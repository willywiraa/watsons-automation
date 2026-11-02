import type { Page } from '@playwright/test';
import type { OrderLine } from '../config/order';
import type { BagPage } from '../pages/BagPage';
import type { ProductOffers } from '../pages/ProductPage';
import type { Availability, ProductSearch } from '../pages/ProductSearch';
import { ask, decided, interactive, type Decision } from '../utils/ask';
import { StepError } from '../utils/errors';
import { log } from '../utils/log';
import { buyQuestion, errorQuestion, hasCode, productQuestion, reasonOf, replaceLine, retryOrAsk, stopped } from './order-issues';

// The products of an order run, as the person's decisions change them (user's request
// 2026-10-22). A product out of stock, not found, or refused by staging is skipped or replaced;
// a failed add is retried without adding anything twice (the bag is read first). A command-line
// run decides as before: sold-out products are skipped, PLUs not found end the run, and any
// other problem ends it. A product with "Buy 1" / "Buy 2" choices on its page (2026-11-02): the
// person chooses how many (a command-line run buys as ordered), and they are added there.

export const showLines = (lines: OrderLine[]) => lines.map((line) => (line.quantity > 1 ? `${line.plu} x${line.quantity}` : line.plu)).join(', ') || 'none';

export class OrderProducts {
  /** The products in the order now. */
  lines: OrderLine[];
  /** Sold-out PLUs met on the way (reported). */
  readonly soldOut: string[] = [];
  /** Every PLU that was in the order at some point: the ones the bag may hold. */
  private readonly everWanted = new Set<string>();
  /** Units of each PLU in the bag: counted while adding, read from the bag before a retry. */
  private readonly inBag = new Map<string, number>();
  /** The PLUs on the search results page now. */
  private shown: string[] = [];
  /** Products whose page offered "Buy 1" / "Buy 2", once how many was settled: the person's decision, if asked. */
  private readonly howMany = new Map<string, Decision | undefined>();

  constructor(
    private readonly page: Page,
    private readonly search: ProductSearch,
    private readonly bag: BagPage,
    private readonly decisions: Decision[],
    products: OrderLine[],
  ) {
    this.lines = products.map((line) => ({ ...line }));
    for (const line of this.lines) this.everWanted.add(line.plu);
  }

  /** Searches these PLUs at once (staging takes them separated by spaces): their tiles are then on the page. */
  private async showResults(plus: string[]): Promise<void> {
    await retryOrAsk('Product Search', this.decisions, () => this.search.searchAll(plus));
    this.shown = plus;
  }

  /** Product Search (PRD §12): every product is checked before anything is added. */
  async check(): Promise<void> {
    await this.showResults(this.lines.map((line) => line.plu));
    const notFound: OrderLine[] = [];
    const checked: OrderLine[] = [];
    const queue = [...this.lines];
    while (queue.length > 0) {
      const line = queue.shift()!;
      const ready = await this.resolve(line, checked.length + queue.length, queue, notFound);
      if (!ready) continue;
      // A replacement already in the order: one line, quantities added up.
      const same = checked.find((other) => other.plu === ready.plu) ?? queue.find((other) => other.plu === ready.plu);
      if (same) same.quantity += ready.quantity;
      else checked.push(ready);
    }
    // A command-line run, as before: every PLU not found is named at once, and nothing is added.
    if (notFound.length > 0) {
      throw new StepError('PRODUCT_NOT_FOUND', 'Product Search', `No product found for PLU ${showLines(notFound)}. Nothing was added.`, [
        'a typo in the order',
        'the product does not exist on staging',
      ]);
    }
    if (this.soldOut.length > 0 && !interactive()) log(`Skipping sold-out PLU(s): ${this.soldOut.join(', ')}`, 'WARN');
    if (checked.length === 0) throw new StepError('PRODUCT_NOT_FOUND', 'Product Search', 'Every product in the order is sold out.');
    this.lines = checked;
    if (interactive()) log(`Products to add: ${showLines(this.lines)}`);
  }

