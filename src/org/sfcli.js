'use strict';

const { spawn } = require('child_process');

/**
 * Thin wrapper over the Salesforce CLI. The extension never stores a password
 * or token on disk: it uses whatever orgs are already authorised with `sf`.
 *
 * On Windows `sf` is a .cmd shim, which Node can only start through cmd.exe.
 * Arguments are escaped the way cross-spawn does it, so project paths and
 * aliases containing spaces or cmd metacharacters survive the round trip.
 */

const META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCommand(cmd) {
  return String(cmd).replace(META, '^$1');
}

function escapeArgument(arg) {
  let s = String(arg);
  // Backslashes before a quote are doubled, then the quote is escaped.
  s = s.replace(/(\\*)"/g, '$1$1\\"');
  // Trailing backslashes are doubled so they don't escape the closing quote.
  s = s.replace(/(\\*)$/, '$1$1');
  s = '"' + s + '"';
  return s.replace(META, '^$1');
}

/** Builds the spawn call for the current platform. Exported for tests. */
function spawnSpec(sfPath, args, platform) {
  const cmd = sfPath || 'sf';
  if ((platform || process.platform) !== 'win32') return { file: cmd, args, verbatim: false };
  const line = [escapeCommand(cmd)].concat(args.map(escapeArgument)).join(' ');
  return { file: process.env.comspec || 'cmd.exe', args: ['/d', '/s', '/c', '"' + line + '"'], verbatim: true };
}

/** sf sometimes prints warnings before the JSON body; take the outermost object. */
function parseJson(text) {
  const s = String(text || '');
  try { return JSON.parse(s); } catch (e) { /* fall through */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { /* not json */ }
  }
  return null;
}

function run(sfPath, args, options) {
  const o = Object.assign({ cwd: undefined, token: null, env: null }, options || {});
  const spec = spawnSpec(sfPath, args.concat(['--json']));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(spec.file, spec.args, {
        cwd: o.cwd, windowsHide: true, windowsVerbatimArguments: spec.verbatim,
        env: Object.assign({}, process.env, {
          SF_DISABLE_COLORS: 'true', FORCE_COLOR: '0', SF_AUTOUPDATE_DISABLE: 'true', SF_SKIP_NEW_VERSION_CHECK: 'true',
          // Each process would otherwise also start telemetry, which costs time on every call.
          SF_DISABLE_TELEMETRY: 'true', SFDX_DISABLE_TELEMETRY: 'true'
        }, o.env || {})
      });
    } catch (e) { reject(e); return; }

    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    if (o.token) o.token.onCancellationRequested(() => { try { child.kill(); } catch (e) { /* gone */ } });
    child.on('error', e => reject(e.code === 'ENOENT'
      ? new Error('The Salesforce CLI (' + (sfPath || 'sf') + ') was not found. Install it or set permStudio.sf.path.')
      : e));
    child.on('close', code => resolve({ code, json: parseJson(out), stdout: out, stderr: err }));
  });
}

/** Runs a command and returns `result`, or throws with the CLI's own message. */
async function runResult(sfPath, args, options) {
  const r = await run(sfPath, args, options);
  if (r.json && r.json.status === 0) return r.json.result;
  const msg = (r.json && (r.json.message || r.json.name)) || r.stderr.trim() || ('sf exited with code ' + r.code);
  const e = new Error(msg);
  e.cli = r;
  throw e;
}

module.exports = { run, runResult, parseJson, spawnSpec, escapeArgument };
