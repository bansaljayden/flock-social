// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// PLANNING ROUTES — budget.js, calendar.js, availability.js
// ---------------------------------------------------------------------------
// The three user-facing surfaces that had never been audited: the per-flock
// spending range and its Skip flow, a person's own calendar entries, and the
// availability pulse friends read to see who is free tonight.
//
// WHAT THIS FILE IS FOR, AND WHY IT DOES NOT REUSE THE EXISTING HARNESSES.
//
// authShapeGuards.test.js already sweeps every scalar field on calendar and
// availability for arrays and objects, and coordAuthz.test.js already pins the
// INT4 ceiling on /api/budget/:flockId. Both prove a request is REFUSED before
// any query runs, and both answer `{ rows: [] }` to everything else — which is
// exactly right for what they test and useless for everything below, because a
// route that never gets a row back never reaches the code that mishandles one.
//
// So this harness stores rows, and it makes the fake behave like the COLUMN:
//   * event_date is a DATE — an unreal day like 2026-02-31 raises 22008, and a
//     stored DATE comes back the way node-postgres actually returns one, a JS
//     Date at LOCAL midnight (verified against pg-types' 1082 parser);
//   * title/venue/time_label/color are VARCHAR(120/200/20/30) — one character
//     over raises 22001;
//   * budget_submissions.amount is DECIMAL(8,2) — it rounds half-away-from-zero
//     on the DECIMAL TEXT, not on a JS float, and it comes back a STRING;
//   * availability_pulses.status is VARCHAR(10) behind a CHECK.
//
// THE FIXTURE READS THE SQL. A recent agent's fixture applied a limit, an
// ordering and a filter no matter what the query said, so three mutations
// stayed green against code that had stopped asking for them. Every WHERE in
// this file is derived from the statement text: `whereMatcher` parses the
// clause the route actually sent, so deleting `AND user_id = $2` from a query
// changes what comes back and the test goes red. The one place that cannot be
// generic — the COUNT(*) FILTER (WHERE ...) aggregate, whose first WHERE is not
// the row filter — is handled explicitly and is not an authorization boundary.
//
// BASELINE. At the time of writing `node --test` stands at 1 failure, in
// __tests__/authFieldBounds.test.js against routes/auth.js, which another agent
// holds. Nothing in this file touches it.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const express = require('express');

process.env.JWT_SECRET = 'planning-routes-test-secret';
process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// The child-process probe (see "Timezone" below) re-executes this same file
// with a different TZ. It must not register the suite when it does.
// ---------------------------------------------------------------------------
const TZ_PROBE = process.env.PLANNING_TZ_PROBE;

const pool = require('../config/database');
const pushHelper = require('../services/pushHelper');

// ---------------------------------------------------------------------------
// Fake Postgres
// ---------------------------------------------------------------------------
function pgErr(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// DATE (oid 1082). Postgres accepts `YYYY-MM-DD` (and the basic `YYYYMMDD`),
// rejects a day that does not exist (22008) and anything else (22007), and
// there is no year zero. node-postgres then parses the result back with
// pg-types' 1082 parser, which builds `new Date(y, m - 1, d)` — LOCAL midnight.
function pgDate(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) || /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) throw pgErr('22007', `invalid input syntax for type date: "${s}"`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1 || mo < 1 || mo > 12 || d < 1 ||
      probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw pgErr('22008', `date/time field value out of range: "${s}"`);
  }
  const local = new Date(2000, 0, 1);
  local.setFullYear(y, mo - 1, d);
  local.setHours(0, 0, 0, 0);
  return local;
}

// A DATE parameter used in a comparison keeps its ordinal value only.
const dateKey = (d) => (d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d));

// NUMERIC(8,2). Postgres rounds the DECIMAL TEXT half away from zero — '1.005'
// becomes 1.01 — which is NOT what Math.round(1.005 * 100) / 100 gives, and is
// the whole reason this is modelled instead of assumed. Returns a string,
// because node-postgres returns NUMERIC as a string.
function pgNumeric82(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  if (/^[+-]?(\d+\.?\d*|\.\d+)[eE][+-]?\d+$/.test(s)) s = Number(s).toFixed(20);
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) {
    throw pgErr('22P02', `invalid input syntax for type numeric: "${v}"`);
  }
  const neg = m[1] === '-';
  const frac = `${m[3] || ''}000`;
  let cents = BigInt(m[2] || '0') * 100n + BigInt(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1n;
  if (cents >= 100000000n) throw pgErr('22003', 'numeric field overflow');
  const out = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
  return neg && cents !== 0n ? `-${out}` : out;
}

function pgVarchar(v, n, col) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    throw pgErr('42804', `column "${col}" is of type character varying but expression is of type text[]`);
  }
  const s = String(v);
  if ([...s].length > n) throw pgErr('22001', `value too long for type character varying(${n})`);
  return s;
}

const USERS = [
  { id: 1, email: 'ava@example.com', name: 'Ava', role: 'user', email_verified: true, is_banned: false, token_version: 0, profile_image_url: null },
  { id: 2, email: 'ben@example.com', name: 'Ben', role: 'user', email_verified: true, is_banned: false, token_version: 0, profile_image_url: null },
  { id: 3, email: 'cy@example.com', name: 'Cy', role: 'user', email_verified: true, is_banned: false, token_version: 0, profile_image_url: null },
  { id: 4, email: 'dee@example.com', name: 'Dee', role: 'user', email_verified: true, is_banned: false, token_version: 0, profile_image_url: null },
  { id: 5, email: 'eve@example.com', name: 'Eve', role: 'user', email_verified: true, is_banned: false, token_version: 0, profile_image_url: null },
];

let db;
let issued;    // every non-auth statement the routes sent
let calSeq;

function resetDb() {
  calSeq = 100;
  issued = [];
  db = {
    // flock 10: Ava is creator, budget on. flock 11: Ben's, Ava not a member.
    flocks: [
      { id: 10, creator_id: 1, name: 'Friday', budget_enabled: true, budget_locked: false, budget_ceiling: null, budget_context: 'dinner', ghost_mode_enabled: false, updated_at: new Date() },
      { id: 11, creator_id: 2, name: 'Private', budget_enabled: true, budget_locked: false, budget_ceiling: null, budget_context: 'drinks', ghost_mode_enabled: false, updated_at: new Date() },
      { id: 12, creator_id: 2, name: 'NoBudget', budget_enabled: false, budget_locked: false, budget_ceiling: null, budget_context: null, ghost_mode_enabled: false, updated_at: new Date() },
    ],
    flock_members: [
      { id: 1, flock_id: 10, user_id: 1, status: 'accepted' },
      { id: 2, flock_id: 10, user_id: 2, status: 'accepted' },
      { id: 3, flock_id: 10, user_id: 3, status: 'accepted' },
      { id: 4, flock_id: 10, user_id: 4, status: 'accepted' },
      { id: 5, flock_id: 11, user_id: 2, status: 'accepted' },
      { id: 6, flock_id: 12, user_id: 1, status: 'accepted' },
      { id: 7, flock_id: 12, user_id: 2, status: 'accepted' },
    ],
    budget_submissions: [],
    calendar_events: [],
    availability_pulses: [],
    // Ava <-> Ben are friends. Ava <-> Cy are not.
    friendships: [{ requester_id: 1, addressee_id: 2, status: 'accepted' }],
  };
}

// Derives a row predicate from the WHERE clause the route actually wrote.
function whereMatcher(sql, params) {
  const wh = /\bWHERE\b([\s\S]*?)(?:\bORDER BY\b|\bRETURNING\b|\bLIMIT\b|\bFOR UPDATE\b|$)/i.exec(sql);
  if (!wh) return () => true;
  const clause = wh[1];
  const preds = [];
  let m;

  const neq = /(\w+)\s*(?:!=|<>)\s*\$(\d+)/g;
  while ((m = neq.exec(clause))) {
    const col = m[1]; const idx = Number(m[2]) - 1;
    preds.push((r) => String(r[col]) !== String(params[idx]));
  }
  const stripped = clause.replace(/(\w+)\s*(?:!=|<>)\s*\$\d+/g, ' ');

  const eq = /(\w+)\s*=\s*\$(\d+)/g;
  while ((m = eq.exec(stripped))) {
    const col = m[1]; const idx = Number(m[2]) - 1;
    preds.push((r) => String(r[col]) === String(params[idx]));
  }
  const lit = /(\w+)\s*=\s*'([^']*)'/g;
  while ((m = lit.exec(stripped))) {
    const col = m[1]; const val = m[2];
    preds.push((r) => String(r[col]) === val);
  }
  const bool = /(\w+)\s*=\s*(true|false)\b/gi;
  while ((m = bool.exec(stripped))) {
    const col = m[1]; const val = m[2].toLowerCase() === 'true';
    preds.push((r) => r[col] === val);
  }
  const btw = /(\w+)\s+BETWEEN\s+\$(\d+)\s+AND\s+\$(\d+)/i.exec(stripped);
  if (btw) {
    const col = btw[1]; const lo = params[Number(btw[2]) - 1]; const hi = params[Number(btw[3]) - 1];
    preds.push((r) => dateKey(r[col]) >= dateKey(pgDate(lo)) && dateKey(r[col]) <= dateKey(pgDate(hi)));
  }
  const gte = /(\w+)\s*>=\s*\$(\d+)/g;
  while ((m = gte.exec(stripped))) {
    const col = m[1]; const v = params[Number(m[2]) - 1];
    preds.push((r) => dateKey(r[col]) >= dateKey(pgDate(v)));
  }
  const lte = /(\w+)\s*<=\s*\$(\d+)/g;
  while ((m = lte.exec(stripped))) {
    const col = m[1]; const v = params[Number(m[2]) - 1];
    preds.push((r) => dateKey(r[col]) <= dateKey(pgDate(v)));
  }
  // `expires_at > NOW()` — the only NOW() comparison these routes make.
  if (/expires_at\s*>\s*NOW\(\)/i.test(stripped)) {
    preds.push((r) => r.expires_at instanceof Date && r.expires_at.getTime() > Date.now());
  }
  return (r) => preds.every((p) => p(r));
}

