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
  assert.match(src, /const skipBaselines = process\.argv\.includes\('--no-baseline-refresh'\);/);
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
