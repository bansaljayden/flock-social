// ---------------------------------------------------------------------------
// COLLECT GAME SCHEDULES FOR THE CROWD MODEL (TheSportsDB)
// ---------------------------------------------------------------------------
// Fills ml_sports_events (migration 057) with every game involving a tracked
// Philadelphia team, HOME OR AWAY, for the seasons asked for. Home or away is
// the point, not an accident: the expanded scope in RETRAIN.md records that
// sports bars fill for road games on TV too, so the model's flag is "is this
// team playing at all tonight", with home-ness kept as its own column for the
// arena-distance features layered on top.
//
//   node scripts/ml/collectSportsSchedules.js --verify          (one call, key check, writes nothing)
//   node scripts/ml/collectSportsSchedules.js --seasons=2025-2026,2026-2027
//   node scripts/ml/collectSportsSchedules.js                   (default: the seasons covering the frozen corpus plus now)
//
// It also refreshes itself: collectRealtime.js calls refreshSportsIfDue()
// at the end of every hourly run, which pulls the seasons in play today
// (currentSeasons) whenever the table's newest row is more than 20 hours
// old, so in practice once a day. Serving (mlPredictor.sportsFeatureValues)
// and training both read ml_sports_events, and a table nobody refreshes
// serves "no game" on game nights. That path never throws; a SportsDB
// outage is a log line, never a lost crowd collection.
//
// Costs: SPORTSDB_API_KEY is a flat $9/mo subscription with a 100 req/min
// limit; a full run here is a few dozen requests total, so there is no bill
// to guard, only politeness (250ms between calls). This is deliberately a
// SEPARATE spend class from BestTime: running this touches no BestTime
// credits and no BestTime endpoints.
//
// Team ids are resolved by NAME at runtime through searchteams.php rather
// than hardcoded from anyone's memory, then pinned by league sanity checks.
// League season schedules come from eventsseason.php and are filtered to
// games where a tracked team appears on either side.
//
// NCAA (the Lehigh corridor angle in RETRAIN.md) is NOT collected yet:
// SportsDB's college coverage on this tier is unverified, and the scope doc
// says to verify it against real pulls before building on it. When that
// happens it is a new entry in TRACKED, not a new script.
// ---------------------------------------------------------------------------

// Requiring this module does nothing: no .env load, no pool, no request.
// The collector requires it for refreshSportsIfDue, and the CLI's setup
// lives in cli() below, behind require.main.
const { sleep } = require('./config');

// Read at call time, not at load, so a key set after the module loaded
// (tests, or a process that loads .env later) is the one used.
function apiKey() {
  return process.env.SPORTSDB_API_KEY || '';
}

const BASE = 'https://www.thesportsdb.com/api/v1/json';
const PAUSE_MS = 250;
// The hourly collector refreshes when the newest row is older than this.
// 20 hours rather than 24 so a daily refresh that ran a little late one day
// does not slip a whole extra hour every day after it.
const FRESH_HOURS = 20;

// The five Philadelphia pro teams from the RETRAIN.md scope. search is the
// exact string handed to searchteams.php; league is a sanity pin so a
// same-named team in some other competition cannot slip in.
const TRACKED = [
  { key: 'eagles', search: 'Philadelphia Eagles', league: 'NFL', code: 'NFL' },
  { key: 'sixers', search: 'Philadelphia 76ers', league: 'NBA', code: 'NBA' },
  { key: 'phillies', search: 'Philadelphia Phillies', league: 'MLB', code: 'MLB' },
  { key: 'flyers', search: 'Philadelphia Flyers', league: 'NHL', code: 'NHL' },
  // league is SportsDB's exact strLeague for matching; code is what the
  // table stores. The full MLS string is 28 characters against a
  // VARCHAR(16) column, which killed the first pull's insert.
  { key: 'union', search: 'Philadelphia Union', league: 'American Major League Soccer', code: 'MLS' },
  // The Lehigh corridor's fall signal, verified on this tier 2026-08-30:
  // both schools carry NCAA Division 1 football (their rivalry is the
  // biggest sports event in that market). College BASKETBALL coverage is
  // patchy on this tier (no Villanova hoops at all), so it stays out until
  // it can be verified the way these were. searchteams matches the short
  // names, not the mascot forms.
  { key: 'lehigh_fb', search: 'Lehigh', league: 'NCAA Division 1', code: 'NCAAF' },
  { key: 'lafayette_fb', search: 'Lafayette', league: 'NCAA Division 1', code: 'NCAAF' },
];

