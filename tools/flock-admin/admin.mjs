#!/usr/bin/env node
// ---------------------------------------------------------------------------
// flock-admin: Flock's admin routes from a terminal, with an admin access key.
// ---------------------------------------------------------------------------
// The admin routes take a signed-in admin, and an admin access key
// (backend/middleware/adminKeys.js) is a second credential for the admin
// routes it lists. This tool reads the key from a file on this computer and
// calls those routes, so admin work does not need a browser where the owner is
// signed in. README.md beside this file says how a key is minted, where it is
// kept, how it is revoked and what it cannot do.
//
// Plain Node 18 or later, no packages. The key is never printed: every line
// this tool writes goes through scrub() first, and nothing it sends carries
// the key anywhere but the Authorization header of an https request to the
// API (or plain http to this machine, for a local server).
//
// Every write needs --yes. Without it the tool says what it would do, sends
// nothing that changes anything, and exits 3.
//
// Exit codes: 0 done, 1 the API refused or failed, 2 the command line was
// wrong, 3 a write that was not confirmed with --yes.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_API = 'https://api.flockcorp.com';
export const KEY_FILE = path.join(os.homedir(), '.secrets', 'flock', 'flock-admin-key');
export const EXIT = Object.freeze({ ok: 0, api: 1, usage: 2, confirm: 3 });

const KEY_SHAPE = /^flk_admin_[A-Za-z0-9_-]{43}$/;
const KEY_ANYWHERE = /flk_admin_[A-Za-z0-9_-]{8,}/g;
const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const JWT_ANYWHERE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const REQUEST_TIMEOUT_MS = 60000;
// --all on the waitlist stops after this many batches of up to 100 emails.
const WAITLIST_MAX_BATCHES = 50;

const HUB_WORDS_FILE = fileURLToPath(new URL('../../frontend/src/lib/moneyHubSummary.js', import.meta.url));

export class UsageError extends Error {}
export class ConfirmNeeded extends Error {}
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// What leaves this process on stdout or stderr never carries a key or a
// session token, whatever the API or an error put in it.
export function scrub(text) {
  return String(text).replace(KEY_ANYWHERE, '[admin key]').replace(JWT_ANYWHERE, '[session token]');
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

const BOOLEAN_FLAGS = new Set(['yes', 'dry-run', 'json', 'all', 'help', 'replace', 'verified', 'credit', 'stopped', 'wait']);
// How often mint --wait asks whether the key was approved, and how long past
// the approval link's own deadline it keeps asking.
const APPROVAL_POLL_MS = 10000;
const APPROVAL_GRACE_MS = 30000;
const VALUE_FLAGS = new Set([
  'api', 'name', 'days', 'vendor', 'product', 'category', 'kind', 'cadence', 'amount', 'amount-cents', 'currency',
  'last-charged', 'renews', 'ends', 'note', 'replaces-line',
]);

// `--name value` or `--name=value`, and the boolean flags alone. Anything
// else that starts with a dash is refused rather than guessed at.
export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (a === '--') {
      positionals.push(...argv.slice(i + 1).map(String));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        if (eq > 0) throw new UsageError(`--${name} takes no value.`);
        flags[name] = true;
        continue;
      }
      if (!VALUE_FLAGS.has(name)) throw new UsageError(`There is no option --${name}. Run with --help for the list.`);
      if (Object.prototype.hasOwnProperty.call(flags, name)) throw new UsageError(`--${name} was given twice.`);
      let value;
      if (eq > 0) value = a.slice(eq + 1);
      else {
        value = argv[i + 1];
        i += 1;
      }
      if (value === undefined || (eq < 0 && String(value).startsWith('--'))) throw new UsageError(`--${name} needs a value.`);
      flags[name] = String(value);
      continue;
    }
    if (a.startsWith('-') && a !== '-') throw new UsageError(`Options are written --name, so ${a} means nothing here.`);
    positionals.push(a);
  }
  return { positionals, flags };
}

