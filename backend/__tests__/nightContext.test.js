// Run: node --test  (from backend/)
//
// The nightly context snapshot — the why-layer's memory of the evening.
//
// What is pinned here, and why each pin exists:
//
//   1. IDEMPOTENCY IS THE CONTRACT. The sweep fires every 30 minutes, restarts
//      on every deploy, and may run on two instances at once. A re-run must
//      upsert, never duplicate: weather rows carry ON CONFLICT (city, night,
//      hour), event rows ride ml_events' ticketmaster_id key, and the
//      once-per-city-per-day Ticketmaster fetch is claimed in
//      night_context_runs BEFORE any paid call (the crowd_alert_sends idiom).
//      A second sweep in the same evening must make ZERO extra Ticketmaster
//      calls and zero extra OpenWeatherMap calls.
//   2. FAILURE NEVER CRASHES THE SERVER. The sweep runs inside setInterval in
//      server.js; an unhandled rejection there is a process crash on a timer.
//      Every upstream failure and every database failure must resolve, and a
//      failed event fetch must RELEASE its claim so the next tick retries —
//      otherwise one Ticketmaster blip blanks a whole night forever, which is
//      the exact permanent blindness this job exists to end.
//   3. THE SCHEDULE IS REAL. A job that exists but was never registered is the
//      current state of collectEvents.js (hand-run, stale since May). The
//      server.js source is pinned: the interval is registered beside
//      crowdAlertsInterval, gated on NIGHT_CONTEXT_ENABLED (default ON), and
//      cleared in shutdown() so a sweep cannot fire into a closing pool.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.WEATHER_API_KEY = 'night-context-test-owm-key';
process.env.TICKETMASTER_API_KEY = 'night-context-test-tm-key';
delete process.env.NIGHT_CONTEXT_ENABLED;
delete process.env.NIGHT_CONTEXT_CITIES;

const pool = require('../config/database');
const weatherService = require('../services/weatherService');
const nightContext = require('../services/nightContext');
const { runNightContextSweep, nightContextEnabled, NIGHT_CONTEXT_INTERVAL_MS } = nightContext;

// ---------------------------------------------------------------------------
// Fake database. Stateful where the contract is stateful: the
// night_context_runs claim emulates ON CONFLICT DO NOTHING with a Set, so the
// test exercises the same win-once semantics production gets from the primary
// key. Everything else is logged and answered empty.
// ---------------------------------------------------------------------------
const db = {
  log: [],
  claims: new Set(),
  cities: [{ city: 'lehigh' }],
  down: false,
  reset() {
    this.log = [];
    this.claims.clear();
    this.cities = [{ city: 'lehigh' }];
    this.down = false;
  },
  rows(re) {
    return this.log.filter((q) => re.test(q.sql));
  },
};

pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  if (db.down) return Promise.reject(new Error('connection terminated'));
  db.log.push({ sql: flat, params: params || [] });
  if (/FROM venue_profiles vp/.test(flat)) {
    return Promise.resolve({ rows: db.cities, rowCount: db.cities.length });
  }
  if (/INSERT INTO night_context_runs/.test(flat)) {
    const key = `${params[0]}|${params[1]}`;
    if (db.claims.has(key)) return Promise.resolve({ rows: [], rowCount: 0 });
    db.claims.add(key);
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (/DELETE FROM night_context_runs/.test(flat)) {
    db.claims.delete(`${params[0]}|${params[1]}`);
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

// ---------------------------------------------------------------------------
// Fake upstreams, keyed by host. Counters are the budget assertions: a test
// that only inspects rows cannot see a double-spend that upserted quietly.
// ---------------------------------------------------------------------------
const upstream = {
  owmCalls: 0,
  tmCalls: 0,
  owmFail: false,
  tmFail: false,
  reset() {
    this.owmCalls = 0;
    this.tmCalls = 0;
    this.owmFail = false;
    this.tmFail = false;
  },
};

const tmEvent = {
  id: 'tmEvt1',
  name: 'Test Concert',
  _embedded: {
    venues: [{ name: 'Steel Arena', location: { latitude: '40.60', longitude: '-75.47' } }],
  },
  dates: { start: { localDate: '2026-08-14', localTime: '20:00:00' } },
  classifications: [{ segment: { name: 'Music' } }],
};

global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('openweathermap.org')) {
    upstream.owmCalls++;
    if (upstream.owmFail) return { ok: false, status: 503, statusText: 'Service Unavailable' };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        main: { temp: 71.2, feels_like: 73.0, humidity: 62 },
        wind: { speed: 4.5 },
        weather: [{ main: 'Rain', description: 'light rain', id: 500 }],
      }),
    };
  }
  if (u.includes('ticketmaster.com')) {
    upstream.tmCalls++;
    if (upstream.tmFail) throw new Error('socket hang up');
    return {
      ok: true,
      status: 200,
      json: async () => ({ _embedded: { events: [tmEvent] }, page: { totalPages: 1 } }),
    };
  }
  throw new Error(`unexpected fetch: ${u}`);
};

