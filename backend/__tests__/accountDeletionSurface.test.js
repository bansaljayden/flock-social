'use strict';
// ---------------------------------------------------------------------------
// WHAT DELETION TAKES, WHAT IT LEAVES, AND WHETHER WE SAY SO.
// ---------------------------------------------------------------------------
//
// DELETE /api/users/me is the one call in this API that cannot be apologised
// for. It either removed something it should have kept, or it kept something it
// swore it removed, and both are discovered too late. Two tests already guard
// pieces of this and it is worth being precise about how much they prove:
//
//   migrationBootSafety "deleting an account leaves nothing of that account
//   behind" runs a raw DELETE FROM users and checks two tables,
//   dm_pinned_venues and dm_venue_votes. It proves those two cascade. It does
//   not sweep the schema and its name is broader than its body.
//
//   migrationBootSafety "no table with a user-identifying column is left
//   without a foreign key" sweeps the catalog for columns NAMED like a user id
//   and requires a foreign key to users. It catches the next `owner_id INTEGER`
//   written with no constraint. It says nothing about the DELETE ACTION on that
//   key, so a SET NULL that quietly leaves the row passes it, and it says
//   nothing about a table that identifies a person by their EMAIL ADDRESS
//   rather than by their id, which is how both of the survivors this file
//   found came to be undisclosed.
//
// So this file asks the three questions those two do not:
//
//   1. Can deletion FAIL on a constraint? Every foreign key to users must be
//      CASCADE or SET NULL. One RESTRICT and the most destructive call in the
//      API starts answering 500 to a user who has already typed DELETE.
//   2. What SURVIVES, exactly? The SET NULL keys and the tables that identify a
//      person without a foreign key are the whole survivor set, and each one is
//      named here with what it is. A new one has to be added deliberately, and
//      adding it means answering whether the delete-account page says so.
//   3. Is the EXPORT still complete? Every column on `users` is either in the
//      export SELECT or in a list of deliberate omissions with a reason. That
//      is what would have caught phone_discoverable, which migration 051 added
//      as a consent record and which nothing put in the export.
//
// Plus the copy check: the account-deletion page must name every survivor a
// reader could have. It said "three things survive" while the privacy policy
// named more, including a plaintext email address kept with no expiry.
//
// This boots the repo's embedded Postgres because the delete action on a
// foreign key is a property of the catalog, not of a string in a .sql file.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Pool } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('./helpers/embeddedPgPort');

const PG_PORT = pickEmbeddedPgPort('accountDeletionSurface');
const REPO = path.join(__dirname, '..', '..');
const USERS_ROUTE = fs.readFileSync(path.join(__dirname, '..', 'routes', 'users.js'), 'utf8');
const DELETE_PAGE = fs.readFileSync(
  path.join(REPO, 'frontend', 'src', 'website', 'DeleteAccount.js'), 'utf8'
);

let pg;
let pool;
let dataDir;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), 'flock-deletionsurface-pg-' + Date.now());
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'accountDeletionSurface', port: PG_PORT, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase('flock_deletion_surface');
  pool = new Pool({
    connectionString: `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_deletion_surface`,
  });
  const { migrate } = require('../db/migrate');
  await migrate(pool);
});

test.after(async () => {
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  // Swallowed on purpose. On Windows the postmaster's file handles outlive
  // pg.stop() by a moment, so rmSync throws EPERM often enough to turn a suite
  // whose assertions all passed into a red file, which is what happened to
  // migrationSearchPath in the run that added this one. A leftover temp
  // directory is a tidiness problem; the OS clears it. A failed cleanup must
  // never be reported as a failed test.
  if (dataDir) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (_) { /* the OS will get it */ }
  }
});

const DELETE_ACTION = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

async function foreignKeysToUsers() {
  const { rows } = await pool.query(
    `SELECT src.relname AS tbl,
            (SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
               FROM unnest(c.conkey) k
               JOIN pg_attribute a ON a.attrelid = src.oid AND a.attnum = k) AS cols,
            c.confdeltype AS del
       FROM pg_constraint c
       JOIN pg_class src ON src.oid = c.conrelid
      WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass
      ORDER BY 1, 2`
  );
  return rows.map((r) => ({ ref: `${r.tbl}.${r.cols}`, action: DELETE_ACTION[r.del] }));
}

// ---------------------------------------------------------------------------
// 1. DELETION MUST NOT BE ABLE TO FAIL ON A CONSTRAINT
// ---------------------------------------------------------------------------

