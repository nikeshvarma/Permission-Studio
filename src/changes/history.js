'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Snapshots and the change log, kept in the project under .permstudio/
 * (add it to .gitignore). A snapshot holds the live values of every entry a
 * save touched, read just before the save; the log holds one line per save.
 * Neither ever holds a token.
 */

function dir(projectDir, sub) { return path.join(projectDir, '.permstudio', sub); }

function newId(now) {
  const d = new Date(now || Date.now());
  const stamp = d.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return stamp + '-' + Math.random().toString(36).slice(2, 6);
}

async function saveSnapshot(projectDir, snapshot) {
  const id = newId();
  const d = dir(projectDir, 'snapshots');
  await fs.promises.mkdir(d, { recursive: true });
  await fs.promises.writeFile(path.join(d, id + '.json'), JSON.stringify(Object.assign({ id, takenAt: new Date().toISOString() }, snapshot), null, 2));
  return id;
}

async function loadSnapshot(projectDir, id) {
  if (!/^[\w-]+$/.test(id)) throw new Error('Bad snapshot id');
  return JSON.parse(await fs.promises.readFile(path.join(dir(projectDir, 'snapshots'), id + '.json'), 'utf8'));
}

async function appendLog(projectDir, entry) {
  const d = dir(projectDir, 'log');
  await fs.promises.mkdir(d, { recursive: true });
  await fs.promises.appendFile(path.join(d, 'changes.jsonl'), JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + '\n');
}

/** Log entries, newest first, optionally for one org only. */
async function readLog(projectDir, options) {
  const o = options || {};
  let text = '';
  try { text = await fs.promises.readFile(path.join(dir(projectDir, 'log'), 'changes.jsonl'), 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (!o.org || e.org === o.org) out.push(e); } catch (e) { /* skip a damaged line */ }
  }
  out.reverse();
  return o.limit ? out.slice(0, o.limit) : out;
}

module.exports = { saveSnapshot, loadSnapshot, appendLog, readLog };
