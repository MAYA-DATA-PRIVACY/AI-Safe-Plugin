import http.client
import json
import sys
import threading
from contextlib import contextmanager
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "server"))

from gliner2_server import DEFAULT_MAX_BODY_BYTES, DEFAULT_THRESHOLD, make_handler


class FakeService:
    default_threshold = DEFAULT_THRESHOLD
    model_name = "fake-model"
    model_source = "test"
    backend = "test"
    model = None

    def detect(self, text, labels, threshold):
        return []

    def classify(self, text):
        return {"sensitivity": "none", "score": 0.0, "label": "none"}

    def structure(self, text, schema=None):
        return {}


def request(server, method, path, body=None, headers=None):
    conn = http.client.HTTPConnection(server.server_address[0], server.server_address[1], timeout=5)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        payload = response.read()
        return response.status, payload
    finally:
        conn.close()


@contextmanager
def running_server(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()


def test_post_rejects_untrusted_browser_origin():
    handler = make_handler(FakeService(), max_chars=1000)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        status, body = request(
            server,
            "POST",
            "/detect",
            body=json.dumps({"text": "hello"}),
            headers={"Content-Type": "application/json", "Origin": "https://evil.example"},
        )
        assert status == 403
        assert b"Forbidden origin" in body
    finally:
        server.shutdown()
        server.server_close()


def test_post_rejects_oversized_json_body_before_detection():
    handler = make_handler(FakeService(), max_chars=1000)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        status, payload = request(
            server,
            "POST",
            "/detect",
            headers={
                "Content-Type": "application/json",
                "Content-Length": str(DEFAULT_MAX_BODY_BYTES + 1),
            },
        )
        assert status == 413
        assert b"byte limit" in payload
    finally:
        server.shutdown()
        server.server_close()


# ─── H2: shared-secret token auth ────────────────────────────────────────────

def test_health_reports_auth_required_when_token_set():
    handler = make_handler(FakeService(), max_chars=1000, auth_token="secret-token")
    with running_server(handler) as server:
        status, payload = request(server, "GET", "/health")
        assert status == 200
        data = json.loads(payload)
        assert data["authRequired"] is True


def test_health_reports_auth_not_required_when_no_token():
    handler = make_handler(FakeService(), max_chars=1000)  # auth_token=None
    with running_server(handler) as server:
        status, payload = request(server, "GET", "/health")
        assert status == 200
        assert json.loads(payload)["authRequired"] is False


def test_post_without_token_is_unauthorized():
    handler = make_handler(FakeService(), max_chars=1000, auth_token="secret-token")
    with running_server(handler) as server:
        status, payload = request(
            server, "POST", "/detect",
            body=json.dumps({"text": "hi"}),
            headers={"Content-Type": "application/json"},
        )
        assert status == 401
        assert b"AI-Safe Plugin token" in payload


def test_post_with_valid_token_is_accepted():
    handler = make_handler(FakeService(), max_chars=1000, auth_token="secret-token")
    with running_server(handler) as server:
        status, _ = request(
            server, "POST", "/detect",
            body=json.dumps({"text": "hi"}),
            headers={"Content-Type": "application/json", "X-AI-Safe-Plugin-Token": "secret-token"},
        )
        assert status == 200


def test_post_with_wrong_token_is_unauthorized():
    handler = make_handler(FakeService(), max_chars=1000, auth_token="secret-token")
    with running_server(handler) as server:
        status, _ = request(
            server, "POST", "/detect",
            body=json.dumps({"text": "hi"}),
            headers={"Content-Type": "application/json", "X-AI-Safe-Plugin-Token": "wrong"},
        )
        assert status == 401


def test_no_auth_mode_accepts_post_without_token():
    handler = make_handler(FakeService(), max_chars=1000)  # auth disabled
    with running_server(handler) as server:
        status, _ = request(
            server, "POST", "/detect",
            body=json.dumps({"text": "hi"}),
            headers={"Content-Type": "application/json"},
        )
        assert status == 200


# ─── H3: Host-header validation ──────────────────────────────────────────────

def test_post_rejects_untrusted_host():
    handler = make_handler(FakeService(), max_chars=1000)
    with running_server(handler) as server:
        status, payload = request(
            server, "POST", "/detect",
            body=json.dumps({"text": "hi"}),
            headers={"Content-Type": "application/json", "Host": "evil.example"},
        )
        assert status == 403
        assert b"Forbidden host" in payload


def test_get_allows_loopback_host():
    handler = make_handler(FakeService(), max_chars=1000)
    with running_server(handler) as server:
        # Default http.client sets Host to 127.0.0.1:<port> → allowed.
        status, _ = request(server, "GET", "/health")
        assert status == 200


# ─── H4: CORS tightened to extension origins ─────────────────────────────────

def test_post_rejects_localhost_browser_origin():
    handler = make_handler(FakeService(), max_chars=1000)
    with running_server(handler) as server:
        status, payload = request(
            server, "POST", "/detect",
            body=json.dumps({"text": "hi"}),
            headers={"Content-Type": "application/json", "Origin": "http://localhost:3000"},
        )
        assert status == 403
        assert b"Forbidden origin" in payload


def test_post_accepts_extension_origin():
    handler = make_handler(FakeService(), max_chars=1000)
    with running_server(handler) as server:
        status, _ = request(
            server, "POST", "/detect",
            body=json.dumps({"text": "hi"}),
            headers={"Content-Type": "application/json", "Origin": "chrome-extension://abcdef"},
        )
        assert status == 200


def test_extra_allowed_origin_is_honored():
    handler = make_handler(
        FakeService(), max_chars=1000,
        extra_allowed_origins=("http://localhost:1234",),
    )
    with running_server(handler) as server:
        status, _ = request(
            server, "POST", "/detect",
            body=json.dumps({"text": "hi"}),
            headers={"Content-Type": "application/json", "Origin": "http://localhost:1234"},
        )
        assert status == 200
