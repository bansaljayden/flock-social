const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { GoogleGenAI } = require('@google/genai');
const pool = require('../config/database');
const { getWeather } = require('../services/weatherService');
const {
  findBestTime,
  findPeakTime,
  getLabel,
  // Round 15: venue-clock scoring, same as routes/crowd.js.
  venueLocalNow,
  weekdayOffset,
} = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');
const { isPremium, paywallEnabled } = require('../services/entitlements');
const { allowPlacesSearch } = require('../utils/placesBudget');
const { upstreamSignal } = require('../utils/upstream');
const {
  checkUserRateLimit,
  nextUtcMidnightISO,
  PREMIUM_DAILY_LIMIT,
  FREE_DAILY_LIMIT,
  // The spend ledger. The turn meter above counts MESSAGES, which is the
  // product limit; these count TOKENS per Gemini call, which is the money.
  // services/birdieUsage.js explains at length why one is not the other.
  estimateGeminiTokens,
  allowGeminiCall,
  settleGeminiCall,
} = require('../services/birdieUsage');

const router = express.Router();
const PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

// ---------------------------------------------------------------------------
// Gemini client (unified @google/genai SDK — the old @google/generative-ai
// package was deprecated 2025-11-30 and never gets 3.x models).
// Model is env-switchable from Railway without a deploy: BIRDIE_MODEL.
// Default gemini-3.5-flash-lite (current-gen, built for fast tool loops,
// free tier). Fallback if its quota ever pinches: gemini-2.5-flash-lite
// (most generous free RPD) — one env var flip.
// ---------------------------------------------------------------------------
const BIRDIE_MODEL = process.env.BIRDIE_MODEL || 'gemini-3.5-flash-lite';
// Wall-clock ceiling for one chat turn. The per-call deadline
// (UPSTREAM_TIMEOUT_MS.gemini) bounds a single round trip, but a turn is up to
// six of them plus the tool work in between, so the worst case is their sum.
// This bounds the whole turn instead: past it the tool loop stops asking for
// another round and answers with what it has.
const BIRDIE_TURN_BUDGET_MS = 45_000;
let genAIClient = null;
function getGenAI() {
  if (!genAIClient && process.env.GEMINI_API_KEY) {
    genAIClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return genAIClient;
}

// ---------------------------------------------------------------------------
// Per-user rate limiting — moved to services/birdieUsage.js (shared with
// entitlements). 150/day premium (or paywall off), 10/day free tier, 15/min all.
//
// That meter counts TURNS. Gemini bills TOKENS, and one turn is up to six calls
// (the tool loop below) of a size the caller chooses, each of which may buy a
// retry. The token ledger in the same module is what bounds the invoice; this
// file's job is to charge it before EVERY chat.sendMessage and to true it up
// afterwards. See __tests__/geminiSpendLedger.test.js.
// ---------------------------------------------------------------------------

// A refusal from the spend ledger, distinguishable from a vendor error so the
// retry path never treats it as transient and the tool loop can stop cleanly
// instead of 500ing. Never retried: a refusal is not a failure to fix, it is the
// ceiling doing its job, and retrying it would be a second charge attempt for a
// call we already decided not to make.
class GeminiBudgetError extends Error {
  constructor() {
    super('Gemini spend ceiling reached');
    this.name = 'GeminiBudgetError';
    this.geminiBudget = true;
    // 429 is what this condition IS, and saying so out loud is what makes the
    // `geminiBudget` check in the retry path load-bearing rather than
    // decorative. Without a status, this error happened not to match the
    // transient test below — but only because its MESSAGE happened not to
    // contain "quota" or "unavailable", which is a property of a sentence, not
    // a design. Anything that reaches the route's outer catch with status 429
    // is answered as a 429, so if a future refactor ever drops the explicit
    // handling, the fallback is still the right answer instead of a 500.
    this.status = 429;
  }
}

// What Birdie says when the ledger stops a turn. Same register as the other
// refusals in this file, and deliberately not an apology for being down — the
// system prompt forbids that voice and the user is reading this sentence, not
// the model.
const BIRDIE_BUSY_MESSAGE = 'lot of chatter right now. hit me again in a bit';

// How many characters a payload puts on the wire. The SDK holds no server-side
// session, so the WHOLE conversation is re-sent on every call; the caller of
// this adds the result to a running total rather than measuring one message.
//
// An unserializable payload is charged as if it were huge. Failing expensive is
// the only safe direction for a spending control: a payload we cannot measure
// must not be a payload that costs nothing.
const UNMEASURABLE_PAYLOAD_CHARS = 400_000;
function payloadChars(payload) {
  if (typeof payload === 'string') return payload.length;
  try {
    const s = JSON.stringify(payload);
    return typeof s === 'string' ? s.length : UNMEASURABLE_PAYLOAD_CHARS;
  } catch {
    return UNMEASURABLE_PAYLOAD_CHARS;
  }
}

// What came back also becomes part of the next call's prompt, so it is measured
// the same way. Tool-call arguments count as well as text — a model that emits
// six function calls has grown the conversation just as surely as one that
// wrote six paragraphs.
function responseChars(resp) {
  try {
    const s = JSON.stringify(resp?.candidates?.[0]?.content ?? '');
    return typeof s === 'string' ? s.length : 0;
  } catch {
    return 0;
  }
}

// The SDK reports real usage on the response. Shape has moved between SDK
// versions, so read the total defensively and treat an absent one as "no
// information" rather than as zero — settleGeminiCall ignores a non-finite
// value, which leaves the pre-call estimate standing.
function reportedTokens(resp) {
  const u = resp?.usageMetadata;
  if (!u) return null;
  const total = u.totalTokenCount ?? u.totalTokens;
  return Number.isFinite(total) ? total : null;
}

// ---------------------------------------------------------------------------
// Tool definitions for Gemini
// ---------------------------------------------------------------------------
const toolDeclarations = [
  {
    name: 'search_venues',
    description: 'Search for nearby venues/restaurants/bars/cafes by keyword and optional location. Returns name, address, rating, price level, and whether it is currently open.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Search query, e.g. "bars near me", "pizza", "fun things to do"' },
        location: { type: 'STRING', description: 'Lat,lng string e.g. "40.7128,-74.0060". Use the user\'s location if available.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_crowd_prediction',
    description: 'Get the current crowd level, hourly forecast, best time to visit, and peak hours for a specific venue. Use this when the user asks about how busy a place is or when to go.',
    parameters: {
      type: 'OBJECT',
      properties: {
        place_id: { type: 'STRING', description: 'Google Places ID of the venue' },
        venue_name: { type: 'STRING', description: 'Name of the venue (for display)' },
      },
      required: ['place_id'],
    },
  },
  {
    name: 'get_user_flocks',
    description: 'Get the user\'s active flocks/plans including members, venue, date, time, and status.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'get_user_friends',
    description: 'Get the user\'s friends list.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'get_weather',
    description: 'Get current weather for a location.',
    parameters: {
      type: 'OBJECT',
      properties: {
        lat: { type: 'NUMBER', description: 'Latitude' },
        lng: { type: 'NUMBER', description: 'Longitude' },
      },
      required: ['lat', 'lng'],
    },
  },
  {
    name: 'navigate_app',
    description: 'Navigate the user to a specific screen or tab in the Flock app. Use this when the user asks how to do something, where to find a feature, or wants to go somewhere in the app.',
    parameters: {
      type: 'OBJECT',
      properties: {
        tab: {
          type: 'STRING',
          description: 'The tab to switch to: "home", "explore", "chats", "calendar", "profile"',
          enum: ['home', 'explore', 'chats', 'calendar', 'profile'],
        },
        screen: {
          type: 'STRING',
          description: 'The screen to navigate to: "create" (create a flock), "addFriends" (add friends), "profile" (profile/settings). Leave empty to just switch tabs.',
          enum: ['create', 'addFriends', 'profile'],
        },
        profile_section: {
          type: 'STRING',
          description: 'If navigating to profile, which section to open: "safety" (trusted contacts/SOS), "payment" (payment methods), "edit" (edit profile)',
          enum: ['safety', 'payment', 'edit'],
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------
function priceLevelToNum(priceLevel) {
  const map = {
    'PRICE_LEVEL_FREE': 0,
    'PRICE_LEVEL_INEXPENSIVE': 1,
    'PRICE_LEVEL_MODERATE': 2,
    'PRICE_LEVEL_EXPENSIVE': 3,
    'PRICE_LEVEL_VERY_EXPENSIVE': 4,
  };
  return map[priceLevel] ?? null;
}

async function executeTool(toolName, toolInput, userId, opts = {}) {
  switch (toolName) {
    case 'search_venues': {
      if (!PLACES_API_KEY) return { error: 'Google Places API not configured' };
      // Birdie was a complete bypass of every Places cost control: the tool
      // loop runs up to 5 iterations and executes every call the model emits,
      // so one free account could drive thousands of PAID Places calls a day
      // (round 12). Same shared budget as the rest of the app.
      if (!allowPlacesSearch(userId)) {
        return { error: 'Too many venue lookups right now. Ask again in a little while.' };
      }
      const searchBody = { textQuery: toolInput.query, maxResultCount: 8 };
      if (toolInput.location) {
        const [lat, lng] = toolInput.location.split(',').map(Number);
        searchBody.locationBias = {
          circle: { center: { latitude: lat, longitude: lng }, radius: 15000.0 },
        };
      }
      // Birdie's tool loop is the one place Places was still called without a
      // timeout, so a Places brownout parked an Express connection for undici's
      // ~5 minute default. A user can steer the model into calling this
      // repeatedly, which makes it a cheap way to exhaust the server.
      const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
        signal: upstreamSignal('places'),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': PLACES_API_KEY,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.priceLevel,places.types,places.currentOpeningHours,places.location,places.photos',
        },
        body: JSON.stringify(searchBody),
      });
      const data = await resp.json();
      const venues = (data.places || []).map(p => ({
        place_id: p.id,
        name: p.displayName?.text || '',
        address: p.formattedAddress || '',
        rating: p.rating || null,
        reviews: p.userRatingCount || 0,
        price_level: priceLevelToNum(p.priceLevel),
        types: (p.types || []).slice(0, 3),
        is_open: p.currentOpeningHours?.openNow ?? null,
        lat: p.location?.latitude,
        lng: p.location?.longitude,
        photo_url: p.photos?.[0]?.name ? `/api/venues/photo?ref=${encodeURIComponent(p.photos[0].name)}&maxwidth=400` : null,
      }));
      return { venues };
    }

    case 'get_crowd_prediction': {
      // Same ML path as GET /api/crowd — Birdie must quote the numbers the
      // Discover screen shows, not a parallel rule-engine estimate.
      if (!PLACES_API_KEY) return { error: 'Google Places API not configured' };
      // Paid Place Details call, same budget as search above (round 12).
      if (!allowPlacesSearch(userId)) {
        return { error: 'Too many venue lookups right now. Ask again in a little while.' };
      }
      const placeId = toolInput.place_id;
      const resp = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
        signal: upstreamSignal('places'),
        headers: {
          'X-Goog-Api-Key': PLACES_API_KEY,
          // Round 15: utcOffsetMinutes so Birdie scores on the venue's clock
          // (see below), same field mask intent as routes/crowd.js.
          'X-Goog-FieldMask': 'id,displayName,formattedAddress,rating,userRatingCount,priceLevel,types,location,currentOpeningHours,utcOffsetMinutes',
        },
      });
      const p = await resp.json();
      if (p.error) return { error: 'Venue not found' };

      // WHOSE CLOCK: the VENUE's, not Railway's UTC and not the caller's phone.
      // Same contract as /api/crowd. The caller's localHour/localDay start as
      // the fallback, but when Google gives us the venue's offset we score on
      // the venue's wall clock. Round 15: this used the caller's localHour with
      // no offset and a raw `localDay - getDay()` day shift (the signed-diff bug
      // weekdayOffset fixes), so the holiday/event features could land on the
      // wrong date.
      const now = new Date();
      let localHour = Number.isInteger(opts.localHour) ? opts.localHour : now.getHours();
      let localDay = Number.isInteger(opts.localDay) ? opts.localDay : now.getDay();
      const venueClock = venueLocalNow(p.utcOffsetMinutes, now);
      if (venueClock) {
        localHour = venueClock.hour;
        localDay = venueClock.day;
      }
      const scoreTime = new Date(now);
      scoreTime.setDate(scoreTime.getDate() + weekdayOffset(scoreTime.getDay(), localDay));
      scoreTime.setHours(localHour, 0, 0, 0);

      let openHour = null, closeHour = null;
      const periods = p.currentOpeningHours?.periods;
      if (periods) {
        const todayPeriod = periods.find(pd => pd.open?.day === localDay);
        if (todayPeriod) {
          openHour = todayPeriod.open?.hour ?? null;
          closeHour = todayPeriod.close?.hour ?? null;
          if (closeHour === 0) closeHour = 24;
        }
      }

      const venue = {
        place_id: p.id,
        name: p.displayName?.text || '',
        rating: p.rating || null,
        user_ratings_total: p.userRatingCount || 0,
        price_level: priceLevelToNum(p.priceLevel),
        types: p.types || [],
        location: p.location || null,
        isOpen: p.currentOpeningHours?.openNow ?? null,
        openHour,
        closeHour,
        // predictBusyness reads this for the Ticketmaster event window
        // (trueEventInstant); null -> the old caller-clock fallback.
        utcOffsetMinutes: p.utcOffsetMinutes != null ? p.utcOffsetMinutes : null,
      };

      const lat = venue.location?.latitude;
      const lon = venue.location?.longitude;
      const weather = (lat && lon) ? await getWeather(lat, lon) : null;

      const crowdResult = await mlPredictor.predictBusyness(venue, weather, scoreTime);
      // Round 13: forward-looking window (see crowdEngine.recommendBestTime).
      // Birdie must never suggest an hour that already passed, and its answer
      // has to agree with the score it quotes in the same sentence.
      const fullDay = await mlPredictor.predictHourlyForecast(venue, weather, localHour, 24, scoreTime);
      const next12 = fullDay.slice(0, 12);
      // Peak off the next 12 hours: the rush that is coming, not tomorrow's.
      // Indexes still line up with fullDay for the best-time exclusion.
      const peakResult = findPeakTime(next12, venue);
      const bestTime = findBestTime(fullDay, venue, peakResult.startIdx, peakResult.endIdx, venue.isOpen, {
        currentHour: localHour,
        currentScore: crowdResult.score,
      });

      const result = {
        venue_name: venue.name,
        crowd_score: crowdResult.score,
        crowd_label: getLabel(crowdResult.score),
        confidence: crowdResult.confidence,
        is_open: venue.isOpen,
        best_time: bestTime,
        peak_hours: peakResult.text,
        weather: weather ? { temp: weather.temp, conditions: weather.conditions } : null,
      };
      // Hour-by-hour forecasts are a Pro surface (forecast meter). Free-tier
      // users get now + best time + peak through Birdie, same as the app.
      if (opts.includeForecast) {
        // Same array the recommendation came from, so the two can't disagree.
        result.hourly_forecast = next12.map(h => ({ hour: h.hour, label: h.label, score: h.score }));
      } else {
        result.hourly_forecast_note = 'Hour-by-hour forecast is a Flock Pro feature; do not invent one.';
      }
      return result;
    }

    case 'get_user_flocks': {
      // Round 3: accepted flocks only (an invitee could pump the minimal
      // invite card for full data via Birdie), and member COUNT instead of
      // third parties' names — rosters stay out of the Gemini payload.
      const result = await pool.query(
        `SELECT f.id, f.name, f.venue_name, f.event_time, f.status,
                COUNT(*) FILTER (WHERE fm.status = 'accepted')::int AS member_count
         FROM flocks f
         JOIN flock_members fm ON fm.flock_id = f.id
         WHERE f.id IN (SELECT flock_id FROM flock_members WHERE user_id = $1 AND status = 'accepted')
           AND f.status IN ('active', 'confirmed')
         GROUP BY f.id
         ORDER BY f.event_time DESC NULLS LAST
         LIMIT 10`,
        [userId]
      );
      return { flocks: result.rows };
    }

    case 'get_user_friends': {
      const result = await pool.query(
        `SELECT u.id, u.name
         FROM friendships fr
         JOIN users u ON (u.id = CASE WHEN fr.requester_id = $1 THEN fr.addressee_id ELSE fr.requester_id END)
         WHERE (fr.requester_id = $1 OR fr.addressee_id = $1) AND fr.status = 'accepted'
         ORDER BY u.name
         LIMIT 50`,
        [userId]
      );
      return { friends: result.rows };
    }

    case 'get_weather': {
      // Coordinates here come from the model, which is steered by the user's
      // own prompt — the same enumeration shape as GET /api/weather, not a
      // venue-derived lookup. Charge the caller's per-user weather ceiling so
      // one account cannot walk lat/lng through Birdie and spend the global
      // daily allowance that every crowd score depends on.
      const weather = await getWeather(toolInput.lat, toolInput.lng, { userId });
      return weather || { error: 'Weather data unavailable' };
    }

    case 'navigate_app': {
      // This is handled client-side — we just pass the navigation intent back
      return { success: true, navigated: true, tab: toolInput.tab, screen: toolInput.screen, profile_section: toolInput.profile_section };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
function buildContextLine(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const parts = [];
  if (ctx.screen) parts.push(`screen=${ctx.screen}`);
  if (ctx.tab) parts.push(`tab=${ctx.tab}`);
  if (ctx.flock?.name) {
    const f = ctx.flock;
    let s = `viewing flock "${f.name}"`;
    if (f.venue) s += ` (venue: ${f.venue})`;
    if (f.status) s += ` [${f.status}]`;
    parts.push(s);
  }
  if (ctx.venue?.name) {
    const v = ctx.venue;
    let s = `looking at venue "${v.name}"`;
    if (v.place_id) s += ` (place_id: ${v.place_id})`;
    parts.push(s);
  }
  return parts.length ? `\n\nWHAT THE USER IS DOING RIGHT NOW (use this for "this place", "this flock", etc.):\n- ${parts.join('\n- ')}` : '';
}

function buildSystemPrompt(userName, ctx, { ageBracket, freeTier } = {}) {
  const ageLine = ageBracket === 'minor'
    ? `\n- The user is UNDER 18. Never recommend bars, clubs, nightlife, or anything alcohol-centric. Steer to all-ages spots: food, cafes, arcades, bowling, activities, events. Do this silently — no lectures, just good picks.`
    : ageBracket === 'under21'
      ? `\n- The user is under 21 (US drinking age). Skip bars and clubs unless they explicitly ask; favor restaurants, cafes, and activities.`
      : '';
  const tierLine = freeTier
    ? `\n- The user is on the free tier: 10 Birdie messages a day, and hour-by-hour crowd forecasts are a Flock Pro feature. If they want the full night hour by hour, you can mention Pro exists (150 Birdie messages a day + unlimited hour-by-hour forecasts + a heads-up push before a spot gets packed). Mention it at most once per conversation, never unprompted, and never promise anything beyond those three things.`
    : '';
  return `You are Birdie, the assistant inside Flock, a social coordination app for Gen Z. You help people figure out where to go, how busy it is, and get their group out the door.

Voice:
- Talk like a sharp friend who knows the city. Casual, short, confident.
- 1-3 sentences unless they ask for detail. No bullet-point essays in chat.
- Slang only where it lands naturally. At most one emoji, usually zero.
- Never use em dashes. Use periods or commas.
- Have opinions. "Hit Oakwood, it's chill till 9" beats a list of five options.

The user's name is ${userName}.${ageLine}${tierLine}

What you can actually do (tools):
- search_venues: find restaurants, cafes, bars, activities near them
- get_crowd_prediction: live crowd level, best time to go, peak hours for a venue. Powered by Flock's own crowd model, the same numbers the Discover screen shows.
- get_user_flocks: their plans (name, venue, time, status, member count)
- get_user_friends: their friends list
- get_weather: current weather
- navigate_app: take them straight to a screen

The app, as it ships today (use the user-facing names on the left; the tool enums in parentheses):
- **Nest** (tab: home) — home base: tonight's status, active flocks, invites waiting on them
- **Discover** (tab: explore) — map + venue search with live crowd levels; each venue page has the crowd dial, best time, and a one-tap "reality check" where people at the venue confirm how busy it really is
- **Plans** (tab: calendar) — calendar of upcoming flocks and events
- **Messages** (tab: chats) — flock group chats and DMs; both support photos, venue cards, voting on spots, pins, and live location sharing
- **You** (tab: profile) — profile, settings, payment methods, appearance
- **Create a flock** (screen: create) — name the night, pick a date, invite friends; they RSVP in one tap
- **Add friends** (screen: addFriends) — search, friend code, QR, phone contacts
- **Safety** (profile_section: safety) — trusted contacts and SOS: one tap sends their live location to their people
- Inside a flock: venue voting, anonymous budget matching (everyone types what they can spend; the group only ever sees the ceiling, never anyone's number, and only after 3+ people submit), bill splitting after (Venmo/Cash App/Zelle links, marked paid manually), and guest invite links that work for friends who don't have Flock yet

How to answer:
- "How do I..." or "where is..." → one-line answer, then USE navigate_app to take them there. Don't just describe the path.
- Vague asks ("what's the move", "where's poppin") → they want somewhere fun nearby. Search real categories (bars, food, activities), never the slang words themselves.
- Slang decoder: "the move" = what to do; "link"/"pull up" = meet up; "dead" = empty; "lit"/"poppin" = busy and fun; "lowkey" = quiet or casual; "bet" = ok; "no cap" = seriously.
- Crowds: translate numbers into advice. "68% and climbing, go now or wait till 11" beats reciting the data. Mention best time when it helps.
- If you have their coordinates, always pass location to search_venues. If not, ask where they are, once.

Hard rules:
- Never invent venue data, crowd numbers, or forecasts. Tools only. If a tool has no data, say you don't have a read on that spot.
- Never claim Flock has a feature that isn't in the list above. No "coming soon".
- Never reveal one user's info to another (budgets are anonymous by design; don't speculate about who submitted what).
- If someone mentions being unsafe, being followed, or an emergency: point them to Safety (SOS sends their live location to trusted contacts) and navigate them there. For real emergencies say to call 911.
- Never say "I'm broken", "I can't right now", or apologize for being down. If a tool errors, come at it from another angle or ask one clarifying question.${buildContextLine(ctx)}`;
}

// ---------------------------------------------------------------------------
// POST /api/ai/chat — Main chat endpoint (Gemini with function calling)
// ---------------------------------------------------------------------------
router.use(authenticate);

router.post('/chat',
  [
    // Bounded: without caps, the 1MB JSON limit was the effective prompt
    // ceiling, and each accepted request can fan out into 6 Gemini calls.
    body('messages').isArray({ min: 1, max: 24 }).withMessage('messages array is required'),
    body('messages.*.text').optional().isString().isLength({ max: 4000 }).withMessage('Message too long'),
    body('location').optional(),
    // Bounded: this is interpolated into the system prompt, so unbounded
    // strings were a 1MB context bypass around the message caps (round 6).
    body('currentContext').optional().isObject(),
    body('currentContext.screen').optional().isString().isLength({ max: 40 }),
    body('currentContext.tab').optional().isString().isLength({ max: 40 }),
    body('currentContext.flock.name').optional().isString().isLength({ max: 120 }),
    body('currentContext.flock.venue').optional().isString().isLength({ max: 120 }),
    body('currentContext.flock.status').optional().isString().isLength({ max: 40 }),
    body('currentContext.venue.name').optional().isString().isLength({ max: 120 }),
    body('currentContext.venue.place_id').optional().isString().isLength({ max: 200 }),
    body('localHour').optional().isInt({ min: 0, max: 23 }),
    body('localDay').optional().isInt({ min: 0, max: 6 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const genAI = getGenAI();
      if (!genAI) {
        return res.status(500).json({ error: 'hold up, gimme a sec' });
      }

      const { messages, location, currentContext } = req.body;
      const userId = req.user.id;

      // The turn has to HAVE a message. `messages.*.text` is optional in the
      // validator above, so `{ messages: [{}] }` passed it, and the last element
      // is the current user input: userText came out undefined, and the location
      // prefix below would then send Gemini the literal string "undefined" — a
      // paid call for nothing, or an SDK throw reported as a 500.
      //
      // Refusing here rather than further down is a SPENDING decision, not a
      // tidiness one. This check sits ahead of both meters. Without it the spend
      // ledger charged an unmeasurable payload at the deliberately-expensive
      // fallback rate (~100,000 tokens) for a request that never reached Gemini,
      // so a caller could burn the whole process-wide daily ceiling with a
      // hundred and fifty empty bodies and take Birdie down for everyone without
      // spending a cent of Google's money or their own. Fail-expensive is the
      // right default for a payload we cannot measure; the fix is to not be
      // holding an unmeasurable payload by the time we start charging for it.
      const lastMessage = messages[messages.length - 1];
      if (typeof lastMessage?.text !== 'string' || lastMessage.text.trim() === '') {
        return res.status(400).json({ error: 'type something first' });
      }

      // Resolve tier ONCE per request (isPremium is a DB query). When the
      // paywall is off (default), no DB hit — behavior is identical to before.
      const freeTier = paywallEnabled() && !(await isPremium(userId));
      const dailyLimit = freeTier ? FREE_DAILY_LIMIT : PREMIUM_DAILY_LIMIT;

      // Per-user rate limit (daily by tier + 15/min for everyone)
      const rateCheck = checkUserRateLimit(userId, dailyLimit);
      if (!rateCheck.allowed) {
        if (freeTier && rateCheck.reason === 'daily') {
          return res.status(429).json({
            error: "Birdie's free tier is out of chirps for today",
            code: 'UPGRADE_REQUIRED',
            feature: 'birdie',
            limit: FREE_DAILY_LIMIT,
            resetsAt: nextUtcMidnightISO(),
          });
        }
        return res.status(429).json({ error: rateCheck.error });
      }

      // Get user name + age bracket
      // Data minimization for the third-party model (audit 2026-08-12): first
      // name only, and age as a coarse bracket — never the birth date itself.
      const userResult = await pool.query('SELECT name, date_of_birth FROM users WHERE id = $1', [userId]);
      const userName = (userResult.rows[0]?.name || 'friend').split(' ')[0];
      let ageBracket = null;
      const dob = userResult.rows[0]?.date_of_birth;
      if (dob) {
        const age = Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 24 * 3600 * 1000));
        ageBracket = age < 18 ? 'minor' : age < 21 ? 'under21' : 'adult';
      }

      // Build Gemini chat history (must start with 'user' role, no consecutive same-role)
      const history = [];
      for (const m of messages.slice(0, -1)) {
        if (!m.text) continue;
        const role = m.role === 'assistant' ? 'model' : 'user';
        // Skip if this would be a model message before any user message
        if (history.length === 0 && role === 'model') continue;
        // Skip consecutive same-role messages
        if (history.length > 0 && history[history.length - 1].role === role) continue;
        history.push({ role, parts: [{ text: m.text }] });
      }
      // Ensure history ends with model (if it ends with user, Gemini expects the next to be model)
      if (history.length > 0 && history[history.length - 1].role === 'user') {
        history.pop();
      }

      // The last message is the current user input. Its presence and type were
      // established above, before either meter was touched.
      let userText = lastMessage.text;

      // Prepend location context if available — rounded to ~1km (2 decimals).
      // Neighborhood-level is all venue recommendations need; exact
      // coordinates of a minor never leave our servers for a third party.
      if (location && Number.isFinite(+location.lat) && Number.isFinite(+location.lng)) {
        userText = `[My approximate location: ${(+location.lat).toFixed(2)},${(+location.lng).toFixed(2)}]\n${userText}`;
      }

      // Chat session on the unified SDK: model per call, system prompt and
      // tools live in config (includes user name + current app context).
      //
      // Round 15: this config object is now reused per request rather than
      // written inline, because a per-request config REPLACES the chat's config
      // outright — the SDK does `config: params.config ?? this.config`, no
      // merge. Passing `{ abortSignal }` alone on sendMessage would therefore
      // have silently dropped Birdie's system prompt AND every tool
      // declaration, which is a far worse bug than the one being fixed.
      const chatConfig = {
        systemInstruction: buildSystemPrompt(userName, currentContext, { ageBracket, freeTier }),
        tools: [{ functionDeclarations: toolDeclarations }],
      };
      const chat = genAI.chats.create({
        model: BIRDIE_MODEL,
        history,
        config: chatConfig,
      });

      // Round 15: Gemini was the last outbound call in the app with no deadline
      // at all — UPSTREAM_TIMEOUT_MS.gemini was declared and never used. Node's
      // fetch applies none of its own, so a hung vendor socket parked this
      // Express connection for minutes; and this is the one endpoint whose call
      // count a user can steer, since the tool loop below runs up to five more
      // round trips on prompts they write. A fresh signal per call, because
      // AbortSignal.timeout starts counting when it is constructed.
      //
      // The retry deliberately does NOT cover a timeout. Gemini is PAID per
      // token and the vendor has already parsed and metered a request we abort,
      // so retrying one is a second invoice for a question we paid to ask —
      // the rule stated in utils/upstream.js. Transient 429/5xx failures, which
      // are cheap and fast, still get their one retry.
      //
      // THE SPEND LEDGER IS CHARGED HERE, ONCE PER ATTEMPT.
      //
      // Not once per turn, and not once per payload. Every attempt below is a
      // separate request Google receives, parses and bills, so every attempt
      // charges — including the retry, which is a second invoice for the same
      // question and is charged like one. The charge happens BEFORE the call
      // for the reason utils/upstream.js states: an aborted paid request is
      // still billed, so a charge-on-success design undercounts exactly when
      // the upstream is sick and our call rate is highest.
      //
      // `promptChars` is the size of the WHOLE conversation, not of this
      // message. The SDK keeps no server-side session: the system prompt, every
      // tool declaration and the entire history go up the wire again on each
      // call. Measuring only the new part is precisely how a six-round tool loop
      // came to be billed as one short question.
      let promptChars = payloadChars(chatConfig) + payloadChars(history);
      async function sendWithRetry(payload) {
        // Once per payload, not once per attempt: a retry re-sends the same
        // message, it does not append a second copy of it.
        promptChars += payloadChars(payload);
        const send = async () => {
          const estimate = estimateGeminiTokens(promptChars);
          if (!allowGeminiCall(userId, estimate)) throw new GeminiBudgetError();
          const resp = await chat.sendMessage({
            message: payload,
            config: { ...chatConfig, abortSignal: upstreamSignal('gemini') },
          });
          // Estimating from characters is a brake, not a billing
          // reconciliation. Where the SDK tells us the real figure, use it, so
          // a systematically low estimate cannot accumulate into a free
          // allowance across a long tool loop.
          settleGeminiCall(userId, estimate, reportedTokens(resp));
          promptChars += responseChars(resp);
          return resp;
        };
        try {
          return await send();
        } catch (e) {
          // A ledger refusal is not a vendor failure and must never be retried:
          // the second attempt would charge again for a call we already decided
          // not to make, and a ceiling that retries itself is not a ceiling.
          if (e?.geminiBudget) throw e;
          const aborted = e?.name === 'AbortError' || e?.name === 'TimeoutError'
            || /abort|timed? ?out/i.test(e?.message || '');
          if (aborted) throw e;
          const transient = e.status === 429 || e.status >= 500 || /quota|overloaded|unavailable|fetch failed/i.test(e.message || '');
          if (!transient) throw e;
          await new Promise(r => setTimeout(r, 800));
          return await send();
        }
      }

      // Send message and handle tool calls
      const turnDeadline = Date.now() + BIRDIE_TURN_BUDGET_MS;
      // The very first call is refused outright when the ledger is spent —
      // there is nothing to answer with, so this is a 429 rather than a
      // degraded reply, and Gemini is never reached.
      let response;
      let budgetStopped = false;
      try {
        response = await sendWithRetry(userText);
      } catch (e) {
        if (e?.geminiBudget) {
          return res.status(429).json({ error: BIRDIE_BUSY_MESSAGE });
        }
        throw e;
      }
      let iterations = 0;
      const collectedVenues = []; // Track venues for card display
      let navigationAction = null; // Track navigation commands

      while (iterations < 5) {
        if (Date.now() > turnDeadline) {
          console.warn('[AI] Turn budget spent; answering without further tool rounds');
          break;
        }
        iterations++;
        const candidate = response.candidates?.[0];
        if (!candidate) break;

        // Check for function calls
        const functionCalls = candidate.content?.parts?.filter(p => p.functionCall) || [];
        if (functionCalls.length === 0) break;

        // Execute all function calls
        const functionResponses = [];
        for (const part of functionCalls) {
          // Gemini 3.x matches responses to calls by id — dropping it makes
          // tool-backed turns come back empty (round 6).
          const { name, args, id } = part.functionCall;
          try {
            const result = await executeTool(name, args || {}, userId, { includeForecast: !freeTier, localHour: req.body.localHour, localDay: req.body.localDay });

            // Collect venue data for cards
            if (name === 'search_venues' && result.venues) {
              collectedVenues.push(...result.venues);
            }
            if (name === 'navigate_app' && result.navigated) {
              navigationAction = { tab: result.tab, screen: result.screen, profile_section: result.profile_section };
            }
            if (name === 'get_crowd_prediction' && result.venue_name) {
              // Enrich any matching venue with crowd data
              const match = collectedVenues.find(v => v.place_id === args.place_id);
              if (match) {
                match.crowd = result.crowd_score;
                match.crowd_label = result.crowd_label;
              }
            }

            functionResponses.push({
              functionResponse: { ...(id ? { id } : {}), name, response: result },
            });
          } catch (err) {
            console.error(`[AI] Tool ${name} failed:`, err.message);
            functionResponses.push({
              functionResponse: { ...(id ? { id } : {}), name, response: { error: err.message } },
            });
          }
        }

        // Send tool results back to Gemini. A ledger refusal mid-loop stops the
        // turn the same way the wall-clock deadline above does: answer with
        // what we already have rather than 500. The tool work is done and any
        // venue cards it produced are still worth returning.
        try {
          response = await sendWithRetry(functionResponses);
        } catch (e) {
          if (e?.geminiBudget) {
            console.warn('[AI] Gemini spend ceiling reached mid-turn; answering without further tool rounds');
            budgetStopped = true;
            break;
          }
          throw e;
        }
      }

      // Extract final text
      const candidate = response.candidates?.[0];
      const textParts = candidate?.content?.parts?.filter(p => p.text) || [];
      const fallbackText = budgetStopped ? BIRDIE_BUSY_MESSAGE : 'say that one more time?';
      const responseText = textParts.map(p => p.text).join('') || fallbackText;

      // Collect venue data from tool results to send as cards
      const venueCards = [];
      if (collectedVenues.length > 0) {
        // Take top 4 venues max for cards
        for (const v of collectedVenues.slice(0, 4)) {
          venueCards.push({
            place_id: v.place_id,
            name: v.name,
            address: v.address,
            rating: v.rating,
            reviews: v.reviews,
            price_level: v.price_level,
            types: v.types,
            is_open: v.is_open,
            lat: v.lat,
            lng: v.lng,
            photo_url: v.photo_url || null,
            crowd: typeof v.crowd === 'number' ? v.crowd : null,
            crowd_label: v.crowd_label || null,
          });
        }
      }

      const result = { text: responseText, venues: venueCards, remaining: rateCheck.remaining };
      if (navigationAction) result.navigate = navigationAction;
      res.json(result);
    } catch (err) {
      console.error('[AI] Chat error:', err);
      if (err.status === 429 || err.message?.includes('quota')) {
        return res.status(429).json({ error: 'one sec, lots of people chatting rn. try that again' });
      }
      res.status(500).json({ error: 'hmm gimme a sec, hit me again' });
    }
  }
);

module.exports = router;
// Exposed for backend/__tests__/paidCallBudgets.test.js. The tool executor is
// where Birdie spends money on the user's behalf (Places, and weather at
// caller-chosen coordinates), and those charges are invisible from the route's
// JSON, so they are tested directly.
module.exports.__testables = { executeTool };
