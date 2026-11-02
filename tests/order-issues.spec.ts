import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrderLine } from '../src/config/order';
import { chooseDelivery } from '../src/flows/delivery-modes';
import { buyQuestion, eligibilityQuestion, errorQuestion, methodEligibilityQuestion, productQuestion, replaceLine } from '../src/flows/order-issues';
import { OrderProducts } from '../src/flows/order-products';
import { BagPage } from '../src/pages/BagPage';
import type { CheckoutPage } from '../src/pages/CheckoutPage';
import type { ProductOffers } from '../src/pages/ProductPage';
import { ProductSearch } from '../src/pages/ProductSearch';
import { ask, pluList, type Answer, type Decision, type Question } from '../src/utils/ask';
import { StepError } from '../src/utils/errors';

// Offline checks of what an order run does when something needs the person's decision before
// Checkout (user's request 2026-10-22): the questions and their choices, the question and answer
// files the launcher reads and writes, the delivery choice on the checkout page, and adding to the
// bag on a small stand-in for the shop (what staging did with the PLUs of the stress test).

const labels = (question: Question) => question.options.map((option) => option.label);

test.describe('the questions and their choices', () => {
  test('a product out of stock: skip only when something else is left to order', () => {
    const question = productQuestion('out_of_stock', '39656', 2);
    expect(question).toMatchObject({ kind: 'out_of_stock', step: 'Product Search', plus: ['39656'], message: 'Product 39656 is out of stock. What would you like to do?' });
    expect(labels(question)).toEqual(['Skip product and continue', 'Replace with another PLU', 'Stop automation']);
    expect(labels(productQuestion('out_of_stock', '39656', 0))).toEqual(['Replace with another PLU', 'Stop automation']);
    expect(productQuestion('not_found', '12345', 1).message).toBe('Product 12345 was not found on staging. What would you like to do?');
  });

  test('a product staging won’t add: asked at Add to bag, with the reason', () => {
    const question = productQuestion('not_available', '57893', 1, 'Staging did not add PLU 57893: "Sorry the item(s) is not available for checkout."');
    expect(question).toMatchObject({ step: 'Add to bag', message: "Product 57893 can't be added to the bag. What would you like to do?", detail: expect.stringContaining('not available for checkout') });
  });

  test('products the delivery can’t take: the other mode when it takes them, other methods, leave out, stop', () => {
    const question = eligibilityQuestion({ plus: ['17971', '21684'], mode: 'express', method: 'home_delivery', otherMode: 'standard', othersLeft: 11, triedMethods: [] });
    expect(question.message).toBe('Products 17971 and 21684 are not eligible for Express delivery with Home Delivery.');
    expect(question.step).toBe('Express Delivery Selection');
    // Remove them (or add others instead) first: the user's request 2026-10-22.
    expect(labels(question)).toEqual(['Remove them and continue', 'Remove them and add other PLUs', 'Use Standard instead', 'Try Click & Collect', 'Try Shell Station', 'Stop automation']);
    expect(question.options.find((option) => option.action === 'replace')?.many).toBe(true);
    // One product, nothing else to order, a method already tried, no other mode: only what is possible.
    const only = eligibilityQuestion({ plus: ['82074'], mode: 'standard', method: 'home_delivery', otherMode: null, othersLeft: 0, triedMethods: ['click_collect'] });
    expect(only.message).toBe('Product 82074 is not eligible for Standard delivery with Home Delivery.');
    expect(labels(only)).toEqual(['Replace with another PLU', 'Try Shell Station', 'Stop automation']);
  });

  test('products the delivery method can’t take (the bag page): another method, leave out, replace, stop; staging’s words as details', () => {
    const said = 'Sorry, your order includes item(s) not available for Click & Collect service. Please review your shopping bag or try another delivery option.';
    const question = methodEligibilityQuestion({ plus: ['24264', '21684'], method: 'click_collect', message: said, othersLeft: 3, triedMethods: [] });
    expect(question).toMatchObject({ kind: 'not_eligible', step: 'Cart validation', plus: ['24264', '21684'], message: 'Products 24264 and 21684 are not eligible for Click & Collect.', detail: said });
    expect(labels(question)).toEqual(['Remove them and continue', 'Remove them and add other PLUs', 'Try Home Delivery', 'Try Shell Station', 'Stop automation']);
    const one = methodEligibilityQuestion({ plus: ['34626'], method: 'shell_station', message: '', othersLeft: 0, triedMethods: ['click_collect'] });
    expect(one.message).toBe('Product 34626 is not eligible for Shell Station.');
    expect(labels(one)).toEqual(['Replace with another PLU', 'Try Home Delivery', 'Stop automation']);
  });

  test('an unexpected error: retry, skip the product concerned, stop; with the reason', () => {
    const error = new StepError('PRODUCT_QUANTITY_MISMATCH', 'Add to bag', 'Adding unit 1 of 1 for PLU 5555 did not increase the bag count (still 1).');
    const question = errorQuestion('Add to bag', error, { skipPlu: '5555' });
    expect(question.message).toBe('Something went wrong at Add to bag (PLU 5555). How would you like to proceed?');
    expect(question.detail).toBe('Adding unit 1 of 1 for PLU 5555 did not increase the bag count (still 1).');
    expect(labels(question)).toEqual(['Retry', 'Skip product 5555', 'Stop automation']);
    expect(labels(errorQuestion('Empty bag', new Error('boom')))).toEqual(['Retry', 'Stop automation']);
  });

  test('a list of PLUs: spaces or commas, each one once; anything else is no list (2026-10-22)', () => {
    expect(pluList('45606, 21679 45606')).toEqual(['45606', '21679']);
    expect(pluList('45606 abc')).toEqual([]);
    expect(pluList('')).toEqual([]);
  });

  test('a product with "Buy 1" / "Buy 2" on its page: how many, with the page’s prices (2026-11-02)', () => {
    const product: ProductOffers = {
      plu: '23475',
      name: 'TIGER BALM Mosquito Repellent Patch Spray 60ml',
      offers: [{ quantity: 1, price: 'S$ 8.50' }, { quantity: 2, price: 'S$ 11.90', saving: 'S$ 5.10' }],
    };
    const question = buyQuestion(product);
    expect(question).toMatchObject({
      kind: 'buy_option',
      step: 'Add to bag',
      plus: ['23475'],
      message: 'Product 23475 has a Buy 2 offer. How many would you like to buy?',
      detail: 'TIGER BALM Mosquito Repellent Patch Spray 60ml. Buy 1: S$ 8.50 · Buy 2: S$ 11.90 (extra savings S$ 5.10).',
    });
    expect(labels(question)).toEqual(['Buy 1 at its normal price', 'Buy 2 for the promotional discount', 'Stop automation']);
    expect(question.options.map((option) => option.quantity)).toEqual([1, 2, undefined]);
    // A page with more offers: one choice each.
    const more = buyQuestion({ ...product, offers: [...product.offers, { quantity: 3, price: 'S$ 15.30', saving: 'S$ 10.20' }] });
    expect(more.message).toBe('Product 23475 has Buy 2 and Buy 3 offers. How many would you like to buy?');
    expect(labels(more)).toEqual(['Buy 1 at its normal price', 'Buy 2 for the promotional discount', 'Buy 3 for the promotional discount', 'Stop automation']);
  });

  test('a replacement takes the old product’s place and quantity, or joins the same PLU', () => {
    const lines: OrderLine[] = [{ plu: '1', quantity: 1 }, { plu: '2', quantity: 3 }, { plu: '3', quantity: 1 }];
    expect(replaceLine(lines, '2', '9')).toEqual([{ plu: '1', quantity: 1 }, { plu: '9', quantity: 3 }, { plu: '3', quantity: 1 }]);
    expect(replaceLine(lines, '2', '3')).toEqual([{ plu: '1', quantity: 1 }, { plu: '3', quantity: 4 }]);
  });
});

