'use strict';
// Every export as an Excel workbook: a title block on each sheet (what it is, the
// org, when, the filters), the data as a real Excel table, cells coloured like the
// screen, and permission sets, profiles, groups and users linked to Setup.
const summary = require('../changes/summary');

const KIND = { permissionSet: 'Permission set', group: 'Permission set group', profile: 'Profile' };
const when = () => { const d = new Date(); return d.toISOString().slice(0, 10) + ' ' + d.toTimeString().slice(0, 5); };
const infoLines = meta => ['Org: ' + (meta.org || '') + '   ·   Exported: ' + when() + '   ·   Permission Studio'].concat(meta.filters || []);

/** A link to the item's page in Setup (from the org's instance URL). */
function setupLink(base, kind, id) {
  if (!base || !id) return null;
  const page = { permissionSet: 'PermSets', profile: 'EnhancedProfiles', group: 'PermSetGroups', user: 'ManageUsers' }[kind];
  return page ? base.replace(/\/$/, '') + '/lightning/setup/' + page + '/page?address=%2F' + id + (kind === 'user' ? '%3Fnoredirect%3D1%26isUserEntityOverride%3D1' : '') : null;
}
const itemCell = (meta, kind, label, id) => ({ v: label, link: setupLink(meta.instanceUrl, kind, id) || undefined });
const userCell = (meta, name, id) => ({ v: name, link: setupLink(meta.instanceUrl, 'user', id) || undefined });

// ---------- health check ----------
function healthWorkbook(h, meta) {
  const info = infoLines(Object.assign({}, meta, { filters: ['Expiring within ' + h.expiringDays + ' days'].concat(meta.filters || []) }));
  const yes = b => b ? 'Yes' : '';
  const s = h.summary;
  return [
    { name: 'Summary', title: 'Access health check', info, header: ['Finding', 'Count', 'Severity'], rows: [
      ['Integration users with admin access', s.integrationAdmins, s.integrationAdmins ? { v: 'Review now', style: 'risk' } : 'None'],
      ['Users with high-impact permissions', s.highImpactUsers, s.highImpactUsers ? { v: 'Review', style: 'risk' } : 'None'],
      ['Assignments to inactive users', s.inactiveAssignments, s.inactiveAssignments ? { v: 'Clean up', style: 'edit' } : 'None'],
      ['Assignments expiring within ' + h.expiringDays + ' days', s.expiring, s.expiring ? { v: 'Check', style: 'edit' } : 'None'],
      ['Unused permission sets', s.unusedPermissionSets, s.unusedPermissionSets ? { v: 'Tidy', style: 'read' } : 'None'],
      ['Unused permission set groups', s.unusedGroups, s.unusedGroups ? { v: 'Tidy', style: 'read' } : 'None'],
      ['Unused custom profiles', s.unusedProfiles, s.unusedProfiles ? { v: 'Tidy', style: 'read' } : 'None'],
      ['Permission sets that grant nothing', s.emptyPermissionSets, s.emptyPermissionSets ? { v: 'Tidy', style: 'read' } : 'None']].concat(h.notes.map(n => ['Note: ' + n, '', ''])) },
    { name: 'Integration admins', title: 'Integration users with admin access', info, header: ['User', 'Username', 'Profile', 'Integration because', 'Admin permissions', 'Granted by'],
      rows: h.integrationAdmins.map(x => [userCell(meta, x.name, x.userId), x.username, x.profile, x.why, { v: x.permissions.join(', '), style: 'risk' }, x.sources.join(', ')]) },
    { name: 'High-impact permissions', title: 'Who holds high-impact permissions', info, header: ['Permission', 'User', 'Username', 'Profile', 'Granted by'],
      rows: h.highImpact.flatMap(p => p.users.map(u => [{ v: p.label, style: 'risk' }, userCell(meta, u.name, u.userId), u.username, u.profile, u.sources.join(', ')])) },
    { name: 'Inactive users', title: 'Assignments to inactive users', info, header: ['User', 'Username', 'Last login', 'Assigned', 'Kind', 'Expires'],
      rows: h.inactiveAssignments.map(x => [userCell(meta, x.name, x.userId), x.username, x.lastLogin || 'Never', x.itemLabel, KIND[x.kind] || x.kind, x.expires]) },
    { name: 'Expiring soon', title: 'Assignments expiring within ' + h.expiringDays + ' days', info, header: ['User', 'Username', 'Assigned', 'Kind', 'Expires', 'Days left'],
      rows: h.expiring.map(x => [userCell(meta, x.name, x.userId), x.username, x.itemLabel, KIND[x.kind] || x.kind, { v: x.expires, style: x.daysLeft <= 7 ? 'delete' : 'edit' }, x.daysLeft]) },
    { name: 'Unused permission sets', title: 'Unused permission sets (no active users, in no group)', info, header: ['Permission set', 'API name', 'Managed', 'Inactive users assigned'],
      rows: h.unusedPermissionSets.map(x => [itemCell(meta, 'permissionSet', x.label, x.recordId || x.id), x.apiName, yes(x.managed), x.inactiveUsers]) },
    { name: 'Unused groups', title: 'Unused permission set groups', info, header: ['Permission set group', 'API name', 'Managed', 'Member permission sets', 'Inactive users assigned'],
      rows: h.unusedGroups.map(x => [itemCell(meta, 'group', x.label, x.recordId), x.apiName, yes(x.managed), x.members, x.inactiveUsers]) },
    { name: 'Unused profiles', title: 'Unused profiles (no active users)', info, header: ['Profile', 'Standard', 'Inactive users'],
      rows: h.unusedProfiles.map(x => [itemCell(meta, 'profile', x.label, x.recordId), yes(x.standard), x.inactiveUsers]) },
    { name: 'Grant nothing', title: 'Permission sets that grant nothing (records-based access)', info, header: ['Permission set', 'API name', 'Active users'],
      rows: h.emptyPermissionSets.map(x => [itemCell(meta, 'permissionSet', x.label, x.recordId), x.apiName, x.activeUsers]) }
  ];
}

