import './pattern_catalog.js';

// background.js - Service worker for GLiNER2 management and local PII detection

const {
  cloneDefaultCustomPatterns,
  SYNCED_SETTING_KEYS,
  reassembleChunks,
} = globalThis.AI_SAFE_PLUGIN_PATTERN_CATALOG;

const SYNC_CHUNKED_KEYS = ['customPatterns', 'customEntityTypes'];

// P2: copy synced settings (chrome.storage.sync) into local when the synced copy
// is newer than this device's last local write. Content scripts then pick up the
// local change through their existing storage.onChanged reconciler. Local is the
// source of truth; we only import when another device's write is strictly newer.
async function applySyncedSettingsIfNewer() {
  try {
    const [syncData, localData] = await Promise.all([
      new Promise((resolve) => chrome.storage.sync.get(null, resolve)),
      new Promise((resolve) => chrome.storage.local.get(['aiSafePluginSettingsUpdatedAt'], resolve)),
    ]);
    const syncTs = Number(syncData?.aiSafePluginSyncMeta?.updatedAt) || 0;
    const localTs = Number(localData?.aiSafePluginSettingsUpdatedAt) || 0;
    if (syncTs <= localTs) return; // not newer (or our own write) → no-op, no loop

    const toApply = {};
    for (const key of SYNCED_SETTING_KEYS) {
      if (SYNC_CHUNKED_KEYS.includes(key)) {
        const count = Number(syncData[`${key}__count`]) || 0;
        if (count <= 0) continue;
        const parts = [];
        for (let i = 0; i < count; i++) parts.push(syncData[`${key}__chunk${i}`] ?? '');
        const value = reassembleChunks(parts);
        if (value !== undefined) toApply[key] = value;
      } else if (syncData[key] !== undefined) {
        toApply[key] = syncData[key];
      }
    }
    if (Object.keys(toApply).length === 0) return;
    toApply.aiSafePluginSettingsUpdatedAt = syncTs;
    await new Promise((resolve) => chrome.storage.local.set(toApply, resolve));
  } catch { /* sync unavailable — local remains authoritative */ }
}

const DEFAULT_LABELS = [
  'person',
  'email',
  'phone',
  'address',
  'ssn',
  'credit_card',
  'date_of_birth',
  'location',
  'organization'
];
const CORE_ENABLED_LABELS = new Set(DEFAULT_LABELS);

// GLiNER2 accepts labels as a Dict[internal_name → natural_language_description].
// The model uses the description for zero-shot embedding matching; it returns
// detections keyed by the dict key (internal name), so no reverse mapping is needed.
// Chunking is handled server-side via batch_extract_entities — one HTTP request per input.
const GLINER_LABEL_DESCRIPTIONS = Object.freeze({
  person: 'person name, first name, last name, or full name of a human individual',
  email: 'email address or email id used for electronic communication',
  phone: 'phone number, mobile number, telephone number, or contact number',
  address: 'street address, home address, residential or postal address, mailing address',
  ssn: 'social security number, national identification number, or government-issued ID number',
  credit_card: 'credit card number, debit card number, or payment card number',
  date_of_birth: 'date of birth, birthday, or birth date of a person',
  location: 'city, town, country, state, region, or geographic place name',
  organization: 'company name, organization name, employer, institution, or business name'
});

function scoreTier(score) {
  if (score >= 0.80) return 'high';
  if (score >= 0.60) return 'medium';
  return 'low';
}

