// ---------------------------------------------------------------------------
// LOCAL DEMO STACK: embedded Postgres + seeded demo data, for screenshots.
// ---------------------------------------------------------------------------
// Boots the same embedded Postgres the migration tests use, applies the full
// migration chain, seeds ONE demo user and TODAY'S REAL game rows (copied
// verbatim from the collector's own output, never invented), then prints the
// DATABASE_URL to boot server.js against. Exists so the app can be driven
// locally without the production database anywhere in the loop: the boot
// guard in server.js stays untouched and untriggered.
//
//   node scripts/demoLocalStack.js
//
// Leaves the postgres running until Ctrl+C (or the process is killed); the
// data directory is a temp dir, disposable by design.
// ---------------------------------------------------------------------------

const path = require('path');
const os = require('os');
const fs = require('fs');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('../__tests__/helpers/embeddedPgPort');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function main() {
  // Registered in the helper's slot registry after all: 55943 sat inside
  // Windows' dynamic client-port range, the exact collision the helper's own
  // header warns about (Codex review, 2026-09-01).
  const port = pickEmbeddedPgPort('demoLocalStack');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-demo-pg-'));
  const pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'demoLocalStack', port, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;

  process.env.DATABASE_URL = url;
  delete process.env.PGHOST;
  const { migrate } = require('../db/migrate');
  const pool = new Pool({ connectionString: url });
  await migrate(pool);

  // The demo login. The password comes from the environment or is minted
  // fresh and printed, NEVER a literal: the first version of this script
  // embedded the Apple-review packet's real password, which lives in a
  // gitignored file precisely so it stays out of history, and the pre-commit
  // diff scan caught it one line from shipping.
  const password = process.env.DEMO_PASSWORD
    || require('crypto').randomBytes(9).toString('base64url');
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO users (email, password, name, email_verified, terms_accepted_at, date_of_birth)
     VALUES ($1, $2, $3, true, NOW(), '2004-01-15')
     ON CONFLICT (email) DO NOTHING`,
    ['demo@localhost.test', hash, 'Demo User']
  );
  console.log(`[demo] login: demo@localhost.test / ${password}`);

  // Today's REAL schedule, verbatim from production ml_sports_events. The
  // rows are passed in over argv as JSON so this script cannot invent a game:
  // no argument, no games, and the card honestly shows no line.
  const gamesArg = process.argv.find((a) => a.startsWith('--games-file='));
  if (gamesArg) {
    const games = JSON.parse(fs.readFileSync(gamesArg.split('=').slice(1).join('='), 'utf8'));
    for (const g of games) {
      await pool.query(
        `INSERT INTO ml_sports_events
           (sportsdb_event_id, league, season, team_key, is_home, opponent,
            event_utc, event_local_date, event_local_time, venue_name, venue_lat, venue_lon, raw_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (sportsdb_event_id) DO NOTHING`,
        [g.sportsdb_event_id, g.league, g.season, g.team_key, g.is_home, g.opponent,
         g.event_utc, g.event_local_date, g.event_local_time, g.venue_name, g.venue_lat, g.venue_lon, g.raw_status]
      );
    }
    console.log(`[demo] seeded ${games.length} real game rows`);
  }

  await pool.end();
  console.log(`DEMO_DB_READY ${url}`);
  // Hold the postgres open until killed.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('[demo] fatal:', err);
  process.exit(1);
});
