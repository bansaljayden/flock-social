// ---------------------------------------------------------------------------
// A LIVE READING STORES THE EVENT VALUES SERVING COMPUTES FOR THE SAME LISTING.
//
// A census of the 8,006 live readings in the 2026-09-08 export found the two
// event-size columns (nearest_event_attendance, total_nearby_attendance) 0 on
// every row, and event_size never filled. The cause: the hourly collector
// sized an event only from the capacity Ticketmaster prints for its venue,
// which it almost never does, and it counted one event and took the nearest
// one that STARTED in the window. Serving, for the same listing, counts every
// event within 2 km that is ongoing at the hour and sizes each by the printed
// capacity or else a size class by segment and venue name
// (estimateTmAttendance). The model trained on zeros and was served the class.
//
// Both now run services/eventFeatures.buildEventResult over the listing's own
// entries. This drives the REAL collector path (eventService's Ticketmaster
// fetch against a stubbed Discovery answer, nearestEventFromAnswers,
// collectRealtime.eventFeatureColumns) and the REAL serving path
// (mlPredictor.getNearbyEvents against the same answer) over a random grid of
// listings and requires the six stored feature columns to equal what serving
// hands buildFeatureMap. mlContextFeatureParity.test.js then proves the Python
// turns those columns into the values buildFeatureMap turns serving's into.
//
// No network: global.fetch is replaced for the length of the test.
// Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-event-collection';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const eventService = require('../scripts/ml/eventService');
const { eventFeatureColumns } = require('../scripts/ml/collectRealtime');
const mlPredictor = require('../services/mlPredictor');
const I = mlPredictor._internals;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEGMENTS = ['Music', 'Sports', 'Arts & Theatre', 'Family', 'Film', 'Miscellaneous'];
const VENUE_NAMES = ['Wells Fargo Center', 'Citizens Bank Park', 'The Fillmore', 'Merriam Theater', 'Kimmel Hall', 'PPL Center', 'Musikfest Cafe', 'Madison Square Garden', 'Lincoln Financial Field', 'Corner Pub'];
const HOUR = 3600000;

function listing(r, lat, lng, atMs) {
  const n = Math.floor(r() * 6);
  const events = [];
  for (let k = 0; k < n; k++) {
    const km = 3 * r();
    const ang = 2 * Math.PI * r();
    const eLat = lat + (km / 111) * Math.cos(ang);
    const eLng = lng + (km / (111 * Math.cos(lat * Math.PI / 180))) * Math.sin(ang);
    const startMs = (Math.floor(atMs / HOUR) - 3 + Math.floor(r() * 4)) * HOUR + Math.floor(r() * 4) * 15 * 60000;
    const cap = r() < 0.15 ? String(500 + Math.floor(r() * 30000)) : undefined;
    events.push({
      name: `event ${k}`,
      classifications: [{ segment: { name: SEGMENTS[Math.floor(r() * SEGMENTS.length)] } }],
      dates: { start: r() < 0.1 ? {} : { dateTime: new Date(startMs).toISOString().replace(/\.\d{3}Z$/, 'Z') } },
      _embedded: { venues: [{
        name: VENUE_NAMES[Math.floor(r() * VENUE_NAMES.length)],
        location: { latitude: eLat.toFixed(6), longitude: eLng.toFixed(6) },
        ...(cap ? { generalInfo: { capacity: cap } } : {}),
      }] },
    });
  }
  return { _embedded: n ? { events } : undefined, page: { totalElements: n } };
}

test('the collector stores, on every live reading, the six event values serving computes from the same listing', async (t) => {
  const r = rng(20260930);
  const realFetch = global.fetch;
  const savedKey = process.env.TICKETMASTER_API_KEY;
  process.env.TICKETMASTER_API_KEY = 'collection-parity-key';
  const quiet = console.error;
  console.error = () => {};
  let body = null;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => body });
  let compared = 0;
  let withEvent = 0;
  let classSized = 0;
  let multi = 0;
  try {
    for (let k = 0; k < 400; k++) {
      const lat = 39.95 + (r() - 0.5) * 0.4;
      const lng = -75.16 + (r() - 0.5) * 0.4;
      const atMs = Date.UTC(2026, 8, 1 + Math.floor(r() * 28), Math.floor(r() * 24), Math.floor(r() * 60));
      const at = new Date(atMs);
      body = listing(r, lat, lng, atMs);

      // The collector: its own Ticketmaster fetch and mapping, the answer, the columns.
      const page = await eventService.fetchTicketmasterPage(lat, lng, eventService.NEARBY_KM, at);
      const answer = eventService.nearestEventFromAnswers(page.events, null, lat, lng, at);
      const stored = Object.fromEntries(eventFeatureColumns(answer));

      // Serving: the real lookup, from a clean cache and budget.
      I.__resetEventBudget();
      const served = await I.getNearbyEvents(lat, lng, at);
      assert.equal(served.observed, true);

      // What training reads: the export writes the stored columns, and
      // prepare_features fills an empty one with 0 (add_event_features).
      const train = {
        hasEvent: stored.has_nearby_event === true,
        totalEvents: stored.total_nearby_events ?? 0,
        totalAttendance: stored.total_nearby_attendance ?? 0,
        nearestAttendance: stored.nearest_event_attendance ?? 0,
        nearestDistance: stored.nearest_event_distance_km ?? 0,
        nearestType: stored.nearest_event_type ?? null,
      };
      const serve = {
        hasEvent: served.hasEvent, totalEvents: served.totalEvents, totalAttendance: served.totalAttendance,
        nearestAttendance: served.nearestAttendance, nearestDistance: served.nearestDistance, nearestType: served.nearestType,
      };
      assert.deepEqual(train, serve, `listing ${k}`);
      compared++;
      if (served.hasEvent) withEvent++;
      if (served.totalEvents > 1) multi++;
      if (served.hasEvent && !(body._embedded.events.some((e) => e._embedded.venues[0].generalInfo))) classSized++;
    }
  } finally {
    global.fetch = realFetch;
    console.error = quiet;
    if (savedKey === undefined) delete process.env.TICKETMASTER_API_KEY; else process.env.TICKETMASTER_API_KEY = savedKey;
    I.__resetEventBudget();
  }
  t.diagnostic(`${compared} listings: ${withEvent} with an event ongoing within 2 km, ${multi} with several, ${classSized} sized by class alone`);
  assert.ok(withEvent > 60 && multi > 10 && classSized > 30, 'the grid must reach events, several at once, and class-sized ones');
});

test('an unmeasured lookup writes NULL feature columns, and a listing it cannot replay keeps the old rules', () => {
  const none = Object.fromEntries(eventFeatureColumns({ observed: false, reason: 'lookup_failed' }));
  assert.deepEqual(Object.values(none), [null, null, null, null, null, null]);
  // A measured answer with no served values (SeatGeek only, or a test double).
  const old = Object.fromEntries(eventFeatureColumns({ observed: true, event_nearby: true, event_size: null, event_distance_km: 0.4, event_type: 'music' }));
  assert.deepEqual(old, { has_nearby_event: true, total_nearby_events: 1, total_nearby_attendance: null,
    nearest_event_attendance: null, nearest_event_distance_km: 0.4, nearest_event_type: 'music' });
  // eventService never replays a list whose entries do not carry the listing.
  assert.equal(eventService.servedEventValues([{ lat: 1, lon: 1 }], 1, 1, new Date()), null);
  assert.equal(eventService.servedEventValues(null, 1, 1, new Date()), null);
});
