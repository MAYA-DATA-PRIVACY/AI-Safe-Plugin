# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Security

- The local server now requires a per-machine shared token on its detection endpoints (`/detect`, `/classify`, `/structure`, `/anonymize`). The server generates the token on startup and stores it with restricted permissions; the extension fetches it through the native messaging host and sends it as `X-AI-Safe-Plugin-Token`, so other local processes and localhost web pages can no longer drive detection. `/health` stays open and reports `authRequired`; auth can be disabled with `--no-auth` / `AI_SAFE_PLUGIN_NO_AUTH=1`.
- Tightened the local server's CORS policy to browser-extension origins only (configurable via `AI_SAFE_PLUGIN_EXTRA_ALLOWED_ORIGINS`); localhost web pages are no longer allowed to call the API from the browser.
- Added `Host`-header validation (loopback only) to defend against DNS rebinding, and a per-request socket timeout so a slow or idle client cannot tie up a server worker thread.
- Releases now publish a `SHA256SUMS` file, and both installers verify downloaded assets against it: a backend-bundle mismatch aborts the install, a model mismatch falls back to the Hugging Face download, and a missing `SHA256SUMS` (older releases) warns and continues.
- The local server no longer writes anonymisation response bodies to its logs. Anonymisation logging is now metadata-only by default (counts, status codes, and body sizes), so raw values returned by the Maya endpoint never reach the logs. Verbose logging can be restored for debugging by setting `AI_SAFE_PLUGIN_DEBUG_ANON_LOGS=1`.

### Changed

- Expanded the default monitored-sites list to cover today's major AI chat apps — ChatGPT, Claude, Gemini, Copilot, Perplexity, Grok, DeepSeek, Mistral Le Chat, Poe, Character.AI, Pi, You.com, Meta AI, Qwen, DuckDuckGo (duck.ai), Hugging Face, Phind, and T3 Chat — so scoped monitoring protects them out of the box. (With "monitor all sites" on by default, every site is already covered; this improves the allowlist used when you scope monitoring to specific sites.)
- AI-Safe Plugin now initializes lazily on ordinary websites: on pages that aren't known AI chat apps, it does no work until you focus a text field, instead of always loading its model ping, observers, and polling on every page. Known AI sites (ChatGPT, Claude, Gemini) still activate immediately on load.

### Added

- Added a local "Your privacy impact" summary in the options About section: a durable, privacy-safe tally of how many items you've protected in total, this week, and your top detection types. Counts only — it never stores the protected values or the sites you used — and the "Delete all data" control clears it.
- Added a first-run interactive playground: a built-in "try it" page (linked from the end of onboarding and the options About section) where new users can insert synthetic sample text and watch AI-Safe Plugin detect, underline, and redact it — using the real in-page engine, without visiting any third-party site and without sending anything anywhere.
- Accessibility pass on the in-page UI: the field badge is now a keyboard-operable button (Tab to it, Enter/Space opens the panel) with a screen-reader label that reflects its state; the detection panel is a focus-trapped dialog that closes on Escape and returns focus to the badge; status changes like "N items protected" are announced through an ARIA live region; toasts and token-tray chips carry proper roles/labels; and all animation continues to respect the reduced-motion setting.
- Added keyboard shortcuts: `Alt+Shift+R` redacts all detections in the focused field, and `Alt+Shift+V` toggles AI-Safe Plugin off/on for the current site using the per-site exclude list.
- Added per-site quick controls to the popup: the current host can be paused for one hour or turned off/on directly, backed by `excludedSites` and `siteSnoozes` storage that content scripts honor live.
- Added a live count on the AI-Safe Plugin toolbar icon: an amber badge shows how many detections still need attention on the current page, flips to a green check when everything is protected, and clears when you navigate away — so you get an at-a-glance signal without opening the popup. Push-based and throttled; no new permissions.
- Brought back the hover popover on detection underlines: hovering an unredacted detection now shows a small card with the detection type, a one-line explanation of why it matters, and Redact / Dismiss actions — so the colored underlines are self-explanatory. The card works on rich-editor (ChatGPT/Gemini/Claude-style) fields, closes on Escape or pointer-out, and respects reduced-motion.
- Added a persistent per-site "Ignore on this site" action (on the hover popover and the field panel) so AI-Safe Plugin stops flagging values you've marked as safe — and remembers them across reloads. Ignored values are stored per site, expire after 90 days, and can be reviewed or removed from the new "Ignored Values" card in the options page. High-risk types (cards, SSNs, API keys, JWTs, private keys, connection strings, Aadhaar) can never be ignored.
- Added a "Delete all AI-Safe Plugin data" control in the Advanced settings. A two-click confirm fully clears all browser-local AI-Safe Plugin data — settings, custom patterns, custom entity types, Maya API key, Hugging Face token, anonymisation seed, server-URL override, per-site alias ledgers, cached redaction state, onboarding flags, and local stats — then restores defaults.
- Published the AI-Safe Plugin privacy policy at `docs/PRIVACY_POLICY.md`, linked from the extension's About section and the README.

