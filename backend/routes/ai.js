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
} = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');
const { isPremium, paywallEnabled } = require('../services/entitlements');
const {
  checkUserRateLimit,
  nextUtcMidnightISO,
  PREMIUM_DAILY_LIMIT,
  FREE_DAILY_LIMIT,
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
// ---------------------------------------------------------------------------

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
      const searchBody = { textQuery: toolInput.query, maxResultCount: 8 };
      if (toolInput.location) {
        const [lat, lng] = toolInput.location.split(',').map(Number);
        searchBody.locationBias = {
          circle: { center: { latitude: lat, longitude: lng }, radius: 15000.0 },
        };
      }
      const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': PLACES_API_KEY,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.priceLevel,places.types,places.currentOpeningHours,places.location',
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
      }));
      return { venues };
    }

    case 'get_crowd_prediction': {
      // Same ML path as GET /api/crowd — Birdie must quote the numbers the
      // Discover screen shows, not a parallel rule-engine estimate.
      if (!PLACES_API_KEY) return { error: 'Google Places API not configured' };
      const placeId = toolInput.place_id;
      const resp = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
        headers: {
          'X-Goog-Api-Key': PLACES_API_KEY,
          'X-Goog-FieldMask': 'id,displayName,formattedAddress,rating,userRatingCount,priceLevel,types,location,currentOpeningHours',
        },
      });
      const p = await resp.json();
      if (p.error) return { error: 'Venue not found' };

      const now = new Date();
      const localHour = now.getHours();
      const localDay = now.getDay();

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
      };

      const lat = venue.location?.latitude;
      const lon = venue.location?.longitude;
      const weather = (lat && lon) ? await getWeather(lat, lon) : null;

      const crowdResult = await mlPredictor.predictBusyness(venue, weather, now);
      const fullDay = await mlPredictor.predictHourlyForecast(venue, weather, 6, 24, now);
      const peakResult = findPeakTime(fullDay, venue);
      const bestTime = findBestTime(fullDay, venue, peakResult.startIdx, peakResult.endIdx, venue.isOpen);

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
        const hourly = await mlPredictor.predictHourlyForecast(venue, weather, localHour, 12, now);
        result.hourly_forecast = hourly.map(h => ({ hour: h.hour, label: h.label, score: h.score }));
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
      const weather = await getWeather(toolInput.lat, toolInput.lng);
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
    body('messages').isArray({ min: 1 }).withMessage('messages array is required'),
    body('location').optional(),
    body('currentContext').optional(),
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

      // The last message is the current user input
      const lastMessage = messages[messages.length - 1];
      let userText = lastMessage.text;

      // Prepend location context if available — rounded to ~1km (2 decimals).
      // Neighborhood-level is all venue recommendations need; exact
      // coordinates of a minor never leave our servers for a third party.
      if (location && Number.isFinite(+location.lat) && Number.isFinite(+location.lng)) {
        userText = `[My approximate location: ${(+location.lat).toFixed(2)},${(+location.lng).toFixed(2)}]\n${userText}`;
      }

      // Chat session on the unified SDK: model per call, system prompt and
      // tools live in config (includes user name + current app context).
      const chat = genAI.chats.create({
        model: BIRDIE_MODEL,
        history,
        config: {
          systemInstruction: buildSystemPrompt(userName, currentContext, { ageBracket, freeTier }),
          tools: [{ functionDeclarations: toolDeclarations }],
        },
      });

      // Helper: send to Gemini with one retry on transient upstream errors
      async function sendWithRetry(payload) {
        try {
          return await chat.sendMessage({ message: payload });
        } catch (e) {
          const transient = e.status === 429 || e.status >= 500 || /quota|overloaded|unavailable|fetch failed/i.test(e.message || '');
          if (!transient) throw e;
          await new Promise(r => setTimeout(r, 800));
          return await chat.sendMessage({ message: payload });
        }
      }

      // Send message and handle tool calls
      let response = await sendWithRetry(userText);
      let iterations = 0;
      const collectedVenues = []; // Track venues for card display
      let navigationAction = null; // Track navigation commands

      while (iterations < 5) {
        iterations++;
        const candidate = response.candidates?.[0];
        if (!candidate) break;

        // Check for function calls
        const functionCalls = candidate.content?.parts?.filter(p => p.functionCall) || [];
        if (functionCalls.length === 0) break;

        // Execute all function calls
        const functionResponses = [];
        for (const part of functionCalls) {
          const { name, args } = part.functionCall;
          try {
            const result = await executeTool(name, args || {}, userId, { includeForecast: !freeTier });

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
              functionResponse: {
                name,
                response: result,
              },
            });
          } catch (err) {
            console.error(`[AI] Tool ${name} failed:`, err.message);
            functionResponses.push({
              functionResponse: {
                name,
                response: { error: err.message },
              },
            });
          }
        }

        // Send tool results back to Gemini
        response = await sendWithRetry(functionResponses);
      }

      // Extract final text
      const candidate = response.candidates?.[0];
      const textParts = candidate?.content?.parts?.filter(p => p.text) || [];
      const responseText = textParts.map(p => p.text).join('') || "say that one more time?";

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
            crowd: v.crowd || null,
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
        return res.status(429).json({ error: 'one sec, lots of people chatting rn — try that again' });
      }
      res.status(500).json({ error: 'hmm gimme a sec, hit me again' });
    }
  }
);

module.exports = router;
