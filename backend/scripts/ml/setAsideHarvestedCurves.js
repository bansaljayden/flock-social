// ---------------------------------------------------------------------------
// Set the harvested venues' curves aside, and put them back for the ship step.
//
//   node scripts/ml/setAsideHarvestedCurves.js            dry run: counts and checks, writes nothing
//   node scripts/ml/setAsideHarvestedCurves.js --commit   the swap
//   node scripts/ml/setAsideHarvestedCurves.js --restore  copy them back (the ship step, before the status change)
//
// WHY (2026-11-21). ml_venue_baselines had grown to 27.2 million rows, about 24
// million of them the curves of venues the harvest added ('harvested',
// inactive: no hourly sweep calls them, no neighbour box counts them, and
// nothing served reads them but a direct lookup of that place). The hourly
// collector's recent-deviation rebuild (buildRecentDeviation.js) joins every
// live reading of 28 days with this table, so its cost followed the table:
// 90 s on 2026-11-18, 240 s on 2026-11-21, and from 17:01 UTC that day its
// first statement passed its two-minute cap every hour. the maintainer chose to move
// the curves aside until the harvest-inclusive candidate ships (or does not),
// rather than delete them; the hourly rebuilds stopped averaging harvested
// venues the same day (buildBaselines includeHarvested, collectRealtime).
//
// HOW. The kept rows are COPIED and the table is SWAPPED, rather than 24 million
// rows deleted: the copy writes about a tenth as much, and leaves a table whose
// pages hold only what the readers need (a DELETE leaves the heap at its size
// until a VACUUM FULL, and every sequential scan reads it). In one transaction:
// lock ml_venue_baselines in SHARE mode (its writers wait; its readers do not),
// copy every row of a place that is not a harvested venue's into a new table,
// build the same indexes and the same primary key, then take the table's
// exclusive lock (readers queue behind it for at most LOCK_TIMEOUT_MS; past it
// the transaction rolls back and nothing has changed) and swap the names. The
// old table, all 27 million rows, becomes ml_venue_baselines_set_aside, with
// its indexes renamed to match; the new one takes the old table's name and its
// indexes the old names, so migrations 006 and 138 (CREATE INDEX IF NOT EXISTS
// by name) find what they expect. Run it at :20 to :45 past an hour: the
// collector's recent-deviation rebuild reads this table for minutes from about
// :59, and the exclusive lock would wait for it.
//
// RESTORE. Every place with no curve in the live table gets its set-aside curve
// back, whole (a place the live table has any slot for keeps the live curve),
// in short transactions, ON CONFLICT DO NOTHING. The ship step runs it, then
// `node scripts/ml/buildBaselines.js --targeted` for the venues harvested after
// the set-aside, then the status change. The set-aside table is never dropped
// here: removing it is the maintainer's call once a model has shipped.
// ---------------------------------------------------------------------------
require('dotenv').config();
const { Pool } = require('pg');

const LIVE = 'ml_venue_baselines';
const SET_ASIDE = 'ml_venue_baselines_set_aside';
const BUILDING = 'ml_venue_baselines_keep';
const LOCK_TIMEOUT_MS = 5000;
const RESTORE_CHUNK_PLACES = 2000;
// A place is set aside only when its venue is a harvested one. ml_venues'
// google_place_id is unique (migration 006), so a place has one status; a slot
// whose place has no venue row at all stays live, as everything did before.
const HARVESTED_PLACE = (alias) => `EXISTS (
    SELECT 1 FROM ml_venues hv
     WHERE hv.google_place_id = ${alias}.google_place_id
       AND hv.besttime_status = 'harvested')`;

// What would stop a rename from being the whole story: anything that refers to
// the table by its identity (views, rules, triggers, foreign keys either way,
// row security, publications) would follow the old table to its new name.
const DEPENDENTS_SQL = `
  SELECT 'view or rule ' || r.ev_class::regclass::text AS what
    FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
   WHERE d.refobjid = $1::regclass AND d.classid = 'pg_rewrite'::regclass AND r.ev_class <> $1::regclass
  UNION ALL
  SELECT 'trigger ' || tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal
  UNION ALL
  SELECT 'foreign key ' || conname FROM pg_constraint
   WHERE contype = 'f' AND (conrelid = $1::regclass OR confrelid = $1::regclass)
  UNION ALL
  SELECT 'row security policy ' || polname FROM pg_policy WHERE polrelid = $1::regclass
  UNION ALL
  SELECT 'publication ' || p.pubname FROM pg_publication_rel pr JOIN pg_publication p ON p.oid = pr.prpubid
   WHERE pr.prrelid = $1::regclass`;

