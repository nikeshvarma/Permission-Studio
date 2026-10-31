'use strict';

const fs = require('fs');
const path = require('path');
const sfcli = require('./sfcli');

/**
 * The Salesforce CLI's own connection library (@salesforce/core), loaded
 * from the CLI's install folder and run inside VS Code.
 *
 * Requests then go out exactly as the CLI's do: the same stored session and
 * automatic token renewal, the same proxy handling, the same network route.
 * That matters in orgs that lock sessions to the IP address they started
 * from, where a token renewed by the CLI is refused when another program
 * sends it by a different route. It is also fast: no `sf` process per call,
 * and once the library's location is known, none at start-up either.
 */

const CACHE_KEY = 'permStudio.sfcorePath';
let loaded = null; // { path, core }

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }

/** Sub-folders of `dir`, newest first (the CLI's self-updates keep one folder per version). */
function newestFirst(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory())
      .map(e => { const p = path.join(dir, e.name); return [p, fs.statSync(p).mtimeMs]; })
      .sort((a, b) => b[1] - a[1]).map(x => x[0]);
  } catch (e) { return []; }
}

/**
 * Folders where the CLI may be installed, most likely first, found without
 * starting `sf` (which can take most of a minute on some machines):
 * the CLI's own self-update folders, folders derived from where `sf` sits
 * on PATH (installer, npm and Homebrew layouts), then the standard places.
 */
function candidateRoots(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const home = o.homedir || require('os').homedir();
  const win = (o.platform || process.platform) === 'win32';
  const out = [];
  const add = p => { if (p && !out.includes(p)) out.push(p); };
  if (o.override) add(o.override);
  if (win && env.LOCALAPPDATA) newestFirst(path.join(env.LOCALAPPDATA, 'sf', 'client')).forEach(add);
  if (!win) newestFirst(path.join(home, '.local', 'share', 'sf', 'client')).forEach(add);
  const fromBin = dir => {
    add(path.join(dir, '..', 'client'));
    add(path.join(dir, 'node_modules', '@salesforce', 'cli'));
    add(path.join(dir, '..', 'lib', 'node_modules', '@salesforce', 'cli'));
    add(path.join(dir, '..'));
    for (const name of win ? ['sf.cmd', 'sf'] : ['sf']) {
      try { add(path.join(path.dirname(fs.realpathSync(path.join(dir, name))), '..')); } catch (e) { /* not here */ }
    }
  };
  if (o.sfPath && path.isAbsolute(o.sfPath)) fromBin(path.dirname(o.sfPath));
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    if ((win ? ['sf.cmd', 'sf.exe', 'sf'] : ['sf']).some(n => fs.existsSync(path.join(dir, n)))) fromBin(dir);
  }
  if (win) {
    for (const pf of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]) if (pf) add(path.join(pf, 'sf', 'client'));
    if (env.APPDATA) add(path.join(env.APPDATA, 'npm', 'node_modules', '@salesforce', 'cli'));
  } else {
    ['/usr/local/lib/sf', '/usr/local/sf/client', '/opt/homebrew/lib/node_modules/@salesforce/cli', '/usr/local/lib/node_modules/@salesforce/cli',
      path.join(home, '.npm-global', 'lib', 'node_modules', '@salesforce', 'cli')].forEach(add);
  }
  return out.filter(isDir);
}

/** The first candidate that holds @salesforce/core, or null. */
function findOnDisk(opts) {
  for (const root of candidateRoots(opts)) {
    const core = path.join(root, 'node_modules', '@salesforce', 'core');
    if (isDir(core)) { try { return require.resolve(core); } catch (e) { /* incomplete install */ } }
  }
  return null;
}

/**
 * Where the CLI is installed, asked from the CLI itself. `sf version` and
 * `sf plugins` are plain oclif commands: their --json output is the bare
 * object, without the { status, result } wrapper other sf commands use.
 */
async function cliRoot(sfPath, cwd) {
  const ask = async args => { const r = await sfcli.run(sfPath, args, { cwd }); return r.json && r.json.result !== undefined ? r.json.result : r.json; };
  const v = await ask(['version', '--verbose']).catch(() => null);
  if (v && v.rootPath) return v.rootPath;
  const plugins = await ask(['plugins', '--core']).catch(() => null);
  const withRoot = (Array.isArray(plugins) ? plugins : []).find(p => p && p.root);
  if (!withRoot) throw new Error('The Salesforce CLI did not say where it is installed. Set permStudio.sf.installPath to its folder.');
  return withRoot.root;
}

function resolveCore(root) {
  return require.resolve('@salesforce/core', { paths: [root, path.join(root, 'node_modules')] });
}

/**
 * Loads @salesforce/core, finding it once through the CLI and remembering the
 * location in `memento` (VS Code global state) so later starts skip the CLI.
 */
async function load(sfPath, cwd, memento, log, options) {
  const o = options || {};
  if (loaded) return loaded;
  let resolved = !o.installPath && memento && memento.get(CACHE_KEY);
  if (!resolved || !fs.existsSync(resolved)) {
    const t = Date.now();
    resolved = findOnDisk({ override: o.installPath, sfPath, env: o.env, homedir: o.homedir, platform: o.platform });
    if (resolved && log) log('Found the Salesforce CLI library on disk in ' + (Date.now() - t) + ' ms');
    if (!resolved && o.installPath) throw new Error('No Salesforce CLI library (node_modules/@salesforce/core) under permStudio.sf.installPath: ' + o.installPath);
    if (!resolved) {
      if (log) log('Asking the Salesforce CLI where it is installed…');
      resolved = resolveCore(await cliRoot(sfPath, cwd));
    }
    if (memento) await memento.update(CACHE_KEY, resolved);
  }
  // The library would otherwise write its own log files from VS Code's process.
  process.env.SF_DISABLE_LOG_FILE = 'true';
  process.env.SFDX_DISABLE_LOG_FILE = 'true';
  process.env.SF_DISABLE_TELEMETRY = 'true';
  let core;
  try { core = require(resolved); } catch (e) {
    if (memento) await memento.update(CACHE_KEY, undefined);
    throw new Error('Could not load the Salesforce CLI library from ' + resolved + ': ' + e.message);
  }
  if (!core || !core.Org || typeof core.Org.create !== 'function') throw new Error('Unexpected Salesforce CLI library at ' + resolved);
  loaded = { path: resolved, core };
  if (log) log('Salesforce CLI library: ' + resolved);
  return loaded;
}

/** A connection for one org, signed in the way the CLI is. */
async function connect(core, username, apiVersion) {
  const org = await core.Org.create({ aliasOrUsername: username });
  const conn = apiVersion ? org.getConnection(apiVersion) : org.getConnection();
  if (!conn || typeof conn.request !== 'function') throw new Error('The CLI library returned no usable connection');
  return conn;
}

/** For tests: forget what was loaded. */
function reset() { loaded = null; }

module.exports = { load, connect, cliRoot, resolveCore, candidateRoots, findOnDisk, reset, CACHE_KEY };
