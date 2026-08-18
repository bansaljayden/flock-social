// Run: node --test  (from backend/)
//
// ===========================================================================
// EVERY FIELD HAS A MAXIMUM OF ITS OWN
// ===========================================================================
//
// The JSON body limit in server.js was audited down from 1MB to 64KB. That was
// a security fix, and it also silently made several fields sixteen times
// smaller, because those fields had no maximum of their own: the parser's limit
// WAS their limit. A bound that lives in another file moves whenever somebody
// tunes an unrelated number there, and it cannot be reasoned about from the
// route that accepts the value.
//
// This file covers the three routers that were audited for that:
// routes/users.js, routes/venueProfile.js and routes/revenuecat.js.
//
// HOW IT ASSERTS, AND WHY IT IS BUILT THIS WAY
//
// Every ceiling is READ OUT OF THE ROUTE, never retyped here. Each field is then
// driven over real HTTP at exactly its declared maximum (which must be accepted)
// and at one past it (which must be a 400, before any query runs). So the test
// does not encode "255"; it encodes "whatever routes/users.js says MAX_NAME is,
// that is the largest name the route accepts and one more is refused". Raise a
// constant and this file follows it. DELETE a constant, or stop enforcing one,
// and this file fails. That is the same trick __tests__/bodyLimitAudit.test.js
// plays on server.js, pointed at the routes instead of the parser.
//
// Two nets sit on top of the per-field cases:
//
//   * THE FIELD CENSUS. Every body()/query() field these three routers declare
//     is extracted from their source and must appear in the probe table below.
//     A field added to one of these routes without a bound cannot pass through
//     unnoticed, because the census fails before anybody gets to the bound.
//   * THE 8000-CHARACTER PROBE. bodyLimitAudit.test.js already fails any route
//     that declares an isLength max above 8000 (its own CEILING, read out of
//     that file rather than copied). So a field that ACCEPTS an 8000-character
//     value has no declared maximum at all, and the body limit is doing the
//     work. Every scalar field on these routes is probed with one.
//
// No database: pool.query / pool.connect are fixtures, and every statement is
// logged so "refused before any query" is a fact rather than a hope.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = 'field-bounds-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.RESEND_API_KEY;
delete process.env.PAYWALL_ENABLED;

const BACKEND = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(BACKEND, rel), 'utf8');

// ---------------------------------------------------------------------------
// 1. The ceilings, read out of the routes that own them
// ---------------------------------------------------------------------------
function num(rel, re, what) {
  const m = re.exec(read(rel));
  assert.ok(m, `${rel} must still declare ${what} — the field-bounds audit reads it`);
  return Number(m[1]);
}
const constIn = (rel, name) => num(rel, new RegExp(`const ${name} = (\\d+);`), name);

const U = {
  NAME: constIn('routes/users.js', 'MAX_NAME'),
  EMAIL: constIn('routes/users.js', 'MAX_EMAIL'),
  PHONE: constIn('routes/users.js', 'MAX_PHONE'),
  SEARCH: constIn('routes/users.js', 'MAX_SEARCH_QUERY'),
  AVATAR_URL: constIn('routes/users.js', 'MAX_AVATAR_URL'),
  PASSWORD: constIn('routes/users.js', 'MAX_PASSWORD'),
  INTERESTS: constIn('routes/users.js', 'MAX_INTERESTS'),
  INTEREST_LEN: constIn('routes/users.js', 'MAX_INTEREST_LEN'),
  BIO: constIn('routes/users.js', 'MAX_BIO'),
  // Declared inline rather than as a constant; read the literal so a change to
  // it is still a change this file sees.
  ZELLE: num('routes/users.js',
    /body\('zelle_identifier'\)[\s\S]{0,240}?isLength\(\{ max: (\d+) \}\)/, 'the Zelle identifier width'),
  SETTINGS_PAYLOAD: num('routes/users.js', /JSON\.stringify\(partial\)\.length > (\d+)/, 'the settings payload cap'),
  SETTINGS_STORED: num('routes/users.js', /serialized\.length > (\d+)/, 'the merged settings cap'),
};

const V = {
  BUSINESS_NAME: constIn('routes/venueProfile.js', 'MAX_BUSINESS_NAME'),
  CATEGORY: constIn('routes/venueProfile.js', 'MAX_CATEGORY'),
  LOCATION: constIn('routes/venueProfile.js', 'MAX_LOCATION'),
  DESCRIPTION: constIn('routes/venueProfile.js', 'MAX_DESCRIPTION'),
  PLACE_ID: constIn('routes/venueProfile.js', 'MAX_PLACE_ID'),
  PHOTO_URL: constIn('routes/venueProfile.js', 'MAX_PHOTO_URL'),
  GOALS: constIn('routes/venueProfile.js', 'MAX_GOALS'),
  GOAL_LEN: constIn('routes/venueProfile.js', 'MAX_GOAL_LEN'),
  HOURS_ROWS: constIn('routes/venueProfile.js', 'MAX_HOURS_ROWS'),
  HOURS_FIELD: constIn('routes/venueProfile.js', 'MAX_HOURS_FIELD'),
  PREF_KEYS: constIn('routes/venueProfile.js', 'MAX_PREF_KEYS'),
  PHONE: num('routes/venueProfile.js',
    /body\('phone'\)[\s\S]{0,160}?isLength\(\{ max: (\d+) \}\)/, 'the venue phone width'),
};

const R = {
  TRANSFER_IDS: constIn('routes/revenuecat.js', 'MAX_TRANSFER_IDS'),
  INT4: constIn('routes/revenuecat.js', 'MAX_INT4'),
};

// server.js's default parser ceiling, read the same way, so the "does the
// largest honest body still fit" arithmetic below cannot drift from it.
const DEFAULT_JSON_BODY_BYTES = (() => {
  const m = /const DEFAULT_JSON_BODY_BYTES = ([^;]+);/.exec(read('server.js'));
  assert.ok(m, 'server.js must still declare DEFAULT_JSON_BODY_BYTES');
  // eslint-disable-next-line no-eval
  const v = eval(m[1]); // an arithmetic literal from our own source
  assert.equal(typeof v, 'number');
  return v;
})();

// ---------------------------------------------------------------------------
// 2. The column widths those ceilings claim to come from
// ---------------------------------------------------------------------------
// The comment in routes/users.js says MAX_NAME is users.name's width. A comment
// cannot say that truthfully for long; this reads the migration.
function usersColumnWidth(column) {
  const src = read('migrations/000_bootstrap.sql');
  const table = /CREATE TABLE IF NOT EXISTS users \(([\s\S]*?)\n\);/.exec(src);
  assert.ok(table, 'migrations/000_bootstrap.sql must still create the users table');
  const m = new RegExp(`\\n\\s*${column} VARCHAR\\((\\d+)\\)`).exec(table[1]);
  assert.ok(m, `users.${column} must still be a VARCHAR in migrations/000_bootstrap.sql`);
  return Number(m[1]);
}

test('the user ceilings are the column widths they say they are', () => {
  assert.equal(U.NAME, usersColumnWidth('name'), 'MAX_NAME must be users.name\'s width');
  assert.equal(U.EMAIL, usersColumnWidth('email'), 'MAX_EMAIL must be users.email\'s width');
  assert.equal(U.PHONE, usersColumnWidth('phone'), 'MAX_PHONE must be users.phone\'s width');
  // The search term is matched with `%term%` against users.name, so anything
  // wider than that column cannot match a row however long it is.
  assert.equal(U.SEARCH, usersColumnWidth('name'),
    'MAX_SEARCH_QUERY is users.name\'s width: a wider term cannot match anything');
});

