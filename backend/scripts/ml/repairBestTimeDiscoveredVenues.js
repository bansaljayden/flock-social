// ---------------------------------------------------------------------------
// ONE-TIME REPAIR: collapse the second ml_venues row this project minted for
// venues it already had, and clear the review counts nobody ever measured.
// ---------------------------------------------------------------------------
// WHAT WENT WRONG. BestTime's venue search answers with a BestTime venue id and
// no Google place id, so scripts/ml/discoverBestTime.js built one —
// `bt_${venue.venue_id}` — and upserted `ON CONFLICT (google_place_id)`.
// ml_venues is UNIQUE on google_place_id and on nothing else, so a venue we
// already held under its REAL Google place id conflicted with nothing and got a
// SECOND row under the pseudo id, carrying the same besttime_venue_id.
//
// On the 2026-09-03 production dump: 933 BestTime venue ids are held by 1,871
// ml_venues rows between them. 909 of those groups contain a `bt_` row. 111
// groups are ACTIVE philly/lehigh venues (222 rows), which is exactly the hourly
// realtime cron's scope, so every sweep pays two BestTime credits for one
// physical venue and writes two rows for one observation. Willow Grove Park is
// ml_venues 33840 (`bt_ven_556d6c...`, 'park', rating NULL, review_count 0) and
// ml_venues 49000 (`ChIJfxx3xTuwxokRg2ccehxvlmU`, 'mall', 4.4, 9,880 reviews),
// and both were handed 168 identical weekly rows by the same 2026-09-01 run.
// Migration 024's unique indexes are keyed on venue_id, so they cannot see any
// of it. train/export_training_data.js joins ml_venues, so both copies are
// exported and every average keyed on the venue counts the building twice.
//
// scripts/ml/discoverBestTime.js now upserts on besttime_venue_id, and
// migration 060 gives that column the unique index that makes the clause
// enforceable. 060 SKIPS the index build while these groups still exist,
// because db/migrate.js runs before server.listen() and a boot-time migration
// does not get to choose which of two venue rows to retire. That choice is what
// this file is. It ends by building the index itself.
//
// ---------------------------------------------------------------------------
// WHY THIS REPAIR IS ALLOWED, STATED PER CLASS, BECAUSE THE TWO ARE NOT ALIKE
//
// A `bt_` row is not a venue. It is a second NAME for a venue, minted by a
// collector that had no way to ask whether we already knew the place. Deleting
// it destroys no observation: its training rows are moved onto the row that
// keeps the Google identity first, and where both rows hold the same slot the
// survivor is chosen by migration 024's rule (newest collected_at, then
// besttime_epoch, then id) so the corpus keeps the fresher read of the two.
// That is the same rule 024 used on the duplicates it collapsed and the same
// rule collectWeekly's DO UPDATE applies on every re-collection, so history and
// go-forward behaviour stay one rule.
//
// 24 groups are NOT that. They hold two DIFFERENT Google places that BestTime's
// own matcher resolved to one venue id: a Bangkok "Taco Bell" at two addresses,
// "100 Gramm Bar" and "100 GRAMM Lounge" in Berlin, "ICONSIAM" and "ICONSIAM
// PARK". Nothing here can tell which of them BestTime actually answered for,
// and both are real Google records with real coordinates. So the VENUE ROWS
// are not deleted in those groups. One row keeps the mapping and the others
// have besttime_venue_id set to NULL and besttime_status set to 'duplicate'.
// They keep their identity and their coordinates; they stop claiming a
// BestTime venue another row also claims, which is the only thing the unique
// index actually forbids. collectWeekly.js writes the same word when a fresh
// lookup hits the same wall.
//
// Their TRAINING ROWS are a different matter, and the first version of this
// file got it wrong by keeping them. Every row under a rival was bought with
// the shared BestTime id: collectWeekly fetches by venue.besttime_venue_id
// once one is stored, collectRealtime only ever fetches by it, and a row's id
// is never overwritten once set. So the rival's 168 weekly rows are the same
// forecast the keeper holds, filed under a second set of coordinates, and its
// realtime rows are the same live readings the keeper was polled for in the
// same sweeps. Left in place, train/export_training_data.js exports one
// source twice under two venues, and buildBaselines.js rebuilds the rival's
// baseline curve from the keeper's data on the next hourly cron, which is the
// contamination this whole repair exists to end. So the rival's weekly rows,
// its realtime rows and its source='collected' baselines are deleted. Its
// source='google' baselines are not: those come from Google popular_times for
// the rival's own place id and are genuinely about the rival.
//
// The realtime rows are deleted rather than moved onto the keeper, unlike an
// orphan's, and the reason is the context columns. A realtime row carries
// weather, the nearest event, the venue's category and rating, all resolved
// from the rival's coordinates and record at collection time. Its busyness is
// the keeper's reading but the rest of the row describes another place, and
// two Google places sharing an id can be a chain's two addresses across a
// city. A moved row would pair the keeper's label with another venue's
// features. The keeper was in the same sweeps (same city, same active flag,
// same id) and holds its own row for each observation, so nothing is lost
// that the keeper does not already have.
//
// PHASE 2 is the other half of the same carelessness. discoverBestTime wrote a
// literal 0 into review_count because BestTime does not report review counts,
// and ml_venues.review_count carried DEFAULT 0 besides. "Nobody has ever been
// here" is the far end of the range, not the middle, and it is not what "we
// never looked" means. review_count and log_review_count are shipped model
// features, and train/prepare_features.py fills a missing rating with the
// corpus MEDIAN while review_count was filled with zero — so a venue this
// script discovered was described to the model as an average-rated venue with
// no reviews, which is a learnable signature for "this row came from the
// discovery path" rather than anything about the venue. Migration 060 clears
// the 1,741 ml_venues rows and drops the DEFAULT; the hundreds of thousands of
// TRAINING rows that already copied that zero are cleared here, batched,
// because that is not work for the boot path.
//
// NOT IN SCOPE, deliberately: the 832 `bt_` venues whose besttime_venue_id is
// theirs alone. They are the only record of those places and nothing about them
// is duplicated. They keep their pseudo place id.
//
// BATCHED AND RESUMABLE. Each group is its own transaction and each phase-2
// batch commits on its own, so the script can be killed at any point and simply
// resumes: every predicate only matches work that has not been done yet.
//
// SAFE UNDER THE HOURLY CRON. Each group's transaction takes the corpus write
// lock (config.withCorpusWriteLock) before it reads a row, and both collectors
// take the same lock around each venue's write, re-checking that the venue
// still exists and still holds its id before they insert. Without that, a
// collector that had read its venue list before this script retired a `bt_`
// row could insert an observation between the move and the DELETE, and the
// ON DELETE CASCADE on ml_training_data.venue_id would take the fresh row with
// it; or the insert could arrive after the DELETE and fail its foreign key
// after the BestTime credit had been spent. The lock is per group, not per
// run, so the sweep waits milliseconds at a time and never loses an hour.
//
// THE INDEX IS THE EXIT CODE. A run that merged everything and then failed to
// leave ml_venues_besttime_venue_id_uniq built, unique, on the right column,
// with the right predicate and valid, exits 1, because an operator reading
// "exit 0" would reasonably assume the constraint is in place and it is not.
// A CREATE INDEX CONCURRENTLY that dies partway leaves an INVALID index under
// the same name, and IF NOT EXISTS then skips it forever; that case is
// detected before the build, dropped, and rebuilt.
//
// AFTER A --commit RUN, rebuild the derived tables, because a venue's corpus
// changed underneath them:
//
//   node scripts/ml/buildBaselines.js
//   node scripts/ml/train/export_training_data.js
//
//   node scripts/ml/repairBestTimeDiscoveredVenues.js            (report only)
//   node scripts/ml/repairBestTimeDiscoveredVenues.js --commit   (write)
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { withCorpusWriteLock } = require('./config');

