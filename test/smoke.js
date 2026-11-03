'use strict';
// Run with: node test/smoke.js
// A hand-written vscode stand-in, a fake `sf` CLI, and a small stateful org
// (test/fixtures/fake-org.js) that answers the REST calls the extension makes.

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

process.env.NODE_PATH = path.join(__dirname, 'vsmock', 'node_modules') + path.delimiter + (process.env.NODE_PATH || '');
require('module').Module._initPaths();

const ROOT = path.join(__dirname, '..');
const sfcli = require('../src/org/sfcli');
const orgs = require('../src/org/orgs');
const project = require('../src/org/project');
const { Connection, open, gate, values, nodeFetch, tokenShape, MAX_QUERY_LENGTH } = require('../src/org/connection');
const soql = require('../src/data/soql');
const catalog = require('../src/data/catalog');
const loader = require('../src/data/loader');
const { Cache } = require('../src/data/cache');
const model = require('../src/model/model');
const deps = require('../src/model/dependencies');
const diff = require('../src/model/diff');
const flatXml = require('../src/xml/flatXml');
const applyMod = require('../src/changes/apply');
const history = require('../src/changes/history');
const { MainPanel, toView } = require('../src/views/mainPanel');
const { createOrg } = require('./fixtures/fake-org');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------- fake CLI ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pstudio-'));
const fakeSf = path.join(tmp, 'sf');
fs.writeFileSync(fakeSf, '#!/bin/sh\nexec "' + process.execPath + '" "' + path.join(__dirname, 'fixtures', 'fake-sf.js') + '" "$@"\n');
fs.chmodSync(fakeSf, 0o755);
const tokenFile = path.join(tmp, 'token');
const callsFile = path.join(tmp, 'calls');
const cliCalls = () => (fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const resetCalls = () => fs.writeFileSync(callsFile, '');
function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  const restore = () => { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } };
  return Promise.resolve().then(fn).finally(restore);
}

// ---------- fake org ----------
let F = createOrg();
let S = F.S;
let INSTANCE;
const PS1 = '0PS000000000001AAA';
function resetOrg() {
  const port = INSTANCE;
  const fresh = createOrg();
  // keep the same server, swap the data behind it
  F.server.removeAllListeners('request');
  F.server.on('request', fresh.server.listeners('request')[0]);
  F = Object.assign(fresh, { server: F.server });
  S = F.S;
  return port;
}
const conn = opts => new Connection({ username: 'uat@example.com', alias: 'uat', instanceUrl: INSTANCE + '/', accessToken: S.token, apiVersion: '62.0' },
  Object.assign({ sfPath: fakeSf }, opts));
const item = (over) => Object.assign({ kind: 'permissionSet', permissionSetId: PS1, recordId: PS1, apiName: 'Sales_Ops', label: 'Sales Ops' }, over);

// ---------- CLI ----------
test('cmd.exe escaping keeps spaces and metacharacters intact', () => {
  assert.strictEqual(sfcli.escapeArgument('C:\\My Projects\\proj'), '^"C:\\My^ Projects\\proj^"');
  assert.strictEqual(sfcli.escapeArgument('a"b'), '^"a\\^"b^"');
  assert.strictEqual(sfcli.escapeArgument('C:\\dir\\'), '^"C:\\dir\\\\^"', 'trailing backslash doubled');
  assert.strictEqual(sfcli.escapeArgument('R&D (EU)'), '^"R^&D^ ^(EU^)^"');
  const w = sfcli.spawnSpec('C:\\Program Files\\sf\\bin\\sf.cmd', ['org', 'display', '--target-org', 'my org'], 'win32');
  assert.deepStrictEqual(w.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.strictEqual(w.args[3], '"C:\\Program^ Files\\sf\\bin\\sf.cmd ^"org^" ^"display^" ^"--target-org^" ^"my^ org^""');
  assert.deepStrictEqual(sfcli.spawnSpec('sf', ['org', 'display'], 'linux'), { file: 'sf', args: ['org', 'display'], verbatim: false });
});

test('CLI JSON is found even after a warning line; CLI errors keep their message', async () => {
  assert.deepStrictEqual(sfcli.parseJson('Warning: update available\n{"status":0,"result":{"a":1}}'), { status: 0, result: { a: 1 } });
  await assert.rejects(sfcli.runResult(fakeSf, ['org', 'display', '--target-org', 'nope']), /No authorization information found for nope/);
  await assert.rejects(sfcli.runResult(path.join(tmp, 'missing-sf'), ['org', 'display']), /was not found/);
});

// ---------- project and default org ----------
test('project: setting wins, then the folder holding the active file, then a nested project', async () => {
  const a = path.join(tmp, 'projA'); const b = path.join(tmp, 'projB'); const nested = path.join(tmp, 'mono', 'sf-app');
  for (const d of [a, b, nested]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'sfdx-project.json'), '{}'); }
  const plain = path.join(tmp, 'plain'); fs.mkdirSync(plain, { recursive: true });
  assert.strictEqual(await project.findProject({ override: b, folders: [a] }), b);
  await assert.rejects(project.findProject({ override: plain }), /has no sfdx-project.json/);
  assert.strictEqual(await project.findProject({ folders: [plain, a, b] }), a);
  assert.strictEqual(await project.findProject({ folders: [a, b], activeFile: path.join(b, 'force-app', 'x.cls') }), b);
  assert.strictEqual(await project.findProject({ folders: [plain], findFiles: async () => [path.join(nested, 'sfdx-project.json')] }), nested);
  assert.strictEqual(await project.findProject({ folders: [plain], findFiles: async () => [] }), null);
});

test('default org is read from the CLI’s files, with the CLI’s precedence, without starting sf', async () => {
  const home = path.join(tmp, 'home'); const proj = path.join(tmp, 'fastproj');
  fs.mkdirSync(path.join(home, '.sfdx'), { recursive: true }); fs.mkdirSync(path.join(home, '.sf'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.sf'), { recursive: true });
  fs.writeFileSync(path.join(home, '.sfdx', 'alias.json'), JSON.stringify({ orgs: { uat: 'uat@example.com', prod: 'prod@example.com' } }));
  fs.writeFileSync(path.join(home, '.sfdx', 'uat@example.com.json'), '{}');
  fs.writeFileSync(path.join(home, '.sfdx', 'prod@example.com.json'), '{}');
  fs.writeFileSync(path.join(home, '.sf', 'config.json'), JSON.stringify({ 'target-org': 'prod' }));
  const opts = { homedir: home, env: {} };
  assert.deepStrictEqual(project.defaultOrgFromFiles(proj, opts), { username: 'prod@example.com', alias: 'prod', location: 'Global', via: 'files' });
  fs.writeFileSync(path.join(proj, '.sf', 'config.json'), JSON.stringify({ 'target-org': 'uat' }));
  assert.deepStrictEqual(project.defaultOrgFromFiles(proj, opts), { username: 'uat@example.com', alias: 'uat', location: 'Local', via: 'files' });
  assert.strictEqual(project.defaultOrgFromFiles(proj, { homedir: home, env: { SF_TARGET_ORG: 'prod@example.com' } }).location, 'Environment');
  fs.writeFileSync(path.join(proj, '.sf', 'config.json'), JSON.stringify({ 'target-org': 'unknown-alias' }));
  assert.strictEqual(project.defaultOrgFromFiles(proj, opts), null, 'unknown alias: let the CLI decide');
  resetCalls();
  await withEnv({ FAKE_SF_CALLS: callsFile }, async () => {
    fs.writeFileSync(path.join(proj, '.sf', 'config.json'), JSON.stringify({ 'target-org': 'uat' }));
    const r = await project.resolveDefaultOrg(fakeSf, proj, opts);
    assert.strictEqual(r.username, 'uat@example.com');
    assert.strictEqual(cliCalls().length, 0, 'no sf process started');
  });
  const none = path.join(tmp, 'nohome'); fs.mkdirSync(none, { recursive: true });
  assert.strictEqual(await project.resolveDefaultOrg(fakeSf, proj.replace('fastproj', 'plain'), { homedir: none, env: {} }), null);
});

test('default org falls back to the CLI when the files don’t settle it', async () => {
  const none = path.join(tmp, 'nohome2'); fs.mkdirSync(none, { recursive: true });
  const proj = path.join(tmp, 'cliproj'); fs.mkdirSync(path.join(proj, '.sf'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.sf', 'config.json'), JSON.stringify({ 'target-org': 'uat' }));
  await withEnv({ FAKE_SF_TARGET: 'uat', FAKE_SF_TARGET_WHERE: 'Local', FAKE_SF_INSTANCE: INSTANCE }, async () => {
    const org = await project.resolveDefaultOrg(fakeSf, proj, { homedir: none, env: {} });
    assert.deepStrictEqual([org.username, org.alias, org.location, org.via], ['uat@example.com', 'uat', 'Local', 'cli']);
    assert.ok(org.display && org.display.accessToken);
  });
  await withEnv({ FAKE_SF_TARGET: 'ghost' }, async () => { await assert.rejects(project.resolveDefaultOrg(fakeSf, proj, { homedir: none, env: {} }), /No authorization information found for ghost/); });
});

// ---------- connection ----------
test('query follows nextRecordsUrl and strips attributes', async () => {
  S.pageSize = 1;
  const r = await conn().query('SELECT Id, Name, License.Name FROM PermissionSet WHERE IsOwnedByProfile = false AND PermissionSetGroupId = null ORDER BY Label');
  S.pageSize = 2000;
  assert.strictEqual(r.records.length, 2);
  assert.ok(!('attributes' in r.records[0]));
  assert.strictEqual(r.records.find(x => x.Name === 'Reader').License.Name, 'Salesforce');
  assert.ok(!('attributes' in r.records.find(x => x.Name === 'Reader').License), 'nested attributes stripped');
});

test('expired stored token: the CLI renews it and REST carries on', async () => {
  S.token = 'fresh-1';
  fs.writeFileSync(tokenFile, 'expired-token');
  resetCalls();
  await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE, FAKE_SF_CALLS: callsFile }, async () => {
    const logs = [];
    const c = await open({ username: 'uat@example.com', alias: 'uat' }, { sfPath: fakeSf, log: l => logs.push(l) });
    const r = await c.query('SELECT IsSandbox FROM Organization LIMIT 1');
    assert.strictEqual(r.records[0].IsSandbox, true);
    assert.strictEqual(c.accessToken, 'fresh-1');
    assert.strictEqual(c.mode, 'rest');
    assert.deepStrictEqual(cliCalls().map(a => a.slice(0, 2).join(' ')), ['org display', 'data query', 'org display']);
    assert.ok(!logs.join('\n').includes('fresh-1'), 'token never logged');
  });
});

test('REST refused even after renewal: switches to the CLI and loads the same data', async () => {
  S.token = 'fresh-2'; S.rejectDirect = true;
  fs.writeFileSync(tokenFile, 'fresh-2');
  try {
    await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE }, async () => {
      const modes = [];
      const c = await open({ username: 'uat@example.com', alias: 'uat' }, { sfPath: fakeSf, onModeChange: m => modes.push(m) });
      const ps = await catalog.listPermissionSets(c);
      assert.deepStrictEqual(ps.map(p => p.apiName), ['acme__Reader', 'Sales_Ops']);
      assert.strictEqual(c.mode, 'cli');
      assert.deepStrictEqual(modes, ['cli']);
      const detail = await loader.loadDetail(c, item());
      assert.strictEqual(detail.model.entries.get('user:ModifyAllData').enabled, true);
      assert.strictEqual([...detail.model.entries.keys()].filter(k => k.startsWith('user:')).length, F.sysNames.length);
    });
  } finally { S.rejectDirect = false; }
});

test('HTTP blocked (proxy or certificate): reads switch to the CLI; rest mode never switches', async () => {
  S.token = 'tok-net'; fs.writeFileSync(tokenFile, 'tok-net');
  await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE }, async () => {
    const blocked = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }; throw e; };
    const logs = [];
    const c = conn({ fetch: blocked, log: l => logs.push(l) });
    assert.strictEqual((await c.query('SELECT IsSandbox FROM Organization LIMIT 1')).records[0].IsSandbox, true);
    assert.strictEqual(c.mode, 'cli');
    assert.ok(logs.some(l => /UNABLE_TO_VERIFY_LEAF_SIGNATURE/.test(l)));
    await assert.rejects(conn({ fetch: blocked, mode: 'rest' }).query('SELECT IsSandbox FROM Organization'), /HTTP request failed/);
  });
});

test('dead refresh token: the message says how to log in again', async () => {
  S.token = 'another'; fs.writeFileSync(tokenFile, 'old');
  await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE, FAKE_SF_LOGIN_EXPIRED: '1' }, async () => {
    const c = await open({ username: 'uat@example.com', alias: 'uat' }, { sfPath: fakeSf });
    await assert.rejects(c.query('SELECT IsSandbox FROM Organization'), e => /could not renew the session for uat/.test(e.message) && /sf org login web --alias uat/.test(e.message));
  });
  S.token = 'tok1'; fs.writeFileSync(tokenFile, 'tok1');
});

test('API errors carry the Salesforce error code; production comes from the org', async () => {
  await assert.rejects(conn().query('SELECT Nope FROM Nowhere'), e => e.errorCode === 'MALFORMED_QUERY');
  const c = conn();
  assert.strictEqual(await orgs.detectProduction(c), false);
  S.org.IsSandbox = false;
  assert.strictEqual(await orgs.detectProduction(c), true);
  S.org.TrialExpirationDate = '2026-12-01T00:00:00.000+0000';
  assert.strictEqual(await orgs.detectProduction(c), false, 'scratch/trial orgs expire');
  S.org.IsSandbox = true; S.org.TrialExpirationDate = null;
});

test('parallel work is capped by the connection gate', async () => {
  const g = gate(3);
  let active = 0; let peak = 0;
  await Promise.all(Array.from({ length: 10 }, () => g(async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 10)); active--; })));
  assert.strictEqual(peak, 3);
});

test('describes are kept for a day across sessions; Refresh bypasses them', async () => {
  const cache = new Cache(path.join(tmp, 'cache-describe'));
  const a = conn({ persist: cache });
  await a.describe('Lead');
  await cache.flush();
  S.requests = [];
  const b = conn({ persist: new Cache(path.join(tmp, 'cache-describe')) });
  assert.strictEqual((await b.describe('Lead')).label, 'Lead');
  assert.strictEqual(S.requests.length, 0, 'served from disk');
  b.forget();
  await b.describe('Lead');
  assert.strictEqual(S.requests.length, 1, 'refresh goes to the org');
});

// ---------- writes ----------
test('record writes go through sObject Collections, all or none', async () => {
  resetOrg();
  const c = conn();
  const [id] = await c.create('FieldPermissions', [{ ParentId: PS1, SobjectType: 'Lead', Field: 'Lead.Industry', PermissionsRead: true, PermissionsEdit: false }]);
  assert.ok(F.T.FieldPermissions.some(r => r.Id === id));
  await c.update('FieldPermissions', [{ Id: id, PermissionsEdit: true }]);
  assert.strictEqual(F.T.FieldPermissions.find(r => r.Id === id).PermissionsEdit, true);
  await assert.rejects(c.create('FieldPermissions', [
    { ParentId: PS1, SobjectType: 'Lead', Field: 'Lead.Description', PermissionsRead: true },
    { ParentId: PS1, SobjectType: 'Lead', Field: 'Lead.Score__c', PermissionsRead: false, PermissionsEdit: true }]),
  e => e.tag === 'REJECTED' && /Edit access requires Read access/.test(e.message) && !/ROLLED_BACK/.test(e.message));
  assert.ok(!F.T.FieldPermissions.some(r => r.Field === 'Lead.Description'), 'nothing from the failed call was written');
  await c.destroy('FieldPermissions', [id]);
  assert.ok(!F.T.FieldPermissions.some(r => r.Id === id));
  const many = Array.from({ length: 450 }, (_, i) => ({ ParentId: PS1, SobjectType: 'Lead', Field: 'Lead.Batch' + i + '__c', PermissionsRead: true }));
  S.requests = [];
  assert.strictEqual((await c.create('FieldPermissions', many)).length, 450);
  assert.strictEqual(S.requests.filter(r => r.method === 'POST').length, 3, '200 per call');
});

test('record writes through the CLI transport, with quoting', async () => {
  resetOrg();
  fs.writeFileSync(tokenFile, S.token);
  await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE }, async () => {
    const c = conn({ mode: 'cli' });
    const [id] = await c.create('ObjectPermissions', [{ ParentId: PS1, SobjectType: 'Lead', PermissionsRead: true }]);
    assert.strictEqual(F.T.ObjectPermissions.find(r => r.Id === id).PermissionsRead, true);
    await c.update('ObjectPermissions', [{ Id: id, PermissionsRead: true, PermissionsEdit: true }]);
    assert.strictEqual(F.T.ObjectPermissions.find(r => r.Id === id).PermissionsEdit, true);
    await assert.rejects(c.update('ObjectPermissions', [{ Id: id, PermissionsRead: false }]), /Read access is required/);
    await c.destroy('ObjectPermissions', [id]);
    assert.ok(!F.T.ObjectPermissions.some(r => r.Id === id));
    assert.ok(S.requests.filter(r => r.method !== 'GET').every(r => r.viaCli));
  });
  assert.strictEqual(values({ A: true, B: 'x y', C: "it's" }), "A=true B='x y' C='it\\'s'");
});

test('a write whose request never got an answer is reported as unknown, not retried', async () => {
  const c = conn({ fetch: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(c.create('FieldPermissions', [{ ParentId: PS1, SobjectType: 'Lead', Field: 'Lead.Industry', PermissionsRead: true }]),
    e => e.tag === 'UNKNOWN_OUTCOME' && /may or may not have reached the org/.test(e.message));
});

// ---------- cache ----------
test('cache: survives a restart, serves stale data then the fresh copy, shares in-flight fetches', async () => {
  const dir = path.join(tmp, 'cache-a');
  const c1 = new Cache(dir);
  c1.set('lists', { n: 1 });
  await c1.flush();
  const c2 = new Cache(dir);
  assert.deepStrictEqual(c2.get('lists').value, { n: 1 });
  let calls = 0;
  let fresh;
  const freshSeen = new Promise(r => { fresh = r; });
  const r = await c2.swr('lists', async () => { calls++; await new Promise(x => setTimeout(x, 20)); return { n: 2 }; }, (v, changed) => fresh([v, changed]));
  assert.deepStrictEqual([r.value, r.stale], [{ n: 1 }, true], 'cached copy at once');
  const [v, changed] = await freshSeen;
  assert.deepStrictEqual([v, changed], [{ n: 2 }, true]);
  assert.deepStrictEqual(c2.get('lists').value, { n: 2 });
  const [a, b] = await Promise.all([c2.swr('x', async () => { calls++; return 1; }), c2.swr('x', async () => { calls++; return 1; })]);
  assert.strictEqual(calls, 2, 'one fetch for two callers');
  assert.deepStrictEqual([a.value, b.value], [1, 1]);
  const young = await c2.swr('lists', async () => { calls++; return 3; }, null, { maxAgeMs: 60000 });
  assert.strictEqual(calls, 2, 'young entry not refetched');
  assert.strictEqual(young.stale, false);
  await c2.clear();
  assert.strictEqual(new Cache(dir).get('lists'), null);
});

test('cache prunes the oldest entries and can be switched off', async () => {
  const c = new Cache(path.join(tmp, 'cache-b'), { maxEntries: 5 });
  for (let i = 0; i < 9; i++) { c.set('k' + i, i); await c.flush(); await new Promise(r => setTimeout(r, 5)); }
  assert.strictEqual(fs.readdirSync(path.join(tmp, 'cache-b')).length, 5);
  const off = require('../src/data/cache').disabled();
  off.set('a', 1);
  assert.strictEqual(off.get('a'), null);
});

// ---------- reading ----------
test('detail: one batch of queries, system permissions in one FIELDS(STANDARD) query', async () => {
  resetOrg();
  const c = conn();
  S.requests = [];
  const detail = await loader.loadDetail(c, item());
  assert.deepStrictEqual(S.requests.filter(r => r.method !== 'GET' || !/describe|sobjects$/.test(r.url)).map(r => r.method + ' ' + r.url.split('?')[0].split('/').pop()), ['POST composite'], 'the data in one round trip');
  assert.strictEqual([...detail.model.entries.keys()].filter(k => k.startsWith('user:')).length, F.sysNames.length);
  assert.strictEqual(detail.model.entries.get('user:ModifyAllData').enabled, true);
  assert.strictEqual(detail.model.entries.get('user:Feature007WithAFairlyLongName').enabled, true);
  assert.strictEqual(detail.model.entries.get('user:ApiEnabled').enabled, false);
  assert.strictEqual(detail.labels.get('user:ModifyAllData'), 'Modify All Data');
  assert.strictEqual(detail.labels.get('object:Custom_Thing__c'), 'Custom Thing');
  assert.deepStrictEqual(detail.model.entries.get('object:Account'), { read: true, create: true, edit: true, delete: false, viewAll: false, modifyAll: false, viewAllFields: false });
  assert.strictEqual(detail.activeAssignees, 12);
  assert.deepStrictEqual(detail.objectColumns, ['read', 'create', 'edit', 'delete', 'viewAll', 'modifyAll', 'viewAllFields']);
});

test('orgs that refuse FIELDS() fall back to column slices within the URL and cmd.exe limits, once', async () => {
  resetOrg();
  S.noFieldsStandard = true;
  const c = conn();
  const d1 = await loader.loadDetail(c, item());
  assert.strictEqual(c.noFieldsStandard, true, 'remembered for the session');
  assert.strictEqual([...d1.model.entries.keys()].filter(k => k.startsWith('user:')).length, F.sysNames.length);
  S.requests = [];
  await loader.loadDetail(c, item());
  assert.strictEqual(S.requests.filter(r => r.method === 'POST').length, 1, 'no second failed try');
  const slices = loader.sliceByLength(await loader.systemPermissionFields(c), g => 'SELECT ' + g.map(f => f.field).join(', ') + " FROM PermissionSet WHERE Id = '0PS000000000001AAA'", MAX_QUERY_LENGTH);
  assert.ok(slices.length >= 2);
  for (const g of slices) {
    const q = 'SELECT ' + g.map(f => f.field).join(', ') + " FROM PermissionSet WHERE Id = '0PS000000000001AAA'";
    assert.ok(q.length <= MAX_QUERY_LENGTH);
    assert.ok(sfcli.spawnSpec('C:\\sf\\sf.cmd', ['data', 'query', '--query', q, '--target-org', 'u@example.com', '--json'], 'win32').args[3].length < 8191);
  }
  S.noFieldsStandard = false;
});

test('queries in bulk: Composite batches of 25 over REST, gzip responses, the same answers over the CLI', async () => {
  resetOrg();
  S.gzip = true;
  const c = conn();
  const qs = Array.from({ length: 30 }, (_, i) => i % 2 ? 'SELECT Id FROM ApexClass ORDER BY Name' : 'SELECT COUNT() FROM PermissionSet');
  S.composites = 0;
  const r = await c.queryMany(qs);
  assert.strictEqual(S.composites, 2, '30 queries in 2 round trips');
  assert.deepStrictEqual([r[0].totalSize, r[1].records.length, r.length], [F.T.PermissionSet.length, 3, 30]);
  S.gzip = false;
  fs.writeFileSync(tokenFile, S.token);
  await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE }, async () => {
    const viaCli = await conn({ mode: 'cli' }).queryMany(qs.slice(0, 2));
    assert.deepStrictEqual(viaCli.map(x => x.totalSize), [r[0].totalSize, r[1].totalSize]);
  });
  await assert.rejects(c.queryMany(['SELECT Nope FROM Nowhere']), e => e.errorCode === 'MALFORMED_QUERY');
});

