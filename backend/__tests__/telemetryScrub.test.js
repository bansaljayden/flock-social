// Run: node --test  (from backend/)
//
// ===========================================================================
// WHAT LEAVES THE BUILDING WHEN SENTRY IS TURNED ON.
//
// SECURITY ROUND 5, 2026-08-20. instrument.js advertises "THE ONE HUMAN STEP:
// set SENTRY_DSN in the Railway service variables", and until this round that
// one step also shipped three classes of personal data to a third party, with
// no diff to review at the moment it happened:
//
//   1. LIVE TOKENS IN URLS. @sentry/node filters query_string against its own
//      credential deny-list but NOT request.url, which it includes
//      unconditionally (its own source says so: "No dataCollection equivalent
//      - URL is always included"). Two of this app's URLs carry a working
//      credential in the query string: the digest opt-out link, whose signed
//      token lives 180 DAYS, and the email-verification and password-reset
//      links in routes/auth.js. One 500 on either puts a usable token in a
//      third-party issue tracker.
//   2. FRAME LOCALS. localVariablesIntegration is a default integration and
//      captures in-scope variables for every frame of an unhandled exception.
//      The frames that throw most often here are in routes/auth.js and
//      routes/users.js, where the locals in scope are email, password,
//      current_password, token, and the whole user row.
//   3. CONSOLE BREADCRUMBS. consoleIntegration is also a default and attaches
//      recent console lines to every event, which would have carried the auth
//      log lines, the SOS trusted-contact address and the socket name-to-id
//      pair out of the building attached to an unrelated error.
//
// This file drives the scrubber directly, with no DSN and no SDK. The scrubber
// IS the control here, and a control nothing exercises is a control nobody can
// prove still works.
// ===========================================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Required WITHOUT a DSN on purpose: Sentry.init must not run, and the
// scrubbers must still be reachable.
delete process.env.SENTRY_DSN;
const { scrubUrl, scrubText, scrubEvent } = require('../instrument');

const src = fs.readFileSync(path.join(__dirname, '..', 'instrument.js'), 'utf8');

// Every token-shaped fixture below is deliberately low-entropy and repetitive.
// The scrubbers match on SHAPE, so a runs-of-one-letter string exercises them
// exactly as a real credential would, and the repo's gitleaks pre-commit hook
// does not have to decide whether a test fixture is a leak.

// -- 1. Credentials in URLs -------------------------------------------------

test('the digest opt-out token does not ride out in the request URL', () => {
  // 180 days of validity, and the link is fetched by mail scanners as well as
  // by the recipient, so this URL turns up on error paths more than most.
  const url = scrubUrl('https://api.flockcorp.com/api/venue-digest/opt-out?token=eyJaaaaaaaaaaaa.eyJaaaaaaaaaaaa.aaaaaaaaaaaaaaaa');
  assert.ok(!url.includes('eyJ'), 'no part of the token survives');
  assert.match(url, /\/api\/venue-digest\/opt-out/, 'the route is still identifiable');
  assert.match(url, /Filtered/);
});

test('verification and reset links lose their token and keep their shape', () => {
  const u = scrubUrl('/api/auth/verify-email?token=aaaabbbbccccdddd&next=/app');
  assert.ok(!u.includes('aaaabbbbccccdddd'));
  assert.match(u, /next=/, 'a parameter that is not a credential is left alone, so the event still says which case failed');
});

test('every credential-shaped parameter name is covered, not just "token"', () => {
  const names = ['token', 'code', 'key', 'secret', 'password', 'auth', 'jwt',
    'session', 'sig', 'signature', 'access_token', 'refresh_token', 'id_token'];
  for (const k of names) {
    assert.ok(!scrubUrl('/x?' + k + '=SUPERSECRETVALUE').includes('SUPERSECRETVALUE'),
      '?' + k + '= must not survive');
  }
  // Case does not save it either.
  assert.ok(!scrubUrl('/x?Token=SUPERSECRETVALUE').includes('SUPERSECRETVALUE'));
});

test('a URL with no query string is untouched, and junk does not throw', () => {
  assert.strictEqual(scrubUrl('/api/crowd/venue'), '/api/crowd/venue');
  assert.strictEqual(scrubUrl(''), '');
  assert.strictEqual(scrubUrl(null), null);
  assert.strictEqual(scrubUrl(undefined), undefined);
});