function dispatch(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();

  if (/FROM users WHERE id = \$1/.test(sql) && /token_version/.test(sql)) {
    const u = USERS.find((x) => x.id === Number(params[0]));
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }
  if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [], rowCount: 0 };

  issued.push({ sql, params });
  const match = whereMatcher(sql, params);

  // ── calendar_events ──────────────────────────────────────────────────────
  if (/INSERT INTO calendar_events/i.test(sql)) {
    const cols = /INSERT INTO calendar_events \(([^)]*)\)/i.exec(sql)[1].split(',').map((c) => c.trim());
    const row = { id: ++calSeq, created_at: new Date(), updated_at: new Date() };
    cols.forEach((c, i) => { row[c] = params[i]; });
    row.title = pgVarchar(row.title, 120, 'title');
    if (row.title === null) throw pgErr('23502', 'null value in column "title" violates not-null constraint');
    row.venue = pgVarchar(row.venue, 200, 'venue');
    row.time_label = pgVarchar(row.time_label, 20, 'time_label');
    row.color = pgVarchar(row.color, 30, 'color');
    row.event_date = pgDate(row.event_date);
    if (row.event_date === null) throw pgErr('23502', 'null value in column "event_date" violates not-null constraint');
    db.calendar_events.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (/UPDATE calendar_events/i.test(sql)) {
    const setPart = /SET([\s\S]*?)WHERE/i.exec(sql)[1];
    const assigns = [];
    const re = /(\w+)\s*=\s*COALESCE\(\$(\d+),\s*\w+\)/g;
    let m;
    while ((m = re.exec(setPart))) assigns.push([m[1], Number(m[2]) - 1]);
    const hit = db.calendar_events.filter(match);
    for (const row of hit) {
      for (const [col, idx] of assigns) {
        const v = params[idx];
        if (v === null || v === undefined) continue;
        if (col === 'event_date') row[col] = pgDate(v);
        else if (col === 'title') row[col] = pgVarchar(v, 120, 'title');
        else if (col === 'venue') row[col] = pgVarchar(v, 200, 'venue');
        else if (col === 'time_label') row[col] = pgVarchar(v, 20, 'time_label');
        else if (col === 'color') row[col] = pgVarchar(v, 30, 'color');
        else row[col] = v;
      }
      row.updated_at = new Date();
    }
    return { rows: hit, rowCount: hit.length };
  }
  if (/DELETE FROM calendar_events/i.test(sql)) {
    const hit = db.calendar_events.filter(match);
    db.calendar_events = db.calendar_events.filter((r) => !hit.includes(r));
    return { rows: hit, rowCount: hit.length };
  }
  if (/FROM calendar_events/i.test(sql)) {
    let rows = db.calendar_events.filter(match);
    if (/ORDER BY event_date/i.test(sql)) {
      rows = [...rows].sort((a, b) => dateKey(a.event_date).localeCompare(dateKey(b.event_date)));
    }
    return { rows, rowCount: rows.length };
  }

  // ── availability_pulses ──────────────────────────────────────────────────
  if (/INSERT INTO availability_pulses/i.test(sql)) {
    const [userId, status, note, expires] = params;
    const s = pgVarchar(status, 10, 'status');
    if (!['down', 'maybe', 'not'].includes(s)) {
      throw pgErr('23514', 'new row violates check constraint "availability_pulses_status_check"');
    }
    const row = { user_id: Number(userId), status: s, note: note === null ? null : String(note), set_at: new Date(), expires_at: expires };
    db.availability_pulses = db.availability_pulses.filter((r) => r.user_id !== row.user_id);
    db.availability_pulses.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (/DELETE FROM availability_pulses/i.test(sql)) {
    const hit = db.availability_pulses.filter(match);
    db.availability_pulses = db.availability_pulses.filter((r) => !hit.includes(r));
    return { rows: hit, rowCount: hit.length };
  }
  if (/FROM friendships/i.test(sql) && /availability_pulses/i.test(sql)) {
    // GET /friends. Every clause below is read out of the statement rather than
    // assumed, so dropping one from the route changes what comes back:
    //   * the accepted-only filter,
    //   * the expiry filter,
    //   * the status ranking in the ORDER BY, whose numbers are parsed from the
    //     CASE the route actually wrote.
    const me = Number(params[0]);
    const acceptedOnly = /f\.status\s*=\s*'accepted'/i.test(sql);
    const liveOnly = /expires_at\s*>\s*NOW\(\)/i.test(sql);
    const rows = [];
    for (const f of db.friendships) {
      if (acceptedOnly && f.status !== 'accepted') continue;
      if (f.requester_id !== me && f.addressee_id !== me) continue;
      const other = f.requester_id === me ? f.addressee_id : f.requester_id;
      const p = db.availability_pulses.find((x) => x.user_id === other);
      if (!p) continue;
      if (liveOnly && !(p.expires_at instanceof Date && p.expires_at.getTime() > Date.now())) continue;
      const u = USERS.find((x) => x.id === other);
      rows.push({ id: u.id, name: u.name, profile_image_url: u.profile_image_url, status: p.status, note: p.note, set_at: p.set_at, expires_at: p.expires_at });
    }
    const caseClause = /ORDER BY[\s\S]*?CASE ap\.status([\s\S]*?)END/i.exec(sql);
    if (caseClause) {
      const rank = {};
      let w; const wre = /WHEN '(\w+)' THEN (\d+)/g;
      while ((w = wre.exec(caseClause[1]))) rank[w[1]] = Number(w[2]);
      const fallback = Number((/ELSE (\d+)/.exec(caseClause[1]) || [])[1] ?? 99);
      rows.sort((a, b) => (rank[a.status] ?? fallback) - (rank[b.status] ?? fallback));
    }
    return { rows, rowCount: rows.length };
  }
  if (/FROM availability_pulses/i.test(sql)) {
    const rows = db.availability_pulses.filter(match);
    return { rows, rowCount: rows.length };
  }
  if (/FROM friendships/i.test(sql)) {
    const me = Number(params[0]);
    const rows = db.friendships
      .filter((f) => f.status === 'accepted' && (f.requester_id === me || f.addressee_id === me))
      .map((f) => ({ friend_id: f.requester_id === me ? f.addressee_id : f.requester_id }));
    return { rows, rowCount: rows.length };
  }

  // ── budget_submissions ───────────────────────────────────────────────────
  // The reminder's "members who have not submitted" query mentions
  // budget_submissions in a SUBQUERY, so it has to be recognised before the
  // budget_submissions branches or it lands in the wrong one.
  if (/FROM flock_members fm/i.test(sql)) {
    const flockId = Number(params[0]);
    const submitted = new Set(db.budget_submissions.filter((r) => r.flock_id === flockId).map((r) => r.user_id));
    const rows = db.flock_members
      .filter((fm) => fm.flock_id === flockId && fm.status === 'accepted' && !submitted.has(fm.user_id))
      .map((fm) => ({ id: fm.user_id, name: USERS.find((u) => u.id === fm.user_id).name }));
    return { rows, rowCount: rows.length };
  }
  if (/INSERT INTO budget_submissions/i.test(sql)) {
    const [flockId, userId, amount, skipped] = params;
    const stored = pgNumeric82(amount);
    // `skipped` is BOOLEAN with DEFAULT false, but an explicit NULL parameter
    // overrides a default — it does not fall back to it. That distinction is
    // load-bearing: a NULL here is excluded by every `skipped = false` filter,
    // so the person's amount silently stops counting toward the ceiling.
    // Storing Boolean(skipped) instead would have hidden exactly that.
    const skippedValue = skipped === null || skipped === undefined ? null : Boolean(skipped);
    const row = { flock_id: Number(flockId), user_id: Number(userId), amount: stored, skipped: skippedValue, updated_at: new Date() };
    const i = db.budget_submissions.findIndex((r) => r.flock_id === row.flock_id && r.user_id === row.user_id);
    if (i >= 0) db.budget_submissions[i] = { ...db.budget_submissions[i], ...row };
    else db.budget_submissions.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (/MIN\(amount\)/i.test(sql)) {
    const rows = db.budget_submissions.filter(match).filter((r) => r.amount !== null);
    const min = rows.length ? rows.reduce((a, b) => (Number(a.amount) <= Number(b.amount) ? a : b)).amount : null;
    return { rows: [{ ceiling: min }], rowCount: 1 };
  }
  if (/COUNT\(\*\) FILTER/i.test(sql)) {
    // The one statement whereMatcher cannot read: its first WHERE belongs to a
    // FILTER, not to the row set. Scoped explicitly on flock_id — but each
    // aggregate's own FILTER is still parsed out of the statement, so dropping
    // one from the route changes the number that comes back.
    const rows = db.budget_submissions.filter((r) => r.flock_id === Number(params[0]));
    const counted = (alias) => {
      const re = new RegExp(`COUNT\\(\\*\\)\\s*(?:FILTER\\s*\\(\\s*WHERE\\s+skipped\\s*=\\s*(true|false)\\s*\\)\\s*)?AS ${alias}`, 'i');
      const m = re.exec(sql);
      if (!m) return null;
      if (!m[1]) return rows.length;
      return rows.filter((r) => r.skipped === (m[1].toLowerCase() === 'true')).length;
    };
    return {
      rows: [{
        total_submissions: String(counted('total_submissions') ?? rows.length),
        non_skip_count: String(counted('non_skip_count') ?? 0),
        skip_count: String(counted('skip_count') ?? 0),
      }],
      rowCount: 1,
    };
  }
  if (/FROM budget_submissions/i.test(sql) && /COUNT\(\*\)::int/i.test(sql)) {
    return { rows: [{ n: db.budget_submissions.filter(match).length }], rowCount: 1 };
  }
  if (/FROM budget_submissions/i.test(sql)) {
    const rows = db.budget_submissions.filter(match);
    return { rows, rowCount: rows.length };
  }

  // ── flocks / flock_members / users ───────────────────────────────────────
  if (/UPDATE flocks/i.test(sql)) {
    const setPart = /SET([\s\S]*?)WHERE/i.exec(sql)[1];
    const hit = db.flocks.filter(match);
    for (const row of hit) {
      let m2; const re2 = /(\w+)\s*=\s*\$(\d+)/g;
      while ((m2 = re2.exec(setPart))) row[m2[1]] = params[Number(m2[2]) - 1];
      if (/budget_locked\s*=\s*true/i.test(setPart)) row.budget_locked = true;
    }
    return { rows: hit, rowCount: hit.length };
  }
  if (/FROM flocks/i.test(sql)) {
    const rows = db.flocks.filter(match);
    return { rows, rowCount: rows.length };
  }
  if (/FROM flock_members/i.test(sql) && /COUNT\(\*\)/i.test(sql)) {
    return { rows: [{ total: String(db.flock_members.filter(match).length) }], rowCount: 1 };
  }
  if (/FROM flock_members/i.test(sql)) {
    const rows = db.flock_members.filter(match).map((r) => ({ ...r }));
    return { rows, rowCount: rows.length };
  }

  return { rows: [], rowCount: 0 };
}

const realQuery = pool.query;
const realConnect = pool.connect;
pool.query = async (text, params) => dispatch(text, params);
pool.connect = async () => ({ query: async (t, p) => dispatch(t, p), release: () => {} });

// ---------------------------------------------------------------------------
// Push + socket capture. budget.js destructures pushHelper at require time, so
// the stubs go on before the router is loaded.
// ---------------------------------------------------------------------------
let pushes = [];
pushHelper.pushIfOffline = async (io, userId, title, body, data) => { pushes.push({ kind: 'ifOffline', userId, title, body, data }); };
pushHelper.pushAlways = async (userId, title, body, data) => { pushes.push({ kind: 'always', userId, title, body, data }); };

let emits = [];
const io = { to: (room) => ({ emit: (event, payload) => emits.push({ room, event, payload }) }) };

const { signUserToken } = require('../middleware/auth');
const budgetRouter = require('../routes/budget');
const calendarRouter = require('../routes/calendar');

const app = express();
app.use(express.json({ limit: 64 * 1024 }));
app.set('io', io);
app.use('/api/budget', budgetRouter);
app.use('/api/calendar', calendarRouter);
app.use('/api/availability', require('../routes/availability'));

const server = http.createServer(app);
const TOKENS = Object.fromEntries(USERS.map((u) => [u.id, signUserToken(u)]));

function call(method, urlPath, body, asUser = 1) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: urlPath, method,
      headers: {
        Authorization: `Bearer ${TOKENS[asUser]}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function fresh() {
  resetDb();
  pushes = [];
  emits = [];
  if (typeof budgetRouter.__resetReminderCooldowns === 'function') budgetRouter.__resetReminderCooldowns();
}

// ===========================================================================
// The child-process timezone probe. Runs this same file under a different TZ.
// ===========================================================================
function probeDateUnderTz(tz) {
  const out = execFileSync(process.execPath, [__filename], {
    env: { ...process.env, TZ: tz, PLANNING_TZ_PROBE: '1', JWT_SECRET: 'planning-routes-test-secret' },
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
  });
  return JSON.parse(out.trim().split('\n').pop());
}

if (TZ_PROBE) {
  // node-postgres hands rowToEvent exactly this: a DATE parsed to LOCAL
  // midnight. 2026-09-01 must read back as 2026-09-01 in every zone.
  const local = new Date(2026, 8, 1);
  const row = { id: 1, title: 'Dinner', venue: null, event_date: local, time_label: null, color: null };
  const shaped = calendarRouter.__rowToEvent
    ? calendarRouter.__rowToEvent(row)
    : { date: typeof row.event_date === 'string' ? row.event_date.slice(0, 10) : row.event_date.toISOString().slice(0, 10) };
  process.stdout.write(`${JSON.stringify({ tz: process.env.TZ, date: shaped.date })}\n`);
  process.exit(0);
}

test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', r)));
test.after(() => { pool.query = realQuery; pool.connect = realConnect; server.close(); });

// ===========================================================================
// 1. CALENDAR — a DATE column takes a real day, and isISO8601() is not that test
// ===========================================================================
//
// validator's isISO8601() is NON-STRICT by default: it checks the SHAPE of an
// ISO string, not whether the day exists. `2026-02-31`, `2026-09-31` and
// `2026-02-30T00:00:00Z` all pass it, and so do the truncated forms `2026` and
// `2026-09`. Every one of them then reaches a DATE column, where Postgres
// answers 22008 or 22007 — a 500 for a value the caller supplies, on all three
// of POST body, PUT body and the GET range.
//
// isISO8601({ strict: true }) is not the fix either: it still admits `2026` and
// `2026-09`, neither of which is a date Postgres will take.
const UNREAL_DATES = [
  '2026-02-31',            // shape-valid, day does not exist
  '2026-09-31',            // September has 30 days
  '2026-02-30T00:00:00Z',  // the same hole with a time on it
  '2026',                  // strict ISO 8601, not a day
  '2026-09',               // ditto
  '0000-01-01',            // there is no year zero in Postgres
];

test('calendar create: a date that is not a real day is a 400, never a 500', async () => {
  for (const date of UNREAL_DATES) {
    fresh();
    const res = await call('POST', '/api/calendar', { title: 'Dinner', date });
    assert.strictEqual(res.status, 400, `date=${date} -> ${res.status} ${res.raw}`);
    assert.deepStrictEqual(issued.map((q) => q.sql), [], `date=${date}: reached the database`);
  }
});

test('calendar update: the same dates are refused before the UPDATE', async () => {
  for (const date of UNREAL_DATES) {
    fresh();
    db.calendar_events.push({ id: 101, user_id: 1, title: 'Dinner', venue: null, event_date: pgDate('2026-09-01'), time_label: null, color: null });
    const res = await call('PUT', '/api/calendar/101', { date });
    assert.strictEqual(res.status, 400, `date=${date} -> ${res.status} ${res.raw}`);
    assert.deepStrictEqual(issued.map((q) => q.sql), [], `date=${date}: reached the database`);
  }
});

test('calendar range: an unreal start or end is a 400 before the SELECT', async () => {
  for (const bad of UNREAL_DATES) {
    fresh();
    const a = await call('GET', `/api/calendar?start=${encodeURIComponent(bad)}&end=2026-09-30`);
    assert.strictEqual(a.status, 400, `start=${bad} -> ${a.status} ${a.raw}`);
    assert.deepStrictEqual(issued.map((q) => q.sql), [], `start=${bad}: reached the database`);

    fresh();
    const b = await call('GET', `/api/calendar?start=2026-09-01&end=${encodeURIComponent(bad)}`);
    assert.strictEqual(b.status, 400, `end=${bad} -> ${b.status} ${b.raw}`);
    assert.deepStrictEqual(issued.map((q) => q.sql), [], `end=${bad}: reached the database`);
  }
});

// The control. Narrowing a validator is only safe if everything the shipping
// client can actually produce still gets through. App.js sends `formatDateStr`,
// i.e. YYYY-MM-DD built from local parts; the derived-flock path sends the same.
test('calendar create: every date form the client can produce still saves', async () => {
  for (const [sent, stored] of [
    ['2026-09-01', '2026-09-01'],
    ['2026-02-29', '2026-02-29'],       // 2026 is not a leap year... 2028 is; see below
    ['2028-02-29', '2028-02-29'],
    ['2026-09-01T18:30:00Z', '2026-09-01'],
    ['2026-12-31', '2026-12-31'],
    ['2026-01-01', '2026-01-01'],
  ]) {
    if (sent === '2026-02-29') continue; // not a real day — covered by UNREAL above
    fresh();
    const res = await call('POST', '/api/calendar', { title: 'Dinner', date: sent });
    assert.strictEqual(res.status, 201, `date=${sent} -> ${res.status} ${res.raw}`);
    assert.strictEqual(res.json.date, stored, `date=${sent} came back ${res.json.date}`);
  }
});

// Narrowing a date rule is exactly where a "control that cannot succeed" gets
// created, so the two ISO spellings Postgres itself takes both stay open, and
// the numeric form of the basic one is coerced rather than refused (round 20's
// finding, which authShapeGuards.test.js also pins). Mixed separators are NOT
// quietly repaired: `2026-0901` is not a date Postgres accepts, and repairing it
// would mean guessing.
test('calendar: both ISO spellings of a day work, and a mixed one does not', async () => {
  for (const [date, param] of [['2026-09-01', '2026-09-01'], ['20260901', '20260901'], [20260901, '20260901']]) {
    fresh();
    const res = await call('POST', '/api/calendar', { title: 'Dinner', date });
    assert.strictEqual(res.status, 201, `date=${JSON.stringify(date)} -> ${res.status} ${res.raw}`);
    assert.strictEqual(res.json.date, '2026-09-01', `date=${JSON.stringify(date)} came back ${res.json.date}`);
    // The spelling that reached pg is the spelling that came in, minus any
    // trailing time. Nothing is quietly rewritten on its way to the column.
    const insert = issued.find((q) => /INSERT INTO calendar_events/i.test(q.sql));
    assert.strictEqual(insert.params[3], param,
      `date=${JSON.stringify(date)} reached pg as ${JSON.stringify(insert.params[3])}`);
  }
  for (const date of ['2026-0901', '202609-01', 2026.5, true, '2026-09-01-01']) {
    fresh();
    const res = await call('POST', '/api/calendar', { title: 'Dinner', date });
    assert.strictEqual(res.status, 400, `date=${JSON.stringify(date)} -> ${res.status} ${res.raw}`);
    assert.deepStrictEqual(issued.map((q) => q.sql), [], `date=${JSON.stringify(date)}: reached the database`);
  }
});

// `Date.UTC` maps a two-digit year onto 1900, so the existence probe alone
// would read `0026-01-01` as 1926 and wave it through. The four-digit floor is
// the only thing standing between that and a DATE column.
test('calendar: a year below 1000 is refused whatever the probe thinks of it', async () => {
  for (const date of ['0500-01-01', '0026-01-01', '0099-12-31', '0001-01-01']) {
    fresh();
    const res = await call('POST', '/api/calendar', { title: 'Dinner', date });
    assert.strictEqual(res.status, 400, `date=${date} -> ${res.status} ${res.raw}`);
    assert.deepStrictEqual(issued.map((q) => q.sql), [], `date=${date}: reached the database`);
  }
  fresh();
  const ok = await call('POST', '/api/calendar', { title: 'Dinner', date: '1000-01-01' });
  assert.strictEqual(ok.status, 201, ok.raw);
});

test('calendar: a title is required and is not optional by accident', async () => {
  for (const body of [{ date: '2026-09-01' }, { title: '', date: '2026-09-01' }, { title: '   ', date: '2026-09-01' }]) {
    fresh();
    const res = await call('POST', '/api/calendar', body);
    assert.strictEqual(res.status, 400, `${JSON.stringify(body)} -> ${res.status} ${res.raw}`);
    assert.deepStrictEqual(issued.map((q) => q.sql), [], `${JSON.stringify(body)}: reached the database`);
  }
});

test('calendar: an update cannot blank a title either', async () => {
  for (const title of ['', '   ']) {
    fresh();
    db.calendar_events.push({ id: 800, user_id: 1, title: 'Dinner', venue: null, event_date: pgDate('2026-09-01'), time_label: null, color: null });
    const res = await call('PUT', '/api/calendar/800', { title });
    assert.strictEqual(res.status, 400, `title=${JSON.stringify(title)} -> ${res.status} ${res.raw}`);
    assert.strictEqual(db.calendar_events[0].title, 'Dinner');
  }
});

test('calendar: 2026-02-29 is refused — 2026 is not a leap year', async () => {
  fresh();
  const res = await call('POST', '/api/calendar', { title: 'Dinner', date: '2026-02-29' });
  assert.strictEqual(res.status, 400, res.raw);
  fresh();
  const ok = await call('POST', '/api/calendar', { title: 'Dinner', date: '2028-02-29' });
  assert.strictEqual(ok.status, 201, ok.raw);
});

// ===========================================================================
// 2. CALENDAR — the day you saved is the day you read back, in every timezone
// ===========================================================================
//
// node-postgres parses a DATE (oid 1082) with pg-types' parser, which builds
// `new Date(year, month - 1, day)` — LOCAL midnight, not UTC midnight. The
// comment on rowToEvent asserted the opposite. `.toISOString().slice(0, 10)` on
// a local-midnight Date is only correct at or west of UTC: east of it the
// instant falls on the previous UTC day and every event moves back one square
// on the calendar.
//
// Railway currently runs UTC, so this is latent rather than live — but nothing
// in the repo pins TZ, a container image or a region change flips it, and this
// is the same shape as the two date-across-zones bugs this codebase has already
// shipped. Proven by running the shaping function in three zones.
test('a stored calendar day reads back unchanged east of UTC, west of it, and at it', () => {
  for (const tz of ['Australia/Sydney', 'Asia/Tokyo', 'UTC', 'America/Los_Angeles']) {
    const out = probeDateUnderTz(tz);
    assert.strictEqual(out.date, '2026-09-01',
      `TZ=${tz}: a DATE of 2026-09-01 came back as ${out.date}`);
  }
});

// The other branch of the same shaping. A DATE arrives as a Date today, but a
// registered type parser (or a driver change) makes it a string, and the route
// carries a branch for that — so the branch has to be right too.
test('a DATE that arrives as a string keeps its day and drops its time', async () => {
  fresh();
  db.calendar_events.push({ id: 700, user_id: 1, title: 'Dinner', venue: null, event_date: '2026-09-01', time_label: null, color: null });
  db.calendar_events.push({ id: 701, user_id: 1, title: 'Show', venue: null, event_date: '2026-09-02T00:00:00.000Z', time_label: null, color: null });
  const res = await call('GET', '/api/calendar');
  assert.deepStrictEqual(res.json.map((e) => e.date), ['2026-09-01', '2026-09-02'], JSON.stringify(res.json));
});

test('the same day survives a full round trip through the route', async () => {
  fresh();
  const created = await call('POST', '/api/calendar', { title: 'Dinner', date: '2026-09-01' });
  assert.strictEqual(created.status, 201, created.raw);
  assert.strictEqual(created.json.date, '2026-09-01');
  const listed = await call('GET', '/api/calendar');
  assert.strictEqual(listed.json[0].date, '2026-09-01', JSON.stringify(listed.json));
});

// ===========================================================================
// 3. CALENDAR — a range with one bound must filter, not silently return all
// ===========================================================================
//
// `if (start && end)` meant a request carrying only one bound got the UNFILTERED
// query: the caller asked for September onwards and was handed every event they
// have ever had, with nothing in the response to say the filter was dropped.
// That is the fixture failure mode ("applies a filter regardless of what the SQL
// said") living in the route itself.
test('calendar range: one bound filters on that bound alone', async () => {
  fresh();
  for (const d of ['2026-08-01', '2026-09-15', '2026-10-20']) {
    db.calendar_events.push({ id: ++calSeq, user_id: 1, title: d, venue: null, event_date: pgDate(d), time_label: null, color: null });
  }

  const from = await call('GET', '/api/calendar?start=2026-09-01');
  assert.strictEqual(from.status, 200, from.raw);
  assert.deepStrictEqual(from.json.map((e) => e.date), ['2026-09-15', '2026-10-20']);

  const until = await call('GET', '/api/calendar?end=2026-09-30');
  assert.strictEqual(until.status, 200, until.raw);
  assert.deepStrictEqual(until.json.map((e) => e.date), ['2026-08-01', '2026-09-15']);

  const both = await call('GET', '/api/calendar?start=2026-09-01&end=2026-09-30');
  assert.deepStrictEqual(both.json.map((e) => e.date), ['2026-09-15']);

  const none = await call('GET', '/api/calendar');
  assert.strictEqual(none.json.length, 3);
});

// ===========================================================================
// 3b. CALENDAR — a day's plans come back in the order they happen
// ===========================================================================
//
// `ORDER BY event_date, time_label` reads like chronological order and is not.
// time_label is free text, so it sorts lexicographically: "10:00 PM" before
// "8:00 PM", and "12:30 AM" before either. The client does not re-sort — App.js
// only filters by date — so a day with an early dinner and a late show rendered
// them backwards.
test('calendar: the events for a day come back in clock order, not alphabetical', async () => {
  fresh();
  const labels = ['8:00 PM', '8:45 PM', '8:05 PM', '10:00 PM', '9:15 AM', '12:30 AM', '12:30 PM', 'TBD', ''];
  for (const t of labels) {
    db.calendar_events.push({ id: ++calSeq, user_id: 1, title: t || '(none)', venue: null, event_date: pgDate('2026-09-01'), time_label: t || null, color: null });
  }
  const res = await call('GET', '/api/calendar');
  assert.strictEqual(res.status, 200, res.raw);
  assert.deepStrictEqual(
    res.json.map((e) => e.time),
    ['12:30 AM', '9:15 AM', '12:30 PM', '8:00 PM', '8:05 PM', '8:45 PM', '10:00 PM', 'TBD', ''],
    JSON.stringify(res.json.map((e) => e.time)),
  );
});

// time_label is free text, so a label can be anything. A string that only looks
// like a time must not be read as one: "13:00 PM", "25:00" and "8:99" have no
// place on a clock, and treating them as 780, 1500 and 539 minutes would
// interleave them with real times. They belong with "TBD" at the end of the day.
test('calendar: a label that only looks like a time is not treated as one', async () => {
  fresh();
  for (const t of ['13:00 PM', '25:00', '8:99', '0:00 PM', 'later', '7:30 PM']) {
    db.calendar_events.push({ id: ++calSeq, user_id: 1, title: t, venue: null, event_date: pgDate('2026-09-01'), time_label: t, color: null });
  }
  const res = await call('GET', '/api/calendar');
  assert.deepStrictEqual(res.json.map((e) => e.time),
    ['7:30 PM', '13:00 PM', '25:00', '8:99', '0:00 PM', 'later'],
    JSON.stringify(res.json.map((e) => e.time)));
});

test('calendar: a 24-hour label sorts by the clock too, and days stay in order', async () => {
  fresh();
  for (const [d, t] of [['2026-09-02', '08:00'], ['2026-09-01', '20:00'], ['2026-09-01', '07:30'], ['2026-09-01', '19:00']]) {
    db.calendar_events.push({ id: ++calSeq, user_id: 1, title: `${d} ${t}`, venue: null, event_date: pgDate(d), time_label: t, color: null });
  }
  const res = await call('GET', '/api/calendar');
  assert.deepStrictEqual(res.json.map((e) => `${e.date} ${e.time}`), [
    '2026-09-01 07:30', '2026-09-01 19:00', '2026-09-01 20:00', '2026-09-02 08:00',
  ], JSON.stringify(res.json));
});

// ===========================================================================
// 4. BUDGET — "skipped" must mean skipped
// ===========================================================================
//
// validator's isBoolean() accepts the STRINGS 'true', 'false', '0' and '1'. The
// handler then reads the value with `!!skipped`, and `!!'false'` is true and
// `!!'0'` is true. So a submission that says "no, I did not skip, here is my
// $50" was recorded as a SKIP with amount NULL: the person's money silently
// stopped counting toward the ceiling, and the 3-submission privacy threshold
// that gates the whole feature moved.
//
// This is the string half of the exact bug budget.js already documents for the
// ARRAY case (`skipped: ["false"]`). scalarOnly closed the array; nothing closed
// this. A boolean-shaped field has to be COERCED, not merely recognised.
test('budget: a stringly-typed false is a real false, not a skip', async () => {
  for (const falsey of ['false', '0', false]) {
    fresh();
    const res = await call('POST', '/api/budget/10/submit', { amount: 50, skipped: falsey });
    assert.strictEqual(res.status, 200, `skipped=${JSON.stringify(falsey)} -> ${res.raw}`);
    const row = db.budget_submissions.find((r) => r.user_id === 1);
    assert.strictEqual(row.skipped, false, `skipped=${JSON.stringify(falsey)} stored skipped=${row.skipped}`);
    assert.strictEqual(row.amount, '50.00', `skipped=${JSON.stringify(falsey)} stored amount=${row.amount}`);
  }
});

test('budget: a stringly-typed true is still a skip', async () => {
  for (const truthy of ['true', '1', true]) {
    fresh();
    const res = await call('POST', '/api/budget/10/submit', { amount: 0, skipped: truthy });
    assert.strictEqual(res.status, 200, `skipped=${JSON.stringify(truthy)} -> ${res.raw}`);
    const row = db.budget_submissions.find((r) => r.user_id === 1);
    assert.strictEqual(row.skipped, true, `skipped=${JSON.stringify(truthy)} stored skipped=${row.skipped}`);
    assert.strictEqual(row.amount, null);
  }
});

test('budget: an absent or null skip flag means not skipped', async () => {
  for (const v of [undefined, null]) {
    fresh();
    const body = { amount: 50 };
    if (v === null) body.skipped = null;
    const res = await call('POST', '/api/budget/10/submit', body);
    assert.strictEqual(res.status, 200, res.raw);
    assert.strictEqual(db.budget_submissions.find((r) => r.user_id === 1).skipped, false);
  }
});

// The Skip button itself — the control that could not succeed, kept pinned.
test('budget: the Skip button payload the shipping client sends is accepted', async () => {
  fresh();
  const res = await call('POST', '/api/budget/10/submit', { amount: 0, skipped: true });
  assert.strictEqual(res.status, 200, res.raw);
  const row = db.budget_submissions.find((r) => r.user_id === 1);
  assert.strictEqual(row.skipped, true);
  assert.strictEqual(row.amount, null);
});

test('budget: a non-skip with no usable amount is still refused, in words', async () => {
  for (const body of [{ amount: 0, skipped: false }, { skipped: false }, { amount: '', skipped: false }]) {
    fresh();
    const res = await call('POST', '/api/budget/10/submit', body);
    assert.strictEqual(res.status, 400, `${JSON.stringify(body)} -> ${res.raw}`);
    assert.match(res.json.error, /amount/i, res.raw);
  }
});

// ===========================================================================
// 5. BUDGET — money
// ===========================================================================
//
// The group budget is read in two places: in the app, from `ceiling`, and in a
// push notification. The push ran the number through Math.floor(), so a ceiling
// of $12.50 was announced as "up to $12" while the app said $12.50, and a
// ceiling under a dollar was announced as "up to $0". Currency is not an
// integer; floor is not a formatter.
//
// The numbers below moved once, for a different reason: the published ceiling
// is now BANDED (audit finding M1), so a MIN of $12.50 publishes as $10 on
// every surface. What these tests still exist to pin is that the push and the
// API agree, and that the formatter never turns a real number into $0 — the
// two failures that motivated them. The banded value is read out of
// routes/budget.js rather than retyped, so the band table and the expectation
// cannot drift apart.
//
// Round 22 moved WHEN the number is published, not what it is. Flock 10 has
// four members and the ceiling is published only once the last of them has
// answered (settledCeiling in routes/budget.js), so this helper sends a fourth,
// deliberately huge amount to close the flock. $10,000 is the validator's
// maximum and can never be the MIN, so the number under test is still
// MIN(amounts) and the band expectations below are unchanged.
async function settledFlock(amounts) {
  fresh();
  for (let i = 0; i < amounts.length; i++) {
    const res = await call('POST', '/api/budget/10/submit', { amount: amounts[i], skipped: false }, i + 1);
    assert.strictEqual(res.status, 200, `submission ${i + 1} -> ${res.raw}`);
  }
  const closing = await call('POST', '/api/budget/10/submit', { amount: 10000, skipped: false }, amounts.length + 1);
  assert.strictEqual(closing.status, 200, `closing submission -> ${closing.raw}`);
  assert.strictEqual(closing.json.budgetLocked, true, 'the last answer did not settle the budget');
}

test('budget: the pushed ceiling is the banded ceiling, and the API agrees with it', async () => {
  await settledFlock([40, 12.5, 30]);
  const banded = budgetRouter.bandCeiling(12.5); // 10 — nearest $5 down under $50
  const ready = pushes.filter((p) => p.data && p.data.type === 'budget_ready');
  assert.ok(ready.length > 0, 'the threshold push never fired');
  for (const p of ready) {
    assert.match(p.body, new RegExp(`\\$${banded}\\b`), `push said: ${p.body}`);
    assert.doesNotMatch(p.body, /\$12\.50/, `the push published the raw MIN: ${p.body}`);
  }
  const status = await call('GET', '/api/budget/10', undefined, 1);
  assert.strictEqual(status.json.ceiling, banded,
    'the push and the API must publish the same number, banded on both');
});

test('budget: a sub-dollar ceiling is not announced as $0', async () => {
  // $0.75 is below the smallest band, and the band below $1 is $0 — which the
  // app reads as "no ceiling yet" and which tells the group nothing. So the
  // sub-dollar reveal is a cent: never zero, never above the true MIN.
  await settledFlock([5, 0.75, 9]);
  const ready = pushes.filter((p) => p.data && p.data.type === 'budget_ready');
  assert.ok(ready.length > 0, 'the threshold push never fired');
  assert.match(ready[0].body, /\$0\.01\b/, `push said: ${ready[0].body}`);
  assert.doesNotMatch(ready[0].body, /\$0\b(?!\.)/, `push announced $0: ${ready[0].body}`);
});

test('budget: a whole-dollar ceiling still reads as a whole dollar', async () => {
  await settledFlock([40, 25, 30]);
  const ready = pushes.filter((p) => p.data && p.data.type === 'budget_ready');
  assert.match(ready[0].body, /\$25\b/, `push said: ${ready[0].body}`);
  assert.doesNotMatch(ready[0].body, /\$25\.00/, `push over-formatted: ${ready[0].body}`);
});

// The DECIMAL column and the API must not disagree. The route hands pg the
// value as sent and lets NUMERIC(8,2) do the rounding, which is the only way
// they can agree: Math.round(1.005 * 100) / 100 is 1.00 in JS and 1.01 in
// Postgres, because 1.005 * 100 is 100.49999999999999. This pins the route to
// reading the stored value back rather than computing its own.
//
// The CALLER'S OWN amount is still reported to the cent, because it is their
// own number and no band applies to it. The group ceiling is banded, so a
// stored MIN of 1.01 publishes as 1 — the one place these two now differ, and
// the difference is the point.
test('budget: the caller sees their own amount to the cent, and the group sees a band', async () => {
  await settledFlock([1.005, 20, 30]);
  const stored = db.budget_submissions.find((r) => r.user_id === 1).amount;
  assert.strictEqual(stored, '1.01', `NUMERIC(8,2) stored ${stored}`);
  const status = await call('GET', '/api/budget/10', undefined, 1);
  assert.strictEqual(status.json.ceiling, budgetRouter.bandCeiling('1.01'), JSON.stringify(status.json));
  assert.strictEqual(status.json.ceiling, 1, JSON.stringify(status.json));
  assert.strictEqual(status.json.userAmount, 1.01, JSON.stringify(status.json));
});

test('budget: amounts outside the accepted range never reach the column', async () => {
  for (const amount of [0.001, 10000.01, -5, 1e9]) {
    fresh();
    const res = await call('POST', '/api/budget/10/submit', { amount, skipped: false });
    assert.strictEqual(res.status, 400, `amount=${amount} -> ${res.raw}`);
  }
  fresh();
  const lo = await call('POST', '/api/budget/10/submit', { amount: 0.01, skipped: false });
  assert.strictEqual(lo.status, 200, lo.raw);
  fresh();
  const hi = await call('POST', '/api/budget/10/submit', { amount: 10000, skipped: false });
  assert.strictEqual(hi.status, 200, hi.raw);
});

// ===========================================================================
// 6. BUDGET — the lock refusal has to describe the rule it is enforcing
// ===========================================================================
//
// The threshold is three NON-SKIPPED submissions, because the ceiling is a MIN
// and revealing it over fewer than three amounts exposes an individual's
// budget. But the refusal said "at least 3 people have submitted" while the
// screen right above it said "4 of 4 submitted" — because submissionCount
// counts skips and the threshold does not. In a four-person flock where two
// people skip, the creator is told everyone has answered and that not enough
// people have answered, and Lock Budget can never succeed.
test('budget lock: the refusal explains that skips do not count', async () => {
  fresh();
  await call('POST', '/api/budget/10/submit', { amount: 50, skipped: false }, 1);
  await call('POST', '/api/budget/10/submit', { amount: 60, skipped: false }, 2);
  await call('POST', '/api/budget/10/submit', { amount: 0, skipped: true }, 3);
  await call('POST', '/api/budget/10/submit', { amount: 0, skipped: true }, 4);

  const status = await call('GET', '/api/budget/10', undefined, 1);
  assert.strictEqual(status.json.submissionCount, 4, 'the screen says everyone answered');
  assert.strictEqual(status.json.isReady, false);

  const locked = await call('POST', '/api/budget/10/lock', undefined, 1);
  assert.strictEqual(locked.status, 400, locked.raw);
  assert.match(locked.json.error, /amount/i,
    `the refusal does not mention amounts, so it contradicts "4 of 4 submitted": ${locked.json.error}`);
});

test('budget lock: three real amounts do lock, and the locked ceiling is the banded minimum', async () => {
  // Three of the four members answer, so the flock does not settle by itself
  // and the creator's lock is the publication. That is the whole reason the
  // lock button still exists: a flock waiting on somebody who never answers.
  fresh();
  for (const [i, amount] of [[1, 40], [2, 12.5], [3, 30]]) {
    const sub = await call('POST', '/api/budget/10/submit', { amount, skipped: false }, i);
    assert.strictEqual(sub.status, 200, sub.raw);
    assert.strictEqual(sub.json.ceiling, null, 'a number was published before everyone answered');
  }
  const res = await call('POST', '/api/budget/10/lock', undefined, 1);
  assert.strictEqual(res.status, 200, res.raw);
  // Was 12.5, the raw MIN. The lock publishes the same band every other surface
  // does (finding M1) — otherwise locking would be a second door to the exact
  // number the submit path had just banded.
  assert.strictEqual(res.json.ceiling, 10);
  assert.strictEqual(db.flocks.find((f) => f.id === 10).budget_locked, true);
  // And the band is what gets cached, so nothing downstream re-publishes 12.5.
  assert.strictEqual(Number(db.flocks.find((f) => f.id === 10).budget_ceiling), 10);
});

// ===========================================================================
// 7. OBJECT AUTHORIZATION — prove it either way
// ===========================================================================
test('calendar: one user cannot read, edit or delete another user\'s event', async () => {
  fresh();
  db.calendar_events.push({ id: 200, user_id: 2, title: 'Ben only', venue: null, event_date: pgDate('2026-09-01'), time_label: null, color: null });

  const list = await call('GET', '/api/calendar', undefined, 1);
  assert.deepStrictEqual(list.json, [], 'Ava saw Ben\'s event');

  const edit = await call('PUT', '/api/calendar/200', { title: 'hijacked' }, 1);
  assert.strictEqual(edit.status, 404, edit.raw);
  assert.strictEqual(db.calendar_events[0].title, 'Ben only', 'Ava edited Ben\'s event');

  const del = await call('DELETE', '/api/calendar/200', undefined, 1);
  assert.strictEqual(del.status, 404, del.raw);
  assert.strictEqual(db.calendar_events.length, 1, 'Ava deleted Ben\'s event');

  // The positive control: Ben can do all three.
  assert.strictEqual((await call('GET', '/api/calendar', undefined, 2)).json.length, 1);
  assert.strictEqual((await call('PUT', '/api/calendar/200', { title: 'mine' }, 2)).status, 200);
  assert.strictEqual((await call('DELETE', '/api/calendar/200', undefined, 2)).status, 200);
});

test('budget: a non-member can neither read nor submit to a flock budget', async () => {
  fresh();
  const read = await call('GET', '/api/budget/11', undefined, 1);
  assert.strictEqual(read.status, 403, read.raw);
  const submit = await call('POST', '/api/budget/11/submit', { amount: 50, skipped: false }, 1);
  assert.strictEqual(submit.status, 403, submit.raw);
  assert.strictEqual(db.budget_submissions.length, 0);
});

test('budget: only the creator can lock or send reminders', async () => {
  // Three of four, so the budget is still open and `budget_locked` staying
  // false below means the refusal, not an earlier auto-settle.
  fresh();
  for (const [i, amount] of [[1, 40], [2, 50], [3, 60]]) {
    await call('POST', '/api/budget/10/submit', { amount, skipped: false }, i);
  }
  const lock = await call('POST', '/api/budget/10/lock', undefined, 2);
  assert.strictEqual(lock.status, 403, lock.raw);
  assert.strictEqual(db.flocks.find((f) => f.id === 10).budget_locked, false);

  const remind = await call('POST', '/api/budget/10/remind', undefined, 2);
  assert.strictEqual(remind.status, 403, remind.raw);
  assert.strictEqual(pushes.filter((p) => p.data && p.data.type === 'budget_reminder').length, 0);
});

test('budget: no member amount ever leaves the server', async () => {
  await settledFlock([40, 12.5, 30]);
  const status = await call('GET', '/api/budget/10', undefined, 2);
  const body = JSON.stringify(status.json);
  assert.strictEqual(status.json.userAmount, 12.5, 'a caller must still see their OWN amount');
  assert.doesNotMatch(body, /\b40\b/, `another member's amount is in the payload: ${body}`);
  assert.doesNotMatch(body, /\b30\b/, `another member's amount is in the payload: ${body}`);
  for (const e of emits.filter((x) => x.event === 'budget_updated')) {
    const p = JSON.stringify(e.payload);
    assert.doesNotMatch(p, /\b40\b/, `budget_updated leaked an amount: ${p}`);
  }
});

