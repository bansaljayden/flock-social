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

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');
const { sleep } = require('./config');

if (!process.env.DATABASE_URL && process.env.PGHOST) {
  const host = process.env.PGHOST;
  const port = process.env.PGPORT || 5432;
  const user = process.env.PGUSER || 'postgres';
  const pass = process.env.PGPASSWORD || '';
  const db = process.env.PGDATABASE || 'railway';
  process.env.DATABASE_URL = `postgresql://${user}:${pass}@${host}:${port}/${db}`;
}

const API_KEY = process.env.SPORTSDB_API_KEY;
const BASE = 'https://www.thesportsdb.com/api/v1/json';

// The five Philadelphia pro teams from the RETRAIN.md scope. search is the
// exact string handed to searchteams.php; league is a sanity pin so a
// same-named team in some other competition cannot slip in.
const TRACKED = [
  { key: 'eagles', search: 'Philadelphia Eagles', league: 'NFL' },
  { key: 'sixers', search: 'Philadelphia 76ers', league: 'NBA' },
  { key: 'phillies', search: 'Philadelphia Phillies', league: 'MLB' },
  { key: 'flyers', search: 'Philadelphia Flyers', league: 'NHL' },
  { key: 'union', search: 'Philadelphia Union', league: 'American Major League Soccer' },
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
};

async function get(pathAndQuery) {
  const res = await fetch(`${BASE}/${API_KEY}/${pathAndQuery}`);
  if (!res.ok) throw new Error(`SportsDB ${res.status} on ${pathAndQuery}`);
  return res.json();
}

async function resolveTeam(t) {
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
    await sleep(250);
    try {
      const vd = await get(`lookupvenue.php?id=${encodeURIComponent(hit.idVenue)}`);
      const venue = (vd.venues || [])[0];
      const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(venue?.strMap || '');
      if (m) {
        stadiumLat = parseFloat(m[1]);
        stadiumLon = parseFloat(m[2]);
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

async function main() {
  if (!API_KEY) {
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

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const resolved = [];
    for (const t of TRACKED) {
      resolved.push(await resolveTeam(t));
      await sleep(250);
    }
    console.log('[ML:Sports] Teams resolved:');
    for (const t of resolved) {
      console.log(`  ${t.key}: ${t.teamId} (${t.league}), arena ${t.stadium} @ ${t.stadiumLat},${t.stadiumLon}`);
    }

    // One schedule pull per (league, season), filtered to tracked teams on
    // EITHER side, so shared leagues (two tracked teams meeting each other)
    // are fetched once and written once per team perspective.
    const byLeague = new Map();
    for (const t of resolved) {
      if (!byLeague.has(t.leagueId)) byLeague.set(t.leagueId, { league: t.league, teams: [] });
      byLeague.get(t.leagueId).teams.push(t);
    }

    let written = 0;
    for (const [leagueId, entry] of byLeague) {
      const seasons = seasonsArg
        ? seasonsArg.split('=')[1].split(',')
        : DEFAULT_SEASONS[entry.league] || [];
      for (const season of seasons) {
        const data = await get(`eventsseason.php?id=${leagueId}&s=${encodeURIComponent(season)}`);
        await sleep(250);
        const events = data.events || [];
        console.log(`[ML:Sports] ${entry.league} ${season}: ${events.length} league events fetched.`);
        for (const ev of events) {
          for (const t of entry.teams) {
            const isHome = ev.idHomeTeam === t.teamId;
            const isAway = ev.idAwayTeam === t.teamId;
            if (!isHome && !isAway) continue;
            const instant = eventInstant(ev);
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
                 raw_status = EXCLUDED.raw_status,
                 collected_at = NOW()`,
              [
                // Two tracked teams meeting each other is one event id; the
                // suffix keeps one row per team perspective without
                // inventing a second real event.
                `${ev.idEvent}:${t.key}`,
                entry.league,
                season,
                t.key,
                isHome,
                isHome ? ev.strAwayTeam : ev.strHomeTeam,
                instant,
                ev.dateEventLocal || ev.dateEvent || null,
                ev.strTimeLocal || ev.strTime || null,
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
    console.log(`[ML:Sports] Done. ${written} rows upserted this run; table holds ${rows[0].n} (${rows[0].lo} to ${rows[0].hi}).`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[ML:Sports] Fatal:', err.message);
  process.exitCode = 1;
});
