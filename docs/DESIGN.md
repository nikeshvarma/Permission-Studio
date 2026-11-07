# Permission Studio: technical design

Permission Studio is a VS Code extension for viewing, comparing and updating Salesforce permission sets, permission set groups and profiles without going through Setup. The first users are a delivery team working across several sandboxes and production. The code is written so the extension can be published to the Marketplace without changes.

This document covers scope, architecture, how permissions are read and written, the safety model, testing, and a phased roadmap sized for part-time evening work.

## 1. Scope

### In scope for v1

The extension covers Permission Sets, Profiles and Permission Set Groups. Muting permission sets and permission set licenses are out of scope. A group's calculated permissions are still shown correctly, because they are read from the group's aggregate permission set, which already has muting applied.

These are the problems it solves, in priority order:

1. Setup is slow to navigate when checking or changing access.
2. Comparing access across orgs (for example UAT against Production) is manual.
3. Finding who has access to a field or object takes too long.
4. Profile XML in Git diffs is noisy.
5. Bulk permission changes are tedious.

### Key decisions

| Area | Decision |
| --- | --- |
| Packaging | Standalone extension. Proven modules from the Copado Release Assistant codebase are copied in where that saves time; there is no runtime dependency between the two. |
| Source of truth | Live org and local source, with a sync indicator between them |
| Saving | 1.0.1 writes only the changed permission records (direct DML). The local XML plus deploy path follows once spike S5 confirms partial deploys leave other entries untouched. |
| Authentication | The Salesforce CLI's session for the default org, renewed through the CLI when it expires |
| Orgs | Only the project's default org (`target-org` of the open SFDX project). Changing it reloads the screen. |
| Production | Writes are allowed after the user types the org name to confirm |
| Categories | All permission categories, including profile-only ones (layouts, login hours, IP ranges) |
| Views | One main screen in the editor area (no sidebar): item list on the left, detail on the right; matrix and compare open as further editor tabs |
| Reverse lookup | Yes, down to the users who end up with access. Built in 1.0.3 as Find access |
| Effective access per user | Later phase |
| Editing | Single toggles and bulk edits; dependent permissions applied automatically; all edits staged and reviewed before apply |
| Lifecycle | Clone, rename and edit description. Creating permission sets and deleting them are not offered (create removed in 2.0.0) |
| Assignments | Assign and remove permission sets and groups for users, with expiry dates. Built in 1.0.3 |
| Compare | PS vs PS, profile vs profile, local vs org, and the same item in another authorised org (picked inside the compare view only) |
| Drift detection | Later phase |
| Audit | Overly permissive access; unused permission sets |
| Export | Removed in 2.0.0 |
| XML normalisation | Optional setting |
| Deploy files | package.xml |
| Copado | Not in v1 |
| Rollback | Snapshot before every apply, one-click restore |
| Start-up and refresh | 2.0.0: starts loading in the background when a Salesforce project opens; refreshes every 1–30 minutes while VS Code has focus, re-reading the lists only when the org's change stamp moved |
| Lists shown | 2.0.0: permission sets and profiles by default; groups optional (`permStudio.lists.show`), and unchosen lists are not loaded |
| Object access wizard | 2.0.0: object permissions (added, never removed) and record type assignments, with profile defaults, across many permission sets and profiles |
| Field access wizard | Added in 1.0.3: one or more fields, Read or Read and Edit, across many permission sets and profiles; one save per item |
| Save history | Added in 1.0.3: the change log as a screen; any save can be undone through review |
| Local source file | Added in 1.0.3: after a save, the project's permission set or profile file is updated in place (optional) |
| Favorites | Added in 1.0.2: starred items and objects (two settings) load first, sit at the top, and are prefetched in the background |
| Caching | Revised in 1.0.1: everything viewed is cached per org in extension storage and refreshed in the background (stale-while-revalidate) |
| Change log | Yes, local |
| Testing | Unit tests with mocked responses; integration tests against a dev sandbox |

### Target scale

The design is sized for orgs with about 1,000 permission sets, 100 profiles, 800 fields on the largest object and 100 active users. Section 4.3 explains how reads stay fast at that size without a cache.

## 2. Architecture

