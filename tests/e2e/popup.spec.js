/**
 * popup.spec.js — E2E tests for the AI-Safe Plugin extension popup (CommonJS).
 */
const { test, expect } = require('./fixtures');
const { startMockServer, stopMockServer } = require('./mock_server');

const MOCK_SERVER_PORT = 18775;
const MOCK_SERVER_URL = `http://127.0.0.1:${MOCK_SERVER_PORT}`;
const POPUP_SITE_PATH = '/popup-site';
const POPUP_SITE_URL = `${MOCK_SERVER_URL}${POPUP_SITE_PATH}`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function clearOnboarding(page) {
    await page.evaluate(() => new Promise((resolve) => chrome.storage.local.remove('aiSafePluginOnboardingDone', resolve)));
}

async function markOnboardingDone(page) {
    await page.evaluate(() => new Promise((resolve) => chrome.storage.local.set({ aiSafePluginOnboardingDone: true }, resolve)));
}

async function setLocalServerOverride(page, url) {
    await page.evaluate(
        (localServerUrl) => new Promise((resolve) => chrome.storage.local.set({
            aiSafePluginLocalServerUrlOverride: localServerUrl,
        }, resolve)),
        url,
    );
}

async function clearLocalServerOverride(page) {
    await page.evaluate(() => new Promise((resolve) => chrome.storage.local.remove('aiSafePluginLocalServerUrlOverride', resolve)));
}

async function openPopupForSite(context, extensionId, url) {
    const target = await context.newPage();
    await target.goto(url);
    await target.waitForLoadState('domcontentloaded');

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.waitForLoadState('domcontentloaded');
    await markOnboardingDone(page);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#currentSiteHost')).toHaveText('127.0.0.1');
    return { page, target };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe('Popup UI', () => {
    test('popup page title is "AI-Safe Plugin"', async ({ extensionPopup }) => {
        const { page } = extensionPopup;
        await expect(page).toHaveTitle(/AI-Safe Plugin/i);
    });

    test('AI-Safe Plugin branding is visible', async ({ extensionPopup }) => {
        const { page } = extensionPopup;
        await markOnboardingDone(page);
        await page.reload();
        await page.waitForLoadState('domcontentloaded');
        await expect(page.locator('.brand-name')).toHaveText('AI-Safe Plugin');
    });

    test('status card is visible', async ({ extensionPopup }) => {
        const { page } = extensionPopup;
        await markOnboardingDone(page);
        await page.reload();
        await page.waitForLoadState('domcontentloaded');
        await expect(page.locator('#statusText')).toBeVisible();
    });

    test('detection and redaction stats are rendered', async ({ extensionPopup }) => {
        const { page } = extensionPopup;
        await markOnboardingDone(page);
        await page.reload();
        await page.waitForLoadState('domcontentloaded');
        await expect(page.locator('#detectionCount')).toBeVisible();
        await expect(page.locator('#redactionCount')).toBeVisible();
    });

    test('installer commands point at the Maya release repo', async ({ extensionPopup }) => {
        const { page } = extensionPopup;
        await markOnboardingDone(page);
        await page.reload();
        await page.waitForLoadState('domcontentloaded');
        await expect(page.locator('#nativeHostInstallCommand')).toContainText('github.com/Maya-Data-Privacy/AI-Safe-Plugin/releases/latest/download');
        await expect(page.locator('#nativeHostUninstallCommand')).toContainText('github.com/Maya-Data-Privacy/AI-Safe-Plugin/releases/latest/download');
    });
});

test.describe('Per-site Quick Controls', () => {
    let mockServer;

    test.beforeEach(async () => {
        mockServer = await startMockServer({
            port: MOCK_SERVER_PORT,
            healthy: true,
            loaded: true,
            pages: {
                [POPUP_SITE_PATH]: '<!DOCTYPE html><html><body><textarea id="field"></textarea></body></html>',
            },
        });
    });

    test.afterEach(async () => {
        if (mockServer) await stopMockServer(mockServer);
        mockServer = null;
    });

    test('turning Off here writes the current host to excludedSites', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        const { page, target } = await openPopupForSite(context, extensionId, POPUP_SITE_URL);

        await page.locator('#siteToggleButton').click();
        await expect(page.locator('#siteToggleButton')).toHaveText('Turn on');
        await expect(page.locator('#siteSnoozeStatus')).toHaveText('Off on this site');
        await expect(page.locator('#pauseSiteButton')).toBeHidden();
        const excludedSites = await page.evaluate(() => new Promise((resolve) => {
            chrome.storage.local.get('excludedSites', (result) => resolve(result.excludedSites || []));
        }));

        expect(excludedSites).toContain('127.0.0.1');
        await page.close();
        await target.close();
    });

    test('Pause 1h writes a future siteSnoozes entry and Resume clears it', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        const { page, target } = await openPopupForSite(context, extensionId, POPUP_SITE_URL);

        await page.locator('#pauseSiteButton').click();
        await expect(page.locator('#siteSnoozeStatus')).toContainText('Paused');
        await expect(page.locator('#pauseSiteButton')).toHaveText('Resume');
        const pausedUntil = await page.evaluate(() => new Promise((resolve) => {
            chrome.storage.local.get('siteSnoozes', (result) => resolve(result.siteSnoozes?.['127.0.0.1'] || 0));
        }));
        expect(pausedUntil).toBeGreaterThan(Date.now());

        await page.locator('#pauseSiteButton').click();
        const afterResume = await page.evaluate(() => new Promise((resolve) => {
            chrome.storage.local.get('siteSnoozes', (result) => resolve(result.siteSnoozes || {}));
        }));
        expect(afterResume['127.0.0.1']).toBeUndefined();

        await page.close();
        await target.close();
    });

    test('global Protection off disables site actions instead of showing conflicting controls', async ({ extensionContext }) => {
        const { context, extensionId } = extensionContext;
        const { page, target } = await openPopupForSite(context, extensionId, POPUP_SITE_URL);

        await page.locator('label.qs-toggle').filter({ has: page.locator('#enabledToggle') }).click();
        await expect(page.locator('#siteSnoozeStatus')).toHaveText('Global protection is off');
        await expect(page.locator('#pauseSiteButton')).toBeHidden();
        await expect(page.locator('#siteToggleButton')).toBeDisabled();

        await page.close();
        await target.close();
    });
});