test('lists change stamp moves only when something changes', async () => {
  resetOrg();
  const c = conn();
  const a = await catalog.changeStamp(c, ['permissionSet', 'profile']);
  assert.strictEqual(await catalog.changeStamp(c, ['permissionSet', 'profile']), a);
  await c.update('PermissionSet', [{ Id: PS1, Label: 'Sales Ops 2' }]);
  const b = await catalog.changeStamp(c, ['permissionSet', 'profile']);
  assert.notStrictEqual(b, a);
  await c.create('PermissionSet', [{ Name: 'New_One', Label: 'New One' }]);
  assert.notStrictEqual(await catalog.changeStamp(c, ['permissionSet', 'profile']), b);
  const l = await catalog.listAll(c, ['permissionSet', 'profile']);
  assert.deepStrictEqual([l.permissionSet.length > 0, l.group, l.profile.length > 0], [true, [], true], 'unchosen kinds are not read');
});

test('older API versions without PermissionsViewAllFields still load', async () => {
  S.viewAllFields = false;
  const c = conn();
  const d = await loader.loadDetail(c, item());
  assert.ok(!('viewAllFields' in d.model.entries.get('object:Account')));
  assert.ok(!d.objectColumns.includes('viewAllFields'));
  S.viewAllFields = true;
});

test('object page: only permissionable fields, Edit blocked on calculated ones, current access filled in', async () => {
  const od = await loader.loadObjectDetail(conn(), item(), 'Lead');
  assert.deepStrictEqual(od.fields.map(f => f.apiName), ['Company', 'CreatedDate', 'Description', 'Industry', 'LastModifiedDate', 'LastName', 'Rating', 'Score__c'],
    'required and system fields listed as in Setup; Id, IsDeleted and SystemModstamp hidden');
  assert.deepStrictEqual(['LastName', 'CreatedDate'].map(n => { const f = od.fields.find(x => x.apiName === n); return [f.fixed, f.read, f.edit, f.canEdit]; }),
    [[true, true, true, false], [true, true, false, false]], 'fixed: always readable, editable only if Salesforce lets anyone edit it');
  assert.strictEqual(od.objectPermissions, true);
  assert.deepStrictEqual(od.fields.find(f => f.apiName === 'Rating'), { name: 'Lead.Rating', apiName: 'Rating', label: 'Rating', type: 'picklist', canEdit: true, read: true, edit: false });
  assert.strictEqual(od.fields.find(f => f.apiName === 'Score__c').canEdit, false);
  assert.ok(Object.values(od.props).every(v => v === false), 'no Lead row yet');
});

test('object catalog: permissionable objects only', async () => {
  const cat = await loader.objectCatalog(conn());
  assert.deepStrictEqual(cat.map(o => [o.name, o.objectPerms, o.fieldPerms]), [['Account', true, true], ['Contact', true, true], ['Custom_Thing__c', true, true],
    ['Event', false, true], ['Lead', true, true], ['Opportunity', true, true], ['Task', false, true]], 'exactly the objects Salesforce lists; activities take field permissions only');
  S.noObjectPicklist = true;
  const c2 = conn();
  assert.deepStrictEqual((await loader.objectCatalog(c2)).map(o => o.name), ['Account', 'Custom_Thing__c', 'Event', 'Lead', 'Region__mdt', 'Task'].filter(n => n !== 'Region__mdt'), 'orgs that don\u2019t say: the old rule');
  S.noObjectPicklist = false;
});

test('catalog: three lists in one shape, with last-modified', async () => {
  resetOrg();
  const c = conn();
  const ps = await catalog.listPermissionSets(c);
  assert.deepStrictEqual(ps.map(p => p.apiName), ['acme__Reader', 'Sales_Ops']);
  assert.deepStrictEqual(ps[1].modified, { at: '2026-10-01T10:00:00.000+0000', by: 'Admin User' });
  const g = await catalog.listGroups(c);
  assert.strictEqual(g[0].status, 'Updated');
  assert.strictEqual(await catalog.resolveGroupPermissionSet(c, g[0].recordId), '0PS00000000000GAAA');
  const p = await catalog.listProfiles(c);
  assert.deepStrictEqual(p.map(x => [x.label, x.standard]), [['Custom: Sales', false], ['System Administrator', true]]);
});

test('favourites load on their own, by API name, across the three kinds', async () => {
  S.requests = [];
  const f = await catalog.listFavorites(conn(), ['permissionSet:acme__Reader', 'profile:Custom: Sales', 'group:Missing_One']);
  assert.deepStrictEqual([f.permissionSet.map(x => x.apiName), f.group, f.profile.map(x => x.label)], [['acme__Reader'], [], ['Custom: Sales']]);
  const qs = S.requests.map(r => decodeURIComponent((r.url.split('?q=')[1] || '').replace(/\+/g, ' ')));
  assert.ok(qs.some(q => /Name IN \('Reader'\)/.test(q)), 'namespace prefix stripped for the query');
  assert.ok(qs.some(q => /Profile\.Name IN \('Custom: Sales'\)/.test(q)));
  assert.deepStrictEqual(await catalog.listFavorites(conn(), []), { permissionSet: [], group: [], profile: [] });
});

test('Apex class and custom permission access: every entity, with what this item grants', async () => {
  const c = conn();
  const classes = await loader.loadEntityAccess(c, item(), 'apexClass');
  assert.deepStrictEqual(classes.items.map(x => [x.name, x.enabled]), [['AccountTriggerHandler', false], ['LeadService', true], ['acme__Util', false]]);
  const perms = await loader.loadEntityAccess(c, item(), 'customPermission');
  assert.deepStrictEqual(perms.items.map(x => [x.name, x.label, x.enabled]), [['Approve_Discounts', 'Approve Discounts', true], ['Bypass_Validation', 'Bypass Validation', false]]);
  assert.deepStrictEqual((await loader.listRecordTypes(c, 'Lead')).map(t => [t.name, t.label]), [['Lead.Direct', 'Direct Lead'], ['Lead.Partner', 'Partner Lead']]);
});

test('SOQL literals are escaped and Ids validated', () => {
  assert.strictEqual(soql.str("O'Brien\\x"), "'O\\'Brien\\\\x'");
  assert.throws(() => soql.assertId("0PS' OR Id != '"), /Not a Salesforce Id/);
});

// ---------- saving ----------
const snapStore = [];
const saveOpts = extra => Object.assign({ onSnapshot: s => { snapStore.push(s); return 'snap-' + snapStore.length; } }, extra);

test('save: new object access is inserted, existing rows updated, rules re-checked on the way in', async () => {
  resetOrg();
  const c = conn();
  const full = r => Object.assign({ read: false, create: false, edit: false, delete: false, viewAll: false, modifyAll: false, viewAllFields: false }, r);
  const r = await applyMod.apply(c, item(), [
    { key: 'object:Lead', before: null, after: full({ read: true, edit: true }) },
    { key: 'object:Account', before: full({ read: true, create: true, edit: true }), after: full({ read: true, create: true, edit: true, delete: true }) }
  ], saveOpts());
  assert.strictEqual(r.status, 'saved');
  assert.deepStrictEqual(r.mismatches, []);
  const lead = F.T.ObjectPermissions.find(x => x.ParentId === PS1 && x.SobjectType === 'Lead');
  assert.deepStrictEqual([lead.PermissionsRead, lead.PermissionsEdit, lead.PermissionsCreate], [true, true, false]);
  assert.strictEqual(F.T.ObjectPermissions.find(x => x.Id === '110000000000001AAA').PermissionsDelete, true);
  assert.deepStrictEqual(snapStore[snapStore.length - 1].map(s => [s.key, s.before && s.before.read]), [['object:Lead', null], ['object:Account', true]], 'snapshot holds the live values from just before');
  await assert.rejects(applyMod.apply(c, item(), [{ key: 'object:Lead', before: full({ read: true, edit: true }), after: full({ edit: true }) }], saveOpts()), /Edit needs read|edit needs read/i);
});

test('save: removing all access deletes the row; fields insert, update and delete', async () => {
  const c = conn();
  const none = { read: false, create: false, edit: false, delete: false, viewAll: false, modifyAll: false, viewAllFields: false };
  const lead = F.T.ObjectPermissions.find(x => x.ParentId === PS1 && x.SobjectType === 'Lead');
  const r = await applyMod.apply(c, item(), [
    { key: 'object:Custom_Thing__c', before: Object.assign({}, none, { read: true }), after: none },
    { key: 'field:Lead.Rating', before: { read: true, edit: false }, after: { read: true, edit: true } },
    { key: 'field:Lead.Industry', before: null, after: { read: true, edit: false } },
    { key: 'object:Lead', before: { read: true, create: false, edit: true, delete: false, viewAll: false, modifyAll: false, viewAllFields: false }, after: Object.assign({}, none, { read: true, edit: true }) }
  ], saveOpts());
  assert.strictEqual(r.status, 'saved');
  assert.ok(!F.T.ObjectPermissions.some(x => x.SobjectType === 'Custom_Thing__c' && x.ParentId === PS1));
  assert.strictEqual(F.T.FieldPermissions.find(x => x.Field === 'Lead.Rating').PermissionsEdit, true);
  assert.ok(F.T.FieldPermissions.some(x => x.Field === 'Lead.Industry' && x.PermissionsRead));
  assert.ok(lead, 'unchanged entries are left alone');
  const r2 = await applyMod.apply(c, item(), [{ key: 'field:Lead.Industry', before: { read: true, edit: false }, after: { read: false, edit: false } }], saveOpts());
  assert.strictEqual(r2.status, 'saved');
  assert.ok(!F.T.FieldPermissions.some(x => x.Field === 'Lead.Industry'));
});

test('save: changed in the org since loaded -> conflict, nothing written; force overwrites', async () => {
  const c = conn();
  S.writes = [];
  const r = await applyMod.apply(c, item(), [{ key: 'field:Lead.Rating', before: { read: true, edit: false }, after: { read: false, edit: false } }], saveOpts());
  assert.strictEqual(r.status, 'conflict');
  assert.deepStrictEqual(r.conflicts[0].now, { read: true, edit: true });
  assert.strictEqual(S.writes.length, 0);
  const forced = await applyMod.apply(c, item(), [{ key: 'field:Lead.Rating', before: { read: true, edit: false }, after: { read: false, edit: false } }], saveOpts({ force: true }));
  assert.strictEqual(forced.status, 'saved');
  assert.ok(!F.T.FieldPermissions.some(x => x.Field === 'Lead.Rating'));
});

test('save: system permissions in one update; the org’s own dependency errors come through', async () => {
  const c = conn();
  const r = await applyMod.apply(c, item(), [{ key: 'user:ApiEnabled', before: { enabled: false }, after: { enabled: true } }], saveOpts());
  assert.strictEqual(r.status, 'saved');
  assert.strictEqual(F.T.PermissionSet[0].PermissionsApiEnabled, true);
  await assert.rejects(applyMod.apply(c, item(), [{ key: 'user:ViewAllData', before: { enabled: true }, after: { enabled: false } }], saveOpts()),
    e => /Modify All Data depends on permission\(s\): View All Data/.test(e.message) && e.failedStep === 'Updating system permissions' && !!e.snapshotId);
  assert.strictEqual(F.T.PermissionSet[0].PermissionsViewAllData, true, 'rejected, unchanged');
});

test('save: anything the org did not take as asked is reported', async () => {
  resetOrg();
  S.silentlyIgnoreFieldEdit = true;
  const r = await applyMod.apply(conn(), item(), [{ key: 'field:Lead.Rating', before: { read: true, edit: false }, after: { read: true, edit: true } }], saveOpts());
  assert.strictEqual(r.status, 'saved');
  assert.strictEqual(r.mismatches.length, 1);
  assert.deepStrictEqual(r.mismatches[0].now, { read: true, edit: false });
});

test('save is refused for groups, managed permission sets and standard profiles', async () => {
  for (const [it, re] of [[item({ kind: 'group' }), /permission sets and muting/], [item({ managed: true }), /managed package/], [item({ kind: 'profile', standard: true }), /Standard profiles/]]) {
    await assert.rejects(applyMod.apply(conn(), it, [{ key: 'user:ApiEnabled', before: null, after: { enabled: true } }]), re);
  }
});

test('save: class and custom permission access are inserted and deleted as SetupEntityAccess rows', async () => {
  resetOrg();
  const c = conn();
  const r = await applyMod.apply(c, item(), [
    { key: 'apexClass:AccountTriggerHandler', ref: '01p000000000001AAA', before: { enabled: false }, after: { enabled: true } },
    { key: 'apexClass:LeadService', ref: '01p000000000002AAA', before: { enabled: true }, after: { enabled: false } },
    { key: 'customPermission:Bypass_Validation', ref: '0CP000000000002AAA', before: { enabled: false }, after: { enabled: true } }
  ], saveOpts());
  assert.strictEqual(r.status, 'saved');
  assert.deepStrictEqual(r.mismatches, []);
  const granted = F.T.SetupEntityAccess.filter(x => x.ParentId === PS1).map(x => x.SetupEntityId).sort();
  assert.deepStrictEqual(granted, ['01p000000000001AAA', '0CP000000000001AAA', '0CP000000000002AAA']);
  await assert.rejects(applyMod.apply(c, item(), [{ key: 'apexClass:X', before: null, after: { enabled: true } }], saveOpts()), /No Salesforce Id/);
});

const metadata = require('../src/org/metadata');
const metaConn = () => conn({ cwd: tmp });
test('record types: read through a retrieve, for permission sets and profiles (profile file name from the org)', async () => {
  resetOrg();
  fs.writeFileSync(tokenFile, S.token);
  await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE }, async () => {
    const ps = await metadata.readRecordTypes(metaConn(), item(), ['Lead.Direct', 'Lead.Partner']);
    assert.deepStrictEqual([...ps], [['Lead.Direct', { visible: false }], ['Lead.Partner', { visible: true }]]);
    const prof = { kind: 'profile', recordId: '00e000000000002AAA', permissionSetId: '0PS0000000000PRAAA', apiName: 'Custom: Sales', label: 'Custom: Sales' };
    const pr = await metadata.readRecordTypes(metaConn(), prof, ['Lead.Direct', 'Lead.Partner']);
    assert.strictEqual(prof.metadataName, 'Custom%3A Sales');
    assert.deepStrictEqual(pr.get('Lead.Partner'), { visible: true, default: true });
    await assert.rejects(metadata.readRecordTypes(metaConn(), { kind: 'group' }, ['Lead.Direct']), /can’t be read or changed/);
  });
});

test('record types: saved with a deploy of only the changed entries, conflicts checked first', async () => {
  resetOrg();
  fs.writeFileSync(tokenFile, S.token);
  await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE }, async () => {
    const c = metaConn();
    const stale = await applyMod.apply(c, item(), [{ key: 'recordType:Lead.Partner', before: { visible: false }, after: { visible: true } }], saveOpts({ metadata }));
    assert.strictEqual(stale.status, 'conflict');
    assert.strictEqual(S.deploys.length, 0);
    const snaps = [];
    const r = await applyMod.apply(c, item(), [
      { key: 'recordType:Lead.Direct', before: { visible: false }, after: { visible: true } },
      { key: 'object:Lead', before: null, after: { read: true, create: false, edit: false, delete: false, viewAll: false, modifyAll: false, viewAllFields: false } }
    ], { metadata, onSnapshot: (snap, safety) => { snaps.push([snap, safety]); return 'snap-rt'; } });
    assert.strictEqual(r.status, 'saved', JSON.stringify(r));
    assert.deepStrictEqual(S.rtVis[PS1]['Lead.Direct'], { visible: true });
    assert.strictEqual(S.deploys.length, 1);
    assert.ok(/<label>Sales Ops<\/label>/.test(S.deploys[0].xml) && !/objectPermissions|fieldPermissions/.test(S.deploys[0].xml), 'only label and the record type entry are deployed');
    assert.ok(snaps[0][1] && snaps[0][1].fields.length === 1, 'full copy taken before the deploy');
    assert.ok(F.T.ObjectPermissions.some(x => x.ParentId === PS1 && x.SobjectType === 'Lead'), 'record changes in the same save went through');
  });
});

test('record types: a deploy that removes other access is caught, and Restore puts it back', async () => {
  resetOrg();
  fs.writeFileSync(tokenFile, S.token);
  S.deployWipesFields = true;
  await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE }, async () => {
    const c = metaConn();
    let safety;
    await assert.rejects(applyMod.apply(c, item(), [{ key: 'recordType:Lead.Direct', before: { visible: false }, after: { visible: true } }],
      { metadata, onSnapshot: (snap, saf) => { safety = saf; return 'snap-x'; } }),
    e => e.tag === 'DEPLOY_REMOVED' && e.restorable && /removed 1 other permission/.test(e.message) && e.snapshotId === 'snap-x');
    assert.strictEqual(F.T.FieldPermissions.filter(f => f.ParentId === PS1).length, 0, 'the fake deploy really wiped it');
    S.deployWipesFields = false;
    assert.strictEqual(await metadata.restoreSafety(c, PS1, safety), 1);
    assert.deepStrictEqual(F.T.FieldPermissions.filter(f => f.ParentId === PS1).map(f => [f.Field, f.PermissionsRead]), [['Lead.Rating', true]]);
    assert.strictEqual(await metadata.restoreSafety(c, PS1, safety), 0, 'nothing left to restore');
  });
});

test('record types: deploy failures come back with the component problem', async () => {
  resetOrg();
  fs.writeFileSync(tokenFile, S.token);
  await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE }, async () => {
    await assert.rejects(metadata.deployEntries(metaConn(), item(), [{ key: 'recordType:Lead.Nope', after: { visible: true } }]), /The deploy failed: .*no RecordType named Lead.Nope/);
  });
});

