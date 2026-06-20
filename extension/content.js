// content.js - Grammarly-style PII detection & redaction for input fields only
// LLM response areas are NEVER scanned or modified.

const {
  cloneDefaultCustomPatterns,
  normalizeCustomPatterns,
  HIGH_RISK_LABELS,
  pruneIgnoredByTtl,
  capFifo,
  normalizeSiteHost,
  hostMatchesSite,
  isoWeekKey,
  mergeRedactionStats
} = globalThis.AI_SAFE_PLUGIN_PATTERN_CATALOG;

const STATS_STORAGE_KEY = 'aiSafePluginStats';

const IGNORED_VALUES_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const IGNORED_VALUES_MAX_PER_SITE = 200;

const DEFAULT_MONITORED_SELECTORS = [
  'textarea',
  'input[type="text"]',
  'input[type="search"]',
  'input[type="email"]',
  'input:not([type])',
  'div[contenteditable="true"]',
  '[role="textbox"]',
  '.ProseMirror'
];

// Platform-specific selectors for LLM chat interfaces
const PLATFORM_SELECTORS = {
  chatgpt: [
    'textarea[data-id]',
    'button[data-testid="send-button"] + div',
    '.flex.flex-1 textarea',
    'form button[type="submit"] + div textarea',
    'textarea.w-full',
    '[contenteditable="true"][data-placeholder]',
    '.chat-input textarea'
  ],
  claude: [
    '.claude-chat-input',
    '[data-claude-ide] textarea',
    '.ce-editor',
    'div[contenteditable="true"][data-test]',
    'textarea#composer-input',
    'textarea[data-celled]',
    '.composer-input textarea',
    '[contenteditable="true"].ce-block'
  ],
  gemini: [
    '[aria-label*="message"] textarea',
    'rich-textarea textarea',
    'text-area textarea',
    '.gemini-chat-input textarea',
    'textarea[placeholder*="message"]',
    'input[aria-label*="prompt"]',
    'rich-textarea',
    'textarea.gmat-input',
    'div[contenteditable="true"][role="textbox"]'
  ],
  generic: [
    'textarea',
    'input[type="text"]',
    'input[type="search"]',
    'input[type="email"]',
    'input:not([type])',
    'div[contenteditable="true"]',
    '[role="textbox"]',
    '.ProseMirror'
  ]
};

const TYPING_IDLE_DELAY_MS = 1200;
const PASTE_IDLE_DELAY_MS = 120;
const BLUR_DELAY_MS = 80;
const SUPPRESS_INPUT_MS = 300;
const AUTO_REDACT_DELAY_MS = 1500;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MASK_MODE_HINT_STORAGE_KEY = 'maskModeHintSeen';
const FAST_PROTECTION_MIN_CHARS = 480;

function isStaticRedactionToken(value) {
  return /^\[[A-Z0-9_ -]+ REDACTED\]$/.test(String(value || '').trim());
}

// One-line "why this matters" copy per detection label, shown in the hover
// popover (U2). Keys mirror getMaskText's label map; unknown labels fall back to
// LABEL_EXPLANATION_FALLBACK.
const LABEL_EXPLANATIONS = {
  person: 'Names can identify you or others and link activity back to a real person.',
  email: 'Email addresses can identify you and invite spam or phishing.',
  phone: 'Phone numbers can identify you and enable unwanted contact.',
  address: 'Physical addresses reveal where you live or work.',
  ssn: 'Social Security numbers enable identity theft — never share them.',
  credit_card: 'Card numbers can be used for fraud if exposed.',
  date_of_birth: 'A date of birth helps others verify or impersonate your identity.',
  location: 'Locations can reveal where you are or frequent.',
  organization: 'Organization names can reveal your employer or affiliations.',
  api_key: 'API keys grant access to your accounts and services — treat as secrets.',
  ip_address: 'IP addresses can approximate your location and identify your network.',
  jwt: 'JWTs are session credentials that can be replayed to impersonate you.',
  pan: 'A PAN is a government identifier that can enable financial fraud.',
  aadhaar: 'Aadhaar numbers are sensitive national IDs — avoid sharing them.',
  passport: 'Passport numbers are strong identity documents and enable fraud.',
  ifsc: 'IFSC codes identify bank branches used for transfers.',
  driver_license: 'Driver license numbers are identity documents that enable fraud.',
  bank_account: 'Bank account numbers can be used for fraud or unwanted transfers.',
  oauth_token: 'OAuth tokens grant access to your accounts — treat as secrets.',
  mac_address: 'MAC addresses can uniquely identify your device.',
  employee_id: 'Employee IDs can link activity to you within an organization.',
  device_id: 'Device IDs can uniquely identify and track your hardware.',
  session_id: 'Session IDs can be replayed to hijack your logged-in session.',
  private_key: 'Private keys grant full access to encrypted data and systems.',
  connection_string: 'Connection strings often embed database credentials.'
};
const LABEL_EXPLANATION_FALLBACK = 'This looks like sensitive information you may not want to share.';

// ── Selectors that identify known LLM assistant / thread areas so AI-Safe Plugin never
// scans or mutates provider-owned conversation history. ─────────────────────
const ASSISTANT_RESPONSE_SELECTORS = [
  '[data-message-author-role="assistant"]',
  '[data-is-streaming]',
  '.assistant-message',
  '.markdown-body',
  '.response-container',
  '.prose',                               // Claude response bodies
  '.result-streaming',                    // ChatGPT streaming
  '.agent-turn',                          // Gemini
  '[data-testid="conversation-turn-"]',
  '.message--assistant',
  '.bot-message',
  '.ai-message',
  '.chat-answer'
];

const USER_THREAD_MESSAGE_SELECTORS = [
  '[data-message-author-role="user"]',
  '.message--user',
  '.user-message',
  '.human-message'
];

const RESPONSE_AREA_SELECTORS = [
  ...ASSISTANT_RESPONSE_SELECTORS,
  ...USER_THREAD_MESSAGE_SELECTORS
];

class AiSafePluginContentController {
  constructor() {
    this.settings = null;
    this.isEnabled = false;
    this.overlay = null;
    this.pageStats = { detections: 0, redactions: 0 };
    // Throttle for the toolbar-icon badge push (U1).
    this._toolbarStatsLast = 0;
    this._toolbarStatsTimer = null;

    this.monitoredElements = new Map();
    this.redactions = new Map();        // element → { sourceText, sourceHtml, mode, items[] }
    this.aliasLedgers = new WeakMap();
    this.lastDetectionSignature = new Map();
    this.lastDetectedRevisions = new Map();   // element → revision at which detection last completed
    this.debounceTimers = new Map();
    this.inputRevisions = new Map();
    this.lastAnalyzedSnapshot = new Map();
    this.postInteractionTimers = new Map();
    this.suppressedInput = new WeakSet();
    this.tokenTrays = new Map();
    this.fieldBadges = new Map();
    this.fieldPanels = new Map();
    this.badgeBlurTimers = new Map();
    this.focusedElements = new Set();
    this.autoRedactTimers = new Map();
    this.dismissedDetections = new WeakMap(); // element → Set of "start:end:label"
    this.maskModeHintChecked = false;
    // True while the local model is unreachable and regex-only protection is
    // active — drives the field badge's fallback indicator dot.
    this.modelOffline = false;

    // Per-site alias ledger — ensures PERSON_1 stays PERSON_1 across sessions
    // on the same site. Loaded from chrome.storage on init, 30-day TTL.
    this.siteAliasCache = { aliases: {}, counters: {}, maskCounters: {} };
    this.siteAliasPersistTimer = null;
    // Per-site "ignore this value" allowlist (U3). label → Set<value>.
    this.siteIgnoredValues = new Map();
    this._siteIgnoredEntries = [];
    this._siteIgnoredPersistTimer = null;
    this.responseRestoreLedger = new Map();
    this.responseRestoreTimer = 0;

    // Per-site redact-all counter — used to offer "always auto-redact here?" after
    // the user has manually clicked Redact All multiple times.
    this.siteRedactCount = 0;

    this.activePopover = null;
    this.activePopoverState = null;   // { element, itemIndex, anchorRect } for the open card
    this.popoverOpenTimer = 0;
    this.popoverHideTimer = 0;
    this._popoverKeydown = null;
    this.activeRevealOverlay = null;
    this.activeRevealState = null;
    this.revealOpenTimer = 0;
    this.revealCloseTimer = 0;
    // Overlay highlights — fixed-position divs in document.body that visually
    // decorate text inside rich-editor contenteditables without touching their DOM.
    this._ceOverlayHighlights = new Map(); // element → { root, highlights: Map<key, HTMLElement> }
    this._ceOverlayTimers = new Map();     // element → setTimeout id
    this.anchoredUiRefreshRaf = 0;
    this.resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => this.scheduleAnchoredUiRefresh('resize-observer'))
      : null;

    this.domObserver = null;
    this.stateReconcileTimer = null;
    this._pollingInterval = null;
    this._settingsChangeListenerBound = false;
    this.handleViewportChange = () => this.scheduleAnchoredUiRefresh('viewport');
    this.handleRuntimeMessage = this.handleRuntimeMessage.bind(this);
    chrome.runtime.onMessage.addListener(this.handleRuntimeMessage);

