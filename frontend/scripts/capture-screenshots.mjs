#!/usr/bin/env node
/**
 * capture-screenshots.mjs — reproducible marketing + App Store screenshots.
 *
 * Boots the WHOLE product locally against a throwaway embedded Postgres,
 * seeds it with plausible demo data, builds the real frontend against that
 * backend, and drives a real Chromium through the real app in light AND dark
 * mode at web and App Store sizes. Every pixel captured is the actual app
 * rendering rows that exist in the seeded database. No mockups.
 *
 * Run:  node scripts/capture-screenshots.mjs            (from frontend/)
 *       node scripts/capture-screenshots.mjs --skip-build   (reuse last build)
 *       node scripts/capture-screenshots.mjs --only=nest,birdie
 *       node scripts/capture-screenshots.mjs --set=web      (web|appstore|all)
 *
 * THIS RUN COSTS MONEY. The backend child keeps the real external API keys
 * on purpose, which is what makes the screens real, and `discover` and `crowd`
 * both perform live Google Places searches. A capture is therefore not free and
 * not idempotent: running it in a loop while iterating spends quota on a key
 * whose photo cache has already been the subject of one cost incident. Use
 * --only to drive the one screen you are working on, and expect discover and
 * crowd to be the two that fail first when the API pushes back.
 *
 * PRODUCTION SAFETY (read before touching):
 *   - The database is an embedded Postgres in a temp dir, created fresh every
 *     run and torn down after. Its port is random.
 *   - The backend child process gets DATABASE_URL *and every PG\* variable*
 *     pinned to that embedded instance IN ITS ENVIRONMENT. dotenv never
 *     overrides variables that already exist, so backend/.env's Railway
 *     values cannot reach the pool. This is the same defense e2e-local.js
 *     uses, doubled: both the URL and the PG* fallback path are pinned.
 *   - BestTime + Railway tokens are blanked. The only .env values the child
 *     can still read are external API keys (Places, Gemini, weather), which
 *     make the screens real and never touch the production database.
 *
 * Outputs land in frontend/public/screenshots/ (web set, PNG + WebP, deployed
 * with the site) and store-assets/ at the repo root (App Store set, PNG, alpha
 * flattened per Apple spec). The App Store set is deliberately OUTSIDE public/:
 * it is 56 MB of submission material with no reason to be fetchable on the web,
 * and store-assets/ is gitignored. manifest.json and WIRING.md are written into
 * the web set.
 *
 * ONLY WHAT SHIPS STAYS IN public/. After a run, every web capture that no
 * source file, public/index.html or public/manifest.json references is moved
 * to frontend/screenshots/ (tracked, not deployed, not in the iPhone bundle).
 * The full set used to ride along in every IPA: 34 files, 7.96 MB, for the
 * two the landing page shows and the four the PWA manifest lists.
 * publicScreenshotsShipped.test.js pins the rule.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(FRONTEND_DIR, '..');
const BACKEND_DIR = path.join(REPO_ROOT, 'backend');
const OUT_DIR = path.join(FRONTEND_DIR, 'public', 'screenshots');
const APPSTORE_DIR = path.join(REPO_ROOT, 'store-assets');

// CommonJS deps live in the two package roots; reach them explicitly so this
// script works no matter what cwd it is launched from.
const requireBackend = createRequire(path.join(BACKEND_DIR, 'package.json'));
const requireFrontend = createRequire(path.join(FRONTEND_DIR, 'package.json'));

const { Client } = requireBackend('pg');
const bcrypt = requireBackend('bcryptjs');

// ---------------------------------------------------------------------------
// Fixed ports. The API port is baked into the CRA build (REACT_APP_API_URL is
// inlined at build time), so it must be stable for --skip-build to be usable.
// ---------------------------------------------------------------------------
const API_PORT = 5210;
const WEB_PORT = 3410;
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};
const ONLY = opt('only') ? opt('only').split(',').map((s) => s.trim()) : null;
const SET = opt('set') || 'all'; // web | appstore | all
const SKIP_BUILD = flag('skip-build');
const KEEP_ALIVE = flag('keep-alive'); // leave the stack up for manual poking

// Scratch space OUTSIDE the repo: the CRA build output and the pg data dir.
const SCRATCH = path.join(os.tmpdir(), 'flock-screenshot-run');
const BUILD_DIR = path.join(SCRATCH, 'build');
const BUILD_STAMP = path.join(SCRATCH, 'build.stamp.json');

const log = (msg) => console.log(`[shots] ${msg}`);
const die = (msg) => { console.error(`[shots] FATAL: ${msg}`); process.exit(1); };

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function assertPortFree(port, what) {
  await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', () => reject(new Error(
      `port ${port} (${what}) is already in use. Another stack is running; stop it first.`
    )));
    srv.listen(port, '127.0.0.1', () => srv.close(resolve));
  }).catch((e) => die(e.message));
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return; } catch { /* keep waiting */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------------------
// 1. Embedded Postgres (verify-backup.js pattern: explicit UTF8 database —
//    Windows initdb otherwise inherits the OS locale and gets WIN1252).
// ---------------------------------------------------------------------------
async function startPostgres() {
  const EP = requireBackend('embedded-postgres');
  const EmbeddedPostgres = EP.default || EP;
  const port = await freePort();
  const dataDir = path.join(os.tmpdir(), `flock-shots-pg-${Date.now()}`);
  const pgLog = [];
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    onLog: (m) => pgLog.push(String(m)),
    onError: (m) => pgLog.push(String(m)),
  });
  log('starting embedded Postgres (first run downloads binaries)...');
  try {
    await pg.initialise();
    await pg.start();
    const admin = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres` });
    await admin.connect();
    await admin.query(`CREATE DATABASE flock_shots ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
    await admin.end();
  } catch (e) {
    console.error(pgLog.slice(-20).join('\n'));
    throw e;
  }
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/flock_shots`;
  log(`embedded Postgres up on :${port} (data: ${dataDir})`);
  return { pg, port, url, dataDir };
}

async function stopPostgresQuietly(pgHandle) {
  if (!pgHandle) return;
  try {
    await pgHandle.pg.stop();
  } catch {
    // Windows EBUSY on teardown: retry the dir removal, never fail the run.
    try {
      await fs.promises.rm(pgHandle.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (e2) {
      log(`(cleanup) could not remove ${pgHandle.dataDir}: ${e2.message} — delete by hand, results stand.`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Backend child process.
//
// cwd stays backend/ so dotenv can hand the child the EXTERNAL API keys that
// make screens real (Places, Gemini, weather). Every database-shaped variable
// is pinned locally below, and dotenv (by contract and by version pinned in
// backend/package.json) never overrides an existing environment variable, so
// backend/.env's Railway DATABASE_URL and PG* values are unreachable.
// ---------------------------------------------------------------------------
function backendEnv(dbUrl, dbPort) {
  return {
    // Minimal Windows/node base.
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT || process.env.SystemRoot,
    COMSPEC: process.env.COMSPEC,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    HOME: process.env.HOME,

    // THE SAFETY WALL. All seven pinned; dotenv cannot override any of them.
    DATABASE_URL: dbUrl,
    PGHOST: '127.0.0.1',
    PGPORT: String(dbPort),
    PGUSER: 'postgres',
    PGPASSWORD: 'postgres',
    PGDATABASE: 'flock_shots',
    PGSSLMODE: 'disable',

    // Blank the tokens nothing in a screenshot run should ever spend.
    BESTTIME_API_KEY: '',
    BESTTIME_API_KEY_PUBLIC: '',
    RAILWAY_API_TOKEN: '',
    RESEND_API_KEY: '',
    SENTRY_DSN: '',

    NODE_ENV: 'development',
    PORT: String(API_PORT),
    JWT_SECRET: 'screenshot-local-secret',
    FRONTEND_URL: WEB_ORIGIN, // CORS allowlist entry for the static server
  };
}

function startBackend(dbUrl, dbPort) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND_DIR,
    env: backendEnv(dbUrl, dbPort),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tail = [];
  const keep = (buf) => {
    const s = buf.toString();
    tail.push(s);
    if (tail.length > 60) tail.shift();
    if (process.env.SHOTS_VERBOSE) process.stdout.write(s);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('exit', (code) => {
    if (!child.expectedExit) {
      console.error(tail.join(''));
      die(`backend exited early with code ${code}`);
    }
  });
  return {
    child,
    async waitUp() {
      await waitFor(async () => {
        const r = await fetch(`${API_ORIGIN}/api/health`).catch(() => null);
        return r && r.ok;
      }, 60000, 'backend /api/health').catch((e) => {
        console.error(tail.join(''));
        throw e;
      });
      log(`backend up on :${API_PORT} (migrations applied on boot)`);
    },
    stop() {
      child.expectedExit = true;
      child.kill();
    },
  };
}

export { backendEnv }; // exported for eyeballing in a REPL, nothing imports it

// ---------------------------------------------------------------------------
// 3. Seed. The reviewer seed script gives auth-safe accounts; everything else
//    here writes the rows that make screens look inhabited. All content is
//    invented and neutral: no real people, no real venue names in seeded rows.
//    (The venue MAP intentionally shows live Google Places results, which is
//    exactly what the shipping app shows.)
// ---------------------------------------------------------------------------
const DEMO = {
  password: 'Screenshot1',
  camera: { email: 'maya@shots.flock.local', name: 'Judge' },
  friends: [
    { email: 'jordan@shots.flock.local', name: 'Jordan Avery' },
    { email: 'sam@shots.flock.local', name: 'Sam Rivera' },
    { email: 'priya@shots.flock.local', name: 'Priya Shah' },
    { email: 'leo@shots.flock.local', name: 'Leo Martin' },
  ],
  owner: { email: 'owner@shots.flock.local', name: 'Copper Finch Owner' },
  flockName: 'Friday Night Crew',
  // Invented venue used in chat cards, votes, and the owner dashboard.
  venue: {
    name: 'The Copper Finch',
    placeId: 'shots_copper_finch_0001',
    addr: '214 Main St',
    category: 'Bar & grill',
  },
  rivalVenueName: 'Juniper Bowl',
};

async function seed(dbUrl) {
  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  const q = (text, params) => db.query(text, params);
  const hash = await bcrypt.hash(DEMO.password, 10);

  const mkUser = async (u, role = 'user') => {
    const r = await q(
      `INSERT INTO users (email, password, name, role, terms_accepted_at, date_of_birth, email_verified, verified_email)
       VALUES ($1,$2,$3,$4,NOW(),'2004-06-15',TRUE,$1)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [u.email, hash, u.name, role]
    );
    return r.rows[0].id;
  };

  const maya = await mkUser(DEMO.camera);
  const ids = {};
  for (const f of DEMO.friends) ids[f.name.split(' ')[0].toLowerCase()] = await mkUser(f);
  const { jordan, sam, priya, leo } = ids;
  const owner = await mkUser(DEMO.owner, 'venue_owner');

  // Friendships: camera account is friends with everyone.
  for (const fid of [jordan, sam, priya, leo]) {
    await q(
      `INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1,$2,'accepted')
       ON CONFLICT (requester_id, addressee_id) DO UPDATE SET status='accepted'`,
      [fid, maya]
    );
  }

  // A light plan history so the profile does not read as a brand-new account,
  // and the numbers stay literally true of this database.
  await q(`UPDATE users SET total_plans_joined = 6, total_plans_attended = 5, reliability_score = 92 WHERE id = $1`, [maya]);

  // Next occurrence of a weekday at a local hour, always in the future, so
  // "Friday Night Crew" really lands on a Friday chip.
  const nextOccurrence = (dow, hour) => {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    let ahead = (dow - d.getDay() + 7) % 7;
    if (ahead === 0 && d <= new Date()) ahead = 7;
    d.setDate(d.getDate() + ahead);
    return d;
  };

  // ---- The flock -----------------------------------------------------------
  const f = await q(
    `INSERT INTO flocks (name, creator_id, event_time, status, budget_enabled)
     VALUES ($1,$2,$3,'planning', TRUE)
     RETURNING id`,
    [DEMO.flockName, maya, nextOccurrence(5, 20)]
  );
  const flockId = f.rows[0].id;
  for (const uid of [maya, jordan, sam, priya, leo]) {
    await q(
      `INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1,$2,'accepted')
       ON CONFLICT (flock_id, user_id) DO UPDATE SET status='accepted'`,
      [flockId, uid]
    );
  }

  // ---- Chat: real conversation shape, one venue card ----------------------
  const venueCard = {
    name: DEMO.venue.name,
    addr: DEMO.venue.addr,
    category: DEMO.venue.category,
    type: 'bar',
    stars: 4.6,
    rating: 4.6,
    price: '$$',
    price_level: 2,
    place_id: DEMO.venue.placeId,
    // Without this the card falls through to /marks/venue-placeholder.jpg, the
    // sparrow, and every screenshot of the vote flow shipped showing a bird
    // where a venue photo belongs. The Copper Finch is invented, so it has no
    // Google Places photo to fetch; this is a local demo still. A relative path
    // is correct here because resolveVenuePhoto only prefixes the API origin
    // for paths beginning "/api/".
    //
    // THE IMAGE IS GENERATED, AND IT HAS TO BE. The first version of this line
    // pointed at a Places photo of a real Allentown bar, captured out of the
    // running app and cropped into the repo. That is wrong three times over and
    // none of them are about whether the business is recognisable: the photo is
    // someone's copyrighted work, backend/services/photoStore.js documents that
    // NO clause of the Maps terms permits caching Places photo bytes at all
    // (which is why that cache expires by real DELETE and never writes a photo
    // name), and a file committed here is served from flockcorp.com, shipped
    // inside every Capacitor binary, and pushed to the repository, i.e.
    // redistributed and cached for ever. These screenshots also feed the
    // marketing site, so the photo would have been baked into those too.
    // Replace this file only with art Flock owns outright.
    photo_url: '/marks/venue-demo-bar.jpg',
  };
  const msgs = [
    [jordan, 'ok who is actually free friday', 'text', null, 55],
    [maya, 'me, any time after 7', 'text', null, 52],
    [sam, 'same. i can drive 4 people', 'text', null, 50],
    [priya, '7:30 works for me. where are we thinking', 'text', null, 41],
    [maya, `Check out ${DEMO.venue.name}!`, 'venue_card', venueCard, 30],
    [leo, 'down, their wings are unreal', 'text', null, 28],
    [jordan, 'voted. winner buys nothing, obviously', 'text', null, 26],
  ];
  const msgIds = [];
  for (const [uid, text, type, vd, minAgo] of msgs) {
    const r = await q(
      `INSERT INTO messages (flock_id, sender_id, message_text, message_type, venue_data, created_at)
       VALUES ($1,$2,$3,$4,$5, NOW() - ($6 || ' minutes')::interval) RETURNING id`,
      [flockId, uid, text, type, vd ? JSON.stringify(vd) : null, minAgo]
    );
    msgIds.push(r.rows[0].id);
  }
  // One reaction so chat shows the feature.
  await q(`INSERT INTO emoji_reactions (message_id, user_id, emoji) VALUES ($1,$2,'👀') ON CONFLICT DO NOTHING`, [msgIds[4], leo]);
  await q(`INSERT INTO emoji_reactions (message_id, user_id, emoji) VALUES ($1,$2,'🔥') ON CONFLICT DO NOTHING`, [msgIds[4], jordan]);

  // ---- Votes + anonymous budget -------------------------------------------
  for (const [uid, venue] of [[jordan, DEMO.venue.name], [leo, DEMO.venue.name], [maya, DEMO.venue.name], [priya, DEMO.rivalVenueName]]) {
    await q(
      `INSERT INTO venue_votes (flock_id, user_id, venue_name, venue_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [flockId, uid, venue, venue === DEMO.venue.name ? DEMO.venue.placeId : null]
    );
  }
  for (const [uid, amount] of [[maya, 35], [jordan, 30], [sam, 40], [priya, 25]]) {
    await q(
      `INSERT INTO budget_submissions (flock_id, user_id, amount, skipped) VALUES ($1,$2,$3,FALSE) ON CONFLICT DO NOTHING`,
      [flockId, uid, amount]
    );
  }

  // ---- Two more flocks so the Nest reads inhabited, not staged-empty ------
  const extraFlocks = [
    { name: 'Sunday Brunch', venue: 'Marigold Diner', when: nextOccurrence(0, 11), members: [maya, priya, sam] },
    { name: "Sam's Birthday", venue: 'Juniper Bowl', when: nextOccurrence(6, 19), members: [maya, sam, jordan, leo] },
  ];
  for (const ef of extraFlocks) {
    const r = await q(
      `INSERT INTO flocks (name, creator_id, venue_name, event_time, status)
       VALUES ($1,$2,$3,$4,'planning')
       RETURNING id`,
      [ef.name, ef.members[0] === maya ? maya : ef.members[0], ef.venue, ef.when]
    );
    for (const uid of ef.members) {
      await q(
        `INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1,$2,'accepted') ON CONFLICT (flock_id, user_id) DO NOTHING`,
        [r.rows[0].id, uid]
      );
    }
    await q(
      `INSERT INTO messages (flock_id, sender_id, message_text, message_type, created_at)
       VALUES ($1,$2,'who is in?','text', NOW() - interval '3 hours')`,
      [r.rows[0].id, ef.members[1]]
    );
  }

  // ---- DMs so the messages surface has more than one thread ----------------
  const dms = [
    [jordan, maya, 'you in for friday?', 190],
    [maya, jordan, 'yeah, already voted', 185],
    [jordan, maya, 'legend', 180],
  ];
  for (const [s, r2, text, minAgo] of dms) {
    await q(
      `INSERT INTO direct_messages (sender_id, receiver_id, message_text, message_type, created_at)
       VALUES ($1,$2,$3,'text', NOW() - ($4 || ' minutes')::interval)`,
      [s, r2, text, minAgo]
    );
  }

  // ---- Venue owner side ----------------------------------------------------
  await q(
    `INSERT INTO venue_profiles (user_id, business_name, category, location, description, google_place_id, verified, tier, operating_hours)
     VALUES ($1,$2,'Bar & grill','214 Main St','Wings, burgers, and a long bar. Busiest after 9.',$3,TRUE,'free','[]')
     ON CONFLICT (user_id) DO UPDATE SET google_place_id = EXCLUDED.google_place_id, verified = TRUE`,
    [owner, DEMO.venue.name, DEMO.venue.placeId]
  );
  await q(
    `INSERT INTO venue_promotions (venue_user_id, google_place_id, title, description, time_slot, days, active)
     VALUES ($1,$2,'Half-price wings','Every order of wings is half price at the bar.','9 PM to close','Thu, Fri, Sat',TRUE)`,
    [owner, DEMO.venue.placeId]
  );
  const reviews = [
    [jordan, 5, 'Went with four friends on a Friday, service kept up even at peak. Wings earn the hype.'],
    [priya, 4, 'Good spot for a group. Gets loud after 10 but that is kind of the point.'],
    [leo, 5, 'Fast kitchen, fair prices, easy to hold a table for six.'],
  ];
  for (const [uid, rating, text] of reviews) {
    await q(
      `INSERT INTO venue_reviews (google_place_id, user_id, rating, text) VALUES ($1,$2,$3,$4)
       ON CONFLICT (google_place_id, user_id) DO NOTHING`,
      [DEMO.venue.placeId, uid, rating, text]
    );
  }
  await q(
    `UPDATE venue_reviews SET venue_reply = 'Thanks Jordan. Friday crews are what we are built for.', venue_replied_at = NOW()
     WHERE google_place_id = $1 AND user_id = $2`,
    [DEMO.venue.placeId, jordan]
  );
  // An incoming flock headed at the venue (the dashboard's incoming list).
  await q(`UPDATE flocks SET venue_id = $1, venue_name = $2 WHERE id = $3`, [DEMO.venue.placeId, DEMO.venue.name, flockId]);

  // Live check-ins in the last hour: the occupancy figure the dashboard shows
  // is a real SUM over these rows.
  for (const [uid, minAgo] of [[jordan, 50], [sam, 35], [priya, 20], [leo, 10]]) {
    await q(
      `INSERT INTO venue_checkins (venue_place_id, user_id, checkin_source, created_at)
       VALUES ($1,$2,'manual', NOW() - ($3 || ' minutes')::interval)`,
      [DEMO.venue.placeId, uid, minAgo]
    );
  }

  // ML corpus entry + 168-hour baseline for the demo venue, so the crowd
  // pipeline treats it as a known venue with an evening-peaked week. Values
  // are a plausible bar curve; the numbers rendered are whatever the real
  // predictor computes from these rows.
  await q(
    `INSERT INTO ml_venues (google_place_id, name, address, city, latitude, longitude, venue_category, timezone, rating, review_count)
     VALUES ($1,$2,$3,'Bethlehem',40.6259,-75.3705,'bar','America/New_York',4.6,182)
     ON CONFLICT (google_place_id) DO NOTHING`,
    [DEMO.venue.placeId, DEMO.venue.name, DEMO.venue.addr]
  );
  const values = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      let base = 8;
      if (h >= 11 && h <= 13) base = 35;           // lunch
      if (h >= 17 && h <= 19) base = 45;           // early evening
      if (h >= 20 && h <= 23) base = (d === 5 || d === 6 || d === 4) ? 85 : 55; // Thu-Sat nights peak
      if (h >= 0 && h <= 2) base = 30;
      if (h >= 3 && h <= 9) base = 0;
      values.push(`('${DEMO.venue.placeId}', ${d}, ${h}, ${base}, 'collected')`);
    }
  }
  await q(`INSERT INTO ml_venue_baselines (google_place_id, day_of_week, hour, baseline, source) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`);

  await db.end();
  log(`seeded: 6 users, flock "${DEMO.flockName}" (${msgs.length} messages, 4 votes, 4 budgets), venue "${DEMO.venue.name}" (promo, 3 reviews, 4 live check-ins, 168 baseline rows)`);
  return { maya, flockId, owner };
}

// ---------------------------------------------------------------------------
// 4. Frontend build against the local API, output OUTSIDE the repo.
// ---------------------------------------------------------------------------
async function buildFrontend() {
  const stamp = { apiUrl: API_ORIGIN };
  if (SKIP_BUILD && fs.existsSync(path.join(BUILD_DIR, 'index.html')) && fs.existsSync(BUILD_STAMP)) {
    const old = JSON.parse(fs.readFileSync(BUILD_STAMP, 'utf8').replace(/^﻿/, ''));
    if (old.apiUrl === API_ORIGIN) {
      // The stamp tracks the API url and nothing else, so a build made before
      // your last edit is reused without complaint. That cost a full debug
      // cycle once: a fix was made, the capture re-run with --skip-build, and
      // the old bundle reported the old failure. Say so rather than making the
      // next person work it out.
      log('reusing existing build (--skip-build) - source edits since that build are NOT in it');
      // Re-applied on the reuse path too. It is idempotent in effect (the
      // origin is already listed on a build this run made), and without it a
      // build carried over from a run on a different port keeps a policy that
      // names a server this one is not using, which is the failure this
      // function exists to stop.
      allowLocalApiInCsp();
      return;
    }
    log('build stamp mismatch; rebuilding');
  }
  log('building frontend against the local API (a few minutes)...');
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['react-scripts', 'build'],
      {
        cwd: FRONTEND_DIR,
        shell: process.platform === 'win32',
        env: {
          ...process.env,
          REACT_APP_API_URL: API_ORIGIN,
          // No analytics or error reporting from a screenshot rig.
          REACT_APP_POSTHOG_KEY: '',
          REACT_APP_SENTRY_DSN: '',
          BUILD_PATH: BUILD_DIR,
          GENERATE_SOURCEMAP: 'false',
          CI: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`react-scripts build failed (${code}):\n${out.slice(-4000)}`));
    });
  });
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.writeFileSync(BUILD_STAMP, JSON.stringify(stamp));
  allowLocalApiInCsp();
  log(`build done -> ${BUILD_DIR}`);
}

/**
 * Let the throwaway build talk to the throwaway backend.
 *
 * WHY THIS IS HERE AT ALL. public/index.html carries a Content-Security-Policy
 * meta tag whose connect-src lists the production API and nothing else, which
 * is exactly right for a shipped build. react-scripts copies it verbatim, so
 * the build this rig makes against a local backend on 127.0.0.1 could not
 * reach it: every request was refused by the browser, the app painted
 * "Couldn't reach Flock", the tab bar never rendered and every driver timed
 * out after thirty seconds with no clue why.
 *
 * That is what had broken this rig, and it produces App Store submission
 * material, so it mattered more than it looked. It was invisible because the
 * failure reported only "Timeout 30000ms exceeded"; the diagnostics added
 * alongside this named the CSP on the first run.
 *
 * ONLY THE TEMP BUILD. BUILD_DIR lives under os.tmpdir() and is rebuilt from
 * scratch; frontend/public/index.html is never touched and neither is anything
 * that ships. The API origin is the one this process just started on a random
 * port, so the widened policy names a server that stops existing when the run
 * ends.
 */
function allowLocalApiInCsp() {
  const indexPath = path.join(BUILD_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) return;
  const html = fs.readFileSync(indexPath, 'utf8');
  // Both the http origin (REST) and its ws twin (Socket.IO), because the app
  // opens a socket as soon as a session lands and a refused socket is a second
  // silent failure behind the first.
  const wsOrigin = API_ORIGIN.replace(/^http/, 'ws');

  /* OPERATE ON THE POLICY, NOT ON THE FIRST TEXT THAT LOOKS LIKE IT.

     This used to run a bare `html.replace(/img-src ([^";]*)/, ...)` over the
     whole document, and it silently edited the wrong thing. The long comment
     above the meta tag in public/index.html explains the policy line by line,
     so it CONTAINS the string "img-src blob: data:" some four hundred
     characters before the real rule. The regex matched the comment, appended
     the local origin inside it, and left the actual policy untouched, so
     every venue image was still refused. `connect-src` never appears in that
     comment, which is exactly why data loaded and only images failed, and why
     the rig looked healthy while shipping screenshots with no venue photos in
     them at all.

     So: isolate the meta tag first, and widen directives only inside its
     content attribute. Prose about the policy can then say anything it likes. */
  const metaRe = /(<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*content=")([^"]*)(")/i;
  const meta = html.match(metaRe);
  if (!meta) {
    log('WARNING: no Content-Security-Policy meta tag in the built index.html; leaving it alone');
    return;
  }

  let policy = meta[2];
  const widenedDirectives = [];
  const widen = (directive, ...origins) => {
    // No backslash escapes in the pattern. Built as a template literal, `\s`
    // is not a valid JS escape and collapses to a bare `s`, so the pattern
    // silently became `(^|;s*)` and matched nothing: both directives were
    // left un-widened while this function still logged success. The policy
    // separator is only ever a semicolon and spaces, so say that literally.
    const re = new RegExp('(^|;[ ]*)' + directive + ' ([^;]*)');
    if (!re.test(policy)) {
      log(`WARNING: no ${directive} in the built policy; some requests may be refused`);
      return;
    }
    policy = policy.replace(re, (_m, lead, sources) => {
      const missing = origins.filter((o) => !sources.includes(o));
      return `${lead}${directive} ${sources}${missing.length ? " " + missing.join(" ") : ""}`;
    });
    widenedDirectives.push(directive);
  };

  widen('connect-src', API_ORIGIN, wsOrigin);   // REST and the socket
  widen('img-src', API_ORIGIN);                 // every venue photo

  const widened = html.replace(metaRe, (_m, a, _b, c) => `${a}${policy}${c}`);
  fs.writeFileSync(indexPath, widened);

  /* Say it out loud, and say what actually happened rather than what was
     intended. This line was unconditional, so during the regex bug above it
     printed "CSP widened for ... (connect-src, img-src)" on a run where
     neither directive had matched and nothing had been touched. That is the
     same silent failure the comment was warning about, one layer up. */
  if (widenedDirectives.length === 2) {
    log(`CSP widened for ${API_ORIGIN} (${widenedDirectives.join(', ')})`);
  } else if (widenedDirectives.length) {
    log(`WARNING: CSP only widened ${widenedDirectives.join(', ')} for ${API_ORIGIN}; the rest will be refused`);
  } else {
    log(`WARNING: CSP was NOT widened at all for ${API_ORIGIN}; expect refused requests and missing venue photos`);
  }
}

// ---------------------------------------------------------------------------
// 5. Static server with SPA fallback (the app answers on /app).
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain', '.mp4': 'video/mp4',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
};

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, WEB_ORIGIN).pathname);
    let file = path.join(BUILD_DIR, urlPath.replace(/^\/+/, ''));
    if (!file.startsWith(BUILD_DIR)) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(BUILD_DIR, 'index.html'); // SPA fallback
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(WEB_PORT, '127.0.0.1', () => {
      log(`static server on ${WEB_ORIGIN}`);
      resolve(server);
    });
  });
}

