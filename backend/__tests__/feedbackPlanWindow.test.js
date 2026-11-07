// Run: node --test __tests__/feedbackPlanWindow.test.js  (from backend/)
//
// THE PLAN WINDOW (2026-11-06): a report from somebody who was a member of a
// locked-in plan counts from the plan's start until noon the day after the
// plan's night on the VENUE's clock, never less than the old 12 hours
// (utils/planReportWindow.js, routes/feedback.js PLAN_FACTS_SQL).
//
// Every clock here is pinned to a fixed instant, in three zones and across
// both 2026-27 clock changes in New York, so no test depends on the hour the
// suite runs at. Part 1 is the arithmetic; part 2 runs the route against a
// fixture database the way __tests__/feedbackRoute.test.js does (no Postgres:
// every statement the route issues is answered, and an unscripted one fails
// the last test).
//
// Before this change every route case below that expects a morning report to
// count failed: the route had only the 12 hours either side of the plan, and
// the fixture's presence check answers no for a report past them, exactly as
// the SQL does.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'test-secret-for-feedback-plan-window-tests';

const {
  noonAfterNightMs,
  planReportClosesAtMs,
  planReportStanding,
  planClock,
  PLAN_REPORT_FLOOR_MS,
} = require('../utils/planReportWindow');

const at = (iso) => Date.parse(iso);
const iso = (ms) => new Date(ms).toISOString();

// ===========================================================================
// PART 1: the window
// ===========================================================================

// Friday 2026-11-06, 9 PM in each zone, as instants.
const NY_FRI_9PM = at('2026-11-07T02:00:00Z');      // EST, UTC-5
const LA_FRI_9PM = at('2026-11-07T05:00:00Z');      // PST, UTC-8
const KOL_FRI_9PM = at('2026-11-06T15:30:00Z');     // IST, UTC+5:30

test('a 9 PM plan counts until noon the next day on the venue clock, in each zone', () => {
  assert.equal(iso(planReportClosesAtMs(NY_FRI_9PM, 'America/New_York')), '2026-11-07T17:00:00.000Z');
  assert.equal(iso(planReportClosesAtMs(LA_FRI_9PM, 'America/Los_Angeles')), '2026-11-07T20:00:00.000Z');
  // A half-hour zone: noon IST is 06:30 UTC, not 06:00 or 07:00.
  assert.equal(iso(planReportClosesAtMs(KOL_FRI_9PM, 'Asia/Kolkata')), '2026-11-07T06:30:00.000Z');
  // Fifteen hours each: three more than the old rule.
  for (const [ev, z] of [[NY_FRI_9PM, 'America/New_York'], [LA_FRI_9PM, 'America/Los_Angeles'], [KOL_FRI_9PM, 'Asia/Kolkata']]) {
    assert.equal(planReportClosesAtMs(ev, z) - ev, 15 * 3600 * 1000, z);
  }
});

test('the same instant closes at a different moment for a venue in another zone', () => {
  // 02:00Z on 7 Nov is 9 PM Friday in New York, 6 PM Friday in Los Angeles
  // and 7:30 AM Saturday in Kolkata, whose night is therefore Saturday's.
  assert.equal(iso(planReportClosesAtMs(NY_FRI_9PM, 'America/New_York')), '2026-11-07T17:00:00.000Z');
  assert.equal(iso(planReportClosesAtMs(NY_FRI_9PM, 'America/Los_Angeles')), '2026-11-07T20:00:00.000Z');
  assert.equal(iso(planReportClosesAtMs(NY_FRI_9PM, 'Asia/Kolkata')), '2026-11-08T06:30:00.000Z');
});

test('the old 12 hours are the floor: a 2 AM plan counts until 2 PM', () => {
  // Saturday 2 AM in New York belongs to Friday's night, so its noon is
  // Saturday's, which is earlier than 2 AM + 12 hours.
  const sat2am = at('2026-11-07T07:00:00Z');
  assert.equal(iso(noonAfterNightMs(sat2am, 'America/New_York')), '2026-11-07T17:00:00.000Z');
  assert.equal(planReportClosesAtMs(sat2am, 'America/New_York'), sat2am + PLAN_REPORT_FLOOR_MS);
  assert.equal(iso(planReportClosesAtMs(sat2am, 'America/New_York')), '2026-11-07T19:00:00.000Z');
});

