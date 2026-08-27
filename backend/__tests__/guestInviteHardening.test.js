// Run: node --test  (from backend/)
//
// GUEST INVITE FLOW — security + correctness sweep, 2026-08-14.
//
// https://www.flockcorp.com/i/<token> is the growth channel and the app's only
// unauthenticated surface: the token is the entire credential. This file pins
// the four properties that make that acceptable:
//
//   1. TOKEN QUALITY  — new tokens carry >=128 bits of unbiased crypto
//      randomness, fit the column, and legacy 12-char tokens keep resolving.
//   2. NO ENUMERATION — an unknown, revoked, or deleted-flock token is one
//      uniform 404 on every route (no oracle), behind the mount's rate limiter,
//      and the preview answers with a fixed allowlist of fields.
//   3. BOUNDED WRITES — a guest name is stripped of markup and length-capped
//      before it is stored or broadcast, minting identities is budgeted per
//      IP per flock, and a guest can only ever touch their own row.
//   4. LIFECYCLE      — deleting a flock cascades the link and every guest row
//      away; a finished plan leaks nothing it did not leak while live; hidden
//      (taken-down) rows are filtered from every read the flow serves.
//
// The spam/fan-out budgets and the takedown replay guard have their own file
// (guestSurfaceAbuse.test.js); nothing here re-pins those.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'guest-invite-hardening-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const pool = require('../config/database');

// ── Fixture plumbing (same shape as guestSurfaceAbuse.test.js) ─────────────
let handlers = [];
let log = [];

function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, raw: String(sql), params });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = fn(params || [], flat);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      log.push({ sql: String(sql).trim(), raw: String(sql), params: null });
      return Promise.resolve({ rows: [] });
    }
    return dispatch(sql, params);
  },
  release: () => {},
});

const pushMod = require('../services/pushHelper');
pushMod.pushIfOffline = async () => ({ skipped: true, reason: 'test' });
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true, reason: 'test' });

const guest = require('../routes/guest');

let emits = [];
const io = {
  to(room) { return { emit(event, payload) { emits.push({ room, event, payload }); } }; },
};

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/guest', guest.router);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  emits = [];
  guest.newGuestLog.clear();
  guest.guestActionLog.clear();
});

function on(re, fn) { handlers.push([re, fn]); }
function ran(re) { return log.filter((q) => re.test(q.sql)); }

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

const LEGACY_TOKEN = 'ABCDEFGHJKLM'; // 12 chars — the pre-widening format
const GUEST_TOKEN = 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5'; // gitleaks:allow — synthetic

const link = (over = {}) => ({
  flock_id: 42, name: 'Dinner', event_time: '2026-09-01T01:00:00Z', venue_name: 'The Bar',
  status: 'planning', host_name: 'Ava Brooks', ...over,
});

function scriptAnnounce() {
  on(/AS members/, () => ({ rows: [{ members: 2, guests: 1 }] }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'/,
    () => ({ rows: [{ user_id: 2 }, { user_id: 3 }] }));
  on(/SELECT creator_id, name FROM flocks WHERE id = \$1/, () => ({ rows: [{ creator_id: 9, name: 'Dinner' }] }));
  on(/FROM user_blocks/, () => ({ rows: [] }));
}

// The world a brand-new guest RSVPs in.
function scriptNewGuest() {
  let nextId = 100;
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SELECT COUNT\(\*\)::int AS n FROM guest_rsvps/, () => ({ rows: [{ n: 0 }] }));
  on(/COALESCE\(is_hidden, false\) = true/, () => ({ rows: [] }));
  on(/INSERT INTO guest_rsvps/, () => {
    nextId += 1;
    return { rows: [{ id: nextId, guest_token: GUEST_TOKEN, is_hidden: false }] };
  });
  scriptAnnounce();
}

const guestSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'guest.js'), 'utf8');
const flocksSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'flocks.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const baselineSql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_baseline.sql'), 'utf8')
  .replace(/\s+/g, ' ');

