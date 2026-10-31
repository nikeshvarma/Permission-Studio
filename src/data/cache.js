'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Cache for what the extension reads from an org, so a screen opens with
 * the last known data straight away and is refreshed in the background
 * (stale-while-revalidate).
 *
 * One folder per org username under the extension's own storage, never in
 * the project. Values are JSON; tokens are never stored. Entries are written
 * to disk asynchronously and pruned oldest-first beyond `maxEntries`.
 */
class Cache {
  constructor(dir, options) {
    const o = options || {};
    this.dir = dir;
    this.enabled = o.enabled !== false;
    this.maxEntries = o.maxEntries || 400;
    this._mem = new Map();      // key -> { value, savedAt }
    this._inflight = new Map(); // key -> Promise
    this._writes = Promise.resolve();
  }

  _file(key) {
    const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 20);
    const safe = key.replace(/[^\w.-]+/g, '_').slice(0, 60);
    return path.join(this.dir, safe + '-' + hash + '.json');
  }

  get(key) {
    if (!this.enabled) return null;
    if (this._mem.has(key)) return this._mem.get(key);
    try {
      const entry = JSON.parse(fs.readFileSync(this._file(key), 'utf8'));
      if (entry && entry.key === key) { this._mem.set(key, entry); return entry; }
    } catch (e) { /* not cached */ }
    return null;
  }

  set(key, value) {
    if (!this.enabled) return;
    const entry = { key, value, savedAt: Date.now() };
    this._mem.set(key, entry);
    const file = this._file(key);
    this._writes = this._writes.then(async () => {
      try {
        await fs.promises.mkdir(this.dir, { recursive: true });
        const tmp = file + '.' + process.pid + '.tmp';
        await fs.promises.writeFile(tmp, JSON.stringify(entry));
        await fs.promises.rename(tmp, file);
        await this._prune();
      } catch (e) { /* cache is best effort */ }
    });
  }

  delete(key) {
    this._mem.delete(key);
    try { fs.unlinkSync(this._file(key)); } catch (e) { /* gone */ }
  }

  /** Waits for pending disk writes (tests, and before clearing). */
  flush() { return this._writes; }

  async clear() {
    await this.flush();
    this._mem.clear();
    await fs.promises.rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }

  async _prune() {
    const names = (await fs.promises.readdir(this.dir)).filter(n => n.endsWith('.json'));
    if (names.length <= this.maxEntries) return;
    const stats = await Promise.all(names.map(async n => ({ n, t: (await fs.promises.stat(path.join(this.dir, n))).mtimeMs })));
    stats.sort((a, b) => a.t - b.t);
    for (const s of stats.slice(0, names.length - this.maxEntries)) await fs.promises.unlink(path.join(this.dir, s.n)).catch(() => {});
  }

  /**
   * Stale-while-revalidate.
   *   cached value present -> returned at once as { value, savedAt, stale: true };
   *                           `fetch` runs in the background and `onFresh(value)`
   *                           is called when it lands (only if it changed).
   *   nothing cached       -> waits for `fetch`.
   * `maxAgeMs` skips the background fetch while the entry is younger than that.
   * Concurrent calls for the same key share one fetch.
   */
  async swr(key, fetch, onFresh, options) {
    const o = options || {};
    const cached = o.force ? null : this.get(key);
    const run = () => {
      if (!this._inflight.has(key)) {
        const p = Promise.resolve().then(fetch).then(value => { this.set(key, value); return value; })
          .finally(() => this._inflight.delete(key));
        this._inflight.set(key, p);
      }
      return this._inflight.get(key);
    };
    if (!cached) {
      const value = await run();
      return { value, savedAt: Date.now(), stale: false };
    }
    if (o.maxAgeMs && Date.now() - cached.savedAt < o.maxAgeMs) return { value: cached.value, savedAt: cached.savedAt, stale: false };
    const before = JSON.stringify(cached.value);
    run().then(value => {
      if (onFresh) onFresh(value, JSON.stringify(value) !== before);
    }, err => { if (o.onError) o.onError(err); });
    return { value: cached.value, savedAt: cached.savedAt, stale: true };
  }
}

/** A cache that never stores anything, for when caching is switched off. */
function disabled() { return new Cache('', { enabled: false }); }

module.exports = { Cache, disabled };