// ---- The question and answer files (src/utils/ask.ts; the launcher reads and writes them) ----

const RUN_ID = '2026-10-22_12-00-00';
let reports: string;
let saved: Record<string, string | undefined>;
const folder = () => join(reports, RUN_ID.slice(0, 10), RUN_ID);
function useInteractive() {
  test.beforeEach(() => {
    reports = mkdtempSync(join(tmpdir(), 'ask-test-'));
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

/** Waits for a question not answered yet (ask.json, no answer-<id>.json) and answers it as the launcher does. */
async function answerNext(answer: Answer, timeout = 10_000): Promise<Question & { id: number }> {
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
      { timeout },
    )
    .toBe(true);
  const question = asked as unknown as Question & { id: number };
  writeFileSync(join(folder(), `answer-${question.id}.json`), JSON.stringify(answer));
  return question;
}

test.describe('asking the person', () => {
  test('a command-line run is not asked: it gets what it always did', async () => {
    const saved = process.env.WATSONS_INTERACTIVE;
    delete process.env.WATSONS_INTERACTIVE;
    try {
      const decisions: Decision[] = [];
      expect(await ask(productQuestion('out_of_stock', '39656', 1), { action: 'skip' }, decisions)).toEqual({ action: 'skip' });
      expect(decisions).toEqual([]);
    } finally {
      if (saved !== undefined) process.env.WATSONS_INTERACTIVE = saved;
    }
  });

  test.describe('from the launcher', () => {
    useInteractive();

    test('writes the question, waits for the answer, and keeps the decision', async () => {
      const decisions: Decision[] = [];
      const [answer, asked] = await Promise.all([ask(productQuestion('out_of_stock', '39656', 1), { action: 'stop' }, decisions), answerNext({ action: 'replace', plu: '45606' })]);
      expect(asked).toMatchObject({ kind: 'out_of_stock', step: 'Product Search', plus: ['39656'], options: [{ action: 'skip' }, { action: 'replace' }, { action: 'stop' }] });
      expect(answer).toEqual({ action: 'replace', plu: '45606' });
      expect(decisions).toEqual([expect.objectContaining({ step: 'Product Search', plus: ['39656'], action: 'replace', label: 'Replace with another PLU', plu: '45606' })]);
    });

    test('several PLUs where the choice allows them, one where it doesn’t (2026-10-22)', async () => {
      const decisions: Decision[] = [];
      const question = eligibilityQuestion({ plus: ['17971', '82074'], mode: 'express', method: 'home_delivery', otherMode: null, othersLeft: 1, triedMethods: [] });
      await Promise.all([ask(question, { action: 'stop' }, decisions), answerNext({ action: 'replace', plu: '45606,21679 45606' })]);
      expect(decisions).toMatchObject([{ action: 'replace', label: 'Remove them and add other PLUs', plu: '45606 21679' }]);
      const [single] = await Promise.all([ask(productQuestion('out_of_stock', '39656', 1), { action: 'stop' }, []).catch((error) => error), answerNext({ action: 'replace', plu: '45606 21679' })]);
      expect(single).toBeInstanceOf(StepError);
    });

    test('an answer that was not offered ends the run instead of guessing', async () => {
      const [result] = await Promise.all([ask(productQuestion('out_of_stock', '39656', 0), { action: 'stop' }, []).catch((error) => error), answerNext({ action: 'skip' })]);
      expect(result).toBeInstanceOf(StepError);
      expect(result.message).toContain('was not one of the choices offered');
      // How many: only a quantity offered (2026-11-02).
      const product: ProductOffers = { plu: '23475', name: 'Spray', offers: [{ quantity: 1, price: 'S$ 8.50' }, { quantity: 2, price: 'S$ 11.90' }] };
      const [three] = await Promise.all([ask(buyQuestion(product), { action: 'stop' }, []).catch((error) => error), answerNext({ action: 'buy', quantity: 3 })]);
      expect(three).toBeInstanceOf(StepError);
      const decisions: Decision[] = [];
      const [two] = await Promise.all([ask(buyQuestion(product), { action: 'stop' }, decisions), answerNext({ action: 'buy', quantity: 2 })]);
      expect(two).toEqual({ action: 'buy', quantity: 2 });
      expect(decisions).toMatchObject([{ kind: 'buy_option', step: 'Add to bag', plus: ['23475'], action: 'buy', label: 'Buy 2 for the promotional discount' }]);
    });
  });
});

// ---- The delivery choice on the checkout page (src/flows/delivery-modes.ts chooseDelivery) ----

const LINES: OrderLine[] = [{ plu: '45274', quantity: 1 }, { plu: '17971', quantity: 1 }, { plu: '21684', quantity: 1 }];
const NAMES = { 45274: 'Oral Pick', 17971: 'Coenzyme Q10', 21684: 'Vitamin E' };

/** A checkout page that offers `offered` and can't deliver `notFor[mode]`; it notes what is done with it. */
function fakeCheckout(offered: ('express' | 'standard')[], notFor: Record<'express' | 'standard', string[]>, calls: string[]): CheckoutPage {
  return {
    offeredModes: async () => offered,
    showsChoice: async () => offered.length === 2,
    unavailableFor: async (mode: 'express' | 'standard') => {
      calls.push(`look up ${mode}`);
      return notFor[mode];
    },
    select: async (mode: string) => {
      calls.push(`select ${mode}`);
    },
    chooseDeliveryDateIfAsked: async () => null,
    expectReadyToCheckOut: async () => {
      calls.push('Checkout ready');
    },
  } as unknown as CheckoutPage;
}
const choose = (checkout: CheckoutPage, decisions: Decision[] = []) =>
  chooseDelivery({ checkout, mode: 'express', method: 'home_delivery', lines: LINES, namesByPlu: NAMES, decisions, triedMethods: [] });

test.describe('delivery choice when products can’t go that way', () => {
  test('a command-line run leaves them out, as before', async () => {
    const calls: string[] = [];
    const next = await choose(fakeCheckout(['express', 'standard'], { express: ['17971'], standard: [] }, calls));
    expect(next).toMatchObject({ kind: 'ready', excluded: [{ plu: '17971' }] });
    expect(calls).toEqual(['look up express', 'select express']);
  });

  test.describe('from the launcher', () => {
    useInteractive();

    test('asks first; "Use Standard instead" selects nothing yet', async () => {
      const calls: string[] = [];
      const decisions: Decision[] = [];
      const [next, asked] = await Promise.all([
        choose(fakeCheckout(['express', 'standard'], { express: ['17971', '21684'], standard: [] }, calls), decisions),
        answerNext({ action: 'switch_mode', mode: 'standard' }),
      ]);
      expect(asked.message).toBe('Products 17971 and 21684 are not eligible for Express delivery with Home Delivery.');
      expect(labels(asked)).toEqual(['Remove them and continue', 'Remove them and add other PLUs', 'Use Standard instead', 'Try Click & Collect', 'Try Shell Station', 'Stop automation']);
      expect(next).toEqual({ kind: 'mode', mode: 'standard' });
      expect(calls).toEqual(['look up express', 'look up standard']);
      expect(decisions).toMatchObject([{ action: 'switch_mode', plus: ['17971', '21684'] }]);
    });

    test('"Remove it and continue": back to the bag to take it out; nothing is selected here (2026-10-22)', async () => {
      const calls: string[] = [];
      const [next] = await Promise.all([choose(fakeCheckout(['express', 'standard'], { express: ['17971'], standard: ['17971'] }, calls)), answerNext({ action: 'skip' })]);
      expect(next).toEqual({ kind: 'remove', plus: ['17971'] });
      expect(calls).toEqual(['look up express', 'look up standard']);
    });

    test('another method, or another PLU: back to the bag', async () => {
      const notFor = { express: ['17971'], standard: ['17971'] };
      const [method, asked] = await Promise.all([choose(fakeCheckout(['express', 'standard'], notFor, [])), answerNext({ action: 'switch_method', method: 'click_collect' })]);
      // Standard can't take it either: not offered.
      expect(labels(asked)).toEqual(['Remove it and continue', 'Replace with another PLU', 'Try Click & Collect', 'Try Shell Station', 'Stop automation']);
      expect(method).toEqual({ kind: 'method', method: 'click_collect' });
      // One PLU or several instead.
      const [replace] = await Promise.all([choose(fakeCheckout(['express', 'standard'], notFor, [])), answerNext({ action: 'replace', plu: '45606, 21679' })]);
      expect(replace).toEqual({ kind: 'replace', plus: ['17971'], replacements: ['45606', '21679'] });
    });

    test('the page offers only Standard: none can go Express, so nothing to leave out', async () => {
      const [next, asked] = await Promise.all([choose(fakeCheckout(['standard'], { express: [], standard: [] }, [])), answerNext({ action: 'switch_mode', mode: 'standard' })]);
      expect(asked.plus).toEqual(['45274', '17971', '21684']);
      expect(labels(asked)).toEqual(['Remove them and add other PLUs', 'Use Standard instead', 'Try Click & Collect', 'Try Shell Station', 'Stop automation']);
      expect(next).toEqual({ kind: 'mode', mode: 'standard' });
    });

    test('everything can go Express: nothing is asked', async () => {
      const calls: string[] = [];
      const next = await choose(fakeCheckout(['express', 'standard'], { express: [], standard: [] }, calls));
      expect(next).toMatchObject({ kind: 'ready', excluded: [] });
      // The list is read once (2026-10-22), then the mode selected.
      expect(calls).toEqual(['look up express', 'select express']);
    });
  });
});

// ---- Adding to the bag on a stand-in for the shop: what staging did on 2026-10-22 ----

// Search results with one tile per PLU. PLU 57893: staging's "not available for checkout"
// pop-up (the page behind it hidden from accessibility tools, as on staging). PLU 21707: "add to
// bag" opens the product's page. PLU 23475: "add to bag" opens its page, which offers "Buy 1" /
// "Buy 2" as staging's did on 2026-11-02 (a choice sets QUANTITY; BUY NOW adds that many). Others:
// added (the header's count goes up).
const SHOP = `<!doctype html><title>Shop</title>
<header id="header"><input type="search" aria-label="Search here..." id="q"><button id="bag" type="button"></button></header>
<main id="main"></main>
<script>
  const count = () => Number(sessionStorage.getItem('count') || 0);
  const bag = document.getElementById('bag');
  bag.textContent = count() + ' MY Bag';
  document.getElementById('q').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') location.href = '/search?text=' + encodeURIComponent(event.target.value);
  });
  const post = () => fetch('/occ/v2/carts/1/entries', { method: 'POST' });
  const text = new URLSearchParams(location.search).get('text');
  if (location.pathname === '/search') {
    document.getElementById('main').innerHTML = '<h1>Search Results for "' + text + '"</h1>' +
      text.split(' ').map((plu) => '<e2-product-tile><a href="/p/BP_' + plu + '">Product ' + plu + '</a><button type="button" data-plu="' + plu + '">add to bag</button></e2-product-tile>').join('');
    for (const button of document.querySelectorAll('[data-plu]')) {
      button.addEventListener('click', async () => {
        const plu = button.dataset.plu;
        if (plu === '21707') return void (location.href = '/p/BP_21707');
        if (plu === '23475') return void (location.href = '/tiger-balm-mosquito-repellent-patch-spray-60ml/p/BP_23475');
        await post();
        if (plu === '57893') {
          document.getElementById('main').setAttribute('aria-hidden', 'true');
          document.getElementById('header').setAttribute('aria-hidden', 'true');
          document.body.insertAdjacentHTML('beforeend', '<div role="dialog" id="na"><span>Sorry the item(s) is not available for checkout. Sorry for the inconvenience.</span><button type="button" aria-label="positiveButton">Confirm</button></div>');
          document.querySelector('#na button').addEventListener('click', () => {
            document.getElementById('na').remove();
            document.getElementById('main').removeAttribute('aria-hidden');
            document.getElementById('header').removeAttribute('aria-hidden');
          });
          return;
        }
        setTimeout(() => {
          sessionStorage.setItem('count', String(count() + 1));
          bag.textContent = count() + ' MY Bag';
        }, 200);
      });
    }
  } else if (location.pathname.endsWith('/p/BP_23475')) {
    document.title = 'TIGER BALM Mosquito Repellent Patch Spray 60ml | Baby & Kids Care | Watsons Singapore';
    const offer = (n, price, saving) =>
      '<div class="swiper-slide"><div class="volume-offer-option' + (n === 1 ? ' checked' : ' save') + '"><label><input type="radio" name="volume-offer-price" style="position:absolute;opacity:0">' +
      '<div class="option"><div class="option-wrapper"><div class="quantity"><span>Buy ' + n + '</span></div><div class="price"><span>S$</span> ' + price + ' </div>' +
      (saving ? '<div class="reward"><span>Extra Savings</span>S$ ' + saving + ' </div>' : '') + '</div></div></label></div></div>';
    document.getElementById('main').innerHTML = '<h1>Mosquito Repellent Patch Spray 60ml</h1>' +
      '<wtc-product-volume-offer><div class="swiper-wrapper">' + offer(1, '8.50') + offer(2, '11.90', '5.10') + '</div></wtc-product-volume-offer>' +
      '<wtc-add-to-cart><form aria-label="item-counter"><span>QUANTITY</span><e2-item-counter><button type="button" aria-label="minus">-</button>' +
      '<input type="number" aria-label="input-val" min="1" max="66" value="1"><button type="button" aria-label="plus">+</button></e2-item-counter></form>' +
      '<button type="button" class="btn btn-add-to-cart"><span> BUY NOW </span></button></wtc-add-to-cart>';
    const box = document.querySelector('input[aria-label="input-val"]');
    for (const option of document.querySelectorAll('.volume-offer-option')) {
      option.querySelector('input').addEventListener('change', () => {
        for (const other of document.querySelectorAll('.volume-offer-option')) other.classList.toggle('checked', other === option);
        box.value = option.querySelector('.quantity').textContent.match(/\\d+/)[0];
      });
    }
    document.querySelector('.btn-add-to-cart').addEventListener('click', async () => {
      const qty = Number(box.value);
      await fetch('/occ/v2/carts/1/entries?code=23475&qty=' + qty, { method: 'POST' });
      setTimeout(() => {
        sessionStorage.setItem('count', String(count() + qty));
        bag.textContent = count() + ' MY Bag';
      }, 200);
    });
  } else if (location.pathname.includes('/p/')) {
    document.getElementById('main').innerHTML = '<h2>Product page</h2>';
  }
</script>`;

test.describe('adding to the bag', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://shop.example.test/**', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
        : route.fulfill({ status: 200, contentType: 'text/html', body: SHOP }),
    );
    await page.goto('https://shop.example.test/');
  });

  test('a product staging refuses: PRODUCT_NOT_AVAILABLE, its pop-up closed, and the next add works', async ({ page }) => {
    const search = new ProductSearch(page);
    await search.searchAll(['57893', '45606']);
    const error = await search.add({ plu: '57893', quantity: 1 }).catch((caught) => caught);
    expect(error).toBeInstanceOf(StepError);
    expect(error.code).toBe('PRODUCT_NOT_AVAILABLE');
    expect(error.message).toContain('Sorry the item(s) is not available for checkout.');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    let added = 0;
    await search.add({ plu: '45606', quantity: 1 }, () => added++);
    expect(added).toBe(1);
    await expect(page.getByRole('button', { name: /MY Bag$/ })).toHaveText('1 MY Bag');
  });

  test('an "add to bag" that opens the product’s page: searched again and clicked again; every time → PRODUCT_NOT_AVAILABLE', async ({ page }) => {
    // Each time its page is also given 15 s to show "Buy N" choices (2026-11-02).
    test.setTimeout(180_000);
    const search = new ProductSearch(page);
    await search.searchAll(['21707']);
    const error = await search.add({ plu: '21707', quantity: 1 }).catch((caught) => caught);
    expect(error).toBeInstanceOf(StepError);
    expect(error.code).toBe('PRODUCT_NOT_AVAILABLE');
    expect(error.message).toContain('opens the product\'s page instead (3 tries)');
    await expect(page.getByRole('button', { name: /MY Bag$/ })).toHaveText('0 MY Bag');
  });

  /** The amounts the shop was asked to add ("?code=…&qty=…"), from now on. */
  const addRequests = (page: Page) => {
    const asked: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') asked.push(new URL(request.url()).search);
    });
    return asked;
  };

  test('"Buy 1" / "Buy 2" on the product’s page: add() returns them and adds nothing; then 2 are bought there (2026-11-02)', async ({ page }) => {
    test.setTimeout(120_000);
    const search = new ProductSearch(page);
    await search.searchAll(['23475', '45606']);
    expect(await search.add({ plu: '23475', quantity: 1 })).toEqual({
      plu: '23475',
      name: 'TIGER BALM Mosquito Repellent Patch Spray 60ml',
      offers: [{ quantity: 1, price: 'S$ 8.50' }, { quantity: 2, price: 'S$ 11.90', saving: 'S$ 5.10' }],
    });
    await expect(page.getByRole('button', { name: /MY Bag$/ })).toHaveText('0 MY Bag');
    const asked = addRequests(page);
    let added = 0;
    await search.buyOnProductPage('23475', 2, () => added++);
    expect(added).toBe(2);
    expect(asked).toEqual(['?code=23475&qty=2']);
    await expect(page.locator('.volume-offer-option.checked')).toContainText('Buy 2');
    await expect(page.getByRole('button', { name: /MY Bag$/ })).toHaveText('2 MY Bag');
  });

  test('"Buy 1" / "Buy 2": a command-line run buys as ordered, without asking (2026-11-02)', async ({ page }) => {
    test.setTimeout(120_000);
    const asked = addRequests(page);
    const decisions: Decision[] = [];
    const products = new OrderProducts(page, new ProductSearch(page), new BagPage(page), decisions, [{ plu: '23475', quantity: 1 }, { plu: '45606', quantity: 1 }]);
    await products.addAll();
    expect(products.lines).toEqual([{ plu: '23475', quantity: 1 }, { plu: '45606', quantity: 1 }]);
    expect(asked).toEqual(['?code=23475&qty=1', '']);
    expect(decisions).toEqual([]);
    await expect(page.getByRole('button', { name: /MY Bag$/ })).toHaveText('2 MY Bag');
  });

  test.describe('from the launcher', () => {
    useInteractive();

    test('"Buy 1" / "Buy 2": asked once with the page’s prices; "Buy 2" puts 2 in the bag and in the order (2026-11-02)', async ({ page }) => {
      test.setTimeout(120_000);
      const asked = addRequests(page);
      const decisions: Decision[] = [];
      const products = new OrderProducts(page, new ProductSearch(page), new BagPage(page), decisions, [{ plu: '23475', quantity: 1 }, { plu: '45606', quantity: 1 }]);
      // Asked once its page is open: after the search results' "add to bag" waited 10 s for an add.
      const [, question] = await Promise.all([products.addAll(), answerNext({ action: 'buy', quantity: 2 }, 60_000)]);
      expect(question).toMatchObject({
        kind: 'buy_option',
        step: 'Add to bag',
        message: 'Product 23475 has a Buy 2 offer. How many would you like to buy?',
        detail: 'TIGER BALM Mosquito Repellent Patch Spray 60ml. Buy 1: S$ 8.50 · Buy 2: S$ 11.90 (extra savings S$ 5.10).',
      });
      expect(labels(question)).toEqual(['Buy 1 at its normal price', 'Buy 2 for the promotional discount', 'Stop automation']);
      expect(products.lines).toEqual([{ plu: '23475', quantity: 2 }, { plu: '45606', quantity: 1 }]);
      expect(asked).toEqual(['?code=23475&qty=2', '']);
      expect(decisions).toMatchObject([{ kind: 'buy_option', plus: ['23475'], action: 'buy', label: 'Buy 2 for the promotional discount', outcome: 'PLU 23475 x2 in the bag' }]);
      await expect(page.getByRole('button', { name: /MY Bag$/ })).toHaveText('3 MY Bag');
    });

    test('"Buy 1" / "Buy 2" with 2 of it in the order: nothing to ask, 2 are bought (2026-11-02)', async ({ page }) => {
      test.setTimeout(120_000);
      const asked = addRequests(page);
      const decisions: Decision[] = [];
      const products = new OrderProducts(page, new ProductSearch(page), new BagPage(page), decisions, [{ plu: '23475', quantity: 2 }]);
      await products.addAll();
      expect(existsSync(join(folder(), 'ask.json'))).toBe(false);
      expect(asked).toEqual(['?code=23475&qty=2']);
      expect(decisions).toEqual([]);
      await expect(page.getByRole('button', { name: /MY Bag$/ })).toHaveText('2 MY Bag');
    });
  });
});

