// Run: node --test  (from backend/)
//
// ONE LOCKED-OUT PUSH PER ADDRESS (2026-11-15).
//
// The locked-out push went out once a day, and from 2026-11-10 it was the same
// bounced address of our own every day. Now it is one push per address for as
// long as the address stays on the do-not-mail list. Pinned:
//   1. The first refusal of an address pushes, and marks the address once the
//      push reached somebody.
//   2. A later refusal of a marked address, on any day and after any deploy,
//      does not push.
//   3. A marked address does not hold the retry window, so a NEW address
//      refused right after it still pushes.
//   4. No mark when the push reached nobody, or when today's one push had
//      already gone out (it may have named another address).
//   5. A failed read pushes anyway; the other alarm kinds never read the list.
//   6. The column is migration 139, and the push says it is the only one.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pool = require('../config/database');
const suppression = require('../services/emailSuppression');
const ops = require('../services/opsAlert');
const emailService = require('../services/emailService');

const realSent = suppression.lockoutAlarmSent;
const realMark = suppression.markLockoutAlarmSent;

const marked = new Set();
const reads = [];
let opsAnswer = () => ({ sent: true, legs: ['push'] });
const pages = [];
ops.opsAlert = async (args) => { pages.push(args); return opsAnswer(args); };
suppression.checkSendAllowed = async () => ({ blocked: true, reason: 'bounce' });
suppression.lockoutAlarmSent = async (addr) => { reads.push(addr); return marked.has(addr); };
suppression.markLockoutAlarmSent = async (addr) => { marked.add(addr); return true; };

function fresh() {
  // A new day, or a fresh boot: the in-memory gates are gone, the marks are
  // in the database and stay.
  emailService.resetEmailHealth();
  pages.length = 0;
  reads.length = 0;
  opsAnswer = () => ({ sent: true, legs: ['push'] });
}

async function refuse(to) {
  const error = console.error;
  const warn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    await emailService.sendEmail({ to, subject: 'Hello', text: 'Hello', purpose: 'the Roost pricing notice' });
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    console.error = error;
    console.warn = warn;
  }
}

test('the first refusal of an address pushes and marks it', async () => {
  marked.clear();
  fresh();
  await refuse('venue@example.com');
  assert.strictEqual(pages.length, 1);
  assert.ok(marked.has('venue@example.com'));
});

test('a marked address never pushes again, on a later day or after a deploy', async () => {
  marked.clear();
  marked.add('venue@example.com');
  for (let day = 0; day < 3; day += 1) {
    fresh();
    await refuse('venue@example.com');
    assert.strictEqual(pages.length, 0, `day ${day} pushed about an address the admins were already told about`);
  }
});

test('a marked address does not hold the retry window from a new one', async () => {
  marked.clear();
  marked.add('venue@example.com');
  fresh();
  await refuse('venue@example.com');
  await refuse('new@example.com');
  assert.strictEqual(pages.length, 1, 'the new address waited behind the old one');
  assert.ok(marked.has('new@example.com'));
});

test('a new address refused while a marked one is still being looked up still pushes', async () => {
  marked.clear();
  marked.add('venue@example.com');
  fresh();
  const realLookup = suppression.lockoutAlarmSent;
  let release;
  const slow = new Promise((r) => { release = r; });
  suppression.lockoutAlarmSent = async (addr) => {
    reads.push(addr);
    if (addr === 'venue@example.com') await slow;
    return marked.has(addr);
  };
  const error = console.error;
  const warn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    const send = (to) => emailService.sendEmail({ to, subject: 'Hello', text: 'Hello', purpose: 'the Roost pricing notice' });
    // The marked address's lookup is still out when the new one is refused.
    await send('venue@example.com');
    await send('new@example.com');
    await new Promise((r) => setTimeout(r, 10));
    release();
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    suppression.lockoutAlarmSent = realLookup;
    console.error = error;
    console.warn = warn;
  }
  assert.strictEqual(pages.length, 1, 'the new address was turned away by the marked one');
  assert.ok(marked.has('new@example.com'));
});

test('a push that reached nobody leaves the address unmarked', async () => {
  marked.clear();
  fresh();
  opsAnswer = () => ({ failed: true });
  await refuse('venue@example.com');
  assert.strictEqual(pages.length, 1);
  assert.ok(!marked.has('venue@example.com'), 'marked although nobody was told');
});

test('a day whose push already went out leaves this address its turn later', async () => {
  marked.clear();
  fresh();
  opsAnswer = () => ({ skipped: 'already-sent-today' });
  await refuse('second@example.com');
  assert.ok(!marked.has('second@example.com'));
  fresh();
  await refuse('second@example.com');
  assert.strictEqual(pages.length, 1);
  assert.ok(marked.has('second@example.com'));
});

test('the other alarm kinds never read the do-not-mail list', async () => {
  fresh();
  const error = console.error;
  console.error = () => {};
  try {
    emailService.raiseEmailAlarm('failing', 'the last 5 outbound emails all failed', { consecutiveFailures: 5 });
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    console.error = error;
  }
  assert.strictEqual(pages.length, 1);
  assert.strictEqual(reads.length, 0);
});

test('the read fails toward a push, and the mark is written once', async () => {
  const realQuery = pool.query;
  const sql = [];
  const error = console.error;
  console.error = () => {};
  try {
    pool.query = async () => { throw new Error('connection terminated'); };
    assert.strictEqual(await realSent('Venue@Example.com'), false);
    assert.strictEqual(await realMark('Venue@Example.com'), false);
    pool.query = async (text, params) => {
      sql.push({ text: String(text).replace(/\s+/g, ' '), params });
      return { rows: [{ alarmed_at: '2026-11-15T12:00:00Z' }] };
    };
    assert.strictEqual(await realSent(' Venue@Example.com '), true);
    assert.strictEqual(await realMark('Venue@Example.com'), true);
  } finally {
    pool.query = realQuery;
    console.error = error;
  }
  assert.deepStrictEqual(sql.map((q) => q.params), [['venue@example.com'], ['venue@example.com']]);
  assert.match(sql[1].text, /SET alarmed_at = NOW\(\) WHERE email = \$1 AND alarmed_at IS NULL/);
});

test('migration 139 adds the column and the push says it is the only one', async () => {
  const file = fs.readFileSync(path.join(__dirname, '..', 'migrations', '139_email_suppressions_alarmed_at.sql'), 'utf8');
  assert.match(file, /^-- @requires column email_suppressions\.alarmed_at/);
  assert.match(file, /ALTER TABLE email_suppressions ADD COLUMN IF NOT EXISTS alarmed_at TIMESTAMPTZ;/);
  assert.ok(/^[\x00-\x7F]*$/.test(file), 'migration 139 must stay ASCII');

  marked.clear();
  fresh();
  await refuse('venue@example.com');
  const { push } = pages[0];
  assert.match(push.body, /One push per address\.$/);
  assert.ok(push.body.length <= ops.PUSH_BODY_MAX, `push body is ${push.body.length} characters`);
});
