import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrderLine, PickupStoreChoice } from '../src/config/order';
import { choosePickupStore, PICKUP_STORE_STEP } from '../src/flows/shell-station';
import { CheckoutPage } from '../src/pages/CheckoutPage';
import { ShellStationPickup } from '../src/pages/ShellStationPickup';
import type { Answer, Decision, Question } from '../src/utils/ask';

// Offline checks of Shell Station's pickup store (user's request 2026-10-30): Shell Station has no
// Express or Standard, only a pickup store, chosen for the person ("Choose for me") or by them
// ("Let me choose"). The stand-in checkout page and store finder copy what staging showed on
// 2026-10-30: the "Pickup at Shell Station" card, the finder's Region filter, its 12 stores 10 to a
// page (the chosen one first, then by name), "Select this store", and the "Available items" list.

const STORES = [
  { code: 'FUEL426', name: 'SHELL BOON LAY', region: 'WEST', address: '2 BOON LAY AVENUE  ,SHELL BOON LAY  ,649960' },
  { code: 'FUEL435', name: 'SHELL BUKIT BATOK ROAD', region: 'WEST', address: '11 BUKIT BATOK WEST AVENUE 3  ,SHELL BUKIT BATOK ROAD  ,659166' },
  { code: 'FUEL431', name: 'SHELL CHOA CHU KANG', region: 'WEST', address: '20 CHOA CHU KANG DRIVE  ,SHELL CHOA CHU KANG  ,689717' },
  { code: 'FUEL430', name: 'SHELL HAVELOCK', region: 'CENTRAL', address: '548 HAVELOCK ROAD  ,SHELL HAVELOCK  ,169637' },
  { code: 'FUEL432', name: 'SHELL MACPHERSON', region: 'CENTRAL', address: '259 MACPHERSON ROAD  ,SHELL MACPHERSON  ,348584' },
  { code: 'FUEL428', name: 'SHELL NEWTON CIRCUS', region: 'CENTRAL', address: '143 BUKIT TIMAH ROAD  ,SHELL NEWTON CIRCUS  ,229843' },
  { code: 'FUEL429', name: 'SHELL PAYA LEBAR MACPHERSON', region: 'EAST', address: '255 PAYA LEBAR ROAD  ,SHELL PAYA LEBAR MACPHERSON  ,409037' },
  { code: 'FUEL427', name: 'SHELL SELETAR HILLS', region: 'NORTH', address: '298 YIO CHU KANG ROAD  ,SHELL SELETAR HILLS  ,805908' },
  { code: 'FUEL425', name: 'SHELL SENGKANG', region: 'NORTH', address: '61 SENGKANG EAST ROAD  ,SHELL SENGKANG  ,545015' },
  { code: 'FUEL436', name: 'SHELL SIGLAP', region: 'EAST', address: '40 UPPER EAST COAST ROAD  ,SHELL SIGLAP  ,455212' },
  { code: 'FUEL433', name: 'SHELL TAMPINES AVE 2', region: 'EAST', address: '9 TAMPINES AVE 2  ,SHELL TAMPINES AVE 2  ,529731' },
  { code: 'FUEL434', name: 'SHELL TELOK BLANGAH', region: 'SOUTH', address: '450 TELOK BLANGAH ROAD  ,SHELL TELOK BLANGAH  ,98857' },
];
const LINES: OrderLine[] = [
  { plu: '45274', quantity: 1 },
  { plu: '43808', quantity: 1 },
];
const NAMES = { 45274: 'XYZ Oral Pick 22s', 43808: 'XYZ Hair Colour #4.15' };

interface StandIn {
  /** The store chosen when the page opens; null: "Add Shell Station Pick up location". */
  chosen?: string | null;
  /** What the finder says of a store's stock (default "All Available"). */
  availability?: Record<string, string>;
  /** Product names a store marks "Not available". */
  unavailable?: Record<string, string[]>;
  recipient?: { firstName: string; lastName: string; mobileNumber: string };
}