test('the night rolls over at 4 AM, as the Nest and the Tonight answer do', () => {
  // 3:59 AM Saturday is still Friday night: noon Saturday, beaten by the floor.
  const sat359 = at('2026-11-07T08:59:00Z');
  assert.equal(iso(noonAfterNightMs(sat359, 'America/New_York')), '2026-11-07T17:00:00.000Z');
  assert.equal(planReportClosesAtMs(sat359, 'America/New_York'), sat359 + PLAN_REPORT_FLOOR_MS);
  // 4:00 AM Saturday is Saturday: noon Sunday.
  const sat4 = at('2026-11-07T09:00:00Z');
  assert.equal(iso(planReportClosesAtMs(sat4, 'America/New_York')), '2026-11-08T17:00:00.000Z');
  // An 11 AM brunch counts until noon the next day.
  const sat11 = at('2026-11-07T16:00:00Z');
  assert.equal(iso(planReportClosesAtMs(sat11, 'America/New_York')), '2026-11-08T17:00:00.000Z');
});

test('noon is found on the clock, so the night New York falls back is 16 hours', () => {
  // Saturday 2026-10-31 9 PM EDT (UTC-4); the clocks go back at 2 AM Sunday,
  // and noon Sunday is EST (UTC-5).
  const ev = at('2026-11-01T01:00:00Z');
  assert.equal(iso(planReportClosesAtMs(ev, 'America/New_York')), '2026-11-01T17:00:00.000Z');
  assert.equal(planReportClosesAtMs(ev, 'America/New_York') - ev, 16 * 3600 * 1000);
  // Los Angeles falls back the same night, three hours west.
  const la = at('2026-11-01T04:00:00Z');
  assert.equal(iso(planReportClosesAtMs(la, 'America/Los_Angeles')), '2026-11-01T20:00:00.000Z');
});

test('and the night it springs forward is 14 hours', () => {
  // Saturday 2027-03-13 9 PM EST; at 2 AM Sunday the clock jumps to 3 AM EDT.
  const ev = at('2027-03-14T02:00:00Z');
  assert.equal(iso(planReportClosesAtMs(ev, 'America/New_York')), '2027-03-14T16:00:00.000Z');
  assert.equal(planReportClosesAtMs(ev, 'America/New_York') - ev, 14 * 3600 * 1000);
  // Kolkata has no clock change, so the same weekend is plain 15 hours.
  const kol = at('2027-03-13T15:30:00Z');
  assert.equal(planReportClosesAtMs(kol, 'Asia/Kolkata') - kol, 15 * 3600 * 1000);
});

test('with no usable zone the window is the old 12 hours, nothing added', () => {
  for (const zone of [null, undefined, '', 'Not/AZone', 42]) {
    assert.equal(noonAfterNightMs(NY_FRI_9PM, zone), null, String(zone));
    assert.equal(planReportClosesAtMs(NY_FRI_9PM, zone), NY_FRI_9PM + PLAN_REPORT_FLOOR_MS, String(zone));
  }
  assert.equal(planReportClosesAtMs(NaN, 'America/New_York'), null);
});

test("the plan's own hour on the venue clock is the bucket a report on it takes", () => {
  assert.deepEqual(planClock(NY_FRI_9PM, 'America/New_York'), { day: 5, hour: 21 });
  assert.deepEqual(planClock(LA_FRI_9PM, 'America/Los_Angeles'), { day: 5, hour: 21 });
  assert.deepEqual(planClock(KOL_FRI_9PM, 'Asia/Kolkata'), { day: 5, hour: 21 });
  assert.deepEqual(planClock(NY_FRI_9PM, 'Asia/Kolkata'), { day: 6, hour: 7 });
  assert.equal(planClock(NY_FRI_9PM, null), null);
});

const PLACE = 'ChIJN1t_tDeuEmsRUsoyG83frY4';
const planRow = (o = {}) => ({
  venue_id: PLACE,
  event_ms: String(NY_FRI_9PM), // EXTRACT(EPOCH ...) * 1000 arrives as a numeric string
  locked_in: true,
  member_at_lock: true,
  not_marked_absent: true,
  accepted_members: 3,
  ...o,
});
const stand = (row, nowIso, zone = 'America/New_York') => planReportStanding(row, {
  venuePlaceId: PLACE, nowMs: at(nowIso), zone,
});

