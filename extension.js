'use strict';

const vscode = require('vscode');
const os = require('os');
const path = require('path');
const project = require('./src/org/project');
const connection = require('./src/org/connection');
const { detectProduction } = require('./src/org/orgs');
const catalog = require('./src/data/catalog');
const loader = require('./src/data/loader');
const { MainPanel } = require('./src/views/mainPanel');
const { Cache, disabled } = require('./src/data/cache');
const { apply } = require('./src/changes/apply');
const history = require('./src/changes/history');
const metadata = require('./src/org/metadata');
const localFile = require('./src/xml/localFile');
const { gate } = require('./src/org/connection');
const sfcore = require('./src/org/sfcore');
const summary = require('./src/changes/summary');

function settings() {
  const c = vscode.workspace.getConfiguration('permStudio');
  return {
    sfPath: c.get('sf.path', 'sf') || 'sf',
    sfInstallPath: String(c.get('sf.installPath', '') || '').trim(),
    apiVersion: String(c.get('apiVersion', '') || '').trim(),
    projectPath: String(c.get('project.path', '') || '').trim(),
    connectionMode: c.get('connection.mode', 'auto') || 'auto',
    cacheEnabled: c.get('cache.enabled', true) !== false,
    localFileMode: c.get('localFile.update', 'ask') || 'ask',
    kinds: listKinds(c.get('lists.show', ['permissionSet', 'profile'])),
    autoRefresh: c.get('autoRefresh.enabled', true) !== false,
    autoRefreshMinutes: Math.min(30, Math.max(1, Math.round(Number(c.get('autoRefresh.minutes', 5)) || 5)))
  };
}

/** Which lists to show, in display order; never empty. */
function listKinds(v) {
  const order = ['permissionSet', 'group', 'profile'];
  const chosen = order.filter(k => Array.isArray(v) && v.includes(k));
  return chosen.length ? chosen : ['permissionSet', 'profile'];
}

/**
 * Favourites live in settings, so they can be shared through workspace
 * settings or kept per user. Items are "permissionSet:<API name>",
 * "group:<API name>" or "profile:<profile name>"; objects are API names.
 */
function favorites() {
  const c = vscode.workspace.getConfiguration('permStudio');
  const clean = v => (Array.isArray(v) ? v : []).map(String).filter(Boolean);
  return { items: clean(c.get('favorites.items', [])), objects: clean(c.get('favorites.objects', [])) };
}

async function toggleFavorite(kind, id) {
  const setting = kind === 'object' ? 'favorites.objects' : 'favorites.items';
  const c = vscode.workspace.getConfiguration('permStudio');
  const current = favorites()[kind === 'object' ? 'objects' : 'items'];
  const next = current.includes(id) ? current.filter(x => x !== id) : current.concat([id]);
  // Keep the change where the list already lives: workspace settings if they define it, otherwise user settings.
  const where = c.inspect(setting) && c.inspect(setting).workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await c.update(setting, next, where);
}

