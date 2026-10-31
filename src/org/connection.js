'use strict';

const sfcli = require('./sfcli');
const zlib = require('zlib');

/**
 * HTTP through Node's http/https modules rather than global fetch: inside
 * VS Code these honour the editor's proxy settings and the operating system's
 * certificate store (http.proxySupport, http.systemCertificates), which
 * corporate networks with TLS inspection need. Responses are gzip-compressed.
 */
function nodeFetch(url, init) {
  const u = new URL(url);
  const mod = u.protocol === 'http:' ? require('http') : require('https');
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method: init.method, headers: Object.assign({ 'Accept-Encoding': 'gzip' }, init.headers) }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        let body = Buffer.concat(chunks);
        try { if (res.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body); } catch (e) { return reject(e); }
        const text = body.toString('utf8');
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text: async () => text });
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('No answer from Salesforce within 2 minutes')));
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/**
 * A live connection to the project's default org.
 *
 * Two transports, same interface (query, count, describe, globalDescribe):
 *
 *   rest  The access token from `sf org display` is used to call the REST API
 *         directly. Fast: one HTTP round trip per page.
 *   cli   Every call goes through the Salesforce CLI (`sf data query`,
 *         `sf sobject describe`). Slower, but it uses the CLI's own session
 *         handling, proxy settings and certificates.
 *
 * `sf org display` hands back the stored token without renewing it, so an
 * expired token stays expired however often it is asked for. On a 401 the
 * connection therefore runs one cheap CLI query first, which makes the CLI
 * renew and save the token, then reads the token again. If REST still fails
 * (session refused, or the HTTP request itself is blocked by a proxy or
 * certificate inspection), the connection switches to the CLI transport for
 * the rest of the session and says so in the log.
 *
 * The token is held in memory only and is never logged.
 */

// Longest SOQL text sent in one call. Keeps REST URLs well under the URL
// limit and CLI command lines under cmd.exe's 8,191-character limit even
// after escaping. Loaders split their queries to fit.
const MAX_QUERY_LENGTH = 5000;

// Describes rarely change; a persisted one is reused for a day unless the
// person selects Refresh.
const DESCRIBE_TTL_MS = 24 * 60 * 60 * 1000;

// sObject Collections take up to 200 records per call.
const COLLECTION_SIZE = 200;

/** Runs at most `n` tasks at once; the rest wait their turn. */
function gate(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    Promise.resolve().then(task).then(resolve, reject).finally(() => { active--; next(); });
  };
  return task => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); next(); });
}

class Connection {
  constructor(org, options) {
    const o = options || {};
    this.username = org.username;
    this.alias = org.alias || '';
    this.instanceUrl = trimUrl(org.instanceUrl);
    this.accessToken = org.accessToken;
    this.apiVersion = o.apiVersion || org.apiVersion || '62.0';
    this.sfPath = o.sfPath || 'sf';
    this.cwd = o.cwd;
    this.mode = o.mode === 'cli' ? 'cli' : o.mode === 'library' ? 'library' : 'rest';
    this.forcedMode = ['cli', 'rest', 'library'].includes(o.mode) ? o.mode : null;
    this._lib = o.library || null;
    this.maxQueryLength = MAX_QUERY_LENGTH;
    this.isProduction = null;
    this._fetch = o.fetch || nodeFetch;
    this._log = o.log || (() => {});
    this._onMode = o.onModeChange || (() => {});
    this._describes = new Map();
    this._global = null;
    this._persist = o.persist || null;
    this._persistFresh = false;
    // Parallel loads are capped so the CLI transport doesn't start dozens of processes.
    this._gate = gate(o.concurrency || 4);
  }

  get label() { return this.alias || this.username; }

  // ---------- public interface ----------

  async query(soql, options) {
    const o = options || {};
    if (this.mode === 'cli') return this._cliQuery(soql, o);
    return this._withRestFallback(() => this._restQuery(soql, o), () => this._cliQuery(soql, o));
  }

