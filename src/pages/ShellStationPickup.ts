import { expect, type Locator, type Page } from '@playwright/test';
import { StepError } from '../utils/errors';
import { log } from '../utils/log';
import { closeChatPanelIfShown, closeCookieNoticeIfShown, throwIfServerErrorShown } from './popups';

// Shell Station's pickup store on the checkout summary page (user's request 2026-10-30). Shell
// Station has no Express or Standard to choose: its one delivery option (an "onlyExpress"
// <e2-radio name="deliveryMethod">, hidden, already chosen) shows once a pickup store is chosen.
//
// Seen on staging 2026-10-30 (and the user's inspect of that day):
// - The "Pickup at Shell Station" card (<wtc-checkout-pickup-place-info>) shows "Add Shell Station
//   Pick up location" while no store is chosen; else the store's name, address and recipient, with
//   <button class="add"> "Change pickup store". The account's last store ("Recent Pickup Store") is
//   chosen to begin with.
// - Either opens the store finder (<ngb-modal-window class="cnc-select-store-modal">, "Pickup at
//   Shell Station"): the recipient (first and last name, mobile number: filled in from the account),
//   a street search, Region and City filters (set to the chosen store's), "N Store(s)", the stores
//   as numbered radios (<input type="radio" name="StoreFinderComponent-store-FUEL435"
//   value="FUEL435">, name, address, "All Available" when it has every product), 10 to a page, and
//   <button class="primary"> Select this store </button>.
// - With the Region filter at "Select Region", all 12 Shell stations show, by name, the recent one
//   first. Choosing one on page 2 and "Select this store" closed the finder; the card then showed it.

/** A Shell station in the store finder. */
export interface PickupStore {
  /** Staging's code, e.g. "FUEL435": the store's radio's value. */
  code: string;
  /** E.g. "SHELL BUKIT BATOK ROAD". */
  name: string;
  /** E.g. "11 BUKIT BATOK WEST AVENUE 3, SHELL BUKIT BATOK ROAD, 659166". */
  address: string;
  /** Whether it has the products in the bag: "All Available", or what else it says. */
  availability: string;
  /** E.g. "Recent Pickup Store". */
  tags: string[];
  /** Chosen in the finder when it opened. */
  checked: boolean;
}

/** Whether a store has every product in the bag. */
export const hasEverything = (store: PickupStore) => /^all available$/i.test(store.availability);

/** The store "Choose for me" takes when none is chosen yet: the first that has every product, else the first. */
export const defaultStore = (stores: PickupStore[]): PickupStore | undefined => stores.find(hasEverything) ?? stores[0];

const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

export class ShellStationPickup {
  readonly card: Locator;
  readonly addButton: Locator;
  readonly changeButton: Locator;
  /** The card's button that opens the store finder, either one: shown once the card is drawn. */
  readonly storeShown: Locator;
  /** The chosen store's name on the card. */
  readonly storeName: Locator;
  readonly finder: Locator;
  readonly storeItems: Locator;
  readonly selectButton: Locator;
  private readonly region: Locator;
  private readonly pages: Locator;

  constructor(private readonly page: Page) {
    this.card = page.locator('wtc-checkout-pickup-place-info');
    // The user's inspect: <span>Add Shell Station Pick up location</span> (in a button, or not).
    this.addButton = page
      .getByRole('button', { name: /Add Shell Station Pick ?up location/i })
      .or(page.getByText(/^\s*Add Shell Station Pick ?up location\s*$/i))
      .first();
    this.changeButton = page.getByRole('button', { name: /Change pickup store/i });
    this.storeShown = this.changeButton.or(this.addButton).first();
    // Not ".receiver-info .name": that is the recipient's.
    this.storeName = this.card.locator('.value-container.name .value');
    this.finder = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Select this store', exact: true }) });
    this.storeItems = this.finder.locator('wtc-checkout-store-finder-list-item');
    this.selectButton = this.finder.getByRole('button', { name: 'Select this store', exact: true });
    this.region = this.finder.locator('e2-select[name="sf-region"]');
    // Previous page, the page numbers, next page.
    this.pages = this.finder.locator('wtc-pagination li');
  }

