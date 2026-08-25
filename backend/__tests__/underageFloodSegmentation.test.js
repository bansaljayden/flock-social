// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// SECURITY-AUDIT-auth.md A5-2 (MEDIUM) — the age gate's memory, re-attacked
// ---------------------------------------------------------------------------
// `8d877c5` replaced `underageAttempts.clear()` with a bounded eviction and
// claimed two properties for the order it chose (expire first, then longest
// remaining lifetime first, over one undivided map):
//
//   1. "every write a flooder makes expires LATER than the block they are
//      aiming at, so their flood evicts itself before their target"
//   2. "the IP blocks survive"
//
// The round-5 audit executed both. (2) held absolutely — 600,000 successive
// refusals never touched an IP block. (1) held for a SINGLE source address and
// FAILED for rotating ones, and the auditor built the counter-example: the
// victim's 24-hour email block was gone after 18,009 refusals.
//
// The mechanism the claim missed is that ONE REFUSAL WRITES TWO ENTRIES. With
// rotating addresses, half of every write is a 15-minute IP entry, and under
// longest-remaining-first those sit at the immune end of one shared ordering.
// So each pass spent its whole 2,000-entry budget on email entries while only
// ~1,000 email entries had arrived since the last one, and the email population
// was eaten backwards, newest to oldest, at a net 1,000 per pass — until it
// reached the oldest entry in the map, which is the victim's.
//
// This file does three things, in this order, because the third is only
// meaningful if the first two are:
//
//   §1  reproduces the auditor's flood against a faithful re-implementation of
//       the PRE-FIX algorithm and pins the number at exactly 18,009, so the
//       test proves the finding as well as the fix;
//   §2  runs the SAME flood, at the same scale and past it, against the real
//       evictUnderageAttempts through routes/auth.js's own __testing exports;
//   §3  pins the properties the comment and the inventory row now claim, and
//       the residual they explicitly do not claim.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests';

const {
  recordUnderageAttempt,
  underageBlocked,
  underageKey,
  evictUnderageAttempts,
  seedUnderageAttempt,
  underageAttemptHas,
  clearUnderageAttempts,
  underageAttemptCount,
  UNDERAGE_EMAIL_TTL_MS,
  UNDERAGE_IP_TTL_MS,
  UNDERAGE_MAX_KEYS,
  UNDERAGE_LOW_WATER,
  UNDERAGE_EMAIL_MAX_KEYS,
  UNDERAGE_EMAIL_LOW_WATER,
  UNDERAGE_IP_MAX_KEYS,
  UNDERAGE_IP_LOW_WATER,
} = require('../routes/auth').__testing;

const T0 = 1700000000000;

// The auditor's flood, as a generator: one refused under-13 signup per step,
// each from a distinct address and a distinct mailbox, which is what the
// attacker is already doing because authLimiter is 10/min per IP.
function rotatingAddress(i) {
  return `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}#${i}`;
}

// ===========================================================================
// §1. THE FINDING, reproduced — the pre-fix algorithm, and the exact number
// ===========================================================================

test('the round-23 eviction really does lose a victim email block at 18,009 rotating refusals', () => {
  // A faithful re-implementation of evictUnderageAttempts as `8d877c5` shipped
  // it: one map, expire-then-longest-remaining-first, low water at 90%, driven
  // through recordUnderageAttempt's own order (evict-if-over, THEN set) so the
  // eviction fires exactly where production fired it.
  const MAX = 20000;
  const LOW = Math.floor(MAX * 0.9);
  const map = new Map();

  function evictOldWay(now) {
    for (const [k, v] of map) if (now >= v) map.delete(k);
    if (map.size <= MAX) return;
    for (const [k] of [...map.entries()].sort((a, b) => b[1] - a[1])) {
      if (map.size <= LOW) break;
      map.delete(k);
    }
  }
  function recordOldWay(email, ip, now) {
    if (map.size > MAX) evictOldWay(now);
    if (email) map.set(`email:${email}`, now + UNDERAGE_EMAIL_TTL_MS);
    if (ip) map.set(`ip:${ip}`, now + UNDERAGE_IP_TTL_MS);
  }

  recordOldWay('victim@example.com', '203.0.113.1', T0);

  let sent = 0;
  for (let i = 0; i < 600000; i++) {
    recordOldWay(`flood-${i}@example.com`, rotatingAddress(i), T0 + 1000 + i);
    sent += 1;
    if (!map.has('email:victim@example.com')) break;
  }

  assert.strictEqual(sent, 18009,
    `the pre-fix eviction lost the victim's email block after ${sent} refusals; the audit `
    + 'measured 18,009. If this number moved, the re-implementation has drifted from what '
    + 'the commit shipped and §2 is no longer testing the same attack.');
  assert.strictEqual(map.has('ip:203.0.113.1'), true,
    "the audit's other half: the IP block was never the reachable one");
});