test.describe('Onboarding Wizard', () => {
    test('overlay appears when aiSafePluginOnboardingDone is unset', async ({ extensionPopup }) => {
        const { page } = extensionPopup;
        await clearOnboarding(page);
        await page.reload();
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(500);
        await expect(page.locator('#onboardingOverlay')).toBeVisible();
    });

    test('step 0 shows welcome title', async ({ extensionPopup }) => {
        const { page } = extensionPopup;
        await clearOnboarding(page);
        await page.reload();
        await page.waitForTimeout(500);
        await expect(page.locator('.onboarding-title').first()).toContainText('Welcome to AI-Safe Plugin');
    });

    test('skip button hides the overlay', async ({ extensionPopup }) => {
        const { page } = extensionPopup;
        await clearOnboarding(page);
        await page.reload();
        await page.waitForTimeout(500);
        await page.locator('#onboardingSkipBtn').click({ force: true });
        await expect(page.locator('#onboardingOverlay')).toBeHidden();
    });

    test('skip sets aiSafePluginOnboardingDone in storage', async ({ extensionPopup }) => {
        const { page } = extensionPopup;
        await clearOnboarding(page);
        await page.reload();
        // Wait for overlay to be visible before clicking
        await page.locator('#onboardingOverlay').waitFor({ state: 'visible', timeout: 5000 });
        await page.locator('#onboardingSkipBtn').click({ force: true });
        const done = await page.evaluate(() =>
            new Promise((resolve) => chrome.storage.local.get('aiSafePluginOnboardingDone', (r) => resolve(r.aiSafePluginOnboardingDone)))
        );
        expect(done).toBeTruthy();
    });

    test('Get Started navigates to step 1 (native host)', async ({ extensionPopup }) => {
        const { page } = extensionPopup;
        await clearOnboarding(page);
        await page.reload();
        // Wait for overlay to be fully visible (async _checkAndShow must finish)
        await page.locator('#onboardingOverlay').waitFor({ state: 'visible', timeout: 8000 });
        // Step 0 must be shown before clicking
        await expect(page.locator('[data-step="0"].onboarding-step')).toBeVisible();
        await page.locator('#onboardingNextBtn0').click({ force: true });
        // Give JS time to run _goToStep(1) and update the DOM
        await page.waitForTimeout(400);
        await expect(page.locator('.onboarding-title').filter({ visible: true })).toContainText('Native Bridge');
    });

    test('overlay is not shown when onboarding already done', async ({ extensionPopup }) => {
        const { page } = extensionPopup;
        await markOnboardingDone(page);
        await page.reload();
        await page.waitForTimeout(500);
        await expect(page.locator('#onboardingOverlay')).toBeHidden();
    });
});