if (!process.env.DATABASE_URL && process.env.PGHOST) {
  const host = process.env.PGHOST;
  const port = process.env.PGPORT || 5432;
  const user = process.env.PGUSER || 'postgres';
  const pass = process.env.PGPASSWORD || '';
  const db = process.env.PGDATABASE || 'railway';
  process.env.DATABASE_URL = `postgresql://${user}:${pass}@${host}:${port}/${db}`;
}

const pool = new Pool({
  // A stalled connect must fail, not hang. The first --commit run of this
  // script sat for two hours with no session on the server, no lock held and
  // nothing written: the TLS connect to the Railway proxy never answered and
  // pg's default is to wait forever. Twenty seconds is far longer than a
  // healthy connect and short enough that an operator sees the failure.
  connectionTimeoutMillis: 20000,
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});

const VENUE_ID_INDEX = 'ml_venues_besttime_venue_id_uniq';

// "This row was created by discoverBestTime.js and Google was never consulted
// about it." Stated once and reused by every statement below, so the report and
// the writes cannot disagree about what a pseudo row is.
const IS_PSEUDO = `google_place_id LIKE 'bt\\_%' ESCAPE '\\'`;

// Rows per phase-2 batch. ml_training_data is 3.9M rows on a database an hourly
// cron is also using, so nothing here takes a long lock.
const BATCH = 25000;

