// Run: node --test  (from backend/)
//
// ===========================================================================
// THE SHARE-MY-LOCATION EMAIL KEEPS THE PRIVACY POLICY'S PROMISE.
// ===========================================================================
// frontend/src/website/PrivacyPolicy.js, "Email, and how to stop it", names
// three kinds of transactional email: the verification link at sign-up, a
// password reset, and SOS alerts to trusted contacts. "Everything else is
// optional and every message carries an unsubscribe link that works without
// signing in."
//
// POST /api/safety/share-location broke that three ways. Its email went out
// as 'transactional', so the do-not-mail list let it through for an address
// that had unsubscribed; it carried no unsubscribe link and no List-Unsubscribe
// header; and it never said who had typed the address into a Safety screen,
// which is the only thing a stranger receiving it would want to know first.
//
// Pinned here, through the real routers with only Postgres and the mail
// provider faked:
//   1. every location email names who added the recipient and carries that
//      recipient's own signed stop link, in the body, in the text part and in
//      the RFC 8058 header pair;
//   2. the link's GET only renders and its POST writes, and once it has, later
//      location emails to that address are refused server side while the
//      other contacts still get theirs;
//   3. an SOS alert still reaches that address;
//   4. the token is verified: missing, edited, forged or foreign tokens stop
//      nothing;
//   5. the opt-out is one row on the do-not-mail list, which stops optional
//      mail and never a password reset or an SOS, and a contact who used it
//      is not shown to their friend as a failing address.
// ===========================================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'location-share-opt-out-test-secret';

// --- pg fake ----------------------------------------------------------------
const pool = require('../config/database');

const ME = { id: 7, email: 'me@example.com', name: 'Ava Lee', role: 'user', is_banned: false, token_version: 0 };
const MUM = { id: 1, contact_name: 'Mum', contact_email: 'mum@example.com' };
const DAD = { id: 2, contact_name: 'Dad', contact_email: 'dad@example.com' };

let suppressionRows; // normalised address -> reason
let contacts;
let userName;
let queries;

