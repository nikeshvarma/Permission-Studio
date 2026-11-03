# QA: unexpected use

Exploratory and negative testing for release 2.2.4: what a user can get wrong, and what the org can throw at the extension. Every charter below is now an automated test: Q-charters in `test/smoke.js` (server side, against the in-memory org), W-charters in the browser click-through suite (the screen, rendered from `media/app.js`).

Result: **11 bugs found and fixed** (marked **Fixed**) and one improvement (marked **Improved**). Everything else behaved correctly.

## Server side

| # | What the user does or the org throws | Expected | Result |
|---|---|---|---|
| Q1 | Saves an empty list of changes | Nothing written, no error | Pass |
| Q2 | Sends a change of an unknown kind, without a value, or junk entries | Refused with the reason, before the org is read | **Fixed** (no-value changes reached the conflict check, a misleading message) |
| Q3 | Keeps editing a permission set someone deleted in Setup | Nothing written; "no longer exists, may have been deleted in Setup"; lists refresh | **Fixed** (the org's raw error) |
| Q4 | Loses the network in the middle of a save | Readable "can't reach Salesforce"; background refresh not left off | Pass |
| Q5 | Double-clicks Save, or starts two saves at once | One save; the other told one is running | **Fixed** (both ran, two snapshots) |
| Q6 | Types the production name in another case, with spaces, or wrongly | Case and spaces forgiven; a wrong name refused | **Fixed** (case-sensitive) |
| Q7 | Searches users for `O'Bri`, `r_S`, SOQL fragments, `%%`, emoji | Searched for as typed; never a query error | **Fixed** (apostrophes and underscores dropped) |
| Q8 | Saves 5,100 field changes at once | Saved (batches of 200; step by step past 25 batches) | Pass |
| Q9 | Clones into an API name that already exists | Refused before anything is created | **Improved** (the org refused it, later and in its own words) |
| Q10 | Clones with an invalid API name (digit first, spaces, `__`, trailing `_`, 81 characters, empty) | Refused before anything is created | **Fixed** (a trailing underscore was accepted) |
| Q11 | Types a ticket with `|`, line breaks, 200+ characters | One line, at most 80 characters; Markdown stays valid | **Fixed** (line breaks kept) |
| Q12–Q13 | Looks up an object, field or system permission that doesn't exist | An error or no users; never a crash | Pass |
| Q14 | Runs a grant or a removal with nothing chosen | An empty plan | Pass |
| Q15 | Has a damaged change log (half lines, binary junk) | Damaged lines skipped | Pass |
| Q16 | Has a damaged cache file | Ignored and re-read | Pass |
| Q17 | Assigns a user someone assigned in Setup a moment ago | Conflict or no-op; never a duplicate assignment | Pass |
| Q20 | Malformed or unexpected messages from the screen | Ignored; the screen keeps working | Pass |
| Q21 | Sets an impossible (`2027-02-30`) or past expiry date, a back-to-front IP range, a 256-character description | Refused with the reason, before the org is read | **Fixed** (left to the org, after a slow Metadata API read) |

## Screen

| # | What the user does | Expected | Result |
|---|---|---|---|
| W1 | Double-clicks Save, then presses Ctrl+S while it saves | One save sent | Pass |
| W2 | Presses Esc during a save | The dialog stays | Pass |
| W3 | Presses Ctrl+S with nothing to save; with changes | Nothing; then the review | Pass |
| W4 | Switches item with unsaved changes; cancels | Asked first; changes kept | Pass |
| W5 | Opens History or Find access with unsaved changes; then a grant screen | The read-only pages open straight away and keep the changes; grant screens ask | **Fixed** (every tool asked to discard) |
| W6 | Opens items whose labels contain HTML or script | Shown as text; nothing runs | Pass |
| W7 | Removes every change from the review | Review and footer close | Pass |
| W8 | Filters the review to nothing | "No changes match"; Save still covers everything | Pass |
| W9 | Pastes 10,000 characters into a search box | Stays responsive | Pass |
| W10 | Opens an org with no permission sets | Empty list, no errors | **Fixed** (the same bug as W18) |
| W11 | Receives a detail with missing parts | Still renders | Pass |
| W13 | Gets "a save is already running" | The save in progress stays on screen | Pass (new reply) |
| W14 | Resizes the window with a list open | The list closes | Pass |
| W16 | Types nonsense into an object picker and presses Enter | Nothing happens | Pass |
| W17 | Types the production name in another case in the review | Save enabled, matching the extension's rule | **Fixed** (three separate checks disagreed) |
| W18 | The open item vanishes from a refresh (deleted in Setup) | List redrawn, item closed, no errors | **Fixed** (the update stopped halfway with an error) |