// ---------- user access ----------
function userAccessWorkbook(d, fields, meta) {
  const u = d.user;
  const info = infoLines(Object.assign({}, meta, { filters: ['User: ' + u.name + ' (' + u.username + ')'] }));
  const src = i => (d.sources[i] || {}).label || '';
  const srcs = ids => (ids || []).map(src).join(', ');
  const FL = [['read', 'Read'], ['create', 'Create'], ['edit', 'Edit'], ['delete', 'Delete'], ['viewAll', 'View All'], ['modifyAll', 'Modify All']];
  const flagStyle = { read: 'read', create: 'edit', edit: 'edit', delete: 'delete', viewAll: 'all', modifyAll: 'all' };
  return [
    { name: 'Summary', title: 'User access: ' + u.name, info, header: ['Detail', 'Value'], rows: [['Name', userCell(meta, u.name, u.id)], ['Username', u.username], ['Active', u.active ? 'Yes' : 'No'],
      ['Profile', u.profile], ['Role', u.role || ''], ['User licence', u.license || ''], ['Permission set licences', d.licenses.join(', ') || 'None'],
      ['Sources of access', d.sources.length], ['Objects with access', d.objects.length], ['System permissions', d.system.length], ['Custom permissions', d.custom.length]] },
    { name: 'Sources', title: 'Where the access comes from', info, header: ['Source', 'Kind', 'Expires'],
      rows: d.sources.map(x => [itemCell(meta, x.kind, x.label, (x.key || '').split(':')[1]), KIND[x.kind] || x.kind, x.expires || '']) },
    { name: 'Object permissions', title: 'Object permissions, with the sources that grant each', info, header: ['Object'].concat(FL.map(f => f[1])), freezeCols: 1,
      rows: d.objects.map(o => [o.name].concat(FL.map(([f]) => o.flags[f] && o.flags[f].length ? { v: srcs(o.flags[f]), style: flagStyle[f] } : ''))) },
    { name: 'Field permissions', title: 'Field permissions, with the sources that grant each', info, header: ['Field', 'Read', 'Edit'], freezeCols: 1,
      rows: fields.map(f => [f.field, f.read.length ? { v: srcs(f.read), style: 'read' } : '', f.edit.length ? { v: srcs(f.edit), style: 'edit' } : '']) },
    { name: 'System permissions', title: 'System permissions, with the sources that grant each', info, header: ['Permission', 'API name', 'Granted by'],
      rows: d.system.map(x => [x.label, x.name, srcs(x.sources)]) },
    { name: 'Custom permissions', title: 'Custom permissions, with the sources that grant each', info, header: ['Custom permission', 'API name', 'Granted by'],
      rows: d.custom.map(x => [x.label, x.name, srcs(x.sources)]) }
  ];
}

