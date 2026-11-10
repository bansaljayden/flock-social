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
 *       node scripts/capture-screenshots.mjs --only=made,stillin,guestlink --set=web --modes=light --out=../some/dir
 *       node scripts/capture-screenshots.mjs --only=nest,chat --modes=dark --viewport=430x932 --scale=3 --out=../some/dir
 *       node scripts/capture-screenshots.mjs --story=site --suffix=-v3   (the website's frames)
 *       node scripts/capture-screenshots.mjs --story=site --viewport=430x932 --scale=3 --out=../some/dir
 *                                                     (the same story as 1290x2796 masters, light and dark)
 *
 * THE SITE STORY (--story=site). The frames the website ships, from one
 * command: the dark theme at 390 x 844, shot at 2x, every one named the way
 * the site names it (<frame>-dark<suffix>@2x.webp, a 480px cut, the home
 * screen's AVIF and PNG), into a folder of the rig's own scratch space and
 * never into public/. The friends are the same five people the site's words
 * follow, and every place is invented and drawn (SITE_VENUES, shot-art.mjs):
 * no Places search, no Places photo. It spends nothing: the backend child's
 * paid keys are blanked whatever backend/.env holds, and every venue search,
 * venue detail, crowd figure, events list, weather reading and Birdie answer
 * a screen asks for is given in the browser, in the shape the server answers
 * with. The browser's clock reads 7 PM wherever the run happens (its time
 * zone moves, the instant does not), and each frame is audited before it is
 * kept: no picture from outside the rig, no generated photo-real cover, no
 * LIVE or ESTIMATED badge, no real business's name, and the bird tab bar.
 * Run it from frontend/ with SHOTS_SCRATCH (and SHOTS_API_PORT /
 * SHOTS_WEB_PORT beside another stack); --out moves the output folder,
 * --only narrows it to some frames. SHOTS_MAPTILER_KEY, the map's browser
 * key, is the one key it can be given: with it the build draws the map and
 * the site story shoots the Discover map (map-crowd) where it otherwise
 * shoots the search list (crowd-list). A map frame ships with the site's own
 * credit for the map beside it: the footer's MapTiler and OpenStreetMap line
 * (SiteFooter.js; siteFooter.test.js asks for it once a map frame is wired)
 * and WIRING.md's words for the map. The frames carry MapTiler's credit too,
 * at a size nobody reads.
 *
 * --viewport and --scale shoot every screen asked for at one size of your own
 * instead of the sets (430x932 at 3 is 1290x2796, an App Store 6.9-inch
 * size), as opaque PNGs named <screen>-<mode>-<width>x<height>.png, to --out
 * only.
 *
 * --modes narrows the theme pass (default light,dark). --out sends every
 * capture to another directory and skips the manifest and the public/
 * archive step, for a layout check that must not leave files in the repo.
 * Scenarios marked `narrow` are also shot at a 320px-wide viewport in the web
 * set, the floor DESIGN-STANDARD rule 6 names.
 *
 * THIS RUN COSTS MONEY. The backend child keeps the real external API keys
 * on purpose, which is what makes the screens real, and `discover` and `crowd`
 * both perform live Google Places searches (Birdie a Gemini call). A capture is
 * therefore not free and not idempotent: running it in a loop while iterating
 * spends quota. Use --only to drive the one screen you are working on, and
 * expect discover and crowd to be the two that fail first when the API pushes
 * back. Venue photos cost nothing: the browser never asks the photo proxy, it
 * is answered with drawings (shot-art.mjs). The site story is the exception
 * to all of this: it can reach no paid service at all (above).
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
 * and store-assets/ is gitignored. manifest.json is written into the web set.
 * WIRING.md beside it is not: it is kept by hand, and a run leaves it alone
 * (see writeManifest).
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
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { installVenueArt, setVenueArtTheme, refreshVisibleVenueArt } from './shot-art.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(FRONTEND_DIR, '..');
const BACKEND_DIR = path.join(REPO_ROOT, 'backend');
const APPSTORE_DIR = path.join(REPO_ROOT, 'store-assets');

// CommonJS deps live in the two package roots; reach them explicitly so this
// script works no matter what cwd it is launched from.
const requireBackend = createRequire(path.join(BACKEND_DIR, 'package.json'));
const requireFrontend = createRequire(path.join(FRONTEND_DIR, 'package.json'));

const { Client } = requireBackend('pg');
const bcrypt = requireBackend('bcryptjs');
// The server's crowd engine (it requires nothing but its venue-clock helper).
// The site story's crowd card takes its quiet hour and its busiest hours from
// the same functions GET /api/crowd/:placeId calls (siteCrowdCard), so a frame
// cannot name an hour the app would not.
const crowdEngine = requireBackend('./services/crowdEngine');
// The browser suite's clock helper (a local hour, by moving the time zone),
// shared rather than copied so the two rigs cannot drift apart.
const { zoneForLocalHour } = createRequire(import.meta.url)('../../tools/e2e/clock.js');

// ---------------------------------------------------------------------------
// Fixed ports. The API port is baked into the CRA build (REACT_APP_API_URL is
// inlined at build time), so it must be stable for --skip-build to be usable.
// SHOTS_API_PORT / SHOTS_WEB_PORT (with SHOTS_SCRATCH below) run a second rig
// beside one that already holds the defaults; sweep-buttons.mjs reads the same
// two variables.
// ---------------------------------------------------------------------------
const API_PORT = Number(process.env.SHOTS_API_PORT) || 5210;
const WEB_PORT = Number(process.env.SHOTS_WEB_PORT) || 3410;
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

const log = (msg) => console.log(`[shots] ${msg}`);
const die = (msg) => { console.error(`[shots] FATAL: ${msg}`); process.exit(1); };

// Scratch space OUTSIDE the repo: the CRA build output and the pg data dir.
// A second rig needs its own (SHOTS_SCRATCH), or it rebuilds over the first
// one's build and stamp.
const SCRATCH = process.env.SHOTS_SCRATCH ? path.resolve(process.env.SHOTS_SCRATCH) : path.join(os.tmpdir(), 'flock-screenshot-run');
const BUILD_DIR = path.join(SCRATCH, 'build');
const BUILD_STAMP = path.join(SCRATCH, 'build.stamp.json');

/* THE SITE STORY (--story=site; see the header). Opt in: without it the run is
   the App Store and web sets as before. `--suffix` is the version every file
   name carries (-v3), because the site's CDN keeps a same-named file for a day
   and a new name needs no purge. */
const STORY = opt('story');
const SITE = STORY === 'site';
const SUFFIX = opt('suffix') || '';
if (STORY !== null && !SITE) die(`--story takes "site", not "${STORY}"`);
if (SUFFIX && !SITE) die('--suffix names the site story\'s files; it goes with --story=site');
if (SUFFIX && !/^-[a-z0-9]{1,12}$/.test(SUFFIX)) die(`--suffix is a short tag that starts with a hyphen, like -v3, not "${SUFFIX}"`);
/* THE SITE STORY AT A SIZE OF ITS OWN (--story=site --viewport=430x932
   --scale=3, with --modes). The same seed, the same invented and drawn places,
   the same stubs and the same audit, shot at that size in each mode asked for
   and kept as opaque PNG masters, <frame>-<mode>-<width>x<height>.png, for a
   listing that frames the app's own screens (430x932 at 3 is 1290x2796, an
   App Store 6.9-inch size). Nothing named for the site is cut from them, so it
   takes no --suffix, and it writes only to an --out of its own. Without
   --viewport and --scale the run is the website's, dark, at 390x844 at 2. */
const SITE_SIZED = SITE && (opt('viewport') !== null || opt('scale') !== null);
if (SITE) {
  for (const o of SITE_SIZED ? ['set', 'suffix'] : ['viewport', 'scale', 'modes', 'set']) {
    if (opt(o) !== null) {
      die(SITE_SIZED
        ? `--story=site at a size of its own keeps masters only, and takes no --${o}`
        : `--story=site shoots the website's frames, dark, at 390x844 at 2, and takes no --${o}`);
    }
  }
  if (SITE_SIZED && opt('out') === null) die('--story=site at a size of its own writes only to --out=<folder>, never into the site story\'s folder');
}

/* Somewhere other than public/. The default output is deployed with the site
   and its archive step moves every unreferenced capture into the tracked
   frontend/screenshots/, so a run made only to look at a layout would leave
   files in the repo either way. With --out set, captures go to that directory
   and nothing under public/ or frontend/screenshots/ is written or moved. The
   site story always works this way: its frames are named for the site before
   any source names them, so the archive step would move every one of them
   out of public/ again. It writes to its own folder in the scratch space,
   and copying the frames into public/ is a deliberate step after a look. */
const OUT_OVERRIDE = opt('out') || (SITE ? path.join(SCRATCH, `site${SUFFIX}`) : null);
const OUT_DIR = OUT_OVERRIDE ? path.resolve(OUT_OVERRIDE) : path.join(FRONTEND_DIR, 'public', 'screenshots');
if (SITE) {
  const inPublic = path.relative(path.join(FRONTEND_DIR, 'public'), OUT_DIR);
  if (!inPublic || (!inPublic.startsWith('..') && !path.isAbsolute(inPublic))) {
    die(`--story=site writes outside frontend/public (it was given ${OUT_DIR}); copy the frames in by hand once they have been looked at`);
  }
}
// Every key the backend reads for a service that bills or reaches a third
// party, blanked for the site story (backendEnv).
const SITE_BLANK_KEYS = [
  'GOOGLE_PLACES_API_KEY', 'GEMINI_API_KEY', 'WEATHER_API_KEY', 'TICKETMASTER_API_KEY',
  'VISION_API_KEY', 'GOOGLE_VISION_API_KEY', 'STRIPE_SECRET_KEY', 'REVENUECAT_SECRET_API_KEY',
  'REVENUECAT_V2_SECRET_API_KEY', 'POSTHOG_API_KEY', 'MAPTILER_SERVICE_TOKEN', 'SPORTSDB_API_KEY',
];
/* The map's browser key, the one key the site story can be given. It is the
   key every visitor's browser already sends to the map tiles, read from the
   environment at build time only and never written anywhere: with it the build
   draws the map (and the plan card's map strip), and the reel's fifth frame is
   the Discover map; without it, the search list. */
const SITE_MAP_KEY = SITE ? (process.env.SHOTS_MAPTILER_KEY || '') : '';

/* ONE SIZE OF YOUR OWN (--viewport=430x932 --scale=3). Every screen asked for
   is shot at it, the owner screens and the narrow-only ones included, in
   place of the web and App Store sets, and written to --out only: frames made
   for one job stay out of public/ and store-assets/. Portrait, 320 to 500 CSS
   px wide, because above 500 the app draws its desktop phone frame instead of
   the full-bleed app. screenshotRigSize.test.js lifts this function. */
function customSize(viewportArg, scaleArg) {
  if (viewportArg == null && scaleArg == null) return null;
  if (viewportArg == null || scaleArg == null) throw new Error('--viewport and --scale go together, e.g. --viewport=430x932 --scale=3');
  const m = /^(\d{3})x(\d{3,4})$/.exec(String(viewportArg));
  if (!m) throw new Error(`--viewport takes WIDTHxHEIGHT in CSS pixels, e.g. 430x932, not "${viewportArg}"`);
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width < 320 || width > 500) throw new Error(`--viewport width ${width} is outside 320 to 500 (above 500 the app draws its desktop phone frame)`);
  if (height < width) throw new Error(`--viewport ${viewportArg} is landscape; the app is shot portrait`);
  if (!/^[1-4]$/.test(String(scaleArg))) throw new Error(`--scale takes 1, 2, 3 or 4, not "${scaleArg}"`);
  const dsf = Number(scaleArg);
  return { id: `custom-${width}x${height}@${dsf}`, viewport: { width, height }, dsf, out: 'custom', custom: true };
}
let CUSTOM_SIZE = null;
try {
  CUSTOM_SIZE = customSize(opt('viewport'), opt('scale'));
} catch (e) {
  die(e.message);
}
if (CUSTOM_SIZE && !OUT_OVERRIDE) die('a --viewport run writes only to --out=<folder>');

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
    // The site story spends nothing, on any machine: every key a screen could
    // spend is blank (dotenv never fills a variable that exists, even an empty
    // one), so a call that slipped past the browser's answers fails here
    // instead of billing. Its screens are answered in the browser
    // (installSiteStubs).
    ...(SITE ? Object.fromEntries(SITE_BLANK_KEYS.map((k) => [k, ''])) : {}),

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
//    (The venue MAP and search intentionally show live Google Places results,
//    which is what the shipping app shows, but every venue picture is a drawing
//    from shot-art.mjs: no Places photo is ever captured.)
// ---------------------------------------------------------------------------
const DEMO = {
  password: 'Screenshot1',
  // The Nest greets the camera account by its first name, in the first App
  // Store screenshot, so that set gets an ordinary one. The site story's five
  // are the people its pages follow (seedSite): two of the names are real,
  // the two people who make Flock, and each of the five has a painted bird
  // for a picture, never a face.
  camera: SITE
    ? { email: 'jayden@shots.flock.local', name: 'Jayden Bansal' }
    : { email: 'maya@shots.flock.local', name: SET === 'appstore' ? 'Maya Chen' : 'Judge' },
  friends: SITE
    ? [
      { email: 'asad@shots.flock.local', name: 'Asad Ali' },
      { email: 'nick@shots.flock.local', name: 'Nick Ferraro' },
      { email: 'kaitlyn@shots.flock.local', name: 'Kaitlyn Brennan' },
      { email: 'tommy@shots.flock.local', name: 'Tommy Walsh' },
    ]
    : [
      { email: 'jordan@shots.flock.local', name: 'Jordan Avery' },
      { email: 'sam@shots.flock.local', name: 'Sam Rivera' },
      { email: 'priya@shots.flock.local', name: 'Priya Shah' },
      { email: 'leo@shots.flock.local', name: 'Leo Martin' },
    ],
  owner: { email: 'owner@shots.flock.local', name: 'Copper Finch Owner' },
  flockName: 'Friday Night Crew',
  // Invented venue used in chat cards, votes, and the owner dashboard. A burger
  // and wings place rather than a bar: it is in the chat screenshot of the App
  // Store set, which has to suit a 4+ audience (Guideline 2.3.8).
  venue: {
    name: 'The Copper Finch',
    placeId: 'shots_copper_finch_0001',
    addr: '214 Main St',
    category: 'Burgers & wings',
  },
  rivalVenueName: 'Juniper Bowl',
  // The plan the `made` scenario creates through the real form.
  madeName: 'Taco Tuesday',
  // A confirmed plan inside its night-of window (see the seed). `guest` has
  // already answered from the link; `newGuest` is who the guestlink scenario
  // answers as.
  night: { name: 'Trivia Night', guest: 'Casey', newGuest: 'Riley' },
};

/* A share-link token the way routes/guest.js mints one: 24 characters from
   its look-alike-free alphabet, each drawn uniformly. The alphabet is copied
   rather than imported because that module pulls in the pool and the
   middleware chain on load, and this script must never touch either. */
const LINK_TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // gitleaks:allow -- character set for token generation, not a credential
function inviteLinkToken() {
  let t = '';
  while (t.length < 24) t += LINK_TOKEN_ALPHABET[crypto.randomInt(LINK_TOKEN_ALPHABET.length)];
  return t;
}