// ---------------------------------------------------------------------------
// Group discovery
// ---------------------------------------------------------------------------
const GROUPS_SQL = `
  SELECT besttime_venue_id, COUNT(*)::int AS n
    FROM ml_venues
   WHERE besttime_venue_id IS NOT NULL
   GROUP BY besttime_venue_id
  HAVING COUNT(*) > 1
   ORDER BY besttime_venue_id`;

// The keeper rule, in one ORDER BY so it is a total order and the report and
// the write cannot pick different rows:
//   1. a real Google place id beats a pseudo one, always. That is the whole
//      point: the surviving row is the one that can be looked up, enriched,
//      rated and served.
//   2. then the row the corpus already attributes BestTime data to (most weekly
//      rows) — for the real-versus-real groups this is the closest thing to
//      evidence about which place BestTime answered for.
//   3. then the RICHER GOOGLE RECORD, which for the real-versus-real groups is
//      the rule that actually decides, and it has to be this one rather than
//      recency. `last_collected_at` records which row our own sweep happened to
//      touch last; it is a fact about our loop order, not about which listing
//      is the real place. `review_count` is Google's own measure of which
//      listing people actually use. Ordered the other way round, the 24 groups
//      where two real Google places resolve to one BestTime venue kept the stub
//      and unmapped the landmark: "Mall" in Dubai with 16 reviews kept over
//      Mall of the Emirates with 144,231, "Opry Mills Mall by walking" with 307
//      over Opry Mills with 30,863, "Vino &" with 28 over Eataly with 5,447.
//      Nothing is deleted in those groups, but the keeper is the row that goes
//      on being collected hourly, so the wrong order abandons the landmark and
//      keeps polling the stub.
//   4. then the most recently collected, then the lowest id, so the answer is
//      stable across runs.
const GROUP_ROWS_SQL = `
  SELECT v.id, v.google_place_id, v.name, v.city, v.is_active,
         v.venue_category, v.price_level, v.rating, v.review_count,
         v.last_collected_at,
         (${IS_PSEUDO}) AS is_pseudo,
         (SELECT COUNT(*)::int FROM ml_training_data t WHERE t.venue_id = v.id) AS rows_total,
         (SELECT COUNT(*)::int FROM ml_training_data t
           WHERE t.venue_id = v.id AND t.collection_mode = 'weekly') AS rows_weekly
    FROM ml_venues v
   WHERE v.besttime_venue_id = $1
   ORDER BY is_pseudo ASC,
            rows_weekly DESC,
            v.review_count DESC NULLS LAST,
            v.last_collected_at DESC NULLS LAST,
            v.id ASC`;

