// Run: node --test  (from backend/)
//
// Round 19. Nothing here was found by reading the code. Over four hundred
// single-token edits were applied one at a time to routes/billing.js,
// routes/auth.js and the calibration half of services/crowdEngine.js — clause
// deletions, boundary flips, && for ||, Math.round for Math.floor — and after
// each one the whole suite was re-run. The edits that no test noticed are the
// ones pinned below. (The rule-engine half of crowdEngine.js, which is the
// heuristic fallback for the ONNX model, was deliberately left unswept: its
// several hundred thresholds are tuned constants, not invariants.)
//
// The sweep first confirmed the round-18 work held: the OAuth claim's
// `token_version` bump, the squat eviction's payment-handle clearing, the equal
// split's remainder distribution, the custom-share two-cent tolerance and the
// roster's ORDER BY were all caught within a second of being deleted. What
// survived was everything ADJACENT to them, in five families:
//
//   A. THE ROUNDING OF THE PUBLISHED CROWD SCORE. Every existing calibration
//      fixture picks inputs that land on a whole number, so Math.round could be
//      swapped for Math.floor (or Math.ceil) in all three outputs of
//      buildCalibrationAdjustment and nothing went red. Not cosmetic: floor
//      biases the number on every crowd card DOWN, on the same field round 18
//      spent its effort bounding to 5 points.
//
//   B. THE >= IN SIX SEND BUDGETS. `budget.x >= LIMIT` could become `> LIMIT`
//      unnoticed, letting the LIMIT+1-th verification or password-reset mail
//      out. Several sit in one boolean whose OTHER operands were covered, so
//      the file looked tested; only the exact operand at its boundary was not.
//
//   C. THREE GUARDS THAT ONLY A RACE REACHES. `AND used_at IS NULL`,
//      `AND expires_at > NOW()` and `AND email_verified = FALSE` are the
//      database's half of checks whose JavaScript half runs on a row read
//      milliseconds earlier. Every fake in the suite re-implemented them beside
//      the statement instead of reading them out of it, so all three could be
//      deleted from the source with the tests still green.
//
//   D. FOUR PIECES OF BILL ARITHMETIC. The tip's rounding, a custom share's
//      rounding, whether a zero share is allowed, and which of two tied shares
//      absorbs the leftover cent. Each is a cent moving between two named
//      people who can both read the number.
//
//   E. THREE AUTHORIZATION BRANCHES AND THE AGE GATE. Each authorization
//      branch is an `&&` of two conditions with a fixture for only one side —
//      the refusal was covered and the permission was not, or the reverse. And
//      `age < MIN_AGE` could become `<=`, refusing every applicant of exactly
//      the age the product is built for, with no error anyone could report.
//
// Nothing below asserts on a fake. The calibration half calls the real exported
// function with no stub in the path. The route half drives the real Express
// routers and asserts on what the route sent and which statements it ran; the
// pg fake answers reads with values the test chose and never re-implements a
// write. Where a WHERE clause has to be honoured (part B3b) it is EVALUATED
// from the statement by a helper that has never heard of the columns involved,
// so a clause deleted from the source stops being enforced here too.

process.env.JWT_SECRET = 'mutation-gaps-test-secret';
process.env.PUBLIC_WEB_URL = 'https://flockcorp.com';
process.env.PUBLIC_API_URL = 'https://flock-app-production.up.railway.app';
process.env.GOOGLE_CLIENT_ID = 'flock-mutation-gaps.apps.googleusercontent.com';
delete process.env.RESEND_API_KEY; // no key -> emailService skips, nothing leaves the process
delete process.env.NODE_ENV;

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

// ===========================================================================
// PART A — the rounding of the number on the crowd card
//
// No mocks at all: the real exported function, called directly.
// ===========================================================================

const crowdEngine = require('../services/crowdEngine');
const { buildCalibrationAdjustment, CROWD_LEVEL_TO_SCORE } = crowdEngine;

// Distinct reporters, one report each, no timestamps (the age filter keeps
// undated rows — see moneyAndCalibration.test.js).
const reporters = (levels) => levels.map((crowd_level, i) => ({ crowd_level, user_id: 900 + i }));

test('the published score is ROUNDED, not truncated toward the quiet end', () => {
  // n=4 at weight 0.30 against engine 61: the blend lands on 50.95 and the mean
  // on 27.5, so every output has a fraction and every output rounds UP.
  // Math.floor would answer 50 / 27 / -34 here.
  const r = buildCalibrationAdjustment(reporters([1, 1, 1, 2]), 61);

  assert.strictEqual(r.reportCount, 4);
  assert.strictEqual(r.feedbackWeight, 0.3);
  assert.strictEqual(r.adjustedScore, 51, 'the score the card prints');
  assert.strictEqual(r.avgFeedbackScore, 28, 'what the crowd said, as shown');
  assert.strictEqual(r.predictionDrift, -33, 'how far the model was off, as shown');
});

test('and it is not rounded UP either', () => {
  // The mirror fixture. n=8 at weight 0.50 against engine 61: the blend lands
  // on 46.125 and the mean on 31.25, so every output rounds DOWN.
  // Math.ceil would answer 47 / 32 / -29 here.
  const r = buildCalibrationAdjustment(reporters([1, 1, 1, 1, 1, 2, 2, 2]), 61);

  assert.strictEqual(r.reportCount, 8);
  assert.strictEqual(r.feedbackWeight, 0.5);
  assert.strictEqual(r.adjustedScore, 46);
  assert.strictEqual(r.avgFeedbackScore, 31);
  assert.strictEqual(r.predictionDrift, -30);
});