function answer(text, params) {
  const sql = String(text);
  queries.push({ sql, params });
  // Every authenticated route loads the caller's row first. Any id is a real
  // account here, so a test can share as a second person without waiting out
  // the first one's ten-minute cooldown.
  if (sql.includes('FROM users WHERE id = $1') && sql.includes('token_version')) {
    return { rows: [{ ...ME, id: params[0] }], rowCount: 1 };
  }
  if (/SELECT reason FROM email_suppressions/.test(sql)) {
    const reason = suppressionRows.get(params[0]);
    return reason ? { rows: [{ reason }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/INSERT INTO email_suppressions/.test(sql)) {
    // The SQL's strengthen-only rule.
    const [email, reason] = params;
    const rank = { unsubscribe: 1, complaint: 2, bounce: 3 };
    const existing = suppressionRows.get(email);
    if (!existing || rank[reason] > rank[existing]) suppressionRows.set(email, reason);
    return { rows: [], rowCount: 1 };
  }
  if (sql.includes('INSERT INTO emergency_alerts')) return { rows: [{ id: 901 }], rowCount: 1 };
  if (sql.includes('FROM emergency_alerts')) return { rows: [], rowCount: 0 };
  if (sql.includes('FROM trusted_contacts')) return { rows: contacts, rowCount: contacts.length };
  if (sql.includes('SELECT name FROM users')) return { rows: [{ name: userName }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}
pool.query = async (text, params) => answer(text, params);
pool.connect = async () => ({
  query: async (text, params) => {
    const sql = String(text);
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql) || sql.includes('pg_advisory_xact_lock')) {
      return { rows: [], rowCount: 0 };
    }
    return answer(text, params);
  },
  release: () => {},
});

const suppression = require('../services/emailSuppression');
const unsub = require('../services/emailUnsubscribe');
const emailService = require('../services/emailService');
const safetyRoutes = require('../routes/safety');
const unsubscribeRoutes = require('../routes/unsubscribe');

let nextUserId = 500;
function resetWorld() {
  suppressionRows = new Map();
  contacts = [MUM, DAD];
  userName = 'Ava Lee';
  queries = [];
  suppression.resetCache();
  emailService.resetRecipientBudget();
}

// --- resend fake --------------------------------------------------------------
const RESEND_PATH = require.resolve('resend');
function stubResend() {
  const realEntry = require.cache[RESEND_PATH];
  const sends = [];
  class FakeResend {
    constructor() {
      this.emails = {
        send: async (payload) => { sends.push(payload); return { data: { id: `msg_${sends.length}` }, error: null }; },
      };
    }
  }
  require.cache[RESEND_PATH] = { id: RESEND_PATH, filename: RESEND_PATH, loaded: true, exports: { Resend: FakeResend } };
  emailService.resetClient();
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

// --- HTTP -------------------------------------------------------------------
async function callSafety(method, urlPath, body, userId = ME.id) {
  const app = express();
  app.use(express.json());
  app.use('/api', safetyRoutes);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const token = jwt.sign({ userId, tv: 0 }, process.env.JWT_SECRET);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${urlPath}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// The stop page, mounted where server.js mounts it.
function callStopPage(method, urlPath, { headers = {}, body } = {}) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/unsubscribe', unsubscribeRoutes);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const req = http.request({
        agent: false, host: '127.0.0.1', port: server.address().port, path: urlPath, method, headers,
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

const SHARE = { latitude: 40.7128, longitude: -74.006, timezone: 'America/New_York' };
const ALERT = { latitude: 40.7128, longitude: -74.006, includeLocation: true };

// Shares as a fresh account each time, so the per-user cooldown never decides
// a test.
async function share() {
  nextUserId += 1;
  return callSafety('POST', '/api/share-location', SHARE, nextUserId);
}

// The stop link a location email carries, as the path and query to request.
function stopPathIn(payload) {
  const m = /href="(https?:\/\/[^"]*\/api\/unsubscribe\/location-share\?token=[^"]+)"/.exec(payload.html);
  assert.ok(m, `no stop link in the email to ${payload.to}`);
  const url = new URL(m[1].replace(/&amp;/g, '&'));
  return { url: m[1].replace(/&amp;/g, '&'), path: `${url.pathname}${url.search}`, token: url.searchParams.get('token') };
}

const wroteSuppression = () => queries.some((q) => /INSERT INTO email_suppressions/.test(q.sql));

// ===========================================================================
// 1. What the email says and carries
// ===========================================================================

test('every location email names who added the recipient and carries their own stop link', async () => {
  resetWorld();
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      const res = await share();
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(r.sends.map((s) => s.to).sort(), ['dad@example.com', 'mum@example.com']);
      for (const payload of r.sends) {
        // Who put this address on a Safety screen, in the footer, by name.
        assert.match(payload.html, /Ava Lee added you as a trusted contact on Flock/);
        assert.match(payload.text, /Ava Lee added you as a trusted contact on Flock/,
          'the text part is what a watch or a screen reader shows, and it has to say it too');
        // The recipient's OWN link: its token verifies to this address and no
        // other, so one contact cannot stop another contact's mail.
        const stop = stopPathIn(payload);
        assert.strictEqual(unsub.verifyUnsubscribeToken(stop.token), payload.to);
        assert.ok(payload.text.includes(stop.url), 'the text part lost the stop link');
        // The RFC 8058 pair, pointing at the same link, as on the waitlist mail.
        assert.strictEqual(payload.headers['List-Unsubscribe'], `<${stop.url}>`);
        assert.strictEqual(payload.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
        // And the one thing the link does not stop.
        assert.match(payload.html, /SOS alerts from Ava Lee still reach you/);
      }
    });
  } finally { cap.restore(); r.restore(); }
});

test('the name in the footer is escaped like every other place it is printed', async () => {
  resetWorld();
  userName = 'Ava <b>Lee</b>';
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      const res = await share();
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      for (const payload of r.sends) {
        assert.match(payload.html, /Ava &lt;b&gt;Lee&lt;\/b&gt; added you as a trusted contact on Flock/);
        assert.ok(!payload.html.includes('<b>Lee</b>'), 'a display name reached the HTML as markup');
      }
    });
  } finally { cap.restore(); r.restore(); }
});

