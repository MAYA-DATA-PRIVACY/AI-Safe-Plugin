# AI-Safe Plugin Privacy Policy Draft

Internal note: this draft is based on the current repository behavior and should be reviewed before publication.

## Gaps To Fix Or Avoid Overclaiming

- Replace the old "Maya File Anonymization Extension" scope. The current product is AI-Safe Plugin, a browser extension plus local GLiNER2 server for AI/chat text inputs, not a file upload anonymization product.
- Update the manifest/store copy that says "Your data never leaves your machine" in `extension/manifest.json:6`. The accurate claim is "local by default"; Anonymize mode can send selected detected values to Maya.
- Avoid saying AI-Safe Plugin collects analytics, beta improvement data, or performance monitoring unless those systems are actually implemented and disclosed. I found local settings, local stats, release checks, local logs, and optional Maya anonymization, but no general telemetry pipeline.
- Disclose local browser storage clearly. AI-Safe Plugin stores settings, custom patterns, API keys, HF token if provided, local server URL override, onboarding state, site counters, alias ledgers, and cached redaction state in `chrome.storage.local`.
- Disclose cached source text. Cached redaction state can include source text and detected items for up to 24 hours; site alias ledgers are retained locally for up to 30 days.
- Do not imply saved secrets are encrypted by AI-Safe Plugin. Maya API keys and HF tokens are stored in browser-local extension storage.
- Tighten anonymization logs before making a metadata-only logging promise. `server/gliner2_server.py` logs anonymization response data at `response.inbound`, and upstream response formats may include original values.
- Disclose broad extension access. The extension uses `<all_urls>` and content scripts on all pages so it can protect text fields where enabled.
- Disclose third-party/network touchpoints: optional Maya anonymization API, GitHub release checks/downloads, Astral uv installer download, PyPI/dependency downloads through `uv`, and Hugging Face fallback model download. Prompt text is not needed for the installer/update checks.
- Disclose that changing the local server URL override can route detection text to the configured server.
- Avoid saying reset clears all local data; current reset restores default settings but does not clear all tokens, redaction caches, or alias memories.
- Consider tightening local server CORS/auth before claiming only the AI-Safe Plugin extension can call local detection endpoints.
- Make the Chrome Web Store privacy/limited-use statement available in the policy and keep Developer Dashboard privacy answers aligned with this policy.
- Confirm the Maya anonymization backend retention rules before publishing any absolute "no storage" language.

---

# Privacy Policy - AI-Safe Plugin AI Privacy Guard

Effective Date: May 13, 2026  
Company: Maya Data Privacy Limited  
Contact: privacy@mayadataprivacy.com  
Website: https://mayadataprivacy.in

## 1. What AI-Safe Plugin Does

AI-Safe Plugin helps users detect and redact sensitive text before they send it to AI chat interfaces and other web text fields. AI-Safe Plugin runs as a browser extension and a local desktop service. AI-Safe Plugin is enabled on all sites by default so it can protect supported text fields, and users can change monitoring settings.

By default, detection runs on the user's own machine using local regex rules and the local GLiNER2 model server. AI-Safe Plugin also offers an optional Anonymize mode. When that mode is enabled and the user provides a Maya API key, selected detected values may be sent to Maya so Maya can return realistic replacement values.

## 2. Information AI-Safe Plugin Processes

AI-Safe Plugin may process:

- Text typed or pasted into monitored browser text fields.
- Detected sensitive values, labels, confidence scores, positions, and replacement text.
- User settings, enabled detection types, custom regex patterns, custom entity descriptions, monitored sites, and redaction mode.
- Local site counters, alias ledgers, and cached redaction state used to keep the redaction UI consistent.
- Maya API key and Hugging Face token, only if the user enters them.
- Local runtime information such as server status, model selection, logs, version metadata, and update status.

AI-Safe Plugin does not require a Maya account for local detection.
AI-Safe Plugin does not run a general analytics or advertising telemetry service in the current product.

## 3. What Leaves The Device

Local detection stays on the user's machine by default. Text is sent from the active browser tab to the extension background worker and then to the local AI-Safe Plugin server at `127.0.0.1:8765`.

Data leaves the device only in these cases:

- Anonymize mode: if enabled and a Maya API key is configured, AI-Safe Plugin sends selected detected values and the metadata needed to generate replacements to Maya through the local `/anonymize` proxy.
- Local server override: if the user or administrator changes the local server URL, detection text is sent to that configured server instead of the default `127.0.0.1` server.
- Installer and updates: AI-Safe Plugin may contact GitHub to download releases, check release metadata, and download model bundles. It may contact Astral to install `uv`, and dependency registries such as PyPI to install required runtime packages. If the bundled model is unavailable, it may contact Hugging Face to download the model.
- User action: if the user submits text to a website after using AI-Safe Plugin, that website receives the text the user chooses to submit.
- Support: if the user sends logs or screenshots to Maya support, Maya receives the information the user chooses to provide.

