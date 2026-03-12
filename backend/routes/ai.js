const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pool = require('../config/database');
const { getWeather } = require('../services/weatherService');
const {
  calculateCrowdScore,
  generateHourlyForecast,
  findBestTime,
  findPeakTime,
  getLabel,
} = require('../services/crowdEngine');

const router = express.Router();
const PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

// ---------------------------------------------------------------------------
// Gemini client (2.5 Flash-Lite — free tier: 15 RPM, 1000 RPD)
// ---------------------------------------------------------------------------
let genAIClient = null;
function getGenAI() {
  if (!genAIClient && process.env.GEMINI_API_KEY) {
    genAIClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return genAIClient;
}

// ---------------------------------------------------------------------------
// Per-user rate limiting (30 messages/day per user, 3/min)
// ---------------------------------------------------------------------------
const userRateLimits = new Map();
const USER_DAILY_LIMIT = 30;
const USER_PER_MIN_LIMIT = 3;

function checkUserRateLimit(userId) {
  const now = Date.now();
  const todayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  if (!userRateLimits.has(userId)) {
    userRateLimits.set(userId, { day: todayKey, dailyCount: 0, recentTimestamps: [] });
  }

  const limit = userRateLimits.get(userId);

  // Reset daily count if new day
  if (limit.day !== todayKey) {
    limit.day = todayKey;
    limit.dailyCount = 0;
  }

  // Check daily limit
  if (limit.dailyCount >= USER_DAILY_LIMIT) {
    return { allowed: false, error: `You've used all ${USER_DAILY_LIMIT} messages for today. Resets at midnight!` };
  }

  // Check per-minute limit
  const oneMinAgo = now - 60000;
  limit.recentTimestamps = limit.recentTimestamps.filter(ts => ts > oneMinAgo);
  if (limit.recentTimestamps.length >= USER_PER_MIN_LIMIT) {
    return { allowed: false, error: 'Slow down! Wait a few seconds before sending another message.' };
  }

  // Allow and record
  limit.dailyCount++;
  limit.recentTimestamps.push(now);
  return { allowed: true, remaining: USER_DAILY_LIMIT - limit.dailyCount };
}

// Clean up stale entries every hour
setInterval(() => {
  const todayKey = new Date().toISOString().slice(0, 10);
  for (const [userId, limit] of userRateLimits) {
    if (limit.day !== todayKey) userRateLimits.delete(userId);
  }
}, 3600000);

// ---------------------------------------------------------------------------
// Tool definitions for Gemini
// ---------------------------------------------------------------------------
const toolDeclarations = [
  {
    name: 'search_venues',
    description: 'Search for nearby venues/restaurants/bars/cafes by keyword and optional location. Returns name, address, rating, price level, and whether it is currently open.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query, e.g. "bars near me", "pizza", "fun things to do"' },
        location: { type: 'string', description: 'Lat,lng string e.g. "40.7128,-74.0060". Use the user\'s location if available.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_crowd_prediction',
    description: 'Get the current crowd level, hourly forecast, best time to visit, and peak hours for a specific venue. Use this when the user asks about how busy a place is or when to go.',
    parameters: {
      type: 'object',
      properties: {
        place_id: { type: 'string', description: 'Google Places ID of the venue' },
        venue_name: { type: 'string', description: 'Name of the venue (for display)' },
      },
      required: ['place_id'],
    },
  },
  {
    name: 'get_user_flocks',
    description: 'Get the user\'s active flocks/plans including members, venue, date, time, and status.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_user_friends',
    description: 'Get the user\'s friends list.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_weather',
    description: 'Get current weather for a location.',
    parameters: {
      type: 'object',
      properties: {
        lat: { type: 'number', description: 'Latitude' },
        lng: { type: 'number', description: 'Longitude' },
      },
      required: ['lat', 'lng'],
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

async function executeTool(toolName, toolInput, userId) {
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

      const crowdResult = calculateCrowdScore(venue, weather, now);
      const hourly = generateHourlyForecast(venue, weather, localHour, 12, now);
      const fullDay = generateHourlyForecast(venue, weather, 6, 24, now);
      const peakResult = findPeakTime(fullDay, venue);
      const bestTime = findBestTime(fullDay, venue, peakResult.startIdx, peakResult.endIdx, venue.isOpen);

      return {
        venue_name: venue.name,
        crowd_score: crowdResult.score,
        crowd_label: getLabel(crowdResult.score),
        confidence: crowdResult.confidence,
        is_open: venue.isOpen,
        best_time: bestTime,
        peak_hours: peakResult.text,
        hourly_forecast: hourly.map(h => ({ hour: h.hour, label: h.label, score: h.score })),
        weather: weather ? { temp: weather.temp, conditions: weather.conditions } : null,
      };
    }

    case 'get_user_flocks': {
      const result = await pool.query(
        `SELECT f.id, f.name, f.venue_name, f.venue_address, f.event_time, f.status,
                json_agg(json_build_object('name', u.name, 'status', fm.status)) as members
         FROM flocks f
         JOIN flock_members fm ON fm.flock_id = f.id
         JOIN users u ON u.id = fm.user_id
         WHERE f.id IN (SELECT flock_id FROM flock_members WHERE user_id = $1)
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

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
function buildSystemPrompt(userName) {
  return `You are Birdie, the AI assistant for Flock — a social coordination app for Gen Z (ages 15-22). You help users find venues, check how busy places are, and coordinate plans with friends.

Your personality:
- Casual, friendly, concise — talk like a chill friend, not a corporate bot
- Use slang naturally but don't overdo it
- Keep responses SHORT (2-4 sentences max unless the user asks for detail)
- Use emojis sparingly (1-2 max per message)
- Be opinionated — recommend things confidently, don't just list options

The user's name is ${userName}.

What you can do:
- Search for venues (restaurants, bars, cafes, activities) nearby
- Check how busy/crowded a place is right now and forecast the best time to go
- Look at the user's flocks (group plans) and friends
- Check the weather
- Help plan outings and coordinate with friends

When searching for venues:
- If the user gives a location or you have their coordinates, always pass location to search_venues
- After finding venues, you can check crowd levels for specific ones
- Give confident recommendations, not just lists

When checking crowds:
- Use get_crowd_prediction with the venue's place_id
- Translate the data into casual advice ("it's pretty chill rn" or "gonna be packed around 9")
- Mention the best time to go if relevant

Important:
- Never make up venue data — always use the tools to get real info
- If you don't know the user's location, ask for it or suggest they search for a specific area
- Don't be overly verbose — Gen Z users want quick, useful answers`;
}

// ---------------------------------------------------------------------------
// POST /api/ai/chat — Main chat endpoint (Gemini with function calling)
// ---------------------------------------------------------------------------
router.use(authenticate);

router.post('/chat',
  [
    body('messages').isArray({ min: 1 }).withMessage('messages array is required'),
    body('location').optional(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const genAI = getGenAI();
      if (!genAI) {
        return res.status(500).json({ error: 'AI service not configured — GEMINI_API_KEY missing' });
      }

      const { messages, location } = req.body;
      const userId = req.user.id;

      // Per-user rate limit
      const rateCheck = checkUserRateLimit(userId);
      if (!rateCheck.allowed) {
        return res.status(429).json({ error: rateCheck.error });
      }

      // Get user name
      const userResult = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
      const userName = userResult.rows[0]?.name || 'friend';

      // Build Gemini chat history
      const history = [];
      for (const m of messages.slice(0, -1)) {
        history.push({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.text }],
        });
      }

      // The last message is the current user input
      const lastMessage = messages[messages.length - 1];
      let userText = lastMessage.text;

      // Prepend location context if available
      if (location) {
        userText = `[My location: ${location.lat},${location.lng}]\n${userText}`;
      }

      // Create model with system instruction (includes user name)
      const gemini = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash-lite',
        systemInstruction: buildSystemPrompt(userName),
      });

      // Start chat with tools
      const chat = gemini.startChat({
        history,
        tools: [{ functionDeclarations: toolDeclarations }],
      });

      // Send message and handle tool calls
      let response = await chat.sendMessage(userText);
      let iterations = 0;
      const collectedVenues = []; // Track venues for card display

      while (iterations < 5) {
        iterations++;
        const candidate = response.response.candidates?.[0];
        if (!candidate) break;

        // Check for function calls
        const functionCalls = candidate.content?.parts?.filter(p => p.functionCall) || [];
        if (functionCalls.length === 0) break;

        // Execute all function calls
        const functionResponses = [];
        for (const part of functionCalls) {
          const { name, args } = part.functionCall;
          try {
            const result = await executeTool(name, args || {}, userId);

            // Collect venue data for cards
            if (name === 'search_venues' && result.venues) {
              collectedVenues.push(...result.venues);
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
        response = await chat.sendMessage(functionResponses);
      }

      // Extract final text
      const candidate = response.response.candidates?.[0];
      const textParts = candidate?.content?.parts?.filter(p => p.text) || [];
      const responseText = textParts.map(p => p.text).join('') || "Sorry, I couldn't process that. Try again?";

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

      res.json({ text: responseText, venues: venueCards, remaining: rateCheck.remaining });
    } catch (err) {
      console.error('[AI] Chat error:', err);
      if (err.status === 429 || err.message?.includes('quota')) {
        return res.status(429).json({ error: 'AI is busy right now, try again in a sec' });
      }
      res.status(500).json({ error: 'Something went wrong with Birdie', debug: err.message });
    }
  }
);

module.exports = router;
