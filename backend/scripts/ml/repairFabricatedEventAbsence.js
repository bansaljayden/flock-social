// ---------------------------------------------------------------------------
// ONE-TIME REPAIR: strip the fabricated event absence from rows written on
// 2026-09-01, before the collectors learned to write those columns NULL.
// ---------------------------------------------------------------------------
// WHAT WENT WRONG. The event-provenance work that day taught both collectors
// to stamp events_observed and events_unavailable_reason, which was the point,
// and left the SEVEN enrichment columns beside them unnamed in the INSERT. Their
// defaults are `false`, `false`, `0` and `0`, so every row written that day
// carried an honest "nothing was measured here" flag next to a confident
// "no event nearby" fact. That pairing is precisely the fabricated negative
// migration 045 was written to end, recreated by the change meant to honor it.
// An adversarial review the same evening found it: 136,920 rows.
//
// WHY THIS BACKFILL IS ALLOWED WHERE 045'S WAS NOT. Migration 045 refused to
// stamp provenance onto pre-045 rows and said no later migration may, because
// an observed false and a fabricated false had become indistinguishable there:
// any stamp would have been an invention. These rows are the opposite case.
// They carry an explicit events_observed = FALSE written by a known collector
// hours ago, so what the event columns beside it should hold is not a guess,
// it is stated by the migration's own contract. Nulling them removes an
// assertion nobody ever measured; it does not add knowledge.
//
// SCOPE. Only rows where events_observed IS FALSE, which by construction is
// only rows the 2026-09-01 collectors wrote: 045 backfilled nothing, and any
// row a real enrichment touched carries TRUE.
//
//   node scripts/ml/repairFabricatedEventAbsence.js            (report only)
//   node scripts/ml/repairFabricatedEventAbsence.js --commit   (write)
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');

if (!process.env.DATABASE_URL && process.env.PGHOST) {
  const host = process.env.PGHOST;
  const port = process.env.PGPORT || 5432;
  const user = process.env.PGUSER || 'postgres';
  const pass = process.env.PGPASSWORD || '';
  const db = process.env.PGDATABASE || 'railway';
  process.env.DATABASE_URL = `postgresql://${user}:${pass}@${host}:${port}/${db}`;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});

const SELECT_SCOPE = `
  SELECT COUNT(*)::int AS n
    FROM ml_training_data
   WHERE events_observed IS FALSE
     AND (event_nearby IS NOT NULL
       OR has_nearby_event IS NOT NULL
       OR total_nearby_events IS NOT NULL
       OR total_nearby_attendance IS NOT NULL
       OR nearest_event_attendance IS NOT NULL
       OR nearest_event_distance_km IS NOT NULL
       OR nearest_event_type IS NOT NULL)`;

async function main() {
  const commit = process.argv.includes('--commit');
  const { rows: before } = await pool.query(SELECT_SCOPE);
  console.log(`[Repair] ${before[0].n} rows carry an event fact beside events_observed = false.`);
  if (before[0].n === 0) {
    console.log('[Repair] Nothing to do.');
    return pool.end();
  }
  if (!commit) {
    console.log('[Repair] Report only. Re-run with --commit to null those columns.');
    return pool.end();
  }

  // The event columns only. busyness_pct, the labels, the weather and the
  // provenance flags themselves are untouched: this statement removes an
  // assertion, it does not edit an observation.
  const res = await pool.query(`
    UPDATE ml_training_data
       -- SEVEN, not six. nearest_event_attendance was in neither the SET list
       -- nor the predicate, and it is the one enrichment column carrying
       -- INTEGER DEFAULT 0. So this script NULLed six columns on 136,920
       -- rows, left the seventh asserting a measurement on every one of them,
       -- and then reported itself clean because the verification predicate had
       -- the same omission. A repair that cannot see its own miss is worse than
       -- no repair: it closes the ticket.
       SET event_nearby = NULL,
           has_nearby_event = NULL,
           total_nearby_events = NULL,
           total_nearby_attendance = NULL,
           nearest_event_attendance = NULL,
           nearest_event_distance_km = NULL,
           nearest_event_type = NULL
     WHERE events_observed IS FALSE
       AND (event_nearby IS NOT NULL
         OR has_nearby_event IS NOT NULL
         OR total_nearby_events IS NOT NULL
         OR total_nearby_attendance IS NOT NULL
         OR nearest_event_attendance IS NOT NULL
         OR nearest_event_distance_km IS NOT NULL
         OR nearest_event_type IS NOT NULL)`);
  console.log(`[Repair] Updated ${res.rowCount} rows.`);

  const { rows: after } = await pool.query(SELECT_SCOPE);
  console.log(`[Repair] Remaining: ${after[0].n} (expected 0).`);
  return pool.end();
}

main().catch((err) => {
  console.error('[Repair] Fatal:', err.message);
  pool.end();
  process.exitCode = 1;
});
