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
//   DECIDED 2026-08-14 (Jayden: "do everything on my list"): WX_DAILY sits at
//   950, UNDER OpenWeatherMap's free allowance of 1,000/day, with 50 calls of
//   headroom for clock skew between our day window and theirs. The old value
//   was 3000, which was willing to spend past free into billed usage on a plan
//   nobody had confirmed paying for. Raise it only after confirming a paid
//   plan on a real invoice. WX_PER_MINUTE stays under the free plan's
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

// ---------------------------------------------------------------------------
// MAX_CACHE_ENTRIES, and the inequality it has to satisfy (round 23).
// ---------------------------------------------------------------------------
// This was 100, and 100 was the whole finding. GET /api/weather hands the
// caller's own lat/lon straight through, so the key is entirely caller-chosen:
// at the 2-decimal bucketing below there are ~6.5e8 reachable keys (18,001
// latitude buckets x 36,001 longitude buckets) against a cache of 100. Roughly
// three requests' worth of fresh coordinates evicted every entry in it, and
// every evicted entry is a paid OpenWeatherMap call the next crowd score,
// public demo card or venue dashboard has to make again. The SPEND was capped
// (40/user/hour, 55/minute, 950/UTC day); the FLUSH was not, and a flush is how
// you make everyone else spend.
//
// BUCKETING FIRST, AND WHY IT IS NOT ENOUGH ON ITS OWN. getCacheKey buckets to
// two decimals (~1.1 km), the same grid routes/publicCrowd.js and the crowd
// batch route snap to before they key anything. That is the right first move
// and it is now single-sourced (bucketCoord, below) so the key and the
// coordinate actually SENT upstream can never drift apart. But 2dp still
// leaves ~6.5e8 buckets, which is unbounded for every practical purpose, so
// bucketing alone does not make this cache a control. Coarsening further would
// buy key space with accuracy the ML feature vector is trained on — the
// training data was collected through this same 2dp function — so the answer
// is not a coarser key. The answer is a cache that a day's worth of paid calls
// cannot flush.
//
// THE PIN: WX_DAILY (950) < MAX_CACHE_ENTRIES (1000).
// Every cache write in this file, including the negative ones, happens strictly
// AFTER allowWeatherFetch() charged a unit — nothing writes on a cache hit and
// nothing writes on a refusal. So the number of entries this map can be made to
// take in one UTC day is exactly the number of units in the daily ceiling, and
// keeping the cache larger than that ceiling means A WHOLE DAY OF SPENDING
// CANNOT EVICT A SINGLE ENTRY THAT HAS NOT ALREADY EXPIRED. The eviction path
// below still exists, and still evicts oldest-first, but it is now only
// reachable across a UTC day boundary rather than by the third request of the
// morning. Same shape as EVENT_USER_DAILY(400) < EVENT_CACHE_MAX(500) in
// services/mlPredictor.js and VISION_USER_DAILY < VISION_GLOBAL_DAILY in
// utils/visionBudget.js, and pinned by a test the same way: if WX_DAILY is ever
// raised (see the free-tier note above), this number moves with it.
//
// The memory cost is nothing to weigh against that: an entry is a frozen object
// of seven numbers and two short strings, so 1000 of them is tens of kilobytes.
const MAX_CACHE_ENTRIES = 1000;

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

// The ONE place a caller's coordinate becomes a bucket. It was three places —
// getCacheKey and the two request URLs each ran their own `toFixed(2)` — and
// three copies of a rounding rule is how a key stops describing the thing
// stored under it. Bucket once, then use the bucketed value for BOTH the key
// and the upstream request, so two callers who share a cache key provably
// asked OpenWeatherMap the same question. Two decimals is ~1.1 km, the same
// grid routes/publicCrowd.js and the crowd batch route snap to.
function bucketCoord(v) {
  return Number(v).toFixed(2);
}