AI-Safe Plugin does not sell user data. AI-Safe Plugin does not use processed text for advertising, credit scoring, lending, or unrelated profiling.

## 4. How AI-Safe Plugin Uses Information

AI-Safe Plugin uses processed information only to:

- Detect sensitive text.
- Highlight, mask, redact, restore, or anonymize detected values.
- Maintain local preferences and redaction state.
- Run and troubleshoot the local server.
- Provide optional Maya anonymization when the user enables it.
- Check and install AI-Safe Plugin runtime and model updates.

AI-Safe Plugin does not use the text processed by local detection to train models.

## 5. Local Storage And Retention

AI-Safe Plugin stores product data locally in the browser and local runtime directory.

- Browser storage: settings, custom patterns, custom entity types, Maya API key, HF token, anonymization seed, onboarding state, local counters, and cached redaction state are stored in `chrome.storage.local`, not Chrome sync. AI-Safe Plugin does not separately encrypt these values before storing them.
- Cached redaction state: may include source text and detected items. Entries older than 24 hours are removed by cache cleanup.
- Site alias ledger: local aliases and counters may be retained for up to 30 days so replacements stay consistent on the same site.
- Local runtime: model files, Python runtime, release metadata, server state, and logs are stored under the local AI-Safe Plugin install directory, including `.runtime`.
- Logs: local logs stay on the user's device unless the user shares them. Logs may include runtime events, errors, request IDs, endpoint status, and anonymization response or error details. Treat logs as sensitive if Anonymize mode is used.

Users can remove browser-local data by removing the extension or clearing extension storage. Users can remove the local server runtime, model files, autostart entries, and native messaging host configuration by running the AI-Safe Plugin uninstall scripts.

## 6. Optional Maya Anonymization

Anonymize mode is off by default. It requires a Maya API key.

When enabled, AI-Safe Plugin sends only supported detected values and the metadata needed for anonymization, such as label type, utility parameter, seed, and value list. Unsupported detections remain local and are masked with local redaction tags.

Maya processes Anonymize mode payloads to return replacement values. Maya does not sell these payloads, use them for advertising, or use them to train general-purpose models. Raw values are retained only as long as needed for transient processing, security, debugging, user-requested support, or legal obligations.

## 7. Third Parties

AI-Safe Plugin may interact with:

- Maya Data Privacy services, only for optional Anonymize mode and support.
- GitHub, for extension/server release checks and downloads.
- Astral, for downloading the pinned `uv` runtime installer.
- PyPI or other Python package indexes used by `uv`, for runtime dependency installation.
- Hugging Face, only as a fallback source for the local model if the bundled model is unavailable.
- The websites the user chooses to use with AI-Safe Plugin, such as AI chat services. AI-Safe Plugin does not control how those websites process text after the user submits it.

AI-Safe Plugin does not share user data with advertising networks or data brokers.

## 8. Browser Permissions

AI-Safe Plugin requests these permissions to provide its core function:

- `storage`: save local settings, keys, counters, and redaction state.
- `activeTab` and `scripting`: work with the user's active page.
- `nativeMessaging`: communicate with the local AI-Safe Plugin server manager.
- `<all_urls>` host access and content scripts: monitor supported text fields on sites where AI-Safe Plugin is enabled.
- `localhost` and `127.0.0.1`: communicate with the local server.

AI-Safe Plugin uses these permissions only to provide and improve its privacy guard function.

## 9. Security

AI-Safe Plugin is designed to keep detection local by default. The local server binds to `127.0.0.1` by default. Optional Maya requests and release downloads use HTTPS endpoints.

No electronic system is completely secure. The user's local browser profile, other installed extensions, local processes, and anything with access to the user's device are part of the local trust boundary.
Other local software or browser extensions with sufficient access to the user's machine may be able to interact with localhost services or local browser storage.

## 10. User Choices And Rights

Users can:

- Pause or disable AI-Safe Plugin.
- Choose Mask mode or Anonymize mode.
- Remove the Maya API key or HF token from settings.
- Change enabled detection types, custom patterns, and monitored sites.
- Review redactions before submitting text.
- Uninstall the browser extension and local server.
- Contact Maya to request access, correction, deletion, or other privacy help for information Maya holds.

Most AI-Safe Plugin product data is stored locally, so deleting local extension storage and uninstalling the local server are the primary ways to remove AI-Safe Plugin data from the device.

## 11. Children

AI-Safe Plugin is not intended for individuals under 18. Maya does not knowingly collect personal information from children through AI-Safe Plugin.

## 12. Chrome Web Store Limited Use

The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## 13. Changes

Maya may update this Privacy Policy as AI-Safe Plugin changes. Updated versions will include a revised effective date.

## 14. Contact

For privacy questions, support, or requests, contact:

Maya Data Privacy Limited  
Email: privacy@mayadataprivacy.com  
Website: https://mayadataprivacy.in