// ===========================================================================
// §2. THE SAME FLOOD, against the real eviction
// ===========================================================================

test('18,009 rotating-address refusals do not evict the victim email block', () => {
  clearUnderageAttempts();
  recordUnderageAttempt('victim@example.com', '203.0.113.1', T0, { addressProved: true });
  const victimEmail = underageKey('email', 'victim@example.com');
  const victimIp = underageKey('ip', '203.0.113.1');
  assert.strictEqual(underageAttemptHas(victimEmail), true, 'sanity: the block was recorded');

  for (let i = 0; i < 18009; i++) {
    recordUnderageAttempt(`flood-${i}@example.com`, rotatingAddress(i), T0 + 1000 + i);
  }

  const now = T0 + 1000 + 18009;
  assert.strictEqual(underageAttemptHas(victimEmail), true,
    'the flood evicted the victim email block at exactly the scale the audit reported. '
    + 'The two classes are competing for one budget again.');
  assert.strictEqual(underageBlocked('victim@example.com', null, now), true,
    'the block is present but no longer blocking, which is worse than being gone');
  assert.strictEqual(underageAttemptHas(victimIp), true,
    'the IP half was un-floodable before this fix and must not have regressed');
  clearUnderageAttempts();
});

test('the flood does not win by being ten times longer either', () => {
  // 18,009 is where the old algorithm broke, not where the new one does. The
  // point of segmenting is that there is no scale at which it breaks, so the
  // test runs an order of magnitude past the reported number.
  clearUnderageAttempts();
  recordUnderageAttempt('victim@example.com', '203.0.113.1', T0, { addressProved: true });
  const victimEmail = underageKey('email', 'victim@example.com');
  const victimIp = underageKey('ip', '203.0.113.1');

  const FLOOD = 200000;
  for (let i = 0; i < FLOOD; i++) {
    recordUnderageAttempt(`flood-${i}@example.com`, rotatingAddress(i), T0 + 1000 + i);
  }

  assert.strictEqual(underageAttemptHas(victimEmail), true,
    `${FLOOD} rotating-address refusals evicted the victim's email block`);
  assert.strictEqual(underageAttemptHas(victimIp), true,
    `${FLOOD} rotating-address refusals evicted the victim's IP block`);

  // Still bounded, and still not emptied. A control that survives the flood by
  // growing without limit has traded one denial of service for another.
  assert.ok(underageAttemptCount() <= UNDERAGE_MAX_KEYS + 2,
    `the map holds ${underageAttemptCount()} against a ceiling of ${UNDERAGE_MAX_KEYS}`);
  assert.ok(underageAttemptCount() >= UNDERAGE_LOW_WATER,
    `the flood emptied the lockout map (${underageAttemptCount()} entries left)`);
  clearUnderageAttempts();
});

test('an IP flood cannot reach an email block, and an email flood cannot reach an IP block', () => {
  // The two directions of the property the segmentation buys, driven one class
  // at a time so neither result can be explained by the other class filling up.
  clearUnderageAttempts();
  recordUnderageAttempt('victim@example.com', '203.0.113.1', T0, { addressProved: true });
  const victimEmail = underageKey('email', 'victim@example.com');
  const victimIp = underageKey('ip', '203.0.113.1');

  // Addresses only. Twenty times the IP class ceiling.
  for (let i = 0; i < UNDERAGE_IP_MAX_KEYS * 20; i++) {
    recordUnderageAttempt(null, rotatingAddress(i), T0 + 1000 + i);
  }
  assert.strictEqual(underageAttemptHas(victimEmail), true,
    'an address-only flood reached across into the email class');
  assert.strictEqual(underageAttemptHas(victimIp), true,
    "an address-only flood evicted an older address's block");

  clearUnderageAttempts();
  recordUnderageAttempt('victim@example.com', '203.0.113.1', T0, { addressProved: true });
  // Mailboxes only. Twice the email class ceiling.
  for (let i = 0; i < UNDERAGE_EMAIL_MAX_KEYS * 2; i++) {
    recordUnderageAttempt(`only-${i}@example.com`, null, T0 + 1000 + i, { addressProved: true });
  }
  assert.strictEqual(underageAttemptHas(victimIp), true,
    'a mailbox-only flood reached across into the IP class — this is the A5-2 shape, inverted');
  assert.strictEqual(underageAttemptHas(victimEmail), true,
    'a mailbox-only flood evicted an older mailbox block');
  clearUnderageAttempts();
});

// ===========================================================================
// §3. THE CLAIMS, and the residual
// ===========================================================================