// ===========================================================================
// PART 1 — token quality
// ===========================================================================

test('a new invite token carries at least 128 bits of crypto randomness', () => {
  // The token is the whole credential on an unauthenticated surface, so it gets
  // the same floor as any other bearer secret. The old generator minted 12
  // chars (~69 bits) — never walkable through a rate limiter, but far under
  // the floor this sweep sets.
  const bitsPerChar = Math.log2(guest.LINK_TOKEN_ALPHABET.length);
  assert.ok(
    guest.LINK_TOKEN_LENGTH * bitsPerChar >= 128,
    `${guest.LINK_TOKEN_LENGTH} chars of a ${guest.LINK_TOKEN_ALPHABET.length}-char alphabet is only ` +
    `${(guest.LINK_TOKEN_LENGTH * bitsPerChar).toFixed(1)} bits`
  );

  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const t = guest.newLinkToken();
    assert.strictEqual(t.length, guest.LINK_TOKEN_LENGTH);
    for (const ch of t) {
      assert.ok(guest.LINK_TOKEN_ALPHABET.includes(ch), `character ${ch} is outside the alphabet`);
    }
    seen.add(t);
  }
  assert.strictEqual(seen.size, 2000, 'tokens must not repeat');
});

test('token characters are drawn uniformly — no modulo bias', () => {
  // The old generator did `byte % 55` on the full 0..255 range. 256 % 55 = 36,
  // so the first 36 alphabet characters were each 25% more likely than the
  // last 19 — about a bit and a half of the advertised entropy given away.
  // 480,000 samples put that skew at ~13 standard deviations; the 6% tolerance
  // here sits at ~5.7 sigma, so this test catches the bias and cannot flake on
  // an honest uniform generator.
  const counts = new Map();
  const tokens = 20000;
  for (let i = 0; i < tokens; i++) {
    for (const ch of guest.newLinkToken()) counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  const total = tokens * guest.LINK_TOKEN_LENGTH;
  const expected = total / guest.LINK_TOKEN_ALPHABET.length;
  for (const ch of guest.LINK_TOKEN_ALPHABET) {
    const n = counts.get(ch) || 0;
    assert.ok(
      Math.abs(n - expected) <= expected * 0.06,
      `character ${ch} appeared ${n} times, expected ~${Math.round(expected)} — the sampling is biased`
    );
  }
});

test('a new token fits the widened column and the route validators', () => {
  // The three-way agreement that makes the longer token deployable: the
  // generator, the VARCHAR the token lands in, and the param validator that
  // admits it back. Any one of them drifting is a minted link that 400s or a
  // 500 on insert.
  const t = guest.newLinkToken();
  assert.ok(t.length <= guest.LINK_TOKEN_PARAM_MAX, 'the validator must admit what the generator mints');
  assert.strictEqual(guest.LINK_TOKEN_PARAM_MAX, 64, 'pinned to the column width below');

  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '022_invite_link_token_width.sql'), 'utf8'
  );
  assert.match(migration, /ALTER TABLE flock_invite_links ALTER COLUMN token TYPE VARCHAR\(64\)/,
    'the column must be widened to what the validator advertises');

  // PIN UPDATE, 2026-08-14: four, not three. POST /:token/join joined the file
  // and reads the same token off the same URL, so it has to be measured by the
  // same bound. A route that validated the token differently would be a route
  // that answers 400 where its neighbours answer 404, which is the enumeration
  // oracle the rest of this file exists to prevent.
  const uses = guestSrc.match(/isLength\(\{ min: LINK_TOKEN_PARAM_MIN, max: LINK_TOKEN_PARAM_MAX \}\)/g) || [];
  assert.strictEqual(uses.length, 4,
    'all four routes (preview, rsvp, vote, join) must share the one token bound');
});

