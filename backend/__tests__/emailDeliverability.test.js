// Run: node --test  (from backend/)
//
// ===========================================================================
// EMAIL AS ONE SYSTEM: DOES ANYBODY FIND OUT WHEN IT STOPS.
// ===========================================================================
// Round 27 audited every place this codebase sends mail as a single channel
// rather than one route at a time, and the findings this file pins are the
// ones that were invisible from inside any single route:
//
//   1. NOBODY WOULD HAVE KNOWN IF SENDING STOPPED. Every caller fails soft, on
//      purpose, and correctly. Added up, an expired Resend key or a lapsed
//      sending domain produced a polite log line at each caller, a product
//      where no screen looks broken, and an account that cannot be created, a
//      password that cannot be recovered and a parent who is not told their
//      child raised an alarm. There is now one alarm, on the send path, on a
//      greppable token, once per condition per UTC day.
//
//   2. THE PER-RECIPIENT CAP COULD EAT AN SOS. The suppression list lets an
//      emergency past a hard bounce because a deliverability fact is not a
//      refusal of an ambulance. The send counter, two lines below it, made no
//      such exception and would have swallowed both the alert and the
//      stand-down that tells a parent it is over.
//
//   3. THE CAP'S NUMBER CONTRADICTED ITS OWN REASON. It was 60 a day, justified
//      by a caller bounded at 40 an HOUR. The operator inbox that carries every
//      content report, every child-safety report and every venue verification
//      claim was therefore cut off at message sixty-one.
//
//   4. FOUR SENDERS SHIPPED HTML-ONLY, the SOS alert among them. A text part is
//      now derived at the one place every message passes through, so no caller
//      can forget it.
//
//   5. NOTHING SET A REPLY-TO, and the SOS alert is sent From an address with
//      no inbound route.
//
//   6. NOTHING COULD TAKE A ROW OFF THE SUPPRESSION LIST. A person whose only
//      address hard-bounced once was locked out of their account forever.
// ===========================================================================
const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'deliverability-test-secret';

// --- pg fake ---------------------------------------------------------------
const pool = require('../config/database');
let suppressionRows;
let queriesRan;

pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queriesRan.push({ flat, params });
  if (/SELECT reason FROM email_suppressions/.test(flat)) {
    const reason = suppressionRows.get(params[0]);
    return Promise.resolve(reason ? { rows: [{ reason }], rowCount: 1 } : { rows: [], rowCount: 0 });
  }
  if (/INSERT INTO email_suppressions/.test(flat)) {
    suppressionRows.set(params[0], params[1]);
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (/DELETE FROM email_suppressions/.test(flat)) {
    const had = suppressionRows.delete(params[0]);
    return Promise.resolve({ rows: [], rowCount: had ? 1 : 0 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const suppression = require('../services/emailSuppression');
const emailService = require('../services/emailService');

const RESEND_PATH = require.resolve('resend');

// `error` makes every send come back as a provider refusal, which is what an
// expired key (401) and a lapsed domain (403) both look like from here.
function stubResend({ error = null } = {}) {
  const realEntry = require.cache[RESEND_PATH];
  const sends = [];
  class FakeResend {
    constructor(key) {
      this.key = key;
      this.emails = {
        send: async (payload) => {
          sends.push(payload);
          if (error) return { data: null, error };
          return { data: { id: `msg_${sends.length}` }, error: null };
        },
      };
    }
  }
  require.cache[RESEND_PATH] = {
    id: RESEND_PATH, filename: RESEND_PATH, loaded: true, exports: { Resend: FakeResend },
  };
  return {
    sends,
    restore() {
      if (realEntry) require.cache[RESEND_PATH] = realEntry;
      else delete require.cache[RESEND_PATH];
      emailService.resetClient();
    },
  };
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  const out = fn();
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

function silence() {
  const real = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  const push = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  console.log = push; console.warn = push; console.error = push;
  return { text: () => lines.join('\n'), restore() { Object.assign(console, real); } };
}

function resetWorld() {
  suppressionRows = new Map();
  queriesRan = [];
  suppression.resetCache();
  emailService.resetRecipientBudget();
  emailService.resetEmailHealth();
}

const EMERGENCY = suppression.EMERGENCY_CATEGORY;

// ===========================================================================
// 1. Would anybody know if sending stopped
// ===========================================================================

test('a missing API key on a production deployment raises the alarm, not a warning', async () => {
  resetWorld();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: undefined, NODE_ENV: 'production' }, async () => {
      emailService.resetClient();
      const out = await emailService.sendEmail({ to: 'a@example.com', subject: 's', html: '<p>x</p>' });
      assert.strictEqual(out.skipped, true, 'the fail-soft contract still holds');
    });
    const text = cap.text();
    assert.match(text, /🛡️ EMAIL:/, 'the alarm token must be present so one grep finds every email failure');
    assert.match(text, /RESEND_API_KEY is not set/);
    assert.match(text, /SOS alert/, 'the alarm has to say what stopped working, not that a variable is unset');
  } finally { cap.restore(); }
});

test('the same alarm is not repeated on every send, because a repeated alarm is an ignored one', async () => {
  resetWorld();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: undefined, NODE_ENV: 'production' }, async () => {
      emailService.resetClient();
      for (let i = 0; i < 6; i++) {
        await emailService.sendEmail({ to: `a${i}@example.com`, subject: 's', html: '<p>x</p>' });
      }
    });
    const hits = cap.text().split('\n').filter((l) => /🛡️ EMAIL: RESEND_API_KEY/.test(l));
    assert.strictEqual(hits.length, 1, 'once per condition per UTC day');
  } finally { cap.restore(); }
});

