require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const SALT_ROUNDS = 10;

// ---------------------------------------------------------------------------
// Demo Users
// ---------------------------------------------------------------------------
const demoUsers = [
  {
    name: 'Jayden Bansal',
    email: 'jayden@demo.com',
    password: 'demo123',
    interests: ['Nightlife', 'Live Music', 'Food', 'Cocktails'],
  },
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
    // 1. Clean previous demo data
    // --------------------------------------------------
    console.log('Cleaning previous demo data...');

    // Find existing demo user IDs
    const existing = await client.query(
      `SELECT id FROM users WHERE email LIKE '%@demo.com'`
    );
    const existingIds = existing.rows.map((r) => r.id);

    if (existingIds.length > 0) {
      const idList = existingIds.join(',');
      // Delete in dependency order
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
    // 2. Create users
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

    const jayden = userIds['jayden@demo.com'];
    const mike = userIds['mike@demo.com'];
    const emma = userIds['emma@demo.com'];
    const alex = userIds['alex@demo.com'];
    const jordan = userIds['jordan@demo.com'];

    // --------------------------------------------------
    // 3. Create flocks
    // --------------------------------------------------
    console.log('\nCreating demo flocks...');

    const flockDefs = [
      {
        name: 'Friday Night Downtown',
        creator: jayden,
        venue_name: 'Blue Heron Bar',
        venue_address: '123 N 3rd St, Easton',
        event_time: hoursFromNow(3),
        status: 'confirmed',
        members: [
          { uid: mike, status: 'accepted' },
          { uid: alex, status: 'accepted' },
          { uid: jordan, status: 'accepted' },
          { uid: emma, status: 'accepted' },
        ],
      },
      {
        name: 'Weekend Brunch Crew',
        creator: emma,
        venue_name: null,
        venue_address: null,
        event_time: hoursFromNow(20),
        status: 'planning',
        members: [
          { uid: jayden, status: 'accepted' },
          { uid: alex, status: 'accepted' },
          { uid: jordan, status: 'invited' },
        ],
      },
      {
        name: 'Study Session @ Library',
        creator: alex,
        venue_name: 'Linderman Library',
        venue_address: '30 Library Dr, Bethlehem',
        event_time: hoursFromNow(18),
        status: 'planning',
        members: [
          { uid: emma, status: 'accepted' },
          { uid: jordan, status: 'accepted' },
        ],
      },
      {
        name: 'Late Night Tacos Run',
        creator: mike,
        venue_name: 'Tulum',
        venue_address: '21 E 4th St, Bethlehem',
        event_time: hoursAgo(14),
        status: 'completed',
        members: [
          { uid: alex, status: 'accepted' },
          { uid: jordan, status: 'accepted' },
          { uid: jayden, status: 'accepted' },
        ],
      },
      {
        name: 'Movie Night Plans',
        creator: jordan,
        venue_name: null,
        venue_address: null,
        event_time: hoursFromNow(48),
        status: 'planning',
        members: [
          { uid: jayden, status: 'accepted' },
          { uid: mike, status: 'invited' },
          { uid: emma, status: 'accepted' },
          { uid: alex, status: 'invited' },
        ],
      },
      {
        name: 'Coffee & Catch Up',
        creator: emma,
        venue_name: 'Local Grounds Cafe',
        venue_address: '14 E 3rd St, Bethlehem',
        event_time: hoursFromNow(22),
        status: 'confirmed',
        members: [
          { uid: jayden, status: 'accepted' },
          { uid: alex, status: 'accepted' },
        ],
      },
      {
        name: 'Birthday Dinner for Jayden',
        creator: alex,
        venue_name: null,
        venue_address: null,
        event_time: hoursFromNow(168),
        status: 'planning',
        members: [
          { uid: mike, status: 'accepted' },
          { uid: emma, status: 'accepted' },
          { uid: jordan, status: 'accepted' },
        ],
      },
      {
        name: 'Pickup Basketball Game',
        creator: mike,
        venue_name: 'Community Court',
        venue_address: '500 Bushkill Dr, Easton',
        event_time: hoursFromNow(1),
        status: 'confirmed',
        members: [
          { uid: jordan, status: 'accepted' },
          { uid: alex, status: 'accepted' },
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
    // 4. Create messages
    // --------------------------------------------------
    console.log('\nCreating demo messages...');
    let messageCount = 0;

    async function msg(flockName, senderId, text, agoMinutes) {
      await client.query(
        `INSERT INTO messages (flock_id, sender_id, message_text, message_type, created_at)
         VALUES ($1, $2, $3, 'text', $4)`,
        [flockIds[flockName], senderId, text, minutesAgo(agoMinutes)]
      );
      messageCount++;
    }

    // --- Friday Night Downtown ---
    await msg('Friday Night Downtown', jayden, "who's ready for tonight?? 🎉", 180);
    await msg('Friday Night Downtown', mike, "let's gooo! what time we meeting?", 175);
    await msg('Friday Night Downtown', jayden, "I was thinking 7pm? happy hour ends at 8", 170);
    await msg('Friday Night Downtown', alex, "7 works for me! I'll be coming from campus", 160);
    await msg('Friday Night Downtown', jordan, "same, I'm in! should we grab a table or bar seats?", 155);
    await msg('Friday Night Downtown', emma, "table for sure, it gets packed on Fridays", 148);
    await msg('Friday Night Downtown', jayden, "I'll get there early and grab one", 140);
    await msg('Friday Night Downtown', mike, "legend 🙌", 138);
    await msg('Friday Night Downtown', alex, "anyone tried their new cocktail menu?", 90);
    await msg('Friday Night Downtown', emma, "yes! the spicy margarita is incredible", 85);
    await msg('Friday Night Downtown', jordan, "say less, I'm getting that", 80);
    await msg('Friday Night Downtown', jayden, "ok I just got here, table by the window 🪟", 15);
    await msg('Friday Night Downtown', mike, "on my way! 5 min", 12);
    await msg('Friday Night Downtown', alex, "same, walking over now", 10);

    // --- Weekend Brunch Crew ---
    await msg('Weekend Brunch Crew', emma, "brunch tomorrow? I need it after this week 😩", 300);
    await msg('Weekend Brunch Crew', jayden, "YES. absolutely. where though?", 295);
    await msg('Weekend Brunch Crew', alex, "that new place on 4th has amazing avocado toast", 288);
    await msg('Weekend Brunch Crew', emma, "oooh or we could do Molinari's, they have bottomless mimosas", 280);
    await msg('Weekend Brunch Crew', jayden, "you had me at bottomless mimosas 🥂", 275);
    await msg('Weekend Brunch Crew', alex, "haha ok that settles it. 11am?", 270);
    await msg('Weekend Brunch Crew', emma, "perfect! Jordan, you in?", 265);

    // --- Study Session @ Library ---
    await msg('Study Session @ Library', alex, "midterms are killing me, anyone want to study together?", 420);
    await msg('Study Session @ Library', emma, "yes please, I can't focus at home", 415);
    await msg('Study Session @ Library', jordan, "I'm down. Linderman 3rd floor?", 410);
    await msg('Study Session @ Library', alex, "yep, the quiet section. tomorrow 3pm?", 405);
    await msg('Study Session @ Library', emma, "works for me! I'll bring snacks", 400);
    await msg('Study Session @ Library', jordan, "MVP 🏆", 395);

    // --- Late Night Tacos Run ---
    await msg('Late Night Tacos Run', mike, "yo who's hungry? taco run??", 900);
    await msg('Late Night Tacos Run', alex, "bro it's 11pm", 895);
    await msg('Late Night Tacos Run', mike, "...and? tacos don't have a bedtime 🌮", 893);
    await msg('Late Night Tacos Run', jordan, "lmaooo I'm in actually", 890);
    await msg('Late Night Tacos Run', jayden, "wait for me!! omw", 885);
    await msg('Late Night Tacos Run', alex, "fine fine, meet at Tulum in 10?", 882);
    await msg('Late Night Tacos Run', mike, "let's ride 🚗", 880);
    await msg('Late Night Tacos Run', jordan, "just got here, they have a table open", 870);
    await msg('Late Night Tacos Run', jayden, "the al pastor is unreal", 855);
    await msg('Late Night Tacos Run', mike, "best decision we've made all week", 850);

    // --- Movie Night Plans ---
    await msg('Movie Night Plans', jordan, "movie night Friday? my place or theater?", 500);
    await msg('Movie Night Plans', jayden, "theater! I wanna see that new thriller", 495);
    await msg('Movie Night Plans', emma, "ooh yes, I've heard it's so good", 490);
    await msg('Movie Night Plans', jordan, "cool, I'll check showtimes. 8pm showing work?", 485);
    await msg('Movie Night Plans', jayden, "perfect 🍿", 480);
    await msg('Movie Night Plans', emma, "should we do dinner before?", 475);
    await msg('Movie Night Plans', jordan, "great idea, maybe that pizza place next door", 470);

    // --- Coffee & Catch Up ---
    await msg('Coffee & Catch Up', emma, "I miss you guys, coffee date soon?", 360);
    await msg('Coffee & Catch Up', jayden, "tomorrow? Local Grounds has that new oat milk latte", 355);
    await msg('Coffee & Catch Up', alex, "I'm free after 2! been wanting to try that", 350);
    await msg('Coffee & Catch Up', emma, "2pm it is! I have so much to tell you both", 345);
    await msg('Coffee & Catch Up', jayden, "ooh tea ☕ can't wait", 340);

    // --- Birthday Dinner for Jayden ---
    await msg('Birthday Dinner for Jayden', alex, "ok team, Jayden's birthday is next Saturday 🎂", 720);
    await msg('Birthday Dinner for Jayden', mike, "we gotta make it special! any restaurant ideas?", 715);
    await msg('Birthday Dinner for Jayden', emma, "what about that rooftop place? he mentioned wanting to go", 710);
    await msg('Birthday Dinner for Jayden', jordan, "Rooftop @ The Grand? yes that's perfect", 705);
    await msg('Birthday Dinner for Jayden', alex, "love it. I'll make a reservation. 7pm?", 700);
    await msg('Birthday Dinner for Jayden', mike, "should we do a surprise or tell him?", 695);
    await msg('Birthday Dinner for Jayden', emma, "surprise!! he'll love it", 690);
    await msg('Birthday Dinner for Jayden', jordan, "my lips are sealed 🤐", 685);

    // --- Pickup Basketball Game ---
    await msg('Pickup Basketball Game', mike, "hoops today? community court at 5", 240);
    await msg('Pickup Basketball Game', jordan, "you already know I'm there 🏀", 235);
    await msg('Pickup Basketball Game', alex, "count me in, I need to blow off steam", 230);
    await msg('Pickup Basketball Game', mike, "nice! 3v3 if we can get a few more", 225);
    await msg('Pickup Basketball Game', jordan, "I'll ask around. bring water it's hot out", 220);
    await msg('Pickup Basketball Game', alex, "and bring your A game 😤", 215);
    await msg('Pickup Basketball Game', mike, "always 💪", 210);

    // --------------------------------------------------
    // Done
    // --------------------------------------------------
    await client.query('COMMIT');

    console.log('\n========================================');
    console.log('  Demo data seeded successfully!');
    console.log('========================================');
    console.log(`  Users:    ${demoUsers.length}`);
    console.log(`  Flocks:   ${flockDefs.length}`);
    console.log(`  Messages: ${messageCount}`);
    console.log('\n  Login with any demo account:');
    console.log('  Email:    jayden@demo.com (or mike/emma/alex/jordan)');
    console.log('  Password: demo123');
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