test('budget: the ceiling stays hidden below three real amounts', async () => {
  fresh();
  await call('POST', '/api/budget/10/submit', { amount: 40, skipped: false }, 1);
  await call('POST', '/api/budget/10/submit', { amount: 12.5, skipped: false }, 2);
  await call('POST', '/api/budget/10/submit', { amount: 0, skipped: true }, 3);
  const status = await call('GET', '/api/budget/10', undefined, 3);
  assert.strictEqual(status.json.ceiling, null, JSON.stringify(status.json));
  assert.strictEqual(status.json.isReady, false);
  assert.strictEqual(pushes.filter((p) => p.data && p.data.type === 'budget_ready').length, 0);
});

test('availability: every read and write is scoped to the caller', async () => {
  fresh();
  await call('POST', '/api/availability', { status: 'down' }, 2);   // Ben, Ava's friend
  await call('POST', '/api/availability', { status: 'maybe' }, 3);  // Cy, a stranger

  const mine = await call('GET', '/api/availability/me', undefined, 1);
  assert.strictEqual(mine.json.pulse, null, 'Ava has no pulse but got one');

  const friends = await call('GET', '/api/availability/friends', undefined, 1);
  assert.deepStrictEqual(friends.json.friends.map((f) => f.id), [2],
    `a non-friend's pulse was visible: ${JSON.stringify(friends.json)}`);

  // Clearing removes only the caller's row.
  const cleared = await call('DELETE', '/api/availability', undefined, 1);
  assert.strictEqual(cleared.status, 200, cleared.raw);
  assert.strictEqual(db.availability_pulses.length, 2, 'DELETE removed someone else\'s pulse');
});

