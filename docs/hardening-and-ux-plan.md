# AI-Safe Plugin — Best-in-Category Hardening & UX Plan

Status: draft for review · Owner: nishikantmandal007 · Branch: `release/best-in-category-hardening`
Written: 2026-06-10 · Based on code audit of v1.2.8 (commit `bdcfc9c`)

This plan is written so that each task can be handed to a junior engineer or a smaller
coding model **as an isolated work order**, and verified independently by a reviewer.
Every task has: background (why), exact directions (what/where), constraints (what NOT
to do), acceptance criteria, and a verification checklist the reviewer runs.

---

## 1. Product snapshot (what exists today)

AI-Safe Plugin = Chrome MV3 extension + local Python GLiNER2 ONNX server + native-messaging host
+ one-command installers (Linux systemd / macOS launchd / Windows Task Scheduler + Inno
Setup `AISafePluginSetup.exe`).

Already shipped and working:

- Grammarly-style **underlines** on detections, click-to-redact, token tray, per-field
  action bar ("Redact all / Restore"), floating scanning pill, hover reveal overlay.
- Detection pipeline: debounced typing detection (1200 ms), staged fast-path regex
  protection for long pastes (`FAST_PROTECTION_MIN_CHARS = 480`), GLiNER2 refinement,
  per-entity sensitivity thresholds, dedup/merge logic, send-blocking while protection
  is pending.
- Mask mode (`[NAME_1 REDACTED]`) and optional Maya **anonymize** mode through the local
  `/anonymize` proxy; per-site alias ledger with 30-day TTL; assistant-response
  restore on-device only.
- Shared regex catalog (`extension/pattern_catalog.js`) covering API keys, JWTs, IPv6,
  PAN/Aadhaar/IFSC, etc., plus user-defined custom patterns (length-capped, ReDoS
  match cap).
- Security work already done in 1.2.5–1.2.8: extension CSP, XSS fix in
  `textToHtmlPreserveLayout`, sender-tab guard, origin-restricted CORS on the server,
  request body size limit, metadata-only logging for anonymize *requests*.
- CI: JS unit tests, Python server tests, Playwright e2e with a mock server, CodeQL,
  version-sync check (package.json ↔ manifest.json ↔ pyproject.toml).

Key files:

| Area | File | Size |
|---|---|---|
| Content script (all in-page UI + pipeline) | `extension/content.js` | ~3,500 lines |
| Service worker (detection routing, server mgmt, Maya proxy client) | `extension/background.js` | ~1,370 lines |
| Popup + full-page settings logic | `extension/popup.js` | ~2,120 lines |
| Settings page | `extension/options.html` / `options.css` | sections: server, protection, detection, pii, advanced, about |
| Local server | `server/gliner2_server.py` | ~1,150 lines, stdlib `ThreadingHTTPServer` |
| Native host | `server/native_host.py` | ~890 lines |

---

## 2. Ground rules for implementers (read before every task)

1. **Surgical diffs only.** Touch only the files listed in the task. No drive-by
   refactors, no reformatting of untouched code, no new abstractions unless the task
   says so.
2. **No new runtime dependencies** (npm or Python) without explicit approval. The
   server is intentionally stdlib-only; the extension is intentionally vanilla JS.
3. **Never log raw PII.** Any new log line must contain only counts, labels, hashes,
   or masked previews. This is a hard rule; PRs violating it are rejected.
4. **Match existing style.** Vanilla JS, no frameworks, 2-space indent, the existing
   `═══` section-banner comment convention in content.js. Python follows the existing
   typed, stdlib style.
5. **Every task ships with tests.** JS logic → `tests/js/test_background_utils.js`
   pattern (plain node asserts); server → `tests/server/test_http_handler.py` pattern;
   UI behavior → Playwright spec in `tests/e2e/` against `tests/e2e/mock_server.js`.
6. **Update `CHANGELOG.md`** under an `## [Unreleased]` heading (create it if absent).
   Do **not** bump versions — releases bump versions via `npm run version:sync`.
7. One task = one branch = one PR. Name branches `task/<id>-<slug>`, e.g.
   `task/h1-anonymize-log-scrub`.
8. Before opening the PR, run the full local gate (Section 3) and paste its output in
   the PR description.

---

## 3. Verification protocol (run for every task)

Implementer runs locally, reviewer re-runs on the PR branch:

```bash
npm run lint                  # eslint on extension/*.js
npm run test:unit             # node JS unit tests
npm run test:unit:python      # pytest tests/server/
npm run test:e2e              # Playwright against mock server (needs chromium)
npm run version:check         # must still pass (no version drift)
```

Reviewer additionally:

1. Reads the full diff; rejects anything outside the task's file list.
2. Greps for new logging of payload fields: `grep -n "response=\|text=\|sourceText" <changed files>`.
3. Runs the task-specific verification steps listed in the task.
4. For UI tasks: loads `extension/` unpacked in Chrome, opens
   `tests/fixtures/regex_smoke_demo.html`, and walks the manual script in the task.

---

## 4. Wave 1 — Privacy & security hardening (do first)

