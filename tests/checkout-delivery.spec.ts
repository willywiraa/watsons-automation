import { expect, test } from '@playwright/test';
import type { OrderLine } from '../src/config/order';
import { deliveryModeSteps } from '../src/flows/delivery-modes';
import { CheckoutPage } from '../src/pages/CheckoutPage';
import { StepError } from '../src/utils/errors';

// Offline checks of the delivery step on the checkout summary page: whether the page offers a
// choice of delivery modes, and what the order flow does when it doesn't (user's request
// 2026-10-14: Standard-only products such as 46700, 46465 and 46358 show no options at all).

/** One delivery option as staging draws it (from the trace of the 2026-10-13 13:27 run). */
function option(mode: 'express' | 'standard', { radioHidden = false } = {}): string {
  return `
    <e2-radio name="deliveryMethod" class="option ${mode}">
      <div class="form-radio"><label tabindex="-1">
        <input type="radio" tabindex="-1" name="deliveryMethod" value=""${radioHidden ? ' style="display: none"' : ''}>
        <div class="option-wrapper"><div class="option-detail"><div class="support-product-container">
          <div class="support-title-group"><div class="support-title-content"><div class="support-title">
            <span>${mode === 'express' ? 'Fastest' : 'Estimated Pickup Date: 17/10 (Sat)'}</span>
          </div></div></div>
          <div class="support-detail"><div class="description">Pickup at Watsons Store</div><button class="amount">View 2 item(s)</button></div>
        </div></div></div>
      </label></div>
    </e2-radio>`;
}
const summaryPage = (options: string) =>
  `<wtc-checkout-express-select><div class="delivery-method-option-container">${options}</div></wtc-checkout-express-select>` +
  '<button class="next-btn"> Checkout </button>';
/** Draws another option on the page after `ms` milliseconds, as staging sometimes does. */
const drawLater = (page: import('@playwright/test').Page, html: string, ms: number) =>
  page.evaluate(([late, wait]) => {
    setTimeout(() => document.querySelector('.delivery-method-option-container')!.insertAdjacentHTML('beforeend', late), wait);
  }, [html, ms] as const);

const LINES: OrderLine[] = [
  { plu: '46700', quantity: 1 },
  { plu: '46465', quantity: 1 },
  { plu: '46358', quantity: 1 },
];
const NAMES = { 46700: 'Product A', 46465: 'Product B', 46358: 'Product C' };

/** A checkout page that only notes what the flow does with it. */
function fakeCheckout(offered: ('express' | 'standard')[], calls: string[], { choiceLater = false } = {}): CheckoutPage {
  return {
    offeredModes: async () => offered,
    showsChoice: async () => choiceLater,
    unavailableFor: async (mode: string) => {
      calls.push(`look up ${mode}`);
      return ['46358'];
    },
    select: async (mode: string) => {
      calls.push(`select ${mode}`);
    },
    chooseDeliveryDateIfAsked: async (mode: string) => {
      calls.push(`${mode} date if asked`);
      return null;
    },
    expectReadyToCheckOut: async () => {
      calls.push('Checkout ready');
    },
  } as unknown as CheckoutPage;
}