// ---------------------------------------------------------------------------
// 6. Capture. Filled in below (SCREENS + drive functions).
// ---------------------------------------------------------------------------

async function main() {
  await assertPortFree(API_PORT, 'backend API');
  await assertPortFree(WEB_PORT, 'static frontend');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(APPSTORE_DIR, { recursive: true });

  let pgHandle = null;
  let backend = null;
  let webServer = null;
  try {
    pgHandle = await startPostgres();
    backend = startBackend(pgHandle.url, pgHandle.port);
    await backend.waitUp();
    await seed(pgHandle.url);
    if (flag('stack-only')) { log('stack-only: backend + seed verified, skipping build/capture'); return; }
    await buildFrontend();
    webServer = await startStaticServer();

    await captureAll(pgHandle.url);

    if (KEEP_ALIVE) {
      log(`--keep-alive: stack stays up. App: ${WEB_ORIGIN}/app  API: ${API_ORIGIN}`);
      log(`log in as ${DEMO.camera.email} / ${DEMO.password}. Ctrl+C to tear down.`);
      await new Promise(() => {});
    }
  } finally {
    if (!KEEP_ALIVE) {
      if (webServer) webServer.close();
      if (backend) backend.stop();
      await stopPostgresQuietly(pgHandle);
    }
  }
}

