// Run: node --test  (from backend/)
//
// ===========================================================================
// THE SERVER PROCESS RUNS IN UTC WHEREVER IT IS STARTED (2026-11-03).
//
// flocks.event_time and every created_at in migrations/000_bootstrap.sql are
// naive TIMESTAMP columns holding UTC wall-clock, and config/database.js pins
// each Postgres session to UTC so NOW() writes them that way. node-pg reads a
// naive TIMESTAMP back in the Node process's own zone, so a backend started on
// a machine in America/New_York served every plan four hours late (five since
// the clocks went back on 2026-11-01). Local stacks filmed exactly that until
// each one learned to set TZ=UTC for its child; Railway runs in UTC, which is
// why production never showed it. server.js now pins the process zone itself.
//
// Pinned here:
//   1. server.js sets process.env.TZ = 'UTC' as its first statement after
//      the Sentry require (which __tests__/observability.test.js holds to the
//      very top), and before anything else is required.
//   2. That line, run in a process started under America/New_York, is what
//      turns the stored 23:00 of a 7 PM plan back into 23:00 UTC instead of
//      03:00 UTC the next day, and what makes a day read off local getters
//      agree with the date toISOString writes for it.
//   3. The two seeders that write naive columns from outside the backend's
//      pool write UTC wall-clock too: the screenshot rig's seed client runs
//      its session in UTC and sends plan times as instants, and
//      seeds/demo-data.js sends its Dates as UTC on a UTC session. Both used
//      the machine's zone, which only looked right while the backend read
//      naive columns in that same zone.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BACKEND = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const PIN = "process.env.TZ = 'UTC';";

test('server.js pins the zone right after Sentry and before any other require', () => {
  const lines = SERVER.split('\n');
  assert.strictEqual(lines[0].startsWith("require('./instrument');"), true, 'the Sentry require moved off the first line');
  const code = lines.slice(1).filter((l) => l.trim() && !l.trim().startsWith('//'));
  assert.strictEqual(code[0].trim(), PIN, `the first statement after Sentry is ${JSON.stringify(code[0])}`);
  const pinAt = SERVER.indexOf(PIN);
  const requires = [...SERVER.matchAll(/require\(/g)].map((m) => m.index);
  assert.ok(requires.length > 1);
  assert.ok(requires.filter((i) => i > SERVER.indexOf('\n')).every((i) => i > pinAt),
    'a require between Sentry and the pin could read a Date in the host zone');
});

// One run of node under America/New_York, with or without server.js's own
// line ahead of the reads. Reports what node-pg makes of the stored values.
function readUnderNewYork({ pinned }) {
  const script = `${pinned ? PIN : ''}
const parse = require('pg-types').getTypeParser(1114);
const day = new Date(Date.UTC(2026, 6, 11, 1, 30));
process.stdout.write(JSON.stringify({
  summerPlan: parse('2026-07-10 23:00:00').toISOString(),
  winterPlan: parse('2026-11-06 00:00:00').toISOString(),
  dayFromGetters: day.getDate(),
  dayFromIso: Number(day.toISOString().slice(8, 10)),
  zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
}));`;
  const run = spawnSync(process.execPath, ['-e', script], {
    cwd: BACKEND,
    env: { ...process.env, TZ: 'America/New_York' },
    encoding: 'utf8',
  });
  assert.strictEqual(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('without the pin, a backend started in New York reads every plan late by its offset', () => {
  const r = readUnderNewYork({ pinned: false });
  // A 7 PM EDT plan is stored as 2026-07-10 23:00 and comes back at 11 PM.
  assert.strictEqual(r.summerPlan, '2026-07-11T03:00:00.000Z');
  // A 7 PM EST plan is stored as 2026-11-06 00:00 and comes back at midnight.
  assert.strictEqual(r.winterPlan, '2026-11-06T05:00:00.000Z');
  // 9:30 PM on Friday the 10th by local getters, Saturday the 11th by toISOString.
  assert.notStrictEqual(r.dayFromGetters, r.dayFromIso);
  assert.strictEqual(r.zone, 'America/New_York');
});

test('with server.js\'s line first, the same process reads them as stored, in UTC', () => {
  const r = readUnderNewYork({ pinned: true });
  assert.strictEqual(r.summerPlan, '2026-07-10T23:00:00.000Z');
  assert.strictEqual(r.winterPlan, '2026-11-06T00:00:00.000Z');
  assert.strictEqual(r.dayFromGetters, r.dayFromIso);
  assert.strictEqual(r.zone, 'UTC');
});

test('the seeders outside the backend\'s pool write UTC wall-clock, the way production does', () => {
  const rig = fs.readFileSync(path.join(BACKEND, '..', 'frontend', 'scripts', 'capture-screenshots.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const seedFn = rig.slice(rig.indexOf('async function seed(dbUrl) {'));
  assert.match(seedFn, /^async function seed\(dbUrl\) \{[\s\S]*?new Client\(\{ connectionString: dbUrl, options: '-c TimeZone=UTC' \}\)/,
    'the rig\'s seed client runs in the embedded server\'s default zone again');
  const next = seedFn.slice(seedFn.indexOf('const nextOccurrence'), seedFn.indexOf('};', seedFn.indexOf('const nextOccurrence')));
  assert.match(next, /return d\.toISOString\(\);/, 'the rig sends plan times as local-zone Dates again');

  const demo = fs.readFileSync(path.join(BACKEND, 'seeds', 'demo-data.js'), 'utf8').replace(/\r\n/g, '\n');
  const poolAt = demo.indexOf('const pool = new Pool({');
  assert.ok(demo.indexOf("require('pg').defaults.parseInputDatesAsUTC = true;") > -1
    && demo.indexOf("require('pg').defaults.parseInputDatesAsUTC = true;") < poolAt,
  'demo-data.js sends its Dates in the local zone again');
  assert.match(demo.slice(poolAt, demo.indexOf('});', poolAt)), /options: '-c TimeZone=UTC'/,
    'demo-data.js runs its session in the server\'s default zone again');
});

test('a Date sent as UTC lands in a naive column as the UTC wall-clock a UTC server reads back', () => {
  // What demo-data.js now does, measured: under America/New_York, with the
  // flag a Date goes over in UTC, and without it in New York time, whose
  // offset a naive column drops.
  const script = `const { prepareValue } = require('pg/lib/utils');
const at = new Date(Date.UTC(2026, 10, 7, 1, 0));
const local = prepareValue(at);
require('pg').defaults.parseInputDatesAsUTC = true;
process.stdout.write(JSON.stringify({ local, utc: prepareValue(at) }));`;
  const run = spawnSync(process.execPath, ['-e', script], { cwd: BACKEND, env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
  assert.strictEqual(run.status, 0, run.stderr);
  const r = JSON.parse(run.stdout);
  // Friday 8 PM EST. A naive column keeps the wall-clock and drops the offset.
  assert.match(r.local, /^2026-11-06T20:00:00\.000-05:00$/);
  assert.match(r.utc, /^2026-11-07T01:00:00\.000\+00:00$/);
});
