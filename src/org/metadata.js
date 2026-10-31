'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sfcli = require('./sfcli');
const model = require('../model/model');
const flatXml = require('../xml/flatXml');
const { str, assertId } = require('../data/soql');
const loader = require('../data/loader');

/**
 * Record type assignments, page layout assignments, login hours and login IP
 * ranges have no queryable object, so they are read with a Metadata API
 * retrieve and saved with a Metadata API deploy, both through the Salesforce
 * CLI and both in temporary folders outside the project. Permission set tab
 * settings are read live (PermissionSetTabSetting) and deployed.
 *
 * A deploy carries only the changed entries. Whether
 * a partial permission set or profile deploy can remove access it does not
 * mention is not yet confirmed for every org, so every deploy is guarded:
 * the item's object, field, system and setup-entity access is copied before
 * (`captureSafety`) and counted after (`checkSafety`); anything that went
 * missing is reported and can be put back (`restoreSafety`).
 */

/** The item's Metadata API name. Profiles' file names can differ from their labels, so ask the org. */
async function metadataName(conn, item) {
  if (item.metadataName) return item.metadataName;
  if (item.kind === 'permissionSet') item.metadataName = item.apiName;
  else if (item.kind === 'profile') {
    const r = await conn.query('SELECT Id, FullName FROM Profile WHERE Id = ' + str(assertId(item.recordId)), { tooling: true });
    item.metadataName = (r.records[0] && r.records[0].FullName) || item.apiName;
  } else throw new Error('Record type assignments of a ' + item.kind + ' can’t be read or changed.');
  return item.metadataName;
}

function metaType(item) { return item.kind === 'profile' ? 'Profile' : 'PermissionSet'; }
function suffix(item) { return item.kind === 'profile' ? 'profile' : 'permissionset'; }

function packageXml(types, apiVersion) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
    Object.entries(types).map(([t, members]) => '    <types>\n' + members.map(m => '        <members>' + esc(m) + '</members>\n').join('') +
      '        <name>' + t + '</name>\n    </types>\n').join('') +
    '    <version>' + apiVersion + '</version>\n</Package>\n';
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function findFile(dir, ext) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const f = findFile(p, ext); if (f) return f; } else if (e.name.endsWith('.' + ext)) return p;
  }
  return null;
}

