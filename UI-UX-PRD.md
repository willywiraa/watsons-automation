# WatsonsTester: UI/UX redesign PRD

| | |
|---|---|
| Status | Draft for review |
| Owner | Willy |
| Date | 2026-10-15 |
| Scope | `launcher/ui.html`, the one page used by both the desktop launcher (`WatsonsTester.exe`, `npm run launcher`) and the hosted version (`server/`): sign-in, Automation, Logs / History, dialogs |
| Out of scope | What the automation does (the Playwright flows), the server's APIs, the staging site. No feature is removed. |

---

## 1. Why redesign

The page works, but it looks generated rather than designed. This is not about taste. The same few
decorative moves are applied to everything, so nothing stands out, and the screen never shows
what matters at that moment.

Measured in today's `launcher/ui.html`:

| What | Today | Target |
|---|---|---|
| Font sizes | 15 (9 to 20 px) | 6 |
| Font weights | 7 (400 to 900) | 2 (400, 600) |
| Corner radii | 9 | 3, plus 1 for dialogs |
| Rounded "pill" styles | 7 | 1 (count badge) |
| Rules with a shadow | 12 | 3 (overlays only) |
| Card containers in the markup | 24 | 0 at rest on the Run page |
| Hint and helper texts | 12 | 4 at most, only where people make mistakes |

### 1.1 Diagnosis: what makes it read as AI-generated

1. **Everything is a card.**
   - Each section is a white box with a border, a shadow and 10 px rounded corners, under the same header: number, title, and a grey hint on the right.
   - Up to eleven equal boxes means eleven equal priorities, so the eye has nowhere to land.
   - Cards sit inside cards: result card, then error box, then a code block. A history row opens another bordered panel.
2. **A wizard that isn't a wizard.**
   - Teal number badges 1 to 6 suggest a sequence, but it is one screen of choices.
   - Step 2 only exists on the server, and step 6 ("Run") sits in the other column.
   - The numbers add noise and a false order.
3. **Pills and tinted blocks everywhere.**
   - Seven rounded pill styles: environment, status, counts, "Fastest", presets, flow steps and live tabs.
   - A selected option gets a coloured border, an inner shadow and a tinted fill at the same time.
   - When everything is emphasised, nothing is.
4. **Icon in a circle.**
   - The status banner, the result head and the dialogs all use a coloured disc with a white glyph, the most recognisable template motif.
   - On top of that there are icons before tabs, options, account chips and most buttons (18 icon uses).
5. **The interface explains itself instead of working.**
   - A hint sits next to every heading: "What should run?", "Before running", "Saved as launcher-log.txt with each run".
   - A sentence sits under most fields, and a 45-word privacy paragraph under the accounts.
   - The copy reads like a specification.
6. **Diagnostics shown as content.**
   - The Run card lists 11 green ticks ("Test project found", "Node.js installed", "All quantities > 0") when nothing is wrong.
   - At rest, the status appears four times: header pill "Ready", banner title "Ready", "Status: Ready", and the last-run line.
7. **The important thing is in the wrong place.**
   - During a run, the locked form keeps the wide column.
   - The live browser, the current step and the result are stacked in a 370 px side column that scrolls.
   - After a run, the result sits below the status and live-browser cards.
8. **Generic SaaS chrome.**
   - A teal and red gradient stripe, soft shadows on everything, and uppercase letter-spaced micro-labels.
   - Five weights from 600 to 800 compete for headings.

---

## 2. Goals, non-goals, measures

**Goals**
- **G1:** One clear focus at each moment: composing, running, reviewing.
- **G2:** A new order can be composed and placed without scrolling at 1366 × 768. A repeat order takes one shortcut and one confirmation.
- **G3:** The state of a run is recognisable in under a second: from the page, the browser tab, the title bar and the history.
- **G4:** It looks like a deliberately designed internal Watsons tool: calm, dense, precise.
- **G5:** WCAG 2.2 AA in light and dark.
- **G6:** Approving someone else's order is a first-class flow, not a detail inside a history row.

**Non-goals**
- Changing what the automation does.
- Adding a framework or a build step.
- Marketing polish: illustrations, gradients, decorative animation.
- A phone layout. 900 px is the narrowest supported width; below that the page degrades but still works.

**Measures**

| Measure | Today | Target | How we check |
|---|---|---|---|
| Compose a 10-PLU order at 1366 × 768 without scrolling | No: Delivery and Timing are below the fold, and Run is in the other column | Yes | Screenshot at 1366 × 768 in the Edge app window |
| Re-run the last order from the keyboard | Not possible | Ctrl+Enter, then Enter | Manual |
| Find a run by order number in History | Click the search box, type, scan wide rows | `/`, type, the first row is it | Hallway test |
| Style inventory (section 1 table) | See table | Targets met | `grep` over the stylesheet, as in section 1 |
| Accessibility | Not audited | 0 serious or critical axe findings; every flow possible by keyboard | axe-core run plus a keyboard pass |
| First-use success | Not tested | 3 colleagues do 5 tasks without asking | Hallway test (section 14, phase 5) |

