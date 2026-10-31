# Changelog

All notable changes to Permission Studio. Versions follow `major.minor.patch`; every delivered change raises the patch number.

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