test('with no signing key there is no dead link and no header: the email says to reply instead', async () => {
  resetWorld();
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k', JWT_SECRET: undefined }, async () => {
      // The share itself is authenticated, so only the link builder may see
      // the missing key.
      const realStop = emailService.locationShareStopUrl;
      assert.strictEqual(realStop('mum@example.com'), null);
    });
    const real = emailService.locationShareStopUrl;
    emailService.locationShareStopUrl = () => null;
    try {
      await withEnv({ RESEND_API_KEY: 'k' }, async () => {
        const res = await share();
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        for (const payload of r.sends) {
          assert.match(payload.html, /Reply to this message and we will stop location emails to this address/);
          assert.ok(!/\/api\/unsubscribe\/location-share/.test(payload.html));
          assert.strictEqual(payload.headers, undefined, 'a List-Unsubscribe header with no link behind it');
          assert.match(payload.html, /Ava Lee added you as a trusted contact on Flock/);
        }
      });
    } finally { emailService.locationShareStopUrl = real; }
  } finally { cap.restore(); r.restore(); }
});

// ===========================================================================
// 2. The stop link: GET renders, POST writes, and later shares obey it
// ===========================================================================

test('the stop link stops later location emails to that address, and only that address', async () => {
  resetWorld();
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      const first = await share();
      assert.strictEqual(first.status, 200, JSON.stringify(first.body));
      const stop = stopPathIn(r.sends.find((s) => s.to === 'mum@example.com'));

      // A Safe Links scanner or a preview fetch is a GET. It draws the page and
      // writes nothing.
      const page = await callStopPage('GET', stop.path);
      assert.strictEqual(page.status, 200);
      assert.match(page.text, /<form method="post" action="\/api\/unsubscribe\/location-share\?token=/);
      assert.match(page.text, /Stop location emails/);
      assert.ok(!page.text.includes('mum@example.com'), 'the page echoed the address');
      assert.strictEqual(suppressionRows.size, 0, 'a GET took somebody off the list');
      assert.ok(!wroteSuppression());

      // The button is the write.
      const done = await callStopPage('POST', stop.path, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '',
      });
      assert.strictEqual(done.status, 200);
      assert.match(done.text, /Location emails are off/);
      assert.match(done.text, /An SOS alert from someone who named this address as a trusted contact still arrives/);
      assert.strictEqual(suppressionRows.get('mum@example.com'), 'unsubscribe');

      // The next share skips Mum at the send path and still reaches Dad.
      r.sends.length = 0;
      const second = await share();
      assert.strictEqual(second.status, 200, JSON.stringify(second.body));
      assert.deepStrictEqual(r.sends.map((s) => s.to), ['dad@example.com'],
        'a location email reached an address that had used its stop link');
      assert.strictEqual(second.body.contactsShared, 1);
      assert.strictEqual(second.body.notReached, 1);
      assert.strictEqual(second.body.message, 'Location shared with 1 contact, 1 contact could not be reached');

      // A later visit to the same link shows the finished page, not a button.
      const again = await callStopPage('GET', stop.path);
      assert.strictEqual(again.status, 200);
      assert.ok(!again.text.includes('<form'), 'nothing left to confirm');
    });
  } finally { cap.restore(); r.restore(); }
});

test("a mail client's one-click POST works: no Origin, the fixed RFC 8058 body", async () => {
  resetWorld();
  const token = unsub.mintUnsubscribeToken('dad@example.com');
  const res = await callStopPage('POST', `/api/unsubscribe/location-share?token=${encodeURIComponent(token)}`, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(suppressionRows.get('dad@example.com'), 'unsubscribe');
  // A second press is a success, not an error.
  const twice = await callStopPage('POST', `/api/unsubscribe/location-share?token=${encodeURIComponent(token)}`, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  });
  assert.strictEqual(twice.status, 200);
});

// ===========================================================================
// 3. An SOS is not optional
// ===========================================================================

test('an SOS alert still reaches an address that stopped location emails', async () => {
  resetWorld();
  const r = stubResend();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      const token = unsub.mintUnsubscribeToken('mum@example.com');
      const stopped = await callStopPage('POST', `/api/unsubscribe/location-share?token=${encodeURIComponent(token)}`, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '',
      });
      assert.strictEqual(stopped.status, 200);
      assert.strictEqual(suppressionRows.get('mum@example.com'), 'unsubscribe');

      nextUserId += 1;
      const res = await callSafety('POST', '/api/alert', ALERT, nextUserId);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(r.sends.map((s) => s.to).sort(), ['dad@example.com', 'mum@example.com'],
        'the stop link silenced an SOS alert');
      const toMum = r.sends.find((s) => s.to === 'mum@example.com');
      assert.ok(!/\/api\/unsubscribe/.test(toMum.html), 'an SOS alert carries a way to stop SOS alerts');
      assert.strictEqual(toMum.headers, undefined, 'an SOS alert carries a List-Unsubscribe header');
    });
  } finally { cap.restore(); r.restore(); }
});

