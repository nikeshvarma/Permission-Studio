# Building and releasing Permission Studio

This guide takes the source from a zip to a GitHub repository with downloadable releases, and later to the VS Code Marketplace.

## What you need

- **Node.js 18 or later.** Check with `node --version`. Nothing else is needed to build: the extension has no dependencies, so there is no `npm install`.
- **Git** and a **GitHub account.**
- Optional: the **GitHub CLI** (`gh`) for releasing from the terminal.

## 1. Unpack and build a .vsix

```
cd C:\dev
tar -xf permission-studio-2.0.5-source.zip
cd permission-studio
npm run package
```

This writes `dist\permission-studio-2.0.5.vsix`. Install it with:

```
code --install-extension dist\permission-studio-2.0.5.vsix --force
```

You can also install it from the Extensions view: **…** menu → **Install from VSIX…**.

`npm run package` uses `tools/package.js`, which needs nothing but Node.js and works offline. If you prefer Microsoft's own packager, `npm run package:vsce` does the same through `@vscode/vsce`; it downloads the tool on first use.

## 2. Run the tests

```
npm test
```

The test suite drives a stand-in Salesforce CLI through a shell script, so it runs on macOS, Linux, WSL and GitHub Actions. On plain Windows, run it in WSL or let GitHub Actions run it for you on every push (step 5).

## 3. Before the first push

**Licence.** The project is released under the MIT License (`LICENSE`, and `"license": "MIT"` in `package.json`). A test checks every file for client or org names.

**Add your repository's address** to `package.json`, next to `"publisher"`, replacing `<your-github-user>`. Besides linking the extension to its source, it lets the README's screenshots show on the extension's page in VS Code: packaging points them at the repository's files on GitHub, because VS Code only shows images from https addresses. For that the repository must be public, with the `media/readme` images pushed to its default branch. To check a build, run `node tools/check-readme.js dist/permission-studio-<version>.vsix`; it lists every README image and whether it will show, with the reason if not.

```json
"repository": { "type": "git", "url": "https://github.com/<your-github-user>/permission-studio.git" },
"bugs": { "url": "https://github.com/<your-github-user>/permission-studio/issues" },
"homepage": "https://github.com/<your-github-user>/permission-studio#readme",
```

## 4. Create the repository and push

On GitHub: **New repository** → name `permission-studio` → choose Public or Private → do **not** add a README, licence or .gitignore (the project has them) → **Create repository**. Then:

```
git init
git add .
git commit -m "Permission Studio 2.0.5"
git branch -M main
git remote add origin https://github.com/<your-github-user>/permission-studio.git
git push -u origin main
```

With a private repository, only people you invite can see the code and download releases.

## 5. What runs on GitHub

Two workflows come with the project, in `.github/workflows`:

- **CI** runs on every push and pull request. It runs the tests, builds the `.vsix`, and keeps it as a downloadable artifact on the run's page (**Actions** tab → the run → **Artifacts**).
- **Release** runs when you push a version tag. It checks that the tag matches the version in `package.json`, runs the tests, builds the `.vsix`, and publishes a GitHub Release with the `.vsix` attached. The release notes come from that version's section in `CHANGELOG.md`.

## 6. Publish a release

```
git tag v2.0.5
git push origin v2.0.5
```

A minute later the release appears under **Releases** on the repository page, with `permission-studio-2.0.5.vsix` to download. Anyone with access installs it with **Install from VSIX…** or `code --install-extension`.

To release by hand instead, either:

- **On GitHub:** **Releases** → **Draft a new release** → tag `v2.0.5` → attach `dist\permission-studio-2.0.5.vsix` → **Publish release**. Or:
- **With the GitHub CLI:** `node tools/release-notes.js v2.0.5 > notes.md`, then `gh release create v2.0.5 dist/permission-studio-2.0.5.vsix --title "Permission Studio v2.0.5" --notes-file notes.md`.

Use one way, not both: the Release workflow stops if the release already exists.

## 7. Each new version

1. Raise `"version"` in `package.json` (for example `2.0.6`).
2. Add a `## 2.0.6` section at the top of `CHANGELOG.md`.
3. Commit, push, then tag and push the tag:

```
git commit -am "Permission Studio 2.0.6"
git push
git tag v2.0.6
git push origin v2.0.6
```

If the tag and `package.json` disagree, the Release workflow stops and says so, rather than publishing the wrong version.

## 8. Later: the VS Code Marketplace

When you're ready to publish on the Marketplace:

1. **Create the publisher.** Sign in at <https://marketplace.visualstudio.com/manage> and create the publisher `nikeshvarma`. The ID must match `"publisher"` in `package.json`.
2. **Create a token.** In Azure DevOps (<https://dev.azure.com>), create a Personal Access Token with the **Marketplace → Manage** scope and access to **All accessible organizations**.
3. **Publish:** run `npx @vscode/vsce login nikeshvarma`, paste the token, then run `npx @vscode/vsce publish`.
4. **Optional: publish from GitHub.** Add the token as a repository secret named `VSCE_PAT` (**Settings → Secrets and variables → Actions**). Then add this step at the end of `release.yml`:

   ```yaml
   - name: Publish to the Marketplace
     env:
       VSCE_PAT: ${{ secrets.VSCE_PAT }}
     run: npx @vscode/vsce publish --packagePath dist/*.vsix
   ```

The Marketplace needs the `LICENSE` file (already there) and the `repository` field from step 3. The listing shows `README.md` as the page and `CHANGELOG.md` under **Changelog**. Screenshots in the README make the listing much clearer; add them under `media/` and link them from the README.

## Project layout

| Path | What it is |
| --- | --- |
| `extension.js` | Entry point: settings, commands, background start, auto-refresh |
| `src/org` | Connections (CLI library, REST, `sf`), project and default org, Metadata API |
| `src/data` | Reading permissions, caching |
| `src/model` | The permission model, rules and comparison |
| `src/changes` | Saving, snapshots, change log, summaries |
| `src/xml` | Reading and updating permission set and profile files |
| `src/views`, `media` | The screen (webview) |
| `test` | The test suite, a stand-in CLI and a small in-memory org |
| `tools` | `package.js` (builds the `.vsix`), `release-notes.js` |
| `docs/DESIGN.md` | Design notes |
