'use strict';
// A small Excel (.xlsx) writer with no dependencies. Each sheet has an optional
// title block (title, org and date, filters) and then its data as a real Excel
// table: banded rows, filter buttons on the header, sortable, frozen below the
// header. Cells can carry a colour (read, edit, delete, all, ok, risk, muted) and a
// link. Results too large for one sheet are split across several.
const { zip } = require('./zip');

const MAX_ROWS = 1048576;
const MAX_COLS = 16384;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // XML 1.0 can't hold most control characters; Excel refuses a file that has them.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
/** Column letters: 0 → A, 25 → Z, 26 → AA. */
function col(n) { let s = ''; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; }
/** Excel's rules for sheet names: at most 31 characters, none of \ / ? * [ ] :, unique. */
function sheetName(name, used) {
  const base = String(name || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
  let n = base, i = 2;
  while (used.has(n.toLowerCase())) { const suffix = ' (' + i++ + ')'; n = base.slice(0, 31 - suffix.length) + suffix; }
  used.add(n.toLowerCase());
  return n;
}

// Styles (cellXfs index): fonts, fills and the combinations cells use.
const STYLES = ['normal', 'header', 'title', 'muted', 'link', 'read', 'edit', 'delete', 'all', 'ok', 'risk', 'riskHeader'];
const STYLE = Object.fromEntries(STYLES.map((s, i) => [s, i]));
const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="6"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font>' +
  '<font><sz val="10"/><color rgb="FF6B7280"/><name val="Calibri"/></font><font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF9B1C1C"/><name val="Calibri"/></font></fonts>' +
  '<fills count="8"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  ['FFDBEAFE', 'FFFEF3C7', 'FFFEE2E2', 'FFEDE9FE', 'FFDCFCE7', 'FFFDE8E8'].map(c => '<fill><patternFill patternType="solid"><fgColor rgb="' + c + '"/><bgColor indexed="64"/></patternFill></fill>').join('') + '</fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="12">' + [
    [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], // normal, header, title, muted, link
    [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [5, 7], [5, 7] // read, edit, delete, all, ok, risk, riskHeader
  ].map(([f, fill]) => '<xf numFmtId="0" fontId="' + f + '" fillId="' + fill + '" borderId="0" xfId="0"' + (f ? ' applyFont="1"' : '') + (fill ? ' applyFill="1"' : '') + '/>').join('') + '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>';

const cellOf = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : { v };
const text = v => { const c = cellOf(v); return c.v == null ? '' : String(c.v); };

/** One sheet: { name, title?, info?: [lines], header: [names], rows: [[cell]], freezeCols?, widths? }. */
function sheetXml(sheet, index, tableId) {
  const block = [];
  if (sheet.title) block.push([{ v: sheet.title, style: 'title' }]);
  for (const line of sheet.info || []) block.push([{ v: line, style: 'muted' }]);
  if (block.length) block.push([]);
  const top = block.length;
  const header = sheet.header || [];
  const rows = sheet.rows || [];
  const width = Math.max(1, header.length, ...rows.map(r => r.length));
  const hasTable = header.length > 0 && rows.length > 0;
  // A table's column names must be unique and not empty; the header cells say exactly those names.
  const seen = new Set();
  const names = Array.from({ length: header.length }, (_, i) => {
    const n = text(header[i]).trim() || 'Column ' + (i + 1);
    let k = n, j = 2;
    while (seen.has(k.toLowerCase())) k = n + ' (' + j++ + ')';
    seen.add(k.toLowerCase());
    return k;
  });
  const headCells = header.map((h, i) => Object.assign({ style: 'header' }, cellOf(h), { v: names[i] }));
  const all = block.concat(header.length ? [headCells] : [], rows);
  const widths = [];
  for (const r of [headCells].concat(rows.slice(0, 2000))) r.forEach((v, i) => { widths[i] = Math.max(widths[i] || 0, text(v).length); });
  const cols = Array.from({ length: width }, (_, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + Math.min(60, Math.max(8, (sheet.widths && sheet.widths[i]) || (widths[i] || 0) + 3)) + '" customWidth="1"/>').join('');
  const links = [];
  const data = all.map((r, ri) => '<row r="' + (ri + 1) + '">' + r.map((raw, ci) => {
    const c = cellOf(raw);
    if (c.v == null || c.v === '') return '';
    const ref = col(ci) + (ri + 1);
    if (c.link) links.push({ ref, url: c.link });
    const st = STYLE[c.link && !c.style ? 'link' : c.style] || 0;
    const s = st ? ' s="' + st + '"' : '';
    if (typeof c.v === 'number' && isFinite(c.v)) return '<c r="' + ref + '"' + s + '><v>' + c.v + '</v></c>';
    return '<c r="' + ref + '" t="inlineStr"' + s + '><is><t xml:space="preserve">' + esc(c.v) + '</t></is></c>';
  }).join('') + '</row>').join('');
  const headRow = top + 1;
  const freezeRows = header.length ? headRow : 0;
  const freezeCols = sheet.freezeCols || 0;
  const pane = freezeRows || freezeCols
    ? '<sheetViews><sheetView workbookViewId="0"' + (index === 0 ? ' tabSelected="1"' : '') + '><pane ' + (freezeCols ? 'xSplit="' + freezeCols + '" ' : '') + (freezeRows ? 'ySplit="' + freezeRows + '" ' : '') +
      'topLeftCell="' + col(freezeCols) + (freezeRows + 1) + '" activePane="' + (freezeRows && freezeCols ? 'bottomRight' : freezeRows ? 'bottomLeft' : 'topRight') + '" state="frozen"/></sheetView></sheetViews>'
    : '<sheetViews><sheetView workbookViewId="0"' + (index === 0 ? ' tabSelected="1"' : '') + '/></sheetViews>';
  const linkXml = links.length ? '<hyperlinks>' + links.map((l, i) => '<hyperlink ref="' + l.ref + '" r:id="rIdL' + (i + 1) + '"/>').join('') + '</hyperlinks>' : '';
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    pane + '<cols>' + cols + '</cols><sheetData>' + data + '</sheetData>' + linkXml + (hasTable ? '<tableParts count="1"><tablePart r:id="rIdT1"/></tableParts>' : '') + '</worksheet>';
  const rels = links.map((l, i) => '<Relationship Id="rIdL' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' + esc(l.url) + '" TargetMode="External"/>')
    .concat(hasTable ? ['<Relationship Id="rIdT1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table' + tableId + '.xml"/>'] : []);
  let table = null;
  if (hasTable) {
    const ref = 'A' + headRow + ':' + col(width - 1) + (headRow + rows.length);
    const tcols = Array.from({ length: width }, (_, i) => names[i] || 'Column ' + (i + 1));
    table = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="' + tableId + '" name="Table' + tableId +
      '" displayName="Table' + tableId + '" ref="' + ref + '" totalsRowShown="0"><autoFilter ref="' + ref + '"/><tableColumns count="' + width + '">' +
      tcols.map((n, i) => '<tableColumn id="' + (i + 1) + '" name="' + esc(n) + '"/>').join('') +
      '</tableColumns><tableStyleInfo name="TableStyleLight9" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>';
  }
  return { xml, rels, table };
}

/** Splits a sheet too big for Excel: columns first (keeping the first columns on every part), then rows. */
function split(sheet) {
  const rows = sheet.rows || [];
  const header = sheet.header || [];
  const room = MAX_ROWS - 20;
  const keep = sheet.freezeCols || 1;
  let parts = [sheet];
  if (header.length > MAX_COLS) {
    const per = MAX_COLS - keep;
    parts = [];
    for (let c = keep, n = 1; c < header.length; c += per, n++) {
      const pick = r => r.slice(0, keep).concat(r.slice(c, c + per));
      parts.push(Object.assign({}, sheet, { name: sheet.name + ' ' + n, header: pick(header), rows: rows.map(pick) }));
    }
  }
  return parts.flatMap(p => (p.rows || []).length <= room ? [p]
    : Array.from({ length: Math.ceil(p.rows.length / room) }, (_, i) => Object.assign({}, p, { name: p.name + ' ' + (i + 1), rows: p.rows.slice(i * room, (i + 1) * room) })));
}

/** sheets: [{ name, title?, info?, header, rows, freezeCols?, widths? }] → a .xlsx file as a Buffer. */
function writeXlsx(sheets) {
  const used = new Set();
  const named = sheets.flatMap(split).map(s => Object.assign({}, s, { name: sheetName(s.name, used) }));
  const built = [];
  let tables = 0;
  for (let i = 0; i < named.length; i++) {
    const hasTable = (named[i].header || []).length > 0 && (named[i].rows || []).length > 0;
    built.push(sheetXml(named[i], i, hasTable ? ++tables : 0));
  }
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const files = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      named.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') +
      Array.from({ length: tables }, (_, i) => '<Override PartName="/xl/tables/table' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>').join('') + '</Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook ' + ns + '><bookViews><workbookView activeTab="0"/></bookViews><sheets>' +
      named.map((s, i) => '<sheet name="' + esc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      named.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') +
      '<Relationship Id="rId' + (named.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', stylesXml]
  ];
  built.forEach((b, i) => {
    files.push(['xl/worksheets/sheet' + (i + 1) + '.xml', b.xml]);
    if (b.rels.length) files.push(['xl/worksheets/_rels/sheet' + (i + 1) + '.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + b.rels.join('') + '</Relationships>']);
  });
  let t = 0;
  built.forEach(b => { if (b.table) files.push(['xl/tables/table' + (++t) + '.xml', b.table]); });
  return zip(files);
}

module.exports = { writeXlsx, col, sheetName, STYLES, MAX_ROWS, MAX_COLS, split };
