// Run: node --test  (from backend/)
//
// THE GAME-NIGHT LINE IS A FACT, NEVER A CROWD CLAIM.
//
// The 2026-08-30 sports ablation measured the game-night features against
// the frozen corpus and found no lift the model could stand behind, so the
// product decision (Jayden's, same day) is a schedule FACT on the crowd
// card: who plays tonight, and where, and nothing else. Pinned here:
//   1. The service is market-gated at the same 60km the training features
//      used: a venue outside the Philadelphia and Lehigh Valley market
//      never carries the line.
//   2. "Tonight" is the market's calendar day (America/New_York), not UTC's.
//   3. Every failure path returns null. The card owes nothing to a garnish.
//   4. Neither the service nor the chip copy ever says "busier": the word
//      the ablation refused to license.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pool = require('../config/database');

let queries = [];
let gamesRows = [];
let arenaRows = [];
pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  queries.push({ sql, params });
  if (sql.includes('SELECT DISTINCT venue_lat')) return { rows: arenaRows };
  if (sql.includes('WHERE event_local_date = $1')) return { rows: gamesRows };
  return { rows: [] };
};

const gameNights = require('../services/gameNights');

const XFINITY = { lat: 39.901111, lon: -75.171944 };

function resetWorld() {
  queries = [];
  gameNights.__test.reset();
  arenaRows = [
    { venue_lat: XFINITY.lat, venue_lon: XFINITY.lon },
    { venue_lat: 39.905833, venue_lon: -75.166389 },
  ];
  const upcoming = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
  gamesRows = [
    { team_key: 'sixers', is_home: true, venue_name: 'Xfinity Mobile Arena', venue_lat: XFINITY.lat, venue_lon: XFINITY.lon, event_utc: upcoming, raw_status: 'NS' },
    { team_key: 'flyers', is_home: false, venue_name: null, venue_lat: null, venue_lon: null, event_utc: upcoming, raw_status: 'NS' },
  ];
}

test('a Philadelphia venue on a game day carries the fact, nearest home game named', async () => {
  resetWorld();
  const r = await gameNights.gameNightFor(39.9526, -75.1652);
  assert.ok(r, 'in-market venue on a game day must carry the line');
  assert.deepStrictEqual(r.teams, ['Sixers', 'Flyers']);
  assert.strictEqual(r.homeGame.team, 'Sixers');
  assert.strictEqual(r.homeGame.venueName, 'Xfinity Mobile Arena');
  assert.ok(r.homeGame.distanceKm > 0 && r.homeGame.distanceKm < 10,
    `downtown Philadelphia is a few km from the arena, got ${r.homeGame.distanceKm}`);
});

test('a Tokyo venue never carries the line, whatever the schedule says', async () => {
  resetWorld();
  const r = await gameNights.gameNightFor(35.6762, 139.6503);
  assert.strictEqual(r, null, 'the market gate is the same 60km the training features used');
});

test('a game that ended hours ago is not tonight', async () => {
  // Codex review, 2026-09-01: the date-only query kept a 1 PM final on the
  // card until midnight. Start plus four hours is the over line.
  resetWorld();
  gamesRows = [{
    team_key: 'phillies', is_home: false, venue_name: null, venue_lat: null, venue_lon: null,
    event_utc: new Date(Date.now() - 9 * 3600 * 1000).toISOString(), raw_status: 'FT',
  }];
  const r = await gameNights.gameNightFor(39.9526, -75.1652);
  assert.strictEqual(r, null, 'an afternoon final must not read as play tonight at 10 PM');
});

test('a canceled or postponed game never counts', async () => {
  resetWorld();
  gamesRows = [{
    team_key: 'sixers', is_home: true, venue_name: 'Xfinity Mobile Arena', venue_lat: XFINITY.lat, venue_lon: XFINITY.lon,
    event_utc: new Date(Date.now() + 3 * 3600 * 1000).toISOString(), raw_status: 'Postponed',
  }];
  const r = await gameNights.gameNightFor(39.9526, -75.1652);
  assert.strictEqual(r, null);
});

test('a game with no recorded instant stays visible rather than guessed away', async () => {
  resetWorld();
  gamesRows = [{
    team_key: 'union', is_home: false, venue_name: null, venue_lat: null, venue_lon: null,
    event_utc: null, raw_status: null,
  }];
  const r = await gameNights.gameNightFor(39.9526, -75.1652);
  assert.ok(r && r.teams.includes('Union'), 'no instant means include, never invent an end time');
});

test('no games today means null, not an empty object', async () => {
  resetWorld();
  gamesRows = [];
  const r = await gameNights.gameNightFor(39.9526, -75.1652);
  assert.strictEqual(r, null);
});

test('a database failure costs the line, never the card', async () => {
  resetWorld();
  pool.query = async () => { throw new Error('database blip'); };
  const r = await gameNights.gameNightFor(39.9526, -75.1652);
  assert.strictEqual(r, null, 'the service must swallow its own failures');
  // Restore the stub for any test that follows.
  pool.query = async (text) => {
    const sql = String(text).replace(/\s+/g, ' ').trim();
    if (sql.includes('SELECT DISTINCT venue_lat')) return { rows: arenaRows };
    if (sql.includes('WHERE event_local_date = $1')) return { rows: gamesRows };
    return { rows: [] };
  };
});

test('bad coordinates mean null before any query runs', async () => {
  resetWorld();
  const r = await gameNights.gameNightFor(undefined, null);
  assert.strictEqual(r, null);
  assert.strictEqual(queries.length, 0, 'no coordinates, no database work');
});

// ---------------------------------------------------------------------------
// Source pins.
// ---------------------------------------------------------------------------
const SERVICE = fs.readFileSync(path.join(__dirname, '..', 'services', 'gameNights.js'), 'utf8');
const CROWD = fs.readFileSync(path.join(__dirname, '..', 'routes', 'crowd.js'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'App.js'), 'utf8');

test('tonight is the market calendar day, not UTC', () => {
  assert.match(SERVICE, /timeZone: 'America\/New_York'/,
    'at 11 PM Eastern, UTC is already tomorrow; the market decides what tonight means');
});

test('the crowd response carries the fact and the route treats it as a garnish', () => {
  assert.match(CROWD, /gameNight: gameNight \|\| null,/);
  assert.match(CROWD, /never a crowd claim/,
    'the route records WHY this is a fact, so the ablation decision travels with the code');
});

test('nobody says busier, the word the ablation refused to license', () => {
  // Comments may NAME the banned word to explain the rule; only code and
  // copy can break it. Same convention as the no-BestTime pin.
  const codeOnly = SERVICE.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/busier/i.test(codeOnly), 'the service states facts');
  const i = APP.indexOf('cd?.gameNight?.teams');
  assert.ok(i !== -1, 'the chip exists in the venue sheet');
  const chip = APP.slice(Math.max(0, i - 800), i + 1200);
  assert.ok(!/busier/i.test(chip), 'the chip states who plays and where and stops');
  assert.match(chip, /play tonight/, 'the fact wording');
  assert.match(chip, /home game tonight at/, 'the near-arena variant names the arena');
});