function getCacheKey(lat, lon) {
  return `${bucketCoord(lat)},${bucketCoord(lon)}`;
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
const WX_DAILY = 950;
const WX_PER_MINUTE = 55;
const WX_PER_USER_HOURLY = 40; // only applied when a userId is supplied

// ---------------------------------------------------------------------------
// THE UNAUTHENTICATED SHARE. Mirrors UNAUTH_DAILY in utils/placesBudget.js,
// for the same reason and after the same mistake (money audit round 4).
//
// WHAT WAS MISSING. Every ceiling above is either global or keyed to an
// account, and the two doors with NO account call getWeather with no id:
// routes/publicCrowd.js (the marketing demo) and routes/badge.js (the
// embeddable SVG). Each keeps its own per-IP gate and its own daily request
// ceiling, and both of those ceilings are 600 (publicCrowd allowDemo's
// dayCount, and badge's BADGE_DAILY), so between them the doors with nobody
// behind them could ask for 1200 readings against a WX_DAILY of 950. That is
// the entire day, spent by callers nobody can identify, after which this
// function refuses every authenticated crowd score, advisor card and Monday
// digest until UTC midnight and each of them silently loses its weather factor
// rather than failing.
//
// MEASURED, not argued: four anonymous GET /api/public/demo/venues requests
// against the live preview moved the shared meter from 23 to 28. Being signed
// in protected none of the other 927.
//
// PER-DOOR GATES ARE NOT A RESERVE. That is the correction placesBudget's M5-1
// section makes about its own three doors: an inequality between constants in
// two route files is a coincidence maintained by hand, and it stops holding the
// day somebody adds a third door or raises one number. This is the control, and
// it sits at the one function every paid weather fetch passes through.
//
// WHY 650. The same two constraints placesBudget pins. Upward: the largest
// single unauthenticated door is 600 requests a day, and a sub-ceiling BELOW
// the door it sits over silently repeals that door's own limit, so this has to
// stay strictly above 600. Downward: WX_DAILY - WX_UNAUTH_DAILY = 300 is the
// authenticated reserve, and 300 is more than seven times WX_PER_USER_HOURLY,
// so no single account can spend the reserve inside an hour either. 650 is the
// smallest round number above 600, which makes it the largest reserve
// available without breaking the first constraint.
//
// WHO COUNTS AS ANONYMOUS: only a caller that says so, with
// { anonymous: true }. Absence of a userId is deliberately NOT the signal. A
// background producer with no user — services/nightContext.js's sweep,
// services/crowdAlerts.js, the ML collection scripts — is our own traffic
// rather than unattributable traffic, and putting it in this bucket would let
// demo load starve a scheduled job. The public door declares itself instead.
const WX_UNAUTH_DAILY = 650;

let wxDayKey = new Date().toISOString().slice(0, 10);
let wxDayCount = 0;
// The unauthenticated slice of wxDayCount. Charged IN ADDITION to it, never
// instead of it: an anonymous reading still counts against the day like any
// other, this only says how much of the day it may reach.
let wxUnauthDayCount = 0;
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

function allowWeatherFetch(userId, opts = {}) {
  const now = Date.now();
  // Normalised rather than trusted to the default, for the reason getWeather
  // states below: an explicit null is a natural thing for a caller to write and
  // `null.anonymous` throws.
  const anonymous = !!(opts && opts.anonymous);

  const today = new Date().toISOString().slice(0, 10);
  if (today !== wxDayKey) { wxDayKey = today; wxDayCount = 0; wxUnauthDayCount = 0; wxRefused = 0; }
  if (wxDayCount >= WX_DAILY) return refuse('daily ceiling');
  // Checked BEFORE any counter moves, like every other ceiling here. This is
  // the whole reserve: no number of addresses, and no public door added later,
  // can push the signed-in product below WX_DAILY - WX_UNAUTH_DAILY readings
  // for the rest of the day.
  if (anonymous && wxUnauthDayCount >= WX_UNAUTH_DAILY) return refuse('unauthenticated share');

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
  if (anonymous) wxUnauthDayCount++;
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
      if (!allowWeatherFetch(o.userId, o)) return null; // weather is an enhancer, fail soft

      const url = `https://api.openweathermap.org/data/2.5/weather?lat=${bucketCoord(lat)}&lon=${bucketCoord(lon)}&appid=${apiKey}&units=imperial`;
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

      if (!allowWeatherFetch(o.userId, o)) return null; // same budget as getWeather (round 8)

      const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${bucketCoord(lat)}&lon=${bucketCoord(lon)}&appid=${apiKey}&units=imperial`;
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
      // Days and hours in the CITY's zone. dt_txt is UTC, so the strip keyed
      // its days on UTC and picked 12:00 UTC, which is 7 or 8 AM in
      // Pennsylvania: "today" rolled over at 8 PM and the day's reading was
      // the morning one. OpenWeather sends the city's offset (seconds) as
      // city.timezone; dt plus that offset, read as UTC fields, is local.
      const tzOffsetSec = Number.isFinite(data.city?.timezone) ? data.city.timezone : 0;
      const dailyMap = {};
      for (const entry2 of data.list) {
        let datePart;
        let hour;
        if (Number.isFinite(entry2?.dt)) {
          const local = new Date((entry2.dt + tzOffsetSec) * 1000);
          datePart = local.toISOString().slice(0, 10);
          hour = local.getUTCHours();
        } else {
          if (typeof entry2?.dt_txt !== 'string') continue;
          const [dp, timePart] = entry2.dt_txt.split(' ');
          if (!dp || !timePart) continue;
          datePart = dp;
          hour = parseInt(timePart.split(':')[0], 10);
        }
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

/**
 * Hour-resolution forecast for the 24-hour crowd strip — the raw 3-hour OWM
 * list mapped to the SAME shape getWeather returns per reading, NOT the daily
 * summaries getForecast collapses it into. Built for services/mlPredictor.js
 * predictHourlyForecast, which used to score all 24 slots with ONE current
 * reading: 3 AM was scored with 3 PM's temperature, and "raining now" rained
 * on tonight's dinner slot (train/serve skew hunt, 2026-08-19 — worth 2-3
 * points on tail hours). Each entry carries `at` (epoch ms of the slot OWM
 * forecast is FOR) so the caller can pick the nearest entry per hour.
 *
 * Same contracts as getForecast: shares the getWeather budget, coalesces
 * concurrent misses, remembers failures briefly, returns null (never a stale
 * or partial answer) when the upstream cannot be asked or cannot answer.
 * Units are IMPERIAL (°F, mph) — the ML corpus was collected through this
 * same vendor and unit setting.
 */
async function getHourlyForecast(lat, lon, opts = {}) {
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

    // Its own key: getForecast stores the daily digest under forecast_*, and a
    // digest cannot be un-summarized back into hours.
    const cacheKey = `forecast_hourly_${getCacheKey(lat, lon)}`;
    const entry = getEntry(cacheKey);
    if (entry) return entry.failed ? null : entry.data;

    return await coalesce(cacheKey, async () => {
      const fresh = getEntry(cacheKey);
      if (fresh) return fresh.failed ? null : fresh.data;

      if (!allowWeatherFetch(o.userId, o)) return null; // same budget as getWeather (round 8)

      const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${bucketCoord(lat)}&lon=${bucketCoord(lon)}&appid=${apiKey}&units=imperial`;
      let response;
      try {
        response = await fetch(url, { signal: upstreamSignal('weather') }); // round 12
      } catch (netErr) {
        console.error('[Weather] Hourly forecast upstream unreachable:', netErr.message);
        setCache(cacheKey, null, true);
        return null;
      }
      if (!response.ok) {
        console.error(`[Weather] Hourly forecast API returned ${response.status} for ${cacheKey}`);
        setCache(cacheKey, null, true);
        return null;
      }

      let data;
      try {
        data = await response.json();
      } catch (bodyErr) {
        console.error('[Weather] Hourly forecast malformed body:', bodyErr.message);
        setCache(cacheKey, null, true);
        return null;
      }

      // A 200 without a list is an upstream failure, not an empty forecast
      // (same reading getForecast settled on).
      if (!data || !Array.isArray(data.list)) {
        console.error(`[Weather] Hourly forecast payload unusable for ${cacheKey}`);
        setCache(cacheKey, null, true);
        return null;
      }

      const entries = [];
      for (const e of data.list) {
        // `dt` is the vendor's own epoch for the slot; an entry without one
        // cannot be matched to an hour and is an entry we cannot serve.
        const at = typeof e?.dt === 'number' && Number.isFinite(e.dt) ? e.dt * 1000 : null;
        if (at == null) continue;
        const weatherMain = (e.weather && e.weather[0] && e.weather[0].main) || '';
        entries.push(Object.freeze({
          at,
          temp: e.main?.temp ?? null,
          feelsLike: e.main?.feels_like ?? null,
          humidity: e.main?.humidity ?? null,
          windSpeed: e.wind?.speed ?? 0,
          conditions: (e.weather && e.weather[0] && e.weather[0].description) || '',
          // OWM condition code — the ML feature vector groups on this, exactly
          // as getWeather passes it for the current reading.
          conditionId: (e.weather && e.weather[0] && e.weather[0].id) || null,
          isRaining: ['rain', 'drizzle', 'thunderstorm'].some(w => weatherMain.toLowerCase().includes(w)),
        }));
      }

      const result = Object.freeze(entries);
      setCache(cacheKey, result);
      return result;
    });
  } catch (err) {
    console.error('[Weather] Hourly forecast error:', err.message);
    return null;
  }
}

