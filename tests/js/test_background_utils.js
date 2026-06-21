/**
 * Unit tests for pure utility functions extracted from background.js.
 * Run with: node tests/js/test_background_utils.js
 * No test runner required — uses simple assertions.
 */

'use strict';

const {
  cloneDefaultCustomPatterns,
  normalizeCustomPatterns,
  PATTERN_NAMES,
  HIGH_RISK_LABELS,
  pruneIgnoredByTtl,
  capFifo,
  normalizeSiteHost,
  hostMatchesSite,
  isoWeekKey,
  mergeRedactionStats,
  SYNCED_SETTING_KEYS,
  chunkForSync,
  reassembleChunks,
} = require('../../extension/pattern_catalog.js');
const {
  REGEX_SMOKE_TEXT,
  REGEX_SMOKE_CUSTOM_PATTERNS,
  EXPECTED_CUSTOM_REGEX_LABELS,
} = require('../fixtures/regex_smoke_corpus.js');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

function assertEqual(a, b, message) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${message} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}

function section(name) {
  console.log(`\n${name}`);
}

// ── Inline the pure functions under test ─────────────────────────────────────

function mergeOverlapping(detections) {
  if (detections.length === 0) return [];
  detections.sort((a, b) => a.start - b.start || b.score - a.score);
  const merged = [];
  let current = detections[0];
  for (let i = 1; i < detections.length; i++) {
    const next = detections[i];
    if (next.start < current.end) {
      const sameSpan = current.start === next.start && current.end === next.end;
      const currentText = String(current.text || '').trim().toLowerCase();
      const nextText = String(next.text || '').trim().toLowerCase();
      const sameText = Boolean(currentText) && currentText === nextText;
      const labels = new Set([String(current.label || '').toLowerCase(), String(next.label || '').toLowerCase()]);
      if ((sameSpan || sameText) && labels.has('person') && labels.has('organization')) {
        current = String(current.label || '').toLowerCase() === 'person' ? current : next;
        continue;
      }
      if (next.score > current.score || (next.score === current.score && (next.end - next.start) > (current.end - current.start))) {
        current = next;
      }
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);
  return merged;
}

function normalizeLabel(label) {
  // Mirrors GLINER_LABEL_DESCRIPTIONS keys
  const KNOWN = new Set(['person','email','phone','address','ssn','credit_card','date_of_birth','location','organization']);
  return KNOWN.has(label) ? label : label;
}

function findClosestOccurrence(text, needle, referenceStart = 0) {
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

function reconcileExistingItems(sourceText, items) {
  const text = String(sourceText || '');
  if (!text || !Array.isArray(items) || items.length === 0) return [];

  return items
    .map((item) => {
      const itemText = String(item?.text || '');
      if (!itemText) return null;
      const referenceStart = Number.isInteger(item.start) ? item.start : 0;
      const nextStart = findClosestOccurrence(text, itemText, referenceStart);
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

function mergeWithExistingDetections(existingItems, newDetections) {
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

function mergeExistingItemsWithDetections(existingItems, newDetections) {
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

function organizationLooksValid(text) {
  const value = String(text || '');
  if (value.length < 3) return false;
  const lower = value.toLowerCase();
  const words = value.trim().split(/\s+/).filter(Boolean);
  const hasKeyword = /\b(inc|inc\.|llc|ltd|ltd\.|corp|corp\.|corporation|company|co\.|university|college|bank|labs?|group|systems?|studio|technologies?|tech|solutions?|partners?|foundation|agency|associates?|ventures?|industries?|institute|ministry|department|hospital|school)\b/i.test(lower);
  const isAcronymLike = /^[A-Z0-9&.-]{2,10}$/.test(value.trim());
  if (/^[a-z\s]+$/.test(value) && !hasKeyword) return false;
  if (words.length === 1 && !hasKeyword && !isAcronymLike) return false;
  if (words.length <= 2 && words.every((word) => /^[A-Z][A-Za-z'`.-]*$/.test(word)) && !hasKeyword && !isAcronymLike) return false;
  return true;
}

function buildResponseRestoreComponents(label, replacement, original) {
  if (String(label || '').toLowerCase() !== 'person') return [];
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

function collectSelectorMatches(selectors, querySelectorAll) {
  const found = [];
  selectors.forEach((selector) => {
    let elements;
    try {
      elements = querySelectorAll(selector);
    } catch {
      return;
    }
    elements.forEach((element) => found.push(element));
  });
  return found;
}

const CORE_ENABLED_LABELS = new Set(['person','email','phone','address','ssn','credit_card','date_of_birth','location','organization']);

function detectWithCustomPatternsForTest(text, patterns, threshold, enabledTypes) {
  const enabledLabelSet = new Set((enabledTypes || []).map((type) => String(type || '').trim().toLowerCase()).filter(Boolean));
  const detections = [];
  patterns
    .filter((patternDef) => patternDef && typeof patternDef === 'object' && patternDef.enabled !== false)
    .forEach((patternDef) => {
      const label = String(patternDef.label || 'custom').trim().toLowerCase();
      if (CORE_ENABLED_LABELS.has(label) && !enabledLabelSet.has(label)) return;
      const regex = new RegExp(patternDef.pattern, patternDef.flags || 'g');
      let match;
      while ((match = regex.exec(text)) !== null) {
        detections.push({ text: match[0], label, start: match.index, end: match.index + match[0].length, score: patternDef.score || 0.96 });
      }
    });
  return detections.filter((item) => item.score >= threshold);
}

function isStaticRedactionToken(value) {
  return /^\[[A-Z0-9_ -]+ REDACTED\]$/.test(String(value || '').trim());
}

// ── Tests ─────────────────────────────────────────────────────────────────────

section('mergeOverlapping — no overlaps');
{
  const dets = [
    { text: 'John', label: 'person', start: 0, end: 4, score: 0.9 },
    { text: 'gmail.com', label: 'email', start: 10, end: 19, score: 0.95 },
  ];
  const result = mergeOverlapping(dets);
  assertEqual(result.length, 2, 'keeps both non-overlapping detections');
  assertEqual(result[0].start, 0, 'first detection at start=0');
}

section('mergeOverlapping — exact same span, keeps higher score');
{
  const dets = [
    { text: 'John', label: 'person', start: 0, end: 4, score: 0.7 },
    { text: 'John', label: 'person', start: 0, end: 4, score: 0.92 },
  ];
  const result = mergeOverlapping(dets);
  assertEqual(result.length, 1, 'merges to single detection');
  assertEqual(result[0].score, 0.92, 'keeps higher score');
}

section('mergeOverlapping — partial overlap, keeps higher score');
{
  const dets = [
    { text: 'John Doe', label: 'person', start: 0, end: 8, score: 0.85 },
    { text: 'Doe', label: 'person', start: 5, end: 8, score: 0.6 },
  ];
  const result = mergeOverlapping(dets);
  assertEqual(result.length, 1, 'overlapping merged to one');
  assertEqual(result[0].score, 0.85, 'kept the higher-scored one');
}

section('mergeOverlapping — person wins over organization on the same span');
{
  const dets = [
    { text: 'Pranav', label: 'organization', start: 0, end: 6, score: 0.91 },
    { text: 'Pranav', label: 'person', start: 0, end: 6, score: 0.82 },
  ];
  const result = mergeOverlapping(dets);
  assertEqual(result.length, 1, 'same-span person/org conflict merges to one detection');
  assertEqual(result[0].label, 'person', 'person is preferred over organization for ambiguous proper names');
}

section('mergeOverlapping — adjacent spans, both kept');
{
  const dets = [
    { text: 'John', label: 'person', start: 0, end: 4, score: 0.9 },
    { text: ' Doe', label: 'person', start: 4, end: 8, score: 0.8 },
  ];
  const result = mergeOverlapping(dets);
  assertEqual(result.length, 2, 'adjacent spans are not overlapping');
}

section('mergeOverlapping — empty input');
{
  const result = mergeOverlapping([]);
  assertEqual(result.length, 0, 'empty input returns empty');
}

section('mergeOverlapping — sorts by start position');
{
  const dets = [
    { text: 'Doe', label: 'person', start: 10, end: 13, score: 0.8 },
    { text: 'John', label: 'person', start: 0, end: 4, score: 0.9 },
  ];
  const result = mergeOverlapping(dets);
  assertEqual(result[0].start, 0, 'first result has lower start');
  assertEqual(result[1].start, 10, 'second result has higher start');
}

section('pattern catalog — expected built-in regex detectors are present');
{
  const ids = cloneDefaultCustomPatterns().map((pattern) => pattern.id);
  assert(ids.includes('openai_key'), 'includes OpenAI key pattern');
  assert(ids.includes('aws_access_key'), 'includes AWS access key pattern');
  assert(ids.includes('github_token'), 'includes GitHub token pattern');
  assert(ids.includes('jwt_token'), 'includes JWT pattern');
  assert(ids.includes('ipv4'), 'includes IPv4 pattern');
  assert(ids.includes('ipv6'), 'includes IPv6 pattern');
  assert(ids.includes('ssn'), 'includes SSN pattern');
  assert(ids.includes('indian_pan'), 'includes PAN pattern');
  assert(ids.includes('indian_aadhaar'), 'includes Aadhaar pattern');
  assert(ids.includes('passport'), 'includes passport pattern');
  assert(ids.includes('ifsc_code'), 'includes IFSC pattern');
  assert(ids.includes('indian_driver_license'), 'includes Indian driver license pattern');
  assert(ids.includes('mac_address'), 'includes MAC address pattern');
  assert(ids.includes('slack_token'), 'includes Slack token pattern');
  assert(ids.includes('stripe_key'), 'includes Stripe key pattern');
  assert(ids.includes('google_api_key'), 'includes Google API key pattern');
  assert(ids.includes('twilio_key'), 'includes Twilio key pattern');
  assert(ids.includes('maya_api_key'), 'includes Maya API key pattern');
  assert(ids.includes('private_key'), 'includes private key pattern');
  assert(ids.includes('connection_string'), 'includes connection string pattern');
  assert(ids.includes('generic_secret'), 'includes generic secret pattern');
  assertEqual(PATTERN_NAMES.openai_key, 'OpenAI API Key', 'exposes display names for built-ins');
}

section('pattern catalog — legacy OpenAI regex migrates to the canonical matcher');
{
  const normalized = normalizeCustomPatterns([
    {
      id: 'openai_key',
      label: 'api_key',
      pattern: '\\bsk-[A-Za-z0-9]{20,}\\b',
      flags: 'g',
      score: 0.99,
      replacement: '[API KEY REDACTED]',
      enabled: true,
    },
  ], cloneDefaultCustomPatterns());

  const openAi = normalized.find((pattern) => pattern.id === 'openai_key');
  assert(openAi.pattern.includes('sk-proj-'), 'legacy OpenAI pattern is upgraded to the canonical matcher');
}

section('pattern catalog — built-in smoke corpus patterns match the shared regex fixture');
{
  const defaults = cloneDefaultCustomPatterns();
  const defaultLabels = new Set(
    defaults
      .filter((pattern) => {
        const regex = new RegExp(pattern.pattern, pattern.flags || 'g');
        return regex.test(REGEX_SMOKE_TEXT);
      })
      .map((pattern) => pattern.label)
  );

  ['aadhaar', 'api_key', 'connection_string', 'driver_license', 'ifsc', 'ip_address', 'jwt', 'pan', 'passport', 'ssn'].forEach((label) => {
    assert(defaultLabels.has(label), `shared smoke corpus hits built-in label "${label}"`);
  });
}

section('pattern catalog — custom smoke corpus patterns match the shared regex fixture');
{
  const customLabels = new Set(
    REGEX_SMOKE_CUSTOM_PATTERNS
      .filter((pattern) => {
        const regex = new RegExp(pattern.pattern, pattern.flags || 'g');
        return regex.test(REGEX_SMOKE_TEXT);
      })
      .map((pattern) => pattern.label)
  );

  EXPECTED_CUSTOM_REGEX_LABELS.forEach((label) => {
    assert(customLabels.has(label), `shared smoke corpus hits custom label "${label}"`);
  });
}

section('content reconciliation — drops stale items when the original text disappears');
{
  const reconciled = reconcileExistingItems('My name is Pranav', [
    { text: 'Rohan Sharma', label: 'person', start: 11, end: 23, redacted: true },
  ]);
  assertEqual(reconciled, [], 'stale carried item is removed when the source text no longer contains it');
}

section('content reconciliation — keeps the closest matching occurrence for repeated text');
{
  const reconciled = reconcileExistingItems('Pranav met Pranav yesterday', [
    { text: 'Pranav', label: 'person', start: 12, end: 18, redacted: true },
  ]);
  assertEqual(reconciled.length, 1, 'one repeated-name item is retained');
  assertEqual(reconciled[0].start, 11, 'reconciles to the closest surviving occurrence');
}

section('content reconciliation — duplicate text in new detections is not over-deduped');
{
  const existing = [
    { text: 'Pranav', label: 'person', start: 0, end: 6, redacted: true },
  ];
  const incoming = [
    { text: 'Pranav', label: 'person', start: 0, end: 6, score: 0.9 },
    { text: 'Pranav', label: 'person', start: 16, end: 22, score: 0.9 },
  ];
  const merged = mergeWithExistingDetections(existing, incoming);
  assertEqual(merged.length, 1, 'only the overlapping carried-forward occurrence is suppressed');
  assertEqual(merged[0].start, 16, 'a second identical name remains detectable');
}

section('content reconciliation — staged supported detections inherit anonymized replacements');
{
  const existing = [
    {
      text: 'aisha.thomas@acmeresearch.com',
      label: 'email',
      start: 14,
      end: 42,
      redacted: true,
      anonymizedText: null,
      replacement: null
    }
  ];
  const incoming = [
    {
      text: 'aisha.thomas@acmeresearch.com',
      label: 'email',
      start: 14,
      end: 42,
      source: 'gliner2',
      tier: 'high',
      anonymizedText: 'nishi@gmail.com'
    }
  ];
  const merged = mergeExistingItemsWithDetections(existing, incoming);
  assertEqual(merged[0].anonymizedText, 'nishi@gmail.com', 'provisional email masking is upgraded with Maya anonymization');
}

section('organization validation — single-word title-case names are rejected as orgs');
{
  assertEqual(organizationLooksValid('Pranav'), false, 'single-word proper names do not qualify as organizations');
  assertEqual(organizationLooksValid('IBM'), true, 'all-caps acronym organizations can still pass');
  assertEqual(organizationLooksValid('Maya Data Privacy'), true, 'multi-word organization names remain valid');
}

section('assistant response restore — person name parts are mapped individually');
{
  const parts = buildResponseRestoreComponents('person', 'Alexandra Aisha', 'Nishi Kant');
  assertEqual(parts, [['Alexandra', 'Nishi'], ['Aisha', 'Kant']], 'multi-part person names expose per-part local restore mappings');
}

section('assistant response restore — non-person labels do not create sub-word mappings');
{
  const parts = buildResponseRestoreComponents('organization', 'Maya Labs', 'Acme Systems');
  assertEqual(parts, [], 'sub-word local restore remains limited to person names');
}

section('site matching — exact or suffix-boundary only');
{
  assertEqual(normalizeSiteHost('https://*.ChatGPT.com/path'), 'chatgpt.com', 'configured site URLs normalize to hostnames');
  assertEqual(hostMatchesSite('chatgpt.com', 'chatgpt.com'), true, 'exact monitored host matches');
  assertEqual(hostMatchesSite('team.chatgpt.com', 'chatgpt.com'), true, 'subdomain monitored host matches');
  assertEqual(hostMatchesSite('evilchatgpt.com', 'chatgpt.com'), false, 'substring host does not match');
  assertEqual(hostMatchesSite('chatgpt.com.evil.example', 'chatgpt.com'), false, 'embedded monitored host does not match');
  assertEqual(hostMatchesSite('gemini.google.com', 'https://gemini.google.com/path'), true, 'configured URL normalizes to hostname');
}

section('selector scanning — invalid selectors are isolated');
{
  const matches = collectSelectorMatches(['textarea', 'input[', '[role="textbox"]'], (selector) => {
    if (selector === 'input[') throw new Error('invalid selector');
    return [{ selector }];
  });
  assertEqual(matches.map((entry) => entry.selector), ['textarea', '[role="textbox"]'], 'one invalid selector does not stop later selectors');
}

section('custom patterns — core labels honor disabled enabledTypes');
{
  const patterns = [
    { label: 'email', pattern: '\\btest@example\\.com\\b', flags: 'g', score: 0.99, enabled: true },
    { label: 'api_key', pattern: '\\bsk-test-secret\\b', flags: 'g', score: 0.99, enabled: true },
  ];
  const detections = detectWithCustomPatternsForTest('test@example.com sk-test-secret', patterns, 0.5, ['person']);
  assertEqual(detections.map((item) => item.label), ['api_key'], 'disabled core email pattern is skipped while non-core secret pattern remains active');
}

section('assistant response restore — static redaction tokens are not ledger keys');
{
  assertEqual(isStaticRedactionToken('[EMAIL REDACTED]'), true, 'plain static mask token is recognized');
  assertEqual(isStaticRedactionToken('[NAME_1 REDACTED]'), true, 'indexed static mask token is recognized');
  assertEqual(isStaticRedactionToken('Alexandra Aisha'), false, 'natural anonymized replacement is still eligible');
}

section('ignored-values helpers (U3)');
{
  const now = 1_000_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  const ttl = 90 * day;
  const entries = [
    { value: 'Acme', label: 'organization', addedAt: now - (100 * day) }, // expired
    { value: 'Globex', label: 'organization', addedAt: now - (10 * day) }, // fresh
    { value: 'NoTimestamp', label: 'organization' }, // invalid → dropped
  ];
  const pruned = pruneIgnoredByTtl(entries, ttl, now);
  assertEqual(pruned.map((e) => e.value), ['Globex'], 'pruneIgnoredByTtl drops expired and timestamp-less entries');
  assertEqual(pruneIgnoredByTtl(null, ttl, now), [], 'pruneIgnoredByTtl tolerates non-array input');

  const many = Array.from({ length: 205 }, (_, i) => ({ value: `v${i}`, label: 'organization', addedAt: now + i }));
  const capped = capFifo(many, 200);
  assertEqual(capped.length, 200, 'capFifo caps at the limit');
  assertEqual(capped[0].value, 'v5', 'capFifo evicts the oldest entries from the front');
  assertEqual(capped[capped.length - 1].value, 'v204', 'capFifo keeps the newest entry');
  assertEqual(capFifo([{ value: 'a', label: 'x', addedAt: now }], 200).length, 1, 'capFifo is a no-op below the limit');

  assertEqual(HIGH_RISK_LABELS.includes('api_key'), true, 'HIGH_RISK_LABELS excludes api_key from ignoring');
  assertEqual(HIGH_RISK_LABELS.includes('ssn'), true, 'HIGH_RISK_LABELS excludes ssn from ignoring');
  assertEqual(HIGH_RISK_LABELS.includes('person'), false, 'HIGH_RISK_LABELS allows ordinary labels like person');
}

section('privacy stats helpers (U7)');
{
  // isoWeekKey — known ISO-8601 boundaries (local-date input).
  assertEqual(isoWeekKey(new Date(2026, 0, 1)), '2026-W01', 'Jan 1 2026 is ISO week 1');
  assertEqual(isoWeekKey(new Date(2026, 5, 21)), '2026-W25', 'Jun 21 2026 is ISO week 25');
  assertEqual(isoWeekKey(new Date(2021, 0, 1)), '2020-W53', 'Jan 1 2021 belongs to ISO week 53 of 2020');

  // mergeRedactionStats — folds an event into a new object, immutably.
  const s0 = mergeRedactionStats(undefined, 'email', '2026-W25');
  assertEqual(s0, { totalProtected: 1, byLabel: { email: 1 }, byWeek: { '2026-W25': 1 } }, 'merge into empty stats seeds counters');

  const s1 = mergeRedactionStats(s0, 'email', '2026-W25');
  assertEqual(s1.totalProtected, 2, 'merge increments total');
  assertEqual(s1.byLabel.email, 2, 'merge increments per-label');
  assertEqual(s1.byWeek['2026-W25'], 2, 'merge increments per-week');
  assertEqual(s0.totalProtected, 1, 'merge does not mutate the input (immutability)');

  const s2 = mergeRedactionStats(s1, 'person', '2026-W26');
  assertEqual(s2.totalProtected, 3, 'second label adds to total');
  assertEqual(s2.byLabel.person, 1, 'new label tracked separately');
  assertEqual(s2.byWeek['2026-W26'], 1, 'new week tracked separately');

  // Counts only — no value/site fields ever appear.
  assertEqual(Object.keys(s2).sort(), ['byLabel', 'byWeek', 'totalProtected'], 'stats object only holds count buckets');
}

section('settings sync helpers (P2)');
{
  // chunkForSync → reassembleChunks round-trip.
  const small = { enabled: true, sensitivity: 'high' };
  assertEqual(reassembleChunks(chunkForSync(small).chunks), small, 'small value round-trips through chunking');

  // A value larger than one chunk splits and rejoins exactly.
  const big = { customPatterns: Array.from({ length: 400 }, (_, i) => ({ id: `p${i}`, pattern: `\\bword${i}\\b`, flags: 'g' })) };
  const chunked = chunkForSync(big, 1000);
  assert(chunked.count > 1, `large value splits into multiple chunks (got ${chunked.count})`);
  assertEqual(reassembleChunks(chunked.chunks), big, 'large value round-trips through chunking');

  assertEqual(reassembleChunks([]), undefined, 'reassembleChunks tolerates empty input');
  assertEqual(reassembleChunks(['{bad json']), undefined, 'reassembleChunks tolerates corrupt input');

  // SYNCED_SETTING_KEYS must never include a sensitive key.
  const forbidden = [
    'aiSafePluginApiKey', 'aiSafePluginAnonymizationSeed', 'hfToken',
    'aiSafePluginServerToken', 'aiSafePluginStats', 'siteSnoozes', 'selectedModel',
    'aiSafePluginLocalServerUrlOverride',
  ];
  for (const key of forbidden) {
    assertEqual(SYNCED_SETTING_KEYS.includes(key), false, `SYNCED_SETTING_KEYS excludes sensitive key ${key}`);
  }
  assertEqual(SYNCED_SETTING_KEYS.includes('sensitivity'), true, 'SYNCED_SETTING_KEYS includes a normal pref (sensitivity)');
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
if (failed > 0) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('All tests passed.');
}
