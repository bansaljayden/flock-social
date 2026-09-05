// Run: node --test  (from backend/)
//
// TASKS.md section B3 leftovers, closed 2026-08-14. Each block pins one item's
// verdict so the closed state cannot silently reopen:
//
//   B3-2 (STALE LINE): "crowd.js hour window clamps at 0 and 23" was already
//        fixed — feedbackWindow works on the 168-hour (day, hour) week with
//        modular arithmetic. paidCallBudgets.test.js pins the values; the pin
//        here is the property the task line was about: hour-23 reports and
//        hour-0 reads share a window, across the weekday boundary.
//
//   B3-3: middleware/auth.js now EXPORTS its token-version helpers, and the
//        two former reimplementations (sockets/handlers.js tokenVersionOf,
//        routes/checkin.js tryAuth's inline comparison) import them instead of
//        carrying copies. Pinned two ways: the semantics of the shared rule,
//        and source checks that neither file re-grows a private copy.
//
//   B3-4 (DECISION): POST /api/feedback stays OFF UNVERIFIED_DENY. Unverified
//        rows never move a public number (every reader filters verified=true),
//        and an email-unverified account cannot reach verified=true through
//        the flock leg BECAUSE the deny list blocks flock create/join/invite —
//        so the decision is only sound while those entries stay listed. Both
//        halves are pinned together.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const authMod = require('../middleware/auth');
const { tokenVersionOf, issuedTokenVersion, currentTokenVersion } = authMod;
const { unverifiedBlocked } = authMod.__testing;
const { evaluateSession } = require('../sockets/handlers');
const crowdRouter = require('../routes/crowd');
const { feedbackWindow } = crowdRouter.__testables;

// --- B3-2: hour window wraps instead of clamping ---------------------------

test('B3-2: an hour-23 report and an hour-0 read share a window across the day boundary', () => {
  // The window AROUND Friday 23:00 includes Saturday 00:00 …
  assert.deepStrictEqual(feedbackWindow(5, 23), [[5, 22], [5, 23], [6, 0]]);
  // … and the window AROUND Saturday 00:00 includes Friday 23:00, so the two
  // buckets are mutually reachable — the exact pair the old GREATEST/LEAST
  // clamp severed.
  assert.deepStrictEqual(feedbackWindow(6, 0), [[5, 23], [6, 0], [6, 1]]);
  // Week seam: Saturday 23:00 reaches Sunday 00:00 and vice versa.
  assert.deepStrictEqual(feedbackWindow(6, 23), [[6, 22], [6, 23], [0, 0]]);
  assert.deepStrictEqual(feedbackWindow(0, 0), [[6, 23], [0, 0], [0, 1]]);
});

test('B3-2: no window computation in crowd.js clamps at the day edge any more', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'routes', 'crowd.js'), 'utf8');
  // The old shape was `hour BETWEEN GREATEST(0, h-1) AND LEAST(23, h+1)`.
  // Every feedback lookup now goes through feedbackWindow; none may clamp.
  // Line comments are stripped first: the fix's own comment quotes the old
  // shape as history, and that quotation must not satisfy this pin.
  const src = raw.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
  assert.ok(!/GREATEST\s*\(\s*0\s*,/.test(src), 'a GREATEST(0, …) clamp is back in crowd.js');
  assert.ok(!/LEAST\s*\(\s*23\s*,/.test(src), 'a LEAST(23, …) clamp is back in crowd.js');
  // All three feedback reads key on (day_of_week, hour) tuples, the shape
  // feedbackWindow emits.
  const tupleReads = src.match(/\(day_of_week, hour\) IN/g) || [];
  assert.strictEqual(tupleReads.length, 3, 'the three inline feedback reads (two in the alternatives route, one in its calm shortcut) key on (day, hour) tuples');
  assert.ok(src.includes('unnest($1::text[], $2::int[], $3::int[])'),
    'the batch feedback read keys on per-venue (place, day, hour) tuples');
});

// --- B3-3: one token-version rule, exported and shared ----------------------

test('B3-3: tokenVersionOf semantics — a missing or non-integer version reads as 0', () => {
  assert.strictEqual(tokenVersionOf(0), 0);
  assert.strictEqual(tokenVersionOf(3), 3);
  assert.strictEqual(tokenVersionOf(undefined), 0);
  assert.strictEqual(tokenVersionOf(null), 0);
  assert.strictEqual(tokenVersionOf('3'), 0); // a string is not a version
  assert.strictEqual(tokenVersionOf(1.5), 0);
  assert.strictEqual(tokenVersionOf(NaN), 0);
});

