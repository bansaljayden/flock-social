// Run: node --test  (from backend/)
//
// MONEY. Google Cloud Vision SafeSearch was the one paid upstream in this repo
// with neither a per-account daily ceiling nor a global one
// (SECURITY-AUDIT-money.md round 3, M3-2). Its only control was the 10-billed-
// images-per-60-seconds limiter in server.js, which sustained is ~14,400 calls
// per account per day — about $21.60/day/account — multiplied by however many
// accounts an attacker cared to create, with nothing capping the total and
// nothing reporting it. The cheapest door was an avatar change on the
// attacker's own account.
//
// This file pins the two ceilings that close it, the order they bite in, the
// arithmetic the dollar figures come from, and — the part that matters most —
// that running out of MONEY refuses the upload rather than letting an
// unscreened image through.
const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');

// Before requiring utils/moderation: the provider-configured flag is read at
// module load, and this file needs the billed path to be live.
process.env.VISION_API_KEY = 'vision-budget-test-key';
process.env.IMAGE_MODERATION_REQUIRED = 'true';

const visionBudget = require('../utils/visionBudget');
const {
  allowVisionCall,
  visionBudgetStatus,
  __resetVisionBudget,
  VISION_USER_HOURLY,
  VISION_USER_DAILY,
  VISION_GLOBAL_DAILY,
  VISION_UNIT_PRICE_USD,
} = visionBudget;

const moderation = require('../utils/moderation');

// A real 1x1 PNG, so the data-URL → Blob conversion and the frame inspection
// both run for real and the only thing stubbed is the provider itself.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const CLEAN = { adult: 'VERY_UNLIKELY', racy: 'UNLIKELY', violence: 'VERY_UNLIKELY', medical: 'VERY_UNLIKELY' };

const realFetch = global.fetch;
let visionCalls = 0;
function stubCleanVision() {
  visionCalls = 0;
  global.fetch = async () => {
    visionCalls += 1;
    return { ok: true, json: async () => ({ responses: [{ safeSearchAnnotation: CLEAN }] }) };
  };
}

// console.error is the exhaustion channel, so several tests read it rather than
// merely tolerating it.
const realError = console.error;
let errorLines = [];
function captureErrors() {
  errorLines = [];
  console.error = (...args) => { errorLines.push(args.join(' ')); };
}

test.beforeEach(() => {
  __resetVisionBudget();
  visionCalls = 0;
  errorLines = [];
});

test.afterEach(() => {
  global.fetch = realFetch;
  console.error = realError;
  mock.timers.reset();
});

// ---------------------------------------------------------------------------
// 1. The arithmetic in the comment is the arithmetic in the code
// ---------------------------------------------------------------------------
// The ceilings only mean anything as dollar figures, and a comment that drifts
// from its constants is worse than no comment. These assertions are the sums
// utils/visionBudget.js states, executed.

test('the unit price and both ceilings produce the dollar figures the file claims', () => {
  assert.strictEqual(VISION_UNIT_PRICE_USD, 0.0015, 'SafeSearch bills $1.50 per 1,000 images');

  // Global: 2000 x $0.0015 = $3.00/day for the WHOLE process, ~$90/month.
  assert.strictEqual(Number((VISION_GLOBAL_DAILY * VISION_UNIT_PRICE_USD).toFixed(2)), 3.00);

  // Per account: 60 x $0.0015 = $0.09/day, down from ~$21.60.
  assert.strictEqual(Number((VISION_USER_DAILY * VISION_UNIT_PRICE_USD).toFixed(2)), 0.09);

  // What it was before: 10 per 60s sustained is 14,400 calls a day.
  const OLD_CEILING_PER_DAY = 10 * 60 * 24;
  assert.strictEqual(Number((OLD_CEILING_PER_DAY * VISION_UNIT_PRICE_USD).toFixed(2)), 21.60);
  assert.ok(VISION_USER_DAILY < OLD_CEILING_PER_DAY / 200,
    'the per-account daily ceiling must be at least two orders of magnitude below what it replaced');

  const status = visionBudgetStatus();
  assert.strictEqual(status.limits.globalDailyMaxSpendUsd, 3.00);
  assert.strictEqual(status.limits.perUserDailyMaxSpendUsd, 0.09);
  assert.strictEqual(status.inMemory, true, 'the numbers must never be read without the caveat');
});