test('every published calibration number is an integer, at every crowd size', () => {
  // The card renders these directly. A fractional score would print as
  // "46.125% busy", and predictionDrift feeds the venue dashboard's accuracy
  // readout. Swept rather than sampled, because the fractions only appear for
  // some (engine, crowd) combinations — which is exactly how the three
  // Math.round calls came to have no test on them.
  const levels = Object.keys(CROWD_LEVEL_TO_SCORE).map(Number);
  for (let n = 3; n <= 24; n++) {
    for (let engine = 0; engine <= 100; engine += 7) {
      const mix = Array.from({ length: n }, (_, i) => levels[i % levels.length]);
      const r = buildCalibrationAdjustment(reporters(mix), engine);
      assert.ok(Number.isInteger(r.adjustedScore), `n=${n} engine=${engine}: adjustedScore ${r.adjustedScore}`);
      assert.ok(Number.isInteger(r.avgFeedbackScore), `n=${n} engine=${engine}: avgFeedbackScore ${r.avgFeedbackScore}`);
      assert.ok(Number.isInteger(r.predictionDrift), `n=${n} engine=${engine}: predictionDrift ${r.predictionDrift}`);
      // Rounding must not push the published number outside the range the
      // label map is defined over.
      assert.ok(r.adjustedScore >= 0 && r.adjustedScore <= 100, `n=${n} engine=${engine}`);
    }
  }
});

test('the drift the dashboard shows is the mean minus the model, at that same precision', () => {
  // predictionDrift is not recomputable by the caller from the other two
  // fields once both have been rounded, so it is its own assertion. A crowd
  // reading 68.75 against a model reading 60 is a drift of 9, not 8.
  const r = buildCalibrationAdjustment(reporters([3, 3, 3, 3, 3, 2, 2, 2]), 60);
  assert.strictEqual(r.avgFeedbackScore, 69);
  assert.strictEqual(r.predictionDrift, 9);
  assert.strictEqual(r.adjustedScore, 64);
});

// ===========================================================================
// PART B — routes/auth.js
// ===========================================================================
//
// A deliberately small pg fake. It answers exactly the SELECTs these routes
// make, with values the test supplies, and it records every statement. It does
// NOT model rows: no handler here mutates state, so no assertion below can be
// satisfied by this file instead of by routes/auth.js. What is asserted is
// which statements the route chose to run.
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
  return Promise.reject(new Error(`unscripted query: ${flat.slice(0, 140)}`));
}
pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      log.push({ sql: String(sql).trim(), params: [] });
      return Promise.resolve({ rows: [] });
    }
    return dispatch(sql, params);
  },
  release: () => {},
});

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const pushMod = require('../services/pushHelper');
let pushes = [];
pushMod.pushIfOffline = async (_io, userId, title, body, data) => { pushes.push({ userId, title, body, data }); };
pushMod.pushAlways = async (_io, userId, title, body, data) => { pushes.push({ userId, title, body, data }); };

const authRouter = require('../routes/auth');
const {
  mintVerificationToken,
  RESEND_MAX_PER_HOUR_ACCOUNT,
  RESEND_MAX_PER_DAY_ACCOUNT,
  RESEND_MAX_PER_HOUR_IP,
  RESET_MAX_PER_HOUR_EMAIL,
  RESET_MAX_PER_DAY_EMAIL,
  RESET_MAX_PER_HOUR_IP,
  flushResetMail,
} = authRouter.__testing;

const billingRouter = require('../routes/billing');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api/billing', billingRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  pushes = [];
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
});

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

const ran = (prefix) => log.filter((q) => q.sql.startsWith(prefix));

// ---------------------------------------------------------------------------
// B1. The verification-resend budget, at its exact ceiling
// ---------------------------------------------------------------------------
// `budget.accountHour >= RESEND_MAX_PER_HOUR_ACCOUNT` is one of four operands
// in one `if`. The other three were covered; this one was not, so `>=` could
// become `>` and the account got one extra link — and one extra mail — every
// hour, for ever. Each of the three counters is driven to its own ceiling with
// the other two slack, so no assertion can be satisfied by a different operand
// tripping.
// ---------------------------------------------------------------------------

function scriptResend({ accountHour = 0, accountDay = 0, ipHour = 0, accountLast = null }) {
  log = [];
  handlers = [
    [/^SELECT id, email, name, email_verified FROM users WHERE id/, () => ({
      rows: [{ id: 1, email: 'ava@example.com', name: 'Ava', email_verified: false }],
    })],
    [/FROM email_verifications WHERE user_id/, () => ({
      rows: [{
        account_hour: accountHour,
        account_day: accountDay,
        account_last: accountLast,
        ip_hour: ipHour,
      }],
    })],
    [/^UPDATE email_verifications SET used_at/, () => ({ rows: [], rowCount: 0 })],
    [/^INSERT INTO email_verifications/, () => ({ rows: [], rowCount: 1 })],
  ];
}

const RESEND_CEILINGS = [
  ['accountHour', () => RESEND_MAX_PER_HOUR_ACCOUNT],
  ['accountDay', () => RESEND_MAX_PER_DAY_ACCOUNT],
  ['ipHour', () => RESEND_MAX_PER_HOUR_IP],
];

for (const [counter, limitOf] of RESEND_CEILINGS) {
  test(`a verification resend is refused when ${counter} has REACHED its limit, not after it passes one`, async () => {
    const limit = limitOf();
    assert.ok(Number.isInteger(limit) && limit > 1, `${counter} limit must be a usable integer`);

    // One below the ceiling: the link is issued.
    scriptResend({ [counter]: limit - 1 });
    const allowed = await call('POST', '/api/auth/resend-verification');
    assert.strictEqual(allowed.status, 200, allowed.text);
    assert.strictEqual(ran('INSERT INTO email_verifications').length, 1,
      `${counter} at ${limit - 1} must still be allowed, or the test below proves nothing`);

    // AT the ceiling: refused. `>` instead of `>=` answers 200 here and issues
    // a link the budget was written to withhold.
    scriptResend({ [counter]: limit });
    const refused = await call('POST', '/api/auth/resend-verification');
    assert.strictEqual(refused.status, 429, `${counter} at exactly ${limit} must be refused`);
    assert.strictEqual(ran('INSERT INTO email_verifications').length, 0,
      'a throttled resend must not mint a token either');
  });
}

