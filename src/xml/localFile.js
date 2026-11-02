'use strict';

const fs = require('fs');
const path = require('path');
const flatXml = require('./flatXml');
const { splitKey, entryXml, xmlTag, XML_OUT } = require('../model/model');

/**
 * Keeps the project's source file in step after a save, so the change can
 * be committed. Only the changed entries are touched: existing ones are
 * replaced in place and new ones are inserted where Salesforce would put
 * them (by element, then case-sensitive name), so diffs stay small.
 * Revokes are written as explicit false values.
 */

const SKIP = new Set(['node_modules', '.git', '.sf', '.sfdx', '.permstudio', '.vscode']);

function packageDirs(projectDir) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(projectDir, 'sfdx-project.json'), 'utf8'));
    const dirs = (p.packageDirectories || []).map(d => path.join(projectDir, d.path || ''));
    return dirs.length ? dirs : [projectDir];
  } catch (e) { return [projectDir]; }
}

/** The source file for the item, or null. `metadataName` is the Metadata API name. */
function findLocalFile(projectDir, item, metadataName) {
  if (!projectDir || (item.kind !== 'permissionSet' && item.kind !== 'profile')) return null;
  const target = metadataName + (item.kind === 'profile' ? '.profile-meta.xml' : '.permissionset-meta.xml');
  const folder = item.kind === 'profile' ? 'profiles' : 'permissionsets';
  const walk = (dir, depth) => {
    if (depth > 12) return null;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
    for (const e of entries) if (e.isFile() && e.name === target && path.basename(dir) === folder) return path.join(dir, e.name);
    for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name)) { const f = walk(path.join(dir, e.name), depth + 1); if (f) return f; }
    return null;
  };
  for (const d of packageDirs(projectDir)) { const f = walk(d, 0); if (f) return f; }
  return null;
}

function entryName(cat, e) {
  if (cat === 'layoutAssignment') return null;
  const o = XML_OUT[cat];
  return o ? e.values[o.key] : null;
}

/** Applies changes ([{ key, after }]) to file text. Returns { text, applied, skipped }. */
function applyToText(text, kind, changes) {
  const doc = flatXml.parse(text);
  const first = doc.entries[0];
  const lineStart = first ? text.lastIndexOf('\n', first.index) + 1 : 0;
  const indent = first ? (text.slice(lineStart, first.index).match(/^[ \t]*/) || ['    '])[0] || '    ' : '    ';
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const edits = [];
  const applied = [];
  const skipped = [];
  const rootClose = text.lastIndexOf('</' + doc.root);

  for (const c of changes) {
    const { cat, name } = splitKey(c.key);
    const tag = xmlTag(kind, cat);
    const xml = entryXml(kind, c.key, c.after, indent);
    if (!tag || xml === null) { skipped.push(c.key); continue; }
    const same = doc.entries.filter(e => e.tag === tag);
    const body = xml.replace(/\n/g, nl);

    let matches;
    if (cat === 'loginHours' || cat === 'loginIpRanges') matches = same;
    else if (cat === 'layoutAssignment') {
      const obj = name.slice(0, name.indexOf('.'));
      const rt = name.slice(name.indexOf('.') + 1) ? name : undefined;
      matches = same.filter(e => (e.values.layout || '').startsWith(obj + '-') && e.values.recordType === rt);
    } else matches = same.filter(e => entryName(cat, e) === name);

    if (matches.length) {
      // Replace the first, drop any others (login IP ranges are written as a whole list).
      edits.push({ start: matches[0].index, end: matches[0].index + matches[0].length, text: body.trimStart() });
      for (const m of matches.slice(1)) edits.push({ start: text.lastIndexOf('\n', m.index), end: m.index + m.length, text: '' });
      if (!body.trim()) edits[edits.length - 1 - (matches.length - 1)].start = text.lastIndexOf('\n', matches[0].index);
    } else if (body.trim()) {
      const keyOf = e => entryName(cat, e) || '';
      const order = tag + '\u0000' + name;
      const after = same.find(e => keyOf(e) > name);
      if (after) edits.push({ start: after.index, end: after.index, text: body.trimStart() + nl + indent, order });
      else if (same.length) { const last = same[same.length - 1]; edits.push({ start: last.index + last.length, end: last.index + last.length, text: nl + body, order }); }
      else {
        const next = doc.entries.find(e => e.tag > tag);
        if (next) edits.push({ start: next.index, end: next.index, text: body.trimStart() + nl + indent, order });
        else {
          const lastEntry = doc.entries[doc.entries.length - 1];
          const at = lastEntry ? lastEntry.index + lastEntry.length : text.lastIndexOf('\n', rootClose);
          edits.push({ start: at, end: at, text: nl + body, order });
        }
      }
    }
    applied.push(c.key);
  }
  // Apply from the end so earlier positions stay valid. At one position, the
  // replacement goes first and inserts follow in reverse Salesforce order, so
  // each lands in front of the one after it.
  edits.sort((a, b) => b.start - a.start || (b.end - b.start) - (a.end - a.start) || ((b.order || '') < (a.order || '') ? -1 : (b.order || '') > (a.order || '') ? 1 : 0));
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { text: out, applied, skipped };
}

async function updateLocalFile(file, kind, changes) {
  const text = await fs.promises.readFile(file, 'utf8');
  const r = applyToText(text, kind, changes);
  if (r.text !== text) await fs.promises.writeFile(file, r.text);
  return r;
}

module.exports = { findLocalFile, applyToText, updateLocalFile };
