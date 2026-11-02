'use strict';

/**
 * Which flags of an entry differ between two values. A missing boolean means
 * false and a missing or empty string means "not set", so an entry Salesforce
 * stores as "absent" and one stored as "all false" compare equal.
 */
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

module.exports = { differingFlags };