test('the same IP ceiling is checked at SIGNUP, at the same boundary', async () => {
  // A second, separate `budget.ipHour >= RESEND_MAX_PER_HOUR_IP` lives on the
  // signup path, and it was the one the resend tests above do NOT reach: the
  // mutation sweep flipped it to `>` on its own and the whole 1413-test suite
  // stayed green. It decides whether a brand new account is mailed its link at
  // all, so the boundary is the difference between "the mail cannon is capped
  // at 30 an hour per IP" and "at 31".
  const signup = (ipHour) => {
    log = [];
    handlers = [
      [/FROM banned_identities/, () => ({ rows: [] })],
      [/^SELECT \* FROM users/, () => ({ rows: [] })],
      [/^INSERT INTO users/, (params) => ({
        rows: [{
          id: 77, email: params[0], name: params[2], phone: null, interests: [],
          role: 'user', profile_image_url: null, email_verified: false, created_at: new Date(),
        }],
      })],
      [/FROM email_verifications WHERE user_id/, () => ({
        rows: [{ account_hour: 0, account_day: 0, account_last: null, ip_hour: ipHour }],
      })],
      [/^UPDATE email_verifications SET used_at/, () => ({ rows: [], rowCount: 0 })],
      [/^INSERT INTO email_verifications/, () => ({ rows: [], rowCount: 1 })],
    ];
    return call('POST', '/api/auth/signup', {
      email: 'newbie@example.com', password: 'Password1', name: 'Newbie', date_of_birth: '2000-01-01',
    });
  };

  const under = await signup(RESEND_MAX_PER_HOUR_IP - 1);
  assert.strictEqual(under.status, 201, under.text);
  assert.strictEqual(ran('INSERT INTO email_verifications').length, 1,
    'one below the ceiling the signup still mints a link');

  const at = await signup(RESEND_MAX_PER_HOUR_IP);
  assert.strictEqual(at.status, 201, 'the account is still created — only the mail is withheld');
  assert.strictEqual(at.body.verificationSent, false);
  assert.strictEqual(ran('INSERT INTO email_verifications').length, 0,
    'at exactly the ceiling no token is minted and no mail is queued');
});

// ---------------------------------------------------------------------------
// B2. The password-reset request budget, at its exact ceiling
// ---------------------------------------------------------------------------
// Same shape, one file down. `budget.ipHour >= RESET_MAX_PER_HOUR_IP` is the
// operand that stops one IP spraying reset mail at addresses it does not own,
// and it was the one operand of the three with no test at its boundary.
//
// The observable is `INSERT INTO password_reset_requests`: the route records
// the attempt only AFTER the budget lets it through, and it does so whether or
// not the address has an account — which is the property that keeps this
// endpoint from answering "does this address exist".
// ---------------------------------------------------------------------------

function scriptForgot({ emailHour = 0, emailDay = 0, ipHour = 0, emailLast = null, accountRows = [] }) {
  log = [];
  handlers = [
    [/FROM password_reset_requests/, () => ({
      rows: [{ email_hour: emailHour, email_day: emailDay, email_last: emailLast, ip_hour: ipHour }],
    })],
    [/^INSERT INTO password_reset_requests/, () => ({ rows: [], rowCount: 1 })],
    // By default no account on this address: the neutral branch, so nothing is
    // mailed and the budget is the only thing under test.
    [/FROM users/, () => ({ rows: accountRows })],
    [/^UPDATE password_resets SET used_at/, () => ({ rows: [], rowCount: 0 })],
    [/^INSERT INTO password_resets/, () => ({ rows: [], rowCount: 1 })],
    [/^DELETE FROM password_reset_requests/, () => ({ rows: [], rowCount: 0 })],
  ];
}

const RESET_CEILINGS = [
  ['emailHour', () => RESET_MAX_PER_HOUR_EMAIL],
  ['emailDay', () => RESET_MAX_PER_DAY_EMAIL],
  ['ipHour', () => RESET_MAX_PER_HOUR_IP],
];

for (const [counter, limitOf] of RESET_CEILINGS) {
  test(`a password-reset request is refused when ${counter} has REACHED its limit`, async () => {
    const limit = limitOf();
    assert.ok(Number.isInteger(limit) && limit > 1);

    scriptForgot({ [counter]: limit - 1 });
    const allowed = await call('POST', '/api/auth/forgot-password', { email: 'nobody@example.com' });
    await flushResetMail();
    assert.strictEqual(allowed.status, 200, allowed.text);
    assert.strictEqual(ran('INSERT INTO password_reset_requests').length, 1,
      `${counter} at ${limit - 1} must still be allowed`);

    scriptForgot({ [counter]: limit });
    const refused = await call('POST', '/api/auth/forgot-password', { email: 'nobody@example.com' });
    await flushResetMail();
    assert.strictEqual(refused.status, 429, `${counter} at exactly ${limit} must be refused`);
    assert.strictEqual(ran('INSERT INTO password_reset_requests').length, 0);
  });
}

