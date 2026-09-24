'use strict';
// ---------------------------------------------------------------------------
// THE FREE-TIER METERS SURVIVE A RESTART, AND THE FIRST WEEK IS FREE.
//
// services/forecastUsage.js and services/birdieUsage.js enforce from memory and
// Railway restarts the process on every push, so until migration 075 a month's
// forecast allowance was really an allowance per deploy. services/usageStore.js
// writes the meters through to usage_meters and loads the current period back
// at boot. This suite runs that against a real, migrated Postgres and simulates
// the restart by loading fresh copies of the three modules, which is exactly
// what a new process is to them: empty maps, then hydrate().
//
// It also runs the first-week grace (services/entitlements.js
// NEW_ACCOUNT_GRACE_DAYS) against real rows, because the end of the week is
// computed by Postgres from a naive TIMESTAMP column and only a real database
// can say whether that arithmetic lands on the right day.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Pool } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');

const PG_PORT = pickEmbeddedPgPort('usageMeters');
let pg;
let testPool;
let dataDir;
const appPool = require('../config/database');
const realQuery = appPool.query;

// Assembled at runtime so nothing here reads as a real credential.
const ENV = {
  PAYWALL_ENABLED: 'true',
  REVENUECAT_WEBHOOK_SECRET: ['usage', 'meters', 'test', 'w'.repeat(24)].join('-'),
};
const savedEnv = {};

const METER_MODULES = ['../services/usageStore', '../services/forecastUsage', '../services/birdieUsage'];
let current = null;

// A new process, as far as the meters can tell: fresh module state, nothing
// loaded, writes off until hydrate() succeeds.
function restart() {
  if (current) current.store.__reset();
  for (const m of METER_MODULES) delete require.cache[require.resolve(m)];
  current = {
    store: require('../services/usageStore'),
    forecast: require('../services/forecastUsage'),
    birdie: require('../services/birdieUsage'),
  };
  return current;
}

test.before(async () => {
  for (const [k, v] of Object.entries(ENV)) { savedEnv[k] = process.env[k]; process.env[k] = v; }
  dataDir = path.join(os.tmpdir(), `flock-usagemeters-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'usageMeters', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase('flock_usagemeters_test');
  testPool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_usagemeters_test` });
  const { migrate } = require('../db/migrate');
  await migrate(testPool);
  appPool.query = (text, params) => testPool.query(text, params);
});