### Changed

- Simplified the per-site popup controls so the site row uses contextual Pause/Resume and Turn on/off actions instead of a second switch, and re-scans existing fields immediately when site protection is restored.
- Corrected store and in-app copy that claimed data "never leaves your machine" to accurately describe AI-Safe Plugin as local detection by default, with optional Maya anonymisation only when the user enables it.
- Replaced the "AI-Safe Plugin / Scanning..." banner pill and the floating action bar with a single 26 px corner badge per field. The badge morphs between five states — idle monogram, spinning scanner, amber count of unredacted items, green check when all protected, and a fallback dot when the server is offline — so the field is never obscured while typing.
- Clicking the badge opens a compact panel listing each detected item with individual redact, restore, and dismiss actions, plus "Redact all" and "Restore all" footer buttons. The panel replaces the old action bar entirely.
- The token tray remains for redacted textarea/input fields but is hidden while the panel is open to avoid duplication.

---

## [1.2.8] - 2026-04-04

### Windows Installer

- Added a branded offline `AISafePluginSetup.exe` Windows installer flow that stages the backend files and release metadata, then provisions the Windows runtime locally during setup instead of shipping a non-portable CI-built virtualenv.
- Updated the Windows install UX so AI-Safe Plugin can generate a command that downloads the latest `AISafePluginSetup.exe` release asset and passes `/EXTENSION_ID=<chrome.runtime.id>`, while the installer only falls back to a manual extension-ID prompt when that argument is missing.
- Added a stable `AISafePluginSetup.exe` latest-release alias alongside the versioned installer asset so extension-generated install commands do not need to guess the current versioned filename.
- Switched the Windows installer to a lighter bootstrap flow that downloads the GLiNER2 model from the release assets during setup with installer progress, instead of baking the model into `AISafePluginSetup.exe`.
- Windows and Unix refresh installs now reuse an existing valid local GLiNER2 model cache instead of redownloading it on every update, while full uninstall still removes the cached model data.
- Fixed the Windows popup install command so PowerShell can paste and run it correctly without expanding `$installer` too early in the current shell.
- Fixed the Windows setup model extraction path so the downloaded `ai-safe-plugin-model-fp16.tar.gz` now unpacks correctly during install.
- Fixed the Windows installer script ordering so the Inno Setup compiler can resolve the model extraction helpers during release builds.
- Fixed the Windows setup runtime bootstrap so the installed `.venv` is created on the user's machine and no longer points back to the GitHub Actions runner Python path.

### Windows Runtime Reliability

- Fixed Windows native-host PID liveness checks so AI-Safe Plugin no longer uses the Unix-style `os.kill(pid, 0)` probe on Windows, which could surface low-level `OSError` failures during server start.
- Switched Windows stop behavior to `taskkill`-based process teardown and hardened server launch with safer Windows-specific process creation flags and clearer startup error reporting.