test('history: snapshots and the change log live in the project’s .permstudio folder', async () => {
  const proj = path.join(tmp, 'histproj');
  const id = await history.saveSnapshot(proj, { org: 'u', target: 'Sales_Ops', items: [{ key: 'user:ApiEnabled', before: { enabled: false } }] });
  assert.match(id, /^\d{8}-\d{6}-\w{4}$/);
  assert.strictEqual((await history.loadSnapshot(proj, id)).items[0].key, 'user:ApiEnabled');
  await history.appendLog(proj, { org: 'u', result: 'saved' });
  await history.appendLog(proj, { org: 'u', result: 'failed' });
  const lines = fs.readFileSync(path.join(proj, '.permstudio', 'log', 'changes.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(lines.map(l => l.result), ['saved', 'failed']);
  await assert.rejects(history.loadSnapshot(proj, '../x'), /Bad snapshot id/);
});

// ---------- XML ----------
const PS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!-- exported -->
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>R&amp;D access</description>
    <hasActivationRequired>false</hasActivationRequired>
    <label>Sales Ops</label>
    <applicationVisibilities><application>Sales</application><visible>true</visible></applicationVisibilities>
    <classAccesses>
        <apexClass>LeadService</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <fieldPermissions>
        <editable>false</editable>
        <field>Lead.Rating</field>
        <readable>true</readable>
    </fieldPermissions>
    <!-- <fieldPermissions><editable>true</editable><field>Lead.Ghost__c</field><readable>true</readable></fieldPermissions> -->
    <objectPermissions>
        <allowCreate>true</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>true</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>Lead</object>
        <viewAllFields>false</viewAllFields>
        <viewAllRecords>false</viewAllRecords>
    </objectPermissions>
    <tabSettings><tab>standard-Lead</tab><visibility>Visible</visibility></tabSettings>
    <userPermissions><enabled>true</enabled><name>ApiEnabled</name></userPermissions>
    <futureThing><name>X</name></futureThing>
</PermissionSet>`;

const PROFILE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <custom>true</custom>
    <description/>
    <fieldPermissions><editable>true</editable><field>Lead.Rating</field><readable>true</readable></fieldPermissions>
    <layoutAssignments><layout>Lead-Lead Layout</layout></layoutAssignments>
    <layoutAssignments><layout>Lead-Partner Layout</layout><recordType>Lead.Partner</recordType></layoutAssignments>
    <loginHours><mondayStart>480</mondayStart><mondayEnd>1080</mondayEnd></loginHours>
    <loginIpRanges><endAddress>10.0.0.255</endAddress><startAddress>10.0.0.0</startAddress></loginIpRanges>
    <recordTypeVisibilities><default>true</default><recordType>Lead.Partner</recordType><visible>true</visible></recordTypeVisibilities>
    <tabVisibilities><tab>standard-Lead</tab><visibility>DefaultOn</visibility></tabVisibilities>
    <userLicense>Salesforce</userLicense>
</Profile>`;

test('a 50k-line permission set parses quickly', () => {
  const parts = [];
  for (let i = 0; i < 10000; i++) parts.push(`    <fieldPermissions>\n        <editable>${i % 2 === 0}</editable>\n        <field>Obj${i % 40}__c.Field${i}__c</field>\n        <readable>true</readable>\n    </fieldPermissions>`);
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n<label>Big</label>\n' + parts.join('\n') + '\n</PermissionSet>';
  assert.ok(xml.split('\n').length >= 50000);
  const t0 = Date.now();
  const doc = flatXml.parse(xml);
  const ms = Date.now() - t0;
  assert.strictEqual(doc.entries.filter(e => e.tag === 'fieldPermissions').length, 10000);
  assert.ok(ms < 1500, 'parsed in ' + ms + ' ms');
  console.log('      (50k lines parsed in ' + ms + ' ms)');
});

// ---------- dependencies ----------
test('granting Modify All grants Read, Edit, Delete and View All', () => {
  const r = deps.applyObject({ read: false }, 'modifyAll', true);
  assert.deepStrictEqual(r.props, { read: true, create: false, edit: true, delete: true, viewAll: true, modifyAll: true, viewAllFields: false });
  assert.deepStrictEqual(r.changed.filter(c => c.implied).map(c => c.flag).sort(), ['delete', 'edit', 'read', 'viewAll']);
});

test('revoking Read revokes everything; revoking Edit keeps Read and View All', () => {
  const full = { read: true, create: true, edit: true, delete: true, viewAll: true, modifyAll: true, viewAllFields: true };
  assert.ok(Object.values(deps.applyObject(full, 'read', false).props).every(v => v === false));
  const e = deps.applyObject(full, 'edit', false).props;
  assert.deepStrictEqual([e.read, e.create, e.edit, e.delete, e.viewAll, e.modifyAll], [true, true, false, false, true, false]);
  assert.strictEqual(deps.applyObject(full, 'viewAll', false).props.modifyAll, false);
});

test('field rules: Edit implies Read, read-only and non-permissionable fields are blocked', () => {
  const g = deps.applyField(null, 'edit', true, { updateable: true, permissionable: true }, { read: true, edit: true });
  assert.deepStrictEqual(g.props, { read: true, edit: true });
  assert.strictEqual(g.warnings.length, 0);
  assert.deepStrictEqual(deps.applyField({ read: true, edit: true }, 'read', false).props, { read: false, edit: false });
  assert.match(deps.applyField(null, 'edit', true, { updateable: false }).blocked, /read-only/);
  assert.match(deps.applyField(null, 'read', true, { permissionable: false }).blocked, /cannot be set/);
  assert.match(deps.applyField(null, 'read', true, {}, null).warnings[0], /no Read access/);
});

// ---------- diff ----------
test('differing flags: absent and all-false are equal; real differences are listed per flag', () => {
  assert.deepStrictEqual(diff.differingFlags(null, { read: false, edit: false }), []);
  assert.deepStrictEqual(diff.differingFlags({ read: true }, { read: true, edit: true }), ['edit']);
  assert.deepStrictEqual(diff.differingFlags({ layout: '' }, {}), [], 'empty text means not set');
  assert.deepStrictEqual(diff.differingFlags({ ranges: [{ a: 1 }] }, { ranges: [{ a: 1 }] }), [], 'lists compare by content');
  assert.deepStrictEqual(diff.differingFlags({ ranges: [{ a: 1 }] }, { ranges: [{ a: 2 }] }), ['ranges']);
});
// ---------- main screen ----------
function panelServices(over) {
  const c = conn();
  const logs = [];
  const caches = new Map();
  const projectDir = path.join(tmp, 'panelproj-' + Math.random().toString(36).slice(2, 7));
  const svc = Object.assign({
    conn: c, logs, projectDir, opens: 0,
    resolveContext: async () => ({ projectDir, org: { username: 'uat@example.com', alias: 'uat', location: 'Local' } }),
    openConnection: async () => { svc.opens++; if (svc.connectDelay) await new Promise(r => setTimeout(r, svc.connectDelay)); return c; },
    cacheFor: u => { if (!caches.has(u)) caches.set(u, new Cache(path.join(projectDir, 'cache', u))); return caches.get(u); },
    catalog, loader, detectProduction: orgs.detectProduction, history, applyChanges: applyMod.apply, metadata, log: l => logs.push(l), showLog() {},
    favs: { items: [], objects: [] },
    favorites: () => svc.favs,
    toggleFavorite: async (kind, id) => { const list = kind === 'object' ? svc.favs.objects : svc.favs.items; const i = list.indexOf(id); if (i >= 0) list.splice(i, 1); else list.push(id); }
  }, over || {});
  return svc;
}
const settle = (ms) => new Promise(r => setTimeout(r, ms || 120));
const posts = (p, type) => p.posted.filter(m => m.type === type);

test('main screen: lists, detail and object page come from the org, then from the cache at once', async () => {
  resetOrg();
  const vscode = require('vscode');
  const svc = panelServices();
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, svc);
  const p = mp.show();
  assert.match(p.webview.html, /dependencies\.js[\s\S]*app\.js/, 'shared rules load before the app');
  p._send({ type: 'ready' });
  await settle();
  const lists = posts(p, 'lists').pop();
  assert.deepStrictEqual([lists.lists.permissionSet.length, lists.lists.group.length, lists.lists.profile.length, lists.refreshing], [2, 1, 2, false]);
  const key = lists.lists.permissionSet.find(r => r.apiName === 'Sales_Ops').key;
  p._send({ type: 'select', key });
  await settle();
  const d = posts(p, 'detail').pop();
  assert.deepStrictEqual([d.refreshing, d.data.header.editable, d.data.header.modified.by], [false, true, 'Admin User']);
  p._send({ type: 'openObject', key, object: 'Lead' });
  await settle();
  assert.strictEqual(posts(p, 'objectDetail').pop().data.fields.filter(f => !f.fixed).length, 4);
  await svc.cacheFor('uat@example.com').flush();
  assert.ok(!JSON.stringify(p.posted).includes(S.token), 'no token reaches the webview');

  // Second session: everything shows from the cache before the org answers.
  const svc2 = panelServices({ projectDir: svc.projectDir, cacheFor: svc.cacheFor, connectDelay: 300 });
  svc2.resolveContext = svc.resolveContext;
  const mp2 = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, svc2);
  const p2 = mp2.show();
  p2._send({ type: 'ready' });
  await settle(40);
  const early = posts(p2, 'lists')[0];
  assert.ok(early && early.refreshing === true, 'cached lists shown while connecting');
  assert.strictEqual(posts(p2, 'context').pop().connecting, true);
  p2._send({ type: 'select', key });
  await settle(40);
  assert.ok(posts(p2, 'detail')[0] && posts(p2, 'detail')[0].refreshing === true, 'cached detail at once');
  await settle(500);
  assert.strictEqual(posts(p2, 'lists').pop().refreshing, false, 'fresh lists after');
  assert.strictEqual(posts(p2, 'detail').pop().refreshing, false, 'fresh detail after');
});

test('main screen: favourites first on a cold start, then everything; favourites prefetched', async () => {
  resetOrg();
  const vscode = require('vscode');
  const svc = panelServices();
  svc.favs = { items: ['permissionSet:Sales_Ops'], objects: ['Lead', 'Account'] };
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, svc);
  const p = mp.show();
  await mp.load();
  const ls = posts(p, 'lists');
  assert.ok(ls.length >= 2);
  assert.deepStrictEqual([ls[0].partial, ls[0].lists.permissionSet.map(r => r.apiName), ls[0].lists.profile.length], [true, ['Sales_Ops'], 0], 'favourites alone first');
  assert.deepStrictEqual([ls[ls.length - 1].partial, ls[ls.length - 1].lists.permissionSet.length], [undefined, 2], 'then the full lists');
  assert.deepStrictEqual(posts(p, 'favorites').pop(), { type: 'favorites', items: ['permissionSet:Sales_Ops'], objects: ['Lead', 'Account'] });
  await settle(300);
  const key = ls[0].lists.permissionSet[0].key;
  assert.ok(mp.cache.get('detail:' + key), 'favourite item prefetched');
  await mp.select(key);
  await settle(300);
  assert.ok(mp.cache.get('object:' + key + ':Lead') && mp.cache.get('object:' + key + ':Account'), 'favourite objects prefetched for the opened item');
  p._send({ type: 'toggleFavorite', kind: 'object', id: 'Lead' });
  await settle(30);
  assert.deepStrictEqual(posts(p, 'favorites').pop().objects, ['Account']);
});

test('main screen: Apex class, custom permission and record type tabs load on demand', async () => {
  resetOrg();
  fs.writeFileSync(tokenFile, S.token);
  await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE }, async () => {
    const vscode = require('vscode');
    const c = metaConn();
    const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, panelServices({ openConnection: async () => c }));
    const p = mp.show();
    await mp.load();
    const lists = posts(p, 'lists').pop().lists;
    const key = lists.permissionSet.find(r => r.apiName === 'Sales_Ops').key;
    await mp.select(key);
    assert.strictEqual(posts(p, 'accessDetail').length, 0, 'nothing read until the tab opens');
    p._send({ type: 'loadAccess', key, category: 'apexClass' });
    await settle(150);
    assert.deepStrictEqual(posts(p, 'accessDetail').pop().data.items.filter(x => x.enabled).map(x => x.name), ['LeadService']);
    await mp.openObject(key, 'Lead');
    await mp.openRecordTypes(key, 'Lead');
    const rt = posts(p, 'recordTypes').pop();
    assert.deepStrictEqual(rt.data.items.map(t => [t.name, t.visible]), [['Lead.Direct', false], ['Lead.Partner', true]]);
    assert.strictEqual(rt.data.profile, false);
    const n = S.retrieves;
    await mp.openRecordTypes(key, 'Lead');
    assert.strictEqual(posts(p, 'recordTypes').slice(-2)[0].refreshing, true, 'cached copy shown at once on the second open');
    assert.ok(S.retrieves > n);
    await mp.save({ key, object: 'Lead', changes: [{ key: 'recordType:Lead.Direct', before: { visible: false }, after: { visible: true } }] });
    assert.strictEqual(posts(p, 'saveResult').pop().status, 'saved');
    assert.strictEqual(posts(p, 'recordTypes').pop().data.items.find(t => t.name === 'Lead.Direct').visible, true, 're-read after the save');
  });
});

test('main screen: a deploy that removed access offers Restore, and Restore puts it back', async () => {
  resetOrg();
  fs.writeFileSync(tokenFile, S.token);
  S.deployWipesFields = true;
  await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE }, async () => {
    const vscode = require('vscode');
    const c = metaConn();
    const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, panelServices({ openConnection: async () => c }));
    const p = mp.show();
    await mp.load();
    const key = posts(p, 'lists').pop().lists.permissionSet.find(r => r.apiName === 'Sales_Ops').key;
    await mp.select(key);
    await mp.save({ key, object: 'Lead', changes: [{ key: 'recordType:Lead.Direct', before: { visible: false }, after: { visible: true } }] });
    const r = posts(p, 'saveResult').pop();
    assert.deepStrictEqual([r.status, r.restorable], ['error', true]);
    S.deployWipesFields = false;
    p._send({ type: 'restore', key, snapshotId: r.snapshotId });
    await settle(400);
    assert.match(posts(p, 'toast').pop().message, /1 permission put back/);
    assert.strictEqual(F.T.FieldPermissions.filter(f => f.ParentId === PS1).length, 1);
  });
});

test('main screen: group and standard profile pages are read-only with a reason', async () => {
  const vscode = require('vscode');
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, panelServices());
  const p = mp.show();
  await mp.load();
  const lists = posts(p, 'lists').pop().lists;
  await mp.select(lists.group[0].key);
  const g = posts(p, 'detail').pop().data.header;
  assert.deepStrictEqual([g.editableCats, g.kind], [['assignment', 'groupComponent'], 'Permission Set Group'], 'only assignments and members can change on a group');
  assert.match(g.readOnlyReason, /Permission Sets in Group/);
  await mp.select(lists.profile.find(r => r.standard).key);
  assert.match(posts(p, 'detail').pop().data.header.readOnlyReason, /Standard profiles/);
});

test('main screen save: production needs the typed name, then saves, logs, refreshes and offers undo', async () => {
  resetOrg();
  const vscode = require('vscode');
  const svc = panelServices();
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, svc);
  const p = mp.show();
  S.org.IsSandbox = false;
  await mp.load();
  assert.strictEqual(posts(p, 'context').pop().production, true);
  const key = posts(p, 'lists').pop().lists.permissionSet.find(r => r.apiName === 'Sales_Ops').key;
  await mp.select(key);
  const change = { key: 'field:Lead.Rating', before: { read: true, edit: false }, after: { read: true, edit: true } };
  await mp.save({ key, object: 'Lead', changes: [change], confirm: 'wrong' });
  assert.match(posts(p, 'saveResult').pop().message, /Type the org’s alias or username/);
  assert.strictEqual(F.T.FieldPermissions[0].PermissionsEdit, false, 'nothing written');
  p.posted.length = 0;
  await mp.save({ key, object: 'Lead', changes: [change], confirm: 'uat' });
  const res = posts(p, 'saveResult').pop();
  assert.strictEqual(res.status, 'saved', JSON.stringify(res));
  assert.deepStrictEqual(res.undo, [{ key: 'field:Lead.Rating', ref: null, after: { read: true, edit: false } }]);
  assert.ok(posts(p, 'saveProgress').length >= 1);
  assert.strictEqual(F.T.FieldPermissions[0].PermissionsEdit, true);
  assert.strictEqual(posts(p, 'objectDetail').pop().data.fields.find(f => f.apiName === 'Rating').edit, true, 'object page re-read after the save');
  const log = fs.readFileSync(path.join(svc.projectDir, '.permstudio', 'log', 'changes.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).pop();
  assert.deepStrictEqual([log.result, log.target, log.org, log.count], ['saved', 'Sales_Ops', 'uat@example.com', 1]);
  assert.ok(fs.existsSync(path.join(svc.projectDir, '.permstudio', 'snapshots', log.snapshot + '.json')));
  S.org.IsSandbox = true;
});

test('main screen save: conflicts come back for a decision; errors keep the edits and show the org’s values', async () => {
  resetOrg();
  const vscode = require('vscode');
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, panelServices());
  const p = mp.show();
  await mp.load();
  const key = posts(p, 'lists').pop().lists.permissionSet.find(r => r.apiName === 'Sales_Ops').key;
  await mp.select(key);
  await mp.save({ key, changes: [{ key: 'field:Lead.Rating', before: { read: false, edit: false }, after: { read: true, edit: true } }] });
  assert.strictEqual(posts(p, 'saveResult').pop().status, 'conflict');
  await mp.save({ key, changes: [{ key: 'user:ViewAllData', before: { enabled: true }, after: { enabled: false } }] });
  const err = posts(p, 'saveResult').pop();
  assert.strictEqual(err.status, 'error');
  assert.match(err.message, /depends on permission/);
  assert.strictEqual(posts(p, 'detail').pop().refreshing, false, 'detail re-read after the failure');
});

test('main screen: no project, no default org, and load errors each get their own state', async () => {
  const vscode = require('vscode');
  for (const [ctx, status] of [[{ projectDir: null, org: null }, 'noProject'], [{ projectDir: '/p', org: null }, 'noOrg']]) {
    const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, panelServices({ resolveContext: async () => ctx }));
    const p = mp.show();
    await mp.load();
    assert.strictEqual(posts(p, 'context').pop().status, status);
  }
  const svc = panelServices({ openConnection: async () => { throw new Error('The CLI could not renew the session for uat'); } });
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, svc);
  const p = mp.show();
  await mp.load();
  const last = posts(p, 'context').pop();
  assert.deepStrictEqual([last.status, /could not renew/.test(last.message)], ['error', true]);
});

test('main screen reloads only when the default org actually changes', async () => {
  const vscode = require('vscode');
  let current = 'uat@example.com';
  const svc = panelServices();
  svc.resolveContext = async () => ({ projectDir: svc.projectDir, org: { username: current, alias: current.split('@')[0] } });
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, svc);
  const p = mp.show();
  await mp.load();
  const n = posts(p, 'lists').length;
  await mp.defaultOrgMayHaveChanged();
  assert.strictEqual(posts(p, 'lists').length, n);
  current = 'prod@example.com';
  await mp.defaultOrgMayHaveChanged();
  await settle();
  assert.strictEqual(posts(p, 'context').pop().org.alias, 'prod');
  assert.ok(svc.logs.some(l => /Default org changed/.test(l)));
});

// ---------- 1.0.3: XML writing, local files, export ----------
const localFile = require('../src/xml/localFile');

test('values compare by content: lists, empty strings, missing booleans', () => {
  assert.deepStrictEqual(diff.differingFlags({ ranges: [{ a: 1 }] }, { ranges: [{ a: 1 }] }), []);
  assert.deepStrictEqual(diff.differingFlags({ ranges: [] }, { ranges: [{ a: 1 }] }), ['ranges']);
  assert.deepStrictEqual(diff.differingFlags({ mondayStart: '' }, {}), []);
  assert.deepStrictEqual(diff.differingFlags({ assigned: false, expires: null }, null), []);
  assert.deepStrictEqual(diff.differingFlags({ visibility: 'None' }, { visibility: 'Visible' }), ['visibility']);
});

test('entries are written the way Salesforce writes them', () => {
  assert.strictEqual(model.entryXml('permissionSet', 'field:Lead.Rating', { read: true, edit: false }),
    '    <fieldPermissions>\n        <editable>false</editable>\n        <field>Lead.Rating</field>\n        <readable>true</readable>\n    </fieldPermissions>');
  assert.match(model.entryXml('profile', 'recordType:Lead.Partner', { visible: true, default: true }), /<default>true<\/default>\n        <recordType>Lead.Partner<\/recordType>/);
  assert.ok(!/default/.test(model.entryXml('permissionSet', 'recordType:Lead.Partner', { visible: true, default: true })), 'permission sets have no default');
  assert.ok(!/recordType/.test(model.entryXml('profile', 'layoutAssignment:Lead.', { layout: 'Lead-Lead Layout' })), 'master layout has no record type');
  assert.match(model.entryXml('profile', 'app:Sales', { enabled: true }), /<application>Sales<\/application>\n        <default>false<\/default>\n        <visible>true<\/visible>/);
  assert.strictEqual(model.entryXml('profile', 'loginIpRanges:all', { ranges: [{ startAddress: '1.1.1.1', endAddress: '1.1.1.9', description: 'A & B' }] }).split('<loginIpRanges>').length, 2);
  assert.match(model.entryXml('permissionSet', 'tab:standard-Lead', { visibility: 'Visible' }), /<tabSettings>/);
  assert.match(model.entryXml('profile', 'tab:standard-Lead', { visibility: 'DefaultOn' }), /<tabVisibilities>/);
  assert.strictEqual(model.entryXml('permissionSet', 'connectedApp:X', { enabled: true }), null);
  assert.strictEqual(model.entryXml('permissionSet', 'assignment:005', { assigned: true }), null);
});

const PS_FILE = `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <fieldPermissions>
        <editable>false</editable>
        <field>Lead.Rating</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Lead.Website</field>
        <readable>true</readable>
    </fieldPermissions>
    <label>Sales Ops</label>
    <userPermissions>
        <enabled>true</enabled>
        <name>ApiEnabled</name>
    </userPermissions>
</PermissionSet>
`;

test('local file: changed entries replaced in place, new ones inserted in Salesforce order, the rest untouched', () => {
  const r = localFile.applyToText(PS_FILE, 'permissionSet', [
    { key: 'field:Lead.Rating', after: { read: true, edit: true } },
    { key: 'field:Lead.Industry', after: { read: true, edit: false } },
    { key: 'field:Lead.Zip__c', after: { read: true, edit: false } },
    { key: 'apexClass:LeadService', after: { enabled: true } },
    { key: 'user:ApiEnabled', after: { enabled: false } },
    { key: 'user:ViewSetup', after: { enabled: true } },
    { key: 'connectedApp:Data Loader', after: { enabled: true } }
  ]);
  const doc = require('../src/xml/flatXml').parse(r.text);
  assert.deepStrictEqual(doc.entries.map(e => e.tag + ':' + (e.values.field || e.values.name || e.values.apexClass)), [
    'classAccesses:LeadService', 'fieldPermissions:Lead.Industry', 'fieldPermissions:Lead.Rating', 'fieldPermissions:Lead.Website', 'fieldPermissions:Lead.Zip__c',
    'userPermissions:ApiEnabled', 'userPermissions:ViewSetup']);
  assert.strictEqual(doc.entries.find(e => e.values.field === 'Lead.Rating').values.editable, 'true');
  assert.strictEqual(doc.entries.find(e => e.values.name === 'ApiEnabled').values.enabled, 'false', 'revokes are explicit');
  assert.ok(r.text.includes('    <fieldPermissions>\n        <editable>false</editable>\n        <field>Lead.Website</field>'), 'untouched entries keep their exact text');
  assert.deepStrictEqual([r.applied.length, r.skipped], [6, ['connectedApp:Data Loader']]);
  const crlf = localFile.applyToText(PS_FILE.replace(/\n/g, '\r\n'), 'permissionSet', [{ key: 'field:Lead.Industry', after: { read: true, edit: false } }]).text;
  assert.ok(!/[^\r]\n/.test(crlf), 'CRLF files stay CRLF');
});

test('local file: profile layouts per record type, login hours and the IP range list as a whole', () => {
  const prof = `<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <custom>true</custom>
    <layoutAssignments>
        <layout>Lead-Lead Layout</layout>
    </layoutAssignments>
    <layoutAssignments>
        <layout>Lead-Lead Layout</layout>
        <recordType>Lead.Partner</recordType>
    </layoutAssignments>
    <loginIpRanges>
        <endAddress>10.0.0.255</endAddress>
        <startAddress>10.0.0.0</startAddress>
    </loginIpRanges>
    <loginIpRanges>
        <endAddress>10.1.0.255</endAddress>
        <startAddress>10.1.0.0</startAddress>
    </loginIpRanges>
    <userLicense>Salesforce</userLicense>
</Profile>
`;
  const r = localFile.applyToText(prof, 'profile', [
    { key: 'layoutAssignment:Lead.Partner', after: { layout: 'Lead-Partner Layout' } },
    { key: 'loginIpRanges:all', after: { ranges: [{ startAddress: '192.168.0.0', endAddress: '192.168.0.255', description: 'VPN' }] } },
    { key: 'loginHours:all', after: { mondayEnd: '1080', mondayStart: '480' } }
  ]);
  const doc = require('../src/xml/flatXml').parse(r.text);
  const la = doc.entries.filter(e => e.tag === 'layoutAssignments');
  assert.deepStrictEqual(la.map(e => [e.values.layout, e.values.recordType || '']), [['Lead-Lead Layout', ''], ['Lead-Partner Layout', 'Lead.Partner']], 'master untouched');
  assert.deepStrictEqual(doc.entries.filter(e => e.tag === 'loginIpRanges').map(e => e.values.startAddress), ['192.168.0.0'], 'list replaced');
  assert.deepStrictEqual(doc.entries.find(e => e.tag === 'loginHours').values, { mondayEnd: '1080', mondayStart: '480' });
  const none = localFile.applyToText(prof, 'profile', [{ key: 'loginIpRanges:all', after: { ranges: [] } }]).text;
  assert.ok(!/loginIpRanges/.test(none) && /<userLicense>/.test(none), 'all ranges removed, nothing else');
});