  /**
   * One product on the search results page. Available: the line to order. Sold out or not found:
   * the person chooses: skip (null), or replace (then the replacement, once it is available too).
   * `othersLeft`: the other products still in the order (skip only when there are some); `then`:
   * the ones still to check, searched along with a replacement. A command-line run: sold out →
   * skipped; not found → noted in `notFound`. `first`: a replacement to check instead of `line`.
   */
  private async resolve(line: OrderLine, othersLeft: number, then: OrderLine[], notFound: OrderLine[], first: OrderLine = line): Promise<OrderLine | null> {
    let current = first;
    for (;;) {
      if (!this.shown.includes(current.plu)) await this.showResults([current.plu, ...then.map((other) => other.plu)]);
      let availability: Availability;
      try {
        availability = await this.search.availabilityOf(current.plu);
      } catch (error) {
        // E.g. the PLU matches more than one product.
        const answer = await ask(errorQuestion('Product Search', error, { skipPlu: othersLeft > 0 ? current.plu : undefined }), { action: 'stop' }, this.decisions);
        if (answer.action === 'skip') return this.leftOut(current);
        if (answer.action !== 'retry') stopped('Product Search', answer, error);
        this.shown = [];
        continue;
      }
      if (availability === 'available') {
        if (current !== line) decided(this.decisions, `PLU ${current.plu} is available: it replaces PLU ${line.plu}`);
        return current;
      }
      if (availability === 'sold_out' && !this.soldOut.includes(current.plu)) this.soldOut.push(current.plu);
      if (!interactive()) {
        if (availability === 'not_found') notFound.push(current);
        return null;
      }
      if (current !== line) decided(this.decisions, `PLU ${current.plu} is ${availability === 'sold_out' ? 'out of stock' : 'not found'} too`);
      const answer = await ask(productQuestion(availability === 'sold_out' ? 'out_of_stock' : 'not_found', current.plu, othersLeft), { action: 'stop' }, this.decisions);
      if (answer.action === 'skip') return this.leftOut(current);
      if (answer.action !== 'replace' || !answer.plu) stopped('Product Search', answer);
      current = this.replacement(current, answer.plu);
    }
  }

  private replacement(line: OrderLine, plu: string): OrderLine {
    log(`Checking PLU ${plu} to replace PLU ${line.plu}`);
    this.everWanted.add(plu);
    return { plu, quantity: line.quantity };
  }

  private leftOut(line: OrderLine): null {
    decided(this.decisions, `PLU ${line.plu} left out of the order`);
    return null;
  }

  /** Add to bag (PRD §13): the units of each product not in the bag yet. */
  async addAll(): Promise<void> {
    for (let index = 0; index < this.lines.length; index++) {
      const line = this.lines[index];
      const result = await this.addLine(line);
      if (result === 'added') continue;
      this.lines = result === 'left out' ? this.lines.filter((other) => other !== line) : replaceLine(this.lines, line.plu, result.plu);
      // From the start again: a replacement may have joined a product already added. Those are
      // in the bag already, so nothing is added twice.
      index = -1;
    }
  }

  /** One product's missing units. Returns 'added', 'left out', or the (available) replacement. */
  private async addLine(line: OrderLine): Promise<'added' | 'left out' | OrderLine> {
    let retried = false;
    for (;;) {
      const missing = line.quantity - (this.inBag.get(line.plu) ?? 0);
      if (missing <= 0) {
        if (retried) decided(this.decisions, `PLU ${line.plu} is in the bag`);
        return 'added';
      }
      const othersLeft = this.lines.length - 1;
      const counted = () => this.inBag.set(line.plu, (this.inBag.get(line.plu) ?? 0) + 1);
      let offers: ProductOffers | null = null;
      try {
        if (!this.shown.includes(line.plu)) await this.showResults(this.lines.filter((other) => (this.inBag.get(other.plu) ?? 0) < other.quantity).map((other) => other.plu));
        offers = await this.search.add({ plu: line.plu, quantity: missing }, counted);
      } catch (error) {
        const next = await this.afterFailedAdd(line, othersLeft, error);
        if (next !== 'retry') return next;
        retried = true;
        continue;
      }
      if (!offers) continue;
      // Its own page opened instead, with "Buy 1" / "Buy 2" (2026-11-02): how many is settled
      // first (outside the try: a question with no answer ends the run), then added there.
      this.shown = [];
      await this.settleHowMany(line, offers);
      try {
        await this.search.buyOnProductPage(line.plu, line.quantity - (this.inBag.get(line.plu) ?? 0), counted);
        const decision = this.howMany.get(line.plu);
        if (decision) decided(this.decisions, `PLU ${line.plu} x${line.quantity} in the bag`, decision);
      } catch (error) {
        const next = await this.afterFailedAdd(line, othersLeft, error);
        if (next !== 'retry') return next;
        retried = true;
      }
    }
  }

  /**
   * A product whose "add to bag" opened its page with "Buy 1" / "Buy 2" choices (user's request
   * 2026-11-02): with 1 of it in the order, the person chooses how many to buy, once per product,
   * and the order then has that many. With more in the order, or from the command line, it keeps
   * what was ordered.
   */
  private async settleHowMany(line: OrderLine, product: ProductOffers): Promise<void> {
    if (this.howMany.has(line.plu)) return;
    const more = product.offers.some((offer) => offer.quantity > line.quantity);
    if (line.quantity > 1 || !more || !interactive()) {
      this.howMany.set(line.plu, undefined);
      log(`PLU ${line.plu} has "Buy N" choices on its page: buying ${line.quantity}, as ordered${line.quantity === 1 && more ? ' (the normal price)' : ''}`);
      return;
    }
    const answer = await ask(buyQuestion(product), { action: 'buy', quantity: line.quantity }, this.decisions);
    if (answer.action !== 'buy' || !answer.quantity) stopped('Add to bag', answer);
    this.howMany.set(line.plu, this.decisions.at(-1));
    line.quantity = answer.quantity;
  }

