'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const { splitKey } = require('../model/model');
const { editBlocker, editableCategories, currentValues } = require('../changes/apply');
const { applyObject } = require('../model/dependencies');
const { META_ACCESS } = require('../model/model');
const { str: soqlStr } = require('../data/soql');

const KIND_LABEL = { permissionSet: 'Permission Set', group: 'Permission Set Group', profile: 'Profile' };

/**
 * The Permission Studio screen for the project's default org.
 *
 * Everything shown is cached per org. Opening the screen, an item or an
 * object shows the cached copy at once and refreshes it in the background;
 * the webview is told when fresh data lands. Edits are staged in the
 * webview and saved through `services.applyChanges`.
 */
class MainPanel {
  constructor(context, services) {
    this.context = context;
    this.s = services;
    this.panel = null;
    this.ctx = null;
    this.conn = null;
    this.connReady = null;
    this.cache = null;
    this.items = new Map();
    this._ctxSeq = 0;
    this._selected = null;
    this._object = null;
  }

  get isOpen() { return !!this.panel; }

  /** permStudio.refreshOnOpen (default on). */
  _refreshOnOpen() { return !this.s.refreshOnOpen || this.s.refreshOnOpen() !== false; }

  show() {
    if (this.panel) {
      this.panel.reveal();
      // Opening it again (from the Command Palette or a file) also reads everything again.
      if (this._webviewReady && this._refreshOnOpen()) this.fullRefresh('page opened again').catch(() => {});
      return this.panel;
    }
    const root = this.context.extensionUri;
    const media = vscode.Uri.joinPath(root, 'media');
    const shared = vscode.Uri.joinPath(root, 'src', 'model');
    this.panel = vscode.window.createWebviewPanel('permStudio.main', 'Permission Studio', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media, shared] });
    // The tab icon has no access to theme colours, so each theme gets its own shield.
    this.panel.iconPath = { light: vscode.Uri.joinPath(media, 'tab-light.svg'), dark: vscode.Uri.joinPath(media, 'tab-dark.svg') };
    this.panel.webview.html = html(this.panel.webview, media, shared);
    this.panel.onDidDispose(() => { this.panel = null; this._webviewReady = false; });
    // Back in view after at least a minute in the background: read everything again.
    if (this.panel.onDidChangeViewState) this.panel.onDidChangeViewState(e => {
      const p = e && e.webviewPanel ? e.webviewPanel : this.panel;
      if (p && p.visible && this._webviewReady && this._refreshOnOpen() && Date.now() - (this._lastFull || 0) > 60 * 1000) this.fullRefresh('back in view').catch(() => {});
    });
    this.panel.webview.onDidReceiveMessage(m => this._onMessage(m).catch(e => this.s.log('Message ' + (m && m.type) + ' failed: ' + (e.stack || e))));
    return this.panel;
  }

  post(m) { if (this.panel) this.panel.webview.postMessage(m); }

  async _onMessage(m) {
    if (!m) return;
    switch (m.type) {
      case 'ready':
        // The extension starts loading in the background as soon as a project opens; join that if it's still running.
        if (this._loading) { if (this.ctx) this.post(contextMessage(this.ctx, this.conn, { loading: 'Loading…' })); await this._loading; }
        let replayed = false;
        if (this.ctx && this.items.size) { this._replay(); replayed = true; } else if (this.ctx && this.ctx.status) this.post(contextMessage(this.ctx, this.conn)); else await this.load();
        this._webviewReady = true;
        this.post({ type: 'persisted', values: this._persisted() });
        // Opening the page shows what's cached at once, then reads everything again (a fresh load needs no second read).
        if (replayed && this._refreshOnOpen()) this.fullRefresh('page opened').catch(() => {});
        if (this._pendingOpen) { this.post({ type: 'selectKey', key: this._pendingOpen }); this._pendingOpen = null; }
        break;
      case 'refresh': await this.load({ force: true }); break;
      case 'select': await this.select(m.key, { force: m.force }); break;
      case 'openObject': await this.openObject(m.key, m.object, { force: m.force }); break;
      case 'objectCatalog': await this.sendCatalog(); break;
      case 'loadAccess': await this.openAccess(m.key, m.category, { force: m.force }); break;
      case 'loadRecordTypes': await this.openRecordTypes(m.key, m.object, { force: m.force }); break;
      case 'toggleFavorite': await this.s.toggleFavorite(m.kind, m.id); this.postFavorites(); break;
      case 'restore': await this.restore(m); break;
      case 'loadTabs': await this.openTabs(m.key, { force: m.force }); break;
      case 'loadAssignments': await this.openAssignments(m.key, { force: m.force }); break;
      case 'loadLayouts': await this.openLayouts(m.key, m.object, { force: m.force }); break;
      case 'loadLogin': await this.openLogin(m.key, { force: m.force }); break;
      case 'userSearch': await this.userSearch(m.text); break;
      case 'lookup': await this.lookup(m); break;
      case 'wizardFields': await this.wizardFields(m.object); break;
      case 'wizardPlan': await this.wizardPlan(m); break;
      case 'wizardApply': await this.wizardApply(m); break;
      case 'revokeApply': await this.revokeApply(m); break;
      case 'clonePs': await this.clonePs(m); break;
      case 'copyProfile': await this.copyProfile(m); break;
      case 'editPs': await this.editPs(m); break;
      case 'loadComponents': await this.openComponents(m.key, { force: m.force }); break;
      case 'permDeps': await this.postDependencies(); break;
      case 'wizardCurrent': await this.wizardCurrent(m); break;
      case 'loadMuting': await this.openMuting(m.key, { force: m.force }); break;
      case 'mutingFields': await this.mutingFields(m); break;
      case 'createMuting': await this.createMuting(m); break;
      case 'loadProfileSettings': await this.openProfileSettings(m.key, { force: m.force }); break;
      case 'loadPolicies': await this.postPolicies(m.key, { force: m.force }); break;
      case 'listOrgs': await this.listOrgs(); break;
      case 'userAccess': await this.userAccess(m); break;
      case 'userFields': await this.userFields(m); break;
      case 'compare': await this.compare(m); break;
      case 'objWizardCurrent': await this.objWizardCurrent(m); break;
      case 'revokePlan': await this.revokePlan(m); break;
      case 'historySetup': await this.historySetup(m); break;
      case 'persist': await this.persist(m.name, m.value); break;
      case 'copy': {
        const text = String(m.text || '');
        await this.s.clipboard(text);
        const lines = text.split('\n').length;
        this.post({ type: 'toast', variant: 'success', title: 'Copied', message: lines > 1 ? lines + ' lines copied to the clipboard.' : text.length > 80 ? text.slice(0, 77) + '…' : text });
        break;
      }
      case 'lookupOptions': await this.lookupOptions(); break;
      case 'lookupPermission': await this.lookupPermission(m); break;
      case 'checkAssignees': await this.checkAssignees(m); break;
      case 'loadAudit': await this.openAudit(m.key, { force: m.force }); break;
      case 'copySummary': await this.copySummary(m); break;
      case 'objWizardInfo': await this.objWizardInfo(m.object); break;
      case 'objWizardPlan': await this.objWizardPlan(m); break;
      case 'objWizardApply': await this.objWizardApply(m); break;
      case 'history': await this.sendHistory(); break;
      case 'undoSnapshot': await this.undoSnapshot(m.snapshotId); break;
      case 'save': await this.save(m); break;
      case 'showLog': this.s.showLog(); break;
      default: break;
    }
  }

  // ---------- org and lists ----------

  async defaultOrgMayHaveChanged() {
    const before = this.ctx && this.ctx.org ? this.ctx.org.username : null;
    const ctx = await this.s.resolveContext().catch(e => ({ error: e }));
    const after = ctx.org ? ctx.org.username : null;
    if (before !== after) {
      this.s.log('Default org changed: ' + (before || 'none') + ' -> ' + (after || 'none'));
      if (this.panel) await this.load({ force: false, ctx });
      else { this.ctx = null; this.conn = null; this.connReady = null; }
    }
    return after;
  }

  load(options) {
    const p = this._load(options);
    this._loading = p;
    p.catch(() => {}).then(() => { if (this._loading === p) this._loading = null; });
    return p;
  }

  kinds() { return this.s.kinds ? this.s.kinds() : ['permissionSet', 'group', 'profile']; }
  _listsKey() { return 'lists:' + this.kinds().join(','); }

  async _load(options) {
    const o = options || {};
    const seq = ++this._ctxSeq;
    this.post({ type: 'context', status: 'loading', message: 'Finding the project’s default org…' });
    let ctx = o.ctx;
    try {
      if (!ctx) ctx = await this.s.resolveContext();
      if (ctx.error) throw ctx.error;
    } catch (e) {
      return this._fail(seq, 'Could not read the project’s default org: ' + (e.message || e));
    }
    if (seq !== this._ctxSeq) return;
    if (!ctx.projectDir || !ctx.org) {
      this.ctx = Object.assign(ctx, { status: ctx.projectDir ? 'noOrg' : 'noProject' });
      this.conn = null; this.connReady = null; this.items.clear();
      return this.post(contextMessage(this.ctx, null));
    }

    const sameOrg = this.ctx && this.ctx.org && this.ctx.org.username === ctx.org.username && this.conn;
    this.ctx = Object.assign(ctx, { status: 'ready', kinds: this.kinds() });
    this.cache = this.s.cacheFor(ctx.org.username);
    if (o.force && this.conn) this.conn.forget();
    if (!sameOrg) { this.items.clear(); this._selected = null; this._object = null; }

    // Cached lists first, so the screen is usable while the org is contacted.
    const meta = this.cache.get('meta');
    const cachedLists = o.force ? null : this.cache.get(this._listsKey());
    if (cachedLists) {
      this._setItems(cachedLists.value);
      this.post(contextMessage(this.ctx, this.conn, { production: meta && meta.value.production, sandbox: meta && meta.value.sandbox, connecting: !this.conn }));
      this.post(this._listsMessage(cachedLists.savedAt, true));
    } else {
      this.post(contextMessage(this.ctx, this.conn, { loading: 'Connecting to ' + (ctx.org.alias || ctx.org.username) + '…', production: meta && meta.value.production }));
    }

    if (!sameOrg || o.force || !this.connReady) {
      this.connReady = this.s.openConnection(ctx.org, ctx.projectDir, this.cache).then(async conn => {
        if (conn.isProduction === null) conn.isProduction = await this.s.detectProduction(conn);
        this.cache.set('meta', { production: conn.isProduction, sandbox: conn.isSandbox === true });
        return conn;
      });
      this.connReady.catch(() => {});
    }
    try {
      const conn = await this.connReady;
      if (seq !== this._ctxSeq) return;
      this.conn = conn;
      this.postFavorites();
      if (!cachedLists) {
        // Favourites first, so the items people actually use appear before the full lists arrive.
        const fav = this.s.favorites().items.filter(f => this.kinds().includes(f.split(':')[0]));
        if (fav.length) {
          const first = await this.s.catalog.listFavorites(conn, fav).catch(e => { this.s.log('Loading favourites failed: ' + e.message); return null; });
          if (first && seq === this._ctxSeq) {
            this._setItems(first);
            this.post(contextMessage(this.ctx, conn));
            this.post(Object.assign(this._listsMessage(Date.now(), true), { partial: true }));
          }
        } else this.post(contextMessage(this.ctx, conn, { loading: 'Reading permission sets, groups and profiles…' }));
      } else this.post(contextMessage(this.ctx, conn));
      const [lists, stamp] = await Promise.all([this._fetchLists(conn), this.s.catalog.changeStamp(conn, this.kinds()).catch(() => null)]);
      if (seq !== this._ctxSeq) return;
      this._listStamp = stamp;
      this._profilesFiltered = this.kinds().includes('profile')
        ? await this.s.loader.profilesFiltered(conn, lists.profile, ctx.org.username).catch(() => false) : false;
      this.cache.set(this._listsKey(), lists);
      this._setItems(lists);
      this.post(this._listsMessage(Date.now(), false));
      this.post(contextMessage(this.ctx, conn));
      // Warm the describes every screen needs, then the favourites' details, without holding anything up.
      Promise.all([conn.describe('PermissionSet'), conn.describe('ObjectPermissions'), conn.globalDescribe()])
        .then(() => this._prefetchFavorites(seq)).catch(e => this.s.log('Prefetch stopped: ' + e.message));
    } catch (e) {
      this.s.log('Loading ' + ctx.org.username + ' failed: ' + (e.stack || e));
      if (seq !== this._ctxSeq) return;
      if (cachedLists) {
        this.post(this._listsMessage(cachedLists.savedAt, false));
        this.post({ type: 'toast', variant: 'error', title: 'Showing saved data', message: 'Could not refresh from the org: ' + (e.message || e), sticky: true });
        this.post(contextMessage(this.ctx, this.conn, { offline: true }));
      } else {
        this._fail(seq, String(e.message || e));
      }
    }
  }

  postFavorites() { const f = this.s.favorites(); this.post({ type: 'favorites', items: f.items, objects: f.objects }); }

  /** Loads favourite items' details into the cache in the background, oldest first, so they open instantly. */
  async _prefetchFavorites(seq) {
    const fav = new Set(this.s.favorites().items);
    const targets = [...this.items.entries()].filter(([, i]) => fav.has(i.kind + ':' + i.apiName) && this.kinds().includes(i.kind)).slice(0, PREFETCH_LIMIT);
    for (const [key, item] of targets) {
      if (seq !== this._ctxSeq) return;
      const cached = this.cache.get('detail:' + key);
      if (cached && Date.now() - cached.savedAt < PREFETCH_FRESH_MS) continue;
      try {
        await this._resolve(item, this.conn);
        this.cache.set('detail:' + key, toView(item, this.conn, await this.s.loader.loadDetail(this.conn, item)));
      } catch (e) { this.s.log('Prefetching ' + item.apiName + ' failed: ' + e.message); }
    }
  }

  /** Favourite objects' pages for the item just opened, in the background. */
  async _prefetchObjects(key) {
    const item = this.items.get(key);
    if (!item || !this.conn) return;
    const dirty = this.cache.get('saved:' + key);
    for (const object of this.s.favorites().objects.slice(0, PREFETCH_LIMIT)) {
      if (this._selected !== key) return;
      const ck = 'object:' + key + ':' + object;
      const cached = this.cache.get(ck);
      if (cached && Date.now() - cached.savedAt < PREFETCH_FRESH_MS && (!dirty || cached.savedAt > dirty.value)) continue;
      try { this.cache.set(ck, await this.s.loader.loadObjectDetail(this.conn, item, object)); } catch (e) { this.s.log('Prefetching ' + object + ' failed: ' + e.message); }
    }
  }

  _fetchLists(conn) { return this.s.catalog.listAll(conn, this.kinds()); }

  /**
   * Background refresh on a timer. The lists are re-read only when the org's
   * change stamp moved; the open item is refreshed by the webview asking for
   * it again (stale-while-revalidate). Skipped while a save is running.
   */
  async autoRefresh() {
    if (!this.conn || this._autoBusy || this._saving || !this.ctx || this.ctx.status !== 'ready') return false;
    this._autoBusy = true;
    const started = Date.now();
    try {
      const stamp = await this.s.catalog.changeStamp(this.conn, this.kinds());
      const changed = stamp !== this._listStamp;
      if (changed) {
        const lists = await this._fetchLists(this.conn);
        this._listStamp = stamp;
        this.cache.set(this._listsKey(), lists);
        this._setItems(lists);
        this.post(this._listsMessage(Date.now(), false));
      } else this.post({ type: 'listsChecked', savedAt: Date.now() });
      this.post({ type: 'autoRefresh' });
      await this._prefetchFavorites(this._ctxSeq);
      this.s.log('Auto-refresh: ' + (changed ? 'lists changed and re-read' : 'lists unchanged') + ', ' + (Date.now() - started) + ' ms');
      return true;
    } catch (e) {
      this.s.log('Auto-refresh failed: ' + (e.message || e));
      return false;
    } finally { this._autoBusy = false; }
  }

  _setItems(lists) {
    const keep = new Map(this.items);
    this.items.clear();
    for (const i of [...lists.permissionSet, ...lists.group, ...lists.profile]) {
      const k = itemKey(i);
      const old = keep.get(k);
      if (old && old.permissionSetId && !i.permissionSetId) i.permissionSetId = old.permissionSetId;
      this.items.set(k, i);
    }
  }

  _listsMessage(savedAt, refreshing) {
    const lists = { permissionSet: [], group: [], profile: [] };
    const kinds = this.kinds();
    for (const [k, i] of this.items) if (kinds.includes(i.kind)) lists[i.kind].push(listRow(k, i));
    return { type: 'lists', lists, kinds, savedAt, refreshing, profilesFiltered: !!this._profilesFiltered };
  }

  _replay() {
    this.post(contextMessage(this.ctx, this.conn));
    this.post(this._listsMessage(Date.now(), false));
  }

  _fail(seq, message) {
    if (seq !== this._ctxSeq) return;
    this.ctx = Object.assign({}, this.ctx || {}, { status: 'error', message });
    this.post(contextMessage(this.ctx, this.conn));
  }

  // ---------- item and object ----------

  async _conn() {
    if (!this.connReady) throw new Error('Not connected to an org.');
    return this.connReady;
  }

  async _resolve(item, conn) {
    if (item.kind === 'group' && !item.permissionSetId) item.permissionSetId = await this.s.catalog.resolveGroupPermissionSet(conn, item.recordId);
    return item;
  }

  async select(key, options) {
    const item = this.items.get(key);
    if (!item) return;
    this._selected = key;
    this._object = null;
    await this._swr('detail:' + key, async () => {
      const conn = await this._conn();
      await this._resolve(item, conn);
      return toView(item, conn, await this.s.loader.loadDetail(conn, item));
    }, (data, savedAt, refreshing) => ({ type: 'detail', key, data, savedAt, refreshing }),
    () => this._selected === key, { type: 'detailError', key }, options);
    if (!(options && options.noPrefetch)) this._prefetchObjects(key).catch(() => {});
    this._sendLocalFile(key).catch(() => {});
  }

  /** Tells the webview whether the item has a source file in the project, for "also update the local file". */
  async _sendLocalFile(key) {
    const item = this.items.get(key);
    if (!item || !this.s.localFile || (item.kind !== 'permissionSet' && item.kind !== 'profile')) return;
    const conn = await this._conn();
    const name = item.kind === 'profile' ? await this.s.metadata.metadataName(conn, item) : item.apiName;
    const file = this.s.localFile.findLocalFile(this.ctx.projectDir, item, name);
    item.localFile = file;
    if (this._selected === key) this.post({ type: 'localFile', key, path: file ? require('path').relative(this.ctx.projectDir, file) : null, mode: this.s.localFileMode ? this.s.localFileMode() : 'ask' });
  }

  /** A group's member permission sets, muting permission set and recalculation status. */
  async openComponents(key, options) {
    const item = this.items.get(key);
    if (!item || item.kind !== 'group') return;
    await this._swr('components:' + key, async () => this.s.loader.loadGroupComponents(await this._conn(), item),
      (data, savedAt, refreshing) => ({ type: 'components', key, data, savedAt, refreshing }), () => this._selected === key, { type: 'componentsError', key }, options);
  }

  /**
   * After a group's members change, Salesforce recalculates its access in the
   * background. Watch the status, tell the screen, and re-read the group's
   * calculated permissions once it settles.
   */
  async pollGroup(key) {
    const item = this.items.get(key);
    if (!item || item.kind !== 'group' || this._polling === key) return;
    this._polling = key;
    const every = this.s.pollMs || 3000;
    try {
      for (let i = 0; i < 60; i++) {
        const status = await this.s.loader.groupStatus(await this._conn(), item.recordId);
        item.status = status;
        this.post({ type: 'groupStatus', key, status });
        if (status !== 'Updating') {
          this.cache.set('saved:' + key, Date.now());
          this.cache.delete('detail:' + key);
          this.cache.delete('components:' + key);
          if (this._selected === key) { await this.select(key, { force: true, noPrefetch: true }); await this.openComponents(key, { force: true }); }
          this.s.log('Group ' + item.apiName + ' recalculated: ' + status);
          return status;
        }
        await new Promise(r => setTimeout(r, every));
      }
      this.s.log('Group ' + item.apiName + ' still recalculating; it will refresh on the next background refresh');
      return 'Updating';
    } catch (e) {
      this.s.log('Watching group ' + item.apiName + ' failed: ' + e.message);
      return null;
    } finally { this._polling = null; }
  }

  // ---------- permission rules, security lookups, licences, Setup Audit Trail ----------

  /** Salesforce's dependency rules for system and custom permissions, cached for a day. */
  async postDependencies() {
    try {
      const conn = await this._conn();
      const hit = this.cache.get('permDeps');
      let deps = hit && Date.now() - hit.savedAt < 24 * 3600 * 1000 ? hit.value : null;
      if (!deps) {
        deps = await this.s.loader.permissionDependencies(conn);
        if (deps.problems.length) this.s.log('Permission rules not fully read: ' + deps.problems.join('; '));
        this.cache.set('permDeps', deps);
      }
      this.post({ type: 'permDeps', system: deps.system, custom: deps.custom });
    } catch (e) { this.s.log('Permission rules not read: ' + e.message); }
  }

  async lookupOptions() {
    try { this.post(Object.assign({ type: 'lookupOptions' }, await this.s.loader.permissionOptions(await this._conn()))); }
    catch (e) { this.post({ type: 'lookupOptions', system: [], custom: [], message: String(e.message || e) }); }
  }

  /** Find access for a system or custom permission. */
  async lookupPermission(m) {
    try {
      const r = await this.s.loader.whoHasPermission(await this._conn(), m);
      for (const src of r.sources) src.key = this._keyForSource(src);
      this.post({ type: 'lookupResult', result: r });
    } catch (e) { this.post({ type: 'lookupResult', result: { error: String(e.message || e) } }); }
  }

  _keyForSource(src) {
    for (const [k, i] of this.items) {
      if (src.kind === 'profile' && i.kind === 'profile' && i.recordId === src.profileId) return k;
      if (src.kind === 'group' && i.kind === 'group' && i.recordId === src.groupId) return k;
      if (src.kind === 'permissionSet' && i.kind === 'permissionSet' && i.permissionSetId === src.permissionSetId) return k;
    }
    return null;
  }

  /** Users about to be assigned who can't hold this permission set (licence rules). */
  async checkAssignees(m) {
    const item = this.items.get(m.key);
    if (!item) return;
    try {
      const conn = await this._conn();
      const [b, fix] = await Promise.all([this.s.loader.assignmentBlockers(conn, item, m.userIds || []), this.s.loader.licenseFix(conn, item, m.userIds || []).catch(() => null)]);
      this.post({ type: 'assigneeChecks', key: m.key, blockers: Object.fromEntries(b), licenseFix: fix && fix.users.length ? { label: fix.label, users: fix.users } : null });
    } catch (e) { this.s.log('Licence check failed: ' + e.message); }
  }

  /** Setup Audit Trail entries about this item. */
  async openAudit(key, options) {
    const item = this.items.get(key);
    if (!item) return;
    await this._swr('audit:' + key, async () => {
      try { return { items: await this.s.loader.setupChanges(await this._conn(), item, 90) }; }
      catch (e) {
        if (/INSUFFICIENT_ACCESS|not supported|INVALID_TYPE|sObject type/i.test(e.message)) return { items: [], denied: true };
        throw e;
      }
    }, (data, savedAt, refreshing) => ({ type: 'audit', key, data, savedAt, refreshing }), () => this._selected === key, { type: 'auditError', key }, options);
  }

  // ---------- screen state kept across sessions ----------

  _persistKey(name) { return 'permStudio.ui.' + name + (name === 'pending' && this.ctx && this.ctx.org ? ':' + this.ctx.org.username : ''); }
  _persisted() {
    const m = this.s.memento;
    if (!m) return {};
    return Object.fromEntries(['pending', 'recentLookups', 'grantTemplates', 'lastTicket'].map(n => [n, m.get(this._persistKey(n)) || null]));
  }
  /** Unsaved changes, recent searches, templates and the last ticket survive closing the tab or reloading VS Code. */
  async persist(name, value) {
    if (!['pending', 'recentLookups', 'grantTemplates', 'lastTicket'].includes(name) || !this.s.memento) return;
    await this.s.memento.update(this._persistKey(name), value == null ? undefined : value);
    if (name === 'pending' && this.panel) this.panel.title = value && value.entries && value.entries.length ? '● Permission Studio' : 'Permission Studio';
  }

  // ---------- grant screens: what each item has now ----------

  /** Each item's users and parent permission set, for the grant screens. */
  async _targetMap(conn) {
    const [profilePs, counts] = await Promise.all([this.s.loader.profilePermissionSets(conn), this.s.loader.assigneeCounts(conn).catch(() => new Map())]);
    const byParent = new Map();
    for (const [k, i] of this.items) {
      if (i.kind === 'permissionSet' && i.permissionSetId) byParent.set(i.permissionSetId, k);
    }
    const profiles = new Map([...this.items.entries()].filter(([, i]) => i.kind === 'profile').map(([k, i]) => [i.recordId, [k, i]]));
    for (const [psId, profileId] of profilePs) {
      const hit = profiles.get(profileId);
      if (hit) { byParent.set(psId, hit[0]); hit[1].permissionSetId = hit[1].permissionSetId || psId; }
    }
    return { byParent, counts };
  }

  async wizardCurrent(m) {
    try {
      const conn = await this._conn();
      const [{ byParent, counts }, fields, objs] = await Promise.all([this._targetMap(conn), this.s.loader.fieldAccessAll(conn, m.fields || []), this.s.loader.objectAccessAll(conn, m.object)]);
      const byKey = {};
      for (const [psId, key] of byParent) {
        byKey[key] = { users: counts.get(psId) || 0, fields: fields.get(psId) || {}, objectRead: !!((objs.byParent.get(psId) || {}).read) };
      }
      this.post({ type: 'wizardCurrent', object: m.object, fields: m.fields, byKey });
    } catch (e) { this.post({ type: 'wizardCurrent', object: m.object, fields: m.fields, byKey: {}, message: String(e.message || e) }); }
  }

  async objWizardCurrent(m) {
    try {
      const conn = await this._conn();
      const [{ byParent, counts }, objs] = await Promise.all([this._targetMap(conn), this.s.loader.objectAccessAll(conn, m.object)]);
      const byKey = {};
      for (const [psId, key] of byParent) byKey[key] = { users: counts.get(psId) || 0, props: objs.byParent.get(psId) || {} };
      this.post({ type: 'objWizardCurrent', object: m.object, byKey, columns: objs.columns });
    } catch (e) { this.post({ type: 'objWizardCurrent', object: m.object, byKey: {}, columns: [], message: String(e.message || e) }); }
  }

  /**
   * Find access "Remove from selected": take the looked-up access away from
   * some of its sources, as a plan saved with the same path as the wizards.
   */
  async revokePlan(m) {
    try {
      const conn = await this._conn();
      const plan = [];
      const skipped = [];
      const cat = m.field ? 'field' : 'object';
      const targets = [];
      for (const k of m.sourceKeys || []) {
        const it = this.items.get(k);
        if (!it) continue;
        const why = editBlocker(it, cat);
        if (why) { skipped.push({ key: k, label: it.label, reason: why }); continue; }
        await this._resolve(it, conn);
        targets.push([k, it]);
      }
      const ids = targets.map(([, it]) => it.permissionSetId);
      if (m.field) {
        const now = await this.s.loader.fieldAccessAll(conn, [m.field]);
        for (const [k, it] of targets) {
          const cur = (now.get(it.permissionSetId) || {})[m.field] || { read: false, edit: false };
          const after = m.level === 'edit' ? { read: cur.read, edit: false } : { read: false, edit: false };
          if (cur.read === after.read && cur.edit === after.edit) { skipped.push({ key: k, label: it.label, reason: 'Gets it another way (for example Modify All Data or View All Fields), not from field access.' }); continue; }
          plan.push({ key: k, label: it.label, kind: it.kind, changes: [{ key: 'field:' + m.field, before: cur, after, label: m.field }] });
        }
      } else {
        const objs = ids.length ? await this.s.loader.loadObjectAccessFor(conn, ids, m.object) : { byParent: new Map(), columns: [] };
        for (const [k, it] of targets) {
          const cur = Object.assign(Object.fromEntries(objs.columns.map(c => [c, false])), objs.byParent.get(it.permissionSetId) || {});
          if (!cur[m.level]) { skipped.push({ key: k, label: it.label, reason: 'Gets it another way (for example Modify All Data), not from object permissions.' }); continue; }
          const after = applyObject(cur, m.level, false).props;
          plan.push({ key: k, label: it.label, kind: it.kind, changes: [{ key: 'object:' + m.object, before: cur, after: Object.fromEntries(objs.columns.map(c => [c, after[c] === true])), label: m.object }] });
        }
      }
      this.post({ type: 'revokePlan', plan, skipped });
    } catch (e) { this.post({ type: 'revokePlan', error: String(e.message || e) }); }
  }

  /** Setup Audit Trail entries about any permission set, profile or group, for History. */
  async historySetup(m) {
    try {
      const names = [...new Set([...this.items.values()].map(i => i.label))];
      const rows = await this.s.loader.setupChangesFor(await this._conn(), names, m.days || 30);
      const byLabel = new Map([...this.items.entries()].map(([k, i]) => [i.label, k]));
      this.post({ type: 'historySetup', entries: rows.map(r => Object.assign(r, { key: byLabel.get(r.name) || null })) });
    } catch (e) {
      this.post({ type: 'historySetup', entries: [], denied: /INSUFFICIENT_ACCESS|not supported|INVALID_TYPE/i.test(e.message), message: String(e.message || e) });
    }
  }

  // ---------- change summaries ----------

  /** Copies a summary of the given saves (by snapshot id) as Markdown or tab-separated text. */
  async copySummary(m) {
    try {
      const all = await this.s.history.readLog(this.ctx.projectDir, { org: this.ctx.org.username });
      const ids = new Set(m.snapshotIds || []);
      const entries = all.filter(e => e.snapshot && ids.has(e.snapshot));
      if (!entries.length) throw new Error('Those saves are not in this project’s change log.');
      const org = this.ctx.org.alias || this.ctx.org.username;
      const text = m.format === 'tsv' ? this.s.summary.toTsv(entries, { org }) : this.s.summary.toMarkdown(entries, { org });
      await this.s.clipboard(text);
      const n = this.s.summary.rows(entries).length;
      this.post({ type: 'toast', variant: 'success', title: 'Copied', message: 'Summary of ' + n + (n === 1 ? ' change' : ' changes') + (m.format === 'tsv' ? ', ready to paste into Excel.' : ' as a Markdown table.') });
      return text;
    } catch (e) {
      this.post({ type: 'toast', variant: 'error', title: 'Could not copy the summary', message: String(e.message || e) });
      return null;
    }
  }

  // ---------- opening an item from elsewhere ----------

  /** Ctrl/Cmd+S pressed while this screen has focus (VS Code's key binding). */
  shortcut(name) { if (this.panel) this.post({ type: 'shortcut', name }); }

  /** Shows the screen and opens the item, once the webview is ready. */
  async openItem(key) {
    this.show();
    if (this._loading) await this._loading;
    if (this._webviewReady) this.post({ type: 'selectKey', key }); else this._pendingOpen = key;
  }

  /** The list item for a permission set, profile or group source file, loading it if its list is hidden. */
  async itemForFile(fsPath) {
    const m = /^(.+)\.(permissionset|profile|permissionsetgroup)-meta\.xml$/.exec(require('path').basename(fsPath));
    if (!m) throw new Error('Not a permission set, profile or permission set group file.');
    if (this._loading) await this._loading;
    const kind = { permissionset: 'permissionSet', profile: 'profile', permissionsetgroup: 'group' }[m[2]];
    let name = m[1];
    if (kind === 'profile') { try { name = decodeURIComponent(name); } catch (e) { /* keep as is */ } name = STANDARD_PROFILES[name] || name; }
    const find = () => [...this.items.entries()].find(([, i]) => i.kind === kind && (kind === 'profile' ? i.label === name : i.apiName === name));
    let hit = find();
    if (!hit && this.conn) {
      const extra = kind === 'permissionSet' ? await this.s.catalog.listPermissionSets(this.conn, [name])
        : kind === 'group' ? await this.s.catalog.listGroups(this.conn, [name]) : await this.s.catalog.listProfiles(this.conn, [name]);
      for (const i of extra) this.items.set(itemKey(i), i);
      hit = find();
    }
    if (!hit) throw new Error('“' + name + '” was not found in ' + (this.ctx && this.ctx.org ? this.ctx.org.alias || this.ctx.org.username : 'the org') + '.');
    return hit[0];
  }

  /** Entries for the Command Palette quick pick: favourites first, then by label. */
  async quickPickItems() {
    if (this._loading) await this._loading;
    const fav = new Set(this.s.favorites().items);
    const kindLabel = { permissionSet: 'Permission set', group: 'Permission set group', profile: 'Profile' };
    return [...this.items.entries()].filter(([, i]) => this.kinds().includes(i.kind))
      .map(([key, i]) => ({ key, favorite: fav.has(i.kind + ':' + i.apiName), label: i.label, description: i.apiName !== i.label ? i.apiName : '',
        detail: [kindLabel[i.kind], i.license, i.managed ? 'Managed' : '', i.standard ? 'Standard' : ''].filter(Boolean).join(' · ') }))
      .sort((a, b) => (b.favorite - a.favorite) || a.label.localeCompare(b.label));
  }

  async openTabs(key, options) {
    const item = this.items.get(key);
    if (!item) return;
    await this._swr('tabs:' + key, async () => {
      const conn = await this._conn();
      await this._resolve(item, conn);
      const tabs = await this.cache.swr('entities:tabs', () => this.s.loader.listTabs(conn), null, { force: options && options.force, maxAgeMs: 10 * 60 * 1000 });
      return this.s.loader.loadTabsPage(conn, item, tabs.value);
    }, (data, savedAt, refreshing) => ({ type: 'tabsDetail', key, data, savedAt, refreshing }), () => this._selected === key, { type: 'tabsError', key }, options);
  }

  async openAssignments(key, options) {
    const item = this.items.get(key);
    if (!item) return;
    await this._swr('assign:' + key, async () => {
      const conn = await this._conn();
      await this._resolve(item, conn);
      return this.s.loader.loadAssignments(conn, item);
    }, (data, savedAt, refreshing) => ({ type: 'assignments', key, data, savedAt, refreshing }), () => this._selected === key, { type: 'assignError', key }, options);
  }

  async openLayouts(key, object, options) {
    const item = this.items.get(key);
    if (!item || item.kind !== 'profile') return;
    await this._swr('layouts:' + key + ':' + object, async () => this.s.metadata.readLayouts(await this._conn(), item, object),
      (data, savedAt, refreshing) => ({ type: 'layouts', key, object, data, savedAt, refreshing }),
      () => this._selected === key && this._object === object, { type: 'layoutsError', key, object }, options);
  }

  async openLogin(key, options) {
    const item = this.items.get(key);
    if (!item || item.kind !== 'profile') return;
    await this._swr('login:' + key, async () => this.s.metadata.readLoginSettings(await this._conn(), item),
      (data, savedAt, refreshing) => ({ type: 'loginSettings', key, data, savedAt, refreshing }), () => this._selected === key, { type: 'loginError', key }, options);
  }

  async userSearch(text) {
    try { this.post({ type: 'users', text, users: await this.s.loader.searchUsers(await this._conn(), text) }); } catch (e) { this.post({ type: 'users', text, users: [], message: String(e.message || e) }); }
  }

  // ---------- who has access ----------

  async lookup(m) {
    try {
      const r = await this.s.loader.whoHasAccess(await this._conn(), { object: m.object, field: m.field || null, level: m.level });
      const keyOf = src => src.kind === 'group' ? 'group:' + src.groupId : src.kind === 'profile' ? 'profile:' + src.profileId : 'permissionSet:' + src.permissionSetId;
      for (const src of r.sources) src.key = this.items.has(keyOf(src)) ? keyOf(src) : null;
      this.post({ type: 'lookupResult', result: r });
    } catch (e) {
      this.s.log('Lookup failed: ' + (e.stack || e));
      this.post({ type: 'lookupResult', error: String(e.message || e) });
    }
  }

  // ---------- field access wizard ----------

  async wizardFields(object) {
    try {
      const d = await (await this._conn()).describe(object);
      const fields = d.fields.filter(f => f.permissionable === true).map(f => ({ name: object + '.' + f.name, apiName: f.name, label: f.label, type: f.type, custom: !!f.custom,
        canEdit: !f.calculated && (f.updateable === true || f.createable === true) })).sort((a, b) => a.label.localeCompare(b.label));
      this.post({ type: 'wizardFields', object, fields });
    } catch (e) { this.post({ type: 'wizardFields', object, fields: [], message: String(e.message || e) }); }
  }

  /** Works out, per target, exactly which entries the wizard would change. Nothing is written. */
  async wizardPlan(m) {
    try {
      const conn = await this._conn();
      const targets = [];
      const skipped = [];
      for (const k of m.targets || []) {
        const it = this.items.get(k);
        if (!it) continue;
        const why = editBlocker(it, 'field');
        if (why) { skipped.push({ key: k, label: it.label, reason: why }); continue; }
        await this._resolve(it, conn);
        targets.push([k, it]);
      }
      const ids = targets.map(([, it]) => it.permissionSetId);
      const objAllowed = await this.s.loader.objectPermissionNames(conn);
      const [fieldsBy, objs] = ids.length ? await Promise.all([this.s.loader.loadFieldPermissions(conn, ids, m.object), this.s.loader.loadObjectAccessFor(conn, ids, m.object)]) : [new Map(), { byParent: new Map(), columns: [] }];
      const plan = [];
      for (const [k, it] of targets) {
        const changes = [];
        const have = fieldsBy.get(it.permissionSetId) || new Map();
        for (const f of m.fields) {
          const cur = have.get('field:' + f.name) || { read: false, edit: false };
          const want = { read: true, edit: m.level === 'edit' ? !!f.canEdit || cur.edit : cur.edit };
          if (want.read !== cur.read || want.edit !== cur.edit) changes.push({ key: 'field:' + f.name, before: cur, after: want, label: f.label });
        }
        if (m.grantObject && changes.length && (!objAllowed || objAllowed.has(m.object))) {
          const blank = Object.fromEntries(objs.columns.map(c => [c, false]));
          const cur = Object.assign({}, blank, objs.byParent.get(it.permissionSetId) || {});
          let next = cur;
          if (!next.read) next = applyObject(next, 'read', true).props;
          if (m.level === 'edit' && !next.edit) next = applyObject(next, 'edit', true).props;
          const after = Object.fromEntries(objs.columns.map(c => [c, next[c] === true]));
          if (objs.columns.some(c => after[c] !== cur[c])) changes.unshift({ key: 'object:' + m.object, before: cur, after, label: m.object });
        }
        if (changes.length) plan.push({ key: k, label: it.label, kind: it.kind, changes });
        else skipped.push({ key: k, label: it.label, reason: 'Already has this access.' });
      }
      this.post({ type: 'wizardPlan', plan, skipped, object: m.object });
    } catch (e) {
      this.s.log('Wizard plan failed: ' + (e.stack || e));
      this.post({ type: 'wizardPlan', error: String(e.message || e) });
    }
  }

  /**
   * Saves a bulk plan (one change list per item) item by item, each with its own
   * snapshot and change-log entry, reporting progress as it goes.
   */
  async _applyPlan(m, progressType, resultType, path) {
    if (this._saving) return this.post({ type: resultType, error: 'A save is already running. Wait for it to finish.' });
    if (!m || !Array.isArray(m.plan)) return this.post({ type: resultType, error: 'Nothing to save.' });
    const conn = await this._conn().catch(e => { this.post({ type: resultType, error: String(e.message || e) }); return null; });
    if (!conn) return;
    if (conn.isProduction && !this._confirmed(m.confirm)) return this.post({ type: resultType, error: 'Type the org’s alias or username to confirm saving to production.' });
    const results = [];
    this._saving = true;
    try {
      for (let i = 0; i < (m.plan || []).length; i++) {
        const t = m.plan[i];
        const item = this.items.get(t.key);
        this.post({ type: progressType, done: i, total: m.plan.length, label: t.label });
        if (!item) { results.push({ key: t.key, label: t.label, status: 'error', message: 'No longer in the list.' }); continue; }
        const r = await this._applyAndLog(conn, item, t.changes.map(c => ({ key: c.key, before: c.before, after: c.after, label: c.label })), { path });
        results.push(Object.assign({ key: t.key, label: t.label }, r));
        this.cache.set('saved:' + t.key, Date.now());
        this.cache.delete('detail:' + t.key);
      }
    } finally { this._saving = false; }
    this.post({ type: resultType, results });
  }

  wizardApply(m) { return this._applyPlan(m, 'wizardProgress', 'wizardResult', 'field access wizard'); }
  /** Find access "Remove from selected". */
  revokeApply(m) { return this._applyPlan(m, 'wizardProgress', 'wizardResult', 'Find access: remove'); }

  // ---------- object access wizard ----------

  async objWizardInfo(object) {
    try {
      const conn = await this._conn();
      const [types, cols] = await Promise.all([this.s.loader.listRecordTypes(conn, object), this.s.loader.objectColumns(conn)]);
      this.post({ type: 'objWizardInfo', object, recordTypes: types.filter(t => t.active), columns: cols.map(c => c[1]) });
    } catch (e) { this.post({ type: 'objWizardInfo', object, recordTypes: [], columns: [], message: String(e.message || e) }); }
  }

  /**
   * Per target: the object permissions to add (never removed, rules applied)
   * and the record types to assign, with the default on profiles. Record type
   * assignments are read per target through the Metadata API, a few at a time.
   */
  async objWizardPlan(m) {
    try {
      const conn = await this._conn();
      const allowedObjects = await this.s.loader.objectPermissionNames(conn);
      if (allowedObjects && !allowedObjects.has(m.object)) throw new Error(m.object + ' has no object permissions in Salesforce' + (/^(Task|Event)$/.test(m.object) ? ': activity access comes from the Edit Tasks and Edit Events system permissions.' : '.') + ' Use Grant field access for its fields.');
      const targets = [];
      const skipped = [];
      const needRt = (m.recordTypes || []).length > 0 || !!m.defaultRt;
      for (const k of m.perTarget ? Object.keys(m.perTarget) : m.targets || []) {
        const it = this.items.get(k);
        if (!it) continue;
        const why = editBlocker(it, 'object') || (needRt ? editBlocker(it, 'recordType') : null);
        if (why) { skipped.push({ key: k, label: it.label, reason: why }); continue; }
        await this._resolve(it, conn);
        targets.push([k, it]);
      }
      const objs = targets.length ? await this.s.loader.loadObjectAccessFor(conn, targets.map(([, it]) => it.permissionSetId), m.object) : { byParent: new Map(), columns: [] };
      const allTypes = needRt ? (await this.s.loader.listRecordTypes(conn, m.object)).map(t => t.name) : [];
      const limit = this.s.gate ? this.s.gate(3) : f => f();
      const vis = needRt ? await Promise.all(targets.map(([, it]) => limit(() => this.s.metadata.readRecordTypes(conn, it, allTypes)))) : [];
      const plan = [];
      targets.forEach(([k, it], i) => {
        const changes = [];
        const blank = Object.fromEntries(objs.columns.map(c => [c, false]));
        const cur = Object.assign({}, blank, objs.byParent.get(it.permissionSetId) || {});
        let next = cur;
        for (const f of (m.perTarget ? m.perTarget[k] : m.flags) || []) if (objs.columns.includes(f) && !next[f]) next = applyObject(next, f, true).props;
        const after = Object.fromEntries(objs.columns.map(c => [c, next[c] === true]));
        if (objs.columns.some(c => after[c] !== cur[c])) changes.push({ key: 'object:' + m.object, before: cur, after, label: m.object });
        if (needRt) {
          const v = vis[i];
          const profile = it.kind === 'profile';
          const now = name => Object.assign(profile ? { visible: false, default: false } : { visible: false }, v.get(name) || {});
          const want = new Map();
          for (const name of m.recordTypes || []) want.set(name, Object.assign(now(name), { visible: true }));
          if (profile) {
            const def = m.defaultRt || (![...allTypes].some(n => now(n).default) ? (m.recordTypes || [])[0] : null);
            if (def) {
              for (const n of allTypes) if (now(n).default && n !== def) want.set(n, Object.assign(want.get(n) || now(n), { default: false }));
              want.set(def, Object.assign(want.get(def) || now(def), { visible: true, default: true }));
            }
          }
          for (const [name, a] of want) if (JSON.stringify(a) !== JSON.stringify(now(name))) changes.push({ key: 'recordType:' + name, before: now(name), after: a, label: name.split('.').pop() });
        }
        if (changes.length) plan.push({ key: k, label: it.label, kind: it.kind, changes });
        else skipped.push({ key: k, label: it.label, reason: 'Already has this access.' });
      });
      this.post({ type: 'objWizardPlan', plan, skipped, object: m.object });
    } catch (e) {
      this.s.log('Object wizard plan failed: ' + (e.stack || e));
      this.post({ type: 'objWizardPlan', error: String(e.message || e) });
    }
  }

  objWizardApply(m) { return this._applyPlan(m, 'objWizardProgress', 'objWizardResult', 'object access wizard'); }

  /**
   * A save error in plain words. When Salesforce says the record doesn't exist,
   * check whether the item itself was deleted (in Setup, by someone else) and say so.
   */
  async _explain(conn, item, e) {
    const msg = String((e && e.message) || e);
    if (!/INVALID_CROSS_REFERENCE_KEY|ENTITY_IS_DELETED|INVALID_ID_FIELD|entity is deleted/i.test(msg)) return msg;
    try {
      const r = await conn.query('SELECT Id FROM PermissionSet WHERE Id = ' + soqlStr(item.permissionSetId));
      if (r.records.length) return msg;
      this.load({ force: true }).catch(() => {});
      return item.label + ' no longer exists in ' + (this.ctx.org.alias || this.ctx.org.username) + ': it may have been deleted in Setup. The lists are being refreshed; nothing was saved.';
    } catch (x) { return msg; }
  }

  /** The typed org name, ignoring case and surrounding spaces; a wrong name is still refused. */
  _confirmed(typed) {
    const t = String(typed || '').trim().toLowerCase();
    return !!t && [this.ctx.org.alias, this.ctx.org.username].some(n => n && String(n).toLowerCase() === t);
  }

  /** apply() plus snapshot and log, returning { status, count, message, snapshotId }. */
  async _applyAndLog(conn, item, changes, extra) {
    const started = Date.now();
    const logBase = { org: this.ctx.org.username, target: item.apiName, kind: item.kind, permissionSetId: item.permissionSetId, path: (extra && extra.path) || 'records', count: changes.length };
    try {
      await this._resolve(item, conn);
      const r = await this.s.applyChanges(conn, item, changes, {
        force: !!(extra && extra.force), metadata: this.s.metadata, assignLicenses: !!(extra && extra.assignLicenses),
        onSnapshot: (snapshot, safety) => this.s.history.saveSnapshot(this.ctx.projectDir, { org: this.ctx.org.username, target: item.apiName, permissionSetId: item.permissionSetId, items: snapshot, safety: safety || undefined }),
        onProgress: extra && extra.onProgress, log: l => this.s.log(l), pollMs: this.s.pollMs
      });
      if (r.status === 'conflict') return { status: 'conflict', conflicts: r.conflicts, message: 'Changed in the org since it was read; nothing written.' };
      await this.s.history.appendLog(this.ctx.projectDir, Object.assign(logBase, { result: r.mismatches.length ? 'saved with differences' : 'saved', snapshot: r.snapshotId,
        changes: changes.map(c => ({ key: c.key, label: c.label, from: c.before, to: c.after })), ms: Date.now() - started })).catch(e => this.s.log('Change log write failed: ' + e.message));
      return { status: 'saved', count: r.count, mismatches: r.mismatches, snapshotId: r.snapshotId, snapshot: r.snapshot };
    } catch (e) {
      this.s.log('Save to ' + item.apiName + ' failed' + (e.failedStep ? ' at "' + e.failedStep + '"' : '') + ': ' + (e.stack || e));
      await this.s.history.appendLog(this.ctx.projectDir, Object.assign(logBase, { result: 'failed', error: String(e.message || e), failedStep: e.failedStep || null,
        completedSteps: e.completedSteps || [], snapshot: e.snapshotId || null, changes: changes.map(c => ({ key: c.key, label: c.label, from: c.before, to: c.after })), ticket })).catch(() => {});
      return { status: 'error', message: String(e.message || e), partial: !!(e.completedSteps && e.completedSteps.length), snapshotId: e.snapshotId || null, restorable: !!e.restorable };
    }
  }

  // ---------- create, clone, edit ----------

  async _confirmWrite(conn, m, type) {
    if (conn.isProduction && !this._confirmed(m.confirm)) { this.post({ type, error: 'Type the org’s alias or username to confirm changing production.' }); return false; }
    return true;
  }

  async _reloadListsAndSelect(key) {
    const lists = await this._fetchLists(this.conn);
    this.cache.set(this._listsKey(), lists);
    this._setItems(lists);
    this.post(this._listsMessage(Date.now(), false));
    if (key && this.items.has(key)) { this.post({ type: 'selectKey', key }); }
  }

  async editPs(m) {
    const item = this.items.get(m.key);
    try {
      const conn = await this._conn();
      if (!item || item.kind !== 'permissionSet' || item.managed) throw new Error('Only your own permission sets can be renamed here.');
      const bad = nameProblem(m.label, m.name, m.description);
      if (bad) throw new Error(bad);
      if (!await this._confirmWrite(conn, m, 'psSaved')) return;
      await conn.update('PermissionSet', [{ Id: item.permissionSetId, Name: m.name, Label: m.label, Description: m.description || null }]);
      await this.s.history.appendLog(this.ctx.projectDir, { org: this.ctx.org.username, target: m.name, kind: 'permissionSet', path: 'rename', result: 'saved', count: 1,
        changes: [{ key: 'details', from: { name: item.apiName, label: item.label, description: item.description }, to: { name: m.name, label: m.label, description: m.description } }] }).catch(() => {});
      this.cache.delete('detail:' + m.key);
      await this._reloadListsAndSelect(m.key);
      this.post({ type: 'psSaved', mode: 'edit', key: m.key, label: m.label });
      await this.select(m.key, { force: true, noPrefetch: true });
    } catch (e) { this.s.log('Rename failed: ' + (e.stack || e)); this.post({ type: 'psSaved', error: String(e.message || e) }); }
  }

  /**
   * Clone: a new permission set with the same license and description, then
   * every object, field, system, class, page, custom permission, flow, app,
   * connected app, custom metadata and custom setting grant copied as
   * records, then record type assignments and tab settings deployed.
   */
  async clonePs(m) { return this._copyInto(m, 'clone'); }

  /**
   * Profile to permission set: copies a profile's object, field, system,
   * class, page and other access, tab settings and record types into a new
   * permission set (with the profile's user license), the permission-set-led
   * model Salesforce recommends. Page layouts, login hours and IP ranges stay
   * on the profile; nothing is removed from it.
   */
  async copyProfile(m) { return this._copyInto(m, 'copyProfile'); }

  async _copyInto(m, mode) {
    const src = this.items.get(m.key);
    const progress = label => this.post({ type: 'cloneProgress', label });
    try {
      const conn = await this._conn();
      if (!src || src.kind !== (mode === 'clone' ? 'permissionSet' : 'profile')) throw new Error(mode === 'clone' ? 'Only permission sets can be cloned.' : 'Only profiles can be copied to a permission set.');
      const bad = nameProblem(m.label, m.name, m.description);
      if (bad) throw new Error(bad);
      if ([...this.items.values()].some(i => i.kind === 'permissionSet' && !i.managed && i.apiName.toLowerCase() === String(m.name).toLowerCase())) throw new Error('A permission set named ' + m.name + ' already exists. Pick another API name.');
      if (!await this._confirmWrite(conn, m, 'psSaved')) return;
      await this._resolve(src, conn);
      progress('Creating the permission set');
      const rec = { Name: m.name, Label: m.label, Description: m.description || src.description || null };
      if (mode === 'clone') {
        const lic = await conn.query('SELECT LicenseId FROM PermissionSet WHERE Id = ' + soqlStr(src.permissionSetId));
        if (lic.records[0] && lic.records[0].LicenseId) rec.LicenseId = lic.records[0].LicenseId;
      } else if (m.useLicense !== false) {
        // Some system permissions only exist with a user license; the profile's own keeps them all valid.
        const lic = await conn.query('SELECT UserLicenseId FROM Profile WHERE Id = ' + soqlStr(src.recordId));
        if (lic.records[0] && lic.records[0].UserLicenseId) rec.LicenseId = lic.records[0].UserLicenseId;
      }
      const [id] = await conn.create('PermissionSet', [rec]);
      progress('Copying object, field, system and other access');
      const safety = await this.s.metadata.captureSafety(conn, src.permissionSetId);
      await this.s.metadata.restoreSafety(conn, id, safety);
      const target = { kind: 'permissionSet', permissionSetId: id, recordId: id, apiName: m.name, label: m.label };
      progress('Copying tab settings and record type assignments');
      const [rts, tabs] = await Promise.all([
        this.s.metadata.readAllRecordTypes(conn, src).catch(e => { this.s.log('Copy: record types not copied: ' + e.message); return []; }),
        this.s.loader.loadTabSettings(conn, src.permissionSetId)
      ]);
      // Tab settings are records; record types still need a deploy.
      const tabRows = [...tabs].map(([t, v]) => ({ attributes: { type: 'PermissionSetTabSetting' }, ParentId: id, Name: t, Visibility: v === 'Visible' ? 'DefaultOn' : 'DefaultOff' }));
      if (tabRows.length) await conn.createRecords(tabRows);
      const meta = rts.map(t => ({ key: 'recordType:' + t.name, after: { visible: true } }));
      if (meta.length) {
        const copy = await this.s.metadata.captureSafety(conn, id);
        await this.s.metadata.deployEntries(conn, target, meta);
        const lost = await this.s.metadata.checkSafety(conn, id, copy);
        if (lost.count) await this.s.metadata.restoreSafety(conn, id, copy);
      }
      const counts = { objects: safety.objects.length, fields: safety.fields.length, system: safety.system.length, entities: safety.entities.length, tabs: tabRows.length, recordTypes: meta.length };
      await this.s.history.appendLog(this.ctx.projectDir, { org: this.ctx.org.username, target: m.name, kind: 'permissionSet', path: mode === 'clone' ? 'clone' : 'copy from profile',
        result: 'created', from: src.apiName, count: Object.values(counts).reduce((a, b) => a + b, 0) }).catch(() => {});
      await this._reloadListsAndSelect('permissionSet:' + id);
      this.post({ type: 'psSaved', mode, key: 'permissionSet:' + id, label: m.label, counts, from: src.label });
    } catch (e) { this.s.log((mode === 'clone' ? 'Clone' : 'Copy from profile') + ' failed: ' + (e.stack || e)); this.post({ type: 'psSaved', error: String(e.message || e) }); }
  }


  // ---------- history ----------

  async sendHistory() {
    const entries = await this.s.history.readLog(this.ctx.projectDir, { org: this.ctx.org.username, limit: 300 });
    for (const e of entries) {
      const it = [...this.items.entries()].find(([, i]) => (e.permissionSetId && i.permissionSetId === e.permissionSetId) || (i.apiName === e.target && i.kind === e.kind));
      e.key = it ? it[0] : null;
    }
    this.post({ type: 'history', entries });
  }

  /** Stages the values a snapshot recorded, against the org's current values, for review. */
  async undoSnapshot(id) {
    try {
      const snap = await this.s.history.loadSnapshot(this.ctx.projectDir, id);
      const found = [...this.items.entries()].find(([, i]) => i.permissionSetId === snap.permissionSetId);
      if (!found) throw new Error('“' + snap.target + '” is not in this org’s list.');
      const [key, item] = found;
      const conn = await this._conn();
      await this._resolve(item, conn);
      const items = (snap.items || []).filter(i => !i.key.startsWith('details'));
      const refs = new Map(items.filter(i => i.ref).map(i => [i.key, i.ref]));
      const live = await currentValues(conn, item, items.map(i => i.key), refs, this.s.metadata);
      const changes = items.map(i => ({ key: i.key, ref: i.ref || null, before: live.props.get(i.key), after: i.before }));
      this.post({ type: 'stageChanges', key, changes, takenAt: snap.takenAt });
    } catch (e) {
      this.s.log('Undo failed: ' + (e.stack || e));
      this.post({ type: 'toast', variant: 'error', title: 'Can’t undo that save', message: String(e.message || e), sticky: true });
    }
  }

  /** Apex class or custom permission tab: every entity in the org with whether this item grants it. */
  async openAccess(key, category, options) {
    const item = this.items.get(key);
    if (!item) return;
    if (META_ACCESS.includes(category)) return this.openMetaAccess(item, key, category, options);
    if (!this.s.loader.ENTITY[category]) return;
    await this._swr('access:' + key + ':' + category, async () => {
      const conn = await this._conn();
      await this._resolve(item, conn);
      const entities = await this.cache.swr('entities:' + category, () => this.s.loader.listEntities(conn, category), null, { force: options && options.force, maxAgeMs: 10 * 60 * 1000 });
      return this.s.loader.loadEntityAccess(conn, item, category, entities.value);
    }, (data, savedAt, refreshing) => ({ type: 'accessDetail', key, category, data, savedAt, refreshing }),
    () => this._selected === key, { type: 'accessError', key, category }, options);
  }

  /**
   * Agents, external credential principals, external data sources, presence
   * statuses and email routing addresses: what the org has (best effort) and what
   * the item enables (one Metadata API retrieve, shared by all five, cached).
   */
  async openMetaAccess(item, key, category, options) {
    const dirty = this.cache.get('saved:' + key);
    await this._swr('access:' + key + ':' + category, async () => {
      const conn = await this._conn();
      const [list, enabled] = await Promise.all([
        this.cache.swr('metaEntities:' + category, () => this.s.loader.listMetaEntities(conn, category), null, { force: options && options.force, maxAgeMs: 10 * 60 * 1000 }).then(r => r.value),
        this.cache.swr('metaAccess:' + key, () => this.s.metadata.readMetaAccess(conn, item).then(m => [...m]), null,
          { force: options && options.force, maxAgeMs: 10 * 60 * 1000, notBefore: dirty ? dirty.value : 0 }).then(r => new Map(r.value))]);
      const items = list.items.map(x => Object.assign({}, x, { enabled: !!(enabled.get(category + ':' + x.name) || {}).enabled }));
      // Something the item enables that the org list doesn't show (not visible to this user, say) is still listed.
      for (const [k, v] of enabled) if (k.startsWith(category + ':') && v.enabled && !items.some(x => category + ':' + x.name === k)) items.push({ name: k.slice(category.length + 1), label: k.slice(category.length + 1), enabled: true, description: '' });
      return { category, items, unavailable: list.items.length ? null : list.unavailable || null, metadata: true };
    }, (data, savedAt, refreshing) => ({ type: 'accessDetail', key, category, data, savedAt, refreshing }),
    () => this._selected === key, { type: 'accessError', key, category }, options);
  }

  // ---------- muting in permission set groups ----------

  /** What the group's member permission sets grant (before muting) and what is muted now. */
  async openMuting(key, options) {
    const item = this.items.get(key);
    if (!item || item.kind !== 'group') return;
    const dirty = this.cache.get('saved:' + key);
    await this._swr('muting:' + key, async () => {
      const conn = await this._conn();
      const comps = await conn.query('SELECT PermissionSetId FROM PermissionSetGroupComponent WHERE PermissionSetGroupId = ' + soqlStr(item.recordId));
      const ids = comps.records.map(r => r.PermissionSetId).filter(id => !/^0QM/.test(id));
      const [objs, sys, muted] = await Promise.all([
        ids.length ? conn.query('SELECT SobjectType, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords FROM ObjectPermissions WHERE ParentId IN (' + ids.map(soqlStr).join(', ') + ')') : { records: [] },
        this.s.insightSystem(conn, ids),
        this.s.metadata.readMuting(conn, item)]);
      const objects = new Map();
      const F = [['read', 'PermissionsRead'], ['create', 'PermissionsCreate'], ['edit', 'PermissionsEdit'], ['delete', 'PermissionsDelete'], ['viewAll', 'PermissionsViewAllRecords'], ['modifyAll', 'PermissionsModifyAllRecords']];
      for (const r of objs.records) { const o = objects.get(r.SobjectType) || {}; for (const [f, c] of F) if (r[c]) o[f] = true; objects.set(r.SobjectType, o); }
      const labels = new Map((await this.s.loader.systemPermissionFields(conn)).map(f => [f.name, f.label]));
      const system = new Set(); for (const set of sys.values()) for (const n of set) system.add(n);
      return { muting: muted.muting, members: ids.length, objects: [...objects].map(([name, props]) => ({ name, props })).sort((a, b) => a.name.localeCompare(b.name)),
        system: [...system].map(n => ({ name: n, label: labels.get(n) || n })).sort((a, b) => a.label.localeCompare(b.label)), muted: [...muted.entries] };
    }, (data, savedAt, refreshing) => ({ type: 'mutingDetail', key, data, savedAt, refreshing }), () => this._selected === key, { type: 'mutingError', key },
    Object.assign({ notBefore: dirty ? dirty.value : 0 }, options));
  }

  /** Fields of one object the group's members grant, for muting field access. */
  async mutingFields(m) {
    const item = this.items.get(m.key);
    if (!item) return;
    try {
      const conn = await this._conn();
      const comps = await conn.query('SELECT PermissionSetId FROM PermissionSetGroupComponent WHERE PermissionSetGroupId = ' + soqlStr(item.recordId));
      const ids = comps.records.map(r => r.PermissionSetId).filter(id => !/^0QM/.test(id));
      const rows = ids.length ? (await conn.query('SELECT Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE SobjectType = ' + soqlStr(m.object) + ' AND ParentId IN (' + ids.map(soqlStr).join(', ') + ')')).records : [];
      const fields = new Map();
      for (const r of rows) { const f = fields.get(r.Field) || { field: r.Field, read: false, edit: false }; f.read = f.read || r.PermissionsRead; f.edit = f.edit || r.PermissionsEdit; fields.set(r.Field, f); }
      this.post({ type: 'mutingFields', key: m.key, object: m.object, fields: [...fields.values()].sort((a, b) => a.field.localeCompare(b.field)) });
    } catch (e) { this.post({ type: 'mutingFields', key: m.key, object: m.object, fields: [], error: String(e.message || e) }); }
  }

  /** A group without a muting permission set gets one, so its permissions can be muted. */
  async createMuting(m) {
    const item = this.items.get(m.key);
    try {
      if (!item || item.kind !== 'group' || item.managed) throw new Error('Only your own permission set groups can have muting.');
      const bad = nameProblem(m.label, m.name);
      if (bad) throw new Error(bad);
      const conn = await this._conn();
      if (conn.isProduction && !this._confirmed(m.confirm)) throw new Error('Type the org’s alias or username to confirm changing production.');
      if (await this.s.metadata.mutingFor(conn, item)) throw new Error(item.label + ' already has a muting permission set.');
      await this.s.metadata.createMuting(conn, m.name, m.label);
      const r = await conn.query('SELECT Id FROM MutingPermissionSet WHERE DeveloperName = ' + soqlStr(m.name));
      if (!r.records[0]) throw new Error('The muting permission set was created but can’t be found. Refresh and try again.');
      await conn.createRecords([{ attributes: { type: 'PermissionSetGroupComponent' }, PermissionSetGroupId: item.recordId, PermissionSetId: r.records[0].Id }]);
      this.cache.set('saved:' + m.key, Date.now());
      this.post({ type: 'mutingCreated', key: m.key });
      await this.openMuting(m.key, { force: true });
      this.pollGroup(m.key).catch(() => {});
    } catch (e) { this.post({ type: 'mutingCreated', key: m.key, error: String(e.message || e) }); }
  }

  // ---------- profile settings ----------

  async openProfileSettings(key, options) {
    const item = this.items.get(key);
    if (!item || item.kind !== 'profile') return;
    const dirty = this.cache.get('saved:' + key);
    await this._swr('profileSettings:' + key, async () => {
      const conn = await this._conn();
      const [settings, apps, flows, groups] = await Promise.all([
        this.s.metadata.readProfileSettings(conn, item),
        this.cache.swr('entities:app', () => this.s.loader.listEntities(conn, 'app'), null, { maxAgeMs: 10 * 60 * 1000 }).then(r => r.value).catch(() => []),
        conn.query("SELECT ApiName, Label FROM FlowDefinitionView WHERE ProcessType = 'Flow' AND IsActive = true ORDER BY Label").then(r => r.records.map(f => ({ name: f.ApiName, label: f.Label || f.ApiName }))).catch(() => []),
        this.s.metadata.listMembers(conn, 'DataCategoryGroup').catch(() => [])]);
      return Object.assign(settings, { appList: apps.map(a => ({ name: a.name, label: a.label })), flowList: flows, groupList: groups });
    }, (data, savedAt, refreshing) => ({ type: 'profileSettings', key, data, savedAt, refreshing }), () => this._selected === key, { type: 'profileSettingsError', key },
    Object.assign({ notBefore: dirty ? dirty.value : 0 }, options));
  }

  // ---------- user access policies ----------

  /** The user access policies that grant or remove this permission set or group. */
  async postPolicies(key, options) {
    const item = this.items.get(key);
    if (!item || (item.kind !== 'permissionSet' && item.kind !== 'group')) return;
    try {
      const conn = await this._conn();
      const all = (await this.cache.swr('accessPolicies', () => this.s.metadata.accessPolicies(conn), null, { force: options && options.force, maxAgeMs: 30 * 60 * 1000 })).value;
      const type = item.kind === 'group' ? 'PermissionSetGroup' : 'PermissionSet';
      const list = all.map(p => Object.assign({}, p, { actions: p.actions.filter(a => a.type === type && a.target === item.apiName) })).filter(p => p.actions.length)
        .map(p => ({ name: p.name, label: p.label, status: p.status, triggerType: p.triggerType, grants: p.actions.some(a => /grant/i.test(a.action)), removes: p.actions.some(a => /revoke|remove/i.test(a.action)) }));
      this.post({ type: 'policies', key, list });
    } catch (e) { this.post({ type: 'policies', key, list: [], error: String(e.message || e).split('\n')[0] }); }
  }

  // ---------- user access and compare ----------

  async userAccess(m) {
    try { this.post({ type: 'userAccess', userId: m.userId, data: await this.s.insight.userAccess(await this._conn(), m.userId) }); }
    catch (e) { this.post({ type: 'userAccess', userId: m.userId, error: String(e.message || e) }); }
  }
  async userFields(m) {
    try { this.post({ type: 'userFields', userId: m.userId, object: m.object, fields: await this.s.insight.userFieldAccess(await this._conn(), m.ids || [], m.object) }); }
    catch (e) { this.post({ type: 'userFields', userId: m.userId, object: m.object, fields: [], error: String(e.message || e) }); }
  }

  /** Orgs the Salesforce CLI is signed in to, for comparing across orgs. */
  async listOrgs() {
    const orgs = await (this.s.listOrgs ? this.s.listOrgs().catch(() => []) : []);
    this.post({ type: 'orgs', orgs: orgs.filter(o => o.username !== (this.ctx && this.ctx.org.username)) });
  }
  async _otherConn(username) {
    this._others = this._others || new Map();
    if (!this._others.has(username)) this._others.set(username, this.s.openConnection({ username, alias: username }, this.ctx.projectDir, null).catch(e => { this._others.delete(username); throw e; }));
    return this._others.get(username);
  }

  /**
   * Compares two items' access: { a: key, b: key } in this org, or { a: key,
   * other: { org, kind, apiName } } for the same kind of item in another org.
   */
  async compare(m) {
    try {
      const conn = await this._conn();
      const a = this.items.get(m.a);
      if (!a) throw new Error('Pick the first item again.');
      await this._resolve(a, conn);
      let b, connB, labelB;
      if (m.other) {
        connB = await this._otherConn(m.other.org);
        const lists = await this.s.catalog.listAll(connB, [m.other.kind]);
        b = (lists[m.other.kind] || []).find(x => x.apiName === m.other.apiName);
        if (!b) throw new Error('No ' + { permissionSet: 'permission set', profile: 'profile', group: 'permission set group' }[m.other.kind] + ' named ' + m.other.apiName + ' in ' + m.other.org + '.');
        if (b.kind === 'group' && !b.permissionSetId) b.permissionSetId = await this.s.catalog.resolveGroupPermissionSet(connB, b.recordId);
        labelB = b.label + ' (' + m.other.org + ')';
      } else {
        b = this.items.get(m.b);
        if (!b) throw new Error('Pick the second item again.');
        connB = conn;
        await this._resolve(b, conn);
        labelB = b.label;
      }
      const namesA = this.s.insight.entityNames(conn);
      const namesB = connB === conn ? namesA : this.s.insight.entityNames(connB);
      const [snapA, snapB] = await Promise.all([this.s.insight.accessSnapshot(conn, a.permissionSetId, namesA), this.s.insight.accessSnapshot(connB, b.permissionSetId, namesB)]);
      const rows = this.s.insight.compareSnapshots(snapA, snapB);
      const labelA = a.label + (m.other ? ' (' + (this.ctx.org.alias || this.ctx.org.username) + ')' : '');
      this.post({ type: 'compareResult', labelA, labelB, rows, sizes: [snapA.size, snapB.size], markdown: this.s.insight.compareMarkdown(labelA, labelB, rows) });
    } catch (e) { this.post({ type: 'compareResult', error: String(e.message || e) }); }
  }

  // ---------- a full refresh each time the page opens ----------

  /** Lists, the open item and its sections, read again (unsaved changes are kept). */
  async fullRefresh(reason) {
    if (!this.ctx || this._saving) return;
    this._lastFull = Date.now();
    this.s.log('Full refresh (' + reason + ')');
    this.cache.delete('accessPolicies');
    await this.load({ force: true }).catch(e => this.s.log('Full refresh failed: ' + e.message));
    this.post({ type: 'fullRefresh' });
  }

  /** Record type assignments for one object. Needs a Metadata API retrieve, so it is slow and cached. */
  async openRecordTypes(key, object, options) {
    const item = this.items.get(key);
    if (!item) return;
    const dirty = this.cache.get('saved:' + key);
    await this._swr('rt:' + key + ':' + object, async () => {
      const conn = await this._conn();
      const types = await this.s.loader.listRecordTypes(conn, object);
      if (!types.length || item.kind === 'group') return { object, profile: item.kind === 'profile', items: types.map(t => Object.assign(t, { visible: false, default: false })), unavailable: item.kind === 'group' };
      const vis = await this.s.metadata.readRecordTypes(conn, item, types.map(t => t.name));
      return { object, profile: item.kind === 'profile', items: types.map(t => Object.assign(t, vis.get(t.name) || { visible: false, default: false })) };
    }, (data, savedAt, refreshing) => ({ type: 'recordTypes', key, object, data, savedAt, refreshing }),
    () => this._selected === key && this._object === object, { type: 'rtError', key, object },
    Object.assign({ notBefore: dirty ? dirty.value : 0 }, options));
  }

  async restore(m) {
    const item = this.items.get(m.key);
    try {
      const conn = await this._conn();
      const snap = await this.s.history.loadSnapshot(this.ctx.projectDir, m.snapshotId);
      if (!snap.safety) throw new Error('That snapshot has no full copy to restore from.');
      const n = await this.s.metadata.restoreSafety(conn, snap.permissionSetId, snap.safety);
      await this.s.history.appendLog(this.ctx.projectDir, { org: this.ctx.org.username, target: snap.target, path: 'restore', result: 'restored', count: n, snapshot: m.snapshotId }).catch(() => {});
      this.post({ type: 'toast', variant: 'success', title: 'Restored', message: n ? n + ' permission' + (n === 1 ? '' : 's') + ' put back from the copy taken before the deploy.' : 'Nothing was missing.' });
    } catch (e) {
      this.s.log('Restore failed: ' + (e.stack || e));
      this.post({ type: 'toast', variant: 'error', title: 'Restore failed', message: String(e.message || e), sticky: true });
    }
    if (item) { this.cache.set('saved:' + m.key, Date.now()); await this.select(m.key, { force: true }); }
  }

  async openObject(key, object, options) {
    const item = this.items.get(key);
    if (!item) return;
    this._selected = key;
    this._object = object;
    const dirty = this.cache.get('saved:' + key);
    await this._swr('object:' + key + ':' + object, async () => {
      const conn = await this._conn();
      await this._resolve(item, conn);
      return this.s.loader.loadObjectDetail(conn, item, object);
    }, (data, savedAt, refreshing) => ({ type: 'objectDetail', key, object, data, savedAt, refreshing }),
    () => this._selected === key && this._object === object, { type: 'objectError', key, object },
    Object.assign({ notBefore: dirty ? dirty.value : 0 }, options));
  }

  async sendCatalog() {
    try {
      const conn = await this._conn();
      const r = await this.cache.swr('catalog', () => this.s.loader.objectCatalog(conn),
        value => this.post({ type: 'objectCatalog', objects: value }));
      this.post({ type: 'objectCatalog', objects: r.value });
    } catch (e) {
      this.s.log('Object list failed: ' + (e.stack || e));
      this.post({ type: 'objectCatalog', objects: null, message: String(e.message || e) });
    }
  }

  /**
   * Shows the cached copy (if any) and fetches a fresh one in the background.
   * `message(data, savedAt, refreshing)` builds what the webview gets;
   * `stillWanted()` stops a late answer replacing what the person moved on to.
   */
  async _swr(cacheKey, fetch, message, stillWanted, errorMessage, options) {
    const o = options || {};
    let cached = o.force ? null : this.cache.get(cacheKey);
    if (cached && o.notBefore && cached.savedAt < o.notBefore) cached = null;
    if (cached) this.post(message(cached.value, cached.savedAt, true));
    else this.post(Object.assign({}, errorMessage, { type: errorMessage.type.replace('Error', 'Loading') }));
    try {
      const value = await fetch();
      this.cache.set(cacheKey, value);
      if (stillWanted()) this.post(message(value, Date.now(), false));
    } catch (e) {
      this.s.log('Loading ' + cacheKey + ' failed: ' + (e.stack || e));
      if (!stillWanted()) return;
      if (cached) {
        this.post(message(cached.value, cached.savedAt, false));
        this.post({ type: 'toast', variant: 'warning', title: 'Showing saved data', message: 'Could not refresh: ' + (e.message || e) });
      } else this.post(Object.assign({}, errorMessage, { message: String(e.message || e) }));
    }
  }

  // ---------- save ----------

  async save(m) {
    const item = this.items.get(m.key);
    const reply = r => this.post(Object.assign({ type: 'saveResult', key: m.key }, r));
    if (!item) return reply({ status: 'error', message: 'That item is no longer in the list. Refresh and try again.' });
    // One save at a time: a double click, or Ctrl+S during a save, mustn't write (and snapshot) twice.
    if (this._saving) return reply({ status: 'busy', message: 'A save is already running. Wait for it to finish.' });
    if (!Array.isArray(m.changes)) return reply({ status: 'error', message: 'These changes are not valid: expected a list of changes.' });
    this._saving = true;
    try { return await this._save(m, item, reply); } finally { this._saving = false; }
  }

  async _save(m, item, reply) {
    for (const c of m.changes) { const why = c && typeof c.key === 'string' ? editBlocker(item, c.key.split(':')[0]) : null; if (why) return reply({ status: 'error', message: why }); }
    let conn;
    try { conn = await this._conn(); } catch (e) { return reply({ status: 'error', message: String(e.message || e) }); }
    if (conn.isProduction && !this._confirmed(m.confirm)) return reply({ status: 'error', message: 'Type the org’s alias or username to confirm saving to production.' });
    const changes = m.changes.map(c => ({ key: String((c && c.key) || ''), ref: (c && c.ref) || null, before: (c && c.before) || null, after: c ? c.after : undefined, label: (c && c.label) || undefined }));
    const started = Date.now();
    const ticket = String(m.ticket || '').replace(/\s+/g, ' ').trim().slice(0, 80) || undefined;
    const usesDeploy = changes.some(c => c.key.startsWith('recordType:'));
    const logBase = { org: this.ctx.org.username, target: item.apiName, kind: item.kind, path: usesDeploy ? 'records + deploy' : 'records', count: changes.length };
    try {
      await this._resolve(item, conn);
      const result = await this.s.applyChanges(conn, item, changes, {
        force: !!m.force,
        metadata: this.s.metadata,
        assignLicenses: !!m.assignLicenses,
        onSnapshot: (snapshot, safety) => this.s.history.saveSnapshot(this.ctx.projectDir, { org: this.ctx.org.username, target: item.apiName, permissionSetId: item.permissionSetId, items: snapshot, safety: safety || undefined }),
        onProgress: (label, done, total) => this.post({ type: 'saveProgress', key: m.key, label, done, total }),
        log: l => this.s.log(l), pollMs: this.s.pollMs
      });
      if (result.status === 'conflict') return reply({ status: 'conflict', conflicts: result.conflicts });
      await this.s.history.appendLog(this.ctx.projectDir, Object.assign(logBase, {
        result: result.mismatches.length ? 'saved with differences' : 'saved', snapshot: result.snapshotId,
        changes: changes.map(c => ({ key: c.key, label: c.label, from: c.before, to: c.after })), ms: Date.now() - started, ticket
      })).catch(e => this.s.log('Change log write failed: ' + e.message));
      this.s.log('Saved ' + changes.length + ' change(s) to ' + item.apiName + ' in ' + (Date.now() - started) + ' ms (snapshot ' + result.snapshotId + ')');
      // Undo = put every entry back to the value read just before the save.
      const undo = result.snapshot.map(s => ({ key: s.key, ref: s.ref, after: s.before }));
      let local = null;
      if (m.writeLocal && item.localFile && this.s.localFile) {
        try {
          // Assignments never live in the file; connected app access has no XML form, so it is reported.
          const fileChanges = changes.filter(c => !c.key.startsWith('assignment:'));
          if (fileChanges.length) {
            const r = await this.s.localFile.updateLocalFile(item.localFile, item.kind, fileChanges);
            local = { path: require('path').relative(this.ctx.projectDir, item.localFile), applied: r.applied.length, skipped: r.skipped.length };
          }
        } catch (e) { local = { error: String(e.message || e) }; }
      }
      reply({ status: 'saved', count: result.count, mismatches: result.mismatches, snapshotId: result.snapshotId, undo, local });
    } catch (e) {
      this.s.log('Save to ' + item.apiName + ' failed' + (e.failedStep ? ' at "' + e.failedStep + '"' : '') + ': ' + (e.stack || e));
      await this.s.history.appendLog(this.ctx.projectDir, Object.assign(logBase, {
        result: 'failed', error: String(e.message || e), failedStep: e.failedStep || null, completedSteps: e.completedSteps || [], snapshot: e.snapshotId || null
      })).catch(() => {});
      reply({ status: 'error', message: await this._explain(conn, item, e), partial: !!(e.completedSteps && e.completedSteps.length), snapshotId: e.snapshotId || null, restorable: !!e.restorable });
    } finally {
      // Every way out, the early conflict return included, lets background refresh run again.
      this._saving = false;
    }
    // Whatever happened, show what the org holds now.
    // Cached object pages of this item from before the save are no longer trusted.
    this.cache.set('saved:' + m.key, Date.now());
    await this.select(m.key, { force: true, noPrefetch: true });
    if (m.object) {
      await this.openObject(m.key, m.object, { force: true });
      if (usesDeploy) await this.openRecordTypes(m.key, m.object, { force: true });
    }
    const cats = new Set(changes.map(c => c.key.split(':')[0]));
    for (const cat of [...cats].filter(c => this.s.loader.ENTITY[c])) await this.openAccess(m.key, cat, { force: true });
    if (cats.has('tab')) await this.openTabs(m.key, { force: true });
    if (cats.has('assignment')) await this.openAssignments(m.key, { force: true });
    if (cats.has('layoutAssignment') && m.object) await this.openLayouts(m.key, m.object, { force: true });
    if (cats.has('loginHours') || cats.has('loginIpRanges')) await this.openLogin(m.key, { force: true });
    if (cats.has('groupComponent')) { await this.openComponents(m.key, { force: true }); this.pollGroup(m.key).catch(() => {}); }
    for (const cat of [...cats].filter(c => META_ACCESS.includes(c))) { this.cache.delete('metaAccess:' + m.key); await this.openAccess(m.key, cat, { force: true }); }
    if (cats.has('mute')) { await this.openMuting(m.key, { force: true }); this.pollGroup(m.key).catch(() => {}); }
    if (['defaultApp', 'loginFlow', 'dataCategory', 'passwordPolicy', 'sessionSetting'].some(c => cats.has(c))) await this.openProfileSettings(m.key, { force: true });
  }
}

