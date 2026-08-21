'use strict';
// ---------------------------------------------------------------------------
// THE PHOTO SPEND LEDGER, AGAINST A REAL POSTGRES.
// ---------------------------------------------------------------------------
// services/photoStore.js charges Google Place Photos in one statement, and the
// statement is the whole control. It has to be exact, because it is the only
// thing standing between "photos always render" and a Google invoice with a
// four-figure number on it, and because Jayden set the budget in dollars per
// YEAR rather than in requests per day.
//
// The statement is subtle enough that a unit test with a fake pool proves
// nothing about it:
//
//   * the monthly ceiling is checked as (this day's locked count + the sum of
//     the PRIOR days of the month), which only works if ON CONFLICT DO UPDATE
//     really does re-read the conflicting row under its lock;
//   * the daily brake is checked in the DO UPDATE's WHERE, so a refusal has to
//     produce zero rows AND leave the counter untouched;
//   * two concurrent charges at the boundary must not both win.
//
// Every one of those is a server behaviour. So this file boots the repo's
// embedded Postgres, applies the real migration 046, and drives the real SQL.
//
// WHAT IT IS NOT. It does not test the cache bytes or the route; those are in
// __tests__/photoCacheCost.test.js against the real read path. This file is
// only about whether the money control can be made to overspend.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Client } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('./helpers/embeddedPgPort');

const PG_PORT = pickEmbeddedPgPort('photoSpendLedger');

// The statement under test, read out of the module that owns it rather than
// retyped. A copy here could pass forever while the shipped SQL drifted.
const { __test: photoStoreTest } = require('../services/photoStore');
const CHARGE_SQL = photoStoreTest.CHARGE_SQL;

let pg;
let client;
let dataDir;

async function charge(monthCeiling, dayBrake) {
  const r = await client.query(CHARGE_SQL, [monthCeiling, dayBrake]);
  return r.rows.length > 0 ? Number(r.rows[0].fetches) : null;
}

async function totals() {
  const r = await client.query(
    `SELECT COALESCE(SUM(fetches), 0)::int AS month,
            COALESCE(SUM(fetches) FILTER (WHERE day = (NOW() AT TIME ZONE 'utc')::date), 0)::int AS day
       FROM places_photo_spend`
  );
  return r.rows[0];
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-photospend-pg-'));
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'photoSpendLedger', port: PG_PORT, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);
  client = new Client({
    host: '127.0.0.1', port: PG_PORT, user: 'postgres', password: 'postgres', database: 'postgres',
  });
  await client.connect();

  // The real migration, not a hand-written approximation of it.
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '046_places_photo_cache.sql'), 'utf8'
  );
  await client.query(sql);
});

