'use strict';

/**
 * Production is decided from the org itself, never from an alias.
 * Developer Edition and trial orgs without an expiry also count as
 * production here, which errs on the safe side.
 */
async function detectProduction(conn) {
  const r = await conn.query('SELECT IsSandbox, OrganizationType, TrialExpirationDate FROM Organization LIMIT 1');
  const org = r.records[0] || {};
  conn.isSandbox = org.IsSandbox === true;
  return org.IsSandbox === false && !org.TrialExpirationDate;
}

module.exports = { detectProduction };
