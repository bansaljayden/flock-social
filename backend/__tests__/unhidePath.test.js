// Run: node --test  (from backend/)
//
// Round 18 — "the takedown you cannot undo, that nobody is told about, and that
// one dashboard never heard of". Three findings, all on the moderation path,
// pinned here because every one of them fails silently:
//
//   1. THERE WAS NO UN-HIDE. routes/admin.js could set is_hidden = true on six
//      tables and nothing in the backend could set it back, so a mistaken
//      takedown was reversible only from a psql prompt against production. The
//      route change is inseparable from migration 017: moderation_actions.action
//      carries a CHECK constraint with no value meaning "restored", and the
//      audit INSERT is inside the same transaction as the mutation, so an
//      un-hide would have died as a 23514 and surfaced as `500 Failed to apply
//      action` — the moderator told the system broke rather than that it
//      refused. This is the third near-miss of that exact drift (003, 016), so
//      the guard here is a test that reads the migration and the route and
//      fails when they disagree, not another comment.
//   2. A TAKEDOWN REACHED NOBODY until the victim happened to refetch. The ban
//      path force-disconnects sockets so a ban bites immediately; hiding a
//      message changed only what a future fetch returned, so the harassing DM
//      stayed on the victim's screen indefinitely.
//   3. THE VENUE OWNER'S REVIEW TAB IGNORED TAKEDOWNS. The public route filters
//      hidden reviews in both its stats and its list; the owner route did
//      neither, so a review taken down for harassing that owner was still served
//      to them in full and still moved the average they see. The reply route was
//      worse: no predicate at all, so it returned the whole row of a hidden
//      review and let business speech attach to it.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'unhide-path-test-secret';
delete process.env.VENUE_BILLING_ENABLED;

const pool = require('../config/database');

// ---------------------------------------------------------------------------
// Harness: scripted pg fake + a fake io, on ONE timeline so ordering is
// assertable (the emit must land after COMMIT, never before).
// ---------------------------------------------------------------------------
let handlers = [];
let log = [];
let emitted = [];

