// ---------------------------------------------------------------------------
// Owner-report context capture: what the world looked like when the slider
// moved.
//
// The slider (routes/venueDashboard.js POST /busy-now) writes the only live
// 0-100 training labels Flock has (migration 031), and a label without its
// context is weak: at export time nothing about that moment's weather, nearby
// events, or what Flock itself was publishing is recoverable, so
// scripts/ml/train/ownerLabelExport.js shipped every one of those columns as
// NULL. This module records them at the one time they are cheap and true —
// the moment of the INSERT — into venue_owner_report_context (migration 036).
//
// THE ONE CONTRACT: this must NEVER block or fail the report POST.
//   * The route calls captureOwnerReportContext fire-and-forget, no await.
//   * The entire body is inside one catch; the returned promise NEVER rejects.
//   * Every source degrades independently to NULL columns: a weather outage,
//     a venue outside ml_venues, a missing serve record, or a serve record
//     this module refuses to trust (see SERVED_LOOKUP_SQL) — each is a quiet
//     log line and a NULL, never a lost report and never a lost capture of the
//     OTHER sources.
//   * Idempotent per report id, twice over: an existing row is detected before
//     any upstream spend, and the INSERT is ON CONFLICT DO NOTHING so two
//     racing captures still write one row.
//
// COST. Weather goes through weatherService.getWeather — cache-first,
// coalesced, budget-gated (charged to the reporting owner's account, the same
// caller dimension every other weather read carries). Events go through
// mlPredictor's getNearbyEvents — same Ticketmaster cache, coalescing and
// budget as the serve path. The served prediction is a single indexed read of
// served_predictions (032): READ, never recomputed, because recomputing would
// record what the model WOULD say now, not what users actually saw — and
// restricted to serves the SERVER chose rather than merely recorded (038),
// because "what Flock was publishing" must not be answerable by whoever last
// posted a vote list.
//
// mlPredictor exports getNearbyEvents under _internals today; resolveEvents
// tolerates either home so a later promotion to the public surface is a
// no-op here, and its absence is one more NULL-degradation, not a crash.
// ---------------------------------------------------------------------------
const pool = require('../config/database');
const weatherService = require('./weatherService');

// How far back a served_predictions row still counts as "what users were
// seeing". 12 hours matches the feedback route's serve-join window (032):
// both are answering "what was on screen around this assertion".
const SERVE_JOIN_WINDOW_HOURS = 12;

// ---------------------------------------------------------------------------
// WHAT FLOCK WAS PUBLISHING, AND WHY IT IS NOT SIMPLY "THE NEWEST ROW"
// (migration 038).
//
// This read is the one place a number the SERVER computed gets written onto a
// training label's context, so it inherits 038's problem whole. POST
// /api/crowd/batch scores venues out of a client-assembled body — rating,
// review count, utcOffsetMinutes — and records the result in
// served_predictions like any other serve. Newest-row-wins therefore let
// anyone with an account decide what this table says Flock was publishing at
// a venue: score the bar at rating 1.0 and a 4am offset, and the ~5 that
// produces becomes served_score on the next owner reading filed there, for
// any venue, without ever touching that venue's account.
//
// routes/feedback.js refuses those rows for provenance. The same allowlist
// applies here, and the argument for it is stronger rather than weaker: the
// author of the surrounding row is the venue owner, so the threat model
// differs — but the poisoned VALUE is identical, and it lands in a training
// corpus rather than in a sentence somebody reads once.
//
//   source = 'detail'   the detail card, scored on the VENUE's own clock. The
//                       only value routes/feedback.js trusts, and the only one
//                       trusted here. NULL (every row written before 038),
//                       'batch' and 'detail_client_clock' all fall outside it
//                       by construction: NULL = 'detail' is NULL, never true.
//
//   the clock must match — the question this column answers is "what was on
//                       screen WHEN the owner said X%", and a serve computed
//                       for a different venue-local hour did not answer it.
//                       The check fits this reader's shape exactly: the venue
//                       clock is already resolved here for day_of_week/hour,
//                       and is now resolved BEFORE this read so both use it.
//
// NO QUALIFYING SERVE MEANS NULLS, never a fallback to an untrusted row. Every
// column in this table is nullable by design (migration 036: "NULL means not
// observed, never 0"), so refusing is a first-class answer here in a way it is
// not on most surfaces. That includes the case where the venue's own clock is
// unavailable — outside ml_venues, or a timezone Intl cannot parse — because
// without it there is nothing to check the pairing against, and a served_score
// nobody can tie to an hour is exactly the unverifiable figure 032 existed to
// stop recording.
//
// ALLOWLIST, NOT BLOCKLIST, and __tests__/ownerReportContext.test.js asserts
// the source text says so: `source <> 'batch'` would re-open this the day a
// fourth write path is added, and would let the pre-038 NULL rows through in
// the meantime.
// ---------------------------------------------------------------------------
const SERVED_LOOKUP_SQL = `
  SELECT id, score, prediction_method, model_version, served_at
    FROM served_predictions
   WHERE venue_place_id = $1
     AND served_at > NOW() - INTERVAL '${SERVE_JOIN_WINDOW_HOURS} hours'
     AND source = 'detail'
     AND local_day = $2
     AND local_hour = $3
   ORDER BY served_at DESC
   LIMIT 1`;

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Venue-local (dayOfWeek 0=Sunday, hour 0-23) for an instant in an IANA zone,
// or null when the zone is unusable — garbage in ml_venues.timezone must
// degrade to NULL, the same rule migration 021 keeps in SQL.
function localClock(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      weekday: 'short',
      hour: 'numeric',
    }).formatToParts(date);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const dayOfWeek = DOW[get('weekday')];
    let hour = Number(get('hour'));
    if (hour === 24) hour = 0; // hour12:false renders midnight as 24 on some ICU builds
    if (!Number.isInteger(dayOfWeek) || !Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    return { dayOfWeek, hour };
  } catch {
    return null;
  }
}

