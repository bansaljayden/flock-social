// ---------------------------------------------------------------------------
// Build venue baselines from collected weekly data
// Populates ml_venue_baselines table — 168 rows per venue (7 days x 24 hours)
// Run: node scripts/ml/buildBaselines.js
//
// THIS FILE IS THE ONLY DEFINITION OF A `source = 'collected'` BASELINE.
// It used to be one of two. scripts/ml/collectRealtime.js ended every run with
// its own hand-written refresh that omitted the `collection_mode = 'weekly'`
// filter this file has applied since it was written, so it averaged weekly
// forecast rows and live realtime readings into the same slot — and, once the
// hour axes of the two collectors diverged (see THE HOUR AXIS in
// collectWeekly.js), averaged two different clocks into the same slot. Which
// blend a venue's baseline held depended on which script had run last.
// collectRealtime.js now calls refreshCollectedBaselines() from here, so there
// is one statement and it cannot drift again.
//
// AXIS. Only rows that DECLARE `hour_axis = 'venue_local'` are averaged.
// ml_venue_baselines.hour is read by services/mlPredictor.js as a venue wall
// clock hour, so a row that has not been converted by migration 023 must not
// contribute — silently producing a baseline off by six hours is what this
// whole change exists to end. If any weekly row is still undeclared the refresh
// REFUSES rather than building a partial answer.
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { withCorpusWriteLock } = require('./config');

// The axis a baseline-eligible row must declare. Mirrors
// collectWeekly.HOUR_AXIS_VENUE_LOCAL and the value migration 023 stamps.
const HOUR_AXIS_VENUE_LOCAL = 'venue_local';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ml_venue_baselines (
    google_place_id VARCHAR(255) NOT NULL,
    day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    hour SMALLINT NOT NULL CHECK (hour BETWEEN 0 AND 23),
    baseline SMALLINT NOT NULL DEFAULT 0,
    source VARCHAR(20) NOT NULL DEFAULT 'collected',
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (google_place_id, day_of_week, hour)
  );
`;

// Is there a weekly row whose hour column is not a venue-local hour (or does
// not say)? EXISTS, not COUNT: ml_training_data is ~4M rows and this runs at
// the end of every realtime cron.
const UNDECLARED_WEEKLY_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM ml_training_data
    WHERE collection_mode = 'weekly'
      AND (hour_axis IS DISTINCT FROM '${HOUR_AXIS_VENUE_LOCAL}')
  ) AS undeclared
`;

// Collected slots that no longer have any backing weekly row. Migration 023
// PERMUTES the (day_of_week, hour) keys of the corpus, so without this a venue
// whose weekly coverage has holes keeps stale rows at the keys the old axis
// used, and mlPredictor happily serves them. Restricted to source='collected':
// mlPredictor.storeGoogleBaselines writes source='google' rows from Google
// popular_times, which are on the venue-local axis already and are not ours.
const DELETE_STALE_SQL = `
  DELETE FROM ml_venue_baselines b
  WHERE b.source = 'collected'
    AND NOT EXISTS (
      SELECT 1
      FROM ml_training_data t
      JOIN ml_venues v ON t.venue_id = v.id
      WHERE v.google_place_id = b.google_place_id
        AND t.day_of_week = b.day_of_week
        AND t.hour = b.hour
        AND t.collection_mode = 'weekly'
        AND t.hour_axis = '${HOUR_AXIS_VENUE_LOCAL}'
        AND t.busyness_pct IS NOT NULL
    )
`;