test('local file is found in the project’s package directories by its metadata name', () => {
  const proj = path.join(tmp, 'localproj');
  fs.mkdirSync(path.join(proj, 'force-app', 'main', 'default', 'permissionsets'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'force-app', 'main', 'default', 'profiles'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'node_modules', 'x', 'permissionsets'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] }));
  fs.writeFileSync(path.join(proj, 'force-app', 'main', 'default', 'permissionsets', 'Sales_Ops.permissionset-meta.xml'), PS_FILE);
  fs.writeFileSync(path.join(proj, 'force-app', 'main', 'default', 'profiles', 'Custom%3A Sales.profile-meta.xml'), '<Profile/>');
  assert.ok(localFile.findLocalFile(proj, item(), 'Sales_Ops').endsWith(path.join('permissionsets', 'Sales_Ops.permissionset-meta.xml')));
  assert.ok(localFile.findLocalFile(proj, { kind: 'profile' }, 'Custom%3A Sales').endsWith('Custom%3A Sales.profile-meta.xml'));
  assert.strictEqual(localFile.findLocalFile(proj, item(), 'Nope'), null);
  assert.strictEqual(localFile.findLocalFile(proj, { kind: 'group' }, 'Sales_Bundle'), null);
});

// ---------- 1.0.3: more categories, assignments, metadata-only settings ----------
test('every setup-entity category lists the org’s entities with what the item grants', async () => {
  resetOrg();
  const c = conn();
  const names = async cat => (await loader.loadEntityAccess(c, item(), cat)).items.map(x => x.name);
  assert.deepStrictEqual(await names('apexPage'), ['LeadWizard']);
  assert.deepStrictEqual(await names('flow'), ['Lead_Intake']);
  assert.deepStrictEqual(await names('app'), ['Sales', 'Service']);
  assert.deepStrictEqual(await names('connectedApp'), ['Data Loader']);
  assert.deepStrictEqual(await names('customMetadata'), ['Region__mdt']);
  assert.deepStrictEqual(await names('customSetting'), ['Config__c']);
  const r = await applyMod.apply(c, item(), [
    { key: 'flow:Lead_Intake', ref: '300000000000001AAA', before: { enabled: false }, after: { enabled: true } },
    { key: 'app:Sales', ref: '02u000000000001AAA', before: { enabled: false }, after: { enabled: true } },
    { key: 'customMetadata:Region__mdt', ref: '01I000000000001AAA', before: { enabled: false }, after: { enabled: true } },
    { key: 'connectedApp:Data Loader', ref: '0H4000000000001AAA', before: { enabled: false }, after: { enabled: true } }
  ], saveOpts());
  assert.strictEqual(r.status, 'saved');
  assert.deepStrictEqual(r.mismatches, []);
  assert.deepStrictEqual(F.T.SetupEntityAccess.filter(x => x.ParentId === PS1).map(x => x.SetupEntityType).sort(), ['ApexClass', 'ConnectedApplication', 'CustomEntityDefinition', 'CustomPermission', 'FlowDefinition', 'TabSet']);
});

test('assignments: list, search users, add with expiry, change expiry, remove; groups and managed sets too', async () => {
  resetOrg();
  const c = conn();
  const a = await loader.loadAssignments(c, item());
  assert.deepStrictEqual(a.items.map(u => [u.name, u.expires]), [['Ana Lima', null], ['Ben Okafor', '2026-12-31']]);
  assert.strictEqual(a.expiration, 'datetime');
  assert.deepStrictEqual((await loader.loadAssignments(c, { kind: 'group', recordId: '0PG000000000001AAA' })).items.map(u => u.name), ['Cara Diaz']);
  const prof = await loader.loadAssignments(c, { kind: 'profile', recordId: '00e000000000002AAA' });
  assert.deepStrictEqual([prof.readOnly, prof.items.map(u => u.name)], [true, ['Ana Lima', 'Cara Diaz']], 'inactive users left out');
  assert.deepStrictEqual((await loader.searchUsers(c, 'old')).map(u => u.name), [], 'inactive users are not offered');
  assert.deepStrictEqual((await loader.searchUsers(c, 'CARA')).map(u => u.username), ['cara@example.com']);
  assert.deepStrictEqual(await loader.searchUsers(c, "x'; DROP"), []);
  const r = await applyMod.apply(c, item(), [
    { key: 'assignment:005000000000003AAA', ref: '005000000000003AAA', before: { assigned: false, expires: null }, after: { assigned: true, expires: '2027-01-31' } },
    { key: 'assignment:005000000000002AAA', ref: '005000000000002AAA', before: { assigned: true, expires: '2026-12-31' }, after: { assigned: true, expires: null } },
    { key: 'assignment:005000000000001AAA', ref: '005000000000001AAA', before: { assigned: true, expires: null }, after: { assigned: false, expires: null } }
  ], saveOpts());
  assert.strictEqual(r.status, 'saved', JSON.stringify(r));
  assert.deepStrictEqual(r.mismatches, []);
  const now = (await loader.loadAssignments(c, item())).items.map(u => [u.name, u.expires]);
  assert.deepStrictEqual(now, [['Ben Okafor', null], ['Cara Diaz', '2027-01-31']]);
  const g = await applyMod.apply(c, { kind: 'group', recordId: '0PG000000000001AAA', permissionSetId: '0PS00000000000GAAA', apiName: 'Sales_Bundle' },
    [{ key: 'assignment:005000000000001AAA', ref: '005000000000001AAA', before: { assigned: false }, after: { assigned: true, expires: null } }], saveOpts());
  assert.strictEqual(g.status, 'saved');
  assert.ok(F.T.PermissionSetAssignment.some(x => x.AssigneeId === '005000000000001AAA' && x.PermissionSetGroupId === '0PG000000000001AAA'));
  const managed = await applyMod.apply(c, item({ permissionSetId: '0PS000000000002AAA', recordId: '0PS000000000002AAA', managed: true }),
    [{ key: 'assignment:005000000000002AAA', ref: '005000000000002AAA', before: { assigned: false }, after: { assigned: true, expires: null } }], saveOpts());
  assert.strictEqual(managed.status, 'saved', 'managed permission sets can still be assigned');
});

test('what can be changed where', () => {
  const ed = applyMod.editableCategories;
  assert.deepStrictEqual(ed({ kind: 'group' }), ['assignment', 'groupComponent']);
  assert.deepStrictEqual(ed({ kind: 'permissionSet', managed: true }), ['assignment']);
  assert.deepStrictEqual(ed({ kind: 'profile', standard: true }), []);
  const ps = ed({ kind: 'permissionSet' });
  assert.ok(ps.includes('tab') && ps.includes('assignment') && !ps.includes('layoutAssignment') && !ps.includes('loginHours'));
  const prof = ed({ kind: 'profile' });
  assert.ok(prof.includes('layoutAssignment') && prof.includes('loginIpRanges') && !prof.includes('assignment') && prof.includes('tab'), 'profiles take tab settings since 2.1.0');
});

test('tab settings are records: saved with other changes in one request, for permission sets and profiles, no deploy', async () => {
  resetOrg();
  fs.writeFileSync(tokenFile, S.token);
  await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE }, async () => {
    const c = metaConn();
    const page = await loader.loadTabsPage(c, item());
    assert.deepStrictEqual(page.items.map(t => [t.name, t.visibility]), [['standard-Account', 'None'], ['Custom_Thing__c', 'None'], ['standard-Lead', 'Visible']]);
    const calls = [];
    const spy = Object.assign({}, metadata, { deployEntries: async () => { calls.push('deploy'); }, captureSafety: async () => { calls.push('safety'); return {}; } });
    S.compositeWrites = 0;
    const r = await applyMod.apply(c, item(), [
      { key: 'tab:standard-Account', before: { visibility: 'None' }, after: { visibility: 'Available' } },
      { key: 'tab:standard-Lead', before: { visibility: 'Visible' }, after: { visibility: 'None' } },
      { key: 'field:Lead.Industry', before: null, after: { read: true, edit: false } }
    ], saveOpts({ metadata: spy }));
    assert.deepStrictEqual([r.status, r.mismatches, r.oneRequest], ['saved', [], true], JSON.stringify(r));
    assert.deepStrictEqual(calls, [], 'no Metadata API deploy, no safety copy');
    assert.strictEqual(S.compositeWrites, 1, 'tabs and the field change in one request');
    assert.deepStrictEqual(F.T.PermissionSetTabSetting.filter(t => t.ParentId === PS1).map(t => [t.Name, t.Visibility]), [['standard-Account', 'DefaultOff']], 'a hidden tab has no row');
    const prof = { kind: 'profile', recordId: '00e000000000002AAA', permissionSetId: '0PS0000000000PRAAA', apiName: 'Custom: Sales', label: 'Custom: Sales' };
    const p2 = await applyMod.apply(c, prof, [{ key: 'tab:standard-Lead', before: { visibility: 'None' }, after: { visibility: 'Visible' } }], saveOpts({ metadata: spy }));
    assert.strictEqual(p2.status, 'saved', 'profile tab settings, through the profile\u2019s permission set');
    assert.ok(F.T.PermissionSetTabSetting.some(t => t.ParentId === '0PS0000000000PRAAA' && t.Name === 'standard-Lead' && t.Visibility === 'DefaultOn'));
    await assert.rejects(applyMod.apply(c, prof, [{ key: 'tab:standard-Lead', before: { visibility: 'Visible' }, after: { visibility: 'Sometimes' } }], saveOpts({ metadata: spy })), /unknown tab visibility/);
  });
});

test('profile files: tab values written in the profile\u2019s own words', () => {
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata">\n    <tabVisibilities>\n        <tab>standard-Lead</tab>\n        <visibility>DefaultOn</visibility>\n    </tabVisibilities>\n</Profile>\n';
  const out = localFile.applyToText(xml, 'profile', [{ key: 'tab:standard-Lead', after: { visibility: 'None' } }, { key: 'tab:standard-Account', after: { visibility: 'Available' } }]).text;
  assert.ok(out.includes('<tab>standard-Lead</tab>\n        <visibility>Hidden</visibility>') && out.includes('<tab>standard-Account</tab>\n        <visibility>DefaultOff</visibility>'), out);
  const psOut = localFile.applyToText(xml.replace(/Profile/g, 'PermissionSet').replace(/tabVisibilities/g, 'tabSettings').replace('DefaultOn', 'Visible'), 'permissionSet',
    [{ key: 'tab:standard-Lead', after: { visibility: 'Available' } }]).text;
  assert.ok(psOut.includes('<visibility>Available</visibility>'), 'permission sets keep Visible / Available / None');
});

const PROFILE = () => ({ kind: 'profile', recordId: '00e000000000002AAA', permissionSetId: '0PS0000000000PRAAA', apiName: 'Custom: Sales', label: 'Custom: Sales' });
test('page layout assignments: read per record type, changed with a deploy, checked after', async () => {
  resetOrg();
  fs.writeFileSync(tokenFile, S.token);
  await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE }, async () => {
    const c = metaConn();
    const d = await metadata.readLayouts(c, PROFILE(), 'Lead');
    assert.deepStrictEqual(d.layouts.map(l => l.name), ['Lead-Lead Layout', 'Lead-Partner Layout']);
    assert.deepStrictEqual(d.rows.map(r => [r.label, r.layout]), [['Master', 'Lead-Lead Layout'], ['Direct Lead', ''], ['Partner Lead', 'Lead-Partner Layout']]);
    const r = await applyMod.apply(c, PROFILE(), [{ key: 'layoutAssignment:Lead.Direct', before: { layout: '' }, after: { layout: 'Lead-Partner Layout' } }], saveOpts({ metadata }));
    assert.strictEqual(r.status, 'saved', JSON.stringify(r));
    assert.deepStrictEqual(r.mismatches, []);
    assert.strictEqual(S.layouts['0PS0000000000PRAAA']['Lead.Direct'], 'Lead-Partner Layout');
    assert.ok(/<recordType>Lead.Direct<\/recordType>/.test(S.deploys.pop().xml));
    assert.deepStrictEqual((await metadata.listLayouts(c, 'Custom_Thing__c')).map(l => l.name), ['Custom_Thing__c-Thing Layout'], 'custom objects found by entity Id');
  });
});

test('login hours and IP ranges: read, validated, the list saved whole, and a deploy that only adds is caught', async () => {
  resetOrg();
  fs.writeFileSync(tokenFile, S.token);
  await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE }, async () => {
    const c = metaConn();
    const l = await metadata.readLoginSettings(c, PROFILE());
    assert.deepStrictEqual(l, { hours: { mondayEnd: '1080', mondayStart: '480' }, ranges: [{ startAddress: '10.0.0.0', endAddress: '10.0.0.255', description: 'Office' }] });
    await assert.rejects(applyMod.apply(c, PROFILE(), [{ key: 'loginIpRanges:all', before: { ranges: l.ranges }, after: { ranges: [{ startAddress: '300.1.1.1', endAddress: '1.1.1.1' }] } }], saveOpts({ metadata })), /not an IPv4 address/);
    const wanted = [{ startAddress: '192.168.1.0', endAddress: '192.168.1.255', description: 'VPN' }];
    const r = await applyMod.apply(c, PROFILE(), [
      { key: 'loginIpRanges:all', before: { ranges: l.ranges }, after: { ranges: wanted } },
      { key: 'loginHours:all', before: l.hours, after: { mondayStart: '420', mondayEnd: '1140', fridayStart: '420', fridayEnd: '960' } }
    ], saveOpts({ metadata }));
    assert.strictEqual(r.status, 'saved', JSON.stringify(r));
    assert.deepStrictEqual(r.mismatches, []);
    assert.deepStrictEqual(S.ipRanges['0PS0000000000PRAAA'], wanted);
    assert.strictEqual(S.loginHours['0PS0000000000PRAAA'].fridayEnd, '960');
    S.ipRangesAdditive = true;
    const r2 = await applyMod.apply(c, PROFILE(), [{ key: 'loginIpRanges:all', before: { ranges: wanted }, after: { ranges: [{ startAddress: '172.16.0.0', endAddress: '172.16.0.255', description: '' }] } }], saveOpts({ metadata }));
    assert.strictEqual(r2.mismatches.length, 1, 'an org that adds instead of replacing is reported');
    assert.strictEqual(r2.mismatches[0].now.ranges.length, 2);
  });
});

test('who has access: both halves of field access, from any mix of sources, down to users', async () => {
  resetOrg();
  F.T.ObjectPermissions.push({ Id: '110000000000009AAA', ParentId: PS1, SobjectType: 'Lead', PermissionsRead: true, PermissionsCreate: false, PermissionsEdit: false, PermissionsDelete: false, PermissionsViewAllRecords: false, PermissionsModifyAllRecords: false, PermissionsViewAllFields: false });
  F.T.PermissionSet.find(x => x.Id === '0PS000000000009AAA').PermissionsViewAllData = true;
  F.T.FieldPermissions.push({ Id: '01k000000000009AAA', ParentId: '0PS000000000009AAA', SobjectType: 'Lead', Field: 'Lead.Industry', PermissionsRead: true, PermissionsEdit: false });
  const c = conn();
  const r = await loader.whoHasAccess(c, { object: 'Lead', field: 'Rating', level: 'read' });
  assert.deepStrictEqual(r.users.map(u => u.name), ['Ana Lima', 'Ben Okafor']);
  const ben = r.users.find(u => u.name === 'Ben Okafor');
  assert.deepStrictEqual([ben.objectFrom.sort(), ben.fieldFrom], [['0PS000000000001AAA', '0PS000000000009AAA'], ['0PS000000000001AAA']]);
  const admin = r.sources.find(s => s.kind === 'profile');
  assert.deepStrictEqual([admin.label, admin.objectVia, admin.fieldVia], ['System Administrator', ['ViewAllData'], []]);
  const ind = await loader.whoHasAccess(c, { object: 'Lead', field: 'Lead.Industry', level: 'read' });
  assert.deepStrictEqual([ind.users.map(u => u.name), ind.partial.map(u => u.name)], [['Ben Okafor'], ['Ana Lima']], 'Ana has the object but not the field');
  assert.deepStrictEqual((await loader.whoHasAccess(c, { object: 'Lead', field: 'Rating', level: 'edit' })).users, []);
  const acc = await loader.whoHasAccess(c, { object: 'Account', level: 'read' });
  assert.deepStrictEqual(acc.users.map(u => u.name), ['Ana Lima', 'Ben Okafor', 'Cara Diaz'], 'group members through the group’s calculated permissions');
  assert.strictEqual(acc.sources.find(s => s.kind === 'group').label, 'Sales Bundle');
  await assert.rejects(loader.whoHasAccess(c, { object: 'Lead', level: 'nope' }), /Unknown access level/);
});

// ---------- 1.0.3: panel tools ----------
test('field access wizard: a plan per item, skipping what can’t or needn’t change, then saved item by item', async () => {
  resetOrg();
  const vscode = require('vscode');
  const svc = panelServices();
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, svc);
  const p = mp.show();
  await mp.load();
  const lists = posts(p, 'lists').pop().lists;
  const keyOf = (kind, label) => lists[kind].find(r => r.label === label).key;
  await mp.wizardFields('Lead');
  const fields = posts(p, 'wizardFields').pop().fields.filter(f => ['Industry', 'Score__c', 'Rating'].includes(f.apiName));
  await mp.wizardPlan({ object: 'Lead', fields, level: 'edit', grantObject: true, targets: [keyOf('permissionSet', 'Sales Ops'), keyOf('profile', 'Custom: Sales'), keyOf('permissionSet', 'Reader'), keyOf('profile', 'System Administrator')] });
  const plan = posts(p, 'wizardPlan').pop();
  assert.deepStrictEqual(plan.plan.map(t => t.label), ['Sales Ops', 'Custom: Sales']);
  assert.deepStrictEqual(plan.skipped.map(x => x.label).sort(), ['Reader', 'System Administrator']);
  const so = plan.plan[0];
  assert.deepStrictEqual(so.changes.map(c => c.key), ['object:Lead', 'field:Lead.Industry', 'field:Lead.Rating', 'field:Lead.Score__c']);
  assert.deepStrictEqual(so.changes.find(c => c.key === 'field:Lead.Score__c').after, { read: true, edit: false }, 'read-only field gets Read only');
  assert.deepStrictEqual([so.changes[0].after.read, so.changes[0].after.edit], [true, true], 'object Read and Edit granted where missing');
  await mp.wizardApply({ plan: plan.plan });
  const res = posts(p, 'wizardResult').pop();
  assert.deepStrictEqual(res.results.map(r => [r.label, r.status]), [['Sales Ops', 'saved'], ['Custom: Sales', 'saved']]);
  assert.ok(F.T.FieldPermissions.some(f => f.ParentId === '0PS0000000000PRAAA' && f.Field === 'Lead.Industry' && f.PermissionsEdit));
  assert.strictEqual(posts(p, 'wizardProgress').length, 2);
});

test('rename and clone permission sets; clones carry every kind of access', async () => {
  resetOrg();
  fs.writeFileSync(tokenFile, S.token);
  await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE }, async () => {
    const vscode = require('vscode');
    const c = metaConn();
    const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, panelServices({ openConnection: async () => c }));
    const p = mp.show();
    await mp.load();
    const srcKey = posts(p, 'lists').pop().lists.permissionSet.find(r => r.apiName === 'Sales_Ops').key;
    await mp.clonePs({ key: srcKey, label: 'Sales Ops Copy', name: 'Sales_Ops_Copy' });
    const cl = posts(p, 'psSaved').pop();
    assert.ok(!cl.error, cl.error);
    const id = cl.key.split(':')[1];
    assert.deepStrictEqual(F.T.ObjectPermissions.filter(x => x.ParentId === id).map(x => x.SobjectType).sort(), ['Account', 'Custom_Thing__c']);
    assert.deepStrictEqual(F.T.FieldPermissions.filter(x => x.ParentId === id).map(x => x.Field), ['Lead.Rating']);
    assert.deepStrictEqual(F.T.SetupEntityAccess.filter(x => x.ParentId === id).map(x => x.SetupEntityType).sort(), ['ApexClass', 'CustomPermission']);
    const copy = F.T.PermissionSet.find(x => x.Id === id);
    assert.deepStrictEqual([copy.PermissionsModifyAllData, copy.PermissionsViewAllData, copy.PermissionsFeature007WithAFairlyLongName], [true, true, true]);
    assert.deepStrictEqual(S.rtVis[id], { 'Lead.Partner': { visible: true } }, 'record types copied');
    assert.deepStrictEqual(F.T.PermissionSetTabSetting.filter(t => t.ParentId === id).map(t => t.Name), ['standard-Lead'], 'tab settings copied');
    assert.ok(posts(p, 'cloneProgress').length >= 3);
    await mp.editPs({ key: cl.key, label: 'Sales Ops Clone', name: 'Sales_Ops_Clone', description: 'Renamed' });
    assert.ok(F.T.PermissionSet.some(x => x.Id === id && x.Name === 'Sales_Ops_Clone' && x.Label === 'Sales Ops Clone'));
    await mp.editPs({ key: cl.key, label: 'Bad', name: 'Bad__Name' });
    assert.match(posts(p, 'psSaved').pop().error, /can’t contain two underscores in a row/, 'checked before anything is sent');
  });
});

