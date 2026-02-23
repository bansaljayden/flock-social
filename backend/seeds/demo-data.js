require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// Build DATABASE_URL from individual PG* vars if not set
if (!process.env.DATABASE_URL && process.env.PGHOST) {
  const host = process.env.PGHOST;
  const port = process.env.PGPORT || 5432;
  const user = process.env.PGUSER || 'postgres';
  const pass = process.env.PGPASSWORD || '';
  const db = process.env.PGDATABASE || 'railway';
  process.env.DATABASE_URL = `postgresql://${user}:${pass}@${host}:${port}/${db}`;
  console.log(`Built DATABASE_URL from PG* vars → ${host}:${port}/${db}`);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const SALT_ROUNDS = 10;

// ---------------------------------------------------------------------------
// Demo Users (other people in Jayden's flocks)
// ---------------------------------------------------------------------------
const demoUsers = [
  {
    name: 'Mike Rodriguez',
    email: 'mike@demo.com',
    password: 'demo123',
    interests: ['Sports', 'Beer', 'Trivia', 'Gaming'],
  },
  {
    name: 'Emma Taylor',
    email: 'emma@demo.com',
    password: 'demo123',
    interests: ['Coffee', 'Art', 'Wine', 'Nightlife'],
  },
  {
    name: 'Alex Johnson',
    email: 'alex@demo.com',
    password: 'demo123',
    interests: ['Food', 'Nightlife', 'Comedy', 'Karaoke'],
  },
  {
    name: 'Jordan Lee',
    email: 'jordan@demo.com',
    password: 'demo123',
    interests: ['Sports', 'Live Music', 'Pool', 'Darts'],
  },
];

// ---------------------------------------------------------------------------
// Helper — relative timestamps
// ---------------------------------------------------------------------------
function hoursFromNow(h) {
  return new Date(Date.now() + h * 60 * 60 * 1000);
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

function minutesAgo(m) {
  return new Date(Date.now() - m * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Main seed function
// ---------------------------------------------------------------------------
async function seed() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    console.log('Starting demo data seed...\n');

    // --------------------------------------------------
    // 0. Ensure stories table exists
    // --------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS stories (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        image_url TEXT NOT NULL,
        caption TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP DEFAULT (NOW() + INTERVAL '24 hours')
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_stories_user ON stories(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_stories_expires ON stories(expires_at)`);

    // --------------------------------------------------
    // 1. Clean previous demo data
    // --------------------------------------------------
    console.log('Cleaning previous demo data...');

    const existing = await client.query(
      `SELECT id FROM users WHERE email LIKE '%@demo.com'`
    );
    const existingIds = existing.rows.map((r) => r.id);

    if (existingIds.length > 0) {
      const idList = existingIds.join(',');
      await client.query(`DELETE FROM stories WHERE user_id IN (${idList})`);
      await client.query(`DELETE FROM emoji_reactions WHERE user_id IN (${idList})`);
      await client.query(`DELETE FROM messages WHERE sender_id IN (${idList})`);
      await client.query(`DELETE FROM direct_messages WHERE sender_id IN (${idList}) OR receiver_id IN (${idList})`);
      await client.query(`DELETE FROM venue_votes WHERE user_id IN (${idList})`);
      await client.query(`DELETE FROM flock_members WHERE user_id IN (${idList})`);
      await client.query(`DELETE FROM flocks WHERE creator_id IN (${idList})`);
      await client.query(`DELETE FROM users WHERE id IN (${idList})`);
      console.log(`  Removed ${existingIds.length} previous demo users and related data.`);
    } else {
      console.log('  No previous demo data found.');
    }

    // --------------------------------------------------
    // 2. Create demo users
    // --------------------------------------------------
    console.log('\nCreating demo users...');
    const userIds = {};

    for (const u of demoUsers) {
      const hashed = await bcrypt.hash(u.password, SALT_ROUNDS);
      const result = await client.query(
        `INSERT INTO users (email, password, name, interests)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, email`,
        [u.email, hashed, u.name, u.interests]
      );
      const user = result.rows[0];
      userIds[u.email] = user.id;
      console.log(`  + ${user.name} (${user.email}) → id ${user.id}`);
    }

    const mike = userIds['mike@demo.com'];
    const emma = userIds['emma@demo.com'];
    const alex = userIds['alex@demo.com'];
    const jordan = userIds['jordan@demo.com'];

    // --------------------------------------------------
    // 3. Look up or create real account
    // --------------------------------------------------
    // Note: express-validator normalizeEmail() strips dots from Gmail
    // so Bansal.jayden@gmail.com becomes bansaljayden@gmail.com in the DB
    const REAL_EMAIL = 'bansaljayden@gmail.com';
    console.log(`\nSetting up real account (${REAL_EMAIL})...`);
    let realJayden;
    const realLookup = await client.query(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1)`,
      [REAL_EMAIL]
    );
    if (realLookup.rows.length > 0) {
      realJayden = realLookup.rows[0].id;
      console.log(`  Found real account → id ${realJayden}`);

      // Clean previous flocks/messages/stories linked to real account so we start fresh
      await client.query(`DELETE FROM stories WHERE user_id = $1`, [realJayden]);
      await client.query(`DELETE FROM emoji_reactions WHERE message_id IN (SELECT id FROM messages WHERE sender_id = $1)`, [realJayden]);
      await client.query(`DELETE FROM messages WHERE sender_id = $1`, [realJayden]);
      await client.query(`DELETE FROM messages WHERE flock_id IN (SELECT id FROM flocks WHERE creator_id = $1)`, [realJayden]);
      await client.query(`DELETE FROM venue_votes WHERE user_id = $1`, [realJayden]);
      await client.query(`DELETE FROM flock_members WHERE user_id = $1`, [realJayden]);
      await client.query(`DELETE FROM flock_members WHERE flock_id IN (SELECT id FROM flocks WHERE creator_id = $1)`, [realJayden]);
      await client.query(`DELETE FROM flocks WHERE creator_id = $1`, [realJayden]);
      console.log('  Cleaned previous demo data for real account.');
    } else {
      const hashed = await bcrypt.hash('REDACTED_PASSWORD', SALT_ROUNDS);
      const result = await client.query(
        `INSERT INTO users (email, password, name, interests)
         VALUES ($1, $2, 'Jayden Bansal', $3)
         RETURNING id`,
        [REAL_EMAIL, hashed, ['entrepreneurship', 'technology', 'business', 'innovation']]
      );
      realJayden = result.rows[0].id;
      console.log(`  Created real account → id ${realJayden}`);
    }

    // --------------------------------------------------
    // 4. Create flocks for real account
    // --------------------------------------------------
    console.log('\nCreating flocks for real account...');

    const flockDefs = [
      {
        name: 'DECA Nationals Prep',
        creator: realJayden,
        venue_name: 'Linderman Library',
        venue_address: '30 Library Dr, Bethlehem',
        event_time: hoursFromNow(18),
        status: 'confirmed',
        members: [
          { uid: emma, status: 'accepted' },
          { uid: alex, status: 'accepted' },
          { uid: jordan, status: 'accepted' },
        ],
      },
      {
        name: 'Weekend Hangout Plans',
        creator: realJayden,
        venue_name: 'The Steel Pub',
        venue_address: '55 E 3rd St, Bethlehem',
        event_time: hoursFromNow(6),
        status: 'planning',
        members: [
          { uid: mike, status: 'accepted' },
          { uid: emma, status: 'accepted' },
          { uid: jordan, status: 'invited' },
        ],
      },
      {
        name: 'Study Session',
        creator: alex,
        venue_name: 'Rauch Business Center',
        venue_address: '621 Taylor St, Bethlehem',
        event_time: hoursFromNow(24),
        status: 'confirmed',
        members: [
          { uid: realJayden, status: 'accepted' },
          { uid: emma, status: 'accepted' },
        ],
      },
      {
        name: 'Friday Night Out',
        creator: mike,
        venue_name: null,
        venue_address: null,
        event_time: hoursFromNow(48),
        status: 'planning',
        members: [
          { uid: realJayden, status: 'accepted' },
          { uid: emma, status: 'accepted' },
          { uid: jordan, status: 'accepted' },
          { uid: alex, status: 'invited' },
        ],
      },
      {
        name: 'Sunday Brunch Crew',
        creator: emma,
        venue_name: "Molinari's",
        venue_address: '322 E 3rd St, Bethlehem',
        event_time: hoursFromNow(40),
        status: 'confirmed',
        members: [
          { uid: realJayden, status: 'accepted' },
          { uid: alex, status: 'accepted' },
          { uid: jordan, status: 'accepted' },
        ],
      },
    ];

    const flockIds = {};

    for (const f of flockDefs) {
      const result = await client.query(
        `INSERT INTO flocks (name, creator_id, venue_name, venue_address, event_time, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name`,
        [f.name, f.creator, f.venue_name, f.venue_address, f.event_time, f.status]
      );
      const flock = result.rows[0];
      flockIds[f.name] = flock.id;

      // Add creator as accepted member
      await client.query(
        `INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, 'accepted')`,
        [flock.id, f.creator]
      );

      // Add other members
      for (const m of f.members) {
        await client.query(
          `INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, $3)`,
          [flock.id, m.uid, m.status]
        );
      }

      const memberCount = f.members.length + 1;
      console.log(`  + "${flock.name}" → id ${flock.id} (${memberCount} members, ${f.status})`);
    }

    // --------------------------------------------------
    // 5. Create messages across all flocks
    // --------------------------------------------------
    console.log('\nCreating messages...');
    let messageCount = 0;

    async function msg(flockName, senderId, text, agoMinutes) {
      await client.query(
        `INSERT INTO messages (flock_id, sender_id, message_text, message_type, created_at)
         VALUES ($1, $2, $3, 'text', $4)`,
        [flockIds[flockName], senderId, text, minutesAgo(agoMinutes)]
      );
      messageCount++;
    }

    // --- DECA Nationals Prep (8 messages) ---
    await msg('DECA Nationals Prep', realJayden, "Alright team, nationals are in 3 weeks. We need to lock in 🔒", 2800);
    await msg('DECA Nationals Prep', emma, "I've been working on the marketing section, it's looking solid", 2750);
    await msg('DECA Nationals Prep', alex, "Same here, financial analysis is almost done. Need to run projections one more time", 2700);
    await msg('DECA Nationals Prep', realJayden, "Let's meet tomorrow to run through the full presentation", 2650);
    await msg('DECA Nationals Prep', jordan, "I'll bring the printed materials and practice scorecards", 2600);
    await msg('DECA Nationals Prep', realJayden, "Perfect. We should also practice the Q&A section, judges always throw curveballs", 2550);
    await msg('DECA Nationals Prep', emma, "Good call. Last time they grilled us on competitive analysis", 2500);
    await msg('DECA Nationals Prep', alex, "I've researched all the top competitors. We're ready for that this time", 2450);
    await msg('DECA Nationals Prep', realJayden, "This is our year. Let's bring home the trophy 🏆", 2400);
    await msg('DECA Nationals Prep', jordan, "LET'S GOOO", 2380);

    // --- Weekend Hangout Plans (10 messages) ---
    await msg('Weekend Hangout Plans', realJayden, "yo what's everyone doing Saturday?", 480);
    await msg('Weekend Hangout Plans', mike, "nothing yet, what you thinking?", 475);
    await msg('Weekend Hangout Plans', realJayden, "maybe Steel Pub? happy hour starts at 4", 470);
    await msg('Weekend Hangout Plans', emma, "I'm in! haven't been there in a while", 460);
    await msg('Weekend Hangout Plans', realJayden, "bet, let's roll around 5ish?", 450);
    await msg('Weekend Hangout Plans', mike, "works for me, their wings are fire 🔥", 440);
    await msg('Weekend Hangout Plans', emma, "ooh yes get the garlic parm ones", 430);
    await msg('Weekend Hangout Plans', realJayden, "noted 📝 Jordan you coming?", 420);
    await msg('Weekend Hangout Plans', mike, "tell Jordan no excuses this time 😂", 410);
    await msg('Weekend Hangout Plans', realJayden, "lmao fr, he always flakes last minute", 400);

    // --- Study Session (8 messages) ---
    await msg('Study Session', alex, "exam is Wednesday, we should probably start studying lol", 1200);
    await msg('Study Session', realJayden, "yeah I haven't even looked at chapter 5 yet 😬", 1180);
    await msg('Study Session', emma, "same... the recursion stuff is confusing", 1160);
    await msg('Study Session', alex, "let's meet at Rauch tomorrow, I can explain the recursion concepts", 1140);
    await msg('Study Session', realJayden, "you're a lifesaver fr", 1120);
    await msg('Study Session', emma, "what time? I'm free after 2", 1100);
    await msg('Study Session', alex, "2pm works, I'll grab the big study room", 1080);
    await msg('Study Session', realJayden, "I'll bring coffee for everyone ☕ we're gonna need it", 1060);

    // --- Friday Night Out (10 messages) ---
    await msg('Friday Night Out', mike, "friday plans?? we gotta go out", 3600);
    await msg('Friday Night Out', realJayden, "I'm so down, this week has been brutal", 3550);
    await msg('Friday Night Out', emma, "same 😩 I need to decompress", 3500);
    await msg('Friday Night Out', jordan, "downtown? or someone's place first?", 3450);
    await msg('Friday Night Out', mike, "pregame at mine then head out?", 3400);
    await msg('Friday Night Out', realJayden, "that's the move. what time should we come over?", 3350);
    await msg('Friday Night Out', mike, "like 8? then we hit downtown around 10", 3300);
    await msg('Friday Night Out', emma, "perfect, gives me time to get ready", 3250);
    await msg('Friday Night Out', jordan, "I'll bring the speaker 🔊", 3200);
    await msg('Friday Night Out', realJayden, "this is gonna be a good night 🎉", 3150);

    // --- Sunday Brunch Crew (7 messages) ---
    await msg('Sunday Brunch Crew', emma, "who's doing brunch Sunday?", 1500);
    await msg('Sunday Brunch Crew', realJayden, "me!! Molinari's?", 1480);
    await msg('Sunday Brunch Crew', alex, "bottomless mimosas? say less 🥂", 1460);
    await msg('Sunday Brunch Crew', jordan, "their french toast is unreal", 1440);
    await msg('Sunday Brunch Crew', realJayden, "11am? I don't wanna wake up too early lol", 1420);
    await msg('Sunday Brunch Crew', emma, "11 is perfect, I'll make a reservation", 1400);
    await msg('Sunday Brunch Crew', realJayden, "you're the best Emma 🙌", 1380);

    // --------------------------------------------------
    // 6. Seed demo stories
    // --------------------------------------------------
    console.log('\nCreating stories...');

    const storyDefs = [
      { user: realJayden, image: 'https://picsum.photos/seed/flock1/400/600', caption: 'Grinding for DECA nationals 💪', hoursAgo: 1 },
      { user: mike,       image: 'https://picsum.photos/seed/flock2/400/600', caption: 'Game day vibes 🏈',             hoursAgo: 2 },
      { user: emma,       image: 'https://picsum.photos/seed/flock3/400/600', caption: 'Coffee and code ☕',             hoursAgo: 3 },
      { user: realJayden, image: 'https://picsum.photos/seed/flock4/400/600', caption: 'Late night study session 📚',    hoursAgo: 4 },
      { user: alex,       image: 'https://picsum.photos/seed/flock5/400/600', caption: 'Downtown adventures 🌃',         hoursAgo: 5 },
      { user: jordan,     image: 'https://picsum.photos/seed/flock6/400/600', caption: 'Cooking something up 🍳',        hoursAgo: 6 },
      { user: emma,       image: 'https://picsum.photos/seed/flock7/400/600', caption: 'Art gallery finds 🎨',           hoursAgo: 8 },
      { user: mike,       image: 'https://picsum.photos/seed/flock8/400/600', caption: 'Sunset views 🌅',               hoursAgo: 9 },
      { user: alex,       image: 'https://picsum.photos/seed/flock9/400/600', caption: 'Weekend plans loading... 🔄',    hoursAgo: 10 },
      { user: jordan,     image: 'https://picsum.photos/seed/flock10/400/600', caption: 'New spot just dropped 📍',      hoursAgo: 11 },
    ];

    let storyCount = 0;
    for (const s of storyDefs) {
      const createdAt = hoursAgo(s.hoursAgo);
      const expiresAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000); // 24hr after creation
      await client.query(
        `INSERT INTO stories (user_id, image_url, caption, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [s.user, s.image, s.caption, createdAt, expiresAt]
      );
      storyCount++;
    }
    console.log(`  Created ${storyCount} stories.`);

    // --------------------------------------------------
    // 7. Verify everything is linked
    // --------------------------------------------------
    console.log('\nVerifying data...');

    const userCheck = await client.query(
      `SELECT id, email, name FROM users WHERE LOWER(email) = LOWER($1)`,
      [REAL_EMAIL]
    );
    console.log(`  User: ${userCheck.rows[0].name} (${userCheck.rows[0].email}) → id ${userCheck.rows[0].id}`);

    const flockCheck = await client.query(
      `SELECT f.id, f.name, f.status, COUNT(fm.id) as member_count
       FROM flocks f
       JOIN flock_members fm ON fm.flock_id = f.id
       WHERE f.id IN (SELECT flock_id FROM flock_members WHERE user_id = $1)
       GROUP BY f.id, f.name, f.status
       ORDER BY f.id`,
      [realJayden]
    );
    console.log(`  Flocks: ${flockCheck.rows.length}`);
    for (const f of flockCheck.rows) {
      console.log(`    - "${f.name}" (${f.status}, ${f.member_count} members)`);
    }

    const msgCheck = await client.query(
      `SELECT COUNT(*) as count FROM messages WHERE flock_id IN (SELECT flock_id FROM flock_members WHERE user_id = $1)`,
      [realJayden]
    );
    console.log(`  Messages across flocks: ${msgCheck.rows[0].count}`);

    const myMsgCheck = await client.query(
      `SELECT COUNT(*) as count FROM messages WHERE sender_id = $1`,
      [realJayden]
    );
    console.log(`  Messages from Jayden: ${myMsgCheck.rows[0].count}`);

    const storyCheck = await client.query(
      `SELECT COUNT(*) as count FROM stories WHERE expires_at > NOW()`
    );
    console.log(`  Active stories: ${storyCheck.rows[0].count}`);

    // --------------------------------------------------
    // Done
    // --------------------------------------------------
    await client.query('COMMIT');

    console.log('\n========================================');
    console.log('  Demo data seeded successfully!');
    console.log('========================================');
    console.log(`  Demo users: ${demoUsers.length}`);
    console.log(`  Flocks:     ${flockDefs.length}`);
    console.log(`  Messages:   ${messageCount}`);
    console.log(`  Stories:    ${storyCount}`);
    console.log(`  Real account: Bansal.jayden@gmail.com → id ${realJayden}`);
    console.log('\n  Login credentials:');
    console.log('  Email:    Bansal.jayden@gmail.com');
    console.log('  Password: REDACTED_PASSWORD');
    console.log('========================================\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nSeed failed, rolling back...');
    console.error(err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
