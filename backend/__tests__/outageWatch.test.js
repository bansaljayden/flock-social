// Run: node --test  (from backend/)
//
// WHO NOTICES WHEN THE WHOLE APP IS DOWN.
//
// Railway calls /api/health only at the start of a deployment, and every other
// alert in this server claims its day in ops_alert_ledger, which lives in the
// database. So a database that died mid-afternoon, or an API process that was
// crash-looping, told nobody. Two watchers now cover it, and this file pins
// both:
//
//   services/dbOutageAlert.js   the server probes Postgres once a minute and,
//                               after three failures in a row, emails without
//                               touching the database; one email per outage,
//                               one "answering again" when it recovers, and
//                               never two down emails inside an hour.
//   services/apiUptimeCheck.js  the hourly collector, a separate service, GETs
//                               /api/health from outside and emails on anything
//                               but a 200, once a day through the ledger when
//                               it can reach it and regardless when it cannot.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'outage-watch-test-secret';

const pool = require('../config/database');
const emailService = require('../services/emailService');

let mails = [];
let mailAnswer = () => ({ sent: true, id: 'm' });
emailService.sendEmail = async (msg) => {
  const out = mailAnswer(msg);
  if (out instanceof Error) throw out;
  if (out.sent !== false) mails.push(msg);
  return out;
};

const realError = console.error;
test.before(() => { console.error = () => {}; });
test.after(() => { console.error = realError; });

const { createDbWatch, DOWN_TICKS_BEFORE_ALERT, MIN_GAP_MS } = require('../services/dbOutageAlert');
const { runApiUptimeCheck, probeApi, ALERT_KEY } = require('../services/apiUptimeCheck');

function reset() {
  mails = [];
  mailAnswer = () => ({ sent: true, id: 'm' });
  process.env.MODERATION_ALERT_EMAIL = 'ops@example.com';
}

function watch(initialUp = true) {
  let up = initialUp;
  let t = 1_000_000;
  const w = createDbWatch({ probe: async () => up, now: () => t });
  return {
    ...w,
    set: (v) => { up = v; },
    advance: (ms) => { t += ms; },
  };
}

// ---------------------------------------------------------------------------
// The in-process database watch
// ---------------------------------------------------------------------------
test('a blip is not an outage; three failed probes in a row are, and mail once', async () => {
  reset();
  const w = watch(false);
  for (let i = 0; i < DOWN_TICKS_BEFORE_ALERT - 1; i += 1) { await w.tick(); w.advance(60_000); }
  assert.strictEqual(mails.length, 0, 'a restart or a failover of the database pages nobody');
  await w.tick();
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].to, 'ops@example.com');
  assert.match(mails[0].subject, /cannot reach its database/);
  assert.match(mails[0].text, /about 2 minutes/);
  for (let i = 0; i < 30; i += 1) { w.advance(60_000); await w.tick(); }
  assert.strictEqual(mails.length, 1, 'one email per outage, not one a minute');
});

test('recovery sends one more email with how long it was down, then silence', async () => {
  reset();
  const w = watch(false);
  for (let i = 0; i < 10; i += 1) { await w.tick(); w.advance(60_000); }
  w.set(true);
  await w.tick();
  await w.tick();
  assert.strictEqual(mails.length, 2);
  assert.match(mails[1].subject, /answering again/);
  assert.match(mails[1].text, /about 10 minutes down/);
});

test('a blip that recovered before the alert sends no recovery email either', async () => {
  reset();
  const w = watch(false);
  await w.tick();
  w.set(true);
  await w.tick();
  assert.strictEqual(mails.length, 0);
});