test('the two invariants hold: per-account below global, hour below day', () => {
  assert.ok(VISION_USER_DAILY < VISION_GLOBAL_DAILY,
    'one account must not be able to consume the whole global allowance');
  assert.ok(VISION_USER_HOURLY < VISION_USER_DAILY,
    'a single hour must not be able to spend the day');

  // How many accounts it now takes to reach the global ceiling. One, before.
  const accountsNeeded = Math.ceil(VISION_GLOBAL_DAILY / VISION_USER_DAILY);
  assert.ok(accountsNeeded >= 30,
    `it should take dozens of accounts to exhaust the day, not ${accountsNeeded}`);
});

// ---------------------------------------------------------------------------
// 2. The per-account ceiling bites BEFORE the global one
// ---------------------------------------------------------------------------
// This is the dimension the audit says Places lacks. If the global ceiling were
// the first to bite, one account could still take the whole day away from
// everybody else — which is the round-2 Ticketmaster attack, in a new upstream.

test('one account is stopped by its OWN ceiling long before the global one moves', () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-18T09:00:00Z') });

  for (let i = 0; i < VISION_USER_HOURLY; i++) {
    assert.strictEqual(allowVisionCall(42).allowed, true, `call ${i + 1} should pass`);
  }
  const refused = allowVisionCall(42);
  assert.strictEqual(refused.allowed, false);
  assert.strictEqual(refused.scope, 'account',
    'the ACCOUNT leg must be the one that refuses, not the global leg');

  const status = visionBudgetStatus(42);
  assert.strictEqual(status.globalUsed, VISION_USER_HOURLY);
  assert.ok(status.globalRemaining > VISION_GLOBAL_DAILY * 0.9,
    'a single account burning out must barely dent the global allowance');
});

test('a refused call costs the caller nothing and the global counter nothing', () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-18T09:00:00Z') });
  for (let i = 0; i < VISION_USER_HOURLY; i++) allowVisionCall(7);
  const before = visionBudgetStatus(7).globalUsed;
  for (let i = 0; i < 50; i++) assert.strictEqual(allowVisionCall(7).allowed, false);
  assert.strictEqual(visionBudgetStatus(7).globalUsed, before,
    'refusals must not charge the global ledger — otherwise a throttled account still spends the day');
});

test('the per-account DAY ceiling holds once the rolling hour has drained', () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-18T09:00:00Z') });

  for (let i = 0; i < VISION_USER_HOURLY; i++) assert.strictEqual(allowVisionCall(99).allowed, true);
  assert.strictEqual(allowVisionCall(99).allowed, false, 'hour one is spent');

  // An hour later the rolling hour is empty, but the day is not.
  mock.timers.setTime(new Date('2026-08-18T10:01:00Z').getTime());
  for (let i = 0; i < VISION_USER_HOURLY; i++) {
    assert.strictEqual(allowVisionCall(99).allowed, true, `hour two, call ${i + 1}`);
  }

  mock.timers.setTime(new Date('2026-08-18T11:02:00Z').getTime());
  const refused = allowVisionCall(99);
  assert.strictEqual(refused.allowed, false, 'the DAY ceiling must bite even with an empty hour');
  assert.strictEqual(refused.scope, 'account');
  assert.strictEqual(visionBudgetStatus(99).globalUsed, VISION_USER_DAILY,
    'the account spent exactly its daily allowance and not one call more');
});

