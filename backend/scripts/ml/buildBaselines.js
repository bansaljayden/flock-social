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
// is one definition (FRESH_SQL's average) and it cannot drift again.
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

// THE REBUILD'S MARK (2026-10-31): the newest venue stamp the last rebuild
// saw, one row, written in the rebuild's own transaction. collectedBaselinesDue
// compares the corpus's stamps with it. Created here, beside the table it
// describes, for the same reason that one is.
const MARK_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ml_baseline_marks (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    corpus_at TIMESTAMPTZ,
    rebuilt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;
// HARVESTED VENUES DO NOT MOVE THE STAMP (2026-11-18). The every-city harvest
// writes a city's new venues ('harvested', inactive; harvestVenueFilter.js) in
// one commit, 500,000 to 1,700,000 weekly rows, and each commit made the next
// hourly run's tail rebuild them all: 638,568 rows took 43 minutes and
// 1,279,320 as long, past the next :07, and Railway skips a cron fire while the
// last one is still running. That day lost the 11:00, 13:00, 20:00 and 22:00 UTC
// sweeps, about 4,000 live readings each, with twenty cities still to go. A
// harvested venue is out of the hourly sweep and out of the neighbour box, so
// nothing served waits on its baseline but its own score. From 2026-11-19 to
// 2026-11-21 the daily rebuild (DAILY_REBUILD_UTC_HOUR), THE TARGETED REBUILD
// below, picked harvested venues up too; since then the collector's rebuilds
// pass includeHarvested false and leave them out until the ship step
// (HARVESTED VENUES' CURVES WAIT FOR THE SHIP STEP, below), and only
// `node scripts/ml/buildBaselines.js --targeted` by hand averages them, in
// short transactions. A promoted venue
// (out of 'harvested') moves no row, so it needs nothing new once its
// baseline exists. (Most of those minutes turned out to be the rebuild's own
// statement, which wrote to every row of the table: ONLY THE ROWS THAT
// CHANGE ARE TOUCHED, below.)
const CORPUS_STAMP_SQL = `SELECT MAX(last_collected_at) AS corpus_at FROM ml_venues
                           WHERE besttime_status IS DISTINCT FROM 'harvested'`;

// Is there a weekly row whose hour column is not a venue-local hour (or does
// not say)? EXISTS, not COUNT. The full rebuild asks it of the whole corpus
// (40 s on production, 2026-11-19); the targeted one asks it of each chunk's
// venues (UNDECLARED_PLACES_SQL).
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
// A slot has a backing row exactly when the average has a group for it, so
// this reads the average (FRESH_SQL, below) rather than the corpus a second
// time; migration 023 runs the same test against the corpus directly.
const DELETE_STALE_SQL = `
  DELETE FROM ml_venue_baselines b
  WHERE b.source = 'collected'
    AND NOT EXISTS (
      SELECT 1
      FROM baseline_fresh f
      WHERE f.google_place_id = b.google_place_id
        AND f.day_of_week = b.day_of_week
        AND f.hour = b.hour
    )
`;

// The baseline itself: per (venue, weekday, venue-local hour) average of the
// weekly forecast rows. The `WHERE ... IS DISTINCT FROM` of UPDATE_CHANGED_SQL
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
// written, updated_at is the average's own MAX(collected_at), the evidence
// date of the value being written, and nothing else. It used to be GREATEST(old stamp, new
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
// ~3.45M migration-stamped rows is the WHERE of UPDATE_CHANGED_SQL: a row is
// written only when its value differs or its evidence is newer. Rows whose
// value and evidence both stand still are not touched, whatever their stamp.
//
// Re-running stays free. If no new weekly row arrived, MAX(collected_at) has
// not moved either, so neither clause of the WHERE fires and the row is
// untouched - which is what mlClockAxisBackfill.test.js pins.
//
// ONLY THE ROWS THAT CHANGE ARE TOUCHED (2026-11-19). This was one statement,
// INSERT ... SELECT ... ON CONFLICT DO UPDATE ... WHERE <the row changed>, and
// Postgres locks every conflicting row before it evaluates that WHERE ("all
// rows will be locked when the ON CONFLICT DO UPDATE action is taken", the
// INSERT documentation). A row lock is a write, to the row's header and to the
// WAL, so every rebuild wrote to every row of the table even when it changed
// none, and its cost grew with the table, not with the change: about three
// minutes at ~3.5M rows in October, 43 to 60 minutes at 7 to 10M on 2026-11-18
// (blamed then on the harvest's new rows), and on 2026-11-19 the daily rebuild
// over ~12M rows, with nearly nothing left to write, held the corpus lock from
// 09:03 UTC past 10:33, which skipped the 09:00 and 10:00 sweeps and held up
// the harvest's commit behind it. Now the average goes into a temporary table
// first (FRESH_SQL) and three statements read it: the DELETE removes slots it
// lacks, the UPDATE rewrites only rows whose value or evidence moved, and the
// INSERT adds only slots the table lacks. An UPDATE locks only the rows it
// writes, so a rebuild that changes nothing writes nothing. Same rows written,
// same values, same stamps: the old statement updated a slot whatever its
// source and inserted a missing one as 'collected', and so do these.
function averageSql(placeFilter = '') {
  return `
  SELECT
    v.google_place_id,
    t.day_of_week,
    t.hour,
    ROUND(AVG(t.busyness_pct))::smallint AS baseline,
    MAX(t.collected_at) AS updated_at
  FROM ml_training_data t
  JOIN ml_venues v ON t.venue_id = v.id
  WHERE t.collection_mode = 'weekly'
    AND t.hour_axis = '${HOUR_AXIS_VENUE_LOCAL}'
    AND t.busyness_pct IS NOT NULL${placeFilter}
  GROUP BY v.google_place_id, t.day_of_week, t.hour
`;
}
const FRESH_SQL = `
  CREATE TEMP TABLE baseline_fresh ON COMMIT DROP AS${averageSql()}`;

const UPDATE_CHANGED_SQL = `
  UPDATE ml_venue_baselines b
     SET baseline = f.baseline,
         updated_at = f.updated_at
    FROM baseline_fresh f
   WHERE b.google_place_id = f.google_place_id
     AND b.day_of_week = f.day_of_week
     AND b.hour = f.hour
     AND (b.baseline IS DISTINCT FROM f.baseline
          OR f.updated_at > COALESCE(b.updated_at, 'epoch'::timestamptz))
`;

const INSERT_NEW_SQL = `
  INSERT INTO ml_venue_baselines (google_place_id, day_of_week, hour, baseline, source, updated_at)
  SELECT f.google_place_id, f.day_of_week, f.hour, f.baseline, 'collected', f.updated_at
    FROM baseline_fresh f
   WHERE NOT EXISTS (
     SELECT 1 FROM ml_venue_baselines b
      WHERE b.google_place_id = f.google_place_id
        AND b.day_of_week = f.day_of_week
        AND b.hour = f.hour
   )
`;

// THE TARGETED REBUILD (2026-11-19). Without the row locks the full rebuild
// still READS the whole corpus: timed on production that day (15.5M slots,
// rolled back), 11 minutes to average every weekly row, 6 to find stale
// slots, 1 to find changed ones, 4 to find missing ones. Started at :56 it
// ends past the next :07, so every full rebuild at a run's tail costs the
// next sweep, and the corpus keeps growing. Most places cannot have changed.
// A weekly writer stamps the venue (last_collected_at) with the rows'
// own instant, and a rebuild stamps each slot with the newest row under it
// (updated_at), so a place needs averaging again exactly when a venue's
// stamp is newer than every slot's evidence, or when it has no slot at all.
// That compares a venue with its own baseline, so unlike the corpus mark it
// cannot be fooled by a write that waited on the lock and committed late
// under an early stamp (the Paris harvest's commit on 2026-11-19 waited from
// 09:03 to 11:41). That morning there were ~6,800 such places: 5,579
// harvested venues without a curve, 1,194 venues whose stamp sits 0.495 s
// after their rows, and a few dozen others (EACH VENUE ASKS ITS OWN SLOTS,
// below, for how they are found).
//
// ONE SECOND OF SLACK, PER VENUE. Those 1,194 were stamped by collectWeekly
// in a separate UPDATE after COMMIT, before it stamped in the rows' own
// transaction, so no rebuild can bring their evidence up to their stamp:
// without slack they were averaged on every targeted pass, about two minutes
// each time (500 of them took 49 s on production) to change nothing. A
// tolerance was wrong for the corpus mark (STAMPS AGAINST THE MARK, below),
// where it compares the newest stamp of all venues with a mark and hid a
// week written seconds after a rebuild. Here it compares one venue with its
// own evidence, and a venue's next week comes days after its last, never
// within a second.
//
// What it cannot see is what the corpus mark cannot see either: a weekly
// row deleted, or a place id remapped, with no stamp moving
// (repairBestTimeDiscoveredVenues.js). Those take the full rebuild, by hand
// as before, and collectedBaselinesDue asks for the full one when the
// newest stamp moves other than forward. So the hourly run's daily rebuild,
// and a rebuild for a newer stamp, average only the targets, in chunks of
// TARGET_CHUNK_PLACES places, each in its own short transaction under the
// corpus lock, so a collector write waits seconds, not the whole rebuild.
// Places whose venues serve the stamp go first; the mark is written once
// none of those is left. Harvested places are not in the stamp, so those
// left at the deadline are simply first in line next time.
//
// ONE VENUE PER PLACE. ml_venues.google_place_id is NOT NULL UNIQUE
// (migration 006), so a place's baselines average one venue's rows and that
// venue's stamp is the place's.
//
// NO STAMP, NO BASELINE, BUT WEEKLY ROWS: a target too. discoverBestTime.js
// commits a venue's week and stamps it in a separate statement after, so a
// run that dies between the two leaves rows no stamp points at. The full
// rebuild used to average them every day; this asks the weekly key's own
// partial index, once per unstamped venue without a baseline (12,535 venues
// had no stamp on 2026-11-19, none of them with such rows). A stamped venue
// whose rows are all NULL busyness stays a target and is averaged to nothing
// on every pass (a few dozen, seconds). What no stamp can show: a
// discoverBestTime run that rewrites a venue's EXISTING week and dies before
// its stamp leaves the old stamp beside new rows. That script runs only by
// hand; after a run that did not finish, run this file in full.
//
// EACH VENUE ASKS ITS OWN SLOTS (2026-11-19). The list was first a join
// against MAX(updated_at) grouped over the whole baseline table. At 16.5M
// rows Postgres planned that as an ordered scan of all of them and it ran
// past 90 s (the backlog drain's 18:03 UTC window got no further than the
// list). "No slot with evidence within a second of the stamp" is the same
// test as "stamp more than a second past the newest evidence", and the same
// for a place with no slot or only undated ones (compared as epoch seconds,
// exact numerics since Postgres 14, so no timestamp at either end of the
// range, nor infinity, can overflow the second), so each venue now asks
// its own place's slots through the place index: 32 s
// cold and 14 s warm on production that day, for 8,277 targets.
const TARGETS_SQL = `
  SELECT v.google_place_id,
         v.besttime_status IS DISTINCT FROM 'harvested' AS stamped
    FROM ml_venues v
   WHERE (v.last_collected_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ml_venue_baselines b
             WHERE b.google_place_id = v.google_place_id
               AND EXTRACT(EPOCH FROM b.updated_at) + 1 >= EXTRACT(EPOCH FROM v.last_collected_at)))
      OR (v.last_collected_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ml_venue_baselines b
             WHERE b.google_place_id = v.google_place_id
               AND b.updated_at IS NOT NULL)
          AND EXISTS (
            SELECT 1 FROM ml_training_data t
             WHERE t.venue_id = v.id
               AND t.collection_mode = 'weekly'
               AND t.hour_axis = '${HOUR_AXIS_VENUE_LOCAL}'
               AND t.busyness_pct IS NOT NULL))
   ORDER BY stamped DESC, v.last_collected_at NULLS LAST, v.google_place_id
`;
// 250 places is ~40,000 slots: about 25 s on cold pages (500 took 49 s).
const TARGET_CHUNK_PLACES = 250;
// The last chunk may start at the deadline; nothing it runs may pass this
// much after it (a statement or lock wait that would is cancelled, and the
// chunk rolls back).
const TARGET_OVERRUN_MS = 30 * 1000;
// The mark's one-row write may wait this long for the lock even past the
// overrun: a collector holds it for milliseconds.
const MARK_TIMEOUT_MS = 5 * 1000;
// The undeclared-axis check for the chunk's own venues: the corpus-wide one
// reads every weekly row (40 s on production, 2026-11-19).
const UNDECLARED_PLACES_SQL = `
  SELECT EXISTS (
    SELECT 1
      FROM ml_training_data t
      JOIN ml_venues v ON v.id = t.venue_id
     WHERE v.google_place_id = ANY($1::text[])
       AND t.collection_mode = 'weekly'
       AND (t.hour_axis IS DISTINCT FROM '${HOUR_AXIS_VENUE_LOCAL}')
  ) AS undeclared
`;
// The same average, the same delete, for the given place ids only. Every
// ml_venues row carrying a place id joins it, so each slot written equals what
// the full rebuild writes for it.
const PLACES_FILTER = `
    AND v.google_place_id = ANY($1::text[])`;
const FRESH_EMPTY_SQL = `${FRESH_SQL}  WITH NO DATA`;
const FRESH_PLACES_SQL = `
  INSERT INTO baseline_fresh${averageSql(PLACES_FILTER)}`;
const DELETE_STALE_PLACES_SQL = `${DELETE_STALE_SQL}    AND b.google_place_id = ANY($1::text[])
`;

// HARVESTED VENUES' CURVES WAIT FOR THE SHIP STEP (2026-11-21). By then the
// harvest's curves were nine tenths of ml_venue_baselines (about 24 of 27.2
// million rows), and the hourly collector's recent-deviation rebuild, which
// joins every live reading of 28 days with the whole table, ran past its
// two-minute cap every hour from 17:01 UTC that day. On the maintainer's decision they
// were set aside (setAsideHarvestedCurves.js), and the collector's rebuilds
// pass `includeHarvested: false` from then on: the full rebuild averages no
// harvested venue and deletes none of its slots, and the targeted one drops
// harvested places from its list. A by-hand run still includes them, which is
// what the ship step runs, after --restore and before the status change. The
// average itself is FRESH_SQL's, with one condition added, so the export's
// copy of it (mlExportContracts.test.js) is unchanged.
const NOT_HARVESTED_FILTER = `
    AND v.besttime_status IS DISTINCT FROM 'harvested'`;
const FRESH_NOT_HARVESTED_SQL = `
  CREATE TEMP TABLE baseline_fresh ON COMMIT DROP AS${averageSql(NOT_HARVESTED_FILTER)}`;
const DELETE_STALE_NOT_HARVESTED_SQL = `${DELETE_STALE_SQL}    AND NOT EXISTS (
      SELECT 1 FROM ml_venues hv
       WHERE hv.google_place_id = b.google_place_id AND hv.besttime_status = 'harvested')
`;
// The targeted chunk's two statements with the same condition, so a venue
// listed as a target and harvested before its chunk ran is still left alone:
// each statement reads the status as it stands, not as the list saw it.
const FRESH_PLACES_NOT_HARVESTED_SQL = `
  INSERT INTO baseline_fresh${averageSql(PLACES_FILTER + NOT_HARVESTED_FILTER)}`;
const DELETE_STALE_PLACES_NOT_HARVESTED_SQL = `${DELETE_STALE_NOT_HARVESTED_SQL}    AND b.google_place_id = ANY($1::text[])
`;
const MARK_SQL = `
  INSERT INTO ml_baseline_marks (id, corpus_at, rebuilt_at) VALUES (1, $1::timestamptz, NOW())
  ON CONFLICT (id) DO UPDATE SET corpus_at = EXCLUDED.corpus_at, rebuilt_at = EXCLUDED.rebuilt_at
`;

// Rebuild every source='collected' baseline from the corrected weekly corpus.
// Safe to call any number of times, from anywhere, in any order.
// Returns { ok, undeclared, deleted, upserted }.
//
// SERIALIZED. The check, the average, the delete, the update and the insert
// run in one transaction under the corpus write lock
// (config.withCorpusWriteLock), the same lock the collectors and the venue
// repair take (the targeted rebuild instead takes it once per chunk, below).
// collectRealtime.js calls this from hourly runs and
// buildBaselines.js is run by hand after a repair, so two refreshes can
// overlap, and two overlapping refreshes were how an older value could be
// published under a newer stamp: each read its own snapshot, and the
// later-started one can commit first. Under the lock the second refresh
// starts after the first commits and reads a corpus at least as new, so the
// newest snapshot is always the last written. The permanent tables' DDL stays
// outside the transaction; it is IF NOT EXISTS and takes no part in the race.
// The one CREATE inside it is FRESH_SQL's temporary table, which belongs to
// this transaction alone and is dropped at its COMMIT or ROLLBACK.
//
// `targeted: true` runs THE TARGETED REBUILD instead, until `deadline` (ms
// since the epoch; none means until done), and also returns { targeted,
// places, left, marked }.
//
// `includeHarvested: false` (the hourly collector, since 2026-11-21) leaves
// every harvested venue's slots as they are: HARVESTED VENUES' CURVES WAIT FOR
// THE SHIP STEP, above.
async function refreshCollectedBaselines(pool, {
  targeted = false, deadline = null, chunkPlaces = TARGET_CHUNK_PLACES, overrunMs = TARGET_OVERRUN_MS,
  includeHarvested = true,
} = {}) {
  await pool.query(CREATE_TABLE_SQL);
  await pool.query(MARK_TABLE_SQL);
  // The targeted rebuild runs from the hourly collector, against the booted
  // server's database, and skips the ALTER below: even when the column exists
  // it queues for an exclusive lock on the corpus table behind any open
  // harvest transaction, and every reader of the table then queues behind it.
  if (targeted) return refreshTargets(pool, { deadline, chunkPlaces, overrunMs, includeHarvested });
  // Both columns are created by migration 023 on a booted server; these scripts
  // also run against databases that have not booted the current server.
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS hour_axis VARCHAR(16)`);

  return withCorpusWriteLock(pool, async (client) => {
    // The mark is read BEFORE the rebuild's own statements: a write that
    // commits between the two lands in the rebuild but not in the mark, and
    // costs one extra rebuild next hour rather than one missed. Read as text
    // and written back as text: a stamp from NOW() keeps microseconds, a JS
    // Date keeps milliseconds, and a mark that passed through one never
    // equalled its stamp (every hour read "due", 2026-10-31 00:07 EDT).
    const { rows: [{ corpus_at: corpusAt }] } = await client.query(
      `SELECT corpus_at::text AS corpus_at FROM (${CORPUS_STAMP_SQL}) c`);
    const { rows: [{ undeclared }] } = await client.query(UNDECLARED_WEEKLY_SQL);
    if (undeclared) {
      return { ok: false, undeclared: true, deleted: 0, upserted: 0 };
    }

    // ANALYZE: a temporary table has no statistics until asked, and the three
    // joins against a ~12M-row table should be planned on its real size.
    await client.query(includeHarvested ? FRESH_SQL : FRESH_NOT_HARVESTED_SQL);
    await client.query('ANALYZE baseline_fresh');
    const del = await client.query(includeHarvested ? DELETE_STALE_SQL : DELETE_STALE_NOT_HARVESTED_SQL);
    const changed = await client.query(UPDATE_CHANGED_SQL);
    const added = await client.query(INSERT_NEW_SQL);
    await client.query(MARK_SQL, [corpusAt]);
    return { ok: true, undeclared: false, deleted: del.rowCount, upserted: changed.rowCount + added.rowCount };
  });
}

// THE TARGETED REBUILD, above. The corpus stamp and the target list are read
// before any chunk and outside the lock: the list is only which places to
// average, and each chunk averages its places from the rows as they stand
// under the lock. The stamp is read first, so a write that commits after it
// with a later stamp is in the list, or leaves the newest stamp past the mark
// and makes the next hour due. One that commits late under an EARLY stamp
// (its transaction began before it waited on the lock) can leave the mark
// covering it; its own stamp is still newer than its own baseline, so it
// stays a target and a later targeted pass averages it (stamp-serving places
// go first, so the daily hour's pass reaches it unless a deadline stops that
// pass before its turn).
//
// With a deadline, nothing runs past it by more than TARGET_OVERRUN_MS (the
// mark's one-row write excepted, MARK_TIMEOUT_MS): no read starts after it,
// every statement and lock wait is cancelled at the overrun (the chunk rolls
// back, and its places stay first in line), and the mark moves once no
// stamp-serving place is left.
const TIMED_OUT = new Set(['57014', '55P03']); // statement / lock timeout
async function refreshTargets(pool, { deadline, chunkPlaces, overrunMs, includeHarvested = true }) {
  const hardStop = deadline == null ? null : deadline + overrunMs;
  const remaining = () => (hardStop == null ? null : hardStop - Date.now());
  const result = (extra) => ({
    ok: true, undeclared: false, deleted: 0, upserted: 0, targeted: true, places: 0, left: 0, marked: false, ...extra,
  });
  if (deadline != null && Date.now() >= deadline) return result({ left: null });
  // A read with the time left, in a transaction of its own so the limit
  // ends with it.
  const read = async (sql, params) => {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      if (hardStop != null) await client.query(`SET LOCAL statement_timeout = ${Math.max(1, remaining())}`);
      const res = await client.query(sql, params);
      await client.query('COMMIT');
      return res;
    } catch (err) {
      // A connection whose ROLLBACK failed is not one to hand back to the
      // pool (config.withCorpusWriteLock does the same).
      await client.query('ROLLBACK').catch(() => { broken = true; });
      throw err;
    } finally {
      client.release(broken || undefined);
    }
  };

  let corpusAt;
  let targets;
  try {
    ({ rows: [{ corpus_at: corpusAt }] } = await read(`SELECT corpus_at::text AS corpus_at FROM (${CORPUS_STAMP_SQL}) c`));
    if (deadline != null && Date.now() >= deadline) return result({ left: null });
    ({ rows: targets } = await read(TARGETS_SQL));
  } catch (err) {
    if (err && TIMED_OUT.has(err.code)) return result({ left: null, timedOut: true });
    throw err;
  }
  // A harvested place is the list's unstamped kind (TARGETS_SQL's `stamped`).
  if (!includeHarvested) targets = targets.filter((r) => r.stamped);

  let deleted = 0;
  let upserted = 0;
  let done = 0;
  let timedOut = false;
  // The mark is written as soon as no stamp-serving place is left, before the
  // harvested chunks rather than after them, with a few seconds of its own:
  // written after a chunk cancelled at the overrun it would have had none, and
  // a collector's millisecond write on the lock would have kept it back.
  let marked = false;
  const markIfDone = async () => {
    if (marked || targets.slice(done).some((r) => r.stamped)) return;
    try {
      await withCorpusWriteLock(pool, (client) => client.query(MARK_SQL, [corpusAt]),
        hardStop == null ? {} : { timeoutMs: Math.max(MARK_TIMEOUT_MS, remaining()) });
      marked = true;
    } catch (err) {
      if (!(err && TIMED_OUT.has(err.code))) throw err;
      timedOut = true;
    }
  };
  await markIfDone();
  while (done < targets.length && (deadline == null || Date.now() < deadline)) {
    const places = targets.slice(done, done + chunkPlaces).map((r) => r.google_place_id);
    let chunk;
    try {
      chunk = await withCorpusWriteLock(pool, async (client) => {
        const q = async (sql, params) => {
          if (hardStop != null) await client.query(`SET LOCAL statement_timeout = ${Math.max(1, remaining())}`);
          return client.query(sql, params);
        };
        const { rows: [{ undeclared }] } = await q(UNDECLARED_PLACES_SQL, [places]);
        if (undeclared) return { undeclared: true };
        await q(FRESH_EMPTY_SQL);
        await q(includeHarvested ? FRESH_PLACES_SQL : FRESH_PLACES_NOT_HARVESTED_SQL, [places]);
        await q('ANALYZE baseline_fresh');
        const del = await q(includeHarvested ? DELETE_STALE_PLACES_SQL : DELETE_STALE_PLACES_NOT_HARVESTED_SQL, [places]);
        const changed = await q(UPDATE_CHANGED_SQL);
        const added = await q(INSERT_NEW_SQL);
        return { deleted: del.rowCount, upserted: changed.rowCount + added.rowCount };
      }, hardStop == null ? {} : { timeoutMs: Math.max(1, remaining()) });
    } catch (err) {
      if (err && TIMED_OUT.has(err.code)) { timedOut = true; break; }
      throw err;
    }
    if (chunk.undeclared) {
      return { ...result({ deleted, upserted, places: done, left: targets.length - done }), ok: false, undeclared: true };
    }
    deleted += chunk.deleted;
    upserted += chunk.upserted;
    done += places.length;
    await markIfDone();
  }
  return result({ deleted, upserted, places: done, left: targets.length - done, marked, timedOut });
}

// IS A REBUILD DUE? (2026-10-30.) collectRealtime.js rebuilt every collected
// baseline at the end of every hourly run, about three minutes of each hour,
// and from 2026-10-27 to 2026-10-30 every one of those ~90 rebuilds reported
// "0 changed, 0 stale removed". The weekly corpus moves only when an
// admission, a harvest or a by-id refresh writes it, and the hourly sweep
// never does. Those minutes come off the end of the hour, which the fill
// cities stop early to leave free, so the hourly run now asks this first.
//
// The stamps say whether anything moved. Every writer of weekly rows stamps
// the venue's last_collected_at with its rows (collectWeekly.js and
// harvestVenueFilter.js in the rows' own transaction), and every rebuild
// records the newest stamp it saw (ml_baseline_marks: the full rebuild reads
// it under the corpus lock before its statements, the targeted one just
// before its target list, outside the lock; THE TARGETED REBUILD says what
// that costs). So a rebuild is due exactly when the
// newest stamp is not the one the last rebuild recorded: a write since then
// raises it, and a repair that clears the newest venue's stamp lowers it.
//
// STAMPS AGAINST THE MARK, NOT AGAINST THE BASELINES' OWN DATES. The first
// version compared the newest stamp with the newest baseline date (the newest
// collected_at under a baseline), and the first hourly run with it
// (2026-10-31 01:07 UTC) read 2026-10-07T00:05:12.757Z against
// 00:05:12.262Z: the 10-06 refresh ran while collectWeekly still stamped the
// venue in a separate UPDATE after COMMIT, 0.495 s after the rows, and no
// rebuild can close that, so every hour read "due". A five second tolerance
// fixed that and broke the other side: a week written seconds after a rebuild
// read as nothing new (mlClockAxisBackfill.test.js caught it). A stamp
// compared with a stamp has neither problem.
//
// What the stamps cannot show is a weekly row DELETED or a venue's place id
// REMAPPED with the newest stamp untouched (repairBestTimeDiscoveredVenues.js):
// the baselines change and nothing marks it. Run this file after a repair, as
// before. The hourly run also rebuilds once a day whatever the stamps say
// (DAILY_REBUILD_UTC_HOUR); since 2026-11-19 that is THE TARGETED REBUILD,
// which catches every venue whose stamp is newer than its own baseline
// (harvested ones only when run by hand, since 2026-11-21: the collector
// passes includeHarvested false), however late its write committed, but not a deletion or
// a remap, so the run after a repair is still this file by hand. No mark yet
// means due, and the caller treats a failure to read as due too. `full` says
// which rebuild: the full one when there is no mark, or when the newest stamp
// moved other than forward (a repair cleared it); the targeted one for a
// newer stamp and for the daily hour.
//
// THE DAILY HOUR IS THE HOUR THE RUN STARTED (2026-11-19). `at` is the
// caller's run start, not the moment it asks. A run starts at :07 to :12 and
// its tail asks at :00 to :05 of the NEXT hour, so on 2026-11-19 the 08:00
// UTC run's tail read 09:03 as the daily hour and began the full rebuild four
// minutes before the 09:07 fire, with no time reserved for it: its start had
// read 08:07, not due, so its fill had used the minutes a rebuild is given
// (collectRealtime FILL_EARLY_STOP_MS). Asked with the start, the run that
// starts in the daily hour is the one that rebuilds and both asks agree. (Since
// the same day that rebuild is the targeted one, before the sweep, with its
// minutes taken off the sweep's budget: collectRealtime
// TARGETED_REBUILD_BUDGET_MS. Only a full rebuild keeps the fill's room.)
const DAILY_REBUILD_UTC_HOUR = 9;
// Compared in SQL, at the columns' microseconds: a JS Date keeps milliseconds.
const DUE_SQL = `
  SELECT c.corpus_at, m.corpus_at AS mark_at, m.rebuilt_at,
         c.corpus_at IS DISTINCT FROM m.corpus_at AS moved,
         c.corpus_at > m.corpus_at AS newer
    FROM (${CORPUS_STAMP_SQL}) c
    LEFT JOIN ml_baseline_marks m ON m.id = 1
`;
const UNDEFINED_TABLE = '42P01';

async function collectedBaselinesDue(db, { at = new Date() } = {}) {
  // The mark first, even in the daily hour: with none, only the full rebuild
  // covers what no stamp marks, and the targeted one would leave a mark that
  // stops the next hour from asking for it.
  let stamps;
  try {
    ({ rows: [stamps] } = await db.query(DUE_SQL));
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return { due: true, full: true, reason: 'no rebuild has recorded a mark yet' };
    throw err;
  }
  const iso = (v) => (v ? new Date(v).toISOString() : 'none');
  if (!stamps.rebuilt_at) return { due: true, full: true, reason: 'no rebuild has recorded a mark yet' };
  // A stamp moved other than forward (a repair) takes the full rebuild in the
  // daily hour too; a targeted pass there would record a new mark and erase
  // the only sign of it.
  if (stamps.moved && !stamps.newer) {
    return {
      due: true,
      full: true,
      reason: `the newest weekly stamp moved from ${iso(stamps.mark_at)} to ${iso(stamps.corpus_at)} since the last rebuild`,
    };
  }
  if (at.getUTCHours() === DAILY_REBUILD_UTC_HOUR) {
    return { due: true, full: false, reason: `the daily rebuild hour (${DAILY_REBUILD_UTC_HOUR}:00 UTC)` };
  }
  if (stamps.newer) {
    return {
      due: true,
      full: false,
      reason: `a weekly curve was written at ${iso(stamps.corpus_at)}, after the last rebuild's mark (${iso(stamps.mark_at)})`,
    };
  }
  return {
    due: false,
    reason: `no weekly curve written since the last rebuild (${iso(stamps.rebuilt_at)}, mark ${iso(stamps.mark_at)})`,
  };
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

  // --targeted: THE TARGETED REBUILD, to the end, in short transactions: what
  // a status change needs (it moves no row), or a harvest backlog. Without it,
  // the full rebuild: after a repair, or when in doubt. On production
  // (2026-11-19) the full one holds the corpus lock 20 minutes or more, and
  // every collector write waits for it.
  const targeted = process.argv.includes('--targeted');
  try {
    console.log(`[Baselines] Computing from weekly collection data (venue-local axis, ${targeted ? 'targeted' : 'full'})...`);
    const result = await refreshCollectedBaselines(pool, { targeted });

    if (!result.ok) {
      console.error(`[Baselines] ${REFUSAL_MESSAGE}`);
      process.exitCode = 1;
      return;
    }

    console.log(`[Baselines] Removed ${result.deleted} stale slots, wrote ${result.upserted} changed slots`
      + `${targeted ? ` across ${result.places} places` : ''}`);

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
  collectedBaselinesDue,
  DAILY_REBUILD_UTC_HOUR,
  MARK_TABLE_SQL,
  REFUSAL_MESSAGE,
  HOUR_AXIS_VENUE_LOCAL,
  DELETE_STALE_SQL,
  FRESH_SQL,
  UPDATE_CHANGED_SQL,
  INSERT_NEW_SQL,
  TARGETS_SQL,
  FRESH_EMPTY_SQL,
  FRESH_PLACES_SQL,
  DELETE_STALE_PLACES_SQL,
  FRESH_NOT_HARVESTED_SQL,
  DELETE_STALE_NOT_HARVESTED_SQL,
  FRESH_PLACES_NOT_HARVESTED_SQL,
  DELETE_STALE_PLACES_NOT_HARVESTED_SQL,
  TARGET_CHUNK_PLACES,
};

if (require.main === module) {
  main().catch(err => {
    console.error('[Baselines] Error:', err);
    process.exit(1);
  });
}
