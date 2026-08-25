// Run: node --test  (from backend/)
//
// ─────────────────────────────────────────────────────────────────────────────
// GAME-RULE ABUSE — venue reviews and the owner reply (routes/venueDashboard.js)
// ─────────────────────────────────────────────────────────────────────────────
//
// The review system had one careful gate (presence: a signed NFC tap, or a
// flock with two accepted members) and one careful anti-self-dealing rule.
// The anti-self-dealing rule was on PROMOTION VIEW COUNTS: the UPDATE carries
// `venue_user_id <> $2` and a long comment explaining that an owner must not
// move a number the product charges them to read. Nothing of the kind existed
// on the star rating, which is the number consumers actually choose venues by.
//
// Four findings were pinned here as REPRODUCIBLE. All four are now closed, and
// each test says what the hole was and what the rule is:
//
//   I. THE OWNER COULD REVIEW THEIR OWN VENUE. POST /submit-review never
//      compared req.user.id to venue_profiles.user_id for the place id being
//      rated, so a verified owner posted themselves five stars and it landed
//      in both aggregates as an ordinary customer review with their own name
//      and photo. FIXED on the write path (403 OWNER_CANNOT_REVIEW) AND on the
//      read path, because a write gate alone cannot see the other ordering:
//      review the bar as a customer first, claim it afterwards.
//
//   J. THE SAME ACCOUNT COULD BE BOTH VOICES: a five-star customer review AND
//      the verified business reply, on the same venue, on the same page, with
//      nothing linking them. FIXED by the same guard. venue_reviews still has
//      no author column on the reply, and it does not need one now that one
//      account cannot hold both roles.
//
//   K. A REVIEW IS ITS OWN PERPETUAL PRESENCE PROOF, and that STAYS. The third
//      EXISTS in the presence check is "you already have a review row here",
//      so presence is bought once per (account, venue) and never expires. It is
//      what lets somebody fix a typo in their own words two months later. What
//      it used to ALSO buy was a fresh position on the page, and that is gone:
//      an edit no longer re-dates the review.
//
//   L. SUPPRESSION WITHOUT MODERATION. The public list is
//      `ORDER BY created_at DESC LIMIT n` and the upsert set
//      `created_at = NOW()` on every edit, so five puppet accounts resubmitting
//      reviews they already had pushed a genuine complaint off the visible page
//      with no takedown, no reply and not one new row. FIXED: created_at now
//      means when this person reviewed this venue.
//
//   L2. THE VANISHING OWNER REPLY. An edit deleted the reply outright, which
//      handed the reviewer a repeatable way to strip a business's answer and
//      told the owner nothing. FIXED as RETIREMENT rather than deletion: the
//      text survives, it stops being published, and the owner's tab says so.
//
//   M. THE NFC TAP IS A PERMANENT TRANSFERABLE CREDENTIAL, and this route is
//      now one of the things it buys. The signature is a static HMAC over the
//      place id, so one tap URL photographed off a tag is proof of presence at
//      that venue for anybody holding it, forever. That was priced when a tap
//      only bought a crowd report. submit-review now mounts requireVerified,
//      which does not make the credential untransferable (that is a change to
//      how routes/checkin.js signs a tap, and it belongs with the NFC hardware
//      work) but does put a confirmed email address behind every account that
//      spends one. The flock branch already implied a verified account, so this
//      costs an honest reviewer nothing.
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
function claimsThisPlace(userId, placeId) {
  return world.profiles.some((p) => p.user_id === userId && p.google_place_id === placeId);
}
// The visibility rules, executed from the statement that was actually sent
// rather than assumed. `NOT_OWNER_OF_THE_PLACE` is the shared fragment the
// route interpolates into all four review reads; if it is dropped from one of
// them, that read starts counting owner reviews again and the tests below say
// which read it was.
function visibleReviews(placeId, sql) {
  const excludesOwners = /NOT EXISTS \( SELECT 1 FROM venue_profiles vpo WHERE vpo\.user_id = vr\.user_id AND vpo\.google_place_id = vr\.google_place_id \)/.test(sql);
  return world.reviews
    .filter((r) => r.google_place_id === placeId && !r.is_hidden && world.users.has(r.user_id))
    .filter((r) => !excludesOwners || !claimsThisPlace(r.user_id, r.google_place_id))
    .sort((a, b) => (b.created_at - a.created_at) || (b.id - a.id));
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
// The other half of the same statement: does this account hold a claim on the
// place it is rating. Answered only if the statement asks.
function presenceOwnsVenue(userId, placeId, sql) {
  const asks = /EXISTS \( SELECT 1 FROM venue_profiles WHERE user_id = \$1 AND google_place_id = \$2 \) AS owns_venue/.test(sql);
  return asks && claimsThisPlace(userId, placeId);
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

  // submit-review presence + ownership check (one statement, two columns)
  if (/AS visited/.test(flat)) {
    return {
      rows: [{
        visited: presenceVisited(Number(p[0]), p[1], flat),
        owns_venue: presenceOwnsVenue(Number(p[0]), p[1], flat),
      }],
      rowCount: 1,
    };
  }

  // submit-review upsert
  if (/^INSERT INTO venue_reviews/.test(flat)) {
    const [placeId, userId, rating, text] = [p[0], Number(p[1]), Number(p[2]), p[3]];
    const existing = world.reviews.find((r) => r.google_place_id === placeId && r.user_id === userId);
    // Three behaviours the DO UPDATE list may or may not carry. All three are
    // modelled, so a revert shows up as a failing abuse test rather than as a
    // query the fake does not recognise.
    const redatesOnEdit = /created_at = NOW\(\)/.test(flat);
    const deletesReply = /venue_reply = CASE WHEN EXCLUDED\.rating IS DISTINCT FROM/.test(flat);
    const retiresReply = /venue_replied_at = CASE WHEN EXCLUDED\.rating IS DISTINCT FROM/.test(flat);
    if (existing) {
      const changed = existing.rating !== rating || (existing.text ?? null) !== (text ?? null);
      existing.rating = rating;
      existing.text = text ?? null;
      if (redatesOnEdit) existing.created_at = world.clock;
      if (changed && deletesReply) existing.venue_reply = null;
      if (changed && retiresReply) existing.venue_replied_at = null;
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
    const rows = visibleReviews(p[0], flat);
    return {
      rows: [{ total: rows.length, average: rows.length ? rows.reduce((a, r) => a + r.rating, 0) / rows.length : null }],
      rowCount: 1,
    };
  }
  // public-reviews list
  if (/^SELECT vr\.id, vr\.rating, vr\.text,/.test(flat)) {
    const limit = Number(p[2]);
    const gated = /vp\.verified = true/.test(flat);
    // A reply is published only while it is live. The route retires one whose
    // review was rewritten under it by clearing venue_replied_at.
    const liveReplyOnly = /CASE WHEN vr\.venue_replied_at IS NOT NULL AND EXISTS/.test(flat);
    const rows = visibleReviews(p[0], flat).slice(0, limit).map((r) => {
      const shown = (!gated || hasVerifiedProfile(r.google_place_id))
        && (!liveReplyOnly || r.venue_replied_at !== null);
      return {
        id: r.id, rating: r.rating, text: r.text,
        venue_reply: shown ? r.venue_reply : null,
        venue_replied_at: (!gated || hasVerifiedProfile(r.google_place_id)) ? r.venue_replied_at : null,
        created_at: new Date(r.created_at).toISOString(),
        name: world.users.get(r.user_id)?.name || null,
        profile_image_url: null,
      };
    });
    return { rows, rowCount: rows.length };
  }
  // owner dashboard stats
  if (/COUNT\(\*\) FILTER \(WHERE vr\.rating = 1\)/.test(flat)) {
    const rows = visibleReviews(p[0], flat);
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
  if (/^SELECT vr\.\*, u\.name, u\.profile_image_url/.test(flat)) {
    const flags = /\(vr\.venue_reply IS NOT NULL AND vr\.venue_replied_at IS NULL\) AS reply_needs_review/.test(flat);
    const rows = visibleReviews(p[0], flat).slice(0, Number(p[1])).map((r) => ({
      ...r,
      created_at: new Date(r.created_at).toISOString(),
      name: world.users.get(r.user_id)?.name || null,
      ...(flags ? { reply_needs_review: r.venue_reply !== null && r.venue_replied_at === null } : {}),
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

// A review row that already exists, written straight into the world rather than
// through the route. This is how a row that PREDATES the owner's claim gets
// into the table, and it is the case a write-time gate can never catch.
function seedReview(placeId, userId, rating, text, { agoDays = 0 } = {}) {
  const row = {
    id: world.nextReviewId++, google_place_id: placeId, user_id: userId, rating,
    text, venue_reply: null, venue_replied_at: null,
    created_at: world.clock - agoDays * 86400e3, is_hidden: false,
  };
  world.reviews.push(row);
  return row;
}

// ═════════════════════════════════════════════════════════════════════════════
// I. THE OWNER REVIEWS THEIR OWN VENUE
// ═════════════════════════════════════════════════════════════════════════════

test('FIXED I: the verified owner of a venue cannot give it five stars', async () => {
  const OWNER = 500;
  const FRIEND = 501;
  as(OWNER, 'Rick the Owner');
  as(FRIEND, 'Friend');
  world.profiles.push({ id: 1, user_id: OWNER, google_place_id: PLACE, verified: true, category: 'bar', verification_requested_at: null });

  // The owner's presence at their own bar is trivially arranged, and it is now
  // beside the point: presence is not what they are missing.
  fabricatedFlock(1, PLACE, [OWNER, FRIEND]);

  as(OWNER, 'Rick the Owner');
  const r = await review(PLACE, 5, 'Best bar in town, honestly.');
  assert.strictEqual(r.status, 403, r.text);
  assert.strictEqual(r.body.code, 'OWNER_CANNOT_REVIEW');
  assert.ok(!r.body.error.includes('—'), 'em dash in user-visible copy');

  // The write path now asks the question it never asked: does this account hold
  // a claim on the place id it is rating.
  const askedOwnership = log.some((q) =>
    /venue_profiles/.test(q.sql) && /AS owns_venue/.test(q.sql));
  assert.strictEqual(askedOwnership, true,
    'submit-review does not read venue_profiles for the place id it is rating');
  // ...and it asks it in the SAME statement as presence, on the same two
  // inputs, so one cannot be evaluated without the other.
  assert.strictEqual(log.filter((q) => /AS visited/.test(q.sql)).length, 1);

  assert.strictEqual(log.some((q) => /^INSERT INTO venue_reviews/.test(q.sql)), false,
    'the rating was written anyway');
  assertQueriesUnderstood();
});

test('FIXED I2: an owner review that predates the claim stops counting, on both surfaces', async () => {
  // The ordering a write gate cannot see: review the bar as a customer, then
  // claim and verify it. The row is already in the table, so the rating has to
  // be defined on the read side as well.
  const OWNER = 510;
  const CUSTOMER = 511;
  as(OWNER, 'Rick'); as(CUSTOMER, 'Real Customer');

  seedReview(PLACE, CUSTOMER, 1, 'Waited an hour, never got served.', { agoDays: 2 });
  seedReview(PLACE, OWNER, 5, 'Wonderful place.', { agoDays: 1 });

  // Before the claim exists, the owner's row is an ordinary customer review and
  // counts: 1 and 5 average 3.
  as(999, 'Reader');
  let pub = await call('GET', `/api/venue-dashboard/public-reviews/${PLACE}`);
  assert.strictEqual(pub.body.average, 3);
  assert.strictEqual(pub.body.total, 2);

  // The claim lands. The same row is now the business rating itself.
  world.profiles.push({ id: 1, user_id: OWNER, google_place_id: PLACE, verified: true, category: 'bar', verification_requested_at: null });

  as(999, 'Reader');
  pub = await call('GET', `/api/venue-dashboard/public-reviews/${PLACE}`);
  assert.strictEqual(pub.body.average, 1, 'the owner\'s own five stars still moved the public rating');
  assert.strictEqual(pub.body.total, 1);
  assert.deepStrictEqual(pub.body.reviews.map((x) => x.name), ['Real Customer']);

  // The owner's own tab shows the same number, list and aggregate together.
  as(OWNER, 'Rick');
  const dash = await call('GET', '/api/venue-dashboard/reviews');
  assert.strictEqual(dash.body.stats.average, 1);
  assert.strictEqual(dash.body.stats.total, 1);
  assert.deepStrictEqual(dash.body.stats.distribution, [1, 0, 0, 0, 0]);
  assert.deepStrictEqual(dash.body.reviews.map((x) => x.user_id), [CUSTOMER]);
  assertQueriesUnderstood();
});

test('FIXED I3: an UNVERIFIED claim is still a claim, and cannot review the place either', async () => {
  const SQUATTER = 515;
  const FRIEND = 516;
  as(SQUATTER, 'Squatter'); as(FRIEND, 'Friend');
  world.profiles.push({ id: 1, user_id: SQUATTER, google_place_id: PLACE, verified: false, category: null, verification_requested_at: null });
  fabricatedFlock(1, PLACE, [SQUATTER, FRIEND]);

  as(SQUATTER, 'Squatter');
  const r = await review(PLACE, 5, 'Great place, no notes.');
  assert.strictEqual(r.status, 403, r.text);
  assert.strictEqual(r.body.code, 'OWNER_CANNOT_REVIEW',
    'an unverified claim is this account saying it IS the business');
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// J. BOTH VOICES AT ONCE
// ═════════════════════════════════════════════════════════════════════════════

test('FIXED J: one account can be the business voice OR a customer, never both', async () => {
  const OWNER = 520;
  const CUSTOMER = 521;
  const FRIEND = 522;
  as(OWNER, 'Rick'); as(CUSTOMER, 'Real Customer'); as(FRIEND, 'Friend');
  world.profiles.push({ id: 1, user_id: OWNER, google_place_id: PLACE, verified: true, category: 'bar', verification_requested_at: null });
  fabricatedFlock(1, PLACE, [OWNER, FRIEND]);
  fabricatedFlock(2, PLACE, [CUSTOMER, FRIEND]);

  as(CUSTOMER, 'Real Customer');
  const bad = await review(PLACE, 1, 'Rude staff.');

  // The business voice still works, and it is the only voice this account has.
  as(OWNER, 'Rick');
  assert.strictEqual((await review(PLACE, 5, 'Lovely spot, great staff.')).status, 403);
  const replied = await call('POST', `/api/venue-dashboard/reviews/${bad.body.id}/reply`, {
    reply: 'We are sorry to hear this and would love to make it right.',
  });
  assert.strictEqual(replied.status, 200, replied.text);

  as(999, 'Reader');
  const pub = await call('GET', `/api/venue-dashboard/public-reviews/${PLACE}`);
  assert.strictEqual(pub.body.reviews.length, 1, 'the owner appears as a reviewer');
  assert.strictEqual(pub.body.reviews[0].name, 'Real Customer');
  assert.ok(pub.body.reviews[0].venue_reply, 'the business can still answer a review');
  assert.strictEqual(pub.body.average, 1, 'the complaint is the whole rating, because it is');
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// K. PRESENCE IS STILL PERPETUAL, AND NOW IT BUYS ONLY WHAT IT SHOULD
// ═════════════════════════════════════════════════════════════════════════════

test('FIXED K: an old review can still be edited, and editing it moves nothing', async () => {
  const A = 530;
  const B = 531;
  as(A, 'Mallory'); as(B, 'Puppet');

  // One fabricated flock, 29 days old, buys presence for BOTH accounts at once:
  // the >= 2 clause counts the flock's members, not each reviewer's evidence.
  // That is unchanged, and it is the honest limit of a presence rule with no
  // hardware behind it.
  fabricatedFlock(1, PLACE, [A, B], { daysAgo: 29 });
  as(A, 'Mallory');
  const first = await review(PLACE, 1, 'Terrible.');
  assert.strictEqual(first.status, 201, first.text);
  const writtenAt = world.reviews.find((r) => r.id === first.body.id).created_at;
  as(B, 'Puppet');
  assert.strictEqual((await review(PLACE, 1, 'Also terrible.')).status, 201,
    'one flock, two reviewers');

  // The flock ages out of the 30-day window. The existing row is still its own
  // proof, deliberately: locking someone out of correcting their own words two
  // months later would be absurd.
  world.flocks.get(1).event_time = new Date(world.clock - 400 * 86400e3).toISOString();
  world.clock = Date.now() + 60 * 86400e3;

  as(A, 'Mallory');
  const rewrite = await review(PLACE, 1, 'Still terrible, a year on, and I have not been back.');
  assert.strictEqual(rewrite.status, 201, rewrite.text);
  assert.match(rewrite.body.text, /a year on/);
  // THE PART THAT CHANGED: the row keeps the date it was written on, so the
  // perpetual edit right buys the ability to change your own words and nothing
  // else. It no longer buys a position on the page.
  assert.strictEqual(world.reviews.find((r) => r.id === first.body.id).created_at, writtenAt,
    'an edit re-dated the review, which is the suppression tool in finding L');

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

test('FIXED L: resubmitting old reviews cannot push a complaint off the page', async () => {
  const OWNER = 550;
  const VICTIM = 551;
  const FRIEND = 552;
  as(OWNER, 'Rick'); as(VICTIM, 'Unhappy'); as(FRIEND, 'Friend');
  world.profiles.push({ id: 1, user_id: OWNER, google_place_id: PLACE, verified: true, category: 'bar', verification_requested_at: null });

  // Five accounts the owner controls, all given presence by ONE fabricated
  // flock, each holding an old five-star review.
  const puppets = [561, 562, 563, 564, 565];
  for (const id of puppets) as(id, `Fan${id}`);

  // Ninety days ago: one fabricated flock, five reviews, all dated then.
  world.clock = Date.now() - 90 * 86400e3;
  fabricatedFlock(1, PLACE, puppets);
  for (const id of puppets) { as(id, `Fan${id}`); await review(PLACE, 5, 'Great!'); }

  // The bad review arrives today and is at the top of the page.
  world.clock = Date.now();
  fabricatedFlock(2, PLACE, [VICTIM, FRIEND]);
  as(VICTIM, 'Unhappy');
  const bad = await review(PLACE, 1, 'Bouncer was aggressive.');

  as(999, 'Reader');
  let page = await call('GET', '/api/venue-dashboard/public-reviews/' + PLACE + '?limit=3');
  assert.strictEqual(page.body.reviews[0].id, bad.body.id, 'newest first');

  // Each puppet re-posts, and this time also EDITS, which is the stronger
  // version of the attack: a changed review is a real write, not a no-op.
  world.clock = Date.now() + 1000;
  for (const id of puppets) { as(id, `Fan${id}`); await review(PLACE, 5, `Great! ${id}`); }

  as(999, 'Reader');
  page = await call('GET', '/api/venue-dashboard/public-reviews/' + PLACE + '?limit=3');
  assert.strictEqual(page.body.reviews[0].id, bad.body.id,
    'ninety-day-old reviews jumped a complaint written today');
  assert.strictEqual(page.body.reviews.some((r) => r.id === bad.body.id), true);
  assert.strictEqual(page.body.total, 6, 'the aggregate still counts every visible review');
  assertQueriesUnderstood();
});

test('FIXED L1b: the page is deterministic when two reviews share a timestamp', async () => {
  // A LIMIT over a tie can drop one row and show another twice. Both of these
  // are written at the same instant, which is what a scripted burst produces.
  const A = 566;
  const B = 567;
  as(A, 'One'); as(B, 'Two');
  seedReview(PLACE, A, 4, 'Same second.');
  seedReview(PLACE, B, 2, 'Same second.');

  as(999, 'Reader');
  const first = await call('GET', '/api/venue-dashboard/public-reviews/' + PLACE + '?limit=1');
  const second = await call('GET', '/api/venue-dashboard/public-reviews/' + PLACE + '?limit=1');
  assert.deepStrictEqual(first.body.reviews.map((r) => r.id), second.body.reviews.map((r) => r.id),
    'the same request returned a different page');
  assertQueriesUnderstood();
});

test('FIXED L2: a reviewer editing their review RETIRES the owner\'s reply instead of deleting it', async () => {
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

  // A resubmit of identical content is what a double-tapped Submit button
  // sends, and it must not disturb anything.
  as(REVIEWER, 'Reviewer');
  await review(PLACE, 5, 'Lovely.');
  as(999, 'Reader');
  let pub = await call('GET', `/api/venue-dashboard/public-reviews/${PLACE}`);
  assert.strictEqual(pub.body.reviews[0].venue_reply, 'Thanks for coming!',
    'an identical resubmit threw away the reply');

  // A REAL edit. The reply stops being published, because it answers words that
  // no longer exist, and misleading the reader is the harm that outranks
  // annoying the owner.
  as(REVIEWER, 'Reviewer');
  const edited = await review(PLACE, 1, 'Actually the worst night of my life.');
  assert.strictEqual(edited.body.venue_reply, null,
    'the write endpoint handed the reviewer back an unpublished business reply');
  as(999, 'Reader');
  pub = await call('GET', `/api/venue-dashboard/public-reviews/${PLACE}`);
  assert.strictEqual(pub.body.reviews[0].venue_reply, null,
    'a reply rode words its author never read');

  // But it is NOT destroyed. The owner still has their words, and their tab
  // says the review changed under them, which is the notice that was missing.
  assert.strictEqual(world.reviews.find((x) => x.id === r.body.id).venue_reply, 'Thanks for coming!',
    'a reviewer deleted a business\'s reply by editing a typo');
  as(OWNER, 'Rick');
  const dash = await call('GET', '/api/venue-dashboard/reviews');
  assert.strictEqual(dash.body.reviews[0].venue_reply, 'Thanks for coming!');
  assert.strictEqual(dash.body.reviews[0].reply_needs_review, true,
    'the owner is not told that their reply was pulled');

  // Replying again publishes the new answer.
  const again = await call('POST', `/api/venue-dashboard/reviews/${r.body.id}/reply`, {
    reply: 'This is not the review we answered before. We would still like to talk.',
  });
  assert.strictEqual(again.status, 200, again.text);
  as(999, 'Reader');
  pub = await call('GET', `/api/venue-dashboard/public-reviews/${PLACE}`);
  assert.match(pub.body.reviews[0].venue_reply, /still like to talk/);
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// M. WHAT A LEAKED TAP BUYS
// ═════════════════════════════════════════════════════════════════════════════

test('FIXED M: an unverified account cannot review, so a leaked tap is not unlimited five stars', async () => {
  const U = 630;
  as(U, 'Throwaway');
  // A perfectly valid signed tap, on an account whose email address nobody has
  // confirmed. Before requireVerified this was a 201, and the tap URL that
  // produced it works for the next throwaway account too, and the one after.
  world.checkins.push({ user_id: U, venue_place_id: PLACE, checkin_source: 'nfc', ageDays: 0 });
  CURRENT_USER = { id: U, name: 'Throwaway', email_verified: false, role: 'user' };
  const r = await review(PLACE, 5, 'Five stars from an address nobody confirmed.');
  assert.strictEqual(r.status, 403, r.text);
  assert.strictEqual(r.body.emailVerificationRequired, true);
  assert.deepStrictEqual(log, [], 'an unverified account reached the database');

  // The same account, once it confirms its address, reviews normally. This is a
  // cost on the account, not a wall in front of the reviewer.
  CURRENT_USER = { id: U, name: 'Throwaway', email_verified: true, role: 'user' };
  assert.strictEqual((await review(PLACE, 5, 'Five stars, address confirmed.')).status, 201);
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
    'the presence gate is what stands between an owner and a competitor\'s rating; owning a different venue is not itself a claim on this one');
  assertQueriesUnderstood();
});

test('HELD: an honest reviewer with no claim anywhere is not affected by any of this', async () => {
  // The whole point of the constraint on this change: the fix aims at
  // self-dealing and at the ordering, never at the reviewer.
  const U = 620;
  const FRIEND = 621;
  as(U, 'Honest'); as(FRIEND, 'Friend');
  fabricatedFlock(1, PLACE, [U, FRIEND]);
  as(U, 'Honest');
  const first = await review(PLACE, 2, 'Loud, slow service, fine drinks.');
  assert.strictEqual(first.status, 201, first.text);
  // ...including editing it afterwards, twice, months later.
  world.clock = Date.now() + 120 * 86400e3;
  assert.strictEqual((await review(PLACE, 3, 'Loud, slow service, good drinks.')).status, 201);
  assert.strictEqual((await review(PLACE, 3, 'Loud, slow service, good drinks. Been back since.')).status, 201);
  as(999, 'Reader');
  const pub = await call('GET', `/api/venue-dashboard/public-reviews/${PLACE}`);
  assert.strictEqual(pub.body.total, 1);
  assert.strictEqual(pub.body.average, 3);
  assert.match(pub.body.reviews[0].text, /Been back since/);
  assertQueriesUnderstood();
});
