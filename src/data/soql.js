'use strict';

/** Quotes a value for a SOQL string literal. */
function str(value) {
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/**
 * A LIKE pattern that matches `text` anywhere, with the text taken literally:
 * quotes and backslashes are escaped for the string, % and _ so they aren't wildcards.
 */
function likeAnywhere(text) {
  return "'%" + String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/%/g, '\\%').replace(/_/g, '\\_') + "%'";
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

module.exports = { str, likeAnywhere, chunk, assertId };
