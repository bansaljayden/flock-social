// Run: node --test  (from backend/)
//
// WHICH QUESTION A YES ANSWERED, ON A REAL DATABASE (migration 122).
//
// Since October 6, 2026 the web app sends the device's time zone with every
// Birdie turn, and Birdie is told the date and time it is there. The question
// the app asks before the first message names both; the question before it did
// not. The app asks only while users.birdie_ai_consent_at is NULL, so an
// account that said yes to the earlier question never sees the new one, and
// its turns carried the zone under a yes that never covered it. The same goes
// for a yes given in App Store build 1.0 or a web tab on an older bundle, which
// show the earlier question.
//
// POST /api/ai/consent now records which question the client showed, and
// /chat reads the zone a turn carries only on a yes to one that names it.
// Walked through the real Birdie router on an embedded Postgres, so the
// consent statements' CASE, GREATEST and NULL handling are Postgres's own.
// Gemini is faked, and everything handed to it is kept.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');

const PG_PORT = pickEmbeddedPgPort('birdieConsentCopyRealDb');
const DB_NAME = 'flock_birdie_consent_copy_test';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-birdie-consent-copy';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.POSTHOG_API_KEY;
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.RESEND_API_KEY;

// Gemini, faked before the router is required. Every chat it is asked to open
// is kept, because the system instruction is where the zone would show.
const genaiMod = require('@google/genai');
let chatCreates = [];
genaiMod.GoogleGenAI = function FakeGenAI() {
  return {
    chats: {
      create: (p) => {
        chatCreates.push(p);
        return { sendMessage: async () => ({ candidates: [{ content: { parts: [{ text: 'oakwood, chill till 9' }] } }] }) };
      },
    },
  };
};

let pg;
let pool;
let dataDir;
let server;
let base;
let signUserToken;
let seq = 0;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-birdie-consent-copy-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'birdieConsentCopyRealDb', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);
  ({ signUserToken } = require('../middleware/auth'));
  const app = express();
  app.use(express.json());
  app.use('/api/ai', require('../routes/ai'));
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test.beforeEach(() => { chatCreates = []; });

// A fresh account per case: the turn meter has no reset hook by design.
async function user() {
  seq += 1;
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password, name, email_verified, date_of_birth)
     VALUES ($1, 'x', 'Ava Lee', true, '2000-01-01') RETURNING *`,
    [`consent${seq}.${Date.now()}@example.com`]
  );
  return { ...u, token: signUserToken(u) };
}

async function call(method, p, who, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

const consentRow = async (who) => (await pool.query(
  'SELECT birdie_ai_consent_at, birdie_ai_consent_copy FROM users WHERE id = $1', [who.id]
)).rows[0];

// A turn from today's web app: it asks, and it sends the device's zone. Los
// Angeles is a zone no developer here is in, so a zone that got through shows
// up as itself rather than passing as this machine's clock.
const ZONE = 'America/Los_Angeles';
const turn = (who) => call('POST', '/api/ai/chat', who, {
  messages: [{ role: 'user', text: "what's the move friday" }],
  consentFlow: 'ask',
  timeZone: ZONE,
});
const prompt = () => chatCreates[0]?.config?.systemInstruction || '';
const nowLine = () => prompt().split('\n').find((l) => l.startsWith('- Now: ')) || '';

function assertZoneWithheld(res) {
  assert.strictEqual(res.status, 200, res.text);
  assert.match(nowLine(), /^- Now: .* UTC\.$/, `the turn was read in a zone: ${nowLine()}`);
  assert.match(prompt(), /You do not know the user's time zone/);
  assert.ok(!JSON.stringify(chatCreates).includes(ZONE), 'the zone reached Gemini under a yes that never named it');
}

function assertZoneRead(res) {
  assert.strictEqual(res.status, 200, res.text);
  assert.match(nowLine(), new RegExp(`, ${ZONE.replace('/', '\\/')} time, where the user is\\.$`), `the zone was not read: ${nowLine()}`);
}

test('the column is a nullable smallint, and every account starts with none on record', async () => {
  const { rows } = await pool.query(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'birdie_ai_consent_copy'`
  );
  assert.deepStrictEqual(rows, [{ data_type: 'smallint', is_nullable: 'YES', column_default: null }]);
  const ava = await user();
  assert.strictEqual((await consentRow(ava)).birdie_ai_consent_copy, null);
});

test('a yes recorded before the question named the time zone keeps the zone out of Gemini', async () => {
  // Every yes given before migration 122 reads like this one: a time and no
  // question. Today's web app never shows such an account the new question,
  // and it sends the zone on every turn.
  const ava = await user();
  await pool.query('UPDATE users SET birdie_ai_consent_at = NOW() WHERE id = $1', [ava.id]);
  assertZoneWithheld(await turn(ava));
});

