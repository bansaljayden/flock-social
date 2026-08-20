// ---------------------------------------------------------------------------
// Nightly context snapshots — the why-layer's memory of the day.
//
// WHAT THIS DOES. Every sweep, for each city that contains a verified claimed
// venue, it persists the two context signals that currently evaporate:
//
//   * EVENTS — once per city per local day, tonight's and the next week's
//     Ticketmaster listings go into the EXISTING ml_events table, through the
//     same insert shape scripts/ml/collectEvents.js uses. Ticketmaster drops
//     past events from its API, so any night not captured in advance has no
//     event answer, ever. The 8-day forward window means each night gets ~8
//     chances to be captured before it happens, so one missed run costs
//     nothing.
//   * WEATHER — across the local service day (07:00-23:59), one reading per
//     city per hour into night_context (migration 034), through the SAME
//     budgeted, coalesced weatherService.getWeather path every other caller
//     uses. Roost serves any venue type, breakfast cafes included, so the
//     window covers the whole trading day, not just bar hours. The budget
//     arithmetic lives at SNAPSHOT_START_HOUR below.
//
// SCHEDULING. server.js registers runNightContextSweep on an interval beside
// crowdAlertsInterval, gated on nightContextEnabled() (NIGHT_CONTEXT_ENABLED,
// default ON — the job is cheap and pure-write). The 30-minute cadence hits
// every snapshot hour at least once; the second tick inside an hour lands on
// weatherService's 30-minute cache, so it refreshes the row without a second
// vendor call.
//
// IDEMPOTENCY, in three layers, because "re-run upserts, never duplicates" is
// the contract:
//   * weather rows upsert on (city, night, hour);
//   * event rows upsert on ticketmaster_id — same key collectEvents relies on,
//     except this writer updates on conflict where collectEvents ignores: a
//     nightly snapshot must track postponements and lineup changes, a one-off
//     historical backfill did not have to;
//   * the once-per-day event fetch is claimed in night_context_runs with
//     INSERT ... ON CONFLICT DO NOTHING before any paid call (the
//     crowd_alert_sends idiom, migration 007), so a second instance or a
//     mid-evening deploy cannot double-spend. On a failed fetch the claim is
//     deleted so the next tick retries; a crash between claim and completion
//     loses at most one day's fetch for one city, which the 8-day window has
//     already covered from the day before.
//
// BUDGET. Weather is charged by weatherService itself. Ticketmaster is charged
// here against a small process-local day ledger (NC_TM_DAILY below).
// routes/events.js holds the interactive budget (global 2000/day) as
// module-private state with no production export — its __test hooks are
// explicitly not for server code — so this job cannot ride that ledger without
// widening the route's surface. Instead it keeps its own ceiling small enough
// that both together stay far under the vendor's 5K/day: 2000 + 200 = 2200.
// A sweep needs at most ~5 calls per city per day; 200 is generous headroom,
// not an ambition.
//
// FAILURE CONTRACT: this never throws to its caller. Every upstream and every
// query failure is logged and skipped; a missing row means "we were not
// watching", which the advisor states honestly, and the next tick or the next
// night tries again.
// ---------------------------------------------------------------------------

const pool = require('../config/database');
const { getWeather } = require('./weatherService');
const { CITIES } = require('../scripts/ml/config');