// The pulse list is a "who is free tonight" list, so the people who said yes
// have to come first. The ranking lives in an ORDER BY CASE.
test('availability: friends who are down come before maybe, and maybe before not', async () => {
  fresh();
  db.friendships.push(
    { requester_id: 1, addressee_id: 3, status: 'accepted' },
    { requester_id: 4, addressee_id: 1, status: 'accepted' },
    { requester_id: 1, addressee_id: 5, status: 'pending' },
  );
  const soon = new Date(Date.now() + 3600 * 1000);
  db.availability_pulses.push(
    { user_id: 2, status: 'not', note: null, set_at: new Date(), expires_at: soon },
    { user_id: 3, status: 'down', note: null, set_at: new Date(), expires_at: soon },
    { user_id: 4, status: 'maybe', note: null, set_at: new Date(), expires_at: soon },
    { user_id: 5, status: 'down', note: null, set_at: new Date(), expires_at: soon },
  );
  const res = await call('GET', '/api/availability/friends', undefined, 1);
  assert.deepStrictEqual(res.json.friends.map((f) => f.status), ['down', 'maybe', 'not'],
    JSON.stringify(res.json.friends));
  assert.ok(!res.json.friends.some((f) => f.id === 5),
    'a pending friend request is not a friendship');
});

test('availability: a note is screened and stripped like every other broadcast field', async () => {
  fresh();
  const res = await call('POST', '/api/availability', { status: 'down', note: '  <b>rooftop</b>  ' });
  assert.strictEqual(res.status, 200, res.raw);
  assert.strictEqual(db.availability_pulses[0].note, 'rooftop', `stored ${JSON.stringify(db.availability_pulses[0].note)}`);

  fresh();
  const blank = await call('POST', '/api/availability', { status: 'down', note: '<b> </b>' });
  assert.strictEqual(blank.status, 200, blank.raw);
  assert.strictEqual(db.availability_pulses[0].note, null, 'a markup-only note was stored as a space');

  // The note is UGC pushed to every friend over the availability_updated socket
  // event, so it gets the same screen every other broadcast text field gets
  // (Apple 1.2). A rejected note must never reach the table.
  fresh();
  const foul = await call('POST', '/api/availability', { status: 'down', note: 'shit' });
  assert.strictEqual(foul.status, 400, foul.raw);
  assert.strictEqual(db.availability_pulses.length, 0, 'a screened note was stored anyway');
  assert.deepStrictEqual(emits, [], 'a screened note was broadcast anyway');
});

