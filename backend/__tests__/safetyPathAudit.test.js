// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// THE SAFETY PATH, AUDITED AS ONE SYSTEM
// ---------------------------------------------------------------------------
// Four files decide what happens when something goes wrong in Flock:
//
//   routes/safety.js          the SOS and the trusted-contact list
//   services/emailService.js  the only way anything leaves this server by mail
//   services/moderationAlerts.js  how a report reaches a person
//   utils/blocks.js           who cannot reach whom
//
// __tests__/safetyFlow.test.js already walks the journey (report -> block ->
// takedown -> SOS) and __tests__/moderationTooling.test.js pins the reach of
// the alerting legs. This file does NOT repeat either. It covers the seams
// between those four files, which is where the defects in this round lived:
//
//   * an SOS whose Resend client was captured at require time, so a process
//     that learned its API key one millisecond later could never send;
//   * a trusted-contact address that passes validation and can never receive
//     mail, which is a Safety screen listing somebody who will never be told;
//   * a block check that answers "not blocked" for an id it could not parse;
//   * third parties' email addresses in stderr;
//   * a per-hour email ceiling that counted reports rather than emails.
//
// No database and no network. pool.query / pool.connect are replaced per test,
// and the `resend` module itself is replaced in require.cache so every field
// that would have gone to the provider is observable.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests';

const pool = require('../config/database');

const ME = { id: 7, email: 'me@example.com', name: 'Me', role: 'user', is_banned: false, token_version: 0 };

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------
async function call(router, method, urlPath, body) {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const token = jwt.sign({ userId: ME.id, tv: 0 }, process.env.JWT_SECRET);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function stubPool(handler) {
  const realQuery = pool.query;
  const realConnect = pool.connect;
  const calls = [];
  pool.query = async (text, params) => {
    const sql = String(text);
    calls.push({ text: sql, params });
    if (sql.includes('FROM users WHERE id = $1') && sql.includes('token_version')) return { rows: [ME] };
    return (await handler(sql, params)) || { rows: [], rowCount: 0 };
  };
  pool.connect = async () => ({
    query: async (text, params) => {
      const sql = String(text);
      calls.push({ text: sql, params });
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql) || sql.includes('pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 0 };
      }
      return (await handler(sql, params)) || { rows: [], rowCount: 0 };
    },
    release: () => {},
  });
  return { calls, restore: () => { pool.query = realQuery; pool.connect = realConnect; } };
}

// Replace the `resend` package itself. Everything the provider would have been
// handed is captured, so a test can assert on the recipient, the subject and
// the body without a network call and without trusting a wrapper's return
// value. This is also the only way to prove a module captured a null client at
// require time: a stub installed afterwards is simply never consulted.
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

// Everything written to the console during a block of work, as one string.
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

const safetyRoutes = require('../routes/safety');
const S = safetyRoutes.__test;
const emailService = require('../services/emailService');
const blocks = require('../utils/blocks');
const moderationAlerts = require('../services/moderationAlerts');

// ===========================================================================
// A. utils/blocks.js — a block check may never fail open
// ===========================================================================

test('blocks: an id that cannot be parsed is never answered "not blocked"', async () => {
  // THE BUG. `isBlockedBetween(a, b)` guards with `!a || !b`, and `!NaN` is
  // true, so every unparseable counterparty returned FALSE — which every caller
  // reads as "these two are allowed to reach each other".
  //
  // That is not theoretical. routes/messages.js calls
  // `isBlockedBetween(req.user.id, parseInt(req.params.userId))`, and
  // `parseInt` answers NaN for anything non-numeric. A validator sits in front
  // of it today, so the hole is currently closed by a caller rather than by the
  // control itself — which is exactly the arrangement this module's own header
  // ("the single source of truth for that enforcement") says it is not.
  //
  // "I could not tell" and "they are not blocked" are different answers and the
  // safe one is not the second. Absence of a counterparty is still false (see
  // the control below); a counterparty we cannot read is now an error the
  // caller has to handle, and every caller already fails closed on a throw.
  await assert.rejects(() => blocks.isBlockedBetween(7, NaN), /id/i,
    'NaN must not be reported as "not blocked"');
  await assert.rejects(() => blocks.isBlockedBetween(7, 'abc'), /id/i);
  await assert.rejects(() => blocks.isBlockedBetween('not-a-user', 7), /id/i);
  await assert.rejects(() => blocks.isBlockedBetween(7, 1.5), /id/i, 'a user id is an integer');
  await assert.rejects(() => blocks.isBlockedBetween(7, -3), /id/i);
  await assert.rejects(() => blocks.isBlockedBetween(7, Infinity), /id/i);
});

test('blocks: an ABSENT counterparty is still simply "not blocked"', async () => {
  // The control in the other direction, and the reason the fix above is not
  // just "throw on anything odd". Callers legitimately pass a missing id
  // (services/pushHelper.js gates on `actorId &&`, several socket handlers pass
  // a value that may not be there yet) and mean "there is nobody on the other
  // side of this". Turning that into a throw would fail those closed for no
  // safety gain, and would suppress notifications that name nobody.
  assert.strictEqual(await blocks.isBlockedBetween(null, 7), false);
  assert.strictEqual(await blocks.isBlockedBetween(7, undefined), false);
  assert.strictEqual(await blocks.isBlockedBetween('', 7), false);
  assert.strictEqual(await blocks.isBlockedBetween(7, 7), false, 'nobody blocks themselves');
  assert.strictEqual(await blocks.isBlockedBetween('7', 7), false, 'string and number are one user');
});

// A block is MUTUAL, and the pair check is the one place that has to say so.
// Nothing asserted it. A mutation pass dropped
// `OR (blocker_id = $2 AND blocked_id = $1)` from isBlockedBetween and the whole
// suite stayed green, because every mock of this query in the repo dispatches on
// the PREFIX `FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2)`,
// which a one-directional query still contains. What that would ship is A
// blocking B, A stops reaching B, and B goes on reaching A through DMs, invites
// and every other caller of this function. That is the failure Apple 1.2 is
// about, and getInvisibleUserIds is pinned for it while the pair check was not.
//
// Asserted as a PROPERTY rather than a spelling, so it survives reformatting,
// renaming the alias and reordering the terms: swapping the two bind
// placeholders must leave the set of OR-terms unchanged. A query naming one
// direction is not symmetric under that swap. A query naming both is, however
// it is written.
function orTerms(sql) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  const at = flat.toUpperCase().indexOf(' WHERE ');
  assert.ok(at > 0, 'the block probe must have a WHERE clause');
  return new Set(
    flat.slice(at + ' WHERE '.length)
      .replace(/\s*LIMIT\s+\d+\s*$/i, '')
      .split(/\s+OR\s+/i)
      .map((t) => t.trim())
      .filter(Boolean)
  );
}
const swapBinds = (s) => String(s).replace(/\$1|\$2/g, (m) => (m === '$1' ? '$2' : '$1'));

test('blocks: the pair probe is symmetric, so a block bites in both directions', async () => {
  const asked = [];
  const db = { query: async (text, params) => { asked.push({ sql: String(text), params }); return { rows: [] }; } };

  assert.strictEqual(await blocks.isBlockedBetween(7, 9, db), false);
  assert.strictEqual(asked.length, 1);
  const { sql, params } = asked[0];

  assert.match(sql, /FROM user_blocks/, 'the answer must come from user_blocks');
  assert.deepStrictEqual(params, [7, 9]);

  const terms = orTerms(sql);
  assert.ok(terms.size >= 2,
    'one term cannot name both directions of a mutual block');
  assert.deepStrictEqual(terms, orTerms(swapBinds(sql)),
    'the probe must ask the same question with the two ids swapped. As written, one of the two '
    + 'people can still reach the other after the block');
});