test('development with no key stays quiet, because that is the ordinary state there', async () => {
  resetWorld();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: undefined, NODE_ENV: 'test' }, async () => {
      emailService.resetClient();
      await emailService.sendEmail({ to: 'a@example.com', subject: 's', html: '<p>x</p>' });
    });
    assert.doesNotMatch(cap.text(), /🛡️ EMAIL:/);
  } finally { cap.restore(); }
});

test('a run of provider failures raises the alarm and names what the provider said', async () => {
  resetWorld();
  const r = stubResend({ error: { message: 'API key is invalid', statusCode: 401 } });
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'expired' }, async () => {
      emailService.resetClient();
      const n = emailService.CONSECUTIVE_FAILURES_BEFORE_ALARM;
      for (let i = 0; i < n - 1; i++) {
        await emailService.sendEmail({ to: `p${i}@example.com`, subject: 's', html: '<p>x</p>' });
      }
      assert.doesNotMatch(cap.text(), /🛡️ EMAIL: the last/, 'one bad send is weather, not an outage');
      await emailService.sendEmail({ to: 'last@example.com', subject: 's', html: '<p>x</p>' });
    });
    const text = cap.text();
    assert.match(text, /🛡️ EMAIL: the last \d+ outbound emails all failed/);
    assert.match(text, /API key is invalid/, 'the provider\'s own words are what makes this diagnosable');
    assert.match(text, /sending domain/, 'the alarm has to name the three things worth checking');
  } finally { cap.restore(); r.restore(); }
});

test('one success clears the run, so an ordinary bad address cannot arm the outage alarm', async () => {
  resetWorld();
  const cap = silence();
  const failing = stubResend({ error: { message: 'nope' } });
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      for (let i = 0; i < emailService.CONSECUTIVE_FAILURES_BEFORE_ALARM - 1; i++) {
        await emailService.sendEmail({ to: `f${i}@example.com`, subject: 's', html: '<p>x</p>' });
      }
    });
    failing.restore();
    const ok = stubResend();
    try {
      await withEnv({ RESEND_API_KEY: 'k' }, async () => {
        emailService.resetClient();
        await emailService.sendEmail({ to: 'good@example.com', subject: 's', html: '<p>x</p>' });
      });
      assert.strictEqual(emailService.emailHealthStatus().consecutiveFailures, 0);
    } finally { ok.restore(); }
    assert.doesNotMatch(cap.text(), /🛡️ EMAIL: the last/);
  } finally { cap.restore(); }
});

