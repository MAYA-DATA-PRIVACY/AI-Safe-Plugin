# Privacy Policy - Veil AI Privacy Guard

Effective Date: May 13, 2026  
Company: Maya Data Privacy Limited  
Contact: privacy@mayadataprivacy.com  
Website: https://mayadataprivacy.in

## 1. What Veil Does

Veil helps users detect and redact sensitive text before they send it to AI chat interfaces and other web text fields. Veil runs as a browser extension and a local desktop service. Veil is enabled on all sites by default so it can protect supported text fields, and users can change monitoring settings.

By default, detection runs on the user's own machine using local regex rules and the local GLiNER2 model server. Veil also offers an optional Anonymize mode. When that mode is enabled and the user provides a Maya API key, selected detected values may be sent to Maya so Maya can return realistic replacement values.

## 2. Information Veil Processes

Veil may process:

- Text typed or pasted into monitored browser text fields.
- Detected sensitive values, labels, confidence scores, positions, and replacement text.
- User settings, enabled detection types, custom regex patterns, custom entity descriptions, monitored sites, and redaction mode.
- Local site counters, alias ledgers, and cached redaction state used to keep the redaction UI consistent.
- Maya API key and Hugging Face token, only if the user enters them.
- Local runtime information such as server status, model selection, logs, version metadata, and update status.

Veil does not require a Maya account for local detection.
Veil does not run a general analytics or advertising telemetry service in the current product.

## 3. What Leaves The Device

Local detection stays on the user's machine by default. Text is sent from the active browser tab to the extension background worker and then to the local Veil server at `127.0.0.1:8765`.

Data leaves the device only in these cases:

- Anonymize mode: if enabled and a Maya API key is configured, Veil sends selected detected values and the metadata needed to generate replacements to Maya through the local `/anonymize` proxy.
- Local server override: if the user or administrator changes the local server URL, detection text is sent to that configured server instead of the default `127.0.0.1` server.
- Installer and updates: Veil may contact GitHub to download releases, check release metadata, and download model bundles. It may contact Astral to install `uv`, and dependency registries such as PyPI to install required runtime packages. If the bundled model is unavailable, it may contact Hugging Face to download the model.
- User action: if the user submits text to a website after using Veil, that website receives the text the user chooses to submit.
- Support: if the user sends logs or screenshots to Maya support, Maya receives the information the user chooses to provide.

Veil does not sell user data. Veil does not use processed text for advertising, credit scoring, lending, or unrelated profiling.

## 4. How Veil Uses Information

Veil uses processed information only to:

- Detect sensitive text.
- Highlight, mask, redact, restore, or anonymize detected values.
- Maintain local preferences and redaction state.
- Run and troubleshoot the local server.
- Provide optional Maya anonymization when the user enables it.
- Check and install Veil runtime and model updates.

Veil does not use the text processed by local detection to train models.

## 5. Local Storage And Retention

Veil stores product data locally in the browser and local runtime directory.

- Browser storage: settings, custom patterns, custom entity types, Maya API key, HF token, anonymization seed, onboarding state, local counters, and cached redaction state are stored in `chrome.storage.local`, not Chrome sync. Veil does not separately encrypt these values before storing them.
- Cached redaction state: may include source text and detected items. Entries older than 24 hours are removed by cache cleanup.
- Site alias ledger: local aliases and counters may be retained for up to 30 days so replacements stay consistent on the same site.
- Local runtime: model files, Python runtime, release metadata, server state, and logs are stored under the local Veil install directory, including `.runtime`.
- Logs: local logs stay on the user's device unless the user shares them. Logs may include runtime events, errors, request IDs, and endpoint status. Anonymization logging is metadata-only by default — the local server records counts, status codes, and body sizes, not raw anonymization values. A debug environment variable (`VEIL_DEBUG_ANON_LOGS=1`) can restore verbose logging for troubleshooting; if you enable it, treat the resulting logs as sensitive.

Users can remove all browser-local data at once using the "Delete all Veil data" control in the extension's Advanced settings, which clears `chrome.storage.local` (settings, custom patterns, API key, HF token, anonymization seed, server-URL override, alias ledgers, cached redaction state, onboarding flags, and local stats) and restores defaults. Users can also remove browser-local data by removing the extension. Users can remove the local server runtime, model files, autostart entries, and native messaging host configuration by running the Veil uninstall scripts.

## 6. Optional Maya Anonymization

Anonymize mode is off by default. It requires a Maya API key.

When enabled, Veil sends only supported detected values and the metadata needed for anonymization, such as label type, utility parameter, seed, and value list. Unsupported detections remain local and are masked with local redaction tags.

Maya processes Anonymize mode payloads to return replacement values. Maya does not sell these payloads, use them for advertising, or use them to train general-purpose models. Raw values are retained only as long as needed for transient processing, security, debugging, user-requested support, or legal obligations.

## 7. Third Parties

Veil may interact with:

- Maya Data Privacy services, only for optional Anonymize mode and support.
- GitHub, for extension/server release checks and downloads.
- Astral, for downloading the pinned `uv` runtime installer.
- PyPI or other Python package indexes used by `uv`, for runtime dependency installation.
- Hugging Face, only as a fallback source for the local model if the bundled model is unavailable.
- The websites the user chooses to use with Veil, such as AI chat services. Veil does not control how those websites process text after the user submits it.

Veil does not share user data with advertising networks or data brokers.

## 8. Browser Permissions

Veil requests these permissions to provide its core function:

- `storage`: save local settings, keys, counters, and redaction state.
- `activeTab` and `scripting`: work with the user's active page.
- `nativeMessaging`: communicate with the local Veil server manager.
- `<all_urls>` host access and content scripts: monitor supported text fields on sites where Veil is enabled.
- `localhost` and `127.0.0.1`: communicate with the local server.

Veil uses these permissions only to provide and improve its privacy guard function.

## 9. Security

Veil is designed to keep detection local by default. The local server binds to `127.0.0.1` by default. Optional Maya requests and release downloads use HTTPS endpoints.

No electronic system is completely secure. The user's local browser profile, other installed extensions, local processes, and anything with access to the user's device are part of the local trust boundary.
Other local software or browser extensions with sufficient access to the user's machine may be able to interact with localhost services or local browser storage.

## 10. User Choices And Rights

Users can:

- Pause or disable Veil.
- Choose Mask mode or Anonymize mode.
- Remove the Maya API key or HF token from settings.
- Change enabled detection types, custom patterns, and monitored sites.
- Review redactions before submitting text.
- Delete all browser-local Veil data with one control in Advanced settings.
- Uninstall the browser extension and local server.
- Contact Maya to request access, correction, deletion, or other privacy help for information Maya holds.

Most Veil product data is stored locally, so deleting local extension storage and uninstalling the local server are the primary ways to remove Veil data from the device.

## 11. Children

Veil is not intended for individuals under 18. Maya does not knowingly collect personal information from children through Veil.

## 12. Chrome Web Store Limited Use

The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## 13. Changes

Maya may update this Privacy Policy as Veil changes. Updated versions will include a revised effective date.

## 14. Contact

For privacy questions, support, or requests, contact:

Maya Data Privacy Limited  
Email: privacy@mayadataprivacy.com  
Website: https://mayadataprivacy.in
