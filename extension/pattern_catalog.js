(function initAiSafePluginPatternCatalog(root) {
  const LEGACY_OPENAI_KEY_PATTERN = '\\bsk-[A-Za-z0-9]{20,}\\b';

  const DEFAULT_CUSTOM_PATTERNS = Object.freeze([
    Object.freeze({
      id: 'openai_key',
      label: 'api_key',
      pattern: '\\b(?:sk-[A-Za-z0-9]{20,}|sk_(?:test|live)_[A-Za-z0-9]{16,}|sk-proj-[A-Za-z0-9_-]{20,})\\b',
      flags: 'g',
      score: 0.99,
      replacement: '[API KEY REDACTED]',
      enabled: true
    }),
    Object.freeze({
      id: 'aws_access_key',
      label: 'api_key',
      pattern: '\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b',
      flags: 'g',
      score: 0.99,
      replacement: '[AWS KEY REDACTED]',
      enabled: true
    }),
    Object.freeze({
      id: 'github_token',
      label: 'api_key',
      pattern: '\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\\b',
      flags: 'g',
      score: 0.99,
      replacement: '[GITHUB TOKEN REDACTED]',
      enabled: true
    }),
    Object.freeze({
      id: 'jwt_token',
      label: 'jwt',
      pattern: '\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b',
      flags: 'g',
      score: 0.97,
      replacement: '[JWT REDACTED]',
      enabled: true
    }),
    Object.freeze({
      id: 'ipv4',
      label: 'ip_address',
      pattern: '\\b(?:(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)\\b',
      flags: 'g',
      score: 0.96,
      replacement: '[IP REDACTED]',
      enabled: true
    }),
    Object.freeze({
      id: 'ipv6',
      label: 'ip_address',
      pattern: '\\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}\\b',
      flags: 'g',
      score: 0.9,
      replacement: '[IPV6 REDACTED]',
      enabled: true
    }),
    Object.freeze({
      id: 'mac_address',
      label: 'mac_address',
      pattern: '\\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\\b',
      flags: 'g',
      score: 0.96,
      replacement: '[MAC REDACTED]',
      enabled: false
    }),
    Object.freeze({
      id: 'ssn',
      label: 'ssn',
      pattern: '\\b\\d{3}-\\d{2}-\\d{4}\\b',
      flags: 'g',
      score: 0.99,
      replacement: '[SSN REDACTED]',
      enabled: true
    }),
    Object.freeze({
      id: 'indian_pan',
      label: 'pan',
      pattern: '\\b[A-Z]{5}[0-9]{4}[A-Z]\\b',
      flags: 'g',
      score: 0.98,
      replacement: '[PAN REDACTED]',
      enabled: true
    }),
    Object.freeze({
      id: 'indian_aadhaar',
      label: 'aadhaar',
      pattern: '\\b[2-9]\\d{3}[\\s-]\\d{4}[\\s-]\\d{4}\\b(?![\\s-]\\d{4})',
      flags: 'g',
      score: 0.95,
      replacement: '[AADHAAR REDACTED]',
      enabled: true
    }),
    Object.freeze({
      id: 'passport',
      label: 'passport',
      pattern: '\\b[A-Z][0-9]{7}\\b',
      flags: 'g',
      score: 0.92,
      replacement: '[PASSPORT REDACTED]',
      enabled: true
    }),
    Object.freeze({
      id: 'ifsc_code',
      label: 'ifsc',
      pattern: '\\b[A-Z]{4}0[A-Z0-9]{6}\\b',
      flags: 'g',
      score: 0.97,
      replacement: '[IFSC REDACTED]',
      enabled: true
    }),
    Object.freeze({
      id: 'indian_driver_license',
      label: 'driver_license',
      pattern: '\\b[A-Z]{2}[0-9]{2}[-\\s]?[0-9]{11}\\b',
      flags: 'g',
      score: 0.95,
      replacement: '[DL REDACTED]',
      enabled: true
    }),
    Object.freeze({
      id: 'slack_token',
      label: 'api_key',
      pattern: '\\bxox[bporas]-[A-Za-z0-9-]{10,}\\b',
      flags: 'g',
      score: 0.99,
      replacement: '[SLACK TOKEN REDACTED]',
      enabled: true
    }),
    Object.freeze({
      id: 'stripe_key',
      label: 'api_key',
      pattern: '\\b[rs]k_(?:test|live)_[A-Za-z0-9]{20,}\\b',
      flags: 'g',
      score: 0.99,
      replacement: '[STRIPE KEY REDACTED]',
      enabled: true
    }),
    Object.freeze({
      id: 'google_api_key',
      label: 'api_key',
      pattern: '\\bAIza[A-Za-z0-9_-]{35}\\b',
      flags: 'g',
      score: 0.99,
      replacement: '[GOOGLE KEY REDACTED]',
      enabled: true
    }),
    Object.freeze({
      id: 'azure_key',
      label: 'api_key',
      pattern: '\\b[A-Fa-f0-9]{32}\\b',
      flags: 'g',
      score: 0.80,
      replacement: '[AZURE KEY REDACTED]',
      enabled: false
    }),
    Object.freeze({
      id: 'twilio_key',
      label: 'api_key',
      pattern: '\\bSK[0-9a-fA-F]{32}\\b',
      flags: 'g',
      score: 0.99,
      replacement: '[TWILIO KEY REDACTED]',
      enabled: true
    }),
    Object.freeze({
      id: 'maya_api_key',
      label: 'api_key',
      pattern: '\\bmdp_(?:dev|prod|test|live)\\|[A-Za-z0-9_-]{20,}\\|[A-Za-z0-9_-]{2,}\\b',
      flags: 'g',
      score: 0.99,
      replacement: '[MAYA KEY REDACTED]',
      enabled: true
    }),
    Object.freeze({
      id: 'private_key',
      label: 'private_key',
      pattern: '-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY[\\s\\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----',
      flags: 'g',
      score: 0.99,
      replacement: '[PRIVATE KEY REDACTED]',
      enabled: true
    }),
    Object.freeze({
      id: 'connection_string',
      label: 'connection_string',
      pattern: '\\b(?:mongodb(?:\\+srv)?|postgres(?:ql)?|mysql|redis|amqp|mssql):\\/\\/[^\\s"\'`]+\\b',
      flags: 'g',
      score: 0.98,
      replacement: '[CONNECTION STRING REDACTED]',
      enabled: true
    }),
    Object.freeze({
      id: 'generic_secret',
      label: 'api_key',
      pattern: '(?<=(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|secret[_-]?key|bearer)\\s*[:=]\\s*["\']?)[A-Za-z0-9_-]{20,}',
      flags: 'gi',
      score: 0.92,
      replacement: '[SECRET REDACTED]',
      enabled: true
    })
  ]);

  const PATTERN_NAMES = Object.freeze({
    openai_key: 'OpenAI API Key',
    aws_access_key: 'AWS Access Key',
    github_token: 'GitHub Token',
    jwt_token: 'JWT Token',
    ipv4: 'IPv4 Address',
    ipv6: 'IPv6 Address',
    mac_address: 'MAC Address',
    ssn: 'US Social Security Number',
    indian_pan: 'Indian PAN Number',
    indian_aadhaar: 'Indian Aadhaar',
    passport: 'Passport Number',
    ifsc_code: 'IFSC Code',
    indian_driver_license: 'Indian Driver License',
    slack_token: 'Slack Token',
    stripe_key: 'Stripe API Key',
    google_api_key: 'Google API Key',
    azure_key: 'Azure Subscription Key',
    twilio_key: 'Twilio API Key',
    maya_api_key: 'Maya API Key',
    private_key: 'Private Key (PEM)',
    connection_string: 'Database Connection String',
    generic_secret: 'Generic Secret / Token'
  });

  function cloneDefaultCustomPatterns() {
    return DEFAULT_CUSTOM_PATTERNS.map((pattern) => ({ ...pattern }));
  }

  function normalizeCustomPatterns(storedPatterns, defaults = cloneDefaultCustomPatterns()) {
    const defaultList = Array.isArray(defaults) ? defaults.map((entry) => ({ ...entry })) : cloneDefaultCustomPatterns();
    if (!Array.isArray(storedPatterns) || storedPatterns.length === 0) {
      return defaultList;
    }

    const storedById = new Map();
    const extras = [];

    storedPatterns.forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      const id = String(entry.id || '').trim();
      if (!id) {
        extras.push({ ...entry });
        return;
      }
      storedById.set(id, entry);
    });

    const mergedDefaults = defaultList.map((def) => {
      const id = String(def?.id || '').trim();
      if (!id || !storedById.has(id)) return { ...def };
      const stored = storedById.get(id);
      if (id === 'openai_key' && String(stored.pattern || '') === LEGACY_OPENAI_KEY_PATTERN) {
        return { ...def, ...stored, pattern: def.pattern };
      }
      return { ...def, ...stored };
    });

    const mergedIds = new Set(mergedDefaults.map((entry) => String(entry?.id || '').trim()).filter(Boolean));
    const customOnly = storedPatterns
      .filter((entry) => {
        const id = String(entry?.id || '').trim();
        return !id || !mergedIds.has(id);
      })
      .map((entry) => ({ ...entry }));

    return [...mergedDefaults, ...extras, ...customOnly];
  }

  // Labels too dangerous to ever add to a per-site "ignore" allowlist (U3). The
  // Ignore action is not offered for these — silently allowlisting a secret would
  // be a footgun.
  const HIGH_RISK_LABELS = Object.freeze([
    'ssn', 'credit_card', 'private_key', 'api_key', 'jwt', 'connection_string', 'aadhaar'
  ]);

  // Drop ignored-value entries older than ttlMs. Pure: returns a new array.
  function pruneIgnoredByTtl(entries, ttlMs, now = Date.now()) {
    if (!Array.isArray(entries)) return [];
    const cutoff = now - Number(ttlMs);
    return entries.filter((e) => e && typeof e.addedAt === 'number' && e.addedAt >= cutoff);
  }

  // Keep at most `max` entries, evicting the oldest (FIFO) from the front. Pure.
  function capFifo(entries, max) {
    if (!Array.isArray(entries)) return [];
    const limit = Math.max(0, Number(max) || 0);
    return entries.length <= limit ? entries.slice() : entries.slice(entries.length - limit);
  }

  function normalizeSiteHost(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    const withoutWildcard = raw.replace(/^\*\./, '');
    const cleanHost = (host) => String(host || '').replace(/^\*\./, '').replace(/^\.+|\.+$/g, '');
    try {
      return cleanHost(new URL(withoutWildcard.includes('://') ? withoutWildcard : `https://${withoutWildcard}`).hostname);
    } catch {
      return cleanHost(withoutWildcard.split('/')[0].split(':')[0]);
    }
  }

  function hostMatchesSite(host, site) {
    const normalizedHost = normalizeSiteHost(host);
    const normalizedSite = normalizeSiteHost(site);
    if (!normalizedHost || !normalizedSite) return false;
    return normalizedHost === normalizedSite || normalizedHost.endsWith(`.${normalizedSite}`);
  }

  // ── Local privacy stats (U7) ──
  // ISO-8601 week key "YYYY-Www" (weeks start Monday; week 1 contains the first
  // Thursday of the year). Used to bucket durable redaction counts by week.
  function isoWeekKey(date = new Date()) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    // Thursday in the current week decides the year.
    const day = d.getUTCDay() || 7; // Sunday → 7
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  // Fold a redaction event into a stats object, returning a NEW object (pure).
  // Counts only — never values or sites.
  function mergeRedactionStats(stats, label, weekKey, n = 1) {
    const inc = Number(n) || 0;
    const base = (stats && typeof stats === 'object') ? stats : {};
    const byLabel = { ...(base.byLabel || {}) };
    const byWeek = { ...(base.byWeek || {}) };
    const labelKey = String(label || 'unknown');
    byLabel[labelKey] = (Number(byLabel[labelKey]) || 0) + inc;
    if (weekKey) byWeek[weekKey] = (Number(byWeek[weekKey]) || 0) + inc;
    return {
      totalProtected: (Number(base.totalProtected) || 0) + inc,
      byLabel,
      byWeek
    };
  }

  const api = {
    DEFAULT_CUSTOM_PATTERNS,
    LEGACY_OPENAI_KEY_PATTERN,
    PATTERN_NAMES,
    HIGH_RISK_LABELS,
    cloneDefaultCustomPatterns,
    normalizeCustomPatterns,
    pruneIgnoredByTtl,
    capFifo,
    normalizeSiteHost,
    hostMatchesSite,
    isoWeekKey,
    mergeRedactionStats
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.AI_SAFE_PLUGIN_PATTERN_CATALOG = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
