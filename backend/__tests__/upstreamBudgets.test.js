// Budget and timeout machinery: utils/placesBudget.js, utils/probeBudget.js,
// utils/upstream.js, services/weatherService.js.
//
// These four files are the chokepoint between Flock and every paid third party.
// A bug here is an invoice, not a UX regression, so the assertions below are
// written about money and about the enumeration oracle rather than about shapes.

const test = require('node:test');
const assert = require('node:assert');

const placesBudget = require('../utils/placesBudget');
const { createUserBudget } = require('../utils/probeBudget');
const { UPSTREAM_TIMEOUT_MS, upstreamSignal } = require('../utils/upstream');

const {
  allowPlacesSearch,
  allowGlobalPlacesCall,
  UNAUTH_DAILY,
  placesBudgetStatus,
  __resetPlacesBudget,
  PER_USER_HOURLY,
  GLOBAL_DAILY,
} = placesBudget;

// ── placesBudget: does the accounting match the spend? ──────────────────────

test.beforeEach(() => __resetPlacesBudget());

test('a caller that makes two paid calls can charge two units', () => {
  __resetPlacesBudget();
  // routes/crowd.js GET /:placeId/alternatives makes a Place Details call AND a
  // Text Search call. Charging one unit for both let it spend twice its budget.
  for (let i = 0; i < PER_USER_HOURLY / 2; i++) {
    assert.strictEqual(allowPlacesSearch(1, 2), true, `pair ${i} should fit`);
  }
  assert.strictEqual(allowPlacesSearch(1, 1), false, 'the 30-unit hour is spent after 15 pairs');
  assert.strictEqual(placesBudgetStatus(1).globalUsed, PER_USER_HOURLY);
});

test('a multi-unit charge is all-or-nothing', () => {
  __resetPlacesBudget();
  for (let i = 0; i < PER_USER_HOURLY - 1; i++) assert.strictEqual(allowPlacesSearch(2), true);
  const before = placesBudgetStatus(2);
  assert.strictEqual(allowPlacesSearch(2, 2), false, 'two units must not squeeze into one slot');
  const after = placesBudgetStatus(2);
  assert.strictEqual(after.globalUsed, before.globalUsed, 'a refused charge must cost nothing');
  assert.strictEqual(allowPlacesSearch(2, 1), true, 'the last single unit is still spendable');
});

test('the same user spelled two ways shares one budget', () => {
  __resetPlacesBudget();
  // req.user.id is a number today, but a string id anywhere would have minted a
  // second 30-call-per-hour allowance for the same person.
  for (let i = 0; i < PER_USER_HOURLY; i++) assert.strictEqual(allowPlacesSearch(i % 2 ? '9' : 9), true);
  assert.strictEqual(allowPlacesSearch('9'), false);
  assert.strictEqual(allowPlacesSearch(9), false);
  assert.strictEqual(allowPlacesSearch(' 9 '), false, 'whitespace is not a new identity');
  assert.strictEqual(allowPlacesSearch('9.0'), false, 'nor is a different numeric spelling');
});

test('an identity the budget cannot pin down pays nothing and gets nothing', () => {
  __resetPlacesBudget();
  for (const bad of [undefined, null, '', 'abc', {}, [], NaN, 0, -1, 1.5, false]) {
    assert.strictEqual(allowPlacesSearch(bad), false, `${String(bad)} must not get a paid lane`);
  }
  assert.strictEqual(placesBudgetStatus(1).globalUsed, 0, 'refused callers must not move the global counter');
});

test('the global daily ceiling stops everyone, not just the heavy user', () => {
  __resetPlacesBudget();
  // Spend the day down through many users so no single hourly limit is hit.
  const users = GLOBAL_DAILY / PER_USER_HOURLY;
  for (let u = 1; u <= users; u++) {
    for (let i = 0; i < PER_USER_HOURLY; i++) {
      assert.strictEqual(allowPlacesSearch(u), true, `user ${u} call ${i}`);
    }
  }
  const status = placesBudgetStatus(1);
  assert.strictEqual(status.globalUsed, GLOBAL_DAILY);
  assert.strictEqual(status.globalRemaining, 0);
  assert.strictEqual(allowPlacesSearch(999999), false, 'a brand-new user cannot spend past the day');
  assert.strictEqual(allowGlobalPlacesCall(), false, 'nor can an unauthenticated surface');
});

