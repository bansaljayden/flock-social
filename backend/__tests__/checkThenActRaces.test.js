'use strict';
// ---------------------------------------------------------------------------
// CHECK-THEN-ACT RACES, ON A REAL POSTGRES.
//
// Three places read something, awaited, and then wrote as if nothing could
// have happened in between:
//
//   * POST /api/auth/forgot-password read the per-address budget, then wrote
//     the ledger row and mailed. A parallel burst all read the same counts, so
//     the sixty-second gap and the hourly and daily caps held only against
//     requests that arrived one at a time, and any mailbox could be buried.
//   * POST /api/auth/resend-verification did the same with the per-account
//     budget.
//   * routes/revenuecat.js syncPremiumFromRevenueCat read RevenueCat and then
//     wrote an absolute is_premium, so a slow read taken before a refund could
//     commit after a fast read taken after it and leave the account Pro.
//
// Each now holds a transaction-scoped advisory lock across the read and the
// write. A scripted pool cannot show that a lock blocks anything, so this
// suite runs the real routes and the real sync against a migrated embedded
// Postgres and fires the requests together.
//
// The resend lock has one more thing to hold. A link whose mail did not leave
// no longer starts the sixty-second gap (routes/auth.js
// markVerificationMailFailed, migration 137), and on its own that would hand a
// burst to a failing provider one request at a time: each would take the lock,
// find that the one before it had failed, and be let through. So the budget
// counts a failure only if it was on the row before the reading request began.
// Which request began before which failure is arranged here with the lock the
// route itself takes.
//
// And a fourth, with no lock to take: an image DM, on both transports, checked
// the pair for a block and then waited on the image screen for as long as it
// took, and a block or a ban that landed in that wait changed nothing. The
// message was stored and delivered to the person who had just blocked its
// sender. Both sends ask the pair again after the screen now
// (utils/blocks.js isBlockedOrBannedBetween); the screen is held open here
// while the block or the ban is written.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');
const { removeTempDir } = require('./helpers/removeTempDir');

const PG_PORT = pickEmbeddedPgPort('checkThenActRaces');
const DB_NAME = 'flock_check_then_act_test';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-check-then-act-races';
delete process.env.BAN_TOMBSTONE_SECRET;
delete process.env.RESEND_API_KEY;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.FIREBASE_SERVICE_ACCOUNT;
// Fake, assembled at runtime so nothing here looks like a real key.
process.env.REVENUECAT_SECRET_API_KEY = ['rc', 'secret', 'r'.repeat(24)].join('-');

// RevenueCat is a fake global fetch, answered by whichever handler the test
// installs. Nothing leaves the process.
const realFetch = global.fetch;
let rcHandler = null;
global.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.revenuecat.com/') && rcHandler) return rcHandler(String(url), init);
  return realFetch(url, init);
};

// The mail provider, replaced before anything that mails is required. The file
// runs without a provider key, so nothing reaches this unless a test sets one
// for its own length (withMailer). `mailFails` makes it answer the way a
// provider that is down does; `mailGate`, when set, holds a send open.
let mailFails = false;
let mailGate = null;
let mailsAsked = 0;
const resendPath = require.resolve('resend');
require.cache[resendPath] = {
  id: resendPath, filename: resendPath, loaded: true,
  exports: {
    Resend: class {
      constructor() {
        this.emails = {
          send: async () => {
            mailsAsked += 1;
            const n = mailsAsked;
            const fails = mailFails;
            if (mailGate) await mailGate;
            return fails
              ? { data: null, error: { statusCode: 503, name: 'application_error', message: 'provider down' } }
              : { data: { id: `mail-${n}` }, error: null };
          },
        };
      }
    },
  },
};
async function withMailer(fn) {
  process.env.RESEND_API_KEY = 'test-resend-key';
  try {
    return await fn();
  } finally {
    delete process.env.RESEND_API_KEY;
    mailFails = false;
    mailGate = null;
  }
}

// The image screen, replaced before anything that sends a DM is required
// (routes/messages.js and sockets/handlers.js take moderateImage when they
// load). Every screen passes; `imageScreen`, when set, holds it open.
const moderation = require('../utils/moderation');
let imageScreen = null;
let screens = 0;
moderation.moderateImage = async () => {
  screens += 1;
  if (imageScreen) await imageScreen;
  return { allowed: true };
};