test('the venue ceilings are the column widths they say they are', () => {
  const src = read('migrations/001_baseline.sql');
  const table = /CREATE TABLE IF NOT EXISTS venue_profiles \(([\s\S]*?)\n\s*\);/.exec(src);
  assert.ok(table, 'migrations/001_baseline.sql must still create venue_profiles');
  const width = (col) => {
    const m = new RegExp(`\\n\\s*${col} VARCHAR\\((\\d+)\\)`).exec(table[1]);
    assert.ok(m, `venue_profiles.${col} must still be a VARCHAR`);
    return Number(m[1]);
  };
  assert.equal(V.BUSINESS_NAME, width('business_name'));
  assert.equal(V.CATEGORY, width('category'));
  assert.equal(V.LOCATION, width('location'));
  assert.equal(V.PLACE_ID, width('google_place_id'));
  const phone = /venue_profiles ADD COLUMN IF NOT EXISTS phone VARCHAR\((\d+)\)/.exec(src);
  assert.ok(phone, 'venue_profiles.phone must still be a VARCHAR');
  assert.equal(V.PHONE, Number(phone[1]));
});

test('the RevenueCat id ceiling is int4, because users.id is SERIAL', () => {
  assert.equal(R.INT4, 2147483647, 'users.id is SERIAL; anything past int4 is a Postgres 22003');
  assert.match(read('migrations/000_bootstrap.sql'), /CREATE TABLE IF NOT EXISTS users \(\s*\n\s*id SERIAL PRIMARY KEY/,
    'users.id must still be SERIAL, or the int4 ceiling above is the wrong ceiling');
});

// ---------------------------------------------------------------------------
// 3. Fixtures: a pool that answers, and an authenticate that does not query
// ---------------------------------------------------------------------------
const pool = require('../config/database');

let handlers = [];
let log = [];

function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params: params || [] });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = fn(params || [], flat);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}
pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) { log.push({ sql: String(sql).trim(), params: [] }); return Promise.resolve({ rows: [] }); }
    return dispatch(sql, params);
  },
  release: () => {},
});

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user', email: 'ava@example.com', email_verified: true };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };
authMod.authenticateAllowBanned = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const usersRouter = require('../routes/users');
const venueProfileRouter = require('../routes/venueProfile');
const revenuecatRouter = require('../routes/revenuecat');

const app = express();
// The SAME ceiling production serves these routes with, read out of server.js.
// A probe that 413s instead of 400ing would be measuring the parser rather than
// the route, and this keeps that distinction honest.
app.use(express.json({ limit: DEFAULT_JSON_BODY_BYTES }));
app.set('io', null);
app.use('/api/users', usersRouter);
app.use('/api/venue-profile', venueProfileRouter);
app.use('/api/revenuecat', revenuecatRouter);

let base;
let server;
test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

async function call(method, pathname, body) {
  handlers = DEFAULT_HANDLERS();
  log = [];
  const res = await fetch(base + pathname, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, bytes: body === undefined ? 0 : Buffer.byteLength(JSON.stringify(body)) };
}

// The account the profile routes read. A PASSWORD account, so the email-change
// branch takes the "possession already proved" path rather than demanding a
// freshly minted OAuth token.
const PASSWORD = 'Correct1Horse';
let PASSWORD_HASH;
test.before(async () => { PASSWORD_HASH = await bcrypt.hash(PASSWORD, 10); });

const accountRow = () => ({
  id: 1, email: 'ava@example.com', name: 'Ava', phone: null, interests: [],
  password: PASSWORD_HASH, oauth_provider: null, oauth_id: null,
  apple_refresh_token: null, is_banned: false, banned_at: null,
  email_verified: true, verified_email: 'ava@example.com', role: 'user',
  profile_image_url: null, token_version: 0,
});

function DEFAULT_HANDLERS() {
  return [
    [/^SELECT \* FROM users WHERE id = \$1$/i, () => ({ rows: [accountRow()] })],
    // DELETE /api/users/me reads a projection rather than *.
    [/^SELECT id, email, phone, password/i, () => ({ rows: [accountRow()] })],
    [/^UPDATE users SET/i, () => ({ rows: [accountRow()] })],
    [/FROM banned_identities/i, () => ({ rows: [] })],
    [/^SELECT id FROM users WHERE/i, () => ({ rows: [] })],
    [/FROM user_settings/i, () => ({ rows: [] })],
    [/INSERT INTO user_settings/i, () => ({ rows: [{ settings: {} }] })],
    [/^SELECT id, name, profile_image_url/i, () => ({ rows: [] })],
    [/FROM venue_profiles WHERE google_place_id/i, () => ({ rows: [] })],
    [/^UPDATE venue_profiles SET/i, () => ({ rows: [{ id: 3, business_name: 'Bar' }] })],
    [/^INSERT INTO venue_profiles/i, () => ({ rows: [{ id: 3 }] })],
    [/^UPDATE users SET role/i, () => ({ rows: [] })],
  ];
}

// Attempt limiters in routes/users.js are per-process and per-account, and this
// file drives the same account dozens of times. Clear them between cases or the
// tenth email probe is a 429 that says nothing about a bound.
const T = usersRouter.__testing;
function clearLimiters() {
  T.proofFailures.clearAll();
  T.phoneChangeAttempts.clearAll();
  T.emailChangeAttempts.clearAll();
}

const wrote = (re) => log.filter((q) => re.test(q.sql));
const noWrites = () => log.filter((q) => /^(INSERT|UPDATE|DELETE)/i.test(q.sql));

// ---------------------------------------------------------------------------
// 4. THE CENSUS: no field on these routes escapes this file
// ---------------------------------------------------------------------------
// Extracted from the source, so adding `body('newThing')` to any of the three
// routers fails here until it is probed below. This is the part that makes the
// rest of the file a policy rather than a snapshot.
const PROBED_FIELDS = {
  'routes/users.js': new Set([
    'name', 'email', 'phone', 'interests', 'bio', 'current_password', 'new_password',
    'url', 'venmo_username', 'cashapp_cashtag', 'zelle_identifier', 'q',
  ]),
  'routes/venueProfile.js': new Set([
    'businessName', 'category', 'location', 'description', 'goals',
    'operatingHours', 'notificationPrefs', 'googlePlaceId', 'photoUrl', 'phone',
  ]),
  'routes/revenuecat.js': new Set([]),
};

test('every field these routers declare is one this file bounds', () => {
  for (const [rel, probed] of Object.entries(PROBED_FIELDS)) {
    const src = read(rel);
    // The negative lookbehind is not decoration: without it `pool.query('DELETE
    // FROM …')` reads as a field called "DELETE FROM …" and the census fails on
    // a SQL statement. express-validator's body()/query() are bare calls; every
    // pool/client query is a method call on something.
    const declared = new Set(
      [...src.matchAll(/(?<![.\w])(?:body|query)\('([A-Za-z_][A-Za-z0-9_]*)'\)/g)].map((m) => m[1])
    );
    for (const field of declared) {
      assert.ok(probed.has(field),
        `${rel} accepts "${field}" and __tests__/fieldBounds.test.js does not bound it. `
        + 'Give it a maximum of its own, then probe it here.');
    }
    // And the other way: a probe for a field the route no longer takes is a
    // test that passes for the wrong reason.
    for (const field of probed) {
      assert.ok(declared.has(field),
        `${rel} no longer declares "${field}"; remove its probe or restore the field`);
    }
  }
});