```
VS Code
  ├─ Main screen ───────┐   webviews: plain HTML/JS, postMessage only
  │   (list + detail)   │
  ├─ Matrix panel ──────┤
  ├─ Compare panel ─────┤
  └─ Staging panel ─────┘
            │
   Canonical permission model ── dependency rules ── diff ── change set
            │                                                    │
   ┌────────┴─────────┐                              ┌───────────┴───────────┐
 live loader      XML reader/writer               apply: DML         apply: delta deploy
   │                   │                              │                       │
 REST API          force-app/ files               REST API              sf project deploy
   │
 token from `sf org display`, renewed through the CLI (memory only)
 or, when REST is refused or blocked: every call through `sf data query` / `sf sobject describe`
```

The core idea is the **canonical model**. Live org data and local XML are both converted into one shape: a map of `category:name` keys to permission flags, for example `field:Lead.Rating → { read: true, edit: false }`. Every feature works on that shape. Views render it, the diff compares two of them, dependency rules edit it, the change set stages edits against it, and snapshots store parts of it. Because of this, "UAT against Production" and "local file against org" are the same comparison.

### Module map

| Module | Responsibility | Status |
| --- | --- | --- |
| `src/org/sfcli.js` | Spawns `sf ... --json` with Windows-safe quoting | Built |
| `src/org/orgs.js` | Detects production from the org | Built |
| `src/org/connection.js` | Library, REST (Node https: VS Code proxy and system certificates, gzip, Composite batching) and CLI transports; token renewal through the CLI; automatic switch | Built |
| `src/org/sfcore.js` | Finds and loads the Salesforce CLI's `@salesforce/core` inside VS Code | Built (2.0.1) |
| `src/data/catalog.js` | Lists permission sets, groups and profiles | Built |
| `src/data/loader.js` | Reads permissions live into the model, in parallel | Built for object, field and system permissions |
| `src/model/model.js` | Canonical model and XML-to-model conversion for all categories | Built |
| `src/model/dependencies.js` | Object and field dependency rules | Built |
| `src/data/insight.js` | One user's combined access (User access) and comparing two items, in one org or across two (Compare) | Built |
| `src/model/diff.js` | Which flags of an entry differ (conflict checks and read-back after a save) | Built |
| `src/changes/changeSet.js` | Removed in 2.2.1: staging lives in the screen; conflict checks, snapshots and undo in the save path (`apply.js`) | Removed |
| `src/xml/flatXml.js` | Fast reader for permission XML | Built |
| `src/org/project.js` | Finds the SFDX project and its default org | Built |
| `src/views/mainPanel.js`, `media/app.js` | Main screen: Lightning-style record page with editing, review and undo | Built |
| `src/data/cache.js` | Per-org disk cache with stale-while-revalidate | Built |
| `src/changes/apply.js` | Record-level save: conflict check, snapshot, write, verify | Built |
| `src/changes/history.js` | Snapshots and change log in `.permstudio/` | Built |
| `src/org/metadata.js` | Retrieve and guarded deploy for record types, page layouts, login hours, IP ranges and tab settings; full safety copy, removal check and restore | Built |
| `src/xml/localFile.js` | In-place updates of the project's source files | Built |
| `src/xml/writer.js` | In-place XML edits and optional normalisation | Phase 3 |
| `src/changes/applyDeploy.js` | Deploying a whole local file as the save path | Not planned; 1.0.3 writes records (or a guarded delta deploy) and then updates the local file |
| `src/views/matrixPanel.js`, `comparePanel.js`, `lookupPanel.js`, `stagingPanel.js` | Remaining views | Phases 1 to 3 |
| `src/reports/audit.js`, `src/export/*` | Audit reports and exports | Phases 2 and 5 |

### Reused from Copado Release Assistant

Several pieces carry over, either already rebuilt here or ready to copy:

- **CLI wrapper.** The `--json` handling, the warning-tolerant JSON parse, and the cmd.exe quoting fix for project paths with spaces.
- **XML formatter.** Specifically its case-sensitive ordering, which matches how Salesforce writes entries. That lesson came from the merge engine.
- **Worker-thread pattern.** Used for any XML work on very large files, so the UI does not freeze.
- **Test harness.** The hand-written `vscode` stand-in and the fake `sf` script.

## 3. Connecting to the org

### 3.1 Which org

The extension works on one org: the default org of the Salesforce project open in VS Code.

**Finding the project.** The project is chosen in this order:

1. The `permStudio.project.path` setting, if set.
2. Otherwise, the workspace folder that holds `sfdx-project.json`. If there are several, the one containing the active editor's file is used.
3. Otherwise, the first `sfdx-project.json` found below a workspace folder.

