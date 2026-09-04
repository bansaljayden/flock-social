// Run: node --test  (from backend/)
//
// GUEST + CHECK-IN ABUSE AUDIT, 2026-08-14.
//
// `routes/guest.js` is the only UNAUTHENTICATED write surface in the product and
// `routes/checkin.js` is the only other route that will write a row for a caller
// with no account. Everything a guest types renders on a flock roster and is
// fanned out live to every member, so this file pins the properties that stop a
// stranger with a share link from (a) undoing a moderator, (b) using the flock's
// own members as an amplifier, and (c) growing server memory without bound.
//
// Each test below was written RED against the code as it stood and is named for
// the thing that was actually broken, not for the fix.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'guest-surface-abuse-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const pool = require('../config/database');

// ── Fixture plumbing ────────────────────────────────────────────────────────
let handlers = [];
let log = [];

function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, raw: String(sql), params });
  // Matched against the COLLAPSED sql: these statements are written across
  // several lines in the routers, so a pattern spanning two of them would
  // otherwise depend on where the source happens to wrap.
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = fn(params || [], String(sql));
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

pool.query = (sql, params) => dispatch(sql, params);
let poolCheckouts = 0;
pool.connect = async () => {
  poolCheckouts += 1;
  return {
    query: (sql, params) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
        log.push({ sql: String(sql).trim(), raw: String(sql), params: null });
        return Promise.resolve({ rows: [] });
      }
      return dispatch(sql, params);
    },
    release: () => {},
  };
};

// Replaced BEFORE the routers are required — routes/guest.js destructures
// pushIfOffline at module load.
const pushMod = require('../services/pushHelper');
pushMod.pushIfOffline = async () => ({ skipped: true, reason: 'test' });
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true, reason: 'test' });

const guest = require('../routes/guest');
const checkinRouter = require('../routes/checkin');

let emits = [];
const io = {
  to(room) { return { emit(event, payload) { emits.push({ room, event, payload }); } }; },
};

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/guest', guest.router);
app.use('/api/checkin', checkinRouter);

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
  poolCheckouts = 0;
  guest.newGuestLog.clear();
  // Optional so the RED run of this file reports each real failure rather than
  // every test dying in the hook before it starts.
  guest.guestActionLog?.clear();
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

const LINK_TOKEN = 'ABCDEFGHJKLM';
// Deliberately full of hex LETTERS. The first draft of this file used
// '11111111-1111-4111-8111-111111111111', which is all digits — so
// `.toUpperCase()` on it is the identity function and the re-casing test below
// was silently asserting nothing. Found by mutating the fix it was meant to
// cover; a fixture that cannot express the attack is not a fixture.
// The secret scanner flags these on entropy alone. They are synthetic counting
// patterns (a1b2c3d4..., b1b2c3d4...) that the local fake below resolves to the
// integers 7 and 8; nothing outside this file has ever seen them. Suppressed
// per line rather than by skipping the hook, so the rest of the commit is still
// scanned.
const GUEST_TOKEN = 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5'; // gitleaks:allow
const GUEST_TOKEN_2 = 'b1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5'; // gitleaks:allow

// Postgres compares the `uuid` type case-insensitively, so the fake resolves a
// token to a row the same way the database would. That is what makes "the same
// guest, spelled differently" a thing these tests can express at all.
const guestIdFor = (t) => (String(t).toLowerCase() === GUEST_TOKEN ? 7 : 8);

const link = (over = {}) => ({
  flock_id: 42, name: 'Dinner', event_time: null, venue_name: 'The Bar',
  status: 'planning', host_name: 'Ava Brooks', ...over,
});

// The queries every accepted RSVP runs on its way out (counts + fan-out).
function scriptAnnounce() {
  on(/AS members/, () => ({ rows: [{ members: 2, guests: 1 }] }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'/,
    () => ({ rows: [{ user_id: 2 }, { user_id: 3 }] }));
  on(/SELECT creator_id, name FROM flocks WHERE id = \$1/, () => ({ rows: [{ creator_id: 9, name: 'Dinner' }] }));
  on(/FROM user_blocks/, () => ({ rows: [] }));
}

// The world an existing, non-hidden guest edits their RSVP in.
function scriptEdit(row = {}) {
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/AS is_hidden\s+FROM guest_rsvps WHERE guest_token/,
    (params) => ({ rows: [{ id: guestIdFor(params[0]), name: 'Bob', status: 'in', is_hidden: false, ...row }] }));
  on(/UPDATE guest_rsvps SET name/, () => ({ rows: [{ id: 7, guest_token: GUEST_TOKEN }], rowCount: 1 }));
  scriptAnnounce();
}

