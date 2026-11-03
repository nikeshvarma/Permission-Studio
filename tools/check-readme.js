#!/usr/bin/env node
'use strict';
// Checks the README packed in a .vsix: which repository its images point at,
// and whether GitHub actually serves each image to an anonymous visitor (as it
// must, for the extension's page in VS Code to show it).
// Usage: node tools/check-readme.js dist/permission-studio-<version>.vsix [--strict]
// With --strict it exits with an error when an image can't be shown.
const fs = require('fs');
const zlib = require('zlib');
const https = require('https');

/** The files in a zip (a .vsix is one): Map<name, Buffer>. Stored and deflated entries only. */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a .vsix (zip) file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged .vsix (central directory).');
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.slice(start, start + size);
    out.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Image addresses in a README (Markdown and <img> tags). */
function imagesIn(md) {
  return [...md.matchAll(/!\[[^\]]*\]\(<?([^)\s>]+)>?/g), ...md.matchAll(/<img\b[^>]*?\bsrc=["']([^"']+)["']/gi)].map(m => m[1]);
}

/** GET an address the way an anonymous browser would, following redirects: { status, type, url }. */
function fetchHead(url, hops) {
  return new Promise(resolve => {
    const req = https.get(url, { headers: { 'User-Agent': 'permission-studio-check' } }, res => {
      res.resume();
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (hops || 0) < 5) return resolve(fetchHead(new URL(res.headers.location, url).href, (hops || 0) + 1));
      resolve({ status: res.statusCode, type: res.headers['content-type'] || '', url });
    });
    req.on('error', e => resolve({ status: 0, type: '', url, error: e.code || e.message }));
    req.setTimeout(15000, () => req.destroy(new Error('timed out')));
  });
}

/** The verdict for each image: [{ src, ok, why }]. `get` is injectable for tests. */
async function check(md, get) {
  const out = [];
  for (const src of imagesIn(md)) {
    if (!/^https:\/\//i.test(src)) { out.push({ src, ok: false, why: 'not an https address: VS Code won\u2019t show it. Add a GitHub "repository" to package.json and package again.' }); continue; }
    const r = await get(src);
    if (r.status === 200 && /^image\//.test(r.type)) out.push({ src, ok: true, why: 'shown (' + r.type + ')' });
    else if (r.status === 404) out.push({ src, ok: false, why: 'GitHub says 404: the repository is private, or this file isn\u2019t on its default branch' });
    else if (r.status === 0) out.push({ src, ok: false, why: 'could not reach GitHub (' + (r.error || 'network') + ')' });
    else out.push({ src, ok: false, why: 'HTTP ' + r.status + (r.type ? ' ' + r.type : '') + ' (expected an image)' });
  }
  return out;
}

module.exports = { readZip, imagesIn, check };
if (require.main === module) {
  (async () => {
    const file = process.argv[2];
    if (!file || !fs.existsSync(file)) { console.error('Usage: node tools/check-readme.js <file.vsix> [--strict]'); process.exit(2); }
    const zip = readZip(fs.readFileSync(file));
    const readme = zip.get('extension/README.md');
    if (!readme) { console.error('No extension/README.md in ' + file); process.exit(2); }
    const md = readme.toString('utf8');
    const pkg = JSON.parse(zip.get('extension/package.json').toString('utf8'));
    const repo = pkg.repository ? (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url) : '(none)';
    console.log(file + ': version ' + pkg.version + ', repository ' + repo);
    const results = await check(md, fetchHead);
    for (const r of results) console.log((r.ok ? '  ok    ' : '  FAIL  ') + r.src + '\n        ' + r.why);
    const bad = results.filter(r => !r.ok).length;
    console.log(bad ? bad + ' of ' + results.length + ' README images won\u2019t show on the extension\u2019s page in VS Code.' : 'All ' + results.length + ' README images will show on the extension\u2019s page in VS Code.');
    if (bad && process.argv.includes('--strict')) process.exit(1);
  })();
}
