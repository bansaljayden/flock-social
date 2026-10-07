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

// `bodiless` sends a POST with neither Content-Length nor Transfer-Encoding,
// which is a request with no body at all. Left to itself Node's client adds
// `Content-Length: 0`, which is a body, just an empty one.
function request(app, method, path, { headers = {}, body, bodiless = false } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const req = http.request({ agent: false,
        host: '127.0.0.1', port: server.address().port, path, method, headers,
      }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, text, headers: res.headers }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (bodiless) {
        req.removeHeader('content-length');
        req.removeHeader('transfer-encoding');
      }
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

// server.js counts every 5xx other than 502-504 as a server fault, and ten in
// fifteen minutes send the day's one server_errors alert. The apps below mount
// the same counter first, as server.js does, so a test can read what a
// request would have cost.
const { faultMiddleware, serverFaultStatus, __resetServerFaults } = require('../utils/serverFault');
// 'finish', where a response is counted, can land after the client has it.
const settle = () => new Promise((r) => setTimeout(r, 20));

// The same parser shape server.js gives this path: JSON that keeps its raw
// bytes, then the form parser every path gets.
function webhookApp(router = require('../routes/emailWebhook')) {
  const app = express();
  app.use(faultMiddleware);
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/email-events', router);
  return app;
}

// `signatureHeader(mac, signed)` writes the svix-signature header from our MAC
// and the exact string it covers, for the tests that send more than one entry.
function signedPost(app, payload, {
  secret = WEBHOOK_SECRET_RAW, id = 'msg_1', timestamp, tamper,
  path = '/api/email-events', contentType = 'application/json', signatureHeader,
} = {}) {
  // Indented, so these bytes differ from what JSON.stringify gives back after
  // a parse. A route that verified a re-serialised object instead of the raw
  // bytes would refuse every event below that expects a 200.
  const body = JSON.stringify(payload, null, 2);
  const ts = String(timestamp != null ? timestamp : Math.floor(Date.now() / 1000));
  const signed = `${id}.${ts}.${body}`;
  const mac = crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(signed).digest('base64');
  return request(app, 'POST', path, {
    headers: {
      'content-type': contentType,
      'content-length': Buffer.byteLength(tamper || body),
      'svix-id': id,
      'svix-timestamp': ts,
      'svix-signature': signatureHeader ? signatureHeader(mac, signed) : `v1,${mac}`,
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

test('a timestamp from the future is refused too, not only one from the past', async () => {
  resetWorld();
  const cap = silence();
  try {
    await withEnv({ RESEND_WEBHOOK_SECRET: `whsec_${WEBHOOK_SECRET_RAW}` }, async () => {
      // A day ahead, the mirror of the case above. The exact edge is pinned on a
      // fixed clock below; over HTTP a margin is needed that no tick of the
      // clock between this line and the route's own reading can close.
      const ahead = Math.floor(Date.now() / 1000) + 24 * 3600;
      const res = await signedPost(webhookApp(), bounced('dead@example.com'), { timestamp: ahead });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(suppressionRows.size, 0);
    });
  } finally { cap.restore(); }
});

test('the replay window is five minutes either side, to the second', () => {
  const { timestampFresh } = require('../routes/emailWebhook').__testing;
  const now = 1_800_000_000;
  assert.strictEqual(timestampFresh(String(now - 300), now), true);
  assert.strictEqual(timestampFresh(String(now + 300), now), true);
  assert.strictEqual(timestampFresh(String(now - 301), now), false);
  assert.strictEqual(timestampFresh(String(now + 301), now), false);
  for (const junk of ['abc', 'Infinity']) assert.strictEqual(timestampFresh(junk, now), false, junk);
});

test('during a secret rotation the matching signature is found wherever it sits in the header', async () => {
  // While a rotation is under way the sender signs with both secrets, so the
  // header carries two entries and the one that matches is not always first.
  // Checking only the first, or only the last, refuses real events until the
  // rotation ends.
  const otherKey = crypto.randomBytes(24);
  const otherMac = (signed) => crypto.createHmac('sha256', otherKey).update(signed).digest('base64');
  const cap = silence();
  try {
    await withEnv({ RESEND_WEBHOOK_SECRET: `whsec_${WEBHOOK_SECRET_RAW}` }, async () => {
      for (const [where, header] of [
        ['second', (mac, signed) => `v1,${otherMac(signed)} v1,${mac}`],
        ['first', (mac, signed) => `v1,${mac} v1,${otherMac(signed)}`],
      ]) {
        resetWorld();
        const res = await signedPost(webhookApp(), bounced('dead@example.com'), { signatureHeader: header });
        assert.strictEqual(res.status, 200, `the matching entry ${where}: answered ${res.status} ${res.text}`);
        assert.strictEqual(suppressionRows.get('dead@example.com'), 'bounce', `the matching entry ${where}`);
      }
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

// ---------------------------------------------------------------------------
// 5b. What an outsider can make the webhook answer, and what that costs
// ---------------------------------------------------------------------------
// The svix headers are not secret and a current timestamp is free, so every
// check ahead of the body passes for anybody who sends three made-up headers.
// A body that never reached the raw-body parser was then answered 500 with a
// line blaming server.js. A 500 is a counted server fault, so ten of those
// requests sent the day's one server_errors alert, with the wrong diagnosis,
// and left nothing to send when a real storm of 500s came later that day.

function madeUpSvixHeaders(extra = {}) {
  return {
    'svix-id': 'msg_x',
    'svix-timestamp': String(Math.floor(Date.now() / 1000)),
    'svix-signature': 'v1,x',
    ...extra,
  };
}

// Every shape of request that reaches the route with no raw bytes and is not
// the server's fault. A function, so each use gets a current timestamp.
const notAJsonBody = () => [
  ['a text/plain body', {
    headers: madeUpSvixHeaders({ 'content-type': 'text/plain', 'content-length': 1 }), body: 'x',
  }],
  ['a form-encoded body', {
    headers: madeUpSvixHeaders({ 'content-type': 'application/x-www-form-urlencoded', 'content-length': 3 }), body: 'a=b',
  }],
  ['a body with no Content-Type', { headers: madeUpSvixHeaders({ 'content-length': 2 }), body: '{}' }],
  ['an empty body with no Content-Type', { headers: madeUpSvixHeaders({ 'content-length': 0 }), body: '' }],
  ['a JSON Content-Type and no body at all', {
    headers: madeUpSvixHeaders({ 'content-type': 'application/json' }), bodiless: true,
  }],
];

test('a body that is not JSON, or no body at all, is a client error: 415, never a counted 500', async () => {
  resetWorld();
  __resetServerFaults();
  const cap = silence();
  try {
    await withEnv({ RESEND_WEBHOOK_SECRET: `whsec_${WEBHOOK_SECRET_RAW}` }, async () => {
      const app = webhookApp();
      for (const [what, opts] of notAJsonBody()) {
        const res = await request(app, 'POST', '/api/email-events', opts);
        assert.strictEqual(res.status, 415, `${what} answered ${res.status} ${res.text}`);
      }
      // Signed or not makes no difference. Resend never sends another type, so
      // a body in one is not read.
      const signedAsText = await signedPost(app, bounced('dead@example.com'), { contentType: 'text/plain' });
      assert.strictEqual(signedAsText.status, 415);
      assert.strictEqual(suppressionRows.size, 0);
    });
    await settle();
    assert.strictEqual(serverFaultStatus().total, 0,
      'a request anybody can send must not count toward the alert that pages the admins');
    assert.ok(!/raw body/.test(cap.text()), 'none of these is a mount bug, and the log must not say one is');
  } finally { cap.restore(); }
});

test('a JSON body with no raw bytes beside it is still the mount bug: a counted 500 and the line that says so', async () => {
  // The two ways server.js could lose the bytes: a parser that does not keep
  // them, or no parser at all. Either turns every genuine event into this, so
  // it has to stay loud.
  const behindPlainJson = express();
  behindPlainJson.use(faultMiddleware);
  behindPlainJson.use(express.json());
  behindPlainJson.use('/api/email-events', require('../routes/emailWebhook'));
  const behindNothing = express();
  behindNothing.use(faultMiddleware);
  behindNothing.use('/api/email-events', require('../routes/emailWebhook'));

  for (const [what, app] of [['express.json() without verify', behindPlainJson], ['no body parser', behindNothing]]) {
    resetWorld();
    __resetServerFaults();
    const cap = silence();
    try {
      // eslint-disable-next-line no-loop-func
      await withEnv({ RESEND_WEBHOOK_SECRET: `whsec_${WEBHOOK_SECRET_RAW}` }, async () => {
        const res = await signedPost(app, bounced('dead@example.com'));
        assert.strictEqual(res.status, 500, `${what}: answered ${res.status} ${res.text}`);
      });
      await settle();
      assert.match(cap.text(), /no raw body[\s\S]*mounted without its raw-body parser in server\.js/, what);
      assert.strictEqual(serverFaultStatus().total, 1, `${what}: the mount bug has to reach the fault count`);
      assert.strictEqual(suppressionRows.size, 0);
    } finally { cap.restore(); }
  }
});

// server.js's own parser table, lifted out of the source the way
// __tests__/bodyLimitAudit.test.js lifts it. The 500 above is out of an
// outsider's reach only if every JSON request that gets through the real table
// to this route carries its bytes, so the two halves are tested together.
function appBehindServerParsers() {
  const src = require('node:fs').readFileSync(require.resolve('../server.js'), 'utf8');
  const start = src.indexOf('const JSON_BODY_ENVELOPE_BYTES');
  const endAt = src.indexOf('app.use(express.urlencoded(');
  assert.ok(start > 0 && endAt > start, 'the parser block in server.js has moved; retarget this lift');
  const app = express();
  app.use(faultMiddleware);
  // Only the image routes read CHAT_IMAGE_MAX_BYTES, and nothing here posts one.
  // eslint-disable-next-line no-new-func
  new Function('express', 'CHAT_IMAGE_MAX_BYTES', 'app', src.slice(start, src.indexOf('\n', endAt)))(
    express, 1024 * 1024, app
  );
  app.use('/api/email-events', require('../routes/emailWebhook'));
  app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));
  return app;
}

test('behind the parsers server.js really mounts, a genuine event verifies at every spelling and an outsider cannot reach the 500', async () => {
  __resetServerFaults();
  const cap = silence();
  try {
    await withEnv({ RESEND_WEBHOOK_SECRET: `whsec_${WEBHOOK_SECRET_RAW}` }, async () => {
      const app = appBehindServerParsers();
      // Express routes all four to the same handler, so each has to get the bytes.
      for (const path of ['/api/email-events', '/api/email-events/', '/API/EMAIL-EVENTS', '/api/email-events//']) {
        resetWorld();
        const res = await signedPost(app, bounced('dead@example.com'), { path });
        assert.strictEqual(res.status, 200, `${path} answered ${res.status} ${res.text}`);
        assert.strictEqual(suppressionRows.get('dead@example.com'), 'bounce', path);
      }

      resetWorld();
      for (const [what, opts] of notAJsonBody()) {
        const res = await request(app, 'POST', '/api/email-events', opts);
        assert.strictEqual(res.status, 415, `${what} answered ${res.status} ${res.text}`);
      }
      // A JSON body, even an empty one, arrives with its bytes, so the furthest
      // an outsider gets is the signature check.
      const emptyJson = await request(app, 'POST', '/api/email-events', {
        headers: madeUpSvixHeaders({ 'content-type': 'application/json', 'content-length': 0 }), body: '',
      });
      assert.strictEqual(emptyJson.status, 401);
      const forged = await signedPost(app, bounced('victim@example.com'),
        { secret: crypto.randomBytes(24).toString('base64') });
      assert.strictEqual(forged.status, 401);
      assert.strictEqual(suppressionRows.size, 0);
    });
    await settle();
    assert.strictEqual(serverFaultStatus().total, 0, 'nothing an outsider sent may count as a server fault');
    assert.ok(!/raw body/.test(cap.text()));
  } finally { cap.restore(); }
});

// ---------------------------------------------------------------------------
// 5c. The secret is judged by what it decodes to
// ---------------------------------------------------------------------------
// The route used to count the characters after `whsec_` and hand the rest to
// Buffer.from(_, 'base64'), which never throws and skips what it cannot read.
// Every value below got past that, became a key that is not the real one, and
// said nothing. A genuine event then failed its signature, or, where the value
// was typed junk, anybody who signed with what it decodes to could suppress
// any address they liked. Each one now answers 503 and says what is wrong.

// A fresh copy of the route module, so its require-time check and its
// once-per-process warning run again under the environment given. The cached
// copy every other test uses is put back.
function freshEmailWebhook(env) {
  const id = require.resolve('../routes/emailWebhook');
  const kept = require.cache[id];
  delete require.cache[id];
  try {
    return withEnv(env, () => require('../routes/emailWebhook'));
  } finally {
    if (kept) require.cache[id] = kept; else delete require.cache[id];
  }
}

// Built rather than written out, so no line here looks like a real secret to
// the secret scanners.
const W = 'whsec_';
// A key whose standard base64 has '+' and '/' in it, so its base64url spelling
// has '-' and '_'.
const URL_SAFE_KEY = Buffer.concat([Buffer.from([0xfb, 0xff, 0xbf]), crypto.randomBytes(21)]);
const NOT_BASE64 = /is not whsec_ followed by standard base64/;
const unusableSecrets = () => [
  ['wrapped in double quotes', `"${W}${WEBHOOK_SECRET_RAW}"`, NOT_BASE64],
  ['wrapped in single quotes', `'${W}${WEBHOOK_SECRET_RAW}'`, NOT_BASE64],
  ['an upper-case prefix', `WHSEC_${WEBHOOK_SECRET_RAW}`, NOT_BASE64],
  ['the prefix twice', `${W}${W}${WEBHOOK_SECRET_RAW}`, NOT_BASE64],
  ['a pasted NAME=value line', `RESEND_WEBHOOK_SECRET=${W}${WEBHOOK_SECRET_RAW}`, NOT_BASE64],
  ['the base64url alphabet', `${W}${URL_SAFE_KEY.toString('base64url')}`, NOT_BASE64],
  ['an = before the end', `${W}${WEBHOOK_SECRET_RAW.slice(0, 8)}=${WEBHOOK_SECRET_RAW.slice(8)}`, NOT_BASE64],
  ['one character too many', `${W}${WEBHOOK_SECRET_RAW}A`, NOT_BASE64],
  ['padding that does not finish a group', `${W}${crypto.randomBytes(25).toString('base64').slice(0, -1)}`, NOT_BASE64],
  ['24 characters that decoded to one byte', `${W}AA${'!'.repeat(22)}`, NOT_BASE64],
  ['a typed placeholder', `${W}change-me-before-launch-pls`, NOT_BASE64],
  ['a template placeholder', 'your_webhook_secret_here', NOT_BASE64],
  ['a 16-byte key', `${W}${crypto.randomBytes(16).toString('base64')}`,
    /decodes to 16 bytes, and a Resend signing secret is at least 24/],
  ['one character typed 32 times', `${W}${'A'.repeat(32)}`, /repeats a short pattern/],
  ['a word typed four times', `${W}${'changeme'.repeat(4)}`, /repeats a short pattern/],
];

test('a secret that is set but malformed is refused with 503 and named as malformed, never as missing', async () => {
  const fresh = freshEmailWebhook({ NODE_ENV: 'test', RESEND_WEBHOOK_SECRET: undefined });
  const app = webhookApp(fresh);
  const cases = unusableSecrets();
  const cap = silence();
  try {
    for (const [what, value, why] of cases) {
      resetWorld();
      // eslint-disable-next-line no-loop-func
      await withEnv({ RESEND_WEBHOOK_SECRET: value }, async () => {
        const state = fresh.__testing.webhookSecret();
        assert.strictEqual(state.key, null, `${what} was accepted as a key`);
        assert.match(state.problem, /^is set but /, what);
        assert.match(state.problem, why, what);
        // Signed with what Node's decoder makes of the value, which is the key
        // the route used to verify with. For the junk values, that was a forged
        // suppression of somebody else's address.
        const lenient = Buffer.from(value.trim().replace(/^whsec_/, ''), 'base64');
        const res = await signedPost(app, bounced('victim@example.com'), { secret: lenient.toString('base64') });
        assert.strictEqual(res.status, 503, `${what} answered ${res.status} ${res.text}`);
        assert.strictEqual(suppressionRows.size, 0, `${what}: an address was suppressed`);
      });
    }
    const text = cap.text();
    assert.ok(!/RESEND_WEBHOOK_SECRET is not set/.test(text), 'a value that is set must not be reported as missing');
    assert.strictEqual(
      (text.match(/RESEND_WEBHOOK_SECRET is set but is not a usable signing secret, so this delivery event was refused/g) || []).length,
      cases.length, 'every refused event logs its own line');
    const named = text.match(/EMAIL: RESEND_WEBHOOK_SECRET is set but [^\n]*Copy the value out of the Resend dashboard/g) || [];
    assert.strictEqual(named.length, 1, 'what is wrong with the value is said once per process, not on every event');
    assert.match(named[0], /quotes around it/, 'and it describes the first value it read');
  } finally { cap.restore(); }
});

test('the real secret still verifies with whitespace around or inside it, with no prefix, and padded or not', async () => {
  const padded25 = crypto.randomBytes(25).toString('base64');
  const cases = [
    ['whitespace around it', `  ${W}${WEBHOOK_SECRET_RAW}\n`, WEBHOOK_SECRET_RAW],
    ['wrapped onto two lines', `${W}${WEBHOOK_SECRET_RAW.slice(0, 16)}\r\n${WEBHOOK_SECRET_RAW.slice(16)}`, WEBHOOK_SECRET_RAW],
    ['no whsec_ prefix', WEBHOOK_SECRET_RAW, WEBHOOK_SECRET_RAW],
    ['a 25-byte key, padded', `${W}${padded25}`, padded25],
    ['a 25-byte key, unpadded', `${W}${padded25.replace(/=+$/, '')}`, padded25],
  ];
  const cap = silence();
  try {
    for (const [what, value, signingSecret] of cases) {
      resetWorld();
      // eslint-disable-next-line no-loop-func
      await withEnv({ RESEND_WEBHOOK_SECRET: value }, async () => {
        const res = await signedPost(webhookApp(), bounced('dead@example.com'), { secret: signingSecret });
        assert.strictEqual(res.status, 200, `${what} answered ${res.status} ${res.text}`);
        assert.strictEqual(suppressionRows.get('dead@example.com'), 'bounce', what);
      });
    }
    assert.ok(!/RESEND_WEBHOOK_SECRET/.test(cap.text()), 'a usable secret is never warned about');
  } finally { cap.restore(); }
});

// What a fresh copy of the route logs as it is required in production.
function bootLog(env) {
  const cap = silence();
  try {
    const mod = freshEmailWebhook({ NODE_ENV: 'production', ...env });
    return { mod, text: cap.text() };
  } finally { cap.restore(); }
}

test('at boot in production a missing secret and a malformed one are each named for what they are', async () => {
  const missing = bootLog({ RESEND_WEBHOOK_SECRET: undefined }).text;
  assert.match(missing, /RESEND_WEBHOOK_SECRET is not set, so POST \/api\/email-events refuses every delivery event/);
  assert.match(missing, /Create the webhook in the Resend dashboard/);

  const quoted = `"${W}${WEBHOOK_SECRET_RAW}"`;
  const malformed = bootLog({ RESEND_WEBHOOK_SECRET: quoted });
  assert.ok(!/is not set/.test(malformed.text), 'a value that is set must not be reported as missing');
  assert.match(malformed.text, /RESEND_WEBHOOK_SECRET is set but is not whsec_ followed by standard base64/);
  assert.match(malformed.text, /Copy the value out of the Resend dashboard webhook page exactly as shown/);

  // Named at boot, so the first event it refuses does not name it again.
  resetWorld();
  const cap = silence();
  try {
    await withEnv({ RESEND_WEBHOOK_SECRET: quoted }, async () => {
      const res = await signedPost(webhookApp(malformed.mod), bounced('dead@example.com'));
      assert.strictEqual(res.status, 503);
    });
    assert.ok(!/EMAIL: RESEND_WEBHOOK_SECRET/.test(cap.text()), 'the boot line already said what is wrong');
    assert.match(cap.text(), /is set but is not a usable signing secret, so this delivery event was refused/);
  } finally { cap.restore(); }

  assert.ok(!/RESEND_WEBHOOK_SECRET/.test(bootLog({ RESEND_WEBHOOK_SECRET: `${W}${WEBHOOK_SECRET_RAW}` }).text),
    'a usable secret says nothing at boot');
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

// ===========================================================================
// 7. The confirm button gets past server.js's cors, not just past the router
// ===========================================================================
// Every test above mounts the router on a bare app, which is how the button
// was found broken in the product while this file stayed green. A browser puts
// an Origin header on every form POST, same-origin included: `null` under
// helmet's `Referrer-Policy: no-referrer`, or the API's own origin. Neither is
// on the allowlist, so the real cors mount answered 403 {"error":"Not allowed
// by CORS"} and the opt-out never ran. Only a provider's one-click POST, which
// carries no Origin, got through. These tests run server.js's own allowlist and
// cors mount, lifted from the source, in front of the real routers.

function appBehindServerCors() {
  const src = require('node:fs').readFileSync(require.resolve('../server.js'), 'utf8');
  const start = src.indexOf('const allowedOrigins = [');
  const mountAt = src.indexOf('app.use(cors(', start);
  // Through the end of the mount statement, however many lines it spans.
  const tail = /\)\);\r?\n/.exec(src.slice(mountAt));
  assert.ok(start > 0 && mountAt > start && tail, 'the cors block in server.js has moved; retarget this lift');
  const mountEnd = mountAt + tail.index + 3;
  const app = express();
  // eslint-disable-next-line no-new-func
  new Function('app', 'cors', 'process', 'console', src.slice(start, mountEnd))(
    app, require('cors'), { env: {} }, { log() {}, warn() {}, error() {} }
  );
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/unsubscribe', require('../routes/unsubscribe'));
  app.use('/api/venue-digest', require('../routes/venueDigest'));
  app.post('/api/flocks', (_req, res) => res.json({ reached: true }));
  app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));
  // Stands in for the CORS_REFUSED branch of server.js's error handler.
  app.use((err, _req, res, _next) => {
    if (err && err.type === 'cors.origin.refused') return res.status(403).json({ error: 'Not allowed by CORS' });
    return res.status(500).json({ error: String(err && err.message) });
  });
  return app;
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

test('the confirm button works from the page: Origin null and the API origin both reach the opt-out', async () => {
  const cases = [
    ['Origin null (helmet sends no-referrer)', { ...FORM, origin: 'null' }],
    ['the API origin itself', { ...FORM, host: 'api.flockcorp.com', origin: 'https://api.flockcorp.com' }],
  ];
  for (const [what, headers] of cases) {
    resetWorld();
    const token = unsub.mintUnsubscribeToken('clicker@example.com');
    const res = await request(appBehindServerCors(), 'POST',
      `/api/unsubscribe?token=${encodeURIComponent(token)}`, { headers, body: '' });
    assert.strictEqual(res.status, 200,
      `${what}: the button was answered ${res.status} ${res.text}. That is the reader who clicked `
      + '"Take me off the list" and kept getting mail.');
    assert.match(res.text, /off the list/i);
    assert.strictEqual(suppressionRows.get('clicker@example.com'), 'unsubscribe', `${what}: nothing was recorded`);
    assert.strictEqual(res.headers['access-control-allow-origin'], undefined,
      `${what}: a same-origin page needs no CORS headers, and handing one to "null" would let any sandboxed frame read the answer`);
  }
});

test('the digest opt-out button reaches its router through the same cors mount', async () => {
  const cap = silence();
  try {
    for (const headers of [
      { ...FORM, origin: 'null' },
      { ...FORM, host: 'api.flockcorp.com', origin: 'https://api.flockcorp.com' },
    ]) {
      // A bad token is enough: the router's own 400 page proves the request
      // got past cors, where the refusal is a 403 JSON body.
      const res = await request(appBehindServerCors(), 'POST', '/api/venue-digest/opt-out?token=nonsense',
        { headers, body: '' });
      assert.strictEqual(res.status, 400, `origin ${headers.origin} answered ${res.status} ${res.text}`);
      assert.match(res.headers['content-type'] || '', /html/);
      assert.ok(!/Not allowed by CORS/.test(res.text));
    }
  } finally { cap.restore(); }
});

test('the exemption is only those two pages and only their own origin', async () => {
  resetWorld();
  const token = unsub.mintUnsubscribeToken('kept@example.com');
  const path = `/api/unsubscribe?token=${encodeURIComponent(token)}`;
  for (const [what, method, url, headers] of [
    ['a foreign site posting to the unsubscribe page', 'POST', path, { ...FORM, origin: 'https://evil.example' }],
    ['an Origin naming a host other than the one addressed', 'POST', path,
      { ...FORM, host: 'api.flockcorp.com', origin: 'https://other.example' }],
    ['Origin null on any other API path', 'POST', '/api/flocks', { ...FORM, origin: 'null' }],
    ['a path that only starts with the same letters', 'POST', '/api/unsubscribe-other', { ...FORM, origin: 'null' }],
  ]) {
    const res = await request(appBehindServerCors(), method, url, { headers, body: '' });
    assert.strictEqual(res.status, 403, `${what} answered ${res.status}; the allowlist must still refuse it`);
  }
  assert.strictEqual(suppressionRows.size, 0, 'a refused request must not have written anything');
});
