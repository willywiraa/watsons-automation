import { expect, type BrowserContext, type Locator } from '@playwright/test';

// Step-by-step recordings ("traces") of staging tests are started and stopped here (see
// src/fixtures/staging.ts), not by Playwright's `trace` setting, so they can be stopped
// completely around the login.
const RECORDING_OPTIONS = { screenshots: true, snapshots: true, sources: true };
const recording = new WeakSet<BrowserContext>();

export async function startRecording(context: BrowserContext): Promise<void> {
  await context.tracing.start(RECORDING_OPTIONS);
  recording.add(context);
}

/**
 * Stops the recording. With `path`, saves it there; without, throws it away.
 * Returns false if nothing was being recorded.
 */
export async function stopRecording(context: BrowserContext, path?: string): Promise<boolean> {
  if (!recording.has(context)) return false;
  recording.delete(context);
  await context.tracing.stop(path ? { path } : undefined);
  return true;
}

/**
 * Runs `action` with recording stopped, so private values typed during it, and the page
 * requests that carry them, never end up in a recording. Only pausing a recording is not
 * enough: the browser still logged the login request once recording resumed (seen
 * 2026-10-04). So the recording so far is thrown away and a new one starts afterwards.
 *
 * If `action` fails, `privateFields` are emptied before recording restarts: otherwise the
 * typed values show up in the failure's page snapshot and recording (seen 2026-10-04).
 */
export async function withRecordingPaused<T>(
  context: BrowserContext,
  action: () => Promise<T>,
  privateFields: Locator[] = [],
): Promise<T> {
  const wasRecording = await stopRecording(context);
  try {
    return await action();
  } catch (error) {
    for (const field of privateFields) {
      await field.evaluate((input) => ((input as HTMLInputElement).value = '')).catch(() => {});
    }
    throw error;
  } finally {
    if (wasRecording) await startRecording(context);
  }
}

/**
 * Types a private value (username, password) into a text field. Playwright's normal fill()
 * shows the typed text in the test report (`Fill "<value>"`); this shows only "Evaluate".
 * Use it inside withRecordingPaused() so the value stays out of recordings too.
 *
 * Staging shows its forms before the site's app has started, and text entered that early is
 * lost (seen 2026-10-04). So the value is entered again until the form marks the field as
 * changed (Angular's "ng-dirty" form-state class), for up to 30 seconds.
 */
export async function enterPrivateText(field: Locator, value: string): Promise<void> {
  await expect(async () => {
    await field.focus();
    await field.evaluate((element, text) => {
      const input = element as HTMLInputElement;
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    await expect(field).toHaveClass(/\bng-dirty\b/, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * enterPrivateText() for the backoffice, which is built with ZK instead of Angular. ZK takes a
 * field's value when the field loses focus, so the value is set, the field is left, and then
 * ZK's own copy is checked against it inside the page (only "same or not" comes back). Same
 * rules: use it inside withRecordingPaused().
 */
export async function enterPrivateTextZk(field: Locator, value: string): Promise<void> {
  await expect(async () => {
    await field.focus();
    await field.evaluate((element, text) => {
      const input = element as HTMLInputElement;
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await field.blur();
    const taken = await field.evaluate((element, text) => {
      type ZkWidget = { getValue(): unknown };
      const zk = (window as unknown as { zk?: { Widget: { $(node: Element): ZkWidget | null } } }).zk;
      return zk?.Widget.$(element)?.getValue() === text;
    }, value);
    expect(taken, 'the backoffice page took the typed value').toBe(true);
  }).toPass({ timeout: 30_000 });
}