test('each class is bounded by its own budget and the two sum to the map ceiling', () => {
  // The equality is load-bearing rather than tidy: it is what guarantees an
  // eviction pass always finds work. Without it a map sitting at
  // email-ceiling + ip-ceiling would sort every entry on every refused signup
  // and delete nothing, which is the CPU lever the low-water rule exists to
  // prevent.
  assert.strictEqual(UNDERAGE_EMAIL_MAX_KEYS + UNDERAGE_IP_MAX_KEYS, UNDERAGE_MAX_KEYS,
    'the class ceilings must sum to the map ceiling, or an eviction pass can run and do nothing');
  assert.ok(UNDERAGE_EMAIL_LOW_WATER < UNDERAGE_EMAIL_MAX_KEYS);
  assert.ok(UNDERAGE_IP_LOW_WATER < UNDERAGE_IP_MAX_KEYS);
  assert.strictEqual(UNDERAGE_LOW_WATER, UNDERAGE_EMAIL_LOW_WATER,
    'the exported low water is the floor a flood cannot push the map below');

  // Headroom in BOTH classes, or the map re-sorts itself every few requests.
  const worstCase = UNDERAGE_EMAIL_MAX_KEYS + UNDERAGE_IP_LOW_WATER;
  assert.ok(UNDERAGE_MAX_KEYS - worstCase >= 1000,
    `only ${UNDERAGE_MAX_KEYS - worstCase} writes between full eviction passes in the worst case`);
});

test('the eviction never spends a deletion on the other class', () => {
  clearUnderageAttempts();
  // Fill the email class past its ceiling with nothing else in the map, then
  // add one IP entry and force a pass. The IP entry is the newest thing in the
  // map, and under the old single ordering it was also the most protected; it
  // must now be neither, it must simply be in a different budget.
  for (let i = 0; i < UNDERAGE_EMAIL_MAX_KEYS + 2500; i++) {
    seedUnderageAttempt(underageKey('email', `seed-${i}@example.com`), T0 + UNDERAGE_EMAIL_TTL_MS + i);
  }
  const lone = underageKey('ip', '198.51.100.9');
  seedUnderageAttempt(lone, T0 + UNDERAGE_IP_TTL_MS);
  evictUnderageAttempts(T0);

  assert.strictEqual(underageAttemptHas(lone), true,
    'the pass deleted an IP entry while the email class was the one over budget');
  assert.ok(underageAttemptCount() <= UNDERAGE_EMAIL_LOW_WATER + 1,
    `the email class was not brought down to its low water (map holds ${underageAttemptCount()})`);
  clearUnderageAttempts();
});

test('the TTLs still expire, and expiry still runs before eviction', () => {
  clearUnderageAttempts();
  recordUnderageAttempt('kid@example.com', '203.0.113.9', T0, { addressProved: true });
  assert.strictEqual(underageBlocked('kid@example.com', null, T0 + 1), true);
  assert.strictEqual(underageBlocked(null, '203.0.113.9', T0 + 1), true);

  // The IP window is deliberately short: signups come off shared school and
  // campus NATs and a long block refuses real 13+ users.
  assert.strictEqual(underageBlocked(null, '203.0.113.9', T0 + UNDERAGE_IP_TTL_MS), false);
  assert.strictEqual(underageBlocked('kid@example.com', null, T0 + UNDERAGE_IP_TTL_MS), true,
    'the mailbox carries the strong signal and must outlive the address');
  assert.strictEqual(underageBlocked('kid@example.com', null, T0 + UNDERAGE_EMAIL_TTL_MS), false);
  clearUnderageAttempts();
});

test('the comment and the inventory row no longer claim the falsified property', () => {
  // A5-2's actual instruction: the code was only half the finding. The other
  // half is that two places in the tree asserted a property the code did not
  // have, and the next round reads those instead of re-deriving the map.
  const authSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  const inventory = fs.readFileSync(
    path.join(__dirname, '..', 'utils', 'cacheKeyInventory.js'), 'utf8');

  const FALSIFIED = /every write a flooder makes (carries a LATER expiry|expires LATER)/i;
  for (const [name, src] of [['routes/auth.js', authSrc], ['utils/cacheKeyInventory.js', inventory]]) {
    const asserted = src
      // The corrected text QUOTES the old claim in order to say it was false.
      // Strip anything within a sentence of "FALSE", "falsified" or "claimed".
      .split(/(?<=\.)\s+/)
      .filter((sentence) => !/fals|claim|round 23 |a5-2/i.test(sentence))
      .join(' ');
    assert.doesNotMatch(asserted, FALSIFIED,
      `${name} still asserts the property the audit falsified at 18,009 requests, outside a `
      + 'sentence that marks it as the old claim');
  }

  // And both must name what replaced it, so the row is checkable rather than
  // merely no longer wrong.
  assert.match(authSrc, /independent|separately|SEPARATE/,
    'routes/auth.js does not say what the new eviction rule is');
  assert.match(inventory, /independent(ly)?-?budget/i,
    'the inventory row does not describe the two-class budget');
});