  /**
   * Several queries at once. Over REST they go in Composite requests of up to
   * 25, so a whole screen loads in one round trip; the CLI runs them in parallel.
   * Returns one { totalSize, records } per query, in order.
   */
  async queryMany(soqls, options) {
    const o = options || {};
    if (!soqls.length) return [];
    if (this.mode === 'cli' || soqls.length === 1) return Promise.all(soqls.map(q => this.query(q, o)));
    return this._withRestFallback(async () => {
      const out = [];
      for (let i = 0; i < soqls.length; i += 25) {
        const slice = soqls.slice(i, i + 25);
        const r = await this._request('POST', this._base() + '/composite', { allOrNone: false,
          compositeRequest: slice.map((q, j) => ({ method: 'GET', url: this._base(o.tooling) + '/query?q=' + encodeURIComponent(q), referenceId: 'q' + (i + j) })) });
        for (const sub of r.compositeResponse) {
          if (sub.httpStatusCode >= 400) throw apiError(sub.httpStatusCode, sub.body, JSON.stringify(sub.body));
          let page = sub.body;
          const records = page.records.slice();
          while (!page.done && page.nextRecordsUrl) { page = await this._request('GET', page.nextRecordsUrl); records.push(...page.records); }
          out.push({ totalSize: page.totalSize, records: records.map(stripAttributes) });
        }
      }
      return out;
    }, () => Promise.all(soqls.map(q => this._cliQuery(q, o))));
  }

  async count(soql) {
    if (this.mode === 'cli') return (await this._cliQuery(soql, {})).totalSize;
    return this._withRestFallback(
      async () => (await this._request('GET', this._base() + '/query?q=' + encodeURIComponent(soql))).totalSize,
      async () => (await this._cliQuery(soql, {})).totalSize);
  }

  describe(sobject) {
    if (!this._describes.has(sobject)) {
      const saved = this._persisted('describe:' + sobject);
      if (saved) { this._describes.set(sobject, Promise.resolve(saved)); return this._describes.get(sobject); }
      const p = (this.mode === 'cli'
        ? this._cliDescribe(sobject)
        : this._withRestFallback(
          () => this._request('GET', this._base() + '/sobjects/' + encodeURIComponent(sobject) + '/describe'),
          () => this._cliDescribe(sobject)))
        .then(d => { this._save('describe:' + sobject, d); return d; })
        .catch(e => { this._describes.delete(sobject); throw e; });
      this._describes.set(sobject, p);
    }
    return this._describes.get(sobject);
  }

  /** { sobjects: [{ name, label }] }. The CLI transport has names only, so labels fall back to names. */
  globalDescribe() {
    if (!this._global) {
      const saved = this._persisted('global');
      if (saved) { this._global = Promise.resolve(saved); return this._global; }
      this._global = (this.mode === 'cli'
        ? this._cliGlobal()
        : this._withRestFallback(() => this._request('GET', this._base() + '/sobjects'), () => this._cliGlobal()))
        .then(g => { this._save('global', g); return g; })
        .catch(e => { this._global = null; throw e; });
    }
    return this._global;
  }

  /** Drops describes, including persisted ones, so the next read goes to the org. */
  forget() { this._describes.clear(); this._global = null; this._persistFresh = true; }

  _persisted(key) {
    if (!this._persist || this._persistFresh) return null;
    const e = this._persist.get(key);
    return e && Date.now() - e.savedAt < DESCRIBE_TTL_MS ? e.value : null;
  }

  _save(key, value) { if (this._persist) this._persist.set(key, value); }

  // ---------- writes ----------

  /** Inserts records; returns their new Ids. All or none per call. */
  async create(sobject, records) {
    return this._write('POST', sobject, records.map(r => Object.assign({ attributes: { type: sobject } }, r)),
      r => ['data', 'create', 'record', '--sobject', sobject, '--values', values(r)]);
  }

  /** Updates records; each must carry its Id. */
  async update(sobject, records) {
    return this._write('PATCH', sobject, records.map(r => Object.assign({ attributes: { type: sobject } }, r)),
      r => ['data', 'update', 'record', '--sobject', sobject, '--record-id', r.Id, '--values', values(omit(r, 'Id'))]);
  }

  async destroy(sobject, ids) {
    return this._write('DELETE', sobject, ids.map(Id => ({ Id })),
      r => ['data', 'delete', 'record', '--sobject', sobject, '--record-id', r.Id]);
  }

