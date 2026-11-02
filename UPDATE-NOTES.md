# Updating to 2.2.1

1. Unzip this into the project folder and let it overwrite.
2. Delete the removed module: `git rm src/changes/changeSet.js`
3. In `package.json`, set `"version": "2.2.1"` (nothing else in it changed).
4. `npm test` and `npm run package` should both pass. Then delete this note, commit, and tag `v2.2.1`.