test('the throttled reset answers the same shape as the allowed one, minus the send', async () => {
  // The budget exists to stop a mail cannon, and it must not have become an
  // account-existence oracle on the way: the refusal is identical whether or
  // not the address has an account behind it.
  const bodies = [];
  for (const accountRows of [[], [{ id: 3, email: 'real@example.com', name: 'R' }]]) {
    scriptForgot({ ipHour: RESET_MAX_PER_HOUR_IP, accountRows });
    const res = await call('POST', '/api/auth/forgot-password', { email: 'real@example.com' });
    await flushResetMail();
    assert.strictEqual(res.status, 429);
    // The refusal now carries when it lifts, and `resetsAt` is an instant: two
    // calls a millisecond apart differ in it for reasons that have nothing to
    // do with the mailbox. Everything else must be byte-identical, so the
    // timestamp is normalised out rather than the comparison being weakened.
    // The window itself is safe to compare: it is read from a budget keyed on
    // the ADDRESS HASH, which counts the same for an address with no account.
    bodies.push(res.text.replace(/"resetsAt":"[^"]+"/, '"resetsAt":"<instant>"'));
    assert.strictEqual(ran('INSERT INTO password_resets').length, 0, 'nothing is minted for a throttled request');
  }
  assert.strictEqual(bodies[0], bodies[1], 'the refusal must not depend on whether the account exists');
  assert.match(bodies[0], /"retryAfterSeconds":/,
    'a refusal on the account-recovery path must say when it lifts');
});

// ---------------------------------------------------------------------------
// B3. A link is dead AT its expiry instant, not one millisecond after it
// ---------------------------------------------------------------------------
// `new Date(row.expires_at).getTime() <= Date.now()`. With `<` the tie goes to
// the token, and "expires at T" quietly means "works at T". The clock is
// frozen for the request so the tie is real and not a race — an unfrozen clock
// advances past expires_at between the fake answering and the comparison
// running, and both operators then agree, which is why no existing test
// distinguishes them.
// ---------------------------------------------------------------------------

async function atFrozenClock(fn) {
  const real = Date.now;
  const frozen = real();
  Date.now = () => frozen;
  try {
    return await fn(frozen);
  } finally {
    Date.now = real;
  }
}

test('a verification link is expired at the exact instant it expires', async () => {
  const minted = mintVerificationToken();
  const verificationRow = (expiresAt) => ({
    id: 11,
    user_id: 1,
    verifier_hash: minted.verifierHash,
    email: 'ava@example.com',
    used_at: null,
    expires_at: new Date(expiresAt),
    current_email: 'ava@example.com',
    email_verified: false,
  });

  await atFrozenClock(async (now) => {
    // expires_at === now. The link is gone.
    handlers = [[/FROM email_verifications v/, () => ({ rows: [verificationRow(now)] })]];
    const dead = await call('POST', '/api/auth/verify-email', { token: minted.token });
    assert.strictEqual(dead.status, 400, dead.text);
    assert.strictEqual(dead.body.reason, 'expired');
    assert.strictEqual(ran('UPDATE email_verifications').length, 0,
      'an expired link must not be spent, or a second click reports "used" instead of "expired"');

    // One millisecond of life left, and it still works — so the assertion
    // above is about the tie and not about the whole branch.
    handlers = [
      [/FROM email_verifications v/, () => ({ rows: [verificationRow(now + 1)] })],
      [/^UPDATE email_verifications SET used_at/, () => ({ rows: [{ id: 11 }], rowCount: 1 })],
      [/^UPDATE users SET email_verified = TRUE/, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    ];
    const alive = await call('POST', '/api/auth/verify-email', { token: minted.token });
    assert.strictEqual(alive.status, 200, alive.text);
  });
});

test('a password-reset link is expired at the exact instant it expires', async () => {
  const minted = mintVerificationToken();
  const resetRow = (expiresAt) => ({
    id: 12,
    user_id: 1,
    verifier_hash: minted.verifierHash,
    email: 'ava@example.com',
    used_at: null,
    expires_at: new Date(expiresAt),
    current_email: 'ava@example.com',
    oauth_provider: null,
    is_banned: false,
    has_password: true,
  });

  await atFrozenClock(async (now) => {
    handlers = [[/FROM password_resets r/, () => ({ rows: [resetRow(now)] })]];
    const dead = await call('POST', '/api/auth/reset-password/check', { token: minted.token });
    assert.strictEqual(dead.status, 200, dead.text);
    assert.strictEqual(dead.body.valid, false);
    assert.strictEqual(dead.body.reason, 'expired');

    handlers = [[/FROM password_resets r/, () => ({ rows: [resetRow(now + 1)] })]];
    const alive = await call('POST', '/api/auth/reset-password/check', { token: minted.token });
    assert.strictEqual(alive.body.valid, true, alive.text);
  });
});

// ---------------------------------------------------------------------------
// B3b. The two WHERE guards that only a race can reach
// ---------------------------------------------------------------------------
// `AND used_at IS NULL` on the verification claim, and `AND email_verified =
// FALSE` on the squat eviction. Both exist because the JS check above them
// happens on a row that was read a few milliseconds earlier, and both could be
// deleted from routes/auth.js without a test noticing — because every fake in
// the suite decides for itself whether the row matches, using a condition
// written in JavaScript next to the statement rather than read out of it.
//
// The evaluator below is the fix for that. It knows about `=`, `IS NULL` and
// `> NOW()`; it has never heard of used_at or email_verified, so it cannot
// supply a guard the route stopped emitting. Delete the clause from the source
// and the clause stops being enforced here, exactly as in Postgres.
// ---------------------------------------------------------------------------

function whereMatches(sql, row, params) {
  const at = sql.search(/\bWHERE\b/i);
  assert.ok(at >= 0, `statement has no WHERE at all: ${sql}`);
  const where = sql.slice(at + 5).replace(/\s+RETURNING\b[\s\S]*$/i, '').trim();
  return where.split(/\s+AND\s+/i).every((cond) => {
    const c = cond.trim();
    let m = /^(\w+)\s*=\s*\$(\d+)$/.exec(c);
    if (m) return String(row[m[1]]) === String(params[Number(m[2]) - 1]);
    m = /^(\w+)\s*=\s*(TRUE|FALSE)$/i.exec(c);
    if (m) return row[m[1]] === /^TRUE$/i.test(m[2]);
    m = /^(\w+)\s+IS\s+NULL$/i.exec(c);
    if (m) return row[m[1]] === null || row[m[1]] === undefined;
    m = /^(\w+)\s*>\s*NOW\(\)$/i.exec(c);
    if (m) return new Date(row[m[1]]).getTime() > Date.now();
    throw new Error(`the evaluator does not understand "${c}" — teach it rather than skipping it`);
  });
}

test('a verification link spent by a racing click cannot be spent again', async () => {
  // Both requests read the row while used_at was still NULL, so the JS check
  // above the claim passes in both. The database decides, and it decides with
  // `AND used_at IS NULL`. Without that clause the loser of the race also
  // succeeds, and a single-use link has been used twice.
  const minted = mintVerificationToken();
  const row = {
    id: 21, user_id: 1, verifier_hash: minted.verifierHash, email: 'ava@example.com',
    used_at: null, expires_at: new Date(Date.now() + 3600e3),
    current_email: 'ava@example.com', email_verified: false,
  };

  log = [];
  handlers = [
    [/FROM email_verifications v/, () => {
      const snapshot = { ...row };
      row.used_at = new Date(); // the other click lands between the read and the claim
      return { rows: [snapshot] };
    }],
    [/^UPDATE email_verifications SET used_at/, (params, sql) => {
      const hit = whereMatches(sql, row, params);
      return { rows: hit ? [{ id: row.id }] : [], rowCount: hit ? 1 : 0 };
    }],
    [/^UPDATE users SET email_verified = TRUE/, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ];

  const res = await call('POST', '/api/auth/verify-email', { token: minted.token });
  assert.strictEqual(res.status, 400, res.text);
  assert.strictEqual(res.body.reason, 'used');
  assert.strictEqual(ran('UPDATE users SET email_verified = TRUE').length, 0,
    'the loser of the race must not verify the account a second time');
});

test('the expiry that decides is the database clock, not this process\'s', async () => {
  // The TTL is written as `NOW() + interval` by Postgres, so the row's lifetime
  // is measured on the database clock — and `AND expires_at > NOW()` is the
  // only check that consults it. The JS guard above compares against THIS
  // machine's clock, which on a container that has drifted (or simply during a
  // request slow enough to straddle the boundary) says the link is still good.
  // Drop the SQL clause and a link the database considers dead is accepted.
  const minted = mintVerificationToken();
  const row = {
    id: 22, user_id: 1, verifier_hash: minted.verifierHash, email: 'ava@example.com',
    used_at: null,
    expires_at: new Date(Date.now() - 1000), // the database's truth: already gone
    current_email: 'ava@example.com', email_verified: false,
  };

  log = [];
  handlers = [
    // What a drifted app clock reads off the same row: still an hour of life.
    [/FROM email_verifications v/, () => ({ rows: [{ ...row, expires_at: new Date(Date.now() + 3600e3) }] })],
    [/^UPDATE email_verifications SET used_at/, (params, sql) => {
      const hit = whereMatches(sql, row, params);
      return { rows: hit ? [{ id: row.id }] : [], rowCount: hit ? 1 : 0 };
    }],
    [/^UPDATE users SET email_verified = TRUE/, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
  ];

  const res = await call('POST', '/api/auth/verify-email', { token: minted.token });
  assert.strictEqual(res.status, 400, res.text);
  assert.strictEqual(ran('UPDATE users SET email_verified = TRUE').length, 0,
    'a link the database has already retired must not verify anything');
});

test('a squat that verifies itself mid-request is not evicted', async () => {
  // The address was unverified when claimDecision read it, so this request is
  // on the eviction path. By the time the UPDATE runs the row has proved the
  // address, and `AND email_verified = FALSE` is the only thing standing
  // between a now-legitimate account and losing its email to someone else.
  const squat = {
    id: 42, email: 'victim@gmail.com', email_verified: false, oauth_provider: null,
    is_banned: false, verified_email: null, password: 'hash', date_of_birth: '2000-01-01',
  };

  log = [];
  handlers = [
    [/FROM banned_identities/, () => ({ rows: [] })],
    // Nobody has signed in with this Google identity before.
    [/oauth_provider = 'google' AND oauth_id/, () => ({ rows: [] })],
    // The canonical address lookup — the read claimDecision judges.
    [/^SELECT \* FROM users WHERE/, () => {
      const snapshot = { ...squat };
      squat.email_verified = true; // they clicked their link while this request was in flight
      return { rows: [snapshot] };
    }],
    [/^UPDATE users SET email = \$1/, (params, sql) => {
      const hit = whereMatches(sql, squat, params);
      return { rows: hit ? [{ id: squat.id }] : [], rowCount: hit ? 1 : 0 };
    }],
    [/^UPDATE email_verifications SET used_at/, () => ({ rows: [], rowCount: 0 })],
    [/^INSERT INTO users/, () => ({ rows: [{ id: 99, email: 'victim@gmail.com' }] })],
  ];

  const profile = { sub: 'g-race', email: 'victim@gmail.com', email_verified: true, name: 'Owner' };
  const realFetch = global.fetch;
  global.fetch = (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ aud: process.env.GOOGLE_CLIENT_ID }) });
    }
    if (u.startsWith('https://openidconnect.googleapis.com/')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => profile });
    }
    return realFetch(url, opts);
  };
  let res;
  try {
    res = await call('POST', '/api/auth/google', { access_token: 'opaque', date_of_birth: '2000-01-01' });
  } finally {
    global.fetch = realFetch;
  }

  assert.strictEqual(res.status, 409, `a lost race is a retry, not a displacement: ${res.text}`);
  assert.strictEqual(ran('INSERT INTO users').length, 0,
    'and no second account is created on an address the first one still holds');
});