test('every foreign key to users deletes or de-attributes, so a deletion cannot be refused', async () => {
  const offenders = (await foreignKeysToUsers())
    .filter((f) => f.action !== 'CASCADE' && f.action !== 'SET NULL');
  assert.deepEqual(
    offenders, [],
    'a RESTRICT or NO ACTION key to users(id) makes DELETE /api/users/me answer 503 to a ' +
    'user who has already typed DELETE, with no way for them to fix it. Apple 5.1.1(v) ' +
    'requires deletion to stay reachable, so a new key here is CASCADE or SET NULL.'
  );
});

// ---------------------------------------------------------------------------
// 2. THE SURVIVOR SET, NAMED
// ---------------------------------------------------------------------------
//
// A SET NULL key does not delete a row, it empties one reference on it. Every
// one is a deliberate decision about evidence or about somebody else's plan, so
// every one is written down. Adding to this list is fine; adding to it without
// deciding whether the delete-account page has to say so is not.
const DE_ATTRIBUTED = {
  'bill_splits.paid_by':
    "a bill split inside somebody else's plan keeps the split and forgets who paid",
  'content_reports.handled_by':
    'the moderator who closed a report, on a report that outlives them',
  'dm_pinned_venues.pinned_by':
    'belt and braces: user1_id/user2_id CASCADE, so the row goes anyway',
  'flock_invite_links.created_by':
    "an invite link somebody else's flock still holds stops saying who made it",
  'messages.sender_id':
    'the schema default, overridden: deleteAccount DELETEs the rows outright so no ' +
    'authored content is retained',
  'moderation_actions.moderator_id':
    'the moderator who took an action, on an action that outlives them',
  'push_sends.user_id':
    'a 30-day delivery counter. Once emptied it holds a push type, an outcome and a ' +
    'timestamp, and nothing that names a person',
  'venue_subscriptions.granted_by':
    'the admin who comped a venue tier',
};

test('the rows that survive a deletion de-attributed are exactly the ones we decided on', async () => {
  const actual = (await foreignKeysToUsers())
    .filter((f) => f.action === 'SET NULL')
    .map((f) => f.ref)
    .sort();
  assert.deepEqual(
    actual, Object.keys(DE_ATTRIBUTED).sort(),
    'a foreign key to users changed its delete action. SET NULL means the row SURVIVES the ' +
    'account with one field emptied. Add it to DE_ATTRIBUTED with what it is, and check ' +
    'whether frontend/src/website/DeleteAccount.js and PrivacyPolicy.js have to say so.'
  );
});

// A table that identifies a person by their EMAIL or PHONE rather than by their
// users.id has no foreign key to cascade, so an account deletion cannot reach
// it and it survives in full. Both entries below are legitimate retentions and
// both are disclosed; the point of the sweep is the THIRD one, written by
// somebody who did not think of it as personal data.
const IDENTIFIER_TABLES_WITHOUT_A_USERS_KEY = {
  'email_suppressions.email':
    'the do-not-mail list. Plaintext, keyed on the address, no expiry, and it survives ' +
    'deletion on purpose: not mailing an address that bounced or reported us as spam is a ' +
    'promise to whoever holds that mailbox, not to the account. Disclosed on both pages.',
  'waitlist.email':
    'a launch-notification address, never linked to an account. Kept until unsubscribed ' +
    'or removed on request. Disclosed in PrivacyPolicy.js.',
};

test('no table identifies a person by address or number outside the disclosed survivors', async () => {
  const { rows } = await pool.query(
    `SELECT c.relname AS tbl, a.attname AS col
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND c.relname <> 'users'
        AND a.attname ~ '^(email|phone|contact_email|contact_phone|verified_email)$'
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint fk
           WHERE fk.contype = 'f' AND fk.conrelid = c.oid
             AND fk.confrelid = 'users'::regclass)
      ORDER BY 1, 2`
  );
  assert.deepEqual(
    rows.map((r) => `${r.tbl}.${r.col}`),
    Object.keys(IDENTIFIER_TABLES_WITHOUT_A_USERS_KEY).sort(),
    'a table holds an email address or phone number and has no foreign key to users, so ' +
    'deleting an account cannot reach it and the value survives. If that is intended, add ' +
    'it to IDENTIFIER_TABLES_WITHOUT_A_USERS_KEY with the reason AND disclose it in ' +
    'frontend/src/website/DeleteAccount.js and PrivacyPolicy.js. Anything that survives and ' +
    'is not disclosed is the defect.'
  );
});

