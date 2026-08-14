// Seeds an App-Review / E2E demo account pre-populated so the report/block/delete
// flows are immediately exercisable (an empty app fails human review). Doubles as
// the E2E test fixture.
//
// Run: node scripts/seed-review-account.js
// Uses DATABASE_URL — point it at your LOCAL Postgres for E2E, or staging for the
// reviewer build. NEVER run against prod casually (it writes rows).
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../config/database');

// ---------------------------------------------------------------------------
// Production guard.
//
// Security review: the comment above said "NEVER run against prod casually",
// and nothing enforced it. `require('dotenv').config()` loads backend/.env,
// whose DATABASE_URL points at the live Railway database — so a bare
// `npm run seed:review` from a dev checkout wrote two accounts with passwords
// that are committed to this repo straight into production, and ran a
// DELETE against the flocks table on the way. Both accounts are also
// `ON CONFLICT DO UPDATE ... password = EXCLUDED.password`, so it would reset
// the password of any real account that happened to hold those addresses.
//
// A local database runs with no ceremony (this is also the E2E fixture, and
// scripts/e2e-local.js points DATABASE_URL at its embedded Postgres). Anything
// else has to be asked for out loud.
// ---------------------------------------------------------------------------
const DB_URL = process.env.DATABASE_URL || '';
const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(DB_URL) || DB_URL === '';

if (!isLocal && process.env.SEED_REVIEW_CONFIRM !== '1') {
  const host = DB_URL.replace(/\/\/[^@]*@/, '//***@');
  console.error(
    '\nRefusing to seed: DATABASE_URL does not point at a local database.\n' +
    `  target: ${host}\n\n` +
    'This script writes accounts whose passwords are committed to this repo, and\n' +
    'deletes the seed flock. If this really is the staging/reviewer database, re-run as:\n\n' +
    '  SEED_REVIEW_CONFIRM=1 node scripts/seed-review-account.js\n'
  );
  process.exit(1);
}

// Overridable so the reviewer build does not have to use a password that is
// public in the repo. Defaults match SUBMISSION.md, which is what App Review
// is handed today.
const REVIEWER_PASSWORD = process.env.SEED_REVIEWER_PASSWORD || 'ReviewPass123';
const BUDDY_PASSWORD = process.env.SEED_BUDDY_PASSWORD || 'BuddyPass123';

async function upsertUser(email, name, password, dob) {
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    // email_verified TRUE (round 16, migration 011). Password signups are
    // created unverified and an unverified account cannot hold payment
    // handles, accept friendships or join a flock — which is exactly what the
    // seeded reviewer account needs to do. Without this the App Review login
    // would 403 on the friend and flock screens, because no one can click a
    // confirmation link sent to review@flockcorp.com.
    `INSERT INTO users (email, password, name, terms_accepted_at, date_of_birth, email_verified, verified_email)
     VALUES ($1, $2, $3, NOW(), $4, TRUE, $1)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password = EXCLUDED.password,
       email_verified = TRUE, verified_email = EXCLUDED.email
     RETURNING id`,
    [email, hash, name, dob]
  );
  return r.rows[0].id;
}

(async () => {
  try {
    const reviewer = await upsertUser('review@flockcorp.com', 'App Reviewer', REVIEWER_PASSWORD, '2000-01-01');
    const buddy = await upsertUser('buddy@flockcorp.com', 'Sam Buddy', BUDDY_PASSWORD, '1999-05-05');

    // Friendship (accepted) so the reviewer has someone to block.
    await pool.query(
      `INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'accepted')
       ON CONFLICT (requester_id, addressee_id) DO UPDATE SET status = 'accepted'`,
      [buddy, reviewer]
    );

    // Fresh flock owned by reviewer (idempotent: clear prior seed flock first).
    await pool.query(`DELETE FROM flocks WHERE creator_id = $1 AND name = 'Friday Night Out'`, [reviewer]);
    const f = await pool.query(`INSERT INTO flocks (name, creator_id) VALUES ($1, $2) RETURNING id`, ['Friday Night Out', reviewer]);
    const flockId = f.rows[0].id;
    await pool.query(
      `INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1,$2,'accepted'),($1,$3,'accepted')`,
      [flockId, reviewer, buddy]
    );

    // Reportable content from the buddy: flock messages + a DM.
    await pool.query(
      `INSERT INTO messages (flock_id, sender_id, message_text, message_type) VALUES
        ($1,$2,'hey everyone! down for tonight?','text'),
        ($1,$2,'this is a sample message you can report','text')`,
      [flockId, buddy]
    );
    await pool.query(
      `INSERT INTO direct_messages (sender_id, receiver_id, message_text, message_type)
       VALUES ($1,$2,'hey! sample DM — you can report this or block me','text')`,
      [buddy, reviewer]
    );

    console.log('Seeded review account:');
    console.log('  reviewer  : review@flockcorp.com / ' + REVIEWER_PASSWORD + '   (id ' + reviewer + ')');
    console.log('  buddy     : buddy@flockcorp.com  (block/report this user) (id ' + buddy + ')');
    console.log('  flock #' + flockId + ' "Friday Night Out": 2 reportable messages + 1 DM from buddy');
    console.log('  admin console: log in as the admin account, open /admin/moderation');
    process.exit(0);
  } catch (e) {
    console.error('Seed failed:', e.message);
    process.exit(1);
  }
})();
