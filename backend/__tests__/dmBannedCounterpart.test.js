// Run: node --test __tests__/dmBannedCounterpart.test.js  (from backend/)
//
// A BANNED COUNTERPART CLOSES THE WHOLE DM, THE READS BESIDE THE THREAD TOO.
//
// The thread read (GET /api/dm/:userId) refuses a banned counterpart exactly
// the way it refuses a block, and every DM write door that asks
// hasDmRelationship is told no for one (utils/relationships.js). Three routes
// around the thread stopped at the block check:
//
//   * GET /api/dm/:userId/venue-votes, whose tally names its voters;
//   * GET /api/dm/:userId/pinned-venue, which names whoever pinned it;
//   * POST /api/dm/messages/:id/react, which still wrote a reaction into the
//     banned account's thread and announced it.
//
// So a conversation with a banned account went blank in the thread while the
// strip above it went on serving that account's name and pin. Each refusal is
// pinned beside the ordinary pair, so a gate that refused everybody cannot
// pass, and the ban question is checked to be about the counterpart rather
// than the caller.
//
// No database: pool.query is a strict fixture dispatcher (an unscripted
// statement throws rather than answering empty, so a query nobody modelled
// cannot pass silently) and `io` is a recorder.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'dm-banned-counterpart-test-secret';

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
const on = (re, fn) => handlers.push([re, fn]);

const authMod = require('../middleware/auth');
const AVA = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = AVA; next(); };

const pushMod = require('../services/pushHelper');
pushMod.pushIfOffline = async () => ({ skipped: true });
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true });

const messagesRouter = require('../routes/messages');

const emits = [];
const io = { to: (room) => ({ emit: (event, payload) => emits.push({ room, event, payload }) }) };

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api', messagesRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  emits.length = 0;
});

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

const BO = 7; // the other person in Ava's conversation
const DM_FROM_BO = 55;
const ONE = { rows: [{ '?column?': 1 }], rowCount: 1 };
const NONE = { rows: [], rowCount: 0 };
const REFUSED = { error: 'You can no longer interact with this user.' };

/**
 * @param blocked  the pair's isBlockedBetween answer
 * @param banned   ids counterpartyIsBanned answers yes for. Keyed on the id it
 *                 is asked about, so a route that asked about the CALLER would
 *                 hear "not banned", go on to read, and fail its test.
 */
function script({ blocked = false, banned = [] } = {}) {
  on(/^SELECT 1 FROM user_blocks WHERE \(blocker_id = \$1 AND blocked_id = \$2\)/, () => (blocked ? ONE : NONE));
  on(/^SELECT 1 FROM users WHERE id = \$1 AND is_banned IS TRUE$/, (p) => (banned.includes(Number(p[0])) ? ONE : NONE));
  on(/FROM dm_venue_votes vv JOIN users u ON u\.id = vv\.user_id/, () => ({
    rows: [{ venue_name: 'Kome', venue_id: null, vote_count: 2, voters: ['Ava', 'Bo'] }], rowCount: 1,
  }));
  on(/FROM dm_pinned_venues pv LEFT JOIN users u ON u\.id = pv\.pinned_by/, () => ({
    rows: [{
      venue_name: 'Kome', venue_address: '1 Main St', venue_id: null, venue_rating: null,
      venue_photo_url: null, pinned_by: BO, pinned_by_name: 'Bo',
    }],
    rowCount: 1,
  }));
  on(/^SELECT sender_id, receiver_id FROM direct_messages WHERE id = \$1/, (p) => (
    Number(p[0]) === DM_FROM_BO ? { rows: [{ sender_id: BO, receiver_id: AVA.id }], rowCount: 1 } : NONE
  ));
  on(/^INSERT INTO dm_emoji_reactions/, (p) => ({
    rows: [{ id: 1, dm_id: p[0], user_id: p[1], emoji: p[2] }], rowCount: 1,
  }));
}

const ran = (re) => log.filter((q) => re.test(q.sql));
const banAsks = () => ran(/is_banned IS TRUE$/).map((q) => Number(q.params[0]));

// ---------------------------------------------------------------------------
// 1. The venue-vote tally
// ---------------------------------------------------------------------------

test('the venue-vote tally still reads for an ordinary pair', async () => {
  script();
  const res = await call('GET', `/api/dm/${BO}/venue-votes`);
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.votes[0].voters, ['Ava', 'Bo']);
  assert.deepStrictEqual(banAsks(), [BO], 'the ban question is about the counterpart, never the caller');
});

test('the venue-vote tally is refused for a banned counterpart, as for a block', async () => {
  script({ banned: [BO] });
  const res = await call('GET', `/api/dm/${BO}/venue-votes`);
  assert.strictEqual(res.status, 403, res.text);
  assert.deepStrictEqual(res.body, REFUSED);
  assert.strictEqual(ran(/FROM dm_venue_votes/).length, 0, 'the tally, and the names in it, are never read');
});

test('a blocked pair is refused before the ban is asked, with the same answer', async () => {
  script({ blocked: true });
  const res = await call('GET', `/api/dm/${BO}/venue-votes`);
  assert.strictEqual(res.status, 403, res.text);
  assert.deepStrictEqual(res.body, REFUSED);
  assert.deepStrictEqual(banAsks(), [], 'one refusal is enough; the block is the cheaper question');
  assert.strictEqual(ran(/FROM dm_venue_votes/).length, 0);
});