test.describe('Server Controls UI', () => {
    test('Start Server button is visible', async ({ extensionOptions }) => {
        const { page } = extensionOptions;
        await expect(page.locator('#startServerButton')).toBeVisible();
    });

    test('Restart Server button is visible', async ({ extensionOptions }) => {
        const { page } = extensionOptions;
        await expect(page.locator('#restartServerButton')).toBeVisible();
    });
});

test.describe('Server Status (with mock server)', () => {
    let mockServer;

    test.beforeEach(async () => {
        mockServer = await startMockServer({ port: MOCK_SERVER_PORT, healthy: true, loaded: true });
    });

    test.afterEach(async ({ extensionOptions }) => {
        const { page } = extensionOptions;
        await clearLocalServerOverride(page);
        if (mockServer) await stopMockServer(mockServer); // stopMockServer handles null safely
    });

    test('status dot gets active class when server is healthy', async ({ extensionOptions }) => {
        const { page } = extensionOptions;
        await setLocalServerOverride(page, MOCK_SERVER_URL);
        await page.waitForTimeout(4000);
        const dot = page.locator('#statusDot');
        const hasActive = await dot.evaluate((el) => el.classList.contains('active'));
        const hasWarn = await dot.evaluate((el) => el.classList.contains('warn'));
        expect(hasActive || hasWarn).toBe(true);
    });

    test('regex runtime note reflects AI-only vs AI-plus-regex states', async ({ extensionOptions }) => {
        const { page } = extensionOptions;
        await page.waitForFunction(() => {
            const sm = window.__AI_SAFE_PLUGIN_SETTINGS_MANAGER__;
            return sm && sm._initPromise;
        });
        await page.evaluate(() => window.__AI_SAFE_PLUGIN_SETTINGS_MANAGER__._initPromise);
        await page.evaluate(() => {
            const sm = window.__AI_SAFE_PLUGIN_SETTINGS_MANAGER__;
            if (sm.serverPollTimer) {
                clearInterval(sm.serverPollTimer);
                sm.serverPollTimer = null;
            }
            sm.refreshServerStatus = async () => { };
            sm.serverPhase = 'ready';
            sm.serverState = {
                ...sm.serverState,
                known: true,
                installed: true,
                running: true,
                healthy: true,
            };
            sm.settings.enabled = true;
            sm.settings.includeRegexWhenModelOnline = false;
            sm.renderRegexRuntimeState();
        });

        await expect(page.locator('#regexRuntimeState')).toContainText('AI only');

        await page.evaluate(() => {
            const sm = window.__AI_SAFE_PLUGIN_SETTINGS_MANAGER__;
            sm.settings.includeRegexWhenModelOnline = true;
            sm.renderRegexRuntimeState();
        });
        await expect(page.locator('#regexRuntimeState')).toContainText('AI + Regex active');
    });
});