// ---------------------------------------------------------------------------
// 3. THE EXPORT KEEPS UP WITH THE users TABLE
// ---------------------------------------------------------------------------
//
// GET /api/users/export hand-writes its SELECT list, so every column added to
// `users` is silently absent from the export until somebody remembers. The
// privacy policy names four things the file leaves out and says so on purpose.
// A fifth that nobody decided to leave out is drift, not honesty.
const EXPORT_OMISSIONS = {
  password: 'a bcrypt hash. Not the password, and useless to the person it belongs to',
  oauth_id: "the provider's subject id, a credential, never leaves the server",
  apple_refresh_token: 'a live credential; it is revoked at deletion, never exported',
  token_version: 'a session-revocation counter, an internal mechanism',
  phone_hash: 'a keyed HMAC of the number under a server secret. The number itself is ' +
    'exported as `phone`, so this adds nothing the user gave us',
  is_banned: 'not exported because a banned account cannot reach this route at all: ' +
    'router.use(authenticate) refuses it, and only DELETE /api/users/me opts into ' +
    'authenticateAllowBanned. Exporting the flag would need the route to accept banned ' +
    'callers first',
  banned_at: 'same as is_banned',
  verified_email: 'the address proved by clicking the link. `email` is the address on the ' +
    'account and is exported; these differ only mid-change',
};

