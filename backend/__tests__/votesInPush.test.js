// Run: node --test  (from backend/)
//
// routes/venues.js notifyHostVotesIn: the host's push when every other member
// of a plan still being planned has voted.
//
// Only the host can lock a plan in, and services/flockSweep.js cancels a plan
// still in 'planning' twelve hours after its time. No push was vote-related, so
// a host who was not looking missed the moment the group finished, and the plan
// died without anybody deciding to end it.
//
// planFlowRaces.test.js runs the claim against a real Postgres, two last votes
// fired together included. This file pins the rest without a database: the
// words, the rules around the claim, what happens with push switched off, and
// that both vote paths call it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'votes-in-push-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const pool = require('../config/database');

let handlers = [];
let log = [];
function dispatch(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ text, params });
  for (const [re, fn] of handlers) {
    if (re.test(text)) {
      const out = fn(params || [], text);
      return out instanceof Promise ? out : Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  // Anything unmodelled is answered as nothing, not as an error: the push
  // ledger's own writes are fire-and-forget, and this file is not about them.
  return Promise.resolve({ rows: [], rowCount: 0 });
}
pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({ query: dispatch, release() {} });

const firebaseService = require('../services/firebaseService');
let pushEnabled = true;
let sends = [];
firebaseService.isEnabled = () => pushEnabled;
firebaseService.sendPushToUser = async (userId, title, body, data) => {
  sends.push({ userId: Number(userId), title, body, data });
  return { sent: 1, failed: 0 };
};

const venues = require('../routes/venues');
const { notifyHostVotesIn, votesInPush, VOTES_IN_CLAIM_SQL } = venues;

const HOST = 9;
const MEMBER = 2;
const offline = { sockets: { adapter: { rooms: new Map() } } };

function reset() {
  handlers = [];
  log = [];
  sends = [];
  pushEnabled = true;
}
function on(re, fn) { handlers.push([re, fn]); }

// A row the way collectVoteRows hands it over.
const row = (venue_name, member_count, guest_count = 0) => ({
  venue_name, venue_id: null, member_count, guest_count, guest_weight: guest_count, voter_rows: [],
});

// The recipient is visible and in good standing, as pushHelper's gate asks.
function recipientOk() {
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, actor_banned: false, can_see: true }] }));
}

// ── The words ──────────────────────────────────────────────────────────────

test('one venue ahead is named as ahead, and the host is asked to lock it in', () => {
  assert.deepStrictEqual(votesInPush([row('Ramen', 1), row('Kome', 2)], 'Friday'),
    { title: 'The votes are in', body: 'Kome is ahead for Friday. Lock it in?' });
});

test('a tie at the top is said as a tie, never as a leader', () => {
  // Same rule as the vote panel's "Tied" badge: equal totals at the top.
  assert.deepStrictEqual(votesInPush([row('Kome', 2), row('Ramen', 2), row('Tacos', 1)], 'Friday'),
    { title: 'The votes are in', body: 'Kome and Ramen are tied for Friday. Your call.' });
  assert.deepStrictEqual(votesInPush([row('Kome', 1), row('Ramen', 1), row('Tacos', 1)], 'Friday'),
    { title: 'The votes are in', body: '3 places are tied for Friday. Your call.' });
});

test('guest votes count the way the tally counts them', () => {
  // Two guests put Tacos level with Kome's two members; the tally's own rule
  // (equal totals) makes it a tie, not Kome ahead.
  assert.match(votesInPush([row('Kome', 2), row('Tacos', 0, 2)], 'Friday').body, /tied/);
});

test('an unnamed plan still reads as a sentence, and no votes is nothing to say', () => {
  assert.strictEqual(votesInPush([row('Kome', 1)], null).body, 'Kome is ahead for your plan. Lock it in?');
  assert.strictEqual(votesInPush([], 'Friday'), null);
});

test('the words carry no em dash', () => {
  const out = [votesInPush([row('A', 2), row('B', 1)], 'P'), votesInPush([row('A', 1), row('B', 1)], 'P')];
  const EM_DASH = String.fromCharCode(0x2014);
  for (const w of out) assert.ok(!(w.title + w.body).includes(EM_DASH));
});

// ── The claim ──────────────────────────────────────────────────────────────

test('the claim is one statement: planning only, not yet sent, every accepted non-host member voted', () => {
  const sql = VOTES_IN_CLAIM_SQL.replace(/\s+/g, ' ');
  assert.match(sql, /UPDATE flocks f SET votes_in_pushed_at = NOW\(\)/);
  assert.match(sql, /f\.status = 'planning'/);
  assert.match(sql, /f\.votes_in_pushed_at IS NULL/);
  // Somebody other than the host has to be on the plan at all.
  assert.match(sql, /AND EXISTS \( SELECT 1 FROM flock_members m WHERE m\.flock_id = f\.id AND m\.status = 'accepted' AND m\.user_id <> f\.creator_id \)/);
  // And none of them may be missing a vote.
  assert.match(sql, /AND NOT EXISTS \( SELECT 1 FROM flock_members m WHERE m\.flock_id = f\.id AND m\.status = 'accepted' AND m\.user_id <> f\.creator_id AND NOT EXISTS \( SELECT 1 FROM venue_votes v WHERE v\.flock_id = f\.id AND v\.user_id = m\.user_id \) \)/);
  assert.match(sql, /RETURNING f\.creator_id, f\.name/);
});