// ---------------------------------------------------------------------------
// B4. The budget constants themselves
// ---------------------------------------------------------------------------
// Every boundary above is written against the exported constant rather than a
// literal, which is the right way round — but it also means all six tests
// would still pass if a limit were raised to a number that makes the budget
// meaningless. These are the values the tests are meaningful at.
// ---------------------------------------------------------------------------

test('the send budgets are still small enough to be budgets', () => {
  assert.deepStrictEqual(
    {
      RESEND_MAX_PER_HOUR_ACCOUNT,
      RESEND_MAX_PER_DAY_ACCOUNT,
      RESEND_MAX_PER_HOUR_IP,
      RESET_MAX_PER_HOUR_EMAIL,
      RESET_MAX_PER_DAY_EMAIL,
      RESET_MAX_PER_HOUR_IP,
    },
    {
      RESEND_MAX_PER_HOUR_ACCOUNT: 5,
      RESEND_MAX_PER_DAY_ACCOUNT: 10,
      RESEND_MAX_PER_HOUR_IP: 30,
      RESET_MAX_PER_HOUR_EMAIL: 3,
      RESET_MAX_PER_DAY_EMAIL: 6,
      RESET_MAX_PER_HOUR_IP: 20,
    }
  );
  // The per-account ceilings have to sit under the per-IP one, or the account
  // limit is decoration: one account on one IP would hit the IP wall first.
  assert.ok(RESEND_MAX_PER_HOUR_ACCOUNT < RESEND_MAX_PER_HOUR_IP);
  assert.ok(RESET_MAX_PER_HOUR_EMAIL < RESET_MAX_PER_HOUR_IP);
  // And the hourly ceilings under the daily ones, same reason.
  assert.ok(RESEND_MAX_PER_HOUR_ACCOUNT < RESEND_MAX_PER_DAY_ACCOUNT);
  assert.ok(RESET_MAX_PER_HOUR_EMAIL < RESET_MAX_PER_DAY_EMAIL);
});