let pg;
let pool;
let dataDir;
let server;
let base;
let authRouter;
let dmServer;
let dmBase;
let signUserToken;
let registerHandlers;

// What the DM routes and handlers send, by room.
const dmEmits = [];
const dmIo = {
  sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
  to(room) {
    const op = { except() { return op; }, emit(event, payload) { dmEmits.push({ room, event, payload }); } };
    return op;
  },
  in() { return { socketsLeave() {}, disconnectSockets() {} }; },
};

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-check-then-act-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'checkThenActRaces', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);

  authRouter = require('../routes/auth');
  const app = express();
  app.use(express.json());
  app.set('io', null);
  app.use('/api/auth', authRouter);
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  ({ signUserToken } = require('../middleware/auth'));
  ({ registerHandlers } = require('../sockets/handlers'));
  const dmApp = express();
  dmApp.use(express.json({ limit: '1mb' }));
  dmApp.set('io', dmIo);
  dmApp.use('/api', require('../routes/messages'));
  dmServer = await new Promise((resolve) => {
    const s = http.createServer(dmApp).listen(0, '127.0.0.1', () => resolve(s));
  });
  dmBase = `http://127.0.0.1:${dmServer.address().port}`;
});

test.after(async () => {
  global.fetch = realFetch;
  if (dmServer) await new Promise((r) => dmServer.close(r));
  if (server) await new Promise((r) => server.close(r));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  removeTempDir(dataDir, 'checkThenActRaces');
});

async function call(method, p, { token, body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

const PASSWORD = 'R4ceCondition';
const signup = (email) => call('POST', '/api/auth/signup', {
  body: { email, password: PASSWORD, name: 'Riley', date_of_birth: '2000-01-01' },
});
const count = async (sql, params = []) => (await pool.query(sql, params)).rows[0].n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond) => { for (let i = 0; i < 400 && !cond(); i += 1) await sleep(5); };
const statusesOf = (answers) => answers.map((a) => a.status);

test('a burst of reset requests for one address passes the budget exactly as often as requests one at a time would', async () => {
  const s = await signup('burst.reset@example.com');
  assert.strictEqual(s.status, 201, s.text);
  await pool.query('DELETE FROM password_reset_requests WHERE id > 0');
  const burst = () => Promise.all(Array.from({ length: 8 }, () =>
    call('POST', '/api/auth/forgot-password', { body: { email: 'burst.reset@example.com' } })));

  // The sixty-second gap: one request of the burst is accepted, the rest are
  // refused with the ordinary 429, and one reset link is issued.
  let statuses = statusesOf(await burst());
  assert.strictEqual(statuses.filter((x) => x === 200).length, 1, `a burst passed the gap more than once: ${statuses}`);
  assert.strictEqual(statuses.filter((x) => x === 429).length, 7, `${statuses}`);
  await authRouter.__testing.flushResetMail();
  assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM password_reset_requests'), 1);
  assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM password_resets WHERE user_id = $1', [s.body.user.id]), 1,
    'more than one reset link was issued for one address');

  // The hourly cap (three) holds under bursts too: with the gap opened before
  // each burst, exactly one more request gets through each time, and none once
  // three are in the hour.
  const accepted = [1];
  for (let round = 0; round < 3; round += 1) {
    await pool.query("UPDATE password_reset_requests SET created_at = created_at - INTERVAL '2 minutes' WHERE id > 0");
    statuses = statusesOf(await burst());
    accepted.push(statuses.filter((x) => x === 200).length);
  }
  assert.deepStrictEqual(accepted, [1, 1, 1, 0], 'the hourly cap was exceeded by a burst');
  assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM password_reset_requests'), 3);
  await authRouter.__testing.flushResetMail();
});

test('a single reset request is still accepted and recorded once', async () => {
  const s = await signup('single.reset@example.com');
  assert.strictEqual(s.status, 201, s.text);
  await pool.query('DELETE FROM password_reset_requests WHERE id > 0');
  const one = await call('POST', '/api/auth/forgot-password', { body: { email: 'single.reset@example.com' } });
  assert.strictEqual(one.status, 200, one.text);
  // An address with no account is budgeted the same way, so a refusal still
  // says nothing about whether the mailbox has one.
  const ghost = await call('POST', '/api/auth/forgot-password', { body: { email: 'nobody.here@example.com' } });
  assert.strictEqual(ghost.status, 200, ghost.text);
  assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM password_reset_requests'), 2);
  await authRouter.__testing.flushResetMail();
});