These directly back the privacy-policy claims in `docs/PRIVACY_POLICY_DRAFT.md` (the
draft's "Gaps To Fix" list calls out several of them explicitly). The policy cannot be
published honestly until H1, H5, and H6 land.

---

### H1 — Stop logging anonymization response bodies on the local server

**Priority: P0 · Effort: S · Files: `server/gliner2_server.py`, `tests/server/test_http_handler.py`, `docs/SECURITY.md`**

**Background.** The Maya anonymization response maps original PII → replacement values.
`proxy_anonymization()` currently logs the **entire parsed response**:

- `server/gliner2_server.py` `response.inbound` event — `response=parsed` (full body, ~line 380–386).
- `response.http_error` and `response.non_json` log `body_preview` up to 1,200 chars.

That writes raw PII into the server log (`.runtime/` log files, journald on Linux),
contradicting `docs/SECURITY.md` ("the local server should not log raw anonymisation
values") and the privacy draft.

**Directions.**

1. In `log_anonymization("response.inbound", ...)`, replace `response=parsed` with
   metadata only: `status=status_code`, `response_type=type(parsed).__name__`,
   `items_count=len(parsed) if isinstance(parsed, list) else None`.
2. For `response.http_error`: replace `body_preview=body[:1200]` with
   `body_chars=len(body)`. Keep `status`. The `RuntimeError` raised to the caller may
   keep a short detail (`body[:320]`) **only if** you first strip it through a new
   helper `scrub_upstream_detail(body)` that returns the body only when it parses as
   JSON containing an `error`/`message` string field; otherwise return
   `"<non-json upstream error body omitted>"`.
3. Same treatment for `response.non_json`: log `body_chars`, not `body_preview`.
4. Add an escape hatch for debugging: if env var `AI_SAFE_PLUGIN_DEBUG_ANON_LOGS=1` is set,
   restore the old verbose behavior. Read it once at module import next to the other
   env reads. Document the variable in `docs/SECURITY.md` ("Local server logs" bullet).
5. Tests (extend `tests/server/test_http_handler.py` or `test_utils.py`, following the
   existing capsys/monkeypatch patterns): simulate a successful proxy response and a
   422 HTTPError; assert captured stdout contains `items_count`/`body_chars` and does
   **not** contain a sentinel PII string placed in the fake response body (e.g.
   `"SENTINEL_SECRET_VALUE"`).

**Constraints.** Do not change the function's return value, the HTTP status mapping,
or `request.outbound` logging (already metadata-only).

**Acceptance criteria.**
- With the env var unset, no code path prints upstream response content.
- New tests fail on the old code and pass on the new code.

**Reviewer verification.** Run the gate; then
`grep -n "body_preview\|response=parsed" server/gliner2_server.py` → only inside the
`AI_SAFE_PLUGIN_DEBUG_ANON_LOGS` branch.

---

### H2 — Shared-secret authentication between extension and local server

**Priority: P0 · Effort: L · Files: `server/gliner2_server.py`, `server/native_host.py`, `extension/background.js`, `tests/server/test_http_handler.py`, `tests/server/test_native_host.py`, `tests/js/test_background_utils.js`, `docs/SECURITY.md`**

**Background.** Today **any local process — and any web page served from
`http://localhost:<any port>`** — can POST to `/detect`, `/classify`, `/structure`,
and `/anonymize` (`_is_allowed_origin` allows all `http://localhost:*` origins, and
non-browser clients send no Origin at all). `/anonymize` even forwards an attacker's
chosen payload upstream with whatever token they supply. A local-only model is fine,
but "best in category" means the detection endpoints should only serve AI-Safe Plugin.

**Design (implement exactly this; do not invent alternatives).**

1. **Token creation (server).** On startup, the server generates a random token
   `secrets.token_hex(32)` and writes it to `RUNTIME_DIR / "server_token"` with mode
   `0o600` (use `os.open` with `O_CREAT|O_WRONLY|O_TRUNC, 0o600`; on Windows just
   write the file). Reuse an existing valid token file if present (so restarts don't
   invalidate clients). Add `--print-token-path` to `parse_args()` for diagnostics.
2. **Enforcement (server).** In `do_POST`, before routing: read header
   `X-AI-Safe-Plugin-Token`; compare to the in-memory token with `hmac.compare_digest`. On
   mismatch → `401 {"ok": false, "error": "Missing or invalid AI-Safe Plugin token."}`.
   `GET /health` stays unauthenticated but add `"authRequired": true` to its JSON so
   the extension can detect old/new servers. Add `--no-auth` CLI flag (and env
   `AI_SAFE_PLUGIN_NO_AUTH=1`) that disables enforcement — needed for the e2e mock parity and
   for users running custom setups; when disabled, `/health` reports
   `"authRequired": false`.
3. **Token transport (native host).** Add a new native-host action `get_server_token`
   in `server/native_host.py`'s action dispatcher that reads
   `RUNTIME_DIR/server_token` and returns `{"ok": true, "token": "..."}`, or
   `{"ok": false, "error": "token_unavailable"}` if missing. Follow the structure of
   the existing `status` action.
4. **Client (background.js).** Where the service worker calls the local server
   (`/health` ~line 1149, `/classify` ~line 1049, `/anonymize` ~line 364, and the
   detect path), add a small token manager:
   - On startup and whenever a request gets a 401: call the native host
     `get_server_token` (reuse the existing `NATIVE_HOST_NAMES` connection helper),
     cache the token in a module-level variable and in
     `chrome.storage.local` under `aiSafePluginServerToken`.
   - Attach `X-AI-Safe-Plugin-Token` header to every local-server POST.
   - If `/health` reports `authRequired: false`, skip the header logic.
   - If the token can't be obtained and the server requires auth, surface the existing
     "setup needed" state (do not invent new UI).
5. **Mock server.** Update `tests/e2e/mock_server.js` to accept any token (it plays
   the `--no-auth` role) and assert in one e2e case that the header is present.

**Constraints.** Don't break the no-native-host flow: if the native host is not
installed but the server runs with `--no-auth`, everything must keep working. The
installers/autostart scripts need **no changes** (token is server-generated at
runtime).

**Acceptance criteria.**
- `curl -X POST http://127.0.0.1:8765/detect -d '{"text":"a"}'` → 401 without token,
  200 with the token from `.runtime/server_token`.
- Extension works end-to-end against an auth-enabled server (manual check) and against
  the mock server (e2e green).
- Python tests cover: token file created with restrictive mode, 401 on bad token,
  200 on good token, `--no-auth` bypass, native-host `get_server_token` action.

**Reviewer verification.** Run the gate; start the real server
(`npm run run-gliner2-lazy`), run the two curl probes above, and load the unpacked
extension to confirm detection still works on the demo fixture page.

---

### H3 — Local-server network hygiene: Host validation + socket timeouts

**Priority: P1 · Effort: S · Files: `server/gliner2_server.py`, `tests/server/test_http_handler.py`**

**Background.** DNS-rebinding defense and slow-client robustness. The handler never
checks the `Host` header, and `BaseHTTPRequestHandler` has no socket timeout, so a
client can hold a connection (and a thread) open indefinitely.

**Directions.**

1. In the `Handler` class (`make_handler`), set class attribute `timeout = 30`
   (BaseHTTPRequestHandler honors it per-request) and handle the resulting
   `socket.timeout` by closing the connection silently.
2. Add `_is_allowed_host(self) -> bool`: parse `self.headers.get("Host", "")`,
   strip the port, and allow only `127.0.0.1`, `localhost`, `[::1]`, or the host the
   server was bound to (`args.host` — thread it through `make_handler` as a parameter).
   Reject otherwise with `403 {"ok": false, "error": "Forbidden host."}` at the top of
   `do_GET`, `do_POST`, `do_OPTIONS` (before origin checks).
3. Tests: requests with `Host: evil.example` → 403; `Host: 127.0.0.1:8765` → normal.

**Constraints.** Don't touch CORS logic here (H4 owns it). Don't change the binding
default.

**Acceptance criteria.** New pytest cases pass; existing handler tests untouched and
green.

**Reviewer verification.** `curl -H 'Host: evil.example' http://127.0.0.1:8765/health`
→ 403; normal curl → 200.

---

### H4 — Tighten CORS to extension origins only

**Priority: P1 · Effort: S · Files: `server/gliner2_server.py`, `tests/server/test_http_handler.py`, `docs/SECURITY.md`**

**Background.** `_is_allowed_origin` (~line 880) currently allows **any**
`http://localhost:*` / `http://127.0.0.1:*` origin, meaning any locally served web app
can call the API from the browser. Once H2 lands, the token is the real gate; CORS
should still be least-privilege.

**Directions.**

1. Restrict `_is_allowed_origin` to `chrome-extension://` and `moz-extension://`
   prefixes only.
2. Add env override `AI_SAFE_PLUGIN_EXTRA_ALLOWED_ORIGINS` (comma-separated exact origins) for
   power users; parse once at startup, pass into `make_handler`.
3. Update the SECURITY.md threat-model table row for the local server.
4. Update/extend the handler tests: localhost origin now rejected, extension origin
   accepted, env override honored.

**Constraints.** Depends on H2 being merged first only for **sequencing of the e2e
suite** — check how `tests/e2e/mock_server.js` is fetched (it is called from the
extension origin, so it should be unaffected); if any test currently exercises a
localhost-origin fetch, update the test, not the policy.

**Acceptance criteria.** Tests prove localhost-origin browser requests are rejected;
extension flows unaffected (e2e green).

---

### H5 — Fix overclaiming copy ("Your data never leaves your machine")

**Priority: P0 · Effort: S · Files: `extension/manifest.json`, `package.json`, `README.md`, `extension/popup.html`, `extension/options.html` (grep for the phrase)**

**Background.** The privacy draft explicitly flags `extension/manifest.json:6`. With
anonymize mode, selected detected values *do* leave the machine (to Maya). The store
listing must not contradict the privacy policy.

**Directions.**

1. `grep -rn "never leaves" extension/ README.md package.json docs/` and replace each
   hit with the agreed phrasing: **"Local detection by default. Optional Maya
   anonymisation only when you enable it."** For the manifest `description` (132-char
   limit), use: `"Real-time PII detection and redaction for AI chat interfaces. Local
   GLiNER2 detection by default."`
2. Do not change `name`, `version`, or permissions.
3. Update the e2e popup spec if it asserts on the old description text.

**Acceptance criteria.** Zero remaining hits for "never leaves" outside CHANGELOG
history; gate green.

---

### H6 — "Delete all AI-Safe Plugin data" control

**Priority: P1 · Effort: M · Files: `extension/options.html`, `extension/popup.js`, `extension/options.css`, `tests/e2e/popup.spec.js`**

**Background.** The privacy draft: "current reset restores default settings but does
not clear all tokens, redaction caches, or alias memories." A privacy product needs a
true wipe.

**Directions.**

1. In the **Advanced** section of `options.html` (`#section-advanced`), add a
   "Danger zone" card with a `Delete all AI-Safe Plugin data` button (reuse existing card +
   button classes from options.css; style destructive state like existing warning
   styles — check for an existing `danger`/`warn` class before adding CSS).
2. Wire it in `popup.js`'s settings manager: on click, show a confirm step (two-click
   pattern: button turns into "Click again to confirm", reverts after 5 s — no
   `window.confirm`).
