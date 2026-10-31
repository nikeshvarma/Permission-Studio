# Permission Studio

View and edit Salesforce permission sets, permission set groups and profiles for your project's default org without opening Setup.

Developed by Nikesh Varma.

## Requirements

- VS Code 1.85 or later
- Salesforce CLI v2 (`sf`)
- A Salesforce project (a folder with `sfdx-project.json`) with a default org set: `sf config set target-org <alias>`

Permission Studio never asks for credentials. It uses the session the Salesforce CLI already holds for the project's default org, keeps the access token in memory only, and writes nothing it reads from the org t## Starting up

Permission Studio starts in the background as soon as VS Code opens a Salesforce project. It finds the default org, connects, reads the lists and prefetches your favourites, so the screen is ready when you open it. While VS Code has focus it refreshes in the background every few minutes (`permStudio.autoRefresh.minutes`, 1 to 30, default 5). The lists are only re-read when something in the org changed, and what is on screen is refreshed without losing unsaved edits.

By default the list shows **Permission Sets** and **Profiles**. Add groups, or show only one kind, with `permStudio.lists.show`; leaving a list out also skips loading it.

## Opening it

Select the shield in the status bar (it shows the default org's alias), or run **Permission Studio: Open** from the Command Palette. The screen opens in the editor area and is laid out like a Lightning record page.

```
[shield] uat  Production                                             Updated 2 min ago  [Log] [Refresh]
┌──────────────────────────────┬───────────────────────────────────────────────────────────────────┐
│ Permission Sets│Groups│Profiles│ [shield] Permission Set                                  [Reload] │
│ [Search this list          ] │          Sales Operations                                         │
│ ▌Sales Operations            │ API Name          License     Active Users   Last Modified        │
│  Report Builder   Managed    │ Sales_Operations  Salesforce  23             28 Oct 2026 by Admin │
│  Lead Management             │ ───────────────────────────────────────────────────────────────── │
│                              │ Object Settings 4 │ System Permissions 12                         │
│                              │ Object Settings › Lead                                            │
│                              │ ┌ Object Permissions ───────────────────────────────────────────┐ │
│                              │ │ [x] Read  [x] Create  [x] Edit  [ ] Delete  [ ] View All ...  │ │
│                              │ ┌ Field Permissions  5 of 7 readable ───────────────────────────┐ │
│                              │ │ Field Label   API Name   Type      [-] Read Access [-] Edit   │ │
│                              │ │ Industry      Industry   picklist     [x]            [x]      │ │
│                              │ ├───────────────────────────────────────────────────────────────┤ │
│                              │ │             2 unsaved changes      [Cancel]  [Save]           │ │
└──────────────────────────────┴───────────────────────────────────────────────────────────────────┘
```

The org is always the project's default org. Change it the usual way (`sf config set target-org <alias>`, or the org picker in the Salesforce extensions) and the screen reloads for the new org on its own.

## What you can see and change

The record page has a menu on the left, grouped the way Setup groups a permission set's overview.

| Section | Permission sets | Profiles | Saved as |
| --- | --- | --- | --- |
| Assigned Apps, Apex Class, Visualforce Page, Flow and Connected App Access, Custom Permissions, Custom Metadata Types, Custom Settings | Yes | Yes | records |
| Object Settings: object and field permissions | Yes | Yes | records |
| Object Settings: record type assignments | Yes | Yes | Metadata API deploy |
| Object Settings: page layout assignments | — | Yes | Metadata API deploy |
| Tab Settings | Yes | — | Metadata API deploy |
| System Permissions | Yes | Yes | records |
| Login Hours and Login IP Ranges | — | Yes | Metadata API deploy |
| Assignments (who has it, expiry dates) | Yes, groups too | read-only list of users | records |

Object permissions are colour-coded wherever they appear: Read blue, Create green, Edit amber, Delete red, View All purple, and Modify All as a solid red tag. Rows that grant nothing are shown quieter, so granted ones stand out. System permissions that reach across the whole org (Modify All Data, Manage Users, Author Apex and similar) carry a **High impact** tag, and assignments that expire within 30 days, or already have, are flagged.

Permission set groups and managed-package permission sets are read-only, apart from their assignments. Standard profiles are read-only.

## Editing

Object permissions, field permissions, record type assignments, system permissions, Apex class access and custom permissions are all checkboxes, as in Setup.

**Apex Classes** and **Custom Permissions** tabs load the first time you open them. They show what the item grants; search, or turn off "Show only enabled", to find something to add.

**Object Settings** lists the objects the item grants access to. Turn on **Show all objects** to add access to a new one, and open an object to change its object permissions and the Read and Edit access of each field. The column headers select or clear Read or Edit for every field shown.

**Record Type Assignments** appear on each object's page. Record types have no queryable object in Salesforce, so they are read with a Metadata API retrieve, which takes a few seconds the first time, and saved with a Metadata API deploy of only the changed entries. On a profile, choose the default with the Default column.

Every such deploy is guarded. A full copy of the item's object, field, system, class and custom permission access is taken first and counted again afterwards. If the deploy removed anything, the review dialog says so and offers **Restore removed permissions**.

**Permission rules are applied as you click.** Granting Edit also grants Read, granting Modify All also grants Read, Edit, Delete and View All, and revoking a permission also revokes what depends on it. Required fields are not listed, and read-only fields (formula, roll-up, auto number) cannot be given Edit.

**Nothing is saved until you select Save.** Changes are highlighted and counted in the footer. **Save** opens a review of every change. On a production org you type the org's alias or username to confirm. Then:

1. Every changed entry is read from the org again. If someone changed one of them in Setup since you loaded it, you choose between saving anyway and reloading.
2. The values just read are stored as a snapshot in the project's `.permstudio/snapshots/` folder (add `.permstudio/` to `.gitignore`).
3. Only the permission records that change are written to the org. Nothing else on the item is touched.
4. The changed entries are read back. Anything the org did not take as asked is reported.
5. The save is logged in `.permstudio/log/changes.jsonl`.

The confirmation offers **Undo**, which stages the snapshot values for review like any other edit.

Permission set groups, managed-package permission sets and standard profiles are shown read-only, with the reason.

## Tools

**Find access.** Pick an object, optionally a field, and an access level. The result lists every active user who has that access and where each half of it comes from (object access and field access can come from different permission sets), plus every permission set, profile and group that grants it, with View All Data, Modify All Data and View All Fields counted. Users who have only half of it are listed separately.

**Grant field access.** Pick an object and fields (custom fields are shown first), choose Read or Read and Edit, and pick the permission sets and profiles to grant it to (Add favorites selects your starred ones). The review shows exactly what changes on each item; items that already have the access, or can't be edited, are skipped with the reason. Each item is then saved on its own, with its own snapshot and log entry. Object access is added where missing unless you turn that off, and read-only fields only get Read.

**Open an item from anywhere.** Right-click a `.permissionset-meta.xml`, `.profile-meta.xml` or `.permissionsetgroup-meta.xml` file in the Explorer, or use the shield button in the editor title while one is open, and choose **Open in Permission Studio**. Or run **Permission Studio: Open Item…** from the Command Palette and type to filter, with favorites first. Encoded profile file names (`Custom%3A Sales`) and standard profiles (`Admin`) are matched to their Setup names, and a group opens even when the Groups list is switched off.

**Permission set groups.** A group's **Permission Sets** section lists its member permission sets and any muting permission set. Add permission sets by name or untick members to remove them; the change goes through the usual review and is saved as records. Salesforce then recalculates the group in the background: the status shows **Updating** in the list and on the page, and the group's calculated access is re-read as soon as it reports **Updated**. Muting permission sets are shown but not edited.

**Grant object access.** Pick an object, the object permissions to add (the same rules apply: Edit brings Read, Modify All brings everything below it), the record types to assign, and optionally the record type profiles should use as their default. Pick the permission sets and profiles, review, and save. Access is only ever added; nothing an item already has is taken away. Record type assignments are read and saved through the Metadata API with the usual safety copy, one item at a time.

**History.** Every save made from this screen in the project, newest first, with what changed. **Copy** puts a save on the clipboard as a Markdown table (Area, Entry, Before, After) for an ADO or Jira ticket, a design document or a wiki. Tick several saves to copy them as one summary, or choose **Copy for Excel** for tab-separated cells that paste straight into a workbook. The save confirmation has **Copy summary** too. **Undo…** compares the org's current values with the values from just before that save and stages the difference for review, like any other edit.

**Edit, Clone.** Rename a permission set, or clone one. A clone copies object, field, system, class, page, custom permission, flow, app, connected app, custom metadata and custom setting access, record type assignments and tab settings; assignments are not copied.

**Local file.** When the item has a source file in the project (`force-app/.../permissionsets/*.permissionset-meta.xml` or `profiles/*.profile-meta.xml`), the review dialog offers to update it after the save, so the change can be committed. Only the changed entries are touched: existing ones are replaced in place, new ones are inserted where Salesforce would put them, and revokes are written as explicit `false`. Set `permStudio.localFile.update` to `always` or `never` to stop being asked.

## Favorites

Star the permission sets, groups and profiles you work with most, and the objects you open most. Favorites sit at the top of the list and of Object Settings. On a fresh start they are loaded before everything else, and their details and the favorite objects of whatever you open are fetched in the background, so they open instantly.

Stars are stored in two settings, so a team can share them through workspace settings:

```json
"permStudio.favorites.items": ["permissionSet:Sales_Operations", "profile:Custom: Sales"],
"permStudio.favorites.objects": ["Lead", "Opportunity", "Invoice__c"]
```

## Speed

Everything you have viewed is cached per org in the extension's own storage, never in the project. The screen, an item or an object opens from the cache straight away and refreshes from the org in the background, with "Refreshing…" shown while it does. **Refresh** re-reads everything, including the object and field definitions, which are otherwise reused for a day. **Permission Studio: Clear Cache** empties the cache, and `permStudio.cache.enabled` switches it off.

The default org is read straight from the CLI's config files, so no `sf` process is needed before the screen appears. Independent queries run in parallel.

n this.

## Speed

- **The CLI's own connection library** inside VS Code: the CLI's session and network route, no `sf` process per call, and none at start-up once its location is known.
- **Direct REST calls**, when used, go through VS Code's proxy settings and the operating system's certificate store.
- **Compressed responses:** responses from Salesforce are gzip-compressed.
- **One round trip per item:** opening an item is one Composite request carrying all its queries. System permissions come in one query instead of four.
- **Background refresh:** the lists are re-read only when the org's change stamp moves.

## Connection

Permission Studio connects the way the Salesforce CLI does, using the CLI's own connection library (`@salesforce/core`) loaded from the CLI's install folder. Requests use the CLI's stored session, its automatic renewal, its proxy handling and its network route, without starting an `sf` process per call.

This matters in orgs that lock sessions to the IP address they started from. There, a token the CLI renewed can be refused when another program sends it by a different route.

The library is found on disk, in the CLI's own install and self-update folders and next to `sf` on your PATH, without starting `sf`. Only if that fails is the CLI asked, once. If your CLI lives somewhere unusual, set `permStudio.sf.installPath` to its folder.

If the library can't be loaded, Permission Studio calls the REST API directly with the CLI's session. If that is refused or blocked, it runs `sf` for each call; a **CLI connection** badge shows when this happens. **Permission Studio: Show Log** gives the reason for every switch, including Salesforce's error code. If the CLI itself can no longer renew the session, the screen tells you to log in again with `sf org login web --alias <alias>`. Tokens are never logged.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `permStudio.sf.path` | `sf` | Path to the Salesforce CLI |
| `permStudio.sf.installPath` | empty | Folder of the CLI install that contains `node_modules/@salesforce/core`; empty finds it automatically |
| `permStudio.project.path` | empty | Project folder to use; empty uses the workspace folder with `sfdx-project.json` |
| `permStudio.apiVersion` | empty | API version for queries; empty uses what the CLI reports |
| `permStudio.connection.mode` | `auto` | `auto` (library, then REST, then sf processes), `library`, `rest` or `cli` |
| `permStudio.cache.enabled` | `true` | Open screens from the cache and refresh in the background |
| `permStudio.favorites.items` | `[]` | Favorite permission sets, groups and profiles |
| `permStudio.favorites.objects` | `[]` | Favorite objects |
| `permStudio.localFile.update` | `ask` | Update the project's source file after a save: `ask`, `always` or `never` |
| `permStudio.lists.show` | `["permissionSet", "profile"]` | Which lists to show and load: `permissionSet`, `group`, `profile` |
| `permStudio.autoRefresh.enabled` | `true` | Refresh in the background while VS Code has focus |
| `permStudio.autoRefresh.minutes` | `5` | Minutes between background refreshes, 1 to 30 |

## Development

There is no build step and there are no dependencies: the extension is plain JavaScript.

```
npm test             the test suite (a stand-in Salesforce CLI and a small in-memory org)
npm run package      builds dist/permission-studio-<version>.vsix with only Node.js
```

[RELEASING.md](RELEASING.md) covers building, GitHub releases and, later, the Marketplace. [CHANGELOG.md](CHANGELOG.md) lists what changed in each version.
