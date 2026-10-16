# Watsons STAGING Order Tester

Automated end-to-end order test for the **Watsons STAGING** website, built with
[Playwright](https://playwright.dev) and TypeScript. It runs in Microsoft Edge.

> ⚠️⚠️⚠️ **Staging only.** Never point this project at the production website.
> Requirements: [PRD.md](PRD.md). Project rules and progress: [CLAUDE.md](CLAUDE.md).
> Planned UI/UX redesign: [UI-UX-PRD.md](UI-UX-PRD.md).

**Status:** all PRD phases (1–12) built. Open **WatsonsTester.exe** (or `npm run launcher`),
paste the PLUs, and click Run, with Express or Standard delivery (Standard since 2026-10-13). The
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
- `mode:` is `Express` (the default) or `Standard`. Products that the mode can't deliver right
  now are left out of the order and listed in the result.
- One PLU per line (paste freely; blank lines are fine). Add a quantity after a PLU for more
  than one unit (`10321 2`). Lines starting with `#` are ignored.
- Sold-out products are skipped and listed. A PLU that isn't found stops the test before
  anything is added.
- To use another order file for one run, set `WATSONS_ORDER_FILE` to its path, e.g. in
  PowerShell: `$env:WATSONS_ORDER_FILE = "C:\path\my-order.txt"` (set it to `''` afterwards).

## The launcher window (WatsonsTester)

The easiest way to run the tests: a Watsons window with two tabs, **Automation** and
**Logs / History**. Start it with `npm run launcher` (or, once built, by double-clicking
`WatsonsTester.exe`, see below; if Windows blocks the exe, `Start without exe.cmd`). It opens in
its own Edge window; keep the black console window open while you use it.

### Automation tab

On the left, what to run, in numbered steps; on the right, **Run** and the **Current status**.

1. **Automation**: what should run.
   - **Place new order** (the usual run) **places a real STAGING test order** (Checkout, Pay,
     OTP `1234`) and then **approves it in the staging backoffice** (Customer Support role →
     Orders → the order → Fraud Report → Approve Order), until its status is **ORDER_EXTRACTED**.
     Without a backoffice account it stops at **"Thank you for your order"**, and the order
     shows **Awaiting approval** until someone with a backoffice account approves it (below).
   - **Approve existing order** does only the backoffice part, for an order that already
     exists: type its number (`07091012` or `WTCSG07091012`). It never opens the shop, so it
     can't create an order. An order that is already extracted is left alone (**No change**).
2. **Products** (new order): paste the PLUs, one per line. For more than one of a product, add
   the quantity after it (`10321 2`). The table next to it shows what will be ordered, and any
   line it can't read. The window starts with the products of your last run (or
   `test-data/order.txt`).
3. **Delivery**: the delivery method, and the mode: **Express** (the default; "Fastest" on the
   checkout page) or **Standard** (the regular delivery or pickup date). Products that the mode
   can't deliver are left out of the order and listed in the result.
4. **Timing**: **Seconds between adds**, the time from one "add to bag" click to the next
   (default 10, from 0 to 120). The window remembers your last choice.
5. **Run** lists the checks of PRD §37 (staging address and accounts set in `.env`, products,
   delivery method and seconds between adds, or the order number). The Run button
   (**Run order test** or **Approve in Backoffice**) stays disabled until all show ✓, and always
   asks you to confirm first. The browser is shown. A missing backoffice account only blocks
   approving; for a new order it shows ○ "the order will wait for approval".

While a test runs, **Current status** shows the step it is on and the time so far, with the
steps done and the log below; the header shows the status too. A new order ends on the
backoffice's Orders list showing the order with **Status ORDER_EXTRACTED** (the order's bar at
the bottom keeps the status it had when it was opened: the backoffice doesn't update it), with
the shop's "Thank you for your order!!" page in the first tab; without a backoffice account it
ends on that page; an approval ends on the backoffice order. Edge stays open until you close its
window (or 5 minutes pass), and you can use it; the launcher already shows the order number.
After you close it, the result shows **Completed** with the order number and the backoffice
status, **Awaiting approval** (placed, not approved yet), **No change**, or **Failed** with its
error report (below), and buttons to open the report and the evidence folder. **Approve Order
is clicked at most once**: if the result is unclear, the run stops with
`ORDER_APPROVAL_UNKNOWN` and asks you to check the order in the backoffice by hand.

**Stop** stops the test and its browser (once it is checking out, paying or approving, it asks
first, because the order or its approval may then already exist); the result is then
**Stopped**. The launcher adds `order.txt` (what you asked for), `launcher-log.txt` (the full log)
and `launcher-run.json` (what it knows about the run) to the run's evidence folder.

Closing the window stops the launcher about 20 seconds later. A test that is running then
carries on to the end (its result is still saved in `reports/`); closing the black console
window stops everything at once.

### When a run fails: the error report

A failed run shows an **error report**: the step, the time it failed, the message, the address
of each page that was open (without its query string, which can hold login details), the order
number if there was one, and the screenshot Playwright took of each open page at that moment
(click it to enlarge). **Copy error report** puts it on the clipboard, ready to paste into Teams
or an email together with the screenshot; the same text is saved as `error-report.txt` in the
run's evidence folder.

