#!/usr/bin/env node
'use strict';
// Mimics the `sf` JSON envelopes this extension relies on.
//   FAKE_SF_INSTANCE       instance URL of the fake REST server
//   FAKE_SF_TOKEN          file holding the token the CLI has stored
//   FAKE_SF_TARGET         target-org value returned by `config get` ('' = not set)
//   FAKE_SF_TARGET_WHERE   location of that value (Local, Global)
//   FAKE_SF_LOGIN_EXPIRED  when set, the stored refresh token is dead
//   FAKE_SF_CALLS          file that each invocation appends its arguments to
// Like the real CLI, `org display` returns the stored token as-is, while
// `data query` and `sobject *` renew it first and save the new one.
const fs = require('fs');
const http = require('http');
const args = process.argv.slice(2);
const val = flag => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1]; };
const env = process.env;
if (env.FAKE_SF_CALLS) fs.appendFileSync(env.FAKE_SF_CALLS, JSON.stringify(args) + '\n');

function reply(status, body) {
  process.stdout.write((env.FAKE_SF_WARN ? 'Warning: update available\n' : '') + JSON.stringify(Object.assign({ status }, body), null, 2));
  process.exit(status);
}

const ORGS = { 'dev@example.com': 'dev', 'uat@example.com': 'uat', 'prod@example.com': 'prod' };
const userFor = t => Object.keys(ORGS).find(u => u === t || ORGS[u] === t);
const stored = () => (env.FAKE_SF_TOKEN && fs.existsSync(env.FAKE_SF_TOKEN) ? fs.readFileSync(env.FAKE_SF_TOKEN, 'utf8').trim() : 'tok');

function get(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, env.FAKE_SF_INSTANCE);
    http.get(u, { headers: { Authorization: 'Bearer ' + token, 'x-fake-cli': '1' } }, res => {
      let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }));
    }).on('error', reject);
  });
}

async function renewed() {
  if (env.FAKE_SF_LOGIN_EXPIRED) reply(1, { name: 'RefreshTokenAuthError', message: 'Error authenticating with the refresh token due to: expired access/refresh token' });
  const r = await get('/__token', '');
  if (env.FAKE_SF_TOKEN) fs.writeFileSync(env.FAKE_SF_TOKEN, r.json.token);
  return r.json.token;
}

async function apiOrFail(path, token) {
  const r = await get(path, token);
  if (r.status >= 400) {
    const e = Array.isArray(r.json) ? r.json[0] : {};
    reply(1, { name: e.errorCode || 'Error', message: e.message || 'HTTP ' + r.status });
  }
  return r.json;
}

