# WatsonsTester: UI/UX redesign PRD

| | |
|---|---|
| Status | Draft 2 for review. Revised 2026-10-15 after reviewing an alternative brief and mockup (decisions in section 18). |
| Owner | Willy |
| Scope | `launcher/ui.html`, the one page used by both the desktop launcher (`WatsonsTester.exe`, `npm run launcher`) and the hosted version (`server/`): sign-in, Automation, Logs / History, dialogs |
| Kind of change | A UI redesign, not a rewrite. Everything the app does today keeps working the same way (section 4). Ideas that would change behaviour are parked in section 15 and need a yes first. |
| North star | Clarity, consistency, maintainability and efficient daily use, over visual novelty. |

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
| Card containers in the markup | 24 | 0 at rest on the Automation page |
| Hint and helper texts | 12 | 4 at most, only where people make mistakes |
| Scroll areas at page level | 2 (the page, and the right column on its own) | 1 |

### 1.1 Diagnosis: what makes it read as AI-generated

1. **Everything is a card.**
   - Each section is a white box with a border, a shadow and 10 px rounded corners, under the same header: number, title, and a grey hint on the right.
   - Up to eleven equal boxes means eleven equal priorities, so the eye has nowhere to land.
   - Cards sit inside cards: result card, then error box, then a code block. A history row opens another bordered panel.
2. **A wizard that isn't a wizard.**
   - Teal number badges 1 to 6 suggest a sequence, but it is one screen of choices.
   - Step 2 only exists on the server, and step 6 ("Run") sits in the other column.
3. **Pills and tinted blocks everywhere.**
   - Seven rounded pill styles: environment, status, counts, "Fastest", presets, flow steps and live tabs.
   - A selected option gets a coloured border, an inner shadow and a tinted fill at the same time.
   - When everything is emphasised, nothing is.
4. **Icon in a circle.** The status banner, the result head and the dialogs all use a coloured disc with a white glyph, the most recognisable template motif. On top of that there are icons before tabs, options, account chips and most buttons (18 icon uses).
5. **The interface explains itself instead of working.**
   - A hint sits next to every heading: "What should run?", "Before running", "Saved as launcher-log.txt with each run".
   - A sentence sits under most fields, and a 45-word privacy paragraph under the accounts.
6. **Diagnostics shown as content.**
   - The Run card lists 11 green ticks ("Test project found", "Node.js installed", "All quantities > 0") when nothing is wrong.
   - At rest, the status appears four times: header pill "Ready", banner title "Ready", "Status: Ready", and the last-run line.
7. **The important thing is in the wrong place, with its own scrollbar.**
   - During a run, the locked form keeps the wide column.
   - The live browser, the current step and the result are stacked in a 370 px side column that scrolls separately from the page.
   - After a run, the result sits below the status and live-browser cards.
8. **Generic SaaS chrome.** A teal and red gradient stripe, soft shadows on everything, uppercase letter-spaced micro-labels, and five weights from 600 to 800 competing for headings.

The opposite failure is just as real, and this redesign must not swap one for the other:
- too much empty space;
- tables so dense they are hard to read;
- settings hidden behind summaries to make the page look tidy.

---

## 2. Goals, non-goals, measures

**Goals**
- **G1:** One clear focus at each moment: composing, running, reviewing.
- **G2:** A new order can be composed and placed without scrolling at 1366 × 768, with the place-order button always in the same spot.
- **G3:** The state of a run is recognisable in under a second, and each view states it once.
- **G4:** It looks like a deliberately designed internal Watsons tool: calm, precise, readable all day.
- **G5:** WCAG 2.2 AA in light and dark.
- **G6:** Approving an order someone else placed is quick from Logs / History: a view of what's waiting, a count on the tab, and Approve in the row.

**Non-goals**
- Changing what the automation does, or anything in section 4.
- New features (section 15 lists ideas, each needing a yes).
- A framework or a build step.
- Decoration: illustrations, gradients, glows, dashboards of statistics.
- A phone layout. 900 px is the narrowest supported width; below that the page degrades but still works.

**Measures**

| Measure | Today | Target | How we check |
|---|---|---|---|
| Compose a 10-PLU order at 1366 × 768 without scrolling | No: Delivery and Timing are below the fold, and Run is in the other column | Yes | Screenshot at 1366 × 768 in the Edge app window |
| Scroll areas at page level | 2 | 1 | Manual check in each state |
| Find a run by order number in Logs / History | Search box, then scan wide rows | Type it; the first row is the run | Hallway test |
| Style inventory (section 1 table) | See table | Targets met | `grep` over the stylesheet, as in section 1 |
| Accessibility | Not audited | 0 serious or critical axe findings; every flow possible by keyboard | axe-core run plus a keyboard pass |
| Nothing lost | n/a | Every item in section 4 checked in the new UI | Checklist in the phase review |
| First-use success | Not tested | 3 colleagues do 5 tasks without asking | Hallway test (phase 4) |

---

## 3. Users and their jobs

| Who | Comes to | How often | Needs first |
|---|---|---|---|
| **Tester** (a colleague; may have no backoffice account) | Place a staging order with given PLUs | Several times a day | Paste PLUs, pick delivery, place, get the order number |
| **Approver** (Willy, anyone with a backoffice account) | Approve orders others placed; approve a known order number | Daily | What is waiting, and Approve next to it |
| **Investigator** (developer or QA after a failure) | Understand why a run failed | Weekly | The failed step in plain words, the screenshot, the log before the failure, a copyable report |
| **Admin** (Willy) | Check who is running what on the VM | Occasionally | Who is running, what is queued |

These moments set the priority of the layout, from most to least frequent:

1. Compose and place.
2. Watch and step in.
3. Read the result. This is the emotional peak of every run.
4. Approve waiting orders.
5. Investigate the history.

---

## 4. What must not change

The redesign is checked against this list. Each item must work in the new UI exactly as it does today.

