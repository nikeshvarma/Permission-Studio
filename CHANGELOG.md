# Changelog

All notable changes to Permission Studio. Versions follow `major.minor.patch`; every delivered change raises the patch number.

## 2.5.4

- README brought up to date: the Health button and how the health check handles large orgs (summary cards, 50 rows at a time with Show more, Select all across the whole finding), lists that keep their place while you work, and every screenshot taken from the current screen.
- No change to how the extension works.

## 2.5.3

- Fixed: ticking a checkbox in a list that scrolls on its own (Grant field access's field list and "Grant to" table, Grant object access's grid) jumped the list back to the top. Every box that scrolls inside the page, and inside the review, now keeps its place when the screen redraws, including any added later.
- Fixed: choosing a section near the bottom of the section menu (Apps) scrolled the menu back to the top. The menu now scrolls on its own and keeps its place.
- Fixed: removing a change in the review jumped its list back to the top.
- A new click-through finds every box that scrolls on these screens, ticks something inside it, and checks it stayed where it was.

## 2.5.2

- Fixed: the health check could leave the whole page scrolled, with blank space under it and the top bar out of view. A toggle's hidden input was positioned against the frame around the scrolling area, so a toggle far down the page (the health check's "Include managed packages" and "Include standard profiles") stretched the page itself to thousands of pixels; clicking a summary card then scrolled the page, not just the health check. Toggles now contain their input, the page itself can never scroll, and summary cards scroll only the health check.
- The layout audit now checks, on every screen at every laptop size, that the page is exactly the window's height and never scrolled.

## 2.5.1

- **The access matrix is removed**, and the **Reports** button is now **Health**: it opens the health check directly.
- Health check: a long finding shows its first 50 rows, with **Show 100 more** and **Show all**; the page scrolls as one, with no scrolling boxes inside it. With thousands of rows (5,345 assignments to inactive users, say) the page was slow to draw and showed blank space. **Select all** still selects every row in the finding.
- Toggles: centred on their label, and green when on, everywhere.
- Dropdown arrows: drawn in the text colour, 12 px in from the edge, the same in every dropdown and filter.
- Compare: the "In this org / In another org" switch fits its buttons (no empty end).
- Find access, Grant field access and Grant object access: the object and field pickers show the magnifier. Every dropdown, search box, picker and text field is the same height.
- Fixed: hovering a table row made it flicker (its size changed on hover, which moved it out from under the pointer). New stylesheet tests catch a rule joined to the wrong selectors, and any hover style that changes size.

## 2.5.0