test('a database that flaps is one down email an hour, not one a flap', async () => {
  reset();
  const w = watch(false);
  for (let i = 0; i < DOWN_TICKS_BEFORE_ALERT; i += 1) { await w.tick(); w.advance(60_000); }
  w.set(true); await w.tick(); // recovered: 2 emails so far
  w.set(false);
  for (let i = 0; i < 10; i += 1) { await w.tick(); w.advance(60_000); }
  assert.strictEqual(mails.length, 2, 'the second outage inside the hour waits for the floor');
  w.advance(MIN_GAP_MS);
  await w.tick();
  assert.strictEqual(mails.length, 3, 'and is mailed once the hour has passed while it is still down');
});

test('a failed send is tried again on the next probe', async () => {
  reset();
  mailAnswer = () => ({ sent: false, error: 'resend down' });
  const w = watch(false);
  for (let i = 0; i < DOWN_TICKS_BEFORE_ALERT; i += 1) { await w.tick(); w.advance(60_000); }
  assert.strictEqual(mails.length, 0);
  mailAnswer = () => ({ sent: true });
  await w.tick();
  assert.strictEqual(mails.length, 1);
});

test('a probe that throws counts as down', async () => {
  reset();
  let t = 0;
  const w = createDbWatch({ probe: async () => { throw new Error('pool ended'); }, now: () => (t += 60_000) });
  for (let i = 0; i < DOWN_TICKS_BEFORE_ALERT; i += 1) await w.tick();
  assert.strictEqual(mails.length, 1);
});

test('the down email goes out with the database unreachable, because it never touches it', async () => {
  reset();
  const saved = pool.query;
  let touched = 0;
  pool.query = async () => { touched += 1; throw new Error('connection terminated'); };
  try {
    const w = watch(false);
    for (let i = 0; i < DOWN_TICKS_BEFORE_ALERT; i += 1) { await w.tick(); w.advance(60_000); }
    assert.strictEqual(mails.length, 1);
    assert.strictEqual(touched, 0, 'no ledger claim, no query of any kind');
  } finally {
    pool.query = saved;
  }
});

test('with no recipient configured, it says so and sends nothing', async () => {
  reset();
  process.env.MODERATION_ALERT_EMAIL = '';
  const w = watch(false);
  for (let i = 0; i < DOWN_TICKS_BEFORE_ALERT; i += 1) { await w.tick(); w.advance(60_000); }
  assert.strictEqual(mails.length, 0);
});

test('server.js runs the watch every minute on the health probe, and stops it on shutdown', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /createDbWatch\(\{ probe: probeDbHealth \}\)/);
  assert.match(src, /dbWatchInterval = setInterval\(/);
  assert.match(src, /dbWatchInterval\.unref\(\)/);
  const shutdown = /function shutdown\(signal\) \{([\s\S]*?)\n\}/.exec(src)[1];
  assert.match(shutdown, /clearInterval\(dbWatchInterval\)/);
  assert.doesNotMatch(src, /Railway routing away from a saturated/,
    'Railway does not poll the healthcheck after a deploy, so the comment must not say it routes on it');
});

// ---------------------------------------------------------------------------
// The outside check, run by the hourly collector
// ---------------------------------------------------------------------------
function ledgerDb({ throws = false } = {}) {
  const rows = new Set();
  const calls = [];
  return {
    calls,
    rows,
    async query(sql, params) {
      const flat = String(sql).replace(/\s+/g, ' ');
      calls.push(flat);
      if (throws) throw new Error('connect ECONNREFUSED');
      if (/INSERT INTO ops_alert_ledger/.test(flat)) {
        if (rows.has(params[0])) return { rows: [] };
        rows.add(params[0]);
        return { rows: [{ sent_on: 'today' }] };
      }
      if (/DELETE FROM ops_alert_ledger/.test(flat)) { rows.delete(params[0]); return { rows: [] }; }
      return { rows: [] };
    },
  };
}

const answer = (status, body) => async () => ({ status, json: async () => body });