async function seed(dbUrl) {
  // THE SEED WRITES WHAT PRODUCTION WRITES (2026-11-03). The naive TIMESTAMP
  // columns (flocks.event_time, every created_at in 000_bootstrap.sql) hold UTC
  // wall-clock: the backend's pool runs its sessions in UTC
  // (config/database.js) and server.js runs the process in UTC, so it reads
  // them back as UTC. This client used the embedded server's default zone,
  // which initdb takes from the machine (America/New_York here), and sent its
  // Dates in local time, so its rows held New York wall-clock and every seeded
  // plan, message and member row read back four or five hours early once the
  // backend stopped borrowing the machine's zone (while the night-of plan,
  // seeded in UTC wall-clock, had read five hours late before that). The
  // session is UTC here too, and the plan times below go in as instants.
  const db = new Client({ connectionString: dbUrl, options: '-c TimeZone=UTC' });
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
  // "Friday Night Crew" really lands on a Friday chip. Sent as the instant's
  // ISO string, which a naive column stores as UTC wall-clock, the way the app
  // sends a plan's time (the create screen posts toISOString()).
  const nextOccurrence = (dow, hour) => {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    let ahead = (dow - d.getDay() + 7) % 7;
    if (ahead === 0 && d <= new Date()) ahead = 7;
    d.setDate(d.getDate() + ahead);
    return d.toISOString();
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
    type: 'restaurant',
    stars: 4.6,
    rating: 4.6,
    price: '$$',
    price_level: 2,
    place_id: DEMO.venue.placeId,
    // Without this the card falls through to /marks/venue-placeholder.webp, the
    // painted wren, and every screenshot of the vote flow shipped showing a bird
    // where a venue photo belongs. The Copper Finch is invented, so it has no
    // Google Places photo to fetch.
    //
    // THE IMAGE IS DRAWN, AND IT HAS TO BE. The first version of this line
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
    //
    // Its replacement, public/marks/venue-demo-bar.jpg, was a bar interior with
    // the bottle shelves in view, which the App Store set cannot show either.
    // So the card now points at the photo proxy with a ref of its own, and the
    // rig answers that request, like every other venue photo, with a drawing
    // from shot-art.mjs (the dining room). resolveVenuePhoto prefixes the API origin
    // for paths beginning "/api/", which is what routes it there. Outside the
    // rig the proxy finds no such ref and the card shows the painted wren.
    photo_url: '/api/venues/photo?ref=shots-copper-finch&maxwidth=400',
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
     VALUES ($1,$2,'Burgers & wings','214 Main St','Wings, burgers and tables for big groups. Busiest after 7.',$3,TRUE,'free','[]')
     ON CONFLICT (user_id) DO UPDATE SET google_place_id = EXCLUDED.google_place_id, verified = TRUE`,
    [owner, DEMO.venue.name, DEMO.venue.placeId]
  );
  await q(
    `INSERT INTO venue_promotions (venue_user_id, google_place_id, title, description, time_slot, days, active)
     VALUES ($1,$2,'Half-price wings','Every order of wings is half price.','9 PM to close','Thu, Fri, Sat',TRUE)`,
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
  // are a plausible curve for a busy evening restaurant; the numbers rendered
  // are whatever the real predictor computes from these rows.
  await q(
    `INSERT INTO ml_venues (google_place_id, name, address, city, latitude, longitude, venue_category, timezone, rating, review_count)
     VALUES ($1,$2,$3,'Bethlehem',40.6259,-75.3705,'restaurant','America/New_York',4.6,182)
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

  // ---- A confirmed plan inside its night-of window -------------------------
  // What the "still in?" strip, the roster marks and the guest link are
  // photographed against. Two hours out, in UTC wall-clock: flocks.event_time
  // is a naive TIMESTAMP and utils/reconfirm.js decides "open" by comparing it
  // with NOW() AT TIME ZONE 'UTC', so a time seeded in local wall-clock would
  // read as already past on any machine west of Greenwich and the window would
  // be shut. reconfirm_opened_at is written here rather than left to the sweep,
  // which only opens windows at its own lead. Two accepted members, one of whom
  // has answered, and one visible 'in' guest who has, so the camera account
  // sees "2 of 3" with the question still addressed to it. The budget is on so
  // the link carries the amount ask too. One message, so the plan has a row in
  // the Messages list to be opened from.
  const night = await q(
    `INSERT INTO flocks (name, creator_id, venue_id, venue_name, event_time, status, budget_enabled, reconfirm_opened_at)
     VALUES ($1,$2,$3,$4,(NOW() AT TIME ZONE 'UTC') + interval '2 hours','confirmed',TRUE,NOW())
     RETURNING id`,
    [DEMO.night.name, maya, DEMO.venue.placeId, DEMO.venue.name]
  );
  const nightId = night.rows[0].id;
  await q(`INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1,$2,'accepted')`, [nightId, maya]);
  await q(`INSERT INTO flock_members (flock_id, user_id, status, reconfirmed_at) VALUES ($1,$2,'accepted',NOW())`, [nightId, jordan]);
  const nightGuest = await q(
    `INSERT INTO guest_rsvps (flock_id, name, status, reconfirmed_at) VALUES ($1,$2,'in',NOW()) RETURNING id`,
    [nightId, DEMO.night.guest]
  );
  await q(
    `INSERT INTO messages (flock_id, sender_id, message_text, message_type, created_at)
     VALUES ($1,$2,'we still on for tonight?','text', NOW() - interval '40 minutes')`,
    [nightId, jordan]
  );
  // The share link, on the same terms routes/flocks.js mints one: fourteen
  // days, not revoked, created by the plan's creator.
  const nightToken = inviteLinkToken();
  await q(
    `INSERT INTO flock_invite_links (token, flock_id, created_by, expires_at)
     VALUES ($1,$2,$3, NOW() + interval '14 days')`,
    [nightToken, nightId, maya]
  );

  await db.end();
  log(`seeded: 6 users, flock "${DEMO.flockName}" (${msgs.length} messages, 4 votes, 4 budgets), venue "${DEMO.venue.name}" (promo, 3 reviews, 4 live check-ins, 168 baseline rows), night-of plan "${DEMO.night.name}" (window open, 2 of 3 answered, share link minted)`);
  return { maya, flockId, owner, night: { flockId: nightId, guestId: nightGuest.rows[0].id, token: nightToken } };
}

/* The guestlink scenario answers as a new guest, says still in and gives a
   number, and every size and theme pass runs it again from a fresh context.
   Its rows are cleared before each pass so "2 of 3" is what every pass
   photographs: the seeded guest stays, the one the driver added goes, and the
   guest's budget row goes with it (guest_rsvp_id is ON DELETE CASCADE). */
async function resetNightRows(dbUrl, night) {
  if (!night) return;
  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  await db.query('DELETE FROM guest_rsvps WHERE flock_id = $1 AND id <> $2', [night.flockId, night.guestId]);
  await db.end();
}

// ---------------------------------------------------------------------------
// 3b. The site story (--story=site): its clock, its places, its seed.
// ---------------------------------------------------------------------------

/* 7 PM WHEREVER THE RUN HAPPENS. The website's frames are an evening out, so
   the browser's clock reads 7 PM whatever the hour of the run: its time zone
   is the Etc/GMT zone where it is 7 PM now (tools/e2e/clock.js), the way the
   browser suite pins a local hour, so the instant itself stays real and the
   server, the session and every window agree with the page. Every seeded time
   is a wall-clock time in that zone (`at`), so "tonight at 9" is 9 PM on the
   screen on any day the run happens. `dow` and `hour` are the zone's own. */
function siteClock(now, zoneFor) {
  const zone = zoneFor(19, now);
  // Etc/GMT zones carry the sign backwards: Etc/GMT-6 is six hours ahead.
  const m = /^Etc\/GMT([+-])(\d+)$/.exec(zone);
  const offsetH = m ? (m[1] === '-' ? 1 : -1) * Number(m[2]) : 0;
  const local = new Date(now.getTime() + offsetH * 3600000);
  const y = local.getUTCFullYear();
  const mo = local.getUTCMonth();
  const d = local.getUTCDate();
  return {
    zone,
    offsetH,
    dow: local.getUTCDay(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    // The instant whose wall clock there reads hh:mm, daysAhead days from
    // today there, as the ISO string a naive column keeps as UTC.
    at: (daysAhead, hh, mm = 0) => new Date(Date.UTC(y, mo, d + daysAhead, hh - offsetH, mm)).toISOString(),
    // That day's date there, YYYY-MM-DD.
    date: (daysAhead) => new Date(Date.UTC(y, mo, d + daysAhead)).toISOString().slice(0, 10),
  };
}

/* NOT ON A FRIDAY, AND NOT LATE IN THE HOUR. Friday Night Crew is the coming
   Friday, and on a Friday that is a week out: past the seven days the venue
   dashboard's incoming list reads (routes/venueDashboard.js), so the owner's
   frame would lose its "Party of 5, Considering you". The zone is picked for
   7 PM, so that refusal holds from 05:00 UTC on a Friday to 05:00 UTC on the
   Saturday. And the answers given in the browser are 7 PM's (the crowd's "now"
   bar, the weather), while the page's own clock runs on, so a run must not
   start so late in the hour that its frames are taken at 8. */
function siteRefusal(clock) {
  if (clock.dow === 5) return 'it is Friday at 7 PM where the site story stands, and Friday Night Crew would be a week out, past the seven days the venue dashboard lists. Run it on any other day';
  if (clock.minute >= 50) return `it is 7:${clock.minute} PM where the site story stands, and the run would end after 8. Start it in the first fifty minutes of an hour`;
  return null;
}

// The instant the run started: every answer the browser is given (the crowd,
// the weather, the Birdie turn) is this one moment's.
const RUN_T = new Date();
const SITE_CLOCK = SITE ? siteClock(RUN_T, zoneForLocalHour) : null;

/* THE PLACES, ALL INVENTED. Old City, Philadelphia is where the camera stands
   (its map, its weather), and every place around it here is made up, its name
   searched for first so that it names no business there, its address a
   number on a Main St that has no such number, and its picture a drawing from
   shot-art.mjs (`ref`; shots-art-<id> names a drawing). `d` is the place's
   offset from the camera, west of Columbus Blvd so no pin lands in the river,
   and `score` its crowd figure at 7 PM, written here and served in the
   browser as the crowd service's answer. No bars, and no drinks in any
   picture: the website is for everyone. */
const SITE_CAMERA = { lat: 39.9502, lng: -75.1447 };
const SITE_VENUES = [
  { key: 'finch', id: 'shots_copper_finch_0001', name: 'The Copper Finch', addr: '214 Main St', ref: 'shots-copper-finch', types: ['american_restaurant', 'restaurant', 'food'], price: 2, rating: 4.6, reviews: 412, d: [-0.0006, -0.0056], score: 78, open: 11, close: 1 },
  { key: 'juniper', id: 'shots_juniper_bowl_0002', name: 'Juniper Bowl', addr: '88 Main St', ref: 'shots-art-noodles', types: ['ramen_restaurant', 'restaurant', 'food'], price: 2, rating: 4.5, reviews: 268, d: [0.0035, -0.0080], score: 58, open: 11, close: 22 },
  { key: 'bluewing', id: 'shots_bluewing_diner_0003', name: 'Bluewing Diner', addr: '301 Main St', ref: 'shots-art-pancakes', types: ['diner', 'restaurant', 'food'], price: 1, rating: 4.3, reviews: 190, d: [-0.0040, -0.0020], score: 34, open: 7, close: 23 },
  { key: 'kestrel', id: 'shots_kestrel_pizza_0004', name: 'Kestrel Pizza Co.', addr: '57 Main St', ref: 'shots-art-pizza', types: ['pizza_restaurant', 'restaurant', 'food'], price: 2, rating: 4.4, reviews: 351, d: [0.0020, -0.0035], score: 72, open: 11, close: 23 },
  { key: 'saltmarsh', id: 'shots_saltmarsh_tacos_0005', name: 'Saltmarsh Tacos', addr: '12 Main St', ref: 'shots-art-tacos', types: ['mexican_restaurant', 'restaurant', 'food'], price: 1, rating: 4.6, reviews: 233, d: [-0.0025, -0.0065], score: 66, open: 10, close: 22 },
  { key: 'bunting', id: 'shots_snow_bunting_0006', name: 'Snow Bunting Creamery', addr: '7 Main St', ref: 'shots-art-ice-cream', types: ['ice_cream_shop', 'dessert_shop', 'food'], price: 1, rating: 4.8, reviews: 412, d: [0.0010, 0.0012], score: 45, open: 11, close: 23 },
  { key: 'plover', id: 'shots_plover_sushi_0007', name: 'Plover Sushi', addr: '410 Main St', ref: 'shots-art-sushi', types: ['sushi_restaurant', 'restaurant', 'food'], price: 3, rating: 4.7, reviews: 302, d: [0.0045, -0.0015], score: 81, open: 16, close: 23 },
  { key: 'wren', id: 'shots_wren_rye_0008', name: 'Wren & Rye Bakery', addr: '22 Main St', ref: 'shots-art-bakery', types: ['bakery', 'cafe', 'food'], price: 1, rating: 4.5, reviews: 147, d: [-0.0055, -0.0090], score: 18, open: 6, close: 20 },
  { key: 'fernway', id: 'shots_fernway_greens_0009', name: 'Fernway Greens', addr: '134 Main St', ref: 'shots-art-salad', types: ['salad_shop', 'restaurant', 'food'], price: 2, rating: 4.2, reviews: 98, d: [0.0060, -0.0060], score: 27, open: 10, close: 21 },
];
const SITE_VENUE = Object.fromEntries(SITE_VENUES.map((v) => [v.key, v]));
const sitePhoto = (ref, w = 400) => `/api/venues/photo?ref=${ref}&maxwidth=${w}`;
/* The Copper Finch's four photos, as a listed venue's Place Details would give
   them, in the order its "Happening here" cards take them (photos[1..3], one
   event each, soonest first: the trivia night tonight, the wing contest
   tomorrow, the acoustic night on Friday), and its logo, a fifth picture. */
const SITE_FINCH_PHOTOS = ['shots-copper-finch', 'shots-copper-finch-counter', 'shots-copper-finch-wings', 'shots-copper-finch-stage'];
const SITE_FINCH_LOGO = sitePhoto('shots-copper-finch-logo');
/* The Copper Finch's usual day by hour; hours it is shut are absent. The
   dinner rush runs 8 to 9 (the two within the engine's three points of each
   other, so the card's busiest hours are both), the room is quietest at 11,
   and the late kitchen picks up again at midnight. The card's quiet hour is
   the engine's pick, the quietest open hour left tonight outside the rush, so
   a quieter midnight would be named instead: the first -v3 curve had one
   (26), under a card that said 11 PM. */
const SITE_FINCH_CURVE = { 11: 24, 12: 41, 13: 37, 14: 22, 15: 19, 16: 27, 17: 46, 18: 63, 19: 78, 20: 82, 21: 80, 22: 58, 23: 38, 0: 44 };
// The crowd service's own ladder (backend services/crowdEngine.js getLabel).
const siteLabel = (s) => (s <= 20 ? 'Quiet' : s <= 39 ? 'Not Busy' : s <= 69 ? 'Steady' : s <= 84 ? 'Busy' : 'Packed');
const siteHourLabel = (h) => { const x = ((h % 24) + 24) % 24; return x === 0 ? '12 AM' : x < 12 ? `${x} AM` : x === 12 ? '12 PM' : `${x - 12} PM`; };
const siteOpenAt = (v, h) => (v.close > v.open ? h >= v.open && h < v.close : h >= v.open || h < v.close);
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const siteClockWords = (h) => { const x = ((h % 24) + 24) % 24; const hh = x % 12 === 0 ? 12 : x % 12; return `${hh}:00 ${x < 12 ? 'AM' : 'PM'}`; };
// Opening hours the way Places writes them (currentOpeningHours).
function siteOpeningHours(v) {
  const h = SITE_CLOCK ? SITE_CLOCK.hour : 19;
  const periods = Array.from({ length: 7 }, (_, day) => ({
    open: { day, hour: v.open, minute: 0 },
    close: { day: v.close > v.open ? day : (day + 1) % 7, hour: v.close % 24, minute: 0 },
  }));
  const weekdayDescriptions = [1, 2, 3, 4, 5, 6, 0].map((day) => `${DAY_NAMES[day]}: ${siteClockWords(v.open)} – ${siteClockWords(v.close)}`);
  return { openNow: siteOpenAt(v, h), periods, weekdayDescriptions };
}
const siteLocation = (v) => ({ latitude: +(SITE_CAMERA.lat + v.d[0]).toFixed(6), longitude: +(SITE_CAMERA.lng + v.d[1]).toFixed(6) });
// A row of GET /api/venues/search (backend routes/venueSearch.js).
function siteSearchRow(v) {
  return {
    place_id: v.id,
    name: v.name,
    formatted_address: v.addr,
    rating: v.rating,
    user_ratings_total: v.reviews,
    price_level: v.price,
    photo_url: sitePhoto(v.ref),
    photo_attribution: null,
    types: v.types,
    opening_hours: siteOpeningHours(v),
    location: siteLocation(v),
    utcOffsetMinutes: SITE_CLOCK.offsetH * 60,
    timeZone: SITE_CLOCK.zone,
  };
}
// GET /api/venues/details's `venue` (shapeDetails in the same file).
function siteDetails(v) {
  const photos = v.key === 'finch' ? SITE_FINCH_PHOTOS.map((r) => sitePhoto(r, 600)) : [sitePhoto(v.ref, 600)];
  return {
    ...siteSearchRow(v),
    formatted_phone_number: null,
    website: null,
    photos,
    photo_attributions: photos.map(() => null),
    photo_url: photos[0],
    google_maps_url: null,
    menu_url: null,
  };
}
const siteClockNow = () => ({ hour: SITE_CLOCK.hour, day: SITE_CLOCK.dow, utcOffsetMinutes: SITE_CLOCK.offsetH * 60, local: true });
/* A place's crowd card as GET /api/crowd/:placeId answers it (routes/crowd.js),
   from the rule engine: what is typical for a place like it, which the card
   says in so many words ("An estimate from typical patterns for this kind of
   place."), and which is why its label is hedged ("Usually busy"). No
   numberSource: none is sent for a rule-engine number.
   The figures are written here; what the card says about them is not. The
   route hands the engine a 24-hour forecast from the venue's hour and the
   venue's hours by weekday, takes the busiest hours off the first twelve
   (findPeakTime) and the quiet hour off every open hour left tonight
   (recommendBestTime, where 12 AM after a 7 PM "now" is the same night), and
   draws the twelve with each bar's open flag. This does the same with the
   same functions. A hand-written rule here once looked four hours ahead and
   put "Least crowded: 11 PM" over a chart whose midnight bar was lower. */
function siteCrowdCard(v) {
  const now = SITE_CLOCK.hour;
  const day = SITE_CLOCK.dow;
  const curve = v.key === 'finch' ? SITE_FINCH_CURVE : null;
  // The venue as routes/crowd.js shapes it from Place Details: its hours from
  // the same periods the search row carries.
  const venue = {
    types: v.types,
    price_level: v.price,
    ...crowdEngine.venueHoursForDay(siteOpeningHours(v).periods, day),
    isOpen: siteOpenAt(v, now),
  };
  const fullDay = Array.from({ length: 24 }, (_, i) => {
    const h = (now + i) % 24;
    const open = siteOpenAt(v, h);
    const score = !open ? 6 : curve && curve[h] != null ? curve[h] : Math.max(8, Math.round(v.score - Math.abs(i - 1) * 7));
    return { hour: siteHourLabel(h), score, label: siteLabel(score), predictionMethod: 'rule_engine' };
  });
  const bars = fullDay.slice(0, 12);
  const barClock = crowdEngine.stripClock(bars, now);
  const hourly = bars.map((b, i) => ({
    ...b,
    open: i === 0 ? venue.isOpen : crowdEngine.isOpenAt(venue, barClock[i].hour, day + barClock[i].dayOffset),
  }));
  const score = v.score;
  const peak = crowdEngine.findPeakTime(bars, venue, { startDay: day });
  const best = crowdEngine.recommendBestTime(fullDay, venue, peak.startIdx, peak.endIdx, venue.isOpen, {
    currentHour: now,
    currentDay: day,
    currentScore: score,
  });
  return {
    placeId: v.id,
    name: v.name,
    score,
    label: `Usually ${siteLabel(score).toLowerCase()}`,
    rawEngineScore: score,
    confidence: 42,
    predictionMethod: 'rule_engine',
    confidenceBasis: 'category_pattern',
    confidenceMeans: 'input_completeness',
    supported: false,
    capacity: null,
    // routes/crowd.js bestTimeFields: the hour named, and the bar it names
    // when that bar is one of the twelve drawn.
    bestTime: best.text,
    peak: peak.text,
    waitEstimate: score < 40 ? 'No wait' : score <= 55 ? '~5 min' : score <= 69 ? '10-20 min' : score <= 84 ? '20-35 min' : '35+ min',
    venueTypes: v.types,
    priceLevel: v.price,
    isOpen: venue.isOpen,
    openHour: venue.openHour,
    closeHour: venue.closeHour,
    hoursToday: venue.hoursToday,
    hourly,
    bestHour: best.dayOffset === 0 ? best.hourLabel : null,
    bestIndex: (best.dayOffset === 0 && best.index >= 0 && best.index < hourly.length && best.hourLabel) ? best.index : null,
    bestIsNow: best.hourLabel == null,
    factors: [],
    calibration: { feedbackUsed: false, reportCount: 0, predictionDrift: 0 },
    dataSourcesUsed: [],
    modelVersion: null,
    baselineData: null,
    weather: null,
    eventAlert: null,
    gameNight: null,
    lastUpdated: RUN_T.toISOString(),
    venueClock: siteClockNow(),
  };
}

/* THE SITE STORY'S SEED. The five people the website's words follow, their
   four plans and the invented places, written as production writes them: a
   UTC session and instants, so every naive column holds UTC wall-clock. Every
   time is a wall-clock time where the camera stands (siteClock). The plans:
     Trivia Night       tonight 9:00 PM at The Copper Finch, locked in, the
                        camera account's, Asad and Kaitlyn already still in:
                        the Nest's hero, the roster frame and the owner's
                        "Party of 3".
     Friday Night Crew  the coming Friday 8:00 PM, all five, still voting: The
                        Copper Finch leads 3 to 1 to 1, four budgets of five in,
                        the camera account's the open one (its $35 sheet).
     Nick's Birthday    in two days, Nick's, at Snow Bunting Creamery: the
                        camera account has not voted, so it is asked to.
     Thursday Dinner    last Thursday at Kestrel Pizza Co., finished: $120.85
                        plus an 18% tip is $142.60, $28.52 each, Asad paid.
   Returns the ids the passes and frames need. */
async function seedSite(dbUrl) {
  const db = new Client({ connectionString: dbUrl, options: '-c TimeZone=UTC' });
  await db.connect();
  const q = (text, params) => db.query(text, params);
  const at = SITE_CLOCK.at;
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
  const jayden = await mkUser(DEMO.camera);
  const ids = {};
  for (const f of DEMO.friends) ids[f.name.split(' ')[0].toLowerCase()] = await mkUser(f);
  const owner = await mkUser(DEMO.owner, 'venue_owner');

  /* PROFILE PICTURES: a painted bird each, one species a person, never a face
     (two of these names are real people). 160px JPEGs in scripts/shot-avatars,
     sent as data URLs under the 11,000 characters a list read lets through
     (lib/avatarImage.js). The owner's house finch is the venue account's own. */
  for (const [file, uid] of [['jayden', jayden], ['asad', ids.asad], ['nick', ids.nick], ['kaitlyn', ids.kaitlyn], ['tommy', ids.tommy], ['owner', owner]]) {
    const url = `data:image/jpeg;base64,${fs.readFileSync(path.join(__dirname, 'shot-avatars', `${file}.jpg`)).toString('base64')}`;
    if (url.length > 11000) throw new Error(`shot-avatars/${file}.jpg is ${url.length} characters as a data URL, over the 11,000 a list read lets through`);
    await q('UPDATE users SET profile_image_url = $1 WHERE id = $2', [url, uid]);
  }

  // The camera account is friends with all four, and has a plan history so
  // its profile is not a brand-new account's, every number on it true of
  // this database.
  for (const fid of [ids.asad, ids.nick, ids.kaitlyn, ids.tommy]) {
    await q(
      `INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1,$2,'accepted')
       ON CONFLICT (requester_id, addressee_id) DO UPDATE SET status='accepted'`,
      [fid, jayden]
    );
  }
  await q('UPDATE users SET total_plans_joined = 6, total_plans_attended = 5, reliability_score = 92 WHERE id = $1', [jayden]);
  // The camera account let Birdie use Google's Gemini weeks ago (the question
  // this build asks, copy 2), so the Nest's field takes a question at once.
  await q(`UPDATE users SET birdie_ai_consent_at = NOW() - interval '20 days', birdie_ai_consent_copy = 2 WHERE id = $1`, [jayden]);

  // Two trusted contacts for the SOS sheet. 555-01xx numbers and example.com
  // addresses are reserved for fiction.
  for (const [name, phone, email, rel] of [
    ['Linda Novak', '(215) 555-0142', 'linda.novak@example.com', 'Mom'],
    ['Dan Okafor', '(215) 555-0187', 'dan.okafor@example.com', 'Roommate'],
  ]) {
    await q(
      `INSERT INTO trusted_contacts (user_id, contact_name, contact_phone, contact_email, relationship, email_set_at)
       VALUES ($1,$2,$3,$4,$5,NOW()) ON CONFLICT (user_id, contact_phone) DO NOTHING`,
      [jayden, name, phone, email, rel]
    );
  }

  // Out tonight: Nick and Tommy are down, Kaitlyn maybe, each until the next
  // 4 AM there, as the app's own answer expires.
  for (const [uid, status, setAt] of [[ids.nick, 'down', at(0, 17, 48)], [ids.tommy, 'down', at(0, 18, 25)], [ids.kaitlyn, 'maybe', at(0, 18, 2)]]) {
    await q(
      `INSERT INTO availability_pulses (user_id, status, set_at, expires_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id) DO UPDATE SET status = EXCLUDED.status, set_at = EXCLUDED.set_at, expires_at = EXCLUDED.expires_at`,
      [uid, status, setAt, at(1, 4, 0)]
    );
  }

  // ---- The Copper Finch's own side ------------------------------------------
  const finch = SITE_VENUE.finch;
  await q(
    `INSERT INTO venue_profiles (user_id, business_name, category, location, description, google_place_id, verified, tier, operating_hours, photo_url)
     VALUES ($1,$2,'Burgers & wings',$3,'Wings, burgers and tables for big groups. Busiest after 7.',$4,TRUE,'free','[]',$5)
     ON CONFLICT (user_id) DO UPDATE SET google_place_id = EXCLUDED.google_place_id, verified = TRUE, photo_url = EXCLUDED.photo_url`,
    [owner, finch.name, finch.addr, finch.id, SITE_FINCH_LOGO]
  );
  // Two deals with the views and claims a listing's weeks would have. A card
  // shows a venue's newest deal (backend utils/venueDeals.js), so the wings.
  await q(
    `INSERT INTO venue_promotions (venue_user_id, google_place_id, title, description, time_slot, days, active, views, claims, created_at)
     VALUES ($1,$2,'Free fries for groups of 6+','Bring six or more and the table gets a basket of fries.','All day','Every day',TRUE,214,38, NOW() - interval '9 days'),
            ($1,$2,'Half-price wings','Every order of wings is half price.','9 PM to close','Thu, Fri, Sat',TRUE,131,17, NOW() - interval '2 days')`,
    [owner, finch.id]
  );
  // "Happening here": tonight's trivia (the plan the five are going to),
  // a wing contest tomorrow and an acoustic night on Friday. Not "Live music":
  // no frame says Live.
  const toFri = ((5 - SITE_CLOCK.dow + 7) % 7) || 7;
  await q(
    `INSERT INTO venue_events (venue_user_id, google_place_id, title, event_date, event_time, capacity, rsvps)
     VALUES ($1,$2,'Trivia Night',$3,'9 PM',60,34),
            ($1,$2,'Wing-eating contest',$4,'6 PM',40,19),
            ($1,$2,'Acoustic night',$5,'8:30 PM',80,22)`,
    [owner, finch.id, SITE_CLOCK.date(0), SITE_CLOCK.date(1), SITE_CLOCK.date(toFri)]
  );
  // Three reviews over three weeks, and the owner's reply to Asad's
  // (venue_reply_user_id: only the venue's current owner speaks for it).
  for (const [uid, rating, text, daysAgo] of [
    [ids.asad, 5, 'Went with four friends on a Friday, service kept up even at peak. Wings earn the hype.', 17],
    [ids.kaitlyn, 4, 'Good spot for a group. Gets loud after 10 but that is kind of the point.', 9],
    [ids.tommy, 5, 'Fast kitchen, fair prices, easy to hold a table for six.', 3],
  ]) {
    await q(
      `INSERT INTO venue_reviews (google_place_id, user_id, rating, text, created_at) VALUES ($1,$2,$3,$4, NOW() - ($5 || ' days')::interval)
       ON CONFLICT (google_place_id, user_id) DO NOTHING`,
      [finch.id, uid, rating, text, daysAgo]
    );
  }
  await q(
    `UPDATE venue_reviews SET venue_reply = 'Thanks Asad. Friday crews are what we are built for.', venue_replied_at = NOW() - interval '16 days', venue_reply_user_id = $3
     WHERE google_place_id = $1 AND user_id = $2`,
    [finch.id, ids.asad, owner]
  );
  for (const [uid, minAgo] of [[ids.asad, 50], [ids.nick, 35], [ids.kaitlyn, 20], [ids.tommy, 10]]) {
    await q(
      `INSERT INTO venue_checkins (venue_place_id, user_id, checkin_source, created_at)
       VALUES ($1,$2,'manual', NOW() - ($3 || ' minutes')::interval)`,
      [finch.id, uid, minAgo]
    );
  }
  // The analytics side's corpus row and 168-hour week, at its own coordinates.
  const loc = siteLocation(finch);
  await q(
    `INSERT INTO ml_venues (google_place_id, name, address, city, latitude, longitude, venue_category, timezone, rating, review_count)
     VALUES ($1,$2,$3,'Philadelphia',$4,$5,'restaurant','America/New_York',$6,$7)
     ON CONFLICT (google_place_id) DO NOTHING`,
    [finch.id, finch.name, finch.addr, loc.latitude, loc.longitude, finch.rating, finch.reviews]
  );
  const week = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const busy = SITE_FINCH_CURVE[h] != null ? SITE_FINCH_CURVE[h] : 0;
      week.push(`('${finch.id}', ${d}, ${h}, ${(d === 4 || d === 5 || d === 6) && h >= 19 && h <= 22 ? Math.min(95, busy + 8) : busy}, 'collected')`);
    }
  }
  await q(`INSERT INTO ml_venue_baselines (google_place_id, day_of_week, hour, baseline, source) VALUES ${week.join(',')} ON CONFLICT DO NOTHING`);

  // ---- The plans ------------------------------------------------------------
  // Each plan keeps its place's coordinates, as a plan whose venue was picked
  // from a search does: with the map's key the plan card heads the venue with
  // the block it is on (FlockDetail.js), and without the key nothing reads
  // them (StaticVenueMap draws nothing; "who is here" needs shared positions).
  const mkPlan = async (p) => {
    const spot = p.venue ? siteLocation(p.venue) : null;
    const r = await q(
      `INSERT INTO flocks (name, creator_id, venue_id, venue_name, venue_address, venue_latitude, venue_longitude, venue_photo_url, venue_rating, event_time, status, budget_enabled, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING id`,
      [p.name, p.host, p.venue ? p.venue.id : null, p.venue ? p.venue.name : null, p.venue ? p.venue.addr : null,
        spot ? spot.latitude : null, spot ? spot.longitude : null,
        p.photo || null, p.venue ? p.venue.rating : null, p.when, p.status, !!p.budget, p.created]
    );
    const id = r.rows[0].id;
    for (const uid of p.members) {
      await q(`INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1,$2,'accepted') ON CONFLICT (flock_id, user_id) DO NOTHING`, [id, uid]);
    }
    return id;
  };
  const say = async (flockId, uid, text, when, extra = {}) => {
    const r = await q(
      `INSERT INTO messages (flock_id, sender_id, message_text, message_type, venue_data, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [flockId, uid, text, extra.type || 'text', extra.venue ? JSON.stringify(extra.venue) : null, when]
    );
    return r.rows[0].id;
  };
  const vote = (flockId, uid, v, when) => q(
    `INSERT INTO venue_votes (flock_id, user_id, venue_name, venue_id, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [flockId, uid, v.name, v.id, when]
  );
  const all5 = [jayden, ids.asad, ids.nick, ids.kaitlyn, ids.tommy];

  // Trivia Night: locked in days ago (so the Nest's one-time lock moment is
  // long past), its night-of window open, Asad and Kaitlyn still in, the
  // camera account not yet. No budget, no guest.
  const trivia = await mkPlan({ name: 'Trivia Night', host: jayden, venue: finch, photo: sitePhoto('shots-copper-finch-counter'), when: at(0, 21, 0), status: 'confirmed', members: [jayden, ids.asad, ids.kaitlyn], created: at(-4, 13, 5) });
  await q(`UPDATE flocks SET confirmed_at = $2, reconfirm_opened_at = NOW() WHERE id = $1`, [trivia, at(-3, 18, 30)]);
  await q(`UPDATE flock_members SET reconfirmed_at = NOW() WHERE flock_id = $1 AND user_id = ANY($2::int[])`, [trivia, [ids.asad, ids.kaitlyn]]);
  const triviaLast = await say(trivia, ids.asad, 'we still on for tonight?', at(0, 18, 12));

  // Friday Night Crew: today's conversation, The Copper Finch's card with two
  // reactions, five votes and four budgets.
  const friday = await mkPlan({ name: DEMO.flockName, host: jayden, venue: finch, photo: sitePhoto('shots-copper-finch'), when: at(toFri, 20, 0), status: 'planning', budget: true, members: all5, created: at(0, 16, 5) });
  const finchCard = {
    name: finch.name, addr: finch.addr, category: 'Burgers & wings', type: 'restaurant',
    stars: finch.rating, rating: finch.rating, price: '$$', price_level: 2, place_id: finch.id,
    photo_url: sitePhoto('shots-copper-finch'),
  };
  const fridayLines = [
    [ids.asad, 'ok who is actually free friday', at(0, 16, 12)],
    [ids.nick, 'free after 7. i can drive 4 people', at(0, 16, 31)],
    [ids.kaitlyn, '7:30 works for me. where are we thinking', at(0, 17, 5)],
    [jayden, `Check out ${finch.name}!`, at(0, 17, 22), { type: 'venue_card', venue: finchCard }],
    [ids.tommy, 'down, their wings are unreal', at(0, 18, 40)],
    [ids.asad, 'voted for it. kaitlyn you are outnumbered', at(0, 18, 51)],
  ];
  const fridayIds = [];
  for (const [uid, text, when, extra] of fridayLines) fridayIds.push(await say(friday, uid, text, when, extra));
  const fridayCard = fridayIds[3];
  await q(`INSERT INTO emoji_reactions (message_id, user_id, emoji) VALUES ($1,$2,'👀') ON CONFLICT DO NOTHING`, [fridayCard, ids.tommy]);
  await q(`INSERT INTO emoji_reactions (message_id, user_id, emoji) VALUES ($1,$2,'🔥') ON CONFLICT DO NOTHING`, [fridayCard, ids.asad]);
  await vote(friday, jayden, finch, at(0, 17, 23));
  await vote(friday, ids.asad, finch, at(0, 17, 30));
  await vote(friday, ids.nick, SITE_VENUE.bluewing, at(0, 17, 41));
  await vote(friday, ids.kaitlyn, SITE_VENUE.juniper, at(0, 17, 52));
  await vote(friday, ids.tommy, finch, at(0, 18, 38));
  for (const [uid, amount] of [[ids.asad, 30], [ids.nick, 40], [ids.kaitlyn, 25], [ids.tommy, 30]]) {
    await q(`INSERT INTO budget_submissions (flock_id, user_id, amount, skipped) VALUES ($1,$2,$3,FALSE) ON CONFLICT DO NOTHING`, [friday, uid, amount]);
  }

  // Nick's Birthday: Nick's plan, three of four votes in, the camera
  // account's missing.
  const birthday = await mkPlan({ name: "Nick's Birthday", host: ids.nick, venue: SITE_VENUE.bunting, photo: sitePhoto(SITE_VENUE.bunting.ref), when: at(2, 19, 0), status: 'planning', members: [ids.nick, jayden, ids.asad, ids.tommy], created: at(0, 15, 50) });
  const birthdayLast = await say(birthday, ids.nick, 'who is in?', at(0, 16, 0));
  for (const [uid, m] of [[ids.nick, 1], [ids.asad, 8], [ids.tommy, 15]]) await vote(birthday, uid, SITE_VENUE.bunting, at(0, 16, m));

  // Thursday Dinner: last Thursday, finished, the bill posted that night.
  const back = ((SITE_CLOCK.dow - 4 + 7) % 7) || 7;
  const thu = (after, hh, mm) => at(after - back, hh, mm);
  const kestrel = SITE_VENUE.kestrel;
  const dinner = await mkPlan({ name: 'Thursday Dinner', host: jayden, venue: kestrel, photo: sitePhoto(kestrel.ref), when: thu(0, 19, 30), status: 'completed', members: all5, created: thu(-2, 12, 10) });
  let dinnerLast = 0;
  for (const [uid, text, when] of [
    [ids.asad, 'table for 5 at 7:30, see you all there', thu(0, 16, 40)],
    [jayden, 'perfect, i will grab the big booth', thu(0, 17, 5)],
    [ids.nick, 'running 10 late, order for me', thu(0, 19, 22)],
    [ids.kaitlyn, 'that was so good. who has the check?', thu(0, 21, 38)],
    [ids.asad, 'got it, putting it in the app now', thu(0, 21, 41)],
    [ids.nick, 'paid you back asad', thu(1, 9, 12)],
    [ids.kaitlyn, 'sent mine too', thu(2, 11, 27)],
  ]) dinnerLast = await say(dinner, uid, text, when);
  await q(`UPDATE flock_members SET attendance = 'attended' WHERE flock_id = $1`, [dinner]);
  // $120.85 and an 18% tip is $142.60, $28.52 a share, the way POST
  // /api/billing/:id/create splits it. Asad paid; Nick and Kaitlyn have paid
  // him back, Tommy has not; the camera account's share is settled or not by pass
  // (setSitePass).
  const billAt = thu(0, 21, 44);
  const bill = await q(
    `INSERT INTO bill_splits (flock_id, total_amount, split_type, paid_by, tip_percent, had_payer, created_at, updated_at)
     VALUES ($1, 120.85, 'equal', $2, 18.0, TRUE, $3, $3) RETURNING id`,
    [dinner, ids.asad, billAt]
  );
  const billId = bill.rows[0].id;
  for (const [uid, settled, when] of [
    [jayden, true, thu(1, 8, 30)],
    [ids.asad, true, billAt],
    [ids.nick, true, thu(1, 9, 12)],
    [ids.kaitlyn, true, thu(2, 11, 27)],
    [ids.tommy, false, null],
  ]) {
    await q(
      `INSERT INTO bill_split_shares (bill_id, user_id, amount, committed, settled, settled_at, paid_amount) VALUES ($1,$2,28.52,FALSE,$3,$4,0)`,
      [billId, uid, settled, when]
    );
  }

  // ---- Asad's DMs -----------------------------------------------------------
  let dmUnread = 0;
  for (const [s, r2, text, when] of [
    [ids.asad, jayden, 'you in for friday?', at(0, 15, 40)],
    [jayden, ids.asad, 'yeah, already voted', at(0, 15, 44)],
    [ids.asad, jayden, 'legend', at(0, 15, 46)],
  ]) {
    const r = await q(
      `INSERT INTO direct_messages (sender_id, receiver_id, message_text, message_type, read_status, created_at)
       VALUES ($1,$2,$3,'text',TRUE,$4) RETURNING id`,
      [s, r2, text, when]
    );
    dmUnread = r.rows[0].id;
  }

  await db.end();
  log(`site story seeded at 7 PM in ${SITE_CLOCK.zone} (${DAY_NAMES[SITE_CLOCK.dow]}): Trivia Night tonight, Friday Night Crew in ${toFri} day(s), Nick's Birthday, Thursday Dinner ${back} day(s) back; nine invented places`);
  return {
    maya: jayden,
    owner,
    flockId: friday,
    plans: { trivia, friday, birthday, dinner },
    billId,
    // What the camera account has read: everything but the last two Friday lines and
    // Asad's "legend" (setSitePass puts these back before every frame).
    reads: { [trivia]: triviaLast, [friday]: fridayCard, [birthday]: birthdayLast, [dinner]: dinnerLast },
    dmUnread,
    night: null,
  };
}

/* One pass's state, put back before every frame so no frame depends on the
   ones before it: opening a chat marks it read, and the BILL pass leaves
   the camera account's share of Thursday's bill unpaid where the MAIN pass has it paid
   (the Nest then asks for nothing on that plan). Nothing a driver does
   outlives the next frame. */
async function setSitePass(dbUrl, seeded, pass) {
  const db = new Client({ connectionString: dbUrl, options: '-c TimeZone=UTC' });
  await db.connect();
  const q = (text, params) => db.query(text, params);
  const me = seeded.maya;
  for (const [flockId, lastRead] of Object.entries(seeded.reads)) {
    await q(
      `UPDATE flock_members SET last_read_message_id = $3, last_opened_message_id = $3, last_delivered_message_id = GREATEST(last_delivered_message_id, $3)
       WHERE flock_id = $1 AND user_id = $2`,
      [Number(flockId), me, lastRead]
    );
  }
  await q('UPDATE direct_messages SET read_status = (id <> $2) WHERE receiver_id = $1', [me, seeded.dmUnread]);
  const paid = pass !== 'bill';
  await q(
    `UPDATE bill_split_shares SET settled = $3, settled_at = CASE WHEN $3 THEN $4::timestamptz ELSE NULL END
     WHERE bill_id = $1 AND user_id = $2`,
    [seeded.billId, me, paid, SITE_CLOCK.at(-(((SITE_CLOCK.dow - 4 + 7) % 7) || 7) + 1, 8, 30)]
  );
  // Whatever a driver might have answered for the camera account, taken back.
  await q('DELETE FROM budget_submissions WHERE flock_id = $1 AND user_id = $2', [seeded.plans.friday, me]);
  await q('DELETE FROM availability_pulses WHERE user_id = $1', [me]);
  await q(`UPDATE flock_members SET reconfirmed_at = NULL WHERE flock_id = $1 AND user_id = $2`, [seeded.plans.trivia, me]);
  await db.end();
}

// ---------------------------------------------------------------------------
// 4. Frontend build against the local API, output OUTSIDE the repo.
// ---------------------------------------------------------------------------
async function buildFrontend() {
  /* The site story's build is its own: whether it was given the map's key
     decides whether the map draws at all, so a build made with the key is
     never reused by a run without it, or the other way round. */
  const stamp = SITE ? { apiUrl: API_ORIGIN, story: 'site', mapKey: !!SITE_MAP_KEY } : { apiUrl: API_ORIGIN };
  if (SKIP_BUILD && fs.existsSync(path.join(BUILD_DIR, 'index.html')) && fs.existsSync(BUILD_STAMP)) {
    const old = JSON.parse(fs.readFileSync(BUILD_STAMP, 'utf8').replace(/^﻿/, ''));
    if (old.apiUrl === API_ORIGIN && (old.story || null) === (stamp.story || null) && !!old.mapKey === !!stamp.mapKey) {
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
          // The site story's map: the browser key from SHOTS_MAPTILER_KEY or
          // none, never the keyless basemap (that service asks for a key).
          ...(SITE ? { REACT_APP_MAPTILER_KEY: SITE_MAP_KEY, REACT_APP_KEYLESS_BASEMAP: '' } : {}),
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
  if (SITE) {
    const refused = siteRefusal(SITE_CLOCK);
    if (refused) die(refused);
    log(`site story: 7 PM in ${SITE_CLOCK.zone}, ${DAY_NAMES[SITE_CLOCK.dow]}; map ${SITE_MAP_KEY ? 'drawn (SHOTS_MAPTILER_KEY)' : 'off (no key: the search list stands in for it)'}; frames to ${OUT_DIR}`);
  }
  await assertPortFree(API_PORT, 'backend API');
  await assertPortFree(WEB_PORT, 'static frontend');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!SITE) fs.mkdirSync(APPSTORE_DIR, { recursive: true });

  let pgHandle = null;
  let backend = null;
  let webServer = null;
  try {
    pgHandle = await startPostgres();
    backend = startBackend(pgHandle.url, pgHandle.port);
    await backend.waitUp();
    const seeded = SITE ? await seedSite(pgHandle.url) : await seed(pgHandle.url);
    if (flag('stack-only')) { log('stack-only: backend + seed verified, skipping build/capture'); return; }
    await buildFrontend();
    webServer = await startStaticServer();

    if (SITE) await captureSite(pgHandle.url, seeded);
    else await captureAll(pgHandle.url, seeded);

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
  /* The narrow end of DESIGN-STANDARD rule 6 ("Mobile 320-390px"), same aspect as
     the web frame so the two shots of a screen sit side by side. Only screens
     that say `narrow: true` are shot here; the web set proper is 390. */
  { id: 'web-320', viewport: { width: 320, height: 693 }, dsf: 2, out: 'web', narrow: true },
  { id: 'appstore-6.9', viewport: { width: 440, height: 956 }, dsf: 3, out: 'appstore' },
  { id: 'appstore-6.5', viewport: { width: 428, height: 926 }, dsf: 3, out: 'appstore' },
];
const MODES = (opt('modes') || 'light,dark').split(',').map((s) => s.trim()).filter(Boolean);
for (const m of MODES) if (m !== 'light' && m !== 'dark') die(`--modes takes light and/or dark, not "${m}"`);

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
  /* THE ANALYTICS TAB, which nothing ever looked at. The real blocker on this
     exact screen was reported from TestFlight on 2026-08-21: it told an
     owner to verify their venue in three places and gave them no way to do it.
     The verification request flow shipped on 08-25/26 and was confirmed by
     reading the code and by a test, which is not the same as somebody seeing
     that the screen now offers a path. It is the paid B2B surface and it had
     no visual coverage at all. */
  { id: 'venue-analytics', title: 'Venue dashboard (analytics tab)', appstore: false, replaces: {} },
  /* THE EVENTS TAB, where the incoming-flocks feed lives ("Flocks With You in
     Their Vote"): the one screen that shows a venue the demand Flock sends it. */
  { id: 'venue-events', title: 'Venue dashboard (events tab, incoming flocks)', appstore: false, replaces: {} },
  { id: 'venue-promos', title: 'Venue dashboard (promotions tab)', appstore: false, replaces: {} },
  /* THE SECOND PERSON. Three surfaces from the change that made the share
     link the product: the step that replaces the create form once a plan
     exists, the night-of "still in?" question in the chat and on the roster,
     and the link itself answered by someone with no account. None performs a
     Places search. All three are shot at 320 as well as 390, because each is
     a strip or a stacked form where the narrow width is the one that breaks. */
  { id: 'made', title: 'Create: the plan is made, send the link', appstore: false, narrow: true, replaces: {} },
  { id: 'stillin', title: 'Night-of window: chat strip and roster marks', appstore: false, narrow: true, replaces: {} },
  { id: 'guestlink', title: 'Guest link: answered, still in, budget given', appstore: false, narrow: true, replaces: {} },
  /* THE PLAN SCREEN, as its host sees it while the plan is still being made.
     The rig reached it only through the night-of plan's roster frame, which
     is a guest's-eye confirmed plan, so the header, the venue card and the
     Lock it in step had never been photographed. No Places search. Shot at
     320 as well, because the header's pills are what wraps there. */
  { id: 'plan', title: 'Plan screen: the host, still planning, venue picked', appstore: false, narrow: true, replaces: {} },
];

// Which screens a size takes: the narrow size only those that asked for it,
// the web size everything, the App Store sizes what is marked for the store,
// a size of your own (--viewport) everything asked for.
const wantsSize = (screen, size) => (size.custom ? true : size.narrow ? !!screen.narrow : (size.id === 'web' || screen.appstore));

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
const OWNER_SCREENS = new Set(['venue-dash', 'venue-analytics', 'venue-events', 'venue-promos']);

/* The screens driven from a context with NO session: no token, nothing an
   app visitor carries. The guest page is for exactly that person, and the
   path router in src/index.js picks it by URL before anything reads a token. */
const GUEST_SCREENS = new Set(['guestlink']);

// Per-screen drivers. Each takes an already-logged-in page sitting on the app
// and leaves the target screen fully rendered.
/* Open Discover and wait for the pins and their photos. Shared by the three
   Discover captures. */
async function openDiscoverPins(page) {
    // A map of every kind of place: every picture in the pool.
    setVenueArtTheme(page.context(), null);
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
    /* NOT IN THE SITE STORY. A frame on the website is marketing use of the
       map, which MapTiler's terms allow with the credit visible, so there the
       credit is left as MapLibre draws it. */
    if (!SITE) {
      await page.evaluate(() => {
        document.querySelectorAll('.maplibregl-ctrl-attrib.maplibregl-compact-show')
          .forEach((el) => el.classList.remove('maplibregl-compact-show'));
      }).catch(() => {});
    }
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

/* What the crowd and Birdie screens ask for. Both are App Store shots, which
   must suit a 4+ audience whatever the app's rating (Guideline 2.3.8), so
   neither asks about bars or drinks. */
const CROWD_SEARCH = 'pizza';
const BIRDIE_ASK = 'Dinner for six tonight in Philadelphia, somewhere with big tables?';

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
    // No weekday in the name: the shot taps "Tonight", whatever day it is.
    await name.fill('Night Out');
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
    /* THE CHAT OPENS AT THE NEWEST MESSAGE. The 21 Oct run saw it land 13 to
       18px short of it; this prints the gap, so every run says whether it
       still does. */
    const gap = await page.evaluate(() => {
      const el = document.querySelector('.chat-scroller');
      return el ? Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) : null;
    });
    log(`  chat: ${gap === null ? 'no .chat-scroller on screen' : `${gap}px between the view and the newest message${gap > 2 ? ' (short of the bottom)' : ''}`}`);
  },
  /* THE PLAN SCREEN (screens/FlockDetail.js), opened from its card on the
     Nest the way most people reach it. The camera account hosts the seeded
     plan, so every host control is on screen. Two frames: the top as it
     opens, and the scroll area run to its end, because the screen scrolls
     under a fixed header and a full-page frame would only repeat the top. */
  async plan(page, shoot) {
    await tab(page, 'Nest').click();
    await page.getByRole('button', { name: new RegExp(DEMO.flockName) }).filter({ visible: true }).first().click();
    await page.getByRole('heading', { level: 1, name: DEMO.flockName }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Back to your plans' }).waitFor({ timeout: 10000 });
    await settle(page);
    await shoot('top');
    const scrolled = await page.evaluate(() => {
      const scrollers = [...document.querySelectorAll('div')].filter((el) => {
        const oy = getComputedStyle(el).overflowY;
        return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1;
      });
      const area = scrollers.sort((a, b) => b.clientHeight - a.clientHeight)[0];
      if (!area) return null;
      area.scrollTop = area.scrollHeight;
      return Math.round(area.scrollHeight - area.clientHeight);
    });
    log(`  plan: ${scrolled === null ? 'the plan fits without scrolling' : `scroll area runs ${scrolled}px past the fold`}`);
    await page.waitForTimeout(300);
    await shoot('end');
    return true;
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
    // Pictures that fit a list of pizza places. Not the dining room: that is
    // The Copper Finch's own picture (shot-art.mjs PINNED).
    setVenueArtTheme(page.context(), ['pizza', 'storefront']);
    await tab(page, 'Discover').click();
    await page.getByText('Finding venues near you...').waitFor({ state: 'detached', timeout: 45000 }).catch(() => {});
    const search = page.locator('#search-input');
    await search.waitFor({ timeout: 15000 });
    // Typing fires the debounced venue search, which then fires the crowd
    // batch for the first 20 results. The percentages live in the full-screen
    // results overlay behind "See All Results". The search is for pizza, not
    // bars: this is an App Store shot, and those must suit a 4+ audience.
    const batch = page.waitForResponse((r) => r.url().includes('/api/crowd/batch'), { timeout: 60000 }).catch(() => null);
    await search.fill(CROWD_SEARCH);
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
    // Neighbouring rows get different pictures, in the order they are shown.
    await refreshVisibleVenueArt(page);
    await settle(page, { quiet: 800 });
  },
  async birdie(page) {
    // Pictures that fit an answer about dinner for six (the dining room is
    // The Copper Finch's own).
    setVenueArtTheme(page.context(), ['pizza', 'noodles', 'tacos', 'sushi', 'salad', 'storefront']);
    await tab(page, 'Nest').click();
    // Birdie is a section of the Nest's page (components/nest/
    // NestBirdieSection.js); its field is the way in. An account that has not
    // yet let Birdie use Gemini is asked first, in the section, and the field
    // comes back after Allow. Answer the way a person would.
    let input = page.locator('[data-nest-band="birdie"] input[aria-label="Ask Birdie"]');
    await input.waitFor({ timeout: 15000 });
    await input.click();
    const allow = page.getByRole('button', { name: 'Allow', exact: true });
    if (await allow.isVisible().catch(() => false)) {
      await allow.click();
      await allow.waitFor({ state: 'detached', timeout: 15000 });
    }
    input = page.locator('[data-nest-band="birdie"] input[aria-label="Ask Birdie"]');
    await input.waitFor({ timeout: 10000 });
    await input.fill(BIRDIE_ASK);
    // A Birdie turn is a real Gemini tool loop (up to ~45s server-side). Done
    // = the HTTP turn returns AND Birdie's Working on your answer line
    // ([data-birdie-working]) leaves the DOM.
    const reply = page.waitForResponse((r) => r.url().includes('/api/ai/chat'), { timeout: 90000 });
    await input.press('Enter');
    await reply;
    await page.locator('[data-birdie-working]').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
    // The answer lands in the page; the asset shows it in the full chat.
    await page.getByRole('button', { name: 'Open the full chat' }).click();
    // Give venue-card images from the reply a beat to load, then hand the
    // cards their pictures in the order they are shown.
    await settle(page, { quiet: 2000 });
    await refreshVisibleVenueArt(page);
    // The thread auto-scrolls to the newest card; the shot should show the
    // question and the top of Birdie's answer, like the current site asset.
    await page.getByText(BIRDIE_ASK).first()
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
    await page.getByTestId('venue-dashboard-title').waitFor({ timeout: 20000 });
    // The owner context never passes through waitAppReady (no tab bar to wait
    // for), so the consent bar has to be declined here as well, or it sits at
    // the bottom of every owner capture.
    await declineAnalyticsAsk(page);
    const analyticsTab = page.getByRole('button', { name: 'Analytics' }).first();
    if (await analyticsTab.count()) await analyticsTab.click();
    await settle(page);
  },
  async 'venue-events'(page) {
    // Same owner context as venue-dash. The seeded demo flock is pointed at
    // the demo venue, so the feed has a real row to draw.
    await page.getByTestId('venue-dashboard-title').waitFor({ timeout: 20000 });
    await declineAnalyticsAsk(page);
    const eventsTab = page.getByRole('button', { name: 'Events' }).first();
    if (await eventsTab.count()) await eventsTab.click();
    await page.getByText('Flocks with you in their vote').first().waitFor({ timeout: 15000 }).catch(() => {});
    await settle(page);
  },
  async 'venue-promos'(page) {
    // Same owner context as venue-dash; the seeded venue carries one promotion.
    await page.getByTestId('venue-dashboard-title').waitFor({ timeout: 20000 });
    await declineAnalyticsAsk(page);
    const promosTab = page.getByRole('button', { name: 'Promotions' }).first();
    if (await promosTab.count()) await promosTab.click();
    await settle(page);
  },
  async 'venue-dash'(page) {
    // Separate context: owner token + venue mode + ?venue=true deep link.
    await page.getByTestId('venue-dashboard-title').waitFor({ timeout: 20000 });
    await declineAnalyticsAsk(page);
    const reviewsTab = page.getByRole('button', { name: 'Reviews' }).first();
    if (await reviewsTab.count()) await reviewsTab.click();
    await page.getByText('Jordan Avery').first().waitFor({ timeout: 15000 }).catch(() => {});
    await settle(page);
  },
  /* THE MADE STEP. Tapping Create Flock now swaps the form for one step
     ("{name} is made." and the ask to send the link) before the chat is ever
     shown. Name and a time, like the create shot; the venue picker is a
     Places search and this is not the shot to spend one on. Send the link is
     NOT tapped: headless Chromium has no navigator.share, so the tap would
     take the clipboard path and leave for the chat. */
  async made(page) {
    await tab(page, 'Nest').click();
    await page.getByText('Start a flock').first().click();
    const name = page.locator('#flock-name-input');
    await name.waitFor({ timeout: 10000 });
    await name.fill(DEMO.madeName);
    for (const label of ['Tonight', '9 PM']) {
      const chip = page.getByRole('button', { name: label, exact: true }).first();
      if (await chip.count()) await chip.click().catch(() => {});
    }
    // The name box commits upward on a short debounce; the chip taps above
    // cover it, this is belt and braces for a form with no chips.
    await page.waitForTimeout(300);
    const created = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/flocks\/?$/.test(r.url()), { timeout: 30000 }).catch(() => null);
    await page.getByRole('button', { name: 'Create Flock' }).click();
    await created;
    await page.getByText(`${DEMO.madeName} is made.`).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Not now' }).waitFor({ timeout: 10000 });
    // The heading takes focus on arrival so a screen reader announces it;
    // the ring is not part of the picture.
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await settle(page);
  },
  /* THE NIGHT-OF QUESTION, from the app. The strip under the chat header and
     the roster's count and marks both read flock.reconfirm off the same
     GET /api/flocks/:id, open on the seeded plan. The camera account has not
     answered, so the strip carries the button. Two frames from one visit,
     because the plan screen is a tap on the chat header and the state on
     both is the same fetch. */
  async stillin(page, shoot) {
    await tab(page, 'Messages').click();
    await page.getByRole('button', { name: new RegExp(DEMO.night.name) }).filter({ visible: true }).first().click();
    await page.locator('.chat-composer-field').first().waitFor({ timeout: 15000 });
    await page.getByText(/Still in\? \d+ of \d+ have said so\./).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: "I'm still in" }).waitFor({ timeout: 10000 });
    await settle(page);
    // The strip arrives with a fetch after the thread opens, over the list.
    const gap = await page.evaluate(() => {
      const el = document.querySelector('.chat-scroller');
      return el ? Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) : null;
    });
    log(`  stillin: ${gap === null ? 'no .chat-scroller on screen' : `${gap}px between the view and the newest message${gap > 2 ? ' (short of the bottom)' : ''}`}`);
    await shoot('chat');
    await page.getByRole('button', { name: 'Open the plan' }).click();
    await page.getByText(/\d+ of \d+ still in tonight\./).waitFor({ timeout: 15000 });
    await page.getByText('Still in', { exact: true }).first().waitFor({ timeout: 10000 });
    await settle(page);
    await shoot('roster');
    return true;
  },
  /* THE LINK, answered by someone with no account. The page is /i/<token>
     in a session-less context (see captureAll). Three frames: answered as a
     guest, with the night-of question and the budget ask both in view; the
     still-in tap counted; a number given, with the aggregate line the page
     shows in place of any amount. Each frame scrolls the Still in? section
     to the top, which is where the budget ask fits underneath at 390; where
     it does not, the run says so in the log rather than hiding it. */
  async guestlink(page, shoot) {
    await declineAnalyticsAsk(page);
    await page.getByRole('heading', { name: 'Still in?' }).waitFor({ timeout: 20000 });
    const nameField = page.locator('#gi-name');
    await nameField.waitFor({ timeout: 10000 });
    await nameField.fill(DEMO.night.newGuest);
    const rsvp = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/rsvp'), { timeout: 20000 }).catch(() => null);
    await page.getByRole('button', { name: "I'm in", exact: true }).click();
    await rsvp;
    await page.getByText("You're down as coming.").waitFor({ timeout: 15000 });
    await page.locator('#gi-budget').waitFor({ timeout: 15000 });
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await frameStillInAndBudget(page, 'answered');
    await settle(page);
    await shoot('answered');
    await shoot('answered', { fullPage: true });
    const still = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/reconfirm'), { timeout: 20000 }).catch(() => null);
    await page.getByRole('button', { name: "I'm still in" }).click();
    await still;
    await page.getByText(/You're in\. \d+ of \d+ still in\./).waitFor({ timeout: 15000 });
    await frameStillInAndBudget(page, 'stillin');
    await settle(page);
    await shoot('stillin');
    await shoot('stillin', { fullPage: true });
    await page.locator('#gi-budget').fill('30');
    const budget = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/budget'), { timeout: 20000 }).catch(() => null);
    await page.getByRole('button', { name: 'That works' }).click();
    await budget;
    await page.getByText(/You said \$30/).waitFor({ timeout: 15000 });
    await page.getByText(/\d+ of \d+ answered\./).waitFor({ timeout: 10000 });
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    // This frame is about the aggregate line, so the budget section wins the
    // frame when the two will not share it.
    await frameStillInAndBudget(page, 'budget', { fitBudget: true });
    await settle(page);
    await shoot('budget');
    await shoot('budget', { fullPage: true });
    return true;
  },
};

