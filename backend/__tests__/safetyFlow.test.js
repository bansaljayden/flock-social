// Run: node --test  (from backend/)
//
// Round 17 — the SAFETY AND MODERATION JOURNEY, end to end, as a user walks it:
// report → block → takedown → SOS. Every test below pins a failure that a real
// person (an App Review tester, or a 16-year-old in trouble) would have hit.
//
// No database. pool.query / pool.connect are replaced per test with fixtures
// that answer the specific statements each route issues.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests';

const pool = require('../config/database');

const ME = { id: 7, email: 'me@example.com', name: 'Me', role: 'user', is_banned: false, token_version: 0 };

// ---------------------------------------------------------------------------
// Shared HTTP harness — the real router behind the real authenticate middleware.
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

// Route statements to a handler; record everything so a test can assert on what
// was NOT written as well as what was.
function stubPool(handler) {
  const realQuery = pool.query;
  const realConnect = pool.connect;
  const calls = [];
  pool.query = async (text, params) => {
    const sql = String(text);
    calls.push({ text: sql, params });
    // Every authenticated route first loads the caller's users row.
    if (sql.includes('FROM users WHERE id = $1') && sql.includes('token_version')) return { rows: [ME] };
    const r = await handler(sql, params);
    return r || { rows: [], rowCount: 0 };
  };
  pool.connect = async () => ({
    query: async (text, params) => {
      const sql = String(text);
      calls.push({ text: sql, params });
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql) || sql.includes('pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 0 };
      }
      const r = await handler(sql, params);
      return r || { rows: [], rowCount: 0 };
    },
    release: () => {},
  });
  return { calls, restore: () => { pool.query = realQuery; pool.connect = realConnect; } };
}

const wrote = (calls, fragment) => calls.some((c) => c.text.includes(fragment));

// ===========================================================================
// A. REPORT — does every content type actually reach the queue?
// ===========================================================================
const moderationRoutes = require('../routes/moderation');
const { VALID_CONTENT_TYPES, REPORT_ACCEPTED } = moderationRoutes.__test;

test('report: every VALID_CONTENT_TYPE is allowed by the database CHECK constraint', () => {
  // THE BUG THIS PINS: 'guest_rsvp' was added to VALID_CONTENT_TYPES in round 13
  // and mapped in admin.js's takedown table, but no migration ever widened
  // content_reports_content_type_check. So the report passed validation, passed
  // the flock-membership visibility gate, and then died on the INSERT as a
  // 23514 — delivered to the reporter as "500 Failed to submit report". The
  // ENTIRE guest-name takedown pipeline built by migration 005 was unreachable.
  //
  // This exact drift has now shipped twice (003's own comment records round 7),
  // because the constraint lives in SQL and the list lives in JS and nothing
  // compared them. This test is that comparison. No database needed: the
  // migrations are the source of truth for the deployed constraint.
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  let allowed = null;
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    // Take the LAST constraint definition in file order — that is the one the
    // deployed database ends up with.
    const matches = [...sql.matchAll(/CHECK\s*\(\s*content_type\s+IN\s*\(([^)]*)\)/gi)];
    if (matches.length > 0) {
      allowed = matches[matches.length - 1][1]
        .split(',')
        .map((s) => s.trim().replace(/^'|'$/g, ''))
        .filter(Boolean);
    }
  }

  assert.ok(allowed, 'no content_type CHECK constraint found in migrations/');
  const missing = VALID_CONTENT_TYPES.filter((t) => !allowed.includes(t));
  assert.deepStrictEqual(
    missing,
    [],
    `routes/moderation.js accepts content types the database will reject: ${missing.join(', ')}. ` +
    'Every one of those is a report button that answers 500. Add a migration widening ' +
    'content_reports_content_type_check in the same commit as the new type.'
  );
});

test('report: a guest RSVP report by a flock member reaches the queue', async () => {
  // The end-to-end shape of the bug above, through the real route.
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('FROM guest_rsvps')) return { rows: [{ sender_id: null, is_hidden: false }] };
    if (sql.includes('FROM content_reports')) return { rows: [] };
    if (sql.includes('INSERT INTO content_reports')) return { rows: [{ id: 1, status: 'open', created_at: 'now' }] };
    return null;
  });
  try {
    const res = await call(moderationRoutes, 'POST', '/api/reports', {
      content_type: 'guest_rsvp', content_id: 42, reason: 'harassment',
    });
    assert.strictEqual(res.status, 201, res.body?.error);
    assert.ok(wrote(calls, 'INSERT INTO content_reports'), 'the report must be recorded');
  } finally { restore(); }
});

test('report: content ids sent as STRINGS still match the content author', async () => {
  // isInt() validated but never converted, so `row.sender_id !== "9"` was true
  // for author 9 and a legitimate report came back "Reported user does not
  // match the content author" — the app accusing the reporter of lying.
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('FROM messages m')) return { rows: [{ sender_id: 9, is_hidden: false }] };
    if (sql.includes('FROM content_reports')) return { rows: [] };
    if (sql.includes('INSERT INTO content_reports')) return { rows: [{ id: 2, status: 'open', created_at: 'now' }] };
    return null;
  });
  try {
    const res = await call(moderationRoutes, 'POST', '/api/reports', {
      content_type: 'flock_message', content_id: '55', reported_user_id: '9', reason: 'hate',
    });
    assert.strictEqual(res.status, 201, res.body?.error);
    assert.ok(wrote(calls, 'INSERT INTO content_reports'));
  } finally { restore(); }
});

