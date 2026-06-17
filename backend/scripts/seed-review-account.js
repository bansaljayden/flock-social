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

async function upsertUser(email, name, password, dob) {
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO users (email, password, name, terms_accepted_at, date_of_birth)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password = EXCLUDED.password
     RETURNING id`,
    [email, hash, name, dob]
  );
  return r.rows[0].id;
}

(async () => {
  try {
    const reviewer = await upsertUser('review@flockcorp.com', 'App Reviewer', 'ReviewPass123', '2000-01-01');
    const buddy = await upsertUser('buddy@flockcorp.com', 'Sam Buddy', 'BuddyPass123', '1999-05-05');

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
    console.log('  reviewer  : review@flockcorp.com / ReviewPass123   (id ' + reviewer + ')');
    console.log('  buddy     : buddy@flockcorp.com  (block/report this user) (id ' + buddy + ')');
    console.log('  flock #' + flockId + ' "Friday Night Out": 2 reportable messages + 1 DM from buddy');
    console.log('  admin console: log in as the admin account, open /admin/moderation');
    process.exit(0);
  } catch (e) {
    console.error('Seed failed:', e.message);
    process.exit(1);
  }
})();
