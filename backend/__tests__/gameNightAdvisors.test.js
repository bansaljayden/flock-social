// Run: node --test  (from backend/)
//
// ===========================================================================
// GAME NIGHTS IN BIRDIE AND ROOST, AS THE CARD STATES THEM: FACTS ONLY.
//
// The card has carried tonight's game since 2026-08-30 (services/gameNights.js,
// __tests__/gameNightFact.test.js): which tracked teams play, and the nearest
// home game's arena when it is within HOME_NEAR_KM of the venue. Never
// "busier": the sports ablation of that day found no crowd effect to stand
// behind. What this file pins:
//
//   * Birdie's get_crowd_prediction carries it as `game_night`, with the home
//     game only as close as the card names one, the schedule feed's strings
//     made prompt-safe, the key absent when there is no game, kept on a locked
//     result like the card keeps it, and a rule telling Birdie never to read a
//     crowd effect into it;
//   * Roost's Around you card carries it as one fact dated with the market's
//     day, source 'events', with a note that it measures nothing, the arena
//     name made safe like a listing title, and no fact when there is no game.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

process.env.JWT_SECRET = 'game-night-advisors-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
delete process.env.PAYWALL_ENABLED;
delete process.env.TICKETMASTER_API_KEY;

const { pinClock } = require('./helpers/pinnedClock');
const pinnedClock = pinClock(Date.UTC(2026, 9, 14, 22, 0, 0));
test.after(() => pinnedClock.restore());

const pool = require('../config/database');
pool.query = async () => ({ rows: [], rowCount: 0 });

const weatherService = require('../services/weatherService');
weatherService.getWeather = async () => ({ temp: 61, conditions: 'clear sky', humidity: 40, windSpeed: 3, isRaining: false, conditionId: 800, fetchedAt: Date.now() });
weatherService.getHourlyForecast = async () => null;
weatherService.getForecast = async () => [];

const gameNights = require('../services/gameNights');
let GAME = null;
gameNights.gameNightFor = async () => GAME;

const crowdEngine = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');
mlPredictor.predictBusyness = async () => ({
  score: 40, label: crowdEngine.getLabel(40), confidence: 60, factors: {},
  dataSourcesUsed: ['ml_model'], predictionMethod: 'ml', modelVersion: 'game-night-test',
});
mlPredictor.predictHourlyForecast = async (_v, _w, startHour, count) =>
  Array.from({ length: count || 12 }, (_, i) => {
    const h = (startHour + i) % 24;
    const display = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return {
      hour: `${display} ${h >= 12 ? 'PM' : 'AM'}`, score: 40, label: crowdEngine.getLabel(40),
      predictionMethod: 'ml', baselineScore: 40,
    };
  });

const realFetch = global.fetch;
const PLACES_PREFIX = 'https://places.googleapis.com/v1/places/';
global.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith(PLACES_PREFIX)) {
    const id = decodeURIComponent(u.slice(PLACES_PREFIX.length).split('?')[0]);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        id,
        displayName: { text: 'The Game Bar' },
        formattedAddress: '1 Test St',
        rating: 4.4,
        userRatingCount: 300,
        priceLevel: 'PRICE_LEVEL_MODERATE',
        types: ['bar'],
        location: { latitude: 39.95, longitude: -75.16 },
        currentOpeningHours: { openNow: true, periods: [{ open: { day: 0, hour: 0, minute: 0 } }] },
        utcOffsetMinutes: -240,
        timeZone: { id: 'America/New_York' },
      }),
    });
  }
  return realFetch(url, opts);
};
test.after(() => { global.fetch = realFetch; pool.end?.().catch(() => {}); });
void http;

const aiRouter = require('../routes/ai');
const { executeTool, buildSystemPrompt } = aiRouter.__testables;
const placeDetailsCache = require('../services/placeDetailsCache');
const { __resetPlacesBudget } = require('../utils/placesBudget');
const advisorFacts = require('../services/advisorFacts');

let seq = 0;
const freshId = () => `ChIJgamenight${String(++seq).padStart(5, '0')}`;

test.beforeEach(() => {
  GAME = null;
  __resetPlacesBudget();
  placeDetailsCache.__test.reset();
});

const NEAR = { teams: ['Eagles', 'Sixers'], homeGame: { team: 'Eagles', venueName: 'Lincoln Financial Field', distanceKm: 3.2 } };
const FAR = { teams: ['Flyers'], homeGame: { team: 'Flyers', venueName: 'Wells Fargo Center', distanceKm: 24.5 } };
const BUSY_WORDS = /busier|busy|packed|crowd|quieter|fill|empt/i;

// ── Birdie ───────────────────────────────────────────────────────────────────

test('Birdie gets tonight\'s game as the card states it, the home game only when near', async () => {
  GAME = NEAR;
  const near = await executeTool('get_crowd_prediction', { place_id: freshId() }, 5501, { includeForecast: true });
  assert.deepStrictEqual(near.game_night, {
    teams: ['Eagles', 'Sixers'],
    home_game: { team: 'Eagles', venue_name: 'Lincoln Financial Field', distance_km: 3.2 },
  });
  GAME = FAR;
  const far = await executeTool('get_crowd_prediction', { place_id: freshId() }, 5502, { includeForecast: true });
  assert.deepStrictEqual(far.game_night, { teams: ['Flyers'], home_game: null },
    'past HOME_NEAR_KM the card names no arena, so Birdie is handed none');
  // The game moves no number.
  assert.strictEqual(near.crowd_score, far.crowd_score);
});

