// ---------------------------------------------------------------------------
// BestTime API Wrapper — placeholder-ready
// When BESTTIME_API_KEY is not set, functions return null gracefully.
//
// Error contract (both fetchers, so callers can protect the corpus + quota):
//   return null            → venue-level "no data" (genuine 404 / no analysis).
//                            Weekly caller may mark the venue 404 and move on.
//   throw err.transient    → BestTime outage / rate limit / network. Caller
//                            must NOT mark the venue; retry-or-bail per venue.
//   throw err.fatal        → key/account-level failure (401/402/403: bad key,
//                            out of credits, forbidden). NOTHING venue-specific
//                            can be concluded; caller must abort the whole run
//                            immediately or every remaining venue gets falsely
//                            marked and the corpus is poisoned for the cycle.
// ---------------------------------------------------------------------------

const { sleep } = require('./config');

let warnedOnce = false;

function getKey() {
  const key = process.env.BESTTIME_API_KEY;
  if (!key && !warnedOnce) {
    console.warn('[ML:BestTime] BESTTIME_API_KEY not set — skipping BestTime calls');
    warnedOnce = true;
  }
  return key;
}

// Classify a non-OK HTTP status into the error contract above.
// Returns an Error to throw, or null meaning "treat as venue-level no-data".
function classifyHttpFailure(status, context) {
  // 5xx / 429 = transient (BestTime outage / rate limit) → throw so the
  // caller's per-venue catch + consecutive-error bail prevents false 404 marks.
  if (status >= 500 || status === 429) {
    const e = new Error(`BestTime ${status} (${context})`);
    e.transient = true;
    return e;
  }
  // 401/402/403 = key-level: invalid key, OUT OF CREDITS (402), forbidden.
  // Before this classification these fell through to `return null`, and
  // collectWeekly marked every remaining venue besttime_status='404' — one
  // expired key or exhausted quota mid-run silently poisoned the whole corpus
  // cycle. The run must stop, not "skip".
  if (status === 401 || status === 402 || status === 403) {
    const e = new Error(`BestTime ${status} (${context}) — key/credits problem, aborting run`);
    e.fatal = true;
    return e;
  }
  // 404 and other 4xx: venue genuinely not resolvable → caller may mark it.
  return null;
}

// Exported since 2026-09-04. collectRealtime needs the SAME test one level up:
// its ten-error breaker says "BestTime looks down" and a timeout on our own
// clock is not that, so the two places that decide what a network error is have
// to be one place. A second copy is how they drift.
const NETWORK_ERR_RE = /aborted|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|fetch failed/i;

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    // Round 13: previously cleared only on the success path — a network error
    // left a 30s timer pending, keeping the process alive after pool.end().
    clearTimeout(timer);
  }
}

// Fetch weekly forecast for a venue (7 days × 24 hours of busyness %)
// Returns: { venueId, days: [{ dayInt, dayText, hours: [0-100 × 24] }], epochAnalysis }
async function fetchWeeklyForecast(venueName, venueAddress, existingVenueId) {
  const apiKey = getKey();
  if (!apiKey) return null;

  try {
    const params = existingVenueId
      ? new URLSearchParams({ api_key_private: apiKey, venue_id: existingVenueId })
      : new URLSearchParams({ api_key_private: apiKey, venue_name: venueName, venue_address: venueAddress });

    const response = await fetchWithTimeout(
      `https://besttime.app/api/v1/forecasts?${params}`,
      { method: 'POST' },
      30000
    );

    if (!response.ok) {
      console.error(`[ML:BestTime] Weekly forecast failed (${response.status}) for ${venueName}`);
      const err = classifyHttpFailure(response.status, 'weekly');
      if (err) throw err;
      return null; // genuine venue-level 404 → caller marks as 404, never retries
    }

    const data = await response.json();

    if (!data.analysis || data.status !== 'OK') {
      console.error(`[ML:BestTime] No analysis data for ${venueName}:`, data.message || 'unknown error');
      return null;
    }

    const days = data.analysis.map(day => ({
      dayInt: day.day_info.day_int,       // BestTime: Mon=0..Sun=6
      dayText: day.day_info.day_text,
      hours: day.day_raw || [],           // array of 24 busyness values (0-100)
    }));

    await sleep(150);

    return {
      venueId: data.venue_info?.venue_id || null,
      days,
      epochAnalysis: data.epoch_analysis || null,
    };
  } catch (err) {
    console.error(`[ML:BestTime] Weekly forecast error for ${venueName}:`, err.message);
    // Re-throw classified errors (transient 5xx/429, fatal 401/402/403) and
    // network/timeout/abort failures so the caller never 404-marks these.
    if (err.transient || err.fatal || NETWORK_ERR_RE.test(err.message || '')) throw err;
    return null;
  }
}