// The shape guard, pinned here as well as in authShapeGuards.test.js: status is
// VARCHAR(10) behind a CHECK, and express-validator stringifies a one-element
// array before isIn() tests it, so the array satisfies the rule and then
// reaches pg as a text[] — a 500 for a body the caller picks.
test('availability: a non-scalar status is a 400 before any query', async () => {
  for (const status of [['down'], ['down', 'maybe'], [], { a: 'down' }]) {
    fresh();
    const res = await call('POST', '/api/availability', { status });
    assert.strictEqual(res.status, 400, `status=${JSON.stringify(status)} -> ${res.status} ${res.raw}`);
    assert.deepStrictEqual(issued.map((q) => q.sql), [], `status=${JSON.stringify(status)}: reached the database`);
  }
});

test('availability: an expired pulse is invisible to me and to my friends', async () => {
  fresh();
  db.availability_pulses.push({ user_id: 1, status: 'down', note: null, set_at: new Date(), expires_at: new Date(Date.now() - 1000) });
  db.availability_pulses.push({ user_id: 2, status: 'down', note: null, set_at: new Date(), expires_at: new Date(Date.now() - 1000) });
  assert.strictEqual((await call('GET', '/api/availability/me', undefined, 1)).json.pulse, null);
  assert.deepStrictEqual((await call('GET', '/api/availability/friends', undefined, 1)).json.friends, []);
});

