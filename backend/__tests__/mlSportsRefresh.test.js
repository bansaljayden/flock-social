// Run: node --test  (from backend/)
//
// THE GAME SCHEDULE REFRESHES ITSELF, AND NEVER AT THE COLLECTOR'S EXPENSE.
//
// ml_sports_events feeds both serving (mlPredictor.sportsFeatureValues) and
// training, and until this existed nothing ran collectSportsSchedules.js on
// a schedule, so the table went stale after its one hand pull. The hourly
// realtime collector now calls refreshSportsIfDue() at the end of every run.
// Pinned here, with a stubbed pool and a stubbed fetch and no network:
//   1. currentSeasons names the season in play for each league across the
//      year, so the refresh never pulls a finished season forever.
//   2. A table refreshed within 20 hours is left alone (one SELECT, no call).
//   3. No key means no call and a log line saying so.
//   4. A stale or empty table is refreshed for the current seasons.
//   5. A SportsDB failure is swallowed and logged, never thrown.
//   6. Requiring the module does nothing: no .env load, no pool, no fetch.
//   7. collectRealtime.js calls it inside run()'s try, after the offsets.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_PATH = path.join(__dirname, '..', 'scripts', 'ml', 'collectSportsSchedules.js');
const {
  currentSeasons, refreshSportsIfDue, TRACKED, FRESH_HOURS,
} = require(MODULE_PATH);

const NOW = new Date('2026-09-26T12:00:00Z');

// lastCollected stamps every tracked league; byLeague overrides single
// leagues (a value of null leaves that league with no rows at all).
function stubPool({ lastCollected = null, byLeague = {} } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/MAX\(collected_at\)/.test(sql)) {
        if (lastCollected == null && Object.keys(byLeague).length === 0) return { rows: [] };
        const codes = [...new Set(TRACKED.map((t) => t.code))];
        const rows = codes
          .map((league) => ({ league, last: league in byLeague ? byLeague[league] : lastCollected }))
          .filter((r) => r.last != null);
        return { rows };
      }
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: calls.filter((c) => /INSERT INTO ml_sports_events/.test(c.sql)).length, lo: null, hi: null }] };
      return { rows: [] };
    },
  };
}

// A SportsDB stand-in: every tracked team resolves in its own league (the
// two NCAA schools share one), no venue lookup, and each league's season
// holds one home game for its first tracked team. Records every URL.
function stubSportsDb() {
  const urls = [];
  const leagueIds = new Map();
  const teamId = (t) => `team-${t.key}`;
  const leagueId = (league) => {
    if (!leagueIds.has(league)) leagueIds.set(league, `L${leagueIds.size + 1}`);
    return leagueIds.get(league);
  };
  for (const t of TRACKED) leagueId(t.league);
  const fetchStub = async (url) => {
    urls.push(url);
    const u = new URL(url);
    const file = u.pathname.split('/').pop();
    let body = {};
    if (file === 'searchteams.php') {
      const name = u.searchParams.get('t');
      const t = TRACKED.find((x) => x.search === name);
      body = { teams: [{ strTeam: t.search, strLeague: t.league, idTeam: teamId(t), idLeague: leagueId(t.league), strStadium: `${t.key} park` }] };
    } else if (file === 'eventsseason.php') {
      const id = u.searchParams.get('id');
      const league = [...leagueIds].find(([, v]) => v === id)[0];
      const t = TRACKED.find((x) => x.league === league);
      body = {
        events: [{
          idEvent: `ev-${t.key}`, idHomeTeam: teamId(t), idAwayTeam: 'someone-else',
          strHomeTeam: t.search, strAwayTeam: 'Visitors', strTimestamp: '2026-09-27T23:00:00',
          strStatus: 'Not Started',
        }],
      };
    }
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchStub, urls };
}

function withEnv(key, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'SPORTSDB_API_KEY');
  const prev = process.env.SPORTSDB_API_KEY;
  if (key == null) delete process.env.SPORTSDB_API_KEY;
  else process.env.SPORTSDB_API_KEY = key;
  const restore = () => {
    if (had) process.env.SPORTSDB_API_KEY = prev;
    else delete process.env.SPORTSDB_API_KEY;
  };
  return Promise.resolve().then(fn).finally(restore);
}