test.after(async () => {
  if (client) await client.end().catch(() => {});
  if (pg) await pg.stop().catch(() => {});
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test.beforeEach(async () => {
  await client.query('DELETE FROM places_photo_spend WHERE true');
});

test('the statement Postgres actually runs is the one the module ships', async () => {
  // A syntax error here is a photo proxy that refuses every fetch in
  // production and serves blank cards, so the parse is the first assertion.
  const first = await charge(10, 10);
  assert.strictEqual(first, 1, 'the first charge of a month must open the row at 1');
  const t = await totals();
  assert.strictEqual(t.day, 1);
  assert.strictEqual(t.month, 1);
});

test('the daily brake is exact: the Nth charge is allowed and the N+1th is not', async () => {
  const BRAKE = 5;
  for (let i = 1; i <= BRAKE; i++) {
    assert.strictEqual(await charge(1000, BRAKE), i, `charge ${i} was refused early`);
  }
  assert.strictEqual(await charge(1000, BRAKE), null, 'the brake did not bind');

  // A refusal must charge NOTHING. A partial charge would leave the caller
  // believing it may proceed, which is the rule utils/placesBudget.js states.
  const t = await totals();
  assert.strictEqual(t.day, BRAKE, 'a refused charge still moved the counter');
});

test('the monthly ceiling binds even when the daily brake has room', async () => {
  const CEILING = 4;
  for (let i = 1; i <= CEILING; i++) {
    assert.strictEqual(await charge(CEILING, 1000), i);
  }
  assert.strictEqual(await charge(CEILING, 1000), null,
    'the month ceiling did not bind, so the annual budget is not a budget');
  assert.strictEqual((await totals()).month, CEILING);
});

test('prior days of the month count toward the ceiling', async () => {
  // The half a single running counter cannot express: yesterday's spend is part
  // of this month's bill. Written directly, because the charge statement only
  // ever writes today.
  await client.query(
    `INSERT INTO places_photo_spend (day, fetches)
     VALUES ((NOW() AT TIME ZONE 'utc')::date - 1, 3)`
  );
  const CEILING = 4;
  assert.strictEqual(await charge(CEILING, 1000), 1, 'the first charge today should fit');
  assert.strictEqual(await charge(CEILING, 1000), null,
    'yesterday was ignored, so a month can be overspent one day at a time');
});

test('a day in the PREVIOUS month does not count against this month', async () => {
  // The other direction. Google bills per calendar month and the free tier
  // resets with it, so carrying last month's spend forward would refuse photos
  // that are paid for.
  await client.query(
    `INSERT INTO places_photo_spend (day, fetches)
     VALUES (DATE_TRUNC('month', (NOW() AT TIME ZONE 'utc')::date)::date - 1, 9999)`
  );
  assert.strictEqual(await charge(3, 1000), 1,
    "last month's spend was counted against this month's ceiling");
});

test('concurrent charges at the boundary cannot both win', async () => {
  // The reason the ceiling is checked inside ON CONFLICT DO UPDATE rather than
  // read first and acted on second. Two connections, one seat left.
  const BRAKE = 3;
  for (let i = 1; i <= BRAKE - 1; i++) await charge(1000, BRAKE);

  const a = new Client({
    host: '127.0.0.1', port: PG_PORT, user: 'postgres', password: 'postgres', database: 'postgres',
  });
  const b = new Client({
    host: '127.0.0.1', port: PG_PORT, user: 'postgres', password: 'postgres', database: 'postgres',
  });
  await a.connect();
  await b.connect();
  try {
    const [ra, rb] = await Promise.all([
      a.query(CHARGE_SQL, [1000, BRAKE]),
      b.query(CHARGE_SQL, [1000, BRAKE]),
    ]);
    const winners = [ra, rb].filter((r) => r.rows.length > 0).length;
    assert.strictEqual(winners, 1, 'two concurrent charges both took the last seat');
    assert.strictEqual((await totals()).day, BRAKE,
      'the counter overshot its brake under concurrency');
  } finally {
    await a.end().catch(() => {});
    await b.end().catch(() => {});
  }
});

test('a hundred concurrent charges never exceed the brake', async () => {
  // The same question at a width that would expose a read-then-act window.
  const BRAKE = 20;
  const CONNECTIONS = 10;
  const clients = [];
  for (let i = 0; i < CONNECTIONS; i++) {
    const c = new Client({
      host: '127.0.0.1', port: PG_PORT, user: 'postgres', password: 'postgres', database: 'postgres',
    });
    await c.connect();
    clients.push(c);
  }
  try {
    const attempts = [];
    for (let i = 0; i < 100; i++) {
      attempts.push(clients[i % CONNECTIONS].query(CHARGE_SQL, [1000, BRAKE]));
    }
    const results = await Promise.all(attempts);
    const granted = results.filter((r) => r.rows.length > 0).length;
    assert.strictEqual(granted, BRAKE, `${granted} charges were granted against a brake of ${BRAKE}`);
    assert.strictEqual((await totals()).day, BRAKE);
  } finally {
    for (const c of clients) await c.end().catch(() => {});
  }
});

test('the cached photos table stores bytes and expires them by age', async () => {
  const KEY = 'a'.repeat(64);
  await client.query(
    `INSERT INTO places_photo_cache (cache_key, content_type, bytes, byte_len)
     VALUES ($1, $2, $3, $4)`,
    [KEY, 'image/jpeg', Buffer.from('pixels'), 6]
  );
  const read = await client.query(
    'SELECT content_type, bytes, byte_len FROM places_photo_cache WHERE cache_key = $1', [KEY]
  );
  assert.strictEqual(read.rows[0].content_type, 'image/jpeg');
  assert.deepStrictEqual(read.rows[0].bytes, Buffer.from('pixels'));

  // Expiry is a deletion, because the caching window is a terms obligation
  // rather than a disk-pressure heuristic.
  await client.query(
    "UPDATE places_photo_cache SET fetched_at = NOW() - INTERVAL '31 days' WHERE cache_key = $1",
    [KEY]
  );
  const gone = await client.query(
    `DELETE FROM places_photo_cache
      WHERE fetched_at <= NOW() - ($1::bigint * INTERVAL '1 millisecond')`,
    [30 * 24 * 60 * 60 * 1000]
  );
  assert.strictEqual(gone.rowCount, 1, 'content past its caching window survived the pruner');
});