test('blocks: the cached check refuses an unreadable id rather than caching "allowed"', async () => {
  // The cached variant is the one on live location and typing, where a false
  // "not blocked" is a stream of coordinates to somebody who was just blocked.
  // It must not soften the answer the uncached check gives, and it must not
  // write a `blocked: false` entry that then stands for 30 seconds.
  const B = blocks.__test;
  B.blockCache.clear();
  await assert.rejects(() => blocks.isBlockedBetweenCached(7, NaN), /id/i);
  assert.strictEqual(B.blockCache.size, 0, 'nothing may be cached from an unreadable pair');
});

test('blocks: the cache key is the same string whatever the ids look like', async () => {
  // safetyFlow.test.js pins the string-vs-number half of this. The half it does
  // not cover is a key built from a value Number() cannot read: `[NaN, 5]`
  // and `[5, NaN]` both survive `.sort((m, n) => m - n)` unchanged, because the
  // comparator returns NaN and V8 treats that as "leave them alone". So the
  // same pair produced "NaN_5" from one call site and "5_NaN" from the other,
  // and an invalidation could never find what the other one wrote.
  const { pairKey } = blocks.__test;
  assert.strictEqual(pairKey(NaN, 5), pairKey(5, NaN), 'a key must not depend on argument order');
  assert.strictEqual(pairKey('x', 5), pairKey(5, 'x'));
  assert.strictEqual(pairKey(9, 10), pairKey('10', '9'), 'the case safetyFlow pins, kept');
});

// ===========================================================================
// B. Trusted contacts — a saved contact must be a REACHABLE contact
// ===========================================================================

test('contacts: an address that can never receive mail is refused when it is saved', async () => {
  // Round 17 established the rule this extends: email is the ONLY channel an
  // SOS has, so a contact who cannot be mailed is a contact who will never be
  // told anything, and the Safety screen must not list one.
  //
  // It enforced that with `EMAIL_RE`, which is a shape test and nothing more.
  // `.invalid` is reserved by RFC 2606 and can never be delivered to, and this
  // codebase already knows it: routes/auth.js mints @apple-signin.invalid for
  // Sign in with Apple's private relay and @unclaimed.invalid for evicted
  // squats, and services/moderationAlerts.js refuses both. The SOS path did
  // not. A user who typed (or pasted from their own Apple account) an .invalid
  // address got a contact row that looks identical to a working one on the
  // Safety screen, and an SOS that reaches nobody.
  for (const bad of [
    'mum@apple-signin.invalid',
    'mum@unclaimed.invalid',
    'MUM@EXAMPLE.INVALID',
  ]) {
    const r = S.readContactFields({ name: 'Mum', phone: '5550100', email: bad });
    assert.ok(r.error, `${bad} must be refused: an alert sent there reaches nobody`);
  }
});

test('contacts: one contact is one recipient, not a list and not a display name', async () => {
  // EMAIL_RE is `/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/`. Its character class excludes
  // whitespace and `@` and nothing else, so it accepts a comma, a semicolon and
  // angle brackets. Three consequences, all on the field whose value is handed
  // straight to the provider as `to`:
  //
  //   "a@b.co,x.co"    one contact row, two addresses in the header
  //   "Mum<a@b.co>"    an RFC 5322 display name chosen by the user, which is
  //                    the part a mail client renders instead of the address
  //   "a@b.co>"        junk that a strict provider rejects at send time, i.e.
  //                    an SOS that fails only when it is finally needed
  //
  // services/moderationAlerts.js got this right for the operator-facing list
  // (its class is `[^\s@,;]`). The user-facing one, on the emergency path, did
  // not.
  for (const bad of ['a@b.co,x.co', 'a@b.co;x.co', 'Mum<a@b.co>', 'a@b.co>', 'a@b.co"', 'a@b']) {
    const r = S.readContactFields({ name: 'Mum', phone: '5550100', email: bad });
    assert.ok(r.error, `${JSON.stringify(bad)} must not be accepted as one deliverable address`);
  }
});

test('contacts: ordinary addresses still save unchanged', () => {
  // The control. A rule that refuses real addresses on a safety screen is worse
  // than the hole it closes.
  for (const good of [
    'mum@example.com',
    'first.last+flock@sub.example.co.uk',
    "o'brien@example.org",
    'MUM@Example.COM',
  ]) {
    const r = S.readContactFields({ name: 'Mum', phone: '5550100', email: good });
    assert.strictEqual(r.error, undefined, `${good} is a real address`);
    assert.strictEqual(r.email, good, 'and it is stored exactly as typed');
  }
});

test('sos: an existing contact row that cannot be mailed counts as unreachable', async () => {
  // Rows saved before the rule above exist and are not deleted (round 17 chose
  // that deliberately). The pre-claim gate asked only whether contact_email was
  // truthy, so an .invalid row read as reachable: the alert claimed a slot,
  // fanned out, failed, and answered 502 — instead of the 400 that says what to
  // actually do about it and costs no retry window.
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) return { rows: [] };
    if (sql.includes('FROM trusted_contacts')) {
      return { rows: [{ id: 1, contact_name: 'Mum', contact_email: 'mum@apple-signin.invalid' }] };
    }
    return null;
  });
  try {
    const res = await call(safetyRoutes, 'POST', '/api/alert', { latitude: 40.7, longitude: -74, includeLocation: true });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.unreachableContacts, true);
    assert.match(res.body.error, /911/);
    assert.ok(!calls.some((c) => c.text.includes('INSERT INTO emergency_alerts')),
      'an alert that could never be delivered must not burn the retry window');
  } finally { restore(); }
});

// ===========================================================================
// C. The SOS send path
// ===========================================================================

test('sos: an alert still goes out when the API key arrived after this module loaded', async () => {
  // THE BUG. routes/safety.js built its Resend client at REQUIRE time:
  //
  //     const resend = process.env.RESEND_API_KEY ? new Resend(...) : null;
  //
  // and then guarded each send with `if (!process.env.RESEND_API_KEY)`. The two
  // read the key at different moments. Any process that loaded this router
  // before the key was in the environment held `resend === null` for its whole
  // life, sailed past the guard, and hit `null.emails` — a TypeError, caught by
  // the local handler, reported as "this contact could not be reached". Every
  // contact. Forever. On the SOS route.
  //
  // services/emailService.js was written for exactly this ("the client is built
  // lazily, not at require time, so a module loaded before dotenv (or in a
  // test) does not permanently capture a missing key") and its own header names
  // routes/safety.js as one of the two callers that should stop hand-rolling
  // it. This test is that migration, pinned: the send has to be resolved when
  // the alert is sent, not when the file was read.
  //
  // The trigger in production is a key rotation or a require-order change, both
  // of which are one-line events that nothing would report.
  const r = stubResend();
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) return { rows: [] };
    if (sql.includes('FROM trusted_contacts')) return { rows: [{ id: 1, contact_name: 'Mum', contact_email: 'mum@example.com' }] };
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Me' }] };
    if (sql.includes('INSERT INTO emergency_alerts')) return { rows: [{ id: 501 }] };
    return null;
  });
  const cap = captureConsole();
  try {
    await withEnv({ RESEND_API_KEY: 'key-set-after-require' }, async () => {
      emailService.resetClient();
      const res = await call(safetyRoutes, 'POST', '/api/alert', { latitude: 40.7, longitude: -74, includeLocation: true });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(r.sends.length, 1, 'the alert must actually reach the provider');
      assert.strictEqual(r.sends[0].payload.to, 'mum@example.com');
    });
  } finally {
    cap.restore(); r.restore(); restore(); emailService.resetClient();
  }
});

