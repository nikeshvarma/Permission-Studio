'use strict';

const flatXml = require('../xml/flatXml');

/**
 * The canonical model is the one shape every feature works on: views, diffs,
 * dependency rules, staged changes and snapshots. Live org data and local XML
 * are both converted into it, which is what makes "local vs org" and
 * "UAT vs Prod" the same comparison.
 *
 *   model = { kind, name, scalars: {...}, entries: Map<key, props> }
 *   key   = category + ':' + name        e.g. "object:Account", "field:Account.Industry"
 *
 * Profiles and permission sets name a few XML elements differently
 * (tabVisibilities vs tabSettings, fieldLevelSecurities as a legacy alias);
 * those all land on the same category here.
 */

const B = 'boolean';
const S = 'string';

const SPEC = {
  objectPermissions: { cat: 'object', key: 'object', props: {
    allowRead: ['read', B], allowCreate: ['create', B], allowEdit: ['edit', B], allowDelete: ['delete', B],
    viewAllRecords: ['viewAll', B], modifyAllRecords: ['modifyAll', B], viewAllFields: ['viewAllFields', B] } },
  fieldPermissions: { cat: 'field', key: 'field', props: { readable: ['read', B], editable: ['edit', B] } },
  fieldLevelSecurities: { cat: 'field', key: 'field', props: { readable: ['read', B], editable: ['edit', B] } },
  userPermissions: { cat: 'user', key: 'name', props: { enabled: ['enabled', B] } },
  classAccesses: { cat: 'apexClass', key: 'apexClass', props: { enabled: ['enabled', B] } },
  pageAccesses: { cat: 'apexPage', key: 'apexPage', props: { enabled: ['enabled', B] } },
  customPermissions: { cat: 'customPermission', key: 'name', props: { enabled: ['enabled', B] } },
  flowAccesses: { cat: 'flow', key: 'flow', props: { enabled: ['enabled', B] } },
  customMetadataTypeAccesses: { cat: 'customMetadata', key: 'name', props: { enabled: ['enabled', B] } },
  customSettingAccesses: { cat: 'customSetting', key: 'name', props: { enabled: ['enabled', B] } },
  externalDataSourceAccesses: { cat: 'externalDataSource', key: 'externalDataSource', props: { enabled: ['enabled', B] } },
  agentAccesses: { cat: 'agent', key: 'agentName', props: { enabled: ['enabled', B] } },
  tabSettings: { cat: 'tab', key: 'tab', props: { visibility: ['visibility', S] } },
  tabVisibilities: { cat: 'tab', key: 'tab', props: { visibility: ['visibility', S] } },
  applicationVisibilities: { cat: 'app', key: 'application', props: { visible: ['visible', B], default: ['default', B] } },
  recordTypeVisibilities: { cat: 'recordType', key: 'recordType', props: {
    visible: ['visible', B], default: ['default', B], personAccountDefault: ['personAccountDefault', B] } },
  layoutAssignments: { cat: 'layout', key: v => (v.layout || '') + '|' + (v.recordType || ''), props: {
    layout: ['layout', S], recordType: ['recordType', S] } },
  loginIpRanges: { cat: 'loginIpRange', key: v => (v.startAddress || '') + '-' + (v.endAddress || ''), props: {
    startAddress: ['startAddress', S], endAddress: ['endAddress', S], description: ['description', S] } },
  loginHours: { cat: 'loginHours', key: () => 'all', props: null }
};

/** Display order and labels for categories. */
const CATEGORIES = [
  ['object', 'Object permissions'], ['field', 'Field permissions'], ['user', 'System permissions'],
  ['apexClass', 'Apex class access'], ['apexPage', 'Visualforce page access'], ['customPermission', 'Custom permissions'],
  ['flow', 'Flow access'], ['customMetadata', 'Custom metadata type access'], ['customSetting', 'Custom setting access'],
  ['tab', 'Tab settings'], ['app', 'App visibility'], ['recordType', 'Record type visibility'],
  ['layout', 'Page layout assignments'], ['connectedApp', 'Connected app access'],
  ['externalDataSource', 'External data source access'], ['agent', 'Agent access'],
  ['loginHours', 'Login hours'], ['loginIpRange', 'Login IP ranges']
];

function key(cat, name) { return cat + ':' + name; }

function splitKey(k) {
  const i = k.indexOf(':');
  return { cat: k.slice(0, i), name: k.slice(i + 1) };
}

function emptyModel(kind, name) { return { kind, name, scalars: {}, entries: new Map() }; }

function convert(raw, type) {
  if (type === B) return raw === 'true';
  return raw;
}

/** XML text (permission set or profile) -> canonical model. Unknown entry tags are kept in `unknown`. */
function fromXml(text, name) {
  const doc = flatXml.parse(text);
  const kind = doc.root === 'Profile' ? 'profile' : doc.root === 'PermissionSetGroup' ? 'group' : 'permissionSet';
  const model = emptyModel(kind, name || doc.scalars.fullName || '');
  model.scalars = doc.scalars;
  model.unknown = [];
  for (const e of doc.entries) {
    const spec = SPEC[e.tag];
    if (!spec) { model.unknown.push(e.tag); continue; }
    const id = typeof spec.key === 'function' ? spec.key(e.values) : e.values[spec.key];
    if (id === undefined || id === '') continue;
    const props = {};
    if (spec.props) {
      for (const [xmlName, [prop, type]] of Object.entries(spec.props)) {
        if (e.values[xmlName] !== undefined) props[prop] = convert(e.values[xmlName], type);
      }
    } else {
      Object.assign(props, e.values);
    }
    model.entries.set(key(spec.cat, id), props);
  }
  model.unknown = [...new Set(model.unknown)];
  return model;
}