// ---------------------------------------------------------------------------
// Capture implementation.
//
// Sizes (verified against Apple's screenshot specifications page 2026-08-14):
//   - App Store 6.9" (REQUIRED):  1320 x 2868  -> viewport 440x956 @3x exactly
//   - App Store 6.5" (fallback):  1284 x 2778  -> viewport 428x926 @3x exactly
//   - Web set: 390x844 viewport @2x (existing site assets are 390x844; a @2x
//     file drops into the same <img width="390" height="844"> slots).
// The app draws a fake desktop phone bezel above 500px viewport width, so all
// three viewports stay under it and capture the real full-bleed app.
// ---------------------------------------------------------------------------
const SIZES = [
  { id: 'web', viewport: { width: 390, height: 844 }, dsf: 2, out: 'web' },
  { id: 'appstore-6.9', viewport: { width: 440, height: 956 }, dsf: 3, out: 'appstore' },
  { id: 'appstore-6.5', viewport: { width: 428, height: 926 }, dsf: 3, out: 'appstore' },
];
const MODES = ['light', 'dark'];

// Which screens go in which set. `replaces` names the existing site asset the
// web capture is meant to swap in for (mode-matched to the current assets).
const SCREENS = [
  { id: 'nest', title: 'Nest (home): tonight status + flock list', appstore: true, replaces: { dark: ['app-nest.png', 'app-nest.webp'] } },
  { id: 'create', title: 'Start a flock form', appstore: true, replaces: { light: ['app-create.png'] } },
  { id: 'chat', title: 'Flock chat with a venue card', appstore: true, replaces: {} },
  { id: 'discover', title: 'Discover map with venue pins', appstore: true, replaces: {} },
  /* THE MAP AT TWO MORE ZOOMS, WITH A MEASUREMENT BEHIND EACH SHOT. Neither
     is shipped; both exist so the pin rules are proven rather than eyeballed:
     every pin's tip (or disc centre) lands on the projected venue within a
     pixel or two, at rest and on every sampled frame of an animated zoom;
     overlapping pins at city zoom fade out behind a survivor that says how
     many; the pin scale moves monotonically through the zoom. See auditMap. */
  { id: 'discover-far', title: 'Discover map zoomed out: overlapping pins fold behind a count', appstore: false, replaces: {} },
  { id: 'discover-near', title: 'Discover map at street zoom: heat hands over to the pins', appstore: false, replaces: {} },
  { id: 'crowd', title: 'Venue search results with live crowd scores', appstore: true, replaces: { dark: ['app-crowd.png'] } },
  { id: 'birdie', title: 'Birdie answering with real venue cards', appstore: true, replaces: { dark: ['app-birdie.png', 'app-birdie.webp'] } },
  /* TWO WHOLE TABS THAT NOTHING HAS EVER PHOTOGRAPHED. The rig covered Nest,
     Discover, Messages and three sub-screens, and Plans and You had no visual
     coverage at all. Neither performs a Google Places search, so they cost
     nothing to capture, unlike discover and crowd. */
  { id: 'plans', title: 'Plans tab', appstore: false, replaces: {} },
  { id: 'you', title: 'Profile tab', appstore: false, replaces: {} },
  { id: 'venue-dash', title: 'Venue dashboard (reviews tab)', appstore: false, replaces: {} },
  /* THE ANALYTICS TAB, which nothing ever looked at. the maintainer reported the real
     blocker on this exact screen from TestFlight on 2026-08-21: it told an
     owner to verify their venue in three places and gave them no way to do it.
     The verification request flow shipped on 08-25/26 and was confirmed by
     reading the code and by a test, which is not the same as somebody seeing
     that the screen now offers a path. It is the paid B2B surface and it had
     no visual coverage at all. */
  { id: 'venue-analytics', title: 'Venue dashboard (analytics tab)', appstore: false, replaces: {} },
];