// The handwritten reads that never go through a validator chain, so the census
// above cannot see them. Listed here so they are still accounted for.
test('the body fields read by hand are bounded too', () => {
  const src = read('routes/users.js');
  // DELETE /api/users/me reads req.body.password directly.
  assert.match(src, /req\.body\.password\.length > MAX_PASSWORD/,
    'DELETE /api/users/me reads req.body.password by hand and must bound it');
  // PATCH /api/users/settings takes the whole body as an opaque blob.
  assert.ok(U.SETTINGS_PAYLOAD > 0 && U.SETTINGS_STORED > 0,
    'PATCH /api/users/settings must cap both the submitted payload and the merged result');
});

// ---------------------------------------------------------------------------
// 5. THE 8000-CHARACTER PROBE
// ---------------------------------------------------------------------------
// bodyLimitAudit.test.js fails any route file declaring an isLength max above
// its CEILING. So a field that accepts a value that long has no declared
// maximum, and the parser is its only bound. The number is read from that file
// rather than copied, so the two audits cannot disagree about what "large" is.
const UNBOUNDED_PROBE = (() => {
  const src = read('__tests__/bodyLimitAudit.test.js');
  const at = src.indexOf('no route has grown a free-text field');
  assert.ok(at > 0, 'bodyLimitAudit.test.js must still cap the widest declared field');
  const m = /const CEILING = (\d+);/.exec(src.slice(at));
  assert.ok(m, 'bodyLimitAudit.test.js must still declare its free-text CEILING');
  return Number(m[1]);
})();

test('the probe is larger than every ceiling these routes declare', () => {
  // Otherwise the probe below proves nothing: it has to be past every legitimate
  // maximum for "accepted" to mean "unbounded".
  for (const [label, v] of [
    ...Object.entries(U).map(([k, n]) => [`users.${k}`, n]),
    ...Object.entries(V).map(([k, n]) => [`venueProfile.${k}`, n]),
  ]) {
    if (label === 'users.PASSWORD' || label === 'users.SETTINGS_PAYLOAD' || label === 'users.SETTINGS_STORED') continue;
    assert.ok(v < UNBOUNDED_PROBE, `${label} is ${v}, at or past the ${UNBOUNDED_PROBE}-character probe`);
  }
  // The password ceiling is deliberately generous (bcrypt reads 72 bytes; the
  // bound exists so the number is chosen here rather than in server.js), so it
  // gets its own probe rather than the shared one.
  assert.ok(U.PASSWORD < DEFAULT_JSON_BODY_BYTES, 'even the generous ceiling must be the route\'s, not the parser\'s');
});

const OVERSIZED = 'x'.repeat(UNBOUNDED_PROBE);

test('no scalar field on these routes accepts an 8000-character value', async () => {
  const cases = [
    ['PUT', '/api/users/profile', { name: OVERSIZED }],
    ['PUT', '/api/users/profile', { email: `${OVERSIZED}@example.com` }],
    ['PUT', '/api/users/profile', { phone: OVERSIZED }],
    ['PUT', '/api/users/profile', { interests: [OVERSIZED] }],
    ['PUT', '/api/users/profile', { new_password: `A1${OVERSIZED}` }],
    ['PUT', '/api/users/profile', { current_password: OVERSIZED }],
    ['GET', `/api/users/search?q=${OVERSIZED}`, undefined],
    ['PUT', '/api/users/profile-image', { url: `https://api.dicebear.com/7.x/bottts/svg?seed=${OVERSIZED}` }],
    ['PUT', '/api/users/venmo-username', { venmo_username: OVERSIZED }],
    ['PUT', '/api/users/payment-methods', { venmo_username: OVERSIZED }],
    ['PUT', '/api/users/payment-methods', { cashapp_cashtag: OVERSIZED }],
    ['PUT', '/api/users/payment-methods', { zelle_identifier: OVERSIZED }],
    ['PUT', '/api/venue-profile', { businessName: OVERSIZED }],
    ['PUT', '/api/venue-profile', { category: OVERSIZED }],
    ['PUT', '/api/venue-profile', { location: OVERSIZED }],
    ['PUT', '/api/venue-profile', { description: OVERSIZED }],
    ['PUT', '/api/venue-profile', { phone: OVERSIZED }],
    ['PUT', '/api/venue-profile', { googlePlaceId: OVERSIZED }],
    ['PUT', '/api/venue-profile', { photoUrl: `https://example.com/${OVERSIZED}` }],
    ['PUT', '/api/venue-profile', { goals: [OVERSIZED] }],
    ['PUT', '/api/venue-profile', { operatingHours: [{ days: OVERSIZED, open: '9', close: '5' }] }],
    ['POST', '/api/venue-profile', { businessName: OVERSIZED }],
    ['POST', '/api/venue-profile', { category: OVERSIZED }],
    ['POST', '/api/venue-profile', { location: OVERSIZED }],
    ['POST', '/api/venue-profile', { description: OVERSIZED }],
    ['POST', '/api/venue-profile', { goals: [OVERSIZED] }],
  ];
  for (const [method, pathname, body] of cases) {
    clearLimiters();
    const res = await call(method, pathname, body);
    const label = `${method} ${pathname} ${JSON.stringify(body || {}).slice(0, 40)}`;
    assert.equal(res.status, 400,
      `${label} -> ${res.status}. A field that takes ${UNBOUNDED_PROBE} characters has no maximum of its own; `
      + 'the JSON parser in server.js is its only bound.');
    assert.deepEqual(noWrites().map((q) => q.sql), [], `${label}: wrote to the database anyway`);
  }
});

// ---------------------------------------------------------------------------
// 6. AT the ceiling, and one past it — driven from the routes' own numbers
// ---------------------------------------------------------------------------

// NOT 'x'. The first draft of this file padded with it and half the boundary
// cases came back 400 for PROFANITY: "xxx" is on content-checker's wordlist, so
// every probe was passing (or failing) for a reason that had nothing to do with
// a length. A padding character has to be inert on every screen these routes
// run, which is what the assertion below pins.
const PAD_CHAR = 'a';
const pad = (n, ch = PAD_CHAR) => ch.repeat(n);

const { moderateText } = require('../utils/moderation');
const { stripHtml } = require('../utils/sanitize');

test('the padding these probes are built from is not itself refused', () => {
  assert.equal(moderateText(pad(300)).allowed, true,
    `"${PAD_CHAR}" repeated is screened as profanity, so every length probe below would be measuring the wordlist`);
  assert.equal(stripHtml(pad(300)), pad(300),
    'the padding must survive stripHtml, or an "at the ceiling" probe is shorter than it claims');
  // The one that actually bit: 'x' looks like the obvious filler and is not.
  assert.equal(moderateText('x'.repeat(300)).allowed, false,
    'if "xxx" stops being profanity this note can go, but do not reintroduce it as padding on a hunch');
});

// A syntactically valid address of EXACTLY n characters. Domain labels are
// capped at 63 by the spec and by validator.js, so the domain is built out of
// several of them rather than one long one.
function emailOfLength(n) {
  const local = pad(64, 'a');
  let domainLen = n - local.length - 1;
  assert.ok(domainLen > 5, 'n is too small to build an address from');
  const labels = [];
  let left = domainLen - 4; // reserve ".com"
  while (left > 0) {
    const take = Math.min(left, 63);
    labels.push(pad(take, 'b'));
    left -= take;
    if (left > 0) { left -= 1; } // the separating dot
  }
  const addr = `${local}@${labels.join('.')}.com`;
  assert.equal(addr.length, n, 'the generated address is not the length asked for');
  return addr;
}