function luhnCheck(digits) {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function compareDetectionPreference(current, next) {
  const currentLabel = String(current?.label || '').toLowerCase();
  const nextLabel = String(next?.label || '').toLowerCase();
  const sameSpan = current?.start === next?.start && current?.end === next?.end;
  const currentText = String(current?.text || '').trim().toLowerCase();
  const nextText = String(next?.text || '').trim().toLowerCase();
  const sameText = Boolean(currentText) && currentText === nextText;

  const labels = new Set([currentLabel, nextLabel]);
  if ((sameSpan || sameText) && labels.has('person') && labels.has('organization')) {
    return currentLabel === 'person' ? current : next;
  }

  const currentLength = (current?.end || 0) - (current?.start || 0);
  const nextLength = (next?.end || 0) - (next?.start || 0);
  if (next?.score > current?.score) return next;
  if (next?.score === current?.score && nextLength > currentLength) return next;
  return current;
}

function buildEntityThresholds(enabledTypes, sensitivity = 'medium') {
  const base = {
    ssn:           { low: 0.38, medium: 0.35, high: 0.30 },
    credit_card:   { low: 0.40, medium: 0.35, high: 0.30 },
    email:         { low: 0.50, medium: 0.42, high: 0.38 },
    phone:         { low: 0.55, medium: 0.45, high: 0.40 },
    date_of_birth: { low: 0.55, medium: 0.48, high: 0.42 },
    address:       { low: 0.60, medium: 0.52, high: 0.46 },
    organization:  { low: 0.72, medium: 0.62, high: 0.55 },
    person:        { low: 0.72, medium: 0.60, high: 0.50 },
    location:      { low: 0.70, medium: 0.58, high: 0.50 },
  };
  const sens = ['low', 'medium', 'high'].includes(sensitivity) ? sensitivity : 'medium';
  const result = {};
  for (const type of enabledTypes) {
    if (base[type]) result[type] = base[type][sens];
  }
  return Object.keys(result).length > 0 ? result : null;
}

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

const NATIVE_HOST_NAMES = ['com.ai_safe_plugin.gliner.server', 'com.privacyshield.gliner2'];
const MDP_SEED_STORAGE_KEY = 'aiSafePluginAnonymizationSeed';
const MDP_SEED_PREFIX = 'ai_safe_plugin_';
const DEFAULT_LOCAL_SERVER_URL = 'http://127.0.0.1:8765';
const LOCAL_SERVER_URL_OVERRIDE_KEY = 'aiSafePluginLocalServerUrlOverride';

// Maps AI-Safe Plugin detection labels → MayaData anonymisation engine utility parameters.
// Available MayaData UtilityParameter enum values:
//   IBAN, MATERIAL, CONSISTENT_ID, NUMBER, NAME, CLEAR, PHONE, URL, ADDRESS,
//   PASSPORT_NUMBER, ACCOUNT_NUMBER, EMAIL, BANK_DETAILS, ORG_NAME, SSN,
//   IP_ADDRESS, CUSTOM_EXPRESSION, DATE, FIXED_VALUE, TAX_ID, NO_CHANGE
const MDP_LABEL_CONFIG = Object.freeze({
  person: Object.freeze({
    columnName: 'Names',
    utilityParameter: 'NAME',
    utilityParameterConditions: Object.freeze(['NAME', 'REMOVE_UNDERSCORE'])
  }),
  email: Object.freeze({
    columnName: 'Emails',
    utilityParameter: 'EMAIL',
    utilityParameterConditions: Object.freeze(['KEEP_DOMAIN'])
  }),
  phone: Object.freeze({
    columnName: 'Phone',
    utilityParameter: 'PHONE',
    utilityParameterConditions: Object.freeze([])
  }),
  address: Object.freeze({
    columnName: 'Address',
    utilityParameter: 'ADDRESS',
    utilityParameterConditions: Object.freeze([])
  }),
  ssn: Object.freeze({
    columnName: 'SSN',
    utilityParameter: 'NUMBER',
    utilityParameterConditions: Object.freeze([])
  }),
  credit_card: Object.freeze({
    columnName: 'Credit Card',
    utilityParameter: 'BANK_DETAILS',
    utilityParameterConditions: Object.freeze([])
  }),
  date_of_birth: Object.freeze({
    columnName: 'Date Of Birth',
    utilityParameter: 'DATE',
    utilityParameterConditions: Object.freeze([])
  }),
  location: Object.freeze({
    columnName: 'Location',
    utilityParameter: 'ADDRESS',
    utilityParameterConditions: Object.freeze([])
  }),
  organization: Object.freeze({
    columnName: 'Organization',
    utilityParameter: 'ORG_NAME',
    utilityParameterConditions: Object.freeze([])
  }),
  api_key: Object.freeze({
    columnName: 'API Key',
    utilityParameter: 'CONSISTENT_ID',
    utilityParameterConditions: Object.freeze([])
  }),
  ip_address: Object.freeze({
    columnName: 'IP Address',
    utilityParameter: 'IP_ADDRESS',
    utilityParameterConditions: Object.freeze([])
  }),
  jwt: Object.freeze({
    columnName: 'JWT',
    utilityParameter: 'CONSISTENT_ID',
    utilityParameterConditions: Object.freeze([])
  }),
  pan: Object.freeze({
    columnName: 'PAN',
    utilityParameter: 'NUMBER',
    utilityParameterConditions: Object.freeze([])
  }),
  aadhaar: Object.freeze({
    columnName: 'Aadhaar',
    utilityParameter: 'NUMBER',
    utilityParameterConditions: Object.freeze([])
  }),
  passport: Object.freeze({
    columnName: 'Passport',
    utilityParameter: 'CONSISTENT_ID',
    utilityParameterConditions: Object.freeze([])
  }),
  ifsc: Object.freeze({
    columnName: 'IFSC',
    utilityParameter: 'CONSISTENT_ID',
    utilityParameterConditions: Object.freeze([])
  }),
  driver_license: Object.freeze({
    columnName: 'Driver License',
    utilityParameter: 'CONSISTENT_ID',
    utilityParameterConditions: Object.freeze([])
  }),
  mac_address: Object.freeze({
    columnName: 'MAC Address',
    utilityParameter: 'CONSISTENT_ID',
    utilityParameterConditions: Object.freeze([])
  }),
  bank_account: Object.freeze({
    columnName: 'Bank Account',
    utilityParameter: 'BANK_DETAILS',
    utilityParameterConditions: Object.freeze([])
  }),
  private_key: Object.freeze({
    columnName: 'Private Key',
    utilityParameter: 'CLEAR',
    utilityParameterConditions: Object.freeze([])
  }),
  connection_string: Object.freeze({
    columnName: 'Connection String',
    utilityParameter: 'URL',
    utilityParameterConditions: Object.freeze([])
  }),
  oauth_token: Object.freeze({
    columnName: 'OAuth Token',
    utilityParameter: 'CONSISTENT_ID',
    utilityParameterConditions: Object.freeze([])
  })
});

function normalizeLocalServerUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_LOCAL_SERVER_URL;

  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return DEFAULT_LOCAL_SERVER_URL;
    }
    return url.origin;
  } catch {
    return DEFAULT_LOCAL_SERVER_URL;
  }
}

function readConfiguredLocalServerUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get([LOCAL_SERVER_URL_OVERRIDE_KEY], (result) => {
      resolve(normalizeLocalServerUrl(result?.[LOCAL_SERVER_URL_OVERRIDE_KEY]));
    });
  });
}

class AiSafePluginAnonymizer {
  constructor() {
    this.timeoutMs = 6000;
    this.localServerUrl = DEFAULT_LOCAL_SERVER_URL;
  }

  setLocalServerUrl(url) {
    this.localServerUrl = normalizeLocalServerUrl(url);
  }

  async enrichDetections(detections, options = {}) {
    if (options?.redactionMode !== 'anonymize') {
      return detections;
    }
    if (!Array.isArray(detections) || detections.length === 0) {
      return detections;
    }

    const supportedDetections = detections.filter((item) => MDP_LABEL_CONFIG[String(item?.label || '').toLowerCase()]);
    const unsupportedLabels = Array.from(new Set(
      detections
        .map((item) => String(item?.label || '').toLowerCase())
        .filter((label) => label && !MDP_LABEL_CONFIG[label])
    ));
    if (unsupportedLabels.length > 0) {
      console.debug('[AI-Safe Plugin] Anonymizer skipped unsupported labels:', unsupportedLabels.join(', '));
    }
    if (supportedDetections.length === 0) {
      return detections;
    }

    const credentials = await this.getCredentials();
    if (!credentials.apiKey) {
      console.warn('[AI-Safe Plugin] Anonymizer skipped: no API key configured. Set one in the extension popup.');
      return detections;
    }

    const payload = this.buildPayload(supportedDetections, credentials.seed);
    if (payload.length === 0) {
      return detections;
    }

    try {
      const apiResponse = await this.callApi(credentials.apiKey, payload);
      const replacements = this.extractReplacementMap(payload, apiResponse);
      return detections.map((item) => this.applyReplacement(item, replacements));
    } catch (error) {
      console.warn('[AI-Safe Plugin] Anonymization bulk request failed, retrying per label:', error?.message || String(error));
      const replacements = await this.callApiBestEffort(credentials.apiKey, payload);
      if (replacements.size === 0) {
        return detections;
      }
      return detections.map((item) => this.applyReplacement(item, replacements));
    }
  }