// ---------------------------------------------------------------------------
// B5. The age gate, at exactly the age it is set to
// ---------------------------------------------------------------------------
// `if (age < MIN_AGE)`. utils/age.js is well tested and age.test.js pins
// "the 13th birthday returns 13", but nothing signed a 13-year-old up through
// the ROUTE, so `<` could become `<=` and the app would refuse the exact
// audience floor the product is built around. There is no error a 13-year-old
// could report that would tell anyone why.
// ---------------------------------------------------------------------------

test('someone who is exactly MIN_AGE today can sign up; a day younger cannot', async () => {
  const { MIN_AGE } = require('../utils/age');
  const today = new Date();
  const dob = (years, dayOffset = 0) => {
    const d = new Date(today.getFullYear() - years, today.getMonth(), today.getDate() + dayOffset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const attempt = (date_of_birth) => {
    log = [];
    handlers = [
      [/FROM banned_identities/, () => ({ rows: [] })],
      [/^SELECT \* FROM users/, () => ({ rows: [] })],
      [/^INSERT INTO users/, (params) => ({
        rows: [{
          id: 88, email: params[0], name: params[2], phone: null, interests: [],
          role: 'user', profile_image_url: null, email_verified: false, created_at: new Date(),
        }],
      })],
      [/FROM email_verifications WHERE user_id/, () => ({
        rows: [{ account_hour: 0, account_day: 0, account_last: null, ip_hour: 0 }],
      })],
      [/^UPDATE email_verifications SET used_at/, () => ({ rows: [], rowCount: 0 })],
      [/^INSERT INTO email_verifications/, () => ({ rows: [], rowCount: 1 })],
    ];
    return call('POST', '/api/auth/signup', {
      email: 'teen@example.com', password: 'Password1', name: 'Teen', date_of_birth,
    });
  };

  // Their MIN_AGE-th birthday is today.
  const onTheDay = await attempt(dob(MIN_AGE));
  assert.strictEqual(onTheDay.status, 201, `a ${MIN_AGE}-year-old must be able to sign up: ${onTheDay.text}`);
  assert.strictEqual(ran('INSERT INTO users').length, 1);

  // One day short of it.
  const dayEarly = await attempt(dob(MIN_AGE, 1));
  assert.strictEqual(dayEarly.status, 403, 'a day under the floor is still under the floor');
  assert.strictEqual(ran('INSERT INTO users').length, 0, 'and no row is created for them');
});

// ---------------------------------------------------------------------------
// B6. canonicalEmail and the one-character local part
// ---------------------------------------------------------------------------
// `if (at < 1) return trimmed.toLowerCase();` — the early return for "no @, or
// an @ at position 0". With `<=` it also swallows every address whose local
// part is ONE character, which then skips the googlemail -> gmail folding. The
// canonical form is what every duplicate-account and squat check compares on,
// so an address that stops folding is an address that can hold two accounts.
// ---------------------------------------------------------------------------

test('a one-character local part is still canonicalized', () => {
  const { canonicalEmail } = authRouter.__testing;
  assert.strictEqual(canonicalEmail('A@GoogleMail.com'), 'a@gmail.com');
  assert.strictEqual(canonicalEmail('a@gmail.com'), 'a@gmail.com');
  // Two characters already worked; this is the pair the bound sits between.
  assert.strictEqual(canonicalEmail('a.b@googlemail.com'), 'ab@gmail.com');
  // And the branch the early return is actually for still behaves.
  assert.strictEqual(canonicalEmail('@gmail.com'), '@gmail.com');
  assert.strictEqual(canonicalEmail('nope'), 'nope');
});

// ===========================================================================
// PART C — routes/billing.js
// ===========================================================================
// Money arithmetic the sweep could change without a test noticing, and three
// authorization branches that had no test at all.
//
// The fake answers the reads and records the writes. It never computes a
// share, so nothing below can be satisfied by this file.
// ---------------------------------------------------------------------------

const membersOf = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `M${i + 1}` }));

function scriptBill({
  members = membersOf(3),
  creatorId = 1,
  existingBill = [],
  existingShares = [],
} = {}) {
  log = [];
  handlers = [
    [/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ id: 9 }] })],
    [/SELECT u\.id, u\.name FROM flock_members/, () => ({ rows: members })],
    [/FROM user_blocks/, () => ({ rows: [] })],
    [/SELECT name, creator_id FROM flocks/, () => ({ rows: [{ name: 'Dinner', creator_id: creatorId }] })],
    [/SELECT id FROM flocks WHERE id = \$1/, () => ({ rows: [{ id: 42 }] })],
    [/SELECT id, paid_by FROM bill_splits/, () => ({ rows: existingBill })],
    [/SELECT user_id, .*FROM bill_split_shares/, () => ({ rows: existingShares })],
    [/INSERT INTO bill_splits/, () => ({ rows: [{ id: 7 }] })],
    [/DELETE FROM bill_split_shares/, () => ({ rows: [], rowCount: 0 })],
    [/INSERT INTO bill_split_shares/, () => ({ rows: [] })],
  ];
}

const createBill = (body) => call('POST', '/api/billing/42/create', body);

test('the tip is applied to the nearest cent, not truncated', async () => {
  // `Math.round(billTotal * (1 + tipPct / 100) * 100) / 100`. Every existing
  // fixture picks a total and tip whose product is already whole cents, so
  // Math.floor here changed nothing anywhere in the suite. It is a cent off the
  // bill, every time the product has a fraction — and the shares are divided
  // against the wrong number, so the sheet is internally consistent and wrong.
  const cases = [
    { totalAmount: 33.33, tipPercent: 18, totalWithTip: 39.33 },  // 39.3294
    { totalAmount: 19.99, tipPercent: 15, totalWithTip: 22.99 },  // 22.9885
    { totalAmount: 47.77, tipPercent: 22, totalWithTip: 58.28 },  // 58.2794
  ];
  for (const c of cases) {
    scriptBill();
    const res = await createBill({ totalAmount: c.totalAmount, tipPercent: c.tipPercent });
    assert.strictEqual(res.status, 201, res.text);
    assert.strictEqual(res.body.bill.totalWithTip, c.totalWithTip, JSON.stringify(c));
    const cents = res.body.bill.shares.reduce((a, s) => a + Math.round(s.amount * 100), 0);
    assert.strictEqual(cents, Math.round(c.totalWithTip * 100), 'and the shares add up to it');
  }
});