test('standing: counts from the start until noon, and says when the clock is the reason', () => {
  const before = stand(planRow(), '2026-11-07T01:59:00Z');
  assert.equal(before.started, false);
  assert.equal(before.counts, false, 'nothing before the start counts through this window');
  assert.equal(before.windowClosed, false);

  const morning = stand(planRow(), '2026-11-07T15:30:00Z'); // 10:30 AM EST, 13.5 h in
  assert.equal(morning.counts, true);
  assert.equal(morning.windowClosed, false);
  assert.equal(iso(morning.closesAtMs), '2026-11-07T17:00:00.000Z');

  const lastMinute = stand(planRow(), '2026-11-07T16:59:59Z');
  assert.equal(lastMinute.counts, true);
  const noon = stand(planRow(), '2026-11-07T17:00:00Z');
  assert.equal(noon.counts, false, 'noon itself is outside');
  assert.equal(noon.windowClosed, true);
});

test('standing: every rule but time must hold, or the window is not this report\'s', () => {
  const now = '2026-11-07T15:30:00Z';
  for (const [name, row] of [
    ['never locked in', planRow({ locked_in: false })],
    ['joined after lock-in', planRow({ member_at_lock: false })],
    ['marked absent by the host', planRow({ not_marked_absent: false })],
    ['a plan of one', planRow({ accepted_members: 1 })],
    ['another venue', planRow({ venue_id: 'ChIJOtherPlaceIdxxxxxxxxxxxx' })],
    ['a NULL from the database', planRow({ member_at_lock: null })],
  ]) {
    const s = stand(row, now);
    assert.equal(s.eligible, false, name);
    assert.equal(s.counts, false, name);
    assert.equal(s.windowClosed, false, `${name}: the clock is not the reason`);
  }
  assert.equal(stand(null, now), null);
  assert.equal(stand(planRow({ event_ms: null }), now), null);
  // accepted_members as Postgres hands back a bigint: a string.
  assert.equal(stand(planRow({ accepted_members: '2' }), now).counts, true);
});

// ===========================================================================
// PART 2: the route, on a fixture database, with its clock pinned
// ===========================================================================

const pool = require('../config/database');

let state;
let queries;
let inserted;
let unknown;

function reset() {
  state = {
    memberships: [{ flock_id: 10, user_id: 1 }],
    flockStatus: { 10: 'completed' },
    planFacts: { 10: planRow() },   // PLAN_FACTS_SQL's row for (flock, user 1)
    planFactsFails: false,
    timezone: 'America/New_York',   // ml_venues.timezone for PLACE
    qualifyingFlock: false,         // the OLD rule's answer: false past its 12 hours
    signedNfcCheckin: false,
    recentCount: 0,
    servedRows: [],
  };
  queries = [];
  inserted = null;
  unknown = [];
}
reset();