// ---------- compare ----------
function compareWorkbook(c, meta) {
  const info = infoLines(Object.assign({}, meta, { filters: [c.labelA + ' compared with ' + c.labelB] }));
  const side = (label, entries) => ({ name: label, title: 'Everything ' + label + ' grants', info, header: ['Area', 'Entry', 'Access'], rows: entries.map(e => [e.area, e.entry, e.value]) });
  return [
    { name: 'Differences', title: c.labelA + ' compared with ' + c.labelB, info, header: ['Area', 'Entry', c.labelA, c.labelB], freezeCols: 2,
      rows: c.rows.map(r => [r.area, r.entry, { v: r.a, style: /^(No access|Off|Hidden)$/.test(r.a) ? 'muted' : 'ok' }, { v: r.b, style: /^(No access|Off|Hidden)$/.test(r.b) ? 'muted' : 'ok' }]) },
    side(c.labelA, c.allA || []), side(c.labelB, c.allB || [])];
}

// ---------- find access ----------
function findAccessWorkbook(r, meta) {
  const what = r.permission ? r.permission.label : r.object + (r.field ? '.' + String(r.field).split('.').pop() : '') + ' (' + r.level + ')';
  const info = infoLines(Object.assign({}, meta, { filters: ['Who has ' + what] }));
  const byId = new Map(r.sources.map(s => [s.permissionSetId, s]));
  const labels = ids => (ids || []).map(id => (byId.get(id) || {}).label || id).join(', ');
  const userRows = list => (list || []).map(u => [userCell(meta, u.name, u.userId), u.username || '', u.profile || '', u.license || '', u.active === false ? 'No' : 'Yes', labels(u.objectFrom), labels(u.fieldFrom)]);
  const userHeader = ['User', 'Username', 'Profile', 'Licence', 'Active', r.permission ? 'Granted by' : 'Object access from', r.permission ? '' : 'Field access from'].filter(Boolean);
  const trim = rows => r.permission ? rows.map(x => x.slice(0, 6)) : rows;
  return [
    { name: 'Users', title: 'Who has ' + what, info, header: userHeader, rows: trim(userRows(r.users)) },
    { name: 'Sources', title: 'What grants ' + what, info, header: ['Source', 'Kind', 'Active users', 'Through'],
      rows: r.sources.map(s => [itemCell(meta, s.kind, s.label, s.recordId || (s.key || '').split(':')[1]), KIND[s.kind] || s.kind, s.users,
        [].concat(s.objectVia || [], s.fieldVia || []).map(v => ({ object: 'object permission', field: 'field permission', ModifyAllData: 'Modify All Data', ViewAllData: 'View All Data', ViewAllFields: 'View All Fields' }[v] || v)).join(', ')
        + (s.includes && s.includes.length ? ' (via ' + s.includes.join(', ') + ')' : '')]) },
    { name: 'Half access', title: 'Users with only half of it (object or field access, not both)', info, header: userHeader, rows: trim(userRows(r.partial)) },
    { name: 'Inactive users', title: 'Inactive users who have it', info, header: userHeader, rows: trim(userRows(r.inactive)) }];
}

// ---------- history ----------
function historyWorkbook(entries, meta) {
  const info = infoLines(meta);
  return [
    { name: 'Saves', title: 'Saves', info, header: ['Saved', 'Item', 'How', 'Result', 'Ticket', 'Changes', 'Error'],
      rows: entries.map(e => [String(e.at || '').replace('T', ' ').slice(0, 16), e.target || '', e.path || '', { v: e.result || '', style: e.result === 'failed' ? 'delete' : 'ok' }, e.ticket || '', (e.changes || []).length, e.error || '']) },
    { name: 'Changes', title: 'Every change', info, header: ['Saved', 'Item', 'Area', 'Entry', 'Before', 'After', 'Ticket'],
      rows: summary.rows(entries).map(x => [x.saved, x.item, x.area, x.entry, { v: x.before, style: 'muted' }, x.after, x.ticket]) }];
}

module.exports = { healthWorkbook, userAccessWorkbook, compareWorkbook, findAccessWorkbook, historyWorkbook, setupLink };