test.describe('Settings Persistence', () => {
    test('sensitivity selection persists across reload', async ({ extensionOptions }) => {
        const { page } = extensionOptions;

        await expect(page.locator('#sensitivitySelect')).toBeVisible();
        await page.locator('#sensitivitySelect').selectOption('high');
        await page.waitForTimeout(500);

        await page.reload();
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(500);

        const value = await page.locator('#sensitivitySelect').inputValue();
        expect(value).toBe('high');
    });

    test('protection toggle persists when unchecked', async ({ extensionOptions }) => {
        const { page } = extensionOptions;

        const toggle = page.locator('#enabledToggle');
        const toggleControl = page.locator('label.opt-cb-toggle').filter({ has: toggle });
        await expect(toggleControl).toBeVisible();
        const isChecked = await toggle.isChecked();
        if (isChecked) {
            await toggleControl.click();
            await expect(toggle).not.toBeChecked();
        }
        await page.waitForTimeout(500);

        await page.reload();
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(500);

        expect(await page.locator('#enabledToggle').isChecked()).toBe(false);
    });
});

test.describe('Release Status UX', () => {
    test('shows backend already updated even when the extension build is behind', async ({ extensionOptions }) => {
        const { page } = extensionOptions;

        await page.waitForFunction(() => {
            const sm = window.__AI_SAFE_PLUGIN_SETTINGS_MANAGER__;
            return sm && sm._initPromise;
        });
        await page.evaluate(() => window.__AI_SAFE_PLUGIN_SETTINGS_MANAGER__._initPromise);
        await page.evaluate(() => {
            const sm = window.__AI_SAFE_PLUGIN_SETTINGS_MANAGER__;
            clearInterval(sm.serverPollTimer);
            clearInterval(sm.statsPollTimer);
            sm.serverPollTimer = null;
            sm.statsPollTimer = null;
            sm.refreshServerStatus = async () => { };
            sm.refreshReleaseInfo = async () => { };
            sm.refreshReleaseSurface = async () => { };
            sm.releaseInfo = {
                ...sm.getDefaultReleaseInfo(),
                status: 'ready',
                latestTag: 'v9.9.9',
                publishedAt: '2026-04-02T08:00:00Z',
                htmlUrl: 'https://github.com/Maya-Data-Privacy/AI-Safe-Plugin/releases/tag/v9.9.9',
                comparableToExtension: true,
                extensionUpdateAvailable: true,
                error: '',
            };
            sm.serverMeta = {
                ...sm.serverMeta,
                bundleReleaseTag: 'v9.9.9',
            };
            sm.renderReleaseInfo();
        });

        await expect(page.locator('#sidebarUpdateTitle')).toHaveText('Backend current, extension behind');
        await expect(page.locator('#releaseNoticeTitle')).toHaveText('Reload the extension to finish updating AI-Safe Plugin');
        await expect(page.locator('#serverUpdateBlock')).toBeHidden();
    });

    test('surfaces missing backend metadata as a refresh step instead of a false outdated warning', async ({ extensionOptions }) => {
        const { page } = extensionOptions;

        await page.waitForFunction(() => {
            const sm = window.__AI_SAFE_PLUGIN_SETTINGS_MANAGER__;
            return sm && sm._initPromise;
        });
        await page.evaluate(() => window.__AI_SAFE_PLUGIN_SETTINGS_MANAGER__._initPromise);
        await page.evaluate(() => {
            const sm = window.__AI_SAFE_PLUGIN_SETTINGS_MANAGER__;
            clearInterval(sm.serverPollTimer);
            clearInterval(sm.statsPollTimer);
            sm.serverPollTimer = null;
            sm.statsPollTimer = null;
            sm.refreshServerStatus = async () => { };
            sm.refreshReleaseInfo = async () => { };
            sm.refreshReleaseSurface = async () => { };
            const manifestVersion = chrome.runtime.getManifest().version;
            sm.releaseInfo = {
                ...sm.getDefaultReleaseInfo(),
                status: 'ready',
                latestTag: `v${manifestVersion}`,
                publishedAt: '2026-04-02T08:00:00Z',
                htmlUrl: 'https://github.com/Maya-Data-Privacy/AI-Safe-Plugin/releases/latest',
                comparableToExtension: true,
                extensionUpdateAvailable: false,
                error: '',
            };
            sm.serverMeta = {
                ...sm.serverMeta,
                bundleReleaseTag: '',
            };
            sm.renderReleaseInfo();
        });

        await expect(page.locator('#sidebarUpdateTitle')).toHaveText('Backend version needs verification');
        await expect(page.locator('#releaseStatusSubtext')).toContainText('needs one local server refresh');
        await expect(page.locator('#serverUpdateBlock')).toBeVisible();
    });

    test('keeps the local server verified when GitHub release lookup fails but bundled metadata is known', async ({ extensionOptions }) => {
        const { page } = extensionOptions;

        await page.waitForFunction(() => {
            const sm = window.__AI_SAFE_PLUGIN_SETTINGS_MANAGER__;
            return sm && sm._initPromise;
        });
        await page.evaluate(() => window.__AI_SAFE_PLUGIN_SETTINGS_MANAGER__._initPromise);
        await page.evaluate(() => {
            const sm = window.__AI_SAFE_PLUGIN_SETTINGS_MANAGER__;
            clearInterval(sm.serverPollTimer);
            clearInterval(sm.statsPollTimer);
            sm.serverPollTimer = null;
            sm.statsPollTimer = null;
            sm.refreshServerStatus = async () => { };
            sm.refreshReleaseInfo = async () => { };
            sm.refreshReleaseSurface = async () => { };
            sm.releaseInfo = {
                ...sm.getDefaultReleaseInfo(),
                status: 'error',
                error: 'GitHub release check failed (403).',
            };
            const v = chrome.runtime.getManifest().version;
            sm.serverMeta = {
                ...sm.serverMeta,
                bundleReleaseTag: `v${v}`,
                bundleReleaseUrl: `https://github.com/Maya-Data-Privacy/AI-Safe-Plugin/releases/tag/v${v}`,
            };
            sm.renderReleaseInfo();
        });

        const extVersion = await page.evaluate(() => chrome.runtime.getManifest().version);
        await expect(page.locator('#sidebarUpdateTitle')).toHaveText('Everything looks current locally');
        await expect(page.locator('#releaseStatusText')).toContainText(`Everything looks current locally: v${extVersion}`);
        await expect(page.locator('#releaseStatusSubtext')).toContainText('GitHub release checks are temporarily unavailable');
    });

    test('shows backend version unknown instead of a generic update failure when both GitHub and local metadata are unavailable', async ({ extensionOptions }) => {
        const { page } = extensionOptions;

        await page.waitForFunction(() => {
            const sm = window.__AI_SAFE_PLUGIN_SETTINGS_MANAGER__;
            return sm && sm._initPromise;
        });
        await page.evaluate(() => window.__AI_SAFE_PLUGIN_SETTINGS_MANAGER__._initPromise);
        await page.evaluate(() => {
            const sm = window.__AI_SAFE_PLUGIN_SETTINGS_MANAGER__;
            clearInterval(sm.serverPollTimer);
            clearInterval(sm.statsPollTimer);
            sm.serverPollTimer = null;
            sm.statsPollTimer = null;
            sm.refreshServerStatus = async () => { };
            sm.refreshReleaseInfo = async () => { };
            sm.refreshReleaseSurface = async () => { };
            sm.releaseInfo = {
                ...sm.getDefaultReleaseInfo(),
                status: 'error',
                error: 'GitHub release check failed (403).',
            };
            sm.serverMeta = {
                ...sm.serverMeta,
                bundleReleaseTag: '',
                bundleReleaseUrl: '',
            };
            sm.renderReleaseInfo();
        });

        await expect(page.locator('#sidebarUpdateTitle')).toHaveText('Backend version unknown');
        await expect(page.locator('#releaseStatusText')).toContainText('Backend version unknown right now');
        await expect(page.locator('#serverUpdateBlock')).toBeVisible();
    });
});

