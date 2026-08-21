// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// SECURITY-AUDIT-money.md M5-1 (MEDIUM) — the sentence and the numbers now agree
// ---------------------------------------------------------------------------
// `8d877c5` gave every unauthenticated Places door a per-IP gate and a daily
// sub-ceiling, and its message concluded: the three "now sum to 2700 against
// 3000, so they cannot starve the signed in product".
//
// The arithmetic is true. The conclusion was not. 2700 of 3000 is 90%, so once
// the public surfaces had spent their sub-ceilings the entire authenticated
// product — venue search, the crowd card, the owner dashboard, Birdie — was
// left 300 paid Places calls for the rest of the UTC day, which is ten
// accounts' hourly allowance. The audit priced reaching it at about 40 source
// addresses sustained for an hour: 5 at the photo proxy's 300/IP/hr, 5 at the
// badge's 120/IP/hr, 30 at the demo's 20/IP/hr.
//
// THE CHOICE MADE HERE was to lower the unauthenticated ceiling rather than to
// soften the sentence, because the property the sentence describes is one worth
// having and it was nearly free. It is lowered in ONE place instead of three:
// three constants in three route files is an invariant maintained by hand, and
// a fourth unauthenticated door added later would inherit nothing from it.
// UNAUTH_DAILY sits in allowGlobalPlacesCall, which is the only entry point a
// caller with no account has, so the reserve holds however many doors there are.
//
// THE SHARE: 1800 unauthenticated / 1200 reserved, i.e. 60/40.
//   * Upward, 1800 was pinned by the photo proxy's PUBLIC_PHOTO_BUDGET = 1500:
//     a sub-ceiling above the ceiling it sits under never binds — that was
//     round 23's own finding about that same constant at 4000 — so the
//     aggregate has to stay strictly above the largest per-door number or it
//     silently repeals the per-address work those numbers are doing. 1800 is
//     the smallest round number that clears 1500, so it was the LARGEST reserve
//     available without breaking a control that already existed. That upward
//     constraint has since RELAXED rather than moved: the photo door's daily
//     brake is derived from a dollar budget in services/photoStore.js and is
//     now a few hundred, not 1500, so 1800 has more room under it than the
//     number it was chosen against.
//   * Downward, 1200 reserved is 40 account-hours at PER_USER_HOURLY = 30, or
//     roughly 240 real sessions a day behind the 5- and 10-minute response
//     caches, against an authenticated population currently two orders of
//     magnitude below that.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || 'test-places-key';

const {
  allowPlacesSearch,
  allowGlobalPlacesCall,
  placesBudgetStatus,
  __resetPlacesBudget,
  PER_USER_HOURLY,
  GLOBAL_DAILY,
  UNAUTH_DAILY,
} = require('../utils/placesBudget');

const BACKEND = path.join(__dirname, '..');
const readSrc = (...p) => fs.readFileSync(path.join(BACKEND, ...p), 'utf8');

// ===========================================================================
// 1. THE EXPLOIT, PINNED AS REFUSED
// ===========================================================================

test('an unauthenticated flood cannot take the day down to 300 calls', () => {
  __resetPlacesBudget();

  // The audit's attack, reduced to what it actually does to the ledger: spend
  // through the doors with no account until they are refused. It does not
  // matter here how many addresses that took, because the reserve does not
  // depend on the address count — that is the point of moving the control off
  // the per-door sub-ceilings.
  let spent = 0;
  while (allowGlobalPlacesCall(1)) spent += 1;

  assert.strictEqual(spent, UNAUTH_DAILY,
    `the unauthenticated doors spent ${spent} of the day; the aggregate ceiling is ${UNAUTH_DAILY}`);

  const left = placesBudgetStatus(1).globalRemaining;
  assert.strictEqual(left, GLOBAL_DAILY - UNAUTH_DAILY,
    `the signed-in product was left ${left} paid Places calls, not the reserved `
    + `${GLOBAL_DAILY - UNAUTH_DAILY}`);
  assert.ok(left >= 1000,
    `a reserve of ${left} is not a defensible share of a ${GLOBAL_DAILY}-call day`);

  // And the reserve is genuinely spendable, not merely counted: real accounts
  // can still buy every call of it after the flood.
  let reserveSpent = 0;
  for (let id = 1; id <= Math.ceil(left / PER_USER_HOURLY) + 2; id++) {
    while (allowPlacesSearch(id, 1)) reserveSpent += 1;
  }
  assert.strictEqual(reserveSpent, left,
    'the reserve was counted but not reachable by authenticated callers');
  assert.strictEqual(placesBudgetStatus(1).globalRemaining, 0);
});

test('the reserve is a floor, not a quota: the product may still spend the whole day', () => {
  // The ceiling runs one way on purpose. Refusing an authenticated caller in
  // order to hold calls back for the badge would be the wrong trade — this is a
  // reserve for the product, not a reservation against it.
  __resetPlacesBudget();
  let spent = 0;
  for (let id = 1; id <= GLOBAL_DAILY / PER_USER_HOURLY; id++) {
    while (allowPlacesSearch(id, 1)) spent += 1;
  }
  assert.strictEqual(spent, GLOBAL_DAILY,
    'authenticated callers must be able to reach the whole invoice ceiling');
  assert.strictEqual(allowGlobalPlacesCall(1), false,
    'and an unauthenticated door must then be refused, because the ledger is shared');
});