// With a provider that delivers. A link whose mail did not leave starts no gap
// (the three tests after this one), so on the file's own keyless setup the
// second request of a burst could rightly be answered too.
test('a burst of resend requests issues one confirmation link, not one per request', () => withMailer(async () => {
  const s = await signup('burst.verify@example.com');
  assert.strictEqual(s.status, 201, s.text);
  assert.strictEqual(s.body.verificationSent, true);
  const userId = s.body.user.id;
  assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM email_verifications WHERE user_id = $1', [userId]), 1,
    'signup should have issued the first link');
  // Past the sixty-second gap, so exactly one resend is due.
  await pool.query("UPDATE email_verifications SET created_at = created_at - INTERVAL '2 minutes' WHERE user_id = $1", [userId]);

  const asked = mailsAsked;
  const answers = await Promise.all(Array.from({ length: 8 }, () =>
    call('POST', '/api/auth/resend-verification', { token: s.body.token })));
  const statuses = statusesOf(answers);
  assert.strictEqual(statuses.filter((x) => x === 200).length, 1, `a burst was sent more than once: ${statuses}`);
  assert.strictEqual(statuses.filter((x) => x === 429).length, 7, `${statuses}`);
  assert.strictEqual(mailsAsked, asked + 1, 'the provider was handed more than one mail');
  assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM email_verifications WHERE user_id = $1', [userId]), 2);
  assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM email_verifications WHERE user_id = $1 AND used_at IS NULL', [userId]), 1,
    'exactly one link is live, the one the accepted request issued');
  assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM email_verifications WHERE user_id = $1 AND mail_failed_at IS NOT NULL', [userId]), 0,
    'a delivered link was marked as one whose mail did not leave');
}));

test('a confirmation mail that did not leave starts no sixty-second gap, and one that did still does', async () => {
  // No provider key, as on a laptop: the link is issued and its mail is not.
  const s = await signup('unsent.verify@example.com');
  assert.strictEqual(s.status, 201, s.text);
  assert.strictEqual(s.body.verificationSent, false);
  const userId = s.body.user.id;
  const resend = () => call('POST', '/api/auth/resend-verification', { token: s.body.token });
  const links = () => count('SELECT COUNT(*)::int AS n FROM email_verifications WHERE user_id = $1', [userId]);
  const unsent = () => count('SELECT COUNT(*)::int AS n FROM email_verifications WHERE user_id = $1 AND mail_failed_at IS NOT NULL', [userId]);
  assert.strictEqual(await unsent(), 1, "signup's link is not marked as one whose mail did not leave");

  // Asked for at once, with that row seconds old. This was a 429 "We just sent
  // one. Check your inbox", under a screen saying the link did not go out.
  const again = await resend();
  assert.strictEqual(again.status, 200, again.text);
  assert.strictEqual(again.body.verificationSent, false);
  assert.strictEqual(await links(), 2);
  assert.strictEqual(await unsent(), 2);

  await withMailer(async () => {
    const delivered = await resend();
    assert.strictEqual(delivered.status, 200, delivered.text);
    assert.strictEqual(delivered.body.verificationSent, true);
    assert.strictEqual(await unsent(), 2, 'a delivered link was marked');

    // That one is in an inbox, so the gap it starts is real.
    const tooSoon = await resend();
    assert.strictEqual(tooSoon.status, 429, tooSoon.text);
    assert.match(tooSoon.body.error, /^We just sent one\. Check your inbox/);
    assert.strictEqual(await links(), 3, 'a refused request issued a link');
  });
});

