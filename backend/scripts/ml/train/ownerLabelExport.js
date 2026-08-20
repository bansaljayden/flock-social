// ===========================================================================
// ROUND 24 — venue_owner_reports as LABELS. Export-only, owner-median anchored.
//
// The owner's 0-100 slider (migration 031, routes/venueDashboard.js /busy-now)
// exists twice over: once as tonight's published number, and once as the only
// LIVE 0-100 label source the plan has — BestTime froze 2026-05-18, and the
// 3-level user report cannot locate the centre of a 20-point window
// (MODEL-EPOCH-FINDING.md: the per-venue calibration layer measures +1.661pp
// on real 0-100 observations and +0.122pp, CI straddling zero, on the 3-level
// scale). This module is the second half: each reading becomes a training row.
//
// THE OWNER-MEDIAN ANCHOR, which is the whole design.
//
// An owner is a single self-interested reporter. "Packed" is social proof and
// "quiet, come now" fills seats; both inflate or deflate the ABSOLUTE level,
// and no floor-of-three can fix it because there is only ever one owner. So
// the absolute level is simply not taken from them:
//
//   busyness_pct = clamp(0..100, baseline_busyness + (busy_percent - owner_median))
//
// where owner_median is the median of that venue's own usable readings. The
// model trains on deltas against the served baseline (label_type 'delta', see
// services/mlPredictor.js), so this row teaches exactly
// `busy_percent - owner_median`: the owner's reading RELATIVE TO THEIR OWN
// TYPICAL CLAIM. An owner who always says 90 contributes zero delta on every
// row — constant inflation cancels out of the label entirely — while an owner
// who honestly tracks their room contributes its real dynamics. The anchor
// needs a real median to mean anything, hence the floor: at least
// MIN_OWNER_REPORTS_FOR_ANCHOR readings across MIN_OWNER_REPORT_DAYS distinct
// venue-local dates before a single row leaves this path.
//
// WHAT THIS PATH MUST NEVER DO: feed serving. ml_venue_baselines is the
// anchor production serves against; a self-report that could reach it would
// let an owner steer the model's baseline as well as tonight's number. This
// module writes CSV rows and nothing else — it runs on the export's read-only
// pool (default_transaction_read_only=on), so a write is a 25006, not a risk.
//
// ROWS EXCLUDED AT SOURCE: retracted = true (the owner withdrew the claim)
// and diverged = true (three or more verified user reporters contradicted it
// while it was live — routes/crowd.js stamps it via services/ownerReports.js).
// A reading real people falsified is not a label.
//
// HANDOFF — prepare_features.py MUST change before an 'owner_report' row can
// train, and this file may not make that change (the retrain agent owns it):
//   1. LABEL_SOURCE_VALUES must gain 'owner_report' and derive_label_provenance
//      must recognise it, or enforce_label_contract raises on the first row.
//   2. The sample-weight ladder must gain a tier for it: OWNER_LABEL_WEIGHT
//      (0.10). The argument: above a weekly snapshot (0.05 — not about the
//      moment at all) and below the user_report tier argued at 0.15, because a
//      user_report row is three or more verified strangers agreeing and this
//      is ONE reporter whose incentives point at the number, with only the
//      median anchor between them and the label. Without the tier, the ladder's
//      `is_realtime != 1 -> 0.05, forecast -> 0.3, else 1.0` would hand an
//      owner's tap MORE weight than a live BestTime observation.
// Until both land, an 'owner_report' row stops prepare_features.py by name.
// That interlock is deliberate — same as round 23's — and must not be softened
// from this side.
// ===========================================================================

const { getSeason, isHoliday, isSchoolBreak } = require('../config');

// Written into label_source / label_provenance for these rows. Deliberately
// NOT a value migration 025's CHECK allows: nothing may ever write it into
// ml_training_data itself. It exists only in the export.
const OWNER_LABEL_SOURCE = 'owner_report';

