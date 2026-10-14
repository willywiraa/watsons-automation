import { test as base } from '@playwright/test';
import { readSettings, type Settings } from '../config/settings';
import { closePromoPopupWhenShown } from '../pages/popups';
import { OrderRun } from '../reporting/order-run';
import { checkStagingUrl, installNavigationGuard } from '../safety/staging-guard';
import { startRecording, stopRecording } from '../utils/secrets';

// Use this `test` (instead of the one from '@playwright/test') in every test that opens
// the staging site. Before the browser opens anything, it checks the settings and that
// the address is the approved staging site. During the test, it stops the browser from
// opening any other site, and records the test step by step (kept only if it fails).
export const test = base.extend<{ settings: Settings; stagingUrl: URL; keepRecording: boolean; orderRun: OrderRun }>({
  // Set to true with test.use({ keepRecording: true }) to keep the recording even on success.
  keepRecording: [false, { option: true }],

  settings: async ({}, use) => {
    await use(readSettings());
  },

  stagingUrl: async ({ settings }, use) => {
    await use(checkStagingUrl(settings.stagingUrl));
  },

  // Every page in a test comes from this context, so every page is guarded and recorded.
  // It depends on stagingUrl so the address is checked before any page is used.
  context: async ({ context, stagingUrl, keepRecording }, use, testInfo) => {
    const guard = await installNavigationGuard(context);
    await startRecording(context);

    await use(context);

    const failed = testInfo.status !== testInfo.expectedStatus || guard.blocked.length > 0;
    const path = testInfo.outputPath('trace.zip');
    const keep = failed || keepRecording;
    if ((await stopRecording(context, keep ? path : undefined)) && keep) {
      await testInfo.attach('trace', { path, contentType: 'application/zip' });
    }
    guard.throwIfViolated();
  },

  // The shop's promotion pop-up can cover the page after login: closed whenever it is in the way.
  page: async ({ page }, use) => {
    await closePromoPopupWhenShown(page);
    await use(page);
  },

  // Order tests: tracks the steps and results of the run, plus the browser's console errors,
  // and attaches them for the result reporter (src/reporting/result-reporter.ts).
  orderRun: async ({ page }, use, testInfo) => {
    const run = new OrderRun();
    page.on('console', (message) => {
      if (message.type() === 'error' && run.consoleErrors.length < 20) run.consoleErrors.push(message.text().slice(0, 300));
    });
    await use(run);
    // Telemetry (user's request 2026-10-07): when the run failed, which pages were open. Their
    // screenshots are Playwright's (screenshot: 'only-on-failure'); the reporter files them.
    if (testInfo.status !== testInfo.expectedStatus) run.recordFailure(page.context().pages().map((tab) => tab.url()));
    await testInfo.attach('order-run', { body: JSON.stringify(run.snapshot()), contentType: 'application/json' });
  },
});

export { expect } from '@playwright/test';