test('sos: the alert email carries a deadline, a safety sender and a header-safe subject', async () => {
  // The properties that must survive the migration onto the shared sender.
  const r = stubResend();
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) return { rows: [] };
    if (sql.includes('FROM trusted_contacts')) return { rows: [{ id: 1, contact_name: 'Mum', contact_email: 'mum@example.com' }] };
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Ada\r\nBcc: someone@evil.example' }] };
    if (sql.includes('INSERT INTO emergency_alerts')) return { rows: [{ id: 502 }] };
    return null;
  });
  const cap = captureConsole();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      await call(safetyRoutes, 'POST', '/api/alert', { latitude: 40.7, longitude: -74, includeLocation: true });
      assert.strictEqual(r.sends.length, 1);
      const { payload, options } = r.sends[0];
      assert.match(payload.from, /alerts@flockcorp\.com/, 'an SOS is not sent from the marketing address');
      assert.ok(!/[\r\n]/.test(payload.subject), `subject carried a newline: ${JSON.stringify(payload.subject)}`);
      assert.ok(options && options.signal, 'round 12: an undeadlined send parks the SOS for minutes');
    });
  } finally {
    cap.restore(); r.restore(); restore(); emailService.resetClient();
  }
});

test('sos: no trusted contact address is written to a log line', async () => {
  // A trusted contact is a THIRD PARTY who never signed up for Flock, and on a
  // teen safety feature they are typically a parent. Their address is the most
  // identifying thing in the request. routes/safety.js logged it in full on
  // four paths (skip, provider error, success, throw), and every one of those
  // lands in Railway's log retention, which is not a system anybody has agreed
  // to store a minor's parent's address in.
  //
  // The failure being diagnosed is "did this go out and to which contact", and
  // a masked local part with the domain intact answers that. The address itself
  // is not needed to answer it.
  const r = stubResend({ error: { message: 'rate_limit_exceeded' } });
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) return { rows: [] };
    if (sql.includes('FROM trusted_contacts')) {
      return { rows: [{ id: 1, contact_name: 'Mum', contact_email: 'patricia.oleary@example.com' }] };
    }
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Me' }] };
    if (sql.includes('INSERT INTO emergency_alerts')) return { rows: [{ id: 503 }] };
    return null;
  });
  const cap = captureConsole();
  let text;
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      await call(safetyRoutes, 'POST', '/api/alert', { latitude: 40.7, longitude: -74, includeLocation: true });
    });
    text = cap.text();
  } finally {
    cap.restore(); r.restore(); restore(); emailService.resetClient();
  }
  assert.ok(!text.includes('patricia.oleary@example.com'),
    `a trusted contact's address reached the log:\n${text}`);
  assert.ok(text.includes('example.com'), 'the domain is what makes a delivery failure diagnosable');
});

test('sos: a delivery failure is still reported to the user, in full', async () => {
  // The control for the masking above: hiding the address must not hide the
  // failure. The caller owns these contacts, so the response says exactly who
  // was and was not reached.
  const r = stubResend({ error: { message: 'rate_limit_exceeded' } });
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) return { rows: [] };
    if (sql.includes('FROM trusted_contacts')) return { rows: [{ id: 1, contact_name: 'Mum', contact_email: 'mum@example.com' }] };
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Me' }] };
    if (sql.includes('INSERT INTO emergency_alerts')) return { rows: [{ id: 504 }] };
    return null;
  });
  const cap = captureConsole();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      const res = await call(safetyRoutes, 'POST', '/api/alert', { latitude: 40.7, longitude: -74, includeLocation: true });
      assert.strictEqual(res.status, 502);
      assert.strictEqual(res.body.canRetry, true);
      assert.match(res.body.error, /911/);
      assert.strictEqual(res.body.alerts[0].sent, false);
      assert.strictEqual(res.body.alerts[0].email, 'mum@example.com', 'the caller owns these contacts');
    });
  } finally {
    cap.restore(); r.restore(); restore(); emailService.resetClient();
  }
});

// ===========================================================================
// D. services/emailService.js — the one outbound path
// ===========================================================================

test('email: a recipient that is not one deliverable address is refused, not sent', async () => {
  // This module is the single outbound mail path, so it is the right and only
  // place to be certain about what `to` means. It passed the value through
  // untouched: an array fanned out to every element, a comma-joined string
  // became a header with several recipients, and `undefined` produced a
  // provider error at the far end of an 8s deadline rather than a refusal here.
  //
  // Every caller today sends exactly one address, which is precisely why this
  // costs nothing and closes the class.
  const r = stubResend();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      for (const to of [
        undefined, null, '', 42, ['a@b.co', 'c@d.co'], { to: 'a@b.co' },
        'a@b.co,c@d.co', 'a@b.co\r\nBcc: c@d.co', 'nope', 'x@y.invalid',
      ]) {
        const out = await emailService.sendEmail({ to, subject: 's', html: '<p>x</p>' });
        assert.strictEqual(out.sent, false, `${JSON.stringify(to)} must not be sent`);
      }
      assert.strictEqual(r.sends.length, 0, 'nothing may reach the provider');
    });
  } finally { r.restore(); emailService.resetClient(); }
});

test('email: a subject can never carry a header break', async () => {
  // A subject IS a header. services/moderationAlerts.js strips CR/LF in its own
  // copy and routes/safety.js strips it in a second copy; the shared sender,
  // which is the only thing both of them go through, did not. A third caller
  // that forgets is the whole failure mode, and there is now a third caller.
  const r = stubResend();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      await emailService.sendEmail({
        to: 'a@b.co', subject: 'Hi\r\nBcc: evil@example.com', html: '<p>x</p>',
      });
      assert.strictEqual(r.sends.length, 1);
      assert.ok(!/[\r\n]/.test(r.sends[0].payload.subject),
        `subject reached the provider as ${JSON.stringify(r.sends[0].payload.subject)}`);
    });
  } finally { r.restore(); emailService.resetClient(); }
});

test('email: recipients are masked in the log on every path', async () => {
  // The same rule as the SOS path, applied where it actually belongs: this
  // module logs a line for the skip, the provider error and the success, and
  // every caller of it mails a real person. Password reset and email
  // verification go through here too, so this is every address the product
  // touches, not just the safety ones.
  const cases = [
    { stub: () => stubResend(), key: undefined },                                  // skipped
    { stub: () => stubResend({ error: { message: 'boom' } }), key: 'k' },          // provider error
    { stub: () => stubResend(), key: 'k' },                                        // success
    { stub: () => stubResend({ throws: 'socket hang up' }), key: 'k' },            // threw
  ];
  for (const c of cases) {
    const r = c.stub();
    const cap = captureConsole();
    let text;
    try {
      await withEnv({ RESEND_API_KEY: c.key }, async () => {
        emailService.resetClient();
        await emailService.sendEmail({ to: 'patricia.oleary@example.com', subject: 's', html: '<p>x</p>' });
      });
      text = cap.text();
    } finally { cap.restore(); r.restore(); emailService.resetClient(); }
    assert.ok(!text.includes('patricia.oleary@example.com'), `address logged in full:\n${text}`);
  }
});

test('email: a link-local or unique-local base URL is never mailed to anyone', async () => {
  // isUnmailableBase's own comment says it refuses "a loopback / link-local /
  // .local host". It refused 127/8, 10/8, 192.168/16, 172.16/12 and ::1 — and
  // not one actual link-local address. 169.254.0.0/16 is the range that carries
  // the cloud metadata endpoint, fe80::/10 is its IPv6 counterpart, and
  // fc00::/7 is the IPv6 private range with no v4 equivalent in the list at
  // all. A base URL is put into a verification and a password-reset link, so
  // one of these is a dead link mailed to a real person for the one action that
  // unlocks their account.
  for (const bad of [
    'https://169.254.169.254', 'https://169.254.1.1',
    'https://[fe80::1]', 'https://[fc00::1]', 'https://[fd00::1]', 'https://[::]',
    'https://[::ffff:127.0.0.1]',
  ]) {
    assert.strictEqual(emailService.isUnmailableBase(bad), true, `${bad} must never be mailed`);
  }
  for (const ok of ['https://flockcorp.com', 'https://app.flockcorp.com', 'https://172.32.0.1']) {
    assert.strictEqual(emailService.isUnmailableBase(ok), false, `${ok} is a public https URL`);
  }
});