test.after(async () => {
  if (current) current.store.__reset();
  appPool.query = realQuery;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await testPool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

let n = 0;
async function makeUser({ daysOld = 30 } = {}) {
  n += 1;
  const r = await testPool.query(
    `INSERT INTO users (email, password, name, created_at)
     VALUES ($1, 'x', 'Meter', NOW() - make_interval(days => $2::int)) RETURNING id`,
    [`meter${n}@example.com`, daysOld]
  );
  return r.rows[0].id;
}

async function rowsFor(userId) {
  const r = await testPool.query(
    'SELECT meter, period, used, tokens, venues FROM usage_meters WHERE user_id = $1 ORDER BY meter',
    [userId]
  );
  return r.rows;
}

const month = () => new Date().toISOString().slice(0, 7);
const day = () => new Date().toISOString().slice(0, 10);

test('before the stored meters are loaded, nothing is written: a zero never overwrites a real count', async () => {
  const uid = await makeUser();
  await testPool.query(
    `INSERT INTO usage_meters (user_id, meter, period, used, venues) VALUES ($1, 'forecast', $2, 12, '{}')`,
    [uid, month()]
  );
  const { store, forecast } = restart();
  forecast.recordView(uid, 'NOT_LOADED_YET');
  await store.flushNow();
  const [row] = await rowsFor(uid);
  assert.strictEqual(row.used, 12, 'a process that never read the table wrote its own count over the stored one');
});

test('a month of forecast views and a day of Birdie come back after a restart', async () => {
  const uid = await makeUser();
  let { store, forecast, birdie } = restart();
  assert.strictEqual(await store.hydrate(), true);

  forecast.recordView(uid, 'VENUE_A');
  forecast.recordView(uid, 'VENUE_B');
  forecast.recordView(uid, 'VENUE_A'); // reopening is free
  forecast.recordView(uid);            // a Birdie turn charges without a venue
  birdie.checkUserRateLimit(uid, 10);
  birdie.checkUserRateLimit(uid, 10);
  const charged = birdie.estimateGeminiTokens(4000);
  assert.strictEqual(birdie.allowGeminiCall(uid, charged), true);
  await store.flushNow();

  const stored = await rowsFor(uid);
  const f = stored.find((r) => r.meter === 'forecast');
  const b = stored.find((r) => r.meter === 'birdie');
  assert.strictEqual(f.period, month());
  assert.strictEqual(f.used, 3);
  assert.deepStrictEqual([...f.venues].sort(), ['VENUE_A', 'VENUE_B']);
  assert.strictEqual(b.period, day());
  assert.strictEqual(b.used, 2);
  assert.strictEqual(Number(b.tokens), charged);

  ({ store, forecast, birdie } = restart());
  assert.strictEqual(forecast.getUsedThisMonth(uid), 0, 'the restart did not start from empty memory');
  assert.strictEqual(await store.hydrate(), true);
  assert.strictEqual(forecast.getUsedThisMonth(uid), 3, 'the month reset on restart');
  assert.strictEqual(forecast.hasViewed(uid, 'VENUE_A'), true, 'a venue already paid for would be charged again');
  assert.strictEqual(forecast.recordView(uid, 'VENUE_B'), 3, 'reopening a stored venue spent the allowance');
  assert.strictEqual(birdie.getUsedToday(uid), 2, 'the Birdie day reset on restart');
  const spend = birdie.geminiSpendStatus(uid);
  assert.strictEqual(spend.userDayRemaining, birdie.PER_USER_DAILY_TOKENS - charged, 'the token day reset on restart');
  assert.ok(spend.globalUsed >= charged, 'the global day was not rebuilt from the stored rows');
  assert.strictEqual(spend.persisted, true);
});

test('a refunded message is written back down, so a restart does not re-charge it', async () => {
  const uid = await makeUser();
  let { store, birdie } = restart();
  await store.hydrate();
  const first = birdie.checkUserRateLimit(uid, 10);
  birdie.checkUserRateLimit(uid, 10);
  birdie.refundTurn(uid, first.chargeDay);
  await store.flushNow();
  assert.strictEqual((await rowsFor(uid))[0].used, 1);
  ({ store, birdie } = restart());
  await store.hydrate();
  assert.strictEqual(birdie.getUsedToday(uid), 1);
});

test('a stored row from another period is ignored, and old rows are pruned', async () => {
  const uid = await makeUser();
  await testPool.query(
    `INSERT INTO usage_meters (user_id, meter, period, used, venues, updated_at)
     VALUES ($1, 'forecast', '2000-01', 29, '{}', NOW() - make_interval(days => $2::int))`,
    [uid, 400]
  );
  const { store, forecast } = restart();
  await store.hydrate();
  assert.strictEqual(forecast.getUsedThisMonth(uid), 0, 'a past month was loaded as this month');
  // The prune runs as hydrate() turns writes on; give it a moment to land.
  for (let i = 0; i < 40 && (await rowsFor(uid)).length > 0; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.deepStrictEqual(await rowsFor(uid), [], `a row older than ${store.KEEP_DAYS} days survived the prune`);
});

test('the table refuses a period in the wrong shape for its meter', async () => {
  const uid = await makeUser();
  await assert.rejects(
    testPool.query(`INSERT INTO usage_meters (user_id, meter, period) VALUES ($1, 'forecast', '2026-09-24')`, [uid]),
    /usage_meters_period_shape/
  );
  await assert.rejects(
    testPool.query(`INSERT INTO usage_meters (user_id, meter, period) VALUES ($1, 'birdie', '2026-09')`, [uid]),
    /usage_meters_period_shape/
  );
});

test('deleting the account deletes its meters', async () => {
  const uid = await makeUser();
  const { store, forecast } = restart();
  await store.hydrate();
  forecast.recordView(uid, 'GONE');
  await store.flushNow();
  assert.strictEqual((await rowsFor(uid)).length, 1);
  await testPool.query('DELETE FROM users WHERE id = $1', [uid]);
  assert.deepStrictEqual(await rowsFor(uid), []);
  // A change still in memory for the deleted account is dropped quietly.
  forecast.recordView(uid, 'AFTER');
  await store.flushNow();
  assert.deepStrictEqual(await rowsFor(uid), []);
});

// ---------------------------------------------------------------------------
// THE FIRST WEEK
// ---------------------------------------------------------------------------

test('an account made today is in its unmetered week, ending seven days after it was made', async () => {
  const { getPremiumState, NEW_ACCOUNT_GRACE_DAYS } = require('../services/entitlements');
  const uid = await makeUser({ daysOld: 0 });
  const state = await getPremiumState(uid);
  assert.strictEqual(state.known, true);
  assert.strictEqual(state.premium, false, 'the first week made an account premium');
  assert.strictEqual(state.inGrace, true);
  const expected = Date.now() + NEW_ACCOUNT_GRACE_DAYS * 864e5;
  assert.ok(Math.abs(Date.parse(state.graceEndsAt) - expected) < 5 * 60 * 1000,
    `the week ends at ${state.graceEndsAt}, not seven days from now; the naive created_at was read in the wrong zone`);
});

test('an account eight days old is metered, and the snapshot shows the limits it is held to', async () => {
  const { getEntitlements } = require('../services/entitlements');
  const oldId = await makeUser({ daysOld: 8 });
  const old = await getEntitlements(oldId);
  assert.strictEqual(old.graceEndsAt, null);
  assert.strictEqual(old.forecast.limit, require('../services/forecastUsage').FREE_MONTHLY_FORECASTS);
  assert.strictEqual(old.birdie.limit, require('../services/birdieUsage').FREE_DAILY_LIMIT);

  const newId = await makeUser({ daysOld: 1 });
  const fresh = await getEntitlements(newId);
  assert.ok(Date.parse(fresh.graceEndsAt) > Date.now(), 'the snapshot hides that the week is running');
  assert.strictEqual(fresh.isPremium, false);
  assert.strictEqual(fresh.forecast.limit, null, 'a first-week account was shown a forecast limit nobody enforces');
  assert.strictEqual(fresh.birdie.limit, require('../services/birdieUsage').PREMIUM_DAILY_LIMIT);
});

test('a subscriber is never reported as in a grace week, and the paywall off reports none', async () => {
  const { getEntitlements } = require('../services/entitlements');
  const uid = await makeUser({ daysOld: 1 });
  await testPool.query('UPDATE users SET is_premium = true WHERE id = $1', [uid]);
  assert.strictEqual((await getEntitlements(uid)).graceEndsAt, null);
  await testPool.query('UPDATE users SET is_premium = false WHERE id = $1', [uid]);
  process.env.PAYWALL_ENABLED = 'false';
  try {
    assert.strictEqual((await getEntitlements(uid)).graceEndsAt, null,
      'with nothing metered, a grace end is a countdown to nothing');
  } finally {
    process.env.PAYWALL_ENABLED = 'true';
  }
});