test('a burst at a provider that is failing is one attempt: a failure recorded after a request began does not let it through', () => withMailer(async () => {
  const s = await signup('burst.unsent@example.com');
  assert.strictEqual(s.status, 201, s.text);
  assert.strictEqual(s.body.verificationSent, true);
  const userId = s.body.user.id;
  // Past the sixty-second gap, so exactly one resend is due.
  await pool.query("UPDATE email_verifications SET created_at = created_at - INTERVAL '2 minutes' WHERE user_id = $1", [userId]);
  const resend = () => call('POST', '/api/auth/resend-verification', { token: s.body.token });
  const waiting = () => count("SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted");
  const waitingOnARow = () => count("SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype <> 'advisory' AND NOT granted");

  // The first request of the burst is accepted, and its mail is with a
  // provider that is about to answer no.
  mailFails = true;
  let letTheProviderAnswer;
  mailGate = new Promise((r) => { letTheProviderAnswer = r; });
  const asked = mailsAsked;
  let rest = [];
  let answered = false;
  const holder = await pool.connect();
  const rowHolder = await pool.connect();
  const first = resend();
  first.then(() => { answered = true; }, () => { answered = true; });
  try {
    await until(() => mailsAsked > asked);
    assert.strictEqual(mailsAsked, asked + 1, 'the first request never reached the provider');

    // The other seven have begun and are queued behind the account's lock,
    // which is held here so that all of them are still waiting when the
    // failure is recorded.
    await holder.query('BEGIN');
    await holder.query("SELECT pg_advisory_xact_lock(hashtext('verify-budget:' || $1::text))", [String(userId)]);
    rest = Array.from({ length: 7 }, resend);
    for (let i = 0; i < 400 && await waiting() < 7; i += 1) await sleep(5);
    assert.strictEqual(await waiting(), 7, 'the burst never queued behind the lock');

    // The provider answers no, and the first request goes to record that. The
    // account's rows are locked here for a moment, so it cannot yet, and its
    // answer has to wait: one that went out first would say "ask again" to a
    // person whose next request could still be told "We just sent one".
    await rowHolder.query('BEGIN');
    await rowHolder.query('SELECT id FROM email_verifications WHERE user_id = $1 FOR UPDATE', [userId]);
    letTheProviderAnswer();
    for (let i = 0; i < 400 && await waitingOnARow() < 1; i += 1) await sleep(5);
    assert.strictEqual(await waitingOnARow(), 1, 'the failure was never sent to be recorded');
    await sleep(50);
    assert.strictEqual(answered, false, 'the request answered before its failure was on the row');
    await rowHolder.query('COMMIT');

    const answer = await first;
    assert.strictEqual(answer.status, 200, answer.text);
    assert.strictEqual(answer.body.verificationSent, false);
    assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM email_verifications WHERE user_id = $1 AND mail_failed_at IS NOT NULL', [userId]), 1);
  } finally {
    // Whatever happened above, nothing is left waiting on the provider, on
    // the rows or on the lock.
    letTheProviderAnswer();
    await rowHolder.query('ROLLBACK').catch(() => {});
    rowHolder.release();
    await holder.query('ROLLBACK').catch(() => {});
    holder.release();
  }

  // Each of the seven began before that failure existed, so to each of them the
  // link is a send still in flight and the gap holds. Counting the failure for
  // them would let them through one after another, each to the same provider.
  const statuses = statusesOf(await Promise.all(rest));
  assert.deepStrictEqual(statuses, Array(7).fill(429), `the rest of a burst got past a send that had only just failed: ${statuses}`);
  assert.strictEqual(mailsAsked, asked + 1, 'a burst reached a failing provider more than once');
  assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM email_verifications WHERE user_id = $1', [userId]), 2);

  // A request that begins after the failure is on the row is the person asking
  // again, and is answered at once.
  mailFails = false;
  mailGate = null;
  const next = await resend();
  assert.strictEqual(next.status, 200, next.text);
  assert.strictEqual(next.body.verificationSent, true);
  assert.strictEqual(mailsAsked, asked + 2);
}));