async function apiLogin(email, password) {
  const r = await fetch(`${API_ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login failed for ${email}: ${r.status} ${await r.text()}`);
  const data = await r.json();
  if (!data.token) throw new Error(`login for ${email} returned no token`);
  return data.token;
}

// Generic "the screen is done painting" gate.
async function settle(page, { quiet = 600 } = {}) {
  await page.waitForLoadState('networkidle').catch(() => {});
  // Skeleton rows all carry .skeleton inside a [role="status"] container.
  await page.waitForSelector('.skeleton', { state: 'detached', timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => document.fonts.status === 'loaded').catch(() => {});
  // Every visible image finished (venue photos, avatars, map sprites).
  await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete), { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(quiet);
}

// The Explore layer is kept permanently mounted behind a visibility:hidden
// wrapper, so a second (hidden) copy of the tab bar exists in the DOM. Always
// address the visible one.
const mainNav = (page) => page.locator('nav[aria-label="Main"]').filter({ visible: true });

async function waitAppReady(page) {
  // The boot splash shows "Loading..." on a navy gradient; the visible tab bar
  // is the proof the session landed.
  await mainNav(page).waitFor({ timeout: 30000 });
  await page.getByText('Loading...', { exact: true }).waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});
  await declineAnalyticsAsk(page);
  await settle(page);
}