// ---------------------------------------------------------------------------
// The merge, one orphan at a time, inside the caller's transaction.
//
// Repointing venue_id is what collides with migration 024's two partial unique
// indexes, and the collision is not hypothetical: Willow Grove's two rows each
// received the same 168 weekly cells. So the collisions are resolved BEFORE the
// move, across both venues at once, by exactly 024's survivor rule. A window
// function over the union keeps one row per slot whichever side it sits on, and
// the UPDATE that follows can then move everything that is left without
// touching either index's key twice.
//
// Rows no index covers — weekly rows on another axis, undated legacy realtime
// observations — are not in either partition and simply move. That is the same
// exemption 024 made for them and for the same reason: nothing can prove two
// undated observations are the same observation.
// ---------------------------------------------------------------------------
const COLLAPSE_WEEKLY_SQL = `
  WITH cand AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY day_of_week, hour
             ORDER BY collected_at DESC NULLS LAST,
                      besttime_epoch DESC NULLS LAST,
                      id DESC) AS rn
      FROM ml_training_data
     WHERE venue_id IN ($1, $2)
       AND collection_mode = 'weekly'
       AND hour_axis = 'venue_local'
  )
  DELETE FROM ml_training_data t
   USING cand
   WHERE t.id = cand.id AND cand.rn > 1`;

const COLLAPSE_REALTIME_SQL = `
  WITH cand AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY day_of_week, hour, observed_date
             ORDER BY collected_at DESC NULLS LAST,
                      besttime_epoch DESC NULLS LAST,
                      id DESC) AS rn
      FROM ml_training_data
     WHERE venue_id IN ($1, $2)
       AND collection_mode = 'realtime'
       AND observed_date IS NOT NULL
  )
  DELETE FROM ml_training_data t
   USING cand
   WHERE t.id = cand.id AND cand.rn > 1`;

// Moved AND relabelled in one statement. The four venue-metadata columns are
// per-row copies of the venue's own record — that is how both collectors write
// them — and the orphan's copies are BestTime's blanks: category 'park' where
// Google says 'mall', rating NULL, review_count 0. Leaving them would give one
// venue a corpus that disagrees with itself about what kind of place it is, and
// venue_category is both a model feature and the key ml_venue_baselines is
// grouped by.
const MOVE_ROWS_SQL = `
  UPDATE ml_training_data t
     SET venue_id       = k.id,
         venue_category = k.venue_category,
         price_level    = k.price_level,
         rating         = k.rating,
         review_count   = k.review_count
    FROM ml_venues k
   WHERE k.id = $1 AND t.venue_id = $2`;

// ml_venue_baselines is keyed on google_place_id, not venue_id, so the FK
// cascade that clears ml_training_data does not reach it. A baseline row under a
// place id that no longer names anything is dead weight that buildBaselines.js
// will never revisit.
const DROP_BASELINES_SQL = 'DELETE FROM ml_venue_baselines WHERE google_place_id = $1';

// A rival's training rows: the keeper's data under another name, per the
// header. Both modes named rather than a bare DELETE by venue_id, so the
// statement says what it believes about the rows it removes. RETURNING the
// mode lets the log count each kind.
const DROP_RIVAL_ROWS_SQL = `
  DELETE FROM ml_training_data
   WHERE venue_id = $1
     AND collection_mode IN ('weekly', 'realtime')
  RETURNING collection_mode`;

// Only the half buildBaselines.js owns. A rival is a real Google place, and
// mlPredictor.storeGoogleBaselines may have written source='google' rows for
// it from Google's own popular_times, which are about the rival and stay.
const DROP_RIVAL_BASELINES_SQL =
  "DELETE FROM ml_venue_baselines WHERE google_place_id = $1 AND source = 'collected'";

const PHASE2_SCOPE = `
  ml_training_data t
   WHERE t.review_count = 0
     AND EXISTS (
       SELECT 1 FROM ml_venues v
        WHERE v.id = t.venue_id AND ${IS_PSEUDO}
     )`;

