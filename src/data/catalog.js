'use strict';

const { str, assertId } = require('./soql');

/**
 * Every Profile and every Permission Set Group has a backing PermissionSet
 * record. Permissions are always read from that record, so profiles, groups
 * and permission sets share one loader. `permissionSetId` on each item is the
 * record to read; `recordId` is the Profile / PermissionSetGroup / PermissionSet.
 */

/**
 * Each list takes an optional `names` filter (API names), used to load the
 * person's favourites first; the full list follows in the background.
 */
async function listPermissionSets(conn, names) {
  const only = names ? ' AND Name IN (' + names.map(n => str(n.replace(/^\w+?__(?!c$)/, ''))).join(', ') + ')' : '';
  const r = await conn.query(
    'SELECT Id, Name, Label, Description, NamespacePrefix, IsCustom, License.Name, LastModifiedDate, LastModifiedBy.Name ' +
    'FROM PermissionSet WHERE IsOwnedByProfile = false AND PermissionSetGroupId = null' + only + ' ORDER BY Label');
  return r.records.map(p => ({
    kind: 'permissionSet',
    permissionSetId: p.Id,
    recordId: p.Id,
    apiName: qualified(p.NamespacePrefix, p.Name),
    label: p.Label,
    description: p.Description || '',
    license: (p.License && p.License.Name) || '',
    managed: !!p.NamespacePrefix,
    modified: modified(p)
  })).filter(p => !names || names.includes(p.apiName));
}

async function listGroups(conn, names) {
  const only = names ? ' WHERE DeveloperName IN (' + names.map(n => str(n.replace(/^\w+?__(?!c$)/, ''))).join(', ') + ')' : '';
  const r = await conn.query(
    'SELECT Id, DeveloperName, MasterLabel, Description, NamespacePrefix, Status, LastModifiedDate, LastModifiedBy.Name FROM PermissionSetGroup' + only + ' ORDER BY MasterLabel');
  return r.records.map(g => ({
    kind: 'group',
    permissionSetId: null, // resolved on open, see resolveGroupPermissionSet
    recordId: g.Id,
    apiName: qualified(g.NamespacePrefix, g.DeveloperName),
    label: g.MasterLabel,
    description: g.Description || '',
    status: g.Status || '',
    managed: !!g.NamespacePrefix,
    modified: modified(g)
  })).filter(g => !names || names.includes(g.apiName));
}

async function listProfiles(conn, names) {
  const only = names ? ' AND Profile.Name IN (' + names.map(str).join(', ') + ')' : '';
  const r = await conn.query(
    'SELECT Id, ProfileId, Profile.Name, Profile.UserLicense.Name, IsCustom, LastModifiedDate, LastModifiedBy.Name ' +
    'FROM PermissionSet WHERE IsOwnedByProfile = true' + only + ' ORDER BY Profile.Name');
  return r.records.map(p => ({
    kind: 'profile',
    permissionSetId: p.Id,
    recordId: p.ProfileId,
    apiName: (p.Profile && p.Profile.Name) || p.ProfileId,
    label: (p.Profile && p.Profile.Name) || p.ProfileId,
    description: '',
    license: (p.Profile && p.Profile.UserLicense && p.Profile.UserLicense.Name) || '',
    standard: p.IsCustom === false,
    modified: modified(p)
  }));
}

/** Favourites first: { permissionSet, group, profile } holding only the named items. */
/** The lists for the chosen kinds in one batch: { permissionSet, group, profile } (unchosen kinds empty). */
async function listAll(conn, kinds) {
  const want = k => !kinds || kinds.includes(k);
  const [ps, groups, profiles] = await Promise.all([
    want('permissionSet') ? listPermissionSets(conn) : [],
    want('group') ? listGroups(conn) : [],
    want('profile') ? listProfiles(conn) : []
  ]);
  return { permissionSet: ps, group: groups, profile: profiles };
}

/**
 * A cheap fingerprint of the lists: newest modification and row counts.
 * Auto-refresh re-reads the lists only when this changes.
 */
async function changeStamp(conn, kinds) {
  const qs = ['SELECT MAX(SystemModstamp) m FROM PermissionSet', 'SELECT COUNT() FROM PermissionSet'];
  if (!kinds || kinds.includes('group')) qs.push('SELECT MAX(SystemModstamp) m FROM PermissionSetGroup', 'SELECT COUNT() FROM PermissionSetGroup');
  const r = await conn.queryMany(qs);
  return r.map(x => (x.records[0] && x.records[0].m) || x.totalSize).join('|');
}

async function listFavorites(conn, favorites) {
  const by = kind => favorites.filter(f => f.startsWith(kind + ':')).map(f => f.slice(kind.length + 1));
  const [ps, groups, profiles] = await Promise.all([
    by('permissionSet').length ? listPermissionSets(conn, by('permissionSet')) : [],
    by('group').length ? listGroups(conn, by('group')) : [],
    by('profile').length ? listProfiles(conn, by('profile')) : []
  ]);
  return { permissionSet: ps, group: groups, profile: profiles };
}

/** A group's calculated permissions live on its aggregate PermissionSet (muting already applied). */
async function resolveGroupPermissionSet(conn, groupId) {
  const r = await conn.query('SELECT Id FROM PermissionSet WHERE PermissionSetGroupId = ' + str(assertId(groupId)) + ' LIMIT 1');
  if (!r.records.length) throw new Error('No aggregate permission set found for group ' + groupId);
  return r.records[0].Id;
}

function modified(r) {
  return r.LastModifiedDate ? { at: r.LastModifiedDate, by: (r.LastModifiedBy && r.LastModifiedBy.Name) || '' } : null;
}

function qualified(ns, name) { return ns ? ns + '__' + name : name; }

module.exports = { listPermissionSets, listGroups, listProfiles, listAll, changeStamp, listFavorites, resolveGroupPermissionSet };