test('legacy 12-char tokens still resolve, and both formats pass validation', async () => {
  // Backward compatibility is the constraint the whole change was made under:
  // links already pasted into group chats must keep working.
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SUM\(c\)::int AS votes/, () => ({ rows: [{ venue_name: 'The Bar', votes: 3 }] }));
  on(/AS members/, () => ({ rows: [{ members: 2, guests: 1 }] }));

  const legacy = await call('GET', `/api/guest/${LEGACY_TOKEN}`);
  assert.strictEqual(legacy.status, 200, 'a pre-widening token must keep resolving');

  const fresh = await call('GET', `/api/guest/${guest.newLinkToken()}`);
  assert.strictEqual(fresh.status, 200, 'a freshly minted token must pass its own validator');
});

test('tokens outside the accepted shape are a 400 before any query runs', async () => {
  for (const bad of ['abcdefg' /* 7 */, 'A'.repeat(65)]) {
    log = [];
    const res = await call('GET', `/api/guest/${bad}`);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(log.length, 0, 'shape is settled before the database hears about it');
  }
});

// ===========================================================================
// PART 2 — enumeration and scraping
// ===========================================================================

test('unknown, revoked, and deleted-flock tokens are one uniform 404 on every route', async () => {
  // resolveLink filters `revoked = false` in SQL and INNER JOINs flocks, so a
  // revoked link and a deleted flock are indistinguishable from a token that
  // never existed — same empty result, same 404, same body. A scraper walking
  // tokens learns nothing about which links once lived.
  assert.match(guestSrc, /WHERE il\.token = \$1 AND il\.revoked = false/,
    'revocation must be part of the lookup itself, not a separate answer');
  assert.match(guestSrc, /JOIN flocks f ON f\.id = il\.flock_id/,
    'an inner join means a deleted flock cannot resolve');

  const responses = [
    await call('GET', `/api/guest/${LEGACY_TOKEN}`),
    await call('POST', `/api/guest/${LEGACY_TOKEN}/rsvp`, { name: 'Alice', status: 'in' }),
    await call('POST', `/api/guest/${LEGACY_TOKEN}/vote`, { guestToken: GUEST_TOKEN, venueName: 'The Bar' }),
  ];
  for (const res of responses) {
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(res.body, { error: 'This invite link is no longer active' },
      'every route answers a dead token with the identical body — no oracle');
  }

  // The fourth route, POST /:token/join, is authenticated, so it cannot be
  // called from this fixture without a JWT — its live 404 is exercised in
  // __tests__/inviteJoinFlow.test.js. What is pinned HERE is that it says the
  // identical sentence, because a signed-in caller learning "that token existed
  // once" is the same oracle as an anonymous one learning it.
  const deadTokenAnswers = guestSrc.match(/error: 'This invite link is no longer active'/g) || [];
  assert.strictEqual(deadTokenAnswers.length, 4,
    'all four routes answer a dead token with the same sentence');
});