test('a custom share is read to the nearest cent, not truncated', async () => {
  // `cents: Math.round(parseFloat(s.amount) * 100)`. A client that computes a
  // share by dividing (or a venue receipt with three decimals) sends fractions
  // of a cent; truncating them turns a balanced bill into one that needs a cent
  // absorbed, and moves the absorbed cent onto a different person.
  scriptBill();
  const res = await createBill({
    totalAmount: 100,
    splitType: 'custom',
    customShares: [{ userId: 1, amount: 50.005 }, { userId: 2, amount: 49.995 }],
  });
  assert.strictEqual(res.status, 201, res.text);
  // 50.005 -> 5001c and 49.995 -> 5000c, one cent over, absorbed off the
  // largest. Truncating reads 5000/4999 and answers 50.01 / 49.99 instead.
  assert.deepStrictEqual(res.body.bill.shares.map((s) => s.amount), [50, 50]);
});

test('the total a custom split is checked against is the bill, not a cent under it', async () => {
  // The custom branch re-derives `totalCents` from `totalWithTip`, and roughly
  // one bill total in eight is a value whose ×100 lands JUST BELOW its integer
  // in binary floating point ($1.13 × 100 is 112.99999999999999). Truncating
  // there makes the bill a cent smaller than it is: shares that add up exactly
  // are declared a cent over, and one of them is quietly reduced.
  //
  // The dollar amounts here are small on purpose — this is the arithmetic, not
  // the size of the bill — and they are the smallest ones that show it.
  // $1.13 lands BELOW (112.99999999999999) and $1.11 lands ABOVE
  // (111.00000000000001), so the pair rules out truncating in either
  // direction. In both cases the shares already add up and must be untouched.
  const cases = [
    { totalAmount: 1.13, shares: [0.57, 0.56] },
    { totalAmount: 1.11, shares: [0.55, 0.56] },
  ];
  for (const c of cases) {
    scriptBill();
    const res = await createBill({
      totalAmount: c.totalAmount,
      splitType: 'custom',
      customShares: [{ userId: 1, amount: c.shares[0] }, { userId: 2, amount: c.shares[1] }],
    });
    assert.strictEqual(res.status, 201, res.text);
    assert.deepStrictEqual(res.body.bill.shares.map((s) => s.amount), c.shares,
      `$${c.totalAmount}: shares that already add up must be left alone`);
    const sum = res.body.bill.shares.reduce((a, s) => a + Math.round(s.amount * 100), 0);
    assert.strictEqual(sum, Math.round(res.body.bill.totalWithTip * 100), `$${c.totalAmount}`);
  }
});

test('the bill-created push names the flock, not the word "Flock"', async () => {
  // `flockResult.rows[0]?.name || 'Flock'` is a fallback for a flock with no
  // name. Nothing asserted the non-fallback side, so the expression could be
  // changed to always take the fallback and every debtor would be told they
  // owe money "for Flock".
  scriptBill();
  const res = await createBill({ totalAmount: 90 });
  assert.strictEqual(res.status, 201, res.text);

  assert.ok(pushes.length > 0, 'the debtors are notified');
  for (const p of pushes) {
    assert.match(p.body, /for Dinner$/, `push body should name the flock: ${p.body}`);
    assert.strictEqual(p.data.type, 'bill_created');
  }
  // The payer is not told they owe themselves.
  assert.deepStrictEqual(pushes.map((p) => p.userId).sort(), [2, 3]);
});

test('a member who owes nothing can be given a zero share', async () => {
  // `if (parsed.some(s => ... || s.cents < 0))`. With `<= 0` the designated
  // driver who ordered nothing cannot be put on the bill at all, and the error
  // says their amount is invalid.
  scriptBill();
  const res = await createBill({
    totalAmount: 100,
    splitType: 'custom',
    customShares: [{ userId: 1, amount: 100 }, { userId: 2, amount: 0 }],
  });
  assert.strictEqual(res.status, 201, res.text);
  assert.deepStrictEqual(res.body.bill.shares.map((s) => s.amount), [100, 0]);
});

test('when two shares tie for largest, the absorbed cent has one settled owner', async () => {
  // `if (parsed[i].cents > parsed[biggest].cents)`. With `>=` the last of the
  // tied shares absorbs instead of the first. Either rule is defensible; having
  // no rule is not, because re-saving the same bill would move a cent between
  // two people and neither would know why.
  scriptBill();
  const res = await createBill({
    totalAmount: 100.01,
    splitType: 'custom',
    customShares: [{ userId: 1, amount: 50 }, { userId: 2, amount: 50 }],
  });
  assert.strictEqual(res.status, 201, res.text);
  assert.deepStrictEqual(res.body.bill.shares.map((s) => s.amount), [50.01, 50],
    'the FIRST of the tied shares takes the cent, every time');
});

test('an empty custom-share list is an equal split, and is recorded as one', async () => {
  // `customShares.length > 0` decides which branch runs. With `>= 0` an empty
  // array takes the custom branch, whose sum is 0 against the bill total — so
  // a client that sends `splitType: 'custom'` before the user has typed
  // anything gets a 400 instead of the sensible default.
  //
  // What it RECORDS is the branch it ran (money audit 2026-09-04). The guard
  // above decided the arithmetic and the UPSERT then wrote the requested split
  // type whatever the arithmetic had been, so this bill was stored as 'custom'
  // over three identical $30 shares nobody had typed. GET /:flockId serves that
  // column back as the split type the client renders, so the sheet offered to
  // edit amounts the payer had never chosen and the record of how the bill was
  // actually divided was wrong on a row nobody would think to doubt.
  scriptBill();
  const res = await createBill({ totalAmount: 90, splitType: 'custom', customShares: [] });
  assert.strictEqual(res.status, 201, res.text);
  assert.deepStrictEqual(res.body.bill.shares.map((s) => s.amount), [30, 30, 30]);
  assert.strictEqual(res.body.bill.splitType, 'equal',
    'the 201 body claims three identical shares were typed by hand');
  // [flockId, billTotal, splitType, payerId, tipPct]
  const upsert = ran('INSERT INTO bill_splits')[0];
  assert.ok(upsert, 'the upsert never ran');
  assert.strictEqual(upsert.params[2], 'equal',
    'bill_splits.split_type says custom over a split the route made itself');
});