  private failed(step: string, reason: string, error?: unknown, causes = ['staging is slow', 'the Shell Station store list changed']): StepError {
    return new StepError('PICKUP_STORE_NOT_SELECTED', step, reason, causes, error);
  }

  /** The store the checkout page shows as chosen; null when there is none yet ("Add Shell Station Pick up location"). */
  async chosenStore(step: string): Promise<string | null> {
    try {
      await expect(this.storeShown).toBeVisible({ timeout: 60_000 });
    } catch (error) {
      await throwIfServerErrorShown(this.page, step, error);
      throw this.failed(step, 'The checkout page shows no Shell Station pickup store, and no "Add Shell Station Pick up location".', error);
    }
    if ((await this.changeButton.count()) === 0) return null;
    return clean(await this.storeName.first().innerText({ timeout: 10_000 }).catch(() => '')) || null;
  }

  /** Opens the store finder from the card and waits for its list. */
  async openFinder(step: string): Promise<void> {
    try {
      await closeCookieNoticeIfShown(this.page);
      await closeChatPanelIfShown(this.page);
      await this.storeShown.click();
      await expect(this.finder).toBeVisible({ timeout: 30_000 });
      await expect(this.finder.getByText(/\d+\s*Store\(s\)/)).toBeVisible({ timeout: 30_000 });
      await this.settle();
    } catch (error) {
      await throwIfServerErrorShown(this.page, step, error);
      throw this.failed(step, 'The Shell Station store list did not open.', error);
    }
  }

  /** "N Store(s)" and the codes listed: the list as it is now. */
  private async listed(): Promise<string> {
    const total = clean(await this.finder.locator('.storeTotal').innerText({ timeout: 5_000 }).catch(() => ''));
    const codes = await this.storeItems.locator('input[type="radio"]').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
    return `${total}|${codes.join(',')}`;
  }

  /** Waits until the list stops changing (it redraws after a filter or another page). */
  private async settle(): Promise<void> {
    let before = await this.listed();
    for (let checks = 0; checks < 30; checks++) {
      await this.page.waitForTimeout(700);
      const now = await this.listed();
      if (now === before && !now.startsWith('|')) return;
      before = now;
    }
  }

  /** The stores on the page of the list shown now. */
  private async storesShown(): Promise<PickupStore[]> {
    return this.storeItems.evaluateAll((items) =>
      items
        .map((item) => {
          const text = (element: Element | null) => (element as HTMLElement | null)?.innerText?.replace(/\s+/g, ' ').trim() ?? '';
          const radio = item.querySelector('input[type="radio"]') as HTMLInputElement | null;
          return {
            code: radio?.value ?? '',
            name: text(item.querySelector('.store-name')),
            address: text(item.querySelector('.store-address')).replace(/\s*,\s*/g, ', '),
            availability: text(item.querySelector('.pickup-info')),
            tags: [...item.querySelectorAll('.tag')].map((tag) => text(tag)).filter(Boolean),
            checked: Boolean(radio?.checked),
          };
        })
        .filter((store) => store.code && store.name),
    );
  }

  private async pageButtonDisabled(item: Locator): Promise<boolean> {
    return /\bdisabled\b/.test((await item.getAttribute('class', { timeout: 5_000 }).catch(() => 'disabled')) ?? '');
  }

  /** To the next (or previous) page of the list; false when there is none. */
  private async turnPage(forward: boolean): Promise<boolean> {
    if ((await this.pages.count()) < 2) return false;
    const button = forward ? this.pages.last() : this.pages.first();
    if (await this.pageButtonDisabled(button)) return false;
    const before = await this.listed();
    await button.locator('a').click();
    await expect.poll(() => this.listed(), { timeout: 15_000 }).not.toBe(before);
    await this.settle();
    return true;
  }

  private async toFirstPage(): Promise<void> {
    for (let turns = 0; turns < 30 && (await this.turnPage(false)); turns++);
  }

