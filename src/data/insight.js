'use strict';
// Analysis over a whole org: what one user can do (through every profile,
// permission set and group they hold), and how two items' access differs
// (in this org, or the same item in two orgs).
const loader = require('./loader');
const { str, assertId, chunk } = require('./soql');
const { sliceByLength } = loader;

const OBJECT_FLAGS = [['read', 'PermissionsRead'], ['create', 'PermissionsCreate'], ['edit', 'PermissionsEdit'], ['delete', 'PermissionsDelete'],
  ['viewAll', 'PermissionsViewAllRecords'], ['modifyAll', 'PermissionsModifyAllRecords']];
const inList = ids => '(' + ids.map(id => str(assertId(id))).join(', ') + ')';

/** Every query in one call each, for lists of Ids longer than one query allows. */
async function queryIn(conn, ids, render) {
  const out = [];
  for (const g of chunk(ids, 200)) out.push(...(await conn.query(render(inList(g)))).records);
  return out;
}

/** Enabled system permissions of several permission sets: Map<permissionSetId, Set<name>>. */
async function systemPermissionsOf(conn, ids) {
  const fields = await loader.systemPermissionFields(conn);
  const out = new Map(ids.map(id => [id, new Set()]));
  if (!ids.length || !fields.length) return out;
  const names = fields.map(f => f.field);
  const render = g => 'SELECT Id, ' + g.join(', ') + ' FROM PermissionSet WHERE Id IN ' + inList(ids);
  for (const g of sliceByLength(names, render, conn.maxQueryLength || 5000)) {
    for (const r of (await conn.query(render(g))).records) for (const f of g) if (r[f] === true) out.get(r.Id).add(f.slice('Permissions'.length));
  }
  return out;
}

/**
 * What one user can do: the sources of their access (profile, permission sets,
 * groups), permission set licences, and the object, system and custom
 * permissions those sources add up to, each with the sources that grant it.
 */
async function userAccess(conn, userId) {
  const u = (await conn.query('SELECT Id, Name, Username, IsActive, ProfileId, Profile.Name, Profile.UserLicense.Name, UserRole.Name FROM User WHERE Id = ' + str(assertId(userId)))).records[0];
  if (!u) throw new Error('That user no longer exists.');
  const psa = await conn.query('SELECT PermissionSetId, PermissionSetGroupId, ExpirationDate FROM PermissionSetAssignment WHERE AssigneeId = ' + str(u.Id));
  // Labels from the permission sets and groups themselves (sturdier than relationship fields on the assignment).
  const psIds = [...new Set(psa.records.map(a => a.PermissionSetId))];
  const grpIds = [...new Set(psa.records.map(a => a.PermissionSetGroupId).filter(Boolean))];
  const [psRows, grpRows] = await Promise.all([
    psIds.length ? queryIn(conn, psIds, list => 'SELECT Id, Name, Label, IsOwnedByProfile, NamespacePrefix FROM PermissionSet WHERE Id IN ' + list) : [],
    grpIds.length ? queryIn(conn, grpIds, list => 'SELECT Id, MasterLabel, DeveloperName FROM PermissionSetGroup WHERE Id IN ' + list) : []]);
  const psById = new Map(psRows.map(r => [r.Id, r]));
  const grpById = new Map(grpRows.map(r => [r.Id, r]));
  const seen = new Set();
  const sources = psa.records.filter(a => !seen.has(a.PermissionSetId) && seen.add(a.PermissionSetId)).map(a => {
    const ps = psById.get(a.PermissionSetId) || {};
    if (ps.IsOwnedByProfile) return { permissionSetId: a.PermissionSetId, kind: 'profile', label: (u.Profile && u.Profile.Name) || 'Profile', key: 'profile:' + u.ProfileId };
    if (a.PermissionSetGroupId) { const g = grpById.get(a.PermissionSetGroupId) || {}; return { permissionSetId: a.PermissionSetId, kind: 'group', label: g.MasterLabel || g.DeveloperName || 'Group', key: 'group:' + a.PermissionSetGroupId, expires: a.ExpirationDate || null }; }
    return { permissionSetId: a.PermissionSetId, kind: 'permissionSet', label: ps.Label || ps.Name || a.PermissionSetId, key: 'permissionSet:' + a.PermissionSetId, namespace: ps.NamespacePrefix || '', expires: a.ExpirationDate || null };
  }).sort((a, b) => ['profile', 'group', 'permissionSet'].indexOf(a.kind) - ['profile', 'group', 'permissionSet'].indexOf(b.kind) || a.label.localeCompare(b.label));
  const ids = sources.map(s => s.permissionSetId);
  const idx = new Map(ids.map((id, i) => [id, i]));
  const [licenses, objRows, system, custom, customList] = await Promise.all([
    conn.query('SELECT PermissionSetLicense.MasterLabel, PermissionSetLicense.DeveloperName FROM PermissionSetLicenseAssign WHERE AssigneeId = ' + str(u.Id)).then(r => r.records).catch(() => []),
    ids.length ? queryIn(conn, ids, list => 'SELECT ParentId, SobjectType, ' + OBJECT_FLAGS.map(f => f[1]).join(', ') + ' FROM ObjectPermissions WHERE ParentId IN ' + list) : [],
    systemPermissionsOf(conn, ids),
    ids.length ? queryIn(conn, ids, list => "SELECT ParentId, SetupEntityId FROM SetupEntityAccess WHERE SetupEntityType = 'CustomPermission' AND ParentId IN " + list) : [],
    loader.listEntities(conn, 'customPermission').catch(() => [])]);
  const objects = new Map();
  for (const r of objRows) {
    const o = objects.get(r.SobjectType) || { name: r.SobjectType, flags: {} };
    for (const [f, col] of OBJECT_FLAGS) if (r[col] === true) (o.flags[f] = o.flags[f] || []).push(idx.get(r.ParentId));
    objects.set(r.SobjectType, o);
  }
  const labels = await loader.systemPermissionFields(conn).then(fs => new Map(fs.map(f => [f.field.slice('Permissions'.length), f.label]))).catch(() => new Map());
  const sys = new Map();
  for (const [id, set] of system) for (const n of set) (sys.get(n) || sys.set(n, []).get(n)).push(idx.get(id));
  const cpById = new Map(customList.map(c => [c.entityId, c]));
  const cps = new Map();
  for (const r of custom) { const c = cpById.get(r.SetupEntityId); if (c) (cps.get(c.name) || cps.set(c.name, { name: c.name, label: c.label, sources: [] }).get(c.name)).sources.push(idx.get(r.ParentId)); }
  return {
    user: { id: u.Id, name: u.Name, username: u.Username, active: u.IsActive !== false, profile: (u.Profile && u.Profile.Name) || '', license: (u.Profile && u.Profile.UserLicense && u.Profile.UserLicense.Name) || '', role: (u.UserRole && u.UserRole.Name) || '' },
    licenses: licenses.map(l => (l.PermissionSetLicense && (l.PermissionSetLicense.MasterLabel || l.PermissionSetLicense.DeveloperName)) || '').filter(Boolean).sort(),
    sources,
    objects: [...objects.values()].sort((a, b) => a.name.localeCompare(b.name)),
    system: [...sys].map(([name, s]) => ({ name, label: labels.get(name) || name, sources: s })).sort((a, b) => a.label.localeCompare(b.label)),
    custom: [...cps.values()].sort((a, b) => a.label.localeCompare(b.label))
  };
}