/** The checkout summary page of a Shell Station order, with its store finder. */
async function standIn(page: Page, options: StandIn = {}): Promise<void> {
  const config = {
    stores: STORES,
    names: Object.values(NAMES),
    chosen: options.chosen === undefined ? 'FUEL435' : options.chosen,
    availability: options.availability ?? {},
    unavailable: options.unavailable ?? {},
    recipient: options.recipient ?? { firstName: 'Test', lastName: 'Shopper', mobileNumber: '81234567' },
  };
  const html = `
    <main>
      <wtc-checkout-pickup-place-info id="card"></wtc-checkout-pickup-place-info>
      <div id="option"></div>
      <button class="next-btn"> Checkout </button>
    </main>
    <div role="dialog" id="finder" hidden></div>
    <div role="dialog" id="items" hidden></div>
    <script>
      const config = ${JSON.stringify(config)};
      const byCode = Object.fromEntries(config.stores.map((store) => [store.code, store]));
      let chosen = config.chosen;
      let region = '';
      let shown = 1;
      let picked = null;
      window.calls = [];
      const later = (then) => setTimeout(then, 150);
      function listed() {
        return config.stores
          .filter((store) => !region || store.region === region)
          .sort((a, b) => (a.code === chosen ? -1 : b.code === chosen ? 1 : a.name.localeCompare(b.name)));
      }
      function drawCard() {
        const store = byCode[chosen];
        document.getElementById('card').innerHTML = store
          ? '<div class="delivery-title"><span>Pickup at Shell Station</span></div><div class="address-wrapper cnc">' +
            '<div class="value-container name"><div class="value"> ' + store.name + ' </div></div>' +
            '<div class="value-container address"> ' + store.address + ' </div>' +
            '<div class="receiver-info"><div class="name"><span>Test Shopper</span></div></div>' +
            '<button class="add"><span>Change pickup store</span><i class="icon-arrow-right"></i></button></div>'
          : '<div class="delivery-title"><span>Pickup at Shell Station</span></div><button class="add-shell"><span>Add Shell Station Pick up location</span></button>';
        document.getElementById('option').innerHTML = store
          ? '<e2-radio name="deliveryMethod" class="option express onlyExpress checked"><label><input type="radio" name="deliveryMethod" value="" checked style="display:none">' +
            '<div class="support-title">Estimated Pickup Date/Time: 31/10 (Sat) 14:30</div><button class="amount">View 2 item(s)</button></label></e2-radio>'
          : '';
      }
      function drawFinder() {
        const all = listed();
        const pages = Math.max(1, Math.ceil(all.length / 10));
        const items = all.slice((shown - 1) * 10, shown * 10).map((store, index) =>
          '<wtc-checkout-store-finder-list-item><e2-radio class="option"><div class="form-radio"><label>' +
          '<input type="radio" tabindex="-1" name="StoreFinderComponent-store-' + store.code + '" value="' + store.code + '"' + (store.code === picked ? ' checked' : '') + ' style="position:absolute;opacity:0">' +
          '<div class="store-name-group"><div class="store-id">' + ((shown - 1) * 10 + index + 1) + '</div><div class="store-name">' + store.name + '</div>' +
          (store.code === config.chosen ? '<div class="tag"><span>Recent Pickup Store</span></div>' : '') + '</div>' +
          '<div class="store-address"> ' + store.address + ' </div>' +
          '<div class="pickup-info"><span> ' + (config.availability[store.code] ?? 'All Available') + ' </span></div>' +
          '</label></div></e2-radio></wtc-checkout-store-finder-list-item>');
        const page = (label, target, state) => '<li class="page-item ' + state + '"><a href="javascript:void(0)" data-page="' + target + '">' + label + '</a></li>';
        document.getElementById('finder').innerHTML =
          '<p>Pickup at Shell Station</p><p>Recipient Information</p>' +
          ['firstName', 'lastName', 'mobileNumber'].map((name) => '<input name="' + name + '" value="' + config.recipient[name] + '">').join('') +
          '<div class="form-title"> Select A Store </div>' +
          '<e2-select name="sf-region"><button type="button" class="dropdown-toggle"> ' + (region || 'Select Region') + ' </button><div class="dropdown-menu" hidden>' +
          ['', 'CENTRAL', 'EAST', 'NORTH', 'SOUTH', 'WEST'].map((value) => '<button type="button" class="dropdown-item" value="' + value + '"> ' + (value || 'Select Region') + ' </button>').join('') +
          '</div></e2-select>' +
          '<div class="storeResult"><div class="storeTotal"> ' + all.length + ' Store(s) </div></div><div class="store-list-container">' + items.join('') + '</div>' +
          '<div class="bottom-group"><wtc-pagination><ul class="pagination">' +
          page('‹', 'prev', shown === 1 ? 'disabled' : '') +
          Array.from({ length: pages }, (_, index) => page(String(index + 1), index + 1, index + 1 === shown ? 'active' : '')).join('') +
          page('›', 'next', shown === pages ? 'disabled' : '') +
          '</ul></wtc-pagination><button class="primary"> Select this store </button></div>';
      }
      drawCard();
      document.addEventListener('click', (event) => {
        const target = event.target.closest('button, a, label');
        if (!target) return;
        if (target.matches('.add, .add-shell')) {
          window.calls.push('open finder');
          region = byCode[chosen]?.region ?? '';
          shown = 1;
          picked = chosen;
          document.getElementById('finder').hidden = false;
          later(drawFinder);
        } else if (target.matches('.dropdown-toggle')) {
          target.nextElementSibling.hidden = !target.nextElementSibling.hidden;
        } else if (target.matches('.dropdown-item')) {
          region = target.value;
          shown = 1;
          later(drawFinder);
        } else if (target.matches('[data-page]')) {
          if (target.closest('li').classList.contains('disabled')) return;
          const to = target.dataset.page;
          shown = to === 'prev' ? shown - 1 : to === 'next' ? shown + 1 : Number(to);
          later(drawFinder);
        } else if (target.matches('.bottom-group .primary')) {
          window.calls.push('select ' + picked);
          chosen = picked;
          document.getElementById('finder').hidden = true;
          later(drawCard);
        } else if (target.matches('.amount')) {
          const missing = config.unavailable[chosen] ?? [];
          const items = document.getElementById('items');
          items.innerHTML = '<p>AVAILABLE ITEMS</p>' + config.names.map((name) => '<p>' + name + '</p><p>' + (missing.includes(name) ? 'Not available' : 'In Stock') + '</p>').join('');
          items.hidden = false;
        }
      });
      document.addEventListener('change', (event) => {
        if (!event.target.name?.startsWith('StoreFinderComponent-store-')) return;
        picked = event.target.value;
        for (const other of document.querySelectorAll('#finder input[type="radio"]')) other.checked = other.value === picked;
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') document.getElementById('items').hidden = true;
      });
    </script>`;
  // At the checkout summary's address, which CheckoutPage waits for (nothing leaves this PC).
  await page.route('https://shop.example.test/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://shop.example.test/checkout/single/summary');
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { calls: string[] }).calls);