test('a malformed account id is refused rather than handed a free lane', () => {
  // Same rule as placesBudget.keyOf and createUserBudget.keyOf: an id that is
  // supplied but is not a positive integer fails CLOSED. Omitting it entirely
  // is a different thing (background callers) and is tested below.
  captureErrors();
  for (const bad of [0, -1, 1.5, '', 'abc', true, [9], {}, NaN]) {
    const res = allowVisionCall(bad);
    assert.strictEqual(res.allowed, false, `${String(bad)} must not buy a screen`);
    assert.strictEqual(res.scope, 'identity',
      'a bad id is a broken caller, not a spent budget, and the two must not be reported as one');
  }
  assert.strictEqual(visionBudgetStatus().globalUsed, 0);
  assert.match(errorLines[0], /unusable account id/,
    'logging this as "account 0 exhausted its budget" would send an operator hunting a user that does not exist');
});

test('a caller with no account at all charges the global leg only', () => {
  // services/mlPredictor.js's allowEventFetch treats background producers the
  // same way. It is what keeps not-yet-wired call sites working while still
  // capping the process-wide bill.
  for (let i = 0; i < 100; i++) assert.strictEqual(allowVisionCall().allowed, true);
  assert.strictEqual(visionBudgetStatus().globalUsed, 100);
});

// ---------------------------------------------------------------------------
// 3. The global ceiling, and what happens at it
// ---------------------------------------------------------------------------

test('the global ceiling refuses everyone once the day is spent, including a fresh account', () => {
  captureErrors();
  for (let i = 0; i < VISION_GLOBAL_DAILY; i++) allowVisionCall();
  assert.strictEqual(visionBudgetStatus().globalRemaining, 0);

  const refused = allowVisionCall(12345);           // an account that has spent nothing
  assert.strictEqual(refused.allowed, false);
  assert.strictEqual(refused.scope, 'global');
  assert.strictEqual(visionBudgetStatus(12345).userRemaining.daily, VISION_USER_DAILY,
    'the global refusal must not have eaten one of that account\'s units');
});

// ---------------------------------------------------------------------------
// 4. A normal user is nowhere near either ceiling
// ---------------------------------------------------------------------------
// A ceiling that a real user can reach is an outage, not a control. The app has
// ~14 users; an avatar change is a once-in-a-while action and chat photos are
// the volume.

test('a heavy real day for one user leaves most of their allowance unspent', () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-18T20:00:00Z') });
  // Twelve photos across a flock chat and a DM thread, plus an avatar change.
  for (let i = 0; i < 13; i++) assert.strictEqual(allowVisionCall(3).allowed, true);
  const left = visionBudgetStatus(3).userRemaining;
  assert.ok(left.daily >= VISION_USER_DAILY - 13);
  assert.ok(left.daily > VISION_USER_DAILY / 2, 'a heavy real day must not get close to the ceiling');
});

test('the whole current user base on a heavy day is a small fraction of the global ceiling', () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-18T20:00:00Z') });
  const USERS = 14;          // the real number today
  const PER_USER = 8;        // a heavy day each
  for (let u = 1; u <= USERS; u++) {
    for (let i = 0; i < PER_USER; i++) {
      assert.strictEqual(allowVisionCall(u).allowed, true, `user ${u} image ${i + 1}`);
    }
  }
  const status = visionBudgetStatus();
  assert.strictEqual(status.globalUsed, USERS * PER_USER);
  assert.ok(status.globalUsed < VISION_GLOBAL_DAILY * 0.1,
    'today\'s entire user base having a heavy day must not reach a tenth of the ceiling');
  assert.ok(status.globalSpendUsd < 0.25, 'and it must cost pennies');

  // The size the ceiling was actually chosen for: 300 daily-active users at 5
  // screened images each.
  assert.ok(300 * 5 < VISION_GLOBAL_DAILY,
    'the ceiling must still clear the user base it was sized for');
});

// ---------------------------------------------------------------------------
// 5. The counters reset on the boundary each one documents
// ---------------------------------------------------------------------------