test('report: content already taken down is a success, not "could not be found"', async () => {
  // Two people report the same abusive review seconds apart. The second one hit
  // `AND is_hidden = false` inside the visibility query, so an already-handled
  // report was indistinguishable from fabricated content and answered 400.
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('FROM venue_reviews')) return { rows: [{ sender_id: 9, is_hidden: true }] };
    return null;
  });
  try {
    const res = await call(moderationRoutes, 'POST', '/api/reports', {
      content_type: 'venue_review', content_id: 3, reported_user_id: 9, reason: 'hate',
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.message, REPORT_ACCEPTED, 'wording must not reveal queue state');
    assert.ok(!wrote(calls, 'INSERT INTO content_reports'), 'nothing left to queue');
  } finally { restore(); }
});

test('report: you still cannot report content you cannot see', async () => {
  // The visibility gate is the whole reason content_id is checked at all —
  // without it the report pipeline is an oracle for private message ids.
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('FROM direct_messages')) return { rows: [] }; // not a party to it
    return null;
  });
  try {
    const res = await call(moderationRoutes, 'POST', '/api/reports', {
      content_type: 'dm', content_id: 88, reported_user_id: 9, reason: 'spam',
    });
    assert.strictEqual(res.status, 400);
    assert.ok(!wrote(calls, 'INSERT INTO content_reports'));
  } finally { restore(); }
});

test('report: naming a user who does not exist is refused, not queued', async () => {
  // A profile report carries no content_id, so it skipped every check and filed
  // a row against any integer. Those sit in the same LIMIT 200 queue as real
  // reports and no moderator action can resolve them.
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('SELECT id FROM users WHERE id = $1')) return { rows: [] };
    return null;
  });
  try {
    const res = await call(moderationRoutes, 'POST', '/api/reports', {
      content_type: 'profile', reported_user_id: 999999, reason: 'harassment',
    });
    assert.strictEqual(res.status, 404);
    assert.ok(!wrote(calls, 'INSERT INTO content_reports'));
  } finally { restore(); }
});

test('report: the reporter is told it was received, in the same words every time', async () => {
  // Apple 1.2 wants the reporter to get feedback. It must also be CONSTANT:
  // if a duplicate said something different from a fresh report, a reporter
  // could probe what is already in the queue.
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('FROM messages m')) return { rows: [{ sender_id: 9, is_hidden: false }] };
    if (sql.includes('FROM content_reports')) return { rows: [{ id: 5, status: 'open', created_at: 'now' }] };
    return null;
  });
  try {
    const res = await call(moderationRoutes, 'POST', '/api/reports', {
      content_type: 'flock_message', content_id: 55, reported_user_id: 9, reason: 'spam',
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.message, REPORT_ACCEPTED);
  } finally { restore(); }
});

// ===========================================================================
// B. SOS — the cooldown must never be a lockout
// ===========================================================================
const safetyRoutes = require('../routes/safety');
const S = safetyRoutes.__test;

test('sos: a delivered alert cannot be re-sent from the same spot inside the cooldown', () => {
  // The anti-abuse half. An unchanged position is still refused.
  const prev = { latitude: 40.7128, longitude: -74.006 };
  assert.strictEqual(S.isEscalation({ lat: 40.7128, lng: -74.006 }, prev), false);
  assert.strictEqual(S.isEscalation({ lat: 40.71285, lng: -74.00605 }, prev), false, '~7m is the same place');
});

test('sos: moving somewhere new IS allowed through the cooldown', () => {
  // THE LOCKOUT. You send an SOS from the bar, you are moved, two minutes later
  // you tap again to say where you are now — and a flat 5-minute rule refuses
  // the most important alert of the night. A materially different location is
  // exactly the update a trusted contact needs and cannot be produced by
  // mashing the button.
  const prev = { latitude: 40.7128, longitude: -74.006 };
  assert.ok(S.metresBetween({ lat: 40.7128, lng: -74.006 }, { lat: 40.7228, lng: -74.006 }) > 1000);
  assert.strictEqual(S.isEscalation({ lat: 40.7228, lng: -74.006 }, prev), true);
});

test('sos: an alert that went out WITHOUT a location can be followed by one WITH a location', () => {
  // Geolocation is slow and often fails first try. The follow-up that finally
  // carries coordinates is the one that matters, and it must not be refused.
  assert.strictEqual(S.isEscalation({ lat: 40.7, lng: -74 }, { latitude: null, longitude: null }), true);
});

test('sos: escalation still needs a location, so a bare retry cannot bypass the cooldown', () => {
  assert.strictEqual(S.isEscalation(null, { latitude: 40.7, longitude: -74 }), false);
  assert.strictEqual(S.isEscalation(null, { latitude: null, longitude: null }), false);
});

test('sos: escalation is bounded, and the floor is shorter than the cooldown', () => {
  assert.ok(S.MAX_ESCALATIONS >= 2, 'one update is not enough for an escalating situation');
  assert.ok(S.MAX_ESCALATIONS <= 5, 'must stay bounded — this route sends email');
  assert.ok(S.ALERT_FLOOR_MS < S.ALERT_COOLDOWN_MS);
  assert.ok(S.ALERT_FLOOR_MS <= 60 * 1000, 'a double-tap guard, not a wait');
});