  /**
   * An add that failed. Interactive runs ask: skip the product, replace it (staging refused it), or
   * retry ('retry': the bag is read again first, so nothing is added twice). A command-line run
   * ends with the error, as before.
   */
  private async afterFailedAdd(line: OrderLine, othersLeft: number, error: unknown): Promise<'retry' | 'left out' | OrderLine> {
    if (!interactive()) throw error;
    if (hasCode(error, 'PRODUCT_NOT_AVAILABLE')) {
      const answer = await ask(productQuestion('not_available', line.plu, othersLeft, reasonOf(error)), { action: 'stop' }, this.decisions);
      if (answer.action === 'skip') {
        this.leftOut(line);
        return 'left out';
      }
      if (answer.action !== 'replace' || !answer.plu) stopped('Add to bag', answer, error);
      const others = this.lines.filter((other) => other !== line);
      return (await this.resolve(line, othersLeft, others, [], this.replacement(line, answer.plu))) ?? 'left out';
    }
    const answer = await ask(errorQuestion('Add to bag', error, { skipPlu: othersLeft > 0 ? line.plu : undefined }), { action: 'stop' }, this.decisions);
    if (answer.action === 'skip') {
      this.leftOut(line);
      return 'left out';
    }
    if (answer.action !== 'retry') stopped('Add to bag', answer, error);
    await this.readBag();
    return 'retry';
  }

  /** Before an add is tried again: what the bag really holds, so nothing is added twice. */
  private async readBag(): Promise<void> {
    log('Reading the bag before trying again, so nothing is added twice');
    await retryOrAsk('Add to bag', this.decisions, async () => {
      // A reload clears whatever covers the page (e.g. an error pop-up).
      await this.page.reload();
      await this.bag.open();
      this.inBag.clear();
      for (const { plu, quantity } of await this.bag.contents()) this.inBag.set(plu, (this.inBag.get(plu) ?? 0) + quantity);
    });
    this.shown = [];
    log(`The bag holds: ${showLines([...this.inBag].map(([plu, quantity]) => ({ plu, quantity })))}`);
  }

  /**
   * After the bag or checkout page (the person's choice): `plus` out of the order, `replacements`
   * in. Each replacement is checked like the others (and asked about if it is out of stock or not
   * found too), then added; `plus` come out of the bag at Cart validation (tidyBag). One product
   * replaced: each replacement gets its quantity; several: one each.
   */
  async replace(plus: string[], replacements: string[]): Promise<void> {
    const decision = this.decisions.at(-1);
    const removed = this.lines.filter((line) => plus.includes(line.plu));
    const quantity = removed.length === 1 ? removed[0].quantity : 1;
    const kept = this.lines.filter((line) => !plus.includes(line.plu));
    const added: string[] = [];
    for (const plu of replacements) {
      log(`Checking PLU ${plu} to add instead of PLU ${plus.join(', ')}`);
      this.everWanted.add(plu);
      const ready = await this.resolve({ plu, quantity }, kept.length, kept, []);
      if (!ready) continue;
      const same = kept.find((line) => line.plu === ready.plu);
      if (same) same.quantity += ready.quantity;
      else kept.push(ready);
      added.push(ready.plu);
    }
    this.lines = kept;
    decided(this.decisions, `PLU ${plus.join(', ')} removed${added.length > 0 ? `; PLU ${added.join(', ')} added instead` : ''}`, decision);
    await this.addAll();
  }

  /** Takes these products out of the order (the person's choice); Cart validation takes them out of the bag (tidyBag). */
  drop(plus: string[]): void {
    this.lines = this.lines.filter((line) => !plus.includes(line.plu));
  }

  /** Leaves these products out of the order and takes them out of the bag (the person's choice). */
  async leaveOut(plus: string[]): Promise<void> {
    this.lines = this.lines.filter((line) => !plus.includes(line.plu));
    for (const plu of plus) {
      await this.bag.removeLines(plu);
      this.inBag.delete(plu);
    }
  }

  /**
   * Cart validation: takes out of the bag the products no longer in the order (skipped or
   * replaced after some of their units went in). Other products are left alone.
   */
  async tidyBag(): Promise<void> {
    const wanted = new Set(this.lines.map((line) => line.plu));
    for (const plu of new Set((await this.bag.contents()).map((line) => line.plu))) {
      if (wanted.has(plu) || !this.everWanted.has(plu)) continue;
      await this.bag.removeLines(plu);
      this.inBag.delete(plu);
    }
  }
}