function withFetch(stub, fn) {
  const prev = global.fetch;
  global.fetch = stub;
  return Promise.resolve().then(fn).finally(() => { global.fetch = prev; });
}

const noFetch = async () => { throw new Error('fetch must not be called'); };

test('currentSeasons names the season in play for every league across the year', () => {
  const at = (iso) => new Date(`${iso}T12:00:00Z`);
  // Football: January and February still belong to last year's season.
  assert.strictEqual(currentSeasons('NFL', at('2027-01-15')), '2026');
  assert.strictEqual(currentSeasons('NFL', at('2027-02-28')), '2026');
  assert.strictEqual(currentSeasons('NFL', at('2027-03-01')), '2027');
  assert.strictEqual(currentSeasons('NFL', at('2026-09-26')), '2026');
  assert.strictEqual(currentSeasons('NCAA Division 1', at('2027-01-05')), '2026');
  assert.strictEqual(currentSeasons('NCAA Division 1', at('2026-11-01')), '2026');
  // Winter leagues: the upcoming season from July on.
  assert.strictEqual(currentSeasons('NBA', at('2026-06-30')), '2025-2026');
  assert.strictEqual(currentSeasons('NBA', at('2026-07-01')), '2026-2027');
  assert.strictEqual(currentSeasons('NHL', at('2027-03-15')), '2026-2027');
  assert.strictEqual(currentSeasons('NHL', at('2026-12-01')), '2026-2027');
  // Single calendar year.
  assert.strictEqual(currentSeasons('MLB', at('2026-09-26')), '2026');
  assert.strictEqual(currentSeasons('MLB', at('2027-01-10')), '2027');
  assert.strictEqual(currentSeasons('American Major League Soccer', at('2026-12-31')), '2026');
});

test('a table refreshed inside 20 hours is left alone', async () => {
  const pool = stubPool({ lastCollected: new Date(NOW.getTime() - (FRESH_HOURS - 1) * 3600000) });
  const logs = [];
  const res = await withEnv('test-key', () => withFetch(noFetch, () =>
    refreshSportsIfDue(pool, { now: NOW, log: (m) => logs.push(m), pauseMs: 0 })));
  assert.strictEqual(res.status, 'fresh');
  assert.strictEqual(pool.calls.length, 1, 'one freshness SELECT and nothing else');
  assert.ok(logs.some((m) => /skipped/.test(m)));
});

test('one league left stale by a half-finished refresh makes the whole refresh due', async () => {
  // The NFL wrote this morning; the NBA failed a day ago. The table's newest
  // row is fresh, which is exactly why freshness is judged league by league.
  const recent = new Date(NOW.getTime() - 2 * 3600000);
  const old = new Date(NOW.getTime() - 30 * 3600000);
  const { fetchStub } = stubSportsDb();
  const logs = [];
  const res = await withEnv('test-key', () => withFetch(fetchStub, () =>
    refreshSportsIfDue(stubPool({ lastCollected: recent, byLeague: { NBA: old } }), { now: NOW, log: (m) => logs.push(m), pauseMs: 0 })));
  assert.strictEqual(res.status, 'refreshed', logs.join('\n'));
  assert.ok(logs.some((m) => /NBA last refreshed 30\.0h ago/.test(m)), logs.join('\n'));

  // A league with no rows at all is due too.
  const res2 = await withEnv('test-key', () => withFetch(stubSportsDb().fetchStub, () =>
    refreshSportsIfDue(stubPool({ lastCollected: recent, byLeague: { MLS: null } }), { now: NOW, log: () => {}, pauseMs: 0 })));
  assert.strictEqual(res2.status, 'refreshed');
});