  async getCredentials() {
    const result = await new Promise((resolve) => {
      chrome.storage.local.get(['aiSafePluginApiKey', MDP_SEED_STORAGE_KEY], resolve);
    });

    let seed = String(result?.[MDP_SEED_STORAGE_KEY] || '').trim();
    if (!seed) {
      seed = MDP_SEED_PREFIX + Math.random().toString(36).slice(2, 10);
      chrome.storage.local.set({ [MDP_SEED_STORAGE_KEY]: seed });
    }

    return {
      apiKey: String(result?.aiSafePluginApiKey || '').trim(),
      seed
    };
  }

  buildPayload(detections, seed) {
    const grouped = new Map();

    detections.forEach((item) => {
      const label = String(item?.label || '').toLowerCase();
      const config = MDP_LABEL_CONFIG[label];
      if (!config) return;
      const value = String(item?.text || '').trim();
      if (!value) return;

      let entry = grouped.get(label);
      if (!entry) {
        entry = {
          column_name: config.columnName,
          utilityParameter: config.utilityParameter,
          utilityParameterConditions: [...config.utilityParameterConditions],
          seed,
          values: []
        };
        grouped.set(label, entry);
      }

      if (!entry.values.includes(value)) {
        entry.values.push(value);
      }
    });

    return Array.from(grouped.values());
  }