- **Workflows**
  - Place new order: login, products, delivery, checkout, payment, then approval when a backoffice account is set.
  - Approve existing order: never creates an order.
  - Choosing Approve existing order hides the settings that don't apply to it.
- **Settings**
  - Products: PLUs and quantities, in today's text format (`10321 2`).
  - Delivery method: Home Delivery, Click & Collect, Shell Station.
  - Delivery mode: Express, Standard.
  - Seconds between adds: 0 to 120, with presets.
  - Defaults come from your last run.
- **Accounts**
  - Desktop: accounts come from `.env`.
  - Hosted: each person enters their own testing and backoffice accounts. They are shown masked, with Remember, Change and Forget. Forget acts at once and confirms with a toast, as now.
  - The backoffice account is optional for new orders: such orders wait for approval.
- **Validation and safeguards**
  - The same checks and rules (`checkRunRequest`, the setup checks).
  - The confirmation before placing or approving an order.
  - The extra question before stopping during checkout, payment or approval.
- **Safety and access**
  - The STAGING-only lock and its indicator.
  - Hosted: sign-in, sessions and the page key.
- **Running**
  - Live progress and Stop.
  - The live browser (hosted): picture, clicks, typing, scrolling, tabs.
  - The 5-minute hold after a pass, and Close browser.
  - Queueing (hosted).
- **Logs / History**
  - Every piece of information in today's columns.
  - Search; filters by status and workflow; Mine / All (hosted); Export CSV; Reports folder (desktop).
  - Approve in Backoffice from a row, and the "approved later" notes.
  - Error report (copy, download), the screenshot viewer, the Playwright report, and evidence (.zip, or the folder on the desktop).
- **Contracts**
  - The APIs and the server-sent events.
  - The status words in `STATUSES`, which history and exports use.
  - The CSV format and the evidence files.
- **Build**
  - One self-contained `ui.html`, with no mock data.
  - Every screen shows real run data.

---

## 5. Design principles

Each principle comes with the rule it sets for this product.