### Release Automation and Coverage

- Added a Windows installer staging builder, branded installer assets, and release-pipeline automation that compiles and publishes the Windows setup binary from GitHub Actions.
- Added regression coverage for the Windows setup packaging flow and for the Windows-specific native-host process handling changes.

---

## [1.2.7] - 2026-04-04

### Improvements

- Bundled GLiNER2 fp16 ONNX model in GitHub Release assets, eliminating the slow HuggingFace Hub download during install. Model downloads are now served from GitHub CDN.
- Fixed double model download caused by mismatched cache paths between the install script pre-download and the systemd/launchd service.
- Added cache environment variables to the Windows scheduled task and immediate server start, ensuring the model is found in the correct location.
- Moved installer scripts (`install.sh`, `install.ps1`, `uninstall.sh`, `uninstall.ps1`) from the repository root to `scripts/installers/` for a cleaner project structure.
- Added `scripts/sync_version.py` for single-source versioning: edit `package.json` once, then run `npm run version:sync` to propagate to `manifest.json` and `pyproject.toml`. CI checks for drift automatically.
- Made e2e test version assertions dynamic, reading from the extension manifest instead of hardcoded values.

---

## [1.2.6] - 2026-04-04

### Bug Fixes

- Fixed sender-tab guard blocking popup and settings page communication with the background service worker, which caused "Active (Setup Needed)", "Native host missing", and "message port closed" errors even when the server was installed and running.
- Fixed popup status subtitle flickering by removing the competing `renderStats` override on the status subtitle element — server status is now solely managed by `renderServerStatus`.

---

## [1.2.5] - 2026-04-04

### Security Hardening

- Added Content-Security-Policy (`script-src 'self'; object-src 'none'`) to the extension manifest, blocking eval, inline scripts, and object embeds in all extension pages.
- Fixed an XSS vector in `textToHtmlPreserveLayout` where code-block and inline-code content bypassed HTML escaping before innerHTML insertion in contentEditable elements.
- Added a ReDoS guard (1 000-match cap) to the custom-pattern regex loop in the background service worker, preventing catastrophic backtracking from user-defined patterns.
- Replaced inline `onerror` event handlers in popup and options HTML with CSP-safe JavaScript listeners.
- Removed raw PII entries from the server-side anonymization request log; only `entries_count` is logged now.
- Added length limits on custom-pattern fields: label ≤ 64, regex ≤ 500, replacement ≤ 200 characters.
- Added HTTPS-scheme validation on release-link URLs sourced from the GitHub API before assigning them to anchor `href` attributes.
- Added a sender-tab guard on the background message handler, rejecting messages that don't originate from a content script in a real tab.
- Replaced realistic-looking dummy API keys in test fixtures with clearly fake placeholders to avoid git secret-scanner false positives.

### Installer Improvements

- Windows install is now one-command: `powershell -ExecutionPolicy Bypass -File install.ps1 --extension-id <ID>` or `$env:AI_SAFE_PLUGIN_EXTENSION_ID='<ID>'; irm .../install.ps1 | iex`.
- Windows uninstall is now one-command: `powershell -ExecutionPolicy Bypass -File uninstall.ps1` or `irm .../uninstall.ps1 | iex`.
- Improved uninstall messaging to confirm removal of server, venv, models, and all cached data.

### Popup and Onboarding Polish

- Reworked the popup onboarding flow into a consistent Material 3 purple surface, removing the leftover amber/gold treatment and tightening the popup-sized layout.
- Fixed the first-use mask hint so it appears after onboarding is dismissed instead of being silently consumed while the onboarding overlay is still covering the popup.
- Updated release-state messaging so AI-Safe Plugin no longer shows a prominent delayed-check warning when GitHub is temporarily unavailable but the installed extension and local server bundle already match locally.

