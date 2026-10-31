'use strict';

const { str, assertId } = require('./soql');
const { key, emptyModel } = require('../model/model');

/**
 * Reads permissions for one permission set (or the PermissionSet behind a
 * profile or group) straight from the org.
 *
 * Field lists come from describe rather than being hard-coded, so the same
 * code works on orgs at different API versions (PermissionsViewAllFields, for
 * example, does not exist on older ones) and picks up new system permissions
 * as Salesforce adds them. Independent reads run in parallel; the
 * connection caps how many are in flight.
 */

const OBJECT_FIELDS = [
  ['PermissionsRead', 'read'], ['PermissionsCreate', 'create'], ['PermissionsEdit', 'edit'],
  ['PermissionsDelete', 'delete'], ['PermissionsViewAllRecords', 'viewAll'],
  ['PermissionsModifyAllRecords', 'modifyAll'], ['PermissionsViewAllFields', 'viewAllFields']
];

/**
 * Splits `items` into groups whose rendered query stays under the
 * connection's length limit. `render(group)` returns the SOQL for a group.
 */
function sliceByLength(items, render, limit) {
  const out = [];
  let cur = [];
  for (const it of items) {
    const next = cur.concat([it]);
    if (cur.length && render(next).length > limit) { out.push(cur); cur = [it]; } else cur = next;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function availableFields(conn, sobject) {
  const d = await conn.describe(sobject);
  return new Set(d.fields.map(f => f.name));
}

/** Object permission columns this org supports, as [field, prop] pairs. */
async function objectColumns(conn) {
  const have = await availableFields(conn, 'ObjectPermissions');
  return OBJECT_FIELDS.filter(([f]) => have.has(f));
}

function objectProps(rec, cols) {
  const props = {};
  for (const [f, p] of cols) props[p] = rec[f] === true;
  return props;
}

/** Object permission rows, keyed "object:<name>"; `ids` gets each row's Id. */
async function loadObjectPermissions(conn, permissionSetId, model, ids, objects) {
  const cols = await objectColumns(conn);
  const base = 'SELECT Id, SobjectType, ' + cols.map(c => c[0]).join(', ') +
    ' FROM ObjectPermissions WHERE ParentId = ' + str(assertId(permissionSetId));
  const queries = objects && objects.length
    ? sliceByLength(objects, g => base + ' AND SobjectType IN (' + g.map(str).join(', ') + ')', conn.maxQueryLength || 5000)
      .map(g => base + ' AND SobjectType IN (' + g.map(str).join(', ') + ')')
    : [base];
  const pages = await Promise.all(queries.map(q => conn.query(q)));
  for (const r of pages) for (const rec of r.records) {
    model.entries.set(key('object', rec.SobjectType), objectProps(rec, cols));
    if (ids) ids.set(key('object', rec.SobjectType), rec.Id);
  }
  return cols;
}

/** System permission columns on PermissionSet, with their labels. */
async function systemPermissionFields(conn) {
  const d = await conn.describe('PermissionSet');
  return d.fields
    .filter(f => f.type === 'boolean' && /^Permissions[A-Z]/.test(f.name))
    .map(f => ({ field: f.name, name: f.name.slice('Permissions'.length), label: f.label }));
}

/**
 * The queries that read a permission set's system permissions. All of them
 * in one short `FIELDS(STANDARD)` query where the org allows it; otherwise
 * (or for a few named ones) the columns are listed, in slices, because ~500
 * columns don't fit in one URL or command line.
 */
function systemQueries(conn, permissionSetId, fields, all) {
  const where = ' FROM PermissionSet WHERE Id = ' + str(assertId(permissionSetId));
  if (all && !conn.noFieldsStandard) return { fieldsStandard: true, queries: ['SELECT FIELDS(STANDARD)' + where] };
  const render = slice => 'SELECT ' + slice.map(f => f.field).join(', ') + where;
  return { fieldsStandard: false, queries: sliceByLength(fields, render, conn.maxQueryLength || 5000).map(render) };
}

function readSystem(results, fields, model, labels) {
  const rec = Object.assign({}, ...results.map(r => r.records[0] || {}));
  for (const f of fields) {
    model.entries.set(key('user', f.name), { enabled: rec[f.field] === true });
    if (labels) labels.set(key('user', f.name), f.label);
  }
}

/** Runs `fn(useFieldsStandard)`; if the org rejects FIELDS(), remembers that and runs it again with column lists. */
async function withFieldsFallback(conn, fn) {
  try { return await fn(); } catch (e) {
    if (conn.noFieldsStandard || !/FIELDS|MALFORMED_QUERY|INVALID_FIELD/i.test((e.errorCode || '') + ' ' + e.message)) throw e;
    conn.noFieldsStandard = true;
    return fn();
  }
}

async function loadSystemPermissions(conn, permissionSetId, model, labels, only) {
  let fields = await systemPermissionFields(conn);
  if (only) fields = fields.filter(f => only.includes(f.name));
  if (!fields.length) return;
  await withFieldsFallback(conn, async () => {
    const q = systemQueries(conn, permissionSetId, fields, !only);
    readSystem(await conn.queryMany(q.queries), fields, model, labels);
  });
}

/**
 * Field permission rows of one permission set. Either every field of one
 * object (`sobject`) or a given list of "Object.Field" names (`fieldNames`).
 */
async function loadFieldRows(conn, permissionSetId, opts) {
  const base = 'SELECT Id, SobjectType, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId = ' + str(assertId(permissionSetId));
  let queries;
  if (opts.sobject) queries = [base + ' AND SobjectType = ' + str(opts.sobject)];
  else {
    const render = g => base + ' AND Field IN (' + g.map(str).join(', ') + ')';
    queries = sliceByLength(opts.fieldNames, render, conn.maxQueryLength || 5000).map(render);
  }
  const pages = await Promise.all(queries.map(q => conn.query(q)));
  return pages.flatMap(p => p.records);
}

/** Field permissions for one object across many permission sets (the matrix view). */
async function loadFieldPermissions(conn, permissionSetIds, sobject) {
  const ids = permissionSetIds.map(assertId);
  const byParent = new Map(ids.map(id => [id, new Map()]));
  const render = slice => 'SELECT ParentId, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions ' +
    'WHERE SobjectType = ' + str(sobject) + ' AND ParentId IN (' + slice.map(str).join(', ') + ')';
  const pages = await Promise.all(sliceByLength(ids, render, conn.maxQueryLength || 5000).map(s => conn.query(render(s))));
  for (const r of pages) for (const rec of r.records) {
    const m = byParent.get(rec.ParentId) || byParent.get(String(rec.ParentId).slice(0, 15));
    if (m) m.set(key('field', rec.Field), { read: rec.PermissionsRead === true, edit: rec.PermissionsEdit === true });
  }
  return byParent;
}

// Objects that never carry object permissions of their own.
const NOT_PERMISSIONABLE = /(__Share|__History|__Feed|__ChangeEvent|__mdt|__e|__x|__b|__hd|__Tag|Share|History|Feed|ChangeEvent|Tag)$/;

/**
 * Objects a permission set can grant access to, for "Show all objects".
 * Uses describe flags when available; the CLI transport only has names,
 * so there the name pattern alone filters.
 */
async function objectCatalog(conn) {
  const g = await conn.globalDescribe();
  return g.sobjects
    .filter(s => !NOT_PERMISSIONABLE.test(s.name))
    .filter(s => s.queryable === undefined || (s.queryable && !s.deprecatedAndHidden && !s.customSetting && (s.custom || s.layoutable)))
    .map(s => ({ name: s.name, label: s.label || s.name, custom: !!s.custom }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

async function objectLabels(conn) {
  const g = await conn.globalDescribe();
  return new Map(g.sobjects.map(s => [s.name, s.label || s.name]));
}

function assigneeCountQuery(item) {
  if (item.kind === 'profile') return 'SELECT COUNT() FROM User WHERE IsActive = true AND ProfileId = ' + str(assertId(item.recordId));
  if (item.kind === 'group') return 'SELECT COUNT() FROM PermissionSetAssignment WHERE Assignee.IsActive = true AND PermissionSetGroupId = ' + str(assertId(item.recordId));
  return 'SELECT COUNT() FROM PermissionSetAssignment WHERE Assignee.IsActive = true AND PermissionSetId = ' + str(assertId(item.permissionSetId));
}

async function countActiveAssignees(conn, item) { return conn.count(assigneeCountQuery(item)); }

/**
 * Object and system permissions, labels and assignee count. The describes
 * come from cache; the data is one batch of queries (one round trip over REST).
 */
async function loadDetail(conn, item) {
  const [cols, sysFields, objLabels] = await Promise.all([objectColumns(conn), systemPermissionFields(conn), objectLabels(conn)]);
  const objQ = 'SELECT Id, SobjectType, ' + cols.map(c => c[0]).join(', ') + ' FROM ObjectPermissions WHERE ParentId = ' + str(assertId(item.permissionSetId));
  return withFieldsFallback(conn, async () => {
    const sys = systemQueries(conn, item.permissionSetId, sysFields, true);
    const results = await conn.queryMany([objQ, assigneeCountQuery(item)].concat(sys.queries));
    const model = emptyModel(item.kind, item.apiName);
    const labels = new Map();
    for (const rec of results[0].records) model.entries.set(key('object', rec.SobjectType), objectProps(rec, cols));
    readSystem(results.slice(2), sysFields, model, labels);
    for (const k of model.entries.keys()) if (k.startsWith('object:')) labels.set(k, objLabels.get(k.slice(7)) || k.slice(7));
    return { model, labels, activeAssignees: results[1].totalSize, objectColumns: cols.map(c => c[1]) };
  });
}

/**
 * One object's page: its object permissions plus every field that can carry
 * field-level security, with whether Edit can be granted.
 * Required fields are not permissionable and are left out, as in Setup.
 */
async function loadObjectDetail(conn, item, sobject) {
  const model = emptyModel(item.kind, item.apiName);
  const [describe, cols] = await Promise.all([conn.describe(sobject), objectColumns(conn)]);
  const id = str(assertId(item.permissionSetId));
  const [objRows, fieldPage] = await conn.queryMany([
    'SELECT Id, SobjectType, ' + cols.map(c => c[0]).join(', ') + ' FROM ObjectPermissions WHERE ParentId = ' + id + ' AND SobjectType = ' + str(sobject),
    'SELECT Id, SobjectType, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId = ' + id + ' AND SobjectType = ' + str(sobject)]);
  for (const rec of objRows.records) model.entries.set(key('object', rec.SobjectType), objectProps(rec, cols));
  const rows = fieldPage.records;
  const granted = new Map(rows.map(r => [r.Field, { read: r.PermissionsRead === true, edit: r.PermissionsEdit === true }]));
  const fields = describe.fields
    .filter(f => f.permissionable === true)
    .map(f => {
      const name = sobject + '.' + f.name;
      const p = granted.get(name) || { read: false, edit: false };
      return { name, apiName: f.name, label: f.label, type: f.type, canEdit: !f.calculated && (f.updateable === true || f.createable === true), read: p.read, edit: p.edit };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  const blank = {};
  for (const [, p] of cols) blank[p] = false;
  return {
    object: sobject, label: describe.label || sobject,
    props: model.entries.get(key('object', sobject)) || blank,
    columns: cols.map(c => c[1]), fields
  };
}

/**
 * Access granted through SetupEntityAccess rows. `ENTITY` maps each
 * category to its setup entity type and how to list the org's entities.
 * Custom metadata types and custom settings share one entity type
 * (CustomEntityDefinition) and are told apart by the list they come from.
 */
const ENTITY = {
  apexClass: { type: 'ApexClass', soql: 'SELECT Id, Name, NamespacePrefix FROM ApexClass ORDER BY Name', label: r => r.Name, name: r => r.Name },
  apexPage: { type: 'ApexPage', soql: 'SELECT Id, Name, MasterLabel, NamespacePrefix FROM ApexPage ORDER BY Name', label: r => r.MasterLabel || r.Name, name: r => r.Name },
  customPermission: { type: 'CustomPermission', soql: 'SELECT Id, DeveloperName, MasterLabel, NamespacePrefix, Description FROM CustomPermission ORDER BY MasterLabel',
    label: r => r.MasterLabel || r.DeveloperName, name: r => r.DeveloperName },
  flow: { type: 'FlowDefinition', soql: 'SELECT DurableId, ApiName, Label, NamespacePrefix FROM FlowDefinitionView ORDER BY Label',
    id: r => r.DurableId, label: r => r.Label || r.ApiName, name: r => r.ApiName },
  app: { type: 'TabSet', soql: "SELECT ApplicationId, Name, Label, NamespacePrefix FROM AppMenuItem WHERE Type = 'TabSet' ORDER BY Label",
    id: r => r.ApplicationId, label: r => r.Label || r.Name, name: r => r.Name },
  connectedApp: { type: 'ConnectedApplication', soql: 'SELECT Id, Name FROM ConnectedApplication ORDER BY Name', label: r => r.Name, name: r => r.Name, noNamespace: true },
  customMetadata: { type: 'CustomEntityDefinition', entities: g => g.sobjects.filter(s => /__mdt$/.test(s.name)) },
  customSetting: { type: 'CustomEntityDefinition', entities: g => g.sobjects.filter(s => s.customSetting === true) }
};

/** Every entity of a category in the org: [{ entityId, name, label, namespace, description }]. */
async function listEntities(conn, cat) {
  const e = ENTITY[cat];
  if (!e) throw new Error('Unknown access category: ' + cat);
  if (e.entities) {
    // Custom metadata types and settings: names from describe, Ids from EntityDefinition.
    const objs = e.entities(await conn.globalDescribe());
    if (!objs.length) return [];
    const render = g => 'SELECT DurableId, QualifiedApiName, Label, NamespacePrefix FROM EntityDefinition WHERE QualifiedApiName IN (' + g.map(str).join(', ') + ')';
    const pages = await Promise.all(sliceByLength(objs.map(o => o.name), render, conn.maxQueryLength || 5000).map(g => conn.query(render(g))));
    return pages.flatMap(p => p.records).map(r => ({ entityId: r.DurableId, name: r.QualifiedApiName, label: r.Label || r.QualifiedApiName, namespace: r.NamespacePrefix || '', description: '' }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
  const r = await conn.query(e.soql);
  return r.records.map(x => ({
    entityId: e.id ? e.id(x) : x.Id, name: (x.NamespacePrefix && !e.noNamespace ? x.NamespacePrefix + '__' : '') + e.name(x),
    label: e.label(x), namespace: x.NamespacePrefix || '', description: x.Description || ''
  }));
}

/** Access rows of one permission set for a category: Map<entityId, accessRowId>. */
async function loadAccessRows(conn, permissionSetId, cat, entityIds) {
  const e = ENTITY[cat];
  const base = 'SELECT Id, SetupEntityId FROM SetupEntityAccess WHERE ParentId = ' + str(assertId(permissionSetId)) + ' AND SetupEntityType = ' + str(e.type);
  let queries = [base];
  if (entityIds) {
    const render = g => base + ' AND SetupEntityId IN (' + g.map(str).join(', ') + ')';
    queries = entityIds.length ? sliceByLength(entityIds, render, conn.maxQueryLength || 5000).map(render) : [];
  }
  const pages = await conn.queryMany(queries);
  const out = new Map();
  for (const p of pages) for (const r of p.records) out.set(r.SetupEntityId, r.Id);
  return out;
}

/** A category tab: every entity in the org with whether this item grants it. */
async function loadEntityAccess(conn, item, cat, entities) {
  const [list, rows] = await Promise.all([entities ? Promise.resolve(entities) : listEntities(conn, cat), loadAccessRows(conn, item.permissionSetId, cat)]);
  return { category: cat, items: list.map(x => Object.assign({}, x, { enabled: rows.has(x.entityId) })) };
}

/** Record types of one object: [{ name: 'Lead.Partner', developerName, label, active }]. */
async function listRecordTypes(conn, sobject) {
  const r = await conn.query('SELECT Id, DeveloperName, Name, NamespacePrefix, IsActive FROM RecordType WHERE SobjectType = ' + str(sobject) + ' ORDER BY Name');
  return r.records.map(x => ({
    id: x.Id, name: sobject + '.' + (x.NamespacePrefix ? x.NamespacePrefix + '__' : '') + x.DeveloperName,
    developerName: x.DeveloperName, label: x.Name, active: x.IsActive !== false
  }));
}

// ---------- tabs, assignments, users ----------

const TAB_FROM_API = { DefaultOn: 'Visible', DefaultOff: 'Available' };

/** Every tab in the org: [{ name, label, sobject }]. */
async function listTabs(conn) {
  const r = await conn.query('SELECT Name, Label, SobjectName, IsCustom FROM TabDefinition ORDER BY Label');
  return r.records.map(t => ({ name: t.Name, label: t.Label || t.Name, sobject: t.SobjectName || '', custom: t.IsCustom === true }));
}

/** A permission set's tab settings: Map<tab name, 'Visible' | 'Available'> (absent = None). */
async function loadTabSettings(conn, permissionSetId, names) {
  let q = 'SELECT Name, Visibility FROM PermissionSetTabSetting WHERE ParentId = ' + str(assertId(permissionSetId));
  if (names) q += ' AND Name IN (' + names.map(str).join(', ') + ')';
  const r = names && !names.length ? { records: [] } : await conn.query(q);
  return new Map(r.records.map(t => [t.Name, TAB_FROM_API[t.Visibility] || t.Visibility]));
}

async function loadTabsPage(conn, item, tabs) {
  const [list, set] = await Promise.all([tabs ? Promise.resolve(tabs) : listTabs(conn), loadTabSettings(conn, item.permissionSetId)]);
  return { items: list.map(t => Object.assign({}, t, { visibility: set.get(t.name) || 'None' })) };
}

/** Whether PermissionSetAssignment has ExpirationDate in this org, and its type. */
async function expirationField(conn) {
  const d = await conn.describe('PermissionSetAssignment');
  const f = d.fields.find(x => x.name === 'ExpirationDate');
  return f ? f.type : null;
}

/** Who has a permission set or group; for a profile, its active users (read-only). */
async function loadAssignments(conn, item) {
  if (item.kind === 'profile') {
    const r = await conn.query('SELECT Id, Name, Username, IsActive, Profile.Name FROM User WHERE IsActive = true AND ProfileId = ' + str(assertId(item.recordId)) + ' ORDER BY Name');
    return { readOnly: true, expiration: null, items: r.records.map(u => ({ userId: u.Id, name: u.Name, username: u.Username, profile: (u.Profile && u.Profile.Name) || '', assigned: true, expires: null })) };
  }
  const exp = await expirationField(conn);
  const where = item.kind === 'group' ? 'PermissionSetGroupId = ' + str(assertId(item.recordId)) : 'PermissionSetId = ' + str(assertId(item.permissionSetId));
  const r = await conn.query('SELECT Id, AssigneeId, Assignee.Name, Assignee.Username, Assignee.IsActive, Assignee.Profile.Name' + (exp ? ', ExpirationDate' : '') +
    ' FROM PermissionSetAssignment WHERE ' + where + ' ORDER BY Assignee.Name');
  return {
    readOnly: false, expiration: exp,
    items: r.records.map(a => ({ userId: a.AssigneeId, name: (a.Assignee && a.Assignee.Name) || a.AssigneeId, username: (a.Assignee && a.Assignee.Username) || '',
      profile: (a.Assignee && a.Assignee.Profile && a.Assignee.Profile.Name) || '', active: !a.Assignee || a.Assignee.IsActive !== false, assigned: true, expires: a.ExpirationDate ? String(a.ExpirationDate).slice(0, 10) : null }))
  };
}

/** Active users whose name or username contains `text`, for adding assignments. */
async function searchUsers(conn, text) {
  const t = String(text || '').trim().replace(/[%_\\']/g, '');
  if (t.length < 2) return [];
  const like = str('%' + t + '%');
  const r = await conn.query('SELECT Id, Name, Username, Profile.Name FROM User WHERE IsActive = true AND (Name LIKE ' + like + ' OR Username LIKE ' + like + ') ORDER BY Name LIMIT 25');
  return r.records.map(u => ({ userId: u.Id, name: u.Name, username: u.Username, profile: (u.Profile && u.Profile.Name) || '' }));
}

/** Object permissions of one object across many permission sets: Map<psId, props>. */
async function loadObjectAccessFor(conn, permissionSetIds, sobject) {
  const cols = await objectColumns(conn);
  const render = g => 'SELECT ParentId, ' + cols.map(c => c[0]).join(', ') + ' FROM ObjectPermissions WHERE SobjectType = ' + str(sobject) + ' AND ParentId IN (' + g.map(str).join(', ') + ')';
  const pages = await Promise.all(sliceByLength(permissionSetIds.map(assertId), render, conn.maxQueryLength || 5000).map(g => conn.query(render(g))));
  const out = new Map();
  for (const p of pages) for (const r of p.records) out.set(r.ParentId, objectProps(r, cols));
  return { byParent: out, columns: cols.map(c => c[1]) };
}

/** Every field permission row of one permission set (for exports). */
async function loadAllFieldRows(conn, permissionSetId) {
  const r = await conn.query('SELECT SobjectType, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId = ' + str(assertId(permissionSetId)) + ' ORDER BY Field');
  return r.records;
}

// ---------- permission set groups ----------

/**
 * A group's members: its permission sets and any muting permission set,
 * with the group's recalculation status. Component rows point at either a
 * PermissionSet or a MutingPermissionSet, so labels come from both.
 */
async function loadGroupComponents(conn, item) {
  const gid = str(assertId(item.recordId));
  const [rows, grp] = await conn.queryMany([
    'SELECT Id, PermissionSetId FROM PermissionSetGroupComponent WHERE PermissionSetGroupId = ' + gid,
    'SELECT Status FROM PermissionSetGroup WHERE Id = ' + gid]);
  const ids = rows.records.map(r => r.PermissionSetId);
  const limit = conn.maxQueryLength || 5000;
  const renderPs = g => 'SELECT Id, Name, Label, NamespacePrefix FROM PermissionSet WHERE Id IN (' + g.map(str).join(', ') + ')';
  const renderMute = g => 'SELECT Id, DeveloperName, MasterLabel FROM MutingPermissionSet WHERE Id IN (' + g.map(str).join(', ') + ')';
  const [ps, mute] = ids.length ? await Promise.all([
    conn.queryMany(sliceByLength(ids, renderPs, limit).map(renderPs)),
    conn.queryMany(sliceByLength(ids, renderMute, limit).map(renderMute)).catch(() => [])
  ]) : [[], []];
  const byId = new Map(ps.flatMap(p => p.records).map(r => [r.Id, { label: r.Label, apiName: (r.NamespacePrefix ? r.NamespacePrefix + '__' : '') + r.Name, managed: !!r.NamespacePrefix }]));
  const muting = new Map(mute.flatMap(p => p.records).map(r => [r.Id, { label: r.MasterLabel || r.DeveloperName, apiName: r.DeveloperName, muting: true }]));
  return {
    status: (grp.records[0] && grp.records[0].Status) || '',
    components: ids.map(id => Object.assign({ permissionSetId: id, label: id, apiName: id, muting: false, managed: false }, byId.get(id) || muting.get(id) || {}))
      .sort((a, b) => (a.muting - b.muting) || a.label.localeCompare(b.label))
  };
}

async function groupStatus(conn, groupId) {
  const r = await conn.query('SELECT Status FROM PermissionSetGroup WHERE Id = ' + str(assertId(groupId)));
  return (r.records[0] && r.records[0].Status) || '';
}

// ---------- who has access ----------

const LOOKUP_OBJECT_FLAG = { read: 'PermissionsRead', create: 'PermissionsCreate', edit: 'PermissionsEdit', delete: 'PermissionsDelete', viewAll: 'PermissionsViewAllRecords', modifyAll: 'PermissionsModifyAllRecords' };

/**
 * Who can read or change an object, or one field of it.
 *
 * A user's access is the union of everything assigned to them, so the two
 * halves of field access (object access, field access) may come from
 * different sources. Sources:
 *   object half  ObjectPermissions with the flag set, or View All Data (read) / Modify All Data (anything else)
 *   field half   FieldPermissions with Read/Edit, or View All Fields on the object (read only)
 * Users come from PermissionSetAssignment, which also covers profiles and groups.
 */
async function whoHasAccess(conn, q) {
  const sobject = q.object;
  const level = q.level || 'read';
  const field = q.field ? (q.field.includes('.') ? q.field : sobject + '.' + q.field) : null;
  const objFlag = field ? (level === 'edit' ? 'PermissionsEdit' : 'PermissionsRead') : LOOKUP_OBJECT_FLAG[level];
  if (!objFlag) throw new Error('Unknown access level: ' + level);
  const system = objFlag === 'PermissionsRead' ? ['PermissionsViewAllData', 'PermissionsModifyAllData'] : ['PermissionsModifyAllData'];
  const [objRows, sysRows, fieldRows, vafRows] = await Promise.all([
    conn.query('SELECT ParentId FROM ObjectPermissions WHERE SobjectType = ' + str(sobject) + ' AND ' + objFlag + ' = true'),
    Promise.all(system.map(f => conn.query('SELECT Id FROM PermissionSet WHERE ' + f + ' = true').then(r => r.records.map(x => [x.Id, f.replace('Permissions', '')])))),
    field ? conn.query('SELECT ParentId FROM FieldPermissions WHERE Field = ' + str(field) + ' AND ' + (level === 'edit' ? 'PermissionsEdit' : 'PermissionsRead') + ' = true') : { records: [] },
    field && level !== 'edit' ? conn.query('SELECT ParentId FROM ObjectPermissions WHERE SobjectType = ' + str(sobject) + ' AND PermissionsViewAllFields = true').catch(() => ({ records: [] })) : { records: [] }
  ]);
  const objectVia = new Map();
  const add = (m, id, why) => { if (!m.has(id)) m.set(id, new Set()); m.get(id).add(why); };
  for (const r of objRows.records) add(objectVia, r.ParentId, 'object');
  for (const list of sysRows) for (const [id, why] of list) add(objectVia, id, why);
  const fieldVia = new Map();
  for (const r of fieldRows.records) add(fieldVia, r.ParentId, 'field');
  for (const r of vafRows.records) add(fieldVia, r.ParentId, 'ViewAllFields');
  const ids = [...new Set([...objectVia.keys(), ...fieldVia.keys()])];
  if (!ids.length) return { object: sobject, field, level, sources: [], users: [] };

  const renderPs = g => 'SELECT Id, Name, Label, NamespacePrefix, IsOwnedByProfile, ProfileId, Profile.Name, PermissionSetGroupId, PermissionSetGroup.MasterLabel FROM PermissionSet WHERE Id IN (' + g.map(str).join(', ') + ')';
  const renderPsa = g => 'SELECT AssigneeId, Assignee.Name, Assignee.Username, Assignee.Profile.Name, PermissionSetId FROM PermissionSetAssignment WHERE Assignee.IsActive = true AND PermissionSetId IN (' + g.map(str).join(', ') + ')';
  const limit = conn.maxQueryLength || 5000;
  const [psPages, psaPages] = await Promise.all([
    Promise.all(sliceByLength(ids, renderPs, limit).map(g => conn.query(renderPs(g)))),
    Promise.all(sliceByLength(ids, renderPsa, limit).map(g => conn.query(renderPsa(g))))
  ]);
  const sources = new Map();
  for (const p of psPages) for (const r of p.records) {
    const kind = r.IsOwnedByProfile ? 'profile' : r.PermissionSetGroupId ? 'group' : 'permissionSet';
    const label = kind === 'profile' ? (r.Profile && r.Profile.Name) : kind === 'group' ? ((r.PermissionSetGroup && r.PermissionSetGroup.MasterLabel) || r.Label) : r.Label;
    sources.set(r.Id, { permissionSetId: r.Id, kind, groupId: r.PermissionSetGroupId || null, profileId: (r.IsOwnedByProfile && r.ProfileId) || null,
      label: label || r.Name, apiName: (r.NamespacePrefix ? r.NamespacePrefix + '__' : '') + r.Name,
      objectVia: [...(objectVia.get(r.Id) || [])], fieldVia: [...(fieldVia.get(r.Id) || [])], users: 0 });
  }
  const users = new Map();
  for (const p of psaPages) for (const a of p.records) {
    const u = users.get(a.AssigneeId) || { userId: a.AssigneeId, name: (a.Assignee && a.Assignee.Name) || a.AssigneeId, username: (a.Assignee && a.Assignee.Username) || '',
      profile: (a.Assignee && a.Assignee.Profile && a.Assignee.Profile.Name) || '', objectFrom: [], fieldFrom: [] };
    const src = sources.get(a.PermissionSetId);
    if (src) src.users++;
    if (objectVia.has(a.PermissionSetId)) u.objectFrom.push(a.PermissionSetId);
    if (fieldVia.has(a.PermissionSetId)) u.fieldFrom.push(a.PermissionSetId);
    users.set(a.AssigneeId, u);
  }
  const granted = [...users.values()].filter(u => u.objectFrom.length && (!field || u.fieldFrom.length));
  const partial = field ? [...users.values()].filter(u => !(u.objectFrom.length && u.fieldFrom.length)) : [];
  const byLabel = (a, b) => a.label.localeCompare(b.label);
  return { object: sobject, field, level, sources: [...sources.values()].sort(byLabel), users: granted.sort((a, b) => a.name.localeCompare(b.name)), partial: partial.sort((a, b) => a.name.localeCompare(b.name)) };
}

module.exports = {
  loadDetail, loadObjectDetail, loadObjectPermissions, loadSystemPermissions, loadFieldRows, loadFieldPermissions,
  systemPermissionFields, countActiveAssignees, objectCatalog, objectLabels, objectColumns, sliceByLength, OBJECT_FIELDS,
  ENTITY, listEntities, loadAccessRows, loadEntityAccess, listRecordTypes,
  loadGroupComponents, groupStatus,
  listTabs, loadTabSettings, loadTabsPage, loadAssignments, expirationField, searchUsers, loadObjectAccessFor, loadAllFieldRows, whoHasAccess, TAB_FROM_API
};
