// Run: node --test  (from backend/)
//
// THE FULLER VENUE REGISTRATION, and the two things it is really for.
//
// 1. THE PLACE ID IS THE JOIN KEY, AND IT WAS OPTIONAL.
//    services/mlPredictor.js getBaseline reads ml_venue_baselines BY
//    google_place_id, and when there is no row for that id the model does not
//    degrade, it refuses (services/crowdEngine.js case 3). So a claimed venue
//    that is outside the corpus can never be shown anything model-backed, at
//    any tier, and NOTHING recorded whether that was the case. The one real
//    venue_profiles row in production is not in ml_venues, which makes that the
//    normal outcome of a claim rather than an unusual one.
//
//    corpus_status / corpus_baseline_rows / corpus_checked_at are that answer,
//    written at claim time and refreshed on a day's TTL (a retrain can move a
//    venue into the corpus without anybody touching the profile row). The tests
//    below pin the three answers, the refresh, and the direction it fails in: a
//    lookup that cannot run leaves the stored answer alone rather than demoting
//    a real corpus venue to 'absent'.
//
// 2. EIGHTEEN NEW COLUMNS ON A ROUTER WITH TWO WRITE PATHS.
//    routes/venueProfile.js already carried the warning in a comment — "Same
//    shape rule as the create route, the two must not drift" — and eighteen
//    fields copied into two validator arrays is eighteen chances to prove it
//    right. They live in validators/venueIntake.js and both routes spread the
//    same array, which is asserted here as source text, because a drift that
//    only shows up on one verb is exactly the shape of bug a behavioural test
//    on the other verb passes straight through.
//
//    The bounds are the venueDashboard.js lesson re-applied: `capacity:
//    3000000000` against an INTEGER column is a 22003 from Postgres, i.e. a 500
//    for a plainly bad request. Every numeric here is bounded on BOTH ends.
//
//    And the three owner-typed strings are screened. A business account is
//    still a user account, and routes/venueDashboard.js already settled how:
//    freeText for the shape and the markup, rejectIfProfane for the words, run
//    on the STRIPPED value so `f<b>u</b>ck` cannot split a word past the filter.
//
// 3. IT IS EDITABLE. category, description and goals were accepted by the PUT
//    from the day it shipped and exposed in Settings by nothing, so they were
//    answerable exactly once. A kitchen close time read off a year-old profile
//    is worse than no kitchen close time, so the settings surface is pinned too.
//
// No database and no renderer: the router runs against a scripted pg fake and
// frontend/src/App.js is read as text. Same two idioms as
// __tests__/eventFieldScreening.test.js.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'venue-intake-test-secret';

const pool = require('../config/database');

// ── Harness ────────────────────────────────────────────────────────────────
let handlers = [];
let log = [];

function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params: params || [] });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = fn(params || [], flat);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}
pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({ query: (sql, params) => dispatch(sql, params), release: () => {} });

// Patched BEFORE the router is required: venueProfile.js calls
// router.use(authenticate) at require time.
const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 7, name: 'Owner', role: 'venue_owner' }; next(); };

const venueProfileRouter = require('../routes/venueProfile');
const intake = require('../validators/venueIntake');
const { hasModelBackedData, corpusSummary, CORPUS_TTL_MS } = require('../services/venueCorpus');

const app = express();
app.use(express.json());
app.use('/api/venue-profile', venueProfileRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => { server.close(() => resolve()); }));

const PLACE = 'ChIJrTLr_TestPlaceId';