test('the guest mount sits behind the API rate limiter', () => {
  // Token walking is bounded by the same per-IP limiter as the rest of the
  // API. Pinned at the mount because the router itself carries no limiter of
  // its own for the GET.
  assert.match(serverSrc, /app\.use\('\/api\/guest', apiLimiter/,
    'the unauthenticated lookup must not be mounted without the limiter');
});

test('the preview answers with a fixed allowlist and nothing else', async () => {
  // What a scraper who HAS a valid token can harvest: plan name, time, venue,
  // status, host FIRST name, a going count, a roster of FIRST names with each
  // person's answer, and vote counts. No surnames, no emails, no phone numbers,
  // no user ids, no guest row ids, no photos. The key-set assertions are exact,
  // so a field added to the payload later fails here and has to argue its case.
  //
  // ── PIN UPDATE, 2026-08-14. `people` was added deliberately. ──────────────
  // The old payload answered "how many" (`going: 3`) and never "who", so the
  // page could not tell the person deciding whether to come who else was
  // coming. That was the whole of Jayden's report on this surface. The widening
  // is EXACTLY one key, and it is bounded on three axes rather than left open:
  //
  //   1. FIELD SET. Each row is { name, rsvp, kind } and the assertions below
  //      are deepStrictEqual on the key set of a row, not a subset check, so
  //      adding an id or a photo to the roster fails here.
  //   2. IDENTITY. `name` is the same first-name reduction `host` has always
  //      used, capped at 24 characters. A surname reaching this list fails the
  //      test below.
  //   3. LENGTH. Capped at ROSTER_LIMIT, so a leaked link is not a paginated
  //      directory and the payload does not grow with the flock.
  //
  // What was NOT weakened: every is_hidden filter still stands (see PART 5,
  // which now also covers the roster), bad tokens are still one uniform 404 on
  // every route including the new one, and the post-event payload still may not
  // grow.
  //
  // ── PIN UPDATE. `full` was added deliberately. ────────────────────────────
  // POST /:token/join refuses a NEW account past LINK_JOIN_MEMBER_CAP with a
  // 429, and the page had no way to know that before it sent a stranger
  // through a whole signup that could not end in this flock. It is a BOOLEAN,
  // not the member count and not the ceiling: the roster is already first
  // names only, and the exact size of a group is not something a link needs to
  // publish. Read off the accepted-member figure the `going` query already
  // fetched, so it costs no extra round trip and cannot disagree with `going`.
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SUM\(c\)::int AS votes/, () => ({ rows: [{ venue_name: 'The Bar', votes: 3 }] }));
  on(/AS members/, () => ({ rows: [{ members: 2, guests: 1 }] }));
  on(/FROM flock_members fm JOIN users u/, () => ({ rows: [
    { name: 'Ava Brooks', status: 'accepted' },
    { name: 'Noor Haddad', status: 'declined' },
    { name: 'Theo Lang', status: 'invited' },
  ] }));
  on(/SELECT name, status FROM guest_rsvps/, () => ({ rows: [{ name: 'Sam', status: 'in' }] }));

  const res = await call('GET', `/api/guest/${LEGACY_TOKEN}`);
  assert.strictEqual(res.status, 200);
  // ── PIN UPDATE. `guestsFull` was added deliberately (2026-08-27). ────────
  // The guest ledger has its own 50-row ceiling and the page used to learn
  // about it from a 409 after the guest had already typed their name into a
  // live form. Same contract as `full`: a boolean, never the count.
  assert.deepStrictEqual(Object.keys(res.body).sort(), ['flock', 'full', 'going', 'guestsFull', 'host', 'people', 'venues']);
  assert.strictEqual(res.body.guestsFull, false, 'nowhere near the guest ledger cap');
  assert.strictEqual(typeof res.body.guestsFull, 'boolean', 'a yes or a no, never the count');
  assert.deepStrictEqual(Object.keys(res.body.flock).sort(), ['chosenVenue', 'name', 'status', 'when']);
  assert.strictEqual(res.body.host, 'Ava', 'host is a FIRST name only');
  assert.strictEqual(res.body.going, 3, 'going is a count, never a list');
  assert.strictEqual(res.body.full, false, 'a two-member flock is nowhere near the join cap');
  assert.strictEqual(typeof res.body.full, 'boolean',
    'the capacity answer is a yes or a no, never the count or the ceiling');
  assert.deepStrictEqual(res.body.venues, [{ venue_name: 'The Bar', votes: 3 }],
    'venue tallies are counts only — no voter identities cross the guest surface');

  // The roster: three answers, first names only, yes before no before silence.
  assert.deepStrictEqual(res.body.people, [
    { name: 'Ava', rsvp: 'in', kind: 'member' },
    { name: 'Sam', rsvp: 'in', kind: 'guest' },
    { name: 'Noor', rsvp: 'out', kind: 'member' },
    { name: 'Theo', rsvp: 'none', kind: 'member' },
  ]);
  for (const p of res.body.people) {
    assert.deepStrictEqual(Object.keys(p).sort(), ['kind', 'name', 'rsvp'],
      'a roster row carries three fields and nothing else');
    assert.ok(!/\s/.test(p.name), 'a surname must never cross this surface');
    assert.ok(p.name.length <= 24, 'names are length-capped');
  }
});