// Seasons whose games can overlap the corpus (Mar 10 to Aug 29 2026 weekly
// window, realtime Mar to May 2026) plus the season now in progress. NFL and
// MLS use single-year season strings; the winter leagues span two.
const DEFAULT_SEASONS = {
  NFL: ['2025', '2026'],
  NBA: ['2025-2026', '2026-2027'],
  MLB: ['2026'],
  NHL: ['2025-2026', '2026-2027'],
  'American Major League Soccer': ['2026'],
  // One big league-wide fetch, filtered to the two tracked schools locally.
  // 2026 only: the 2025 college season predates the corpus window entirely.
  'NCAA Division 1': ['2026'],
};

// The seasons in play on a given date, computed so they never go stale the
// way a hardcoded list does. The football seasons are named for the year
// they start (September) and run into the next year's February, so January
// and February still belong to last year's season. The winter leagues span
// two years and open their new schedule over the summer, so from July on
// the upcoming season is the one worth pulling. Everything else is played
// within one calendar year. Months are 1 based and read in UTC; a day's
// slip at a boundary costs nothing because the refresh runs daily.
function currentSeasons(league, now = new Date()) {
  const y = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  if (league === 'NFL' || league === 'NCAA Division 1') return String(month >= 3 ? y : y - 1);
  if (league === 'NBA' || league === 'NHL') return month >= 7 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
  return String(y);
}

async function get(pathAndQuery) {
  const res = await fetch(`${BASE}/${apiKey()}/${pathAndQuery}`);
  if (!res.ok) throw new Error(`SportsDB ${res.status} on ${pathAndQuery}`);
  return res.json();
}

async function resolveTeam(t, pauseMs = PAUSE_MS) {
  const data = await get(`searchteams.php?t=${encodeURIComponent(t.search)}`);
  const teams = data.teams || [];
  const hit = teams.find((x) => x.strTeam === t.search && x.strLeague === t.league);
  if (!hit) {
    throw new Error(`Could not resolve ${t.search} in ${t.league} (got: ${teams.map((x) => `${x.strTeam}/${x.strLeague}`).join(', ') || 'nothing'})`);
  }
  // SportsDB's own venue records carry the arena coordinates, which is the
  // free stadium list the scope doc counts on, but they live one hop away:
  // the team record holds idVenue, and lookupvenue.php answers with a
  // "lat, lon" string in strMap (probed live 2026-08-29; the team record
  // itself carries no coordinate fields on this tier).
  let stadiumLat = null;
  let stadiumLon = null;
  if (hit.idVenue) {
    await sleep(pauseMs);
    try {
      const vd = await get(`lookupvenue.php?id=${encodeURIComponent(hit.idVenue)}`);
      const venue = (vd.venues || [])[0];
      const parsed = parseStrMap(venue?.strMap);
      if (parsed) {
        stadiumLat = parsed.lat;
        stadiumLon = parsed.lon;
      }
    } catch (err) {
      // A missing venue record costs the distance feature for this team's
      // home games, not the run.
      console.warn(`[ML:Sports] venue lookup failed for ${t.search}: ${err.message}`);
    }
  }
  return {
    ...t,
    teamId: hit.idTeam,
    leagueId: hit.idLeague,
    stadium: hit.strStadium || null,
    stadiumLat,
    stadiumLon,
  };
}

// strMap arrives in TWO formats across SportsDB's own venue records,
// probed live 2026-08-30: decimal ("39.901111, -75.171944", the Sixers and
// Flyers arena) and degrees-minutes-seconds ("39°54′21″N 75°9′59″W",
// the other three). Both parse; anything else returns null and costs the
// distance feature, never the run.
function parseStrMap(raw) {
  const str = String(raw || '').trim();
  let m = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(str);
  if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };
  m = /^(\d+)°(\d+)′(?:(\d+(?:\.\d+)?)″)?([NS])\s+(\d+)°(\d+)′(?:(\d+(?:\.\d+)?)″)?([EW])$/.exec(str);
  if (m) {
    const lat = (parseInt(m[1], 10) + parseInt(m[2], 10) / 60 + (parseFloat(m[3]) || 0) / 3600) * (m[4] === 'S' ? -1 : 1);
    const lon = (parseInt(m[5], 10) + parseInt(m[6], 10) / 60 + (parseFloat(m[7]) || 0) / 3600) * (m[8] === 'W' ? -1 : 1);
    return { lat, lon };
  }
  return null;
}