(async () => {
  const [a0, a1] = args;
  // Plain oclif commands: --json prints the bare object, with no { status, result } wrapper.
  const bare = o => { process.stdout.write(JSON.stringify(o, null, 2)); process.exit(0); };
  if (a0 === 'version') {
    bare(Object.assign({ cliVersion: '@salesforce/cli/2.99.0', nodeVersion: process.version }, env.FAKE_SF_NO_ROOTPATH ? {} : { rootPath: env.FAKE_SF_ROOT || '' }));
  }
  if (a0 === 'plugins' && args.includes('--core')) {
    bare([{ name: '@salesforce/plugin-auth', type: 'core', root: require('path').join(env.FAKE_SF_ROOT || '', 'node_modules', '@salesforce', 'plugin-auth') }]);
  }
  if (a0 === 'config' && a1 === 'get') {
    const v = env.FAKE_SF_TARGET || '';
    reply(0, { result: [v ? { name: 'target-org', key: 'target-org', value: v, location: env.FAKE_SF_TARGET_WHERE || 'Local', success: true } : { name: 'target-org', key: 'target-org', success: true }] });
  }
  const target = val('--target-org');
  const user = target ? userFor(target) : null;
  if (target && !user) reply(1, { name: 'NoAuthInfoFoundError', message: 'No authorization information found for ' + target + '.' });

  if (a0 === 'org' && a1 === 'display') {
    reply(0, { result: { username: user, alias: ORGS[user], accessToken: stored(), instanceUrl: env.FAKE_SF_INSTANCE || 'http://127.0.0.1:1', apiVersion: '62.0', id: '00D000000000001AAA' } });
  }
  if (a0 === 'data' && a1 === 'query') {
    const token = await renewed();
    const base = '/services/data/v62.0' + (args.includes('--use-tooling-api') ? '/tooling' : '');
    let page = await apiOrFail(base + '/query?q=' + encodeURIComponent(val('--query')), token);
    const records = page.records.slice();
    while (!page.done && page.nextRecordsUrl) { page = await apiOrFail(page.nextRecordsUrl, token); records.push(...page.records); }
    reply(0, { result: { records, totalSize: page.totalSize, done: true } });
  }
  if (a0 === 'sobject' && a1 === 'describe') {
    const token = await renewed();
    reply(0, { result: await apiOrFail('/services/data/v62.0/sobjects/' + val('--sobject') + '/describe', token) });
  }
  if (a0 === 'sobject' && a1 === 'list') {
    const token = await renewed();
    const g = await apiOrFail('/services/data/v62.0/sobjects', token);
    reply(0, { result: g.sobjects.map(s => s.name) });
  }
  if (a0 === 'data' && ['create', 'update', 'delete'].includes(a1) && args[2] === 'record') {
    const token = await renewed();
    const sobject = val('--sobject');
    const fields = {};
    for (const m of String(val('--values') || '').matchAll(/(\w+)=('(?:[^'\\]|\\.)*'|\S+)/g)) {
      const raw = m[2].startsWith("'") ? m[2].slice(1, -1).replace(/\\'/g, "'") : m[2];
      fields[m[1]] = raw === 'true' ? true : raw === 'false' ? false : raw;
    }
    const method = a1 === 'create' ? 'POST' : a1 === 'update' ? 'PATCH' : 'DELETE';
    const rec = Object.assign({ attributes: { type: sobject } }, fields, a1 === 'create' ? {} : { Id: val('--record-id') });
    const r = await send(method, method === 'DELETE' ? '/services/data/v62.0/composite/sobjects?allOrNone=true&ids=' + val('--record-id') : '/services/data/v62.0/composite/sobjects',
      method === 'DELETE' ? undefined : { allOrNone: true, records: [rec] }, token);
    const res = r.json[0];
    if (!res.success) reply(1, { name: res.errors[0].statusCode, message: res.errors[0].message });
    reply(0, { result: { id: res.id, success: true, errors: [] } });
  }
  const FOLDERS = { PermissionSet: ['permissionsets', 'permissionset'], Profile: ['profiles', 'profile'], MutingPermissionSet: ['mutingpermissionsets', 'mutingpermissionset'],
    ProfilePasswordPolicy: ['profilePasswordPolicies', 'profilePasswordPolicy'], ProfileSessionSetting: ['profileSessionSettings', 'profileSessionSetting'],
    UserAccessPolicy: ['userAccessPolicies', 'userAccessPolicy'], DataCategoryGroup: ['datacategorygroups', 'datacategorygroup'] };
  if (a0 === 'org' && a1 === 'list' && args[2] === 'metadata') {
    await renewed();
    const r = await get('/__meta/list?type=' + encodeURIComponent(val('--metadata-type')), '');
    reply(0, { result: r.json.names.map(n => ({ fullName: n, type: val('--metadata-type') })) });
  }
  if (a0 === 'project' && a1 === 'retrieve') {
    await renewed();
    const xml = fs.readFileSync(val('--manifest'), 'utf8');
    const types = {};
    for (const m of xml.matchAll(/<types>([\s\S]*?)<\/types>/g)) types[(/<name>(.*?)<\/name>/.exec(m[1]) || [])[1]] = [...m[1].matchAll(/<members>(.*?)<\/members>/g)].map(x => x[1]);
    const main = types.Profile ? 'Profile' : types.PermissionSet ? 'PermissionSet' : null;
    const write = (type, name, text) => {
      const [folder, ext] = FOLDERS[type];
      const dir = require('path').join(val('--target-metadata-dir'), 'unpackaged', folder);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(require('path').join(dir, name + '.' + ext), text);
    };
    if (main) {
      const name = types[main][0];
      const r = await get('/__meta/retrieve?type=' + main + '&name=' + encodeURIComponent(name) + '&rts=' + encodeURIComponent((types.RecordType || []).join(',')) + '&layouts=' + encodeURIComponent(JSON.stringify(types.Layout || [])), '');
      if (r.json.error) reply(1, { name: 'RetrieveFailed', message: r.json.error });
      write(main, name, r.json.xml);
    }
    for (const type of Object.keys(types).filter(t => FOLDERS[t] && t !== 'Profile' && t !== 'PermissionSet' && !(main && t === 'DataCategoryGroup'))) {
      let names = types[type];
      if (names.includes('*')) names = (await get('/__meta/list?type=' + type, '')).json.names;
      for (const name of names) {
        const r = await get('/__meta/retrieve?type=' + type + '&name=' + encodeURIComponent(name), '');
        if (r.json.error) reply(1, { name: 'RetrieveFailed', message: r.json.error });
        write(type, name, r.json.xml);
      }
    }
    reply(0, { result: { status: 'Succeeded', success: true, fileProperties: [] } });
  }
  if (a0 === 'project' && a1 === 'deploy') {
    await renewed();
    const root = val('--metadata-dir');
    let id = null;
    for (const [type, [folder, ext]] of Object.entries(FOLDERS)) {
      const dir = require('path').join(root, folder);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.' + ext))) {
        const name = file.slice(0, -ext.length - 1);
        const r = await send('POST', '/__meta/deploy?type=' + type + '&name=' + encodeURIComponent(name), fs.readFileSync(require('path').join(dir, file), 'utf8'), '');
        if (r.json.error) reply(1, { name: 'FailedDeploy', message: 'Deploy failed.', result: { status: 'Failed', success: false, details: { componentFailures: [{ fullName: name, problem: r.json.error }] } } });
        id = r.json.id;
      }
    }
    reply(0, { result: { id, status: 'Succeeded', success: true } });
  }
  reply(1, { name: 'UnknownCommand', message: 'Unknown command: ' + args.join(' ') });
})();

function send(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, env.FAKE_SF_INSTANCE);
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(u, { method, headers: Object.assign({ Authorization: 'Bearer ' + token, 'x-fake-cli': '1' }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }, res => {
      let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
