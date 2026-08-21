// Run: node --test  (from backend/)
//
// ===========================================================================
// NOBODY GETS MAILED WHO ASKED NOT TO BE, OR WHOSE MAILBOX IS GONE.
// ===========================================================================
// Round 26 audit of the outbound-mail lane found three holes, and this file
// pins all three shut:
//
//   1. THERE WAS NO SUPPRESSION LIST. Every sender checked whether an address
//      LOOKED deliverable and whether a feature switch was on. Neither is the
//      question "did the last message to this address hard bounce". So a dead
//      mailbox kept getting the Monday digest every week forever, billed each
//      time, each bounce charged against flockcorp.com's reputation with the
//      receiving providers, which is what eventually puts everyone else's
//      password reset in spam.
//
//   2. THE WAITLIST CONFIRMATION HAD NO UNSUBSCRIBE. It announces a future
//      mailing ("We'll let you know as soon as it's ready") to addresses
//      collected on a public marketing page, and carried no link, no RFC 8058
//      header, and no column that could have recorded a request to stop.
//
//   3. NOTHING EVER HEARD ABOUT A BOUNCE. `sent: true` was the end of the
//      story; Resend's delivery webhook had no endpoint to call.
//
// The properties that matter, in the order the code meets them:
//   * the suppression check is INSIDE sendEmail, so no caller can skip it;
//   * a hard bounce blocks everything EXCEPT an emergency, an unsubscribe
//     blocks marketing only (unsubscribing from the waitlist must not break a
//     password reset), and the emergency exception is the SOS alert and
//     nothing else: a bounce is a fact about a mailbox and a complaint about a
//     venue digest is not a refusal of an ambulance;
//   * the check FAILS OPEN, because a Postgres blip swallowing an SOS is a
//     worse outcome than one wasted send;
//   * an unsubscribe token is scoped to one address and cannot be edited into
//     another recipient's;
//   * the emailed GET renders and only a POST writes, so Safe Links cannot
//     unsubscribe anyone;
//   * the webhook refuses everything without a verified Svix signature.
// ===========================================================================
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'suppression-test-secret';

// --- pg fake ---------------------------------------------------------------
const pool = require('../config/database');
let suppressionRows;   // normalised address -> reason
let selectFails;       // when true, every SELECT throws (the fail-open case)
let writeFails;        // when true, every INSERT throws
let queriesRan;

pool.query = (sql, params) => {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  queriesRan.push({ flat, params });
  if (/SELECT reason FROM email_suppressions/.test(flat)) {
    if (selectFails) return Promise.reject(new Error('connection terminated'));
    const reason = suppressionRows.get(params[0]);
    return Promise.resolve(reason ? { rows: [{ reason }], rowCount: 1 } : { rows: [], rowCount: 0 });
  }
  if (/INSERT INTO email_suppressions/.test(flat)) {
    if (writeFails) return Promise.reject(new Error('disk full'));
    const [email, reason] = params;
    const existing = suppressionRows.get(email);
    // Mirror the SQL's strengthen-only rule.
    const rank = { unsubscribe: 1, complaint: 2, bounce: 3 };
    if (!existing || rank[reason] > rank[existing]) suppressionRows.set(email, reason);
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const suppression = require('../services/emailSuppression');
const unsub = require('../services/emailUnsubscribe');
const emailService = require('../services/emailService');

function resetWorld() {
  suppressionRows = new Map();
  selectFails = false;
  writeFails = false;
  queriesRan = [];
  suppression.resetCache();
  emailService.resetRecipientBudget();
}

// --- resend fake (same seam as emailServiceResilience.test.js) --------------
const RESEND_PATH = require.resolve('resend');
function stubResend() {
  const realEntry = require.cache[RESEND_PATH];
  const sends = [];
  class FakeResend {
    constructor(key) {
      this.key = key;
      this.emails = { send: async (payload) => { sends.push(payload); return { data: { id: `msg_${sends.length}` }, error: null }; } };
    }
  }
  require.cache[RESEND_PATH] = { id: RESEND_PATH, filename: RESEND_PATH, loaded: true, exports: { Resend: FakeResend } };
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

// ===========================================================================
// 1. The check is on the send path
// ===========================================================================

test('a hard-bounced address is refused by sendEmail itself, before the provider', async () => {
  resetWorld();
  suppressionRows.set('gone@example.com', 'bounce');
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      const out = await emailService.sendEmail({
        to: 'gone@example.com', subject: 'anything', html: '<p>hi</p>',
      });
      assert.strictEqual(out.sent, false);
      assert.strictEqual(out.suppressed, true);
      assert.strictEqual(out.reason, 'bounce');
      assert.strictEqual(r.sends.length, 0, 'a suppressed address must never reach Resend');
    });
  } finally { cap.restore(); r.restore(); }
});