// Sensible defaults for every statement the routes make. Registered in
// specificity order, because dispatch takes the FIRST regex that matches and
// both venue_profiles UPDATEs would otherwise answer to the same pattern.
function baseHandlers({ profile = {}, corpus = null } = {}) {
  const row = {
    id: 1, user_id: 7, business_name: 'The Blue Heron', google_place_id: PLACE,
    corpus_status: null, corpus_baseline_rows: null, corpus_checked_at: null,
    ...profile,
  };
  handlers.push([/SELECT 1 FROM venue_profiles WHERE google_place_id/, () => ({ rows: [] })]);
  handlers.push([/UPDATE users SET role/, () => ({ rows: [], rowCount: 1 })]);
  handlers.push([/EXISTS \(SELECT 1 FROM ml_venues/, () => {
    if (corpus === 'error') throw new Error('pg is down');
    return { rows: [corpus || { in_venues: false, baseline_rows: 0 }] };
  }]);
  handlers.push([/INSERT INTO venue_profiles/, () => ({ rows: [row], rowCount: 1 })]);
  handlers.push([/SELECT \* FROM venue_profiles WHERE user_id/, () => ({ rows: [row], rowCount: 1 })]);
  handlers.push([/UPDATE venue_profiles SET business_name/, () => ({ rows: [row], rowCount: 1 })]);
  // The intake + corpus follow-up. Echoes the row so the response is coherent.
  handlers.push([/UPDATE venue_profiles SET /, (params, sql) => {
    lastFollowUp = { sql, params };
    return { rows: [{ ...row }], rowCount: 1 };
  }]);
  return row;
}

let lastFollowUp = null;
test.beforeEach(() => { handlers = []; log = []; lastFollowUp = null; });

async function call(method, path_, body) {
  const res = await fetch(base + path_, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, body: json };
}

// Pull "column -> value" out of the follow-up UPDATE, so an assertion names the
// COLUMN rather than a parameter index that moves whenever a field is added.
function followUpColumns() {
  assert.ok(lastFollowUp, 'the intake/corpus follow-up UPDATE never ran');
  const out = {};
  // The SET list only. `user_id = $N` is the WHERE clause, not a column this
  // statement writes, and counting it would make the "a read writes nothing an
  // owner typed" assertion below unreadable.
  const setList = lastFollowUp.sql.slice(0, lastFollowUp.sql.indexOf(' WHERE '));
  for (const m of setList.matchAll(/(\w+) = \$(\d+)/g)) {
    out[m[1]] = lastFollowUp.params[Number(m[2]) - 1];
  }
  return out;
}

const FULL_INTAKE = {
  capacity: 220,
  serviceStyle: 'seated_table',
  reservationPolicy: 'reservations_accepted',
  largestWalkinGroup: 6,
  typicalDwellMinutes: 90,
  typicalSpendPerPerson: 35,
  hasOutdoorSeating: true,
  kitchenLastOrder: '21:00',
  lastCall: '01:30',
  agePolicy: 'twenty_one_plus',
  ageRestrictedAfter: '22:00',
  eventNights: ['tuesday', 'thursday'],
  eventNote: 'Trivia at 8',
  ownerBusyNights: ['friday', 'saturday'],
  targetNight: 'wednesday',
  anchorTypes: ['stadium_arena', 'transit_hub'],
  anchorNote: 'Across from the arena',
  quirks: 'The patio holds 40 more but we close it below 55 degrees.',
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. Every intake field reaches its own column, on both verbs
// ═══════════════════════════════════════════════════════════════════════════

test('a full intake lands in every column it names, on POST', async () => {
  baseHandlers();
  const res = await call('POST', '/api/venue-profile', { businessName: 'The Blue Heron', googlePlaceId: PLACE, ...FULL_INTAKE });
  assert.strictEqual(res.status, 201, res.text);
  const cols = followUpColumns();
  assert.strictEqual(cols.capacity, 220);
  assert.strictEqual(cols.service_style, 'seated_table');
  assert.strictEqual(cols.reservation_policy, 'reservations_accepted');
  assert.strictEqual(cols.largest_walkin_group, 6);
  assert.strictEqual(cols.typical_dwell_minutes, 90);
  assert.strictEqual(cols.typical_spend_per_person, 35);
  assert.strictEqual(cols.has_outdoor_seating, true);
  assert.strictEqual(cols.kitchen_last_order, '21:00');
  assert.strictEqual(cols.last_call, '01:30');
  assert.strictEqual(cols.age_policy, 'twenty_one_plus');
  assert.strictEqual(cols.age_restricted_after, '22:00');
  assert.deepStrictEqual(cols.event_nights, ['tuesday', 'thursday']);
  assert.strictEqual(cols.event_note, 'Trivia at 8');
  assert.deepStrictEqual(cols.owner_busy_nights, ['friday', 'saturday']);
  assert.strictEqual(cols.target_night, 'wednesday');
  assert.deepStrictEqual(cols.anchor_types, ['stadium_arena', 'transit_hub']);
  assert.strictEqual(cols.anchor_note, 'Across from the arena');
  assert.match(cols.quirks, /^The patio holds 40 more/);
});

// The one that matters most on this router, because the PUT is the surface a
// venue uses for the REST of its life and the POST is the one they use once.
test('the same full intake lands in the same columns on PUT', async () => {
  baseHandlers();
  const res = await call('PUT', '/api/venue-profile', FULL_INTAKE);
  assert.strictEqual(res.status, 200, res.text);
  const cols = followUpColumns();
  assert.strictEqual(cols.capacity, 220);
  assert.strictEqual(cols.kitchen_last_order, '21:00');
  assert.deepStrictEqual(cols.anchor_types, ['stadium_arena', 'transit_hub']);
});

// The comment on the PUT has said "the two must not drift" since long before
// these fields existed. Text, not behaviour: a chain that stops being spread
// into one of the two arrays is invisible to any test that exercises the other.
test('both write paths spread the SAME intake chain', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'venueProfile.js'), 'utf8');
  const spreads = src.match(/\.\.\.intakeRules/g) || [];
  assert.strictEqual(spreads.length, 2,
    `routes/venueProfile.js spreads intakeRules ${spreads.length} times; POST and PUT both need it`);
  const screens = src.match(/if \(screenIntakeText\(req, res\)\) return;/g) || [];
  assert.strictEqual(screens.length, 2, 'both write paths must screen the owner-typed strings');
});

