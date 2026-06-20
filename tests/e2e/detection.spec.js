/**
 * detection.spec.js — E2E tests for content-script PII detection (CommonJS).
 */
const { test, expect } = require('./fixtures');
const { startMockServer, stopMockServer } = require('./mock_server');
const { cloneDefaultCustomPatterns } = require('../../extension/pattern_catalog.js');
const {
    REGEX_SMOKE_TEXT,
    REGEX_SMOKE_CUSTOM_PATTERNS,
    EXPECTED_BUILTIN_REGEX_LABELS,
    EXPECTED_CUSTOM_REGEX_LABELS,
} = require('../fixtures/regex_smoke_corpus');

const MOCK_SERVER_PORT = 18765;
const OFFLINE_SERVER_PORT = 18766;
const MOCK_SERVER_URL = `http://127.0.0.1:${MOCK_SERVER_PORT}`;
const OFFLINE_SERVER_URL = `http://127.0.0.1:${OFFLINE_SERVER_PORT}`;
const CONTENT_PAGE_PATH = '/content-fixture';
const HOSTILE_SCROLL_PAGE_PATH = '/hostile-scroll-fixture';
const OUTBOUND_PRIVACY_PAGE_PATH = '/outbound-privacy-fixture';
const CONTENT_PAGE_URL = `${MOCK_SERVER_URL}${CONTENT_PAGE_PATH}`;
const OFFLINE_HOSTILE_SCROLL_URL = `${OFFLINE_SERVER_URL}${HOSTILE_SCROLL_PAGE_PATH}`;
const OUTBOUND_PRIVACY_PAGE_URL = `${OFFLINE_SERVER_URL}${OUTBOUND_PRIVACY_PAGE_PATH}`;

const TEST_PAGE_HTML = `<!DOCTYPE html>
<html>
<head><title>AI-Safe Plugin detection test</title></head>
<body>
  <textarea id="userInput" style="width:400px;height:100px;"></textarea>
  <div class="markdown-body" id="responseArea">This is an AI response mentioning John Smith.</div>
</body>
</html>`;

const OUTBOUND_PRIVACY_PAGE_HTML = `<!DOCTYPE html>
<html>
<head><title>AI-Safe Plugin outbound privacy fixture</title></head>
<body>
  <form id="composerForm">
    <textarea id="userInput" style="width:400px;height:100px;"></textarea>
    <button id="sendButton" type="submit">Send</button>
  </form>
  <div id="thread">
    <div data-message-author-role="assistant" id="assistantReply">Assistant keeps only protected thread text.</div>
  </div>
  <script>
    const form = document.getElementById('composerForm');
    const textarea = document.getElementById('userInput');
    const thread = document.getElementById('thread');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const current = textarea.value;
      const threadMessages = Array.from(thread.querySelectorAll('[data-message-author-role]')).map((node) => ({
        role: node.getAttribute('data-message-author-role'),
        text: node.textContent || '',
      }));

      await fetch('/provider-capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current, thread: threadMessages }),
      });

      const sent = document.createElement('div');
      sent.setAttribute('data-message-author-role', 'user');
      sent.textContent = current;
      thread.appendChild(sent);
      textarea.value = '';
    });
  </script>
</body>
</html>`;

const HOSTILE_SCROLL_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>AI-Safe Plugin hostile editor scroll test</title>
  <style>
    body { font-family: sans-serif; padding: 24px; }
    #scrollHost {
      width: 560px;
      height: 140px;
      overflow: auto;
      border: 1px solid #aaa;
      padding: 12px;
    }
    #hostileEditor {
      min-height: 420px;
      white-space: pre-wrap;
      outline: none;
    }
  </style>
</head>
<body>
  <div id="scrollHost">
    <div id="hostileEditor" contenteditable="true" role="textbox"></div>
  </div>
  <script>
    const editor = document.getElementById('hostileEditor');
    let normalizeScheduled = false;

    const stripInjectedMarkup = () => {
      normalizeScheduled = false;
      if (!editor.isConnected) return;
      if (!editor.querySelector('.ps-redaction, .ps-pii-underline')) return;
      const plainText = editor.innerText;
      editor.textContent = plainText;
    };

    new MutationObserver(() => {
      if (normalizeScheduled) return;
      normalizeScheduled = true;
      requestAnimationFrame(stripInjectedMarkup);
    }).observe(editor, { childList: true, subtree: true });
  </script>