const NIGHT_CONTEXT_INTERVAL_MS = 30 * 60 * 1000;
// The snapshot window is the full service day — Roost serves any venue type,
// and a breakfast cafe's dead Tuesday morning is as real a why-question as a
// bar's dead Friday night.
//
// BUDGET ARITHMETIC, kept next to the constants it justifies: 17 hourly
// slots (7..23) x at most 2 sweep ticks per slot = 34 getWeather calls per
// city per day worst case, and the second tick of a slot rides
// weatherService's 30-minute cache in all but clock-edge cases, so ~17
// typical. Against the shared WX_DAILY of 950: one city 17-34/day (2-4%),
// two cities 34-68 (4-7%), five cities 85-170 (9-18%). Today's resolved city
// count is one or two, so hourly across the whole day fits comfortably. If
// the watched-city count ever nears ten (170-340/day, up to a third of a
// budget shared with live crowd scoring), thin the hours OUTSIDE 17:00-23:00
// to every 2h before raising any ceiling.
const SNAPSHOT_START_HOUR = 7;
const SNAPSHOT_END_HOUR = 23; // inclusive; 07:00-23:59 local
const EVENTS_WINDOW_DAYS = 8;
const MAX_EVENT_PAGES = 5; // same cap as collectEvents.fetchCityWindow

// Default ON: absent, empty, or anything not an explicit "off" enables it.
function nightContextEnabled() {
  const v = String(process.env.NIGHT_CONTEXT_ENABLED ?? '').trim().toLowerCase();
  return !['false', '0', 'off', 'no'].includes(v);
}

// ---------------------------------------------------------------------------
// Ticketmaster day ledger — same rollover shape as routes/events.js
// rollGlobalDay: the roll runs before every read, so a capped day cannot
// leave the ledger permanently "full" (the outage that pattern fixed there).
// ---------------------------------------------------------------------------
const NC_TM_DAILY = 200;
let ncTmDayKey = new Date().toISOString().slice(0, 10);
let ncTmDayCount = 0;

function allowTmCall() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== ncTmDayKey) { ncTmDayKey = today; ncTmDayCount = 0; }
  if (ncTmDayCount >= NC_TM_DAILY) return false;
  ncTmDayCount++; // charged BEFORE the fetch — an aborted paid call still bills
  return true;
}

// ---------------------------------------------------------------------------
// City wall clock. CITIES carries each key's IANA zone; Intl gives the local
// date and hour without trusting the server's own timezone. Returns null on an
// invalid zone so the caller skips the city instead of writing rows stamped
// with the wrong night.
// ---------------------------------------------------------------------------
function cityWallClock(timeZone, at) {
  try {
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    });
    const f = {};
    for (const p of dtf.formatToParts(at)) f[p.type] = p.value;
    const hour = parseInt(f.hour, 10);
    if (!f.year || !f.month || !f.day || Number.isNaN(hour)) return null;
    return { night: `${f.year}-${f.month}-${f.day}`, hour: hour === 24 ? 0 : hour };
  } catch {
    return null;
  }
}

// Minutes to ADD to UTC to reach local time — the offsetMinutesForZone shape
// from services/crowdAlerts.js, used here to find local midnight in UTC so the
// event window starts at the top of the city's day, not the server's.
function offsetMinutesForZone(timeZone, at) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const f = {};
    for (const p of dtf.formatToParts(at)) f[p.type] = p.value;
    const asUTC = Date.UTC(+f.year, +f.month - 1, +f.day, +f.hour, +f.minute, +f.second);
    if (Number.isNaN(asUTC)) return null;
    return Math.round((asUTC - at.getTime()) / 60000);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Which cities to watch: every CITIES key that holds a verified claimed venue