test('a refused unauthenticated call is charged nothing on either counter', () => {
  __resetPlacesBudget();
  while (allowGlobalPlacesCall(1));
  const before = placesBudgetStatus(1);
  assert.strictEqual(allowGlobalPlacesCall(1), false);
  assert.strictEqual(allowGlobalPlacesCall(5), false);
  const after = placesBudgetStatus(1);
  assert.strictEqual(after.globalUsed, before.globalUsed, 'a refused call moved the invoice counter');
  assert.strictEqual(after.unauthUsed, before.unauthUsed, 'a refused call moved the unauthenticated counter');
});

test('a multi-unit charge is all-or-nothing against the unauthenticated ceiling too', () => {
  __resetPlacesBudget();
  // Walk to one unit short of the ceiling, then ask for two.
  while (placesBudgetStatus(1).unauthRemaining > 1) allowGlobalPlacesCall(1);
  assert.strictEqual(placesBudgetStatus(1).unauthRemaining, 1);
  assert.strictEqual(allowGlobalPlacesCall(2), false, 'a charge that does not fit must be refused whole');
  assert.strictEqual(placesBudgetStatus(1).unauthRemaining, 1, 'a refused charge partially charged');
  assert.strictEqual(allowGlobalPlacesCall(1), true, 'the last unit is still spendable');
  assert.strictEqual(placesBudgetStatus(1).unauthRemaining, 0);
});

test('an unauthenticated call charges BOTH counters, so the invoice ceiling still covers it', () => {
  // The failure this guards against is the obvious one: a reserve implemented
  // by giving the unauthenticated doors their own budget INSTEAD of the shared
  // one would take them back off the invoice ledger, which is the thing round
  // 23 wired up in the first place.
  __resetPlacesBudget();
  assert.strictEqual(allowGlobalPlacesCall(3), true);
  const s = placesBudgetStatus(1);
  assert.strictEqual(s.globalUsed, 3, 'an unauthenticated call must still count against the invoice');
  assert.strictEqual(s.unauthUsed, 3);
  assert.strictEqual(allowPlacesSearch(1, 1), true);
  assert.strictEqual(placesBudgetStatus(1).globalUsed, 4, 'both doors count into one ledger');
  assert.strictEqual(placesBudgetStatus(1).unauthUsed, 3,
    'an AUTHENTICATED call must not consume the unauthenticated share');
});

test('the UTC day rolls both counters, not one', () => {
  // A reserve that resets on a different schedule than the ceiling it sits
  // inside is a reserve that disappears for part of every day.
  __resetPlacesBudget();
  while (allowGlobalPlacesCall(1));
  assert.strictEqual(placesBudgetStatus(1).unauthRemaining, 0);
  __resetPlacesBudget({ keepUsers: true }); // what a real 00:00 UTC does
  const s = placesBudgetStatus(1);
  assert.strictEqual(s.unauthRemaining, UNAUTH_DAILY);
  assert.strictEqual(s.globalRemaining, GLOBAL_DAILY);
});

// ===========================================================================
// 2. THE NUMBERS THE CLAIM RESTS ON
// ===========================================================================

test('every per-door sub-ceiling still binds strictly under the aggregate', () => {
  // This is the constraint that chose 1800. A per-door number above the
  // aggregate would never be reached, which quietly removes the per-address
  // control it represents — round 23's exact finding about PUBLIC_PHOTO_BUDGET
  // at 4000 under a 3000 ceiling.
  const badge = require('../routes/badge').__test;
  const vs = require('../routes/venueSearch').__test;

  const demoSrc = readSrc('routes', 'publicCrowd.js');
  const demoLeg = demoSrc.match(/dayCount\s*>=\s*(\d+)/);
  assert.ok(demoLeg, 'routes/publicCrowd.js no longer declares a daily demo leg');
  const DEMO_DAILY = Number(demoLeg[1]);

  for (const [name, value] of [
    ['BADGE_DAILY', badge.BADGE_DAILY],
    ['the photo proxy daily brake', require('../services/photoStore').PHOTO_FETCH_BURST_PER_DAY],
    ['DEMO_DAILY', DEMO_DAILY],
  ]) {
    assert.ok(value < UNAUTH_DAILY,
      `${name} (${value}) is not under UNAUTH_DAILY (${UNAUTH_DAILY}); a sub-ceiling above the `
      + 'ceiling it sits under never binds, so its per-address gate stops being reachable');
  }

  assert.ok(UNAUTH_DAILY < GLOBAL_DAILY,
    'the unauthenticated share must be a share');
  assert.strictEqual(GLOBAL_DAILY - UNAUTH_DAILY, 1200);
});

test('the claim in the source says what the code does', () => {
  // M5-1 was as much about the sentence as the numbers, and the sentence is
  // what the next round reads. It must not be possible to leave the two
  // disagreeing again by editing only one of them.
  const src = readSrc('utils', 'placesBudget.js');
  assert.match(src, /M5-1/, 'placesBudget.js does not name the finding it answers');
  assert.match(src, new RegExp(`UNAUTH_DAILY\\s*=\\s*${UNAUTH_DAILY}`),
    'the header block does not state UNAUTH_DAILY as the code sets it');

  // The falsified sentence, or any restatement of it that leans on the sum of
  // the three per-door numbers rather than on the aggregate ceiling.
  const asserted = src
    .split(/(?<=\.)\s+/)
    .filter((sentence) => !/M5-1|was not|used to be wrong|round 23/i.test(sentence))
    .join(' ');
  assert.doesNotMatch(asserted, /2700\s*<\s*3000/,
    'placesBudget.js still argues the reserve from 600 + 1500 + 600 rather than from UNAUTH_DAILY');

  const inventory = readSrc('utils', 'cacheKeyInventory.js');
  assert.match(inventory, /unauthDayCount/,
    'the inventory has no row for the counter that enforces the reserve');
});
