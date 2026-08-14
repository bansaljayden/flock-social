// Round 15 — the unauthenticated demo's abuse limits, and the class they
// belong to.
//
// The finding: routes/publicCrowd.js kept its per-IP counters in a Map whose
// "memory guard" was `if (ipHits.size > 5000) ipHits.clear()`. An attacker
// cycling 5000 source addresses reset every counter in the process — their own
// included — at will, so the limiter got WEAKER the harder it was pushed. The
// response cache had the identical shape (`if (cache.size > 500)
// cache.clear()`), where a wipe converts every cached answer back into a paid
// Google call. Both now use the repo's solved pattern (routes/guest.js,
// utils/places.rememberKnownVenue, utils/probeBudget.js): expire first, then
// bounded eviction in an order that favours the attacker least, never clear().
//
// These tests pin the BEHAVIOUR, not the comments. probeBudget.js documents
// its own defences at length, and three comment/code divergences shipped this
// week elsewhere — so the documented-but-untested parts of probeBudget are
// pinned here too, alongside the dev-mode rate-limit toggle in server.js,
// which must be impossible to trip in a misconfigured production fleet.
//
// Run: node --test  (from backend/)

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  allowDemo, evictIpHits, ipHits, setCache, getCache, cache,
  resetDemoLimitsForTest, demoState,
  IP_LIMIT, IP_WINDOW_MS, IP_MAX_ENTRIES, IP_LOW_WATER,
  CACHE_MAX_ENTRIES, CACHE_LOW_WATER,
} = require('../routes/publicCrowd').__testables;
const { createUserBudget } = require('../utils/probeBudget');

// ── 1. The per-IP demo counter ──────────────────────────────────────────────

test('demo: a spent attacker cannot shake their counter loose by flooding addresses', () => {
  resetDemoLimitsForTest();
  const attacker = { ip: 'attacker' };

  for (let i = 0; i < IP_LIMIT; i++) {
    assert.strictEqual(allowDemo(attacker), true, `honest call ${i} within the limit`);
  }
  assert.strictEqual(allowDemo(attacker), false, 'the limit itself');

  // The flood is seeded directly (5000 allowed requests would trip the global
  // day cap first — which is itself part of why this flood is expensive to
  // mount for real). Each junk address has consumed exactly one hit, the way a
  // rotating-source flood looks.
  const now = Date.now();
  for (let i = 0; i < IP_MAX_ENTRIES; i++) ipHits.set(`junk-${i}`, [now]);

  // A fresh visitor's request lands on the over-full map and triggers eviction.
  assert.strictEqual(allowDemo({ ip: 'fresh-visitor' }), true, 'a new visitor still gets in');
  assert.ok(ipHits.size <= IP_MAX_ENTRIES, `map stays bounded (size ${ipHits.size})`);

  // The old clear() made this next line pass — that was the whole attack.
  assert.strictEqual(allowDemo(attacker), false,
    "the attacker's spent counter must survive the flood they mounted");
  resetDemoLimitsForTest();
});

test('demo: eviction drops least-consumed entries and stops at the low-water mark', () => {
  resetDemoLimitsForTest();
  const now = Date.now();
  const full = Array.from({ length: IP_LIMIT }, (_, i) => now - i); // a spent address
  ipHits.set('spent', full.slice());
  for (let i = 0; i < IP_MAX_ENTRIES + 1000; i++) ipHits.set(`junk-${i}`, [now]);

  evictIpHits(now);

  assert.strictEqual(ipHits.size, IP_LOW_WATER,
    'evicts to the low-water mark, not the ceiling — at the ceiling every request would re-sort the whole map');
  assert.ok(ipHits.has('spent'), 'the fullest entry is the last one eviction may touch');
  assert.strictEqual(ipHits.get('spent').length, IP_LIMIT, 'and its history is intact');
  resetDemoLimitsForTest();
});

test('demo: expired addresses are forgotten before any live one is evicted', () => {
  resetDemoLimitsForTest();
  const now = Date.now();
  const stale = now - IP_WINDOW_MS - 1000;
  for (let i = 0; i < 3000; i++) ipHits.set(`expired-${i}`, [stale]);
  for (let i = 0; i < 2500; i++) ipHits.set(`live-${i}`, [now, now]);

  evictIpHits(now); // 5500 tracked, but 3000 are pure history

  assert.strictEqual(ipHits.size, 2500, 'every expired entry gone, every live one kept');
  assert.ok(ipHits.has('live-0') && ipHits.has('live-2499'));
  assert.ok(!ipHits.has('expired-0'));
  resetDemoLimitsForTest();
});