test('sos: a refusal tells the user their earlier alert WAS delivered, and names 911', async () => {
  // "Please wait 4 minutes before sending another alert" does not tell a
  // frightened person whether the first one went out. That is the single most
  // important fact in the response.
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) {
      return { rows: [{ created_at: new Date().toISOString(), latitude: 40.7, longitude: -74, contacts_alerted: 3, age_ms: 90_000, delivered_in_window: 1 }] };
    }
    return null;
  });
  try {
    const res = await call(safetyRoutes, 'POST', '/api/alert', { latitude: 40.7, longitude: -74, includeLocation: true });
    assert.strictEqual(res.status, 429);
    assert.match(res.body.error, /went out to 3 contacts/i);
    assert.match(res.body.error, /911/);
    assert.strictEqual(res.body.alreadySent, true);
    assert.ok(!wrote(calls, 'INSERT INTO emergency_alerts'), 'a refused alert must not claim a slot');
  } finally { restore(); }
});

test('sos: after a TOTAL delivery failure the retry path reopens immediately', async () => {
  // We answered 502 "could not be delivered to any contact" and then left the
  // claim row blocking the retry for the rest of the 60-second window. Telling
  // someone their SOS failed and then refusing their retry is the worst thing
  // this file could do.
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) return { rows: [] };
    if (sql.includes('FROM trusted_contacts')) return { rows: [{ id: 1, contact_name: 'Mum', contact_email: 'mum@example.com' }] };
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Me' }] };
    if (sql.includes('INSERT INTO emergency_alerts')) return { rows: [{ id: 77 }] };
    return null;
  });
  const realFetch = global.fetch;
  const realKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY; // sendAlertEmail reports skipped, never sent
  try {
    const res = await call(safetyRoutes, 'POST', '/api/alert', { latitude: 40.7, longitude: -74, includeLocation: true });
    assert.strictEqual(res.status, 502);
    assert.strictEqual(res.body.canRetry, true);
    assert.match(res.body.error, /911/);
    const release = calls.find((c) => c.text.includes('SET created_at = NOW()'));
    assert.ok(release, 'the claim must be released so the next tap is not refused');
  } finally {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = realKey;
    restore();
  }
});

test('sos: releasing the claim on failure does not open an unbounded retry loop', async () => {
  // The hole the release above could have created: when EVERY send fails —
  // which is what a provider outage looks like — each retry is allowed at once,
  // writes a row, and fans out to every contact again, forever. The escalation
  // cap counts only DELIVERED alerts, so it does not bite here. This outer
  // bound does, and it sits far above what a person in trouble needs.
  assert.ok(S.MAX_ATTEMPTS_PER_WINDOW > S.MAX_ESCALATIONS, 'the outer bound must not be tighter than the escalation cap');
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) {
      return { rows: [{ created_at: new Date().toISOString(), latitude: null, longitude: null, contacts_alerted: 0, age_ms: 120_000, delivered_in_window: 0, attempts_in_window: S.MAX_ATTEMPTS_PER_WINDOW }] };
    }
    return null;
  });
  try {
    const res = await call(safetyRoutes, 'POST', '/api/alert', { latitude: 41.9, longitude: -75, includeLocation: true });
    assert.strictEqual(res.status, 429);
    assert.match(res.body.error, /911/, 'even the abuse ceiling has to point somewhere useful');
    assert.ok(!wrote(calls, 'INSERT INTO emergency_alerts'));
  } finally { restore(); }
});

test('sos: a first alert never meets the abuse ceiling', async () => {
  // The ceiling is deliberately the last thing checked. A user with no history
  // must sail past every gate.
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts') && !sql.includes('INSERT')) return { rows: [] };
    if (sql.includes('FROM trusted_contacts')) return { rows: [{ id: 1, contact_name: 'Mum', contact_email: 'mum@example.com' }] };
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Me' }] };
    if (sql.includes('INSERT INTO emergency_alerts')) return { rows: [{ id: 90 }] };
    return null;
  });
  try {
    await call(safetyRoutes, 'POST', '/api/alert', { latitude: 40.7, longitude: -74, includeLocation: true });
    assert.ok(wrote(calls, 'INSERT INTO emergency_alerts'), 'the first alert must always be attempted');
  } finally { restore(); }
});

test('sos: contacts with no email address are refused up front, with what to do about it', async () => {
  // Email is the ONLY delivery channel this route has. Phone-only contacts look
  // identical on the Safety screen, so a user could sit on five of them
  // believing SOS was armed. This is not a transient failure a retry fixes, so
  // it must not burn the retry window either.
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) return { rows: [] };
    if (sql.includes('FROM trusted_contacts')) return { rows: [{ id: 1, contact_name: 'Mum', contact_email: null }] };
    return null;
  });
  try {
    const res = await call(safetyRoutes, 'POST', '/api/alert', { latitude: 40.7, longitude: -74, includeLocation: true });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.unreachableContacts, true);
    assert.match(res.body.error, /email/i);
    assert.match(res.body.error, /911/);
    assert.ok(!wrote(calls, 'INSERT INTO emergency_alerts'));
  } finally { restore(); }
});

