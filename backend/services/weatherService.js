// ---------------------------------------------------------------------------
// OpenWeatherMap wrapper.
//
// IN-MEMORY STATE — READ THIS BEFORE TRUSTING THE NUMBERS.
//   The reading cache, the negative cache, the in-flight map and the upstream
//   spend counters all live in this process's heap. That means:
//     * They reset to zero on every Railway deploy, crash and restart. A day
//       with ten deploys has no 3000/day ceiling in any real sense; it has ten
//       fresh allowances, and a cold cache after each one (which is itself a
//       burst of paid calls right when a deploy is being watched).
//     * They divide by the instance count. Two instances = double the daily
//       spend and half the cache hit rate, silently.
//     * Nothing here races: the counters are read and written synchronously
//       inside one turn, and Node runs one turn at a time. That guarantee is
//       per process.
//
//   WHAT SHOULD MOVE TO POSTGRES: the daily counter, for the same reason as the
//   Places one (see utils/placesBudget.js) — it is denominated in money, and an
//   in-memory implementation cannot tell a deploy loop from having no cap. It
//   is a lower priority than the Places counter because OpenWeatherMap is the
//   cheaper vendor and the 30-minute cache absorbs most of the traffic.
//
//   HUMAN DECISION NEEDED: WX_DAILY below is 3000/day, which is ABOVE
//   OpenWeatherMap's free allowance (1,000 calls/day on the free plan). As
//   written, this module is willing to spend past free into billed usage.
//   Either lower WX_DAILY to sit under the plan we are actually on, or confirm
//   the paid plan and leave it. WX_PER_MINUTE is set under the free plan's
//   60 calls/minute so we get refusals we control instead of 429s we don't.
//
// CACHING CONTRACT: a stale reading is NEVER returned as current. A cached
// reading is served only inside CACHE_TTL, and every reading carries the
// `fetchedAt` it was observed at so a caller can say how old it is rather than
// implying "now". Results are frozen: the cache hands the same object to every
// caller, so one consumer mutating it would poison every later read.
//
// FAILURE CONTRACT: a weather outage returns null. That is the honest answer —
// "we have no weather" — and services/crowdEngine.js reads it correctly
// (getWeatherFactor contributes 0, confidence drops 15, and 'weather' is left
// out of dataSourcesUsed). See the note on WX_NEGATIVE_TTL for why failures are
// remembered briefly.
// ---------------------------------------------------------------------------

const { upstreamSignal } = require('../utils/upstream');

const weatherCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const MAX_CACHE_ENTRIES = 100;

// A failure is remembered for sixty seconds. Without this, an outage, a revoked
// key or a coordinate OpenWeatherMap has no data for is an uncached miss that
// re-charges the daily budget on every single request — the fastest way to burn
// a day's allowance is for the upstream to be broken. Sixty seconds collapses
// that from one paid call per request to one per coordinate per minute, roughly
// a hundredfold reduction, while staying short enough that a recovering
// upstream (or a transient vendor 429) is picked up almost immediately. A
// longer window would blank out weather for a coordinate well past the outage,
// which is the silent-degradation failure this file is trying to avoid.
const WX_NEGATIVE_TTL = 60 * 1000;

let warnedOnce = false;

