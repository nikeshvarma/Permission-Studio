'use strict';

/**
 * Turns saves from the change log into a summary for a ticket, a design
 * document or a workbook: Markdown (ADO, Jira, wikis, .md files) or
 * tab-separated text (pastes into Excel as cells).
 */

const AREA = {
  object: 'Object Permissions', field: 'Field Permissions', user: 'System Permissions', apexClass: 'Apex Class Access', apexPage: 'Visualforce Page Access',
  flow: 'Flow Access', app: 'Assigned Apps', connectedApp: 'Connected App Access', customPermission: 'Custom Permissions', customMetadata: 'Custom Metadata Types',
  customSetting: 'Custom Settings', tab: 'Tab Settings', recordType: 'Record Type Assignments', layoutAssignment: 'Page Layout Assignments',
  loginHours: 'Login Hours', loginIpRanges: 'Login IP Ranges', assignment: 'Assignments', groupComponent: 'Permission Sets in Group', details: 'Details'
};
const OBJECT_ORDER = [['read', 'Read'], ['create', 'Create'], ['edit', 'Edit'], ['delete', 'Delete'], ['viewAll', 'View All'], ['modifyAll', 'Modify All'], ['viewAllFields', 'View All Fields']];
const ENABLED = ['user', 'apexClass', 'apexPage', 'flow', 'app', 'connectedApp', 'customPermission', 'customMetadata', 'customSetting'];
const DAY = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' };

function hhmm(m) { const n = Number(m); return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0'); }

/** A value in words, e.g. "Read, Edit", "Assigned (default)", "Not included". */
function valueText(cat, v) {
  if (cat === 'object') { const on = OBJECT_ORDER.filter(([f]) => v && v[f]).map(x => x[1]); return on.length ? on.join(', ') : 'No access'; }
  if (cat === 'field') return v && v.read ? (v.edit ? 'Read, Edit' : 'Read') : 'No access';
  if (ENABLED.includes(cat)) return v && v.enabled ? 'Enabled' : 'Disabled';
  if (cat === 'recordType') return v && v.visible ? 'Assigned' + (v.default ? ' (default)' : '') : 'Not assigned';
  if (cat === 'tab') return !v || v.visibility === 'None' ? 'Hidden' : v.visibility;
  if (cat === 'assignment') return v && v.assigned ? 'Assigned' + (v.expires ? ' until ' + v.expires : '') : 'Not assigned';
  if (cat === 'groupComponent') return v && v.included ? 'Included' : 'Not included';
  if (cat === 'layoutAssignment') return v && v.layout ? v.layout.slice(v.layout.indexOf('-') + 1) : 'None';
  if (cat === 'loginHours') {
    const days = Object.keys(DAY).filter(d => v && v[d + 'Start'] !== undefined).map(d => DAY[d] + ' ' + hhmm(v[d + 'Start']) + '–' + hhmm(v[d + 'End']));
    return days.length ? days.join(', ') : 'No restriction';
  }
  if (cat === 'loginIpRanges') return v && v.ranges && v.ranges.length ? v.ranges.map(r => r.startAddress + '–' + r.endAddress + (r.description ? ' (' + r.description + ')' : '')).join(', ') : 'None';
  if (cat === 'details') return v ? [v.label, v.name && '(' + v.name + ')', v.description].filter(Boolean).join(' ') : 'None';
  return v == null ? 'None' : JSON.stringify(v);
}

function when(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso || '');
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** One row per change, oldest save first: { item, area, entry, before, after, saved, result }. */
function rows(entries) {
  const out = [];
  for (const e of entries.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    for (const c of e.changes || []) {
      const i = c.key.indexOf(':');
      const cat = i > 0 ? c.key.slice(0, i) : c.key;
      const name = i > 0 ? c.key.slice(i + 1) : '';
      const label = c.label && c.label !== name && !name.endsWith('.' + c.label) ? c.label : '';
      const entry = cat === 'assignment' || cat === 'groupComponent' ? (c.label || name) : cat === 'loginHours' || cat === 'loginIpRanges' ? AREA[cat] : label ? label + ' (' + name + ')' : name;
      out.push({ item: e.target || '', area: AREA[cat] || cat, entry, before: valueText(cat, c.from), after: valueText(cat, c.to), saved: when(e.at), result: e.result || '', ticket: e.ticket || '' });
    }
  }
  return out;
}

const cell = s => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function toMarkdown(entries, options) {
  const o = options || {};
  const list = rows(entries);
  const items = [...new Set(entries.map(e => e.target).filter(Boolean))];
  const failed = entries.filter(e => e.result === 'failed').length;
  const tickets = [...new Set(entries.map(e => e.ticket).filter(Boolean))];
  const head = ['### Permission changes: ' + (items.join(', ') || 'no item') + (o.org ? ' (' + o.org + ')' : '') + (tickets.length === 1 ? ' · ' + tickets[0] : ''),
    entries.length === 1 ? 'Saved ' + when(entries[0].at) + ' · ' + list.length + (list.length === 1 ? ' change' : ' changes') + (entries[0].result && entries[0].result !== 'saved' ? ' · ' + entries[0].result : '')
      : entries.length + ' saves, ' + list.length + ' changes, ' + when(entries.map(e => e.at).sort()[0]) + ' to ' + when(entries.map(e => e.at).sort().pop()) + (failed ? ' · ' + failed + ' failed' : '')];
  const multi = items.length > 1;
  const tcol = tickets.length > 1;
  const cols = (multi ? ['Item'] : []).concat(['Area', 'Entry', 'Before', 'After'], entries.length > 1 ? ['Saved'] : [], tcol ? ['Ticket'] : []);
  const lines = ['| ' + cols.join(' | ') + ' |', '| ' + cols.map(() => '---').join(' | ') + ' |'];
  for (const r of list) lines.push('| ' + (multi ? [r.item] : []).concat([r.area, r.entry, r.before, r.after], entries.length > 1 ? [r.saved] : [], tcol ? [r.ticket] : []).map(cell).join(' | ') + ' |');
  return head.join('\n') + '\n\n' + lines.join('\n') + '\n';
}


module.exports = { toMarkdown, rows };