test('email: one definition of "can this address receive mail", not three', () => {
  // routes/auth.js has isMailableAddress, services/moderationAlerts.js has
  // isMailable, routes/safety.js had EMAIL_RE, and the three disagreed — which
  // is how an .invalid address became a trusted contact while being refused as
  // a moderation recipient. The shared sender is where the answer belongs,
  // because it is the thing that would have to deliver to the address.
  assert.strictEqual(typeof emailService.isMailableAddress, 'function',
    'services/emailService.js must export the shared predicate');
  const fs = require('node:fs');
  const path = require('node:path');
  for (const f of ['routes/safety.js', 'services/moderationAlerts.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.match(src, /require\('\.\.?\/(services\/)?emailService'\)/,
      `${f} must import the shared sender rather than reimplementing it`);
  }
});

// ===========================================================================
// E. services/moderationAlerts.js
// ===========================================================================

function alertHarness({ admins = [], resendKey = 'k', alertEnv = undefined } = {}) {
  const realQuery = pool.query;
  const realSend = emailService.sendEmail;
  const mails = [];
  pool.query = async (text) => {
    if (String(text).includes("role = 'admin'")) return { rows: admins };
    return { rows: [], rowCount: 0 };
  };
  emailService.sendEmail = async (msg) => { mails.push(msg); return { sent: true, id: 't' }; };
  const savedKey = process.env.RESEND_API_KEY;
  const savedEnv = process.env.MODERATION_ALERT_EMAIL;
  if (resendKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = resendKey;
  if (alertEnv === undefined) delete process.env.MODERATION_ALERT_EMAIL; else process.env.MODERATION_ALERT_EMAIL = alertEnv;
  moderationAlerts.__testing.resetEmailWindow();
  const cap = captureConsole();
  return {
    mails,
    text: () => cap.text(),
    restore() {
      cap.restore();
      pool.query = realQuery;
      emailService.sendEmail = realSend;
      if (savedKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = savedKey;
      if (savedEnv === undefined) delete process.env.MODERATION_ALERT_EMAIL; else process.env.MODERATION_ALERT_EMAIL = savedEnv;
      moderationAlerts.__testing.resetEmailWindow();
    },
  };
}

const REPORT = { reportId: 42, content_type: 'dm', reason: 'harassment', reporter: 'Ava' };

test('alerting: an unset MODERATION_ALERT_EMAIL is named, not merely implied', async () => {
  // TASKS.md records MODERATION_ALERT_EMAIL as unset in production, and this is
  // what that actually looks like in the log today: the fallback address is
  // named, and nothing says it IS the fallback. An operator reading
  // "Email went to hello@flockcorp.com (1 delivered)" cannot tell whether that
  // is the address they configured or the last resort standing in for it.
  //
  // moderationTooling.test.js already pins that zero admins is loud. This is
  // the other half of the same sentence and it was silent: the variable that
  // fixes it has to appear in the line that reports the problem, the way
  // ADMIN_USER_IDS already does.
  const h = alertHarness({ admins: [], alertEnv: undefined });
  try {
    const s = await moderationAlerts.alertModerators(null, REPORT);
    assert.strictEqual(s.emailRecipients[0], moderationAlerts.__testing.MODERATION_INBOX);
    assert.match(h.text(), /MODERATION_ALERT_EMAIL/,
      'the setting that would fix this must be nameable from the log line that reports it');
  } finally { h.restore(); }
});

test('alerting: a CONFIGURED address is not reported as a fallback', async () => {
  // The control. Crying "unset" at a correctly configured deployment is how a
  // real signal gets tuned out.
  const h = alertHarness({ admins: [], alertEnv: 'mods@flockcorp.com' });
  try {
    await moderationAlerts.alertModerators(null, REPORT);
    assert.ok(!/MODERATION_ALERT_EMAIL is not set/i.test(h.text()), h.text());
  } finally { h.restore(); }
});

test('alerting: the hourly ceiling counts EMAILS, which is what it is named for', async () => {
  // The constant is EMAILS_PER_HOUR and its comment is about Resend quota
  // during a brigading incident. The counter was charged once per REPORT and
  // then fanned out to up to MAX_RECIPIENTS addresses, so the real ceiling was
  // ten times the stated one — 400 sends an hour from a limiter that says 40.
  //
  // moderationTooling.test.js pins the single-recipient case at exactly
  // EMAILS_PER_HOUR, and that stays true: charging per recipient changes
  // nothing for the production deployment (one fallback address) and makes the
  // number mean what it says for every other one.
  const { EMAILS_PER_HOUR } = moderationAlerts.__testing;
  const list = Array.from({ length: 5 }, (_, i) => `mod${i}@flockcorp.com`).join(',');
  const h = alertHarness({ admins: [], alertEnv: list });
  try {
    for (let i = 0; i < EMAILS_PER_HOUR + 5; i++) {
      await moderationAlerts.alertModerators(null, { ...REPORT, reportId: i });
    }
    assert.ok(h.mails.length <= EMAILS_PER_HOUR,
      `sent ${h.mails.length} emails under a ceiling of ${EMAILS_PER_HOUR}`);
  } finally { h.restore(); }
});

test('alerting: a report that is held back by the ceiling still says so, with its id', async () => {
  // The control. A suppressed alert has to be louder in the log than a sent
  // one, never quieter — that is this file's whole thesis.
  const { EMAILS_PER_HOUR } = moderationAlerts.__testing;
  const h = alertHarness({ admins: [], alertEnv: 'mods@flockcorp.com' });
  try {
    for (let i = 0; i < EMAILS_PER_HOUR; i++) {
      await moderationAlerts.alertModerators(null, { ...REPORT, reportId: i });
    }
    const s = await moderationAlerts.alertModerators(null, { ...REPORT, reportId: 9999 });
    assert.strictEqual(s.emailSkipped, true);
    assert.match(h.text(), /#9999/);
    assert.match(h.text(), /NO EMAIL SENT/);
  } finally { h.restore(); }
});

test('alerting: an unbounded reporter name cannot reach a subject, a push body or a log line', async () => {
  // `reporter` is req.user.name, straight off the profile, and it is
  // interpolated into three places with no length of its own: the log line, the
  // `label` that becomes a PUSH BODY on a moderator's lock screen, and (through
  // the subject builder) a mail header. safeSubject caps the finished subject;
  // nothing capped the label or the log.
  //
  // A 4000-character display name is not the interesting case. A 300-character
  // one that pushes the report id off the end of a truncated lock-screen
  // notification is, because the id is the only actionable thing in it.
  const h = alertHarness({ admins: [], alertEnv: 'mods@flockcorp.com' });
  try {
    await moderationAlerts.alertModerators(null, { ...REPORT, reporter: 'A'.repeat(4000) });
    for (const line of h.text().split('\n')) {
      assert.ok(line.length < 500, `a log line grew to ${line.length} characters from one display name`);
    }
    assert.ok(h.mails[0].subject.length <= 200);
  } finally { h.restore(); }
});

test('alerting: a moderator address is not written to the log in full either', async () => {
  // Two lines name every recipient verbatim: the truncation warning and the
  // "EMAIL FAILED for every recipient" line. These are staff addresses rather
  // than a minor's parent's, so the stakes are lower than on the SOS path, but
  // the rule is the same one and there is no reason for this file to be the
  // exception to it.
  const h = alertHarness({ admins: [], alertEnv: 'duty.officer@flockcorp.com' });
  emailService.sendEmail = async () => ({ sent: false, error: 'boom' });
  try {
    await moderationAlerts.alertModerators(null, REPORT);
    assert.ok(!h.text().includes('duty.officer@flockcorp.com'), h.text());
    assert.ok(/flockcorp\.com/.test(h.text()), 'the domain still has to be readable');
  } finally { h.restore(); }
});

test('alerting: nothing it is handed can make it throw', async () => {
  // Its header states the contract ("nothing in here is allowed to throw") and
  // its one caller relies on it: routes/moderation.js fires it without
  // awaiting. The log line and the `label` above it were built OUTSIDE the try,
  // so a null report — or one whose fields are not strings — rejected the
  // promise instead of degrading. The report is already in the database at that
  // point; losing the notification is survivable, losing the process is not.
  const h = alertHarness({ admins: [], alertEnv: 'mods@flockcorp.com' });
  try {
    for (const bad of [null, undefined, 'report', 42, [], { reportId: { a: 1 }, reason: ['x'] }]) {
      const s = await moderationAlerts.alertModerators(null, bad);
      assert.ok(s && typeof s === 'object', `alertModerators(${JSON.stringify(bad)}) returned no summary`);
      assert.strictEqual(s.logged, true, 'the log leg is the one that is always true');
    }
  } finally { h.restore(); }
});

// ===========================================================================
// F. The SOS route as a mail relay
// ===========================================================================

test('contacts: the recipient list cannot be rewritten fast enough to be a mail relay', async () => {
  // WHAT THIS CLOSES. A trusted contact is an address the user types, and it is
  // never verified — nobody asks Mum whether she agreed to this. The alert
  // route is well bounded per USER (MAX_ATTEMPTS_PER_WINDOW attempts per 15
  // minutes) but says nothing about which ADDRESSES those attempts reach, and
  // nothing throttled the contact form at all. So five slots rewritten between
  // alerts turned a bounded 6-attempts-per-quarter-hour into roughly 120
  // Flock-branded emails an hour aimed at 120 DIFFERENT strangers, each with a
  // subject line ending in a display name the sender chose.
  //
  // The lever is deliberately the contact FORM and not the alert. Throttling
  // /alert would be delaying an SOS to slow down a spammer, which is not a
  // trade this file is allowed to make. Changing who your emergency contacts
  // are is not something anyone does thirty times an hour; sending an SOS
  // might be. DELETE is left alone on purpose — removing a recipient cannot
  // send mail to anybody, and taking someone off your emergency list is not an
  // action to put a speed limit on.
  const S2 = safetyRoutes.__test;
  assert.ok(S2.MAX_CONTACT_WRITES_PER_HOUR >= 15,
    'a real user setting up five contacts and fixing typos must never meet this');
  assert.ok(S2.MAX_CONTACT_WRITES_PER_HOUR <= 40,
    'above this it stops bounding the relay at all');
  S2.resetContactWrites();

  const { restore } = stubPool(async (sql) => {
    if (sql.includes('COUNT(*)::int AS n FROM trusted_contacts')) return { rows: [{ n: 0 }] };
    if (sql.includes('INSERT INTO trusted_contacts')) return { rows: [{ id: 1 }], rowCount: 1 };
    return null;
  });
  try {
    let refusedAt = null;
    for (let i = 0; i < S2.MAX_CONTACT_WRITES_PER_HOUR + 3; i++) {
      const res = await call(safetyRoutes, 'POST', '/api/contacts', {
        name: 'Mum', phone: `555010${i}`, email: `victim${i}@example.com`,
      });
      if (res.status === 429) { refusedAt = i; break; }
    }
    assert.ok(refusedAt !== null, 'the contact form has no ceiling at all');
    assert.strictEqual(refusedAt, S2.MAX_CONTACT_WRITES_PER_HOUR,
      'the ceiling must bite exactly where it says it does');
  } finally { restore(); S2.resetContactWrites(); }
});

test('contacts: the throttle never touches the alert itself', async () => {
  // The control, and the only property of the throttle that actually matters.
  // A user who has just spent their contact-write budget must still be able to
  // send an SOS, because the two have nothing to do with each other.
  const S2 = safetyRoutes.__test;
  S2.resetContactWrites();
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('COUNT(*)::int AS n FROM trusted_contacts')) return { rows: [{ n: 0 }] };
    if (sql.includes('INSERT INTO trusted_contacts')) return { rows: [{ id: 1 }], rowCount: 1 };
    if (sql.includes('FROM emergency_alerts')) return { rows: [] };
    if (sql.includes('FROM trusted_contacts')) return { rows: [{ id: 1, contact_name: 'Mum', contact_email: 'mum@example.com' }] };
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Me' }] };
    if (sql.includes('INSERT INTO emergency_alerts')) return { rows: [{ id: 601 }] };
    return null;
  });
  try {
    for (let i = 0; i < S2.MAX_CONTACT_WRITES_PER_HOUR + 2; i++) {
      await call(safetyRoutes, 'POST', '/api/contacts', {
        name: 'Mum', phone: `555020${i}`, email: `m${i}@example.com`,
      });
    }
    const res = await call(safetyRoutes, 'POST', '/api/alert', { latitude: 40.7, longitude: -74, includeLocation: true });
    assert.notStrictEqual(res.status, 429, 'an SOS may never be refused because of the contact form');
    assert.ok(calls.some((c) => c.text.includes('INSERT INTO emergency_alerts')),
      'the alert must still be attempted');
  } finally { restore(); S2.resetContactWrites(); }
});

