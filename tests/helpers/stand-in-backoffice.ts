import type { BrowserContext } from '@playwright/test';
import { STAGING_BACKOFFICE_HOST } from '../../src/safety/staging-guard';

// A stand-in for the staging backoffice, for offline tests (never the real one): its sign-in
// page, the role choice, the main screen with Orders, the Orders list and its search, an order
// with its Fraud Report and Approve Order. It answers every tab of the browser context, and
// nothing else gets out. `signOut` says when it sends the run's tab back to its sign-in page, as
// the real one does when the same account is open in another tab or browser (2026-10-16, 2026-10-24).

export const STAND_IN_ACCOUNT = { username: 'stand.in', password: 'stand-in-password' };

/**
 * When the stand-in can sign the run out: just after Sign In (before the role choice), just
 * after PROCEED, at a search of the Orders list, or when the Fraud Report tab is opened.
 */
export type Moment = 'after-sign-in' | 'after-role' | 'search' | 'fraud-report';

export type StandIn = {
  signIns: number;
  /** Sign-in pages opened without a session cookie: the first one, and after each fresh session. */
  sessionsCleared: number;
  searches: number;
  approveClicks: number;
  /** Each time it signed the run out: "search #2", … */
  signedOut: string[];
};

// The page reads typed values through ZK (src/utils/secrets.ts, enterPrivateTextZk): a stand-in for it.
const ZK = '<script>window.zk = { Widget: { $: (element) => ({ getValue: () => element.value }) } };</script>';
const SIGN_IN = `${ZK}
  <form onsubmit="event.preventDefault(); location.href = '/backoffice/signed-in';">
    <input name="j_username"><input name="j_password" type="password"><button>Sign In</button>
  </form>`;
const ROLES = `
  <table><tr role="row" aria-selected="false" onclick="this.setAttribute('aria-selected', 'true')"><td>WTCSG Customer Support Manager Role</td></tr></table>
  <button onclick="location.href = '/backoffice/proceed'">PROCEED</button>`;
// As seen 2026-10-16: it leaves the page, then lands on the sign-in page.
const BOUNCE = "<p>Loading…</p><script>setTimeout(() => location.replace('/backoffice/login.zul'), 300);</script>";

/**
 * The main screen: Orders, its list with the search, and the opened order (one page, like ZK's).
 * Once clicked, the Orders row is named "Orders selected", as staging's is (seen 2026-11-03).
 */
function home(code: string): string {
  return `
  <table><tr role="row" onclick="document.getElementById('orders').hidden = false; this.setAttribute('aria-selected', 'true'); this.setAttribute('aria-label', 'Orders selected')"><td>Orders</td></tr></table>
  <div id="orders" hidden>
    <div class="yw-textsearch-searchbox"><input id="search"></div>
    <div id="results"></div>
  </div>
  <div id="order" hidden>
    <div role="tablist"><div role="tab">Overview</div><div role="tab" id="fraud-tab">Fraud Report</div></div>
    <div id="fraud"></div>
  </div>
  <script>
    const code = ${JSON.stringify(code)};
    async function call(path) {
      const answer = await (await fetch(path, { method: 'POST' })).json();
      if (answer.signedOut) {
        location.href = '/backoffice/login.zul';
        return null;
      }
      return answer;
    }
    document.getElementById('search').addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter') return;
      const typed = event.target.value;
      const results = document.getElementById('results');
      results.textContent = '';
      const answer = await call('/backoffice/api/search?code=' + encodeURIComponent(typed));
      if (!answer || !answer.found) return;
      const row = document.createElement('tr');
      row.setAttribute('role', 'row');
      row.setAttribute('aria-selected', 'false');
      row.setAttribute('aria-label', 'Row 1 of 1, Order Number: ' + typed + ', Customer: Stand In, Status: ' + answer.status + ', Total Price: S$1.00,');
      row.innerHTML = '<td role="gridcell" aria-label="Order Number"><span class="number"></span></td><td role="gridcell" aria-label="Status"></td>';
      row.querySelector('.number').textContent = typed;
      row.querySelector('[aria-label="Status"]').textContent = answer.status;
      row.querySelector('.number').addEventListener('click', () => {
        row.setAttribute('aria-selected', 'true');
        document.getElementById('order').hidden = false;
      });
      const table = document.createElement('table');
      table.append(row);
      results.append(table);
    });
    document.getElementById('fraud-tab').addEventListener('click', async () => {
      if (!(await call('/backoffice/api/fraud'))) return;
      document.getElementById('fraud').innerHTML =
        '<table><tr role="row" aria-label="Fraud report, null: ' + code + '_FR0, null: hybris,"><td><button title="Approve Order">Approve</button></td></tr></table>';
      document.querySelector('[title="Approve Order"]').addEventListener('click', () => call('/backoffice/api/approve'));
    });
  </script>`;
}

/**
 * The stand-in backoffice for one order (its backoffice code, e.g. WTCSG07134000). Its status is
 * `statusBefore` until Approve Order is clicked, then `statusesAfter` one per search (the last stays).
 */
export async function standInBackoffice(
  context: BrowserContext,
  {
    code = 'WTCSG07134000',
    statusBefore = 'Waiting For Manual Validation',
    statusesAfter = ['Order Split', 'ORDER_EXTRACTED'],
    signOut = () => false,
  }: { code?: string; statusBefore?: string; statusesAfter?: string[]; signOut?: (moment: Moment, count: number, state: StandIn) => boolean } = {},
): Promise<StandIn> {
  const state: StandIn = { signIns: 0, sessionsCleared: 0, searches: 0, approveClicks: 0, signedOut: [] };
  const counts: Record<string, number> = {};
  let afterApproval = 0;
  const signsOut = (moment: Moment) => {
    counts[moment] = (counts[moment] ?? 0) + 1;
    const out = signOut(moment, counts[moment], state);
    if (out) state.signedOut.push(`${moment} #${counts[moment]}`);
    return out;
  };
  // Nothing gets out of this browser context (the last route registered is asked first).
  await context.route('**/*', (route) => route.abort());
  await context.route(`https://${STAGING_BACKOFFICE_HOST}/**`, async (route) => {
    const request = route.request();
    const { pathname, searchParams } = new URL(request.url());
    const html = (body: string, headers: Record<string, string> = {}) => route.fulfill({ contentType: 'text/html', body, headers });
    const json = (body: object) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname.endsWith('/login.zul')) {
      if (!(request.headers().cookie ?? '').includes('JSESSIONID')) state.sessionsCleared++;
      return html(SIGN_IN, { 'Set-Cookie': 'JSESSIONID=stand-in; Path=/' });
    }
    if (pathname.endsWith('/signed-in')) {
      state.signIns++;
      return html(signsOut('after-sign-in') ? BOUNCE : ROLES);
    }
    if (pathname.endsWith('/proceed')) return html(signsOut('after-role') ? BOUNCE : home(code));
    if (pathname.endsWith('/api/search')) {
      state.searches++;
      if (signsOut('search')) return json({ signedOut: true });
      const status = state.approveClicks === 0 ? statusBefore : statusesAfter[Math.min(afterApproval++, statusesAfter.length - 1)];
      return json({ found: searchParams.get('code') === code, status });
    }
    if (pathname.endsWith('/api/fraud')) return json(signsOut('fraud-report') ? { signedOut: true } : { ok: true });
    if (pathname.endsWith('/api/approve')) {
      state.approveClicks++;
      return json({ ok: true });
    }
    return route.fulfill({ status: 404, body: 'Not in the stand-in' });
  });
  return state;
}
