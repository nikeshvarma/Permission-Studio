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
 *     record types, page layouts, login hours, login IP ranges
 *   Tab settings are PermissionSetTabSetting records (API 45.0+), for permission sets and profiles alike.
 *
 * Steps: re-read every touched entry; stop if anything changed since it was
 * staged (unless forced); hand the live values to `onSnapshot` (with a full
 * safety copy when a deploy is involved); write; read back and report
 * anything that did not end up as asked.
 */

const PROP_TO_FIELD = Object.fromEntries(loader.OBJECT_FIELDS.map(([f, p]) => [p, f]));
const ENTITY_CATS = Object.keys(loader.ENTITY);
const META_CATS = ['recordType', 'layoutAssignment', 'loginHours', 'loginIpRanges',
  // Newer kinds of access, profile settings, muting and password / session policies: all Metadata API.
  'agent', 'externalCredential', 'externalDataSource', 'presenceStatus', 'emailRouting', 'defaultApp', 'loginFlow', 'dataCategory', 'passwordPolicy', 'sessionSetting', 'mute'];
/**
 * Deploys that change something other than the item's own access, so the safety
 * copy (which checks the item's access didn't change by accident) doesn't apply:
 * muting deliberately changes the group's access, and policies aren't access at all.
 */
const NO_SAFETY = ['mute', 'passwordPolicy', 'sessionSetting'];
// Tab visibility as stored in PermissionSetTabSetting.Visibility; a hidden tab has no row.
const TAB_TO_API = { Visible: 'DefaultOn', Available: 'DefaultOff' };
const TAB_FROM_API = { DefaultOn: 'Visible', DefaultOff: 'Available' };
const PROFILE_ONLY = ['layoutAssignment', 'loginHours', 'loginIpRanges', 'defaultApp', 'loginFlow', 'dataCategory', 'passwordPolicy', 'sessionSetting'];

/** Why `cat` can't be changed on `item`, or null. Without `cat`: why nothing at all can be. */
function editBlocker(item, cat) {
  if (item.kind === 'profile' && item.standard) return 'Standard profiles can’t be edited.';
  if (cat === 'groupComponent') return item.kind === 'group' ? (item.managed ? 'This group belongs to a managed package and can’t be edited.' : null) : 'Only permission set groups have member permission sets.';
  if (cat === 'assignment') {
    if (item.kind === 'profile') return 'Users get a profile from their user record, not here.';
    return null;
  }
  if (cat === 'mute') return 'Muting is read-only in Permission Studio. Change it in Setup.';
  if (item.kind === 'group') return cat ? 'Permission set group access comes from its permission sets and muting. Edit those permission sets; muting is changed in Setup.'
    : 'A group’s access comes from its permission sets and muting. Change which permission sets it holds under Permission Sets in Group, and its assignments here; edit the permission sets themselves for anything else.';
  if (item.managed) return cat ? 'This permission set belongs to a managed package and can’t be edited.' : 'This permission set belongs to a managed package and can’t be edited; assignments can be changed here.';
  if (cat && PROFILE_ONLY.includes(cat) && item.kind !== 'profile') return 'Only profiles have this.';
  return null;
}