function dispatch(sql, params) {
  log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  for (const [re, fn] of handlers) {
    if (re.test(sql)) {
      const out = fn(params || [], String(sql));
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${String(sql).replace(/\s+/g, ' ').slice(0, 160)}`));
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      log.push({ sql: String(sql).trim(), params: null });
      return Promise.resolve({ rows: [] });
    }
    return dispatch(sql, params);
  },
  release: () => {},
});

let ioThrows = false;
const fakeIo = {
  to(room) {
    return {
      emit: (event, payload) => {
        if (ioThrows) throw new Error('socket layer exploded');
        emitted.push({ room, event, payload });
        log.push({ sql: `EMIT ${event} -> ${room}`, params: null });
      },
    };
  },
  in(room) {
    return { disconnectSockets: () => log.push({ sql: `DISCONNECT ${room}`, params: null }) };
  },
};

// Must be patched BEFORE the routers are required: admin.js destructures
// `authenticate` at require time and mounts it with router.use.
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 99, name: 'Mod', role: 'admin' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const adminRouter = require('../routes/admin');
const venueDashboardRouter = require('../routes/venueDashboard');

const app = express();
app.use(express.json());
app.set('io', fakeIo);
app.use('/api/admin', adminRouter);
app.use('/api/venue-dashboard', venueDashboardRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  emitted = [];
  ioThrows = false;
  CURRENT_USER = { id: 99, name: 'Mod', role: 'admin' };
});

async function call(method, path_, body) {
  const res = await fetch(base + path_, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: json, text };
}

const ran = (re) => log.filter((q) => re.test(q.sql));
const timeline = () => log.map((q) => q.sql);

// A report row of the given content type, with the two report columns the route
// reads. `content_id` 55 throughout.
function reportRow(contentType, over = {}) {
  return {
    id: 7,
    content_type: contentType,
    content_id: 55,
    reported_user_id: 3,
    reporter_id: 4,
    status: 'open',
    ...over,
  };
}

// The scripted set for a hide/un-hide against `table`, returning `audienceRow`
// from the takedown UPDATE.
function moderationHandlers(contentType, table, audienceRow, over = {}) {
  return [
    [/SELECT \* FROM content_reports WHERE id/, () => ({ rows: [reportRow(contentType, over)], rowCount: 1 })],
    [new RegExp(`UPDATE ${table} SET is_hidden`), () => (
      audienceRow === null
        ? { rows: [], rowCount: 0 }
        : { rows: [audienceRow], rowCount: 1 }
    )],
    [/UPDATE content_reports SET status/, () => ({ rows: [], rowCount: 1 })],
    [/INSERT INTO moderation_actions/, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [/SELECT user_id FROM flock_members/, () => ({ rows: [{ user_id: 11 }, { user_id: 12 }], rowCount: 2 })],
  ];
}

// ===========================================================================
// A. Migration 017 — the constraint the route change cannot ship without
// ===========================================================================

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const MIGRATION_017 = path.join(MIGRATIONS_DIR, '017_moderation_action_content_restored.sql');
const ADMIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');

// Every value routes/admin.js can ever assign to `actionType`, read out of the
// source rather than restated here — a restated list is a list that rots.
function actionTypesInAdminRoute() {
  const found = new Set();
  for (const m of ADMIN_SRC.matchAll(/actionType\s*=\s*([^;]+);/g)) {
    for (const q of m[1].matchAll(/'([a-z_]+)'/g)) found.add(q[1]);
  }
  return found;
}

function constraintValuesIn017() {
  const sql = fs.readFileSync(MIGRATION_017, 'utf8');
  const body = sql.slice(sql.indexOf('ADD CONSTRAINT'));
  const check = body.slice(body.indexOf('CHECK'));
  return new Set([...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
}

test('017 exists and is the only migration claiming that number', () => {
  assert.ok(fs.existsSync(MIGRATION_017), 'migration 017 must exist');
  const seventeens = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^017[_.]/.test(f));
  assert.deepStrictEqual(seventeens, ['017_moderation_action_content_restored.sql'],
    'exactly one 017, and 015/016 are not renumbered');
});

test('017 adds content_restored to the moderation_actions CHECK', () => {
  const values = constraintValuesIn017();
  assert.ok(values.has('content_restored'),
    'without this value the un-hide audit INSERT is a 23514 inside the transaction');
  // The pre-existing six survive: dropping one that historic rows hold would
  // fail this very migration.
  for (const kept of ['content_hidden', 'content_removed', 'user_warned', 'user_banned', 'user_unbanned', 'dismissed']) {
    assert.ok(values.has(kept), `${kept} must not be dropped from the constraint`);
  }
});

test('017 drops the old constraint before re-adding it', () => {
  const sql = fs.readFileSync(MIGRATION_017, 'utf8');
  assert.match(sql, /DROP CONSTRAINT IF EXISTS moderation_actions_action_check/);
  assert.ok(sql.indexOf('DROP CONSTRAINT') < sql.indexOf('ADD CONSTRAINT'),
    'ADD before DROP leaves the six-value constraint in place');
});

test('017 does not swallow its own failure', () => {
  // 003 and 016 use `EXCEPTION WHEN others THEN NULL`. db/migrate.js records the
  // filename in schema_migrations either way and never retries, so a swallowed
  // failure would mark this fix applied while the old constraint stood — the
  // exact silent drift the migration exists to end.
  const sql = fs.readFileSync(MIGRATION_017, 'utf8').replace(/^\s*--.*$/gm, '');
  assert.ok(!/EXCEPTION\s+WHEN/i.test(sql),
    'a swallowed ALTER is indistinguishable from a working one');
});

test('DRIFT GUARD: every action routes/admin.js writes is legal under 017', () => {
  const written = actionTypesInAdminRoute();
  const allowed = constraintValuesIn017();
  assert.ok(written.size >= 4, 'the scrape found the assignments it is supposed to find');
  assert.ok(written.has('content_restored'), 'the un-hide path must be writing the new value');
  for (const a of written) {
    assert.ok(allowed.has(a),
      `routes/admin.js writes moderation_actions.action = '${a}' and the CHECK in 017 forbids it. ` +
      'This is the drift that shipped in 003 and again in 016: widen the constraint in the SAME commit.');
  }
});

test('DRIFT GUARD: routes/admin.js is still the only writer of moderation_actions.action', () => {
  // The guard above scrapes ONE file. That is only sufficient while one file
  // writes the column: a second INSERT anywhere else could carry a value the
  // constraint forbids and would 23514 in production without this failing.
  const roots = ['routes', 'services', 'sockets', 'utils', 'middleware'];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      if (/INSERT\s+INTO\s+moderation_actions/i.test(src)) offenders.push(path.basename(full));
    }
  };
  for (const r of roots) walk(path.join(__dirname, '..', r));
  assert.deepStrictEqual(offenders.sort(), ['admin.js'],
    'a new writer of moderation_actions.action must be added to the scrape above, ' +
    'or its value checked against the CHECK constraint in migration 017');
});

test('the baseline constraint really lacked a restored value (017 is not a no-op)', () => {
  const baseline = fs.readFileSync(path.join(MIGRATIONS_DIR, '001_baseline.sql'), 'utf8');
  const line = baseline.split('\n').find((l) => /action VARCHAR\(30\) NOT NULL CHECK/.test(l));
  assert.ok(line, 'the inline CHECK is still where 001 declares it');
  assert.ok(!line.includes('content_restored'));
});

// ===========================================================================
// B. The un-hide itself
// ===========================================================================

test('unhide is accepted, and an unknown action is still 400', async () => {
  handlers = moderationHandlers('flock_message', 'messages', { flock_id: 8, notify_a: null, notify_b: null });
  const ok = await call('PUT', '/api/admin/reports/7', { action: 'unhide' });
  assert.strictEqual(ok.status, 200);

  log = [];
  const bad = await call('PUT', '/api/admin/reports/7', { action: 'unpublish' });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.error, 'Invalid action');
  assert.strictEqual(ran(/UPDATE messages/).length, 0);
});

test('unhide writes is_hidden = false, not true', async () => {
  handlers = moderationHandlers('flock_message', 'messages', { flock_id: 8, notify_a: null, notify_b: null });
  await call('PUT', '/api/admin/reports/7', { action: 'unhide' });
  const upd = ran(/UPDATE messages SET is_hidden/);
  assert.strictEqual(upd.length, 1);
  assert.strictEqual(upd[0].params[0], false, 'the boolean is bound, not interpolated');
  assert.strictEqual(upd[0].params[1], 55);
});

test('hide still writes is_hidden = true and audits content_hidden', async () => {
  handlers = moderationHandlers('flock_message', 'messages', { flock_id: 8, notify_a: null, notify_b: null });
  const res = await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.action, 'content_hidden');
  assert.strictEqual(res.body.status, 'resolved');
  assert.strictEqual(ran(/UPDATE messages SET is_hidden/)[0].params[0], true);
  assert.strictEqual(ran(/INSERT INTO moderation_actions/)[0].params[3], 'content_hidden');
});

test('unhide audits content_restored', async () => {
  handlers = moderationHandlers('dm', 'direct_messages', { flock_id: null, notify_a: 3, notify_b: 4 });
  const res = await call('PUT', '/api/admin/reports/7', { action: 'unhide' });
  assert.strictEqual(res.body.action, 'content_restored');
  const audit = ran(/INSERT INTO moderation_actions/)[0];
  assert.strictEqual(audit.params[3], 'content_restored');
  // Same transaction as the mutation, which is why 017 has to exist.
  const t = timeline();
  assert.ok(t.indexOf('BEGIN') < t.findIndex((s) => /INSERT INTO moderation_actions/.test(s)));
  assert.ok(t.findIndex((s) => /INSERT INTO moderation_actions/.test(s)) < t.indexOf('COMMIT'));
});

test('JUDGEMENT: an un-hide resolves the report as dismissed, not resolved', async () => {
  handlers = moderationHandlers('story', 'stories', { flock_id: null, notify_a: 3, notify_b: null });
  const res = await call('PUT', '/api/admin/reports/7', { action: 'unhide' });
  // `resolved` is this queue's word for "the complaint was upheld". Putting the
  // content back is the opposite finding, and recording it as resolved would
  // count a reversed takedown in the same header tally as the ones we stand
  // behind — the very number you would check to find out how often we get this
  // wrong.
  assert.strictEqual(res.body.status, 'dismissed');
  assert.strictEqual(ran(/UPDATE content_reports SET status/)[0].params[0], 'dismissed');
});

test('hide, ban, unban and dismiss keep the status they had', async () => {
  const expected = { hide: 'resolved', ban: 'resolved', unban: 'resolved', dismiss: 'dismissed' };
  for (const [action, status] of Object.entries(expected)) {
    handlers = [
      ...moderationHandlers('flock_message', 'messages', { flock_id: 8, notify_a: null, notify_b: null }),
      [/UPDATE users SET is_banned/, () => ({ rows: [], rowCount: 1 })],
    ];
    log = [];
    const res = await call('PUT', '/api/admin/reports/7', { action });
    assert.strictEqual(res.body.status, status, `${action} must still resolve as ${status}`);
  }
});

test('unhide on a profile report refuses and names the alternative', async () => {
  handlers = [
    [/SELECT \* FROM content_reports WHERE id/, () => ({ rows: [reportRow('profile')], rowCount: 1 })],
  ];
  const res = await call('PUT', '/api/admin/reports/7', { action: 'unhide' });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /restore/);
  assert.match(res.body.error, /Unban/);
  // Nothing was written, and the report was NOT marked handled.
  assert.strictEqual(ran(/UPDATE content_reports SET status/).length, 0);
  assert.strictEqual(ran(/INSERT INTO moderation_actions/).length, 0);
  assert.ok(timeline().includes('ROLLBACK'));
});

test('COPY: every refusal this route can send passes the SLOP rules', async () => {
  // Rule 1 (no em dashes in user-visible text) and rule 5 (never name a feature
  // that is not in the shipping build). Nothing in backend/services/ emails a
  // content author about a takedown, so no refusal may point at one.
  const seen = [];
  const scenarios = [
    ['profile', null, 'hide'], ['profile', null, 'unhide'],
    ['venue_review', null, 'hide'], ['venue_review', null, 'unhide'],
  ];
  for (const [type, audienceRow, action] of scenarios) {
    handlers = moderationHandlers(type, 'venue_reviews', audienceRow);
    log = [];
    const res = await call('PUT', '/api/admin/reports/7', { action });
    assert.ok(res.status >= 400, `${type}/${action} must refuse`);
    seen.push(res.body.error);
  }
  assert.strictEqual(seen.length, 4);
  for (const line of seen) {
    assert.ok(!line.includes('—'), `em dash in: ${line}`);
    assert.ok(!/email|support ticket|appeal/i.test(line),
      `names a channel that does not exist: ${line}`);
    // Every refusal has to leave the moderator an action they can actually take.
    assert.match(line, /dismiss the report|Dismiss the report/, line);
  }
});

test('unhide of content that no longer exists is a 404 and audits nothing', async () => {
  handlers = moderationHandlers('venue_review', 'venue_reviews', null);
  const res = await call('PUT', '/api/admin/reports/7', { action: 'unhide' });
  assert.strictEqual(res.status, 404);
  assert.match(res.body.error, /nothing to restore/);
  assert.strictEqual(ran(/INSERT INTO moderation_actions/).length, 0);
  assert.ok(timeline().includes('ROLLBACK'));
  assert.strictEqual(emitted.length, 0, 'a rolled-back action must tell nobody');
});

test('the takedown table is chosen from the fixed map, never from the request', async () => {
  // The one place a table name is interpolated. Feeding a content_type that is
  // not a key must not produce SQL, and must not be reported as success.
  for (const bogus of ['users', 'venue_events; DROP TABLE users', '']) {
    handlers = [
      [/SELECT \* FROM content_reports WHERE id/, () => ({ rows: [reportRow(bogus)], rowCount: 1 })],
    ];
    log = [];
    const res = await call('PUT', '/api/admin/reports/7', { action: 'unhide' });
    assert.strictEqual(res.status, 400, `content_type ${JSON.stringify(bogus)} must refuse`);
    assert.strictEqual(ran(/SET is_hidden/).length, 0);
  }
});

test('the hoisted map still covers every hideable type, both directions', async () => {
  const cases = [
    ['flock_message', 'messages'],
    ['dm', 'direct_messages'],
    ['story', 'stories'],
    ['venue_review', 'venue_reviews'],
    ['venue_promotion', 'venue_promotions'],
    ['guest_rsvp', 'guest_rsvps'],
  ];
  for (const [type, table] of cases) {
    for (const action of ['hide', 'unhide']) {
      handlers = moderationHandlers(type, table, { flock_id: null, notify_a: 3, notify_b: null });
      log = [];
      const res = await call('PUT', '/api/admin/reports/7', { action });
      assert.strictEqual(res.status, 200, `${action} ${type}`);
      assert.strictEqual(ran(new RegExp(`UPDATE ${table} SET is_hidden`)).length, 1, `${action} ${type}`);
    }
  }
});

// ===========================================================================
// C. A takedown reaches the people looking at it
// ===========================================================================

test('a hidden flock message is announced to the flock members', async () => {
  handlers = moderationHandlers('flock_message', 'messages', { flock_id: 8, notify_a: null, notify_b: null });
  const res = await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  assert.strictEqual(res.status, 200);
  // Per-member fan-out through emitToFlockMembers, whose membership read is the
  // thing that makes it safe. Never the `flock:{id}` room, which is not a
  // membership list.
  assert.deepStrictEqual(emitted.map((e) => e.room).sort(), ['user:11', 'user:12']);
  assert.ok(emitted.every((e) => e.event === 'content_removed'));
  assert.strictEqual(ran(/SELECT user_id FROM flock_members/).length, 1);
});

test('a hidden guest RSVP is announced to the flock, and to no personal room', async () => {
  handlers = moderationHandlers('guest_rsvp', 'guest_rsvps', { flock_id: 8, notify_a: null, notify_b: null });
  await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  assert.deepStrictEqual(emitted.map((e) => e.room).sort(), ['user:11', 'user:12']);
  // A guest has no account, so there is nobody personal to tell.
  assert.strictEqual(emitted[0].payload.contentType, 'guest_rsvp');
});

test('a hidden DM reaches BOTH participants', async () => {
  handlers = moderationHandlers('dm', 'direct_messages', { flock_id: null, notify_a: 3, notify_b: 4 });
  await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  assert.deepStrictEqual(emitted.map((e) => e.room).sort(), ['user:3', 'user:4']);
  // No flock lookup for a DM.
  assert.strictEqual(ran(/SELECT user_id FROM flock_members/).length, 0);
});

test('stories and venue reviews reach their author; promotions reach the venue owner', async () => {
  const cases = [
    ['story', 'stories'],
    ['venue_review', 'venue_reviews'],
    ['venue_promotion', 'venue_promotions'],
  ];
  for (const [type, table] of cases) {
    handlers = moderationHandlers(type, table, { flock_id: null, notify_a: 21, notify_b: null });
    log = [];
    emitted = [];
    await call('PUT', '/api/admin/reports/7', { action: 'hide' });
    assert.deepStrictEqual(emitted.map((e) => e.room), ['user:21'], type);
  }
});

test('an un-hide announces content_restored, not content_removed', async () => {
  handlers = moderationHandlers('dm', 'direct_messages', { flock_id: null, notify_a: 3, notify_b: 4 });
  await call('PUT', '/api/admin/reports/7', { action: 'unhide' });
  assert.ok(emitted.length > 0);
  assert.ok(emitted.every((e) => e.event === 'content_restored'),
    'a client that already dropped the row needs a different instruction than one that still has it');
});

test('the announcement carries nothing about the reporter, the moderator or the reason', async () => {
  handlers = moderationHandlers('dm', 'direct_messages', { flock_id: null, notify_a: 3, notify_b: 4 });
  await call('PUT', '/api/admin/reports/7', { action: 'hide', reason: 'racist slur, ticket #91' });
  const payload = emitted[0].payload;
  assert.deepStrictEqual(Object.keys(payload).sort(), ['contentId', 'contentType', 'flockId']);
  const asText = JSON.stringify(payload);
  assert.ok(!/ticket #91|racist/.test(asText), 'moderator notes are written for moderators');
  assert.ok(!asText.includes('"reporterId"') && !asText.includes('"moderatorId"'));
  // The reporter's identity is the one thing a report must never hand back.
  assert.ok(!asText.includes('4') || payload.contentId === 55);
});

test('the announcement happens AFTER commit, never before', async () => {
  handlers = moderationHandlers('flock_message', 'messages', { flock_id: 8, notify_a: null, notify_b: null });
  await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  const t = timeline();
  const commit = t.indexOf('COMMIT');
  const firstEmit = t.findIndex((s) => /^EMIT /.test(s));
  assert.ok(commit >= 0 && firstEmit >= 0);
  assert.ok(commit < firstEmit, 'a rolled-back takedown must never tell anyone their content is gone');
});

test('a socket failure does not turn a committed takedown into a 500', async () => {
  handlers = moderationHandlers('dm', 'direct_messages', { flock_id: null, notify_a: 3, notify_b: 4 });
  ioThrows = true;
  const realError = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const res = await call('PUT', '/api/admin/reports/7', { action: 'hide' });
    // The content IS hidden and the audit row IS written. Answering 500 would
    // invite the moderator to run the takedown again.
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.action, 'content_hidden');
    assert.ok(timeline().includes('COMMIT'));
    assert.match(errors.join('\n'), /notify failed/i);
  } finally { console.error = realError; }
});

test('with no io on the app the takedown still succeeds', async () => {
  handlers = moderationHandlers('story', 'stories', { flock_id: null, notify_a: 3, notify_b: null });
  app.set('io', null);
  try {
    const res = await call('PUT', '/api/admin/reports/7', { action: 'hide' });
    assert.strictEqual(res.status, 200);
  } finally { app.set('io', fakeIo); }
});

test('a ban still force-disconnects and announces nothing about content', async () => {
  handlers = [
    [/SELECT \* FROM content_reports WHERE id/, () => ({ rows: [reportRow('profile')], rowCount: 1 })],
    [/UPDATE users SET is_banned/, () => ({ rows: [], rowCount: 1 })],
    [/UPDATE content_reports SET status/, () => ({ rows: [], rowCount: 1 })],
    [/INSERT INTO moderation_actions/, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ];
  const res = await call('PUT', '/api/admin/reports/7', { action: 'ban' });
  assert.strictEqual(res.status, 200);
  assert.ok(timeline().includes('DISCONNECT user:3'));
  assert.strictEqual(emitted.length, 0);
});

// ===========================================================================
// D. The venue owner's review tab
// ===========================================================================

const OWNER = { id: 1, name: 'Ava', role: 'venue_owner' };
const venueCtx = [/SELECT id, google_place_id, verified, category, verification_requested_at FROM venue_profiles/, () => ({
  rows: [{ id: 7, google_place_id: 'place-1', verified: true }], rowCount: 1,
})];

test('the owner review stats exclude hidden reviews', async () => {
  CURRENT_USER = OWNER;
  handlers = [
    venueCtx,
    [/COUNT\(\*\) FILTER \(WHERE vr.rating = 1\)/, () => ({ rows: [{ total: 2, average: 4.5, r1: 0, r2: 0, r3: 0, r4: 1, r5: 1 }] })],
    [/SELECT vr\.\*, u.name, u.profile_image_url/, () => ({ rows: [] })],
  ];
  const res = await call('GET', '/api/venue-dashboard/reviews');
  assert.strictEqual(res.status, 200);
  const stats = ran(/COUNT\(\*\) FILTER/)[0].sql;
  assert.match(stats, /COALESCE\(vr.is_hidden, false\) = false/,
    'a hidden review moved the average the owner sees, forever disagreeing with the public number');
});

test('the owner review list excludes hidden reviews, with the SAME predicate as its stats', async () => {
  CURRENT_USER = OWNER;
  handlers = [
    venueCtx,
    [/COUNT\(\*\) FILTER \(WHERE vr.rating = 1\)/, () => ({ rows: [{ total: 0, average: null }] })],
    [/SELECT vr\.\*, u.name, u.profile_image_url/, () => ({ rows: [] })],
  ];
  await call('GET', '/api/venue-dashboard/reviews');
  const list = ran(/SELECT vr\.\*, u.name/)[0].sql;
  assert.match(list, /COALESCE\(vr.is_hidden, false\) = false/);
  // If the two ever disagree the count and the rows describe different sets.
  const stats = ran(/COUNT\(\*\) FILTER/)[0].sql;
  const pred = /COALESCE\(vr\.is_hidden, false\) = false/;
  assert.ok(pred.test(list) && pred.test(stats));
});

test('the owner cannot reply to a hidden review, and gets none of its text back', async () => {
  CURRENT_USER = OWNER;
  handlers = [
    venueCtx,
    // The takedown predicate is now part of the WHERE, so a hidden row matches
    // nothing and the UPDATE writes nothing.
    [/UPDATE venue_reviews SET venue_reply/, () => ({ rows: [], rowCount: 0 })],
  ];
  const res = await call('POST', '/api/venue-dashboard/reviews/55/reply', { reply: 'thanks' });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, 'Review not found');
  const upd = ran(/UPDATE venue_reviews SET venue_reply/)[0];
  assert.match(upd.sql, /COALESCE\(is_hidden, false\) = false/,
    'without this the route returned the whole row of a taken-down review');
  assert.ok(!res.text.includes('rating'), 'no part of the hidden row may come back');
});

test('replying to a visible review still works', async () => {
  CURRENT_USER = OWNER;
  handlers = [
    venueCtx,
    [/UPDATE venue_reviews SET venue_reply/, () => ({ rows: [{ id: 55, rating: 5, venue_reply: 'thanks' }], rowCount: 1 })],
  ];
  const res = await call('POST', '/api/venue-dashboard/reviews/55/reply', { reply: 'thanks' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.venue_reply, 'thanks');
});

// ===========================================================================
// E. Promotions: visible to their author, marked, and not editable
// ===========================================================================

test('a hidden promotion stays in the owner list and is marked', async () => {
  CURRENT_USER = OWNER;
  handlers = [
    venueCtx,
    [/SELECT \* FROM venue_promotions WHERE venue_user_id/, () => ({
      rows: [
        { id: 1, title: 'Live', is_hidden: false },
        { id: 2, title: 'Taken down', is_hidden: true },
      ],
    })],
  ];
  const res = await call('GET', '/api/venue-dashboard/promotions');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.promotions.length, 2, 'the author still sees their own copy');
  assert.strictEqual(res.body.promotions[0].hidden_by_moderation, false);
  assert.strictEqual(res.body.promotions[1].hidden_by_moderation, true,
    'unmarked, the dashboard shows a taken-down promotion as running');
});

test('a null is_hidden is marked false, not undefined', async () => {
  CURRENT_USER = OWNER;
  handlers = [
    venueCtx,
    [/SELECT \* FROM venue_promotions WHERE venue_user_id/, () => ({ rows: [{ id: 1, title: 'Old row', is_hidden: null }] })],
  ];
  const res = await call('GET', '/api/venue-dashboard/promotions');
  assert.strictEqual(res.body.promotions[0].hidden_by_moderation, false);
});

test('editing a hidden promotion is refused and the takedown is named', async () => {
  CURRENT_USER = OWNER;
  handlers = [
    // target exists and is hidden, so the UPDATE half of the CTE produced no row.
    [/WITH target AS/, () => ({ rows: [{ target_hidden: true, id: null, title: null }], rowCount: 1 })],
  ];
  const res = await call('PUT', '/api/venue-dashboard/promotions/2', { title: 'New title' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.code, 'CONTENT_HIDDEN');
  assert.match(res.body.error, /taken down by moderation/);
  // SLOP-AUDIT.md rule 1: no em dashes in user-visible copy.
  assert.ok(!res.body.error.includes('—'));
});

test('the refusal and the write are one statement, so nothing can slip between them', async () => {
  CURRENT_USER = OWNER;
  handlers = [[/WITH target AS/, () => ({ rows: [{ target_hidden: true, id: null }], rowCount: 1 })]];
  await call('PUT', '/api/venue-dashboard/promotions/2', { title: 'New title' });
  assert.strictEqual(ran(/venue_promotions/).length, 1, 'no SELECT-then-UPDATE window');
  const sql = ran(/venue_promotions/)[0].sql;
  assert.match(sql, /EXISTS \(SELECT 1 FROM target t WHERE t.is_hidden = false\)/);
});

test('editing a visible promotion still succeeds and leaks no internal column', async () => {
  CURRENT_USER = OWNER;
  handlers = [
    [/WITH target AS/, () => ({ rows: [{ target_hidden: false, id: 2, title: 'New title', is_hidden: false }], rowCount: 1 })],
  ];
  const res = await call('PUT', '/api/venue-dashboard/promotions/2', { title: 'New title' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.title, 'New title');
  assert.ok(!('target_hidden' in res.body), 'the CTE bookkeeping column is not part of the API');
});

test('a promotion that is not yours is still a 404, not the takedown message', async () => {
  CURRENT_USER = OWNER;
  handlers = [[/WITH target AS/, () => ({ rows: [], rowCount: 0 })]];
  const res = await call('PUT', '/api/venue-dashboard/promotions/999', { title: 'x' });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, 'Promotion not found');
});

test('a non-numeric promotion id is still refused before any query', async () => {
  CURRENT_USER = OWNER;
  handlers = [];
  const res = await call('PUT', '/api/venue-dashboard/promotions/abc', { title: 'x' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(ran(/venue_promotions/).length, 0);
});
