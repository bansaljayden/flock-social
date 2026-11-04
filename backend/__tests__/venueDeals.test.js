// Run: node --test  (from backend/)
//
// WHICH OF A VENUE'S DEALS A PERSON SEES (utils/venueDeals.js, 2026-11-03).
//
// One decision, read by the venue page, a flock's vote and Birdie. This file
// walks it with a fake database: which statement goes out for one venue and
// for many, what each viewer gets back by age, the clock the age is read on,
// what a vote option or a Birdie card carries, and that both statements carry
// every rule. venueDealsParity.test.js runs the same thing on a real Postgres
// beside the venue page itself.
const test = require('node:test');
const assert = require('node:assert');

const deals = require('../utils/venueDeals');
const {
  ONE_VENUE_DEALS_SQL, MANY_VENUE_DEALS_SQL, DEALS_PER_VENUE, MAX_BATCH_PLACES,
  activeDealsForVenues, activeDealsForViewers, leadDeal, leadDeals,
} = deals;

const flat = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const DOB_ONE = /^SELECT date_of_birth FROM users WHERE id = \$1$/;
const DOB_MANY = /^SELECT id, date_of_birth FROM users WHERE id = ANY\(\$1::int\[\]\)$/;

// A fake database answering the two deal statements from a list of rows
// (each with its google_place_id, as the batch returns them), and birthdays
// from a map of user id to date of birth.
function fakeDb({ rows = [], dobs = {}, failDob = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      const text = flat(sql);
      calls.push({ sql: text, params });
      if (text === flat(ONE_VENUE_DEALS_SQL)) {
        return { rows: rows.filter((r) => r.google_place_id === params[0]).map(({ google_place_id: _p, ...d }) => d) };
      }
      if (text === flat(MANY_VENUE_DEALS_SQL)) {
        return { rows: rows.filter((r) => params[0].includes(r.google_place_id)) };
      }
      if (DOB_ONE.test(text) || DOB_MANY.test(text)) {
        if (failDob) throw new Error('connection reset');
        const ids = DOB_ONE.test(text) ? [params[0]] : params[0];
        return { rows: ids.filter((id) => id in dobs).map((id) => ({ id, date_of_birth: dobs[id] })) };
      }
      throw new Error(`unscripted query: ${text.slice(0, 120)}`);
    },
  };
}

// Place ids the way Google writes them, long enough for isPlaceIdShaped.
const TAQUERIA = 'ChIJtaqueria000001';
const TAPROOM = 'ChIJtaproom0000002';
const CAFE = 'ChIJcafe00000000003';
const row = (place, id, title, extra = {}) => ({ google_place_id: place, id, title, description: null, time_slot: null, days: null, ...extra });

const WINGS = row(TAQUERIA, 11, 'Half-price wings', { time_slot: 'All Day', days: 'Daily' });
const DESSERT = row(TAQUERIA, 12, 'Free churros with any entree', { time_slot: '5 to 7pm', days: 'Tuesday to Thursday' });
const DRAFTS = row(TAPROOM, 21, '$5 drafts', { time_slot: 'Late Night', days: 'Fri-Sun' });
const NACHOS = row(TAPROOM, 22, 'Nachos for two', { time_slot: 'Happy Hour', days: 'Weekdays' });
const CUSTOM_DRINKS = row(CAFE, 31, 'Wings basket', { time_slot: '5 to 7, happy hour', days: 'Daily' });
const LATTES = row(CAFE, 32, '2-for-1 drinks', { description: 'Any iced latte or cold brew', time_slot: 'Mornings', days: 'Weekdays' });

// Birthdays relative to one fixed clock.
const NOW = new Date('2026-11-03T15:00:00Z');
const ADULT = 1;   // 30
const TWENTY = 2;  // 20
const NO_DOB = 3;
const TURNS_21_TOMORROW = 4;
const DOBS = { [ADULT]: '1996-05-01', [TWENTY]: '2006-01-15', [TURNS_21_TOMORROW]: '2005-11-04' };

const ids = (list) => (list || []).map((d) => d.id);

// ===========================================================================
// The statements
// ===========================================================================

test('one venue is read with the venue page\'s own statement, its place id the only parameter', async () => {
  const db = fakeDb({ rows: [WINGS, DESSERT] });
  const out = await activeDealsForVenues([TAQUERIA], { userId: ADULT }, { db, now: NOW });
  assert.strictEqual(db.calls.length, 1, 'no drink deal, so no birthday read either');
  assert.strictEqual(db.calls[0].sql, flat(ONE_VENUE_DEALS_SQL));
  assert.deepStrictEqual(db.calls[0].params, [TAQUERIA]);
  // The rows as the statement returned them: the five fields the page serves.
  assert.deepStrictEqual(out.get(TAQUERIA), [
    { id: 11, title: 'Half-price wings', description: null, time_slot: 'All Day', days: 'Daily' },
    { id: 12, title: 'Free churros with any entree', description: null, time_slot: '5 to 7pm', days: 'Tuesday to Thursday' },
  ]);
});

