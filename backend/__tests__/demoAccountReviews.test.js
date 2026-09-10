// Run: node --test  (from backend/)
//
// ─────────────────────────────────────────────────────────────────────────────
// DEMO-ACCOUNT REVIEWS STAY OUT OF EVERYONE ELSE'S VIEW (utils/demoAccounts.js)
// ─────────────────────────────────────────────────────────────────────────────
//
// The recording workflow stages two persistent accounts before it films:
// they become friends, make plans, and post five-star reviews on real bars
// so the venue card is not an empty state on tape. Those reviews are real
// rows in venue_reviews and they were counted like any other, so a scripted
// opinion moved the average that real users compare venues on. DEMO_USER_IDS
// names those accounts; hideDemoReviews(viewer) is the clause every reader
// of venue_reviews adds, and it is empty only when nothing is configured or
// the viewer is one of the demo accounts (the recording itself).
//
// The second half pins the wiring: every review query in the dashboard that
// already carries NOT_OWNER_OF_THE_PLACE carries the demo clause too, so the
// owner's tab, the public card, and the weekly summary cannot disagree.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { demoUserIds, hideDemoReviews } = require('../utils/demoAccounts');

function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DEMO_USER_IDS');
  const before = process.env.DEMO_USER_IDS;
  if (value === undefined) delete process.env.DEMO_USER_IDS; else process.env.DEMO_USER_IDS = value;
  try { return fn(); } finally {
    if (had) process.env.DEMO_USER_IDS = before; else delete process.env.DEMO_USER_IDS;
  }
}

test('unset, there are no demo accounts and no clause: nothing changes', () => {
  withEnv(undefined, () => {
    assert.deepEqual(demoUserIds(), []);
    assert.equal(hideDemoReviews(42), '');
    assert.equal(hideDemoReviews(null), '');
  });
  withEnv('', () => {
    assert.deepEqual(demoUserIds(), []);
    assert.equal(hideDemoReviews(42), '');
  });
});

test('only whole decimal ids inside int4 survive parsing; nothing else can reach a query', () => {
  withEnv(' 98, 99 ,abc,-4,0,7.5,12junk,99,2147483648,;DROP TABLE users;', () => {
    // "7.5" and "12junk" are dropped, not rounded into somebody else's id;
    // 2147483648 does not fit a Postgres int4 and would fail the query;
    // a repeated id is listed once.
    assert.deepEqual(demoUserIds(), [98, 99]);
    const clause = hideDemoReviews(1);
    assert.equal(clause, 'AND vr.user_id <> ALL(ARRAY[98,99]::int[])');
    assert.ok(!/DROP|abc|;|7|junk/.test(clause.replace(/98|99/g, '')));
  });
});

test('a demo account viewing sees demo reviews; anyone else does not', () => {
  withEnv('98,99', () => {
    assert.equal(hideDemoReviews(98), '', 'the recording signs in as 98 and must see its own staging');
    assert.equal(hideDemoReviews('99'), '', 'ids arrive as strings from some callers');
    assert.equal(hideDemoReviews(5), 'AND vr.user_id <> ALL(ARRAY[98,99]::int[])');
    assert.equal(hideDemoReviews(null), 'AND vr.user_id <> ALL(ARRAY[98,99]::int[])', 'a read with no viewer is a public read');
  });
});

test('every dashboard review query that excludes the owner excludes the demo accounts too', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'venueDashboard.js'), 'utf8');
  const owner = src.match(/\$\{NOT_OWNER_OF_THE_PLACE\}/g) || [];
  const demo = src.match(/\$\{hideDemoReviews\((req\.user\.id|null)\)\}/g) || [];
  assert.ok(owner.length >= 5, 'the five review readers are still there');
  // Every carrier of the owner clause carries the demo clause, including the
  // one write that reads a review back: the owner's reply (RETURNING *), which
  // otherwise let an owner answer a review they are not shown.
  assert.equal(demo.length, owner.length, 'one demo clause per owner clause, the reply included');
  assert.match(src, /UPDATE venue_reviews vr SET venue_reply[\s\S]{0,700}\$\{hideDemoReviews\(req\.user\.id\)\}[\s\S]{0,40}RETURNING \*/);
  assert.match(src, /UPDATE venue_reviews vr SET venue_reply[\s\S]{0,400}bu\.is_banned IS TRUE[\s\S]{0,200}\$\{NOT_OWNER_OF_THE_PLACE\}/,
    'the reply refuses a banned author and the owner\'s own review, like the list does');
  assert.match(src, /require\('\.\.\/utils\/demoAccounts'\)/);
  // The clause correlates on `vr`, so every carrier must alias the table that way.
  const carriers = src.split('${hideDemoReviews(').slice(1);
  assert.equal(carriers.length, demo.length);
  for (const after of src.split('${hideDemoReviews(').slice(0, -1)) {
    const tail = after.slice(-900);
    assert.match(tail, /(FROM|UPDATE) venue_reviews vr/, 'the demo clause sits in a query over venue_reviews vr');
  }
});

test('.env.example documents the variable next to the other id list', () => {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert.match(env, /^DEMO_USER_IDS=/m);
  assert.ok(env.indexOf('DEMO_USER_IDS=') > env.indexOf('ADMIN_USER_IDS='));
});