test('the health snapshot reports what an ops surface would need to ask', async () => {
  resetWorld();
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      await emailService.sendEmail({ to: 'h@example.com', subject: 's', html: '<p>x</p>' });
    });
    const status = emailService.emailHealthStatus();
    assert.strictEqual(status.sent, 1);
    assert.strictEqual(status.attempted, 1);
    assert.strictEqual(status.failed, 0);
    assert.ok(status.lastSentAt, 'a surface that cannot say when mail last left cannot answer the question');
  } finally { cap.restore(); r.restore(); }
});

// ===========================================================================
// 2. The cap must never be the reason an emergency is not delivered
// ===========================================================================

test('an SOS alert is sent even past the per-recipient daily cap', async () => {
  resetWorld();
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      const n = emailService.PER_RECIPIENT_DAILY_CAP;
      for (let i = 0; i < n; i++) {
        await emailService.sendEmail({ to: 'parent@example.com', subject: 's', html: '<p>x</p>', category: EMERGENCY });
      }
      const over = await emailService.sendEmail({
        to: 'parent@example.com', subject: 'alert', html: '<p>x</p>', category: EMERGENCY,
      });
      assert.strictEqual(over.sent, true, 'a counter built for marketing loops must not swallow an SOS');
      assert.strictEqual(r.sends.length, n + 1);
    });
  } finally { cap.restore(); r.restore(); }
});

test('an uncapped emergency loop is still reported, so it cannot run unseen', async () => {
  resetWorld();
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      for (let i = 0; i <= emailService.PER_RECIPIENT_DAILY_CAP; i++) {
        await emailService.sendEmail({ to: 'loop@example.com', subject: 's', html: '<p>x</p>', category: EMERGENCY });
      }
    });
    assert.match(cap.text(), /🛡️ EMAIL: .* emergency messages in 24 hours/);
  } finally { cap.restore(); r.restore(); }
});

test('a marketing flood cannot be the reason a password reset to the same address is refused', async () => {
  resetWorld();
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      for (let i = 0; i < emailService.PER_RECIPIENT_DAILY_CAP; i++) {
        await emailService.sendEmail({ to: 'both@example.com', subject: 's', html: '<p>x</p>', category: 'marketing' });
      }
      const marketing = await emailService.sendEmail({
        to: 'both@example.com', subject: 's', html: '<p>x</p>', category: 'marketing',
      });
      assert.strictEqual(marketing.sent, false, 'the loop is still stopped in its own category');
      const reset = await emailService.sendEmail({
        to: 'both@example.com', subject: 'Reset your Flock password', html: '<p>x</p>',
      });
      assert.strictEqual(reset.sent, true, 'a cap that eats a verification link is worse than one that eats a digest');
    });
  } finally { cap.restore(); r.restore(); }
});

test('the cap still stops an ordinary send loop, and tells a retrying caller nothing was sent', async () => {
  resetWorld();
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      for (let i = 0; i < emailService.PER_RECIPIENT_DAILY_CAP; i++) {
        await emailService.sendEmail({ to: 'busy@example.com', subject: 's', html: '<p>x</p>' });
      }
      const over = await emailService.sendEmail({ to: 'busy@example.com', subject: 's', html: '<p>x</p>' });
      assert.strictEqual(over.sent, false);
      assert.strictEqual(over.refused, true);
      assert.strictEqual(r.sends.length, emailService.PER_RECIPIENT_DAILY_CAP);
    });
    assert.match(cap.text(), /🛡️ EMAIL: .* send loop/);
  } finally { cap.restore(); r.restore(); }
});

// ===========================================================================
// 3. No message leaves here HTML-only
// ===========================================================================