test('contacts: DELETE is not throttled, because removing a recipient cannot send mail', async () => {
  const S2 = safetyRoutes.__test;
  S2.resetContactWrites();
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('DELETE FROM trusted_contacts')) return { rows: [{ id: 1 }], rowCount: 1 };
    if (sql.includes('COUNT(*)::int AS n FROM trusted_contacts')) return { rows: [{ n: 0 }] };
    if (sql.includes('INSERT INTO trusted_contacts')) return { rows: [{ id: 1 }], rowCount: 1 };
    return null;
  });
  try {
    for (let i = 0; i < S2.MAX_CONTACT_WRITES_PER_HOUR + 2; i++) {
      await call(safetyRoutes, 'POST', '/api/contacts', { name: 'Mum', phone: `55503${i}`, email: `m${i}@example.com` });
    }
    const res = await call(safetyRoutes, 'DELETE', '/api/contacts/1');
    assert.strictEqual(res.status, 200, 'taking somebody off your emergency list is always allowed');
  } finally { restore(); S2.resetContactWrites(); }
});

// ===========================================================================
// G. Round 3 — what the round-2 read found
// ===========================================================================

test('sos: a bookkeeping failure after a successful send is not reported as a failed alert', async () => {
  // THE ASYMMETRY. After the emails settle, the route writes the confirmed
  // count back to the claim row. The TOTAL-FAILURE branch guards that write
  // with `.catch()`; the SUCCESS branch did not. So a database blip on a
  // one-row UPDATE — after every contact had ALREADY been emailed — threw into
  // the outer catch and answered `500 Failed to send alert`.
  //
  // That is round 17's bug pointing the other way, and this direction is worse.
  // The user is told nobody was reached when everybody was, so they re-tap; the
  // row is still sitting at contacts_alerted = 0, so it reads as in flight and
  // the retry is refused for the next sixty seconds with "an alert is already
  // going out". Delivered, disbelieved, and locked out.
  //
  // The write is bookkeeping for the COOLDOWN. It is not the thing the user
  // asked for, and its failure is not theirs to hear about.
  const r = stubResend();
  const realQuery = pool.query;
  const realConnect = pool.connect;
  const errors = [];
  const inTx = async (sql) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql) || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM emergency_alerts')) return { rows: [] };
    if (sql.includes('FROM trusted_contacts')) return { rows: [{ id: 1, contact_name: 'Mum', contact_email: 'mum@example.com' }] };
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Me' }] };
    if (sql.includes('INSERT INTO emergency_alerts')) return { rows: [{ id: 700 }] };
    return { rows: [], rowCount: 0 };
  };
  pool.query = async (text) => {
    const sql = String(text);
    if (sql.includes('FROM users WHERE id = $1') && sql.includes('token_version')) return { rows: [ME] };
    // The one statement that fails: the post-send bookkeeping UPDATE.
    if (sql.includes('UPDATE emergency_alerts SET contacts_alerted')) {
      throw new Error('connection terminated unexpectedly');
    }
    return inTx(sql);
  };
  pool.connect = async () => ({ query: async (t) => inTx(String(t)), release: () => {} });
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      const res = await call(safetyRoutes, 'POST', '/api/alert', { latitude: 40.7, longitude: -74, includeLocation: true });
      assert.strictEqual(r.sends.length, 1, 'the email did go out');
      assert.strictEqual(res.status, 200, `the alert was delivered; the answer was ${res.status}`);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.alerts[0].sent, true);
    });
    assert.ok(errors.join('\n').includes('700'),
      'the lost bookkeeping write must still be loud in the log, with the alert id');
  } finally {
    console.error = realError;
    pool.query = realQuery; pool.connect = realConnect;
    r.restore(); emailService.resetClient();
  }
});