// ===========================================================================
// 8. FIELD BOUNDS — every ceiling derived from the column or the interface
// ===========================================================================
//
// The global JSON body limit dropped from 1MB to 64KB this session, so any
// field that leaned on it as its only maximum changed silently. These are the
// derivations, one per field:
//
//   calendar title      120  = calendar_events.title VARCHAR(120)   (migration 003)
//   calendar venue      200  = calendar_events.venue VARCHAR(200)   (migration 003)
//   calendar time       20   = calendar_events.time_label VARCHAR(20)
//   calendar color      30   = calendar_events.color VARCHAR(30)
//   availability note   80   = not the column (it is TEXT) — this is a broadcast
//                              field the shipping client never populates, so the
//                              bound is what a one-line status note can be.
//   budget amount       10000 = product rule, well inside NUMERIC(8,2)'s 999999.99
//
// Each is checked at the boundary and one past it, and the "one past it" case
// must be a 400 from the validator, NOT a 413 from the parser and NOT a 22001
// from the column.
const BOUNDS = [
  { label: 'calendar title', max: 120, build: (s) => ['POST', '/api/calendar', { title: s, date: '2026-09-01' }] },
  { label: 'calendar venue', max: 200, build: (s) => ['POST', '/api/calendar', { title: 'x', date: '2026-09-01', venue: s }] },
  { label: 'calendar time', max: 20, build: (s) => ['POST', '/api/calendar', { title: 'x', date: '2026-09-01', time: s }] },
  { label: 'calendar color', max: 30, build: (s) => ['POST', '/api/calendar', { title: 'x', date: '2026-09-01', color: s }] },
  { label: 'availability note', max: 80, build: (s) => ['POST', '/api/availability', { status: 'down', note: s }] },
];