test('at the hourly cap, the refusal promises a working link only when one was delivered', async () => {
  const { RESEND_MAX_PER_HOUR_ACCOUNT } = authRouter.__testing;
  // No provider key: every link of the hour is issued and none is mailed.
  const s = await signup('capped.unsent@example.com');
  assert.strictEqual(s.status, 201, s.text);
  const userId = s.body.user.id;
  const resend = () => call('POST', '/api/auth/resend-verification', { token: s.body.token });
  for (let i = 1; i < RESEND_MAX_PER_HOUR_ACCOUNT; i += 1) {
    const r = await resend();
    assert.strictEqual(r.status, 200, `ask ${i} of the hour: ${r.text}`);
    assert.strictEqual(r.body.verificationSent, false);
  }

  // A send that did not leave is still an attempt, so the cap holds. Each link
  // retired the one before it and the newest was never mailed, so no inbox
  // holds one that works, and the refusal does not say one does.
  const capped = await resend();
  assert.strictEqual(capped.status, 429, capped.text);
  assert.strictEqual(capped.body.error,
    'That is several confirmation links already. You can ask for another in about an hour.');

  // The same hour, had the newest link been delivered.
  await pool.query(
    'UPDATE email_verifications SET mail_failed_at = NULL WHERE id = (SELECT MAX(id) FROM email_verifications WHERE user_id = $1)',
    [userId]
  );
  const cappedWithALink = await resend();
  assert.strictEqual(cappedWithALink.status, 429, cappedWithALink.text);
  assert.strictEqual(cappedWithALink.body.error,
    'That is several confirmation links already. You can ask for another in about an hour. The last link we sent still works.');
  assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM email_verifications WHERE user_id = $1', [userId]), RESEND_MAX_PER_HOUR_ACCOUNT);
});

test('two overlapping Pro syncs for one account: the second reads RevenueCat only after the first has committed', async () => {
  const { rows: [u] } = await pool.query(
    "INSERT INTO users (email, password, name) VALUES ('sync.race@example.com', 'x', 'S') RETURNING id"
  );
  const { syncPremiumFromRevenueCat } = require('../routes/revenuecat');
  const future = new Date(Date.now() + 30 * 864e5).toISOString();
  let rcActive = true;
  let reads = 0;
  let letFirstReadFinish;
  const firstReadHeld = new Promise((r) => { letFirstReadFinish = r; });
  const seen = [];
  rcHandler = async (url) => {
    if (!url.includes('/subscribers/')) return new Response('{}', { status: 200 });
    reads += 1;
    const n = reads;
    const answer = rcActive;
    seen.push(`read${n}:${answer}`);
    if (n === 1) await firstReadHeld;
    return new Response(JSON.stringify({ subscriber: { entitlements: answer ? { pro: { expires_date: future } } : {} } }), { status: 200 });
  };
  try {
    const first = syncPremiumFromRevenueCat(u.id);
    await until(() => reads === 1);
    rcActive = false; // a refund lands at RevenueCat while the first read is out
    const second = syncPremiumFromRevenueCat(u.id);
    await sleep(200);
    assert.strictEqual(reads, 1, 'the second sync read RevenueCat while the first still held the account');
    letFirstReadFinish();
    assert.deepStrictEqual(await Promise.all([first, second]), [true, false]);
    assert.deepStrictEqual(seen, ['read1:true', 'read2:false']);
    const { rows: [row] } = await pool.query('SELECT is_premium FROM users WHERE id = $1', [u.id]);
    assert.strictEqual(row.is_premium, false, 'a stale read left a refunded account Pro');
  } finally {
    rcHandler = null;
  }
});

test('Pro syncs for different accounts do not wait on each other', async () => {
  const { rows: [a] } = await pool.query("INSERT INTO users (email, password, name) VALUES ('sync.a@example.com', 'x', 'A') RETURNING id");
  const { rows: [b] } = await pool.query("INSERT INTO users (email, password, name) VALUES ('sync.b@example.com', 'x', 'B') RETURNING id");
  const { syncPremiumFromRevenueCat } = require('../routes/revenuecat');
  const future = new Date(Date.now() + 30 * 864e5).toISOString();
  let letSlowFinish;
  const slowHeld = new Promise((r) => { letSlowFinish = r; });
  rcHandler = async (url) => {
    if (url.includes(`/subscribers/${a.id}`)) await slowHeld;
    return new Response(JSON.stringify({ subscriber: { entitlements: { pro: { expires_date: future } } } }), { status: 200 });
  };
  try {
    const slow = syncPremiumFromRevenueCat(a.id);
    await sleep(50);
    assert.strictEqual(await syncPremiumFromRevenueCat(b.id), true, 'one account\'s sync waited on another\'s');
    const { rows: [rowB] } = await pool.query('SELECT is_premium FROM users WHERE id = $1', [b.id]);
    assert.strictEqual(rowB.is_premium, true);
    letSlowFinish();
    assert.strictEqual(await slow, true);
  } finally {
    rcHandler = null;
  }
});

