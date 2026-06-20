"""
Unit tests for pure utility functions in server/gliner2_server.py.
Run with: pytest tests/server/test_utils.py -v
"""
import sys
import urllib.error
from contextlib import contextmanager
from pathlib import Path

import pytest

# Add server dir to path so we can import without installing
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "server"))

import gliner2_server
from gliner2_server import (
    CHUNK_OVERLAP,
    CHUNK_SIZE,
    LABEL_TO_STRUCTURE_KEY,
    deduplicate_detections,
    flatten_gliner2_output,
    make_chunks,
    normalize_model_name,
    proxy_anonymization,
    resolve_runtime_model_name,
    scrub_upstream_detail,
)

SENTINEL = "SENTINEL_SECRET_VALUE"


class TestMakeChunks:
    def test_short_text_single_chunk(self):
        text = "Hello world"
        chunks = make_chunks(text)
        assert len(chunks) == 1
        assert chunks[0] == (text, 0)

    def test_exact_chunk_size_single_chunk(self):
        text = "a" * CHUNK_SIZE
        chunks = make_chunks(text)
        assert len(chunks) == 1

    def test_long_text_multiple_chunks(self):
        text = "word " * 200  # well over CHUNK_SIZE
        chunks = make_chunks(text)
        assert len(chunks) > 1

    def test_chunks_cover_full_text(self):
        text = "Hello world. " * 100
        chunks = make_chunks(text)
        # Every character of the text should appear in at least one chunk
        covered = set()
        for chunk_text, offset in chunks:
            for i, ch in enumerate(chunk_text):
                covered.add(offset + i)
        assert covered == set(range(len(text)))

    def test_whitespace_adjusted_chunks_do_not_leave_gaps(self):
        text = ("a" * (CHUNK_SIZE // 2)) + " " + ("b" * (CHUNK_SIZE + 20))
        chunks = make_chunks(text)
        covered = set()
        for chunk_text, offset in chunks:
            covered.update(range(offset, offset + len(chunk_text)))
        assert covered == set(range(len(text)))

    def test_chunk_offsets_correct(self):
        text = "a" * 200 + "b" * 200 + "c" * 200
        chunks = make_chunks(text)
        for chunk_text, offset in chunks:
            # Verify the chunk matches the source text at the given offset
            assert text[offset:offset + len(chunk_text)] == chunk_text

    def test_overlap_captures_boundary(self):
        # An entity spanning the boundary should appear in adjacent chunks
        text = ("word " * 90) + "BOUNDARY_ENTITY " + ("word " * 90)
        chunks = make_chunks(text)
        entity_pos = text.index("BOUNDARY_ENTITY")
        chunks_with_entity = [
            (ct, off) for ct, off in chunks
            if off <= entity_pos < off + len(ct)
        ]
        assert len(chunks_with_entity) >= 1


class TestDeduplicateDetections:
    def _det(self, start, end, label="person", score=0.8):
        return {"text": "x", "label": label, "start": start, "end": end, "score": score}

    def test_empty(self):
        assert deduplicate_detections([]) == []

    def test_no_overlap(self):
        dets = [self._det(0, 5), self._det(10, 15)]
        result = deduplicate_detections(dets)
        assert len(result) == 2

    def test_exact_overlap_keeps_higher_score(self):
        dets = [self._det(0, 5, score=0.9), self._det(0, 5, score=0.7)]
        result = deduplicate_detections(dets)
        assert len(result) == 1
        assert result[0]["score"] == 0.9

    def test_partial_overlap_keeps_higher_score(self):
        dets = [self._det(0, 10, score=0.6), self._det(5, 15, score=0.85)]
        result = deduplicate_detections(dets)
        assert len(result) == 1
        assert result[0]["score"] == 0.85

    def test_same_span_prefers_person_over_organization(self):
        dets = [
            {"text": "Pranav", "label": "organization", "start": 0, "end": 6, "score": 0.93},
            {"text": "Pranav", "label": "person", "start": 0, "end": 6, "score": 0.81},
        ]
        result = deduplicate_detections(dets)
        assert len(result) == 1
        assert result[0]["label"] == "person"

    def test_adjacent_no_overlap(self):
        dets = [self._det(0, 5), self._det(5, 10)]
        result = deduplicate_detections(dets)
        assert len(result) == 2

    def test_output_sorted_by_start(self):
        dets = [self._det(10, 15), self._det(0, 5), self._det(20, 25)]
        result = deduplicate_detections(dets)
        starts = [d["start"] for d in result]
        assert starts == sorted(starts)


class TestFlattenGliner2Output:
    def test_grouped_dict_format(self):
        raw = {
            "entities": {
                "person": [{"text": "John", "start": 0, "end": 4, "confidence": 0.9}],
                "email": [{"text": "a@b.com", "start": 10, "end": 17, "confidence": 0.95}],
            }
        }
        result = flatten_gliner2_output(raw)
        assert len(result) == 2
        labels = {r["label"] for r in result}
        assert labels == {"person", "email"}

    def test_flat_list_format(self):
        raw = [
            {"text": "John", "label": "person", "start": 0, "end": 4},
        ]
        result = flatten_gliner2_output(raw)
        assert len(result) == 1
        assert result[0]["label"] == "person"

    def test_empty_entities(self):
        assert flatten_gliner2_output({"entities": {}}) == []
        assert flatten_gliner2_output([]) == []
        assert flatten_gliner2_output({}) == []

    def test_grouped_sets_label_from_key(self):
        raw = {
            "entities": {
                "custom_employee_id": [{"text": "EMP-001", "start": 0, "end": 7, "confidence": 0.88}]
            }
        }
        result = flatten_gliner2_output(raw)
        assert result[0]["label"] == "custom_employee_id"


class TestModelAliases:
    def test_default_model(self):
        assert normalize_model_name("") == "fastino/gliner2-large-v1"

    def test_base_model_aliases_to_large(self):
        assert normalize_model_name("fastino/gliner2-base-v1") == "fastino/gliner2-large-v1"

    def test_public_onnx_alias_resolution(self):
        assert resolve_runtime_model_name("fastino/gliner2-large-v1") == "lmo3/gliner2-large-v1-onnx"
        assert resolve_runtime_model_name("fastino/gliner2-multi-v1") == "lmo3/gliner2-multi-v1-onnx"


class TestStructureMapping:
    def test_organization_has_its_own_structure_bucket(self):
        assert LABEL_TO_STRUCTURE_KEY["organization"] == "organizations"
        assert LABEL_TO_STRUCTURE_KEY["person"] == "persons"


class TestScrubUpstreamDetail:
    def test_empty_body(self):
        assert scrub_upstream_detail("") == ""

    def test_json_error_field_is_returned(self):
        assert scrub_upstream_detail('{"error": "rate limited"}') == "rate limited"

    def test_json_message_field_is_returned(self):
        assert scrub_upstream_detail('{"message": "bad request"}') == "bad request"

    def test_non_json_is_omitted(self):
        assert scrub_upstream_detail(f"oops {SENTINEL}") == "<non-json upstream error body omitted>"

    def test_json_without_error_field_is_omitted(self):
        assert scrub_upstream_detail(f'{{"detail": "{SENTINEL}"}}') == "<non-json upstream error body omitted>"


@contextmanager
def _fake_response(status, body):
    class _Resp:
        status = None

        def read(self):
            return body.encode("utf-8")

    resp = _Resp()
    resp.status = status
    yield resp


class TestAnonymizationLogging:
    """H1: anonymization logging must be metadata-only by default (no raw PII)."""

    def test_successful_response_logs_metadata_not_body(self, monkeypatch, capsys):
        body = f'[{{"original": "{SENTINEL}", "replacement": "Acme"}}]'
        monkeypatch.setattr(gliner2_server, "DEBUG_ANON_LOGS", False)
        monkeypatch.setattr(
            gliner2_server.urlrequest, "urlopen",
            lambda *a, **k: _fake_response(200, body),
        )

        result = proxy_anonymization([{"text": "x", "label": "org"}], "jwt-token", "req-1")

        assert isinstance(result, list) and len(result) == 1
        out = capsys.readouterr().out
        assert "items_count" in out
        assert SENTINEL not in out

    def test_http_error_logs_body_chars_not_body(self, monkeypatch, capsys):
        body = f'{{"detail": "{SENTINEL}"}}'

        def _raise(*a, **k):
            raise urllib.error.HTTPError("url", 422, "Unprocessable", {}, None)

        monkeypatch.setattr(gliner2_server, "DEBUG_ANON_LOGS", False)
        monkeypatch.setattr(gliner2_server.urlrequest, "urlopen", _raise)
        monkeypatch.setattr(
            urllib.error.HTTPError, "read",
            lambda self: body.encode("utf-8"), raising=False,
        )

        with pytest.raises(RuntimeError) as exc_info:
            proxy_anonymization([{"text": "x", "label": "org"}], "jwt-token", "req-2")

        out = capsys.readouterr().out
        assert "body_chars" in out
        assert SENTINEL not in out
        assert SENTINEL not in str(exc_info.value)

    def test_debug_flag_restores_verbose_logging(self, monkeypatch, capsys):
        body = f'[{{"original": "{SENTINEL}"}}]'
        monkeypatch.setattr(gliner2_server, "DEBUG_ANON_LOGS", True)
        monkeypatch.setattr(
            gliner2_server.urlrequest, "urlopen",
            lambda *a, **k: _fake_response(200, body),
        )

        proxy_anonymization([{"text": "x", "label": "org"}], "jwt-token", "req-3")

        out = capsys.readouterr().out
        assert SENTINEL in out