test('the GLOBAL counter resets at 00:00 UTC and not before', () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-18T23:58:00Z') });
  for (let i = 0; i < 500; i++) allowVisionCall();
  assert.strictEqual(visionBudgetStatus().globalUsed, 500);
  assert.strictEqual(visionBudgetStatus().day, '2026-08-18');

  mock.timers.setTime(new Date('2026-08-18T23:59:59Z').getTime());
  assert.strictEqual(visionBudgetStatus().globalUsed, 500, 'still the same UTC day');

  mock.timers.setTime(new Date('2026-08-19T00:00:01Z').getTime());
  const rolled = visionBudgetStatus();
  assert.strictEqual(rolled.globalUsed, 0, 'a fixed UTC day is the documented boundary');
  assert.strictEqual(rolled.day, '2026-08-19');
});

test('the PER-ACCOUNT day window resets 24h after that account\'s first screen', () => {
  // createUserBudget anchors the day at the caller's first charge rather than
  // at UTC midnight; the rolling hour is what bounds the burst at the seam.
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-18T09:00:00Z') });
  for (let i = 0; i < VISION_USER_HOURLY; i++) allowVisionCall(555);
  mock.timers.setTime(new Date('2026-08-18T10:30:00Z').getTime());
  for (let i = 0; i < VISION_USER_HOURLY; i++) allowVisionCall(555);
  assert.strictEqual(allowVisionCall(555).allowed, false, 'the day is spent');

  mock.timers.setTime(new Date('2026-08-19T08:59:00Z').getTime());
  assert.strictEqual(allowVisionCall(555).allowed, false, 'still inside the 24h window');

  mock.timers.setTime(new Date('2026-08-19T09:00:01Z').getTime());
  assert.strictEqual(allowVisionCall(555).allowed, true, '24h after the first screen, the window rolls');
});

// ---------------------------------------------------------------------------
// 6. Exhaustion is LOUD
// ---------------------------------------------------------------------------
// The audit's complaint about every existing ceiling in this repo is that they
// are silent in-heap counters nothing can inspect, so the first evidence is an
// invoice.

test('an account exhausting its budget logs an error naming the account', () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-18T09:00:00Z') });
  for (let i = 0; i < VISION_USER_HOURLY; i++) allowVisionCall(4711);
  captureErrors();
  allowVisionCall(4711);

  assert.strictEqual(errorLines.length, 1, 'exhaustion must not be silent');
  assert.match(errorLines[0], /MONEY/, 'the operator greps for MONEY');
  assert.match(errorLines[0], /4711/, 'the log has to say WHICH account');
  assert.match(errorLines[0], /REJECTED/, 'and that the upload was refused');
});

test('the global ceiling logs that every upload in the app is now being refused', () => {
  for (let i = 0; i < VISION_GLOBAL_DAILY; i++) allowVisionCall();
  captureErrors();
  allowVisionCall();

  assert.strictEqual(errorLines.length, 1);
  assert.match(errorLines[0], /MONEY/);
  assert.match(errorLines[0], /EXHAUSTED/);
  assert.match(errorLines[0], /EVERY image upload/);
  assert.match(errorLines[0], /fail-closed/i, 'so nobody reads the outage as a bug to fix by allowing');
});

test('the log is throttled so a flood cannot be turned on us, and says what it suppressed', () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-18T09:00:00Z') });
  for (let i = 0; i < VISION_USER_HOURLY; i++) allowVisionCall(88);
  captureErrors();
  for (let i = 0; i < 500; i++) allowVisionCall(88);
  assert.strictEqual(errorLines.length, 1, '500 refusals in the same minute is one log line');

  mock.timers.setTime(new Date('2026-08-18T09:02:00Z').getTime());
  allowVisionCall(88);
  assert.strictEqual(errorLines.length, 2);
  assert.match(errorLines[1], /499 further refusals/,
    'the suppressed count has to survive, or the throttle hides the scale of the attack');
});