test('every users column is exported or is a named, reasoned omission', async () => {
  const { rows } = await pool.query(
    `SELECT a.attname AS col
       FROM pg_attribute a
      WHERE a.attrelid = 'users'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`
  );

  // The export's own SELECT, taken from the route rather than restated here, so
  // this cannot pass against a list that has drifted from the code.
  const select = USERS_ROUTE.match(
    /router\.get\('\/export'[\s\S]*?`(SELECT id, email, name[\s\S]*?FROM users WHERE id = \$1)`/
  );
  assert.ok(select, "could not find the export's SELECT in routes/users.js");
  const selected = new Set(
    select[1]
      .replace(/^SELECT/, '')
      .replace(/FROM users WHERE id = \$1$/, '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
  );

  const unaccounted = rows
    .map((r) => r.col)
    .filter((c) => !selected.has(c) && !(c in EXPORT_OMISSIONS));

  assert.deepEqual(
    unaccounted, [],
    'a column on users is neither in the export SELECT nor in EXPORT_OMISSIONS. An export ' +
    'is the copy of themselves a user is entitled to, so a new column is exported by ' +
    'default. If it genuinely should not be, name it in EXPORT_OMISSIONS with the reason ' +
    'and check the "four things are not in that file today" sentence in PrivacyPolicy.js ' +
    'still counts correctly.'
  );

  // And the two that this file put there, so a revert is loud.
  assert.ok(selected.has('phone_discoverable'), 'the phone-discovery consent is exported');
  assert.ok(selected.has('phone_discoverable_at'), 'and the moment it was given');
});

test('the export payload publishes the phone-discovery consent it now selects', () => {
  assert.match(USERS_ROUTE, /phone_discoverable: account\.phone_discoverable \?\? false/);
  assert.match(USERS_ROUTE, /phone_discoverable_at: account\.phone_discoverable_at \?\? null/);
});

test('the export says which images it leaves out, and the profile photo is not one of them', () => {
  // "Inline image data is not included in the export" was not true. An avatar
  // uploaded through POST /upload-image is stored as a base64 data URL in
  // users.profile_image_url (MAX_AVATAR_DATA_URL_BYTES is the ceiling on
  // exactly that), and the profile section copies it out untouched, so the
  // file contradicted its own note on every account with an uploaded photo.
  assert.doesNotMatch(
    USERS_ROUTE, /'Inline image data is not included in the export/,
    'the blanket claim is false while profile_image_url is exported as stored'
  );
  assert.match(USERS_ROUTE, /Images inside messages and stories are not included in this file/);
  assert.match(USERS_ROUTE, /Your profile photo is included/);

  // And the marker really is applied to those two and not to the avatar.
  assert.match(USERS_ROUTE, /profile_image_url: account\.profile_image_url,/);
  const exportImage = USERS_ROUTE.match(/function exportImage\(url\)[\s\S]*?\n\}/);
  assert.ok(exportImage, 'exportImage must exist');
  assert.match(exportImage[0], /url\.startsWith\('data:'\)/);
});

// ---------------------------------------------------------------------------
// 4. DELETING AN ACCOUNT CANCELS OTHER PEOPLE'S PLANS, AND MUST SAY SO
// ---------------------------------------------------------------------------

test('flocks.creator_id cascades, which is why the cancellation fan-out has to exist', async () => {
  const fks = await foreignKeysToUsers();
  const creator = fks.find((f) => f.ref === 'flocks.creator_id');
  assert.equal(
    creator?.action, 'CASCADE',
    'deleting an account deletes every flock it created, and with it everyone else\'s chat, ' +
    'RSVPs and votes. If this ever becomes SET NULL the flock survives ownerless instead, ' +
    'and the fan-out in deleteAccount is announcing a cancellation that did not happen.'
  );
});

test('deleteAccount tells the members of every plan it cancels', () => {
  // Read before the delete, because the CASCADE takes flock_members with it.
  assert.match(USERS_ROUTE, /FROM flocks f\s*\n\s*LEFT JOIN flock_members fm ON fm\.flock_id = f\.id/);
  assert.match(USERS_ROUTE, /WHERE f\.creator_id = \$1/);
  // Emitted with the recipients passed in, which is the argument
  // emitToFlockMembers exists for once the membership rows are gone.
  assert.match(USERS_ROUTE, /emitToFlockMembers\(io, f\.id, 'flock_deleted'/);
  // And pushed, because the person who is not in the app is the one who
  // otherwise turns up at the bar.
  assert.match(USERS_ROUTE, /'Plan cancelled'/);
  assert.match(USERS_ROUTE, /type: 'flock_cancelled'/);
});

test('the fan-out runs after the COMMIT and only for plans that have not happened', () => {
  const commitAt = USERS_ROUTE.indexOf("await client.query('COMMIT')");
  const emitAt = USERS_ROUTE.indexOf("emitToFlockMembers(io, f.id, 'flock_deleted'");
  assert.ok(commitAt > 0 && emitAt > commitAt,
    'a rolled-back deletion must never tell anybody their plan is off');

  // Everyone gets the socket event, because it is what takes a dead row out of
  // a list somebody is looking at. Only upcoming plans get a push.
  assert.match(USERS_ROUTE, /\(f\.status NOT IN \('completed', 'cancelled'\)\) AS upcoming/);
  assert.match(USERS_ROUTE, /cancelledFlocks\.filter\(\(f\) => f\.upcoming\)/);
});

test('preparing the notification can never block the deletion itself', () => {
  // Apple 5.1.1(v): deletion stays reachable. The read that feeds the fan-out
  // is outside the transaction and inside its own catch, so a failure there
  // costs a notification and not an account.
  const readAt = USERS_ROUTE.indexOf('could not read the flocks this cancels');
  const connectAt = USERS_ROUTE.indexOf('const client = await pool.connect();');
  assert.ok(readAt > 0 && connectAt > readAt,
    'the cancellation read belongs before the transaction, in a catch of its own');

  // Work now continues after the 200, so the outer catch must not try to send
  // a second response.
  assert.match(USERS_ROUTE, /if \(!res\.headersSent\) res\.status\(500\)\.json\(\{ error: 'Failed to delete account' \}\)/);
});

// ---------------------------------------------------------------------------
// 5. THE PAGE A USER READS BEFORE THEY DECIDE
// ---------------------------------------------------------------------------

test('the delete-account page names every survivor a reader could have', () => {
  // The count was the bug: "Three things survive a deletion, all explained in
  // our Privacy Policy" while the policy named more, so a reader who stopped at
  // this page concluded their email address was gone. It is not.
  assert.doesNotMatch(
    DELETE_PAGE, /Three things survive/,
    'the page must not count the survivors, because the count goes stale the moment one ' +
    'is added and a wrong count reads as a promise'
  );
  assert.match(DELETE_PAGE, /do-not-mail list/, 'the address kept with no expiry is named');
  assert.match(DELETE_PAGE, /has no expiry/);
  assert.match(DELETE_PAGE, /Reports and moderation records are kept/);
  assert.match(DELETE_PAGE, /one-way hashed code/);
  assert.match(DELETE_PAGE, /One row per finished plan/i);
  assert.match(DELETE_PAGE, /stop pointing at you rather than being\s*\n?\s*deleted/,
    "the bill split's payer and the invite link's author survive emptied, and the policy " +
    'says so, so this page has to as well');
});

test('the delete-account page and the privacy policy agree on what survives', () => {
  const policy = fs.readFileSync(
    path.join(REPO, 'frontend', 'src', 'website', 'PrivacyPolicy.js'), 'utf8'
  );
  // Each of these is a survivor the policy states. If the policy drops one, the
  // delete page is claiming something the policy no longer backs; if the policy
  // adds one, this test is where somebody notices the delete page is behind.
  for (const claim of [/do-not-mail list/, /Reports filed about content/, /ban tombstone/i,
    /One row per finished plan/i, /emptied rather than removed/]) {
    assert.match(policy, claim,
      'PrivacyPolicy.js no longer states a survivor that DeleteAccount.js repeats. Two ' +
      'pages that disagree about what deletion means is its own defect.'
    );
  }
});

test('the page does not promise deletion is total', () => {
  // "Copy must never imply an account is gone if anything about it remains."
  assert.doesNotMatch(DELETE_PAGE, /nothing (?:at all )?(?:is|remains|is left)/i);
  assert.doesNotMatch(DELETE_PAGE, /erased completely|wiped completely|no trace/i);
});

// ---------------------------------------------------------------------------
// 6. THE FAN-OUT, DRIVEN
// ---------------------------------------------------------------------------
//
// Everything above is the catalog and the source. This section runs the real
// route: a person who created three plans deletes their account, and the test
// asks who was told what. It stubs the shared pool (a different object from the
// embedded-Postgres pool this file opened above, so the two do not collide) the
// way __tests__/banEvasion.test.js does, and records what reached io.
//
// pushHelper is patched BEFORE routes/users is required, because that file
// destructures its two functions at require time and a later assignment on the
// module object would never be seen.
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests';

const pushHelper = require('../services/pushHelper');
const pushed = [];
let pushConfigured = true;
pushHelper.isPushConfigured = () => pushConfigured;
pushHelper.pushIfOffline = async (_io, userId, title, body, data) => {
  pushed.push({ userId, title, body, data });
  return true;
};

const sharedPool = require('../config/database');
const realSharedQuery = sharedPool.query;
const realSharedConnect = sharedPool.connect;
const usersRouter = require('../routes/users');

const PASSWORD = 'CorrectHorse1';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
const DELETER = 11;

// Three plans, chosen for the three different answers:
//   200 upcoming, two other members, one of whom may have blocked the deleter
//   201 already finished, one other member
//   202 upcoming, nobody else in it
const OWNED = [
  { id: 200, name: 'Friday at Kome', upcoming: true, member_ids: [21, 22] },
  { id: 201, name: 'Taco night in March', upcoming: false, member_ids: [23] },
  { id: 202, name: 'A plan nobody joined', upcoming: true, member_ids: [] },
];

let emitted;
let blockedBoth;
let failTransaction;
let unmodelled;

function stubQuery(text) {
  const q = String(text);
  const has = (f) => q.includes(f);

  // Ordered before the SELECT below on purpose: 'DELETE FROM users WHERE id =
  // $1 RETURNING id' also contains the substring 'FROM users WHERE id = $1', so
  // a SELECT-first dispatcher answers the delete with a user row and every
  // rollback case silently passes as a success.
  if (has('DELETE FROM users WHERE id = $1')) {
    if (failTransaction) throw new Error('simulated write failure');
    return { rows: [{ id: DELETER }], rowCount: 1 };
  }
  if (has('FROM users WHERE id = $1')) {
    return { rows: [{
      id: DELETER, email: 'deleter@example.com', name: 'Robin', phone: null,
      password: PASSWORD_HASH, oauth_provider: null, oauth_id: null,
      apple_refresh_token: null, is_banned: false, banned_at: null,
      email_verified: true, verified_email: 'deleter@example.com', role: 'user',
      token_version: 0,
    }], rowCount: 1 };
  }
  if (has('FROM flocks f') && has('WHERE f.creator_id = $1')) {
    return { rows: OWNED.map((f) => ({ ...f })), rowCount: OWNED.length };
  }
  // utils/blocks getInvisibleUserIds, whichever shape it asks in.
  if (has('user_blocks')) {
    // getInvisibleUserIds reads `id`, from a UNION that aliases both columns to
    // it. Returning user_id here made the block gate see [undefined] and pass.
    return { rows: blockedBoth.map((id) => ({ id })), rowCount: blockedBoth.length };
  }
  if (has('BEGIN') || has('COMMIT') || has('ROLLBACK')) return { rows: [], rowCount: 0 };
  if (has('UPDATE content_reports') || has('UPDATE moderation_actions')) return { rows: [], rowCount: 0 };
  if (has('DELETE FROM messages')) return { rows: [], rowCount: 0 };
  if (has('banned_identities')) return { rows: [], rowCount: 0 };
  unmodelled.push(q);
  return { rows: [], rowCount: 0 };
}

const io = {
  to(room) {
    return { emit: (event, payload) => emitted.push({ room, event, payload }) };
  },
  in() { return { disconnectSockets() {} }; },
};

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/users', usersRouter);
const server = http.createServer(app);
let base;

test.before(() => new Promise((resolve) => {
  sharedPool.query = async (text) => stubQuery(text);
  sharedPool.connect = async () => ({
    query: async (text) => stubQuery(text),
    release() {},
  });
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));

test.after(() => new Promise((resolve) => server.close(resolve)));
test.after(() => {
  sharedPool.query = realSharedQuery;
  sharedPool.connect = realSharedConnect;
  return sharedPool.end().catch(() => {});
});

async function deleteAccountAs(opts = {}) {
  emitted = [];
  pushed.length = 0;
  unmodelled = [];
  blockedBoth = opts.blocked || [];
  failTransaction = Boolean(opts.failTransaction);
  pushConfigured = opts.pushConfigured !== false;
  // getInvisibleUserIds is the UNCACHED variant, so blockedBoth is read fresh
  // on every call and there is nothing to invalidate.
  usersRouter.__testing.proofFailures.clearAll();
  const token = jwt.sign(
    { userId: DELETER, tv: 0, iat: Math.floor(Date.now() / 1000) },
    process.env.JWT_SECRET
  );
  const res = await fetch(base + '/api/users/me', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('every member of every cancelled plan gets the socket event', async () => {
  const res = await deleteAccountAs();
  assert.equal(res.status, 200, res.body && JSON.stringify(res.body));
  assert.deepEqual(unmodelled, [], 'fixture did not model a query the route ran');

  const deletes = emitted.filter((e) => e.event === 'flock_deleted');
  assert.deepEqual(
    deletes.map((e) => e.room).sort(),
    ['user:21', 'user:22', 'user:23'],
    'the finished plan is announced too: the socket event is what takes a dead row out ' +
    'of a list somebody is looking at, whatever state the plan was in'
  );
  // The plan nobody else joined tells nobody, rather than emitting into space.
  assert.equal(deletes.filter((e) => e.payload.flockId === 202).length, 0);
  // Named, because the client's toast reads "<name> was deleted by <deletedBy>"
  // and would otherwise say "by undefined".
  assert.equal(deletes[0].payload.deletedBy, 'Robin');
  assert.equal(
    deletes.find((e) => e.room === 'user:23').payload.flockName, 'Taco night in March'
  );
});

test('only plans that have not happened interrupt anyone with a push', async () => {
  await deleteAccountAs();
  assert.deepEqual(
    pushed.map((p) => p.userId).sort(), [21, 22],
    'an account with a year of history must not push "Taco night in March is off"'
  );
  assert.equal(pushed[0].title, 'Plan cancelled');
  assert.equal(pushed[0].body, 'Friday at Kome is off.');
  // No flockId: the row is gone, so pushHelper's visibility gate would find no
  // flock and suppress every send, and there is no screen left to open.
  assert.deepEqual(pushed[0].data, { type: 'flock_cancelled' });
});

test('a member who blocked the deleter is not sent a payload naming them', async () => {
  await deleteAccountAs({ blocked: [22] });
  const rooms = emitted.filter((e) => e.event === 'flock_deleted').map((e) => e.room);
  assert.ok(!rooms.includes('user:22'), 'the socket payload carries deletedBy, so it is block-gated');
  assert.ok(rooms.includes('user:21'));
});

test('a deletion that rolls back tells nobody their plan is off', async () => {
  const res = await deleteAccountAs({ failTransaction: true });
  assert.equal(res.status, 503);
  assert.deepEqual(emitted.filter((e) => e.event === 'flock_deleted'), []);
  assert.deepEqual(pushed, []);
});

test('with push unconfigured the deletion still completes and still emits', async () => {
  const res = await deleteAccountAs({ pushConfigured: false });
  assert.equal(res.status, 200);
  assert.equal(emitted.filter((e) => e.event === 'flock_deleted').length, 3);
  assert.deepEqual(pushed, []);
});