// The API's address: https, or plain http to this machine for a local
// server. The key is never sent anywhere else, and never to a path a typo
// could point at another service.
export function apiBase(flags = {}, env = process.env) {
  const raw = flags.api || env.FLOCK_API_URL || DEFAULT_API;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError(`The API address must be a URL, such as ${DEFAULT_API}.`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) {
    throw new UsageError('The key is sent only to an https address, or to http on this machine.');
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    throw new UsageError('The API address is the origin alone, such as https://api.flockcorp.com, with no path.');
  }
  return u.origin;
}

// A path `get` may read: /api/admin and below, plain segments, and a query
// string rebuilt from its parts.
export function adminPath(input) {
  if (typeof input !== 'string' || input.trim() === '') throw new UsageError('get needs a path, such as /api/admin/money.');
  const p = input.trim();
  const q = p.indexOf('?');
  const pathname = q >= 0 ? p.slice(0, q) : p;
  const query = q >= 0 ? p.slice(q + 1) : '';
  if (!/^\/api\/admin(?:\/[A-Za-z0-9_-]+)*\/?$/.test(pathname)) {
    throw new UsageError('get reads /api/admin paths only, such as /api/admin/money or /api/admin/expenses.');
  }
  if (!query) return pathname;
  const params = new URLSearchParams(query);
  const rebuilt = params.toString();
  return rebuilt ? `${pathname}?${rebuilt}` : pathname;
}

// ---------------------------------------------------------------------------
// The key file
// ---------------------------------------------------------------------------

// A key written by Notepad, by PowerShell's `>` (UTF-16) or by Set-Content
// (ANSI) all read back as the same text.
function decodeKeyFile(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buf.toString('utf8').replace(/^﻿/, '');
}

export function keyFilePath(env = process.env) {
  return env.FLOCK_ADMIN_KEY_FILE || KEY_FILE;
}

// The key, from FLOCK_ADMIN_KEY or the key file. A message about a bad key
// names where it came from, never what it holds.
export function readKey(env = process.env) {
  if (env.FLOCK_ADMIN_KEY) {
    const key = env.FLOCK_ADMIN_KEY.trim();
    if (!KEY_SHAPE.test(key)) throw new UsageError('FLOCK_ADMIN_KEY does not hold an admin key (flk_admin_ and 43 more characters).');
    return { key, source: 'env' };
  }
  const file = keyFilePath(env);
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new UsageError(`No admin key at ${file}. Mint one (tools/flock-admin/README.md), or set FLOCK_ADMIN_KEY.`);
    }
    throw new UsageError(`The key file ${file} could not be read (${err.code || err.message}).`);
  }
  const key = decodeKeyFile(buf).trim();
  if (!KEY_SHAPE.test(key)) throw new UsageError(`${file} does not hold an admin key (flk_admin_ and 43 more characters).`);
  return { key, source: 'file', file };
}