    this.init();
  }

  // ═══════════════════════════════════════════════════════════
  // Platform Detection
  // ═══════════════════════════════════════════════════════════

  detectPlatform() {
    const hostname = window.location.hostname.toLowerCase();
    if (hostMatchesSite(hostname, 'chatgpt.com') || hostMatchesSite(hostname, 'chat.openai.com')) return 'chatgpt';
    if (hostMatchesSite(hostname, 'claude.ai')) return 'claude';
    if (hostMatchesSite(hostname, 'gemini.google.com') || hostMatchesSite(hostname, 'bard.google.com')) return 'gemini';
    return 'generic';
  }

  getPlatformSelectors() {
    const platform = this.detectPlatform();
    const platformSelectors = PLATFORM_SELECTORS[platform] || PLATFORM_SELECTORS.generic;
    // Combine platform-specific selectors with generic ones (deduplicated)
    const allSelectors = [...new Set([...PLATFORM_SELECTORS.generic, ...platformSelectors])];
    return allSelectors;
  }

  // ═══════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════

  async init() {
    await this.loadSettings();
    this.setupSettingsChangeListener();

    if (!this.settings.enabled) return;
    if (!this.isSiteMonitored()) return;

    // P1 — lazy boot. On known AI platforms boot immediately (unchanged behavior).
    // On generic pages, defer the heavy setup (overlay, model ping, ledgers,
    // observers, polling, reconciler) until the user focuses a monitored field —
    // so most browsing does zero work.
    if (this.detectPlatform() !== 'generic') {
      await this.activateMonitoring('init');
    } else {
      this.armLazyBoot();
    }
  }

  // Cheap arming phase (P1): one delegated focusin listener + a probe of the
  // already-focused element. Boots the full controller once, on first focus of a
  // monitored field, then detaches.
  armLazyBoot() {
    if (this._lazyBootStarted || this.isEnabled) return;
    const selector = (this.settings.monitoredSelectors || this.getPlatformSelectors()).join(',');

    const matchesMonitored = (el) => {
      try { return el instanceof Element && !!selector && el.matches(selector); }
      catch { return false; }
    };

    const fullBoot = async () => {
      if (this._lazyBootStarted) return;
      this._lazyBootStarted = true;
      document.removeEventListener('focusin', onFocusIn, true);
      await this.activateMonitoring('focusin');
      // The focusin that triggered boot fired before the per-element focus
      // listeners existed, so reflect focus now: surface the (idle) badge for the
      // currently-focused field, mirroring handleFocus().
      const active = document.activeElement;
      if (matchesMonitored(active) && this.monitoredElements.has(active)) {
        this.focusedElements.add(active);
        this.showFieldBadge(active);
        this.updateFieldBadge(active, this.redactions.get(active));
      }
    };

    const onFocusIn = (event) => {
      if (matchesMonitored(event.target)) void fullBoot();
    };

    document.addEventListener('focusin', onFocusIn, true);
    // Handle a field that is already focused at arming time.
    if (matchesMonitored(document.activeElement)) fullBoot();
  }

  async loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get([
        'enabled',
        'autoRedact',
        'redactionMode',
        'sensitivity',
        'includeRegexWhenModelOnline',
        'enabledTypes',
        'monitorAllSites',
        'monitoredSites',
        'monitoredSelectors',
        'customPatterns',
        'customEntityTypes',
        'excludedSites',
        'siteSnoozes'
      ], (result) => {
        this.settings = {
          enabled: result.enabled ?? true,
          autoRedact: result.autoRedact ?? true,
          redactionMode: result.redactionMode ?? 'mask',
          sensitivity: result.sensitivity ?? 'medium',
          includeRegexWhenModelOnline: result.includeRegexWhenModelOnline ?? true,
          enabledTypes: result.enabledTypes ?? ['person', 'email', 'phone', 'address', 'ssn', 'credit_card'],
          monitorAllSites: result.monitorAllSites ?? true,
          monitoredSites: result.monitoredSites ?? ['claude.ai', 'gemini.google.com', 'chatgpt.com'],
          monitoredSelectors: Array.isArray(result.monitoredSelectors) && result.monitoredSelectors.length > 0
            ? result.monitoredSelectors
            : this.getPlatformSelectors(),
          customPatterns: normalizeCustomPatterns(result.customPatterns, cloneDefaultCustomPatterns()),
          customEntityTypes: Array.isArray(result.customEntityTypes) ? result.customEntityTypes : [],
          excludedSites: Array.isArray(result.excludedSites) ? result.excludedSites : [],
          siteSnoozes: result.siteSnoozes && typeof result.siteSnoozes === 'object' ? result.siteSnoozes : {}
        };
        resolve();
      });
    });
  }

  isSiteMonitored() {
    const host = window.location.hostname;
    const monitored = this.settings.monitorAllSites
      || this.settings.monitoredSites.some((site) => hostMatchesSite(host, site));
    if (!monitored) return false;
    if (this.settings.excludedSites.some((site) => hostMatchesSite(host, site))) return false;

    const normalizedHost = normalizeSiteHost(host);
    const now = Date.now();
    const snoozes = this.settings.siteSnoozes || {};
    const pruned = {};
    let changed = false;
    Object.entries(snoozes).forEach(([site, until]) => {
      const normalizedSite = normalizeSiteHost(site);
      const untilMs = Number(until) || 0;
      if (!normalizedSite || untilMs <= now) {
        changed = true;
        return;
      }
      pruned[normalizedSite] = untilMs;
      if (normalizedSite !== site) changed = true;
    });
    if (changed) {
      this.settings.siteSnoozes = pruned;
      chrome.storage.local.set({ siteSnoozes: pruned });
    }
    return !(normalizedHost && pruned[normalizedHost] > now);
  }

  async activateMonitoring(_reason = 'settings') {
    if (this.isEnabled) {
      this.findInputElements();
      this.scanCurrentInputs('reactivate');
      return;
    }

    this.isEnabled = true;
    if (!this.overlay?.isConnected) {
      this.createOverlay();
    }
    await this.initializeModel();
    // Load per-site alias ledger before starting monitoring so that the first
    // element to trigger detection already has the correct counter seed.
    await this.loadSiteAliasLedger();
    await this.loadSiteIgnoredValues();
    this.startMonitoring();
    this.scanCurrentInputs('activate');

    // Rehydrate cached redactions
    this.rehydrateCachedRedactions();
    this.scheduleAssistantResponseRestore('activate');
  }

  async initializeModel() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'initialize' });
      if (response?.mode) {
        console.debug('[AI-Safe Plugin] detection mode:', response.mode);
      }
    } catch (error) {
      console.error('[AI-Safe Plugin] initialize failed:', error);
    }
  }

  createOverlay() {
    this.overlay = document.createElement('div');
    this.overlay.id = 'privacy-shield-overlay';
    this.overlay.className = 'ps-overlay';
    document.body.appendChild(this.overlay);
  }

  // ═══════════════════════════════════════════════════════════
  // Response Area Exclusion
  // ═══════════════════════════════════════════════════════════

  isResponseArea(element) {
    if (!element) return false;

    // Never treat editable user-input surfaces as response areas.
    if (this.isEditableInputSurface(element)) {
      return false;
    }

    // Check the element itself and all ancestors
    for (const selector of RESPONSE_AREA_SELECTORS) {
      try {
        if (element.matches(selector) || element.closest(selector)) {
          return true;
        }
      } catch { /* invalid selector on some pages, skip */ }
    }

    // Additional heuristic: aria-label containing response/output/answer
    const aria = (element.getAttribute('aria-label') || '').toLowerCase();
    if (/\b(response|output|answer|reply|result)\b/.test(aria)) {
      return true;
    }

    return false;
  }

  isEditableInputSurface(element) {
    if (!element || !(element instanceof HTMLElement)) return false;
    if (element.matches('textarea, input')) return true;
    if (element.isContentEditable) return true;
    if (element.getAttribute('contenteditable') === 'true') return true;
    if (element.getAttribute('role') === 'textbox') return true;
    return false;
  }

  isAssistantResponseElement(element) {
    if (!element || !(element instanceof Element)) return false;
    for (const selector of ASSISTANT_RESPONSE_SELECTORS) {
      try {
        if (element.matches(selector)) return true;
      } catch { /* ignore invalid selectors on host pages */ }
    }
    return false;
  }

  rememberResponseRestoreMappings(state) {
    if (!state?.items?.length) return;
    state.items.forEach((item) => {
      if (!item?.redacted) return;
      const replacement = this.getReplacementText(item, state.mode);
      const original = String(item.text || '').trim();
      if (!replacement || !original || replacement === original) return;
      if (isStaticRedactionToken(replacement)) return;
      this.responseRestoreLedger.set(replacement, original);
      this.buildResponseRestoreComponents(item, replacement, original).forEach(([partialReplacement, partialOriginal]) => {
        if (!partialReplacement || !partialOriginal || partialReplacement === partialOriginal) return;
        if (!this.responseRestoreLedger.has(partialReplacement)) {
          this.responseRestoreLedger.set(partialReplacement, partialOriginal);
        }
      });
    });
  }

  buildResponseRestoreComponents(item, replacement, original) {
    const label = String(item?.label || '').toLowerCase();
    if (label !== 'person') return [];

    const replacementParts = String(replacement || '').trim().split(/\s+/).filter(Boolean);
    const originalParts = String(original || '').trim().split(/\s+/).filter(Boolean);
    if (replacementParts.length < 2 || replacementParts.length !== originalParts.length || replacementParts.length > 4) {
      return [];
    }

    return replacementParts
      .map((part, index) => [part, originalParts[index]])
      .filter(([part, mapped]) => (
        part &&
        mapped &&
        part.length >= 3 &&
        mapped.length >= 3 &&
        !/\d/.test(part) &&
        !/\d/.test(mapped)
      ));
  }

  scheduleAssistantResponseRestore(_reason = 'update') {
    clearTimeout(this.responseRestoreTimer);
    this.responseRestoreTimer = setTimeout(() => {
      this.responseRestoreTimer = 0;
      this.restoreAssistantResponses();
    }, 80);
  }

  restoreAssistantResponses(root = document.body) {
    const redactionKeyMap = this.buildRedactionKey();
    if (!redactionKeyMap.size) return;

    const replacements = [...redactionKeyMap.entries()]
      .filter(([replacement, original]) => replacement && original && replacement !== original)
      .sort((left, right) => right[0].length - left[0].length);
    if (replacements.length === 0) return;

    const roots = new Set();
    if (root instanceof Element && this.isAssistantResponseElement(root)) {
      roots.add(root);
    }
    if (root?.querySelectorAll) {
      ASSISTANT_RESPONSE_SELECTORS.forEach((selector) => {
        try {
          root.querySelectorAll(selector).forEach((node) => roots.add(node));
        } catch { /* ignore invalid selectors on host pages */ }
      });
    }

    roots.forEach((node) => this.restoreAssistantResponseNode(node, replacements));
  }

  restoreAssistantResponseNode(root, replacements) {
    if (!root || this.isEditableInputSurface(root)) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest('script, style, textarea, input, [contenteditable="true"], [role="textbox"]')) {
          return NodeFilter.FILTER_REJECT;
        }
        if (!node.nodeValue || !node.nodeValue.trim()) {
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let textNode = walker.nextNode();
    while (textNode) {
      const originalValue = textNode.nodeValue || '';
      let nextValue = originalValue;
      replacements.forEach(([replacement, original]) => {
        if (!nextValue.includes(replacement)) return;
        nextValue = nextValue.split(replacement).join(original);
      });
      if (nextValue !== originalValue) {
        textNode.nodeValue = nextValue;
      }
      textNode = walker.nextNode();
    }

    // Second pass: restore tokens split across syntax-highlighted spans in code blocks
    this.restoreCodeBlockTokens(root, replacements);
  }

  restoreCodeBlockTokens(root, replacements) {
    if (!root?.querySelectorAll) return;
    const codeContainers = root.querySelectorAll('pre, code, .hljs, [class*="highlight-"]');
    if (!codeContainers.length) return;

    const processed = new Set();
    codeContainers.forEach((el) => {
      // Skip if already processed (e.g. <code> inside a <pre> we already handled)
      if (processed.has(el)) return;
      if (this.isEditableInputSurface(el)) return;
      // Mark all descendants to avoid double-processing
      el.querySelectorAll('pre, code, .hljs, [class*="highlight-"]').forEach((child) => processed.add(child));

      const text = el.textContent || '';
      let needsReplace = false;
      for (const [replacement] of replacements) {
        if (text.includes(replacement)) {
          needsReplace = true;
          break;
        }
      }
      if (!needsReplace) return;

      // Replace in innerHTML — tokens may span across <span> tags from syntax highlighting
      let html = el.innerHTML;
      replacements.forEach(([replacement, original]) => {
        if (!text.includes(replacement)) return;
        // Build a regex that matches the replacement token even if split by HTML tags
        const escaped = replacement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Allow optional HTML tags between each character of the token
        const flexPattern = escaped.split('').join('(?:<[^>]*>)*');
        try {
          const regex = new RegExp(flexPattern, 'g');
          html = html.replace(regex, original.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
        } catch { /* skip malformed regex */ }
      });
      if (html !== el.innerHTML) {
        el.innerHTML = html;
      }
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Element Monitoring
  // ═══════════════════════════════════════════════════════════

  startMonitoring() {
    this.isEnabled = true;
    this.findInputElements();
    this.startStateReconciler();
    this.startDynamicMonitoring();
    this.startPollingFallback();

    this.domObserver = new MutationObserver((mutations) => {
      // Immediately clean up state for tracked elements that were removed from DOM
      for (const mutation of mutations) {
        for (const removed of mutation.removedNodes) {
          if (!(removed instanceof HTMLElement)) continue;
          // Check if the removed node itself is tracked
          if (this.redactions.has(removed)) {
            this.clearElementState(removed);
          }
          // Check children of the removed subtree
          if (removed.querySelectorAll) {
            this.monitoredElements.forEach((_listeners, element) => {
              if (removed.contains(element)) {
                this.clearElementState(element);
              }
            });
          }
        }
      }
      // Debounce finding new elements to batch rapid mutations
      this.debouncedFindInputElements();
      this.scheduleAnchoredUiRefresh('dom-mutation');
      this.scheduleAssistantResponseRestore('dom-mutation');
    });
    this.domObserver.observe(document.body, { childList: true, subtree: true });

    window.addEventListener('scroll', this.handleViewportChange, true);
    window.addEventListener('resize', this.handleViewportChange);

    // Hide field badges when the tab goes to the background so they don't
    // linger and appear stale when switching back.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.monitoredElements.forEach((_, el) => this.hideFieldBadge(el));
      }
    });

  }

  setupSettingsChangeListener() {
    if (this._settingsChangeListenerBound) return;
    this._settingsChangeListenerBound = true;
    chrome.storage.onChanged.addListener((changes) => {
      if (
        changes.enabled ||
        changes.autoRedact ||
        changes.redactionMode ||
        changes.sensitivity ||
        changes.includeRegexWhenModelOnline ||
        changes.enabledTypes ||
        changes.monitorAllSites ||
        changes.monitoredSites ||
        changes.monitoredSelectors ||
        changes.excludedSites ||
        changes.siteSnoozes ||
        changes.customPatterns ||
        changes.customEntityTypes
      ) {
        this.loadSettings().then(async () => {
          if (!this.settings.enabled || !this.isSiteMonitored()) {
            this.stopMonitoring();
          } else {
            await this.activateMonitoring('settings-change');
          }
        });
      }
    });
  }

  // Debounced version of findInputElements to batch rapid DOM mutations
  debouncedFindInputElements() {
    if (this._findInputElementsTimer) {
      clearTimeout(this._findInputElementsTimer);
    }
    this._findInputElementsTimer = setTimeout(() => {
      this.findInputElements();
    }, 300);
  }

  scheduleAnchoredUiRefresh(_reason = 'unknown') {
    if (this.anchoredUiRefreshRaf) return;
    this.anchoredUiRefreshRaf = requestAnimationFrame(() => {
      this.anchoredUiRefreshRaf = 0;
      this.refreshAnchoredUi();
    });
  }

  refreshAnchoredUi() {
    this.repositionFieldBadges();
    this.repositionTokenTrays();
    this._refreshAllOverlays();
    this.refreshRevealOverlayPosition();
    this.refreshPopoverPosition();
    this.cleanupOrphanedUIElements();
  }

  getAnchoredUiScrollRoots(element) {
    const roots = [];
    if (!element || !(element instanceof HTMLElement)) return roots;

    const maybePush = (node) => {
      if (!node || roots.includes(node)) return;
      roots.push(node);
    };

    const isScrollable = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
      if (!/(auto|scroll|overlay)/.test(overflow)) return false;
      return (node.scrollHeight - node.clientHeight > 1) || (node.scrollWidth - node.clientWidth > 1);
    };

    if (isScrollable(element)) maybePush(element);

    let current = element.parentElement;
    while (current) {
      if (isScrollable(current)) maybePush(current);
      current = current.parentElement;
    }

    return roots;
  }

  getOverlayClipRect(element) {
    const clipRect = {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
    };

    this.getAnchoredUiScrollRoots(element).forEach((root) => {
      const rect = root.getBoundingClientRect();
      clipRect.left = Math.max(clipRect.left, rect.left);
      clipRect.top = Math.max(clipRect.top, rect.top);
      clipRect.right = Math.min(clipRect.right, rect.right);
      clipRect.bottom = Math.min(clipRect.bottom, rect.bottom);
    });

    if (clipRect.right <= clipRect.left || clipRect.bottom <= clipRect.top) {
      return null;
    }
    return clipRect;
  }

  intersectClientRect(rect, clipRect) {
    if (!rect || !clipRect) return null;
    const left = Math.max(rect.left, clipRect.left);
    const top = Math.max(rect.top, clipRect.top);
    const right = Math.min(rect.right, clipRect.right);
    const bottom = Math.min(rect.bottom, clipRect.bottom);
    if (right <= left || bottom <= top) return null;
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    };
  }

  // Enhanced MutationObserver with explicit new element detection
  startDynamicMonitoring() {
    // This is now integrated into startMonitoring's MutationObserver
    // but we keep the method for clarity and potential separate use
    console.debug('[AI-Safe Plugin] Dynamic monitoring active for:', this.detectPlatform());
  }

  // Polling fallback for SPA navigation that doesn't trigger MutationObserver
  startPollingFallback() {
    if (this._pollingInterval) {
      clearInterval(this._pollingInterval);
    }
    this._pollingInterval = setInterval(() => {
      this.findInputElements();
    }, 5000);
  }

  findInputElements() {
    if (!this.settings.enabled || !this.isSiteMonitored()) return;
    this.pruneDisconnectedMonitoredElements();

    this.settings.monitoredSelectors.forEach((selector) => {
      let elements;
      try {
        elements = document.querySelectorAll(selector);
      } catch (error) {
        console.warn('[AI-Safe Plugin] Ignoring invalid monitored selector:', selector, error?.message || error);
        return;
      }
      elements.forEach((element) => {
        if (!this.isElementEligible(element)) return;
        if (!this.monitoredElements.has(element)) {
          this.attachListeners(element);
        }
      });
    });

    // Some editors clear content programmatically after send without emitting
    // input/blur. Ensure stale highlights are removed.
    this.monitoredElements.forEach((_listeners, element) => {
      if (!this.redactions.has(element)) return;
      const text = this.getRawElementText(element);
      if (!text || text.trim().length < 1) {
        const prevState = this.redactions.get(element);
        if (!prevState?.items?.some((item) => item.redacted)) {
          this.clearElementState(element);
          // Clear stale caches to prevent cross-contamination with new composer elements
          this.dismissedDetections.delete(element);
          this.aliasLedgers.delete(element);
        }
      }
    });
  }

  scanCurrentInputs(reason = 'reactivate') {
    this.monitoredElements.forEach((_listeners, element) => {
      const text = this.getRawElementText(element);
      if (!text || text.trim().length < 1) return;
      this.bumpInputRevision(element);
      this.scheduleDetection(element, reason);
    });
  }

  startStateReconciler() {
    if (this.stateReconcileTimer) {
      clearInterval(this.stateReconcileTimer);
      this.stateReconcileTimer = null;
    }
    this.stateReconcileTimer = setInterval(() => this.reconcileElementStates(), 700);
  }

  reconcileElementStates() {
    this.redactions.forEach((_state, element) => {
      if (!element?.isConnected) {
        this.clearElementState(element);
        return;
      }
      if (this.isResponseArea(element)) {
        this.clearElementState(element);
        return;
      }
      if (!this.monitoredElements.has(element)) {
        this.clearElementState(element);
        return;
      }

      const raw = this.getRawElementText(element);
      if (!raw || raw.trim().length < 1) {
        const existingState = this.redactions.get(element);
        if (!existingState?.items?.some((item) => item.redacted)) {
          this.clearElementState(element);
        }
      }
    });

    // ── Global orphan sweep: remove UI elements whose tracked element is gone ──
    this.cleanupOrphanedUIElements();
  }

  cleanupOrphanedUIElements() {
    const trackedIds = new Set();
    this.monitoredElements.forEach((_listeners, element) => {
      if (element?.isConnected && element.dataset?.psId) {
        trackedIds.add(element.dataset.psId);
      }
    });

    // Remove orphaned highlight overlays
    document.querySelectorAll('.ps-highlight[data-element-id]').forEach((node) => {
      const id = node.getAttribute('data-element-id');
      if (!id || !trackedIds.has(id)) {
        node.remove();
      }
    });

    // Remove orphaned field badges, panels, token trays
    // (These are tracked in Maps but may leak if element is GC'd)
    this.fieldBadges.forEach((badge, element) => {
      if (!element?.isConnected) {
        badge.remove();
        this.fieldBadges.delete(element);
      }
    });
    this.fieldPanels.forEach((panel, element) => {
      if (!element?.isConnected) {
        panel.remove();
        this.fieldPanels.delete(element);
      }
    });
    this.tokenTrays.forEach((tray, element) => {
      if (!element?.isConnected) {
        tray.remove();
        this.tokenTrays.delete(element);
      }
    });
    // Remove fixed-position overlay highlights whose source element is gone.
    // These are not tracked by data-element-id so must be swept via the Map.
    this._ceOverlayHighlights.forEach((layer, element) => {
      if (!element?.isConnected) {
        layer?.root?.remove?.();
        this._ceOverlayHighlights.delete(element);
      }
    });
  }

  pruneDisconnectedMonitoredElements() {
    this.monitoredElements.forEach((listeners, element) => {
      if (element?.isConnected) return;
      this.cancelPostInteractionCleanup(element);
      element.removeEventListener('input', listeners.handleInput);
      element.removeEventListener('paste', listeners.handlePaste);
      element.removeEventListener('focus', listeners.handleFocus);
      element.removeEventListener('blur', listeners.handleBlur);
      element.removeEventListener('keydown', listeners.handleKeydown);
      element.removeEventListener('compositionstart', listeners.handleCompositionStart);
      element.removeEventListener('compositionend', listeners.handleCompositionEnd);
      if (listeners.form && listeners.handleSubmit) {
        listeners.form.removeEventListener('submit', listeners.handleSubmit);
      }
      if (listeners.handleAnchoredScroll) {
        listeners.scrollRoots?.forEach((root) => {
          root.removeEventListener('scroll', listeners.handleAnchoredScroll);
          this.resizeObserver?.unobserve(root);
        });
      }
      this.resizeObserver?.unobserve(element);
      this.clearElementState(element);
      this.monitoredElements.delete(element);
      this.inputRevisions.delete(element);
      this.lastAnalyzedSnapshot.delete(element);
    });
  }

  schedulePostInteractionCleanup(element) {
    this.cancelPostInteractionCleanup(element);

    const timers = [];
    [180, 700, 1400].forEach((delay) => {
      const timer = setTimeout(() => {
        if (!this.redactions.has(element)) return;
        const raw = this.getRawElementText(element);
        // Post-send: always clear when empty — guard only applies to mid-typing reconciliation.
        if (!raw || raw.trim().length < 1 || this.isResponseArea(element)) {
          this.clearElementState(element);
        }
      }, delay);
      timers.push(timer);
    });

    this.postInteractionTimers.set(element, timers);
  }

  cancelPostInteractionCleanup(element) {
    const timers = this.postInteractionTimers.get(element);
    if (!timers) return;
    timers.forEach((timer) => clearTimeout(timer));
    this.postInteractionTimers.delete(element);
  }

  isElementEligible(element) {
    if (!element || !(element instanceof HTMLElement)) return false;
    if (!element.isConnected) return false;

    // ── CRITICAL: never scan LLM response areas ──
    if (this.isResponseArea(element)) return false;

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    const rect = element.getBoundingClientRect();
    if (rect.width < 48 || rect.height < 18) return false;

    if (element.matches('textarea, input')) {
      if (element.disabled || element.readOnly) return false;
      if (element.getAttribute('aria-hidden') === 'true') return false;
      return true;
    }

    const isEditable = element.isContentEditable || element.getAttribute('contenteditable') === 'true';
    const roleTextbox = element.getAttribute('role') === 'textbox';
    if (!isEditable && !roleTextbox) return false;
    if (element.getAttribute('aria-readonly') === 'true') return false;
    return true;
  }

  attachListeners(element) {
    const bumpAndSchedule = (reason) => {
      if (this.suppressedInput.has(element)) return;
      this.cancelPostInteractionCleanup(element);
      this.bumpInputRevision(element);
      this.scheduleDetection(element, reason);
    };
    const handleInput = () => bumpAndSchedule('typing');
    const handlePaste = () => bumpAndSchedule('paste');
    const handleFocus = () => {
      this.focusedElements.add(element);
      // Cancel any pending blur-hide timer since field is focused again
      const blurTimer = this.badgeBlurTimers.get(element);
      if (blurTimer) {
        clearTimeout(blurTimer);
        this.badgeBlurTimers.delete(element);
      }
      this.showFieldBadge(element);
      const st = this.redactions.get(element);
      this.updateFieldBadge(element, st);
    };
    const handleBlur = () => {
      this.focusedElements.delete(element);
      this.scheduleDetection(element, 'blur');
      this.schedulePostInteractionCleanup(element);
      this.scheduleFieldBadgeBlurHide(element);
    };
    const handleCompositionStart = () => { element.dataset.psComposing = '1'; };
    const handleCompositionEnd = () => {
      element.dataset.psComposing = '';
      bumpAndSchedule('typing');
    };

    const handleKeydown = (event) => {
      // Immediately drop highlight overlays when the user deletes text so stale
      // green boxes don't linger. The debounced re-scan will restore any that
      // are still valid after the edit.
      if (event.key === 'Backspace' || event.key === 'Delete') {
        this.clearHighlights(element);
        this._clearElementOverlay(element);
      }
      if (event.key === 'Enter' && !event.shiftKey && this.hasPendingProtection(element)) {
        event.preventDefault();
        this.showNotification('AI-Safe Plugin is still protecting this message. Please wait a moment.', 'warning');
      }
      if (event.key === 'Enter' && !event.shiftKey && this.hasUnreviewedRedactions(element)) {
        event.preventDefault();
        this.showNotification('Review pending redactions before sending.', 'warning');
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.defaultPrevented) {
        // Immediately clear all visual artifacts so nothing lingers after send
        this.clearHighlights(element);
        this._clearElementOverlay(element); // removes fixed-position ps-overlay-hl divs instantly
        this.hideFieldPanel(element);
        this.removeTokenTray(element);
        this.hideFieldBadge(element);
        this.hidePopover();
        this.schedulePostInteractionCleanup(element);
      }
    };

    element.addEventListener('input', handleInput);
    element.addEventListener('paste', handlePaste);
    element.addEventListener('focus', handleFocus);
    element.addEventListener('blur', handleBlur);
    element.addEventListener('keydown', handleKeydown);
    element.addEventListener('compositionstart', handleCompositionStart);
    element.addEventListener('compositionend', handleCompositionEnd);

    const form = element.closest('form');
    let handleSubmit = null;
    if (form) {
      handleSubmit = (event) => {
        if (this.hasPendingProtection(element)) {
          event.preventDefault();
          this.showNotification('AI-Safe Plugin is still protecting this message. Please wait a moment.', 'warning');
        }
        if (this.hasUnreviewedRedactions(element)) {
          event.preventDefault();
          this.showNotification('Review pending redactions before sending.', 'warning');
        }
        // Mirror the same immediate cleanup done on Enter so overlays don't
        // linger when the user sends via a submit button rather than keyboard.
        this.clearHighlights(element);
        this._clearElementOverlay(element);
        this.hideFieldPanel(element);
        this.removeTokenTray(element);
        this.hideFieldBadge(element);
        this.hidePopover();
        this.schedulePostInteractionCleanup(element);
      };
      form.addEventListener('submit', handleSubmit);
    }

    const handleAnchoredScroll = () => this.scheduleAnchoredUiRefresh('editor-scroll');
    const scrollRoots = this.getAnchoredUiScrollRoots(element);
    scrollRoots.forEach((root) => {
      root.addEventListener('scroll', handleAnchoredScroll, { passive: true });
      this.resizeObserver?.observe(root);
    });
    this.resizeObserver?.observe(element);

    this.monitoredElements.set(element, {
      handleInput,
      handlePaste,
      handleFocus,
      handleBlur,
      handleKeydown,
      handleCompositionStart,
      handleCompositionEnd,
      form,
      handleSubmit,
      handleAnchoredScroll,
      scrollRoots
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Input Revision Tracking
  // ═══════════════════════════════════════════════════════════

  bumpInputRevision(element) {
    const current = this.inputRevisions.get(element) || 0;
    const next = current + 1;
    this.inputRevisions.set(element, next);
    return next;
  }

  getInputRevision(element) {
    return this.inputRevisions.get(element) || 0;
  }

  // ═══════════════════════════════════════════════════════════
  // Detection Scheduling
  // ═══════════════════════════════════════════════════════════

  scheduleDetection(element, reason = 'typing') {
    const isComposing = element.dataset.psComposing === '1';
    if (isComposing && reason !== 'blur') return;

    // Don't re-scan on blur when nothing new has been typed since the last
    // completed detection. Without this guard, blur reads the already-rendered
    // replacement text (e.g. "[NAME]") as if it were new input, fails the
    // sourceText equality check, and fires a redundant detection that clears state.
    if (reason === 'blur' && this.redactions.has(element)) {
      const rev = this.getInputRevision(element);
      if (this.lastDetectedRevisions.get(element) === rev) return;
    }

    if (this.debounceTimers.has(element)) {
      clearTimeout(this.debounceTimers.get(element));
    }

    const targetRevision = this.getInputRevision(element);
    const delay = reason === 'blur'
      ? BLUR_DELAY_MS
      : (reason === 'paste' || reason === 'activate' || reason === 'reactivate')
        ? PASTE_IDLE_DELAY_MS
        : TYPING_IDLE_DELAY_MS;

    if (reason === 'typing' || reason === 'paste') {
      element.classList.add('ps-awaiting-idle');
    }

    const timer = setTimeout(() => {
      const currentRevision = this.getInputRevision(element);
      if (currentRevision !== targetRevision) return;
      element.classList.remove('ps-awaiting-idle');
      this.detectAndHighlight(element, currentRevision, reason);
    }, delay);

    this.debounceTimers.set(element, timer);
  }

  // ═══════════════════════════════════════════════════════════
  // Field Status Badge
  // ═══════════════════════════════════════════════════════════

  // Inline SVG monogram derived from ai-safe-plugin-icon.svg — single-color path
  // representing the "stacked bars" visual mark at 14×14.
  _buildBadgeSvg(extraClass) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 14 14');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    if (extraClass) svg.setAttribute('class', extraClass);
    // Three horizontal bars (simplified from ai-safe-plugin-icon rect elements)
    [[1, 4, 12, 2], [1, 7, 12, 2], [1, 10, 8, 2]].forEach(([x, y, w, h]) => {
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', String(w));
      rect.setAttribute('height', String(h));
      rect.setAttribute('rx', '1');
      svg.appendChild(rect);
    });
    return svg;
  }

  _buildCheckSvg() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 14 14');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'ps-badge-check');
    const path = document.createElementNS(ns, 'polyline');
    path.setAttribute('points', '2.5,7 5.5,10 11.5,4');
    svg.appendChild(path);
    return svg;
  }

  showFieldBadge(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 28) return;

    let badge = this.fieldBadges.get(element);
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'ps-field-badge';
      badge.setAttribute('role', 'button');
      badge.tabIndex = 0;
      badge.setAttribute('aria-label', 'AI-Safe Plugin');

      const monoSvg = this._buildBadgeSvg('ps-badge-svg');
      badge.appendChild(monoSvg);

      const checkSvg = this._buildCheckSvg();
      badge.appendChild(checkSvg);

      const countEl = document.createElement('span');
      countEl.className = 'ps-badge-count';
      badge.appendChild(countEl);

      const dotEl = document.createElement('span');
      dotEl.className = 'ps-badge-dot';
      badge.appendChild(dotEl);

      document.body.appendChild(badge);
      this.fieldBadges.set(element, badge);

      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleFieldPanel(element);
      });
      // Keyboard activation — Enter/Space open the panel and move focus into it.
      badge.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          e.stopPropagation();
          this.toggleFieldPanel(element, true);
        }
      });
    }

    this.positionFieldBadge(element, badge);
    // Only make the badge visible if the element is currently focused or has pending items
    const state = this.redactions.get(element);
    const items = state?.items || [];
    const hasPending = items.some((i) => !i.redacted);
    if (this.focusedElements.has(element) || hasPending) {
      requestAnimationFrame(() => badge.classList.add('ps-badge-visible'));
    }
  }

  updateFieldBadge(element, state) {
    const badge = this.fieldBadges.get(element);
    if (!badge) return;

    const rect = element.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 28) {
      badge.style.display = 'none';
      return;
    }
    badge.style.display = '';

    // Derive badge state from element state
    const analyzing = element.classList.contains('ps-analyzing');
    const items = state?.items || [];
    const unredacted = items.filter((i) => !i.redacted);
    const allRedacted = items.length > 0 && items.every((i) => i.redacted);

    // Store classify sensitivity for the panel header
    if (state?.sensitivity) {
      badge.dataset.sensitivity = state.sensitivity;
    }

    // Remove all state classes
    badge.classList.remove(
      'ps-badge-idle', 'ps-badge-scanning', 'ps-badge-pending',
      'ps-badge-protected', 'ps-badge-fallback'
    );

    const countEl = badge.querySelector('.ps-badge-count');

    if (analyzing) {
      badge.classList.add('ps-badge-scanning');
      badge.title = 'AI-Safe Plugin — scanning';
      countEl.textContent = '';
    } else if (unredacted.length > 0) {
      badge.classList.add('ps-badge-pending');
      const displayCount = unredacted.length > 9 ? '9+' : String(unredacted.length);
      countEl.textContent = displayCount;
      badge.title = `${unredacted.length} item${unredacted.length === 1 ? '' : 's'} need attention`;
      // Ensure badge is visible when pending
      badge.classList.add('ps-badge-visible');
      // Cancel any pending blur-hide timer since there are pending items
      const blurTimer = this.badgeBlurTimers.get(element);
      if (blurTimer) {
        clearTimeout(blurTimer);
        this.badgeBlurTimers.delete(element);
      }
    } else if (allRedacted) {
      badge.classList.add('ps-badge-protected');
      countEl.textContent = '';
      badge.title = 'All items protected';
      // Protected state is always visible (user just acted, keep feedback visible)
      badge.classList.add('ps-badge-visible');
    } else if (this.modelOffline) {
      badge.classList.add('ps-badge-idle', 'ps-badge-fallback');
      countEl.textContent = '';
      badge.title = 'AI-Safe Plugin — regex-only mode';
    } else {
      badge.classList.add('ps-badge-idle');
      countEl.textContent = '';
      badge.title = 'AI-Safe Plugin';
    }

    // Offline is a modifier on top of the other states: keep the dot visible
    // while scanning/pending/protected so regex-only mode stays discoverable.
    if (this.modelOffline) badge.classList.add('ps-badge-fallback');

    // Mirror the per-state tooltip into the accessible name (U8).
    badge.setAttribute('aria-label', badge.title || 'AI-Safe Plugin');
  }

  positionFieldBadge(element, badge) {
    if (!element?.isConnected || !badge) return;

    const rect = element.getBoundingClientRect();
    const clipRect = this.getOverlayClipRect(element);

    if (rect.width < 80 || rect.height < 28) {
      badge.style.display = 'none';
      return;
    }
    badge.style.display = '';

    const badgeSize = 26;
    const inset = 8;

    // Bottom-right of field, inset 8px
    let top = rect.bottom - badgeSize - inset;
    let left = rect.right - badgeSize - inset;

    // Clamp to clip rect (for internal-scroll editors)
    if (clipRect) {
      top = Math.max(clipRect.top + inset, Math.min(clipRect.bottom - badgeSize - inset, top));
      left = Math.max(clipRect.left + inset, Math.min(clipRect.right - badgeSize - inset, left));
      // If the badge is completely outside the clip rect, hide it
      if (top + badgeSize < clipRect.top || top > clipRect.bottom ||
          left + badgeSize < clipRect.left || left > clipRect.right) {
        badge.style.display = 'none';
        return;
      }
    }

    badge.style.top = `${top}px`;
    badge.style.left = `${left}px`;
  }

  repositionFieldBadges() {
    this.fieldBadges.forEach((badge, element) => {
      if (!element?.isConnected || !badge?.isConnected) {
        badge?.remove?.();
        this.fieldBadges.delete(element);
        return;
      }
      this.positionFieldBadge(element, badge);
    });
    // Also reposition any open panel
    this.fieldPanels.forEach((panel, element) => {
      if (!element?.isConnected || !panel?.isConnected) {
        panel?.remove?.();
        this.fieldPanels.delete(element);
        return;
      }
      // Close the panel when its badge has been clipped out of view
      // (field scrolled beyond the editor's internal clip rect).
      const badge = this.fieldBadges.get(element);
      if (badge && badge.style.display === 'none') {
        this.hideFieldPanel(element);
        return;
      }
      this.positionFieldPanel(element, panel);
    });
  }

  hideFieldBadge(element) {
    const badge = this.fieldBadges.get(element);
    if (!badge) return;

    // Cancel any pending blur timer
    const blurTimer = this.badgeBlurTimers.get(element);
    if (blurTimer) {
      clearTimeout(blurTimer);
      this.badgeBlurTimers.delete(element);
    }

    badge.classList.remove('ps-badge-visible');
    const hideTimer = setTimeout(() => {
      badge.remove();
      this.fieldBadges.delete(element);
    }, 200);
    badge._hideTimer = hideTimer;
  }

  scheduleFieldBadgeBlurHide(element) {
    // Only hide on blur if state is idle (no pending items)
    const state = this.redactions.get(element);
    const items = state?.items || [];
    const hasPending = items.some((i) => !i.redacted);

    if (hasPending) return; // Pending state stays visible after blur

    const timer = setTimeout(() => {
      this.badgeBlurTimers.delete(element);
      const badge = this.fieldBadges.get(element);
      if (!badge) return;
      badge.classList.remove('ps-badge-visible');
    }, 2000);
    this.badgeBlurTimers.set(element, timer);
  }

  // ═══════════════════════════════════════════════════════════
  // Field Panel
  // ═══════════════════════════════════════════════════════════

  toggleFieldPanel(element, viaKeyboard = false) {
    const existing = this.fieldPanels.get(element);
    if (existing) {
      this.hideFieldPanel(element);
    } else {
      this.showFieldPanel(element, viaKeyboard);
    }
  }

  showFieldPanel(element, viaKeyboard = false) {
    this.hideFieldPanel(element);
    const state = this.redactions.get(element);
    if (!state || !state.items || state.items.length === 0) return;

    const panel = document.createElement('div');
    panel.className = 'ps-field-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'AI-Safe Plugin detections');

    // ── Header ──
    const header = document.createElement('div');
    header.className = 'ps-panel-header';

    const title = document.createElement('span');
    title.className = 'ps-panel-title';
    title.textContent = `AI-Safe Plugin · ${state.items.length} item${state.items.length === 1 ? '' : 's'}`;
    header.appendChild(title);

    // Risk chip (sourced from stored sensitivity)
    const badge = this.fieldBadges.get(element);
    const sensitivity = badge?.dataset?.sensitivity || state.sensitivity;
    if (sensitivity === 'high' || sensitivity === 'medium') {
      const chip = document.createElement('span');
      chip.className = 'ps-panel-risk-chip';
      if (sensitivity === 'high') {
        chip.classList.add('ps-panel-risk-high');
        chip.textContent = 'High risk';
      } else {
        chip.classList.add('ps-panel-risk-moderate');
        chip.textContent = 'Moderate risk';
      }
      header.appendChild(chip);
    }

    panel.appendChild(header);

    // ── Item rows ──
    const itemList = document.createElement('div');
    itemList.className = 'ps-panel-items';

    state.items.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'ps-panel-row';
      row.style.setProperty('--row-color', this.getTypeColor(item.label));

      const dot = document.createElement('span');
      dot.className = 'ps-panel-dot';
      row.appendChild(dot);

      const labelEl = document.createElement('span');
      labelEl.className = 'ps-panel-row-label';
      labelEl.textContent = this.formatLabel(item.label);
      row.appendChild(labelEl);

      const valueEl = document.createElement('span');
      valueEl.className = 'ps-panel-row-value';
      valueEl.textContent = this._middleTruncate(String(item.text || ''), 28);
      row.appendChild(valueEl);

      const actions = document.createElement('span');
      actions.className = 'ps-panel-row-actions';

      // Dismiss button
      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'ps-panel-row-btn';
      dismissBtn.title = 'Dismiss';
      dismissBtn.setAttribute('aria-label', `Dismiss ${this.formatLabel(item.label)}`);
      const dismissSvg = this._buildDismissSvg();
      dismissBtn.appendChild(dismissSvg);
      dismissBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.dismissDetection(element, index);
        this.hideFieldPanel(element);
        const newState = this.redactions.get(element);
        if (newState && newState.items.length > 0) {
          this.showFieldPanel(element);
        }
      });
      actions.appendChild(dismissBtn);

      // Redact / restore toggle button
      const redactBtn = document.createElement('button');
      redactBtn.type = 'button';
      redactBtn.className = 'ps-panel-row-btn';
      if (item.redacted) {
        redactBtn.title = 'Restore';
        redactBtn.setAttribute('aria-label', `Restore ${this.formatLabel(item.label)}`);
        const restoreSvg = this._buildRestoreSvg();
        redactBtn.appendChild(restoreSvg);
        redactBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleRedaction(element, index);
          this.hideFieldPanel(element);
          this.showFieldPanel(element);
        });
      } else {
        redactBtn.title = 'Redact';
        redactBtn.setAttribute('aria-label', `Redact ${this.formatLabel(item.label)}`);
        const redactSvg = this._buildRedactSvg();
        redactBtn.appendChild(redactSvg);
        redactBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.redactSingle(element, index);
          this.hideFieldPanel(element);
          this.showFieldPanel(element);
        });
      }
      actions.appendChild(redactBtn);

      // Ignore on this site — omitted for high-risk labels (U3).
      if (!item.redacted && this.canIgnoreLabel(item.label)) {
        const ignoreBtn = document.createElement('button');
        ignoreBtn.type = 'button';
        ignoreBtn.className = 'ps-panel-row-btn';
        ignoreBtn.title = 'Ignore on this site';
        ignoreBtn.setAttribute('aria-label', `Ignore ${this.formatLabel(item.label)} on this site`);
        ignoreBtn.appendChild(this._buildIgnoreSvg());
        ignoreBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.ignoreDetectionValue(element, index);
          this.hideFieldPanel(element);
          const newState = this.redactions.get(element);
          if (newState && newState.items.length > 0) this.showFieldPanel(element);
        });
        actions.appendChild(ignoreBtn);
      }

      row.appendChild(actions);
      itemList.appendChild(row);
    });

    panel.appendChild(itemList);

    // ── Divider ──
    const divider = document.createElement('hr');
    divider.className = 'ps-panel-divider';
    panel.appendChild(divider);

    // ── Footer ──
    const footer = document.createElement('div');
    footer.className = 'ps-panel-footer';

    const unredacted = state.items.filter((i) => !i.redacted);
    const redacted = state.items.filter((i) => i.redacted);

    if (unredacted.length > 0) {
      const redactAllBtn = document.createElement('button');
      redactAllBtn.type = 'button';
      redactAllBtn.className = 'ps-panel-btn ps-panel-btn-redact';
      redactAllBtn.textContent = 'Redact all';
      redactAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.cancelAutoRedact(element);
        this.redactAll(element);
        this.hideFieldPanel(element);
        const newState = this.redactions.get(element);
        if (newState && newState.items.length > 0) {
          this.showFieldPanel(element);
        }
      });
      footer.appendChild(redactAllBtn);
    }

    if (redacted.length > 0) {
      const restoreAllBtn = document.createElement('button');
      restoreAllBtn.type = 'button';
      restoreAllBtn.className = 'ps-panel-btn ps-panel-btn-restore';
      restoreAllBtn.textContent = 'Restore all';
      restoreAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.restoreAll(element);
        this.hideFieldPanel(element);
        const newState = this.redactions.get(element);
        if (newState && newState.items.length > 0) {
          this.showFieldPanel(element);
        }
      });
      footer.appendChild(restoreAllBtn);
    }

    panel.appendChild(footer);

    document.body.appendChild(panel);
    this.fieldPanels.set(element, panel);

    this.positionFieldPanel(element, panel);
    requestAnimationFrame(() => panel.classList.add('ps-panel-visible'));

    // Close on outside click
    const outsideClickHandler = (e) => {
      const badge = this.fieldBadges.get(element);
      if (!panel.contains(e.target) && e.target !== badge && !badge?.contains(e.target)) {
        this.hideFieldPanel(element);
        document.removeEventListener('mousedown', outsideClickHandler, true);
      }
    };
    document.addEventListener('mousedown', outsideClickHandler, true);
    panel._outsideClickHandler = outsideClickHandler;

    // Close on Escape
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        this.hideFieldPanel(element);
        document.removeEventListener('keydown', escHandler, true);
      }
    };
    document.addEventListener('keydown', escHandler, true);
    panel._escHandler = escHandler;

    // ── Focus management (U8) ──
    // Trap Tab within the panel while it's open.
    panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const focusables = panel.querySelectorAll('button');
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
    // Only pull focus into the panel when it was opened from the keyboard — a
    // mouse click must not yank focus out of the text field the user is typing in.
    if (viaKeyboard) {
      panel._returnFocus = this.fieldBadges.get(element) || null;
      requestAnimationFrame(() => panel.querySelector('button')?.focus());
    }

    // Hide token tray while panel is open
    const tray = this.tokenTrays.get(element);
    if (tray) tray.style.display = 'none';
  }

  positionFieldPanel(element, panel) {
    if (!element?.isConnected || !panel?.isConnected) return;
    const rect = element.getBoundingClientRect();
    const panelH = panel.offsetHeight || 180;
    const panelW = panel.offsetWidth || 240;
    const spaceBelow = window.innerHeight - rect.bottom;

    let top;
    if (spaceBelow >= panelH + 8) {
      top = rect.bottom + 6;
    } else {
      // Flip above
      top = rect.top - panelH - 6;
    }

    let left = rect.left;
    const maxLeft = window.innerWidth - panelW - 8;
    if (left > maxLeft) left = Math.max(8, maxLeft);

    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
  }

  hideFieldPanel(element) {
    const panel = this.fieldPanels.get(element);
    if (!panel) return;

    if (panel._outsideClickHandler) {
      document.removeEventListener('mousedown', panel._outsideClickHandler, true);
      panel._outsideClickHandler = null;
    }
    if (panel._escHandler) {
      document.removeEventListener('keydown', panel._escHandler, true);
      panel._escHandler = null;
    }

    panel.classList.remove('ps-panel-visible');
    setTimeout(() => {
      if (panel.isConnected) panel.remove();
    }, 200);
    this.fieldPanels.delete(element);

    // Return focus to the badge when the panel was opened from the keyboard (U8).
    const returnTarget = panel._returnFocus;
    panel._returnFocus = null;
    if (returnTarget && typeof returnTarget.focus === 'function') returnTarget.focus();

    // Restore token tray visibility
    const tray = this.tokenTrays.get(element);
    if (tray) tray.style.display = '';
  }

  // Inline SVG helpers for panel row buttons
  _buildDismissSvg() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const l1 = document.createElementNS(ns, 'line');
    l1.setAttribute('x1', '2'); l1.setAttribute('y1', '2');
    l1.setAttribute('x2', '10'); l1.setAttribute('y2', '10');
    const l2 = document.createElementNS(ns, 'line');
    l2.setAttribute('x1', '10'); l2.setAttribute('y1', '2');
    l2.setAttribute('x2', '2'); l2.setAttribute('y2', '10');
    svg.appendChild(l1);
    svg.appendChild(l2);
    return svg;
  }

  _buildRedactSvg() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    // Shield icon
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M6 1 L10.5 3 L10.5 6.5 Q10.5 9.5 6 11 Q1.5 9.5 1.5 6.5 L1.5 3 Z');
    svg.appendChild(path);
    return svg;
  }

  _buildIgnoreSvg() {
    // Crossed-eye "ignore/hide" glyph.
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.3');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const eye = document.createElementNS(ns, 'path');
    eye.setAttribute('d', 'M1.5 6 C3 3.5 9 3.5 10.5 6 C9 8.5 3 8.5 1.5 6 Z');
    svg.appendChild(eye);
    const slash = document.createElementNS(ns, 'line');
    slash.setAttribute('x1', '2'); slash.setAttribute('y1', '10');
    slash.setAttribute('x2', '10'); slash.setAttribute('y2', '2');
    svg.appendChild(slash);
    return svg;
  }

  _buildRestoreSvg() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    // Undo arrow
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M2 5.5 A4 4 0 1 1 3.5 9');
    svg.appendChild(path);
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', '2,3 2,6 5,6');
    svg.appendChild(line);
    return svg;
  }

  _middleTruncate(text, maxLen) {
    if (!text || text.length <= maxLen) return text;
    const half = Math.floor(maxLen / 2) - 1;
    return `${text.slice(0, half)}…${text.slice(text.length - half)}`;
  }

  // ═══════════════════════════════════════════════════════════
  // Detection & Highlight (core pipeline)
  // ═══════════════════════════════════════════════════════════

  shouldUseFastProtection(reason, sourceText) {
    return reason === 'paste' && String(sourceText || '').trim().length >= FAST_PROTECTION_MIN_CHARS;
  }

  hasPendingProtection(element) {
    if (!element) return false;
    if (element.classList?.contains('ps-awaiting-idle')) return true;
    if (element.classList?.contains('ps-analyzing')) return true;
    const state = this.redactions.get(element);
    if (!state) return false;
    if (state.pendingRefinement) return true;
    return state.items.some((item) => !item.redacted && !item.userRestored);
  }

  protectItemsImmediately(items) {
    if (!Array.isArray(items)) return items;
    items.forEach((item) => {
      item.redacted = true;
      item.reviewed = true;
    });
    return items;
  }

  async applyFastLocalProtection(element, sourceText, currentRevision) {
    const response = await chrome.runtime.sendMessage({
      action: 'detectPIIFast',
      text: sourceText,
      options: {
        threshold: this.getSensitivityThreshold(),
        enabledTypes: this.settings.enabledTypes,
        customPatterns: this.settings.customPatterns
      }
    });

    if (!response?.success || !Array.isArray(response.detections) || response.detections.length === 0) {
      return false;
    }

    if (currentRevision !== this.getInputRevision(element)) {
      return false;
    }

    const detections = response.detections
      .filter((item) => !this.isSyntheticReplacementToken(item.text))
      .filter((item) => !this.isValueIgnored(item.label, item.text)); // per-site ignore (U3)
    if (detections.length === 0) return false;

    const ledger = this.getAliasLedger(element);
    const items = detections.map((detection) => this.createRedactionItem(detection, ledger, null));
    this.protectItemsImmediately(items);

    const state = {
      sourceText,
      sourceHtml: this.isContentEditableElement(element)
        ? this.captureContentEditableHtml(element)
        : null,
      mode: this.settings.redactionMode,
      pendingRefinement: true,
      items
    };

    this.redactions.set(element, state);
    this.renderElement(element);
    return true;
  }

  async detectAndHighlight(element, expectedRevision = null, reason = 'typing') {
    const currentRevision = this.getInputRevision(element);
    if (expectedRevision !== null && expectedRevision !== currentRevision) return;

    const sourceText = this.getElementText(element);
    const snapshotKey = `${currentRevision}:${this.hashString(sourceText)}`;
    if (this.lastAnalyzedSnapshot.get(element) === snapshotKey) return;
    const currentState = this.redactions.get(element);

    // Prevent re-detect loops when the semantic source text has not changed.
    // Trim both sides to tolerate trailing newlines added by block-element editors (e.g. Gemini).
    if (currentState?.sourceText !== undefined &&
        currentState.sourceText.trim() === sourceText.trim()) {
      this.lastAnalyzedSnapshot.set(element, snapshotKey);
      return;
    }

    if (!sourceText || sourceText.trim().length < 3) {
      const prevState = this.redactions.get(element);
      if (!prevState?.items?.some((item) => item.redacted)) {
        this.clearElementState(element);
      }
      this.lastAnalyzedSnapshot.set(element, snapshotKey);
      return;
    }

    // If the text is composed entirely of redaction tokens (state was lost and
    // restoration failed), skip detection — there is nothing real to detect.
    const strippedOfTokens = sourceText.replace(/\[[A-Z][A-Z\s]*REDACTED\]/gi, '').trim();
    if (!strippedOfTokens || strippedOfTokens.length < 3) {
      this.lastAnalyzedSnapshot.set(element, snapshotKey);
      return;
    }

    this.setAnalyzingState(element, true);
    this.showFieldBadge(element);
    this.updateFieldBadge(element, this.redactions.get(element));
    const useFastProtection = this.shouldUseFastProtection(reason, sourceText);
    let fastProtectionApplied = false;

    if (sourceText.length >= 20 && sourceText.length < FAST_PROTECTION_MIN_CHARS) {
      chrome.runtime.sendMessage({ action: 'classifyPII', text: sourceText }, (res) => {
        if (chrome.runtime.lastError) return;
        if (res?.success && res.result) {
          // Store sensitivity on the badge for the panel header
          const badge = this.fieldBadges.get(element);
          if (badge && res.result.sensitivity) {
            badge.dataset.sensitivity = res.result.sensitivity;
          }
          // Also store on state if it exists
          const st = this.redactions.get(element);
          if (st && res.result.sensitivity) {
            st.sensitivity = res.result.sensitivity;
          }
        }
      });
    }

    try {
      if (useFastProtection) {
        fastProtectionApplied = await this.applyFastLocalProtection(element, sourceText, currentRevision);
      }

      const response = await chrome.runtime.sendMessage({
        action: 'detectPII',
        text: sourceText,
        options: {
          redactionMode: this.settings.redactionMode,
          threshold: this.getSensitivityThreshold(),
          enabledTypes: this.settings.enabledTypes,
          customPatterns: this.settings.customPatterns,
          customEntityTypes: this.settings.customEntityTypes || [],
          includeRegexWhenModelOnline: this.settings.includeRegexWhenModelOnline
        }
      });

      if (!response?.success || !Array.isArray(response.detections) || response.detections.length === 0) {
        const staged = this.redactions.get(element);
        if (staged?.pendingRefinement) {
          staged.pendingRefinement = false;
          this.redactions.set(element, staged);
          this.renderElement(element);
          this.lastAnalyzedSnapshot.set(element, snapshotKey);
          return;
        }
        const prevState = this.redactions.get(element);
        if (!prevState?.items?.some((item) => item.redacted)) {
          this.clearElementState(element);
        }
        this.lastAnalyzedSnapshot.set(element, snapshotKey);
        return;
      }

      if (expectedRevision !== null && expectedRevision !== this.getInputRevision(element)) return;

      let detections = response.detections;

      // ── Dedup: filter out dismissed, ignored, and already-handled detections ──
      const dismissed = this.dismissedDetections.get(element) || new Set();
      detections = detections.filter((d) => {
        const key = `${d.start}:${d.end}:${d.label}`;
        if (dismissed.has(key)) return false;
        if (this.isValueIgnored(d.label, d.text)) return false; // persistent per-site ignore (U3)
        return true;
      });
      detections = detections.filter((d) => !this.isSyntheticReplacementToken(d.text));

      // ── Prevent re-anonymisation of already-treated text ──
      // If there is existing state, filter out detections whose text matches
      // any known replacement token or alias from the current redactions.
      if (currentState && currentState.items.length > 0) {
        const knownReplacements = new Set();
        currentState.items.forEach((item) => {
          if (item.alias) knownReplacements.add(`<${item.alias}>`);
          if (item.anonymizedText) knownReplacements.add(item.anonymizedText);
          if (item.replacement) knownReplacements.add(item.replacement);
          // Also add the mask text variants (both generic and numbered)
          knownReplacements.add(this.getMaskText(item.label));
          if (item.maskIndex != null) knownReplacements.add(this.getMaskText(item.label, item.maskIndex));
        });
        detections = detections.filter((d) => {
          const text = String(d.text || '').trim();
          // Reject exact matches
          if (knownReplacements.has(text)) return false;
          // Reject text that *contains* a known replacement token
          for (const rep of knownReplacements) {
            if (rep && text.includes(rep)) return false;
          }
          return true;
        });

        // ── Overlap guard: reject detections whose character range ──
        // overlaps with ANY already-tracked item (redacted or not).
        // During staged fast protection we intentionally keep overlapping
        // refined detections so provisional regex masks can be upgraded with
        // anonymized replacements from the AI/anonymization pipeline.
        if (!currentState.pendingRefinement) {
          detections = detections.filter((d) => {
            return !currentState.items.some((ex) =>
              d.start < ex.end && d.end > ex.start
            );
          });
        }
      }

      const existingState = this.redactions.get(element) || currentState;
      const existingItems = existingState ? existingState.items : [];
      let updatedExistingItems = this.reconcileExistingItems(sourceText, existingItems);
      updatedExistingItems = this.mergeExistingItemsWithDetections(updatedExistingItems, detections);
      let newDetections = detections;
      if (updatedExistingItems.length > 0) {
        newDetections = this.mergeWithExistingDetections(updatedExistingItems, detections);
      }

      const ledger = this.getAliasLedger(element);
      const newItems = newDetections
        .map((detection) => this.createRedactionItem(detection, ledger, null));
      if (useFastProtection || existingState?.pendingRefinement || fastProtectionApplied) {
        this.protectItemsImmediately(newItems);
      }

      const allItems = [...updatedExistingItems, ...newItems]
        .slice()
        .sort((a, b) => a.start - b.start);

      if (allItems.length === 0) {
        this.setAnalyzingState(element, false);
        this.updateFieldBadge(element, this.redactions.get(element));
        return;
      }

      const allDetectionsForSignature = allItems.map((i) => ({
        label: i.label, start: i.start, end: i.end
      }));
      const signature = this.buildSignature(sourceText, allDetectionsForSignature);
      if (this.lastDetectionSignature.get(element) === signature) {
        this.setAnalyzingState(element, false);
        this.updateFieldBadge(element, this.redactions.get(element));
        return;
      }

      this.lastDetectionSignature.set(element, signature);

      const state = {
        sourceText,
        sourceHtml: this.isContentEditableElement(element)
          ? this.captureContentEditableHtml(element)
          : null,
        mode: this.settings.redactionMode,
        pendingRefinement: false,
        items: allItems
      };

      this.redactions.set(element, state);
      this.lastDetectedRevisions.set(element, currentRevision);

      // Render: existing redacted items stay redacted, new items get underlines
      this.renderElement(element);

      // Auto-redact after delay if setting is on
      if (this.settings.autoRedact) {
        this.scheduleAutoRedact(element);
      }

      this.updateStats(newItems.filter((i) => !i.redacted).length, 0);
      this.lastAnalyzedSnapshot.set(element, snapshotKey);
    } catch (error) {
      console.error('[AI-Safe Plugin] detection error:', error);
      const staged = this.redactions.get(element);
      if (staged?.pendingRefinement) {
        staged.pendingRefinement = false;
        this.redactions.set(element, staged);
        this.renderElement(element);
      }
      this.lastAnalyzedSnapshot.set(element, snapshotKey);
      // Surface model-offline state as a non-blocking notification so users know
      // regex fallback is active rather than silently getting degraded detection.
      if (/failed to fetch|networkerror|connection refused|econnrefused/i.test(String(error?.message || ''))) {
        this.modelOffline = true;
        this.showNotification('Model offline — regex fallback active', 'warning');
      }
    } finally {
      this.setAnalyzingState(element, false);
      const finalState = this.redactions.get(element);
      this.updateFieldBadge(element, finalState);
    }
  }

  mergeWithExistingDetections(existingItems, newDetections) {
    // Filter out fresh detections that correspond to items we already carried
    // forward into the current source text. Matching by text+label alone is too
    // coarse because repeated names/emails are valid independent detections.
    const existing = Array.isArray(existingItems) ? existingItems : [];
    return newDetections.filter((nd) => {
      const textLower = String(nd.text || '').toLowerCase();
      const labelLower = String(nd.label || '').toLowerCase();
      return !existing.some((ex) => {
        const exTextLower = String(ex.text || '').toLowerCase();
        const exLabelLower = String(ex.label || '').toLowerCase();
        return (
          exTextLower === textLower &&
          exLabelLower === labelLower &&
          nd.start < ex.end &&
          nd.end > ex.start
        );
      });
    });
  }

  mergeExistingItemsWithDetections(existingItems, newDetections) {
    const existing = Array.isArray(existingItems) ? existingItems : [];
    const incoming = Array.isArray(newDetections) ? newDetections : [];
    if (existing.length === 0 || incoming.length === 0) return existing;

    return existing.map((item) => {
      const itemTextLower = String(item?.text || '').toLowerCase();
      const itemLabelLower = String(item?.label || '').toLowerCase();
      const match = incoming.find((detection) => {
        const detectionTextLower = String(detection?.text || '').toLowerCase();
        const detectionLabelLower = String(detection?.label || '').toLowerCase();
        return (
          detectionTextLower === itemTextLower &&
          detectionLabelLower === itemLabelLower &&
          detection.start < item.end &&
          detection.end > item.start
        );
      });

      if (!match) return item;

      return {
        ...item,
        score: typeof match.score === 'number' ? match.score : item.score,
        source: match.source || item.source,
        tier: match.tier || item.tier,
        replacement: match.replacement ? String(match.replacement) : item.replacement,
        anonymizedText: match.anonymizedText ? String(match.anonymizedText) : item.anonymizedText
      };
    });
  }

  findClosestOccurrence(text, needle, referenceStart = 0) {
    const source = String(text || '');
    const target = String(needle || '');
    if (!source || !target) return -1;

    const matches = [];
    let startIndex = 0;
    while (startIndex <= source.length) {
      const found = source.indexOf(target, startIndex);
      if (found === -1) break;
      matches.push(found);
      startIndex = found + Math.max(1, target.length);
    }

    if (matches.length === 0) return -1;
    let best = matches[0];
    let bestDistance = Math.abs(best - referenceStart);
    for (let index = 1; index < matches.length; index += 1) {
      const candidate = matches[index];
      const distance = Math.abs(candidate - referenceStart);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  reconcileExistingItems(sourceText, items) {
    const text = String(sourceText || '');
    if (!text || !Array.isArray(items) || items.length === 0) return [];

    return items
      .map((item) => {
        const itemText = String(item?.text || '');
        if (!itemText) return null;

        const referenceStart = Number.isInteger(item.start) ? item.start : 0;
        const nextStart = this.findClosestOccurrence(text, itemText, referenceStart);
        if (nextStart === -1) return null;

        return {
          ...item,
          start: nextStart,
          end: nextStart + itemText.length,
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.start - right.start || left.end - right.end);
  }

  buildSignature(sourceText, detections) {
    const entries = detections.map((item) => `${item.label}:${item.start}:${item.end}`).join('|');
    return `${sourceText.length}:${this.settings.redactionMode}:${entries}`;
  }

  getSensitivityThreshold() {
    const map = { low: 0.75, medium: 0.62, high: 0.52 };
    return map[this.settings.sensitivity] || 0.62;
  }

  getElementText(element) {
    const state = this.redactions.get(element);

    if (element.isContentEditable || element.hasAttribute('contenteditable')) {
      const clone = element.cloneNode(true);
      clone.querySelectorAll('.ps-redaction, .ps-pii-underline').forEach((span) => {
        const original = span.getAttribute('data-ps-original');
        if (original != null) {
          span.replaceWith(document.createTextNode(original));
        } else {
          span.replaceWith(document.createTextNode(span.textContent || ''));
        }
      });
      const raw = this.extractContentEditableText(clone);
      // FIX: always restore known redactions so the semantic source text is
      // returned even when CE renders replacement text (prevents re-detection loop)
      return this.restoreKnownRedactions(raw, state);
    }

    const rawValue = element.value || '';
    if (!state || !Array.isArray(state.items) || state.items.length === 0) {
      return rawValue;
    }

    const hasRedactedItems = state.items.some((item) => item.redacted);
    if (!hasRedactedItems) return rawValue;

    const renderedFromState = this.buildRenderedText(state);
    if (rawValue === renderedFromState) {
      return state.sourceText || rawValue;
    }

    return this.restoreKnownRedactions(rawValue, state);
  }

  getRawElementText(element) {
    if (!element) return '';

    if (this.isContentEditableElement(element)) {
      const raw = element.textContent || element.innerText || '';
      return raw
        .replace(/\u00a0/g, ' ')
        .replace(/\r\n?/g, '\n');
    }

    return String(element.value || '');
  }

  restoreKnownRedactions(rawValue, state) {
    if (!state || !Array.isArray(state.items) || state.items.length === 0) {
      return String(rawValue || '');
    }

    let restored = String(rawValue || '');
    const redactedItems = state.items
      .filter((item) => item.redacted)
      .slice()
      .sort((a, b) => this.getReplacementText(b, state.mode).length - this.getReplacementText(a, state.mode).length);

    redactedItems.forEach((item) => {
      const replacement = this.getReplacementText(item, state.mode);
      if (!replacement || replacement === item.text) return;
      if (!restored.includes(replacement)) return;
      restored = restored.split(replacement).join(item.text);
    });

    return restored;
  }

  /**
   * DOM-aware text extraction for contenteditable elements.
   * Unlike textContent, this adds \n between block-level elements
   * so Gemini's <p>-based structure is correctly read.
   */
  extractContentEditableText(element) {
    let result = '';
    const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TR']);

    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        result += (node.nodeValue || '').replace(/\u00a0/g, ' ');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = node.tagName.toUpperCase();
      if (tag === 'BR') {
        result += '\n';
        return;
      }

      const isBlock = BLOCK_TAGS.has(tag);
      const prevLen = result.length;

      for (const child of node.childNodes) {
        walk(child);
      }

      if (isBlock && result.length > prevLen && !result.endsWith('\n')) {
        result += '\n';
      }
    };

    for (const child of element.childNodes) {
      walk(child);
    }

    return result
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\n$/, '')
      .replace(/\r\n?/g, '\n');
  }

  /**
   * Detect whether this contenteditable uses <p> tags (Gemini-style)
   * or <br> elements (ChatGPT/Claude-style) for newlines.
   */
  detectNativeNewlineStyle(element) {
    const hostname = window.location.hostname.toLowerCase();
    if (hostMatchesSite(hostname, 'gemini.google.com') || hostMatchesSite(hostname, 'bard.google.com')) return 'p';

    let pCount = 0;
    for (const child of element.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'P') {
        pCount++;
      }
    }
    return pCount >= 1 ? 'p' : 'br';
  }

  /**
   * Minimal HTML escaper for <p>-mode rendering.
   * Keeps \n as a literal character (caller will split on it for <p> wrapping).
   */
  escapeHtmlForParagraph(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');
  }

  isSyntheticReplacementToken(value) {
    const text = String(value || '').trim();
    if (!text) return true;
    // Exact alias tokens: <PERSON_1>
    if (/^<\s*[A-Z][A-Z0-9_]{1,40}\s*>$/.test(text)) return true;
    // Exact redacted tokens: [NAME REDACTED]
    if (/^\[[^\]]*redacted[^\]]*\]$/i.test(text)) return true;
    // Text *containing* alias tokens: "foo <PERSON_1> bar"
    if (/<\s*[A-Z][A-Z0-9_]{1,40}\s*>/.test(text)) return true;
    // Text *containing* redacted tokens
    if (/\[[^\]]*redacted[^\]]*\]/i.test(text)) return true;
    // Text that looks like a corrupted/concatenated redaction artefact
    // e.g. "phon:930409..." or "emailfoo@bar.commom"
    if (/\[\w+\s+REDACTED\]/i.test(text)) return true;
    // "WORD REDACTED" without brackets — GLiNER span may exclude the surrounding brackets
    if (/^[A-Z][A-Z\s]{1,30}\s+REDACTED$/i.test(text)) return true;
    return false;
  }

  setAnalyzingState(element, isAnalyzing) {
    if (!element || !element.classList) return;
    element.classList.toggle('ps-analyzing', isAnalyzing);
  }

  renderFieldHighlight(element, detections) {
    const elementId = this.getElementId(element);
    document.querySelectorAll(`.ps-highlight[data-element-id="${elementId}"]`).forEach((node) => node.remove());

    const rect = element.getBoundingClientRect();
    const primaryType = detections[0]?.label || 'person';
    const highlight = document.createElement('div');
    highlight.className = 'ps-highlight ps-pulse';
    highlight.setAttribute('data-element-id', elementId);
    highlight.style.top = `${rect.top + window.scrollY}px`;
    highlight.style.left = `${rect.left + window.scrollX}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
    highlight.style.setProperty('--detection-color', this.getTypeColor(primaryType));

    const label = document.createElement('span');
    label.className = 'ps-label';
    label.style.setProperty('--detection-color', this.getTypeColor(primaryType));
    label.textContent = `${detections.length} sensitive entit${detections.length === 1 ? 'y' : 'ies'} detected`;
    highlight.appendChild(label);

    document.body.appendChild(highlight);
    requestAnimationFrame(() => highlight.classList.add('ps-visible'));
  }

  // ═══════════════════════════════════════════════════════════
  // Redaction State Management
  // ═══════════════════════════════════════════════════════════

  getAliasLedger(element) {
    if (this.aliasLedgers.has(element)) return this.aliasLedgers.get(element);
    // Pre-populate ledger from the site alias cache so aliases stay consistent
    // across sessions (e.g. PERSON_1 remains PERSON_1 on the same site).
    const ledger = {
      aliases: new Map(Object.entries(this.siteAliasCache.aliases || {})),
      counters: new Map(Object.entries(this.siteAliasCache.counters || {}).map(([k, v]) => [k, Number(v)])),
      maskCounters: new Map(Object.entries(this.siteAliasCache.maskCounters || {}).map(([k, v]) => [k, Number(v)]))
    };
    this.aliasLedgers.set(element, ledger);
    return ledger;
  }

  createRedactionItem(detection, ledger, existingState = null) {
    // Check if this detection is already tracked and preserve its state
    if (existingState) {
      const existing = existingState.items.find(
        (ex) => ex.start === detection.start && ex.end === detection.end && ex.label === detection.label
      );
      if (existing) return existing; // Keep redacted/reviewed/alias state
    }

    const key = `${String(detection.label).toLowerCase()}::${String(detection.text).toLowerCase()}`;
    let alias = ledger.aliases.get(key);
    if (!alias) {
      alias = this.allocateAlias(detection.label, ledger);
      ledger.aliases.set(key, alias);
      // Persist new alias to site cache
      this.siteAliasCache.aliases[key] = alias;
      this.persistSiteAliasLedger();
    }

    // Allocate a stable numeric index per label type for numbered mask tokens,
    // e.g. [NAME_1 REDACTED], [NAME_2 REDACTED] — keeps repeated entities distinct.
    if (!ledger.maskCounters) ledger.maskCounters = new Map();
    const maskKey = String(detection.label || 'pii').toUpperCase().replace(/[^A-Z0-9]+/g, '_') || 'PII';
    const maskIndex = (ledger.maskCounters.get(maskKey) || 0) + 1;
    ledger.maskCounters.set(maskKey, maskIndex);
    // Persist mask counter to site cache
    this.siteAliasCache.maskCounters[maskKey] = maskIndex;
    this.persistSiteAliasLedger();

    return {
      ...detection,
      alias,
      maskIndex,
      anonymizedText: detection.anonymizedText ? String(detection.anonymizedText) : null,
      replacement: detection.replacement ? String(detection.replacement) : null,
      redacted: false,   // Start as underlined, NOT redacted
      reviewed: false
    };
  }

  allocateAlias(label, ledger) {
    const normalized = String(label || 'pii')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'PII';
    const next = (ledger.counters.get(normalized) || 0) + 1;
    ledger.counters.set(normalized, next);
    // Keep site alias cache in sync so counters persist across sessions
    this.siteAliasCache.counters[normalized] = next;
    this.persistSiteAliasLedger();
    return `${normalized}_${next}`;
  }

  // ═══════════════════════════════════════════════════════════
  // Auto-Redact Scheduler
  // ═══════════════════════════════════════════════════════════

  scheduleAutoRedact(element) {
    this.cancelAutoRedact(element);
    const timer = setTimeout(() => {
      this.redactAll(element);
    }, AUTO_REDACT_DELAY_MS);
    this.autoRedactTimers.set(element, timer);
  }

  cancelAutoRedact(element) {
    const timer = this.autoRedactTimers.get(element);
    if (timer) {
      clearTimeout(timer);
      this.autoRedactTimers.delete(element);
    }
  }

  redactAll(element) {
    const state = this.redactions.get(element);
    if (!state) return;

    let changed = false;
    let count = 0;
    state.items.forEach((item) => {
      // Skip items the user explicitly restored — respect their choice
      if (item.userRestored) return;
      if (!item.redacted) {
        item.redacted = true;
        item.reviewed = true;
        changed = true;
        count += 1;
        this._recordRedactionStat(item.label);
      }
    });

    if (changed) {
      this.rememberResponseRestoreMappings(state);
      this.renderElement(element);
      this.persistCache(element);
      this.showNotification(`${count} item${count === 1 ? '' : 's'} protected`, 'info');
      if (state.mode === 'mask') {
        setTimeout(() => {
          void this.showMaskModeHintOnce();
        }, 1100);
      }
      this.updateStats(0, count);
      // Track per-site manual redact count — after 3 times offer always-auto-redact
      this.siteRedactCount += 1;
      chrome.storage.local.set({ [this.getSiteRedactCountKey()]: this.siteRedactCount });
      if (this.siteRedactCount === 3 && !this.settings.autoRedact) {
        setTimeout(() => this.showNotification('Tip: enable Auto-Redact in AI-Safe Plugin settings to do this automatically.', 'info'), 1200);
      }
    }
  }

  getCommandRedactTarget() {
    const focused = Array.from(this.focusedElements).find((element) => (
      this.monitoredElements.has(element) && this.redactions.has(element)
    ));
    if (focused) return focused;

    for (const [element, state] of this.redactions.entries()) {
      if (!this.monitoredElements.has(element)) continue;
      if (!state?.items?.some((item) => item && !item.redacted)) continue;
      return element;
    }
    return null;
  }

  handleCommandRedactAll() {
    const target = this.getCommandRedactTarget();
    if (!target) return { success: false, error: 'No pending detections.' };
    this.redactAll(target);
    return { success: true };
  }

  async handleCommandToggleSite() {
    const host = normalizeSiteHost(window.location.hostname);
    if (!host) return { success: false, error: 'No host for this page.' };

    const result = await new Promise((resolve) => chrome.storage.local.get('excludedSites', resolve));
    const sites = Array.isArray(result.excludedSites)
      ? [...new Set(result.excludedSites.map((site) => normalizeSiteHost(site)).filter(Boolean))]
      : [];
    const currentlyExcluded = sites.includes(host);
    const excludedSites = currentlyExcluded
      ? sites.filter((site) => site !== host)
      : [...sites, host];

    await new Promise((resolve) => chrome.storage.local.set({ excludedSites }, resolve));
    return { success: true, enabled: currentlyExcluded, excludedSites };
  }

  restoreAll(element) {
    const state = this.redactions.get(element);
    if (!state) return;

    state.items.forEach((item) => {
      item.redacted = false;
      item.reviewed = true;
      item.userRestored = true;  // Protect from auto-re-redaction
    });

    this.cancelAutoRedact(element);

    this.renderElement(element);
    this.persistCache(element);
  }

  // ═══════════════════════════════════════════════════════════
  // Rendering
  // ═══════════════════════════════════════════════════════════

  renderElement(element, flashIndex = -1) {
    // Reflect the latest page-wide counts on the toolbar icon (U1). Fired here
    // because every state change (detect/redact/dismiss/restore/ignore) renders.
    this.scheduleToolbarStatsPush();
    const state = this.redactions.get(element);
    if (!state) return;

    if (this.isContentEditableElement(element)) {
      // ── Save cursor position ──
      const savedCaret = this.saveCaretPosition(element);

      const allUnderlineOnly = state.items.every((item) => !item.redacted);

      const html = this.renderContentEditableHtml(element, state, flashIndex);
      if (html == null) return;

      this.withSuppressedInput(element, () => {
        element.innerHTML = html;
      });

      // Attach delegated event listeners for click/hover on spans
      this._attachContentEditableSpanListeners(element);

      // ── Restore cursor position ──
      this.restoreCaretPosition(element, savedCaret);

      if (!allUnderlineOnly) {
        this.playCommitAnimation(element);
      }
      this.removeTokenTray(element);

      // FIX: Update lastAnalyzedSnapshot so the input event fired by the DOM
      // mutation doesn't immediately re-trigger detection on the replaced text.
      const currentRevision = this.getInputRevision(element);
      const sourceText = state.sourceText || '';
      const snapshotKey = `${currentRevision}:${this.hashString(sourceText)}`;
      this.lastAnalyzedSnapshot.set(element, snapshotKey);

      // Schedule overlay pass: if the host editor (Lexical, ProseMirror, Angular, etc.)
      // strips our injected spans during its reconciliation cycle, we draw external
      // fixed-position highlights instead so visuals survive without touching the editor DOM.
      this._scheduleOverlayUpdate(element);
      this.scheduleAssistantResponseRestore('render');
      // Update badge after render
      this.updateFieldBadge(element, state);
      return;
    }

    // Input/textarea
    const savedStart = element.selectionStart;
    const savedEnd = element.selectionEnd;

    const renderedText = this.buildRenderedText(state);
    this.withSuppressedInput(element, () => {
      element.value = renderedText;
    });

    // Restore cursor
    try {
      element.selectionStart = Math.min(savedStart, renderedText.length);
      element.selectionEnd = Math.min(savedEnd, renderedText.length);
    } catch { /* some inputs don't support selection */ }

    if (state.items.some((i) => i.redacted)) {
      this.playCommitAnimation(element);
    }
    // Token tray only renders while the panel is closed
    if (!this.fieldPanels.has(element)) {
      this.renderTokenTray(element, state);
    }
    this.updateFieldBadge(element, state);
    this.scheduleAssistantResponseRestore('render');
  }

  isContentEditableElement(element) {
    return Boolean(element?.isContentEditable || element?.hasAttribute?.('contenteditable'));
  }

  // ── Caret save/restore for contenteditable ──

  saveCaretPosition(element) {
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || !element.contains(sel.anchorNode)) return null;

      const range = sel.getRangeAt(0);
      const preCaretRange = range.cloneRange();
      preCaretRange.selectNodeContents(element);
      preCaretRange.setEnd(range.startContainer, range.startOffset);
      const startOffset = preCaretRange.toString().length;

      preCaretRange.setEnd(range.endContainer, range.endOffset);
      const endOffset = preCaretRange.toString().length;

      return { startOffset, endOffset };
    } catch {
      return null;
    }
  }

  restoreCaretPosition(element, saved) {
    if (!saved) return;
    try {
      const offsets = this.buildTextNodeOffsets(element);
      const startPos = this.resolveTextPosition(offsets, saved.startOffset, false);
      const endPos = this.resolveTextPosition(offsets, saved.endOffset, true);
      if (!startPos || !endPos) return;

      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(startPos.node, startPos.offset);
      range.setEnd(endPos.node, endPos.offset);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch { /* best-effort */ }
  }

  captureContentEditableHtml(element) {
    const clone = element.cloneNode(true);
    // Strip any existing redaction/underline spans to get clean source
    clone.querySelectorAll('.ps-redaction, .ps-pii-underline').forEach((node) => {
      const original = node.getAttribute('data-ps-original') || node.textContent || '';
      node.replaceWith(document.createTextNode(original));
    });
    return clone.innerHTML;
  }

  buildTextNodeOffsets(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const offsets = [];
    let position = 0;
    let node = walker.nextNode();
    while (node) {
      const value = node.nodeValue || '';
      const length = value.length;
      offsets.push({ node, start: position, end: position + length });
      position += length;
      node = walker.nextNode();
    }
    return offsets;
  }

  resolveTextPosition(offsets, absoluteOffset, preferNext = false) {
    if (!Array.isArray(offsets) || offsets.length === 0) return null;

    for (let index = 0; index < offsets.length; index += 1) {
      const item = offsets[index];
      if (absoluteOffset < item.start) continue;
      if (absoluteOffset > item.end) continue;

      if (absoluteOffset === item.end && preferNext && index < offsets.length - 1) {
        const next = offsets[index + 1];
        return { node: next.node, offset: 0 };
      }

      return {
        node: item.node,
        offset: Math.max(0, Math.min(item.node.nodeValue?.length || 0, absoluteOffset - item.start))
      };
    }

    const last = offsets[offsets.length - 1];
    if (absoluteOffset === last.end) {
      return { node: last.node, offset: last.node.nodeValue?.length || 0 };
    }

    return null;
  }

  renderContentEditableHtml(element, state, flashIndex = -1) {
    const sourceText = state.sourceText || '';
    if (!sourceText) return null;

    // Detect whether the editor uses <p> (Gemini) or <br> (ChatGPT/Claude) for newlines
    const newlineStyle = this.detectNativeNewlineStyle(element);

    const sorted = state.items
      .map((item, index) => ({ item, index }))
      .slice()
      .sort((a, b) => a.item.start - b.item.start);

    const encodeSegment = (str) => newlineStyle === 'p'
      ? this.escapeHtmlForParagraph(str)
      : this.textToHtmlPreserveLayout(str);

    const parts = [];
    let cursor = 0;

    sorted.forEach(({ item, index }) => {
      const start = Math.max(0, item.start);
      const end = Math.min(sourceText.length, item.end);
      if (start >= end || start < cursor) return;

      if (cursor < start) {
        parts.push(encodeSegment(sourceText.slice(cursor, start)));
      }

      const originalText = item.text || sourceText.slice(start, end);
      const color = this.getTypeColor(item.label);
      const stagger = `${Math.min(index * 30, 280)}ms`;
      const escapedOriginal = encodeSegment(originalText);

      if (item.redacted) {
        const displayText = encodeSegment(this.getReplacementText(item));
        const extraClasses = ['ps-redaction-active'];
        if (this.settings?.redactionMode === 'anonymize') extraClasses.push('ps-redaction-anonymized');
        if (flashIndex === index) extraClasses.push('ps-undo-ripple');
        parts.push(
          `<span class="ps-redaction ${extraClasses.join(' ')}"` +
          ` data-index="${index}"` +
          ` data-ps-original="${this._escapeAttr(originalText)}"` +
          ` style="--redaction-color:${color};--stagger:${stagger}"` +
          ` title="Hover to restore ${this.escapeHtml(item.label)}"` +
          `>${displayText}</span>`
        );
      } else {
        const flashClass = flashIndex === index ? ' ps-undo-ripple' : '';
        parts.push(
          `<span class="ps-pii-underline${flashClass}"` +
          ` data-index="${index}"` +
          ` data-ps-original="${this._escapeAttr(originalText)}"` +
          (item.tier ? ` data-tier="${item.tier}"` : '') +
          ` style="--detection-color:${color};--stagger:${stagger}"` +
          `>${escapedOriginal}</span>`
        );
      }

      cursor = end;
    });

    if (cursor < sourceText.length) {
      parts.push(encodeSegment(sourceText.slice(cursor)));
    }

    if (newlineStyle === 'p') {
      // Parts contain literal \n — split and wrap each line in <p>
      const flat = parts.join('');
      const lines = flat.split('\n');
      return lines.map((line) => `<p>${line || '<br>'}</p>`).join('');
    }

    return parts.join('');
  }

  /** Escape a string for safe use inside an HTML attribute value (double-quoted). */
  _escapeAttr(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  textToHtmlPreserveLayout(str) {
    const value = String(str || '').replace(/\r\n?/g, '\n');

    // Step 1: Extract and preserve code blocks (```...```) first
    const codeBlockPattern = /(```[\s\S]*?```)/g;
    const codeBlocks = [];
    let textWithoutCodeBlocks = value.replace(codeBlockPattern, (match) => {
      codeBlocks.push(match);
      return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
    });

    // Step 2: Extract inline code (`...`)
    const inlineCodePattern = /(`[^`\n]+`)/g;
    const inlineCodes = [];
    textWithoutCodeBlocks = textWithoutCodeBlocks.replace(inlineCodePattern, (match) => {
      inlineCodes.push(match);
      return `__INLINE_CODE_${inlineCodes.length - 1}__`;
    });

    // Step 3: Process the remaining text with whitespace and markdown
    let out = '';
    let lineStart = true;

    for (let i = 0; i < textWithoutCodeBlocks.length; i += 1) {
      const ch = textWithoutCodeBlocks[i];

      // Check for placeholder markers and restore original
      if (textWithoutCodeBlocks.startsWith(`__CODE_BLOCK_`, i)) {
        const match = textWithoutCodeBlocks.slice(i).match(/^__CODE_BLOCK_(\d+)__/);
        if (match) {
          // Restore code block with literal formatting
          const codeIdx = parseInt(match[1], 10);
          const codeBlock = codeBlocks[codeIdx] || '';
          // Convert newlines within code blocks to <br> but preserve leading/trailing newlines
          out += this.escapeHtmlForParagraph(codeBlock).replace(/\n/g, '<br>');
          i += match[0].length - 1;
          lineStart = false;
          continue;
        }
      }

      if (textWithoutCodeBlocks.startsWith(`__INLINE_CODE_`, i)) {
        const match = textWithoutCodeBlocks.slice(i).match(/^__INLINE_CODE_(\d+)__/);
        if (match) {
          const codeIdx = parseInt(match[1], 10);
          const inlineCode = inlineCodes[codeIdx] || '';
          // Keep inline code as-is (backticks will be handled later)
          out += inlineCode;
          i += match[0].length - 1;
          lineStart = false;
          continue;
        }
      }

      if (ch === '\n') {
        out += '<br>';
        lineStart = true;
        continue;
      }

      if (ch === '\t') {
        out += '&nbsp;&nbsp;&nbsp;&nbsp;';
        lineStart = false;
        continue;
      }

      if (ch === ' ') {
        const prev = i > 0 ? textWithoutCodeBlocks[i - 1] : '\n';
        const next = i + 1 < textWithoutCodeBlocks.length ? textWithoutCodeBlocks[i + 1] : '\n';
        // Preserve spaces at line start, after other spaces, and before newlines
        const preserve = lineStart || prev === ' ' || next === ' ' || next === '\n';
        out += preserve ? '&nbsp;' : ' ';
        lineStart = false;
        continue;
      }

      // HTML entity escaping
      if (ch === '&') {
        out += '&amp;';
      } else if (ch === '<') {
        out += '&lt;';
      } else if (ch === '>') {
        out += '&gt;';
      } else {
        out += ch;
      }
      lineStart = false;
    }

    // Step 4: Restore inline code with formatting
    out = out.replace(/__INLINE_CODE_(\d+)__/g, (match, idx) => {
      const code = inlineCodes[parseInt(idx, 10)] || '';
      // Wrap inline code in styling span but keep backticks visible
      return `<span class="ps-inline-code">${this.escapeHtmlForParagraph(code)}</span>`;
    });

    // Step 5: Handle markdown formatting that wasn't in code blocks
    // Bold: **text** or __text__
    out = out.replace(/(\*\*[^*]+\*\*|__[^_]+__)/g, '<strong>$1</strong>');
    // Italic: *text* or _text_ (not in strong)
    out = out.replace(/(?<!\*)(\*[^*]+\*)(?!\*)/g, '<em>$1</em>');
    out = out.replace(/(?<!_)(_[^_]+_)(?!_)/g, '<em>$1</em>');

    return out;
  }

  /**
   * Attach click / hover listeners to ps-redaction and ps-pii-underline spans
   * inside a contentEditable element via event delegation.  Called once after
   * innerHTML is set so that listeners survive serialisation.
   */
  _attachContentEditableSpanListeners(element) {
    // Guard against double-attaching. Use a WeakSet to avoid polluting DOM nodes.
    if (!this._ceListenersAttached) this._ceListenersAttached = new WeakSet();
    if (this._ceListenersAttached.has(element)) return;
    this._ceListenersAttached.add(element);

    element.addEventListener('click', (event) => {
      const span = event.target.closest('.ps-redaction, .ps-pii-underline');
      if (!span) return;
      event.preventDefault();
      event.stopPropagation();
      const index = parseInt(span.getAttribute('data-index'), 10);
      if (Number.isNaN(index)) return;
      if (span.classList.contains('ps-pii-underline')) {
        this.redactSingle(element, index);
      } else {
        this.toggleRedaction(element, index);
      }
    });

    // IMPORTANT: mouseenter/mouseleave do NOT bubble, so delegating them on the
    // parent element never fires for child spans. Use mouseover/mouseout instead.
    //
    // KEY INSIGHT (Grammarly approach): rich editors like ProseMirror/Lexical run a
    // MutationObserver with { attributes: true, subtree: true } on their contenteditable.
    // Any attribute change on a child node (even a CSS class toggle) triggers their
    // reconciliation loop which re-renders the DOM — wiping our spans before rAF fires.
    //
    // Fix: capture getBoundingClientRect() SYNCHRONOUSLY during the event handler
    // (before any microtask/reconciliation can run), then render the reveal overlay as
    // a fixed-position div OUTSIDE the contenteditable. Zero DOM mutations inside the
    // editor during hover.
    element.addEventListener('mouseover', (event) => {
      const span = event.target.closest('.ps-redaction, .ps-pii-underline');
      if (!span || !element.contains(span)) return;
      const index = parseInt(span.getAttribute('data-index'), 10);
      if (Number.isNaN(index)) return;
      const mode = span.classList.contains('ps-pii-underline') ? 'underline' : 'redacted';

      // Capture rect NOW — synchronously — before any reconciliation microtask runs.
      // Use getClientRects() to get the visual line segment under the cursor; a plain
      // getBoundingClientRect() gives a giant combined box for wrapped tokens.
      const rects = span.getClientRects();
      const anchorRect = [...rects].find(r => event.clientY >= r.top && event.clientY <= r.bottom)
        ?? rects[0]
        ?? span.getBoundingClientRect();

      if (mode === 'redacted') {
        const currentState = this.redactions.get(element);
        const current = currentState?.items?.[index];
        if (current?.redacted) {
          this.beginRevealHover({
            element,
            itemIndex: index,
            anchorRect,
            typographySource: span,
          });
        }
      } else {
        // Pre-redaction underline → show the explanatory popover (U2).
        this.beginPopoverHover({ element, itemIndex: index, anchorRect });
      }
    });

    element.addEventListener('mouseout', (event) => {
      const span = event.target.closest('.ps-redaction, .ps-pii-underline');
      if (!span || !element.contains(span)) return;
      // Skip if the pointer is still within the same span (moving between child nodes)
      if (span.contains(event.relatedTarget)) return;
      const index = parseInt(span.getAttribute('data-index'), 10);
      const idx = Number.isNaN(index) ? null : index;
      if (span.classList.contains('ps-pii-underline')) {
        // Pre-redaction underline → close the popover unless the pointer moved onto it.
        this.cancelPopoverOpen();
        if (!this.shouldKeepPopoverOpen(event.relatedTarget, element, idx)) this.schedulePopoverHide();
        return;
      }
      if (this.shouldKeepRevealOpen(event.relatedTarget, element, idx)) return;
      this.scheduleRevealHide();
    });
  }

  // ── Underline span (Grammarly-style, before redaction) ──

  createUnderlineSpan(element, index, item) {
    const span = document.createElement('span');
    span.className = 'ps-pii-underline';
    span.setAttribute('data-index', String(index));
    span.setAttribute('data-ps-original', String(item.text || ''));
    if (item.tier) span.setAttribute('data-tier', item.tier);
    span.style.setProperty('--detection-color', this.getTypeColor(item.label));
    span.style.setProperty('--stagger', `${Math.min(index * 40, 300)}ms`);
    span.textContent = item.text;

    span.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.redactSingle(element, index);
    });

    return span;
  }

  // ── Redaction span (after redaction) ──

  createRedactionSpan(element, index, item, flash = false) {
    const span = document.createElement('span');
    span.className = 'ps-redaction';
    span.setAttribute('data-index', String(index));
    span.setAttribute('data-ps-original', String(item.text || ''));
    span.style.setProperty('--redaction-color', this.getTypeColor(item.label));
    span.style.setProperty('--stagger', `${Math.min(index * 30, 280)}ms`);

    if (item.redacted) {
      span.classList.add('ps-redaction-active');
      if (this.settings.redactionMode === 'anonymize') {
        span.classList.add('ps-redaction-anonymized');
      }
      span.textContent = this.getReplacementText(item);
      span.title = `Hover to restore ${item.label}`;
    } else {
      span.classList.add('ps-redaction-restored');
      span.textContent = item.text;
      span.title = 'Hover to re-redact';
    }

    if (flash) {
      span.classList.add('ps-undo-ripple');
    }

    span.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.toggleRedaction(element, index);
    });

    return span;
  }

  buildRenderedText(state) {
    let output = state.sourceText;
    const sorted = state.items
      .filter((item) => item.redacted)
      .slice()
      .sort((a, b) => b.start - a.start);

    sorted.forEach((item) => {
      output = output.slice(0, item.start) + this.getReplacementText(item) + output.slice(item.end);
    });

    return output;
  }

  getReplacementText(item, modeOverride = this.settings.redactionMode) {
    if (!item.redacted) return item.text;
    if (modeOverride === 'anonymize') {
      if (item.anonymizedText) return item.anonymizedText;
      if (item.replacement) return item.replacement;
      return this.getMaskText(item.label, item.maskIndex ?? null);
    }
    if (item.replacement) return item.replacement;
    return this.getMaskText(item.label, item.maskIndex ?? null);
  }

  getMaskText(label, maskIndex = null) {
    const map = {
      person: '[NAME REDACTED]',
      email: '[EMAIL REDACTED]',
      phone: '[PHONE REDACTED]',
      address: '[ADDRESS REDACTED]',
      ssn: '[SSN REDACTED]',
      credit_card: '[CARD REDACTED]',
      date_of_birth: '[DOB REDACTED]',
      location: '[LOCATION REDACTED]',
      organization: '[ORG REDACTED]',
      api_key: '[API KEY REDACTED]',
      ip_address: '[IP REDACTED]',
      jwt: '[JWT REDACTED]',
      pan: '[PAN REDACTED]',
      aadhaar: '[AADHAAR REDACTED]',
      passport: '[PASSPORT REDACTED]',
      ifsc: '[IFSC REDACTED]',
      driver_license: '[DL REDACTED]',
      bank_account: '[BANK ACCOUNT REDACTED]',
      oauth_token: '[OAUTH TOKEN REDACTED]',
      mac_address: '[MAC REDACTED]',
      employee_id: '[EMPLOYEE ID REDACTED]',
      device_id: '[DEVICE ID REDACTED]',
      session_id: '[SESSION ID REDACTED]',
      private_key: '[PRIVATE KEY REDACTED]',
      connection_string: '[CONNECTION STRING REDACTED]'
    };
    const base = map[label] || `[${String(label || 'PII').toUpperCase()} REDACTED]`;
    // Insert numeric index before REDACTED so tokens are uniquely identifiable:
    // [NAME REDACTED] → [NAME_1 REDACTED] for repeated entities in the same prompt.
    if (maskIndex != null) return base.replace(/ REDACTED]$/, `_${maskIndex} REDACTED]`);
    return base;
  }

  // ═══════════════════════════════════════════════════════════
  // Popover (per-span anchored tooltip – Grammarly-style)
  // ═══════════════════════════════════════════════════════════

  // anchorRect is captured synchronously from the hover event so positioning does
  // not depend on the underline span still being in the DOM when rAF fires (rich
  // editors may reconcile in between) — same strategy as the reveal overlay.
  beginPopoverHover({ element, itemIndex, anchorRect }) {
    const item = this.redactions.get(element)?.items?.[itemIndex];
    if (!item || item.redacted) return;  // popover is for pre-redaction underlines only

    this.cancelPopoverClose();
    this.cancelPopoverOpen();

    const show = () => {
      const current = this.redactions.get(element)?.items?.[itemIndex];
      if (!current || current.redacted) {
        this.hidePopover();
        return;
      }
      this.activePopoverState = { element, itemIndex, anchorRect };
      this.showPopover(element, itemIndex, anchorRect);
    };

    if (this.activePopoverState?.element === element && this.activePopoverState?.itemIndex === itemIndex) {
      show();
      return;
    }
    this.popoverOpenTimer = setTimeout(() => {
      this.popoverOpenTimer = 0;
      show();
    }, 250);
  }

  showPopover(element, itemIndex, anchorRect) {
    if (!anchorRect) return;
    const item = this.redactions.get(element)?.items?.[itemIndex];
    if (!item || item.redacted) return;

    let card = this.activePopover;
    if (!card) {
      card = document.createElement('div');
      card.className = 'ps-popover';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-label', 'AI-Safe Plugin detection');
      card.addEventListener('mouseenter', () => this.cancelPopoverClose());
      card.addEventListener('mouseleave', (event) => {
        const st = this.activePopoverState;
        if (st && this.shouldKeepPopoverOpen(event.relatedTarget, st.element, st.itemIndex)) return;
        this.schedulePopoverHide();
      });
      document.body.appendChild(card);
      this.activePopover = card;
      // Close on Escape while the card is open.
      this._popoverKeydown = (event) => { if (event.key === 'Escape') this.hidePopover(); };
      document.addEventListener('keydown', this._popoverKeydown, true);
    } else if (!card.isConnected) {
      document.body.appendChild(card);
    }

    card.textContent = '';
    card.style.setProperty('--detection-color', this.getTypeColor(item.label));

    // Header: colored dot + human label + confidence-tier chip.
    const header = document.createElement('div');
    header.className = 'ps-popover-header';
    const dot = document.createElement('span');
    dot.className = 'ps-popover-dot';
    header.appendChild(dot);
    const title = document.createElement('span');
    title.className = 'ps-popover-title';
    title.textContent = this.formatLabel(item.label);
    header.appendChild(title);
    const tier = String(item.tier || '').toLowerCase();
    if (tier === 'high' || tier === 'medium' || tier === 'low') {
      const chip = document.createElement('span');
      chip.className = `ps-popover-tier ps-popover-tier-${tier}`;
      chip.textContent = `${tier} confidence`;
      header.appendChild(chip);
    }
    card.appendChild(header);

    // Explanation line.
    const text = document.createElement('div');
    text.className = 'ps-popover-text';
    text.textContent = LABEL_EXPLANATIONS[item.label] || LABEL_EXPLANATION_FALLBACK;
    card.appendChild(text);

    // Actions: Redact (primary) + Dismiss. (U3 adds "Ignore on this site".)
    const actions = document.createElement('div');
    actions.className = 'ps-popover-actions';

    const redactBtn = document.createElement('button');
    redactBtn.type = 'button';
    redactBtn.className = 'ps-popover-btn ps-popover-btn-primary';
    redactBtn.textContent = 'Redact';
    redactBtn.setAttribute('aria-label', `Redact ${this.formatLabel(item.label)}`);
    redactBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.redactSingle(element, itemIndex);
      this.hidePopover();
    });
    actions.appendChild(redactBtn);

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'ps-popover-btn ps-popover-btn-dismiss';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.setAttribute('aria-label', `Dismiss ${this.formatLabel(item.label)}`);
    dismissBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.dismissDetection(element, itemIndex);
      this.hidePopover();
    });
    actions.appendChild(dismissBtn);

    // Ignore on this site — omitted for high-risk labels (U3).
    if (this.canIgnoreLabel(item.label)) {
      const ignoreBtn = document.createElement('button');
      ignoreBtn.type = 'button';
      ignoreBtn.className = 'ps-popover-btn ps-popover-btn-dismiss';
      ignoreBtn.textContent = 'Ignore here';
      ignoreBtn.setAttribute('aria-label', `Ignore ${this.formatLabel(item.label)} on this site`);
      ignoreBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.ignoreDetectionValue(element, itemIndex);
        this.hidePopover();
      });
      actions.appendChild(ignoreBtn);
    }

    card.appendChild(actions);

    this.positionPopover(anchorRect);
    requestAnimationFrame(() => {
      if (this.activePopover === card) card.classList.add('ps-popover-visible');
    });
  }

  positionPopover(anchorRect) {
    const card = this.activePopover;
    if (!card || !anchorRect) return;
    const margin = 12;
    const spacing = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = card.offsetWidth || 1;
    const h = card.offsetHeight || 1;

    let left = anchorRect.left + (anchorRect.width / 2) - (w / 2);
    left = Math.max(margin, Math.min(left, vw - w - margin));

    // Prefer below the underline (Grammarly-style); flip above when there's no room.
    let top = anchorRect.bottom + spacing;
    if (top + h > vh - margin) top = anchorRect.top - h - spacing;
    top = Math.max(margin, Math.min(top, vh - h - margin));

    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
  }

  refreshPopoverPosition() {
    const st = this.activePopoverState;
    if (!st || !this.activePopover) return;
    const item = this.redactions.get(st.element)?.items?.[st.itemIndex];
    if (!item || item.redacted) {
      this.hidePopover();
      return;
    }
    const rect = this.getRevealAnchorRect(st.element, st.itemIndex);
    if (!rect || rect.width === 0 || rect.height === 0) {
      this.hidePopover();
      return;
    }
    st.anchorRect = rect;
    this.positionPopover(rect);
  }

  cancelPopoverOpen() {
    if (this.popoverOpenTimer) {
      clearTimeout(this.popoverOpenTimer);
      this.popoverOpenTimer = 0;
    }
  }

  cancelPopoverClose() {
    if (this.popoverHideTimer) {
      clearTimeout(this.popoverHideTimer);
      this.popoverHideTimer = 0;
    }
  }

  schedulePopoverHide(delay = 150) {
    this.cancelPopoverOpen();
    this.cancelPopoverClose();
    this.popoverHideTimer = setTimeout(() => {
      this.popoverHideTimer = 0;
      this.hidePopover();
    }, delay);
  }

  shouldKeepPopoverOpen(target, element, itemIndex) {
    if (!target) return false;
    if (this.activePopover?.contains?.(target)) return true;
    if (!(target instanceof Element)) return false;
    if (itemIndex != null) {
      // Overlay-highlight (hostile editors) lives on document.body, not inside element.
      if (target.closest(`.ps-overlay-hl[data-item-index="${itemIndex}"]`)) return true;
      if (element?.contains?.(target) && target.closest(`.ps-pii-underline[data-index="${itemIndex}"]`)) return true;
    }
    return false;
  }

  hidePopover() {
    this.cancelPopoverOpen();
    this.cancelPopoverClose();
    this.activePopoverState = null;
    if (this._popoverKeydown) {
      document.removeEventListener('keydown', this._popoverKeydown, true);
      this._popoverKeydown = null;
    }
    if (!this.activePopover) return;
    this.activePopover.classList.remove('ps-popover-visible');
    const old = this.activePopover;
    setTimeout(() => old.remove(), 200);
    this.activePopover = null;
  }

  // ── Reveal overlay (fixed-position, outside contenteditable DOM) ──────────
  // Displays the original text visually over the redacted span on hover,
  // without touching any node inside the contenteditable. This survives
  // rich-editor DOM reconciliation (ProseMirror, Lexical, etc.).

  showRevealOverlay(originalText, anchorRect, refSpan) {
    if (!anchorRect || anchorRect.width === 0) return;

    let overlay = this.activeRevealOverlay;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'ps-reveal-overlay';
      overlay.addEventListener('mouseenter', () => {
        this.cancelRevealClose();
      });
      overlay.addEventListener('mouseleave', (event) => {
        if (this.shouldKeepRevealOpen(event.relatedTarget, this.activeRevealState?.element, this.activeRevealState?.itemIndex)) {
          return;
        }
        this.scheduleRevealHide();
      });
      document.body.appendChild(overlay);
      this.activeRevealOverlay = overlay;
    } else if (!overlay.isConnected) {
      document.body.appendChild(overlay);
    }

    const cs = window.getComputedStyle(refSpan);
    overlay.textContent = originalText;
    overlay.style.visibility = 'hidden';
    overlay.style.fontSize = cs.fontSize;
    overlay.style.fontFamily = cs.fontFamily;
    overlay.style.fontWeight = cs.fontWeight;
    overlay.style.lineHeight = cs.lineHeight;
    overlay.style.letterSpacing = cs.letterSpacing;
    this.positionRevealOverlay(anchorRect);
    overlay.style.visibility = '';
  }

  hideRevealOverlay() {
    this.cancelRevealOpen();
    this.cancelRevealClose();
    if (this.activeRevealOverlay) {
      this.activeRevealOverlay.remove();
      this.activeRevealOverlay = null;
    }
    this.activeRevealState = null;
  }

  cancelRevealOpen() {
    if (this.revealOpenTimer) {
      clearTimeout(this.revealOpenTimer);
      this.revealOpenTimer = 0;
    }
  }

  cancelRevealClose() {
    if (this.revealCloseTimer) {
      clearTimeout(this.revealCloseTimer);
      this.revealCloseTimer = 0;
    }
  }

  beginRevealHover({ element, itemIndex, anchorRect, typographySource, anchorKey = null }) {
    const item = this.redactions.get(element)?.items?.[itemIndex];
    if (!item?.redacted) return;

    this.cancelRevealClose();
    this.cancelRevealOpen();

    const show = () => {
      const current = this.redactions.get(element)?.items?.[itemIndex];
      if (!current?.redacted) {
        this.hideRevealOverlay();
        return;
      }
      this.activeRevealState = { element, itemIndex, anchorKey };
      this.showRevealOverlay(current.text, anchorRect, typographySource || element);
    };

    if (this.activeRevealState?.element === element && this.activeRevealState?.itemIndex === itemIndex) {
      show();
      return;
    }

    this.revealOpenTimer = setTimeout(() => {
      this.revealOpenTimer = 0;
      show();
    }, 70);
  }

  scheduleRevealHide(delay = 120) {
    this.cancelRevealOpen();
    this.cancelRevealClose();
    this.revealCloseTimer = setTimeout(() => {
      this.revealCloseTimer = 0;
      this.hideRevealOverlay();
    }, delay);
  }

  shouldKeepRevealOpen(target, element, itemIndex) {
    if (!target || itemIndex == null) return false;
    if (this.activeRevealOverlay?.contains?.(target)) return true;
    if (!(target instanceof Element)) return false;

    const overlayMatch = target.closest(`.ps-overlay-hl[data-item-index="${itemIndex}"]`);
    if (overlayMatch) return true;

    if (element?.contains?.(target)) {
      const spanMatch = target.closest(`.ps-redaction[data-index="${itemIndex}"], .ps-pii-underline[data-index="${itemIndex}"]`);
      if (spanMatch) return true;
    }
    return false;
  }

  positionRevealOverlay(anchorRect) {
    const overlay = this.activeRevealOverlay;
    if (!overlay || !anchorRect) return;

    const margin = 12;
    const spacing = 10;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const overlayWidth = overlay.offsetWidth || 1;
    const overlayHeight = overlay.offsetHeight || 1;

    let left = anchorRect.left + (anchorRect.width / 2) - (overlayWidth / 2);
    left = Math.max(margin, Math.min(left, viewportWidth - overlayWidth - margin));

    let top = anchorRect.top - overlayHeight - spacing;
    if (top < margin) {
      top = anchorRect.bottom + spacing;
    }
    top = Math.max(margin, Math.min(top, viewportHeight - overlayHeight - margin));

    overlay.style.left = `${Math.round(left)}px`;
    overlay.style.top = `${Math.round(top)}px`;
  }

  getRevealAnchorRect(element, itemIndex, anchorKey = null) {
    const layer = this._ceOverlayHighlights.get(element);
    if (layer?.highlights instanceof Map) {
      if (anchorKey && layer.highlights.has(anchorKey)) {
        return layer.highlights.get(anchorKey).getBoundingClientRect();
      }
      for (const node of layer.highlights.values()) {
        if (String(node.dataset.itemIndex) === String(itemIndex)) {
          return node.getBoundingClientRect();
        }
      }
    }

    const span = element?.querySelector?.(`.ps-redaction[data-index="${itemIndex}"], .ps-pii-underline[data-index="${itemIndex}"]`);
    if (!span) return null;

    const rects = span.getClientRects();
    return rects[0] || span.getBoundingClientRect();
  }

  refreshRevealOverlayPosition() {
    const reveal = this.activeRevealState;
    if (!reveal || !this.activeRevealOverlay) return;

    const item = this.redactions.get(reveal.element)?.items?.[reveal.itemIndex];
    if (!item?.redacted) {
      this.hideRevealOverlay();
      return;
    }

    const anchorRect = this.getRevealAnchorRect(reveal.element, reveal.itemIndex, reveal.anchorKey);
    if (!anchorRect || anchorRect.width === 0 || anchorRect.height === 0) {
      this.hideRevealOverlay();
      return;
    }

    this.activeRevealOverlay.textContent = item.text;
    this.positionRevealOverlay(anchorRect);
  }

  // ═══════════════════════════════════════════════════════════
  // External overlay highlights for hostile contenteditables
  // (ChatGPT / Gemini / Claude — editors that strip injected spans)
  // ═══════════════════════════════════════════════════════════

  _scheduleOverlayUpdate(element) {
    clearTimeout(this._ceOverlayTimers.get(element));
    this._ceOverlayTimers.set(element, setTimeout(() => {
      this._updateElementOverlay(element);
    }, 90)); // 90ms — enough for any editor reconciliation microtask/macrotask to complete
  }

  _updateElementOverlay(element) {
    const state = this.redactions.get(element);
    if (!state || !element.isConnected || !state.items.length) {
      this._clearElementOverlay(element);
      return;
    }

    // If our spans survived innerHTML injection (regular site), the existing span
    // delegation handles everything — no overlay needed.
    if (element.querySelector('.ps-redaction, .ps-pii-underline')) {
      this._clearElementOverlay(element);
      return;
    }

    // Spans were stripped by the editor. Draw external fixed-position highlights.
    const clipRect = this.getOverlayClipRect(element);
    if (!clipRect) {
      this._clearElementOverlay(element);
      return;
    }

    const layer = this._getOrCreateOverlayLayer(element);
    const seenKeys = new Set();

    state.items.forEach((item, index) => {
      const range = item.redacted
        ? this._getTokenRange(element, this.getReplacementText(item))
        : this._getTextNodeRange(element, item.start, item.end);

      if (!range) return;
      // Use getClientRects() instead of getBoundingClientRect() so that tokens
      // wrapping across multiple visual lines get one hl div per line segment,
      // not a single giant bounding-box rectangle.
      const lineRects = [...range.getClientRects()]
        .map((rect) => this.intersectClientRect(rect, clipRect))
        .filter((rect) => rect && rect.width > 0 && rect.height > 0);
      if (!lineRects.length) return;

      const color = this.getTypeColor(item.label);
      lineRects.forEach((rect, rectIndex) => {
        const overlayKey = `${index}:${rectIndex}`;
        seenKeys.add(overlayKey);
        let hl = layer.highlights.get(overlayKey);
        if (!hl) {
          hl = this._createOverlayHighlightNode(element, index);
          layer.root.appendChild(hl);
          layer.highlights.set(overlayKey, hl);
        }

        hl.dataset.itemIndex = String(index);
        hl.dataset.overlayKey = overlayKey;
        hl.classList.toggle('ps-overlay-hl-redacted', Boolean(item.redacted));
        hl.classList.toggle('ps-overlay-hl-underline', !item.redacted);
        hl.style.left = `${Math.round(rect.left)}px`;
        hl.style.top = `${Math.round(rect.top)}px`;
        hl.style.width = `${Math.round(rect.width)}px`;
        hl.style.height = `${Math.round(rect.height)}px`;
        hl.style.setProperty('--hl-color', color);
      });
    });

    layer.highlights.forEach((hl, key) => {
      if (seenKeys.has(key)) return;
      hl.remove();
      layer.highlights.delete(key);
    });

    if (layer.highlights.size === 0) {
      this._clearElementOverlay(element);
    } else if (this.activeRevealState?.element === element) {
      this.refreshRevealOverlayPosition();
    }
  }

  _clearElementOverlay(element) {
    const layer = this._ceOverlayHighlights.get(element);
    if (layer) {
      layer.highlights?.forEach((hl) => hl.remove());
      layer.root?.remove?.();
      this._ceOverlayHighlights.delete(element);
      if (this.activeRevealState?.element === element) {
        this.hideRevealOverlay();
      }
    }
    clearTimeout(this._ceOverlayTimers.get(element));
    this._ceOverlayTimers.delete(element);
  }

  _refreshAllOverlays() {
    this.redactions.forEach((state, element) => {
      if (!element?.isConnected || !this.isContentEditableElement(element)) {
        this._clearElementOverlay(element);
        return;
      }
      if (!state?.items?.length) {
        this._clearElementOverlay(element);
        return;
      }
      this._updateElementOverlay(element);
    });
  }

  _getOrCreateOverlayLayer(element) {
    let layer = this._ceOverlayHighlights.get(element);
    if (layer?.root?.isConnected && layer.highlights instanceof Map) {
      return layer;
    }

    const root = document.createElement('div');
    root.className = 'ps-overlay-hl-layer';
    root.style.cssText = [
      'position:fixed',
      'inset:0',
      'pointer-events:none',
      'z-index:2147483090',
    ].join(';');
    document.body.appendChild(root);

    layer = {
      root,
      highlights: new Map(),
    };
    this._ceOverlayHighlights.set(element, layer);
    return layer;
  }

  _createOverlayHighlightNode(element, itemIndex) {
    const hl = document.createElement('div');
    hl.className = 'ps-overlay-hl';
    hl.dataset.itemIndex = String(itemIndex);
    hl.style.pointerEvents = 'auto';
    hl.style.position = 'absolute';

    hl.addEventListener('mouseenter', () => {
      const index = Number(hl.dataset.itemIndex);
      if (!Number.isInteger(index)) return;
      const anchorRect = hl.getBoundingClientRect();
      const item = this.redactions.get(element)?.items?.[index];
      if (item && !item.redacted) {
        // Pre-redaction highlight → explanatory popover (U2).
        this.beginPopoverHover({ element, itemIndex: index, anchorRect });
      } else {
        this.beginRevealHover({
          element,
          itemIndex: index,
          anchorRect,
          typographySource: element,
          anchorKey: hl.dataset.overlayKey || null,
        });
      }
    });
    hl.addEventListener('mouseleave', (event) => {
      const index = Number(hl.dataset.itemIndex);
      const idx = Number.isInteger(index) ? index : null;
      const item = idx != null ? this.redactions.get(element)?.items?.[idx] : null;
      if (item && !item.redacted) {
        this.cancelPopoverOpen();
        if (!this.shouldKeepPopoverOpen(event.relatedTarget, element, idx)) this.schedulePopoverHide();
        return;
      }
      if (this.shouldKeepRevealOpen(event.relatedTarget, element, idx)) {
        return;
      }
      this.scheduleRevealHide();
    });
    hl.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const index = Number(hl.dataset.itemIndex);
      if (!Number.isInteger(index)) return;
      this.hideRevealOverlay();
      const item = this.redactions.get(element)?.items?.[index];
      if (item?.redacted) {
        this.toggleRedaction(element, index);
      } else {
        this.redactSingle(element, index);
      }
    });

    return hl;
  }

  // Walk text nodes in element to build a Range for character offsets [start, end].
  _getTextNodeRange(element, start, end) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let charCount = 0;
    let startNode = null, startOff = 0, endNode = null, endOff = 0;
    let node;

    while ((node = walker.nextNode())) {
      const len = node.textContent.length;

      if (!startNode && charCount + len > start) {
        startNode = node;
        startOff = start - charCount;
      }
      if (startNode && charCount + len >= end) {
        endNode = node;
        endOff = end - charCount;
        break;
      }
      charCount += len;
    }

    if (!startNode || !endNode) return null;
    try {
      const range = document.createRange();
      range.setStart(startNode, Math.min(startOff, startNode.textContent.length));
      range.setEnd(endNode, Math.min(endOff, endNode.textContent.length));
      return range;
    } catch { return null; }
  }

  // Walk text nodes to find the first occurrence of tokenText and return its Range.
  _getTokenRange(element, tokenText) {
    if (!tokenText) return null;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;

    while ((node = walker.nextNode())) {
      const idx = node.textContent.indexOf(tokenText);
      if (idx !== -1) {
        try {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + tokenText.length);
          return range;
        } catch { return null; }
      }
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  // Single-item Actions
  // ═══════════════════════════════════════════════════════════

  redactSingle(element, index) {
    const state = this.redactions.get(element);
    if (!state || !state.items[index]) return;

    const wasRedacted = state.items[index].redacted;
    state.items[index].redacted = true;
    state.items[index].reviewed = true;
    state.items[index].userRestored = false;  // User chose to re-redact
    if (!wasRedacted) this._recordRedactionStat(state.items[index].label);

    this.rememberResponseRestoreMappings(state);
    this.renderElement(element, index);
    this.persistCache(element);
    if (state.mode === 'mask') {
      void this.showMaskModeHintOnce();
    }
  }

  restoreSingle(element, index) {
    const state = this.redactions.get(element);
    if (!state || !state.items[index]) return;

    state.items[index].redacted = false;
    state.items[index].reviewed = true;
    state.items[index].userRestored = true;  // Protect from auto-re-redaction

    // Cancel any pending auto-redact so it doesn't override this restore
    this.cancelAutoRedact(element);

    this.renderElement(element, index);
    this.persistCache(element);
  }

  dismissDetection(element, index) {
    const state = this.redactions.get(element);
    if (!state || !state.items[index]) return;

    const item = state.items[index];
    const key = `${item.start}:${item.end}:${item.label}`;

    if (!this.dismissedDetections.has(element)) {
      this.dismissedDetections.set(element, new Set());
    }
    this.dismissedDetections.get(element).add(key);

    // Remove this item from state
    state.items.splice(index, 1);

    if (state.items.length === 0) {
      this.clearElementState(element);
    } else {
      this.renderElement(element);
    }
  }

  toggleRedaction(element, index) {
    const state = this.redactions.get(element);
    if (!state || !state.items[index]) return;

    const wasRedacted = state.items[index].redacted;
    state.items[index].redacted = !wasRedacted;
    state.items[index].reviewed = true;
    // If user is restoring, mark as user-restored; if re-redacting, clear the flag
    state.items[index].userRestored = wasRedacted ? true : false;

    if (wasRedacted) {
      this.cancelAutoRedact(element);
    } else {
      this.rememberResponseRestoreMappings(state);
      this._recordRedactionStat(state.items[index].label);
    }

    this.renderElement(element, index);
    this.persistCache(element);
  }

  // ═══════════════════════════════════════════════════════════
  // Token Tray (for input/textarea elements)
  // ═══════════════════════════════════════════════════════════

  summarizeTokenText(text, maxLength = 26) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    if (raw.length <= maxLength) return raw;
    return `${raw.slice(0, Math.max(8, maxLength - 1))}…`;
  }

  renderTokenTray(element, state) {
    let tray = this.tokenTrays.get(element);
    if (!tray) {
      tray = document.createElement('div');
      tray.className = 'ps-token-tray';
      document.body.appendChild(tray);
      this.tokenTrays.set(element, tray);
    }

    tray.innerHTML = '';
    state.items.forEach((item, index) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `ps-token-chip ${item.redacted ? 'is-redacted' : 'is-restored'}`;
      chip.style.setProperty('--chip-color', this.getTypeColor(item.label));
      chip.textContent = this.summarizeTokenText(item.text);
      chip.title = item.redacted ? 'Click to restore' : 'Click to re-redact';
      // Action + type for screen readers (avoid reading the raw value as the name).
      chip.setAttribute('aria-label', `${item.redacted ? 'Restore' : 'Re-redact'} ${this.formatLabel(item.label)}`);
      chip.addEventListener('click', () => this.toggleRedaction(element, index));
      tray.appendChild(chip);
    });

    this.positionTokenTray(element, tray);
  }

  positionTokenTray(element, tray) {
    const rect = element.getBoundingClientRect();
    // Skip elements that aren't actually visible (hidden duplicates, zero-size ghosts)
    if (rect.width < 50 || rect.height < 10) return;
    // Tray is position:fixed — use viewport coordinates directly (no scroll offset)
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < 80) {
      // Not enough room below — show above the element instead
      tray.style.bottom = `${window.innerHeight - rect.top + 6}px`;
      tray.style.top = 'auto';
    } else {
      tray.style.top = `${rect.bottom + 6}px`;
      tray.style.bottom = 'auto';
    }
    tray.style.left = `${rect.left}px`;
    tray.style.maxWidth = `${Math.max(220, rect.width)}px`;
    tray.classList.add('ps-token-tray-visible');
    requestAnimationFrame(() => {
      const maxLeft = window.innerWidth - tray.offsetWidth - 8;
      if (parseFloat(tray.style.left) > maxLeft) tray.style.left = `${Math.max(8, maxLeft)}px`;
    });
  }

  repositionTokenTrays() {
    this.tokenTrays.forEach((tray, element) => {
      if (!document.body.contains(element)) {
        this.removeTokenTray(element);
        return;
      }
      this.positionTokenTray(element, tray);
    });
  }

  removeTokenTray(element) {
    const tray = this.tokenTrays.get(element);
    if (!tray) return;
    tray.remove();
    this.tokenTrays.delete(element);
  }

  // ═══════════════════════════════════════════════════════════
  // localStorage / chrome.storage.local Cache
  // ═══════════════════════════════════════════════════════════

  getCacheKey(element) {
    const host = window.location.hostname;
    const id = this.getElementId(element);
    const state = this.redactions.get(element);
    const textHash = this.hashString(state?.sourceText || '');
    return `ps::${host}::${id}::${textHash}`;
  }

  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + ch;
      hash |= 0;
    }
    return hash.toString(36);
  }

  persistCache(element) {
    try {
      const state = this.redactions.get(element);
      if (!state) return;

      const key = this.getCacheKey(element);
      const payload = {
        timestamp: Date.now(),
        sourceText: state.sourceText,
        mode: state.mode,
        items: state.items.map((i) => ({
          label: i.label,
          text: i.text,
          start: i.start,
          end: i.end,
          alias: i.alias,
          anonymizedText: i.anonymizedText || null,
          replacement: i.replacement,
          redacted: i.redacted,
          reviewed: i.reviewed,
          userRestored: i.userRestored || false,
          score: i.score
        }))
      };

      chrome.storage.local.set({ [key]: payload });
    } catch (e) {
      console.error('[AI-Safe Plugin] cache persist error:', e);
    }
  }

  async rehydrateCachedRedactions() {
    try {
      const allData = await new Promise((resolve) => chrome.storage.local.get(null, resolve));
      const now = Date.now();
      const keysToRemove = [];

      Object.entries(allData).forEach(([key, value]) => {
        if (!key.startsWith('ps::')) return;
        if (!value?.timestamp || (now - value.timestamp) > CACHE_TTL_MS) {
          keysToRemove.push(key);
        }
      });

      if (keysToRemove.length > 0) {
        chrome.storage.local.remove(keysToRemove);
      }
    } catch (e) {
      console.error('[AI-Safe Plugin] cache rehydration error:', e);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Utility Helpers
  // ═══════════════════════════════════════════════════════════

  withSuppressedInput(element, updateFn) {
    this.suppressedInput.add(element);
    updateFn();
    setTimeout(() => this.suppressedInput.delete(element), SUPPRESS_INPUT_MS);
  }

  playCommitAnimation(element) {
    // Disabled intentionally: the commit animation feels noisy and can make
    // repeated reflows more noticeable on chat composer UIs.
    return;
  }

  clearElementState(element) {
    const priorState = this.redactions.get(element);
    this.rememberResponseRestoreMappings(priorState);
    this.clearHighlights(element);
    this._clearElementOverlay(element);
    if (this.activeRevealState?.element === element) {
      this.hideRevealOverlay();
    }
    this.redactions.delete(element);
    this.lastDetectionSignature.delete(element);
    this.lastAnalyzedSnapshot.delete(element);
    this.cancelPostInteractionCleanup(element);
    element.classList.remove('ps-awaiting-idle', 'ps-analyzing', 'ps-redaction-commit');
    this.removeTokenTray(element);
    this.hideFieldPanel(element);
    this.hideFieldBadge(element);
    this.cancelAutoRedact(element);

    // Strip injected PII spans from contenteditable elements to avoid visual artifacts
    if (this.isContentEditableElement(element) && element.isConnected) {
      const spans = element.querySelectorAll('.ps-pii-underline, .ps-redaction');
      if (spans.length > 0) {
        this.withSuppressedInput(element, () => {
          spans.forEach((span) => {
            const original = span.getAttribute('data-ps-original') || span.textContent || '';
            span.replaceWith(document.createTextNode(original));
          });
        });
      }
    }
  }

  clearHighlights(element) {
    const elementId = this.getElementId(element);
    document.querySelectorAll(`.ps-highlight[data-element-id="${elementId}"]`).forEach((node) => {
      node.classList.remove('ps-visible');
      setTimeout(() => node.remove(), 220);
    });
  }

  hasUnreviewedRedactions(element) {
    const state = this.redactions.get(element);
    if (!state) return false;
    return state.items.some((item) => item.redacted && !item.reviewed);
  }

  getElementId(element) {
    if (!element.dataset.psId) {
      element.dataset.psId = `ps-${Math.random().toString(36).slice(2, 11)}`;
    }
    return element.dataset.psId;
  }

  getTypeColor(type) {
    const palette = {
      person: '#D32F2F',
      email: '#0288D1',
      phone: '#00796B',
      address: '#EF6C00',
      ssn: '#C2185B',
      credit_card: '#5D4037',
      date_of_birth: '#8E24AA',
      location: '#2E7D32',
      organization: '#3949AB',
      api_key: '#6A1B9A',
      ip_address: '#546E7A',
      jwt: '#8D6E63',
      pan: '#00897B',
      aadhaar: '#5E35B1',
      passport: '#6D4C41',
      ifsc: '#455A64',
      driver_license: '#AD1457',
      bank_account: '#33691E',
      oauth_token: '#7B1FA2',
      mac_address: '#1565C0',
      employee_id: '#6A1B1A',
      device_id: '#2E7D32',
      session_id: '#5D4037'
    };
    return palette[type] || '#546E7A';
  }

  formatLabel(label) {
    return String(label || 'PII')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  updateStats(detections, redactions) {
    this.pageStats = {
      detections: this.pageStats.detections + (Number(detections) || 0),
      redactions: this.pageStats.redactions + (Number(redactions) || 0)
    };
  }

  // ── Durable privacy stats (U7) ────────────────────────────────────────────
  // Accumulate redaction counts in memory and flush them (debounced) into
  // chrome.storage.local under STATS_STORAGE_KEY. Counts only — never the
  // detected value or the site. A redactAll burst becomes a single write.
  _recordRedactionStat(label, n = 1) {
    const inc = Number(n) || 0;
    if (inc <= 0) return;
    if (!this._statDeltas) this._statDeltas = { total: 0, byLabel: {} };
    const key = String(label || 'unknown');
    this._statDeltas.total += inc;
    this._statDeltas.byLabel[key] = (this._statDeltas.byLabel[key] || 0) + inc;

    clearTimeout(this._statFlushTimer);
    this._statFlushTimer = setTimeout(() => this._flushRedactionStats(), 800);
  }

  _flushRedactionStats() {
    const deltas = this._statDeltas;
    if (!deltas || deltas.total <= 0) return;
    this._statDeltas = { total: 0, byLabel: {} };
    const weekKey = isoWeekKey();
    try {
      chrome.storage.local.get([STATS_STORAGE_KEY], (data) => {
        let stats = data?.[STATS_STORAGE_KEY];
        for (const [label, count] of Object.entries(deltas.byLabel)) {
          stats = mergeRedactionStats(stats, label, weekKey, count);
        }
        chrome.storage.local.set({ [STATS_STORAGE_KEY]: stats });
      });
    } catch { /* context invalidated — non-fatal */ }
  }

  computeLiveStats() {
    let detections = 0;
    let redactions = 0;

    this.redactions.forEach((state) => {
      if (!state || !Array.isArray(state.items)) return;
      state.items.forEach((item) => {
        if (!item) return;
        detections += 1;
        if (item.redacted) {
          redactions += 1;
        }
      });
    });

    return { detections, redactions };
  }

  // ── Toolbar-icon badge (U1) ───────────────────────────────────────────────
  // Push live page counts to the background worker, which renders an amber count
  // / green check on the extension icon. Throttled to ≤1/sec with a trailing
  // call; top-frame only (matches getPageStats) so iframes don't fight the badge.
  scheduleToolbarStatsPush() {
    if (window !== window.top) return;
    const now = Date.now();
    const since = now - this._toolbarStatsLast;
    if (since >= 1000) {
      this._toolbarStatsLast = now;
      this._sendToolbarStats();
    } else if (!this._toolbarStatsTimer) {
      this._toolbarStatsTimer = setTimeout(() => {
        this._toolbarStatsTimer = null;
        this._toolbarStatsLast = Date.now();
        this._sendToolbarStats();
      }, 1000 - since);
    }
  }

  _sendToolbarStats() {
    const { detections, redactions } = this.computeLiveStats();
    try {
      chrome.runtime.sendMessage({
        action: 'aiSafePluginStatsPush',
        detected: detections,
        protected: redactions
      }).catch(() => { /* SW asleep / no receiver — non-fatal */ });
    } catch { /* context invalidated — non-fatal */ }
  }

  handleRuntimeMessage(request, _sender, sendResponse) {
    if (request?.action === 'serverCrashed') {
      this.modelOffline = true;
      this.fieldBadges.forEach((_, el) => this.updateFieldBadge(el, this.redactions.get(el)));
      this.showNotification('GLiNER2 server offline — using regex fallback.', 'warning');
      // Reset detector mode so next detection triggers a re-check
      try { chrome.runtime.sendMessage({ action: 'initialize' }).catch(() => { }); } catch { }
      return false;
    }

    if (request?.action === 'serverRestored') {
      this.modelOffline = false;
      this.fieldBadges.forEach((_, el) => this.updateFieldBadge(el, this.redactions.get(el)));
      this.showNotification('Local model back online — full AI detection active.', 'info');
      try { chrome.runtime.sendMessage({ action: 'initialize' }).catch(() => { }); } catch { }
      return false;
    }

    if (request?.action === 'commandRedactAll') {
      sendResponse(this.handleCommandRedactAll());
      return false;
    }

    if (request?.action === 'commandToggleSite') {
      this.handleCommandToggleSite()
        .then((response) => sendResponse(response))
        .catch((error) => sendResponse({ success: false, error: error?.message || 'Toggle failed.' }));
      return true;
    }

    if (request?.action !== 'getPageStats') return false;
    if (window !== window.top) return false;
    const redactionKeyMap = this.buildVisibleRedactionKey();
    const redactionKey = redactionKeyMap.size
      ? Object.fromEntries([...redactionKeyMap])
      : null;
    // Use cumulative pageStats so counts survive element cleanup (e.g. after
    // the chat app clears the input field on submit).  Fall back to live
    // stats when the cumulative counters haven't been populated yet.
    const liveStats = this.computeLiveStats();
    const stats = {
      detections: Math.max(this.pageStats.detections, liveStats.detections),
      redactions: Math.max(this.pageStats.redactions, liveStats.redactions)
    };
    sendResponse({
      success: true,
      stats,
      redactionKey
    });
    return false;
  }

  async showMaskModeHintOnce() {
    if (this.maskModeHintChecked) return;
    this.maskModeHintChecked = true;

    const result = await new Promise((resolve) => {
      chrome.storage.local.get([MASK_MODE_HINT_STORAGE_KEY], resolve);
    });
    if (result?.[MASK_MODE_HINT_STORAGE_KEY]) return;

    chrome.storage.local.set({ [MASK_MODE_HINT_STORAGE_KEY]: true });
    this.showNotification(
      'Mask mode replaces sensitive text with [TYPE REDACTED] tags. For more natural replacements later, switch to Anonymize in AI-Safe Plugin settings.',
      'info',
      3600
    );
  }

  // Visually-hidden, persistent ARIA live region (U8). Created once; updating its
  // text makes screen readers announce status changes (e.g. "3 items protected").
  _ensureAriaLive() {
    if (this._ariaLive && this._ariaLive.isConnected) return this._ariaLive;
    const region = document.createElement('div');
    region.className = 'ps-sr-only';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
    this._ariaLive = region;
    return region;
  }

  announce(message) {
    const region = this._ensureAriaLive();
    region.textContent = '';
    // Re-set on the next frame so repeated identical messages still announce.
    requestAnimationFrame(() => { region.textContent = String(message || ''); });
  }

  showNotification(message, type = 'info', durationMs = 1900) {
    const toast = document.createElement('div');
    toast.className = `ps-notification ps-notification-${type}`;
    // The toast is purely visual; the persistent live region does the announcing
    // (below), so screen readers hear it exactly once.
    toast.setAttribute('aria-hidden', 'true');
    const inner = document.createElement('div');
    inner.className = 'ps-notification-message';
    inner.textContent = message;
    toast.appendChild(inner);

    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('ps-notification-visible'));

    this.announce(message);

    setTimeout(() => {
      toast.classList.remove('ps-notification-visible');
      setTimeout(() => toast.remove(), 260);
    }, durationMs);
  }

  // ═══════════════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════════════

  stopMonitoring() {
    this.isEnabled = false;
    this.monitoredElements.forEach((listeners, element) => {
      element.removeEventListener('input', listeners.handleInput);
      element.removeEventListener('paste', listeners.handlePaste);
      element.removeEventListener('focus', listeners.handleFocus);
      element.removeEventListener('blur', listeners.handleBlur);
      element.removeEventListener('keydown', listeners.handleKeydown);
      element.removeEventListener('compositionstart', listeners.handleCompositionStart);
      element.removeEventListener('compositionend', listeners.handleCompositionEnd);
      if (listeners.form && listeners.handleSubmit) {
        listeners.form.removeEventListener('submit', listeners.handleSubmit);
      }
      if (listeners.handleAnchoredScroll) {
        listeners.scrollRoots?.forEach((root) => {
          root.removeEventListener('scroll', listeners.handleAnchoredScroll);
          this.resizeObserver?.unobserve(root);
        });
      }
      this.resizeObserver?.unobserve(element);
      this.clearElementState(element);
    });

    this.monitoredElements.clear();
    this.redactions.clear();
    this.inputRevisions.clear();
    this.lastAnalyzedSnapshot.clear();
    this.lastDetectionSignature.clear();
    this.postInteractionTimers.forEach((timers) => {
      timers.forEach((timer) => clearTimeout(timer));
    });
    this.postInteractionTimers.clear();

    this.debounceTimers.forEach((timer) => clearTimeout(timer));
    this.debounceTimers.clear();

    this.autoRedactTimers.forEach((timer) => clearTimeout(timer));
    this.autoRedactTimers.clear();

    this.fieldBadges.forEach((badge) => {
      if (badge?._hideTimer) clearTimeout(badge._hideTimer);
      badge?.remove?.();
    });
    this.fieldBadges.clear();
    this.fieldPanels.forEach((panel) => {
      if (panel?._outsideClickHandler) {
        document.removeEventListener('mousedown', panel._outsideClickHandler, true);
      }
      if (panel?._escHandler) {
        document.removeEventListener('keydown', panel._escHandler, true);
      }
      panel?.remove?.();
    });
    this.fieldPanels.clear();
    this.badgeBlurTimers.forEach((timer) => clearTimeout(timer));
    this.badgeBlurTimers.clear();
    this.focusedElements.clear();

    this.hidePopover();
    this.hideRevealOverlay();

    if (this.domObserver) {
      this.domObserver.disconnect();
      this.domObserver = null;
    }
    if (this.stateReconcileTimer) {
      clearInterval(this.stateReconcileTimer);
      this.stateReconcileTimer = null;
    }
    if (this._pollingInterval) {
      clearInterval(this._pollingInterval);
      this._pollingInterval = null;
    }
    if (this.responseRestoreTimer) {
      clearTimeout(this.responseRestoreTimer);
      this.responseRestoreTimer = 0;
    }

    window.removeEventListener('scroll', this.handleViewportChange, true);
    window.removeEventListener('resize', this.handleViewportChange);

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }

    if (this.anchoredUiRefreshRaf) {
      cancelAnimationFrame(this.anchoredUiRefreshRaf);
      this.anchoredUiRefreshRaf = 0;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Per-Site Persistent Memory
  // ═══════════════════════════════════════════════════════════

  getSiteAliasKey() {
    return `ai_safe_plugin::aliases::${location.hostname}`;
  }

  getSiteRedactCountKey() {
    return `ai_safe_plugin::redactCount::${location.hostname}`;
  }

  async loadSiteAliasLedger() {
    const key = this.getSiteAliasKey();
    const countKey = this.getSiteRedactCountKey();
    try {
      const data = await new Promise((resolve) => chrome.storage.local.get([key, countKey], resolve));
      const stored = data[key];
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      if (stored && stored.updatedAt && (Date.now() - stored.updatedAt) < thirtyDays) {
        this.siteAliasCache = {
          aliases: stored.aliases || {},
          counters: stored.counters || {},
          maskCounters: stored.maskCounters || {}
        };
      }
      this.siteRedactCount = Number(data[countKey] || 0);
    } catch { /* non-fatal */ }
  }

  persistSiteAliasLedger() {
    // Debounce writes — alias allocations happen in bursts during detection
    clearTimeout(this.siteAliasPersistTimer);
    this.siteAliasPersistTimer = setTimeout(() => {
      const key = this.getSiteAliasKey();
      chrome.storage.local.set({
        [key]: { ...this.siteAliasCache, updatedAt: Date.now() }
      });
    }, 1000);
  }

  // ── Persistent per-site ignore list (U3) ──────────────────────────────────
  // Values the user chose to "Ignore on this site" so AI-Safe Plugin stops flagging them
  // across reloads. Stored per host with a 90-day TTL and FIFO cap.

  getSiteIgnoredKey() {
    return `ai_safe_plugin::ignored::${location.hostname}`;
  }

  async loadSiteIgnoredValues() {
    this.siteIgnoredValues = new Map(); // label → Set<value> (exact, trimmed)
    this._siteIgnoredEntries = [];      // [{ value, label, addedAt }] (load-prune-persist)
    const key = this.getSiteIgnoredKey();
    try {
      const data = await new Promise((resolve) => chrome.storage.local.get([key], resolve));
      const stored = data[key];
      let entries = Array.isArray(stored?.entries) ? stored.entries : [];
      const before = entries.length;
      entries = capFifo(pruneIgnoredByTtl(entries, IGNORED_VALUES_TTL_MS), IGNORED_VALUES_MAX_PER_SITE);
      this._siteIgnoredEntries = entries;
      for (const e of entries) {
        if (!e || typeof e.value !== 'string' || typeof e.label !== 'string') continue;
        this._addToIgnoredMap(e.label, e.value);
      }
      if (entries.length !== before) this.persistSiteIgnoredValues(); // write back the prune
    } catch { /* non-fatal */ }
  }

  _addToIgnoredMap(label, value) {
    const v = String(value || '').trim();
    if (!v) return;
    if (!this.siteIgnoredValues.has(label)) this.siteIgnoredValues.set(label, new Set());
    this.siteIgnoredValues.get(label).add(v);
  }

  isValueIgnored(label, text) {
    const set = this.siteIgnoredValues?.get(label);
    return Boolean(set && set.has(String(text || '').trim()));
  }

  persistSiteIgnoredValues() {
    clearTimeout(this._siteIgnoredPersistTimer);
    this._siteIgnoredPersistTimer = setTimeout(() => {
      const key = this.getSiteIgnoredKey();
      chrome.storage.local.set({
        [key]: { entries: this._siteIgnoredEntries, updatedAt: Date.now() }
      });
    }, 600);
  }

  // Add a detection's (label, value) to the per-site ignore list, then dismiss it.
  // High-risk labels are never ignorable.
  ignoreDetectionValue(element, index) {
    const item = this.redactions.get(element)?.items?.[index];
    if (!item || HIGH_RISK_LABELS.includes(item.label)) return;
    const value = String(item.text || '').trim();
    if (value && !this.isValueIgnored(item.label, value)) {
      this._addToIgnoredMap(item.label, value);
      this._siteIgnoredEntries.push({ value, label: item.label, addedAt: Date.now() });
      this._siteIgnoredEntries = capFifo(this._siteIgnoredEntries, IGNORED_VALUES_MAX_PER_SITE);
      this.persistSiteIgnoredValues();
    }
    this.dismissDetection(element, index);
  }

  canIgnoreLabel(label) {
    return !HIGH_RISK_LABELS.includes(label);
  }

  // Build the popup/settings redaction key from currently active AI-Safe Plugin states only.
  // AI-Safe Plugin must never rewrite provider-owned thread history with original values.
  buildVisibleRedactionKey() {
    // Start with persisted ledger so entries survive after the chat app
    // clears the input field on submit.
    const map = new Map(this.responseRestoreLedger);
    this.redactions.forEach((state) => {
      if (!state?.items?.length) return;
      state.items.forEach((item) => {
        if (!item?.redacted) return;
        const replacement = this.getReplacementText(item, state.mode);
        const original = String(item.text || '').trim();
        if (!replacement || !original || replacement === original) return;
        if (isStaticRedactionToken(replacement)) return;
        if (!map.has(replacement)) map.set(replacement, original);
      });
    });
    return map;
  }

  buildRedactionKey() {
    const map = new Map(this.responseRestoreLedger);
    this.redactions.forEach((state) => {
      if (!state?.items?.length) return;
      state.items.forEach((item) => {
        if (!item?.redacted) return;
        const replacement = this.getReplacementText(item, state.mode);
        const original = String(item.text || '').trim();
        if (!replacement || !original || replacement === original) return;
        if (isStaticRedactionToken(replacement)) return;
        if (!map.has(replacement)) map.set(replacement, original);
      });
    });
    return map;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new AiSafePluginContentController());
} else {
  new AiSafePluginContentController();
}
