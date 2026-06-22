# MAYA AISafe Plugin — Features

MAYA AISafe Plugin watches what you type into AI chat tools and gives you a
chance to mask sensitive information before it's sent. Detection runs on your
own machine by default. This document lists what the product does, grouped by
what it gives you.

---

## Detection & coverage

- **Local detection by default.** Text is scanned by GLiNER2, an NER model that
  runs on your machine at `127.0.0.1:8765`. Nothing is uploaded just to be
  checked, and detection keeps working offline once the model is installed.
- **Regex engine.** A built-in catalog of 20+ patterns runs alongside the model
  and responds instantly, so structured secrets are caught even before the model
  finishes loading.
- **Entities the model catches:** person names, email addresses, phone numbers,
  physical addresses, social security numbers, credit card numbers, dates of
  birth, locations, and organizations.
- **Secrets the regex engine catches:** API keys (OpenAI, AWS, GitHub, Stripe,
  Twilio), JWTs, IPv4/IPv6 and MAC addresses, Indian PAN/Aadhaar/IFSC numbers,
  passport numbers, database connection strings, and private keys.

## Redaction workflow

- **Inline highlights.** Anything found is underlined where you typed it, similar
  to a spell-checker.
- **One click either way.** Click to redact a match, or click to dismiss a false
  positive.
- **Masked before send.** Redacted values become tags such as `[PERSON]` or
  `[EMAIL REDACTED]` before the text leaves the page.

## Controls & customization

- **Sensitivity levels.** Choose Low (0.75, fewer/precise), Medium (0.62,
  default), or High (0.52, catches more) depending on how many false positives
  you can tolerate.
- **Per-type toggles.** Turn individual PII types on or off.
- **Custom detectors.** Add your own regex rules for internal IDs, project codes,
  or anything specific to your workflow, with custom labels and replacements.
- **Ignore-list.** Keep a list of values you never want flagged.
- **Per-site pause.** Disable the plugin on sites where you don't need it.

## Productivity

- **Keyboard shortcuts.** `Alt+Shift+R` redacts everything in the focused field.
  `Alt+Shift+V` pauses or resumes the plugin on the current site.
- **Status and counters.** The toolbar popup shows whether the local server is
  online and how many items it has caught on the current tab.

## Anonymize mode (optional)

- **Realistic replacements.** Instead of a plain `[PERSON]` tag, Anonymize mode
  swaps `John Smith` for a consistent synthetic alias like `Alex Johnson`, so the
  AI still follows your prompt.
- **Bring your own key.** It uses the Maya Data Privacy API and your own API key.
- **Local proxy.** Only the values being replaced are sent, and they go through
  the local server's `/anonymize` proxy. Maya's policy is not to store PII run
  through its anonymisation engine.
- **Off by default.** Nothing leaves your machine for anonymisation until you
  turn this on.

## Platform & setup

- **Works where you type.** ChatGPT, Claude, Gemini, Perplexity, Notion, and any
  other page with a text input or contentEditable field.
- **One-command install.** A single curl/PowerShell command sets up the local
  server, downloads the model, and registers autostart.
- **Cross-platform autostart.** Linux (systemd), macOS (launchd), and Windows
  (Task Scheduler).
- **One server, all browsers.** A single local server handles every Chromium
  browser on the machine.

## Privacy & data handling

- **Browser-local storage.** Settings, custom patterns, your Maya API key, and
  counters live in `chrome.storage.local`, not Chrome sync.
- **Cache expiry.** Cached detection results are deleted after 24 hours.
- **Clean uninstall.** Removing the local server clears its runtime, the model
  files, the autostart entry, and the native messaging host config.

## What it does not do

MAYA AISafe Plugin works on your text before you hit send. Once the text reaches
ChatGPT, Claude, or any other service, what happens to it is out of the plugin's
hands. It also can't protect you from a compromised browser, a malicious
extension, or an OS-level keylogger. It's a safeguard against sending things you
didn't mean to send, not a security boundary.