test.describe('Options Navigation', () => {
    test('sidebar navigation lands headings below the sticky control bar', async ({ extensionOptions }) => {
        const { page } = extensionOptions;

        await page.locator('.opt-nav-item[data-section="protection"]').click();
        await page.waitForTimeout(500);

        const barBox = await page.locator('.opt-control-bar').boundingBox();
        const headingBox = await page.locator('#section-protection .opt-section-title').boundingBox();

        expect(barBox).not.toBeNull();
        expect(headingBox).not.toBeNull();
        expect(headingBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 1);
    });

    test('about remains clickable and becomes the active section near the bottom', async ({ extensionOptions }) => {
        const { page } = extensionOptions;

        await page.locator('.opt-nav-item[data-section="about"]').click();
        await page.waitForFunction(() => document.querySelector('.opt-nav-item[data-section="about"]').classList.contains('is-active'));

        const barBox = await page.locator('.opt-control-bar').boundingBox();
        const headingBox = await page.locator('#section-about .opt-section-title').boundingBox();

        expect(barBox).not.toBeNull();
        expect(headingBox).not.toBeNull();
        expect(headingBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 1);
        await expect(page.locator('.opt-nav-item[data-section="about"]')).toHaveClass(/is-active/);
    });
});

test.describe('Delete all AI-Safe Plugin data', () => {
    test('two-click wipe clears sensitive keys and re-seeds defaults', async ({ extensionOptions }) => {
        const { page } = extensionOptions;

        await page.waitForFunction(() => {
            const sm = window.__AI_SAFE_PLUGIN_SETTINGS_MANAGER__;
            return sm && sm._initPromise;
        });
        await page.evaluate(() => window.__AI_SAFE_PLUGIN_SETTINGS_MANAGER__._initPromise);

        // Seed sensitive, non-default data that a true wipe must remove.
        await page.evaluate(() => new Promise((resolve) => chrome.storage.local.set({
            aiSafePluginApiKey: 'fake-secret-key',
            'ai_safe_plugin::aliases::example.com': { aliases: { person: 'Alias_1' }, updatedAt: Date.now() },
            aiSafePluginStats: { totalProtected: 5, byLabel: { person: 5 }, byWeek: { '2026-W25': 5 } },
        }, resolve)));

        const before = await page.evaluate(() =>
            new Promise((resolve) => chrome.storage.local.get(['aiSafePluginApiKey', 'ai_safe_plugin::aliases::example.com'], resolve)));
        expect(before.aiSafePluginApiKey).toBe('fake-secret-key');
        expect(before['ai_safe_plugin::aliases::example.com']).toBeTruthy();

        const button = page.locator('#deleteAllDataButton');
        await expect(button).toBeVisible();

        // First click arms the confirm; second click performs the wipe.
        await button.click();
        await expect(button).toHaveText('Click again to confirm');
        await button.click();
        await page.waitForTimeout(500);

        const after = await page.evaluate(() =>
            new Promise((resolve) => chrome.storage.local.get(null, resolve)));

        expect(after.aiSafePluginApiKey).toBeUndefined();
        expect(after['ai_safe_plugin::aliases::example.com']).toBeUndefined();
        expect(after.aiSafePluginStats).toBeUndefined();
        // Defaults are re-seeded after the wipe.
        expect(after.enabled).toBe(true);
    });
});