test('an omitted field is left alone, and an empty one is cleared', async () => {
  baseHandlers();
  // capacity present but blank means "I do not want to say" — the only way an
  // owner clears a value they entered by mistake. lastCall is absent entirely.
  await call('PUT', '/api/venue-profile', { capacity: '', serviceStyle: 'mixed' });
  const cols = followUpColumns();
  assert.strictEqual(cols.capacity, null, 'an empty capacity must clear the column');
  assert.strictEqual(cols.service_style, 'mixed');
  assert.ok(!('last_call' in cols), 'a field the request never mentioned was written anyway');
});

test('a weekday set is stored in one canonical order', async () => {
  baseHandlers();
  await call('PUT', '/api/venue-profile', { ownerBusyNights: ['saturday', 'monday', 'friday'] });
  assert.deepStrictEqual(followUpColumns().owner_busy_nights, ['monday', 'friday', 'saturday'],
    'two spellings of the same set must not be two values');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Bounds: a bad number is a 400, never a Postgres exception
// ═══════════════════════════════════════════════════════════════════════════

test('every numeric is bounded on both ends', async () => {
  const cases = [
    // The venueDashboard.js lesson: unbounded isInt() + an INTEGER column = 22003.
    ['capacity', 3000000000], ['capacity', 0], ['capacity', -5], ['capacity', 90.5],
    ['capacity', true], ['capacity', 'lots'],
    ['largestWalkinGroup', 0], ['largestWalkinGroup', 5000],
    ['typicalDwellMinutes', 1], ['typicalDwellMinutes', 10000],
    ['typicalSpendPerPerson', 0], ['typicalSpendPerPerson', 999999],
  ];
  for (const [field, value] of cases) {
    baseHandlers();
    const res = await call('PUT', '/api/venue-profile', { [field]: value });
    assert.strictEqual(res.status, 400, `${field}=${JSON.stringify(value)} -> ${res.status} ${res.text}`);
    handlers = [];
  }
});

test('the values inside the bounds still save', async () => {
  for (const [field, value] of [['capacity', 1], ['capacity', 20000], ['largestWalkinGroup', 200], ['typicalDwellMinutes', 10], ['typicalSpendPerPerson', 1000]]) {
    handlers = []; lastFollowUp = null;
    baseHandlers();
    const res = await call('PUT', '/api/venue-profile', { [field]: value });
    assert.strictEqual(res.status, 200, `${field}=${value} -> ${res.status} ${res.text}`);
  }
});

test('an enum only accepts a value the form can produce', async () => {
  const cases = [
    ['serviceStyle', 'table service'], ['reservationPolicy', 'maybe'],
    ['agePolicy', '21+'], ['targetNight', 'Friday'], ['targetNight', 'someday'],
  ];
  for (const [field, value] of cases) {
    handlers = [];
    baseHandlers();
    const res = await call('PUT', '/api/venue-profile', { [field]: value });
    assert.strictEqual(res.status, 400, `${field}=${JSON.stringify(value)} -> ${res.status} ${res.text}`);
  }
});

test('a time has to be a time', async () => {
  for (const value of ['9pm', '25:00', '21:60', '9:00', '', ' ']) {
    handlers = [];
    baseHandlers();
    const res = await call('PUT', '/api/venue-profile', { kitchenLastOrder: value });
    const expected = value.trim() === '' ? 200 : 400;
    assert.strictEqual(res.status, expected, `kitchenLastOrder=${JSON.stringify(value)} -> ${res.status} ${res.text}`);
  }
});

test('a set refuses anything not on its list, and refuses being over-filled', async () => {
  const cases = [
    { eventNights: ['funday'] },
    { eventNights: 'friday' },
    { eventNights: [{ day: 'friday' }] },
    { ownerBusyNights: ['monday', 'monday', 'monday', 'monday', 'monday', 'monday', 'monday', 'monday'] },
    { anchorTypes: ['volcano'] },
    { anchorTypes: intake.ANCHOR_TYPES.slice(0, intake.MAX_ANCHOR_TYPES + 1) },
  ];
  for (const body of cases) {
    handlers = [];
    baseHandlers();
    const res = await call('PUT', '/api/venue-profile', body);
    assert.strictEqual(res.status, 400, `${JSON.stringify(body)} -> ${res.status} ${res.text}`);
  }
});

// validators/shape.js, applied to eighteen new doors at once. An array coerces
// past isLength and past the profanity screen, and then reaches a scalar column
// as a Postgres array literal — a 500 for what should be a 400.
test('a non-scalar cannot reach a scalar intake column', async () => {
  for (const body of [
    { capacity: [220] }, { serviceStyle: ['mixed'] }, { kitchenLastOrder: ['21:00'] },
    { quirks: ['<b>x</b>'] }, { agePolicy: { v: 'all_ages' } }, { hasOutdoorSeating: ['true'] },
  ]) {
    handlers = [];
    baseHandlers();
    const res = await call('PUT', '/api/venue-profile', body);
    assert.strictEqual(res.status, 400, `${JSON.stringify(body)} -> ${res.status} ${res.text}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The free text is screened, on both verbs
// ═══════════════════════════════════════════════════════════════════════════

const { moderateText } = require('../utils/moderation');
const DIRTY = ['shit', 'fuck', 'bitch'].find((w) => !moderateText(w).allowed);

test('the profanity filter still rejects something, or nothing below means anything', () => {
  assert.ok(DIRTY, 'utils/moderation rejects none of the sample words; the screening tests would pass vacuously');
});

test('every owner-typed intake string is screened, on POST and on PUT', async () => {
  for (const field of intake.INTAKE_TEXT_FIELDS) {
    for (const [method, body] of [
      ['POST', { businessName: 'The Blue Heron', googlePlaceId: PLACE, [field]: `Nice place, ${DIRTY}` }],
      ['PUT', { [field]: `Nice place, ${DIRTY}` }],
    ]) {
      handlers = []; log = [];
      baseHandlers();
      const res = await call(method, '/api/venue-profile', body);
      assert.strictEqual(res.status, 400, `${method} ${field} -> ${res.status} ${res.text}`);
      assert.ok(
        !log.some((q) => /INSERT INTO venue_profiles|UPDATE venue_profiles/i.test(q.sql)),
        `${method} ${field}: refused, but a write ran anyway`
      );
    }
  }
});

// Round 20's rule, inherited: the screen reads the STRIPPED string, so markup
// cannot be used to split a word in half past the filter.
test('markup cannot smuggle a word past the screen', async () => {
  baseHandlers();
  const split = `${DIRTY[0]}<b>${DIRTY.slice(1)}</b>`;
  const res = await call('PUT', '/api/venue-profile', { quirks: `Our ${split} policy` });
  assert.strictEqual(res.status, 400, res.text);
});

test('clean prose is stored with its markup removed, not with its words changed', async () => {
  baseHandlers();
  await call('PUT', '/api/venue-profile', { quirks: 'Parking <b>fills</b> by seven.' });
  assert.strictEqual(followUpColumns().quirks, 'Parking fills by seven.');
});

test('over-long prose is a 400, not a truncated column', async () => {
  for (const [field, max] of [['eventNote', intake.MAX_EVENT_NOTE], ['anchorNote', intake.MAX_ANCHOR_NOTE], ['quirks', intake.MAX_QUIRKS]]) {
    handlers = [];
    baseHandlers();
    const res = await call('PUT', '/api/venue-profile', { [field]: 'a'.repeat(max + 1) });
    assert.strictEqual(res.status, 400, `${field} -> ${res.status} ${res.text}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. A stored contradiction is made unrepresentable
// ═══════════════════════════════════════════════════════════════════════════

test('all ages clears the time the age rule starts', async () => {
  baseHandlers();
  // "Everyone is welcome, after 22:00" is a value an advisor would read out.
  await call('PUT', '/api/venue-profile', { agePolicy: 'all_ages', ageRestrictedAfter: '22:00' });
  const cols = followUpColumns();
  assert.strictEqual(cols.age_policy, 'all_ages');
  assert.strictEqual(cols.age_restricted_after, null);
});

test('a request that never mentions the age policy leaves the stored time alone', async () => {
  baseHandlers();
  await call('PUT', '/api/venue-profile', { capacity: 100 });
  assert.ok(!('age_restricted_after' in followUpColumns()),
    'an unrelated save wiped a field the owner set earlier');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Corpus membership
// ═══════════════════════════════════════════════════════════════════════════

test('a claim records which of the three answers this venue is', async () => {
  const cases = [
    [{ in_venues: true, baseline_rows: 168 }, 'baselines', 168],
    [{ in_venues: true, baseline_rows: 0 }, 'venue_only', 0],
    [{ in_venues: false, baseline_rows: 0 }, 'absent', 0],
  ];
  for (const [corpus, status, rows] of cases) {
    handlers = []; lastFollowUp = null;
    baseHandlers({ corpus });
    const res = await call('POST', '/api/venue-profile', { businessName: 'The Blue Heron', googlePlaceId: PLACE });
    assert.strictEqual(res.status, 201, res.text);
    const cols = followUpColumns();
    assert.strictEqual(cols.corpus_status, status);
    assert.strictEqual(cols.corpus_baseline_rows, rows);
    assert.match(lastFollowUp.sql, /corpus_checked_at = NOW\(\)/);
  }
});

test('the membership question is asked of both ML tables, by place id', async () => {
  baseHandlers({ corpus: { in_venues: true, baseline_rows: 12 } });
  await call('POST', '/api/venue-profile', { businessName: 'The Blue Heron', googlePlaceId: PLACE });
  const q = log.find((r) => /FROM ml_venues/.test(r.sql));
  assert.ok(q, 'the corpus lookup never ran');
  assert.match(q.sql, /ml_venue_baselines/);
  assert.deepStrictEqual(q.params, [PLACE]);
});

// The direction it fails in is the whole point: a transient error must not take
// a real corpus venue's intelligence away for a day.
test('a corpus lookup that cannot run leaves the stored answer alone', async () => {
  baseHandlers({ corpus: 'error', profile: { corpus_status: 'baselines', corpus_baseline_rows: 168, corpus_checked_at: new Date(0).toISOString() } });
  const res = await call('POST', '/api/venue-profile', { businessName: 'The Blue Heron', googlePlaceId: PLACE });
  assert.strictEqual(res.status, 201, res.text);
  if (lastFollowUp) {
    assert.ok(!/corpus_status/.test(lastFollowUp.sql), 'a failed lookup overwrote the stored answer');
  }
});

test('a claim with no place id asks nothing and stores nothing', async () => {
  baseHandlers({ profile: { google_place_id: null } });
  const res = await call('POST', '/api/venue-profile', { businessName: 'The Blue Heron' });
  assert.strictEqual(res.status, 201, res.text);
  assert.ok(!log.some((q) => /FROM ml_venues/.test(q.sql)), 'a paid-nothing lookup ran on an unclaimed place');
});

test('a stored answer inside the TTL is not re-asked on a read', async () => {
  baseHandlers({ profile: { corpus_status: 'absent', corpus_baseline_rows: 0, corpus_checked_at: new Date().toISOString() } });
  const res = await call('GET', '/api/venue-profile');
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(!log.some((q) => /FROM ml_venues/.test(q.sql)), 'a fresh answer was re-queried');
});

// The reason it is a TTL and not a write-once: a retrain moves venues INTO the
// corpus, and an owner stuck on their signup-day answer reads a lie.
test('a stale answer is refreshed on a read', async () => {
  const old = new Date(Date.now() - CORPUS_TTL_MS - 60000).toISOString();
  baseHandlers({ corpus: { in_venues: true, baseline_rows: 168 }, profile: { corpus_status: 'absent', corpus_baseline_rows: 0, corpus_checked_at: old } });
  const res = await call('GET', '/api/venue-profile');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(followUpColumns().corpus_status, 'baselines');
});

test('a read never writes anything an owner typed', async () => {
  const old = new Date(Date.now() - CORPUS_TTL_MS - 60000).toISOString();
  baseHandlers({ corpus: { in_venues: false, baseline_rows: 0 }, profile: { corpus_status: null, corpus_checked_at: old } });
  await call('GET', '/api/venue-profile');
  const cols = Object.keys(followUpColumns());
  assert.deepStrictEqual(cols.sort(), ['corpus_baseline_rows', 'corpus_status'],
    `a GET wrote ${cols.join(', ')}`);
});

// Verification binds to the PLACE, and so does this. Both reset when the id
// changes, for the same reason.
test('repointing the profile at a different place re-asks immediately', async () => {
  const fresh = new Date().toISOString();
  baseHandlers({ corpus: { in_venues: false, baseline_rows: 0 }, profile: { corpus_status: 'baselines', corpus_baseline_rows: 168, corpus_checked_at: fresh, google_place_id: 'ChIJsomethingElse' } });
  const res = await call('PUT', '/api/venue-profile', { googlePlaceId: 'ChIJsomethingElse' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(followUpColumns().corpus_status, 'absent',
    'the corpus answer for the OLD place survived a change of place');
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The read side: unknown is never permission
// ═══════════════════════════════════════════════════════════════════════════

test('only a real baseline curve counts as model-backed', () => {
  assert.strictEqual(hasModelBackedData({ corpus_status: 'baselines', corpus_baseline_rows: 168 }), true);
  assert.strictEqual(hasModelBackedData({ corpus_status: 'baselines', corpus_baseline_rows: 0 }), false);
  assert.strictEqual(hasModelBackedData({ corpus_status: 'venue_only', corpus_baseline_rows: 0 }), false);
  assert.strictEqual(hasModelBackedData({ corpus_status: 'absent', corpus_baseline_rows: 0 }), false);
  assert.strictEqual(hasModelBackedData({ corpus_status: 'unknown' }), false);
  assert.strictEqual(hasModelBackedData({}), false, 'a never-checked profile must not read as permission');
  assert.strictEqual(hasModelBackedData(null), false);
});

test('the profile a client receives carries the answer and the sentence', async () => {
  baseHandlers({ profile: { corpus_status: 'absent', corpus_baseline_rows: 0, corpus_checked_at: new Date().toISOString() } });
  const res = await call('GET', '/api/venue-profile');
  assert.strictEqual(res.body.has_model_backed_data, false);
  assert.strictEqual(res.body.corpus_summary, corpusSummary({ corpus_status: 'absent', corpus_baseline_rows: 0 }));
  // Said plainly. An owner reading this must not come away thinking a forecast
  // is on its way.
  assert.match(res.body.corpus_summary, /no crowd history/i);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. The form and the server agree, and the form is reachable twice
// ═══════════════════════════════════════════════════════════════════════════

// The venue owner dashboard left App.js on 2026-08-26: it is its own lazily
// loaded chunk now (screens/VenueDashboard.js), and the venue settings card
// this section reads went with it. Nothing asserted below changed. The app
// source is simply in two files, so both are read, in the order they used to
// be one.
const CLIENT_SRC = path.join(__dirname, '..', '..', 'frontend', 'src');
const APP_JS = fs.readFileSync(path.join(CLIENT_SRC, 'App.js'), 'utf8')
  + fs.readFileSync(path.join(CLIENT_SRC, 'screens', 'VenueDashboard.js'), 'utf8');

// A dropdown offering a value the server refuses is a form that 400s on submit.
function optionValues(constName) {
  const start = APP_JS.indexOf(`const ${constName} = [`);
  assert.notStrictEqual(start, -1, `${constName} is gone from frontend/src/App.js`);
  const end = APP_JS.indexOf('\n  ];', start);
  const block = APP_JS.slice(start, end);
  return [...block.matchAll(/value: '([a-z_]+)'/g)].map((m) => m[1]);
}

test('every option the venue form offers is a value the server accepts', () => {
  const pairs = [
    ['venueServiceStyles', intake.SERVICE_STYLES],
    ['venueReservationPolicies', intake.RESERVATION_POLICIES],
    ['venueAgePolicies', intake.AGE_POLICIES],
    ['venueWeekdays', intake.WEEKDAYS],
    ['venueAnchorTypes', intake.ANCHOR_TYPES],
  ];
  for (const [constName, allowed] of pairs) {
    assert.deepStrictEqual(optionValues(constName), allowed,
      `${constName} in App.js has drifted from validators/venueIntake.js`);
  }
});

test('the picker requires a real Google place, not a typed name', () => {
  // The place id is the join key to ml_venue_baselines, ml_venues, the badge,
  // NFC taps and the one-owner-per-place claim. It used to be captured only if
  // the owner happened to tap a suggestion.
  assert.match(APP_JS, /venueOnboardingStep === 1\) return !!venueOnboardingData\.googlePlaceId/,
    'venue onboarding step 1 no longer requires a picked place id');
});

test('everything the form asks is answerable again in settings', () => {
  // The bug this closes: category, description and goals were accepted by the
  // PUT and exposed in settings by nothing, so they could be set exactly once.
  const start = APP_JS.indexOf('About Your Venue');
  assert.notStrictEqual(start, -1, 'the venue settings intake card is gone');
  const card = APP_JS.slice(start, start + 12000);
  for (const key of [
    'category', 'description', 'goals', 'capacity', 'serviceStyle', 'hasOutdoorSeating',
    'reservationPolicy', 'largestWalkinGroup', 'typicalDwellMinutes', 'typicalSpendPerPerson',
    'kitchenLastOrder', 'lastCall', 'agePolicy', 'ageRestrictedAfter',
    'eventNights', 'eventNote', 'ownerBusyNights', 'targetNight',
    'anchorTypes', 'anchorNote', 'quirks',
  ]) {
    assert.ok(card.includes(key), `venue settings cannot edit ${key}`);
  }
});

test('the optional onboarding steps say they are optional', () => {
  // SLOP-AUDIT §G10: onboarding screens get a Skip, and a longer form needs it
  // more than a short one did.
  assert.match(APP_JS, /const skippableSteps = new Set/, 'the intake steps lost their Skip');
});
