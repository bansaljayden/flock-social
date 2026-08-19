// Run: node --test  (from backend/)
//
// THE MODERATOR HAS TO BE ABLE TO READ WHAT WAS REPORTED.
//
// routes/admin.js builds the moderation queue's excerpt from CONTENT_TEXT_SQL,
// one expression per content type. For `profile`, the reported content is the
// account itself, so the expression has to cover every field a stranger can see.
//
// It did not. The expression selected name and interests, under a comment that
// said "users has no bio column" — true when it was written, false from
// migration 026 onward. By then `bio` was 200 characters of user-typed free
// text (MAX_BIO, routes/users.js) served to anyone who taps a person card
// (GET /api/users/:id/card returns { id, name, profile_image_url, bio }).
//
// That is precisely the surface an abusive or contact-soliciting profile uses,
// and it is the most likely reason someone reports a profile at all. So the
// report arrived, the moderator opened it, and the offending string was not on
// screen. They were asked to judge content they could not read — the same
// failure adminEvidence.test.js was written to close for venue cards and venue
// replies, and that the paragraph above this expression closes for the avatar.
//
// This runs the REAL expression against a REAL Postgres rather than asserting on
// the string, because a substring check passes on SQL that does not compile and
// says nothing about whether CONCAT_WS actually emits the value. adminEvidence
// explicitly declines to test these semantics with a scripted fake and verified
// them out-of-band instead; this file gives that verification somewhere to live.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('./helpers/embeddedPgPort');

const { CONTENT_TEXT_SQL } = require('../routes/admin').__test;

// This suite boots its own embedded Postgres, so its port must be distinct from
// e2e-local.js's 59595 and from every sibling suite that does the same. It used
// to be the hardcoded 54411, which held right up until a run was killed: the
// orphaned postgres kept the port and broke every LATER run of this file
// permanently, reported only as `hookFailed: undefined`.
//
// pickEmbeddedPgPort keeps the distinctness, by giving each suite a disjoint
// range of its own, and adds orphan-immunity on top of it. The candidate port
// starts from a process.pid-derived offset, so a fresh run never starts where an
// orphan of some dead process sits, and it is then confirmed free by an actual
// bind. See __tests__/helpers/embeddedPgPort.js.
// It resolves SYNCHRONOUSLY, so it is usable at module scope like the constant
// it replaces.
const PG_PORT = pickEmbeddedPgPort('moderationProfileBio');
let pg;
let pool;
let dataDir;

// The excerpt as the queue asks for it: the expression, aliased, over users.
const excerptFor = async (userId) => {
  const { rows } = await pool.query(
    `SELECT ${CONTENT_TEXT_SQL.profile('pu')} AS content_text
       FROM users pu WHERE pu.id = $1`,
    [userId]
  );
  return rows[0].content_text;
};

const makeUser = async ({ email, name, bio = null, interests = null }) => {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password, name, bio, interests)
     VALUES ($1, 'x', $2, $3, $4) RETURNING id`,
    [email, name, bio, interests]
  );
  return rows[0].id;
};

test.before(async () => {
  dataDir = path.join(os.tmpdir(), 'flock-modbio-pg-' + process.pid);
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'moderationProfileBio', port: PG_PORT, databaseDir: dataDir,
  });
  // Not pg.start(): the wrapper turns embedded-postgres's bare reject() into an
  // error that names the suite, the port, and whether an orphan is holding it.
  await startEmbeddedPostgres(pg);
  await pg.createDatabase('flock_modbio_test');

  pool = new Pool({
    connectionString: `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_modbio_test`,
  });

  // The real migration chain, so `bio` exists here for the same reason it exists
  // in production: migration 026 applied, not a hand-written CREATE TABLE that
  // could drift from it.
  const { migrate } = require('../db/migrate');
  await migrate(pool);
});

test.after(async () => {
  if (pool) await pool.end().catch(() => {});
  if (pg) await pg.stop().catch(() => {});
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
});

test('users.bio exists, so the comment that denied it cannot be restored', async () => {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'bio'`
  );
  assert.strictEqual(rows.length, 1, 'migration 026 must still add users.bio');
});

test('a reported profile reaches the moderator WITH its bio', async () => {
  const bio = 'text me at 555-0100 for a good time';
  const id = await makeUser({
    email: 'bio-carrier@example.com', name: 'Bio Carrier',
    bio, interests: ['hiking'],
  });

  const excerpt = await excerptFor(id);

  // The assertion that fails on the pre-2026-08-18 expression.
  assert.ok(
    excerpt.includes(bio),
    `the reported bio must be in the excerpt, got: ${JSON.stringify(excerpt)}`
  );
  assert.ok(excerpt.includes('Bio Carrier'), 'name must survive');
  assert.ok(excerpt.includes('hiking'), 'interests must survive');
});

test('a bio-only profile is not reported as having no text', async () => {
  // The worst case: nothing but the offending bio. Before the fix CONCAT_WS
  // produced just the name, and a name-only excerpt tells a moderator nothing
  // about why the account was reported.
  const bio = 'slur goes here, and this is the entire reason for the report';
  const id = await makeUser({ email: 'bio-only@example.com', name: 'B', bio });

  const excerpt = await excerptFor(id);
  assert.ok(excerpt.includes(bio), 'a bio-only profile must still show its bio');
});

test('an empty or absent bio adds no separator noise', async () => {
  // NULLIF(bio, '') keeps CONCAT_WS from emitting a trailing ' / ' for the
  // accounts — most of them — that never wrote one.
  const nullBio = await makeUser({
    email: 'no-bio@example.com', name: 'No Bio', interests: ['chess'],
  });
  const emptyBio = await makeUser({
    email: 'empty-bio@example.com', name: 'Empty Bio', bio: '', interests: ['chess'],
  });

  for (const [label, id] of [['null', nullBio], ['empty string', emptyBio]]) {
    const excerpt = await excerptFor(id);
    assert.ok(!excerpt.endsWith('/'), `${label} bio must not leave a dangling separator: ${excerpt}`);
    assert.ok(!excerpt.includes('/  /'), `${label} bio must not leave an empty slot: ${excerpt}`);
    assert.ok(excerpt.includes('chess'), `${label} bio must not eat the interests`);
  }
});

test('a profile with nothing at all is still NULL, not an empty string', async () => {
  // The outer NULLIF is what makes the queue render "No text on this item"
  // rather than a blank row, so it has to survive the added field.
  const id = await makeUser({ email: 'blank@example.com', name: '' });
  const excerpt = await excerptFor(id);
  assert.strictEqual(excerpt, null, 'a wholly empty profile must come back NULL');
});

test('every field the person card serves a stranger is in the excerpt', async () => {
  // The rule this file exists to enforce, stated as a rule rather than as three
  // cases: GET /api/users/:id/card returns id, name, profile_image_url and bio.
  // The avatar goes through /reports/:id/image; the other two text fields must
  // be in CONTENT_TEXT_SQL.profile, or a moderator is judging blind again the
  // next time a field is added.
  const sql = CONTENT_TEXT_SQL.profile('pu');
  for (const field of ['name', 'bio', 'interests']) {
    assert.ok(
      sql.includes(`pu.${field}`),
      `CONTENT_TEXT_SQL.profile must read pu.${field}; a new visible field needs adding here too`
    );
  }
});