test('save history: newest first for this org, and any save can be undone through review', async () => {
  resetOrg();
  const vscode = require('vscode');
  const svc = panelServices();
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, svc);
  const p = mp.show();
  await mp.load();
  const key = posts(p, 'lists').pop().lists.permissionSet.find(r => r.apiName === 'Sales_Ops').key;
  await mp.select(key);
  await mp.save({ key, changes: [{ key: 'field:Lead.Rating', before: { read: true, edit: false }, after: { read: true, edit: true } }] });
  await mp.save({ key, changes: [{ key: 'apexClass:AccountTriggerHandler', ref: '01p000000000001AAA', before: { enabled: false }, after: { enabled: true } }] });
  await mp.sendHistory();
  const h = posts(p, 'history').pop().entries;
  assert.deepStrictEqual(h.map(e => [e.target, e.changes[0].key, e.key]), [['Sales_Ops', 'apexClass:AccountTriggerHandler', key], ['Sales_Ops', 'field:Lead.Rating', key]]);
  await mp.undoSnapshot(h[1].snapshot);
  const st = posts(p, 'stageChanges').pop();
  assert.deepStrictEqual([st.key, st.changes], [key, [{ key: 'field:Lead.Rating', ref: null, before: { read: true, edit: true }, after: { read: true, edit: false } }]], 'current value against the value before that save');
  await mp.undoSnapshot('nope');
  assert.match(posts(p, 'toast').pop().message, /ENOENT|no such file/i);
});

test('saving can also update the project’s source file', async () => {
  resetOrg();
  const vscode = require('vscode');
  const svc = panelServices({ localFile });
  const proj = svc.projectDir;
  fs.mkdirSync(path.join(proj, 'force-app', 'main', 'default', 'permissionsets'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app' }] }));
  const file = path.join(proj, 'force-app', 'main', 'default', 'permissionsets', 'Sales_Ops.permissionset-meta.xml');
  fs.writeFileSync(file, PS_FILE);
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, svc);
  const p = mp.show();
  await mp.load();
  const key = posts(p, 'lists').pop().lists.permissionSet.find(r => r.apiName === 'Sales_Ops').key;
  await mp.select(key);
  await settle(80);
  assert.strictEqual(posts(p, 'localFile').pop().path, path.join('force-app', 'main', 'default', 'permissionsets', 'Sales_Ops.permissionset-meta.xml'));
  await mp.save({ key, writeLocal: true, changes: [{ key: 'field:Lead.Rating', before: { read: true, edit: false }, after: { read: true, edit: true } },
    { key: 'customPermission:Bypass_Validation', ref: '0CP000000000002AAA', before: { enabled: false }, after: { enabled: true } }] });
  const r = posts(p, 'saveResult').pop();
  assert.deepStrictEqual([r.status, r.local.applied, r.local.skipped], ['saved', 2, 0]);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(/<editable>true<\/editable>\n        <field>Lead.Rating<\/field>/.test(text) && /<name>Bypass_Validation<\/name>/.test(text));
  await mp.save({ key, writeLocal: false, changes: [{ key: 'field:Lead.Rating', before: { read: true, edit: true }, after: { read: true, edit: false } }] });
  assert.strictEqual(posts(p, 'saveResult').pop().local, null);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), text, 'left alone when not asked');
});

// ---------- 2.0.0: background start, auto-refresh, list choice, object access wizard ----------
test('only the chosen lists are loaded and shown; the choice travels with the lists', async () => {
  resetOrg();
  const vscode = require('vscode');
  const svc = panelServices({ kinds: () => ['permissionSet', 'profile'] });
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, svc);
  const p = mp.show();
  S.requests = [];
  await mp.load();
  const l = posts(p, 'lists').pop();
  assert.deepStrictEqual([l.kinds, l.lists.group.length, l.lists.permissionSet.length > 0], [['permissionSet', 'profile'], 0, true]);
  assert.ok(!S.requests.some(r => /PermissionSetGroup\+ORDER|FROM%20PermissionSetGroup%20ORDER|MasterLabel/.test(r.url)), 'groups not even read');
  assert.deepStrictEqual(posts(p, 'context').pop().kinds, ['permissionSet', 'profile']);
});

test('background start: everything is loaded before the screen opens, and the screen joins it', async () => {
  resetOrg();
  const vscode = require('vscode');
  const svc = panelServices({ connectDelay: 120 });
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, svc);
  const running = mp.load();
  assert.ok(mp._loading, 'a load is in progress with no screen open');
  const p = mp.show();
  p._send({ type: 'ready' });
  await running;
  await settle(60);
  assert.strictEqual(svc.opens, 1, 'opening the screen did not start a second load');
  assert.ok(posts(p, 'lists').length >= 1 && posts(p, 'context').pop().status === 'ready');
});

test('auto-refresh re-reads the lists only after an org change, then refreshes what is on screen', async () => {
  resetOrg();
  const vscode = require('vscode');
  const svc = panelServices();
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, svc);
  const p = mp.show();
  await mp.load();
  const before = posts(p, 'lists').length;
  assert.strictEqual(await mp.autoRefresh(), true);
  assert.strictEqual(posts(p, 'lists').length, before, 'nothing changed: lists not re-read');
  assert.ok(posts(p, 'listsChecked').length === 1 && posts(p, 'autoRefresh').length === 1);
  F.T.PermissionSet[0].Label = 'Sales Ops Renamed in Setup';
  F.T.PermissionSet[0].SystemModstamp = new Date(Date.now() + 60000).toISOString();
  await mp.autoRefresh();
  assert.strictEqual(posts(p, 'lists').pop().lists.permissionSet.find(r => r.apiName === 'Sales_Ops').label, 'Sales Ops Renamed in Setup');
  mp._saving = true;
  assert.strictEqual(await mp.autoRefresh(), false, 'never during a save');
  mp._saving = false;
  assert.ok(svc.logs.some(l => /Auto-refresh: lists unchanged/.test(l)) && svc.logs.some(l => /lists changed and re-read/.test(l)));
});

test('grant object access: permissions only added, record types assigned, profile defaults moved', async () => {
  resetOrg();
  fs.writeFileSync(tokenFile, S.token);
  await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE }, async () => {
    const vscode = require('vscode');
    const c = metaConn();
    const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, panelServices({ openConnection: async () => c, gate }));
    const p = mp.show();
    await mp.load();
    const lists = posts(p, 'lists').pop().lists;
    const so = lists.permissionSet.find(r => r.apiName === 'Sales_Ops').key;
    const prof = lists.profile.find(r => r.label === 'Custom: Sales').key;
    const reader = lists.permissionSet.find(r => r.apiName === 'acme__Reader').key;
    await mp.objWizardInfo('Lead');
    const info = posts(p, 'objWizardInfo').pop();
    assert.deepStrictEqual(info.recordTypes.map(t => t.name), ['Lead.Direct', 'Lead.Partner']);
    await mp.objWizardPlan({ object: 'Lead', flags: ['read', 'edit'], recordTypes: ['Lead.Direct'], defaultRt: 'Lead.Direct', targets: [so, prof, reader] });
    const plan = posts(p, 'objWizardPlan').pop();
    assert.deepStrictEqual(plan.skipped.map(x => x.label), ['Reader']);
    const ps = plan.plan.find(t => t.key === so);
    assert.deepStrictEqual(ps.changes.map(c2 => [c2.key, c2.after]), [
      ['object:Lead', { read: true, create: false, edit: true, delete: false, viewAll: false, modifyAll: false, viewAllFields: false }],
      ['recordType:Lead.Direct', { visible: true }]], 'permission sets have no default');
    const pr = plan.plan.find(t => t.key === prof);
    assert.deepStrictEqual(pr.changes.filter(c2 => c2.key.startsWith('recordType:')).map(c2 => [c2.key, c2.after]).sort(), [
      ['recordType:Lead.Direct', { visible: true, default: true }], ['recordType:Lead.Partner', { visible: true, default: false }]], 'the old default gives way');
    await mp.objWizardApply({ plan: plan.plan });
    const res = posts(p, 'objWizardResult').pop();
    assert.deepStrictEqual(res.results.map(r => r.status), ['saved', 'saved'], JSON.stringify(res));
    assert.deepStrictEqual(S.rtVis['0PS0000000000PRAAA'], { 'Lead.Partner': { visible: true, default: false }, 'Lead.Direct': { visible: true, default: true } });
    assert.ok(F.T.ObjectPermissions.some(x => x.ParentId === PS1 && x.SobjectType === 'Lead' && x.PermissionsEdit));
    await mp.objWizardPlan({ object: 'Account', flags: ['read'], recordTypes: [], targets: [so] });
    assert.deepStrictEqual(posts(p, 'objWizardPlan').pop().skipped.map(x => x.reason), ['Already has this access.'], 'nothing is ever taken away');
  });
});

test('activation starts loading in the background and schedules auto-refresh; focus rule respected', async () => {
  const vscode = require('vscode');
  const timers = [];
  const realSet = global.setInterval;
  global.setInterval = (fn, ms) => { timers.push([fn, ms]); return 0; };
  try {
    vscode.__config['permStudio.autoRefresh.minutes'] = 45;
    require('../extension').activate({ subscriptions: { push() {} }, extensionUri: vscode.Uri.file(ROOT), globalStorageUri: vscode.Uri.file(path.join(tmp, 'gs2')), extension: { packageJSON: { version: '2.0.0' } } });
    assert.strictEqual(timers[timers.length - 1][1], 30 * 60 * 1000, 'clamped to 30 minutes');
    vscode.window.state.focused = false;
    timers[timers.length - 1][0]();
    vscode.window.state.focused = true;
    assert.ok(vscode.__windowListeners.length > 0);
  } finally { global.setInterval = realSet; delete vscode.__config['permStudio.autoRefresh.minutes']; }
  await settle(30);
});

test('HTTP client: gzip responses, proxy- and certificate-aware modules, readable network errors', async () => {
  S.gzip = true;
  const r = await nodeFetch(INSTANCE + '/services/data/v62.0/sobjects', { method: 'GET', headers: { Authorization: 'Bearer ' + S.token } });
  assert.strictEqual(r.status, 200);
  assert.ok(JSON.parse(await r.text()).sobjects.length > 0, 'gzip body decoded');
  S.gzip = false;
  const dead = conn({ fetch: undefined });
  dead.instanceUrl = 'http://127.0.0.1:9';
  const logs = [];
  dead._log = l => logs.push(l);
  await assert.rejects(dead.query('SELECT Id FROM Organization'));
  assert.strictEqual(dead.mode, 'cli', 'an unreachable host switches to the CLI');
  assert.ok(logs.some(l => /HTTP request failed: .*ECONNREFUSED/.test(l)), 'the reason is logged: ' + logs.join(' | '));
});

// ---------- 2.0.1: the CLI's own connection library ----------
const sfcore = require('../src/org/sfcore');
const FAKE_ROOT = path.join(__dirname, 'fixtures', 'fake-cli-root');
const memento = () => { const m = new Map(); return { get: k => m.get(k), update: async (k, v) => { if (v === undefined) m.delete(k); else m.set(k, v); }, _m: m }; };

test('CLI library: found through the CLI once, then from memory with no sf process at all', async () => {
  sfcore.reset();
  resetCalls();
  const mem = memento();
  await withEnv({ FAKE_SF_ROOT: FAKE_ROOT, FAKE_SF_CALLS: callsFile }, async () => {
    const a = await sfcore.load(fakeSf, tmp, mem);
    assert.ok(a.path.endsWith(path.join('@salesforce', 'core', 'index.js')) && typeof a.core.Org.create === 'function');
    assert.deepStrictEqual(cliCalls().map(x => x[0]), ['version']);
    assert.strictEqual(process.env.SF_DISABLE_LOG_FILE, 'true', 'the library writes no log files of its own');
    sfcore.reset(); resetCalls();
    await sfcore.load(fakeSf, tmp, mem);
    assert.strictEqual(cliCalls().length, 0, 'remembered location: no sf process');
    sfcore.reset();
    await mem.update(sfcore.CACHE_KEY, path.join(tmp, 'gone', 'index.js'));
    await withEnv({ FAKE_SF_NO_ROOTPATH: '1' }, async () => { assert.ok((await sfcore.load(fakeSf, tmp, mem)).path.includes('fake-cli-root'), 'stale location re-found, through the plugin list on older CLIs'); });
  });
  sfcore.reset();
});

test('sf version and sf plugins answer in bare JSON (the 2.0.1 bug): the install folder is still read', async () => {
  sfcore.reset();
  await withEnv({ FAKE_SF_ROOT: FAKE_ROOT }, async () => {
    assert.strictEqual(await sfcore.cliRoot(fakeSf, tmp), FAKE_ROOT);
    await withEnv({ FAKE_SF_NO_ROOTPATH: '1' }, async () => {
      assert.ok((await sfcore.cliRoot(fakeSf, tmp)).startsWith(FAKE_ROOT), 'older CLIs: from the plugin list');
    });
  });
  await withEnv({ FAKE_SF_ROOT: '', FAKE_SF_NO_ROOTPATH: '1' }, async () => {
    await assert.rejects(sfcore.load(fakeSf, tmp, memento(), null, { env: {}, homedir: path.join(tmp, 'nohome3') }), /Cannot find module|installPath/);
  });
  sfcore.reset();
});

/** Lays out a fake CLI install (with the stand-in library) under `root`. */
function fakeInstall(root) {
  const dst = path.join(root, 'node_modules', '@salesforce', 'core');
  fs.mkdirSync(dst, { recursive: true });
  for (const f of ['index.js', 'package.json']) fs.copyFileSync(path.join(FAKE_ROOT, 'node_modules', '@salesforce', 'core', f), path.join(dst, f));
  return dst;
}

test('CLI library found on disk without starting sf: self-update folder, installer and npm layouts, setting override', async () => {
  sfcore.reset();
  const base = path.join(tmp, 'installs');
  // Windows self-update folders: newest version wins.
  const lad = path.join(base, 'LocalAppData');
  fakeInstall(path.join(lad, 'sf', 'client', '2.90.0-aaa'));
  await new Promise(r => setTimeout(r, 20));
  const newest = fakeInstall(path.join(lad, 'sf', 'client', '2.99.1-bbb'));
  assert.strictEqual(sfcore.findOnDisk({ platform: 'win32', env: { LOCALAPPDATA: lad }, homedir: base }), path.join(newest, 'index.js'));
  // Installer: <install>\bin\sf.cmd on PATH, library in <install>\client.
  const inst = path.join(base, 'ProgramFiles', 'sf');
  fs.mkdirSync(path.join(inst, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(inst, 'bin', 'sf.cmd'), '@echo off');
  const instCore = fakeInstall(path.join(inst, 'client'));
  assert.strictEqual(sfcore.findOnDisk({ platform: 'win32', env: { PATH: path.join(inst, 'bin') }, homedir: base }), path.join(instCore, 'index.js'));
  // npm on macOS/Linux: <prefix>/bin/sf is a link into lib/node_modules/@salesforce/cli/bin.
  const prefix = path.join(base, 'npm');
  const cli = path.join(prefix, 'lib', 'node_modules', '@salesforce', 'cli');
  fs.mkdirSync(path.join(cli, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(cli, 'bin', 'run.js'), '');
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  fs.symlinkSync(path.join(cli, 'bin', 'run.js'), path.join(prefix, 'bin', 'sf'));
  const npmCore = fakeInstall(cli);
  assert.strictEqual(sfcore.findOnDisk({ platform: 'linux', env: { PATH: path.join(prefix, 'bin') }, homedir: path.join(base, 'h') }), path.join(npmCore, 'index.js'));
  // The whole load, with no sf process at all.
  resetCalls();
  await withEnv({ FAKE_SF_CALLS: callsFile }, async () => {
    const r = await sfcore.load(fakeSf, tmp, memento(), null, { platform: 'win32', env: { LOCALAPPDATA: lad }, homedir: base });
    assert.strictEqual(r.path, path.join(newest, 'index.js'));
    assert.strictEqual(cliCalls().length, 0);
  });
  sfcore.reset();
  assert.strictEqual((await sfcore.load(fakeSf, tmp, memento(), null, { installPath: path.join(inst, 'client'), env: {} })).path, path.join(instCore, 'index.js'), 'the setting wins');
  sfcore.reset();
  await assert.rejects(sfcore.load(fakeSf, tmp, memento(), null, { installPath: path.join(base, 'nothing-here'), env: {} }), /permStudio.sf.installPath/);
  sfcore.reset();
});

test('CLI library: works where direct REST is refused (the reported case), renews its own session, saves too', async () => {
  resetOrg();
  sfcore.reset();
  S.rejectDirect = true;
  resetCalls();
  try {
    await withEnv({ FAKE_SF_ROOT: FAKE_ROOT, FAKE_SF_INSTANCE: INSTANCE, FAKE_SF_CALLS: callsFile }, async () => {
      const mem = memento();
      await sfcore.load(fakeSf, tmp, mem);
      resetCalls();
      const logs = [];
      const opener = async u => sfcore.connect((await sfcore.load(fakeSf, tmp, mem)).core, u, '62.0');
      const c = await open({ username: 'uat@example.com', alias: 'uat' }, { sfPath: fakeSf, openLibrary: opener, log: l => logs.push(l) });
      assert.strictEqual(c.mode, 'library');
      assert.strictEqual(cliCalls().length, 0, 'no sf org display, no sf process at all');
      const d = await loader.loadDetail(c, item());
      assert.strictEqual(d.model.entries.get('user:ModifyAllData').enabled, true);
      assert.ok(global.__fakeCore.renewals >= 1, 'the library renewed its stale token itself');
      const ps = await catalog.listAll(c, ['permissionSet', 'profile']);
      assert.ok(ps.permissionSet.length === 2 && ps.profile.length === 2);
      const r = await applyMod.apply(c, item(), [{ key: 'field:Lead.Rating', before: { read: true, edit: false }, after: { read: true, edit: true } }], saveOpts());
      assert.deepStrictEqual([r.status, r.mismatches], ['saved', []]);
      await assert.rejects(c.query('SELECT Nope FROM Nowhere'), e => e.errorCode === 'MALFORMED_QUERY');
      assert.strictEqual(c.mode, 'library', 'errors never switch away from the library');
    });
  } finally { S.rejectDirect = false; sfcore.reset(); }
});

test('CLI library unavailable: falls back to direct REST and says why; forced library mode fails loudly', async () => {
  resetOrg();
  fs.writeFileSync(tokenFile, S.token);
  await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE }, async () => {
    const logs = [];
    const broken = async () => { throw new Error('Cannot find module @salesforce/core'); };
    const c = await open({ username: 'uat@example.com', alias: 'uat' }, { sfPath: fakeSf, openLibrary: broken, log: l => logs.push(l) });
    assert.strictEqual(c.mode, 'rest');
    assert.ok(logs.some(l => /CLI library could not be used \(Cannot find module/.test(l)));
    await assert.rejects(open({ username: 'uat@example.com' }, { sfPath: fakeSf, openLibrary: broken, mode: 'library' }), /Cannot find module/);
  });
});

test('a refused session is logged with Salesforce’s error code and host, and the likely reason', async () => {
  resetOrg();
  S.rejectDirect = true;
  fs.writeFileSync(tokenFile, S.token);
  try {
    await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE }, async () => {
      const logs = [];
      const c = conn({ log: l => logs.push(l) });
      await c.query('SELECT IsSandbox FROM Organization LIMIT 1');
      const host = new URL(INSTANCE).host;
      assert.ok(logs.some(l => l.includes('from ' + host + ' (INVALID_SESSION_ID: Session expired or invalid; token from the CLI: unrecognised format,')), logs.join(' | '));
      assert.ok(!logs.join(' ').includes(S.token), 'the token itself is never logged');
      assert.ok(logs.some(l => /locks sessions to the IP address/.test(l)));
  assert.strictEqual(tokenShape('00D5g000004ABCD!AQ4AQ.xyz_1'), 'session ID format, 27 characters');
  assert.strictEqual(tokenShape('ab12:cd34:ef'), 'looks encrypted (hex with colons), 12 characters');
    });
  } finally { S.rejectDirect = false; }
});

// ---------- 2.0.4: permission set groups, change summaries, opening items ----------
const summaryMod = require('../src/changes/summary');
const GROUP = () => ({ kind: 'group', recordId: '0PG000000000001AAA', permissionSetId: '0PS00000000000GAAA', apiName: 'Sales_Bundle', label: 'Sales Bundle' });

test('groups: members with labels, the muting permission set, and the recalculation status', async () => {
  resetOrg();
  const g = await loader.loadGroupComponents(conn(), GROUP());
  assert.strictEqual(g.status, 'Updated');
  assert.deepStrictEqual(g.components.map(c => [c.label, c.apiName, c.muting]), [['Sales Ops', 'Sales_Ops', false], ['Sales Bundle Muting', 'Sales_Bundle_Muting', true]]);
});

test('groups: add and remove member permission sets as records; only groups can', async () => {
  resetOrg();
  const c = conn();
  const r = await applyMod.apply(c, GROUP(), [
    { key: 'groupComponent:0PS000000000002AAA', ref: '0PS000000000002AAA', before: { included: false }, after: { included: true } },
    { key: 'groupComponent:0PS000000000001AAA', ref: '0PS000000000001AAA', before: { included: true }, after: { included: false } }
  ], saveOpts());
  assert.deepStrictEqual([r.status, r.mismatches], ['saved', []]);
  assert.deepStrictEqual(F.T.PermissionSetGroupComponent.map(x => x.PermissionSetId).sort(), ['0PS000000000002AAA', '0QM000000000001AAA'], 'muting component untouched');
  assert.strictEqual(F.T.PermissionSetGroup[0].Status, 'Updating', 'Salesforce starts recalculating');
  await assert.rejects(applyMod.apply(c, item(), [{ key: 'groupComponent:x', ref: '0PS000000000002AAA', before: null, after: { included: true } }], saveOpts()), /Only permission set groups/);
  await assert.rejects(applyMod.apply(c, Object.assign(GROUP(), { managed: true }), [{ key: 'groupComponent:x', ref: '0PS000000000002AAA', before: null, after: { included: true } }], saveOpts()), /managed package/);
  assert.deepStrictEqual(applyMod.editableCategories(GROUP()), ['assignment', 'groupComponent']);
});