function dispatch(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  queries.push({ text, params });

  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return Promise.resolve({ rows: [] });
  if (/pg_advisory_xact_lock/i.test(text)) return Promise.resolve({ rows: [{}] });
  if (/FROM ml_venues WHERE google_place_id/i.test(text)) {
    return Promise.resolve({ rows: state.timezone ? [{ timezone: state.timezone }] : [] });
  }
  // PLAN_FACTS_SQL: the plan and this member's row, joined.
  if (/FROM flocks f JOIN flock_members fm/i.test(text)) {
    if (state.planFactsFails) return Promise.reject(new Error('canceling statement due to statement timeout'));
    const [flockId, userId] = params;
    const member = state.memberships.some((m) => m.flock_id === Number(flockId) && m.user_id === Number(userId));
    const row = member ? state.planFacts[Number(flockId)] : null;
    return Promise.resolve({ rows: row ? [row] : [] });
  }
  if (/FROM served_predictions/i.test(text)) {
    const [, , day, hour, eventMs] = params;
    const qualifying = state.servedRows.filter((r) => (
      r.source === 'detail' && r.local_day === day && r.local_hour === hour
      && (eventMs == null || Math.abs(at(r.served_at) - eventMs) < 12 * 3600 * 1000)
    ));
    return Promise.resolve({ rows: qualifying.length ? [{ id: qualifying[0].id, score: qualifying[0].score }] : [] });
  }
  if (/FROM flock_members WHERE flock_id/i.test(text)) {
    const [flockId, userId] = params;
    const hit = state.memberships.some((m) => m.flock_id === Number(flockId) && m.user_id === Number(userId));
    const row = { flock_status: state.flockStatus[Number(flockId)] ?? null };
    return Promise.resolve({ rows: hit ? [row] : [], rowCount: hit ? 1 : 0 });
  }
  if (/^DELETE FROM venue_feedback/i.test(text)) return Promise.resolve({ rows: [], rowCount: 0 });
  if (/SELECT COUNT\(\*\)::int AS n FROM venue_feedback/i.test(text)) {
    return Promise.resolve({ rows: [{ n: state.recentCount }] });
  }
  if (/FROM venue_checkins/i.test(text) && /flock_members fm/i.test(text)) {
    return Promise.resolve({ rows: [{ verified: state.signedNfcCheckin || state.qualifyingFlock }] });
  }
  if (/^INSERT INTO venue_feedback/i.test(text)) {
    inserted = params;
    return Promise.resolve({
      rows: [{
        id: 1,
        user_id: params[0],
        flock_id: params[1],
        venue_place_id: params[2],
        venue_name: params[3],
        crowd_level: params[4],
        price_worth: params[5],
        rating: params[6],
        predicted_score: params[7],
        predicted_score_source: params[8],
        client_predicted_score: params[9],
        served_prediction_id: params[10],
        day_of_week: params[11],
        hour: params[12],
        verified: params[13],
        observed_at: params[14],
      }],
    });
  }
  unknown.push(text);
  return Promise.reject(new Error(`unscripted query: ${text.slice(0, 140)}`));
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({ query: (sql, params) => dispatch(sql, params), release: () => {} });

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 1, name: 'Ava', role: 'user' }; next(); };

const feedbackRouter = require('../routes/feedback');
const { clock } = feedbackRouter.__testables;
const realNow = clock.now;

const app = express();
app.use(express.json());
app.use('/api/feedback', feedbackRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => {
  clock.now = realNow;
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));
test.beforeEach(() => { reset(); clock.now = realNow; });

