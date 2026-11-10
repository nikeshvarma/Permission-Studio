'use strict';
// The access health check: what needs cleaning up or a second look. Every finding
// is worked out from the org's records; nothing is changed here (fixes go through
// the usual review and save).
const insight = require('./insight');
const { chunk, str } = require('./soql');

/** System permissions that reach across the whole org. */
const HIGH_IMPACT = [['ModifyAllData', 'Modify All Data'], ['ViewAllData', 'View All Data'], ['ManageUsers', 'Manage Users'], ['AuthorApex', 'Author Apex'],
  ['CustomizeApplication', 'Customize Application'], ['ModifyMetadata', 'Modify Metadata Through Metadata API Functions'],
  ['ManageProfilesPermissionsets', 'Manage Profiles and Permission Sets'], ['AssignPermissionSets', 'Assign Permission Sets'], ['UseAnyApiClient', 'Use Any API Client']];
/** What makes an integration user an admin. */
const ADMIN = ['ModifyAllData', 'ViewAllData', 'ManageUsers', 'CustomizeApplication', 'AuthorApex', 'ModifyMetadata'];

const day = d => String(d || '').slice(0, 10);
async function all(conn, soql) { return (await conn.query(soql)).records; }
/** Parent Ids that have at least one row in an object (GROUP BY keeps this to one row per parent). */
async function parentsWithRows(conn, object) {
  try { return new Set((await all(conn, 'SELECT ParentId, COUNT(Id) n FROM ' + object + ' GROUP BY ParentId')).map(r => r.ParentId)); }
  catch (e) { return null; }
}

/**
 * items: the org's permission sets, groups and profiles, whatever lists are shown
 * ({ key, kind, label, apiName, recordId, permissionSetId, managed, standard }).
 * options: { expiringDays }.
 *
 * Reads only what the findings need, so it stays quick in orgs with many users:
 * assignments other than profile assignments, user counts per profile (not users),
 * and the details of users who have an assignment or a high-impact profile.
 */
