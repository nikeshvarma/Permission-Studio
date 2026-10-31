'use strict';

const { splitKey, grants } = require('./model');

/**
 * Compares two canonical models entry by entry.
 *
 * An entry that is absent on one side and grants nothing on the other is
 * treated as equal: Salesforce stores "no access" both ways depending on how
 * the permission was last saved, and showing those as differences is noise.
 *
 * options.scope = 'left'  compares only keys present on the left. Use it for
 *   local profile XML, which only holds the components it was retrieved with,
 *   so everything else would otherwise show as a false difference.
 * options.categories      limits the comparison to a set of categories.
 */
function compare(left, right, options) {
  const o = options || {};
  const cats = o.categories ? new Set(o.categories) : null;
  const keys = new Set(left.entries.keys());
  if (o.scope !== 'left') for (const k of right.entries.keys()) keys.add(k);

  const rows = [];
  for (const k of keys) {
    const { cat, name } = splitKey(k);
    if (cats && !cats.has(cat)) continue;
    const a = left.entries.get(k);
    const b = right.entries.get(k);
    const status = statusOf(cat, a, b);
    if (status === 'same' && !o.includeSame) continue;
    rows.push({ key: k, cat, name, left: a || null, right: b || null, status, flags: differingFlags(a, b) });
  }
  rows.sort((x, y) => x.cat === y.cat ? x.name.localeCompare(y.name) : x.cat.localeCompare(y.cat));
  return rows;
}

function statusOf(cat, a, b) {
  if (!a && !b) return 'same';
  if (!a) return grants(cat, b) ? 'onlyRight' : 'same';
  if (!b) return grants(cat, a) ? 'onlyLeft' : 'same';
  return differingFlags(a, b).length ? 'different' : 'same';
}

function differingFlags(a, b) {
  const x = a || {};
  const y = b || {};
  const names = new Set([...Object.keys(x), ...Object.keys(y)]);
  const out = [];
  for (const n of names) {
    const vx = norm(x[n] === undefined ? defaultFor(y[n]) : x[n]);
    const vy = norm(y[n] === undefined ? defaultFor(x[n]) : y[n]);
    if (vx == null && vy == null) continue;
    // Lists and records (login IP ranges, for one) compare by content.
    if (typeof vx === 'object' || typeof vy === 'object') { if (JSON.stringify(vx) !== JSON.stringify(vy)) out.push(n); continue; }
    if (vx !== vy) out.push(n);
  }
  return out;
}

// A missing boolean means false; a missing or empty string means "not set".
function norm(v) { return v === '' ? null : v; }

function defaultFor(other) { return typeof other === 'boolean' ? false : undefined; }

function summarize(rows) {
  const s = { different: 0, onlyLeft: 0, onlyRight: 0 };
  for (const r of rows) if (s[r.status] !== undefined) s[r.status]++;
  return s;
}

module.exports = { compare, summarize, differingFlags };