test('a name at MAX_NAME is stored and one character more is refused', async () => {
  clearLimiters();
  const at = await call('PUT', '/api/users/profile', { name: pad(U.NAME), current_password: PASSWORD });
  assert.equal(at.status, 200, `a ${U.NAME}-character name is inside users.name and must be accepted: ${at.text}`);
  assert.equal(wrote(/^UPDATE users SET name/i).length, 1);

  clearLimiters();
  const over = await call('PUT', '/api/users/profile', { name: pad(U.NAME + 1), current_password: PASSWORD });
  assert.equal(over.status, 400, 'one character past the column is a 400, never a Postgres 22001');
  assert.deepEqual(noWrites(), []);
});

test('a bio at MAX_BIO is stored and one character more is refused', async () => {
  // users.bio is TEXT, so unlike name there is no column width behind this
  // ceiling — the route's bound is the ONLY bound, which makes the refusal
  // side of this probe the load-bearing half.
  clearLimiters();
  const at = await call('PUT', '/api/users/profile', { bio: pad(U.BIO), current_password: PASSWORD });
  assert.equal(at.status, 200, `a ${U.BIO}-character bio must be accepted: ${at.text}`);
  const update = wrote(/^UPDATE users SET name/i);
  assert.equal(update.length, 1);
  assert.equal(update[0].params[6], pad(U.BIO), 'the bio must reach the UPDATE as $7');

  clearLimiters();
  const over = await call('PUT', '/api/users/profile', { bio: pad(U.BIO + 1), current_password: PASSWORD });
  assert.equal(over.status, 400, 'one character past the ceiling must be a 400, not a silently stored novel');
  assert.deepEqual(noWrites(), []);
});

test('markup in a bio is stripped before it is stored, and the ceiling reads the stripped string', async () => {
  // The bio is served to ANY authenticated user by GET /api/users/:id/card,
  // so it takes the same freeText treatment as the name: what lands in the
  // column is text, never markup.
  clearLimiters();
  const res = await call('PUT', '/api/users/profile', {
    bio: 'plans <b>rooftop</b> nights<script>alert(1)</script>', current_password: PASSWORD,
  });
  assert.equal(res.status, 200, res.text);
  const update = wrote(/^UPDATE users SET name/i)[0];
  assert.equal(update.params[6], 'plans rooftop nights');

  // Measured after the strip: a value whose markup pushes it past the ceiling
  // but whose TEXT is inside it must be accepted, which is the same direction
  // the name field documents.
  clearLimiters();
  const wrapped = `<b>${pad(U.BIO)}</b>`;
  const stillFits = await call('PUT', '/api/users/profile', { bio: wrapped, current_password: PASSWORD });
  assert.equal(stillFits.status, 200, stillFits.text);
  assert.equal(wrote(/^UPDATE users SET name/i)[0].params[6], pad(U.BIO));
});

// MEASURED, NOT ASSUMED. The first draft of this test asserted that an address
// at MAX_EMAIL is accepted, and it failed: validator.js's isEmail caps the whole
// address at 254 characters, one below users.email's width, so the route's own
// ceiling is a BACKSTOP that never fires today. That is worth knowing precisely
// rather than guessing at, and it is worth checking in the direction that
// matters, which is not "where does the refusal happen" but "can anything this
// route accepts overflow the column". So this finds the real maximum by asking
// the running route, and holds THAT against the column width.
async function largestAcceptedEmailLength() {
  const put = async (n) => {
    clearLimiters();
    return call('PUT', '/api/users/profile', { email: emailOfLength(n), current_password: PASSWORD });
  };
  let lo = 80;
  let hi = U.EMAIL + 80;
  assert.equal((await put(lo)).status, 200, 'an ordinary address must be accepted, or this search means nothing');
  assert.equal((await put(hi)).status, 400, `a ${hi}-character address must be refused somewhere`);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const res = await put(mid);
    if (res.status === 200) lo = mid; else hi = mid;
  }
  return lo;
}

test('nothing this route accepts as an email can overflow users.email', async () => {
  const measured = await largestAcceptedEmailLength();
  assert.ok(measured <= U.EMAIL,
    `the route accepts a ${measured}-character address and users.email holds ${U.EMAIL}. `
    + 'That is a Postgres 22001 on the UPDATE, i.e. a 500 for a client mistake.');
  assert.ok(measured > 64, `the measured maximum (${measured}) is implausibly small; the search is wrong, not the route`);
});

test('an address that GROWS when it is normalized cannot overflow the column either', async () => {
  // Round 2 of this audit, and the bug was in the fix rather than in the route:
  // the first draft measured the raw address on the reasoning that
  // normalizeEmail only shortens. It does not. Lowercasing U+0130 produces two
  // code points, isEmail caps the local part at 64 BYTES rather than characters,
  // and a 254-code-point address therefore normalizes to 286 and lands on a
  // VARCHAR(255). This is that exact address.
  const local = 'İ'.repeat(32); // 64 UTF-8 bytes, 32 code points, 64 once lowercased
  const domainLen = 254 - local.length - 1;
  const labels = [];
  let left = domainLen - 4;
  while (left > 0) { const t = Math.min(left, 63); labels.push(pad(t, 'b')); left -= t; if (left > 0) left -= 1; }
  const addr = `${local}@${labels.join('.')}.com`;
  assert.equal([...addr].length, 254, 'the probe must be inside every raw-length rule, or it proves nothing');
  assert.ok([...addr.toLowerCase()].length > U.EMAIL, 'the probe must actually grow past the column');

  clearLimiters();
  const res = await call('PUT', '/api/users/profile', { email: addr, current_password: PASSWORD });
  assert.equal(res.status, 400,
    `a ${[...addr].length}-character address that normalizes to ${[...addr.toLowerCase()].length} `
    + 'must be refused, not written to a VARCHAR(255) as a Postgres 22001');
  assert.deepEqual(noWrites(), []);

  // And the shape of the fix, pinned: the width has to be measured AFTER the
  // sanitizer that can change it. Measuring only before is the bug above.
  const src = read('routes/users.js');
  const from = src.indexOf("body('email')");
  const to = src.indexOf("body('phone')", from);
  assert.ok(from > 0 && to > from, 'the email chain is not where this expected it');
  const chain = src.slice(from, to);
  const afterSanitizer = chain.slice(chain.indexOf('.normalizeEmail()'));
  assert.match(afterSanitizer, /isLength\(\{ max: MAX_EMAIL \}\)/,
    'the width must be re-checked after normalizeEmail, which is the sanitizer that can lengthen it');
});

test('an address past the route\'s own ceiling is refused as a length, in words', async () => {
  clearLimiters();
  const over = await call('PUT', '/api/users/profile', { email: emailOfLength(U.EMAIL + 40), current_password: PASSWORD });
  assert.equal(over.status, 400, over.text);
  assert.match(over.text, /too long/i,
    'the route\'s own isLength must be what answers here, not "Valid email required" from a library rule '
    + 'that a dependency upgrade could relax');
  assert.deepEqual(noWrites(), []);
});

test('the search term is capped at the width of the column it is matched against', async () => {
  clearLimiters();
  const at = await call('GET', `/api/users/search?q=${pad(U.SEARCH)}`);
  assert.equal(at.status, 200, at.text);
  assert.equal(wrote(/FROM users/i).length, 1, 'a term at the ceiling must still be searched for');

  clearLimiters();
  const over = await call('GET', `/api/users/search?q=${pad(U.SEARCH + 1)}`);
  assert.equal(over.status, 400, 'a term wider than users.name cannot match anything and must not be scanned for');
  assert.deepEqual(log.map((q) => q.sql), [], 'the over-long term reached the database');
});