</body>
</html>`;

const DEFAULT_SMOKE_PATTERNS = Object.freeze([
    ...cloneDefaultCustomPatterns(),
    ...REGEX_SMOKE_CUSTOM_PATTERNS.map((pattern) => ({ ...pattern })),
]);
const MOCK_MODEL_DETECTIONS = Object.freeze([
    {
        text: 'Rohan Sen',
        label: 'person',
        start: REGEX_SMOKE_TEXT.indexOf('Rohan Sen'),
        end: REGEX_SMOKE_TEXT.indexOf('Rohan Sen') + 'Rohan Sen'.length,
        score: 0.94,
        source: 'gliner2',
    },
]);

function buildMockDetectionsForText(text) {
    const source = String(text || '');
    const detections = [];

    const add = (token, label = 'person', score = 0.94) => {
        const start = source.indexOf(token);
        if (start === -1) return;
        detections.push({
            text: token,
            label,
            start,
            end: start + token.length,
            score,
            source: 'gliner2',
        });
    };

    add('Rohan Sen');
    add('Rohan Sharma');
    add('Pranav');
    add('Jane Doe');
    return detections;
}

async function withExtensionPage(context, extensionId, callback) {
    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await extensionPage.waitForLoadState('domcontentloaded');
    try {
        return await callback(extensionPage);
    } finally {
        await extensionPage.close();
    }
}

async function setLocalServerOverride(context, extensionId, url) {
    const result = await withExtensionPage(context, extensionId, (page) => page.evaluate(
        (localServerUrl) => new Promise((resolve) => chrome.storage.local.set({
            aiSafePluginLocalServerUrlOverride: localServerUrl,
        }, () => {
            chrome.runtime.sendMessage({ action: 'initialize' }, (initializeResponse) => {
                chrome.runtime.sendMessage({ action: 'getStatus' }, (statusResponse) => {
                    resolve({ initializeResponse, statusResponse });
                });
            });
        })),
        url,
    ));
    expect(result.statusResponse?.localServerUrl).toBe(url);
}

async function sendDetectRequest(context, extensionId, text, options = {}) {
    return withExtensionPage(context, extensionId, (page) => page.evaluate(
        ({ payloadText, payloadOptions }) => new Promise((resolve) => chrome.runtime.sendMessage({
            action: 'detectPII',
            text: payloadText,
            options: payloadOptions,
        }, resolve)),
        { payloadText: text, payloadOptions: options },
    ));
}

async function sendContentMessage(context, extensionId, pageUrl, message) {
    return withExtensionPage(context, extensionId, (page) => page.evaluate(
        ({ targetUrl, payload }) => new Promise((resolve) => {
            chrome.tabs.query({}, (tabs) => {
                const tab = tabs.find((entry) => entry.url === targetUrl);
                if (!tab?.id) {
                    resolve({ success: false, error: 'target tab not found' });
                    return;
                }
                chrome.tabs.sendMessage(tab.id, payload, (response) => {
                    resolve(response || { success: false, error: chrome.runtime.lastError?.message || 'no response' });
                });
            });
        }),
        { targetUrl: pageUrl, payload: message },
    ));
}

async function readCapturedProviderPayload(page) {
    return page.evaluate(async () => {
        const response = await fetch('/provider-capture-last');
        return response.json();
    });
}

test.describe('Content-Script Detection', () => {
    let mockServer;

    test.beforeEach(async () => {
        mockServer = await startMockServer({
            port: MOCK_SERVER_PORT,
            healthy: true,
            loaded: true,
            detections: MOCK_MODEL_DETECTIONS,
            pages: {
                [CONTENT_PAGE_PATH]: TEST_PAGE_HTML,
                [HOSTILE_SCROLL_PAGE_PATH]: HOSTILE_SCROLL_HTML,
            },
            handlers: {
                'POST /detect': ({ body, cors }) => {
                    let payload = {};
                    try {
                        payload = JSON.parse(body || '{}');
                    } catch {
                        payload = {};
                    }
                    const text = String(payload.text || '');
                    return {
                        headers: cors,
                        body: {
                            ok: true,
                            detections: buildMockDetectionsForText(text),
                        },
                    };
                },
            },
        });
    });

    test.afterEach(async () => {
        if (mockServer) await stopMockServer(mockServer);
        mockServer = null;
    });

    test('content script attaches and textarea retains value after detection', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, MOCK_SERVER_URL);

        const page = await context.newPage();
        await page.goto(CONTENT_PAGE_URL);
        await page.waitForLoadState('domcontentloaded');

        const textarea = page.locator('#userInput');
        await textarea.click();
        await textarea.fill('My name is Jane Doe and my email is jane@example.com');

        await page.waitForTimeout(3000);

        const value = await textarea.inputValue();
        expect(value.length).toBeGreaterThan(0);

        await page.close();
    });

    test('excludedSites disables and re-enables detection without reloading the tab', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, MOCK_SERVER_URL);
        await withExtensionPage(context, extensionId, (page) => page.evaluate(
            () => new Promise((resolve) => chrome.storage.local.set({
                autoRedact: false,
                excludedSites: ['127.0.0.1'],
            }, resolve)),
        ));

        const page = await context.newPage();
        await page.goto(CONTENT_PAGE_URL);
        await page.waitForLoadState('domcontentloaded');

        const textarea = page.locator('#userInput');
        await textarea.click();
        await textarea.fill('My name is Jane Doe and my email is jane@example.com');
        await page.waitForTimeout(3000);

        await expect(page.locator('.ps-field-badge')).toHaveCount(0);
        await expect(page.locator('.ps-pii-underline')).toHaveCount(0);

        await withExtensionPage(context, extensionId, (extensionPage) => extensionPage.evaluate(
            () => new Promise((resolve) => chrome.storage.local.set({ excludedSites: [] }, resolve)),
        ));

        await expect(page.locator('.ps-field-badge.ps-badge-pending')).toBeVisible({ timeout: 8000 });

        await page.close();
    });

    test('commandRedactAll redacts pending detections in the focused field', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, MOCK_SERVER_URL);
        await withExtensionPage(context, extensionId, (page) => page.evaluate(
            () => new Promise((resolve) => chrome.storage.local.set({ autoRedact: false }, resolve)),
        ));

        const page = await context.newPage();
        await page.goto(CONTENT_PAGE_URL);
        await page.waitForLoadState('domcontentloaded');

        const textarea = page.locator('#userInput');
        await textarea.click();
        await textarea.fill('My name is Jane Doe and my email is jane@example.com');
        await expect(page.locator('.ps-field-badge.ps-badge-pending')).toBeVisible({ timeout: 8000 });

        const response = await sendContentMessage(context, extensionId, CONTENT_PAGE_URL, { action: 'commandRedactAll' });
        expect(response.success).toBeTruthy();
        await expect(textarea).toHaveValue(/NAME.*REDACTED/, { timeout: 5000 });
        await expect(textarea).toHaveValue(/EMAIL.*REDACTED/, { timeout: 5000 });

        await page.close();
    });

    test('commandToggleSite updates excludedSites for the current host', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, MOCK_SERVER_URL);

        const page = await context.newPage();
        await page.goto(CONTENT_PAGE_URL);
        await page.waitForLoadState('domcontentloaded');

        const first = await sendContentMessage(context, extensionId, CONTENT_PAGE_URL, { action: 'commandToggleSite' });
        expect(first.success).toBeTruthy();
        expect(first.enabled).toBe(false);
        expect(first.excludedSites).toContain('127.0.0.1');

        const stored = await withExtensionPage(context, extensionId, (extensionPage) => extensionPage.evaluate(
            () => new Promise((resolve) => chrome.storage.local.get('excludedSites', (result) => resolve(result.excludedSites || []))),
        ));
        expect(stored).toContain('127.0.0.1');

        const second = await sendContentMessage(context, extensionId, CONTENT_PAGE_URL, { action: 'commandToggleSite' });
        expect(second.success).toBeTruthy();
        expect(second.enabled).toBe(true);
        expect(second.excludedSites).not.toContain('127.0.0.1');

        await page.close();
    });

    test('regex token detectors stay off while the model is online when the toggle is disabled', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, MOCK_SERVER_URL);

        const response = await sendDetectRequest(
            context,
            extensionId,
            REGEX_SMOKE_TEXT,
            {
                enabledTypes: ['person', 'email', 'phone', 'address', 'ssn', 'credit_card', 'date_of_birth'],
                includeRegexWhenModelOnline: false,
                customPatterns: DEFAULT_SMOKE_PATTERNS,
            },
        );

        expect(response.success).toBeTruthy();
        expect(response.mode).toBe('gliner2-local');
        expect(response.detections.map((item) => item.label)).toEqual(['person']);
    });

    test('regex token detectors run alongside the model when the toggle is enabled', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, MOCK_SERVER_URL);

        const response = await sendDetectRequest(
            context,
            extensionId,
            REGEX_SMOKE_TEXT,
            {
                enabledTypes: ['person', 'email', 'phone', 'address', 'ssn', 'credit_card', 'date_of_birth'],
                includeRegexWhenModelOnline: true,
                customPatterns: DEFAULT_SMOKE_PATTERNS,
            },
        );

        expect(response.success).toBeTruthy();
        expect(response.mode).toBe('gliner2-local');

        const labels = new Set(response.detections.map((item) => item.label));
        expect(labels.has('person')).toBeTruthy();
        EXPECTED_BUILTIN_REGEX_LABELS.forEach((label) => expect(labels.has(label), label).toBeTruthy());
        EXPECTED_CUSTOM_REGEX_LABELS.forEach((label) => expect(labels.has(label), label).toBeTruthy());
    });

    test('static assistant response tokens stay masked while user thread prompts stay protected', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, MOCK_SERVER_URL);

        const page = await context.newPage();
        await page.goto(CONTENT_PAGE_URL);
        await page.waitForLoadState('domcontentloaded');

        const textarea = page.locator('#userInput');
        await textarea.click();
        await textarea.fill('My name is Rohan Sen.');
        await expect(textarea).toHaveValue(/NAME.*REDACTED/, { timeout: 8000 });

        const redactedPrompt = await textarea.inputValue();
        const maskedName = redactedPrompt.match(/\[NAME(?:_\d+)? REDACTED\]/)?.[0];
        expect(maskedName).toBeTruthy();

        await page.evaluate((token) => {
            document.getElementById('responseArea').textContent = `Hello ${token}, welcome back.`;
            const threadUser = document.createElement('div');
            threadUser.id = 'threadUser';
            threadUser.setAttribute('data-message-author-role', 'user');
            threadUser.textContent = `User thread keeps ${token} protected.`;
            document.body.appendChild(threadUser);
        }, maskedName);

        const injectedCount = await page.locator('#responseArea .ps-redaction, #responseArea .ps-pii-underline').count();
        expect(injectedCount).toBe(0);

        await expect(page.locator('#responseArea')).toContainText(maskedName);
        await expect(page.locator('#responseArea')).not.toContainText('Rohan Sen');
        await expect(page.locator('#threadUser')).toContainText(maskedName);
        await expect(page.locator('#threadUser')).not.toContainText('Rohan Sen');

        await page.close();
    });
});

test.describe('Regex Fallback (no server)', () => {
    let offlineServer;

    test.beforeEach(async () => {
        offlineServer = await startMockServer({
            port: OFFLINE_SERVER_PORT,
            healthy: false,
            loaded: false,
            detections: [],
            pages: {
                [HOSTILE_SCROLL_PAGE_PATH]: HOSTILE_SCROLL_HTML,
                [OUTBOUND_PRIVACY_PAGE_PATH]: OUTBOUND_PRIVACY_PAGE_HTML,
            },
            handlers: {
                'POST /provider-capture': ({ body, state }) => {
                    try {
                        state.lastProviderPayload = JSON.parse(body || '{}');
                    } catch {
                        state.lastProviderPayload = { parseError: true, raw: body };
                    }
                    return { body: { ok: true } };
                },
                'GET /provider-capture-last': ({ state }) => ({
                    body: state.lastProviderPayload || { ok: false, empty: true },
                }),
            },
        });
    });

    test.afterEach(async () => {
        if (offlineServer) await stopMockServer(offlineServer);
        offlineServer = null;
    });

    test('regex fallback detects built-in and custom smoke-corpus patterns when server is offline', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, OFFLINE_SERVER_URL);

        const response = await sendDetectRequest(
            context,
            extensionId,
            REGEX_SMOKE_TEXT,
            {
                enabledTypes: ['email', 'phone', 'address', 'ssn', 'credit_card', 'date_of_birth'],
                includeRegexWhenModelOnline: false,
                customPatterns: DEFAULT_SMOKE_PATTERNS,
            },
        );

        expect(response.success).toBeTruthy();
        expect(response.mode).toBe('regex-fallback');

        const labels = new Set(response.detections.map((item) => item.label));
        EXPECTED_BUILTIN_REGEX_LABELS.forEach((label) => expect(labels.has(label), label).toBeTruthy());
        EXPECTED_CUSTOM_REGEX_LABELS.forEach((label) => expect(labels.has(label), label).toBeTruthy());
    });

    test('follow-up sends never include original PII in provider-bound thread context', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, OFFLINE_SERVER_URL);

        const page = await context.newPage();
        await page.goto(OUTBOUND_PRIVACY_PAGE_URL);
        await page.waitForLoadState('domcontentloaded');

        const textarea = page.locator('#userInput');
        await textarea.click();
        await textarea.fill('Email jane@example.com about the launch.');
        await expect(textarea).toHaveValue(/EMAIL.*REDACTED/, { timeout: 8000 });
        await page.locator('#sendButton').click();

        await expect.poll(async () => (await readCapturedProviderPayload(page)).current || '', { timeout: 5000 })
            .toMatch(/EMAIL.*REDACTED/);
        const firstPayload = await readCapturedProviderPayload(page);
        expect(firstPayload.current).toMatch(/EMAIL.*REDACTED/);
        expect(firstPayload.current).not.toContain('jane@example.com');

        await textarea.fill('Write a follow-up for Sanket.');
        await page.locator('#sendButton').click();

        await expect.poll(async () => (await readCapturedProviderPayload(page)).thread?.length || 0, { timeout: 5000 })
            .toBeGreaterThan(1);
        const secondPayload = await readCapturedProviderPayload(page);
        expect(secondPayload.current).toContain('Sanket');
        expect(secondPayload.current).not.toContain('jane@example.com');
        expect(secondPayload.thread.map((entry) => entry.text).join('\n')).not.toContain('jane@example.com');
        expect(secondPayload.thread.map((entry) => entry.text).join('\n')).toMatch(/EMAIL.*REDACTED/);

        await page.close();
    });

});

test.describe('Anchored Overlay Scroll Refresh', () => {
    let offlineServer;

    test.beforeEach(async () => {
        offlineServer = await startMockServer({
            port: OFFLINE_SERVER_PORT,
            healthy: false,
            loaded: false,
            detections: [],
            pages: {
                [HOSTILE_SCROLL_PAGE_PATH]: HOSTILE_SCROLL_HTML,
            },
        });
    });

    test.afterEach(async () => {
        if (offlineServer) await stopMockServer(offlineServer);
        offlineServer = null;
    });

    test('external overlay highlights move with hostile editor internal scroll', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, OFFLINE_SERVER_URL);

        const page = await context.newPage();
        await page.goto(OFFLINE_HOSTILE_SCROLL_URL);
        await page.waitForLoadState('domcontentloaded');

        const editor = page.locator('#hostileEditor');
        await editor.click();
        await page.keyboard.insertText(Array.from({ length: 28 }, (_, index) => `Line ${index + 1}: jane@example.com`).join('\n'));

        const overlay = page.locator('.ps-overlay-hl').first();
        await expect(overlay).toBeVisible({ timeout: 8000 });
        const hostBounds = await page.locator('#scrollHost').boundingBox();
        const beforeTops = await page.locator('.ps-overlay-hl').evaluateAll((nodes) => (
            nodes.map((node) => Math.round(node.getBoundingClientRect().top))
        ));

        await page.locator('#scrollHost').evaluate((node) => {
            node.scrollTop = 72;
            node.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        await page.waitForTimeout(350);

        const afterRects = await page.locator('.ps-overlay-hl').evaluateAll((nodes) => (
            nodes.map((node) => {
                const rect = node.getBoundingClientRect();
                return {
                    top: Math.round(rect.top),
                    bottom: Math.round(rect.bottom),
                    left: Math.round(rect.left),
                    right: Math.round(rect.right),
                };
            })
        ));

        expect(hostBounds).not.toBeNull();
        expect(beforeTops.length).toBeGreaterThan(0);
        expect(afterRects.length).toBeGreaterThan(0);
        expect(afterRects.map((rect) => rect.top)).not.toEqual(beforeTops);
        afterRects.forEach((rect) => {
            expect(rect.top).toBeGreaterThanOrEqual(Math.floor(hostBounds.y) - 2);
            expect(rect.bottom).toBeLessThanOrEqual(Math.ceil(hostBounds.y + hostBounds.height) + 2);
            expect(rect.left).toBeGreaterThanOrEqual(Math.floor(hostBounds.x) - 2);
            expect(rect.right).toBeLessThanOrEqual(Math.ceil(hostBounds.x + hostBounds.width) + 2);
        });

        await page.close();
    });

    test('hostile-editor redactions keep the reveal card visible while moving from token to card', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, OFFLINE_SERVER_URL);

        const page = await context.newPage();
        await page.goto(OFFLINE_HOSTILE_SCROLL_URL);
        await page.waitForLoadState('domcontentloaded');

        const editor = page.locator('#hostileEditor');
        await editor.click();
        await page.keyboard.insertText('Email: jane@example.com');

        const overlay = page.locator('.ps-overlay-hl.ps-overlay-hl-redacted').first();
        await expect(overlay).toBeVisible({ timeout: 8000 });
        await overlay.hover();

        const reveal = page.locator('.ps-reveal-overlay');
        await expect(reveal).toBeVisible();
        await expect(reveal).toContainText('jane@example.com');

        const revealBox = await reveal.boundingBox();
        expect(revealBox).not.toBeNull();
        await page.mouse.move(revealBox.x + revealBox.width / 2, revealBox.y + revealBox.height / 2);
        await page.waitForTimeout(180);
        await expect(reveal).toBeVisible();

        await page.mouse.move(10, 10);
        await page.waitForTimeout(220);
        await expect(reveal).toBeHidden();

        await page.close();
    });
});

test.describe('Field Status Badge', () => {
    let mockServer;
    let offlineServer;

    test.beforeEach(async () => {
        mockServer = await startMockServer({
            port: MOCK_SERVER_PORT,
            healthy: true,
            loaded: true,
            detections: MOCK_MODEL_DETECTIONS,
            pages: {
                [CONTENT_PAGE_PATH]: TEST_PAGE_HTML,
                [HOSTILE_SCROLL_PAGE_PATH]: HOSTILE_SCROLL_HTML,
            },
            handlers: {
                'POST /detect': ({ body, cors }) => {
                    let payload = {};
                    try {
                        payload = JSON.parse(body || '{}');
                    } catch {
                        payload = {};
                    }
                    const text = String(payload.text || '');
                    return {
                        headers: cors,
                        body: {
                            ok: true,
                            detections: buildMockDetectionsForText(text),
                        },
                    };
                },
            },
        });
        offlineServer = await startMockServer({
            port: OFFLINE_SERVER_PORT,
            healthy: false,
            loaded: false,
            detections: [],
            pages: {
                [HOSTILE_SCROLL_PAGE_PATH]: HOSTILE_SCROLL_HTML,
            },
        });
    });

    test.afterEach(async () => {
        if (mockServer) await stopMockServer(mockServer);
        mockServer = null;
        if (offlineServer) await stopMockServer(offlineServer);
        offlineServer = null;
    });

    test('badge shows count after detection', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, MOCK_SERVER_URL);

        const page = await context.newPage();
        await page.goto(CONTENT_PAGE_URL);
        await page.waitForLoadState('domcontentloaded');

        const textarea = page.locator('#userInput');
        await textarea.click();
        await textarea.fill('My name is Jane Doe');

        // Wait for detection and badge to appear with count
        await expect(page.locator('.ps-field-badge.ps-badge-pending')).toBeVisible({ timeout: 8000 });

        // Badge count should be visible (non-empty)
        const countText = await page.locator('.ps-field-badge.ps-badge-pending .ps-badge-count').textContent();
        expect(Number.parseInt(countText, 10) || countText).toBeTruthy();

        await page.close();
    });

    test('click on badge opens field panel', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, MOCK_SERVER_URL);

        const page = await context.newPage();
        await page.goto(CONTENT_PAGE_URL);
        await page.waitForLoadState('domcontentloaded');

        const textarea = page.locator('#userInput');
        await textarea.click();
        await textarea.fill('My name is Jane Doe');

        // Wait for badge with pending state
        const badge = page.locator('.ps-field-badge.ps-badge-pending');
        await expect(badge).toBeVisible({ timeout: 8000 });

        // Click badge to open panel
        await badge.click();
        await expect(page.locator('.ps-field-panel.ps-panel-visible')).toBeVisible({ timeout: 3000 });

        // Panel should contain "AI-Safe Plugin ·" header
        await expect(page.locator('.ps-panel-title')).toContainText('AI-Safe Plugin ·');

        await page.close();
    });

    test('Redact all from panel redacts items and turns badge green', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, MOCK_SERVER_URL);

        const page = await context.newPage();
        await page.goto(CONTENT_PAGE_URL);
        await page.waitForLoadState('domcontentloaded');

        const textarea = page.locator('#userInput');
        await textarea.click();
        await textarea.fill('My name is Jane Doe');

        // Wait for badge
        const badge = page.locator('.ps-field-badge.ps-badge-pending');
        await expect(badge).toBeVisible({ timeout: 8000 });

        // Open panel
        await badge.click();
        const panel = page.locator('.ps-field-panel.ps-panel-visible');
        await expect(panel).toBeVisible({ timeout: 3000 });

        // Click Redact all
        const redactAllBtn = panel.locator('.ps-panel-btn-redact');
        await expect(redactAllBtn).toBeVisible();
        await redactAllBtn.click();

        // Badge should turn green (protected)
        await expect(page.locator('.ps-field-badge.ps-badge-protected')).toBeVisible({ timeout: 5000 });

        await page.close();
    });

    test('badge persists on blur while pending', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, MOCK_SERVER_URL);

        // Disable auto-redact so items stay pending after detection
        await withExtensionPage(context, extensionId, (page) => page.evaluate(
            () => new Promise((resolve) => chrome.storage.local.set({ autoRedact: false }, resolve)),
        ));

        const page = await context.newPage();
        await page.goto(CONTENT_PAGE_URL);
        await page.waitForLoadState('domcontentloaded');

        const textarea = page.locator('#userInput');
        await textarea.click();
        await textarea.fill('My name is Jane Doe');

        // Wait for pending badge
        await expect(page.locator('.ps-field-badge.ps-badge-pending')).toBeVisible({ timeout: 8000 });

        // Explicitly blur the textarea — pending badge should remain visible
        await textarea.evaluate((el) => el.blur());
        await page.waitForTimeout(3000);

        // Badge should still be visible because it is pending (safety signal)
        await expect(page.locator('.ps-field-badge.ps-badge-pending')).toBeVisible();

        await page.close();
    });

    test('badge hides on blur when idle (no detections)', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, MOCK_SERVER_URL);

        const page = await context.newPage();
        await page.goto(CONTENT_PAGE_URL);
        await page.waitForLoadState('domcontentloaded');

        const textarea = page.locator('#userInput');
        await textarea.click();
        // Wait for badge to appear in idle state (visible on focus, no detections yet)
        await expect(page.locator('.ps-field-badge')).toBeVisible({ timeout: 3000 });

        // Explicitly blur the textarea
        await textarea.evaluate((el) => el.blur());
        // Badge should fade out within ~4 s (2 s blur delay + transition)
        await expect(page.locator('.ps-field-badge.ps-badge-visible')).toBeHidden({ timeout: 6000 });

        await page.close();
    });

    test('badge clips inside the internal-scroll hostile-editor fixture', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, OFFLINE_SERVER_URL);

        const page = await context.newPage();
        await page.goto(OFFLINE_HOSTILE_SCROLL_URL);
        await page.waitForLoadState('domcontentloaded');

        const editor = page.locator('#hostileEditor');
        await editor.click();
        await page.keyboard.insertText('Email: jane@example.com');

        // Badge should appear
        await expect(page.locator('.ps-field-badge')).toBeVisible({ timeout: 8000 });

        // Badge should be within the scroll host bounds (clipped)
        const badgeBounds = await page.locator('.ps-field-badge').boundingBox();
        const hostBounds = await page.locator('#scrollHost').boundingBox();
        expect(badgeBounds).not.toBeNull();
        expect(hostBounds).not.toBeNull();
        // Badge top/left must be within host rect (clamped by clip rect)
        expect(badgeBounds.x + badgeBounds.width).toBeLessThanOrEqual(hostBounds.x + hostBounds.width + 4);
        expect(badgeBounds.y + badgeBounds.height).toBeLessThanOrEqual(hostBounds.y + hostBounds.height + 4);

        await page.close();
    });
});

test.describe('Detection Popover (U2)', () => {
    let mockServer;
    const ONLINE_HOSTILE_SCROLL_URL = `${MOCK_SERVER_URL}${HOSTILE_SCROLL_PAGE_PATH}`;

    test.beforeEach(async () => {
        // Online model path leaves detections pending (underlined) rather than
        // auto-redacting, so the explanatory popover is reachable.
        mockServer = await startMockServer({
            port: MOCK_SERVER_PORT,
            healthy: true,
            loaded: true,
            detections: MOCK_MODEL_DETECTIONS,
            pages: { [HOSTILE_SCROLL_PAGE_PATH]: HOSTILE_SCROLL_HTML },
            handlers: {
                'POST /detect': ({ body, cors }) => {
                    let payload = {};
                    try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
                    return {
                        headers: cors,
                        body: { ok: true, detections: buildMockDetectionsForText(String(payload.text || '')) },
                    };
                },
            },
        });
    });

    test.afterEach(async () => {
        if (mockServer) await stopMockServer(mockServer);
        mockServer = null;
    });

    async function openPopover(context, extensionId) {
        await setLocalServerOverride(context, extensionId, MOCK_SERVER_URL);
        const page = await context.newPage();
        await page.goto(ONLINE_HOSTILE_SCROLL_URL);
        await page.waitForLoadState('domcontentloaded');

        const editor = page.locator('#hostileEditor');
        await editor.click();
        await page.keyboard.insertText('My name is Jane Doe');

        const underline = page.locator('.ps-overlay-hl.ps-overlay-hl-underline').first();
        await expect(underline).toBeVisible({ timeout: 8000 });
        await underline.hover();

        const popover = page.locator('.ps-popover.ps-popover-visible');
        await expect(popover).toBeVisible({ timeout: 3000 });
        return { page, popover };
    }

    test('hover on an underline shows a popover with the label and explanation', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        const { page, popover } = await openPopover(context, extensionId);

        await expect(popover.locator('.ps-popover-title')).toContainText('Person');
        await expect(popover.locator('.ps-popover-text')).not.toBeEmpty();

        await page.close();
    });

    test('Dismiss from the popover removes the detection and closes the card', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        const { page, popover } = await openPopover(context, extensionId);

        await popover.getByRole('button', { name: /Dismiss/ }).click();

        await expect(page.locator('.ps-popover.ps-popover-visible')).toBeHidden({ timeout: 3000 });
        await expect(page.locator('.ps-overlay-hl.ps-overlay-hl-underline')).toHaveCount(0, { timeout: 3000 });

        await page.close();
    });

    test('Redact from the popover redacts the item and closes the card', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        const { page, popover } = await openPopover(context, extensionId);

        await popover.getByRole('button', { name: /Redact/ }).click();

        await expect(page.locator('.ps-popover.ps-popover-visible')).toBeHidden({ timeout: 3000 });
        await expect(page.locator('.ps-overlay-hl.ps-overlay-hl-redacted').first()).toBeVisible({ timeout: 3000 });

        await page.close();
    });

    test('Escape closes the popover', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        const { page, popover } = await openPopover(context, extensionId);

        await page.keyboard.press('Escape');
        await expect(page.locator('.ps-popover.ps-popover-visible')).toBeHidden({ timeout: 3000 });

        await page.close();
    });
});

test.describe('Persistent Ignore List (U3)', () => {
    let mockServer;
    const ONLINE_HOSTILE_SCROLL_URL = `${MOCK_SERVER_URL}${HOSTILE_SCROLL_PAGE_PATH}`;

    function startWithDetections(detectFn) {
        return startMockServer({
            port: MOCK_SERVER_PORT,
            healthy: true,
            loaded: true,
            detections: MOCK_MODEL_DETECTIONS,
            pages: { [HOSTILE_SCROLL_PAGE_PATH]: HOSTILE_SCROLL_HTML },
            handlers: {
                'POST /detect': ({ body, cors }) => {
                    let payload = {};
                    try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
                    return { headers: cors, body: { ok: true, detections: detectFn(String(payload.text || '')) } };
                },
            },
        });
    }

    test.afterEach(async () => {
        if (mockServer) await stopMockServer(mockServer);
        mockServer = null;
    });

    test('an ignored value stays ignored after reload', async ({ extensionContext }) => {
        mockServer = await startWithDetections(buildMockDetectionsForText);
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, MOCK_SERVER_URL);

        const page = await context.newPage();
        await page.goto(ONLINE_HOSTILE_SCROLL_URL);
        await page.waitForLoadState('domcontentloaded');

        const editor = page.locator('#hostileEditor');
        await editor.click();
        await page.keyboard.insertText('My name is Jane Doe');

        // Hover the underline → popover → "Ignore here".
        const underline = page.locator('.ps-overlay-hl.ps-overlay-hl-underline').first();
        await expect(underline).toBeVisible({ timeout: 8000 });
        await underline.hover();
        const popover = page.locator('.ps-popover.ps-popover-visible');
        await expect(popover).toBeVisible({ timeout: 3000 });
        await popover.getByRole('button', { name: /Ignore/ }).click();
        await expect(page.locator('.ps-overlay-hl.ps-overlay-hl-underline')).toHaveCount(0, { timeout: 3000 });

        // Reload and retype the same value — it must not be flagged again.
        await page.reload();
        await page.waitForLoadState('domcontentloaded');
        const editor2 = page.locator('#hostileEditor');
        await editor2.click();
        await page.keyboard.insertText('My name is Jane Doe');
        await page.waitForTimeout(3000);
        await expect(page.locator('.ps-overlay-hl.ps-overlay-hl-underline')).toHaveCount(0);

        await page.close();
    });

    test('high-risk labels do not offer an Ignore action', async ({ extensionContext }) => {
        const ssnDetect = (text) => {
            const token = '123-45-6789';
            const start = text.indexOf(token);
            if (start === -1) return [];
            return [{ text: token, label: 'ssn', start, end: start + token.length, score: 0.97, source: 'gliner2' }];
        };
        mockServer = await startWithDetections(ssnDetect);
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, MOCK_SERVER_URL);

        const page = await context.newPage();
        await page.goto(ONLINE_HOSTILE_SCROLL_URL);
        await page.waitForLoadState('domcontentloaded');

        const editor = page.locator('#hostileEditor');
        await editor.click();
        await page.keyboard.insertText('My SSN is 123-45-6789');

        const underline = page.locator('.ps-overlay-hl.ps-overlay-hl-underline').first();
        await expect(underline).toBeVisible({ timeout: 8000 });
        await underline.hover();
        const popover = page.locator('.ps-popover.ps-popover-visible');
        await expect(popover).toBeVisible({ timeout: 3000 });

        // Dismiss is present, but Ignore is not offered for high-risk labels.
        await expect(popover.getByRole('button', { name: /Dismiss/ })).toBeVisible();
        await expect(popover.getByRole('button', { name: /Ignore/ })).toHaveCount(0);

        await page.close();
    });
});

test.describe('Toolbar Badge (U1)', () => {
    let mockServer;

    test.beforeEach(async () => {
        mockServer = await startMockServer({
            port: MOCK_SERVER_PORT,
            healthy: true,
            loaded: true,
            detections: MOCK_MODEL_DETECTIONS,
            pages: { [CONTENT_PAGE_PATH]: TEST_PAGE_HTML },
            handlers: {
                'POST /detect': ({ body, cors }) => {
                    let payload = {};
                    try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
                    return { headers: cors, body: { ok: true, detections: buildMockDetectionsForText(String(payload.text || '')) } };
                },
            },
        });
    });

    test.afterEach(async () => {
        if (mockServer) await stopMockServer(mockServer);
        mockServer = null;
    });

    // Opens an extension page, resolves the content-fixture tab id (the URL may
    // change later on navigation), and returns a reader bound to that tab id.
    async function openBadgeReader(context, extensionId) {
        const extPage = await context.newPage();
        await extPage.goto(`chrome-extension://${extensionId}/popup.html`);
        await extPage.waitForLoadState('domcontentloaded');
        const tabId = await extPage.evaluate(() => new Promise((resolve) => {
            chrome.tabs.query({}, (tabs) => {
                const t = (tabs || []).find((tab) => tab.url && tab.url.includes('content-fixture'));
                resolve(t ? t.id : null);
            });
        }));
        const read = () => extPage.evaluate((id) => new Promise((resolve) => {
            chrome.action.getBadgeText({ tabId: id }, (text) => resolve(text));
        }), tabId);
        return { extPage, read };
    }

    test('shows an amber count after detection', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, MOCK_SERVER_URL);

        const page = await context.newPage();
        await page.goto(CONTENT_PAGE_URL);
        await page.waitForLoadState('domcontentloaded');
        const textarea = page.locator('#userInput');
        await textarea.click();
        await textarea.fill('My name is Jane Doe');

        const { extPage, read } = await openBadgeReader(context, extensionId);
        await expect.poll(read, { timeout: 10000 }).toMatch(/^[1-9]/);

        await extPage.close();
        await page.close();
    });

    test('flips to a green check after redact-all', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, MOCK_SERVER_URL);

        const page = await context.newPage();
        await page.goto(CONTENT_PAGE_URL);
        await page.waitForLoadState('domcontentloaded');
        const textarea = page.locator('#userInput');
        await textarea.click();
        await textarea.fill('My name is Jane Doe');

        const badge = page.locator('.ps-field-badge.ps-badge-pending');
        await expect(badge).toBeVisible({ timeout: 8000 });
        await badge.click();
        const panel = page.locator('.ps-field-panel.ps-panel-visible');
        await expect(panel).toBeVisible({ timeout: 3000 });
        await panel.locator('.ps-panel-btn-redact').click();
        await expect(page.locator('.ps-field-badge.ps-badge-protected')).toBeVisible({ timeout: 5000 });

        const { extPage, read } = await openBadgeReader(context, extensionId);
        await expect.poll(read, { timeout: 10000 }).toBe('✓');

        await extPage.close();
        await page.close();
    });

    test('clears the badge on navigation', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, MOCK_SERVER_URL);

        const page = await context.newPage();
        await page.goto(CONTENT_PAGE_URL);
        await page.waitForLoadState('domcontentloaded');
        const textarea = page.locator('#userInput');
        await textarea.click();
        await textarea.fill('My name is Jane Doe');

        // Reader resolves the tab id while still on the fixture URL.
        const { extPage, read } = await openBadgeReader(context, extensionId);
        await expect.poll(read, { timeout: 10000 }).toMatch(/^[1-9]/);

        // Navigate away — the badge must clear for that tab.
        await page.goto('about:blank');
        await page.waitForLoadState('domcontentloaded');
        await expect.poll(read, { timeout: 10000 }).toBe('');

        await extPage.close();
        await page.close();
    });
});

