# Watsons STAGING Order Tester

Automated end-to-end order test for the **Watsons STAGING** website, built with
[Playwright](https://playwright.dev) and TypeScript. It runs in Microsoft Edge.

> ⚠️⚠️⚠️ **Staging only.** Never point this project at the production website.
> Requirements: [PRD.md](PRD.md). Project rules and progress: [CLAUDE.md](CLAUDE.md).
> UI/UX design: [UI-UX-PRD.md](UI-UX-PRD.md); the launcher page follows its refined prototype (2026-10-21).

**Status:** all PRD phases (1–12) built. Open **WatsonsTester.exe** (or `npm run launcher`),
paste the PLUs, and click **Place test order**, with Express or Standard delivery (Standard since 2026-10-13; Shell Station
with its pickup store instead, since 2026-10-30). The
launcher can also approve an order that already exists, and keeps a history of every run.

## What you need

- Windows 10 or 11 with **Microsoft Edge** (already part of Windows)
- **Node.js 22 LTS** or newer, from <https://nodejs.org>
- **Git** for save points (optional if you only run the tests), from <https://git-scm.com>
- Internet access to the staging website

No separate browser download is needed: the tests use your installed Edge.

## First-time setup

1. Open a terminal in the project folder. In VS Code: **Terminal → New Terminal**.
2. Download the libraries the project uses (into the `node_modules` folder):

   ```
   npm install
   ```

3. Create your private settings file (next section).
4. Build the launcher program once: `npm run build:exe` (see "WatsonsTester.exe").

## Settings (`.env`)

Private settings live in a file called `.env` in the project folder. Git never saves it.

1. If `.env` doesn't exist, copy `.env.example` and name the copy `.env`.
2. Open `.env`, type each value right after the `=` sign, then save (Ctrl+S).

| Setting | Value |
|---|---|
| `WATSONS_STAGING_URL` | The Watsons **staging** website address |
| `WATSONS_USERNAME` | Staging test account email |
| `WATSONS_PASSWORD` | Staging test account password |
| `WATSONS_BACKOFFICE_USERNAME` | Staging backoffice account with the Customer Support Manager role. Approves each new order, and is needed to approve an existing one. Optional for new orders: without it, a run ends on "Thank you for your order" and the order waits for approval |
| `WATSONS_BACKOFFICE_PASSWORD` | That backoffice account's password (fill in both backoffice settings, or neither) |
| `WATSONS_PAYMENT_OTP` | Optional. One-time code for the staging payment step; `1234` (what staging shows) when not set |
| `WATSONS_OPERATOR` | Optional. Your name in the launcher's Logs / History; your Windows user name when not set |

Tips:

- Don't put spaces around the `=` sign. If a value contains `#`, put the value in double quotes: `WATSONS_PASSWORD="abc#123"`.
- Never put real values in `.env.example`, in code, or in chats.

To check your settings, run `npm test`. The test "your .env file has every required setting" names
anything that is missing. It never shows the values.

## The test order (`test-data/order.txt`)

The order test reads its products and delivery method from `test-data/order.txt`:

```
delivery: Home Delivery
mode: Express

10117
10321 2
```

- `delivery:` is `Home Delivery`, `Click & Collect` or `Shell Station`.
- `mode:` is `Express` (the default) or `Standard`. From the command line, products that the
  mode can't deliver right now go in a second order by the other mode when it takes them all (a
  **partial order**, since 2026-11-03, below); otherwise they are left out of the order and listed
  in the result. A run from the launcher window asks first ("When a run needs your decision",
  below).
- **Shell Station** has no mode (since 2026-10-30): instead, `pickup store:` is `Choose for me`
  (the default) or `Let me choose` ("Shell Station pickup store", below). A `mode:` line is
  ignored for it.
- One PLU per line (paste freely; blank lines are fine). Add a quantity after a PLU for more
  than one unit (`10321 2`). Lines starting with `#` are ignored.
- From the command line, sold-out products are skipped and listed, and a PLU that isn't found
  stops the test before anything is added. A run from the launcher window asks instead.
- To use another order file for one run, set `WATSONS_ORDER_FILE` to its path, e.g. in
  PowerShell: `$env:WATSONS_ORDER_FILE = "C:\path\my-order.txt"` (set it to `''` afterwards).

## The launcher window (WatsonsTester)

The easiest way to run the tests: a Watsons window with two pages, **Automation** and
**Logs / History** (in its header, next to the **Light / Dark** switch; without a choice it follows
Windows). Start it with `npm run launcher` (or, once built, by double-clicking
`WatsonsTester.exe`, see below; if Windows blocks the exe, `Start without exe.cmd`). It opens in
its own Edge window; keep the black console window open while you use it.

### Automation page

On the left, the **workflow**; on the right, the **Ready** bar with the run button, and the form.

- **Workflow** (left), what should run:
  - **Place new order** (the usual run) **places a real STAGING test order** (Checkout, Pay,
    OTP `1234`) and then **approves it in the staging backoffice** (Customer Support role →
    Orders → the order → Fraud Report → Approve Order), until its status is **ORDER_EXTRACTED**.
    Without a backoffice account it stops at **"Thank you for your order"**, and the order
    shows **Awaiting approval** until someone with a backoffice account approves it (below).
  - **Approve existing order** does only the backoffice part, for an order that already
    exists. It never opens the shop, so it can't create an order. An order that is already
    extracted is left alone (**No change**).
  - Below them, the orders **awaiting approval** (the newest three, each with **Approve**).
