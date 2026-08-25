// Run: node --test  (from backend/)
//
// ─────────────────────────────────────────────────────────────────────────────
// GAME-RULE ABUSE — venue reviews and the owner reply (routes/venueDashboard.js)
// ─────────────────────────────────────────────────────────────────────────────
//
// The review system has one careful gate (presence: a signed NFC tap, or a
// flock with two accepted members) and one careful anti-self-dealing rule.
// The anti-self-dealing rule is on PROMOTION VIEW COUNTS: the UPDATE carries
// `venue_user_id <> $2` and a long comment explaining that an owner must not
// move a number the product charges them to read. Nothing of the kind exists
// on the star rating, which is the number consumers actually choose venues by.
//
// Findings pinned here, all currently REPRODUCIBLE:
//
//   I. THE OWNER CAN REVIEW THEIR OWN VENUE. POST /submit-review never
//      compares req.user.id to venue_profiles.user_id for the place id being
//      rated. The verified owner of a venue can post themselves five stars and
//      it lands in both aggregates, rendered as an ordinary customer review
//      with their user name and photo.
//
//   J. THE SAME ACCOUNT CAN BE BOTH VOICES. venue_reviews has no author column
//      on the reply, so an owner can hold a five-star customer review AND
//      speak as the business under the verified badge on the same venue, on
//      the same page, with nothing linking or labelling the two.
//
//   K. A REVIEW IS ITS OWN PERPETUAL PRESENCE PROOF. The third EXISTS in the
//      presence check is "you already have a review row here". Presence is
//      therefore bought ONCE per (account, venue) and never expires, so a
//      one-star review can be rewritten forever from an account whose only
//      visit was a fabricated flock 30 days ago.
//
//   L. SUPPRESSION WITHOUT MODERATION. The public list is
//      `ORDER BY created_at DESC LIMIT n`, and the upsert sets
//      `created_at = NOW()` on every edit. Resubmitting existing reviews
//      re-dates them, so an owner with a handful of accounts can push a
//      negative review off the visible page without a takedown, a reply, or
//      any new review rows at all.
//
// And what HELD, asserted so it stays that way: an unverified claim cannot
// reply, a hidden review cannot be replied to, and no non-'nfc' check-in
// source has ever been able to buy presence.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'abuse-venue-review-test-secret';

const pool = require('../config/database');

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const PLACE = 'ChIJownvenue00000001';
const OTHER_PLACE = 'ChIJownvenue00000002';

// ── The semantic world ───────────────────────────────────────────────────────
let world;
function freshWorld() {
  return {
    profiles: [],     // { id, user_id, google_place_id, verified, category }
    reviews: [],      // { id, google_place_id, user_id, rating, text, venue_reply, venue_replied_at, created_at, is_hidden }
    checkins: [],     // { user_id, venue_place_id, checkin_source, ageDays }
    flocks: new Map(),// id -> { id, venue_id, status, event_time }
    members: [],      // { flock_id, user_id, status }
    users: new Map(), // id -> { id, name, profile_image_url }
    nextReviewId: 1,
    clock: Date.now(),
  };
}
function profileFor(userId) {
  return world.profiles.find((p) => p.user_id === userId) || null;
}
function visibleReviews(placeId) {
  return world.reviews
    .filter((r) => r.google_place_id === placeId && !r.is_hidden && world.users.has(r.user_id))
    .sort((a, b) => b.created_at - a.created_at);
}
function hasVerifiedProfile(placeId) {
  return world.profiles.some((p) => p.google_place_id === placeId && p.verified === true);
}
// The presence disjunction, executed rather than pattern-matched.
function presenceVisited(userId, placeId, sql) {
  const nfcClause = /checkin_source = 'nfc'/.test(sql);
  const twoMemberClause = /\) >= 2/.test(sql);
  const priorReviewClause = /OR EXISTS \( SELECT 1 FROM venue_reviews WHERE user_id = \$1 AND google_place_id = \$2 \)/.test(sql);

  const byTap = nfcClause && world.checkins.some((c) =>
    c.user_id === userId && c.venue_place_id === placeId
    && c.checkin_source === 'nfc' && c.ageDays <= 30);

  const byFlock = world.members.some((m) => {
    if (m.user_id !== userId || m.status !== 'accepted') return false;
    const f = world.flocks.get(m.flock_id);
    if (!f || f.venue_id !== placeId) return false;
    if (f.status === 'cancelled') return false;
    if (!f.event_time) return false;
    const dt = (world.clock - new Date(f.event_time).getTime()) / 86400e3;
    if (!(dt <= 30 && dt >= -0.5)) return false;
    if (!twoMemberClause) return true;
    return world.members.filter((x) => x.flock_id === m.flock_id && x.status === 'accepted').length >= 2;
  });

  const byPriorReview = priorReviewClause
    && world.reviews.some((r) => r.user_id === userId && r.google_place_id === placeId);

  return byTap || byFlock || byPriorReview;
}