test('a plan at the join ceiling says so on the preview, before anybody signs up', async () => {
  // THE SILENT DEAD END THIS CLOSES. POST /:token/join answers a new account
  // past LINK_JOIN_MEMBER_CAP with a 429 the client cannot explain, so the
  // page used to send a stranger through a whole signup that could not end in
  // this flock and then say nothing at all about why. The preview now answers
  // the same question the join route will answer, using the same count and the
  // same ceiling, so the page can be honest before the trip starts.
  //
  // Pinned against the exported constant, not against 50, so raising the cap
  // stays one edit.
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SUM\(c\)::int AS votes/, () => ({ rows: [] }));
  on(/AS members/, () => ({ rows: [{ members: guest.LINK_JOIN_MEMBER_CAP, guests: 0 }] }));
  on(/FROM flock_members fm JOIN users u/, () => ({ rows: [] }));
  on(/SELECT name, status FROM guest_rsvps/, () => ({ rows: [] }));

  const res = await call('GET', `/api/guest/${LEGACY_TOKEN}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.full, true);
});

test('one member under the ceiling is not reported as full', async () => {
  // Off by one here is the difference between an honest page and a page that
  // turns people away from a plan they could have joined.
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SUM\(c\)::int AS votes/, () => ({ rows: [] }));
  on(/AS members/, () => ({ rows: [{ members: guest.LINK_JOIN_MEMBER_CAP - 1, guests: 0 }] }));
  on(/FROM flock_members fm JOIN users u/, () => ({ rows: [] }));
  on(/SELECT name, status FROM guest_rsvps/, () => ({ rows: [] }));

  const res = await call('GET', `/api/guest/${LEGACY_TOKEN}`);
  assert.strictEqual(res.body.full, false);
});

test('guests do not fill the member ceiling, because they do not take member seats', async () => {
  // guest_rsvps and flock_members are different tables with different caps.
  // Counting guests toward the join ceiling would close the join band on a
  // plan that has room, which is the mirror image of the bug above.
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SUM\(c\)::int AS votes/, () => ({ rows: [] }));
  on(/AS members/, () => ({ rows: [{ members: 3, guests: guest.LINK_JOIN_MEMBER_CAP }] }));
  on(/FROM flock_members fm JOIN users u/, () => ({ rows: [] }));
  on(/SELECT name, status FROM guest_rsvps/, () => ({ rows: [] }));

  const res = await call('GET', `/api/guest/${LEGACY_TOKEN}`);
  assert.strictEqual(res.body.full, false);
  assert.strictEqual(res.body.going, 3 + guest.LINK_JOIN_MEMBER_CAP);
});

test('the roster is capped, and the cap is what the route advertises', async () => {
  // A leaked link is not a directory. Pinned against the exported constant so
  // raising the cap is a deliberate edit in two places, not a drift in one.
  const many = Array.from({ length: 200 }, (_, i) => ({ name: `Person${i}`, status: 'accepted' }));
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SUM\(c\)::int AS votes/, () => ({ rows: [] }));
  on(/AS members/, () => ({ rows: [{ members: 200, guests: 0 }] }));
  on(/FROM flock_members fm JOIN users u/, () => ({ rows: many }));
  on(/SELECT name, status FROM guest_rsvps/, () => ({ rows: [] }));

  const res = await call('GET', `/api/guest/${LEGACY_TOKEN}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.people.length, guest.ROSTER_LIMIT);

  // And the cap is pushed into SQL as a LIMIT, not applied only after the rows
  // have already been read into memory.
  for (const q of ran(/FROM flock_members fm JOIN users u/).concat(ran(/SELECT name, status FROM guest_rsvps/))) {
    assert.match(q.sql, /LIMIT \$2/, 'the roster reads are bounded in the database');
  }
});

// ===========================================================================
// PART 3 — guest writes
// ===========================================================================