// ---------------------------------------------------------------------------
// 2. The pinned venue
// ---------------------------------------------------------------------------

test('the pinned venue still reads for an ordinary pair', async () => {
  script();
  const res = await call('GET', `/api/dm/${BO}/pinned-venue`);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.venue.venue_name, 'Kome');
  assert.strictEqual(res.body.venue.pinned_by_name, 'Bo');
  assert.deepStrictEqual(banAsks(), [BO]);
});

test('the pinned venue is refused for a banned counterpart, as for a block', async () => {
  script({ banned: [BO] });
  const res = await call('GET', `/api/dm/${BO}/pinned-venue`);
  assert.strictEqual(res.status, 403, res.text);
  assert.deepStrictEqual(res.body, REFUSED);
  assert.strictEqual(ran(/FROM dm_pinned_venues/).length, 0, 'the pin, and the name on it, are never read');

  handlers = []; log = [];
  script({ blocked: true });
  const blocked = await call('GET', `/api/dm/${BO}/pinned-venue`);
  assert.strictEqual(blocked.status, 403, blocked.text);
  assert.deepStrictEqual(blocked.body, REFUSED, 'the answer this route already gave a block');
});

// ---------------------------------------------------------------------------
// 3. Reactions. The non-participant 404 lives in __tests__/objectAuthz.test.js
//    beside its flock twin; this is the ban half.
// ---------------------------------------------------------------------------

test('a reaction in an ordinary thread still lands and both sides are told', async () => {
  script();
  const res = await call('POST', `/api/dm/messages/${DM_FROM_BO}/react`, { emoji: '🔥' });
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(ran(/^INSERT INTO dm_emoji_reactions/).length, 1);
  assert.deepStrictEqual(emits.map((e) => e.room).sort(), ['user:1', `user:${BO}`]);
  assert.deepStrictEqual(banAsks(), [BO], 'the counterpart is derived from the row, and that is who is asked about');
});

test('a reaction on a banned counterpart\'s DM is refused and announced to nobody', async () => {
  script({ banned: [BO] });
  const res = await call('POST', `/api/dm/messages/${DM_FROM_BO}/react`, { emoji: '🔥' });
  assert.strictEqual(res.status, 403, res.text);
  assert.deepStrictEqual(res.body, REFUSED, 'the same refusal the route gives a block');
  assert.strictEqual(ran(/^INSERT INTO dm_emoji_reactions/).length, 0, 'no reaction row is written');
  assert.deepStrictEqual(emits, [], 'and neither side hears of one');
});

// ---------------------------------------------------------------------------
// 4. Taking a reaction back. The removal is cleanup of your own row and stays
//    allowed whatever the counterpart's standing; the EVENT that tells them is
//    contact, and a banned account gets none, the add route's rule.
// ---------------------------------------------------------------------------

const REMOVE = `/api/dm/messages/${DM_FROM_BO}/react/${encodeURIComponent('🔥')}`;
function scriptRemoval({ removed = true, ...rest } = {}) {
  script(rest);
  on(/^DELETE FROM dm_emoji_reactions/, (p) => (removed
    ? { rows: [{ id: 1, dm_id: p[0], user_id: p[1], emoji: p[2] }], rowCount: 1 }
    : NONE));
}

test('taking a reaction back in an ordinary thread still tells both sides', async () => {
  scriptRemoval();
  const res = await call('DELETE', REMOVE);
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(emits.map((e) => e.room).sort(), ['user:1', `user:${BO}`]);
  assert.deepStrictEqual(banAsks(), [BO], 'asked about the counterpart the row names, never the caller');
});

test('taking a reaction back from a banned counterpart\'s DM works, and only your own devices hear of it', async () => {
  scriptRemoval({ banned: [BO] });
  const res = await call('DELETE', REMOVE);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(ran(/^DELETE FROM dm_emoji_reactions/).length, 1, 'cleanup of your own row is never refused');
  assert.deepStrictEqual(emits.map((e) => e.room), ['user:1'],
    'the event names you and lands in their socket, and they are unreachable everywhere else');
});

test('a removal that removed nothing is a 404, announced to nobody and asked about nobody', async () => {
  scriptRemoval({ removed: false });
  const res = await call('DELETE', REMOVE);
  assert.strictEqual(res.status, 404, res.text);
  assert.deepStrictEqual(emits, []);
  assert.deepStrictEqual(banAsks(), []);
});

test('a ban question that cannot be answered costs the counterpart the event, never the removal', async () => {
  scriptRemoval();
  handlers = handlers.filter(([re]) => !re.test('SELECT 1 FROM users WHERE id = $1 AND is_banned IS TRUE'));
  on(/^SELECT 1 FROM users WHERE id = \$1 AND is_banned IS TRUE$/, () => { throw new Error('users unreadable'); });
  const res = await call('DELETE', REMOVE);
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(emits.map((e) => e.room), ['user:1'], 'when in doubt the counterpart hears nothing');
});