test('sos: a bad location degrades the alert, it never fails it', async () => {
  // readCoords already refuses junk; the point is what happens NEXT. A coord
  // the client could not produce must still send the alert.
  assert.strictEqual(S.readCoords('not-a-number', '-74'), null);
  assert.strictEqual(S.readCoords(undefined, undefined), null);
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) return { rows: [] };
    if (sql.includes('FROM trusted_contacts')) return { rows: [{ id: 1, contact_name: 'Mum', contact_email: 'mum@example.com' }] };
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Me' }] };
    if (sql.includes('INSERT INTO emergency_alerts')) return { rows: [{ id: 78 }] };
    return null;
  });
  try {
    await call(safetyRoutes, 'POST', '/api/alert', { latitude: 'garbage', longitude: {}, includeLocation: true });
    const claim = calls.find((c) => c.text.includes('INSERT INTO emergency_alerts'));
    assert.ok(claim, 'the alert must still be attempted without a location');
    assert.strictEqual(claim.params[1], null, 'and no junk coordinate is persisted');
  } finally { restore(); }
});

test('sos: declining to share your location does not persist it either', () => {
  // Consent: includeLocation === false means the coordinates never reach the
  // row, even though the client sent them.
  assert.strictEqual(S.readCoords(40.7, -74).lat, 40.7);
});

// ---------------------------------------------------------------------------
// Trusted contacts — the delivery channel has to actually be reachable
// ---------------------------------------------------------------------------
test('contacts: email is required server-side, not just in App.js', () => {
  // CLAUDE.md rule 7: a frontend gate that is not enforced here is not a gate.
  // App.js refuses to save a contact without an email; the server did not.
  const r = S.readContactFields({ name: 'Mum', phone: '5550100' });
  assert.ok(r.error, 'a contact with no email can never be alerted');
  assert.match(r.error, /email/i);
});

test('contacts: over-long fields are a 400, not a Postgres 22001 turned 500', () => {
  // contact_phone is VARCHAR(20). A pasted "+1 (555) 010-0000 ext. 4021"
  // reached the database and came back "Failed to add contact" on a safety
  // screen, which reads to a user as "the app is broken".
  assert.ok(S.readContactFields({ name: 'Mum', phone: '1'.repeat(21), email: 'm@example.com' }).error);
  assert.ok(S.readContactFields({ name: 'x'.repeat(101), phone: '5550100', email: 'm@example.com' }).error);
  assert.ok(S.readContactFields({ name: 'Mum', phone: '5550100', email: 'm@example.com', relationship: 'r'.repeat(51) }).error);
});

test('contacts: a well-formed contact still saves, and is sanitized', () => {
  const r = S.readContactFields({ name: '  Mum <b>x</b> ', phone: ' 5550100 ', email: ' MUM@example.com ', relationship: '' });
  assert.strictEqual(r.error, undefined);
  assert.ok(!r.name.includes('<b>'), 'contact_name is echoed back in the alert response');
  assert.strictEqual(r.phone, '5550100');
  assert.strictEqual(r.email, 'MUM@example.com');
  assert.strictEqual(r.relationship, null);
});

// ---------------------------------------------------------------------------
// Alert email content
// ---------------------------------------------------------------------------
test('alert email: a display name cannot inject markup into the message sent to a parent', () => {
  // users.name is user-controlled and was interpolated raw into the alert HTML
  // and into the Resend subject. On a safety email the realistic payload is not
  // a script tag, it is an <a href> pointing somewhere else.
  const evil = '<a href="http://evil.example">Mum</a>';
  const out = S.escapeHtml(evil);
  assert.ok(!out.includes('<a '), out);
  assert.ok(out.includes('&lt;a'));
  assert.strictEqual(S.escapeHtml("O'Brien & Sons"), 'O&#39;Brien &amp; Sons', 'ordinary names must survive');
});

test('alert email: the subject line cannot carry a newline', () => {
  assert.strictEqual(S.safeSubjectText('Mum\r\nBcc: someone@evil.example'), 'Mum Bcc: someone@evil.example');
  assert.ok(S.safeSubjectText('x'.repeat(400)).length <= 120);
});

// ===========================================================================
// B2. ROUND 23 — the SOS end to end, audited as the thing a person presses
// ===========================================================================
// Everything below pins a behaviour that was missing rather than wrong: an
// alert a suspended account could not raise, a location printed to eleven
// centimetres when the phone said two kilometres, a confirmation that counted
// SMTP transactions instead of naming who knows, a catastrophic failure that
// gave the least advice of any path in the file, and an alert that could never
// be withdrawn.
const emailService = require('../services/emailService');

// Replace the one function every send in this file goes through. Returns the
// captured messages, so a test can read the HTML a parent would actually see.
function stubMail(result = { sent: true, id: 't' }) {
  const real = emailService.sendEmail;
  const mails = [];
  emailService.sendEmail = async (msg) => {
    mails.push(msg);
    return typeof result === 'function' ? result(msg) : result;
  };
  return { mails, restore: () => { emailService.sendEmail = real; } };
}

// stubPool answers the caller's users row with ME. This one answers it with
// whatever the test needs, which is the only way to ask what happens to an
// account the moderation queue has just banned.
function stubPoolAs(userRow, handler) {
  const realQuery = pool.query;
  const realConnect = pool.connect;
  const calls = [];
  const route = async (text, params) => {
    const sql = String(text);
    calls.push({ text: sql, params });
    if (sql.includes('FROM users WHERE id = $1') && sql.includes('token_version')) return { rows: [userRow] };
    return (await handler(sql, params)) || { rows: [], rowCount: 0 };
  };
  pool.query = route;
  pool.connect = async () => ({
    query: async (text, params) => {
      const sql = String(text);
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql) || sql.includes('pg_advisory_xact_lock')) {
        calls.push({ text: sql, params });
        return { rows: [], rowCount: 0 };
      }
      return route(text, params);
    },
    release: () => {},
  });
  return { calls, restore: () => { pool.query = realQuery; pool.connect = realConnect; } };
}