test('demo: a refused request consumes nothing', () => {
  resetDemoLimitsForTest();
  const req = { ip: 'limit-tester' };
  for (let i = 0; i < IP_LIMIT; i++) allowDemo(req);
  const spentDay = demoState().dayCount;
  const spentHits = ipHits.get('limit-tester').length;

  for (let i = 0; i < 50; i++) assert.strictEqual(allowDemo(req), false);

  assert.strictEqual(demoState().dayCount, spentDay,
    'a refusal must not charge the global day budget');
  assert.strictEqual(ipHits.get('limit-tester').length, spentHits,
    'a refusal must not extend the refused window');
  resetDemoLimitsForTest();
});

// ── 2. The shared response cache ────────────────────────────────────────────

test('cache: overflowing by one entry no longer wipes the other five hundred', () => {
  resetDemoLimitsForTest();
  for (let i = 0; i < CACHE_MAX_ENTRIES; i++) setCache(`area:${i}`, { i }, 60_000);
  assert.strictEqual(cache.size, CACHE_MAX_ENTRIES);

  setCache('area:one-more', { fresh: true }, 60_000);

  // The old code: cache.clear() then set — size 1, every paid answer gone.
  assert.strictEqual(cache.size, CACHE_LOW_WATER,
    'bounded eviction down to the low-water mark, not a wipe');
  assert.deepStrictEqual(getCache('area:one-more'), { fresh: true }, 'the new entry is cached');
  assert.ok(getCache(`area:${CACHE_MAX_ENTRIES - 1}`),
    'recently cached answers survive — only the soonest-to-expire tail is shed');
  resetDemoLimitsForTest();
});

test('cache: expired junk is shed before any live entry', () => {
  resetDemoLimitsForTest();
  for (let i = 0; i < 490; i++) setCache(`live:${i}`, { i }, 60_000);
  // A spray of already-dead entries (the cheapest thing to write) cannot push
  // live answers out: the expire pass eats the spray itself.
  for (let i = 0; i < 40; i++) setCache(`dead:${i}`, { i }, -1000);

  for (let i = 0; i < 490; i++) {
    assert.ok(getCache(`live:${i}`), `live:${i} must survive an expired-junk spray`);
  }
  assert.ok(cache.size <= CACHE_MAX_ENTRIES);
  resetDemoLimitsForTest();
});

test('no clear() is reachable from a request path in publicCrowd.js', () => {
  // The tripwire form, same as edgeCaseSweep uses: the only wholesale clears
  // allowed in the file are inside the test-only reset helper.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'publicCrowd.js'), 'utf8');
  // Comments quote the OLD clear() as history, so strip them (split per line —
  // the file is CRLF, a multi-line regex would misfire) before matching code.
  const requestReachable = src.split('function resetDemoLimitsForTest')[0]
    .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(!/\b(ipHits|cache)\.clear\(\)/.test(requestReachable),
    'a wholesale clear() crept back into the request path');
  assert.match(src, /function resetDemoLimitsForTest/, 'the reset helper still anchors this split');
});

// ── 3. The dev-mode rate-limit toggle in server.js ──────────────────────────
//
// Every limiter is disabled when `isDev` is true. The verdict this section
// pins: isDev can ONLY be true when NODE_ENV is the exact lowercase string
// 'development'. An unset NODE_ENV, 'production', 'staging', 'test', a stray
// space, or a case difference all leave every limiter armed — the fail-safe
// direction. (Matched per line, never across lines: server.js is CRLF and a
// multi-line literal would silently never match.)

test('rate limits: the dev bypass keys on exactly one strict comparison', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  const defs = src.match(/const isDev =[^\r\n]*/g) || [];
  assert.strictEqual(defs.length, 1, 'exactly one definition of isDev');
  const m = defs[0].match(/^const isDev = process\.env\.NODE_ENV === '([^']+)';/);
  assert.ok(m, `isDev must be a strict equality against a string literal, got: ${defs[0]}`);
  const literal = m[1];
  assert.strictEqual(literal, 'development');

  // No second assignment anywhere — a later `isDev = true` for "local testing"
  // would arm the bypass fleet-wide.
  assert.strictEqual((src.match(/\bisDev\s*=/g) || []).length, 1, 'isDev is assigned exactly once');

  // Every no-op passthrough middleware in the file is guarded by `isDev ?` and
  // paired with a real rateLimit() in its other arm. A bypass keyed on
  // anything else (say `!isProduction`, which is true on an UNSET NODE_ENV)
  // fails the count.
  const bypasses = (src.match(/\(_req, _res, next\) => next\(\)/g) || []).length;
  const guarded = (src.match(/isDev \? \(_req, _res, next\) => next\(\) : rateLimit\(\{/g) || []).length;
  assert.strictEqual(bypasses, guarded, 'every limiter bypass must be the isDev arm of a rateLimit ternary');
  assert.ok(guarded >= 5, `api, auth, venueSearch, imageSpend and ai limiters all present (found ${guarded})`);

  // The misconfigurations a real fleet ships, checked against the literal the
  // source actually compares to (the regex above guarantees the mirror).
  const misconfigs = [undefined, '', 'production', 'staging', 'test', 'Development',
    'DEVELOPMENT', ' development', 'development ', 'dev', 'develop'];
  for (const v of misconfigs) {
    assert.notStrictEqual(v, literal, `NODE_ENV=${JSON.stringify(v)} must leave limiters armed`);
  }
});

