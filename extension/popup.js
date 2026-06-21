// popup.js - Claude-like compact settings UI + server controls

const {
  DEFAULT_CUSTOM_PATTERNS,
  PATTERN_NAMES,
  cloneDefaultCustomPatterns,
  normalizeCustomPatterns,
  normalizeSiteHost,
  isoWeekKey,
  SYNCED_SETTING_KEYS,
  chunkForSync
} = globalThis.AI_SAFE_PLUGIN_PATTERN_CATALOG;

// Array-valued synced keys that may exceed chrome.storage.sync's per-item quota
// and are therefore stored chunked (<key>__count + <key>__chunkN).
const SYNC_CHUNKED_KEYS = ['customPatterns', 'customEntityTypes'];
const DEFAULT_SERVER_MODEL = 'fastino/gliner2-large-v1';
const SITE_SNOOZE_MS = 60 * 60 * 1000;
const MODEL_SELECTION_ALIASES = {
  'fastino/gliner2-base-v1': DEFAULT_SERVER_MODEL
};
const AI_SAFE_PLUGIN_RELEASE_REPO_SLUG = 'Maya-Data-Privacy/AI-Safe-Plugin';
const AI_SAFE_PLUGIN_RELEASE_BASE_URL = `https://github.com/${AI_SAFE_PLUGIN_RELEASE_REPO_SLUG}/releases/latest/download`;
const AI_SAFE_PLUGIN_RELEASE_PAGE_URL = `https://github.com/${AI_SAFE_PLUGIN_RELEASE_REPO_SLUG}/releases`;
const AI_SAFE_PLUGIN_RELEASE_API_URL = `https://api.github.com/repos/${AI_SAFE_PLUGIN_RELEASE_REPO_SLUG}/releases/latest`;

function normalizeSelectedModel(modelId) {
  const raw = String(modelId || '').trim();
  if (!raw) return DEFAULT_SERVER_MODEL;
  return MODEL_SELECTION_ALIASES[raw] || raw;
}

const DEFAULT_SETTINGS = {
  enabled: true,
  autoRedact: true,
  redactionMode: 'mask',
  maskModeHintSeen: false,
  sensitivity: 'medium',
  includeRegexWhenModelOnline: true,
  monitorAllSites: true,
  enabledTypes: [
    'person',
    'email',
    'phone',
    'address',
    'ssn',
    'credit_card',
    'date_of_birth',
    'location',
    'organization'
  ],
  monitoredSites: [
    'chatgpt.com',
    'chat.openai.com',
    'claude.ai',
    'gemini.google.com',
    'copilot.microsoft.com',
    'perplexity.ai',
    'grok.com',
    'x.ai',
    'chat.deepseek.com',
    'chat.mistral.ai',
    'poe.com',
    'character.ai',
    'pi.ai',
    'you.com',
    'meta.ai',
    'chat.qwen.ai',
    'chat.qwenlm.ai',
    'duck.ai',
    'huggingface.co',
    'phind.com',
    't3.chat'
  ],
  monitoredSelectors: [
    'textarea',
    'input[type="text"]',
    'input[type="search"]',
    'input[type="email"]',
    'input:not([type])',
    'div[contenteditable="true"]',
    '[role="textbox"]',
    '.ProseMirror'
  ],
  customPatterns: cloneDefaultCustomPatterns(),
  customEntityTypes: [],
  excludedSites: [],
  siteSnoozes: {}
};

class SettingsManager {
  constructor() {
    this.settings = {};
    this.stats = { detections: 0, redactions: 0 };
    this.localSecrets = {
      hfToken: '',
      aiSafePluginApiKey: ''
    };
    this.selectedModel = DEFAULT_SERVER_MODEL;
    this.platformOs = '';
    this.apiKeyRevealed = false;
    this.hfTokenVisible = false;
    this.keyExpanded = false;
    this.serverBusy = false;
    this.serverPhase = 'disconnected';
    this.terminalVisible = false;
    this.serverToolsActivePanel = 'hfToken';
    this.currentSiteHost = '';
    this.siteCountdownTimer = null;
    this.serverState = {
      known: false,
      installed: true,
      running: false,
      healthy: false,
      pid: null,
      portConflict: false
    };
    this.serverMeta = this.getDefaultServerMeta();
    this.releaseInfo = this.getDefaultReleaseInfo();
    this.serverPollTimer = null;
    this.statsPollTimer = null;
    this.messageTimer = null;
    this.copyButtonTimers = new Map();
    this._initPromise = this.init();
  }

  async init() {
    // Open as full-page settings tab when ?tab=1 is in the URL
    if (location.search.includes('tab=1')) {
      document.body.classList.add('full-page');
    }
    await this.loadSettings();
    await this.loadActiveSite();
    await this.loadLocalSecrets();
    await this.loadPlatformInfo();
    this.bindEvents();
    const manifest = chrome.runtime.getManifest();
    const versionEl = document.getElementById('versionBadge');
    if (versionEl && manifest?.version) {
      versionEl.textContent = `v${manifest.version}`;
    }
    this.initBetaBanner();
    this.render();
    await this.loadPageStats();
    await this.refreshServerStatus();
    await this.refreshReleaseInfo({ silent: true });
    await this.refreshServerLogs({ silent: true });
    this.startServerPolling();
    this.startStatsPolling();
    this.wizard = null; // set by OnboardingWizard after construction
  }