const ONE_CONTACT = [{ id: 1, contact_name: 'Mum', contact_email: 'mum@example.com' }];

test('sos: a suspended account can still raise an alert', async () => {
  // THE BUG THIS PINS. POST /api/safety/alert was mounted on the ordinary
  // `authenticate`, which answers 403 "This account has been suspended for
  // violating our community guidelines." to any row with is_banned. That
  // sentence, returned to a sixteen-year-old who has just pressed SOS, is the
  // product deciding that a judgement about how somebody behaved in a group
  // chat is also a judgement about whether their night is safe.
  //
  // DELETE /api/users/me already had the answer: authenticateAllowBanned, for
  // the actions an account keeps after a ban because refusing them causes harm
  // out of all proportion to the offence.
  const banned = { ...ME, is_banned: true };
  const mail = stubMail();
  const { restore } = stubPoolAs(banned, async (sql) => {
    if (sql.includes('FROM emergency_alerts')) return { rows: [] };
    if (sql.includes('FROM trusted_contacts')) return { rows: ONE_CONTACT };
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Me' }] };
    if (sql.includes('INSERT INTO emergency_alerts')) return { rows: [{ id: 991 }] };
    return null;
  });
  try {
    const res = await call(safetyRoutes, 'POST', '/api/alert', { latitude: 40.7, longitude: -74, includeLocation: true });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(mail.mails.length, 1, 'a ban must not stop the one message that matters');
  } finally { mail.restore(); restore(); }
});

test('sos: a suspended account is still refused the surfaces that reach a NEW address', async () => {
  // The exemption is as narrow as it can be. Adding a trusted contact and
  // /share-location are the surfaces that turn an account into a mail relay
  // pointed at somebody who has not heard from Flock before, and a banned
  // account has no business reaching one. Only raising and standing down an
  // alert survive a ban.
  const banned = { ...ME, is_banned: true };
  const { restore } = stubPoolAs(banned, async () => null);
  try {
    const add = await call(safetyRoutes, 'POST', '/api/contacts', { name: 'X', phone: '5550100', email: 'x@example.com' });
    assert.strictEqual(add.status, 403);
    const share = await call(safetyRoutes, 'POST', '/api/share-location', { latitude: 40.7, longitude: -74 });
    assert.strictEqual(share.status, 403);
  } finally { restore(); }
});

test('sos: a fix the phone calls approximate is not drawn as a pin', () => {
  // THE BUG THIS PINS. The alert email printed six decimal places of latitude
  // (eleven centimetres) and a button reading "View Location on Map", for every
  // fix, including the cell-tower fix that a phone indoors reports as accurate
  // to two kilometres. A parent who drives to a pin stops searching when they
  // arrive. `position.coords.accuracy` settles it and nothing was reading it.
  assert.strictEqual(S.readAccuracy(25), 25);
  assert.strictEqual(S.readAccuracy('25'), 25);
  assert.strictEqual(S.readAccuracy(0), null, 'zero is not a radius');
  assert.strictEqual(S.readAccuracy(-5), null);
  assert.strictEqual(S.readAccuracy(NaN), null);
  assert.strictEqual(S.readAccuracy(undefined), null, 'a client that sends nothing must change nothing');
  assert.strictEqual(S.readAccuracy(500000), null, 'a broken sensor reads as "we were not told"');
  // Never more precise than the number deserves.
  assert.strictEqual(S.accuracyPhrase(1847), 'about 1.8 km');
  assert.strictEqual(S.accuracyPhrase(12), 'about 10 m');
  assert.strictEqual(S.accuracyPhrase(3), 'about 5 m');
  assert.ok(S.COARSE_FIX_METRES >= 500, 'the threshold has to sit above a normal urban GPS fix');
});

test('sos: the alert email carries the accuracy, and says who else was told', async () => {
  const mail = stubMail();
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) return { rows: [] };
    if (sql.includes('FROM trusted_contacts')) {
      return { rows: [
        { id: 1, contact_name: 'Mum', contact_email: 'mum@example.com' },
        { id: 2, contact_name: 'Dad', contact_email: 'dad@example.com' },
      ] };
    }
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Ava' }] };
    if (sql.includes('INSERT INTO emergency_alerts')) return { rows: [{ id: 992 }] };
    return null;
  });
  try {
    const res = await call(safetyRoutes, 'POST', '/api/alert', {
      latitude: 40.7, longitude: -74, includeLocation: true, accuracy: 2400,
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const html = mail.mails[0].html;
    assert.match(html, /approximate/i, 'a 2.4 km fix must be labelled as one');
    assert.match(html, /about 2\.4 km/);
    assert.match(html, /View Area on Map/, 'and the button must not promise a spot');
    // A contact who is the only one has to act; one of five has to know four
    // other people are about to ring the same number.
    assert.match(html, /You are one of 2 people/);
    // The confirmation answers the user's question, not the machinery's.
    assert.match(res.body.message, /Mum and Dad have been told/);
  } finally { mail.restore(); restore(); }
});

