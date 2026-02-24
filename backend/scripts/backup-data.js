require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Build DATABASE_URL from individual PG* vars if not set
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
  ssl: { rejectUnauthorized: false },
});

async function backup() {
  const client = await pool.connect();
  console.log('Starting database backup...\n');

  try {
    const tables = [
      'users',
      'flocks',
      'flock_members',
      'messages',
      'direct_messages',
      'emoji_reactions',
      'venue_votes',
      'stories',
      'friends',
      'friend_requests',
    ];

    const data = {
      exported_at: new Date().toISOString(),
      tables: {},
    };

    for (const table of tables) {
      try {
        const result = await client.query(`SELECT * FROM ${table}`);
        data.tables[table] = {
          count: result.rows.length,
          rows: result.rows,
        };
        console.log(`  ✅ ${table}: ${result.rows.length} rows`);
      } catch (err) {
        // Table might not exist
        console.log(`  ⚠️  ${table}: skipped (${err.message.split('\n')[0]})`);
        data.tables[table] = { count: 0, rows: [], error: 'table not found' };
      }
    }

    // Save to file
    const backupDir = path.join(__dirname, '..', 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-${timestamp}.json`;
    const filepath = path.join(backupDir, filename);

    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));

    // Also save a "latest" copy for quick access
    const latestPath = path.join(backupDir, 'backup-latest.json');
    fs.writeFileSync(latestPath, JSON.stringify(data, null, 2));

    console.log(`\n========================================`);
    console.log(`  Backup saved successfully!`);
    console.log(`  File: ${filepath}`);
    console.log(`  Latest: ${latestPath}`);
    console.log(`========================================\n`);
  } catch (err) {
    console.error('Backup failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

backup();