// The baseline itself: per (venue, weekday, venue-local hour) average of the
// weekly forecast rows. The `WHERE ... IS DISTINCT FROM` on the conflict target
// suppresses no-op rewrites, so a second run of this file writes literally
// nothing — re-running it is free and leaves the table byte-identical.
//
// `updated_at` IS THE DATE OF THE EVIDENCE, NOT THE DATE OF THE WRITE.
//
// It used to be NOW(), and the churn suppression below meant NOW() only ever
// landed when the average actually MOVED. So the column recorded when this
// venue's number last changed, and mlPredictor.baselineMeta publishes it as
// how old the data under the number is — two different questions with the same
// answer only by accident.
//
// The consequence ran the wrong way round. A venue whose weekly pattern is
// stable is the healthy case, and it is the case that never trips the WHERE:
// re-collected every week, re-averaged to the same number every week, and
// stamped `stale: true` after ninety days of being confirmed. Meanwhile a venue
// whose average wobbles by one point looks permanently fresh. The flag was
// strongest exactly where it should have been quietest.
//
// MAX(collected_at) is the newest row that fed the average, which is the honest
// answer: this number is supported by evidence gathered up to that moment.
// NULL when nothing in the group carries a collection time, and NULL is
// deliberate — baselineMeta reads it as `stale: null`, "nothing to say", which
// is true. NOW() would have been a claim about data we cannot date.
//
// THE STAMP MOVES ONLY WITH THE VALUE IT DESCRIBES. Whenever the row is
// written, updated_at is EXCLUDED.updated_at, the evidence date of the value
// being written, and nothing else. It used to be GREATEST(old stamp, new
// evidence), kept so that a row migration 023 had stamped with NOW() on
// 2026-08-15 would not move backwards. That made (baseline, updated_at) two
// facts from two different moments: a value that changed because rows moved
// under it (the venue repair does exactly that) kept the older, newer-looking
// stamp; and two refreshes running at once could publish the OLDER value with
// the NEWER stamp, because the value was overwritten whenever it differed
// while the stamp took the maximum on its own. The date of the evidence is
// what the column means, so a value whose evidence is older than the stamp it
// replaces gets the older date, and baselineMeta says stale sooner rather than
// claiming freshness the rows cannot support.
//
// THE COST ARGUMENT WAS NEVER ABOUT GREATEST. What stops a mass rewrite of the
// ~3.45M migration-stamped rows is the WHERE below, which is unchanged: a row
// is written only when its value differs or its evidence is newer. Rows whose
// value and evidence both stand still are not touched, whatever their stamp.
//
// Re-running stays free. If no new weekly row arrived, MAX(collected_at) has
// not moved either, so neither clause of the WHERE fires and the row is
// untouched - which is what mlClockAxisBackfill.test.js pins.
const UPSERT_SQL = `
  INSERT INTO ml_venue_baselines (google_place_id, day_of_week, hour, baseline, source, updated_at)
  SELECT
    v.google_place_id,
    t.day_of_week,
    t.hour,
    ROUND(AVG(t.busyness_pct))::smallint,
    'collected',
    MAX(t.collected_at)
  FROM ml_training_data t
  JOIN ml_venues v ON t.venue_id = v.id
  WHERE t.collection_mode = 'weekly'
    AND t.hour_axis = '${HOUR_AXIS_VENUE_LOCAL}'
    AND t.busyness_pct IS NOT NULL
  GROUP BY v.google_place_id, t.day_of_week, t.hour
  ON CONFLICT (google_place_id, day_of_week, hour)
  DO UPDATE SET
    baseline = EXCLUDED.baseline,
    updated_at = EXCLUDED.updated_at
  WHERE ml_venue_baselines.baseline IS DISTINCT FROM EXCLUDED.baseline
     OR EXCLUDED.updated_at > COALESCE(ml_venue_baselines.updated_at, 'epoch'::timestamptz)
`;

// Rebuild every source='collected' baseline from the corrected weekly corpus.
// Safe to call any number of times, from anywhere, in any order.
// Returns { ok, undeclared, deleted, upserted }.
//
// SERIALIZED. The check, the delete and the upsert run in one transaction
// under the corpus write lock (config.withCorpusWriteLock), the same lock the
// collectors and the venue repair take. collectRealtime.js calls this at the
// end of every hourly run and buildBaselines.js is run by hand after a repair,
// so two refreshes can overlap, and two overlapping refreshes were how an
// older value could be published under a newer stamp: each is one statement
// over its own snapshot, and the later-started one can commit first. Under
// the lock the second refresh starts after the first commits and reads a
// corpus at least as new, so the newest snapshot is always the last written.
// The DDL stays outside the transaction; it is IF NOT EXISTS and takes no
// part in the race.
async function refreshCollectedBaselines(pool) {
  await pool.query(CREATE_TABLE_SQL);
  // Both columns are created by migration 023 on a booted server; these scripts
  // also run against databases that have not booted the current server.
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS hour_axis VARCHAR(16)`);

  return withCorpusWriteLock(pool, async (client) => {
    const { rows: [{ undeclared }] } = await client.query(UNDECLARED_WEEKLY_SQL);
    if (undeclared) {
      return { ok: false, undeclared: true, deleted: 0, upserted: 0 };
    }

    const del = await client.query(DELETE_STALE_SQL);
    const up = await client.query(UPSERT_SQL);
    return { ok: true, undeclared: false, deleted: del.rowCount, upserted: up.rowCount };
  });
}

const REFUSAL_MESSAGE =
  'REFUSED: ml_training_data still holds weekly rows that do not declare '
  + `hour_axis = '${HOUR_AXIS_VENUE_LOCAL}'. Their hour column is a BestTime array index, `
  + 'six hours off the venue clock — averaging them into ml_venue_baselines is the bug this '
  + 'guard exists to prevent. Apply migration 023_backfill_ml_weekly_local_hours.sql '
  + '(it runs on server boot) and re-run.';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // An explicit PGSSLMODE wins — see config/database.js.
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });

  try {
    console.log('[Baselines] Computing from weekly collection data (venue-local axis)...');
    const result = await refreshCollectedBaselines(pool);

    if (!result.ok) {
      console.error(`[Baselines] ${REFUSAL_MESSAGE}`);
      process.exitCode = 1;
      return;
    }

    console.log(`[Baselines] Removed ${result.deleted} stale slots, wrote ${result.upserted} changed slots`);

    const { rows: [stats] } = await pool.query(`
      SELECT COUNT(DISTINCT google_place_id) AS venues, COUNT(*) AS slots
      FROM ml_venue_baselines
    `);
    console.log(`[Baselines] ${stats.venues} venues, ${stats.slots} total slots`);
  } finally {
    await pool.end();
  }
}

module.exports = {
  refreshCollectedBaselines,
  REFUSAL_MESSAGE,
  HOUR_AXIS_VENUE_LOCAL,
  DELETE_STALE_SQL,
  UPSERT_SQL,
};

if (require.main === module) {
  main().catch(err => {
    console.error('[Baselines] Error:', err);
    process.exit(1);
  });
}
