'use strict';

const { splitKey, emptyModel, key } = require('../model/model');
const { differingFlags } = require('../model/diff');
const { OBJECT_REQUIRES } = require('../model/dependencies');
const loader = require('../data/loader');
const { str, assertId, chunk } = require('../data/soql');

/**
 * Saves staged edits for one item by writing only what changes.
 *
 *   records (direct writes)
 *     object permissions        ObjectPermissions rows: insert, update, or delete when no access is left
 *     field permissions         FieldPermissions rows: insert, update, or delete when Read is removed
 *     system permissions        one update of the PermissionSet record
 *     classes, pages, custom permissions, flows, apps, connected apps,
 *     custom metadata types, custom settings   SetupEntityAccess rows: insert or delete
 *     assignments               PermissionSetAssignment rows: insert, update (expiry), delete
 *     group members             PermissionSetGroupComponent rows: insert, delete (groups only)
 *   metadata (guarded deploy, see src/org/metadata.js)
 *     record types, page layouts, login hours, login IP ranges, tab settings
 *
 * Steps: re-read every touched entry; stop if anything changed since it was
 * staged (unless forced); hand the live values to `onSnapshot` (with a full
 * safety copy when a deploy is involved); write; read back and report
 * anything that did not end up as asked.
 */

const PROP_TO_FIELD = Object.fromEntries(loader.OBJECT_FIELDS.map(([f, p]) => [p, f]));
const ENTITY_CATS = Object.keys(loader.ENTITY);
const META_CATS = ['recordType', 'layoutAssignment', 'loginHours', 'loginIpRanges', 'tab'];
const PROFILE_ONLY = ['layoutAssignment', 'loginHours', 'loginIpRanges'];

/** Why `cat` can't be changed on `item`, or null. Without `cat`: why nothing at all can be. */
function editBlocker(item, cat) {
  if (item.kind === 'profile' && item.standard) return 'Standard profiles can’t be edited.';
  if (cat === 'groupComponent') return item.kind === 'group' ? (item.managed ? 'This group belongs to a managed package and can’t be edited.' : null) : 'Only permission set groups have member permission sets.';
  if (cat === 'assignment') {
    if (item.kind === 'profile') return 'Users get a profile from their user record, not here.';
    return null;
  }
  if (item.kind === 'group') return cat ? 'Permission set group access comes from its permission sets and muting. Edit those permission sets instead.'
    : 'A group’s access comes from its permission sets and muting. Change which permission sets it holds under Permission Sets in Group, and its assignments here; edit the permission sets themselves for anything else.';
  if (item.managed) return cat ? 'This permission set belongs to a managed package and can’t be edited.' : 'This permission set belongs to a managed package and can’t be edited; assignments can be changed here.';
  if (cat && PROFILE_ONLY.includes(cat) && item.kind !== 'profile') return 'Only profiles have this.';
  if (cat === 'tab' && item.kind !== 'permissionSet') return 'Profile tab settings can’t be changed in this version.';
  return null;
}

/** Which categories can be edited on the item, for the webview. */
function editableCategories(item) {
  return ['object', 'field', 'user', 'assignment', 'groupComponent'].concat(ENTITY_CATS, META_CATS).filter(c => !editBlocker(item, c));
}

/**
 * Live values of record entries: { props: Map<key, props|null>, ids: Map<key, Id>, columns }.
 * `refs` maps setup-entity keys to the entity's Id and assignment keys to the user's Id.
 */
