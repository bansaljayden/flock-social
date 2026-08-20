// ===========================================================================
// services/emailService.js — resilience and contract audit
// ===========================================================================
// Every transactional message the product sends (verification, password reset,
// the OAuth "there is no password" notice, SOS alerts and moderation alerts via
// sendEmail) leaves through this one module. Three properties are load-bearing
// and each has a caller that depends on it without a safety net of its own:
//
//   1. sendEmail NEVER rejects. routes/safety.js and routes/auth.js await it
//      bare, on the strength of the "Never throws" contract line. A Resend
//      outage, a 4xx, an abort, a missing API key, or a broken `resend`
//      install must all settle as { sent:false, ... }.
//   2. A missing RESEND_API_KEY is a logged no-op, exactly as
//      backend/.env.example describes ("silently skipped"): the caller gets
//      { sent:false, skipped:true } and the provider is never consulted.
//   3. The service does not retry. Callers own throttling, so a runaway caller
//      loop must map 1:1 onto provider calls, not be amplified from inside.
//
// Plus the two content laws: user-supplied values render as text in the HTML
// part, and every link and word obeys SLOP-AUDIT.md and the pinned production
// hosts.
// ===========================================================================
const test = require('node:test');
const assert = require('node:assert');

// --- helpers (same pattern as safetyPathAudit.test.js) ---------------------

const RESEND_PATH = require.resolve('resend');

