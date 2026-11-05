#!/usr/bin/env node
/**
 * tools/cfdns/cfdns.mjs: the flockcorp.com DNS records on Cloudflare, from the
 * command line.
 *
 *   node tools/cfdns/cfdns.mjs verify
 *   node tools/cfdns/cfdns.mjs list [--type MX] [--name receipts]
 *   node tools/cfdns/cfdns.mjs add --type MX --name receipts --content route1.mx.cloudflare.net --priority 10 [--yes]
 *   node tools/cfdns/cfdns.mjs remove <record id> [--yes]
 *
 * Plain Node 18 or later: the global fetch, no packages. README.md beside this
 * file has the commands and the one-time token setup; in short:
 *
 *  - Cloudflare's v4 API, https://api.cloudflare.com/client/v4, with an API
 *    token that reaches the flockcorp.com zone only: Zone DNS Edit, and Zone
 *    Read so the zone can be found by name.
 *  - The token comes from --token-file, else CF_DNS_TOKEN, else the file
 *    ~/.secrets/flock/cloudflare-dns-token. It is sent to api.cloudflare.com
 *    only, and no line this prints carries it: it would show as {token}.
 *  - add and remove are the writes. Each prints its exact call first;
 *    --dry-run stops there and exits 0, and without --yes it stops there and
 *    exits 4. Nothing is ever asked interactively.
 *  - The live records refuse both writes unless --i-know-this-is-live is given
 *    as well: every record at flockcorp.com itself (the site, and the MX
 *    records route1, route2 and route3.mx.cloudflare.net that carry the
 *    domain's mail), at www.flockcorp.com and at api.flockcorp.com.
 *  - Exit codes: 0 done, 1 an API call failed, 2 usage or configuration (a
 *    missing token file too), 3 refused before any write (a live record
 *    without --i-know-this-is-live, or a check failed), 4 not confirmed.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const API_BASE = 'https://api.cloudflare.com/client/v4';
export const ZONE = 'flockcorp.com';
export const EXIT = Object.freeze({ OK: 0, API: 1, USAGE: 2, REFUSED: 3, UNCONFIRMED: 4 });
export const LIVE_FLAG = 'i-know-this-is-live';

/** The record types add writes; the rest are for the dashboard. */
export const ADD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT'];
/** The record types list can filter on (Cloudflare's own list). */
export const LIST_TYPES = ['A', 'AAAA', 'CAA', 'CERT', 'CNAME', 'DNSKEY', 'DS', 'HTTPS', 'LOC', 'MX', 'NAPTR', 'NS',
  'OPENPGPKEY', 'PTR', 'SMIMEA', 'SRV', 'SSHFP', 'SVCB', 'TLSA', 'TXT', 'URI'];
const PROXIABLE = new Set(['A', 'AAAA', 'CNAME']);
const RECORD_ID_RE = /^[0-9a-f]{32}$/i;