test('the address is matched as a mailbox, not as a string somebody typed', async () => {
  resetWorld();
  suppressionRows.set('gone@example.com', 'bounce');
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      const out = await emailService.sendEmail({
        to: '  GONE@Example.COM  ', subject: 's', html: '<p>hi</p>',
      });
      assert.strictEqual(out.suppressed, true, 'case and whitespace must not be a way back onto the list');
      assert.strictEqual(r.sends.length, 0);
    });
  } finally { cap.restore(); r.restore(); }
});

test('an unsubscribe blocks marketing and leaves a password reset alone', async () => {
  resetWorld();
  suppressionRows.set('opted@example.com', 'unsubscribe');
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      const marketing = await emailService.sendEmail({
        to: 'opted@example.com', subject: 's', html: '<p>x</p>', category: 'marketing',
      });
      assert.strictEqual(marketing.suppressed, true, 'an unsubscribe has to stop the mailing it was about');

      const transactional = await emailService.sendEmail({
        to: 'opted@example.com', subject: 's', html: '<p>x</p>',
      });
      assert.strictEqual(transactional.sent, true,
        'unsubscribing from announcements must not silently break this person password reset');
      assert.strictEqual(r.sends.length, 1);
    });
  } finally { cap.restore(); r.restore(); }
});

test('a complaint blocks transactional mail too: it is the strongest instruction to stop', async () => {
  resetWorld();
  suppressionRows.set('angry@example.com', 'complaint');
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      const out = await emailService.sendEmail({ to: 'angry@example.com', subject: 's', html: '<p>x</p>' });
      assert.strictEqual(out.suppressed, true);
      assert.strictEqual(r.sends.length, 0);
    });
  } finally { cap.restore(); r.restore(); }
});

test('an EMERGENCY walks past every suppression reason, because a bounce is not consent', async () => {
  // The defect: HARD_REASONS blocked every category, so a trusted contact whose
  // address once hard bounced, or who once hit "spam" on a Monday venue digest,
  // received no SOS alert and nobody was told. A trusted contact is a third
  // party who never signed up, typically a parent, on a product whose floor is
  // 13. A bounce is a fact about a mailbox on one past day; a complaint is a
  // refusal of the thing complained about. Neither is a refusal of an
  // emergency from the person who named that contact, and the cost of being
  // wrong the other way is an alert that is never sent and never seen to fail.
  for (const reason of ['bounce', 'complaint', 'unsubscribe']) {
    resetWorld();
    suppressionRows.set('parent@example.com', reason);
    const r = stubResend();
    const cap = silence();
    try {
      // eslint-disable-next-line no-loop-func
      await withEnv({ RESEND_API_KEY: 'k' }, async () => {
        emailService.resetClient();
        const blocked = await emailService.sendEmail({
          to: 'parent@example.com', subject: 's', html: '<p>x</p>',
        });
        if (reason === 'unsubscribe') {
          assert.strictEqual(blocked.sent, true, 'an unsubscribe never blocked transactional mail');
        } else {
          assert.strictEqual(blocked.suppressed, true,
            `a ${reason} must still stop ordinary transactional mail`);
        }

        const emergency = await emailService.sendEmail({
          to: 'parent@example.com', subject: 's', html: '<p>x</p>', category: 'emergency',
        });
        assert.strictEqual(emergency.sent, true,
          `a ${reason} must not stop an emergency alert`);
        assert.notStrictEqual(emergency.suppressed, true);
      });
    } finally { cap.restore(); r.restore(); }
  }
});