test('a request that never finishes is cut off and the refresh reports an error instead of hanging', async () => {
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  // Every request carries its own abort deadline covering headers and body.
  assert.match(src, /AbortSignal\.timeout\(REQUEST_TIMEOUT_MS\)/);
  assert.match(src, /fetch\(`\$\{BASE\}\/\$\{apiKey\(\)\}\/\$\{pathAndQuery\}`, \{ signal \}\)/);
  // And the daily refresh has an overall budget.
  assert.match(src, /budgetMs: REFRESH_BUDGET_MS/);

  // Behaviour: a fetch that honours its signal and never resolves otherwise.
  const hanging = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
  });
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => realTimeout.call(AbortSignal, 20);
  try {
    const logs = [];
    const res = await withEnv('test-key', () => withFetch(hanging, () =>
      refreshSportsIfDue(stubPool({ lastCollected: new Date(NOW.getTime() - 30 * 3600000) }), { now: NOW, log: (m) => logs.push(m), pauseMs: 0 })));
    assert.strictEqual(res.status, 'error');
    assert.ok(logs.some((m) => /crowd collection unaffected/.test(m)), logs.join('\n'));
  } finally {
    AbortSignal.timeout = realTimeout;
  }
});

test('no key means no request and a log line saying why', async () => {
  const pool = stubPool();
  const logs = [];
  const res = await withEnv(null, () => withFetch(noFetch, () =>
    refreshSportsIfDue(pool, { now: NOW, log: (m) => logs.push(m), pauseMs: 0 })));
  assert.strictEqual(res.status, 'no_key');
  assert.strictEqual(pool.calls.length, 0);
  assert.ok(logs.some((m) => /SPORTSDB_API_KEY/.test(m)));
});

test('a stale table is refreshed for the current seasons', async () => {
  const pool = stubPool({ lastCollected: new Date(NOW.getTime() - 30 * 3600000) });
  const { fetchStub, urls } = stubSportsDb();
  const logs = [];
  const res = await withEnv('test-key', () => withFetch(fetchStub, () =>
    refreshSportsIfDue(pool, { now: NOW, log: (m) => logs.push(m), pauseMs: 0 })));
  assert.strictEqual(res.status, 'refreshed', logs.join('\n'));
  // The key is read at call time and used in the path.
  assert.ok(urls.every((u) => u.includes('/json/test-key/')));
  const seasonPulls = urls.filter((u) => u.includes('eventsseason.php'))
    .map((u) => new URL(u).searchParams.get('s')).sort();
  // Six leagues (the two NCAA schools share one), one current season each.
  // September 2026: football 2026, winter leagues 2026-2027, the rest 2026.
  assert.deepStrictEqual(seasonPulls, ['2026', '2026', '2026', '2026', '2026-2027', '2026-2027']);
  const inserts = pool.calls.filter((c) => /INSERT INTO ml_sports_events/.test(c.sql));
  assert.strictEqual(inserts.length, 6);
  assert.ok(inserts.every((c) => c.params[2] === '2026' || c.params[2] === '2026-2027'));
});

test('an empty table counts as stale', async () => {
  const pool = stubPool({ lastCollected: null });
  const { fetchStub } = stubSportsDb();
  const res = await withEnv('test-key', () => withFetch(fetchStub, () =>
    refreshSportsIfDue(pool, { now: NOW, log: () => {}, pauseMs: 0 })));
  assert.strictEqual(res.status, 'refreshed');
});

