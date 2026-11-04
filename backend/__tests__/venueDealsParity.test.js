// Run: node --test  (from backend/)
//
// ONE DEALS READ FOR THE VENUE PAGE, A FLOCK'S VOTE AND BIRDIE, ON A REAL
// DATABASE (utils/venueDeals.js, 2026-11-03).
//
// The venue page (GET /api/venue-dashboard/public-promotions/:placeId) is the
// reference: whatever it shows a person is what a vote option and a Birdie card
// may show them, and nothing else. This suite seeds every case the page's
// rules decide (a verified owner's deals newest first with a tie written in one
// go, a Custom time slot and days, a drink deal by its title and by its Custom
// time slot, a takedown, a deal its owner retired or deleted, an unverified
// claimant, a banned owner, a deal written on another place, an owner who lost
// the badge) and then, for four viewers (21 and over, 20, 16, no date of
// birth), checks three answers against each other on an embedded Postgres with
// every migration applied:
//
//   1. the venue page itself, through the real router;
//   2. the batch read for many venues at once, for one viewer and for all four;
//   3. a flock's vote, through the real vote routes: GET /votes for each member,
//      and the new_vote each member is sent when somebody votes. Each option's
//      deal is the first deal that member's venue page shows, or none.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');
const { removeTempDir } = require('./helpers/removeTempDir');

const PG_PORT = pickEmbeddedPgPort('venueDealsParity');
const DB_NAME = 'flock_venue_deals_parity_test';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-venue-deals-parity';
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.RESEND_API_KEY;
delete process.env.VENUE_BILLING_ENABLED;

let pg;
let pool;
let dataDir;
let server;
let base;
let signUserToken;
let venueDeals;
let seq = 0;

// Every room an event was addressed to, with its payload (the vote fan-out).
const sent = [];
const fakeIo = { to: (room) => ({ emit: (event, payload) => sent.push({ room, event, payload }) }) };

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-venue-deals-parity-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'venueDealsParity', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);
  ({ signUserToken } = require('../middleware/auth'));
  venueDeals = require('../utils/venueDeals');
  const app = express();
  app.use(express.json());
  app.set('io', fakeIo);
  app.use('/api/venue-dashboard', require('../routes/venueDashboard'));
  app.use('/api/flocks', require('../routes/venues'));
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  await seed();
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  removeTempDir(dataDir, 'venueDealsParity');
});

// Ages on the real clock, because the routes read them on it.
const YEAR = new Date().getUTCFullYear();
const AGE_30 = `${YEAR - 30}-01-01`;
const AGE_20 = `${YEAR - 20}-12-31`; // 19 or 20 depending on the day, never 21
const AGE_16 = `${YEAR - 16}-06-15`;