async function readCurrent(conn, item, keys, refs) {
  const permissionSetId = item.permissionSetId;
  const objects = [];
  const fields = [];
  const users = [];
  const entities = {};
  const assignees = [];
  const members = [];
  for (const k of keys) {
    const { cat, name } = splitKey(k);
    if (cat === 'object') objects.push(name);
    else if (cat === 'field') fields.push(name);
    else if (cat === 'user') users.push(name);
    else if (ENTITY_CATS.includes(cat) || cat === 'assignment' || cat === 'groupComponent') {
      if (!refs || !refs.get(k)) throw new Error('No Salesforce Id for ' + k);
      if (cat === 'assignment') assignees.push(k); else if (cat === 'groupComponent') members.push(k); else (entities[cat] = entities[cat] || []).push(k);
    } else throw new Error('Saving ' + cat + ' entries this way is not supported');
  }
  const model = emptyModel('permissionSet', '');
  const ids = new Map();
  const [cols, rows, , entityRows, assignRows, memberRows] = await Promise.all([
    objects.length ? loader.loadObjectPermissions(conn, permissionSetId, model, ids, objects) : loader.objectColumns(conn),
    fields.length ? loader.loadFieldRows(conn, permissionSetId, { fieldNames: fields }) : [],
    users.length ? loader.loadSystemPermissions(conn, permissionSetId, model, null, users) : null,
    Promise.all(Object.entries(entities).map(async ([cat, ks]) => [ks, await loader.loadAccessRows(conn, permissionSetId, cat, ks.map(k => refs.get(k)))])),
    assignees.length ? readAssignments(conn, item, assignees.map(k => refs.get(k))) : new Map(),
    members.length ? readMembers(conn, item, members.map(k => refs.get(k))) : new Map()
  ]);
  for (const r of rows) {
    model.entries.set(key('field', r.Field), { read: r.PermissionsRead === true, edit: r.PermissionsEdit === true });
    ids.set(key('field', r.Field), r.Id);
  }
  for (const [ks, access] of entityRows) for (const k of ks) {
    const rowId = access.get(refs.get(k));
    model.entries.set(k, { enabled: !!rowId });
    if (rowId) ids.set(k, rowId);
  }
  for (const k of assignees) {
    const a = assignRows.get(refs.get(k));
    model.entries.set(k, a ? { assigned: true, expires: a.expires } : { assigned: false, expires: null });
    if (a) ids.set(k, a.id);
  }
  for (const k of members) {
    const rowId = memberRows.get(refs.get(k));
    model.entries.set(k, { included: !!rowId });
    if (rowId) ids.set(k, rowId);
  }
  const props = new Map(keys.map(k => [k, model.entries.get(k) || null]));
  return { props, ids, columns: cols.map(c => c[1]) };
}

/** The group's component rows for the given permission sets: Map<permissionSetId, rowId>. */
async function readMembers(conn, item, psIds) {
  const out = new Map();
  for (const slice of chunk(psIds, 200)) {
    const r = await conn.query('SELECT Id, PermissionSetId FROM PermissionSetGroupComponent WHERE PermissionSetGroupId = ' + str(assertId(item.recordId)) +
      ' AND PermissionSetId IN (' + slice.map(str).join(', ') + ')');
    for (const row of r.records) out.set(row.PermissionSetId, row.Id);
  }
  return out;
}

async function readAssignments(conn, item, userIds) {
  const exp = await loader.expirationField(conn);
  const where = item.kind === 'group' ? 'PermissionSetGroupId = ' + str(assertId(item.recordId)) : 'PermissionSetId = ' + str(assertId(item.permissionSetId));
  const out = new Map();
  for (const slice of chunk(userIds, 200)) {
    const r = await conn.query('SELECT Id, AssigneeId' + (exp ? ', ExpirationDate' : '') + ' FROM PermissionSetAssignment WHERE ' + where +
      ' AND AssigneeId IN (' + slice.map(str).join(', ') + ')');
    for (const a of r.records) out.set(a.AssigneeId, { id: a.Id, expires: a.ExpirationDate ? String(a.ExpirationDate).slice(0, 10) : null });
  }
  return out;
}

