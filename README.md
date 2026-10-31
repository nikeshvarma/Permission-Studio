# Permission Studio

View and edit Salesforce permission sets, permission set groups and profiles without leaving VS Code. Permission Studio works on your project's default org and signs in the way the Salesforce CLI does, so there is nothing extra to set up.

Developed by Nikesh Varma.

![Permission Studio showing a permission set's object settings, with colour-coded Read, Create, Edit, Delete, View All and Modify All tags](media/readme/overview.png)

## Why

Checking or changing access in Setup means a lot of clicking: open the permission set, open Object Settings, open the object, find the field, edit, save, then do it again for the next permission set. Answering "who can edit this field?" means checking every profile, permission set and group by hand.

Permission Studio puts all of it on one screen in VS Code, next to your code. Every change is reviewed before it is saved, checked against what is in the org right now, and can be undone.

## What it does

**Edit like Setup, then review before anything is saved.** Object, field, record type and system permissions, Apex class, Visualforce page, flow and app access, custom permissions, tab settings and more are checkboxes, grouped the way Setup groups a permission set. Permission rules apply as you click: granting Edit also grants Read, and Modify All brings everything below it. Changes are highlighted and counted until you save.

![An object's page with object permissions, record type assignments and field permissions, three changes waiting to be saved](media/readme/editing.png)

**Every save is checked first.** Save opens a review of every change. On a production org you type the org's name to confirm.

![The review dialog listing each change, with the production org name typed to confirm](media/readme/review.png)

**Find out who has access.** Pick an object or a field and an access level. You get every active user who has it, and where each part comes from: object access and field access can come from different permission sets, profiles or groups. View All Data, Modify All Data and View All Fields are counted too.

![Find access results: users who can edit Lead.Rating, with the permission sets, profiles and groups that grant it](media/readme/find-access.png)

**Grant access in bulk.** **Grant field access** gives fields Read or Read and Edit across many permission sets and profiles at once. **Grant object access** does the same for object permissions and record types, including profile defaults. The review shows what changes on each item; access is only ever added.

![Grant field access: two new custom fields selected, Read and Edit chosen, four permission sets and profiles picked](media/readme/grant-field-access.png)

**Manage permission set groups.** Add or remove a group's member permission sets. Salesforce recalculates the group in the background; the status shows while it runs, and the group's access refreshes when it finishes.

![A permission set group's members, one being added, with the recalculation in progress](media/readme/groups.png)

**Every save in History.** Undo any save, or copy saves as a table for an ADO or Jira ticket, a design document or an Excel workbook.

![Save history with two saves selected for copying as a summary](media/readme/history.png)

**And more:**

- **Assignments:** see who has a permission set or group, add or remove users, and set expiry dates.
- **Profile-only settings:** page layout assignments, login hours and login IP ranges.
- **Rename and clone** permission sets.
- **Favorites:** star the items and objects you use most; they load first and open instantly.
- **Open from a file:** right-click a permission set, profile or group file and choose **Open in Permission Studio**, or use **Permission Studio: Open Item…** in the Command Palette.
- **Keep your source in step:** optionally update the project's `.permissionset-meta.xml` or `.profile-meta.xml` after a save, ready to commit.
- **Easy to read:** colour-coded permissions, **High impact** tags on org-wide system permissions, and warnings on assignments that expire soon.
- **Light or dark:** the screen follows your VS Code theme.

![The same permission set in a light theme](media/readme/light-theme.png)

## How it works

![How Permission Studio reads from your org through the Salesforce CLI's own connection, and the six steps of every save: review, check, snapshot, write, verify, record](media/readme/how-it-works.png)

**Reading.** Permission Studio loads the Salesforce CLI's own connection library and runs it inside VS Code. It uses the CLI's sign-in, token renewal, proxy settings and network route, without starting an `sf` process for each call. Screens open at once from what you saw last time and refresh from the org in the background; lists are only re-read when something in the org changed.

**Saving.** Only the records that change are written. Before writing, every changed entry is read again, so an edit someone made in Setup since you loaded the screen is never silently overwritten. The values from just before the save are kept as a snapshot for undo. Afterwards everything is read back, and anything the org did not take is reported. Record types, page layouts, login settings and tabs go through the Metadata API; each deploy is preceded by a full copy of the item's access, and anything a deploy removed can be restored in one click.

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
| Tab Settings | Yes | — | Metadata API deploy |
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
