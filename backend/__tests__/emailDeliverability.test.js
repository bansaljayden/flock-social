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
