// ---------------------------------------------------------------------------
// Versioned migrations. Files in backend/migrations/*.sql run in name order,
// once each, recorded in schema_migrations.
//
// Two modes:
//  - default: the whole file runs in ONE transaction; any error rolls back,
//    logs loudly, and FAILS THE BOOT. No more silent partially-migrated
//    deployments (the old inline runner swallowed errors per-group).
//  - `-- @tolerant` (first line): statements run one-by-one and errors are
//    logged but skipped. Reserved for 001_baseline.sql, which replays the
//    historical idempotent DDL against databases in unknown drift states.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

async function migrate(pool) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ DEFAULT NOW()
     )`
  );

  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const appliedRes = await pool.query('SELECT name FROM schema_migrations');
  const applied = new Set(appliedRes.rows.map((r) => r.name));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const tolerant = sql.trimStart().startsWith('-- @tolerant');
    console.log(`[migrate] applying ${file}${tolerant ? ' (tolerant)' : ''}`);

    if (tolerant) {
      const stmts = sql
        .split(/;\s*(?:\r?\n|$)/)
        .map((s) => s.replace(/^\s*--[^\n]*\n?/gm, '').trim())
        .filter(Boolean);
      for (const stmt of stmts) {
        try {
          await pool.query(stmt);
        } catch (e) {
          console.warn(`[migrate] ${file} tolerant skip: ${e.message}`);
        }
      }
      await pool.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
    } else {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`[migrate] FAILED ${file}: ${e.message}`);
        throw e; // boot must not continue on a half-applied schema
      } finally {
        client.release();
      }
    }
    console.log(`[migrate] applied ${file}`);
  }
}

module.exports = { migrate };