/* Put the night-of question at the top of the frame and say whether the
   budget ask made it in underneath. With `fitBudget`, a budget section that
   runs past the frame is brought fully in instead, at the cost of the
   question scrolling off the top. The guest page scrolls the document and
   has nothing fixed over it but the off-screen skip link. */
async function frameStillInAndBudget(page, label, { fitBudget = false } = {}) {
  const fit = await page.evaluate((wantBudget) => {
    const still = document.getElementById('gi-still-h');
    if (!still) return null;
    (still.closest('section') || still).scrollIntoView({ block: 'start' });
    window.scrollBy(0, -8);
    const budget = document.getElementById('gi-budget-h');
    if (!budget) return { budget: false };
    const section = budget.closest('section') || budget;
    let r = section.getBoundingClientRect();
    let moved = false;
    if (wantBudget && r.bottom > window.innerHeight) {
      section.scrollIntoView({ block: 'end' });
      window.scrollBy(0, 8);
      r = section.getBoundingClientRect();
      moved = true;
    }
    return { budget: true, top: Math.round(r.top), bottom: Math.round(r.bottom), frame: window.innerHeight, moved };
  }, fitBudget);
  if (!fit) log(`  guestlink/${label}: no Still in? section on the page`);
  else if (!fit.budget) log(`  guestlink/${label}: no budget section on the page`);
  else if (fit.moved) log(`  guestlink/${label}: budget section did not fit under Still in?; framed on the budget section, the question scrolled off the top`);
  else if (fit.top >= fit.frame) log(`  guestlink/${label}: budget section starts at ${fit.top}px, below the ${fit.frame}px frame`);
  else if (fit.bottom > fit.frame) log(`  guestlink/${label}: budget section runs to ${fit.bottom}px, past the ${fit.frame}px frame (heading in, form cut)`);
}

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
  // The site story stands in Old City at 7 PM (siteClock); the other sets in
  // Philadelphia on the machine's own clock.
  const here = SITE ? SITE_CAMERA : { lat: 39.9526, lng: -75.1652 };
  const context = await browser.newContext({
    viewport: size.viewport,
    deviceScaleFactor: size.dsf,
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
    permissions: ['geolocation'],
    geolocation: { latitude: here.lat, longitude: here.lng },
    locale: 'en-US',
    timezoneId: SITE ? SITE_CLOCK.zone : 'America/New_York',
    colorScheme: mode,
  });
  /* The site story's answers from outside Flock (installSiteStubs). The
     page's clock is left real: Playwright's installed clock stalls the
     animations framer-motion runs (the crowd forecast stayed at opacity 0),
     and the zone alone makes it 7 PM (siteClock). */
  if (SITE) await installSiteStubs(context);
  // Every venue picture on every screen is a drawing from shot-art.mjs, never
  // a Places photo (see that file for why).
  await installVenueArt(context, requireFrontend('sharp'));
  await context.addInitScript(([theme, jwt, uMode, lat, lng]) => {
    localStorage.setItem('flock-theme-mode', 'manual');
    localStorage.setItem('flock-theme', theme);
    localStorage.setItem('flock_notif_denied', 'true');
    localStorage.setItem('flockUserMode', uMode);
    if (uMode === 'venue') localStorage.setItem('flockVenueOnboardingComplete', 'true');
    localStorage.setItem('flock_user_lat', String(lat));
    localStorage.setItem('flock_user_lng', String(lng));
    // No token means no session: the guest page is shot as a stranger.
    if (jwt) localStorage.setItem('flockToken', jwt);
    // Lets the map audit below project venues and measure their pins.
    window.__FLOCK_MAP_DEBUG__ = true;
  }, [mode, token, userMode, here.lat, here.lng]);
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