// The world a guest votes in.
function scriptVote({ currentVotes = 0, currentVenue = null, countRows = null } = {}) {
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SELECT id FROM guest_rsvps WHERE guest_token/, (params) => ({ rows: [{ id: guestIdFor(params[0]) }] }));
  on(/AS same\b/, () => (countRows
    ? { rows: countRows }
    : { rows: [{ n: currentVotes, same: currentVenue === 'The Bar' ? 1 : 0 }] }));
  on(/UNION SELECT 1 FROM guest_votes/, () => ({ rows: [{ '?column?': 1 }] }));
  on(/SUM\(c\)::int AS votes/, () => ({ rows: [{ venue_name: 'The Bar', votes: 3 }] }));
  on(/MIN\(venue_id\) FILTER/, () => ({ rows: [{ venue_name: 'The Bar', venue_id: 'abc', member_count: 2, voter_rows: [] }] }));
  on(/AS guest_count/, () => ({ rows: [{ venue_name: 'The Bar', guest_count: 1 }] }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'/,
    () => ({ rows: [{ user_id: 2 }, { user_id: 3 }] }));
  on(/FROM user_blocks/, () => ({ rows: [] }));
}

// ===========================================================================
// PART 1 — a takedown has to survive the EDIT path, not only the INSERT path
// ===========================================================================
//
// Round 15 made a guest-name takedown stick by refusing to INSERT a new row
// carrying a name a moderator had hidden: dropping your guest_token and
// re-RSVPing was a one-request bypass, and the name is the reported content.
//
// The guard was only ever on the creation path. A guest holding ANY live
// guest_token for that flock — including one the same person minted before the
// takedown, since the per-IP allowance is three an hour — could simply RENAME
// their existing RSVP to the removed name. Same table, same column, same
// broadcast to every member, and the row is not hidden so nothing filters it.
// The moderator had removed nothing, again.

test('renaming an existing RSVP to a moderator-removed name is refused', async () => {
  scriptEdit();
  on(/COALESCE\(is_hidden, false\) = true/, () => ({ rows: [{ '?column?': 1 }] }));

  const res = await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, {
    name: 'Removed Name', status: 'in', guestToken: GUEST_TOKEN,
  });

  assert.strictEqual(res.status, 403, 'a taken-down name must be refused on the edit path too');
  assert.strictEqual(ran(/UPDATE guest_rsvps SET name/).length, 0, 'the removed name must never be written');
  assert.strictEqual(emits.length, 0, 'and must never reach a member screen');
});

test('the edit-path takedown check asks the same question the insert path asks', async () => {
  // Both must normalise case and whitespace the same way, or "  BOB  " walks
  // past a takedown on "bob" through whichever path is laxer.
  scriptEdit();
  let asked = null;
  on(/COALESCE\(is_hidden, false\) = true/, (params) => { asked = params; return { rows: [] }; });

  await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, {
    name: '  BOB   MARLEY ', status: 'in', guestToken: GUEST_TOKEN,
  });

  assert.ok(asked, 'the edit path must consult the takedown list');
  assert.strictEqual(asked[1], 'bob marley', 'the same normalisation as normalizeGuestName');
});

test('an ordinary rename still goes through and is still announced', async () => {
  // The control. A guard that refuses everything is not a guard.
  scriptEdit();
  on(/COALESCE\(is_hidden, false\) = true/, () => ({ rows: [] }));

  const res = await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, {
    name: 'Roberta', status: 'in', guestToken: GUEST_TOKEN,
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(ran(/UPDATE guest_rsvps SET name/).length, 1);
  assert.ok(emits.some((e) => e.event === 'guest_rsvp'), 'members still see the change');
});

test('the takedown list is consulted on the STRIPPED name, not the raw one', async () => {
  // freeText sanitises in the validator chain, so `B<b></b>ob` is `Bob` by the
  // time the route reads it. If the takedown query ran on the raw body value,
  // markup would split the name past the replay guard exactly as it once split
  // words past the profanity filter.
  scriptEdit();
  let asked = null;
  on(/COALESCE\(is_hidden, false\) = true/, (params) => { asked = params; return { rows: [] }; });

  await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, {
    name: 'B<b></b>ob', status: 'in', guestToken: GUEST_TOKEN,
  });

  assert.strictEqual(asked[1], 'bob', 'markup must not smuggle a removed name past the guard');
});