function getCacheKey(lat, lon) {
  return `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;
}

// A coordinate that cannot be a coordinate must never reach the vendor. Without
// this, getWeather(undefined, undefined) built a URL containing lat=NaN, paid
// for the round trip, and got a 400 back — a charge for a question we knew was
// unanswerable before we asked it. Callers that validate their own input lose
// nothing; the ones that do not are the reason this is here.
function validCoords(lat, lon) {
  // Type-gate first. Number(null), Number(''), Number(false) and Number([]) are
  // all 0, which is a real coordinate (null island, in the Gulf of Guinea), so
  // a numeric check alone would happily pay to ask about the ocean every time a
  // caller had no location. "I have no coordinate" must not coerce into one.
  const ok = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== ''));
  if (!ok(lat) || !ok(lon)) return false;
  const a = Number(lat);
  const b = Number(lon);
  return Number.isFinite(a) && Number.isFinite(b) && a >= -90 && a <= 90 && b >= -180 && b <= 180;
}

// Returns the cache entry (which may be a remembered failure) or null for a
// genuine miss. A remembered failure and a miss are deliberately different
// things here: only the miss may spend money.
function getEntry(key) {
  const entry = weatherCache.get(key);
  if (!entry) return null;
  const ttl = entry.failed ? WX_NEGATIVE_TTL : CACHE_TTL;
  if (Date.now() - entry.ts < ttl) return entry;
  weatherCache.delete(key);
  return null;
}

function setCache(key, data, failed = false) {
  // Delete first so a refreshed key moves to the end of the Map's insertion
  // order. Map.set on an existing key keeps its original position, which meant
  // the oldest-first eviction below was evicting the most frequently refreshed
  // (i.e. hottest) keys.
  weatherCache.delete(key);
  weatherCache.set(key, { data, ts: Date.now(), failed });
  if (weatherCache.size > MAX_CACHE_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of weatherCache) {
      if (now - v.ts > (v.failed ? WX_NEGATIVE_TTL : CACHE_TTL)) weatherCache.delete(k);
    }
    // Fresh-but-oversized: evict oldest so coordinate spam can't grow it
    while (weatherCache.size > MAX_CACHE_ENTRIES) weatherCache.delete(weatherCache.keys().next().value);
  }
}

// ---------------------------------------------------------------------------
// Upstream spend budget (round 7: unique coordinates were unmetered misses).
//
// Both dimensions are GLOBAL, which is the known weakness: any single
// authenticated caller who can choose lat/lon — GET /api/weather is exactly
// that — can walk coordinates at 0.01 resolution and spend the whole daily
// allowance, denying weather to every crowd score for the rest of the day. The
// general limiter (300 req / 15 min) is far above WX_DAILY, so it does not help.
//
// The per-minute cap bounds how fast that can happen and keeps us under the
// vendor's rate limit. The proper fix is a per-user dimension, which needs a
// caller identity this function does not otherwise have: pass
// `{ userId: req.user.id }` as the third argument from routes/weather.js and
// the per-user ceiling below starts applying. Routes that derive coordinates
// from a venue (crowd, publicCrowd, venueDashboard) are not the enumeration
// surface and can keep calling with two arguments.
// ---------------------------------------------------------------------------
// WX_PER_MINUTE sits JUST UNDER OpenWeatherMap's documented 60 calls/minute.
// That specific number matters: at or above the vendor's own limit, a caller we
// refuse is a caller the vendor would have 429'd anyway, so the cap can never
// cost us a reading we would otherwise have gotten. It only converts an opaque
// vendor throttle into a refusal we can see, log and count. It is set at 55
// rather than 60 because their minute window and ours are not aligned.
//
// This matters for the ML collection scripts (scripts/ml/collectWeekly.js calls
// getWeather once per venue): a cap set below the vendor's limit would silently
// null out weather columns in training data collected against a limited
// BestTime quota, which is exactly the silent degradation this audit is about.
// Refusals are counted and logged (see wxRefused) so it can never be silent.
const WX_DAILY = 3000;
const WX_PER_MINUTE = 55;
const WX_PER_USER_HOURLY = 40; // only applied when a userId is supplied

let wxDayKey = new Date().toISOString().slice(0, 10);
let wxDayCount = 0;
let wxMinuteKey = 0;
let wxMinuteCount = 0;
let wxRefused = 0;
let lastRefusalLog = 0;
const wxUserHits = new Map(); // userId -> number[] of charge timestamps
const HOUR_MS = 60 * 60 * 1000;
const MAX_TRACKED_USERS = 20000;
const EVICT_TARGET = 18000;

// A refused fetch means a crowd score loses its weather factor. That must never
// be silent, or a degraded model looks like a model that got worse. Counted
// always, logged at most once a minute so an outage cannot flood the log.
function refuse(reason) {
  wxRefused++;
  const now = Date.now();
  if (now - lastRefusalLog > 60_000) {
    lastRefusalLog = now;
    console.warn(`[Weather] Upstream budget refused a fetch (${reason}); crowd scores are running without weather. Refused so far: ${wxRefused}`);
  }
  return false;
}

function allowWeatherFetch(userId) {
  const now = Date.now();

  const today = new Date().toISOString().slice(0, 10);
  if (today !== wxDayKey) { wxDayKey = today; wxDayCount = 0; wxRefused = 0; }
  if (wxDayCount >= WX_DAILY) return refuse('daily ceiling');

  const minute = Math.floor(now / 60000);
  if (minute !== wxMinuteKey) { wxMinuteKey = minute; wxMinuteCount = 0; }
  if (wxMinuteCount >= WX_PER_MINUTE) return refuse('per-minute ceiling');

  // Per-user ceiling, only when the caller identified itself. An unidentified
  // caller is NOT denied here — most call sites legitimately have no user — but
  // it also gets no per-user protection, which is why the enumeration-shaped
  // route is the one that must pass an id.
  let id = null;
  if (userId !== undefined && userId !== null) {
    const n = Number(userId);
    // Fail closed on a malformed id: a caller that tried to identify itself and
    // could not must not fall back to the unmetered lane.
    if (!Number.isInteger(n) || n <= 0) return refuse('unusable caller id');
    id = n;
    const hits = (wxUserHits.get(id) || []).filter((t) => now - t < HOUR_MS);
    if (hits.length >= WX_PER_USER_HOURLY) {
      wxUserHits.set(id, hits);
      return refuse('per-user hourly ceiling');
    }
    hits.push(now);
    wxUserHits.set(id, hits);
    // Never clear() the whole map to make room — that hands everyone tracked a
    // fresh allowance, including whoever pushed it over the edge. Evict least
    // consumed first, same doctrine as utils/probeBudget.js.
    if (wxUserHits.size > MAX_TRACKED_USERS) {
      for (const [k, v] of wxUserHits) {
        const live = v.filter((t) => now - t < HOUR_MS);
        if (live.length === 0) wxUserHits.delete(k);
        else if (live.length !== v.length) wxUserHits.set(k, live);
      }
      const bySpend = [...wxUserHits.entries()].sort((a, b) => a[1].length - b[1].length);
      // Evict to a low-water mark, not to exactly the ceiling: stopping at the
      // ceiling makes every later call pay a full scan and sort of 20,000
      // entries. Same reasoning as utils/placesBudget.js.
      for (const [k] of bySpend) {
        if (wxUserHits.size <= EVICT_TARGET) break;
        wxUserHits.delete(k);
      }
    }
  }

  wxDayCount++;
  wxMinuteCount++;
  return true;
}

// ---------------------------------------------------------------------------
// In-flight coalescing.
//
// Without this, N concurrent requests for the same uncached coordinate all miss
// the cache, all charge the budget and all hit OpenWeatherMap — N invoices for
// one answer. That is the normal case, not an edge case: publicCrowd scores a
// whole area at once, and a cold cache after a deploy means every simultaneous
// visitor misses together. Callers that arrive while a fetch is in flight wait
// on the same promise. The promise never rejects (both fetchers resolve to null
// on failure), so a joiner cannot inherit an unhandled rejection.
//
// A joiner is not charged, because no second vendor call happens — the ledger
// tracks calls, not readings. That does mean a caller who is over their own
// per-user ceiling can still receive a reading by arriving while someone else's
// fetch is open. That is deliberate: the per-user ceiling exists to bound
// SPENDING, and a joiner spends nothing.
//
// A joiner also inherits the leader's deadline rather than starting its own, so
// its wait is always shorter than a fresh fetch would have been. No caller can
// wait longer than UPSTREAM_TIMEOUT_MS.weather because of coalescing.
// ---------------------------------------------------------------------------
const inFlight = new Map();

function coalesce(key, work) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = work().finally(() => {
    // Only clear our own entry: a later fetch for the same key must not be
    // cancelled out by an earlier one finishing.
    if (inFlight.get(key) === p) inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}

/**
 * Current conditions. Returns null when unavailable — never a stale reading
 * dressed up as current, and never a fabricated default.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {object} [opts]
 * @param {number} [opts.userId] authenticated caller, when the caller chooses
 *   the coordinates. Enables the per-user hourly ceiling.
 */
async function getWeather(lat, lon, opts = {}) {
// `opts` is defaulted, and a DEFAULT ONLY APPLIES TO `undefined`. An explicit
// null — `getWeather(lat, lon, isUser ? { userId } : null)`, an entirely
// natural thing for a caller to write — reached `opts.userId` and threw, and
// the outer catch turned that into `return null`: weather silently off for
// that call, indistinguishable from an OpenWeatherMap outage, on the critical
// path of every crowd score. Normalise instead of trusting the default.
  const o = opts || {};
  try {
    const apiKey = process.env.WEATHER_API_KEY;
    if (!apiKey) {
      if (!warnedOnce) {
        console.warn('[Weather] WEATHER_API_KEY not set — skipping weather data');
        warnedOnce = true;
      }
      return null;
    }

    if (!validCoords(lat, lon)) return null;

    const cacheKey = getCacheKey(lat, lon);
    const entry = getEntry(cacheKey);
    if (entry) return entry.failed ? null : entry.data;

    return await coalesce(cacheKey, async () => {
      // Re-read inside the coalesced body: a caller that queued behind a fetch
      // which has since populated the cache must not spend a second unit.
      const fresh = getEntry(cacheKey);
      if (fresh) return fresh.failed ? null : fresh.data;

      // Charged BEFORE the call, because an aborted request still bills at the
      // vendor. See utils/upstream.js.
      if (!allowWeatherFetch(o.userId)) return null; // weather is an enhancer, fail soft

      const url = `https://api.openweathermap.org/data/2.5/weather?lat=${Number(lat).toFixed(2)}&lon=${Number(lon).toFixed(2)}&appid=${apiKey}&units=imperial`;
      // Round 12: weather is an enhancer on the critical path of crowd scoring —
      // a hung OpenWeather socket used to hold the whole prediction request open.
      // The catch below already degrades to null. See utils/upstream.js.
      let response;
      try {
        response = await fetch(url, { signal: upstreamSignal('weather') });
      } catch (netErr) {
        // Timeout or unreachable. Remember it briefly so a sustained outage
        // does not re-charge the daily budget on every request.
        console.error('[Weather] Upstream unreachable:', netErr.message);
        setCache(cacheKey, null, true);
        return null;
      }

      if (!response.ok) {
        console.error(`[Weather] API returned ${response.status} for ${cacheKey}`);
        setCache(cacheKey, null, true);
        return null;
      }

      let data;
      try {
        data = await response.json();
      } catch (bodyErr) {
        // The deadline also covers the body stream, so a truncated or hung body
        // lands here rather than hanging the request.
        console.error('[Weather] Malformed response body:', bodyErr.message);
        setCache(cacheKey, null, true);
        return null;
      }

      // A 200 with an unusable shape is a failure, not a reading of 0°F. Both
      // crowdEngine and mlPredictor read temp numerically, so letting undefined
      // through would silently become a fabricated number downstream.
      if (!data || typeof data.main?.temp !== 'number') {
        console.error(`[Weather] Unusable payload for ${cacheKey}`);
        setCache(cacheKey, null, true);
        return null;
      }

      const weatherMain = (data.weather && data.weather[0] && data.weather[0].main) || '';
      const result = Object.freeze({
        temp: data.main.temp,
        feelsLike: data.main.feels_like,
        humidity: data.main.humidity,
        windSpeed: data.wind?.speed ?? 0,
        conditions: (data.weather && data.weather[0] && data.weather[0].description) || '',
        // OWM condition code (e.g. 800 = clear) — the ML feature vector groups
        // on this; it was never passed through before (audit 2026-08-12)
        conditionId: (data.weather && data.weather[0] && data.weather[0].id) || null,
        isRaining: ['rain', 'drizzle', 'thunderstorm'].some(w => weatherMain.toLowerCase().includes(w)),
        // When this was actually observed. Callers that show an age (the public
        // demo's withAge, the venue card) must read this rather than assuming
        // "now": a cache hit can be up to CACHE_TTL old and must not claim to be
        // a live reading. Note the units are IMPERIAL (°F, mph) — the ML
        // training data was collected through this same function.
        fetchedAt: Date.now(),
      });

      setCache(cacheKey, result);
      return result;
    });
  } catch (err) {
    console.error('[Weather] Failed to fetch weather:', err.message);
    return null;
  }
}