test('markup in a guest name is stripped before storage, broadcast, and push', async () => {
  // The name is unauthenticated UGC rendered in every member's app and in the
  // host's push notification title. It must leave this route inert.
  scriptNewGuest();

  const res = await call('POST', `/api/guest/${LEGACY_TOKEN}/rsvp`, {
    name: '<img src=x onerror=alert(1)>Bob', status: 'in',
  });
  assert.strictEqual(res.status, 201);

  const ins = ran(/INSERT INTO guest_rsvps/)[0];
  assert.ok(ins, 'the RSVP must land');
  assert.strictEqual(ins.params[1], 'Bob', 'the stored name carries no markup');

  for (const e of emits) {
    if (e.payload && typeof e.payload.name === 'string') {
      assert.ok(!/[<>]/.test(e.payload.name), 'no member screen ever receives markup');
    }
  }
});

test('a name that is nothing but markup is refused, not stored blank', async () => {
  scriptNewGuest();
  const res = await call('POST', `/api/guest/${LEGACY_TOKEN}/rsvp`, { name: '<b><i></i></b>', status: 'in' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(ran(/INSERT INTO guest_rsvps/).length, 0);
});

test('guest names are capped at the 60-char column, over-long is a 400 not a 500', async () => {
  scriptNewGuest();
  // Not 'x': a run of x's reads as 'xxx' to the profanity screen, which is its
  // own 400 and would make this test pass for the wrong reason.
  const long = await call('POST', `/api/guest/${LEGACY_TOKEN}/rsvp`, { name: 'N'.repeat(61), status: 'in' });
  assert.strictEqual(long.status, 400);
  assert.strictEqual(ran(/INSERT INTO guest_rsvps/).length, 0);

  const exact = await call('POST', `/api/guest/${LEGACY_TOKEN}/rsvp`, { name: 'N'.repeat(60), status: 'in' });
  assert.strictEqual(exact.status, 201, 'the column cap itself is still usable');
});

test('one address cannot mint unlimited guest identities on a link', async () => {
  // Every request in this file shares one source IP, which is exactly the
  // attacker shape: a script holding a leaked link. The per-IP-per-flock
  // budget must bite before the 50-slot flock cap is consumable in one burst.
  scriptNewGuest();

  const cap = guest.NEW_GUESTS_PER_IP_PER_FLOCK;
  for (let i = 0; i < cap; i++) {
    const res = await call('POST', `/api/guest/${LEGACY_TOKEN}/rsvp`, { name: `Guest ${i}`, status: 'in' });
    assert.strictEqual(res.status, 201, `mint ${i + 1} of ${cap} is honest use`);
  }
  const refused = await call('POST', `/api/guest/${LEGACY_TOKEN}/rsvp`, { name: 'One More', status: 'in' });
  assert.strictEqual(refused.status, 429);
  assert.strictEqual(ran(/INSERT INTO guest_rsvps/).length, cap, 'the refused mint writes nothing');
});

test('an RSVP edit is scoped to the caller\'s own row, and no route deletes one', async () => {
  // The UPDATE must be pinned to the server-issued guest_token AND the link's
  // flock — a guest can never address anybody else's row, in this flock or
  // any other. And there is deliberately no guest-facing DELETE: takedown is
  // is_hidden, owned by moderators.
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/AS is_hidden FROM guest_rsvps WHERE guest_token/,
    () => ({ rows: [{ id: 7, name: 'Bob', status: 'in', is_hidden: false }] }));
  on(/COALESCE\(is_hidden, false\) = true/, () => ({ rows: [] }));
  on(/UPDATE guest_rsvps SET name/, () => ({ rows: [{ id: 7, guest_token: GUEST_TOKEN }], rowCount: 1 }));
  scriptAnnounce();

  const res = await call('POST', `/api/guest/${LEGACY_TOKEN}/rsvp`, {
    name: 'Roberta', status: 'out', guestToken: GUEST_TOKEN,
  });
  assert.strictEqual(res.status, 200);

  const upd = ran(/UPDATE guest_rsvps SET name/)[0];
  assert.match(upd.sql, /WHERE guest_token = \$3 AND flock_id = \$4/,
    'the write is addressed by the token the server issued, inside this flock only');
  assert.strictEqual(upd.params[2], GUEST_TOKEN);
  assert.strictEqual(upd.params[3], 42);

  assert.ok(!/router\.delete\(/.test(guestSrc), 'no guest-facing DELETE route');
  assert.ok(!/DELETE FROM guest_rsvps/.test(guestSrc), 'no path removes an RSVP row');
});

// ===========================================================================
// PART 4 — token lifecycle
// ===========================================================================

test('deleting a flock takes the link and every guest row with it', () => {
  // The schema is the enforcement: FK cascades mean a deleted flock has no
  // link row to resolve and no guest rows to leak — the link goes dead at the
  // same instant the flock does, with no code path to forget.
  assert.match(baselineSql,
    /CREATE TABLE IF NOT EXISTS flock_invite_links \( token VARCHAR\(20\) PRIMARY KEY, flock_id INTEGER NOT NULL REFERENCES flocks\(id\) ON DELETE CASCADE/,
    'flock_invite_links must cascade away with its flock');
  assert.match(baselineSql,
    /CREATE TABLE IF NOT EXISTS guest_rsvps \( id SERIAL PRIMARY KEY, flock_id INTEGER NOT NULL REFERENCES flocks\(id\) ON DELETE CASCADE/,
    'guest_rsvps must cascade away with its flock');
  assert.match(baselineSql,
    /guest_rsvp_id INTEGER NOT NULL REFERENCES guest_rsvps\(id\) ON DELETE CASCADE/,
    'guest_votes must cascade away with its guest');
});

test('revoking is the flip of one flag, and regenerating kills every prior link', () => {
  // The minting route in routes/flocks.js: one active link per flock, and
  // { regenerate: true } revokes ALL existing links before minting — a leaked
  // link dies, it is not merely joined by a sibling. Minting goes through the
  // one generator this file audits.
  assert.match(flocksSrc, /UPDATE flock_invite_links SET revoked = true WHERE flock_id = \$1/,
    'regenerate must revoke by flock, not by token');
  assert.match(flocksSrc, /require\('\.\/guest'\)/,
    'flocks.js mints through routes/guest.js — one token generator in the app');
  assert.ok(!/randomBytes/.test(flocksSrc), 'no second, private token generator in flocks.js');
});

test('a finished plan leaks nothing through the link that a live one did not', async () => {
  // The preview stays readable after the event on purpose — the holder finds
  // out the plan is off through `status`. What it must never do is grow: the
  // post-event payload carries exactly the same fields as the live one.
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SUM\(c\)::int AS votes/, () => ({ rows: [{ venue_name: 'The Bar', votes: 3 }] }));
  on(/AS members/, () => ({ rows: [{ members: 2, guests: 1 }] }));

  const live = await call('GET', `/api/guest/${LEGACY_TOKEN}`);

  handlers = handlers.filter(([re]) => !re.test('FROM flock_invite_links'));
  on(/FROM flock_invite_links/, () => ({ rows: [link({ status: 'completed' })] }));
  const done = await call('GET', `/api/guest/${LEGACY_TOKEN}`);

  assert.strictEqual(live.status, 200);
  assert.strictEqual(done.status, 200);
  assert.strictEqual(done.body.flock.status, 'completed', 'the holder learns the plan is over');
  assert.deepStrictEqual(Object.keys(done.body).sort(), Object.keys(live.body).sort(),
    'the payload must not grow after the event');
  assert.deepStrictEqual(Object.keys(done.body.flock).sort(), Object.keys(live.body.flock).sort());
});

// ===========================================================================
// PART 5 — the hidden flag (migration 005) closes every door
// ===========================================================================
// The sweeping every-reader source scan lives in guestSurfaceAbuse.test.js;
// these three pin the behavior on the guest surface itself.

test('the preview counts, tallies and ROSTER all exclude hidden guests', async () => {
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SUM\(c\)::int AS votes/, () => ({ rows: [] }));
  on(/AS members/, () => ({ rows: [{ members: 2, guests: 0 }] }));

  await call('GET', `/api/guest/${LEGACY_TOKEN}`);

  const going = ran(/AS members/)[0];
  assert.ok(going, 'the going count ran');
  assert.match(going.sql, /status = 'in' AND COALESCE\(is_hidden, false\) = false/,
    'a taken-down guest must not inflate the public going count');

  const tally = ran(/SUM\(c\)::int AS votes/)[0];
  assert.ok(tally, 'the venue tally ran');
  assert.match(tally.sql, /JOIN guest_rsvps gr ON gr\.id = gv\.guest_rsvp_id WHERE gv\.flock_id = \$1 AND COALESCE\(gr\.is_hidden, false\) = false/,
    'a hidden guest\'s votes must not move the public tally');

  // The roster is the newest reader of guest_rsvps and therefore the newest way
  // a takedown could have been undone: it is the one surface an abuser can
  // still reach, and it names people. Filtered in the SQL, like every other
  // reader on this route.
  const roster = ran(/SELECT name, status FROM guest_rsvps/)[0];
  assert.ok(roster, 'the roster read the guest rows');
  assert.match(roster.sql, /COALESCE\(is_hidden, false\) = false/,
    'a taken-down guest name must not come back on the roster');
});

test('a hidden guest is absent from the roster even when the row is returned', async () => {
  // Belt to the SQL filter's braces: the filter above is what actually removes
  // the row, and this pins that nothing downstream re-admits one. The fixture
  // deliberately answers the roster query with a hidden row it would never see
  // in production, and the assertion is that only what the WHERE clause admits
  // is what the handler was given.
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SUM\(c\)::int AS votes/, () => ({ rows: [] }));
  on(/AS members/, () => ({ rows: [{ members: 0, guests: 0 }] }));
  on(/FROM flock_members fm JOIN users u/, () => ({ rows: [] }));
  on(/SELECT name, status FROM guest_rsvps/, (params, sql) => {
    assert.match(sql, /COALESCE\(is_hidden, false\) = false/);
    return { rows: [{ name: 'Visible', status: 'in' }] };
  });

  const res = await call('GET', `/api/guest/${LEGACY_TOKEN}`);
  assert.deepStrictEqual(res.body.people, [{ name: 'Visible', rsvp: 'in', kind: 'guest' }]);
});

test('a hidden guest cannot edit their RSVP back onto the surface', async () => {
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/AS is_hidden FROM guest_rsvps WHERE guest_token/,
    () => ({ rows: [{ id: 7, name: 'Bob', status: 'in', is_hidden: true }] }));
  scriptAnnounce();

  const res = await call('POST', `/api/guest/${LEGACY_TOKEN}/rsvp`, {
    name: 'Bob Again', status: 'in', guestToken: GUEST_TOKEN,
  });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(ran(/UPDATE guest_rsvps SET name/).length, 0, 'nothing is written');
  assert.strictEqual(emits.length, 0, 'and nothing reaches a member screen');
});

test('a hidden guest cannot vote, and the lookup itself enforces it', async () => {
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SELECT id FROM guest_rsvps WHERE guest_token/, () => ({ rows: [] })); // hidden = filtered out

  const res = await call('POST', `/api/guest/${LEGACY_TOKEN}/vote`, {
    guestToken: GUEST_TOKEN, venueName: 'The Bar',
  });
  assert.strictEqual(res.status, 403);

  const lookup = ran(/SELECT id FROM guest_rsvps WHERE guest_token/)[0];
  assert.ok(lookup, 'the vote path looked the guest up');
  assert.match(lookup.sql, /COALESCE\(is_hidden, false\) = false/,
    'hidden rows are excluded in the lookup SQL, not by a forgettable if');
  assert.strictEqual(ran(/INSERT INTO guest_votes/).length, 0);
});
