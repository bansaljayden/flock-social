/**
 * A SECOND COLLECTOR MUST NOT REBUILD THE BASELINES (2026-09-05).
 *
 * The baseline refresh is corpus-wide: it rebuilds every venue from all 3.3M
 * weekly rows in one transaction under withCorpusWriteLock. Two collectors on
 * two crons means one stalls on that lock for the whole rebuild while its own
 * run clock keeps ticking, and the corpus gets 36 full rebuilds a day instead
 * of 24, on the same Postgres that serves production. The holdout-city
 * collector therefore passes --no-baseline-refresh; the hourly PA run owns the
 * rebuild, and covers every city because the statement is not city-scoped.
 *
 * HOW TO RUN
 *   cd backend && node --test __tests__/holdoutCollector.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'collectRealtime.js'), 'utf8').replace(/\r\n/g, '\n');

test('the flag exists, is read from argv, and gates the refresh as a branch', () => {
  assert.match(src, /const skipBaselines = process\.argv\.includes\('--no-baseline-refresh'\) \|\| HOLDOUT\.active;/);
  assert.match(src, /if \(!skipBaselines\) \{\n\s+try \{\n\s+console\.log\('\[ML:Realtime\] Refreshing venue baselines\.\.\.'\);/);
  // A thrown sentinel would swallow real refresh errors; the branch must not
  // be reintroduced that way.
  assert.ok(!/throw \{ skip: true \}/.test(src), 'the skip must be a branch, never a thrown sentinel');
});

test('skipping is announced, so a silent run cannot be mistaken for a refresh', () => {
  assert.match(src, /Skipping the baseline refresh \(--no-baseline-refresh\); another collector owns it\./);
});

test('the refresh still runs by default, so the existing hourly cron is unchanged', () => {
  const at = src.indexOf('const skipBaselines');
  const after = src.slice(at, at + 900);
  assert.match(after, /await refreshCollectedBaselines\(pool\)/);
  // No flag on the command line means skipBaselines is false, so the branch runs.
  assert.ok(!/--no-baseline-refresh.*default/i.test(src), 'the flag must be opt in');
});

test('the collector still only ever asks BestTime by id, so the new-venue allowance is untouched', () => {
  const svc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'bestTimeService.js'), 'utf8').replace(/\r\n/g, '\n');
  const at = svc.indexOf('async function fetchLiveBusyness');
  const fn = svc.slice(at, at + 1200);
  assert.match(fn, /if \(!venueId\) \{/);
  assert.match(fn, /venue_id: venueId/);
  // A by-name live call would spend the monthly new-venue allowance, which is
  // 100 a month on the current package. There must be no venue_name parameter.
  assert.ok(!/venue_name/.test(fn), 'a live call must never be made by name');
});

test('a refused run exits non zero, so a green cron cannot mean nothing was collected', () => {
  // The ceiling refusal used to console.error and return, which ended the
  // process with status 0. Railway paints that green. A new city's service is
  // the most likely thing to trip a stale ceiling, so it is the most likely
  // thing to fail silently, which is the shape of the ninety-day gap this
  // file's header exists to prevent.
  const at = src.indexOf('if (venues.length > maxCredits) {');
  assert.ok(at > -1, 'the ceiling check is gone');
  // Just this if-block: the next branch has its own end-and-return shape.
  const block = src.slice(at, src.indexOf('\n' + '  }', at));
  assert.ok(block.includes('throw new Error('), 'the refusal must throw');
  assert.ok(!/console\.error\([\s\S]{0,200}REFUSED: this run would spend/.test(block),
    'the refusal must throw, not log and return');
  assert.ok(!/await pool\.end\(\);\n\s+return;/.test(block), 'no bare return on the refusal path');

  // The invalid-ceiling guard above it follows the same rule.
  const guardAt = src.indexOf('if (!Number.isInteger(maxCredits)');
  assert.ok(guardAt > -1 && guardAt < at, 'the invalid-ceiling guard is gone');
  const guard = src.slice(guardAt, at);
  assert.ok(guard.includes("throw new Error('REFUSED: --max-credits must be a positive integer"),
    'an invalid ceiling must throw too');

  // An empty scope, which a mistyped city name produces, throws too.
  assert.match(src, /REFUSED: no active venues with a besttime_venue_id in scope/);
  assert.ok(!src.includes("No venues with besttime_venue_id. Run weekly collection first."),
    'an empty scope must not log and exit 0');

  // And the top level turns any throw into a non-zero exit.
  assert.match(src, /run\(\)\.catch\(err => \{/);
  assert.match(src, /process\.exit\(1\);/);
});

test('the holdout city is resolved once, at load, from named UTC hours', () => {
  // A sweep runs for the better part of an hour. If the decision were taken
  // per venue it could change city halfway through when the clock ticked over.
  assert.match(src, /const HOLDOUT = \(\(\) => \{/);
  assert.match(src, /hours\.includes\(new Date\(\)\.getUTCHours\(\)\)/);
  // Declared above run(), so both the scope resolution and the baseline
  // decision read the same answer.
  assert.ok(src.indexOf('const HOLDOUT = ') < src.indexOf('async function run()'),
    'HOLDOUT must resolve before run()');
});

test('a holdout hour replaces the training cities, says so, and skips the corpus rebuild', () => {
  assert.match(src, /\? \[HOLDOUT\.city\]/);
  assert.match(src, /Holdout hour: this run collects \$\{HOLDOUT\.city\} instead of the training cities/);
  assert.match(src, /const skipBaselines = process\.argv\.includes\('--no-baseline-refresh'\) \|\| HOLDOUT\.active;/);
});

test('half a holdout flag is refused, not guessed at', () => {
  // --holdout-city with no hours would either never fire or, read the other
  // way, take every hour from the training cities. Both are wrong and the
  // difference is invisible in a log, so it refuses.
  assert.match(src, /if \(HOLDOUT\.misconfigured\) \{/);
  assert.match(src, /REFUSED: --holdout-city needs --holdout-utc-hours/);
  const at = src.indexOf('if (HOLDOUT.misconfigured)');
  assert.ok(src.slice(at, at + 500).includes('throw new Error('), 'it must throw, not return');
});

test('an hour outside 0 to 23, or a non-number, is dropped rather than trusted', () => {
  const at = src.indexOf('const HOLDOUT = ');
  const block = src.slice(at, src.indexOf('async function run()', at));
  assert.match(block, /Number\.isInteger\(h\) && h >= 0 && h <= 23/);
  // And a flag whose hours all get dropped counts as misconfigured, so it
  // cannot quietly become "never runs".
  assert.match(block, /misconfigured = Boolean\(cityArg\) && \(!city \|\| hours\.length === 0\)/);
});