// Fetch live busyness for a venue
// Returns: { forecastedBusyness, liveBusyness, liveAvailable, hour, venueOpen }
// Same error contract as fetchWeeklyForecast — before round 13 this swallowed
// EVERY failure into null, so a BestTime outage or a dead key looked identical
// to "venue has no live data" and collectRealtime kept hammering the API for
// thousands of venues with no way to bail.
//
// ---------------------------------------------------------------------------
// WHICH OF THE TWO NUMBERS IS AN OBSERVATION (round 19). This endpoint always
// answers with a forecast and sometimes also with a live reading, and the ONLY
// thing that separates them is the flag:
//
//   venue_forecasted_busyness       BestTime's own PREDICTION for this moment.
//                                   Always present for an analysed venue. Not
//                                   foot traffic; a model output.
//   venue_live_busyness             the live reading — but ONLY when
//                                   venue_live_busyness_available is true.
//                                   When it is false this field still carries a
//                                   number, and that number is the forecast
//                                   again. It is an echo, not evidence.
//   venue_live_busyness_available   the flag. This is the whole discriminator.
//
// So a caller must never infer "this is live" from `liveBusyness != null`.
// `liveAvailable` is normalised to a strict boolean below precisely so that a
// missing, null or malformed flag can only ever read as false: mislabelling a
// vendor forecast as an observation trains it at full confidence, while the
// opposite mistake only downweights a real observation. Classification itself
// lives in collectRealtime.classifyReading(), which is the single place the
// mapping is written and the place the tests pin.
//
// This matters because nothing in ml_training_data recorded the flag until
// 2026-08-13, and all 457,402 realtime rows collected before then are
// permanently 'unknown' as a result. See migration 025's header.
// ---------------------------------------------------------------------------
async function fetchLiveBusyness(venueId) {
  const apiKey = getKey();
  if (!apiKey) return null;
  if (!venueId) {
    console.warn('[ML:BestTime] No venue_id for live query — run weekly forecast first');
    return null;
  }

  try {
    const params = new URLSearchParams({ api_key_private: apiKey, venue_id: venueId });
    const response = await fetchWithTimeout(
      `https://besttime.app/api/v1/forecasts/live?${params}`,
      { method: 'POST' },
      // 20 s. A live answer normally lands in a second or two, but BestTime
      // has slow hours: measured from outside at 03:50 UTC on 2026-09-04,
      // live answers took 16-18 s. At 10 s (the first cut, down from 30)
      // every one of those was aborted here and the sweep's second half
      // wrote nothing, while at 30 s a burst of them once ran a sweep past
      // the next hour's trigger. The run-time budget in collectRealtime.js
      // is what protects the hour now; this only decides how long one venue
      // may take. The forecast call above keeps 30 s: it is rare and it
      // fetches a whole week.
      20000
    );

    if (!response.ok) {
      console.error(`[ML:BestTime] Live query failed (${response.status}) for ${venueId}`);
      const err = classifyHttpFailure(response.status, 'live');
      if (err) throw err;
      return null;
    }

    const data = await response.json();

    if (data.status !== 'OK') {
      return null;
    }

    await sleep(150);

    return {
      forecastedBusyness: data.analysis?.venue_forecasted_busyness ?? null,
      liveBusyness: data.analysis?.venue_live_busyness ?? null,
      // `=== true`, not `?? false`: the previous form left any truthy
      // non-boolean (the string "false" among them) reading as "live data
      // available", which would stamp a vendor forecast as an observation.
      liveAvailable: data.analysis?.venue_live_busyness_available === true,
      hour: data.analysis?.hour_analysis ?? null,
      venueOpen: data.analysis?.venue_open ?? null,
    };
  } catch (err) {
    console.error(`[ML:BestTime] Live query error for ${venueId}:`, err.message);
    if (err.transient || err.fatal || NETWORK_ERR_RE.test(err.message || '')) throw err;
    return null;
  }
}

module.exports = { fetchWeeklyForecast, fetchLiveBusyness, NETWORK_ERR_RE };
