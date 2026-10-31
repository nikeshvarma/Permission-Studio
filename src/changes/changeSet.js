'use strict';

const { differingFlags } = require('../model/diff');

/**
 * Staged edits for one org (decision 19: stage, review the diff, then apply).
 *
 * Each item records the value it was staged against (`before`) and the
 * desired value (`after`). Staging the same entry twice keeps the first
 * `before`, so toggling a checkbox on and off again removes the item.
 *
 * Before applying, the extension re-reads every touched entry live and calls
 * `conflicts()`: anything someone changed in Setup since it was staged is
 * shown instead of silently overwritten. The same re-read is the snapshot
 * that `inverse()` turns into a one-click rollback.
 */
class ChangeSet {
  constructor(org) {
    this.org = org;
    this.items = new Map(); // targetId|key -> item
  }

  static id(target, key) { return target.permissionSetId + '|' + key; }

  stage(target, key, before, after, notes) {
    const id = ChangeSet.id(target, key);
    const existing = this.items.get(id);
    const original = existing ? existing.before : clone(before);
    if (!differingFlags(original, after).length) { this.items.delete(id); return null; }
    const item = { target: pickTarget(target), key, before: original, after: clone(after), notes: notes || [] };
    this.items.set(id, item);
    return item;
  }

  unstage(target, key) { return this.items.delete(ChangeSet.id(target, key)); }

  get size() { return this.items.size; }

  list() { return [...this.items.values()]; }

  /** `live(item)` returns the entry's current props in the org (or null when absent). */
  conflicts(live) {
    const out = [];
    for (const item of this.items.values()) {
      const now = live(item);
      if (differingFlags(item.before, now).length) out.push({ item, now });
    }
    return out;
  }

  /** A change set that puts every entry back to its snapshot value. */
  inverse(snapshot) {
    const inv = new ChangeSet(this.org);
    for (const item of this.items.values()) {
      const restore = snapshot ? snapshot(item) : item.before;
      inv.items.set(ChangeSet.id(item.target, item.key),
        { target: item.target, key: item.key, before: clone(item.after), after: clone(restore), notes: ['rollback'] });
    }
    return inv;
  }

  toJSON() { return { org: this.org, items: this.list() }; }

  static fromJSON(json) {
    const cs = new ChangeSet(json.org);
    for (const it of json.items || []) cs.items.set(ChangeSet.id(it.target, it.key), it);
    return cs;
  }
}

function pickTarget(t) {
  return { kind: t.kind, permissionSetId: t.permissionSetId, recordId: t.recordId, apiName: t.apiName };
}

function clone(v) { return v == null ? null : JSON.parse(JSON.stringify(v)); }

module.exports = { ChangeSet };