let log = [];
let unknown = [];
function assertQueriesUnderstood() {
  assert.deepStrictEqual(unknown, [], `unmodelled queries: ${JSON.stringify(unknown.slice(0, 3))}`);
}

async function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params });
  const p = params || [];

  if (/^SELECT id, google_place_id, verified, category, verification_requested_at FROM venue_profiles WHERE user_id = \$1$/.test(flat)) {
    const v = profileFor(Number(p[0]));
    return v ? { rows: [v], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // submit-review presence check
  if (/AS visited$/.test(flat)) {
    return { rows: [{ visited: presenceVisited(Number(p[0]), p[1], flat) }], rowCount: 1 };
  }

  // submit-review upsert
  if (/^INSERT INTO venue_reviews/.test(flat)) {
    const [placeId, userId, rating, text] = [p[0], Number(p[1]), Number(p[2]), p[3]];
    const existing = world.reviews.find((r) => r.google_place_id === placeId && r.user_id === userId);
    const clearsReply = /venue_reply = CASE WHEN EXCLUDED\.rating IS DISTINCT FROM/.test(flat);
    if (existing) {
      const changed = existing.rating !== rating || (existing.text ?? null) !== (text ?? null);
      existing.rating = rating;
      existing.text = text ?? null;
      // The route sets created_at = NOW() on every edit. Modelled exactly.
      existing.created_at = world.clock;
      if (clearsReply && changed) { existing.venue_reply = null; existing.venue_replied_at = null; }
      return { rows: [{ ...existing }], rowCount: 1 };
    }
    const row = {
      id: world.nextReviewId++, google_place_id: placeId, user_id: userId, rating,
      text: text ?? null, venue_reply: null, venue_replied_at: null,
      created_at: world.clock, is_hidden: false,
    };
    world.reviews.push(row);
    return { rows: [{ ...row }], rowCount: 1 };
  }

  // owner reply
  if (/^UPDATE venue_reviews SET venue_reply = \$1/.test(flat)) {
    const hiddenGuard = /COALESCE\(is_hidden, false\) = false/.test(flat);
    const r = world.reviews.find((x) => x.id === Number(p[1]) && x.google_place_id === p[2]
      && (!hiddenGuard || !x.is_hidden));
    if (!r) return { rows: [], rowCount: 0 };
    r.venue_reply = p[0];
    r.venue_replied_at = world.clock;
    return { rows: [{ ...r }], rowCount: 1 };
  }

  // public-reviews stats
  if (/SELECT COUNT\(\*\)::int AS total, AVG\(vr\.rating\)::float AS average FROM venue_reviews/.test(flat)) {
    const rows = visibleReviews(p[0]);
    return {
      rows: [{ total: rows.length, average: rows.length ? rows.reduce((a, r) => a + r.rating, 0) / rows.length : null }],
      rowCount: 1,
    };
  }
  // public-reviews list
  if (/^SELECT vr\.id, vr\.rating, vr\.text,/.test(flat)) {
    const limit = Number(p[2]);
    const gated = /vp\.verified = true/.test(flat);
    const rows = visibleReviews(p[0]).slice(0, limit).map((r) => ({
      id: r.id, rating: r.rating, text: r.text,
      venue_reply: (!gated || hasVerifiedProfile(r.google_place_id)) ? r.venue_reply : null,
      venue_replied_at: (!gated || hasVerifiedProfile(r.google_place_id)) ? r.venue_replied_at : null,
      created_at: new Date(r.created_at).toISOString(),
      name: world.users.get(r.user_id)?.name || null,
      profile_image_url: null,
    }));
    return { rows, rowCount: rows.length };
  }
  // owner dashboard stats
  if (/COUNT\(\*\) FILTER \(WHERE vr\.rating = 1\)/.test(flat)) {
    const rows = visibleReviews(p[0]);
    const c = (n) => rows.filter((r) => r.rating === n).length;
    return {
      rows: [{
        total: rows.length,
        average: rows.length ? rows.reduce((a, r) => a + r.rating, 0) / rows.length : null,
        r1: c(1), r2: c(2), r3: c(3), r4: c(4), r5: c(5),
      }],
      rowCount: 1,
    };
  }
  // owner dashboard list
  if (/^SELECT vr\.\*, u\.name, u\.profile_image_url FROM venue_reviews/.test(flat)) {
    const rows = visibleReviews(p[0]).slice(0, Number(p[1])).map((r) => ({
      ...r, created_at: new Date(r.created_at).toISOString(), name: world.users.get(r.user_id)?.name || null,
    }));
    return { rows, rowCount: rows.length };
  }

  unknown.push(flat.slice(0, 160));
  throw new Error(`unscripted query: ${flat.slice(0, 160)}`);
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({ query: (sql, params) => dispatch(sql, params), release: () => {} });

const dashRouter = require('../routes/venueDashboard');

const app = express();
app.use(express.json());
app.set('io', null);
app.use('/api/venue-dashboard', dashRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => { world = freshWorld(); log = []; unknown = []; });

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
const as = (id, name) => {
  CURRENT_USER = { id, name, email_verified: true, role: 'user' };
  world.users.set(id, { id, name, profile_image_url: null });
};
const review = (placeId, rating, text) =>
  call('POST', '/api/venue-dashboard/submit-review', { googlePlaceId: placeId, rating, text });

// The cheapest presence there is: one flock at the venue with two accepted
// members. venue_id is client-supplied and the flock need never have happened.
function fabricatedFlock(id, placeId, userIds, { daysAgo = 1 } = {}) {
  world.flocks.set(id, {
    id, venue_id: placeId, status: 'completed',
    event_time: new Date(world.clock - daysAgo * 86400e3).toISOString(),
  });
  for (const uid of userIds) world.members.push({ flock_id: id, user_id: uid, status: 'accepted' });
}

// ═════════════════════════════════════════════════════════════════════════════
// I. THE OWNER REVIEWS THEIR OWN VENUE
// ═════════════════════════════════════════════════════════════════════════════

test('ABUSE I: the verified owner of a venue gives it five stars and it counts', async () => {
  const OWNER = 500;
  const FRIEND = 501;
  as(OWNER, 'Rick the Owner');
  as(FRIEND, 'Friend');
  world.profiles.push({ id: 1, user_id: OWNER, google_place_id: PLACE, verified: true, category: 'bar', verification_requested_at: null });

  // The owner's presence at their own bar is trivially arranged.
  fabricatedFlock(1, PLACE, [OWNER, FRIEND]);

  as(OWNER, 'Rick the Owner');
  const r = await review(PLACE, 5, 'Best bar in town, honestly.');
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.body.rating, 5);
  assert.strictEqual(r.body.user_id, OWNER);

  // Nothing on the write path ever asked whether this user owns this venue.
  const askedOwnership = log.some((q) =>
    /venue_profiles/.test(q.sql) && /google_place_id = \$/.test(q.sql) && /user_id/.test(q.sql));
  assert.strictEqual(askedOwnership, false,
    'submit-review never reads venue_profiles for the place id it is rating');

  // And it lands on the consumer surface as an ordinary customer review.
  as(999, 'Some User');
  const pub = await call('GET', `/api/venue-dashboard/public-reviews/${PLACE}`);
  assert.strictEqual(pub.status, 200, pub.text);
  assert.strictEqual(pub.body.average, 5);
  assert.strictEqual(pub.body.total, 1);
  assert.strictEqual(pub.body.reviews[0].name, 'Rick the Owner',
    'shown with the owner\'s own name and photo, with nothing marking it as the owner');
  assertQueriesUnderstood();
});

test('ABUSE I2: the owner\'s self-review outweighs a real customer, and the owner tab agrees', async () => {
  const OWNER = 510;
  const CUSTOMER = 511;
  const FRIEND = 512;
  as(OWNER, 'Rick'); as(CUSTOMER, 'Real Customer'); as(FRIEND, 'Friend');
  world.profiles.push({ id: 1, user_id: OWNER, google_place_id: PLACE, verified: true, category: 'bar', verification_requested_at: null });
  fabricatedFlock(1, PLACE, [OWNER, FRIEND]);
  fabricatedFlock(2, PLACE, [CUSTOMER, FRIEND]);

  as(CUSTOMER, 'Real Customer');
  await review(PLACE, 1, 'Waited an hour, never got served.');
  as(999, 'Reader');
  let pub = await call('GET', `/api/venue-dashboard/public-reviews/${PLACE}`);
  assert.strictEqual(pub.body.average, 1);

  as(OWNER, 'Rick');
  await review(PLACE, 5, 'Wonderful place.');
  as(999, 'Reader');
  pub = await call('GET', `/api/venue-dashboard/public-reviews/${PLACE}`);
  assert.strictEqual(pub.body.average, 3, 'one owner POST moved a 1.0 venue to a 3.0');

  // The owner's own dashboard shows the same inflated number back to them.
  as(OWNER, 'Rick');
  const dash = await call('GET', '/api/venue-dashboard/reviews');
  assert.strictEqual(dash.body.stats.average, 3);
  assert.deepStrictEqual(dash.body.stats.distribution, [1, 0, 0, 0, 1]);
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// J. BOTH VOICES AT ONCE
// ═════════════════════════════════════════════════════════════════════════════

test('ABUSE J: one account is a five-star customer AND the verified business voice on the same page', async () => {
  const OWNER = 520;
  const CUSTOMER = 521;
  const FRIEND = 522;
  as(OWNER, 'Rick'); as(CUSTOMER, 'Real Customer'); as(FRIEND, 'Friend');
  world.profiles.push({ id: 1, user_id: OWNER, google_place_id: PLACE, verified: true, category: 'bar', verification_requested_at: null });
  fabricatedFlock(1, PLACE, [OWNER, FRIEND]);
  fabricatedFlock(2, PLACE, [CUSTOMER, FRIEND]);

  as(CUSTOMER, 'Real Customer');
  const bad = await review(PLACE, 1, 'Rude staff.');

  as(OWNER, 'Rick');
  const mine = await review(PLACE, 5, 'Lovely spot, great staff.');
  const replied = await call('POST', `/api/venue-dashboard/reviews/${bad.body.id}/reply`, {
    reply: 'We are sorry to hear this and would love to make it right.',
  });
  assert.strictEqual(replied.status, 200, replied.text);

  as(999, 'Reader');
  const pub = await call('GET', `/api/venue-dashboard/public-reviews/${PLACE}`);
  const asCustomer = pub.body.reviews.find((r) => r.id === mine.body.id);
  const withReply = pub.body.reviews.find((r) => r.id === bad.body.id);

  assert.strictEqual(asCustomer.rating, 5);
  assert.strictEqual(asCustomer.name, 'Rick', 'the owner appears as a reviewer');
  assert.ok(withReply.venue_reply, 'and as the business, under the verified badge');
  assert.strictEqual('venue_reply_user_id' in withReply, false,
    'the reply carries no author column, so the two voices cannot be connected by a reader OR by a moderator',
  );
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// K. A REVIEW IS ITS OWN PERPETUAL PRESENCE PROOF
// ═════════════════════════════════════════════════════════════════════════════

test('ABUSE K: presence is bought once per account per venue and never expires', async () => {
  const A = 530;
  const B = 531;
  as(A, 'Mallory'); as(B, 'Puppet');

  // One fabricated flock, 29 days old, buys presence for BOTH accounts at once:
  // the >= 2 clause counts the flock's members, not each reviewer's evidence.
  fabricatedFlock(1, PLACE, [A, B], { daysAgo: 29 });
  as(A, 'Mallory');
  const first = await review(PLACE, 1, 'Terrible.');
  assert.strictEqual(first.status, 201, first.text);
  as(B, 'Puppet');
  assert.strictEqual((await review(PLACE, 1, 'Also terrible.')).status, 201,
    'one flock, two reviewers');

  // The flock ages out of the 30-day window. The tap window is irrelevant
  // (there was never a tap). Presence should now be gone.
  world.flocks.get(1).event_time = new Date(world.clock - 400 * 86400e3).toISOString();

  as(A, 'Mallory');
  const rewrite = await review(PLACE, 1, 'Still terrible, a year on, and I have not been back.');
  assert.strictEqual(rewrite.status, 201, rewrite.text);
  assert.match(rewrite.body.text, /a year on/,
    'the existing row is its own proof, so the review can be rewritten indefinitely');

  // A different account with no history is still refused, which is the rule
  // working exactly as intended for a first review.
  as(540, 'Stranger');
  const stranger = await review(PLACE, 1, 'Never been, one star.');
  assert.strictEqual(stranger.status, 403, stranger.text);
  assert.strictEqual(stranger.body.code, 'VISIT_REQUIRED');
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// L. SUPPRESSION WITHOUT MODERATION
// ═════════════════════════════════════════════════════════════════════════════

test('ABUSE L: resubmitting old reviews re-dates them and pushes a negative review off the page', async () => {
  const OWNER = 550;
  const VICTIM = 551;
  const FRIEND = 552;
  as(OWNER, 'Rick'); as(VICTIM, 'Unhappy'); as(FRIEND, 'Friend');
  world.profiles.push({ id: 1, user_id: OWNER, google_place_id: PLACE, verified: true, category: 'bar', verification_requested_at: null });

  // Five accounts the owner controls, all given presence by ONE fabricated
  // flock, each holding an old five-star review.
  const puppets = [561, 562, 563, 564, 565];
  for (const id of puppets) as(id, `Fan${id}`);
  fabricatedFlock(1, PLACE, puppets);
  fabricatedFlock(2, PLACE, [VICTIM, FRIEND]);

  world.clock = Date.now() - 90 * 86400e3;
  for (const id of puppets) { as(id, `Fan${id}`); await review(PLACE, 5, 'Great!'); }

  // The bad review arrives today and is naturally at the top of the page.
  world.clock = Date.now();
  as(VICTIM, 'Unhappy');
  const bad = await review(PLACE, 1, 'Bouncer was aggressive.');

  as(999, 'Reader');
  let page = await call('GET', '/api/venue-dashboard/public-reviews/' + PLACE + '?limit=3');
  assert.strictEqual(page.body.reviews[0].id, bad.body.id, 'newest first');

  // The owner does nothing that moderation can see: each puppet re-posts the
  // review it already had. The upsert sets created_at = NOW() on every edit,
  // so all five jump above the complaint.
  world.clock = Date.now() + 1000;
  for (const id of puppets) { as(id, `Fan${id}`); await review(PLACE, 5, `Great! ${id}`); }

  as(999, 'Reader');
  page = await call('GET', '/api/venue-dashboard/public-reviews/' + PLACE + '?limit=3');
  assert.strictEqual(page.body.reviews.some((r) => r.id === bad.body.id), false,
    'the complaint is off the visible page without a takedown, a reply, or a single new row');
  assert.deepStrictEqual(page.body.reviews.map((r) => r.rating), [5, 5, 5]);
  // The aggregate still knows, which is the one thing that limits this.
  assert.strictEqual(page.body.total, 6);
  assertQueriesUnderstood();
});

test('ABUSE L2: a reviewer editing their own review silently deletes the owner\'s reply', async () => {
  const OWNER = 570;
  const REVIEWER = 571;
  const FRIEND = 572;
  as(OWNER, 'Rick'); as(REVIEWER, 'Reviewer'); as(FRIEND, 'Friend');
  world.profiles.push({ id: 1, user_id: OWNER, google_place_id: PLACE, verified: true, category: 'bar', verification_requested_at: null });
  fabricatedFlock(2, PLACE, [REVIEWER, FRIEND]);

  as(REVIEWER, 'Reviewer');
  const r = await review(PLACE, 5, 'Lovely.');
  as(OWNER, 'Rick');
  await call('POST', `/api/venue-dashboard/reviews/${r.body.id}/reply`, { reply: 'Thanks for coming!' });

  // The clearing rule is deliberate and correct: it stops the owner's words
  // being reattached to different content. The abuse is the other direction —
  // a reviewer can strip a reply they dislike at will, and the owner is told
  // nothing.
  as(REVIEWER, 'Reviewer');
  await review(PLACE, 5, 'Lovely place.');
  as(999, 'Reader');
  const pub = await call('GET', `/api/venue-dashboard/public-reviews/${PLACE}`);
  assert.strictEqual(pub.body.reviews[0].venue_reply, null,
    'a one-character edit removes the business reply, repeatably, with no notice to the owner');
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// WHAT HELD
// ═════════════════════════════════════════════════════════════════════════════

test('HELD: no check-in source other than a signed NFC tap can buy presence', async () => {
  const U = 580;
  as(U, 'Walker');
  // A manual check-in, an unsigned tap and a gps row, all at the venue, all
  // recent. routes/checkin.js writes 'manual' for the in-app button and
  // 'nfc_unverified' for a tap with no valid HMAC; nothing writes 'gps' at all.
  world.checkins.push(
    { user_id: U, venue_place_id: PLACE, checkin_source: 'manual', ageDays: 0 },
    { user_id: U, venue_place_id: PLACE, checkin_source: 'nfc_unverified', ageDays: 0 },
    { user_id: U, venue_place_id: PLACE, checkin_source: 'gps', ageDays: 0 },
  );
  const r = await review(PLACE, 1, 'One star from a phone that never left the house.');
  assert.strictEqual(r.status, 403, r.text);
  assert.strictEqual(r.body.code, 'VISIT_REQUIRED');

  // The signed tap, and only the signed tap, opens the door.
  world.checkins.push({ user_id: U, venue_place_id: PLACE, checkin_source: 'nfc', ageDays: 3 });
  assert.strictEqual((await review(PLACE, 1, 'Now allowed.')).status, 201);
  assertQueriesUnderstood();
});

test('HELD: an UNVERIFIED claim on the same place cannot speak as the business', async () => {
  const REAL = 590;
  const SQUATTER = 591;
  const REVIEWER = 592;
  const FRIEND = 593;
  as(REAL, 'Rick'); as(SQUATTER, 'Squatter'); as(REVIEWER, 'Reviewer'); as(FRIEND, 'Friend');
  world.profiles.push(
    { id: 1, user_id: REAL, google_place_id: PLACE, verified: true, category: 'bar', verification_requested_at: null },
    { id: 2, user_id: SQUATTER, google_place_id: PLACE, verified: false, category: null, verification_requested_at: null },
  );
  fabricatedFlock(2, PLACE, [REVIEWER, FRIEND]);
  as(REVIEWER, 'Reviewer');
  const r = await review(PLACE, 1, 'Bad night.');

  as(SQUATTER, 'Squatter');
  const attempt = await call('POST', `/api/venue-dashboard/reviews/${r.body.id}/reply`, { reply: 'We do not care.' });
  assert.strictEqual(attempt.status, 403, attempt.text);
  assert.match(attempt.body.error, /verified/i);
  assertQueriesUnderstood();
});

test('HELD: a hidden review cannot be replied to, and the reply route does not read it back', async () => {
  const OWNER = 600;
  const REVIEWER = 601;
  const FRIEND = 602;
  as(OWNER, 'Rick'); as(REVIEWER, 'Reviewer'); as(FRIEND, 'Friend');
  world.profiles.push({ id: 1, user_id: OWNER, google_place_id: PLACE, verified: true, category: 'bar', verification_requested_at: null });
  fabricatedFlock(2, PLACE, [REVIEWER, FRIEND]);
  as(REVIEWER, 'Reviewer');
  const r = await review(PLACE, 1, 'Content a moderator later removed.');
  world.reviews.find((x) => x.id === r.body.id).is_hidden = true;

  as(OWNER, 'Rick');
  const attempt = await call('POST', `/api/venue-dashboard/reviews/${r.body.id}/reply`, { reply: 'hi' });
  assert.strictEqual(attempt.status, 404, attempt.text);
  assert.strictEqual(attempt.text.includes('moderator later removed'), false,
    'the removed text is not handed back through the write endpoint');
  assertQueriesUnderstood();
});

test('HELD: an owner cannot review a venue they have never been to just by owning a DIFFERENT one', async () => {
  const OWNER = 610;
  as(OWNER, 'Rick');
  world.profiles.push({ id: 1, user_id: OWNER, google_place_id: PLACE, verified: true, category: 'bar', verification_requested_at: null });
  const r = await review(OTHER_PLACE, 1, 'My competitor is awful.');
  assert.strictEqual(r.status, 403, r.text);
  assert.strictEqual(r.body.code, 'VISIT_REQUIRED',
    'the presence gate is the only thing standing between an owner and a competitor\'s rating');
  assertQueriesUnderstood();
});