test('no game, no key: every other result keeps exactly its keys', async () => {
  GAME = null;
  const plain = await executeTool('get_crowd_prediction', { place_id: freshId() }, 5503, { includeForecast: true });
  assert.ok(!('game_night' in plain));
  GAME = { teams: [], homeGame: null };
  const empty = await executeTool('get_crowd_prediction', { place_id: freshId() }, 5504, { includeForecast: true });
  assert.ok(!('game_night' in empty));
});

test('the schedule feed\'s strings reach the prompt flattened and bounded', async () => {
  GAME = {
    teams: ['Eagles‮'],
    homeGame: { team: 'Eagles', venueName: `Lincoln\nFinancial​ Field ${'x'.repeat(400)}`, distanceKm: 1 },
  };
  const out = await executeTool('get_crowd_prediction', { place_id: freshId() }, 5505, { includeForecast: true });
  assert.deepStrictEqual(out.game_night.teams, ['Eagles']);
  assert.ok(!/[\n​‮]/.test(out.game_night.home_game.venue_name));
  assert.ok(out.game_night.home_game.venue_name.startsWith('Lincoln Financial Field'));
  assert.ok(out.game_night.home_game.venue_name.length <= 120);
});

test('a locked result keeps the game, as the locked card does', async () => {
  GAME = NEAR;
  const locked = await executeTool('get_crowd_prediction', { place_id: freshId() }, 5506, { includeForecast: false });
  assert.strictEqual(locked.forecast_locked, true);
  assert.ok(!('crowd_score' in locked));
  assert.deepStrictEqual(locked.game_night.teams, ['Eagles', 'Sixers']);
});

test('Birdie is told the game is a schedule fact and never a crowd effect', () => {
  const prompt = buildSystemPrompt('Jay', {}, { ageBracket: 'adult' });
  const rule = prompt.split('\n').find((l) => l.includes('`game_night`'));
  assert.ok(rule, 'the rule for game_night is in the prompt');
  assert.match(rule, /Never say or imply that the game makes the venue busier/);
  assert.match(rule, /no crowd effect from games has been measured/);
});

// ── Roost ────────────────────────────────────────────────────────────────────

const NOW = new Date(Date.UTC(2026, 9, 14, 22, 0, 0));
function ctx() {
  return {
    mlVenue: { latitude: 39.95, longitude: -75.16, timezone: 'America/New_York' },
    profile: { google_place_id: 'ChIJroostgame', anchor_types: null, anchor_note: null },
  };
}

test('Roost\'s Around you card states tonight\'s game as one dated events fact', async () => {
  GAME = NEAR;
  const facts = await advisorFacts.buildAroundYou(ctx(), { now: NOW });
  const games = facts.filter((f) => typeof f.id === 'string' && f.id.startsWith('game_night_'));
  assert.strictEqual(games.length, 1);
  const g = games[0];
  assert.strictEqual(g.id, 'game_night_2026-10-14', 'dated with the market\'s own day');
  assert.strictEqual(g.source, 'events');
  assert.deepStrictEqual(g.value, {
    date: '2026-10-14',
    teams: ['Eagles', 'Sixers'],
    homeGame: { team: 'Eagles', venueName: 'Lincoln Financial Field', distanceKm: 3.2 },
  });
  assert.strictEqual(g.label, 'Tonight: Eagles home game at Lincoln Financial Field, about 3.2 km from you.');
  assert.match(g.note, /no crowd effect/);
  assert.ok(!BUSY_WORDS.test(g.label), 'the label states a schedule, never a crowd');
});

test('a far home game names the teams and no arena; no game is no fact', async () => {
  GAME = FAR;
  const far = (await advisorFacts.buildAroundYou(ctx(), { now: NOW })).find((f) => String(f.id).startsWith('game_night_'));
  assert.strictEqual(far.label, 'Tonight: Flyers play.', 'worded as the card words it');
  assert.strictEqual(far.value.homeGame, null);
  GAME = { teams: ['Eagles', 'Sixers', 'Flyers'], homeGame: null };
  const three = (await advisorFacts.buildAroundYou(ctx(), { now: NOW })).find((f) => String(f.id).startsWith('game_night_'));
  assert.strictEqual(three.label, 'Tonight: Eagles, Sixers and Flyers play.');
  GAME = null;
  const none = await advisorFacts.buildAroundYou(ctx(), { now: NOW });
  assert.ok(!none.some((f) => String(f.id).startsWith('game_night_')));
});

test('the arena name is made safe like a listing title, and a throwing read is no fact', async () => {
  GAME = { teams: ['Union'], homeGame: { team: 'Union', venueName: 'Subaru {Park}‮', distanceKm: 2 } };
  const g = (await advisorFacts.buildAroundYou(ctx(), { now: NOW })).find((f) => String(f.id).startsWith('game_night_'));
  assert.ok(!/[{}‮]/.test(g.value.homeGame.venueName));
  assert.ok(!/[{}‮]/.test(g.label));
  gameNights.gameNightFor = async () => { throw new Error('schedule down'); };
  try {
    const facts = await advisorFacts.buildAroundYou(ctx(), { now: NOW });
    assert.ok(!facts.some((f) => String(f.id).startsWith('game_night_')));
  } finally {
    gameNights.gameNightFor = async () => GAME;
  }
});