test('test email: the daily allowance is not spent on an account that has no address', async () => {
  // The allowance is three per day and it was charged BEFORE the route looked
  // at whether there was anywhere to send to. An account with no mailable
  // address (an Apple private-relay signup, before the user adds a real one)
  // therefore burned its whole day's budget on three refusals, and the button
  // that exists to answer "are my emergency alerts set up" stopped answering
  // anything for 24 hours.
  //
  // Nothing is spent by asking a question whose answer cannot change within the
  // window, and no mail can be sent down this path either way, so there is
  // nothing here to abuse.
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('SELECT name, email FROM users')) return { rows: [{ name: 'Me', email: 'me@apple-signin.invalid' }] };
    return null;
  });
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      for (let i = 0; i < 5; i++) {
        const res = await call(safetyRoutes, 'GET', '/api/test-email');
        assert.strictEqual(res.status, 200, 'this must never become a 429');
        assert.strictEqual(res.body.ok, false);
        assert.match(res.body.error, /No email address on file/);
      }
    });
  } finally { restore(); }
});

test('copy: no em dash reaches anything routes/safety.js sends or says', () => {
  // SLOP-AUDIT.md rule 1, applied to the file rather than to one string. The
  // test-email subject shipped as "Flock Safety — Test Email", which is a
  // user-visible line in somebody's inbox, and it survived every previous round
  // because nothing looked at this file for it. moderationTooling.test.js
  // already holds the alert email to the same rule; the SOS route was not held
  // to anything.
  //
  // Comments are stripped first: an em dash in a comment is prose for the next
  // person reading the code, which is the one place the rule does not apply.
  const fs = require('node:fs');
  const path = require('node:path');
  for (const f of ['routes/safety.js', 'services/moderationAlerts.js', 'services/emailService.js']) {
    // \r is stripped first on purpose: JS's `.` does not match a carriage
    // return, so on CRLF sources `//.*$` never reaches the end of the line and
    // the comment stripper silently strips nothing.
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r/g, '');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      // `[^:]` in front so a `https://` inside a string is not read as a comment.
      .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
      .join('\n');
    const bad = code.split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => line.includes('—'));
    assert.deepStrictEqual(bad, [], `em dash in ${f} outside a comment: ${JSON.stringify(bad)}`);
  }
});

// ===========================================================================
// H. Round 4 — what the round-3 read found
// ===========================================================================

test('blocks: a value that COERCES to a user id is not a user id', async () => {
  // Number() is happy to turn things into a plausible id, and the guard only
  // asked whether the result was a positive integer. So:
  //
  //   Number(true)  === 1   -> a block check answered about USER 1
  //   Number(['5']) === 5   -> a block check answered about USER 5
  //
  // Both are silently WRONG ANSWERS rather than refusals, and on this control a
  // wrong answer is indistinguishable from a correct one at every call site.
  // The array case is not hypothetical: socket payloads are attacker-shaped
  // JSON, and `{"receiverId": ["5"]}` is exactly the coerced-non-scalar family
  // validators/shape.js exists for. `false` stays ABSENT because callers use it
  // to mean "nobody"; `true` never means anybody.
  for (const bad of [true, ['5'], [5], {}, { id: 5 }, [], new Date()]) {
    await assert.rejects(() => blocks.isBlockedBetween(7, bad), /id/i,
      `${JSON.stringify(bad)} must not be read as a user id`);
  }
  assert.strictEqual(await blocks.isBlockedBetween(7, false), false, 'false still means nobody');
});

test('email: a rotated API key is picked up, not cached for the life of the process', async () => {
  // The root of the bug routes/safety.js was migrated off. Moving it onto the
  // lazy client fixed capture at REQUIRE time; the lazy client itself still
  // built once and kept that instance forever, so a key rotated inside a live
  // process left every subsequent send authenticating with the OLD secret. That
  // is a 401 from the provider on every message, including an SOS, with nothing
  // in the code able to notice — resetClient() exists but only the tests call
  // it.
  //
  // A cached client has to be invalidated by the thing it was built from.
  const r = stubResend();
  try {
    await withEnv({ RESEND_API_KEY: 'old-key' }, async () => {
      emailService.resetClient();
      await emailService.sendEmail({ to: 'a@b.co', subject: 's', html: '<p>x</p>' });
    });
    await withEnv({ RESEND_API_KEY: 'new-key' }, async () => {
      await emailService.sendEmail({ to: 'a@b.co', subject: 's', html: '<p>x</p>' });
    });
    assert.deepStrictEqual(r.sends.map((s) => s.key), ['old-key', 'new-key'],
      'the second send used a stale client built from the previous key');
  } finally { r.restore(); emailService.resetClient(); }
});

test('email: the From header cannot be broken either', async () => {
  // `to` and `subject` are now settled in the shared sender; `from` was the
  // third header and the only one left passed through untouched. It is a
  // constant at both call sites today, which is exactly the argument for
  // closing it now rather than after a fourth caller builds one.
  const r = stubResend();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      await emailService.sendEmail({
        to: 'a@b.co', subject: 's', html: '<p>x</p>',
        from: 'Flock <hello@flockcorp.com>\r\nBcc: evil@example.com',
      });
      assert.strictEqual(r.sends.length, 1);
      assert.ok(!/[\r\n]/.test(r.sends[0].payload.from),
        `from reached the provider as ${JSON.stringify(r.sends[0].payload.from)}`);
    });
  } finally { r.restore(); emailService.resetClient(); }
});

// ===========================================================================
// I. Round 5 — auditing the round-2 fix itself
// ===========================================================================

test('contacts: a fumbled form does not spend the anti-relay budget', async () => {
  // A FLAW IN THE ROUND-2 FIX, found by re-reading it rather than by a
  // failure. The throttle was charged BEFORE validation, on the theory that a
  // limiter counting only successes can be walked past. That reasoning does not
  // survive contact with what the limiter is actually for: reaching a NEW
  // address requires a write that LANDS. A request refused for a bad email
  // address stores nothing, mails nothing, and does not even open a database
  // connection, so charging for it buys no safety at all.
  //
  // What it does buy is the wrong person paying. Somebody adding five contacts
  // on a small phone keyboard and mistyping a few addresses could spend the
  // hour's budget without ever saving a single contact, and then be locked out
  // of their own Safety screen. On this screen that is the worst possible
  // trade: the throttle exists to protect strangers from a spammer, and it was
  // charging the user who is trying to set up their emergency contacts.
  const S2 = safetyRoutes.__test;
  S2.resetContactWrites();
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('COUNT(*)::int AS n FROM trusted_contacts')) return { rows: [{ n: 0 }] };
    if (sql.includes('INSERT INTO trusted_contacts')) return { rows: [{ id: 1 }], rowCount: 1 };
    return null;
  });
  try {
    // Fumble the form well past the ceiling. Nothing is stored by any of these.
    for (let i = 0; i < S2.MAX_CONTACT_WRITES_PER_HOUR + 5; i++) {
      const res = await call(safetyRoutes, 'POST', '/api/contacts', {
        name: 'Mum', phone: '5550100', email: 'not-an-address',
      });
      assert.strictEqual(res.status, 400, 'a bad address is a 400 throughout');
    }
    // The budget is untouched, so the contact they were trying to save saves.
    const ok = await call(safetyRoutes, 'POST', '/api/contacts', {
      name: 'Mum', phone: '5550100', email: 'mum@example.com',
    });
    assert.strictEqual(ok.status, 201, 'a refused write may not spend the budget');
  } finally { restore(); S2.resetContactWrites(); }
});

