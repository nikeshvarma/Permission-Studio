// @ts-check
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const Deps = /** @type {any} */ (window).PermDeps;
  const saved = vscode.getState() || {};
  const ui = {
    kind: saved.kind || 'permissionSet', search: saved.search || '', selected: saved.selected || null,
    section: saved.section || saved.tab || 'objects', page: saved.page || 'detail', object: saved.object || null, tool: null,
    objFilter: '', allObjects: false, fieldFilter: '', fieldsGranted: false, sysFilter: '', sysEnabled: saved.sysEnabled === true
  };
  let ctx = { status: 'loading', message: 'Starting…' };
  let lists = null;
  let listsMeta = { savedAt: 0, refreshing: false };
  let detail = null;     // { key, data, savedAt, refreshing, state, message }
  let objectPage = null; // { key, object, data, savedAt, refreshing, state, message }
  let catalog = null;    // null = not asked, 'loading', or [{ name, label }]
  let pending = new Map(); // entry key -> { before, after, touched:Set, label, cat, ref? }
  let favs = { items: new Set(), objects: new Set() };
  let access = {};       // category -> { key, data, savedAt, refreshing, state, message }
  let rtPage = null;     // { key, object, data, savedAt, refreshing, state, message }
  let accessLimit = 300;
  let tabsPage = null;      // { key, data, ... } permission set tab settings
  let assignPage = null;    // { key, data, ... } assignments or a profile's users
  let loginPage = null;     // { key, data: { hours, ranges } } profile login settings
  let componentsPage = null; // { key, data: { status, components } } a group's member permission sets
  let historyPicked = new Set();
  let permDeps = { system: {}, custom: {} };
  let depsAsked = false;
  let auditPage = null;      // { key, data: { items, denied } } Setup Audit Trail entries
  let assigneeBlockers = {}; // userId -> why they can't be assigned
  let layoutPage = null;    // { key, object, data: { layouts, rows } } profile layout assignments
  let localFile = null;     // { key, path, mode }
  let userResults = null;   // { text, users }
  let lookup = { object: '', field: '', level: 'read', result: null, busy: false, fields: null, target: '',
    f: { through: 'any', profile: 'any', license: 'any', users: 'active', show: 'full', q: '' }, why: new Set(), sel: new Set(), revoke: null };
  let wizard = { object: '', fields: null, chosen: new Set(), level: 'read', targets: new Set(), grantObject: true, filter: '', targetFilter: '', customOnly: true, plan: null, busy: false, results: null, progress: null, confirm: '',
    types: 'all', hideHave: false, current: null, currentSig: '', templateName: null };
  let objWizard = { object: '', info: null, flags: new Set(['read']), rts: new Set(), defaultRt: '', targets: new Set(), targetFilter: '', plan: null, busy: false, results: null, progress: null, confirm: '',
    adds: new Map(), types: 'all', current: null, currentFor: '', rtRows: new Set() };
  let historyData = null;
  let lookupOptions = null;
  let historySetupData = null;      // Setup Audit Trail entries for History
  let hf = { q: '', days: '7', item: '', result: '', setup: false, open: new Set() };
  let recentLookups = [];
  let grantTemplates = [];
  let lastTicket = '';
  let restoreSaved = null;          // unsaved changes kept from an earlier session
  let applyTarget = 'wizard';       // which screen is waiting for a bulk save result
  let lastKeyShortcut = 0;
  let stageAfterLoad = null; // stageChanges waiting for its item to open
  let saving = null;     // { label, done, total }
  let modal = null;
  let lastFocus = null;

  const OBJECT_FLAGS = [['read', 'Read'], ['create', 'Create'], ['edit', 'Edit'], ['delete', 'Delete'],
    ['viewAll', 'View All Records'], ['modifyAll', 'Modify All Records'], ['viewAllFields', 'View All Fields']];
  const SHORT = { read: 'Read', create: 'Create', edit: 'Edit', delete: 'Delete', viewAll: 'View All', modifyAll: 'Modify All', viewAllFields: 'View All Fields', enabled: 'Enabled', visible: 'Assigned', default: 'Default',
    visibility: 'Visibility', assigned: 'Assigned', expires: 'Expires', layout: 'Layout', ranges: 'IP ranges' };
  // Setup-entity categories, each a list of checkboxes: [category, menu label, card title, column title].
  const ACCESS_TABS = [['app', 'Assigned Apps', 'Assigned Apps', 'App'], ['apexClass', 'Apex Class Access', 'Apex Class Access', 'Class'],
    ['apexPage', 'Visualforce Page Access', 'Visualforce Page Access', 'Page'], ['flow', 'Flow Access', 'Flow Access', 'Flow'],
    ['connectedApp', 'Connected App Access', 'Connected App Access', 'Connected App'], ['customPermission', 'Custom Permissions', 'Custom Permissions', 'Permission'],
    ['customMetadata', 'Custom Metadata Types', 'Custom Metadata Types', 'Type'], ['customSetting', 'Custom Settings', 'Custom Setting Definitions', 'Setting']];
  // The record page menu, grouped the way Setup groups a permission set's overview.
  const SECTIONS = [
    ['Group', [['components', 'Permission Sets', k => k === 'group']]],
    ['Apps', [['app'], ['objects', 'Object Settings'], ['apexClass'], ['apexPage'], ['flow'], ['connectedApp'], ['customPermission'], ['customMetadata'], ['customSetting'], ['tab', 'Tab Settings', k => k === 'permissionSet' || k === 'profile']]],
    ['System', [['system', 'System Permissions'], ['login', 'Login Hours & IP Ranges', k => k === 'profile']]],
    ['Users', [['assignment', 'Assignments', k => k !== 'profile'], ['users', 'Users', k => k === 'profile']]],
    ['Activity', [['audit', 'Changes in Setup']]]
  ];
  const CATEGORY_TITLES = [['groupComponent', 'Permission Sets in Group'], ['object', 'Object Permissions'], ['field', 'Field Permissions'], ['recordType', 'Record Type Assignments'], ['layoutAssignment', 'Page Layout Assignments'],
    ['user', 'System Permissions'], ['tab', 'Tab Settings'], ['loginHours', 'Login Hours'], ['loginIpRanges', 'Login IP Ranges'], ['assignment', 'Assignments'], ['audit', 'Changes in Setup']]
    .concat(ACCESS_TABS.map(t => [t[0], t[2]]));
  // One colour per object permission, used everywhere the permission appears.
  const TONE = { read: 'perm-read', create: 'perm-create', edit: 'perm-edit', delete: 'perm-delete', viewAll: 'perm-viewall', modifyAll: 'perm-modifyall', viewAllFields: 'perm-viewall' };
  // System permissions that reach far beyond one object; tagged so they stand out when reading.
  const HIGH_IMPACT = new Set(['ModifyAllData', 'ViewAllData', 'ManageUsers', 'ManageInternalUsers', 'CustomizeApplication', 'AuthorApex', 'ModifyMetadata',
    'ManageProfilesPermissionsets', 'AssignPermissionSets', 'ManageRoles', 'ManageSharing', 'ResetPasswords', 'ViewAllUsers', 'ManageEncryptionKeys',
    'ViewEncryptedData', 'BulkApiHardDelete', 'TransferAnyEntity', 'EditReadonlyFields', 'PasswordNeverExpires', 'ManageAuthProviders', 'ManageIpAddresses',
    'ManageLoginAccessPolicies', 'ManageSandboxes', 'ManageCustomPermissions', 'ManageDataIntegrations', 'InstallPackaging']);
  const NAV_ICONS = {
    app: ['M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'],
    objects: ['M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 2.3L18.6 8 12 11.7 5.4 8 12 4.3ZM5 9.7l6 3.4v6.6l-6-3.4V9.7Zm8 10v-6.6l6-3.4v6.6l-6 3.4Z'],
    apexClass: ['M8.6 16.6 4 12l4.6-4.6L7.2 6l-6 6 6 6 1.4-1.4Zm6.8 0L20 12l-4.6-4.6L16.8 6l6 6-6 6-1.4-1.4Z'],
    apexPage: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm4 18H6V4h7v5h5v11Z'],
    flow: ['M7 3a3 3 0 0 0-1 5.8v6.4A3 3 0 1 0 8 15.2V13h7a3 3 0 0 0 3-3V8.8a3 3 0 1 0-2 0V10a1 1 0 0 1-1 1H8V8.8A3 3 0 0 0 7 3Z'],
    connectedApp: ['M16 7V3h-2v4h-4V3H8v4H7a1 1 0 0 0-1 1v4a6 6 0 0 0 5 5.9V22h2v-4.1a6 6 0 0 0 5-5.9V8a1 1 0 0 0-1-1h-1Z'],
    customPermission: ['M7 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm5.6-4A6 6 0 1 0 12.6 14H16v3h3v-3h2v-4h-8.4Z'],
    customMetadata: ['M12 2 2 7l10 5 10-5-10-5ZM2 12l10 5 10-5-2.1-1L12 15l-7.9-4L2 12Zm0 5 10 5 10-5-2.1-1L12 20l-7.9-4L2 17Z'],
    customSetting: ['M3 17v2h6v-2H3ZM3 5v2h10V5H3Zm10 16v-2h8v-2h-8v-2h-2v6h2ZM7 9v2H3v2h4v2h2V9H7Zm14 4v-2H11v2h10Zm-6-4h2V7h4V5h-4V3h-2v6Z'],
    tab: ['M21 3H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Zm0 16H3V5h10v4h8v10Z'],
    system: ['M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1l-.4-2.6h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L4.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1l.4 2.6h4l.4-2.6c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5-2.1-1.6ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z'],
    login: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7Z'],
    assignment: ['M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13Zm8 0c-.3 0-.6 0-1 .1 1.2.8 2 1.9 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5Z']
  };
  NAV_ICONS.users = NAV_ICONS.assignment;
  NAV_ICONS.audit = ['M13 3a9 9 0 0 0-9 9H1l3.9 3.9.1.1L9 12H6a7 7 0 1 1 2.1 5l-1.4 1.4A9 9 0 1 0 13 3Zm-1 5v5l4.3 2.5.7-1.2-3.5-2.1V8H12Z'];
  // Salesforce: grant these connected-app permissions sparingly (since the September 2025 restrictions).
  const HIGH_IMPACT_LABELS = /^(use any api client|approve uninstalled connected apps)$/i;
  function isHighImpact(s) { return HIGH_IMPACT.has(s.name) || HIGH_IMPACT_LABELS.test(s.label || ''); }
  NAV_ICONS.components = ['M12 2 3 6.5 12 11l9-4.5L12 2ZM3 11.5 12 16l9-4.5v2.2L12 18.2l-9-4.5v-2.2ZM3 16.5 12 21l9-4.5v2.2L12 23.2l-9-4.5v-2.2Z'];
  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const HOURS = Array.from({ length: 25 }, (_, i) => [String(i * 60), i === 24 ? 'Midnight (end of day)' : String(((i + 11) % 12) + 1) + ':00 ' + (i < 12 ? 'AM' : 'PM')]);
  const ALL_KINDS = [['permissionSet', 'Permission Sets'], ['group', 'Groups'], ['profile', 'Profiles']];
  let KINDS = ALL_KINDS.filter(k => k[0] !== 'group');

  // ---------- helpers ----------
  function h(tag, attrs, kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'text') e.textContent = v;
      else if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'disabled' || k === 'indeterminate') e[k] = !!v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(kids || [])) if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return e;
  }
  function svg(paths, cls) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); if (cls) s.setAttribute('class', cls);
    for (const d of paths) { const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); s.appendChild(p); }
    return s;
  }
  /** Two overlapping squares: copy. */
  function copyIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const s2 = document.createElementNS(NS, 'svg');
    s2.setAttribute('viewBox', '0 0 16 16'); s2.setAttribute('aria-hidden', 'true'); s2.setAttribute('class', 'copy-icon');
    const r = document.createElementNS(NS, 'rect'); r.setAttribute('x', '5.5'); r.setAttribute('y', '5.5'); r.setAttribute('width', '8'); r.setAttribute('height', '8'); r.setAttribute('rx', '1.5');
    const pth = document.createElementNS(NS, 'path'); pth.setAttribute('d', 'M3 10.5v-7a1 1 0 0 1 1-1h7');
    for (const el of [r, pth]) { el.setAttribute('fill', 'none'); el.setAttribute('stroke', 'currentColor'); el.setAttribute('stroke-width', '1.4'); el.setAttribute('stroke-linecap', 'round'); s2.appendChild(el); }
    return s2;
  }
  /** How favourites name an item: "permissionSet:Sales_Ops". */
  function favId(r) { return r ? r.kind + ':' + r.apiName : ''; }
  const SRC_CLASS = { permissionSet: 'ps', profile: 'pr', group: 'gr' };
  const SRC_TYPE = { permissionSet: 'Permission set', profile: 'Profile', group: 'Group' };
  /** A grant source as a coloured chip: blue permission sets, green profiles, purple groups. Opens the item. */
  function srcChip(src) {
    if (!src) return null;
    const attrs = { class: 'src ' + SRC_CLASS[src.kind], title: SRC_TYPE[src.kind], text: src.label };
    if (src.key) { attrs.onclick = () => { ui.tool = null; renderTop(); guard(() => choose(src.key)); }; attrs.role = 'link'; attrs.tabindex = '0'; }
    return h('span', attrs);
  }
  const chip = (sign, text, title) => h('span', { class: 'rv-chip ' + (sign === '+' ? 'rv-add' : sign === '-' ? 'rv-del' : 'rv-mod'), title: title || null, text: (sign === '+' ? '+ ' : sign === '-' ? '− ' : '') + text });
  /** A filter chip holding a select: "Profile Custom: Sales ▾". */
  function filterChip(label, value, options, onPick, fallback) {
    return h('label', { class: 'flt' + (value !== fallback ? ' on' : '') }, [label + ' ', h('select', { 'aria-label': label, onchange: e => onPick(e.target.value) },
      options.map(([v, t]) => h('option', { value: v, selected: v === value, text: t })))]);
  }
  const ADD_LABEL = { enabled: 'Enabled', visible: 'Assigned', assigned: 'Assigned', included: 'Included', default: 'Default' };
  /** What changes in an entry, as + / − / ~ chips: [{ sign, text, auto }]. */
  function changeChips(before, after, touched) {
    const out = [];
    const b = before || {};
    const a = after || {};
    for (const f of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (!valueDiffers(b[f], a[f])) continue;
      const name = SHORT[f] || ADD_LABEL[f] || f.replace(/(Start|End)$/, ' $1').replace(/^./, c => c.toUpperCase());
      const auto = touched ? !touched.has(f) : false;
      if (typeof a[f] === 'boolean' || typeof b[f] === 'boolean') out.push({ sign: a[f] ? '+' : '-', text: name, auto });
      else out.push({ sign: '~', text: name + ': ' + shown(b[f], a[f]) + ' → ' + shown(a[f], b[f]), auto });
    }
    return out;
  }

  /** An outline magnifier: a thin ring and a round-ended handle stay crisp at 14 px, where a filled glyph blurs. */
  function searchIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'search-icon');
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', '6.75'); c.setAttribute('cy', '6.75'); c.setAttribute('r', '4.75');
    const l = document.createElementNS(NS, 'path');
    l.setAttribute('d', 'M10.3 10.3 14 14');
    for (const el of [c, l]) { el.setAttribute('fill', 'none'); el.setAttribute('stroke', 'currentColor'); el.setAttribute('stroke-width', '1.6'); el.setAttribute('stroke-linecap', 'round'); s.appendChild(el); }
    return s;
  }
  const ICONS = {
    permissionSet: ['M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Zm-1 14-4-4 1.4-1.4 2.6 2.6 5.6-5.6L18 9l-7 7Z'],
    group: ['M12 2 3 6.5 12 11l9-4.5L12 2Z', 'M3 11.5 12 16l9-4.5v2.2L12 18.2l-9-4.5v-2.2Z', 'M3 16.5 12 21l9-4.5v2.2L12 23.2l-9-4.5v-2.2Z'],
    profile: ['M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.4 0-9 2.2-9 5.5V22h18v-2.5c0-3.3-4.6-5.5-9-5.5Z'],
    chevron: ['M9 6l6 6-6 6'],
    refresh: ['M17.7 6.3A8 8 0 1 0 19.9 13h-2.1a6 6 0 1 1-1.5-5.3L13 11h7V4l-2.3 2.3Z'], info: ['M11 7h2v2h-2V7Zm0 4h2v6h-2v-6Zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z'],
    warning: ['M1 21h22L12 2 1 21Zm12-3h-2v-2h2v2Zm0-4h-2v-4h2v4Z'], close: ['M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4Z'],
    success: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-2 15-5-5 1.4-1.4 3.6 3.6 7.6-7.6L19 8l-9 9Z'],
    starOn: ['M12 17.3 18.2 21l-1.6-7 5.4-4.7-7.2-.6L12 2 9.2 8.7 2 9.3l5.4 4.7-1.6 7z'],
    starOff: ['M22 9.2l-7.2-.6L12 2 9.2 8.6 2 9.2l5.5 4.7L5.8 21 12 17.3 18.2 21l-1.6-7.1L22 9.2zM12 15.4l-3.8 2.3 1-4.3-3.3-2.9 4.4-.4L12 6.1l1.7 4 4.4.4-3.3 2.9 1 4.3-3.8-2.3z']
  };
  const save = () => vscode.setState({ kind: ui.kind, search: ui.search, selected: ui.selected, section: ui.section, page: ui.page, object: ui.object, sysEnabled: ui.sysEnabled });
  const send = m => vscode.postMessage(m);
  function ago(t) {
    if (!t) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 45) return 'just now';
    const m = Math.round(s / 60); if (m < 60) return m + ' min ago';
    const hr = Math.round(m / 60); if (hr < 24) return hr + ' h ago';
    return Math.round(hr / 24) + ' d ago';
  }
  function fmtDate(iso) { try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return iso; } }
  function spinner(small) { return h('span', { class: small ? 'spinner small' : 'spinner', role: 'status', 'aria-label': 'Loading' }, [h('span'), h('span'), h('span')]); }
  /** Does one value of an entry differ? Booleans default to false; text and lists compare by content. */
  function valueDiffers(a, b) {
    if (typeof a === 'boolean' || typeof b === 'boolean') return (a === true) !== (b === true);
    const n = v => (v === '' || v === undefined ? null : v);
    return JSON.stringify(n(a)) !== JSON.stringify(n(b));
  }
  function differs(a, b) {
    const x = a || {}; const y = b || {};
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (valueDiffers(x[k], y[k])) return true;
    return false;
  }
  function checkbox(opts) {
    // opts: { checked, onChange, disabled, label, hidden label, edited, implied, fid, title }
    const input = h('input', { type: 'checkbox', checked: opts.checked, disabled: opts.disabled, 'aria-label': opts.aria || opts.label || '', 'data-fid': opts.fid, title: opts.title,
      onchange: e => { lastFocus = opts.fid; opts.onChange(e.target.checked); } });
    if (opts.indeterminate) input.indeterminate = true;
    const cls = 'cb' + (opts.edited ? ' edited' : '') + (opts.tone ? ' perm ' + opts.tone : '');
    return h('label', { class: cls, title: opts.title }, [input, h('span', { class: 'box', 'aria-hidden': 'true' }), opts.label ? h('span', { class: 'cb-label', text: opts.label }) : null]);
  }
  function toggle(label, on, onChange) {
    return h('label', { class: 'toggle' }, [h('input', { type: 'checkbox', checked: on, onchange: e => onChange(e.target.checked) }), h('span', { class: 'track', 'aria-hidden': 'true' }), h('span', { text: label })]);
  }
  /** A search box. `fid` keeps focus and the caret across redraws; `later` delays the redraw while typing. */
  function searchBox(value, placeholder, onInput, fid, later) {
    return h('div', { class: 'search' }, [searchIcon(),
      h('input', { type: 'search', value, placeholder, 'aria-label': placeholder, 'data-fid': fid,
        oninput: e => { const v = e.target.value; if (later) debounce(() => onInput(v)); else onInput(v); } })]);
  }
  let debounceTimer = null;
  function debounce(fn) { clearTimeout(debounceTimer); debounceTimer = setTimeout(fn, 140); }
  function star(on, label, onClick) {
    return h('button', { class: 'star' + (on ? ' on' : ''), 'aria-pressed': String(on), 'aria-label': (on ? 'Remove ' : 'Add ') + label + (on ? ' from favorites' : ' to favorites'),
      title: on ? 'Remove from favorites' : 'Add to favorites', onclick: e => { e.stopPropagation(); onClick(); } }, svg(on ? ICONS.starOn : ICONS.starOff));
  }
  function alertBox(variant, text, kids) {
    return h('div', { class: 'alert ' + variant, role: variant === 'error' ? 'alert' : 'status' }, [svg(ICONS[variant === 'error' ? 'warning' : variant] || ICONS.info, 'alert-icon'), h('div', {}, [text ? h('span', { text }) : null].concat(kids || []))]);
  }

  // ---------- editing ----------
  const ready = () => detail && detail.data && ctx.status === 'ready' && !ctx.offline && !saving;
  const editable = () => ready() && detail.data.header.editable;
  /** Can this category be changed on the open item? */
  const can = cat => ready() && (detail.data.header.editableCats || []).includes(cat);
  function eff(k, base) { const p = pending.get(k); return p ? p.after : base; }
  function stage(k, base, after, flag, label, cat, quiet, ref, auto) {
    const prev = pending.get(k);
    const touched = new Set(prev ? prev.touched : []);
    // Entries the permission rules change are left untouched, so the review marks them "auto".
    if (!auto) touched.add(flag);
    const before = prev ? prev.before : base;
    if (!differs(before, after)) pending.delete(k);
    else pending.set(k, { before, after, touched, label, cat, ref: ref || (prev && prev.ref) });
    if (!quiet) renderMain();
    renderFooter();
  }
  function edited(k, flag) { const p = pending.get(k); return !!p && valueDiffers((p.before || {})[flag], p.after[flag]); }
  function restrict(props, columns) { const o = {}; for (const c of columns) o[c] = props[c] === true; return o; }

  function toggleObject(name, label, base, columns, flag, value) {
    const k = 'object:' + name;
    const r = Deps.applyObject(eff(k, base), flag, value);
    stage(k, base, restrict(r.props, columns), flag, label, 'object');
  }
  function toggleField(f, objectBase, flag, value) {
    const k = 'field:' + f.name;
    const base = { read: f.read, edit: f.edit };
    const r = Deps.applyField(eff(k, base), flag, value, { permissionable: true, updateable: f.canEdit }, eff('object:' + objectPage.object, objectBase));
    if (r.blocked) { toast('warning', r.blocked); renderMain(); return; }
    stage(k, base, r.props, flag, f.label, 'field', true);
    patchRows([k]);
  }
  function bulkFields(fields, objectBase, flag, value) {
    for (const f of fields) {
      if (f.fixed) continue;
      if (flag === 'edit' && !f.canEdit) continue;
      const k = 'field:' + f.name;
      const base = { read: f.read, edit: f.edit };
      const r = Deps.applyField(eff(k, base), flag, value, { permissionable: true, updateable: f.canEdit }, null);
      if (r.blocked) continue;
      const prev = pending.get(k);
      const touched = new Set(prev ? prev.touched : []); touched.add(flag);
      const before = prev ? prev.before : base;
      if (!differs(before, r.props)) pending.delete(k); else pending.set(k, { before, after: r.props, touched, label: f.label, cat: 'field' });
    }
    patchRows(fields.map(f => 'field:' + f.name));
    renderFooter();
  }
  /**
   * Salesforce's own rules (PermissionDependency, CustomPermissionDependency):
   * turning a permission on turns on what it needs, turning one off turns off
   * what needs it, as Setup does. `graph` maps a permission to those it requires.
   */
  function ruleText(value, names) {
    const list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
    return value ? 'Also turned on ' + list + ', which Salesforce requires for it.' : 'Also turned off ' + list + ', which ' + (names.length > 1 ? 'need' : 'needs') + ' it.';
  }
  function withRules(graph, start, value) {
    const out = new Set();
    const next = value ? id => graph.get(id) || [] : id => [...graph.keys()].filter(k => (graph.get(k) || []).includes(id));
    const walk = id => { for (const n of next(id)) if (!out.has(n) && n !== start) { out.add(n); walk(n); } };
    walk(start);
    return [...out];
  }
  const norm = t => String(t || '').toLowerCase().replace(/^permissions/, '').replace(/[^a-z0-9]/g, '');
  function systemGraph() {
    const list = (detail && detail.data && detail.data.system) || [];
    const byKey = new Map();
    for (const x of list) { byKey.set(norm(x.name), x.name); byKey.set(norm(x.label), x.name); }
    const g = new Map();
    for (const [a, reqs] of Object.entries(permDeps.system || {})) {
      const from = byKey.get(norm(a));
      if (!from) continue;
      g.set(from, reqs.map(r => byKey.get(norm(r))).filter(Boolean));
    }
    return g;
  }
  function toggleSystem(s, value) {
    stage('user:' + s.name, { enabled: s.enabled }, { enabled: value }, 'enabled', s.label, 'user', true);
    const keys = ['user:' + s.name];
    const list = detail.data.system;
    for (const n of withRules(systemGraph(), s.name, value)) {
      const x = list.find(y => y.name === n);
      if (!x || eff('user:' + n, { enabled: x.enabled }).enabled === value) continue;
      stage('user:' + n, { enabled: x.enabled }, { enabled: value }, 'enabled', x.label, 'user', true, null, true);
      keys.push('user:' + n);
    }
    const was = ui.ruleNote && ui.ruleNote.key;
    ui.ruleNote = keys.length > 1 ? { key: 'user:' + s.name, text: ruleText(value, keys.slice(1).map(k => (list.find(y => 'user:' + y.name === k) || {}).label || k)) } : null;
    patchRows(keys.concat(was && !keys.includes(was) ? [was] : []));
  }
  function toggleEntity(cat, x, value) {
    const k = cat + ':' + x.name;
    stage(k, { enabled: x.enabled }, { enabled: value }, 'enabled', x.label, cat, true, x.entityId);
    const keys = [k];
    if (cat === 'customPermission' && access.customPermission && access.customPermission.data) {
      const rows = access.customPermission.data.items;
      const g = new Map(Object.entries(permDeps.custom || {}));
      for (const id of withRules(g, x.entityId, value)) {
        const y = rows.find(r => r.entityId === id);
        if (!y || eff(cat + ':' + y.name, { enabled: y.enabled }).enabled === value) continue;
        stage(cat + ':' + y.name, { enabled: y.enabled }, { enabled: value }, 'enabled', y.label, cat, true, y.entityId, true);
        keys.push(cat + ':' + y.name);
      }
      const was = ui.ruleNote && ui.ruleNote.key;
      ui.ruleNote = keys.length > 1 ? { key: k, text: ruleText(value, keys.slice(1).map(kk => (pending.get(kk) || {}).label || kk)) } : null;
      if (was && !keys.includes(was)) keys.push(was);
    }
    patchRows(keys);
  }

  function rtBase(t) { return rtPage.data.profile ? { visible: t.visible, default: t.default } : { visible: t.visible }; }
  function toggleRecordType(t, value) {
    const k = 'recordType:' + t.name;
    const cur = eff(k, rtBase(t));
    if (rtPage.data.profile && !value && cur.default) { toast('warning', 'Choose another default record type before removing this one.'); renderMain(); return; }
    const after = Object.assign({}, cur, { visible: value });
    // A profile needs a default once it has any record type of the object.
    if (rtPage.data.profile && value && !rtPage.data.items.some(x => eff('recordType:' + x.name, rtBase(x)).default)) after.default = true;
    stage(k, rtBase(t), after, 'visible', t.label, 'recordType');
  }
  function setDefaultRecordType(t) {
    for (const x of rtPage.data.items) {
      const k = 'recordType:' + x.name;
      const cur = eff(k, rtBase(x));
      if (x.name === t.name) stage(k, rtBase(x), { visible: true, default: true }, 'default', x.label, 'recordType', true);
      else if (cur.default) stage(k, rtBase(x), Object.assign({}, cur, { default: false }), 'default', x.label, 'recordType', true);
    }
    renderMain();
  }

  /**
   * Redraws only the given table rows (plus the field table's header and
   * count), so a click on an object with hundreds of fields stays instant.
   * Falls back to a full redraw when something outside the table changes.
   */
  function patchRows(keys) {
    const fieldBody = main.querySelector('#fieldBody');
    const sysBody = main.querySelector('#sysBody');
    const od = objectPage && objectPage.data;
    if (fieldBody && od) {
      if (!!main.querySelector('#fieldNote') !== needsNote(od)) return renderMain();
      const ok = can('field');
      const byName = new Map(od.fields.map(f => [f.name, f]));
      for (const k of keys) {
        const tr = fieldBody.querySelector('tr[data-row="' + CSS.escape(k) + '"]');
        const f = byName.get(k.slice(6));
        if (tr && f) tr.replaceWith(fieldRow(f, od, ok));
      }
      const head = main.querySelector('#fieldHead');
      if (head) head.replaceWith(fieldHead(shownFields(od), od, ok));
      const count = main.querySelector('#fieldCount');
      if (count) count.textContent = fieldCountText(od);
    } else if (main.querySelector('#accBody') && access[ui.section] && access[ui.section].data) {
      const body = main.querySelector('#accBody');
      const ok = can(ui.section);
      const byName = new Map(access[ui.section].data.items.map(x => [ui.section + ':' + x.name, x]));
      for (const k of keys) {
        const tr = body.querySelector('tr[data-row="' + CSS.escape(k) + '"]');
        const x = byName.get(k);
        if (tr && x) tr.replaceWith(accessRow(ui.section, x, ok));
      }
      updateNavCount(ui.section);
    } else if (sysBody && detail && detail.data) {
      const ok = can('user');
      const byName = new Map(detail.data.system.map(x => [x.name, x]));
      for (const k of keys) {
        const tr = sysBody.querySelector('tr[data-row="' + CSS.escape(k) + '"]');
        const sp = byName.get(k.slice(5));
        if (tr && sp) tr.replaceWith(sysRow(sp, ok));
      }
      updateNavCount('system');
    } else return renderMain();
    if (lastFocus) { const el = main.querySelector('[data-fid="' + CSS.escape(lastFocus) + '"]'); if (el) el.focus({ preventScroll: true }); }
  }

  /** Drops staged entries the org now already matches (after a refresh or a partial save). */
  function reconcile(entries) {
    for (const [k, base] of entries) { const p = pending.get(k); if (p && !differs(base, p.after)) pending.delete(k); }
  }

  // ---------- skeleton ----------
  const app = document.getElementById('app');
  const top = h('header', { class: 'globalbar' });
  const side = h('nav', { class: 'split', 'aria-label': 'Permission sets, groups and profiles' });
  const main = h('main', { class: 'record' });
  const footer = h('div', { class: 'docked-footer', hidden: true });
  const toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
  const overlay = h('div', { class: 'overlay', hidden: true });
  const body = h('div', { class: 'body no-side' }, [side, h('div', { class: 'record-wrap' }, [main, footer])]);
  app.append(top, body, toasts, overlay);

  // ---------- global bar ----------
  function renderTop() {
    top.textContent = '';
    const org = ctx.org;
    const left = h('div', { class: 'org' }, [
      h('span', { class: 'org-tile', 'aria-hidden': 'true' }, svg(ICONS.permissionSet)),
      h('div', { class: 'org-text' }, [
        h('div', { class: 'org-line' }, [
          h('span', { class: 'org-name', text: org ? (org.alias || org.username) : 'Permission Studio' }),
          ctx.production ? h('span', { class: 'badge warning', text: 'Production' }) : ctx.sandbox ? h('span', { class: 'badge sandbox', text: 'Sandbox' }) : null,
          ctx.mode === 'cli' ? h('span', { class: 'badge', title: 'Direct API calls were refused or blocked, so calls go through the Salesforce CLI.', text: 'CLI connection' }) : null,
          ctx.offline ? h('span', { class: 'badge error', text: 'Offline · saved data' }) : null
        ]),
        org ? h('div', { class: 'org-sub', text: org.username }) : null
      ])
    ]);
    const status = ctx.connecting ? h('span', { class: 'muted status' }, [spinner(true), ' Connecting…'])
      : listsMeta.refreshing ? h('span', { class: 'muted status' }, [spinner(true), ' Refreshing…'])
        : listsMeta.savedAt ? h('span', { class: 'muted status', text: 'Updated ' + ago(listsMeta.savedAt) }) : null;
    const tool = (id, label) => h('button', { class: 'btn ' + (ui.tool === id ? 'brand' : 'neutral'), disabled: ctx.status !== 'ready' || !lists, onclick: () => (ui.tool === id ? closeTool() : openTool(id)), text: label });
    top.append(left, h('div', { class: 'actions' }, [status,
      h('div', { class: 'btn-group' }, [tool('lookup', 'Find access'), tool('wizard', 'Grant field access'), tool('objwizard', 'Grant object access'), tool('history', 'History')]),
      h('button', { class: 'btn neutral', onclick: () => send({ type: 'showLog' }), text: 'Log' }),
      h('button', { class: 'btn neutral icon-btn', title: 'Refresh everything from the org', 'aria-label': 'Refresh', disabled: ctx.status === 'loading',
        onclick: () => guard(() => send({ type: 'refresh' })) }, [svg(ICONS.refresh), h('span', { text: 'Refresh' })])
    ]));
  }

  // ---------- split view ----------
  function renderSide() {
    const old = document.getElementById('list');
    const keepScroll = old ? old.scrollTop : 0;
    side.textContent = '';
    body.classList.toggle('no-side', !lists);
    if (!lists) return;
    side.appendChild(h('div', { class: 'split-head' }, [
      h('div', { class: 'kinds', role: 'tablist' }, KINDS.map(([k, label]) => h('button', { role: 'tab', class: ui.kind === k ? 'kind on' : 'kind', 'aria-selected': String(ui.kind === k),
        onclick: () => { ui.kind = k; save(); renderSide(); } }, [label, h('span', { class: 'count', text: String(lists[k].length) })]))),
      searchBox(ui.search, 'Search this list', v => { ui.search = v; save(); renderList(); })
    ]));
    side.appendChild(h('div', { class: 'split-list', id: 'list', role: 'listbox', 'aria-label': 'Items' }));
    renderList();
    const list = document.getElementById('list');
    if (list && keepScroll) list.scrollTop = keepScroll;
  }
  function renderList() {
    const box = document.getElementById('list');
    if (!box) return;
    box.textContent = '';
    const q = ui.search.trim().toLowerCase();
    const rows = lists[ui.kind].filter(r => !q || r.label.toLowerCase().includes(q) || r.apiName.toLowerCase().includes(q));
    const favRows = rows.filter(r => favs.items.has(favId(r)));
    const rest = rows.filter(r => !favs.items.has(favId(r)));
    const frag = document.createDocumentFragment();
    const item = r => {
      const marks = [r.managed ? 'Managed' : '', r.standard ? 'Standard' : '', r.sessionBased ? 'Session-based' : '', r.status && r.status !== 'Updated' ? r.status : ''].filter(Boolean);
      const on = ui.selected === r.key;
      const isFav = favs.items.has(favId(r));
      return h('div', { role: 'option', tabindex: '0', class: 'split-item' + (on ? ' on' : ''), 'aria-selected': String(on), 'data-key': r.key,
        onclick: () => guard(() => choose(r.key)), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); guard(() => choose(r.key)); } } }, [
        h('div', { class: 'si-text' }, [
          h('span', { class: 'si-title', text: r.label }),
          h('span', { class: 'si-sub' }, [h('span', { text: r.apiName !== r.label ? r.apiName : (r.license || '') })].concat(marks.map(m => h('span', { class: 'pill', text: m }))))]),
        star(isFav, r.label, () => send({ type: 'toggleFavorite', kind: 'item', id: favId(r) }))
      ]);
    };
    if (ui.kind === 'profile' && lists.profilesFiltered) frag.appendChild(h('div', { class: 'si-note' }, alertBox('info', 'Only your own profile is visible. Since Winter ’27, Salesforce shows other profiles only to users with the View All Profiles permission.')));
    if (favRows.length) {
      frag.appendChild(h('div', { class: 'si-group', text: 'Favorites' }));
      favRows.forEach(r => frag.appendChild(item(r)));
      if (rest.length || lists.partial) frag.appendChild(h('div', { class: 'si-group', text: 'All ' + KINDS.find(k => k[0] === ui.kind)[1].toLowerCase() }));
    }
    rest.forEach(r => frag.appendChild(item(r)));
    if (lists.partial) frag.appendChild(h('div', { class: 'empty-line' }, [spinner(true), ' Loading the rest…']));
    else if (!rows.length) frag.appendChild(h('p', { class: 'empty-line', text: q ? 'No matches for “' + ui.search + '”.' : 'None in this org.' }));
    box.appendChild(frag);
  }
  function choose(key) {
    ui.selected = key; ui.page = 'detail'; ui.object = null; save();
    pending.clear(); objectPage = null; rtPage = null; access = {}; accessLimit = 300;
    tabsPage = null; assignPage = null; loginPage = null; layoutPage = null; componentsPage = null; auditPage = null; assigneeBlockers = {}; localFile = null; userResults = null; ui.tool = null; renderTop();
    document.querySelectorAll('.split-item').forEach(b => { const on = b.getAttribute('data-key') === key; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    detail = { key, state: 'loading' };
    renderMain(); renderFooter();
    send({ type: 'select', key });
  }
  /** Runs `fn` now, or after asking, when there are unsaved changes. */
  function guard(fn) {
    if (!pending.size) return fn();
    openModal({ kind: 'discard', then: fn });
  }

  // ---------- record page ----------
  function renderMain() {
    const scroll = main.scrollTop;
    // Keep focus (and the caret) in whatever had it, e.g. a search box being typed in.
    const act = document.activeElement;
    const keepFid = act && main.contains(act) ? act.getAttribute('data-fid') : null;
    const caret = keepFid && typeof act.selectionStart === 'number' ? [act.selectionStart, act.selectionEnd] : null;
    main.textContent = '';
    try { drawMain(); } finally {
      main.scrollTop = scroll;
      const fid = keepFid || lastFocus;
      const el = fid ? main.querySelector('[data-fid="' + CSS.escape(fid) + '"]') : null;
      if (el) { el.focus({ preventScroll: true }); if (caret && el.setSelectionRange) { try { el.setSelectionRange(caret[0], caret[1]); } catch (e) { /* not a text field */ } } }
    }
  }
  function drawMain() {
    if (ctx.status !== 'ready' && !lists) { main.appendChild(statusView()); return; }
    if (ui.tool) { main.appendChild(toolPage()); return; }
    if (!ui.selected || !detail) { main.appendChild(h('div', { class: 'illustration' }, [svg(ICONS.permissionSet, 'big-icon'), h('h2', { text: 'Pick something to open' }), h('p', { class: 'muted', text: 'Choose a permission set, group or profile from the list to see and change its access.' })])); return; }
    if (!detail.data) {
      if (detail.state === 'error') main.appendChild(h('div', { class: 'pad' }, alertBox('error', 'Could not read this item. ', [h('pre', { text: detail.message || '' }), h('div', { class: 'btns' }, [h('button', { class: 'btn brand', onclick: () => send({ type: 'select', key: ui.selected, force: true }), text: 'Try again' }), h('button', { class: 'btn neutral', onclick: () => send({ type: 'showLog' }), text: 'Show log' })])])));
      else main.appendChild(h('div', { class: 'loading-block' }, [spinner(), h('p', { class: 'muted', text: 'Reading from the org…' })]));
      return;
    }
    if (ui.restored && pending.size) main.appendChild(h('div', { class: 'restored', role: 'status' }, [
      h('span', { class: 'grow' }, [h('b', { text: pending.size + (pending.size === 1 ? ' unsaved change' : ' unsaved changes') }), ' from your last session ' + (pending.size === 1 ? 'was' : 'were') + ' kept and ' + (pending.size === 1 ? 'is' : 'are') + ' ready to review.']),
      h('button', { class: 'btn neutral', onclick: () => { pending.clear(); ui.restored = 0; renderMain(); renderFooter(); }, text: 'Discard' }),
      h('button', { class: 'btn brand', onclick: () => openModal({ kind: 'review' }), text: 'Review' })]));
    main.appendChild(narrowPicker());
    main.appendChild(pageHeader(detail.data.header));
    if (detail.data.header.readOnlyReason) main.appendChild(h('div', { class: 'pad-x' }, alertBox('info', detail.data.header.readOnlyReason)));
    main.appendChild(sectionsView());
  }

  /** Narrow windows: the item list becomes a picker (CSS shows it below 900 px). */
  function narrowPicker() {
    const groups = KINDS.map(([kind, title]) => h('optgroup', { label: title }, ((lists && lists[kind]) || []).map(r => h('option', { value: r.key, selected: r.key === ui.selected, text: r.label }))));
    return h('div', { class: 'narrow-bar' }, [h('select', { class: 'select', 'aria-label': 'Open an item', onchange: e => { const k = e.target.value; guard(() => { ui.kind = k.split(':')[0]; save(); renderSide(); choose(k); }); } }, groups),
      ui.selected && (lists[ui.kind] || []).some(r => r.key === ui.selected) ? star(favs.items.has(favId((lists[ui.kind] || []).find(r => r.key === ui.selected))), 'this item', () => {
        const r = (lists[ui.kind] || []).find(x => x.key === ui.selected); if (r) send({ type: 'toggleFavorite', kind: 'item', id: favId(r) }); }) : null]);
  }
  function narrowSections(kind) {
    const opts = SECTIONS.flatMap(([g, entries]) => entries.filter(e => !e[2] || e[2](kind)).map(e => [e[0], e[1]]));
    return h('div', { class: 'narrow-sections' }, select(opts, ui.section, v => { ui.section = v; ui.page = 'detail'; save(); renderMain(); }, false, 'nav.narrow', 'Section'));
  }

  function statusView() {
    const s = ctx.status;
    if (s === 'loading') return h('div', { class: 'loading-block' }, [spinner(), h('p', { class: 'muted', text: ctx.message || 'Loading…' })]);
    if (s === 'noProject') return h('div', { class: 'illustration' }, [h('h2', { text: 'No Salesforce project open' }), h('p', { class: 'muted', text: 'Open a folder that contains sfdx-project.json, or point the permStudio.project.path setting at one.' })]);
    if (s === 'noOrg') return h('div', { class: 'illustration' }, [h('h2', { text: 'This project has no default org' }), h('p', { class: 'muted', text: 'Set one in a terminal in the project folder, then select Refresh:' }), h('pre', { text: 'sf config set target-org <alias>' })]);
    return h('div', { class: 'pad' }, alertBox('error', 'Could not load the org. ', [h('pre', { text: ctx.message || '' }), h('div', { class: 'btns' }, [h('button', { class: 'btn brand', onclick: () => send({ type: 'refresh' }), text: 'Try again' }), h('button', { class: 'btn neutral', onclick: () => send({ type: 'showLog' }), text: 'Show log' })])]));
  }

  function pageHeader(hd) {
    const meta = detail.refreshing ? h('span', { class: 'muted status' }, [spinner(true), ' Refreshing…']) : h('span', { class: 'muted status', text: 'Updated ' + ago(detail.savedAt) });
    const fields = [['API Name', hd.apiName], ['License', hd.license || '—'], ['Active Users', String(hd.activeAssignees)],
      ['Last Modified', hd.modified ? fmtDate(hd.modified.at) + (hd.modified.by ? ' by ' + hd.modified.by : '') : '—']];
    if (hd.status) fields.push(['Status', hd.status]);
    return h('div', { class: 'page-header' }, [
      h('div', { class: 'ph-row' }, [
        h('div', { class: 'ph-title' }, [
          h('span', { class: 'icon-tile ' + hd.kindId, 'aria-hidden': 'true' }, svg(ICONS[hd.kindId] || ICONS.permissionSet)),
          h('div', {}, [h('div', { class: 'ph-type', text: hd.kind }), h('h1', {}, [hd.label, hd.sessionBased ? h('span', { class: 'pill warn', title: 'Session-based: assigned users switch this permission set on for a session.', text: 'Session-based' }) : null])])
        ]),
        h('div', { class: 'ph-actions' }, [meta,
          hd.canRename ? h('button', { class: 'btn neutral', onclick: () => guard(() => openPsForm('edit')), text: 'Edit' }) : null,
          hd.canClone ? h('button', { class: 'btn neutral', onclick: () => guard(() => openPsForm('clone')), text: 'Clone' }) : null,
          hd.canCopyToPs ? h('button', { class: 'btn neutral', title: 'Copy this profile’s access into a new permission set', onclick: () => guard(() => openPsForm('copyProfile')), text: 'Copy to permission set' }) : null,
          h('button', { class: 'btn neutral', onclick: () => guard(() => reloadCurrent()), text: 'Reload' })])
      ]),
      h('dl', { class: 'highlights' }, fields.map(([k, v]) => h('div', { class: 'hl' }, [h('dt', { text: k }), h('dd', { text: v, title: v })]))),
      hd.description ? h('p', { class: 'ph-desc', text: hd.description }) : null
    ]);
  }
  /**
   * Background refresh of what is on screen, keeping unsaved edits: the
   * cached copy stays until the fresh one lands. Metadata API sections
   * (record types, layouts, login settings) are slow, so they are left to Reload.
   */
  function refreshOpen() {
    if (!ui.selected || saving || ui.tool || (modal && modal.kind !== 'discard')) return;
    send({ type: 'select', key: ui.selected });
    if (ui.page === 'object' && ui.object) send({ type: 'openObject', key: ui.selected, object: ui.object });
    for (const cat of Object.keys(access)) if (access[cat] && access[cat].data) send({ type: 'loadAccess', key: ui.selected, category: cat });
    if (tabsPage && tabsPage.data) send({ type: 'loadTabs', key: ui.selected });
    if (assignPage && assignPage.data) send({ type: 'loadAssignments', key: ui.selected });
    if (componentsPage && componentsPage.data) send({ type: 'loadComponents', key: ui.selected });
  }
  function reloadCurrent() {
    pending.clear(); renderFooter();
    if (ui.page === 'object' && ui.object) { send({ type: 'openObject', key: ui.selected, object: ui.object, force: true }); send({ type: 'loadRecordTypes', key: ui.selected, object: ui.object, force: true }); }
    send({ type: 'select', key: ui.selected, force: true });
    for (const cat of Object.keys(access)) send({ type: 'loadAccess', key: ui.selected, category: cat, force: true });
    if (tabsPage) send({ type: 'loadTabs', key: ui.selected, force: true });
    if (assignPage) send({ type: 'loadAssignments', key: ui.selected, force: true });
    if (componentsPage) send({ type: 'loadComponents', key: ui.selected, force: true });
    if (auditPage) send({ type: 'loadAudit', key: ui.selected, force: true });
    if (loginPage) send({ type: 'loadLogin', key: ui.selected, force: true });
    if (layoutPage && ui.object) send({ type: 'loadLayouts', key: ui.selected, object: ui.object, force: true });
  }

  /** The record page body: a section menu grouped like Setup's overview, and the chosen section. */
  function sectionsView() {
    const d = detail.data;
    const kind = d.header.kindId;
    if (ui.page === 'object' && ui.object) return h('div', { class: 'sections' }, [nav(kind), h('div', { class: 'section-body' }, [narrowSections(kind)].concat(objectView()))]);
    const valid = SECTIONS.flatMap(g => g[1]).filter(e => !e[2] || e[2](kind)).map(e => e[0]);
    if (!valid.includes(ui.section)) ui.section = 'objects';
    return h('div', { class: 'sections' }, [nav(kind), h('div', { class: 'section-body' }, [narrowSections(kind)].concat(sectionContent(ui.section)))]);
  }
  function sectionLabel(id) { const t = ACCESS_TABS.find(x => x[0] === id); return t ? t[1] : (SECTIONS.flatMap(g => g[1]).find(e => e[0] === id) || [])[1] || id; }
  function sectionCount(id) {
    const d = detail.data;
    if (id === 'objects') return d.objects.filter(o => Object.values(eff('object:' + o.name, o.props)).some(Boolean)).length + (d.fieldObjects || []).length;
    if (id === 'system') return d.system.filter(x => eff('user:' + x.name, { enabled: x.enabled }).enabled).length;
    if (access[id] && access[id].data) return access[id].data.items.filter(x => eff(id + ':' + x.name, { enabled: x.enabled }).enabled).length;
    if (id === 'tab' && tabsPage && tabsPage.data) return tabsPage.data.items.filter(t => eff('tab:' + t.name, { visibility: t.visibility }).visibility !== 'None').length;
    if (id === 'components' && componentsPage && componentsPage.data) return componentsPage.data.components.filter(c => !c.muting && eff('groupComponent:' + c.permissionSetId, { included: true }).included).length
      + [...pending.values()].filter(p => p.cat === 'groupComponent' && p.after.included && !(p.before || {}).included).length;
    if ((id === 'assignment' || id === 'users') && assignPage && assignPage.data) return assignPage.data.items.length + [...pending.values()].filter(p => p.cat === 'assignment' && p.after.assigned && !(p.before || {}).assigned).length;
    return null;
  }
  function updateNavCount(id) {
    const el = main.querySelector('.nav-item[data-section="' + id + '"] .count');
    const n = sectionCount(id);
    if (el && n !== null) el.textContent = String(n);
  }
  function nav(kind) {
    return h('nav', { class: 'section-nav', 'aria-label': 'Sections' }, SECTIONS.filter(([, entries]) => entries.some(e => !e[2] || e[2](kind))).map(([group, entries]) => h('div', { class: 'nav-group nav-g-' + group.toLowerCase() }, [
      h('div', { class: 'nav-title', text: group })].concat(entries.filter(e => !e[2] || e[2](kind)).map(e => {
      const id = e[0];
      const on = (ui.page !== 'object' && ui.section === id) || (ui.page === 'object' && id === 'objects');
      const n = sectionCount(id);
      const dirty = [...pending.values()].some(p => sectionOf(p.cat) === id);
      return h('button', { class: 'nav-item' + (on ? ' on' : ''), 'data-section': id, 'aria-current': on ? 'page' : null,
        onclick: () => { ui.section = id; ui.page = 'detail'; accessLimit = 300; save(); renderMain(); main.scrollTop = 0; } },
      [NAV_ICONS[id] ? svg(NAV_ICONS[id], 'nav-icon') : null, h('span', { class: 'nav-label', text: sectionLabel(id) }), dirty ? h('span', { class: 'dot', title: 'Unsaved changes' }) : null,
        n === null ? null : h('span', { class: 'count' + (n ? ' has' : ''), text: String(n) })]);
    })))));
  }
  function sectionOf(cat) {
    if (cat === 'object' || cat === 'field' || cat === 'recordType' || cat === 'layoutAssignment') return 'objects';
    if (cat === 'user') return 'system';
    if (cat === 'loginHours' || cat === 'loginIpRanges') return 'login';
    if (cat === 'assignment') return 'assignment';
    if (cat === 'groupComponent') return 'components';
    return cat;
  }
  function sectionContent(id) {
    if (id === 'objects') return objectsCard();
    if (id === 'system') return systemCard();
    if (ACCESS_TABS.some(t => t[0] === id)) { ensureAccess(id); return accessCard(id); }
    if (id === 'tab') return tabsCard();
    if (id === 'assignment' || id === 'users') return assignCard();
    if (id === 'login') return loginCard();
    if (id === 'components') return componentsCard();
    if (id === 'audit') return auditCard();
    return h('p', { class: 'empty-line', text: 'Unknown section.' });
  }
  function loadingCard(title, page, retry, message) {
    const head = h('div', { class: 'card-head' }, [h('h2', { text: title })]);
    const inner = page && page.state === 'error'
      ? alertBox('error', 'Could not read this. ', [h('pre', { text: page.message || '' }), retry ? h('button', { class: 'btn neutral', onclick: retry, text: 'Try again' }) : null])
      : h('div', { class: 'skeleton', 'aria-busy': 'true' }, [0, 1, 2, 3, 4].map(i => h('div', { class: 'sk-row' }, [
        h('span', { style: 'width:' + [38, 30, 44, 28, 36][i] + '%' }), h('span', { style: 'width:' + [22, 26, 18, 24, 20][i] + '%' }), h('span', { style: 'width:' + [30, 18, 26, 34, 22][i] + '%' })]))
        .concat([h('p', { class: 'muted sk-text', text: message || 'Reading from the org…' })]));
    return h('section', { class: 'card' }, [head, h('div', { class: 'card-body' + (page && page.state === 'error' ? '' : ' flush') }, inner)]);
  }
  function select(options, value, onChange, disabled, fid, aria) {
    return h('select', { class: 'select', disabled, 'data-fid': fid, 'aria-label': aria, onchange: e => { lastFocus = fid; onChange(e.target.value); } },
      options.map(([v, label]) => h('option', { value: v, selected: v === value ? true : null, text: label })));
  }

  // ---------- tab settings (permission sets) ----------
  function tabsCard() {
    if (!tabsPage || tabsPage.key !== ui.selected) { tabsPage = { key: ui.selected, state: 'loading' }; send({ type: 'loadTabs', key: ui.selected }); }
    if (!tabsPage.data) return loadingCard('Tab Settings', tabsPage, () => { tabsPage = null; renderMain(); });
    const ok = can('tab');
    const q = (ui.tabsFilter || '').trim().toLowerCase();
    if (ui.tabsOnly === undefined) ui.tabsOnly = true;
    let rows = tabsPage.data.items;
    if (q) rows = rows.filter(t => t.label.toLowerCase().includes(q) || t.name.toLowerCase().includes(q));
    else if (ui.tabsOnly) rows = rows.filter(t => t.visibility !== 'None' || pending.has('tab:' + t.name));
    return h('section', { class: 'card' }, [
      h('div', { class: 'card-head' }, [h('h2', { text: 'Tab Settings' }), h('div', { class: 'card-tools' }, [
        tabsPage.refreshing ? h('span', { class: 'muted status' }, [spinner(true), ' Refreshing…']) : null,
        searchBox(ui.tabsFilter || '', 'Search tabs', v => { ui.tabsFilter = v; renderMain(); }, 'search.tabs', true),
        toggle('Show only set', ui.tabsOnly, v => { ui.tabsOnly = v; renderMain(); })])]),
      h('div', { class: 'card-body flush' }, rows.length ? h('table', { class: 'datatable' }, [
        h('thead', {}, h('tr', {}, [h('th', { text: 'Tab' }), h('th', { text: 'API Name' }), h('th', { text: 'Visibility' })])),
        h('tbody', {}, rows.map(t => {
          const k = 'tab:' + t.name;
          const v = eff(k, { visibility: t.visibility }).visibility;
          return h('tr', { class: pending.has(k) ? 'row-edited' : '' }, [h('td', { class: 'strong', text: t.label }), h('td', { class: 'muted mono', text: t.name }),
            h('td', {}, select(detail.data.header.kindId === 'profile' ? [['Visible', 'Default On'], ['Available', 'Default Off'], ['None', 'Tab Hidden']] : [['Visible', 'Visible'], ['Available', 'Available'], ['None', 'Hidden']], v, val => stage(k, { visibility: t.visibility }, { visibility: val }, 'visibility', t.label, 'tab'), !ok, k, 'Visibility of ' + t.label))]);
        }))]) : h('p', { class: 'empty-line', text: q ? 'No tabs match.' : 'No tab settings. Search or turn off “Show only set” to add some.' })),
      h('div', { class: 'card-body' }, h('p', { class: 'muted flat', text: 'Tab settings are saved through the Metadata API, with the same safety copy as record types.' }))
    ]);
  }

  // ---------- assignments / users ----------
  function assignCard() {
    if (!assignPage || assignPage.key !== ui.selected) { assignPage = { key: ui.selected, state: 'loading' }; send({ type: 'loadAssignments', key: ui.selected }); }
    const title = detail.data.header.kindId === 'profile' ? 'Users' : 'Assignments';
    if (!assignPage.data) return loadingCard(title, assignPage, () => { assignPage = null; renderMain(); });
    const d = assignPage.data;
    const ok = can('assignment') && !d.readOnly;
    const q = (ui.assignFilter || '').trim().toLowerCase();
    const added = [...pending.entries()].filter(([k, p]) => p.cat === 'assignment' && !d.items.some(u => 'assignment:' + u.userId === k))
      .map(([k, p]) => ({ userId: k.slice(11), name: p.label, username: (p.meta && p.meta.username) || '', profile: (p.meta && p.meta.profile) || '', assigned: false, expires: null, isNew: true }));
    let rows = added.concat(d.items);
    if (q) rows = rows.filter(u => u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q) || (u.profile || '').toLowerCase().includes(q));
    const cols = [h('th', { text: 'User' }), h('th', { text: 'Username' }), h('th', { text: 'Profile' })];
    if (!d.readOnly) { if (d.expiration) cols.push(h('th', { text: 'Expires' })); cols.push(h('th', { class: 'c', text: 'Assigned' })); }
    const adder = ok ? h('div', { class: 'adder' }, [
      searchBox(ui.userQuery || '', 'Add users: type a name or username', v => { ui.userQuery = v; if (v.trim().length >= 2) send({ type: 'userSearch', text: v }); else userResults = null; renderMain(); }, 'search.users', true),
      userResults && userResults.text === ui.userQuery ? h('ul', { class: 'results' }, userResults.users.length ? userResults.users.map(u => {
        const has = d.items.some(x => x.userId === u.userId) || pending.has('assignment:' + u.userId);
        return h('li', {}, [h('span', { class: 'strong', text: u.name }), h('span', { class: 'muted', text: ' ' + u.username + (u.profile ? ' · ' + u.profile : '') }),
          h('button', { class: 'btn neutral small', disabled: has, onclick: () => {
            stage('assignment:' + u.userId, { assigned: false, expires: null }, { assigned: true, expires: null }, 'assigned', u.name, 'assignment', true, u.userId);
            pending.get('assignment:' + u.userId).meta = { username: u.username, profile: u.profile };
            send({ type: 'checkAssignees', key: ui.selected, userIds: [u.userId] });
            renderMain(); }, text: has ? 'Added' : 'Add' })]);
      }) : [h('li', { class: 'muted', text: userResults.message || 'No active users match.' })]) : null]) : null;
    return h('section', { class: 'card' }, [
      h('div', { class: 'card-head' }, [h('h2', {}, [title + ' ', h('span', { class: 'count', text: String(d.items.length) })]), h('div', { class: 'card-tools' }, [
        assignPage.refreshing ? h('span', { class: 'muted status' }, [spinner(true), ' Refreshing…']) : null,
        searchBox(ui.assignFilter || '', 'Filter this list', v => { ui.assignFilter = v; renderMain(); }, 'search.assign', true)])]),
      adder ? h('div', { class: 'card-body' }, adder) : null,
      d.readOnly ? h('div', { class: 'card-body' }, h('p', { class: 'muted flat', text: 'Users get a profile from their user record. This list is read-only.' })) : null,
      h('div', { class: 'card-body flush' }, rows.length ? h('table', { class: 'datatable' }, [h('thead', {}, h('tr', {}, cols)),
        h('tbody', {}, rows.map(u => {
          const k = 'assignment:' + u.userId;
          const base = { assigned: !u.isNew && u.assigned, expires: u.expires || null };
          const p = eff(k, base);
          const left = p.expires ? Math.ceil((new Date(p.expires + 'T23:59:59') - Date.now()) / 86400000) : null;
          const expiry = left === null ? null : left < 0 ? h('span', { class: 'pill risk', text: 'Expired' }) : left <= 30 ? h('span', { class: 'pill warn', text: left === 0 ? 'Expires today' : 'Expires in ' + left + (left === 1 ? ' day' : ' days') }) : null;
          const blocked = u.isNew && assigneeBlockers[u.userId];
          const cells = [h('td', { class: 'strong' }, [u.name, u.isNew ? h('span', { class: 'pill on', text: 'New' }) : null, u.active === false ? h('span', { class: 'pill', text: 'Inactive' }) : null, expiry,
            blocked ? h('span', { class: 'pill risk', title: u.name + ' ' + blocked, text: 'License mismatch' }) : null]),
            h('td', { class: 'muted', text: u.username }), h('td', { class: 'muted', text: u.profile || '' })];
          if (!d.readOnly) {
            if (d.expiration) cells.push(h('td', {}, h('input', { type: 'date', class: 'date' + (edited(k, 'expires') ? ' edited' : ''), value: p.expires || '', disabled: !ok || !p.assigned, 'data-fid': k + '.expires', 'aria-label': 'Expiry for ' + u.name,
              onchange: e => { lastFocus = k + '.expires'; stage(k, base, Object.assign({}, p, { expires: e.target.value || null }), 'expires', u.name, 'assignment', false, u.userId); } })));
            cells.push(h('td', { class: 'c' }, checkbox({ checked: p.assigned, disabled: !ok, edited: edited(k, 'assigned'), fid: k, aria: 'Assigned to ' + u.name,
              onChange: v => stage(k, base, { assigned: v, expires: v ? p.expires : null }, 'assigned', u.name, 'assignment', false, u.userId) })));
          }
          return h('tr', { class: pending.has(k) ? 'row-edited' : '' }, cells);
        }))]) : h('p', { class: 'empty-line', text: q ? 'No one matches.' : 'No one has this yet.' }))
    ]);
  }

  // ---------- a group's permission sets ----------
  function componentsCard() {
    if (!componentsPage || componentsPage.key !== ui.selected) { componentsPage = { key: ui.selected, state: 'loading' }; send({ type: 'loadComponents', key: ui.selected }); }
    if (!componentsPage.data) return loadingCard('Permission Sets in Group', componentsPage, () => { componentsPage = null; renderMain(); });
    const d = componentsPage.data;
    const ok = can('groupComponent');
    const have = new Set(d.components.map(c => c.permissionSetId));
    const added = [...pending.entries()].filter(([k, p]) => p.cat === 'groupComponent' && !have.has(k.slice(15)))
      .map(([k, p]) => ({ permissionSetId: k.slice(15), label: p.label, apiName: (p.meta && p.meta.apiName) || '', isNew: true }));
    const q = (ui.compFilter || '').trim().toLowerCase();
    let rows = added.concat(d.components);
    if (q) rows = rows.filter(c => c.label.toLowerCase().includes(q) || c.apiName.toLowerCase().includes(q));
    const status = d.status || (detail && detail.data ? detail.data.header.status : '');
    const banner = status === 'Updating' ? h('div', { class: 'card-body' }, alertBox('info', '', [spinner(true), ' Salesforce is recalculating this group’s access. The group’s permissions refresh here when it finishes.']))
      : status === 'Failed' ? h('div', { class: 'card-body' }, alertBox('error', 'Salesforce could not recalculate this group. Check the group in Setup.')) : null;
    const pickFrom = (lists && lists.permissionSet) || [];
    const uq = (ui.compAdd || '').trim().toLowerCase();
    const matches = uq.length >= 2 ? pickFrom.filter(r => !have.has(r.key.split(':')[1]) && !pending.has('groupComponent:' + r.key.split(':')[1]) && (r.label.toLowerCase().includes(uq) || r.apiName.toLowerCase().includes(uq))).slice(0, 20) : [];
    const adder = ok ? h('div', { class: 'adder' }, [
      searchBox(ui.compAdd || '', 'Add permission sets: type a name', v => { ui.compAdd = v; renderMain(); }, 'search.compadd', true),
      uq.length >= 2 ? h('ul', { class: 'results' }, matches.length ? matches.map(r => h('li', {}, [h('span', { class: 'strong', text: r.label }), h('span', { class: 'muted', text: ' ' + r.apiName }),
        r.managed ? h('span', { class: 'pill', text: 'Managed' }) : null,
        h('button', { class: 'btn neutral small', onclick: () => {
          const id = r.key.split(':')[1];
          stage('groupComponent:' + id, { included: false }, { included: true }, 'included', r.label, 'groupComponent', true, id);
          pending.get('groupComponent:' + id).meta = { apiName: r.apiName }; renderMain(); }, text: 'Add' })]))
        : [h('li', { class: 'muted', text: pickFrom.length ? 'No other permission sets match.' : 'Turn on the Permission Sets list (permStudio.lists.show) to pick from it.' })]) : null]) : null;
    return h('section', { class: 'card' }, [
      h('div', { class: 'card-head' }, [h('h2', {}, ['Permission Sets in Group ', h('span', { class: 'count', text: String(d.components.filter(c => !c.muting).length) })]),
        h('div', { class: 'card-tools' }, [componentsPage.refreshing ? h('span', { class: 'muted status' }, [spinner(true), ' Refreshing…']) : null,
          status ? h('span', { class: 'pill ' + (status === 'Updated' ? 'ok' : status === 'Failed' ? 'risk' : 'warn'), text: status }) : null,
          searchBox(ui.compFilter || '', 'Filter this list', v => { ui.compFilter = v; renderMain(); }, 'search.comp', true)])]),
      banner, adder ? h('div', { class: 'card-body' }, adder) : null,
      h('div', { class: 'card-body flush' }, rows.length ? h('table', { class: 'datatable' }, [
        h('thead', {}, h('tr', {}, [h('th', { class: 'c narrow', text: 'In group' }), h('th', { text: 'Permission Set' }), h('th', { text: 'API Name' })])),
        h('tbody', {}, rows.map(c => {
          const k = 'groupComponent:' + c.permissionSetId;
          const base = { included: !c.isNew };
          const inGroup = eff(k, base).included;
          const target = lists && lists.permissionSet && lists.permissionSet.find(r => r.key === 'permissionSet:' + c.permissionSetId);
          return h('tr', { class: pending.has(k) ? 'row-edited' : inGroup ? '' : 'dim' }, [
            h('td', { class: 'c narrow' }, c.muting ? h('span', { class: 'muted', text: '—' }) : checkbox({ checked: inGroup, disabled: !ok, edited: edited(k, 'included'), fid: k, aria: 'In group: ' + c.label,
              onChange: v => stage(k, base, { included: v }, 'included', c.label, 'groupComponent', false, c.permissionSetId) })),
            h('td', { class: 'strong' }, [target ? h('button', { class: 'link', onclick: () => guard(() => choose(target.key)), text: c.label }) : h('span', { text: c.label }),
              c.isNew ? h('span', { class: 'pill on', text: 'New' }) : null, c.muting ? h('span', { class: 'pill warn', title: 'Removes permissions from the group. Read-only here.', text: 'Muting' }) : null,
              c.managed ? h('span', { class: 'pill', text: 'Managed' }) : null]),
            h('td', { class: 'muted mono', text: c.apiName })]);
        }))]) : h('p', { class: 'empty-line', text: q ? 'Nothing matches.' : 'This group holds no permission sets yet.' })),
      h('div', { class: 'card-body' }, h('p', { class: 'muted flat', text: 'Adding or removing a permission set changes the group’s access for everyone assigned to it. Muting permission sets are shown but not edited here.' }))
    ]);
  }

  // ---------- changes made in Setup (Setup Audit Trail) ----------
  function auditCard() {
    if (!auditPage || auditPage.key !== ui.selected) { auditPage = { key: ui.selected, state: 'loading' }; send({ type: 'loadAudit', key: ui.selected }); }
    if (!auditPage.data) return loadingCard('Changes in Setup', auditPage, () => { auditPage = null; renderMain(); });
    const d = auditPage.data;
    return h('section', { class: 'card' }, [
      h('div', { class: 'card-head' }, [h('h2', {}, ['Changes in Setup ', h('span', { class: 'count', text: String(d.items.length) })]), h('div', { class: 'card-tools' }, [
        auditPage.refreshing ? h('span', { class: 'muted status' }, [spinner(true), ' Refreshing…']) : null,
        h('span', { class: 'muted', text: 'Last 90 days, from Setup Audit Trail' })])]),
      d.denied ? h('div', { class: 'card-body' }, alertBox('info', 'Reading Setup Audit Trail needs the View Setup Audit Trail permission (from Winter ’27; View Setup before that). Changes made with Permission Studio are in History either way.'))
      : h('div', { class: 'card-body flush' }, d.items.length ? h('table', { class: 'datatable' }, [
        h('thead', {}, h('tr', {}, [h('th', { text: 'When' }), h('th', { text: 'Who' }), h('th', { text: 'What changed' }), h('th', { text: 'Section' })])),
        h('tbody', {}, d.items.map(x => h('tr', {}, [h('td', { class: 'muted', text: fmtDate(x.at) }), h('td', { class: 'strong', text: x.by + (x.delegate ? ' (as ' + x.delegate + ')' : '') }),
          h('td', { class: 'wrap', text: x.display }), h('td', { class: 'muted', text: x.section })])))])
        : h('p', { class: 'empty-line', text: 'No changes to this item in Setup in the last 90 days.' }))
    ]);
  }

  // ---------- login hours and IP ranges (profiles) ----------
  function loginCard() {
    if (!loginPage || loginPage.key !== ui.selected) { loginPage = { key: ui.selected, state: 'loading' }; send({ type: 'loadLogin', key: ui.selected }); }
    if (!loginPage.data) return loadingCard('Login Hours & IP Ranges', loginPage, () => { loginPage = null; renderMain(); }, 'Reading through the Metadata API…');
    const ok = can('loginHours');
    const hk = 'loginHours:all';
    const baseHours = loginPage.data.hours || {};
    const hours = eff(hk, baseHours);
    const setDay = (day, which, v) => {
      const next = Object.assign({}, hours);
      if (v === '') { delete next[day + 'Start']; delete next[day + 'End']; }
      else {
        next[day + which] = v;
        const other = which === 'Start' ? 'End' : 'Start';
        if (next[day + other] === undefined) next[day + other] = which === 'Start' ? '1440' : '0';
      }
      stage(hk, baseHours, next, day + which, 'Login hours', 'loginHours');
    };
    const hourOpts = [['', 'No restriction']].concat(HOURS);
    const hoursTable = h('table', { class: 'datatable' }, [h('thead', {}, h('tr', {}, [h('th', { text: 'Day' }), h('th', { text: 'Start' }), h('th', { text: 'End' })])),
      h('tbody', {}, DAYS.map(day => h('tr', { class: edited(hk, day + 'Start') || edited(hk, day + 'End') ? 'row-edited' : '' }, [
        h('td', { class: 'strong', text: day[0].toUpperCase() + day.slice(1) }),
        h('td', {}, select(hourOpts, hours[day + 'Start'] === undefined ? '' : String(hours[day + 'Start']), v => setDay(day, 'Start', v), !ok, hk + day + 's', day + ' start')),
        h('td', {}, select(hourOpts, hours[day + 'End'] === undefined ? '' : String(hours[day + 'End']), v => setDay(day, 'End', v), !ok, hk + day + 'e', day + ' end'))])))]);
    const rk = 'loginIpRanges:all';
    const baseRanges = { ranges: loginPage.data.ranges || [] };
    const ranges = eff(rk, baseRanges).ranges;
    const setRanges = list => stage(rk, baseRanges, { ranges: list }, 'ranges', 'Login IP ranges', 'loginIpRanges');
    const field = (r, i, prop, label) => h('input', { type: 'text', class: 'text', value: r[prop] || '', disabled: !ok, 'aria-label': label + ' ' + (i + 1), 'data-fid': rk + i + prop, placeholder: prop === 'description' ? 'Optional' : '0.0.0.0',
      onchange: e => { lastFocus = rk + i + prop; setRanges(ranges.map((x, j) => (j === i ? Object.assign({}, x, { [prop]: e.target.value.trim() }) : x))); } });
    const rangeTable = h('table', { class: 'datatable' }, [h('thead', {}, h('tr', {}, [h('th', { text: 'Start IP' }), h('th', { text: 'End IP' }), h('th', { text: 'Description' }), h('th', { class: 'narrow' })])),
      h('tbody', {}, ranges.length ? ranges.map((r, i) => h('tr', {}, [h('td', {}, field(r, i, 'startAddress', 'Start IP')), h('td', {}, field(r, i, 'endAddress', 'End IP')), h('td', {}, field(r, i, 'description', 'Description')),
        h('td', { class: 'narrow' }, ok ? h('button', { class: 'btn neutral small', onclick: () => setRanges(ranges.filter((x, j) => j !== i)), text: 'Remove' }) : null)]))
        : [h('tr', {}, h('td', { colspan: '4', class: 'muted', text: 'No IP ranges: users can log in from anywhere.' }))])]);
    return h('div', { class: 'stack' }, [
      h('section', { class: 'card' }, [h('div', { class: 'card-head' }, [h('h2', { text: 'Login Hours' }), loginPage.refreshing ? h('span', { class: 'muted status' }, [spinner(true), ' Refreshing…']) : null]),
        h('div', { class: 'card-body flush' }, hoursTable)]),
      h('section', { class: 'card' }, [h('div', { class: 'card-head' }, [h('h2', { text: 'Login IP Ranges' }),
        ok ? h('button', { class: 'btn neutral', onclick: () => setRanges(ranges.concat([{ startAddress: '', endAddress: '', description: '' }])), text: 'Add range' }) : null]),
        h('div', { class: 'card-body flush' }, rangeTable),
        h('div', { class: 'card-body' }, h('p', { class: 'muted flat', text: 'The list is saved as a whole, exactly as shown, through the Metadata API.' }))])
    ]);
  }

  function ensureAccess(cat) {
    if (access[cat] && access[cat].key === ui.selected) return;
    access[cat] = { key: ui.selected, state: 'loading' };
    send({ type: 'loadAccess', key: ui.selected, category: cat });
  }

  function accessCard(cat) {
    const title = ACCESS_TABS.find(t => t[0] === cat)[2];
    const a = access[cat];
    const filterKey = cat + 'Filter';
    const onlyKey = cat + 'Only';
    if (ui[onlyKey] === undefined) ui[onlyKey] = true;
    const head = h('div', { class: 'card-head' }, [h('h2', { text: title }), h('div', { class: 'card-tools' }, [
      a && a.refreshing ? h('span', { class: 'muted status' }, [spinner(true), ' Refreshing…']) : null,
      searchBox(ui[filterKey] || '', 'Search ' + title.toLowerCase(), v => { ui[filterKey] = v; accessLimit = 300; renderMain(); }, 'search.' + cat, true),
      toggle('Show only enabled', ui[onlyKey], v => { ui[onlyKey] = v; accessLimit = 300; renderMain(); })])]);
    if (!a || !a.data) {
      const inner = a && a.state === 'error' ? alertBox('error', 'Could not read this list. ', [h('pre', { text: a.message || '' })]) : h('div', { class: 'loading-block' }, [spinner(), h('p', { class: 'muted', text: 'Reading from the org…' })]);
      return h('section', { class: 'card' }, [head, h('div', { class: 'card-body' }, inner)]);
    }
    const ok = can(cat);
    const q = (ui[filterKey] || '').trim().toLowerCase();
    let rows = a.data.items;
    // Searching looks through everything, so a class or permission can be found and granted.
    if (q) rows = rows.filter(x => x.label.toLowerCase().includes(q) || x.name.toLowerCase().includes(q));
    else if (ui[onlyKey]) rows = rows.filter(x => x.enabled || pending.has(cat + ':' + x.name));
    const shown = rows.slice(0, accessLimit);
    const body = rows.length ? h('table', { class: 'datatable' }, [
      h('thead', {}, h('tr', {}, [h('th', { class: 'c narrow', text: 'Enabled' }), h('th', { text: cat === 'apexClass' ? 'Class' : 'Permission' }), h('th', { text: 'API Name' }), h('th', { text: cat === 'customPermission' ? 'Description' : 'Namespace' })])),
      h('tbody', { id: 'accBody' }, shown.map(x => accessRow(cat, x, ok)))
    ]) : h('p', { class: 'empty-line', text: q ? 'Nothing matches.' : ui[onlyKey] ? 'None enabled. Search or turn off “Show only enabled” to grant some.' : 'None in this org.' });
    const more = rows.length > shown.length ? h('div', { class: 'more' }, [h('button', { class: 'btn neutral', onclick: () => { accessLimit += 500; renderMain(); }, text: 'Show ' + Math.min(500, rows.length - shown.length) + ' more of ' + (rows.length - shown.length) })]) : null;
    return h('section', { class: 'card' }, [head, h('div', { class: 'card-body flush' }, [body, more])]);
  }
  function accessRow(cat, x, ok) {
    const k = cat + ':' + x.name;
    const on = eff(k, { enabled: x.enabled }).enabled;
    return h('tr', { class: pending.has(k) ? 'row-edited' : on ? '' : 'dim', 'data-row': k }, [
      h('td', { class: 'c narrow' }, checkbox({ checked: on, disabled: !ok, edited: edited(k, 'enabled'), fid: k, aria: x.label, onChange: v => toggleEntity(cat, x, v) })),
      h('td', { class: 'strong' }, [x.label, ui.ruleNote && ui.ruleNote.key === k ? h('span', { class: 'rule-note', role: 'status', text: ui.ruleNote.text }) : null]), h('td', { class: 'muted mono', text: x.name }),
      h('td', { class: 'muted' }, cat === 'customPermission' ? (x.description || '') : x.namespace ? h('span', { class: 'pill', text: x.namespace }) : '')]);
  }

  function objectsCard() {
    const d = detail.data;
    const byName = new Map(d.objects.map(o => [o.name, o]));
    const labelOf = n => (Array.isArray(catalog) && (catalog.find(c => c.name === n) || {}).label) || n;
    let rows = d.objects.slice();
    // Favourite objects are always listed, even without access, so access is one click away.
    for (const n of favs.objects) if (!byName.has(n)) { rows.push({ name: n, label: labelOf(n), props: {} }); byName.set(n, rows[rows.length - 1]); }
    // Objects where only fields are granted (Event and Task can't be granted any other way).
    for (const f of d.fieldObjects || []) if (!byName.has(f.name)) { rows.push({ name: f.name, label: f.label, props: {}, fields: f.fields, fieldOnly: f.objectPermissions === false }); byName.set(f.name, rows[rows.length - 1]); }
    const q = ui.objFilter.trim().toLowerCase();
    // Searching looks at every object in the org, not only the ones listed.
    if (q && catalog === null) { catalog = 'loading'; send({ type: 'objectCatalog' }); }
    if ((ui.allObjects || q) && Array.isArray(catalog)) {
      for (const c of catalog) if (!byName.has(c.name)) rows.push({ name: c.name, label: c.label, props: {}, fieldOnly: c.objectPerms === false, other: !ui.allObjects });
    }
    if (!ui.allObjects) rows = rows.filter(o => o.other || o.fields || Object.values(o.props).some(Boolean) || pending.has('object:' + o.name) || favs.objects.has(o.name)
      || [...pending.keys()].some(k => k.startsWith('field:' + o.name + '.')));
    rows.sort((a, b) => (!!a.other - !!b.other) || (favs.objects.has(b.name) - favs.objects.has(a.name)) || a.label.localeCompare(b.label));
    if (q) rows = rows.filter(o => o.label.toLowerCase().includes(q) || o.name.toLowerCase().includes(q));
    const cols = d.objectColumns;
    const tools = h('div', { class: 'card-tools' }, [
      searchBox(ui.objFilter, 'Search objects', v => { ui.objFilter = v; renderMain(); }, 'search.objects', true),
      toggle('Show all objects', ui.allObjects, v => { ui.allObjects = v; if (v && catalog === null) { catalog = 'loading'; send({ type: 'objectCatalog' }); } renderMain(); }),
      catalog === 'loading' && (ui.allObjects || q) ? spinner(true) : null
    ]);
    const table = rows.length ? h('table', { class: 'datatable clickable' }, [
      h('thead', {}, h('tr', {}, [h('th', { class: 'narrow', 'aria-label': 'Favorite' }), h('th', { text: 'Object' }), h('th', { text: 'API Name' }), h('th', { text: 'Access' }), h('th', { class: 'narrow', 'aria-label': 'Open' })])),
      h('tbody', {}, rows.map(o => {
        const p = eff('object:' + o.name, o.props);
        const flags = cols.filter(c => p[c]);
        const changed = pending.has('object:' + o.name) || [...pending.keys()].some(k => k.startsWith('field:' + o.name + '.'));
        return h('tr', { tabindex: '0', class: changed ? 'row-edited' : flags.length || o.fields ? '' : 'dim', onclick: () => openObject(o.name), onkeydown: e => { if (e.key === 'Enter') openObject(o.name); } }, [
          h('td', { class: 'narrow' }, star(favs.objects.has(o.name), o.label, () => send({ type: 'toggleFavorite', kind: 'object', id: o.name }))),
          h('td', { class: 'strong' }, [o.label, changed ? h('span', { class: 'dot', title: 'Unsaved changes' }) : null]),
          h('td', { class: 'muted mono', text: o.name }),
          h('td', {}, flags.length ? flags.map(f => h('span', { class: 'pill perm ' + TONE[f], text: SHORT[f] }))
            : o.fields ? [h('span', { class: 'pill perm ' + TONE.read, title: 'This item grants access to ' + o.fields + (o.fields === 1 ? ' field' : ' fields') + ' on ' + o.label + '.', text: o.fields + (o.fields === 1 ? ' field' : ' fields') }),
              o.fieldOnly ? h('span', { class: 'muted', text: ' Field access only' }) : null]
            : o.fieldOnly ? h('span', { class: 'muted', title: 'Salesforce has no object permissions for this object; open it to set its fields’ access.', text: 'Field access only' }) : h('span', { class: 'muted', text: 'No access' })),
          h('td', { class: 'narrow' }, svg(ICONS.chevron, 'chev'))
        ]);
      }))
    ]) : h('p', { class: 'empty-line', text: q ? 'No objects match.' : 'This item grants no object access. Turn on “Show all objects” to add some.' });
    return h('section', { class: 'card' }, [h('div', { class: 'card-head' }, [h('h2', { text: 'Object Settings' }), tools]), h('div', { class: 'card-body flush' }, table)]);
  }
  function openObject(name) {
    ui.page = 'object'; ui.object = name; save();
    objectPage = { key: ui.selected, object: name, state: 'loading' };
    rtPage = { key: ui.selected, object: name, state: 'loading' };
    lastFocus = null;
    renderMain();
    send({ type: 'openObject', key: ui.selected, object: name });
    send({ type: 'loadRecordTypes', key: ui.selected, object: name });
    main.scrollTop = 0;
  }

  function objectView() {
    const crumbs = h('nav', { class: 'breadcrumb', 'aria-label': 'Breadcrumb' }, [
      h('button', { class: 'link', onclick: () => { ui.page = 'detail'; ui.section = 'objects'; save(); renderMain(); }, text: 'Object Settings' }),
      h('span', { class: 'sep', text: '›' }), h('span', { text: (objectPage && objectPage.data && objectPage.data.label) || ui.object })]);
    if (!objectPage || !objectPage.data) {
      if (objectPage && objectPage.state === 'error') return h('div', { class: 'stack' }, [crumbs, alertBox('error', 'Could not read this object. ', [h('pre', { text: objectPage.message || '' })])]);
      return h('div', { class: 'stack' }, [crumbs, h('div', { class: 'loading-block' }, [spinner(), h('p', { class: 'muted', text: 'Reading fields…' })])]);
    }
    const od = objectPage.data;
    const ok = can('object');
    const objKey = 'object:' + od.object;
    const objEff = eff(objKey, od.props);
    const objCard = h('section', { class: 'card' }, [
      h('div', { class: 'card-head' }, [h('h2', { text: 'Object Permissions' }), objectPage.refreshing ? h('span', { class: 'muted status' }, [spinner(true), ' Refreshing…']) : null]),
      od.objectPermissions === false ? h('div', { class: 'card-body' }, alertBox('info', 'Salesforce has no object permissions for ' + od.label + '. ' + (/^(Task|Event)$/.test(od.object)
        ? 'Activity access comes from the Edit Tasks and Edit Events system permissions; the fields below can still be set here.' : 'Only its fields’ access is set here.')))
      : h('div', { class: 'card-body' }, h('div', { class: 'perm-grid' }, OBJECT_FLAGS.filter(([f]) => od.columns.includes(f)).map(([f, label]) =>
        checkbox({ label, checked: objEff[f] === true, disabled: !ok, edited: edited(objKey, f), fid: objKey + '.' + f, tone: TONE[f],
          onChange: v => toggleObject(od.object, od.label, od.props, od.columns, f, v) }))))
    ]);
    const note = needsNote(od) ? h('div', { id: 'fieldNote' }, alertBox('info', 'Field access only takes effect where the user also has Read on ' + od.label + ' (from this or another permission set).')) : null;
    const fields = shownFields(od);
    const fieldCard = h('section', { class: 'card' }, [
      h('div', { class: 'card-head' }, [h('h2', {}, ['Field Permissions ', h('span', { class: 'count', id: 'fieldCount', text: fieldCountText(od) })]),
        h('div', { class: 'card-tools' }, [searchBox(ui.fieldFilter, 'Search fields', v => { ui.fieldFilter = v; renderMain(); }, 'search.fields', true),
          toggle('Show only granted', ui.fieldsGranted, v => { ui.fieldsGranted = v; renderMain(); })])]),
      h('div', { class: 'card-body flush' }, fields.length ? h('table', { class: 'datatable' }, [
        fieldHead(fields, od, can('field')),
        h('tbody', { id: 'fieldBody' }, fields.map(f => fieldRow(f, od, can('field'))))
      ]) : h('p', { class: 'empty-line', text: 'No fields match.' }))
    ]);
    return h('div', { class: 'stack' }, [crumbs, objCard, note, recordTypeCard(), detail.data.header.kindId === 'profile' ? layoutCard() : null, fieldCard]);
  }

  function recordTypeCard() {
    const head = h('div', { class: 'card-head' }, [h('h2', { text: 'Record Type Assignments' }),
      rtPage && rtPage.refreshing ? h('span', { class: 'muted status' }, [spinner(true), ' Refreshing…']) : null]);
    if (!rtPage || !rtPage.data) {
      const inner = rtPage && rtPage.state === 'error'
        ? alertBox('error', 'Could not read record type assignments. ', [h('pre', { text: rtPage.message || '' }), h('button', { class: 'btn neutral', onclick: () => { rtPage = { key: ui.selected, object: ui.object, state: 'loading' }; renderMain(); send({ type: 'loadRecordTypes', key: ui.selected, object: ui.object, force: true }); }, text: 'Try again' })])
        : h('p', { class: 'muted status' }, [spinner(true), ' Reading assignments through the Metadata API. This takes a few seconds the first time.']);
      return h('section', { class: 'card' }, [head, h('div', { class: 'card-body' }, inner)]);
    }
    const d = rtPage.data;
    if (!d.items.length) return h('section', { class: 'card' }, [head, h('div', { class: 'card-body' }, h('p', { class: 'muted flat', text: 'This object has no record types.' }))]);
    const ok = can('recordType') && !d.unavailable;
    const cols = [h('th', { text: 'Record Type' }), h('th', { text: 'API Name' }), h('th', { text: 'Active' }), h('th', { class: 'c', text: 'Assigned' })];
    if (d.profile) cols.push(h('th', { class: 'c', text: 'Default' }));
    return h('section', { class: 'card' }, [head, h('div', { class: 'card-body flush' }, h('table', { class: 'datatable' }, [
      h('thead', {}, h('tr', {}, cols)),
      h('tbody', {}, d.items.map(t => {
        const k = 'recordType:' + t.name;
        const p = eff(k, rtBase(t));
        const cells = [h('td', { class: 'strong', text: t.label }), h('td', { class: 'muted mono', text: t.name.slice(t.name.indexOf('.') + 1) }), h('td', {}, h('span', { class: 'pill ' + (t.active ? 'ok' : ''), text: t.active ? 'Active' : 'Inactive' })),
          h('td', { class: 'c' }, checkbox({ checked: p.visible, disabled: !ok, edited: edited(k, 'visible'), fid: k + '.visible', aria: 'Assign ' + t.label, onChange: v => toggleRecordType(t, v) }))];
        if (d.profile) cells.push(h('td', { class: 'c' }, h('label', { class: 'radio' + (edited(k, 'default') ? ' edited' : '') }, [
          h('input', { type: 'radio', name: 'rt-default', checked: p.default === true, disabled: !ok, 'data-fid': k + '.default', 'aria-label': 'Default ' + t.label, onchange: () => { lastFocus = k + '.default'; setDefaultRecordType(t); } }),
          h('span', { class: 'dot-radio', 'aria-hidden': 'true' })])));
        return h('tr', { class: pending.has(k) ? 'row-edited' : '' }, cells);
      }))
    ])), d.unavailable ? h('div', { class: 'card-body' }, h('p', { class: 'muted flat', text: 'Groups get record types from their permission sets.' })) : null]);
  }
  function needsNote(od) { return od.objectPermissions !== false && od.fields.some(f => !f.fixed && eff('field:' + f.name, f).read) && !eff('object:' + od.object, od.props).read; }
  function fieldCountText(od) {
    const settable = od.fields.filter(f => !f.fixed);
    const fixed = od.fields.length - settable.length;
    return settable.filter(f => eff('field:' + f.name, f).read).length + ' of ' + settable.length + ' readable' + (fixed ? ' · ' + fixed + ' always visible' : '');
  }
  function shownFields(od) {
    const q = ui.fieldFilter.trim().toLowerCase();
    let fields = od.fields;
    if (q) fields = fields.filter(f => f.label.toLowerCase().includes(q) || f.apiName.toLowerCase().includes(q));
    if (ui.fieldsGranted) fields = fields.filter(f => !f.fixed && (f.read || pending.has('field:' + f.name)));
    return fields;
  }
  function fieldHead(fields, od, ok) {
    const settable = fields.filter(f => !f.fixed);
    const readAll = settable.length && settable.every(f => eff('field:' + f.name, f).read);
    const readSome = settable.some(f => eff('field:' + f.name, f).read);
    const editableFields = settable.filter(f => f.canEdit);
    const editAll = editableFields.length && editableFields.every(f => eff('field:' + f.name, f).edit);
    const editSome = editableFields.some(f => eff('field:' + f.name, f).edit);
    return h('thead', { id: 'fieldHead' }, h('tr', {}, [h('th', { text: 'Field Label' }), h('th', { text: 'API Name' }), h('th', { text: 'Type' }),
      h('th', { class: 'c' }, checkbox({ label: 'Read Access', checked: !!readAll, indeterminate: !readAll && readSome, disabled: !ok || !settable.length, fid: 'all.read', aria: 'Read access for all shown fields', tone: TONE.read,
        onChange: v => bulkFields(settable, od.props, 'read', v) })),
      h('th', { class: 'c' }, checkbox({ label: 'Edit Access', checked: !!editAll, indeterminate: !editAll && editSome, disabled: !ok || !editableFields.length, fid: 'all.edit', aria: 'Edit access for all shown fields', tone: TONE.edit,
        onChange: v => bulkFields(settable, od.props, 'edit', v) }))]));
  }
  function fieldRow(f, od, ok) {
    const k = 'field:' + f.name;
    const p = eff(k, f);
    if (f.fixed) {
      const why = 'Required and system fields can’t have field-level security: everyone with access to ' + od.label + ' can see this field' + (f.edit ? ' and edit it.' : '.');
      return h('tr', { 'data-row': k, class: 'fixed' }, [
        h('td', { class: 'strong' }, [f.label, h('span', { class: 'pill', title: why, text: 'Always visible' })]), h('td', { class: 'muted mono', text: f.apiName }), h('td', {}, h('span', { class: 'type', text: f.type })),
        h('td', { class: 'c' }, checkbox({ checked: true, disabled: true, fid: k + '.read', aria: 'Read ' + f.label + ' (always)', title: why, tone: TONE.read, onChange: () => {} })),
        h('td', { class: 'c' }, checkbox({ checked: !!f.edit, disabled: true, fid: k + '.edit', aria: 'Edit ' + f.label + ' (fixed)', title: why, tone: TONE.edit, onChange: () => {} }))]);
    }
    return h('tr', { class: pending.has(k) ? 'row-edited' : p.read ? '' : 'dim', 'data-row': k }, [
      h('td', { class: 'strong', text: f.label }), h('td', { class: 'muted mono', text: f.apiName }), h('td', {}, h('span', { class: 'type', text: f.type })),
      h('td', { class: 'c' }, checkbox({ checked: p.read, disabled: !ok, edited: edited(k, 'read'), fid: k + '.read', aria: 'Read ' + f.label, tone: TONE.read, onChange: v => toggleField(f, od.props, 'read', v) })),
      h('td', { class: 'c' }, checkbox({ checked: p.edit, disabled: !ok || !f.canEdit, edited: edited(k, 'edit'), fid: k + '.edit', aria: 'Edit ' + f.label, tone: TONE.edit,
        title: f.canEdit ? '' : 'Read-only field: Edit can’t be granted', onChange: v => toggleField(f, od.props, 'edit', v) }))
    ]);
  }

  function systemCard() {
    const d = detail.data;
    const ok = can('user');
    const q = ui.sysFilter.trim().toLowerCase();
    let rows = d.system;
    if (q) rows = rows.filter(s => s.label.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
    if (ui.sysEnabled) rows = rows.filter(s => s.enabled || pending.has('user:' + s.name));
    return h('section', { class: 'card' }, [
      h('div', { class: 'card-head' }, [h('h2', { text: 'System Permissions' }), h('div', { class: 'card-tools' }, [
        searchBox(ui.sysFilter, 'Search permissions', v => { ui.sysFilter = v; renderMain(); }, 'search.system', true),
        toggle('Show only enabled', ui.sysEnabled, v => { ui.sysEnabled = v; save(); renderMain(); })])]),
      h('div', { class: 'card-body flush' }, rows.length ? h('table', { class: 'datatable' }, [
        h('thead', {}, h('tr', {}, [h('th', { class: 'c narrow', text: 'Enabled' }), h('th', { text: 'Permission' }), h('th', { text: 'API Name' })])),
        h('tbody', { id: 'sysBody' }, rows.map(s => sysRow(s, ok)))
      ]) : h('p', { class: 'empty-line', text: 'No permissions match.' }))
    ]);
  }
  function sysRow(s, ok) {
    const k = 'user:' + s.name;
    const on = eff(k, s).enabled;
    return h('tr', { class: pending.has(k) ? 'row-edited' : on ? '' : 'dim', 'data-row': k }, [
      h('td', { class: 'c narrow' }, checkbox({ checked: on, disabled: !ok, edited: edited(k, 'enabled'), fid: k, aria: s.label, onChange: v => toggleSystem(s, v) })),
      h('td', { class: 'strong' }, [s.label, isHighImpact(s) ? h('span', { class: 'pill risk', title: 'Reaches far beyond a single object: review carefully', text: 'High impact' }) : null,
        ui.ruleNote && ui.ruleNote.key === k ? h('span', { class: 'rule-note', role: 'status', text: ui.ruleNote.text }) : null]),
      h('td', { class: 'muted mono', text: s.name })]);
  }

  // ---------- page layouts (profiles) ----------
  function layoutCard() {
    if (!layoutPage || layoutPage.key !== ui.selected || layoutPage.object !== ui.object) {
      layoutPage = { key: ui.selected, object: ui.object, state: 'loading' };
      send({ type: 'loadLayouts', key: ui.selected, object: ui.object });
    }
    if (!layoutPage.data) return loadingCard('Page Layout Assignments', layoutPage, () => { layoutPage = null; renderMain(); }, 'Reading through the Metadata API…');
    const ok = can('layoutAssignment');
    const d = layoutPage.data;
    const opts = d.layouts.map(l => [l.name, l.label]);
    return h('section', { class: 'card' }, [
      h('div', { class: 'card-head' }, [h('h2', { text: 'Page Layout Assignments' }), layoutPage.refreshing ? h('span', { class: 'muted status' }, [spinner(true), ' Refreshing…']) : null]),
      h('div', { class: 'card-body flush' }, h('table', { class: 'datatable' }, [h('thead', {}, h('tr', {}, [h('th', { text: 'Record Type' }), h('th', { text: 'Page Layout' })])),
        h('tbody', {}, d.rows.map(r => {
          const v = eff(r.key, { layout: r.layout }).layout;
          const choices = v && !opts.some(o => o[0] === v) ? opts.concat([[v, v]]) : opts;
          return h('tr', { class: pending.has(r.key) ? 'row-edited' : '' }, [h('td', { class: 'strong', text: r.label }),
            h('td', {}, select((v ? [] : [['', '—']]).concat(choices), v, val => stage(r.key, { layout: r.layout }, { layout: val }, 'layout', r.label + ' layout', 'layoutAssignment'), !ok, r.key, 'Layout for ' + r.label))]);
        }))]))
    ]);
  }

  // ---------- tool pages ----------
  function openTool(t) {
    guard(() => {
      ui.tool = t;
      if (t === 'history') { historyData = null; send({ type: 'history' }); }
      if ((t === 'lookup' || t === 'wizard' || t === 'objwizard') && catalog === null) { catalog = 'loading'; send({ type: 'objectCatalog' }); }
      renderMain(); renderTop(); main.scrollTop = 0;
    });
  }
  function closeTool() { ui.tool = null; renderMain(); renderTop(); }
  function toolPage() {
    const back = h('button', { class: 'link', onclick: closeTool, text: ui.selected ? '‹ Back to the record' : '‹ Back' });
    const body = ui.tool === 'lookup' ? lookupPage() : ui.tool === 'wizard' ? wizardPage() : ui.tool === 'objwizard' ? objWizardPage() : historyPage();
    const titles = { lookup: ['Find access', 'Who can see or change an object or field, and through what.'], wizard: ['Grant field access', 'Give one or more fields Read or Edit access across several permission sets and profiles at once.'],
      objwizard: ['Grant object access', 'Give object permissions and record types to several permission sets and profiles at once.'],
      history: ['Save history', 'Every save made with Permission Studio in this project, newest first.'] };
    return h('div', { class: 'tool' }, [h('div', { class: 'page-header' }, [back, h('div', { class: 'ph-title tool-title' }, [h('h1', { text: titles[ui.tool][0] })]), h('p', { class: 'muted flat', text: titles[ui.tool][1] })]),
      h('div', { class: 'tab-body' }, body)]);
  }
  function objectPicker(value, onPick, fid, objectPermsOnly) {
    const list = (Array.isArray(catalog) ? catalog : []).filter(o => !objectPermsOnly || o.objectPerms !== false);
    const id = 'objects-' + fid;
    return h('div', { class: 'picker' }, [
      h('input', { type: 'text', class: 'text', list: id, value, placeholder: catalog === 'loading' ? 'Loading objects…' : 'Object API name, e.g. Lead', 'data-fid': fid, 'aria-label': 'Object',
        onchange: e => { lastFocus = fid; onPick(e.target.value.trim()); } }),
      h('datalist', { id }, list.map(o => h('option', { value: o.name, text: o.label })))]);
  }

  function lookupPage() {
    if (lookup.revoke && (lookup.revoke.plan || lookup.revoke.results || lookup.revoke.busy)) {
      if (lookup.revoke.busy) return [h('div', { class: 'loading-block' }, [spinner(), h('p', { class: 'muted', text: 'Working out what to remove…' })])];
      const back = () => { lookup.revoke = null; rerunLookup(); };
      return [h('h2', { class: 'sub-title', text: 'Remove access from selected sources' })].concat(planView(lookup.revoke, 'wizardApply', {}, { target: 'revoke', onDone: back, onBack: () => { lookup.revoke = null; renderMain(); }, saveLabel: 'Remove' }));
    }
    const mode = lookup.mode || 'access';
    const modeBar = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'What to look up' }, [['access', 'Object or field'], ['system', 'System permission'], ['custom', 'Custom permission']].map(([m, label]) =>
      h('button', { class: mode === m ? 'on' : '', role: 'radio', 'aria-checked': String(mode === m),
        onclick: () => { lookup.mode = m; lookup.result = null; lookup.sel = new Set(); if (m !== 'access' && !lookupOptions) { lookupOptions = 'loading'; send({ type: 'lookupOptions' }); } renderMain(); }, text: label })));
    const out = [h('div', { class: 'lk-bar' }, [h('div', { class: 'fld' }, [h('span', { text: 'Look up' }), modeBar])].concat(mode === 'access' ? accessInputs() : permissionInputs(mode === 'system'))
      .concat([recentLookups.length ? h('div', { class: 'lk-recent' }, ['Recent: '].concat(recentLookups.slice(0, 5).flatMap((r, i) => [i ? ' · ' : '', h('button', { class: 'link', onclick: () => runRecent(r), text: r.label })]))) : null]))];
    if (lookup.busy) out.push(h('div', { class: 'loading-block' }, [spinner(), h('p', { class: 'muted', text: 'Checking permission sets, profiles, groups and assignments…' })]));
    const r = lookup.result;
    if (r && r.error) out.push(alertBox('error', r.error));
    if (r && !r.error && (r.object || r.permission)) out.push(...lookupResults(r));
    return out;
  }

  function parseTarget(v) {
    const t = String(v || '').trim();
    const list = Array.isArray(catalog) ? catalog : [];
    const objPart = t.includes('.') ? t.slice(0, t.indexOf('.')) : t;
    const obj = list.find(o => o.name.toLowerCase() === objPart.toLowerCase()) || (!t.includes('.') && list.find(o => o.label.toLowerCase() === t.toLowerCase()));
    if (!obj) return { object: '', field: '' };
    if (!t.includes('.')) return { object: obj.name, field: '' };
    const fp = t.slice(t.indexOf('.') + 1).toLowerCase();
    const fld = (lookup.fieldsFor === obj.name && lookup.fields || []).find(f => f.apiName.toLowerCase() === fp || f.label.toLowerCase() === fp);
    return { object: obj.name, field: fld ? fld.apiName : '', pendingField: !fld && fp ? fp : '' };
  }
  function accessInputs() {
    if (catalog === null) { catalog = 'loading'; send({ type: 'objectCatalog' }); }
    const t = parseTarget(lookup.target);
    if (t.object && lookup.fieldsFor !== t.object && t.pendingField !== undefined) { lookup.fieldsFor = t.object; lookup.fields = null; lookup.object = t.object; send({ type: 'wizardFields', object: t.object }); }
    const levels = t.field ? [['read', 'Read'], ['edit', 'Edit']] : [['read', 'Read'], ['create', 'Create'], ['edit', 'Edit'], ['delete', 'Delete'], ['viewAll', 'View All'], ['modifyAll', 'Modify All']];
    if (!levels.some(l => l[0] === lookup.level)) lookup.level = 'read';
    const options = (Array.isArray(catalog) ? catalog : []).map(o => h('option', { value: o.name, label: o.label }))
      .concat(t.object && lookup.fieldsFor === t.object ? (lookup.fields || []).map(f => h('option', { value: t.object + '.' + f.apiName, label: f.label })) : []);
    const find = () => {
      const x = parseTarget(lookup.target);
      if (!x.object) return;
      lookup.object = x.object; lookup.field = x.field;
      lookup.busy = true; lookup.result = null; lookup.why = new Set(); lookup.sel = new Set(); renderMain();
      send({ type: 'lookup', object: x.object, field: x.field || null, level: lookup.level });
      addRecent({ mode: 'access', object: x.object, field: x.field, level: lookup.level, label: x.object + (x.field ? '.' + x.field : '') + (lookup.level !== 'read' ? ' (' + (SHORT[lookup.level] || lookup.level) + ')' : '') });
    };
    return [h('label', { class: 'fld grow' }, [h('span', { text: 'Object or field' }), h('input', { type: 'text', class: 'text', list: 'lk-targets', value: lookup.target || '', 'data-fid': 'lk.target',
        placeholder: 'Lead, or Lead.Rating', autocomplete: 'off', oninput: e => { lookup.target = e.target.value; const y = parseTarget(lookup.target); if (y.object && lookup.fieldsFor !== y.object) { lookup.fieldsFor = y.object; lookup.fields = null; send({ type: 'wizardFields', object: y.object }); } },
        onchange: () => renderMain(), onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); find(); } } }), h('datalist', { id: 'lk-targets' }, options)]),
      h('label', { class: 'fld' }, [h('span', { text: 'Access' }), select(levels, lookup.level, v => { lookup.level = v; renderMain(); }, false, 'lk.level', 'Access')]),
      h('button', { class: 'btn brand', disabled: lookup.busy || !t.object, onclick: find, text: lookup.busy ? 'Looking…' : 'Find' })];
  }
  function permissionInputs(sys) {
    if (!lookupOptions || !lookupOptions.ready) return [lookupOptions && lookupOptions.message ? alertBox('error', lookupOptions.message) : spinner(true)];
    const opts = sys ? lookupOptions.system : lookupOptions.custom;
    const high = sys ? opts.filter(isHighImpact) : [];
    const rest = sys ? opts.filter(o => !isHighImpact(o)) : opts;
    const value = sys ? lookup.sysName || '' : lookup.customId || '';
    const sel = h('select', { class: 'select', 'aria-label': sys ? 'System permission' : 'Custom permission', 'data-fid': 'lk.perm', onchange: e => { if (sys) lookup.sysName = e.target.value; else lookup.customId = e.target.value; renderMain(); } },
      [h('option', { value: '', text: sys ? 'Choose a system permission' : (opts.length ? 'Choose a custom permission' : 'This org has no custom permissions') })]
        .concat(high.length ? [h('optgroup', { label: 'High impact' }, high.map(o => h('option', { value: o.name, selected: value === o.name, text: o.label })))] : [])
        .concat([h('optgroup', { label: sys ? 'All system permissions' : 'Custom permissions' }, rest.map(o => h('option', { value: sys ? o.name : o.id, selected: value === (sys ? o.name : o.id), text: o.label + (sys ? '' : ' (' + o.name + ')') })))]));
    const chosen = opts.find(o => (sys ? o.name : o.id) === value);
    return [h('label', { class: 'fld grow' }, [h('span', { text: sys ? 'System permission' : 'Custom permission' }), sel]),
      h('button', { class: 'btn brand', disabled: !chosen || lookup.busy, onclick: () => {
        lookup.busy = true; lookup.result = null; lookup.why = new Set(); lookup.sel = new Set(); renderMain();
        send(sys ? { type: 'lookupPermission', kind: 'system', name: chosen.name, label: chosen.label } : { type: 'lookupPermission', kind: 'custom', id: chosen.id, label: chosen.label });
        addRecent(sys ? { mode: 'system', sysName: chosen.name, label: chosen.label } : { mode: 'custom', customId: chosen.id, label: chosen.label }); }, text: lookup.busy ? 'Looking…' : 'Find' })];
  }
  function addRecent(r) {
    recentLookups = [r].concat(recentLookups.filter(x => x.label !== r.label)).slice(0, 8);
    send({ type: 'persist', name: 'recentLookups', value: recentLookups });
  }
  function runRecent(r) {
    lookup.mode = r.mode; lookup.why = new Set(); lookup.sel = new Set(); lookup.result = null;
    if (r.mode === 'access') { lookup.target = r.object + (r.field ? '.' + r.field : ''); lookup.object = r.object; lookup.field = r.field || ''; lookup.level = r.level || 'read';
      lookup.busy = true; send({ type: 'lookup', object: r.object, field: r.field || null, level: lookup.level }); }
    else { if (r.mode === 'system') lookup.sysName = r.sysName; else lookup.customId = r.customId;
      if (!lookupOptions) { lookupOptions = 'loading'; send({ type: 'lookupOptions' }); }
      lookup.busy = true; send(r.mode === 'system' ? { type: 'lookupPermission', kind: 'system', name: r.sysName, label: r.label } : { type: 'lookupPermission', kind: 'custom', id: r.customId, label: r.label }); }
    addRecent(r); renderMain();
  }
  function rerunLookup() {
    const r = recentLookups[0];
    if (r) runRecent(r); else renderMain();
  }

  /** Results: filters as chips, users with who-and-why, an at-a-glance panel and the sources with next steps. */
  function lookupResults(r) {
    const out = [];
    for (const x of r.sources) { x.objectVia = x.objectVia || []; x.fieldVia = x.fieldVia || []; }
    for (const u of (r.users || []).concat(r.inactive || [], r.partial || [])) { u.objectFrom = u.objectFrom || []; u.fieldFrom = u.fieldFrom || []; }
    const perm = !!r.permission;
    const byId = new Map(r.sources.map(x => [x.permissionSetId, x]));
    const what = perm ? r.permission.label : (SHORT[r.level] || r.level) + ' on ' + r.object + (r.field ? '.' + r.field.split('.').pop() : '');
    if (r.fieldOnly) out.push(alertBox('info', 'Salesforce has no object permissions for ' + r.object + ', so this shows field access only.' + (/^(Task|Event)$/.test(r.object) ? ' Activity access itself comes from the Edit Tasks and Edit Events system permissions.' : '')));
    const f = lookup.f;
    const base = f.show === 'partial' && r.partial ? r.partial : f.users === 'inactive' ? r.inactive || [] : f.users === 'all' ? r.users.concat(r.inactive || []) : r.users;
    const kindsOf = u => new Set(u.objectFrom.concat(u.fieldFrom).map(id => (byId.get(id) || {}).kind));
    const profiles = [...new Set(r.users.concat(r.inactive || []).map(u => u.profile).filter(Boolean))].sort();
    const licenses = [...new Set(r.users.concat(r.inactive || []).map(u => u.license).filter(Boolean))].sort();
    const q = f.q.trim().toLowerCase();
    const users = base.filter(u => (f.through === 'any' || kindsOf(u).has(f.through)) && (f.profile === 'any' || u.profile === f.profile) && (f.license === 'any' || u.license === f.license) &&
      (!q || (u.name + ' ' + u.username).toLowerCase().includes(q)));
    const set = (k, v) => { lookup.f[k] = v; renderMain(); };
    out.push(h('div', { class: 'filters' }, [h('span', { class: 'muted small', text: 'Filter' }),
      filterChip('Granted through', f.through, [['any', 'Any'], ['permissionSet', 'Permission set'], ['profile', 'Profile'], ['group', 'Group']], v => set('through', v), 'any'),
      filterChip('Profile', f.profile, [['any', 'Any']].concat(profiles.map(p => [p, p])), v => set('profile', v), 'any'),
      filterChip('License', f.license, [['any', 'Any']].concat(licenses.map(l => [l, l])), v => set('license', v), 'any'),
      filterChip('Users', f.users, [['active', 'Active'], ['inactive', 'Inactive'], ['all', 'All']], v => set('users', v), 'active'),
      !perm && r.field ? filterChip('Show', f.show, [['full', 'full access'], ['partial', 'only half of it']], v => set('show', v), 'full') : null,
      h('div', { class: 'grow' }), searchBox(f.q, 'Search users', v => set('q', v), 'lk.users', true)]));
    const grants = src => {
      const g = [];
      if (perm) g.push(chip('+', r.permission.label));
      for (const v of src.objectVia) g.push(v === 'object' ? chip('+', (SHORT[r.level] || r.level) + ' on ' + r.object) : v === 'system' || v === 'custom' ? null : chip('+', { ModifyAllData: 'Modify All Data', ViewAllData: 'View All Data' }[v] || v));
      for (const v of src.fieldVia) g.push(v === 'field' ? chip('+', (SHORT[r.level] || r.level) + ' on ' + r.field) : chip('+', v === 'ViewAllFields' ? 'View All Fields' : v));
      return g.filter(Boolean);
    };
    const pathFor = u => {
      const parts = [h('b', { text: 'How ' + u.name.split(' ')[0] + ' gets ' + what + ':' })];
      [...new Set(u.objectFrom.concat(u.fieldFrom))].forEach((id, i) => {
        const src = byId.get(id);
        if (!src) return;
        if (i) parts.push(h('span', { class: 'arrow', text: 'and' }));
        parts.push(srcChip(src));
        if (src.includes && src.includes.length) { parts.push(h('span', { class: 'arrow', text: '→ includes' })); src.includes.forEach(l => parts.push(h('span', { class: 'src ps', text: l }))); }
        parts.push(h('span', { class: 'arrow', text: '→' }));
        parts.push(...grants(src));
      });
      return h('div', { class: 'path' }, parts);
    };
    const chips = ids => ids.map(id => srcChip(byId.get(id)));
    const cols = perm ? ['User', 'Profile', 'Granted by', ''] : r.field ? ['User', 'Profile', 'Object access from', 'Field access from', ''] : ['User', 'Profile', 'Access from', ''];
    const rows = [];
    for (const u of users) {
      const open = lookup.why.has(u.userId);
      rows.push(h('tr', { class: open ? 'why' : '' }, [
        h('td', {}, [h('b', { text: u.name }), u.active === false ? h('span', { class: 'pill', text: 'Inactive' }) : null, h('div', { class: 'cur', text: u.username })]),
        h('td', { class: 'muted', text: u.profile })].concat(perm || !r.field ? [h('td', { class: 'wrap' }, chips(u.objectFrom))] : [h('td', { class: 'wrap' }, chips(u.objectFrom)), h('td', { class: 'wrap' }, chips(u.fieldFrom))])
        .concat([h('td', { class: 'c narrow' }, h('button', { class: 'link', onclick: () => { if (open) lookup.why.delete(u.userId); else lookup.why.add(u.userId); renderMain(); }, text: open ? 'Hide' : 'Why?' }))])));
      if (open) rows.push(h('tr', { class: 'why' }, h('td', { colspan: String(cols.length) }, pathFor(u))));
    }
    const usersCard = h('section', { class: 'card' }, [h('div', { class: 'card-head' }, [h('h2', {}, ['Users ', h('span', { class: 'count', text: users.length === base.length ? String(users.length) : users.length + ' of ' + base.length })]),
      h('div', { class: 'card-tools' }, h('button', { class: 'btn neutral small', disabled: !users.length, onclick: () => send({ type: 'copy', text: users.map(u => [u.name, u.username, u.profile].join('\t')).join('\n') }), text: 'Copy list' }))]),
      h('div', { class: 'card-body flush' }, users.length ? h('table', { class: 'datatable' }, [h('thead', {}, h('tr', {}, cols.map(c => h('th', { text: c })))), h('tbody', {}, rows)])
        : h('p', { class: 'empty-line', text: base.length ? 'No users match these filters.' : 'No ' + (f.users === 'inactive' ? 'inactive' : 'active') + ' user has this.' })),
      !perm && r.partial && r.partial.length && f.show !== 'partial' ? h('div', { class: 'card-body' }, h('button', { class: 'link', onclick: () => set('show', 'partial'), text: '▸ ' + r.partial.length + (r.partial.length === 1 ? ' more user has' : ' more users have') + ' only half of it (object or field access, not both)' })) : null]);
    // at a glance
    const kinds = { permissionSet: 0, profile: 0, group: 0 };
    for (const x of r.sources) if (x.users || x.kind !== 'permissionSet') kinds[x.kind]++;
    const total = kinds.permissionSet + kinds.profile + kinds.group || 1;
    const sysOnly = r.users.filter(u => u.objectFrom.length && u.objectFrom.every(id => { const x = byId.get(id); return x && x.objectVia.every(v => v === 'ModifyAllData' || v === 'ViewAllData'); }));
    const glance = h('section', { class: 'card' }, [h('div', { class: 'card-head' }, h('h2', { text: 'At a glance' })), h('div', { class: 'card-body' }, [
      h('div', { class: 'big-num' }, [h('b', { text: String(r.users.length) }), ' ' + (r.users.length === 1 ? 'active user has ' : 'active users have ') + what,
        perm && isHighImpact({ name: r.permission.name, label: r.permission.label }) ? h('span', { class: 'rv-risk', text: 'High impact' }) : null]),
      h('div', { class: 'mix', 'aria-hidden': 'true' }, [['permissionSet', '--vscode-charts-blue'], ['profile', '--vscode-charts-green'], ['group', '--vscode-charts-purple']].map(([k, c]) => h('i', { style: 'width:' + (kinds[k] / total * 100) + '%;background:var(' + c + ')' }))),
      h('div', { class: 'legend2' }, [h('span', { class: 'lg ps', text: kinds.permissionSet + (kinds.permissionSet === 1 ? ' permission set' : ' permission sets') }), h('span', { class: 'lg pr', text: kinds.profile + (kinds.profile === 1 ? ' profile' : ' profiles') }),
        h('span', { class: 'lg gr', text: kinds.group + (kinds.group === 1 ? ' group' : ' groups') })]),
      sysOnly.length ? h('p', { class: 'muted small', text: sysOnly.length + (sysOnly.length === 1 ? ' user gets' : ' users get') + ' it only through Modify All Data or View All Data.' }) : null])]);
    // sources, with next steps
    const selectable = x => !!x.key && !perm;
    const srcRows = r.sources.map(x => h('tr', { class: lookup.sel.has(x.key) ? 'row-edited' : '' }, [
      !perm ? h('td', { class: 'c narrow' }, selectable(x) ? checkbox({ checked: lookup.sel.has(x.key), fid: 'lksrc.' + x.permissionSetId, aria: 'Select ' + x.label, onChange: v => { if (v) lookup.sel.add(x.key); else lookup.sel.delete(x.key); renderMain(); } }) : null) : null,
      h('td', {}, [srcChip(x), !perm && r.field && !x.fieldVia.length ? h('span', { class: 'muted small', text: ' object only' }) : null,
        x.objectVia.some(v => v === 'ModifyAllData' || v === 'ViewAllData') ? h('span', { class: 'rv-risk', text: x.objectVia.includes('ModifyAllData') ? 'Modify All Data' : 'View All Data' }) : null]),
      h('td', { class: 'c', text: String(x.users) })].filter(Boolean)));
    const sourcesCard = h('section', { class: 'card' }, [h('div', { class: 'card-head' }, [h('h2', { text: 'Sources' }), h('span', { class: 'muted small', text: 'users' })]),
      h('div', { class: 'card-body flush' }, r.sources.length ? h('table', { class: 'datatable' }, h('tbody', {}, srcRows)) : h('p', { class: 'empty-line', text: 'Nothing grants this.' })),
      !perm && r.sources.length ? h('div', { class: 'card-body btns' }, [
        h('button', { class: 'btn neutral small', disabled: !lookup.sel.size, onclick: () => { lookup.revoke = { busy: true }; applyTarget = 'revoke'; renderMain();
          send({ type: 'revokePlan', object: r.object, field: r.field || null, level: r.level, sourceKeys: [...lookup.sel] }); }, text: 'Remove from selected…' }),
        h('button', { class: 'btn neutral small', onclick: () => grantMore(r), text: 'Grant to more…' })]) : null]);
    out.push(h('div', { class: 'lk-cols' }, [h('div', {}, usersCard), h('div', { class: 'lk-side' }, [glance, sourcesCard])]));
    return out;
  }
  /** "Grant to more…": the matching grant screen, with the object, field and access already chosen. */
  function grantMore(r) {
    if (r.field) {
      Object.assign(wizard, { object: r.object, fields: null, chosen: new Set([r.object + '.' + r.field.split('.').pop()]), level: r.level === 'edit' ? 'edit' : 'read', targets: new Set(), plan: null, results: null, currentSig: '' });
      send({ type: 'wizardFields', object: r.object });
      ui.tool = 'wizard';
    } else {
      Object.assign(objWizard, { object: r.object, info: null, adds: new Map(), plan: null, results: null, currentFor: '' });
      send({ type: 'objWizardInfo', object: r.object });
      ui.tool = 'objwizard';
    }
    renderTop(); renderMain();
  }

  function steps(list) {
    const first = list.findIndex(x => !x.done);
    return h('div', { class: 'steps' }, list.map((x, i) => h('div', { class: x.done ? 'done' : i === first ? 'on' : '' }, [h('b', { text: x.title }), x.text])));
  }
  /** Who can be granted: unmanaged permission sets and custom profiles (others listed, locked). */
  function grantCandidates(w) {
    const all = ((lists && lists.permissionSet) || []).concat((lists && lists.profile) || []);
    const q = (w.targetFilter || '').trim().toLowerCase();
    return all.filter(r => (w.types === 'all' || r.kind === w.types) && (!q || r.label.toLowerCase().includes(q) || r.apiName.toLowerCase().includes(q)));
  }
  const accessWords = p => p && p.read ? (p.edit ? 'Read, Edit' : 'Read') : 'No access';
  function wizardPage() {
    const w = wizard;
    if (w.results || w.plan) return planView(w, 'wizardApply', { chosen: new Set() });
    const fields = w.fields || [];
    const chosen = fields.filter(f => w.chosen.has(f.name));
    const sig = w.object + '|' + [...w.chosen].sort().join(',');
    if (w.object && w.chosen.size && w.currentSig !== sig) { w.currentSig = sig; w.current = null; send({ type: 'wizardCurrent', object: w.object, fields: [...w.chosen] }); }
    const cur = key => (w.current && w.current.byKey && w.current.byKey[key]) || null;
    const want = f => ({ read: true, edit: w.level === 'edit' && f.canEdit });
    const missing = (key, f) => { const c = ((cur(key) || {}).fields || {})[f.name] || { read: false, edit: false }; const n = want(f); return { read: n.read && !c.read, edit: n.edit && !c.edit }; };
    const hasAll = key => chosen.every(f => { const m = missing(key, f); return !m.read && !m.edit; });
    const editable = r => !r.managed && !(r.kind === 'profile' && r.standard);
    const targets = [...w.targets];
    let changes = 0, inPlace = 0, reach = 0, noRead = 0;
    for (const k of targets) {
      for (const f of chosen) { const m = missing(k, f); if (m.read || m.edit) changes++; else inPlace++; }
      const c = cur(k); if (c) { reach += c.users || 0; if (!c.objectRead) noRead++; }
    }
    const out = [steps([{ title: 'What', text: chosen.length ? chosen.length + (chosen.length === 1 ? ' field' : ' fields') + ' on ' + w.object : 'Pick fields', done: !!chosen.length },
      { title: 'Access', text: w.level === 'edit' ? 'Read and Edit' : 'Read', done: !!chosen.length },
      { title: 'Who', text: targets.length + ' selected', done: !!targets.length },
      { title: 'Review and save', text: changes + (changes === 1 ? ' change' : ' changes'), done: false }])];
    // 1. fields
    const q = w.filter.trim().toLowerCase();
    let shownFields = fields.filter(f => !q || f.label.toLowerCase().includes(q) || f.apiName.toLowerCase().includes(q));
    if (w.customOnly && !q) shownFields = shownFields.filter(f => f.custom || w.chosen.has(f.name));
    const left = [h('section', { class: 'card' }, [h('div', { class: 'card-head' }, [h('h2', { text: '1. Fields' }), h('div', { class: 'card-tools' }, [
      grantTemplates.length ? select([['', 'Templates']].concat(grantTemplates.map((t, i) => [String(i), t.name])), '', v => { if (v === '') return; const t = grantTemplates[Number(v)];
        Object.assign(w, { object: t.object, fields: null, chosen: new Set(t.fields), level: t.level, grantObject: t.grantObject !== false, targets: new Set(t.targets || []), currentSig: '' });
        send({ type: 'wizardFields', object: t.object }); renderMain(); }, false, 'wz.tpl', 'Templates') : null,
      objectPicker(w.object, v => { w.object = v; w.fields = null; w.chosen = new Set(); if (v) send({ type: 'wizardFields', object: v }); renderMain(); }, 'wz.obj'),
      w.object ? searchBox(w.filter, 'Search fields', v => { w.filter = v; renderMain(); }, 'wz.filter', true) : null,
      w.object ? toggle('Custom fields only', w.customOnly, v => { w.customOnly = v; renderMain(); }) : null])]),
      h('div', { class: 'card-body flush scroll-y short' }, !w.object ? h('p', { class: 'empty-line', text: 'Pick an object first.' }) : !w.fields ? h('div', { class: 'loading-block' }, spinner())
        : shownFields.length ? h('table', { class: 'datatable' }, [h('thead', {}, h('tr', {}, [h('th', { class: 'c narrow', text: 'Grant' }), h('th', { text: 'Field' }), h('th', { text: 'API Name' }), h('th', { text: 'Type' })])),
          h('tbody', {}, shownFields.map(f => h('tr', { class: w.chosen.has(f.name) ? 'row-edited' : '' }, [h('td', { class: 'c narrow' }, checkbox({ checked: w.chosen.has(f.name), fid: 'wz.' + f.name, aria: f.label,
            onChange: v => { if (v) w.chosen.add(f.name); else w.chosen.delete(f.name); renderMain(); } })), h('td', { class: 'strong', text: f.label }), h('td', { class: 'muted mono', text: f.apiName }),
            h('td', {}, h('span', { class: 'type', text: f.type + (f.canEdit ? '' : ' · read-only') }))])))]) : h('p', { class: 'empty-line', text: 'No fields match.' }))]),
      h('section', { class: 'card' }, [h('div', { class: 'card-head' }, h('h2', { text: '2. Access' })), h('div', { class: 'card-body form-row' }, [
        h('label', { class: 'radio-line' }, [h('input', { type: 'radio', name: 'wzlevel', checked: w.level === 'read', onchange: () => { w.level = 'read'; renderMain(); } }), ' Read only']),
        h('label', { class: 'radio-line' }, [h('input', { type: 'radio', name: 'wzlevel', checked: w.level === 'edit', onchange: () => { w.level = 'edit'; renderMain(); } }), ' Read and Edit'])])])];
    // 3. who, with what each has now and what changes
    const cands = grantCandidates(w).filter(r => !w.hideHave || !chosen.length || !w.current || !hasAll(r.key) || w.targets.has(r.key));
    const shownCols = chosen.slice(0, 3);
    const selectableShown = cands.filter(editable);
    const allOn = selectableShown.length && selectableShown.every(r => w.targets.has(r.key));
    const someOn = selectableShown.some(r => w.targets.has(r.key));
    left.push(h('section', { class: 'card' }, [h('div', { class: 'card-head' }, [h('h2', {}, ['3. Grant to ', h('span', { class: 'count', text: targets.length + ' selected' })]), h('div', { class: 'card-tools' }, [
      h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Show' }, [['all', 'All'], ['permissionSet', 'Permission sets'], ['profile', 'Profiles']].map(([v, t]) => h('button', { class: w.types === v ? 'on' : '', role: 'radio', 'aria-checked': String(w.types === v), onclick: () => { w.types = v; renderMain(); }, text: t }))),
      toggle('Hide those that have it', w.hideHave, v => { w.hideHave = v; renderMain(); }),
      searchBox(w.targetFilter, 'Search', v => { w.targetFilter = v; renderMain(); }, 'wz.tg', true),
      h('button', { class: 'btn neutral small', onclick: () => { for (const r of grantCandidates(Object.assign({}, w, { types: 'all', targetFilter: '' }))) if (editable(r) && favs.items.has(favId(r))) w.targets.add(r.key); renderMain(); }, text: 'Add favorites' })])]),
      h('div', { class: 'card-body flush scroll-y' }, h('table', { class: 'datatable' }, [h('thead', {}, h('tr', {}, [
        h('th', { class: 'c narrow' }, checkbox({ checked: !!allOn, indeterminate: !allOn && someOn, fid: 'wz.all', aria: 'Select all shown', onChange: v => { for (const r of selectableShown) { if (v) w.targets.add(r.key); else w.targets.delete(r.key); } renderMain(); } })),
        h('th', { text: 'Name' })].concat(shownCols.map(f => h('th', { text: f.label + ' now' })), chosen.length > 3 ? [h('th', { text: 'Others now' })] : [], [h('th', { text: 'After saving' })]))),
        h('tbody', {}, cands.slice(0, 400).map(r => {
          const c = cur(r.key);
          const on = w.targets.has(r.key);
          const ok = editable(r);
          const afterCells = !on || !c ? (on ? [h('span', { class: 'muted small', text: chosen.length ? 'Checking…' : '' })] : [h('span', { class: 'muted', text: '—' })])
            : chosen.map(f => { const m = missing(r.key, f); return m.read || m.edit ? chip('+', [m.read ? 'Read' : null, m.edit ? 'Edit' : null].filter(Boolean).join(', '), f.label) : h('span', { class: 'muted small', text: 'has ' + f.label + ' ' }); });
          return h('tr', { class: on ? 'row-edited' : ok ? '' : 'dim' }, [
            h('td', { class: 'c narrow' }, ok ? checkbox({ checked: on, fid: 'tgt.' + r.key, aria: r.label, onChange: v => { if (v) w.targets.add(r.key); else w.targets.delete(r.key); renderMain(); } }) : null),
            h('td', {}, [h('b', { text: r.label }), favs.items.has(favId(r)) ? h('span', { class: 'pill', text: 'Favorite' }) : null, r.managed ? h('span', { class: 'pill', text: 'Managed' }) : null,
              h('div', { class: 'cur', text: ok ? SRC_TYPE[r.kind] + (c ? ' · ' + c.users + (c.users === 1 ? ' user' : ' users') : '') : 'Can’t be changed' })])]
            .concat(shownCols.map(f => h('td', { class: 'cur', text: c ? accessWords((c.fields || {})[f.name]) : '…' })),
              chosen.length > 3 ? [h('td', { class: 'cur', text: c ? chosen.slice(3).filter(f => ((c.fields || {})[f.name] || {}).read).length + ' of ' + (chosen.length - 3) + ' readable' : '…' })] : [],
              [h('td', { class: 'wrap' }, afterCells)]));
        }))]))]));
    // summary
    const nPs = targets.filter(k => k.startsWith('permissionSet:')).length;
    const nPr = targets.length - nPs;
    const side = h('aside', { class: 'card grant-sum' }, [h('div', { class: 'card-head' }, h('h2', { text: 'You’re granting' })), h('div', { class: 'card-body' }, [
      chosen.length ? h('p', {}, [h('b', { text: w.level === 'edit' ? 'Read and Edit' : 'Read' }), ' on ', h('b', { text: chosen.map(f => f.label).join(', ') }), ' (' + w.object + ')']) : h('p', { class: 'muted', text: 'Pick fields on the left.' }),
      h('div', { class: 'k', text: 'To' }), h('p', {}, targets.length ? [nPs + (nPs === 1 ? ' permission set' : ' permission sets') + (nPr ? ' and ' + nPr + (nPr === 1 ? ' profile' : ' profiles') : '')]
        .concat(w.current ? [', reaching up to ', h('b', { text: String(reach) }), ' users'] : []) : 'Nobody yet'),
      h('div', { class: 'k', text: 'Also' }),
      checkbox({ checked: w.grantObject, fid: 'wz.obj.grant', label: 'Grant ' + (w.level === 'edit' ? 'Read and Edit' : 'Read') + ' on ' + (w.object || 'the object') + ' where it’s missing' + (w.current && targets.length ? ' (' + noRead + (noRead === 1 ? ' item)' : ' items)') : ''), onChange: v => { w.grantObject = v; renderMain(); } }),
      h('div', { class: 'k', text: 'Changes' }), h('p', { text: w.current ? changes + ' field ' + (changes === 1 ? 'change' : 'changes') + (inPlace ? ', ' + inPlace + ' already in place' : '') : chosen.length && targets.length ? 'Checking current access…' : '—' }),
      h('div', { class: 'btns' }, [h('button', { class: 'btn brand', disabled: !chosen.length || !targets.length || w.busy,
        onclick: () => { w.busy = true; renderMain(); send({ type: 'wizardPlan', object: w.object, fields: chosen, targets, level: w.level, grantObject: w.grantObject }); },
        text: w.busy ? 'Working out the changes…' : 'Review ' + (w.current ? changes + (changes === 1 ? ' change' : ' changes') : 'changes') })]),
      w.templateName === null ? h('button', { class: 'link small', disabled: !chosen.length, onclick: () => { w.templateName = ''; renderMain(); }, text: 'Save these choices as a template' })
        : h('div', { class: 'form-row' }, [h('input', { type: 'text', class: 'text', placeholder: 'Template name', value: w.templateName, 'data-fid': 'wz.tplname', oninput: e => { w.templateName = e.target.value; } }),
          h('button', { class: 'btn neutral small', onclick: () => { const n = (w.templateName || '').trim(); if (!n) return;
            grantTemplates = grantTemplates.filter(t => t.name !== n).concat([{ name: n, object: w.object, fields: [...w.chosen], level: w.level, grantObject: w.grantObject, targets }]);
            send({ type: 'persist', name: 'grantTemplates', value: grantTemplates }); w.templateName = null; toast('success', 'Saved the template “' + n + '”.', { title: 'Template' }); renderMain(); }, text: 'Save' })])])]);
    out.push(h('div', { class: 'grant-cols' }, [h('div', { class: 'grant-main' }, left), side]));
    return out;
  }
  /** Plan review, progress and results, shared by both wizards. */
  function planView(w, applyType, resetTo, opts) {
    const o = opts || {};
    const out = [];
    if (w.results) {
      const ok = w.results.filter(r => r.status === 'saved').length;
      out.push(alertBox(ok === w.results.length ? 'info' : 'warning', ok + ' of ' + w.results.length + ' saved.'));
      out.push(h('section', { class: 'card' }, h('div', { class: 'card-body flush' }, h('table', { class: 'datatable' }, [h('thead', {}, h('tr', {}, [h('th', { text: 'Item' }), h('th', { text: 'Result' })])),
        h('tbody', {}, w.results.map(r => h('tr', {}, [h('td', { class: 'strong', text: r.label }), h('td', { class: 'wrap', text: r.status === 'saved' ? r.count + ' change' + (r.count === 1 ? '' : 's') + ' saved' : r.message })])))]))));
      out.push(h('div', { class: 'btns' }, o.onDone ? [h('button', { class: 'btn brand', onclick: o.onDone, text: 'Back to results' })] : [h('button', { class: 'btn brand', onclick: () => { Object.assign(w, resetTo, { plan: null, results: null, confirm: '' }); renderMain(); }, text: 'Grant more' }),
        h('button', { class: 'btn neutral', onclick: closeTool, text: 'Done' })]));
      return out;
    }
    const total = w.plan.plan ? w.plan.plan.reduce((n, t) => n + t.changes.length, 0) : 0;
    const deploys = w.plan.plan ? w.plan.plan.some(t => t.changes.some(c => c.key.startsWith('recordType:'))) : false;
    out.push(w.plan.error ? alertBox('error', w.plan.error) : h('p', { text: total + ' change' + (total === 1 ? '' : 's') + ' across ' + w.plan.plan.length + ' item' + (w.plan.plan.length === 1 ? '' : 's') + '. Each item is saved on its own, with its own snapshot.' }));
    if (w.plan.plan && w.plan.plan.length) {
      out.push(h('div', { class: 'rv-scroll' }, h('table', { class: 'rv-table' }, [h('thead', {}, h('tr', {}, [h('th', { text: 'Item' }), h('th', { text: 'Entry' }), h('th', { text: 'Change' })])),
        h('tbody', {}, w.plan.plan.flatMap(t => t.changes.map((c, i) => h('tr', {}, [h('td', {}, i ? null : h('b', { text: t.label })), h('td', { class: 'mono', text: c.label || c.key }),
          h('td', {}, changeChips(c.before, c.after).map(x => chip(x.sign, x.text)))]))))])));
    }
    if (deploys) out.push(alertBox('info', 'Record type assignments are saved with a Metadata API deploy per item, guarded by a full copy of its access.'));
    if (w.plan.skipped && w.plan.skipped.length) out.push(h('details', { class: 'card disclosure' }, [h('summary', { text: w.plan.skipped.length + ' skipped' }), h('ul', { class: 'plain' }, w.plan.skipped.map(x => h('li', {}, [h('strong', { text: x.label }), ' — ' + x.reason])))]));
    if (w.progress) out.push(h('p', { class: 'muted status' }, [spinner(true), ' Saving ' + w.progress.label + ' (' + (w.progress.done + 1) + ' of ' + w.progress.total + ')']));
    if (w.applyError) out.push(alertBox('error', w.applyError));
    if (ctx.production && w.plan.plan && w.plan.plan.length) out.push(h('div', { class: 'confirm' }, [alertBox('warning', 'This is a production org.'), h('label', { text: 'Type ' + (ctx.org.alias || ctx.org.username) + ' to confirm' }),
      h('input', { type: 'text', class: 'text', value: w.confirm, 'data-fid': applyType + '.confirm', oninput: e => { w.confirm = e.target.value; const b = document.getElementById('wzApply'); if (b) b.disabled = !confirmOk(w.confirm); } })]));
    out.push(h('div', { class: 'btns' }, [h('button', { class: 'btn neutral', disabled: !!w.progress, onclick: o.onBack || (() => { w.plan = null; renderMain(); }), text: 'Back' }),
      h('button', { class: 'btn brand', id: 'wzApply', disabled: !!w.progress || !(w.plan.plan && w.plan.plan.length) || (ctx.production && !confirmOk(w.confirm)),
        onclick: () => { applyTarget = o.target || 'wizard'; w.progress = { label: '', done: 0, total: w.plan.plan.length }; w.applyError = null; renderMain(); send({ type: applyType, plan: w.plan.plan, confirm: w.confirm }); }, text: o.saveLabel || 'Save all' })]));
    return out;
  }

  function objWizardPage() {
    const w = objWizard;
    if (w.results || w.plan) return planView(w, 'objWizardApply', { adds: new Map(), rts: new Set(), defaultRt: '' });
    const info = w.info;
    if (w.object && info && w.currentFor !== w.object) { w.currentFor = w.object; w.current = null; send({ type: 'objWizardCurrent', object: w.object }); }
    const cols = info ? OBJECT_FLAGS.filter(([f]) => info.columns.includes(f)) : [];
    const cur = key => Object.assign(Object.fromEntries(cols.map(([f]) => [f, false])), ((w.current && w.current.byKey[key]) || {}).props || {});
    const after = key => { let p = cur(key); for (const f of w.adds.get(key) || []) if (!p[f]) p = Deps.applyObject(p, f, true).props; return p; };
    const editable = r => !r.managed && !(r.kind === 'profile' && r.standard);
    const rows = grantCandidates(w).filter(editable);
    const included = key => (w.adds.get(key) || new Set()).size > 0 || w.rtRows.has(key);
    const addedCount = key => { const a = after(key); const c = cur(key); return cols.filter(([f]) => a[f] && !c[f]).length; };
    const total = rows.reduce((n, r) => n + (included(r.key) ? addedCount(r.key) + (w.rts.size ? 1 : 0) : 0), 0);
    // Unticking keeps everything still shown as ticked, minus this box and whatever needs it (as in Setup).
    const setCellQuiet = (key, f, on) => {
      let s2;
      if (on) { s2 = new Set(w.adds.get(key) || []); s2.add(f); }
      else {
        const a = after(key); const c = cur(key);
        s2 = new Set(cols.map(([g]) => g).filter(g => a[g] && !c[g] && g !== f && !(Deps.OBJECT_REQUIRED_BY[f] || []).includes(g)));
      }
      if (s2.size) w.adds.set(key, s2); else w.adds.delete(key);
    };
    const setCell = (key, f, on) => { setCellQuiet(key, f, on); renderMain(); };
    const column = f => {
      const all = rows.every(r => after(r.key)[f]);
      for (const r of rows) { if (cur(r.key)[f]) continue; setCellQuiet(r.key, f, !all); }
      renderMain();
    };
    const out = [steps([{ title: 'What', text: w.object ? 'Object: ' + w.object : 'Pick an object', done: !!w.object },
      { title: 'Access and who', text: 'set per item', done: total > 0 }, { title: 'Review and save', text: total + (total === 1 ? ' change' : ' changes'), done: false }])];
    out.push(h('section', { class: 'card' }, [h('div', { class: 'card-head' }, [h('h2', { text: 'Object' }), h('div', { class: 'card-tools' }, [
      objectPicker(w.object, v => { w.object = v; w.info = null; w.adds = new Map(); w.rtRows = new Set(); w.rts = new Set(); w.defaultRt = ''; w.currentFor = ''; if (v) send({ type: 'objWizardInfo', object: v }); renderMain(); }, 'ow.obj', true)])]),
      !w.object ? h('div', { class: 'card-body' }, h('p', { class: 'muted flat', text: 'Pick an object to see who has access to it.' })) : null]));
    if (!w.object) return out;
    if (!info || !w.current) { out.push(loadingCard(w.object + ' access by item', { state: 'loading' })); return out; }
    const rts = info.recordTypes || [];
    if (rts.length) out.push(h('section', { class: 'card' }, [h('div', { class: 'card-head' }, [h('h2', { text: 'Record types to assign' }), h('span', { class: 'muted small', text: 'Applied to every item that gets access below. On profiles, the chosen default replaces the current one.' })]),
      h('div', { class: 'card-body rt-pick' }, rts.map(t => h('span', { class: 'rt-opt' }, [checkbox({ checked: w.rts.has(t.name), fid: 'owrt.' + t.name, label: t.label, onChange: v => { if (v) w.rts.add(t.name); else { w.rts.delete(t.name); if (w.defaultRt === t.name) w.defaultRt = ''; } renderMain(); } }),
        h('label', { class: 'radio small' }, [h('input', { type: 'radio', name: 'ow-default', checked: w.defaultRt === t.name, 'aria-label': 'Default ' + t.label, onchange: () => { w.defaultRt = t.name; w.rts.add(t.name); renderMain(); } }), ' default'])])))]));
    const cell = (r, f) => {
      const c = cur(r.key)[f];
      if (c) return h('span', { class: 'gc on', title: 'Already granted', text: '✓' });
      const a = after(r.key)[f];
      return h('button', { class: 'gc' + (a ? ' plus' : ''), 'aria-pressed': String(!!a), 'aria-label': (a ? 'Don’t grant ' : 'Grant ') + f + ' to ' + r.label, onclick: () => setCell(r.key, f, !a), text: a ? '+' : '' });
    };
    out.push(h('section', { class: 'card' }, [h('div', { class: 'card-head' }, [h('h2', { text: w.object + ' access by item' }),
      h('span', { class: 'muted small', text: 'Click a column header to set it for everyone shown. Grey ticks are already granted.' }),
      h('div', { class: 'card-tools' }, [h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Show' }, [['all', 'All'], ['permissionSet', 'Permission sets'], ['profile', 'Profiles']].map(([v, t]) =>
        h('button', { class: w.types === v ? 'on' : '', role: 'radio', 'aria-checked': String(w.types === v), onclick: () => { w.types = v; renderMain(); }, text: t }))),
        searchBox(w.targetFilter, 'Search', v => { w.targetFilter = v; renderMain(); }, 'ow.tg', true)])]),
      h('div', { class: 'card-body flush scroll-y' }, h('table', { class: 'datatable mtx' }, [h('thead', {}, h('tr', {}, [h('th', { text: 'Permission set or profile' })]
        .concat(cols.map(([f, label]) => h('th', { class: 'c' }, h('button', { class: 'col-set', title: 'Set ' + label + ' for everyone shown', onclick: () => column(f), text: label.replace(' Records', '') + ' ▾' }))),
          rts.length ? [h('th', { text: 'Record types' })] : []))),
        h('tbody', {}, rows.slice(0, 400).map(r => {
          const c = (w.current.byKey[r.key] || {});
          const inc = included(r.key);
          return h('tr', { class: inc ? 'row-edited' : '' }, [h('td', {}, [h('b', { text: r.label }), h('div', { class: 'cur', text: SRC_TYPE[r.kind] + ' · ' + (c.users || 0) + (c.users === 1 ? ' user' : ' users') })])]
            .concat(cols.map(([f]) => h('td', { class: 'c' }, cell(r, f))),
              rts.length ? [h('td', {}, w.rts.size ? h('button', { class: 'link small', onclick: () => { if (w.rtRows.has(r.key)) w.rtRows.delete(r.key); else w.rtRows.add(r.key); renderMain(); } },
                inc ? [chip('+', [...w.rts].map(n => (rts.find(t => t.name === n) || {}).label || n).join(', ')), r.kind === 'profile' && w.defaultRt ? h('span', { class: 'rv-chip rv-mod', text: 'default' }) : null] : '—') : h('span', { class: 'muted', text: '—' }))] : []));
        }))])),
      h('div', { class: 'card-body btns' }, [h('span', { class: 'muted small grow', text: '+ added now · ✓ already granted · ticking Edit also ticks Read, as in Setup. Nothing is taken away.' }),
        h('button', { class: 'btn brand', disabled: !total || w.busy, onclick: () => {
          const perTarget = {};
          for (const r of rows) if (included(r.key)) { const a = after(r.key); perTarget[r.key] = cols.map(([f]) => f).filter(f => a[f]); }
          w.busy = true; renderMain();
          send({ type: 'objWizardPlan', object: w.object, perTarget, recordTypes: [...w.rts], defaultRt: w.defaultRt || null });
        }, text: w.busy ? 'Working out the changes…' : 'Review ' + total + (total === 1 ? ' change' : ' changes') })])]));
    return out;
  }

  function confirmOk(t) { const v = String(t || '').trim(); return v === ctx.org.alias || v === ctx.org.username; }

  function historyPage() {
    if (historyData === null) { historyData = 'loading'; send({ type: 'history' }); }
    if (!Array.isArray(historyData)) return [h('div', { class: 'loading-block' }, spinner())];
    if (hf.setup && historySetupData === null) { historySetupData = 'loading'; send({ type: 'historySetup', days: hf.days === 'all' ? 180 : Number(hf.days) }); }
    const labelOf = key => { const k = (key || '').split(':')[0]; const r = lists && lists[k] && lists[k].find(x => x.key === key); return r ? r.label : null; };
    const since = hf.days === 'all' ? 0 : Date.now() - Number(hf.days) * 86400e3;
    const q = hf.q.trim().toLowerCase();
    const items = [...new Set(historyData.map(e => e.key).filter(Boolean))].map(k => [k, labelOf(k) || k]).sort((a, b) => a[1].localeCompare(b[1]));
    const ok = e => /saved|created/.test(e.result || '');
    const mine = historyData.filter(e => Date.parse(e.at) >= since && (!hf.item || e.key === hf.item) && (!hf.result || (hf.result === 'failed' ? e.result === 'failed' : ok(e))) &&
      (!q || [e.target, labelOf(e.key), e.ticket, (e.changes || []).map(c => c.key + ' ' + (c.label || '')).join(' ')].join(' ').toLowerCase().includes(q)))
      .map(e => ({ kind: 'save', at: e.at, e }));
    const setupRows = hf.setup && Array.isArray(historySetupData) ? historySetupData.filter(x => Date.parse(x.at) >= since && (!hf.item || x.key === hf.item) && !hf.result &&
      (!q || (x.display + ' ' + x.name + ' ' + x.by).toLowerCase().includes(q))).map(x => ({ kind: 'setup', at: x.at, x })) : [];
    const all = mine.concat(setupRows).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const copyable = historyData.filter(e => e.snapshot && e.changes && e.changes.length);
    const picked = copyable.filter(e => historyPicked.has(e.snapshot)).map(e => e.snapshot);
    const copy = (ids, format) => send({ type: 'copySummary', snapshotIds: ids, format });
    const out = [h('div', { class: 'filters' }, [
      searchBox(hf.q, 'Search item, field, permission or ticket', v => { hf.q = v; renderMain(); }, 'hf.q', true),
      filterChip('Last', hf.days, [['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['all', 'All']], v => { hf.days = v; historySetupData = null; renderMain(); }, '7'),
      filterChip('Item', hf.item, [['', 'Any']].concat(items), v => { hf.item = v; renderMain(); }, ''),
      filterChip('Result', hf.result, [['', 'Any'], ['saved', 'Saved'], ['failed', 'Failed']], v => { hf.result = v; renderMain(); }, ''),
      toggle('Include changes made in Setup', hf.setup, v => { hf.setup = v; if (!v) historySetupData = null; renderMain(); })])];
    if (picked.length) out.push(h('div', { class: 'selbar' }, [h('span', { class: 'muted small', text: picked.length + ' selected' }),
      h('button', { class: 'btn neutral', onclick: () => copy(picked, 'markdown'), text: 'Copy summary' }),
      h('button', { class: 'btn neutral', title: 'Tab-separated, pastes into Excel as cells', onclick: () => copy(picked, 'tsv'), text: 'Copy for Excel' }),
      h('button', { class: 'btn neutral', onclick: () => { historyPicked.clear(); renderMain(); }, text: 'Clear' })]));
    if (hf.setup && historySetupData && historySetupData.denied) out.push(alertBox('info', 'Changes made in Setup need the View Setup Audit Trail permission (from Winter ’27; View Setup before that).'));
    if (!all.length) { out.push(h('p', { class: 'empty-line', text: historyData.length ? 'Nothing matches these filters.' : 'No saves yet. Every save from this screen is recorded here.' })); return out; }
    const dayOf = at => { const d = new Date(at); const t = new Date(); const y = new Date(Date.now() - 86400e3);
      return d.toDateString() === t.toDateString() ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }); };
    const timeOf = at => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    let day = null;
    for (const row of all) {
      const d = dayOf(row.at);
      if (d !== day) { day = d; out.push(h('div', { class: 'day', text: d })); }
      if (row.kind === 'setup') {
        const x = row.x;
        out.push(h('div', { class: 'ev setup' }, [h('div', {}), h('div', {}, [h('div', { class: 't' }, [h('span', { class: 'ico su', text: 'S' }),
          x.key ? h('button', { class: 'link strong', onclick: () => { ui.tool = null; renderTop(); guard(() => choose(x.key)); }, text: labelOf(x.key) || x.name }) : h('b', { text: x.name }), h('span', { class: 'st und', text: 'In Setup' })]),
          h('div', { class: 'meta', text: timeOf(x.at) + ' · by ' + x.by + (x.delegate ? ' (as ' + x.delegate + ')' : '') + ' in Setup' + (x.section ? ' · ' + x.section : '') }),
          h('div', { class: 'cur', text: x.display })]), h('div', {})]));
        continue;
      }
      const e = row.e;
      const kind = (e.key || '').split(':')[0] || e.kind || 'permissionSet';
      const canPick = e.snapshot && e.changes && e.changes.length;
      const changes = e.changes || [];
      const open = hf.open.has(e.snapshot || e.at);
      const chips = [];
      for (const c of changes) {
        const name = c.key.slice(c.key.indexOf(':') + 1);
        for (const x of changeChips(c.from, c.to)) chips.push(chip(x.sign, x.text + ' · ' + (c.label && !name.endsWith(c.label) ? c.label : name)));
      }
      const status = e.result === 'failed' ? h('span', { class: 'st bad', text: 'Failed' }) : /^undo/.test(e.path || '') ? h('span', { class: 'st und', text: 'Undo' }) : e.result === 'created' ? h('span', { class: 'st ok', text: 'Created' }) : h('span', { class: 'st ok', text: 'Saved' });
      out.push(h('div', { class: 'ev' + (historyPicked.has(e.snapshot) ? ' sel' : '') }, [
        h('div', {}, canPick ? checkbox({ checked: historyPicked.has(e.snapshot), fid: 'hist.' + e.snapshot, aria: 'Select save of ' + (e.target || ''), onChange: v => { if (v) historyPicked.add(e.snapshot); else historyPicked.delete(e.snapshot); renderMain(); } }) : null),
        h('div', {}, [h('div', { class: 't' }, [h('span', { class: 'ico ' + (SRC_CLASS[kind] || 'ps'), text: { permissionSet: 'PS', profile: 'P', group: 'G' }[kind] || 'PS' }),
            e.key && labelOf(e.key) ? h('button', { class: 'link strong', onclick: () => { ui.tool = null; renderTop(); guard(() => choose(e.key)); }, text: labelOf(e.key) }) : h('b', { text: e.target || '' }),
            status, e.ticket ? h('span', { class: 'ticket', text: e.ticket }) : null]),
          h('div', { class: 'meta', text: timeOf(e.at) + ' · ' + (e.count != null ? e.count : changes.length) + ((e.count != null ? e.count : changes.length) === 1 ? ' change' : ' changes') + (e.path ? ' · ' + e.path : '') }),
          e.result === 'failed' && e.error ? h('div', { class: 'cur err', text: (e.failedStep ? e.failedStep + ': ' : '') + e.error }) : null,
          chips.length ? h('div', { class: 'ch' }, (open ? chips : chips.slice(0, 6)).concat(chips.length > 6 ? [h('button', { class: 'link small', onclick: () => { if (open) hf.open.delete(e.snapshot || e.at); else hf.open.add(e.snapshot || e.at); renderMain(); }, text: open ? 'Show fewer' : '+' + (chips.length - 6) + ' more' })] : [])) : null]),
        h('div', { class: 'act' }, [canPick ? h('button', { class: 'btn neutral small', title: 'Copy this save as a Markdown table', onclick: () => copy([e.snapshot], 'markdown'), text: 'Copy' }) : null,
          e.snapshot && e.result !== 'failed' && e.key ? h('button', { class: 'btn neutral small', onclick: () => send({ type: 'undoSnapshot', snapshotId: e.snapshot }), text: 'Undo…' }) : null])]));
    }
    return out;
  }

  function brief(v) {
    if (v == null) return 'none';
    if (typeof v !== 'object') return String(v);
    const on = Object.keys(v).filter(k => v[k] === true).map(k => SHORT[k] || k);
    const other = Object.keys(v).filter(k => typeof v[k] === 'string' && v[k]).map(k => (SHORT[k] || k) + ' ' + v[k]);
    if (Array.isArray(v.ranges)) other.push(v.ranges.length + ' ranges');
    return on.concat(other).join(', ') || 'none';
  }

  // ---------- create, edit, clone ----------
  function openPsForm(mode) {
    const hd = detail && detail.data && detail.data.header;
    const f = mode === 'edit' ? { label: hd.label, name: hd.apiName, description: hd.description || '' }
        : mode === 'copyProfile' ? { label: hd.label.replace(/^Custom:\s*/i, '') + ' Access', name: '', description: 'Access from the ' + hd.label + ' profile.', useLicense: true }
        : { label: 'Copy of ' + hd.label, name: ('Copy_of_' + hd.apiName.replace(/^\w+?__(?!c$)/, '')).slice(0, 80), description: hd.description || '' };
    if (mode === 'copyProfile') f.name = apiName(f.label);
    f.nameTouched = mode === 'edit';
    openModal({ kind: 'psForm', mode, form: f });
  }
  function apiName(label) { return label.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'X$1').replace(/__+/g, '_').slice(0, 80); }
  function psFormContent() {
    const f = modal.form;
    const field = (label, prop, extra) => h('label', { class: 'fld wide' }, [h('span', { text: label }), h(extra && extra.area ? 'textarea' : 'input', Object.assign({ class: 'text', value: f[prop] || '', 'data-fid': 'ps.' + prop,
      oninput: e => { f[prop] = e.target.value; if (prop === 'label' && !f.nameTouched) { f.name = apiName(f.label); const n = document.querySelector('[data-fid="ps.name"]'); if (n) n.value = f.name; } if (prop === 'name') f.nameTouched = true; updatePsBtn(); } },
      extra && extra.area ? { rows: '3', text: f[prop] || '' } : { type: 'text' }))]);
    const out = [field('Label', 'label'), field('API Name', 'name'), field('Description', 'description', { area: true })];
    if (modal.mode === 'clone') out.push(alertBox('info', 'Copies object, field, system, class, page, custom permission, flow, app, connected app, custom metadata and custom setting access, record type assignments and tab settings. Assignments are not copied.'));
    if (modal.mode === 'copyProfile') {
      out.push(checkbox({ checked: f.useLicense !== false, fid: 'ps.license', label: 'Give it the profile’s user license (recommended: every system permission stays valid)', onChange: v => { f.useLicense = v; } }));
      out.push(alertBox('info', 'Copies the profile’s object, field, system, class, page, custom permission, flow, app, connected app, custom metadata and custom setting access, tab settings and record type assignments into a new permission set. Page layouts, login hours, IP ranges and record type defaults stay on the profile, and nothing is removed from it.'));
    }
    if (ctx.production) out.push(h('div', { class: 'confirm' }, [alertBox('warning', 'This is a production org.'), h('label', { text: 'Type ' + (ctx.org.alias || ctx.org.username) + ' to confirm' }),
      h('input', { type: 'text', class: 'text', value: modal.confirm || '', oninput: e => { modal.confirm = e.target.value; updatePsBtn(); } })]));
    if (modal.progress) out.push(h('p', { class: 'muted status' }, [spinner(true), ' ' + modal.progress]));
    if (modal.error) out.push(alertBox('error', modal.error));
    return out;
  }
  function updatePsBtn() {
    const b = document.getElementById('psBtn');
    if (!b || !modal) return;
    const f = modal.form;
    b.disabled = !!modal.progress || !f.label.trim() || !/^[A-Za-z][A-Za-z0-9_]*$/.test(f.name) || /__/.test(f.name) || /_$/.test(f.name) || (ctx.production && !confirmOk(modal.confirm));
  }
  function submitPs() {
    const f = modal.form;
    modal.error = null;
    modal.progress = modal.mode === 'edit' ? 'Saving…' : 'Starting the copy…';
    renderModal();
    const type = { edit: 'editPs', clone: 'clonePs', copyProfile: 'copyProfile' }[modal.mode];
    send({ type, key: ui.selected, label: f.label.trim(), name: f.name.trim(), description: f.description.trim(), confirm: modal.confirm || '', useLicense: f.useLicense !== false });
  }

  // ---------- footer, review, toasts ----------
  /** Unsaved changes are handed to the extension, so closing the tab or reloading VS Code doesn't lose them. */
  let lastPersisted = '';
  function persistPending() {
    if (restoreSaved) return; // don't overwrite what's waiting to be restored
    const v = pending.size && ui.selected ? { key: ui.selected, entries: [...pending.entries()].map(([k, p]) => [k, Object.assign({}, p, { touched: [...(p.touched || [])] })]) } : null;
    const j = JSON.stringify(v);
    if (j === lastPersisted) return;
    lastPersisted = j;
    send({ type: 'persist', name: 'pending', value: v });
  }
  function restorePending() {
    if (!restoreSaved || !detail || detail.key !== restoreSaved.key || !detail.data || pending.size) return;
    for (const [k, p] of restoreSaved.entries) pending.set(k, Object.assign({}, p, { touched: new Set(p.touched || []) }));
    ui.restored = pending.size;
    restoreSaved = null;
    renderMain(); renderFooter();
  }
  function renderFooter() {
    persistPending();
    if (!pending.size) ui.restored = 0;
    footer.textContent = '';
    footer.hidden = !pending.size;
    if (!pending.size) return;
    footer.append(h('span', { class: 'footer-text' }, [h('strong', { text: String(pending.size) }), pending.size === 1 ? ' unsaved change' : ' unsaved changes']),
      h('div', { class: 'btns' }, [
        h('button', { class: 'btn neutral', onclick: () => { pending.clear(); lastFocus = null; renderMain(); renderFooter(); }, text: 'Cancel', disabled: !!saving }),
        h('button', { class: 'btn brand', onclick: () => openModal({ kind: 'review' }), text: 'Save', disabled: !!saving })]));
  }

  /** One value for the review list; `other` is the value on the other side, to tell a missing checkbox from a missing text. */
  function shown(v, other) {
    if (typeof v === 'boolean' || (v === undefined && typeof other === 'boolean')) return v ? 'Yes' : 'No';
    if (v === undefined) return '—';
    if (v === null || v === '') return '—';
    if (Array.isArray(v)) return v.length ? v.map(r => r.startAddress + '–' + r.endAddress).join(', ') : 'none';
    if (/^\d+$/.test(String(v)) && Number(v) <= 1440) return HOURS.find(x => x[0] === String(v)) ? HOURS.find(x => x[0] === String(v))[1] : String(v);
    return String(v);
  }
  function changeLines(p) {
    const keys = [...new Set([...Object.keys(p.before || {}), ...Object.keys(p.after)])].filter(f => valueDiffers((p.before || {})[f], p.after[f]));
    return keys.map(f => h('li', {}, [h('span', { text: (SHORT[f] || f.replace(/(Start|End)$/, ' $1').replace(/^./, c => c.toUpperCase())) + ': ' }), h('span', { class: 'from', text: shown((p.before || {})[f], p.after[f]) }), ' → ',
      h('span', { class: 'to', text: shown(p.after[f], (p.before || {})[f]) }), !p.touched.has(f) ? h('span', { class: 'auto', text: 'auto' }) : null]));
  }
  function reviewList() {
    return CATEGORY_TITLES.map(([cat, title]) => {
      const entries = [...pending.entries()].filter(([, p]) => p.cat === cat);
      if (!entries.length) return null;
      return h('div', { class: 'review-group' }, [h('h3', { text: title + ' (' + entries.length + ')' }),
        h('ul', { class: 'review' }, entries.map(([k, p]) => h('li', {}, [h('span', { class: 'strong', text: p.label }), h('span', { class: 'muted mono', text: ' ' + k.slice(k.indexOf(':') + 1) }), h('ul', {}, changeLines(p))])))]);
    });
  }

  // What a high-impact system permission lets every holder do, in plain words.
  const RISK_TEXT = { ModifyAllData: 'read, edit and delete every record in the org', ViewAllData: 'read every record in the org', ManageUsers: 'create, change and deactivate users',
    AuthorApex: 'write and run Apex code', CustomizeApplication: 'change the org’s setup', ModifyMetadata: 'change the org’s metadata', ManageProfilesPermissionsets: 'change profiles and permission sets',
    AssignPermissionSets: 'assign permission sets to anyone', ViewAllUsers: 'see every user', ResetPasswords: 'reset users’ passwords' };
  /** The review: impact first (counts, risks, removals), then every change on one line. */
  function reviewView(hd) {
    const rows = [...pending.entries()].map(([k, p]) => ({ k, p, chips: changeChips(p.before, p.after, p.touched) }));
    const granted = rows.filter(r => r.chips.some(c => c.sign === '+')).length;
    const removed = rows.filter(r => r.chips.some(c => c.sign === '-'));
    const risky = rows.filter(r => r.p.cat === 'user' && r.p.after.enabled && isHighImpact({ name: r.k.slice(5), label: r.p.label }));
    const users = Number(hd.activeAssignees) || 0;
    const who = hd.kindId === 'profile' ? 'users with this profile' : 'active users affected';
    const out = [h('div', { class: 'rv-stats' }, [
      h('div', { class: 'rv-stat' }, [h('b', { text: String(rows.length) }), h('span', { text: (rows.length === 1 ? 'change' : 'changes') + ' · ' + granted + ' granted, ' + removed.length + ' removed' })]),
      h('div', { class: 'rv-stat' }, [h('b', { text: String(users) }), h('span', { text: who })]),
      h('div', { class: 'rv-stat' + (risky.length ? ' risk' : '') }, [h('b', { text: String(risky.length) }), h('span', { text: 'high-impact permissions granted' })]),
      h('div', { class: 'rv-stat' + (removed.length ? ' warn' : '') }, [h('b', { text: String(removed.length) }), h('span', { text: 'access removed' })])])];
    if (risky.length) {
      const first = risky.find(r => !r.chips.every(c => c.auto)) || risky[0];
      const name = first.k.slice(5);
      const auto = risky.filter(r => r !== first && r.chips.every(c => c.auto)).map(r => r.p.label);
      const others = risky.filter(r => r !== first && !auto.includes(r.p.label)).map(r => r.p.label);
      out.push(h('div', { class: 'rv-call risk', role: 'note' }, [h('span', { class: 'ic', text: '!' }), h('span', {}, [h('b', { text: first.p.label }),
        ' lets all ' + users + ' ' + (hd.kindId === 'profile' ? 'users with this profile ' : 'users ') + (RISK_TEXT[name] || 'reach far beyond a single object') + '.',
        others.length ? ' Also granted: ' + others.join(', ') + '.' : '',
        auto.length ? ' ' + auto.join(' and ') + (auto.length === 1 ? ' is' : ' are') + ' added because Salesforce requires it.' : ''])]));
    }
    if (removed.length) {
      const lost = removed.slice(0, 3).map(r => r.chips.filter(c => c.sign === '-').map(c => c.text).join(', ') + ' on ' + r.p.label);
      out.push(h('div', { class: 'rv-call warn', role: 'note' }, [h('span', { class: 'ic', text: '−' }), h('span', { text: 'Users lose ' + lost.join('; ') + (removed.length > 3 ? ' and ' + (removed.length - 3) + ' more' : '') +
        ', unless another permission set, profile or group still gives it to them.' })]));
    }
    if (modal.ticket === undefined) modal.ticket = lastTicket || '';
    out.push(h('div', { class: 'rv-tools' }, [
      h('input', { type: 'search', class: 'text', placeholder: 'Filter changes', 'aria-label': 'Filter changes', value: modal.filter || '', 'data-fid': 'rv.filter',
        oninput: e => { modal.filter = e.target.value; renderReviewTable(); } }),
      h('input', { type: 'text', class: 'text', placeholder: 'Ticket (optional), e.g. ADO US 11581701', 'aria-label': 'Ticket', value: modal.ticket, 'data-fid': 'rv.ticket', maxlength: '80',
        oninput: e => { modal.ticket = e.target.value; } })]));
    out.push(h('div', { class: 'rv-scroll', id: 'rvTable' }, reviewTable(rows)));
    return out;
  }
  function reviewTable(rows) {
    const q = (modal.filter || '').trim().toLowerCase();
    const body = [];
    for (const [cat, title] of CATEGORY_TITLES) {
      const inCat = rows.filter(r => r.p.cat === cat && (!q || (r.p.label + ' ' + r.k + ' ' + r.chips.map(c => c.text).join(' ')).toLowerCase().includes(q)));
      if (!inCat.length) continue;
      body.push(h('tr', { class: 'rv-grp' }, h('td', { colspan: '4', text: title + ' (' + inCat.length + ')' })));
      for (const r of inCat) {
        const allAuto = r.chips.length && r.chips.every(c => c.auto);
        const risk = r.p.cat === 'user' && r.p.after.enabled && isHighImpact({ name: r.k.slice(5), label: r.p.label });
        body.push(h('tr', {}, [
          h('td', {}, [h('b', { text: r.p.label }), allAuto ? h('span', { class: 'rv-auto', title: 'Added by Salesforce’s permission rules', text: 'auto' }) : null, risk ? h('span', { class: 'rv-risk', text: 'High impact' }) : null]),
          h('td', { class: 'mono', text: r.k.slice(r.k.indexOf(':') + 1) }),
          h('td', {}, r.chips.map(c => chip(c.sign, c.text, c.auto ? 'Added by Salesforce’s permission rules' : null))),
          h('td', { class: 'c narrow' }, h('button', { class: 'rv-x', title: 'Remove this change', 'aria-label': 'Remove the change to ' + r.p.label, disabled: !!saving,
            onclick: () => { pending.delete(r.k); patchRows([r.k]); renderFooter(); if (!pending.size) closeModal(); else renderModal(); }, text: '×' }))]));
      }
    }
    if (!body.length) return h('p', { class: 'empty-line', text: 'No changes match.' });
    return h('table', { class: 'rv-table' }, [h('thead', {}, h('tr', {}, [h('th', { text: 'Entry' }), h('th', { text: 'API name' }), h('th', { text: 'Change' }), h('th', {})])), h('tbody', {}, body)]);
  }
  function renderReviewTable() {
    const el = document.getElementById('rvTable');
    if (!el) return;
    el.textContent = '';
    el.appendChild(reviewTable([...pending.entries()].map(([k, p]) => ({ k, p, chips: changeChips(p.before, p.after, p.touched) }))));
  }

  function openModal(m) { modal = m; renderModal(); }
  function closeModal() { modal = null; renderModal(); }
  function renderModal() {
    overlay.textContent = '';
    overlay.hidden = !modal;
    if (!modal) return;
    let title, content, buttons;
    if (modal.kind === 'psForm') {
      title = { edit: 'Edit permission set', clone: 'Clone ' + (detail && detail.data ? detail.data.header.label : ''), copyProfile: 'Copy ' + (detail && detail.data ? detail.data.header.label : '') + ' to a permission set' }[modal.mode];
      content = psFormContent();
      buttons = [h('button', { class: 'btn neutral', onclick: closeModal, text: 'Cancel', disabled: !!modal.progress }),
        h('button', { class: 'btn brand', id: 'psBtn', onclick: submitPs, text: modal.mode === 'clone' ? 'Clone' : 'Save' })];
    } else if (modal.kind === 'discard') {
      title = 'Discard unsaved changes?';
      content = [h('p', { text: 'You have ' + pending.size + ' unsaved ' + (pending.size === 1 ? 'change' : 'changes') + ' on ' + detail.data.header.label + '.' })];
      buttons = [h('button', { class: 'btn neutral', onclick: closeModal, text: 'Keep editing' }),
        h('button', { class: 'btn destructive', onclick: () => { const then = modal.then; pending.clear(); closeModal(); renderFooter(); then(); }, text: 'Discard changes' })];
    } else {
      const hd = detail.data.header;
      title = modal.kind === 'conflict' ? 'Changed in the org since you loaded it' : 'Review changes to ' + hd.label;
      const confirm = ctx.production ? h('div', { class: 'confirm' }, [alertBox('warning', 'This is a production org.'),
        h('label', { for: 'confirm', text: 'Type ' + (ctx.org.alias || ctx.org.username) + ' to confirm' }),
        h('input', { id: 'confirm', type: 'text', autocomplete: 'off', value: modal.confirm || '', oninput: e => { modal.confirm = e.target.value; updateSaveBtn(); } })]) : null;
      content = [];
      if (modal.kind === 'conflict') {
        content.push(alertBox('warning', 'Someone changed these entries after you loaded them. Saving anyway replaces their values with yours.'));
        content.push(h('ul', { class: 'review' }, modal.conflicts.map(c => h('li', {}, [h('span', { class: 'strong', text: (pending.get(c.key) || {}).label || c.key }),
          h('span', { class: 'muted', text: ' now: ' + brief(c.now) })]))));
      }
      if (modal.kind === 'conflict') content.push(h('div', { class: 'review-scroll' }, reviewList()));
      else {
        content.push(...reviewView(hd));
        if ([...pending.values()].some(p => ['recordType', 'layoutAssignment', 'loginHours', 'loginIpRanges'].includes(p.cat))) content.push(alertBox('info', 'Some of these are saved with a Metadata API deploy, which takes longer. A full copy of this item’s access is taken first and checked afterwards.'));
      }
      if (modal.error) content.push(alertBox('error', modal.error, modal.restore ? [h('div', { class: 'btns mt' }, h('button', { class: 'btn brand', onclick: () => { send({ type: 'restore', key: ui.selected, snapshotId: modal.restore }); pending.clear(); closeModal(); renderFooter(); }, text: 'Restore removed permissions' }))] : null));
      if (localFile && localFile.key === ui.selected && localFile.path && localFile.mode !== 'never' && modal.kind === 'review') {
        if (modal.writeLocal === undefined) modal.writeLocal = true;
        content.push(checkbox({ checked: modal.writeLocal, disabled: localFile.mode === 'always', fid: 'review.local', label: 'Also update ' + localFile.path, onChange: v => { modal.writeLocal = v; } }));
      }
      if (confirm) content.push(confirm);
      if (saving) content.push(h('p', { class: 'muted status' }, [spinner(true), ' ' + (saving.label || 'Saving…') + (saving.total ? ' (' + (saving.done + 1) + ' of ' + saving.total + ')' : '')]));
      const go = h('button', { class: 'btn brand', id: 'saveBtn', onclick: () => doSave(modal.kind === 'conflict'), text: modal.kind === 'conflict' ? 'Save anyway' : 'Save ' + pending.size + (pending.size === 1 ? ' change' : ' changes') });
      buttons = [h('button', { class: 'btn neutral', onclick: () => { if (modal.kind === 'conflict') { pending.clear(); renderFooter(); closeModal(); reloadCurrent(); } else closeModal(); },
        text: modal.kind === 'conflict' ? 'Discard mine and reload' : 'Cancel', disabled: !!saving }), go];
    }
    const box = h('section', { class: 'modal' + (modal.kind === 'review' ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' }, [
      h('header', {}, [h('h2', { id: 'modal-title', text: title }), h('button', { class: 'icon-only', 'aria-label': 'Close', onclick: () => { if (!saving) closeModal(); } }, svg(ICONS.close))]),
      h('div', { class: 'modal-body' }, content),
      h('footer', {}, buttons)]);
    overlay.appendChild(box);
    updateSaveBtn();
    if (modal.kind === 'psForm') updatePsBtn();
    const first = box.querySelector('#confirm') || box.querySelector('[data-fid="ps.label"]') || box.querySelector('footer .btn.brand, footer .btn.destructive');
    if (first && document.activeElement && !box.contains(document.activeElement)) first.focus();
  }
  function updateSaveBtn() {
    const b = document.getElementById('saveBtn');
    if (!b) return;
    const need = ctx.production ? (ctx.org.alias || ctx.org.username) : null;
    const typed = (modal && modal.confirm || '').trim();
    b.disabled = !!saving || (need && typed !== ctx.org.alias && typed !== ctx.org.username);
  }
  function doSave(force) {
    saving = { label: 'Checking the org for changes…', done: 0, total: 0 };
    modal.error = null;
    renderModal(); renderFooter();
    const changes = [...pending.entries()].map(([key, p]) => ({ key, ref: p.ref || null, before: p.before, after: p.after, label: p.label || null }));
    const writeLocal = !!(localFile && localFile.path && localFile.mode !== 'never' && (localFile.mode === 'always' || modal.writeLocal !== false));
    const ticket = (modal.ticket || '').trim();
    if (ticket !== lastTicket) { lastTicket = ticket; send({ type: 'persist', name: 'lastTicket', value: ticket || null }); }
    send({ type: 'save', key: ui.selected, object: ui.page === 'object' ? ui.object : null, changes, confirm: modal.confirm || '', force: !!force, writeLocal, ticket });
  }

  function toast(variant, message, opts) {
    const o = opts || {};
    const el = h('div', { class: 'toast ' + variant, role: variant === 'error' ? 'alert' : 'status' }, [
      svg(ICONS[variant === 'error' || variant === 'warning' ? 'warning' : variant === 'success' ? 'success' : 'info'], 'toast-icon'),
      h('div', { class: 'toast-text' }, [o.title ? h('strong', { text: o.title }) : null, h('span', { text: message }),
        (o.action || o.actions) ? h('div', { class: 'toast-actions' }, [].concat(o.actions || [o.action]).filter(Boolean).map(a => h('button', { class: 'link', onclick: () => { el.remove(); a.run(); }, text: a.label }))) : null]),
      h('button', { class: 'icon-only', 'aria-label': 'Close', onclick: () => el.remove() }, svg(ICONS.close))]);
    toasts.appendChild(el);
    if (!o.sticky) setTimeout(() => el.remove(), variant === 'error' || variant === 'warning' ? 12000 : 7000);
  }

  // ---------- messages ----------
  window.addEventListener('message', ev => {
    const m = ev.data || {};
    switch (m.type) {
      case 'context': {
        const orgChanged = (ctx.org && ctx.org.username) !== (m.org && m.org.username);
        ctx = m;
        if (orgChanged && ctx.org) { lists = null; detail = null; objectPage = null; catalog = null; pending.clear(); }
        if (m.status !== 'ready' && orgChanged) { ui.selected = null; save(); }
        renderTop(); renderSide(); renderMain(); renderFooter();
        break;
      }
      case 'lists': {
        lists = Object.assign({}, m.lists, { partial: !!m.partial, profilesFiltered: !!m.profilesFiltered }); listsMeta = { savedAt: m.savedAt, refreshing: m.refreshing };
        if (!depsAsked && !m.refreshing) { depsAsked = true; send({ type: 'permDeps' }); }
        if (m.kinds) { KINDS = ALL_KINDS.filter(k => m.kinds.includes(k[0])); if (!m.kinds.includes(ui.kind)) { ui.kind = KINDS[0][0]; save(); } }
        const known = ui.selected && Object.values(lists).some(l => l.some(r => r.key === ui.selected));
        if (!known && ui.selected) { ui.selected = null; detail = null; save(); }
        renderTop(); renderSide();
        if (known && (!detail || detail.key !== ui.selected)) {
          detail = { key: ui.selected, state: 'loading' };
          send({ type: 'select', key: ui.selected });
          if (ui.page === 'object' && ui.object) {
            objectPage = { key: ui.selected, object: ui.object, state: 'loading' }; rtPage = { key: ui.selected, object: ui.object, state: 'loading' };
            send({ type: 'openObject', key: ui.selected, object: ui.object }); send({ type: 'loadRecordTypes', key: ui.selected, object: ui.object });
          }
        }
        renderMain();
        break;
      }
      case 'detailLoading':
        if (m.key !== ui.selected) break;
        if (detail && detail.key === m.key && detail.data) detail.refreshing = true; else detail = { key: m.key, state: 'loading' };
        renderMain(); break;
      case 'detail':
        if (m.key !== ui.selected) break;
        detail = { key: m.key, data: m.data, savedAt: m.savedAt, refreshing: m.refreshing, state: 'ready' };
        reconcile(m.data.objects.map(o => ['object:' + o.name, o.props]).concat(m.data.system.map(s => ['user:' + s.name, { enabled: s.enabled }])));
        if (stageAfterLoad && stageAfterLoad.key === m.key) { const st = stageAfterLoad; stageAfterLoad = null; applyStaged(st); break; }
        renderMain(); renderFooter(); restorePending(); break;
      case 'detailError':
        if (m.key !== ui.selected) break;
        detail = { key: m.key, state: 'error', message: m.message }; renderMain(); break;
      case 'objectLoading':
        if (m.key !== ui.selected || m.object !== ui.object) break;
        if (objectPage && objectPage.data && objectPage.object === m.object) objectPage.refreshing = true; else objectPage = { key: m.key, object: m.object, state: 'loading' };
        renderMain(); break;
      case 'objectDetail':
        if (m.key !== ui.selected || m.object !== ui.object) break;
        objectPage = { key: m.key, object: m.object, data: m.data, savedAt: m.savedAt, refreshing: m.refreshing, state: 'ready' };
        reconcile([['object:' + m.object, m.data.props]].concat(m.data.fields.filter(f => !f.fixed).map(f => ['field:' + f.name, { read: f.read, edit: f.edit }])));
        renderMain(); renderFooter(); break;
      case 'objectError':
        if (m.key !== ui.selected || m.object !== ui.object) break;
        objectPage = { key: m.key, object: m.object, state: 'error', message: m.message }; renderMain(); break;
      case 'objectCatalog':
        catalog = Array.isArray(m.objects) ? m.objects : [];
        if (ui.tool) { renderMain(); break; }
        if (!Array.isArray(m.objects) && m.message) toast('error', m.message, { title: 'Could not list objects' });
        renderMain(); break;
      case 'saveProgress':
        if (saving) { saving = { label: m.label, done: m.done, total: m.total }; renderModal(); }
        break;
      case 'saveResult': {
        saving = null;
        if (m.status === 'conflict') { openModal({ kind: 'conflict', conflicts: m.conflicts, confirm: modal && modal.confirm }); renderFooter(); break; }
        if (m.status === 'saved') {
          const target = detail && detail.data ? detail.data.header.label : 'the item';
          pending.clear(); closeModal(); renderFooter(); renderMain();
          toast('success', m.count + (m.count === 1 ? ' change' : ' changes') + ' saved to ' + target + '.' + (m.local && m.local.path ? ' Updated ' + m.local.path + '.' : ''),
            { title: 'Saved', actions: m.snapshotId ? [{ label: 'Undo', run: () => send({ type: 'undoSnapshot', snapshotId: m.snapshotId }) },
              { label: 'Copy summary', run: () => send({ type: 'copySummary', snapshotIds: [m.snapshotId], format: 'markdown' }) }] : null });
          if (m.local && m.local.error) toast('warning', 'Saved to the org, but the local file could not be updated: ' + m.local.error, { sticky: true });
          if (m.local && m.local.skipped) toast('info', m.local.skipped + ' connected app change' + (m.local.skipped === 1 ? ' has' : 's have') + ' no place in the file and ' + (m.local.skipped === 1 ? 'was' : 'were') + ' left out of it.');
          if (m.mismatches && m.mismatches.length) toast('warning', m.mismatches.length + ' entries did not end up as requested; the screen shows what the org now holds.', { title: 'Check these', sticky: true });
          break;
        }
        if (modal) { modal.error = m.message + (m.partial ? '\nSome steps were saved before this error. The screen now shows the org’s current values; anything still listed was not saved.' : ''); modal.restore = m.restorable ? m.snapshotId : null; renderModal(); }
        else toast('error', m.message, { title: 'Save failed', sticky: true });
        renderFooter();
        break;
      }
      case 'toast': toast(m.variant || 'info', m.message, { title: m.title, sticky: m.sticky }); break;
      case 'permDeps': permDeps = { system: m.system || {}, custom: m.custom || {} }; break;
      case 'lookupOptions': lookupOptions = m.message ? { message: m.message } : { ready: true, system: m.system || [], custom: m.custom || [] }; if (ui.tool === 'lookup') renderMain(); break;
      case 'assigneeChecks': if (m.key === ui.selected) { Object.assign(assigneeBlockers, m.blockers || {}); renderMain(); } break;
      case 'auditLoading': if (m.key === ui.selected) { if (auditPage && auditPage.data) auditPage.refreshing = true; else auditPage = { key: m.key, state: 'loading' }; renderMain(); } break;
      case 'audit': if (m.key === ui.selected) { auditPage = { key: m.key, data: m.data, refreshing: m.refreshing, state: 'ready' }; renderMain(); } break;
      case 'auditError': if (m.key === ui.selected) { auditPage = { key: m.key, state: 'error', message: m.message }; renderMain(); } break;
      case 'listsChecked': listsMeta.savedAt = m.savedAt; renderTop(); break;
      case 'autoRefresh': refreshOpen(); break;
      case 'tabsLoading': if (m.key === ui.selected) { if (tabsPage && tabsPage.data) tabsPage.refreshing = true; else tabsPage = { key: m.key, state: 'loading' }; renderMain(); } break;
      case 'tabsDetail': if (m.key === ui.selected) { tabsPage = { key: m.key, data: m.data, refreshing: m.refreshing, state: 'ready' }; reconcile(m.data.items.map(t => ['tab:' + t.name, { visibility: t.visibility }])); renderMain(); renderFooter(); } break;
      case 'tabsError': if (m.key === ui.selected) { tabsPage = { key: m.key, state: 'error', message: m.message }; renderMain(); } break;
      case 'assignLoading': if (m.key === ui.selected) { if (assignPage && assignPage.data) assignPage.refreshing = true; else assignPage = { key: m.key, state: 'loading' }; renderMain(); } break;
      case 'assignments': if (m.key === ui.selected) { assignPage = { key: m.key, data: m.data, refreshing: m.refreshing, state: 'ready' }; reconcile(m.data.items.map(u => ['assignment:' + u.userId, { assigned: true, expires: u.expires || null }])); renderMain(); renderFooter(); } break;
      case 'assignError': if (m.key === ui.selected) { assignPage = { key: m.key, state: 'error', message: m.message }; renderMain(); } break;
      case 'layoutsLoading': if (m.key === ui.selected && m.object === ui.object) { if (layoutPage && layoutPage.data) layoutPage.refreshing = true; else layoutPage = { key: m.key, object: m.object, state: 'loading' }; renderMain(); } break;
      case 'layouts': if (m.key === ui.selected && m.object === ui.object) { layoutPage = { key: m.key, object: m.object, data: m.data, refreshing: m.refreshing, state: 'ready' }; reconcile(m.data.rows.map(r => [r.key, { layout: r.layout }])); renderMain(); renderFooter(); } break;
      case 'layoutsError': if (m.key === ui.selected && m.object === ui.object) { layoutPage = { key: m.key, object: m.object, state: 'error', message: m.message }; renderMain(); } break;
      case 'componentsLoading': if (m.key === ui.selected) { if (componentsPage && componentsPage.data) componentsPage.refreshing = true; else componentsPage = { key: m.key, state: 'loading' }; renderMain(); } break;
      case 'components': if (m.key === ui.selected) { componentsPage = { key: m.key, data: m.data, refreshing: m.refreshing, state: 'ready' }; reconcile(m.data.components.map(c => ['groupComponent:' + c.permissionSetId, { included: true }])); renderMain(); renderFooter(); } break;
      case 'componentsError': if (m.key === ui.selected) { componentsPage = { key: m.key, state: 'error', message: m.message }; renderMain(); } break;
      case 'groupStatus': {
        const row = lists && lists.group && lists.group.find(r => r.key === m.key);
        if (row) row.status = m.status;
        if (m.key === ui.selected) {
          if (detail && detail.data) detail.data.header.status = m.status;
          if (componentsPage && componentsPage.data) componentsPage.data.status = m.status;
          renderMain();
        }
        renderList();
        break;
      }
      case 'loginLoading': if (m.key === ui.selected) { if (loginPage && loginPage.data) loginPage.refreshing = true; else loginPage = { key: m.key, state: 'loading' }; renderMain(); } break;
      case 'loginSettings': if (m.key === ui.selected) { loginPage = { key: m.key, data: m.data, refreshing: m.refreshing, state: 'ready' }; reconcile([['loginHours:all', m.data.hours || {}], ['loginIpRanges:all', { ranges: m.data.ranges || [] }]]); renderMain(); renderFooter(); } break;
      case 'loginError': if (m.key === ui.selected) { loginPage = { key: m.key, state: 'error', message: m.message }; renderMain(); } break;
      case 'users': userResults = { text: m.text, users: m.users || [], message: m.message }; if (m.text === ui.userQuery) renderMain(); break;
      case 'localFile': if (m.key === ui.selected) localFile = { key: m.key, path: m.path, mode: m.mode }; break;
      case 'lookupResult': lookup.busy = false; lookup.result = m.error ? { error: m.error } : m.result; lookup.f.profile = 'any'; lookup.f.license = 'any'; if (ui.tool === 'lookup') renderMain(); break;
      case 'wizardFields':
        if (lookup.object === m.object || lookup.fieldsFor === m.object) lookup.fields = m.fields;
        if (wizard.object === m.object) wizard.fields = m.fields;
        if (m.message) toast('error', m.message, { title: 'Could not read ' + m.object });
        if (ui.tool === 'lookup' || ui.tool === 'wizard') renderMain();
        break;
      case 'wizardPlan': wizard.busy = false; wizard.plan = m; if (ui.tool === 'wizard') renderMain(); break;
      case 'wizardProgress': { const w = applyTarget === 'revoke' && lookup.revoke ? lookup.revoke : wizard; w.progress = { label: m.label, done: m.done, total: m.total }; renderMain(); break; }
      case 'wizardResult': {
        const w = applyTarget === 'revoke' && lookup.revoke ? lookup.revoke : wizard;
        w.progress = null;
        if (m.error) w.applyError = m.error; else { w.results = m.results; w.plan = null; if (ui.selected && m.results.some(r => r.key === ui.selected)) detail = null; }
        applyTarget = 'wizard';
        renderMain();
        break;
      }
      case 'wizardCurrent': if (wizard.object === m.object) { wizard.current = { byKey: m.byKey || {} }; if (m.message) toast('error', m.message, { title: 'Could not read current access' }); if (ui.tool === 'wizard') renderMain(); } break;
      case 'objWizardCurrent': if (objWizard.object === m.object) { objWizard.current = { byKey: m.byKey || {} }; if (m.message) toast('error', m.message, { title: 'Could not read current access' }); if (ui.tool === 'objwizard') renderMain(); } break;
      case 'revokePlan': lookup.revoke = { plan: m.error ? { error: m.error } : { plan: m.plan, skipped: m.skipped }, confirm: '', progress: null, results: null }; if (ui.tool === 'lookup') renderMain(); break;
      case 'historySetup': historySetupData = Object.assign(m.entries || [], { denied: !!m.denied }); if (ui.tool === 'history') renderMain(); break;
      case 'persisted': {
        const v = m.values || {};
        recentLookups = v.recentLookups || []; grantTemplates = v.grantTemplates || []; lastTicket = v.lastTicket || '';
        if (v.pending && v.pending.entries && v.pending.entries.length && !pending.size) {
          restoreSaved = v.pending;
          if (ui.selected !== v.pending.key) choose(v.pending.key); else restorePending();
        }
        break;
      }
      case 'shortcut': if (m.name === 'save' && Date.now() - lastKeyShortcut > 600) shortcutSave(); break;
      case 'history': historyData = m.entries || []; if (ui.tool === 'history') renderMain(); break;
      case 'objWizardInfo': if (objWizard.object === m.object) { objWizard.info = { recordTypes: m.recordTypes, columns: m.columns }; if (m.message) toast('error', m.message, { title: 'Could not read ' + m.object }); if (ui.tool === 'objwizard') renderMain(); } break;
      case 'objWizardPlan': objWizard.busy = false; objWizard.plan = m; if (ui.tool === 'objwizard') renderMain(); break;
      case 'objWizardProgress': objWizard.progress = { label: m.label, done: m.done, total: m.total }; if (ui.tool === 'objwizard') renderMain(); break;
      case 'objWizardResult':
        objWizard.progress = null;
        if (m.error) objWizard.applyError = m.error; else { objWizard.results = m.results; objWizard.plan = null; if (ui.selected && m.results.some(r => r.key === ui.selected)) detail = null; }
        if (ui.tool === 'objwizard') renderMain();
        break;
      case 'stageChanges':
        if (ui.selected === m.key && detail && detail.data) applyStaged(m);
        else { stageAfterLoad = m; choose(m.key); }
        break;
      case 'cloneProgress': if (modal && modal.kind === 'psForm') { modal.progress = m.label; renderModal(); } break;
      case 'psSaved':
        if (m.error) { if (modal && modal.kind === 'psForm') { modal.progress = null; modal.error = m.error; renderModal(); } else toast('error', m.error, { sticky: true }); break; }
        closeModal();
        if (m.mode === 'copyProfile' && m.counts) {
          const c = m.counts;
          toast('success', 'Copied ' + m.from + ' into ' + m.label + ': ' + [c.objects + ' object', c.fields + ' field', c.system + ' system', c.entities + ' class, page and other', c.tabs + ' tab', c.recordTypes + ' record type'].join(', ') +
            ' permissions. Assign the new permission set, then remove what it duplicates from the profile when you’re ready.', { title: 'Done', sticky: true });
        } else toast('success', { edit: 'Saved ', clone: 'Cloned into ' }[m.mode] + m.label + '.', { title: 'Done' });
        break;
      case 'selectKey': guard(() => {
        const kind = m.key.split(':')[0];
        if (KINDS.some(k => k[0] === kind)) { ui.kind = kind; save(); renderSide(); }
        if (kind === 'group' && !SECTIONS[0][1].some(e => e[0] === ui.section)) ui.section = 'components';
        choose(m.key);
      }); break;
      case 'favorites':
        favs = { items: new Set(m.items || []), objects: new Set(m.objects || []) };
        renderList(); if (detail && detail.data && ui.page !== 'object') renderMain();
        break;
      case 'accessLoading':
        if (m.key !== ui.selected) break;
        if (access[m.category] && access[m.category].data) access[m.category].refreshing = true; else access[m.category] = { key: m.key, state: 'loading' };
        if (ui.section === m.category) renderMain(); break;
      case 'accessDetail':
        if (m.key !== ui.selected) break;
        access[m.category] = { key: m.key, data: m.data, savedAt: m.savedAt, refreshing: m.refreshing, state: 'ready' };
        reconcile(m.data.items.map(x => [m.category + ':' + x.name, { enabled: x.enabled }]));
        if (ui.section === m.category || ui.page === 'detail') renderMain();
        renderFooter(); break;
      case 'accessError':
        if (m.key !== ui.selected) break;
        access[m.category] = { key: m.key, state: 'error', message: m.message }; if (ui.section === m.category) renderMain(); break;
      case 'rtLoading':
        if (m.key !== ui.selected || m.object !== ui.object) break;
        if (rtPage && rtPage.data && rtPage.object === m.object) rtPage.refreshing = true; else rtPage = { key: m.key, object: m.object, state: 'loading' };
        renderMain(); break;
      case 'recordTypes':
        if (m.key !== ui.selected || m.object !== ui.object) break;
        rtPage = { key: m.key, object: m.object, data: m.data, savedAt: m.savedAt, refreshing: m.refreshing, state: 'ready' };
        reconcile(m.data.items.map(t => ['recordType:' + t.name, rtBase(t)]));
        renderMain(); renderFooter(); break;
      case 'rtError':
        if (m.key !== ui.selected || m.object !== ui.object) break;
        rtPage = { key: m.key, object: m.object, state: 'error', message: m.message }; renderMain(); break;
      default: break;
    }
  });

  /** Stages changes sent by the extension (undo of a save) for review like any other edit. */
  function applyStaged(m) {
    const empty = { field: { read: false, edit: false }, user: { enabled: false }, recordType: { visible: false }, tab: { visibility: 'None' }, assignment: { assigned: false, expires: null },
      loginHours: {}, loginIpRanges: { ranges: [] }, layoutAssignment: { layout: '' }, groupComponent: { included: false } };
    pending.clear();
    for (const c of m.changes) {
      const cat = c.key.slice(0, c.key.indexOf(':'));
      const name = c.key.slice(c.key.indexOf(':') + 1);
      const blank = cat === 'object' ? Object.fromEntries(detail.data.objectColumns.map(x => [x, false])) : ACCESS_TABS.some(t => t[0] === cat) ? { enabled: false } : empty[cat] || {};
      const before = c.before || blank;
      const after = c.after || blank;
      if (differs(before, after)) pending.set(c.key, { before, after, touched: new Set(Object.keys(after)), label: name.replace(/^.*\./, '') || name, cat, ref: c.ref || null });
    }
    ui.tool = null;
    renderTop(); renderMain(); renderFooter();
    if (pending.size) openModal({ kind: 'review' });
    else toast('info', 'Nothing to undo: the org already has the values from before that save.');
  }

  // Keyboard: Ctrl/Cmd+S reviews, then saves; Esc closes a dialog or leaves a tool page; / jumps to search.
  function shortcutSave() {
    if (saving) return;
    if (modal && modal.kind === 'review') { const b = document.getElementById('saveBtn'); if (b && !b.disabled) doSave(false); return; }
    if (!modal && pending.size && detail && detail.data) openModal({ kind: 'review' });
  }
  document.addEventListener('keydown', e => {
    const tag = (e.target && e.target.tagName) || '';
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag);
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); lastKeyShortcut = Date.now(); shortcutSave(); return; }
    if (e.key === 'Escape') {
      if (modal && !saving) { e.preventDefault(); closeModal(); return; }
      if (!modal && ui.tool && !typing) { e.preventDefault(); closeTool(); return; }
    }
    if (e.key === '/' && !typing && !modal && !e.ctrlKey && !e.metaKey) {
      const inp = document.querySelector('main .search input') || document.querySelector('.split .search input');
      if (inp) { e.preventDefault(); inp.focus(); inp.select(); }
    }
  });
  // Copy an API name: a small button appears on hover over any API name cell.
  document.addEventListener('mouseover', e => {
    const td = e.target && e.target.closest ? e.target.closest('td.mono') : null;
    if (!td || td.querySelector('.copy-btn') || !td.textContent.trim()) return;
    const tr = td.closest('tr');
    const dr = tr && tr.getAttribute('data-row');
    const text = dr && dr.includes(':') && !/^(assignment|groupComponent):/.test(dr) ? dr.slice(dr.indexOf(':') + 1) : td.textContent.trim();
    td.appendChild(h('button', { class: 'copy-btn', title: 'Copy ' + text, 'aria-label': 'Copy ' + text, onclick: ev => { ev.stopPropagation(); send({ type: 'copy', text }); } }, copyIcon()));
  });
  setInterval(() => { if (!listsMeta.refreshing && lists) renderTop(); }, 60000);

  renderTop(); renderMain();
  send({ type: 'ready' });
})();