test('a caller that passes only html still reaches the provider with a text part', async () => {
  resetWorld();
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      await emailService.sendEmail({
        to: 'contact@example.com',
        subject: 'Flock SOS',
        html: '<div><h1>Ava needs help</h1><p>Sent at 11:04 PM. <a href="https://maps.example.org/x">Open the map</a></p></div>',
        category: EMERGENCY,
      });
    });
    const sent = r.sends[0];
    assert.ok(sent.text, 'the SOS alert was HTML-only, which is the message least able to afford a spam folder');
    assert.match(sent.text, /Ava needs help/);
    assert.match(sent.text, /https:\/\/maps\.example\.org\/x/, 'a text part whose links vanished is worse than none');
  } finally { cap.restore(); r.restore(); }
});

test('a caller that wrote its own text part keeps it verbatim', async () => {
  resetWorld();
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      await emailService.sendEmail({
        to: 'a@example.com', subject: 's', html: '<p>rendered</p>', text: 'hand written',
      });
    });
    assert.strictEqual(r.sends[0].text, 'hand written');
  } finally { cap.restore(); r.restore(); }
});

test('the derived text reverses the escaping, so a name reads as itself', () => {
  const out = emailService.deriveTextFromHtml('<p>Hi O&#39;Brien &amp; Sons</p><p>Second line</p>');
  assert.match(out, /O'Brien & Sons/);
  assert.match(out, /\nSecond line/, 'block tags become line breaks, not one run-on paragraph');
});

test('the derived text never renders a script or a style block as words', () => {
  const out = emailService.deriveTextFromHtml('<style>.x{color:red}</style><script>alert(1)</script><p>body</p>');
  assert.strictEqual(out, 'body');
});

test('the derived text cannot resurrect markup that escaping had neutralised', () => {
  // `&amp;lt;` is a literal "&lt;" in the rendered page. Unescaping the
  // ampersand first would turn it into a real "<".
  const out = emailService.deriveTextFromHtml('<p>&amp;lt;script&amp;gt;</p>');
  assert.strictEqual(out, '&lt;script&gt;');
});

// ===========================================================================
// 4. A reply reaches somebody
// ===========================================================================

test('every message carries a reply-to a person reads', async () => {
  resetWorld();
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      await emailService.sendEmail({
        to: 'parent@example.com',
        subject: 'Flock SOS',
        html: '<p>x</p>',
        from: 'Flock Safety <alerts@flockcorp.com>',
        category: EMERGENCY,
      });
    });
    assert.strictEqual(r.sends[0].replyTo, emailService.DEFAULT_REPLY_TO,
      'the SOS is sent From an address with no inbound route, and a parent will reply to it');
  } finally { cap.restore(); r.restore(); }
});

test('a caller can name its own reply-to, and a header injection in one is stripped', async () => {
  resetWorld();
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      await emailService.sendEmail({
        to: 'a@example.com', subject: 's', html: '<p>x</p>', replyTo: 'desk@flockcorp.com',
      });
      await emailService.sendEmail({
        to: 'b@example.com', subject: 's', html: '<p>x</p>', replyTo: 'desk@flockcorp.com\r\nBcc: evil@example.org',
      });
    });
    assert.strictEqual(r.sends[0].replyTo, 'desk@flockcorp.com');
    assert.doesNotMatch(r.sends[1].replyTo, /[\r\n]/, 'a reply-to is a header like any other');
  } finally { cap.restore(); r.restore(); }
});

// ===========================================================================
// 5. A suppressed address on a transactional message is a locked-out person
// ===========================================================================

test('a transactional message refused by the suppression list is named as a lockout', async () => {
  resetWorld();
  suppressionRows.set('stuck@example.com', 'bounce');
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      const out = await emailService.sendEmail({
        to: 'stuck@example.com', subject: 'Reset your Flock password', html: '<p>x</p>',
      });
      assert.strictEqual(out.suppressed, true);
    });
    const text = cap.text();
    assert.match(text, /🛡️ EMAIL: .* do-not-mail list/);
    assert.match(text, /cannot reset their password/);
    assert.match(text, /no self-service way back/);
  } finally { cap.restore(); r.restore(); }
});

