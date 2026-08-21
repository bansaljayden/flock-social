// Run: node --test  (from backend/)
//
// ===========================================================================
// A LOOKUP THAT DID NOT SUCCEED MUST NOT BECOME A SOURCED FACT.
//
// Codex review finding 6. services/mlPredictor.js getNearbyEvents answered
// with one indistinguishable `hasEvent: false` object in five situations, and
// only one of them was an observation:
//
//   * the Ticketmaster key is missing,
//   * the event budget refused to make the call,
//   * Ticketmaster returned an error status,
//   * the request timed out,
//   * Ticketmaster answered and listed nothing nearby.
//
// services/advisorFacts.js treated all five as a negative observation and,
// after seven of them, built a fact with id `no_listed_events`, source
// `events` and a current `asOf`, reading "No big listed events within about a
// kilometer over the next 7 days". A venue owner can staff a night against
// that sentence while no listing query ever ran.
//
// The whole fact engine rests on one rule: a fact carries a real source or it
// cannot be constructed. This file pins both halves of the repair.
//
//   1. getNearbyEvents stamps `observed` on every return, so the caller can
//      tell an answer from a silence, plus `unavailableReason` naming which
//      silence it was.
//   2. buildAroundYou constructs `no_listed_events` only when every one of the
//      seven daily probes genuinely answered. Any unanswered day produces a
//      refusal instead, and a refusal is not a fact and carries no source.
//
// Each of the three failure modes in the finding is driven separately, end to
// end, through the real getNearbyEvents rather than a stub: budget refusal,
// provider error, timeout. The genuine empty result is driven the same way and
// must still produce the fact, because a card that refuses when the street is
// actually quiet is a different bug with the same shape.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');

process.env.TICKETMASTER_API_KEY = 'provenance-test-key';

// The baseline curve is read inside a try/catch for the probe hour. An empty
// curve is a supported state (the 19:00 fallback covers it), so this fake
// keeps the whole file off Postgres.
const pool = require('../config/database');
pool.query = async () => ({ rows: [], rowCount: 0 });

const mlPredictor = require('../services/mlPredictor');
const weatherService = require('../services/weatherService');
const advisorFacts = require('../services/advisorFacts');

const I = mlPredictor._internals;
const realFetch = global.fetch;

// A venue in the corpus with coordinates, which is what card 2 needs before it
// will look anything up at all.
const CTX = {
  mlVenue: { latitude: 39.9526, longitude: -75.1652, timezone: 'America/New_York' },
  profile: { google_place_id: 'ChIJprovenancetest', anchor_types: null, anchor_note: null },
};
const NOW = new Date('2026-08-20T18:00:00Z');

// Distinct coordinates per case so no case can be answered out of another's
// cache entry. The cache key buckets to three decimals.
let caseN = 0;
function freshCtx() {
  caseN += 1;
  return {
    ...CTX,
    mlVenue: { ...CTX.mlVenue, latitude: 39.9526 + caseN * 0.01 },
  };
}

function okEmpty() {
  return { ok: true, status: 200, json: async () => ({ _embedded: { events: [] } }) };
}

async function aroundYou(ctx, userId) {
  return advisorFacts.buildAroundYou(ctx, { now: NOW, userId });
}

const isEventFact = (f) => !advisorFacts.isRefusal(f) && f.source === 'events';
const byId = (facts, id) => facts.find((f) => f.id === id) || null;

test.afterEach(() => {
  global.fetch = realFetch;
  I.__resetEventBudget();
});

// ── Layer 1: the sentinel is distinguishable ────────────────────────────────