test('a split the payer really did type is still recorded as custom', async () => {
  // The other side of the same rule: effectiveSplit must not flatten every bill
  // to 'equal'. These amounts were typed, they are not an even division of $90,
  // and the column has to say so.
  scriptBill();
  const res = await createBill({
    totalAmount: 90,
    splitType: 'custom',
    customShares: [{ userId: 1, amount: 50 }, { userId: 2, amount: 25 }, { userId: 3, amount: 15 }],
  });
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(res.body.bill.splitType, 'custom');
  assert.strictEqual(ran('INSERT INTO bill_splits')[0].params[2], 'custom');
});

// ---------------------------------------------------------------------------
// C2. The three authorization branches
// ---------------------------------------------------------------------------
// Each is an `&&` of two conditions, and swapping either for `||` broke no
// test. The reason is that only ONE side of each branch had a fixture: the
// refusals were covered and the permissions were not, or the other way round.
// ---------------------------------------------------------------------------

test('a ghost-commit shell belongs to nobody, so the payer can still open the bill', async () => {
  // paid_by NULL means no one has claimed the bill. Round 7 fixed this branch
  // rejecting every legitimate first payer, and then nothing pinned it.
  CURRENT_USER = { id: 2, name: 'Ben', role: 'user' };
  scriptBill({ creatorId: 1, existingBill: [{ id: 5, paid_by: null }] });
  const own = await createBill({ totalAmount: 60, paidBy: 2 });
  assert.strictEqual(own.status, 201, `the payer may claim a ghost shell: ${own.text}`);

  // ...and a member who is neither the payer nor the flock creator may not
  // assign the debt to someone else.
  CURRENT_USER = { id: 3, name: 'Cy', role: 'user' };
  scriptBill({ creatorId: 1, existingBill: [{ id: 5, paid_by: null }] });
  const other = await createBill({ totalAmount: 60, paidBy: 2 });
  assert.strictEqual(other.status, 403, 'a bystander cannot name someone else as payer');
  assert.strictEqual(ran('INSERT INTO bill_splits').length, 0);
});

test('the flock creator can rewrite a bill someone else opened', async () => {
  // `userId !== prevPayer && userId !== flockCreatorId`. The refusal (a third
  // member) was covered; the permission (the creator) was not, so `||` would
  // have locked the creator out of the bill they are meant to be able to fix.
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  scriptBill({ creatorId: 1, existingBill: [{ id: 5, paid_by: 2 }] });
  const asCreator = await createBill({ totalAmount: 60, paidBy: 2 });
  assert.strictEqual(asCreator.status, 201, `the flock creator may fix the bill: ${asCreator.text}`);

  CURRENT_USER = { id: 3, name: 'Cy', role: 'user' };
  scriptBill({ creatorId: 1, existingBill: [{ id: 5, paid_by: 2 }] });
  const asBystander = await createBill({ totalAmount: 60, paidBy: 2 });
  assert.strictEqual(asBystander.status, 403);
});

test('a settled debt survives a payer change, and keeps the time it was settled', async () => {
  // Two clauses in one line, neither pinned:
  //   `if (row.user_id === prevPayer && prevPayer !== payerId) continue;`
  //     — drops ONLY the former payer's auto-settled flag. With `||` every
  //       settled row is dropped on any payer change, so a debt someone
  //       actually paid is re-issued.
  //   `existingSettled.set(row.user_id, row.settled_at || new Date())`
  //     — with `&&` the ORIGINAL settlement time is replaced by now, so the
  //       receipt says the debt was paid at the moment the bill was edited.
  const paidAt = new Date('2026-08-01T18:30:00Z');
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  // The rows carry their amounts because the route now decides a settled
  // row's fate from what it paid (bill_split_shares.amount and paid_amount,
  // migration 061), not from the flag alone: a settled row whose amount
  // cannot be read is a row the route will not vouch for, and it is skipped
  // rather than carried. A real DECIMAL column never hands back undefined, so
  // this is only the fixture catching up with the SELECT list money.test.js
  // pins. $90 three ways is $30 each, and Cy paid his.
  scriptBill({
    creatorId: 1,
    existingBill: [{ id: 5, paid_by: 1 }],
    existingShares: [
      { user_id: 1, committed: false, settled: true, settled_at: new Date(), amount: '30.00' }, // Ava, payer
      { user_id: 3, committed: false, settled: true, settled_at: paidAt, amount: '30.00' },     // Cy, really paid
      { user_id: 2, committed: false, settled: false, settled_at: null, amount: '30.00' },
    ],
  });

  const res = await createBill({ totalAmount: 90, paidBy: 2 }); // hand the bill to Ben
  assert.strictEqual(res.status, 201, res.text);

  const by = Object.fromEntries(res.body.bill.shares.map((s) => [s.userId, s]));
  assert.strictEqual(by[1].settled, false, 'the former payer now owes the new one');
  assert.strictEqual(by[2].settled, true, 'the new payer fronted the money');
  assert.strictEqual(by[3].settled, true, 'a debt Cy actually paid is NOT re-issued');

  // The INSERT carries Cy's original settled_at, not the moment of the edit.
  const cyRow = ran('INSERT INTO bill_split_shares').find((q) => q.params[1] === 3);
  assert.ok(cyRow, 'Cy is written back');
  assert.strictEqual(new Date(cyRow.params[5]).getTime(), paidAt.getTime(),
    'editing a bill must not restamp when a debt was paid');
});

// A guard on this file itself: `crypto` is imported for token minting, and an
// unused import here would mean a fixture stopped exercising what it claims to.
assert.strictEqual(typeof crypto.createHash, 'function');