  async _write(method, sobject, records, cliArgs) {
    const ids = [];
    for (let i = 0; i < records.length; i += COLLECTION_SIZE) {
      const slice = records.slice(i, i + COLLECTION_SIZE);
      const rest = () => this._restCollection(method, slice);
      const cli = () => this._cliWrite(slice, cliArgs);
      let r;
      if (this.mode === 'cli') r = await cli();
      else {
        try { r = await rest(); } catch (e) {
          // A refused session means nothing was written, so the CLI can safely redo it.
          // A request that never got an answer may or may not have been applied: say so instead of retrying.
          if (e.tag === 'SESSION_REFUSED' && this.forcedMode !== 'rest') { this.mode = 'cli'; this._onMode('cli', e.message); r = await cli(); }
          else if (e.tag === 'NETWORK') {
            if (this.forcedMode !== 'rest') { this.mode = 'cli'; this._onMode('cli', e.message); }
            throw tagged(new Error('The connection dropped while saving, so some of these changes may or may not have reached the org. ' +
              'Reload to see the current values. (' + e.message + ')'), 'UNKNOWN_OUTCOME');
          } else throw e;
        }
      }
      ids.push(...r);
    }
    return ids;
  }

  async _restCollection(method, records) {
    let results;
    if (method === 'DELETE') {
      results = await this._request('DELETE', this._base() + '/composite/sobjects?allOrNone=true&ids=' + records.map(r => encodeURIComponent(r.Id)).join(','));
    } else {
      results = await this._request(method, this._base() + '/composite/sobjects', { allOrNone: true, records });
    }
    const failed = (results || []).filter(x => !x.success);
    if (failed.length) {
      const msgs = [];
      for (const f of failed) for (const err of f.errors || []) {
        if (err.statusCode !== 'ALL_OR_NONE_OPERATION_ROLLED_BACK') msgs.push((err.statusCode ? err.statusCode + ': ' : '') + err.message);
      }
      const e = new Error([...new Set(msgs)].join('\n') || 'The org rejected the change.');
      e.tag = 'REJECTED';
      throw e;
    }
    return results.map(x => x.id);
  }

  async _cliWrite(records, cliArgs) {
    const ids = [];
    for (const r of records) {
      let res;
      try { res = await this._cli(cliArgs(r)); } catch (e) {
        const err = cliSessionError(this, e);
        if (err === e) err.tag = 'REJECTED';
        if (ids.length) err.message += '\n(' + ids.length + ' of ' + records.length + ' records in this step were saved before the error.)';
        throw err;
      }
      ids.push((res && (res.id || res.Id)) || r.Id);
    }
    return ids;
  }

  _cli(args, o) { return this._gate(() => sfcli.runResult(this.sfPath, args.concat(['--target-org', this.username]), { cwd: this.cwd, token: o && o.token })); }

  // ---------- REST transport ----------

  _base(tooling) { return '/services/data/v' + this.apiVersion + (tooling ? '/tooling' : ''); }

  async _restQuery(soql, o) {
    let page = await this._request('GET', this._base(o.tooling) + '/query?q=' + encodeURIComponent(soql));
    const records = page.records.slice();
    while (!page.done && page.nextRecordsUrl) {
      if (o.token && o.token.isCancellationRequested) break;
      page = await this._request('GET', page.nextRecordsUrl);
      records.push(...page.records);
      if (o.onProgress) o.onProgress(records.length, page.totalSize);
    }
    return { totalSize: page.totalSize, records: records.map(stripAttributes) };
  }

  async _request(method, path, body) {
    if (this.mode === 'library') return this._libraryRequest(method, path, body);
    const url = /^https?:/.test(path) ? path : this.instanceUrl + path;
    let res = await this._send(method, url, body);
    if (res.status === 401) {
      const first = await errorSummary(res);
      this._log('REST returned 401 for ' + this.label + ' from ' + hostOf(url) + ' (' + first + '; token from the CLI: ' + tokenShape(this.accessToken) + '); renewing the session through the CLI');
      await this._renewToken();
      res = await this._send(method, url, body);
      if (res.status === 401) {
        const why = await errorSummary(res);
        this._log('Still refused after renewal (' + why + '; token: ' + tokenShape(this.accessToken) + '). ' + (/INVALID_AUTH_HEADER/.test(why)
          ? 'Salesforce found the Authorization header malformed: the token the CLI hands out (sf org display) is not usable as is by other programs here.'
          : 'The CLI can use this session but this connection can’t: often the org locks sessions to the IP address they started from and the two reach Salesforce by different routes.'));
        throw tagged(new Error('Session still refused after renewal (' + why + ')'), 'SESSION_REFUSED');
      }
    }
    const text = await res.text();
    const json = text ? safeJson(text) : null;
    if (!res.ok) throw apiError(res.status, json, text);
    return json;
  }