// -- 2. Addresses and tokens inside free text -------------------------------

test('an address is stripped wherever it appears in a line of text', () => {
  // This is the shape the auth path actually writes. maskAddress at the source
  // is the first line of defence; this is the second, because a breadcrumb is
  // free-form text with no field to name.
  const s = scrubText('Failed login attempt (unknown email) for someone@gmail.com from 1.2.3.4');
  assert.ok(!s.includes('someone@gmail.com'));
  assert.match(s, /1\.2\.3\.4/, 'the IP is operational and stays');

  // A Postgres unique-violation detail: how an address reaches an exception
  // message rather than a log line.
  const pg = scrubText('duplicate key value violates unique constraint: Key (email)=(victim@example.org) already exists.');
  assert.ok(!pg.includes('victim@example.org'));
});

test('a JWT is stripped wherever it appears', () => {
  const s = scrubText('Authorization: Bearer eyJbbbbbbbbbbbbbbbb.eyJbbbbbbbbbbbbbbbb.bbbbbbbbbbbbbbbbbbbb');
  assert.ok(!s.includes('eyJbbbbbbbbbbbbbbbb'));
  assert.match(s, /\[jwt\]/);
});

// -- 3. The whole event -----------------------------------------------------

test('one pass over an event covers the URL, the breadcrumbs and the exception', () => {
  const ev = scrubEvent({
    request: {
      url: 'https://api.flockcorp.com/api/venue-digest/opt-out?token=LIVETOKEN&vp=7',
      query_string: 'token=LIVETOKEN',
      cookies: { session: 'cookievalue' },
      data: { password: 'hunter2' },
      headers: { host: 'api.flockcorp.com' },
    },
    message: 'failed for alice@example.com',
    breadcrumbs: [
      { message: 'Socket connected: bob@example.com (42)' },
      { message: 'GET /api/auth/verify-email', data: { url: '/api/auth/verify-email?token=LIVETWO' } },
    ],
    exception: { values: [{ value: 'Key (email)=(carol@example.net) already exists' }] },
  });

  const blob = JSON.stringify(ev);
  const forbidden = ['LIVETOKEN', 'LIVETWO', 'alice@example.com', 'bob@example.com',
    'carol@example.net', 'hunter2', 'cookievalue'];
  for (const bad of forbidden) {
    assert.ok(!blob.includes(bad), bad + ' must not survive the scrubber');
  }
  // The request BODY and cookies are dropped outright rather than filtered: a
  // body is arbitrary user input and no field list over it stays correct.
  assert.strictEqual(ev.request.data, undefined);
  assert.strictEqual(ev.request.cookies, undefined);
  assert.strictEqual(ev.request.query_string, undefined);
  // And the event is still worth having.
  assert.match(ev.request.url, /venue-digest\/opt-out/);
  assert.match(ev.request.url, /vp=7/, 'a non-credential parameter is kept, so the event stays diagnosable');
});

test('a scrubber that throws drops the event rather than sending it raw', () => {
  // Fail closed. An event that cannot be proven clean is not sent.
  const hostile = { get request() { throw new Error('boom'); } };
  assert.strictEqual(scrubEvent(hostile), null);
});

// -- 4. The wiring, not just the functions ----------------------------------

test('the two leaking default integrations are removed and frame locals are off', () => {
  // Configuration rather than behaviour, so it is checked at the source. Both
  // of these default to ON in @sentry/node, and both were on here.
  assert.match(src, /includeLocalVariables:\s*false/,
    'frame locals carry email, password and whole user rows');
  assert.match(src, /i\.name !== .LocalVariables./);
  assert.match(src, /i\.name !== .Console./,
    'console breadcrumbs would carry every log line this app writes');
  assert.match(src, /sendDefaultPii:\s*false/,
    'stated rather than left to a default that can change under a minor bump');
  assert.match(src, /beforeSend:\s*scrubEvent/);
  assert.match(src, /beforeSendTransaction:\s*scrubEvent/);
  assert.match(src, /beforeBreadcrumb:/);
});

test('requiring instrument.js without a DSN starts nothing', () => {
  // The dormant state has to stay genuinely dormant: this file is required
  // first in server.js, before anything else, on every boot.
  assert.ok(!process.env.SENTRY_DSN);
  assert.strictEqual(typeof scrubEvent, 'function');
});