- **Exports are Excel only, and richer.** Every export is one workbook with as many sheets as the subject needs. Each sheet starts with what it is, the org, when and the filters; the data is a real Excel table (banded rows, filter buttons, sortable) with the header frozen; cells are coloured like the screen; permission sets, profiles, groups and users link to Setup; very large results are split across sheets. After saving: **Open** or **Show in folder**. Buttons simply say **Export**.
- **New exports:** User access (summary, sources, object, field, system and custom permissions), Compare (differences, then each side in full), Find access (users, sources, half access, inactive users), History (saves and every change, for the selected saves or everything shown), and **Export everything** for the access matrix (object, field per object, system and other access in one workbook).
- **Removed:** CSV exports, and History's "Copy for Excel" (replaced by Export). Copy summary is Markdown only.
- **One consistent look:** tags (Managed, High impact, Saved, Failed, tickets, sources, counts, field types) share one pill size; checkboxes and radio buttons share one size and colours (radio buttons are no longer the system's own); every table has the same header, spacing, dividers and hover; cards, dialogs, bars, tiles and notices share 8 px corners; switches and tabs match buttons; secondary text uses one size. A new design check measures all of this on ten screens.

## 2.4.0

- **Reports › Health check**: integration users with admin access; who holds high-impact permissions and through what; assignments to inactive users (remove them in one reviewed save); assignments expiring soon (extend them by 30, 90 or 180 days); unused permission sets, permission set groups and profiles; permission sets that grant nothing. Export to Excel (a summary and one sheet per finding) or CSV.
- **Reports › Access matrix**: permission sets, groups and profiles against object permissions, field permissions, system permissions or other access (apps, Apex, Visualforce, flows, connected apps, custom permissions, custom metadata, custom settings). Filters: kinds, managed packages, standard profiles, only items with active users, favorites, name, and hiding items without access. Preview, then export to Excel (with an About sheet of filters and legend) or CSV.
- Consistent controls: every button is a rectangle with the same corners; every dropdown and search box (including the object and field pickers) is a pill.
- Fixed: a bulk save that failed (Grant screens, Find access's "Remove from selected") showed "ticket is not defined" instead of the org's error, and the failure wasn't recorded in History.
- Fixed: bulk saves dropped each change's record reference, which assignment changes need.

## 2.3.5

- README completed: contents, commands, every key feature (including Changes in Setup, a profile's users, copying API names, offline screens and the org badges), the six steps of a save, limitations, a fuller FAQ and troubleshooting, the project structure and a link to the changelog.
- Marketplace keywords widened (permission set group, object permissions, muting, security, Salesforce CLI, Agentforce and more).
- No change to how the extension works.

## 2.3.4

- Fixed: Agent Access and Email Routing Address Access kept showing "INVALID_FIELD:" after the 2.3.3 fix. The page showed a list saved in the cache by the older version: an expired cached value was handed back to the refresh that should have replaced it. Now a refresh always waits for the fresh value, a list that fails is shown as an error and never cached, and a new version starts with an empty cache.
- New settings for where the toggles start: `permStudio.defaults.onlyEnabledAccess` (access lists, on), `permStudio.defaults.onlyEnabledSystemPermissions` (System Permissions, off) and `permStudio.defaults.showAllObjects` (Object Settings, off). They apply each time the page opens and as soon as they change; flipping a toggle on the page still works for the session.
- Loading: a page or section that loads for the first time shows placeholder rows with a line saying what is being read ("Reading Sales Operations from the org…", "Reading Apex Class Access from the org…"), and nothing else. The progress bar at the top is gone, and the three-dot indicator is kept only for background refreshes ("Refreshing…").

## 2.3.3

- Fixed: Agent Access and Email Routing Address Access showed "INVALID_FIELD:" in orgs whose BotDefinition or EmailRoutingAddress lacks a field the list asked for (NamespacePrefix, DisplayName). The newer access lists now ask the org which fields the object has and query only those.
- Errors now show Salesforce's own reason ("No such column … on entity …") instead of only the error code.
- Fixed: with all three lists shown (permission sets, groups and profiles), the Profiles tab was cut off. The tabs now share the row (short names, with the count under each, when the list is narrow), and the hide-the-list button sits beside the search box.
- README rewritten: the problem it solves, a task-by-task comparison with Setup, key features with screenshots, getting started, safety, shortcuts, settings and an FAQ.

## 2.3.2

- README brought up to date with 2.3.0 and 2.3.1: the table of what can be seen and changed now covers the newer kinds of access, profile settings, muting and licence assignment; "And more" covers the refresh on open and the laptop layout; the Settings table lists `permStudio.refreshOnOpen`; every screenshot shows the current screen.
- No change to how the extension works.

## 2.3.1

Laptop screens. Checked at the sizes a 14-inch laptop gives the page in VS Code (about 970 × 620 with VS Code's sidebar open, up to 1480 × 760), every screen fits with nothing cut off.

- The layout follows the width the page actually has (VS Code's sidebar, a split editor and zoom all change it), not the window.
- The section menu shows icons only when the page is narrow, instead of a block of links above the content; a toggle shows the names at any width, and the choice is remembered.
- The item list can be hidden to a thin rail for more room; an item picker then sits at the top of the page. In a narrow window it starts hidden once an item is open.
- The top bar stays on one row: shorter tool names when space is tight, labels that never wrap, and "Updated …" moves into the Refresh button's tooltip.
- In short windows the page header is tighter (the description takes one line) and the review leaves more room for its list of changes.
- Card headers wrap instead of cutting off a button; permission tags in a narrow table wrap onto a second line.

## 2.3.0

- **Muting in permission set groups**: a group's Muted Permissions section shows the object, field and system permissions its permission sets grant, with what is muted ticked. Muting follows Setup's rules (muting Read mutes what needs it; unmuting Delete unmutes Edit and Read). The whole muting permission set is written back, so existing mutes are kept. A group without a muting permission set gets one in a click.
- **Newer kinds of access**, for permission sets and profiles: Agent Access, External Credential Principal Access, External Data Source Access, Service Presence Statuses Access and Email Routing Address Access. Read and saved with the Metadata API; a feature the org doesn't have says so.
- **Profile settings**: default app, login flow, data category visibility, password policy and session settings.
- **User access policies**: permission sets and groups show the policies that assign or remove them automatically, and the review warns before you remove an assignment a policy may give back.
- **Permission set licences**: assigning a permission set to users who lack its licence can assign the licence in the same save.
- **User access**: everything one user can do, added up across their profile, permission sets and groups, with where each permission comes from.
- **Compare**: two items in this org, or the same item in another org the Salesforce CLI is signed in to. Differences filterable by area and copyable as Markdown.
- **A full refresh each time the page opens**, or comes back into view after a minute or more; unsaved changes are kept. Setting: `permStudio.refreshOnOpen` (on by default).
- **Animated loaders**: bouncing dots, a progress bar at the top while anything loads, and a gentle pulse on loading text; all still when the system asks for reduced motion.

## 2.2.7

- README image addresses now use the same form as Microsoft's packager (`https://github.com/<owner>/<repo>/raw/HEAD/<path>`).
- New `tools/check-readme.js`: run it on a `.vsix` to see which repository the README points at and whether GitHub serves each image to an anonymous visitor, with the reason when it doesn't (no repository in package.json, private repository, file not on the default branch). The Release workflow runs it, so every release's log shows the result.

## 2.2.6

- Fixed: README images were broken on the extension's page in VS Code, which only shows images from https addresses. Packaging now points the README's images at the repository's files on GitHub (and its links to other files at their GitHub pages), as Microsoft's own packager does. The README in the repository is unchanged and still works on GitHub. The screenshots are no longer packed into the extension, which shrinks from about 1 MB to about 230 KB.
- This needs a GitHub `repository` in package.json and a public repository; packaging says so when it's missing.

## 2.2.5

- A new test fails when `media/app.css` is older than `media/app.js`: every style class the screen uses must be defined. A repository that received the 2.2.3 picker code without its stylesheet built a release where the object and field pickers showed as an unstyled bulleted list.
- No change to how the extension works.

## 2.2.4

QA round: what users can get wrong, and what the org can throw at the extension. See docs/QA.md.

- Fixed: when the open item disappeared from refreshed lists (deleted in Setup, another org, a list type switched off), the list update stopped halfway with an error and the screen kept a stale item.
- Fixed: a second save while one was running (double-click, Ctrl+S during a save) also wrote and took a second snapshot. One save runs at a time; the other is told to wait. The same applies to the bulk screens.
- Fixed: user search dropped apostrophes and underscores, so "O'Brien" couldn't be found. Text is now searched for as typed.
- Fixed: the production confirmation was case-sensitive, and the review dialog, the bulk screens and the save itself each had their own copy of the check. One rule everywhere: the alias or username, any case, spaces ignored.
- Fixed: Find access and History asked to discard unsaved changes before opening; they only read, so they open straight away and the changes wait. The grant screens still ask.
- Saving to a permission set deleted in Setup now says so plainly and refreshes the lists.
- Checked before anything is written or read: malformed changes, API names (start with a letter, no double or trailing underscore, at most 80 characters), labels, descriptions (at most 255 characters), impossible or past expiry dates, IP ranges whose start is after their end.
- Tickets: line breaks and runs of spaces become single spaces before the 80-character limit.

## 2.2.3

- Fixed: the object boxes in Grant object access, Grant field access and Find access used the browser's own suggestion dropdown, which ignored the theme (white), tried to show every object in the org at once and could stay stuck open in VS Code. They now use Permission Studio's own picker: themed, at most 50 matches with the best first (exact name, then names starting with what you typed, then label words), ↑/↓ and Enter to pick, Esc, Tab or a click elsewhere to close. Typing an exact API name and pressing Enter still works. In Find access, typing "Lead." switches the list to Lead's fields.

## 2.2.2

- Fixed: in Find access, the suggestion list under "Object or field" closed after every key, so a suggestion couldn't be picked. Typing no longer redraws the page; the suggestions (objects, then the object's fields) and the Access choices are updated in place.

## 2.2.1

Code review: bugs fixed, dead code removed, nothing new to learn.

- Fixed: after a save that found a conflict (an entry changed in Setup since it was loaded), background refresh stayed off until VS Code restarted.
- Fixed: Find access's Find button stayed disabled while typing, and the first click after typing could be lost. It now also says so when nothing recognisable was typed.
- Fixed: unsaved changes kept for an item that no longer exists, or left unrestored while editing another item, stopped new unsaved changes from being kept.
- Fixed: the permission-rule note stayed under its checkbox after Cancel or Save.
- Fixed: Changes in Setup and History matched item names inside other words ("Sales" in "Salesforce"); names now match as whole words, longest first.
- Fixed: Grant field access could show an earlier answer for current access after the field selection changed.
- Fixed: copying a list showed the whole list in the notification; it now says how many lines were copied.
- Find access "Remove from selected" is logged as "Find access: remove" in History, not as the field wizard.
- Faster redraws on wide windows (the narrow-window picker is only built when the window is narrow).
- Removed unused code: the old change-set module, model comparison and XML-to-model reading, and a few unused loader, SOQL and Metadata API helpers; module exports trimmed to what is actually used; duplicate CSS rules merged.

## 2.2.0

- **Review screen redesigned**: the impact first (changes, users affected, high-impact permissions granted, access removed), a plain-words warning for risky permissions and removals, then every change on one line with granted and removed chips. Remove a single change with ×, filter long lists, and tag the save with a ticket (for example an ADO story); the ticket is kept in History and in copied summaries.
- **Find access redesigned**: one box for an object or field (`Lead.Rating`), recent searches, filters (granted through, profile, license, active or inactive users, full or partial access), coloured sources, **Why?** showing how each user gets the access (through which group and member permission set), an at-a-glance panel, and **Remove from selected…** / **Grant to more…**.
- **Grant field access redesigned**: steps across the top, each permission set's and profile's current access next to what will change, filters, a running summary (users reached, Read added on the object where missing), and templates to reuse a set of choices.
- **Grant object access redesigned**: one grid of items × permissions with what's already granted, per-item choices, set a whole column at once, and record types with profile defaults.
- **History redesigned**: grouped by day, changes as chips, tickets, clear Saved / Failed / Undo status, filters, and Setup Audit Trail changes mixed in.
- Unsaved changes are kept if the tab is closed or VS Code reloads, and the tab title shows ● while changes wait.
- **Ctrl/Cmd+S** opens the review and saves from it, **Esc** closes a dialog or leaves a tool page, **/** jumps to search (no hints on screen).
- Column headers stay visible while scrolling; narrow windows show the list and section menu as pickers; placeholder rows while loading; the permission-rule note sits under the checkbox; a **Sandbox** badge; copy any API name on hover.

## 2.1.0

- **Tab settings are saved as records** (PermissionSetTabSetting) instead of a Metadata API deploy, so they go in the same single save request as everything else. Profiles now have Tab Settings too, in Setup's wording (Default On, Default Off, Tab Hidden), and profile source files are written in the profile's own values.
- **Salesforce's permission rules for system and custom permissions**, read from the org (PermissionDependency and CustomPermissionDependency) and cached for a day: turning a permission on turns on what it needs, turning one off turns off what needs it, as Setup does. The review marks those entries **auto**.
- **Find access for system and custom permissions**: who has Modify All Data, Use Any API Client or a custom permission, and through which permission sets, profiles and groups. High-impact permissions are listed first. Use Any API Client and Approve Uninstalled Connected Apps are now tagged **High impact**.
- **Copy to permission set** on profile pages: a new permission set with the profile's user license and its object, field, system and other access, tab settings and record types. Page layouts, login hours and IP ranges stay on the profile; nothing is removed from it.
- **License checks before assigning**: users whose user license, or missing permission set license, doesn't fit the permission set are tagged **License mismatch**, and the save stops with the reason before writing anything. Session-based permission sets are tagged **Session-based**.
- **Changes in Setup**: the last 90 days of Setup Audit Trail entries about the open item, or a note when the View Setup Audit Trail permission is missing.
- When the profile list shows only your own profile, a note explains Winter '27 profile filtering (View All Profiles).

## 2.0.10

- Saves now go in one request: every addition, update and removal is sent together as a single Composite request and one transaction, so either all of it is saved or none of it. If Salesforce refuses that request (for example while a permission set group recalculates), the extension re-reads the org and saves whatever did not land step by step, waiting for the group as in 2.0.9. CLI connections save step by step.
- Object Settings lists objects where the item grants field access but no object access, with the number of fields, such as Event and Task. Searching Object Settings looks through every object in the org, not only those listed.

## 2.0.9

- Fixed: saving several kinds of change to a permission set that belongs to a permission set group could stop partway with "The … permission set group is updating". Each write to such a permission set makes Salesforce recalculate the group, and Salesforce refuses further changes until that finishes.
- A save is now at most three writes (everything added, everything updated, everything removed), whatever the mix of permissions.
- Before the first write, and whenever Salesforce reports the group is updating, the save waits for the recalculation to finish and carries on. The review dialog shows what it is waiting for. If a group is still recalculating after 5 minutes, the save stops cleanly and says which steps were not sent.

## 2.0.8

- Fixed: object permissions offered on objects that can't have them, such as Event and Task, which failed with "bad value for restricted picklist field". The object list now comes from Salesforce's own list of objects that take object or field permissions. Activities open with their fields editable and a note that their access comes from the Edit Tasks and Edit Events system permissions; Find access answers by field for them.
- Saving checks the objects first and stops with a clear reason before anything is written.
- Object pages list required and system fields (Name, Created Date, Last Modified Date and so on) as in Setup, tagged **Always visible**, with their access locked because Salesforce doesn't allow field-level security on them.

## 2.0.7

- Released under the MIT License.
- Contributing guide, and templates for issues and pull requests.
- No change to how the extension works.

## 2.0.6

- README rewritten with screenshots and a how-it-works diagram. The images ship in the extension, so they show on its page in VS Code as well as on GitHub.
- No change to how the extension works.

## 2.0.5

- Source release: changelog, a packaging script that builds the `.vsix` on any OS with only Node.js (`npm run package`), and GitHub Actions that test every push and attach the `.vsix` to a GitHub Release for each version tag.
- No change to how the extension works.

## 2.0.4

- Permission set groups: add and remove member permission sets from the group's **Permission Sets** section, with review, snapshot, undo and history. The group's recalculation is watched and its access re-read when Salesforce reports it updated. Muting permission sets are shown read-only.
- Copy change summaries: **Copy summary** after a save, and **Copy** / **Copy for Excel** in History, for one save or several. Markdown tables for tickets and documents; tab-separated cells for Excel.
- Open items from anywhere: **Open in Permission Studio** on permission set, profile and group files (Explorer, editor title), and **Permission Studio: Open Item…** in the Command Palette.

## 2.0.3

- Colour-coded object permissions (Read, Create, Edit, Delete, View All, Modify All) everywhere they appear.
- Rows that grant nothing are shown quieter; **High impact** tags on org-wide system permissions; expiry warnings on assignments.
- Small icons in the section menu.

## 2.0.2

- The Salesforce CLI's library is found on disk without starting `sf`; new setting `permStudio.sf.installPath`.
- Fixed reading the CLI's install location (its `--json` output has no `{ status, result }` wrapper).
- The log records the token's format (never the token) when a fallback connection is refused.

## 2.0.1

- Connects through the Salesforce CLI's own connection library inside VS Code: the CLI's session, renewal and network route, with no `sf` process per call.
- `sf` processes that still run skip telemetry.

## 2.0.0

- New extension icon; editor tab icon visible in light and dark themes.
- Starts in the background when a Salesforce project opens; auto-refresh every 1–30 minutes, re-reading lists only when the org changed.
- Choose which lists to show (`permStudio.lists.show`); permission sets and profiles by default.
- **Grant object access**: object permissions and record types across many permission sets and profiles.
- Faster: Composite batching, gzip, one query for system permissions, HTTP through VS Code's proxy and certificate settings.
- Removed: creating permission sets, Export/CSV, the "auto" tag next to checkboxes.
- Publisher is now `nikeshvarma` (uninstall versions published as `nikesh-varma`).

## 1.0.3

- **Find access**, **Grant field access**, **History** with undo of any save.
- Assignments with expiry dates; Visualforce pages, flows, apps, connected apps, custom metadata types, custom settings, tab settings, page layouts, login hours and IP ranges.
- Clone and rename permission sets; optional update of the project's source file after a save.

## 1.0.2

- Favorites for items and objects, loaded first and prefetched.
- Apex class access, custom permissions and record type assignments.
- Search boxes keep focus while typing.

## 1.0.1

- Editing of object, field and system permissions with review, conflict check, snapshots, undo and a change log.
- Cached screens refreshed in the background.
- Lightning-style record page.

## 1.0.0

- One main screen for the project's default org.
- Session renewal through the CLI, with a CLI fallback.

## 0.1.0

- First build: read-only view of permission sets, groups and profiles.