// The analytics consent bar is up on a fresh profile. Every capture is a
// marketing shot, so it must not be in frame, and until 2026-09-10 it also sat
// over the tab bar, so the first tab tap timed out on it. Declining sends
// nothing and is remembered for the rest of the session.
async function declineAnalyticsAsk(page) {
  const no = page.locator('.cb-wrap .cb-btn', { hasText: 'No thanks' });
  if (await no.count()) {
    await no.first().click();
    await page.locator('.cb-wrap').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  }
}

const tab = (page, name) => mainNav(page).getByRole('button', { name });

/* The screens that need the OWNER token and the ?venue=true deep link rather
   than an ordinary session. Both filters below read this, so a screen added to
   one is never missing from the other. */
const OWNER_SCREENS = new Set(['venue-dash', 'venue-analytics']);

// Per-screen drivers. Each takes an already-logged-in page sitting on the app
// and leaves the target screen fully rendered.
/* Open Discover and wait for the pins and their photos. Shared by the three
   Discover captures. */
async function openDiscoverPins(page) {
    await tab(page, 'Discover').click();
    await page.getByText('Finding venues near you...').waitFor({ state: 'detached', timeout: 45000 }).catch(() => {});
    await page.locator('.mlb-venue-marker').first().waitFor({ timeout: 45000 });
    /* COLLAPSE THE ATTRIBUTION. MapLibre renders "MapTiler (c) OpenStreetMap
       contributors" expanded by default and it reads as a stray bar of legal
       text across the bottom of the shot. Its own (i) button collapses it to
       a single dot, which is the state a real user sees after one tap and is
       still compliant: the credit remains one click away. */
    /* Collapse it by class rather than by clicking the disclosure. The button
       is moved out of MapLibre's own container into the map root for tab order
       and given tabindex -1, so a Playwright click on it raced the move and
       silently did nothing. Dropping `maplibregl-compact-show` is the same
       state a user reaches by tapping it, and it cannot race. */
    await page.evaluate(() => {
      document.querySelectorAll('.maplibregl-ctrl-attrib.maplibregl-compact-show')
        .forEach((el) => el.classList.remove('maplibregl-compact-show'));
    }).catch(() => {});
    /* WAIT FOR THE PHOTO PINS. Each marker paints a lettered SVG fallback
       immediately and swaps to the venue's circular photo only once
       buildPhotoPin resolves, so a short settle photographs the fallback and
       makes the map look like it failed to load. Wait for the swap. */
    await page.waitForFunction(() => {
      const pins = [...document.querySelectorAll('.mlb-marker-inner')];
      if (!pins.length) return false;
      const withPhoto = pins.filter((p) => p.style.backgroundImage && p.style.backgroundImage !== 'none');
      // Nearly all of them, not half. At 50% the light pass shot with 6 of 20
      // photos in and 14 lettered fallbacks still on screen; none had failed,
      // they were simply still in flight. One straggler must not stall the run.
      return withPhoto.length >= Math.ceil(pins.length * 0.9);
    }, null, { timeout: 60000 }).catch(() => {});
}

/* THE MAP AUDIT. Zoom to `zoom` (animated when asked, with the animation
   marked essential so the rig's reduced-motion setting does not skip it),
   sample the pins along the way, and measure them at rest: for every visible
   pin, the point MapLibre anchors (a teardrop's tip, a disc's centre) against
   the venue's projected coordinate. A pin more than two pixels off its venue
   fails the capture, which is what a "declutter" that moved pins used to be
   guilty of by design. Also reported: how many pins folded behind a
   neighbour, the badges they left, and the pin scale, which must move in
   one direction through the zoom. */