async function captureAll(dbUrl, seeded) {
  const sizes = CUSTOM_SIZE ? [CUSTOM_SIZE] : SIZES.filter((s) => SET === 'all' || (SET === 'web' ? s.out === 'web' : s.out === 'appstore'));
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
        await resetNightRows(dbUrl, seeded && seeded.night);
        /* OWNER_SCREENS, not a hardcoded 'venue-dash'. This excluded that one id
           by name, so adding venue-analytics silently put it in the CONSUMER
           context: logged in as an ordinary user, no ?venue=true, and a
           twenty-second wait for an owner's dashboard header that a regular
           account never sees. One list, used by both filters, so a third owner screen cannot
           repeat it. GUEST_SCREENS is the same rule for the session-less
           context below. */
        const consumerScreens = screens.filter((s) => !OWNER_SCREENS.has(s.id) && !GUEST_SCREENS.has(s.id) && wantsSize(s, size));
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
                await driveAndSnap(page, sharp, manifest, { screen, size, mode });
              } catch (e) {
                failures.push(await failureReport(page, e, { screen, size, mode }));
              }
            }
          } finally {
            await context.close();
          }
        }
        /* THE GUEST LINK, from a context with no session at all. One page per
           screen, each opened at /i/<token> fresh, the same rule as the two
           loops around it. Diagnosed on failure the same way. */
        const guestScreens = screens.filter((s) => GUEST_SCREENS.has(s.id) && wantsSize(s, size));
        if (guestScreens.length && seeded && seeded.night) {
          const { context, page } = await newAppContext(browser, { size, mode, token: null, userMode: 'user' });
          page.__consoleErrors = [];
          page.on('console', (m) => {
            if (m.type() === 'error') page.__consoleErrors.push(m.text().slice(0, 200));
          });
          page.on('pageerror', (err) => page.__consoleErrors.push(`pageerror: ${String(err).slice(0, 200)}`));
          try {
            for (const screen of guestScreens) {
              try {
                page.__imgFails = [];
                await page.goto(`${WEB_ORIGIN}/i/${seeded.night.token}`, { waitUntil: 'domcontentloaded' });
                await page.addStyleTag({ content: hideCaretCss });
                await driveAndSnap(page, sharp, manifest, { screen, size, mode });
              } catch (e) {
                failures.push(await failureReport(page, e, { screen, size, mode }));
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
        if (ownerScreens.length > 0 && (size.id === 'web' || size.custom)) {
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

  if (OUT_OVERRIDE) {
    log(`captures written to ${OUT_DIR}; manifest and the public/ archive step skipped (--out)`);
  } else {
    finishInPublic(manifest);
  }
  reportOverflow();
  log(`captured ${manifest.length} images${failures.length ? `, ${failures.length} FAILURES` : ''}`);
  for (const f of failures) log(`  FAIL ${f}`);
  if (failures.length) process.exitCode = 1;
}

/* Run a driver and take the picture. A driver that frames its own captures
   (several states of one visit) calls `shoot(label)` for each and returns
   true; every other driver leaves one screen up and the frame is taken here.
   `shoot(label, { fullPage: true })` takes the whole document at the
   viewport's width, for a page that scrolls further than one frame shows. */
async function driveAndSnap(page, sharp, manifest, { screen, size, mode }) {
  const shoot = (label, extra = {}) => snap(page, sharp, manifest, { screen, size, mode, label, ...extra });
  const framed = await DRIVERS[screen.id](page, shoot);
  if (!framed) await snap(page, sharp, manifest, { screen, size, mode });
}

/* SAY WHY, not just that. This reported "Timeout 30000ms exceeded" and
   nothing else, which is a sentence that fits every possible cause: a stale
   selector, a login that did not land, a crash on boot. The rig produces App
   Store submission material, so a failure nobody can diagnose is a failure
   nobody fixes, and this one had gone unnoticed.

   A screenshot of whatever WAS on screen, plus the console and any page
   error, turns thirty seconds of silence into an answer. Best effort
   throughout: diagnostics must never replace the real failure with one of
   their own. */
async function failureReport(page, e, { screen, size, mode }) {
  const why = [`${screen.id} [${size.id}/${mode}]: ${e.message.split('\n')[0]}`];
  try {
    /* SCRATCH, not OUT_DIR. OUT_DIR is frontend/public/screenshots by default,
       which is deployed with the site, so a debug capture there would ship a
       picture of a broken app to production. */
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
  return why.join('\n');
}

/* Collected across a run and printed at the end, so one overflowing screen
   does not fail a capture that is otherwise fine and useful. */
const overflowFindings = [];

/**
 * DESIGN-STANDARD rule 6, checked by the thing that already visits every screen.
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

async function snap(page, sharp, manifest, { screen, size, mode, label = '', fullPage = false }) {
  // Measured once per state, on the viewport frame; the full-page twin of the
  // same state would only repeat the finding.
  if (!fullPage) await checkOverflow(page, { screen, size, mode });
  /* FROM THE TOP. Chromium paints a full-page frame with the window still
     scrolled where it was, and lays out position:fixed elements against that
     scrolled viewport, so the guest page's skip link, which lives two of its
     own heights above the viewport's top edge, turned up in the middle of the
     document sitting on the join band. No viewer sees that; the capture did.
     Scrolling to the top first puts every fixed element where the document's
     top edge really is, and a driver re-frames before its next frame anyway. */
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  const raw = await page.screenshot({ type: 'png', fullPage });
  const px = { w: size.viewport.width * size.dsf, h: size.viewport.height * size.dsf };
  const meta = await sharp(raw).metadata();
  // A full-page frame is as tall as the document; its width is still the
  // viewport's, and that is the half of the check that catches a wrong size.
  if (meta.width !== px.w || (!fullPage && meta.height !== px.h)) {
    throw new Error(`capture size mismatch: got ${meta.width}x${meta.height}, wanted ${px.w}x${fullPage ? 'document' : px.h}`);
  }
  if (fullPage) px.h = meta.height;
  if (size.out === 'custom') {
    // Opaque, as Apple takes them: flattened onto white, no alpha channel,
    // tagged sRGB (the colour space Chromium paints in).
    const file = `${screen.id}${label ? `-${label}` : ''}${fullPage ? '-full' : ''}-${mode}-${px.w}x${px.h}.png`;
    await sharp(raw).flatten({ background: '#ffffff' }).removeAlpha().withIccProfile('srgb').png({ compressionLevel: 9 }).toFile(path.join(OUT_DIR, file));
    manifest.push({ file, screen: screen.id, title: screen.title, mode, set: size.id, width: px.w, height: px.h, replaces: null });
  } else if (size.out === 'web') {
    // The 390 name is unchanged, so the shipped set keeps its files; a frame
    // label, a full-page frame and the narrow width are spelled out where
    // they apply.
    const base = `${screen.id}${label ? `-${label}` : ''}${fullPage ? '-full' : ''}-${mode}${size.id === 'web' ? '' : `-${size.viewport.width}`}@2x`;
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
  log(`  ok ${screen.id}${label ? `/${label}` : ''}${fullPage ? ' (full page)' : ''} [${size.id}/${mode}]${imgNote}`);
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

/* A full run's last step: the archive step, then the manifest. The other way
   round, manifest.json listed every capture the run took, and the archive
   step then moved the unreferenced ones out to frontend/screenshots/, so the
   manifest in public/ named files that were not there. Written after, it
   lists what public/ still holds (see the filter in writeManifest).
   screenshotRigNotes.test.js runs the two in this order. */
function finishInPublic(manifest) {
  archiveUnshipped();
  writeManifest(manifest);
}

/* THE MANIFEST, AND NOT WIRING.md (2026-11-04). This used to write WIRING.md
   too, from a template of its own: the swap plan from the first capture run,
   which says the website source is untouched and that files are in public/
   that are not. So a full run (no --out) put that text over the WIRING.md
   beside the shipped captures, which was corrected by hand on 2026-11-03 to
   say what those frames really show: whose names are real, that the crowd
   figures are estimates from typical patterns, how wide the plates paint. A
   run knows none of that, and it does not make the shipped frames (a version
   of this script that was never committed did), so WIRING.md is kept by hand
   and a run leaves it alone: its words live in one place. The note below only
   points at it, and the committed manifest carries the same note and
   generator, so a run changes neither. screenshotRigNotes.test.js pins this. */
function writeManifest(manifest) {
  // Merge with the manifest from previous runs so a partial (--only/--set)
  // rerun refreshes its own entries without dropping the rest.
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  const byFile = new Map();
  try {
    const prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^﻿/, ''));
    for (const c of prev.captures || []) byFile.set(c.file, c);
  } catch { /* first run */ }
  for (const c of manifest) byFile.set(c.file, c);
  // Only web captures still in public/: the archive step has run, and an entry
  // for a file it moved, this run's or an earlier run's, would name a file that
  // is not there. The App Store set is in store-assets/, which the archive step
  // never touches, so its entries stay.
  const left = (c) => !c.file.startsWith('screenshots/') || fs.existsSync(path.join(OUT_DIR, c.file.slice('screenshots/'.length)));
  const captures = [...byFile.values()].filter(left).sort((a, b) => a.file.localeCompare(b.file));

  fs.writeFileSync(manifestPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    generator: 'frontend/scripts/capture-screenshots.mjs',
    note: 'See WIRING.md for what the shipped captures show and where each one is used.',
    captures,
  }, null, 2));
  log('wrote manifest.json (WIRING.md is kept by hand and left as it is)');
}

/* DESIGN-STANDARD rule 6, reported rather than enforced. A capture run that is
   otherwise good should not fail on this, but nobody should have to go
   looking for it either. Its own function so a --out run, which writes no
   manifest, still says it. */
function reportOverflow() {
  if (overflowFindings.length) {
    log(`HORIZONTAL OVERFLOW on ${overflowFindings.length} screen(s) - DESIGN-STANDARD rule 6:`);
    for (const f of overflowFindings) log(`  ${f}`);
  } else {
    log('no horizontal overflow on any screen (DESIGN-STANDARD rule 6)');
  }
}

// ---------------------------------------------------------------------------
// 7. The site story's capture (--story=site).
// ---------------------------------------------------------------------------

/* EVERY ANSWER A SITE FRAME NEEDS FROM OUTSIDE FLOCK, GIVEN IN THE BROWSER.
   Venue search and details (Google Places), crowd figures (the forecast),
   events (Ticketmaster), weather and Birdie's turn (Gemini) are answered here
   from SITE_VENUES, in the shapes the backend returns, before a request
   leaves the page; the backend's keys for all of them are blank anyway
   (backendEnv). Everything else the app asks of its own API goes through, so
   the plans, chats, votes, budgets, bills and the venue's own side are the
   seeded database's. A request for any host but the rig's two (and the map's
   tiles, when the build has the map's key) is refused and recorded, so no
   frame can carry something fetched from outside. */
const SITE_BIRDIE_ASK = 'Somewhere cheaper than The Copper Finch for the five of us tonight?';
// The search list's places: sit-down dinner, no bakery and no ice cream.
const SITE_DINNER = ['finch', 'kestrel', 'juniper', 'saltmarsh', 'bluewing', 'plover', 'fernway'];
function siteBirdieReply() {
  const pick = ['bluewing', 'saltmarsh', 'juniper'].map((k) => SITE_VENUE[k]);
  return {
    text: "Bluewing Diner. Booths that fit five, most plates under $15, and it's quieter than The Copper Finch right now.",
    venues: pick.map((v) => {
      const at = siteLocation(v);
      return {
        place_id: v.id,
        name: v.name,
        address: v.addr,
        rating: v.rating,
        reviews: v.reviews,
        price_level: v.price,
        types: v.types,
        is_open: siteOpenAt(v, SITE_CLOCK.hour),
        lat: at.latitude,
        lng: at.longitude,
        photo_url: sitePhoto(v.ref),
        crowd: v.score,
        crowd_label: `Usually ${siteLabel(v.score).toLowerCase()}`,
      };
    }),
    remaining: 149,
  };
}
function siteWeather() {
  return {
    temp: 52,
    feelsLike: 49,
    humidity: 58,
    windSpeed: 7,
    // A cloud, not a sun: the card draws the sun for any clear sky, at 7 PM too.
    conditions: 'few clouds',
    conditionId: 801,
    isRaining: false,
    fetchedAt: RUN_T.getTime() - 12 * 60 * 1000,
  };
}
function siteForecast() {
  const days = [[54, 'clear sky', '01d'], [57, 'few clouds', '02d'], [55, 'scattered clouds', '03d'], [51, 'light rain', '10d'], [49, 'clear sky', '01d']];
  return days.map(([temp, conditions, icon], i) => ({
    date: SITE_CLOCK.date(i + 1), temp, feelsLike: temp - 3, humidity: 55 + i * 3, windSpeed: 6 + i, conditions, icon,
  }));
}
async function installSiteStubs(context) {
  const cors = { 'Access-Control-Allow-Origin': WEB_ORIGIN, 'Access-Control-Allow-Credentials': 'true', 'Cache-Control': 'no-store' };
  const preflight = (route) => route.fulfill({ status: 204, headers: { ...cors, 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' } });
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
  const answered = [];
  const refused = [];
  context.__siteAnswered = answered;
  context.__siteRefused = refused;
  const byId = new Map(SITE_VENUES.map((v) => [v.id, v]));
  const ownHost = (url) => url.host === `127.0.0.1:${WEB_PORT}` || url.host === `127.0.0.1:${API_PORT}`
    || (!!SITE_MAP_KEY && url.host === 'api.maptiler.com');
  // Registered first, so every route below is consulted before it.
  await context.route((url) => !ownHost(url), (route) => {
    refused.push(route.request().url().slice(0, 160));
    return route.abort('blockedbyclient');
  });
  await context.route((url) => url.pathname === '/api/venues/search' || url.pathname === '/api/venues/details' || url.pathname === '/api/venues/resolve-poi', (route) => {
    if (route.request().method() === 'OPTIONS') return preflight(route);
    const url = new URL(route.request().url());
    answered.push(`${url.pathname}?${url.search.slice(1, 60)}`);
    if (url.pathname === '/api/venues/details') {
      const v = byId.get(url.searchParams.get('place_id'));
      return v ? json(route, { venue: siteDetails(v) }) : json(route, { error: 'This venue is no longer listed, so its details cannot load.' }, 404);
    }
    if (url.pathname === '/api/venues/resolve-poi') return json(route, { error: 'That spot is not on the map.' }, 400);
    const query = (url.searchParams.get('query') || '').toLowerCase();
    const named = SITE_VENUES.filter((v) => query.includes(v.name.toLowerCase().replace(/^the /, '')));
    const hits = named.length ? named : /dinner/.test(query) ? SITE_DINNER.map((k) => SITE_VENUE[k]) : SITE_VENUES;
    return json(route, { venues: hits.map(siteSearchRow), total: hits.length });
  });
  await context.route((url) => url.pathname.startsWith('/api/crowd/'), (route) => {
    if (route.request().method() === 'OPTIONS') return preflight(route);
    const url = new URL(route.request().url());
    answered.push(url.pathname);
    if (url.pathname === '/api/crowd/batch') {
      let asked = [];
      try { asked = (JSON.parse(route.request().postData() || '{}').venues || []).map((v) => v.place_id || v.placeId); } catch { /* none */ }
      const predictions = asked.filter((id) => byId.has(id)).map((id) => {
        const v = byId.get(id);
        return {
          placeId: v.id, name: v.name, venueTypes: v.types, score: v.score, label: `Usually ${siteLabel(v.score).toLowerCase()}`,
          rawEngineScore: v.score, confidence: 42, predictionMethod: 'rule_engine', modelVersion: null,
          confidenceBasis: 'category_pattern', confidenceMeans: 'input_completeness', supported: false, baselineData: null,
          calibration: { feedbackUsed: false, reportCount: 0, predictionDrift: 0 }, venueClock: siteClockNow(),
        };
      });
      return json(route, { predictions, weather: null, timestamp: RUN_T.toISOString() });
    }
    const id = decodeURIComponent(url.pathname.split('/')[3] || '');
    const v = byId.get(id);
    if (!v) return json(route, { error: 'Venue not found' }, 404);
    if (url.pathname.endsWith('/alternatives')) {
      const quieter = SITE_VENUES.filter((o) => o.id !== v.id && o.score < v.score && SITE_DINNER.includes(o.key))
        .sort((a, b) => a.score - b.score).slice(0, 2);
      return json(route, {
        currentVenue: { name: v.name, venueTypes: v.types, score: v.score, predictionMethod: 'rule_engine', confidenceBasis: 'category_pattern', supported: false },
        alternatives: quieter.map((o) => ({
          placeId: o.id, name: o.name, venueTypes: o.types, score: o.score, label: `Usually ${siteLabel(o.score).toLowerCase()}`,
          predictionMethod: 'rule_engine', confidenceBasis: 'category_pattern', supported: false,
        })),
      });
    }
    return json(route, siteCrowdCard(v));
  });
  // Ticketmaster's events would put real events and their pictures in frame.
  await context.route((url) => url.pathname.startsWith('/api/events/'), (route) => {
    if (route.request().method() === 'OPTIONS') return preflight(route);
    answered.push(new URL(route.request().url()).pathname);
    return json(route, { events: [] });
  });
  await context.route((url) => url.pathname === '/api/weather' || url.pathname === '/api/weather/forecast', (route) => {
    if (route.request().method() === 'OPTIONS') return preflight(route);
    const url = new URL(route.request().url());
    answered.push(url.pathname);
    return json(route, url.pathname === '/api/weather' ? siteWeather() : { forecast: siteForecast() });
  });
  // Birdie's turn, written here: no Gemini call (WIRING.md says so).
  await context.route((url) => url.pathname === '/api/ai/chat', (route) => {
    if (route.request().method() === 'OPTIONS') return preflight(route);
    if (route.request().method() !== 'POST') return route.continue();
    answered.push('/api/ai/chat');
    return json(route, siteBirdieReply());
  });
}

/* THE FRAMES, in the order the site's reel and plates are listed (PLAN.md 2c).
   `id` is the shipped base name, `driver` the SITE_DRIVERS entry that frames
   it (one visit can frame two: the bill's chat and its sheet), `frame` the
   label that driver gives it, `pass` the database state it is shot in, `nav`
   whether the bird tab bar is in it, `anchors` the home page's annotated
   plate it is (landingAnnotations.js), measured as it is shot. */
const SITE_SHOTS = [
  { id: 'nest', driver: 'nest', pass: 'main', nav: true, title: "The Nest: tonight's plan, what needs you, who is out tonight" },
  { id: 'crowd-dial', driver: 'crowd-dial', pass: 'main', title: "The Copper Finch's crowd forecast: usually busy at 78, quietest at 11 PM, hour by hour until it closes" },
  { id: 'still-in', driver: 'stillin', frame: 'roster', pass: 'main', title: 'Trivia Night on the night: two of three already still in' },
  { id: 'birdie-pick', driver: 'birdie-pick', pass: 'main', nav: true, title: 'Birdie, asked for somewhere cheaper for five, answers with Bluewing Diner' },
  SITE_MAP_KEY
    ? { id: 'map-crowd', driver: 'map-crowd', pass: 'main', nav: true, map: true, title: 'Discover over Old City: the places nearby and the crowd heat' }
    : { id: 'crowd-list', driver: 'crowd-list', pass: 'main', title: 'Discover, searched for dinner: places nearby with their crowd figures' },
  { id: 'plans-tab', driver: 'plans', pass: 'main', nav: true, title: "The Plans tab: this month, tonight's weather and tonight's trivia" },
  { id: 'profile', driver: 'you', pass: 'main', nav: true, title: "Jayden Bansal's profile: four flocks, four friends, 92% reliable" },
  { id: 'messages', driver: 'messages', pass: 'main', nav: true, title: "The Messages tab: Asad's message and four flock chats" },
  { id: 'bill-chat', driver: 'bill', frame: 'chat', pass: 'bill', title: "Thursday Dinner's chat: the $142.60 bill, three of five settled" },
  { id: 'chat', driver: 'chat', pass: 'main', anchors: 'vote', title: 'Friday Night Crew: The Copper Finch pinned, four of five budgets in, five of five voted' },
  { id: 'budget', driver: 'budget', pass: 'main', anchors: 'budget', title: 'Private budget: $35 typed in, and the note that nobody sees it' },
  { id: 'bill-split', driver: 'bill', frame: 'sheet', pass: 'bill', anchors: 'bill', title: 'Split the bill: $142.60 with an 18% tip, $28.52 each' },
  { id: 'sos', driver: 'sos', pass: 'main', anchors: 'sos', title: 'Safety: the SOS sheet over the Nest' },
  { id: 'owner-dashboard', driver: 'venue-events', pass: 'main', owner: true, anchors: 'venue', title: "The Copper Finch's dashboard: the flocks with it in their vote, and its events" },
  { id: 'create', driver: 'create', pass: 'main', title: 'Start a flock: Burger night tomorrow at 8, four friends invited' },
  { id: 'vote', driver: 'vote', pass: 'main', title: 'Vote for a venue: The Copper Finch ahead with three' },
  { id: 'venue-card-events', driver: 'venue-card', frame: 'events', pass: 'main', title: "The Copper Finch's card: three events under Happening here" },
];

// Shared by several drivers: Messages, then a flock's chat by name.
async function openSiteChat(page, name) {
  await tab(page, 'Messages').click();
  await page.getByRole('button', { name: new RegExp(escapeSiteRe(name)) }).filter({ visible: true }).first().click();
  await page.locator('.chat-composer-field').first().waitFor({ timeout: 15000 });
}
const escapeSiteRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const blurAll = (page) => page.evaluate(() => document.activeElement && document.activeElement.blur());
// Scroll a descendant's nearest scrolling box so the descendant sits `pad` px
// below that box's top. The window never scrolls in the app; its boxes do.
const scrollInBox = (locator, pad = 12) => locator.evaluate((el, p) => {
  let s = el.parentElement;
  while (s && !/(auto|scroll)/.test(getComputedStyle(s).overflowY)) s = s.parentElement;
  if (!s) return;
  s.scrollTop += el.getBoundingClientRect().top - s.getBoundingClientRect().top - p;
}, pad);

/* THE NEWEST MESSAGE, WHOLE. The thread anchors to its bottom when it opens,
   and a row that grows after that (the poll card, a reaction strip) can leave
   the newest message half under the composer. Says how far short it opened,
   then finishes the scroll a reader would make. */
async function scrollChatToNewest(page, label) {
  const short = await page.evaluate(() => {
    const el = document.querySelector('.chat-scroller');
    if (!el) return null;
    const gap = Math.round(el.scrollHeight - el.scrollTop - el.clientHeight);
    el.scrollTop = el.scrollHeight;
    return gap;
  });
  if (short != null && short > 1) log(`  ${label}: the thread opened ${short}px short of its newest message; scrolled the rest of the way`);
  await page.waitForTimeout(400);
}

const SITE_DRIVERS = {
  /* THE NEST, as it opens at 7 PM: tonight's plan as the hero, what needs
     the camera account, who is out tonight. */
  async nest(page) {
    await tab(page, 'Nest').click();
    await page.locator('[data-nest-band="hero"]').getByText('Trivia Night').waitFor({ timeout: 20000 });
    await page.getByText(/^[A-Z][a-z]+day evening$/).first().waitFor({ timeout: 15000 });
    for (const row of [/Add your budget for Friday Night Crew/, /Vote on Nick.s Birthday/]) {
      await page.getByText(row).first().waitFor({ timeout: 15000 }).catch(() => log(`  nest: no "${row.source}" row`));
    }
    await page.locator('[data-nest-band="out-tonight"]').waitFor({ timeout: 15000 }).catch(() => log('  nest: no Out tonight? band'));
    await blurAll(page);
    await page.evaluate(() => { const s = document.querySelector('[data-nest-scroll]'); if (s) s.scrollTop = 0; });
    await settle(page, { quiet: 1200 });
  },
  /* THE COPPER FINCH'S CROWD FORECAST. With the map, the card its pin opens on
     Discover; without it, the venue sheet the chat's venue card opens, whose
     forecast is the same panel (CrowdForecastPanel). */
  async 'crowd-dial'(page) {
    if (SITE_MAP_KEY) {
      await openDiscoverPins(page);
      await page.getByRole('button', { name: /^The Copper Finch/ }).first().dispatchEvent('click');
    } else {
      await openSiteChat(page, DEMO.flockName);
      await settle(page);
      await page.locator('[data-card="venue"][role="button"]').filter({ visible: true }).first().click();
      const sheet = page.getByRole('dialog', { name: DEMO.venue.name });
      await sheet.waitFor({ timeout: 15000 });
      await sheet.getByText('Loading details...').waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});
    }
    await page.getByText('An estimate from typical patterns for this kind of place.').first().waitFor({ timeout: 20000 });
    await blurAll(page);
    await settle(page, { quiet: 1500 });
  },
  stillin: DRIVERS.stillin,
  /* BIRDIE ON THE NEST, answered in the page: the question at the top, the
     answer and its three cards under it. The answer is written by the rig
     (siteBirdieReply); no Gemini call is made. */
  async 'birdie-pick'(page) {
    await tab(page, 'Nest').click();
    let input = page.locator('[data-nest-band="birdie"] input[aria-label="Ask Birdie"]');
    await input.waitFor({ timeout: 15000 });
    await input.scrollIntoViewIfNeeded();
    await input.click();
    const allow = page.getByRole('button', { name: 'Allow', exact: true });
    if (await allow.waitFor({ timeout: 3000 }).then(() => true).catch(() => false)) {
      await allow.click();
      await allow.waitFor({ state: 'detached', timeout: 15000 });
    }
    input = page.locator('[data-nest-band="birdie"] input[aria-label="Ask Birdie"]');
    await input.waitFor({ timeout: 10000 });
    await input.fill(SITE_BIRDIE_ASK);
    const reply = page.waitForResponse((r) => r.url().includes('/api/ai/chat') && r.request().method() === 'POST', { timeout: 30000 });
    await input.press('Enter');
    await reply;
    await page.locator('[data-birdie-working]').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
    await page.getByText(/^Bluewing Diner\. Booths/).first().waitFor({ timeout: 15000 });
    await blurAll(page);
    await settle(page, { quiet: 1500 });
    await page.getByText(SITE_BIRDIE_ASK).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(700);
  },
  /* DISCOVER WITH THE MAP (SHOTS_MAPTILER_KEY): the invented places over Old
     City, the crowd heat warm over the busy ones, the map's credit drawn. */
  async 'map-crowd'(page) {
    await openDiscoverPins(page);
    await blurAll(page);
    await settle(page, { quiet: 3000 });
  },
  /* DISCOVER WITHOUT THE MAP: a search for dinner, its full list, each place
     with its drawing and its crowd figure. */
  async 'crowd-list'(page) {
    await tab(page, 'Discover').click();
    const search = page.locator('#search-input');
    await search.waitFor({ timeout: 15000 });
    const batch = page.waitForResponse((r) => r.url().includes('/api/crowd/batch'), { timeout: 30000 }).catch(() => null);
    await search.fill('dinner');
    await batch;
    await page.getByRole('button', { name: /^See (all \d+|1 result)/ }).first().click();
    await page.getByLabel(/out of 100/).first().waitFor({ timeout: 30000 });
    await blurAll(page);
    await settle(page, { quiet: 1500 });
  },
  async plans(page) {
    await tab(page, 'Plans').click();
    await page.getByText('Trivia Night').first().waitFor({ timeout: 15000 });
    await page.getByText(/52°/).first().waitFor({ timeout: 15000 }).catch(() => log('  plans: no weather on the card'));
    await settle(page, { quiet: 900 });
  },
  async you(page) {
    await tab(page, 'You').click();
    await page.getByText('Jayden Bansal').first().waitFor({ timeout: 15000 });
    await settle(page, { quiet: 900 });
  },
  async messages(page) {
    await tab(page, 'Messages').click();
    await page.getByText(DEMO.flockName).first().waitFor({ timeout: 15000 });
    await page.getByText('Asad Ali').first().waitFor({ timeout: 15000 }).catch(() => {});
    await blurAll(page);
    await settle(page, { quiet: 900 });
  },
  /* THE BILL, on last Thursday's dinner (the BILL pass, so the camera
     account still owes): the bill card in the thread, then the split sheet
     it opens. */
  async bill(page, shoot) {
    await openSiteChat(page, 'Thursday Dinner');
    const card = page.locator('[data-card="bill"]').first();
    await card.waitFor({ timeout: 15000 });
    await settle(page);
    await scrollChatToNewest(page, 'bill');
    await blurAll(page);
    await settle(page, { quiet: 600 });
    await shoot('chat');
    await card.getByText(/^Bill \$/).first().click();
    const pool = page.getByRole('dialog', { name: 'Cash pool' });
    await pool.waitFor({ timeout: 10000 });
    await pool.getByText(/18% tip/).first().waitFor({ timeout: 10000 });
    await blurAll(page);
    await settle(page, { quiet: 900 });
    await shoot('sheet');
    return true;
  },
  async chat(page) {
    await openSiteChat(page, DEMO.flockName);
    await page.getByText(DEMO.venue.name).first().waitFor({ timeout: 15000 });
    await page.locator('[data-card="poll"]').first().waitFor({ timeout: 15000 });
    await settle(page);
    await scrollChatToNewest(page, 'chat');
    await blurAll(page);
    await settle(page, { quiet: 600 });
  },
  /* THE PRIVATE BUDGET: the camera account has not answered, so the band opens the ask.
     $35 typed and not sent. */
  async budget(page) {
    await openSiteChat(page, DEMO.flockName);
    await page.getByText(/answered/).first().waitFor({ timeout: 15000 });
    await settle(page);
    await page.locator('[aria-label="Open group cash pool"]').click();
    const ask = page.getByText("What's your budget tonight?");
    if (!(await ask.isVisible().catch(() => false))) {
      const change = page.getByRole('button', { name: 'Change', exact: true });
      if (await change.isVisible().catch(() => false)) await change.click();
    }
    await ask.waitFor({ timeout: 10000 });
    await page.getByLabel('Amount').fill('35');
    await page.waitForTimeout(400);
    await blurAll(page);
    await settle(page, { quiet: 900 });
  },
  /* SOS from the Nest: the sheet, with two trusted contacts to email. */
  async sos(page) {
    await tab(page, 'Nest').click();
    await page.locator('[data-nest-band="hero"]').waitFor({ timeout: 15000 });
    await settle(page);
    await page.locator('[aria-label="Safety and emergency SOS"]').click();
    await page.getByRole('alertdialog').waitFor({ timeout: 10000 });
    await page.getByText(/2 trusted contacts will be emailed/).waitFor({ timeout: 15000 });
    await blurAll(page);
    await settle(page, { quiet: 900 });
  },
  /* THE OWNER'S DASHBOARD, Events tab: the drawn dining room behind the
     header, the burger as the logo, the flocks with it in their vote, its
     three events. */
  async 'venue-events'(page) {
    await DRIVERS['venue-events'](page);
    await page.getByText('Party of 5').first().waitFor({ timeout: 15000 }).catch(() => log('  owner-dashboard: no Party of 5'));
    await page.getByText(/Your Events/).first().waitFor({ timeout: 15000 }).catch(() => {});
    await settle(page, { quiet: 1200 });
  },
  /* START A FLOCK: a name, tomorrow at 8, four friends invited, and the form's
     own box scrolled so When and Who share the frame. */
  async create(page) {
    await tab(page, 'Nest').click();
    await page.getByText('Start a flock').first().click();
    const name = page.locator('#flock-name-input');
    await name.waitFor({ timeout: 10000 });
    await name.fill('Burger night');
    for (const label of ['Tomorrow', '8 PM']) {
      await page.getByRole('button', { name: label, exact: true }).first().click();
    }
    await page.getByText('Suggested', { exact: true }).waitFor({ timeout: 15000 });
    for (const who of ['Asad', 'Nick', 'Kaitlyn', 'Tommy']) {
      await page.locator('button.glass-secondary', { hasText: who }).first().click();
      await page.getByRole('button', { name: new RegExp(`^Remove ${who}`) }).waitFor({ timeout: 5000 });
    }
    await page.getByText('You and 4 more').first().waitFor({ timeout: 5000 });
    await scrollInBox(page.getByRole('heading', { name: 'When', exact: true }), 12);
    await blurAll(page);
    await settle(page, { quiet: 900 });
  },
  /* VOTING: the poll card's title opens the vote panel without the places
     search the composer's tile runs, so the panel holds the ballot alone.
     Nothing in it is tapped: every row there casts or moves a vote. */
  async vote(page) {
    await openSiteChat(page, DEMO.flockName);
    const poll = page.locator('[data-card="poll"]').first();
    await poll.waitFor({ timeout: 15000 });
    await settle(page);
    await poll.getByText('Where are we going?', { exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Vote on a venue' });
    await panel.waitFor({ timeout: 10000 });
    await panel.getByText(/votes? cast/).first().waitFor({ timeout: 10000 });
    await blurAll(page);
    await settle(page, { quiet: 900 });
  },
  /* THE VENUE SHEET from the chat's venue card, scrolled to Happening here:
     each event over one of the venue's own (drawn) photos. The block above
     the section (the crowd forecast) goes wholly under the sheet's fixed
     photo, so the section opens under the photo by its own 8px margin;
     scrolled to the heading with a gap, the forecast's rounded bottom edge
     showed as a strip between the two, a card cut off. */
  async 'venue-card'(page, shoot) {
    await openSiteChat(page, DEMO.flockName);
    await settle(page);
    await page.locator('[data-card="venue"][role="button"]').filter({ visible: true }).first().click();
    const sheet = page.getByRole('dialog', { name: DEMO.venue.name });
    await sheet.waitFor({ timeout: 15000 });
    await sheet.getByText('Loading details...').waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});
    const heading = sheet.getByRole('heading', { name: /Happening here/ });
    await heading.waitFor({ timeout: 15000 });
    await blurAll(page);
    await settle(page, { quiet: 1200 });
    const above = await heading.evaluate((el) => {
      let box = el.parentElement;
      while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
      if (!box) return null;
      // The section the heading opens, and the block before it.
      let section = el;
      while (section.parentElement && section.parentElement !== box && !section.previousElementSibling) section = section.parentElement;
      const prev = section.previousElementSibling;
      if (!prev) return null;
      box.scrollTop += Math.ceil(prev.getBoundingClientRect().bottom - box.getBoundingClientRect().top);
      return Math.round((prev.getBoundingClientRect().bottom - box.getBoundingClientRect().top) * 10) / 10;
    });
    if (above == null) {
      log('  venue-card: no block above Happening here; scrolled to the heading');
      await scrollInBox(heading, 16);
    } else if (above > 0) {
      throw new Error(`the block above Happening here still shows ${above}px under the photo`);
    }
    await settle(page, { quiet: 900 });
    await shoot('events');
    return true;
  },
};

/* WHAT A SITE FRAME MAY CARRY, checked on the page as it is shot. A frame
   that fails is not written.
   - Pictures: every visible <img>, <image>, <source> and CSS background is
     the rig's own page, a data: or blob: URL, the photo proxy asked for one
     of the rig's drawings (a shots-* ref), or, in a run given the map's key,
     MapTiler's tiles and still maps on any frame (the still map's pin is
     Flock's own file). A Places photo name, a Google host or the generated
     photo-real cover (/venue-covers/) fails it, and so does anything else.
   - Words: no element whose own text is a LIVE or ESTIMATED badge (the shapes
     noLiveDotLabel.test.js refuses), and no real business from the earlier
     captures by name.
   - The tab bar, where the frame shows it: the bird set (the birdhouse's roof
     and entrance hole, the binoculars' two lenses).
   Requests the stubs refused are reported with the frame. */
const SITE_BADGE_WORDS = /^(LIVE|Live|LIVE NOW|ESTIMATED|Estimated|FORECAST)$/;
const SITE_REAL_NAMES = /Sonny|Pizzeria Stella|Oh Brother|Silk City|Franklin Fountain|Race Street|European Republic|\bFork\b|IL GUSTO/;
async function auditSiteFrame(page, shot) {
  const seen = await page.evaluate(() => {
    const shown = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
    };
    const urls = new Set();
    const add = (u) => { if (u && typeof u === 'string') urls.add(u); };
    for (const img of document.images) if (shown(img)) add(img.currentSrc || img.src);
    for (const im of document.querySelectorAll('image')) if (shown(im)) add(im.getAttribute('href') || im.getAttribute('xlink:href'));
    for (const s of document.querySelectorAll('source')) {
      const pic = s.closest('picture');
      if (pic && shown(pic)) for (const part of String(s.srcset || '').split(',')) add(part.trim().split(/\s+/)[0]);
    }
    const badge = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!shown(el)) continue;
      for (const pseudo of [null, '::before', '::after']) {
        const bg = getComputedStyle(el, pseudo).backgroundImage;
        if (bg && bg !== 'none') for (const m of bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)) add(m[1]);
      }
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
      if (own && /^(LIVE|Live|LIVE NOW|ESTIMATED|Estimated|FORECAST)$/.test(own)) badge.push(`<${el.tagName.toLowerCase()}>${own}`);
    }
    const nav = [...document.querySelectorAll('nav[aria-label="Main"]')].find(shown) || null;
    return {
      urls: [...urls].map((u) => { try { return new URL(u, location.href).href; } catch { return u; } }),
      badge,
      text: document.body.innerText,
      // Each tab draws an outline when idle and a solid shape when chosen:
      // the birdhouse's hole is a circle on the outline and a cut in the
      // solid one, and so are the binoculars' two lenses.
      nav: nav ? (() => {
        const ds = [...nav.querySelectorAll('path')].map((pth) => pth.getAttribute('d') || '');
        return {
          roof: ds.includes('M2.5 12 12 2.5 21.5 12'),
          hole: !!nav.querySelector('circle[cx="12"][cy="13.5"]') || ds.some((d) => d.startsWith('M5.5 9 12 2.5 18.5 9')),
          lenses: nav.querySelectorAll('circle[r="3.5"]').length >= 2 || ds.some((d) => d.startsWith('M2.5 15.5 2.5 8.5 9.5 8.5')),
        };
      })() : null,
    };
  });
  const refOf = (u) => { try { return new URL(u).searchParams.get('ref') || ''; } catch { return ''; } };
  const pathOf = (u) => { try { return new URL(u).pathname; } catch { return ''; } };
  const verdicts = seen.urls.map((u) => {
    if (u.startsWith('data:') || u.startsWith('blob:')) return { u, ok: true, kind: 'inline' };
    if (/googleusercontent\.com|googleapis\.com|gstatic\.com|ggpht\.com|google\.com\/maps/.test(u)) return { u, ok: false, kind: 'google' };
    const own = u.startsWith(`${WEB_ORIGIN}/`) || u.startsWith(`${API_ORIGIN}/`);
    if (own && pathOf(u) === '/api/venues/photo') {
      const ref = refOf(u);
      if (ref.startsWith('places/')) return { u, ok: false, kind: 'places-photo' };
      return { u, ok: ref.startsWith('shots-'), kind: 'drawing' };
    }
    if (own && pathOf(u).startsWith('/venue-covers/')) return { u, ok: false, kind: 'photo-real-cover' };
    if (u.startsWith(`${WEB_ORIGIN}/`)) return { u, ok: true, kind: 'site' };
    // The map's tiles, and the still maps a build with the key draws on any
    // screen: the plan card's strip, the venue sheet's header while its first
    // photo decodes. Only with the key; without it no request leaves for them.
    if (SITE_MAP_KEY && u.startsWith('https://api.maptiler.com/')) return { u, ok: true, kind: 'map' };
    if (/^https:\/\/www\.flockcorp\.com\/map\/pin-[a-z0-9-]+\.svg$/.test(u)) return { u, ok: true, kind: 'map-pin' };
    return { u, ok: false, kind: 'foreign' };
  });
  const realNames = (seen.text.match(new RegExp(SITE_REAL_NAMES.source, 'g')) || []);
  const problems = [
    ...verdicts.filter((v) => !v.ok).map((v) => `${v.kind} picture: ${v.u.slice(0, 120)}`),
    ...seen.badge.map((b) => `a ${b} badge`),
    ...realNames.map((n) => `a real business's name: ${n}`),
  ];
  if (shot.nav) {
    if (!seen.nav) problems.push('no tab bar in the frame');
    else if (!seen.nav.roof || !seen.nav.hole || !seen.nav.lenses) problems.push(`the tab bar is not the bird set (${JSON.stringify(seen.nav)})`);
  }
  const ctx = page.context();
  return {
    pictures: verdicts.reduce((acc, v) => ({ ...acc, [v.kind]: (acc[v.kind] || 0) + 1 }), {}),
    drawings: [...new Set(verdicts.filter((v) => v.kind === 'drawing').map((v) => refOf(v.u)))],
    nav: seen.nav,
    answeredInBrowser: [...new Set(ctx.__siteAnswered || [])],
    refusedRequests: [...new Set(ctx.__siteRefused || [])],
    problems,
  };
}