3. On confirm: `chrome.storage.local.clear()`, then re-seed defaults by calling the
   existing default-settings save path, then notify all tabs with the existing
   settings-changed message so content scripts drop in-memory ledgers, then reload the
   options view.
4. List exactly what is removed in the card body copy: settings, custom patterns,
   Maya API key, anonymisation seed, server URL override, site alias ledgers, cached
   redaction state, onboarding flags, stats.
5. e2e: in `popup.spec.js`, seed a fake `aiSafePluginApiKey` + alias-ledger key into storage,
   click the button twice, assert storage contains only re-seeded defaults.

**Constraints.** Don't implement partial deletion toggles; one button, full wipe.

**Acceptance criteria.** After wipe, `chrome.storage.local.get(null)` contains only
default settings keys. e2e covers it.

---

### H7 — Release-asset integrity: checksums verified by installers

**Priority: P2 · Effort: M · Files: `.github/workflows/release.yml`, `scripts/installers/install.sh`, `scripts/installers/install.ps1`, `tests/server/test_unix_installer.py`, `tests/server/test_windows_installer.py`**

**Background.** Install is `curl | bash` of release assets (backend bundle, model
tarball). TLS to GitHub is the only integrity check. Publishing a `SHA256SUMS` file
and verifying it in the installers protects against truncated/corrupted downloads and
raises the bar for asset tampering.

**Directions.**