test('a claim won pushes the host once, naming nobody, typed for the vote panel', async () => {
  reset();
  recipientOk();
  on(/UPDATE flocks f SET votes_in_pushed_at/i, (params) => {
    assert.deepStrictEqual(params, [41]);
    return { rows: [{ creator_id: HOST, name: 'Friday' }], rowCount: 1 };
  });
  const sent = await notifyHostVotesIn(offline, 41, MEMBER, [row('Kome', 2)]);
  assert.strictEqual(sent, true);
  assert.deepStrictEqual(sends.map((s) => [s.userId, s.title, s.body, s.data.type, s.data.flockId]),
    [[HOST, 'The votes are in', 'Kome is ahead for Friday. Lock it in?', 'flock_votes_in', '41']]);
  // No person is named, so no actor rides on the payload for the block gate.
  assert.strictEqual(sends[0].data.fromUserId, undefined);
  assert.strictEqual(sends[0].data.senderId, undefined);
});

test('a claim lost (already sent, not planning, or somebody has not voted) sends nothing', async () => {
  reset();
  on(/UPDATE flocks f SET votes_in_pushed_at/i, () => ({ rows: [], rowCount: 0 }));
  assert.strictEqual(await notifyHostVotesIn(offline, 41, MEMBER, [row('Kome', 2)]), false);
  assert.deepStrictEqual(sends, []);
});

test('the host finishing the vote themselves takes the claim and is not pushed', async () => {
  reset();
  on(/UPDATE flocks f SET votes_in_pushed_at/i, () => ({ rows: [{ creator_id: HOST, name: 'Friday' }], rowCount: 1 }));
  assert.strictEqual(await notifyHostVotesIn(offline, 41, HOST, [row('Kome', 2)]), false);
  assert.ok(log.some((q) => /UPDATE flocks f SET votes_in_pushed_at/i.test(q.text)), 'the claim was taken');
  assert.deepStrictEqual(sends, []);
});

test('with push switched off, nothing touches the database', async () => {
  reset();
  pushEnabled = false;
  assert.strictEqual(await notifyHostVotesIn(offline, 41, MEMBER, [row('Kome', 2)]), false);
  assert.deepStrictEqual(log, []);
  assert.deepStrictEqual(sends, []);
});

test('a failing claim is logged and swallowed: the vote is already committed', async () => {
  reset();
  on(/UPDATE flocks f SET votes_in_pushed_at/i, () => Promise.reject(new Error('connection terminated')));
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    assert.strictEqual(await notifyHostVotesIn(offline, 41, MEMBER, [row('Kome', 2)]), false);
  } finally {
    console.error = realError;
  }
  assert.ok(errors.some((e) => /Votes-in push error/.test(e)));
  assert.deepStrictEqual(sends, []);
});

// ── Both vote paths call it ────────────────────────────────────────────────

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');

test('the REST vote pushes after answering, and only for a vote that changed something', () => {
  const src = read('routes', 'venues.js');
  assert.match(src, /res\.status\(changed \? 201 : 200\)\.json\(\{ vote, votes: tailorVotes\(rows, myInvisible\) \}\);[\s\S]{0,300}if \(changed\) await notifyHostVotesIn\(req\.app\.get\('io'\), flockId, req\.user\.id, rows\);/);
});

test('the socket vote calls the same function, after its tallies go out', () => {
  const src = read('sockets', 'handlers.js');
  assert.match(src, /const \{[^}]*\bnotifyHostVotesIn\b[^}]*\} = require\('\.\.\/routes\/venues'\);/);
  const at = src.indexOf("socket.on('vote_venue'");
  const end = src.indexOf("console.error('vote_venue error:'", at);
  const body = src.slice(at, end);
  const lastEmit = body.lastIndexOf("emit('new_vote'");
  const call = body.indexOf('await notifyHostVotesIn(io, flockId, user.id, rows);');
  assert.ok(call > lastEmit && lastEmit > 0, 'the push is after the live tallies, not before them');
});

test('the type is registered where a tap is routed, and lands on the vote panel', () => {
  const fb = read('services', 'firebaseService.js');
  const scoped = fb.slice(fb.indexOf('const FLOCK_SCOPED_TYPES = new Set('), fb.indexOf(']);', fb.indexOf('const FLOCK_SCOPED_TYPES')));
  assert.match(scoped, /'flock_votes_in'/);
  const view = fb.slice(fb.indexOf('const FLOCK_VIEW = {'), fb.indexOf('function deepLinkPath'));
  assert.match(view, /flock_votes_in: 'votes'/);
  assert.match(read('services', 'pushHelper.js'), /flock_votes_in\s+everyone else in the plan they host has voted/);
});

test('the migration that holds the claim is additive and replay-safe', () => {
  const sql = read('migrations', '099_flock_votes_in_push.sql');
  assert.match(sql, /-- @requires column flocks\.votes_in_pushed_at/);
  assert.match(sql, /ALTER TABLE flocks ADD COLUMN IF NOT EXISTS votes_in_pushed_at TIMESTAMPTZ;/);
  assert.ok(!/DROP|DEFAULT|NOT NULL/i.test(sql.replace(/^--.*$/gm, '')), 'nothing but a nullable column');
  assert.ok(/^[\x00-\x7F]*$/.test(sql), 'ASCII only: the boot-safety server is WIN1252');
});
