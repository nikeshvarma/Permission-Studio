'use strict';

/** Quotes a value for a SOQL string literal. */
function str(value) {
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/** IN (...) list. Callers chunk large lists with `chunk` first. */
function inList(values) {
  if (!values.length) throw new Error('inList needs at least one value');
  return '(' + values.map(str).join(', ') + ')';
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Salesforce Ids are 15 or 18 alphanumeric characters. */
function assertId(id) {
  if (!/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(String(id))) throw new Error('Not a Salesforce Id: ' + id);
  return id;
}

module.exports = { str, inList, chunk, assertId };