// The stored date and time are the MARKET's (America/New_York), derived
// from the UTC instant whenever one exists. The API's dateEventLocal is the
// HOST venue's wall clock, and a late West Coast start crosses Eastern
// midnight: gameNights queries an Eastern date and the feature builder joins
// Pennsylvania observation dates, so a host-local date lands that game on
// the wrong market night (code review, 2026-09-01). The API fields remain
// the fallback when no instant is available.
const MARKET_DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const MARKET_TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/New_York', hour12: false,
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function eventInstant(ev) {
  // strTimestamp is the UTC instant when present. The date/time pair is the
  // LOCAL wall clock of the event and stays stored as-is; deriving the
  // instant from it would be the naive-timestamp landmine.
  if (ev.strTimestamp) {
    const d = new Date(ev.strTimestamp.endsWith('Z') ? ev.strTimestamp : `${ev.strTimestamp}Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

// Resolve the tracked teams, then one schedule pull per (league, season),
// filtered to tracked teams on EITHER side, so shared leagues (two tracked
// teams meeting each other) are fetched once and written once per team
// perspective. seasonsFor(league) answers the seasons to pull for a
// SportsDB league name. Throws on any SportsDB or database failure; the
// callers decide whether that is fatal (the CLI) or a log line (the daily
// refresh).
async function refreshSportsSchedules(pool, seasonsFor, log = console.log, { pauseMs = PAUSE_MS } = {}) {
  const resolved = [];
  for (const t of TRACKED) {
    resolved.push(await resolveTeam(t, pauseMs));
    await sleep(pauseMs);
  }
  log('[ML:Sports] Teams resolved:');
  for (const t of resolved) {
    log(`  ${t.key}: ${t.teamId} (${t.league}), arena ${t.stadium} @ ${t.stadiumLat},${t.stadiumLon}`);
  }

  const byLeague = new Map();
  for (const t of resolved) {
    if (!byLeague.has(t.leagueId)) byLeague.set(t.leagueId, { league: t.league, code: t.code, teams: [] });
    byLeague.get(t.leagueId).teams.push(t);
  }

  let written = 0;
  for (const [leagueId, entry] of byLeague) {
    const seasons = seasonsFor(entry.league) || [];
    for (const season of seasons) {
      const data = await get(`eventsseason.php?id=${leagueId}&s=${encodeURIComponent(season)}`);
      await sleep(pauseMs);
      const events = data.events || [];
      log(`[ML:Sports] ${entry.league} ${season}: ${events.length} league events fetched.`);
      for (const ev of events) {
        for (const t of entry.teams) {
          const isHome = ev.idHomeTeam === t.teamId;
          const isAway = ev.idAwayTeam === t.teamId;
          if (!isHome && !isAway) continue;
          const instant = eventInstant(ev);
          const marketDate = instant ? MARKET_DATE_FMT.format(instant) : (ev.dateEventLocal || ev.dateEvent || null);
          const marketTime = instant ? MARKET_TIME_FMT.format(instant) : (ev.strTimeLocal || ev.strTime || null);
          await pool.query(
            `INSERT INTO ml_sports_events
               (sportsdb_event_id, league, season, team_key, is_home, opponent,
                event_utc, event_local_date, event_local_time, venue_name,
                venue_lat, venue_lon, raw_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             ON CONFLICT (sportsdb_event_id) DO UPDATE SET
               event_utc = EXCLUDED.event_utc,
               event_local_date = EXCLUDED.event_local_date,
               event_local_time = EXCLUDED.event_local_time,
               venue_name = EXCLUDED.venue_name,
               venue_lat = EXCLUDED.venue_lat,
               venue_lon = EXCLUDED.venue_lon,
               raw_status = EXCLUDED.raw_status,
               collected_at = NOW()`,
            [
              // Two tracked teams meeting each other is one event id; the
              // suffix keeps one row per team perspective without
              // inventing a second real event.
              `${ev.idEvent}:${t.key}`,
              entry.code,
              season,
              t.key,
              isHome,
              isHome ? ev.strAwayTeam : ev.strHomeTeam,
              instant,
              marketDate,
              marketTime,
              ev.strVenue || (isHome ? t.stadium : null),
              isHome ? t.stadiumLat : null,
              isHome ? t.stadiumLon : null,
              ev.strStatus || null,
            ]
          );
          written++;
        }
      }
    }
  }
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n, MIN(event_local_date) AS lo, MAX(event_local_date) AS hi FROM ml_sports_events');
  log(`[ML:Sports] Done. ${written} rows upserted this run; table holds ${rows[0].n} (${rows[0].lo} to ${rows[0].hi}).`);
  return { written, total: rows[0].n };
}

// THE DAILY REFRESH, called at the end of every hourly collector run.
// Skips without a key (says so, because a missing key is otherwise
// invisible) and while the table's newest row is younger than FRESH_HOURS,
// so the SportsDB requests happen about once a day. NEVER throws: the
// collector's crowd readings are already committed by the time this runs,
// and nothing about a schedule refresh may fail that run. Every outcome is
// returned as a status for the tests and logged for the operator.
async function refreshSportsIfDue(pool, { now = new Date(), log = console.log, pauseMs = PAUSE_MS } = {}) {
  try {
    if (!apiKey()) {
      log('[ML:Sports] Schedule refresh skipped: SPORTSDB_API_KEY is not set on this service.');
      return { status: 'no_key' };
    }
    const { rows } = await pool.query('SELECT MAX(collected_at) AS last FROM ml_sports_events');
    const last = rows[0] && rows[0].last ? new Date(rows[0].last) : null;
    const ageHours = last ? (now.getTime() - last.getTime()) / 3600000 : null;
    if (ageHours != null && ageHours < FRESH_HOURS) {
      log(`[ML:Sports] Schedule refresh skipped: newest row is ${ageHours.toFixed(1)}h old (refreshes after ${FRESH_HOURS}h).`);
      return { status: 'fresh', ageHours };
    }
    log(`[ML:Sports] Schedule refresh due (${ageHours == null ? 'table empty' : `newest row ${ageHours.toFixed(1)}h old`}).`);
    const result = await refreshSportsSchedules(pool, (league) => [currentSeasons(league, now)], log, { pauseMs });
    return { status: 'refreshed', ...result };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    try {
      log(`[ML:Sports] Schedule refresh failed, crowd collection unaffected: ${message}`);
    } catch (_) {
      // A logger that throws must not turn a swallowed failure into a thrown one.
    }
    return { status: 'error', error: message };
  }
}

async function cli() {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
  if (!process.env.DATABASE_URL && process.env.PGHOST) {
    const host = process.env.PGHOST;
    const port = process.env.PGPORT || 5432;
    const user = process.env.PGUSER || 'postgres';
    const pass = process.env.PGPASSWORD || '';
    const db = process.env.PGDATABASE || 'railway';
    process.env.DATABASE_URL = `postgresql://${user}:${pass}@${host}:${port}/${db}`;
  }

  if (!apiKey()) {
    console.error('[ML:Sports] SPORTSDB_API_KEY not set (backend/.env).');
    process.exitCode = 1;
    return;
  }

  const verifyOnly = process.argv.includes('--verify');
  const seasonsArg = process.argv.find((a) => a.startsWith('--seasons='));

  if (verifyOnly) {
    // One request, no writes: proves the key is live and premium. The shared
    // public test key cannot see V2 or full premium data, but this V1 search
    // works on both, so the check is "did we get OUR key's answer", which is
    // simply that the call succeeds under this key path at all.
    const t = await resolveTeam(TRACKED[1]);
    console.log(`[ML:Sports] Key OK. Resolved ${t.search}: team ${t.teamId}, league ${t.leagueId} (${t.league}), arena "${t.stadium}" at ${t.stadiumLat},${t.stadiumLon}.`);
    return;
  }

  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const seasonsFor = seasonsArg
    ? () => seasonsArg.split('=')[1].split(',')
    : (league) => DEFAULT_SEASONS[league] || [];
  try {
    await refreshSportsSchedules(pool, seasonsFor);
  } finally {
    await pool.end();
  }
}

module.exports = {
  currentSeasons, refreshSportsSchedules, refreshSportsIfDue,
  parseStrMap, TRACKED, DEFAULT_SEASONS, FRESH_HOURS,
};

if (require.main === module) {
  cli().catch((err) => {
    console.error('[ML:Sports] Fatal:', err.message);
    process.exitCode = 1;
  });
}