test('an avatar URL at MAX_AVATAR_URL is saved and one character more is refused', async () => {
  const prefix = 'https://api.dicebear.com/7.x/bottts/svg?seed=';
  clearLimiters();
  const at = await call('PUT', '/api/users/profile-image', { url: prefix + pad(U.AVATAR_URL - prefix.length) });
  assert.equal(at.status, 200, at.text);
  assert.equal(wrote(/UPDATE users SET profile_image_url/i).length, 1);

  clearLimiters();
  const over = await call('PUT', '/api/users/profile-image', { url: prefix + pad(U.AVATAR_URL + 1 - prefix.length) });
  assert.equal(over.status, 400, 'profile_image_url is repeated on every roster and push; it needs a ceiling');
  assert.deepEqual(noWrites(), []);
});

test('a password at MAX_PASSWORD still reaches bcrypt and one character more is refused', async () => {
  clearLimiters();
  // At the ceiling the value is WRONG, not oversized, so the route must answer
  // with its own credential refusal rather than a validation error.
  const at = await call('PUT', '/api/users/profile', { name: 'Ava', current_password: pad(U.PASSWORD) });
  assert.equal(at.status, 401, `a ${U.PASSWORD}-character password must reach the compare: ${at.text}`);

  clearLimiters();
  const over = await call('PUT', '/api/users/profile', { name: 'Ava', current_password: pad(U.PASSWORD + 1) });
  assert.equal(over.status, 400, over.text);
  assert.match(over.text, /too long/i);
});

test('a new password at MAX_PASSWORD is hashed and one character more is refused', async () => {
  clearLimiters();
  const good = `Aa1${pad(U.PASSWORD - 3)}`;
  const at = await call('PUT', '/api/users/profile', { new_password: good, current_password: PASSWORD });
  assert.equal(at.status, 200, at.text);

  clearLimiters();
  const over = await call('PUT', '/api/users/profile', { new_password: `Aa1${pad(U.PASSWORD - 2)}`, current_password: PASSWORD });
  assert.equal(over.status, 400, over.text);
  assert.deepEqual(noWrites(), []);
});

test('the deletion password carries the same ceiling, refused rather than ignored', async () => {
  clearLimiters();
  const over = await call('DELETE', '/api/users/me', { password: pad(U.PASSWORD + 1) });
  assert.equal(over.status, 400, over.text);
  assert.match(over.text, /too long/i,
    'answering an over-long password with the "enter your password" prompt sends the user round the loop for ever');
  assert.deepEqual(noWrites(), [], 'nothing may be written for a refused deletion');
});

test('a Zelle identifier at its ceiling saves and one character more is refused', async () => {
  clearLimiters();
  const at = await call('PUT', '/api/users/payment-methods', { zelle_identifier: pad(U.ZELLE) });
  assert.equal(at.status, 200, at.text);

  clearLimiters();
  const over = await call('PUT', '/api/users/payment-methods', { zelle_identifier: pad(U.ZELLE + 1) });
  assert.equal(over.status, 400, over.text);
  assert.deepEqual(noWrites(), []);
});

// ---------------------------------------------------------------------------
// 7. interests — the field the finding was about
// ---------------------------------------------------------------------------

test('interests at MAX_INTERESTS x MAX_INTEREST_LEN is stored, and either dimension past it is a 400', async () => {
  clearLimiters();
  const full = Array.from({ length: U.INTERESTS }, (_, i) => `${i}`.padEnd(U.INTEREST_LEN, 'z'));
  const at = await call('PUT', '/api/users/profile', { interests: full, current_password: PASSWORD });
  assert.equal(at.status, 200, at.text);
  const update = wrote(/^UPDATE users SET name/i)[0];
  assert.ok(update, 'the profile update never ran');
  const stored = update.params.find((p) => Array.isArray(p));
  assert.equal(stored.length, U.INTERESTS, 'the whole array must be stored, not a truncated one');

  clearLimiters();
  const tooMany = await call('PUT', '/api/users/profile', {
    interests: [...full, 'one more'], current_password: PASSWORD,
  });
  assert.equal(tooMany.status, 400, 'the array length had no maximum of its own');
  assert.deepEqual(noWrites(), []);

  clearLimiters();
  const tooLong = await call('PUT', '/api/users/profile', {
    interests: [pad(U.INTEREST_LEN + 1)], current_password: PASSWORD,
  });
  assert.equal(tooLong.status, 400, 'each element had no maximum of its own either');
  assert.deepEqual(noWrites(), []);
});

test('a structured interest never reaches the TEXT[] column', async () => {
  // sanitizeArray DROPS objects and nested arrays rather than storing them, so
  // before the rule was added `["ok", {"a":1}]` was silently stored as ["ok"]:
  // a save that quietly means something other than what was sent. It is a 400
  // now, and the shape is settled before the sanitizer rather than after it.
  for (const bad of [[{ a: 1 }], [['nested']], [null], [42], [true], 'not a list', { a: 1 }]) {
    clearLimiters();
    const res = await call('PUT', '/api/users/profile', { interests: bad, current_password: PASSWORD });
    assert.equal(res.status, 400, `interests=${JSON.stringify(bad)} -> ${res.status} ${res.text}`);
    assert.deepEqual(noWrites(), [], `interests=${JSON.stringify(bad)} reached the database`);
  }
});

test('an explicit null interests list is "leave it alone", not a validation error', async () => {
  // optional() skips undefined, not null. The handler has always read a falsy
  // value as "do not touch the column"; the chain must not be the thing that
  // refuses what the handler knows how to serve.
  clearLimiters();
  const res = await call('PUT', '/api/users/profile', { interests: null, current_password: PASSWORD });
  assert.equal(res.status, 200, res.text);
  const update = wrote(/^UPDATE users SET name/i)[0];
  assert.equal(update.params[3], null, 'a null list must reach COALESCE as NULL, leaving the column untouched');
});

test('an empty interests list still clears the column', async () => {
  clearLimiters();
  const res = await call('PUT', '/api/users/profile', { interests: [], current_password: PASSWORD });
  assert.equal(res.status, 200, res.text);
  const update = wrote(/^UPDATE users SET name/i)[0];
  assert.deepEqual(update.params[3], [], 'clearing your interests must still be possible');
});

test('markup in an interest is stripped, and the screen runs on the stripped string', async () => {
  clearLimiters();
  const res = await call('PUT', '/api/users/profile', {
    interests: ['<b>Live Music</b>', 'Cocktails<script>alert(1)</script>'],
    current_password: PASSWORD,
  });
  assert.equal(res.status, 200, res.text);
  const stored = wrote(/^UPDATE users SET name/i)[0].params.find((p) => Array.isArray(p));
  assert.deepEqual(stored, ['Live Music', 'Cocktails'],
    'interests are rendered into the moderation queue\'s profile evidence; they cannot BE markup');
});

test('an interest made entirely of markup is refused, not stored blank', async () => {
  clearLimiters();
  const res = await call('PUT', '/api/users/profile', { interests: ['<b> </b>'], current_password: PASSWORD });
  assert.equal(res.status, 400, res.text);
  assert.deepEqual(noWrites(), []);
});