1. In `release.yml`, after all assets are staged, generate `SHA256SUMS` over every
   uploaded asset (`sha256sum * > SHA256SUMS`) and upload it as a release asset.
2. `install.sh`: after downloading each asset, download `SHA256SUMS` from the same
   release, and verify with `sha256sum --check --ignore-missing`. On failure: abort
   with a clear message. If `SHA256SUMS` is missing (older releases), print a warning
   and continue (back-compat).
3. `install.ps1`: same logic with `Get-FileHash -Algorithm SHA256`.
4. Extend the installer tests to cover: matching checksum passes, corrupted file
   aborts, missing SHA256SUMS warns-and-continues. Follow the existing installer test
   patterns (they already shell out / mock downloads).

**Acceptance criteria.** Both installers verify checksums; tests cover the three
paths; a dry-run of `install.sh` against a locally staged fake release works.

---

### H8 — Publish the privacy policy and align surfaces

**Priority: P1 · Effort: M (mostly writing) · Files: `docs/PRIVACY_POLICY_DRAFT.md` → `docs/PRIVACY_POLICY.md`, `extension/options.html` (About section link), README footer, gh-pages site**

**Background.** Draft exists with a self-audit of gaps. H1/H5/H6 close the technical
gaps; this task finalizes and publishes.

**Directions.**

1. Wait for H1, H5, H6 to merge (they change what the policy can truthfully claim).
2. Promote the draft: remove the internal "Gaps" preamble, fix the items it lists
   (each is either resolved by H1/H5/H6 or must be disclosed as-is: plaintext API-key
   storage in `chrome.storage.local`, `<all_urls>` access, server-URL override risk,
   GitHub/HF/PyPI network touchpoints).
3. Link it from the options About section and the README.
4. Keep `Privacy Policy.docx` out of the repo (it's an untracked working file — do not
   commit it; add `*.docx` to `.gitignore`).

**Acceptance criteria.** Policy contains no claim contradicted by code (reviewer
cross-checks each claim against the codebase); linked from extension About + README.

---

## 5. Wave 2 — Grammarly-grade usability

Ordered by user-visible impact. U0 is the flagship visual overhaul; U0–U3 together
are the "feels like Grammarly" core.

---

### U0 — Per-field status badge: replace the scanning pill, consolidate the floating UI

**Priority: P0 (UX) · Effort: L · Files: `extension/content.js`, `extension/styles.css`, `tests/e2e/detection.spec.js`, `tests/e2e/fixtures.js`**

**Background.** AI-Safe Plugin currently injects up to **three separate floating surfaces per
field**, and the most visible one is the worst:

- The **scanning pill** (`showScanningPill`, content.js ~line 1028) is a ~210 px
  banner reading "AI-Safe Plugin / Scanning..." that positions itself **over the top-center of
  the input, on top of the user's own text** (`positionScanningPill` centers it
  horizontally inside the field at ~18% height). It also grows a "High Risk" badge
  via inline `style.cssText` (`updateScanningPillWithSensitivity`).
- The **action bar** (`showActionBar`, ~line 2841) floats below the field with
  emoji-labelled buttons (`🛡 Redact All (3)`) and a `3 PIIs` count label.
- The **token tray** (`renderTokenTray`) is a third floating surface.

This reads as three different widgets from three different products. Grammarly ships
exactly **one** affordance: a ~26 px circle pinned to the bottom-right corner of the
field that morphs between states (logo → spinner → red count → green check) and opens
a single panel on click. That is the bar for "professional."

**Target design (implement exactly this):**

```
            ┌──────────────────────────────────────────────┐
            │ My name is John Smith and my email is        │
            │ john@example.com                             │
            │                                              │
            │                                       (V)    │ ← idle: muted AI-Safe Plugin mark
            └──────────────────────────────────────────────┘
   States of the badge (26px circle, 8px inset from bottom-right):
   idle       (V)  monogram, 45% opacity, only while field is focused
   scanning   (◌)  monogram + thin rotating ring (no text, no "Scanning...")
   pending    (3)  amber filled circle with white count (caps at 9+)
   protected  (✓)  green filled circle with check
   fallback   (V)  monogram with small gray dot (regex-only / server offline)

   Click badge →  one anchored panel (replaces action bar + tray):
            ┌────────────────────────────────┐
            │ AI-Safe Plugin · 3 items   [High risk]   │ ← risk chip moves here from the pill
            │ ─────────────────────────────  │
            │ ● Email  john@example.com   ⊘ ✓│ ← per-item: dismiss / redact
            │ ● Person John Smith         ⊘ ✓│
            │ ─────────────────────────────  │
            │ [ Redact all ]   [ Restore ]   │ ← no emoji, sentence case
            └────────────────────────────────┘
```

**Directions.**

1. **Build the badge.** New methods `showFieldBadge(element)`,
   `updateFieldBadge(element, state)`, `hideFieldBadge(element)`, replacing the
   `scanningPills` map with `fieldBadges`. One fixed-position `<div>` per monitored
   element appended to `document.body` (same anchoring strategy as today). Position:
   bottom-right **inside** the field rect, 8 px inset, clamped by
   `getOverlayClipRect(element)` so it clips correctly in internal-scroll editors
   (Gemini/Claude composers). Reposition through the existing
   `scheduleAnchoredUiRefresh` / `refreshAnchoredUi` scheduler — extend
   `repositionScanningPills` into `repositionFieldBadges` rather than adding a new
   loop.