test('groups on screen: members listed, a change saved, the recalculation watched until it settles', async () => {
  resetOrg();
  const vscode = require('vscode');
  const svc = panelServices({ pollMs: 5 });
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, svc);
  const p = mp.show();
  await mp.load();
  const key = posts(p, 'lists').pop().lists.group[0].key;
  await mp.select(key);
  await mp.openComponents(key);
  assert.strictEqual(posts(p, 'components').pop().data.components.length, 2);
  F.T.PermissionSetGroup[0].Status = 'Updated';
  await mp.save({ key, changes: [{ key: 'groupComponent:0PS000000000002AAA', ref: '0PS000000000002AAA', before: { included: false }, after: { included: true }, label: 'Reader' }] });
  assert.strictEqual(posts(p, 'saveResult').pop().status, 'saved');
  await settle(120);
  const seen = posts(p, 'groupStatus').map(m => m.status);
  assert.deepStrictEqual([seen[0], seen[seen.length - 1]], ['Updating', 'Updated'], seen.join(','));
  assert.ok(posts(p, 'detail').pop().refreshing === false && svc.logs.some(l => /Group Sales_Bundle recalculated: Updated/.test(l)), 'group access re-read after recalculation');
  assert.strictEqual(posts(p, 'components').pop().data.components.length, 3);
});

test('change summary: Markdown table for tickets, tab-separated for Excel, plain words for every kind of change', () => {
  const entries = [
    { at: '2026-10-31T09:15:00.000Z', target: 'Sales_Ops', result: 'saved', snapshot: 's1', changes: [
      { key: 'object:Lead', label: 'Lead', from: { read: true }, to: { read: true, edit: true } },
      { key: 'field:Lead.Rating', label: 'Rating', from: { read: true, edit: false }, to: { read: false, edit: false } },
      { key: 'user:ModifyAllData', label: 'Modify All Data', from: { enabled: false }, to: { enabled: true } },
      { key: 'recordType:Lead.Partner', label: 'Partner Lead', from: null, to: { visible: true, default: true } },
      { key: 'assignment:005A', label: 'Ana Lima', from: { assigned: false }, to: { assigned: true, expires: '2027-01-31' } },
      { key: 'loginHours:all', label: 'Login hours', from: {}, to: { mondayStart: '480', mondayEnd: '1080' } },
      { key: 'apexClass:Pipe|Class', label: 'Pipe|Class', from: { enabled: false }, to: { enabled: true } }] },
    { at: '2026-10-31T10:00:00.000Z', target: 'Sales_Bundle', result: 'saved', snapshot: 's2', changes: [
      { key: 'groupComponent:0PS2', label: 'Reader', from: { included: false }, to: { included: true } }] }
  ];
  const one = summaryMod.toMarkdown([entries[0]], { org: 'uat' });
  assert.ok(one.startsWith('### Permission changes: Sales_Ops (uat)\nSaved '));
  assert.ok(one.includes('| Area | Entry | Before | After |'));
  assert.ok(one.includes('| Object Permissions | Lead | Read | Read, Edit |'));
  assert.ok(one.includes('| Field Permissions | Lead.Rating | Read | No access |'), 'a label that only repeats the API name is not shown twice');
  assert.ok(one.includes('| System Permissions | Modify All Data (ModifyAllData) | Disabled | Enabled |'));
  assert.ok(one.includes('| Record Type Assignments | Partner Lead (Lead.Partner) | Not assigned | Assigned (default) |'));
  assert.ok(one.includes('| Assignments | Ana Lima | Not assigned | Assigned until 2027-01-31 |'));
  assert.ok(one.includes('| Login Hours | Login Hours | No restriction | Mon 08:00–18:00 |'));
  assert.ok(one.includes('Pipe\\|Class'), 'pipes escaped');
  const both = summaryMod.toMarkdown(entries, { org: 'uat' });
  assert.ok(both.includes('| Item | Area | Entry | Before | After | Saved |') && both.includes('| Sales_Bundle | Permission Sets in Group | Reader | Not included | Included |'));
  const tsv = summaryMod.toTsv(entries, { org: 'uat' }).split('\n');
  assert.strictEqual(tsv[0], 'Item\tArea\tEntry\tBefore\tAfter\tSaved\tOrg\tResult\tTicket');
  assert.strictEqual(tsv[1].split('\t').slice(0, 5).join('|'), 'Sales_Ops|Object Permissions|Lead|Read|Read, Edit');
  assert.strictEqual(tsv.filter(Boolean).length, 9);
});

test('copy summary from the screen: real saves, labels kept, straight to the clipboard', async () => {
  resetOrg();
  const vscode = require('vscode');
  let clip = null;
  const svc = panelServices({ summary: summaryMod, clipboard: async t => { clip = t; } });
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, svc);
  const p = mp.show();
  await mp.load();
  const key = posts(p, 'lists').pop().lists.permissionSet.find(r => r.apiName === 'Sales_Ops').key;
  await mp.select(key);
  await mp.save({ key, changes: [{ key: 'field:Lead.Rating', label: 'Rating', before: { read: true, edit: false }, after: { read: true, edit: true } }] });
  await mp.save({ key, changes: [{ key: 'apexClass:AccountTriggerHandler', label: 'AccountTriggerHandler', ref: '01p000000000001AAA', before: { enabled: false }, after: { enabled: true } }] });
  const ids = (await history.readLog(svc.projectDir, {})).map(e => e.snapshot);
  await mp.copySummary({ snapshotIds: ids, format: 'markdown' });
  assert.ok(clip.includes('| Field Permissions | Lead.Rating | Read | Read, Edit |') && clip.includes('| Apex Class Access | AccountTriggerHandler | Disabled | Enabled |'), clip);
  assert.match(posts(p, 'toast').pop().message, /Summary of 2 changes as a Markdown table/);
  await mp.copySummary({ snapshotIds: [ids[0]], format: 'tsv' });
  assert.ok(clip.startsWith('Item\tArea'));
  await mp.copySummary({ snapshotIds: ['nope'] });
  assert.match(posts(p, 'toast').pop().message, /not in this project/);
});

test('open from a file: permission sets, encoded and standard profile names, a hidden group loaded on demand', async () => {
  resetOrg();
  const vscode = require('vscode');
  const svc = panelServices({ kinds: () => ['permissionSet', 'profile'] });
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, svc);
  await mp.load();
  const dir = '/proj/force-app/main/default/';
  assert.strictEqual(await mp.itemForFile(dir + 'permissionsets/Sales_Ops.permissionset-meta.xml'), 'permissionSet:0PS000000000001AAA');
  assert.strictEqual(await mp.itemForFile(dir + 'permissionsets/acme__Reader.permissionset-meta.xml'), 'permissionSet:0PS000000000002AAA');
  assert.strictEqual(await mp.itemForFile(dir + 'profiles/Custom%3A Sales.profile-meta.xml'), 'profile:00e000000000002AAA');
  assert.strictEqual(await mp.itemForFile(dir + 'profiles/Admin.profile-meta.xml'), 'profile:00e000000000001AAA');
  assert.strictEqual(await mp.itemForFile(dir + 'permissionsetgroups/Sales_Bundle.permissionsetgroup-meta.xml'), 'group:0PG000000000001AAA', 'groups list hidden: fetched on demand');
  await assert.rejects(mp.itemForFile(dir + 'permissionsets/Gone.permissionset-meta.xml'), /“Gone” was not found/);
  await assert.rejects(mp.itemForFile(dir + 'classes/Foo.cls'), /Not a permission set, profile or permission set group file/);
});

test('open from elsewhere: the quick pick lists favourites first; the screen opens on the item once ready', async () => {
  resetOrg();
  const vscode = require('vscode');
  const svc = panelServices({ kinds: () => ['permissionSet', 'profile'] });
  svc.favs = { items: ['profile:System Administrator'], objects: [] };
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, svc);
  await mp.load();
  const items = await mp.quickPickItems();
  assert.deepStrictEqual(items.map(i => [i.label, i.favorite]), [['System Administrator', true], ['Custom: Sales', false], ['Reader', false], ['Sales Ops', false]]);
  assert.match(items.find(i => i.label === 'Reader').detail, /Permission set · Salesforce · Managed/);
  await mp.openItem(items[0].key);
  const p = mp.panel;
  assert.strictEqual(posts(p, 'selectKey').length, 0, 'waits for the webview');
  p._send({ type: 'ready' });
  await settle(60);
  assert.deepStrictEqual(posts(p, 'selectKey').pop(), { type: 'selectKey', key: items[0].key });
  await mp.openItem(items[1].key);
  assert.deepStrictEqual(posts(p, 'selectKey').pop(), { type: 'selectKey', key: items[1].key }, 'already open: straight away');
});

test('the file commands appear only on permission set, profile and group files', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const when = pkg.contributes.menus['explorer/context'][0].when;
  const re = new RegExp(when.match(/\/(.*)\//)[1]);
  for (const f of ['Sales.permissionset-meta.xml', 'Custom%3A Sales.profile-meta.xml', 'Bundle.permissionsetgroup-meta.xml']) assert.ok(re.test(f), f);
  for (const f of ['Lead.object-meta.xml', 'Foo.cls', 'Sales.permissionset-meta.xml.bak']) assert.ok(!re.test(f), f);
  assert.deepStrictEqual(['explorer/context', 'editor/title', 'editor/title/context', 'commandPalette'].map(m => pkg.contributes.menus[m][0].command), Array(4).fill('permStudio.openFile'));
});

// ---------- 2.0.8: objects without object permissions; required and system fields ----------
test('saving object access for Event is stopped with a clear reason, before anything is written', async () => {
  resetOrg();
  const c = conn();
  S.writes = [];
  await assert.rejects(applyMod.apply(c, item(), [
    { key: 'object:Event', before: null, after: { read: true, create: false, edit: false, delete: false, viewAll: false, modifyAll: false, viewAllFields: false } },
    { key: 'field:Lead.Industry', before: null, after: { read: true, edit: false } }], saveOpts()),
  e => /Event: Salesforce has no object permissions for this object \(activity access comes from the Edit Tasks and Edit Events system permissions\)/.test(e.message));
  assert.strictEqual(S.writes.length, 0, 'nothing written, not even the valid field change');
  const r = await applyMod.apply(c, item(), [{ key: 'field:Event.Region__c', before: null, after: { read: true, edit: true } }], saveOpts());
  assert.deepStrictEqual([r.status, r.mismatches], ['saved', []], 'an activity field\u2019s access can still be set');
});

test('Event opens with its fields and a note instead of object permissions', async () => {
  const od = await loader.loadObjectDetail(conn(), item(), 'Event');
  assert.strictEqual(od.objectPermissions, false);
  assert.deepStrictEqual(od.fields.map(f => [f.apiName, !!f.fixed]), [['Region__c', false], ['Subject', true]]);
  assert.strictEqual(od.fields.find(f => f.apiName === 'Region__c').read, true, 'the saved field access is shown');
});

test('who has access on Event: by field only, with a clear message for object-level questions', async () => {
  const c = conn();
  await assert.rejects(loader.whoHasAccess(c, { object: 'Event', level: 'read' }), /Event has no object permissions in Salesforce: activity access comes from the Edit Tasks and Edit Events/);
  const r = await loader.whoHasAccess(c, { object: 'Event', field: 'Region__c', level: 'edit' });
  assert.strictEqual(r.fieldOnly, true);
  assert.deepStrictEqual(r.users.map(u => u.name), ['Ana Lima', 'Ben Okafor'], 'everyone who gets the field from Sales Ops');
  assert.deepStrictEqual(r.partial, []);
});

test('wizards: field access for activities skips the object step; object access refuses activities', async () => {
  resetOrg();
  const vscode = require('vscode');
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, panelServices());
  const p = mp.show();
  await mp.load();
  const so = posts(p, 'lists').pop().lists.permissionSet.find(r => r.apiName === 'Sales_Ops').key;
  await mp.wizardPlan({ object: 'Event', fields: [{ name: 'Event.Region__c', canEdit: true }], targets: [so], level: 'read', grantObject: true });
  assert.deepStrictEqual(posts(p, 'wizardPlan').pop().plan[0].changes.map(c => c.key), ['field:Event.Region__c'], 'no object change attempted');
  await mp.objWizardPlan({ object: 'Task', flags: ['read'], recordTypes: [], targets: [so] });
  assert.match(posts(p, 'objWizardPlan').pop().error, /Task has no object permissions in Salesforce/);
});

// ---------- 2.0.9: permission sets inside recalculating groups ----------
// The reported save: field access added, an Apex class added and one removed, object access widened, a system permission on.
const REPORTED = () => [
  { key: 'field:Lead.Industry', before: null, after: { read: true, edit: false } },
  { key: 'field:Lead.Description', before: null, after: { read: true, edit: true } },
  { key: 'apexClass:AccountTriggerHandler', ref: '01p000000000001AAA', before: { enabled: false }, after: { enabled: true } },
  { key: 'object:Account', before: { read: true, create: true, edit: true, delete: false, viewAll: false, modifyAll: false, viewAllFields: false },
    after: { read: true, create: true, edit: true, delete: true, viewAll: false, modifyAll: false, viewAllFields: false } },
  { key: 'user:ApiEnabled', before: { enabled: false }, after: { enabled: true } },
  { key: 'apexClass:LeadService', ref: '01p000000000002AAA', before: { enabled: true }, after: { enabled: false } }
];
function reportedSaved() {
  assert.ok(F.T.FieldPermissions.some(x => x.ParentId === PS1 && x.Field === 'Lead.Description' && x.PermissionsEdit));
  assert.ok(!F.T.SetupEntityAccess.some(x => x.ParentId === PS1 && x.SetupEntityId === '01p000000000002AAA'), 'the removal that failed in the report is saved');
  assert.ok(F.T.SetupEntityAccess.some(x => x.ParentId === PS1 && x.SetupEntityId === '01p000000000001AAA'));
  assert.strictEqual(F.T.ObjectPermissions.find(x => x.ParentId === PS1 && x.SobjectType === 'Account').PermissionsDelete, true);
  assert.strictEqual(F.T.PermissionSet.find(x => x.Id === PS1).PermissionsApiEnabled, true);
}

test('the reported save, inside a group: everything in one request, one transaction, no waiting', async () => {
  resetOrg();
  S.lockDuringRecalc = true;
  try {
    S.requests = []; S.compositeWrites = 0;
    const progress = [];
    const r = await applyMod.apply(conn(), item(), REPORTED(), Object.assign(saveOpts(), { pollMs: 5, onProgress: m => progress.push(m) }));
    assert.deepStrictEqual([r.status, r.mismatches, r.oneRequest], ['saved', [], true], JSON.stringify(r));
    assert.strictEqual(S.compositeWrites, 1, 'one request carried the adds, the update and the removal');
    assert.ok(!S.requests.some(x => /\/composite\/sobjects/.test(x.url)), 'no separate writes');
    assert.strictEqual(S.refusedWhileUpdating, 0);
    assert.ok(progress.includes('Saving all 6 record changes in one request'), progress.join(' | '));
    reportedSaved();
    assert.strictEqual(F.T.PermissionSetGroup[0].Status, 'Updating', 'the group recalculates once, after the transaction');
  } finally { S.lockDuringRecalc = false; }
});

test('if Salesforce locks the permission set inside one request: rolled back, then saved step by step with waiting', async () => {
  resetOrg();
  S.lockDuringRecalc = true; S.compositeLocks = true;
  const logs = [];
  try {
    const progress = [];
    const r = await applyMod.apply(conn(), item(), REPORTED(), Object.assign(saveOpts(), { pollMs: 5, onProgress: m => progress.push(m), log: l => logs.push(l) }));
    assert.deepStrictEqual([r.status, r.mismatches, r.oneRequest], ['saved', [], false], JSON.stringify(r));
    assert.ok(logs.some(l => /One-request save not used \(DELETE_FAILED: The Sales_Bundle permission set group is updating/.test(l)) || logs.some(l => /One-request save not used/.test(l)), logs.join(' | '));
    assert.ok(progress.some(m => /^Waiting for Salesforce to finish recalculating Sales_Bundle/.test(m)), progress.join(' | '));
    reportedSaved();
  } finally { S.lockDuringRecalc = false; S.compositeLocks = false; }
});

test('if a failed request was not rolled back, only what is missing is sent again', async () => {
  resetOrg();
  S.lockDuringRecalc = true; S.compositeLocks = true; S.compositeNoRollback = true;
  try {
    const r = await applyMod.apply(conn(), item(), REPORTED(), Object.assign(saveOpts(), { pollMs: 5 }));
    assert.deepStrictEqual([r.status, r.mismatches], ['saved', []], JSON.stringify(r));
    reportedSaved();
    assert.strictEqual(F.T.FieldPermissions.filter(x => x.ParentId === PS1 && x.Field === 'Lead.Description').length, 1, 'no duplicate rows');
  } finally { S.lockDuringRecalc = false; S.compositeLocks = false; S.compositeNoRollback = false; }
});

test('orgs that refuse writes in one request, and CLI connections, save step by step', async () => {
  resetOrg();
  S.noCompositeWrites = true;
  try {
    const r = await applyMod.apply(conn(), item(), REPORTED(), Object.assign(saveOpts(), { pollMs: 5 }));
    assert.deepStrictEqual([r.status, r.oneRequest], ['saved', false]);
    reportedSaved();
  } finally { S.noCompositeWrites = false; }
  resetOrg();
  fs.writeFileSync(tokenFile, S.token);
  await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE }, async () => {
    S.compositeWrites = 0;
    const r = await applyMod.apply(conn({ mode: 'cli' }), item(), REPORTED(), Object.assign(saveOpts(), { pollMs: 5 }));
    assert.deepStrictEqual([r.status, r.oneRequest], ['saved', false]);
    assert.strictEqual(S.compositeWrites, 0);
    reportedSaved();
  });
});

test('a group still recalculating from an earlier change is waited for before the first write; a stuck one stops cleanly', async () => {
  resetOrg();
  S.lockDuringRecalc = true;
  try {
    F.T.PermissionSetGroup[0].Status = 'Updating';
    S.groupPolls = 3;
    S.writes = [];
    const progress = [];
    const r = await applyMod.apply(conn(), item(), [{ key: 'field:Lead.Industry', before: null, after: { read: true, edit: false } }],
      Object.assign(saveOpts(), { pollMs: 5, onProgress: m => progress.push(m) }));
    assert.strictEqual(r.status, 'saved');
    assert.strictEqual(S.refusedWhileUpdating, 0, 'waited instead of being refused');
    assert.ok(progress[0].startsWith('Waiting for Salesforce to finish recalculating Sales_Bundle'));
    F.T.PermissionSetGroup[0].Status = 'Updating';
    S.groupPolls = 0;
    S.writes = [];
    await assert.rejects(applyMod.apply(conn(), item(), [{ key: 'field:Lead.Description', before: null, after: { read: true, edit: true } }],
      Object.assign(saveOpts(), { pollMs: 5, maxGroupWaitMs: 40 })), e => e.tag === 'GROUP_BUSY' && /still recalculating Sales_Bundle after .*Save again once the group shows Updated/.test(e.message));
    assert.strictEqual(S.writes.length, 0, 'nothing sent');
  } finally { S.lockDuringRecalc = false; }
});

test('outside groups: one request and no status checks; the CLI path takes each record\u2019s own type', async () => {
  resetOrg();
  S.requests = [];
  const r = await applyMod.apply(conn(), Object.assign(item(), { permissionSetId: '0PS000000000002AAA' }), [
    { key: 'field:Lead.Industry', before: null, after: { read: true, edit: false } },
    { key: 'object:Contact', before: null, after: { read: true, create: false, edit: false, delete: false, viewAll: false, modifyAll: false, viewAllFields: false } }
  ], Object.assign(saveOpts(), { pollMs: 5000 }));
  assert.deepStrictEqual([r.status, r.oneRequest], ['saved', true]);
  assert.ok(!S.requests.some(x => /PermissionSetGroup%20WHERE|PermissionSetGroup\+WHERE/.test(x.url)), 'not in a group: no status checks');
  await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE }, async () => {
    fs.writeFileSync(tokenFile, S.token);
    await conn({ mode: 'cli' }).createRecords([{ attributes: { type: 'FieldPermissions' }, ParentId: '0PS000000000002AAA', SobjectType: 'Lead', Field: 'Lead.Rating', PermissionsRead: true, PermissionsEdit: false }]);
    assert.ok(F.T.FieldPermissions.some(x => x.ParentId === '0PS000000000002AAA' && x.Field === 'Lead.Rating'));
  });
});

test('Object Settings lists objects where only fields are granted, such as Event', async () => {
  resetOrg();
  const c = conn();
  await applyMod.apply(c, item(), [{ key: 'field:Event.Region__c', before: null, after: { read: true, edit: false } }], saveOpts());
  const d = await loader.loadDetail(c, item());
  assert.deepStrictEqual(d.fieldObjects.find(f => f.name === 'Event'), { name: 'Event', label: 'Event', fields: 1, objectPermissions: false });
  assert.strictEqual(d.fieldObjects.find(f => f.name === 'Lead').objectPermissions, true, 'Lead can take object access; it just has none yet');
  assert.ok(d.fieldObjects.some(f => f.name === 'Lead'), 'every object with field grants is counted');
  const vscode = require('vscode');
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, panelServices());
  const p = mp.show();
  await mp.load();
  await mp.select(posts(p, 'lists').pop().lists.permissionSet.find(r => r.apiName === 'Sales_Ops').key);
  const view = posts(p, 'detail').pop().data;
  assert.deepStrictEqual(view.fieldObjects.map(f => f.name), ['Event', 'Lead'], 'objects with field grants but no object access are added; Account is listed already');
});

// ---------- 2.1.0: rules, security view, profile copy, licences, Setup changes, profile filtering ----------
test('Salesforce\u2019s dependency rules are read for system and custom permissions; other kinds are left out', async () => {
  resetOrg();
  const d = await loader.permissionDependencies(conn());
  assert.deepStrictEqual(d.system, { ModifyAllData: ['ViewAllData'], PermissionsViewAllData: ['PermissionsApiEnabled'] }, 'object-permission rules skipped; names as the org gives them');
  assert.deepStrictEqual(d.custom, { '0CP000000000002AAA': ['0CP000000000001AAA'] });
  assert.deepStrictEqual(d.problems, []);
});