// ---------------------------------------------------------------------------
// An image DM, and a block or a ban that lands while its image is screened.
// ---------------------------------------------------------------------------

const IMAGE = `data:image/png;base64,${Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24),
]).toString('base64')}`;
let dmSeq = 0;

async function friendsForDm() {
  const make = async (name) => {
    dmSeq += 1;
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (email, password, name, email_verified) VALUES ($1, 'x', $2, true) RETURNING *`,
      [`dm${dmSeq}.${Date.now()}@example.com`, name]
    );
    return { ...u, token: signUserToken(u) };
  };
  const sender = await make('Sender');
  const receiver = await make('Receiver');
  await pool.query(
    "INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'accepted')", [sender.id, receiver.id]
  );
  return { sender, receiver };
}

// Each door sends one image DM and answers whether it was refused as closed.
const DM_DOORS = [
  ['over REST', async (sender, receiver) => {
    const res = await fetch(`${dmBase}/api/dm/${receiver.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sender.token}` },
      body: JSON.stringify({ image_url: IMAGE, message_type: 'image' }),
    });
    const text = await res.text();
    return { closed: res.status === 403 && /no longer message this user/.test(text), sent: res.status === 201, detail: `${res.status} ${text}` };
  }],
  ['over the socket', async (sender, receiver) => {
    const errors = [];
    const handlers = new Map();
    dmSeq += 1;
    const socket = {
      id: `dm-race-${dmSeq}`,
      user: { id: sender.id, name: sender.name },
      rooms: new Set(),
      handshake: null,
      on(event, handler) { handlers.set(event, handler); },
      join(room) { socket.rooms.add(room); },
      leave(room) { socket.rooms.delete(room); },
      emit(event, payload) { if (event === 'error') errors.push(payload && payload.message); },
      to(room) { return dmIo.to(room); },
    };
    registerHandlers(dmIo, socket);
    await handlers.get('send_dm')({ receiverId: receiver.id, image_url: IMAGE, message_type: 'image' });
    return {
      closed: errors.includes('You can no longer message this user.'),
      sent: errors.length === 0,
      detail: JSON.stringify(errors),
    };
  }],
];

const CLOSERS = [
  ['the recipient blocks the sender', ({ sender, receiver }) => pool.query(
    'INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)', [receiver.id, sender.id]
  )],
  ['the sender is banned', ({ sender }) => pool.query('UPDATE users SET is_banned = true WHERE id = $1', [sender.id])],
];

const deliveredTo = (user) => dmEmits.filter((e) => e.event === 'new_dm' && e.room === `user:${user.id}`);

for (const [door, send] of DM_DOORS) {
  for (const [what, close] of CLOSERS) {
    test(`an image DM ${door}: ${what} while the image is screened, and nothing is stored or delivered`, async () => {
      const pair = await friendsForDm();
      let letScreenFinish = () => {};
      imageScreen = new Promise((r) => { letScreenFinish = r; });
      const before = screens;
      let outcome;
      try {
        const sending = send(pair.sender, pair.receiver);
        await until(() => screens > before); // the send is inside the screen, past every check
        assert.ok(screens > before, 'the send never reached the image screen');
        await close(pair);
        letScreenFinish();
        outcome = await sending;
      } finally {
        imageScreen = null;
        letScreenFinish();
      }
      assert.ok(outcome.closed, `the message went through: ${outcome.detail}`);
      assert.strictEqual(
        await count('SELECT COUNT(*)::int AS n FROM direct_messages WHERE sender_id = $1', [pair.sender.id]), 0,
        'the message was stored'
      );
      assert.deepStrictEqual(deliveredTo(pair.receiver), [], 'and delivered');
    });
  }

  test(`an image DM ${door} with nothing changed during the screen is stored and delivered`, async () => {
    const pair = await friendsForDm();
    const outcome = await send(pair.sender, pair.receiver);
    assert.ok(outcome.sent, outcome.detail);
    assert.strictEqual(
      await count('SELECT COUNT(*)::int AS n FROM direct_messages WHERE sender_id = $1', [pair.sender.id]), 1
    );
    assert.strictEqual(deliveredTo(pair.receiver).length, 1);
  });
}