/* THE CALLOUT TARGETS, measured as each annotated frame is shot, in percent
   of the frame to two decimals (the unit landingAnnotations.js uses). Each
   target is found in the page; a button, chip or field with a fill of its
   own is its border box, and text and icons are the box of their own pixels
   in the frame, read from the lossless capture inside the box the page gives
   them (a text's line box runs a few pixels above and below its letters, and
   a leader that ends on it would stop short). `boxes` is what the plates use,
   `dom` the page's boxes, `texts` every line of text in the frame (for placing
   a note's number where it covers none), `sheetTop` a sheet's top edge in CSS
   px and `sheetRow` its first whole row in the capture (sheetRowOf), for
   cutting a plate down to its sheet: the crop is sheetRow's. Specs:
     text / texts   the characters of one needle, or of several, unioned
     row            only the hits on the same line as that needle
     exact          a text node that is the needle and nothing else
     every          every hit of each needle, not only the first
     within         look inside the first visible match of that selector
     selector       an element (all: every match, unioned)
     box            button | chip | field | line | firstLine | sheet
     ink            measure the pixels inside the page's box (pad: px) */
const SITE_ANCHOR_SPECS = {
  vote: [
    { key: 'pinned', texts: ['The Copper Finch', 'Pinned', 'Google Maps'], row: 'Pinned', ink: true },
    { key: 'answered', text: 'answered', box: 'line', ink: true },
    { key: 'lock', text: 'Lock it in', exact: true, box: 'button', within: '[data-card="poll"]' },
    { key: 'voted', text: 'voted', box: 'line', within: '[data-card="poll"]', ink: true },
  ],
  budget: [
    { key: 'chip', selector: 'button.glass-secondary[aria-pressed]', within: '[role="dialog"]' },
    { key: 'field', selector: 'input[aria-label="Amount"]', box: 'field' },
    { key: 'note', text: 'This is anonymous', box: 'firstLine', ink: true },
    { key: 'skip', text: 'Skip', box: 'button' },
    { key: 'sheet', text: 'Group budget', exact: true, box: 'sheet' },
  ],
  bill: [
    { key: 'total', texts: ['Total', 'Paid by'], within: '[role="dialog"]', box: 'line', ink: true },
    { key: 'rows', texts: ['Jayden Bansal', 'Tommy Walsh', 'Owes'], every: true, within: '[role="dialog"]', box: 'line', ink: true, pad: 4 },
    { key: 'settle', text: 'Settle Up', box: 'button' },
    { key: 'sheet', text: 'Split the bill', exact: true, box: 'sheet' },
  ],
  sos: [
    { key: 'call911', text: 'Call 911', box: 'button' },
    { key: 'alert', text: 'Alert contacts', box: 'button' },
    { key: 'share', text: 'Share location', box: 'button' },
  ],
  venue: [
    { key: 'create', text: 'Create event', box: 'button' },
    { key: 'heading', text: 'Flocks with you in their vote', box: 'line', ink: true },
    { key: 'chips', texts: ['Confirmed', 'Considering you'], exact: true, box: 'chip' },
    { key: 'editDelete', selector: 'button[aria-label="Edit Trivia Night"] svg, button[aria-label="Delete Trivia Night"] svg', all: true, ink: true },
  ],
};
async function measureAnchors(page, kind) {
  const spec = SITE_ANCHOR_SPECS[kind];
  const out = await page.evaluate((list) => {
    const W = innerWidth;
    const H = innerHeight;
    const pct = (r) => [r.left / W * 100, r.top / H * 100, r.right / W * 100, r.bottom / H * 100].map((v) => Math.round(v * 100) / 100);
    const union = (rs) => (rs.length ? {
      left: Math.min(...rs.map((r) => r.left)), top: Math.min(...rs.map((r) => r.top)),
      right: Math.max(...rs.map((r) => r.right)), bottom: Math.max(...rs.map((r) => r.bottom)),
    } : null);
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.bottom <= 0 || r.top >= H) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    // Every text node shown that holds `needle`, with the needle's range.
    const textHits = (needle, exact, root) => {
      const hits = [];
      const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n.textContent;
        if (!t || !n.parentElement || !visible(n.parentElement)) continue;
        const i = exact ? (t.trim() === needle ? t.indexOf(needle) : -1) : t.indexOf(needle);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + needle.length);
        const r = range.getBoundingClientRect();
        if (r.width === 0 || r.bottom <= 0 || r.top >= H) continue;
        hits.push({ node: n, rect: r });
      }
      return hits;
    };
    const nodeRect = (node, first) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return first ? (range.getClientRects()[0] || null) : range.getBoundingClientRect();
    };
    const filled = (el) => {
      let c = el;
      while (c && c !== document.body) {
        const cs = getComputedStyle(c);
        if (parseFloat(cs.borderTopWidth) > 0 || cs.backgroundColor !== 'rgba(0, 0, 0, 0)') return c;
        c = c.parentElement;
      }
      return el;
    };
    const result = {};
    for (const s of list) {
      let rect = null;
      if (s.selector) {
        const scope = s.within ? [...document.querySelectorAll(s.within)].find(visible) : document;
        const els = scope ? [...scope.querySelectorAll(s.selector)].filter(visible) : [];
        if (s.all) rect = union(els.map((el) => el.getBoundingClientRect()));
        else if (els[0] && s.box === 'field') rect = filled(els[0]).getBoundingClientRect();
        else if (els[0]) rect = els[0].getBoundingClientRect();
      } else {
        const root = s.within ? [...document.querySelectorAll(s.within)].find(visible) : null;
        let hits = (s.texts || [s.text]).map((needle) => textHits(needle, s.exact, root));
        if (s.row) {
          const line = textHits(s.row, true, root)[0];
          const mid = (r) => (r.top + r.bottom) / 2;
          hits = hits.map((hs) => (line ? hs.filter((h) => Math.abs(mid(h.rect) - mid(line.rect)) < 14) : hs));
        }
        // The first hit of each needle, or every hit (`every`).
        const chosen = hits.flatMap((hs) => (s.every ? hs : hs.slice(0, 1)));
        const rects = chosen.map((h) => {
          const el = h.node.parentElement;
          if (!s.box) return h.rect;
          if (s.box === 'line') return nodeRect(h.node, false);
          if (s.box === 'firstLine') return nodeRect(h.node, true);
          if (s.box === 'button') return (el.closest('button, [role="button"], a') || el).getBoundingClientRect();
          if (s.box === 'chip') return filled(el).getBoundingClientRect();
          if (s.box === 'sheet') {
            // The panel the heading sits on: the nearest ancestor with a fill
            // of its own that spans the screen.
            let c = el;
            while (c && c !== document.body) {
              const r = c.getBoundingClientRect();
              if (r.width >= W * 0.95 && getComputedStyle(c).backgroundColor !== 'rgba(0, 0, 0, 0)') return r;
              c = c.parentElement;
            }
            return null;
          }
          return h.rect;
        }).filter(Boolean);
        rect = union(rects);
      }
      result[s.key] = rect ? pct(rect) : null;
      if (s.box === 'sheet' && rect) result.sheetTop = Math.round(rect.top * 100) / 100;
    }
    result.viewH = H;
    // Every line of text on screen, for placing the phone's numbers: the text
    // that is on top where it is drawn, not what a sheet or a scrim covers.
    const texts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!n.textContent.trim() || !el || !visible(el)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.bottom <= 0 || r.top >= H) continue;
        const hit = document.elementFromPoint(Math.min(W - 1, Math.max(0, (r.left + r.right) / 2)), Math.min(H - 1, Math.max(0, (r.top + r.bottom) / 2)));
        if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) continue;
        texts.push(pct(r));
      }
    }
    result.texts = texts;
    return result;
  }, spec);
  const missing = spec.filter((s) => !out[s.key]).map((s) => s.key);
  if (missing.length) log(`  anchors ${kind}: not found on the page: ${missing.join(', ')}`);
  return out;
}