test('a marketing message refused by the same list is the list working, and stays quiet', async () => {
  resetWorld();
  suppressionRows.set('optedout@example.com', 'unsubscribe');
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      const out = await emailService.sendEmail({
        to: 'optedout@example.com', subject: 'Your week in numbers', html: '<p>x</p>', category: 'marketing',
      });
      assert.strictEqual(out.suppressed, true);
    });
    assert.doesNotMatch(cap.text(), /🛡️ EMAIL:/);
  } finally { cap.restore(); r.restore(); }
});

// ===========================================================================
// 6. The way back off the list
// ===========================================================================

test('unsuppress clears the row and the cached answer, so the next send goes', async () => {
  resetWorld();
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      await suppression.suppress('back@example.com', 'bounce', 'permanent bounce');
      // Read once, so the answer is cached and a naive delete would be invisible
      // for the whole five-minute TTL.
      assert.strictEqual(await suppression.suppressionReason('back@example.com'), 'bounce');
      assert.strictEqual(await suppression.unsuppress('back@example.com'), true);
      assert.strictEqual(await suppression.suppressionReason('back@example.com'), null);
      const out = await emailService.sendEmail({
        to: 'back@example.com', subject: 'Reset your Flock password', html: '<p>x</p>',
      });
      assert.strictEqual(out.sent, true);
    });
  } finally { cap.restore(); r.restore(); }
});

test('unsuppress normalises the address the same way suppress does', async () => {
  resetWorld();
  const cap = silence();
  try {
    await suppression.suppress('Person@Example.com', 'complaint');
    assert.strictEqual(await suppression.unsuppress('  PERSON@example.COM  '), true);
    assert.strictEqual(await suppression.suppressionReason('person@example.com'), null);
  } finally { cap.restore(); }
});

test('unsuppress is not reachable from any router in the app', () => {
  // Taking an address off a do-not-mail list is a promise somebody makes on
  // purpose. A public button would let anyone clear a complaint a real person
  // filed, so this pins that the only caller is an operator path added
  // deliberately, not a route that drifted in.
  const fs = require('node:fs');
  const path = require('node:path');
  const routesDir = path.join(__dirname, '..', 'routes');
  const offenders = fs.readdirSync(routesDir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /\bunsuppress\b/.test(fs.readFileSync(path.join(routesDir, f), 'utf8')))
    .filter((f) => f !== 'admin.js');
  assert.deepStrictEqual(offenders, [], 'only an admin-only route may clear a suppression');
});

// ===========================================================================
// 8. The alarm's own dedupe map, which said it was bounded and was not
// ===========================================================================
// Adversarial pass over d9a3567, 2026-08-26. raiseEmailAlarm's own comment read
// "Bounded, and swept STALE-FIRST rather than cleared", and
// utils/cacheKeyInventory.js recorded `bound: '2k entries, stale-first sweep'`.
// Both were describing a sweep that cannot bound anything on its own.
//
// The value stored against every key is a UTC DAY STRING, and the sweep deletes
// only the entries whose day is not today. So on the one day the map actually
// fills up, nothing in it is stale, the loop frees nothing at all, and the map
// grows past its ceiling without limit. Two of the five alarm keys carry a
// recipient address (`locked-out:` and `emergency-loop:`), so the entry count is
// the number of DISTINCT ADDRESSES the alarm has spoken about since midnight.
//
// This is a REAL gap and it is not a reachable one today: filling it needs
// thousands of distinct addresses on email_suppressions inside one day, and the
// only writer to that table is the Resend bounce webhook. It is pinned because
// the claim was written down twice as a fact somebody would rely on, and
// because a growth bound that only holds on the day AFTER the problem is not a
// bound.
test('the alarm dedupe map is bounded on the day it fills, not only the day after', () => {
  resetWorld();
  const cap = silence();
  try {
    const { alarmKeysMax } = emailService.emailHealthStatus();
    assert.ok(Number.isInteger(alarmKeysMax) && alarmKeysMax > 0,
      'emailHealthStatus no longer reports the ceiling, so nothing can measure it');

    // Every one of these is a DIFFERENT address on the SAME day, which is
    // exactly the shape the stale sweep cannot touch. Driven through the real
    // send path rather than by poking the map, so this measures the alarm the
    // product actually raises.
    const overshoot = alarmKeysMax + 500;
    for (let i = 0; i < overshoot; i += 1) {
      emailService.raiseEmailAlarm(`probe:${i}@example.com`, 'a locked-out address', { i });
    }

    const after = emailService.emailHealthStatus();
    assert.ok(after.alarmKeys <= alarmKeysMax + 1,
      `the alarm map holds ${after.alarmKeys} entries against a stated ceiling of ${alarmKeysMax}. `
      + 'The stale-first sweep deletes only entries from a PREVIOUS day, so on the day the map fills it '
      + 'frees nothing and grows without limit. Two of the keys carry a recipient address.');
  } finally { cap.restore(); }
});