function activate(context) {
  const out = vscode.window.createOutputChannel('Permission Studio');
  const log = line => out.appendLine('[' + new Date().toISOString().slice(11, 19) + '] ' + line);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'permStudio.open';
  status.text = '$(shield) Permissions';
  status.tooltip = 'Open Permission Studio for this project’s default org';
  status.show();

  let watchers = [];
  let watchedProject;
  let debounce = null;

  async function resolveContext() {
    const s = settings();
    const editor = vscode.window.activeTextEditor;
    const projectDir = await project.findProject({
      override: s.projectPath,
      folders: (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath),
      activeFile: editor && editor.document && editor.document.uri ? editor.document.uri.fsPath : '',
      findFiles: async () => (await vscode.workspace.findFiles('**/sfdx-project.json', '**/node_modules/**', 5)).map(u => u.fsPath)
    });
    if (projectDir !== watchedProject) watch(projectDir);
    if (!projectDir) { setStatus(null); return { projectDir: null, org: null }; }
    const org = await project.resolveDefaultOrg(s.sfPath, projectDir);
    log('Project ' + projectDir + ': default org ' + (org ? (org.alias || org.username) + ' (' + org.username + ', ' + (org.location || 'unknown') + ' config)' : 'not set'));
    setStatus(org);
    return { projectDir, org };
  }

  function setStatus(org) {
    status.text = '$(shield) ' + (org ? (org.alias || org.username) : 'Permissions');
    status.tooltip = org ? 'Permission Studio: ' + org.username + '\nClick to open' : 'Permission Studio: no default org for this project';
  }

  // One cache folder per org username, in the extension's own storage (never in the project).
  const caches = new Map();
  function cacheFor(username) {
    if (!settings().cacheEnabled) return disabled();
    if (!caches.has(username)) {
      const base = (context.globalStorageUri && context.globalStorageUri.fsPath) || path.join(os.tmpdir(), 'permission-studio');
      caches.set(username, new Cache(path.join(base, 'cache', username.replace(/[^\w.@-]+/g, '_'))));
    }
    return caches.get(username);
  }

  async function openConnection(org, projectDir, cache) {
    const s = settings();
    const t0 = Date.now();
    log('Connecting to ' + org.username + ' (connection mode: ' + s.connectionMode + ')');
    const conn = await connection.open(org, {
      sfPath: s.sfPath, cwd: projectDir, apiVersion: s.apiVersion || undefined, persist: cache,
      openLibrary: async username => {
        const lib = await sfcore.load(s.sfPath, projectDir, context.globalState, log, { installPath: s.sfInstallPath || undefined });
        return sfcore.connect(lib.core, username, s.apiVersion || undefined);
      },
      mode: s.connectionMode === 'auto' ? undefined : s.connectionMode, log,
      onModeChange: mode => log('Connection mode is now ' + mode)
    });
    log('Connected in ' + (Date.now() - t0) + ' ms (' + { library: 'through the Salesforce CLI library', rest: 'direct REST', cli: 'sf processes' }[conn.mode] + ')');
    return conn;
  }

  const panel = new MainPanel(context, {
    resolveContext, openConnection, cacheFor, catalog, loader, detectProduction, history, metadata, favorites, toggleFavorite, log,
    localFile, localFileMode: () => settings().localFileMode, kinds: () => settings().kinds, gate,
    summary, clipboard: text => vscode.env.clipboard.writeText(text),
    applyChanges: apply, showLog: () => out.show(true)
  });

  // The default org lives in the project's .sf/config.json (or the older
  // .sfdx/sfdx-config.json), falling back to the global ~/.sf/config.json.
  function watch(projectDir) {
    watchers.forEach(w => w.dispose());
    watchers = [];
    watchedProject = projectDir;
    const changed = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => panel.defaultOrgMayHaveChanged().catch(e => log('Re-reading the default org failed: ' + e.message)), 600);
    };
    const files = [path.join(os.homedir(), '.sf', 'config.json')].concat(projectDir ? project.configFiles(projectDir) : []);
    const patterns = files.map(f => new vscode.RelativePattern(vscode.Uri.file(path.dirname(f)), path.basename(f)));
    for (const p of patterns) {
      const w = vscode.workspace.createFileSystemWatcher(p);
      w.onDidChange(changed); w.onDidCreate(changed); w.onDidDelete(changed);
      watchers.push(w);
    }
  }

  const cmd = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
    try { return await fn(...args); } catch (e) {
      log(id + ' failed: ' + (e.stack || e));
      vscode.window.showErrorMessage(String(e.message || e));
    }
  }));

  cmd('permStudio.open', () => { panel.show(); });
  cmd('permStudio.refresh', async () => { panel.show(); await panel.load({ force: true }); });
  cmd('permStudio.showLog', () => out.show(true));

  // Open an item by name from the Command Palette: favourites first, type to filter.
  cmd('permStudio.openItem', async () => {
    const items = await panel.quickPickItems();
    if (!items.length) return vscode.window.showInformationMessage('Nothing loaded yet: open a Salesforce project with a default org.');
    const pick = await vscode.window.showQuickPick(items.map(i => Object.assign({}, i, { label: (i.favorite ? '$(star-full) ' : '') + i.label })),
      { placeHolder: 'Open a permission set, group or profile', matchOnDescription: true, matchOnDetail: true });
    if (pick) await panel.openItem(pick.key);
  });
  // Open the item behind a permission set, profile or group file (Explorer, editor title, or the active editor).
  cmd('permStudio.openFile', async uri => {
    const target = uri && uri.fsPath ? uri : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
    if (!target) return vscode.window.showInformationMessage('Open or select a .permissionset-meta.xml, .profile-meta.xml or .permissionsetgroup-meta.xml file first.');
    await panel.openItem(await panel.itemForFile(target.fsPath));
  });
  cmd('permStudio.clearCache', async () => {
    for (const c of caches.values()) await c.clear();
    caches.clear();
    vscode.window.showInformationMessage('Permission Studio cache cleared.');
    if (panel.isOpen) await panel.load({ force: true });
  });

  context.subscriptions.push(out, status, { dispose: () => watchers.forEach(w => w.dispose()) },
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('permStudio.autoRefresh')) scheduleRefresh();
      if (e.affectsConfiguration('permStudio.lists.show') && !panel.isOpen) panel.load({ force: false }).catch(() => {});
      if (!panel.isOpen) return;
      const favs = e.affectsConfiguration('permStudio.favorites');
      if (e.affectsConfiguration('permStudio.sf.installPath')) { sfcore.reset(); if (context.globalState) context.globalState.update(sfcore.CACHE_KEY, undefined); }
      const other = ['sf.path', 'sf.installPath', 'project.path', 'apiVersion', 'connection.mode', 'cache.enabled', 'lists.show'].some(k => e.affectsConfiguration('permStudio.' + k));
      if (e.affectsConfiguration('permStudio.localFile.update') && panel.isOpen && panel._selected) panel._sendLocalFile(panel._selected).catch(() => {});
      if (other) panel.load({ force: true });
      else if (favs) panel.postFavorites();
    }));

  // Auto-refresh: every N minutes while the window has focus; a missed tick runs when focus comes back.
  let timer = null;
  let due = false;
  const tick = () => {
    if (!vscode.window.state.focused) { due = true; return; }
    due = false;
    panel.autoRefresh().catch(() => {});
  };
  function scheduleRefresh() {
    if (timer) clearInterval(timer);
    timer = null;
    const st = settings();
    if (st.autoRefresh) timer = setInterval(tick, st.autoRefreshMinutes * 60 * 1000);
  }
  scheduleRefresh();
  context.subscriptions.push({ dispose: () => timer && clearInterval(timer) },
    vscode.window.onDidChangeWindowState(w => { if (w.focused && due) tick(); }));

  // Start in the background as soon as a Salesforce project opens: find the default org,
  // connect, read the lists and prefetch favourites, so the screen opens instantly.
  setImmediate(() => panel.load().catch(e => log('Background start failed: ' + (e.message || e))));
  const pkg = context.extension && context.extension.packageJSON;
  log('Permission Studio ' + (pkg ? pkg.version : '') + ' activated');
}

function deactivate() {}

module.exports = { activate, deactivate };