test('every text field has a maximum of its own, at the column width', async () => {
  for (const b of BOUNDS) {
    fresh();
    const [m1, p1, body1] = b.build('a'.repeat(b.max));
    const ok = await call(m1, p1, body1);
    assert.ok(ok.status < 400, `${b.label}: ${b.max} chars was refused (${ok.status} ${ok.raw})`);

    fresh();
    const [m2, p2, body2] = b.build('a'.repeat(b.max + 1));
    const over = await call(m2, p2, body2);
    assert.strictEqual(over.status, 400, `${b.label}: ${b.max + 1} chars -> ${over.status} ${over.raw}`);
    assert.deepStrictEqual(issued.map((q) => q.sql), [], `${b.label}: an oversized value reached the database`);
  }
});

test('no text field leans on the 64KB body parser as its ceiling', async () => {
  // 10KB — comfortably inside express.json()'s limit, so a 400 here can only
  // come from the field's own rule.
  const big = 'a'.repeat(10 * 1024);
  for (const b of BOUNDS) {
    fresh();
    const [m, p, body] = b.build(big);
    const res = await call(m, p, body);
    assert.strictEqual(res.status, 400, `${b.label}: a 10KB value -> ${res.status} ${res.raw}`);
    assert.deepStrictEqual(issued.map((q) => q.sql), [], `${b.label}: 10KB reached the database`);
  }
});

test('the update path carries the same bounds as the create path', async () => {
  const cases = [['title', 120], ['venue', 200], ['time', 20], ['color', 30]];
  for (const [field, max] of cases) {
    fresh();
    db.calendar_events.push({ id: 300, user_id: 1, title: 'x', venue: null, event_date: pgDate('2026-09-01'), time_label: null, color: null });
    const over = await call('PUT', '/api/calendar/300', { [field]: 'a'.repeat(max + 1) });
    assert.strictEqual(over.status, 400, `PUT ${field} ${max + 1} -> ${over.status} ${over.raw}`);
    assert.deepStrictEqual(issued.map((q) => q.sql), [], `PUT ${field}: oversized value reached the database`);
  }
});

// ===========================================================================
// 9. optional() SKIPS ONLY undefined — the null half, on every optional field
// ===========================================================================
test('an explicit null on any optional field is accepted, not 400ed', async () => {
  fresh();
  const cal = await call('POST', '/api/calendar', { title: 'Dinner', date: '2026-09-01', venue: null, time: null, color: null });
  assert.strictEqual(cal.status, 201, cal.raw);

  fresh();
  db.calendar_events.push({ id: 400, user_id: 1, title: 'Dinner', venue: 'Bar', event_date: pgDate('2026-09-01'), time_label: '8 PM', color: '#fff' });
  const put = await call('PUT', '/api/calendar/400', { title: null, date: null, venue: null, time: null, color: null });
  assert.strictEqual(put.status, 200, put.raw);
  assert.strictEqual(db.calendar_events[0].title, 'Dinner', 'a null cleared a column it should have left alone');
  assert.strictEqual(db.calendar_events[0].venue, 'Bar');

  fresh();
  const avail = await call('POST', '/api/availability', { status: 'down', note: null, expires_at: null });
  assert.strictEqual(avail.status, 200, avail.raw);

  fresh();
  const budget = await call('POST', '/api/budget/10/submit', { amount: 50, skipped: null });
  assert.strictEqual(budget.status, 200, budget.raw);
});

test('the calendar range accepts an explicit null bound', async () => {
  fresh();
  const res = await call('GET', '/api/calendar');
  assert.strictEqual(res.status, 200, res.raw);
});

// ===========================================================================
// 10. NOTHING A CALLER CAN SEND IS A 500
// ===========================================================================
//
// The shape guards already cover arrays and objects. These are the SCALARS —
// numbers where strings are expected, exponent notation, empty strings, and
// oversized ids — swept across every field on all three routers. A 500 here is
// a caller-controlled crash; a 400 or a success is fine.
const NASTY = [0, -1, 1e309, '', ' ', 'NaN', 'null', 'undefined', true, false, '1e3', '0x10', '  50  ', ' ', '💥'.repeat(5)];

