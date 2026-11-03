'use strict';
// A small in-memory Salesforce org behind an HTTP server, answering the REST
// calls Permission Studio makes: SOQL (the subset it generates), describes,
// and sObject Collections inserts, updates and deletes with all-or-none.
// It enforces the platform rules the extension relies on: Edit needs Read on
// objects and fields, one row per parent and object/field, and a system
// permission dependency (Modify All Data needs View All Data).

const http = require('http');

function createOrg(options) {
  const o = options || {};
  const S = {
    token: 'tok1', requests: [], rejectDirect: false, pageSize: 2000, viewAllFields: true,
    systemCount: o.systemCount || 300, org: { Id: '00D000000000001AAA', IsSandbox: true, OrganizationType: 'Enterprise Edition', TrialExpirationDate: null },
    silentlyIgnoreFieldEdit: false, seq: 0, cursors: new Map(), writes: [], deployWipesFields: false, deploys: [], retrieves: 0,
    rtVis: { '0PS000000000001AAA': { 'Lead.Partner': { visible: true } }, '0PS0000000000PRAAA': { 'Lead.Partner': { visible: true, default: true } } },
    layouts: { '0PS0000000000PRAAA': { 'Lead.': 'Lead-Lead Layout', 'Lead.Partner': 'Lead-Partner Layout' } },
    loginHours: { '0PS0000000000PRAAA': { mondayStart: '480', mondayEnd: '1080' } },
    ipRanges: { '0PS0000000000PRAAA': [{ startAddress: '10.0.0.0', endAddress: '10.0.0.255', description: 'Office' }] },
    ipRangesAdditive: false, gzip: false, composites: 0, noFieldsStandard: false, groupPolls: 0, noObjectPicklist: false,
    lockDuringRecalc: false, noActivationField: false, noAuditAccess: false, recalcPolls: 2, refusedWhileUpdating: 0, compositeLocks: false, noCompositeWrites: false, compositeNoRollback: false, compositeWrites: 0, inComposite: false, pendingRecalc: null
  };
  const sysNames = ['ModifyAllData', 'ViewAllData', 'ApiEnabled'];
  for (let i = 0; i < S.systemCount; i++) sysNames.push('Feature' + String(i).padStart(3, '0') + 'WithAFairlyLongName');
  const ps = (id, extra) => {
    const r = Object.assign({ Id: id, Name: '', Label: '', Description: null, NamespacePrefix: null, IsCustom: true, IsOwnedByProfile: false,
      ProfileId: null, Profile: null, PermissionSetGroupId: null, License: null, LastModifiedDate: '2026-10-01T10:00:00.000+0000', LastModifiedBy: { Name: 'Admin User' } }, extra);
    for (const n of sysNames) if (!('Permissions' + n in r)) r['Permissions' + n] = false;
    return r;
  };
  const T = {
    Organization: [S.org],
    PermissionSet: [
      ps('0PS000000000001AAA', { Name: 'Sales_Ops', Label: 'Sales Ops', Description: 'Sales operations team', PermissionsModifyAllData: true, PermissionsViewAllData: true, PermissionsFeature007WithAFairlyLongName: true }),
      ps('0PS000000000002AAA', { Name: 'Reader', Label: 'Reader', NamespacePrefix: 'acme', License: { Name: 'Salesforce' } }),
      ps('0PS000000000009AAA', { IsOwnedByProfile: true, ProfileId: '00e000000000001AAA', IsCustom: false, Profile: { Name: 'System Administrator', UserLicense: { Name: 'Salesforce' } } }),
      ps('0PS00000000000GAAA', { Name: 'X00ex', PermissionSetGroupId: '0PG000000000001AAA', PermissionSetGroup: { MasterLabel: 'Sales Bundle' } }),
      ps('0PS0000000000PRAAA', { IsOwnedByProfile: true, ProfileId: '00e000000000002AAA', IsCustom: true, Profile: { Name: 'Custom: Sales', UserLicense: { Name: 'Salesforce' } } })
    ],
    Profile: [{ Id: '00e000000000001AAA', FullName: 'Admin', UserLicenseId: '100000000000001AAA' }, { Id: '00e000000000002AAA', FullName: 'Custom%3A Sales', UserLicenseId: '100000000000001AAA' }],
    ApexPage: [{ Id: '066000000000001AAA', Name: 'LeadWizard', MasterLabel: 'Lead Wizard', NamespacePrefix: null }],
    FlowDefinitionView: [{ DurableId: '300000000000001AAA', ApiName: 'Lead_Intake', Label: 'Lead Intake', NamespacePrefix: null }],
    AppMenuItem: [{ ApplicationId: '02u000000000001AAA', Name: 'Sales', Label: 'Sales', NamespacePrefix: null, Type: 'TabSet' }, { ApplicationId: '02u000000000002AAA', Name: 'Service', Label: 'Service', NamespacePrefix: null, Type: 'TabSet' }],
    ConnectedApplication: [{ Id: '0H4000000000001AAA', Name: 'Data Loader' }],
    EntityDefinition: [{ DurableId: '01I000000000001AAA', QualifiedApiName: 'Region__mdt', Label: 'Region', NamespacePrefix: null }, { DurableId: '01I000000000002AAA', QualifiedApiName: 'Config__c', Label: 'Config', NamespacePrefix: null },
      { DurableId: '01I000000000003AAA', QualifiedApiName: 'Custom_Thing__c', Label: 'Custom Thing', NamespacePrefix: null }],
    TabDefinition: [{ Name: 'standard-Lead', Label: 'Leads', SobjectName: 'Lead', IsCustom: false }, { Name: 'standard-Account', Label: 'Accounts', SobjectName: 'Account', IsCustom: false }, { Name: 'Custom_Thing__c', Label: 'Custom Things', SobjectName: 'Custom_Thing__c', IsCustom: true }],
    PermissionSetTabSetting: [{ Id: '01P000000000001AAA', ParentId: '0PS000000000001AAA', Name: 'standard-Lead', Visibility: 'DefaultOn' }],
    // Salesforce's dependency rules, in the forms the org may report names (API name, Permissions… prefix).
    PermissionDependency: [
      { Permission: 'ModifyAllData', PermissionType: 'User Permission', RequiredPermission: 'ViewAllData', RequiredPermissionType: 'User Permission' },
      { Permission: 'PermissionsViewAllData', PermissionType: 'User Permission', RequiredPermission: 'PermissionsApiEnabled', RequiredPermissionType: 'User Permission' },
      { Permission: 'ModifyAllData', PermissionType: 'User Permission', RequiredPermission: 'Lead', RequiredPermissionType: 'Object Permission' }
    ],
    CustomPermissionDependency: [{ Id: '0CD000000000001AAA', CustomPermissionId: '0CP000000000002AAA', RequiredCustomPermissionId: '0CP000000000001AAA' }],
    PermissionSetLicense: [{ Id: '0PL000000000001AAA', MasterLabel: 'Sales Cloud Einstein', DeveloperName: 'SalesCloudEinstein' }],
    PermissionSetLicenseAssign: [],
    SetupAuditTrail: [
      { CreatedDate: new Date(Date.now() - 3600e3).toISOString(), CreatedBy: { Name: 'Jordan Lee' }, Action: 'PermSetEnableUserPerm', Section: 'Manage Users', Display: 'Permission set Sales Ops: system permission Export Reports was changed from disabled to enabled', DelegateUser: null },
      { CreatedDate: new Date(Date.now() - 86400e3).toISOString(), CreatedBy: { Name: 'Admin User' }, Action: 'profileFlsChanged', Section: 'Manage Users', Display: 'Changed profile Custom: Sales: field-level security for Lead: Rating was changed', DelegateUser: null },
      { CreatedDate: new Date(Date.now() - 2 * 86400e3).toISOString(), CreatedBy: { Name: 'Admin User' }, Action: 'PermSetAssign', Section: 'Manage Users', Display: 'Permission set Reader: assigned to user Ana Lima', DelegateUser: 'Support Agent' }
    ],
    Layout: [{ Name: 'Lead Layout', NamespacePrefix: null, TableEnumOrId: 'Lead' }, { Name: 'Partner Layout', NamespacePrefix: null, TableEnumOrId: 'Lead' }, { Name: 'Thing Layout', NamespacePrefix: null, TableEnumOrId: '01I000000000003AAA' }],
    UserLicense: [{ Id: '100000000000001AAA', Name: 'Salesforce', Status: 'Active' }, { Id: '100000000000002AAA', Name: 'Salesforce Platform', Status: 'Active' }],
    User: [
      { Id: '005000000000001AAA', Name: 'Ana Lima', Username: 'ana@example.com', IsActive: true, ProfileId: '00e000000000002AAA', Profile: { Name: 'Custom: Sales', UserLicenseId: '100000000000001AAA', UserLicense: { Name: 'Salesforce' } } },
      { Id: '005000000000002AAA', Name: 'Ben Okafor', Username: 'ben@example.com', IsActive: true, ProfileId: '00e000000000001AAA', Profile: { Name: 'System Administrator', UserLicenseId: '100000000000001AAA', UserLicense: { Name: 'Salesforce' } } },
      { Id: '005000000000003AAA', Name: 'Cara Diaz', Username: 'cara@example.com', IsActive: true, ProfileId: '00e000000000002AAA', Profile: { Name: 'Custom: Sales', UserLicenseId: '100000000000001AAA', UserLicense: { Name: 'Salesforce' } } },
      { Id: '005000000000004AAA', Name: 'Old Account', Username: 'old@example.com', IsActive: false, ProfileId: '00e000000000002AAA', Profile: { Name: 'Custom: Sales', UserLicenseId: '100000000000001AAA', UserLicense: { Name: 'Salesforce' } } }
    ],
    PermissionSetAssignment: [],
    PermissionSetGroupComponent: [
      { Id: '0PU000000000001AAA', PermissionSetGroupId: '0PG000000000001AAA', PermissionSetId: '0PS000000000001AAA' },
      { Id: '0PU000000000002AAA', PermissionSetGroupId: '0PG000000000001AAA', PermissionSetId: '0QM000000000001AAA' }
    ],
    MutingPermissionSet: [{ Id: '0QM000000000001AAA', DeveloperName: 'Sales_Bundle_Muting', MasterLabel: 'Sales Bundle Muting' }],
    ApexClass: [
      { Id: '01p000000000001AAA', Name: 'AccountTriggerHandler', NamespacePrefix: null },
      { Id: '01p000000000002AAA', Name: 'LeadService', NamespacePrefix: null },
      { Id: '01p000000000003AAA', Name: 'Util', NamespacePrefix: 'acme' }
    ],
    CustomPermission: [
      { Id: '0CP000000000001AAA', DeveloperName: 'Approve_Discounts', MasterLabel: 'Approve Discounts', NamespacePrefix: null, Description: 'Can approve discounts over 20%' },
      { Id: '0CP000000000002AAA', DeveloperName: 'Bypass_Validation', MasterLabel: 'Bypass Validation', NamespacePrefix: null, Description: null }
    ],
    SetupEntityAccess: [
      { Id: '0J0000000000001AAA', ParentId: '0PS000000000001AAA', SetupEntityId: '01p000000000002AAA', SetupEntityType: 'ApexClass' },
      { Id: '0J0000000000002AAA', ParentId: '0PS000000000001AAA', SetupEntityId: '0CP000000000001AAA', SetupEntityType: 'CustomPermission' }
    ],
    RecordType: [
      { Id: '012000000000001AAA', DeveloperName: 'Direct', Name: 'Direct Lead', SobjectType: 'Lead', NamespacePrefix: null, IsActive: true },
      { Id: '012000000000002AAA', DeveloperName: 'Partner', Name: 'Partner Lead', SobjectType: 'Lead', NamespacePrefix: null, IsActive: true }
    ],
    PermissionSetGroup: [{ Id: '0PG000000000001AAA', DeveloperName: 'Sales_Bundle', MasterLabel: 'Sales Bundle', Description: null, NamespacePrefix: null, Status: 'Updated', LastModifiedDate: '2026-09-01T10:00:00.000+0000', LastModifiedBy: { Name: 'Admin User' } }],
    ObjectPermissions: [
      { Id: '110000000000001AAA', ParentId: '0PS000000000001AAA', SobjectType: 'Account', PermissionsRead: true, PermissionsCreate: true, PermissionsEdit: true, PermissionsDelete: false, PermissionsViewAllRecords: false, PermissionsModifyAllRecords: false, PermissionsViewAllFields: false },
      { Id: '110000000000002AAA', ParentId: '0PS000000000001AAA', SobjectType: 'Custom_Thing__c', PermissionsRead: true, PermissionsCreate: false, PermissionsEdit: false, PermissionsDelete: false, PermissionsViewAllRecords: false, PermissionsModifyAllRecords: false, PermissionsViewAllFields: false },
      { Id: '110000000000003AAA', ParentId: '0PS00000000000GAAA', SobjectType: 'Account', PermissionsRead: true, PermissionsCreate: false, PermissionsEdit: false, PermissionsDelete: false, PermissionsViewAllRecords: false, PermissionsModifyAllRecords: false, PermissionsViewAllFields: false }
    ],
    FieldPermissions: [
      { Id: '01k000000000001AAA', ParentId: '0PS000000000001AAA', SobjectType: 'Lead', Field: 'Lead.Rating', PermissionsRead: true, PermissionsEdit: false }
    ]
  };
  // Assignments: every user has their profile's PermissionSet; Ana and Ben have Sales Ops; Cara has the group.
  let psaSeq = 0;
  const psa = (user, extra) => Object.assign({ Id: '0Pa' + String(++psaSeq).padStart(15, '0'), AssigneeId: user.Id, Assignee: user, PermissionSetGroupId: null, ExpirationDate: null }, extra);
  for (const u of T.User) T.PermissionSetAssignment.push(psa(u, { PermissionSetId: T.PermissionSet.find(x => x.ProfileId === u.ProfileId).Id }));
  T.PermissionSetAssignment.push(psa(T.User[0], { PermissionSetId: '0PS000000000001AAA' }), psa(T.User[1], { PermissionSetId: '0PS000000000001AAA', ExpirationDate: '2026-12-31T00:00:00.000+0000' }),
    psa(T.User[2], { PermissionSetId: '0PS00000000000GAAA', PermissionSetGroupId: '0PG000000000001AAA' }));

  const DESCRIBE = {
    Lead: { name: 'Lead', label: 'Lead', fields: [
      { name: 'Id', label: 'Lead ID', type: 'id', permissionable: false, updateable: false, createable: false },
      { name: 'IsDeleted', label: 'Deleted', type: 'boolean', permissionable: false, updateable: false, createable: false },
      { name: 'SystemModstamp', label: 'System Modstamp', type: 'datetime', permissionable: false, updateable: false, createable: false },
      { name: 'LastName', label: 'Last Name', type: 'string', permissionable: false, updateable: true, createable: true },
      { name: 'CreatedDate', label: 'Created Date', type: 'datetime', permissionable: false, updateable: false, createable: false },
      { name: 'LastModifiedDate', label: 'Last Modified Date', type: 'datetime', permissionable: false, updateable: false, createable: false },
      { name: 'Company', label: 'Company', type: 'string', permissionable: false, updateable: true, createable: true },
      { name: 'Rating', label: 'Rating', type: 'picklist', permissionable: true, updateable: true, createable: true },
      { name: 'Industry', label: 'Industry', type: 'picklist', permissionable: true, updateable: true, createable: true },
      { name: 'Score__c', label: 'Score', type: 'double', permissionable: true, updateable: false, createable: false, calculated: true },
      { name: 'Description', label: 'Description', type: 'textarea', permissionable: true, updateable: true, createable: true }
    ] },
    Account: { name: 'Account', label: 'Account', fields: [{ name: 'Industry', label: 'Industry', type: 'picklist', permissionable: true, updateable: true, createable: true }] },
    Event: { name: 'Event', label: 'Event', fields: [
      { name: 'Id', label: 'Activity ID', type: 'id', permissionable: false, updateable: false, createable: false },
      { name: 'Subject', label: 'Subject', type: 'combobox', permissionable: false, updateable: true, createable: true },
      { name: 'Region__c', label: 'Region', type: 'picklist', permissionable: true, updateable: true, createable: true, custom: true }] },
    FieldPermissions: { name: 'FieldPermissions', fields: [{ name: 'SobjectType', type: 'picklist', picklistValues: ['Account', 'Contact', 'Custom_Thing__c', 'Event', 'Lead', 'Opportunity', 'Task'].map(v => ({ value: v, label: v, active: true })) }] },
    PermissionSetAssignment: { name: 'PermissionSetAssignment', fields: ['Id', 'AssigneeId', 'PermissionSetId', 'PermissionSetGroupId'].map(name => ({ name, type: 'reference' })).concat([{ name: 'ExpirationDate', type: 'datetime' }]) }
  };
  const OBJECT_PERM_OBJECTS = ['Account', 'Contact', 'Custom_Thing__c', 'Lead', 'Opportunity'];
  const GLOBAL = { sobjects: [
    { name: 'Event', label: 'Event', queryable: true, layoutable: true, custom: false },
    { name: 'Task', label: 'Task', queryable: true, layoutable: true, custom: false },
    { name: 'Region__mdt', label: 'Region', queryable: true, custom: true },
    { name: 'Config__c', label: 'Config', queryable: true, custom: true, customSetting: true },
    { name: 'Account', label: 'Account', queryable: true, layoutable: true, custom: false },
    { name: 'Lead', label: 'Lead', queryable: true, layoutable: true, custom: false },
    { name: 'AccountShare', label: 'Account Share', queryable: true, layoutable: false },
    { name: 'Custom_Thing__c', label: 'Custom Thing', queryable: true, layoutable: true, custom: true },
    { name: 'Custom_Thing__History', label: 'Custom Thing History', queryable: true, custom: true },
    { name: 'Old__c', label: 'Old', queryable: true, custom: true, deprecatedAndHidden: true }
  ] };

  // ---------- SOQL subset ----------
  const get = (row, p) => p.split('.').reduce((v, k) => (v == null ? v : v[k]), row);
  /** SOQL LIKE: % any run, _ one character, \\% \\_ \\' \\\\ literal. */
  function likePattern(raw) {
    const t = raw.trim().slice(1, -1);
    let out = '';
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (ch === '\\' && i + 1 < t.length) { out += t[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
      out += ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp('^' + out + '$', 'i');
  }
  function literal(s) {
    s = s.trim();
    if (s === 'null') return null;
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    return Number(s);
  }
  function listValues(s) { return (s.match(/'(?:[^'\\]|\\.)*'/g) || []).map(literal); }
  function query(q) {
    if (S.noActivationField && /HasActivationRequired/.test(q)) throw bad('No such column \'HasActivationRequired\' on entity \'PermissionSet\'');
    const audit = /FROM SetupAuditTrail WHERE CreatedDate = LAST_N_DAYS:(\d+) ORDER BY CreatedDate DESC LIMIT (\d+)$/.exec(q);
    if (audit) {
      if (S.noAuditAccess) throw Object.assign(new Error("sObject type 'SetupAuditTrail' is not supported."), { code: 'INVALID_TYPE' });
      const since = Date.now() - Number(audit[1]) * 86400e3;
      const rows = T.SetupAuditTrail.filter(x => Date.parse(x.CreatedDate) >= since).sort((a, b) => b.CreatedDate.localeCompare(a.CreatedDate)).slice(0, Number(audit[2]));
      return { totalSize: rows.length, done: true, records: rows };
    }
    // A group being recalculated reports Updating for a couple of status checks, then Updated.
    if (/FROM PermissionSetGroup WHERE Id/.test(q) && S.groupPolls > 0 && --S.groupPolls === 0) T.PermissionSetGroup[0].Status = 'Updated';
    const count = /^SELECT COUNT\(\) FROM (\w+) WHERE (.+)$/.exec(q);
    if (count) return { totalSize: /ProfileId/.test(q) ? 7 : /PermissionSetGroupId/.test(q) ? 3 : 12, done: true, records: [] };
    const perPs = /^SELECT PermissionSetId, COUNT\(Id\) (\w+) FROM PermissionSetAssignment WHERE Assignee\.IsActive = true GROUP BY PermissionSetId$/.exec(q);
    if (perPs) {
      const counts = new Map();
      for (const a of T.PermissionSetAssignment) { const u = T.User.find(x => x.Id === a.AssigneeId); if (u && u.IsActive) counts.set(a.PermissionSetId, (counts.get(a.PermissionSetId) || 0) + 1); }
      return { totalSize: counts.size, done: true, records: [...counts].map(([id, n]) => ({ attributes: { type: 'AggregateResult' }, PermissionSetId: id, [perPs[1]]: n })) };
    }
    const grouped = /^SELECT SobjectType, COUNT\(Id\) (\w+) FROM FieldPermissions WHERE ParentId = '(\w+)' GROUP BY SobjectType$/.exec(q);
    if (grouped) {
      const counts = new Map();
      for (const r of T.FieldPermissions.filter(x => x.ParentId === grouped[2])) counts.set(r.SobjectType, (counts.get(r.SobjectType) || 0) + 1);
      return { totalSize: counts.size, done: true, records: [...counts].map(([t, n]) => ({ attributes: { type: 'AggregateResult' }, SobjectType: t, [grouped[1]]: n })) };
    }
    const countAll = /^SELECT COUNT\(\) FROM (\w+)$/.exec(q);
    if (countAll) return { totalSize: T[countAll[1]].length, done: true, records: [] };
    const max = /^SELECT MAX\((\w+)\) (\w+) FROM (\w+)$/.exec(q);
    if (max) return { totalSize: 1, done: true, records: [{ attributes: { type: 'AggregateResult' }, [max[2]]: T[max[3]].map(r => r[max[1]] || r.LastModifiedDate || '').sort().pop() || null }] };
    if (/^SELECT FIELDS\(STANDARD\) FROM PermissionSet WHERE/.test(q)) {
      if (S.noFieldsStandard) throw bad("FIELDS(STANDARD) is not supported in this context");
      q = q.replace('FIELDS(STANDARD)', Object.keys(T.PermissionSet[0]).filter(k => !['License', 'Profile', 'LastModifiedBy', 'PermissionSetGroup'].includes(k)).join(', '));
    }
    const m = /^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY ([\w.]+(?:, [\w.]+)*))?(?: LIMIT (\d+))?$/.exec(q);
    if (!m) throw bad('unparsed: ' + q);
    const [, colText, table, where, order, limit] = m;
    if (!T[table]) throw bad('unknown table ' + table);
    const cols = colText.split(', ').map(c => c.trim());
    let rows = T[table].slice();
    const val = (r, f) => { const v = get(r, f); return v === undefined ? null : v; };
    const test = (r, cond) => {
      let c;
      if ((c = /^\((.+)\)$/.exec(cond))) return c[1].split(' OR ').some(x => test(r, x));
      if ((c = /^([\w.]+) IN \((.+)\)$/.exec(cond))) return listValues(c[2]).includes(val(r, c[1]));
      if ((c = /^([\w.]+) LIKE (.+)$/.exec(cond))) { const re = likePattern(c[2]); return re.test(String(val(r, c[1]) || '')); }
      if ((c = /^([\w.]+) (=|!=) (.+)$/.exec(cond))) { const v = literal(c[3]); return c[2] === '=' ? val(r, c[1]) === v : val(r, c[1]) !== v; }
      throw bad('unparsed condition: ' + cond);
    };
    if (where) for (const cond of where.split(' AND ')) rows = rows.filter(r => test(r, cond));
    if (table === 'ObjectPermissions' && !S.viewAllFields && cols.includes('PermissionsViewAllFields')) throw bad("No such column 'PermissionsViewAllFields' on entity 'ObjectPermissions'");
    if (order) { const keys = order.split(', '); rows.sort((a, b) => { for (const k of keys) { const d = String(get(a, k) || '').localeCompare(String(get(b, k) || '')); if (d) return d; } return 0; }); }
    if (limit) rows = rows.slice(0, Number(limit));
    const out = rows.map(r => {
      const x = { attributes: { type: table } };
      for (const col of cols) {
        if (!col.includes('.')) { x[col] = r[col] === undefined ? null : r[col]; continue; }
        const [rel, ...rest] = col.split('.');
        if (r[rel] == null) { x[rel] = null; continue; }
        x[rel] = x[rel] || { attributes: {} };
        let tgt = x[rel]; let src = r[rel];
        for (let i = 0; i < rest.length - 1; i++) { src = src && src[rest[i]]; tgt[rest[i]] = tgt[rest[i]] || { attributes: {} }; tgt = tgt[rest[i]]; }
        tgt[rest[rest.length - 1]] = src ? src[rest[rest.length - 1]] : null;
      }
      return x;
    });
    return page(out, 0);
  }
  function page(all, offset) {
    const slice = all.slice(offset, offset + S.pageSize);
    const done = offset + S.pageSize >= all.length;
    const res = { totalSize: all.length, done, records: slice };
    if (!done) { const id = 'c' + (++S.seq); S.cursors.set(id, all); res.nextRecordsUrl = '/services/data/v62.0/query/01g' + id + '-' + (offset + S.pageSize); }
    return res;
  }
  function bad(msg) { const e = new Error(msg); e.code = 'MALFORMED_QUERY'; return e; }

  // ---------- writes ----------
  const ID_PREFIX = { ObjectPermissions: '110', FieldPermissions: '01k', SetupEntityAccess: '0J0', PermissionSet: '0PS', PermissionSetAssignment: '0Pa', PermissionSetGroupComponent: '0PU', PermissionSetTabSetting: '01P' };
  const ENTITY_OF = id => [['ApexClass', 'Id', 'ApexClass'], ['CustomPermission', 'Id', 'CustomPermission'], ['ApexPage', 'Id', 'ApexPage'], ['FlowDefinitionView', 'DurableId', 'FlowDefinition'],
    ['AppMenuItem', 'ApplicationId', 'TabSet'], ['ConnectedApplication', 'Id', 'ConnectedApplication'], ['EntityDefinition', 'DurableId', 'CustomEntityDefinition']]
    .map(([t, f, type]) => (T[t].some(x => x[f] === id) ? type : null)).find(Boolean) || null;
  function findById(id) {
    for (const t of ['ObjectPermissions', 'FieldPermissions', 'PermissionSet', 'SetupEntityAccess', 'PermissionSetAssignment', 'PermissionSetGroupComponent', 'PermissionSetTabSetting']) { const r = T[t].find(x => x.Id === id); if (r) return [t, r]; }
    return [null, null];
  }
  function check(type, rec) {
    if (type === 'ObjectPermissions') {
      const read = rec.PermissionsRead;
      if (!read && ['PermissionsCreate', 'PermissionsEdit', 'PermissionsDelete', 'PermissionsViewAllRecords', 'PermissionsModifyAllRecords'].some(f => rec[f])) return 'FIELD_INTEGRITY_EXCEPTION: Read access is required for the other object permissions';
      if (rec.PermissionsModifyAllRecords && !(rec.PermissionsViewAllRecords && rec.PermissionsDelete && rec.PermissionsEdit)) return 'FIELD_INTEGRITY_EXCEPTION: Modify All needs View All, Delete and Edit';
    }
    if (type === 'FieldPermissions' && rec.PermissionsEdit && !rec.PermissionsRead) return 'FIELD_INTEGRITY_EXCEPTION: Edit access requires Read access';
    if (type === 'PermissionSet' && rec.PermissionsModifyAllData && !rec.PermissionsViewAllData) return 'FIELD_INTEGRITY_EXCEPTION: Permission Modify All Data depends on permission(s): View All Data';
    if (type === 'PermissionSet' && rec.IsOwnedByProfile && rec.Profile && rec.IsCustom === false) return 'INSUFFICIENT_ACCESS: cannot modify a standard profile';
    return null;
  }
  /**
   * As in Salesforce: a permission set in a group can't be changed while the group
   * recalculates, and every change to it starts a recalculation (S.lockDuringRecalc).
   */
  function touchedPermissionSets(method, body, ids) {
    const out = new Set();
    const parentOf = id => { const [t, r] = findById(id); return r ? (t === 'PermissionSet' ? r.Id : r.ParentId) : null; };
    if (method === 'DELETE') for (const id of ids) out.add(parentOf(id));
    else for (const rec of body.records) {
      if (rec.attributes.type === 'PermissionSet') out.add(rec.Id);
      else if (['ObjectPermissions', 'FieldPermissions', 'SetupEntityAccess', 'PermissionSetTabSetting'].includes(rec.attributes.type)) out.add(rec.ParentId || parentOf(rec.Id));
    }
    out.delete(null); out.delete(undefined);
    return out;
  }
  function groupsOf(psIds) {
    return T.PermissionSetGroup.filter(g => T.PermissionSetGroupComponent.some(c => c.PermissionSetGroupId === g.Id && psIds.has(c.PermissionSetId)));
  }

  function collectionUnlocked(method, body, ids) {
    const keep = S.lockDuringRecalc;
    S.lockDuringRecalc = false;
    try { return collection(method, body, ids); } finally { S.lockDuringRecalc = keep; }
  }

  function collection(method, body, ids) {
    const results = [];
    const apply = [];
    if (S.lockDuringRecalc) {
      const touched = touchedPermissionSets(method, body, ids);
      // Inside one Composite transaction the recalculation starts at commit, unless S.compositeLocks.
      if (S.inComposite && !S.compositeLocks) {
        S.pendingRecalc = (S.pendingRecalc || []).concat(groupsOf(touched));
        return collectionUnlocked(method, body, ids);
      }
      const busy = groupsOf(touched).find(g => g.Status === 'Updating');
      if (busy) {
        S.refusedWhileUpdating++;
        const code = { POST: 'INSERT_FAILED', PATCH: 'UPDATE_FAILED', DELETE: 'DELETE_FAILED' }[method];
        const message = 'The ' + busy.DeveloperName + ' permission set group is updating. You can make edits to this permission set when the group update completes.';
        return (method === 'DELETE' ? ids : body.records).map(r => ({ id: typeof r === 'string' ? r : r.Id || null, success: false, errors: [{ statusCode: code, message }] }));
      }
      if (touched.size) for (const g of groupsOf(touched)) { g.Status = 'Updating'; S.groupPolls = S.recalcPolls || 2; }
    }
    if (method === 'DELETE') {
      for (const id of ids) { const [t, r] = findById(id); results.push(r ? { id, success: true, errors: [] } : { id, success: false, errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted' }] }); if (r) apply.push(() => { T[t] = T[t].filter(x => x !== r); }); }
    } else {
      for (const rec of body.records) {
        const type = rec.attributes.type;
        const fields = Object.assign({}, rec); delete fields.attributes;
        let err = null; let id = fields.Id;
        if (method === 'POST') {
          if (type === 'ObjectPermissions' && T.ObjectPermissions.some(x => x.ParentId === fields.ParentId && x.SobjectType === fields.SobjectType)) err = 'DUPLICATE_VALUE: duplicate value found: duplicates value on record';
          if (type === 'ObjectPermissions' && !OBJECT_PERM_OBJECTS.includes(fields.SobjectType)) err = 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: SObject Type Name: bad value for restricted picklist field: ' + fields.SobjectType;
          if (type === 'FieldPermissions' && T.FieldPermissions.some(x => x.ParentId === fields.ParentId && x.Field === fields.Field)) err = 'DUPLICATE_VALUE: duplicate value found';
          if (type === 'SetupEntityAccess') {
            if (T.SetupEntityAccess.some(x => x.ParentId === fields.ParentId && x.SetupEntityId === fields.SetupEntityId)) err = 'DUPLICATE_VALUE: duplicate value found';
            const ent = ENTITY_OF(fields.SetupEntityId);
            if (!ent) err = err || 'INVALID_CROSS_REFERENCE_KEY: invalid cross reference id';
            fields.SetupEntityType = ent;
          }
          if (type === 'PermissionSet') {
            if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(fields.Name || '') || /__/.test(fields.Name)) err = 'INVALID_FIELD: The API name can only contain underscores and alphanumeric characters';
            if (T.PermissionSet.some(x => !x.IsOwnedByProfile && x.Name === fields.Name && !x.NamespacePrefix)) err = 'DUPLICATE_DEVELOPER_NAME: The API name is already in use';
          }
          if (['ObjectPermissions', 'FieldPermissions', 'SetupEntityAccess', 'PermissionSetTabSetting'].includes(type) && !T.PermissionSet.some(x => x.Id === fields.ParentId)) err = 'INVALID_CROSS_REFERENCE_KEY: invalid cross reference id';
          if (type === 'PermissionSetTabSetting') {
            if (!['DefaultOn', 'DefaultOff'].includes(fields.Visibility)) err = 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: Visibility: bad value for restricted picklist field: ' + fields.Visibility;
            else if (T.PermissionSetTabSetting.some(x => x.ParentId === fields.ParentId && x.Name === fields.Name)) err = 'DUPLICATE_VALUE: duplicate value found: Name';
            else if (!T.TabDefinition.some(t => t.Name === fields.Name)) err = 'INVALID_FIELD: no tab named ' + fields.Name;
          }
          if (type === 'PermissionSetGroupComponent') {
            const p = T.PermissionSet.find(x => x.Id === fields.PermissionSetId && !x.IsOwnedByProfile && !x.PermissionSetGroupId);
            if (!p) err = 'INVALID_CROSS_REFERENCE_KEY: invalid cross reference id';
            else if (T.PermissionSetGroupComponent.some(x => x.PermissionSetGroupId === fields.PermissionSetGroupId && x.PermissionSetId === fields.PermissionSetId)) err = 'DUPLICATE_VALUE: This permission set is already in the group';
          }
          if (type === 'PermissionSetAssignment') {
            const u = T.User.find(x => x.Id === fields.AssigneeId);
            if (!u || !u.IsActive) err = 'INVALID_CROSS_REFERENCE_KEY: invalid cross reference id';
            const target = fields.PermissionSetGroupId ? { PermissionSetGroupId: fields.PermissionSetGroupId } : { PermissionSetId: fields.PermissionSetId };
            if (T.PermissionSetAssignment.some(x => x.AssigneeId === fields.AssigneeId && (target.PermissionSetGroupId ? x.PermissionSetGroupId === target.PermissionSetGroupId : x.PermissionSetId === target.PermissionSetId && !x.PermissionSetGroupId))) err = err || 'DUPLICATE_VALUE: Duplicate PermissionSetAssignment';
            if (target.PermissionSetGroupId) fields.PermissionSetId = (T.PermissionSet.find(x => x.PermissionSetGroupId === target.PermissionSetGroupId) || {}).Id;
            fields.Assignee = u;
          }
          const row = type === 'ObjectPermissions'
            ? Object.assign({ PermissionsRead: false, PermissionsCreate: false, PermissionsEdit: false, PermissionsDelete: false, PermissionsViewAllRecords: false, PermissionsModifyAllRecords: false, PermissionsViewAllFields: false }, fields)
            : type === 'FieldPermissions' ? Object.assign({ PermissionsRead: false, PermissionsEdit: false }, fields)
              : type === 'PermissionSet' ? ps(null, Object.assign({ Label: fields.Label }, fields))
                : type === 'PermissionSetAssignment' ? Object.assign({ PermissionSetGroupId: null, ExpirationDate: null }, fields) : Object.assign({}, fields);
          err = err || check(type, row);
          id = ID_PREFIX[type] + String(100000 + (++S.seq)).padStart(12, '0') + 'AAA';
          row.Id = id;
          if (type === 'PermissionSet' && row.LicenseId) row.License = { Name: (T.UserLicense.find(l => l.Id === row.LicenseId) || {}).Name };
          if (type === 'PermissionSet') row.SystemModstamp = new Date(Date.now() + (++S.seq)).toISOString();
          if (!err) apply.push(() => T[type].push(row));
        } else {
          const [t, r] = findById(fields.Id);
          if (!r) err = 'ENTITY_IS_DELETED: entity is deleted';
          else {
            const merged = Object.assign({}, r, fields);
            if (t === 'PermissionSet' && fields.Name !== undefined && (!/^[A-Za-z][A-Za-z0-9_]*$/.test(fields.Name) || /__|_$/.test(fields.Name))) err = 'INVALID_FIELD: The API name can only contain underscores and alphanumeric characters';
            if (S.silentlyIgnoreFieldEdit && t === 'FieldPermissions') merged.PermissionsEdit = r.PermissionsEdit;
            err = err || check(t, merged);
            if (!err) apply.push(() => { Object.assign(r, S.silentlyIgnoreFieldEdit && t === 'FieldPermissions' ? omit(fields, 'PermissionsEdit') : fields); if (t === 'PermissionSet') r.SystemModstamp = new Date(Date.now() + (++S.seq)).toISOString(); });
          }
        }
        results.push(err ? { id: id || null, success: false, errors: [{ statusCode: err.split(':')[0], message: err.slice(err.indexOf(':') + 2) }] } : { id, success: true, errors: [] });
      }
    }
    if (results.some(r => !r.success)) {
      return results.map(r => r.success ? { id: r.id, success: false, errors: [{ statusCode: 'ALL_OR_NONE_OPERATION_ROLLED_BACK', message: 'Record rolled back because not all records were valid' }] } : r);
    }
    apply.forEach(f => f());
    // Changing a group's members starts a recalculation.
    if (body && (body.records || []).some(r => r.attributes.type === 'PermissionSetGroupComponent') || (method === 'DELETE' && (ids || []).some(i => i.startsWith('0PU')))) {
      T.PermissionSetGroup[0].Status = 'Updating';
      S.groupPolls = 4;
    }
    S.writes.push({ method, count: results.length });
    return results;
  }
  function omit(o, k) { const c = Object.assign({}, o); delete c[k]; return c; }

  // ---------- Metadata API stand-in (used by fake-sf retrieve/deploy) ----------
  function psFor(type, name) {
    if (type === 'Profile') { const pr = T.Profile.find(x => x.FullName === name); return pr && T.PermissionSet.find(x => x.ProfileId === pr.Id); }
    return T.PermissionSet.find(x => !x.IsOwnedByProfile && ((x.NamespacePrefix ? x.NamespacePrefix + '__' : '') + x.Name) === name);
  }
  function metaRetrieve(type, name, rts, layouts) {
    S.retrieves++;
    const p = psFor(type, name);
    if (!p) return { error: 'Entity of type \'' + type + '\' named \'' + name + '\' cannot be found' };
    const vis = S.rtVis[p.Id] || {};
    const root = type === 'Profile' ? 'Profile' : 'PermissionSet';
    let body = rts.filter(r => T.RecordType.some(t => t.SobjectType + '.' + t.DeveloperName === r)).map(r => {
      const v = vis[r] || { visible: false, default: false };
      return '    <recordTypeVisibilities>\n' + (type === 'Profile' ? '        <default>' + !!v.default + '</default>\n' : '') +
        '        <recordType>' + r + '</recordType>\n        <visible>' + !!v.visible + '</visible>\n    </recordTypeVisibilities>\n';
    }).join('');
    if (type === 'Profile') {
      // Layout assignments come back only for the layouts named in the manifest, as in Salesforce.
      for (const [k, layout] of Object.entries(S.layouts[p.Id] || {})) if (layouts.includes(layout)) {
        const rt = k.slice(k.indexOf('.') + 1) ? k : null;
        body += '    <layoutAssignments>\n        <layout>' + layout + '</layout>\n' + (rt ? '        <recordType>' + rt + '</recordType>\n' : '') + '    </layoutAssignments>\n';
      }
      const hrs = S.loginHours[p.Id];
      if (hrs && Object.keys(hrs).length) body += '    <loginHours>\n' + Object.keys(hrs).sort().map(k => '        <' + k + '>' + hrs[k] + '</' + k + '>\n').join('') + '    </loginHours>\n';
      for (const r of S.ipRanges[p.Id] || []) body += '    <loginIpRanges>\n' + (r.description ? '        <description>' + r.description + '</description>\n' : '') + '        <endAddress>' + r.endAddress + '</endAddress>\n        <startAddress>' + r.startAddress + '</startAddress>\n    </loginIpRanges>\n';
    }
    return { xml: '<?xml version="1.0" encoding="UTF-8"?>\n<' + root + ' xmlns="http://soap.sforce.com/2006/04/metadata">\n' + (type === 'Profile' ? '    <custom>true</custom>\n' : '    <label>' + p.Label + '</label>\n') + body + '</' + root + '>\n' };
  }
  function metaDeploy(type, name, xml) {
    const p = psFor(type, name);
    if (!p) return { error: 'Entity of type \'' + type + '\' named \'' + name + '\' cannot be found' };
    if (type === 'PermissionSet' && !/<label>/.test(xml)) return { error: 'Required field is missing: label' };
    const entries = [...xml.matchAll(/<recordTypeVisibilities>([\s\S]*?)<\/recordTypeVisibilities>/g)].map(m => ({
      recordType: (/<recordType>(.*?)<\/recordType>/.exec(m[1]) || [])[1], visible: /<visible>true/.test(m[1]), default: /<default>true/.test(m[1]) }));
    for (const e of entries) if (!T.RecordType.some(t => t.SobjectType + '.' + t.DeveloperName === e.recordType)) return { error: 'In field: recordType - no RecordType named ' + e.recordType + ' found' };
    S.rtVis[p.Id] = S.rtVis[p.Id] || {};
    for (const e of entries) S.rtVis[p.Id][e.recordType] = type === 'Profile' ? { visible: e.visible, default: e.default } : { visible: e.visible };
    for (const m of xml.matchAll(/<layoutAssignments>([\s\S]*?)<\/layoutAssignments>/g)) {
      const layout = (/<layout>(.*?)<\/layout>/.exec(m[1]) || [])[1];
      const rt = (/<recordType>(.*?)<\/recordType>/.exec(m[1]) || [])[1];
      const obj = layout.slice(0, layout.indexOf('-'));
      if (!T.Layout.some(l => obj + '-' + l.Name === layout)) return { error: 'In field: layout - no Layout named ' + layout + ' found' };
      S.layouts[p.Id] = S.layouts[p.Id] || {};
      S.layouts[p.Id][rt || obj + '.'] = layout;
    }
    const hours = /<loginHours>([\s\S]*?)<\/loginHours>/.exec(xml);
    if (hours) S.loginHours[p.Id] = Object.fromEntries([...hours[1].matchAll(/<(\w+)>(.*?)<\/\1>/g)].map(x => [x[1], x[2]]));
    const ranges = [...xml.matchAll(/<loginIpRanges>([\s\S]*?)<\/loginIpRanges>/g)].map(m => ({ startAddress: (/<startAddress>(.*?)</.exec(m[1]) || [])[1], endAddress: (/<endAddress>(.*?)</.exec(m[1]) || [])[1], description: (/<description>(.*?)</.exec(m[1]) || [])[1] || '' }));
    if (ranges.length) S.ipRanges[p.Id] = S.ipRangesAdditive ? (S.ipRanges[p.Id] || []).concat(ranges) : ranges;
    for (const m of xml.matchAll(/<tabSettings>([\s\S]*?)<\/tabSettings>/g)) {
      const tab = (/<tab>(.*?)<\/tab>/.exec(m[1]) || [])[1];
      const v = (/<visibility>(.*?)<\/visibility>/.exec(m[1]) || [])[1];
      T.PermissionSetTabSetting = T.PermissionSetTabSetting.filter(t => !(t.ParentId === p.Id && t.Name === tab));
      if (v !== 'None') T.PermissionSetTabSetting.push({ ParentId: p.Id, Name: tab, Visibility: v === 'Visible' ? 'DefaultOn' : 'DefaultOff' });
    }
    if (S.deployWipesFields) T.FieldPermissions = T.FieldPermissions.filter(f => f.ParentId !== p.Id);
    S.deploys.push({ type, name, xml });
    return { id: '0Af' + String(++S.seq).padStart(15, '0') };
  }

  // ---------- server ----------
  let currentReq = null;
  function send(res, code, body) {
    const text = body === undefined ? '' : JSON.stringify(body);
    if (S.gzip && currentReq && /gzip/.test(currentReq.headers['accept-encoding'] || '')) {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
      return res.end(require('zlib').gzipSync(text));
    }
    res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(text);
  }
  /**
   * Composite: queries, and sObject Collections writes run as one transaction
   * (allOrNone): if any part fails, everything is rolled back and the rest is
   * reported as halted. S.compositeLocks: whether a group recalculation started
   * by one part also blocks the later parts of the same request.
   * S.noCompositeWrites: refuse writes inside Composite altogether.
   */
  function composite(body) {
    S.composites++;
    const writes = body.compositeRequest.some(sub => /\/composite\/sobjects/.test(sub.url));
    if (writes) S.compositeWrites++;
    const saved = writes ? JSON.stringify(T) : null;
    let failed = false;
    const out = body.compositeRequest.map(sub => {
      const u = new URL(sub.url, 'http://x');
      if (failed) return { body: [{ errorCode: 'PROCESSING_HALTED', message: 'The transaction was rolled back since another operation in the same transaction failed.' }], httpStatusCode: 400, referenceId: sub.referenceId };
      if (/\/composite\/sobjects/.test(u.pathname)) {
        if (S.noCompositeWrites) { failed = true; return { body: [{ errorCode: 'INVALID_API_INPUT', message: 'This resource is not supported in a composite request' }], httpStatusCode: 400, referenceId: sub.referenceId }; }
        const ids = (u.searchParams.get('ids') || '').split(',').filter(Boolean);
        S.inComposite = true;
        const results = collection(sub.method, sub.body, ids);
        S.inComposite = false;
        if (results.some(x => !x.success)) { failed = true; return { body: results, httpStatusCode: 400, referenceId: sub.referenceId }; }
        return { body: results, httpStatusCode: 200, referenceId: sub.referenceId };
      }
      try { return { body: query(u.searchParams.get('q')), httpStatusCode: 200, referenceId: sub.referenceId }; }
      catch (e) { failed = !!body.allOrNone && writes; return { body: [{ errorCode: e.code || 'ERROR', message: e.message }], httpStatusCode: 400, referenceId: sub.referenceId }; }
    });
    if (failed && body.allOrNone && saved && !S.compositeNoRollback) { const back = JSON.parse(saved); for (const k of Object.keys(back)) T[k] = back[k]; }
    else if (writes && S.pendingRecalc) { for (const g of S.pendingRecalc) g.Status = 'Updating'; S.groupPolls = S.recalcPolls || 2; }
    S.pendingRecalc = null;
    return { compositeResponse: out };
  }
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      currentReq = req;
      if (url.pathname === '/__token') return send(res, 200, { token: S.token });
      if (url.pathname === '/__meta/retrieve') return send(res, 200, metaRetrieve(url.searchParams.get('type'), url.searchParams.get('name'), (url.searchParams.get('rts') || '').split(',').filter(Boolean), JSON.parse(url.searchParams.get('layouts') || '[]')));
      if (url.pathname === '/__meta/deploy') return send(res, 200, metaDeploy(url.searchParams.get('type'), url.searchParams.get('name'), raw));
      const viaCli = req.headers['x-fake-cli'] === '1';
      S.requests.push({ method: req.method, url: req.url, length: req.url.length, viaCli });
      if (req.headers.authorization !== 'Bearer ' + S.token || (S.rejectDirect && !viaCli)) return send(res, 401, [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired or invalid' }]);
      const p = url.pathname;
      try {
        if (/\/composite$/.test(p) && req.method === 'POST') return send(res, 200, composite(JSON.parse(raw)));
        if (p.endsWith('/composite/sobjects')) {
          if (req.method === 'DELETE') return send(res, 200, collection('DELETE', null, (url.searchParams.get('ids') || '').split(',').filter(Boolean)));
          return send(res, 200, collection(req.method, JSON.parse(raw)));
        }
        if (p.endsWith('/sobjects')) return send(res, 200, GLOBAL);
        const d = /\/sobjects\/(\w+)\/describe$/.exec(p);
        if (d) {
          if (d[1] === 'ObjectPermissions') {
            const f = ['Id', 'SobjectType', 'ParentId', 'PermissionsRead', 'PermissionsCreate', 'PermissionsEdit', 'PermissionsDelete', 'PermissionsViewAllRecords', 'PermissionsModifyAllRecords'];
            if (S.viewAllFields) f.push('PermissionsViewAllFields');
            // As in Salesforce, SobjectType is a restricted picklist of the objects that take object permissions.
            return send(res, 200, { name: 'ObjectPermissions', fields: f.map(name => name === 'SobjectType' && !S.noObjectPicklist
              ? { name, type: 'picklist', picklistValues: OBJECT_PERM_OBJECTS.map(v => ({ value: v, label: v === 'Custom_Thing__c' ? 'Custom Thing' : v, active: true })) } : { name }) });
          }
          if (d[1] === 'PermissionSet') {
            const fields = [{ name: 'Id', type: 'id', label: 'Id' }, { name: 'Name', type: 'string', label: 'Name' }, { name: 'IsOwnedByProfile', type: 'boolean', label: 'Is Owned By Profile' }];
            for (const n of sysNames) fields.push({ name: 'Permissions' + n, type: 'boolean', label: n === 'ModifyAllData' ? 'Modify All Data' : n === 'ViewAllData' ? 'View All Data' : n === 'ApiEnabled' ? 'API Enabled' : 'Feature ' + n.slice(7, 10) });
            return send(res, 200, { name: 'PermissionSet', fields });
          }
          if (DESCRIBE[d[1]]) return send(res, 200, DESCRIBE[d[1]]);
          return send(res, 404, [{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }]);
        }
        const cur = /\/query\/01g(c\d+)-(\d+)$/.exec(p);
        if (cur) return send(res, 200, page(S.cursors.get(cur[1]), Number(cur[2])));
        if (p.endsWith('/query')) return send(res, 200, query(url.searchParams.get('q')));
        send(res, 404, [{ errorCode: 'NOT_FOUND', message: p }]);
      } catch (e) {
        send(res, 400, [{ errorCode: e.code || 'ERROR', message: e.message }]);
      }
    });
  });
  return { S, T, server, sysNames };
}

module.exports = { createOrg };