// Replace the `resend` package itself, so what the provider would have been
// handed is captured without a network call and without trusting the wrapper's
// return value.
function stubResend({ error = null, throws = null } = {}) {
  const realEntry = require.cache[RESEND_PATH];
  const sends = [];
  class FakeResend {
    constructor(key) {
      this.key = key;
      this.emails = {
        send: async (payload, options) => {
          sends.push({ payload, options, key });
          if (throws) throw new Error(throws);
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
    },
  };
}

// A `resend` module whose constructor throws: what a broken node_modules
// deploy looks like from in here. Round 21 was exactly this — the client was
// built OUTSIDE sendEmail's try, so this rejected instead of settling.
function stubBrokenResendModule() {
  const realEntry = require.cache[RESEND_PATH];
  class ExplodingResend {
    constructor() { throw new Error('resend module is broken'); }
  }
  require.cache[RESEND_PATH] = {
    id: RESEND_PATH, filename: RESEND_PATH, loaded: true, exports: { Resend: ExplodingResend },
  };
  return {
    restore() {
      if (realEntry) require.cache[RESEND_PATH] = realEntry;
      else delete require.cache[RESEND_PATH];
    },
  };
}

function captureConsole() {
  const real = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  const push = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  console.log = push; console.warn = push; console.error = push;
  return {
    text: () => lines.join('\n'),
    restore() { console.log = real.log; console.warn = real.warn; console.error = real.error; },
  };
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const out = fn();
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

const emailService = require('../services/emailService');

// PUBLIC_WEB_URL / PUBLIC_API_URL unset for these tests, so the pinned
// production bases are what gets exercised.
const CLEAN_ENV = { PUBLIC_WEB_URL: undefined, PUBLIC_API_URL: undefined };

// ===========================================================================
// 1. The settle contract: no path out of sendEmail is a rejection
// ===========================================================================

test('contract: a provider outage mid-batch settles every send, rejects none', async () => {
  const r = stubResend({ throws: 'socket hang up' });
  const cap = captureConsole();
  try {
    await withEnv({ ...CLEAN_ENV, RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      // Promise.all is the harshest consumer: one rejection loses the batch.
      // This is the moderationAlerts fan-out shape during an outage.
      const results = await Promise.all([
        emailService.sendEmail({ to: 'a@b.co', subject: 's1', html: '<p>1</p>' }),
        emailService.sendEmail({ to: 'c@d.co', subject: 's2', html: '<p>2</p>' }),
        emailService.sendEmail({ to: 'e@f.co', subject: 's3', html: '<p>3</p>' }),
      ]);
      for (const out of results) {
        assert.strictEqual(out.sent, false);
        assert.ok(out.error, 'the failure must be reported, not swallowed into success');
      }
    });
  } finally { cap.restore(); r.restore(); emailService.resetClient(); }
});

test('contract: a provider 4xx (error object, no throw) settles as sent:false with the reason', async () => {
  const r = stubResend({ error: { message: 'validation_error: from is not allowed' } });
  const cap = captureConsole();
  try {
    await withEnv({ ...CLEAN_ENV, RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      const out = await emailService.sendEmail({ to: 'a@b.co', subject: 's', html: '<p>x</p>' });
      assert.strictEqual(out.sent, false);
      assert.match(out.error, /validation_error/);
    });
  } finally { cap.restore(); r.restore(); emailService.resetClient(); }
});

test('contract: a resend module whose constructor throws still settles, not rejects', async () => {
  // Round 21. resendClient() ran outside sendEmail's try, so this exact case
  // was a rejected promise from a function documented "Never throws" — and
  // routes/safety.js awaits it bare on the SOS path.
  const r = stubBrokenResendModule();
  const cap = captureConsole();
  try {
    await withEnv({ ...CLEAN_ENV, RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      const out = await emailService.sendEmail({ to: 'a@b.co', subject: 's', html: '<p>x</p>' });
      assert.strictEqual(out.sent, false);
      assert.match(out.error, /broken/);
      assert.match(cap.text(), /\[email\]/, 'the failure must be logged, not silent');
    });
  } finally { cap.restore(); r.restore(); emailService.resetClient(); }
});

test('contract: the templated senders inherit the settle contract on every failure mode', async () => {
  for (const make of [
    () => stubResend({ throws: 'ETIMEDOUT' }),
    () => stubResend({ error: { message: 'rate_limit_exceeded' } }),
  ]) {
    const r = make();
    const cap = captureConsole();
    try {
      await withEnv({ ...CLEAN_ENV, RESEND_API_KEY: 'k' }, async () => {
        emailService.resetClient();
        const outs = await Promise.all([
          emailService.sendVerificationEmail({ to: 'a@b.co', name: 'A', link: emailService.verificationLink('t'), hours: 24 }),
          emailService.sendPasswordResetEmail({ to: 'a@b.co', name: 'A', link: emailService.passwordResetLink('t'), minutes: 60 }),
          emailService.sendPasswordResetOAuthEmail({ to: 'a@b.co', name: 'A', provider: 'google' }),
        ]);
        for (const out of outs) assert.strictEqual(out.sent, false);
      });
    } finally { cap.restore(); r.restore(); emailService.resetClient(); }
  }
});

// ===========================================================================
// 2. Missing RESEND_API_KEY: a logged no-op, exactly as .env.example says
// ===========================================================================

test('missing key: every sender degrades to a logged skip and the provider is never consulted', async () => {
  const r = stubResend();
  const cap = captureConsole();
  try {
    await withEnv({ ...CLEAN_ENV, RESEND_API_KEY: undefined }, async () => {
      emailService.resetClient();
      const outs = await Promise.all([
        emailService.sendEmail({ to: 'a@b.co', subject: 's', html: '<p>x</p>' }),
        emailService.sendVerificationEmail({ to: 'a@b.co', name: 'A', link: emailService.verificationLink('t'), hours: 24 }),
        emailService.sendPasswordResetEmail({ to: 'a@b.co', name: 'A', link: emailService.passwordResetLink('t'), minutes: 60 }),
        emailService.sendPasswordResetOAuthEmail({ to: 'a@b.co', name: 'A', provider: 'apple' }),
      ]);
      for (const out of outs) {
        assert.strictEqual(out.sent, false);
        assert.strictEqual(out.skipped, true, 'a missing key is a skip, not an error — callers branch on it');
      }
      assert.strictEqual(r.sends.length, 0, 'no key means no provider call, ever');
      assert.match(cap.text(), /RESEND_API_KEY not set/, 'the skip must be visible in the log');
    });
  } finally { cap.restore(); r.restore(); emailService.resetClient(); }
});

// ===========================================================================
// 3. No amplification: one caller send = at most one provider call
// ===========================================================================

test('no retries: five failing sends are exactly five provider calls, not more', async () => {
  // utils/upstream.js: "NEVER retry a paid call after a timeout". A runaway
  // caller loop is bad enough at 1:1; a retry inside this module would
  // multiply it against a provider that is already refusing us.
  const r = stubResend({ throws: 'socket hang up' });
  const cap = captureConsole();
  try {
    await withEnv({ ...CLEAN_ENV, RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      for (let i = 0; i < 5; i++) {
        await emailService.sendEmail({ to: 'a@b.co', subject: 's', html: '<p>x</p>' });
      }
      assert.strictEqual(r.sends.length, 5, `expected 5 provider calls, saw ${r.sends.length}`);
    });
  } finally { cap.restore(); r.restore(); emailService.resetClient(); }
});

test('deadline: every send carries an abort signal so an outage cannot park the request', async () => {
  const r = stubResend();
  try {
    await withEnv({ ...CLEAN_ENV, RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      await emailService.sendVerificationEmail({ to: 'a@b.co', name: 'A', link: emailService.verificationLink('t'), hours: 24 });
      assert.strictEqual(r.sends.length, 1);
      assert.ok(r.sends[0].options && r.sends[0].options.signal instanceof AbortSignal,
        'round 12: an undeadlined send parks an Express connection and a pg slot');
    });
  } finally { r.restore(); emailService.resetClient(); }
});

// ===========================================================================
// 3b. Extra headers: the Monday digest's RFC 8058 one-click pair
// ===========================================================================
// The digest's unsubscribe link is a GET that renders and a POST that writes
// (routes/venueDigest.js), which only works as a product if the mail client
// can do the POST itself. That is these two headers, and they are the first
// thing in the codebase to pass a header through sendEmail, so what actually
// reaches the provider is worth pinning rather than assuming.

test('headers: a caller\'s extra headers reach the provider, and a CRLF in one does not', async () => {
  const r = stubResend();
  try {
    await withEnv({ ...CLEAN_ENV, RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      await emailService.sendEmail({
        to: 'a@b.co',
        subject: 'digest',
        html: '<p>hi</p>',
        headers: {
          'List-Unsubscribe': '<https://api.example.com/opt-out?token=t>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
      assert.deepStrictEqual(r.sends[0].payload.headers, {
        'List-Unsubscribe': '<https://api.example.com/opt-out?token=t>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      });

      // Injection: a newline in a header value is a second header on the wire.
      await emailService.sendEmail({
        to: 'a@b.co',
        subject: 'digest',
        html: '<p>hi</p>',
        headers: { 'List-Unsubscribe': '<https://api.example.com/x>\r\nBcc: attacker@example.com' },
      });
      const smuggled = r.sends[1].payload.headers['List-Unsubscribe'];
      assert.ok(!/[\r\n]/.test(smuggled), smuggled);

      // A caller that passes nothing sends no `headers` key at all, so the
      // existing senders' payloads are byte-identical to what they were.
      await emailService.sendEmail({ to: 'a@b.co', subject: 'plain', html: '<p>hi</p>' });
      assert.ok(!('headers' in r.sends[2].payload));
    });
  } finally { r.restore(); emailService.resetClient(); }
});

// ===========================================================================
// 4. Injection: user-supplied values render as text in the HTML part
// ===========================================================================

const HOSTILE_NAME = '<img src=x onerror=alert(1)>';

test('injection: a hostile display name renders as text in all three templates', async () => {
  const r = stubResend();
  try {
    await withEnv({ ...CLEAN_ENV, RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      await emailService.sendVerificationEmail({ to: 'a@b.co', name: HOSTILE_NAME, link: emailService.verificationLink('t'), hours: 24 });
      await emailService.sendPasswordResetEmail({ to: 'a@b.co', name: HOSTILE_NAME, link: emailService.passwordResetLink('t'), minutes: 60 });
      await emailService.sendPasswordResetOAuthEmail({ to: 'a@b.co', name: HOSTILE_NAME, provider: 'google' });
      assert.strictEqual(r.sends.length, 3);
      for (const { payload } of r.sends) {
        assert.ok(!payload.html.includes(HOSTILE_NAME),
          'the raw payload reached the HTML body');
        assert.ok(payload.html.includes('&lt;img src=x onerror=alert(1)&gt;'),
          'the name must render as visible text, not be stripped');
      }
    });
  } finally { r.restore(); emailService.resetClient(); }
});

test("injection: O'Brien & Sons still renders as itself (escaped, not mangled)", async () => {
  const r = stubResend();
  try {
    await withEnv({ ...CLEAN_ENV, RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      await emailService.sendVerificationEmail({ to: 'a@b.co', name: "O'Brien & Sons", link: emailService.verificationLink('t'), hours: 24 });
      assert.ok(r.sends[0].payload.html.includes('O&#39;Brien &amp; Sons'));
    });
  } finally { r.restore(); emailService.resetClient(); }
});

test('injection: a link that is not a public https URL is refused, not mailed', async () => {
  // escapeHtml is about markup, not schemes: `javascript:alert(1)` survives it
  // untouched and becomes a live href. The builders only ever produce pinned
  // https links, so anything else means a caller was handed user input.
  const r = stubResend();
  const cap = captureConsole();
  try {
    await withEnv({ ...CLEAN_ENV, RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      for (const link of [
        'javascript:alert(1)',
        'http://www.flockcorp.com/verify',       // downgraded scheme
        'https://localhost:3000/verify',
        'https://169.254.169.254/verify',
        undefined, null, '', 'not a url',
      ]) {
        const a = await emailService.sendVerificationEmail({ to: 'a@b.co', name: 'A', link, hours: 24 });
        const b = await emailService.sendPasswordResetEmail({ to: 'a@b.co', name: 'A', link, minutes: 60 });
        assert.strictEqual(a.sent, false, `verification mailed link ${JSON.stringify(link)}`);
        assert.strictEqual(b.sent, false, `reset mailed link ${JSON.stringify(link)}`);
      }
      assert.strictEqual(r.sends.length, 0, 'nothing may reach the provider');
    });
  } finally { cap.restore(); r.restore(); emailService.resetClient(); }
});

test('injection: an unrecognised oauth provider value cannot reach the body', async () => {
  const r = stubResend();
  try {
    await withEnv({ ...CLEAN_ENV, RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      await emailService.sendPasswordResetOAuthEmail({ to: 'a@b.co', name: 'A', provider: '<script>x</script>' });
      const html = r.sends[0].payload.html;
      assert.ok(!html.includes('<script>'), 'provider is a whitelist, not an interpolation');
      assert.ok(html.includes('Google'), 'unknown providers fall back to the Google wording');
    });
  } finally { r.restore(); emailService.resetClient(); }
});

// ===========================================================================
// 5. Copy and link law (SLOP-AUDIT.md + pinned production hosts)
// ===========================================================================

async function renderAllTemplates() {
  const r = stubResend();
  try {
    await withEnv({ ...CLEAN_ENV, RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      await emailService.sendVerificationEmail({ to: 'a@b.co', name: 'Jess', link: emailService.verificationLink('tok'), hours: 24 });
      await emailService.sendPasswordResetEmail({ to: 'a@b.co', name: 'Jess', link: emailService.passwordResetLink('tok'), minutes: 60 });
      await emailService.sendPasswordResetOAuthEmail({ to: 'a@b.co', name: 'Jess', provider: 'apple' });
    });
    return r.sends.map((s) => s.payload);
  } finally { r.restore(); emailService.resetClient(); }
}

test('copy: no em dashes, no marketing-slop words, in any subject or body', async () => {
  const banned = [
    /—/,                    // em dash — the first law in SLOP-AUDIT.md
    /seamless/i, /effortless/i, /unlock/i, /supercharge/i, /empower/i,
    /revolutioni[sz]e/i, /game.chang/i, /elevate your/i,
    /personali[sz]e your experience/i,
  ];
  const payloads = await renderAllTemplates();
  assert.strictEqual(payloads.length, 3);
  for (const { subject, html } of payloads) {
    for (const re of banned) {
      assert.ok(!re.test(subject), `subject "${subject}" violates ${re}`);
      assert.ok(!re.test(html), `body for "${subject}" violates ${re}`);
    }
  }
});

test('links: every href points at the pinned production hosts, never localhost or a preview', async () => {
  assert.strictEqual(emailService.PROD_WEB_URL, 'https://www.flockcorp.com',
    'DOMAIN.md pins www as canonical; the apex 308s to it and an emailed link should not ride a redirect');
  assert.strictEqual(emailService.PROD_API_URL, 'https://flock-app-production.up.railway.app');

  const payloads = await renderAllTemplates();
  for (const { subject, html } of payloads) {
    assert.ok(!/localhost|127\.0\.0\.1|vercel\.app|ngrok/i.test(html),
      `body for "${subject}" carries a non-production host`);
    assert.ok(!/http:\/\//.test(html), `body for "${subject}" carries a plain-http link`);
    // Every href resolves to one of the two pinned production bases.
    for (const m of html.matchAll(/href="([^"]+)"/g)) {
      const href = m[1].replace(/&amp;/g, '&');
      assert.ok(
        href.startsWith(emailService.PROD_WEB_URL) || href.startsWith(emailService.PROD_API_URL),
        `href ${href} in "${subject}" is not a pinned production URL`
      );
    }
  }
  // And the two secret-bearing links land where their consumers actually live.
  assert.strictEqual(emailService.verificationLink('t'),
    `${emailService.PROD_API_URL}/api/auth/verify-email?token=t`);
  assert.strictEqual(emailService.passwordResetLink('t'),
    `${emailService.PROD_WEB_URL}/reset-password#token=t`);
});

test('copy: a caller that drops the TTL still mails sentences, not "undefined hours"', async () => {
  const r = stubResend();
  try {
    await withEnv({ ...CLEAN_ENV, RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      await emailService.sendVerificationEmail({ to: 'a@b.co', name: 'A', link: emailService.verificationLink('t'), hours: Symbol('boom') });
      await emailService.sendPasswordResetEmail({ to: 'a@b.co', name: 'A', link: emailService.passwordResetLink('t'), minutes: '<b>9</b>' });
      assert.ok(r.sends[0].payload.html.includes('expires in 24 hours'), 'the fallback matches the auth.js constant');
      assert.ok(r.sends[1].payload.html.includes('expires in 60 minutes'), 'a non-numeric TTL falls back, never interpolates');
      for (const { payload } of r.sends) {
        assert.ok(!/undefined|NaN|<b>/.test(payload.html));
      }
    });
  } finally { r.restore(); emailService.resetClient(); }
});