test('an empty Ticketmaster list is observed; the three failures are not', async () => {
  I.__resetEventBudget();
  const at = new Date('2026-08-21T23:00:00Z');

  global.fetch = async () => okEmpty();
  const empty = await I.getNearbyEvents(41.1, -75.1, at, 90001);
  assert.equal(empty.hasEvent, false);
  assert.equal(empty.observed, true, 'the vendor answered, and the answer was nothing');
  assert.equal(empty.unavailableReason, null);

  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const errored = await I.getNearbyEvents(41.2, -75.1, at, 90002);
  assert.equal(errored.hasEvent, false);
  assert.equal(errored.observed, false, 'a 503 is not an empty street');
  assert.equal(errored.unavailableReason, 'provider_error');

  global.fetch = async () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  };
  const timedOut = await I.getNearbyEvents(41.3, -75.1, at, 90003);
  assert.equal(timedOut.observed, false, 'a timeout is not an empty street');
  assert.equal(timedOut.unavailableReason, 'timeout');

  delete process.env.TICKETMASTER_API_KEY;
  const keyless = await I.getNearbyEvents(41.4, -75.1, at, 90004);
  process.env.TICKETMASTER_API_KEY = 'provenance-test-key';
  assert.equal(keyless.observed, false, 'no key means no lookup');
  assert.equal(keyless.unavailableReason, 'no_api_key');
});

test('the budget refusal is unobserved, and costs nothing to discover', async () => {
  I.__resetEventBudget();
  let upstreamCalls = 0;
  global.fetch = async () => { upstreamCalls += 1; return okEmpty(); };

  const USER = 90101;
  const at = new Date('2026-08-21T23:00:00Z');
  // The per-account hourly ceiling is 200 real calls. Distinct coordinates so
  // every one of them is a cache miss and therefore a charged call.
  for (let i = 0; i < 200; i++) {
    await I.getNearbyEvents(20 + i * 0.01, -75.1, at, USER);
  }
  assert.equal(upstreamCalls, 200, 'the ceiling is reached by real calls, not by cache hits');

  const refused = await I.getNearbyEvents(30.5, -75.1, at, USER);
  assert.equal(upstreamCalls, 200, 'a refused call must not reach the vendor');
  assert.equal(refused.hasEvent, false);
  assert.equal(refused.observed, false, 'a call the budget refused saw nothing');
  assert.equal(refused.unavailableReason, 'budget_exhausted');
});

test('a failed lookup is remembered for a minute, not for an hour', async () => {
  I.__resetEventBudget();
  let calls = 0;
  global.fetch = async () => { calls += 1; return { ok: false, status: 500, json: async () => ({}) }; };
  const at = new Date('2026-08-21T23:00:00Z');

  const first = await I.getNearbyEvents(42.5, -75.1, at, 90201);
  const second = await I.getNearbyEvents(42.5, -75.1, at, 90201);
  assert.equal(calls, 1, 'the failure is cached, so an outage does not re-charge every request');
  assert.equal(second.observed, false, 'and the cached copy is still honest about being a failure');
  assert.equal(first.unavailableReason, second.unavailableReason);
});

// ── Layer 2: the fact engine refuses rather than inventing a quiet street ───

test('a genuine empty week still produces the sourced no_listed_events fact', async () => {
  I.__resetEventBudget();
  let calls = 0;
  global.fetch = async () => { calls += 1; return okEmpty(); };

  const facts = await aroundYou(freshCtx(), 90301);
  assert.equal(calls, 7, 'seven days, seven probes');
  const fact = byId(facts, 'no_listed_events');
  assert.ok(fact, 'seven answered probes that listed nothing IS a negative observation');
  assert.equal(fact.source, 'events');
  assert.equal(byId(facts, 'refuse_events_unavailable'), null, 'nothing to refuse about');
});

test('a provider error yields no event fact at all, only a refusal', async () => {
  I.__resetEventBudget();
  global.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });

  const facts = await aroundYou(freshCtx(), 90401);
  assert.equal(byId(facts, 'no_listed_events'), null,
    'a Ticketmaster 502 must never be published as "no listed events"');
  assert.equal(facts.filter(isEventFact).length, 0, 'no fact may carry event provenance here');
  const refusal = byId(facts, 'refuse_events_unavailable');
  assert.ok(refusal && advisorFacts.isRefusal(refusal), 'the card says it cannot say');
  assert.ok(/did not answer/.test(refusal.reason), refusal.reason);
});