### Redaction UX

- Cleaned up the popup/settings redaction key so it shows only currently active redactions instead of long-lived response-restore aliases and partial-name mappings.
- Improved redaction key layout so long anonymized values wrap cleanly instead of blowing out the dropdown panel.
- Corrected live popup/settings stats so `detected` counts all active detections on the page while `protected` continues to reflect the redacted subset.

### Test and Fixture Hygiene

- Replaced production-looking fixture secrets in the shared regex smoke corpus with clearly synthetic placeholders while preserving detector coverage.
- Refreshed the regex smoke demo and shared fixture references for the `v1.2.5` follow-up and kept the JavaScript regression coverage aligned with the updated popup/content behavior.

## [1.2.4] - 2026-04-02

### Update UX and Backend Tracking

- Split extension and backend release state in the popup/settings UI so AI-Safe Plugin can clearly show mixed states like “extension behind, backend already updated” instead of masking backend success behind one generic update warning.
- Refreshed release-state checks whenever the popup or settings view regains focus, reducing the need to close and reopen AI-Safe Plugin after refreshing the local server bundle.
- Surfaced missing backend release metadata as a one-time refresh step instead of incorrectly implying that the installed backend is definitely outdated.
- Fixed Unix release metadata stamping so the stored backend `html_url` is extracted from the actual GitHub release payload instead of occasionally capturing an unrelated nested URL.
- Embedded canonical release metadata directly into the backend bundles so local installs can verify the installed server version even when `api.github.com` is temporarily rate-limited or unavailable.
- Updated the Unix and Windows installers to stamp `.runtime/bundle_release.json` from the bundled metadata and add `installed_at` locally instead of depending on a live GitHub API call during install.
- Changed the settings popup/update surface to treat GitHub latest-release lookups as best-effort only: AI-Safe Plugin now shows a verified local bundle state when installed metadata is known, and falls back to “backend version unknown” when both GitHub and local metadata are unavailable.

### Settings and Maintenance

- Fixed settings-page sidebar navigation so section headers land fully below the sticky control bar, improved bottom-of-page scroll-spy behavior, and made the `About` section reliably selectable.
- Moved local server uninstall into Diagnostics so setup, logs, runtime details, and repair actions live in one Local Server workflow.
- Polished the Local Server maintenance surface with clearer recovery copy and a more explicit uninstall command section for removing the native host, autostart entry, and installed backend bundle.

### Regex Detection

- Unified AI-Safe Plugin’s built-in sensitive-token patterns into one shared regex catalog used by the background runtime, popup/options editor, and content-side settings normalization, eliminating drift between UI and detection behavior.
- Updated the online regex toggle to govern all regex-based detectors while GLiNER is healthy, while keeping regex fallback automatic when the local server is offline.
- Switched new installs and unset profiles to default to `AI + Regex` so structured secrets are protected alongside GLiNER from the first run.
- Expanded the built-in regex catalog coverage for GitHub tokens, IPv6, PAN, Aadhaar, passport, IFSC, and Indian driver-license patterns, and ensured explicit regex replacements are respected even in anonymize mode for token-style detections.
- Added a dedicated built-in MAC-address detector so colon-delimited MAC values no longer get mislabeled as IPv6 placeholders during regex protection.
- Added a shared regex smoke corpus and hostile-editor E2E fixtures so built-in and custom regex detectors are verified in online, offline, and internal-scroll scenarios without depending on a live local server.

### Overlay and Onboarding Polish

- Reworked hostile-editor overlay refresh so external highlight boxes are rebuilt from tracked state, clipped to the visible editor scroll bounds, and refreshed through one anchored UI scheduler instead of lingering as stray floating boxes during Gemini-style internal scrolling.
- Stabilized hostile-editor overlay highlights by updating them in place instead of destroying and recreating them on every layout pass, reducing visible flicker in Gemini/Claude-style editors.
- Added a stable hover-intent reveal card for redacted hostile-editor overlays so original text stays readable while moving the pointer from the token to the reveal card.
- Added clearer live regex-runtime status notes to popup and settings so users can tell whether AI-Safe Plugin is currently running in `AI only`, `AI + Regex`, or `Regex fallback` mode.
- Updated the setup flow styling to keep button text readable on hover and align the onboarding surface with AI-Safe Plugin’s dashboard color language.