- **Ready** says whether the run can start, or what to fix (click an item to go to it).
  **Show checks** lists the checks of PRD §37 (staging address and accounts set in `.env`,
  products and delivery method, or the order number). The button
  (**Place test order** or **Approve order**) stays disabled until all pass, and always asks you
  to confirm first. The run's browser shows in **Live browser**: no separate Edge window opens
  (since 2026-10-22). A missing backoffice account only blocks approving;
  for a new order the checks note "the order will wait for approval".
- **Products** (new order): paste the PLUs, one per line. For more than one of a product, add
  the quantity after it (`10321 2`). Beside each line: what it will order, or why it can't be
  read. The window starts with the products of your last run (or `test-data/order.txt`);
  **Clear** empties the list.
- **Delivery**: the method, and the mode: **Express** (the default; "Fastest" on the checkout
  page) or **Standard** (the regular delivery or pickup date). When the mode or method can't
  take some products, the run asks you what to do (below). The test waits 5 seconds from one
  "add to bag" click to the next (fixed since 2026-10-21; not a setting).
  **Shell Station** has only one way to deliver, so **Mode** is hidden for it and **Pickup
  store** shows instead (since 2026-10-30): **Choose for me** or **Let me choose** (below).
- **Order** (approving): its number (`07091012` or `WTCSG07091012`); beside it, its backoffice
  code, and below it who placed that order, if it is in the history.
- **Accounts**: where the accounts come from (`.env` on this PC; never shown).
- **Live browser**: where the run's browser shows once a run starts.

While a test runs, the page shows what runs with the time so far and **Stop**, the **Live
browser** (the run's browser, live: click, scroll and type into it, and switch its tabs; it runs
hidden, with no Edge window of its own, as on the hosted version), the **Steps** (with the time
each took) and the **Log**; on the Logs / History page, the header shows your run. The page
scrolls as a whole: the steps show in full, and the log keeps its own box, its lines wrapped
(since 2026-10-23).