test('the bag: a free "Buy 1 Get 1 Free" line is not part of what was ordered (seen 2026-10-22, PLU 17971)', async ({ page }) => {
  await page.setContent(`
    <wtc-cart-item><div class="item"><a class="name" href="/q10/p/BP_17971">Coenzyme Q10</a><input aria-label="input-val" value="1"><button class="delete-btn">x</button></div></wtc-cart-item>
    <wtc-cart-item><div class="item"><a class="name" href="/vit-e/p/BP_21684">Vitamin E</a><input aria-label="input-val" value="2"><button class="delete-btn">x</button></div></wtc-cart-item>
    <wtc-cart-item><div class="item"><a class="name" href="/q10/p/BP_17971">Coenzyme Q10</a><div class="free"><span>FREE</span></div><div class="counter disabled"><span>1</span></div><button class="delete-btn">x</button></div></wtc-cart-item>`);
  const bag = new BagPage(page);
  expect(await bag.contents()).toEqual([{ plu: '17971', quantity: 1 }, { plu: '21684', quantity: 2 }]);
  expect(await bag.freeItems()).toEqual([{ plu: '17971', quantity: 1 }]);
  await expect(bag.itemFor('17971')).toHaveCount(1);
  await bag.expectContents([{ plu: '21684', quantity: 2 }, { plu: '17971', quantity: 1 }]);
});