  /** Every Shell station: the Region filter back to "Select Region" (it opens on the chosen store's region and city). */
  private async showAllStores(): Promise<void> {
    const toggle = this.region.locator('.dropdown-toggle');
    if ((await toggle.count()) === 0 || /^select region$/i.test(clean(await toggle.innerText()))) return;
    await toggle.click();
    await this.region.locator('.dropdown-item').filter({ hasText: /^\s*Select Region\s*$/i }).click();
    await expect(toggle).toHaveText(/Select Region/i);
    await this.settle();
  }

  /** Every Shell station in the finder, from every page of its list (left on the first page). */
  async allStores(step: string): Promise<PickupStore[]> {
    try {
      await this.showAllStores();
      await this.toFirstPage();
      const stores = new Map<string, PickupStore>();
      for (let pages = 0; pages < 30; pages++) {
        for (const store of await this.storesShown()) if (!stores.has(store.code)) stores.set(store.code, store);
        if (!(await this.turnPage(true))) break;
      }
      await this.toFirstPage();
      if (stores.size === 0) throw this.failed(step, 'The Shell Station store list is empty.', undefined, ['no Shell station on staging takes these products', 'staging is slow']);
      log(`Shell stations on staging: ${stores.size}`);
      return [...stores.values()];
    } catch (error) {
      if (error instanceof StepError) throw error;
      await throwIfServerErrorShown(this.page, step, error);
      throw this.failed(step, 'Could not read the Shell Station store list.', error);
    }
  }

  /**
   * Chooses the store in the finder and confirms it ("Select this store"); waits until the checkout
   * page shows it.
   */
  async select(store: PickupStore, step: string): Promise<void> {
    const radio = this.finder.locator(`input[type="radio"][value="${store.code}"]`);
    try {
      // Its page of the list (the finder may show only the chosen store's region).
      await this.toFirstPage();
      for (let turns = 0; turns < 30 && (await radio.count()) === 0; turns++) if (!(await this.turnPage(true))) break;
      if ((await radio.count()) === 0) {
        await this.showAllStores();
        await this.toFirstPage();
        for (let turns = 0; turns < 30 && (await radio.count()) === 0; turns++) if (!(await this.turnPage(true))) break;
      }
    } catch (error) {
      await throwIfServerErrorShown(this.page, step, error);
      throw this.failed(step, `Could not find ${store.name} in the Shell Station store list.`, error);
    }
    if ((await radio.count()) === 0) throw this.failed(step, `${store.name} (${store.code}) is not in the Shell Station store list.`);
    await this.expectRecipient(step);
    try {
      // The radio itself is hidden: click the store's name (its label). (Within each list item.)
      await this.storeItems.filter({ has: this.page.locator(`input[type="radio"][value="${store.code}"]`) }).locator('.store-name').click();
      await expect(radio).toBeChecked();
      await this.selectButton.click();
      await expect(this.finder).toBeHidden({ timeout: 30_000 });
      await expect(this.storeName.first()).toHaveText(store.name, { timeout: 30_000 });
    } catch (error) {
      await throwIfServerErrorShown(this.page, step, error);
      throw this.failed(step, `${store.name} was chosen in the store list, but the checkout page did not take it.`, error);
    }
    log(`Pickup store selected: ${store.name} (${store.code})`);
  }

  /** The recipient's name and mobile number, which the finder fills in from the account, are there. */
  private async expectRecipient(step: string): Promise<void> {
    const missing: string[] = [];
    for (const [name, label] of [
      ['firstName', 'first name'],
      ['lastName', 'last name'],
      ['mobileNumber', 'mobile number'],
    ]) {
      const box = this.finder.locator(`input[name="${name}"]`);
      if ((await box.count()) > 0 && (await box.first().inputValue()).trim() === '') missing.push(label);
    }
    if (missing.length > 0) {
      throw this.failed(step, `The Shell Station store list asks for the recipient's ${missing.join(', ')}, and the testing account has none.`, undefined, [
        'the testing account has no name or mobile number on staging: add them in My Account, or choose a pickup store once by hand',
      ]);
    }
  }
}
