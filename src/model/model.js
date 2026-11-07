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


function key(cat, name) { return cat + ':' + name; }

function splitKey(k) {
  const i = k.indexOf(':');
  return { cat: k.slice(0, i), name: k.slice(i + 1) };
}

function emptyModel(kind, name) { return { kind, name, scalars: {}, entries: new Map() }; }

/** Does this entry grant anything? ("absent" and "all false" both mean no.) */
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
  recordType: { tag: 'recordTypeVisibilities', key: 'recordType', props: { visible: 'visible', default: 'default' }, profileOnly: ['default'] },
  // Newer kinds of access, saved with the Metadata API (field names as in the PermissionSet and Profile types).
  agent: { tag: 'agentAccesses', key: 'agentName', props: { enabled: 'enabled' } },
  externalCredential: { tag: 'externalCredentialPrincipalAccesses', key: 'externalCredentialPrincipal', props: { enabled: 'enabled' } },
  externalDataSource: { tag: 'externalDataSourceAccesses', key: 'externalDataSource', props: { enabled: 'enabled' } },
  presenceStatus: { tag: 'servicePresenceStatusAccesses', key: 'servicePresenceStatus', props: { enabled: 'enabled' } },
  emailRouting: { tag: 'emailRoutingAddressAccesses', key: 'name', props: { enabled: 'enabled' } },
  dataCategory: { tag: 'categoryGroupVisibilities', key: 'dataCategoryGroup', props: { visibility: 'visibility' }, profileOnly: ['visibility'] }
};
/** Kinds of access that live only in metadata (read with a retrieve, saved with a deploy). */
const META_ACCESS = ['agent', 'externalCredential', 'externalDataSource', 'presenceStatus', 'emailRouting'];

const PROFILE_TAB_OUT = { Visible: 'DefaultOn', Available: 'DefaultOff', None: 'Hidden' };

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
  // A profile's default app: the new one on, the previous one (if any) still visible but no longer the default.
  if (cat === 'defaultApp') return [block('applicationVisibilities', [['application', p.app], ['default', true], ['visible', true]], ind)]
    .concat(p.previous && p.previous !== p.app ? [block('applicationVisibilities', [['application', p.previous], ['default', false], ['visible', true]], ind)] : []).join('\n');
  if (cat === 'loginFlow') return p.flow ? block('loginFlows', [['flow', p.flow], ['flowtype', 'UI'], ['friendlyname', p.flow], ['uiLoginFlowType', 'VisualWorkflow'], ['useLightningRuntime', true]], ind) : null;
  if (cat === 'loginIpRanges') return (p.ranges || []).map(r => block('loginIpRanges', [['description', r.description], ['endAddress', r.endAddress], ['startAddress', r.startAddress]], ind)).join('\n');
  const o = XML_OUT[cat];
  if (!o) return null;
  const children = [[o.key, name]];
  for (const [prop, xmlName] of Object.entries(o.props)) {
    if (o.profileOnly && o.profileOnly.includes(prop) && kind !== 'profile') continue;
    if (cat === 'object' && p[prop] === undefined) continue;
    let v = p[prop];
    if (cat === 'tab' && kind === 'profile') v = PROFILE_TAB_OUT[v] || v;
    children.push([xmlName, typeof v === 'boolean' || v === undefined ? String(v === true) : v]);
  }
  // Profiles require <default> on app visibility.
  if (cat === 'app' && kind === 'profile') children.push(['default', String(p.default === true)]);
  return block(xmlTag(kind, cat), children, ind);
}

module.exports = { XML_OUT, META_ACCESS, key, splitKey, emptyModel, grants, entryXml, xmlTag, block };