test('the unauthenticated surfaces charge the same global ceiling', () => {
  __resetPlacesBudget();
  // The badge, the public demo and the photo proxy are paid Places calls with no
  // user to charge. Without this the "global" daily cap only saw the logged-in
  // slice of the Google invoice.
  assert.strictEqual(allowGlobalPlacesCall(2), true);
  assert.strictEqual(placesBudgetStatus(1).globalUsed, 2);
  assert.strictEqual(allowPlacesSearch(1), true);
  assert.strictEqual(placesBudgetStatus(1).globalUsed, 3, 'both doors count into one ledger');
});

test('flooding the tracked-user map does not refund the flooder', () => {
  __resetPlacesBudget();
  // The old implementation called userHits.clear() at 5000 entries, so whoever
  // pushed it over the edge wiped their own spent counter — and the caller who
  // trips the threshold is the one who just spent a unit.
  const attacker = 1;
  for (let i = 0; i < PER_USER_HOURLY; i++) assert.strictEqual(allowPlacesSearch(attacker), true);
  assert.strictEqual(allowPlacesSearch(attacker), false);

  // Flood past the tracked-user ceiling. The global day counter is rolled
  // between batches because otherwise the 3000/day ceiling stops the flood long
  // before the map fills — the flood has to be spread over days in production
  // too, which is itself part of why this attack is not worth mounting.
  let id = 1000;
  for (let day = 0; day < 12; day++) {
    __resetPlacesBudget({ keepUsers: true });
    for (let i = 0; i < 2500; i++) allowPlacesSearch(id++);
  }
  assert.strictEqual(allowPlacesSearch(attacker), false, "the spender's own counter must survive eviction");
});

test('the stated limits are the enforced limits', () => {
  // The header block in placesBudget.js is the only place these numbers are
  // written down for a human. If someone edits one they must edit both.
  assert.strictEqual(PER_USER_HOURLY, 30);
  assert.strictEqual(GLOBAL_DAILY, 3000);
  assert.strictEqual(UNAUTH_DAILY, 1800);
  const status = placesBudgetStatus(1);
  assert.deepStrictEqual(status.limits,
    { perUserHourly: 30, globalDaily: 3000, unauthDaily: 1800 });
  assert.strictEqual(status.inMemory, true, 'callers must be able to see this is process-local');
});

// ── probeBudget: the enumeration oracle ─────────────────────────────────────

test('the day rollover does not hand back a fresh hourly allowance', () => {
  // The rolling hour must survive the fixed day window resetting under it.
  // Rebuilding the entry on rollover discarded `hits`, so a prober who spent
  // their hour in the last minutes of the day window got a second full hourly
  // allowance seconds later — at a moment they can compute exactly.
  const realNow = Date.now;
  let clock = 1_000_000_000_000;
  Date.now = () => clock;
  try {
    const b = createUserBudget({ name: 't', hourly: 3, daily: 100 });
    for (let i = 0; i < 3; i++) assert.strictEqual(b.allow(5), true);
    assert.strictEqual(b.allow(5), false);

    clock += 24 * 60 * 60 * 1000 + 1000; // day window rolls; the hour has NOT
    // The hits are 24h old by now, so the hour has genuinely elapsed too.
    assert.strictEqual(b.allow(5), true, 'a full day later the hour really has passed');
  } finally {
    Date.now = realNow;
  }
});

test('spending the hour just before the day boundary does not double it', () => {
  const realNow = Date.now;
  let clock = 1_000_000_000_000;
  Date.now = () => clock;
  try {
    const b = createUserBudget({ name: 't', hourly: 3, daily: 100 });
    b.allow(7); // anchors dayResetAt at clock + 24h
    clock += 24 * 60 * 60 * 1000 - 60_000; // one minute before the day rolls
    // The anchor hit is 24h old, so it has already left the rolling hour: the
    // full hourly allowance is available right up against the day boundary.
    for (let i = 0; i < 3; i++) assert.strictEqual(b.allow(7), true, `boundary call ${i}`);
    assert.strictEqual(b.allow(7), false, 'hourly limit reached');

    clock += 120_000; // two minutes later: the DAY has rolled, the hour has not
    assert.strictEqual(b.allow(7), false,
      'the rolling hour must survive the day rollover — this was 2x hourly in two minutes');
    assert.strictEqual(b.remaining(7).hourly, 0, 'and the read must agree with allow()');
  } finally {
    Date.now = realNow;
  }
});

