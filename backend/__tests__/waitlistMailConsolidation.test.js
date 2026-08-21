// Run: node --test  (from backend/)
//
// ===========================================================================
// routes/waitlist.js x services/emailService.js — the mail consolidation
// ===========================================================================
// The waitlist route was the last caller holding its own Resend client, its
// own null-key skip and its own copy of the abort signal, which meant it had
// PART of the service's hardening and none of the rest: no settle contract of
// the service's making, no recipient gate, no pinned logo host. The
// confirmation now goes through emailService.sendWaitlistConfirmation, so the
// route inherits the whole contract instead of re-implementing half:
//
//   1. the send settles, never rejects — a provider outage, a 4xx, or a
//      broken `resend` install costs the confirmation, never the 201 or the
//      committed row;
//   2. a missing RESEND_API_KEY is a logged skip, the provider is never
//      consulted, and the route hands the daily mail-budget claim back — the
//      budget bounds outbound MAIL, and a skip sent none;
//   3. every send carries upstreamSignal('email') (round 12);
//   4. nothing the user typed can become markup in the message: the body
//      interpolates no user-supplied value at all, and an address that could
//      carry markup (< > ") is refused before the provider is consulted;
//   5. the copy is the route's own, post-fb55915: plain "The Flock Team"
//      signoff, logo on the pinned www host, no em dashes, no slop words.
//
// The route's OWN controls did not move: per-IP throttle, global daily mail
// budget, and the ON CONFLICT dedupe are still the route's, and are pinned
// here from the outside.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'test-secret-waitlist-mail-consolidation';
delete process.env.RESEND_API_KEY;   // set per test via withEnv
delete process.env.PUBLIC_WEB_URL;   // the pinned production bases get exercised
delete process.env.PUBLIC_API_URL;
delete process.env.FIREBASE_SERVICE_ACCOUNT;

// ── Database, faked (same pattern as edgeCaseSweep.test.js) ────────────────
const pool = require('../config/database');
let queries = [];
// Called for the waitlist INSERT; swapped per test to simulate the dedupe.
let insertResult = () => ({ rows: [{ id: 1 }], rowCount: 1 });
pool.query = (text, params) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  queries.push({ sql, params: params || [] });
  if (/^INSERT INTO waitlist/i.test(sql)) return Promise.resolve(insertResult(params || []));
  return Promise.resolve({ rows: [], rowCount: 0 });
};
pool.connect = async () => ({ query: pool.query, release: () => {} });

const emailService = require('../services/emailService');
const waitlistRouter = require('../routes/waitlist');

// ── The `resend` package, replaced (same as emailServiceResilience.test.js) ─
// emailService builds its client lazily inside sendEmail, so swapping the
// module in require.cache between tests is enough — provided the client cache
// is reset, which beforeEach below does.
const RESEND_PATH = require.resolve('resend');

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

// ── The route, mounted for real ────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/waitlist', waitlistRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((r) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); });
}));
test.after(() => new Promise((r) => server.close(() => r())));

test.beforeEach(() => {
  queries = [];
  insertResult = () => ({ rows: [{ id: 1 }], rowCount: 1 });
  waitlistRouter.__test.reset();
  emailService.resetClient();
});

async function signup(email) {
  const res = await fetch(base + '/api/waitlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, body: json };
}

// ===========================================================================
// 1. The send moved: one message, through the service, with its deadline
// ===========================================================================

test('consolidation: a new signup mails one confirmation through the service, deadline and all', async () => {
  const r = stubResend();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      const res = await signup('Ava@Example.com ');
      assert.strictEqual(res.status, 201, res.text);
      assert.strictEqual(r.sends.length, 1, 'exactly one confirmation send');
      const { payload, options } = r.sends[0];
      // normalizeEmail lowercased what the person typed; the send goes to the
      // stored address, not the raw one.
      assert.strictEqual(payload.to, 'ava@example.com');
      assert.strictEqual(payload.from, 'Flock <hello@flockcorp.com>');
      assert.strictEqual(payload.subject, "You're on the Flock waitlist");
      assert.ok(options && options.signal instanceof AbortSignal,
        'round 12: every send carries an abort signal');
      assert.strictEqual(waitlistRouter.__test.mailSendsToday(), 1,
        'a real send spends the daily budget');
    });
  } finally { r.restore(); emailService.resetClient(); }
});

