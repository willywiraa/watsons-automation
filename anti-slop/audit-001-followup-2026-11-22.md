# antislop audit 001: follow-up (2026-11-22)

Fixed: items 1, 2, 3, 4, 6, 8, 9, 10 and 11 of `audit-001-2026-11-22.md`, as approved. Items 5, 7, 12 and 13 were not approved and were not touched. The "—" no-value markers are still there.

All changes are in `launcher/ui.html`, so the desktop launcher and the hosted server both get them.

## The approved items

**1. R-03: the page no longer scrolls sideways.**
`body{min-width:1024px}` is gone.
- At 900 px and wider, the layout is the one the design doc describes.
- The history table keeps its columns at a minimum of 940 px. At 1005 px and below, it scrolls sideways inside its card, and its header stops being sticky there.
- Below 900 px the page is one column, with the side navigation above the form.
- Below 640 px the tabs get their own row in the header. The product name and button labels stay for screen readers only.

Checked in Edge at 390, 900, 1024, 1280 and 1440 px, light and dark: the page itself never scrolls sideways. Below 900 px is still "supported, not optimised", as the design doc says. On a phone, an open run's details scroll sideways with the table.

**2. R-27: Logs / History has an error state.**
If the history cannot be loaded, a red banner says so, with **Try again**:
- First load: "Couldn't load the history". There is no table and no stuck "Loading…".
- Refresh: "Couldn't refresh the history. It shows the runs as of <time of the last load>." The runs it already had stay on screen.
- The hint depends on where the page runs. Hosted: "Check the network or VPN, then try again." Desktop: "Check that the launcher's console window is still open, then try again."

A signed-out session still goes to the sign-in page instead.

**3. R-25: the small text passes 4.5:1.**
- Light `text-3` is now `#636c76` (was `#69727c`): 5.33:1 on white and 4.79:1 on the table header. This fixes the product line numbers.
- Status pills and the numbered circles in Execution activity use the 8% status tints. Their text is 4.74:1 or more in light and 5.3:1 or more in dark. This fixes the Running pill and the circles.
- The grey circle uses the secondary text colour.

The design doc's colour table is updated.

**4. R-39: the Automation page has an `h1`.**
The side navigation's "Automation" title is now an `h1`. It looks the same.

**6. R-02: the three pieces of text.**
- "All 1 shown" is now "1 run shown", "All 12 runs shown" or "40 of 120 runs shown".
- "Start using app" is now "Start using the app".
- The heading of a run's error question is now "Unexpected error". The step comes before it, for example "Paused at Add to bag · Unexpected error".

**8. R-31: an open row no longer repeats Copy and Approve.**
- A closed row's Copy is a small icon inside the Order column. It shows on hover or keyboard focus and no longer covers the Delivery column.
- An open row hides its own Copy and Approve. Order results, just below, has them.

**9. R-31: the result card has one Copy.**
The Copy beside the order number stays, and the "Copy order number" action is gone. A partial order keeps "Copy order numbers", which copies all of its numbers at once.

**10. R-31: "awaiting approval" is not an error.**
The Error column shows nothing ("—") for an order awaiting approval. The status column still says "Awaiting approval".

**11. R-05: names are not cut off.**
The Operator column wraps long names instead of cutting them. So does the "at <step>" line under a failed run's status.

## Polish in the same pass

- **Toolbar in the card:** the search and filters are now the table card's toolbar, not a separate block above it. They are the same height (40 px).
- **Top alignment:** table cells line up on their first line, with the pill, the Copy icon and the arrow centred on it.
- **Column widths:** rebalanced so that Order fits the number and its icon, and Status and Operator fit their text at 1280 px.
- **Grey row icons:** the automation icons in each row are grey. The accent colour stays for the active tab, the primary button and links.
- **Form columns:** on the Automation page the two columns now end on the same line.

## Tests

- **Changed:** four tests that clicked the row's Approve after opening the row now click Approve in Order results. The "Needs approval" checks were removed, and the walkthrough button has its new name.
- **Added:** checks that a closed row shows Approve and Copy and an open row hides them, that the Error cell is empty for an order awaiting approval, and both history error banners with Try again.
- **Result:** all 192 tests pass in Edge (11.6 minutes). They include the order, approval, partial-order, question and walkthrough flows, desktop and hosted.
- **Keyboard:** Tab from a row's arrow reaches its Copy icon, which shows while focused, and Enter copies the number.

## Still open

- **Item 5:** the "—" markers for "no value".
- **Item 7:** the icon set's reason is not written in the design doc.
- **Item 12:** the step names use mixed capital styles.
- **Item 13:** the code comments.
- **Walkthrough video:** it still shows the older look.