/** One object's field access for a user (or every object's, without one), by source: [{ field, read: [sourceIdx], edit: [sourceIdx] }]. */
async function userFieldAccess(conn, permissionSetIds, sobject) {
  if (!permissionSetIds.length) return [];
  const idx = new Map(permissionSetIds.map((id, i) => [id, i]));
  const rows = await queryIn(conn, permissionSetIds, list => 'SELECT ParentId, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ' + (sobject ? 'SobjectType = ' + str(sobject) + ' AND ' : '') + 'ParentId IN ' + list);
  const out = new Map();
  for (const r of rows) {
    const f = out.get(r.Field) || { field: r.Field, read: [], edit: [] };
    if (r.PermissionsRead) f.read.push(idx.get(r.ParentId));
    if (r.PermissionsEdit) f.edit.push(idx.get(r.ParentId));
    out.set(r.Field, f);
  }
  return [...out.values()].sort((a, b) => a.field.localeCompare(b.field));
}

// ---------- compare ----------

const ENTITY_TYPES = { ApexClass: 'apexClass', ApexPage: 'apexPage', CustomPermission: 'customPermission', TabSet: 'app', FlowDefinition: 'flow', ConnectedApplication: 'connectedApp', CustomEntityDefinition: null };

/**
 * Everything an item grants, keyed by name (never by Id), so the same item in
 * two orgs compares correctly: Map<'object:Account', props>, 'field:', 'user:', 'apexClass:', 'tab:' and so on.
 */
async function accessSnapshot(conn, permissionSetId, names) {
  const id = assertId(permissionSetId);
  const out = new Map();
  const [objs, fields, system, ents, tabs] = await Promise.all([
    conn.query('SELECT SobjectType, ' + OBJECT_FLAGS.map(f => f[1]).join(', ') + ' FROM ObjectPermissions WHERE ParentId = ' + str(id)),
    conn.query('SELECT Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId = ' + str(id)),
    systemPermissionsOf(conn, [id]),
    conn.query('SELECT SetupEntityId, SetupEntityType FROM SetupEntityAccess WHERE ParentId = ' + str(id)),
    loader.loadTabSettings(conn, id).catch(() => new Map())]);
  for (const r of objs.records) out.set('object:' + r.SobjectType, Object.fromEntries(OBJECT_FLAGS.map(([f, c]) => [f, r[c] === true])));
  for (const r of fields.records) out.set('field:' + r.Field, { read: r.PermissionsRead === true, edit: r.PermissionsEdit === true });
  for (const n of system.get(id) || []) out.set('user:' + n, { enabled: true });
  for (const r of ents.records) {
    const cat = ENTITY_TYPES[r.SetupEntityType];
    if (cat === undefined) continue;
    const name = await names(cat || 'customMetadata', r.SetupEntityId);
    if (name) out.set((cat || name.cat) + ':' + (name.name || name), { enabled: true });
  }
  for (const [tab, vis] of tabs) out.set('tab:' + tab, { visibility: vis });
  return out;
}

