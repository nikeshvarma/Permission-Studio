# Changelog

All notable changes to Permission Studio. Versions follow `major.minor.patch`; every delivered change raises the patch number.

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
