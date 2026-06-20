#!/usr/bin/env python3
"""
Local GLiNER2 inference bridge for the Veil extension.

The service binds to localhost by default and never forwards prompt text to any
external API except optional anonymization proxy requests made to a configured
endpoint from local `.env`.
"""

import argparse
import atexit
import json
import os
import socket
import sys
import threading
import time
import uuid
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib import error as urlerror
from urllib import request as urlrequest
from urllib.parse import urlparse

from dotenv import load_dotenv

os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("USE_TORCH", "0")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
warnings.filterwarnings("ignore", message=".*incorrect regex pattern.*")
warnings.filterwarnings("ignore", message="PyTorch was not found.*")

DEFAULT_MODEL = "fastino/gliner2-large-v1"
MODEL_ALIASES = {
    "fastino/gliner2-large-v1": "lmo3/gliner2-large-v1-onnx",
    "fastino/gliner2-multi-v1": "lmo3/gliner2-multi-v1-onnx",
}
UNSUPPORTED_MODEL_ALIASES = {
    "fastino/gliner2-base-v1": "fastino/gliner2-large-v1",
}
FALLBACK_MODELS = ["fastino/gliner2-multi-v1"]
ONNX_PRECISION_ENV_KEY = "GLINER2_ONNX_PRECISION"
ONNX_PROVIDERS_ENV_KEY = "GLINER2_ONNX_PROVIDERS"
DEFAULT_ONNX_PRECISION = "fp16"
DEFAULT_ONNX_PROVIDERS = ["CPUExecutionProvider"]
DEFAULT_THRESHOLD = 0.42
DEFAULT_MAX_CHARS = 9000
DEFAULT_MAX_BODY_BYTES = 1024 * 1024
DEFAULT_LABELS = {
    "person":        "full name, first name, last name, or nickname of a real human individual",
    "email":         "electronic mail address containing @ and a domain like user@example.com",
    "phone":         "phone number, mobile number, or contact number including country codes",
    "address":       "street address, home or mailing address with street number",
    "ssn":           "social security number or government-issued ID in NNN-NN-NNNN format",
    "credit_card":   "credit or debit card number with 13 to 16 digits",
    "date_of_birth": "date of birth, birthday, or birth date of a specific person",
    "location":      "city, country, state, region, or named geographic place",
    "organization":  "company name, institution, government agency, or business entity",
}

DEFAULT_THRESHOLDS_BY_TYPE = {
    "ssn": 0.35, "credit_card": 0.35, "email": 0.40, "phone": 0.42,
    "date_of_birth": 0.45, "address": 0.48, "organization": 0.48,
    "person": 0.50, "location": 0.50,
}

PII_STRUCTURE_SCHEMA = {
    "persons":   "names of people — first names, last names, full names",
    "organizations": "company names, institutions, government agencies, or business entities",
    "emails":    "email addresses in format user@domain.com",
    "phones":    "phone numbers or mobile numbers",
    "ids":       "identity numbers such as SSN, passport number, national ID",
    "financial": "credit card numbers or bank account details",
    "locations": "addresses, cities, countries, states, geographic places",
}
LABEL_TO_STRUCTURE_KEY = {
    "person": "persons",
    "organization": "organizations",
    "email": "emails",
    "phone": "phones",
    "ssn": "ids",
    "credit_card": "financial",
    "address": "locations",
    "location": "locations",
    "date_of_birth": "ids",
}

# Server-side chunking: GLiNER2's context window is ~512 tokens; 480 chars is a
# safe character-level proxy. Chunks overlap so entities near boundaries aren't missed.
CHUNK_SIZE = 480
CHUNK_OVERLAP = 80
REPO_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = REPO_DIR / ".env"
RUNTIME_DIR = REPO_DIR / ".runtime"
PROCESS_LOCK_FILE = RUNTIME_DIR / "server_process.lock"
PROCESS_STATE_FILE = RUNTIME_DIR / "server_process.json"
ANON_ENDPOINT_ENV_KEY = "MDP_ANONYMIZATION_ENDPOINT"
DEFAULT_ANONYMIZATION_ENDPOINT = "https://app.mayadataprivacy.in/mdp/engine/anonymization"
ANON_REQUEST_TIMEOUT_SEC = 10.0
# When set to "1", restore verbose anonymization logging (full upstream response and
# body previews) for debugging. Off by default so raw PII never reaches the logs.
DEBUG_ANON_LOGS = os.environ.get("VEIL_DEBUG_ANON_LOGS", "") == "1"
PROCESS_SESSION_ID = uuid.uuid4().hex[:10]
PROCESS_LOCK_HANDLE = None

load_dotenv(ENV_FILE, override=False)


class RequestBodyTooLarge(ValueError):
    """Raised before reading request bodies that exceed the local API cap."""

if os.name == "nt":
    import msvcrt