test('the bag: the products the delivery method can’t take, as staging marks them (seen 2026-10-22 with Click & Collect)', async ({ page }) => {
  const item = (plu: string) =>
    `<wtc-cart-item><div class="item"><a class="name" href="/x/p/BP_${plu}">Product ${plu}</a><input aria-label="input-val" value="1"><button class="delete-btn">x</button></div></wtc-cart-item>`;
  // From the page on 2026-10-22: the box above the other products, and "Next" greyed out.
  await page.setContent(`
    <wtc-cart-error-entries><div class="error-cart-container active"><div class="err-box">
      <div class="title-group"><div class="title"><i class="icon-information"></i><span>Sorry, your order includes item(s) not available for Click &amp; Collect service. Please review your shopping bag or try another delivery option.</span></div></div>
      <div class="error-cart-item-container"><div class="error-cart-item-wrapper">${item('24264')}${item('21684')}</div>
      <div class="control-button-group"><button class="save-btn">Buy Next Time</button></div></div>
    </div></div></wtc-cart-error-entries>
    ${item('45274')}
    <button class="next-btn disabled" style="pointer-events: none"><i></i> Next</button>`);
  const bag = new BagPage(page);
  expect(await bag.methodProblem()).toEqual({
    message: 'Sorry, your order includes item(s) not available for Click & Collect service. Please review your shopping bag or try another delivery option.',
    plus: ['24264', '21684'],
  });
  // Home Delivery: no such box, and "Next" can be clicked.
  await page.setContent(`${item('45274')}${item('24264')}<button class="next-btn"><i></i> Next</button>`);
  expect(await bag.methodProblem()).toBeNull();
});

test('the bag: a free-gift area showing "0/0 selected" has nothing to remove (seen 2026-10-22 with Click & Collect)', async ({ page }) => {
  // As staging drew it: the only gift is "Fully redeemed", so none is in the bag.
  await page.setContent(`
    <div class="free-gift-widget-wrapper"><div class="title-group"><div class="title"><span> 0 Free Gift(s) to select </span></div></div>
      <button class="free-gift-counter-container"><div class="free-gift-counter"> 0/0 selected </div><i class="icon-arrow-down"></i></button>
      <div class="free-gift-container" style="height: 0px;"><div class="free-gift-wrapper"><wtc-free-gift-item><button class="free-gift oos" tabindex="-1">
        <div class="gift-info"><p class="name">HOME DELIVERY CHARGES</p><p class="quantity">1</p><p class="oos"> Fully redeemed </p></div>
      </button></wtc-free-gift-item></div></div>
    </div>`);
  expect(await new BagPage(page).removeFreeGiftIfPresent()).toBeNull();
});