**P1. One focus per state.** *(Progressive disclosure; Hick's law)*
- The Automation page has three states: Compose, Running and Result.
- During a run the form collapses to a one-line summary, and the run takes the space.
- After the run, "Edit order" brings the form back, filled in as before.

**P2. Hierarchy from type and space, not boxes.** *(Gestalt: proximity, common region)*
- Sections are separated by 32 px of space and a 1 px rule.
- A border or background only surrounds something you act on as one unit: a field, a table, the live browser, a dialog.

**P3. Colour means state.**
- One accent, Watsons teal, for the primary action, focus, selection and links.
- Green, amber and red only mean status, mostly as an 8 px dot next to a word.
- A tinted background is reserved for the one thing that needs attention now: a blocking problem, or the result header.

**P4. Say it once, say it short.**
- Labels are 3 words at most, and there are no page subtitles.
- Helper text appears only where people actually make mistakes (the PLU format).
- Never repeat what a control already shows.

**P5. Defaults and memory over input.** *(Tesler's law; recognition over recall)*
- Start from the last run.
- Show the consequence of a choice where it is made, e.g. "No backoffice account. The order will wait for approval."

**P6. Visible status, one vocabulary.** *(Nielsen heuristic 1; Doherty threshold)*
- One status model (section 10.2) is used on the page, in the header and in the history.
- Every action responds within 100 ms. Anything slower than 1 s shows progress.

**P7. Friction where it protects, speed everywhere else.** *(Error prevention)*
- Placing and approving orders keep their confirmation, and it summarises exactly what will happen.
- Nothing reversible asks first.

**P8. Design with real data, at real sizes.**
Check every state against:
- 40 PLUs;
- 300-character errors and slow staging (minutes per step);
- 500 history rows;
- a 1366 × 768 laptop in the Edge app window;
- dark mode.

**P9. The end of the run is the product.** *(Peak–end rule)*
The result gets the most care:
- the order number large and copyable;
- the outcome in one sentence;
- the next action obvious.

**P10. The primary action never moves.** *(Fitts's law)*
- "Place test order" or "Approve order" sits at the bottom of the form in a sticky bar.
- It is the only filled accent button on screen.

### 5.1 What we borrow, and from whom

| Reference | Borrow | Don't copy |
|---|---|---|
| Retool | Label-and-field forms, structured inputs, plain operational tables | The grey "builder" look |
| Linear | Two type weights, consistent spacing, quiet colour, one accent | The dark-first look, keyboard-only flows |
| GitHub Actions | Run status words, the step list with durations, the failed step opened with its log, "Re-run" | The icon density |

---

## 6. Structure

Two pages, as today, keeping their names: **Automation** and **Logs / History**.
- The Logs / History tab shows a count of orders awaiting approval, only when there are any. That is more useful than today's count of all runs.
- The header also holds the environment badge, the signed-in user and Sign out. On the desktop it holds the operator name instead.

Where today's elements go:

| Today | New home |
|---|---|
| Step 1 option cards (Place new order / Approve existing order) | A segmented control at the top of the form, same names |
| Environment and Accounts facts under step 1 | Environment badge in the header (host name in its tooltip); Accounts rows in the form |
| Step 2 "Your accounts" (hosted) | Two compact Accounts rows in the form; "Change" opens today's fields in place |
| Steps 3 to 5 (Products, Delivery, Timing) | Form sections with no cards: Products, then Delivery (method, mode, seconds between adds) |
| Step 6 "Run" checklist | One line in the action bar ("✓ Ready · 9 checks passed", expandable); failing checks listed with their fix |
| "Current status" card | The Running header; a compact indicator in the page header while a run goes on |
| "Live browser" card | Main area of the Running state |
| Result card, "Progress" card | The Result state, with a step list like GitHub Actions |
| "Log" card | Log line under the live browser; full log in the run's details |
| "Last run", "Also on the server now" | A narrow right column in the Compose state, scrolling with the page |
| "Awaiting approval" rows inside History | A saved view in Logs / History with Approve in the row; the count on the tab; the first few also in the right column |
| Inline row expansion in History | A side panel (master–detail) |

---

## 7. Screens

These are wireframes for structure and priority, not final styling. The high-fidelity designs
come in phase 0 (section 16).

### 7.1 Header

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ◼ Watsons Automation    Automation    Logs / History 2        ● Staging    Willy    Sign out │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Header bar:** 48 px high, on the surface colour, with a 1 px bottom border. No shadow and no gradient stripe. The logo mark is 24 px.
- **Navigation:** 14 px / 600, with a 2 px accent underline under the current page.
- **Environment badge "Staging":**
  - A neutral outlined badge with an amber dot. Staging is context, not success, so today's green, which reads as "all good", goes.
  - Its tooltip shows the host.
- **While a run of yours goes on:** a compact indicator ("◌ Add to bag 2:41") appears before the user name and links to the run.
- **Signed-in user and Sign out:** shown as plain text, not as a menu.

### 7.2 Automation: Place new order

```
┌──────────────────────────────────────────────────────────────┬───────────────────────────────┐
│                                                              │                               │
│  [ Place new order | Approve existing order ]                │  Last run                     │
│                                                              │  ● Awaiting approval          │
│  Products                              3 products · 4 items  │  07110006 · Today 16:16       │
│  ┌──────────────────────────────┬────────────────────────┐   │  Felix · Details              │
│  │ 1  46700                     │ 46700               ×1 │   │                               │
│  │ 2  46465                     │ 46465               ×1 │   │  On the server now            │
│  │ 3  46358 2                   │ 46358               ×2 │   │  Bob · Add to bag · 2:10      │
│  │ 4  abc     ← not a PLU       │                        │   │                               │
│  └──────────────────────────────┴────────────────────────┘   │  Awaiting approval         2  │
│  From your last run · Clear                                  │  07110006  Felix     Approve  │
│                                                              │  07110012  Bob       Approve  │
│  Delivery                                                    │  All in Logs / History        │
│  Method  [ Home Delivery | Click & Collect | Shell Station ] │                               │
│  Mode    [ Express  Fastest | Standard ]                     │                               │
│  Seconds between adds   [ 8 ]   5 · 10 · 20 · 30             │                               │
│                         ≈ 32 s of adding                     │                               │
│                                                              │                               │
│  Accounts                                                    │                               │
│  Testing      wi•••@y•••.com                         Change  │                               │
│  Backoffice   none: order waits for approval         Change  │                               │
│                                                              │                               │
├──────────────────────────────────────────────────────────────┤                               │
│  ✓ Ready · 9 checks passed · Show      [ Place test order ]  │                               │
└──────────────────────────────────────────────────────────────┴───────────────────────────────┘
```

- **Layout:**
  - The form is 680 px wide at most. Next to it, a 300 px column, from 1200 px wide.
  - The column scrolls with the page, never on its own.
  - There are no cards and no page title. The segmented control is the title.
- **Products:** one bordered component holding both parts.
  - On the left, today's text area in monospace with line numbers, so lists can still be pasted.
  - On the right, the parsed rows ("what will be ordered").
  - A line that can't be read is marked in its own row ("← not a PLU").
  - The only helper is the placeholder, and "quantity after the PLU" in the header's tooltip.
- **Delivery:** method and mode as segmented controls; seconds between adds as a short field with the presets as small text buttons and the estimate ("≈ 32 s of adding").
  - Everything stays visible and editable: these change between runs.
  - "Fastest" is a small muted suffix inside Express.
- **Accounts (hosted):**
  - Each row states the account and its consequence.
  - "Change" opens today's fields (user name, password, Remember, Use this account, Cancel) in place of the row.
  - A missing testing account shows its fields straight away.
- **Action bar:**
  - Sticky at the bottom of the form, with the only filled accent button on the page: **Place test order**.
  - On the left, the pre-run checks in one line: "✓ Ready · 9 checks passed". "Show" expands the list.
  - When something blocks, the line names the problems with links that focus the field ("✕ Line 4: "abc" is not a PLU"), and the button is disabled.
  - An optional item (no backoffice account) shows as a note, not a failure.
- **Setup problems** (desktop: Node.js missing, project not found, staging address not set): one banner above the form with the fix. The form is disabled meanwhile.

### 7.3 Automation: Approve existing order

```
┌──────────────────────────────────────────────────────────────┬───────────────────────────────┐
│                                                              │                               │
│  [ Place new order | Approve existing order ]                │  Last run                     │
│                                                              │  ● Awaiting approval          │
│  Order number                                                │  07110006 · Today 16:16       │
│  ┌──────────────────────────────┐                            │  Felix · Details              │
│  │ 07110006                     │   → WTCSG07110006          │                               │
│  └──────────────────────────────┘                            │  On the server now            │
│  Placed by Felix · Today 16:16 · Awaiting approval           │  Bob · Add to bag · 2:10      │
│                                                              │                               │
│  Accounts                                                    │  Awaiting approval         2  │
│  Backoffice   wi•••.support                          Change  │  07110006  Felix     Approve  │
│                                                              │  07110012  Bob       Approve  │
│  Never creates an order. Approve Order is clicked once.      │  All in Logs / History        │
│                                                              │                               │
├──────────────────────────────────────────────────────────────┤                               │
│  ✓ Ready · 3 checks passed · Show         [ Approve order ]  │                               │
└──────────────────────────────────────────────────────────────┴───────────────────────────────┘
```

- **What shows:** only what applies. That is the order number, the backoffice account, and one muted line on what will happen.
- **Order number:** a large monospace field with live reading ("→ WTCSG07110006").
- **Who placed it:** when the order is in the history, a line below says who placed it and its status. That keeps the continuation from another user visible.
- **Action bar:** "Approve order", with its own checks line.

### 7.4 Running

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  Placing test order · 3 products · Click & Collect · Standard                  2:41    Stop  │
├──────────────────────────────────────────────────────────────┬───────────────────────────────┤
│  Cart Page │ Backoffice                                      │  ✓ Login                 0:14 │
│  ┌────────────────────────────────────────────────────────┐  │  ✓ Empty bag             0:05 │
│  │                                                        │  │  ✓ Product search        0:03 │
│  │           live picture of the run's browser            │  │  ◌ Add to bag            0:41 │
│  │                   (fixed 16 : 9 box)                   │  │  · Cart validation            │
│  │                                                        │  │  · Standard delivery          │
│  └────────────────────────────────────────────────────────┘  │  · Checkout · Pay · OTP       │
│  16:12:04  Added PLU 46700 (1/1); bag now 1        Full log  │  · Order confirmation         │
└──────────────────────────────────────────────────────────────┴───────────────────────────────┘
```

- **Run header:**
  - Replaces the form: the task in one line, the elapsed time (tabular figures) and Stop (secondary, danger).
  - During checkout, payment or approval, Stop asks first, as today, but in a styled dialog instead of the browser's plain `confirm()`.
- **Live browser (hosted):**
  - The main area, up to 960 px wide, in a fixed 16:9 box, so frames never shift the layout.
  - The tab strip above it switches tabs, as today.
  - Clicks and typing pass through as they do now. When the picture has focus, an accent ring says so.
  - After a pass, the strip says "Browser kept open · closes by itself after 5 minutes" with **Close browser**.
- **Desktop:** there is no picture, because Edge has its own window. The main area shows the steps larger.
- **Steps:**
  - Done steps show a ✓ and their duration.
  - The current step shows a spinner and a running time.
  - Upcoming steps are muted, and skipped ones are marked "–" with the reason in a tooltip.
  - Durations come from the timestamps of the step lines already in the log (section 14).
- **Log:** the latest log line under the picture. "Full log" expands to 12 lines in a fixed-height box.
- **Queued (hosted):** "Waiting for a free slot · 2nd in line".

### 7.5 Result

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  ● Awaiting approval                                                                         │
│  07110006   Copy                                   Placed Today 16:18 by Felix · 3 min 12 s  │
│  Placed without a backoffice account, so it is not approved yet.                             │
│  [ Approve now ]   New order   Run again   Edit order   Evidence                             │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│  Products                                                                                    │
│  46700       ×1   Ordered                                                                    │
│  46465       ×1   Ordered                                                                    │
│  46358       ×2   Skipped: sold out                                                          │
│                                                                                              │
│  14 steps · 3:12 · Show steps                  Screenshots ▢ ▢    Evidence (.zip)    Report  │
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
| Completed | New order | Run again, Edit order, Evidence |
| Awaiting approval, and you have a backoffice account | Approve now (today's Approve in Backoffice prefill) | Copy order number, New order |
| Awaiting approval, and you don't | Copy order number | "Someone with a backoffice account can approve it from Logs / History." |
| Failed | Copy error report | Run again, Edit order, and the details in 7.6 |
| No change (approval) | New approval | Evidence |
| Stopped, Interrupted | Run again | The warning about what may already have happened, when relevant |

- **Products:** each PLU with its quantity and what happened to it: Ordered; Skipped: sold out; Left out: not Standard.
  - Product names aren't in the run results today, so the rows show PLUs only (section 14).
- **When it ends:** the result stays until New order, Run again or Edit order.

### 7.6 Failed run details

The same layout serves the end of a failed run and the side panel in Logs / History. It is the
investigator's main screen.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  ✕ Failed at Cart validation                                       Today 15:40 · 1 min 05 s  │
│  Place new order · Home Delivery · Express · Willy                                           │
│  [ Copy error report ]   Download error-report.txt   Open report   Evidence (.zip)           │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│  ✓ Login                         0:14                                                        │
│  ✓ Empty bag                     0:05                                                        │
│  ✓ Product search                0:03                                                        │
│  ✓ Add to bag                    0:41                                                        │
│  ✕ Cart validation               0:20                                                        │
│    The bag didn't hold what was added.                                                       │
│    CART_VALIDATION_FAILED · Expected 10031 x1, 10321 x1 but the bag has 10031 x1.            │
│    Likely: an item could not be added · the bag had other items in it                        │
│    ┌────────────────┐                                                                        │
│    │   screenshot   │   Page: /checkoutstepone                                               │
│    └────────────────┘                                                                        │
│    › Log before the failure (12 lines)      › Full message                                   │
│  · Express Delivery Selection, and 7 more: not run                                           │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Header:**
  - The failed step as the title ("✕ Failed at Cart validation").
  - The workflow, delivery, person, time and duration.
  - The evidence actions: Copy error report, Download error-report.txt, Open report, Evidence.
- **Steps:**
  - Every step with its duration.
  - The failed step is opened, like GitHub Actions, and shows:
    - a headline in plain words;
    - the code and the original message;
    - up to 3 likely causes;
    - the failure screenshot (it opens the viewer);
    - the page address;
    - the log lines before the failure.
  - Steps that never ran are muted.
- **Plain-language headlines:**
  - They come from a table in `ui.html` keyed by error code, e.g. `CART_VALIDATION_FAILED` → "The bag didn't hold what was added."
  - An unknown code falls back to the message.
- **Full message:** never cut off here. It wraps, and "Full message" expands it.

### 7.7 Logs / History

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  Logs / History         [ Search order, PLU, error code, person ]   Workflow ▾   Export CSV  │
│  All 128    Mine 41    Failed 7    Awaiting approval 2                                       │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│  Status               Time   Workflow   Order     Delivery        By     Took  ▣             │
│  Today                                                                                       │
│  ● Awaiting approval  16:16  New order  07110006  C&C · Standard  Felix  3:12  1    Approve  │
│  ● Failed             15:40  New order  —         Home · Express  Willy  1:05  1             │
│    CART_VALIDATION_FAILED · Cart validation · Expected 10031 x1, 10321 x1 but the bag…       │
│  ● Completed          15:02  Approval   07109998  —               Willy  2:40  1             │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Views:** All · Mine (hosted) · Failed · Awaiting approval, each with its count.
  - They replace the status dropdown.
  - Workflow stays a small dropdown.
- **Table:** 40 px rows, 13 px text, a sticky header in sentence case.
  - Rows are grouped under day headings (Today, Yesterday, 14 Oct), so each row shows only its time.
  - The workflow shows as "New order" or "Approval".
  - Order numbers in monospace, copyable on hover; durations right-aligned with tabular figures.
  - The ▣ column counts screenshots, and hovering shows the first as a preview.
- **Failed rows:** a muted second line holds the code, the step and the message, cut to one line with "…". The full message is always in the details.
- **Awaiting-approval rows:** they carry **Approve** in the row. It is today's Approve in Backoffice: it fills in Approve existing order with that number.
- **Details:**
  - A row opens a 520 px side panel with the layout of 7.5 or 7.6.
  - The table stays visible behind it. Esc closes it, and focus returns to the row.
- **More rows:** "Load 100 more" up to the 500 kept.

### 7.8 Dialogs, toasts, sign-in

- **Review dialog** (place an order, approve an order):
  - The title asks the question: "Place a staging test order?"
  - The body lists exactly what will happen: products (3, 4 items), delivery method, delivery mode, testing account, and approval (an account, or "none: waits for approval").
  - The buttons are Cancel and the action's own name.
  - No icon disc.
- **Toasts:**
  - Bottom centre, one line, gone after 4 s.
  - Never used for errors that need action; those stay inline.
- **"Copied":** appears in place for 1.5 s.
- **Sign-in (hosted):**
  - A plain 360 px form with the logo mark and product name.
  - No shadowed card.
  - Errors appear under the fields.

---

## 8. Visual direction

| | A. Light operations console | B. Dark operations console |
|---|---|---|
| Fits | Bright offices, all-day use, reading tables and long errors | Long sessions watching runs and logs |
| Screenshots and live picture | The shop's white pages sit naturally on a light page | White pages glare against a dark page and need framing |
| Sharing | Screenshots in Teams look like the shop and docs | Heavier in chat and documents |
| Colour | One teal accent works at full strength | Status colours and teal need separate tuning |
| Risk | Can drift into "bland" without the type and spacing rules | Can drift into "glowy" and low contrast |

**Recommendation: A.** It is the designed default. B comes from the same tokens when Windows is
set to dark, as today, with no separate design (Q2).

---

## 9. Visual system

### 9.1 Typography

- **UI font:** `"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`.
  - It is native to Windows 11 and nothing is downloaded. That is required: the exe works offline, and the hosted page's CSP allows no external fonts.
  - Inter was considered and rejected (D5).
- **Monospace:** `"Cascadia Mono", Consolas, ui-monospace, monospace`, for PLUs, order numbers, codes, logs and times.

| Role | Size / line height | Weight | Used for |
|---|---|---|---|
| Display | 28 / 36 | 600, monospace | The order number in a result |
| Title | 20 / 28 | 600 | Page title (Logs / History); the result status |
| Heading | 16 / 24 | 600 | Section titles (Products, Delivery, Accounts) |
| Body | 14 / 20 | 400 | Default text and controls |
| Small | 13 / 18 | 400 | Tables, secondary text; the log at 12 / 18 monospace |
| Caption | 12 / 16 | 400 | Meta, timestamps, second lines in tables |

Rules:
- Two weights only.
- Sentence case everywhere, with no uppercase letter-spaced labels.
- `font-variant-numeric: tabular-nums` for times, counts, durations and order numbers.
- Prose no wider than 72 characters.
- Nothing smaller than 12 px.

### 9.2 Colour

All ratios below were computed against the surface colours listed (WCAG 2 formula).

| Token | Light | Dark | Role | Contrast, light / dark |
|---|---|---|---|---|
| `canvas` | `#f6f7f8` | `#0f1214` | Page background | |
| `surface` | `#ffffff` | `#161a1d` | Form area, header, inputs, panels | |
| `surface-sunken` | `#f1f3f4` | `#1c2125` | Table header, code, log | |
| `border` | `#e2e5e8` | `#272d32` | Dividers, hairlines | Decorative |
| `border-control` | `#8c949c` | `#646d75` | Input and segment outlines | 3.07 / 3.32 (non-text ≥ 3) |
| `text` | `#15191d` | `#e7eaed` | Primary text | 17.67 / 14.50 |
| `text-2` | `#4b5560` | `#a6afb8` | Secondary text | 7.59 / 7.87 |
| `text-3` | `#636c76` | `#86909a` | Meta, placeholders | 5.33 / 5.39 |
| `accent` | `#00787a` | `#2fb3b0` | Primary button, focus, selection, links, running | 5.29 / 6.83 |
| `on-accent` | `#ffffff` | `#031b1b` | Text on the accent | 5.29 / 6.97 |
| `success` | `#18794e` | `#49c08a` | Completed | 5.41 / 7.66 |
| `warning` | `#8f5500` | `#e2a53c` | Awaiting approval, stopped, staging dot | 6.06 / 8.07 |
| `danger` | `#c2312b` | `#f26b62` | Failed, destructive actions | 5.57 / 5.88 |

Usage rules:
- **Accent budget:** at rest, the page has exactly one filled accent element, its primary button.
  - A selected segment is the surface colour with a 2 px accent outline.
  - Teal borders and fills don't go on every component.
- **Status colour:** a dot plus a word.
  - Tinted backgrounds (the status colour at about 8 % over the surface) are allowed only for the result header, a blocking banner and the selected history row.
- **Watsons red:** only inside the logo. Next to "Failed" it would read as an error.
- **Effects:** no gradients, glass effects, glows or coloured shadows.

### 9.3 Space, shape, depth

- **Spacing scale (px):** 4, 8, 12, 16, 24, 32, 48.
  - Label to field: 8.
  - Between fields: 16.
  - Between sections: 32, with a 1 px rule.
  - Page gutter: 24.
- **Control heights:** 32 px by default; 40 px for the action-bar button. Table rows are 40 px.
- **Radii:**
  - 4 px for badges and key hints;
  - 6 px for controls;
  - 8 px for the live browser, panels and thumbnails;
  - 12 px for dialogs only.
- **Elevation:** in-page elements have none and are separated by space and borders.
  - Toast: `0 8px 24px rgb(0 0 0 / .12)` plus a 1 px border.
  - Dialog and side panel: `0 16px 48px rgb(0 0 0 / .18)`.

### 9.4 Icons

- **Set:** one 16 px outline set, inline SVG, 1.5 px stroke, `currentColor`.
- **Use for:** status glyphs in step lists, toolbar actions (refresh, export, copy, download), chevrons and the run indicator.
- **Don't use for:** navigation, section titles, option labels, account rows, or the primary button.
- **Emoji:** never, in any control.
- **Budget:** at most 8 icons visible in the Compose state.

### 9.5 Motion

- **Timings:**
  - Hover and press: 100 ms (colour only).
  - Selection: 160 ms.
  - Side panel and dialog: 200 ms in, 150 ms out.
  - Easing: `cubic-bezier(.2, 0, 0, 1)`.
- **Looping:** only the current step's spinner and the live picture move by themselves. No pulsing dots, nothing bouncing.
- **Reduced motion:** `prefers-reduced-motion` turns animations off, as it does today.

### 9.6 Dark mode

- **Theme:** follows Windows, as today. The tokens are the same, so there is no separate design.
- **Darkest colour:** `canvas`. Pure black is never used.
- **Screenshots and the live picture:** they get a 1 px border, so a white shop page doesn't glare against the dark page.

---

## 10. Components and status model

### 10.1 Components

| Component | Replaces | Notes and states |
|---|---|---|
| Button | `.btn`, `.btn.big`, `.chip` | Primary, secondary, ghost, danger; 32 and 40 px. Default, hover, active, focus, disabled, loading (spinner keeps the width). |
| Segmented control | `.option` cards, `.choice` pills | Radio group semantics, arrow keys move; selection is the surface colour plus an accent outline |
| Text area with gutter | `textarea`, products preview | Line numbers and inline issues; error linked by `aria-describedby` |
| Number field with presets | `.input-suffix`, `.presets` | Presets are text buttons (5 · 10 · 20 · 30), not pills |
| Status badge | `.pill[data-state]`, `.env`, `.tag` | Dot plus word, 4 px radius, never a filled pill |
| Checks line | `.checklist` | One line with a count; expands to the list; failing items first, each linking to its field |
| Step list | `ol.steps`, `.step-groups` | Done, current, upcoming, skipped, failed; durations; the failed step opened |
| Data table | `table.history` | 40 px rows, sticky header, row selection, second line for failures |
| Side panel | Inline `.detail` row | Non-modal, 520 px, Esc closes, focus returns to the row |
| Dialog | `dialog .dialog` | Review and Stop questions only; no icon disc; title asks the question |
| Toast | `.toast` | One line, 4 s |
| Banner | `.callout`, `.banner` | Page-level and blocking only; one at a time |
| Copyable value | Order number displays | Value plus Copy; "Copied" in place |
| Live frame | `.live-*` | Tab strip, fixed 16:9 box, focus ring, kept-open note with Close browser |
| Empty state | `.empty`, `.preview-empty` | One sentence and, if useful, one action; no illustration |

### 10.2 Status model

One vocabulary everywhere, using today's words from `STATUSES`. "Success" in other proposals is
"Completed" here, because history, exports and tests use that word.

| State | Label | Dot | Notes |
|---|---|---|---|
| (form) Ready | Ready · N checks passed | `success` ✓ | Not a run status: the action bar's line |
| Queued | Waiting | `text-3` | Hosted, with the position in line |
| Running | Running | `accent`, spinning | The current step is shown with it |
| Holding | Browser kept open | `accent` | Passed; Close browser |
| Completed | Completed | `success` | |
| Awaiting approval | Awaiting approval | `warning` | Approve in the row (Logs / History) |
| No change | No change | `text-3` | Approval of an already extracted order |
| Failed | Failed | `danger` | |
| Stopped | Stopped | `warning` | |
| Interrupted | Interrupted | `warning` | |

---

## 11. Content and microcopy

**Voice:** plain, specific and calm. Numbers over words, no exclamation marks, no filler ("simply",
"just", "successfully").

Rules:
- **Buttons:** a verb plus the object: "Place test order", "Approve order", "Copy order number".
- **Labels:** nouns of 3 words at most, in sentence case, with no page subtitles.
- **Messages:** what happened, why (if known), what to do, in that order and in at most two sentences. Codes and stack traces go behind "Full message".
- **Order numbers:** shown as the 8 digits (`07110006`). The backoffice code (`WTCSG07110006`) appears only where you type or read it for the backoffice.
- **Dates:** "Today 16:16", "Yesterday 09:02", or "14 Oct 16:16". The full timestamp is in the tooltip.

Before and after, from today's page and from the alternative mockup:

| Today | Proposed |
|---|---|
| "Place new order" + "Login → products → Express checkout → payment → approve in Backoffice. Creates a STAGING test order." | Segment "Place new order" (the steps show once the run starts) |
| Card hints "What should run?", "Before running", "Saved as launcher-log.txt with each run" | Removed |
| Mockup subtitle "Configure the order and review the test settings before running." | Removed: no page subtitles |
| "Run order test" (mockup: "▶️ Run order test") | "Place test order": it keeps "test" and says an order is placed. No emoji. |
| "Approve in Backoffice" (the Run button) | "Approve order" |
| 11 ticked checklist items | "✓ Ready · 9 checks passed" (expandable), or the failing items with their fix |
| Banner "Ready" + "Status: Ready" | The checks line only |
| "Used only for your runs, and never shown to anyone else or written in a report or log. With Remember ticked, the server keeps it for your next sign-in, locked with your portal password, so only your sign-in can open it. Forget removes it." | "Encrypted with your portal password. Only you can use it." + "How it's stored" (link to `docs/server-deployment.md`) |
| "No backoffice account: the order will wait for approval" | Kept; it states a consequence, which is good copy |
| "Found 0 Standard (delivery options without "Fastest") options; expected exactly one." | Headline: "Standard delivery wasn't offered on the checkout page." The original message moves under "Full message". |

---

## 12. Accessibility (WCAG 2.2 AA)

- **Contrast:** text and controls meet the ratios in 9.2. The focus ring is a 2 px accent ring with a 2 px offset, on every interactive element.
- **Keyboard:**
  - Tab order follows the visual order.
  - Arrow keys move within segmented controls.
  - Enter or Space activates controls.
  - Esc closes the side panel and dialogs, and leaves the live picture.
  - Extra shortcuts are optional (O1).
- **Focus:**
  - Dialogs move focus in and return it to the button that opened them.
  - The side panel doesn't trap focus. Esc returns focus to the row.
- **Live regions:**
  - Step changes and results are announced politely ("Completed. Order 07110006.").
  - Failures are announced assertively.
- **Never colour alone:** every status has a word, and every step state has a glyph.
- **Target size:** 24 × 24 px at least (2.5.8); segments are 32 px high.
- **Zoom:** at 200 % in a 1366 px window, nothing needs horizontal scrolling except the history table, inside its own container.
- **Live browser:**
  - `role="application"` with a label.
  - When it has focus it says so in text.
  - Esc leaves it.
- **Forms:**
  - Every field has a programmatic label.
  - Each failing check in the action bar is a link that focuses its field.

---

## 13. Layout and window sizes

**One scrollbar rule.** The page is the only scrolling area. Only these may scroll inside:
- the side panel and dialogs (overlays);
- the products text area after 16 lines;
- the full log box;
- the history table, sideways.

| Width | Automation | Logs / History |
|---|---|---|
| ≥ 1440 px | Form 680 px + 300 px column; Running: browser + 320 px steps | Table + 520 px side panel, side by side |
| 1200 to 1439 px | Form + 280 px column | Side panel overlays the right part of the table |
| 900 to 1199 px | The column moves under the form; steps go under the browser | Side panel full height, 440 px |
| < 900 px | One column; supported, not optimised | Table scrolls sideways |

**Budget at 1366 × 768:**
- The Edge app window leaves about 690 px of height.
- The header takes 48 px, the form content up to 560 px, and the action bar 64 px.
- The products area shows 8 lines and grows to 16 before it scrolls.

---

## 14. Technical constraints

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
- **What the page already has, and what it doesn't:**
  - **Step durations:** live, from the timestamps of the streamed step lines. For finished runs, from the same lines in the run's log when it can be read; otherwise they are left out.
  - **Approvals:** the "who placed it", the views and the counts are computed in the page from the history rows it already loads.
  - **Product names:** not in the run results. Rows show PLUs only. Adding names would mean saving them in `result.json` (a change for later, not part of this redesign).
  - **Live browser page address:** not sent to the page. The tab strip shows titles only (O7).
- **Test contract.**
  - `tests/launcher.spec.ts` and `tests/server.spec.ts` drive the page by accessible name and id. For example:
    - labels "Place new order", "Approve existing order", "One PLU per line", "Order number", "Home Delivery", "Click & Collect", "Seconds between adds";
    - `#run`, `#stop`, `#confirm` with "Run test" / "Approve in Backoffice" / "Cancel";
    - `#result .verdict`, `#result .order-number`, `#steps li.done|.skipped`;
    - `tr.hrow`, `tr.hdetail`, `#history-search`, `#history-count`;
    - `#live-img`, `#live-close`, `.check-optional`, `.check-bad`.
  - Keep ids as hooks.
  - Where a name or meaning changes on purpose, update the tests in the same commit. Examples: "Run order test" → "Place test order"; `#history-count` → the awaiting-approval count.
  - A phase is done only when all offline tests pass.
- **Performance:**
  - first paint under 200 ms locally;
  - the live picture renders in a fixed-ratio box, so the layout never shifts;
  - 500 history rows render in under 50 ms.

---

## 15. Optional enhancements (each needs a yes)

These would change behaviour or add features, so they are not part of the redesign. Each can be
decided on its own.

| # | Idea | Value | Cost or risk |
|---|---|---|---|
| O1 | Keyboard shortcuts: Ctrl+Enter to place or approve, `/` for search, ↑ ↓ in history | Faster repeat runs | Small; must not clash with the live browser's typing |
| O2 | Window title and favicon show the run's state | Follow a run from another tab | Small |
| O3 | Browser notification when a hosted run ends in the background | No need to watch | Needs permission; can annoy |
| O4 | Links to a run or a filtered history view (`#/runs/<id>`), to share in Teams | Faster triage | Small; hash routing |
| O5 | Unsent form edits survive a reload | Fewer lost edits | Small; must not store account fields |
| O6 | Live browser "Watching / Take control": clicks pass through only after Take control | No accidental interference with a run | Changes today's behaviour |
| O7 | Page address in the live browser's tab strip | Easier debugging | Server sends the tab URL (small API addition) |
| O8 | Countdown on the kept-open browser ("Closes in 4:12") | Clearer hold | The page must know when the hold began |
| O9 | A separate Approvals page | Only if the Logs / History view isn't enough | A third page in the navigation |

---

## 16. Delivery plan

Each phase ships on its own. Before it ships:
- all tests pass;
- section 4 is checked item by item;
- screenshots in light and dark at 1366 × 768 and 1920 × 1080 go with the commit.

| Phase | Scope | Done when |
|---|---|---|
| 0. Design review | Directions A and B (section 8) with a recommendation. High-fidelity designs at 1366 × 768 and 1920 × 1080, with real runs from `reports/`, for: Place new order, Approve existing order, Logs / History, Running, Failed run details. | Willy approves a direction and the five screens. Nothing is implemented before this. |
| 1. Foundations | Tokens, type scale, colour, radii, buttons, inputs, badges. Remove shadows, the gradient stripe, number badges, icon discs and uppercase labels. Layout unchanged. | Section 1 targets met; contrast as in 9.2; tests passing |
| 2. Automation page | Compose / Running / Result; action bar with the checks line; accounts rows; review dialog; one scrollbar; the Approve existing order form | G2 met at 1366 × 768; section 4 checked; tests updated |
| 3. Running and failures | Live browser as the main area, steps with durations, failed step opened with its log, kept-open state | A run can be followed and stopped by keyboard; no layout shift while frames arrive |
| 4. Logs / History | Views with counts, readable table, Approve in the row, side panel, screenshot previews | An order awaiting approval is approved from Logs / History in 2 clicks plus the confirmation; hallway test with 3 colleagues |
| 5. Optional | Only the items from section 15 that were approved | As agreed per item |

---

## 17. Definition of done: "doesn't look generated"

A checklist for every phase review:

- [ ] At rest, the Automation page has exactly one filled accent element: the primary button.
- [ ] No element has a border, a shadow and a tinted background at once.
- [ ] No numbered step badges, no icon-in-a-circle, no emoji.
- [ ] The stylesheet uses at most 6 font sizes, 2 weights and 3 radii (plus dialogs).
- [ ] No uppercase letter-spaced text, and no page subtitles.
- [ ] Each helper text exists because people made that mistake or asked that question.
- [ ] Each view states its status once (the header's run indicator aside).
- [ ] One page scrollbar (section 13).
- [ ] No setting is hidden behind a summary to make the page look tidy.
- [ ] Each state was checked with real data: 40 PLUs, a 300-character error, 500 history rows, dark mode.
- [ ] Squint test: with the screenshot blurred, the one thing that matters in that state is still the most visible.
- [ ] Nothing moves on its own except the current step's spinner and the live picture.
- [ ] Every item in section 4 still works.

---

## 18. Decision log

| # | Decision | Why | Source |
|---|---|---|---|
| D1 | Two pages, keeping their names: Automation and Logs / History | Familiar; the docs, START-HERE and tests use them. Approvals fit as a view with a count. | Alternative brief (draft 1 had added an Approvals page; now O9) |
| D2 | Products stay a paste-first text area beside a structured preview, not one row per product with "Add product" | People paste lists (the default order file has 18 PLUs). One row per product costs a click per product, and its small "Add product · Remove" links are hard to hit. The preview gives the structure and shows per-line errors. | Mockup rejected |
| D3 | Pre-run checks as one line when all pass, expandable; failing items listed | Reassurance before a real order, without 11 ticks. Draft 1 showed nothing when fine. | Alternative brief and mockup adopted |
| D4 | Delivery settings stay visible and editable | They change between runs (Express versus Standard). The mockup's read-only line hid them. | Mockup rejected |
| D5 | Segoe UI Variable, not Inter | Native on Windows, so nothing to download (offline exe, CSP). Inter would have to be embedded, and is the default look of generated mockups. | Alternative brief adjusted |
| D6 | Light console as the designed default; dark follows Windows with the same tokens | Section 8 | Alternative brief adopted |
| D7 | The redesign is presentation only; behaviour changes go to section 15 | Lower risk; easy to review | Alternative brief adopted |
| D8 | One page scrollbar | Today's right column scrolls on its own | Alternative brief adopted |
| D9 | No emoji and no decorative icons in buttons | The mockup's "▶️" renders differently per machine and reads as generated | Mockup rejected |
| D10 | Status words stay as today ("Completed", not "Success") | History, CSV exports and tests use them | Alternative brief adjusted |
| D11 | "Run order test" → "Place test order" | Says that an order is placed, and keeps "test" | Draft 1, softened |
| D12 | Accounts as compact rows; Change opens today's fields in place | Same behaviour, less space. No new panel. | Alternative brief adopted (draft 1 had a panel) |
| D13 | The live browser keeps today's behaviour (clicks pass through) | Behaviour change; now O6 | Alternative brief |
| D14 | No page title or subtitle above the form; the segmented control names the task | The mockup repeated "Place new order" three times on one screen | Mockup rejected |
| D15 | A failed run opens the failed step with its log, like GitHub Actions | The investigator's main need | Alternative brief adopted |
| D16 | No "Undo" for Forget | The password is deleted on the server, so there is nothing to restore | Draft 1 corrected |

**The alternative mockup** (2026-10-15) was a narrow 770 px view, so it couldn't show desktop layout decisions.
- **Calmer than today:** sentence-case headings, a two-way workflow switch, one accent, and validation reduced to a line.
- **Still a card per section**, with a teal-filled selected option.
- **Left out:**
  - the accounts, the signed-in user and Sign out;
  - the editable delivery settings;
  - any running or result state.
- **Signs of a layout that doesn't fit:** a floating "↓" scroll button and an emoji on the main button.

---

## 19. Open questions for Willy

1. **Direction:** approve A (light, recommended) or B (dark) for phase 0?
2. **Theme:** keep following Windows (light or dark), or always light?
3. **Brand line:** keep a thin Watsons brand line in the header, or only the logo mark?
4. **Optional items:** which of O1 to O9 do you want, if any? O1 and O2 are cheap and useful.
5. **Screens:** do colleagues mostly work on 1366 × 768 laptops or larger screens? This decides how dense the defaults are.
6. **Button name:** "Place test order" instead of "Run order test": yes or no?

---

## Appendix: references

- Jakob Nielsen, *10 usability heuristics for user interface design*.
- Jon Yablonski, *Laws of UX*: Hick, Fitts, Tesler, Doherty, peak–end.
- W3C, *Web Content Accessibility Guidelines 2.2*.
- Adam Wathan and Steve Schoger, *Refactoring UI*: hierarchy, spacing and colour in practice.
- Microsoft *Fluent 2*: Segoe UI Variable, density, Windows conventions.
- Retool, Linear and GitHub Actions: see section 5.1 for what is borrowed from each.
