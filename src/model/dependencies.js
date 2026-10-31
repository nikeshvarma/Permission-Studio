(function (root, factory) {
  // Shared by the extension (CommonJS) and the webview (plain script), so the
  // checkboxes and the save path apply exactly the same rules.
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PermDeps = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/**
 * Dependency rules for object and field permissions, applied automatically
 * when a change is staged (decision 16). Granting a permission also grants
 * what it needs; revoking one also revokes what depends on it.
 *
 * System permission dependencies are not hard-coded: Salesforce publishes
 * them in the PermissionDependency object, which phase 3 reads per org.
 */

// Granting the key also grants every listed permission.
const OBJECT_REQUIRES = {
  read: [],
  create: ['read'],
  edit: ['read'],
  delete: ['read', 'edit'],
  viewAll: ['read'],
  modifyAll: ['read', 'edit', 'delete', 'viewAll'],
  viewAllFields: ['read']
};

// Revoking the key also revokes everything that requires it.
const OBJECT_REQUIRED_BY = invert(OBJECT_REQUIRES);

function invert(req) {
  const out = {};
  for (const k of Object.keys(req)) out[k] = [];
  for (const [k, needs] of Object.entries(req)) for (const n of needs) out[n].push(k);
  // Close transitively: revoking read must also revoke delete via edit, etc.
  let grew = true;
  while (grew) {
    grew = false;
    for (const k of Object.keys(out)) {
      for (const d of out[k].slice()) for (const dd of out[d]) {
        if (!out[k].includes(dd)) { out[k].push(dd); grew = true; }
      }
    }
  }
  return out;
}

/**
 * Applies one permission flag change to an object entry.
 * Returns the full resulting props and the list of flags that changed,
 * with `implied: true` on the ones the rules added.
 */
function applyObject(current, flag, value) {
  if (!(flag in OBJECT_REQUIRES)) throw new Error('Unknown object permission: ' + flag);
  const before = Object.assign(blankObject(), current || {});
  const after = Object.assign({}, before);
  after[flag] = value;
  const implied = value ? OBJECT_REQUIRES[flag] : OBJECT_REQUIRED_BY[flag];
  for (const f of implied) after[f] = value;
  return { props: after, changed: changedFlags(before, after, flag) };
}

/**
 * Field-level security. `meta` comes from the object's describe:
 *   permissionable === false  -> FLS cannot be set at all (e.g. required fields)
 *   updateable === false      -> Edit cannot be granted (formula, roll-up, auto number)
 * `objectProps` is the same permission set's object entry, used only for a warning.
 */
function applyField(current, flag, value, meta, objectProps) {
  if (flag !== 'read' && flag !== 'edit') throw new Error('Unknown field permission: ' + flag);
  const warnings = [];
  if (meta && meta.permissionable === false) {
    return { props: Object.assign({ read: false, edit: false }, current), changed: [], blocked: 'Field-level security cannot be set on this field.', warnings };
  }
  if (flag === 'edit' && value && meta && meta.updateable === false) {
    return { props: Object.assign({ read: false, edit: false }, current), changed: [], blocked: 'This field is read-only, so Edit cannot be granted.', warnings };
  }
  const before = Object.assign({ read: false, edit: false }, current || {});
  const after = Object.assign({}, before, { [flag]: value });
  if (flag === 'edit' && value) after.read = true;
  if (flag === 'read' && !value) after.edit = false;
  if (after.read && (!objectProps || !objectProps.read)) {
    warnings.push('The object has no Read access in this permission set, so the field stays hidden unless another source grants it.');
  }
  if (after.edit && objectProps && objectProps.read && !objectProps.edit) {
    warnings.push('The object has no Edit access in this permission set, so the field cannot be edited through it.');
  }
  return { props: after, changed: changedFlags(before, after, flag), warnings };
}

function blankObject() {
  const o = {};
  for (const k of Object.keys(OBJECT_REQUIRES)) o[k] = false;
  return o;
}

function changedFlags(before, after, primary) {
  const out = [];
  for (const k of Object.keys(after)) {
    if (before[k] !== after[k]) out.push({ flag: k, from: before[k], to: after[k], implied: k !== primary });
  }
  return out;
}

return { applyObject, applyField, OBJECT_REQUIRES, OBJECT_REQUIRED_BY };
}));