function readMapState() {
  const d = window.__flockMapDebug;
  if (!d) return { error: 'no __flockMapDebug hook on the page (flag=' + String(window.__FLOCK_MAP_DEBUG__) + ', maps=' + document.querySelectorAll('.maplibregl-map').length + ', globals=' + Object.keys(window).filter((k) => /flock/i.test(k)).join('+') + ')' };
  const root = d.container().getBoundingClientRect();
  const pins = [];
  for (const m of d.markers()) {
    if (m.el.style.display === 'none') continue;
    const inner = m.el.querySelector('.mlb-marker-inner');
    if (!inner) continue;
    const r = inner.getBoundingClientRect();
    const round = (inner.style.transformOrigin || '').startsWith('center');
    const ax = r.left + r.width / 2 - root.left;
    const ay = (round ? r.top + r.height / 2 : r.bottom) - root.top;
    const p = d.project(m.lng, m.lat);
    const t = getComputedStyle(inner).transform;
    const mm = t && t !== 'none' ? t.match(/matrix\(([^,]+),/) : null;
    pins.push({
      id: m.id,
      dx: +(ax - p.x).toFixed(2),
      dy: +(ay - p.y).toFixed(2),
      covered: m.el.dataset.covered === '1',
      badge: (m.el.querySelector('.mlb-cluster-badge') || {}).textContent || '',
      scale: mm ? +(+mm[1]).toFixed(3) : 1,
    });
  }
  const shown = pins.filter((q) => !q.covered);
  const worst = shown.reduce((w, q) => Math.max(w, Math.abs(q.dx), Math.abs(q.dy)), 0);
  return {
    zoom: +d.getZoom().toFixed(2),
    pins: pins.length,
    shown: shown.length,
    covered: pins.length - shown.length,
    badges: shown.filter((q) => q.badge).map((q) => q.badge),
    worstPx: +worst.toFixed(2),
    scale: shown[0] ? shown[0].scale : null,
  };
}

async function auditMap(page, zoom, { label, animate = false } = {}) {
  const before = await page.evaluate(readMapState);
  if (before.error) throw new Error(`${label}: ${before.error}`);
  const samples = [];
  if (animate) {
    await page.evaluate((z) => window.__flockMapDebug.zoomTo(z, 1600), zoom);
    for (let i = 0; i < 10; i += 1) {
      await page.waitForTimeout(150);
      samples.push(await page.evaluate(readMapState));
    }
  } else {
    await page.evaluate((z) => window.__flockMapDebug.zoomTo(z, 0), zoom);
  }
  await page.waitForTimeout(400);
  const after = await page.evaluate(readMapState);
  const line = (st) => `z=${st.zoom} pins=${st.pins} shown=${st.shown} covered=${st.covered} badges=[${st.badges.join(',')}] worst=${st.worstPx}px scale=${st.scale}`;
  log(`  map ${label}: before ${line(before)}`);
  for (const st of samples) log(`  map ${label}: frame  ${line(st)}`);
  log(`  map ${label}: after  ${line(after)}`);
  const failures = [];
  if (after.worstPx > 2) failures.push(`a pin sits ${after.worstPx}px off its venue at rest`);
  for (const st of samples) {
    if (st.worstPx > 3) failures.push(`a pin was ${st.worstPx}px off its venue mid-zoom at z=${st.zoom}`);
  }
  const scales = samples.map((st) => st.scale).filter((v) => v !== null);
  for (let i = 1; i < scales.length; i += 1) {
    if (scales[i] < scales[i - 1] - 0.001) failures.push(`the pin scale went backwards mid-zoom (${scales[i - 1]} -> ${scales[i]})`);
  }
  if (label === 'discover-far' && after.pins > 8 && after.covered === 0) {
    failures.push('twenty-odd pins at city zoom and none folded behind a neighbour');
  }
  if (after.covered > 0 && after.badges.length === 0) failures.push('pins folded but no survivor carries a count');
  if (failures.length) throw new Error(`${label}: ${failures.join('; ')}`);
}

const DRIVERS = {
  async nest(page) {
    await tab(page, 'Nest').click();
    await page.getByText('Start a flock').first().waitFor({ timeout: 15000 });
    await page.getByText(DEMO.flockName).first().waitFor({ timeout: 15000 });
    await settle(page);
  },
  async create(page) {
    await tab(page, 'Nest').click();
    await page.getByText('Start a flock').first().click();
    const name = page.locator('#flock-name-input');
    await name.waitFor({ timeout: 10000 });
    await name.fill('Friday Night Out');
    // Pick a night + time when the quick chips exist, so the form reads
    // half-filled the way a real user leaves it.
    for (const label of ['Tonight', '9 PM']) {
      const chip = page.getByRole('button', { name: label, exact: true }).first();
      if (await chip.count()) await chip.click().catch(() => {});
    }
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await settle(page);
  },
  async chat(page) {
    await tab(page, 'Messages').click();
    await page.getByRole('button', { name: new RegExp(DEMO.flockName) }).filter({ visible: true }).first().click();
    /* `.chat-composer-field`, not `#chat-input`. The chat rebuild replaced
       both composers with components/chat/ChatInputBar, which carries neither
       that id nor the DM's old data attribute, so this waited fifteen seconds
       for an element that had stopped existing. The class is the field's own
       and is what chatInput.css styles it by. */
    await page.locator('.chat-composer-field').first().waitFor({ timeout: 15000 });
    // The venue card must be on screen: its name renders as an h4.
    await page.getByText(DEMO.venue.name).first().waitFor({ timeout: 15000 });
    await settle(page);
  },
  async discover(page) {
    await openDiscoverPins(page);
    // Let tiles finish rendering; maplibre paints async after markers land.
    await settle(page, { quiet: 3500 });
  },
  async 'discover-far'(page) {
    await openDiscoverPins(page);
    await auditMap(page, 12.2, { label: 'discover-far' });
    await settle(page, { quiet: 2500 });
  },
  async 'discover-near'(page) {
    await openDiscoverPins(page);
    await auditMap(page, 16.4, { label: 'discover-near', animate: true });
    await settle(page, { quiet: 2500 });
  },
  async crowd(page) {
    await tab(page, 'Discover').click();
    await page.getByText('Finding venues near you...').waitFor({ state: 'detached', timeout: 45000 }).catch(() => {});
    const search = page.locator('#search-input');
    await search.waitFor({ timeout: 15000 });
    // Typing fires the debounced venue search, which then fires the crowd
    // batch for the first 20 results. The percentages live in the full-screen
    // results overlay behind "See All Results".
    const batch = page.waitForResponse((r) => r.url().includes('/api/crowd/batch'), { timeout: 60000 }).catch(() => null);
    await search.fill('bars');
    await batch;
    await page.getByText(/See All Results/).first().click();
    /* The crowd pill, by its accessible name rather than by a percent sign.
       This waited for /\d+%/ and the app has not drawn a "%" on a crowd score
       for a while, correctly: a BestTime score is relative busyness on a 0-100
       ladder, not a share of capacity, so "43%" would be a claim about how
       full the room is. The pill now carries a real name, which is both the
       accessible fix and a handle that cannot go stale behind a style change. */
    await page.getByLabel(/out of 100/).first().waitFor({ timeout: 30000 });
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await settle(page, { quiet: 1500 });
  },
  async birdie(page) {
    await tab(page, 'Nest').click();
    const fab = page.locator('[aria-label="Open Birdie assistant"]');
    await fab.waitFor({ timeout: 15000 });
    await fab.click();
    // Expand to fullscreen: the unlabeled toggle sits right before Close.
    await page.locator('button[aria-label="Close"]').locator('xpath=preceding-sibling::button[1]').click();
    const input = page.locator('input[aria-label="Ask me anything"]');
    await input.waitFor({ timeout: 10000 });
    await input.fill("Where's poppin in Philadelphia rn?");
    // A Birdie turn is a real Gemini tool loop (up to ~45s server-side). Done
    // = the HTTP turn returns AND the animated typing bubble (svg animate#b1)
    // leaves the DOM.
    const reply = page.waitForResponse((r) => r.url().includes('/api/ai/chat'), { timeout: 90000 });
    await input.press('Enter');
    await reply;
    await page.locator('#b1').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
    // Give venue-card images from the reply a beat to load.
    await settle(page, { quiet: 2000 });
    // The thread auto-scrolls to the newest card; the shot should show the
    // question and the top of Birdie's answer, like the current site asset.
    await page.getByText("Where's poppin in Philadelphia rn?").first()
      .evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.waitForTimeout(600);
  },
  async plans(page) {
    await tab(page, 'Plans').click();
    await settle(page);
  },
  async you(page) {
    await tab(page, 'You').click();
    await settle(page);
  },
  async 'venue-analytics'(page) {
    // Same owner context as venue-dash. Analytics is the tab the dashboard
    // opens on, so the click is belt and braces for a future default change.
    await page.getByText('Welcome,').first().waitFor({ timeout: 20000 });
    // The owner context never passes through waitAppReady (no tab bar to wait
    // for), so the consent bar has to be declined here as well, or it sits at
    // the bottom of every owner capture.
    await declineAnalyticsAsk(page);
    const analyticsTab = page.getByRole('button', { name: 'Analytics' }).first();
    if (await analyticsTab.count()) await analyticsTab.click();
    await settle(page);
  },
  async 'venue-dash'(page) {
    // Separate context: owner token + venue mode + ?venue=true deep link.
    await page.getByText('Welcome,').first().waitFor({ timeout: 20000 });
    await declineAnalyticsAsk(page);
    const reviewsTab = page.getByRole('button', { name: 'Reviews' }).first();
    if (await reviewsTab.count()) await reviewsTab.click();
    await page.getByText('Jordan Avery').first().waitFor({ timeout: 15000 }).catch(() => {});
    await settle(page);
  },
};

async function launchChromium() {
  const { chromium } = requireFrontend('@playwright/test');
  try {
    return await chromium.launch();
  } catch (e) {
    log(`chromium launch failed (${e.message.split('\n')[0]}); running playwright install...`);
    await new Promise((resolve, reject) => {
      const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['playwright', 'install', 'chromium'], {
        cwd: FRONTEND_DIR, shell: process.platform === 'win32', stdio: 'inherit',
      });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('playwright install failed'))));
    });
    return chromium.launch();
  }
}

async function newAppContext(browser, { size, mode, token, userMode }) {
  const context = await browser.newContext({
    viewport: size.viewport,
    deviceScaleFactor: size.dsf,
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
    permissions: ['geolocation'],
    geolocation: { latitude: 39.9526, longitude: -75.1652 }, // Philadelphia
    locale: 'en-US',
    timezoneId: 'America/New_York',
    colorScheme: mode,
  });
  await context.addInitScript(([theme, jwt, uMode]) => {
    localStorage.setItem('flock-theme-mode', 'manual');
    localStorage.setItem('flock-theme', theme);
    localStorage.setItem('flock_notif_denied', 'true');
    localStorage.setItem('flockUserMode', uMode);
    if (uMode === 'venue') localStorage.setItem('flockVenueOnboardingComplete', 'true');
    localStorage.setItem('flock_user_lat', '39.9526');
    localStorage.setItem('flock_user_lng', '-75.1652');
    localStorage.setItem('flockToken', jwt);
    // Lets the map audit below project venues and measure their pins.
    window.__FLOCK_MAP_DEBUG__ = true;
  }, [mode, token, userMode]);
  const page = await context.newPage();
  return { context, page };
}

const hideCaretCss = '*{caret-color:transparent!important}';