test('the emergency bypass does not even ask the database, so a blip cannot delay it', async () => {
  resetWorld();
  selectFails = true;
  const out = await suppression.checkSendAllowed('parent@example.com', 'emergency');
  assert.strictEqual(out.blocked, false);
  assert.strictEqual(out.bypassed, true);
  assert.strictEqual(
    queriesRan.filter((q) => /SELECT reason FROM email_suppressions/.test(q.flat)).length, 0,
    'an emergency is going to send whatever the answer is, so it must not wait for one'
  );
});

test('the bypass is one category and one word: nothing else is treated as an emergency', async () => {
  resetWorld();
  suppressionRows.set('gone@example.com', 'bounce');
  for (const category of ['transactional', 'marketing', 'Emergency', 'urgent', undefined]) {
    const out = await suppression.checkSendAllowed('gone@example.com', category);
    assert.strictEqual(out.blocked, true, `${category} must not be a way past a hard bounce`);
  }
});

test('the lookup FAILS OPEN: a database outage must not swallow an SOS alert', async () => {
  resetWorld();
  selectFails = true;
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      const out = await emailService.sendEmail({ to: 'mum@example.com', subject: 'Emergency', html: '<p>x</p>' });
      assert.strictEqual(out.sent, true, 'a Postgres blip must not become a blocked emergency alert');
      assert.match(cap.text(), /lookup failed/);
    });
  } finally { cap.restore(); r.restore(); }
});

test('the strengthen-only rule: an unsubscribe cannot downgrade a recorded bounce', async () => {
  resetWorld();
  await suppression.suppress('dead@example.com', 'bounce', 'permanent bounce');
  await suppression.suppress('dead@example.com', 'unsubscribe', 'link');
  assert.strictEqual(suppressionRows.get('dead@example.com'), 'bounce');
});

test('a suppression that could not be written is reported as a failure, not swallowed', async () => {
  resetWorld();
  writeFails = true;
  const cap = silence();
  try {
    assert.strictEqual(await suppression.suppress('x@example.com', 'bounce'), false);
  } finally { cap.restore(); }
});

// ===========================================================================
// 2. The per-recipient daily cap
// ===========================================================================

test('a send loop is stopped at the per-recipient daily cap, whatever the caller does', async () => {
  resetWorld();
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      const n = emailService.PER_RECIPIENT_DAILY_CAP;
      for (let i = 0; i < n; i++) {
        const out = await emailService.sendEmail({ to: 'loop@example.com', subject: 's', html: '<p>x</p>' });
        assert.strictEqual(out.sent, true, `send ${i + 1} should have gone`);
      }
      const over = await emailService.sendEmail({ to: 'loop@example.com', subject: 's', html: '<p>x</p>' });
      assert.strictEqual(over.sent, false);
      assert.strictEqual(over.refused, true, 'a caller that retries must be told nothing was sent');
      assert.strictEqual(r.sends.length, n, 'the provider must not be charged past the cap');
      assert.match(cap.text(), /send loop/);
    });
  } finally { cap.restore(); r.restore(); }
});

test('the cap is per recipient, so one busy address does not mute another', async () => {
  resetWorld();
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      for (let i = 0; i < emailService.PER_RECIPIENT_DAILY_CAP; i++) {
        await emailService.sendEmail({ to: 'busy@example.com', subject: 's', html: '<p>x</p>' });
      }
      const other = await emailService.sendEmail({ to: 'quiet@example.com', subject: 's', html: '<p>x</p>' });
      assert.strictEqual(other.sent, true);
    });
  } finally { cap.restore(); r.restore(); }
});

// ===========================================================================
// 3. The unsubscribe token
// ===========================================================================

test('the token round-trips the address it was minted for', () => {
  const t = unsub.mintUnsubscribeToken('Person@Example.com');
  assert.strictEqual(unsub.verifyUnsubscribeToken(t), 'person@example.com');
});