**Finding the default org.** The default org is read with `sf config get target-org`, run in the project folder. This gives the same precedence every other `sf` command uses: the project's `.sf/config.json` (or the older `.sfdx/sfdx-config.json`) first, then the global config.

The extension watches those files, so switching the default org reloads the screen for the new org. Switching can happen from the terminal or from the Salesforce extensions' org picker. A change that leaves the org the same does nothing.

### 3.2 Session

**Since 2.0.1 the first choice is the Salesforce CLI's own connection library.** It is `@salesforce/core`, found on disk without starting `sf` (the CLI's self-update folders, layouts derived from where `sf` sits on PATH, standard install folders, or `permStudio.sf.installPath`). Only if that fails is it asked from `sf version --verbose`, whose `--json` output is the bare oclif object, not the usual `{ status, result }` wrapper (2.0.1 misread it). The location is remembered in VS Code's global state, and the library is loaded inside VS Code. Requests then use the CLI's session, token renewal, proxy handling and network route, with no `sf` process per call and none at start-up once the location is known.

This was added after a user's log showed direct REST getting `401` even straight after the CLI renewed the token. The error code, logged from 2.0.2, was `INVALID_AUTH_HEADER` on two unrelated orgs: Salesforce found the token handed out by `sf org display` malformed as a bearer token. The library sidesteps this because it reads and renews the session itself. The steps below apply when the library can't be loaded.



`sf org display` returns the stored access token without renewing it. An expired token therefore stays expired no matter how often it is asked for. This was the cause of the "session expired" failures in 0.1.0.

The connection now works like this:

1. It starts from the `sf org display` result.
2. On a 401, it runs one cheap CLI query (`sf data query`). This makes the CLI renew its token and save the new one. The extension then reads the token again and retries.
3. If the direct call is still refused, or the HTTP request never gets an answer (a proxy, TLS inspection or a missing corporate certificate), the connection switches to the CLI transport for the rest of the session. From then on, every query, count and describe goes through `sf data query` and `sf sobject describe`.
4. If the CLI cannot renew the session either, the person is told to run `sf org login web`.

The CLI transport is slower, but it uses the CLI's own session handling, proxy and certificate settings. The screen shows a "CLI connection" badge while it is in use, and the `permStudio.connection.mode` setting can force either transport.

Every query is kept under 5,000 characters and split if longer. That keeps REST URLs under their length limit and CLI command lines under cmd.exe's 8,191-character limit.

Tokens are held in memory only and never logged or sent to the webview.

### 3.3 Production

Production is determined from `Organization.IsSandbox` and `TrialExpirationDate`, never from an alias. Developer Edition orgs are therefore treated as production, which is the safe side to err on.

## 4. Reading permissions

### 4.1 Every profile and group is a PermissionSet

Every profile has a backing PermissionSet record (`IsOwnedByProfile = true`). Every permission set group has an aggregate PermissionSet record (`PermissionSetGroupId` set), which holds the group's calculated permissions after muting. So one loader serves all three kinds. Each list item carries both the record the person sees (Profile, group or permission set) and the PermissionSet the permissions are read from.

### 4.2 Where each category is read from, and how it can be written

| Category | Live read | Direct DML write | XML + deploy write |
| --- | --- | --- | --- |
| Object (CRUD, View All, Modify All, View All Fields) | `ObjectPermissions` | Yes | Yes |
| Field-level security | `FieldPermissions` | Yes | Yes |
| System permissions | `PermissionSet.Permissions*` columns | Yes for permission sets; profiles to be verified (spike S1) | Yes |
| Apex classes, Visualforce pages, custom permissions, custom metadata and custom setting access | `SetupEntityAccess` | Yes (insert/delete); Apex classes and custom permissions built in 1.0.2 | Yes |
| Connected apps | `SetupEntityAccess` | Yes, built in 1.0.3 | Not in the permission set or profile XML |
| Flow access | `SetupEntityAccess` (FlowDefinitionView.DurableId) | Yes, built in 1.0.3; to be verified (S2) | Yes |
| Tab settings | `PermissionSetTabSetting` for permission sets; metadata for profiles | No: saved by guarded deploy (permission sets, 1.0.3) | Yes |
| App visibility | `SetupEntityAccess` (TabSet) | Visibility only, built in 1.0.3 | Yes |
| Record type visibility | Targeted metadata retrieve (built in 1.0.2) | No | Yes, guarded deploy of changed entries only (built in 1.0.2) |
| Page layout assignments (profiles) | Targeted metadata retrieve (built in 1.0.3) | No | Yes, guarded deploy (built in 1.0.3) |
| Login hours and IP ranges (profiles) | Targeted metadata retrieve (built in 1.0.3) | No | Yes, guarded deploy of the whole list, re-read afterwards (built in 1.0.3) |