// The sample-weight tier argued for in the handoff above. Not read by this
// file (weights are prepare_features.py's job); exported and pinned by
// __tests__/ownerBusyReports.test.js so the number the handoff argues for and
// the number the docs quote cannot drift apart.
const OWNER_LABEL_WEIGHT = 0.10;

const OWNER_ENABLE_ENV = 'FLOCK_EXPORT_OWNER_LABELS';

// The anchor floor. A median of two readings is one outlier away from being
// either of them; five readings across three different venue-local dates is
// the first shape where "this owner's typical claim" is a statement about the
// owner rather than about one evening.
const MIN_OWNER_REPORTS_FOR_ANCHOR = 5;
const MIN_OWNER_REPORT_DAYS = 3;

// Same memory-grouping assumption as the feedback path, same refusal when it
// expires. The write path caps owners at 48 readings a day, so this is years
// of headroom.
const OWNER_ROW_CAP = 500000;

function ownerExportRequested(env = process.env) {
  const v = env[OWNER_ENABLE_ENV];
  return v === '1' || v === 'true' || v === 'yes';
}

const OWNER_EXCLUSION_REASONS = {
  no_observation_date: { kind: 'absence', why: 'created_at is NULL, so the venue-local date of the reading is unknowable' },
  no_venue_attributes: { kind: 'absence', why: 'the venue has no ml_training_data row, so it has no venue_category and cannot be featurised' },
  below_anchor_floor: { kind: 'absence', why: `fewer than ${MIN_OWNER_REPORTS_FOR_ANCHOR} usable readings across ${MIN_OWNER_REPORT_DAYS} distinct venue-local dates; the owner-median anchor is not a median yet` },
  unusable_percent: { kind: 'corrupt', why: "busy_percent is outside the table's CHECK domain of 0-100, so something wrote past the constraint" },
};