test('a SportsDB failure is swallowed and logged, never thrown', async () => {
  const pool = stubPool({ lastCollected: null });
  const logs = [];
  const failing = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const res = await withEnv('test-key', () => withFetch(failing, () =>
    refreshSportsIfDue(pool, { now: NOW, log: (m) => logs.push(m), pauseMs: 0 })));
  assert.strictEqual(res.status, 'error');
  assert.match(res.error, /SportsDB 503/);
  assert.ok(logs.some((m) => /failed/.test(m) && /SportsDB 503/.test(m)));

  // A network rejection and a database failure take the same path.
  const rejecting = async () => { throw new Error('ECONNRESET'); };
  const res2 = await withEnv('test-key', () => withFetch(rejecting, () =>
    refreshSportsIfDue(pool, { now: NOW, log: () => {}, pauseMs: 0 })));
  assert.strictEqual(res2.status, 'error');
  const brokenPool = { async query() { throw new Error('relation "ml_sports_events" does not exist'); } };
  const res3 = await withEnv('test-key', () => withFetch(noFetch, () =>
    refreshSportsIfDue(brokenPool, { now: NOW, log: () => {}, pauseMs: 0 })));
  assert.strictEqual(res3.status, 'error');
  // Even a logger that throws cannot turn it into a throw.
  const res4 = await withEnv('test-key', () => withFetch(rejecting, () =>
    refreshSportsIfDue(stubPool(), { now: NOW, log: () => { throw new Error('log down'); }, pauseMs: 0 })));
  assert.strictEqual(res4.status, 'error');
});

test('requiring the module does no work', async () => {
  const { spawnSync } = require('node:child_process');
  // A fresh process with fetch and pg.Pool trapped and the database env
  // cleared: requiring must not load .env, build a pool or call anything.
  const script = `
    const pg = require('pg');
    let pools = 0, fetches = 0;
    const Real = pg.Pool;
    pg.Pool = function () { pools++; return new Real(); };
    global.fetch = async () => { fetches++; throw new Error('no'); };
    const before = JSON.stringify(Object.keys(process.env).sort());
    const m = require(${JSON.stringify(MODULE_PATH)});
    setTimeout(() => {
      const after = JSON.stringify(Object.keys(process.env).sort());
      process.stdout.write(JSON.stringify({ pools, fetches, envChanged: before !== after, exports: Object.keys(m).sort() }));
    }, 50);
  `;
  const env = { ...process.env };
  for (const k of ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'DATABASE_URL', 'SPORTSDB_API_KEY']) delete env[k];
  const out = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(out.status, 0, out.stderr);
  const r = JSON.parse(out.stdout);
  assert.strictEqual(r.pools, 0);
  assert.strictEqual(r.fetches, 0);
  assert.strictEqual(r.envChanged, false, 'requiring must not load backend/.env (it points at production)');
  assert.ok(r.exports.includes('refreshSportsIfDue'));
  assert.ok(!/\[ML:Sports\]/.test(out.stdout + out.stderr), 'nothing logged on require');
});

test('the CLI is guarded by require.main and keeps its flags', () => {
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  assert.match(src, /if \(require\.main === module\) \{\s*cli\(\)/);
  assert.match(src, /--verify/);
  assert.match(src, /--seasons=/);
  assert.match(src, /DEFAULT_SEASONS\[league\]/);
  assert.ok(!/^const API_KEY = process\.env/m.test(src), 'the key is read at call time, not load');
});

test('the hourly collector calls it inside run()\'s try, after the offsets', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'collectRealtime.js'), 'utf8');
  const runStart = src.indexOf('async function run()');
  const body = src.slice(runStart, src.indexOf('\nmodule.exports', runStart));
  const tryIdx = body.indexOf('try {');
  const devIdx = body.indexOf('buildRecentDeviation()');
  const sportsIdx = body.indexOf('await refreshSportsIfDue(pool)');
  const finallyIdx = body.lastIndexOf('} finally {');
  assert.ok(tryIdx !== -1 && devIdx !== -1 && sportsIdx !== -1 && finallyIdx !== -1);
  assert.ok(tryIdx < devIdx && devIdx < sportsIdx && sportsIdx < finallyIdx);
  // Outside the skipBaselines block, so holdout runs reach it too.
  const skipBlock = body.indexOf('if (!skipBaselines) {');
  const afterSkip = body.slice(skipBlock);
  let depth = 0; let end = -1;
  for (let i = afterSkip.indexOf('{'); i < afterSkip.length; i++) {
    if (afterSkip[i] === '{') depth++;
    else if (afterSkip[i] === '}') { depth--; if (depth === 0) { end = skipBlock + i; break; } }
  }
  assert.ok(end !== -1 && sportsIdx > end, 'the refresh runs on holdout and --no-baseline-refresh runs too');
});