/** Which categories can be edited on the item, for the webview. */
function editableCategories(item) {
  return ['object', 'field', 'user', 'assignment', 'groupComponent', 'tab'].concat(ENTITY_CATS, META_CATS).filter(c => !editBlocker(item, c));
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
  const tabs = [];
  for (const k of keys) {
    const { cat, name } = splitKey(k);
    if (cat === 'tab') { tabs.push(name); continue; }
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
  const [cols, rows, , entityRows, assignRows, memberRows, tabRows] = await Promise.all([
    objects.length ? loader.loadObjectPermissions(conn, permissionSetId, model, ids, objects) : loader.objectColumns(conn),
    fields.length ? loader.loadFieldRows(conn, permissionSetId, { fieldNames: fields }) : [],
    users.length ? loader.loadSystemPermissions(conn, permissionSetId, model, null, users) : null,
    Promise.all(Object.entries(entities).map(async ([cat, ks]) => [ks, await loader.loadAccessRows(conn, permissionSetId, cat, ks.map(k => refs.get(k)))])),
    assignees.length ? readAssignments(conn, item, assignees.map(k => refs.get(k))) : new Map(),
    members.length ? readMembers(conn, item, members.map(k => refs.get(k))) : new Map(),
    tabs.length ? readTabs(conn, permissionSetId, tabs) : new Map()
  ]);
  for (const t of tabs) {
    const row = tabRows.get(t);
    model.entries.set(key('tab', t), { visibility: row ? TAB_FROM_API[row.Visibility] || 'Visible' : 'None' });
    if (row) ids.set(key('tab', t), row.Id);
  }
  for (const r of rows) {
    model.entries.set(key('field', r.Field), { read: r.PermissionsRead === true, edit: r.PermissionsEdit === true });
    // A placeholder row (View All Fields) isn't a record: a grant creates one; Read from it can't be removed here.
    if (loader.realId(r.Id)) ids.set(key('field', r.Field), r.Id);
    else (model.implied || (model.implied = new Set())).add(key('field', r.Field));
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
    if (a && a.raw) (model.rawExpiry || (model.rawExpiry = new Map())).set(k, a.raw);
  }
  for (const k of members) {
    const rowId = memberRows.get(refs.get(k));
    model.entries.set(k, { included: !!rowId });
    if (rowId) ids.set(k, rowId);
  }
  const props = new Map(keys.map(k => [k, model.entries.get(k) || null]));
  return { props, ids, columns: cols.map(c => c[1]), rawExpiry: model.rawExpiry || null, implied: model.implied || new Set() };
}

/** Tab setting rows of a permission set (or a profile's permission set): Map<tab name, { Id, Visibility }>. */
async function readTabs(conn, permissionSetId, names) {
  const out = new Map();
  for (const slice of chunk(names, 200)) {
    const r = await conn.query('SELECT Id, Name, Visibility FROM PermissionSetTabSetting WHERE ParentId = ' + str(assertId(permissionSetId)) +
      ' AND Name IN (' + slice.map(str).join(', ') + ')');
    for (const row of r.records) out.set(row.Name, row);
  }
  return out;
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
    for (const a of r.records) out.set(a.AssigneeId, { id: a.Id, expires: loader.expiryDate(a.ExpirationDate), raw: a.ExpirationDate || null });
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

const realDate = d => { const t = new Date(d + 'T00:00:00Z'); return !isNaN(t) && t.toISOString().slice(0, 10) === d; };
const localToday = () => { const n = new Date(); return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0'); };
const ipNumber = ip => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0);

function validate(changes, columns) {
  const problems = [];
  for (const c of changes) {
    const { cat, name } = splitKey(c.key);
    const a = c.after || {};
    if (cat === 'object' && columns) {
      for (const [flag, needs] of Object.entries(OBJECT_REQUIRES)) {
        if (a[flag] && columns.includes(flag)) for (const n of needs) if (!a[n]) problems.push(name + ': ' + flag + ' needs ' + n);
      }
    }
    if (cat === 'field' && a.edit && !a.read) problems.push(name + ': Edit needs Read');
    if ((cat === 'user' || ENTITY_CATS.includes(cat)) && typeof a.enabled !== 'boolean') problems.push(name + ': no value');
    if (cat === 'recordType' && a.default && !a.visible) problems.push(name + ': a default record type must be assigned');
    if (cat === 'assignment' && a.expires && (!/^\d{4}-\d{2}-\d{2}$/.test(a.expires) || !realDate(a.expires))) problems.push((c.label || name) + ': expiry must be a date');
    else if (cat === 'assignment' && a.expires && a.expires !== (c.before || {}).expires && a.expires < localToday()) problems.push((c.label || name) + ': the expiry date ' + a.expires + ' is in the past; Salesforce needs a future date');
    if (cat === 'tab' && !['Visible', 'Available', 'None'].includes(a.visibility)) problems.push(name + ': unknown tab visibility');
    if (cat === 'groupComponent' && typeof a.included !== 'boolean') problems.push(name + ': no value');
    if (cat === 'loginIpRanges') for (const r of a.ranges || []) {
      if (!IPV4.test(r.startAddress) || !IPV4.test(r.endAddress)) problems.push('IP range ' + r.startAddress + ' – ' + r.endAddress + ': not an IPv4 address');
      else if (ipNumber(r.startAddress) > ipNumber(r.endAddress)) problems.push('IP range ' + r.startAddress + ' – ' + r.endAddress + ': the start address is after the end address');
    }
    if (cat === 'loginHours') for (const [k, v] of Object.entries(a)) if (v !== '' && v != null && !(Number(v) >= 0 && Number(v) <= 1440)) problems.push('Login hours ' + k + ': out of range');
  }
  return problems;
}

/** Changes the screen can send: every category this module knows how to save. */
const KNOWN_CATS = ['object', 'field', 'user', 'assignment', 'groupComponent', 'tab'].concat(ENTITY_CATS, META_CATS);

/**
 * Everything before the first write: validation, what the org has now, the conflict check,
 * the safety copy and snapshot, and the planned record writes. Returns { result } when there is
 * nothing to write (no changes, or a conflict), otherwise the context the write steps use.
 */
async function prepare(conn, item, changes, o) {
  if (!Array.isArray(changes)) throw new Error('These changes are not valid: expected a list of changes.');
  const malformed = changes.filter(c => !c || typeof c.key !== 'string' || !/^\w+:.+/.test(c.key) || !KNOWN_CATS.includes(splitKey(c.key).cat) || !c.after || typeof c.after !== 'object');
  if (malformed.length) throw new Error('These changes are not valid:\n' + malformed.slice(0, 5).map(c => (c && c.key ? c.key : 'an entry') + ': ' + (c && c.key && !KNOWN_CATS.includes(splitKey(String(c.key)).cat) ? 'unknown kind of change' : 'no new value')).join('\n'));
  for (const c of changes) {
    const blocked = editBlocker(item, splitKey(c.key).cat);
    if (blocked) throw new Error(blocked);
  }
  // Everything that can be checked without the org is checked before anything is read from it.
  const early = validate(changes, null);
  if (early.length) throw new Error('These changes are not valid:\n' + early.join('\n'));
  if (!changes.length) return { result: { status: 'saved', count: 0, mismatches: [], snapshot: [] } };
  const psId = item.permissionSetId;
  const metaChanges = changes.filter(c => META_CATS.includes(splitKey(c.key).cat));
  const recordChanges = changes.filter(c => !META_CATS.includes(splitKey(c.key).cat));
  const refs = new Map(changes.filter(c => c.ref).map(c => [c.key, c.ref]));
  if (metaChanges.length && !o.metadata) throw new Error('These changes need the Metadata API, which is not available here.');

  const live = await currentValues(conn, item, changes.map(c => c.key), refs, o.metadata);
  const problems = validate(changes, live.columns);
  // Object permissions only exist for some objects; say so before writing anything, rather than failing halfway.
  if (recordChanges.some(c => c.key.startsWith('object:'))) {
    const allowed = await loader.objectPermissionNames(conn);
    if (allowed) for (const c of recordChanges.filter(x => x.key.startsWith('object:'))) {
      const obj = splitKey(c.key).name;
      if (!allowed.has(obj)) problems.push(obj + ': Salesforce has no object permissions for this object' + (/^(Task|Event)$/.test(obj) ? ' (activity access comes from the Edit Tasks and Edit Events system permissions)' : ''));
    }
  }
  // New assignees must be able to hold the permission set's licence; say so before writing anything.
  const newAssignees = recordChanges.filter(c => c.key.startsWith('assignment:') && c.after.assigned && !(live.props.get(c.key) || {}).assigned);
  if (newAssignees.length && item.kind === 'permissionSet') {
    const users = newAssignees.map(c => refs.get(c.key));
    // When asked, users who only lack the permission set licence get it first.
    if (o.assignLicenses) {
      const fix = await loader.licenseFix(conn, item, users);
      if (fix && fix.users.length) {
        if (o.onProgress) o.onProgress('Assigning the ' + fix.label + ' permission set licence to ' + fix.users.length + (fix.users.length === 1 ? ' user' : ' users'), 0, 1);
        await conn.createRecords(fix.users.map(u => ({ attributes: { type: 'PermissionSetLicenseAssign' }, AssigneeId: u, PermissionSetLicenseId: fix.licenseId })));
      }
    }
    const blocked = await loader.assignmentBlockers(conn, item, users);
    for (const c of newAssignees) if (blocked.has(refs.get(c.key))) problems.push((c.label || refs.get(c.key)) + ' ' + blocked.get(refs.get(c.key)));
  }
  // A profile with Modify All Data has full access to every object, and Salesforce refuses its object permission
  // records ("Cannot insert a record if parent permission set has Modify All Data permission enabled"): say so first.
  const objChanges = item.kind === 'profile' ? recordChanges.filter(c => c.key.startsWith('object:')) : [];
  if (objChanges.length) {
    const madChange = changes.find(c => c.key === 'user:ModifyAllData');
    const mad = madChange ? madChange.after.enabled === true
      : await conn.query('SELECT PermissionsModifyAllData FROM PermissionSet WHERE Id = ' + require('../data/soql').str(item.permissionSetId)).then(r => !!(r.records[0] && r.records[0].PermissionsModifyAllData)).catch(() => false);
    if (mad) problems.push((item.label || item.apiName) + ' has Modify All Data, so its object permissions can’t be changed. Remove: ' + objChanges.map(c => c.label || splitKey(c.key).name).slice(0, 5).join(', ') + (objChanges.length > 5 ? '…' : '') + '.');
  }
  // Never send a field permission Salesforce defines as invalid, whatever screen the change came from:
  // the field must exist and take field permissions, and read-only fields (formula, auto-number, system) take Read only.
  const fieldChanges = recordChanges.filter(c => c.key.startsWith('field:'));
  if (fieldChanges.length && conn.describe) {
    const byObj = new Map();
    for (const c of fieldChanges) { const n = splitKey(c.key).name; const o = n.slice(0, n.indexOf('.')); (byObj.get(o) || byObj.set(o, []).get(o)).push(c); }
    for (const [obj, list] of byObj) {
      const d = await conn.describe(obj).catch(() => null);
      if (!d || !Array.isArray(d.fields)) continue;
      const fields = new Map(d.fields.map(f => [String(f.name).toLowerCase(), f]));
      for (const c of list) {
        const n = splitKey(c.key).name;
        const f = fields.get(n.slice(n.indexOf('.') + 1).toLowerCase());
        const label = c.label || n;
        if (!f) problems.push(label + ': this field no longer exists on ' + obj + '.');
        else if (f.permissionable !== true) problems.push(label + ': Salesforce doesn’t take field permissions on this field.');
        else if (c.after && c.after.edit && (f.calculated || !(f.updateable || f.createable))) problems.push(label + ': this field is read-only, so only Read can be given.');
      }
    }
  }
  // A system permission that needs object access (PermissionDependency, such as Activate Contracts: Read and Edit
  // on Contract) is refused by Salesforce without it: check the item has, or is getting, that access.
  const turningOn = recordChanges.filter(c => c.key.startsWith('user:') && c.after && c.after.enabled && !(c.before && c.before.enabled));
  if (turningOn.length) {
    const deps = conn._permDeps || (conn._permDeps = await loader.permissionDependencies(conn).catch(() => null));
    if (deps && deps.unparsed && deps.unparsed.length && o.log && !conn._loggedUnparsed) { conn._loggedUnparsed = true; o.log('Object requirements in a form Permission Studio does not recognise (not checked before saving): ' + deps.unparsed.slice(0, 20).join('; ')); }
    const needs = turningOn.flatMap(c => ((deps && deps.objects && deps.objects[splitKey(c.key).name]) || []).map(r => ({ c, r })));
    if (needs.length) {
      const madOn = changes.find(c => c.key === 'user:ModifyAllData');
      const mad = madOn ? madOn.after.enabled === true : await conn.query('SELECT PermissionsModifyAllData FROM PermissionSet WHERE Id = ' + str(psId)).then(r => !!(r.records[0] && r.records[0].PermissionsModifyAllData)).catch(() => false);
      if (!mad) {
        const objs = [...new Set(needs.map(n => n.r.object))];
        const have = new Map();
        const rows = await conn.query('SELECT SobjectType, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords FROM ObjectPermissions WHERE ParentId = ' + str(psId) + ' AND SobjectType IN (' + objs.map(str).join(', ') + ')').catch(() => ({ records: [] }));
        for (const r of rows.records) have.set(r.SobjectType, { read: r.PermissionsRead, create: r.PermissionsCreate, edit: r.PermissionsEdit, delete: r.PermissionsDelete, viewAll: r.PermissionsViewAllRecords, modifyAll: r.PermissionsModifyAllRecords });
        for (const c of changes) if (c.key.startsWith('object:')) have.set(splitKey(c.key).name, Object.assign({}, have.get(splitKey(c.key).name) || {}, c.after));
        const FLAG = { read: 'Read', create: 'Create', edit: 'Edit', delete: 'Delete', viewAll: 'View All', modifyAll: 'Modify All' };
        const missing = new Map();
        for (const { c, r } of needs) if (!(have.get(r.object) || {})[r.flag]) (missing.get(c) || missing.set(c, []).get(c)).push(r);
        for (const [c, rs] of missing) {
          const byObj = new Map();
          for (const r of rs) (byObj.get(r.object) || byObj.set(r.object, []).get(r.object)).push(FLAG[r.flag]);
          const what = [...byObj].map(([obj, fl]) => fl.join(' and ') + ' on ' + obj).join('; ');
          problems.push((c.label || splitKey(c.key).name) + ' needs ' + what + '. Add ' + (rs.length === 1 ? 'it' : 'them') + ' in Object Settings, or remove it.');
        }
      }
    }
  }
  // Read that comes from View All Fields isn't a record, so it can't be removed field by field.
  for (const c of recordChanges) if (live.implied && live.implied.has(c.key) && c.after && !c.after.read) problems.push((c.label || splitKey(c.key).name) + ': Read comes from View All Fields on ' + splitKey(c.key).name.split('.')[0] + ', so it can’t be removed here.');
  if (problems.length) throw new Error('These changes are not valid:\n' + problems.join('\n'));

  const conflicts = changes
    .filter(c => differingFlags(c.before, live.props.get(c.key)).length)
    .map(c => ({ key: c.key, before: c.before, now: live.props.get(c.key) }));
  if (conflicts.length && !o.force) return { result: { status: 'conflict', conflicts } };

  // A deploy gets a full copy of the item's access first, so anything it removes by mistake can be put back.
  const needSafety = metaChanges.some(c => !NO_SAFETY.includes(splitKey(c.key).cat));
  const safety = needSafety ? await o.metadata.captureSafety(conn, psId) : null;
  const snapshot = changes.map(c => ({ key: c.key, ref: c.ref || null, before: live.props.get(c.key), after: c.after }));
  const snapshotId = o.onSnapshot ? await o.onSnapshot(snapshot, safety) : null;
  const exp = recordChanges.some(c => c.key.startsWith('assignment:')) ? await loader.expirationField(conn) : null;
  const writes = planWrites(item, recordChanges, live, refs, exp);
  return { item, psId, changes, metaChanges, recordChanges, refs, live, safety, snapshot, snapshotId, exp, writes,
    groupWait: { pollMs: o.pollMs || 3000, maxMs: o.maxGroupWaitMs || 5 * 60 * 1000 } };
}

const recordCountOf = w => w.creates.length + w.updates.length + w.deletes.length;
/** Composite subrequests a set of writes needs: one per 200 records of each kind of write (at most 25 per request). */
const subrequestsOf = w => Math.ceil(w.creates.length / 200) + Math.ceil(w.updates.length / 200) + Math.ceil(w.deletes.length / 200);

/** When a one-request save isn't used, re-read what is there now and plan only what didn't land. */
async function replan(conn, ctx) {
  const now = await currentValues(conn, ctx.item, ctx.recordChanges.map(c => c.key), ctx.refs, null);
  const left = ctx.recordChanges.filter(c => differingFlags(c.after, now.props.get(c.key)).length);
  ctx.writes = planWrites(ctx.item, left, now, ctx.refs, ctx.exp);
}

/** The writes not yet made (step by step: records, then any deploy), each retried while a group recalculates. */
async function writeSteps(conn, ctx, o, oneRequest) {
  const { item, metaChanges, safety, psId, snapshotId, groupWait } = ctx;
  const creates = oneRequest ? [] : ctx.writes.creates;
  const updates = oneRequest ? [] : ctx.writes.updates;
  const deletes = oneRequest ? [] : ctx.writes.deletes;
  const steps = [];
  const step = (label, list, run) => { if (list.length) steps.push([label, run]); };
  step(describeWrite('Adding', creates), creates, () => conn.createRecords(creates));
  step(describeWrite('Updating', updates), updates, () => conn.updateRecords(updates));
  step(describeWrite('Removing', deletes), deletes, () => conn.destroyRecords(deletes));
  if (metaChanges.length) {
    steps.push(['Deploying ' + describeMeta(metaChanges), async () => {
      await o.metadata.deployEntries(conn, item, metaChanges);
      const lost = safety ? await o.metadata.checkSafety(conn, psId, safety) : { count: 0 };
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
    try {
      // Each write starts the group recalculating; when Salesforce refuses the next one
      // for that reason, wait until the group is done and send it again.
      for (let attempt = 0; ; attempt++) {
        try { await run(); break; } catch (e) {
          if (!isGroupUpdating(e) || attempt >= 6) throw e;
          await waitForGroups(conn, item, Object.assign({ force: true }, groupWait), msg => o.onProgress && o.onProgress(msg, done.length, steps.length));
        }
      }
    } catch (e) {
      e.snapshotId = snapshotId;
      e.completedSteps = (oneRequest ? ['Saving in one request'] : []).concat(done);
      e.failedStep = label;
      throw e;
    }
    done.push(label);
  }
  if (oneRequest) done.unshift('Saving in one request');
  return done;
}

/** After the writes: read everything back and report what the org didn't take. */
async function verify(conn, ctx, o, oneRequest) {
  const after = await currentValues(conn, ctx.item, ctx.changes.map(c => c.key), ctx.refs, o.metadata);
  const mismatches = ctx.changes
    .filter(c => differingFlags(c.after, after.props.get(c.key)).length)
    .map(c => ({ key: c.key, label: c.label || null, wanted: c.after, now: after.props.get(c.key), raw: (after.rawExpiry && after.rawExpiry.get(c.key)) || undefined }));
  return { status: 'saved', count: ctx.changes.length, mismatches, snapshotId: ctx.snapshotId, snapshot: ctx.snapshot, now: [...after.props], oneRequest };
}

async function apply(conn, item, changes, options) {
  const o = options || {};
  const ctx = await prepare(conn, item, changes, o);
  if (ctx.result) return ctx.result;
  const recordCount = recordCountOf(ctx.writes);
  // If a group this item belongs to is still recalculating from an earlier change, the
  // first write would be refused: wait for it first.
  if (recordCount || ctx.metaChanges.length) await waitForGroups(conn, item, ctx.groupWait, msg => o.onProgress && o.onProgress(msg, 0, 1));
  // First choice: every record change in one Composite request, one transaction. If the
  // org refuses it for any reason, re-read what is there now and carry on step by step
  // with whatever did not land.
  let oneRequest = false;
  if (recordCount && conn.compositeWrite && conn.mode !== 'cli') {
    if (o.onProgress) o.onProgress('Saving ' + (recordCount === 1 ? 'the change' : 'all ' + recordCount + ' record changes') + ' in one request', 0, 1);
    try {
      await conn.compositeWrite(ctx.writes);
      oneRequest = true;
    } catch (e) {
      if (o.log) o.log('One-request save not used (' + String(e.message || e).split('\n')[0] + '); saving step by step');
      await replan(conn, ctx);
    }
  }
  await writeSteps(conn, ctx, o, oneRequest);
  if (o.onProgress) o.onProgress('Checking the result', 1, 2);
  return verify(conn, ctx, o, oneRequest);
}

const mergedWrites = list => ({ creates: [].concat(...list.map(c => c.writes.creates)), updates: [].concat(...list.map(c => c.writes.updates)), deletes: [].concat(...list.map(c => c.writes.deletes)) });
/**
 * Items grouped into as few one-request saves as Composite allows (25 subrequests of up to 200
 * records each), keeping each item whole and in order. Items with nothing to write are left out.
 */
function batchesOf(ctxs) {
  const batches = [];
  let cur = [];
  for (const c of ctxs) {
    if (!recordCountOf(c.writes)) continue;
    if (cur.length && subrequestsOf(mergedWrites(cur.concat([c]))) > 25) { batches.push(cur); cur = []; }
    cur.push(c);
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/**
 * Many items at once (the Grant screens, Find access, the health check): every item is checked
 * and snapshotted as in apply(), then the record changes of all of them go in one Composite
 * request (as few as the limit allows: 25 subrequests of up to 200 records), so a group isn't
 * recalculated between one permission set and the next. Deploys (record types) follow per item,
 * then each item is read back. entries: [{ item, changes, options }]. Returns one result per
 * entry, in order: apply()'s result, or { error }.
 * options.onProgress(label, done, total, counts) gets { changesSaved, changesTotal } too.
 */
async function applyMany(conn, entries, options) {
  const o = options || {};
  const results = new Array(entries.length);
  const ctxs = [];
  const changesTotal = entries.reduce((n, e) => n + (Array.isArray(e.changes) ? e.changes.length : 0), 0);
  let changesSaved = 0;
  const units = entries.length * 2 + 1;
  let done = 0;
  const tick = label => { if (o.onProgress) o.onProgress(label, done, units, { changesSaved, changesTotal }); };
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const eo = Object.assign({}, o, e.options || {}, { onProgress: null });
    tick('Checking ' + (e.item.label || e.item.apiName) + ' before saving');
    try {
      const ctx = await prepare(conn, e.item, e.changes, eo);
      if (ctx.result) results[i] = ctx.result;
      else { ctx.index = i; ctx.o = eo; ctxs.push(ctx); }
    } catch (err) { results[i] = { error: err }; }
    done++;
  }
  // A group that is still recalculating would refuse the write: wait for it once, before saving anything.
  for (const c of ctxs) if (recordCountOf(c.writes) || c.metaChanges.length) await waitForGroups(conn, c.item, c.groupWait, msg => tick(msg));
  const batches = batchesOf(ctxs);
  for (const b of batches) {
    const w = mergedWrites(b);
    const n = recordCountOf(w);
    tick('Saving ' + n.toLocaleString() + (n === 1 ? ' change' : ' changes') + (b.length > 1 ? ' to ' + b.length + ' items' : '') + ' in one request');
    if (conn.compositeWrite && conn.mode !== 'cli' && subrequestsOf(w) <= 25) {
      try {
        await conn.compositeWrite(w);
        for (const c of b) { c.oneRequest = true; changesSaved += c.changes.length; }
        continue;
      } catch (e) {
        if (o.log) o.log('One-request save of ' + b.length + ' items not used (' + String(e.message || e).split('\n')[0] + '); saving them one by one');
      }
    }
    for (const c of b) await replan(conn, c);
  }
  done++;
  // The rest per item: step-by-step writes where the one request wasn't used, deploys, then the read-back.
  for (const c of ctxs) {
    tick((c.oneRequest && !c.metaChanges.length ? 'Checking ' : 'Saving ') + (c.item.label || c.item.apiName));
    try {
      await writeSteps(conn, c, Object.assign({}, c.o, { onProgress: label => tick(label) }), !!c.oneRequest);
      if (!c.oneRequest) changesSaved += c.changes.length;
      results[c.index] = await verify(conn, c, c.o, !!c.oneRequest);
    } catch (err) { results[c.index] = { error: err }; }
    done++;
  }
  done = units;
  tick('Done');
  return results;
}

/**
 * The record writes for a set of changes, given what is in the org now:
 * { creates, updates, deletes }, each a list of records of mixed types.
 * Order within each: objects before fields on the way in, fields before
 * objects on the way out.
 */
function planWrites(item, recordChanges, live, refs, exp) {
  const psId = item.permissionSetId;
  const expValue = d => (!d ? null : exp === 'datetime' ? d + 'T00:00:00.000Z' : d);
  const ops = { objCreate: [], objUpdate: [], fieldCreate: [], fieldUpdate: [], fieldDelete: [], objDelete: [], system: {},
    entityCreate: [], entityDelete: [], assignCreate: [], assignUpdate: [], assignDelete: [], memberCreate: [], memberDelete: [],
    tabCreate: [], tabUpdate: [], tabDelete: [] };
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
    } else if (cat === 'tab') {
      const v = TAB_TO_API[c.after.visibility];
      if (v && id) ops.tabUpdate.push({ Id: id, Visibility: v });
      else if (v) ops.tabCreate.push({ ParentId: psId, Name: name, Visibility: v });
      else if (id) ops.tabDelete.push(id);
    }
  }
  const T = (type, list) => list.map(r => Object.assign({ attributes: { type } }, r));
  return {
    creates: [].concat(T('ObjectPermissions', ops.objCreate), T('FieldPermissions', ops.fieldCreate), T('SetupEntityAccess', ops.entityCreate),
      T('PermissionSetAssignment', ops.assignCreate), T('PermissionSetGroupComponent', ops.memberCreate), T('PermissionSetTabSetting', ops.tabCreate)),
    updates: [].concat(T('ObjectPermissions', ops.objUpdate), T('FieldPermissions', ops.fieldUpdate),
      // A profile's system permissions are on the Profile record: Salesforce refuses edits to a profile's own
      // permission set ("You can't create, edit, or delete this permission set because it's associated with a profile").
      Object.keys(ops.system).length ? (item.kind === 'profile' && item.recordId ? T('Profile', [Object.assign({ Id: item.recordId }, ops.system)]) : T('PermissionSet', [Object.assign({ Id: psId }, ops.system)])) : [], T('PermissionSetAssignment', ops.assignUpdate),
      T('PermissionSetTabSetting', ops.tabUpdate)),
    deletes: [].concat(T('FieldPermissions', ops.fieldDelete.map(Id => ({ Id }))), T('SetupEntityAccess', ops.entityDelete.map(Id => ({ Id }))),
      T('ObjectPermissions', ops.objDelete.map(Id => ({ Id }))), T('PermissionSetAssignment', ops.assignDelete.map(Id => ({ Id }))),
      T('PermissionSetGroupComponent', ops.memberDelete.map(Id => ({ Id }))), T('PermissionSetTabSetting', ops.tabDelete.map(Id => ({ Id }))))
  };
}

function describeWrite(verb, records) {
  const names = { ObjectPermissions: 'object access', FieldPermissions: 'field access', SetupEntityAccess: 'class, page and other access', PermissionSet: 'system permissions',
    PermissionSetAssignment: 'assignments', PermissionSetGroupComponent: 'group members', PermissionSetTabSetting: 'tab settings' };
  const kinds = [...new Set(records.map(r => names[r.attributes.type]))];
  return verb + ' ' + (kinds.length > 2 ? kinds.slice(0, -1).join(', ') + ' and ' + kinds[kinds.length - 1] : kinds.join(' and '));
}

/** Salesforce refuses changes to a group's permission set while the group recalculates. */
function isGroupUpdating(e) { return /permission set group is updating|group update completes/i.test(String(e && e.message)); }

/**
 * Waits while any permission set group this item belongs to (or the item
 * itself, for a group) is recalculating. With `force`, waits even if the
 * status hasn't caught up yet. Throws after maxMs with what to do next.
 */
async function waitForGroups(conn, item, opts, progress) {
  let groupIds;
  if (item.kind === 'group') groupIds = [item.recordId];
  else {
    const r = await conn.query('SELECT PermissionSetGroupId FROM PermissionSetGroupComponent WHERE PermissionSetId = ' + str(assertId(item.permissionSetId)));
    groupIds = [...new Set(r.records.map(x => x.PermissionSetGroupId))];
  }
  if (!groupIds.length) return;
  const started = Date.now();
  for (let first = true; ; first = false) {
    const r = await conn.query('SELECT Id, DeveloperName, Status FROM PermissionSetGroup WHERE Id IN (' + groupIds.map(str).join(', ') + ')');
    const busy = r.records.filter(g => g.Status === 'Updating');
    if (!busy.length && !(first && opts.force)) return;
    const names = busy.length ? busy.map(g => g.DeveloperName).join(', ') : r.records.map(g => g.DeveloperName).join(', ');
    if (Date.now() - started > opts.maxMs) {
      const err = new Error('Salesforce is still recalculating ' + names + ' after ' + Math.round(opts.maxMs / 60000) + ' minutes, so the rest of this save was not sent. Save again once the group shows Updated.');
      err.tag = 'GROUP_BUSY';
      throw err;
    }
    if (progress) progress('Waiting for Salesforce to finish recalculating ' + names + (Date.now() - started > 5000 ? ' (' + Math.round((Date.now() - started) / 1000) + ' s so far)' : '') + '…');
    await new Promise(res => setTimeout(res, opts.pollMs));
  }
}

function describeMeta(changes) {
  const names = { recordType: 'record type assignments', layoutAssignment: 'page layout assignments', loginHours: 'login hours', loginIpRanges: 'login IP ranges',
    mute: 'muted permissions', defaultApp: 'the default app', loginFlow: 'the login flow', dataCategory: 'data category visibility', passwordPolicy: 'the password policy',
    sessionSetting: 'session settings', agent: 'agent access', externalCredential: 'external credential access', externalDataSource: 'external data source access',
    presenceStatus: 'presence status access', emailRouting: 'email routing address access' };
  return [...new Set(changes.map(c => names[splitKey(c.key).cat] || 'settings'))].join(', ');
}

module.exports = { apply, applyMany, batchesOf, subrequestsOf, currentValues, editBlocker, editableCategories };