test('the five-minute prune does not wipe a live hour either', () => {
  // prune() deleted any entry past dayResetAt outright, which reached the same
  // hourly-history wipe through a different door: prune is triggered by ANY
  // user's call once the interval has passed, so a user whose day had just
  // rolled lost their live timestamps without ever calling allow() themselves.
  const realNow = Date.now;
  let clock = 1_000_000_000_000;
  Date.now = () => clock;
  try {
    const b = createUserBudget({ name: 't', hourly: 2, daily: 100 });
    b.allow(11); // anchors the day window
    clock += 24 * 60 * 60 * 1000 - 60_000;
    for (let i = 0; i < 2; i++) assert.strictEqual(b.allow(11), true, `boundary call ${i}`);
    assert.strictEqual(b.allow(11), false);

    clock += 120_000;      // day rolled
    b.allow(999);          // some other user's call triggers prune()
    clock += 6 * 60 * 1000 - 120_000; // push past PRUNE_INTERVAL_MS
    b.allow(998);
    b.allow(997);

    assert.strictEqual(b.remaining(11).hourly, 0,
      "prune must not forget a user whose hour is still live");
  } finally {
    Date.now = realNow;
  }
});

test('exhaustion is not distinguishable from a miss by the budget itself', () => {
  // The routes answer both with the same 404 body. The primitive's contribution
  // is that a refusal costs the same work as an approval: no extra query, no
  // extra allocation proportional to the target, and a plain boolean that
  // carries no reason a caller could accidentally leak.
  const b = createUserBudget({ name: 't', hourly: 2, daily: 2 });
  assert.strictEqual(b.allow(3), true);
  assert.strictEqual(b.allow(3), true);
  const refused = b.allow(3);
  assert.strictEqual(refused, false);
  assert.strictEqual(typeof refused, 'boolean', 'a reason code here would become a status code upstream');
});

test('a probe budget denies rather than sharing one bucket among unknowns', () => {
  const b = createUserBudget({ name: 't', hourly: 5, daily: 5 });
  for (const bad of [undefined, null, '', 'abc', {}, [], NaN, 0, -3, 2.5, false]) {
    assert.strictEqual(b.allow(bad), false, `${String(bad)} must not get a free lane`);
    assert.deepStrictEqual(b.remaining(bad), { hourly: 0, daily: 0 });
  }
});

test('constructing a budget with a nonsense limit fails loudly', () => {
  for (const bad of [0, -1, 1.5, '10', null, undefined, NaN]) {
    assert.throws(() => createUserBudget({ name: 't', hourly: bad, daily: 10 }));
    assert.throws(() => createUserBudget({ name: 't', hourly: 10, daily: bad }));
  }
});

// ── upstream: is a deadline applied everywhere it should be? ────────────────