function freshStart() {
  db.reset();
  upstream.reset();
  weatherService.__resetWeatherState();
  nightContext.__test.reset();
  delete process.env.NIGHT_CONTEXT_ENABLED;
  delete process.env.NIGHT_CONTEXT_CITIES;
}

// 2026-08-14T23:30:00Z is Friday 19:30 in America/New_York (lehigh) — inside
// the 17:00-23:59 evening window. Injected so the test does not depend on the
// machine's clock or zone.
const FRIDAY_EVENING = new Date('2026-08-14T23:30:00Z');
const FRIDAY_NOON = new Date('2026-08-14T16:00:00Z'); // 12:00 EDT — outside the window

// ---------------------------------------------------------------------------
test('a sweep persists tonight\'s events into ml_events and the evening reading into night_context', async () => {
  freshStart();
  await runNightContextSweep(FRIDAY_EVENING);

  // Events: written through the existing ml_events shape, upsert-keyed on
  // ticketmaster_id, with collectEvents' field derivation (music at an arena
  // estimates 20000, three-hour duration ends at 23).
  const evWrites = db.rows(/INSERT INTO ml_events/);
  assert.strictEqual(evWrites.length, 1);
  assert.match(evWrites[0].sql, /ON CONFLICT \(ticketmaster_id\) DO UPDATE/);
  const [tmId, evName, city, venueName, , , evDate, startHour, endHour, evType, attendance] = evWrites[0].params;
  assert.strictEqual(tmId, 'tmEvt1');
  assert.strictEqual(evName, 'Test Concert');
  assert.strictEqual(city, 'lehigh');
  assert.strictEqual(venueName, 'Steel Arena');
  assert.strictEqual(evDate, '2026-08-14');
  assert.strictEqual(startHour, 20);
  assert.strictEqual(endHour, 23);
  assert.strictEqual(evType, 'music');
  assert.strictEqual(attendance, 20000);

  // The claim was taken before the paid call and marked ok after it.
  assert.strictEqual(db.rows(/INSERT INTO night_context_runs/).length, 1);
  assert.match(db.rows(/INSERT INTO night_context_runs/)[0].sql, /ON CONFLICT DO NOTHING/);
  assert.strictEqual(db.rows(/UPDATE night_context_runs SET ok = true/).length, 1);

  // Weather: one row for (lehigh, 2026-08-14, 19), imperial reading intact.
  const wxWrites = db.rows(/INSERT INTO night_context \(/);
  assert.strictEqual(wxWrites.length, 1);
  assert.match(wxWrites[0].sql, /ON CONFLICT \(city, night, hour\) DO UPDATE/);
  const [wCity, night, hour, temp, feelsLike, humidity, windSpeed, conditions, code, raining] = wxWrites[0].params;
  assert.strictEqual(wCity, 'lehigh');
  assert.strictEqual(night, '2026-08-14');
  assert.strictEqual(hour, 19);
  assert.strictEqual(temp, 71.2);
  assert.strictEqual(feelsLike, 73.0);
  assert.strictEqual(humidity, 62);
  assert.strictEqual(windSpeed, 4.5);
  assert.strictEqual(conditions, 'light rain');
  assert.strictEqual(code, 500);
  assert.strictEqual(raining, true);

  assert.strictEqual(upstream.tmCalls, 1);
  assert.strictEqual(upstream.owmCalls, 1);
});

// ---------------------------------------------------------------------------
test('a second sweep in the same evening spends nothing: the claim blocks Ticketmaster and the cache absorbs weather', async () => {
  freshStart();
  await runNightContextSweep(FRIDAY_EVENING);
  await runNightContextSweep(new Date(FRIDAY_EVENING.getTime() + 5 * 60 * 1000));

  // One paid Ticketmaster fetch for the night, full stop. The second sweep's
  // claim insert lost the ON CONFLICT race against the first.
  assert.strictEqual(upstream.tmCalls, 1);
  assert.strictEqual(db.rows(/INSERT INTO ml_events/).length, 1);

  // One paid OpenWeatherMap call: the second sweep, five minutes later, rode
  // weatherService's 30-minute cache. The weather ROW is refreshed both times
  // — that is the upsert doing its job, not a duplicate: same (city, night,
  // hour) key, ON CONFLICT ... DO UPDATE.
  assert.strictEqual(upstream.owmCalls, 1);
  const wxWrites = db.rows(/INSERT INTO night_context \(/);
  assert.strictEqual(wxWrites.length, 2);
  assert.deepStrictEqual(
    wxWrites.map((w) => [w.params[0], w.params[1], w.params[2]]),
    [['lehigh', '2026-08-14', 19], ['lehigh', '2026-08-14', 19]]
  );
  for (const w of wxWrites) assert.match(w.sql, /ON CONFLICT \(city, night, hour\) DO UPDATE/);
});

// ---------------------------------------------------------------------------
test('a Ticketmaster failure releases the claim, spares the weather half, and the next tick recovers', async () => {
  freshStart();
  upstream.tmFail = true;
  await runNightContextSweep(FRIDAY_EVENING); // must resolve, not throw

  // The claim was taken, the fetch failed, the claim was handed back.
  assert.strictEqual(db.rows(/DELETE FROM night_context_runs/).length, 1);
  assert.strictEqual(db.claims.size, 0);
  assert.strictEqual(db.rows(/UPDATE night_context_runs SET ok = true/).length, 0);
  assert.strictEqual(db.rows(/INSERT INTO ml_events/).length, 0);

  // The evening reading landed anyway — one half failing must not blind the other.
  assert.strictEqual(db.rows(/INSERT INTO night_context \(/).length, 1);

  // Upstream recovers; the next tick re-claims and completes the night.
  upstream.tmFail = false;
  await runNightContextSweep(new Date(FRIDAY_EVENING.getTime() + 30 * 60 * 1000));
  assert.strictEqual(db.rows(/INSERT INTO ml_events/).length, 1);
  assert.strictEqual(db.rows(/UPDATE night_context_runs SET ok = true/).length, 1);
});

// ---------------------------------------------------------------------------
test('a weather outage writes no row and no fabricated reading; events are unaffected', async () => {
  freshStart();
  upstream.owmFail = true;
  await runNightContextSweep(FRIDAY_EVENING);

  // No reading, no row. A missing hour means "we were not watching", which the
  // advisor can say honestly; a placeholder row would be a fabricated actual.
  assert.strictEqual(db.rows(/INSERT INTO night_context \(/).length, 0);
  assert.strictEqual(db.rows(/INSERT INTO ml_events/).length, 1);
});

// ---------------------------------------------------------------------------
test('outside the 17:00-23:59 local window no weather row is written, but the daily event snapshot still runs', async () => {
  freshStart();
  await runNightContextSweep(FRIDAY_NOON);

  assert.strictEqual(db.rows(/INSERT INTO night_context \(/).length, 0);
  assert.strictEqual(upstream.owmCalls, 0);
  assert.strictEqual(db.rows(/INSERT INTO ml_events/).length, 1);
});

// ---------------------------------------------------------------------------
test('a database outage resolves quietly — the sweep can never crash the server it rides in', async () => {
  freshStart();
  db.down = true;
  await assert.doesNotReject(runNightContextSweep(FRIDAY_EVENING));
  assert.strictEqual(upstream.tmCalls, 0);
  assert.strictEqual(upstream.owmCalls, 0);
});

// ---------------------------------------------------------------------------
test('the job\'s own Ticketmaster ledger refuses before the vendor is called, and hands the claim back', async () => {
  freshStart();
  nightContext.__test.forceTmLedger(new Date().toISOString().slice(0, 10), nightContext.__test.NC_TM_DAILY);
  await runNightContextSweep(FRIDAY_EVENING);

  assert.strictEqual(upstream.tmCalls, 0);
  assert.strictEqual(db.rows(/DELETE FROM night_context_runs/).length, 1);
  assert.strictEqual(db.claims.size, 0);
});

// ---------------------------------------------------------------------------
test('NIGHT_CONTEXT_ENABLED defaults on and only an explicit off turns it off; disabled means zero queries', async () => {
  freshStart();

  for (const v of [undefined, '', 'true', '1', 'yes', 'anything']) {
    if (v === undefined) delete process.env.NIGHT_CONTEXT_ENABLED;
    else process.env.NIGHT_CONTEXT_ENABLED = v;
    assert.strictEqual(nightContextEnabled(), true, `expected enabled for ${JSON.stringify(v)}`);
  }
  for (const v of ['false', '0', 'off', 'no', ' FALSE ']) {
    process.env.NIGHT_CONTEXT_ENABLED = v;
    assert.strictEqual(nightContextEnabled(), false, `expected disabled for ${JSON.stringify(v)}`);
  }

  process.env.NIGHT_CONTEXT_ENABLED = 'false';
  await runNightContextSweep(FRIDAY_EVENING);
  assert.strictEqual(db.log.length, 0);
  assert.strictEqual(upstream.tmCalls + upstream.owmCalls, 0);
});

// ---------------------------------------------------------------------------
test('NIGHT_CONTEXT_CITIES adds a non-corpus city; unknown keys and unknown DB cities are skipped, not thrown', async () => {
  freshStart();
  db.cities = [{ city: 'atlantis' }]; // a DB city not in CITIES config
  process.env.NIGHT_CONTEXT_CITIES = 'philly, notacity';
  await runNightContextSweep(FRIDAY_EVENING);

  // philly (America/New_York, same instant → 19:30) ran both halves; atlantis
  // and notacity produced nothing and broke nothing.
  const evWrites = db.rows(/INSERT INTO ml_events/);
  assert.strictEqual(evWrites.length, 1);
  assert.strictEqual(evWrites[0].params[2], 'philly');
  const wxWrites = db.rows(/INSERT INTO night_context \(/);
  assert.strictEqual(wxWrites.length, 1);
  assert.strictEqual(wxWrites[0].params[0], 'philly');
});

// ---------------------------------------------------------------------------
// The wiring pin. server.js is the only file allowed to register the sweep,
// and these are the exact properties that make the registration safe: gated,
// beside crowdAlertsInterval, and cleared on shutdown. If someone renames the
// handles or drops the gate, this fails with the reason in the assertion.
// ---------------------------------------------------------------------------
test('server.js registers the sweep beside crowdAlertsInterval, env-gated, and clears it on shutdown', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  assert.match(src, /require\('\.\/services\/nightContext'\)/,
    'server.js must require services/nightContext');
  assert.match(src, /if \(nightContextEnabled\(\)\)/,
    'the registration must be gated on nightContextEnabled()');
  assert.match(src, /nightContextInterval = setInterval\(runNightContextSweep, NIGHT_CONTEXT_INTERVAL_MS\)/,
    'the interval must run runNightContextSweep on the exported cadence');
  assert.match(src, /nightContextKickoff = setTimeout\(runNightContextSweep,/,
    'a kickoff run must fire shortly after boot');
  assert.match(src, /if \(nightContextInterval\) clearInterval\(nightContextInterval\);/,
    'shutdown() must clear the interval so a sweep cannot fire into a closing pool');
  assert.match(src, /if \(nightContextKickoff\) clearTimeout\(nightContextKickoff\);/,
    'shutdown() must clear the kickoff timer too');

  // The registration lives in boot(), after listen — the same lifecycle as
  // crowdAlertsInterval, whose handles are declared right beside these.
  const declBlock = src.indexOf('let nightContextInterval = null;');
  const crowdDecl = src.indexOf('let crowdAlertsInterval = null;');
  assert.ok(declBlock > -1 && crowdDecl > -1 && declBlock > crowdDecl &&
    declBlock - crowdDecl < 200,
    'the timer handles must be declared beside the crowdAlerts handles');

  // The cadence constant is exported, real, and sane: at most 30 minutes, so
  // every evening hour gets at least one reading.
  assert.ok(Number.isInteger(NIGHT_CONTEXT_INTERVAL_MS));
  assert.ok(NIGHT_CONTEXT_INTERVAL_MS <= 30 * 60 * 1000);
  assert.ok(NIGHT_CONTEXT_INTERVAL_MS >= 5 * 60 * 1000);
});
