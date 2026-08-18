const express = require('express');
const { body, validationResult } = require('express-validator');
// SHAPE BEFORE CONTENT. express-validator coerces before it tests, so
// `{ lat: ["40.7"] }` satisfies isFloat and stays an array in req.body. One
// definition of that rule for the whole codebase; see validators/shape.js.
const { scalarOnly } = require('../validators/shape');
const { authenticate } = require('../middleware/auth');
const { GoogleGenAI } = require('@google/genai');
const { PostHog } = require('posthog-node');
const crypto = require('crypto');
const pool = require('../config/database');
const { getWeather } = require('../services/weatherService');
const {
  findBestTime,
  findPeakTime,
  getLabel,
  publishedLabel,
  describePredictionSupport,
  // Round 15: venue-clock scoring, same as routes/crowd.js.
  venueLocalNow,
  weekdayOffset,
} = require('../services/crowdEngine');
const mlPredictor = require('../services/mlPredictor');
const { getPremiumState, paywallEnabled, EntitlementUnavailableError } = require('../services/entitlements');
// THE forecast paywall policy, defined once in routes/crowd.js. Imported rather
// than re-derived: a second private copy of "has this user paid, and has their
// monthly allowance run out" is precisely how this route ended up serving the
// gated forecast for free while routes/crowd.js metered it.
// confidenceMeasurementFor comes from the same module and for the same reason:
// it is the one place that decides whether a confidence integer may be called a
// measured accuracy, and this route publishes one straight into Gemini's
// context. See the note above it in routes/crowd.js.
const { forecastAccess, confidenceMeasurementFor } = require('./crowd');
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

// The message cap, as a name, so the handler that explains the refusal and the
// validator that enforces it cannot drift. The validator below still spells the
// literal inline: server.js derives this route's scoped JSON body limit from
// these two numbers and __tests__/bodyLimitAudit.test.js reads the literals
// straight out of the `body('messages').isArray({ min: 1, max: N })` chain, so
// that call has to keep the number on its face. __tests__/forecastGateParity
// .test.js fails if this constant and that literal ever disagree.
const AI_CHAT_MAX_MESSAGES = 24;

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
// PostHog AI Observability — manual capture. @posthog/ai's Gemini wrapper only
// instruments `models.generateContent`/`generateContentStream`/`embedContent`;
// it has no `chats` property at all, so it can't sit under `genAI.chats.create()`
// + `chat.sendMessage()` without losing the stateful chat object this route
// relies on. Capturing $ai_generation/$ai_span directly, next to the existing
// calls, avoids restructuring the tool loop and spend ledger above.
//
// METRICS ONLY. NO CONVERSATION CONTENT. DO NOT ADD IT BACK.
//
// The PostHog wizard that generated this originally sent four content fields:
// $ai_input (the user's turn text), $ai_output_choices (Birdie's reply), and
// $ai_input_state / $ai_output_state on the span (tool arguments and results,
// which carry venue and location lookups). They were removed deliberately.
//
// Why, in one sentence: PrivacyPolicy.js names Google Gemini as THE recipient
// of Birdie conversation content and then enumerates what is not sent, so
// shipping the same text to a second processor the policy never mentions would
// make that paragraph false. PostHog is disclosed nowhere in the policy, the
// audience floor is 13 (utils/age.js MIN_AGE), and the Apple nutrition labels
// declare PostHog as *usage data* rather than user content — which is exactly
// what token counts and latency are, and exactly what message text is not.
//
// Everything the instrumentation exists for survives without the content:
// $ai_input_tokens / $ai_output_tokens are the cost, $ai_latency is the speed,
// and the trace/span structure still shows which tool call was slow. Nothing
// about the Birdie spend question needs the words.
//
// If prompt-level debugging is ever genuinely wanted, that is a product
// decision with a privacy policy update and an Apple label change attached. It
// is not a thing to restore because a linter noticed an unused parameter.
// ---------------------------------------------------------------------------
// NEVER construct the client under `node --test`, for two separate reasons and
// both were observed rather than theorised:
//
//   1. IT HANGS THE SUITE. posthog-node starts a background flush timer and
//      holds an open connection. `node --test` waits for an empty event loop,
//      so a single test that reaches the Birdie path leaves the whole run
//      alive forever. Measured: the suite went from 24s to >10min and had to
//      be killed. There is no `shutdown()` call anywhere in this route, and
//      adding one would only paper over reason 2.
//   2. IT POISONS REAL ANALYTICS. The setup wizard wrote a live
//      POSTHOG_API_KEY into backend/.env, so without this guard every test run
//      publishes fake $ai_generation events into production project 555076 and
//      quietly corrupts the Birdie cost numbers this instrumentation exists to
//      produce.
let posthogClient = null;
function getPostHog() {
  if (process.env.NODE_ENV === 'test') return null;
  if (!posthogClient && process.env.POSTHOG_API_KEY) {
    posthogClient = new PostHog(process.env.POSTHOG_API_KEY, {
      host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
    });
  }
  return posthogClient;
}