### Logs / History tab

Every run in `reports/`, newest first: time, automation, order number, delivery, products (and
how many were left out), status (**Running**, **Completed**, **Awaiting approval**, **Failed**,
**Stopped**, **No change**), error code and step, operator, and screenshots. An order with
status **Awaiting approval** ("Needs approval") has an **Approve in Backoffice** button in its
details: it fills in an "Approve existing order" run for that order number. Once that approval completes
(or finds the order already extracted), the order shows **Completed**, "approved later by …".
Search by order number, PLU,
error code or operator, filter by status or automation, and click a run for its details, error
report and screenshots. **Export CSV** saves the runs shown as `reports/history-<date_time>.csv`
and opens it (order numbers as backoffice codes, so Excel keeps their zeros). Runs from before the
history show what their evidence folder holds, without an operator. The operator is
`WATSONS_OPERATOR` from `.env`, or your Windows user name.

### Delivery modes on the checkout page

The checkout summary page offers one option per delivery mode, each a radio with a
**View N item(s)** list of which products it can deliver. **Express** is the option that shows
"Fastest"; **Standard** is the other one (it shows the estimated delivery or pickup date). For
either mode the test reads that list, leaves out the products marked "Not available", selects
the option and waits for **Checkout** (`src/pages/CheckoutPage.ts`, `src/flows/delivery-modes.ts`).
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
`EXPRESS_OPTION_NOT_FOUND` ("offers only Standard for these products") and places no order. A
page that doesn't load, or whose Checkout button stays unavailable, stops the run with
`CHECKOUT_FAILED`.

**Click & Collect** needs a pickup store on the account. Staging remembers the last one used
("Recent Pickup Store"), and with one, Click & Collect runs reach Checkout (2026-10-14). Without
one, the bag's **Next** stays locked (seen 2026-10-13); the test doesn't choose a store itself
yet. Home Delivery works with both modes.

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
| Testing and backoffice accounts | Each person enters their own in step 2, once: the staging shop account (to place orders) and the staging backoffice account (to approve them; approving an existing order needs only this one). The backoffice account is **optional for new orders**: without it, the order stops at "Thank you for your order" and shows **Awaiting approval** in Logs / History until someone with a backoffice account approves it there (**Approve in Backoffice**). The server **remembers them** for the person's next sign-in (unless they untick Remember), **sealed with a key made from their own portal password**, so only their sign-in opens them. They are used only for their runs, and never logged or shown to anyone else. |
| Live browser | While a run goes on, its owner sees the server's browser in the page (**Live browser**, about 3 pictures a second) and can use it: click, scroll, type, and switch between its tabs. Nobody else sees it. When the order is placed, the last page (e.g. "Thank you for your order") stays open until **Close browser**, at most 5 minutes. |
| Parallel runs | One run per person, and per testing account, at a time; up to `WATSONS_MAX_PARALLEL_RUNS` runs at once, then a waiting line. |
| Logs / History | Everyone's runs, from a database on the server (SQLite), with a **Mine / All** filter. Evidence is downloaded (zip, error report) or shown in the browser (screenshots, Playwright report). |

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

The order flow waits 10 seconds between "add to bag" clicks. For another time in a command-line
run, set `WATSONS_ADD_DELAY_SECONDS` first (0 to 120), e.g. `$env:WATSONS_ADD_DELAY_SECONDS = '5'`
(the launcher sets it from **Seconds between adds**).

### Evidence of each order run (`reports/`)

Every `npm run test:e2e` or `npm run order` run saves its evidence in its own folder,
`reports/<date>_<time>/` (shown as "Evidence: …" at the end of the run):

| File | Contents |
|---|---|
| `result.json` | Passed/failed, the automation (`order` or `approve`), the outcome (`order_placed`, `order_placed_unapproved` (placed without a backoffice account), `ready_to_check_out`, `approved`, `no_change` or `failed`), the order number, the failed step and error code with the time it failed, the pages open then and their screenshots, the products ordered / skipped as sold out / left out as not eligible, browser console errors |
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
| `src/pages/` | One "page object" per staging page (login, search, bag, checkout, payment, confirmation) |
| `src/reporting/` | The evidence folder per order run (`reports/`) and the PASS/FAIL box |
| `launcher/` | The launcher window (`launcher.cjs` runs it and reads Logs / History from `reports/`; `ui.html` is the page, with the Watsons logo inside it); see `docs/launcher-decision.md` |
| `server/` | The hosted version: `server.cjs` (the web app), `lib/` (sign-in, runs, database, evidence), `scripts/` (users, import of desktop reports), `iis/web.config`; setup in `docs/server-deployment.md` |
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
- **"❌ BACKOFFICE_LOGIN_FAILED … seems to be open in another browser"**: the backoffice sent
  the sign-in back to its sign-in page twice. The test already starts a fresh backoffice session
  once by itself. This happens when the same backoffice account is open elsewhere, e.g. in your
  own browser: close that backoffice tab or sign out there, then run again.
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