The query field lists come from `describe`, not from hard-coded lists. That way the same code works across API versions (`PermissionsViewAllFields` does not exist on older ones) and picks up new system permissions as Salesforce adds them.

**Targeted metadata retrieve.** Four categories have no queryable object: record type visibility, layout assignments, login hours and IP ranges. For these, the extension retrieves the single Profile or Permission Set into a temporary folder outside `force-app`, using a manifest that also lists the related RecordType and Layout members. The Metadata API only returns a profile's record type and layout entries for the components named in the same manifest. A plain profile retrieve therefore looks complete but is not, which is also why local profile files are compared with scope "left" (section 7).

### 4.3 Volume, speed and caching

Since 2.0.0, a whole screen's data is one Composite request of up to 25 queries. System permissions are a single `SELECT FIELDS(STANDARD) FROM PermissionSet WHERE Id = …` (column slices only where an org refuses `FIELDS()`), and responses are gzip-compressed. REST calls go through Node's `https` module, which VS Code connects to its proxy settings and the operating system's certificate store; global `fetch` was not, which is the most likely reason some networks ended up on the slower CLI connection.


Reads stay bounded by scoping every query:

- **Field permissions** are read one object at a time, as Salesforce's own Object Settings page does.
- **System permissions** are read in slices that keep each query under 5,000 characters. The slices run in parallel.
- **Object permissions, system permissions, labels and the assignee count** are read in parallel, with at most four requests in flight per connection.

Everything a screen shows is cached per org username in the extension's global storage, never in the project:

- the item lists
- each item's detail
- each object page
- the object catalogue
- describes

Opening the screen, an item or an object shows the cached copy at once, marked "Refreshing…", and the fresh copy replaces it when it lands. If the org can't be reached, the cached copy stays on screen with an "Offline · saved data" badge.

Describes are reused for 24 hours. Refresh re-reads everything, including describes.

After a save, cached object pages of that item from before the save are ignored.

The default org is read from the CLI's config files (`.sf/config.json`, `~/.sfdx/alias.json`), using the CLI's precedence. So cached data can appear before any `sf` process has started. The CLI is asked only when the files don't settle it.

Tokens are never cached.

### 4.4 Reverse lookup: "who can edit Opportunity.Some_Field__c"

The lookup runs in four steps:

1. Find every PermissionSet that grants the field:
   - field-level grants through `FieldPermissions` where `Field = 'Opportunity.Some_Field__c'`
   - object-level grants that cover the field, through `ObjectPermissions` with View All Fields on the object
   - system-level grants through `PermissionSet` with `PermissionsViewAllData` or `PermissionsModifyAllData`
2. Do the same for the object permission the action needs, for example object Edit for field Edit.
3. Classify each source as a profile, a group aggregate or a regular permission set. Component permission sets inside groups are labelled "granted through group X".
4. Load active assignments through `PermissionSetAssignment` (profile and group assignments appear there too). For each user, check that some assigned source grants the field access **and** some source grants the object access. These can come from different sets, because a user's access is the union of everything assigned to them.

With 100 active users this is a handful of queries. The result has two parts: the sources that grant the access, and the users who end up with it. Each user row shows which sources supply each half of the access.

## 5. Writing permissions

### 5.1 Staging

Every edit goes into a change set first. This includes single toggles, bulk edits from the matrix, and generated rollbacks. The staging panel shows a diff grouped by item and category, with implied changes marked (for example "Read added because Edit was granted"). Toggling a value back to where it started removes the item from the set.

### 5.2 Dependency rules (applied automatically)

| Granting | Also grants |
| --- | --- |
| Create, Edit, View All, View All Fields | Read |
| Delete | Read, Edit |
| Modify All | Read, Edit, Delete, View All |
| Field Edit | Field Read |

Revoking a permission also revokes everything that depends on it. For example, revoking object Read clears all object flags, and revoking field Read clears field Edit.

Some field changes are blocked outright, using the object's describe:

- Fields with `permissionable = false` (required and universally required fields) cannot have field-level security set.
- Read-only fields (formula, roll-up, auto number) cannot be granted Edit.

Granting field access without the matching object access gives a warning rather than an automatic grant. The object access may come from another permission set, and granting it automatically would widen access silently.

System permission dependencies are read per org from the `PermissionDependency` object rather than hard-coded (spike S3 confirms availability).

Standard profiles and managed-package permission sets are shown read-only.

### 5.3 Path A: local XML plus delta deploy (after spike S5)

This path runs in seven steps:

1. **Re-read and compare.** Every touched entry is read live again and compared with the value it was staged against. Anything changed in Setup since then is shown and must be confirmed.
2. **Snapshot.** That same re-read is saved as the snapshot (section 5.5).
3. **Update the local file.** The local `force-app` file is edited in place, keeping its formatting. The parser records each entry's position, so only changed entries are rewritten and new entries are inserted in Salesforce's case-sensitive order. If normalisation is switched on, the whole file is sorted and deduplicated instead.
4. **Build a delta package.** A separate metadata-format package is built in a temporary folder. It contains `package.xml` and a permission set or profile file with only the changed entries. Revokes are written as explicit `false` values, not omitted. This means the deploy can never push unrelated, possibly stale, values from the local file, and a removed entry is really removed in the org.
5. **Deploy.** The package is deployed with `sf project deploy start --metadata-dir <temp> --target-org <org>`. A validate-only run (`--dry-run`) is offered first.
6. **Verify.** The touched entries are read live again to confirm the result, and the outcome is written to the change log.
7. **Check groups.** If any changed permission set is a component of a group, the group's status is polled until it leaves `Updating`, and the group is marked as recalculating until then.

Profile names are encoded for metadata file names (for example `Custom%3A Sales` for a colon). Phase 3 adds tests for this encoding.

### 5.4 Path B: direct record writes (built in 1.0.1)

Path B is offered only when every item in the change set can be written this way (see the table in 4.2). In 1.0.1 it covers object, field and system permissions.

**How it writes.** Object and field permissions go through sObject Collections, 200 records per call with all-or-none. System permissions are one update of the PermissionSet record. Revoking all access deletes the row.

**Order of writes.** Grants run before revokes. Object rows are written before their fields when access is added, and after them when it is removed.

**CLI transport.** On the CLI transport the same writes go through `sf data create/update/delete record`.

**Request failures.** If a write's HTTP request never gets an answer, the change is reported as possibly applied. It is not retried, and the screen re-reads the org.

The re-read, snapshot, verify and log steps are the same as in Path A. The local file is not touched, and the staging panel says so. The sync indicator will then show the item as "differs" until the file is retrieved or updated.

### 5.5 Snapshots and rollback

Before every apply, the live values of every touched entry are written to `.permstudio/snapshots/<timestamp>-<org>.json` in the project. "Restore snapshot" lists them and stages the inverse change set, which goes through the normal review and apply flow. The same checks and production guard apply.

### 5.6 Production guard

Applying to an org detected as production opens a modal that shows the change summary. The person must type the org's alias or username to continue. There is no setting to turn this off.

### 5.7 Change log

Each apply appends one line to `.permstudio/log/changes.jsonl` with:

- the time
- the org username
- the path used (deploy or DML)
- the items changed
- the deploy Id, if any
- the result

`.permstudio/` is in `.gitignore` by default. Snapshots and logs hold permission data but never tokens.

### 5.8 Lifecycle and assignments

**Create and rename.** A new permission set is inserted through DML with its API name, label, description and license. Rename edits the label and description.

**Clone.** Clone reads the source live, including a targeted retrieve for the metadata-only categories. It creates the new permission set, then stages all the entries as a normal change set against it.

**Assignments.** Assigning and removing permission sets and groups uses `PermissionSetAssignment` inserts and deletes. Assignments are data, not metadata, so they always go through DML. They are still staged, snapshotted and logged.

## 6. Views

**Main screen.** One webview panel in the editor area, opened from the status bar (which shows the default org) or the Command Palette. A top bar shows the org, a Production badge, the connection mode and the project folder. On the left are tabs for Permission Sets, Groups and Profiles, with counts, search, and markers for managed, standard and group recalculation status. The selected item's detail fills the rest. There is no sidebar.