test('a healthy API is one GET and nothing else', async () => {
  reset();
  const db = ledgerDb();
  const seen = [];
  const out = await runApiUptimeCheck({
    db,
    fetchImpl: async (url, opts) => { seen.push({ url, opts }); return { status: 200, json: async () => ({ status: 'ok', db: 'ok' }) }; },
  });
  assert.deepStrictEqual(out, { ok: true });
  assert.strictEqual(seen.length, 1);
  assert.match(seen[0].url, /\/api\/health$/);
  assert.ok(seen[0].opts.signal, 'the GET is bounded');
  assert.strictEqual(db.calls.length, 0);
  assert.strictEqual(mails.length, 0);
});

test('a 503 from a database the API cannot reach is mailed, and says where to look', async () => {
  reset();
  const db = ledgerDb();
  const out = await runApiUptimeCheck({ db, fetchImpl: answer(503, { status: 'degraded', db: 'unreachable' }) });
  assert.deepStrictEqual(out, { ok: false, sent: true });
  assert.strictEqual(mails.length, 1);
  assert.match(mails[0].subject, /API is not answering/);
  assert.match(mails[0].text, /answered 503: the API is running but cannot reach Postgres/);
  assert.ok(db.rows.has(ALERT_KEY));
  assert.doesNotMatch(`${mails[0].subject}\n${mails[0].text}`, /—/);
});

test('a dead or crash-looping process is named as that', async () => {
  reset();
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  await runApiUptimeCheck({ db: ledgerDb(), fetchImpl: async () => { throw refused; } });
  assert.match(mails[0].text, /the request failed: ECONNREFUSED/);
  assert.match(mails[0].text, /probably down or restarting in a loop/);

  reset();
  const slow = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  await runApiUptimeCheck({ db: ledgerDb(), fetchImpl: async () => { throw slow; } });
  assert.match(mails[0].text, /no answer within 10 seconds/);
});

test('it mails once a day through the ledger while the API stays down', async () => {
  reset();
  const db = ledgerDb();
  for (let i = 0; i < 5; i += 1) await runApiUptimeCheck({ db, fetchImpl: answer(502, {}) });
  assert.strictEqual(mails.length, 1);
});

test('with the database unreachable from the collector too, it sends anyway', async () => {
  reset();
  const out = await runApiUptimeCheck({ db: ledgerDb({ throws: true }), fetchImpl: answer(503, { db: 'unreachable' }) });
  assert.deepStrictEqual(out, { ok: false, sent: true });
  assert.strictEqual(mails.length, 1);
});

test('a send that failed releases the day so the next hour tries again', async () => {
  reset();
  const db = ledgerDb();
  mailAnswer = () => ({ sent: false, error: 'resend down' });
  await runApiUptimeCheck({ db, fetchImpl: answer(500, {}) });
  assert.ok(!db.rows.has(ALERT_KEY));
  mailAnswer = () => ({ sent: true });
  await runApiUptimeCheck({ db, fetchImpl: answer(500, {}) });
  assert.strictEqual(mails.length, 1);
});

test('no recipient on the collector service is said, not swallowed, and the day is not burned', async () => {
  reset();
  process.env.MODERATION_ALERT_EMAIL = '';
  const db = ledgerDb();
  const out = await runApiUptimeCheck({ db, fetchImpl: answer(503, {}) });
  assert.deepStrictEqual(out, { ok: false, skipped: 'no-recipient' });
  assert.strictEqual(db.calls.length, 0);
});

test('probeApi never rejects, whatever the network does', async () => {
  const r = await probeApi({ url: 'https://example.invalid/api/health', fetchImpl: async () => { throw new Error('boom'); } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, null);
});

test('the collector opens every run with the outside check, before it collects', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'collectRealtime.js'), 'utf8').replace(/\r\n/g, '\n');
  const run = /async function run\(\) \{([\s\S]*?)\n\}/.exec(src)[1];
  const check = run.indexOf("require('../../services/apiUptimeCheck').runApiUptimeCheck({ db: pool })");
  assert.ok(check > 0, 'the collector no longer checks the API from outside');
  assert.ok(check < run.indexOf('await collectRealtime();'));
});