test('a warning fires once per day BEFORE the global ceiling is reached', () => {
  captureErrors();
  const warnAt = Math.floor(VISION_GLOBAL_DAILY * 0.8);
  for (let i = 0; i < warnAt - 1; i++) allowVisionCall();
  assert.strictEqual(errorLines.length, 0, 'no noise below the threshold');

  allowVisionCall();
  assert.strictEqual(errorLines.length, 1, 'a chance to look before uploads start failing');
  assert.match(errorLines[0], /80% spent/);

  for (let i = 0; i < 100; i++) allowVisionCall();
  assert.strictEqual(errorLines.length, 1, 'once per UTC day, not once per call');
});

// ---------------------------------------------------------------------------
// 7. Through moderateImage: exhaustion REFUSES the upload
// ---------------------------------------------------------------------------
// The whole point. A spend cap that let the image through once the money ran
// out would be an image-moderation bypass anyone could buy for $3, on an app
// whose enforced age floor is 13.

test('a screened image passes normally and charges exactly one unit', async () => {
  stubCleanVision();
  const res = await moderation.moderateImage(TINY_PNG, { userId: 1001 });
  assert.strictEqual(res.allowed, true);
  assert.strictEqual(visionCalls, 1);
  assert.strictEqual(visionBudgetStatus().globalUsed, 1, 'one image, one unit');
  assert.strictEqual(visionBudgetStatus(1001).userRemaining.daily, VISION_USER_DAILY - 1);
});

test('once the account budget is gone the upload is REJECTED, not allowed through unscreened', async () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-18T09:00:00Z') });
  stubCleanVision();
  captureErrors();

  for (let i = 0; i < VISION_USER_HOURLY; i++) {
    const ok = await moderation.moderateImage(TINY_PNG, { userId: 2002 });
    assert.strictEqual(ok.allowed, true, `image ${i + 1} should be screened normally`);
  }
  assert.strictEqual(visionCalls, VISION_USER_HOURLY);

  const res = await moderation.moderateImage(TINY_PNG, { userId: 2002 });
  assert.strictEqual(res.allowed, false, 'FAIL CLOSED — running out of money must not open the gate');
  assert.strictEqual(res.reason, 'moderation_budget');
  assert.strictEqual(visionCalls, VISION_USER_HOURLY, 'and no unbilled call was smuggled out either');
});

test('once the GLOBAL budget is gone every account is refused, provider stubbed clean', async () => {
  stubCleanVision();
  captureErrors();
  for (let i = 0; i < VISION_GLOBAL_DAILY; i++) allowVisionCall();

  for (const userId of [1, 2, undefined]) {
    const res = await moderation.moderateImage(TINY_PNG, userId ? { userId } : undefined);
    assert.strictEqual(res.allowed, false, 'a clean provider answer is irrelevant — we never asked it');
    assert.strictEqual(res.reason, 'moderation_budget');
  }
  assert.strictEqual(visionCalls, 0);
});

test('the refusal reads to the user as an ordinary failed screen', () => {
  // Not "we ran out of budget": that invites a retry loop and tells an attacker
  // their spend attack landed.
  assert.strictEqual(
    moderation.imageRejectionMessage({ allowed: false, reason: 'moderation_budget' }),
    moderation.IMAGE_REJECTED_MESSAGE
  );
});

// ---------------------------------------------------------------------------
// 8. Free refusals stay free
// ---------------------------------------------------------------------------
// utils/placesBudget.js's rule: charge before the call, and only for a call you
// are actually going to make. An image we refuse from its own bytes must not
// spend a unit the user needs for a photo that would have worked.