/* A sheet's first whole row in the capture, for cutting a plate down to its
   sheet: the first row from the page's edge for it whose pixel is the sheet's
   own colour (within 10, summed over the channels: the fill varies by a point
   or two from row to row) and whose row above is not, read where the cut
   reads it, 60 px in at 780 wide, past the rounded corner's curve, with the
   fill taken eight rows inside the sheet. The page can put that edge on a
   half pixel (the bill's at 374.5), and the row there is the edge blended
   with what is behind, so a cut at the page's figure (749 of 1688, 44.37%)
   leaves a seam where the first whole row (750, 44.43%) does not. Device
   pixels, and the crop it makes in percent to two decimals. */
function sheetRowOf(img, sheetTopCss, viewH) {
  const { data, width: W, height: H, channels: C } = img;
  const x = Math.min(W - 1, Math.round(W * 60 / 780));
  const at = (y) => { const i = (y * W + x) * C; return [data[i], data[i + 1], data[i + 2]]; };
  const top = Math.floor(sheetTopCss * (H / viewH));
  const fill = at(Math.min(H - 1, top + 8));
  const near = (y) => { const p = at(y); return Math.abs(p[0] - fill[0]) + Math.abs(p[1] - fill[1]) + Math.abs(p[2] - fill[2]) <= 10; };
  for (let y = Math.max(1, top - 3); y < Math.min(H, top + 8); y += 1) {
    if (near(y) && !near(y - 1)) return { row: y, crop: Math.round(y / H * 10000) / 100, fill };
  }
  return null;
}