// The live table's indexes, as Postgres prints them, and which one is the key.
const INDEXES_SQL = `
  SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS def, i.indisprimary AS primary_key
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = $1::regclass
   ORDER BY c.relname`;

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// The same index, on the new table, under a name of its own until the swap.
function indexOn(def, oldName, newName) {
  const re = new RegExp(`^CREATE (UNIQUE )?INDEX ${oldName} ON (public\\.)?${LIVE} `);
  if (!re.test(def)) throw new Error(`unexpected index definition: ${def}`);
  return def.replace(re, (m, unique) => `CREATE ${unique || ''}INDEX ${newName} ON ${BUILDING} `);
}

async function tableExists(db, name) {
  const { rows: [r] } = await db.query('SELECT to_regclass($1) IS NOT NULL AS present', [name]);
  return r.present;
}

async function survey(db) {
  if (await tableExists(db, SET_ASIDE)) {
    return { refused: `${SET_ASIDE} already exists: the curves were set aside before. --restore puts them back.` };
  }
  const { rows: dependents } = await db.query(DEPENDENTS_SQL, [LIVE]);
  if (dependents.length) {
    return { refused: `${LIVE} has dependents a rename would carry with it: ${dependents.map((d) => d.what).join(', ')}` };
  }
  // The new table is created by this connection's role with no grants or
  // storage options of its own, so the old one must have none either.
  const { rows: [meta] } = await db.query(`
    SELECT pg_get_userbyid(c.relowner) = current_user AS owned, c.relacl IS NULL AS no_grants,
           c.reloptions IS NULL AS no_options
      FROM pg_class c WHERE c.oid = $1::regclass`, [LIVE]);
  if (!meta.owned || !meta.no_grants || !meta.no_options) {
    return { refused: `${LIVE} has another owner, grants or storage options the new table would not carry` };
  }
  const { rows: indexes } = await db.query(INDEXES_SQL, [LIVE]);
  // A join, not a subquery per row: google_place_id is unique in ml_venues, so
  // no slot is counted twice.
  const { rows: [counts] } = await db.query(`
    SELECT COUNT(*)::bigint AS total, COUNT(*) FILTER (WHERE hv.google_place_id IS NULL)::bigint AS kept
      FROM ${LIVE} b
      LEFT JOIN ml_venues hv ON hv.google_place_id = b.google_place_id AND hv.besttime_status = 'harvested'`);
  const { rows: [size] } = await db.query(
    `SELECT pg_size_pretty(pg_total_relation_size($1::regclass)) AS table_size,
            pg_size_pretty(pg_database_size(current_database())) AS database_size`, [LIVE]);
  return { indexes, total: Number(counts.total), kept: Number(counts.kept), ...size };
}