2. **State machine.** Badge state is derived, never set ad hoc:
   - `scanning` while a detection request is in flight for the element (hook the same
     call sites that currently call `showScanningPill` / `hideScanningPill`).
   - `pending: n` when `state.items.filter(i => !i.redacted && !dismissed).length > 0`.
   - `protected` when items exist and all are redacted.
   - `idle` when focused with no items; badge hides on blur after ~2 s **unless**
     state is `pending` (pending stays visible — that's the safety signal).
   - `fallback` modifier dot when the model is offline and regex-only protection is
     active (the controller already knows this from the model-init/health state).
   - Visibility rule: never show on fields narrower than 80 px or shorter than 28 px.
3. **SVG monogram, no text.** Inline a small `<svg>` of the AI-Safe Plugin mark (derive from
   `extension/assets/icons/ai-safe-plugin-icon.svg`, simplified to single-color path). No
   "AI-Safe Plugin / Scanning..." copy anywhere. Hover shows a native-feeling tooltip
   (`title` attribute is fine for v1): "AI-Safe Plugin — scanning", "3 items need attention",
   "All items protected", "AI-Safe Plugin — regex-only mode".
4. **Build the panel.** Clicking the badge toggles one anchored panel that replaces
   **both** `showActionBar` and the token tray for the focused field:
   - Header: "AI-Safe Plugin · N items" + risk chip (`High risk` / `Moderate risk`) sourced
     from the same classify result that currently feeds
     `updateScanningPillWithSensitivity` — delete that method and its inline
     `style.cssText` styling; the chip is styled in `styles.css`.
   - Item rows: colored type dot (`getTypeColor`), label, value preview
     (`textContent`, middle-truncated to ~28 chars), per-row actions: redact
     (`redactSingle`) / restore (`toggleRedaction`) / dismiss (`dismissDetection`).
   - Footer: `Redact all` (primary) and `Restore all` (ghost) buttons — **plain text,
     sentence case, no emoji**; reuse the existing handlers from `showActionBar`.
   - Panel anchors below the field (flip above when there's no room — same clamp
     math as `positionActionBar`), closes on outside click, `Escape`, blur of both
     field and panel, and on scroll beyond the clip rect.
5. **Delete the replaced surfaces.** Remove `showScanningPill`,
   `positionScanningPill`, `repositionScanningPills`,
   `updateScanningPillWithSensitivity`, `hideScanningPill`, `showActionBar`,
   `removeActionBar`, `positionActionBar`, `repositionActionBars`, the
   `scanningPills`/`actionBars` maps, and their CSS blocks (`.ps-scanning-pill*`,
   `.ps-action-bar*` in styles.css). The token tray (`renderTokenTray`) **stays for
   now** but only renders while the panel is closed and detections are redacted —
   if the panel fully covers its job, removing the tray is a follow-up task, not part
   of this one.
6. **Visual spec** (put these in `styles.css` as CSS variables under a
   `.ps-field-badge` namespace): 26 px circle; `box-shadow: 0 1px 4px rgba(0,0,0,.18)`;
   amber `#B45309`, green `#15803D`, idle `currentColor` at 45% opacity on a white
   96%-opacity disc; 120 ms ease transitions; spinner and all transitions gated
   behind `@media (prefers-reduced-motion: no-preference)`; `z-index` matching the
   existing anchored-UI tokens (top of styles.css, lines ~13–18). Dark-background
   detection is **out of scope** — the white disc works on both.
7. **Tests.** Update `detection.spec.js`: assertions that referenced
   `.ps-scanning-pill` / `.ps-action-bar` now target `.ps-field-badge` /
   `.ps-field-panel`. New cases: badge shows count after detection; click opens
   panel; "Redact all" from panel redacts; badge turns green; badge persists on blur
   while pending; badge hides on blur when idle; badge clips inside internal-scroll
   editor fixture (the hostile-editor fixture already exists).

**Constraints.** Do not touch the underline spans, popover (U2), detection pipeline,
or send-guards. No images — inline SVG only. The badge must never intercept typing:
`pointer-events` only on the badge itself, and it must never overlap the field's last
line of text by more than its own height (it sits in the padding corner like
Grammarly; accept overlap — Grammarly does).

**Acceptance criteria.**
- While typing, **nothing covers the user's text** — the only scan indicator is the
  corner badge.
- Exactly one AI-Safe Plugin surface visible per field at rest (badge), two when the panel is
  open.
- No emoji in any injected UI string. No inline `style.cssText` styling remains in
  the touched methods.
- All five badge states reachable and visually distinct (manual script: idle →
  type email → scanning → pending 1 → redact → protected; kill server → fallback dot).
- e2e suite green, including the hostile-editor fixture.

**Reviewer verification.** Run the gate; load unpacked on the demo fixture **and** on
chatgpt.com; screenshot each badge state; confirm the pill/action-bar code and CSS are
fully deleted (`grep -rn "scanning-pill\|action-bar\|scanningPills\|actionBars" extension/` → no hits).

---

### U1 — Toolbar badge with live detection count

**Priority: P1 · Effort: M · Files: `extension/background.js`, `extension/content.js`, `tests/e2e/detection.spec.js`**

**Background.** Grammarly's red/green count on its icon is its primary ambient signal.
AI-Safe Plugin computes page stats (`pageStats`, served via the `getPageStats` message) but the
toolbar icon is static — users only see state by opening the popup.

**Directions.**

1. **content.js:** wherever `pageStats` / active detections change (the render path
   `renderElement` and the dismiss/redact handlers — find the single choke point where
   the popup's `getPageStats` numbers are derived), send a throttled (≤1/sec)
   `chrome.runtime.sendMessage({ action: 'aiSafePluginStatsPush', detected, protected })`.
2. **background.js:** in the existing `chrome.runtime.onMessage` listener (~line 1254),
   handle `aiSafePluginStatsPush` (sender-tab-guarded like the others): compute
   `pending = detected - protected`; call `chrome.action.setBadgeText({ tabId,
   text: pending > 0 ? String(pending) : (protected > 0 ? '✓' : '') })` and
   `setBadgeBackgroundColor` — amber `#B45309` when pending > 0, green `#15803D` when
   all protected. Clear badge on `chrome.tabs.onUpdated` navigation events for that tab.
3. Numbers cap at `99+`.
4. e2e: extend `detection.spec.js` — after a detection appears, assert
   `chrome.action.getBadgeText` (via the extension's service-worker context in
   Playwright) equals the expected count.

**Constraints.** No polling; push-based only. No new permissions (`action` API needs
none beyond the existing `action` manifest key).

**Acceptance criteria.** Typing a detectable email on the demo page shows an amber
count within ~1 s; clicking "Redact all" flips it to green ✓; navigating away clears it.

---

### U2 — Bring back the anchored detection card (hover popover)

**Priority: P1 · Effort: L · Files: `extension/content.js`, `extension/styles.css`, `tests/e2e/detection.spec.js`**

**Background.** Grammarly's signature interaction is the hover card on an underline:
what was found, why it matters, and actions. AI-Safe Plugin **removed** its popover —
`showPopover` is now an empty no-op (content.js ~line 2410) and the only affordance is
"click underline = redact", which is fast but unexplained. New users don't learn what
the colors mean, can't dismiss a single false positive from the underline, and have no
"why this matters" context.

**Directions.**

1. Rebuild `showPopover(anchorSpan, element, index, mode, anchorRect)` as a
   fixed-position card appended to `document.body` (never inside the editable —
   follow the pattern of `showRevealOverlay`, which already solves positioning,
   hover-intent, and rich-editor DOM-reconciliation survival; reuse its
   open/close-timer fields `revealOpenTimer` / `activePopoverHideTimer`).
2. Card contents (build with `createElement`/`textContent` only — **no innerHTML with
   user data**):
   - Header row: colored dot (reuse `getTypeColor(item.label)`), human label
     ("Email address"), confidence tier chip (`item.tier`: high/medium/low).
   - One explanation line per label from a new `LABEL_EXPLANATIONS` map, e.g.
     `email: "Email addresses can identify you and invite spam or phishing."` Cover
     all labels in `getMaskText`'s map; fall back to a generic line.
   - Action row: **Redact** (primary, calls existing `redactSingle`), **Dismiss**
     (calls existing `dismissDetection`), **Ignore on this site** (only after U3;
     until then omit this button).
3. Trigger: `mouseenter` on `.ps-pii-underline` spans with 250 ms open delay, close on
   leave of both span and card (150 ms grace), `Escape` closes, scroll/resize closes
   (hook into the existing `scheduleAnchoredUiRefresh`).
4. On redacted spans (`.ps-redaction`), keep the existing reveal-overlay behavior —
   the card is for **pre-redaction** underlines only.
5. Styles in `styles.css` under a `ps-popover` namespace; they already partially exist
   (`ps-popover-visible` is referenced in `hidePopover`) — audit and rebuild cleanly.
   Respect `prefers-reduced-motion`.
6. e2e: hover an underline on the demo fixture → card appears with the right label;
   click Dismiss → underline disappears and card closes; click Redact → token appears.

**Constraints.** Plain `textarea`/`input` + contenteditable spans first; for the
overlay-highlight ("hostile editor") path, attach the same card to the overlay
highlight divs (`_ceOverlayHighlights`) — if that proves unstable, ship without it and
file a follow-up, but say so in the PR.

**Acceptance criteria.** Card works on ChatGPT-style contenteditable and plain
textarea in the e2e fixtures; no XSS vector (reviewer greps the diff for `innerHTML`);
keyboard: `Escape` closes; no flicker when moving pointer from span to card.

---

### U3 — Persistent "ignore" list (per-site allowlist of values)

**Priority: P1 · Effort: M · Files: `extension/content.js`, `extension/background.js` (storage key constants if shared), `extension/options.html`, `extension/popup.js`, `tests/js/test_background_utils.js`, `tests/e2e/detection.spec.js`**

**Background.** Dismissals live in a per-element `WeakMap` (content.js line 146) keyed
by `"start:end:label"` — they evaporate on reload and even on retype. Grammarly
remembers "ignore this". AI-Safe Plugin flagging your own company name in every prompt forever
is the #1 churn risk for daily users.

**Directions.**

1. New storage shape under key `aiSafePluginIgnoredValues`:
   `{ [siteHost]: [{ value, label, addedAt }] }` where `value` is the exact matched
   text trimmed, `label` the detection label, max 200 entries/site (FIFO eviction),
   90-day TTL pruned on load (mirror the site-alias-ledger TTL pattern, which already
   does load-prune-persist — copy that mechanism).
2. Load alongside `loadSiteAliasLedger()` in `init()`; store on the controller as
   `this.siteIgnoredValues` (a `Map<label, Set<value>>` after normalization;
   case-sensitive exact match).
3. Filter: in `detectAndHighlight` where `dismissedDetections` is consulted
   (~line 1272), also drop detections whose `(label, text)` is in the ignore set.
   Apply the same filter in the fast-protection path (`applyFastLocalProtection`).
4. Add the "Ignore on this site" action to the U2 card **and** as a third per-row
   action in the U0 panel; both call a new `ignoreDetectionValue(element, index)`
   that updates the in-memory set, persists (debounced, like the alias ledger),
   dismisses the current detection, and re-renders.
5. **Options UI:** in `#section-detection` (or `#section-pii`, whichever holds type
   toggles), add an "Ignored values" card listing entries grouped by site with a
   remove (×) per entry and "Clear all". Render with `textContent`. Wire through the
   existing SettingsManager load/save plumbing in popup.js.
6. Unit-test the prune/evict/normalize helpers by extracting them into
   `pattern_catalog.js`-style pure functions if needed (or a small new shared module
   loaded by both contexts — follow how `pattern_catalog.js` is shared via
   `globalThis.AI_SAFE_PLUGIN_PATTERN_CATALOG`).

**Constraints.** Ignore lists must NOT apply to high-risk structured secrets:
hard-exclude labels `ssn`, `credit_card`, `private_key`, `api_key`, `jwt`,
`connection_string`, `aadhaar` — the card simply doesn't offer "Ignore" for those.

**Acceptance criteria.** Ignored value stays ignored after page reload (e2e proves
it); options page lists and removes entries; excluded labels never show the Ignore
button.

---

### U4 — Keyboard shortcuts

**Priority: P2 · Effort: S · Files: `extension/manifest.json`, `extension/background.js`, `extension/content.js`, `README.md`, `extension/options.html` (document shortcuts in About)**

**Directions.**

1. Add to manifest:
   ```json
   "commands": {
     "ai-safe-plugin-redact-all": { "suggested_key": { "default": "Alt+Shift+R" }, "description": "Redact all detections in the focused field" },
     "ai-safe-plugin-toggle": { "suggested_key": { "default": "Alt+Shift+V" }, "description": "Pause/resume AI-Safe Plugin on this site" }
   }
   ```
2. background.js: `chrome.commands.onCommand` → forward to the active tab via the
   existing `sendMessage` plumbing as actions `commandRedactAll` / `commandToggleSite`.
3. content.js `handleRuntimeMessage`: `commandRedactAll` → call `redactAll` on the
   currently-focused monitored element (track focus; if none, the element with pending
   detections); `commandToggleSite` → flip the U5 per-site pause (if U5 not yet
   merged, toggle the global `enabled` setting instead and note it in the PR).
4. Document both in README "Key Features" and the options About section.

**Acceptance criteria.** Shortcuts work on the demo page (manual check); unit test
covers the message routing; no conflict with Chrome reserved combos.

---

### U5 — Per-site quick controls in the popup (pause / exclude)

**Priority: P1 · Effort: M · Files: `extension/popup.html`, `extension/popup.js`, `extension/content.js`, `extension/popup.css`, `tests/e2e/popup.spec.js`**

**Background.** Site control today is a global "monitor all sites" toggle plus a
multiline allowlist textarea buried in Advanced (popup.js lines 307–345). Grammarly's
per-site toggle in the popup is the convenience benchmark. Users on a trusted internal
tool need "not here" in two clicks, not a settings spelunk.

**Directions.**

1. New storage keys: `excludedSites: string[]` and
   `siteSnoozes: { [host]: untilEpochMs }`.
2. **popup.html/js:** at the top of the popup (under the status header), show the
   current tab's host with two controls: `Pause 1 hour` and a `On/Off here` toggle.
   - Toggle off → add host to `excludedSites`; on → remove.
   - Pause → `siteSnoozes[host] = Date.now() + 3600_000`; show countdown text
     ("Paused · resumes 14:32"); a `Resume` button clears it.
   - Get the host from the active tab via the existing `getActiveTabId` +
     `chrome.tabs.query` pattern; normalize with the same logic as content.js
     `normalizeSiteHost` (move that helper into `pattern_catalog.js` so popup,
     background, and content share one copy — it currently lives only in content.js).
3. **content.js:** `isSiteMonitored()` additionally returns false when the host
   matches `excludedSites` (use `hostMatchesSite`) or has an unexpired snooze. Listen
   for the settings-changed broadcast to tear down/re-init live (the reconciler
   already handles enable/disable — reuse that path).
4. Expired snoozes are pruned on read.
5. e2e: popup spec — toggle off on the fixture host, assert no underlines render;
   toggle back on, assert they return.

**Constraints.** Don't redesign the popup layout; add one compact row. `excludedSites`
wins over `monitoredSites` allowlist.

**Acceptance criteria.** Two-click site disable from popup, live (no manual reload
needed beyond what the existing settings broadcast already requires); snooze
auto-expires.

---

### U6 — First-run interactive playground

**Priority: P2 · Effort: M · Files: new `extension/playground.html` + `extension/playground.js` + reuse `options.css`, `extension/popup.js` (link), `extension/manifest.json` (web_accessible_resources NOT needed — open via `chrome.runtime.getURL`), `tests/e2e/popup.spec.js`**

**Background.** After install, users must go to a real AI site and type PII to see
AI-Safe Plugin work. `tests/fixtures/regex_smoke_demo.html` already proves the concept as a test
fixture. A "try it" page converts installs into activated users and doubles as a
support/diagnostic tool.

**Directions.**

1. Create `extension/playground.html`: a single centered card with one large
   `textarea`, a "Insert sample text" button (sample includes a fake name, email,
   phone, AWS-style key — copy the clearly-synthetic values from
   `tests/fixtures/regex_smoke_corpus.js`, never realistic ones), and a short legend
   explaining underline colors and the token tray.
2. The content script must run there: extension pages are not matched by
   `<all_urls>` content scripts, so `playground.js` should itself load
   `pattern_catalog.js` + `content.js` via `<script src=...>` tags in the page (same
   files, no duplication) — verify the controller boots on an extension page; if
   `chrome.storage`/messaging behaves differently there, instead register the
   playground under `content_scripts.matches` is impossible, so fall back to opening
   the **hosted demo fixture** pattern: serve the playground as an extension page and
   confirm `chrome.runtime` APIs used by content.js all exist in that context
   (they do — extension pages have full access). Note findings in the PR.
3. Link it: onboarding final step ("Try it now") and options About section.
4. e2e: open the playground page, click sample text, assert underlines + redact-all
   works offline (mock server).

**Acceptance criteria.** Fresh profile → onboarding → playground → type/insert sample
→ see underlines, hover card (U2), redact all — without visiting any third-party site.

---

### U7 — Local privacy stats ("what AI-Safe Plugin saved you")

**Priority: P3 · Effort: M · Files: `extension/content.js`, `extension/popup.js`, `extension/options.html`, `tests/js/test_background_utils.js`**

**Background.** Grammarly's weekly stats build retention. AI-Safe Plugin counts per-page stats
but nothing durable. Aggregate counters are cheap and privacy-safe.

**Directions.**

1. On each redaction event, increment counters in `chrome.storage.local` under
   `aiSafePluginStats`: `{ totalProtected, byLabel: {label: n}, byWeek: {"2026-W24": n} }`.
   **Counts only — never store values or sites.** Batch writes (flush ≤1/10 s).
2. Show in options About or a new small card: total protected, top 3 types, this-week
   number. Include the stats in the H6 wipe.
3. Unit-test the counter merge + week-key helpers as pure functions.

**Acceptance criteria.** Counters survive restarts, contain no strings other than
label keys and week keys (reviewer inspects storage dump in e2e).

---

### U8 — Accessibility pass on injected UI

**Priority: P2 · Effort: M · Files: `extension/content.js`, `extension/styles.css`**

**Directions.**

1. Field badge and panel (U0), token tray chips: badge gets `role="button"` +
   `aria-label` reflecting its state ("AI-Safe Plugin: 3 items need attention"), panel gets
   `role="dialog"` with focus trapped while open; buttons get `aria-label` (label
   only, no value: "Redact detected email"); chips become real `<button>`s if they
   aren't.
2. U2 popover: `role="dialog"`, `aria-label`, focus is NOT stolen on hover-open;
   `Escape` close (already in U2).
3. `aria-live="polite"` announcement element (visually hidden) that announces
   "3 items protected" after redact-all.
4. All animations gated behind `@media (prefers-reduced-motion: no-preference)`.
5. Verify contrast of underline/tray colors on white and dark backgrounds ≥ 3:1
   (adjust CSS variables only, not the color scheme).

**Acceptance criteria.** Manual screen-reader smoke (Orca/VoiceOver) on the playground:
tab reaches tray chips and action-bar buttons; reduced-motion verified by toggling the
OS setting.

---

## 6. Wave 3 — Convenience & performance

### P1 — Lazy content-script initialization

**Priority: P2 · Effort: M · Files: `extension/content.js`, `tests/e2e/detection.spec.js`**

**Background.** The controller boots on **every page** (`<all_urls>`): settings load,
model init ping, alias-ledger load, MutationObserver + polling fallback + state
reconciler — even on pages with no text inputs. This is wasted work on ~most browsing
and the main perf complaint vector for store reviews.

**Directions.**

1. Split `init()` into a cheap **arming phase** (load settings, check
   `isSiteMonitored`, then attach a single delegated `focusin` listener +
   one lightweight DOM probe for already-focused eligible elements) and a **full
   boot** (everything else: overlay, model init, ledgers, observers, reconciler,
   polling).
2. Full boot triggers on: first `focusin` matching `getPlatformSelectors()`, or
   immediately on known AI platforms (`detectPlatform() !== 'generic'`) to preserve
   current behavior where it matters.
3. Once booted, behavior is identical to today. Guard double-boot.
4. e2e: add a case asserting no scanning pill / observers on a fixture page **until**
   a field is focused (assert via absence of injected DOM), and that detection still
   fires after focus.

**Constraints.** Zero behavior change on chatgpt/claude/gemini hosts. Don't move code
between files.

**Acceptance criteria.** On a no-input fixture page, AI-Safe Plugin injects nothing and attaches
only the focusin listener (verify via Playwright DOM inspection); all existing e2e
stays green.

### P2 — Settings sync across devices (non-sensitive only)

**Priority: P3 · Effort: M · Files: `extension/background.js`, `extension/popup.js`**

Sync via `chrome.storage.sync` for: `enabled`, `sensitivity`, `redactionMode`,
`autoRedact`, `enabledTypes`, `customPatterns`, `monitorAllSites`,
`monitoredSites`, `excludedSites`. **Never sync:** `aiSafePluginApiKey`, anonymisation seed,
ledgers, caches, stats, server token. Local remains source of truth; sync is
write-through + apply-on-startup-if-newer (store `updatedAt`). Respect sync quota
(`QUOTA_BYTES_PER_ITEM` 8 KB — chunk custom patterns if needed). Update SECURITY.md
storage row (it currently states "no Chrome sync storage is used").

### P3 — Backlog (explicitly deferred, do not start without a new plan)

- Firefox/Edge port (MV3 differences, native-messaging manifest locations).
- i18n `_locales` scaffolding.
- Per-pattern regex execution budget (beyond the existing 1k-match cap).
- Encrypting the Maya API key at rest (no meaningful threat-model win inside the
  browser profile; revisit if a native-host keychain integration is planned).

---

## 7. Sequencing & dependency map

```
Wave 1:  H1 ──┐
         H5 ──┼──► H8 (publish policy)
         H6 ──┘
         H2 ──► H4        H3 (independent)        H7 (independent)

Wave 2:  U0 ──► U2 (card and panel must share visual language; build badge first)
         U0 ──► U8 (a11y pass covers the badge/panel)
         U2 ──► U3 (Ignore button lives on the card and in the U0 panel rows)
         U5 ──► U4 (toggle command targets U5's per-site pause)
         U1, U6, U7 independent (U6 ideally after U0+U2 so the playground shows the final UI)

Wave 3:  P1, P2 independent, after Wave 2 stabilizes.
```

Suggested order of execution (one PR each):
**H1 → H5 → H6 → H2 → H3 → H4 → H7 → H8 → U0 → U2 → U3 → U1 → U5 → U4 → U6 → U8 → U7 → P1 → P2**

U0 jumps the queue inside Wave 2 deliberately: every later UI task (popover, ignore
actions, playground, a11y) builds on the badge/panel as the single per-field surface,
and it is the change users will screenshot.

Effort legend: S ≤ ½ day · M ≈ 1–2 days · L ≈ 3–5 days (for a junior/small-model
implementer, including tests).

---

## 8. Reviewer (verifier) master checklist — applied to every PR

1. Diff touches only the task's listed files. ✅/❌
2. Full gate green (Section 3 commands). ✅/❌
3. No raw PII in any new log/storage/telemetry path (grep + read). ✅/❌
4. No `innerHTML`/`insertAdjacentHTML` with non-escaped dynamic strings. ✅/❌
5. New behavior covered by at least one automated test that fails on `main`. ✅/❌
6. CHANGELOG `[Unreleased]` entry present, honest, user-phrased. ✅/❌
7. Manual script from the task executed (record result in PR review). ✅/❌
8. For storage-schema changes: old profiles load cleanly (test with a storage dump
   from current `main`). ✅/❌
