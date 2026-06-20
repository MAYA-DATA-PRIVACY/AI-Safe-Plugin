# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | ✅        |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Email **nishikant.mandal@mayadataprivacy.eu** with:

1. A clear description of the vulnerability.
2. Steps to reproduce (proof-of-concept if possible).
3. Potential impact assessment.
4. Your preferred contact method for follow-up.

You will receive an acknowledgement within **48 hours** and a status update within **7 days**.

If a fix is warranted, we will coordinate a disclosure timeline with you (typically 90 days).

---

## Threat Model

Veil performs PII detection locally by default. The browser extension sends text to the local Veil server on `127.0.0.1:8765` for GLiNER2 inference and local regex handling. Optional Maya anonymisation is disabled by default; when enabled, selected anonymisation payloads are proxied from the local server to Maya.

The surfaces most relevant to security researchers are:

| Surface | Notes |
|---------|-------|
| Content script ↔ page DOM | `innerHTML` injection paths — all user-controlled strings must be `escapeHtml()`-escaped |
| Content script ↔ background message | Structured-clone boundary; validate all message shapes |
| Background ↔ local Python server | HTTP on `127.0.0.1:8765`. Detection endpoints (`/detect`, `/classify`, `/structure`, `/anonymize`) require a per-machine shared token (`X-Veil-Token`); CORS is limited to `chrome-extension://`/`moz-extension://` origins (plus any in `VEIL_EXTRA_ALLOWED_ORIGINS`). The server also validates the `Host` header (loopback only) and applies a per-request socket timeout |
| Local server ↔ Maya anonymisation API | Optional external call for selected anonymisation payloads only when Anonymize mode and a Maya API key are configured |
| `chrome.storage.local` | Settings, custom patterns, API key, counters, and cached redaction state are stored locally; no Chrome sync storage is used |
| Custom regex patterns | Executed client-side; regex DoS (ReDoS) possible with malicious patterns |

---

## Data Flow and Retention

- **Local detection**: text being edited is sent from the active tab to the extension background worker and then to the local server. This path stays on the user's machine.
- **Local server authentication**: on startup the server generates a random token (`secrets.token_hex(32)`) and writes it to `.runtime/server_token` with `0600` permissions (POSIX). The extension obtains it through the native messaging host (`get_server_token`) and sends it as `X-Veil-Token` on detection requests, so other local processes and localhost web pages cannot drive the detection endpoints. `/health` stays unauthenticated and advertises `authRequired`. Auth can be disabled with `--no-auth` / `VEIL_NO_AUTH=1` for custom setups.
- **Optional Maya anonymisation**: Anonymize mode sends selected detected values and metadata needed for anonymisation to Maya through the local `/anonymize` proxy. Maya company policy says Maya does not store PII that runs through its anonymisation engine.
- **Browser-local storage**: Veil stores configuration, custom patterns, the Maya API key if provided, onboarding/preferences, site redaction counters, and cached redaction state in `chrome.storage.local`.
- **Cached redaction state**: local cache entries may include source text and detected items so the UI can keep redaction state consistent. Entries older than 24 hours are removed by extension cache cleanup.
- **Local server logs**: anonymisation logging is metadata-only by default — the local server logs counts, status codes, and body sizes (`items_count`, `body_chars`), never raw upstream response values. Setting the environment variable `VEIL_DEBUG_ANON_LOGS=1` restores verbose logging (full upstream response and body previews) for debugging only; treat such logs as sensitive and do not enable it in normal use.

---

## Security Boundaries

- Veil protects text before submission. It does not control how destination sites or LLM providers store, log, train on, or process text after the user sends it.
- Veil's local trust boundary includes the user's browser profile, installed extensions, local processes, and anything with access to `chrome.storage.local` or localhost traffic on the machine.
- The local server is intended to bind to `127.0.0.1`. Do not expose it on a network interface unless you also add appropriate authentication and network controls.
- Custom regex rules are user-provided code-like configuration. Treat shared pattern sets as untrusted until reviewed.

---

## Known Accepted Risks

- **Local browser storage**: Maya API keys and cached redaction state are stored in `chrome.storage.local`. This keeps data off Chrome sync, but it is still accessible to the local browser profile and should be treated as sensitive local data.
- **Localhost exposure**: The local server trusts the user's machine boundary. CORS headers are restricted to trusted extension and localhost origins, but other local software can still interact with localhost services if it has sufficient local access.

---

## Hall of Fame

Responsible disclosures that lead to a fix will be credited here (with permission).
