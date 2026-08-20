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
//     a venue outside ml_venues, a missing serve record — each is a quiet log
//     line and a NULL, never a lost report and never a lost capture of the
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
// record what the model WOULD say now, not what users actually saw.
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

const INSERT_CONTEXT_SQL = `
  INSERT INTO venue_owner_report_context (
    report_id,
    temperature, feels_like, humidity, wind_speed,
    weather_condition, weather_condition_code, is_raining,
    has_nearby_event, total_nearby_events, total_nearby_attendance,
    nearest_event_distance_km, nearest_event_attendance, nearest_event_type,
    served_prediction_id, served_score, served_prediction_method,
    served_model_version, served_at,
    day_of_week, hour, timezone, venue_category
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
            $15, $16, $17, $18, $19, $20, $21, $22, $23)
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
        getNearbyEvents
          ? Promise.resolve()
              .then(() => getNearbyEvents(lat, lon, at, userId))
              .catch((err) => { quiet('events', err); return null; })
          : Promise.resolve(null),
      ]);
    }

    // The last number Flock actually published for this venue. Read from the
    // serve log (032), never recomputed.
    let served = null;
    try {
      const { rows } = await pool.query(
        `SELECT id, score, prediction_method, model_version, served_at
           FROM served_predictions
          WHERE venue_place_id = $1
            AND served_at > NOW() - INTERVAL '${SERVE_JOIN_WINDOW_HOURS} hours'
          ORDER BY served_at DESC
          LIMIT 1`,
        [placeId]
      );
      served = rows[0] || null;
    } catch (err) {
      quiet('served prediction', err);
    }

    const clock = venue?.timezone ? localClock(at, venue.timezone) : null;

    await pool.query(INSERT_CONTEXT_SQL, [
      reportId,
      weather?.temp ?? null,
      weather?.feelsLike ?? null,
      weather?.humidity ?? null,
      weather?.windSpeed ?? null,
      weather?.conditions ?? null,
      weather?.conditionId ?? null,
      weather ? weather.isRaining === true : null,
      events ? events.hasEvent === true : null,
      events ? events.totalEvents ?? null : null,
      events ? events.totalAttendance ?? null : null,
      // Distance/attendance/type of the NEAREST event only mean something
      // when there is one; getNearbyEvents fills 0s into its no-event shape
      // and storing those would fabricate "an event 0 km away".
      events?.hasEvent ? events.nearestDistance ?? null : null,
      events?.hasEvent ? events.nearestAttendance ?? null : null,
      events?.hasEvent ? events.nearestType ?? null : null,
      served?.id ?? null,
      served?.score ?? null,
      served?.prediction_method ?? null,
      served?.model_version ?? null,
      served?.served_at ?? null,
      clock?.dayOfWeek ?? null,
      clock?.hour ?? null,
      venue?.timezone ?? null,
      venue?.venue_category ?? null,
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
  localClock,
  SERVE_JOIN_WINDOW_HOURS,
  INSERT_CONTEXT_SQL,
};