test('no scalar on any planning field produces a 500', async () => {
  const shots = [];
  for (const v of NASTY) {
    shots.push(['POST', '/api/calendar', { title: v, date: '2026-09-01' }]);
    shots.push(['POST', '/api/calendar', { title: 'x', date: v }]);
    shots.push(['POST', '/api/calendar', { title: 'x', date: '2026-09-01', venue: v }]);
    shots.push(['POST', '/api/calendar', { title: 'x', date: '2026-09-01', time: v }]);
    shots.push(['POST', '/api/calendar', { title: 'x', date: '2026-09-01', color: v }]);
    shots.push(['PUT', '/api/calendar/500', { title: v }]);
    shots.push(['PUT', '/api/calendar/500', { date: v }]);
    shots.push(['POST', '/api/availability', { status: v }]);
    shots.push(['POST', '/api/availability', { status: 'down', note: v }]);
    shots.push(['POST', '/api/availability', { status: 'down', expires_at: v }]);
    shots.push(['POST', '/api/budget/10/submit', { amount: v, skipped: false }]);
    shots.push(['POST', '/api/budget/10/submit', { amount: 50, skipped: v }]);
  }
  for (const [m, p, body] of shots) {
    fresh();
    db.calendar_events.push({ id: 500, user_id: 1, title: 'x', venue: null, event_date: pgDate('2026-09-01'), time_label: null, color: null });
    const res = await call(m, p, body);
    assert.notStrictEqual(res.status, 500, `${m} ${p} ${JSON.stringify(body)} -> 500 ${res.raw}`);
  }
});

test('an out-of-range flock or event id is a 400 before any query', async () => {
  for (const id of ['2147483648', '99999999999', '0', '-1', 'abc']) {
    for (const [m, p, body] of [
      ['GET', `/api/budget/${id}`, undefined],
      ['POST', `/api/budget/${id}/submit`, { amount: 50, skipped: false }],
      ['POST', `/api/budget/${id}/lock`, undefined],
      ['POST', `/api/budget/${id}/remind`, undefined],
      ['PUT', `/api/calendar/${id}`, { title: 'x' }],
      ['DELETE', `/api/calendar/${id}`, undefined],
    ]) {
      fresh();
      const res = await call(m, p, body);
      assert.strictEqual(res.status, 400, `${m} ${p} -> ${res.status} ${res.raw}`);
      assert.deepStrictEqual(issued.map((q) => q.sql), [], `${m} ${p}: reached the database`);
    }
  }
});

// ===========================================================================
// 11. AVAILABILITY — expiry clamping and the status set
// ===========================================================================
test('availability: expiry is clamped to the 36 hour cap and forward of now', async () => {
  fresh();
  const far = new Date(Date.now() + 90 * 3600 * 1000).toISOString();
  const a = await call('POST', '/api/availability', { status: 'down', expires_at: far });
  const capped = new Date(a.json.pulse.expires_at).getTime();
  assert.ok(capped <= Date.now() + 36 * 3600 * 1000 + 5000, `expiry not capped: ${a.json.pulse.expires_at}`);

  fresh();
  const past = new Date(Date.now() - 3600 * 1000).toISOString();
  const b = await call('POST', '/api/availability', { status: 'down', expires_at: past });
  assert.ok(new Date(b.json.pulse.expires_at).getTime() > Date.now(), 'a past expiry was stored as past');
});

// `expires_at` keeps a loose isISO8601() where `date` on the calendar could
// not, and that is deliberate rather than an oversight: nothing here is handed
// to a DATE column. clampExpiry coerces whatever arrives into an instant and
// then clamps it, so the property worth pinning is not "the string was valid",
// it is the range. Whatever a caller sends — an unreal day that JS rolls over,
// a truncated year, an outright non-date — the stored expiry is always in the
// future and never past the 36 hour cap, and never a 500.
//
// The floor is "in the future", NOT "at least an hour away". The one-hour
// rescue applies only to an expiry that has already passed. A pulse legitimately
// expires in minutes: the client asks for 4am local, so someone setting their
// status at 3:55am is asking for five minutes, and honouring that is the point
// of letting the client send the time at all.
test('availability: any expiry a caller can send lands inside the window', async () => {
  const sent = [
    undefined, null, '2026-02-31T00:00:00Z', '2026', '2026-09', '2026-13-01',
    // These three satisfy isISO8601 and are an INVALID DATE to `new Date` —
    // the basic form, an ISO week date, and an ordinal date. They are the only
    // way to reach clampExpiry's isNaN branch, so without them that branch is
    // untested and a pulse could be stored with an unusable timestamp.
    '20260901', '2026-W01-1', '2026-366',
    new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    new Date(Date.now() + 20 * 3600 * 1000).toISOString(),
    new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString(),
    new Date(Date.now() + 3650 * 24 * 3600 * 1000).toISOString(),
  ];
  for (const expires_at of sent) {
    fresh();
    const body = { status: 'down' };
    if (expires_at !== undefined) body.expires_at = expires_at;
    const before = Date.now();
    const res = await call('POST', '/api/availability', body);
    // A refusal is a fine answer too — `2026-13-01` does not even satisfy the
    // loose ISO check. What must never happen is a 500, or a pulse stored
    // outside the window.
    assert.ok(res.status === 200 || res.status === 400, `expires_at=${expires_at} -> ${res.status} ${res.raw}`);
    if (res.status === 400) { assert.strictEqual(db.availability_pulses.length, 0); continue; }
    const at = new Date(res.json.pulse.expires_at).getTime();
    assert.ok(Number.isFinite(at), `expires_at=${expires_at} stored ${res.json.pulse.expires_at}`);
    assert.ok(at > before, `expires_at=${expires_at} was stored already expired: ${res.json.pulse.expires_at}`);
    assert.ok(at <= before + 36 * 3600 * 1000 + 5000, `expires_at=${expires_at} outlived the cap: ${res.json.pulse.expires_at}`);
  }
});

// The other half of the clamp: a time inside the window is HONOURED, not
// replaced. Clamping every value to a default would satisfy every bound above
// while quietly ignoring what the client asked for — which is the whole reason
// the client sends the time in the first place (it knows the user's timezone
// and the server does not).
test('availability: an expiry inside the window is kept, not replaced', async () => {
  for (const hours of [2, 8, 20, 30]) {
    fresh();
    const want = new Date(Date.now() + hours * 3600 * 1000);
    const res = await call('POST', '/api/availability', { status: 'down', expires_at: want.toISOString() });
    assert.strictEqual(res.status, 200, res.raw);
    const got = new Date(res.json.pulse.expires_at).getTime();
    assert.ok(Math.abs(got - want.getTime()) < 2000,
      `asked for +${hours}h (${want.toISOString()}), got ${res.json.pulse.expires_at}`);
  }
});

test('availability: only the three real statuses are accepted', async () => {
  for (const status of ['down', 'maybe', 'not']) {
    fresh();
    const res = await call('POST', '/api/availability', { status });
    assert.strictEqual(res.status, 200, `${status} -> ${res.raw}`);
  }
  for (const status of ['DOWN', 'busy', 'free', 'down ', '']) {
    fresh();
    const res = await call('POST', '/api/availability', { status });
    assert.strictEqual(res.status, 400, `${status} -> ${res.status} ${res.raw}`);
    assert.deepStrictEqual(issued.map((q) => q.sql), [], `status=${status} reached the database`);
  }
});

// ===========================================================================
// 12. BUDGET — the reminder cooldown, and the threshold push firing once
// ===========================================================================
test('budget reminder: the cooldown is per flock and claimed before the work', async () => {
  fresh();
  const first = await call('POST', '/api/budget/10/remind', undefined, 1);
  assert.strictEqual(first.status, 200, first.raw);
  assert.strictEqual(first.json.reminded, 4, 'should remind all four members, none of whom has submitted');
  const second = await call('POST', '/api/budget/10/remind', undefined, 1);
  assert.strictEqual(second.status, 429, second.raw);
});

test('budget: the "Budget set!" push fires on the crossing and not on later edits', async () => {
  await settledFlock([40, 50, 60]);
  assert.strictEqual(pushes.filter((p) => p.data && p.data.type === 'budget_ready').length, 3,
    'the crossing should notify the three other members exactly once each');
  pushes.length = 0;
  await call('POST', '/api/budget/10/submit', { amount: 35, skipped: false }, 1);
  assert.strictEqual(pushes.filter((p) => p.data && p.data.type === 'budget_ready').length, 0,
    'an edit after the threshold replayed the announcement');
});

// ===========================================================================
// 13. THE SHARED SHAPE HELPERS, NOT A PRIVATE COPY
// ===========================================================================
test('all three routers use validators/shape.js rather than a local predicate', () => {
  const fs = require('node:fs');
  for (const f of ['budget.js', 'calendar.js', 'availability.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', f), 'utf8');
    assert.match(src, /require\('\.\.\/validators\/shape'\)/, `${f} does not import the shared shape helpers`);
    assert.doesNotMatch(src, /typeof\s+\w+\s*!==\s*'object'/,
      `${f} carries a private copy of the scalar predicate`);
  }
});
