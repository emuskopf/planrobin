'use strict';
// Playwright config for the UX FLOOR SUITE (tests/ux). Deterministic: every /api/* is replayed
// from committed fixtures, so the suite needs no database and no network — just the static site
// served by the dev server. Runs locally and in the deploy gate.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/ux',
  testMatch: /.*\.spec\.js$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: process.env.CI ? 2 : 4,
  timeout: 30000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'tests/ux/report' }]],
  use: {
    baseURL: 'http://localhost:8788',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node dev/server.js',
    port: 8788,
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