async function user(name, { role = 'user', dob = null } = {}) {
  seq += 1;
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password, name, email_verified, role, date_of_birth) VALUES ($1, 'x', $2, true, $3, $4) RETURNING *`,
    [`deals${seq}.${Date.now()}@example.com`, name, role, dob]
  );
  return { ...u, token: signUserToken(u) };
}

async function owner(name, place, { verified = true } = {}) {
  const o = await user(name, { role: 'venue_owner' });
  await pool.query(
    'INSERT INTO venue_profiles (user_id, business_name, google_place_id, verified) VALUES ($1, $2, $3, $4)',
    [o.id, name, place, verified]
  );
  return o;
}

// Written straight into the table, so a test controls the order of creation
// and the flags no editor sets.
async function deal(author, place, title, { slot = null, days = null, minutesAgo = 0, hidden = false, active = true, retired = false } = {}) {
  const { rows: [d] } = await pool.query(
    `INSERT INTO venue_promotions (venue_user_id, google_place_id, title, time_slot, days, is_hidden, active, owner_deleted_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN NOW() END, NOW() - make_interval(mins => $9::int)) RETURNING id`,
    [author.id, place, title, slot, days, hidden, active, retired, minutesAgo]
  );
  return d.id;
}

async function call(method, url, who, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty body */ }
  return { status: res.status, body: json };
}

const PLACE = {
  taqueria: 'ChIJdealsTaqueria0001',
  banned: 'ChIJdealsBannedBar0002',
  brunch: 'ChIJdealsBrunchSpot0003',
  quiet: 'ChIJdealsQuietCafe0004',
  handover: 'ChIJdealsHandover0005',
  elsewhere: 'ChIJdealsElsewhere0006',
};
const ALL_PLACES = Object.values(PLACE);
let viewers;  // { adult, twenty, minor, noDob }
let ids;      // deal ids by name

async function seed() {
  viewers = {
    adult: await user('Ada', { dob: AGE_30 }),
    twenty: await user('Tess', { dob: AGE_20 }),
    minor: await user('Milo', { dob: AGE_16 }),
    noDob: await user('Nico'),
  };
  ids = {};

  const taq = await owner('Taqueria Owner', PLACE.taqueria);
  // Two written in one go share a created_at; the id breaks the tie.
  const twinAt = 600;
  ids.twinA = await deal(taq, PLACE.taqueria, 'Taco Tuesday', { slot: 'All Day', days: 'Tuesday', minutesAgo: twinAt });
  ids.twinB = await deal(taq, PLACE.taqueria, 'Kids eat free', { slot: 'All Day', days: 'Sunday', minutesAgo: twinAt });
  await pool.query('UPDATE venue_promotions SET created_at = (SELECT created_at FROM venue_promotions WHERE id = $1) WHERE id = $2', [ids.twinA, ids.twinB]);
  ids.wings = await deal(taq, PLACE.taqueria, 'Half-price wings', { slot: 'All Day', days: 'Daily', minutesAgo: 300 });
  ids.drafts = await deal(taq, PLACE.taqueria, '$5 drafts', { slot: 'Late Night', days: 'Fri-Sun', minutesAgo: 240 });
  // The Custom choice: the owner's own words in both boxes.
  ids.churros = await deal(taq, PLACE.taqueria, 'Free churros with any entree', { slot: '5 to 7pm', days: 'Tuesday to Thursday', minutesAgo: 180 });
  // A food deal made a drink deal by the owner's own time slot.
  ids.basket = await deal(taq, PLACE.taqueria, 'Wings basket', { slot: '5 to 7, happy hour', days: 'Daily', minutesAgo: 120 });
  ids.takenDown = await deal(taq, PLACE.taqueria, 'Taken down', { minutesAgo: 60, hidden: true });
  // Deleted by the owner while a report was open: kept as evidence, off every card.
  ids.retired = await deal(taq, PLACE.taqueria, 'Retired', { minutesAgo: 30, active: false, retired: true });
  const claimant = await owner('Claimant', PLACE.taqueria, { verified: false });
  ids.claimant = await deal(claimant, PLACE.taqueria, 'Claimant special', { minutesAgo: 10 });

  const banned = await owner('Banned Owner', PLACE.banned);
  ids.banned = await deal(banned, PLACE.banned, 'Banned deal');
  await pool.query('UPDATE users SET is_banned = true WHERE id = $1', [banned.id]);

  const brunch = await owner('Brunch Owner', PLACE.brunch);
  ids.mimosas = await deal(brunch, PLACE.brunch, 'Bottomless mimosas', { slot: 'Weekend Brunch', days: 'Weekends' });

  await owner('Quiet Owner', PLACE.quiet);

  // The badge moved: the earlier owner's deal does not ride the new claim.
  const before = await owner('Earlier Owner', PLACE.handover, { verified: false });
  ids.earlier = await deal(before, PLACE.handover, 'Earlier owner deal', { minutesAgo: 5 });
  const after = await owner('Current Owner', PLACE.handover);
  ids.current = await deal(after, PLACE.handover, 'Current owner deal', { minutesAgo: 50 });

  // Written by a verified owner, on a place that is not theirs.
  ids.elsewhere = await deal(after, PLACE.elsewhere, 'Not my place');
}

async function page(who, place) {
  const r = await call('GET', `/api/venue-dashboard/public-promotions/${place}`, who);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.body.promotions;
}
const idsOf = (list) => (list || []).map((d) => d.id);

test('the venue page serves what its rules say, for each viewer', async () => {
  const forAdult = await page(viewers.adult, PLACE.taqueria);
  assert.deepStrictEqual(idsOf(forAdult), [ids.basket, ids.churros, ids.drafts, ids.wings, ids.twinB, ids.twinA]);
  for (const v of ['twenty', 'minor', 'noDob']) {
    assert.deepStrictEqual(idsOf(await page(viewers[v], PLACE.taqueria)), [ids.churros, ids.wings, ids.twinB, ids.twinA], v);
    assert.deepStrictEqual(await page(viewers[v], PLACE.brunch), [], v);
  }
  assert.deepStrictEqual(idsOf(await page(viewers.adult, PLACE.brunch)), [ids.mimosas]);
  assert.deepStrictEqual(idsOf(await page(viewers.adult, PLACE.handover)), [ids.current]);
  for (const place of [PLACE.banned, PLACE.quiet, PLACE.elsewhere]) {
    assert.deepStrictEqual(await page(viewers.adult, place), [], place);
  }
  // The Custom words come back exactly as the owner typed them.
  const churros = forAdult.find((d) => d.id === ids.churros);
  assert.deepStrictEqual(churros, { id: ids.churros, title: 'Free churros with any entree', description: null, time_slot: '5 to 7pm', days: 'Tuesday to Thursday' });
});

test('PARITY: the batch read answers every viewer exactly what the venue page shows them', async () => {
  const { activeDealsForVenues, activeDealsForViewers } = venueDeals;
  const viewerIds = Object.values(viewers).map((v) => v.id);
  const allAtOnce = await activeDealsForViewers(ALL_PLACES, viewerIds);
  for (const [name, v] of Object.entries(viewers)) {
    const oneViewer = await activeDealsForVenues(ALL_PLACES, { userId: v.id });
    for (const place of ALL_PLACES) {
      const shown = await page(v, place);
      assert.deepStrictEqual(oneViewer.get(place) || [], shown, `${name} at ${place}: one viewer`);
      assert.deepStrictEqual(allAtOnce(v.id).get(place) || [], shown, `${name} at ${place}: every viewer at once`);
    }
  }
});

test('the batch is one deals statement for every place and one birthday read for every viewer', async () => {
  const seen = [];
  const counting = { query: (sql, params) => { seen.push(String(sql).replace(/\s+/g, ' ').trim()); return pool.query(sql, params); } };
  await venueDeals.activeDealsForViewers(ALL_PLACES, Object.values(viewers).map((v) => v.id), { db: counting });
  assert.strictEqual(seen.length, 2, seen.join('\n'));
  assert.match(seen[0], /FROM venue_promotions p .* WHERE p\.google_place_id = ANY\(\$1::text\[\]\)/);
  assert.match(seen[1], /^SELECT id, date_of_birth FROM users WHERE id = ANY\(\$1::int\[\]\)$/);
});

// ---------------------------------------------------------------------------
// The vote
// ---------------------------------------------------------------------------

let flockId;
async function voteFixture() {
  if (flockId) return flockId;
  const { rows: [f] } = await pool.query(
    `INSERT INTO flocks (name, creator_id, status, event_time)
     VALUES ('Friday', $1, 'planning', (NOW() AT TIME ZONE 'UTC') + INTERVAL '2 days') RETURNING id`,
    [viewers.adult.id]
  );
  flockId = f.id;
  for (const v of Object.values(viewers)) {
    await pool.query("INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, 'accepted')", [flockId, v.id]);
  }
  const vote = (v, name, place) => pool.query(
    'INSERT INTO venue_votes (flock_id, user_id, venue_name, venue_id) VALUES ($1, $2, $3, $4)', [flockId, v.id, name, place]
  );
  await vote(viewers.adult, 'Taqueria', PLACE.taqueria);
  await vote(viewers.minor, 'Brunch Spot', PLACE.brunch);
  await vote(viewers.noDob, 'Quiet Cafe', PLACE.quiet);
  await vote(viewers.twenty, 'Somewhere typed', null);
  return flockId;
}

// What a member's venue page leads with at a place: the deal a vote option
// may carry for them, as its title and when it runs, or null.
async function pageLead(who, place) {
  const [first] = await page(who, place);
  return first ? { title: first.title, time_slot: first.time_slot, days: first.days } : null;
}

async function assertOptionsMatchPages(who, options, label) {
  for (const o of options) {
    const expected = o.venue_id ? await pageLead(who, o.venue_id) : null;
    if (expected) assert.deepStrictEqual(o.deal, expected, `${label}: ${o.venue_name}`);
    else assert.ok(!('deal' in o), `${label}: ${o.venue_name} carries a deal its page does not show`);
  }
}

test('GET /votes: each member sees on each option the deal their own venue page leads with', async () => {
  const id = await voteFixture();
  const viewsBefore = (await pool.query('SELECT SUM(views)::int AS n FROM venue_promotions')).rows[0].n;
  for (const [name, v] of Object.entries(viewers)) {
    const r = await call('GET', `/api/flocks/${id}/votes`, v);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    await assertOptionsMatchPages(v, r.body.votes, name);
  }
  const byName = async (who) => Object.fromEntries((await call('GET', `/api/flocks/${id}/votes`, who)).body.votes.map((o) => [o.venue_name, o]));
  const adult = await byName(viewers.adult);
  assert.deepStrictEqual(adult.Taqueria.deal, { title: 'Wings basket', time_slot: '5 to 7, happy hour', days: 'Daily' });
  assert.deepStrictEqual(adult['Brunch Spot'].deal, { title: 'Bottomless mimosas', time_slot: 'Weekend Brunch', days: 'Weekends' });
  for (const name of ['twenty', 'minor', 'noDob']) {
    const theirs = await byName(viewers[name]);
    assert.deepStrictEqual(theirs.Taqueria.deal, { title: 'Free churros with any entree', time_slot: '5 to 7pm', days: 'Tuesday to Thursday' }, name);
    assert.ok(!('deal' in theirs['Brunch Spot']), `${name} was shown a drink deal on a vote option`);
  }
  for (const name of Object.keys(viewers)) {
    const theirs = await byName(viewers[name]);
    assert.ok(!('deal' in theirs['Quiet Cafe']), 'a venue with no deal');
    assert.ok(!('deal' in theirs['Somewhere typed']), 'a venue with no place id');
  }
  // A deal on a vote option is not a view of the venue's page. The venue page
  // reads above did count, once per reader and deal, so the total is measured
  // across vote reads alone.
  const viewsMid = (await pool.query('SELECT SUM(views)::int AS n FROM venue_promotions')).rows[0].n;
  assert.ok(viewsMid >= viewsBefore);
  await call('GET', `/api/flocks/${id}/votes`, viewers.minor);
  const viewsAfter = (await pool.query('SELECT SUM(views)::int AS n FROM venue_promotions')).rows[0].n;
  assert.strictEqual(viewsAfter, viewsMid, 'reading the vote counted a view');
});

test('a vote: the voter\'s answer and every member\'s new_vote carry that member\'s own view of each deal', async () => {
  const id = await voteFixture();
  sent.length = 0;
  const r = await call('POST', `/api/flocks/${id}/vote`, viewers.twenty, { venue_name: 'Taqueria', venue_id: PLACE.taqueria });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  await assertOptionsMatchPages(viewers.twenty, r.body.votes, 'the voter\'s own answer');

  const events = sent.filter((e) => e.event === 'new_vote');
  assert.deepStrictEqual(events.map((e) => e.room).sort(), [viewers.adult, viewers.minor, viewers.noDob].map((v) => `user:${v.id}`).sort());
  for (const e of events) {
    const who = Object.values(viewers).find((v) => `user:${v.id}` === e.room);
    await assertOptionsMatchPages(who, e.payload.votes, `new_vote to ${who.name}`);
  }
  const brunchFor = (v) => events.find((e) => e.room === `user:${v.id}`).payload.votes.find((o) => o.venue_name === 'Brunch Spot');
  assert.deepStrictEqual(brunchFor(viewers.adult).deal, { title: 'Bottomless mimosas', time_slot: 'Weekend Brunch', days: 'Weekends' });
  assert.ok(!('deal' in brunchFor(viewers.minor)), 'the 16-year-old was sent the drink deal');
  assert.ok(!('deal' in brunchFor(viewers.noDob)), 'an account with no date of birth was sent the drink deal');
});

test('a takedown, a delete and a lost badge come off the vote option exactly as they come off the page', async () => {
  const id = await voteFixture();
  const taqueriaFor = async (who) => (await call('GET', `/api/flocks/${id}/votes`, who)).body.votes.find((o) => o.venue_name === 'Taqueria');

  await pool.query('UPDATE venue_promotions SET is_hidden = true WHERE id = $1', [ids.basket]);
  assert.strictEqual((await taqueriaFor(viewers.adult)).deal.title, 'Free churros with any entree');
  await assertOptionsMatchPages(viewers.adult, (await call('GET', `/api/flocks/${id}/votes`, viewers.adult)).body.votes, 'after the takedown');

  // The owner's own delete, through the real route.
  const taqOwner = (await pool.query('SELECT venue_user_id FROM venue_promotions WHERE id = $1', [ids.churros])).rows[0].venue_user_id;
  const ownerRow = (await pool.query('SELECT * FROM users WHERE id = $1', [taqOwner])).rows[0];
  const del = await call('DELETE', `/api/venue-dashboard/promotions/${ids.churros}`, { token: signUserToken(ownerRow) });
  assert.strictEqual(del.status, 200, JSON.stringify(del.body));
  assert.strictEqual((await taqueriaFor(viewers.minor)).deal.title, 'Half-price wings');
  assert.strictEqual((await taqueriaFor(viewers.adult)).deal.title, '$5 drafts');

  await pool.query('UPDATE venue_profiles SET verified = false WHERE user_id = $1', [taqOwner]);
  for (const v of Object.values(viewers)) {
    assert.ok(!('deal' in await taqueriaFor(v)), `${v.name}: an unverified owner's deal on a vote option`);
    assert.deepStrictEqual(await page(v, PLACE.taqueria), []);
  }
});