test('an alarm that has already spoken today still stays quiet after the map has been swept', () => {
  // The other half. Evicting to hold the bound must not evict so eagerly that
  // the dedupe stops working for the condition that just spoke, because a
  // repeated alarm is the failure this map exists to prevent.
  resetWorld();
  const cap = silence();
  try {
    const { alarmKeysMax } = emailService.emailHealthStatus();
    for (let i = 0; i < alarmKeysMax + 200; i += 1) {
      emailService.raiseEmailAlarm(`probe:${i}@example.com`, 'a locked-out address');
    }
    // The most recent key is the one furthest from eviction, and it must not
    // speak twice.
    const again = emailService.raiseEmailAlarm(
      `probe:${alarmKeysMax + 199}@example.com`, 'a locked-out address'
    );
    assert.strictEqual(again, false,
      'the alarm repeated a condition it had already reported today. The eviction that holds the bound '
      + 'has taken the dedupe with it.');
  } finally { cap.restore(); }
});

test('a broken alarm can never break a send', async () => {
  // The watchdog rule stated at the top of the alarm block: "IT REPORTS, IT
  // NEVER REFUSES ... A watchdog that can break the thing it watches is worse
  // than no watchdog." Measured rather than trusted, by taking away the two
  // things it writes to.
  resetWorld();
  const r = stubResend();
  const realError = console.error;
  const realWarn = console.warn;
  try {
    await withEnv({ RESEND_API_KEY: 'k', NODE_ENV: 'production' }, async () => {
      emailService.resetClient();
      console.error = () => { throw new Error('the log stream is gone'); };
      console.warn = () => { throw new Error('the log stream is gone'); };
      const out = await emailService.sendEmail({
        to: 'watchdog@example.com', subject: 's', html: '<p>x</p>',
      });
      assert.strictEqual(out.sent, true,
        'a throwing console took the send down with it. The alarm is allowed to say nothing; it is not '
        + 'allowed to stop a password reset.');
    });
  } finally {
    console.error = realError;
    console.warn = realWarn;
    r.restore();
  }
});