/* The pixels of a text or an icon inside the box the page gave it, grown by
   `pad` capture pixels: whatever differs from the colour that box's own
   border holds most (the measure3.py method: summed channel difference over
   60). The box, in percent to two decimals; the page's box if nothing shows. */
function inkBox(img, box, pad = 10, threshold = 60) {
  const { data, width: W, height: H, channels: C } = img;
  const r = [
    Math.max(0, Math.round(box[0] / 100 * W) - pad), Math.max(0, Math.round(box[1] / 100 * H) - pad),
    Math.min(W, Math.round(box[2] / 100 * W) + pad), Math.min(H, Math.round(box[3] / 100 * H) + pad),
  ];
  const at = (x, y) => { const i = (y * W + x) * C; return [data[i], data[i + 1], data[i + 2]]; };
  const counts = new Map();
  const tally = (x, y) => { const k = at(x, y).join(','); counts.set(k, (counts.get(k) || 0) + 1); };
  for (let x = r[0]; x < r[2]; x += 1) { tally(x, r[1]); tally(x, r[3] - 1); }
  for (let y = r[1]; y < r[3]; y += 1) { tally(r[0], y); tally(r[2] - 1, y); }
  const bg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
  let x1 = Infinity; let y1 = Infinity; let x2 = -1; let y2 = -1;
  for (let y = r[1]; y < r[3]; y += 1) {
    for (let x = r[0]; x < r[2]; x += 1) {
      const p = at(x, y);
      if (Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > threshold) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  }
  if (x2 < 0) return box;
  const p = (v, d) => Math.round(v / d * 10000) / 100;
  return [p(x1, W), p(y1, H), p(x2 + 1, W), p(y2 + 1, H)];
}

/* One frame of the site story, kept as a lossless master in memory and
   audited; the shipped files are cut from it at the end (exportSite), or, at
   a size of its own, kept as they are (exportSiteMasters). A sized run shoots
   each frame once per mode, so its frames, audits and anchors are keyed by
   frame and mode. */
const siteKey = (id, mode) => (SITE_SIZED ? `${id}-${mode}` : id);
async function snapSite(page, shot, frames, report, size, mode) {
  await checkOverflow(page, { screen: { id: shot.id }, size, mode });
  const audit = await auditSiteFrame(page, shot);
  const dom = shot.anchors ? await measureAnchors(page, shot.anchors) : null;
  const raw = await page.screenshot({ type: 'png' });
  report.audit[siteKey(shot.id, mode)] = audit;
  if (dom) {
    const sharp = requireFrontend('sharp');
    const { data, info } = await sharp(raw).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const img = { data, width: info.width, height: info.height, channels: info.channels };
    const boxes = {};
    const how = {};
    for (const s of SITE_ANCHOR_SPECS[shot.anchors]) {
      if (!dom[s.key] || s.box === 'sheet') continue;
      boxes[s.key] = s.ink ? inkBox(img, dom[s.key], s.pad) : dom[s.key];
      how[s.key] = s.ink ? 'ink' : 'element';
    }
    const { texts, sheetTop, viewH, ...domBoxes } = dom;
    report.anchors[siteKey(shot.anchors, mode)] = {
      frame: shot.id, boxes, how, dom: domBoxes, sheetTop: sheetTop ?? null,
      sheetRow: sheetTop == null ? null : sheetRowOf(img, sheetTop, viewH),
      texts,
    };
  }
  if (audit.problems.length) throw new Error(`refused by the audit: ${audit.problems.slice(0, 4).join('; ')}`);
  frames.set(siteKey(shot.id, mode), raw);
  const pics = Object.entries(audit.pictures).map(([k, n]) => `${n} ${k}`).join(', ') || 'none';
  log(`  ok ${siteKey(shot.id, mode)}: pictures ${pics}${audit.drawings.length ? ` (${audit.drawings.join(', ')})` : ''}${audit.refusedRequests.length ? `; refused ${audit.refusedRequests.length} outside request(s)` : ''}`);
}

async function captureSite(dbUrl, seeded) {
  const sharp = requireFrontend('sharp');
  const browser = await launchChromium();
  const userToken = await apiLogin(DEMO.camera.email, DEMO.password);
  const ownerToken = await apiLogin(DEMO.owner.email, DEMO.password);
  // The website's frames are dark at 390x844 at 2; a sized run shoots its own
  // size in each mode it was given.
  const size = SITE_SIZED ? CUSTOM_SIZE : SIZES[0];
  const modes = SITE_SIZED ? MODES : ['dark'];
  const wanted = SITE_SHOTS.filter((s) => !ONLY || ONLY.includes(s.id));
  const frames = new Map();
  const report = { audit: {}, anchors: {} };
  const failures = [];
  const diagnose = (page) => {
    page.__consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') page.__consoleErrors.push(m.text().slice(0, 200)); });
    page.on('pageerror', (err) => page.__consoleErrors.push(`pageerror: ${String(err).slice(0, 200)}`));
  };
  try {
    for (const mode of modes) for (const pass of ['main', 'bill']) {
      const shots = wanted.filter((s) => s.pass === pass);
      if (!shots.length) continue;
      log(`site story, ${SITE_SIZED ? `${mode} ` : ''}${pass.toUpperCase()} pass: ${shots.map((s) => s.id).join(', ')}`);
      await setServerTheme(dbUrl, mode);
      // One visit per driver; a driver that frames two shots (the bill) runs once.
      const drivers = [...new Set(shots.filter((s) => !s.owner).map((s) => s.driver))];
      if (drivers.length) {
        const { context, page } = await newAppContext(browser, { size, mode, token: userToken, userMode: 'user' });
        diagnose(page);
        try {
          for (const driver of drivers) {
            const mine = shots.filter((s) => s.driver === driver && !s.owner);
            try {
              await setSitePass(dbUrl, seeded, pass);
              context.__siteAnswered.length = 0;
              context.__siteRefused.length = 0;
              await page.goto(`${WEB_ORIGIN}/app`, { waitUntil: 'domcontentloaded' });
              await page.addStyleTag({ content: hideCaretCss });
              await waitAppReady(page);
              const shoot = async (label) => {
                const shot = mine.find((s) => s.frame === label);
                if (shot) await snapSite(page, shot, frames, report, size, mode);
              };
              const framed = await SITE_DRIVERS[driver](page, shoot);
              if (!framed) await snapSite(page, mine.find((s) => !s.frame) || mine[0], frames, report, size, mode);
            } catch (e) {
              failures.push(await failureReport(page, e, { screen: { id: mine.map((s) => s.id).join('+') }, size, mode }));
            }
          }
        } finally {
          await context.close();
        }
      }
      const owned = shots.filter((s) => s.owner);
      if (owned.length) {
        const { context, page } = await newAppContext(browser, { size, mode, token: ownerToken, userMode: 'venue' });
        diagnose(page);
        try {
          for (const shot of owned) {
            try {
              await setSitePass(dbUrl, seeded, pass);
              context.__siteAnswered.length = 0;
              context.__siteRefused.length = 0;
              await page.goto(`${WEB_ORIGIN}/app?venue=true`, { waitUntil: 'domcontentloaded' });
              await page.addStyleTag({ content: hideCaretCss });
              await SITE_DRIVERS[shot.driver](page);
              await snapSite(page, shot, frames, report, size, mode);
            } catch (e) {
              failures.push(await failureReport(page, e, { screen: { id: shot.id }, size, mode }));
            }
          }
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  const kept = frames.size;
  if (SITE_SIZED) await exportSiteMasters(sharp, frames, report, size, modes);
  else await exportSite(sharp, frames, report);
  reportOverflow();
  log(`site story: ${kept} of ${wanted.length * modes.length} frame(s) kept${failures.length ? `, ${failures.length} FAILURES` : ''}`);
  if (SITE_MAP_KEY) log('site story: the map was drawn; a map frame ships with the footer\'s MapTiler and OpenStreetMap line (SiteFooter.js, siteFooter.test.js) and WIRING.md\'s words for it');
  for (const f of failures) log(`  FAIL ${f}`);
  if (failures.length) process.exitCode = 1;
}

/* THE SHIPPED NAMES, cut from each frame's master: <frame>-dark<suffix>@2x.webp
   (780 wide, quality 82) and -480w.webp (480 wide, lanczos3), and for the
   home screen the PNG fallback (full colour: a 256-colour palette bands the
   drawings and dithers the painted birds) and the reel's AVIF, which
   siteSpeedPass.test.js holds under 40,000 bytes. `palette: false` is said
   outright: sharp turns the palette on whenever a PNG is given an `effort`,
   which is how the first -v3 PNG came out at 253 colours. Beside them: the
   audit, the anchors, a manifest of what was written and a contact sheet of
   every frame. */
async function exportSite(sharp, frames, report) {
  const written = [];
  const put = async (file, buf, extra) => {
    fs.writeFileSync(path.join(OUT_DIR, file), buf);
    const meta = await sharp(buf).metadata();
    written.push({ file, bytes: buf.length, width: meta.width, height: meta.height, ...extra });
  };
  fs.mkdirSync(path.join(OUT_DIR, 'masters'), { recursive: true });
  for (const shot of SITE_SHOTS) {
    const raw = frames.get(shot.id);
    if (!raw) continue;
    fs.writeFileSync(path.join(OUT_DIR, 'masters', `${shot.id}-dark${SUFFIX}@2x.png`), raw);
    const base = `${shot.id}-dark${SUFFIX}`;
    await put(`${base}@2x.webp`, await sharp(raw).webp({ quality: 82 }).toBuffer(), { screen: shot.id, title: shot.title });
    await put(`${base}-480w.webp`, await sharp(raw).resize(480, null, { kernel: 'lanczos3' }).webp({ quality: 82 }).toBuffer(), { screen: shot.id, title: shot.title });
    if (shot.id === 'nest') {
      await put(`${base}@2x.png`, await sharp(raw).png({ compressionLevel: 9, palette: false }).toBuffer(), { screen: shot.id, title: shot.title });
      let avif = null;
      for (let quality = 50; quality >= 30; quality -= 4) {
        avif = await sharp(raw).flatten({ background: '#000000' }).removeAlpha().avif({ quality, effort: 9 }).toBuffer();
        if (avif.length < 40000) break;
      }
      await put(`home-reel${SUFFIX}.avif`, avif, { screen: shot.id, title: shot.title });
    }
  }
  const earlier = (file, empty) => {
    try { return JSON.parse(fs.readFileSync(path.join(OUT_DIR, file), 'utf8')); } catch { return empty; }
  };
  const audit = earlier(`audit${SUFFIX}.json`, { frames: {} });
  fs.writeFileSync(path.join(OUT_DIR, `audit${SUFFIX}.json`), JSON.stringify({
    takenAt: RUN_T.toISOString(), zone: SITE_CLOCK.zone, mapKey: !!SITE_MAP_KEY,
    frames: { ...(audit.frames || {}), ...report.audit }, overflow: overflowFindings,
  }, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, `anchors${SUFFIX}.json`), JSON.stringify({ ...earlier(`anchors${SUFFIX}.json`, {}), ...report.anchors }, null, 2));
  const files = new Map(earlier(`site-manifest${SUFFIX}.json`, []).map((f) => [f.file, f]));
  for (const f of written) files.set(f.file, f);
  fs.writeFileSync(path.join(OUT_DIR, `site-manifest${SUFFIX}.json`), JSON.stringify([...files.values()].sort((a, b) => a.file.localeCompare(b.file)), null, 2));
  // The contact sheet: every frame at 260 px, six to a row, named over it.
  const master = (id) => path.join(OUT_DIR, 'masters', `${id}-dark${SUFFIX}@2x.png`);
  for (const shot of SITE_SHOTS) if (!frames.has(shot.id) && fs.existsSync(master(shot.id))) frames.set(shot.id, fs.readFileSync(master(shot.id)));
  const shots = SITE_SHOTS.filter((s) => frames.has(s.id));
  if (shots.length) {
    const w = 260;
    const h = Math.round(w * 1688 / 780);
    const cols = 6;
    const rows = Math.ceil(shots.length / cols);
    const pad = 14;
    const label = 26;
    const tiles = [];
    for (const [i, shot] of shots.entries()) {
      const x = pad + (i % cols) * (w + pad);
      const y = pad + Math.floor(i / cols) * (h + label + pad);
      tiles.push({ input: await sharp(frames.get(shot.id)).resize(w).png().toBuffer(), left: x, top: y + label });
      const text = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${label}"><text x="0" y="18" font-family="Arial, sans-serif" font-size="15" fill="#e8ecf2">${shot.id}-dark${SUFFIX}</text></svg>`);
      tiles.push({ input: text, left: x, top: y });
    }
    const sheet = await sharp({
      create: { width: pad + cols * (w + pad), height: pad + rows * (h + label + pad), channels: 3, background: '#1b1f27' },
    }).composite(tiles).png().toBuffer();
    fs.writeFileSync(path.join(OUT_DIR, `contact${SUFFIX}.png`), sheet);
  }
  log(`site story: ${written.length} file(s) written to ${OUT_DIR} (audit${SUFFIX}.json, anchors${SUFFIX}.json, contact${SUFFIX}.png beside them)`);
}

/* THE SITE STORY AT A SIZE OF ITS OWN: each frame kept whole, as an opaque PNG
   (Apple takes no alpha), <frame>-<mode>-<width>x<height>.png, with the audit
   and the anchors keyed by frame and mode beside them and a contact sheet of
   every frame. Nothing is resized, recompressed or named for the site. */
async function exportSiteMasters(sharp, frames, report, size, modes) {
  const W = size.viewport.width * size.dsf;
  const H = size.viewport.height * size.dsf;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const kept = [];
  for (const mode of modes) {
    for (const shot of SITE_SHOTS) {
      const raw = frames.get(siteKey(shot.id, mode));
      if (!raw) continue;
      const file = `${shot.id}-${mode}-${W}x${H}.png`;
      fs.writeFileSync(path.join(OUT_DIR, file), await sharp(raw).removeAlpha().png({ compressionLevel: 9, palette: false }).toBuffer());
      kept.push({ file, id: shot.id, mode, title: shot.title });
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, `audit-${W}x${H}.json`), JSON.stringify({
    takenAt: RUN_T.toISOString(), zone: SITE_CLOCK.zone, size: { ...size.viewport, scale: size.dsf }, modes,
    frames: report.audit, overflow: overflowFindings,
  }, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, `anchors-${W}x${H}.json`), JSON.stringify(report.anchors, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, `manifest-${W}x${H}.json`), JSON.stringify(kept, null, 2));
  if (kept.length) {
    const w = 260;
    const h = Math.round(w * H / W);
    const cols = 6;
    const pad = 14;
    const label = 26;
    const rows = Math.ceil(kept.length / cols);
    const tiles = [];
    for (const [i, k] of kept.entries()) {
      const x = pad + (i % cols) * (w + pad);
      const y = pad + Math.floor(i / cols) * (h + label + pad);
      tiles.push({ input: await sharp(frames.get(siteKey(k.id, k.mode))).resize(w).png().toBuffer(), left: x, top: y + label });
      const text = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${label}"><text x="0" y="18" font-family="Arial, sans-serif" font-size="15" fill="#e8ecf2">${k.id}-${k.mode}</text></svg>`);
      tiles.push({ input: text, left: x, top: y });
    }
    const sheet = await sharp({
      create: { width: pad + cols * (w + pad), height: pad + rows * (h + label + pad), channels: 3, background: '#1b1f27' },
    }).composite(tiles).png().toBuffer();
    fs.writeFileSync(path.join(OUT_DIR, `contact-${W}x${H}.png`), sheet);
  }
  log(`site story at ${W}x${H}: ${kept.length} master(s) written to ${OUT_DIR}`);
}

main().catch((e) => die(e.stack || e.message));