test('many venues are ONE statement, grouped back by place in the order it ranked them', async () => {
  const db = fakeDb({ rows: [WINGS, DESSERT, NACHOS, LATTES], dobs: DOBS });
  const out = await activeDealsForVenues([TAQUERIA, TAPROOM, CAFE], { userId: ADULT }, { db, now: NOW });
  // The deals statement, then (Nachos for two runs at Happy Hour, a drink
  // deal) the one birthday read.
  assert.deepStrictEqual(db.calls.map((c) => c.sql), [flat(MANY_VENUE_DEALS_SQL), 'SELECT date_of_birth FROM users WHERE id = $1']);
  assert.deepStrictEqual(db.calls[0].params, [[TAQUERIA, TAPROOM, CAFE]]);
  assert.deepStrictEqual(ids(out.get(TAQUERIA)), [11, 12]);
  assert.deepStrictEqual(ids(out.get(TAPROOM)), [22]);
  assert.deepStrictEqual(ids(out.get(CAFE)), [32]);
  // The grouping column stays in the statement: a deal has the same five
  // fields whichever statement read it.
  for (const list of out.values()) {
    for (const d of list) assert.deepStrictEqual(Object.keys(d).sort(), ['days', 'description', 'id', 'time_slot', 'title']);
  }
});

test('only real place ids are asked about, each once, and nothing is asked for none', async () => {
  const db = fakeDb({ rows: [WINGS] });
  const out = await activeDealsForVenues([null, '', 'abc', 42, TAQUERIA, TAQUERIA, 'has spaces in it', 'x'.repeat(300)], { userId: ADULT }, { db, now: NOW });
  assert.deepStrictEqual(db.calls.map((c) => c.params), [[TAQUERIA]]);
  assert.deepStrictEqual(ids(out.get(TAQUERIA)), [11]);

  const empty = fakeDb();
  assert.strictEqual((await activeDealsForVenues([null, 'abc'], { userId: ADULT }, { db: empty })).size, 0);
  assert.strictEqual((await activeDealsForVenues(undefined, { userId: ADULT }, { db: empty })).size, 0);
  const seen = await activeDealsForViewers([], [ADULT], { db: empty });
  assert.strictEqual(seen(ADULT).size, 0);
  assert.strictEqual(empty.calls.length, 0);
});

test('a batch reads at most MAX_BATCH_PLACES places', async () => {
  const many = Array.from({ length: MAX_BATCH_PLACES + 10 }, (_, i) => `ChIJplace${String(i).padStart(8, '0')}`);
  const db = fakeDb();
  await activeDealsForVenues(many, { userId: ADULT }, { db });
  assert.strictEqual(db.calls[0].params[0].length, MAX_BATCH_PLACES);
});

test('a failed deals read throws, so each caller decides what it costs', async () => {
  const broken = { query: async () => { throw new Error('timeout exceeded'); } };
  await assert.rejects(activeDealsForVenues([TAQUERIA], { userId: ADULT }, { db: broken }), /timeout exceeded/);
  await assert.rejects(activeDealsForViewers([TAQUERIA, CAFE], [ADULT], { db: broken }), /timeout exceeded/);
});

test('both statements carry every rule, and neither reads a plan', () => {
  for (const sql of [ONE_VENUE_DEALS_SQL, MANY_VENUE_DEALS_SQL].map(flat)) {
    assert.match(sql, /JOIN venue_profiles vp ON vp\.user_id = p\.venue_user_id AND vp\.google_place_id = p\.google_place_id AND vp\.verified = true/);
    assert.match(sql, /JOIN users ou ON ou\.id = vp\.user_id AND ou\.is_banned IS NOT TRUE/);
    assert.match(sql, /p\.active = true AND COALESCE\(p\.is_hidden, false\) = false/);
    assert.match(sql, /ORDER BY p\.created_at DESC, p\.id DESC/);
    assert.doesNotMatch(sql, /vp\.tier|venue_subscriptions|venue_roost_notices/);
  }
  assert.match(flat(ONE_VENUE_DEALS_SQL), new RegExp(`WHERE p\\.google_place_id = \\$1 AND .* LIMIT ${DEALS_PER_VENUE}$`));
  assert.match(flat(MANY_VENUE_DEALS_SQL), /WHERE p\.google_place_id = ANY\(\$1::text\[\]\) AND /);
  assert.match(flat(MANY_VENUE_DEALS_SQL), new RegExp(`WHERE d\\.deal_rank <= ${DEALS_PER_VENUE} ORDER BY d\\.google_place_id, d\\.deal_rank$`));
});