  _send(method, url, body) { return this._gate(() => this._sendNow(method, url, body)); }

  async _sendNow(method, url, body) {
    try {
      return await this._fetch(url, {
        method,
        headers: Object.assign(
          { Authorization: 'Bearer ' + this.accessToken, Accept: 'application/json' },
          body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      // fetch rejects only when the request never got an HTTP answer:
      // DNS, proxy, TLS/certificate, connection reset.
      const c = (e && e.cause) || e || {};
      const cause = c.code ? ' (' + c.code + ')' : c !== e && c.message ? ' (' + c.message + ')' : '';
      throw tagged(new Error('HTTP request failed: ' + (e.message || e) + cause), 'NETWORK');
    }
  }

  /** A request through the CLI's own library: its session, renewal and network route. */
  async _libraryRequest(method, path, body) {
    try {
      return await this._gate(() => this._lib.request({ method, url: path,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {} }));
    } catch (e) {
      const err = new Error((e.errorCode ? e.errorCode + ': ' : '') + (e.message || e));
      err.errorCode = e.errorCode || e.name;
      err.status = e.statusCode || e.status;
      throw err;
    }
  }

  /** Makes the CLI renew its stored token, then reads it back. */
  async _renewToken() {
    try {
      await sfcli.runResult(this.sfPath, ['data', 'query', '--query', 'SELECT Id FROM Organization LIMIT 1', '--target-org', this.username], { cwd: this.cwd });
    } catch (e) {
      throw cliSessionError(this, e);
    }
    const info = await sfcli.runResult(this.sfPath, ['org', 'display', '--target-org', this.username], { cwd: this.cwd });
    if (!info || !info.accessToken) throw new Error('The CLI did not return a session for ' + this.label + '.');
    this.accessToken = info.accessToken;
    if (info.instanceUrl) this.instanceUrl = trimUrl(info.instanceUrl);
  }

  async _withRestFallback(rest, cli) {
    try {
      return await rest();
    } catch (e) {
      if (this.forcedMode === 'rest' || (e.tag !== 'SESSION_REFUSED' && e.tag !== 'NETWORK')) throw e;
      this._log('Switching ' + this.label + ' to the CLI connection for this session: ' + e.message);
      this.mode = 'cli';
      this._onMode('cli', e.message);
      return cli();
    }
  }

  // ---------- CLI transport ----------

  async _cliQuery(soql, o) {
    const args = ['data', 'query', '--query', soql];
    if (o.tooling) args.push('--use-tooling-api');
    let result;
    try {
      result = await this._cli(args, o);
    } catch (e) { throw cliSessionError(this, e); }
    const records = (result && result.records) || [];
    return { totalSize: result && typeof result.totalSize === 'number' ? result.totalSize : records.length, records: records.map(stripAttributes) };
  }

  async _cliDescribe(sobject) {
    try {
      return await this._cli(['sobject', 'describe', '--sobject', sobject]);
    } catch (e) { throw cliSessionError(this, e); }
  }

  async _cliGlobal() {
    let names;
    try {
      names = await this._cli(['sobject', 'list', '--sobject', 'all']);
    } catch (e) { throw cliSessionError(this, e); }
    return { sobjects: (names || []).map(n => ({ name: n, label: n })) };
  }
}

/**
 * Opens the connection for a resolved default org. In auto mode the CLI's
 * own library is tried first (see sfcore.js), then direct REST with the
 * CLI's token, then `sf` processes.
 */
async function open(org, options) {
  const o = options || {};
  if (o.mode === 'cli') return new Connection(org, o);
  if ((!o.mode || o.mode === 'library') && o.openLibrary) {
    try {
      const lib = await o.openLibrary(org.username);
      return new Connection({ username: org.username, alias: org.alias, instanceUrl: lib.instanceUrl, apiVersion: lib.version },
        Object.assign({}, o, { mode: 'library', library: lib }));
    } catch (e) {
      if (o.mode === 'library') throw e;
      if (o.log) o.log('The CLI library could not be used (' + (e.message || e) + '); calling the REST API directly instead');
    }
  }
  const info = org.display || await sfcli.runResult(o.sfPath || 'sf', ['org', 'display', '--target-org', org.username], { cwd: o.cwd });
  if (!info || !info.accessToken || !info.instanceUrl) {
    throw new Error('The CLI did not return a session for ' + (org.alias || org.username) + '. Run: sf org login web --alias ' + (org.alias || '<alias>'));
  }
  return new Connection({ username: org.username, alias: org.alias || info.alias, instanceUrl: info.instanceUrl,
    accessToken: info.accessToken, apiVersion: info.apiVersion }, o);
}

function cliSessionError(conn, e) {
  const msg = String(e.message || e);
  if (/expired|invalid_grant|INVALID_SESSION_ID|No authorization information|refresh token/i.test(msg)) {
    return tagged(new Error('The CLI could not renew the session for ' + conn.label + ': ' + msg +
      '\nLog in again with: sf org login web --alias ' + (conn.alias || '<alias>') + ' --instance-url <your My Domain URL>'), 'LOGIN_REQUIRED');
  }
  return e;
}

/** `sf data create/update record --values` text: Name=value pairs, quoted when needed. */
function values(record) {
  return Object.entries(record).filter(([k]) => k !== 'attributes').map(([k, v]) => {
    const s = String(v);
    return k + '=' + (/[\s'"]/.test(s) ? "'" + s.replace(/'/g, "\\'") + "'" : s);
  }).join(' ');
}

function omit(o, key) { const c = Object.assign({}, o); delete c[key]; return c; }

function stripAttributes(r) {
  if (!r || typeof r !== 'object') return r;
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === 'attributes') continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? stripAttributes(v) : v;
  }
  return out;
}

function trimUrl(u) { return String(u || '').replace(/\/+$/, ''); }
/**
 * What kind of token this is, without revealing it: Salesforce session IDs
 * look like "00D…!…", JWT access tokens start "eyJ"; anything else (for
 * example an encrypted value) is not usable as a bearer token.
 */
function tokenShape(t) {
  if (!t) return 'missing';
  const s = String(t);
  const n = s.length + ' characters';
  if (/^00D[A-Za-z0-9]{12,15}![A-Za-z0-9._]+$/.test(s)) return 'session ID format, ' + n;
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(s)) return 'JWT format, ' + n;
  if (/\s|"|'/.test(s)) return 'contains spaces or quotes, ' + n;
  if (/^[0-9a-f]+(:[0-9a-f]+)+$/i.test(s)) return 'looks encrypted (hex with colons), ' + n;
  return 'unrecognised format, ' + n;
}

function hostOf(u) { try { return new URL(u).host; } catch (e) { return '?'; } }

/** "INVALID_SESSION_ID: Session expired or invalid" from a refused response, for the log. */
async function errorSummary(res) {
  try {
    const j = safeJson(await res.text());
    const f = Array.isArray(j) ? j[0] : j;
    return f ? [f.errorCode || f.error, f.message || f.error_description].filter(Boolean).join(': ') : 'no details';
  } catch (e) { return 'no details'; }
}
function safeJson(text) { try { return JSON.parse(text); } catch (e) { return null; } }
function tagged(e, tag) { e.tag = tag; return e; }

function apiError(status, json, text) {
  const first = Array.isArray(json) ? json[0] : json;
  const code = first && (first.errorCode || first.error);
  const msg = first && (first.message || first.error_description);
  const e = new Error(msg ? (code ? code + ': ' : '') + msg : 'HTTP ' + status + ' ' + String(text || '').slice(0, 200));
  e.status = status;
  e.errorCode = code;
  return e;
}

module.exports = { Connection, open, stripAttributes, values, gate, nodeFetch, tokenShape, MAX_QUERY_LENGTH, COLLECTION_SIZE };