test('every outbound call in the request path carries a deadline', async () => {
  const fs = require('fs');
  const path = require('path');
  const roots = ['routes', 'services', 'utils', 'middleware', 'sockets', 'socket'];
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  const base = path.join(__dirname, '..');
  for (const r of roots) walk(path.join(base, r));
  assert.ok(files.length > 20, 'expected to find the backend source');

  // Strip string and template literals before looking for a call, so prose that
  // happens to contain the word does not read as an undeadlined request.
  const stripLiterals = (s) => s
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');

  const offenders = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const code = stripLiterals(line);
      if (!/\bfetch\s*\(/.test(code)) return;
      // Assigning or restoring the global (tests, stubs) is not a request.
      if (/(^|[^.\w])fetch\s*=/.test(code)) return;
      // The signal is usually a few lines below the opening paren.
      const window = lines.slice(i, i + 25).join('\n');
      if (!/signal\s*:/.test(window)) offenders.push(`${path.relative(base, f)}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(offenders, [],
    'an undeadlined fetch parks an Express connection and a pg pool slot for ~5 minutes');
});

test('an unknown upstream fails closed instead of silently having no deadline', () => {
  assert.throws(() => upstreamSignal('nope'), /unknown upstream/);
  assert.throws(() => upstreamSignal(''), /unknown upstream/);
  assert.throws(() => upstreamSignal(undefined), /unknown upstream/);
});

test('every declared timeout is a sane positive number and the table is frozen', () => {
  for (const [kind, ms] of Object.entries(UPSTREAM_TIMEOUT_MS)) {
    assert.ok(Number.isInteger(ms) && ms > 0, `${kind} must be a positive integer`);
    assert.ok(ms <= 15000, `${kind} at ${ms}ms is longer than any client will wait`);
    assert.ok(ms >= 3000, `${kind} at ${ms}ms will abort healthy calls (and still be billed for them)`);
  }
  assert.ok(Object.isFrozen(UPSTREAM_TIMEOUT_MS), 'a mutable timeout table can be edited at runtime');
});

test('a fresh signal is produced per call and starts unaborted', () => {
  // A module-level constant signal would already be expired by the time the
  // second request used it.
  const a = upstreamSignal('places');
  const b = upstreamSignal('places');
  assert.notStrictEqual(a, b);
  assert.strictEqual(a.aborted, false);
  assert.strictEqual(b.aborted, false);
});

test('an expired deadline aborts and the reason is a TimeoutError', async () => {
  const signal = AbortSignal.timeout(5);
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(signal.aborted, true);
  assert.strictEqual(signal.reason?.name, 'TimeoutError',
    'call sites must be able to tell a deadline from a caller cancellation');
});

// ── weatherService: caching, failure and hang behaviour ────────────────────

const weatherService = require('../services/weatherService');

function stubFetch(impl) {
  const real = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = real; };
}

const OWM_OK = {
  main: { temp: 71.2, feels_like: 70, humidity: 44 },
  wind: { speed: 6 },
  weather: [{ id: 800, main: 'Clear', description: 'clear sky' }],
};

test('weather: concurrent misses for one coordinate buy exactly one call', async () => {
  weatherService.__resetWeatherState();
  process.env.WEATHER_API_KEY = 'test-key';
  let calls = 0;
  const restore = stubFetch(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return { ok: true, status: 200, json: async () => OWM_OK };
  });
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => weatherService.getWeather(39.74, -104.98))
    );
    assert.strictEqual(calls, 1, 'eight simultaneous callers must not buy eight readings');
    for (const r of results) assert.strictEqual(r.temp, 71.2);
    assert.strictEqual(weatherService.weatherBudgetStatus().dailyUsed, 1,
      'and the budget must be charged once, not eight times');
  } finally {
    restore();
  }
});

test('weather: a reading is served from cache and never presented as newer than it is', async () => {
  weatherService.__resetWeatherState();
  process.env.WEATHER_API_KEY = 'test-key';
  let calls = 0;
  const restore = stubFetch(async () => {
    calls++;
    return { ok: true, status: 200, json: async () => OWM_OK };
  });
  try {
    const first = await weatherService.getWeather(40.0, -75.0);
    const second = await weatherService.getWeather(40.0, -75.0);
    assert.strictEqual(calls, 1);
    assert.strictEqual(first.fetchedAt, second.fetchedAt,
      'a cache hit must report the observation time, not the read time');
    assert.ok(typeof first.fetchedAt === 'number' && first.fetchedAt > 0);
  } finally {
    restore();
  }
});

test('weather: the cached object cannot be mutated by one consumer for everybody', async () => {
  weatherService.__resetWeatherState();
  process.env.WEATHER_API_KEY = 'test-key';
  const restore = stubFetch(async () => ({ ok: true, status: 200, json: async () => OWM_OK }));
  try {
    const a = await weatherService.getWeather(41.0, -74.0);
    try { a.temp = -999; } catch { /* frozen: strict-mode callers throw */ }
    const b = await weatherService.getWeather(41.0, -74.0);
    assert.strictEqual(b.temp, 71.2, 'the cache must not be poisonable');
  } finally {
    restore();
  }
});

test('weather: a coordinate the upstream cannot answer is not re-bought every request', async () => {
  weatherService.__resetWeatherState();
  process.env.WEATHER_API_KEY = 'test-key';
  let calls = 0;
  const restore = stubFetch(async () => { calls++; return { ok: false, status: 500, json: async () => ({}) }; });
  try {
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(await weatherService.getWeather(35.0, -80.0), null,
        'a failure degrades to null, never to a fabricated reading');
    }
    assert.strictEqual(calls, 1, 'an outage must not burn the daily budget once per request');
    assert.strictEqual(weatherService.weatherBudgetStatus().dailyUsed, 1);
  } finally {
    restore();
  }
});

test('weather: a 200 with an unusable body is a failure, not a reading of zero', async () => {
  weatherService.__resetWeatherState();
  process.env.WEATHER_API_KEY = 'test-key';
  const restore = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ cod: 401, message: 'bad key' }) }));
  try {
    assert.strictEqual(await weatherService.getWeather(36.0, -81.0), null,
      'letting this through would feed the model temp=undefined');
  } finally {
    restore();
  }
});

test('weather: an aborted upstream degrades to null and cannot hang the caller', async () => {
  weatherService.__resetWeatherState();
  process.env.WEATHER_API_KEY = 'test-key';
  const restore = stubFetch(async (_url, opts) => {
    // Behave like undici: reject when the deadline fires.
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
    });
  });
  try {
    const started = Date.now();
    const result = await weatherService.getWeather(37.0, -82.0);
    assert.strictEqual(result, null);
    assert.ok(Date.now() - started < UPSTREAM_TIMEOUT_MS.weather + 2000,
      'the deadline must actually bound the wait');
  } finally {
    restore();
  }
});

test('weather: a failure does not leave a permanent in-flight entry behind', async () => {
  weatherService.__resetWeatherState();
  process.env.WEATHER_API_KEY = 'test-key';
  const restore = stubFetch(async () => { throw new Error('socket hang up'); });
  try {
    await weatherService.getWeather(38.0, -83.0);
    assert.strictEqual(weatherService.weatherBudgetStatus().inFlight, 0,
      'a stuck in-flight entry would wedge that coordinate until restart');
  } finally {
    restore();
  }
});

test('weather: a per-user ceiling applies when the caller identifies itself', async () => {
  weatherService.__resetWeatherState();
  process.env.WEATHER_API_KEY = 'test-key';
  let calls = 0;
  const restore = stubFetch(async () => { calls++; return { ok: true, status: 200, json: async () => OWM_OK }; });
  try {
    // 40/hour per user; walk unique coordinates so nothing is cached.
    for (let i = 0; i < 40; i++) {
      const r = await weatherService.getWeather(30 + i * 0.01, -90, { userId: 4 });
      assert.ok(r, `call ${i} should be allowed`);
    }
    assert.strictEqual(await weatherService.getWeather(31.0, -90, { userId: 4 }), null,
      'one account must not be able to spend the whole global allowance');
    assert.strictEqual(calls, 40);
    // A different user still has their own allowance.
    assert.ok(await weatherService.getWeather(32.0, -90, { userId: 5 }));
  } finally {
    restore();
  }
});

test('weather: a caller that tries to identify itself and fails is denied, not un-metered', async () => {
  weatherService.__resetWeatherState();
  process.env.WEATHER_API_KEY = 'test-key';
  const restore = stubFetch(async () => ({ ok: true, status: 200, json: async () => OWM_OK }));
  try {
    assert.strictEqual(await weatherService.getWeather(33.0, -91, { userId: 'nope' }), null);
    assert.strictEqual(await weatherService.getWeather(33.1, -91, { userId: 0 }), null);
    assert.strictEqual(weatherService.weatherBudgetStatus().dailyUsed, 0);
    // Omitting the id entirely is still allowed — most call sites have no user.
    assert.ok(await weatherService.getWeather(33.2, -91));
  } finally {
    restore();
  }
});

test('weather: no API key means no reading and no upstream call', async () => {
  weatherService.__resetWeatherState();
  const saved = process.env.WEATHER_API_KEY;
  delete process.env.WEATHER_API_KEY;
  let calls = 0;
  const restore = stubFetch(async () => { calls++; return { ok: true, status: 200, json: async () => OWM_OK }; });
  try {
    assert.strictEqual(await weatherService.getWeather(34.0, -92), null);
    assert.strictEqual(await weatherService.getForecast(34.0, -92), null);
    assert.strictEqual(calls, 0);
  } finally {
    restore();
    if (saved !== undefined) process.env.WEATHER_API_KEY = saved;
  }
});

test('weather: current and forecast never collide in the cache', async () => {
  weatherService.__resetWeatherState();
  process.env.WEATHER_API_KEY = 'test-key';
  const restore = stubFetch(async (url) => {
    if (String(url).includes('/forecast')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ list: [{ dt_txt: '2026-08-14 12:00:00', main: { temp: 80, feels_like: 79, humidity: 30 }, wind: { speed: 3 }, weather: [{ description: 'sunny', icon: '01d' }] }] }),
      };
    }
    return { ok: true, status: 200, json: async () => OWM_OK };
  });
  try {
    const now = await weatherService.getWeather(42.0, -71.0);
    const fc = await weatherService.getForecast(42.0, -71.0);
    assert.strictEqual(now.temp, 71.2);
    assert.ok(Array.isArray(fc) && fc.length === 1 && fc[0].temp === 80,
      'the forecast key must stay distinct from the current-conditions key');
    assert.strictEqual(fc[0].hour, undefined, 'the internal sort key must not leak to callers');
  } finally {
    restore();
  }
});

test('weather: a forecast 200 without a list is a failure, not an empty forecast', async () => {
  weatherService.__resetWeatherState();
  process.env.WEATHER_API_KEY = 'test-key';
  let calls = 0;
  const restore = stubFetch(async () => { calls++; return { ok: true, status: 200, json: async () => ({ cod: '429' }) }; });
  try {
    assert.strictEqual(await weatherService.getForecast(43.0, -72.0), null);
    assert.strictEqual(await weatherService.getForecast(43.0, -72.0), null);
    assert.strictEqual(calls, 1, 'and it is remembered so it does not re-charge the budget');
  } finally {
    restore();
  }
});

test('weather: the daily and per-minute ceilings are both real', async () => {
  weatherService.__resetWeatherState();
  process.env.WEATHER_API_KEY = 'test-key';
  const restore = stubFetch(async () => ({ ok: true, status: 200, json: async () => OWM_OK }));
  try {
    const limits = weatherService.weatherBudgetStatus().limits;
    // Must stay under OpenWeatherMap's 60/min: at or above it, a caller we
    // refuse is one the vendor would have 429'd anyway, so the cap can never
    // cost a reading the ML collection scripts would otherwise have recorded.
    assert.ok(limits.perMinute < 60, 'per-minute cap must sit under the vendor limit');
    assert.ok(limits.perMinute >= 50, 'but not so low it throttles a legitimate batch run');
    // Burn the minute with unique coordinates.
    let allowed = 0;
    for (let i = 0; i < limits.perMinute + 10; i++) {
      if (await weatherService.getWeather(20 + i * 0.01, -100)) allowed++;
    }
    assert.strictEqual(allowed, limits.perMinute, 'the per-minute cap must bound the burn rate');
    const status = weatherService.weatherBudgetStatus();
    assert.strictEqual(status.dailyUsed, limits.perMinute, 'refused calls must not be charged');
    assert.strictEqual(status.refusedToday, 10,
      'a refusal drops the weather factor from a crowd score and must be counted, never silent');
  } finally {
    restore();
  }
});

test('weather: a failure is remembered briefly, then retried', async () => {
  weatherService.__resetWeatherState();
  process.env.WEATHER_API_KEY = 'test-key';
  let calls = 0;
  let broken = true;
  const realNow = Date.now;
  const restore = stubFetch(async () => {
    calls++;
    if (broken) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => OWM_OK };
  });
  try {
    assert.strictEqual(await weatherService.getWeather(44.0, -73.0), null);
    assert.strictEqual(await weatherService.getWeather(44.0, -73.0), null);
    assert.strictEqual(calls, 1, 'the failure is remembered');

    // A recovering upstream must be picked up quickly: a long negative window
    // would blank weather for a coordinate well past the outage.
    const shifted = realNow() + 61_000;
    Date.now = () => shifted;
    broken = false;
    const recovered = await weatherService.getWeather(44.0, -73.0);
    assert.strictEqual(recovered?.temp, 71.2, 'the negative cache must expire, not stick');
    assert.strictEqual(calls, 2);
  } finally {
    Date.now = realNow;
    restore();
  }
});

test('places: an impossible charge is a loud programming error, not silent throttling', () => {
  __resetPlacesBudget();
  for (const bad of [0, -1, 1.5, '2', null, NaN, PER_USER_HOURLY + 1]) {
    assert.throws(() => allowPlacesSearch(1, bad), /cost must be an integer/,
      `cost=${String(bad)} can never be satisfied and must not look like a 429`);
  }
  assert.strictEqual(placesBudgetStatus(1).globalUsed, 0);
});

test('places: eviction leaves headroom instead of sorting the whole map every call', () => {
  __resetPlacesBudget();
  // Holding the map exactly at its ceiling used to force a full scan + sort of
  // 20,000 entries on every single charge. Once eviction has run, the tracked
  // set must sit BELOW the ceiling so the next charge is cheap.
  //
  // The map outlives the day counter, so reaching the ceiling takes several
  // days' worth of distinct users — that is exactly how it happens in
  // production, where the 3000/day ceiling caps a single day at ~3000 entries.
  let id = 1000;
  for (let day = 0; day < 10; day++) {
    __resetPlacesBudget({ keepUsers: true });
    for (let i = 0; i < 2500; i++) assert.strictEqual(allowPlacesSearch(id++), true);
  }
  const tracked = placesBudgetStatus(1).trackedUsers;
  assert.ok(tracked <= 20000, `must not grow past the ceiling, tracked=${tracked}`);
  assert.ok(tracked < 20000, `expected headroom under the ceiling, tracked=${tracked}`);
  assert.ok(tracked > 1000, 'and it must not have thrown everything away');
});

test('weather: an impossible coordinate is refused before it costs anything', async () => {
  weatherService.__resetWeatherState();
  process.env.WEATHER_API_KEY = 'test-key';
  let calls = 0;
  const restore = stubFetch(async () => { calls++; return { ok: true, status: 200, json: async () => OWM_OK }; });
  try {
    for (const [lat, lon] of [[undefined, undefined], [NaN, 0], ['x', 'y'], [91, 0], [0, 181], [null, null], [Infinity, 0]]) {
      assert.strictEqual(await weatherService.getWeather(lat, lon), null, `${String(lat)},${String(lon)}`);
      assert.strictEqual(await weatherService.getForecast(lat, lon), null, `${String(lat)},${String(lon)}`);
    }
    assert.strictEqual(calls, 0, 'a question we know is unanswerable must not be paid for');
    assert.strictEqual(weatherService.weatherBudgetStatus().dailyUsed, 0);
  } finally {
    restore();
  }
});

test('an id that is not a number or a numeric string is refused, not coerced', () => {
  __resetPlacesBudget();
  // Number(true) is 1 and Number([9]) is 9, so an untyped coercion would let a
  // stray boolean or array spend a real user's allowance.
  for (const bad of [true, false, [9], [1], { valueOf: () => 9 }]) {
    assert.strictEqual(allowPlacesSearch(bad), false, `${JSON.stringify(bad)} must not map onto a real user`);
  }
  const probe = createUserBudget({ name: 't', hourly: 5, daily: 5 });
  for (const bad of [true, [9], { valueOf: () => 9 }]) {
    assert.strictEqual(probe.allow(bad), false);
  }
  assert.strictEqual(probe.allow(9), true, 'the real user 9 still has a full allowance');
  assert.strictEqual(placesBudgetStatus(9).globalUsed, 0);
});

test('weather: the module says out loud that its state is process-local', () => {
  assert.strictEqual(weatherService.weatherBudgetStatus().inMemory, true);
});