else:
    import fcntl


def normalize_model_name(model_name: str) -> str:
    raw = str(model_name or "").strip()
    if not raw:
        return DEFAULT_MODEL
    return UNSUPPORTED_MODEL_ALIASES.get(raw, raw)


def resolve_runtime_model_name(model_name: str) -> str:
    normalized = normalize_model_name(model_name)
    if Path(normalized).is_dir():
        return str(Path(normalized))
    return MODEL_ALIASES.get(normalized, normalized)


def resolve_onnx_precision() -> str:
    raw = str(os.environ.get(ONNX_PRECISION_ENV_KEY, DEFAULT_ONNX_PRECISION)).strip().lower()
    return raw if raw in {"fp16", "fp32"} else DEFAULT_ONNX_PRECISION


def resolve_onnx_providers() -> List[str]:
    raw = str(os.environ.get(ONNX_PROVIDERS_ENV_KEY, "")).strip()
    if not raw:
        return list(DEFAULT_ONNX_PROVIDERS)
    providers = [item.strip() for item in raw.split(",") if item.strip()]
    return providers or list(DEFAULT_ONNX_PROVIDERS)


def parse_simple_env_file(path: Path) -> Dict[str, str]:
    values: Dict[str, str] = {}
    if not path.exists():
        return values

    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return values

    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        if not key:
            continue

        cleaned = value.strip()
        if len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in {"'", '"'}:
            cleaned = cleaned[1:-1]
        values[key] = cleaned

    return values


def resolve_anonymization_endpoint() -> str:
    direct = str(os.environ.get(ANON_ENDPOINT_ENV_KEY, "")).strip()
    if direct:
        return direct

    file_values = parse_simple_env_file(ENV_FILE)
    from_file = str(file_values.get(ANON_ENDPOINT_ENV_KEY, "")).strip()
    if from_file:
        return from_file
    return DEFAULT_ANONYMIZATION_ENDPOINT


def ensure_runtime_dir() -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)