  async callApi(apiKey, payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body = JSON.stringify({ entries: payload });
      const doFetch = async () => fetch(`${this.localServerUrl}/anonymize`, {
        method: 'POST',
        headers: await localServerHeaders({
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        }),
        body,
        signal: controller.signal
      });
      let response = await doFetch();
      if (response.status === 401 && aiSafePluginAuthRequired) {
        await refreshServerToken();
        response = await doFetch();
      }

      let data = null;
      try {
        data = await response.json();
      } catch {
        throw new Error('Local anonymization proxy returned invalid JSON.');
      }

      if (data?.ok === false) {
        throw new Error(String(data.error || 'Local anonymization proxy failed.'));
      }
      if (!response.ok) {
        throw new Error(`Local anonymization proxy returned status ${response.status}.`);
      }

      if (Array.isArray(data?.data)) return data.data;
      if (Array.isArray(data?.result)) return data.result;

      const upstream = data?.data;
      if (Array.isArray(upstream?.data)) return upstream.data;
      if (Array.isArray(upstream?.result)) return upstream.result;
      if (Array.isArray(upstream?.results)) return upstream.results;
      if (Array.isArray(upstream)) return upstream;

      if (Array.isArray(data)) return data;
      return [];
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async callApiBestEffort(apiKey, payload) {
    const merged = new Map();
    for (const entry of payload) {
      try {
        const apiResponse = await this.callApi(apiKey, [entry]);
        const replacementMap = this.extractReplacementMap([entry], apiResponse);
        replacementMap.forEach((value, key) => merged.set(key, value));
      } catch (error) {
        const label = String(entry?.utilityParameter || entry?.column_name || 'unknown');
        console.warn(`[AI-Safe Plugin] Anonymizer skipped label ${label}:`, error?.message || String(error));
      }
    }
    return merged;
  }

  extractReplacementMap(payload, apiResponse) {
    const replacementMap = new Map();
    const rows = this.extractRows(apiResponse);

    // MayaData format:
    // [{ column_name, anonymizedValues: { "John Doe": { anonymizedValue: "..." } } }, ...]
    rows.forEach((row) => {
      if (!row || typeof row !== 'object') return;
      const map = row.anonymizedValues;
      if (!map || typeof map !== 'object' || Array.isArray(map)) return;
      Object.entries(map).forEach(([sourceValue, detail]) => {
        const source = String(sourceValue || '').trim();
        const replacement = this.normalizeResponseValue(detail?.anonymizedValue ?? detail).trim();
        if (!source || !replacement || replacement === source) return;
        replacementMap.set(this.makeAnyMapKey(source), replacement);
      });
    });

    payload.forEach((requestRow, index) => {
      const sourceValues = Array.isArray(requestRow.values) ? requestRow.values : [];
      const responseRow = rows[index];
      const mappedValues = this.extractValuesArray(responseRow);

      sourceValues.forEach((sourceValue, valueIndex) => {
        const replacement = String(mappedValues[valueIndex] || '').trim();
        if (!replacement || replacement === sourceValue) return;
        replacementMap.set(this.makeMapKey(requestRow.utilityParameter, sourceValue), replacement);
      });
    });

    return replacementMap;
  }

  extractRows(apiResponse) {
    if (Array.isArray(apiResponse)) return apiResponse;
    if (!apiResponse || typeof apiResponse !== 'object') return [];

    const candidates = [
      apiResponse.data,
      apiResponse.results,
      apiResponse.result,
      apiResponse.outputs
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate;
    }
    return [];
  }

  extractValuesArray(responseRow) {
    if (Array.isArray(responseRow)) {
      return responseRow.map((item) => this.normalizeResponseValue(item));
    }
    if (!responseRow || typeof responseRow !== 'object') {
      return [];
    }

    const keys = [
      'values',
      'anonymized_values',
      'anonymizedValues',
      'outputValues',
      'outputs',
      'result',
      'results'
    ];

    for (const key of keys) {
      if (Array.isArray(responseRow[key])) {
        return responseRow[key].map((item) => this.normalizeResponseValue(item));
      }
    }

    if (responseRow.data && typeof responseRow.data === 'object') {
      for (const key of keys) {
        if (Array.isArray(responseRow.data[key])) {
          return responseRow.data[key].map((item) => this.normalizeResponseValue(item));
        }
      }
    }

    return [];
  }

  normalizeResponseValue(item) {
    if (typeof item === 'string' || typeof item === 'number') {
      return String(item);
    }
    if (!item || typeof item !== 'object') {
      return '';
    }

    const keys = [
      'anonymized',
      'anonymizedValue',
      'anonymized_value',
      'output',
      'value',
      'masked',
      'maskedValue'
    ];

    for (const key of keys) {
      if (item[key] == null) continue;
      return String(item[key]);
    }

    return '';
  }

  applyReplacement(item, replacementMap) {
    const label = String(item?.label || '').toLowerCase();
    const config = MDP_LABEL_CONFIG[label];
    if (!config) return item;

    const sourceValue = String(item?.text || '').trim();
    if (!sourceValue) return item;

    const replacement = replacementMap.get(this.makeMapKey(config.utilityParameter, sourceValue))
      || replacementMap.get(this.makeAnyMapKey(sourceValue));
    if (!replacement) return item;

    return {
      ...item,
      anonymizedText: replacement
    };
  }

  makeMapKey(utilityParameter, value) {
    return `${utilityParameter}\u0000${value}`;
  }

  makeAnyMapKey(value) {
    return `*\u0000${value}`;
  }
}

function getDefaultCustomPatterns() {
  return cloneDefaultCustomPatterns();
}

function isNativeHostMissingError(message) {
  const text = String(message || '').toLowerCase();
  return (
    (text.includes('native messaging host') &&
      (text.includes('not found') || text.includes('not registered'))) ||
    (text.includes('native messaging') && text.includes('forbidden')) ||
    (text.includes('access to the specified native messaging host is forbidden'))
  );
}

function sendNativeHostMessage(payload) {
  const tryHost = (index) => new Promise((resolve, reject) => {
    const hostName = NATIVE_HOST_NAMES[index];
    if (!hostName) {
      reject(new Error('No response from native host.'));
      return;
    }

    try {
      chrome.runtime.sendNativeMessage(hostName, payload, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          const error = new Error(lastError.message);
          if (isNativeHostMissingError(error.message) && index < NATIVE_HOST_NAMES.length - 1) {
            resolve(tryHost(index + 1));
            return;
          }
          reject(error);
          return;
        }
        if (!response) {
          reject(new Error('No response from native host.'));
          return;
        }
        if (response.success === false) {
          reject(new Error(response.error || 'Native host command failed.'));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });

  return tryHost(0);
}

// ─── Local-server shared token (H2) ──────────────────────────────────────────
// The local server generates a token and the native host hands it to us. We
// attach it as X-AI-Safe-Plugin-Token on detection POSTs. When the server reports
// authRequired:false (old servers / --no-auth / the e2e mock) we skip all of this.
const SERVER_TOKEN_STORAGE_KEY = 'aiSafePluginServerToken';
let aiSafePluginServerToken = null;
let aiSafePluginAuthRequired = false;

async function loadCachedServerToken() {
  if (aiSafePluginServerToken) return aiSafePluginServerToken;
  try {
    const stored = await chrome.storage.local.get(SERVER_TOKEN_STORAGE_KEY);
    if (stored && stored[SERVER_TOKEN_STORAGE_KEY]) {
      aiSafePluginServerToken = stored[SERVER_TOKEN_STORAGE_KEY];
    }
  } catch (_e) { /* storage unavailable — non-fatal */ }
  return aiSafePluginServerToken;
}

async function refreshServerToken() {
  try {
    const response = await sendNativeHostMessage({ action: 'get_server_token' });
    if (response && response.token) {
      aiSafePluginServerToken = response.token;
      try { await chrome.storage.local.set({ [SERVER_TOKEN_STORAGE_KEY]: aiSafePluginServerToken }); } catch (_e) { /* non-fatal */ }
      return aiSafePluginServerToken;
    }
  } catch (_e) { /* native host unavailable — caller surfaces setup-needed state */ }
  return null;
}

async function getServerToken() {
  const cached = await loadCachedServerToken();
  if (cached) return cached;
  return refreshServerToken();
}

// Build request headers for a local-server POST, adding the token when required.
async function localServerHeaders(base = {}) {
  const headers = { ...base };
  if (aiSafePluginAuthRequired) {
    const token = await getServerToken();
    if (token) headers['X-AI-Safe-Plugin-Token'] = token;
  }
  return headers;
}

class GLiNERDetector {
  constructor() {
    this.isLoading = false;
    this.isReady = false;
    this.mode = 'regex-fallback';
    this.localServerUrl = DEFAULT_LOCAL_SERVER_URL;
    this.lastServerCheckTs = 0;
    this.serverCheckCooldownMs = 2500;
    this.labels = DEFAULT_LABELS;
  }

  setLocalServerUrl(url) {
    this.localServerUrl = normalizeLocalServerUrl(url);
  }

  async initialize(force = false) {
    if (this.isReady && !force) return;
    if (this.isLoading) {
      while (this.isLoading) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return;
    }

    this.isLoading = true;
    try {
      this.setLocalServerUrl(await readConfiguredLocalServerUrl());
      await this.refreshMode();
      this.isReady = true;
    } finally {
      this.isLoading = false;
    }
  }

  async refreshMode() {
    const now = Date.now();
    if (now - this.lastServerCheckTs < this.serverCheckCooldownMs && this.isReady) {
      return;
    }
    this.lastServerCheckTs = now;
    this.mode = (await this.pingLocalServer()) ? 'gliner2-local' : 'regex-fallback';
  }

  async pingLocalServer() {
    try {
      const response = await this.fetchWithTimeout(`${this.localServerUrl}/health`, { method: 'GET' }, 1400);
      if (!response.ok) return false;
      const data = await response.json();
      // Track whether this server enforces the shared token so detection POSTs
      // can attach it. Old servers / the mock omit the field → treated as false.
      aiSafePluginAuthRequired = Boolean(data?.authRequired);
      return Boolean(data?.ok);
    } catch {
      return false;
    }
  }

  async fetchWithTimeout(url, options, timeoutMs, externalSignal = null) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    // Propagate external cancellation (e.g. per-tab abort) into this request
    const onExternalAbort = () => controller.abort();
    if (externalSignal) externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }

  async detectPII(text, options = {}, signal = null) {
    await this.initialize();

    const threshold = typeof options.threshold === 'number' ? options.threshold : 0.5;
    const enabledTypes = Array.isArray(options.enabledTypes) && options.enabledTypes.length > 0
      ? options.enabledTypes
      : this.labels;
    const customPatterns = Array.isArray(options.customPatterns)
      ? options.customPatterns
      : getDefaultCustomPatterns();
    const customEntityTypes = Array.isArray(options.customEntityTypes)
      ? options.customEntityTypes.filter((t) => t && t.enabled && t.id && t.description)
      : [];
    const includeRegexWhenModelOnline = Boolean(options.includeRegexWhenModelOnline);

    if (!text || text.trim().length === 0) {
      return [];
    }

    const detections = [];
    let modelOnline = false;
    if (this.mode === 'gliner2-local') {
      try {
        detections.push(...await this.detectWithLocalGLiNER(text, enabledTypes, threshold, customEntityTypes, options.sensitivity || 'medium', signal));
        modelOnline = true;
      } catch (error) {
        if (error.name === 'AbortError') throw error; // propagate cancellation up
        console.warn('Local GLiNER2 server unavailable, using fallback detection:', error.message);
        this.mode = 'regex-fallback';
      }
    }

    const shouldRunRegexDetectors = !modelOnline || includeRegexWhenModelOnline;
    if (shouldRunRegexDetectors) {
      detections.push(...this.detectWithRegex(text, enabledTypes, threshold));
      detections.push(...this.detectWithCustomPatterns(text, customPatterns, threshold, enabledTypes));
    }

    return this.mergeAdjacentSameLabel(
      this.mergeOverlapping(this.postProcessDetections(detections, threshold)),
      text
    );
  }

  detectFastLocalProtection(text, options = {}) {
    const threshold = typeof options.threshold === 'number' ? options.threshold : 0.5;
    const enabledTypes = Array.isArray(options.enabledTypes) && options.enabledTypes.length > 0
      ? options.enabledTypes
      : this.labels;
    const customPatterns = Array.isArray(options.customPatterns)
      ? options.customPatterns
      : getDefaultCustomPatterns();

    if (!text || text.trim().length === 0) {
      return [];
    }

    const detections = [
      ...this.detectWithRegex(text, enabledTypes, threshold),
      ...this.detectWithCustomPatterns(text, customPatterns, threshold, enabledTypes)
    ];

    return this.mergeAdjacentSameLabel(
      this.mergeOverlapping(this.postProcessDetections(detections, threshold)),
      text
    );
  }

  postProcessDetections(detections, threshold) {
    const baseThreshold = typeof threshold === 'number' ? threshold : 0.5;
    const minByLabel = {
      person: Math.max(baseThreshold, 0.72),
      organization: Math.max(baseThreshold, 0.74),
      location: Math.max(baseThreshold, 0.66),
      address: Math.max(baseThreshold, 0.64),
      date_of_birth: Math.max(baseThreshold, 0.6)
    };
    const organizationKeywordPattern = /\b(inc|inc\.|llc|ltd|ltd\.|corp|corp\.|corporation|company|co\.|university|college|bank|labs?|group|systems?|studio|technologies?|tech|solutions?|partners?|foundation|agency|associates?|ventures?|industries?|institute|ministry|department|hospital|school)\b/i;
    const personStopwords = new Set([
      'you',
      'your',
      'yours',
      'i',
      'me',
      'my',
      'mine',
      'we',
      'our',
      'ours',
      'they',
      'their',
      'theirs',
      'this',
      'that',
      'these',
      'those',
      'hello',
      'thanks',
      'please',
      'assistant',
      'model',
      'server',
      'privacy',
      'shield'
    ]);

    return detections.filter((item) => {
      if (!item || typeof item !== 'object') return false;
      if (typeof item.start !== 'number' || typeof item.end !== 'number') return false;
      if (item.end <= item.start) return false;
      if (typeof item.score !== 'number') return false;

      const text = String(item.text || '');
      const label = String(item.label || '').toLowerCase();
      if (!text.trim()) return false;
      if (item.score < (minByLabel[label] || baseThreshold)) return false;

      if (label === 'person') {
        if (text.length < 4) return false;
        if (/^[A-Z\s]+$/.test(text)) return false;
        const words = text.trim().split(/\s+/).filter(Boolean);
        if (words.length === 0 || words.length > 3) return false;
        if (words.some((word) => /\d/.test(word))) return false;
        if (words.length === 1) {
          const token = words[0];
          if (token.length < 5) return false;
          if (personStopwords.has(token.toLowerCase())) return false;
          if (!/^[A-Z][A-Za-z'`.-]*$/.test(token)) return false;
        } else {
          if (words.some((word) => !/^[A-Z][A-Za-z'`.-]*$/.test(word))) return false;
        }
      }

      if (label === 'organization') {
        if (text.length < 3) return false;
        const lower = text.toLowerCase();
        const words = text.trim().split(/\s+/).filter(Boolean);
        const hasKeyword = organizationKeywordPattern.test(lower);
        const isAcronymLike = /^[A-Z0-9&.-]{2,10}$/.test(text.trim());
        if (/^[a-z\s]+$/.test(text) && !hasKeyword) {
          return false;
        }
        if (words.length === 1 && !hasKeyword && !isAcronymLike) return false;
        if (words.length <= 2 && words.every((word) => /^[A-Z][A-Za-z'`.-]*$/.test(word)) && !hasKeyword && !isAcronymLike) {
          return false;
        }
      }

      if (label === 'location') {
        if (text.length < 3) return false;
        if (!/[A-Z]/.test(text.charAt(0)) && text.trim().split(/\s+/).length === 1) return false;
      }

      if (label === 'address') {
        const hasStreetNumber = /\d/.test(text);
        const hasStreetWord = /\b(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way)\b/i.test(text);
        if (!hasStreetNumber && !hasStreetWord) return false;
      }

      return true;
    });
  }

  async warmUpIfAvailable() {
    await this.initialize(true);
    if (this.mode !== 'gliner2-local') return false;
    try {
      await this.detectWithLocalGLiNER(
        'Warmup: contact warmup@example.com',
        ['email'],
        0.95
      );
      return true;
    } catch (error) {
      console.debug('Warmup request failed:', error.message);
      return false;
    }
  }

  async detectWithLocalGLiNER(text, enabledTypes, threshold, customEntityTypes = [], sensitivity = 'medium', signal = null) {
    // Build labels dict: {internal_name: description}.
    // GLiNER2 uses the description for zero-shot embedding matching and returns
    // detections keyed by the internal name — no reverse mapping needed.
    // Chunking is handled server-side via batch_extract_entities.
    const labels = {};
    for (const type of enabledTypes) {
      labels[type] = GLINER_LABEL_DESCRIPTIONS[type] || type;
    }
    // Merge user-defined custom entity types — user describes what to find in plain English
    for (const entity of customEntityTypes) {
      labels[entity.id] = entity.description;
    }

    const thresholds = buildEntityThresholds(enabledTypes, sensitivity);
    const requestBody = { text, labels, threshold };
    if (thresholds) requestBody.thresholds = thresholds;

    const body = JSON.stringify(requestBody);
    const doFetch = async () => this.fetchWithTimeout(
      `${this.localServerUrl}/detect`,
      {
        method: 'POST',
        headers: await localServerHeaders({ 'Content-Type': 'application/json' }),
        body
      },
      8000,  // longer timeout — server may be chunking + batching long inputs
      signal
    );
    let response = await doFetch();
    if (response.status === 401 && aiSafePluginAuthRequired) {
      await refreshServerToken();
      response = await doFetch();
    }

    if (!response.ok) {
      throw new Error(`GLiNER2 server returned status ${response.status}`);
    }

    const data = await response.json();
    return (Array.isArray(data?.detections) ? data.detections : [])
      .map((row) => this.normalizeDetection(row, text, 'gliner2'))
      .filter(Boolean)
      .filter((row) => row.score >= threshold);
  }

  normalizeDetection(row, sourceText, source) {
    if (!row || typeof row !== 'object') return null;
    const label = String(row.label || '').trim().toLowerCase();
    if (!label) return null;

    let start = Number.isInteger(row.start) ? row.start : -1;
    let end = Number.isInteger(row.end) ? row.end : -1;
    const entityText = String(row.text || '');

    if (start < 0 || end <= start) {
      const inferredStart = entityText ? sourceText.indexOf(entityText) : -1;
      if (inferredStart < 0) return null;
      start = inferredStart;
      end = inferredStart + entityText.length;
    }

    if (start < 0 || end > sourceText.length || end <= start) return null;

    const score = typeof row.score === 'number' ? row.score : 0.0;
    return {
      text: sourceText.slice(start, end),
      label,
      start,
      end,
      score,
      source,
      replacement: row.replacement ? String(row.replacement) : null,
      tier: row.tier || scoreTier(score),
    };
  }

  detectWithRegex(text, enabledTypes, threshold) {
    const detections = [];
    const push = (match, label, score) => {
      detections.push({
        text: match[0],
        label,
        start: match.index,
        end: match.index + match[0].length,
        score,
        source: 'fallback'
      });
    };

    if (enabledTypes.includes('email')) {
      const regex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
      let match;
      while ((match = regex.exec(text)) !== null) push(match, 'email', 0.95);
    }

    if (enabledTypes.includes('phone')) {
      const regex = /(?<![A-Za-z0-9])(?:\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;
      let match;
      while ((match = regex.exec(text)) !== null) push(match, 'phone', 0.9);
    }

    if (enabledTypes.includes('address')) {
      const regex = /\b\d+\s+[A-Z][a-z]+\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way)\b/gi;
      let match;
      while ((match = regex.exec(text)) !== null) push(match, 'address', 0.84);
    }

    if (enabledTypes.includes('credit_card')) {
      const regex = /\b(?:\d[ -]*?){13,16}\b/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const digits = match[0].replace(/\D/g, '');
        if (digits.length >= 13 && digits.length <= 16 && luhnCheck(digits)) {
          push(match, 'credit_card', 0.9);
        }
      }
    }

    if (enabledTypes.includes('date_of_birth')) {
      const regex = /\b(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])[/-](?:19|20)\d{2}\b/g;
      let match;
      while ((match = regex.exec(text)) !== null) push(match, 'date_of_birth', 0.87);
    }

    if (enabledTypes.includes('person')) {
      // Disabled by default due high false positives.
    }

    // Indian PAN number: 5 uppercase letters, 4 digits, 1 uppercase letter (e.g. ABCDE1234F)
    if (enabledTypes.includes('pan')) {
      const regex = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g;
      let match;
      while ((match = regex.exec(text)) !== null) push(match, 'pan', 0.98);
    }

    // Indian Aadhaar: 12-digit number, optionally space/hyphen separated in groups of 4
    if (enabledTypes.includes('aadhaar')) {
      const regex = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g;
      let match;
      while ((match = regex.exec(text)) !== null) push(match, 'aadhaar', 0.95);
    }

    return detections.filter((item) => item.score >= threshold);
  }

  detectWithCustomPatterns(text, patterns, threshold, enabledTypes = this.labels) {
    const detections = [];
    const enabledLabelSet = new Set(
      (Array.isArray(enabledTypes) ? enabledTypes : this.labels)
        .map((type) => String(type || '').trim().toLowerCase())
        .filter(Boolean)
    );
    patterns
      .filter((patternDef) => patternDef && typeof patternDef === 'object' && patternDef.enabled !== false)
      .forEach((patternDef) => {
        const label = String(patternDef.label || 'custom').trim().toLowerCase();
        const pattern = String(patternDef.pattern || '');
        const flags = this.normalizeRegexFlags(patternDef.flags);
        const score = typeof patternDef.score === 'number' ? patternDef.score : 0.96;
        const replacement = patternDef.replacement ? String(patternDef.replacement) : null;

        if (!label || !pattern) return;
        if (CORE_ENABLED_LABELS.has(label) && !enabledLabelSet.has(label)) return;

        let regex;
        try {
          regex = new RegExp(pattern, flags);
        } catch {
          return;
        }

        const MAX_CUSTOM_MATCHES = 1000;
        let matchCount = 0;
        let match;
        while ((match = regex.exec(text)) !== null) {
          if (!match[0]) {
            regex.lastIndex += 1;
            continue;
          }
          if (++matchCount > MAX_CUSTOM_MATCHES) break; // ReDoS guard
          detections.push({
            text: match[0],
            label,
            start: match.index,
            end: match.index + match[0].length,
            score,
            source: 'custom',
            replacement
          });
        }
      });

    return detections.filter((item) => item.score >= threshold);
  }

  async classifyText(text) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    try {
      const body = JSON.stringify({ text });
      const doFetch = async () => fetch(`${this.localServerUrl}/classify`, {
        method: 'POST',
        headers: await localServerHeaders({ 'Content-Type': 'application/json' }),
        body,
        signal: controller.signal,
      });
      let response = await doFetch();
      if (response.status === 401 && aiSafePluginAuthRequired) {
        await refreshServerToken();
        response = await doFetch();
      }
      if (!response.ok) return null;
      const data = await response.json();
      return data?.ok ? { sensitivity: data.sensitivity, score: data.score, label: data.label } : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  normalizeRegexFlags(flags) {
    const raw = String(flags || 'g');
    const filtered = raw.replace(/[^dgimsuvy]/g, '');
    return filtered.includes('g') ? filtered : `${filtered}g`;
  }

  mergeAdjacentSameLabel(detections, originalText) {
    if (detections.length <= 1) return detections;
    const result = [];
    let current = { ...detections[0] };
    for (let i = 1; i < detections.length; i++) {
      const next = detections[i];
      if (
        current.label === next.label &&
        next.start >= current.end &&
        /^\s*$/.test(originalText.slice(current.end, next.start))
      ) {
        current = {
          ...current,
          end: next.end,
          text: originalText.slice(current.start, next.end),
          score: Math.max(current.score, next.score)
        };
      } else {
        result.push(current);
        current = { ...next };
      }
    }
    result.push(current);
    return result;
  }

  mergeOverlapping(detections) {
    if (detections.length === 0) return [];
    detections.sort((a, b) => a.start - b.start || b.score - a.score);

    const merged = [];
    let current = detections[0];
    for (let index = 1; index < detections.length; index += 1) {
      const next = detections[index];
      const overlap = next.start < current.end;
      if (!overlap) {
        merged.push(current);
        current = next;
        continue;
      }
      current = compareDetectionPreference(current, next);
    }
    merged.push(current);
    return merged;
  }
}

const detector = new GLiNERDetector();
const anonymizer = new AiSafePluginAnonymizer();

async function syncConfiguredLocalServerUrl() {
  const url = await readConfiguredLocalServerUrl();
  detector.setLocalServerUrl(url);
  anonymizer.setLocalServerUrl(url);
  return url;
}

// Per-tab AbortControllers — cancels any stale in-flight detection when the same
// tab fires a new detectPII request (e.g. fast typing across multiple tabs).
const activeDetectionControllers = new Map(); // tabId → AbortController

// ─── Server crash detection ───────────────────────────────────────────────────
let prevServerHealthy = null; // null = unknown, true/false = last known state

async function broadcastToTabs(message) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') continue;
      chrome.tabs.sendMessage(tab.id, message).catch(() => { }); // ignore unresponsive tabs
    }
  } catch { /* ignore */ }
}

const COMMAND_ACTIONS = Object.freeze({
  'ai-safe-plugin-redact-all': 'commandRedactAll',
  'ai-safe-plugin-toggle': 'commandToggleSite'
});

async function sendCommandToActiveTab(action) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    if (typeof tabId !== 'number') return;
    chrome.tabs.sendMessage(tabId, { action }).catch(() => { });
  } catch { /* ignore */ }
}

if (chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    const action = COMMAND_ACTIONS[command];
    if (action) {
      sendCommandToActiveTab(action);
    }
  });
}

async function checkServerHealthAndNotify() {
  let isHealthy = false;
  try {
    const localServerUrl = await syncConfiguredLocalServerUrl();
    const response = await fetch(`${localServerUrl}/health`, { method: 'GET', signal: AbortSignal.timeout(2000) });
    if (response.ok) {
      const data = await response.json();
      isHealthy = Boolean(data?.ok);
      aiSafePluginAuthRequired = Boolean(data?.authRequired);
    }
  } catch { /* server unreachable */ }

  if (prevServerHealthy === true && !isHealthy) {
    // Server was healthy, now it's offline — crashed!
    prevServerHealthy = false;
    broadcastToTabs({ action: 'serverCrashed' });
  } else if (prevServerHealthy === false && isHealthy) {
    // Server restored
    prevServerHealthy = true;
    broadcastToTabs({ action: 'serverRestored' });
  } else if (prevServerHealthy === null) {
    prevServerHealthy = isHealthy;
  }
}

// Poll every 5 seconds to detect crashes between popup refreshes
setInterval(checkServerHealthAndNotify, 5000);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!changes[LOCAL_SERVER_URL_OVERRIDE_KEY]) return;
  const nextValue = changes[LOCAL_SERVER_URL_OVERRIDE_KEY]?.newValue;
  detector.setLocalServerUrl(nextValue);
  anonymizer.setLocalServerUrl(nextValue);
  detector.isReady = false;
  detector.mode = 'regex-fallback';
  detector.lastServerCheckTs = 0;
});


