# Permission Studio

View and edit Salesforce permission sets, permission set groups and profiles without leaving VS Code. Permission Studio works on your project's default org and signs in the way the Salesforce CLI does, so there is nothing extra to set up.

Developed by Nikesh Varma.

![Permission Studio showing a permission set's object settings, with colour-coded Read, Create, Edit, Delete, View All and Modify All tags](media/readme/overview.png)

## Why

Checking or changing access in Setup means a lot of clicking: open the permission set, open Object Settings, open the object, find the field, edit, save, then do it again for the next permission set. Answering "who can edit this field?" means checking every profile, permission set and group by hand.

Permission Studio puts all of it on one screen in VS Code, next to your code. Every change is reviewed before it is saved, checked against what is in the org right now, and can be undone.

## What it does

**Edit like Setup, then review before anything is saved.** Object, field, record type and system permissions, Apex class, Visualforce page, flow and app access, custom permissions, tab settings and more are checkboxes, grouped the way Setup groups a permission set. Permission rules apply as you click: granting Edit also grants Read, and Modify All brings everything below it. System and custom permissions follow Salesforce's own dependency rules, read from the org: turning on Modify All Data also turns on what it needs. Changes are highlighted and counted until you save.

![An object's page with object permissions, record type assignments and field permissions, three changes waiting to be saved](media/readme/editing.png)

**Every save is checked first.** Save opens a review that starts with the impact: how many users are affected, which high-impact permissions are granted and what access is removed. Then every change on one line, where you can drop any single change. Add a ticket such as an JIRA story and it follows the save into History and copied summaries. On a production org you type the org's name to confirm. Ctrl/Cmd+S opens the review and saves from it.

![The review: changes, users affected, high-impact permissions and removals first, then each change on one line with granted chips and a button to remove it](media/readme/review.png)

**Find out who has access.** Type an object or a field (`Lead.Rating`), filter by profile, license, source or user status, and use **Why?** to see exactly how each user gets the access, even through a group's member permission sets. Remove the access from selected sources, or grant it to more, straight from the results.

It works for system and custom permissions too, such as Modify All Data or Use Any API Client. View All Data, Modify All Data and View All Fields are counted.

![Find access for Lead.Rating: filters, users with the permission sets, profiles and groups that grant it, how one user gets it through a group, and the sources](media/readme/find-access.png)

**Grant access in bulk.** **Grant field access** gives fields Read or Read and Edit across many permission sets and profiles at once. **Grant object access** does the same for object permissions and record types, including profile defaults. The review shows what changes on each item; access is only ever added.

![Grant field access: two fields chosen, each permission set's and profile's current access next to what will change, and a running summary](media/readme/grant-field-access.png)

![Grant object access: a grid of permission sets and profiles by object permission, with what's already granted and what will be added](media/readme/grant-object-access.png)

**Manage permission set groups.** Add or remove a group's member permission sets, and mute permissions in the group: object, field and system permissions its permission sets grant can be turned off for the group's users without changing the permission sets themselves. A group without a muting permission set gets one in a click. Salesforce recalculates the group in the background; the status shows while it runs, and the group's access refreshes when it finishes.

![A permission set group's members, one being added, with the recalculation in progress](media/readme/groups.png)

![Muted Permissions on a permission set group: the object and system permissions its permission sets grant, with what is muted ticked](media/readme/muting.png)

**Newer kinds of access.** Agent access (Agentforce employee agents), external credential principals, external data sources, Service presence statuses and email routing addresses, for permission sets and profiles. They're read and saved with the Metadata API; a feature the org doesn't have says so.

**Profile settings.** A profile's default app and login flow, data category visibility, and its password and session policies, edited like everything else and reviewed before saving.

**User access policies and licences.** A permission set or group shows the user access policies that assign it automatically, and the review warns before you remove an assignment a policy may give back. Assigning a permission set to users who lack its permission set licence can assign the licence in the same save.

**See everything one user can do.** User access adds up a user's profile, permission sets and groups (with expiry dates), their permission set licences, and the object, field, system and custom permissions those add up to, each with the sources that grant it.

![User access: one user's sources of access, licences, and object and system permissions with where each comes from](media/readme/user-access.png)

**Compare.** Two permission sets, profiles or groups in this org, or the same one in another org the Salesforce CLI is signed in to: every object, field, system, app, Apex, Visualforce, flow, custom permission, custom metadata, custom setting and tab difference, filterable and copyable as Markdown.

![Compare: the same permission set in two orgs, with each difference](media/readme/compare.png)

**Every save in History.** Undo any save, or copy saves as a table for an ADO or Jira ticket, a design document or an Excel workbook.

![History grouped by day: saves with their changes and tickets, a failed save, and a change made in Setup](media/readme/history.png)

**And more:**

- **Assignments:** see who has a permission set or group, add or remove users, and set expiry dates.
- **Profile-only settings:** page layout assignments, login hours and login IP ranges.
- **Rename and clone** permission sets, or **copy a profile to a new permission set** (Salesforce's recommended permission-set-led model): its access, tab settings and record types, with the profile's user license. Nothing is removed from the profile.
- **License checks:** users who can't hold a permission set's license are flagged before you save. Session-based permission sets are tagged.
- **Changes in Setup:** who changed the open item in Setup recently, from Setup Audit Trail.
- **Favorites:** star the items and objects you use most; they load first and open instantly.
- **Open from a file:** right-click a permission set, profile or group file and choose **Open in Permission Studio**, or use **Permission Studio: Open Item…** in the Command Palette.
- **Keep your source in step:** optionally update the project's `.permissionset-meta.xml` or `.profile-meta.xml` after a save, ready to commit.
- **Easy to read:** colour-coded permissions, **High impact** tags on org-wide system permissions (including Use Any API Client and Approve Uninstalled Connected Apps), and warnings on assignments that expire soon.
- **Light or dark:** the screen follows your VS Code theme.

![The same permission set in a light theme](media/readme/light-theme.png)

## How it works

![How Permission Studio reads from your org through the Salesforce CLI's own connection, and the six steps of every save: review, check, snapshot, write, verify, record](media/readme/how-it-works.png)

**Reading.** Permission Studio loads the Salesforce CLI's own connection library and runs it inside VS Code. It uses the CLI's sign-in, token renewal, proxy settings and network route, without starting an `sf` process for each call. Screens open at once from what you saw last time and refresh from the org in the background; lists are only re-read when something in the org changed.

**Saving.** Only the records that change are written. Before writing, every changed entry is read again, so an edit someone made in Setup since you loaded the screen is never silently overwritten. The values from just before the save are kept as a snapshot for undo. Afterwards everything is read back, and anything the org did not take is reported. Tab settings are records too. Record types, page layouts and login settings go through the Metadata API; each deploy is preceded by a full copy of the item's access, and anything a deploy removed can be restored in one click.

## Getting started

You need:

- VS Code 1.85 or later
- Salesforce CLI v2 (`sf`)
- A Salesforce project (a folder with `sfdx-project.json`) with a default org: `sf config set target-org <alias>`

To install:

1. Download the latest `.vsix` from the repository's **Releases** page.
2. In VS Code, open the Extensions view, then **…** → **Install from VSIX…**, and pick the file. Or run `code --install-extension permission-studio-<version>.vsix`.
3. Open your Salesforce project. Permission Studio starts loading in the background straight away.
4. Click the shield in the status bar, or run **Permission Studio: Open** from the Command Palette.

The org is always the project's default org. Change it the usual way (`sf config set target-org <alias>`, or the org picker in the Salesforce extensions) and the screen switches to the new org on its own.

## What you can see and change

| Section | Permission sets | Profiles | Saved as |
| --- | --- | --- | --- |
| Assigned Apps; Apex Class, Visualforce Page, Flow and Connected App Access; Custom Permissions; Custom Metadata Types; Custom Settings | Yes | Yes | records |
| Object Settings: object and field permissions | Yes | Yes | records |
| Object Settings: record type assignments | Yes | Yes | Metadata API deploy |
| Object Settings: page layout assignments | — | Yes | Metadata API deploy |
| Tab Settings | Yes | Yes | records |
| System Permissions | Yes | Yes | records |
| Login Hours and Login IP Ranges | — | Yes | Metadata API deploy |
| Assignments, with expiry dates | Yes, and groups | Read-only list of users | records |
| Member permission sets | — | — | records (groups only) |

A group's access comes from its member permission sets, so on a group you change its members and assignments, and edit the permission sets themselves for anything else. Managed-package permission sets and groups are read-only apart from their assignments. Standard profiles are read-only.

## Safety and privacy

- **No credentials:** Permission Studio never asks for a password or stores a token. It uses the session the Salesforce CLI already holds, and tokens never appear in the log.
- **Cached screens:** they are kept in the extension's own storage, one folder per org, never in your project. **Permission Studio: Clear Cache** empties it.
- **Snapshots and the change log:** they are written to `.permstudio/` in the project, for History and undo. Add `.permstudio/` to your `.gitignore`.
- **Production:** saving to a production org always asks you to type the org's name. Whether an org is production is read from the org itself, never from its alias.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `permStudio.lists.show` | `["permissionSet", "profile"]` | Which lists to show and load: `permissionSet`, `group`, `profile` |
| `permStudio.autoRefresh.enabled` | `true` | Refresh in the background while VS Code has focus |
| `permStudio.autoRefresh.minutes` | `5` | Minutes between background refreshes, 1 to 30 |
| `permStudio.favorites.items` | `[]` | Favorite permission sets, groups and profiles, e.g. `"permissionSet:Sales_Operations"` |
| `permStudio.favorites.objects` | `[]` | Favorite objects, e.g. `"Lead"` |
| `permStudio.localFile.update` | `ask` | Update the project's source file after a save: `ask`, `always` or `never` |
| `permStudio.cache.enabled` | `true` | Open screens from the cache and refresh in the background |
| `permStudio.sf.path` | `sf` | Path to the Salesforce CLI |
| `permStudio.sf.installPath` | empty | The CLI's install folder (contains `node_modules/@salesforce/core`); empty finds it automatically |
| `permStudio.project.path` | empty | Project folder to use; empty uses the workspace folder with `sfdx-project.json` |
| `permStudio.apiVersion` | empty | API version for queries; empty uses what the CLI reports |
| `permStudio.connection.mode` | `auto` | `auto` (CLI library, then REST, then `sf` processes), `library`, `rest` or `cli` |

## Troubleshooting

**Permission Studio: Show Log** records each connection step and the reason for any fallback, including Salesforce's own error code. A **CLI connection** badge in the top bar means calls are going through `sf` processes, which is slower. If that happens, the log says why. Setting `permStudio.sf.installPath` to the CLI's folder usually brings back the faster connection. If the CLI can no longer renew the session, log in again with `sf org login web --alias <alias>`.

## Contributing

Bug reports, ideas and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report an issue, set up the code and send a change.

## Development

There is no build step and there are no dependencies: the extension is plain JavaScript.

```
npm test             the test suite (a stand-in Salesforce CLI and a small in-memory org)
npm run package      builds dist/permission-studio-<version>.vsix with only Node.js
```

[RELEASING.md](RELEASING.md) covers building, GitHub releases and, later, the Marketplace. [CHANGELOG.md](CHANGELOG.md) lists what changed in each version. Design notes are in [docs/DESIGN.md](docs/DESIGN.md).

## License

[MIT](LICENSE). Free to use, change and share, including in commercial work, as long as the copyright notice is kept.