/** Live values for any mix of keys, records and metadata alike. */
async function currentValues(conn, item, keys, refs, metadata) {
  const meta = keys.filter(k => META_CATS.includes(splitKey(k).cat));
  const rec = keys.filter(k => !META_CATS.includes(splitKey(k).cat));
  const [live, liveMeta] = await Promise.all([
    readCurrent(conn, item, rec, refs),
    meta.length ? metadata.readEntries(conn, item, meta) : new Map()
  ]);
  for (const k of meta) live.props.set(k, liveMeta.get(k) || null);
  return live;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function validate(changes, columns) {
  const problems = [];
  for (const c of changes) {
    const { cat, name } = splitKey(c.key);
    const a = c.after || {};
    if (cat === 'object') {
      for (const [flag, needs] of Object.entries(OBJECT_REQUIRES)) {
        if (a[flag] && columns.includes(flag)) for (const n of needs) if (!a[n]) problems.push(name + ': ' + flag + ' needs ' + n);
      }
    }
    if (cat === 'field' && a.edit && !a.read) problems.push(name + ': Edit needs Read');
    if ((cat === 'user' || ENTITY_CATS.includes(cat)) && typeof a.enabled !== 'boolean') problems.push(name + ': no value');
    if (cat === 'recordType' && a.default && !a.visible) problems.push(name + ': a default record type must be assigned');
    if (cat === 'assignment' && a.expires && !/^\d{4}-\d{2}-\d{2}$/.test(a.expires)) problems.push(name + ': expiry must be a date');
    if (cat === 'tab' && !['Visible', 'Available', 'None'].includes(a.visibility)) problems.push(name + ': unknown tab visibility');
    if (cat === 'groupComponent' && typeof a.included !== 'boolean') problems.push(name + ': no value');
    if (cat === 'loginIpRanges') for (const r of a.ranges || []) {
      if (!IPV4.test(r.startAddress) || !IPV4.test(r.endAddress)) problems.push('IP range ' + r.startAddress + ' – ' + r.endAddress + ': not an IPv4 address');
    }
    if (cat === 'loginHours') for (const [k, v] of Object.entries(a)) if (v !== '' && v != null && !(Number(v) >= 0 && Number(v) <= 1440)) problems.push('Login hours ' + k + ': out of range');
  }
  return problems;
}

async function apply(conn, item, changes, options) {
  const o = options || {};
  for (const c of changes) {
    const blocked = editBlocker(item, splitKey(c.key).cat);
    if (blocked) throw new Error(blocked);
  }
  if (!changes.length) return { status: 'saved', count: 0, mismatches: [], snapshot: [] };
  const psId = item.permissionSetId;
  const metaChanges = changes.filter(c => META_CATS.includes(splitKey(c.key).cat));
  const recordChanges = changes.filter(c => !META_CATS.includes(splitKey(c.key).cat));
  const refs = new Map(changes.filter(c => c.ref).map(c => [c.key, c.ref]));
  if (metaChanges.length && !o.metadata) throw new Error('These changes need the Metadata API, which is not available here.');

  const live = await currentValues(conn, item, changes.map(c => c.key), refs, o.metadata);
  const problems = validate(changes, live.columns);
  if (problems.length) throw new Error('These changes are not valid:\n' + problems.join('\n'));

  const conflicts = changes
    .filter(c => differingFlags(c.before, live.props.get(c.key)).length)
    .map(c => ({ key: c.key, before: c.before, now: live.props.get(c.key) }));
  if (conflicts.length && !o.force) return { status: 'conflict', conflicts };

  // A deploy gets a full copy of the item's access first, so anything it removes by mistake can be put back.
  const safety = metaChanges.length ? await o.metadata.captureSafety(conn, psId) : null;
  const snapshot = changes.map(c => ({ key: c.key, ref: c.ref || null, before: live.props.get(c.key), after: c.after }));
  const snapshotId = o.onSnapshot ? await o.onSnapshot(snapshot, safety) : null;

  const exp = recordChanges.some(c => c.key.startsWith('assignment:')) ? await loader.expirationField(conn) : null;
  const expValue = d => (!d ? null : exp === 'datetime' ? d + 'T00:00:00.000Z' : d);
  const ops = { objCreate: [], objUpdate: [], fieldCreate: [], fieldUpdate: [], fieldDelete: [], objDelete: [], system: {},
    entityCreate: [], entityDelete: [], assignCreate: [], assignUpdate: [], assignDelete: [], memberCreate: [], memberDelete: [] };
  for (const c of recordChanges) {
    const { cat, name } = splitKey(c.key);
    const id = live.ids.get(c.key);
    if (cat === 'object') {
      const rec = {};
      for (const p of live.columns) rec[PROP_TO_FIELD[p]] = c.after[p] === true;
      if (Object.values(rec).some(Boolean)) {
        if (id) ops.objUpdate.push(Object.assign({ Id: id }, rec));
        else ops.objCreate.push(Object.assign({ ParentId: psId, SobjectType: name }, rec));
      } else if (id) ops.objDelete.push(id);
    } else if (cat === 'field') {
      const rec = { PermissionsRead: c.after.read === true, PermissionsEdit: c.after.edit === true };
      if (rec.PermissionsRead) {
        if (id) ops.fieldUpdate.push(Object.assign({ Id: id }, rec));
        else ops.fieldCreate.push(Object.assign({ ParentId: psId, SobjectType: name.split('.')[0], Field: name }, rec));
      } else if (id) ops.fieldDelete.push(id);
    } else if (cat === 'user') {
      ops.system['Permissions' + name] = c.after.enabled === true;
    } else if (ENTITY_CATS.includes(cat)) {
      if (c.after.enabled && !id) ops.entityCreate.push({ ParentId: psId, SetupEntityId: refs.get(c.key) });
      if (!c.after.enabled && id) ops.entityDelete.push(id);
    } else if (cat === 'assignment') {
      const target = item.kind === 'group' ? { PermissionSetGroupId: item.recordId } : { PermissionSetId: psId };
      if (c.after.assigned && !id) ops.assignCreate.push(Object.assign({ AssigneeId: refs.get(c.key) }, target, exp && c.after.expires ? { ExpirationDate: expValue(c.after.expires) } : {}));
      else if (c.after.assigned && id && exp) ops.assignUpdate.push({ Id: id, ExpirationDate: expValue(c.after.expires) });
      else if (!c.after.assigned && id) ops.assignDelete.push(id);
    } else if (cat === 'groupComponent') {
      if (c.after.included && !id) ops.memberCreate.push({ PermissionSetGroupId: item.recordId, PermissionSetId: refs.get(c.key) });
      if (!c.after.included && id) ops.memberDelete.push(id);
    }
  }

  // Grants before revokes, objects before their fields on the way in and after them on the way out.
  const steps = [];
  const step = (label, list, run) => { if (Array.isArray(list) ? list.length : Object.keys(list).length) steps.push([label, run]); };
  step('Adding object access', ops.objCreate, () => conn.create('ObjectPermissions', ops.objCreate));
  step('Updating object access', ops.objUpdate, () => conn.update('ObjectPermissions', ops.objUpdate));
  step('Adding field access', ops.fieldCreate, () => conn.create('FieldPermissions', ops.fieldCreate));
  step('Updating field access', ops.fieldUpdate, () => conn.update('FieldPermissions', ops.fieldUpdate));
  step('Updating system permissions', ops.system, () => conn.update('PermissionSet', [Object.assign({ Id: psId }, ops.system)]));
  step('Granting access', ops.entityCreate, () => conn.create('SetupEntityAccess', ops.entityCreate));
  step('Removing access', ops.entityDelete, () => conn.destroy('SetupEntityAccess', ops.entityDelete));
  step('Removing field access', ops.fieldDelete, () => conn.destroy('FieldPermissions', ops.fieldDelete));
  step('Removing object access', ops.objDelete, () => conn.destroy('ObjectPermissions', ops.objDelete));
  step('Assigning users', ops.assignCreate, () => conn.create('PermissionSetAssignment', ops.assignCreate));
  step('Updating expiry dates', ops.assignUpdate, () => conn.update('PermissionSetAssignment', ops.assignUpdate));
  step('Removing assignments', ops.assignDelete, () => conn.destroy('PermissionSetAssignment', ops.assignDelete));
  step('Adding permission sets to the group', ops.memberCreate, () => conn.create('PermissionSetGroupComponent', ops.memberCreate));
  step('Removing permission sets from the group', ops.memberDelete, () => conn.destroy('PermissionSetGroupComponent', ops.memberDelete));
  if (metaChanges.length) {
    steps.push(['Deploying ' + describeMeta(metaChanges), async () => {
      await o.metadata.deployEntries(conn, item, metaChanges);
      const lost = await o.metadata.checkSafety(conn, psId, safety);
      if (lost.count) {
        const e = new Error('The deploy removed ' + lost.count + ' other permission' + (lost.count === 1 ? '' : 's') + ' from this item ' +
          '(' + [lost.objects.length && lost.objects.length + ' object', lost.fields.length && lost.fields.length + ' field',
          lost.entities.length && lost.entities.length + ' class, page or custom permission', lost.system.length && lost.system.length + ' system'].filter(Boolean).join(', ') +
          '). A full copy was saved before the deploy; select Restore to put them back.');
        e.tag = 'DEPLOY_REMOVED';
        e.restorable = true;
        throw e;
      }
    }]);
  }

  const done = [];
  for (const [label, run] of steps) {
    if (o.onProgress) o.onProgress(label, done.length, steps.length);
    try { await run(); } catch (e) {
      e.snapshotId = snapshotId;
      e.completedSteps = done.slice();
      e.failedStep = label;
      throw e;
    }
    done.push(label);
  }

  if (o.onProgress) o.onProgress('Checking the result', steps.length, steps.length + 1);
  const after = await currentValues(conn, item, changes.map(c => c.key), refs, o.metadata);
  const mismatches = changes
    .filter(c => differingFlags(c.after, after.props.get(c.key)).length)
    .map(c => ({ key: c.key, wanted: c.after, now: after.props.get(c.key) }));
  return { status: 'saved', count: changes.length, mismatches, snapshotId, snapshot, now: [...after.props] };
}

function describeMeta(changes) {
  const names = { recordType: 'record type assignments', layoutAssignment: 'page layout assignments', loginHours: 'login hours', loginIpRanges: 'login IP ranges', tab: 'tab settings' };
  return [...new Set(changes.map(c => names[splitKey(c.key).cat]))].join(', ');
}

module.exports = { apply, readCurrent, currentValues, editBlocker, editableCategories, validate, META_CATS, ENTITY_CATS };
