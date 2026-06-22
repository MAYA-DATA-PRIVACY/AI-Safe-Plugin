/**
 * fixtures.js — Playwright test fixtures for the MAYA AISafe Plugin extension (CommonJS).
 *
 * Usage:
 *   const { test, expect } = require('./fixtures');
 */
const { test: base, chromium, expect } = require('@playwright/test');
const path = require('path');

const EXTENSION_PATH = path.resolve(__dirname, '..', '..', 'extension');

/**
 * Launch a Chromium instance with the MAYA AISafe Plugin extension loaded.
 */
async function launchWithExtension() {
    const context = await chromium.launchPersistentContext('', {
        headless: false,
        args: [
            `--disable-extensions-except=${EXTENSION_PATH}`,
            `--load-extension=${EXTENSION_PATH}`,
            '--no-first-run',
            '--no-default-browser-check',
        ],
    });

    // Wait for the service worker so we can get the extension id
    let [background] = context.serviceWorkers();
    if (!background) {
        background = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    }

    const extensionId = background.url().split('/')[2];
    return { context, extensionId };
}

const test = base.extend({
    /**
     * extensionContext fixture — fresh browser context with extension installed.
     */
    extensionContext: async ({ }, use) => {
        const { context, extensionId } = await launchWithExtension();
        await use({ context, extensionId });
        await context.close();
    },

    /**
     * extensionPopup fixture — popup page pre-opened, ready for interaction.
     */
    extensionPopup: async ({ }, use) => {
        const { context, extensionId } = await launchWithExtension();
        const page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/popup.html`);
        await page.waitForLoadState('domcontentloaded');
        await use({ page, context, extensionId });
        await context.close();
    },

    /**
     * extensionOptions fixture — options page pre-opened, ready for interaction.
     */
    extensionOptions: async ({ }, use) => {
        const { context, extensionId } = await launchWithExtension();
        const page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/options.html`);
        await page.waitForLoadState('domcontentloaded');
        await use({ page, context, extensionId });
        await context.close();
    },
});

module.exports = { test, expect };