// ===========================================================================
// PART 2 — the flock's own members are not an amplifier
// ===========================================================================
//
// Every accepted guest write fans out to every accepted member's personal room
// and re-runs the member-facing tally to build each payload. That is the right
// behaviour and it is also, on an UNAUTHENTICATED route, an amplifier: one
// request costs the server a pool checkout, an advisory lock, two writes and
// N socket payloads.
//
// The RSVP path already refuses to announce an UNCHANGED answer for exactly
// this reason. The vote path had no equivalent, and the RSVP guard only covers
// a literal repeat — alternating `in` / `out` is "changed" every time.

test('re-voting for the venue a guest already picked writes nothing and announces nothing', async () => {
  scriptVote({ currentVotes: 1, currentVenue: 'The Bar' });

  const res = await call('POST', `/api/guest/${LINK_TOKEN}/vote`, {
    guestToken: GUEST_TOKEN, venueName: 'The Bar',
  });

  assert.strictEqual(res.status, 201, 'the guest still gets their tally back');
  assert.ok(Array.isArray(res.body.venues), 'and it is still the real tally');
  assert.strictEqual(ran(/DELETE FROM guest_votes/).length, 0, 'no write for a vote that changes nothing');
  assert.strictEqual(ran(/INSERT INTO guest_votes/).length, 0);
  assert.strictEqual(poolCheckouts, 0, 'and no transaction is opened for it');
  assert.strictEqual(emits.filter((e) => e.event === 'new_vote').length, 0,
    'a repeat of the same vote must not re-notify every member');
});

test('a guest CHANGING their vote still writes and still announces', async () => {
  // The control in the other direction.
  scriptVote({ currentVotes: 1, currentVenue: 'Somewhere Else' });

  const res = await call('POST', `/api/guest/${LINK_TOKEN}/vote`, {
    guestToken: GUEST_TOKEN, venueName: 'The Bar',
  });

  assert.strictEqual(res.status, 201);
  assert.strictEqual(ran(/DELETE FROM guest_votes/).length, 1);
  assert.strictEqual(ran(/INSERT INTO guest_votes/).length, 1);
  assert.ok(emits.some((e) => e.event === 'new_vote'), 'members learn about a real change');
});

test('a guest holding more than one vote is repaired, not treated as a no-op', async () => {
  // Found by mutating the fix, not by reading it. "Has this guest already voted
  // for this venue" is the WRONG question — the delete-then-insert below exists
  // because round 11 shipped a guest who could hold a vote for every venue in
  // the flock at once, and rows from before that fix can still be in the table.
  // For such a guest, re-posting one of their venues looks like a repeat while
  // the extra rows are still inflating every other venue's bar. The no-op is
  // only correct when this venue is their ONLY vote.
  scriptVote({ currentVotes: 2, currentVenue: 'The Bar' });

  const res = await call('POST', `/api/guest/${LINK_TOKEN}/vote`, {
    guestToken: GUEST_TOKEN, venueName: 'The Bar',
  });

  assert.strictEqual(res.status, 201);
  assert.strictEqual(ran(/DELETE FROM guest_votes/).length, 1,
    'the stale extra votes must still be cleared');
  assert.ok(emits.some((e) => e.event === 'new_vote'),
    'and the corrected tally must reach the members whose bars were wrong');
});

test('a guest who has never voted still writes and still announces', async () => {
  scriptVote({ currentVotes: 0 });

  const res = await call('POST', `/api/guest/${LINK_TOKEN}/vote`, {
    guestToken: GUEST_TOKEN, venueName: 'The Bar',
  });

  assert.strictEqual(res.status, 201);
  assert.strictEqual(ran(/INSERT INTO guest_votes/).length, 1);
  assert.ok(emits.some((e) => e.event === 'new_vote'));
});