// One candidate row per non-retracted, non-diverged reading at a corpus venue,
// clocked on the VENUE's wall (same contract as every other exporter: the hour
// column is the venue-local hour or the row does not exist). Verified claims
// only, enforced at the source the way the feedback query enforces
// verified = true: the write path already refuses unverified venues, and this
// join is what keeps that true for rows written before a venue lost its badge.
function ownerCandidateQuery(city, baselineAggregateSql) {
  return {
    text: `
      SELECT
        r.id           AS report_id,
        r.busy_percent,
        r.created_at,
        lc.dow         AS day_of_week,
        lc.hr          AS hour,
        lc.local_date,
        v.id           AS venue_id,
        v.city,
        v.google_place_id,
        v.google_types, v.latitude, v.longitude,
        a.venue_category, a.price_level, a.rating, a.review_count,
        COALESCE(b.baseline, 0) AS baseline_busyness
      FROM (SELECT * FROM venue_owner_reports
             WHERE retracted = false AND diverged = false) r
      JOIN venue_profiles vp   ON vp.google_place_id = r.google_place_id AND vp.verified = true
      JOIN ml_venues v         ON v.google_place_id = r.google_place_id
      JOIN pg_timezone_names z ON z.name = v.timezone
      CROSS JOIN LATERAL (
        SELECT EXTRACT(DOW  FROM (r.created_at AT TIME ZONE z.name))::int AS dow,
               EXTRACT(HOUR FROM (r.created_at AT TIME ZONE z.name))::int AS hr,
               to_char(r.created_at AT TIME ZONE z.name, 'YYYY-MM-DD')    AS local_date
      ) lc
      LEFT JOIN LATERAL (
        SELECT t.venue_category, t.price_level, t.rating, t.review_count
          FROM ml_training_data t
         WHERE t.venue_id = v.id
         ORDER BY t.collected_at DESC NULLS LAST, t.id DESC
         LIMIT 1
      ) a ON true
      LEFT JOIN (${baselineAggregateSql}
      ) b
        ON b.google_place_id = v.google_place_id
       AND b.day_of_week = lc.dow
       AND b.hour = lc.hr
      WHERE v.city = $1
      ORDER BY v.id, r.created_at
    `,
    values: [city],
  };
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Group readings per venue, then one cell per (dow, hour, local_date) with the
// NEWEST reading in the cell — an owner nudging the slider three times in one
// hour is one opinion about one moment, exactly the one-vote-per-account rule
// the feedback path keeps, applied to the only account there is.
function groupOwnerVenues(rows) {
  const venues = new Map();
  for (const row of rows) {
    let v = venues.get(row.venue_id);
    if (!v) {
      v = { venue_id: row.venue_id, cells: new Map() };
      venues.set(row.venue_id, v);
    }
    const key = `${row.day_of_week}|${row.hour}|${row.local_date}`;
    const prev = v.cells.get(key);
    const at = row.created_at ? new Date(row.created_at).getTime() : 0;
    if (!prev || at >= prev.at) v.cells.set(key, { row, at });
  }
  return [...venues.values()];
}

// One venue's cells -> training rows, or the reasons why not. The anchor is
// computed over the venue's USABLE cells (one per venue-hour-date), so a burst
// of same-hour updates cannot drag the median toward one evening.
function ownerVenueToTrainingRows(venueGroup) {
  const cells = [...venueGroup.cells.values()].map((c) => c.row);
  const excluded = [];
  const usable = [];

  for (const row of cells) {
    const pct = Number(row.busy_percent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      excluded.push({ reason: 'unusable_percent', row, detail: row.busy_percent });
      continue;
    }
    if (!row.local_date) {
      excluded.push({ reason: 'no_observation_date', row });
      continue;
    }
    if (row.venue_category == null || row.venue_category === '') {
      excluded.push({ reason: 'no_venue_attributes', row });
      continue;
    }
    usable.push(row);
  }

  const distinctDays = new Set(usable.map((r) => r.local_date));
  if (usable.length < MIN_OWNER_REPORTS_FOR_ANCHOR || distinctDays.size < MIN_OWNER_REPORT_DAYS) {
    for (const row of usable) excluded.push({ reason: 'below_anchor_floor', row });
    return { rows: [], excluded, anchored: 0 };
  }

  const ownerMedian = median(usable.map((r) => Number(r.busy_percent)));

  const rows = usable.map((meta) => {
    const anchoredLabel = Math.max(0, Math.min(100, Math.round(
      Number(meta.baseline_busyness) + (Number(meta.busy_percent) - ownerMedian)
    )));
    const month = Number(meta.local_date.slice(5, 7));
    return {
      venue_id: meta.venue_id,
      day_of_week: meta.day_of_week,
      hour: meta.hour,
      month,
      season: getSeason(month),
      is_holiday: isHoliday(meta.local_date),
      is_school_break: isSchoolBreak(meta.local_date),
      venue_category: meta.venue_category,
      price_level: meta.price_level,
      rating: meta.rating,
      review_count: meta.review_count,
      // NO WEATHER, NO EVENTS — nothing was recorded at the moment the reading
      // describes and neither is recoverable. Empty, never 0: same doctrine and
      // same known prepare_features fillna blocker as the feedback path.
      temperature: null,
      humidity: null,
      wind_speed: null,
      weather_condition: null,
      weather_condition_code: null,
      is_raining: false,
      event_nearby: false,
      event_distance_km: null,
      event_size: null,
      event_type: null,
      event_hours_until: null,
      has_nearby_event: false,
      nearest_event_distance_km: null,
      nearest_event_attendance: null,
      total_nearby_events: null,
      total_nearby_attendance: null,
      nearest_event_type: null,
      baseline_busyness: meta.baseline_busyness,
      // An owner's reading is an observation of ONE MOMENT. is_realtime=1 is
      // the truthful value; what separates it from a BestTime live row is
      // label_provenance, which is what the weight ladder keys on.
      collection_mode: 'realtime',
      busyness_pct: anchoredLabel,
      city: meta.city,
      google_types: meta.google_types,
      latitude: meta.latitude,
      longitude: meta.longitude,
      // The feedback-as-feature channel is OFF for these rows, same reasoning
      // as the feedback path: empty records "not supplied".
      avg_user_crowd: null,
      user_feedback_count: null,
      avg_prediction_error: null,
      stored_observed_date: meta.local_date,
      label_source: OWNER_LABEL_SOURCE,
      vendor_forecast_pct: null,
    };
  });

  return { rows, excluded, anchored: usable.length, ownerMedian };
}

// Runs per city inside the export's own loop. `deps` carries the two things
// this module deliberately does not own: rowToCsv (the 44-column contract has
// ONE writer) and BASELINE_AGGREGATE_SQL (the anchor has ONE definition).
// Passed in rather than required back to keep the module graph acyclic.
async function exportOwnerCity(pool, city, stream, counters, deps) {
  const { rowToCsv, baselineAggregateSql, write } = deps;
  const q = ownerCandidateQuery(city, baselineAggregateSql);
  const client = await pool.connect();
  let rows;
  try {
    await client.query('BEGIN READ ONLY');
    ({ rows } = await client.query(q.text, q.values));
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already gone */ }
    throw err;
  } finally {
    client.release();
  }

  counters.candidates += rows.length;
  if (counters.candidates > OWNER_ROW_CAP) {
    const err = new Error(
      `REFUSED: more than ${OWNER_ROW_CAP} owner-reading candidate rows. This path groups `
      + 'them in memory on the assumption that owner readings stay orders of magnitude below '
      + 'the vendor corpus. Move the grouping into SQL rather than raising this cap.'
    );
    err.code = 'OWNER_ROW_CAP';
    throw err;
  }

  let chunk = '';
  for (const venueGroup of groupOwnerVenues(rows)) {
    const out = ownerVenueToTrainingRows(venueGroup);
    for (const ex of out.excluded) {
      counters.excluded[ex.reason] = (counters.excluded[ex.reason] || 0) + 1;
      if (OWNER_EXCLUSION_REASONS[ex.reason].kind === 'corrupt') {
        counters.corrupt.push({ reason: ex.reason, city, venueId: venueGroup.venue_id, detail: ex.detail });
      }
    }
    if (out.rows.length > 0) {
      counters.emitted += out.rows.length;
      counters.anchoredVenues += 1;
      for (const row of out.rows) chunk += rowToCsv(row) + '\n';
    }
  }
  if (chunk) {
    const backpressure = write(stream, chunk);
    if (backpressure) await backpressure;
  }
  return counters;
}