test('contacts: a write that does NOT land does not spend the budget either', async () => {
  // The same rule one level down: a PUT against a contact that is not yours
  // answers 404 and changes nothing, so it cannot be a step toward mailing
  // anybody and must not be charged.
  const S2 = safetyRoutes.__test;
  S2.resetContactWrites();
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('UPDATE trusted_contacts')) return { rows: [], rowCount: 0 };
    if (sql.includes('COUNT(*)::int AS n FROM trusted_contacts')) return { rows: [{ n: 0 }] };
    if (sql.includes('INSERT INTO trusted_contacts')) return { rows: [{ id: 1 }], rowCount: 1 };
    return null;
  });
  try {
    for (let i = 0; i < S2.MAX_CONTACT_WRITES_PER_HOUR + 5; i++) {
      const res = await call(safetyRoutes, 'PUT', '/api/contacts/999', {
        name: 'Mum', phone: '5550100', email: 'mum@example.com',
      });
      assert.strictEqual(res.status, 404);
    }
    const ok = await call(safetyRoutes, 'POST', '/api/contacts', {
      name: 'Mum', phone: '5550100', email: 'mum@example.com',
    });
    assert.strictEqual(ok.status, 201);
  } finally { restore(); S2.resetContactWrites(); }
});

test('contacts: the ceiling still bites on writes that DO land', async () => {
  // The control for both of the above. Moving the charge to the landing point
  // must not turn the limiter off.
  const S2 = safetyRoutes.__test;
  S2.resetContactWrites();
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('COUNT(*)::int AS n FROM trusted_contacts')) return { rows: [{ n: 0 }] };
    if (sql.includes('INSERT INTO trusted_contacts')) return { rows: [{ id: 1 }], rowCount: 1 };
    return null;
  });
  try {
    for (let i = 0; i < S2.MAX_CONTACT_WRITES_PER_HOUR; i++) {
      const res = await call(safetyRoutes, 'POST', '/api/contacts', {
        name: 'Mum', phone: `55504${i}`, email: `v${i}@example.com`,
      });
      assert.strictEqual(res.status, 201, `write ${i} should have landed`);
    }
    const over = await call(safetyRoutes, 'POST', '/api/contacts', {
      name: 'Mum', phone: '5550499', email: 'v99@example.com',
    });
    assert.strictEqual(over.status, 429, 'the relay ceiling must still exist');
  } finally { restore(); S2.resetContactWrites(); }
});

test('blocks: a caller inside a transaction can check the block on the client it holds', async () => {
  // THE N+1 QUESTION, answered. routes/flocks.js records what the per-pair
  // version cost the invite path: a block check that talks to the pool BORROWS
  // A SECOND CONNECTION, and a caller that is already holding one from a
  // transaction is then holding two out of twenty for the length of the check.
  // That is the shape that turns a slow query into pool exhaustion, and it is
  // not fixable from the call site without duplicating the SQL, which is what
  // routes/flocks.js had to do twice.
  //
  // The one REMAINING loop of this shape is sockets/handlers.js's flock_invite
  // handler, and it does not need this parameter at all: it should ask
  // getInvisibleUserIds ONCE and test a Set, which is what the next block in
  // that same handler already does. Recorded as a handoff, not fixed here.
  const realQuery = pool.query;
  let usedPool = false;
  pool.query = async () => { usedPool = true; return { rows: [] }; };
  const txCalls = [];
  const txClient = { query: async (t, p) => { txCalls.push({ t: String(t), p }); return { rows: [{ '?column?': 1 }] }; } };
  try {
    const blocked = await blocks.isBlockedBetween(7, 9, txClient);
    assert.strictEqual(blocked, true, 'the answer must come from the supplied client');
    assert.strictEqual(usedPool, false, 'a second connection must not be checked out');
    assert.strictEqual(txCalls.length, 1);
    assert.deepStrictEqual(txCalls[0].p, [7, 9], 'and the ids reach it normalized');

    txCalls.length = 0;
    await blocks.getInvisibleUserIds(9, txClient);
    assert.strictEqual(usedPool, false);
    assert.strictEqual(txCalls.length, 1, 'the set-based read takes a client too');
  } finally { pool.query = realQuery; }
});

// ===========================================================================
// J. Round 6 — the gaps a mutation pass found in the tests above
// ===========================================================================
// Every test in this section exists because a deliberate reintroduction of one
// of the defects above SURVIVED the suite. A fix whose loss nothing can detect
// is not a fix, it is a comment.

test('email: the shared predicate is the one every sender actually holds', () => {
  // "Imports emailService" is not the property that matters; USING its
  // definition is. Both of these files can keep the import while quietly
  // restoring a private regex beside it, and a grep for the require cannot tell
  // the difference. Identity can.
  assert.strictEqual(S.EMAIL_RE, emailService.MAILABLE_RE,
    'routes/safety.js is matching addresses against something of its own again');
  assert.strictEqual(moderationAlerts.__testing.isMailable, emailService.isMailableAddress,
    'services/moderationAlerts.js is matching addresses against something of its own again');
});

test('email: the address rules hold at every boundary they claim', () => {
  const ok = (a) => emailService.isMailableAddress(a);
  // A one-character TLD does not exist.
  assert.strictEqual(ok('a@b.c'), false);
  assert.strictEqual(ok('a@b.co'), true);
  // The separators have to be excluded on BOTH sides of the @, not only on the
  // side the earlier test happened to exercise.
  assert.strictEqual(ok('a,b@c.co'), false, 'comma in the local part');
  assert.strictEqual(ok('a;b@c.co'), false, 'semicolon in the local part');
  assert.strictEqual(ok('<a>@b.co'), false, 'angle brackets in the local part');
  assert.strictEqual(ok('a"b@c.co'), false, 'quote in the local part');
  // RFC 5321 caps the whole path at 254 octets. Accepting more only moves the
  // rejection to the provider, which on this route means the moment it matters.
  assert.strictEqual(`${'a'.repeat(242)}@example.com`.length, 254, 'exactly on the limit');
  assert.strictEqual(ok(`${'a'.repeat(242)}@example.com`), true, '254 is allowed');
  assert.strictEqual(ok(`${'a'.repeat(243)}@example.com`), false, '255 is not');
  assert.strictEqual(ok(`${'a'.repeat(30)}@example.com`), true);
});

test('contacts: an over-long address is told it is too long, not that it looks wrong', () => {
  // Two problems, two messages, and the boundary between them has to sit
  // exactly on the RFC limit. When the form's own cap drifted one character
  // above it, a 255-character address fell past the length branch and came back
  // "does not look right", which sends the user hunting for a typo in an
  // address whose only fault is its length.
  const long = `${'a'.repeat(300)}@example.com`;
  assert.match(S.readContactFields({ name: 'Mum', phone: '5550100', email: long }).error, /too long/i);
  const at255 = `${'a'.repeat(255 - '@example.com'.length)}@example.com`;
  assert.strictEqual(at255.length, 255, 'one character over the RFC limit');
  assert.match(S.readContactFields({ name: 'Mum', phone: '5550100', email: at255 }).error, /too long/i);
});

test('blocks: an id that coerces to zero is refused like any other unusable one', async () => {
  // `0` and `'0'` are ABSENT by name. Values that merely COERCE to zero are not
  // the same thing, and the boundary belongs on the integer rather than on the
  // handful of literals somebody thought to list.
  for (const bad of ['00', '0.0', ' 0 ', '-0.5', '0x0']) {
    await assert.rejects(() => blocks.isBlockedBetween(7, bad), /id/i, JSON.stringify(bad));
  }
});