// The app SYNCS theme to the server: the first logged-in pass pushes its local
// theme up, and every later pass pulls it back down, overriding the injected
// localStorage. So the server-side setting is written to match the mode before
// each pass — the pull then agrees with the injection instead of fighting it.
async function setServerTheme(dbUrl, mode) {
  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  const mk = (userMode) => JSON.stringify({ theme: mode, themeMode: 'manual', userMode, locationEnabled: true });
  await db.query(
    `INSERT INTO user_settings (user_id, settings)
     SELECT id, $1::jsonb FROM users WHERE email LIKE '%@shots.flock.local' AND role <> 'venue_owner'
     ON CONFLICT (user_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`,
    [mk('user')]
  );
  await db.query(
    `INSERT INTO user_settings (user_id, settings)
     SELECT id, $1::jsonb FROM users WHERE email LIKE '%@shots.flock.local' AND role = 'venue_owner'
     ON CONFLICT (user_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`,
    [mk('venue')]
  );
  await db.end();
}

async function captureAll(dbUrl) {
  const sizes = SIZES.filter((s) => SET === 'all' || (SET === 'web' ? s.id === 'web' : s.id.startsWith('appstore')));
  const screens = SCREENS.filter((s) => !ONLY || ONLY.includes(s.id));
  const sharp = requireFrontend('sharp');
  const browser = await launchChromium();
  const userToken = await apiLogin(DEMO.camera.email, DEMO.password);
  const ownerToken = await apiLogin(DEMO.owner.email, DEMO.password);
  const manifest = [];
  const failures = [];

  try {
    for (const size of sizes) {
      for (const mode of MODES) {
        await setServerTheme(dbUrl, mode);
        /* OWNER_SCREENS, not a hardcoded 'venue-dash'. This excluded that one id
           by name, so adding venue-analytics silently put it in the CONSUMER
           context: logged in as an ordinary user, no ?venue=true, and a
           twenty-second wait for a "Welcome," that a regular account never
           sees. One list, used by both filters, so a third owner screen cannot
           repeat it. */
        const consumerScreens = screens.filter((s) => !OWNER_SCREENS.has(s.id) && (size.id === 'web' || s.appstore));
        if (consumerScreens.length) {
          const { context, page } = await newAppContext(browser, { size, mode, token: userToken, userMode: 'user' });
          /* Collected for the failure report above. Attached here rather than
             inside newAppContext so the venue-dash context, which has its own
             driver and its own failure mode, is not silently sharing an array
             with the consumer one. */
          page.__consoleErrors = [];
          page.on('console', (m) => {
            if (m.type() === 'error') page.__consoleErrors.push(m.text().slice(0, 200));
          });
          page.on('pageerror', (err) => page.__consoleErrors.push(`pageerror: ${String(err).slice(0, 200)}`));

          /* EVERY IMAGE THAT DOES NOT ARRIVE, NAMED.
             A venue photo that fails is invisible in this rig by design: the
             app swaps in its placeholder bird and carries on, so a capture
             with no photos at all still reports "ok". That is how a CSP that
             blocked every venue image shipped screenshots for weeks. Failed
             and non-2xx image requests are collected here and printed per
             screen, so the next silent fallback is one line in the log. */
          page.__imgFails = [];
          page.on('requestfailed', (r) => {
            if (r.resourceType() === 'image') {
              page.__imgFails.push(`${(r.failure() && r.failure().errorText) || 'failed'} ${r.url().slice(0, 110)}`);
            }
          });
          page.on('response', (r) => {
            if (r.request().resourceType() === 'image' && r.status() >= 400) {
              page.__imgFails.push(`HTTP ${r.status()} ${r.url().slice(0, 110)}`);
            }
          });
          try {
            for (const screen of consumerScreens) {
              try {
                // Fresh /app load per screen: several screens (chat detail,
                // the search overlay) hide the tab bar, so starting each
                // driver from the app root is what makes the order of the
                // screen list irrelevant.
                page.__imgFails = [];
                await page.goto(`${WEB_ORIGIN}/app`, { waitUntil: 'domcontentloaded' });
                await page.addStyleTag({ content: hideCaretCss });
                await waitAppReady(page);
                await DRIVERS[screen.id](page);
                await snap(page, sharp, manifest, { screen, size, mode });
              } catch (e) {
                /* SAY WHY, not just that. This reported "Timeout 30000ms
                   exceeded" and nothing else, which is a sentence that fits
                   every possible cause: a stale selector, a login that did not
                   land, a crash on boot. The rig produces App Store submission
                   material, so a failure nobody can diagnose is a failure
                   nobody fixes, and this one had gone unnoticed.

                   A screenshot of whatever WAS on screen, plus the console and
                   any page error, turns thirty seconds of silence into an
                   answer. Best effort throughout: diagnostics must never
                   replace the real failure with one of their own. */
                const why = [`${screen.id} [${size.id}/${mode}]: ${e.message.split('\n')[0]}`];
                try {
                  /* SCRATCH, not OUT_DIR. OUT_DIR is frontend/public/screenshots,
                     which is deployed with the site, so a debug capture there
                     would ship a picture of a broken app to production. */
                  const shot = path.join(SCRATCH, `FAILED-${screen.id}-${size.id}-${mode}.png`);
                  fs.mkdirSync(SCRATCH, { recursive: true });
                  await page.screenshot({ path: shot });
                  why.push(`  screen at failure: ${shot}`);
                } catch { /* the page may be gone */ }
                try {
                  const logged = (page.__consoleErrors || []).slice(0, 6);
                  if (logged.length) why.push(`  console: ${logged.join(' | ')}`);
                  const url = page.url();
                  const visible = await page.evaluate(() => ({
                    nav: !!document.querySelector('nav[aria-label="Main"]'),
                    loading: document.body.innerText.includes('Loading...'),
                    firstText: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 160),
                  }));
                  why.push(`  at ${url} | nav:${visible.nav} loading:${visible.loading}`);
                  why.push(`  page reads: ${visible.firstText}`);
                } catch { /* ditto */ }
                failures.push(why.join('\n'));
              }
            }
          } finally {
            await context.close();
          }
        }
        /* The owner shots, plural since 2026-09-05. One context and one login,
           several tabs, each driven from the dashboard root so the order of the
           screen list cannot decide which tab a driver starts from. That is the
           same rule the consumer loop above follows and for the same reason. */
        const ownerScreens = screens.filter((s) => OWNER_SCREENS.has(s.id));
        if (ownerScreens.length > 0 && size.id === 'web') {
          const { context, page } = await newAppContext(browser, { size, mode, token: ownerToken, userMode: 'venue' });
          try {
            for (const screen of ownerScreens) {
              try {
                await page.goto(`${WEB_ORIGIN}/app?venue=true`, { waitUntil: 'domcontentloaded' });
                await page.addStyleTag({ content: hideCaretCss });
                await DRIVERS[screen.id](page);
                await snap(page, sharp, manifest, { screen, size, mode });
              } catch (e) {
                failures.push(`${screen.id} [${size.id}/${mode}]: ${e.message.split('\n')[0]}`);
              }
            }
          } finally {
            await context.close();
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  writeManifestAndWiring(manifest);
  archiveUnshipped();
  log(`captured ${manifest.length} images${failures.length ? `, ${failures.length} FAILURES` : ''}`);
  for (const f of failures) log(`  FAIL ${f}`);
  if (failures.length) process.exitCode = 1;
}

/* Collected across a run and printed at the end, so one overflowing screen
   does not fail a capture that is otherwise fine and useful. */
const overflowFindings = [];

/**
 * SLOP-AUDIT rule 6, checked by the thing that already visits every screen.
 *
 * "Mobile 320-390px: zero horizontal overflow, nothing cut off." That rule has
 * been enforced by somebody remembering to look, and this rig walks every
 * screen in both themes on the way to photographing it. Measuring the document
 * costs nothing and turns a standard into a check.
 *
 * A screenshot cannot show this. The viewport clips at its own width, so a row
 * running 40px off the side photographs as a tidy edge and reads as correct;
 * the only tell is the number.
 */
async function checkOverflow(page, { screen, size, mode }) {
  try {
    const m = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      // The widest element sticking out, to name what to look at rather than
      // reporting that something, somewhere, is too wide.
      worst: (() => {
        let worstEl = null;
        let worstRight = 0;
        const limit = document.documentElement.clientWidth;
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.right > limit + 1 && r.right > worstRight) {
            worstRight = r.right;
            worstEl = el;
          }
        }
        if (!worstEl) return null;
        const cls = typeof worstEl.className === 'string' ? worstEl.className : '';
        return {
          tag: worstEl.tagName.toLowerCase(),
          cls: cls.split(/\s+/).filter(Boolean).slice(0, 3).join('.'),
          right: Math.round(worstRight),
          text: (worstEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        };
      })(),
    }));
    const over = m.scrollW - m.clientW;
    if (over > 0) {
      const w = m.worst;
      overflowFindings.push(
        `${screen.id} [${size.id}/${mode}]: ${over}px of horizontal overflow`
        + (w ? ` | widest: <${w.tag}${w.cls ? ` class="${w.cls}"` : ''}> reaches ${w.right}px "${w.text}"` : '')
      );
    }
  } catch {
    /* A measurement must never cost the capture. */
  }
}