### Privacy Hardening

- Removed inline response de-anonymization from provider-owned chat threads so AI-Safe Plugin no longer writes original PII back into ChatGPT/Gemini/Claude-style message history.
- Tightened ChatGPT input monitoring so historical user turns are never mistaken for live composer surfaces.
- Standardized anonymize-mode fallback so supported entities fall back to safe masking instead of alias placeholders when Maya anonymization is unavailable.
- Restored original PII only in assistant responses on the user’s device while keeping user-thread prompts permanently protected in provider-owned history.
- Improved staged refinement so Maya-supported labels like emails inherit their anonymized replacements after the fast local regex pass instead of remaining stuck in temporary mask placeholders.
- Clarified popup/settings copy that Maya anonymization is the trusted remote path for supported labels, unsupported detections stay local, and Diagnostics are local-only troubleshooting data.

### Performance and Composer Protection

- Added a staged long-paste protection flow that applies fast local regex/custom masking first, then refines the same canonical source text with GLiNER and Maya anonymization in the background.
- Tightened send guards so AI-Safe Plugin blocks submission while protection is still pending, preventing large pasted prompts from slipping through before refinement completes.
- Switched popup protection counts to compute from the live redaction state so the UI reflects the actual number of protected items on the page during staged refinement.

### Windows Installer

- Changed the Windows PowerShell installer to treat autostart registration as a warning when permissions block scheduled-task creation, allowing the core backend/native-host install to finish cleanly in non-admin sessions.
- Added a safe immediate-start step after install on Windows so AI-Safe Plugin can start the local server for the current session when port `8765` is free, while still warning instead of failing if the server is already running or the port is occupied.
- Replaced the previous `cmd.exe`-only manual start guidance in the Windows autostart script with both Command Prompt and PowerShell-safe instructions.

## [1.2.3] - 2026-03-31

### Runtime and Packaging

- Included the Windows installer follow-up fix and regression test that harden the PowerShell install path and keep the release line aligned with commit `b26472e258d48cc0ca1631cbb409fa6d8d0d5a4c`.
- Tightened the local GLiNER2 server CORS behavior so it only reflects trusted browser-extension and localhost origins instead of sending a wildcard allow-origin header.

### Privacy UX and Settings

- Persisted the Maya anonymization seed in extension storage so anonymized replacements stay stable across sessions instead of changing on each browser restart.
- Switched first-use defaults and guidance toward mask mode, including one-time mask-mode hints in both the popup and content-script flow so users understand the zero-setup path before opting into anonymization.
- Polished the onboarding overlay layout for popup-sized surfaces and replaced the welcome icon with the AI-Safe Plugin brand asset for a cleaner first-run experience.
- Escaped custom pattern and custom entity labels before rendering them in the popup/settings UI, closing an HTML injection path in user-supplied display text.

## [1.2.2] - 2026-03-27

### Runtime and Packaging

- Replaced the ad-hoc `venv + pip + requirements.txt` bootstrap path with a pinned `uv` runtime contract: `uv 0.10.7`, managed Python `3.11.11`, project metadata in `pyproject.toml`, and a committed `uv.lock` for deterministic installs.
- Updated the Linux and Windows installers to provision AI-Safe Plugin’s runtime inside the install directory, preserve `.env` and `.runtime`, rebuild incompatible environments in place, and stop AI-Safe Plugin-owned processes before overwriting backend files.
- Switched backend bundle creation to ship the uv metadata files required for offline-consistent runtime sync and removed the now-obsolete `requirements.txt` dependency definition.
- Fixed the Windows PowerShell installer path that previously failed on fresh systems when `schtasks /end` was called for a missing legacy task, and migrated autostart/native-host identifiers from the old `PrivacyShield...` naming to AI-Safe Plugin-branded names with cleanup for both generations during reinstall and uninstall.

