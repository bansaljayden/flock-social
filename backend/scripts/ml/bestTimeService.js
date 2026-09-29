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

// WHAT A FAILED LOOKUP MEANT, NEVER WHAT IT SAID. No text that came back from
// BestTime is ever logged: see logSafe.js for why, and for the fixed labels.
const { labelFor, failureReason, describeError } = require('./logSafe');

// At most this many bytes of a failure body are read, and for at most this
// long: the reason is a nicety, and a body that never ends must not hold a
// lookup for the rest of its thirty seconds. Each chunk is clipped to what is
// left of the allowance BEFORE it is copied.
const REASON_MAX_BYTES = 4096;
const REASON_MAX_MS = 5000;
async function readBoundedText(response) {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') return null;
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < REASON_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : Buffer.from(value);
      const take = Math.min(bytes.byteLength, REASON_MAX_BYTES - size);
      chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, take));
      size += take;
    }
  } finally {
    Promise.resolve().then(() => reader.cancel()).catch(() => {});
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

// A failure whose body nobody reads is cancelled, so its connection goes back
// to the pool instead of waiting on a body after the deadline has been let go.
function discardBody(response) {
  const body = response && response.body;
  if (!body || typeof body.cancel !== 'function') return;
  Promise.resolve().then(() => body.cancel()).catch(() => {});
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
// "terminated" / UND_ERR_SOCKET is undici dropping a connection mid-body.
const NETWORK_ERR_RE = /aborted|timeout|terminated|UND_ERR_SOCKET|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|fetch failed/i;

// THE DEADLINE LASTS UNTIL THE BODY HAS BEEN READ. `await fetch()` resolves
// when the response HEADERS arrive, and this used to clear its timer right
// there, so the `.json()` each caller ran next had no deadline at all: a body
// that trickled in, or stalled after prompt headers, held the caller for as long
// as the connection stayed open. In the realtime sweep that is a call slot held
// with no end, and the sweep's drain waits for every slot, so one such answer
// could keep the collector alive until its three-hour watchdog and cost every
// hourly run in between. utils/upstream.js describes the same trap. The body is
// now read here, inside the deadline; an abort mid-body rejects the read with
// "This operation was aborted", which NETWORK_ERR_RE already counts as ours.
// A failed status is answered from the status alone and its body is cancelled
// unread, unless the caller asks for { withReason: true }: then up to
// REASON_MAX_BYTES of it are read for up to REASON_MAX_MS and `reason` is one
// of the fixed labels above. Only the weekly lookup asks. A by-name lookup
// spends an admission whether or not it finds the venue, and the reason is
// what tells "no foot traffic data" from "no venue at that address". The live
// sweep and the harvest never use it, so they never wait on a failure body.
// Returns { response, data }, with data null when the status failed.
async function fetchJsonWithTimeout(url, options, ms, { withReason = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (response.ok) {
      // A 200 whose body is not JSON is a gateway page or a cut answer, not a
      // verdict on the venue. Returned as null it marked the venue 404, spent
      // its admission for nothing and reset the error count, so an outage that
      // answers 200 with HTML walked the whole list without tripping the bail.
      // It is transient; and the parse error's own text (a quote of the body)
      // goes nowhere.
      try {
        return { response, data: await response.json() };
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        throw Object.assign(new Error('BestTime answered 200 with a body that is not JSON'), { transient: true, notJson: true });
      }
    }
    if (!withReason) {
      discardBody(response);
      return { response, data: null };
    }
    let reason = null;
    const reasonTimer = setTimeout(() => controller.abort(), REASON_MAX_MS);
    try {
      reason = failureReason(await readBoundedText(response));
    } catch {
      // Cut by a deadline or a broken body: the status still says what happened.
    } finally {
      clearTimeout(reasonTimer);
    }
    return { response, data: null, reason };
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

    const { response, data, reason } = await fetchJsonWithTimeout(
      `https://besttime.app/api/v1/forecasts?${params}`,
      { method: 'POST' },
      30000,
      { withReason: true }
    );

    if (!response.ok) {
      console.error(`[ML:BestTime] Weekly forecast failed (${response.status}) for ${venueName}`
        + (reason ? `: ${reason}` : ''));
      const err = classifyHttpFailure(response.status, 'weekly');
      if (err) throw err;
      return null; // genuine venue-level 404 → caller marks as 404, never retries
    }

    if (!data.analysis || data.status !== 'OK') {
      console.error(`[ML:BestTime] No analysis data for ${venueName}: ${labelFor(data.message)}`);
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
      // A number or nothing: it goes into a BIGINT column, and a stray string
      // there would come back quoted inside a Postgres error.
      epochAnalysis: Number.isSafeInteger(Number(data.epoch_analysis)) && Number(data.epoch_analysis) > 0
        ? Number(data.epoch_analysis) : null,
    };
  } catch (err) {
    console.error(`[ML:BestTime] Weekly forecast error for ${venueName}: ${describeError(err)}`);
    // Re-throw classified errors (transient 5xx/429, fatal 401/402/403) and
    // network/timeout/abort failures so the caller never 404-marks these.
    if (err.transient || err.fatal || (!(err instanceof SyntaxError) && NETWORK_ERR_RE.test(err.message || ''))) throw err;
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
    const { response, data } = await fetchJsonWithTimeout(
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
      // WHAT THE ANSWER SAYS ABOUT ITSELF, read where BestTime's documented
      // live response puts it. This read `analysis.hour_analysis` and
      // `analysis.venue_open` until 2026-09-26; neither key exists in the live
      // response (hour_analysis belongs to the week forecast, venue_open to
      // venue_info), so both were null on every call. Stored per reading by
      // collectRealtime.js (migration 094).
      //   hourStart        analysis.hour_start, the hour the live value is
      //                    measured for (0-23), which is what separates a
      //                    reading that lags the clock from one that does not
      //   venueOpen        venue_info.venue_open, 'Open' / 'Closed' as sent
      //   vendorLocalTime  venue_info.venue_current_localtime, the vendor's
      //                    clock at the call, as sent
      hourStart: data.analysis?.hour_start ?? null,
      venueOpen: data.venue_info?.venue_open ?? data.analysis?.venue_open ?? null,
      vendorLocalTime: data.venue_info?.venue_current_localtime ?? null,
    };
  } catch (err) {
    console.error(`[ML:BestTime] Live query error for ${venueId}: ${describeError(err)}`);
    if (err.transient || err.fatal || (!(err instanceof SyntaxError) && NETWORK_ERR_RE.test(err.message || ''))) throw err;
    return null;
  }
}

module.exports = { fetchWeeklyForecast, fetchLiveBusyness, NETWORK_ERR_RE };
// Also exported for harvestVenueFilter.js, which calls a different endpoint
// under the same error contract and the same body deadline. A second copy of
// either is how a 402 would come to mean "no venues here" in one collector and
// "stop" in another.
module.exports.classifyHttpFailure = classifyHttpFailure;
module.exports.fetchJsonWithTimeout = fetchJsonWithTimeout;
module.exports.failureReason = failureReason;
module.exports.readBoundedText = readBoundedText;
module.exports.REASON_MAX_BYTES = REASON_MAX_BYTES;
