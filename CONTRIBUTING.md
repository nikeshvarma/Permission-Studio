# Contributing to Permission Studio

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug or asking for a feature

Open an issue and pick **Bug report** or **Feature request**. For bugs, include the lines from **Permission Studio: Show Log** around the problem.

Never post anything from a real org in an issue: no tokens, passwords, exported permissions, user lists or My Domain URLs. Replace usernames and org names with placeholders such as `user@example.com` and `my-sandbox`.

## Working on the code

You need Node.js 18 or later and Git. There are no dependencies to install.

```
git clone https://github.com/<your-fork>/permission-studio.git
cd permission-studio
npm test                 runs the test suite (backend, saving, the screen's logic)
npm run test:ui          runs the browser tests (the real screen in Chromium)
npm run screenshots      regenerates the README screenshots in media/readme
npm run package          builds dist/permission-studio-<version>.vsix
```

To try your changes, open the folder in VS Code and press **F5** to start an Extension Development Host, or install the built `.vsix` with `code --install-extension`.

The test suite uses a stand-in Salesforce CLI (a shell script) and a small in-memory org, so it runs on macOS, Linux and WSL. On plain Windows, run it in WSL; GitHub Actions also runs it on every pull request.

The browser tests (`test/ui`) open the real screen (`media/app.js`, `media/app.css`) in Chromium and use it the way a person would: the layout at four laptop sizes, one design for every element, lists that keep their place, the health check with an org-sized dataset, saving, History. They need Python 3 and Playwright:

```
pip install playwright pillow
python -m playwright install chromium
npm run test:ui                      all of them (about two minutes)
python3 test/ui/run_all.py run17     just one
```

Set `CHROME=/path/to/chrome` to use a Chrome you already have. GitHub Actions runs them on every pull request too. Run them, and `npm run screenshots` if the screen changed, before sending a change to the screen.

## How the code is organised

| Path | What it is |
| --- | --- |
| `extension.js` | Entry point: settings, commands, background start, auto-refresh |
| `src/org` | Connections (CLI library, REST, `sf`), project and default org, Metadata API |
| `src/data` | Reading permissions, caching |
| `src/model` | The permission model, rules and comparison |
| `src/changes` | Saving, snapshots, change log, summaries |
| `src/xml` | Reading and updating permission set and profile files |
| `src/views`, `media` | The screen (a webview) |
| `test` | Tests, the stand-in CLI and the in-memory org |
| `test/ui` | Browser tests: page harnesses that load the real screen, sample data, and the checks |
| `tools/screenshots` | The scripts that make the README screenshots |

`docs/DESIGN.md` explains the main decisions, including how saving is guarded.

## Pull requests

- **Keep each pull request to one change,** and explain the problem it solves.
- **Add or update a test** for new behaviour, and make sure `npm test` passes. For a change to the screen, `npm run test:ui` too.
- **Add a line to `CHANGELOG.md`** under a new version heading.
- **Keep the extension dependency-free:** plain JavaScript (CommonJS) and the VS Code API only.
- **Anything that writes to an org must go through the save path in `src/changes/apply.js`,** so it gets the review, the conflict check, the snapshot and the read-back.
- **No real org data,** usernames or client names in code, tests or screenshots; a test checks for common ones.

## Licence

Permission Studio is released under the [MIT License](LICENSE). By contributing, you agree that your contributions are licensed under the same terms.
