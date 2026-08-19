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
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);

// Round 17: this was a regex over the raw connection string, which was wrong in
// both directions.
//
//  - `DATABASE_URL === ''` counted as LOCAL. But an unset DATABASE_URL does not
//    mean "no database": config/database.js hands `undefined` to pg, and pg
//    then falls back to the libpq PG* environment variables. Those are a live
//    pattern in this very repo — seeds/demo-data.js builds a connection string
//    out of PGHOST/PGPASSWORD/... — so an operator with PGHOST exported for
//    psql against Railway had a completely unguarded run straight at
//    production. The PG* fallback is resolved here and judged by the same rule.
//
//  - the regex `/@(localhost|...)[:/]/` matched ANYWHERE in the string, and a
//    URL has more than one `@`. `postgresql://user@localhost:x@prod.example.com/db`
//    matched, while pg splits on the LAST `@` and connects to prod.example.com.
//    Parse the URL and read `hostname`, which is the same field pg uses.
//
// Failing to parse is treated as NOT local: an unrecognisable target is exactly
// the case that should be asked about out loud.
function resolveTargetHost() {
  const url = process.env.DATABASE_URL;
  if (url) {
    try {
      return { host: new URL(url).hostname.toLowerCase(), shown: url.replace(/\/\/[^@]*@/, '//***@') };
    } catch (_) {
      return { host: null, shown: '<unparseable DATABASE_URL>' };
    }
  }
  // No DATABASE_URL: pg reads PGHOST (default: the local socket / localhost).
  const pgHost = (process.env.PGHOST || '').trim().toLowerCase();
  return { host: pgHost, shown: pgHost ? `PGHOST=${pgHost}` : 'the local default (no DATABASE_URL, no PGHOST)' };
}

const target = resolveTargetHost();
const isLocal = target.host !== null && LOCAL_HOSTS.has(target.host);

if (!isLocal && process.env.SEED_REVIEW_CONFIRM !== '1') {
  console.error(
    '\nRefusing to seed: the database this would write to is not local.\n' +
    `  target: ${target.shown}\n\n` +
    'This script writes accounts whose passwords are committed to this repo, and\n' +
    'deletes the seed flock. If this really is the staging/reviewer database, re-run as:\n\n' +
    '  SEED_REVIEW_CONFIRM=1 node scripts/seed-review-account.js\n'
  );
  process.exit(1);
}

// These defaults are LOCAL FIXTURES ONLY. They are the credentials
// scripts/e2e-local.js logs in with against its embedded Postgres, and they are
// public in this repository, which is exactly why the live review account does
// not use them: production was re-seeded with SEED_REVIEWER_PASSWORD set, and
// the value handed to App Review is recorded outside version control. Setting
// the env vars is not optional for any database that is not a throwaway -- the
// production guard above exists because a bare run once wrote these very
// strings into the live database.
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
    // The UPDATE branch mirrors the INSERT branch on every column that decides
    // whether the app will let this account do anything. It used to set only
    // name/password/verification, which left three ways for a re-seed to hand
    // App Review an account it could log into and then not use:
    //   - is_banned / banned_at: the reviewer account gets BANNED as a normal
    //     consequence of demonstrating the moderation flow (that is what the
    //     seeded reportable content is for), and a ban outlives the re-seed.
    //     middleware/auth.js then 403s every request after login.
    //   - date_of_birth: null on a legacy row, and the age gate reads it.
    //   - terms_accepted_at: null on a legacy row.
    // Re-seeding is the one lever anyone has before a submission, so it has to
    // put the account fully back into a usable state.
    `INSERT INTO users (email, password, name, terms_accepted_at, date_of_birth, email_verified, verified_email)
     VALUES ($1, $2, $3, NOW(), $4, TRUE, $1)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password = EXCLUDED.password,
       email_verified = TRUE, verified_email = EXCLUDED.email,
       date_of_birth = EXCLUDED.date_of_birth,
       terms_accepted_at = COALESCE(users.terms_accepted_at, EXCLUDED.terms_accepted_at),
       is_banned = FALSE, banned_at = NULL
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