test('the screen gets the rules once and keeps them a day', async () => {
  resetOrg();
  const vscode = require('vscode');
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, panelServices());
  const p = mp.show();
  await mp.load();
  S.requests = [];
  await mp.postDependencies();
  await mp.postDependencies();
  assert.strictEqual(S.requests.filter(r => / FROM PermissionDependency$/.test(decodeURIComponent(r.url).split('?q=').pop())).length, 1, 'read once, then cached');
  assert.deepStrictEqual(posts(p, 'permDeps').pop().custom, { '0CP000000000002AAA': ['0CP000000000001AAA'] });
});

test('who has a system or custom permission, through which permission sets, profiles and groups', async () => {
  resetOrg();
  const c = conn();
  const opts = await loader.permissionOptions(c);
  assert.ok(opts.system.some(o => o.name === 'ModifyAllData'));
  assert.deepStrictEqual(opts.custom.map(o => [o.id, o.name]), [['0CP000000000001AAA', 'Approve_Discounts'], ['0CP000000000002AAA', 'Bypass_Validation']]);
  const r = await loader.whoHasPermission(c, { kind: 'system', name: 'ModifyAllData', label: 'Modify All Data' });
  assert.deepStrictEqual(r.permission, { kind: 'system', name: 'ModifyAllData', label: 'Modify All Data' });
  assert.ok(r.sources.some(x => x.label === 'Sales Ops' && x.kind === 'permissionSet'));
  const viaPs1 = new Set(F.T.PermissionSetAssignment.filter(a => a.PermissionSetId === PS1).map(a => a.AssigneeId));
  for (const u of r.users) assert.ok(u.objectFrom.length);
  assert.ok([...viaPs1].every(id => !F.T.User.find(x => x.Id === id && x.IsActive) || r.users.some(u => u.userId === id)), 'everyone assigned Sales Ops is listed');
  const cp = await loader.whoHasPermission(c, { kind: 'custom', id: '0CP000000000001AAA', label: 'Approve Discounts' });
  assert.deepStrictEqual(cp.sources.map(x => x.label), ['Sales Ops']);
  await assert.rejects(loader.whoHasPermission(c, { kind: 'system', name: 'Drop; Table' }), /Unknown system permission/);
  const vscode = require('vscode');
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, panelServices());
  const p = mp.show();
  await mp.load();
  await mp.lookupPermission({ kind: 'system', name: 'ModifyAllData', label: 'Modify All Data' });
  assert.ok(posts(p, 'lookupResult').pop().result.sources.find(x => x.label === 'Sales Ops').key, 'sources link to their item');
});

test('copy a profile to a new permission set: its access, its licence, tab settings and record types; the profile untouched', async () => {
  resetOrg();
  fs.writeFileSync(tokenFile, S.token);
  F.T.PermissionSetTabSetting.push({ Id: '01P000000000009AAA', ParentId: '0PS0000000000PRAAA', Name: 'standard-Account', Visibility: 'DefaultOff' });
  const before = JSON.stringify([F.T.ObjectPermissions, F.T.FieldPermissions].map(t => t.filter(x => x.ParentId === '0PS0000000000PRAAA')));
  await withEnv({ FAKE_SF_TOKEN: tokenFile, FAKE_SF_INSTANCE: INSTANCE }, async () => {
    const vscode = require('vscode');
    const c = metaConn();
    const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, panelServices({ openConnection: async () => c }));
    const p = mp.show();
    await mp.load();
    const key = posts(p, 'lists').pop().lists.profile.find(r => r.label === 'Custom: Sales').key;
    await mp.select(key);
    assert.strictEqual(posts(p, 'detail').pop().data.header.canCopyToPs, true);
    await mp.copyProfile({ key, label: 'Sales Access', name: 'Sales_Access', description: 'From the Custom: Sales profile' });
    const done = posts(p, 'psSaved').pop();
    assert.ok(!done.error, done.error);
    assert.strictEqual(done.mode, 'copyProfile');
    const id = done.key.split(':')[1];
    const made = F.T.PermissionSet.find(x => x.Id === id);
    assert.deepStrictEqual([made.Name, made.LicenseId, made.IsOwnedByProfile], ['Sales_Access', '100000000000001AAA', false], 'with the profile\u2019s user licence');
    const objs = t => F.T[t].filter(x => x.ParentId === '0PS0000000000PRAAA').length;
    assert.strictEqual(F.T.ObjectPermissions.filter(x => x.ParentId === id).length, objs('ObjectPermissions'));
    assert.strictEqual(F.T.FieldPermissions.filter(x => x.ParentId === id).length, objs('FieldPermissions'));
    assert.deepStrictEqual(F.T.PermissionSetTabSetting.filter(t => t.ParentId === id).map(t => [t.Name, t.Visibility]), [['standard-Account', 'DefaultOff']], 'tab settings copied as records');
    assert.ok(done.counts && done.counts.tabs === 1 && typeof done.counts.recordTypes === 'number');
    assert.strictEqual(JSON.stringify([F.T.ObjectPermissions, F.T.FieldPermissions].map(t => t.filter(x => x.ParentId === '0PS0000000000PRAAA'))), before, 'nothing removed from the profile');
    await mp.copyProfile({ key: posts(p, 'lists').pop().lists.permissionSet[0].key, label: 'X', name: 'X' });
    assert.match(posts(p, 'psSaved').pop().error, /Only profiles can be copied/);
  });
});

test('licences are checked before assigning: user licence and permission set licence', async () => {
  resetOrg();
  const c = conn();
  const ps1 = F.T.PermissionSet.find(x => x.Id === PS1);
  Object.assign(ps1, { LicenseId: '100000000000001AAA', License: { Name: 'Salesforce' } });
  const cara = F.T.User.find(u => u.Name === 'Cara Diaz');
  cara.Profile = Object.assign({}, cara.Profile, { UserLicenseId: '100000000000002AAA', UserLicense: { Name: 'Salesforce Platform' } });
  const b = await loader.assignmentBlockers(c, item(), ['005000000000001AAA', cara.Id]);
  assert.deepStrictEqual([...b.keys()], [cara.Id]);
  assert.match(b.get(cara.Id), /has the Salesforce Platform user license; this permission set needs Salesforce/);
  S.writes = [];
  await assert.rejects(applyMod.apply(c, item(), [
    { key: 'assignment:' + cara.Id, ref: cara.Id, label: 'Cara Diaz', before: { assigned: false, expires: null }, after: { assigned: true, expires: null } },
    { key: 'field:Lead.Industry', before: null, after: { read: true, edit: false } }], saveOpts()), /Cara Diaz has the Salesforce Platform user license/);
  assert.strictEqual(S.writes.length, 0, 'nothing written');
  const reader = F.T.PermissionSet.find(x => x.Id === '0PS000000000002AAA');
  Object.assign(reader, { LicenseId: '0PL000000000001AAA', License: { Name: 'Sales Cloud Einstein' } });
  const item2 = Object.assign(item(), { permissionSetId: '0PS000000000002AAA', recordId: '0PS000000000002AAA' });
  assert.match((await loader.assignmentBlockers(c, item2, ['005000000000001AAA'])).get('005000000000001AAA'), /needs the Sales Cloud Einstein permission set license assigned first/);
  F.T.PermissionSetLicenseAssign.push({ Id: '2LA000000000001AAA', AssigneeId: '005000000000001AAA', PermissionSetLicenseId: '0PL000000000001AAA' });
  assert.strictEqual((await loader.assignmentBlockers(c, item2, ['005000000000001AAA'])).size, 0);
  const vscode = require('vscode');
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, panelServices());
  const p = mp.show();
  await mp.load();
  await mp.checkAssignees({ key: 'permissionSet:' + PS1, userIds: [cara.Id] });
  assert.ok(posts(p, 'assigneeChecks').pop().blockers[cara.Id]);
});

test('session-based permission sets are marked; orgs without the field still list everything', async () => {
  resetOrg();
  F.T.PermissionSet.find(x => x.Id === PS1).HasActivationRequired = true;
  const list = await catalog.listPermissionSets(conn());
  assert.deepStrictEqual(list.map(x => [x.apiName, x.sessionBased]), [['acme__Reader', false], ['Sales_Ops', true]]);
  S.noActivationField = true;
  try { assert.strictEqual((await catalog.listPermissionSets(conn())).length, 2); } finally { S.noActivationField = false; }
});

test('changes made in Setup: Setup Audit Trail entries about the item, or a clear note without the permission', async () => {
  resetOrg();
  const c = conn();
  const ps = await loader.setupChanges(c, { label: 'Sales Ops', apiName: 'Sales_Ops' }, 90);
  assert.deepStrictEqual(ps.map(x => [x.by, x.section]), [['Jordan Lee', 'Manage Users']]);
  assert.match(ps[0].display, /Export Reports/);
  const prof = await loader.setupChanges(c, { label: 'Custom: Sales', apiName: 'Custom: Sales' }, 90);
  assert.strictEqual(prof.length, 1);
  assert.strictEqual((await loader.setupChanges(c, { label: 'Reader', apiName: 'acme__Reader' }, 90))[0].delegate, 'Support Agent');
  const vscode = require('vscode');
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, panelServices());
  const p = mp.show();
  await mp.load();
  const key = 'permissionSet:' + PS1;
  await mp.select(key);
  S.noAuditAccess = true;
  try {
    await mp.openAudit(key, { force: true });
    assert.deepStrictEqual(posts(p, 'audit').pop().data, { items: [], denied: true });
  } finally { S.noAuditAccess = false; }
});

test('profile filtering (Winter \u201927): a list cut down to your own profile is recognised', async () => {
  resetOrg();
  const c = conn();
  assert.strictEqual(await loader.profilesFiltered(c, [{ recordId: '00e000000000001AAA' }], 'ben@example.com'), true, 'only Ben\u2019s own profile');
  assert.strictEqual(await loader.profilesFiltered(c, [{ recordId: '00e000000000002AAA' }], 'ben@example.com'), false, 'one profile, but not his own');
  assert.strictEqual(await loader.profilesFiltered(c, [{ recordId: 'a' }, { recordId: 'b' }], 'ben@example.com'), false);
  const vscode = require('vscode');
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, panelServices());
  const p = mp.show();
  await mp.load();
  assert.strictEqual(posts(p, 'lists').pop().profilesFiltered, false, 'normal org: both profiles visible');
});

// ---------- 2.2.0: review, Find access, grant screens, History, kept changes ----------
const mem22 = () => { const m = new Map(); return { get: k => m.get(k), update: async (k, v) => { if (v === undefined) m.delete(k); else m.set(k, v); }, _m: m }; };

test('tickets: kept with the save in the change log and in the copied summary', async () => {
  resetOrg();
  const vscode = require('vscode');
  let clip = '';
  const svc = panelServices({ summary: summaryMod, clipboard: async t => { clip = t; } });
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, svc);
  const p = mp.show();
  await mp.load();
  const key = 'permissionSet:' + PS1;
  await mp.select(key);
  await mp.save({ key, ticket: '  ADO US 11581701 ', changes: [{ key: 'field:Lead.Industry', label: 'Industry', before: null, after: { read: true, edit: false } }] });
  const log = await history.readLog(svc.projectDir, {});
  assert.strictEqual(log[log.length - 1].ticket, 'ADO US 11581701', 'trimmed and stored');
  await mp.copySummary({ snapshotIds: [log[log.length - 1].snapshot], format: 'markdown' });
  assert.match(clip.split('\n')[0], / · ADO US 11581701$/);
  const two = summaryMod.toMarkdown([{ at: '2026-11-01T10:00:00Z', target: 'A', ticket: 'T-1', changes: [{ key: 'user:ApiEnabled', from: { enabled: false }, to: { enabled: true } }] },
    { at: '2026-11-01T11:00:00Z', target: 'B', ticket: 'T-2', changes: [{ key: 'user:ApiEnabled', from: { enabled: false }, to: { enabled: true } }] }], {});
  assert.ok(two.includes('| Ticket |') && two.includes('| T-2 |'), 'several tickets: a Ticket column');
});

test('Find access: inactive users kept apart, licences shown, and which group members give the access', async () => {
  resetOrg();
  const c = conn();
  const ana = F.T.User.find(u => u.Name === 'Ana Lima');
  ana.IsActive = false;
  F.T.PermissionSetGroupComponent.push({ Id: '0PU000000000009AAA', PermissionSetGroupId: '0PG000000000001AAA', PermissionSetId: '0PS00000000000GAAA' });
  const r = await loader.whoHasAccess(c, { object: 'Account', level: 'read' });
  assert.ok(!r.users.some(u => u.name === 'Ana Lima') && (r.inactive || []).some(u => u.name === 'Ana Lima' && u.active === false), 'inactive users listed separately');
  assert.ok(r.users.every(u => typeof u.license === 'string'));
  const grp = r.sources.find(x => x.kind === 'group');
  if (grp) assert.ok(Array.isArray(grp.includes), 'groups say which member permission sets grant it');
  const sp = await loader.whoHasPermission(c, { kind: 'system', name: 'ModifyAllData', label: 'Modify All Data' });
  assert.ok(Array.isArray(sp.inactive));
});

test('grant screens: each item\u2019s current access and users, for fields and for an object', async () => {
  resetOrg();
  const vscode = require('vscode');
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, panelServices());
  const p = mp.show();
  await mp.load();
  await mp.wizardCurrent({ object: 'Lead', fields: ['Lead.Rating', 'Lead.Industry'] });
  const w = posts(p, 'wizardCurrent').pop();
  const ps1 = w.byKey['permissionSet:' + PS1];
  assert.ok(ps1, JSON.stringify(Object.keys(w.byKey)));
  assert.deepStrictEqual(ps1.fields['Lead.Rating'], F.T.FieldPermissions.filter(x => x.ParentId === PS1 && x.Field === 'Lead.Rating').map(x => ({ read: x.PermissionsRead, edit: x.PermissionsEdit }))[0]);
  assert.strictEqual(typeof ps1.users, 'number');
  assert.ok(Object.keys(w.byKey).some(k => k.startsWith('profile:')), 'profiles are mapped through their own permission sets');
  await mp.objWizardCurrent({ object: 'Account' });
  const o = posts(p, 'objWizardCurrent').pop();
  assert.strictEqual(o.byKey['permissionSet:' + PS1].props.read, true);
  assert.ok(o.columns.includes('read'));
});

test('grant object access, one grid: different permissions per item in one plan', async () => {
  resetOrg();
  const vscode = require('vscode');
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, panelServices());
  const p = mp.show();
  await mp.load();
  const lists = posts(p, 'lists').pop().lists;
  const so = lists.permissionSet.find(r => r.apiName === 'Sales_Ops').key;
  const prof = lists.profile.find(r => r.label === 'Custom: Sales').key;
  await mp.objWizardPlan({ object: 'Contact', perTarget: { [so]: ['read', 'edit'], [prof]: ['read'] }, recordTypes: [], defaultRt: null });
  const plan = posts(p, 'objWizardPlan').pop();
  assert.ok(!plan.error, plan.error);
  const a = plan.plan.find(t => t.key === so).changes[0].after;
  const b = plan.plan.find(t => t.key === prof).changes[0].after;
  assert.deepStrictEqual([a.read, a.edit, b.read, b.edit], [true, true, true, false]);
});

test('Find access \u201cRemove from selected\u201d: a plan that takes the access away, saved like the wizards', async () => {
  resetOrg();
  const vscode = require('vscode');
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, panelServices());
  const p = mp.show();
  await mp.load();
  const so = 'permissionSet:' + PS1;
  await mp.revokePlan({ object: 'Lead', field: 'Lead.Rating', level: 'read', sourceKeys: [so, 'permissionSet:0PS000000000002AAA'] });
  const plan = posts(p, 'revokePlan').pop();
  assert.deepStrictEqual(plan.plan.map(t => [t.key, t.changes[0].after]), [[so, { read: false, edit: false }]]);
  assert.deepStrictEqual(plan.skipped.map(x => x.label), ['Reader'], 'managed: skipped with the reason');
  await mp.revokeApply({ plan: plan.plan });
  assert.deepStrictEqual(posts(p, 'wizardResult').pop().results.map(r => r.status), ['saved']);
  assert.ok(!F.T.FieldPermissions.some(x => x.ParentId === PS1 && x.Field === 'Lead.Rating'));
  assert.strictEqual((await history.readLog(mp.ctx.projectDir, {})).pop().path, 'Find access: remove', 'logged as what it was');
  await mp.revokePlan({ object: 'Account', level: 'edit', sourceKeys: [so] });
  const o = posts(p, 'revokePlan').pop().plan[0].changes[0];
  assert.deepStrictEqual([o.before.edit, o.after.edit, o.after.read], [true, false, true], 'removing Edit keeps Read');
});

test('History: Setup changes about any item; screen state kept across sessions; the tab shows \u25cf with unsaved changes', async () => {
  resetOrg();
  const vscode = require('vscode');
  const memento = mem22();
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, panelServices({ memento }));
  const p = mp.show();
  await mp.load();
  await mp.historySetup({ days: 30 });
  const hs = posts(p, 'historySetup').pop();
  assert.ok(hs.entries.length >= 2 && hs.entries.every(e => e.name), JSON.stringify(hs));
  assert.ok(hs.entries.some(e => e.key && e.key.startsWith('profile:')));
  const pend = { key: 'permissionSet:' + PS1, entries: [['field:Lead.Rating', { before: { read: true, edit: false }, after: { read: true, edit: true }, label: 'Rating', cat: 'field', touched: ['edit'] }]] };
  await mp.persist('pending', pend);
  assert.strictEqual(mp.panel.title, '\u25cf Permission Studio');
  await mp.persist('recentLookups', [{ mode: 'access', object: 'Lead', label: 'Lead' }]);
  await mp.persist('nonsense', 1);
  p._send({ type: 'ready' });
  await settle(60);
  const v = posts(p, 'persisted').pop().values;
  assert.deepStrictEqual([v.pending.key, v.recentLookups[0].label, 'nonsense' in v], [pend.key, 'Lead', false]);
  await mp.persist('pending', null);
  assert.strictEqual(mp.panel.title, 'Permission Studio');
});

test('Ctrl/Cmd+S: a key binding only while Permission Studio has focus, hidden from the Command Palette', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const kb = pkg.contributes.keybindings.find(k => k.command === 'permStudio.saveShortcut');
  assert.deepStrictEqual([kb.key, kb.mac, kb.when], ['ctrl+s', 'cmd+s', "activeWebviewPanelId == 'permStudio.main'"]);
  assert.ok(pkg.contributes.menus.commandPalette.some(m => m.command === 'permStudio.saveShortcut' && m.when === 'false'));
});

// ---------- code review fixes ----------
test('Setup Audit Trail names match whole words, the longest first', async () => {
  const rows = [{ CreatedDate: '3', Display: 'Permission set Sales Ops: system permission Export Reports was changed' },
    { CreatedDate: '2', Display: 'Changed Salesforce settings' }, { CreatedDate: '1', Display: 'Permission set Sales: assigned to user Ana Lima' }];
  const r = await loader.setupChangesFor({ query: async () => ({ records: rows }) }, ['Sales', 'Sales Ops', 'Ab'], 30);
  assert.deepStrictEqual(r.map(x => x.name), ['Sales Ops', 'Sales'], '"Salesforce" is not "Sales"; two-letter names are ignored');
});

test('copying a list says how many lines were copied instead of showing them all', async () => {
  resetOrg();
  const vscode = require('vscode');
  let clip = '';
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, panelServices({ clipboard: async t => { clip = t; } }));
  const p = mp.show();
  await mp.load();
  p._send({ type: 'copy', text: 'a\tb\nc\td\ne\tf' });
  await settle(30);
  assert.strictEqual(clip, 'a\tb\nc\td\ne\tf');
  assert.strictEqual(posts(p, 'toast').pop().message, '3 lines copied to the clipboard.');
  p._send({ type: 'copy', text: 'Lead.Rating' });
  await settle(30);
  assert.strictEqual(posts(p, 'toast').pop().message, 'Lead.Rating');
});

test('a save that finds a conflict doesn\u2019t leave background refresh switched off', async () => {
  resetOrg();
  const vscode = require('vscode');
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, panelServices());
  const p = mp.show();
  await mp.load();
  const key = 'permissionSet:' + PS1;
  await mp.select(key);
  await mp.save({ key, changes: [{ key: 'field:Lead.Rating', label: 'Rating', before: { read: false, edit: false }, after: { read: true, edit: true } }] });
  assert.strictEqual(posts(p, 'saveResult').pop().status, 'conflict');
  assert.strictEqual(mp._saving, false);
  assert.strictEqual(await mp.autoRefresh(), true, 'auto-refresh still runs');
});

// ---------- QA: what users can get wrong, and what the org can throw at us ----------
async function qaPanel(over) {
  const vscode = require('vscode');
  const svc = panelServices(over);
  const mp = new MainPanel({ extensionUri: vscode.Uri.file(ROOT) }, svc);
  const p = mp.show();
  await mp.load();
  return { mp, p, svc };
}

test('QA Q1-Q2: saving nothing, or changes the extension doesn\u2019t know, is refused politely', async () => {
  resetOrg();
  const { mp, p } = await qaPanel();
  const key = 'permissionSet:' + PS1;
  await mp.select(key);
  await mp.save({ key, changes: [] });
  let r = posts(p, 'saveResult').pop();
  assert.ok(r && r.status !== 'saved' || (r && r.count === 0), 'no-op save: ' + JSON.stringify(r));
  await mp.save({ key, changes: [{ key: 'bogus:Thing', before: null, after: { x: true } }] });
  r = posts(p, 'saveResult').pop();
  assert.strictEqual(r.status, 'error', JSON.stringify(r));
  assert.ok(r.message && r.message.length < 400, 'a readable reason');
  await mp.save({ key, changes: [{ key: 'field:Lead.Rating', before: null }] });
  r = posts(p, 'saveResult').pop();
  assert.deepStrictEqual([r.status, /field:Lead\.Rating: no new value/.test(r.message)], ['error', true], 'a change without a value: ' + r.message);
  await mp.save({ key, changes: [null, 'x'] });
  assert.strictEqual(posts(p, 'saveResult').pop().status, 'error', 'junk entries');
  assert.strictEqual(mp._saving, false);
});