### Native Host and Local Server Control

- Extended the native messaging host with explicit `restart` support, richer runtime metadata, and settings-page diagnostics for the managed Python path, pinned uv binary, and local port ownership state.
- Tightened server lifecycle semantics so AI-Safe Plugin only stops AI-Safe Plugin-owned backend processes discovered from tracked PID state or AI-Safe Plugin-specific command lines under the current install directory.
- Added non-destructive port-conflict handling for `127.0.0.1:8765`: when another local process owns the port, AI-Safe Plugin now reports the conflict in the settings UI instead of attempting to terminate it.
- Added a dedicated Unix native-host launcher that always executes the AI-Safe Plugin-managed interpreter, aligning Chrome native-messaging startup with the same local `.venv` used by manual start, autostart, and backend tests.

### Settings Experience

- Promoted the settings page into the primary post-install control surface by adding an explicit `Restart Server` action alongside the existing start/stop/refresh controls.
- Expanded diagnostics to expose the active GLiNER2 model, runtime directory, managed interpreter version, uv version, log path, and live port state so runtime failures are debuggable without opening a terminal.
- Carried forward the last 20 upstream commits’ release and installer work into a single technical release narrative: manual tag-based publishing, backend release metadata, richer update notices, improved popup/options server management, backend server tests, and hardened reinstall/uninstall paths.

### Release Engineering and Tests

- Migrated Python CI and release jobs to `astral-sh/setup-uv` and `uv sync --frozen`, so test and release workflows now validate the same locked runtime that end users install.
- Added native-host unit coverage for port-conflict detection, ownership-safe stop behavior, and restart sequencing, plus popup/options E2E coverage for the new restart control.
- Cleaned up release documentation so contributor setup, test commands, and manual release steps all reference the uv-managed runtime rather than the removed `requirements.txt` flow.

## [1.2.0] - 2026-03-27


### Features

