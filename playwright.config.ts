import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

// Load the private settings (staging address, test account, OTP) from .env, if it
// exists. Tests read them through src/config/settings.ts, which reports anything missing.
const envFile = join(__dirname, '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// The hosted server's live browser view (2026-10-14): with WATSONS_LIVE_VIEW_PORT set, the browser
// also opens a DevTools port on this computer only (127.0.0.1), so the server can show the run in
// the person's page and pass their clicks and typing on (server/lib/liveview.cjs).
const liveViewPort = /^\d{2,5}$/.test(process.env.WATSONS_LIVE_VIEW_PORT?.trim() ?? '') ? process.env.WATSONS_LIVE_VIEW_PORT!.trim() : null;

// One id per run, e.g. "2026-10-05_21-26-50": order runs save their evidence in
// reports/<id>/. Set once here (the test workers inherit it), or by the launcher.
const pad = (n: number) => String(n).padStart(2, '0');
const now = new Date();
process.env.WATSONS_RUN_ID ??= `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

// Playwright settings for this project.
// Reference: https://playwright.dev/docs/test-configuration
export default defineConfig({
  // Test files live in the "tests" folder.
  testDir: './tests',

  // Run tests one at a time, in order. This is easier to follow, and the order
  // tests we add later must not run at the same time as each other.
  fullyParallel: false,
  workers: 1,

  // Never re-run a failed test automatically: re-running an order test could
  // create a duplicate order (PRD §41-42).
  retries: 0,

  // Staging is slow (a page can take 10+ seconds), so allow 2 minutes per test and
  // 15 seconds for each check (PRD §40).
  timeout: 120_000,
  expect: { timeout: 15_000 },

  // Show progress in the terminal, save an HTML report that can be opened with
  // "npm run report", and save each order run's evidence in reports/<run id>/ (PRD §35).
  // The hosted server (server/) gives each run its own HTML report folder, so parallel runs
  // don't write over each other's (WATSONS_HTML_REPORT_DIR; not set: playwright-report).
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: process.env.WATSONS_HTML_REPORT_DIR || 'playwright-report' }],
    ['./src/reporting/result-reporter.ts'],
  ],

  use: {
    // A click or page load that can't happen (e.g. a pop-up is in the way) fails after this
    // long instead of waiting until the whole test times out.
    actionTimeout: 30_000,
    navigationTimeout: 60_000,

    // Don't let websites install a service worker (a background script). It could load
    // pages without the safety lock seeing them (src/safety/staging-guard.ts).
    serviceWorkers: 'block',

    launchOptions: liveViewPort ? { args: [`--remote-debugging-port=${liveViewPort}`] } : {},

    // When a test fails, keep a screenshot so we can see what went wrong.
    screenshot: 'only-on-failure',
    // Staging tests also keep a step-by-step recording ("trace") when they fail. It is
    // managed by src/fixtures/staging.ts instead of here, so it can be switched off
    // completely while the login details are typed (src/utils/secrets.ts).
    trace: 'off',
  },

  // Both use the Microsoft Edge that is already installed on this PC.
  projects: [
    {
      // Quick checks (npm test). The long order flow is left out.
      name: 'edge',
      testIgnore: /\.e2e\.spec\.ts$/,
      use: { channel: 'msedge' },
    },
    {
      // The order flow (npm run test:e2e): several minutes, and it changes the test account's bag.
      name: 'e2e',
      testMatch: /\.e2e\.spec\.ts$/,
      testIgnore: /approve\.e2e\.spec\.ts$/,
      use: { channel: 'msedge' },
    },
    {
      // Approving an existing order in the backoffice (npm run approve; the launcher's "Approve
      // existing order"). Its own project, so that only an explicit approve run ever approves.
      name: 'approve',
      testMatch: /approve\.e2e\.spec\.ts$/,
      use: { channel: 'msedge' },
    },
  ],
});