async function handleServerControl(command, options = {}) {
  try {
    if (command === 'status') {
      const response = await sendNativeHostMessage({ action: 'status' });
      return { success: true, ...response };
    }

    if (command === 'logs') {
      const response = await sendNativeHostMessage({
        action: 'logs',
        lines: typeof options.lines === 'number' ? options.lines : 120
      });
      return { success: true, ...response };
    }

    if (command === 'start') {
      const hfToken = typeof options.hfToken === 'string' ? options.hfToken.trim() : '';
      const modelId = typeof options.modelId === 'string' ? options.modelId.trim() : '';
      const payload = {
        action: 'start',
        installDeps: options.installDeps !== false,
        downloadModel: options.downloadModel !== false
      };
      if (hfToken) payload.hfToken = hfToken;
      if (modelId) payload.modelId = modelId;
      const response = await sendNativeHostMessage({
        ...payload
      });
      await detector.initialize(true);
      return { success: true, ...response, detectionMode: detector.mode };
    }

    if (command === 'stop') {
      const response = await sendNativeHostMessage({ action: 'stop' });
      await detector.initialize(true);
      return { success: true, ...response, detectionMode: detector.mode };
    }

    if (command === 'restart') {
      const hfToken = typeof options.hfToken === 'string' ? options.hfToken.trim() : '';
      const modelId = typeof options.modelId === 'string' ? options.modelId.trim() : '';
      const payload = {
        action: 'restart',
        installDeps: options.installDeps !== false,
        downloadModel: options.downloadModel !== false
      };
      if (hfToken) payload.hfToken = hfToken;
      if (modelId) payload.modelId = modelId;
      const response = await sendNativeHostMessage(payload);
      await detector.initialize(true);
      return { success: true, ...response, detectionMode: detector.mode };
    }

    return { success: false, error: `Unknown server control command: ${command}` };
  } catch (error) {
    if (isNativeHostMissingError(error.message)) {
      return {
        success: true,
        installed: false,
        running: false,
        healthy: false,
        logLines: [],
        logExists: false,
        error: `Native host is not installed for extension id ${chrome.runtime.id}.`
      };
    }
    return { success: false, error: error.message || String(error) };
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Detection actions must come from content scripts in real tabs
  const isDetectionAction = request.action === 'detectPII' || request.action === 'detectPIIFast';
  if (isDetectionAction && !sender?.tab?.id) return false;

  // ── Toolbar-icon badge (U1) ──
  // Push from a content script: amber count of unredacted detections, green ✓
  // when everything is protected, cleared when there's nothing.
  if (request.action === 'aiSafePluginStatsPush') {
    if (!sender?.tab?.id) return false;
    const detected = Number(request.detected) || 0;
    const protectedCount = Number(request.protected) || 0;
    const pending = Math.max(0, detected - protectedCount);
    const tabId = sender.tab.id;
    const text = pending > 0
      ? (pending > 99 ? '99+' : String(pending))
      : (protectedCount > 0 ? '✓' : '');
    chrome.action.setBadgeText({ tabId, text });
    if (text) {
      chrome.action.setBadgeBackgroundColor({ tabId, color: pending > 0 ? '#B45309' : '#15803D' });
      try { chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }); } catch { /* older Chrome */ }
    }
    return false;
  }

  if (request.action === 'detectPIIFast') {
    try {
      const detections = detector.detectFastLocalProtection(request.text, request.options);
      sendResponse({
        success: true,
        detections,
        mode: detector.mode
      });
    } catch (error) {
      console.error('Fast detection error:', error);
      sendResponse({ success: false, error: error.message || String(error) });
    }
    return false;
  }

  if (request.action === 'detectPII') {
    const tabId = sender?.tab?.id;
    // Cancel any stale in-flight request from this tab before issuing a new one
    if (typeof tabId === 'number' && activeDetectionControllers.has(tabId)) {
      activeDetectionControllers.get(tabId).abort();
    }
    const controller = new AbortController();
    if (typeof tabId === 'number') activeDetectionControllers.set(tabId, controller);

    detector.detectPII(request.text, request.options, controller.signal)
      .then((detections) => anonymizer.enrichDetections(detections, request.options))
      .then((detections) => {
        sendResponse({
          success: true,
          detections,
          mode: detector.mode
        });
      })
      .catch((error) => {
        if (error.name === 'AbortError') return; // superseded by newer request — no response needed
        console.error('Detection error:', error);
        sendResponse({ success: false, error: error.message });
      })
      .finally(() => {
        if (typeof tabId === 'number') activeDetectionControllers.delete(tabId);
      });
    return true;
  }

  if (request.action === 'initialize') {
    detector.initialize(true)
      .then(() => {
        sendResponse({
          success: true,
          mode: detector.mode,
          localServerUrl: detector.localServerUrl
        });
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (request.action === 'getStatus') {
    sendResponse({
      isReady: detector.isReady,
      isLoading: detector.isLoading,
      mode: detector.mode,
      localServerUrl: detector.localServerUrl
    });
  }

  if (request.action === 'classifyPII') {
    if (detector.mode !== 'gliner2-local') {
      sendResponse({ success: false, result: null });
      return;
    }
    detector.classifyText(request.text)
      .then((result) => sendResponse({ success: true, result }))
      .catch(() => sendResponse({ success: false, result: null }));
    return true;
  }

  if (request.action === 'serverControl') {
    handleServerControl(request.command, request.options)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    enabled: true,
    autoRedact: true,
    redactionMode: 'mask',
    sensitivity: 'medium',
    includeRegexWhenModelOnline: true,
    monitorAllSites: true,
    enabledTypes: DEFAULT_LABELS,
    customPatterns: getDefaultCustomPatterns(),
    monitoredSelectors: DEFAULT_MONITORED_SELECTORS,
    monitoredSites: [
      'chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com',
      'copilot.microsoft.com', 'perplexity.ai', 'grok.com', 'x.ai',
      'chat.deepseek.com', 'chat.mistral.ai', 'poe.com', 'character.ai',
      'pi.ai', 'you.com', 'meta.ai', 'chat.qwen.ai', 'chat.qwenlm.ai',
      'duck.ai', 'huggingface.co', 'phind.com', 't3.chat'
    ]
  }, () => {
    // After seeding defaults, restore any newer synced prefs (e.g. on reinstall).
    applySyncedSettingsIfNewer();
  });
  detector.warmUpIfAvailable().catch(() => { });
});

chrome.runtime.onStartup.addListener(() => {
  applySyncedSettingsIfNewer();
  detector.warmUpIfAvailable().catch(() => { });
});

// Live cross-device apply: when another device updates synced settings, import them.
chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === 'sync') applySyncedSettingsIfNewer();
});

// Clear the toolbar badge (U1) when a tab navigates — the content script will
// re-push counts for the new page. `status === 'loading'` is available without
// the optional "tabs" permission.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});
