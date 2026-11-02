# package.json changes for 2.2.0

Make these four edits in your `package.json` (it isn't in this zip, so your repository and licence fields stay as they are).

1. Set the version:

```json
"version": "2.2.0",
```

2. In `contributes.commands`, add:

```json
{ "command": "permStudio.saveShortcut", "title": "Review and Save", "category": "Permission Studio" }
```

3. In `contributes`, add a `keybindings` list (next to `commands`):

```json
"keybindings": [
  { "command": "permStudio.saveShortcut", "key": "ctrl+s", "mac": "cmd+s", "when": "activeWebviewPanelId == 'permStudio.main'" }
],
```

4. In `contributes.menus.commandPalette`, add (hides the command from the Command Palette):

```json
{ "command": "permStudio.saveShortcut", "when": "false" }
```

Then `npm test` and `npm run package` should both pass.