test('one guest identity cannot fan out to the flock without limit', async () => {
  // Alternating in/out is "changed" every single time, so the existing
  // unchanged-answer guard never fires. Unauthenticated, and the general
  // limiter allows thousands of requests per IP per window.
  scriptEdit();
  on(/COALESCE\(is_hidden, false\) = true/, () => ({ rows: [] }));

  const limit = guest.GUEST_ACTIONS_PER_HOUR;
  assert.ok(Number.isInteger(limit) && limit > 0, 'the per-guest ceiling must be a real number');

  let refusedAt = null;
  for (let i = 0; i < limit + 5; i++) {
    const res = await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, {
      name: 'Bob', status: i % 2 === 0 ? 'out' : 'in', guestToken: GUEST_TOKEN,
    });
    if (res.status === 429) { refusedAt = i; break; }
  }

  assert.strictEqual(refusedAt, limit, `the ceiling must bite at exactly ${limit} actions`);
  assert.ok(emits.length <= limit * 3, 'and the fan-out must stop with it');
});

test('the per-guest ceiling covers votes as well as RSVP edits', async () => {
  // One budget, one identity. Spending it on votes must not leave a fresh
  // allowance for RSVP fan-out, or the ceiling is decorative.
  scriptVote({ currentVotes: 1, currentVenue: 'Somewhere Else' });

  const limit = guest.GUEST_ACTIONS_PER_HOUR;
  let refusedAt = null;
  for (let i = 0; i < limit + 5; i++) {
    const res = await call('POST', `/api/guest/${LINK_TOKEN}/vote`, {
      guestToken: GUEST_TOKEN, venueName: 'The Bar',
    });
    if (res.status === 429) { refusedAt = i; break; }
  }
  assert.strictEqual(refusedAt, limit);
});

test('a budget refused before any work is done costs the caller no writes', async () => {
  scriptVote({ currentVotes: 1, currentVenue: 'Somewhere Else' });
  for (let i = 0; i < guest.GUEST_ACTIONS_PER_HOUR; i++) {
    await call('POST', `/api/guest/${LINK_TOKEN}/vote`, { guestToken: GUEST_TOKEN, venueName: 'The Bar' });
  }
  log = [];
  emits = [];
  poolCheckouts = 0;

  const res = await call('POST', `/api/guest/${LINK_TOKEN}/vote`, { guestToken: GUEST_TOKEN, venueName: 'The Bar' });
  assert.strictEqual(res.status, 429);
  assert.strictEqual(poolCheckouts, 0, 'a refused request must not check out a connection');
  assert.strictEqual(emits.length, 0);
});

test('re-spelling the guest token does not buy a second allowance', async () => {
  // Found by mutating the first version of this fix. Postgres compares the
  // `uuid` type case-insensitively, so `A1B2…` and `a1b2…` resolve to the SAME
  // guest row — but they are two different Map keys. A 36-character hex token
  // can be re-cased about 2^32 ways, so a budget keyed on the token string was
  // no budget at all: it is the identical defeat probeBudget.js records for the
  // limiter that was beaten "by changing the case of an email". The counter has
  // to be keyed on the row the database named, not on the string that found it.
  scriptVote({ currentVotes: 1, currentVenue: 'Somewhere Else' });

  const limit = guest.GUEST_ACTIONS_PER_HOUR;
  const spellings = [GUEST_TOKEN, GUEST_TOKEN.toUpperCase(), GUEST_TOKEN.replace(/b/g, 'B')];
  assert.strictEqual(new Set(spellings).size, 3, 'the fixture must actually offer three spellings');

  let allowed = 0;
  for (let i = 0; i < limit + 10; i++) {
    const res = await call('POST', `/api/guest/${LINK_TOKEN}/vote`, {
      guestToken: spellings[i % spellings.length], venueName: 'The Bar',
    });
    if (res.status === 429) break;
    allowed += 1;
  }

  assert.strictEqual(allowed, limit, 'the same guest gets one allowance however they spell their token');
});

test('two different guests on the same link have separate allowances', async () => {
  // Also found by mutation. If the identity the counter is keyed on is ever
  // missing — the edit lookup forgetting to select `id`, say — every guest in
  // the product lands in one bucket under the same undefined key, and the first
  // busy guest of the hour locks out everybody else on every link. A ceiling
  // that can be spent by somebody other than the person it bounds is worse than
  // no ceiling: it is a denial-of-service handed to any stranger with a link.
  scriptVote({ currentVotes: 1, currentVenue: 'Somewhere Else' });

  for (let i = 0; i < guest.GUEST_ACTIONS_PER_HOUR; i++) {
    await call('POST', `/api/guest/${LINK_TOKEN}/vote`, { guestToken: GUEST_TOKEN, venueName: 'The Bar' });
  }
  const spent = await call('POST', `/api/guest/${LINK_TOKEN}/vote`, { guestToken: GUEST_TOKEN, venueName: 'The Bar' });
  assert.strictEqual(spent.status, 429, 'the first guest is spent');

  const other = await call('POST', `/api/guest/${LINK_TOKEN}/vote`, { guestToken: GUEST_TOKEN_2, venueName: 'The Bar' });
  assert.strictEqual(other.status, 201, 'a different guest must be unaffected');
});

