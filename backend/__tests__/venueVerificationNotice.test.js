// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// A DECISION THE OWNER IS NEVER TOLD IS A QUEUE THAT REFILLS ITSELF.
// ---------------------------------------------------------------------------
// Verification gates the public badge, promotions, review replies and the whole
// Roost advisor, so it is the difference between a claimed listing and a
// working one. Until now the owner learned the outcome by noticing: a verified
// claim simply started working on their next load, and a declined one silently
// put the "Request verification" button back with nothing said.
//
// The declined half is the worse one. From the owner's side, a decline and a
// queue nobody has read yet look identical, so the only rational move left is
// to ask again. A queue that answers by saying nothing trains the people in it
// to re-enter it.
//
// WHAT THE DECLINE EMAIL MUST NOT CARRY is the admin's `reason`. That field is
// written for the next moderator and lands in moderation_actions; it can hold
// an internal note, and a reason for refusing a claim is also a description of
// what a second attempt would need to defeat. The owner gets the outcome and a
// real address to reply to.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'venue-verification-notice-test-secret';

const pool = require('../config/database');
const emailService = require('../services/emailService');

let handlers = [];
let sent = [];

function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = fn(params || [], flat);
      if (out instanceof Error) return Promise.reject(out);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}
pool.query = (sql, params) => dispatch(sql, params);

// Patched on the module object rather than re-required, because routes/admin.js
// holds the module and looks the function up at call time.
emailService.sendEmail = async (msg) => { sent.push(msg); return { sent: true }; };

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 9, name: 'Admin', role: 'admin' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const adminRouter = require('../routes/admin');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((r) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); });
}));
test.after(() => new Promise((r) => server.close(() => r())));

test.beforeEach(() => { handlers = []; sent = []; });

// The verify statement is one query, so one handler answers it. The shape
// mirrors what the real SELECT returns, owner columns included.
const decisionReturns = (row) => [/UPDATE venue_profiles SET verified/, () => ({ rows: [row], rowCount: 1 })];

const OWNER = { owner_email: 'owner@example.com', owner_name: 'Sam' };
const verified = (extra = {}) => ({
  id: 7, business_name: 'The Bird Bar', verified: true,
  google_place_id: 'PLACE_A', conflict_user_id: null, ...OWNER, ...extra,
});
const declined = (extra = {}) => verified({ verified: false, ...extra });

async function decide(body) {
  const res = await fetch(`${base}/api/admin/venues/7/verify`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // The notice is deliberately post-response and unawaited, so the assertions
  // need a turn of the loop before they can see it.
  await new Promise((r) => setImmediate(() => setImmediate(r)));
  return { status: res.status, text };
}

// ---------------------------------------------------------------------------

test('a verified owner is told, and told what it turned on', async () => {
  handlers = [decisionReturns(verified())];
  const res = await decide({ verified: true });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(sent.length, 1, 'the owner was not told their claim was verified');
  assert.strictEqual(sent[0].to, 'owner@example.com');
  assert.match(sent[0].subject, /verified/i);
  // A badge nobody can find is not an outcome. Name what it unlocked.
  assert.match(sent[0].text, /promotions/i);
  assert.match(sent[0].text, /Roost/);
});

test('a declined owner is told, so they do not simply ask again', async () => {
  handlers = [decisionReturns(declined())];
  const res = await decide({ verified: false });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(sent.length, 1, 'a decline was silent, which is what made the queue refill');
  assert.strictEqual(sent[0].to, 'owner@example.com');
  // And it has to offer a way back, or it is a wall rather than a decision.
  assert.match(sent[0].text, /reply to this email/i);
});

test('the decline never repeats the moderator note back to the person it is about', async () => {
  // reason lands in moderation_actions and is written for the next moderator.
  // It can carry an internal note, and it is also a description of what a
  // second attempt would need to defeat.
  const note = 'SECRETMODERATORNOTE looks like a squatter, no evidence of operating';
  handlers = [decisionReturns(declined())];
  await decide({ verified: false, reason: note });
  assert.strictEqual(sent.length, 1);
  const blob = `${sent[0].subject} ${sent[0].text} ${sent[0].html}`;
  assert.ok(!blob.includes('SECRETMODERATORNOTE'),
    'the admin note reached the venue owner, which leaks an internal comment and the rubric at once');
  assert.ok(!/squatter/i.test(blob), 'the moderator wording reached the owner');
});

test('an owner with no mailable address is a logged skip, not a failed decision', async () => {
  handlers = [decisionReturns(declined({ owner_email: null, owner_name: null }))];
  const res = await decide({ verified: false });
  assert.strictEqual(res.status, 200, 'the decision itself is committed and must still answer 200');
  assert.strictEqual(sent.length, 0);
});

test('a mail failure does not turn a committed decision into an error', async () => {
  // The write and the audit row are already in. Answering 500 here would invite
  // the admin to click it a second time on a claim that was already decided.
  const boom = emailService.sendEmail;
  emailService.sendEmail = async () => { throw new Error('resend is down'); };
  try {
    handlers = [decisionReturns(verified())];
    const res = await decide({ verified: true });
    assert.strictEqual(res.status, 200, res.text);
    assert.match(res.text, /"verified":true/);
  } finally {
    emailService.sendEmail = boom;
  }
});

test('a refused conflict tells nobody, because nothing was decided', async () => {
  // id null is the UPDATE not firing: another account already holds the place.
  handlers = [decisionReturns({
    id: null, business_name: null, verified: null,
    google_place_id: 'PLACE_A', conflict_user_id: 42, ...OWNER,
  })];
  const res = await decide({ verified: true });
  assert.strictEqual(res.status, 409, res.text);
  assert.strictEqual(sent.length, 0,
    'an owner was emailed about a decision that was refused and never happened');
});