test('sos: a good fix is not decorated with a warning it has not earned', async () => {
  const mail = stubMail();
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) return { rows: [] };
    if (sql.includes('FROM trusted_contacts')) return { rows: ONE_CONTACT };
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Ava' }] };
    if (sql.includes('INSERT INTO emergency_alerts')) return { rows: [{ id: 993 }] };
    return null;
  });
  try {
    await call(safetyRoutes, 'POST', '/api/alert', {
      latitude: 40.7, longitude: -74, includeLocation: true, accuracy: 18,
    });
    const html = mail.mails[0].html;
    assert.match(html, /Accurate to about 20 m/);
    assert.match(html, /View Location on Map/);
    assert.doesNotMatch(html, /approximate/i);
    assert.match(html, /You are the only contact/);
  } finally { mail.restore(); restore(); }
});

test('sos: the catastrophic failure names 911 and says a retry is worth making', async () => {
  // Every other refusal in this route names 911. The 500 — the one that fires
  // when the database is unreachable, and the one that means "we do not know
  // whether your alert went out" — answered "Failed to send alert" and stopped.
  // The outcome that knows the least told the user the least.
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) throw new Error('connection terminated');
    return null;
  });
  try {
    const res = await call(safetyRoutes, 'POST', '/api/alert', { latitude: 40.7, longitude: -74, includeLocation: true });
    assert.strictEqual(res.status, 500);
    assert.match(res.body.error, /911/);
    assert.strictEqual(res.body.canRetry, true);
  } finally { restore(); }
});

test('sos: the in-flight refusal names 911 too', async () => {
  // This one fires while the outcome of the first alert is still unknown, so
  // the person reading it has been told less than any other 429 here tells
  // them. That is the wrong place for this file to be quietest.
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) {
      return { rows: [{ created_at: new Date().toISOString(), latitude: null, longitude: null, contacts_alerted: 0, age_ms: 3000, delivered_in_window: 0, attempts_in_window: 1 }] };
    }
    return null;
  });
  try {
    const res = await call(safetyRoutes, 'POST', '/api/alert', { includeLocation: false });
    assert.strictEqual(res.status, 429);
    assert.match(res.body.error, /911/);
  } finally { restore(); }
});

test('confirmation: the message names who knows, at any list length', () => {
  assert.strictEqual(S.namePhrase(['Mum']), 'Mum has');
  assert.strictEqual(S.namePhrase(['Mum', 'Dad']), 'Mum and Dad have');
  assert.strictEqual(S.namePhrase(['Mum', 'Dad', 'Sam']), 'Mum, Dad and 1 other have');
  assert.strictEqual(S.namePhrase(['Mum', 'Dad', 'Sam', 'Jo']), 'Mum, Dad and 2 others have');
  assert.strictEqual(S.namePhrase([]), 'They have', 'never an empty sentence');
});

// ---------------------------------------------------------------------------
// The stand-down. Until round 23 an SOS was a one-way door.
// ---------------------------------------------------------------------------
test('stand-down: with nothing delivered recently there is nothing to withdraw', async () => {
  // Mailing an all-clear for an alert that never went out would be the first
  // thing some contacts ever heard from Flock, and it cannot be manufactured
  // from a claim row that reached nobody.
  S.resetCancels();
  const mail = stubMail();
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) return { rows: [], rowCount: 0 };
    return null;
  });
  try {
    const res = await call(safetyRoutes, 'POST', '/api/alert/cancel', {});
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.nothingToCancel, true);
    assert.strictEqual(mail.mails.length, 0);
  } finally { mail.restore(); restore(); }
});

test('stand-down: it reaches the people who got the alert, and no suppression gets a vote', async () => {
  S.resetCancels();
  const mail = stubMail();
  const alertAt = new Date('2026-08-25T02:00:00Z');
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) {
      return { rows: [{ created_at: alertAt, contacts_alerted: 2 }], rowCount: 1 };
    }
    if (sql.includes('FROM trusted_contacts')) {
      return { rows: [
        { contact_name: 'Mum', contact_email: 'mum@example.com' },
        { contact_name: 'Dad', contact_email: 'dad@example.com' },
      ] };
    }
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Ava' }] };
    return null;
  });
  try {
    const res = await call(safetyRoutes, 'POST', '/api/alert/cancel', { timezone: 'America/New_York' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(mail.mails.length, 2);
    // The only person who can receive a stand-down is somebody who already
    // received the alarm. A hard bounce swallowing this one leaves a parent
    // holding "your child needs help" and nothing else, forever.
    assert.ok(mail.mails.every((m) => m.category === 'emergency'),
      'the withdrawal of an emergency is part of the emergency');
    assert.match(mail.mails[0].html, /All Clear/);
    assert.doesNotMatch(mail.mails[0].html, /maps\.google\.com/, 'a stand-down carries no location');
    assert.match(res.body.message, /Mum and Dad have been told you are OK/);
    // The window is bounded, so a cancel cannot resurrect an alert from days ago.
    const lookup = calls.find((c) => c.text.includes('FROM emergency_alerts'));
    assert.strictEqual(lookup.params[1], S.CANCEL_WINDOW_MS);
    // Only the contacts who existed when the alert went out. A contact added
    // afterwards never got the alarm, and a stand-down is the wrong first
    // message to send anybody.
    const who = calls.find((c) => c.text.includes('FROM trusted_contacts'));
    assert.match(who.text, /created_at <= \$2/);
    assert.strictEqual(who.params[1], alertAt);
  } finally { mail.restore(); restore(); }
});