function run(page: Page, choice: PickupStoreChoice, decisions: Decision[] = []) {
  return choosePickupStore({
    checkout: new CheckoutPage(page),
    pickup: new ShellStationPickup(page),
    choice,
    lines: LINES,
    namesByPlu: NAMES,
    decisions,
    triedMethods: [],
  });
}

// ---- Runs from the launcher: they ask the person (src/utils/ask.ts). ----

const RUN_ID = '2026-10-30_12-00-00';
let reports: string;
let saved: Record<string, string | undefined>;
const folder = () => join(reports, RUN_ID.slice(0, 10), RUN_ID);
function useInteractive() {
  test.beforeEach(() => {
    reports = mkdtempSync(join(tmpdir(), 'shell-test-'));
    saved = { WATSONS_INTERACTIVE: process.env.WATSONS_INTERACTIVE, WATSONS_RUN_ID: process.env.WATSONS_RUN_ID, WATSONS_REPORTS_DIR: process.env.WATSONS_REPORTS_DIR };
    Object.assign(process.env, { WATSONS_INTERACTIVE: 'yes', WATSONS_RUN_ID: RUN_ID, WATSONS_REPORTS_DIR: reports });
  });
  test.afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(reports, { recursive: true, force: true });
  });
}

/** Waits for the run's question and answers it, as the launcher does. */
async function answerNext(answer: Answer): Promise<Question & { id: number }> {
  let asked: (Question & { id: number }) | null = null;
  await expect
    .poll(
      () => {
        try {
          asked = JSON.parse(readFileSync(join(folder(), 'ask.json'), 'utf8'));
          return asked !== null && !existsSync(join(folder(), `answer-${asked.id}.json`));
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const question = asked as unknown as Question & { id: number };
  writeFileSync(join(folder(), `answer-${question.id}.json`), JSON.stringify(answer));
  return question;
}

test.describe('Shell Station: the pickup store', () => {
  test('the page counts as loaded with only "Add Shell Station Pick up location" (no delivery option yet)', async ({ page }) => {
    await standIn(page, { chosen: null });
    const started = Date.now();
    await new CheckoutPage(page).waitUntilLoaded(new ShellStationPickup(page).storeShown);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await new ShellStationPickup(page).chosenStore(PICKUP_STORE_STEP)).toBeNull();
  });

  test('"Choose for me" keeps the store already chosen: the store list is not even opened', async ({ page }) => {
    await standIn(page);
    expect(await run(page, 'auto')).toEqual({ kind: 'ready', kept: LINES, excluded: [], store: 'SHELL BUKIT BATOK ROAD' });
    expect(await calls(page)).toEqual([]);
  });

  test('"Choose for me" with no store yet: the first one in staging’s list that has every product', async ({ page }) => {
    // Store 1 (Boon Lay) lacks a product: store 2 (Bukit Batok) is taken.
    await standIn(page, { chosen: null, availability: { FUEL426: 'Partially Available' } });
    expect(await run(page, 'auto')).toMatchObject({ kind: 'ready', store: 'SHELL BUKIT BATOK ROAD', excluded: [] });
    expect(await calls(page)).toEqual(['open finder', 'select FUEL435']);
    await expect(page.locator('wtc-checkout-pickup-place-info')).toContainText('SHELL BUKIT BATOK ROAD');
  });

  test('a command-line run with "Let me choose" can’t ask: it chooses for itself', async ({ page }) => {
    await standIn(page);
    expect(await run(page, 'ask')).toMatchObject({ kind: 'ready', store: 'SHELL BUKIT BATOK ROAD' });
    expect(await calls(page)).toEqual([]);
  });

  test('products the store doesn’t have: a command-line run goes on without them and says which', async ({ page }) => {
    await standIn(page, { unavailable: { FUEL435: [NAMES[43808]] } });
    expect(await run(page, 'auto')).toEqual({ kind: 'ready', kept: [LINES[0]], excluded: [LINES[1]], store: 'SHELL BUKIT BATOK ROAD' });
    await expect(page.locator('#items')).toBeHidden();
  });

  test('no recipient name or mobile number on the account: a clear error, no store chosen', async ({ page }) => {
    await standIn(page, { chosen: null, recipient: { firstName: '', lastName: 'Shopper', mobileNumber: '' } });
    const error = await run(page, 'auto').catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'PICKUP_STORE_NOT_SELECTED', step: PICKUP_STORE_STEP });
    expect(String((error as Error).message)).toContain("asks for the recipient's first name, mobile number");
    expect(await calls(page)).toEqual(['open finder']);
  });

  test.describe('from the launcher', () => {
    useInteractive();

    test('"Let me choose": every store from every page, the chosen one first; the one picked (on page 2) is selected', async ({ page }) => {
      await standIn(page);
      const decisions: Decision[] = [];
      const [result, asked] = await Promise.all([run(page, 'ask', decisions), answerNext({ action: 'choose', value: 'FUEL433' })]);
      expect(asked).toMatchObject({ kind: 'choose_store', step: PICKUP_STORE_STEP, message: 'Which Shell Station should the order be picked up from?', detail: 'Chosen now: SHELL BUKIT BATOK ROAD.' });
      expect(asked.options.map((option) => option.label)).toEqual(['Use this store', 'Stop automation']);
      // The finder opened on the chosen store's region (1 store): the run showed all 12.
      expect(asked.choices?.map((choice) => choice.value)).toEqual([
        'FUEL435', 'FUEL426', 'FUEL431', 'FUEL430', 'FUEL432', 'FUEL428', 'FUEL429', 'FUEL427', 'FUEL425', 'FUEL436', 'FUEL433', 'FUEL434',
      ]);
      expect(asked.choices?.[0]).toEqual({
        value: 'FUEL435',
        label: 'SHELL BUKIT BATOK ROAD',
        detail: '11 BUKIT BATOK WEST AVENUE 3, SHELL BUKIT BATOK ROAD, 659166 · Recent Pickup Store · All Available',
        selected: true,
      });
      expect(asked.choices?.filter((choice) => choice.selected)).toHaveLength(1);
      expect(result).toEqual({ kind: 'ready', kept: LINES, excluded: [], store: 'SHELL TAMPINES AVE 2' });
      expect(await calls(page)).toEqual(['open finder', 'select FUEL433']);
      await expect(page.locator('wtc-checkout-pickup-place-info')).toContainText('SHELL TAMPINES AVE 2');
      expect(decisions).toMatchObject([{ step: PICKUP_STORE_STEP, kind: 'choose_store', action: 'choose', label: 'Use this store', choice: 'SHELL TAMPINES AVE 2', outcome: 'Pickup store: SHELL TAMPINES AVE 2' }]);
    });

    test('a store that is not in the list ends the run instead of guessing', async ({ page }) => {
      await standIn(page);
      const [result] = await Promise.all([run(page, 'ask').catch((error: unknown) => error), answerNext({ action: 'choose', value: 'FUEL999' })]);
      expect(String((result as Error).message)).toContain('was not one of the choices offered');
      expect(await calls(page)).toEqual(['open finder']);
    });

    test('products the store doesn’t have: the person chooses (remove, replace, another method, stop)', async ({ page }) => {
      await standIn(page, { unavailable: { FUEL435: [NAMES[43808]] } });
      const [result, asked] = await Promise.all([run(page, 'auto'), answerNext({ action: 'skip' })]);
      expect(asked).toMatchObject({ kind: 'not_eligible', step: PICKUP_STORE_STEP, plus: ['43808'], message: 'Product 43808 is not available at SHELL BUKIT BATOK ROAD.' });
      expect(asked.options.map((option) => option.label)).toEqual(['Remove it and continue', 'Replace with another PLU', 'Try Home Delivery', 'Try Click & Collect', 'Stop automation']);
      expect(result).toEqual({ kind: 'remove', plus: ['43808'] });
    });
  });
});
