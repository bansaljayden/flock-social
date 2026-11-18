// Run: node --test  (from backend/)
//
// A REAL VENUE IS NOT PROFANITY ON THE DM FALLBACK EITHER.
//
// dm_pin_venue and dm_vote_venue screen a venue name and address that arrive
// with a Google place id as Google's text (utils/moderation.js
// moderateVenueText), so "Hell's Kitchen" and "Dick's Sporting Goods" pin and
// vote. Their REST twins, PUT /api/dm/:userId/pinned-venue and POST
// /api/dm/:userId/venue-votes, which the app falls back to when its socket is
// down, still ran the full list, so the same venue was refused only on a bad
// connection, with "That doesn't fit our community guidelines" and nothing to
// rephrase. Flock create, edit and vote were moved over in the first-session
// audit; these two were not.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'dm-venue-rest-provider-names-secret';

const pool = require('../config/database');

let handlers = [];
let log = [];

async function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params: params || [] });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = await fn(params || [], flat);
      return out === undefined ? { rows: [], rowCount: 0 } : out;
    }
  }
  throw new Error(`unscripted query: ${flat.slice(0, 160)}`);
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(String(sql))) return Promise.resolve({ rows: [], rowCount: 0 });
    return dispatch(sql, params);
  },
  release: () => {},
});

const on = (re, fn) => handlers.push([re, fn]);

const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 1, name: 'Ava', email_verified: true, role: 'user' }; next(); };

const pushMod = require('../services/pushHelper');
pushMod.pushIfOffline = async () => ({ skipped: true });
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true });

const { VENUE_REJECTED_MESSAGE } = require('../utils/moderation');
const messagesRouter = require('../routes/messages');

const app = express();
app.use(express.json());
app.set('io', { to: () => ({ emit: () => {} }) });
app.use('/api', messagesRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((r) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); });
}));
test.after(() => new Promise((r) => {
  server.close(() => r());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  // Ava (1) and Cy (7) are friends, with no block and no ban between them.
  on(/FROM user_blocks/, () => ({ rows: [] }));
  on(/SELECT 1 WHERE EXISTS/, () => ({ rows: [{ '?column?': 1 }] }));
  on(/SELECT 1 FROM users WHERE id = \$1 AND is_banned IS TRUE/, () => ({ rows: [] }));
  on(/INSERT INTO dm_pinned_venues/, () => ({ rows: [], rowCount: 1 }));
  on(/pg_advisory_xact_lock/, () => ({ rows: [] }));
  on(/^SELECT id FROM dm_venue_votes/, () => ({ rows: [] }));
  on(/^DELETE FROM dm_venue_votes/, () => ({ rows: [] }));
  on(/^INSERT INTO dm_venue_votes/, () => ({ rows: [], rowCount: 1 }));
  on(/FROM dm_venue_votes vv JOIN users u/, () => ({ rows: [] }));
});

async function call(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: parsed, text };
}

const wrote = (table) => log.filter((q) => new RegExp(`^INSERT INTO ${table}`).test(q.sql));

// A Google place id, by the shape moderateVenueText checks for.
const PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';

test("pinning Google's own venue over REST works, as it does over the socket", async () => {
  const res = await call('PUT', '/api/dm/7/pinned-venue', {
    venue_name: "Hell's Kitchen", venue_address: '1 Butt Rd', venue_id: PLACE_ID,
  });
  assert.strictEqual(res.status, 200, res.text);
  const pin = wrote('dm_pinned_venues');
  assert.strictEqual(pin.length, 1);
  assert.deepStrictEqual(pin[0].params.slice(2, 5), ["Hell's Kitchen", '1 Butt Rd', PLACE_ID]);
});

test("voting for Google's own venue over REST works, as it does over the socket", async () => {
  const res = await call('POST', '/api/dm/7/venue-votes', { venue_name: "Dick's Sporting Goods", venue_id: PLACE_ID });
  assert.strictEqual(res.status, 200, res.text);
  const vote = wrote('dm_venue_votes');
  assert.strictEqual(vote.length, 1);
  assert.deepStrictEqual(vote[0].params.slice(3), ["Dick's Sporting Goods", PLACE_ID]);
});

test('a slur under a place id is still refused on both, with the venue sentence', async () => {
  const pin = await call('PUT', '/api/dm/7/pinned-venue', { venue_name: 'faggot', venue_id: PLACE_ID });
  assert.strictEqual(pin.status, 400);
  assert.strictEqual(pin.body.error, VENUE_REJECTED_MESSAGE);
  const address = await call('PUT', '/api/dm/7/pinned-venue', { venue_name: 'The Fig', venue_address: 'faggot', venue_id: PLACE_ID });
  assert.strictEqual(address.status, 400);
  const vote = await call('POST', '/api/dm/7/venue-votes', { venue_name: 'faggot', venue_id: PLACE_ID });
  assert.strictEqual(vote.status, 400);
  assert.strictEqual(vote.body.error, VENUE_REJECTED_MESSAGE);
  assert.strictEqual(wrote('dm_pinned_venues').length + wrote('dm_venue_votes').length, 0);
});

test('a venue typed with no place id keeps the full list', async () => {
  const pin = await call('PUT', '/api/dm/7/pinned-venue', { venue_name: "Hell's Kitchen" });
  assert.strictEqual(pin.status, 400);
  const vote = await call('POST', '/api/dm/7/venue-votes', { venue_name: "Hell's Kitchen", venue_id: 'abc' });
  assert.strictEqual(vote.status, 400);
  assert.strictEqual(wrote('dm_pinned_venues').length + wrote('dm_venue_votes').length, 0);
});