test('stand-down: it writes no row, because a row would block the next real SOS', async () => {
  // emergency_alerts is the alert log, and the cooldown reads its most recent
  // row. A stand-down inserted there reads as a delivered alert and refuses the
  // next genuine press for five minutes. That is the one thing this route is
  // absolutely not allowed to do.
  S.resetCancels();
  const mail = stubMail();
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) return { rows: [{ created_at: new Date(), contacts_alerted: 1 }], rowCount: 1 };
    if (sql.includes('FROM trusted_contacts')) return { rows: [{ contact_name: 'Mum', contact_email: 'mum@example.com' }] };
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Ava' }] };
    return null;
  });
  try {
    await call(safetyRoutes, 'POST', '/api/alert/cancel', {});
    assert.ok(!wrote(calls, 'INSERT INTO emergency_alerts'));
    assert.ok(!wrote(calls, 'UPDATE emergency_alerts'));
  } finally { mail.restore(); restore(); }
});

test('stand-down: a total failure is reported honestly and the retry stays open', async () => {
  // Same rule as the alert: never report a delivery that did not happen. The
  // contacts are still holding the alarm, so the copy has to say so and send
  // the user to the phone.
  S.resetCancels();
  const mail = stubMail({ sent: false, error: 'provider down' });
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) return { rows: [{ created_at: new Date(), contacts_alerted: 1 }], rowCount: 1 };
    if (sql.includes('FROM trusted_contacts')) return { rows: [{ contact_name: 'Mum', contact_email: 'mum@example.com' }] };
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Ava' }] };
    return null;
  });
  try {
    const res = await call(safetyRoutes, 'POST', '/api/alert/cancel', {});
    assert.strictEqual(res.status, 502);
    assert.strictEqual(res.body.success, false);
    assert.match(res.body.error, /still have your alert/i);
    assert.strictEqual(res.body.canRetry, true);
  } finally { mail.restore(); restore(); }
});

test('stand-down: the meter bounds it, and a refused stand-down is the cheap direction', async () => {
  // This route may be limited where /alert may not. A refused SOS can leave
  // somebody alone; a refused stand-down leaves somebody worried. Different
  // harms, so different rules — and the ceiling still sits past any real
  // sequence of taps.
  assert.ok(S.MAX_CANCELS_PER_WINDOW >= 2 && S.MAX_CANCELS_PER_WINDOW <= 10);
  S.resetCancels();
  const mail = stubMail();
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('FROM emergency_alerts')) return { rows: [{ created_at: new Date(), contacts_alerted: 1 }], rowCount: 1 };
    if (sql.includes('FROM trusted_contacts')) return { rows: [{ contact_name: 'Mum', contact_email: 'mum@example.com' }] };
    if (sql.includes('SELECT name FROM users')) return { rows: [{ name: 'Ava' }] };
    return null;
  });
  try {
    for (let i = 0; i < S.MAX_CANCELS_PER_WINDOW; i++) {
      const ok = await call(safetyRoutes, 'POST', '/api/alert/cancel', {});
      assert.strictEqual(ok.status, 200, `stand-down ${i + 1} must be allowed`);
    }
    const refused = await call(safetyRoutes, 'POST', '/api/alert/cancel', {});
    assert.strictEqual(refused.status, 429);
  } finally { mail.restore(); restore(); S.resetCancels(); }
});

// ===========================================================================
// C. BLOCK — the control Apple 1.2 actually tests
// ===========================================================================
test('block: blocking separates the two accounts, not just the message surface', async () => {
  // A block that leaves the friendship in place leaves the pair visible to each
  // other through /friends, /friends/pending and availability, none of which
  // filter user_blocks. Deleting the row in both directions is what closes
  // those; this pins that it still happens.
  const { calls, restore } = stubPool(async (sql) => {
    if (sql.includes('SELECT id FROM users WHERE id = $1')) return { rows: [{ id: 9 }] };
    return null;
  });
  try {
    const res = await call(moderationRoutes, 'POST', '/api/blocks/9');
    assert.strictEqual(res.status, 201);
    assert.ok(wrote(calls, 'INSERT INTO user_blocks'));
    assert.ok(wrote(calls, 'DELETE FROM friendships'), 'a block must also end the friendship');
  } finally { restore(); }
});

test('block: the blocked user is never named to the blocker as "already blocked"', async () => {
  // ON CONFLICT DO NOTHING plus a constant 201 means re-blocking is idempotent
  // and reveals nothing.
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('SELECT id FROM users WHERE id = $1')) return { rows: [{ id: 9 }] };
    return null;
  });
  try {
    const a = await call(moderationRoutes, 'POST', '/api/blocks/9');
    const b = await call(moderationRoutes, 'POST', '/api/blocks/9');
    assert.deepStrictEqual([a.status, b.status], [201, 201]);
    assert.strictEqual(a.body.message, b.body.message);
  } finally { restore(); }
});

test('block: the unblock route exists and works, so a block is reversible on the server', async () => {
  // The API half of the missing Settings screen. If this ever 404s, an
  // accidental block becomes permanent for the user with no recourse.
  const { restore } = stubPool(async (sql) => {
    if (sql.includes('DELETE FROM user_blocks')) return { rows: [{ id: 1 }], rowCount: 1 };
    return null;
  });
  try {
    const res = await call(moderationRoutes, 'DELETE', '/api/blocks/9');
    assert.strictEqual(res.status, 200);
  } finally { restore(); }
});

