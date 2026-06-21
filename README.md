<div align="center">

<br/>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/icons/ai-safe-plugin-wordmark-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/icons/ai-safe-plugin-wordmark-light.png">
  <img src="assets/icons/ai-safe-plugin-wordmark-dark.png" alt="AI-Safe Plugin" height="96">
</picture>

<br/><br/>

**Real-time PII detection and redaction for AI chat interfaces.**<br/>
Local detection by default, with optional Maya anonymisation when you enable it.

<br/>

[![CI](https://github.com/Maya-Data-Privacy/AI-Safe-Plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/Maya-Data-Privacy/AI-Safe-Plugin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](https://chrome.google.com/webstore)
[![Powered by GLiNER2](https://img.shields.io/badge/Powered%20by-GLiNER2-8B5CF6?style=flat-square)](https://github.com/fastino-ai/GLiNER2)
[![Release](https://img.shields.io/github/v/release/Maya-Data-Privacy/AI-Safe-Plugin?style=flat-square&color=22C55E)](https://github.com/Maya-Data-Privacy/AI-Safe-Plugin/releases)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-orange?style=flat-square)](docs/CONTRIBUTING.md)
[![Stars](https://img.shields.io/github/stars/Maya-Data-Privacy/AI-Safe-Plugin?style=flat-square&color=yellow)](https://github.com/Maya-Data-Privacy/AI-Safe-Plugin/stargazers)

<br/>

[Website](https://maya-data-privacy.github.io/AI-Safe-Plugin/) &middot; [Install Guide](https://maya-data-privacy.github.io/AI-Safe-Plugin/install) &middot; [Changelog](CHANGELOG.md) &middot; [Report a Bug](https://github.com/Maya-Data-Privacy/AI-Safe-Plugin/issues/new?template=bug_report.md) &middot; [Request a Feature](https://github.com/Maya-Data-Privacy/AI-Safe-Plugin/issues/new?template=feature_request.md)

</div>

<br/>

---

## The Problem

Every time you type a name, email, phone number, or credit card into ChatGPT, Claude, Gemini, or any other AI assistant, that data can leave your browser and land on somebody else's server. It may be logged. It might get used for training. You have no way to get it back.

Most people don't even think about it until it's too late.

## What AI-Safe Plugin Does

AI-Safe Plugin sits between you and the AI. It watches what you type, spots sensitive information in real time, and gives you a chance to mask it before it gets sent. Names become `[PERSON]`. Emails become `[EMAIL REDACTED]`. Credit card numbers can be replaced before they leave your browser.

Detection runs on your own machine by default using a local NLP model called [GLiNER2](https://github.com/fastino-ai/GLiNER2), plus local regex rules. AI-Safe Plugin also has an optional Maya anonymisation mode for realistic replacements; when enabled, selected anonymisation payloads are sent to Maya through AI-Safe Plugin's local proxy.

<br/>

<div align="center">

```
You type:    "Hey, my name is John Smith and my SSN is 123-45-6789"
                                    |
                              AI-Safe Plugin intercepts
                                    |
AI receives: "Hey, my name is [PERSON] and my SSN is [SSN REDACTED]"
```

</div>

<br/>

## Key Features

- **Local detection by default** - GLiNER2 ONNX model runs on localhost. Detection does not require cloud calls and works offline after initial setup.
- **Inline highlights** - Grammarly-style underlining shows exactly what AI-Safe Plugin found. One click to redact, one click to dismiss.
- **Works everywhere** - ChatGPT, Claude, Gemini, Perplexity, Notion, and any other site with text inputs or contentEditable fields.
- **Regex fallback** - Built-in patterns catch API keys, JWTs, AWS credentials, SSNs, and more. Works instantly even without the local model.
- **Custom patterns** - Add your own regex rules for internal IDs, project codes, or anything specific to your workflow.
- **Keyboard shortcuts** - Use `Alt+Shift+R` to redact all detections in the focused field and `Alt+Shift+V` to pause or resume AI-Safe Plugin on the current site.
- **Adjustable sensitivity** - Low, Medium, or High detection thresholds depending on how aggressive you want the scanning to be.
- **One-command install** - Single curl/PowerShell command sets up the local server, downloads the model, registers autostart, and you're done.
- **Cross-platform** - Linux (systemd), macOS (launchd), and Windows (Task Scheduler) autostart out of the box.

## What It Detects

**Via the GLiNER2 model:** Person names, email addresses, phone numbers, physical addresses, social security numbers, credit card numbers, dates of birth, locations, and organizations.

**Via regex patterns:** OpenAI/AWS/GitHub/Stripe/Twilio API keys, JWTs, IPv4/IPv6 addresses, MAC addresses, Indian PAN/Aadhaar/IFSC numbers, passport numbers, connection strings, private keys, and any custom pattern you define.

---

## Getting Started

### 1. Install the Extension

Download the latest `ai-safe-plugin-extension-*.zip` from [Releases](https://github.com/Maya-Data-Privacy/AI-Safe-Plugin/releases), extract it, then:

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select the extracted folder
4. If you previously loaded an older unpacked build, reload the extension once so Chrome uses AI-Safe Plugin's fixed extension ID.

### 2. Install the Local Server

The server handles PII detection using the GLiNER2 model. One command does everything: downloads the server, sets up the Python runtime, downloads the model, registers autostart, and starts the server.

**Linux / macOS:**
```bash
curl -fsSL https://github.com/Maya-Data-Privacy/AI-Safe-Plugin/releases/latest/download/install.sh | bash
```

**Windows** (PowerShell as Administrator):
```powershell
irm https://github.com/Maya-Data-Privacy/AI-Safe-Plugin/releases/latest/download/install.ps1 | iex
```

That's it. The server starts immediately and will auto-launch on every login. Advanced/custom builds can still pass an explicit extension ID with `--extension-id` or `-ExtensionId`; ordinary releases use the pinned ID `aggkonihfabdcbgomkfecjhdolddfabe`. Open any AI chatbot and start typing - AI-Safe Plugin is watching.

### 3. Verify It Works

Click the AI-Safe Plugin icon in your browser toolbar. You should see:
- A green status dot indicating the local server is online
- "Local GLiNER2 is online" in the status area

Type something like "My name is John Smith and my email is john@example.com" into any AI chat. AI-Safe Plugin should highlight the name and email within a second or two.

---

## How It Works Under the Hood

```
Browser Tab (chatgpt.com, claude.ai, etc.)
    |
    v
content.js ---- monitors input fields ----> background.js (service worker)
    |                                              |
    |   highlights + redaction UI                  v
    |<-----------------------------    GLiNER2 ONNX server (127.0.0.1:8765)
    |                                  via native_host.py (Chrome native messaging)
    v
User sees inline highlights. One-click redaction replaces PII before submission.
```

1. **content.js** watches every text input and contentEditable field on the page. When you type, it debounces and sends the text to the background service worker.
2. **background.js** forwards the text to the local GLiNER2 server over `localhost:8765` (via Chrome's native messaging bridge for reliability).
3. The **GLiNER2 server** runs the ONNX model, finds entities, and returns detection results with positions and confidence scores.
4. **content.js** renders inline highlights over the detected spans. You can dismiss false positives or accept redactions with a single click.

Local detection happens on your machine. The extension's manifest includes a strict Content Security Policy (`script-src 'self'; object-src 'none'`) and no remote code is ever loaded or executed.

### Data Flow and Retention

- **Detection text**: sent from the active tab to the extension background worker, then to the local AI-Safe Plugin server on `127.0.0.1:8765` for GLiNER2 inference. This detection path is local by default.
- **Optional anonymisation**: when Anonymize mode is enabled and a Maya API key is configured, selected detected values are sent to Maya through the local `/anonymize` proxy so Maya can return realistic replacements. Maya company policy says Maya does not store PII that runs through its anonymisation engine.
- **Browser-local storage**: settings, custom regex patterns, Maya API key, local server URL override, onboarding/preferences, site redaction counters, and cached redaction state are stored in `chrome.storage.local`, not Chrome sync.
- **Cached redaction state**: AI-Safe Plugin stores recent redaction state locally so page interactions can remain consistent. The cache includes the source text and detected items, and entries older than 24 hours are removed by the extension cache cleanup logic.
- **Uninstall**: removing the extension clears extension-owned browser storage according to browser behavior. The server uninstall scripts remove the local server runtime, model files, autostart entries, and native messaging host config.

### Security Boundaries

- AI-Safe Plugin protects text before submission; it does not control how ChatGPT, Claude, Gemini, or any destination service handles text after you send it.
- AI-Safe Plugin does not inspect provider-owned server logs, conversation databases, or model-training pipelines.
- The local server binds to `127.0.0.1` by default. Treat other local processes and browser extensions on the same machine as part of your local trust boundary.
- Custom regex patterns run locally but can still create performance problems if a pattern is pathological. Add only patterns you trust.

---

## Configuration

### Sensitivity Levels

| Level  | Threshold | When to Use |
|--------|-----------|-------------|
| Low    | 0.75      | Fewer detections, higher precision. Good if you're getting false positives. |
| Medium | 0.62      | Balanced. This is the default. |
| High   | 0.52      | Catches more, but expect some noise. Use when handling highly sensitive data. |

### Custom Regex Patterns

Head to the extension's Settings page, scroll to **Advanced**, and add patterns like:

```json
{
  "id": "internal_employee_id",
  "label": "employee_id",
  "pattern": "\\bEMP-[0-9]{6}\\b",
  "flags": "g",
  "score": 0.99,
  "replacement": "[EMPLOYEE ID]",
  "enabled": true
}
```

### Anonymisation Service (Optional)

AI-Safe Plugin can optionally connect to the [Maya Data Privacy](https://mayadataprivacy.in) anonymisation API for smarter replacements - turning `John Smith` into a consistent synthetic alias like `Alex Johnson` instead of a generic `[PERSON]` tag.

This is disabled by default and requires your own Maya API key. When Anonymize mode is enabled, AI-Safe Plugin sends the selected detected values and metadata needed for anonymisation to Maya through the local server's `/anonymize` proxy. Maya company policy says Maya does not store PII that runs through its anonymisation engine. Unsupported detections remain local and are masked with local redaction tags.

---

## Uninstalling

**Linux / macOS:**
```bash
curl -fsSL https://github.com/Maya-Data-Privacy/AI-Safe-Plugin/releases/latest/download/uninstall.sh | bash
```

**Windows:**
```powershell
irm https://github.com/Maya-Data-Privacy/AI-Safe-Plugin/releases/latest/download/uninstall.ps1 | iex
```

This removes the server, Python virtual environment, downloaded models, autostart registration, and native messaging host config. The Chrome extension itself is removed separately from `chrome://extensions`.

---

## Development

### Prerequisites

- Node.js 18+
- Python 3.11 (managed automatically by `uv`)
- Chrome or any Chromium-based browser

### Setup

```bash
git clone https://github.com/Maya-Data-Privacy/AI-Safe-Plugin.git
cd AI-Safe Plugin
npm run setup                    # provisions Python 3.11 + dependencies via uv
npm run download-gliner2         # downloads the ONNX model (~2 GB)
npm run run-gliner2              # starts the local server on port 8765
```

Load `extension/` as an unpacked extension in Chrome, and you're developing.

For optional Maya anonymisation endpoint overrides, create a local `.env` from the environment variable sample in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Do not commit `.env`.

### Running Tests

```bash
npm run test:unit              # JavaScript unit tests
npm run test:unit:python       # Python unit tests (pytest)
npm run test:e2e               # Playwright end-to-end tests (headless Chromium)
npm run test:e2e:headed        # same, but with a visible browser
```

### Version Management

Version is defined once in `package.json`. After editing it, run:

```bash
npm run version:sync           # propagates to manifest.json + pyproject.toml
npm run version:check          # CI uses this to catch drift
```

### Building a Release

```bash
npm run build:zip              # extension zip for Chrome Web Store
npm run build:backend-bundle   # server tarball for GitHub Release
npm run build:model-bundle     # ONNX model tarball for GitHub Release
```

Releases are triggered by pushing a `v*` tag. The CI pipeline verifies version consistency across all files, runs the full test suite, and uploads release assets automatically.

---

## Project Structure

```
AI-Safe Plugin/
├── extension/                  # Chrome extension (load this folder directly)
│   ├── manifest.json           # MV3 manifest with CSP
│   ├── background.js           # Service worker: detection routing, server health
│   ├── content.js              # In-page PII detection, highlights, redaction UI
│   ├── popup.html / popup.js   # Toolbar popup
│   ├── options.html / options.js  # Full settings page
│   ├── pattern_catalog.js      # Built-in + custom regex pattern engine
│   └── styles.css
│
├── server/                     # Local Python backend
│   ├── gliner2_server.py       # GLiNER2 ONNX inference server (localhost:8765)
│   ├── native_host.py          # Chrome native messaging bridge (stdio)
│   ├── native-host/            # Platform install/uninstall for the messaging host
│   └── autostart/              # Platform service registration (systemd/launchd/schtasks)
│
├── scripts/
│   ├── installers/             # User-facing install.sh, install.ps1, uninstall.*
│   ├── build_backend_bundle.py # Packages server + runtime for GitHub Release
│   ├── build_model_bundle.py   # Packages fp16 ONNX model for GitHub Release
│   ├── build_crx.sh            # Zips extension/ for Chrome Web Store
│   └── sync_version.py         # Single-source version propagation
│
├── tests/
│   ├── e2e/                    # Playwright browser tests
│   ├── js/                     # Node.js unit tests
│   └── server/                 # Python unit tests (pytest)
│
├── assets/icons/               # Logos, wordmarks, social preview
├── docs/                       # Contributing, security policy, architecture
└── .github/workflows/          # CI, CodeQL, release automation
```

---

## Security

### What AI-Safe Plugin Protects Against

Accidental disclosure of personal data to AI services. If you paste your SSN into ChatGPT without thinking, AI-Safe Plugin catches it and gives you a chance to redact it first.

### What It Does Not Protect Against

A compromised browser, a malicious extension with higher privileges, OS-level keyloggers, or network interception. AI-Safe Plugin is a privacy guardrail, not a security perimeter.

### Extension Permissions

| Permission | Why |
|---|---|
| `storage` | Saves your settings (sensitivity, custom patterns, enabled state) locally |
| `activeTab` | Shows per-tab detection stats in the popup |
| `scripting` | Fallback content script injection for dynamic iframes |
| `nativeMessaging` | Connects to the local GLiNER2 server via Chrome's native messaging bridge |
| `<all_urls>` | Monitors text inputs on any site where you might type sensitive data |

### Reporting Vulnerabilities

Please do not open public issues for security vulnerabilities. See [docs/SECURITY.md](docs/SECURITY.md) for responsible disclosure instructions.

### Privacy

AI-Safe Plugin performs detection locally by default; optional Maya anonymisation runs only when you enable it. See the full [Privacy Policy](docs/PRIVACY_POLICY.md) for what AI-Safe Plugin processes, what leaves the device, and how local data is stored and deleted.

---

## Roadmap

- [x] GLiNER2 local NER detection
- [x] Regex fallback engine with 20+ built-in patterns
- [x] Inline redaction UI for plain text and contentEditable fields
- [x] Custom regex pattern support
- [x] Cross-platform autostart (Linux, macOS, Windows)
- [x] Bundled ONNX model in GitHub Release (no HuggingFace download needed)
- [x] Single-source version management
- [ ] Chrome Web Store listing
- [ ] Firefox support
- [ ] On-device ONNX model (no Python server required)
- [ ] Audit log / export of redacted sessions
- [ ] Team policy mode (enforce redaction rules via shared config)

---

## Contributing

We welcome contributions, especially around PII detection accuracy, new browser support, performance improvements, and documentation.

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for guidelines and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the local development setup.

**Areas where we could use help:** Firefox/Safari port, Windows and macOS native host improvements, ONNX model packaging, UI polish, demo GIFs, and documentation.

---

## Acknowledgments

<table>
  <tr>
    <td align="center" width="180">
      <a href="https://github.com/fastino-ai">
        <img src="https://github.com/fastino-ai.png" width="52" style="border-radius:8px" /><br/>
        <b>Fastino Labs</b>
      </a><br/>
      <sub>GLiNER2 — the local zero-shot NER model that powers PII detection</sub>
    </td>
    <td align="center" width="180">
      <a href="https://github.com/Maya-Data-Privacy">
        <img src="https://github.com/Maya-Data-Privacy.png" width="52" style="border-radius:8px" /><br/>
        <b>Maya Data Privacy</b>
      </a><br/>
      <sub>Anonymisation API for format-preserving entity replacement</sub>
    </td>
    <td align="center" width="180">
      <a href="https://huggingface.co">
        <img src="https://huggingface.co/front/assets/huggingface_logo-noborder.svg" width="52" /><br/>
        <b>Hugging Face</b>
      </a><br/>
      <sub>Model hosting and the transformers ecosystem</sub>
    </td>
  </tr>
</table>

---

## License

[MIT](LICENSE) &copy; 2025 [Maya Data Privacy](https://mayadataprivacy.in)