test('the emergency category is never caller data, so an ordinary message cannot present as one', () => {
  // The emergency category is the one bypass in this file: it skips the
  // do-not-mail list AND, since round 27, the per-recipient counter. What keeps
  // that safe is not the string comparison, which is exact and has no trim and
  // no case fold. It is that no request body ever reaches it.
  for (const near of ['EMERGENCY', 'Emergency', ' emergency', 'emergency ', 'emergenc', 'emergency ']) {
    assert.notStrictEqual(near, EMERGENCY,
      `${JSON.stringify(near)} is being treated as the emergency category`);
  }

  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  for (const d of ['routes', 'services', 'sockets', 'utils', 'middleware']) walk(path.join(root, d));

  // Scoped to the SEND call sites. `category:` on its own is far too common to
  // sweep for: routes/events.js carries a Ticketmaster event genre under that
  // exact name and it has nothing to do with email.
  const CALL = /\b(?:emailService\.)?send(?:Email|AlertEmail)\s*\(/g;
  let sites = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    let call;
    CALL.lastIndex = 0;
    while ((call = CALL.exec(src))) {
      sites += 1;
      // The argument text, bounded. Long enough to reach the category on every
      // real call site and short enough not to wander into the next statement.
      const args = src.slice(call.index, call.index + 900);
      const m = /category:\s*([^,\n}]+)/.exec(args);
      if (!m) continue;
      const value = m[1].trim();
      const ok = /^'[^']*'$/.test(value)
        || /^"[^"]*"$/.test(value)
        || value === 'EMERGENCY_CATEGORY';
      assert.ok(ok,
        `${path.relative(root, file).replace(/\\/g, '/')} names an email category as ${value}. The `
        + 'emergency category skips the do-not-mail list and the per-recipient cap, so it may only ever '
        + 'be a literal in the code or the shared constant, never anything a caller sends.');
    }
  }
  assert.ok(sites >= 6,
    `this sweep found only ${sites} send call sites, which means it stopped matching them and is no `
    + 'longer measuring anything');

  // routes/safety.js is the one indirection: sendAlertEmail forwards a
  // `category` variable down to sendEmail. Its own signature is what decides
  // what that variable can be, so it is read here rather than assumed.
  const safety = fs.readFileSync(path.join(root, 'routes', 'safety.js'), 'utf8');
  assert.match(safety,
    /async function sendAlertEmail\([^)]*\{\s*category\s*=\s*'transactional'\s*\}\s*=\s*\{\}\s*\)/,
    'sendAlertEmail no longer defaults its category to a literal, so a caller that omits it decides '
    + 'nothing and a caller that passes a request value decides everything');
  const emergencyCallers = safety.match(/category:\s*EMERGENCY_CATEGORY/g) || [];
  assert.strictEqual(emergencyCallers.length, 2,
    'the emergency category has gained or lost a caller in routes/safety.js. There are exactly two by '
    + 'design, the alert and its stand-down, and emailSuppression.js asks that a third make its argument '
    + 'in writing first.');
});

test('what one address can absorb in a day, now that the counter is keyed on category', async () => {
  // NOT A DEFECT, PINNED SO IT STAYS A DECISION. Keying the counter on the
  // category was the right fix for the right reason: a digest flood must never
  // be why a password reset is refused. It also multiplies the ceiling. The cap
  // is per (category, address), so one address absorbs the cap once per capped
  // category instead of once in total, and the emergency category is uncapped
  // on top of that. 60 in total became 300 per capped category.
  //
  // It stands because of who can aim it. Exactly one path lets a caller name
  // its own recipient (an unauthenticated waitlist signup), and naming your own
  // address only spends your own allowance; every other sender resolves the
  // address from a database row. What this test exists to catch is a THIRD
  // capped category arriving without anybody noticing the total moved again.
  resetWorld();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: undefined }, async () => {
      const seen = {};
      for (const category of ['transactional', 'marketing', EMERGENCY]) {
        let through = 0;
        const tries = emailService.PER_RECIPIENT_DAILY_CAP + 40;
        for (let i = 0; i < tries; i += 1) {
          // No key set, so a message that gets past the counter comes back
          // `skipped` rather than sent. That is what makes this measure the
          // COUNTER and nothing downstream of it.
          const out = await emailService.sendEmail({
            to: 'one@example.com', subject: 's', html: '<p>x</p>', category,
          });
          if (out.skipped) through += 1;
        }
        seen[category] = through;
      }
      assert.strictEqual(seen.transactional, emailService.PER_RECIPIENT_DAILY_CAP);
      assert.strictEqual(seen.marketing, emailService.PER_RECIPIENT_DAILY_CAP);
      assert.strictEqual(seen[EMERGENCY], emailService.PER_RECIPIENT_DAILY_CAP + 40,
        'the emergency category is capped again. An SOS alert and, worse, the stand-down that tells a '
        + 'parent it is over, are back to being eatable by a counter built to stop marketing loops.');
    });
  } finally { cap.restore(); }
});
