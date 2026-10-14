import { copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { buildOrderResult, formatResultBox, type OrderTestResult } from './order-result';
import type { OrderRunSnapshot } from './order-run';

// Writes the evidence of every order test run (PRD §26, §35) into reports/<run id>/:
//   result.json, log.txt, screenshot-*.png and trace.zip (on failure), html-report/.
// The run id comes from WATSONS_RUN_ID (set in playwright.config.ts, or by the launcher).
// With WATSONS_REPORTS_DIR set (the hosted server), the evidence goes to
// <WATSONS_REPORTS_DIR>/<yyyy-mm-dd>/<run id>/ instead: runs grouped by day (user, 2026-10-08).

const root = join(__dirname, '..', '..');

/** The evidence folder of a run (its id starts with its date, e.g. "2026-10-08_14-20-11"). */
export function evidenceFolder(runId: string, reportsDir = process.env.WATSONS_REPORTS_DIR): string {
  return reportsDir ? join(reportsDir, runId.slice(0, 10), runId) : join(root, 'reports', runId);
}

class OrderResultReporter implements Reporter {
  private readonly runId = process.env.WATSONS_RUN_ID ?? 'run';
  private readonly logs = new Map<TestCase, string[]>();
  private written: { folder: string; result: OrderTestResult }[] = [];

  onStdOut(chunk: string | Buffer, test?: TestCase) {
    if (test) this.logs.set(test, [...(this.logs.get(test) ?? []), chunk.toString()]);
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const attachment = result.attachments.find((item) => item.name === 'order-run' && item.body);
    if (!attachment?.body) return;
    const run = JSON.parse(attachment.body.toString()) as OrderRunSnapshot;

    const name = this.written.length === 0 ? this.runId : `${this.runId}_${this.written.length + 1}`;
    const folder = evidenceFolder(name);
    mkdirSync(folder, { recursive: true });
    // Paths in result.json: from the project folder, or from the reports folder when that is elsewhere.
    const show = (path: string) => relative(process.env.WATSONS_REPORTS_DIR || root, path);

    const screenshots: string[] = [];
    const failureScreenshots: string[] = [];
    let trace: string | undefined;
    for (const item of result.attachments) {
      // Screenshots come as files (Playwright's failure screenshot, one per open page, named
      // "screenshot") or as data (the test's own, e.g. "checkout summary").
      if (item.contentType === 'image/png' && (item.body || (item.path && existsSync(item.path)))) {
        const slug = item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const isFailure = slug === 'screenshot';
        const target = join(folder, `screenshot-${screenshots.length + 1}${isFailure ? '-failure' : slug ? `-${slug}` : ''}.png`);
        if (item.body) writeFileSync(target, item.body);
        else copyFileSync(item.path!, target);
        screenshots.push(show(target));
        if (isFailure) failureScreenshots.push(show(target));
      } else if (item.name === 'trace' && item.path && existsSync(item.path)) {
        trace = join(folder, 'trace.zip');
        copyFileSync(item.path, trace);
      }
    }
    const log = join(folder, 'log.txt');
    writeFileSync(log, (this.logs.get(test) ?? []).join(''));

    const orderResult = buildOrderResult({
      runId: name,
      run,
      passed: result.status === 'passed',
      durationMs: result.duration,
      errorMessage: result.errors[0]?.message,
      artifacts: { folder: show(folder), screenshots, trace: trace ? show(trace) : undefined, log: show(log) },
      failureScreenshots,
    });
    writeFileSync(join(folder, 'result.json'), JSON.stringify(orderResult, null, 2));
    this.written.push({ folder, result: orderResult });

    console.log(`\n${formatResultBox(orderResult)}`);
    if (orderResult.error?.code === 'PAYMENT_RESULT_UNKNOWN') {
      console.log('⚠️ PAYMENT STATE UNKNOWN: check My Account → Order History before running again.');
    }
    if (orderResult.error?.code === 'ORDER_APPROVAL_UNKNOWN') {
      console.log(`⚠️ APPROVAL STATE UNKNOWN: check order ${orderResult.orderNumber ?? ''} in the backoffice by hand before running again.`);
    }
    for (const page of orderResult.error?.pages ?? []) console.log(`Page at failure: ${page}`);
    for (const screenshot of failureScreenshots) console.log(`Failure screenshot: ${screenshot}`);
    console.log(`Evidence: ${show(folder)}`);
  }

  // Runs after the HTML reporter (listed before this one) has written playwright-report/ (or the
  // folder in WATSONS_HTML_REPORT_DIR, see playwright.config.ts).
  onEnd() {
    const htmlReport = process.env.WATSONS_HTML_REPORT_DIR || join(root, 'playwright-report');
    for (const { folder, result } of this.written) {
      if (!existsSync(htmlReport)) continue;
      const target = join(folder, 'html-report');
      cpSync(htmlReport, target, { recursive: true });
      result.artifacts.htmlReport = relative(process.env.WATSONS_REPORTS_DIR || root, join(target, 'index.html'));
      writeFileSync(join(folder, 'result.json'), JSON.stringify(result, null, 2));
    }
  }
}

export default OrderResultReporter;