/** Does this entry grant anything? Used for "show only granted" and for diffing absent vs false. */
function grants(cat, props) {
  if (!props) return false;
  if (cat === 'tab') return props.visibility && props.visibility !== 'None';
  if (cat === 'layout' || cat === 'loginIpRange' || cat === 'loginHours') return true;
  if (cat === 'app' || cat === 'recordType') return props.visible === true;
  return Object.values(props).some(v => v === true);
}

// ---------- writing entries ----------

/**
 * How each category is written as permission set / profile XML. Children are
 * written in alphabetical order, the way Salesforce writes them, so files
 * stay diff-friendly. Categories missing here (connected app access,
 * assignments) don't live in these files.
 */
const XML_OUT = {
  object: { tag: 'objectPermissions', key: 'object', props: { create: 'allowCreate', delete: 'allowDelete', edit: 'allowEdit', read: 'allowRead', modifyAll: 'modifyAllRecords', viewAllFields: 'viewAllFields', viewAll: 'viewAllRecords' } },
  field: { tag: 'fieldPermissions', key: 'field', props: { edit: 'editable', read: 'readable' } },
  user: { tag: 'userPermissions', key: 'name', props: { enabled: 'enabled' } },
  apexClass: { tag: 'classAccesses', key: 'apexClass', props: { enabled: 'enabled' } },
  apexPage: { tag: 'pageAccesses', key: 'apexPage', props: { enabled: 'enabled' } },
  customPermission: { tag: 'customPermissions', key: 'name', props: { enabled: 'enabled' } },
  flow: { tag: 'flowAccesses', key: 'flow', props: { enabled: 'enabled' } },
  customMetadata: { tag: 'customMetadataTypeAccesses', key: 'name', props: { enabled: 'enabled' } },
  customSetting: { tag: 'customSettingAccesses', key: 'name', props: { enabled: 'enabled' } },
  app: { tag: 'applicationVisibilities', key: 'application', props: { enabled: 'visible' } },
  tab: { tag: kind => (kind === 'profile' ? 'tabVisibilities' : 'tabSettings'), key: 'tab', props: { visibility: 'visibility' } },
  recordType: { tag: 'recordTypeVisibilities', key: 'recordType', props: { visible: 'visible', default: 'default' }, profileOnly: ['default'] }
};

function escXml(v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function block(tag, children, indent) {
  const inner = children.filter(([, v]) => v !== undefined && v !== null && v !== '').sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => indent + indent + '<' + k + '>' + escXml(v) + '</' + k + '>').join('\n');
  return indent + '<' + tag + '>\n' + inner + '\n' + indent + '</' + tag + '>';
}

/** The XML tag a category is written under for this kind (permissionSet / profile), or null. */
function xmlTag(kind, cat) {
  if (cat === 'layoutAssignment') return 'layoutAssignments';
  if (cat === 'loginHours') return 'loginHours';
  if (cat === 'loginIpRanges') return 'loginIpRanges';
  const o = XML_OUT[cat];
  if (!o) return null;
  return typeof o.tag === 'function' ? o.tag(kind) : o.tag;
}

/**
 * XML for one entry, or null when the category has no XML form.
 *   layoutAssignment:<Object>.<RecordType or empty>  { layout }
 *   loginHours:all     { mondayStart: '480', ... }  (minutes after midnight)
 *   loginIpRanges:all  { ranges: [{ startAddress, endAddress, description }] }  (several elements)
 */
function entryXml(kind, entryKey, props, indent) {
  const ind = indent || '    ';
  const { cat, name } = splitKey(entryKey);
  const p = props || {};
  if (cat === 'layoutAssignment') {
    const rt = name.slice(name.indexOf('.') + 1);
    return block('layoutAssignments', [['layout', p.layout], ['recordType', rt ? name : null]], ind);
  }
  if (cat === 'loginHours') return block('loginHours', Object.entries(p).filter(([, v]) => v !== '' && v != null), ind);
  if (cat === 'loginIpRanges') return (p.ranges || []).map(r => block('loginIpRanges', [['description', r.description], ['endAddress', r.endAddress], ['startAddress', r.startAddress]], ind)).join('\n');
  const o = XML_OUT[cat];
  if (!o) return null;
  const children = [[o.key, name]];
  for (const [prop, xmlName] of Object.entries(o.props)) {
    if (o.profileOnly && o.profileOnly.includes(prop) && kind !== 'profile') continue;
    if (cat === 'object' && p[prop] === undefined) continue;
    const v = p[prop];
    children.push([xmlName, typeof v === 'boolean' || v === undefined ? String(v === true) : v]);
  }
  // Profiles require <default> on app visibility.
  if (cat === 'app' && kind === 'profile') children.push(['default', String(p.default === true)]);
  return block(xmlTag(kind, cat), children, ind);
}

module.exports = { SPEC, CATEGORIES, XML_OUT, key, splitKey, emptyModel, fromXml, grants, entryXml, xmlTag };