test('one recipient cannot edit their link into another recipient unsubscribe', () => {
  const mine = unsub.mintUnsubscribeToken('me@example.com');
  const theirs = unsub.mintUnsubscribeToken('victim@example.com');
  const [, myMac] = mine.split('.');
  const [theirBody] = theirs.split('.');
  // Swap in the victim's address, keep my signature. This is the whole attack.
  assert.strictEqual(unsub.verifyUnsubscribeToken(`${theirBody}.${myMac}`), null);
  // And the body alone, unsigned.
  assert.strictEqual(unsub.verifyUnsubscribeToken(theirBody), null);
  assert.strictEqual(unsub.verifyUnsubscribeToken(`${theirBody}.`), null);
});

test('garbage, empty and wrong-shaped tokens are refused without throwing', () => {
  for (const bad of ['', 'x', 'a.b.c', '....', null, undefined, 42, {}, 'ZZZZ.ZZZZ']) {
    assert.strictEqual(unsub.verifyUnsubscribeToken(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test('a token minted under a different JWT_SECRET does not verify', () => {
  const t = withEnv({ JWT_SECRET: 'other-secret' }, () => unsub.mintUnsubscribeToken('a@example.com'));
  assert.strictEqual(unsub.verifyUnsubscribeToken(t), null);
});

test('the unsubscribe key is DERIVED, so a session token cannot verify as one', () => {
  const jwtLib = require('jsonwebtoken');
  const session = jwtLib.sign({ userId: 1 }, process.env.JWT_SECRET);
  assert.strictEqual(unsub.verifyUnsubscribeToken(session), null);
});

// ===========================================================================
// 4. The unsubscribe route: GET renders, POST writes
// ===========================================================================

function serveRouter(mountPath, router) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(mountPath, router);
  return app;
}

function request(app, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, path, method, headers,
      }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, text }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (body !== undefined) req.write(body);
      req.end();
    });
  });
}

const unsubscribeApp = () => serveRouter('/api/unsubscribe', require('../routes/unsubscribe'));

test('the emailed GET only renders: it draws a button and writes nothing', async () => {
  resetWorld();
  const token = unsub.mintUnsubscribeToken('reader@example.com');
  const res = await request(unsubscribeApp(), 'GET', `/api/unsubscribe?token=${encodeURIComponent(token)}`);
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /<form method="post"/);
  assert.strictEqual(suppressionRows.size, 0,
    'a Safe Links scanner fetching this URL must not take anyone off the list');
  assert.ok(!queriesRan.some((q) => /INSERT INTO email_suppressions/.test(q.flat)));
});

test('the page never echoes the address back', async () => {
  resetWorld();
  const token = unsub.mintUnsubscribeToken('reader@example.com');
  const res = await request(unsubscribeApp(), 'GET', `/api/unsubscribe?token=${encodeURIComponent(token)}`);
  assert.ok(!res.text.includes('reader@example.com'));
});

test('POST is the write, and a second POST is a success rather than an error', async () => {
  resetWorld();
  const token = unsub.mintUnsubscribeToken('bye@example.com');
  const path = `/api/unsubscribe?token=${encodeURIComponent(token)}`;
  const first = await request(unsubscribeApp(), 'POST', path);
  assert.strictEqual(first.status, 200);
  assert.match(first.text, /off the list/i);
  assert.strictEqual(suppressionRows.get('bye@example.com'), 'unsubscribe');

  const second = await request(unsubscribeApp(), 'POST', path);
  assert.strictEqual(second.status, 200, 'a repeat click is a success, not an error');
});

test('an already-unsubscribed address sees the plain page, not a button', async () => {
  resetWorld();
  suppressionRows.set('done@example.com', 'unsubscribe');
  const token = unsub.mintUnsubscribeToken('done@example.com');
  const res = await request(unsubscribeApp(), 'GET', `/api/unsubscribe?token=${encodeURIComponent(token)}`);
  assert.strictEqual(res.status, 200);
  assert.ok(!res.text.includes('<form'), 'nothing left to confirm');
});