test('B3-3: issued/current are the same rule applied to claim and row', () => {
  assert.strictEqual(issuedTokenVersion({ tv: 4 }), 4);
  assert.strictEqual(issuedTokenVersion({}), 0);
  assert.strictEqual(issuedTokenVersion(undefined), 0);
  assert.strictEqual(currentTokenVersion({ token_version: 4 }), 4);
  assert.strictEqual(currentTokenVersion({}), 0);
  assert.strictEqual(currentTokenVersion(undefined), 0);
});

test('B3-3: the socket revalidation verdict agrees with the middleware rule on every value shape', () => {
  // Mutation-equivalence check: for a matrix of claim/row value shapes, the
  // live-socket verdict must be revoked exactly when the middleware's own
  // comparison says the versions differ. If handlers.js ever re-grows a local
  // rule that drifts (e.g. treats a missing claim as a mismatch), a legacy
  // token with no tv claim on a version-0 row flips this matrix.
  const values = [undefined, 0, 1, 2, '1', 1.5];
  for (const tv of values) {
    for (const rowVersion of values) {
      const decoded = tv === undefined ? {} : { tv };
      const row = { id: 1, is_banned: false, token_version: rowVersion };
      const expectRevoked = issuedTokenVersion(decoded) !== currentTokenVersion(row);
      assert.strictEqual(
        evaluateSession(decoded, row),
        expectRevoked ? 'session_revoked' : null,
        `tv=${String(tv)} row=${String(rowVersion)}`
      );
    }
  }
});

test('B3-3: neither former call site carries a private copy of the comparison', () => {
  const handlersSrc = fs.readFileSync(path.join(__dirname, '..', 'sockets', 'handlers.js'), 'utf8');
  const checkinSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'checkin.js'), 'utf8');

  assert.ok(!/function tokenVersionOf/.test(handlersSrc),
    'sockets/handlers.js defines its own tokenVersionOf again');
  assert.match(handlersSrc, /require\('\.\.\/middleware\/auth'\)/);
  assert.ok(/\btokenVersionOf\b/.test(handlersSrc.split('\n').find((l) => l.includes("require('../middleware/auth')"))),
    'sockets/handlers.js must import tokenVersionOf from middleware/auth');

  assert.ok(!/Number\.isInteger\(decoded\?\.tv\)/.test(checkinSrc),
    'routes/checkin.js re-implements the missing-claim rule inline again');
  assert.ok(/issuedTokenVersion|tokenVersionOf/.test(checkinSrc.split('\n').find((l) => l.includes("require('../middleware/auth')"))),
    'routes/checkin.js must import the version helpers from middleware/auth');
  assert.match(checkinSrc, /issuedTokenVersion\(decoded\) !== currentTokenVersion\(row\)/,
    'tryAuth compares with the shared helpers');
});

// --- B3-4: POST /api/feedback stays off UNVERIFIED_DENY — pinned with its premise

function gateReq(method, baseUrl, reqPath = '/') {
  return { method, baseUrl, path: reqPath };
}

test('B3-4: an unverified account may still submit post-hangout feedback', () => {
  assert.strictEqual(unverifiedBlocked(gateReq('POST', '/api/feedback')), false,
    'POST /api/feedback must not be on UNVERIFIED_DENY — see the decision note above the list');
});

test('B3-4: the premise holds — the flock leg to verified=true stays denied to unverified accounts', () => {
  // The feedback decision is only sound while an unverified account cannot
  // manufacture the flock-membership evidence VERIFIED_PRESENCE_SQL accepts.
  // If any of these come off the list, the feedback decision must be re-made.
  assert.strictEqual(unverifiedBlocked(gateReq('POST', '/api/flocks')), true);
  assert.strictEqual(unverifiedBlocked(gateReq('POST', '/api/flocks', '/42/join')), true);
  assert.strictEqual(unverifiedBlocked(gateReq('POST', '/api/flocks', '/42/invite')), true);
  assert.strictEqual(unverifiedBlocked(gateReq('POST', '/api/flocks', '/42/invite-link')), true);
});