test('the same separation holds on the RSVP edit path', async () => {
  scriptEdit();
  on(/COALESCE\(is_hidden, false\) = true/, () => ({ rows: [] }));

  for (let i = 0; i < guest.GUEST_ACTIONS_PER_HOUR; i++) {
    await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, { name: 'Bob', status: i % 2 ? 'in' : 'out', guestToken: GUEST_TOKEN });
  }
  const spent = await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, { name: 'Bob', status: 'in', guestToken: GUEST_TOKEN });
  assert.strictEqual(spent.status, 429);

  const other = await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, { name: 'Cass', status: 'in', guestToken: GUEST_TOKEN_2 });
  assert.strictEqual(other.status, 200, 'a different guest must be unaffected');
});

test('re-spelling the token does not buy a second allowance on the edit path either', async () => {
  scriptEdit();
  on(/COALESCE\(is_hidden, false\) = true/, () => ({ rows: [] }));

  const limit = guest.GUEST_ACTIONS_PER_HOUR;
  const spellings = [GUEST_TOKEN, GUEST_TOKEN.toUpperCase(), GUEST_TOKEN.replace(/b/g, 'B')];
  assert.strictEqual(new Set(spellings).size, 3);

  let allowed = 0;
  for (let i = 0; i < limit + 10; i++) {
    const res = await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, {
      name: 'Bob', status: i % 2 ? 'in' : 'out', guestToken: spellings[i % spellings.length],
    });
    if (res.status === 429) break;
    allowed += 1;
  }
  assert.strictEqual(allowed, limit, 'one guest, one allowance, however they spell their token');
});

test('the edit lookup asks the database for the identity it budgets on', async () => {
  // The fake answers with whatever shape a test hands it, so it cannot notice a
  // column vanishing from the projection — and a missing `id` means every guest
  // in the product shares one undefined bucket. Asserted against the statement
  // that actually ran.
  scriptEdit();
  on(/COALESCE\(is_hidden, false\) = true/, () => ({ rows: [] }));

  await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, { name: 'Bob', status: 'in', guestToken: GUEST_TOKEN });

  const lookup = ran(/FROM guest_rsvps WHERE guest_token = \$1 AND flock_id = \$2/)[0];
  assert.ok(lookup, 'the edit path must look the guest up');
  assert.match(lookup.sql, /^SELECT id,/,
    'the per-guest budget is keyed on this row id; without it every guest shares one counter');
});