async function setAside(pool, { commit = false, log = console.log } = {}) {
  const client = await pool.connect();
  let broken = false;
  try {
    // A dry run reads and locks nothing anyone else waits on.
    await client.query(commit ? 'BEGIN' : 'BEGIN READ ONLY');
    await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
    // The writers of the table wait from here to COMMIT; its readers never do
    // until the exclusive lock below.
    if (commit) await client.query(`LOCK TABLE ${LIVE} IN SHARE MODE`);
    const s = await survey(client);
    if (s.refused) {
      await client.query('ROLLBACK');
      return { ok: false, refused: s.refused };
    }
    log(`[SetAside] ${LIVE}: ${s.total} rows (${s.table_size}; database ${s.database_size}); `
      + `${s.kept} belong to places that are not harvested venues and stay, ${s.total - s.kept} are set aside.`);
    if (!commit) {
      await client.query('ROLLBACK');
      return { ok: true, dryRun: true, total: s.total, kept: s.kept, indexes: s.indexes.map((i) => i.name) };
    }
    await client.query(`CREATE TABLE ${BUILDING} (LIKE ${LIVE} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING STORAGE INCLUDING COMMENTS)`);
    const copied = await client.query(`INSERT INTO ${BUILDING} SELECT b.* FROM ${LIVE} b WHERE NOT ${HARVESTED_PLACE('b')}`);
    if (copied.rowCount !== s.kept) throw new Error(`copied ${copied.rowCount} rows, counted ${s.kept}`);
    const renames = [];
    for (const idx of s.indexes) {
      const temp = `${idx.name}_keep`;
      if (idx.primary_key) {
        const cols = /\((.*)\)$/.exec(idx.def)[1];
        await client.query(`ALTER TABLE ${BUILDING} ADD CONSTRAINT ${quoteIdent(temp)} PRIMARY KEY (${cols})`);
      } else {
        await client.query(indexOn(idx.def, idx.name, quoteIdent(temp)));
      }
      renames.push(idx);
    }
    await client.query(`ANALYZE ${BUILDING}`);
    const { rows: [oids] } = await client.query(
      'SELECT $1::regclass::oid AS old_oid, $2::regclass::oid AS new_oid', [LIVE, BUILDING]);
    // The swap. Every reader of the table waits here, for at most the lock
    // timeout; past it this throws, the transaction rolls back, and nothing
    // has changed. Only catalog renames run under the lock, milliseconds.
    await client.query(`LOCK TABLE ${LIVE} IN ACCESS EXCLUSIVE MODE`);
    await client.query(`ALTER TABLE ${LIVE} RENAME TO ${SET_ASIDE}`);
    for (const idx of renames) {
      await client.query(`ALTER INDEX ${quoteIdent(idx.name)} RENAME TO ${quoteIdent(`${idx.name}_set_aside`)}`);
    }
    await client.query(`ALTER TABLE ${BUILDING} RENAME TO ${LIVE}`);
    for (const idx of renames) {
      await client.query(`ALTER INDEX ${quoteIdent(`${idx.name}_keep`)} RENAME TO ${quoteIdent(idx.name)}`);
    }
    // Each name now names the other table: checked by identity, not by a count
    // that would hold every reader while it scanned.
    const { rows: [after] } = await client.query(
      'SELECT $1::regclass::oid AS live_oid, $2::regclass::oid AS aside_oid', [LIVE, SET_ASIDE]);
    if (after.live_oid !== oids.new_oid || after.aside_oid !== oids.old_oid) {
      throw new Error('after the swap the names do not point where they should');
    }
    await client.query('COMMIT');
    log(`[SetAside] Done: ${LIVE} holds ${s.kept} rows; ${SET_ASIDE} holds all ${s.total} as they stood.`);
    return { ok: true, total: s.total, kept: s.kept, indexes: renames.map((i) => i.name) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { broken = true; });
    throw err;
  } finally {
    client.release(broken || undefined);
  }
}

// The set-aside curves of every place the live table holds no slot for, a
// chunk of places per transaction.
async function restore(pool, { chunkPlaces = RESTORE_CHUNK_PLACES, log = console.log } = {}) {
  if (!(await tableExists(pool, SET_ASIDE))) return { ok: false, refused: `${SET_ASIDE} does not exist: nothing was set aside.` };
  const { rows: places } = await pool.query(`
    SELECT DISTINCT s.google_place_id
      FROM ${SET_ASIDE} s
     WHERE NOT EXISTS (SELECT 1 FROM ${LIVE} b WHERE b.google_place_id = s.google_place_id)
     ORDER BY 1`);
  let restored = 0;
  for (let i = 0; i < places.length; i += chunkPlaces) {
    const chunk = places.slice(i, i + chunkPlaces).map((r) => r.google_place_id);
    const res = await pool.query(`
      INSERT INTO ${LIVE} (google_place_id, day_of_week, hour, baseline, source, updated_at)
      SELECT s.google_place_id, s.day_of_week, s.hour, s.baseline, s.source, s.updated_at
        FROM ${SET_ASIDE} s
       WHERE s.google_place_id = ANY($1::text[])
         AND NOT EXISTS (SELECT 1 FROM ${LIVE} b WHERE b.google_place_id = s.google_place_id)
      ON CONFLICT DO NOTHING`, [chunk]);
    restored += res.rowCount;
  }
  log(`[SetAside] Restored ${restored} slots for ${places.length} places; ${SET_ASIDE} is left as it was.`);
  return { ok: true, places: places.length, restored };
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });
  try {
    const result = process.argv.includes('--restore')
      ? await restore(pool)
      : await setAside(pool, { commit: process.argv.includes('--commit') });
    if (!result.ok) {
      console.error(`[SetAside] REFUSED: ${result.refused}`);
      process.exitCode = 1;
    } else if (result.dryRun) {
      console.log(`[SetAside] Dry run, nothing written. Indexes the new table would get: ${result.indexes.join(', ')}. `
        + 'Run again with --commit to swap.');
    }
  } finally {
    await pool.end();
  }
}

module.exports = { setAside, restore, LIVE, SET_ASIDE, LOCK_TIMEOUT_MS };

if (require.main === module) {
  main().catch((err) => {
    console.error('[SetAside] FAILED:', err.message);
    process.exit(1);
  });
}