  // Product-stage beta banner: shown until the user dismisses it (remembered
  // locally). When the product graduates out of beta, delete the banner markup
  // and this method.
  initBetaBanner() {
    const banner = document.getElementById('betaBanner');
    if (!banner) return;
    const closeBtn = document.getElementById('betaBannerClose');
    chrome.storage.local.get('betaBannerDismissed', (result) => {
      if (result && result.betaBannerDismissed) {
        banner.hidden = true;
      }
    });
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        banner.hidden = true;
        chrome.storage.local.set({ betaBannerDismissed: true });
      });
    }
  }

  loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS), (result) => {
        this.settings = {
          ...DEFAULT_SETTINGS,
          ...result
        };
        this.settings.customPatterns = normalizeCustomPatterns(this.settings.customPatterns, cloneDefaultCustomPatterns());
        this.settings.excludedSites = this.normalizeSiteList(this.settings.excludedSites);
        this.settings.siteSnoozes = this.pruneSiteSnoozes(this.settings.siteSnoozes);
        resolve();
      });
    });
  }

  normalizeSiteList(sites) {
    if (!Array.isArray(sites)) return [];
    return [...new Set(sites.map((site) => normalizeSiteHost(site)).filter(Boolean))];
  }

  pruneSiteSnoozes(siteSnoozes) {
    const source = siteSnoozes && typeof siteSnoozes === 'object' ? siteSnoozes : {};
    const now = Date.now();
    const pruned = {};
    let changed = false;
    Object.entries(source).forEach(([site, until]) => {
      const host = normalizeSiteHost(site);
      const untilMs = Number(until) || 0;
      if (!host || untilMs <= now) {
        changed = true;
        return;
      }
      pruned[host] = untilMs;
      if (host !== site) changed = true;
    });
    if (changed) {
      chrome.storage.local.set({ siteSnoozes: pruned });
    }
    return pruned;
  }

  isPageUrl(url) {
    try {
      const parsed = new URL(url || '');
      return ['http:', 'https:', 'file:'].includes(parsed.protocol);
    } catch {
      return false;
    }
  }

  async getActiveTab() {
    const activeTab = await new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(tabs?.[0] || null);
      });
    });
    if (activeTab?.url && this.isPageUrl(activeTab.url)) return activeTab;

    return new Promise((resolve) => {
      chrome.tabs.query({ currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve((tabs || []).find((tab) => this.isPageUrl(tab.url)) || null);
      });
    });
  }

  async loadActiveSite() {
    const tab = await this.getActiveTab();
    this.currentSiteHost = normalizeSiteHost(tab?.url);
  }

  async getActiveTabId() {
    const tab = await this.getActiveTab();
    return typeof tab?.id === 'number' ? tab.id : null;
  }

  async loadPageStats() {
    const tabId = await this.getActiveTabId();
    if (typeof tabId !== 'number') {
      this.stats = { detections: 0, redactions: 0 };
      this.renderStats();
      return;
    }

    const response = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: 'getPageStats' }, (message) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false });
          return;
        }
        resolve(message || { success: false });
      });
    });

    if (response?.success && response.stats) {
      this._pageActive = true;
      this.stats = {
        detections: Number(response.stats.detections) || 0,
        redactions: Number(response.stats.redactions) || 0
      };
    } else {
      this._pageActive = false;
      this.stats = { detections: 0, redactions: 0 };
    }

    this.renderStats();
    this.renderRedactionKey(response?.redactionKey ?? null);
  }

  renderRedactionKey(key) {
    const card = document.getElementById('redactionKeyCard');
    const list = document.getElementById('redactionKeyList');
    const toggle = document.getElementById('redactionKeyToggle');
    if (!card || !list || !toggle) return;

    if (!key || Object.keys(key).length === 0) {
      // Show a hint when items are detected but nothing is redacted yet
      if (this.stats.detections > 0 && this.stats.redactions === 0) {
        card.hidden = false;
        list.innerHTML = '<div class="key-hint" style="padding:8px 0;color:#79747E;font-size:12px;">'
          + `${this.stats.detections} item(s) detected \u2014 click items in the input or enable auto-redact to protect them.`
          + '</div>';
        list.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
        return;
      }
      card.hidden = true;
      return;
    }

    // Wire toggle once
    if (!toggle._aiSafePluginBound) {
      toggle._aiSafePluginBound = true;
      toggle.addEventListener('click', () => {
        this.keyExpanded = !this.keyExpanded;
        toggle.setAttribute('aria-expanded', String(this.keyExpanded));
        list.hidden = !this.keyExpanded;
      });
    }

    // Rebuild list content
    list.innerHTML = '';
    Object.entries(key).forEach(([token, original]) => {
      const row = document.createElement('div');
      row.className = 'key-row';
      const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      row.innerHTML = `<span class="key-token">${esc(token)}</span>`
        + `<span class="key-arrow">→</span>`
        + `<span class="key-original">${esc(original)}</span>`;
      list.appendChild(row);
    });

    // Apply current expand/collapse state (preserved across poll cycles)
    toggle.setAttribute('aria-expanded', String(this.keyExpanded));
    list.hidden = !this.keyExpanded;
    card.hidden = false;
  }

  loadLocalSecrets() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['hfToken', 'aiSafePluginApiKey', 'selectedModel'], (result) => {
        this.localSecrets = {
          hfToken: typeof result.hfToken === 'string' ? result.hfToken : '',
          aiSafePluginApiKey: typeof result.aiSafePluginApiKey === 'string' ? result.aiSafePluginApiKey : ''
        };
        const normalizedModel = normalizeSelectedModel(result.selectedModel);
        this.selectedModel = normalizedModel;
        if (normalizedModel !== result.selectedModel) {
          chrome.storage.local.set({ selectedModel: normalizedModel });
        }
        resolve();
      });
    });
  }

  loadPlatformInfo() {
    return new Promise((resolve) => {
      if (!chrome.runtime?.getPlatformInfo) {
        resolve();
        return;
      }
      chrome.runtime.getPlatformInfo((info) => {
        if (!chrome.runtime.lastError && info?.os) {
          this.platformOs = info.os;
        }
        resolve();
      });
    });
  }

  detectPlatformOsFallback() {
    const platform = `${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
    if (platform.includes('win')) return 'win';
    if (platform.includes('mac')) return 'mac';
    if (platform.includes('cros')) return 'cros';
    return 'linux';
  }

  renderAnonymizeAvailability() {
    const hasKey = Boolean(this.localSecrets.aiSafePluginApiKey);
    const anonymizeHint = document.getElementById('anonymizeHint');
    // Show hint only when Anonymize is selected AND no API key is saved
    if (anonymizeHint) anonymizeHint.hidden = hasKey || this.settings.redactionMode !== 'anonymize';
    this.renderMaskHint();
  }

  renderMaskHint() {
    const card = document.getElementById('maskHintCard');
    if (!card) return;
    const isMask = this.settings.redactionMode === 'mask';
    const alreadySeen = Boolean(this.settings.maskModeHintSeen);
    const onboardingVisible = Boolean(this.wizard?.overlay && !this.wizard.overlay.hidden);
    if (isMask && !alreadySeen && !onboardingVisible) {
      card.hidden = false;
      this.settings.maskModeHintSeen = true;
      chrome.storage.local.set({ maskModeHintSeen: true });
    } else {
      card.hidden = true;
    }
  }

  bindEvents() {
    const openSettings = () => chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
    document.getElementById('openSettingsTabBtn')?.addEventListener('click', openSettings);
    document.getElementById('anonymizeHintSettingsBtn')?.addEventListener('click', openSettings);
    document.getElementById('siteToggleButton')?.addEventListener('click', () => {
      const host = this.currentSiteHost;
      const excluded = this.normalizeSiteList(this.settings.excludedSites).includes(host);
      this.setCurrentSiteEnabled(excluded);
    });
    document.getElementById('pauseSiteButton')?.addEventListener('click', () => {
      const host = this.currentSiteHost;
      const snoozed = Number(this.settings.siteSnoozes?.[host]) > Date.now();
      if (snoozed) {
        this.resumeCurrentSite();
      } else {
        this.pauseCurrentSite();
      }
    });

    document.getElementById('enabledToggle').addEventListener('change', (event) => {
      this.updateSetting('enabled', event.target.checked);
      this.renderStatus();
      this.renderSiteControls();
    });

    document.getElementById('autoRedactToggle').addEventListener('change', (event) => {
      this.updateSetting('autoRedact', event.target.checked);
    });

    document.getElementById('monitorAllSitesToggle').addEventListener('change', (event) => {
      this.saveAdvancedConfig(false);
      this.updateSetting('monitorAllSites', event.target.checked);
      this.renderAdvancedStates();
    });

    document.getElementById('includeRegexToggle').addEventListener('change', (event) => {
      this.updateSetting('includeRegexWhenModelOnline', event.target.checked);
      this.renderRegexRuntimeState();
    });

    document.getElementById('redactionModeSelect').addEventListener('change', (event) => {
      this.settings.redactionMode = event.target.value;
      this.updateSetting('redactionMode', event.target.value);
      this.renderModeSummary();
      this.renderAnonymizeAvailability();
    });

    document.getElementById('sensitivitySelect').addEventListener('change', (event) => {
      this.updateSetting('sensitivity', event.target.value);
      this.renderModeSummary();
    });

    document.querySelectorAll('.type-checkbox').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const enabledTypes = Array.from(document.querySelectorAll('.type-checkbox:checked')).map((node) => node.value);
        this.updateSetting('enabledTypes', enabledTypes);
      });
    });

    document.getElementById('clearIgnoredValuesButton')?.addEventListener('click', () => this.clearAllIgnoredValues());
    document.getElementById('saveAdvancedButton').addEventListener('click', () => this.saveAdvancedConfig(true));
    document.getElementById('loadDefaultsButton').addEventListener('click', () => {
      this.settings.customPatterns = cloneDefaultCustomPatterns();
      this.renderPatternCards();
      this.savePatterns();
      this.setMessage('Patterns reset to defaults.');
    });

    document.getElementById('monitoredSitesInput').addEventListener('blur', () => this.saveAdvancedConfig(false));
    document.getElementById('selectorsInput').addEventListener('blur', () => this.saveAdvancedConfig(false));

    document.getElementById('addPatternButton').addEventListener('click', () => {
      const form = document.getElementById('addPatternForm');
      form.hidden = !form.hidden;
      if (!form.hidden) document.getElementById('newPatternName').focus();
    });

    document.getElementById('cancelAddPatternButton').addEventListener('click', () => {
      document.getElementById('addPatternForm').hidden = true;
      document.getElementById('newPatternName').value = '';
      document.getElementById('newPatternRegex').value = '';
      document.getElementById('newPatternReplacement').value = '';
    });

    document.getElementById('confirmAddPatternButton').addEventListener('click', () => this.addPatternFromForm());

    document.getElementById('addEntityTypeButton').addEventListener('click', () => {
      const form = document.getElementById('addEntityTypeForm');
      form.hidden = !form.hidden;
      if (!form.hidden) document.getElementById('newEntityName').focus();
    });

    document.getElementById('cancelAddEntityButton').addEventListener('click', () => {
      document.getElementById('addEntityTypeForm').hidden = true;
      document.getElementById('newEntityName').value = '';
      document.getElementById('newEntityDescription').value = '';
    });

    document.getElementById('confirmAddEntityButton').addEventListener('click', () => this.addEntityTypeFromForm());

    document.getElementById('resetButton').addEventListener('click', () => this.resetDefaults());
    document.getElementById('deleteAllDataButton')?.addEventListener('click', () => this.deleteAllAiSafePluginData());

    document.getElementById('refreshServerButton').addEventListener('click', async () => {
      await this.refreshServerStatus();
      await this.refreshServerLogs({ silent: true });
    });
    document.getElementById('startServerButton').addEventListener('click', () => this.startServer());
    document.getElementById('stopServerButton').addEventListener('click', () => this.stopServer());
    document.getElementById('restartServerButton')?.addEventListener('click', () => this.restartServer());
    document.getElementById('toggleTerminalButton').addEventListener('click', () => this.toggleTerminalVisibility());
    document.getElementById('copyInstallCommandButton').addEventListener('click', () => this.copyInstallCommand());
    document.getElementById('copyUpdateCommandButton')?.addEventListener('click', () => this.copyFromCode('serverUpdateCommand', 'copyUpdateCommandButton'));
    document.getElementById('copyUninstallCommandButton')?.addEventListener('click', () => this.copyFromCode('nativeHostUninstallCommand', 'copyUninstallCommandButton'));
    document.getElementById('copyLogCommandButton').addEventListener('click', () => this.copyFromCode('logCommandText', 'copyLogCommandButton'));
    document.querySelector('.tool-tabs-bar').addEventListener('click', (event) => {
      const tab = event.target.closest('.tool-tab');
      if (!tab) return;
      this.setServerToolsPanel(tab.dataset.panel);
    });
    document.getElementById('saveHfTokenButton').addEventListener('click', () => this.saveHfToken());
    document.getElementById('clearHfTokenButton').addEventListener('click', () => this.clearHfToken());
    document.getElementById('hfTokenInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.saveHfToken();
      }
    });
    const toggleGuidance = () => {
      const toggle = document.getElementById('mayaApiGuidanceToggle');
      const body = document.getElementById('mayaApiGuidanceBody');
      if (!toggle || !body) return;
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      body.hidden = expanded;
    };
    document.getElementById('mayaApiGuidanceToggle')?.addEventListener('click', toggleGuidance);
    document.getElementById('mayaApiGuidanceToggle')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGuidance(); }
    });
    document.getElementById('saveApiKeyButton').addEventListener('click', () => this.saveApiKey());
    document.getElementById('removeApiKeyButton').addEventListener('click', () => this.removeApiKey());
    document.getElementById('revealApiKeyButton').addEventListener('click', () => this.toggleApiKeyReveal());
    document.getElementById('toggleApiKeyVisibility').addEventListener('click', () => this.toggleApiKeyInputVisibility());
    document.getElementById('aiSafePluginApiKeyInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.saveApiKey();
      }
    });
    document.getElementById('toggleHfTokenVisibility').addEventListener('click', () => this.toggleHfTokenInputVisibility());

    document.getElementById('modelSelect').addEventListener('change', (event) => {
      this.selectedModel = normalizeSelectedModel(event.target.value);
      chrome.storage.local.set({ selectedModel: this.selectedModel }, () => {
        this.setMessage(`Model set to ${this.selectedModel}. Restart server to apply.`);
      });
    });

    window.addEventListener('unload', () => {
      if (this.serverPollTimer) {
        clearInterval(this.serverPollTimer);
        this.serverPollTimer = null;
      }
      if (this.statsPollTimer) {
        clearInterval(this.statsPollTimer);
        this.statsPollTimer = null;
      }
      if (this.siteCountdownTimer) {
        clearInterval(this.siteCountdownTimer);
        this.siteCountdownTimer = null;
      }
    });

    window.addEventListener('focus', () => {
      this.loadPageStats().catch(() => { });
      this.refreshReleaseSurface({ silent: true }).catch(() => { });
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      this.refreshReleaseSurface({ silent: true }).catch(() => { });
    });
  }

  render() {
    document.getElementById('enabledToggle').checked = Boolean(this.settings.enabled);
    document.getElementById('autoRedactToggle').checked = Boolean(this.settings.autoRedact);
    document.getElementById('monitorAllSitesToggle').checked = Boolean(this.settings.monitorAllSites);
    document.getElementById('includeRegexToggle').checked = Boolean(this.settings.includeRegexWhenModelOnline);

    document.getElementById('redactionModeSelect').value = this.settings.redactionMode;
    document.getElementById('sensitivitySelect').value = this.settings.sensitivity;

    document.querySelectorAll('.type-checkbox').forEach((checkbox) => {
      checkbox.checked = this.settings.enabledTypes.includes(checkbox.value);
    });

    document.getElementById('monitoredSitesInput').value = (this.settings.monitoredSites || []).join('\n');
    document.getElementById('selectorsInput').value = (this.settings.monitoredSelectors || []).join('\n');
    document.getElementById('hfTokenInput').value = this.localSecrets.hfToken || '';
    const modelSelect = document.getElementById('modelSelect');
    if (modelSelect) modelSelect.value = this.selectedModel;
    this.renderPatternCards();
    this.renderEntityTypeCards();
    this.renderIgnoredValuesCard();
    this.renderAnonymizeAvailability();
    this.renderApiKeyState();

    this.renderStatus();
    this.renderStats();
    this.renderPrivacyStats();
    this.renderAdvancedStates();
    this.renderModeSummary();
    this.renderRegexRuntimeState();
    this.renderServerDiagnostics();
    this.renderTerminalVisibility();
    this.renderServerToolsPanel();
    this.renderReleaseInfo();
    this.renderServerButtons();
    this.renderSiteControls();
  }

  renderStatus() {
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const sub = document.getElementById('statusSubtext');

    this.renderRegexRuntimeState();

    dot.classList.remove('active', 'warn');

    if (!this.settings.enabled) {
      text.textContent = 'Paused';
      sub.textContent = 'Protection is disabled.';
      return;
    }

    if (this.serverPhase === 'connecting') {
      dot.classList.add('warn');
      text.textContent = 'Starting Local Server';
      sub.textContent = 'Attempting to connect to local GLiNER2...';
      return;
    }

    if (this.serverPhase === 'downloading') {
      dot.classList.add('warn');
      text.textContent = 'Downloading Model';
      sub.textContent = 'Downloading GLiNER2 model (~1.8 GB). First install may take a few minutes...';
      return;
    }

    if (this.serverPhase === 'model-loading') {
      dot.classList.add('warn');
      text.textContent = 'Loading Model';
      sub.textContent = 'GLiNER2 model is loading — first start can take 15–30 s...';
      return;
    }

    if (this.serverPhase === 'disconnecting') {
      dot.classList.add('warn');
      text.textContent = 'Stopping Local Server';
      sub.textContent = 'Shutting down local GLiNER2 server...';
      return;
    }

    if (!this.serverState.known) {
      text.textContent = 'Active';
      sub.textContent = 'Checking local model status...';
      return;
    }

    if (this.serverState.installed && this.serverState.running && this.serverState.healthy) {
      dot.classList.add('active');
      text.textContent = 'Active (Local)';
      sub.textContent = `Local GLiNER2 is online${this.serverState.pid ? ` (PID ${this.serverState.pid})` : ''}.`;
      return;
    }

    dot.classList.add('warn');
    if (!this.serverState.installed) {
      text.textContent = 'Active (Setup Needed)';
      sub.textContent = 'Native host missing. Install once for one-click server control.';
      return;
    }
    if (this.serverState.portConflict) {
      text.textContent = 'Active (Port Busy)';
      sub.textContent = 'Another local process owns port 8765. AI-Safe Plugin will not stop it automatically.';
      return;
    }
    if (this.serverState.running && !this.serverState.healthy) {
      text.textContent = 'Active (Connecting)';
      sub.textContent = 'Local server process is starting.';
      return;
    }
    text.textContent = 'Active (Regex Mode)';
    sub.textContent = 'Local model is offline. Regex/custom patterns are active.';
  }

  renderRegexRuntimeState() {
    const node = document.getElementById('regexRuntimeState');
    if (!node) return;

    if (!this.settings.enabled) {
      node.textContent = 'Runtime: protection paused.';
      return;
    }

    if (
      this.serverPhase === 'connecting'
      || this.serverPhase === 'model-loading'
      || this.serverPhase === 'disconnecting'
      || !this.serverState.known
    ) {
      node.textContent = 'Runtime: checking AI and regex availability…';
      return;
    }

    if (this.serverState.installed && this.serverState.running && this.serverState.healthy) {
      node.textContent = this.settings.includeRegexWhenModelOnline
        ? 'Runtime: AI + Regex active.'
        : 'Runtime: AI only. Regex stays ready as fallback.';
      return;
    }

    node.textContent = 'Runtime: Regex fallback active.';
  }

  renderStats() {
    document.getElementById('detectionCount').textContent = this.formatNumber(this.stats.detections);
    document.getElementById('redactionCount').textContent = this.formatNumber(this.stats.redactions);
  }

  // U7: durable "what AI-Safe Plugin saved you" card (options About). Counts only.
  renderPrivacyStats() {
    const totalEl = document.getElementById('statTotalProtected');
    if (!totalEl) return; // only present on the options page
    chrome.storage.local.get(['aiSafePluginStats'], (data) => {
      const stats = data?.aiSafePluginStats || {};
      const byLabel = stats.byLabel || {};
      const byWeek = stats.byWeek || {};
      totalEl.textContent = this.formatNumber(Number(stats.totalProtected) || 0);

      const weekEl = document.getElementById('statThisWeek');
      if (weekEl) weekEl.textContent = this.formatNumber(Number(byWeek[isoWeekKey()]) || 0);

      const topEl = document.getElementById('statTopTypes');
      if (topEl) {
        const top = Object.entries(byLabel)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([label, n]) => `${this._prettyLabel(label)} (${this.formatNumber(n)})`);
        topEl.textContent = top.length ? top.join(', ') : '—';
      }
    });
  }

  _prettyLabel(label) {
    return String(label || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  renderAdvancedStates() {
    document.getElementById('monitoredSitesInput').disabled = Boolean(this.settings.monitorAllSites);
  }

  renderSiteControls() {
    const row = document.getElementById('siteControlRow');
    if (!row) return;
    const host = this.currentSiteHost;
    row.hidden = !host;
    if (!host) return;

    const hostNode = document.getElementById('currentSiteHost');
    const pauseButton = document.getElementById('pauseSiteButton');
    const toggleButton = document.getElementById('siteToggleButton');
    const snoozeStatus = document.getElementById('siteSnoozeStatus');
    const excluded = this.normalizeSiteList(this.settings.excludedSites).includes(host);
    const until = Number(this.settings.siteSnoozes?.[host]) || 0;
    const snoozed = until > Date.now();
    const globallyEnabled = Boolean(this.settings.enabled);

    if (hostNode) hostNode.textContent = host;
    if (snoozeStatus) {
      snoozeStatus.hidden = false;
      if (!globallyEnabled) {
        snoozeStatus.textContent = 'Global protection is off';
      } else if (excluded) {
        snoozeStatus.textContent = 'Off on this site';
      } else if (snoozed) {
        const resumesAt = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        snoozeStatus.textContent = `Paused · resumes ${resumesAt}`;
      } else {
        snoozeStatus.textContent = 'Active on this site';
      }
    }
    if (pauseButton) {
      pauseButton.hidden = !globallyEnabled || excluded;
      pauseButton.textContent = snoozed ? 'Resume' : 'Pause 1h';
    }
    if (toggleButton) {
      toggleButton.disabled = !globallyEnabled;
      toggleButton.textContent = excluded ? 'Turn on' : 'Turn off';
      toggleButton.classList.toggle('secondary', excluded);
      toggleButton.classList.toggle('ghost', !excluded);
    }

    if (this.siteCountdownTimer) {
      clearInterval(this.siteCountdownTimer);
      this.siteCountdownTimer = null;
    }
    if (snoozed) {
      this.siteCountdownTimer = setInterval(() => {
        this.settings.siteSnoozes = this.pruneSiteSnoozes(this.settings.siteSnoozes);
        this.renderSiteControls();
      }, 30000);
    }
  }

  setCurrentSiteEnabled(enabled) {
    const host = this.currentSiteHost;
    if (!host) return;
    const sites = this.normalizeSiteList(this.settings.excludedSites);
    const siteSnoozes = this.pruneSiteSnoozes(this.settings.siteSnoozes);
    delete siteSnoozes[host];
    const next = enabled
      ? sites.filter((site) => site !== host)
      : [...new Set([...sites, host])];
    this.settings.excludedSites = next;
    this.settings.siteSnoozes = siteSnoozes;
    chrome.storage.local.set({ excludedSites: next, siteSnoozes }, () => this.setMessage(enabled ? 'AI-Safe Plugin enabled here.' : 'AI-Safe Plugin paused on this site.'));
    this.renderSiteControls();
  }

  pauseCurrentSite() {
    const host = this.currentSiteHost;
    if (!host) return;
    const siteSnoozes = this.pruneSiteSnoozes(this.settings.siteSnoozes);
    const excludedSites = this.normalizeSiteList(this.settings.excludedSites).filter((site) => site !== host);
    siteSnoozes[host] = Date.now() + SITE_SNOOZE_MS;
    this.settings.excludedSites = excludedSites;
    this.settings.siteSnoozes = siteSnoozes;
    chrome.storage.local.set({ excludedSites, siteSnoozes }, () => this.setMessage('AI-Safe Plugin paused here for 1 hour.'));
    this.renderSiteControls();
  }

  resumeCurrentSite() {
    const host = this.currentSiteHost;
    if (!host) return;
    const siteSnoozes = this.pruneSiteSnoozes(this.settings.siteSnoozes);
    delete siteSnoozes[host];
    this.settings.siteSnoozes = siteSnoozes;
    chrome.storage.local.set({ siteSnoozes }, () => this.setMessage('AI-Safe Plugin resumed here.'));
    this.renderSiteControls();
  }

  renderModeSummary() {
    const node = document.getElementById('modeSummary');
    if (!node) return;
    const mode = this.settings.redactionMode === 'mask' ? 'Mask' : 'Anonymize';
    const modeBehavior = mode === 'Mask'
      ? 'Replaces your data with [TYPE REDACTED] tags — private, no setup needed.'
      : 'Swaps supported PII with realistic fakes through Maya so enterprise LLMs receive only anonymized text. Unsupported types stay local and are still redacted.';

    const sensitivityMap = {
      low: 'Low = strict precision mode (fewer detections).',
      medium: 'Medium = balanced mode.',
      high: 'High = aggressive mode (more detections, more false positives).'
    };
    node.textContent = `${mode}: ${modeBehavior} ${sensitivityMap[this.settings.sensitivity] || sensitivityMap.medium}`;
  }

  startServerPolling() {
    if (this.serverPollTimer) {
      clearInterval(this.serverPollTimer);
    }
    this.serverPollTimer = setInterval(() => {
      this.refreshServerStatus({ silent: true }).catch(() => { });
      this.refreshServerLogs({ silent: true }).catch(() => { });
    }, 2600);
  }

  startStatsPolling() {
    if (this.statsPollTimer) {
      clearInterval(this.statsPollTimer);
    }
    this.statsPollTimer = setInterval(() => {
      this.loadPageStats().catch(() => { });
    }, 1200);
  }

  setServerPhase(phase) {
    this.serverPhase = phase;
    this.renderStatus();
  }

  toggleTerminalVisibility() {
    this.terminalVisible = !this.terminalVisible;
    this.renderTerminalVisibility();
  }

  renderTerminalVisibility() {
    const panel = document.getElementById('terminalPanel');
    const button = document.getElementById('toggleTerminalButton');
    if (!panel || !button) return;
    panel.hidden = !this.terminalVisible;
    button.textContent = this.terminalVisible ? 'Hide Logs' : 'Show Logs';
  }

  setServerToolsPanel(panel) {
    this.serverToolsActivePanel = typeof panel === 'string' && panel ? panel : 'hfToken';
    this.renderServerToolsPanel();
  }

  renderServerToolsPanel() {
    const active = this.serverToolsActivePanel || 'hfToken';
    document.querySelectorAll('.tool-tab').forEach((tab) => {
      tab.classList.toggle('is-active', tab.dataset.panel === active);
    });
    document.querySelectorAll('.tool-panel').forEach((panel) => {
      panel.hidden = panel.id !== `${active}Panel`;
    });
  }

  appendTerminalLine(message) {
    const output = document.getElementById('terminalOutput');
    if (!output) return;
    const prefix = new Date().toLocaleTimeString();
    const line = `[${prefix}] ${message}`;
    if (!output.textContent || output.textContent === 'No server logs yet.') {
      output.textContent = line;
    } else {
      output.textContent = `${output.textContent}\n${line}`;
    }
    output.scrollTop = output.scrollHeight;
  }

  renderTerminalLogs(lines) {
    const output = document.getElementById('terminalOutput');
    if (!output) return;
    if (!Array.isArray(lines) || lines.length === 0) {
      output.textContent = 'No server logs yet.';
      return;
    }
    output.textContent = lines.join('\n');
    output.scrollTop = output.scrollHeight;
  }

  renderServerButtons() {
    const startButton = document.getElementById('startServerButton');
    const stopButton = document.getElementById('stopServerButton');
    const restartButton = document.getElementById('restartServerButton');
    const refreshButton = document.getElementById('refreshServerButton');
    if (!startButton || !stopButton || !refreshButton) return;

    if (this.serverBusy) {
      startButton.disabled = true;
      stopButton.disabled = true;
      if (restartButton) restartButton.disabled = true;
      refreshButton.disabled = true;
      return;
    }

    const running = Boolean(this.serverState.running);
    const installed = this.serverState.installed !== false;
    const portConflict = Boolean(this.serverState.portConflict);
    startButton.disabled = running || !installed || portConflict;
    stopButton.disabled = !running;
    if (restartButton) restartButton.disabled = !running || !installed || portConflict;
    refreshButton.disabled = false;
  }

  setServerButtonsDisabled(disabled) {
    this.serverBusy = disabled;
    this.renderServerButtons();
  }

  async requestServerControl(command, options = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'serverControl', command, options }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { success: false, error: 'No response from background.' });
      });
    });
  }

  getNativeHostInstallCommand() {
    const platformOs = this.platformOs || this.detectPlatformOsFallback();
    if (platformOs === 'win') {
      return `powershell -NoProfile -ExecutionPolicy Bypass -Command '$installer = Join-Path $env:TEMP ''AISafePluginSetup.exe''; Invoke-WebRequest -UseBasicParsing -Uri ''${AI_SAFE_PLUGIN_RELEASE_BASE_URL}/AISafePluginSetup.exe'' -OutFile $installer; Start-Process -FilePath $installer -ArgumentList ''/EXTENSION_ID=${chrome.runtime.id}'' -Wait'`;
    }
    return `curl -fsSL ${AI_SAFE_PLUGIN_RELEASE_BASE_URL}/install.sh | bash -s -- --extension-id ${chrome.runtime.id}`;
  }

  getNativeHostUninstallCommand() {
    const platformOs = this.platformOs || this.detectPlatformOsFallback();
    if (platformOs === 'win') {
      return `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm '${AI_SAFE_PLUGIN_RELEASE_BASE_URL}/uninstall.ps1' | iex; Uninstall-AiSafePlugin"`;
    }
    return `curl -fsSL ${AI_SAFE_PLUGIN_RELEASE_BASE_URL}/uninstall.sh | bash`;
  }

  getDefaultReleaseInfo() {
    return {
      status: 'loading',
      latestTag: '',
      publishedAt: '',
      htmlUrl: AI_SAFE_PLUGIN_RELEASE_PAGE_URL,
      extensionUpdateAvailable: false,
      comparableToExtension: false,
      error: ''
    };
  }

  normalizeVersionTag(tag) {
    return String(tag || '').trim().replace(/^v/i, '');
  }

  parseVersionParts(tag) {
    const normalized = this.normalizeVersionTag(tag);
    const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    if (!match) return null;
    return match.slice(1, 4).map((part) => Number(part));
  }

  compareVersionParts(left, right) {
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const lhs = Number(left[index] || 0);
      const rhs = Number(right[index] || 0);
      if (lhs > rhs) return 1;
      if (lhs < rhs) return -1;
    }
    return 0;
  }

  getReleaseComparison(tag) {
    const manifestVersion = chrome.runtime.getManifest()?.version || '';
    const latestParts = this.parseVersionParts(tag);
    const currentParts = this.parseVersionParts(manifestVersion);
    if (latestParts && currentParts) {
      return {
        comparableToExtension: true,
        extensionUpdateAvailable: this.compareVersionParts(latestParts, currentParts) > 0
      };
    }
    return {
      comparableToExtension: false,
      extensionUpdateAvailable: false
    };
  }

  formatReleaseTimestamp(value) {
    if (!value) return 'Unknown';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
  }

  async refreshReleaseInfo(options = {}) {
    const silent = Boolean(options.silent);
    this.releaseInfo = {
      ...this.releaseInfo,
      status: 'loading',
      error: ''
    };
    this.renderReleaseInfo();

    try {
      const response = await fetch(AI_SAFE_PLUGIN_RELEASE_API_URL, {
        headers: { Accept: 'application/vnd.github+json' },
        cache: 'no-store'
      });
      if (!response.ok) {
        throw new Error(`GitHub release check failed (${response.status}).`);
      }

      const payload = await response.json();
      const latestTag = String(payload?.tag_name || payload?.name || '').trim();
      const comparison = this.getReleaseComparison(latestTag);
      this.releaseInfo = {
        status: 'ready',
        latestTag,
        publishedAt: String(payload?.published_at || payload?.created_at || '').trim(),
        htmlUrl: String(payload?.html_url || AI_SAFE_PLUGIN_RELEASE_PAGE_URL).trim() || AI_SAFE_PLUGIN_RELEASE_PAGE_URL,
        extensionUpdateAvailable: comparison.extensionUpdateAvailable,
        comparableToExtension: comparison.comparableToExtension,
        error: ''
      };
    } catch (error) {
      this.releaseInfo = {
        ...this.getDefaultReleaseInfo(),
        status: 'error',
        error: error?.message || 'GitHub release check failed.'
      };
      if (!silent) {
        this.setMessage(this.releaseInfo.error, true);
      }
    }

    this.renderReleaseInfo();
  }

  renderReleaseInfo() {
    const updateBlock = document.getElementById('serverUpdateBlock');
    const updateCode = document.getElementById('serverUpdateCommand');
    if (updateCode) updateCode.textContent = this.getNativeHostInstallCommand();

    const uninstallCode = document.getElementById('nativeHostUninstallCommand');
    if (uninstallCode) uninstallCode.textContent = this.getNativeHostUninstallCommand();

    const releaseText = document.getElementById('releaseStatusText');
    const releaseSubtext = document.getElementById('releaseStatusSubtext');
    const releaseLink = document.getElementById('releaseLink');
    const sidebarBlock = document.getElementById('sidebarUpdateBlock');
    const sidebarPill = document.getElementById('sidebarUpdatePill');
    const sidebarTitle = document.getElementById('sidebarUpdateTitle');
    const sidebarSubtext = document.getElementById('sidebarUpdateSubtext');
    const noticeCard = document.getElementById('releaseNoticeCard');
    const noticeBadge = document.getElementById('releaseNoticeBadge');
    const noticeTitle = document.getElementById('releaseNoticeTitle');
    const noticeBody = document.getElementById('releaseNoticeBody');
    const noticeLink = document.getElementById('releaseNoticeLink');
    const installedBundleTag = String(this.serverMeta.bundleReleaseTag || '').trim();
    const currentVersion = chrome.runtime.getManifest()?.version || 'unknown';
    const localInstallAligned = Boolean(installedBundleTag)
      && this.normalizeVersionTag(installedBundleTag) === this.normalizeVersionTag(currentVersion);

    const resolvedReleaseLink = this._safeHttpsUrl(
      this.releaseInfo.htmlUrl || this.serverMeta.bundleReleaseUrl || AI_SAFE_PLUGIN_RELEASE_PAGE_URL
    );

    if (releaseLink) {
      releaseLink.href = resolvedReleaseLink;
    }
    if (noticeLink) {
      noticeLink.href = resolvedReleaseLink;
    }

    const applySidebarState = (state, pill, title, subtext) => {
      if (!sidebarBlock) return;
      sidebarBlock.classList.remove('is-loading', 'is-available', 'is-current', 'is-error');
      sidebarBlock.classList.add(state);
      if (sidebarPill) sidebarPill.textContent = pill;
      if (sidebarTitle) sidebarTitle.textContent = title;
      if (sidebarSubtext) sidebarSubtext.textContent = subtext;
    };

    const showNotice = (badge, title, body) => {
      if (!noticeCard) return;
      noticeCard.hidden = false;
      if (noticeBadge) noticeBadge.textContent = badge;
      if (noticeTitle) noticeTitle.textContent = title;
      if (noticeBody) noticeBody.textContent = body;
    };

    const setUpdateBlockVisible = (visible) => {
      if (updateBlock) updateBlock.hidden = !visible;
    };

    if (noticeCard) {
      noticeCard.hidden = true;
    }

    if (!releaseText || !releaseSubtext) return;

    if (this.releaseInfo.status === 'idle' || this.releaseInfo.status === 'loading') {
      setUpdateBlockVisible(false);
      releaseText.textContent = 'Checking GitHub for the latest release…';
      releaseSubtext.textContent = 'Re-run this command after a new release to update the local server bundle while keeping your cache and local config.';
      applySidebarState('is-loading', 'Checking', 'Checking for updates', 'AI-Safe Plugin is checking whether a newer extension or local server bundle is available.');
      return;
    }

    if (this.releaseInfo.status === 'error') {
      if (installedBundleTag) {
        setUpdateBlockVisible(!localInstallAligned);
        if (localInstallAligned) {
          releaseText.textContent = `Everything looks current locally: v${currentVersion}`;
          releaseSubtext.textContent = `GitHub release checks are temporarily unavailable, but both the extension and installed local server bundle report ${installedBundleTag}.`;
          applySidebarState('is-current', 'Up to date', 'Everything looks current locally', `GitHub release checks are temporarily unavailable, but the installed extension and local server bundle both report ${installedBundleTag}.`);
          return;
        }
        releaseText.textContent = `Local server verified: ${installedBundleTag}`;
        releaseSubtext.textContent = `${this.releaseInfo.error || 'GitHub could not be reached right now.'} AI-Safe Plugin can confirm the installed local server bundle on this machine, but it cannot check for newer releases at the moment.`;
        applySidebarState('is-current', 'Verified', 'Local server verified', `Installed local server bundle ${installedBundleTag} is known. Checking GitHub for newer releases is temporarily unavailable.`);
        showNotice(
          'Release check delayed',
          'Installed local server bundle is verified',
          `AI-Safe Plugin can confirm that this machine is running local server bundle ${installedBundleTag}. GitHub could not be reached to check whether anything newer exists right now.`
        );
        return;
      }

      setUpdateBlockVisible(true);
      releaseText.textContent = 'Backend version unknown right now.';
      releaseSubtext.textContent = `${this.releaseInfo.error || 'GitHub could not be reached right now.'} Refresh the local server bundle below once to stamp this install with local release metadata.`;
      applySidebarState('is-available', 'Refresh', 'Backend version unknown', 'GitHub could not be reached, and this install does not yet have local bundle metadata.');
      showNotice(
        'Server metadata',
        'Refresh the local server bundle once',
        'This install is missing local backend release metadata. Refresh the local server bundle below once, and future update checks will stay valid even if GitHub is temporarily unavailable.'
      );
      return;
    }

    const latestTag = this.releaseInfo.latestTag || 'latest';
    const published = this.formatReleaseTimestamp(this.releaseInfo.publishedAt);
    const bundleKnown = Boolean(installedBundleTag);
    const bundleIsCurrent = bundleKnown && installedBundleTag === latestTag;
    const bundleNeedsRefresh = bundleKnown && Boolean(latestTag) && installedBundleTag !== latestTag;
    const bundleUnknown = !bundleKnown;
    const extensionComparable = Boolean(this.releaseInfo.comparableToExtension);
    const extensionUpdateAvailable = extensionComparable && Boolean(this.releaseInfo.extensionUpdateAvailable);
    const extensionIsCurrent = extensionComparable && !extensionUpdateAvailable;

    if (extensionUpdateAvailable && bundleIsCurrent) {
      setUpdateBlockVisible(false);
      releaseText.textContent = `Extension update available: ${latestTag} (backend already updated)`;
      releaseSubtext.textContent = `Published ${published}. Your installed local server bundle already matches ${latestTag}. Reload or reinstall the extension build from v${currentVersion} to finish the upgrade.`;
      applySidebarState('is-available', 'Update', 'Backend current, extension behind', `The local server bundle is already on ${latestTag}, but the extension UI is still on v${currentVersion}.`);
      showNotice(
        'Extension update',
        'Reload the extension to finish updating AI-Safe Plugin',
        `Your local server bundle already matches ${latestTag}. Reload or reinstall the extension build from v${currentVersion} so the UI and backend are on the same release.`
      );
      return;
    }

    if (extensionUpdateAvailable && bundleNeedsRefresh) {
      setUpdateBlockVisible(true);
      releaseText.textContent = `AI-Safe Plugin update available: ${latestTag}`;
      releaseSubtext.textContent = `Published ${published}. Extension build is v${currentVersion} and the installed local server bundle is ${installedBundleTag}. Update or reload the extension, then run the refresh command below so both parts land on ${latestTag}.`;
      applySidebarState('is-available', 'Update', 'Extension and server update available', `A newer AI-Safe Plugin release is available, and this machine still has the ${installedBundleTag} local server bundle.`);
      showNotice(
        'Update available',
        'Update the extension, then refresh the local server bundle',
        `You’re on extension v${currentVersion} with local server bundle ${installedBundleTag}. Reload the extension first, then run the refresh command below so both move to ${latestTag}.`
      );
      return;
    }

    if (extensionUpdateAvailable && bundleUnknown) {
      setUpdateBlockVisible(true);
      releaseText.textContent = `Extension update available: ${latestTag} (backend version unknown)`;
      releaseSubtext.textContent = `Published ${published}. Update or reload the extension build first. Then run the refresh command below once so AI-Safe Plugin can stamp and verify the installed local server bundle version.`;
      applySidebarState('is-available', 'Update', 'Extension update available', `A newer AI-Safe Plugin release is available, and this install still needs backend release metadata stamped locally.`);
      showNotice(
        'Update available',
        'Update the extension and refresh local server metadata',
        `You’re currently on v${currentVersion}. Reload the extension first, then run the refresh command below so AI-Safe Plugin can verify which local server bundle is installed.`
      );
      return;
    }

    if (bundleNeedsRefresh) {
      setUpdateBlockVisible(true);
      const installedText = installedBundleTag || 'unknown bundle version';
      releaseText.textContent = `Local server bundle update available: ${latestTag}`;
      releaseSubtext.textContent = `Published ${published}. Installed bundle is ${installedText}. Run the refresh command below; once the local server bundle matches ${latestTag}, this notice will clear.`;
      applySidebarState('is-available', 'Update', 'Local server update available', installedBundleTag ? 'A newer local server bundle is available for this install.' : 'This install needs one refresh so AI-Safe Plugin can track the local server bundle version precisely.');
      showNotice(
        'Server update',
        'Refresh the local server bundle',
        installedBundleTag
          ? `Your installed local server bundle is ${installedBundleTag}. Run the refresh command below and this update notice will clear once the installed bundle matches ${latestTag}.`
          : `This install does not have release metadata yet. Run the refresh command below once, and future update checks will track the installed server bundle precisely.`
      );
      return;
    }

    if (extensionIsCurrent && bundleUnknown) {
      setUpdateBlockVisible(true);
      releaseText.textContent = `Extension is up to date: v${currentVersion}`;
      releaseSubtext.textContent = `Latest GitHub release is ${latestTag}, published ${published}. This install still needs one local server refresh so AI-Safe Plugin can verify and stamp the backend bundle version on this machine.`;
      applySidebarState('is-available', 'Refresh', 'Backend version needs verification', 'The extension is current, but this local server install is missing release metadata until you refresh it once.');
      showNotice(
        'Server metadata',
        'Refresh the local server bundle once',
        `The extension is already on ${latestTag}. Run the refresh command below once so AI-Safe Plugin can stamp and verify the backend bundle version for this install.`
      );
      return;
    }

    if (bundleIsCurrent) {
      setUpdateBlockVisible(false);
      releaseText.textContent = `Local server bundle is up to date: ${latestTag}`;
      releaseSubtext.textContent = `Published ${published}. Installed bundle matches the latest GitHub release, so there is nothing to update right now.`;
      applySidebarState('is-current', 'Up to date', 'Everything is up to date', 'Your local server bundle matches the latest published release.');
      return;
    }

    if (extensionComparable) {
      setUpdateBlockVisible(false);
      releaseText.textContent = `Extension is up to date: v${currentVersion}`;
      releaseSubtext.textContent = `Latest GitHub release is ${latestTag}, published ${published}. Refresh the local server bundle below if you want to stamp this install with the latest release metadata or repair it in place.`;
      applySidebarState('is-current', 'Up to date', 'Everything is up to date', 'AI-Safe Plugin is on the latest published extension release.');
      return;
    }

    setUpdateBlockVisible(true);
    releaseText.textContent = `Latest GitHub release channel: ${latestTag}`;
    releaseSubtext.textContent = `Published ${published}. This tag does not map cleanly to the installed extension version, so treat the command below as a local server refresh command, not as proof that the extension itself is outdated.`;
    applySidebarState('is-loading', 'Preview', 'Preview release detected', 'You are on a preview or fork release channel, so AI-Safe Plugin is keeping the manual refresh command available.');
  }

  getDefaultServerMeta() {
    return {
      logFile: '.runtime/gliner2_server.log',
      logCommand: 'tail -n 80 .runtime/gliner2_server.log',
      runtimeDir: '.runtime',
      runtimePython: '.venv/bin/python',
      runtimePythonVersion: null,
      uvBinary: null,
      uvVersion: null,
      uvPinnedVersion: null,
      pythonPinnedVersion: null,
      modelOverride: null,
      bundleReleaseTag: null,
      bundleReleasePublishedAt: null,
      bundleReleaseUrl: null,
      bundleReleaseInstalledAt: null
    };
  }

  updateServerMeta(payload = {}) {
    this.serverMeta = {
      ...this.getDefaultServerMeta(),
      ...this.serverMeta,
      ...(payload || {})
    };
    this.renderServerDiagnostics();
    this.renderReleaseInfo();
  }

  renderServerDiagnostics() {
    // Active model: show what the running server reported, or the selected model if stopped
    const activeModel = this.serverMeta.modelOverride || (this.serverState.running ? this.selectedModel : '—');
    document.getElementById('modelText').textContent = String(activeModel);
    document.getElementById('logFileText').textContent = String(this.serverMeta.logFile || '.runtime/gliner2_server.log');
    document.getElementById('logCommandText').textContent = String(this.serverMeta.logCommand || 'tail -n 80 .runtime/gliner2_server.log');
    document.getElementById('runtimeDirText').textContent = String(this.serverMeta.runtimeDir || '.runtime');
    const runtimePython = document.getElementById('runtimePythonText');
    if (runtimePython) {
      const runtimeValue = this.serverMeta.runtimePythonVersion
        ? `${this.serverMeta.runtimePython || '.venv/bin/python'} (${this.serverMeta.runtimePythonVersion})`
        : String(this.serverMeta.runtimePython || '.venv/bin/python');
      runtimePython.textContent = runtimeValue;
    }
    const uvBinary = document.getElementById('uvBinaryText');
    if (uvBinary) {
      const uvValue = this.serverMeta.uvVersion
        ? `${this.serverMeta.uvVersion} · ${this.serverMeta.uvBinary || 'managed locally'}`
        : `Pinned ${this.serverMeta.uvPinnedVersion || 'uv'} pending install`;
      uvBinary.textContent = uvValue;
    }
    const portStatus = document.getElementById('portStatusText');
    if (portStatus) {
      if (this.serverState.portConflict) {
        portStatus.textContent = 'Occupied by another local process';
      } else if (this.serverState.running && this.serverState.healthy) {
        portStatus.textContent = `AI-Safe Plugin server online${this.serverState.pid ? ` (PID ${this.serverState.pid})` : ''}`;
      } else if (this.serverState.running) {
        portStatus.textContent = 'AI-Safe Plugin server starting';
      } else {
        portStatus.textContent = 'Available';
      }
    }
  }

  setCopyButtonState(label = 'Copy', copied = false) {
    const button = document.getElementById('copyInstallCommandButton');
    button.textContent = label;
    button.classList.toggle('is-copied', copied);
  }

  setAnyCopyButtonState(buttonId, label = 'Copy', copied = false) {
    const button = document.getElementById(buttonId);
    if (!button) return;
    button.textContent = label;
    button.classList.toggle('is-copied', copied);
  }

  clearCopyButtonTimer(buttonId) {
    const timer = this.copyButtonTimers.get(buttonId);
    if (timer) {
      clearTimeout(timer);
      this.copyButtonTimers.delete(buttonId);
    }
  }

  flashCopiedButton(buttonId) {
    this.clearCopyButtonTimer(buttonId);
    this.setAnyCopyButtonState(buttonId, 'Copied!', true);
    const timer = setTimeout(() => {
      this.setAnyCopyButtonState(buttonId, 'Copy', false);
      this.copyButtonTimers.delete(buttonId);
    }, 1400);
    this.copyButtonTimers.set(buttonId, timer);
  }

  renderNativeHostInstallBlock(installed) {
    const block = document.getElementById('nativeHostInstallBlock');
    const code = document.getElementById('nativeHostInstallCommand');
    if (installed) {
      block.hidden = true;
      code.textContent = '';
      this.clearCopyButtonTimer('copyInstallCommandButton');
      this.setCopyButtonState('Copy', false);
      return;
    }

    code.textContent = this.getNativeHostInstallCommand();
    block.hidden = false;
    this.setCopyButtonState('Copy', false);
  }

  async copyInstallCommand() {
    const command = this.getNativeHostInstallCommand();
    try {
      await navigator.clipboard.writeText(command);
      this.flashCopiedButton('copyInstallCommandButton');
      this.setMessage('Install command copied.');
    } catch {
      const helper = document.createElement('textarea');
      helper.value = command;
      helper.setAttribute('readonly', 'true');
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.focus();
      helper.select();
      try {
        document.execCommand('copy');
        this.flashCopiedButton('copyInstallCommandButton');
        this.setMessage('Install command copied.');
      } catch {
        this.setMessage('Copy failed. Please copy manually.', true);
      } finally {
        helper.remove();
      }
    }
  }

  async copyFromCode(codeId, buttonId) {
    const node = document.getElementById(codeId);
    const text = node ? String(node.textContent || '').trim() : '';
    if (!text) {
      this.setMessage('Nothing to copy.', true);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      this.flashCopiedButton(buttonId);
      this.setMessage('Command copied.');
    } catch {
      const helper = document.createElement('textarea');
      helper.value = text;
      helper.setAttribute('readonly', 'true');
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.focus();
      helper.select();
      try {
        document.execCommand('copy');
        this.flashCopiedButton(buttonId);
        this.setMessage('Command copied.');
      } catch {
        this.setMessage('Copy failed. Please copy manually.', true);
      } finally {
        helper.remove();
      }
    }
  }

  getInputHfToken() {
    const node = document.getElementById('hfTokenInput');
    return String(node?.value || '').trim();
  }

  async saveHfToken() {
    const hfToken = this.getInputHfToken();
    await new Promise((resolve) => {
      chrome.storage.local.set({ hfToken }, resolve);
    });
    this.localSecrets.hfToken = hfToken;
    this.flashBtn('saveHfTokenButton', '✓ Saved');
    this.setMessage(hfToken ? 'HF token saved locally.' : 'HF token cleared.');
  }

  async clearHfToken() {
    await new Promise((resolve) => {
      chrome.storage.local.set({ hfToken: '' }, resolve);
    });
    this.localSecrets.hfToken = '';
    const input = document.getElementById('hfTokenInput');
    if (input) input.value = '';
    this.setMessage('HF token cleared.');
  }

  getInputApiKey() {
    const node = document.getElementById('aiSafePluginApiKeyInput');
    return String(node?.value || '').trim();
  }

  async saveApiKey() {
    const aiSafePluginApiKey = this.getInputApiKey();
    if (!aiSafePluginApiKey) {
      this.setMessage('Please enter an API key.', true);
      return;
    }
    await new Promise((resolve) => {
      chrome.storage.local.set({ aiSafePluginApiKey }, resolve);
    });
    this.localSecrets.aiSafePluginApiKey = aiSafePluginApiKey;
    // Auto-activate Anonymize mode when API key is set
    this.updateSetting('redactionMode', 'anonymize');
    this.settings.redactionMode = 'anonymize';
    document.getElementById('redactionModeSelect').value = 'anonymize';
    this.renderAnonymizeAvailability();
    this.renderModeSummary();
    this.apiKeyRevealed = false;
    this.renderApiKeyState();
    this.flashBtn('saveApiKeyButton', '✓ Saved');
    this.setMessage('API key saved securely.');
  }

  async removeApiKey() {
    await new Promise((resolve) => {
      chrome.storage.local.set({ aiSafePluginApiKey: '' }, resolve);
    });
    this.localSecrets.aiSafePluginApiKey = '';
    // Revert to Mask mode when API key is removed
    this.updateSetting('redactionMode', 'mask');
    this.settings.redactionMode = 'mask';
    document.getElementById('redactionModeSelect').value = 'mask';
    this.renderAnonymizeAvailability();
    this.renderModeSummary();
    this.apiKeyRevealed = false;
    const input = document.getElementById('aiSafePluginApiKeyInput');
    if (input) input.value = '';
    this.renderApiKeyState();
    this.setMessage('API key removed.');
  }

  toggleApiKeyReveal() {
    this.apiKeyRevealed = !this.apiKeyRevealed;
    const preview = document.getElementById('apiKeyPreview');
    const btn = document.getElementById('revealApiKeyButton');
    if (!preview || !btn) return;
    if (this.apiKeyRevealed) {
      const key = this.localSecrets.aiSafePluginApiKey || '';
      preview.textContent = key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : key;
      btn.textContent = 'Hide';
    } else {
      preview.textContent = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
      btn.textContent = 'Show';
    }
  }

  toggleApiKeyInputVisibility() {
    const input = document.getElementById('aiSafePluginApiKeyInput');
    const btn = document.getElementById('toggleApiKeyVisibility');
    if (!input || !btn) return;
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    btn.setAttribute('aria-label', isPassword ? 'Hide key' : 'Show key');
  }

  toggleHfTokenInputVisibility() {
    const input = document.getElementById('hfTokenInput');
    const btn = document.getElementById('toggleHfTokenVisibility');
    if (!input) return;
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    if (btn) btn.setAttribute('aria-label', isPassword ? 'Hide token' : 'Show token');
  }

  renderApiKeyState() {
    const hasKey = Boolean(this.localSecrets.aiSafePluginApiKey);
    const savedState = document.getElementById('apiKeySavedState');
    const inputState = document.getElementById('apiKeyInputState');
    if (!savedState || !inputState) return;

    savedState.hidden = !hasKey;
    inputState.hidden = hasKey;

    // Collapse the guidance card when a key is already saved; expand when not.
    const toggle = document.getElementById('mayaApiGuidanceToggle');
    const body = document.getElementById('mayaApiGuidanceBody');
    if (toggle && body) {
      const shouldExpand = !hasKey;
      toggle.setAttribute('aria-expanded', String(shouldExpand));
      body.hidden = !shouldExpand;
    }

    if (hasKey) {
      const preview = document.getElementById('apiKeyPreview');
      if (preview) {
        preview.textContent = this.apiKeyRevealed
          ? this.localSecrets.aiSafePluginApiKey
          : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
      }
    } else {
      const input = document.getElementById('aiSafePluginApiKeyInput');
      if (input) input.value = '';
    }
  }

  updateServerState(payload = {}) {
    this.serverState = {
      known: true,
      installed: payload.installed !== false,
      running: Boolean(payload.running),
      healthy: Boolean(payload.healthy),
      pid: payload.pid || null,
      portConflict: Boolean(payload.portConflict),
      processPhase: String(payload.processPhase || '')
    };
    if (!this.serverState.installed) {
      this.setServerPhase('disconnected');
    } else if (this.serverState.running && this.serverState.healthy) {
      this.setServerPhase('active');
    } else if (this.serverState.running && !this.serverState.healthy) {
      // Distinguish downloading from general model-loading
      this.setServerPhase(this.serverState.processPhase === 'downloading' ? 'downloading' : 'model-loading');
    } else {
      this.setServerPhase('disconnected');
    }
    // Notify onboarding wizard of state change
    if (this.wizard) this.wizard.onServerStateUpdate();
    this.renderServerButtons();
  }

  async refreshServerLogs(options = {}) {
    const silent = Boolean(options.silent);
    const response = await this.requestServerControl('logs', { lines: 120 });
    if (!response?.success) {
      if (!silent) {
        this.appendTerminalLine(`Log fetch failed: ${response?.error || 'unknown error'}`);
      }
      return;
    }
    this.updateServerMeta(response);
    this.renderTerminalLogs(response.logLines);
  }

  async refreshServerStatus(options = {}) {
    const silent = Boolean(options.silent);
    if (this.serverBusy) return;
    const response = await this.requestServerControl('status');
    if (!response?.success) {
      this.updateServerMeta({});
      this.updateServerState({ installed: true, running: false, healthy: false, pid: null });
      if (!silent) {
        this.setMessage(response?.error || 'Failed to query server status.', true);
      }
      return;
    }

    const installed = response.installed !== false;
    this.updateServerMeta(response);
    this.renderNativeHostInstallBlock(installed);
    this.updateServerState({
      installed,
      running: Boolean(response.running),
      healthy: Boolean(response.healthy),
      pid: response.pid,
      portConflict: Boolean(response.portConflict),
      processPhase: response.processPhase || ''
    });
  }

  async refreshReleaseSurface(options = {}) {
    await this.refreshServerStatus(options);
    await this.refreshReleaseInfo(options);
  }

  async startServer() {
    if (this.serverBusy) return;
    const hfToken = this.getInputHfToken() || this.localSecrets.hfToken || '';
    this.setServerPhase('connecting');
    this.appendTerminalLine('Start requested. Initializing local GLiNER2 server...');
    this.setServerButtonsDisabled(true);
    const response = await this.requestServerControl('start', {
      installDeps: true,
      downloadModel: true,
      hfToken,
      modelId: this.selectedModel
    });
    this.setServerButtonsDisabled(false);

    if (!response?.success) {
      this.setServerPhase('disconnected');
      this.appendTerminalLine(`Start failed: ${response?.error || 'unknown error'}`);
      if (/auth|unauthorized|401|repository not found/i.test(String(response?.error || '')) && !hfToken) {
        this.setMessage('Model access failed. Add an HF token only if you are using a private or gated model.', true);
      } else {
        this.setMessage(response?.error || 'Unable to start server.', true);
      }
      await this.refreshServerStatus();
      await this.refreshServerLogs({ silent: true });
      return;
    }

    if (response.installed === false) {
      this.updateServerMeta(response);
      this.renderNativeHostInstallBlock(false);
      this.updateServerState({ installed: false, running: false, healthy: false, pid: null });
      this.setServerPhase('disconnected');
      this.appendTerminalLine('Start blocked: native host not installed.');
      this.setMessage(response.error || 'Native host is not installed.', true);
      await this.refreshServerLogs({ silent: true });
      return;
    }

    const installed = response.installed !== false;
    this.updateServerMeta(response);
    this.renderNativeHostInstallBlock(installed);
    this.updateServerState({
      installed,
      running: Boolean(response.running),
      healthy: Boolean(response.healthy),
      pid: response.pid,
      portConflict: Boolean(response.portConflict)
    });
    this.appendTerminalLine(response.message || 'Server started.');
    await this.refreshServerLogs({ silent: true });
    this.setMessage(response.message || 'Server started.');
  }

  async stopServer() {
    if (this.serverBusy) return;
    this.setServerPhase('disconnecting');
    this.appendTerminalLine('Stop requested. Shutting down local GLiNER2 server...');
    this.setServerButtonsDisabled(true);
    const response = await this.requestServerControl('stop');
    this.setServerButtonsDisabled(false);

    if (!response?.success) {
      this.appendTerminalLine(`Stop failed: ${response?.error || 'unknown error'}`);
      this.setMessage(response?.error || 'Unable to stop server.', true);
      await this.refreshServerStatus();
      await this.refreshServerLogs({ silent: true });
      return;
    }

    if (response.installed === false) {
      this.updateServerMeta(response);
      this.renderNativeHostInstallBlock(false);
      this.updateServerState({ installed: false, running: false, healthy: false, pid: null });
      this.setServerPhase('disconnected');
      this.appendTerminalLine('Stop completed. Native host not installed.');
      this.setMessage(response.error || 'Native host is not installed.', true);
      await this.refreshServerLogs({ silent: true });
      return;
    }

    const installed = response.installed !== false;
    this.updateServerMeta(response);
    this.renderNativeHostInstallBlock(installed);
    this.updateServerState({
      installed,
      running: Boolean(response.running),
      healthy: Boolean(response.healthy),
      pid: response.pid,
      portConflict: Boolean(response.portConflict)
    });
    this.appendTerminalLine(response.message || 'Server stopped.');
    await this.refreshServerLogs({ silent: true });
    this.setMessage(response.message || 'Server stopped.');
  }

  async restartServer() {
    if (this.serverBusy) return;
    const hfToken = this.getInputHfToken() || this.localSecrets.hfToken || '';
    this.setServerPhase('connecting');
    this.appendTerminalLine('Restart requested. Recycling local GLiNER2 server...');
    this.setServerButtonsDisabled(true);
    const response = await this.requestServerControl('restart', {
      installDeps: true,
      downloadModel: true,
      hfToken,
      modelId: this.selectedModel
    });
    this.setServerButtonsDisabled(false);

    if (!response?.success) {
      this.setServerPhase('disconnected');
      this.appendTerminalLine(`Restart failed: ${response?.error || 'unknown error'}`);
      this.setMessage(response?.error || 'Unable to restart server.', true);
      await this.refreshServerStatus();
      await this.refreshServerLogs({ silent: true });
      return;
    }

    const installed = response.installed !== false;
    this.updateServerMeta(response);
    this.renderNativeHostInstallBlock(installed);
    this.updateServerState({
      installed,
      running: Boolean(response.running),
      healthy: Boolean(response.healthy),
      pid: response.pid,
      portConflict: Boolean(response.portConflict)
    });
    this.appendTerminalLine(response.message || 'Server restarted.');
    await this.refreshServerLogs({ silent: true });
    this.setMessage(response.message || 'Server restarted.');
  }

  updateSetting(key, value) {
    this.settings[key] = value;
    chrome.storage.local.set({ [key]: value }, () => this.setMessage('Saved'));
    this.persistSyncedSettings();
  }

  // P2: mirror the non-sensitive settings subset to chrome.storage.sync (debounced).
  // Local stays the source of truth; a sync failure never breaks the local save, and
  // no secret/ledger/cache/stat is ever written here. Equal local+sync timestamps
  // keep the background apply-on-startup from clobbering a just-made local edit.
  persistSyncedSettings() {
    clearTimeout(this._syncWriteTimer);
    this._syncWriteTimer = setTimeout(() => this._writeSyncedSettings(), 500);
  }

  _writeSyncedSettings() {
    const ts = Date.now();
    const payload = { aiSafePluginSyncMeta: { updatedAt: ts } };
    for (const key of SYNCED_SETTING_KEYS) {
      const value = this.settings[key];
      if (value === undefined) continue;
      if (SYNC_CHUNKED_KEYS.includes(key)) {
        const { chunks, count } = chunkForSync(value);
        payload[`${key}__count`] = count;
        chunks.forEach((c, i) => { payload[`${key}__chunk${i}`] = c; });
      } else {
        payload[key] = value;
      }
    }
    try {
      chrome.storage.sync.set(payload, () => { void chrome.runtime.lastError; /* ignore quota/errors */ });
    } catch { /* sync unavailable — local remains authoritative */ }
    // Stamp local with the same ts so this device doesn't re-import its own write.
    chrome.storage.local.set({ aiSafePluginSettingsUpdatedAt: ts });
  }

  _safeHttpsUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' ? url : AI_SAFE_PLUGIN_RELEASE_PAGE_URL;
    } catch {
      return AI_SAFE_PLUGIN_RELEASE_PAGE_URL;
    }
  }

  escHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  parseLines(text) {
    return text
      .split(/\n|,/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  normalizePatterns(rawPatterns) {
    if (!Array.isArray(rawPatterns)) {
      throw new Error('Patterns must be a JSON array.');
    }

    return rawPatterns.map((pattern, index) => {
      if (!pattern || typeof pattern !== 'object') {
        throw new Error(`Pattern at index ${index} must be an object.`);
      }
      const label = String(pattern.label || '').trim().toLowerCase();
      const patternText = String(pattern.pattern || '');
      if (!label || !patternText) {
        throw new Error(`Pattern at index ${index} must include label and pattern.`);
      }
      if (label.length > 64) {
        throw new Error(`Pattern at index ${index}: label exceeds 64 characters.`);
      }
      if (patternText.length > 500) {
        throw new Error(`Pattern at index ${index}: regex exceeds 500 characters.`);
      }

      return {
        id: pattern.id ? String(pattern.id) : `custom_${index + 1}`,
        label,
        pattern: patternText,
        flags: pattern.flags ? String(pattern.flags) : 'g',
        score: typeof pattern.score === 'number' ? pattern.score : 0.96,
        replacement: pattern.replacement ? String(pattern.replacement).slice(0, 200) : null,
        enabled: pattern.enabled !== false
      };
    });
  }

  saveAdvancedConfig(showMessage = true) {
    try {
      const monitoredSites = this.parseLines(document.getElementById('monitoredSitesInput').value);
      const monitoredSelectors = this.parseLines(document.getElementById('selectorsInput').value);

      const payload = {
        monitoredSites: monitoredSites.length > 0 ? monitoredSites : DEFAULT_SETTINGS.monitoredSites,
        monitoredSelectors: monitoredSelectors.length > 0 ? monitoredSelectors : DEFAULT_SETTINGS.monitoredSelectors
      };

      this.settings = { ...this.settings, ...payload };
      chrome.storage.local.set(payload, () => {
        if (showMessage) {
          this.flashBtn('saveAdvancedButton', '✓ Saved');
          this.setMessage('Settings saved.');
        }
      });
      this.persistSyncedSettings();
    } catch (error) {
      this.setMessage(error.message || 'Invalid settings.', true);
    }
  }

  savePatterns() {
    const customPatterns = this.settings.customPatterns;
    chrome.storage.local.set({ customPatterns }, () => this.setMessage('Patterns saved.'));
    this.persistSyncedSettings();
  }

  addPatternFromForm() {
    const name = document.getElementById('newPatternName').value.trim();
    const regex = document.getElementById('newPatternRegex').value.trim();
    const replacement = document.getElementById('newPatternReplacement').value.trim();

    if (!name || !regex) {
      this.setMessage('Name and regex pattern are required.', true);
      return;
    }

    // Validate the regex
    try {
      new RegExp(regex, 'g');
    } catch {
      this.setMessage('Invalid regex pattern — check your syntax.', true);
      return;
    }

    const id = `custom_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}_${Date.now()}`;
    const newPattern = {
      id,
      label: name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
      pattern: regex,
      flags: 'g',
      score: 0.97,
      replacement: replacement || `[${name.toUpperCase()} REDACTED]`,
      enabled: true
    };

    this.settings.customPatterns = [...(this.settings.customPatterns || []), newPattern];
    this.renderPatternCards();
    this.savePatterns();

    // Reset and hide form
    document.getElementById('addPatternForm').hidden = true;
    document.getElementById('newPatternName').value = '';
    document.getElementById('newPatternRegex').value = '';
    document.getElementById('newPatternReplacement').value = '';
  }

  renderPatternCards() {
    const list = document.getElementById('patternCardsList');
    if (!list) return;

    const patterns = this.settings.customPatterns || [];
    if (patterns.length === 0) {
      list.innerHTML = '<p class="hint" style="text-align:center;padding:8px 0">No patterns yet.</p>';
      return;
    }

    const defaultIds = new Set(DEFAULT_CUSTOM_PATTERNS.map((p) => p.id));

    list.innerHTML = patterns.map((pattern, index) => {
      const isDefault = defaultIds.has(pattern.id);
      const displayName = PATTERN_NAMES[pattern.id]
        || pattern.id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      const labelBadge = String(pattern.label || '').replace(/_/g, ' ');
      const preview = pattern.pattern.length > 36
        ? `${pattern.pattern.slice(0, 36)}…`
        : pattern.pattern;

      return `<div class="pattern-card${pattern.enabled ? '' : ' pattern-card--off'}">
  <label class="pattern-toggle-wrap" title="${pattern.enabled ? 'Disable' : 'Enable'}">
    <input type="checkbox" class="pattern-cb" data-index="${index}"${pattern.enabled ? ' checked' : ''}>
    <span class="pattern-toggle-pill"></span>
  </label>
  <div class="pattern-card-body">
    <span class="pattern-card-name">${this.escHtml(displayName)}</span>
    <code class="pattern-card-preview">${this.escHtml(preview)}</code>
  </div>
  <span class="pattern-card-badge">${this.escHtml(labelBadge)}</span>
  ${!isDefault ? `<button class="pattern-card-del ghost compact" data-index="${index}" aria-label="Remove pattern" title="Remove">&#x2715;</button>` : ''}
</div>`;
    }).join('');

    list.querySelectorAll('.pattern-cb').forEach((cb) => {
      cb.addEventListener('change', () => {
        const idx = parseInt(cb.dataset.index, 10);
        this.settings.customPatterns[idx].enabled = cb.checked;
        cb.closest('.pattern-card').classList.toggle('pattern-card--off', !cb.checked);
        this.savePatterns();
      });
    });

    list.querySelectorAll('.pattern-card-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        this.settings.customPatterns.splice(idx, 1);
        this.renderPatternCards();
        this.savePatterns();
      });
    });
  }

  saveEntityTypes() {
    const customEntityTypes = this.settings.customEntityTypes || [];
    chrome.storage.local.set({ customEntityTypes }, () => this.setMessage('Custom detectors saved.'));
    this.persistSyncedSettings();
  }

  addEntityTypeFromForm() {
    const name = document.getElementById('newEntityName').value.trim();
    const description = document.getElementById('newEntityDescription').value.trim();

    if (!name || !description) {
      this.setMessage('Name and description are both required.', true);
      return;
    }

    const id = `entity_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}_${Date.now()}`;
    const newEntity = { id, name, description, enabled: true };

    this.settings.customEntityTypes = [...(this.settings.customEntityTypes || []), newEntity];
    this.renderEntityTypeCards();
    this.saveEntityTypes();

    document.getElementById('addEntityTypeForm').hidden = true;
    document.getElementById('newEntityName').value = '';
    document.getElementById('newEntityDescription').value = '';
  }

  renderEntityTypeCards() {
    const list = document.getElementById('entityTypeCardsList');
    if (!list) return;

    const types = this.settings.customEntityTypes || [];
    if (types.length === 0) {
      list.innerHTML = '<p class="hint" style="text-align:center;padding:8px 0">No custom detectors yet. Add one to teach GLiNER2 new entity types.</p>';
      return;
    }

    list.innerHTML = types.map((t, index) => {
      const name = this.escHtml(t.name);
      const desc = this.escHtml(String(t.description || '').slice(0, 48)) + (String(t.description || '').length > 48 ? '…' : '');
      return `<div class="pattern-card${t.enabled ? '' : ' pattern-card--off'}">
  <label class="pattern-toggle-wrap" title="${t.enabled ? 'Disable' : 'Enable'}">
    <input type="checkbox" class="entity-cb" data-index="${index}"${t.enabled ? ' checked' : ''}>
    <span class="pattern-toggle-pill"></span>
  </label>
  <div class="pattern-card-body">
    <span class="pattern-card-name">${name}</span>
    <code class="pattern-card-preview">${desc}</code>
  </div>
  <span class="pattern-card-badge">AI</span>
  <button class="entity-del ghost compact" data-index="${index}" aria-label="Remove" title="Remove">&#x2715;</button>
</div>`;
    }).join('');

    list.querySelectorAll('.entity-cb').forEach((cb) => {
      cb.addEventListener('change', () => {
        const idx = parseInt(cb.dataset.index, 10);
        this.settings.customEntityTypes[idx].enabled = cb.checked;
        cb.closest('.pattern-card').classList.toggle('pattern-card--off', !cb.checked);
        this.saveEntityTypes();
      });
    });

    list.querySelectorAll('.entity-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        this.settings.customEntityTypes.splice(idx, 1);
        this.renderEntityTypeCards();
        this.saveEntityTypes();
      });
    });
  }

  // ── Ignored values (U3): persistent per-site allowlist stored under
  //    `ai_safe_plugin::ignored::<host>` keys, managed here. ──
  static IGNORED_KEY_PREFIX = 'ai_safe_plugin::ignored::';

  async _readIgnoredValuesBySite() {
    const all = await new Promise((resolve) => chrome.storage.local.get(null, resolve));
    const bySite = {};
    for (const [key, val] of Object.entries(all || {})) {
      if (!key.startsWith(SettingsManager.IGNORED_KEY_PREFIX)) continue;
      const host = key.slice(SettingsManager.IGNORED_KEY_PREFIX.length);
      const entries = Array.isArray(val?.entries) ? val.entries : [];
      if (entries.length) bySite[host] = entries;
    }
    return bySite;
  }

  async renderIgnoredValuesCard() {
    const list = document.getElementById('ignoredValuesList');
    if (!list) return;
    const bySite = await this._readIgnoredValuesBySite();
    const hosts = Object.keys(bySite).sort();

    list.textContent = '';
    if (hosts.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.style.cssText = 'text-align:center;padding:8px 0';
      empty.textContent = 'No ignored values. Use "Ignore on this site" on a detection to add one.';
      list.appendChild(empty);
      return;
    }

    for (const host of hosts) {
      const group = document.createElement('div');
      group.className = 'ignored-site-group';

      const heading = document.createElement('div');
      heading.className = 'ignored-site-host';
      heading.textContent = host;
      group.appendChild(heading);

      bySite[host].forEach((entry, index) => {
        const row = document.createElement('div');
        row.className = 'pattern-card';

        const body = document.createElement('div');
        body.className = 'pattern-card-body';
        const name = document.createElement('span');
        name.className = 'pattern-card-name';
        name.textContent = entry.value;
        const preview = document.createElement('code');
        preview.className = 'pattern-card-preview';
        preview.textContent = String(entry.label || '').replace(/_/g, ' ');
        body.appendChild(name);
        body.appendChild(preview);
        row.appendChild(body);

        const del = document.createElement('button');
        del.className = 'entity-del ghost compact';
        del.setAttribute('aria-label', 'Remove');
        del.title = 'Remove';
        del.textContent = '✕';
        del.addEventListener('click', () => this.removeIgnoredValue(host, index));
        row.appendChild(del);

        group.appendChild(row);
      });

      list.appendChild(group);
    }
  }

  async removeIgnoredValue(host, index) {
    const key = SettingsManager.IGNORED_KEY_PREFIX + host;
    const stored = await new Promise((resolve) => chrome.storage.local.get([key], resolve));
    const entries = Array.isArray(stored[key]?.entries) ? stored[key].entries.slice() : [];
    if (index < 0 || index >= entries.length) return;
    entries.splice(index, 1);
    if (entries.length === 0) {
      await new Promise((resolve) => chrome.storage.local.remove(key, resolve));
    } else {
      await new Promise((resolve) => chrome.storage.local.set({ [key]: { entries, updatedAt: Date.now() } }, resolve));
    }
    this.renderIgnoredValuesCard();
  }

  async clearAllIgnoredValues() {
    const bySite = await this._readIgnoredValuesBySite();
    const keys = Object.keys(bySite).map((h) => SettingsManager.IGNORED_KEY_PREFIX + h);
    if (keys.length === 0) return;
    await new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
    this.renderIgnoredValuesCard();
    this.setMessage('Cleared all ignored values.');
  }

  async resetDefaults() {
    await chrome.storage.local.set(DEFAULT_SETTINGS);
    this.settings = { ...DEFAULT_SETTINGS };
    this.render();
    this.setMessage('Settings reset to defaults.');
  }

  /**
   * Full wipe of all AI-Safe Plugin browser-local data (H6). Uses a two-click confirm — the
   * first click arms the button for 5 s, the second performs the wipe — instead of
   * window.confirm. After clearing, defaults are re-seeded; content scripts react to
   * the storage change via their chrome.storage.onChanged listener.
   */
  async deleteAllAiSafePluginData() {
    const btn = document.getElementById('deleteAllDataButton');
    if (!btn) return;

    if (!this._deleteDataArmed) {
      this._deleteDataArmed = true;
      const original = btn.dataset.originalLabel || btn.textContent;
      btn.dataset.originalLabel = original;
      btn.textContent = 'Click again to confirm';
      this._deleteDataTimer = setTimeout(() => {
        this._deleteDataArmed = false;
        btn.textContent = btn.dataset.originalLabel || original;
      }, 5000);
      return;
    }

    if (this._deleteDataTimer) clearTimeout(this._deleteDataTimer);
    this._deleteDataArmed = false;
    btn.textContent = btn.dataset.originalLabel || 'Delete all AI-Safe Plugin data';

    await chrome.storage.local.clear();
    await chrome.storage.local.set(DEFAULT_SETTINGS);
    this.settings = { ...DEFAULT_SETTINGS };
    this.render();
    this.setMessage('All AI-Safe Plugin data deleted. Settings restored to defaults.');
  }

  setMessage(text, isError = false) {
    const bar = document.getElementById('messageBar');
    bar.textContent = text;
    bar.classList.toggle('error', isError);

    if (this.messageTimer) clearTimeout(this.messageTimer);

    const isOptionsPage = Boolean(document.getElementById('opt-main'));
    if (isError && isOptionsPage) {
      this.messageTimer = null;
      return;
    }
    this.messageTimer = setTimeout(() => {
      bar.textContent = '';
      bar.classList.remove('error');
    }, isError ? 5000 : 3200);
  }

  /** Temporarily change a button's label to confirm an action, then restore it. */
  flashBtn(id, confirmedLabel = '✓ Saved', ms = 2000) {
    const btn = document.getElementById(id);
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = confirmedLabel;
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, ms);
  }

  formatNumber(value) {
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
    return String(value);
  }
}

/* ══════════════════════════════════════════════════
   OnboardingWizard — first-run guided setup
══════════════════════════════════════════════════ */

class OnboardingWizard {
  constructor(settingsManager) {
    this.sm = settingsManager;
    this.currentStep = 0;
    this.hostPollTimer = null;
    this.hostDetected = false;
    this.overlay = document.getElementById('onboardingOverlay');
    if (!this.overlay) return;
    this.sm.wizard = this; // wire back so server state updates reach wizard
    this._bindEvents();
    this._checkAndShow();
  }

  _setVisible(visible) {
    if (!this.overlay) return;
    this.overlay.hidden = !visible;
    document.body.classList.toggle('onboarding-open', Boolean(visible));
  }

  async _checkAndShow() {
    const result = await new Promise((resolve) => chrome.storage.local.get(['aiSafePluginOnboardingDone'], resolve));
    if (result.aiSafePluginOnboardingDone) return;
    this._populateInstallCmd();
    this._goToStep(0);
    this._setVisible(true);
  }

  _populateInstallCmd() {
    const cmd = document.getElementById('onboardingInstallCmd');
    if (cmd) cmd.textContent = this.sm.getNativeHostInstallCommand();
  }

  _bindEvents() {
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };

    on('onboardingSkipBtn', () => this._finish());
    on('onboardingSkipHost', () => this._goToStep(2));
    on('onboardingSkipServer', () => this._finish());
    on('onboardingNextBtn0', () => this._goToStep(1));
    on('onboardingDoneBtn', () => this._finish());
    on('onboardingTryItBtn', () => {
      this._finish();
      try { chrome.tabs.create({ url: chrome.runtime.getURL('playground.html') }); } catch { }
    });

    on('onboardingCopyCmd', async () => {
      const cmd = document.getElementById('onboardingInstallCmd')?.textContent.trim() || '';
      try { await navigator.clipboard.writeText(cmd); } catch { }
      const btn = document.getElementById('onboardingCopyCmd');
      if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); }
    });

    on('onboardingCheckHost', () => {
      if (this.hostDetected) {
        this._goToStep(2);
        return;
      }
      this._pollHostNow();
    });

    on('onboardingStartServerBtn', async () => {
      const btn = document.getElementById('onboardingStartServerBtn');
      const statusEl = document.getElementById('onboardingServerStatus');
      if (btn) btn.disabled = true;
      if (statusEl) { statusEl.textContent = 'Starting server… (first run may take 30–60 s)'; statusEl.className = 'onboarding-status-note is-loading'; }
      await this.sm.startServer();
      if (btn) btn.disabled = false;
      this._updateServerStep();
    });
  }

  _goToStep(index) {
    this.currentStep = index;
    document.querySelectorAll('#onboardingOverlay .onboarding-step').forEach((step) => {
      const stepIndex = Number(step.dataset.step);
      step.hidden = stepIndex !== index;
    });
    document.querySelectorAll('#onboardingOverlay .onboarding-dot').forEach((dot) => {
      const dotIndex = Number(dot.dataset.step);
      dot.classList.toggle('is-active', dotIndex === index);
      dot.classList.toggle('is-done', dotIndex < index);
      dot.classList.remove('is-active');
      if (dotIndex === index) dot.classList.add('is-active');
      else if (dotIndex < index) dot.classList.add('is-done');
    });

    if (index === 1) {
      this._populateInstallCmd();
      this._setHostActionState(false);
      this._startHostPolling();
    } else {
      this._stopHostPolling();
    }

    if (index === 2) this._updateServerStep();
  }

  _setHostActionState(installed) {
    this.hostDetected = Boolean(installed);
    const button = document.getElementById('onboardingCheckHost');
    if (!button) return;
    button.textContent = installed ? 'Continue' : 'Check Again';
  }

  _startHostPolling() {
    this._pollHostNow();
    this.hostPollTimer = setInterval(() => this._pollHostNow(), 2500);
  }

  _stopHostPolling() {
    if (this.hostPollTimer) { clearInterval(this.hostPollTimer); this.hostPollTimer = null; }
  }

  async _pollHostNow() {
    const statusEl = document.getElementById('onboardingHostStatus');
    const response = await this.sm.requestServerControl('status');
    const installed = response?.installed !== false && response?.success !== false;
    this._setHostActionState(installed && response?.success);
    if (statusEl) {
      if (installed && response?.success) {
        statusEl.textContent = '✓ Native host detected. You can still copy the command above if you want it, then click Continue.';
        statusEl.className = 'onboarding-status-note is-ok';
        this._stopHostPolling();
      } else {
        statusEl.textContent = 'Native host not found yet. Run the command above and click Check Again.';
        statusEl.className = 'onboarding-status-note';
      }
    }
  }

  _updateServerStep() {
    const statusEl = document.getElementById('onboardingServerStatus');
    if (!statusEl) return;
    const state = this.sm.serverState;
    if (state.healthy) {
      statusEl.textContent = '✓ Local server is running!';
      statusEl.className = 'onboarding-status-note is-ok';
      setTimeout(() => this._goToStep(3), 800);
    } else if (state.running) {
      statusEl.textContent = 'Server process is starting — model loads in 15–30 s…';
      statusEl.className = 'onboarding-status-note is-loading';
    } else {
      statusEl.textContent = 'Server not started yet.';
      statusEl.className = 'onboarding-status-note';
    }
  }

  // Called by SettingsManager when server state updates while wizard is on step 2
  onServerStateUpdate() {
    if (this.overlay?.hidden) return;
    if (this.currentStep === 2) this._updateServerStep();
  }

  _finish() {
    this._stopHostPolling();
    chrome.storage.local.set({ aiSafePluginOnboardingDone: true });
    this._setVisible(false);
    this.sm.renderMaskHint();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // CSP-safe replacement for inline onerror handlers
  document.querySelectorAll('img[data-hide-on-error]').forEach(img => {
    img.addEventListener('error', () => { img.style.display = 'none'; });
  });

  const sm = new SettingsManager();
  window.__AI_SAFE_PLUGIN_SETTINGS_MANAGER__ = sm;
  new OnboardingWizard(sm);

  // Sidebar scroll-spy for options page
  const mainEl = document.getElementById('opt-main');
  if (mainEl) {
    const navItems = Array.from(document.querySelectorAll('.opt-nav-item[data-section]'));
    const sections = Array.from(document.querySelectorAll('.opt-section[id]'));
    const sectionPrefix = 'section-';
    const getScrollOffset = () => {
      const rawOffset = getComputedStyle(document.documentElement).getPropertyValue('--opt-section-scroll-offset');
      const parsedOffset = Number.parseFloat(rawOffset);
      return Number.isFinite(parsedOffset) ? parsedOffset : 112;
    };
    const getSectionName = (value = '') => value.startsWith(sectionPrefix) ? value.slice(sectionPrefix.length) : value;
    const setActive = (sectionName) => {
      navItems.forEach((item) => {
        item.classList.toggle('is-active', item.dataset.section === sectionName);
      });
    };
    const getSectionTop = (section) => (
      mainEl.scrollTop + section.getBoundingClientRect().top - mainEl.getBoundingClientRect().top
    );
    const activate = () => {
      if (!sections.length) return;
      const lastSection = sections[sections.length - 1];
      const lastSectionTop = getSectionTop(lastSection);
      const viewportBottom = mainEl.scrollTop + mainEl.clientHeight;
      if (lastSectionTop <= viewportBottom - 24) {
        setActive(getSectionName(lastSection.id));
        return;
      }

      const bottomSlack = Math.max(24, getScrollOffset());
      if (mainEl.scrollTop + mainEl.clientHeight >= mainEl.scrollHeight - bottomSlack) {
        setActive(getSectionName(lastSection.id));
        return;
      }

      const threshold = mainEl.scrollTop + getScrollOffset() + 24;
      let activeSection = sections[0];
      sections.forEach((section) => {
        if (getSectionTop(section) <= threshold) {
          activeSection = section;
        }
      });
      setActive(getSectionName(activeSection.id));
    };
    const scrollToSection = (sectionName, updateHash = true) => {
      const target = document.getElementById(`${sectionPrefix}${sectionName}`);
      if (!target) return;
      const nextTop = Math.max(0, getSectionTop(target) - getScrollOffset());
      mainEl.scrollTo({ top: nextTop, behavior: 'smooth' });
      setActive(sectionName);
      if (updateHash) {
        const nextHash = `#${sectionPrefix}${sectionName}`;
        if (window.history?.replaceState) {
          window.history.replaceState(null, '', nextHash);
        } else {
          window.location.hash = nextHash;
        }
      }
    };

    navItems.forEach((item) => {
      item.addEventListener('click', (event) => {
        event.preventDefault();
        scrollToSection(item.dataset.section);
      });
    });

    window.addEventListener('hashchange', () => {
      const sectionName = getSectionName(window.location.hash.replace(/^#/, ''));
      if (!sectionName || !navItems.some((item) => item.dataset.section === sectionName)) return;
      scrollToSection(sectionName, false);
    });

    mainEl.addEventListener('scroll', activate, { passive: true });
    requestAnimationFrame(() => {
      const initialSection = getSectionName(window.location.hash.replace(/^#/, ''));
      if (initialSection && navItems.some((item) => item.dataset.section === initialSection)) {
        scrollToSection(initialSection, false);
        return;
      }
      activate();
    });
  }
});