// ===========================================================================
// 4. The token is the whole authorisation, so it is checked
// ===========================================================================

test('a missing, garbled, edited, forged or foreign token stops nothing, on either verb', async () => {
  resetWorld();
  const mine = unsub.mintUnsubscribeToken('me@example.com');
  const theirs = unsub.mintUnsubscribeToken('mum@example.com');
  const edited = `${theirs.split('.')[0]}.${mine.split('.')[1]}`;
  const foreign = withEnv({ JWT_SECRET: 'some-other-secret' }, () => unsub.mintUnsubscribeToken('mum@example.com'));
  const unsigned = theirs.split('.')[0];
  const cap = silence();
  try {
    for (const method of ['GET', 'POST']) {
      for (const [what, query] of [
        ['no token', ''],
        ['garbage', '?token=nonsense'],
        ['my signature on their address', `?token=${encodeURIComponent(edited)}`],
        ['a token from another secret', `?token=${encodeURIComponent(foreign)}`],
        ['an unsigned address', `?token=${encodeURIComponent(unsigned)}`],
      ]) {
        const res = await callStopPage(method, `/api/unsubscribe/location-share${query}`, {
          headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '',
        });
        assert.strictEqual(res.status, 400, `${method} with ${what} answered ${res.status}`);
        assert.ok(!res.text.includes('<form'), `${method} with ${what} drew the button`);
      }
    }
    assert.strictEqual(suppressionRows.size, 0);
    assert.ok(!wroteSuppression(), 'a refused token still wrote a row');
  } finally { cap.restore(); }
});

// ===========================================================================
// 5. What the row stops, and what it does not
// ===========================================================================

test('the do-not-mail list: an unsubscribe stops optional mail and never a reset or an SOS', async () => {
  resetWorld();
  const C = suppression.LOCATION_SHARE_CATEGORY;
  assert.strictEqual(C, 'location_share');
  assert.ok(suppression.OPTIONAL_CATEGORIES.has(C));
  assert.ok(suppression.OPTIONAL_CATEGORIES.has('marketing'));
  assert.ok(!suppression.OPTIONAL_CATEGORIES.has('transactional'), 'a password reset became optional');
  assert.ok(!suppression.OPTIONAL_CATEGORIES.has(suppression.EMERGENCY_CATEGORY), 'an SOS became optional');

  const expect = {
    // reason:       [location_share, marketing, transactional, emergency]
    none: [false, false, false, false],
    unsubscribe: [true, true, false, false],
    complaint: [true, true, true, false],
    bounce: [true, true, true, false],
  };
  for (const [reason, blocked] of Object.entries(expect)) {
    resetWorld();
    if (reason !== 'none') suppressionRows.set('person@example.com', reason);
    const got = [];
    for (const category of [C, 'marketing', 'transactional', suppression.EMERGENCY_CATEGORY]) {
      got.push((await suppression.checkSendAllowed('person@example.com', category)).blocked);
    }
    assert.deepStrictEqual(got, blocked, `with ${reason}: [location_share, marketing, transactional, emergency]`);
  }
});

test('a location email refused by the list is the list working: no lockout alarm', async () => {
  // The lockout alarm is for a person who cannot verify their address or reset
  // their password. A location email refused for an address that stopped
  // them, or that bounced, says nothing about anybody's account.
  for (const [address, reason] of [['stopped.contact@example.com', 'unsubscribe'], ['gone.contact@example.com', 'bounce']]) {
    resetWorld();
    suppressionRows.set(address, reason);
    const r = stubResend();
    const cap = silence();
    try {
      // eslint-disable-next-line no-loop-func
      await withEnv({ RESEND_API_KEY: 'k' }, async () => {
        const out = await emailService.sendEmail({
          to: address, subject: 'x shared their location with you', html: '<p>x</p>', category: 'location_share',
        });
        assert.strictEqual(out.sent, false);
        assert.strictEqual(out.suppressed, true);
        assert.strictEqual(r.sends.length, 0);
      });
      assert.doesNotMatch(cap.text(), /EMAIL: .*do-not-mail list/, `${reason}: a location email raised the lockout alarm`);
    } finally { cap.restore(); r.restore(); }
  }
});