test('a count query that answers nothing is not read as "already voted"', async () => {
  // The fail-safe direction. If the repeat check cannot tell, the vote must go
  // through — reading an empty result as "unchanged" would silently drop a real
  // vote and tell the guest 201 while nothing was written, which is the one
  // outcome worse than doing the work twice.
  scriptVote({ countRows: [] });

  const res = await call('POST', `/api/guest/${LINK_TOKEN}/vote`, { guestToken: GUEST_TOKEN, venueName: 'The Bar' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(ran(/INSERT INTO guest_votes/).length, 1, 'a vote we cannot rule out is a vote we record');
});

test('the per-guest budget is only ever keyed on an identity the database confirmed', async () => {
  // The key space has to be bounded by rows that exist. Keying on the
  // caller-supplied token BEFORE the lookup would let anyone fill the map with
  // invented UUIDs — the same unbounded-key problem the IP maps have.
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SELECT id FROM guest_rsvps WHERE guest_token/, () => ({ rows: [] })); // no such guest

  for (let i = 0; i < 25; i++) {
    const res = await call('POST', `/api/guest/${LINK_TOKEN}/vote`, {
      guestToken: `2222${String(i).padStart(4, '0')}-1111-4111-8111-111111111111`,
      venueName: 'The Bar',
    });
    assert.strictEqual(res.status, 403, 'an unknown token is refused on its own merits');
  }
  assert.strictEqual(guest.guestActionLog.size, 0, 'and leaves nothing behind in the budget map');
});

// ===========================================================================
// PART 3 — the in-memory maps are bounded, and a flood cannot reset them
// ===========================================================================
//
// newGuestLog is keyed on "ip|flockId". Its only maintenance was "if the map is
// over 5000, delete the entries that have already EXPIRED" — which does nothing
// at all while the flood is live, because a one-hour window means none of them
// have. So the map grew without any ceiling, and past 5000 entries every single
// new-guest request paid a full O(n) scan of it first. Rotating source
// addresses is the cheapest thing an attacker does and it is the exact input
// this map takes.

test('newGuestLog stays bounded under a flood of fresh addresses', () => {
  for (let i = 0; i < 40000; i++) {
    guest.allowNewGuest(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, 42);
  }
  assert.ok(
    guest.newGuestLog.size <= guest.NEW_GUEST_MAX_KEYS,
    `newGuestLog grew to ${guest.newGuestLog.size}, past its ${guest.NEW_GUEST_MAX_KEYS} ceiling`
  );
});

test('a flood cannot hand a spender back their own new-guest allowance', () => {
  // The lesson utils/probeBudget.js and routes/checkin.js both spell out: an
  // attacker spends first and floods second, so oldest-first eviction (and any
  // wholesale clear) deletes precisely the counter they wanted gone.
  const mine = '203.0.113.7';
  for (let i = 0; i < guest.NEW_GUESTS_PER_IP_PER_FLOCK; i++) assert.strictEqual(guest.allowNewGuest(mine, 42), true);
  assert.strictEqual(guest.allowNewGuest(mine, 42), false, 'spent');

  for (let i = 0; i < 40000; i++) {
    guest.allowNewGuest(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, 42);
  }

  assert.strictEqual(guest.allowNewGuest(mine, 42), false,
    'flooding the map must not recover a spent allowance');
});

test('an expired entry is evicted before a live one, however much it consumed', () => {
  // Eviction sorts by CONSUMPTION, which is right for live entries and exactly
  // wrong for dead ones: a spent-out entry whose window has already rolled is
  // worth nothing and would otherwise outrank every live entry in the map. So
  // the expiry pass has to run first. Exercised on a small counter of its own
  // rather than on the real 20,000-key one.
  const c = guest.createGuestCounter({ name: 'expiry-probe', limit: 5, windowMs: 60000, maxKeys: 10 });

  for (let i = 0; i < 5; i++) for (let k = 0; k < 5; k++) c.allow(`spent-${i}`);
  for (const [, v] of c.entries) v.resetAt = Date.now() - 1; // their hour has passed

  for (let i = 0; i < 6; i++) c.allow(`live-${i}`);

  for (let i = 0; i < 5; i++) {
    assert.ok(!c.entries.has(`spent-${i}`), `spent-${i} is expired and must be dropped first`);
  }
  for (let i = 0; i < 6; i++) {
    assert.ok(c.entries.has(`live-${i}`), `live-${i} is a real counter and must survive`);
  }
});

test('the per-guest action budget is bounded the same way', () => {
  for (let i = 0; i < 40000; i++) {
    guest.allowGuestAction(`token-${i}`);
  }
  assert.ok(
    guest.guestActionLog.size <= guest.GUEST_ACTION_MAX_KEYS,
    `guestActionLog grew to ${guest.guestActionLog.size}`
  );

  const mine = 'spent-token';
  for (let i = 0; i < guest.GUEST_ACTIONS_PER_HOUR; i++) guest.allowGuestAction(mine);
  assert.strictEqual(guest.allowGuestAction(mine), false, 'spent');
  for (let i = 40000; i < 80000; i++) guest.allowGuestAction(`token-${i}`);
  assert.strictEqual(guest.allowGuestAction(mine), false, 'and stays spent through a flood');
});

// ===========================================================================
// PART 4 — a guest link to a plan that is over is not a live write surface
// ===========================================================================

test('a cancelled flock takes no new guest RSVPs', async () => {
  on(/FROM flock_invite_links/, () => ({ rows: [link({ status: 'cancelled' })] }));
  scriptAnnounce();
  on(/SELECT COUNT\(\*\)::int AS n FROM guest_rsvps/, () => ({ rows: [{ n: 0 }] }));
  on(/INSERT INTO guest_rsvps/, () => ({ rows: [{ id: 5, guest_token: GUEST_TOKEN, is_hidden: false }] }));

  const res = await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, { name: 'Alice', status: 'in' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(ran(/INSERT INTO guest_rsvps/).length, 0, 'nothing is written for a cancelled plan');
  assert.strictEqual(emits.length, 0, 'and the host is not told somebody is coming to it');
});

test('a completed flock takes no new guest votes', async () => {
  scriptVote({ currentVotes: 0 });
  handlers = handlers.filter(([re]) => !re.test('FROM flock_invite_links il'));
  on(/FROM flock_invite_links/, () => ({ rows: [link({ status: 'completed' })] }));

  const res = await call('POST', `/api/guest/${LINK_TOKEN}/vote`, { guestToken: GUEST_TOKEN, venueName: 'The Bar' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(ran(/INSERT INTO guest_votes/).length, 0);
});

test('the preview of a cancelled flock still loads', async () => {
  // Refusing to WRITE is not refusing to look. Somebody holding the link needs
  // to be able to see that the plan is off.
  on(/FROM flock_invite_links/, () => ({ rows: [link({ status: 'cancelled' })] }));
  on(/SUM\(c\)::int AS votes/, () => ({ rows: [] }));
  on(/AS members/, () => ({ rows: [{ members: 2, guests: 0 }] }));

  const res = await call('GET', `/api/guest/${LINK_TOKEN}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.flock.status, 'cancelled');
});

test('a brand-new guest still cannot claim a moderator-removed name', async () => {
  // Round 15's original property, pinned here because the edit-path fix moved
  // the query behind a shared helper and a shared helper is exactly the thing
  // that can be quietly wired up on one caller and not the other.
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SELECT COUNT\(\*\)::int AS n FROM guest_rsvps/, () => ({ rows: [{ n: 0 }] }));
  on(/COALESCE\(is_hidden, false\) = true/, () => ({ rows: [{ '?column?': 1 }] }));
  on(/INSERT INTO guest_rsvps/, () => ({ rows: [{ id: 5, guest_token: GUEST_TOKEN, is_hidden: false }] }));
  scriptAnnounce();

  const res = await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, { name: 'Removed Name', status: 'in' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(ran(/INSERT INTO guest_rsvps/).length, 0, 'dropping the token must not mint the name again');
  assert.strictEqual(emits.length, 0);
});

test('a planning flock is still a live write surface', async () => {
  // The control for the whole of part 4.
  on(/FROM flock_invite_links/, () => ({ rows: [link({ status: 'planning' })] }));
  on(/SELECT COUNT\(\*\)::int AS n FROM guest_rsvps/, () => ({ rows: [{ n: 0 }] }));
  on(/COALESCE\(is_hidden, false\) = true/, () => ({ rows: [] }));
  on(/INSERT INTO guest_rsvps/, () => ({ rows: [{ id: 5, guest_token: GUEST_TOKEN, is_hidden: false }] }));
  scriptAnnounce();

  const res = await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, { name: 'Alice', status: 'in' });
  assert.strictEqual(res.status, 201);
});

// ===========================================================================
// PART 5 — routes/checkin.js tryAuth must not be a weaker door than
//          middleware/auth.js
// ===========================================================================
//
// tryAuth is a deliberate COPY of the middleware's revocation rules, because the
// NFC tap has to succeed for anonymous callers and cannot 401. Round 15 brought
// token_version and is_banned across. The algorithm pin did not come with them:
// middleware/auth.js verifies with `{ algorithms: ['HS256'] }` and says in its
// own comment why ("a future change to how JWT_SECRET is loaded can never
// silently widen the accepted algorithm set"). tryAuth called jwt.verify with no
// options at all, so it accepted the whole HMAC family that the rest of the app
// refuses — on the app's only anonymous-friendly write path, where an accepted
// identity mints a venue_checkins row, an occupancy event and flock attendance.

const { tryAuth } = checkinRouter.__test;

function userRow(over = {}) {
  return { id: 4, is_banned: false, token_version: 0, ...over };
}

test('tryAuth accepts the algorithm the rest of the app signs with', async () => {
  on(/FROM users WHERE id = \$1/, () => ({ rows: [userRow()] }));
  const token = jwt.sign({ userId: 4, tv: 0 }, process.env.JWT_SECRET, { algorithm: 'HS256' });
  assert.strictEqual(await tryAuth({ headers: { authorization: `Bearer ${token}` } }), 4);
});

test('tryAuth refuses an algorithm middleware/auth.js would refuse', async () => {
  on(/FROM users WHERE id = \$1/, () => ({ rows: [userRow()] }));
  for (const algorithm of ['HS384', 'HS512']) {
    const token = jwt.sign({ userId: 4, tv: 0 }, process.env.JWT_SECRET, { algorithm });
    assert.strictEqual(
      await tryAuth({ headers: { authorization: `Bearer ${token}` } }), null,
      `${algorithm} is rejected by every other route in the app and must be rejected here`
    );
  }
});

test('tryAuth still enforces the two revocation controls it was given', async () => {
  const token = jwt.sign({ userId: 4, tv: 0 }, process.env.JWT_SECRET);

  handlers = [];
  on(/FROM users WHERE id = \$1/, () => ({ rows: [userRow({ token_version: 3 })] }));
  assert.strictEqual(await tryAuth({ headers: { authorization: `Bearer ${token}` } }), null, 'stale tv');

  handlers = [];
  on(/FROM users WHERE id = \$1/, () => ({ rows: [userRow({ is_banned: true })] }));
  assert.strictEqual(await tryAuth({ headers: { authorization: `Bearer ${token}` } }), null, 'banned');
});

// ===========================================================================
// PART 6 — the shape rule has one spelling
// ===========================================================================

// ===========================================================================
// PART 7 — every read of guest_rsvps honours the takedown
// ===========================================================================
//
// This is the failure the venue-event takedown had days ago and that migration
// 005 had for two rounds before that: the column lands, one or two readers are
// updated, and the next reader written after the migration never hears about
// it. guest_rsvps.name is unauthenticated UGC on a flock roster, so a reader
// that forgets the filter renders a name a moderator removed.
//
// Enumerated from the source rather than asserted route by route, so a NEW
// reader added later is covered by a test nobody had to remember to write.
// routes/admin.js is excluded on purpose: the moderator console has to see
// hidden rows, and its queue query selects the flag explicitly.

const GUEST_READERS = [
  'routes/guest.js', 'routes/flocks.js', 'routes/venues.js',
  'routes/moderation.js', 'sockets/handlers.js', 'utils/guestRsvp.js',
];

// The statements that touch guest_rsvps WITHOUT filtering the flag, each for a
// stated reason. Anything not on this list must filter.
const DELIBERATE = [
  // The 50-guest cap counts hidden rows on purpose: a takedown must not hand
  // the abuser a fresh slot.
  'SELECT COUNT(*)::int AS n FROM guest_rsvps',
  // Writes, not reads.
  'INSERT INTO guest_rsvps',
];

test('every read of guest_rsvps outside the moderator console honours is_hidden', () => {
  const misses = [];
  for (const rel of GUEST_READERS) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\s+/g, ' ');
    // Only where the table is actually being addressed in SQL. The bare name
    // appears all over the prose in these files, and `guest_rsvp_id` is a
    // column on a different table.
    for (const m of src.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+guest_rsvps\b/g)) {
      const i = m.index;
      const window = src.slice(Math.max(0, i - 280), i + 340);
      if (/is_hidden/.test(window)) continue;
      if (DELIBERATE.some((d) => window.includes(d))) continue;
      misses.push(`${rel}: ...${src.slice(Math.max(0, i - 90), i + 130)}...`);
    }
  }
  assert.deepStrictEqual(misses, [],
    'a read of guest_rsvps with no is_hidden filter renders guests a moderator removed');
});

test('the guest router uses validators/shape.js rather than a private copy', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'guest.js'), 'utf8');
  assert.match(src, /require\('\.\.\/validators\/shape'\)/, 'shape guards come from the one module');
  assert.ok(!/const\s+isScalar\s*=/.test(src), 'no local re-definition of the scalar guard');
});

test('a non-scalar name is a 400 before any query runs', async () => {
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  const res = await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, { name: ['<b>x</b>'], status: 'in' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(log.length, 0, 'shape is settled before the link is even resolved');
});

test('a null guestToken is a new guest, not a 400', async () => {
  // express-validator's .optional() skips only `undefined`; the shipping client
  // sends `null` for a first-time guest.
  on(/FROM flock_invite_links/, () => ({ rows: [link()] }));
  on(/SELECT COUNT\(\*\)::int AS n FROM guest_rsvps/, () => ({ rows: [{ n: 0 }] }));
  on(/COALESCE\(is_hidden, false\) = true/, () => ({ rows: [] }));
  on(/INSERT INTO guest_rsvps/, () => ({ rows: [{ id: 5, guest_token: GUEST_TOKEN, is_hidden: false }] }));
  scriptAnnounce();

  const res = await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, { name: 'Alice', status: 'in', guestToken: null });
  assert.strictEqual(res.status, 201);
});