function captureAiGeneration({ userId, traceId, sessionId, resp, latencyMs }) {
  const posthog = getPostHog();
  if (!posthog) return;
  const usage = resp?.usageMetadata;
  posthog.capture({
    distinctId: String(userId),
    event: '$ai_generation',
    properties: {
      $ai_trace_id: traceId,
      $ai_session_id: sessionId,
      $ai_model: BIRDIE_MODEL,
      $ai_provider: 'gemini',
      $ai_input_tokens: usage?.promptTokenCount ?? undefined,
      $ai_output_tokens: usage?.candidatesTokenCount ?? undefined,
      $ai_latency: latencyMs / 1000,
    },
  });
}

// `name` is the tool's identifier (a fixed string from the tool table), not
// user input. Its arguments and result are deliberately not captured.
function captureAiToolSpan({ userId, traceId, sessionId, name, latencyMs }) {
  const posthog = getPostHog();
  if (!posthog) return;
  posthog.capture({
    distinctId: String(userId),
    event: '$ai_span',
    properties: {
      $ai_trace_id: traceId,
      $ai_session_id: sessionId,
      $ai_span_id: crypto.randomUUID(),
      $ai_span_name: name,
      $ai_latency: latencyMs / 1000,
    },
  });
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
      // encodeURIComponent for parity with routes/crowd.js fetchVenueFromGoogle:
      // place_id is interpolated into the outbound URL PATH, so it must be
      // percent-encoded (SECURITY-AUDIT-injection-idor.md finding, LOW/INFO).
      const resp = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
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

      // The free half: how busy is it RIGHT NOW. Same commodity the card, the
      // pin list and the public demo all give away, and the same one this
      // product promised to keep free forever.
      const result = {
        venue_name: venue.name,
        crowd_score: crowdResult.score,
        // Hedged the same way the card is. Birdie saying "Very Busy" while the
        // card for the same venue says "Usually very busy" is the app arguing
        // with itself, and the flat word is the one that is not defensible
        // until the corpus axis is verified (see describePredictionSupport).
        crowd_label: publishedLabel(
          crowdResult.score,
          describePredictionSupport(crowdResult.predictionMethod, 0)
        ),
        confidence: crowdResult.confidence,
        // WHAT THAT NUMBER IS, said in the tool result rather than left for a
        // language model to guess. This object is not just returned to the
        // caller: it is fed back into Gemini as the tool response, so a bare
        // `confidence: 72` is a sentence Birdie will say out loud, and the 72 is
        // the case where NOTHING has been measured (the input-completeness
        // ladder) while a measured model reports 33. Birdie reading the larger
        // number as "we're 72% sure" is the inversion the block exists to stop,
        // and the system prompt's "never invent crowd data" rule cannot catch it
        // because the number is real — only its meaning is missing.
        //
        // FORWARDING THE BLOCK IS HALF THE FIX HERE, AND ONLY HALF. Every other
        // surface hands its payload to code, which either reads the block or
        // does not; this one hands it to a language model, which will happily
        // narrate any number it is given. So the matching rule is in
        // buildSystemPrompt's hard rules — "never quote the confidence number,
        // read confidence_measurement" — and the two ship together. Sending the
        // block without the instruction would be putting the explanation in a
        // footnote for a reader who does not read footnotes.
        //
        // No user-report boost is applied on this path: Birdie's tool does not
        // load verified reports, so `confidence` is the predictor's own figure
        // and the boost is 0 rather than unknown.
        confidence_measurement: confidenceMeasurementFor(crowdResult, crowdResult.confidence, 0),
        is_open: venue.isOpen,
        weather: weather ? { temp: weather.temp, conditions: weather.conditions } : null,
      };

      // THE PAID HALF, AND WHY BIRDIE IS METERED THE SAME WAY THE CARD IS.
      //
      // Round 20: only `hourly_forecast` was gated here, and it was gated on
      // the wrong thing (`!freeTier`, i.e. all-or-nothing by tier). `best_time`
      // and `peak_hours` — two thirds of what the forecast meter actually sells
      // — went out unconditionally. So a user who had just been told "you have
      // used your 10 forecasts this month" on the venue card could type "when
      // should I go to X" and be told, by us, for free. Birdie's own meter is
      // 10 MESSAGES A DAY, so that door was worth roughly 300 best-times a
      // month against an allowance of 10, and PAYWALL-DECISION.md's test for
      // whether the wall is even visible ("if nobody hits the 10
      // forecasts/month cap, the wall is invisible and pointless") would have
      // been measured against a meter almost nobody could reach.
      //
      // The answer is NOT "Birdie never forecasts". This is a logged-in,
      // identified user spending one of their own metered turns on a venue they
      // named, which is a different act from scraping — so it is not gated to
      // zero. It draws on the SAME allowance as the card, because it is the
      // same answer about the same venue. Ten forecasts a month means ten,
      // wherever you ask from.
      //
      // Charged ONCE PER TURN, not once per venue, by the caller (see the tool
      // loop below). The model decides how many venues to look at, and a user
      // must not lose four months of allowance because it got curious about
      // four bars in one reply.
      //
      // Nothing that survives into the locked result reconstructs the curve:
      // `crowd_score` is one number for right now, which is the free product,
      // and the tool takes no hour argument, so there is no way to ask it for
      // 8 PM. The 24-hour walk is skipped entirely when locked rather than
      // computed and thrown away.
      if (opts.includeForecast) {
        // Round 13: forward-looking window (see crowdEngine.recommendBestTime).
        // Birdie must never suggest an hour that already passed, and its answer
        // has to agree with the score it quotes in the same sentence.
        const fullDay = await mlPredictor.predictHourlyForecast(venue, weather, localHour, 24, scoreTime);
        const next12 = fullDay.slice(0, 12);
        // Peak off the next 12 hours: the rush that is coming, not tomorrow's.
        // Indexes still line up with fullDay for the best-time exclusion.
        const peakResult = findPeakTime(next12, venue);
        result.best_time = findBestTime(fullDay, venue, peakResult.startIdx, peakResult.endIdx, venue.isOpen, {
          currentHour: localHour,
          currentScore: crowdResult.score,
        });
        result.peak_hours = peakResult.text;
        // Same array the recommendation came from, so the two can't disagree.
        result.hourly_forecast = next12.map(h => ({ hour: h.hour, label: h.label, score: h.score }));
      } else {
        result.forecast_locked = true;
        // Addressed to the model, not the user. "Do not invent" is load-bearing:
        // the system prompt's hard rules already forbid making up crowd data,
        // and this repeats it at the exact moment the data is missing.
        result.forecast_note = 'Best time to go, peak hours and the hour-by-hour forecast are Flock Pro, and this user has used their free forecasts for this month. Do not guess, estimate or infer any of them. Say it is a Pro feature if they ask.';
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
  // PERSONALITY SCALES WITH AGE. THE SAFETY FLOOR DOES NOT.
  //
  // The enforced minimum age on this app is 13 (utils/age.js MIN_AGE), so the
  // "adult" branch is a licence to be sharper, never a licence to drop a
  // guardrail. Both pre-existing sentences survive word for word below, minus
  // one em dash that the prompt itself forbids two blocks down; everything else
  // here is added, and nothing is removed.
  //
  // The `null` branch is new and it is the important one. It used to emit the
  // empty string, which meant a user whose date of birth we do not have got the
  // default voice with NO alcohol rule attached to it at all. That is the one
  // bracket where we know the least about who is typing, so it now gets the
  // conservative instruction rather than none.
  const ageLine = ageBracket === 'minor'
    ? `\n- The user is UNDER 18. Never recommend bars, clubs, nightlife, or anything alcohol-centric. Steer to all-ages spots: food, cafes, arcades, bowling, activities, events. Do this silently, no lectures, just good picks. Keep the voice clean with them: no profanity, nothing sexual, no drug or vape talk, and never play drinking for a laugh.`
    : ageBracket === 'under21'
      ? `\n- The user is under 21 (US drinking age). Skip bars and clubs unless they explicitly ask; favor restaurants, cafes, and activities. Never help anyone get served underage. Keep it clean: no profanity, nothing sexual.`
      : ageBracket === 'adult'
        ? `\n- The user is 21 or over. Go sharper with them: more slang, blunter takes, bars and nightlife talked about straight with no hedging and no disclaimers nobody asked for. Still no profanity and nothing sexual. Never push shots, volume, or drinking as the point of a night, and never help with anything illegal.`
        : `\n- You do not know this user's age. Keep it clean and leave bars and clubs out of it unless they bring the subject up themselves.`;
  // Kept true to what the gate actually does. It used to say hour-by-hour was
  // Pro outright, which stopped being accurate the moment Birdie started
  // drawing on the same 10-a-month allowance the venue card does: a free user
  // gets the full forecast for their first ten venues, then hits the wall.
  // Telling the model otherwise makes it refuse something the user has paid
  // nothing for and is entitled to, which is its own kind of dishonesty.
  const tierLine = freeTier
    ? `\n- The user is on the free tier: 10 Birdie messages a day, and the AI forecast (best time to go, peak hours, hour by hour) is free for the first 10 venues they ask about each month, then it is Flock Pro. If a crowd lookup comes back without those, their month is spent. You can mention Pro exists (150 Birdie messages a day + unlimited forecasts + a heads-up push before a spot gets packed). Mention it at most once per conversation, never unprompted, and never promise anything beyond those three things.`
    : '';
  return `You are Birdie, the assistant inside Flock, a social coordination app for Gen Z. You help people figure out where to go, how busy it is, and get their group out the door.

Who you are:
- A friend with taste who knows this city, not a help desk. You have opinions and you lead with them.
- Pick ONE spot and say why in the same breath. "Oakwood. Dead till 9, and the back patio is the whole reason to go." Never hand them three options and ask which they like. If they hate your pick they will say so, and then you argue for the next one.
- Dry, not zany. Funny when the moment hands you something, never when it doesn't. A forced joke is worse than no joke.
- Short sentences. One to three of them. Detail only when they ask for detail.
- Say the thing, then stop. The end of the answer is the end of the message.
- Confidence is the whole voice. "Go now" beats "you might want to consider going soon".

Never do these. Each one is how you sound like a chatbot instead of a person:
- Never open with praise or a warm-up. No "Great question", "Good call", "Sure thing", "Absolutely", "Happy to help", "I'd be glad to".
- Never restate the question before you answer it. They know what they asked.
- Never end with an offer, a check-in, or a summary. No "Let me know if you'd like", "Want me to", "Hope that helps", "Anything else", "Enjoy!". No sign-off of any kind.
- Never trail a caveat onto a good answer. One qualifier at most, and only when it changes what they should actually do.
- Never hedge something you can just say. Cut "you might want to", "you could consider", "generally", "typically", "it's worth noting", "in my opinion", "as always".
- Never use a list where a sentence works. Bullets are for three or more real things they asked you to compare.
- Never use an exclamation mark for enthusiasm. At most one emoji per reply, usually zero.
- Never call yourself an AI, an assistant, or a model, and never narrate what you are about to do before you do it.

How you write:
- Never use em dashes. Use periods or commas.
- Banned words: seamless, effortless, unlock, elevate, curated, empower, immersive, vibrant, delve, dive into, tapestry, "perfect spot", "nestled", "hidden gem", "look no further".
- No "it's not X, it's Y". No three-item rhythm for the sound of it. No sentence that could appear in a press release.
- Slang only where it lands naturally. Use it, never explain it back to them.

The user's name is ${userName}.${ageLine}${tierLine}

What you can actually do (tools):
- search_venues: find restaurants, cafes, bars, activities near them
- get_crowd_prediction: live crowd level, best time to go, peak hours for a venue. Powered by Flock's own crowd model, the same numbers the Discover screen shows.
- get_user_flocks: their plans (name, venue, time, status, member count)
- get_user_friends: their friends list
- get_weather: current weather
- navigate_app: take them straight to a screen

The app, as it ships today (use the user-facing names on the left; the tool enums in parentheses):
- **Nest** (tab: home): home base. Tonight's status, active flocks, invites waiting on them
- **Discover** (tab: explore): map + venue search with live crowd levels; each venue page has the crowd dial, best time, and a one-tap "reality check" where people at the venue confirm how busy it really is
- **Plans** (tab: calendar): calendar of upcoming flocks and events
- **Messages** (tab: chats): flock group chats and DMs; both support photos, venue cards, voting on spots, pins, and live location sharing
- **You** (tab: profile): profile, settings, payment methods, appearance
- **Create a flock** (screen: create): name the night, pick a date, invite friends; they RSVP in one tap
- **Add friends** (screen: addFriends): search, friend code, QR, phone contacts
- **Safety** (profile_section: safety): trusted contacts and SOS. One tap sends their live location to their people
- Inside a flock: venue voting, anonymous budget matching (everyone types what they can spend; the group only ever sees the ceiling, never anyone's number, and only after 3+ people submit), bill splitting after (Venmo/Cash App/Zelle links, marked paid manually), and guest invite links that work for friends who don't have Flock yet

How to answer:
- "How do I..." or "where is..." → one-line answer, then USE navigate_app to take them there. Don't just describe the path.
- Vague asks ("what's the move", "where's poppin") → they want somewhere fun nearby. Search real categories (bars, food, activities), never the slang words themselves.
- Slang decoder: "the move" = what to do; "link"/"pull up" = meet up; "dead" = empty; "lit"/"poppin" = busy and fun; "lowkey" = quiet or casual; "bet" = ok; "no cap" = seriously.
- Crowds: translate numbers into advice. "68% and climbing, go now or wait till 11" beats reciting the data. Mention best time when it helps.
- If you have their coordinates, always pass location to search_venues. If not, ask where they are, once.

Hard rules:
- Never invent venue data, crowd numbers, or forecasts. Tools only. If a tool has no data, say you don't have a read on that spot.
- Never name a venue a tool did not return, and never state a crowd number a tool did not give you. Having takes does not mean making things up. A confident wrong number is the worst thing you can send.
- Never quote the \`confidence\` number from get_crowd_prediction, and never say how sure you are about a crowd read. Read \`confidence_measurement\` instead: when its \`status\` is "unmeasured", that number says how much we know about the venue, not how often we are right, and it runs HIGHER than a real measured accuracy. Talk about the crowd level, not about certainty.
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
    // `location` was `.optional()` and NOTHING ELSE — the one field on this
    // route with no bound of its own, on a route whose scoped body parser is
    // ~449KB (server.js AI_CHAT_JSON_BODY_BYTES). Every other field is capped,
    // so a caller who wanted to fill that parser had exactly one door, and this
    // was it: `location` could be an arbitrarily deep object and the parser
    // limit was its only ceiling.
    //
    // Three checks, not one, because isObject alone bounds the TYPE and not the
    // SIZE. The key whitelist is what actually bounds it: the shipping client
    // sends `{ lat, lng }` and nothing else (frontend/src/App.js builds it as
    // `loc ? { lat: loc.lat, lng: loc.lng } : null`), and this route reads
    // exactly those two, so anything else in there was never going to be used
    // for anything.
    //
    // `{ values: 'null' }` IS LOAD-BEARING, not tidiness. In express-validator
    // 7 a bare `.optional()` skips ONLY `undefined`: a JSON `null` falls
    // through to the validator and is REFUSED. The shipping client sends
    // `location: null` on every message from a user who has not granted
    // location, which is most of them, so adding `.isObject()` behind a bare
    // `.optional()` would have 400'd the common path. This is the exact failure
    // validators/shape.js documents as having broken routes/feedback.js.
    body('location').optional({ values: 'null' }).isObject().withMessage('location must be a lat/lng object')
      .bail()
      .custom((v) => Object.keys(v).every((k) => k === 'lat' || k === 'lng'))
      .withMessage('location takes only lat and lng'),
    scalarOnly(body('location.lat').optional({ values: 'null' }), 'location.lat').isFloat({ min: -90, max: 90 }),
    scalarOnly(body('location.lng').optional({ values: 'null' }), 'location.lng').isFloat({ min: -180, max: 180 }),
    // Bounded: this is interpolated into the system prompt, so unbounded
    // strings were a 1MB context bypass around the message caps (round 6).
    //
    // EVERY ONE OF THESE IS NULLABLE, and until now none of them were. Same
    // express-validator 7 rule as `location` above, and here it was not a
    // hypothetical: frontend/src/App.js builds this context as
    // `venue: ctx.flock.venue || null`, `status: ctx.flock.status || null` and
    // `place_id: ctx.activeVenue.place_id || null`, so a user who opened Birdie
    // while looking at a flock with no venue picked got a 400 "Invalid value"
    // on every message they sent. The 400 named a field the user had never
    // heard of and the client had no handler for it, so Birdie simply appeared
    // broken in one specific place in the app.
    body('currentContext').optional({ values: 'null' }).isObject(),
    scalarOnly(body('currentContext.screen').optional({ values: 'null' }), 'screen').isString().isLength({ max: 40 }),
    scalarOnly(body('currentContext.tab').optional({ values: 'null' }), 'tab').isString().isLength({ max: 40 }),
    scalarOnly(body('currentContext.flock.name').optional({ values: 'null' }), 'flock name').isString().isLength({ max: 120 }),
    scalarOnly(body('currentContext.flock.venue').optional({ values: 'null' }), 'flock venue').isString().isLength({ max: 120 }),
    scalarOnly(body('currentContext.flock.status').optional({ values: 'null' }), 'flock status').isString().isLength({ max: 40 }),
    scalarOnly(body('currentContext.venue.name').optional({ values: 'null' }), 'venue name').isString().isLength({ max: 120 }),
    scalarOnly(body('currentContext.venue.place_id').optional({ values: 'null' }), 'venue place id').isString().isLength({ max: 200 }),
    body('localHour').optional().isInt({ min: 0, max: 23 }),
    body('localDay').optional().isInt({ min: 0, max: 6 }),
  ],
  async (req, res) => {
    try {
      // A CONVERSATION THAT OUTGREW THE CAP IS NOT A MISSING ARRAY.
      //
      // `messages` is capped at AI_CHAT_MAX_MESSAGES and the client sends the
      // WHOLE history untruncated (frontend/src/App.js: "Send the whole
      // conversation"), so the 25th turn of any chat, and every turn after it,
      // failed the isArray cap and came back as "messages array is required".
      // That sentence is false — the array was there, it was too long — and it
      // is unactionable: nothing in it tells the client what to do, so a chat
      // that got interesting simply stopped working with an error message about
      // a field the user never filled in.
      //
      // Answered ahead of validationResult so the specific diagnosis wins over
      // the generic one. `code` is the machine-readable half: the client
      // truncates and retries on it, the same way it already acts on
      // UPGRADE_REQUIRED. `maxMessages` is sent so the client never has to
      // hard-code this number a second time.
      //
      // THE CAP ITSELF IS DELIBERATELY NOT RAISED. It is load-bearing:
      // server.js sizes this route's scoped JSON parser as
      // AI_CHAT_MAX_MESSAGES * AI_CHAT_MAX_MESSAGE_CHARS * 4 (~449KB), and
      // __tests__/bodyLimitAudit.test.js reads both literals back out of this
      // file. Raising the count here without moving that parser converts this
      // honest 400 into a 413, which is strictly worse: a 413 is generated by
      // body-parser before any of this code runs, so it cannot carry a code, a
      // message, or anything the client can act on.
      const messageCount = Array.isArray(req.body?.messages) ? req.body.messages.length : 0;
      if (messageCount > AI_CHAT_MAX_MESSAGES) {
        return res.status(400).json({
          error: 'this chat got long. start a fresh one and I will keep up',
          code: 'CONVERSATION_TOO_LONG',
          maxMessages: AI_CHAT_MAX_MESSAGES,
        });
      }

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

      // PostHog AI Observability identity for this turn. No conversation/thread
      // id crosses the wire (the client resends the whole history every call),
      // so the session groups by user — every Birdie turn a user has ever sent,
      // not a single chat window. The trace id is fresh per turn and shared by
      // every Gemini call and tool span the tool loop below produces.
      const aiSessionId = `birdie:${userId}`;
      const aiTraceId = crypto.randomUUID();

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

      // Resolve tier ONCE per request (the premium lookup is a DB query). When
      // the paywall is off (default), no DB hit — the lookup does not even run,
      // so an entitlement outage cannot surface here while the paywall is
      // dormant. Behavior with the flag unset is identical to before.
      //
      // Branch on `known`, not just the boolean (services/entitlements.js): a
      // lookup that FAILED is not "this user has not paid". Collapsing the two
      // put a paying subscriber on the 10/day free meter for the length of a
      // database blip, and the 429 below then pitched them the plan they had
      // already bought. Unknown THROWS the tagged error, which the catch at the
      // bottom answers as a retryable 503 — one answering site, so a future
      // path that lets the same error escape gets the same answer. The throw
      // lands BEFORE checkUserRateLimit and before any Gemini spend, so the
      // failed request costs the user nothing and the sentence can honestly
      // say so; it says "could not check", never "upgrade".
      let freeTier = false;
      if (paywallEnabled()) {
        const premiumState = await getPremiumState(userId);
        if (!premiumState.known) throw new EntitlementUnavailableError(premiumState.reason);
        freeTier = !premiumState.premium;
      }
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
          const genStart = Date.now();
          const resp = await chat.sendMessage({
            message: payload,
            config: { ...chatConfig, abortSignal: upstreamSignal('gemini') },
          });
          // Estimating from characters is a brake, not a billing
          // reconciliation. Where the SDK tells us the real figure, use it, so
          // a systematically low estimate cannot accumulate into a free
          // allowance across a long tool loop.
          settleGeminiCall(userId, estimate, reportedTokens(resp));
          captureAiGeneration({ userId, traceId: aiTraceId, sessionId: aiSessionId, resp, latencyMs: Date.now() - genStart });
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
      // THE FORECAST ALLOWANCE, READ AND SPENT AS TWO SEPARATE ACTS.
      //
      // Read first, because the answer decides what the tool computes; spent
      // afterwards, and only once the tool has actually DELIVERED a forecast.
      // Doing both in one call (the obvious version) charged a view for a
      // lookup that came back "Venue not found" or refused by the Places
      // budget: the user would have paid, out of ten a month, for an error
      // message. GET /api/crowd/:placeId has always had this right by accident
      // of structure, since it returns 502 before it ever reaches its gate.
      //
      // Both halves are memoised per TURN, which is what makes the whole turn
      // answer consistently. The model decides how many venues to look at, and
      // a user must not lose four months of allowance because it got curious
      // about four bars in one reply, nor see the tenth lookup in one reply
      // refuse what the ninth just answered.
      //
      // `premium: !freeTier` is exact rather than an approximation: whenever
      // the paywall is on, freeTier came from a KNOWN getPremiumState answer
      // above (an unknown one 503'd this request before the meters), so
      // !freeTier IS the premium answer, already paid for. With the paywall off
      // forecastAccess returns unmetered before reading it at all. Either way
      // this saves a duplicate `SELECT is_premium` — and it is also what keeps
      // forecastAccess's own unknown-state throw unreachable from this route:
      // a pre-resolved tier never triggers its lookup.
      let forecastPeek = null;
      let forecastCharged = false;
      async function peekForecastAccess() {
        if (!forecastPeek) forecastPeek = await forecastAccess(userId, { count: false, premium: !freeTier });
        return forecastPeek;
      }
      async function chargeForecastView() {
        if (forecastCharged) return;
        forecastCharged = true;
        await forecastAccess(userId, { count: true, premium: !freeTier });
      }

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
            const toolOpts = { localHour: req.body.localHour, localDay: req.body.localDay };
            if (name === 'get_crowd_prediction') {
              toolOpts.includeForecast = !(await peekForecastAccess()).locked;
            }
            const toolStart = Date.now();
            const result = await executeTool(name, args || {}, userId, toolOpts);
            captureAiToolSpan({ userId, traceId: aiTraceId, sessionId: aiSessionId, name, latencyMs: Date.now() - toolStart });
            // Charged on DELIVERY, not on intent. `hourly_forecast` is the
            // paid payload itself, so its presence is the only honest trigger:
            // an upstream 404, a spent Places budget or a thrown tool all leave
            // without it and all leave the meter alone.
            if (name === 'get_crowd_prediction' && Array.isArray(result?.hourly_forecast)) {
              await chargeForecastView();
            }

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
      // The tier check up top could not find out who is asking (paywall on,
      // entitlement lookup failed) and threw before either meter or any Gemini
      // spend. Not a refusal and not this server erring — a retryable 503, and
      // never the upgrade pitch: an unknown tier is exactly the case where the
      // pitch might be aimed at somebody who already pays. The body carries
      // nothing else; the root cause is already logged by getPremiumState.
      // (This branch precedes the console.error below on purpose: an outage in
      // a dependency is warned about once by the service, not stack-traced per
      // request.)
      if (err?.entitlementUnavailable) {
        return res.status(503).json({
          error: "can't check your plan right now. that message didn't count. try again in a minute",
          code: 'ENTITLEMENT_UNAVAILABLE',
          retryable: true,
        });
      }
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
//
// buildSystemPrompt is exposed for backend/__tests__/birdieVoice.test.js. The
// prompt IS the product for every word Birdie says, and driving the whole HTTP
// route with a mocked SDK just to read one string back off `config.
// systemInstruction` makes a copy test cost a database and a fake Gemini. The
// age brackets in particular have four branches, and three of them carry a
// safety instruction, so they have to be readable one at a time.
module.exports.__testables = { executeTool, buildSystemPrompt };