test('consolidation: the route no longer owns a mail client, a signal, or a template', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'waitlist.js'), 'utf8');
  // Comments in this codebase quote removed lines to record why they were
  // removed; strip them so a quote cannot read as the line coming back.
  const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/require\(['"]resend['"]\)/.test(code), 'the route requires the resend package');
  assert.ok(!/new Resend/.test(code), 'the route builds its own Resend client');
  assert.ok(!/emails\.send/.test(code), 'the route calls the provider directly');
  assert.ok(!/upstreamSignal/.test(code), 'the abort signal belongs to the service now');
  assert.ok(!/<div style=/.test(code), 'the HTML template belongs to the service now');
  assert.ok(/require\(['"]\.\.\/services\/emailService['"]\)/.test(code),
    'the route must import the service');
  assert.ok(/sendWaitlistConfirmation/.test(code), 'the route must use the service sender');
});

// ===========================================================================
// 2. The settle contract, exercised through the route
// ===========================================================================

test('contract: a provider outage costs the confirmation, never the 201 or the row', async () => {
  const r = stubResend({ throws: 'socket hang up' });
  const cap = captureConsole();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      const res = await signup('ava@example.com');
      assert.strictEqual(res.status, 201, `outage leaked into the response: ${res.text}`);
      assert.match(res.body.message, /on the list/i);
      assert.strictEqual(queries.filter((q) => /^INSERT INTO waitlist/i.test(q.sql)).length, 1,
        'the signup row must be committed regardless of the mail');
      // A failure that reached the provider stays charged — only a SKIP
      // (nothing attempted) is refunded.
      assert.strictEqual(waitlistRouter.__test.mailSendsToday(), 1);
    });
  } finally { cap.restore(); r.restore(); emailService.resetClient(); }
});

test('contract: a provider 4xx (error object, no throw) settles the same way', async () => {
  const r = stubResend({ error: { message: 'validation_error: from is not allowed' } });
  const cap = captureConsole();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      const res = await signup('ava@example.com');
      assert.strictEqual(res.status, 201, res.text);
    });
  } finally { cap.restore(); r.restore(); emailService.resetClient(); }
});

test('contract: a resend module whose constructor throws still cannot 500 the signup', async () => {
  const r = stubBrokenResendModule();
  const cap = captureConsole();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      const res = await signup('ava@example.com');
      assert.strictEqual(res.status, 201, res.text);
    });
  } finally { cap.restore(); r.restore(); emailService.resetClient(); }
});

// ===========================================================================
// 3. Missing key: a logged skip, and the mail budget is handed back
// ===========================================================================

test('missing key: signup succeeds, the provider is never consulted, the budget is not spent', async () => {
  const r = stubResend();
  const cap = captureConsole();
  try {
    await withEnv({ RESEND_API_KEY: undefined }, async () => {
      emailService.resetClient();
      const res = await signup('ava@example.com');
      assert.strictEqual(res.status, 201, res.text);
      assert.strictEqual(r.sends.length, 0, 'no key means no provider call, ever');
      assert.strictEqual(waitlistRouter.__test.mailSendsToday(), 0,
        'a skipped send spent no outbound mail, so the claim must be refunded');
      assert.match(cap.text(), /RESEND_API_KEY not set/, 'the skip must be visible in the log');
    });
  } finally { cap.restore(); r.restore(); emailService.resetClient(); }
});

// ===========================================================================
// 4. The route's own controls did not move
// ===========================================================================

test('budget: an exhausted mail budget skips the service entirely and still records the signup', async () => {
  const r = stubResend();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      waitlistRouter.__test.exhaustMailBudget();
      const res = await signup('late@example.com');
      assert.strictEqual(res.status, 201, res.text);
      assert.strictEqual(r.sends.length, 0, 'a spent budget means the service is never called');
      assert.strictEqual(queries.filter((q) => /^INSERT INTO waitlist/i.test(q.sql)).length, 1);
    });
  } finally { r.restore(); emailService.resetClient(); }
});