// ===========================================================================
// The 21 rule, per viewer
// ===========================================================================

test('a viewer we know is 21 gets every deal; under 21, no date of birth, or an unreadable one gets no drink deal', async () => {
  const all = [WINGS, DRAFTS, NACHOS, CUSTOM_DRINKS, LATTES];
  const places = [TAQUERIA, TAPROOM, CAFE];
  const seenBy = async (userId, opts = {}) => activeDealsForVenues(places, { userId }, { db: fakeDb({ rows: all, dobs: DOBS, ...opts }), now: NOW });

  const adult = await seenBy(ADULT);
  assert.deepStrictEqual(ids(adult.get(TAPROOM)), [21, 22]);
  assert.deepStrictEqual(ids(adult.get(CAFE)), [31, 32]);

  for (const [who, viewer] of [['twenty', TWENTY], ['no date of birth', NO_DOB], ['no account', null]]) {
    const out = await seenBy(viewer);
    assert.deepStrictEqual(ids(out.get(TAQUERIA)), [11], who);
    // "$5 drafts" by its title, "Nachos for two" by its Happy Hour time slot.
    assert.strictEqual(out.has(TAPROOM), false, `${who}: a place with only drink deals left is absent`);
    // The Custom time slot "5 to 7, happy hour" makes a food deal a drink
    // deal; "2-for-1 drinks" whose description names lattes stays a cafe deal.
    assert.deepStrictEqual(ids(out.get(CAFE)), [32], who);
  }
  const unreadable = await seenBy(ADULT, { failDob: true });
  assert.strictEqual(unreadable.has(TAPROOM), false, 'a birthday read that fails is not known to be 21');
});

test('the birthday is read only when a drink deal is among the deals', async () => {
  const db = fakeDb({ rows: [WINGS, DESSERT, LATTES], dobs: DOBS });
  await activeDealsForVenues([TAQUERIA, CAFE], { userId: TWENTY }, { db, now: NOW });
  assert.strictEqual(db.calls.filter((c) => DOB_ONE.test(c.sql) || DOB_MANY.test(c.sql)).length, 0);

  const withDrinks = fakeDb({ rows: [WINGS, DRAFTS], dobs: DOBS });
  await activeDealsForVenues([TAQUERIA, TAPROOM], { userId: TWENTY }, { db: withDrinks, now: NOW });
  const dobReads = withDrinks.calls.filter((c) => DOB_ONE.test(c.sql));
  assert.deepStrictEqual(dobReads.map((c) => c.params), [[TWENTY]], 'one viewer is read with the venue page\'s own birthday statement');
});

test('the age is read on the clock it is handed: 21 on the birthday, not the day before', async () => {
  const rows = [WINGS, DRAFTS];
  const dayBefore = await activeDealsForVenues([TAQUERIA, TAPROOM], { userId: TURNS_21_TOMORROW }, { db: fakeDb({ rows, dobs: DOBS }), now: NOW });
  assert.strictEqual(dayBefore.has(TAPROOM), false);
  const birthday = new Date('2026-11-04T15:00:00Z');
  const onTheDay = await activeDealsForVenues([TAQUERIA, TAPROOM], { userId: TURNS_21_TOMORROW }, { db: fakeDb({ rows, dobs: DOBS }), now: birthday });
  assert.deepStrictEqual(ids(onTheDay.get(TAPROOM)), [21]);

  const viewers = [TURNS_21_TOMORROW, ADULT];
  const before = await activeDealsForViewers([TAQUERIA, TAPROOM], viewers, { db: fakeDb({ rows, dobs: DOBS }), now: NOW });
  assert.strictEqual(before(TURNS_21_TOMORROW).has(TAPROOM), false);
  const after = await activeDealsForViewers([TAQUERIA, TAPROOM], viewers, { db: fakeDb({ rows, dobs: DOBS }), now: birthday });
  assert.deepStrictEqual(ids(after(TURNS_21_TOMORROW).get(TAPROOM)), [21]);
});

