// ---------------------------------------------------------------------------
// GAME-NIGHT FACTS FOR THE CROWD CARD (2026-08-30)
// ---------------------------------------------------------------------------
// Facts only, by measured decision. The sports ablation
// (scripts/ml/train/sports_ablation.py, same date) found no crowd lift the
// model could stand behind: within-10 flat, MAE slightly WORSE with the
// game-night features, worse still on game nights themselves. So nothing
// here ever says "busier". It says a tracked team plays tonight, and where,
// and stops; the reader draws their own inference. Jayden's call, same day:
// the fact alone is worth surfacing, and it is the reason the SportsDB
// subscription stays.
//
// Market-gated at the same 60km the training features used: the schedule
// describes the Philadelphia and Lehigh Valley market, so venues beyond it
// never carry the line. "Tonight" is the market's own calendar day
// (America/New_York), not UTC's, for the same reason every date in this
// pipeline is venue-local: at 11 PM Eastern, UTC is already tomorrow.
//
// In-memory caches, single-instance by deployment (see the replica warning
// in CLAUDE.md): today's games for 15 minutes, the arena set for 12 hours.
// Every failure path returns null. The crowd card owes nothing to this
// garnish, and a database blip must cost the line, never the card.
// ---------------------------------------------------------------------------

const pool = require('../config/database');

const MARKET_KM = 60;
const HOME_NEAR_KM = 10;
const GAMES_CACHE_MS = 15 * 60 * 1000;
// A game stops being "tonight" once it is plausibly over: start plus four
// hours covers every league we track, extra innings included. Canceled and
// postponed games never count at all (Codex review, 2026-09-01: a date-only
// query kept a 1 PM final on the card until midnight).
const GAME_OVER_MS = 4 * 60 * 60 * 1000;
const ARENAS_CACHE_MS = 12 * 60 * 60 * 1000;

// team_key (ml_sports_events) to the name a card prints.
const TEAM_NAMES = {
  eagles: 'Eagles',
  sixers: 'Sixers',
  phillies: 'Phillies',
  flyers: 'Flyers',
  union: 'Union',
  lehigh_fb: 'Lehigh',
  lafayette_fb: 'Lafayette',
};

let gamesCache = { date: null, rows: [], at: 0 };
let arenasCache = { arenas: [], at: 0 };

function easternDate(now) {
  // en-CA renders YYYY-MM-DD, which matches event_local_date's ::text form.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
}

function kmBetween(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function arenaSet() {
  const fresh = Date.now() - arenasCache.at < ARENAS_CACHE_MS;
  if (fresh && arenasCache.arenas.length) return arenasCache.arenas;
  const { rows } = await pool.query(
    `SELECT DISTINCT venue_lat, venue_lon FROM ml_sports_events
      WHERE is_home = true AND venue_lat IS NOT NULL AND venue_lon IS NOT NULL`
  );
  arenasCache = { arenas: rows.map((r) => [Number(r.venue_lat), Number(r.venue_lon)]), at: Date.now() };
  return arenasCache.arenas;
}

async function gamesForToday(now) {
  const date = easternDate(now);
  if (gamesCache.date === date && Date.now() - gamesCache.at < GAMES_CACHE_MS) {
    return gamesCache.rows;
  }
  const { rows } = await pool.query(
    `SELECT team_key, is_home, venue_name, venue_lat, venue_lon, event_utc, raw_status
       FROM ml_sports_events
      WHERE event_local_date = $1`,
    [date]
  );
  gamesCache = { date, rows, at: Date.now() };
  return rows;
}

// The one export the card uses: null, or
//   { teams: ['Sixers', 'Flyers'],
//     homeGame: { team, venueName, distanceKm } | null }
// homeGame names the NEAREST home game's arena when one is in the market;
// the caller decides how close is close enough to mention.
async function gameNightFor(lat, lon, now = new Date()) {
  try {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const all = await gamesForToday(now);
    // Time and status filtering happens HERE, per call, never in the cache:
    // the cache is keyed by date and lives 15 minutes, and "is this game
    // over yet" changes inside that window.
    const games = all.filter((g) => {
      if (/cancel|postpon/i.test(String(g.raw_status || ''))) return false;
      if (g.event_utc) {
        const t = new Date(g.event_utc).getTime();
        if (Number.isFinite(t) && now.getTime() > t + GAME_OVER_MS) return false;
      }
      return true;
    });
    if (!games.length) return null;

    const arenas = await arenaSet();
    if (!arenas.length) return null;
    const inMarket = arenas.some(([alat, alon]) => kmBetween(lat, lon, alat, alon) <= MARKET_KM);
    if (!inMarket) return null;

    const teams = [];
    for (const g of games) {
      const name = TEAM_NAMES[g.team_key] || null;
      if (name && !teams.includes(name)) teams.push(name);
    }
    if (!teams.length) return null;

    let homeGame = null;
    for (const g of games) {
      if (!g.is_home || g.venue_lat == null || g.venue_lon == null) continue;
      const d = kmBetween(lat, lon, Number(g.venue_lat), Number(g.venue_lon));
      if (d <= MARKET_KM && (!homeGame || d < homeGame.distanceKm)) {
        homeGame = {
          team: TEAM_NAMES[g.team_key] || 'Home team',
          venueName: g.venue_name || null,
          distanceKm: Math.round(d * 10) / 10,
        };
      }
    }

    return { teams, homeGame };
  } catch (err) {
    // A garnish, never a dependency: the card ships without the line.
    return null;
  }
}

module.exports = { gameNightFor, HOME_NEAR_KM };
module.exports.__test = {
  reset() {
    gamesCache = { date: null, rows: [], at: 0 };
    arenasCache = { arenas: [], at: 0 };
  },
};