test('dedupe: an address already on the list gets its polite 201 and no second email', async () => {
  const r = stubResend();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      let n = 0;
      insertResult = () => (++n === 1 ? { rows: [{ id: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 });
      const first = await signup('ava@example.com');
      const second = await signup('ava@example.com');
      assert.strictEqual(first.status, 201, first.text);
      assert.strictEqual(second.status, 201, second.text);
      assert.match(second.body.message, /already/i);
      assert.strictEqual(r.sends.length, 1, 'the duplicate must not be mailed again');
    });
  } finally { r.restore(); emailService.resetClient(); }
});

test('throttle: the per-IP hourly budget still bites, with the mail path live', async () => {
  const r = stubResend();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      const limit = waitlistRouter.__test.WAITLIST_IP_HOURLY;
      for (let i = 0; i < limit; i++) {
        const ok = await signup(`a${i}@example.com`);
        assert.strictEqual(ok.status, 201, `signup ${i}: ${ok.text}`);
      }
      const refused = await signup('over@example.com');
      assert.strictEqual(refused.status, 429, refused.text);
      assert.strictEqual(r.sends.length, limit, 'the refused signup must not be mailed');
    });
  } finally { r.restore(); emailService.resetClient(); }
});

// ===========================================================================
// 5. Injection: what the user typed cannot become markup in the message
// ===========================================================================