test.describe('delivery choice on the checkout page', () => {
  test('both options shown: Express and Standard can be chosen, straight away', async ({ page }) => {
    await page.setContent(summaryPage(option('express') + option('standard')));
    const started = Date.now();
    expect(await new CheckoutPage(page).offeredModes('standard')).toEqual(['express', 'standard']);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('no options (one Standard option, its radio hidden): only Standard, after 5 seconds of no change', async ({ page }) => {
    await page.setContent(summaryPage(option('standard', { radioHidden: true })));
    const started = Date.now();
    expect(await new CheckoutPage(page).offeredModes('standard')).toEqual(['standard']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_000);
  });

  test('"Fastest" alone with its radio hidden, the Standard option drawn later (seen 2026-10-14): a choice', async ({ page }) => {
    await page.setContent(summaryPage(option('express', { radioHidden: true })));
    await drawLater(page, option('standard'), 6_000);
    // Not taken for an Express-only page, although it stays alone for 6 seconds.
    expect(await new CheckoutPage(page).offeredModes('express')).toEqual(['express', 'standard']);
  });

  test('a lone option with a radio to click is a choice still being drawn', async ({ page }) => {
    await page.setContent(summaryPage(option('standard')));
    expect(await new CheckoutPage(page).offeredModes('standard')).toEqual(['express', 'standard']);
  });

  test('any other lone option counts only after the patience runs out', async ({ page }) => {
    const checkout = new CheckoutPage(page);
    await page.setContent(summaryPage(option('standard', { radioHidden: true })));
    let started = Date.now();
    expect(await checkout.offeredModes('express', 3_000)).toEqual(['standard']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_000);
    await page.setContent(summaryPage(option('express', { radioHidden: true })));
    started = Date.now();
    expect(await checkout.offeredModes('express', 3_000)).toEqual(['express']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_000);
  });
});

test.describe('delivery step of the order flow', () => {
  test('Standard without options: no searching for options, straight on to Checkout with every product', async () => {
    const calls: string[] = [];
    const result = await deliveryModeSteps('standard').selectOnCheckout(fakeCheckout(['standard'], calls), LINES, NAMES);
    expect(result).toEqual({ kept: LINES, excluded: [] });
    expect(calls).toEqual(['standard date if asked', 'Checkout ready']);
  });

  test('Express with products that only go Standard: a clear error before Checkout, no order', async () => {
    const calls: string[] = [];
    const error = await deliveryModeSteps('express')
      .selectOnCheckout(fakeCheckout(['standard'], calls), LINES, NAMES)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(StepError);
    expect(error).toMatchObject({ code: 'EXPRESS_OPTION_NOT_FOUND', step: 'Express Delivery Selection' });
    expect(String((error as Error).message)).toContain('The checkout page offers only Standard for these products');
    expect(calls).toEqual([]);
  });

  test('both options shown: the mode is looked up and selected as before', async () => {
    const calls: string[] = [];
    const result = await deliveryModeSteps('standard').selectOnCheckout(fakeCheckout(['express', 'standard'], calls), LINES, NAMES);
    expect(result).toEqual({ kept: LINES.slice(0, 2), excluded: [LINES[2]] });
    expect(calls).toEqual(['look up standard', 'select standard', 'standard date if asked']);
  });

  test('Express with options: selected, then its own date checked too', async () => {
    const calls: string[] = [];
    await deliveryModeSteps('express').selectOnCheckout(fakeCheckout(['express', 'standard'], calls), LINES, NAMES);
    expect(calls).toEqual(['look up express', 'select express', 'express date if asked']);
  });

  test('options that appear after all: the mode is then selected as usual', async () => {
    const calls: string[] = [];
    const result = await deliveryModeSteps('standard').selectOnCheckout(fakeCheckout(['standard'], calls, { choiceLater: true }), LINES, NAMES);
    expect(result).toEqual({ kept: LINES.slice(0, 2), excluded: [LINES[2]] });
    expect(calls).toEqual(['standard date if asked', 'Checkout ready', 'look up standard', 'select standard', 'standard date if asked']);
  });
});

// The delivery date (user's request 2026-10-16: for any mode, the latest available date). A stand-in
// for the checkout page and its date dialog, from the user's inspect of 2026-10-16.
function datedOption(mode: 'express' | 'standard', asksForDate: boolean): string {
  const title = asksForDate ? 'Please Select a delivery date' : 'Estimated Delivery Date: 17/10 (Sat)';
  const button = asksForDate
    ? '<button type="button" class="btn btn-outline-primary enhance pick-date"><img alt="icon" src="data:,"> Select delivery date </button>'
    : '';
  return `
    <e2-radio name="deliveryMethod" class="option ${mode}"${asksForDate ? ' data-asks' : ''}><div class="form-radio"><label>
      <input type="radio" name="deliveryMethod" value="">
      ${mode === 'express' ? '<span>Fastest</span>' : ''}
      <div class="support-title"><span>${title}</span></div>
      ${button}
    </label></div></e2-radio>`;
}
function datePage(options: string, days = ['Tue 20/10', 'Fri 23/10', 'Sat 24/10']): string {
  // The day name and the date are separate pieces of text, as on staging (2026-10-16).
  const rows = days.map((day) => `<div class="timeslot"><div class="date"><span>${day.split(' ')[0]}</span><br><span>${day.split(' ')[1]}</span></div><button type="button" class="btn btn-primary-outline">Available</button></div>`);
  return `${options}
    <div role="dialog" id="dates" hidden>
      <p>Please select your preferred delivery date. Kindly note that there will be no delivery on Sundays and Public Holidays.</p>
      ${rows.join('')}
      <div class="timeslot"><div class="date">Sun 25/10</div><span>Not Available</span></div>
      <button type="button" class="icon-close">×</button>
      <button type="button" class="btn btn-primary" id="confirm" disabled>Confirm</button>
    </div>
    <button class="next-btn"> Checkout </button>
    <script>
      let picked = null;
      for (const open of document.querySelectorAll('.pick-date')) open.onclick = (event) => { event.preventDefault(); window.opened = true; document.getElementById('dates').hidden = false; };
      for (const slot of document.querySelectorAll('#dates .btn-primary-outline')) {
        slot.onclick = () => { picked = [...slot.closest('.timeslot').querySelectorAll('.date span')].map((part) => part.textContent).join(' '); document.getElementById('confirm').disabled = false; };
      }
      document.querySelector('#dates .icon-close').onclick = () => { document.getElementById('dates').hidden = true; };
      document.getElementById('confirm').onclick = () => {
        document.getElementById('dates').hidden = true;
        const option = document.querySelector('[data-asks]');
        option.querySelector('.support-title').textContent = 'Estimated Delivery Date: ' + picked;
        option.querySelector('.pick-date').outerHTML = '<button type="button">Change Dateslot</button>';
        window.picked = picked;
      };
    </script>`;
}

test.describe('delivery date on the checkout page', () => {
  test('the chosen option asks for a date: the latest available one is picked and confirmed', async ({ page }) => {
    await page.setContent(datePage(datedOption('express', false) + datedOption('standard', true)));
    expect(await new CheckoutPage(page).chooseDeliveryDateIfAsked('standard')).toBe('Sat 24/10');
    expect(await page.evaluate(() => (window as unknown as { picked?: string }).picked)).toBe('Sat 24/10');
  });

  test('also when the page shows no options (one Standard option, its radio hidden)', async ({ page }) => {
    await page.setContent(datePage(datedOption('standard', true).replace('value="">', 'value="" style="display: none">')));
    expect(await new CheckoutPage(page).chooseDeliveryDateIfAsked('standard')).toBe('Sat 24/10');
  });

  test('also for Express, when its own option asks for a date', async ({ page }) => {
    await page.setContent(datePage(datedOption('express', true) + datedOption('standard', false)));
    expect(await new CheckoutPage(page).chooseDeliveryDateIfAsked('express')).toBe('Sat 24/10');
  });

  test('Express chosen: the Standard option still asking for a date is left alone', async ({ page }) => {
    await page.setContent(datePage(datedOption('express', false) + datedOption('standard', true)));
    expect(await new CheckoutPage(page).chooseDeliveryDateIfAsked('express')).toBeNull();
    expect(await page.evaluate(() => (window as unknown as { opened?: boolean }).opened)).toBeUndefined();
  });

  test('no date available: a clear error, and the list is closed again', async ({ page }) => {
    await page.setContent(datePage(datedOption('standard', true), []));
    const error = await new CheckoutPage(page).chooseDeliveryDateIfAsked('standard').catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'DELIVERY_DATE_NOT_AVAILABLE', step: 'Standard Delivery Selection' });
    await expect(page.locator('#dates')).toBeHidden();
  });
});