function newOwnerCounters() {
  return { candidates: 0, emitted: 0, anchoredVenues: 0, excluded: {}, corrupt: [] };
}

// The census, run on EVERY export whether the path is enabled or not — the
// number that matters is the day it stops being zero, and the only way that
// day gets noticed is if the export says so out loud every time.
async function ownerCensus(db) {
  try {
    const { rows: [row] } = await db.query(
      `SELECT COUNT(*)::bigint AS readings,
              COUNT(*) FILTER (WHERE retracted)::bigint AS retracted,
              COUNT(*) FILTER (WHERE diverged)::bigint  AS diverged,
              COUNT(DISTINCT google_place_id)::bigint   AS venues
         FROM venue_owner_reports`
    );
    return { available: true, ...row };
  } catch {
    // Pre-migration-031 database: the table does not exist yet.
    return { available: false };
  }
}

module.exports = {
  OWNER_LABEL_SOURCE,
  OWNER_LABEL_WEIGHT,
  OWNER_ENABLE_ENV,
  MIN_OWNER_REPORTS_FOR_ANCHOR,
  MIN_OWNER_REPORT_DAYS,
  OWNER_ROW_CAP,
  OWNER_EXCLUSION_REASONS,
  ownerExportRequested,
  ownerCandidateQuery,
  groupOwnerVenues,
  ownerVenueToTrainingRows,
  exportOwnerCity,
  newOwnerCounters,
  ownerCensus,
  median,
};