test('blocks: the set-based read refuses an id it cannot use, like the pair check', async () => {
  // getInvisibleUserIds drives every roster, feed and fan-out filter in the
  // app. Answering [] for an id it could not read is "nobody is invisible to
  // this person", which is the fail-open answer in list form.
  for (const bad of [NaN, 'abc', 1.5, -3, true, ['5'], {}]) {
    await assert.rejects(() => blocks.getInvisibleUserIds(bad), /id/i, JSON.stringify(bad));
  }
  assert.deepStrictEqual(await blocks.getInvisibleUserIds(null), [], 'absent is still empty');
});

test('sos: one undeliverable contact does not stop the others, and is reported', async () => {
  // The mixed list, which is the realistic one: a working contact plus an old
  // row carrying an Apple private-relay placeholder. The pre-claim gate passes
  // because SOMEBODY is reachable, so the only thing between the bad row and a
  // wasted send is the fan-out filter, and nothing was testing that.
  const r = stubResend();
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) return { rows: [] };
    if (sql.includes('FROM trusted_contacts')) {
      return {
        rows: [
          { id: 1, contact_name: 'Mum', contact_email: 'mum@example.com' },
          { id: 2, contact_name: 'Dad', contact_email: 'dad@apple-signin.invalid' },
          { id: 3, contact_name: 'Sam', contact_email: null },
        ],
      };
    }
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Me' }] };
    if (sql.includes('INSERT INTO emergency_alerts')) return { rows: [{ id: 801 }] };
    return null;
  });
  const cap = captureConsole();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      const res = await call(safetyRoutes, 'POST', '/api/alert', { latitude: 40.7, longitude: -74, includeLocation: true });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(r.sends.map((s) => s.payload.to), ['mum@example.com'],
        'only the deliverable contact may be mailed');
      // ONE ROW PER CONTACT. Found by mutation: reverting the fan-out filter
      // alone does not change what the provider receives, because the shared
      // sender refuses the address a second time downstream. What it does
      // change is this list, which gains a DUPLICATE entry for the bad contact
      // (once from the skip loop, once from the settled loop) and a skipped
      // count that no longer adds up. The user reads "1 email sent, 2 contacts
      // skipped" against three contacts. Defence in depth is why the mutation
      // was invisible; the report is where it shows.
      assert.strictEqual(res.body.alerts.length, 3,
        'every contact appears exactly once in the report');
      assert.strictEqual(new Set(res.body.alerts.map((a) => a.contactName)).size, 3);
      // Round 23 changed what this sentence answers. It used to count emails,
      // which is the machinery's question; it now names who knows, which is
      // the one the person who pressed the button is asking. The count of
      // contacts who were NOT reached still has to be in it, because that is
      // the half they have to act on.
      assert.match(res.body.message, /Mum has been told/);
      assert.match(res.body.message, /2 contacts could not be reached/);
      assert.strictEqual(res.body.contactsAlerted, 1);
      const dad = res.body.alerts.find((a) => a.contactName === 'Dad');
      assert.ok(dad, 'the undeliverable contact must appear in the report');
      assert.strictEqual(dad.sent, false);
      assert.match(dad.reason, /cannot receive mail/i,
        'and the reason has to name the actual problem, not "no email"');
      const sam = res.body.alerts.find((a) => a.contactName === 'Sam');
      assert.strictEqual(sam.reason, 'no email', 'a missing address is still its own reason');
    });
  } finally { cap.restore(); r.restore(); restore(); emailService.resetClient(); }
});

test('share location: an undeliverable contact is skipped there too', async () => {
  // The sibling route keeps drifting from /alert (round 17 found the same thing
  // about its failure response), so the property is pinned on both.
  const r = stubResend();
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('FROM trusted_contacts')) {
      return {
        rows: [
          { id: 1, contact_name: 'Mum', contact_email: 'mum@example.com' },
          { id: 2, contact_name: 'Dad', contact_email: 'dad@unclaimed.invalid' },
        ],
      };
    }
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Me' }] };
    return null;
  });
  const cap = captureConsole();
  try {
    await withEnv({ RESEND_API_KEY: 'k' }, async () => {
      emailService.resetClient();
      const res = await call(safetyRoutes, 'POST', '/api/share-location', { latitude: 40.7, longitude: -74 });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(r.sends.map((s) => s.payload.to), ['mum@example.com']);
      assert.match(res.body.message, /1 skipped/);
    });
  } finally { cap.restore(); r.restore(); restore(); emailService.resetClient(); }
});

test('sos: the no-key path does not log a contact address either', async () => {
  // The masking test above ran with a key set, so it only ever exercised the
  // provider-error branch. The branch that fires when RESEND_API_KEY was never
  // set was untested, and that is the one that runs on EVERY alert on a
  // deployment where the mail leg is off.
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) return { rows: [] };
    if (sql.includes('FROM trusted_contacts')) return { rows: [{ id: 1, contact_name: 'Mum', contact_email: 'patricia.oleary@example.com' }] };
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Me' }] };
    if (sql.includes('INSERT INTO emergency_alerts')) return { rows: [{ id: 802 }] };
    return null;
  });
  const cap = captureConsole();
  let text;
  try {
    await withEnv({ RESEND_API_KEY: undefined }, async () => {
      emailService.resetClient();
      const res = await call(safetyRoutes, 'POST', '/api/alert', { latitude: 40.7, longitude: -74, includeLocation: true });
      assert.strictEqual(res.status, 502, 'with no key nothing is delivered and the user is told so');
    });
    text = cap.text();
  } finally { cap.restore(); restore(); emailService.resetClient(); }
  assert.ok(!text.includes('patricia.oleary@example.com'), `address logged in full:\n${text}`);
});

test('contacts: editing is throttled and charged the same way adding is', async () => {
  // PUT is the cheaper half of the churn: five slots edited in place needs no
  // deletes and no count check at all. Testing only POST left the relay open
  // through the route right next to it.
  const S2 = safetyRoutes.__test;
  S2.resetContactWrites();
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('UPDATE trusted_contacts')) return { rows: [{ id: 1 }], rowCount: 1 };
    return null;
  });
  try {
    for (let i = 0; i < S2.MAX_CONTACT_WRITES_PER_HOUR; i++) {
      const res = await call(safetyRoutes, 'PUT', '/api/contacts/1', {
        name: 'Mum', phone: '5550100', email: `v${i}@example.com`,
      });
      assert.strictEqual(res.status, 200, `edit ${i} should have landed`);
    }
    const over = await call(safetyRoutes, 'PUT', '/api/contacts/1', {
      name: 'Mum', phone: '5550100', email: 'v99@example.com',
    });
    assert.strictEqual(over.status, 429, 'editing must be bounded, not just adding');
  } finally { restore(); S2.resetContactWrites(); }
});

test('alerting: the fallback line says the setting is NOT SET, not just that one exists', async () => {
  // Naming the variable is half the sentence. "Set MODERATION_ALERT_EMAIL on
  // the deployment" reads identically whether it was never set or was set to
  // something unusable, and those two need different actions from whoever is
  // reading the log.
  const h = alertHarness({ admins: [], alertEnv: undefined });
  try {
    await moderationAlerts.alertModerators(null, REPORT);
    const t = h.text();
    assert.match(t, /MODERATION_ALERT_EMAIL/);
    assert.match(t, /is not set/i, 'the state has to be nameable, not only the variable');
    assert.match(t, /fallback/i, 'and it has to say the address used was a last resort');
  } finally { h.restore(); }
});

test('alerting: a report id cannot break a log line into two', async () => {
  // reportId is normalized alongside every other field. Without that, a value
  // carrying CR/LF splits the one log line that is guaranteed to exist for
  // every report, and searching the log by report id stops finding it.
  const h = alertHarness({ admins: [], alertEnv: 'mods@flockcorp.com' });
  try {
    await moderationAlerts.alertModerators(null, { ...REPORT, reportId: '9\r\n[MODERATION] forged line' });
    for (const line of h.text().split('\n')) {
      assert.ok(!/forged line/.test(line) || /^\[MODERATION\] (New report|report) #/.test(line),
        `a report id opened a new log line: ${JSON.stringify(line)}`);
    }
  } finally { h.restore(); }
});