// Lazy, tolerant resolution of the event lookup (see header).
function resolveEvents() {
  try {
    // eslint-disable-next-line global-require
    const ml = require('./mlPredictor');
    const fn = ml.getNearbyEvents || ml._internals?.getNearbyEvents;
    return typeof fn === 'function' ? fn : null;
  } catch {
    return null;
  }
}

function quiet(what, err) {
  console.error(`[OwnerReportContext] ${what} unavailable, storing NULLs:`, err?.message || err);
}

// ---------------------------------------------------------------------------
// A LOOKUP THAT DID NOT HAPPEN IS NOT A QUIET NIGHT (migration 044).
//
// This module used to write the event columns as
//
//     has_nearby_event    = events ? events.hasEvent === true : null
//     total_nearby_events = events ? events.totalEvents ?? null : null
//
// and `events` was truthy in four situations that are not one fact. Until it
// was fixed, mlPredictor.getNearbyEvents answered ONE shared no-event object
// whether Ticketmaster listed nothing, the per-account event budget refused
// the call, the provider errored, or the request timed out. Three of those
// four are "nobody looked", and all four were written here as
// has_nearby_event = false, total_nearby_events = 0: a negative observation
// that never happened, persisted, and then read back by
// scripts/ml/train/ownerLabelExport.js as the context of a training label.
// Every Ticketmaster outage was quietly recording "there were no events near
// this venue" for as long as it lasted.
//
// getNearbyEvents now carries `observed` and `unavailableReason` on every
// return, so this reader can hold the three states 036's header already
// implied ("NULL means not observed, never 0"):
//
//   observed true   Ticketmaster answered. The columns are a measurement,
//                   including the genuinely quiet night: false and 0 are then
//                   facts and are stored as facts.
//   observed false  the lookup failed or was refused. Every event column is
//                   NULL and events_unavailable_reason keeps which failure it
//                   was, so an audit can tell a provider outage from a venue
//                   that had no coordinates to look near.
//   observed null   no lookup was attempted and none could have been: no
//                   coordinates, or mlPredictor would not load.
//
// FAIL CLOSED ON A SHAPE THAT CANNOT SAY. A result object with no `observed`
// flag is treated as unobserved rather than waved through as a measurement.
// The flag is cheap to add and its absence means the caller predates the
// contract, which is exactly the state in which its zeros cannot be trusted.
// ---------------------------------------------------------------------------
function readEvents(events) {
  if (!events || typeof events !== 'object') {
    return { observed: null, reason: null, data: null };
  }
  if (events.observed === true) {
    return { observed: true, reason: null, data: events };
  }
  const reason = typeof events.unavailableReason === 'string' && events.unavailableReason
    ? events.unavailableReason
    : 'unknown_provenance';
  return { observed: false, reason, data: null };
}

const INSERT_CONTEXT_SQL = `
  INSERT INTO venue_owner_report_context (
    report_id,
    temperature, feels_like, humidity, wind_speed,
    weather_condition, weather_condition_code, is_raining,
    has_nearby_event, total_nearby_events, total_nearby_attendance,
    nearest_event_distance_km, nearest_event_attendance, nearest_event_type,
    served_prediction_id, served_score, served_prediction_method,
    served_model_version, served_at,
    day_of_week, hour, timezone, venue_category,
    events_observed, events_unavailable_reason
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
            $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
  ON CONFLICT (report_id) DO NOTHING`;

/**
 * Capture the context for one just-inserted owner report. Fire-and-forget:
 * resolves always, rejects never. `deps` exists for tests.
 */