// Writes the key file with only this account able to read it, through a
// temporary file so a half-written key never sits in place.
export function writeKeyFile(file, key, { replace = false } = {}) {
  if (!KEY_SHAPE.test(key)) throw new UsageError('That is not an admin key, so nothing was saved.');
  if (fs.existsSync(file) && !replace) {
    throw new UsageError(`${file} already holds a key. Run again with --replace to overwrite it, after revoking the old one if it is still live.`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${key}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows keeps the profile folder's own permissions */ }
}

// ---------------------------------------------------------------------------
// Talking to the API
// ---------------------------------------------------------------------------

async function call(ctx, method, p, { body, bearer } = {}) {
  const headers = {
    Authorization: `Bearer ${bearer || ctx.key}`,
    Accept: 'application/json',
    'User-Agent': 'flock-admin/1',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await ctx.fetch(`${ctx.base}${p}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // A redirect is never followed: the key goes to the address it was
      // given and nowhere else.
      redirect: 'error',
      signal: AbortSignal.timeout(ctx.timeoutMs || REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const why = err && err.name === 'TimeoutError' ? 'it did not answer in time' : (err && err.message) || 'the request failed';
    throw new ApiError(`Could not reach ${ctx.base}: ${why}.`, 0, null);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const said = json && typeof json.error === 'string' ? json.error : `The API answered ${res.status}.`;
    throw new ApiError(said, res.status, json);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

// A time as a calendar day. A bare YYYY-MM-DD (a bill's renewal) is that day
// wherever this runs: read as a time it is UTC midnight, the day before here.
function day(value) {
  if (!value) return 'never';
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  const d = ymd ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])) : new Date(value);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function dollars(cents, currency = 'USD') {
  if (!Number.isFinite(cents)) return 'unknown';
  const text = (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'USD' ? `${cents < 0 ? '-' : ''}$${text}` : `${cents < 0 ? '-' : ''}${text} ${currency}`;
}

const CADENCE_WORDS = { monthly: 'a month', quarterly: 'a quarter', yearly: 'a year', usage: 'a month, usage', one_time: 'once' };

function table(rows) {
  const widths = [];
  for (const r of rows) r.forEach((c, i) => { widths[i] = Math.max(widths[i] || 0, String(c).length); });
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? String(c) : String(c).padEnd(widths[i]))).join('  ').trimEnd()).join('\n');
}

// The dashboard's own words for the money hub (frontend/src/lib/moneyHubSummary.js):
// plain JavaScript with no imports, loaded as a module straight from its text,
// so this tool prints exactly what the Overview draws.
export async function loadHubWords(file = HUB_WORDS_FILE) {
  const src = fs.readFileSync(file, 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(src, 'utf8').toString('base64')}`);
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

const HELP = `flock-admin: Flock's admin routes with an admin access key.

  node tools/flock-admin/admin.mjs <command> [options]

Reading:
  status                       who the key acts as, and when it expires
  money                        the money hub: the month's four figures and what needs you
  expenses list                every bill on the expense list
  get <path>                   any /api/admin path, as JSON, such as /api/admin/costs

Writing (each needs --yes; without it, nothing is sent):
  expenses stop <id> --yes     mark a bill as no longer charged
  expenses add --vendor V --amount 12.34 --kind tooling --cadence monthly --yes
      [--product P] [--category C] [--currency USD] [--last-charged YYYY-MM-DD]
      [--renews YYYY-MM-DD] [--ends YYYY-MM-DD] [--note N] [--replaces-line ID]
      [--verified] [--credit] [--stopped]
  waitlist announce --dry-run  how many are waiting for the launch email
  waitlist announce --yes      send it to the next batch of up to 100 (--all: keep going)
  revoke --yes                 revoke this key, then delete the key file

The key:
  mint --name N [--days 90] --yes [--wait]
                               mint a key with a session token piped in, and save it.
                               From a session older than 15 minutes the key is pending
                               until Approve is tapped in the email; --wait waits for that
  key save [<file>]            save a key piped in, or moved from a downloaded file

Options:
  --api <url>    the API (default ${DEFAULT_API}, or FLOCK_API_URL)
  --json         print the API's answer as JSON
  --yes          confirm a write

The key is read from ${KEY_FILE} or from FLOCK_ADMIN_KEY. It is never printed.
`;

function needYes(flags, words) {
  if (!flags.yes) throw new ConfirmNeeded(`${words} Nothing was sent. Run it again with --yes to do it.`);
}

async function cmdStatus(ctx) {
  const who = await call(ctx, 'GET', '/api/admin/whoami');
  if (ctx.flags.json) return ctx.printJson(who);
  if (!who || who.authVia !== 'admin_key' || !who.key) {
    ctx.print(`Signed in as ${who && who.user ? who.user.name : 'unknown'}, but not with an admin key.`);
    return EXIT.ok;
  }
  const k = who.key;
  ctx.print(`Admin key "${k.name}" (key ${k.id}), acting as ${who.user.name} (user ${who.user.id}, ${who.user.role}).`);
  ctx.print(`It was made ${day(k.createdAt)} and expires ${day(k.expiresAt)}, in ${k.daysLeft} ${k.daysLeft === 1 ? 'day' : 'days'}. Scopes: ${(k.scopes || []).join(', ')}.`);
  if (k.daysLeft <= 14) ctx.print('It runs out soon. Mint a new key from a signed-in browser, then revoke this one.');
  return EXIT.ok;
}

async function cmdMoney(ctx) {
  const h = await call(ctx, 'GET', '/api/admin/money');
  let words = null;
  try {
    words = await loadHubWords(ctx.hubWordsFile);
  } catch (err) {
    ctx.warn(`The dashboard's words for the hub were not found (${ctx.hubWordsFile || HUB_WORDS_FILE}), so this is the payload's own figures.`);
  }
  const tiles = words
    ? words.hubMonthTiles(h)
    : [
      { label: 'Money in', value: dollars(h.net && h.net.revenueThisMonthCents) },
      { label: 'Costs', value: dollars(h.net && h.net.costsThisMonthCents) },
      { label: 'Profit or loss', value: dollars(h.net && h.net.netThisMonthCents) },
      { label: 'Monthly bills', value: dollars(h.net && h.net.burnCents) },
    ];
  const needs = words ? words.hubAttention(h).problems : [];
  if (ctx.flags.json) {
    return ctx.printJson({
      month: h.month || null,
      generatedAt: h.generatedAt || null,
      tiles: tiles.map(({ label, value, sub }) => ({ label, value, sub: sub || null })),
      needs: needs.map(({ key, tone, label, value, note }) => ({ key, tone, label, value, note })),
    });
  }
  const m = h.month || {};
  const at = h.generatedAt ? new Date(h.generatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null;
  ctx.print(`${m.label || 'This month'}, day ${m.dayOfMonth} of ${m.daysInMonth}, New York time.${at ? ` Read at ${at}.` : ''}`);
  ctx.print('');
  ctx.print(table(tiles.map((t) => [`  ${t.label}`, t.value, t.sub || ''])));
  ctx.print('');
  if (!words) return EXIT.ok;
  if (needs.length === 0) {
    ctx.print('Nothing needs you.');
    return EXIT.ok;
  }
  ctx.print(`${needs.length} ${needs.length === 1 ? 'thing needs' : 'things need'} you:`);
  for (const p of needs) {
    ctx.print(`  ${p.tone === 'bad' ? '[bad] ' : '[warn]'} ${p.label}: ${p.value}`);
    if (p.note) ctx.print(`         ${p.note}`);
  }
  return EXIT.ok;
}

function expenseLine(x) {
  const name = x.product ? `${x.vendor}, ${x.product}` : x.vendor;
  const amount = `${dollars(x.isCredit ? -x.amountCents : x.amountCents, x.currency)} ${CADENCE_WORDS[x.cadence] || x.cadence}`;
  const state = !x.active ? 'stopped' : x.endsOn ? `ends ${day(x.endsOn)}` : 'running';
  const when = x.renewsOn ? `renews ${day(x.renewsOn)}` : x.lastChargedOn ? `last charged ${day(x.lastChargedOn)}` : '';
  return [String(x.id), name, amount, state, when];
}

async function cmdExpensesList(ctx) {
  const r = await call(ctx, 'GET', '/api/admin/expenses');
  if (ctx.flags.json) return ctx.printJson(r);
  const rows = (r && Array.isArray(r.expenses)) ? r.expenses : [];
  if (rows.length === 0) {
    ctx.print('Nothing on the expense list.');
    return EXIT.ok;
  }
  ctx.print(table([['id', 'bill', 'amount', 'state', ''], ...rows.map(expenseLine)]));
  return EXIT.ok;
}

// The row as the expense routes take it back: the same fields, minus the two
// the server owns.
function expenseBody(x) {
  const { id, updatedAt, ...rest } = x;
  return rest;
}

async function cmdExpensesStop(ctx, idText) {
  if (!/^\d+$/.test(String(idText || ''))) throw new UsageError('expenses stop needs the bill\'s id, a whole number from expenses list.');
  const id = Number(idText);
  const r = await call(ctx, 'GET', '/api/admin/expenses');
  const row = ((r && r.expenses) || []).find((x) => Number(x.id) === id);
  if (!row) throw new ApiError(`No bill ${id} is on the expense list.`, 404, null);
  const name = row.product ? `${row.vendor}, ${row.product}` : row.vendor;
  if (!row.active) {
    ctx.print(`Bill ${id} (${name}) is already marked as stopped.`);
    return EXIT.ok;
  }
  needYes(ctx.flags, `Would mark bill ${id} (${name}) as no longer charged.`);
  const saved = await call(ctx, 'PUT', `/api/admin/expenses/${id}`, { body: { ...expenseBody(row), active: false } });
  if (ctx.flags.json) return ctx.printJson(saved);
  ctx.print(`Bill ${id} (${name}) is marked as stopped.`);
  return EXIT.ok;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function expenseFromFlags(flags) {
  for (const need of ['vendor', 'kind', 'cadence']) {
    if (!flags[need]) throw new UsageError(`expenses add needs --${need}.`);
  }
  if (!flags.amount && !flags['amount-cents']) throw new UsageError('expenses add needs --amount in dollars, such as 12.34.');
  if (flags.amount && flags['amount-cents']) throw new UsageError('Give --amount or --amount-cents, not both.');
  const body = { vendor: flags.vendor, kind: flags.kind, cadence: flags.cadence };
  if (flags.amount) body.amount = flags.amount;
  if (flags['amount-cents']) {
    if (!/^\d+$/.test(flags['amount-cents'])) throw new UsageError('--amount-cents is a whole number of cents.');
    body.amountCents = Number(flags['amount-cents']);
  }
  for (const [flag, field] of [['product', 'product'], ['category', 'category'], ['currency', 'currency'], ['note', 'note'], ['replaces-line', 'replacesLine']]) {
    if (flags[flag] !== undefined) body[field] = flags[flag];
  }
  for (const [flag, field] of [['last-charged', 'lastChargedOn'], ['renews', 'renewsOn'], ['ends', 'endsOn']]) {
    if (flags[flag] === undefined) continue;
    if (!YMD.test(flags[flag])) throw new UsageError(`--${flag} is a date, YYYY-MM-DD.`);
    body[field] = flags[flag];
  }
  if (flags.verified) body.verified = true;
  if (flags.credit) body.isCredit = true;
  if (flags.stopped) body.active = false;
  return body;
}

function confirmAdd(flags) {
  const body = expenseFromFlags(flags);
  const amount = body.amount !== undefined ? `$${body.amount}` : dollars(body.amountCents);
  needYes(flags, `Would add ${body.vendor}${body.product ? `, ${body.product}` : ''}: ${amount} ${CADENCE_WORDS[body.cadence] || body.cadence}, ${body.kind}.`);
  return body;
}

async function cmdExpensesAdd(ctx) {
  const body = confirmAdd(ctx.flags);
  const saved = await call(ctx, 'POST', '/api/admin/expenses', { body });
  if (ctx.flags.json) return ctx.printJson(saved);
  const x = saved && saved.expense;
  ctx.print(x ? `Added bill ${x.id}: ${expenseLine(x).slice(1, 3).join(', ')}.` : 'Added.');
  return EXIT.ok;
}

function batchWords(r) {
  const parts = [`sent ${r.sent}`];
  if (r.suppressed) parts.push(`${r.suppressed} skipped as unmailable`);
  if (r.failed) parts.push(`${r.failed} turned down and left for the next run`);
  if (r.unknown) parts.push(`${r.unknown} with no word from the mail service (waitlist ids ${(r.unknown_ids || []).join(', ')}; check them in the provider's log)`);
  return `${parts.join(', ')}. ${r.remaining} still waiting.`;
}

function confirmAnnounce(flags) {
  if (!flags.yes) {
    throw new ConfirmNeeded('waitlist announce sends the launch email. Run it with --dry-run to see how many are waiting, or --yes to send. Nothing was sent.');
  }
}

async function cmdWaitlistAnnounce(ctx) {
  if (ctx.flags['dry-run']) {
    const r = await call(ctx, 'POST', '/api/admin/waitlist/announce', { body: { dry_run: true } });
    if (ctx.flags.json) return ctx.printJson(r);
    ctx.print(`${r.pending} waiting for the launch email. ${r.announced} already sent, ${r.converted} already have an account, ${r.total} on the waitlist in all.`);
    return EXIT.ok;
  }
  confirmAnnounce(ctx.flags);
  const all = [];
  for (let n = 1; n <= (ctx.flags.all ? WAITLIST_MAX_BATCHES : 1); n += 1) {
    const r = await call(ctx, 'POST', '/api/admin/waitlist/announce', { body: {} });
    all.push(r);
    if (!ctx.flags.json) ctx.print(`Batch ${n}: ${batchWords(r)}`);
    if (r.stopped_early) {
      if (!ctx.flags.json) ctx.print('The server stopped the batch: the mail service stopped answering. Run it again once mail is going out.');
      break;
    }
    const moved = (r.sent || 0) + (r.suppressed || 0) + (r.unknown || 0);
    if (r.remaining === 0 || r.batch === 0 || moved === 0) break;
  }
  if (ctx.flags.json) return ctx.printJson(all);
  return EXIT.ok;
}

async function cmdGet(ctx, p) {
  const r = await call(ctx, 'GET', adminPath(p));
  ctx.printJson(r);
  return EXIT.ok;
}

async function cmdRevoke(ctx) {
  const who = await call(ctx, 'GET', '/api/admin/whoami');
  if (!who || !who.key) throw new ApiError('The API did not say which key this is.', 0, who);
  needYes(ctx.flags, `Would revoke admin key "${who.key.name}" (key ${who.key.id}), so it stops working everywhere.`);
  await call(ctx, 'DELETE', `/api/admin/keys/${who.key.id}`);
  ctx.print(`Admin key "${who.key.name}" (key ${who.key.id}) is revoked.`);
  if (ctx.keySource === 'file' && ctx.keyFile) {
    fs.rmSync(ctx.keyFile, { force: true });
    ctx.print(`Deleted ${ctx.keyFile}.`);
  }
  return EXIT.ok;
}

async function readStdin(stdin) {
  if (!stdin || stdin.isTTY) return null;
  let text = '';
  for await (const chunk of stdin) {
    text += typeof chunk === 'string' ? chunk : decodeKeyFile(Buffer.from(chunk));
    if (text.length > 16384) break;
  }
  return text.replace(/^﻿/, '').trim();
}

async function cmdMint(ctx) {
  if (!ctx.flags.name) throw new UsageError('mint needs --name, a few words for where the key will live, such as "PC tools".');
  let days;
  if (ctx.flags.days !== undefined) {
    if (!/^\d+$/.test(ctx.flags.days)) throw new UsageError('--days is a whole number from 1 to 180.');
    days = Number(ctx.flags.days);
  }
  const file = keyFilePath(ctx.env);
  if (fs.existsSync(file) && !ctx.flags.replace) {
    throw new UsageError(`${file} already holds a key. Run again with --replace to overwrite it, after revoking the old one if it is still live.`);
  }
  needYes(ctx.flags, `Would mint an admin key named "${ctx.flags.name}"${days ? ` for ${days} days` : ''} and save it to ${file}.`);
  const token = await readStdin(ctx.stdin);
  if (!token) {
    throw new UsageError('Pipe the session token in. In the signed-in browser console: copy(localStorage.getItem(\'flockToken\')). Then: Get-Clipboard | node tools/flock-admin/admin.mjs mint --name "PC tools" --yes');
  }
  if (!JWT_SHAPE.test(token)) throw new UsageError('What was piped in is not a session token, so nothing was sent.');
  const minted = await call(ctx, 'POST', '/api/admin/keys', { bearer: token, body: { name: ctx.flags.name, ...(days ? { days } : {}) } });
  if (!minted || !KEY_SHAPE.test(String(minted.key || ''))) throw new ApiError('The API answered without a key.', 0, null);
  // Saved whether it works yet or not: the API shows a key once.
  writeKeyFile(file, minted.key, { replace: !!ctx.flags.replace });
  if (minted.pending) {
    const to = minted.approval && minted.approval.sentTo ? ` sent to ${minted.approval.sentTo}` : '';
    const until = minted.approval && minted.approval.expiresAt
      ? ` The link expires at ${new Date(minted.approval.expiresAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`
      : '';
    ctx.print(`Minted admin key "${minted.name}" (key ${minted.id}), pending: tap Approve in the email${to}. It does nothing until then.${until}`);
    ctx.print(`Saved to ${file}. The key was not shown, and the API will not show it again.`);
    if (!ctx.flags.wait) return EXIT.ok;
    return waitForApproval(ctx, minted);
  }
  ctx.print(`Minted admin key "${minted.name}" (key ${minted.id}). It expires ${day(minted.expiresAt)}.`);
  ctx.print(`Saved to ${file}. The key was not shown, and the API will not show it again.`);
  return EXIT.ok;
}

// Asks whoami with the new key until it answers: 403 "awaiting approval" means
// keep waiting, 200 means approved, anything else means it never will be.
async function waitForApproval(ctx, minted) {
  ctx.key = minted.key;
  const linkDeadline = minted.approval && Date.parse(minted.approval.expiresAt);
  const deadline = Number.isFinite(linkDeadline)
    ? linkDeadline + APPROVAL_GRACE_MS
    : Date.now() + 15 * 60 * 1000 + APPROVAL_GRACE_MS;
  const pollMs = ctx.pollMs || APPROVAL_POLL_MS;
  ctx.print('Waiting for the approval, for up to 15 minutes.');
  for (;;) {
    try {
      await call(ctx, 'GET', '/api/admin/whoami');
      ctx.print(`Approved. The key works now, until ${day(minted.expiresAt)}.`);
      return EXIT.ok;
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      const waiting = err.status === 403 && err.body && err.body.adminKeyPending === true;
      // A dropped connection says nothing about the key; ask again.
      if (!waiting && err.status !== 0) {
        ctx.warn(`The key will not work: ${err.message}`);
        return EXIT.api;
      }
    }
    if (Date.now() + pollMs > deadline) {
      ctx.warn('No approval came before the link expired, so the key will never work. Mint a new one to try again.');
      return EXIT.api;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function cmdKeySave(ctx, from) {
  const file = keyFilePath(ctx.env);
  let key;
  if (from) {
    let buf;
    try {
      buf = fs.readFileSync(from);
    } catch (err) {
      throw new UsageError(`${from} could not be read (${err.code || err.message}).`);
    }
    key = decodeKeyFile(buf).trim();
  } else {
    key = await readStdin(ctx.stdin);
    if (!key) throw new UsageError('Pipe the key in, or name the downloaded key file: key save <file>.');
  }
  if (!KEY_SHAPE.test(key)) throw new UsageError(`${from || 'What was piped in'} does not hold an admin key, so nothing was saved.`);
  if (from && path.resolve(from) === path.resolve(file)) {
    ctx.print(`${file} already holds that key.`);
    return EXIT.ok;
  }
  writeKeyFile(file, key, { replace: !!ctx.flags.replace });
  ctx.print(`Saved the key to ${file}.`);
  // The downloaded copy is a second copy of a secret, so it goes once the
  // saved one is in place.
  if (from) {
    fs.rmSync(from, { force: true });
    ctx.print(`Deleted ${from}, the downloaded copy.`);
  }
  return EXIT.ok;
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

// `io` is for tests: { env, stdout, stderr, stdin, fetch, hubWordsFile }.
export async function main(argv, io = {}) {
  const env = io.env || process.env;
  const stdout = io.stdout || ((s) => process.stdout.write(s));
  const stderr = io.stderr || ((s) => process.stderr.write(s));
  const print = (s = '') => stdout(`${scrub(s)}\n`);
  const warn = (s) => stderr(`${scrub(s)}\n`);
  try {
    const { positionals, flags } = parseArgs(argv);
    const [command, sub, arg] = positionals;
    if (flags.help || !command || command === 'help') {
      print(HELP);
      return command || flags.help ? EXIT.ok : EXIT.usage;
    }
    const ctx = {
      env,
      flags,
      base: apiBase(flags, env),
      fetch: io.fetch || globalThis.fetch,
      stdin: io.stdin === undefined ? process.stdin : io.stdin,
      hubWordsFile: io.hubWordsFile,
      timeoutMs: io.timeoutMs,
      pollMs: io.pollMs,
      print,
      warn,
      printJson: (v) => { print(JSON.stringify(v, null, 2)); return EXIT.ok; },
    };
    // The two commands that make a key run before any key is read.
    if (command === 'mint') return await cmdMint(ctx);
    if (command === 'key') {
      if (sub !== 'save') throw new UsageError('key has one subcommand: key save [<file>].');
      return await cmdKeySave(ctx, arg);
    }
    const known = {
      status: () => cmdStatus(ctx),
      money: () => cmdMoney(ctx),
      get: () => cmdGet(ctx, sub),
      revoke: () => cmdRevoke(ctx),
      expenses: () => {
        if (sub === 'list') return cmdExpensesList(ctx);
        if (sub === 'stop') return cmdExpensesStop(ctx, arg);
        if (sub === 'add') return cmdExpensesAdd(ctx);
        throw new UsageError('expenses takes list, stop <id> or add.');
      },
      waitlist: () => {
        if (sub === 'announce') return cmdWaitlistAnnounce(ctx);
        throw new UsageError('waitlist takes announce.');
      },
    };
    if (!Object.prototype.hasOwnProperty.call(known, command)) throw new UsageError(`There is no command ${command}. Run with --help for the list.`);
    // What can be refused from the command line alone is refused before the
    // key is read or anything is sent.
    if (command === 'get') adminPath(sub);
    if (command === 'expenses' && sub === 'add') confirmAdd(flags);
    if (command === 'waitlist' && sub === 'announce' && !flags['dry-run']) confirmAnnounce(flags);
    const { key, source, file } = readKey(env);
    ctx.key = key;
    ctx.keySource = source;
    ctx.keyFile = file;
    return await known[command]();
  } catch (err) {
    if (err instanceof UsageError) {
      warn(err.message);
      return EXIT.usage;
    }
    if (err instanceof ConfirmNeeded) {
      warn(err.message);
      return EXIT.confirm;
    }
    if (err instanceof ApiError) {
      warn(err.status ? `Refused (${err.status}): ${err.message}` : err.message);
      return EXIT.api;
    }
    warn(`Failed: ${err && err.message ? err.message : String(err)}`);
    return EXIT.api;
  }
}

// Run as a program, not when a test imports it. Both sides are real paths,
// compared without case on Windows, so a junction or a lower-case drive letter
// on the command line still counts.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    const run = fs.realpathSync(path.resolve(process.argv[1]));
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? run.toLowerCase() === self.toLowerCase() : run === self;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