test('location_share is capped on its own, so a share loop cannot spend a password reset', async () => {
  // __tests__/emailDeliverability.test.js measures the other three categories.
  // This is the fourth, and the same decision: 300 a day per address, counted
  // apart from transactional mail, so whatever happens to location emails to
  // an address cannot be why a reset to that address is refused.
  resetWorld();
  const cap = silence();
  try {
    await withEnv({ RESEND_API_KEY: undefined }, async () => {
      let through = 0;
      for (let i = 0; i < emailService.PER_RECIPIENT_DAILY_CAP + 20; i += 1) {
        const out = await emailService.sendEmail({
          to: 'one@example.com', subject: 's', html: '<p>x</p>', category: 'location_share',
        });
        if (out.skipped) through += 1;
      }
      assert.strictEqual(through, emailService.PER_RECIPIENT_DAILY_CAP);
      const reset = await emailService.sendEmail({ to: 'one@example.com', subject: 'Reset', html: '<p>x</p>' });
      assert.strictEqual(reset.skipped, true, 'the location cap spent the transactional allowance');
    });
  } finally { cap.restore(); }
});

test('a contact who stopped location emails is not shown to their friend as a failing address', async () => {
  resetWorld();
  contacts = [
    MUM,
    DAD,
    { id: 3, contact_name: 'Gran', contact_email: 'gran@example.com' },
    { id: 4, contact_name: 'Sam', contact_email: 'sam@example.com' },
  ];
  suppressionRows.set('mum@example.com', 'unsubscribe');
  suppressionRows.set('dad@example.com', 'bounce');
  suppressionRows.set('gran@example.com', 'complaint');
  const res = await callSafety('GET', '/api/contacts');
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const deliverable = Object.fromEntries(res.body.contacts.map((c) => [c.contact_name, c.email_deliverable]));
  assert.deepStrictEqual(deliverable, { Mum: true, Dad: false, Gran: false, Sam: true },
    'only a bounce or a complaint is a failing address; an unsubscribe still gets every SOS');
});

test('the waitlist page no longer says "nothing else changes", because the same row now stops location emails', async () => {
  resetWorld();
  const token = unsub.mintUnsubscribeToken('reader@example.com');
  const page = await callStopPage('GET', `/api/unsubscribe?token=${encodeURIComponent(token)}`);
  assert.strictEqual(page.status, 200);
  assert.ok(!/Nothing else changes/.test(page.text));
  assert.match(page.text, /stops any other optional Flock email/);
  assert.match(page.text, /SOS alert from someone who named this address as a trusted contact/);
});

// ===========================================================================
// 6. The promise, held to the page that makes it
// ===========================================================================

test('the privacy policy promise this file pins is still the one on the page, and the code keeps it', () => {
  const policy = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'website', 'PrivacyPolicy.js'), 'utf8'
  ).replace(/\s+/g, ' ');
  assert.ok(policy.includes(
    'Transactional email keeps your account working: the verification link at sign-up, a password reset you asked for, and SOS alerts to your trusted contacts.'
  ), 'the policy changed its list of transactional email; re-check which category the location email belongs in');
  assert.ok(policy.includes(
    'Everything else is optional and every message carries an unsubscribe link that works without signing in.'
  ), 'the policy changed its unsubscribe promise; re-check what this file pins');
  assert.ok(policy.includes('Unsubscribing from a list does not stop a password reset or an SOS alert'));

  // The share route sends through its own sender, as optional mail, and never
  // through the alert sender, whose default is 'transactional'.
  const safety = fs.readFileSync(path.join(__dirname, '..', 'routes', 'safety.js'), 'utf8');
  const start = safety.indexOf("router.post('/share-location'");
  const end = safety.indexOf('module.exports = router;', start);
  assert.ok(start > 0 && end > start, 'could not isolate the share-location handler');
  const handler = safety.slice(start, end);
  assert.ok(!/sendAlertEmail\(/.test(handler), 'the location email went back to the transactional sender');
  assert.match(handler, /sendShareEmail\(/);
  const sender = safety.slice(safety.indexOf('async function sendShareEmail('));
  assert.match(sender.slice(0, 600), /category: 'location_share'/);
});