async function report(nowIso, body = {}) {
  clock.now = () => at(nowIso);
  const res = await fetch(`${base}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      venue_place_id: PLACE,
      venue_name: 'The Vault',
      crowd_level: 3,
      flock_id: 10,
      ...body,
    }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

const VERIFIED = 13;
const DAY = 11;
const HOUR = 12;
const OBSERVED = 14;

test('New York: a 10:30 AM answer about last night counts, filed under the night', async () => {
  const r = await report('2026-11-07T15:30:00Z'); // Sat 10:30 AM EST, 13.5 h after 9 PM
  assert.equal(r.status, 201, r.text);
  assert.equal(inserted[VERIFIED], true, 'the morning answer counts under the plan window');
  assert.equal(r.body.verified, true);
  // Filed under Friday 9 PM, not Saturday 10 AM.
  assert.equal(inserted[DAY], 5);
  assert.equal(inserted[HOUR], 21);
  assert.equal(new Date(inserted[OBSERVED]).toISOString(), '2026-11-07T02:00:00.000Z');
  assert.equal(r.body.plan_report_closes_at, '2026-11-07T17:00:00.000Z');
  assert.equal(r.body.plan_window_closed, false);
});

test('New York: at noon the window has shut, and the answer says the clock is why', async () => {
  const r = await report('2026-11-07T17:00:00Z');
  assert.equal(r.status, 201, r.text);
  assert.equal(inserted[VERIFIED], false);
  assert.equal(r.body.plan_window_closed, true);
  assert.equal(r.body.plan_report_closes_at, '2026-11-07T17:00:00.000Z');
  // Still filed under the night it is about.
  assert.deepEqual([inserted[DAY], inserted[HOUR]], [5, 21]);
});

test('Los Angeles, zone from the reporter: 11:59 AM counts, 12:01 PM does not', async () => {
  state.timezone = null; // not an ml_venues venue
  state.planFacts[10] = planRow({ event_ms: String(LA_FRI_9PM) });
  const ok = await report('2026-11-07T19:59:00Z', { time_zone: 'America/Los_Angeles' });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(inserted[VERIFIED], true);
  assert.deepEqual([inserted[DAY], inserted[HOUR]], [5, 21]);

  reset();
  state.timezone = null;
  state.planFacts[10] = planRow({ event_ms: String(LA_FRI_9PM) });
  const late = await report('2026-11-07T20:01:00Z', { time_zone: 'America/Los_Angeles' });
  assert.equal(inserted[VERIFIED], false);
  assert.equal(late.body.plan_window_closed, true);
});

test('Kolkata (+5:30): the half-hour zone shuts at 12:00 IST exactly', async () => {
  state.timezone = 'Asia/Kolkata';
  state.planFacts[10] = planRow({ event_ms: String(KOL_FRI_9PM) });
  await report('2026-11-07T06:29:00Z'); // 11:59 AM IST
  assert.equal(inserted[VERIFIED], true);
  assert.deepEqual([inserted[DAY], inserted[HOUR]], [5, 21]);

  reset();
  state.timezone = 'Asia/Kolkata';
  state.planFacts[10] = planRow({ event_ms: String(KOL_FRI_9PM) });
  await report('2026-11-07T06:30:00Z'); // 12:00 IST
  assert.equal(inserted[VERIFIED], false);
});

test('the venue zone wins over the reporter zone', async () => {
  // ml_venues says New York; a phone set to Kolkata would put noon 10.5 hours
  // earlier. The venue's own clock decides.
  await report('2026-11-07T15:30:00Z', { time_zone: 'Asia/Kolkata' });
  assert.equal(inserted[VERIFIED], true);
  assert.deepEqual([inserted[DAY], inserted[HOUR]], [5, 21]);
});

test('fall back: 11:30 AM EST after a 9 PM EDT plan is 15.5 hours and still counts', async () => {
  state.planFacts[10] = planRow({ event_ms: String(at('2026-11-01T01:00:00Z')) });
  await report('2026-11-01T16:30:00Z');
  assert.equal(inserted[VERIFIED], true);
  assert.deepEqual([inserted[DAY], inserted[HOUR]], [6, 21]); // Saturday 9 PM
  reset();
  state.planFacts[10] = planRow({ event_ms: String(at('2026-11-01T01:00:00Z')) });
  await report('2026-11-01T17:00:00Z'); // noon EST
  assert.equal(inserted[VERIFIED], false);
});

test('spring forward: the window shuts at noon EDT, 14 hours after a 9 PM EST plan', async () => {
  state.planFacts[10] = planRow({ event_ms: String(at('2027-03-14T02:00:00Z')) });
  await report('2027-03-14T15:59:00Z'); // 11:59 AM EDT
  assert.equal(inserted[VERIFIED], true);
  reset();
  state.planFacts[10] = planRow({ event_ms: String(at('2027-03-14T02:00:00Z')) });
  await report('2027-03-14T16:00:00Z'); // 12:00 EDT
  assert.equal(inserted[VERIFIED], false);
});

test('a 2 AM plan keeps its 12 hours: 1:59 PM counts, 2 PM does not', async () => {
  state.planFacts[10] = planRow({ event_ms: String(at('2026-11-07T07:00:00Z')) });
  await report('2026-11-07T18:59:00Z');
  assert.equal(inserted[VERIFIED], true);
  reset();
  state.planFacts[10] = planRow({ event_ms: String(at('2026-11-07T07:00:00Z')) });
  const r = await report('2026-11-07T19:00:00Z');
  assert.equal(inserted[VERIFIED], false);
  assert.equal(r.body.plan_report_closes_at, '2026-11-07T19:00:00.000Z');
});

test('the anti-abuse rules hold inside the window', async () => {
  for (const [name, row] of [
    ['a plan never locked in', planRow({ locked_in: false })],
    ['a member who joined after lock-in', planRow({ member_at_lock: false })],
    ['a member the host marked absent', planRow({ not_marked_absent: false })],
    ['a plan of one', planRow({ accepted_members: 1 })],
  ]) {
    reset();
    state.planFacts[10] = row;
    const r = await report('2026-11-07T15:30:00Z');
    assert.equal(r.status, 201, `${name}: ${r.text}`);
    assert.equal(inserted[VERIFIED], false, name);
    assert.equal(r.body.plan_window_closed, undefined, `${name}: the clock is not the reason, so nothing says it is`);
    // Still about that night: a member of the plan, after its start.
    assert.deepEqual([inserted[DAY], inserted[HOUR]], [5, 21], name);
  }
});

test('nothing before the start counts through the window, and keeps its own clock', async () => {
  // 8:30 PM, half an hour early. The old rule decides (here: no).
  const r = await report('2026-11-07T01:30:00Z');
  assert.equal(r.status, 201, r.text);
  assert.equal(inserted[VERIFIED], false);
  assert.deepEqual([inserted[DAY], inserted[HOUR]], [5, 20], 'filed under the hour it was sent');
  assert.equal(inserted[OBSERVED], null);
  // And the old rule still verifies an early report when it says yes.
  reset();
  state.qualifyingFlock = true;
  await report('2026-11-07T01:30:00Z');
  assert.equal(inserted[VERIFIED], true);
});

test('a report that names no plan keeps the old rule and its own hour', async () => {
  const r = await report('2026-11-07T15:30:00Z', { flock_id: null });
  assert.equal(r.status, 201, r.text);
  assert.equal(inserted[VERIFIED], false, 'the old 12 hours have passed and nothing else applies');
  assert.deepEqual([inserted[DAY], inserted[HOUR]], [6, 10]);
  assert.equal(inserted[OBSERVED], null);
  assert.equal(r.body.plan_window_closed, undefined);
  assert.ok(!queries.some((q) => /FROM flocks f JOIN flock_members fm/i.test(q.text)), 'no plan read without a plan');
});

test('a plan at another venue is not a report on that plan', async () => {
  state.planFacts[10] = planRow({ venue_id: 'ChIJOtherPlaceIdxxxxxxxxxxxx' });
  await report('2026-11-07T15:30:00Z');
  assert.equal(inserted[VERIFIED], false);
  assert.deepEqual([inserted[DAY], inserted[HOUR]], [6, 10]);
  assert.equal(inserted[OBSERVED], null);
});

test('with no zone at all the window is the old 12 hours and the old clock', async () => {
  state.timezone = null;
  const r = await report('2026-11-07T15:30:00Z', { local_day: 6, local_hour: 10 });
  assert.equal(inserted[VERIFIED], false);
  assert.deepEqual([inserted[DAY], inserted[HOUR]], [6, 10]);
  assert.equal(r.body.plan_report_closes_at, '2026-11-07T14:00:00.000Z', '9 PM + 12 hours');
  assert.equal(r.body.plan_window_closed, true);
});

test('a zone name the server does not know is ignored, not refused', async () => {
  state.timezone = null;
  const r = await report('2026-11-07T15:30:00Z', { time_zone: 'Mars/Olympus_Mons' });
  assert.equal(r.status, 201, r.text);
  assert.equal(inserted[VERIFIED], false);
  const bad = await report('2026-11-07T15:30:00Z', { time_zone: 'x'.repeat(65) });
  assert.equal(bad.status, 400, 'an over-long zone is a 400');
});

test('one report per member per plan: a counted report replaces the earlier ones on that plan', async () => {
  await report('2026-11-07T15:30:00Z');
  const del = queries.find((q) => /^DELETE FROM venue_feedback/i.test(q.text));
  assert.match(del.text, /OR flock_id = \$3::int/);
  assert.deepEqual(del.params, [1, PLACE, 10, null]);
});

test('a late answer replaces nothing on the plan, and protects the one that counted', async () => {
  await report('2026-11-07T18:00:00Z'); // 1 PM, after noon
  const del = queries.find((q) => /^DELETE FROM venue_feedback/i.test(q.text));
  assert.match(del.text, /AND NOT COALESCE\(verified IS TRUE AND flock_id = \$4::int, false\)/);
  assert.deepEqual(del.params, [1, PLACE, null, 10]);
});

test('whether a report counts is settled before the dedupe that depends on it', async () => {
  await report('2026-11-07T15:30:00Z');
  const order = queries.map((q) => q.text);
  const presence = order.findIndex((t) => /FROM venue_checkins/i.test(t));
  const del = order.findIndex((t) => /^DELETE FROM venue_feedback/i.test(t));
  assert.ok(presence >= 0 && presence < del);
});

test('a report that names no plan keeps the plain 2-hour dedupe', async () => {
  await report('2026-11-07T15:30:00Z', { flock_id: null });
  const del = queries.find((q) => /^DELETE FROM venue_feedback/i.test(q.text));
  assert.deepEqual(del.params, [1, PLACE, null, null]);
});

test("the denominator is the card read in the plan's hour, from 12 hours either side of it", async () => {
  state.servedRows = [
    { id: 77, score: 81, source: 'detail', local_day: 5, local_hour: 21, served_at: '2026-11-07T02:20:00Z' },
  ];
  await report('2026-11-07T15:30:00Z', { predicted_score: 12, local_day: 6, local_hour: 10 });
  const lookup = queries.find((q) => /FROM served_predictions/i.test(q.text));
  assert.deepEqual(lookup.params, [1, PLACE, 5, 21, NY_FRI_9PM]);
  assert.match(lookup.text, /to_timestamp\(\$5::double precision \/ 1000\.0\) - INTERVAL '12 hours'/);
  assert.match(lookup.text, /to_timestamp\(\$5::double precision \/ 1000\.0\) \+ INTERVAL '12 hours'/);
  assert.equal(inserted[7], 81, 'the night serve is the predicted score');
  assert.equal(inserted[8], 'server');
  assert.equal(inserted[9], 12, 'the breakfast number the phone sent is kept verbatim');
});

test("a claim from another hour is not the night's denominator", async () => {
  // No serve in the plan's hour; the phone sent the 10 AM score.
  await report('2026-11-07T15:30:00Z', { predicted_score: 12, local_day: 6, local_hour: 10 });
  assert.equal(inserted[7], null, 'a breakfast forecast must not be paired with the night');
  assert.equal(inserted[8], null);
  assert.equal(inserted[9], 12);
});

test("a claim made in the plan's own hour still is", async () => {
  await report('2026-11-07T02:40:00Z', { predicted_score: 64, local_day: 5, local_hour: 21 });
  assert.equal(inserted[VERIFIED], true);
  assert.equal(inserted[7], 64);
  assert.equal(inserted[8], 'client');
});

test('a failing plan read costs the window, never the report', async () => {
  state.planFactsFails = true;
  const r = await report('2026-11-07T15:30:00Z', { local_day: 6, local_hour: 10 });
  assert.equal(r.status, 201, r.text);
  assert.equal(inserted[VERIFIED], false);
  assert.deepEqual([inserted[DAY], inserted[HOUR]], [6, 10]);
  assert.ok(queries.some((q) => /^COMMIT/i.test(q.text)));
});

test('the plan read and the served lookup both run before BEGIN; the refusals still run inside', async () => {
  await report('2026-11-07T15:30:00Z');
  const order = queries.map((q) => q.text);
  const idx = (re) => order.findIndex((t) => re.test(t));
  const plan = idx(/FROM flocks f JOIN flock_members fm/i);
  const served = idx(/FROM served_predictions/i);
  const begin = idx(/^BEGIN/i);
  const membership = idx(/FROM flock_members WHERE flock_id/i);
  assert.ok(plan >= 0 && plan < served, 'the plan is read before the served lookup that needs its hour');
  assert.equal(begin, served + 1);
  assert.ok(membership > begin, 'the membership refusal stays inside the transaction');
});

test('a plan that is not yours is still refused, window or not', async () => {
  state.memberships = [];
  const r = await report('2026-11-07T15:30:00Z');
  assert.equal(r.status, 403, r.text);
  assert.equal(inserted, null);
});

test('a plan that was called off is still refused', async () => {
  state.flockStatus[10] = 'cancelled';
  const r = await report('2026-11-07T15:30:00Z');
  assert.equal(r.status, 409, r.text);
  assert.equal(inserted, null);
});

test('PLAN_FACTS_SQL reads the instant as UTC and the lock-in as a time, not a flag', () => {
  const sql = feedbackRouter.__testables.PLAN_FACTS_SQL.replace(/\s+/g, ' ');
  assert.match(sql, /EXTRACT\(EPOCH FROM \(f\.event_time AT TIME ZONE 'UTC'\)\) \* 1000 AS event_ms/);
  assert.match(sql, /f\.confirmed_at IS NOT NULL AND f\.status IN \('confirmed', 'completed'\)/);
  assert.match(sql, /\(fm\.joined_at AT TIME ZONE 'UTC'\) <= f\.confirmed_at/);
  assert.match(sql, /fm\.attendance IS DISTINCT FROM 'no_show'/);
  assert.match(sql, /fm\.status = 'accepted'/);
  assert.match(sql, /m\.status = 'accepted'\)::int AS accepted_members/);
});

test('no unscripted statement was issued', () => {
  assert.deepEqual(unknown, []);
});
