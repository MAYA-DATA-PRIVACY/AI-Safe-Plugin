// playwright.config.js — AI-Safe Plugin extension E2E test configuration (CommonJS)
// @ts-check
const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
    testDir: './tests/e2e',
    timeout: 60_000,
    retries: 1,
    // Run serially — extension tests share port 8765 and can't run in parallel
    workers: 1,
    fullyParallel: false,
    reporter: [['line'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
    use: {
        // Headless is not supported when loading extensions in Playwright.
        headless: false,
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },
    projects: [
        {
            name: 'chromium-extension',
            use: {
                ...devices['Desktop Chrome'],
                channel: 'chromium',
            },
        },
    ],
    outputDir: 'test-results',
});
