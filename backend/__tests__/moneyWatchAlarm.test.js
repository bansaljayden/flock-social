// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// THE ALARM ON THE SPEND CEILINGS
// ---------------------------------------------------------------------------
// Every paid or quota-limited upstream in this app has a global daily ceiling,
// and until the money watch in server.js existed, five of the six reached that
// ceiling in complete silence:
//
//   utils/placesBudget.js    no console call anywhere in the file
//   services/birdieUsage.js  no console call anywhere in the file
//   services/mlPredictor.js  event budget, silent
//   services/nightContext.js background sweep, silent by definition
//   services/photoStore.js   one line an hour, to stdout
//   utils/visionBudget.js    the only one that talks properly
//
// So the first evidence of a spent budget was a user reporting that venues had
// stopped loading, or the invoice. utils/visionBudget.js's own inventory row
// says the missing piece out loud — "what is missing is still not a different
// policy but an alarm" — and names the fix.
//
// This file holds that alarm to two promises:
//
//   1. IT CANNOT GO STALE. Any module that exports a spend-status reader has to
//      be read by runMoneyWatch. A seventh paid upstream cannot land unwatched,
//      which is the same forcing function utils/cacheKeyInventory.js applies to
//      caches — and it is needed for the same reason: the four rounds that each
//      fixed the reported instance rather than the class.
//   2. IT FIRES ONCE, AT THE RIGHT TIME. Below 80% it says nothing, at 80% it
//      warns, at the ceiling it escalates, and it does not repeat itself inside
//      one day. An alarm that repeats every fifteen minutes trains its reader to
//      ignore it, which lands in exactly the same place as no alarm at all.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8').replace(/\r\n/g, '\n');

// The body of runMoneyWatch, which is where every leg has to be named.
function moneyWatchBody() {
  const m = /async function runMoneyWatch\(\) \{([\s\S]*?)\n\}/.exec(SRC);
  assert.ok(m, 'runMoneyWatch is gone from server.js. Without it, a spent Places or Gemini budget '
    + 'is discovered from the invoice or from a user saying the app stopped loading venues.');
  return m[1];
}

// ── 1. Every spend-status reader in the repo is watched ─────────────────────

test('every module that exports a spend-status reader is read by the money watch', () => {
  const body = moneyWatchBody();
  const found = [];

  for (const dir of ['utils', 'services']) {
    const abs = path.join(BACKEND, dir);
    for (const f of fs.readdirSync(abs).filter((n) => n.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(abs, f), 'utf8').replace(/\r\n/g, '\n');
      const exports = /module\.exports = \{([\s\S]*?)\n\};/.exec(src);
      if (!exports) continue;
      for (const m of exports[1].matchAll(/^\s*([A-Za-z_$][\w$]*(?:Budget|Spend)Status),?$/gm)) {
        found.push({ file: `${dir}/${f}`, name: m[1] });
      }
    }
  }

  assert.ok(found.length >= 6,
    `the sweep found ${found.length} spend-status readers, which means it is broken rather than `
    + 'the tree being clean');

  const unwatched = found.filter((r) => !body.includes(r.name));
  assert.deepStrictEqual(unwatched.map((r) => `${r.file} -> ${r.name}`), [],
    `${unwatched.length} spend ceiling(s) are not read by runMoneyWatch in server.js:\n`
    + unwatched.map((r) => `    ${r.file}  ->  ${r.name}()`).join('\n')
    + '\n\n  ──────────────────────────────────────────────────────────────────────\n'
    + '  A GLOBAL CEILING THAT NOBODY IS TOLD ABOUT IS DISCOVERED FROM THE\n'
    + '  INVOICE. Add a checkMoneyLeg({ ... }) call for it in runMoneyWatch, and\n'
    + '  write its two sentences the way the existing legs do:\n\n'
    + '    atCeiling  what STOPS WORKING, in product terms, and until when. Not\n'
    + '               "budget exhausted" — "every photo upload in the app is\n'
    + '               refused until 00:00 UTC". The reader is deciding whether to\n'
    + '               get out of bed.\n'
    + '    atWarn     the same thing in the future tense, because 80% is the last\n'
    + '               point at which a decision is still available.\n'
    + '  ──────────────────────────────────────────────────────────────────────');
});