async function snap(page, sharp, manifest, { screen, size, mode }) {
  await checkOverflow(page, { screen, size, mode });
  const raw = await page.screenshot({ type: 'png' });
  const px = { w: size.viewport.width * size.dsf, h: size.viewport.height * size.dsf };
  const meta = await sharp(raw).metadata();
  if (meta.width !== px.w || meta.height !== px.h) {
    throw new Error(`capture size mismatch: got ${meta.width}x${meta.height}, wanted ${px.w}x${px.h}`);
  }
  if (size.out === 'web') {
    const base = `${screen.id}-${mode}@2x`;
    const pngPath = path.join(OUT_DIR, `${base}.png`);
    const webpPath = path.join(OUT_DIR, `${base}.webp`);
    await sharp(raw).png({ compressionLevel: 9, palette: true }).toFile(pngPath);
    await sharp(raw).webp({ quality: 82 }).toFile(webpPath);
    const replaces = (screen.replaces[mode] || []);
    manifest.push({ file: `screenshots/${base}.png`, screen: screen.id, title: screen.title, mode, set: 'web', width: px.w, height: px.h, replaces: replaces.find((r) => r.endsWith('.png')) ? `screenshots/${replaces.find((r) => r.endsWith('.png'))}` : null });
    manifest.push({ file: `screenshots/${base}.webp`, screen: screen.id, title: screen.title, mode, set: 'web', width: px.w, height: px.h, replaces: replaces.find((r) => r.endsWith('.webp')) ? `screenshots/${replaces.find((r) => r.endsWith('.webp'))}` : null });
  } else {
    // Apple: no alpha channel. Flatten to opaque PNG.
    const inches = size.id.endsWith('6.9') ? '6.9' : '6.5';
    const file = `${screen.id}-${mode}-${inches}in.png`;
    await sharp(raw).flatten({ background: '#ffffff' }).removeAlpha().png({ compressionLevel: 9 }).toFile(path.join(APPSTORE_DIR, file));
    manifest.push({ file: `store-assets/${file}`, screen: screen.id, title: screen.title, mode, set: `appstore-${inches}`, width: px.w, height: px.h, replaces: null });
  }
  const imgFails = [...new Set(page.__imgFails || [])];
  const imgNote = imgFails.length ? `  (${imgFails.length} image(s) did not load: ${imgFails.slice(0, 3).join(' | ')})` : '';
  log(`  ok ${screen.id} [${size.id}/${mode}]${imgNote}`);
}

// The captures that ship: anything source, index.html or the PWA manifest
// names under /screenshots/. Everything else the run produced leaves public/.
function shippedCaptures() {
  const names = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__tests__') walk(p); }
      else if (/\.(js|jsx|css|html)$/.test(e.name)) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/\/screenshots\/([A-Za-z0-9@._-]+\.(?:png|webp))/g)) names.add(m[1]);
      }
    }
  };
  walk(path.join(FRONTEND_DIR, 'src'));
  for (const m of fs.readFileSync(path.join(FRONTEND_DIR, 'public', 'index.html'), 'utf8').matchAll(/\/screenshots\/([A-Za-z0-9@._-]+\.(?:png|webp))/g)) names.add(m[1]);
  try {
    const pwa = JSON.parse(fs.readFileSync(path.join(FRONTEND_DIR, 'public', 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
    for (const s of pwa.screenshots || []) {
      const m = String(s.src).match(/screenshots\/([A-Za-z0-9@._-]+)/);
      if (m) names.add(m[1]);
    }
  } catch { /* no PWA screenshots */ }
  return names;
}

function archiveUnshipped() {
  const archive = path.join(FRONTEND_DIR, 'screenshots');
  fs.mkdirSync(archive, { recursive: true });
  const shipped = shippedCaptures();
  let n = 0;
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (!/\.(png|webp)$/.test(f) || shipped.has(f)) continue;
    fs.renameSync(path.join(OUT_DIR, f), path.join(archive, f));
    n += 1;
  }
  log(`${n} unreferenced capture(s) moved to frontend/screenshots/; ${shipped.size} stay in public/`);
}

function writeManifestAndWiring(manifest) {
  // Merge with the manifest from previous runs so a partial (--only/--set)
  // rerun refreshes its own entries without dropping the rest.
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  const byFile = new Map();
  try {
    const prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^﻿/, ''));
    for (const c of prev.captures || []) byFile.set(c.file, c);
  } catch { /* first run */ }
  for (const c of manifest) byFile.set(c.file, c);
  const captures = [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));

  fs.writeFileSync(manifestPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    generator: 'frontend/scripts/capture-screenshots.mjs',
    note: 'Real captures of the shipping app against a seeded local stack. See WIRING.md for the swap plan.',
    captures,
  }, null, 2));

  const wiring = `# Screenshot wiring plan

Generated by \`frontend/scripts/capture-screenshots.mjs\` on ${new Date().toISOString().slice(0, 10)}.
All files below already exist in \`frontend/public/screenshots/\`. Nothing in the
website source has been touched; these are the exact one-line swaps, to be made
once the agents holding \`frontend/src/website/*\` land.

## LandingPage.js (4 references, 2 <picture> blocks)

1. Hero figure (class \`lp-shot lp-shot-hero\`, dark-mode capture matches the navy hero):
   - \`srcSet="/screenshots/app-nest.webp"\`  ->  \`srcSet="/screenshots/nest-dark@2x.webp"\`
   - \`src="/screenshots/app-nest.png"\`      ->  \`src="/screenshots/nest-dark@2x.png"\`
   - Keep \`width="390" height="844"\` (files are the same frame at @2x; the img attributes stay the display size).

2. Birdie section (class \`lp-shot\`, alt mentions the Philadelphia question; the new capture asks the same question):
   - \`srcSet="/screenshots/app-birdie.webp"\` ->  \`srcSet="/screenshots/birdie-dark@2x.webp"\`
   - \`src="/screenshots/app-birdie.png"\`     ->  \`src="/screenshots/birdie-dark@2x.png"\`

## public/manifest.json (PWA screenshots array, 4 entries, all 390x844 sized entries)

- \`screenshots/app-nest.png\`   -> \`screenshots/nest-dark@2x.png\`   (update "sizes" to "780x1688")
- \`screenshots/app-create.png\` -> \`screenshots/create-light@2x.png\` (update "sizes" to "780x1688")
- \`screenshots/app-crowd.png\`  -> \`screenshots/crowd-dark@2x.png\`  (update "sizes" to "780x1688")
- \`screenshots/app-birdie.png\` -> \`screenshots/birdie-dark@2x.png\` (update "sizes" to "780x1688")

## public/index.html

- The only \`/screenshots/\` mention is inside an HTML comment (a deliberate
  decision NOT to preload the hero image). No change required.

## App Store Connect

Upload from \`store-assets/\` at the repo root (gitignored, not deployed):
- \`*-6.9in.png\` (1320x2868) satisfies the REQUIRED 6.9-inch slot.
- \`*-6.5in.png\` (1284x2778) fills the optional 6.5-inch slot.
Both light and dark variants exist for every screen; pick one narrative set of
up to 10 per slot. Files are opaque PNG (Apple rejects alpha).

## Old assets

\`app-nest.*\`, \`app-birdie.*\`, \`app-create.png\`, \`app-crowd.png\` stay in place
until the swaps above land. \`chat.png, confirmed.png, create.png, crowd.png,
discover.png, home.png, messages.png, profile.png, split.png\` (365x790, dated
March) are referenced nowhere and can be deleted whenever.
`;
  fs.writeFileSync(path.join(OUT_DIR, 'WIRING.md'), wiring);
  log('wrote manifest.json + WIRING.md');
  /* SLOP-AUDIT rule 6, reported rather than enforced. A capture run that is
     otherwise good should not fail on this, but nobody should have to go
     looking for it either. */
  if (overflowFindings.length) {
    log(`HORIZONTAL OVERFLOW on ${overflowFindings.length} screen(s) - SLOP-AUDIT rule 6:`);
    for (const f of overflowFindings) log(`  ${f}`);
  } else {
    log('no horizontal overflow on any screen (SLOP-AUDIT rule 6)');
  }
}

main().catch((e) => die(e.stack || e.message));