* Add dependabot configuration for automated dependency updates ([097a7b8](https://github.com/MAYA-DATA-PRIVACY/AI-Safe-Plugin/commit/097a7b8c1ce75c3b2d6c5899677e2406879404fe))
* Add GitHub Actions for CI, CodeQL, and Dependabot, and update README badges. ([4798939](https://github.com/MAYA-DATA-PRIVACY/AI-Safe-Plugin/commit/4798939443f05244c0611e0a6ff774e633f3380c))
* Add JWT utility functions and simplify CSS animations and transitions across various UI elements. ([df79936](https://github.com/MAYA-DATA-PRIVACY/AI-Safe-Plugin/commit/df79936617469732010d924de590367d70b70062))
* enhance UI with design tokens and improve styling for various elements ([b66bff7](https://github.com/MAYA-DATA-PRIVACY/AI-Safe-Plugin/commit/b66bff7ed164b0cfb9660bd20f549a6081eea752))
* implement reveal overlay for redacted text and enhance external highlights ([2f20499](https://github.com/MAYA-DATA-PRIVACY/AI-Safe-Plugin/commit/2f2049910301d4b19850e432fa8742cd2fc0a57a))
* Integrate MayaData anonymization service with JWT token management and API communication. ([fe63c51](https://github.com/MAYA-DATA-PRIVACY/AI-Safe-Plugin/commit/fe63c514b351b850ee96dff11f9d2bbfcdcfc202))
* Major feature additions — GLiNER2 server integration, custom PII types, cross-platform install scripts, tests ([7c75332](https://github.com/MAYA-DATA-PRIVACY/AI-Safe-Plugin/commit/7c75332db1b1cccb02d4962ddcdf34cb027d6b50))
* migrate storage from chrome.storage.sync to chrome.storage.local ([b4d16c0](https://github.com/MAYA-DATA-PRIVACY/AI-Safe-Plugin/commit/b4d16c0bc77ad70038b24b2347a0c3646e09fb67))
* Refactor content-editable rendering to use string-based HTML generation with delegated event listeners, improve detection filtering to prevent overlaps, and enhance synthetic token recognition. ([1734b89](https://github.com/MAYA-DATA-PRIVACY/AI-Safe-Plugin/commit/1734b8911551d81dc7031d53484309b85e960693))
* Rename extension to "AI-Safe Plugin" and enhance UI ([db526fa](https://github.com/MAYA-DATA-PRIVACY/AI-Safe-Plugin/commit/db526fa00ce7457213c4a1afc5ebbe2908d5c909))
* Rename project to AI-Safe Plugin, update package metadata, and add GitHub funding configuration. ([83ab788](https://github.com/MAYA-DATA-PRIVACY/AI-Safe-Plugin/commit/83ab7888b71c1af7a5c04330888cc28de1877b35))


### Bug Fixes

* **ci:** summarize release-please outputs in workflow summary ([36d26df](https://github.com/MAYA-DATA-PRIVACY/AI-Safe-Plugin/commit/36d26df90cb8e5c12f304d8fbd05d7124540ae63))
* ensure build script output path is absolute and correct manifest path in release workflow. ([fe10b68](https://github.com/MAYA-DATA-PRIVACY/AI-Safe-Plugin/commit/fe10b68385d0847c8ab3a0c915d07526a7ccf70b))
* Update CI pip install to use `--extra-index-url` for PyTorch wheels. ([7593711](https://github.com/MAYA-DATA-PRIVACY/AI-Safe-Plugin/commit/75937111bf759cf4219a91adedcc4e6751776e7e))
* Update README to enhance clarity and improve branding with new logo and descriptions ([bf8c9ed](https://github.com/MAYA-DATA-PRIVACY/AI-Safe-Plugin/commit/bf8c9edebd22457905103b881482f75dd28c92eb))

## [1.1.1] - 2026-03-27


### Bug Fixes

* **ci:** summarize release-please outputs in workflow summary ([36d26df](https://github.com/MAYA-DATA-PRIVACY/AI-Safe-Plugin/commit/36d26df90cb8e5c12f304d8fbd05d7124540ae63))

## [1.1.0](https://github.com/nishikantmandal007/AI-Safe Plugin/compare/ai-safe-plugin-v1.0.0...ai-safe-plugin-v1.1.0) (2026-03-09)


### Features

* Add dependabot configuration for automated dependency updates ([097a7b8](https://github.com/nishikantmandal007/AI-Safe Plugin/commit/097a7b8c1ce75c3b2d6c5899677e2406879404fe))
* Add GitHub Actions for CI, CodeQL, and Dependabot, and update README badges. ([4798939](https://github.com/nishikantmandal007/AI-Safe Plugin/commit/4798939443f05244c0611e0a6ff774e633f3380c))
* Add JWT utility functions and simplify CSS animations and transitions across various UI elements. ([df79936](https://github.com/nishikantmandal007/AI-Safe Plugin/commit/df79936617469732010d924de590367d70b70062))
* enhance UI with design tokens and improve styling for various elements ([b66bff7](https://github.com/nishikantmandal007/AI-Safe Plugin/commit/b66bff7ed164b0cfb9660bd20f549a6081eea752))
* implement reveal overlay for redacted text and enhance external highlights ([2f20499](https://github.com/nishikantmandal007/AI-Safe Plugin/commit/2f2049910301d4b19850e432fa8742cd2fc0a57a))
* Integrate MayaData anonymization service with JWT token management and API communication. ([fe63c51](https://github.com/nishikantmandal007/AI-Safe Plugin/commit/fe63c514b351b850ee96dff11f9d2bbfcdcfc202))
* Major feature additions — GLiNER2 server integration, custom PII types, cross-platform install scripts, tests ([7c75332](https://github.com/nishikantmandal007/AI-Safe Plugin/commit/7c75332db1b1cccb02d4962ddcdf34cb027d6b50))
* migrate storage from chrome.storage.sync to chrome.storage.local ([b4d16c0](https://github.com/nishikantmandal007/AI-Safe Plugin/commit/b4d16c0bc77ad70038b24b2347a0c3646e09fb67))
* Refactor content-editable rendering to use string-based HTML generation with delegated event listeners, improve detection filtering to prevent overlaps, and enhance synthetic token recognition. ([1734b89](https://github.com/nishikantmandal007/AI-Safe Plugin/commit/1734b8911551d81dc7031d53484309b85e960693))
* Rename extension to "AI-Safe Plugin" and enhance UI ([db526fa](https://github.com/nishikantmandal007/AI-Safe Plugin/commit/db526fa00ce7457213c4a1afc5ebbe2908d5c909))
* Rename project to AI-Safe Plugin, update package metadata, and add GitHub funding configuration. ([83ab788](https://github.com/nishikantmandal007/AI-Safe Plugin/commit/83ab7888b71c1af7a5c04330888cc28de1877b35))


### Bug Fixes

* ensure build script output path is absolute and correct manifest path in release workflow. ([fe10b68](https://github.com/nishikantmandal007/AI-Safe Plugin/commit/fe10b68385d0847c8ab3a0c915d07526a7ccf70b))
* Update CI pip install to use `--extra-index-url` for PyTorch wheels. ([7593711](https://github.com/nishikantmandal007/AI-Safe Plugin/commit/75937111bf759cf4219a91adedcc4e6751776e7e))
* Update README to enhance clarity and improve branding with new logo and descriptions ([bf8c9ed](https://github.com/nishikantmandal007/AI-Safe Plugin/commit/bf8c9edebd22457905103b881482f75dd28c92eb))

## [1.0.0] - 2025-03-08

### Added

- Real-time PII detection via local GLiNER2 NER model (zero server calls for inference).
- Regex fallback engine for offline / pattern-only detection.
- Format-preserving redaction for both `<br>`-based (ChatGPT, Claude) and `<p>`-based (Gemini) contenteditables.
- Grammarly-style wavy underline for detected PII before redaction.
- Hover-to-preview: hovering a redacted token temporarily reveals the original text.
- Per-entity colour theming via CSS custom properties.
- Scanning pill indicator with minimal pulse animation.
- Popup redesign: 3-panel carousel (HF Token · API Key · Diagnostics).
- API key authentication replacing JWT — stored in `chrome.storage.local`, never transmitted unencrypted.
- Show / Hide / Remove API key controls with eye toggle.
- Custom regex pattern support with label colours.
- Token tray: allowlist / blocklist tokens from popover.
- Keyboard shortcut: `Alt+Shift+V` to toggle redaction.
- `chrome.storage.local` used for all sensitive data (no sync leakage).
- Comprehensive `.gitignore`, `.editorconfig`, `CONTRIBUTING.md`, `SECURITY.md`, GitHub issue/PR templates.
- MIT licence.

### Fixed

- Gemini new-line bug: `<p>`-based contenteditables now correctly preserve line breaks on re-render.
- Hover delegation bug: switched from `mouseenter`/`mouseleave` (non-bubbling) to `mouseover`/`mouseout` so delegated listeners fire on child spans.
- XSS vector: `labelText` in popover now HTML-escaped before `innerHTML` injection.
- `escapeHtml` performance: replaced DOM-element approach with pure string replaces.
- DOM pollution: `element._psListenersAttached` replaced with `WeakSet`.
- Duplicate dead variable (`allRestored`) removed.
- Code-block placeholder regex: used `^` anchor to avoid matching wrong placeholder.
