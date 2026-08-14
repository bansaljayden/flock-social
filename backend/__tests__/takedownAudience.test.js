// Run: node --test  (from backend/)
//
// Round 22 — WHO A TAKEDOWN REACHES, re-decided on current facts.
//
// Round 20 wrote an honest table into routes/admin.js saying that four of the
// seven takedown types reach the author and nobody else, and gave a reason for
// leaving them that way whose load-bearing half was "nothing on the client
// listens for content_removed, for any type". A listener has since landed
// (frontend/src/services/socket.js registers both events through the
// reconnect-replaying registry; frontend/src/App.js has a per-type handler), so
// the reason expired and the decision is re-made rather than re-explained.
//
// What this file pins:
//
//   1. venue_review and venue_promotion now reach the VIEWERS. Those two are
//      served publicly off a venue card (/public-reviews, /public-promotions)
//      into state that nothing refetches while the card is open, so a takedown
//      that told only the author left the content on every open card until the
//      app was reloaded.
//   2. The room they reach is `venue_content:{placeId}`, NOT `venue:{placeId}`.
//      The crowd room is joined off the map bottom sheet and off the venue
//      OWNER's dashboard, so it misses every card opened from a flock, a search
//      result or a chat share, and it delivers to two surfaces that hold none
//      of this state. A grep here refuses the shortcut.
//   3. story and venue_event stay narrow, on reasons that are true TODAY:
//      nothing serves venue events publicly (no /public-events twin exists) and
//      the launch client renders no stories at all. Both are pinned to the
//      evidence rather than to a comment, so the day either changes this file
//      goes red instead of the claim going quietly stale.
//   4. A RESTORE reaches exactly the audience the REMOVAL did. An audience that
//      is wider on the way down than on the way back up is content that
//      vanishes for people and never returns.
//   5. Everything round 18 and 20 already guaranteed still holds with the new
//      room in play: the emit is after COMMIT, a refused or rolled-back
//      takedown tells nobody at all, and the payload is still the same three
//      keys with no moderator, reason or reporter on it.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'takedown-audience-test-secret';

const pool = require('../config/database');

// ---------------------------------------------------------------------------
// Harness — the shape __tests__/unhidePath.test.js uses: a scripted pg fake and
// a fake io on ONE timeline, so ordering (emit after COMMIT) is assertable and
// an unscripted query is a loud failure rather than a silent empty result.
// ---------------------------------------------------------------------------
let handlers = [];
let log = [];
let emitted = [];

function dispatch(sql, params) {
  log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  for (const [re, fn] of handlers) {
    if (re.test(sql)) {
      const out = fn(params || [], String(sql));
      if (out && typeof out.then === 'function') return out;
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

const fakeIo = {
  to(room) {
    return {
      emit: (event, payload) => {
        emitted.push({ room, event, payload });
        log.push({ sql: `EMIT ${event} -> ${room}`, params: null });
      },
    };
  },
  in(room) {
    return { disconnectSockets: () => log.push({ sql: `DISCONNECT ${room}`, params: null }) };
  },
};

// Patched BEFORE the router is required: admin.js destructures `authenticate`
// at require time and mounts it with router.use.
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 99, name: 'Mod', role: 'admin' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

// pushHelper is destructured at module load by sockets/handlers.js, which
// admin.js requires for the two room helpers.
const pushMod = require('../services/pushHelper');
pushMod.pushIfOffline = async () => ({ skipped: true });
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true });

const adminRouter = require('../routes/admin');
const {
  registerHandlers,
  emitToVenueContentViewers,
  VENUE_CONTENT_ROOM,
  __resetRateLimiters,
} = require('../sockets/handlers');
const { clearKnownVenueCache } = require('../utils/places');

const app = express();
app.use(express.json());
app.set('io', fakeIo);
app.use('/api/admin', adminRouter);

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
  CURRENT_USER = { id: 99, name: 'Mod', role: 'admin' };
  clearKnownVenueCache();
  __resetRateLimiters();
});

async function call(method, path_, body) {
  const res = await fetch(base + path_, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

const ran = (re) => log.filter((q) => re.test(q.sql));
const timeline = () => log.map((q) => q.sql);
const rooms = () => emitted.map((e) => e.room).sort();

const PLACE = 'ChIJtakedownAudience_01';
const OTHER_PLACE = 'ChIJtakedownAudience_02';

const ADMIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
const HANDLERS_SRC = fs.readFileSync(path.join(__dirname, '..', 'sockets', 'handlers.js'), 'utf8');
const VENUE_DASH_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'venueDashboard.js'), 'utf8');