test('injection: the typed address never appears in the HTML body at all', async () => {
  // The message used to interpolate no user value at all, so two signups
  // produced byte-identical HTML. It cannot any more: CAN-SPAM needs an
  // unsubscribe link in this message, and an unsubscribe link that is not
  // keyed on the recipient is one that takes other people off the list. So the
  // invariant moves rather than being dropped, and it moves to the sharper
  // version of the same claim: the ONLY thing that varies is the token, the
  // token's alphabet is base64url plus one dot, and no character a person
  // typed reaches the markup in a form that could break out of it.
  const r = stubResend();
  try {
    await withEnv({ RESEND_API_KEY: 'k', JWT_SECRET: 'test-secret-for-unsubscribe-tokens' }, async () => {
      emailService.resetClient();
      const quirky = "o'brien&sons@example.com"; // mailable, and HTML-meaningful if interpolated raw
      const a = await signup(quirky);
      waitlistRouter.__test.reset();
      const b = await signup('plain@example.com');
      assert.strictEqual(a.status, 201, a.text);
      assert.strictEqual(b.status, 201, b.text);
      assert.strictEqual(r.sends.length, 2);
      const html = r.sends[0].payload.html;
      assert.ok(!html.includes(quirky), 'the raw address reached the HTML body');
      assert.ok(!html.includes("o'brien"), 'part of the address reached the HTML body');
      assert.ok(!html.includes('&sons'), 'an unescaped ampersand from the address reached the HTML body');

      // Everything outside the token is still byte-identical between the two.
      const stripToken = (s) => s.replace(/token=[^"]*/g, 'token=X');
      assert.strictEqual(stripToken(html), stripToken(r.sends[1].payload.html),
        'nothing but the unsubscribe token may vary with the address');

      // The token's alphabet. base64url has no <, >, ", & or quote in it, so a
      // hostile address cannot survive the encoding as markup.
      const token = /token=([^"]+)/.exec(html)[1];
      assert.match(token, /^[A-Za-z0-9._~%-]+$/, 'the unsubscribe token carries characters that could break the href');
    });
  } finally { r.restore(); emailService.resetClient(); }
});

test('the waitlist mail carries a working unsubscribe: a body link, the RFC 8058 header pair, and a text part', async () => {
  // The message says "We'll let you know as soon as it's ready", which is an
  // announced future mailing to a list collected on a public marketing page.
  // It shipped with no link, no header, and no column that could have recorded
  // a request to stop.
  const r = stubResend();
  try {
    await withEnv({ RESEND_API_KEY: 'k', JWT_SECRET: 'test-secret-for-unsubscribe-tokens' }, async () => {
      emailService.resetClient();
      const out = await emailService.sendWaitlistConfirmation({ to: 'someone@example.com' });
      assert.strictEqual(out.sent, true);
      const payload = r.sends[0].payload;
      assert.match(payload.html, /\/api\/unsubscribe\?token=/, 'no unsubscribe link in the body');
      assert.match(payload.headers['List-Unsubscribe'], /^<https:\/\/[^>]+\/api\/unsubscribe\?token=[^>]+>$/);
      assert.strictEqual(payload.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
      assert.ok(typeof payload.text === 'string' && payload.text.includes('/api/unsubscribe?token='),
        'the plain-text part needs the link too, or a text-only reader cannot unsubscribe');
      assert.ok(!/[—–]/.test(payload.text), 'no em dash in user-visible copy (SLOP-AUDIT.md)');
    });
  } finally { r.restore(); emailService.resetClient(); }
});

test('injection: an address that could carry markup is refused before the provider', async () => {
  // Defense in depth below the route's validator: even if a future validator
  // change let a quoted local part through, sendEmail's recipient gate
  // (isMailableAddress excludes < > ") refuses it before any provider call.
  const r = stubResend();
  const cap = captureConsole();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      for (const to of [
        '<img src=x onerror=alert(1)>@evil.co',
        '"quoted"@evil.co',
        'a@b.co,c@d.co',
        ['a@b.co'],
      ]) {
        const out = await emailService.sendWaitlistConfirmation({ to });
        assert.strictEqual(out.sent, false, `mailed ${JSON.stringify(to)}`);
        assert.strictEqual(out.skipped, undefined, 'a refusal is an error, not a skip');
      }
      assert.strictEqual(r.sends.length, 0, 'nothing may reach the provider');
    });
  } finally { cap.restore(); r.restore(); emailService.resetClient(); }
});

// ===========================================================================
// 6. Copy and link law: post-fb55915, re-expressed through the service
// ===========================================================================

test('copy: plain signoff, www logo host, headline intact, no em dash, no slop', async () => {
  const r = stubResend();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      const res = await signup('jess@example.com');
      assert.strictEqual(res.status, 201, res.text);
      const { subject, html } = r.sends[0].payload;
      assert.strictEqual(subject, "You're on the Flock waitlist");
      assert.ok(html.includes("You're on the list."), 'the headline moved or changed');
      assert.ok(html.includes('The Flock Team'), 'the plain signoff is the copy law (fb55915)');
      assert.ok(!/Team,|warmly|cheers|best regards/i.test(html), 'the signoff must stay plain');
      assert.ok(html.includes(`${emailService.PROD_WEB_URL}/flock-logo.png`),
        'the logo must ride the pinned www host');
      assert.ok(!/—/.test(subject + html), 'no em dashes (SLOP-AUDIT.md, first law)');
      for (const re of [/seamless/i, /effortless/i, /unlock/i, /supercharge/i, /empower/i]) {
        assert.ok(!re.test(html), `body violates ${re}`);
      }
      assert.ok(!/localhost|127\.0\.0\.1|vercel\.app|ngrok/i.test(html), 'non-production host in the body');
      assert.ok(!/http:\/\//.test(html), 'plain-http link in the body');
    });
  } finally { r.restore(); emailService.resetClient(); }
});

test('links: a dev PUBLIC_WEB_URL cannot put localhost in the confirmation', async () => {
  // The route used to read PUBLIC_WEB_URL raw, so `http://localhost:3000` in
  // the environment became the logo host in a real person's inbox. The
  // service's pickBase gates the scheme and the host and falls back to the
  // pinned production base.
  const r = stubResend();
  const cap = captureConsole();
  try {
    await withEnv({ RESEND_API_KEY: 'k', PUBLIC_WEB_URL: 'http://localhost:3000' }, async () => {
      emailService.resetClient();
      const res = await signup('jess@example.com');
      assert.strictEqual(res.status, 201, res.text);
      const { html } = r.sends[0].payload;
      assert.ok(!/localhost/.test(html), 'the dev base leaked into the mail');
      assert.ok(html.includes(`${emailService.PROD_WEB_URL}/flock-logo.png`),
        'the pinned production base must be what gets mailed');
    });
  } finally { cap.restore(); r.restore(); emailService.resetClient(); }
});