// Diagnostics and tests. Production code must never reset a spending counter.
function weatherBudgetStatus() {
  return {
    day: wxDayKey,
    dailyUsed: wxDayCount,
    dailyRemaining: Math.max(0, WX_DAILY - wxDayCount),
    // What the doors with no account have left, against what the whole process
    // has left. Two different numbers on purpose; the gap is the reserve.
    unauthUsed: wxUnauthDayCount,
    unauthRemaining: Math.max(0, WX_UNAUTH_DAILY - wxUnauthDayCount),
    refusedToday: wxRefused,
    cacheEntries: weatherCache.size,
    inFlight: inFlight.size,
    limits: {
      daily: WX_DAILY, perMinute: WX_PER_MINUTE, perUserHourly: WX_PER_USER_HOURLY,
      unauthDaily: WX_UNAUTH_DAILY,
    },
    inMemory: true,
  };
}

function __resetWeatherState() {
  weatherCache.clear();
  inFlight.clear();
  wxUserHits.clear();
  wxDayKey = new Date().toISOString().slice(0, 10);
  wxDayCount = 0;
  wxUnauthDayCount = 0;
  wxMinuteKey = 0;
  wxMinuteCount = 0;
  wxRefused = 0;
  lastRefusalLog = 0;
  warnedOnce = false;
}

module.exports = { getWeather, getForecast, getHourlyForecast, weatherBudgetStatus, __resetWeatherState };

// Exported for __tests__/weatherCacheFlush.test.js, which pins the inequality
// WX_DAILY < MAX_CACHE_ENTRIES and the single-sourced 2dp bucketing. Reading
// them from here rather than retyping them is the point: a test that repeats a
// constant stops testing the code the moment somebody edits the code.
module.exports.__test = {
  WX_DAILY,
  WX_UNAUTH_DAILY,
  WX_PER_MINUTE,
  WX_PER_USER_HOURLY,
  MAX_CACHE_ENTRIES,
  CACHE_TTL,
  bucketCoord,
  getCacheKey,
  setCache,
  cacheSize: () => weatherCache.size,
  cacheHas: (key) => weatherCache.has(key),
};