function reportRow(contentType, over = {}) {
  return { id: 7, content_type: contentType, content_id: 55, reported_user_id: 3, reporter_id: 4, status: 'open', ...over };
}

// Scripts one whole PUT /reports/:id round trip. `returning` is the row the
// takedown UPDATE hands back, which is where the audience comes from.
function script(contentType, table, returning) {
  return [
    [/SELECT \* FROM content_reports WHERE id/, () => ({ rows: [reportRow(contentType)], rowCount: 1 })],
    [new RegExp(`UPDATE ${table} SET is_hidden`), () => (
      returning ? { rows: [returning], rowCount: 1 } : { rows: [], rowCount: 0 }
    )],
    [/SELECT user_id FROM flock_members/, () => ({ rows: [{ user_id: 11 }, { user_id: 12 }] })],
    [/UPDATE content_reports SET status/, () => ({ rows: [], rowCount: 1 })],
    [/INSERT INTO moderation_actions/, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ];
}

// ===========================================================================
// A. The two types that were widened
// ===========================================================================

test('a hidden venue review reaches its author AND everyone holding that venue card', async () => {
  // THE BUG: /public-reviews fills `venueDetailReviews` in frontend/src/App.js
  // and nothing refetches it while the card is open, so a review taken down for
  // harassment stayed on every open venue card until somebody reloaded. The
  // author was the only person told.
  handlers = script('venue_review', 'venue_reviews', { flock_id: null, notify_a: 21, notify_b: null, place_id: PLACE });
  const res = await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(rooms(), ['user:21', `venue_content:${PLACE}`]);
  assert.ok(emitted.every((e) => e.event === 'content_removed'));
});

test('a hidden venue promotion reaches the owner AND everyone holding that venue card', async () => {
  handlers = script('venue_promotion', 'venue_promotions', { flock_id: null, notify_a: 21, notify_b: null, place_id: PLACE });
  await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  assert.deepStrictEqual(rooms(), ['user:21', `venue_content:${PLACE}`]);
});

test('the takedown asks the row for its place id, in the same statement as the user ids', async () => {
  // Reading google_place_id in a SECOND query would read a world the takedown
  // has already changed, and on a rollback it would name a venue about an event
  // that never happened. Same reasoning the flock_id capture is built on.
  handlers = script('venue_review', 'venue_reviews', { flock_id: null, notify_a: 21, notify_b: null, place_id: PLACE });
  await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  const update = ran(/UPDATE venue_reviews SET is_hidden/)[0];
  assert.match(update.sql, /RETURNING .*google_place_id AS place_id/);
  assert.strictEqual(ran(/SELECT .*google_place_id FROM venue_reviews/).length, 0,
    'the place id must come from the RETURNING, not from a second read');
});

test('the room emit carries the identical payload the personal emit does', async () => {
  handlers = script('venue_review', 'venue_reviews', { flock_id: null, notify_a: 21, notify_b: null, place_id: PLACE });
  await call('PUT', '/api/admin/reports/7', { action: 'hide', reason: 'racist slur, ticket #91' });
  const personal = emitted.find((e) => e.room === 'user:21');
  const room = emitted.find((e) => e.room.startsWith('venue_content:'));
  assert.ok(personal && room);
  assert.deepStrictEqual(room.payload, personal.payload);
  // Three keys, still. The room is PUBLIC in the sense that any signed-in
  // account can join it for a known venue, so anything extra on this payload is
  // handed to strangers rather than to the author.
  assert.deepStrictEqual(Object.keys(room.payload).sort(), ['contentId', 'contentType', 'flockId']);
  const asText = JSON.stringify(room.payload);
  assert.ok(!/ticket #91|racist/.test(asText), 'moderator notes are written for moderators');
  assert.ok(!asText.includes('placeId'), 'the room addresses the venue; the payload need not name it');
});

test('the author is told first, so a room failure cannot cost them the notice', async () => {
  handlers = script('venue_review', 'venue_reviews', { flock_id: null, notify_a: 21, notify_b: null, place_id: PLACE });
  await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  const order = emitted.map((e) => e.room);
  assert.strictEqual(order[0], 'user:21');
  assert.strictEqual(order[1], `venue_content:${PLACE}`);
});

// ===========================================================================
// B. Restore reaches exactly what removal reached
// ===========================================================================
//
// An audience wider on removal than on restoration is content that vanishes for
// people and never comes back — the failure mode that is invisible until a
// moderator reverses a mistake and half the app never hears about it.

test('every type restores to exactly the audience it was removed from', async () => {
  const cases = [
    ['flock_message', 'messages', { flock_id: 8, notify_a: null, notify_b: null, place_id: null }],
    ['guest_rsvp', 'guest_rsvps', { flock_id: 8, notify_a: null, notify_b: null, place_id: null }],
    ['dm', 'direct_messages', { flock_id: null, notify_a: 3, notify_b: 4, place_id: null }],
    ['story', 'stories', { flock_id: null, notify_a: 21, notify_b: null, place_id: null }],
    ['venue_event', 'venue_events', { flock_id: null, notify_a: 21, notify_b: null, place_id: null }],
    ['venue_review', 'venue_reviews', { flock_id: null, notify_a: 21, notify_b: null, place_id: PLACE }],
    ['venue_promotion', 'venue_promotions', { flock_id: null, notify_a: 21, notify_b: null, place_id: PLACE }],
  ];
  for (const [type, table, returning] of cases) {
    const seen = {};
    for (const action of ['hide', 'unhide']) {
      handlers = script(type, table, returning);
      log = [];
      emitted = [];
      // eslint-disable-next-line no-await-in-loop
      const res = await call('PUT', `/api/admin/reports/7`, { action });
      assert.strictEqual(res.status, 200, `${action} ${type}: ${res.text}`);
      assert.ok(emitted.length > 0, `${action} ${type} told nobody`);
      seen[action] = rooms();
      assert.ok(
        emitted.every((e) => e.event === (action === 'hide' ? 'content_removed' : 'content_restored')),
        `${action} ${type} used the wrong event name`
      );
    }
    assert.deepStrictEqual(seen.unhide, seen.hide,
      `${type}: a restore must reach the same people the removal did, or the content never comes back for the difference`);
  }
});

// ===========================================================================
// C. The types that stay narrow, pinned to the reason rather than the comment
// ===========================================================================

test('story reaches its author and never a venue room', async () => {
  handlers = script('story', 'stories', { flock_id: null, notify_a: 21, notify_b: null, place_id: null });
  await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  assert.deepStrictEqual(rooms(), ['user:21']);
});

test('venue_event reaches the owner and never a venue room, because nothing serves events publicly', async () => {
  handlers = script('venue_event', 'venue_events', { flock_id: null, notify_a: 21, notify_b: null, place_id: null });
  await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  assert.deepStrictEqual(rooms(), ['user:21']);
});

test('the venue_event decision is tied to the absence of a public events route', () => {
  // The claim in the TAKEDOWN_TARGETS comment, checked instead of trusted. The
  // day a /public-events route lands, this goes red and the map entry is the
  // fix — which is the drift this repo has shipped three times (003, 016, 017).
  assert.match(VENUE_DASH_SRC, /router\.get\('\/public-reviews\/:placeId'/);
  assert.match(VENUE_DASH_SRC, /router\.get\('\/public-promotions\/:placeId'/);
  const publicRoutes = [...VENUE_DASH_SRC.matchAll(/router\.get\('\/(public-[a-z-]+)/g)].map((m) => m[1]);
  assert.deepStrictEqual(publicRoutes.sort(), ['public-promotions', 'public-reviews'],
    'a new public venue route means a new set of viewers; give its content type a place_id in TAKEDOWN_TARGETS');
});

test('the story decision is tied to the absence of a story reader in the client', () => {
  // Round 20 named story as the type to widen FIRST. On current facts it is the
  // one to widen LAST: the audience is buildable (utils/relationships.js) and
  // the fan-out is cheap at a moderator's click rate, but the launch client has
  // no story UI at all, so there is nobody to tell. That is the whole reason,
  // and it is checkable.
  const appSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'App.js'), 'utf8'
  );
  assert.ok(!/\bgetStories\b/.test(appSrc),
    'App.js reads stories now. Widening the story takedown is owed by the same commit: ' +
    'build the audience with storyVisibilitySql and fan out to the personal rooms.');
  // And the reason recorded in admin.js must be THAT one, not the cost argument
  // round 20 leaned on.
  const block = ADMIN_SRC.slice(ADMIN_SRC.indexOf('ROUND 22'), ADMIN_SRC.indexOf('const TAKEDOWN_TARGETS'));
  assert.match(block, /getStories/,
    'the reason story stays narrow has to name the evidence, so the next reader can check it');
});

// ===========================================================================
// D. Nothing addresses a room it should not
// ===========================================================================

test('a takedown with no place id on the row tells only the personal rooms', async () => {
  // venue_promotions.google_place_id is NULLABLE, so this is a real row, not a
  // hypothetical: a promotion drafted before a place was attached.
  handlers = script('venue_promotion', 'venue_promotions', { flock_id: null, notify_a: 21, notify_b: null, place_id: null });
  await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  assert.deepStrictEqual(rooms(), ['user:21']);
});

test('a malformed stored place id never becomes a room name', async () => {
  // google_place_id is a plain VARCHAR with no format constraint and is written
  // from a client-supplied string on the venue claim path. It is the one value
  // in this flow that reaches a room name from storage.
  for (const bogus of ['', '  ', 'a', 'has space', 'has/slash', 'x'.repeat(200), 'a:b', null, 42, {}]) {
    handlers = script('venue_review', 'venue_reviews', { flock_id: null, notify_a: 21, notify_b: null, place_id: bogus });
    log = [];
    emitted = [];
    // eslint-disable-next-line no-await-in-loop
    const res = await call('PUT', '/api/admin/reports/7', { action: 'hide' });
    assert.strictEqual(res.status, 200, `${JSON.stringify(bogus)}: ${res.text}`);
    assert.deepStrictEqual(rooms(), ['user:21'], `place_id ${JSON.stringify(bogus)} produced a room`);
  }
});

test('no takedown of any type ever addresses the crowd room', async () => {
  const cases = [
    ['flock_message', 'messages', { flock_id: 8, notify_a: null, notify_b: null, place_id: PLACE }],
    ['guest_rsvp', 'guest_rsvps', { flock_id: 8, notify_a: null, notify_b: null, place_id: PLACE }],
    ['dm', 'direct_messages', { flock_id: null, notify_a: 3, notify_b: 4, place_id: PLACE }],
    ['story', 'stories', { flock_id: null, notify_a: 21, notify_b: null, place_id: PLACE }],
    ['venue_event', 'venue_events', { flock_id: null, notify_a: 21, notify_b: null, place_id: PLACE }],
    ['venue_review', 'venue_reviews', { flock_id: null, notify_a: 21, notify_b: null, place_id: PLACE }],
    ['venue_promotion', 'venue_promotions', { flock_id: null, notify_a: 21, notify_b: null, place_id: PLACE }],
  ];
  // Every row is handed a place id, INCLUDING the types whose map entry selects
  // NULL. A row that carries one anyway must still not reach a room, because
  // what decides is the map entry and not whatever the table happens to hold.
  for (const [type, table, returning] of cases) {
    handlers = script(type, table, returning);
    emitted = [];
    // eslint-disable-next-line no-await-in-loop
    const res = await call('PUT', '/api/admin/reports/7', { action: 'hide' });
    assert.strictEqual(res.status, 200, `${type}: ${res.text}`);
    for (const e of emitted) {
      assert.ok(!/^venue:/.test(e.room),
        `${type} reached ${e.room}: the crowd room holds map-sheet subscribers and the venue owner's own dashboard, ` +
        'neither of which is the set of people holding this content');
    }
  }
});

test('routes/admin.js does not spell a venue room name itself', () => {
  // The room belongs to sockets/handlers.js. A route that builds the string is
  // how the join side and the emit side drift apart.
  const offenders = ADMIN_SRC.split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => !line.startsWith('//') && /`venue(_content)?:\$\{/.test(line));
  assert.deepStrictEqual(offenders, []);
  assert.match(ADMIN_SRC, /emitToVenueContentViewers/);
});

// ===========================================================================
// E. Everything rounds 18 and 20 guaranteed still holds with a room in play
// ===========================================================================

test('the room emit happens AFTER commit, never before', async () => {
  handlers = script('venue_review', 'venue_reviews', { flock_id: null, notify_a: 21, notify_b: null, place_id: PLACE });
  await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  const t = timeline();
  const commit = t.indexOf('COMMIT');
  assert.ok(commit >= 0);
  const emits = t.map((s, i) => ({ s, i })).filter(({ s }) => /^EMIT /.test(s));
  assert.strictEqual(emits.length, 2);
  for (const { s, i } of emits) {
    assert.ok(commit < i, `${s} landed before COMMIT`);
  }
});

test('a takedown of content that no longer exists tells the venue room nothing', async () => {
  // rowCount 0 => refusal => ROLLBACK. Round 18's rule, re-checked now that a
  // whole room could be told a public review was pulled when nothing was.
  for (const action of ['hide', 'unhide']) {
    handlers = script('venue_review', 'venue_reviews', null);
    log = [];
    emitted = [];
    // eslint-disable-next-line no-await-in-loop
    const res = await call('PUT', '/api/admin/reports/7', { action });
    assert.strictEqual(res.status, 404, action);
    assert.strictEqual(emitted.length, 0, `${action}: a rolled-back takedown must tell nobody`);
    assert.ok(timeline().includes('ROLLBACK'), action);
    assert.strictEqual(ran(/INSERT INTO moderation_actions/).length, 0, action);
  }
});

test('a takedown that dies inside the transaction tells the venue room nothing', async () => {
  handlers = [
    [/SELECT \* FROM content_reports WHERE id/, () => ({ rows: [reportRow('venue_review')], rowCount: 1 })],
    [/UPDATE venue_reviews SET is_hidden/, () => ({
      rows: [{ flock_id: null, notify_a: 21, notify_b: null, place_id: PLACE }], rowCount: 1,
    })],
    [/UPDATE content_reports SET status/, () => ({ rows: [], rowCount: 1 })],
    // The audit INSERT is the one that historically died (23514 on the CHECK).
    [/INSERT INTO moderation_actions/, () => Promise.reject(new Error('23514 check constraint'))],
  ];
  const realError = console.error;
  console.error = () => {};
  try {
    const res = await call('PUT', '/api/admin/reports/7', { action: 'hide' });
    assert.strictEqual(res.status, 500);
    assert.strictEqual(emitted.length, 0,
      'a whole venue card must not be told a review was pulled by an action that rolled back');
    assert.ok(timeline().includes('ROLLBACK'));
  } finally { console.error = realError; }
});

test('a report the map cannot action reaches neither a personal room nor a venue room', async () => {
  handlers = [[/SELECT \* FROM content_reports WHERE id/, () => ({ rows: [reportRow('profile', { content_id: null })], rowCount: 1 })]];
  const res = await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(emitted.length, 0);
});

test('a dismiss or a ban never addresses a venue room', async () => {
  handlers = [
    [/SELECT \* FROM content_reports WHERE id/, () => ({ rows: [reportRow('venue_review')], rowCount: 1 })],
    [/UPDATE content_reports SET status/, () => ({ rows: [], rowCount: 1 })],
    [/INSERT INTO moderation_actions/, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ];
  const res = await call('PUT', '/api/admin/reports/7', { action: 'dismiss' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(emitted.length, 0, 'dismissing a report changes no content');
  assert.strictEqual(ran(/SET is_hidden/).length, 0);
});

test('a socket failure on the room emit still leaves a committed takedown a 200', async () => {
  handlers = script('venue_review', 'venue_reviews', { flock_id: null, notify_a: 21, notify_b: null, place_id: PLACE });
  const realTo = fakeIo.to;
  fakeIo.to = (room) => ({
    emit: (event, payload) => {
      if (room.startsWith('venue_content:')) throw new Error('socket layer exploded');
      emitted.push({ room, event, payload });
    },
  });
  const realError = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const res = await call('PUT', '/api/admin/reports/7', { action: 'hide' });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.action, 'content_hidden');
    assert.deepStrictEqual(rooms(), ['user:21'], 'the author is told before the room, so they keep the notice');
    assert.match(errors.join('\n'), /notify failed/i);
  } finally {
    fakeIo.to = realTo;
    console.error = realError;
  }
});

// ===========================================================================
// F. The map itself
// ===========================================================================

function takedownTargets() {
  const start = ADMIN_SRC.indexOf('const TAKEDOWN_TARGETS = {');
  assert.ok(start > 0);
  const body = ADMIN_SRC.slice(start, ADMIN_SRC.indexOf('\n};', start));
  const out = new Map();
  for (const m of body.matchAll(/^ {2}([a-z_]+): \{ table: '([a-z_]+)', audience: '([^']+)' \},$/gm)) {
    out.set(m[1], { table: m[2], audience: m[3] });
  }
  return out;
}

test('every entry returns the same three aliases, so the caller never branches', () => {
  const targets = takedownTargets();
  assert.strictEqual(targets.size, 7, 'the map must still be seven single-line entries');
  for (const [type, { audience }] of targets) {
    for (const alias of ['flock_id', 'notify_a', 'notify_b', 'place_id']) {
      assert.ok(new RegExp(`(^|AS )${alias}(,|$)`).test(audience),
        `${type} does not return ${alias}; the emit block reads all four off one row`);
    }
  }
});

test('exactly the two publicly served venue types select a real place id', () => {
  const targets = takedownTargets();
  const withPlace = [...targets]
    .filter(([, { audience }]) => /google_place_id AS place_id/.test(audience))
    .map(([type]) => type)
    .sort();
  assert.deepStrictEqual(withPlace, ['venue_promotion', 'venue_review'],
    'widening a type means there is a public route serving it; narrowing one means there is not');
  // And the others must say NULL explicitly rather than omitting the column,
  // which would be a 42703 inside the takedown transaction.
  for (const [type, { audience }] of targets) {
    if (withPlace.includes(type)) continue;
    assert.match(audience, /NULL::text AS place_id/, type);
  }
});

test('the stale round 20 reason is gone, not merely contradicted', () => {
  // "Not widening is an acceptable outcome; leaving a false reason in the code
  // is not." The sentence that was false is the one that has to go.
  assert.ok(!ADMIN_SRC.includes('frontend/src for ANY type'),
    'admin.js still claims nothing on the client listens for content_removed');
  assert.ok(!/widen story first/.test(ADMIN_SRC),
    'admin.js still tells the next reader to widen story first, which is now backwards');
  assert.ok(!/There is no venue viewer room to emit into/.test(ADMIN_SRC),
    'the venue viewer room exists now');
  assert.ok(!/for four of the seven types it reaches the author and nobody else/.test(ADMIN_SRC),
    'four became two');
});

// ===========================================================================
// G. The room itself — join, leave, and the helper that addresses it
// ===========================================================================

function fakeSocket(id, user) {
  const socketHandlers = new Map();
  const joined = new Set();
  return {
    id,
    user,
    rooms: joined,
    handshake: null, // no handshake => the session watchdog timer stays off
    on(event, handler) { socketHandlers.set(event, handler); },
    join(room) { joined.add(room); },
    leave(room) { joined.delete(room); },
    emit() {},
    to() { return { except() { return this; }, emit() {} }; },
    disconnect() {},
    handlers: socketHandlers,
    joined,
  };
}

function connectSocket(user = { id: 1, name: 'Ava' }) {
  const io = { sockets: { sockets: new Map(), adapter: { rooms: new Map() } }, to() { return { emit() {} }; } };
  const socket = fakeSocket('s1', user);
  registerHandlers(io, socket);
  // Drop the connect-time bookkeeping (`user:{id}`), so every assertion below
  // is about the venue subscriptions and nothing else.
  socket.joined.clear();
  log = [];
  return socket;
}

const KNOWN_VENUE = /EXISTS \(SELECT 1 FROM venue_profiles WHERE google_place_id/;
const fire = (socket, event, ...args) => socket.handlers.get(event)(...args);

test('join_venue_content joins the content room and not the crowd room', async () => {
  handlers = [[KNOWN_VENUE, () => ({ rows: [{ known: true }] })]];
  const socket = connectSocket();
  await fire(socket, 'join_venue_content', { placeId: PLACE });
  assert.deepStrictEqual([...socket.joined], [`venue_content:${PLACE}`]);
  assert.ok(!socket.joined.has(`venue:${PLACE}`),
    'subscribing to a venue card must not sign you up for the crowd firehose');
});

test('the two subscriptions are independent in both directions', async () => {
  handlers = [[KNOWN_VENUE, () => ({ rows: [{ known: true }] })]];
  const socket = connectSocket();
  await fire(socket, 'join_venue', { placeId: PLACE });
  await fire(socket, 'join_venue_content', { placeId: PLACE });
  assert.deepStrictEqual([...socket.joined].sort(), [`venue:${PLACE}`, `venue_content:${PLACE}`]);
  // Closing the card must not silence the crowd feed behind it.
  fire(socket, 'leave_venue_content', { placeId: PLACE });
  assert.deepStrictEqual([...socket.joined], [`venue:${PLACE}`]);
  // And leaving the crowd feed must not silence takedowns on the open card.
  await fire(socket, 'join_venue_content', { placeId: PLACE });
  fire(socket, 'leave_venue', { placeId: PLACE });
  assert.deepStrictEqual([...socket.joined], [`venue_content:${PLACE}`]);
});

test('filling one subscription does not evict the other one', async () => {
  // The independence test above passes even if the two handlers SHARE a Set,
  // because leaving a room you are not in is a no-op and the membership counts
  // come out the same. This is the difference a shared Set actually makes: the
  // content rooms would push the crowd rooms out of the bookkeeping, so the
  // socket stays in `venue:X` with nothing tracking it and the next join pays a
  // known-venue query for a room it never left. Both caps are per-subscription.
  handlers = [[KNOWN_VENUE, () => ({ rows: [{ known: true }] })]];
  const socket = connectSocket();
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await fire(socket, 'join_venue', { placeId: `ChIJcrowd_${i}` });
  }
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await fire(socket, 'join_venue_content', { placeId: `ChIJcard_${i}` });
  }
  assert.strictEqual(socket.joined.size, 20, 'ten of each, not ten between them');
  clearKnownVenueCache();
  log = [];
  await fire(socket, 'join_venue', { placeId: 'ChIJcrowd_0' });
  assert.strictEqual(ran(KNOWN_VENUE).length, 0,
    'the crowd subscription was evicted from its own bookkeeping by the content one');
  assert.ok(socket.joined.has('venue:ChIJcrowd_0'));
});

test('an unknown or misshapen place id cannot mint a content room', async () => {
  handlers = [[KNOWN_VENUE, () => ({ rows: [{ known: false }] })]];
  const socket = connectSocket();
  await fire(socket, 'join_venue_content', { placeId: PLACE });
  assert.deepStrictEqual([...socket.joined], [], 'unknown venue');

  log = [];
  for (const bad of ['', 'a', 'has space', 'x'.repeat(200), null, undefined, 42, {}, ['a']]) {
    // eslint-disable-next-line no-await-in-loop
    await fire(socket, 'join_venue_content', { placeId: bad });
    // eslint-disable-next-line no-await-in-loop
    await fire(socket, 'join_venue_content', bad);
  }
  assert.deepStrictEqual([...socket.joined], []);
  assert.strictEqual(log.length, 0, 'a misshapen id must be refused before it costs a query');
});

test('the known-venue check is skipped for a room this socket already holds', async () => {
  let lookups = 0;
  handlers = [[KNOWN_VENUE, () => { lookups += 1; return { rows: [{ known: true }] }; }]];
  const socket = connectSocket();
  await fire(socket, 'join_venue_content', { placeId: PLACE });
  assert.strictEqual(lookups, 1);
  // The known-venue CACHE in utils/places.js would also swallow the second
  // lookup, so clearing it is what makes this test about the `has` check on the
  // socket's own Set rather than about a cache that has nothing to do with the
  // handler. Without this line the assertion below passes even if the
  // short-circuit is deleted.
  clearKnownVenueCache();
  await fire(socket, 'join_venue_content', { placeId: PLACE });
  assert.strictEqual(lookups, 1, 'a replayed join on reconnect must not cost a query per replay');
  assert.deepStrictEqual([...socket.joined], [`venue_content:${PLACE}`]);
});

test('the content room cap evicts the oldest rather than refusing the newest', async () => {
  handlers = [[KNOWN_VENUE, () => ({ rows: [{ known: true }] })]];
  const socket = connectSocket();
  for (let i = 0; i < 12; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await fire(socket, 'join_venue_content', { placeId: `ChIJcap_${String(i).padStart(3, '0')}` });
  }
  assert.strictEqual(socket.joined.size, 10, 'MAX_VENUE_ROOMS_PER_SOCKET');
  assert.ok(socket.joined.has('venue_content:ChIJcap_011'), 'the card the user is looking at must never be the one refused');
  assert.ok(!socket.joined.has('venue_content:ChIJcap_000'), 'the oldest goes first');
});

test('leave_venue_content leaves, and a leave for a room never joined is a no-op', async () => {
  handlers = [[KNOWN_VENUE, () => ({ rows: [{ known: true }] })]];
  const socket = connectSocket();
  await fire(socket, 'join_venue_content', { placeId: PLACE });
  fire(socket, 'leave_venue_content', { placeId: OTHER_PLACE });
  assert.deepStrictEqual([...socket.joined], [`venue_content:${PLACE}`]);
  fire(socket, 'leave_venue_content', PLACE);
  assert.deepStrictEqual([...socket.joined], []);
  fire(socket, 'leave_venue_content', undefined);
  fire(socket, 'leave_venue_content', {});
  assert.deepStrictEqual([...socket.joined], []);
});

test('join_venue_content is rate limited, and on its own budget', async () => {
  handlers = [[KNOWN_VENUE, () => ({ rows: [{ known: true }] })]];
  const socket = connectSocket();
  // 30 per 10s. Distinct ids so the cheap already-joined path does not absorb
  // them, and the cap eviction keeps the room set bounded meanwhile.
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await fire(socket, 'join_venue_content', { placeId: `ChIJrate_${String(i).padStart(3, '0')}` });
  }
  assert.strictEqual(ran(KNOWN_VENUE).length, 30, 'join_venue_content: 30 per 10s per socket');
  // A separate bucket from the crowd room: exhausting one must not close the
  // other, or a busy map would silence takedowns.
  log = [];
  await fire(socket, 'join_venue', { placeId: OTHER_PLACE });
  assert.strictEqual(ran(KNOWN_VENUE).length, 1, 'join_venue shares join_venue_content\'s budget');
});

test('emitToVenueContentViewers refuses to build a room name it should not', () => {
  const sent = [];
  const io = { to: (room) => ({ emit: (event, payload) => sent.push({ room, event, payload }) }) };
  assert.strictEqual(emitToVenueContentViewers(null, PLACE, 'content_removed', {}), false, 'no io');
  for (const bad of ['', 'a', 'has space', 'x'.repeat(200), null, undefined, 42, {}]) {
    assert.strictEqual(emitToVenueContentViewers(io, bad, 'content_removed', {}), false, JSON.stringify(bad));
  }
  assert.deepStrictEqual(sent, []);
  assert.strictEqual(emitToVenueContentViewers(io, PLACE, 'content_removed', { contentId: 1 }), true);
  assert.deepStrictEqual(sent, [{ room: `venue_content:${PLACE}`, event: 'content_removed', payload: { contentId: 1 } }]);
});

test('the room name has one definition, and it is not a prefix of the crowd room', () => {
  assert.strictEqual(VENUE_CONTENT_ROOM(PLACE), `venue_content:${PLACE}`);
  // `venue:` and `venue_content:` must not be able to collide: a place id
  // cannot contain a colon (PLACE_ID_RE is [A-Za-z0-9_-]), so no crowd room
  // name can ever equal a content room name.
  assert.ok(!/^venue:/.test(VENUE_CONTENT_ROOM(PLACE)));
  const literals = HANDLERS_SRC.split('\n')
    .map((l) => l.trim())
    .filter((l) => !l.startsWith('//') && /`venue_content:\$\{/.test(l));
  assert.strictEqual(literals.length, 1,
    'the content room name is built in more than one place; sockets/handlers.js owns it');
});

test('the join handler and the emit helper agree on the gate', () => {
  // Both sides use utils/places.js. If the join side ever gets stricter than
  // the emit side, the server addresses rooms nobody can be in; looser, and a
  // stored string becomes a room name.
  const joinBlock = HANDLERS_SRC.slice(
    HANDLERS_SRC.indexOf("socket.on('join_venue_content'"),
    HANDLERS_SRC.indexOf("socket.on('leave_venue_content'")
  );
  assert.match(joinBlock, /isPlaceIdShaped\(placeId\)/);
  assert.match(joinBlock, /isKnownVenue\(placeId\)/);
  const helperBlock = HANDLERS_SRC.slice(
    HANDLERS_SRC.indexOf('function emitToVenueContentViewers'),
    HANDLERS_SRC.indexOf('// Guest RSVPs come in over an UNAUTHENTICATED')
  );
  assert.match(helperBlock, /isPlaceIdShaped\(placeId\)/);
});