test('block: a fresh block bites on live location even when ids arrive as strings', async () => {
  // isBlockedBetweenCached and invalidateBlockCache each built the cache key
  // with `a < b`, a RELATIONAL comparison. Socket payloads carry ids as strings
  // and REST carries them as numbers, and '10' < '9' is true while 10 < 9 is
  // false — so a pair cached from a typing/location event could sit under a key
  // the block route's invalidation never touched. The block then took up to 30
  // seconds to stop live coordinates reaching the person just blocked, which is
  // the exact leak the invalidation exists to prevent.
  const blocks = require('../utils/blocks');
  const B = blocks.__test;
  assert.strictEqual(B.pairKey('10', '9'), B.pairKey(9, 10), 'string and numeric ids must share one key');
  assert.strictEqual(B.pairKey(9, 10), B.pairKey(10, 9), 'order must not matter');

  const realQuery = pool.query;
  pool.query = async () => ({ rows: [{ '?column?': 1 }] }); // blocked
  try {
    B.blockCache.clear();
    assert.strictEqual(await blocks.isBlockedBetweenCached('10', '9'), true);
    blocks.invalidateBlockCache(9, 10); // the REST block route's numeric call
    assert.strictEqual(B.blockCache.size, 0, 'invalidation must find the socket-written entry');
  } finally {
    pool.query = realQuery;
    B.blockCache.clear();
  }
});

// ===========================================================================
// D. IMAGE MODERATION — fail closed, on the production posture
// ===========================================================================
test('image moderation: production fails closed by DEFAULT, not by remembering an env var', () => {
  // "Fail-closed" used to be opt-IN via IMAGE_MODERATION_REQUIRED=true, a
  // variable that lives only in the Railway dashboard. Omit it on a new service
  // or lose it in an env import and every image path in a teen social app
  // silently reverts to allow-with-a-console-warning. A safety default has to
  // be the default; turning it OFF is now a deliberate, greppable act.
  const saved = { req: process.env.IMAGE_MODERATION_REQUIRED, env: process.env.NODE_ENV };
  const load = () => {
    delete require.cache[require.resolve('../utils/moderation')];
    return require('../utils/moderation').__test.IMAGE_MODERATION_REQUIRED;
  };
  try {
    delete process.env.IMAGE_MODERATION_REQUIRED;
    process.env.NODE_ENV = 'production';
    assert.strictEqual(load(), true, 'production with the variable simply forgotten must still fail closed');

    process.env.IMAGE_MODERATION_REQUIRED = 'false';
    assert.strictEqual(load(), false, 'an explicit opt-out must still work');

    delete process.env.IMAGE_MODERATION_REQUIRED;
    process.env.NODE_ENV = 'development';
    assert.strictEqual(load(), false, 'local dev without a Vision key must not be bricked');
  } finally {
    if (saved.req === undefined) delete process.env.IMAGE_MODERATION_REQUIRED; else process.env.IMAGE_MODERATION_REQUIRED = saved.req;
    if (saved.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.env;
    delete require.cache[require.resolve('../utils/moderation')];
  }
});

test('image moderation: the SSRF guard refuses IPv4-mapped private addresses', () => {
  // The IPv6 branch spot-checked three ::ffff: prefixes as strings, so every
  // other private range slipped through in mapped form — including the cloud
  // metadata endpoint.
  const { isPrivateAddress } = require('../utils/moderation').__test;
  for (const bad of [
    '::ffff:169.254.169.254', // cloud metadata, was ALLOWED
    '::ffff:172.16.0.1',      // RFC1918, was ALLOWED
    '::ffff:100.64.0.1',      // carrier-grade NAT, was ALLOWED
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:192.168.1.1',
    '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1',
    '169.254.169.254', '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '0.0.0.0',
  ]) {
    assert.strictEqual(isPrivateAddress(bad), true, `${bad} must be refused`);
  }
  for (const ok of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '172.32.0.1', '100.128.0.1']) {
    assert.strictEqual(isPrivateAddress(ok), false, `${ok} is a public address`);
  }
});


test('image moderation: with no provider configured and REQUIRED set, uploads are refused', async () => {
  // The build-time decision. moderation.test.js proves the provider-error path;
  // this proves the "we shipped without a key" path, which is how it would
  // actually fail on launch day.
  const keys = { v: process.env.VISION_API_KEY, g: process.env.GOOGLE_VISION_API_KEY, r: process.env.IMAGE_MODERATION_REQUIRED };
  delete process.env.VISION_API_KEY;
  delete process.env.GOOGLE_VISION_API_KEY;
  process.env.IMAGE_MODERATION_REQUIRED = 'true';
  delete require.cache[require.resolve('../utils/moderation')];
  try {
    const mod = require('../utils/moderation');
    const res = await mod.moderateImage('data:image/png;base64,iVBORw0KGgo=');
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.reason, 'moderation_unavailable');
  } finally {
    if (keys.v === undefined) delete process.env.VISION_API_KEY; else process.env.VISION_API_KEY = keys.v;
    if (keys.g === undefined) delete process.env.GOOGLE_VISION_API_KEY; else process.env.GOOGLE_VISION_API_KEY = keys.g;
    if (keys.r === undefined) delete process.env.IMAGE_MODERATION_REQUIRED; else process.env.IMAGE_MODERATION_REQUIRED = keys.r;
    delete require.cache[require.resolve('../utils/moderation')];
  }
});