test('the interest ceilings are at least what the product\'s own vocabulary needs', () => {
  // A bound can be wrong by being too SMALL, and nothing above catches that:
  // every boundary case is driven from the constant, so tightening it moves the
  // test with it. The floor is the interest vocabulary the product defines for
  // itself. routes/events.js maps user interests onto Ticketmaster
  // classifications, so its key set is the list this app has committed to
  // understanding, and every one of them has to fit in the column at once.
  const src = read('routes/events.js');
  const map = /const interestToTM = \{([\s\S]*?)\n {6}\};/.exec(src);
  assert.ok(map, 'routes/events.js must still declare interestToTM; the floor below is read from it');
  const keys = [...map[1].matchAll(/'([^']+)':/g)].map((m) => m[1]);
  assert.ok(keys.length >= 10, `only ${keys.length} interests parsed out of interestToTM; the read is wrong`);
  assert.ok(U.INTERESTS >= keys.length,
    `MAX_INTERESTS is ${U.INTERESTS} and the product itself names ${keys.length} interests. `
    + 'Somebody with every interest the app knows about could not save their profile.');
  const longest = keys.reduce((a, b) => (b.length > a.length ? b : a));
  assert.ok(U.INTEREST_LEN >= longest.length,
    `MAX_INTEREST_LEN is ${U.INTEREST_LEN} and the product's own longest interest is "${longest}" `
    + `at ${longest.length} characters`);
});

test('a Zelle identifier cannot BE markup on somebody else\'s bill-split screen', async () => {
  clearLimiters();
  const res = await call('PUT', '/api/users/payment-methods', { zelle_identifier: '<b>ava@example.com</b>' });
  assert.equal(res.status, 200, res.text);
  const update = wrote(/^UPDATE users SET/i)[0];
  assert.equal(update.params[0], 'ava@example.com',
    'routes/billing.js interpolates this into the payment instructions other members read');

  // And the wordlist runs on it, on the STRIPPED string, for the same reason it
  // runs on interests: the value lands on somebody else's screen. The tag sits
  // inside the word so that a screen placed before the strip would miss it.
  const slur = 'shit';
  const split = `${slur.slice(0, 2)}<b>${slur.slice(2)}`;
  assert.equal(moderateText(split).allowed, true, 'the probe must be invisible to a PRE-strip screen');
  clearLimiters();
  const screened = await call('PUT', '/api/users/payment-methods', { zelle_identifier: split });
  assert.equal(screened.status, 400, `"${split}" reached zelle_identifier: ${screened.text}`);
  assert.deepEqual(noWrites(), []);
});

test('a slur wrapped in markup is caught, which is the whole reason the screen runs second', async () => {
  const slur = 'shit';
  // Asserted rather than assumed: if the wordlist stops holding this word the
  // failure below would look like a broken screen instead of a stale probe.
  assert.equal(moderateText(slur).allowed, false, 'the probe word is no longer profanity; pick another');
  clearLimiters();
  const bare = await call('PUT', '/api/users/profile', { interests: [slur], current_password: PASSWORD });
  assert.equal(bare.status, 400, `"${slur}" must be screened out of interests: ${bare.text}`);

  // The tag has to sit INSIDE the word, not around it. Round 3 of this audit
  // caught the first version using `<b>shit</b>`, which the wordlist flags
  // either way (it tokenizes on the angle brackets), so the test passed whether
  // the screen ran before or after the strip and proved nothing about the
  // ordering it claimed to be about. A tag between two letters is what actually
  // separates the two: "sh<b>it" is three harmless tokens before stripHtml and
  // one slur after it.
  const split = `${slur.slice(0, 2)}<b>${slur.slice(2)}`;
  assert.equal(moderateText(split).allowed, true, 'the probe must be invisible to a PRE-strip screen');
  assert.equal(moderateText(stripHtml(split)).allowed, false, 'and visible to a POST-strip one');

  clearLimiters();
  const hidden = await call('PUT', '/api/users/profile', { interests: [split], current_password: PASSWORD });
  assert.equal(hidden.status, 400,
    'screening BEFORE the strip lets a tag hide the word and then stores it without the tag');
  assert.deepEqual(noWrites(), []);
});

// ---------------------------------------------------------------------------
// 8. notificationPrefs — a key ceiling, and a write that merges
// ---------------------------------------------------------------------------

test('notificationPrefs accepts MAX_PREF_KEYS keys and refuses one more', async () => {
  const keys = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, true]));
  clearLimiters();
  const at = await call('PUT', '/api/venue-profile', { notificationPrefs: keys(V.PREF_KEYS) });
  assert.equal(at.status, 200, at.text);

  clearLimiters();
  const over = await call('PUT', '/api/venue-profile', { notificationPrefs: keys(V.PREF_KEYS + 1) });
  assert.equal(over.status, 400, 'the object had no key ceiling; server.js\'s parser was the only one');
  assert.deepEqual(noWrites(), []);
});

test('an unknown key is still dropped rather than refused, and its value never reaches the column', async () => {
  // The forgiving half of the rule: a client round-tripping an older shape must
  // keep saving. What must not survive is the value.
  clearLimiters();
  const res = await call('PUT', '/api/venue-profile', {
    notificationPrefs: { bookings: true, junk: pad(5000), reviews: false },
  });
  assert.equal(res.status, 200, res.text);
  const update = wrote(/^UPDATE venue_profiles SET/i)[0];
  const sent = JSON.parse(update.params.find((p) => typeof p === 'string' && p.startsWith('{')));
  assert.deepEqual(sent, { bookings: true, reviews: false });
});

test('a partial notificationPrefs write MERGES; it does not replace the other switches', async () => {
  // COALESCE picks one side or the other. The owner who toggles "bookings" must
  // not lose "reviews" and "weekly" as a side effect, and the owner who sends an
  // object of unknown keys (which sanitizes to {}) must not have all three
  // cleared. Asserted on the statement actually issued, because a comment
  // claiming a merge and SQL that replaces is exactly this bug wearing a
  // disguise.
  clearLimiters();
  const res = await call('PUT', '/api/venue-profile', { notificationPrefs: { bookings: false } });
  assert.equal(res.status, 200, res.text);
  const update = wrote(/^UPDATE venue_profiles SET/i)[0];
  const clause = /notification_prefs = ([\s\S]*?),\s+google_place_id/.exec(update.sql);
  assert.ok(clause, `the notification_prefs assignment is not where this expected it: ${update.sql}`);
  assert.match(clause[1], /\|\|/,
    'the write must merge with jsonb ||; COALESCE alone replaces the whole object');
  assert.doesNotMatch(clause[1], /^COALESCE\(\$\d+, notification_prefs\)$/,
    'this is the replace-instead-of-merge form the audit found');
  // Sending nothing must still leave the column alone.
  clearLimiters();
  await call('PUT', '/api/venue-profile', { businessName: 'Bar' });
  const none = wrote(/^UPDATE venue_profiles SET/i)[0];
  assert.equal(none.params[7], null, 'an absent notificationPrefs must reach the statement as NULL');
});

