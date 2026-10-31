'use strict';

/**
 * Permission set and profile XML is two levels deep: the root holds scalar
 * elements (label, description, ...) and repeated entries (objectPermissions,
 * fieldPermissions, ...) whose children are all text. This parser handles
 * exactly that shape, in one linear pass, which keeps 50k-line files fast.
 *
 * It is a reader only. Writing XML keeps the original text and edits entries
 * in place (see the design doc, "Writing XML"), so nothing is reformatted
 * unless normalisation is switched on.
 */

const ELEMENT = /<([A-Za-z_][\w.-]*)(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;

function decode(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => {
    switch (e) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'amp': return '&';
      case 'quot': return '"';
      case 'apos': return "'";
      default: return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    }
  });
}

function children(body) {
  const out = [];
  let m;
  const re = new RegExp(ELEMENT.source, 'g');
  while ((m = re.exec(body)) !== null) out.push({ tag: m[1], body: m[2] === undefined ? '' : m[2], index: m.index, length: m[0].length });
  return out;
}

/**
 * Returns { root, scalars: {name: text}, entries: [{tag, values: {child: text}, index, length}] }.
 * `index`/`length` locate each entry in the original text for in-place edits.
 */
function parse(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  const noProlog = src.replace(/<\?xml[\s\S]*?\?>/, '');
  const rootMatch = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>/.exec(noProlog.replace(/<!--[\s\S]*?-->/g, m => ' '.repeat(m.length)));
  if (!rootMatch) throw new Error('No root element found');
  const root = rootMatch[1];
  const offset = src.length - noProlog.length;
  const open = offset + rootMatch.index + rootMatch[0].length;
  const close = src.lastIndexOf('</' + root);
  if (close < open) throw new Error('Root element <' + root + '> is not closed');
  const body = src.slice(open, close).replace(/<!--[\s\S]*?-->/g, m => ' '.repeat(m.length));

  const scalars = {};
  const entries = [];
  for (const c of children(body)) {
    if (/</.test(c.body)) {
      const values = {};
      for (const k of children(c.body)) values[k.tag] = decode(k.body.trim());
      entries.push({ tag: c.tag, values, index: open + c.index, length: c.length });
    } else {
      scalars[c.tag] = decode(c.body.trim());
    }
  }
  return { root, scalars, entries };
}

module.exports = { parse, decode };