test('an image refused from its own bytes never touches the budget', async () => {
  stubCleanVision();
  for (const bad of ['data:image/png;base64,', 'data:image/png;base64,!!!!', 'not-a-url', '']) {
    const res = await moderation.moderateImage(bad, { userId: 3003 });
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.reason, 'moderation_error', 'refused before the provider, and before the charge');
  }
  assert.strictEqual(visionCalls, 0);
  assert.strictEqual(visionBudgetStatus().globalUsed, 0, 'a free refusal must cost nothing');
  assert.strictEqual(visionBudgetStatus(3003).userRemaining.daily, VISION_USER_DAILY);
});

test('an animated image is refused by the frame gate, still without a charge', async () => {
  stubCleanVision();
  // Minimal 2-frame GIF: header + logical screen descriptor + two image
  // descriptors. inspectImageFrames counts 0x2C blocks and stops at two.
  const gif = Buffer.concat([
    Buffer.from('GIF89a', 'latin1'),
    Buffer.from([1, 0, 1, 0, 0x00, 0, 0]),          // screen descriptor, no global colour table
    Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 0x02, 0x00]),  // frame 1
    Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 0x02, 0x00]),  // frame 2
    Buffer.from([0x3b]),
  ]);
  const res = await moderation.moderateImage(`data:image/gif;base64,${gif.toString('base64')}`, { userId: 4004 });
  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.reason, 'animated_image');
  assert.strictEqual(visionCalls, 0);
  assert.strictEqual(visionBudgetStatus().globalUsed, 0);
});

// ---------------------------------------------------------------------------
// 9. The wiring, asserted against the source
// ---------------------------------------------------------------------------
// Behavioural tests above prove what happens today. These two make it awkward
// to quietly undo.

test('moderation.js charges the shared ledger rather than a hand-rolled counter', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'moderation.js'), 'utf8');
  assert.match(src, /require\('\.\/visionBudget'\)/, 'the budget lives in one file');
  assert.match(src, /allowVisionCall\(userId\)/, 'and moderateImage has to charge it');

  // The charge must sit ABOVE the fetch, not below it: Google bills a request
  // it received even if we abort on timeout, so charge-on-success undercounts
  // exactly when things are going wrong.
  const chargeAt = src.indexOf('allowVisionCall(userId)');
  const fetchAt = src.indexOf('vision.googleapis.com');
  assert.ok(chargeAt > 0 && fetchAt > chargeAt, 'charge BEFORE the call, never after');
});

test('nothing in the repo resets a spend counter outside a test', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const backend = path.join(__dirname, '..');
  const dirs = ['routes', 'services', 'sockets', 'utils', 'middleware'];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(path.join(backend, dir))) {
      if (!f.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(backend, dir, f), 'utf8');
      const hits = (src.match(/__resetVisionBudget\(/g) || []).length;
      const declaration = dir === 'utils' && f === 'visionBudget.js' ? 1 : 0;
      assert.strictEqual(hits, declaration, `${dir}/${f} must not reset the Vision spend counter`);
    }
  }
});

// ---------------------------------------------------------------------------
// 10. THE CALL SITES ACTUALLY PASS AN IDENTITY
// ---------------------------------------------------------------------------
// Everything above proves the per-account leg WORKS. None of it proved it was
// REACHED. moderateImage's `userId` is optional on purpose (a background caller
// with no account charges the global leg only), which means a call site that
// omits it does not fail, does not warn, and does not look wrong — it silently
// drops back to the global-only path. That is the state commit 0f53910 shipped
// in: all six billed doors screened without an id, so one account could still
// walk the whole 2000-call day through the 10-per-60s limiter in server.js in
// about three and a half hours and turn image uploads off for everyone until
// 00:00 UTC. The bill was capped; the fairness was not.
//
// utils/visionBudget.js cannot detect that from the inside — it cannot tell
// "this caller has no account" from "this caller forgot". So the call sites are
// read here instead, both as source and, for the avatar door the audit names as
// the cheapest one, for real over HTTP.

const fs = require('node:fs');
const path = require('node:path');
const BACKEND = path.join(__dirname, '..');