function fmtRow(r) {
  return `      ml_venues ${r.id} ${r.is_pseudo ? '[pseudo]' : '[google] '} `
    + `${r.google_place_id} "${r.name}" ${r.city}`
    + `${r.is_active ? '' : ' (inactive)'} `
    + `cat=${r.venue_category} rating=${r.rating ?? 'null'} reviews=${r.review_count ?? 'null'} `
    + `rows=${r.rows_total} (${r.rows_weekly} weekly)`;
}

async function loadGroups() {
  const { rows: groups } = await pool.query(GROUPS_SQL);
  const out = [];
  for (const g of groups) {
    const { rows } = await pool.query(GROUP_ROWS_SQL, [g.besttime_venue_id]);
    const keeper = rows[0];
    out.push({
      besttimeVenueId: g.besttime_venue_id,
      rows,
      keeper,
      orphans: rows.slice(1).filter((r) => r.is_pseudo),
      rivals: rows.slice(1).filter((r) => !r.is_pseudo),
    });
  }
  return out;
}

async function report(groups) {
  const merges = groups.filter((g) => g.orphans.length > 0);
  const contested = groups.filter((g) => g.rivals.length > 0);
  const orphanRows = merges.reduce((n, g) => n + g.orphans.length, 0);
  const rivalRows = contested.reduce((n, g) => n + g.rivals.length, 0);

  console.log(`[Repair] ${groups.length} BestTime venue ids are held by more than one ml_venues row.`);
  console.log(`[Repair] PHASE 1a: ${merges.length} groups hold ${orphanRows} pseudo rows that will be MERGED into the row keeping the Google identity.`);
  console.log(`[Repair] PHASE 1b: ${contested.length} groups hold ${rivalRows} further REAL Google places sharing one BestTime venue. The venue rows stay; the mapping, the training rows bought with it and the collected baselines built from them go.`);

  for (const g of merges.slice(0, 5)) {
    console.log(`  ${g.besttimeVenueId}`);
    console.log(`    KEEP  ${fmtRow(g.keeper).trim()}`);
    for (const o of g.orphans) console.log(`    MERGE ${fmtRow(o).trim()}`);
  }
  if (merges.length > 5) console.log(`  ... and ${merges.length - 5} more merge groups.`);

  for (const g of contested) {
    console.log(`  ${g.besttimeVenueId}  [two Google places, one BestTime venue]`);
    console.log(`    KEEP    ${fmtRow(g.keeper).trim()}`);
    for (const r of g.rivals) console.log(`    UNMAP   ${fmtRow(r).trim()}`);
  }

  const { rows: [p2] } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${PHASE2_SCOPE}`);
  console.log(`[Repair] PHASE 2: ${p2.n} training rows carry review_count = 0 copied from a venue nobody ever asked Google about.`);
}

// One group, one transaction, under the corpus write lock from its first
// statement. The lock is what keeps a collector's in-flight observation for the
// orphan from landing between the move and the DELETE below (see the header).
async function mergeGroup(g) {
  await withCorpusWriteLock(pool, async (client) => {
    for (const orphan of g.orphans) {
      await client.query(COLLAPSE_WEEKLY_SQL, [g.keeper.id, orphan.id]);
      await client.query(COLLAPSE_REALTIME_SQL, [g.keeper.id, orphan.id]);
      const moved = await client.query(MOVE_ROWS_SQL, [g.keeper.id, orphan.id]);
      await client.query(DROP_BASELINES_SQL, [orphan.google_place_id]);
      await client.query('DELETE FROM ml_venues WHERE id = $1', [orphan.id]);
      g.movedRows = (g.movedRows || 0) + moved.rowCount;
    }
    for (const rival of g.rivals) {
      // The venue row is NOT deleted: it keeps its Google identity and its
      // coordinates and stops claiming a BestTime venue another row also
      // claims. Its training rows and collected baselines go, because they
      // are the keeper's data under this row's name (header, "Their TRAINING
      // ROWS"). besttime_attempted_at is preserved when it exists so the
      // record of when we last tried is not rewritten by a cleanup.
      const dropped = await client.query(DROP_RIVAL_ROWS_SQL, [rival.id]);
      for (const r of dropped.rows) {
        if (r.collection_mode === 'weekly') g.rivalWeeklyDropped = (g.rivalWeeklyDropped || 0) + 1;
        else g.rivalRealtimeDropped = (g.rivalRealtimeDropped || 0) + 1;
      }
      const baselines = await client.query(DROP_RIVAL_BASELINES_SQL, [rival.google_place_id]);
      g.rivalBaselinesDropped = (g.rivalBaselinesDropped || 0) + baselines.rowCount;
      await client.query(
        `UPDATE ml_venues
            SET besttime_venue_id = NULL,
                besttime_status = 'duplicate',
                besttime_attempted_at = COALESCE(besttime_attempted_at, NOW()),
                updated_at = NOW()
          WHERE id = $1`,
        [rival.id]
      );
    }
  });
}

async function phase2() {
  let total = 0;
  for (;;) {
    const res = await pool.query(`
      UPDATE ml_training_data
         SET review_count = NULL
       WHERE id IN (
         SELECT t.id FROM ${PHASE2_SCOPE}
          ORDER BY t.id
          LIMIT ${BATCH}
       )`);
    if (res.rowCount === 0) break;
    total += res.rowCount;
    console.log(`[Repair] phase 2: ${total} training rows cleared...`);
  }
  return total;
}

// What the catalog says about the index under our name, or null when there is
// none. Every field the final assertion judges is read here, from pg_index
// itself rather than from a string: uniqueness, the key columns in order, the
// partial predicate, and whether the index is valid.
async function indexState() {
  const { rows } = await pool.query(
    `SELECT i.indisvalid, i.indisunique,
            pg_get_expr(i.indpred, i.indrelid) AS predicate,
            pg_get_indexdef(i.indexrelid) AS def,
            ARRAY(
              SELECT a.attname::text
                FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
               ORDER BY k.ord
            ) AS columns
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1`,
    [VENUE_ID_INDEX]
  );
  return rows[0] || null;
}

// The hard assertion, as a list of what is wrong so the log can name all of it
// at once. Empty means the index is exactly what migration 060 describes.
function indexProblems(ix) {
  if (!ix) return ['it does not exist'];
  const problems = [];
  if (ix.indisunique !== true) problems.push('it is not UNIQUE');
  if (!Array.isArray(ix.columns) || ix.columns.length !== 1 || ix.columns[0] !== 'besttime_venue_id') {
    problems.push(`its key is (${(ix.columns || []).join(', ')}) rather than (besttime_venue_id)`);
  }
  const predicate = String(ix.predicate || '').replace(/[()\s]+/g, ' ').trim().toLowerCase();
  if (predicate !== 'besttime_venue_id is not null') {
    problems.push(`its predicate is ${ix.predicate ? `"${ix.predicate}"` : 'absent'} rather than "besttime_venue_id IS NOT NULL"`);
  }
  if (ix.indisvalid !== true) problems.push('it is INVALID (enforced on every insert, ignored by the planner)');
  return problems;
}

async function buildIndex() {
  const { rows: left } = await pool.query(GROUPS_SQL);
  if (left.length > 0) {
    console.error(`[Repair] ${left.length} duplicate groups remain; NOT building ${VENUE_ID_INDEX}.`);
    return false;
  }

  // An earlier CONCURRENTLY build that died partway (a duplicate that slipped
  // in, a lost connection, a kill) leaves the name in the catalog flagged
  // invalid, and CREATE INDEX IF NOT EXISTS sees the name and skips. So the
  // leftover is dropped first. Only an INVALID index is dropped: a valid index
  // of the wrong shape under this name is somebody's deliberate object, and the
  // assertion below reports it for a human rather than replacing it.
  const before = await indexState();
  if (before && before.indisvalid === false) {
    console.warn(`[Repair] ${VENUE_ID_INDEX} exists but is INVALID, left by a build that died partway. Dropping it before rebuilding.`);
    await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${VENUE_ID_INDEX}`);
  }

  // CONCURRENTLY here and plainly in migration 060, which is a build strategy
  // and not a different index: same name, same column, same predicate. This
  // script is not in the boot path and production's collectors may be running,
  // so it takes no write lock; 060 runs before server.listen() on a 34,785-row
  // table where the lock is measured in milliseconds and CONCURRENTLY is not
  // allowed inside its conditional block anyway.
  try {
    await pool.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${VENUE_ID_INDEX}
         ON ml_venues (besttime_venue_id)
         WHERE besttime_venue_id IS NOT NULL`
    );
  } catch (err) {
    console.error(`[Repair] CREATE INDEX CONCURRENTLY failed: ${err.message}`);
  }

  const after = await indexState();
  const problems = indexProblems(after);
  if (problems.length > 0) {
    console.error(`[Repair] ${VENUE_ID_INDEX} is NOT in place after the build: ${problems.join('; ')}.`);
    if (after) console.error(`[Repair] Catalog definition: ${after.def}`);
    console.error('[Repair] Re-run this script once the cause is understood; an invalid leftover is dropped and rebuilt automatically, anything else is left for a human.');
    return false;
  }
  console.log(`[Repair] ${VENUE_ID_INDEX} is built: unique, on (besttime_venue_id), WHERE besttime_venue_id IS NOT NULL, valid.`);
  return true;
}

async function main() {
  const commit = process.argv.includes('--commit');
  const groups = await loadGroups();
  await report(groups);

  if (!commit) {
    console.log('[Repair] Report only. Re-run with --commit to merge these groups, clear the fabricated review counts and build the unique index.');
    return pool.end();
  }

  let merged = 0;
  let unmapped = 0;
  let movedRows = 0;
  let rivalWeekly = 0;
  let rivalRealtime = 0;
  let rivalBaselines = 0;
  for (const g of groups) {
    await mergeGroup(g);
    merged += g.orphans.length;
    unmapped += g.rivals.length;
    movedRows += g.movedRows || 0;
    rivalWeekly += g.rivalWeeklyDropped || 0;
    rivalRealtime += g.rivalRealtimeDropped || 0;
    rivalBaselines += g.rivalBaselinesDropped || 0;
    if ((merged + unmapped) % 100 === 0) {
      console.log(`[Repair] phase 1: ${merged} pseudo rows merged, ${unmapped} rows unmapped...`);
    }
  }
  console.log(`[Repair] phase 1 done. ${merged} pseudo rows merged (${movedRows} training rows moved onto their keeper), `
    + `${unmapped} real rows unmapped (${rivalWeekly} weekly rows, ${rivalRealtime} realtime rows and `
    + `${rivalBaselines} collected baseline slots removed from them as the keeper's data under another name).`);

  const cleared = await phase2();
  console.log(`[Repair] phase 2 done. ${cleared} training rows cleared.`);

  const { rows: after } = await pool.query(GROUPS_SQL);
  console.log(`[Repair] Remaining duplicate groups: ${after.length} (expected 0).`);

  // The index is the point of the whole run, so its absence is the exit code.
  const built = await buildIndex();
  if (!built) {
    console.error(`[Repair] FAILED: ${VENUE_ID_INDEX} is not in place. The merges above are committed and will not be redone; `
      + 'discoverBestTime.js keeps refusing to run and collectWeekly.js keeps checking the table by hand until it is.');
    process.exitCode = 1;
    return pool.end();
  }
  console.log('[Repair] Next: node scripts/ml/buildBaselines.js, then node scripts/ml/train/export_training_data.js.');
  return pool.end();
}

main().catch((err) => {
  console.error('[Repair] Fatal:', err.message);
  pool.end();
  process.exitCode = 1;
});