async function healthCheck(conn, items, options) {
  const o = options || {};
  const days = Math.max(1, Math.min(365, o.expiringDays || 30));
  const notes = [];
  const USER = 'Id, Name, Username, IsActive, ProfileId, Profile.Name, LastLoginDate';
  const counts = active => all(conn, 'SELECT ProfileId, COUNT(Id) n FROM User WHERE IsActive = ' + active + ' GROUP BY ProfileId').then(rs => new Map(rs.map(r => [r.ProfileId, r.n])));
  const [assigns, comps, profilePs, profileActive, profileInactive, integrationProfiles, assignees] = await Promise.all([
    all(conn, 'SELECT Id, AssigneeId, PermissionSetId, PermissionSetGroupId, ExpirationDate FROM PermissionSetAssignment WHERE PermissionSet.IsOwnedByProfile = false'),
    all(conn, 'SELECT PermissionSetGroupId, PermissionSetId FROM PermissionSetGroupComponent'),
    all(conn, 'SELECT Id, ProfileId FROM PermissionSet WHERE IsOwnedByProfile = true'),
    counts(true), counts(false),
    all(conn, "SELECT Id FROM Profile WHERE UserLicense.Name LIKE '%Integration%'").then(rs => new Set(rs.map(r => r.Id))).catch(() => new Set()),
    all(conn, 'SELECT ' + USER + ' FROM User WHERE Id IN (SELECT AssigneeId FROM PermissionSetAssignment WHERE PermissionSet.IsOwnedByProfile = false)')]);
  const userById = new Map(assignees.map(u => [u.Id, u]));
  const profileOfPs = new Map(profilePs.map(r => [r.Id, r.ProfileId]));
  const byKind = k => items.filter(i => i.kind === k);
  const psById = new Map(byKind('permissionSet').map(i => [i.permissionSetId, i]));
  const groupById = new Map(byKind('group').map(i => [i.recordId, i]));
  const profileById = new Map(byKind('profile').map(i => [i.recordId, i]));
  const person = u => ({ userId: u.Id, name: u.Name, username: u.Username, profile: (u.Profile && u.Profile.Name) || (profileById.get(u.ProfileId) || {}).label || '',
    lastLogin: day(u.LastLoginDate) });
  const sourceOf = a => a.PermissionSetGroupId ? groupById.get(a.PermissionSetGroupId) : psById.get(a.PermissionSetId);

  // ---- unused permission sets, groups and profiles
  const direct = new Map(), directInactive = new Map(), groupActive = new Map(), groupInactive = new Map();
  for (const a of assigns) {
    const u = userById.get(a.AssigneeId);
    const active = !!(u && u.IsActive);
    if (a.PermissionSetGroupId) { const m = active ? groupActive : groupInactive; m.set(a.PermissionSetGroupId, (m.get(a.PermissionSetGroupId) || 0) + 1); }
    else { const m = active ? direct : directInactive; m.set(a.PermissionSetId, (m.get(a.PermissionSetId) || 0) + 1); }
  }
  const inGroup = new Set(comps.map(c => c.PermissionSetId));
  const unusedPermissionSets = byKind('permissionSet').filter(i => !direct.get(i.permissionSetId) && !inGroup.has(i.permissionSetId))
    .map(i => ({ key: i.key, recordId: i.recordId || i.permissionSetId, label: i.label, apiName: i.apiName, managed: !!i.managed, inactiveUsers: directInactive.get(i.permissionSetId) || 0 }));
  const unusedGroups = byKind('group').filter(i => !groupActive.get(i.recordId))
    .map(i => ({ key: i.key, recordId: i.recordId, label: i.label, apiName: i.apiName, managed: !!i.managed, inactiveUsers: groupInactive.get(i.recordId) || 0,
      members: comps.filter(c => c.PermissionSetGroupId === i.recordId && !/^0QM/.test(c.PermissionSetId)).length }));
  const unusedProfiles = byKind('profile').filter(i => !profileActive.get(i.recordId))
    .map(i => ({ key: i.key, recordId: i.recordId, label: i.label, apiName: i.apiName, standard: !!i.standard, inactiveUsers: profileInactive.get(i.recordId) || 0 }));

  // ---- assignments to inactive users, and assignments that expire soon
  const assignmentRow = a => { const src = sourceOf(a) || {}; return Object.assign(person(userById.get(a.AssigneeId) || { Id: a.AssigneeId, Name: a.AssigneeId }),
    { assignmentId: a.Id, key: src.key || null, itemLabel: src.label || a.PermissionSetGroupId || a.PermissionSetId, kind: src.kind || (a.PermissionSetGroupId ? 'group' : 'permissionSet'), expires: day(a.ExpirationDate) }); };
  const inactiveAssignments = assigns.filter(a => { const u = userById.get(a.AssigneeId); return u && !u.IsActive; })
    .map(assignmentRow).sort((x, y) => x.name.localeCompare(y.name) || x.itemLabel.localeCompare(y.itemLabel));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const limit = new Date(today.getTime() + days * 86400e3);
  const expiring = assigns.filter(a => { if (!a.ExpirationDate) return false; const u = userById.get(a.AssigneeId); const d = new Date(day(a.ExpirationDate) + 'T00:00:00'); return u && u.IsActive && d >= today && d <= limit; })
    .map(a => Object.assign(assignmentRow(a), { daysLeft: Math.round((new Date(day(a.ExpirationDate) + 'T00:00:00') - today) / 86400e3) }))
    .sort((x, y) => x.daysLeft - y.daysLeft || x.name.localeCompare(y.name));

  // ---- who holds high-impact permissions, and through what: assignments, and profiles
  const withPerm = new Map(); // permission → Set of permission set Ids (profile ones included)
  for (const [name] of HIGH_IMPACT.concat([['ApiUserOnly', 'API Only User']])) {
    try { withPerm.set(name, new Set((await all(conn, 'SELECT Id FROM PermissionSet WHERE Permissions' + name + ' = true')).map(r => r.Id))); }
    catch (e) { if (name !== 'ApiUserOnly') notes.push((HIGH_IMPACT.find(h => h[0] === name) || [, name])[1] + ' (' + name + ') couldn’t be checked: this org or its API version doesn’t have it.'); }
  }
  // Active users of the profiles that grant one of them, or that have an integration licence.
  const holderProfiles = new Set(integrationProfiles);
  for (const ids of withPerm.values()) for (const id of ids) if (profileOfPs.has(id)) holderProfiles.add(profileOfPs.get(id));
  const profileUsers = [];
  for (const g of chunk([...holderProfiles], 200)) profileUsers.push(...await all(conn, 'SELECT ' + USER + ' FROM User WHERE IsActive = true AND ProfileId IN (' + g.map(str).join(', ') + ')'));
  for (const u of profileUsers) if (!userById.has(u.Id)) userById.set(u.Id, u);
  const usersOfProfile = new Map();
  for (const u of profileUsers) (usersOfProfile.get(u.ProfileId) || usersOfProfile.set(u.ProfileId, []).get(u.ProfileId)).push(u);
  const holders = new Map(); // permission → Map<userId, Set<source label>>
  for (const [name, ids] of withPerm) {
    const m = new Map();
    const add = (u, label) => (m.get(u.Id) || m.set(u.Id, new Set()).get(u.Id)).add(label);
    for (const a of assigns) {
      if (!ids.has(a.PermissionSetId)) continue;
      const u = userById.get(a.AssigneeId);
      if (!u || !u.IsActive) continue;
      const src = sourceOf(a);
      add(u, src ? src.label : 'Permission set ' + a.PermissionSetId);
    }
    for (const id of ids) {
      const profileId = profileOfPs.get(id);
      if (!profileId) continue;
      const label = (profileById.get(profileId) || {}).label || 'Profile ' + profileId;
      for (const u of usersOfProfile.get(profileId) || []) add(u, label);
    }
    holders.set(name, m);
  }
  const highImpact = HIGH_IMPACT.filter(([n]) => holders.has(n)).map(([name, label]) => ({ name, label,
    users: [...holders.get(name)].map(([id, src]) => Object.assign(person(userById.get(id)), { sources: [...src].sort() })).sort((a, b) => a.name.localeCompare(b.name)) }));

  // ---- integration users with admin access: API Only users, or users on an integration licence
  const apiOnly = holders.get('ApiUserOnly') || new Map();
  const integrationUsers = [...userById.values()].filter(u => u.IsActive && (apiOnly.has(u.Id) || integrationProfiles.has(u.ProfileId)));
  const integrationAdmins = integrationUsers.map(u => ({ u, admin: ADMIN.filter(n => holders.has(n) && holders.get(n).has(u.Id)) })).filter(x => x.admin.length)
    .map(({ u, admin }) => Object.assign(person(u), { why: apiOnly.has(u.Id) ? 'API Only User' : 'Integration licence',
      permissions: admin.map(n => (HIGH_IMPACT.find(h => h[0] === n) || [n, n])[1]),
      sources: [...new Set(admin.flatMap(n => [...holders.get(n).get(u.Id)]))].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // ---- permission sets that grant nothing at all (records-based access)
  let emptyPermissionSets = [];
  const custom = byKind('permissionSet').filter(i => !i.managed && i.permissionSetId);
  const sets = await Promise.all(['ObjectPermissions', 'FieldPermissions', 'SetupEntityAccess', 'PermissionSetTabSetting'].map(t => parentsWithRows(conn, t)));
  if (sets.every(Boolean)) {
    const withRows = new Set(sets.flatMap(s => [...s]));
    const candidates = custom.filter(i => !withRows.has(i.permissionSetId));
    const sys = new Map();
    for (const g of chunk(candidates.map(i => i.permissionSetId), 200)) for (const [id, s] of await insight.systemPermissionsOf(conn, g)) sys.set(id, s);
    emptyPermissionSets = candidates.filter(i => !(sys.get(i.permissionSetId) || new Set()).size)
      .map(i => ({ key: i.key, recordId: i.recordId || i.permissionSetId, label: i.label, apiName: i.apiName, activeUsers: direct.get(i.permissionSetId) || 0 }));
  } else notes.push('Couldn’t count every permission set’s access rows, so empty permission sets weren’t checked.');

  return {
    generatedAt: new Date().toISOString(), expiringDays: days, notes,
    summary: { unusedPermissionSets: unusedPermissionSets.length, unusedGroups: unusedGroups.length, unusedProfiles: unusedProfiles.filter(p => !p.standard).length,
      emptyPermissionSets: emptyPermissionSets.length, inactiveAssignments: inactiveAssignments.length, expiring: expiring.length,
      highImpactUsers: new Set(highImpact.flatMap(h => h.users.map(u => u.userId))).size, integrationAdmins: integrationAdmins.length },
    unusedPermissionSets, unusedGroups, unusedProfiles, emptyPermissionSets, inactiveAssignments, expiring, highImpact, integrationAdmins
  };
}

module.exports = { healthCheck, HIGH_IMPACT, ADMIN };