// Which file holds how many billed doors, and what each one charges.
// REST routes carry req.user, set by middleware/auth's authenticate.
// sockets/handlers.js closes over `const user = socket.user` (handlers.js:730),
// which authenticateSocket sets to the users row it re-read from the database.
const VISION_CALL_SITES = {
  'routes/users.js':     { count: 1, identity: 'req.user.id', what: 'avatar upload' },
  // Four, not two, since 2026-08-27: each chat-photo door also moderates the
  // client-derived THUMBNAIL it now accepts (a hostile client could pair an
  // innocent full image with an unrelated thumb, so the thumb is screened
  // like the image and silently dropped on any refusal). Two doors times two
  // screened payloads per door.
  'routes/messages.js':  { count: 4, identity: 'req.user.id', what: 'flock photo and DM photo plus their thumbnails, REST' },
  'routes/stories.js':   { count: 1, identity: 'req.user.id', what: 'story' },
  'sockets/handlers.js': { count: 4, identity: 'user.id',     what: 'flock photo and DM photo plus their thumbnails, socket' },
};

// Comments in this repo quote call sites verbatim — utils/visionBudget.js has a
// whole block of them — so a raw grep would happily assert against prose and
// pass while the code said something else. Only code lines count.
function moderateImageCallLines(relPath) {
  const src = fs.readFileSync(path.join(BACKEND, relPath), 'utf8');
  return src.split(/\r?\n/).filter((line) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
    if (/function\s+moderateImage\(/.test(t)) return false;   // the declaration itself
    return /moderateImage\(/.test(t);
  });
}

for (const [relPath, spec] of Object.entries(VISION_CALL_SITES)) {
  test(`${relPath} charges the per-account Vision leg (${spec.what})`, () => {
    const calls = moderateImageCallLines(relPath);
    assert.strictEqual(calls.length, spec.count,
      `${relPath} should hold exactly ${spec.count} billed Vision call site(s); found ${calls.length}. ` +
      'If a door was added or removed, update VISION_CALL_SITES — do not delete the assertion.');
    const wanted = new RegExp(
      `moderateImage\\(.*,\\s*\\{\\s*userId:\\s*${spec.identity.replace(/\./g, '\\.')}\\s*\\}\\s*\\)`
    );
    for (const line of calls) {
      assert.match(line.trim(), wanted,
        `${relPath}: this screen must charge \`${spec.identity}\`. Without it the call falls back to the ` +
        'global-only path and one account can spend the whole day on everybody else.');
    }
  });
}

test('no billed Vision call site anywhere in the backend screens without an identity', () => {
  // The per-file table above pins the six that exist today; this catches a
  // SEVENTH added later without one, which is the failure mode that put the
  // fairness leg to sleep the first time.
  const dirs = ['routes', 'services', 'sockets', 'utils', 'middleware'];
  const found = [];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(path.join(BACKEND, dir))) {
      if (!f.endsWith('.js')) continue;
      const rel = `${dir}/${f}`;
      if (rel === 'utils/moderation.js') continue;   // the chokepoint, not a caller
      for (const line of moderateImageCallLines(rel)) {
        found.push(rel);
        assert.match(line.trim(), /moderateImage\(.*,\s*\{\s*userId:/,
          `${rel} screens an image without charging an account. Every caller that HAS an authenticated ` +
          'user must pass one; a caller that genuinely has none belongs in this test as a documented exception.');
      }
    }
  }
  assert.deepStrictEqual(
    found.sort(),
    // Four per chat file since 2026-08-27: each photo door also screens the
    // client-derived thumbnail it accepts, under the same identity. See the
    // VISION_CALL_SITES note above.
    ['routes/messages.js', 'routes/messages.js', 'routes/messages.js', 'routes/messages.js',
      'routes/stories.js', 'routes/users.js',
      'sockets/handlers.js', 'sockets/handlers.js', 'sockets/handlers.js', 'sockets/handlers.js'],
    'the set of billed Vision doors changed — re-read visionBudget.js CALL SITES and update both tables'
  );
});

// ---------------------------------------------------------------------------
// 11. The avatar door, end to end, per account
// ---------------------------------------------------------------------------
// Source assertions prove the argument is written. This proves it ARRIVES: the
// avatar route is the one the money audit calls the cheapest door in the app —
// no flock, no membership, no second party — so it is the one worth driving for
// real. The test that matters is the second: an exhausted account must not be
// able to take the door away from anybody else, which is exactly what the
// global-only path could not promise.
const express = require('express');
const http = require('node:http');

const pool = require('../config/database');
// The route's only write. No database in this suite; the screen is the subject.
pool.query = async () => ({ rows: [], rowCount: 1 });

// Replaced BEFORE routes/users.js is required — it destructures `authenticate`
// at module load, so a later assignment would not be seen.
const authMod = require('../middleware/auth');
let currentUserId = 9001;
authMod.authenticate = (req, _res, next) => {
  req.user = { id: currentUserId, name: 'Test', role: 'user' };
  next();
};

const usersRouter = require('../routes/users');
const avatarApp = express();
avatarApp.use('/api/users', usersRouter);
const avatarServer = http.createServer(avatarApp);
let avatarBase;

const PNG_BYTES = Buffer.from(TINY_PNG.split(',')[1], 'base64');

test.before(() => new Promise((resolve) => {
  avatarServer.listen(0, '127.0.0.1', () => {
    avatarBase = `http://127.0.0.1:${avatarServer.address().port}`;
    resolve();
  });
}));

test.after(() => new Promise((resolve) => {
  avatarServer.close(() => resolve());
  pool.end?.().catch(() => {});
}));

async function uploadAvatar(userId) {
  currentUserId = userId;
  const form = new FormData();
  form.append('image', new Blob([PNG_BYTES], { type: 'image/png' }), 'avatar.png');
  // realFetch, not the stubbed global: the Vision stub is not an HTTP client.
  const res = await realFetch(`${avatarBase}/api/users/upload-image`, { method: 'POST', body: form });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

test('the avatar upload charges the uploader, not just the global ledger', async () => {
  stubCleanVision();
  const res = await uploadAvatar(9001);
  assert.strictEqual(res.status, 200, 'an ordinary avatar still uploads');
  assert.strictEqual(visionCalls, 1);
  assert.strictEqual(visionBudgetStatus(9001).userRemaining.daily, VISION_USER_DAILY - 1,
    'the screen has to land on the uploader ledger — if it does not, this door is still global-only');
  assert.strictEqual(visionBudgetStatus(9002).userRemaining.daily, VISION_USER_DAILY,
    'and on nobody else');
});

test('an account that spends its Vision budget cannot take the avatar door from anyone else', async () => {
  stubCleanVision();
  captureErrors();

  // Spend 9101's hour directly, so this test is about the ROUTE's behaviour at
  // the wall rather than about re-proving the counter.
  for (let i = 0; i < VISION_USER_HOURLY; i++) {
    assert.strictEqual(allowVisionCall(9101).allowed, true, `unit ${i + 1} should be granted`);
  }

  const spent = await uploadAvatar(9101);
  assert.strictEqual(spent.status, 400, 'FAIL CLOSED — no screen, no avatar');
  assert.strictEqual(spent.body.moderation, 'moderation_budget');
  assert.strictEqual(spent.body.error, moderation.IMAGE_REJECTED_MESSAGE,
    'and the user is told the same thing a provider outage tells them');
  assert.strictEqual(visionCalls, 0, 'nothing was billed for the refusal');

  const other = await uploadAvatar(9102);
  assert.strictEqual(other.status, 200,
    'the second account is untouched — this is the entire point of the per-account leg');
  assert.strictEqual(visionCalls, 1);
  assert.strictEqual(visionBudgetStatus().globalUsed, VISION_USER_HOURLY + 1,
    'and one account nowhere near emptied the global allowance for everybody');
});