test('a timeout yields no event fact at all, only a refusal', async () => {
  I.__resetEventBudget();
  global.fetch = async () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  };

  const facts = await aroundYou(freshCtx(), 90501);
  assert.equal(byId(facts, 'no_listed_events'), null,
    'a timed-out probe must never be published as "no listed events"');
  assert.equal(facts.filter(isEventFact).length, 0);
  assert.ok(byId(facts, 'refuse_events_unavailable'));
});

test('a budget refusal yields no event fact at all, only a refusal', async () => {
  I.__resetEventBudget();
  let upstreamCalls = 0;
  global.fetch = async () => { upstreamCalls += 1; return okEmpty(); };

  const USER = 90601;
  const at = new Date('2026-08-21T23:00:00Z');
  for (let i = 0; i < 200; i++) {
    await I.getNearbyEvents(50 + i * 0.01, -75.1, at, USER);
  }
  const spentBefore = upstreamCalls;

  const facts = await aroundYou(freshCtx(), USER);
  assert.equal(upstreamCalls, spentBefore, 'the card spent nothing it was not allowed to spend');
  assert.equal(byId(facts, 'no_listed_events'), null,
    'an exhausted budget must never be published as "no listed events"');
  assert.equal(facts.filter(isEventFact).length, 0);
  assert.ok(byId(facts, 'refuse_events_unavailable'));
});

test('one unanswered day is enough to withdraw the weekly claim, and the days we did see survive', async () => {
  I.__resetEventBudget();
  let n = 0;
  global.fetch = async () => {
    n += 1;
    if (n === 3) return { ok: false, status: 500, json: async () => ({}) };
    if (n === 4) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          _embedded: {
            events: [{
              name: 'Real listed show',
              classifications: [{ segment: { name: 'Music' } }],
              _embedded: { venues: [{ name: 'Nearby Theatre', location: { latitude: '40.0026', longitude: '-75.1652' } }] },
            }],
          },
        }),
      };
    }
    return okEmpty();
  };

  // The event has to sit inside the probe's radius, so build the venue on top
  // of the coordinates above rather than through freshCtx.
  const ctx = { ...CTX, mlVenue: { ...CTX.mlVenue, latitude: 40.0026, longitude: -75.1652 } };
  const facts = await aroundYou(ctx, 90701);

  assert.equal(byId(facts, 'no_listed_events'), null,
    'six answered days cannot speak for a seventh nobody asked about');
  const dayFacts = facts.filter((f) => isEventFact(f) && /^event_/.test(f.id));
  assert.equal(dayFacts.length, 1, 'the day the vendor DID answer stays a fact');
  assert.equal(dayFacts[0].source, 'events');
  const refusal = byId(facts, 'refuse_events_unavailable');
  assert.ok(refusal, 'and the hole in the week is stated');
  assert.ok(/1 of the next 7 days/.test(refusal.reason), refusal.reason);
});

// ── The same question, asked of weather ─────────────────────────────────────

test('weather cannot fabricate an observation either: an outage refuses', async () => {
  I.__resetEventBudget();
  global.fetch = async () => okEmpty();
  const realForecast = weatherService.getForecast;
  try {
    // Every failure inside weatherService.getForecast returns null: missing
    // key, budget refusal, non-ok status, unreachable upstream, malformed
    // body. There is no shape in which a failure can arrive looking like a
    // forecast, which is why this source never had the events bug.
    weatherService.getForecast = async () => null;
    const facts = await aroundYou(freshCtx(), 90801);
    assert.equal(facts.filter((f) => !advisorFacts.isRefusal(f) && f.source === 'weather').length, 0,
      'no weather fact may be built from a weather outage');
    assert.ok(byId(facts, 'refuse_weather_unavailable'));
  } finally {
    weatherService.getForecast = realForecast;
  }
});