test('no clock judges a deal: a Custom time slot and days are served at any hour on any day, as the venue page serves them', async () => {
  // "Free churros with any entree", 5 to 7pm, Tuesday to Thursday. Nothing
  // stores a start or an end, so a Monday morning and a Wednesday at six read
  // the same. Only the age moves with the clock (the test above).
  const mondayMorning = new Date('2026-11-02T13:00:00Z');
  const wednesdayAtSix = new Date('2026-11-04T23:00:00Z');
  for (const now of [mondayMorning, wednesdayAtSix]) {
    const out = await activeDealsForVenues([TAQUERIA], { userId: NO_DOB }, { db: fakeDb({ rows: [DESSERT] }), now });
    assert.deepStrictEqual(ids(out.get(TAQUERIA)), [12]);
  }
});

test('many viewers: one deals statement, one birthday read for all of them, each answered for themselves', async () => {
  const db = fakeDb({ rows: [WINGS, DRAFTS, NACHOS, CUSTOM_DRINKS, LATTES], dobs: DOBS });
  const seen = await activeDealsForViewers([TAQUERIA, TAPROOM, CAFE], [ADULT, TWENTY, NO_DOB, ADULT, 'x'], { db, now: NOW });
  assert.strictEqual(db.calls.length, 2);
  assert.strictEqual(db.calls[0].sql, flat(MANY_VENUE_DEALS_SQL));
  assert.match(db.calls[1].sql, DOB_MANY);
  assert.deepStrictEqual(db.calls[1].params, [[ADULT, TWENTY, NO_DOB]], 'each viewer once, and only ids');

  assert.deepStrictEqual(ids(seen(ADULT).get(TAPROOM)), [21, 22]);
  assert.deepStrictEqual(ids(seen(String(ADULT)).get(TAPROOM)), [21, 22], 'an id that arrives as a string is the same viewer');
  for (const viewer of [TWENTY, NO_DOB, 999]) {
    assert.strictEqual(seen(viewer).has(TAPROOM), false, `viewer ${viewer}`);
    assert.deepStrictEqual(ids(seen(viewer).get(CAFE)), [32], `viewer ${viewer}`);
  }

  // The same answer the one-viewer read gives each of them.
  for (const viewer of [ADULT, TWENTY, NO_DOB]) {
    const one = await activeDealsForVenues([TAQUERIA, TAPROOM, CAFE], { userId: viewer }, { db: fakeDb({ rows: [WINGS, DRAFTS, NACHOS, CUSTOM_DRINKS, LATTES], dobs: DOBS }), now: NOW });
    assert.deepStrictEqual([...seen(viewer)], [...one], `viewer ${viewer}`);
  }

  const noDrinks = fakeDb({ rows: [WINGS, LATTES], dobs: DOBS });
  await activeDealsForViewers([TAQUERIA, CAFE], [ADULT, TWENTY], { db: noDrinks, now: NOW });
  assert.strictEqual(noDrinks.calls.length, 1, 'no drink deal, no birthday read');

  const failing = await activeDealsForViewers([TAQUERIA, TAPROOM], [ADULT], { db: fakeDb({ rows: [WINGS, DRAFTS], dobs: DOBS, failDob: true }), now: NOW });
  assert.strictEqual(failing(ADULT).has(TAPROOM), false, 'a failed birthday read is nobody known to be 21');
});

// ===========================================================================
// The one line a vote option or a Birdie card carries
// ===========================================================================

test('the lead deal is the newest one, as its title and when it runs', () => {
  assert.deepStrictEqual(leadDeal([
    { id: 12, title: ' Free churros with any entree ', description: 'Dine in only', time_slot: '5 to 7pm', days: ' Tuesday to Thursday ' },
    { id: 11, title: 'Half-price wings', description: null, time_slot: 'All Day', days: 'Daily' },
  ]), { title: 'Free churros with any entree', time_slot: '5 to 7pm', days: 'Tuesday to Thursday' });
  assert.deepStrictEqual(leadDeal([{ id: 1, title: 'Wings', time_slot: '', days: null }]), { title: 'Wings', time_slot: null, days: null });
  for (const none of [[], null, undefined, [{ id: 1, title: '   ' }], [{ id: 1 }], [null]]) {
    assert.strictEqual(leadDeal(none), null, JSON.stringify(none));
  }
});

test('leadDeals keeps a place only when it has a deal to lead with', () => {
  const byPlace = new Map([[TAQUERIA, [WINGS, DESSERT]], [CAFE, [{ id: 9, title: '' }]]]);
  assert.deepStrictEqual([...leadDeals(byPlace)], [[TAQUERIA, { title: 'Half-price wings', time_slot: 'All Day', days: 'Daily' }]]);
  assert.strictEqual(leadDeals(null).size, 0);
});