test.describe('Accessibility (U8)', () => {
    let mockServer;

    test.beforeEach(async () => {
        mockServer = await startMockServer({
            port: MOCK_SERVER_PORT,
            healthy: true,
            loaded: true,
            detections: MOCK_MODEL_DETECTIONS,
            pages: { [CONTENT_PAGE_PATH]: TEST_PAGE_HTML },
            handlers: {
                'POST /detect': ({ body, cors }) => {
                    let payload = {};
                    try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
                    return { headers: cors, body: { ok: true, detections: buildMockDetectionsForText(String(payload.text || '')) } };
                },
            },
        });
    });

    test.afterEach(async () => {
        if (mockServer) await stopMockServer(mockServer);
        mockServer = null;
    });

    test('badge is a keyboard-operable button that opens the panel; Escape closes and returns focus', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, MOCK_SERVER_URL);

        const page = await context.newPage();
        await page.goto(CONTENT_PAGE_URL);
        await page.waitForLoadState('domcontentloaded');
        const textarea = page.locator('#userInput');
        await textarea.click();
        await textarea.fill('My name is Jane Doe');

        const badge = page.locator('.ps-field-badge.ps-badge-pending');
        await expect(badge).toBeVisible({ timeout: 8000 });
        await expect(badge).toHaveAttribute('role', 'button');
        await expect(badge).toHaveAttribute('aria-label', /need attention/);

        // Keyboard open.
        await badge.focus();
        await page.keyboard.press('Enter');
        const panel = page.locator('.ps-field-panel.ps-panel-visible');
        await expect(panel).toBeVisible({ timeout: 3000 });
        await expect(panel).toHaveAttribute('role', 'dialog');

        // Escape closes and focus returns to the badge.
        await page.keyboard.press('Escape');
        await expect(page.locator('.ps-field-panel.ps-panel-visible')).toBeHidden({ timeout: 3000 });
        const focusedIsBadge = await page.evaluate(() =>
            document.activeElement?.classList?.contains('ps-field-badge') === true);
        expect(focusedIsBadge).toBe(true);

        await page.close();
    });

    test('redact-all is announced via an aria-live region', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, MOCK_SERVER_URL);

        const page = await context.newPage();
        await page.goto(CONTENT_PAGE_URL);
        await page.waitForLoadState('domcontentloaded');
        const textarea = page.locator('#userInput');
        await textarea.click();
        await textarea.fill('My name is Jane Doe');

        const badge = page.locator('.ps-field-badge.ps-badge-pending');
        await expect(badge).toBeVisible({ timeout: 8000 });
        await badge.click();
        const panel = page.locator('.ps-field-panel.ps-panel-visible');
        await expect(panel).toBeVisible({ timeout: 3000 });
        await panel.locator('.ps-panel-btn-redact').click();

        const live = page.locator('[role="status"][aria-live="polite"]');
        await expect.poll(async () => (await live.textContent()) || '', { timeout: 5000 }).toMatch(/protected/);

        await page.close();
    });

    test('token tray chips expose an action+type aria-label', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        await setLocalServerOverride(context, extensionId, MOCK_SERVER_URL);

        const page = await context.newPage();
        await page.goto(CONTENT_PAGE_URL);
        await page.waitForLoadState('domcontentloaded');
        const textarea = page.locator('#userInput');
        await textarea.click();
        await textarea.fill('My name is Jane Doe');

        const badge = page.locator('.ps-field-badge.ps-badge-pending');
        await expect(badge).toBeVisible({ timeout: 8000 });
        await badge.click();
        const panel = page.locator('.ps-field-panel.ps-panel-visible');
        await expect(panel).toBeVisible({ timeout: 3000 });
        await panel.locator('.ps-panel-btn-redact').click();
        await page.keyboard.press('Escape');

        const chip = page.locator('.ps-token-chip').first();
        await expect(chip).toHaveAttribute('aria-label', /Restore|Re-redact/, { timeout: 5000 });

        await page.close();
    });
});