// Standard profiles' metadata file names, mapped to the names shown in Setup.
const STANDARD_PROFILES = { Admin: 'System Administrator', Standard: 'Standard User', ReadOnly: 'Read Only', SolutionManager: 'Solution Manager',
  MarketingProfile: 'Marketing User', ContractManager: 'Contract Manager', StandardAul: 'Standard Platform User', 'Minimum Access - Salesforce': 'Minimum Access - Salesforce' };

// Favourites prefetched per load, and how recent a cached copy must be to skip prefetching it.
const PREFETCH_LIMIT = 15;
const PREFETCH_FRESH_MS = 10 * 60 * 1000;

function itemKey(i) { return i.kind + ':' + i.recordId; }

/** Salesforce's rules for a new permission set's label and API name, checked before anything is written. */
function nameProblem(label, name, description) {
  const l = String(label || '').trim();
  const n = String(name || '');
  if (!l) return 'The label can’t be empty.';
  if (l.length > 80) return 'The label can be at most 80 characters.';
  if (!n) return 'The API name can’t be empty.';
  if (n.length > 80) return 'The API name can be at most 80 characters.';
  if (!/^[A-Za-z]/.test(n)) return 'The API name must start with a letter.';
  if (!/^[A-Za-z0-9_]+$/.test(n)) return 'The API name can only contain letters, numbers and underscores.';
  if (/__/.test(n)) return 'The API name can’t contain two underscores in a row.';
  if (/_$/.test(n)) return 'The API name can’t end with an underscore.';
  if (description && String(description).length > 255) return 'The description can be at most 255 characters (it has ' + String(description).length + ').';
  return null;
}