test('QA Q3: the permission set was deleted in Setup while you edited it', async () => {
  resetOrg();
  const { mp, p } = await qaPanel();
  const key = 'permissionSet:' + PS1;
  await mp.select(key);
  F.T.PermissionSet = F.T.PermissionSet.filter(x => x.Id !== PS1);
  for (const t of ['ObjectPermissions', 'FieldPermissions', 'SetupEntityAccess', 'PermissionSetAssignment', 'PermissionSetTabSetting']) F.T[t] = F.T[t].filter(x => x.ParentId !== PS1 && x.PermissionSetId !== PS1);
  await mp.save({ key, changes: [{ key: 'field:Lead.Industry', label: 'Industry', before: null, after: { read: true, edit: false } }] });
  const r = posts(p, 'saveResult').pop();
  assert.strictEqual(r.status, 'error', JSON.stringify(r));
  assert.match(r.message, /^Sales Ops no longer exists in .*deleted in Setup/, r.message);
  assert.strictEqual(mp._saving, false);
  assert.ok(!F.T.FieldPermissions.some(x => x.ParentId === PS1), 'nothing written for a permission set that no longer exists');
});

test('QA Q4: the network drops in the middle of a save', async () => {
  resetOrg();
  const { mp, p } = await qaPanel();
  const key = 'permissionSet:' + PS1;
  await mp.select(key);
  mp.conn.instanceUrl = 'http://127.0.0.1:9';
  mp.conn.forcedMode = 'rest';
  await mp.save({ key, changes: [{ key: 'field:Lead.Industry', label: 'Industry', before: null, after: { read: true, edit: false } }] });
  const r = posts(p, 'saveResult').pop();
  assert.strictEqual(r.status, 'error', JSON.stringify(r));
  assert.ok(/ECONNREFUSED|reach|network|connect/i.test(r.message), 'says it could not reach Salesforce: ' + r.message);
  assert.strictEqual(mp._saving, false, 'background refresh is not left off');
});

test('QA Q5: double-clicking Save does not write twice', async () => {
  resetOrg();
  const { mp, p } = await qaPanel();
  const key = 'permissionSet:' + PS1;
  await mp.select(key);
  const ch = [{ key: 'field:Lead.Description', label: 'Description', before: null, after: { read: true, edit: true } }];
  await Promise.all([mp.save({ key, changes: ch }), mp.save({ key, changes: ch })]);
  assert.strictEqual(F.T.FieldPermissions.filter(x => x.ParentId === PS1 && x.Field === 'Lead.Description').length, 1, 'one row, not two');
  const replies = posts(p, 'saveResult');
  assert.deepStrictEqual(replies.map(r => r.status).sort(), ['busy', 'saved'], 'one save; the other is told one is running');
  assert.match(replies.find(r => r.status === 'busy').message, /already running/);
  assert.strictEqual(mp._saving, false);
});

test('QA Q6: production confirmation forgives case and spaces, not a wrong name', async () => {
  resetOrg();
  const { mp, p } = await qaPanel({ detectProduction: async () => true });
  const key = 'permissionSet:' + PS1;
  await mp.select(key);
  const ch = [{ key: 'field:Lead.Description', label: 'Description', before: null, after: { read: true, edit: false } }];
  await mp.save({ key, changes: ch, confirm: 'not-the-org' });
  assert.strictEqual(posts(p, 'saveResult').pop().status, 'error');
  await mp.save({ key, changes: ch, confirm: '  ' + mp.ctx.org.alias.toUpperCase() + ' ' });
  assert.strictEqual(posts(p, 'saveResult').pop().status, 'saved', 'case and spaces do not matter');
});

test('QA Q7: user search with apostrophes, quotes, SOQL and wildcards', async () => {
  resetOrg();
  F.T.User.push({ Id: '005000000000099AAA', Name: "Sean O'Brien", Username: 'sean@example.com', IsActive: true, ProfileId: '00e000000000002AAA', Profile: { Name: 'Custom: Sales' } });
  F.T.User.push({ Id: '005000000000098AAA', Name: 'Under_Score', Username: 'us@example.com', IsActive: true, ProfileId: '00e000000000002AAA', Profile: { Name: 'Custom: Sales' } });
  const c = conn();
  assert.deepStrictEqual((await loader.searchUsers(c, "O'Bri")).map(u => u.name), ["Sean O'Brien"], 'apostrophes are searched for, not dropped');
  assert.deepStrictEqual((await loader.searchUsers(c, 'r_S')).map(u => u.name), ['Under_Score'], 'an underscore is a character, not a wildcard');
  for (const t of ["' OR Name LIKE '%", '%%', "\\'", '"; DROP', '😀😀']) await loader.searchUsers(c, t); // must not throw
});

test('QA Q8: a very large save (5,100 field changes) still goes through', async () => {
  resetOrg();
  const c = conn();
  const changes = [];
  for (let i = 0; i < 5100; i++) changes.push({ key: 'field:Lead.Q' + i + '__c', before: null, after: { read: true, edit: false } });
  const r = await applyMod.apply(c, item(), changes, saveOpts());
  assert.strictEqual(r.status, 'saved', JSON.stringify(r).slice(0, 300));
  assert.strictEqual(F.T.FieldPermissions.filter(x => x.ParentId === PS1 && /^Lead\.Q\d+__c$/.test(x.Field)).length, 5100);
});

test('QA Q9-Q10: cloning with a taken or an invalid API name', async () => {
  resetOrg();
  const { mp, p } = await qaPanel();
  const key = 'permissionSet:' + PS1;
  await mp.select(key);
  const before = F.T.PermissionSet.length;
  for (const name of ['Sales_Ops', '9_Starts_With_A_Digit', 'Has Space', 'Double__Underscore', 'Ends_', 'x'.repeat(81), '']) {
    await mp.clonePs({ key, label: 'Copy', name });
    const r = posts(p, 'psSaved').pop();
    assert.ok(r && r.error, name + ': ' + JSON.stringify(r));
  }
  assert.strictEqual(F.T.PermissionSet.length, before, 'nothing half-created');
});

test('QA Q11: odd tickets: table characters, line breaks, far too long', async () => {
  resetOrg();
  const { mp, p, svc } = await qaPanel();
  const key = 'permissionSet:' + PS1;
  await mp.select(key);
  await mp.save({ key, ticket: 'US | 1\nsecond line ' + 'x'.repeat(200), changes: [{ key: 'field:Lead.Industry', label: 'Industry', before: null, after: { read: true, edit: false } }] });
  const e = (await history.readLog(svc.projectDir, {}))[0];
  assert.ok(e.ticket.length <= 80 && !e.ticket.includes('\n'), JSON.stringify(e.ticket));
  const md = summaryMod.toMarkdown([e], {});
  assert.ok(md.split('\n')[0].startsWith('### ') && !md.split('\n')[0].includes('\n'));
});

test('QA Q12-Q14: looking up things that don\u2019t exist; grants and removals with nothing chosen', async () => {
  resetOrg();
  const { mp, p } = await qaPanel();
  await mp.lookup({ object: 'Nope__c', field: null, level: 'read' });
  let r = posts(p, 'lookupResult').pop();
  assert.ok(r.error || (r.result && (r.result.error || r.result.users.length === 0)), JSON.stringify(r).slice(0, 200));
  await mp.lookup({ object: 'Lead', field: 'NotAField__c', level: 'edit' });
  r = posts(p, 'lookupResult').pop();
  assert.ok(r.error || (r.result && (r.result.error || r.result.users.length === 0)));
  await mp.lookupPermission({ kind: 'system', name: 'NoSuchPermission', label: 'X' });
  assert.ok(posts(p, 'lookupResult').pop().result.error, 'unknown system permission: an error, not a crash');
  await mp.revokePlan({ object: 'Lead', field: 'Lead.Rating', level: 'read', sourceKeys: [] });
  assert.deepStrictEqual(posts(p, 'revokePlan').pop().plan, []);
  await mp.wizardPlan({ object: 'Lead', fields: [], targets: [], level: 'read', grantObject: true });
  const w = posts(p, 'wizardPlan').pop();
  assert.ok(w.error || (w.plan && w.plan.length === 0), JSON.stringify(w));
  await mp.objWizardPlan({ object: 'Lead', perTarget: {}, recordTypes: [], defaultRt: null });
  const o = posts(p, 'objWizardPlan').pop();
  assert.ok(o.error || (o.plan && o.plan.length === 0), JSON.stringify(o));
});

test('QA Q15-Q16: a damaged change log or cache file', async () => {
  resetOrg();
  const { mp, p, svc } = await qaPanel();
  const dir = path.join(svc.projectDir, '.permstudio', 'log');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'changes.jsonl'), '{"at":"2026-11-01T00:00:00Z","target":"A","changes":[]}\n{not json\n\n' + Buffer.from([0xff, 0xfe, 0x00]).toString('latin1') + '\n');
  p._send({ type: 'history' });
  await settle(60);
  assert.ok(Array.isArray(posts(p, 'history').pop().entries), 'damaged lines are skipped');
  const cdir = svc.cacheDir || null;
  if (cdir && fs.existsSync(cdir)) for (const f of fs.readdirSync(cdir)) fs.writeFileSync(path.join(cdir, f), '{truncated');
  await mp.load({ force: false });
  assert.ok(posts(p, 'lists').length > 0, 'a damaged cache is ignored');
});

test('QA Q17: assigning a user someone assigned in Setup a moment ago', async () => {
  resetOrg();
  const { mp, p } = await qaPanel();
  const key = 'permissionSet:' + PS1;
  await mp.select(key);
  const cara = F.T.User.find(u => u.Name === 'Cara Diaz');
  F.T.PermissionSetAssignment.push({ Id: '0Pa000000000077AAA', AssigneeId: cara.Id, PermissionSetId: PS1 });
  await mp.save({ key, changes: [{ key: 'assignment:' + cara.Id, ref: cara.Id, label: 'Cara Diaz', before: { assigned: false, expires: null }, after: { assigned: true, expires: null } }] });
  const r = posts(p, 'saveResult').pop();
  assert.ok(['conflict', 'saved'].includes(r.status), JSON.stringify(r));
  assert.strictEqual(F.T.PermissionSetAssignment.filter(a => a.AssigneeId === cara.Id && a.PermissionSetId === PS1).length, 1, 'no duplicate assignment');
});

test('QA Q20: malformed or unexpected messages from the screen are ignored safely', async () => {
  resetOrg();
  const { mp, p } = await qaPanel();
  const before = posts(p, 'toast').length;
  for (const m of [{}, { type: 'nonsense' }, { type: 'select' }, { type: 'select', key: 'permissionSet:000000000000000AAA' }, { type: 'openObject', key: 'nope', object: 'X' },
    { type: 'save' }, { type: 'save', key: 'nope', changes: 'not a list' }, { type: 'lookup' }, { type: 'loadAccess', key: 'nope' }, { type: 'persist', name: 'pending', value: { key: 1 } },
    { type: 'copySummary', snapshotIds: 'x' }, { type: 'wizardPlan' }, { type: 'objWizardPlan' }, { type: 'revokePlan' }, { type: 'checkAssignees' }]) p._send(m);
  await settle(200);
  assert.ok(mp.panel, 'still running');
  await mp.select('permissionSet:' + PS1);
  assert.ok(posts(p, 'detail').length, 'still works afterwards');
  void before;
});

test('QA Q21: impossible or past expiry dates, back-to-front IP ranges, over-long descriptions', async () => {
  resetOrg();
  const c = conn();
  const cara = F.T.User.find(u => u.Name === 'Cara Diaz');
  const assign = expires => ({ key: 'assignment:' + cara.Id, ref: cara.Id, label: 'Cara Diaz', before: { assigned: false, expires: null }, after: { assigned: true, expires } });
  await assert.rejects(applyMod.apply(c, item(), [assign('2027-02-30')], saveOpts()), /Cara Diaz: expiry must be a date/);
  await assert.rejects(applyMod.apply(c, item(), [assign('2020-01-01')], saveOpts()), /2020-01-01 is in the past/);
  const prof = { kind: 'profile', recordId: '00e000000000002AAA', permissionSetId: '0PS0000000000PRAAA', apiName: 'Custom: Sales', label: 'Custom: Sales' };
  await assert.rejects(applyMod.apply(c, prof, [{ key: 'loginIpRanges:all', before: { ranges: [] }, after: { ranges: [{ startAddress: '10.0.0.9', endAddress: '10.0.0.1' }] } }], saveOpts({ metadata })),
    /start address is after the end address/);
  const { mp, p } = await qaPanel();
  await mp.select('permissionSet:' + PS1);
  await mp.clonePs({ key: 'permissionSet:' + PS1, label: 'Copy', name: 'Copy_Ok', description: 'd'.repeat(256) });
  assert.match(posts(p, 'psSaved').pop().error, /at most 255 characters \(it has 256\)/);
});

test('the stylesheet matches the screen: every class the screen uses has a style (catches a stale media/app.css)', () => {
  const js = fs.readFileSync(path.join(ROOT, 'media', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'media', 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const styled = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]));
  const used = new Set();
  for (const m of js.matchAll(/class: '([^']*)'/g)) for (const c of m[1].split(/\s+/)) if (c) used.add(c);
  for (const m of js.matchAll(/setAttribute\('class', '([^']*)'\)/g)) for (const c of m[1].split(/\s+/)) if (c) used.add(c);
  for (const m of js.matchAll(/classList\.(?:add|toggle|remove)\('([\w-]+)'/g)) used.add(m[1]);
  // Markers that deliberately have no style of their own; nav-g- is the start of names built in code.
  const plain = new Set(['neutral', 'icon-btn', 'org-text', 'si-note', 'nav-g-']);
  const missing = [...used].filter(c => !styled.has(c) && !plain.has(c)).sort();
  assert.deepStrictEqual(missing, [], 'media/app.css is missing styles for: ' + missing.join(', ') + '. Is media/app.css from an older version than media/app.js?');
});

test('README images show in VS Code: the packaged README points them at GitHub over https', () => {
  const pk = require('../tools/package.js');
  for (const u of ['https://github.com/o/Permission-Studio', 'https://github.com/o/Permission-Studio.git', 'git+https://github.com/o/Permission-Studio.git', 'git@github.com:o/Permission-Studio.git', 'github:o/Permission-Studio', 'o/Permission-Studio'])
    assert.strictEqual(pk.githubRepo({ repository: { url: u } }), 'o/Permission-Studio', u);
  assert.strictEqual(pk.githubRepo({ repository: 'https://github.com/o/r' }), 'o/r', 'a plain string works too');
  assert.strictEqual(pk.githubRepo({ repository: { url: 'https://gitlab.com/o/r' } }), null);
  assert.strictEqual(pk.githubRepo({}), null);
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const out = pk.readmeForPackage(readme, 'o/Permission-Studio');
  const imgs = [...out.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map(m => m[1]);
  assert.ok(imgs.length >= 8 && imgs.every(u => u.startsWith('https://raw.githubusercontent.com/o/Permission-Studio/HEAD/media/readme/')), imgs.join('\n'));
  assert.ok(/\]\(https:\/\/github\.com\/o\/Permission-Studio\/blob\/HEAD\/RELEASING\.md\)/.test(out), 'links to other files go to GitHub');
  assert.strictEqual(pk.readmeForPackage(readme, null), readme, 'without a GitHub repository nothing is rewritten');
  assert.strictEqual(pk.readmeForPackage('[a](https://x.dev) [b](#why) ![c](https://x.dev/c.png) <img src="data:image/png;base64,AA">', 'o/r'),
    '[a](https://x.dev) [b](#why) ![c](https://x.dev/c.png) <img src="data:image/png;base64,AA">', 'web links, anchors and remote images are left alone');
  const files = ['README.md', 'media/readme/a.png', 'media/icon.png'];
  assert.deepStrictEqual(pk.packagedFiles(files, 'o/r'), ['README.md', 'media/icon.png'], 'screenshots served from GitHub stay out of the package');
  assert.deepStrictEqual(pk.packagedFiles(files, null), files);
});

// ---------- extension wiring ----------
test('activation: commands and settings match package.json; status bar; version and author', async () => {
  const vscode = require('vscode');
  require('../extension').activate({ subscriptions: { push() {} }, extensionUri: vscode.Uri.file(ROOT), globalStorageUri: vscode.Uri.file(path.join(tmp, 'gs')), extension: { packageJSON: { version: '2.0.0' } } });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepStrictEqual([...vscode.__registered.keys()].sort(), pkg.contributes.commands.map(c => c.command).sort());
  const code = fs.readFileSync(path.join(ROOT, 'extension.js'), 'utf8');
  assert.deepStrictEqual([...code.matchAll(/c\.get\('([\w.]+)'/g)].map(m => 'permStudio.' + m[1]).sort(), Object.keys(pkg.contributes.configuration.properties).sort());
  assert.ok(vscode.__statusItems[0].shown && vscode.__statusItems[0].command === 'permStudio.open');
  for (const f of ['media/app.js', 'media/app.css', 'media/tab-light.svg', 'media/tab-dark.svg', 'src/model/dependencies.js', pkg.icon]) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  assert.deepStrictEqual([pkg.version, pkg.publisher, pkg.author.name], ['2.2.6', 'nikeshvarma', 'Nikesh Varma']);
  const png = fs.readFileSync(path.join(ROOT, pkg.icon));
  assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [256, 256], 'Marketplace icon is 256 px');
  for (const t of ['light', 'dark']) assert.match(fs.readFileSync(path.join(ROOT, 'media', 'tab-' + t + '.svg'), 'utf8'), /fill="#[0-9A-F]{6}"/i, 'tab icon has an explicit colour');
  await settle(30);
});

test('webview and panel agree on every message type', () => {
  const js = fs.readFileSync(path.join(ROOT, 'media', 'app.js'), 'utf8');
  const panel = fs.readFileSync(path.join(ROOT, 'src/views/mainPanel.js'), 'utf8');
  const sent = [...new Set([...js.matchAll(/send\(\{ type: '(\w+)'/g)].map(m => m[1]))].sort();
  const handled = [...new Set([...panel.matchAll(/case '(\w+)':/g)].map(m => m[1]))].sort();
  assert.deepStrictEqual(sent.filter(t => !handled.includes(t)), [], 'webview sends something the panel ignores');
  const posted = new Set([...panel.matchAll(/(?<!attributes: \{ )type: '(\w+)'/g)].map(m => m[1]));
  for (const t of ['loading', 'error']) posted.delete(t);
  for (const t of ['detailLoading', 'objectLoading', 'accessLoading', 'rtLoading', 'tabsLoading', 'assignLoading', 'layoutsLoading', 'loginLoading', 'componentsLoading']) posted.add(t);
  assert.ok(!sent.includes('export') && !sent.includes('createPs') && !sent.includes('licenses'), 'removed features stay removed');
  const webHandles = new Set([...js.matchAll(/case '(\w+)':/g)].map(m => m[1]));
  assert.deepStrictEqual([...posted].filter(t => !webHandles.has(t)).sort(), [], 'panel posts something the webview ignores');
});

test('no dead functions in shipped code', () => {
  const files = ['extension.js'];
  const walk = d => fs.readdirSync(path.join(ROOT, d)).forEach(f => { const rel = d + '/' + f; if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel); else if (f.endsWith('.js')) files.push(rel); });
  walk('src'); walk('media');
  const src = Object.fromEntries(files.map(f => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));
  const all = Object.values(src).join('\n') + fs.readFileSync(__filename, 'utf8');
  const dead = [];
  for (const f of files) for (const m of src[f].matchAll(/^\s*(?:async\s+)?function\s+(\w+)/gm)) {
    if ((all.match(new RegExp('\\b' + m[1] + '\\b', 'g')) || []).length <= 1) dead.push(f + ': ' + m[1]);
  }
  assert.deepStrictEqual(dead, []);
});

test('open source: MIT licence in the repository, the package and the README', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lic = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  assert.strictEqual(pkg.license, 'MIT');
  assert.ok(lic.startsWith('MIT License') && /Copyright \(c\) \d{4} Nikesh Varma/.test(lic) && lic.includes('WITHOUT WARRANTY OF ANY KIND'));
  assert.ok(/## License\n\n\[MIT\]\(LICENSE\)/.test(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')));
  assert.ok(fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8').includes('licensed under the same terms'));
  for (const f of ['.github/ISSUE_TEMPLATE/bug_report.md', '.github/ISSUE_TEMPLATE/feature_request.md', '.github/pull_request_template.md']) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

test('every image the README shows exists and ships in the extension', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const imgs = [...readme.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)];
  assert.ok(imgs.length >= 8, imgs.length + ' images');
  for (const [, alt, src] of imgs) {
    assert.ok(alt.length > 20, 'descriptive alt text for ' + src);
    assert.ok(fs.existsSync(path.join(ROOT, src)), src + ' exists');
    assert.ok(src.startsWith('media/'), src + ' is under media/, which the .vsix includes');
  }
  const links = [...readme.matchAll(/\]\(([A-Z][\w/.-]+\.md)\)/g)].map(m => m[1]);
  for (const l of links) assert.ok(fs.existsSync(path.join(ROOT, l)), l + ' exists');
});

test('no client or org-specific names anywhere in the repository', () => {
  const files = [];
  const walk = d => fs.readdirSync(path.join(ROOT, d)).forEach(f => {
    const rel = d ? d + '/' + f : f;
    if (['node_modules', 'dist', '.git'].includes(f) && !rel.startsWith('test/')) return;
    if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel); else if (!/\.(png|vsix|zip)$/.test(f)) files.push(rel);
  });
  walk('');
  const banned = new RegExp(['narwhal', 'spdji', 'spglobal', 's&p global', 'sp dji', 'pwc'].join('|'), 'i');
  const hits = files.filter(f => banned.test(fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').filter(l => !l.includes("const banned = new RegExp")).join('\n')));
  assert.deepStrictEqual(hits, []);
  assert.ok(files.length > 30, files.length + ' files scanned');
});

// ---------- run ----------
(async () => {
  await new Promise(r => F.server.listen(0, '127.0.0.1', r));
  INSTANCE = 'http://127.0.0.1:' + F.server.address().port;
  let pass = 0; let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).split('\n').slice(0, 6).join('\n       ')); }
  }
  F.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + pass + ' passed' + (fail ? ', ' + fail + ' failed' : ''));
  process.exit(fail ? 1 : 0);
})();