test('a bad or missing token is refused on BOTH verbs, with no write', async () => {
  resetWorld();
  const cap = silence();
  try {
    for (const method of ['GET', 'POST']) {
      const missing = await request(unsubscribeApp(), method, '/api/unsubscribe');
      assert.strictEqual(missing.status, 400);
      const bad = await request(unsubscribeApp(), method, '/api/unsubscribe?token=nonsense');
      assert.strictEqual(bad.status, 400);
    }
    assert.strictEqual(suppressionRows.size, 0);
  } finally { cap.restore(); }
});

test('a write that failed answers 500, not the page that says it worked', async () => {
  resetWorld();
  writeFails = true;
  const cap = silence();
  try {
    const token = unsub.mintUnsubscribeToken('bye@example.com');
    const res = await request(unsubscribeApp(), 'POST', `/api/unsubscribe?token=${encodeURIComponent(token)}`);
    assert.strictEqual(res.status, 500);
    assert.ok(!/You are off the list/.test(res.text),
      'a failed write must not answer with the page that says it succeeded');
    assert.match(res.text, /could not save that/i);
  } finally { cap.restore(); }
});

// ===========================================================================
// 5. The Resend webhook
// ===========================================================================

const WEBHOOK_SECRET_RAW = crypto.randomBytes(24).toString('base64');

function webhookApp() {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/api/email-events', require('../routes/emailWebhook'));
  return app;
}

function signedPost(app, payload, { secret = WEBHOOK_SECRET_RAW, id = 'msg_1', timestamp, tamper } = {}) {
  const body = JSON.stringify(payload);
  const ts = String(timestamp != null ? timestamp : Math.floor(Date.now() / 1000));
  const mac = crypto.createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(`${id}.${ts}.${body}`).digest('base64');
  return request(app, 'POST', '/api/email-events', {
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(tamper || body),
      'svix-id': id,
      'svix-timestamp': ts,
      'svix-signature': `v1,${mac}`,
    },
    body: tamper || body,
  });
}

const bounced = (to, type = 'Permanent') => ({
  type: 'email.bounced',
  data: { to: [to], bounce: { type, subType: 'General' } },
});

test('a signed permanent bounce suppresses the address', async () => {
  resetWorld();
  const cap = silence();
  try {
    await withEnv({ RESEND_WEBHOOK_SECRET: `whsec_${WEBHOOK_SECRET_RAW}` }, async () => {
      const res = await signedPost(webhookApp(), bounced('dead@example.com'));
      assert.strictEqual(res.status, 200);
      assert.strictEqual(suppressionRows.get('dead@example.com'), 'bounce');
    });
  } finally { cap.restore(); }
});

test('a SOFT bounce is acknowledged and suppresses nobody', async () => {
  resetWorld();
  const cap = silence();
  try {
    await withEnv({ RESEND_WEBHOOK_SECRET: `whsec_${WEBHOOK_SECRET_RAW}` }, async () => {
      const res = await signedPost(webhookApp(), bounced('full@example.com', 'Transient'));
      assert.strictEqual(res.status, 200);
      assert.strictEqual(suppressionRows.size, 0,
        'a full mailbox is a bad afternoon, not a permanent do-not-mail');
    });
  } finally { cap.restore(); }
});

test('a spam complaint suppresses the address', async () => {
  resetWorld();
  const cap = silence();
  try {
    await withEnv({ RESEND_WEBHOOK_SECRET: `whsec_${WEBHOOK_SECRET_RAW}` }, async () => {
      const res = await signedPost(webhookApp(), { type: 'email.complained', data: { to: ['mad@example.com'] } });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(suppressionRows.get('mad@example.com'), 'complaint');
    });
  } finally { cap.restore(); }
});

test('an unsigned or wrongly signed event is refused, so nobody can mute an address they name', async () => {
  resetWorld();
  const cap = silence();
  try {
    await withEnv({ RESEND_WEBHOOK_SECRET: `whsec_${WEBHOOK_SECRET_RAW}` }, async () => {
      const app = webhookApp();
      const payload = bounced('victim@example.com');
      const body = JSON.stringify(payload);

      const unsigned = await request(app, 'POST', '/api/email-events', {
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        body,
      });
      assert.strictEqual(unsigned.status, 400);

      const wrongKey = await signedPost(app, payload, { secret: crypto.randomBytes(24).toString('base64') });
      assert.strictEqual(wrongKey.status, 401);

      assert.strictEqual(suppressionRows.size, 0);
    });
  } finally { cap.restore(); }
});