test('Allow from a client whose question names the zone records it, and the zone is read', async () => {
  const ava = await user();
  const granted = await call('POST', '/api/ai/consent', ava, { copy: 2 });
  assert.strictEqual(granted.status, 200, granted.text);
  assert.strictEqual(granted.body.consented, true);
  const row = await consentRow(ava);
  assert.ok(row.birdie_ai_consent_at instanceof Date);
  assert.strictEqual(row.birdie_ai_consent_copy, 2);
  assertZoneRead(await turn(ava));
});

test('Allow from a client that names no question (App Store 1.0, an older tab) records none', async () => {
  for (const body of [undefined, {}, { copy: null }]) {
    const ava = await user();
    const granted = await call('POST', '/api/ai/consent', ava, body);
    assert.strictEqual(granted.status, 200, granted.text);
    assert.strictEqual((await consentRow(ava)).birdie_ai_consent_copy, null, `${JSON.stringify(body)} recorded a question`);
    chatCreates = [];
    assertZoneWithheld(await turn(ava));
  }
});

test('withdrawing clears the question with the time, so a later yes on an older client inherits nothing', async () => {
  const ava = await user();
  await call('POST', '/api/ai/consent', ava, { copy: 2 });
  const withdrawn = await call('DELETE', '/api/ai/consent', ava);
  assert.strictEqual(withdrawn.status, 200);
  assert.deepStrictEqual(await consentRow(ava), { birdie_ai_consent_at: null, birdie_ai_consent_copy: null });

  await call('POST', '/api/ai/consent', ava);
  const row = await consentRow(ava);
  assert.ok(row.birdie_ai_consent_at instanceof Date);
  assert.strictEqual(row.birdie_ai_consent_copy, null);
  assertZoneWithheld(await turn(ava));
});

test('a repeated yes keeps the first time and the fullest question agreed to', async () => {
  // A yes to the question that names the zone, then one from an older client.
  const ava = await user();
  const first = await call('POST', '/api/ai/consent', ava, { copy: 2 });
  await new Promise((r) => setTimeout(r, 15));
  const again = await call('POST', '/api/ai/consent', ava);
  assert.strictEqual(again.body.consentedAt, first.body.consentedAt);
  assert.strictEqual((await consentRow(ava)).birdie_ai_consent_copy, 2);

  // An earlier yes, then a yes to the question that names it: that one counts.
  const bo = await user();
  const earlier = await call('POST', '/api/ai/consent', bo);
  const named = await call('POST', '/api/ai/consent', bo, { copy: 2 });
  assert.strictEqual(named.body.consentedAt, earlier.body.consentedAt);
  assert.strictEqual((await consentRow(bo)).birdie_ai_consent_copy, 2);
  assertZoneRead(await turn(bo));
});

// No build sends the zone without the flag: the zone joined the turn together
// with the question that names it. A turn made by hand that sends one and
// leaves the flag off is held to the same recorded yes, read on this database.
const unflaggedTurn = (who) => call('POST', '/api/ai/chat', who, {
  messages: [{ role: 'user', text: "what's the move friday" }],
  timeZone: ZONE,
});

test('a turn that sends the zone without the flag gets it only on a yes to the question that names it', async () => {
  const none = await user();
  assertZoneWithheld(await unflaggedTurn(none));

  const earlier = await user();
  assert.strictEqual((await call('POST', '/api/ai/consent', earlier)).status, 200);
  chatCreates = [];
  assertZoneWithheld(await unflaggedTurn(earlier));

  const named = await user();
  assert.strictEqual((await call('POST', '/api/ai/consent', named, { copy: 2 })).status, 200);
  chatCreates = [];
  assertZoneRead(await unflaggedTurn(named));

  // Withdrawn, the zone goes back out with everything else the yes covered.
  assert.strictEqual((await call('DELETE', '/api/ai/consent', named)).status, 200);
  chatCreates = [];
  assertZoneWithheld(await unflaggedTurn(named));
});

test('the question number takes one value, and anything else saves nothing', async () => {
  const ava = await user();
  for (const copy of ['2', 1, 3, 2.5, true, [2], { copy: 2 }]) {
    const res = await call('POST', '/api/ai/consent', ava, { copy });
    assert.strictEqual(res.status, 400, `copy ${JSON.stringify(copy)} was accepted`);
  }
  assert.deepStrictEqual(await consentRow(ava), { birdie_ai_consent_at: null, birdie_ai_consent_copy: null });
});
