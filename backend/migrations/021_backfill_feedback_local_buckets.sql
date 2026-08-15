-- 021: venue_feedback rows bucketed on the wrong clock get their bucket keys
-- recomputed on the venue's clock (TASKS.md B3).
--
-- WHAT WENT WRONG. day_of_week / hour on venue_feedback are BUCKET KEYS, not
-- timestamps: routes/crowd.js looks calibration rows up with
-- `day_of_week = $localDay AND hour BETWEEN $localHour-1 AND $localHour+1`,
-- where localDay/localHour are the VENUE's wall clock. Before the venue-local
-- clock fix in routes/feedback.js (see the long "Venue-local clock" note
-- there), the INSERT computed both keys with EXTRACT(DOW/HOUR FROM NOW()) —
-- the database server's clock, which is UTC on Railway. A 9pm Friday report in
-- Philadelphia was filed as Saturday 01:00 or 02:00, so the Friday-night
-- lookup never found it and the Saturday-small-hours lookup found a crowd
-- level from a different part of the week. feedback.js ends that note with:
-- "Rows written before this fix are still bucketed in UTC and cannot be
-- corrected from here; they need a backfill keyed on created_at + timezone."
-- This file is that backfill.
--
-- WHY THE PREDICATE IS "DISAGREES WITH THE RECOMPUTATION", NOT A CUTOFF DATE.
-- There is no per-row marker of which code path wrote a row, and no dated
-- comment pins the exact deploy instant, so a created_at cutoff would be a
-- guess — and a wrong backfill is worse than a stale bucket. A date is also
-- unnecessary, because for every row this statement can touch (one whose venue
-- is in ml_venues with a usable timezone) the recomputation is a FIXED POINT
-- of the current write path:
--
--   * A post-fix row for such a venue was bucketed by feedback.js from
--     ml_venues.timezone at insert time (resolution order 1 — the venue zone
--     beats the client hint whenever it exists). created_at defaults to NOW(),
--     the transaction timestamp of that same insert, so recomputing
--     created_at AT TIME ZONE timezone reproduces the stored keys and the
--     row does not satisfy the disagreement predicate. (The only exception is
--     a row whose insert straddled the top of an hour — created_at is the
--     BEGIN instant, the JS clock read runs milliseconds later — and for such
--     a row this statement moves it one adjacent hour, to the bucket its own
--     created_at implies, which the +/-1-hour read window in routes/crowd.js
--     absorbs either way.)
--   * A pre-fix row for such a venue carries the UTC bucket. Wherever venue
--     local time differs from UTC (America/New_York is UTC-5/-4, so always),
--     it disagrees and is corrected; at any venue whose zone IS UTC the two
--     buckets coincide, the row is already right, and there is nothing to do.
--
-- So "stored keys disagree with created_at rendered in the venue's zone" IS
-- the disease, not a proxy for it, and no provenance guess is involved.
--
-- IDEMPOTENT BY CONSTRUCTION. The new values are a pure function of
-- (created_at, ml_venues.timezone), neither of which this statement writes.
-- After one run every joinable row equals its recomputation, so a second run's
-- disagreement predicate matches nothing and writes nothing — a fixed point,
-- not incremental shifting. Running this file any number of times is
-- byte-identical to running it once.
--
-- DST. AT TIME ZONE applies the IANA rule in force at the row's actual
-- instant, so rows on both sides of a transition land on their true wall
-- clock: 2026-11-01 05:30Z and 06:30Z (the repeated 1:30am in
-- America/New_York) both render as hour 1, which is correct — bucket keys
-- carry no offset, so the two 1ams are one bucket by design. The spring
-- forward gap (2:00-2:59 on 2026-03-08) is unrepresentable as an instant, so
-- the recomputation can never produce it.
--
-- DAY NUMBERING. Postgres EXTRACT(DOW) is 0=Sunday..6=Saturday — the same
-- convention as the JS Date#getDay()/Intl weekday mapping feedback.js writes
-- (WEEKDAY_INDEX there starts Sun: 0). Pinned by
-- __tests__/feedbackBackfillMigration.test.js, which derives the expected
-- buckets with the JS convention and asserts this SQL agrees.
--
-- WHAT STAYS UNTOUCHED, deliberately:
--   * rows whose venue_place_id has no ml_venues row — no known timezone, so
--     no honest recomputation exists. (Post-fix such rows are bucketed from
--     the client's clock hint, which is the best available answer already.)
--   * rows whose ml_venues.timezone is not a name Postgres knows
--     (pg_timezone_names, exact match) — garbage in that column must degrade
--     to "leave the row alone", never abort the transaction. Unguarded,
--     `AT TIME ZONE 'Gotham/Nowhere'` raises, the transaction rolls back, and
--     db/migrate.js turns that into `FATAL: migration failed` — a boot loop
--     bought by one bad reference row. The MATERIALIZED CTE below is that
--     guard: it is an optimization fence (PG >= 12), so the timezone values
--     the UPDATE can ever evaluate are exactly the pre-validated ones,
--     regardless of how the planner orders the WHERE predicates.
--   * rows with a NULL created_at — nothing to recompute from.
--
-- Operator's counts-by-category query (run before or after; read-only):
--
--   WITH j AS (
--     SELECT vf.id, vf.day_of_week, vf.hour, vf.created_at,
--            mv.google_place_id AS joined, tz.name AS tzname,
--            CASE WHEN tz.name IS NOT NULL AND vf.created_at IS NOT NULL THEN
--              EXTRACT(DOW  FROM (vf.created_at AT TIME ZONE mv.timezone))::smallint END AS want_day,
--            CASE WHEN tz.name IS NOT NULL AND vf.created_at IS NOT NULL THEN
--              EXTRACT(HOUR FROM (vf.created_at AT TIME ZONE mv.timezone))::smallint END AS want_hour
--     FROM venue_feedback vf
--     LEFT JOIN ml_venues mv ON mv.google_place_id = vf.venue_place_id
--     LEFT JOIN pg_timezone_names tz ON tz.name = mv.timezone
--   )
--   SELECT CASE
--            WHEN joined IS NULL THEN 'untouched: venue not in ml_venues'
--            WHEN tzname IS NULL THEN 'untouched: unusable ml_venues.timezone'
--            WHEN created_at IS NULL THEN 'untouched: NULL created_at'
--            WHEN day_of_week = want_day AND hour = want_hour THEN 'already correct (fixed point)'
--            ELSE 'corrected by 021'
--          END AS category, COUNT(*)
--   FROM j GROUP BY 1 ORDER BY 1;
--
-- Default transactional mode on purpose (no directive line): one UPDATE,
-- all-or-nothing, rolled back clean on any failure.

WITH usable_tz AS MATERIALIZED (
  -- The only timezone strings the UPDATE below is allowed to evaluate:
  -- exact-name members of pg_timezone_names. google_place_id is UNIQUE on
  -- ml_venues, so this joins at most one row per feedback row.
  SELECT mv.google_place_id, mv.timezone
  FROM ml_venues mv
  JOIN pg_timezone_names tz ON tz.name = mv.timezone
)
UPDATE venue_feedback vf
SET day_of_week = EXTRACT(DOW  FROM (vf.created_at AT TIME ZONE u.timezone))::smallint,
    hour        = EXTRACT(HOUR FROM (vf.created_at AT TIME ZONE u.timezone))::smallint
FROM usable_tz u
WHERE u.google_place_id = vf.venue_place_id
  AND vf.created_at IS NOT NULL
  AND (
        vf.day_of_week <> EXTRACT(DOW  FROM (vf.created_at AT TIME ZONE u.timezone))::smallint
     OR vf.hour        <> EXTRACT(HOUR FROM (vf.created_at AT TIME ZONE u.timezone))::smallint
  );