async function captureOwnerReportContext(reportId, { placeId, userId, now, deps } = {}) {
  try {
    if (!Number.isFinite(Number(reportId)) || typeof placeId !== 'string' || placeId.length === 0) {
      return { captured: false, reason: 'bad_args' };
    }
    const d = deps || {};
    const getWeather = d.getWeather || weatherService.getWeather;
    const getNearbyEvents = d.getNearbyEvents !== undefined ? d.getNearbyEvents : resolveEvents();
    const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();

    // Idempotency gate BEFORE any upstream spend: a re-capture of a report
    // that already has context must not touch the weather or event budgets.
    const { rows: existing } = await pool.query(
      'SELECT 1 FROM venue_owner_report_context WHERE report_id = $1',
      [reportId]
    );
    if (existing.length > 0) return { captured: false, reason: 'already_captured' };

    // The venue's identity: coordinates, clock, category. Outside the corpus
    // -> everything geo-dependent is NULL, and that is fine; the report row
    // itself still stands.
    let venue = null;
    try {
      const { rows } = await pool.query(
        `SELECT latitude, longitude, timezone, venue_category
           FROM ml_venues WHERE google_place_id = $1`,
        [placeId]
      );
      venue = rows[0] || null;
    } catch (err) {
      quiet('venue lookup', err);
    }

    const lat = venue ? Number(venue.latitude) : NaN;
    const lon = venue ? Number(venue.longitude) : NaN;
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);

    // Weather and events in parallel, each failing alone.
    let weather = null;
    let events = null;
    if (hasCoords) {
      [weather, events] = await Promise.all([
        Promise.resolve()
          .then(() => getWeather(lat, lon, userId ? { userId } : {}))
          .catch((err) => { quiet('weather', err); return null; }),
        // A THROW IS A FAILED LOOKUP, NOT AN UNATTEMPTED ONE. Returning null
        // here would file it under "no coordinates, nobody looked"; it belongs
        // with the other refusals, named, so the audit can see it.
        getNearbyEvents
          ? Promise.resolve()
              .then(() => getNearbyEvents(lat, lon, at, userId))
              .catch((err) => {
                quiet('events', err);
                return { observed: false, unavailableReason: 'lookup_threw' };
              })
          : Promise.resolve(null),
      ]);
    }

    // The venue's own clock, resolved BEFORE the serve read rather than after
    // it: the clock is both a stored column and the thing the serve now has to
    // agree with.
    const clock = venue?.timezone ? localClock(at, venue.timezone) : null;

    // The last number Flock actually published for this venue AT THIS HOUR.
    // Read from the serve log (032), never recomputed, and filtered by 038's
    // provenance allowlist so a score a caller engineered through POST
    // /api/crowd/batch cannot become this label's context. See the long note
    // on SERVED_LOOKUP_SQL.
    //
    // No clock, no lookup: there is nothing to match against, and the newest
    // row would be exactly the unverifiable figure the filter exists to refuse.
    let served = null;
    if (clock) {
      try {
        const { rows } = await pool.query(SERVED_LOOKUP_SQL, [placeId, clock.dayOfWeek, clock.hour]);
        served = rows[0] || null;
      } catch (err) {
        quiet('served prediction', err);
      }
    }

    // Three-state read of the event lookup. See readEvents: only `observed`
    // true produces numbers, and the reason a failure gives is stored beside
    // the NULLs so the corpus can be audited later.
    const ev = readEvents(events);

    await pool.query(INSERT_CONTEXT_SQL, [
      reportId,
      weather?.temp ?? null,
      weather?.feelsLike ?? null,
      weather?.humidity ?? null,
      weather?.windSpeed ?? null,
      weather?.conditions ?? null,
      weather?.conditionId ?? null,
      weather ? weather.isRaining === true : null,
      ev.observed === true ? ev.data.hasEvent === true : null,
      ev.observed === true ? ev.data.totalEvents ?? null : null,
      ev.observed === true ? ev.data.totalAttendance ?? null : null,
      // Distance/attendance/type of the NEAREST event only mean something
      // when there is one; getNearbyEvents fills 0s into its no-event shape
      // and storing those would fabricate "an event 0 km away".
      ev.observed === true && ev.data.hasEvent ? ev.data.nearestDistance ?? null : null,
      ev.observed === true && ev.data.hasEvent ? ev.data.nearestAttendance ?? null : null,
      ev.observed === true && ev.data.hasEvent ? ev.data.nearestType ?? null : null,
      served?.id ?? null,
      served?.score ?? null,
      served?.prediction_method ?? null,
      served?.model_version ?? null,
      served?.served_at ?? null,
      clock?.dayOfWeek ?? null,
      clock?.hour ?? null,
      venue?.timezone ?? null,
      venue?.venue_category ?? null,
      ev.observed,
      ev.reason,
    ]);
    return { captured: true };
  } catch (err) {
    // The report already stands; the context is best-effort telemetry.
    console.error('[OwnerReportContext] capture failed (report unaffected):', err?.message || err);
    return { captured: false, reason: 'error' };
  }
}

module.exports = {
  captureOwnerReportContext,
  readEvents,
  localClock,
  SERVE_JOIN_WINDOW_HOURS,
  INSERT_CONTEXT_SQL,
  SERVED_LOOKUP_SQL,
};