/**
 * 5-day forecast (3-hour intervals) — returns daily summaries, or null when
 * unavailable. Shares the daily/minute budget with getWeather (round 8).
 */
async function getForecast(lat, lon, opts = {}) {
  const o = opts || {}; // see getWeather: an explicit null is not the default
  try {
    const apiKey = process.env.WEATHER_API_KEY;
    if (!apiKey) {
      if (!warnedOnce) {
        console.warn('[Weather] WEATHER_API_KEY not set — skipping weather data');
        warnedOnce = true;
      }
      return null;
    }

    if (!validCoords(lat, lon)) return null;

    const cacheKey = `forecast_${getCacheKey(lat, lon)}`;
    const entry = getEntry(cacheKey);
    if (entry) return entry.failed ? null : entry.data;

    return await coalesce(cacheKey, async () => {
      const fresh = getEntry(cacheKey);
      if (fresh) return fresh.failed ? null : fresh.data;

      if (!allowWeatherFetch(o.userId)) return null; // same budget as getWeather (round 8)

      const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${Number(lat).toFixed(2)}&lon=${Number(lon).toFixed(2)}&appid=${apiKey}&units=imperial`;
      let response;
      try {
        response = await fetch(url, { signal: upstreamSignal('weather') }); // round 12
      } catch (netErr) {
        console.error('[Weather] Forecast upstream unreachable:', netErr.message);
        setCache(cacheKey, null, true);
        return null;
      }
      if (!response.ok) {
        console.error(`[Weather] Forecast API returned ${response.status} for ${cacheKey}`);
        setCache(cacheKey, null, true);
        return null;
      }

      let data;
      try {
        data = await response.json();
      } catch (bodyErr) {
        console.error('[Weather] Forecast malformed body:', bodyErr.message);
        setCache(cacheKey, null, true);
        return null;
      }

      // A 200 without a list is an upstream failure, not an empty forecast. It
      // used to throw on `data.list` and land in the outer catch, which was the
      // right answer by accident but re-charged the budget every time.
      if (!data || !Array.isArray(data.list)) {
        console.error(`[Weather] Forecast payload unusable for ${cacheKey}`);
        setCache(cacheKey, null, true);
        return null;
      }

      // Group by date, pick midday (12:00) or closest entry per day
      const dailyMap = {};
      for (const entry2 of data.list) {
        if (typeof entry2?.dt_txt !== 'string') continue;
        const [datePart, timePart] = entry2.dt_txt.split(' ');
        if (!datePart || !timePart) continue;
        const hour = parseInt(timePart.split(':')[0], 10);
        if (!Number.isInteger(hour)) continue;
        if (!dailyMap[datePart] || Math.abs(hour - 12) < Math.abs(dailyMap[datePart].hour - 12)) {
          dailyMap[datePart] = {
            hour,
            date: datePart,
            temp: entry2.main?.temp ?? null,
            feelsLike: entry2.main?.feels_like ?? null,
            humidity: entry2.main?.humidity ?? null,
            windSpeed: entry2.wind?.speed ?? null,
            conditions: entry2.weather?.[0]?.description || '',
            icon: entry2.weather?.[0]?.icon || '',
          };
        }
      }

      const result = Object.freeze(
        Object.values(dailyMap).map(({ hour, ...rest }) => Object.freeze(rest))
      );
      setCache(cacheKey, result);
      return result;
    });
  } catch (err) {
    console.error('[Weather] Forecast error:', err.message);
    return null;
  }
}

// Diagnostics and tests. Production code must never reset a spending counter.
function weatherBudgetStatus() {
  return {
    day: wxDayKey,
    dailyUsed: wxDayCount,
    dailyRemaining: Math.max(0, WX_DAILY - wxDayCount),
    refusedToday: wxRefused,
    cacheEntries: weatherCache.size,
    inFlight: inFlight.size,
    limits: { daily: WX_DAILY, perMinute: WX_PER_MINUTE, perUserHourly: WX_PER_USER_HOURLY },
    inMemory: true,
  };
}

function __resetWeatherState() {
  weatherCache.clear();
  inFlight.clear();
  wxUserHits.clear();
  wxDayKey = new Date().toISOString().slice(0, 10);
  wxDayCount = 0;
  wxMinuteKey = 0;
  wxMinuteCount = 0;
  wxRefused = 0;
  lastRefusalLog = 0;
  warnedOnce = false;
}

module.exports = { getWeather, getForecast, weatherBudgetStatus, __resetWeatherState };