// present in the corpus, plus NIGHT_CONTEXT_CITIES (comma-separated CITIES
// keys) for claimed venues OUTSIDE ml_venues — which migration 030 documents
// as the modal case. venue_profiles stores no coordinates, so a non-corpus
// venue cannot be mapped to a city automatically; the env override is the
// honest escape hatch rather than a geocoding guess.
// ---------------------------------------------------------------------------
async function resolveCities() {
  const keys = new Set();
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT v.city
         FROM venue_profiles vp
         JOIN ml_venues v ON v.google_place_id = vp.google_place_id
        WHERE vp.verified = true`
    );
    for (const r of rows) {
      if (CITIES[r.city]) keys.add(r.city);
      else console.warn(`[NightContext] city ${r.city} not in CITIES config — skipped`);
    }
  } catch (err) {
    console.error('[NightContext] city lookup failed:', err.message);
  }
  const extra = String(process.env.NIGHT_CONTEXT_CITIES || '').split(',');
  for (const raw of extra) {
    const k = raw.trim();
    if (!k) continue;
    if (CITIES[k]) keys.add(k);
    else console.warn(`[NightContext] NIGHT_CONTEXT_CITIES key ${k} not in CITIES config — skipped`);
  }
  return [...keys];
}

// ---------------------------------------------------------------------------
// Weather half. Rides getWeather completely: its cache, its coalescing, its
// daily/minute ceilings, its null-on-anything-wrong contract. A null here is
// a refusal or an outage; the hour simply stays unwritten.
// ---------------------------------------------------------------------------
async function snapshotWeather(cityKey, clock) {
  if (clock.hour < SNAPSHOT_START_HOUR || clock.hour > SNAPSHOT_END_HOUR) return false;
  const { lat, lon } = CITIES[cityKey];
  const reading = await getWeather(lat, lon);
  if (!reading) return false;
  // Latest reading inside the hour wins: a 17:35 refresh replaces 17:05.
  // Both are actuals for hour 17; fresher is strictly better.
  await pool.query(
    `INSERT INTO night_context
       (city, night, hour, temp, feels_like, humidity, wind_speed,
        conditions, condition_code, is_raining, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11 / 1000.0))
     ON CONFLICT (city, night, hour) DO UPDATE SET
       temp = EXCLUDED.temp,
       feels_like = EXCLUDED.feels_like,
       humidity = EXCLUDED.humidity,
       wind_speed = EXCLUDED.wind_speed,
       conditions = EXCLUDED.conditions,
       condition_code = EXCLUDED.condition_code,
       is_raining = EXCLUDED.is_raining,
       observed_at = EXCLUDED.observed_at`,
    [cityKey, clock.night, clock.hour,
     reading.temp, reading.feelsLike, reading.humidity, reading.windSpeed,
     String(reading.conditions || '').slice(0, 100), reading.conditionId,
     reading.isRaining, reading.fetchedAt]
  );
  return true;
}

// ---------------------------------------------------------------------------
// Events half. Field derivation below (mapEventType / estimateAttendance /
// estimateEndHour) mirrors scripts/ml/collectEvents.js so the rows this job
// writes are indistinguishable in shape from the corpus-era ones. That script
// cannot be require()d — it opens its own pool and runs main() at module load
// — which is why the functions are duplicated rather than imported. If the
// derivation ever changes, change BOTH.
// ---------------------------------------------------------------------------
const TM_BASE = 'https://app.ticketmaster.com/discovery/v2/events.json';

function mapEventType(classifications) {
  if (!classifications || !classifications.length) return 'other';
  const seg = (classifications[0].segment?.name || '').toLowerCase();
  if (seg.includes('music')) return 'music';
  if (seg.includes('sport')) return 'sports';
  if (seg.includes('arts') || seg.includes('theatre')) return 'arts';
  if (seg.includes('family')) return 'family';
  return 'other';
}

function estimateAttendance(event) {
  const venues = event._embedded?.venues || [];
  for (const v of venues) {
    const cap = parseInt(v.generalInfo?.capacity, 10) ||
                parseInt(v.boxOfficeInfo?.capacity, 10) || 0;
    if (cap > 0) return cap;
  }
  const type = mapEventType(event.classifications);
  const venueName = (venues[0]?.name || '').toLowerCase();
  const isArena = venueName.includes('arena') || venueName.includes('stadium') ||
                  venueName.includes('center') || venueName.includes('centre') ||
                  venueName.includes('garden') || venueName.includes('field');
  if (type === 'sports') return isArena ? 25000 : 5000;
  if (type === 'music') {
    if (isArena) return 20000;
    if (venueName.includes('theater') || venueName.includes('theatre')) return 3000;
    return 500;
  }
  if (type === 'arts') return 1500;
  if (type === 'family') return 1000;
  return 500;
}

function estimateEndHour(startHour, type) {
  const durations = { music: 3, sports: 3, arts: 2, family: 3, other: 3 };
  return (startHour + (durations[type] || 3)) % 24;
}

function toTmDate(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function fetchEventPage(lat, lon, startDt, endDt, page) {
  const params = new URLSearchParams({
    apikey: process.env.TICKETMASTER_API_KEY,
    latlong: `${lat},${lon}`,
    radius: '30',
    unit: 'km',
    startDateTime: startDt,
    endDateTime: endDt,
    size: '200',
    page: String(page),
    sort: 'date,asc',
  });
  // Same 15s deadline as collectEvents: a hung Ticketmaster must not stall the
  // sweep. No 429 self-retry here — a background job retries next tick via the
  // released claim, so an immediate paid retry buys nothing.
  const response = await fetch(`${TM_BASE}?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    throw new Error(`Ticketmaster ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return {
    events: data._embedded?.events || [],
    totalPages: data.page?.totalPages || 0,
  };
}

async function upsertEvents(events, cityKey) {
  let written = 0;
  for (const e of events) {
    const venueLat = parseFloat(e._embedded?.venues?.[0]?.location?.latitude) || null;
    const venueLng = parseFloat(e._embedded?.venues?.[0]?.location?.longitude) || null;
    if (!venueLat || !venueLng) continue;
    const localDate = e.dates?.start?.localDate || null;
    if (!localDate) continue;
    const localTime = e.dates?.start?.localTime || '19:00:00';
    const startHour = parseInt(localTime.split(':')[0], 10) || 19;
    const type = mapEventType(e.classifications);
    try {
      await pool.query(
        `INSERT INTO ml_events (ticketmaster_id, name, city, venue_name, venue_lat, venue_lng,
           event_date, event_start_hour, event_end_hour, event_type, estimated_attendance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (ticketmaster_id) DO UPDATE SET
           name = EXCLUDED.name,
           event_date = EXCLUDED.event_date,
           event_start_hour = EXCLUDED.event_start_hour,
           event_end_hour = EXCLUDED.event_end_hour,
           estimated_attendance = EXCLUDED.estimated_attendance`,
        [e.id, (e.name || '').substring(0, 500), cityKey,
         (e._embedded?.venues?.[0]?.name || '').substring(0, 255),
         venueLat, venueLng, localDate, startHour, estimateEndHour(startHour, type),
         type, estimateAttendance(e)]
      );
      written++;
    } catch (err) {
      console.error(`[NightContext] ml_events upsert failed for ${e.id}:`, err.message);
    }
  }
  return written;
}

async function snapshotEvents(cityKey, clock, at) {
  // Key check BEFORE the claim: claiming a run we cannot make would mark the
  // night done and silence tomorrow's retry.
  if (!process.env.TICKETMASTER_API_KEY) {
    if (!warnedNoTmKey) {
      console.warn('[NightContext] TICKETMASTER_API_KEY not set — event snapshots off');
      warnedNoTmKey = true;
    }
    return false;
  }

  const { rowCount } = await pool.query(
    `INSERT INTO night_context_runs (city, night, kind)
     VALUES ($1, $2, 'events')
     ON CONFLICT DO NOTHING`,
    [cityKey, clock.night]
  );
  if (rowCount !== 1) return false; // another tick, instance, or deploy already has today

  try {
    const { lat, lon, tz } = CITIES[cityKey];
    // Window opens at the CITY's midnight so events earlier tonight are
    // included even when the sweep first fires late in the local day.
    const offsetMin = offsetMinutesForZone(tz, at) ?? 0;
    const windowStart = new Date(Date.parse(`${clock.night}T00:00:00Z`) - offsetMin * 60000);
    const windowEnd = new Date(windowStart.getTime() + EVENTS_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    let written = 0;
    let page = 0;
    let totalPages = 1;
    while (page < totalPages && page < MAX_EVENT_PAGES) {
      if (!allowTmCall()) throw new Error('night-context Ticketmaster ledger exhausted');
      const result = await fetchEventPage(lat, lon, toTmDate(windowStart), toTmDate(windowEnd), page);
      written += await upsertEvents(result.events, cityKey);
      totalPages = result.totalPages;
      page++;
    }

    await pool.query(
      `UPDATE night_context_runs SET ok = true, ran_at = NOW()
        WHERE city = $1 AND night = $2 AND kind = 'events'`,
      [cityKey, clock.night]
    );
    console.log(`[NightContext] ${cityKey} ${clock.night}: ${written} events snapshotted`);
    return true;
  } catch (err) {
    console.error(`[NightContext] event snapshot failed for ${cityKey}:`, err.message);
    // Release the claim so the next tick retries; without this one blip
    // blanks the whole night. Bounded by the day ledger above.
    try {
      await pool.query(
        `DELETE FROM night_context_runs
          WHERE city = $1 AND night = $2 AND kind = 'events' AND ok = false`,
        [cityKey, clock.night]
      );
    } catch (delErr) {
      console.error('[NightContext] claim release failed:', delErr.message);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// The sweep. Registered by server.js on NIGHT_CONTEXT_INTERVAL_MS. Never
// throws; a re-entrancy latch keeps a slow upstream from stacking sweeps.
// `now` is injectable for tests only — production callers pass nothing.
// ---------------------------------------------------------------------------
let sweepInFlight = false;
let warnedNoTmKey = false;

async function runNightContextSweep(now) {
  if (!nightContextEnabled()) return;
  if (sweepInFlight) return;
  sweepInFlight = true;
  const at = now instanceof Date ? now : new Date();
  try {
    const cities = await resolveCities();
    for (const cityKey of cities) {
      const clock = cityWallClock(CITIES[cityKey].tz, at);
      if (!clock) {
        console.warn(`[NightContext] no wall clock for ${cityKey} — skipped`);
        continue;
      }
      try {
        await snapshotEvents(cityKey, clock, at);
      } catch (err) {
        console.error(`[NightContext] events sweep error for ${cityKey}:`, err.message);
      }
      try {
        await snapshotWeather(cityKey, clock);
      } catch (err) {
        console.error(`[NightContext] weather sweep error for ${cityKey}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[NightContext] sweep failed:', err?.message || err);
  } finally {
    sweepInFlight = false;
  }
}