/** A cache of entity names per org, for accessSnapshot: (cat, id) → name. */
function entityNames(conn) {
  const lists = new Map();
  return async (cat, entityId) => {
    if (cat === 'customMetadata') {
      for (const c of ['customMetadata', 'customSetting']) {
        if (!lists.has(c)) lists.set(c, loader.listEntities(conn, c).catch(() => []));
        const hit = (await lists.get(c)).find(x => x.entityId === entityId);
        if (hit) return { cat: c, name: hit.name };
      }
      return null;
    }
    if (!lists.has(cat)) lists.set(cat, loader.listEntities(conn, cat).catch(() => []));
    const hit = (await lists.get(cat)).find(x => x.entityId === entityId);
    return hit ? hit.name : null;
  };
}

const AREAS = { object: 'Object Permissions', field: 'Field Permissions', user: 'System Permissions', app: 'Assigned Apps', apexClass: 'Apex Class Access', apexPage: 'Visualforce Page Access',
  flow: 'Flow Access', connectedApp: 'Connected App Access', customPermission: 'Custom Permissions', customMetadata: 'Custom Metadata Types', customSetting: 'Custom Settings', tab: 'Tab Settings' };
const FLAG_WORDS = { read: 'Read', create: 'Create', edit: 'Edit', delete: 'Delete', viewAll: 'View All', modifyAll: 'Modify All' };

/** In plain words, as the screen shows it. */
function describe(cat, p) {
  if (!p) return cat === 'tab' ? 'Hidden' : 'No access';
  if (cat === 'object') return OBJECT_FLAGS.map(([f]) => f).filter(f => p[f]).map(f => FLAG_WORDS[f]).join(', ') || 'No access';
  if (cat === 'field') return p.edit ? 'Read, Edit' : p.read ? 'Read' : 'No access';
  if (cat === 'tab') return { DefaultOn: 'Visible', Visible: 'Visible', DefaultOff: 'Available', Available: 'Available' }[p.visibility] || 'Hidden';
  return p.enabled ? 'Enabled' : 'Off';
}

/** The differences between two snapshots: [{ area, cat, entry, a, b }] (entries the same on both sides are left out). */
function compareSnapshots(a, b) {
  const out = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const cat = k.slice(0, k.indexOf(':'));
    const entry = k.slice(k.indexOf(':') + 1);
    const da = describe(cat, a.get(k));
    const db = describe(cat, b.get(k));
    if (da !== db) out.push({ area: AREAS[cat] || cat, cat, entry, a: da, b: db });
  }
  const order = Object.keys(AREAS);
  return out.sort((x, y) => order.indexOf(x.cat) - order.indexOf(y.cat) || x.entry.localeCompare(y.entry));
}

/** The comparison as a Markdown table, for tickets and reviews. */
function compareMarkdown(labelA, labelB, rows) {
  const cell = t => String(t).replace(/\|/g, '\\|');
  return ['### ' + labelA + ' compared with ' + labelB, '', rows.length + (rows.length === 1 ? ' difference' : ' differences'), '',
    '| Area | Entry | ' + cell(labelA) + ' | ' + cell(labelB) + ' |', '| --- | --- | --- | --- |']
    .concat(rows.map(r => '| ' + [r.area, r.entry, r.a, r.b].map(cell).join(' | ') + ' |')).join('\n');
}

/** A snapshot as rows, for the Compare export: [{ area, entry, value }]. */
function snapshotRows(snap) {
  const order = Object.keys(AREAS);
  return [...snap].map(([k, p]) => { const cat = k.slice(0, k.indexOf(':')); return { cat, area: AREAS[cat] || cat, entry: k.slice(k.indexOf(':') + 1), value: describe(cat, p) }; })
    .filter(r => !/^(No access|Off|Hidden)$/.test(r.value))
    .sort((a, b) => order.indexOf(a.cat) - order.indexOf(b.cat) || a.entry.localeCompare(b.entry)).map(({ area, entry, value }) => ({ area, entry, value }));
}

module.exports = { snapshotRows, systemPermissionsOf, userAccess, userFieldAccess, accessSnapshot, entityNames, compareSnapshots, compareMarkdown, describe };