// ── 4. probeBudget: documented defences, now held by tests ──────────────────
//
// spamBudgets.test.js and upstreamBudgets.test.js already pin: the day
// rollover keeping the rolling hour, prune keeping a live hour, '5' and 5
// sharing one bucket, unknown identities denied, the daily ceiling, and a
// spent attacker surviving a flood. What was documented but NOT tested:

test('probeBudget: eviction runs to the low-water mark, least consumed first', () => {
  const realNow = Date.now;
  let clock = 1_700_000_000_000;
  Date.now = () => clock++;
  try {
    const maxEntries = 100;
    const b = createUserBudget({ name: 't', hourly: 50, daily: 50, maxEntries });

    const heavy = 9999;
    for (let i = 0; i < 3; i++) assert.strictEqual(b.allow(heavy), true);

    // Flood 101 fresh ids: the 101st call finds the map over the ceiling and
    // must prune down to floor(100 * 0.9) = 90 before inserting.
    for (let i = 1; i <= 101; i++) assert.strictEqual(b.allow(i), true);

    const remembered = (id) => b.remaining(id).daily < 50;
    // Stopping at the ceiling instead of the low-water mark is the documented
    // CPU DoS: a map held at the ceiling re-sorts on every allow(). Here the
    // one prune evicted 11 entries, so ids 1..11 (least consumed, earliest
    // anchored) are gone and everything later is kept.
    for (let i = 1; i <= 11; i++) {
      assert.strictEqual(remembered(i), false, `flood id ${i} should have been evicted`);
    }
    for (let i = 12; i <= 101; i++) {
      assert.strictEqual(remembered(i), true, `flood id ${i} should have survived`);
    }
    assert.deepStrictEqual(b.remaining(heavy), { hourly: 47, daily: 47 },
      'the most-consumed entry is untouchable by a single-hit flood, whatever its age');
  } finally {
    Date.now = realNow;
  }
});

test('probeBudget: coercible non-identities are refused, never coerced onto a real user', () => {
  // keyOf documents that without its type gate, Number(true) === 1 and
  // Number([9]) === 9 — a stray boolean or one-element array would spend a
  // REAL user's allowance. The refusal alone is not the defence; the intact
  // budget of users 1 and 9 is.
  const b = createUserBudget({ name: 't', hourly: 5, daily: 5 });
  for (const bad of [true, false, [9], ['7'], [1], new Number(5), { valueOf: () => 3 }]) {
    assert.strictEqual(b.allow(bad), false, `${JSON.stringify(bad)} must be refused`);
  }
  assert.deepStrictEqual(b.remaining(1), { hourly: 5, daily: 5 }, "user 1's budget untouched by `true`/[1]");
  assert.deepStrictEqual(b.remaining(9), { hourly: 5, daily: 5 }, "user 9's budget untouched by [9]");
  assert.deepStrictEqual(b.remaining(3), { hourly: 5, daily: 5 }, "user 3's budget untouched by valueOf");
});

test('probeBudget: remaining() is a read, not a charge', () => {
  const b = createUserBudget({ name: 't', hourly: 3, daily: 10 });
  assert.strictEqual(b.allow(7), true);
  for (let i = 0; i < 100; i++) {
    assert.deepStrictEqual(b.remaining(7), { hourly: 2, daily: 9 });
  }
  assert.strictEqual(b.allow(7), true, 'a hundred reads must not consume a probe');
});

test('probeBudget: check and charge are one synchronous act — no TOCTOU window', () => {
  // allow() consumes at the moment it approves; there is no separate
  // "reserve then commit" a concurrent request could interleave with. Pinned
  // by exhausting the budget through interleaved callers and counting exactly
  // `hourly` approvals, never one more.
  const b = createUserBudget({ name: 't', hourly: 4, daily: 4 });
  let approvals = 0;
  for (let i = 0; i < 20; i++) {
    if (b.allow(1)) approvals++;
    if (b.allow(2)) approvals++; // a second caller interleaving with the first
  }
  assert.strictEqual(approvals, 8, 'exactly hourly x 2 callers, however the calls interleave');
  assert.strictEqual(b.allow(1), false);
  assert.strictEqual(b.allow(2), false);
});