def load_process_state() -> Dict[str, Any]:
    ensure_runtime_dir()
    if not PROCESS_STATE_FILE.exists():
        return {}
    try:
        return json.loads(PROCESS_STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_process_state(state: Dict[str, Any]) -> None:
    ensure_runtime_dir()
    PROCESS_STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def clear_process_state() -> None:
    ensure_runtime_dir()
    try:
        existing = load_process_state()
        if existing.get("pid") not in (None, os.getpid()):
            return
        PROCESS_STATE_FILE.unlink(missing_ok=True)
    except Exception:
        return


def acquire_process_lock() -> bool:
    global PROCESS_LOCK_HANDLE
    ensure_runtime_dir()
    handle = PROCESS_LOCK_FILE.open("a+")
    try:
        if os.name == "nt":
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return False
    PROCESS_LOCK_HANDLE = handle
    return True


def release_process_lock() -> None:
    global PROCESS_LOCK_HANDLE
    handle = PROCESS_LOCK_HANDLE
    PROCESS_LOCK_HANDLE = None
    if handle is None:
        return
    try:
        if os.name == "nt":
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass
    try:
        handle.close()
    except OSError:
        pass


def is_port_in_use(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


def cleanup_process_runtime() -> None:
    clear_process_state()
    release_process_lock()


def mark_process_state(status: str, **fields: Any) -> None:
    payload = {
        "pid": os.getpid(),
        "session_id": PROCESS_SESSION_ID,
        "status": status,
        **fields,
    }
    save_process_state(payload)


def log_session_marker(message: str) -> None:
    print(f"[server-session {PROCESS_SESSION_ID}] {message}", flush=True)


def extract_bearer_token(header_value: str) -> str:
    raw = str(header_value or "").strip()
    if not raw:
        return ""
    lower = raw.lower()
    if lower.startswith("bearer "):
        return raw[7:].strip()
    return raw


def mask_token(token: str) -> str:
    value = str(token or "")
    if not value:
        return "<empty>"
    if len(value) <= 12:
        return f"{value[:2]}***{value[-2:]}"
    return f"{value[:6]}...{value[-6:]}"


def compact_json(value: Any, max_chars: int = 6000) -> str:
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        encoded = repr(value)
    if len(encoded) <= max_chars:
        return encoded
    return f"{encoded[:max_chars]}...<truncated {len(encoded) - max_chars} chars>"


def log_anonymization(event: str, request_id: str, **fields: Any) -> None:
    payload = {"event": event, "request_id": request_id, **fields}
    print(f"[anonymize] {compact_json(payload)}", flush=True)


def scrub_upstream_detail(body: str) -> str:
    """Return a short upstream error detail only when it is a JSON object whose
    ``error``/``message`` field is a plain string; otherwise omit the body so raw
    upstream content (which may contain PII) never surfaces in errors or logs."""
    text = (body or "").strip()
    if not text:
        return ""
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return "<non-json upstream error body omitted>"
    if isinstance(parsed, dict):
        for key in ("error", "message"):
            value = parsed.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()[:320]
    return "<non-json upstream error body omitted>"


def proxy_anonymization(entries: List[Any], jwt_token: str, request_id: str) -> Any:
    if not isinstance(entries, list):
        raise ValueError("entries must be a JSON array.")
    if not entries:
        log_anonymization("skip.empty_entries", request_id, entries_count=0)
        return []

    token = str(jwt_token or "").strip()
    if not token:
        log_anonymization("error.missing_jwt", request_id, entries_count=len(entries))
        raise ValueError("Missing anonymization JWT token.")

    endpoint = resolve_anonymization_endpoint()
    if not endpoint:
        log_anonymization("error.missing_endpoint", request_id, env_key=ANON_ENDPOINT_ENV_KEY)
        raise RuntimeError(
            f"Missing {ANON_ENDPOINT_ENV_KEY}. Set it in .env or process environment."
        )

    log_anonymization(
        "request.outbound",
        request_id,
        endpoint=endpoint,
        jwt=mask_token(token),
        entries_count=len(entries),
    )

    request_body = json.dumps(entries).encode("utf-8")
    upstream = urlrequest.Request(
        endpoint,
        data=request_body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Api-key": token,
        },
    )

    try:
        with urlrequest.urlopen(upstream, timeout=ANON_REQUEST_TIMEOUT_SEC) as response:
            status_code = int(getattr(response, "status", 200))
            raw = response.read().decode("utf-8")
    except urlerror.HTTPError as exc:
        try:
            body = exc.read().decode("utf-8", errors="replace").strip()
        except Exception:
            body = ""
        http_error_fields = {
            "status": int(getattr(exc, "code", 0) or 0),
            "body_chars": len(body),
        }
        if DEBUG_ANON_LOGS:
            http_error_fields["body_preview"] = body[:1200]
        log_anonymization("response.http_error", request_id, **http_error_fields)
        detail = scrub_upstream_detail(body) or str(exc)
        raise RuntimeError(f"Upstream anonymization failed ({exc.code}): {detail}") from exc
    except urlerror.URLError as exc:
        log_anonymization("response.network_error", request_id, reason=str(exc.reason))
        raise RuntimeError(f"Unable to reach anonymization endpoint: {exc.reason}") from exc

    if not raw.strip():
        log_anonymization("response.empty", request_id, status=status_code)
        return []

    try:
        parsed = json.loads(raw)
        inbound_fields = {
            "status": status_code,
            "response_type": type(parsed).__name__,
            "items_count": len(parsed) if isinstance(parsed, list) else None,
        }
        if DEBUG_ANON_LOGS:
            inbound_fields["response"] = parsed
        log_anonymization("response.inbound", request_id, **inbound_fields)
        return parsed
    except json.JSONDecodeError as exc:
        non_json_fields = {
            "status": status_code,
            "body_chars": len(raw),
        }
        if DEBUG_ANON_LOGS:
            non_json_fields["body_preview"] = raw[:1200]
        log_anonymization("response.non_json", request_id, **non_json_fields)
        raise RuntimeError("Anonymization endpoint returned non-JSON response.") from exc


def coerce_entity_item(raw_item: Any) -> Optional[Dict[str, Any]]:
    if isinstance(raw_item, dict):
        return dict(raw_item)

    fields = ("text", "label", "start", "end", "score")
    if all(hasattr(raw_item, field) for field in fields):
        return {field: getattr(raw_item, field) for field in fields}

    return None


def flatten_gliner2_output(raw_items: Any) -> List[Dict[str, Any]]:
    """
    Normalize GLiNER2 outputs into a flat list of entity-like dicts.

    GLiNER2 often returns:
      {"entities": {"person": [...], "email": [...]}}
    while older integrations may return:
      {"entities": [...]} or {"predictions": [...]}
    """
    if isinstance(raw_items, list):
        flattened = []
        for item in raw_items:
            coerced = coerce_entity_item(item)
            if coerced is not None:
                flattened.append(coerced)
        return flattened

    if not isinstance(raw_items, dict):
        return []

    entities = raw_items.get("entities")
    if isinstance(entities, list):
        return [item for item in entities if isinstance(item, dict)]

    if isinstance(entities, dict):
        flattened: List[Dict[str, Any]] = []
        for label, values in entities.items():
            if isinstance(values, dict):
                values = [values]
            elif isinstance(values, (str, tuple)):
                values = [values]
            elif not isinstance(values, list):
                continue

            for value in values:
                if isinstance(value, dict):
                    item = dict(value)
                    item.setdefault("label", str(label))
                    flattened.append(item)
                    continue

                if isinstance(value, str):
                    flattened.append({"label": str(label), "text": value})
                    continue

                if isinstance(value, (list, tuple)) and value:
                    # Backward-compat: (text, confidence, start, end)
                    item: Dict[str, Any] = {"label": str(label), "text": str(value[0])}
                    if len(value) > 1:
                        item["confidence"] = value[1]
                    if len(value) > 3 and isinstance(value[2], int) and isinstance(value[3], int):
                        item["start"] = value[2]
                        item["end"] = value[3]
                    flattened.append(item)

        return flattened

    predictions = raw_items.get("predictions")
    if isinstance(predictions, list):
        return [item for item in predictions if isinstance(item, dict)]

    return []


def extract_span(item: Dict[str, Any], text: str) -> Optional[Tuple[int, int]]:
    start = item.get("start", item.get("start_char"))
    end = item.get("end", item.get("end_char"))

    if isinstance(start, int) and isinstance(end, int) and end > start:
        return start, end

    span = item.get("span")
    if isinstance(span, (list, tuple)) and len(span) == 2:
        if isinstance(span[0], int) and isinstance(span[1], int) and span[1] > span[0]:
            return span[0], span[1]

    entity_text = str(
        item.get("text")
        or item.get("entity")
        or item.get("entity_text")
        or ""
    )
    if not entity_text:
        return None

    inferred = text.find(entity_text)
    if inferred < 0:
        return None
    return inferred, inferred + len(entity_text)


def extract_label(item: Dict[str, Any]) -> str:
    return str(
        item.get("label")
        or item.get("entity_group")
        or item.get("type")
        or ""
    ).strip().lower()


def extract_score(item: Dict[str, Any]) -> float:
    raw_score = item.get("score", item.get("confidence", item.get("probability", 0.0)))
    try:
        return float(raw_score)
    except (TypeError, ValueError):
        return 0.0


def make_chunks(text: str) -> List[Tuple[str, int]]:
    """Split text into overlapping chunks. Returns [(chunk_text, char_offset), ...]."""
    if len(text) <= CHUNK_SIZE:
        return [(text, 0)]
    result: List[Tuple[str, int]] = []
    pos = 0
    while pos < len(text):
        end = min(pos + CHUNK_SIZE, len(text))
        # Prefer breaking at whitespace to avoid splitting tokens
        if end < len(text):
            ws = text.rfind(" ", pos + CHUNK_SIZE // 2, end)
            if ws > pos:
                end = ws + 1
        result.append((text[pos:end], pos))
        if end >= len(text):
            break
        pos = max(end - CHUNK_OVERLAP, pos + 1)
    return result


def score_to_tier(score: float) -> str:
    if score >= 0.80:
        return "high"
    if score >= 0.60:
        return "medium"
    return "low"


def apply_per_entity_thresholds(
    detections: List[Dict[str, Any]],
    global_threshold: float,
    per_entity: Optional[Dict[str, float]] = None,
) -> List[Dict[str, Any]]:
    if not per_entity:
        per_entity = {}
    result = []
    for det in detections:
        label = str(det.get("label", "")).strip().lower()
        threshold = per_entity.get(label, DEFAULT_THRESHOLDS_BY_TYPE.get(label, global_threshold))
        if det.get("score", 0.0) >= threshold:
            result.append(det)
    return result


def deduplicate_detections(detections: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Remove overlapping spans, keeping the one with the highest score."""
    if not detections:
        return []
    detections.sort(key=lambda d: (d["start"], -d["score"]))
    merged: List[Dict[str, Any]] = []
    cur = detections[0]
    for nxt in detections[1:]:
        if nxt["start"] < cur["end"]:  # overlap — keep higher score
            cur_label = str(cur.get("label", "")).strip().lower()
            nxt_label = str(nxt.get("label", "")).strip().lower()
            cur_text = str(cur.get("text", "")).strip().lower()
            nxt_text = str(nxt.get("text", "")).strip().lower()
            same_span = cur["start"] == nxt["start"] and cur["end"] == nxt["end"]
            same_text = bool(cur_text) and cur_text == nxt_text
            labels = {cur_label, nxt_label}
            if (same_span or same_text) and labels == {"person", "organization"}:
                if nxt_label == "person":
                    cur = nxt
            elif nxt["score"] > cur["score"]:
                cur = nxt
        else:
            merged.append(cur)
            cur = nxt
    merged.append(cur)
    return merged


class GLiNERService:
    def __init__(self, model_name: str, default_threshold: float) -> None:
        self.model_name = model_name
        self.default_threshold = default_threshold
        self.model_source = resolve_runtime_model_name(model_name)
        self.model = None
        self.backend = "gliner2-onnx"
        self.model_lock = threading.Lock()
        self.onnx_precision = resolve_onnx_precision()
        self.onnx_providers = resolve_onnx_providers()

    def resolve_local_snapshot(self, model_name: str) -> Optional[str]:
        model = str(model_name or "").strip()
        if not model:
            return None

        model_path = Path(model)
        if model_path.is_dir():
            return str(model_path)

        if "/" not in model:
            return None

        hub_root = (
            os.environ.get("HUGGINGFACE_HUB_CACHE")
            or os.environ.get("HF_HUB_CACHE")
            or os.environ.get("HF_HOME")
        )

        if hub_root:
            hub_dir = Path(hub_root)
        else:
            repo_dir = Path(__file__).resolve().parent.parent
            hub_dir = repo_dir / ".runtime" / "cache" / "hf" / "hub"

        if hub_dir.name != "hub":
            hub_dir = hub_dir / "hub"

        model_dir = hub_dir / f"models--{model.replace('/', '--')}"
        snapshots_dir = model_dir / "snapshots"
        refs_main = model_dir / "refs" / "main"

        preferred: List[Path] = []
        if refs_main.exists():
            revision = refs_main.read_text(encoding="utf-8", errors="ignore").strip()
            if revision:
                preferred.append(snapshots_dir / revision)

        if snapshots_dir.exists():
            others = [path for path in snapshots_dir.iterdir() if path.is_dir()]
            others.sort(key=lambda path: path.stat().st_mtime, reverse=True)
            preferred.extend(others)

        # Also check the bundled model path (extracted from GitHub Release asset)
        repo_dir = Path(__file__).resolve().parent.parent
        bundled = repo_dir / ".runtime" / "cache" / "model" / "model"
        if bundled.is_dir():
            preferred.insert(0, bundled)

        required = ("config.json", "gliner2_config.json")
        for candidate in preferred:
            if all((candidate / item).exists() for item in required):
                return str(candidate)
        return None

    def load_model(self) -> None:
        if self.model is not None:
            return

        try:
            from gliner2_onnx import GLiNER2ONNXRuntime
        except Exception as exc:
            raise RuntimeError(
                "GLiNER2 ONNX import failed. Re-sync the managed runtime with "
                "`uv sync --frozen --no-dev --no-install-project`."
            ) from exc

        normalized_model = normalize_model_name(self.model_name)
        candidates = [normalized_model] + [item for item in FALLBACK_MODELS if item != normalized_model]
        failures: List[Tuple[str, str]] = []
        for candidate in candidates:
            runtime_model = resolve_runtime_model_name(candidate)
            local_snapshot = self.resolve_local_snapshot(runtime_model)
            load_targets = []
            if local_snapshot:
                load_targets.append(local_snapshot)
            load_targets.append(runtime_model)

            seen_targets = set()
            for load_target in load_targets:
                if load_target in seen_targets:
                    continue
                seen_targets.add(load_target)
                try:
                    load_path = Path(load_target)
                    if load_path.is_dir():
                        print(f"Loading GLiNER2 ONNX model ({self.onnx_precision}) from local cache: {load_target}")
                        self.model = GLiNER2ONNXRuntime(
                            str(load_path),
                            precision=self.onnx_precision,
                            providers=self.onnx_providers,
                        )
                    else:
                        print(f"Downloading/loading GLiNER2 ONNX model ({self.onnx_precision}): {load_target}")
                        save_process_state({
                            "pid": os.getpid(),
                            "session_id": PROCESS_SESSION_ID,
                            "phase": "downloading",
                            "model": candidate,
                            "precision": self.onnx_precision,
                        })
                        self.model = GLiNER2ONNXRuntime.from_pretrained(
                            load_target,
                            precision=self.onnx_precision,
                            providers=self.onnx_providers,
                        )
                    self.model_name = candidate
                    self.model_source = str(load_path if load_path.is_dir() else runtime_model)
                    self.backend = f"gliner2-onnx/{self.onnx_precision}"
                    print(f"GLiNER2 ONNX model loaded: {candidate} ({self.model_source})")
                    return
                except Exception as exc:
                    source_name = f"{candidate} via {load_target}"
                    failures.append((source_name, str(exc)))

        joined = " | ".join(f"{name}: {error}" for name, error in failures)
        if any(
            token in joined.lower()
            for token in ("401", "unauthorized", "repository not found", "invalid username or password")
        ):
            raise RuntimeError(
                "Model download failed (auth/repository issue). "
                f"Tried: {', '.join(candidates)}. "
                "The default public ONNX models should not require HF_TOKEN. "
                "Set a valid model id/path or configure Hugging Face auth only for private or gated models."
            )
        raise RuntimeError(
            f"Model load failed. Tried: {', '.join(candidates)}. Last errors: {joined}"
        )

    def _predict(self, text: str, labels, threshold: float) -> List[Dict[str, Any]]:
        try:
            return self.model.extract_entities(text, labels, threshold=threshold)
        except TypeError:
            return self.model.extract_entities(text, labels)

    def _prepare_labels(self, labels: Any) -> Tuple[List[str], Dict[str, str]]:
        if isinstance(labels, dict) and labels:
            model_labels: List[str] = []
            label_lookup: Dict[str, str] = {}
            for key, value in labels.items():
                internal_name = str(key).strip().lower()
                description = str(value).strip() or internal_name
                if not internal_name or not description:
                    continue
                model_labels.append(description)
                label_lookup.setdefault(description.lower(), internal_name)
                label_lookup.setdefault(internal_name, internal_name)
            if model_labels:
                return model_labels, label_lookup

        cleaned = [str(lbl).strip().lower() for lbl in (labels or []) if str(lbl).strip()]
        if cleaned:
            label_lookup = {label.lower(): label for label in cleaned}
            return cleaned, label_lookup

        defaults = list(DEFAULT_LABELS.values())
        label_lookup = {description.lower(): internal for internal, description in DEFAULT_LABELS.items()}
        return defaults, label_lookup

    def _predict_chunk(
        self,
        chunk_text: str,
        labels: List[str],
        label_lookup: Dict[str, str],
        threshold: float,
        source_text: str,
        offset: int,
    ) -> List[Dict[str, Any]]:
        """Run prediction on one chunk and return detections with absolute offsets."""
        raw_items = flatten_gliner2_output(self._predict(chunk_text, labels, threshold))
        detections: List[Dict[str, Any]] = []
        for item in raw_items:
            label = extract_label(item)
            if not label:
                continue
            resolved_label = label_lookup.get(label.lower(), label)
            span = extract_span(item, chunk_text)
            if span is None:
                continue
            start, end = span[0] + offset, span[1] + offset
            if start < 0 or end > len(source_text) or end <= start:
                continue
            detections.append({
                "text":  source_text[start:end],
                "label": resolved_label,
                "start": start,
                "end":   end,
                "score": extract_score(item),
            })
        return detections

    def detect(self, text: str, labels, threshold: float) -> List[Dict[str, Any]]:
        self.load_model()
        model_labels, label_lookup = self._prepare_labels(labels)

        chunks = make_chunks(text)
        detections: List[Dict[str, Any]] = []

        with self.model_lock:
            for chunk_text, offset in chunks:
                detections.extend(
                    self._predict_chunk(chunk_text, model_labels, label_lookup, threshold, text, offset)
                )

        result = deduplicate_detections(detections)
        for det in result:
            det["tier"] = score_to_tier(det.get("score", 0.0))
        return result

    def classify(self, text: str) -> Dict[str, Any]:
        """Classify text sensitivity using GLiNER2 or detection fallback."""
        self.load_model()
        classify_labels = ["highly sensitive PII present", "moderate PII", "low risk", "no PII"]
        sensitivity_map = {
            "highly sensitive pii present": "high",
            "moderate pii": "medium",
            "low risk": "low",
            "no pii": "none",
        }

        if hasattr(self.model, "classify"):
            with self.model_lock:
                try:
                    raw = self.model.classify(text, classify_labels)
                    if isinstance(raw, dict):
                        if not raw:
                            raise ValueError("empty classification output")
                        label, score = max(raw.items(), key=lambda item: float(item[1]))
                        label = str(label).lower()
                        score = float(score)
                        return {"sensitivity": sensitivity_map.get(label, "none"), "score": score, "label": label}
                except Exception:
                    pass

        # Fallback: detect and infer sensitivity
        try:
            detections = self.detect(text, DEFAULT_LABELS, 0.30)
            if not detections:
                return {"sensitivity": "none", "score": 0.0, "label": "no pii"}
            max_score = max(d.get("score", 0.0) for d in detections)
            high_risk = {"ssn", "credit_card"}
            has_high_risk = any(d.get("label", "").lower() in high_risk for d in detections)
            if has_high_risk or max_score >= 0.80:
                sensitivity = "high"
            elif max_score >= 0.60:
                sensitivity = "medium"
            elif max_score >= 0.40:
                sensitivity = "low"
            else:
                sensitivity = "none"
            return {"sensitivity": sensitivity, "score": max_score, "label": f"{len(detections)} entities detected"}
        except Exception as exc:
            return {"sensitivity": "none", "score": 0.0, "label": "error", "error": str(exc)}

    def structure(self, text: str, schema: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        """Extract structured PII into schema categories."""
        self.load_model()
        if schema is None:
            schema = PII_STRUCTURE_SCHEMA

        try:
            detections = self.detect(text, DEFAULT_LABELS, 0.35)
            result: Dict[str, List[str]] = {key: [] for key in schema}
            seen: Dict[str, set] = {key: set() for key in schema}
            for det in detections:
                lbl = str(det.get("label", "")).lower()
                bucket = LABEL_TO_STRUCTURE_KEY.get(lbl)
                if bucket and bucket in result:
                    value = str(det.get("text", "")).strip()
                    if value and value not in seen[bucket]:
                        seen[bucket].add(value)
                        result[bucket].append(value)
            return result
        except Exception as exc:
            return {"error": str(exc)}


def make_handler(service: GLiNERService, max_chars: int):
    class Handler(BaseHTTPRequestHandler):
        def _origin_header(self) -> str:
            return str(self.headers.get("Origin", "")).strip().replace("\r", "").replace("\n", "")

        def _is_allowed_origin(self, origin: str) -> bool:
            if (
                origin.startswith("chrome-extension://")
                or origin.startswith("moz-extension://")
                or origin in ("http://localhost", "https://localhost",
                               "http://127.0.0.1", "https://127.0.0.1")
                or origin.startswith("http://localhost:")
                or origin.startswith("http://127.0.0.1:")
            ):
                return True
            return False

        def _allowed_origin(self) -> str:
            """Return the sanitized trusted Origin for CORS response headers."""
            origin = self._origin_header()
            if not origin:
                return ""
            if self._is_allowed_origin(origin):
                return origin
            return ""

        def _reject_forbidden_origin(self) -> bool:
            origin = self._origin_header()
            if origin and not self._is_allowed_origin(origin):
                self._write_json({"ok": False, "error": "Forbidden origin."}, status_code=403)
                return True
            return False

        def _write_json(self, payload: Any, status_code: int = 200) -> None:
            body = json.dumps(payload).encode("utf-8")
            try:
                self.send_response(status_code)
                self.send_header("Content-Type", "application/json")
                allowed = self._allowed_origin()
                if allowed:
                    self.send_header("Access-Control-Allow-Origin", allowed)
                    self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                    self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
                    self.send_header("Vary", "Origin")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                # Browser disconnected while we were sending response.
                pass

        def _read_json(self) -> Any:
            try:
                content_length = int(self.headers.get("Content-Length", "0"))
            except (TypeError, ValueError):
                raise ValueError("Invalid Content-Length header.")
            if content_length <= 0:
                return {}
            if content_length > DEFAULT_MAX_BODY_BYTES:
                raise RequestBodyTooLarge(
                    f"Request body exceeds {DEFAULT_MAX_BODY_BYTES} byte limit."
                )
            try:
                raw = self.rfile.read(content_length).decode("utf-8")
            except UnicodeDecodeError as exc:
                raise ValueError("Invalid UTF-8 JSON body.") from exc
            if not raw:
                return {}
            return json.loads(raw)

        def do_OPTIONS(self) -> None:  # noqa: N802
            if self._reject_forbidden_origin():
                return
            self._write_json({}, status_code=204)

        def do_GET(self) -> None:  # noqa: N802
            if self._reject_forbidden_origin():
                return
            path = urlparse(self.path).path
            if path == "/health":
                self._write_json(
                    {
                        "ok": True,
                        "provider": "lmoe/gliner2-onnx",
                        "model": service.model_name,
                        "model_source": service.model_source,
                        "backend": service.backend,
                        "loaded": service.model is not None,
                        "anonymizationProxy": True,
                        "anonymizationEndpointConfigured": bool(resolve_anonymization_endpoint()),
                    }
                )
                return
            self._write_json({"ok": False, "error": "Not found"}, status_code=404)

        def do_POST(self) -> None:  # noqa: N802
            if self._reject_forbidden_origin():
                return
            path = urlparse(self.path).path

            try:
                payload = self._read_json()
                if path == "/detect":
                    text = str(payload.get("text", ""))
                    labels = payload.get("labels", DEFAULT_LABELS)
                    threshold = payload.get("threshold", service.default_threshold)
                    per_entity_thresholds = payload.get("thresholds", None)
                    fast_mode = bool(payload.get("fast_mode", False))

                    try:
                        threshold = float(threshold)
                    except (TypeError, ValueError):
                        threshold = service.default_threshold

                    if fast_mode and len(text.strip()) < 100:
                        self._write_json({"ok": True, "detections": [], "fast_mode_skip": True})
                        return

                    if len(text) > max_chars:
                        text = text[:max_chars]

                    # Use the lowest applicable threshold for the model pass so
                    # per-entity filtering can select the right detections afterwards.
                    effective_min = threshold
                    if isinstance(per_entity_thresholds, dict) and per_entity_thresholds:
                        try:
                            effective_min = min(
                                effective_min,
                                min(float(v) for v in per_entity_thresholds.values() if v is not None),
                            )
                        except (TypeError, ValueError):
                            pass

                    detections = service.detect(text, labels, effective_min)
                    if per_entity_thresholds:
                        detections = apply_per_entity_thresholds(detections, threshold, per_entity_thresholds)
                    self._write_json({"ok": True, "detections": detections}, status_code=200)
                    return

                if path == "/classify":
                    text = str(payload.get("text", ""))
                    if not text.strip():
                        self._write_json({"ok": True, "sensitivity": "none", "score": 0.0, "label": "empty"})
                        return
                    result = service.classify(text)
                    self._write_json({"ok": True, **result})
                    return

                if path == "/structure":
                    text = str(payload.get("text", ""))
                    schema = payload.get("schema", None)
                    if not text.strip():
                        self._write_json({"ok": True, "structure": {}})
                        return
                    result = service.structure(text, schema if isinstance(schema, dict) else None)
                    self._write_json({"ok": True, "structure": result})
                    return

                if path == "/anonymize":
                    request_id = uuid.uuid4().hex[:10]
                    entries = payload
                    api_key = ""
                    api_key = extract_bearer_token(self.headers.get("Authorization", ""))
                    if not api_key:
                        api_key = str(self.headers.get("X-Api-key", "")).strip()
                    if isinstance(payload, dict):
                        entries = payload.get("entries", payload.get("payload", []))
                        if not api_key:
                            api_key = str(payload.get("jwtToken", "")).strip()

                    input_count = len(entries) if isinstance(entries, list) else None
                    log_anonymization(
                        "route.inbound",
                        request_id,
                        has_inline_jwt=bool(api_key),
                        entries_count=input_count,
                    )

                    result = proxy_anonymization(entries, api_key, request_id)
                    self._write_json({"ok": True, "data": result}, status_code=200)
                    return

                self._write_json({"ok": False, "error": "Not found"}, status_code=404)
            except (BrokenPipeError, ConnectionResetError):
                # Client disconnected before receiving server output.
                return
            except json.JSONDecodeError:
                self._write_json({"ok": False, "error": "Invalid JSON body."}, status_code=400)
            except RequestBodyTooLarge as exc:
                self._write_json({"ok": False, "error": str(exc)}, status_code=413)
            except ValueError as exc:
                self._write_json({"ok": False, "error": str(exc)}, status_code=400)
            except RuntimeError as exc:
                self._write_json({"ok": False, "error": str(exc)}, status_code=502)
            except Exception as exc:
                self._write_json({"ok": False, "error": str(exc)}, status_code=500)

        def log_message(self, fmt: str, *args: Any) -> None:
            print(f"[gliner2-server] {self.address_string()} - {fmt % args}")

    return Handler


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run local GLiNER2 ONNX HTTP inference server")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Model id/path (default: {DEFAULT_MODEL})")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", default=8765, type=int, help="Bind port (default: 8765)")
    parser.add_argument("--threshold", default=DEFAULT_THRESHOLD, type=float, help="Default confidence threshold")
    parser.add_argument("--max-chars", default=DEFAULT_MAX_CHARS, type=int, help="Max chars per request")
    parser.add_argument(
        "--lazy-load",
        action="store_true",
        help="Do not load model at startup. Load only on first /detect request.",
    )
    parser.add_argument("--download-only", action="store_true", help="Download/cache model and exit")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not acquire_process_lock():
        print("Another GLiNER2 server instance is already starting or running.", flush=True)
        raise SystemExit(0)

    atexit.register(cleanup_process_runtime)
    mark_process_state(
        "starting",
        host=args.host,
        port=args.port,
        model=normalize_model_name(args.model),
        started_at=int(time.time()),
    )
    log_session_marker("Server process starting")
    service = GLiNERService(args.model, args.threshold)

    if args.download_only:
        try:
            service.load_model()
        except Exception as exc:
            print(f"Model initialization error: {exc}", file=sys.stderr)
            raise SystemExit(2)
        print("Model download/cache complete")
        return

    if is_port_in_use(args.host, args.port):
        log_session_marker(f"Port {args.port} is already in use; exiting duplicate start request")
        print(f"Another process is already listening on http://{args.host}:{args.port}", flush=True)
        raise SystemExit(0)

    if not args.lazy_load:
        print("Preloading GLiNER2 ONNX model into memory...")
        try:
            service.load_model()
        except Exception as exc:
            print(f"Model initialization error: {exc}", file=sys.stderr)
            raise SystemExit(2)
    else:
        print("Lazy-load mode enabled: ONNX model loads on first detection request.")

    handler = make_handler(service, args.max_chars)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    mark_process_state(
        "running",
        host=args.host,
        port=args.port,
        model=normalize_model_name(args.model),
        ready_at=int(time.time()),
    )
    log_session_marker("Server ready")
    print(f"GLiNER2 ONNX local server listening on http://{args.host}:{args.port}")
    print("Endpoints: GET /health, POST /detect, POST /anonymize, POST /classify, POST /structure")
    try:
        server.serve_forever()
    finally:
        cleanup_process_runtime()


if __name__ == "__main__":
    main()