async function withTemp(fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'permstudio-'));
  try { return await fn(dir); } finally { fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

function cliError(e, what) {
  const r = e.cli && e.cli.json && e.cli.json.result;
  const failures = r && r.details && [].concat(r.details.componentFailures || []);
  const msg = failures && failures.length ? failures.map(f => (f.fullName ? f.fullName + ': ' : '') + f.problem).join('\n') : e.message;
  const err = new Error(what + ' failed: ' + msg);
  err.tag = 'REJECTED';
  return err;
}

/** Retrieves the item with the given extra members; returns the parsed file, or null if the org sent none. */
async function retrieveItem(conn, item, members) {
  const name = await metadataName(conn, item);
  return withTemp(async dir => {
    const manifest = path.join(dir, 'package.xml');
    const types = Object.assign({ [metaType(item)]: [name] }, members || {});
    for (const k of Object.keys(types)) if (!types[k] || !types[k].length) delete types[k];
    await fs.promises.writeFile(manifest, packageXml(types, conn.apiVersion));
    const out = path.join(dir, 'out');
    try {
      await sfcli.runResult(conn.sfPath, ['project', 'retrieve', 'start', '--manifest', manifest, '--target-metadata-dir', out, '--unzip',
        '--target-org', conn.username, '--wait', '10'], { cwd: conn.cwd });
    } catch (e) { throw cliError(e, 'Reading from the Metadata API'); }
    const file = fs.existsSync(out) ? findFile(out, suffix(item)) : null;
    return file ? flatXml.parse(await fs.promises.readFile(file, 'utf8')) : null;
  });
}

/** Page layouts of an object: [{ name: 'Lead-Lead Layout', label }]. */
async function listLayouts(conn, sobject) {
  let ids = [sobject];
  if (/__c$/.test(sobject)) {
    const e = await conn.query('SELECT DurableId FROM EntityDefinition WHERE QualifiedApiName = ' + str(sobject));
    if (e.records[0]) ids = ids.concat([e.records[0].DurableId]);
  }
  const r = await conn.query('SELECT Name, NamespacePrefix, TableEnumOrId FROM Layout WHERE TableEnumOrId IN (' + ids.map(str).join(', ') + ')', { tooling: true });
  return r.records.map(l => ({ name: sobject + '-' + (l.NamespacePrefix ? l.NamespacePrefix + '__' : '') + l.Name, label: l.Name }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Entries of a retrieved file in the editor's terms: Map<key, props>. */
function entriesOf(doc, item) {
  const out = new Map();
  const ranges = [];
  for (const e of (doc && doc.entries) || []) {
    const v = e.values;
    if (e.tag === 'recordTypeVisibilities') {
      const p = { visible: v.visible === 'true' };
      if (item.kind === 'profile') p.default = v.default === 'true';
      out.set('recordType:' + v.recordType, p);
    } else if (e.tag === 'layoutAssignments' && v.layout) {
      const obj = v.layout.slice(0, v.layout.indexOf('-'));
      out.set('layoutAssignment:' + (v.recordType || obj + '.'), { layout: v.layout });
    } else if (e.tag === 'loginHours') {
      out.set('loginHours:all', Object.assign({}, v));
    } else if (e.tag === 'loginIpRanges') {
      ranges.push({ startAddress: v.startAddress || '', endAddress: v.endAddress || '', description: v.description || '' });
    }
  }
  out.set('loginIpRanges:all', { ranges });
  if (!out.has('loginHours:all')) out.set('loginHours:all', {});
  return out;
}

/**
 * Current values of metadata-only entries, for the conflict check before a
 * deploy and the read-back after it. One retrieve covers record types,
 * layouts and login settings; permission set tab settings are read live.
 */
async function readEntries(conn, item, keys) {
  const result = new Map();
  const rts = new Set();
  const layoutObjects = new Set();
  let needRetrieve = false;
  const tabs = [];
  for (const k of keys) {
    const cat = k.slice(0, k.indexOf(':'));
    const name = k.slice(k.indexOf(':') + 1);
    if (cat === 'recordType') { rts.add(name); needRetrieve = true; }
    else if (cat === 'layoutAssignment') { layoutObjects.add(name.slice(0, name.indexOf('.'))); if (name.slice(name.indexOf('.') + 1)) rts.add(name); needRetrieve = true; }
    else if (cat === 'loginHours' || cat === 'loginIpRanges') needRetrieve = true;
    else if (cat === 'tab') tabs.push(name);
    else throw new Error(cat + ' is not a metadata entry');
  }
  if (needRetrieve) {
    const layouts = (await Promise.all([...layoutObjects].map(o => listLayouts(conn, o)))).flat().map(l => l.name);
    const doc = await retrieveItem(conn, item, { RecordType: [...rts], Layout: layouts });
    const all = entriesOf(doc, item);
    for (const k of keys) if (!k.startsWith('tab:')) result.set(k, all.get(k) || null);
  }
  if (tabs.length) {
    if (item.kind !== 'permissionSet') throw new Error('Tab settings can only be changed on permission sets in this version.');
    const set = await loader.loadTabSettings(conn, item.permissionSetId, tabs);
    for (const t of tabs) result.set('tab:' + t, { visibility: set.get(t) || 'None' });
  }
  return result;
}

/** Record type visibility for the item: Map<'Lead.Partner', { visible, default? }> (absent = not assigned). */
async function readRecordTypes(conn, item, recordTypeNames) {
  await metadataName(conn, item);
  if (!recordTypeNames.length) return new Map();
  const doc = await retrieveItem(conn, item, { RecordType: recordTypeNames });
  const out = new Map();
  for (const [k, p] of entriesOf(doc, item)) if (k.startsWith('recordType:')) out.set(k.slice('recordType:'.length), p);
  return out;
}

/** Every active record type the item is assigned, across all objects, in one retrieve: [{ name, object, label, default }]. */
async function readAllRecordTypes(conn, item) {
  const r = await conn.query('SELECT DeveloperName, NamespacePrefix, SobjectType, Name FROM RecordType WHERE IsActive = true ORDER BY SobjectType, Name');
  const types = r.records.map(t => ({ name: t.SobjectType + '.' + (t.NamespacePrefix ? t.NamespacePrefix + '__' : '') + t.DeveloperName, object: t.SobjectType, label: t.Name }));
  if (!types.length) return [];
  const vis = await readRecordTypes(conn, item, types.map(t => t.name));
  return types.filter(t => (vis.get(t.name) || {}).visible).map(t => Object.assign(t, { default: (vis.get(t.name) || {}).default === true }));
}

/** Profile page: which layout each record type (and the master) uses. */
async function readLayouts(conn, item, sobject) {
  const [layouts, types] = await Promise.all([listLayouts(conn, sobject), loader.listRecordTypes(conn, sobject)]);
  const doc = await retrieveItem(conn, item, { Layout: layouts.map(l => l.name), RecordType: types.map(t => t.name) });
  const all = entriesOf(doc, item);
  const rows = [{ key: 'layoutAssignment:' + sobject + '.', recordType: null, label: 'Master' }]
    .concat(types.map(t => ({ key: 'layoutAssignment:' + t.name, recordType: t.name, label: t.label })))
    .map(r => Object.assign(r, { layout: (all.get(r.key) || {}).layout || '' }));
  return { object: sobject, layouts, rows };
}

/** Profile login hours and IP ranges. */
async function readLoginSettings(conn, item) {
  if (item.kind !== 'profile') throw new Error('Login hours and IP ranges belong to profiles.');
  const all = entriesOf(await retrieveItem(conn, item, {}), item);
  return { hours: all.get('loginHours:all'), ranges: all.get('loginIpRanges:all').ranges };
}

/** Deploys only the given entries ([{ key, after }]) for the item. */
async function deployEntries(conn, item, changes) {
  const name = await metadataName(conn, item);
  const lines = changes.map(c => model.entryXml(item.kind, c.key, c.after)).filter(Boolean).join('\n');
  const body = item.kind === 'profile'
    ? '<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata">\n    <custom>true</custom>\n' + lines + '\n</Profile>\n'
    : '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n    <label>' + esc(item.label) + '</label>\n' + lines + '\n</PermissionSet>\n';
  return withTemp(async dir => {
    const folder = item.kind === 'profile' ? 'profiles' : 'permissionsets';
    await fs.promises.mkdir(path.join(dir, folder));
    await fs.promises.writeFile(path.join(dir, folder, name + '.' + suffix(item)), body);
    await fs.promises.writeFile(path.join(dir, 'package.xml'), packageXml({ [metaType(item)]: [name] }, conn.apiVersion));
    let r;
    try {
      r = await sfcli.runResult(conn.sfPath, ['project', 'deploy', 'start', '--metadata-dir', dir, '--target-org', conn.username, '--wait', '30'], { cwd: conn.cwd });
    } catch (e) { throw cliError(e, 'The deploy'); }
    return { id: r && r.id, status: r && r.status, body };
  });
}

/** Kept for callers that only change record types. */
function deployRecordTypes(conn, item, entries) {
  return deployEntries(conn, item, entries.map(e => ({ key: 'recordType:' + e.name, after: e })));
}

// ---------- safety copy around a deploy ----------

/** Every object, field, system and setup-entity grant of the item, for checking and restoring. */
async function captureSafety(conn, permissionSetId) {
  const id = str(assertId(permissionSetId));
  const cols = await loader.objectColumns(conn);
  const [objects, fields, entities, sys] = await Promise.all([
    conn.query('SELECT SobjectType, ' + cols.map(c => c[0]).join(', ') + ' FROM ObjectPermissions WHERE ParentId = ' + id),
    conn.query('SELECT SobjectType, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId = ' + id),
    conn.query('SELECT SetupEntityId, SetupEntityType FROM SetupEntityAccess WHERE ParentId = ' + id),
    (async () => { const m = model.emptyModel('permissionSet', ''); await loader.loadSystemPermissions(conn, permissionSetId, m); return m; })()
  ]);
  return {
    objects: objects.records.map(r => { const o = { SobjectType: r.SobjectType }; for (const [f] of cols) o[f] = r[f] === true; return o; }),
    fields: fields.records.map(r => ({ SobjectType: r.SobjectType, Field: r.Field, PermissionsRead: r.PermissionsRead === true, PermissionsEdit: r.PermissionsEdit === true })),
    entities: entities.records.map(r => ({ SetupEntityId: r.SetupEntityId, SetupEntityType: r.SetupEntityType })),
    system: [...sys.entries].filter(([, p]) => p.enabled).map(([k]) => k.slice('user:'.length))
  };
}

/** What the item lost compared with the safety copy: { objects, fields, entities, system } (lists of what's missing). */
async function checkSafety(conn, permissionSetId, safety) {
  const now = await captureSafety(conn, permissionSetId);
  const objNow = new Map(now.objects.map(o => [o.SobjectType, o]));
  const fieldNow = new Map(now.fields.map(f => [f.Field, f]));
  const entNow = new Set(now.entities.map(e => e.SetupEntityId));
  const sysNow = new Set(now.system);
  const lost = {
    objects: safety.objects.filter(o => { const n = objNow.get(o.SobjectType); return !n || Object.keys(o).some(k => o[k] === true && n[k] !== true); }),
    fields: safety.fields.filter(f => { const n = fieldNow.get(f.Field); return !n || (f.PermissionsRead && !n.PermissionsRead) || (f.PermissionsEdit && !n.PermissionsEdit); }),
    entities: safety.entities.filter(e => !entNow.has(e.SetupEntityId)),
    system: safety.system.filter(s => !sysNow.has(s))
  };
  lost.count = lost.objects.length + lost.fields.length + lost.entities.length + lost.system.length;
  return lost;
}

/** Puts back everything `checkSafety` found missing. Returns how many entries were restored. */
async function restoreSafety(conn, permissionSetId, safety) {
  const lost = await checkSafety(conn, permissionSetId, safety);
  if (!lost.count) return 0;
  const id = str(assertId(permissionSetId));
  const [objRows, fieldRows] = await Promise.all([
    conn.query('SELECT Id, SobjectType FROM ObjectPermissions WHERE ParentId = ' + id),
    conn.query('SELECT Id, Field FROM FieldPermissions WHERE ParentId = ' + id)
  ]);
  const objIds = new Map(objRows.records.map(r => [r.SobjectType, r.Id]));
  const fieldIds = new Map(fieldRows.records.map(r => [r.Field, r.Id]));
  const objCreate = lost.objects.filter(o => !objIds.has(o.SobjectType)).map(o => Object.assign({ ParentId: permissionSetId }, o));
  const objUpdate = lost.objects.filter(o => objIds.has(o.SobjectType)).map(o => { const c = Object.assign({ Id: objIds.get(o.SobjectType) }, o); delete c.SobjectType; return c; });
  const fCreate = lost.fields.filter(f => !fieldIds.has(f.Field)).map(f => Object.assign({ ParentId: permissionSetId }, f));
  const fUpdate = lost.fields.filter(f => fieldIds.has(f.Field)).map(f => ({ Id: fieldIds.get(f.Field), PermissionsRead: f.PermissionsRead, PermissionsEdit: f.PermissionsEdit }));
  if (objCreate.length) await conn.create('ObjectPermissions', objCreate);
  if (objUpdate.length) await conn.update('ObjectPermissions', objUpdate);
  if (fCreate.length) await conn.create('FieldPermissions', fCreate);
  if (fUpdate.length) await conn.update('FieldPermissions', fUpdate);
  if (lost.entities.length) await conn.create('SetupEntityAccess', lost.entities.map(e => ({ ParentId: permissionSetId, SetupEntityId: e.SetupEntityId })));
  if (lost.system.length) await conn.update('PermissionSet', [Object.assign({ Id: permissionSetId }, Object.fromEntries(lost.system.map(n => ['Permissions' + n, true])))]);
  return lost.count;
}

module.exports = { metadataName, retrieveItem, listLayouts, entriesOf, readEntries, readRecordTypes, readAllRecordTypes, readLayouts, readLoginSettings, deployEntries, deployRecordTypes,
  captureSafety, checkSafety, restoreSafety, packageXml };