test('a body edited after signing is refused: the signature covers the raw bytes', async () => {
  resetWorld();
  const cap = silence();
  try {
    await withEnv({ RESEND_WEBHOOK_SECRET: `whsec_${WEBHOOK_SECRET_RAW}` }, async () => {
      const swapped = JSON.stringify(bounced('someone-else@example.com'));
      const res = await signedPost(webhookApp(), bounced('dead@example.com'), { tamper: swapped });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(suppressionRows.size, 0);
    });
  } finally { cap.restore(); }
});

test('a captured event cannot be replayed a day later', async () => {
  resetWorld();
  const cap = silence();
  try {
    await withEnv({ RESEND_WEBHOOK_SECRET: `whsec_${WEBHOOK_SECRET_RAW}` }, async () => {
      const stale = Math.floor(Date.now() / 1000) - 24 * 3600;
      const res = await signedPost(webhookApp(), bounced('dead@example.com'), { timestamp: stale });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(suppressionRows.size, 0);
    });
  } finally { cap.restore(); }
});

test('with no webhook secret configured the route refuses loudly instead of trusting the sender', async () => {
  resetWorld();
  const cap = silence();
  try {
    await withEnv({ RESEND_WEBHOOK_SECRET: undefined }, async () => {
      const res = await signedPost(webhookApp(), bounced('dead@example.com'));
      assert.strictEqual(res.status, 503);
      assert.strictEqual(suppressionRows.size, 0);
      assert.match(cap.text(), /RESEND_WEBHOOK_SECRET is not set/);
    });
  } finally { cap.restore(); }
});

test('a delivered event is acknowledged and changes nothing', async () => {
  resetWorld();
  const cap = silence();
  try {
    await withEnv({ RESEND_WEBHOOK_SECRET: `whsec_${WEBHOOK_SECRET_RAW}` }, async () => {
      const res = await signedPost(webhookApp(), { type: 'email.delivered', data: { to: ['ok@example.com'] } });
      assert.strictEqual(res.status, 200, 'a 200 is what stops Resend retrying an event we have no opinion about');
      assert.strictEqual(suppressionRows.size, 0);
    });
  } finally { cap.restore(); }
});

// ===========================================================================
// 6. server.js wiring — the same class of miss that 401'd the digest link
// ===========================================================================

test('server.js mounts /api/unsubscribe and /api/email-events ahead of the bare /api catch-alls', () => {
  const src = require('node:fs').readFileSync(require.resolve('../server.js'), 'utf8');
  const unsubscribeAt = src.indexOf("app.use('/api/unsubscribe'");
  const eventsAt = src.indexOf("app.use('/api/email-events'");
  const catchAll = src.indexOf("app.use('/api', apiLimiter, moderationRoutes)");
  assert.ok(unsubscribeAt > 0, '/api/unsubscribe is not mounted at all');
  assert.ok(eventsAt > 0, '/api/email-events is not mounted at all');
  assert.ok(catchAll > 0, 'the /api catch-all moved; this test needs updating');
  assert.ok(unsubscribeAt < catchAll,
    'an emailed unsubscribe link mounted below the catch-all is answered 401 and CAN-SPAM is not satisfied by a 401');
  assert.ok(eventsAt < catchAll, 'the webhook below the catch-all means bounces are never recorded');
});

test('the webhook path gets a parser that keeps the raw bytes, or its signature check is meaningless', () => {
  const src = require('node:fs').readFileSync(require.resolve('../server.js'), 'utf8');
  assert.match(src, /EMAIL_EVENTS_BODY_ROUTE/, 'no scoped parser row for the webhook path');
  assert.match(src, /emailWebhookParser[\s\S]{0,400}?req\.rawBody = buf/,
    'the webhook parser must capture the raw body via body-parser verify');
});