**Record page (1.0.1).** The right-hand side of the main screen is laid out like a Lightning record page:

- **Page header:** an icon tile, the type and name, and a highlights panel (API name, license, active users, last modified).
- **Tabs:** Object Settings and System Permissions.
- **Object pages:** open from Object Settings, with an Object Permissions card and a Field Permissions data table. Its Read and Edit header checkboxes act on every field shown.
- **Editing:** changed cells are highlighted, and permissions added by the rules are tagged "auto". A docked Cancel / Save footer appears while there are unsaved changes.
- **Review:** a review dialog, with typed confirmation on production, then toasts with Undo.
- **Speed:** a click redraws only the rows it changes, so an object with 800 fields still responds in under 20 ms.

**Detail (planned categories).** Further tabs follow for the remaining categories. It has filter, "show only granted", and "show only differences" when a compare target is set. In phase 0 it is read-only, covering object and system permissions.

**Matrix.** Rows are the fields of one object (from describe, permissionable fields only). Columns are permission sets and profiles chosen from a picker. Rows are virtualised so 800 fields scroll smoothly. Each cell shows Read and Edit and stages a change on click. There is a second mode with objects as rows and CRUD columns. Bulk edits apply one change to a selected block of rows and columns.

**Compare.** Two items side by side, from the same or different orgs, or a local file against its org. It shows only differences by default, with per-category counts.

**Lookup.** Pick an object or field and an access level, and the results show the granting sources and the users with that access.

**Staging.** Shows pending changes, their implied changes, the apply path, and the dry-run and apply buttons.

**Webviews.** All webviews are plain HTML and JavaScript, as in Copado Release Assistant. They use a nonce-based content security policy and VS Code theme variables, and communicate with the extension only through `postMessage`.

## 7. Sync indicator

When an item is opened, and on request for a whole folder, the extension looks for the matching file in the SFDX project and compares it with the live model.

| State | Meaning |
| --- | --- |
| In sync | Every entry in the local file matches the org |
| Differs | At least one entry differs; the compare view opens on click |
| Org only | No local file for this item |
| Local only | A local file with no matching item in the org |

Profile files are compared with scope "left": only entries present in the file are checked. A profile file only holds the components it was retrieved with, so without this every profile would show as "differs".

## 8. Audit and export

**Overly permissive access** lists every source that grants Modify All Data, View All Data, or object-level Modify All / View All. Each source is shown with its active assignee count.

**Unused permission sets** lists regular permission sets with no assignments that are not a component of any group. Excluding group components matters, because a permission set used only inside a group has no direct assignments by design.

**Exports.** Removed in 2.0.0.

## 9. Security and Marketplace readiness

The extension is built to the following standards:

- **No stored credentials.** The extension stores no credentials and sends no telemetry.
- **Workspace Trust.** The extension does not run in untrusted workspaces, because it executes the CLI.
- **Generic content.** No client or org names appear in shipped files. A test enforces this.
- **Text-only README.** Diagrams are text, so the extension page renders the same when sideloaded or installed from the Marketplace.
- **Before publishing.** A publisher Id and a license file are still needed.
- **Requirements.** VS Code 1.85 or later and Salesforce CLI v2.

## 10. Testing

Run `node test/smoke.js`. It runs the whole suite against three stand-ins. The webview is also rendered and clicked through in headless Chrome, in dark and light themes, before each release. That pass covers editing, implied permissions, bulk edits, review, production confirmation, save, undo, the discard guard and read-only items.

- a fake `sf` that produces the CLI's real JSON envelopes, including warnings printed before the JSON, and that behaves like the real CLI on expired tokens
- a small stateful org behind a local HTTP server (`test/fixtures/fake-org.js`). It answers the SOQL the extension sends, describes, and sObject Collections writes with all-or-none. It enforces platform rules such as Edit needing Read and Modify All Data needing View All Data.
- the `vscode` stand-in

The current 91 checks cover:

