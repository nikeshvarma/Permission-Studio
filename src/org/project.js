'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const sfcli = require('./sfcli');

/**
 * The extension works on one org: the default org (target-org) of the
 * Salesforce project open in VS Code.
 *
 * Project: the `permStudio.project.path` setting if set, otherwise the
 * workspace folder that holds sfdx-project.json (preferring the one that
 * contains the active editor's file), otherwise the first sfdx-project.json
 * found below a workspace folder.
 *
 * Default org: read from the CLI's config files with the CLI's own precedence
 * (a project-level .sf/config.json, or the older .sfdx/sfdx-config.json, wins
 * over the global one). When the files don't settle it, the CLI is asked.
 */

function isProject(dir) {
  try { return fs.statSync(path.join(dir, 'sfdx-project.json')).isFile(); } catch (e) { return false; }
}

async function findProject(opts) {
  const o = opts || {};
  if (o.override) {
    const dir = path.resolve(o.override);
    if (!isProject(dir)) throw new Error('permStudio.project.path is set to ' + dir + ', which has no sfdx-project.json.');
    return dir;
  }
  const folders = o.folders || [];
  const roots = folders.filter(isProject);
  if (roots.length) {
    const active = o.activeFile ? path.resolve(o.activeFile) : '';
    const match = roots.filter(r => active.startsWith(path.resolve(r) + path.sep)).sort((a, b) => b.length - a.length)[0];
    return match || roots[0];
  }
  if (o.findFiles) {
    const found = (await o.findFiles()).map(f => path.dirname(f)).sort((a, b) => a.length - b.length);
    if (found.length) return found[0];
  }
  return null;
}

/** Files whose change means the default org may have changed. */
function configFiles(projectDir) {
  return [path.join(projectDir, '.sf', 'config.json'), path.join(projectDir, '.sfdx', 'sfdx-config.json')];
}

/**
 * Returns { value, location } for target-org, or null when none is set.
 * `location` is Local (this project), Global, or Environment.
 */
async function defaultOrgSetting(sfPath, projectDir) {
  const r = await sfcli.runResult(sfPath, ['config', 'get', 'target-org'], { cwd: projectDir });
  const entry = Array.isArray(r) ? r.find(x => x && (x.key === 'target-org' || x.name === 'target-org')) : null;
  if (!entry || !entry.value) return null;
  return { value: String(entry.value), location: entry.location || '' };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

/**
 * Reads target-org straight from the CLI's config files, which takes
 * microseconds instead of the seconds a `sf` process needs on Windows.
 * Same precedence as the CLI: environment, project config, global config.
 * Returns null when it can't be sure, and the caller asks the CLI instead.
 */
function defaultOrgFromFiles(projectDir, options) {
  const o = options || {};
  const env = o.env || process.env;
  const home = o.homedir || os.homedir();
  const sources = [
    [env.SF_TARGET_ORG || env.SFDX_DEFAULTUSERNAME, 'Environment'],
    [(readJson(path.join(projectDir, '.sf', 'config.json')) || {})['target-org'], 'Local'],
    [(readJson(path.join(projectDir, '.sfdx', 'sfdx-config.json')) || {}).defaultusername, 'Local'],
    [(readJson(path.join(home, '.sf', 'config.json')) || {})['target-org'], 'Global'],
    [(readJson(path.join(home, '.sfdx', 'sfdx-config.json')) || {}).defaultusername, 'Global']
  ];
  const hit = sources.find(([v]) => v);
  if (!hit) return { none: true };
  const value = String(hit[0]);
  const aliases = (readJson(path.join(home, '.sfdx', 'alias.json')) || {}).orgs || {};
  const username = value.includes('@') ? value : aliases[value];
  if (!username) return null;
  // Only trust it if the CLI holds an authorisation for that username.
  if (!fs.existsSync(path.join(home, '.sfdx', username + '.json'))) return null;
  const alias = value.includes('@') ? (Object.keys(aliases).find(a => aliases[a] === username) || '') : value;
  return { username, alias, location: hit[1], via: 'files' };
}

/** Resolves the project's default org to its username and alias. Returns null when none is set. */
async function resolveDefaultOrg(sfPath, projectDir, options) {
  const fast = defaultOrgFromFiles(projectDir, options);
  if (fast && fast.none) return null;
  if (fast) return fast;
  const setting = await defaultOrgSetting(sfPath, projectDir);
  if (!setting) return null;
  const info = await sfcli.runResult(sfPath, ['org', 'display', '--target-org', setting.value], { cwd: projectDir });
  return {
    username: info.username,
    alias: info.alias || (setting.value !== info.username ? setting.value : ''),
    location: setting.location,
    via: 'cli',
    // Handed to connection.open so the CLI is not asked twice. Never logged or sent to the webview.
    display: info
  };
}

module.exports = { findProject, isProject, configFiles, defaultOrgSetting, defaultOrgFromFiles, resolveDefaultOrg };