A run ends as soon as it is done (since 2026-10-23; before, its last page stayed open until
**Close browser**, up to 5 minutes, and you couldn't start another run meanwhile):
- A new order with a backoffice account ends once the order is **ORDER_EXTRACTED** in the
  backoffice. Once it is **Order Split** it gets at most 1 more minute; if it isn't extracted by
  then, the run still completes and says **extraction still pending**: wait a few minutes, then
  check the order in the backoffice. (Before, it waited 10 minutes and then failed with
  `ORDER_NOT_EXTRACTED`.) The hosted version keeps checking it and updates the page by itself
  once it is extracted (since 2026-11-03, see [The hosted version](#the-hosted-version-server)).
- Without a backoffice account it ends on "Thank you for your order" right away: **Completed**,
  with a note that the order is **awaiting approval** until someone with a backoffice account
  approves it (Logs / History → **Approve**).
- An approval ends the same way as a new order. An order that is already at Order Split was
  approved before: **No change**, and Approve Order isn't clicked.

The result then shows **Completed** with
the order number (**Copy** copies it), the backoffice status and what is still pending, if
anything; **No change**, or **Failed at** a step with its error report (below); then
the products, the screenshots (click one to enlarge it), and the steps and log. **New order**
(or **Edit order**) goes back to the form; **Run again** asks to run the same again. (Since
2026-10-25 there is no **error-report.txt**, **Open report** or **Evidence folder** / **Evidence
(.zip)** button: the files stay in the run's evidence folder.) **Approve Order is clicked at
most once**: if the result is unclear, the run stops with `ORDER_APPROVAL_UNKNOWN` and asks you
to check the order in the backoffice by hand.

**Signed out by the backoffice** (since 2026-10-25): when the same backoffice account is open in
another tab or browser (e.g. your own, not signed out), the backoffice can send the run's tab
back to its sign-in page, while signing in or later. The run then closes that backoffice tab,
ends its session, signs in again in a new tab and carries on from the same step, at once instead
of waiting for the Orders list. It does this up to 3 times; then it stops with
`BACKOFFICE_LOGIN_FAILED` ("seems to be open in another tab or browser"). Approve Order is still
clicked only once: signed out just before it, the run opens the order again and checks its status
first.

**Stop** stops the test and its browser (once it is checking out, paying or approving, it asks
first, because the order or its approval may then already exist); the result is then **Stopped
at** that step. The launcher adds `order.txt` (what you asked for), `launcher-log.txt` (the full
log) and `launcher-run.json` (what it knows about the run) to the run's evidence folder.

### When a run needs your decision (since 2026-10-22)

Before **Checkout**, a run started from the window doesn't skip products or guess when something
is wrong: it **pauses** and asks, in a card under the run's bar (the page title says "Decision
needed"). It shows only the choices that make sense then:

| What happened | The question | The choices |
|---|---|---|
| Out of stock (Product Search) | "Product 39656 is out of stock. What would you like to do?" | Skip product and continue · Replace with another PLU · Stop automation |
| Not found (Product Search) | "Product 12345 was not found on staging. …" | the same |
| Staging won't add it (Add to bag): its "not available for checkout" pop-up, or its "add to bag" only opens the product's page (a page without Buy 1 / Buy 2) | "Product 57893 can't be added to the bag. …" | the same |
| A product with **Buy 1 / Buy 2** on its page (Add to bag, since 2026-11-02): its "add to bag" opens that page | "Product 23475 has a Buy 2 offer. How many would you like to buy?", with the page's prices ("Buy 1: S$ 8.50 · Buy 2: S$ 11.90 (extra savings S$ 5.10)") | Buy 1 at its normal price · Buy 2 for the promotional discount · Stop automation |
| The delivery mode can't take some products (checkout page) | "Products 17971 and 21684 are not eligible for Express delivery with Home Delivery." With a split, the details say what goes in each order | **Split into 2 orders: Express, then Standard** (when Standard takes all of them and some products can go Express; since 2026-11-03) · Remove them and continue · Remove them and add other PLUs (one product: Replace with another PLU) · Use Standard instead (when Standard takes them) · Try another delivery method · Stop automation |
| The delivery method can't take some products (bag page) | "Products 45614 and 24264 are not eligible for Click & Collect." | Remove them and continue · Remove them and add other PLUs (one product: Replace with another PLU) · Try another delivery method · Stop automation |
| Shell Station with **Let me choose** (checkout page, since 2026-10-30) | "Which Shell Station should the order be picked up from?", with staging's list of stations (name, address, stock; the one chosen now is selected; a search box when the list is long) | Use this store · Stop automation |
| The Shell station lacks some products (checkout page) | "Product 43808 is not available at SHELL BUKIT BATOK ROAD." | Remove it and continue · Replace with another PLU · Try another delivery method · Stop automation |
| Anything else before Checkout | "Something went wrong at Add to bag (PLU 5555). How would you like to proceed?", with the reason | Retry · Skip that product (when there is one) · Try another delivery method (at the bag) · Stop automation |

- **Skip** is offered only when other products are left to order.
- **Replace** asks for the PLU to use instead. The new product is checked like the others: if it
  is out of stock too, the run asks again.
- **Buy 1 / Buy 2** (since 2026-11-02) is asked once per product, when the order has 1 of it.
  The run chooses that on the product's page and clicks **BUY NOW**, so the bag and the order
  get 1 or 2 (Logs / History shows ×2); staging applies the offer itself ("2ND BUY AT 60% OFF").
  With 2 or more in the order nothing is asked: that many are bought on its page.
- **Split into 2 orders** (since 2026-11-03) places a **partial order**: order 1 by the chosen
  mode without those products, then order 2 by the other mode with them ("Partial orders", below).
  **Stop automation** stops before Checkout, with no order placed.
- **Remove … and continue** (products a delivery can't take, since 2026-10-22) takes them out of
  the bag, a "Buy 1 Get 1 Free" line with them, and the run goes on with the others. **Remove them
  and add other PLUs** (or **Replace with another PLU** for one product) takes several PLUs,
  separated by spaces; each is checked and added instead. One product replaced passes its quantity
  on; several: one each.
- **Retry** first reads the bag again, so nothing is added twice.
- **Stop automation** stops the run as **Stop** does.
- After your choice the run goes on from where it paused. Another delivery method goes back to
  the bag first; the steps follow your choice.
- A question waits up to 30 minutes, then the run stops there (`NO_ANSWER`).
- Nothing is asked from an order's **Checkout** on: the order may exist by then, so a problem
  there ends the run as before, and nothing is retried. (Order 2 of a partial order can still ask
  before its own Checkout, e.g. Retry when its bag page didn't load.)
- Each question, the choice, who made it and what came of it are in the log, in the result's
  **Decisions**, in Logs / History (and its CSV export), and in `result.json` (`decisions`).
- Runs from the command line (`npm run order`) are never asked. They do what they always did:
  skip sold-out products, stop on a PLU that isn't found, and leave out products the mode can't
  deliver, unless the other mode takes them all: then they split the order (a partial order, since
  2026-11-03). For Shell Station they choose the pickup store themselves. A product with Buy 1 /
  Buy 2 is bought as ordered (1: the normal price).

On the hosted version, only the person whose run it is can answer, and every answer is in the
audit trail.

Closing the window stops the launcher about 20 seconds later. A test that is running then
carries on to the end (its result is still saved in `reports/`; a run that has passed then
closes its browser); closing the black console window stops everything at once.

### When a run fails: the error report

A failed run shows its **error** under the step it failed at: the message, the error code and
the time, the address of each page that was open (without its query string, which can hold login
details), and the screenshot Playwright took of each open page at that moment (click it to
enlarge; the result shows the order number if there was one). **Copy error report** puts it on
the clipboard, ready to paste into Teams or an email together with the screenshot; the same text
is saved as `error-report.txt` in the run's evidence folder.

### Logs / History page

Every run in `reports/`, newest first: time, automation, order number (with **Copy**), delivery,
products (and how many were left out), status (**Running**, **Completed**, **Awaiting approval**,
**Failed**, **Stopped**, **No change**) and the step it ended at, error code and operator (its
screenshots are in its details, under **Evidence**). An order with status **Awaiting approval** ("Needs approval") has an **Approve**
button: it fills in an "Approve existing order" run for that order number; the header counts
these orders. Once that approval completes (or finds the order already extracted), the order
shows **Completed**, "approved later by …". A **partial order** (since 2026-11-03) shows both
order numbers (each with **Copy** in its details) and both modes ("Express + Standard"); each of its orders is approved on its own
(**Approve** fills in the next one, "Awaiting approval (1 of 2)" meanwhile), and the run shows
**Completed** once both are. Search by order number (either order of a partial order), PLU, error code or operator,
filter by status or automation, and click a run for its details. The first 40 runs show;
**Load 100 more** shows more.

A run's details (redesigned 2026-11-04 and simplified 2026-11-05, so a run can be understood
without reading everything):
- **One line on top:** what happened (a failed run: its error, with **Copy error report**, which
  holds the full error), how many orders, how long and how many steps, and **Evidence (N)**: the
  run's screenshots in the screenshot viewer (a failed run's starting with the one taken when it
  failed). With several, a strip of them under the screenshot goes to any one; the arrow keys
  and **Open file** (hosted: **Download**) work as before. This is the run's only Evidence
  button (the table has no Evidence column since 2026-11-05), and no screenshots show in the details.
- **Order results** (left): each order's number with **Copy** and its final status as a badge
  (Extracted, Extraction pending, Awaiting approval with its **Approve**, Approved, Not placed),
  then its mode and delivery method, its products, and the backoffice's own status in small print.
- **Execution activity** (right): the run's events, numbered, oldest first: eligibility problems,
  replacements, skipped products, a partial order, the orders placed, the backoffice approval,
  how the run ended, and approvals and extractions seen later. One short line each; click one
  for more (the question asked, the choice and its result; a failure's code, time and page, open
  by default).
- The two panels sit side by side, and one under the other when the space is narrow. What you
  opened stays open while the page updates.
**Export CSV** saves every run that matches the search and filters as
`reports/history-<date_time>.csv` and opens it (order numbers as backoffice codes, so Excel
keeps their zeros). Runs from before the history show what their evidence folder holds, without
an operator. The operator is `WATSONS_OPERATOR` from `.env`, or your Windows user name.

### Delivery modes on the checkout page

The checkout summary page offers one option per delivery mode, each a radio with a
**View N item(s)** list of which products it can deliver. **Express** is the option that shows
"Fastest"; **Standard** is the other one (it shows the estimated delivery or pickup date). For
either mode the test reads that list, leaves out the products marked "Not available" (a run from
the launcher window asks first: the other mode when it takes them, another method, leave them
out, replace, or stop), selects the option and waits for **Checkout** (`src/pages/CheckoutPage.ts`, `src/flows/delivery-modes.ts`).
When the chosen option asks for a delivery date ("Please Select a delivery date", usually
Standard **home delivery**), whatever the mode, the test opens "Select delivery date", picks
the **latest** available date in the list and confirms it, before Checkout (since 2026-10-16;
before, the earliest). It only looks at the chosen option: with Express chosen, the Standard
option still asks for a date, and is left alone. Click & Collect shows an estimated pickup date
instead.

**No delivery options** (since 2026-10-14): when all the products can only go one way, e.g. the
Standard-only PLUs 46700, 46465 and 46358, the page shows just that one mode, already chosen,
with no options to pick from. The test then doesn't look for options: it picks the delivery
date if asked and goes straight on to **Checkout**, with every product. It tells the pages apart
by the options themselves, not by whether Express shows:
- a radio to click, or two options: a choice, handled as above;
- one Standard option with its radio hidden, unchanged for 5 seconds: no choice;
- anything else waits up to a minute for the other option, because the page sometimes draws one
  option well before the other (seen 2026-10-14: "Fastest" alone for several seconds).

If options still appear by the time Checkout is ready, the test selects the mode as usual. If the
run asked for **Express** but the page offers only Standard, it stops before Checkout with
`EXPRESS_OPTION_NOT_FOUND` ("offers only Standard for these products") and places no order; a
run from the launcher window asks instead ("Use Standard instead"). A
page that doesn't load, or whose Checkout button stays unavailable, stops the run with
`CHECKOUT_FAILED`.

### Partial orders (since 2026-11-03)

When the chosen mode can't deliver some products but the **other mode takes them all** (and some
products can go the chosen way), the order can be **split in two**, e.g. Click & Collect Express
(CCE) or Home Delivery Express (HDE) with PLUs 10031 and 46700 (Express) and 17562 (Standard only):
1. The run asks first (**Split into 2 orders: Express, then Standard**; the details say what goes
   in each). The other choices stay; **Stop automation** stops before Checkout. A command-line
   run splits by itself.
2. **Order 1** is checked out by the chosen mode with the products it takes. Staging keeps the
   others in the bag ("The remaining 1 items have been added to your bag." on the thank-you page).
3. **Order 2** comes from that bag: nothing is emptied or removed. Its own steps, named
   "… (order 2)", check that the bag holds exactly those products, choose the other mode (the
   page often offers only that one) and its date if asked, then check out, pay and confirm.
4. With a backoffice account, each order is approved, then each one's extraction is waited for.
   Without one, both wait for approval.
5. The run is **Completed** only once every order is placed (and approved, with a backoffice
   account). The result, Logs / History, the log and `result.json` (`orders`) give each order's
   number, delivery mode, products and status. If order 2 fails, the run fails at its step, and
   order 1's number is still shown.

Works the other way round too (Standard first, Express for the rest), for Home Delivery and Click
& Collect. Not for Shell Station (one way only), and order 2 is never split again. The checkout
page's "Available items" list marks a product a mode can't deliver "Not available" or, with Click &
Collect since 2026-11-03, "Sorry, this item is not available for Express mode."; both are read.

**Click & Collect** needs a pickup store on the account. Staging remembers the last one used
("Recent Pickup Store"), and with one, Click & Collect runs reach Checkout (2026-10-14). Without
one, the bag's **Next** stays locked (seen 2026-10-13); the test doesn't choose a store itself
yet. Home Delivery works with both modes.

### Shell Station pickup store (since 2026-10-30)

Shell Station has **no Express or Standard**: its one way is a pickup at a Shell station, so the
window hides **Mode** for it and asks how to choose the **pickup store** instead. Its checkout
step is **Pickup Store Selection** (instead of "Express Delivery Selection"). Before, a Shell
Station run waited at "Express Delivery Selection" for options that never come, and failed.

On the checkout page, the "Pickup at Shell Station" card shows either the chosen store with
**Change pickup store** (staging remembers the account's last one, "Recent Pickup Store"), or
**Add Shell Station Pick up location** when there is none. Either opens staging's store list
(the recipient's name and mobile number, filled in from the account; Region and City filters;
the stations, numbered, 10 to a page, each saying whether it has the products, e.g. "All
Available"; **Select this store**). On 2026-10-30 staging had 12 Shell stations.

- **Choose for me** (the default): the store already chosen stays; with none yet, the run takes
  the first station in the list that has every product ("All Available"), else the first one.
- **Let me choose**: the run opens the list, shows every station (all regions, all pages) in the
  window, and waits for your pick (**Use this store**); then it selects it there. A run from the
  command line can't ask: it chooses for itself.
- Then it opens the option's **View N item(s)** list. Products the station marks "Not available":
  a run from the window asks (remove them, replace them, another method, or stop); from the
  command line they are left out and listed, as with Express.
- The station chosen is in the log, the result (**Delivery**: "Shell Station · SHELL BUKIT BATOK
  ROAD"), Logs / History and `result.json` (`delivery.store`).
- If the list has no name or mobile number for the recipient, or a station can't be chosen, the
  run stops before Checkout with `PICKUP_STORE_NOT_SELECTED`.

Code: `src/pages/ShellStationPickup.ts` (the card and the store list), `src/flows/shell-station.ts`.

**Products a delivery method can't take** (seen 2026-10-22): with Click & Collect or Shell
Station, the bag page lists them in a box above the others ("Sorry, your order includes item(s)
not available for Click & Collect service…"; Shell Station: "…not applicable for Click and
Collect, please select Home Delivery") with **Buy Next Time**, and **Next** can't be clicked.
The test reads that list (`BagPage.methodProblem`). A run from the launcher window asks: remove
them, remove them and add other PLUs, another method, or stop. From the command line it stops
with `DELIVERY_METHOD_NOT_AVAILABLE`, naming them.

**Buy 1 / Buy 2 products** (seen 2026-11-02 with PLU 23475 and 23317, "Buy 2 Get Discount"):
the search results show them as e.g. "S$5.95/pcs (Buy 2 - Offer price)", and their **add to
bag** opens the product's page instead of adding. Before, the run tried 3 times and then asked
"can't be added to the bag". That page offers **Buy 1** (the normal price) and **Buy 2** (with
"Extra Savings") above QUANTITY and **BUY NOW**. Choosing one only sets the quantity; BUY NOW then
adds that many with the search results' own request (`…/entries?code=23475&qty=2`) and the page
stays. The test checks the request and that the bag's count went up by that many. The bag then
shows one line of 2, "Applied 2ND BUY AT 60% OFF" (S$17.00 → S$11.90), and checks it like any
other line. Code: `src/pages/ProductPage.ts`, `src/flows/order-products.ts`.

**Free items** (seen 2026-10-22): with "Buy 1 Get 1 Free" (e.g. PLU 17971) staging adds the free
unit by itself, as its own bag line marked FREE without a quantity box. The bag check leaves it
out of the comparison and logs it; it comes with the order.

**Free gifts** (seen 2026-10-22 with Click & Collect and 10 products): the bag shows a free-gift
area ("0 Free Gift(s) to select", a **0/0 selected** counter) and, opened, "For Express orders,
online free gift/s are not applicable. Please remove them if you would still like to go for
Express delivery." With **0** selected no gift is in the bag (its only gift, "HOME DELIVERY
CHARGES", was "Fully redeemed"), so there is nothing to remove and the run goes on; before, it
failed with `FREE_GIFT_REMOVAL_FAILED`. A selected gift is removed, as before.

To add another mode: give it a step in `src/flows/delivery-modes.ts`, then add it to `MODES` in
`launcher/launcher.cjs`. The window, its checks, the order file and the progress steps follow
from that list.

## The hosted version (server)

The same tool can run on a company server: colleagues open it **by URL in Edge** (on the Watsons
network or VPN), sign in, enter **their own staging accounts** and run. Runs go on in parallel
on the server, headless, and everyone sees **one shared Logs / History**.

| Topic | Hosted version |
|---|---|
| Sign-in | With an account the admin creates (`server/scripts/users.cjs`; bcrypt hashes in `users.json` on the server). |
| Testing and backoffice accounts | Each person enters their own under **Accounts**, once: the staging shop account (to place orders) and the staging backoffice account (to approve them; approving an existing order needs only this one). The backoffice account is **optional for new orders**: without it, the order stops at "Thank you for your order", the run shows **Completed** with **Awaiting approval** under it in Logs / History until someone with a backoffice account approves it there (**Approve**). The server **remembers them** for the person's next sign-in (unless they untick Remember), **sealed with a key made from their own portal password**, so only their sign-in opens them. They are used only for their runs, and never logged or shown to anyone else. |
| Live browser | While a run goes on, its owner sees the server's browser in the page (**Live browser**, about 3 pictures a second) and can use it: click, scroll, type, and switch between its tabs. Nobody else sees it. The run ends as soon as it is done (since 2026-10-23), so the next one can start straight away. |
| Parallel runs | One run per person, and per testing account, at a time; up to `WATSONS_MAX_PARALLEL_RUNS` runs at once, then a waiting line. |
| Logs / History | Everyone's runs, from a database on the server (SQLite), with a **Mine / All** filter. Screenshots are shown in the browser (**Download** saves one); the error report is copied from the page. The rest of the evidence stays on the server (no zip, report or error-report.txt downloads since 2026-10-25). |
| Extraction pending (since 2026-11-03) | An order whose run ended at **Order Split** is checked until it is **ORDER_EXTRACTED**: 2 minutes after the run, every 2 minutes for the first hour, then every 10 minutes, for up to 24 hours. A check signs in to the staging **shop** with the testing account that placed the order and reads the order under My Account (the shop gives its status, e.g. `ORDER_EXTRACTED`, and its extraction time); it only reads, and never uses the backoffice. Once extracted, every open page updates by itself, with no refresh: Logs / History shows **Order extracted** instead of **Extraction pending**, and the run's details and result say when it was extracted. The checks pause while the person who placed it is signed out (the server holds their testing account only while they are) and go on at their next sign-in; one at a time, never while that account is in use by a run. After 24 hours the row says to check it in the backoffice. A partial order's orders are followed one by one (e.g. "Order 2 extracted"). Code: `server/lib/extraction.cjs`, `tests/extraction-check.e2e.spec.ts` (Playwright project `extraction`). The desktop window doesn't check. |
| Walkthrough (since 2026-10-31) | A 30-second video of the whole workflow, recorded from the hosted app itself (since 2026-11-01): a new test order with its products and delivery, its run followed step by step (sped up), its approval in the backoffice, the order at ORDER_EXTRACTED, and Logs / History. It opens by itself the first time a browser lands on the page after sign-in, with captions and steps to jump to; **Start using app**, **×** or Esc close it, and **Walkthrough** in the header shows it again. The video is only sent when it opens. The desktop window has none. To record it again after the page changes: `node server/scripts/record-walkthrough.cjs --place-order` (it places a real staging test order, which the run approves; [docs/server-deployment.md](docs/server-deployment.md) §7). |

- **Code:** `server/` (Node.js 24 with express, express-rate-limit and bcryptjs; the database is
  Node's built-in SQLite). It reuses the launcher's code (`launcher/launcher.cjs`) and page
  (`launcher/ui.html`, in its server mode) and the same tests.
- **Setup for IT:** [docs/server-deployment.md](docs/server-deployment.md).
- **Try it on a PC:**
  1. Run `npm install` in `server/`.
  2. Add a user with `node server/scripts/users.cjs add <name>`.
  3. Start it with `npm run server`, with `WATSONS_STAGING_URL`, `WATSONS_CONFIG_DIR`,
     `WATSONS_DATA_DIR`, `WATSONS_EVIDENCE_DIR` and `WATSONS_COOKIE_SECURE=false` set.
  4. Open `http://127.0.0.1:3000`.

## WatsonsTester.exe

`WatsonsTester.exe` is the launcher window as one Windows program: double-click it in the
project folder and the launcher opens. It is built from `launcher/` and is not saved in Git,
so build it on each PC:

```
npm run build:exe
```

This takes a few seconds and writes `WatsonsTester.exe` (about 80 MB) into the project folder.
Build it again after changing anything in `launcher/` (changes to the tests themselves don't
need a rebuild: the exe always runs the tests in the project folder). Close the launcher
before rebuilding.

How it works (`scripts/build-exe.mjs`): Node's "single executable application" feature puts
`launcher/launcher.cjs` and `launcher/ui.html` inside a copy of your `node.exe`, using the
`postject` tool. Background: `docs/launcher-decision.md`.

What the exe needs:

- It must stay **in the project folder** (it uses the tests, `node_modules` and `.env` next to
  it). For a desktop icon, right-click it → **Show more options → Send to → Desktop (create
  shortcut)**.
- **Node.js** installed, `npm install` done and `.env` filled in. The window's "Before
  running" list shows ✗ with a hint for anything missing.
- **Microsoft Edge** for the window and the tests. Without Edge, the window opens in the
  default browser.

To give the launcher to other people, use the share zip (next section) instead of copying the
project folder: the folder holds your `.env` with the test account's password.

Windows may say the publisher is unknown: the exe is built on your PC and not signed (Node's
own signature no longer matches once the launcher is inside; the build prints "The signature
seems corrupted!", which is expected). Everything stays visible in the project: `npm test`,
`npm run test:e2e` and `npm run order` work without the exe.

## Sharing WatsonsTester with other people

```
npm run build:share
```

This writes **`WatsonsTester.zip`** (about 35 MB) into the project folder. Send that file. It
contains a fresh `WatsonsTester.exe`, the order test, the libraries it runs on, a `.env` with
only the staging address filled in, and `START-HERE.txt` with the steps for the person who
gets it (also in `launcher/START-HERE.txt`). It never contains your `.env`, reports,
recordings or captures: the build stops if the test account's username or password appears in
any of its files. The zip works while your own launcher is open.

What the other person needs (all in `START-HERE.txt`):

1. Windows 10 or 11 with Microsoft Edge.
2. **Node.js** 20 or newer (LTS) from <https://nodejs.org>. The exe runs the test with it.
3. Unzip into a folder of their own. If the zip came by email, Teams or a download, first
   right-click it → Properties → tick **Unblock**, so Windows doesn't block the exe.
4. Fill in `WATSONS_USERNAME` and `WATSONS_PASSWORD` (shop test account) and, if they approve
   orders, `WATSONS_BACKOFFICE_USERNAME` and `WATSONS_BACKOFFICE_PASSWORD` (backoffice account)
   in the `.env` in that folder. Without a backoffice account their orders wait for approval.
   **Send the account details separately** (never in the zip or a shared chat).
5. Access to the staging website from their PC.

Then they double-click `WatsonsTester.exe`. If Windows shows "Windows protected your PC": More
info → Run anyway. If the exe is blocked completely, `Start without exe.cmd` in the same
folder opens the same launcher.

Good to know: each run empties the test account's bag first, so two people using the **same
test account at the same time** spoil each other's runs. Take turns, or give each person their
own staging test account. After you change the tests or the launcher, build and send a new zip.

## Safety lock

The approved staging address is written into the code (`src/safety/staging-guard.ts`).

- If `WATSONS_STAGING_URL` is anything else (production, a look-alike, plain `http`), tests that
  visit the website stop before opening anything, with **❌ SAFETY CHECK FAILED**.
- While a test runs, Edge is not allowed to open any other site. Such a page load is cancelled
  before it leaves the PC, and the test fails with the same message.

## Running the tests

| Command | What it does |
|---|---|
| `npm test` | Quick checks (browser hidden). Some visit the staging site and log in (about 2 minutes). The hosted version's checks (`tests/server.spec.ts`) run when `npm install` was done in `server/`, else they are skipped. |
| `npm run test:e2e` | The order flow from `test-data/order.txt`, up to the Checkout button with the file's mode selected (several minutes; empties and refills the test account's bag; places no order) |
| `npm run order` | The same, then **places a real STAGING test order**: Checkout, Pay, OTP, and checks the order number on the confirmation page |
| `npm run approve` | **Approves an existing STAGING order** in the backoffice (no new order). Set its number first: `$env:WATSONS_APPROVE_ORDER = '07091012'; npm run approve` (then `$env:WATSONS_APPROVE_ORDER = ''`) |
| `npx playwright test --project=extraction` | **Reads** whether orders are extracted, in the staging shop with the `.env` testing account (only reads). The hosted version runs it by itself (since 2026-11-03). By hand: `$env:WATSONS_CHECK_ORDERS = '07155003'; $env:WATSONS_CHECK_RESULT = 'check.json'; npx playwright test --project=extraction` |
| `npx playwright test --headed` | Run all tests with the Edge window visible |
| `npm run report` | Open the last test report (press Ctrl+C in the terminal to stop it) |
| `npm run typecheck` | Check the TypeScript code for mistakes |
| `npm run look` | Developer tool: look-only captures of staging pages, saved in `inspection/` |
| `npm run check:leaks` | Check that the password appears nowhere in reports, recordings or captures |
| `npm run launcher` | Open the launcher window (see "The launcher window") |
| `npm run server` | Start the hosted version (see "The hosted version"; needs `npm install` in `server/` once) |
| `npm run build:exe` | Build `WatsonsTester.exe` (see "WatsonsTester.exe") |
| `npm run build:share` | Build `WatsonsTester.zip` to give to other people (see "Sharing WatsonsTester") |

When a test fails, Playwright keeps a screenshot and a step-by-step recording ("trace") of it.
Both are in the report.

The order flow waits 5 seconds between "add to bag" clicks (fixed since 2026-10-21; it is not a
setting).

### Evidence of each order run (`reports/`)

Every `npm run test:e2e` or `npm run order` run saves its evidence in its own folder,
`reports/<date>_<time>/` (shown as "Evidence: …" at the end of the run):

| File | Contents |
|---|---|
| `result.json` | Passed/failed, the automation (`order` or `approve`), the outcome (`order_placed`, `order_placed_unapproved` (placed without a backoffice account), `ready_to_check_out`, `approved`, `no_change` or `failed`), the order number (of a partial order, the first; each of its orders with its number, delivery mode, products and backoffice status in `orders`, since 2026-11-03), the failed step and error code with the time it failed, the pages open then and their screenshots, the products ordered / skipped as sold out / left out as not eligible, the questions the run asked and what was chosen (`decisions`, since 2026-10-22), browser console errors |
| `log.txt` | The step-by-step log of the run |
| `screenshot-*.png` | The checkout summary, the order confirmation and the backoffice order (when an order is placed or approved), and `screenshot-N-failure.png`: each open page when the run failed |
| `order.txt`, `launcher-log.txt`, `launcher-run.json` | Launcher runs only: what was asked, the full log, and what the launcher knows about the run (automation, operator, status, seconds between adds) for Logs / History |
| `error-report.txt` | Failed launcher runs only: the error report, ready to send (see "When a run fails") |
| `trace.zip` | Step-by-step recording, kept only when the run fails. Open it with `npx playwright show-trace <path>` |
| `html-report/index.html` | The full Playwright report of the run |

The run ends with a summary box: **ORDER TEST PASSED** (with the order number), **ORDER PLACED
(NOT APPROVED YET)** (no backoffice account), **READY TO CHECK OUT (NO ORDER PLACED)**, or
**ORDER TEST FAILED** with the step, the error code and the reason (for approvals: **ORDER
APPROVED**, **NO CHANGE (ALREADY EXTRACTED)** or **APPROVAL FAILED**). If it says `PAYMENT_RESULT_UNKNOWN`, check My Account → Order History on staging
before running again: the order may have been created.

The `reports/` folder is never saved in Git. Delete old run folders whenever you like.

## Project layout

| Path | Contents |
|---|---|
| `tests/` | The tests: `order.e2e.spec.ts` (the order flow), `approve.e2e.spec.ts` (approving an existing order) and the quick checks |
| `src/config/settings.ts` | Reads and checks the settings |
| `src/safety/staging-guard.ts` | The safety lock: approved address and browser guard |
| `src/fixtures/staging.ts` | The `test` used by every test that visits staging (safety lock, recordings) |
| `src/pages/` | One "page object" per staging page (login, search, product page, bag, checkout, payment, confirmation) |
| `src/reporting/` | The evidence folder per order run (`reports/`) and the PASS/FAIL box |
| `launcher/` | The launcher window (`launcher.cjs` runs it and reads Logs / History from `reports/`; `ui.html` is the page, with the Watsons logo inside it); see `docs/launcher-decision.md` |
| `server/` | The hosted version: `server.cjs` (the web app), `lib/` (sign-in, runs, database, evidence), `scripts/` (users, import of desktop reports, recording the walkthrough), `walkthrough/` (the walkthrough video, its poster and its captions), `iis/web.config`; setup in `docs/server-deployment.md` |
| `scripts/build-exe.mjs` | Builds `WatsonsTester.exe` from `launcher/` |
| `scripts/build-share.mjs` | Builds `WatsonsTester.zip` for other people (their guide: `launcher/START-HERE.txt`) |
| `src/utils/secrets.ts` | Types the username and password so they never appear in reports or recordings |
| `inspect/` + `playwright.inspect.config.ts` | Look-only captures (`npm run look`) |
| `docs/staging-notes.md` | What the staging pages actually contain |
| `playwright.config.ts` | Playwright settings: Edge, one test at a time, no automatic retries |
| `.env.example` | The list of settings, with no real values |
| `.claude/settings.json` | Claude Code settings (blocks Claude's file tools from opening `.env`) |

## Troubleshooting

- **"Missing settings in .env: …"**: open `.env`, fill in the settings named in the message, save, and run again.
- **"❌ LOGIN_FAILED"**: the message names the step and likely causes. Check the username and
  password in `.env`, and the failure screenshot in the report (`npm run report`).
- **"❌ BACKOFFICE_LOGIN_FAILED … seems to be open in another tab or browser"**: the backoffice
  kept signing the run out. The test already closes its backoffice tab and signs in again in a
  new one by itself, up to 3 times. This happens when the same backoffice account is open
  elsewhere, e.g. in your own browser: sign out there or close that backoffice tab, then run again
  (for a new order that is already placed: **Approve existing order** with its number).
- **"❌ PICKUP_STORE_NOT_SELECTED"** (Shell Station): no pickup store could be chosen. If it says
  the recipient's name or mobile number is missing, add them to the testing account on staging
  (My Account), or choose a Shell station once by hand; otherwise staging was slow or its store
  list changed: run again, and look at the failure screenshot.
- **"Empty bag" stuck on removing a product** (before 2026-10-30): a product that brings a
  promotion's free item asks "ARE YOU CONFIRM TO DELETE" instead of the usual "Are you sure you
  want to remove this item?". The test now takes both.
- **"❌ SAFETY CHECK FAILED"**: `WATSONS_STAGING_URL` in `.env` isn't the approved staging address, or
  the site tried to send the browser somewhere else. Check the address; don't change the safety lock.
- **"running scripts is disabled on this system"** when typing `npm` commands in PowerShell: run
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, then open a new terminal.
- **Extra options after `npm run …` are ignored in PowerShell** (PowerShell removes the `--`):
  run Playwright directly instead, e.g. `npx playwright test --headed`.
- **Edge doesn't start**: check that Microsoft Edge is installed and up to date
  (Edge menu **…** → Settings → About Microsoft Edge).
- **"Windows cannot access the specified device, path, or file" when opening WatsonsTester.exe**:
  on company-managed PCs, Microsoft Defender can block new, unsigned programs (seen 2026-10-07:
  its "prevalence, age or trusted list" rule). Double-click `Start without exe.cmd` instead
  (needs Node.js): it opens the same launcher. Only the company's IT can allow the exe itself.