- cmd.exe quoting
- CLI output and error parsing
- project and default-org resolution
- connection paging, token renewal through the CLI, and the switch to the CLI transport when REST is refused or blocked
- production detection
- SOQL escaping and Id validation
- the catalog, the loaders and their query slicing
- permission set and profile XML, including a 50,000-line file (parsed in about 120 ms)
- dependency rules
- diff semantics
- the change set
- the disk cache and stale-while-revalidate
- record writes (REST and CLI), saving with conflict checks, snapshots, verification and rules enforced on the way in
- the panel's cached-first loading and save flow
- favourites first on a cold start, and prefetching
- Apex class and custom permission access
- record type retrieve and deploy, including a deploy that wipes other access being caught and restored
- every setup-entity category, assignments with expiry, tab settings, page layouts, login hours and IP ranges (including an org that adds ranges instead of replacing them being reported)
- who has access, both wizards, rename and clone, save history and undo, and local file updates
- 2.0.1: the CLI library connection, including the case where direct REST is refused but the CLI's route works, and the fallback when the library can't be loaded
- 2.0.0: background start (the screen joins the running load), auto-refresh with change detection and the focus rule, the list choice, Composite batching (30 queries in 2 round trips), gzip, the FIELDS() fallback
- activation wiring and the main screen, including stale-response handling
- the no-client-names and no-dead-code checks

Phase 1 adds integration tests that run against a dedicated dev sandbox (`npm run test:org -- --target-org <alias>`). They are read-only except for one throwaway permission set, `PSTUDIO_TEST`, which the run creates and deletes. Each verification spike below becomes an integration test once settled.

## 11. Roadmap

The estimates assume roughly eight to ten hours a week.

| Phase | Delivers | Problems addressed | Estimate |
| --- | --- | --- | --- |
| 0. Foundation | Default-org connection with CLI fallback, main screen, read-only detail for object and system permissions, model, dependency rules, diff, change set, test harness | Groundwork | Done (1.0.0) |
| 1. See everything | Done in 1.0.3: every category, reverse lookup with users. Still to do: matrix across permission sets | 1, 3 | 1 week remaining |
| 2. Compare | Deferred at your request | 2 | |
| 3. Safe editing | Done in 1.0.1 for object, field and system permissions: staging, review, conflict check, snapshots and undo, production guard, change log, record-level save. Still to do: in-place XML edits, delta deploy with dry run, package.xml, optional normalisation (after S5) | 4 | 3 weeks remaining |
| 4. Direct and bulk | Done: record-level save, bulk field edits, field access wizard, create, clone, rename, assignments, every category | 5 | Done (1.0.3) |
| 5. Audit and release | Still to do: audit reports, Marketplace packaging (export removed in 2.0.0) | | 1–2 weeks |
| Later | Effective access per user, Git-to-org drift detection, Copado integration | | |

## 12. Risks and items to verify in the sandbox

Each spike is a short script run against the dev sandbox at the start of the phase that needs it.

| Id | Question | Needed by | Fallback if the answer is no |
| --- | --- | --- | --- |
| S1 | Can system permissions on a profile's PermissionSet be updated through DML? | Phase 4 | System permission edits on profiles always use the deploy path |
| S2 | Are flow access (`SetupEntityAccess`) and `PermissionSetTabSetting` writable through DML? | Phase 4 | Those categories always use the deploy path |
| S3 | Is `PermissionDependency` queryable at the org's API version? | Phase 3 | Ship a maintained rules file and let the org reject the rest |
| S4 | Settled in 1.0.0: `sf org display` does not renew tokens, so renewal goes through a CLI query (section 3.2) | Done | |
| S6 | Is `EntityDefinition.DurableId` the SetupEntityId for custom metadata types and custom settings, and `FlowDefinitionView.DurableId` for flows? | 1.0.3 | Show those sections read-only |
| S7 | Is `PermissionSetAssignment.ExpirationDate` a date or a datetime in the org? (Read from describe; both are handled) | 1.0.3 | — |
| S5 | Delta deploy: are omitted entries left untouched, and are explicit `false` values honoured for every category? Record type saves (1.0.2) answer this per org on first use: every deploy is preceded by a full copy and followed by a removal check with one-click restore | Phase 3 | Restore from the safety copy, then deploy the full entry set for the touched categories |

Other known risks and how the design handles them:

- **Group recalculation lag.** After a component permission set changes, the group's calculated permissions are stale until its status returns to `Updated`. The item list and the detail view show the status, and lookups flag group-sourced results while it lasts.
- **API request limits.** A matrix load costs about one request per 2,000 rows. The heaviest flows at the target scale stay in the low hundreds of requests. The request count per action is logged so it can be watched.
- **Concurrent Setup edits.** These are handled by the re-read before apply (5.3, step 1).
- **Read-only items.** Editing standard profiles or managed-package permission sets is blocked in the UI rather than left to fail at deploy.