// Non-consuming read of this job's own Ticketmaster day ledger, for the admin
// cost panel (services/costModel.js). Separate from routes/events.js's
// interactive ledger on purpose: the two are sized against each other so that
// together they stay under the vendor's 5,000-a-day free tier, and a panel that
// added them into one number would hide which half was moving. In-process, so
// it reads zero after a deploy.
function nightContextBudgetStatus() {
  return {
    day: ncTmDayKey,
    globalUsed: ncTmDayCount,
    globalRemaining: Math.max(0, NC_TM_DAILY - ncTmDayCount),
    limits: { globalDaily: NC_TM_DAILY },
    inMemory: true,
  };
}

module.exports = {
  runNightContextSweep,
  nightContextEnabled,
  NIGHT_CONTEXT_INTERVAL_MS,
  nightContextBudgetStatus,
};

// Test hooks only — process-wide in-memory state needs a clean start per case.
// Nothing in the server calls this.
module.exports.__test = {
  reset() {
    sweepInFlight = false;
    warnedNoTmKey = false;
    ncTmDayCount = 0;
    ncTmDayKey = new Date().toISOString().slice(0, 10);
  },
  forceTmLedger(dayKey, count) { ncTmDayKey = dayKey; ncTmDayCount = count; },
  tmSpent: () => ncTmDayCount,
  cityWallClock,
  offsetMinutesForZone,
  SNAPSHOT_START_HOUR,
  SNAPSHOT_END_HOUR,
  NC_TM_DAILY,
};