---

## 3. Users and their jobs

| Who | Comes to | How often | Needs first |
|---|---|---|---|
| **Tester** (a colleague; may have no backoffice account) | Place a staging order with given PLUs | Several times a day | Paste PLUs, pick delivery, place, get the order number |
| **Approver** (Willy, anyone with a backoffice account) | Approve orders others placed; approve a known order number | Daily | What is waiting, and a one-click approve |
| **Investigator** (developer or QA after a failure) | Understand why a run failed | Weekly | The failed step in plain words, the screenshot, a copyable report |
| **Admin** (Willy) | Check who is running what on the VM | Occasionally | Who is running, what is queued |

These moments set the priority of the layout, from most to least frequent:

1. Compose and place.
2. Watch and step in.
3. Read the result. This is the emotional peak of every run.
4. Approve waiting orders.
5. Investigate the history.

---

## 4. Design principles

Each principle comes with the rule it sets for this product.

**P1. One focus per state.** *(Progressive disclosure; Hick's law)*
The Run page has three states: Compose, Running and Result. The layout changes with the state
instead of showing everything all the time.

**P2. Hierarchy from type and space, not boxes.** *(Gestalt: proximity, common region)*
- Sections are separated by 32 px of space and a 1 px rule.
- A border or background only surrounds something you act on as one unit: a field, a table, the live browser, a dialog.

**P3. Colour means state.**
- One accent, Watsons teal, for the primary action, focus, selection and links.
- Green, amber and red only mean status, mostly as an 8 px dot next to a word.
- A tinted background is reserved for the one thing that needs attention now: a blocking problem, or the result header.

**P4. Say it once, say it short.**
- Labels are 3 words at most.
- Helper text appears only where people actually make mistakes (the PLU format).
- Explanations move behind a "?" or into the docs.
- Never repeat what a control already shows.

**P5. Defaults and memory over input.** *(Tesler's law; recognition over recall)*
- Start from the last run, and remember per person.
- Prefill approvals from the queue.
- Show the consequence of a choice where it is made, e.g. "No backoffice account. The order will wait for approval."

**P6. Visible status, one vocabulary.** *(Nielsen heuristic 1; Doherty threshold)*
- One status model (section 8.2) is used in the top bar, the page, the history, the window title and the favicon.
- Every action responds within 100 ms. Anything slower than 1 s shows progress.

**P7. Friction where it protects, speed everywhere else.**
- Placing a staging order and approving an order keep a confirmation, and it summarises exactly what will happen.
- Reversible actions get no dialog: forgetting an account, filtering, closing a drawer. Instead they offer Undo.

**P8. Design with real data, at real sizes.**
Check every state against:
- 40 PLUs and 60-character product names;
- 300-character errors and slow staging (minutes per step);
- 500 history rows;
- a 1366 × 768 laptop in the Edge app window;
- dark mode.

**P9. The end of the run is the product.** *(Peak–end rule)*
The result gets the most care:
- the order number large and copyable;
- the outcome in one sentence;
- the next action obvious.

**P10. Keyboard-first for repeat users.** *(Fitts's law for the pointer, shortcuts for the rest)*
The primary action is always in the same place, at the bottom of the composer and sticky.
Ctrl+Enter triggers it.

---

## 5. Information architecture

**Top bar:** Watsons Automation · **Run** · **Approvals** (count) · **History**. On the right sit the
environment badge, the live-run indicator and the user menu:
- hosted version: Accounts, Sign out;
- desktop: operator name, Open reports folder.

Where today's elements go:

| Today | New home |
|---|---|
| "Automation" tab | **Run** |
| "Logs / History" tab | **History** (each run keeps its log inside it) |
| "Awaiting approval" rows inside History | Also **Approvals**, with a count in the top bar (hosted; desktop: see Q1) |
| Step 1 option cards (Place new order / Approve existing order) | A two-way switch at the top of the composer: New order / Approve order |
| Environment and Accounts facts under step 1 | Environment badge in the top bar (host name in its tooltip); accounts summary row in the composer |
| Step 2 "Your accounts" (hosted) | **Accounts** panel from the user menu, plus one summary row in the composer with "Change" |
| Steps 3 to 5 (Products, Delivery, Timing) | Composer sections: Products, Delivery, and Advanced (seconds between adds) |
| Step 6 "Run" checklist | Inline validation at each field, plus the action bar. Setup problems (project, Node.js, staging address) appear in a page banner only when one fails. |
| "Current status" card | Live-run indicator in the top bar; header of the Running state |
| "Live browser" card | Main area of the Running state |
| Result card | The Result state |
| "Progress" card | Step timeline (Running and Result) |
| "Log" card | Log tail under the live browser; full log in the result's evidence |
| "Also on the server now" | Right rail: "On the server now" |
| "Last run" line | Right rail: "Last run" |
| Inline row expansion in History | A side drawer (master–detail) |

---

## 6. Screens

The wireframes show structure and priority, not final styling.

### 6.1 App shell

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ◼ Watsons Automation   Run   Approvals 2   History    ● Staging   ◌ Add to bag 2:41  Willy ▾ │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```
- **Top bar:**
  - 48 px high, on the surface colour, with a 1 px bottom border.
  - No shadow and no gradient stripe.
  - The logo mark is 24 px.
- **Navigation:** 14 px / 600, with a 2 px accent underline on the current page.
- **Environment badge "Staging":**
  - A neutral outlined badge with an amber dot.
  - Staging is context, not success, so today's green, which reads as "all good", goes.
  - Its tooltip shows the host.
- **Live-run indicator:**
  - Only shown while a run of yours is going on or queued.
  - Shows the current step and the elapsed time, and links to Run.
- **Window title and favicon follow the state:**
  - "◌ 2:41 Add to bag · Watsons Automation"
  - "✓ Order 07110006 · …"
  - "✕ Failed · …"
  - You can follow a run from another tab or window.

### 6.2 Run: Compose

```
┌──────────────────────────────────────────────────────────────┬───────────────────────────────┐
│  [ New order | Approve order ]                               │  Last run                     │
│                                                              │  ● Awaiting approval          │
│  Products                               3 products · 4 items │  07110006 · 16:16 · Felix     │
│  ┌─────────────────────────────────┬────────────────────────┐│                               │
│  │  1  46700                       │ 46700            ×1    ││  On the server now            │
│  │  2  46465                       │ 46465            ×1    ││  Bob · Add to bag · 2:10      │
│  │  3  46358 2                     │ 46358            ×2    ││                               │
│  │  4  abc     ← not a PLU         │                        ││  Waiting for approval      2  │
│  └─────────────────────────────────┴────────────────────────┘│  07110006   Felix   16:16     │
│  From your last run · Clear                                  │  07110012   Bob     15:02     │
│                                                              │  View all                     │
│  Delivery method   [ Home Delivery | Click & Collect | Shell Station ]                       │
│  Delivery mode     [ Express  Fastest | Standard ]           │                               │
│                                                              │                               │
│  Accounts   Testing  wi•••@y•••.com                          │                               │
│             Backoffice  none: the order will wait for approval   Change                      │
│                                                              │                               │
│  › Advanced   8 s between adds                               │                               │
├──────────────────────────────────────────────────────────────┤                               │
│  3 products · 4 items · Click & Collect · Standard     Place order  Ctrl+Enter               │
└──────────────────────────────────────────────────────────────┴───────────────────────────────┘
```
- **Layout:**
  - The composer is 680 px wide at most.
  - The right rail is 320 px wide from 1200 px; below that it moves under the composer.
  - The composer has no cards.
- **New order | Approve order:** a segmented control replaces the two option cards. The flow descriptions ("Login → products → …") go: the steps appear on their own once the run starts.
- **Products:** one bordered component holding both parts.
  - On the left, a monospace text area with line numbers.
  - On the right, what will be ordered.
  - A line that can't be read is marked in its own row, with the reason ("← not a PLU").
  - The only helper is the placeholder (`10117`, `10321 2`) and "quantity after the PLU" in the header's tooltip.
- **Delivery method and Delivery mode:** segmented controls. "Fastest" is a small muted suffix inside Express. The sentences under each mode go.
- **Accounts:**
  - One row stating each account's consequence.
  - When the testing account is missing, the row becomes an inline form. That is the only time fields show here.
  - Changing accounts otherwise happens in the Accounts panel (6.7).
- **Advanced:**
  - Collapsed by default, and remembers whether it was open.
  - Holds seconds between adds, with presets and the estimate ("≈ 32 s of adding").
- **Action bar:**
  - Sticky at the bottom of the composer.
  - Shows a one-line summary and the only filled accent button on the page: **Place order** (**Approve order** for approvals), with the shortcut shown.
  - When something blocks, the button is disabled and the bar shows the first two problems as links that focus the field ("Line 4: "abc" is not a PLU"), plus "and 3 more".
- **Setup problems:** missing Node.js, project not found, or staging address not set.
  - They appear as one banner above the composer, with the fix.
  - The composer is disabled meanwhile.
  - Nothing shows when everything is fine.

**Approve order variant:**
- **Order number:** a large monospace field with live reading ("→ WTCSG07091012").
- **Who placed it:** when the order is in the history, a line below says so ("Placed by Felix · 14 Oct 16:16 · Awaiting approval"). That keeps the continuation from another user visible.
- **Accounts:** the backoffice account row.
- **Action bar:** "Approve order".

### 6.3 Run: Running

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  Placing order · 3 products · Click & Collect · Standard                      2:41    Stop   │
├──────────────────────────────────────────────────────────────┬───────────────────────────────┤
│  Cart Page │ Backoffice                                      │  Bag                          │
│  /cart                         Watching  ·  Take control     │  ✓ Login               0:14   │
│  ┌────────────────────────────────────────────────────────┐  │  ✓ Empty bag           0:05   │
│  │                                                        │  │  ✓ Product search      0:03   │
│  │           live picture of the run's browser            │  │  ◌ Add to bag          0:41   │
│  │                        (16 : 9)                        │  │  · Cart validation            │
│  │                                                        │  │  · Standard delivery          │
│  └────────────────────────────────────────────────────────┘  │  Order                        │
│  16:12:04  Added PLU 46700 (1/1); bag now 1     Full log ▾   │  · Checkout · Pay · OTP …     │
└──────────────────────────────────────────────────────────────┴───────────────────────────────┘
```
- **Run header:**
  - The task in one line, the elapsed time (tabular figures), and Stop (secondary, danger).
  - During the risky steps (Checkout, Pay, OTP, Approve), Stop asks first in a small popover anchored to it, not a full dialog.
- **Live browser (hosted):**
  - The main area, up to 960 px wide.
  - Above it, a browser-like strip with the tabs and the read-only path of the page shown.
- **Control model:**
  - **Watching** by default: clicks don't pass through, so nobody disturbs a run by accident.
  - **Take control** passes clicks and typing on, shows an accent ring, and says "You're in control · Esc to release".
  - Once the test has passed and the browser is kept open, control is on by default and the strip shows "Closes in 4:12 · Close now".
- **Desktop:** there is no picture, because Edge has its own window. The main area shows the timeline larger, with a short note that the browser is in its own window.
- **Steps timeline:**
  - Vertical, grouped "Bag" and "Order".
  - Done steps show a ✓ and their duration.
  - The current step shows a spinner and a running time.
  - Upcoming steps are muted, and skipped ones are marked "–" with the reason in a tooltip.
- **Log tail:** the last line under the picture; "Full log" expands to 12 lines (monospace, 12 px).
- **Queued (hosted):** "Waiting for a free slot · 2nd in line", with Cancel.

### 6.4 Run: Result

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  ● Awaiting approval                                                                         │
│  07110006   Copy                         Placed 16:18 by Felix · 3 min 12 s · C&C · Standard │
│  Placed without a backoffice account, so it isn't approved yet.                              │
│  [ Approve now ]   New order   Run again   Evidence ▾                                        │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│  Items                                                                                       │
│  46700   Product name that can be quite long …                  ×1   Ordered                 │
│  46465   …                                                      ×1   Ordered                 │
│  46358   …                                                      ×2   Skipped: sold out       │
│                                                                                              │
│  10 of 14 steps · 3:12 · Show steps          Screenshots ▢ ▢ ▢   Download .zip   Report      │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```
- **Result header:** the only tinted block on the page. It holds:
  - the status as a word with its dot;
  - the order number at 28 px monospace, with Copy;
  - one sentence on what happened;
  - one line of facts.
- **The primary action depends on the outcome:**

| Outcome | Primary | Also |
|---|---|---|
| Completed | New order | Run again, Evidence |
| Awaiting approval: you have a backoffice account | Approve now | Copy number, New order |
| Awaiting approval: you don't | Copy order number | "Someone with a backoffice account can approve it in Approvals." |
| Failed | Copy error report | Run again, Open report |
| No change (approval) | New approval | Evidence |
| Stopped or Interrupted | Run again | The warning about what may already have happened, when relevant |

- **Failure block:**
  - A headline in plain words ("Staging didn't show the bag in time").
  - The step, the code in small monospace, and up to 3 likely causes.
  - The failure screenshot as a thumbnail.
  - The technical message collapsed.
- **Items (a receipt):** each PLU, its name, the quantity and what happened to it: Ordered; Skipped: sold out; Left out: not Standard; free gift removed.
- **When it ends:** the result stays until "New order" or an edit to the composer. The composer is then prefilled as before.

### 6.5 Approvals (new)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  Waiting for approval  2                                                                     │
│  Order      Placed by   When          Items   Delivery              Waiting                  │
│  07110006   Felix       Today 16:16   3       C&C · Standard        25 min     [ Approve ]   │
│  07110012   Bob         Today 15:02   1       Home · Express        1 h 39 min [ Approve ]   │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```
- **Source:** history runs with status "Awaiting approval", from everyone.
- **Approve:**
  - Opens the review dialog (6.7) for that order number, then switches to Run in the Running state.
  - Without a backoffice account it reads "Add backoffice account" and opens the Accounts panel.
- **Empty state:** "Nothing is waiting for approval."
- **Count:** shown in the top bar, so approvers see waiting orders without opening History.

### 6.6 History

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  History                    [ Search order, PLU, error, person   / ]   Task ▾   Export CSV   │
│  All 128 · Mine 41 · Failed 7 · Awaiting approval 2                                          │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│  Status               When          Task        Order      Delivery          Items  By  Time │
│  ● Awaiting approval  Today 16:16   New order   07110006   C&C · Standard    3   Felix  3:12 │
│  ● Failed             Today 15:40   New order   —          Home · Express    2   Willy  1:05 │
│    PRODUCT_NOT_FOUND · Product search                                                        │
│  ● Completed          Today 15:02   Approve     07109998   —                 —   Willy  2:40 │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```
- **Saved views:** All · Mine (hosted) · Failed · Awaiting approval, each with its count. They replace the three dropdowns. Task stays a small dropdown.
- **Table:**
  - 36 px rows, 13 px text, a sticky header in sentence case.
  - Order numbers in monospace, copyable on hover; durations right-aligned with tabular figures.
  - A failed row shows its code and step as a second, muted line.
  - Thumbnails move into the drawer.
- **Drawer:**
  - A row opens a 480 px side drawer with the same layout as the Result (6.4), including Approve and Run again ("Run again" prefills the composer).
  - The table stays visible. ↑ and ↓ move between runs, and Esc closes.
- **Shareable links (hosted):** `#/history?view=failed&q=0711` and `#/runs/<run id>`, so a failure can be linked in Teams.
- **More rows:** "Load 100 more" up to the 500 kept.

### 6.7 Dialogs, toasts, sign-in, accounts

- **Review dialog** (place an order, approve an order):
  - The title asks the question: "Place a staging order?"
  - The body lists exactly what will happen: products (3, 4 items), delivery method, delivery mode, testing account, and approval (an account, or "none: waits for approval").
  - The buttons are Cancel and **Place order**.
  - Focus starts on the primary button, so Ctrl+Enter then Enter places the order. Two deliberate key presses are the safety.
- **Toasts:**
  - Bottom centre, one line, gone after 4 s, with Undo where it applies.
  - Never used for errors that need action; those stay inline.
- **"Copied":** appears in place for 1.5 s, without a toast.
- **Sign-in (hosted):**
  - A plain 360 px form with the logo mark and product name.
  - No shadowed card.
  - Errors appear under the fields.
  - After a timeout it says why: "Signed out after 2 hours idle".
- **Accounts panel (hosted, from the user menu):**
  - A side drawer with Testing and Backoffice.
  - Each shows its masked value, Remember, Change and Forget.
  - Forget is immediate, with Undo.
  - The privacy text becomes one line ("Encrypted with your portal password. Only you can use it.") plus a link to the details in `docs/server-deployment.md`.

---

## 7. Visual system

### 7.1 Typography

- **UI font:** `"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`. It is native to Windows 11, so nothing is downloaded. That is required: the exe works offline, and the hosted page's CSP allows no external fonts.
- **Monospace:** `"Cascadia Mono", Consolas, ui-monospace, monospace`, for PLUs, order numbers, codes, logs and times.

| Role | Size / line height | Weight | Used for |
|---|---|---|---|
| Display | 28 / 36 | 600, monospace | The order number in a result |
| Title | 20 / 28 | 600 | Page titles; the result status |
| Heading | 16 / 24 | 600 | Section titles (Products, Delivery) |
| Body | 14 / 20 | 400 | Default text and controls |
| Small | 13 / 18 | 400 | Tables, secondary text; the log at 12 / 18 monospace |
| Caption | 12 / 16 | 400 | Meta, timestamps, the few hints |

Rules:
- Two weights only.
- Sentence case everywhere, with no uppercase letter-spaced labels.
- `font-variant-numeric: tabular-nums` for times, counts, durations and order numbers.
- Prose no wider than 72 characters.
- Nothing smaller than 12 px.

### 7.2 Colour

All ratios below were computed against the surface colours listed (WCAG 2 formula).

| Token | Light | Dark | Role | Contrast, light / dark |
|---|---|---|---|---|
| `canvas` | `#f6f7f8` | `#0f1214` | Page background | |
| `surface` | `#ffffff` | `#161a1d` | Panels, top bar, inputs | |
| `surface-sunken` | `#f1f3f4` | `#1c2125` | Table header, code, log | |
| `border` | `#e2e5e8` | `#272d32` | Dividers, hairlines | Decorative |
| `border-control` | `#8c949c` | `#646d75` | Input and segment outlines | 3.07 / 3.32 (non-text ≥ 3) |
| `text` | `#15191d` | `#e7eaed` | Primary text | 17.67 / 14.50 |
| `text-2` | `#4b5560` | `#a6afb8` | Secondary text | 7.59 / 7.87 |
| `text-3` | `#69727c` | `#86909a` | Meta, placeholders | 4.89 / 5.39 |
| `accent` | `#00787a` | `#2fb3b0` | Primary button, focus, selection, links, running | 5.29 / 6.83 |
| `on-accent` | `#ffffff` | `#031b1b` | Text on the accent | 5.29 / 6.97 |
| `success` | `#18794e` | `#49c08a` | Completed | 5.41 / 7.66 |
| `warning` | `#8f5500` | `#e2a53c` | Awaiting approval, stopped, staging dot | 6.06 / 8.07 |
| `danger` | `#c2312b` | `#f26b62` | Failed, destructive actions | 5.57 / 5.88 |

Usage rules:
- **Accent budget:** at rest, the page has exactly one filled accent element, its primary button. Selection uses a 2 px accent marker or outline, not a fill.
- **Status colour:** a dot plus a word in tables, timelines and badges. Tinted backgrounds (the status colour at about 8 % over the surface) are allowed only for the result header, a blocking banner and the selected history row.
- **Watsons red:** only inside the logo. Next to "Failed" it would read as an error.
- **Gradients and coloured shadows:** none.

### 7.3 Space, shape, depth

- **Spacing scale (px):** 4, 8, 12, 16, 24, 32, 48.
  - Label to field: 8.
  - Between fields: 16.
  - Between sections: 32, with a 1 px rule.
  - Page gutter: 24.
- **Control heights:** 32 px by default; 28 px in tables and toolbars; 40 px for the action-bar button.
- **Radii:**
  - 4 px for badges and key hints;
  - 6 px for controls;
  - 8 px for panels, the live browser and thumbnails;
  - 12 px for dialogs only.
- **Elevation:** in-page elements have none and are separated by space and borders.
  - Popover and toast: `0 8px 24px rgb(0 0 0 / .12)` plus a 1 px border.
  - Dialog and drawer: `0 16px 48px rgb(0 0 0 / .18)`.

### 7.4 Icons

- **Set:** one 16 px outline set, inline SVG, 1.5 px stroke, `currentColor`.
- **Use for:** timeline glyphs, toolbar actions (refresh, export, copy, download), chevrons and the run indicator.
- **Don't use for:** navigation, section titles, option labels or account rows.
- **Budget:** at most 8 icons visible in the Compose state.

### 7.5 Motion

- **Timings:**
  - Hover and press: 100 ms (colour only).
  - Selection: 160 ms.
  - Drawer and dialog: 200 ms in, 150 ms out.
  - Easing: `cubic-bezier(.2, 0, 0, 1)`.
- **Looping:** only the current step's spinner and the live picture move by themselves. No pulsing dots, nothing bouncing.
- **Reduced motion:** `prefers-reduced-motion` turns animations off, as it does today.

### 7.6 Dark mode

- **Theme:** follows Windows (`prefers-color-scheme`), as today. The tokens are the same, so there is no separate design.
- **Darkest colour:** `canvas`. Pure black is never used.
- **Screenshots and the live picture:** they get a 1 px border, so a white shop page doesn't glare against the dark page.

---

## 8. Components and status model

### 8.1 Components

| Component | Replaces | Notes and states |
|---|---|---|
| Button | `.btn`, `.btn.big`, `.chip` | Primary, secondary, ghost, danger; 28, 32 and 40 px. Default, hover, active, focus, disabled, loading (spinner keeps the width). |
| Segmented control | `.option` cards, `.choice` pills | Radio group semantics; arrow keys move; selection = surface plus accent outline |
| Text field, text area with gutter | `.input`, `textarea`, products preview | Line numbers and inline issues in the gutter; error linked by `aria-describedby` |
| Number field with presets | `.input-suffix`, `.presets` | Presets are ghost buttons (5, 10, 20, 30 s), not pills |
| Status badge | `.pill[data-state]`, `.env`, `.tag` | Dot plus word, 4 px radius, never a filled pill |
| Timeline | `ol.steps`, `.step-groups` | Done, current, upcoming, skipped, failed; duration column |
| Data table | `table.history`, `.preview` | Dense 36 px rows (28 px compact); sticky header; row selection |
| Drawer | Inline `.detail` row | Non-modal, 480 px, Esc closes, focus returns to the row |
| Dialog | `dialog .dialog` | Review only; no icon disc; title asks the question |
| Toast | `.toast` | One line, Undo, 4 s |
| Banner | `.callout`, `.banner` | Page-level and blocking only; one at a time |
| Copyable value | Order number displays | Value plus Copy; "Copied" in place |
| Live frame | `.live-*` | Tab strip, path, Watching / Take control, countdown when holding |
| Empty state | `.empty`, `.preview-empty` | One sentence and, if useful, one action; no illustration |

### 8.2 Status model

One vocabulary everywhere. The words match today's `STATUSES`, so history and exports stay
the same.

| State | Label | Dot | Title-bar glyph | Notes |
|---|---|---|---|---|
| Queued | Waiting | `text-3` | ○ | Hosted, with a position in line |
| Running | Running | `accent`, spinning | ◌ | The current step is shown with it |
| Holding | Browser open | `accent` | ◌ | Passed; browser kept open; countdown |
| Completed | Completed | `success` | ✓ | |
| Awaiting approval | Awaiting approval | `warning` | ◐ | Links to Approvals |
| No change | No change | `text-3` | – | Approval of an already extracted order |
| Failed | Failed | `danger` | ✕ | |
| Stopped | Stopped | `warning` | ■ | |
| Interrupted | Interrupted | `warning` | ! | |

---

## 9. Content and microcopy

**Voice:** plain, specific and calm. Numbers over words, no exclamation marks, no filler ("simply",
"just", "successfully").

Rules:
- **Buttons:** a verb plus the object: "Place order", "Approve order", "Copy order number".
- **Labels:** nouns of 3 words at most, in sentence case.
- **Messages:** what happened, why (if known), what to do, in that order and in at most two sentences. Codes and stack traces go behind "Details".
- **Order numbers:** shown as the 8 digits (`07110006`). The backoffice code (`WTCSG07110006`) appears only where you type or read it for the backoffice.
- **Dates:** "Today 16:16", "Yesterday 09:02", or "14 Oct 16:16". The full timestamp is in the tooltip.

Before and after, from today's page:

| Today | Proposed |
|---|---|
| "Place new order" + "Login → products → Express checkout → payment → approve in Backoffice. Creates a STAGING test order." | Segment "New order" (the steps show once the run starts) |
| Card hints "What should run?", "Before running", "Saved as launcher-log.txt with each run" | Removed |
| "Run order test" | "Place order" |
| "Approve in Backoffice" (the Run button) | "Approve order" |
| Checklist "✓ At least one product configured", "✓ All PLUs valid format", … | Nothing when fine; "Add at least one PLU." or "Line 4: "abc" is not a PLU." when not |
| Banner "Ready" + "Status: Ready" | Nothing at rest |
| "Used only for your runs, and never shown to anyone else or written in a report or log. With Remember ticked, the server keeps it for your next sign-in, locked with your portal password, so only your sign-in can open it. Forget removes it." | "Encrypted with your portal password. Only you can use it." + "How it's stored" |
| "No backoffice account: the order will wait for approval" | Kept; it states a consequence, which is good copy |
| "Clicks, scrolling and typing here go to the real browser. While the test runs, they can disturb it." | "Take control", with the tooltip "Your clicks go to the run's browser and can disturb it." |
| "Found 0 Standard (delivery options without "Fastest") options; expected exactly one." | Headline: "Standard delivery wasn't offered on the checkout page." The original message moves under "Details". |

---

## 10. Accessibility (WCAG 2.2 AA)

- **Contrast:** text and controls meet the ratios in 7.2. The focus ring is a 2 px accent ring with a 2 px offset, on every interactive element.
- **Keyboard:**

| Keys | Does |
|---|---|
| Ctrl+Enter | Place order / Approve order (from anywhere in the composer) |
| `/` | Focus the History search |
| ↑ ↓, Enter | Move between history rows; open the drawer |
| Esc | Close the drawer or dialog; release control of the live browser |
| Alt+1, 2, 3 | Run, Approvals, History |

- **Focus:**
  - Dialogs move focus in and return it to the button that opened them.
  - The drawer is non-modal: it doesn't trap focus, and Esc returns focus to the row.
- **Live regions:**
  - Step changes and results are announced politely ("Completed. Order 07110006.").
  - Failures are announced assertively.
- **Never colour alone:** every status has a word, and every timeline state has a glyph.
- **Target size:** 24 × 24 px at least (2.5.8); segments are 32 px high.
- **Zoom:** at 200 % in a 1366 px window, nothing needs horizontal scrolling except the history table, inside its own container.
- **Live browser:**
  - `role="application"` with a label.
  - Watching or controlling is stated in text.
  - Esc always releases control.
- **Forms:**
  - Every field has a programmatic label.
  - An error in the action bar is a link that focuses its field.

---

## 11. Layout and window sizes

| Width | Run page | History |
|---|---|---|
| ≥ 1440 px | Composer 680 px + rail 320 px; Running: browser + 320 px timeline | Table + 480 px drawer side by side |
| 1200 to 1439 px | Composer + 280 px rail | Drawer overlays the right part of the table |
| 900 to 1199 px | Rail moves under the composer; timeline under the browser | Drawer full height, 420 px |
| < 900 px | One column; supported, not optimised | Table scrolls horizontally |

**Budget at 1366 × 768:**
- The Edge app window leaves about 690 px of height.
- The top bar takes 48 px, the composer content up to 560 px, and the action bar 64 px.
- The products area shows 8 lines and grows to 16 before it scrolls.

---

## 12. Behaviour details

- **Prefill and drafts:**
  - The composer starts from the last run, as today. "Clear" empties it.
  - Unsent edits survive a reload: in `localStorage` on the desktop, and in the existing per-person preferences on the hosted version.
- **Optimistic start:** Place order switches to Running at once ("Starting…"), or to Queued with the position.
- **Holding:** after a pass, the browser is kept open, and the header counts down "Closes in 4:12" with "Close now". This is today's Close browser.
- **Background notice (hosted, opt-in):** a browser notification when your run ends while the tab is in the background. The title and favicon change in every case.
- **History updates:** new rows slide in without moving the selected row or the drawer.
- **Undo instead of confirm:** forgetting an account, and clearing the products.

---

## 13. Technical constraints

- **One self-contained file.** `launcher/ui.html` stays a single file:
  - it is embedded in `WatsonsTester.exe`;
  - the hosted server serves it under a strict CSP;
  - so no external fonts, scripts or images, and no build step;
  - vanilla JavaScript and inline SVG.
- **CSS structure:**
  - `@layer reset, tokens, base, components, states, utilities;`
  - tokens as custom properties for both themes;
  - component selectors wrapped in `:where()` to keep specificity flat;
  - no `!important`, except `[hidden]`.
- **Unchanged contracts:**
  - the page state from `launcher.cjs` and the server;
  - the server-sent events: `line`, `started`, `finished`, `live`, `frame`, `history`;
  - the API routes.
  - Both modes keep one markup, switched by `data-mode="server"`.
- **Test contract.** `tests/launcher.spec.ts` and `tests/server.spec.ts` drive the page by accessible name and id. For example:
  - labels "Place new order", "Approve existing order", "One PLU per line", "Order number", "Home Delivery", "Click & Collect", "Seconds between adds";
  - `#run`, `#stop`, `#confirm` and its "Run test" / "Approve in Backoffice" / "Cancel" buttons;
  - `#result .verdict`, `#result .order-number`, `#steps li.done|.skipped`;
  - `tr.hrow`, `tr.hdetail`, `#history-search`;
  - `#live-img`, `#live-close`, `.check-optional`, `.check-bad`.

  Keep ids as hooks where you can. Where a name changes on purpose ("Run order test" → "Place order"), update the tests in the same commit. A phase is done only when all offline tests pass.
- **Performance:**
  - first paint under 200 ms locally;
  - the live picture renders in a fixed-ratio box, so the layout never shifts;
  - 500 history rows render in under 50 ms.

---

## 14. Delivery plan

Each phase ships on its own. Before it ships:
- all tests pass;
- screenshots in light and dark at 1366 × 768 and 1920 × 1080 go with the commit.

| Phase | Scope | Done when |
|---|---|---|
| 1. Foundations | Tokens, type scale, colour, radii, buttons, inputs, badges. Remove shadows, the gradient stripe, number badges, icon discs and uppercase labels. Layout unchanged. | The section 1 targets are met; contrast as in 7.2; tests unchanged and passing |
| 2. Run page states | Compose / Running / Result; action bar; inline validation instead of the checklist; accounts summary row; review dialog | G2 is met at 1366 × 768; Ctrl+Enter works; tests updated |
| 3. Run console | Live browser as the main area, Watching / Take control, timeline with durations, holding countdown, title and favicon status | A run can be followed and stopped by keyboard only; no layout shift while frames arrive |
| 4. History and Approvals | Saved views, dense table, drawer, shareable links; Approvals page and count | An order waiting for approval can be approved from Approvals in 2 clicks plus a confirmation |
| 5. Polish and audit | Shortcuts, background notice, empty / loading / error states, axe audit, hallway test with 3 colleagues | 0 serious axe findings; 3 of 3 colleagues complete the 5 tasks unaided |

---

## 15. Definition of done: "doesn't look generated"

A checklist for every phase review:

- [ ] At rest, the Run page has exactly one filled accent element: the primary button.
- [ ] No element has a border, a shadow and a tinted background at once.
- [ ] No numbered step badges and no icon-in-a-circle.
- [ ] The stylesheet uses at most 6 font sizes, 2 weights and 3 radii (plus dialogs).
- [ ] No uppercase letter-spaced text.
- [ ] Each helper text exists because people made that mistake or asked that question.
- [ ] Each view states its status once (the top-bar run indicator aside).
- [ ] Each state was checked with real data: 40 PLUs, a 300-character error, a 60-character product name, 500 history rows, dark mode.
- [ ] Squint test: with the screenshot blurred, the one thing that matters in that state is still the most visible.
- [ ] Nothing moves on its own except the current step's spinner and the live picture.

---

## 16. Open questions for Willy

1. **Approvals on the desktop:** show orders waiting for approval from the local history, or hide the page there?
2. **Theme:** keep following Windows (light or dark), or always light?
3. **Brand line:** keep a thin Watsons brand line in the top bar, or only the logo mark?
4. **Take control:** during a run, require it before clicks pass through (proposed), or just warn?
5. **Screens:** do colleagues mostly work on 1366 × 768 laptops or larger screens? This decides how dense the defaults are.
6. **Notifications:** do you want a browser notification when a hosted run ends?

---

## Appendix: references

- Jakob Nielsen, *10 usability heuristics for user interface design*.
- Jon Yablonski, *Laws of UX*: Hick, Fitts, Tesler, Doherty, peak–end, Jakob.
- W3C, *Web Content Accessibility Guidelines 2.2*.
- Adam Wathan and Steve Schoger, *Refactoring UI*: hierarchy, spacing and colour in practice.
- Microsoft *Fluent 2*: Segoe UI Variable, density, Windows conventions.
- GitHub Primer and Linear: dense tool interfaces with one accent.
- Radix Colors: step-based neutral scales.