test('every statement these routes issue binds exactly the parameters it names', async () => {
  // Round 2 of this audit, and the bug was mine. A SQL comment added inside the
  // venue UPDATE contained a BACKTICK. That statement is a template literal, so
  // the backtick ended the string, the rest of the query became a second literal
  // joined to the first with ||, and JavaScript evaluated the whole thing to the
  // truncated first half. It parsed, it linted, the route answered 200 against a
  // fake pool, and what would have reached Postgres was an UPDATE naming seven
  // placeholders with eleven parameters bound to it: "bind message supplies 11
  // parameters, but prepared statement requires 7", on every venue profile save.
  //
  // The general property that catches it, checked over everything these routes
  // actually issue rather than over one statement somebody remembered.
  const drive = [
    ['PUT', '/api/venue-profile', { businessName: 'Bar', notificationPrefs: { bookings: true }, photoUrl: '/api/venues/photo?ref=a123' }],
    ['POST', '/api/venue-profile', { businessName: 'Bar', goals: ['more weeknights'] }],
    ['PUT', '/api/users/profile', { name: 'Ava', interests: ['Cocktails'], current_password: PASSWORD }],
    ['PUT', '/api/users/payment-methods', { venmo_username: 'ava', cashapp_cashtag: 'ava', zelle_identifier: 'ava@example.com' }],
    ['PUT', '/api/users/profile-image', { url: 'https://api.dicebear.com/7.x/bottts/svg?seed=abc' }],
    ['GET', '/api/users/search?q=ava', undefined],
    ['PATCH', '/api/users/settings', { theme: 'dark' }],
  ];
  let checked = 0;
  const seen = [];
  for (const [method, pathname, body] of drive) {
    clearLimiters();
    const res = await call(method, pathname, body);
    assert.ok(res.status < 400, `${method} ${pathname} -> ${res.status} ${res.text}`);
    for (const q of log) {
      const named = [...q.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
      const highest = named.length ? Math.max(...named) : 0;
      assert.equal(highest, q.params.length,
        `${method} ${pathname}: a statement names $1..$${highest} and binds ${q.params.length} parameters. `
        + `Postgres refuses that outright.\n${q.sql}`);
      checked += 1;
      seen.push(q.sql);
    }
  }
  assert.ok(checked >= drive.length,
    `only ${checked} statements were checked; the drive list is not exercising these routes`);
  // The two widest statements by parameter count are the ones this class of bug
  // actually lands on, so name them rather than trusting a count.
  for (const [label, re] of [
    ['the venue profile UPDATE', /UPDATE venue_profiles SET .*\$11/],
    ['the venue profile INSERT', /INSERT INTO venue_profiles .*\$7/],
    ['the user profile UPDATE', /UPDATE users SET name = COALESCE\(\$1.*\$6/],
  ]) {
    assert.ok(seen.some((s) => re.test(s)), `${label} never ran, so its parameter count went unchecked`);
  }
});

// ---------------------------------------------------------------------------
// 9. The venue profile's other ceilings, at the boundary
// ---------------------------------------------------------------------------

test('every venue text field is accepted at its ceiling and refused one past it', async () => {
  const cases = [
    ['businessName', V.BUSINESS_NAME],
    ['category', V.CATEGORY],
    ['location', V.LOCATION],
    ['description', V.DESCRIPTION],
    ['phone', V.PHONE],
  ];
  for (const [field, max] of cases) {
    clearLimiters();
    const at = await call('PUT', '/api/venue-profile', { [field]: pad(max) });
    assert.equal(at.status, 200, `${field} at ${max} -> ${at.status} ${at.text}`);

    clearLimiters();
    const over = await call('PUT', '/api/venue-profile', { [field]: pad(max + 1) });
    assert.equal(over.status, 400, `${field} at ${max + 1} -> ${over.status}`);
    assert.deepEqual(noWrites(), [], `${field}: an over-long value reached the database`);
  }
});

test('goals and operating hours hold at both of their dimensions', async () => {
  const goals = (n, len) => Array.from({ length: n }, () => pad(len));
  const hours = (n, len) => Array.from({ length: n }, () => ({ days: pad(len), open: '9', close: '5' }));

  clearLimiters();
  assert.equal((await call('PUT', '/api/venue-profile', { goals: goals(V.GOALS, V.GOAL_LEN) })).status, 200);
  clearLimiters();
  assert.equal((await call('PUT', '/api/venue-profile', { goals: goals(V.GOALS + 1, 1) })).status, 400);
  clearLimiters();
  assert.equal((await call('PUT', '/api/venue-profile', { goals: goals(1, V.GOAL_LEN + 1) })).status, 400);

  clearLimiters();
  assert.equal((await call('PUT', '/api/venue-profile', { operatingHours: hours(V.HOURS_ROWS, V.HOURS_FIELD) })).status, 200);
  clearLimiters();
  assert.equal((await call('PUT', '/api/venue-profile', { operatingHours: hours(V.HOURS_ROWS + 1, 1) })).status, 400);
  clearLimiters();
  assert.equal((await call('PUT', '/api/venue-profile', { operatingHours: hours(1, V.HOURS_FIELD + 1) })).status, 400);
});

test('venue prose cannot BE markup on the way into the column', async () => {
  clearLimiters();
  const res = await call('PUT', '/api/venue-profile', {
    businessName: "<b>Joe's Bar</b>",
    description: 'Great <script>alert(1)</script>beer',
  });
  assert.equal(res.status, 200, res.text);
  const update = wrote(/^UPDATE venue_profiles SET/i)[0];
  assert.equal(update.params[0], "Joe's Bar");
  assert.equal(update.params[3], 'Great beer');
});

test('the CREATE route strips prose too, not just the update', async () => {
  // The two chains are separate declarations and have drifted before (the PUT's
  // validators were dead code entirely until the 2026-08-14 audit). Onboarding
  // is where a profile's text is first written, so it needs its own case.
  clearLimiters();
  const res = await call('POST', '/api/venue-profile', {
    businessName: "<b>Joe's Bar</b>",
    category: '<i>Bar</i>',
    location: 'Denver<script>alert(1)</script>, CO',
    description: 'Great <script>alert(1)</script>beer',
  });
  assert.equal(res.status, 201, res.text);
  const insert = wrote(/^INSERT INTO venue_profiles/i)[0];
  assert.ok(insert, 'the insert never ran');
  assert.equal(insert.params[1], "Joe's Bar");
  assert.equal(insert.params[2], 'Bar');
  assert.equal(insert.params[3], 'Denver, CO');
  assert.equal(insert.params[4], 'Great beer');
});

test('a business name that is nothing but markup is refused on create', async () => {
  clearLimiters();
  const res = await call('POST', '/api/venue-profile', { businessName: '<b> </b>' });
  assert.equal(res.status, 400, res.text);
  assert.deepEqual(noWrites(), [],
    'a markup-only name must not be promoted to venue_owner and stored blank');
});

// ---------------------------------------------------------------------------
// 10. The RevenueCat webhook
// ---------------------------------------------------------------------------

const RC_SECRET = 'field-bounds-rc-secret';
async function rc(body, secret = RC_SECRET) {
  handlers = DEFAULT_HANDLERS();
  log = [];
  const res = await fetch(`${base}/api/revenuecat/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

// Comments are allowed to NAME the thing that was removed; code is not allowed
// to be it. Same `codeOnly` idea __tests__/alertPreferences.test.js uses on the
// em-dash scan, and the first draft of this test failed on its own explanation.
const codeOnly = (src) => src.split('\n')
  .map((line) => { const at = line.indexOf('//'); return at === -1 ? line : line.slice(0, at); })
  .join('\n');

test('the router mounts no parser of its own, because it could not take effect', () => {
  const src = codeOnly(read('routes/revenuecat.js'));
  assert.doesNotMatch(src, /express\.(json|urlencoded|raw|text)\s*\(/,
    'a parser here is a no-op: the block in server.js runs first and marks the body read. '
    + 'Leaving one in place reads as though this route controls its ceiling, and it does not.');
  // And the real ceiling still lives where it can take effect.
  assert.match(read('server.js'), /const WEBHOOK_JSON_BODY_BYTES = /,
    'server.js must still scope this route a parser of its own');
});

test('the shared-secret compare is constant time, and is length-guarded first', () => {
  // The one property on this route no black-box test can observe: a compare that
  // returns early on the first differing byte leaks the secret to somebody
  // timing it, and /api/revenuecat is deliberately mounted with NO rate limiter
  // (webhook retries must never be throttled), so there is nothing else slowing
  // that measurement down. Pinned against the source, because the alternative is
  // pinning it against nothing.
  const src = codeOnly(read('routes/revenuecat.js'));
  assert.match(src, /crypto\.timingSafeEqual\(/,
    'the secret compare must be constant time; === leaks it byte by byte to a caller with a stopwatch');
  assert.match(src, /if \(a\.length !== b\.length\) return false;[\s\S]{0,80}?crypto\.timingSafeEqual\(a, b\)/,
    'timingSafeEqual THROWS on unequal lengths, so the length guard has to come first and has to return false');
  assert.doesNotMatch(src, /header === `Bearer|secret === |=== secret/,
    'a plain equality compare on the secret has come back');
  // And the route it guards is still mounted without a limiter, which is the
  // premise the whole paragraph rests on.
  assert.match(read('server.js'), /app\.use\('\/api\/revenuecat', revenuecatRoutes\);/,
    'if this route ever gains a rate limiter, the note above should be revisited rather than left stale');
});

test('the webhook fails closed with no secret and on a wrong one', async () => {
  delete process.env.REVENUECAT_WEBHOOK_SECRET;
  const unconfigured = await rc({ event: { type: 'INITIAL_PURCHASE', app_user_id: '1', entitlement_ids: ['pro'] } });
  assert.equal(unconfigured.status, 503, 'an unconfigured secret must never accept an entitlement event');
  assert.deepEqual(noWrites(), []);

  process.env.REVENUECAT_WEBHOOK_SECRET = RC_SECRET;
  const wrong = await rc({ event: { type: 'INITIAL_PURCHASE', app_user_id: '1' } }, 'not-the-secret');
  assert.equal(wrong.status, 401);
  assert.deepEqual(noWrites(), []);
  delete process.env.REVENUECAT_WEBHOOK_SECRET;
});

test('an app_user_id outside int4 is a 400, not a Postgres 22003 dressed as a 500', async () => {
  process.env.REVENUECAT_WEBHOOK_SECRET = RC_SECRET;
  try {
    for (const id of [String(R.INT4 + 1), '99999999999', '-5', '0', '4242junk', 'junk', '', ' ', '4.2']) {
      const res = await rc({ event: { type: 'INITIAL_PURCHASE', app_user_id: id, entitlement_ids: ['pro'] } });
      assert.equal(res.status, 400, `app_user_id=${JSON.stringify(id)} -> ${res.status} ${res.text}`);
      assert.deepEqual(noWrites(), [],
        `app_user_id=${JSON.stringify(id)} reached a query. A 500 here is retried by RevenueCat for ever.`);
    }
    // The largest id the column can hold is still accepted, so this is a range
    // check and not a narrowing.
    const ok = await rc({ event: { type: 'INITIAL_PURCHASE', app_user_id: String(R.INT4), entitlement_ids: ['pro'] } });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(wrote(/UPDATE users SET is_premium/i)[0].params, [true, R.INT4]);
  } finally {
    delete process.env.REVENUECAT_WEBHOOK_SECRET;
  }
});

test('a TRANSFER at MAX_TRANSFER_IDS is applied and one id more is refused', async () => {
  process.env.REVENUECAT_WEBHOOK_SECRET = RC_SECRET;
  try {
    const ids = (n, from = 1) => Array.from({ length: n }, (_, i) => String(from + i));
    const at = await rc({ event: { type: 'TRANSFER', transferred_from: ids(R.TRANSFER_IDS), transferred_to: ids(R.TRANSFER_IDS, 1000) } });
    assert.equal(at.status, 200, at.text);
    assert.equal(wrote(/UPDATE users SET is_premium = false/i).length, 1);
    assert.equal(wrote(/UPDATE users SET is_premium = true/i).length, 1);

    const over = await rc({ event: { type: 'TRANSFER', transferred_to: ids(R.TRANSFER_IDS + 1) } });
    assert.equal(over.status, 400,
      'one webhook rewriting is_premium on an unbounded set of rows was bounded only by the 256KB parser');
    assert.deepEqual(noWrites(), []);

    // And the refusal is on the RAW array, so a huge list of junk costs nothing
    // to refuse.
    const junk = await rc({ event: { type: 'TRANSFER', transferred_from: Array.from({ length: 5000 }, () => 'nope') } });
    assert.equal(junk.status, 400, junk.text);
    assert.deepEqual(noWrites(), []);
  } finally {
    delete process.env.REVENUECAT_WEBHOOK_SECRET;
  }
});

test('an out-of-range id inside a TRANSFER is dropped, never sent to the int[] parameter', async () => {
  process.env.REVENUECAT_WEBHOOK_SECRET = RC_SECRET;
  try {
    const res = await rc({
      event: { type: 'TRANSFER', transferred_to: ['7', String(R.INT4 + 1), 'junk', '-3', '0'] },
    });
    assert.equal(res.status, 200, res.text);
    const update = wrote(/UPDATE users SET is_premium = true/i)[0];
    assert.deepEqual(update.params[0], [7],
      'anything the int[] parameter cannot hold has to be dropped before the query, not after it');
  } finally {
    delete process.env.REVENUECAT_WEBHOOK_SECRET;
  }
});

// ---------------------------------------------------------------------------
// 11. The bounds still fit the parser that serves them
// ---------------------------------------------------------------------------
// The point of giving a field its own maximum is undone if that maximum is
// larger than the buffer the route is served with: the request would be a 413
// before any validator saw it. Recomputed from the routes' own numbers, exactly
// the way bodyLimitAudit.test.js recomputes its own.

const PER_CHAR = 4; // worst-case UTF-8 bytes per code point; see server.js

test('the largest honest PUT /api/users/profile body fits the default parser', () => {
  const chars = U.NAME + U.EMAIL + U.PHONE
    + U.INTERESTS * U.INTEREST_LEN
    + U.PASSWORD * 2; // current_password and new_password together
  const worst = chars * PER_CHAR + 512; // keys and punctuation
  assert.ok(DEFAULT_JSON_BODY_BYTES >= worst,
    `the profile route accepts ${worst} bytes at its ceilings, past the ${DEFAULT_JSON_BODY_BYTES} default. `
    + 'A legal request would come back 413.');
});

test('the largest honest interests array fits, on its own terms', () => {
  const worst = U.INTERESTS * (U.INTEREST_LEN * PER_CHAR + 4) + 64;
  assert.ok(DEFAULT_JSON_BODY_BYTES >= worst,
    `interests alone is ${worst} bytes at its ceiling, past the ${DEFAULT_JSON_BODY_BYTES} default`);
});

test('the largest honest venue notificationPrefs object fits', () => {
  // Keys are the bounded dimension; the values are not, so this costs the object
  // at the widest key the parser could carry beside the rest of the body.
  const worst = V.PREF_KEYS * 128 + 256;
  assert.ok(DEFAULT_JSON_BODY_BYTES >= worst,
    `notificationPrefs is ${worst} bytes at its key ceiling, past the ${DEFAULT_JSON_BODY_BYTES} default`);
});