function listRow(key, i) {
  return { key, kind: i.kind, label: i.label, apiName: i.apiName, managed: !!i.managed, standard: !!i.standard,
    status: i.status || '', license: i.license || '', sessionBased: !!i.sessionBased };
}

function contextMessage(ctx, conn, extra) {
  const e = extra || {};
  const org = ctx && ctx.org;
  return {
    type: 'context',
    status: e.loading ? 'loading' : ctx.status,
    message: e.loading || ctx.message || '',
    projectDir: (ctx && ctx.projectDir) || '',
    org: org ? { alias: org.alias, username: org.username, location: org.location || '' } : null,
    production: conn ? conn.isProduction === true : e.production === true,
    sandbox: conn ? conn.isSandbox === true : e.sandbox === true,
    mode: conn ? conn.mode : null,
    connecting: !!e.connecting,
    offline: !!e.offline,
    kinds: ctx && ctx.kinds ? ctx.kinds : undefined
  };
}

/** Shapes a loaded detail for the webview. */
function toView(item, conn, detail) {
  const objects = [];
  const system = [];
  for (const [k, props] of detail.model.entries) {
    const { cat, name } = splitKey(k);
    const label = detail.labels.get(k) || name;
    if (cat === 'object') objects.push({ name, label, props });
    if (cat === 'user') system.push({ name, label, enabled: props.enabled });
  }
  objects.sort((a, b) => a.label.localeCompare(b.label));
  system.sort((a, b) => a.label.localeCompare(b.label));
  const blocked = editBlocker(item);
  return {
    header: {
      label: item.label, apiName: item.apiName, kind: KIND_LABEL[item.kind] || item.kind, kindId: item.kind,
      license: item.license || '', status: item.status || '', activeAssignees: detail.activeAssignees,
      managed: !!item.managed, standard: !!item.standard, description: item.description || '',
      modified: item.modified || null, editable: editableCategories(item).length > 0, readOnlyReason: blocked || '',
      editableCats: editableCategories(item), canRename: item.kind === 'permissionSet' && !item.managed, canClone: item.kind === 'permissionSet',
      canCopyToPs: item.kind === 'profile', sessionBased: !!item.sessionBased
    },
    objects, system,
    // Objects where this item grants field access but no object access (Event and Task always work this way).
    fieldObjects: (detail.fieldObjects || []).filter(f => !objects.some(o => o.name === f.name)),
    objectColumns: detail.objectColumns || ['read', 'create', 'edit', 'delete', 'viewAll', 'modifyAll']
  };
}

function html(webview, media, shared) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'app.css'));
  const deps = webview.asWebviewUri(vscode.Uri.joinPath(shared, 'dependencies.js'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'app.js'));
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>Permission Studio</title>
</head><body>
<div id="app"></div>
<script nonce="${nonce}" src="${deps}"></script>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
}

module.exports = { MainPanel, toView };