export class UsageError extends Error {}
/** A check failed before anything was written. */
export class RefusedError extends Error {}
export class CfError extends Error {
  constructor(message, status = null, errors = []) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

export const HELP = `cfdns: the ${ZONE} DNS records on Cloudflare, from the command line.

Read only:
  verify                            the token: active, reaches ${ZONE} and nothing else, reads DNS
  list [--type MX] [--name x]       records, each with the id remove takes; --name is
                                    receipts, receipts.${ZONE} or @ for ${ZONE} itself

Writes (each prints its exact call; --dry-run stops there, --yes makes it):
  add --type <A|AAAA|CNAME|MX|TXT> --name <name> --content <value>
      [--priority N] [--ttl auto|60-86400] [--proxied true|false]
      --priority is for MX and required there; --proxied for A, AAAA and CNAME
      (default false). A record that is already there is left as it is.
  remove <record id>

Live records refuse add and remove without --${LIVE_FLAG} as well:
  everything at ${ZONE} itself (the site, and its MX records route1, route2 and
  route3.mx.cloudflare.net, which carry the domain's mail), www.${ZONE} and api.${ZONE}.

Options: --token-file <file>  --dry-run  --yes  --${LIVE_FLAG}  --help
Token: --token-file, else CF_DNS_TOKEN, else ${path.join('~', '.secrets', 'flock', 'cloudflare-dns-token')}
  (README.md beside this file has the one-time setup).
Exit codes: 0 done, 1 an API call failed, 2 usage or configuration,
  3 refused before any write, 4 not confirmed (add --yes).`;

// ---------------------------------------------------------------------------
// Names, values and the live records
// ---------------------------------------------------------------------------

const LABEL_RE = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/** receipts, receipts.flockcorp.com, receipts.flockcorp.com. and @ as the record's full name. */
export function fullName(input, zone = ZONE) {
  const raw = String(input ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!raw) throw new UsageError(`--name is empty (it is @ for ${zone} itself)`);
  const name = raw === '@' ? zone : raw === zone || raw.endsWith(`.${zone}`) ? raw : `${raw}.${zone}`;
  if (name.length > 253) throw new UsageError(`--name ${input} is longer than a DNS name can be`);
  name.split('.').forEach((label, i) => {
    if (label === '*' && i === 0) return;
    if (!LABEL_RE.test(label)) {
      throw new UsageError(`--name ${input}: "${label}" is not a DNS label (letters, digits, - and _, at most 63; other letters in punycode)`);
    }
  });
  return name;
}

const isHostname = (h) => h.length <= 253 && h.includes('.') && h.split('.').every((l) => LABEL_RE.test(l));

/** The record's value, checked for its type: A an IPv4 address, AAAA IPv6, CNAME and MX a host name. */
export function checkContent(type, raw) {
  const v = String(raw ?? '');
  if (!v.trim()) throw new UsageError('--content is empty');
  if (type === 'A') {
    if (!net.isIPv4(v.trim())) throw new UsageError(`--content ${v} is not an IPv4 address, which an A record holds (like 192.0.2.10)`);
    return v.trim();
  }
  if (type === 'AAAA') {
    if (!net.isIPv6(v.trim())) throw new UsageError(`--content ${v} is not an IPv6 address, which an AAAA record holds (like 2001:db8::10)`);
    return v.trim().toLowerCase();
  }
  if (type === 'CNAME' || type === 'MX') {
    const h = v.trim().toLowerCase().replace(/\.$/, '');
    if (!isHostname(h)) {
      throw new UsageError(`--content ${v} is not a host name, which a${type === 'MX' ? 'n MX' : ' CNAME'} record points at `
        + `(like ${type === 'MX' ? 'route1.mx.cloudflare.net' : 'example.pages.dev'})`);
    }
    return h;
  }
  return v; // TXT, exactly as given
}

/**
 * Why a record is live, or null. Every record at the zone's own name, at www
 * and at api counts, whatever its type: adding one there changes what is
 * served as surely as removing one.
 */
export function protectionFor(name, record = null, zone = ZONE) {
  const n = String(name || '').toLowerCase().replace(/\.$/, '');
  if (n === zone) {
    if (record && record.type === 'MX') {
      return `the MX records of ${zone} (route1, route2 and route3.mx.cloudflare.net) carry every email to @${zone}`;
    }
    return `${zone} itself is the live site and the domain's mail (its MX records route1, route2 and route3.mx.cloudflare.net carry every email to @${zone})`;
  }
  if (n === `www.${zone}`) return `www.${zone} is the live site`;
  if (n === `api.${zone}`) return `api.${zone} is the app's live backend`;
  return null;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const VALUE_OPTIONS = new Set(['type', 'name', 'content', 'priority', 'ttl', 'proxied', 'token-file']);
const FLAG_OPTIONS = new Set(['yes', 'dry-run', 'help', LIVE_FLAG]);
const SPEC = {
  verify: { id: false, opts: [] },
  list: { id: false, opts: ['type', 'name'] },
  add: { id: false, opts: ['type', 'name', 'content', 'priority', 'ttl', 'proxied', 'yes', 'dry-run', LIVE_FLAG], required: ['type', 'name', 'content'] },
  remove: { id: true, opts: ['yes', 'dry-run', LIVE_FLAG] },
};

export function parseTtl(v) {
  if (v === undefined || /^auto$/i.test(v) || v === '1') return 1;
  if (/^\d+$/.test(v) && Number(v) >= 60 && Number(v) <= 86400) return Number(v);
  throw new UsageError(`--ttl takes auto or a number of seconds from 60 to 86400, not "${v}"`);
}

export function parseArgs(argv) {
  const words = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      words.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (!flag) throw new UsageError(`"${arg}" is not an option`);
    if (FLAG_OPTIONS.has(flag)) {
      if (value !== undefined) throw new UsageError(`--${flag} takes no value`);
      if (opts[flag]) throw new UsageError(`--${flag} is given twice`);
      opts[flag] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(flag)) throw new UsageError(`unknown option --${flag}`);
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`--${flag} needs a value`);
      i += 1;
    }
    if (opts[flag] !== undefined) throw new UsageError(`--${flag} is given twice`);
    opts[flag] = value;
  }

  if (opts.help || words.length === 0 || words[0] === 'help') return { command: 'help', id: null, opts, write: false };
  const [command, ...rest] = words;
  const spec = SPEC[command];
  if (!spec) throw new UsageError(`unknown command "${command}" (${Object.keys(SPEC).join(', ')})`);
  const id = spec.id ? rest.shift() : null;
  if (spec.id && id === undefined) throw new UsageError(`"${command}" needs a record id ("list" shows them)`);
  if (rest.length) throw new UsageError(`unexpected "${rest[0]}"`);
  if (spec.id && !RECORD_ID_RE.test(id)) throw new UsageError(`"${id}" is not a Cloudflare record id (32 characters, 0-9 and a-f; "list" shows them)`);

  const allowed = new Set(['token-file', 'help', ...spec.opts]);
  for (const k of Object.keys(opts)) {
    if (!allowed.has(k)) throw new UsageError(`--${k} does not apply to "${command}"`);
  }
  for (const k of spec.required || []) {
    if (opts[k] === undefined) throw new UsageError(`"${command}" needs --${k}`);
  }

  const out = { command, id: id ? id.toLowerCase() : null, opts, write: command === 'add' || command === 'remove' };
  if (command === 'list') {
    const type = opts.type === undefined ? null : opts.type.toUpperCase();
    if (type && !LIST_TYPES.includes(type)) throw new UsageError(`--type ${opts.type} is not a DNS record type (${LIST_TYPES.join(', ')})`);
    out.filter = { type, name: opts.name === undefined ? null : fullName(opts.name) };
  }
  if (command === 'add') {
    const type = opts.type.toUpperCase();
    if (!ADD_TYPES.includes(type)) throw new UsageError(`add writes ${ADD_TYPES.join(', ')} records; add a ${opts.type} record in the dashboard`);
    const record = { type, name: fullName(opts.name), content: checkContent(type, opts.content), ttl: parseTtl(opts.ttl) };
    if (type === 'MX') {
      if (opts.priority === undefined) throw new UsageError('an MX record needs --priority (0 to 65535, lower is tried first)');
      if (!/^\d+$/.test(opts.priority) || Number(opts.priority) > 65535) throw new UsageError(`--priority takes a whole number from 0 to 65535, not "${opts.priority}"`);
      record.priority = Number(opts.priority);
    } else if (opts.priority !== undefined) {
      throw new UsageError('--priority is for MX records only');
    }
    if (opts.proxied !== undefined && !/^(true|false)$/i.test(opts.proxied)) throw new UsageError(`--proxied takes true or false, not "${opts.proxied}"`);
    const proxied = opts.proxied !== undefined && opts.proxied.toLowerCase() === 'true';
    if (proxied && !PROXIABLE.has(type)) throw new UsageError('--proxied true is for A, AAAA and CNAME records only');
    if (PROXIABLE.has(type)) record.proxied = proxied;
    out.record = record;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------

export function defaultTokenPath(home = os.homedir()) {
  return path.join(home, '.secrets', 'flock', 'cloudflare-dns-token');
}

const stripBom = (s) => String(s).replace(/^\uFEFF/, '');

/**
 * The token, from --token-file, else CF_DNS_TOKEN, else the default file (or
 * the same name with .txt, which is what Notepad saves). The value is checked
 * for shape and never put in a message.
 */
export function loadToken({ env = process.env, tokenFile, home, readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  if (!tokenFile && env.CF_DNS_TOKEN && env.CF_DNS_TOKEN.trim()) {
    return { token: checkTokenShape(env.CF_DNS_TOKEN, 'CF_DNS_TOKEN'), source: 'CF_DNS_TOKEN' };
  }
  const file = tokenFile || defaultTokenPath(home);
  const found = (tokenFile ? [file] : [file, `${file}.txt`]).find((f) => exists(f));
  if (!found) {
    throw new UsageError(tokenFile
      ? `no token file at ${file}`
      : `no Cloudflare token. Save it as ${file} (the token alone, on one line) or set CF_DNS_TOKEN. `
        + 'README.md beside this tool has the steps.');
  }
  return { token: checkTokenShape(readFile(found, 'utf8'), found), source: found };
}

function checkTokenShape(raw, where) {
  let t = stripBom(raw).trim();
  const quoted = /^(["'])(.*)\1$/.exec(t);
  if (quoted) t = quoted[2].trim();
  if (/^bearer\s+/i.test(t)) t = t.replace(/^bearer\s+/i, '');
  if (!t) throw new UsageError(`${where} is empty: it should hold the Cloudflare API token`);
  if (/\s/.test(t)) throw new UsageError(`${where} should hold the token alone, on one line (it holds more than one word or line)`);
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) throw new UsageError(`${where} holds NAME=value; it should hold the token alone`);
  return t;
}

/** Masks each secret wherever it would be printed. */
export function makeRedactor(secrets) {
  const list = secrets.filter((s) => s && String(s).length >= 8).map(String);
  return (text) => {
    let s = String(text);
    for (const v of list) s = s.split(v).join('{token}');
    return s;
  };
}

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

const timeoutSignal = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
const enc = encodeURIComponent;
const PERMISSION_HINT = ` (README.md beside this tool has the token setup: Zone DNS Edit and Zone Read, on ${ZONE} only)`;

/** The API client. GETs retry twice on network errors, 429 and 5xx; writes are never retried. */
export function makeClient({ fetchImpl, token, sleep, base = API_BASE }) {
  async function request(method, p, body) {
    const retries = method === 'GET' ? 2 : 0;
    for (let attempt = 0; ; attempt += 1) {
      let res;
      try {
        res = await fetchImpl(base + p, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: timeoutSignal(60000),
        });
      } catch (e) {
        if (attempt < retries) {
          await sleep(2000 * (attempt + 1));
          continue;
        }
        throw new CfError(`${method} ${p}: could not reach api.cloudflare.com (${e.message})`, null);
      }
      const text = await res.text();
      let json = null;
      if (text) {
        try { json = JSON.parse(text); } catch { json = null; }
      }
      if (res.ok && !(json && json.success === false)) return json || {};
      if (attempt < retries && (res.status === 429 || res.status >= 500)) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      const errors = json && Array.isArray(json.errors) ? json.errors : [];
      const detail = errors.length
        ? errors.map((e) => `${e.code ? `${e.code} ` : ''}${e.message || ''}`.trim()).join('; ')
        : String(text || '').trim().slice(0, 300);
      const hint = res.status === 401 || res.status === 403 ? PERMISSION_HINT : '';
      throw new CfError(`${method} ${p} -> HTTP ${res.status}${detail ? `: ${detail}` : ''}${hint}`, res.status, errors);
    }
  }
  return {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    del: (p) => request('DELETE', p),
  };
}

async function findZone(api) {
  const j = await api.get(`/zones?name=${enc(ZONE)}`);
  const zone = (Array.isArray(j.result) ? j.result : []).find((z) => z.name === ZONE);
  if (!zone) throw new RefusedError(`the token cannot see the ${ZONE} zone.${PERMISSION_HINT}`);
  return zone;
}

const byNameThenType = (a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type)
  || (a.priority ?? 0) - (b.priority ?? 0) || String(a.content).localeCompare(String(b.content));

/** Every record that matches, all pages. The filters are applied here too, so a looser answer cannot widen them. */
async function listRecords(api, zone, { type = null, name = null } = {}) {
  const q = [];
  if (type) q.push(`type=${enc(type)}`);
  if (name) q.push(`name=${enc(name)}`);
  const out = [];
  for (let page = 1; page <= 50; page += 1) {
    const j = await api.get(`/zones/${enc(zone.id)}/dns_records?${[...q, `page=${page}`, 'per_page=100'].join('&')}`);
    out.push(...(Array.isArray(j.result) ? j.result : []));
    const pages = Number(j.result_info && j.result_info.total_pages) || 1;
    if (page >= pages) break;
  }
  return out
    .filter((r) => (!type || r.type === type) && (!name || String(r.name).toLowerCase() === name))
    .sort(byNameThenType);
}

async function getRecord(api, zone, id) {
  try {
    return (await api.get(`/zones/${enc(zone.id)}/dns_records/${enc(id)}`)).result;
  } catch (e) {
    if (e instanceof CfError && e.status === 404) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Printing and comparing
// ---------------------------------------------------------------------------

export function recordLine(r) {
  const extra = [
    r.type === 'MX' && r.priority != null ? `priority ${r.priority}` : null,
    `ttl ${r.ttl === 1 ? 'auto' : r.ttl}`,
    PROXIABLE.has(r.type) ? (r.proxied ? 'proxied' : 'DNS only') : null,
    protectionFor(r.name, r) ? 'LIVE' : null,
  ].filter(Boolean);
  return `${r.id || '(new)'}  ${String(r.type).padEnd(5)} ${r.name}  ${r.content}  ${extra.join('  ')}`;
}

const unquoteTxt = (s) => {
  const t = String(s ?? '');
  return /^"[^"]*"$/.test(t) ? t.slice(1, -1) : t;
};
const comparable = (r) => (r.type === 'TXT' ? unquoteTxt(r.content) : String(r.content ?? '').toLowerCase().replace(/\.$/, ''));

/** Same type, name and value (and priority for MX): Cloudflare would call it a duplicate. */
export function sameRecord(a, b) {
  return a.type === b.type
    && String(a.name).toLowerCase() === String(b.name).toLowerCase()
    && comparable(a) === comparable(b)
    && (a.type !== 'MX' || Number(a.priority) === Number(b.priority));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function finishPlan(ctx, args, problems, what) {
  if (problems.length) {
    ctx.say('');
    ctx.say(`Refused, nothing ${what} (${problems.length} problem${problems.length === 1 ? '' : 's'}):`);
    for (const p of problems) ctx.say(`  - ${p}`);
    return EXIT.REFUSED;
  }
  if (args.opts['dry-run']) {
    ctx.say('');
    ctx.say(`Dry run: nothing ${what}.`);
    return EXIT.OK;
  }
  if (!args.opts.yes) {
    ctx.say('');
    ctx.say(`Nothing ${what}: add --yes to make this call (--dry-run only prints it).`);
    return EXIT.UNCONFIRMED;
  }
  return null;
}

async function runVerify(api, args, ctx) {
  const problems = [];
  let zone = null;
  try {
    zone = await findZone(api);
  } catch (e) {
    if (!(e instanceof RefusedError) && !(e instanceof CfError && (e.status === 401 || e.status === 403))) throw e;
    problems.push(`zone: ${e instanceof RefusedError ? e.message : `the token cannot look up ${ZONE} (${e.message})`}`);
  }

  // A user token answers at /user/tokens/verify; an account-owned one at its
  // account's address, which the zone names.
  let token = null;
  let kind = 'user token';
  let verifyError = null;
  try {
    token = (await api.get('/user/tokens/verify')).result || null;
  } catch (e) {
    if (!(e instanceof CfError) || !e.status || e.status >= 500 || e.status === 429) throw e;
    verifyError = e;
  }
  if (!token && zone && zone.account && zone.account.id) {
    try {
      token = (await api.get(`/accounts/${enc(zone.account.id)}/tokens/verify`)).result || null;
      kind = 'account token';
    } catch (e) {
      if (!(e instanceof CfError) || !e.status || e.status >= 500 || e.status === 429) throw e;
    }
  }
  if (!token) {
    problems.unshift(`token: Cloudflare does not accept it${verifyError ? ` (${verifyError.message})` : ''}`);
  } else {
    const exp = token.expires_on ? Date.parse(token.expires_on) : null;
    const days = exp ? Math.floor((exp - ctx.now().getTime()) / 86400000) : null;
    ctx.say(`token      ${token.status}, ${kind}, ${exp ? `expires ${new Date(exp).toISOString().slice(0, 10)}${days != null && days < 14 ? ` (in ${days} day${days === 1 ? '' : 's'})` : ''}` : 'no expiry date'}`);
    if (token.status !== 'active') problems.push(`token: it is ${token.status}, not active`);
  }

  if (zone) {
    ctx.say(`zone       ${zone.name} (zone id ${zone.id}), ${zone.status}`);
    let names = [];
    try {
      const j = await api.get('/zones?per_page=50');
      names = (Array.isArray(j.result) ? j.result : []).map((z) => z.name).sort();
      const total = Number(j.result_info && j.result_info.total_count) || names.length;
      const others = names.filter((n) => n !== ZONE);
      if (others.length || total > names.length) {
        ctx.say(`reach      ${total} zones: ${names.join(', ')}`);
        problems.push(`reach: the token reaches ${total} zones and should reach ${ZONE} alone. `
          + `Edit it on Cloudflare: Zone Resources, Include, Specific zone, ${ZONE}.`);
      } else {
        ctx.say(`reach      ${ZONE} only`);
      }
    } catch (e) {
      if (!(e instanceof CfError) || !e.status || e.status >= 500) throw e;
      problems.push(`reach: the zone list is not readable (${e.message})`);
    }
    try {
      const j = await api.get(`/zones/${enc(zone.id)}/dns_records?per_page=5`);
      const count = Number(j.result_info && j.result_info.total_count);
      ctx.say(`DNS read   yes${Number.isFinite(count) ? `, ${count} records` : ''}`);
    } catch (e) {
      if (!(e instanceof CfError) || !e.status || e.status >= 500) throw e;
      problems.push(`DNS read: refused (${e.message})`);
    }
    ctx.say('DNS edit   Cloudflare\'s token check does not list permissions, so the first add or remove shows it '
      + '(a token without DNS Edit is refused there with HTTP 403, before anything changes)');
  }

  if (problems.length) {
    ctx.say('');
    ctx.say(`Not ready (${problems.length} problem${problems.length === 1 ? '' : 's'}):`);
    for (const p of problems) ctx.say(`  - ${p}`);
    return EXIT.REFUSED;
  }
  ctx.say('');
  ctx.say(`Ready: the token is active and reaches ${ZONE} alone.`);
  return EXIT.OK;
}

async function runList(api, args, ctx) {
  const zone = await findZone(api);
  const records = await listRecords(api, zone, args.filter);
  const what = [args.filter.type, args.filter.name].filter(Boolean).join(' at ');
  ctx.say(`${ZONE}: ${records.length} record${records.length === 1 ? '' : 's'}${what ? ` (${what})` : ''}`);
  for (const r of records) ctx.say(`  ${recordLine(r)}`);
  if (records.some((r) => protectionFor(r.name, r))) {
    ctx.say(`LIVE records change only with --${LIVE_FLAG}.`);
  }
  return EXIT.OK;
}

async function runAdd(api, args, ctx) {
  const want = args.record;
  const zone = await findZone(api);
  ctx.say(`Add to ${ZONE}:`);
  ctx.say(`  ${recordLine(want)}`);
  const existing = await listRecords(api, zone, { name: want.name });
  ctx.say(`Already at ${want.name}:${existing.length ? '' : ' nothing'}`);
  for (const r of existing) ctx.say(`  ${recordLine(r)}`);
  const same = existing.find((r) => sameRecord(r, want));
  if (same) {
    ctx.say('');
    ctx.say(`That record is already there (${same.id}). Nothing to add.`);
    return EXIT.OK;
  }
  const problems = [];
  const live = protectionFor(want.name, want);
  if (live && !args.opts[LIVE_FLAG]) {
    problems.push(`${live}, so a record added at ${want.name} changes what is live. Add --${LIVE_FLAG} if that is the intent.`);
  }
  const body = { type: want.type, name: want.name, content: want.content, ttl: want.ttl };
  if (want.type === 'MX') body.priority = want.priority;
  if (PROXIABLE.has(want.type)) body.proxied = want.proxied;
  ctx.say('');
  ctx.say('Call:');
  ctx.say(`  POST /zones/${zone.id}/dns_records ${JSON.stringify(body)}`);
  const fin = finishPlan(ctx, args, problems, 'added');
  if (fin !== null) return fin;

  const j = await api.post(`/zones/${enc(zone.id)}/dns_records`, body);
  const made = j.result;
  if (!made || !made.id) throw new CfError(`POST /zones/${zone.id}/dns_records answered without a record`);
  const back = (await getRecord(api, zone, made.id)) || made;
  ctx.say('');
  ctx.say(`Added ${made.id}:`);
  ctx.say(`  ${recordLine(back)}`);
  return EXIT.OK;
}

async function runRemove(api, args, ctx) {
  const zone = await findZone(api);
  const r = await getRecord(api, zone, args.id);
  if (!r) throw new RefusedError(`no record ${args.id} in ${ZONE} ("list" shows the ids)`);
  ctx.say(`Remove from ${ZONE}:`);
  ctx.say(`  ${recordLine(r)}`);
  const problems = [];
  const live = protectionFor(r.name, r);
  if (live && !args.opts[LIVE_FLAG]) problems.push(`${live}, so removing this record changes what is live. Add --${LIVE_FLAG} if that is the intent.`);
  ctx.say('');
  ctx.say('Call:');
  ctx.say(`  DELETE /zones/${zone.id}/dns_records/${r.id}`);
  const fin = finishPlan(ctx, args, problems, 'removed');
  if (fin !== null) return fin;

  await api.del(`/zones/${enc(zone.id)}/dns_records/${enc(r.id)}`);
  if (await getRecord(api, zone, r.id)) {
    ctx.warn(`cfdns: Cloudflare still lists ${r.id} after the DELETE; check the dashboard`);
    return EXIT.API;
  }
  ctx.say('');
  ctx.say(`Removed ${r.id}.`);
  return EXIT.OK;
}

const RUNNERS = { verify: runVerify, list: runList, add: runAdd, remove: runRemove };

/**
 * deps (tests): { env, home, fetch, stdout, stderr, sleep, now, fs }.
 * Returns the exit code.
 */
export async function main(argv, deps = {}) {
  const out = deps.stdout || ((s) => process.stdout.write(`${s}\n`));
  const errOut = deps.stderr || ((s) => process.stderr.write(`${s}\n`));
  let redact = (s) => String(s);
  const ctx = {
    say: (s = '') => out(redact(s)),
    warn: (s) => errOut(redact(s)),
    sleep: deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: deps.now || (() => new Date()),
    fetchImpl: deps.fetch || globalThis.fetch,
    fs: deps.fs || fs,
    env: deps.env || process.env,
  };
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    ctx.warn(`cfdns: ${e.message}`);
    ctx.warn('Run with --help for the commands.');
    return EXIT.USAGE;
  }
  if (args.command === 'help') {
    ctx.say(HELP);
    return EXIT.OK;
  }
  try {
    if (typeof ctx.fetchImpl !== 'function') throw new UsageError('this needs Node 18 or later (no global fetch here)');
    const { token } = loadToken({ env: ctx.env, tokenFile: args.opts['token-file'], home: deps.home, readFile: ctx.fs.readFileSync, exists: ctx.fs.existsSync });
    redact = makeRedactor([token]);
    const api = makeClient({ fetchImpl: ctx.fetchImpl, token, sleep: ctx.sleep });
    return await RUNNERS[args.command](api, args, ctx);
  } catch (e) {
    if (e instanceof UsageError) {
      ctx.warn(`cfdns: ${e.message}`);
      return EXIT.USAGE;
    }
    if (e instanceof RefusedError) {
      ctx.warn(`cfdns: ${e.message}`);
      return EXIT.REFUSED;
    }
    ctx.warn(`cfdns: ${e instanceof CfError ? e.message : (e.stack || e.message)}`);
    return EXIT.API;
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const a = path.resolve(process.argv[1]);
  const b = fileURLToPath(import.meta.url);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
})();
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
