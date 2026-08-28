// ---------------------------------------------------------------------------
// ARCHIVE THE CURRENT WEEKLY WINDOW BEFORE ANY REFRESH
// ---------------------------------------------------------------------------
// collectWeekly.js upserts ON CONFLICT (venue, day, hour) DO UPDATE, newest
// wins. That is the right behavior for serving and the WRONG behavior for the
// drift features a second collection window exists to unlock: without a copy
// of window 1, a refresh leaves nothing to diff against and the whole reason
// for buying the second window is destroyed silently.
//
// So this runs FIRST, once, before the first refresh call spends a credit:
//
//   node scripts/ml/archiveWeeklyWindow.js            (from backend/)
//
// It copies every weekly-mode row into ml_training_data_weekly_w1 and refuses
// to run if that table already exists, so it cannot overwrite an archive with
// post-refresh rows if it is run twice by accident. A second refresh in a
// later season archives into _w2 via --suffix=w2, and so on.
//
// Read-only against the live table, additive against the archive name, no
// DELETE and no UPDATE anywhere in this file.
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});

async function main() {
  const suffixArg = process.argv.find((a) => a.startsWith('--suffix='));
  const suffix = suffixArg ? suffixArg.split('=')[1] : 'w1';
  if (!/^[a-z0-9_]{1,16}$/.test(suffix)) {
    console.error(`[ML:Archive] Bad --suffix "${suffix}". Lowercase letters, digits, underscore, max 16.`);
    process.exitCode = 1;
    return pool.end();
  }
  const archiveTable = `ml_training_data_weekly_${suffix}`;

  const exists = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [archiveTable]
  );
  if (exists.rows.length > 0) {
    console.error(
      `[ML:Archive] ${archiveTable} already exists and this script will not touch it. `
      + `If you mean to take a NEW archive after a refresh, pass --suffix=w2 (or the next number).`
    );
    process.exitCode = 1;
    return pool.end();
  }

  const before = await pool.query(
    `SELECT COUNT(*)::bigint AS n, MIN(collected_at) AS oldest, MAX(collected_at) AS newest
       FROM ml_training_data WHERE collection_mode = 'weekly'`
  );
  const { n, oldest, newest } = before.rows[0];
  if (Number(n) === 0) {
    console.error('[ML:Archive] No weekly rows to archive. Nothing done.');
    process.exitCode = 1;
    return pool.end();
  }

  console.log(`[ML:Archive] Archiving ${n} weekly rows (${oldest} to ${newest}) into ${archiveTable}...`);
  await pool.query(
    `CREATE TABLE ${archiveTable} AS SELECT * FROM ml_training_data WHERE collection_mode = 'weekly'`
  );
  const after = await pool.query(`SELECT COUNT(*)::bigint AS n FROM ${archiveTable}`);
  if (after.rows[0].n !== n) {
    console.error(
      `[ML:Archive] COUNT MISMATCH: live ${n} vs archive ${after.rows[0].n}. `
      + 'Investigate before refreshing anything.'
    );
    process.exitCode = 1;
    return pool.end();
  }
  console.log(`[ML:Archive] Done. ${after.rows[0].n} rows in ${archiveTable}. Safe to refresh.`);
  return pool.end();
}

main().catch((err) => {
  console.error('[ML:Archive] Failed:', err.message);
  process.exitCode = 1;
  pool.end();
});