test('every watched leg says what stops working, not just that a number was reached', () => {
  const body = moneyWatchBody();
  const legs = [...body.matchAll(/leg: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(legs.length >= 6, `only ${legs.length} legs are watched; the parser is broken`);
  assert.strictEqual(new Set(legs).size, legs.length,
    `two legs share a name, so one of them can never raise its own alarm: ${legs.join(', ')}`);

  const sentences = [...body.matchAll(/at(?:Ceiling|Warn): '([\s\S]*?)',\n/g)].map((m) => m[1]);
  assert.strictEqual(sentences.length, legs.length * 2,
    'every leg needs both an atCeiling and an atWarn sentence');
  for (const s of sentences) {
    assert.ok(s.length >= 40,
      `a money alarm sentence is too short to act on: "${s}"\n`
      + 'Say what stops working and until when.');
  }
});

// ── 2. The alarm fires once, at the right time ──────────────────────────────

// Lifted from server.js rather than restated: a copy of the thresholds here
// would pass forever while the real ones drifted, which is the failure this
// whole area of the codebase keeps finding.
function loadAlarm() {
  const pieces = [
    /const MONEY_WARN_FRACTION = [^\n]+;/,
    /const moneyWatchSaid = new Map\(\);/,
    /function sayOnceToday\(leg, level, day, message, extra\) \{[\s\S]*?\n\}/,
    /const moneyWatchPaged = new Map\(\);/,
    /const MONEY_PAGE_RETRY_MS = [^\n]+;/,
    /function pageMoneyLeg\(leg, day, title, message\) \{[\s\S]*?\n\}/,
    /function checkMoneyLeg\(\{[\s\S]*?\n\}/,
  ].map((re) => {
    const m = re.exec(SRC);
    assert.ok(m, `the money watch no longer contains ${re}`);
    return m[0];
  });

  const captured = [];
  const paged = [];
  const Sentry = { captureMessage: (msg, opts) => captured.push({ msg, level: opts.level, tags: opts.tags }) };
  const fakeConsole = { error: () => {} };
  // The real pageMoneyLeg, handed an opsAlert that records the page and
  // answers what the test says it answers. `answer` can be swapped mid-test.
  const alarm = { answer: () => ({ sent: true, legs: ['email', 'push'] }) };
  const fakeRequire = (p) => {
    assert.strictEqual(p, './services/opsAlert');
    return {
      opsAlert: async (a) => {
        paged.push({ leg: a.key.replace(/^money_/, ''), title: a.push.title, message: a.push.body, key: a.key });
        return alarm.answer(a);
      },
    };
  };
  const make = Function('Sentry', 'console', 'require', `"use strict";
    ${pieces.join('\n')}
    return { checkMoneyLeg, reset: () => { moneyWatchSaid.clear(); moneyWatchPaged.clear(); } };`);
  return Object.assign(alarm, make(Sentry, fakeConsole, fakeRequire), { captured, paged });
}

// The page answers after opsAlert's promise settles.
const settle = () => new Promise((r) => setImmediate(r));

// ── 3. A spent ceiling reaches a person, not just the log ───────────────────

test('a spent ceiling pages the admins once, and the 80% warning stays in the log', () => {
  const a = loadAlarm();
  const leg = { leg: 'vision-global', day: '2026-09-27', ceiling: 100, noun: 'screens', atCeiling: 'Uploads are off.', atWarn: 'Nearly spent.', title: 'Photo uploads are off' };
  a.checkMoneyLeg({ ...leg, used: 85 });
  assert.deepStrictEqual(a.paged, [], 'a warning is a decision that can wait for somebody to look');
  a.checkMoneyLeg({ ...leg, used: 100 });
  a.checkMoneyLeg({ ...leg, used: 100 });
  assert.strictEqual(a.paged.length, 1, 'the ceiling pages once per leg per day');
  assert.strictEqual(a.paged[0].leg, 'vision-global');
  assert.strictEqual(a.paged[0].title, 'Photo uploads are off');
  assert.ok(a.paged[0].message.includes('Uploads are off.'));
});

test('a page that reached nobody is tried again on a later run the same day', async () => {
  // opsAlert answers { failed: true } when neither the email nor any admin
  // device took the alert, and gives its ledger claim back so a later run can
  // try again. A page marked done before that answer came back blocked the
  // retry until 00:00 UTC, which is when the ceiling resets anyway, so a spent
  // Vision or Gemini budget could reach nobody for the whole day it was spent.
  const a = loadAlarm();
  const realNow = Date.now;
  const t0 = realNow();
  const leg = { leg: 'gemini-global', day: '2026-09-27', used: 100, ceiling: 100, noun: 'tokens', atCeiling: 'Birdie is off.', atWarn: 'w', title: 'Birdie is off until 00:00 UTC' };
  try {
    Date.now = () => t0;
    a.answer = () => ({ failed: true });
    a.checkMoneyLeg(leg);
    await settle();
    assert.strictEqual(a.paged.length, 1);
    assert.strictEqual(a.paged[0].key, 'money_gemini-global');

    // A run moments later, while the answer is still fresh, does not page again.
    a.checkMoneyLeg(leg);
    await settle();
    assert.strictEqual(a.paged.length, 1, 'attempts are spaced, not one per reading');

    // The next fifteen-minute run pages again, although the log already spoke.
    a.answer = () => ({ sent: true, legs: ['push'] });
    Date.now = () => t0 + 15 * 60 * 1000;
    a.checkMoneyLeg(leg);
    await settle();
    assert.strictEqual(a.paged.length, 2, 'nobody had been reached, so the page is not done');
    assert.strictEqual(a.captured.length, 1, 'the log line is still said once a day');

    // Reached now, so the rest of the day is quiet.
    Date.now = () => t0 + 30 * 60 * 1000;
    a.checkMoneyLeg(leg);
    await settle();
    assert.strictEqual(a.paged.length, 2);

    // A new day is a new page.
    Date.now = () => t0 + 45 * 60 * 1000;
    a.checkMoneyLeg({ ...leg, day: '2026-09-28' });
    await settle();
    assert.strictEqual(a.paged.length, 3);
  } finally {
    Date.now = realNow;
  }
});

test('a page that threw or found no recipient is retried, and one the ledger already sent is done', async () => {
  const realNow = Date.now;
  const t0 = realNow();
  const leg = { leg: 'vision-global', day: '2026-09-27', used: 100, ceiling: 100, noun: 'screens', atCeiling: 'Uploads are off.', atWarn: 'w', title: 'Photo uploads are off' };
  try {
    for (const miss of [() => { throw new Error('ledger down'); }, () => ({ skipped: 'no-recipient' })]) {
      const a = loadAlarm();
      Date.now = () => t0;
      a.answer = miss;
      a.checkMoneyLeg(leg);
      await settle();
      a.answer = () => ({ sent: true, legs: ['email'] });
      Date.now = () => t0 + 15 * 60 * 1000;
      a.checkMoneyLeg(leg);
      await settle();
      assert.strictEqual(a.paged.length, 2, `a page answered ${String(miss).slice(0, 60)} was never retried`);
    }

    // After a deploy the map is empty but the ledger remembers: the ledger's
    // "already sent today" means somebody was reached, so the page is done.
    const a = loadAlarm();
    Date.now = () => t0;
    a.answer = () => ({ skipped: 'already-sent-today' });
    a.checkMoneyLeg(leg);
    await settle();
    Date.now = () => t0 + 15 * 60 * 1000;
    a.checkMoneyLeg(leg);
    await settle();
    assert.strictEqual(a.paged.length, 1);
  } finally {
    Date.now = realNow;
  }
});

test('a leg with no title stays in the log, so a leg another alert covers is not paged twice', () => {
  const a = loadAlarm();
  a.checkMoneyLeg({ leg: 'photo-month', day: '2026-09', used: 100, ceiling: 100, noun: 'fetches', atCeiling: 'Spent.', atWarn: 'w' });
  assert.strictEqual(a.captured.length, 1);
  assert.deepStrictEqual(a.paged, []);
});

test('every paged leg in runMoneyWatch carries a title, and only the photo leg goes without', () => {
  const body = moneyWatchBody();
  const calls = [...body.matchAll(/checkMoneyLeg\(\{([\s\S]*?)\n\s*\}\);/g)].map((m) => m[1]);
  assert.ok(calls.length >= 6);
  const untitled = calls
    .filter((c) => !/\btitle: '/.test(c))
    .map((c) => (/leg: '([^']+)'/.exec(c) || [])[1]);
  assert.deepStrictEqual(untitled, ['photo-month'],
    'a spent ceiling with no title is never paged. Only the photo month budget may go without, because '
    + 'services/costHeartbeat.js already alerts on it.');
  // And the pager itself goes through the shared sender, keyed per leg.
  assert.match(SRC, /function pageMoneyLeg\(leg, day, title, message\) \{[\s\S]*?opsAlert\(\{[\s\S]*?key: `money_\$\{leg\}`/);
});

test('nothing is said below the warning threshold', () => {
  const a = loadAlarm();
  a.checkMoneyLeg({ leg: 'x', day: '2026-08-26', used: 79, ceiling: 100, noun: 'calls', atCeiling: 'c', atWarn: 'w' });
  assert.deepStrictEqual(a.captured, [],
    'the watch spoke at 79% of a ceiling. Below the warning line there is nothing to decide, '
    + 'and a watch that talks about ordinary days is one nobody reads on the day that matters.');
});

test('80% warns, the ceiling escalates, and neither repeats inside the same day', () => {
  const a = loadAlarm();
  const leg = { leg: 'places-global', day: '2026-08-26', ceiling: 100, noun: 'paid calls', atCeiling: 'Venue search is off.', atWarn: 'Nearly spent.' };

  a.checkMoneyLeg({ ...leg, used: 80 });
  assert.strictEqual(a.captured.length, 1, 'crossing 80% did not raise a warning');
  assert.strictEqual(a.captured[0].level, 'warning');

  a.checkMoneyLeg({ ...leg, used: 85 });
  a.checkMoneyLeg({ ...leg, used: 92 });
  assert.strictEqual(a.captured.length, 1,
    'the warning repeated inside one day. The sweep runs every fifteen minutes, so a budget sitting '
    + 'at 85% for an afternoon would raise it dozens of times and the reader would learn to skip it.');

  a.checkMoneyLeg({ ...leg, used: 100 });
  assert.strictEqual(a.captured.length, 2, 'reaching the ceiling did not escalate past the warning');
  assert.strictEqual(a.captured[1].level, 'error',
    'exhaustion is not a warning: the product has started refusing people.');
  assert.ok(a.captured[1].msg.includes('Venue search is off.'),
    'the exhaustion alert does not carry the sentence saying what stopped working');

  a.checkMoneyLeg({ ...leg, used: 100 });
  assert.strictEqual(a.captured.length, 2, 'the exhaustion alert repeated inside one day');

  // A new day is a new budget, so it is a new alarm.
  a.checkMoneyLeg({ ...leg, day: '2026-08-27', used: 100 });
  assert.strictEqual(a.captured.length, 3,
    'the counters roll at UTC midnight, so the alarm has to roll with them. Otherwise a budget spent '
    + 'on two days running is reported once.');
});

test('a leg with an unreadable status is skipped rather than throwing', () => {
  const a = loadAlarm();
  // What a failed status read looks like: undefined numbers, or a ceiling of 0
  // from a module that has not initialised. A watchdog that can break the thing
  // it watches is worse than no watchdog.
  a.checkMoneyLeg({ leg: 'x', day: 'd', used: undefined, ceiling: 100, noun: 'n', atCeiling: 'c', atWarn: 'w' });
  a.checkMoneyLeg({ leg: 'y', day: 'd', used: 5, ceiling: 0, noun: 'n', atCeiling: 'c', atWarn: 'w' });
  a.checkMoneyLeg({ leg: 'z', day: 'd', used: NaN, ceiling: NaN, noun: 'n', atCeiling: 'c', atWarn: 'w' });
  assert.deepStrictEqual(a.captured, []);
});

test('a status reader that returns no day still gets its leg heard', () => {
  // The dedupe is `moneyWatchSaid.get(key) === day`, and before a leg has ever
  // spoken that get() is undefined. So a reader that came back without a `day`
  // (a new module, a rename, a status object built in a hurry) compared equal
  // to "already said this today" on its very FIRST call, and that leg was
  // silent for the life of the process. Every one of the six readers returns a
  // day today. The point is what happens to the seventh: the alarm built to
  // stop money ceilings failing quietly would itself have failed quietly, and
  // nothing anywhere would have said so.
  for (const day of [undefined, null, '', 0]) {
    const a = loadAlarm();
    a.checkMoneyLeg({ leg: 'new-upstream', day, used: 100, ceiling: 100, noun: 'calls', atCeiling: 'It is off.', atWarn: 'w' });
    assert.strictEqual(a.captured.length, 1,
      `a leg whose status reader returned day=${JSON.stringify(day)} said nothing at its ceiling. `
      + 'A missing day means the reader is broken, which is a reason to talk more rather than less.');

    // And it does not then repeat on every fifteen-minute sweep either, which
    // is the failure the dedupe exists to prevent. Once the leg has spoken, the
    // stored value is that same missing day.
    a.checkMoneyLeg({ leg: 'new-upstream', day, used: 100, ceiling: 100, noun: 'calls', atCeiling: 'It is off.', atWarn: 'w' });
    assert.strictEqual(a.captured.length, 2,
      'a leg with no day cannot dedupe on one, so it speaks every sweep. That is the deliberate '
      + 'trade: noisy beats silent, and the fix is to give the reader a day.');
  }
});

test('the watch is registered on a timer and cleared on shutdown', () => {
  assert.match(SRC, /moneyWatchInterval = setInterval\(moneyWatch, MONEY_WATCH_INTERVAL_MS\)/,
    'the money watch is defined but never scheduled, so it never runs');
  assert.match(SRC, /if \(moneyWatchInterval\) clearInterval\(moneyWatchInterval\)/,
    'the money watch timer is not cleared in shutdown(), so it fires into a closing pool on every deploy');
});
