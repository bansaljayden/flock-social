// ---------------------------------------------------------------------------
// PUBLIC crowd demo — powers the "try it live" section on flockcorp.com.
// No auth: visitors get the real Discover experience (map pins + the full
// venue card, scored by the same ML model the app serves) before they sign up.
//
// Cost/abuse controls, since every fresh area search is a Google Places call:
//  - per-visitor limit: 20 requests/hour across both endpoints (visitorKey:
//    the relay's signed visitor address, or the source address)
//  - global cap: 600 scored requests/day (after that: 429, the site says
//    "the demo is resting, see it in the app")
//  - aggressive caching: area searches 20 min, venue cards 10 min
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const net = require('net');
const express = require('express');
const { query, param, validationResult } = require('express-validator');
const { getWeather } = require('../services/weatherService');
const mlPredictor = require('../services/mlPredictor');
const { upstreamSignal } = require('../utils/upstream');
const { allowGlobalPlacesCall } = require('../utils/placesBudget');
// Free outage detection. This is the file whose console.error below ran for five days in September with nobody counting it. See utils/placesHealth.js.
const { recordPlacesResult } = require('../utils/placesHealth');
const { paywallEnabled } = require('../services/entitlements');
const { recommendBestTime, findPeakTime, getLabel, publishedLabel, describePredictionSupport, venueLocalNow, isOpenAt, buildHoursByDay, weekdayOffset, stripClock } = require('../services/crowdEngine');
// The venue's IANA zone off a Places payload (utils/venueZone.js).
const { placeTimeZone } = require('../utils/venueZone');
// The one place that decides whether a confidence integer may be called a
// measured accuracy, defined in routes/crowd.js and imported rather than
// re-derived — the same argument the forecast gate above records for
// forecastAccess, and it applies harder here: this door is unauthenticated, so
// a private copy that drifted would put the wrong claim in front of visitors
// who have never seen the app. See the note above confidenceMeasurementFor.
const { confidenceMeasurementFor } = require('./crowd');

const router = express.Router();
const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

// --- limits ---------------------------------------------------------------
// Round 15: the memory guard here was `if (ipHits.size > 5000) ipHits.clear()`.
// A wholesale clear hands every tracked address a fresh allowance, so an
// attacker cycling 5000 addresses could reset their own counter — and every
// legitimate visitor's — at will: the defence got weaker the harder it was
// pushed. Same bounded eviction as routes/guest.js's guest counter and
// utils/probeBudget.js: expire first, then evict LEAST CONSUMED first, never
// clear(). Consumption order matters for the reason those two files spell out:
// a flooder spends their 20 and only then sprays fresh addresses, so their own
// entry is the oldest AND the fullest — an age-ordered drop (or a clear)
// deletes precisely the counter they wanted gone, while consumption order
// makes recovering it cost thousands of addresses that each already spent.
const IP_LIMIT = 20;          // requests per address per rolling hour
const IP_WINDOW_MS = 3600_000;
const IP_MAX_ENTRIES = 5000;  // ceiling on tracked addresses
// Evict down to 90%, not to the ceiling: stopping exactly at the ceiling makes
// a map held at the ceiling sort itself on every request (probeBudget's
// comment owns this reasoning; the CPU DoS is the same here).
const IP_LOW_WATER = Math.floor(IP_MAX_ENTRIES * 0.9);
const ipHits = new Map(); // ip -> [timestamps], each list capped at IP_LIMIT
let dayKey = new Date().toISOString().slice(0, 10);
let dayCount = 0;

function evictIpHits(now) {
  // Expire pass first: an address with nothing live in the window is free to
  // forget. Order-independent, so no delete-before-set dance is needed for
  // this map anywhere in the file — the fallback below sorts by consumption,
  // not insertion age (routes/guest.js records the same non-rule).
  for (const [k, v] of ipHits) {
    const live = v.filter((t) => now - t < IP_WINDOW_MS);
    if (live.length === 0) ipHits.delete(k);
    else if (live.length !== v.length) ipHits.set(k, live);
  }
  if (ipHits.size <= IP_MAX_ENTRIES) return;
  const byConsumption = [...ipHits.entries()].sort((a, b) => a[1].length - b[1].length);
  for (const [k] of byConsumption) {
    if (ipHits.size <= IP_LOW_WATER) break;
    ipHits.delete(k);
  }
}

// WHOSE 20 REQUESTS THESE ARE, AND WHY IN PRODUCTION THEY ARE NOT ONE
// VISITOR'S.
//
// req.ip is the LAST entry in X-Forwarded-For: server.js sets `trust proxy` to
// 1, so Express trusts exactly one hop, and the last entry is the one our own
// proxy appended — the only entry a caller cannot write, which is the same
// rule socketClientIp and forwardedProtocol in server.js read that header
// family by. For a request that reaches Railway directly, that entry is the
// visitor and this gate means what it says.
//
// THE MARKETING PAGE DOES NOT REACH RAILWAY DIRECTLY. In production the demo
// fetches same-origin /relay/public/*, which vercel.json rewrites to this
// backend server-side (frontend/src/website/LiveDemo.js picks the relay in
// production only, because school and work filters block *.railway.app). The
// chain is therefore browser -> Vercel -> Railway proxy -> here, so the entry
// our proxy appended is VERCEL'S egress address, and every visitor arriving
// through one Vercel POP shares a single bucket of IP_LIMIT per rolling hour:
// the 21st uncached area search in that hour answers DEMO_BUSY_MSG to all of
// them. The cache hides most of it (allowDemo is consulted only on a MISS, and
// a miss is a ~1km bucket for 20 minutes), which is why the demo does not look
// broken — but the per-address gate is not metering addresses.
//
// WHY THE LEFTMOST ENTRY IS NOT THE FIX, AND WHAT IS. Keying on the FIRST
// X-Forwarded-For entry would read the visitor for relayed traffic and would
// read whatever any caller cares to type for everything else: every entry left
// of our proxy's own is client-written, and relayed and direct requests arrive
// through the same Railway edge, so that header cannot tell them apart. One
// request header would then mint a fresh allowance on demand, which is the
// round-15 mistake above in a new costume: a defence that gets weaker the
// harder it is pushed. A shared bucket refuses honest visitors; a spoofable key
// refuses nobody.
//
// THE RELAY SIGNS THE ADDRESS. The Vercel side is a function now, not a bare
// rewrite (frontend/api/demo-relay.js). It reads the visitor's address from
// the headers Vercel's edge writes itself, and forwards it as x-flock-relay-ip
// with x-flock-relay-ts (unix seconds) and x-flock-relay-sig, an HMAC-SHA256
// over `${ip}.${ts}` under RELAY_SIGNING_SECRET, the one value set in both
// Railway and Vercel. visitorKey below believes that address only when all
// three headers are present, the timestamp is within two minutes, the address
// parses as one, and the signature matches in constant time. Anything else,
// which includes every direct caller, is keyed on req.ip exactly as before. A
// direct caller can type the three headers but not the signature, so typing
// them buys nothing; a captured set replays for two minutes at most and only as
// the address it names, which puts the replayer in somebody else's bucket,
// never a fresh one. With the secret unset (or under 16 characters) the relay
// sends no headers and nothing here believes any: the behaviour before this.
//
//
// Hop COUNTS only, never addresses, and once per process: the two facts the fix
// needs are how many hops the chain carries and whether req.ip is the last of
// them. Silent when no forwarding header is present, which is also what keeps
// the abuse tests (they call allowDemo with a bare { ip }) quiet.
let forwardingShapeLogged = false;
function reportForwardingShape(req) {
  if (forwardingShapeLogged) return;
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (!xff) return;
  forwardingShapeLogged = true;
  const hops = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
  const ipIsLastHop = req.ip === hops[hops.length - 1];
  console.warn(`[PublicDemo] forwarding chain on the demo gate: ${hops.length} hop(s), req.ip is the last hop: ${ipIsLastHop}`);
}

const RELAY_MAX_SKEW_S = 120;
const RELAY_MIN_SECRET = 16;

function relaySecret() {
  const raw = process.env.RELAY_SIGNING_SECRET;
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v.length >= RELAY_MIN_SECRET ? v : null;
}

// One string per header or nothing: Node hands a repeated header over as an
// array, and a request carrying two of these did not come from the relay.
function singleHeader(req, name) {
  const v = req && req.headers ? req.headers[name] : undefined;
  return typeof v === 'string' ? v : null;
}

// Whether a request's relay headers are believed, and the address if so. The
// status names why not, for the log line below; it never carries an address.
function relayVerdict(req, nowMs = Date.now()) {
  const secret = relaySecret();
  const ip = singleHeader(req, 'x-flock-relay-ip');
  const ts = singleHeader(req, 'x-flock-relay-ts');
  const sig = singleHeader(req, 'x-flock-relay-sig');
  if (!ip && !ts && !sig) return { status: secret ? 'absent' : 'off' };
  if (!secret) return { status: 'unconfigured' };
  if (!ip || !ts || !sig) return { status: 'incomplete' };
  if (ip.length > 64 || net.isIP(ip) === 0) return { status: 'bad-address' };
  if (!/^\d{1,12}$/.test(ts)) return { status: 'bad-timestamp' };
  if (Math.abs(Math.floor(nowMs / 1000) - Number(ts)) > RELAY_MAX_SKEW_S) return { status: 'stale' };
  if (!/^[0-9a-f]{64}$/i.test(sig)) return { status: 'bad-signature' };
  const expected = crypto.createHmac('sha256', secret).update(`${ip}.${ts}`).digest();
  const given = Buffer.from(sig, 'hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { status: 'bad-signature' };
  }
  return { status: 'valid', ip: ip.toLowerCase() };
}

// Once per verdict per process, so a deploy's logs say whether the relay's
// signatures are arriving and being believed without printing anyone's address.
// 'off' (no secret, no headers) is today's quiet state and is not reported.
const relayStatusesLogged = {};
function reportRelayVerdict(status) {
  if (status === 'off' || relayStatusesLogged[status]) return;
  relayStatusesLogged[status] = true;
  console.warn(`[PublicDemo] relay signature on the demo gate: ${status}`);
}

// WHO IS ASKING, for both per-visitor meters in this file: allowDemo's hourly
// window and the three-venues-a-day cap below. The relay's signed address when
// it checks out, req.ip otherwise.
function visitorKey(req, nowMs) {
  const verdict = relayVerdict(req, nowMs);
  reportRelayVerdict(verdict.status);
  if (verdict.status === 'valid') return verdict.ip;
  return (req && req.ip) || 'unknown';
}

function allowDemo(req) {
  // Measured from the gate rather than from either route, so both endpoints
  // feed the one report above.
  reportForwardingShape(req);
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) { dayKey = today; dayCount = 0; }
  if (dayCount >= 600) return false;

  const now = Date.now();
  const ip = visitorKey(req, now);
  const hits = (ipHits.get(ip) || []).filter(t => now - t < IP_WINDOW_MS);
  if (hits.length >= IP_LIMIT) return false; // a refusal consumes nothing
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > IP_MAX_ENTRIES) evictIpHits(now);
  dayCount++;
  return true;
}

const DEMO_BUSY_MSG = 'The live demo is taking a breather. The full thing is in the app.';

// EVERY UPSTREAM THIS FILE REACHES IS SPENT WITH NOBODY BEHIND IT.
//
// allowDemo above caps requests per IP and per day, and the Places ledger has
// carried an unauthenticated share since M5-1 (utils/placesBudget.js
// UNAUTH_DAILY). The weather and Ticketmaster ledgers did not: this file called
// getWeather and predictBusyness with no caller identity at all, which the two
// gates read as "background traffic" and charged against the global ceiling
// alone. Measured (money audit round 4): one card here is 24 Ticketmaster calls
// (1 for the score, 23 more for the 24-hour forecast), so 63 requests emptied a
// 1500-call day for the whole product, out of the 600 requests allowDemo will
// serve. Weather was the same shape: four anonymous requests against the live
// preview moved the shared meter by five.
//
// This marker is what puts those calls in the unauthenticated bucket, so they
// are bounded by a SHARE of each day rather than by the whole of it. See
// services/weatherService.js WX_UNAUTH_DAILY and services/mlPredictor.js
// EVENT_UNAUTH_DAILY.
const ANON = Object.freeze({ anonymous: true });

// --- cache ----------------------------------------------------------------
// Round 15: `if (cache.size > 500) cache.clear()` — the same wholesale-clear
// shape as the old ipHits guard, on a map whose keys are caller-shaped
// (rounded coordinates + free-text query, or a caller-supplied place id).
// Every write is already behind allowDemo AND the global Places ledger, so
// junk keys only trickle in at demo pace — but the one entry past the ceiling
// wiped all 500 at once, and every wiped entry is a fresh PAID Google call the
// next legitimate visitor makes, at a moment the attacker chooses. Bounded
// eviction instead: expired entries first, then soonest-to-expire, down to a
// low-water mark. A new junk entry always carries the latest expiry in the
// map, so each budgeted request can only push out the entries closest to
// lapsing anyway — never the whole cache.
const CACHE_MAX_ENTRIES = 500;
const CACHE_LOW_WATER = Math.floor(CACHE_MAX_ENTRIES * 0.9);
const cache = new Map(); // key -> { data, expires }
function getCache(key) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;
  cache.delete(key);
  return null;
}
function setCache(key, data, ttlMs) {
  cache.set(key, { data, expires: Date.now() + ttlMs });
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const now = Date.now();
  for (const [k, v] of cache) { if (v.expires <= now) cache.delete(k); }
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const byExpiry = [...cache.entries()].sort((a, b) => a[1].expires - b[1].expires);
  for (const [k] of byExpiry) {
    if (cache.size <= CACHE_LOW_WATER) break;
    cache.delete(k);
  }
}

// --- helpers --------------------------------------------------------------
function priceLevelToNum(priceLevel) {
  const map = {
    PRICE_LEVEL_FREE: 0,
    PRICE_LEVEL_INEXPENSIVE: 1,
    PRICE_LEVEL_MODERATE: 2,
    PRICE_LEVEL_EXPENSIVE: 3,
    PRICE_LEVEL_VERY_EXPENSIVE: 4,
  };
  return map[priceLevel] ?? null;
}

function toVenueShape(p, localDay) {
  let openHour = null, closeHour = null, closeMinute = 0;
  const periods = p.currentOpeningHours?.periods;
  const hoursByDay = buildHoursByDay(periods);
  const timeZone = placeTimeZone(p);
  if (hoursByDay) {
    // The venue's own day beats the visitor's: a place in LA is still on
    // Friday's hours while a visitor in London has rolled over to Saturday.
    const venueDay = venueLocalNow(p.utcOffsetMinutes, undefined, timeZone)?.day;
    const today = venueDay != null ? venueDay : (localDay != null ? localDay : new Date().getDay());
    // Scalars stay for anything still reading a single window; hoursByDay is
    // what actually decides open/closed now.
    const todayWindow = (hoursByDay[today] || [])[0];
    if (todayWindow) {
      openHour = todayWindow.open;
      closeHour = todayWindow.close;
      closeMinute = todayWindow.closeMinute;
    }
  }
  return {
    hoursByDay,
    closeMinute,
    place_id: p.id,
    name: p.displayName?.text || '',
    formatted_address: p.formattedAddress || '',
    rating: p.rating || null,
    user_ratings_total: p.userRatingCount || 0,
    price_level: priceLevelToNum(p.priceLevel),
    types: p.types || [],
    location: p.location || null,
    isOpen: p.currentOpeningHours?.openNow ?? null,
    openHour,
    closeHour,
    // The venue shape is what predictBusyness scores, and it reads
    // utcOffsetMinutes to build the Ticketmaster query window (trueEventInstant).
    // venueClock() reads the offset off the raw place for the scoring clock, but
    // the event window was left on the wrong (server) instant because the shape
    // dropped this. Carry it through so both halves use the venue's real time.
    utcOffsetMinutes: p.utcOffsetMinutes != null ? p.utcOffsetMinutes : null,
    // The venue's IANA zone (PLACE_FIELDS asks for it). With it the demo's
    // clock and every forecast hour use the offset in force at that hour, so
    // the card stays right across the venue's own clock change; without it,
    // the offset above, as before.
    timeZone,
  };
}

/* WARM THE PHOTOS THIS ANSWER JUST NAMED, AFTER THE ANSWER HAS GONE.
   The demo draws one pin per venue, but a browser only fetches the pins it
   actually paints, so the venues below the fold and the cards nobody taps stay
   uncached. When one of those is finally asked for and the fetch fails, for a
   rotated photo name or a moment of upstream trouble, the pin falls back to a
   letter and the card to the placeholder bird, which is the failure this is
   here to make rare.

   It costs no extra Google search: the names come from the search this request
   already paid for, and photos already held are answered from Postgres inside
   fetchPhotoOnce before any gate, so a warm run on a warm area spends nothing.
   It is fired AFTER res.json so it can never delay the response, and every
   failure is swallowed: this is opportunistic, and a visitor must never see a
   slower or worse answer because a warm did not work.

   Bounded three ways. It never runs while the day's photo budget is nearly
   spent, so a warm cannot be the thing that exhausts a ceiling a real viewer
   needs. It asks for ONE width, the same 400 the pin and the card now share.
   And it walks the venues one at a time rather than in parallel, because the
   point is to fill a cache quietly, not to open eight sockets to Google the
   moment somebody loads a marketing page. */
const WARM_MIN_DAY_REMAINING = 32;
let warmInFlight = false;
async function warmDemoPhotos(rows, req) {
  if (warmInFlight) return;
  const refs = (rows || [])
    .map((v) => {
      const m = /[?&]ref=([^&]+)/.exec(String(v && v.photo_url) || '');
      return m ? decodeURIComponent(m[1]) : null;
    })
    .filter(Boolean);
  if (refs.length === 0) return;
  warmInFlight = true;
  try {
    const { warmPhoto, photoProxyStatus } = require('./venueSearch');
    const status = await photoProxyStatus();
    if (!status || status.dayRemaining < WARM_MIN_DAY_REMAINING) return;
    for (const ref of refs) {
      try { await warmPhoto(ref, 400, req); } catch { /* opportunistic */ }
    }
  } catch (err) {
    console.warn('[PublicDemo] photo warm skipped:', err.message);
  } finally {
    warmInFlight = false;
  }
}

// places.timeZone (2026-09-25): Pro in both Text Search and Place Details, the
// tier places.utcOffsetMinutes is already bought at, on a mask billed at
// Enterprise for rating, review count, price and hours. It adds nothing to
// either call's price. See utils/venueZone.js for what it is for.
const PLACE_FIELDS = 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.priceLevel,places.types,places.currentOpeningHours,places.utcOffsetMinutes,places.timeZone,places.location,places.photos';

// The full venue card: current score + best time + peak + 12h forecast.
//
// Round 13: the 24-hour forecast used to start at 6 AM no matter what time it
// was, which is how a card at 8:49 PM recommended 4 PM. It now starts at the
// venue's current hour and runs forward, so:
//   - every hour in it is still to come,
//   - entry 0 is scored at the exact timestamp the dial uses, so the chart's
//     first bar, the headline number and the recommendation cannot disagree,
//   - the chart is the first 12 entries of that same array instead of a second
//     set of predictions that could drift from it (and 12 fewer model calls).
async function buildCard(v, weather, clock, preScored, place) {
  // Round 14: the list pin and the card dial are the same venue at the same
  // instant, so they must be the same prediction, not two calls that could
  // straddle an event-cache refill and print 78% on the pin and 76% in the
  // ring. The caller hands its score in when it already has one.
  const scored = preScored || await mlPredictor.predictBusyness(v, weather, clock.time, ANON);
  const fullDay = await mlPredictor.predictHourlyForecast(v, weather, clock.localHour, 24, clock.time, ANON);
  const hourly = fullDay.slice(0, 12);
  const barClock = stripClock(hourly, clock.localHour);
  // Peak is read off the 12 hours the chart draws, so the rush it names is a
  // bar you can see. Scanning all 24 made a Wednesday card report Thursday
  // evening as the peak. Indexes still line up with fullDay for the best-time
  // exclusion below.
  const peakResult = findPeakTime(hourly, v, { startDay: clock.localDay });
  const best = recommendBestTime(fullDay, v, peakResult.startIdx, peakResult.endIdx, v.isOpen, {
    currentHour: clock.localHour,
    currentDay: clock.localDay, // so a Monday-closed venue isn't sent tonight
    currentScore: scored.score, // the number on the dial, not a different hour's
  });
  // Entry 0 is scored at the same instant as the dial, so this must hold. If it
  // ever stops holding, the card is lying about one of the two numbers.
  if (hourly.length && hourly[0].score !== scored.score) {
    console.error(`[PublicDemo] dial/chart mismatch for ${v.place_id}: ${scored.score} vs ${hourly[0].score}`);
  }
  return {
    place_id: v.place_id,
    name: v.name,
    // The card had every fact about the venue except what it looks like. The
    // pin row has carried a photo ref all along; the card was built from the
    // venue shape, which does not include one, so nothing reached the page.
    // 400 is the size the photo proxy snaps a card request to, and the area
    // search's pin row asks for 400 too. The width is half of photoCacheKey
    // (services/photoStore.js), so holding both to ONE width makes the pin and
    // the card one purchase for one photograph instead of two.
    photo_url: place?.photos?.[0]?.name
      ? `/api/venues/photo?ref=${encodeURIComponent(place.photos[0].name)}&maxwidth=400`
      : null,
    address: v.formatted_address,
    rating: v.rating,
    reviews: v.user_ratings_total,
    price_level: v.price_level,
    is_open: v.isOpen,
    score: scored.score,
    // The public demo hedges exactly like the in-app card. This surface is
    // read by people who have never used the app, so an unhedged word here is
    // the first claim the product makes and the least defensible one.
    label: publishedLabel(scored.score, describePredictionSupport(scored.predictionMethod, 0)),
    // The label's provenance, machine-readable. The hedge above already
    // carries it in prose; this is the same answer for a client that reads
    // fields instead of words (snake_case, this surface's convention).
    confidence_basis: describePredictionSupport(scored.predictionMethod, 0).basis,
    confidence: scored.confidence,
    // The confidence above is the free half of this demo and is published to
    // people who have no account, so it is the FIRST number this product shows
    // anyone. It cannot go out bare: 72 here means "Google described this venue
    // richly", 33 means "the model is right within 15 points a third of the
    // time on the rows it actually serves", and without this block the demo
    // shows its most ignorant state as its most confident one.
    //
    // Boost is 0 by construction: the demo runs no calibration query, so no
    // verified report has moved this number. Survives gateDemoCard, which
    // blanks the paid forecast fields and leaves the free half intact.
    confidence_measurement: confidenceMeasurementFor(scored, scored.confidence, 0),
    best_time: best.text,
    // Which bar the chart should mark. Matched by index, not by label: the
    // recommendation is chosen over 24 hours and the chart only draws 12, so a
    // named hour can sit past the last bar and must not ring a bar at all.
    best_hour: best.dayOffset === 0 ? best.hourLabel : null,
    best_index: (best.dayOffset === 0 && best.index >= 0 && best.index < hourly.length && best.hourLabel)
      ? best.index
      : null,
    // True when the answer is "now" rather than a named hour, so the card can
    // stop printing "Best time to go: Packed now, and it stays that way".
    best_is_now: best.hourLabel == null,
    peak_hours: peakResult.text,
    // `open` per hour so closed hours can't be drawn as a crowd. A shut venue
    // has no crowd, whatever the model thinks the hour looks like.
    hourly: hourly.map((h, i) => {
      // This bar's hour and day off its own label (crowdEngine.stripClock):
      // the forecast runs forward from now, but a strip across a
      // spring-forward night has no 2 AM bar, so "now plus i" would be an
      // hour early for every bar after it.
      const at = barClock[i];
      return {
        hour: h.hour,
        label: h.label,
        score: h.score,
        // Which engine scored this bar (skew fix c, 2026-08-19). The demo
        // rebuilds entries field by field, so without this line the public
        // strip silently drops what mlPredictor now says about every hour.
        predictionMethod: h.predictionMethod || null,
        // Google's openNow wins for the "Now" bar. Published hours and reality
        // disagree often enough (holidays, private events, a late open) that
        // the bar under a "Closed right now" headline must not be drawn as a
        // live crowd just because the posted window says it should be.
        open: (i === 0 && v.isOpen != null)
          ? v.isOpen
          : isOpenAt(v, at.hour, clock.localDay + at.dayOffset),
      };
    }),
    as_of: Date.now(),
  };
}

// The freshness line is drawn from this, not from the client's own clock: a
// phone whose clock is four minutes fast would otherwise read a fresh card as
// "4m ago". The card object itself is shared cache, so age is stamped per
// response and never written back into it.
function withAge(card) {
  if (!card || typeof card.as_of !== 'number') return card;
  return { ...card, age_ms: Math.max(0, Date.now() - card.as_of) };
}

// ---------------------------------------------------------------------------
// THE DEMO IS THE FREE TIER, NOT THE PAID ONE.
//
// This file had NO gate. When PAYWALL_ENABLED goes true, an account that has
// spent its ten monthly forecasts gets `bestTime: null, hourly: []` from
// GET /api/crowd/:placeId (see the gate in routes/crowd.js) while THIS
// endpoint — no auth, no account, no meter, a URL anyone can curl — kept
// handing out the same venue's best time, peak window and 12-hour curve. That
// is not a leak around the edge of the paywall, it is a cheaper door than the
// paid one, and it would have made PAYWALL-DECISION.md an argument about a
// meter nobody had to touch.
//
// WHAT THE HONEST DEMO IS. "Try it live" exists to show people without accounts
// what the product does. What it must show is what they will actually get when
// they sign up, and a signed-out visitor is strictly LESS entitled than a free
// account: the free account has thirty forecasts a month, the visitor has none.
// So the demo shows the free half in full — real venues near them, real live
// busyness scores on every pin, the dial, the label, the confidence, open or
// closed — and stops where the paid product starts. That is a better demo
// argument than the old one, because it shows what you are buying instead of
// giving it away, and it is the only version that is honest about the price.
//
// WHAT IS NOT GATED BY THIS BLOCK: `score`, `label`, `confidence`, `is_open`
// and the per-venue scores in the pin list. Gating them for everyone would
// leave a demo of nothing. With the paywall on they are shown for three venues
// a visitor a day and covered after that; THE LIVE LEVEL, THREE VENUES A DAY
// below says why and how.
//
// `forecast_locked` is published so the marketing page can say what is behind
// the wall instead of just rendering less. NOTE for whoever flips the switch:
// frontend/src/website/LiveDemo.js degrades correctly today (it renders no
// chart for an empty `hourly` and no line for an absent `best_time`) but it has
// NO copy for this state, so the section would silently lose its chart. That is
// a one-line frontend change and it is not in this file.
// ---------------------------------------------------------------------------
// Frozen, array included: this object is spread into every locked response, so
// the one empty array is shared by all of them.
const DEMO_LOCKED_FORECAST = Object.freeze({
  best_time: null,
  best_hour: null,
  best_index: null,
  best_is_now: null,
  peak_hours: null,
  hourly: Object.freeze([]),
});

function gateDemoCard(card) {
  if (!card || !paywallEnabled()) return card;
  return { ...card, ...DEMO_LOCKED_FORECAST, forecast_locked: true };
}

// ---------------------------------------------------------------------------
// THE LIVE LEVEL, THREE VENUES A DAY PER VISITOR, ONCE THE PAYWALL IS ON.
//
// The app covers the live level once a free account has spent its thirty
// venues for the month (routes/crowd.js lockedCard and crowdVisibility). This
// demo went on printing it for any venue to anyone, so an account at its limit
// could sign out and read the map here instead: allowDemo above allows 20
// requests an address an hour, and a cache HIT never consults it at all, which
// left hundreds of venues a day behind a door with no meter on it.
//
// With PAYWALL_ENABLED on, a visitor is shown the crowd level (the dial, the
// label, the confidence, the number on a pin) for at most DEMO_FREE_VENUES
// distinct venues per UTC day. Pins and cards draw on the same three, a venue
// already shown stays shown, and past three a card or pin comes back with venue
// facts only and `crowd_locked`, the flag LiveDemo.js reads to say what an
// account gets instead of drawing an empty dial. With the paywall off nothing
// in this block runs.
//
// KEYED ON visitorKey, the key allowDemo uses: the relay's signed visitor
// address when it checks out, req.ip otherwise ("THE RELAY SIGNS THE ADDRESS"
// above). Until RELAY_SIGNING_SECRET is set on both sides, relayed visitors
// share the relay's egress address, which is the strict direction for a meter:
// it hides too much from honest visitors rather than too little from anyone.
// Checked on EVERY response, hit or miss, because the cache is shared by every
// visitor and allowDemo only runs on a miss.
// ---------------------------------------------------------------------------
const DEMO_FREE_VENUES = 3;
const REVEAL_MAX_ENTRIES = 5000;
const REVEAL_LOW_WATER = Math.floor(REVEAL_MAX_ENTRIES * 0.9);
const demoReveals = new Map(); // address -> { day: 'YYYY-MM-DD', ids: Set<place id> }, at most three ids

function evictDemoReveals(today) {
  // Yesterday's entries first: a visitor whose day rolled over has nothing
  // left to remember. Then least consumed first, for the reason evictIpHits
  // gives: an address that has already spent its three is the entry somebody
  // cycling addresses wants forgotten, so it is the last to go. Never clear().
  for (const [k, v] of demoReveals) {
    if (v.day !== today) demoReveals.delete(k);
  }
  if (demoReveals.size <= REVEAL_MAX_ENTRIES) return;
  const byConsumption = [...demoReveals.entries()].sort((a, b) => a[1].ids.size - b[1].ids.size);
  for (const [k] of byConsumption) {
    if (demoReveals.size <= REVEAL_LOW_WATER) break;
    demoReveals.delete(k);
  }
}

// Whether this visitor may be shown the crowd level for this venue, and if so,
// records that they were. A missing id is never shown: it cannot be counted.
function mayShowCrowd(req, placeId) {
  if (!paywallEnabled()) return true;
  if (typeof placeId !== 'string' || !placeId) return false;
  const today = new Date().toISOString().slice(0, 10);
  const key = visitorKey(req);
  let entry = demoReveals.get(key);
  if (!entry || entry.day !== today) entry = { day: today, ids: new Set() };
  if (!entry.ids.has(placeId)) {
    if (entry.ids.size >= DEMO_FREE_VENUES) return false;
    entry.ids.add(placeId);
  }
  demoReveals.set(key, entry);
  if (demoReveals.size > REVEAL_MAX_ENTRIES) evictDemoReveals(today);
  return true;
}

// What a covered card or pin keeps: facts about the place, never a reading. An
// allowlist for the reason routes/crowd.js LOCKED_CARD_KEEP gives: a field
// added to the card later stays off a covered response by default instead of
// shipping by default.
const DEMO_CARD_KEEP = Object.freeze([
  'place_id', 'name', 'photo_url', 'address', 'rating', 'reviews', 'price_level', 'is_open', 'as_of', 'age_ms',
]);
const DEMO_PIN_KEEP = Object.freeze([
  'place_id', 'name', 'address', 'rating', 'price_level', 'lat', 'lng', 'is_open', 'photo_url',
]);

function keepOnly(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

function coverDemoCard(card) {
  return {
    ...keepOnly(card, DEMO_CARD_KEEP),
    score: null,
    label: null,
    confidence_basis: null,
    // Null beside null: no number here for a measurement block to describe.
    confidence: null,
    confidence_measurement: null,
    ...DEMO_LOCKED_FORECAST,
    forecast_locked: true,
    crowd_locked: true,
  };
}

// A pin never carries a confidence (see the pin row below), so a covered one
// does not grow the key either.
function coverDemoPin(v) {
  return { ...keepOnly(v, DEMO_PIN_KEEP), score: null, label: null, confidence_basis: null, crowd_locked: true };
}

// Everything that leaves this file as a card goes through here: age stamped per
// response, the crowd level counted against the visitor per response, forecast
// gated per response. All three are per-response for the same reason: the card
// object itself is SHARED CACHE, so writing any of them into it would hand the
// next caller a stale age, somebody else's three venues, or whatever the
// paywall happened to be at build time, baked into a 20-minute entry.
function presentCard(card, req) {
  const aged = withAge(card);
  if (aged && !mayShowCrowd(req, aged.place_id)) return coverDemoCard(aged);
  return gateDemoCard(aged);
}

// The area search, card and pins together. The embedded card is counted first:
// it is the hero of the section and its venue is one of the pins, so showing it
// costs the visitor one of their three, not two.
function presentArea(result, req) {
  if (!result || !Array.isArray(result.venues)) return result;
  const card = result.card ? presentCard(result.card, req) : null;
  const venues = result.venues.map((v) => (mayShowCrowd(req, v.place_id) ? v : coverDemoPin(v)));
  return card ? { ...result, venues, card } : { ...result, venues };
}

// ---------------------------------------------------------------------------
// GET /api/public/demo/venues?lat=..&lng=..&q=..
// Area search -> up to 8 venues, each scored by the live model.
// ---------------------------------------------------------------------------
// Visitors' clocks, not Railway's: the server runs UTC, so scoring "now" with
// server time shifts every prediction by the visitor's UTC offset. Same
// localHour/localDay contract as GET /api/crowd.
// Everything downstream reads day/hour off a Date with getDay()/getHours(), so
// a "local" clock is expressed as a server-tz Date carrying the right wall
// values.
// Round 14: `localDay - t.getDay()` is a signed weekday difference, not a
// number of days. On a UTC Sunday a Los Angeles venue is still on Saturday, so
// it computed 6 - 0 = +6 and built a timestamp SIX DAYS IN THE FUTURE — every
// Saturday night, for every venue west of the date line. The weekday and hour
// came out right, which is why it hid, but the DATE feeds the holiday /
// school-break / special-night features and the Ticketmaster query window, so
// the card was scored against next week's events. Nearest matching weekday
// (-3..+3) is the only reading that means "this venue, now".
function clockFor(localHour, localDay, now) {
  const t = now ? new Date(now) : new Date();
  t.setDate(t.getDate() + weekdayOffset(t.getDay(), localDay));
  t.setHours(localHour, 0, 0, 0);
  return { time: t, localHour, localDay };
}

function clientNow(req) {
  const now = new Date();
  const localHour = req.query.localHour != null ? parseInt(req.query.localHour, 10) : now.getHours();
  const localDay = req.query.localDay != null ? parseInt(req.query.localDay, 10) : now.getDay();
  return clockFor(localHour, localDay);
}

// Round 13: the visitor's clock is a decent guess and the server's is a bad
// one. When Google tells us the venue's UTC offset we use the venue's own
// clock, so "a time in the future" is true at the door.
function venueClock(place, fallback) {
  // The zone first when Google sent one: the area search caches for twenty
  // minutes, so an offset fetched just before the venue's clock change would
  // otherwise score the next card an hour off.
  const local = venueLocalNow(place?.utcOffsetMinutes, undefined, placeTimeZone(place));
  return local ? clockFor(local.hour, local.day) : fallback;
}

router.get('/demo/venues',
  [
    query('lat').isFloat({ min: -90, max: 90 }),
    query('lng').isFloat({ min: -180, max: 180 }),
    query('q').optional().trim().isLength({ max: 60 }),
    query('localHour').optional().isInt({ min: 0, max: 23 }),
    query('localDay').optional().isInt({ min: 0, max: 6 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
      if (!API_KEY) return res.status(503).json({ error: DEMO_BUSY_MSG });

      const lat = +(+req.query.lat).toFixed(2); // ~1km buckets = shared cache
      const lng = +(+req.query.lng).toFixed(2);
      const q = (req.query.q || 'restaurants and bars').toLowerCase();
      const { time: scoreTime, localHour, localDay } = clientNow(req);

      // localDay changes the score, so it MUST be in the key — otherwise a
      // weekend request could poison the weekday cache (round 6).
      const cacheKey = `area:${lat}:${lng}:${q}:${localDay}:${localHour}`;
      const cached = getCache(cacheKey);
      // A cache hit is minutes old and says so. Stamping age at build time
      // would let a 19-minute-old card claim "updated just now".
      if (cached) return res.json(presentArea(cached, req));

      if (!allowDemo(req)) return res.status(429).json({ error: DEMO_BUSY_MSG });
      // allowDemo caps REQUESTS per IP and per day; it never touched the shared
      // Places ledger, so everything this endpoint spends at Google was
      // invisible to the "global" daily ceiling. One paid Text Search per cache
      // miss, charged before the fetch (an aborted request still bills).
      // Ordered after allowDemo so a request the demo refuses never charges for
      // a call it was never going to make.
      if (!allowGlobalPlacesCall(1)) return res.status(429).json({ error: DEMO_BUSY_MSG });

      // Round 11: resp.ok was never checked, so a quota, auth or upstream
      // outage came back as a 200 with an empty venue list and the marketing
      // page told visitors their city had no spots. An upstream failure is now
      // an explicit 503 the page can be honest about; only a real zero-result
      // search returns 200 with an empty list.
      let resp;
      try {
        resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': API_KEY,
            'X-Goog-FieldMask': PLACE_FIELDS,
          },
          body: JSON.stringify({
            textQuery: q,
            maxResultCount: 8,
            locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 8000.0 } },
          }),
          // Round 12: a timeout lands in the catch below, which already turns
          // an unreachable upstream into an honest 503.
          signal: upstreamSignal('places'),
        });
      } catch (netErr) {
        console.error('[PublicDemo] Places search unreachable:', netErr.message);
        recordPlacesResult(false, 'unreachable');
        return res.status(503).json({ error: DEMO_BUSY_MSG, unavailable: true });
      }
      if (!resp.ok) {
        console.error(`[PublicDemo] Places search failed: HTTP ${resp.status}`);
        recordPlacesResult(false, `HTTP ${resp.status}`);
        return res.status(503).json({ error: DEMO_BUSY_MSG, unavailable: true });
      }

      const data = await resp.json();
      if (data.error) {
        console.error('[PublicDemo] Places search error:', data.error.message || data.error.status);
        recordPlacesResult(false, 'error body');
        return res.status(503).json({ error: DEMO_BUSY_MSG, unavailable: true });
      }
      recordPlacesResult(true);
      const places = (data.places || []).filter(p => p.location);
      // Cached like any other answer. This was the one response shape that
      // skipped the cache, and it is the cheapest one to ask for repeatedly:
      // lat/lng are rounded to ~1km buckets, so an empty bucket is trivial to
      // find (any stretch of water) and every request for it was a fresh paid
      // Text Search. The header of this file promises area searches are cached
      // for 20 minutes; "we looked here and found nothing" is an area search
      // result like any other. It is a real result, not a swallowed failure —
      // the three checks above already turned every upstream failure into a
      // 503, and none of those are cached.
      if (places.length === 0) {
        const empty = { venues: [] };
        setCache(cacheKey, empty, 20 * 60_000);
        return res.json(empty);
      }

      // One weather lookup for the whole area; venues scored in parallel —
      // serial scoring made the first paint feel like dial-up.
      const weather = await getWeather(lat, lng, ANON).catch(() => null);
      const localDayParam = req.query.localDay != null ? parseInt(req.query.localDay, 10) : null;
      const visitorClock = { time: scoreTime, localHour, localDay };

      const venues = (await Promise.all(places.map(async (p) => {
        const v = toVenueShape(p, localDayParam);
        try {
          const clock = venueClock(p, visitorClock);
          const scored = await mlPredictor.predictBusyness(v, weather, clock.time, ANON);
          return {
            _place: p,
            _shape: v,
            _clock: clock,
            _scored: scored,
            place_id: v.place_id,
            name: v.name,
            address: v.formatted_address,
            rating: v.rating,
            price_level: v.price_level,
            lat: v.location.latitude,
            lng: v.location.longitude,
            is_open: v.isOpen,
            // The photo proxy takes a Google photo resource ref, not a place id.
            //
            // 400, NOT THE 160 A 46px PIN NEEDS, BECAUSE THE WIDTH IS HALF THE
            // CACHE KEY. photoCacheKey is sha256(`${photoRef}|${maxWidth}`)
            // (services/photoStore.js), so a pin at 160 and a card at 400 were
            // two keys, two places_photo_cache rows and two billable Google
            // /media fetches for one photograph — and this demo shows the same
            // venue at both sizes by construction: the featured card below is
            // built from a place object that already has a pin here, and tapping
            // any other pin opens GET /demo/venue/:placeId, whose card asks 400.
            // Every venue a visitor actually looked at was bought twice.
            //
            // Nothing on the page changes: the pin draws as a 46px CSS
            // background (.lpd-pin-photo, background-size: cover), so a wider
            // source scales into the same circle. It transfers about 40 KB
            // instead of about 12 KB, once per viewer per 30 days, since
            // sendPhoto answers Cache-Control public, max-age=2592000,
            // immutable — and Google bills the /media fetch, not the pixels.
            // routes/venueSearch.js photoUrl carries this same rule for the app:
            // never mint a second width for a photo already paid for.
            photo_url: p.photos?.[0]?.name ? `/api/venues/photo?ref=${encodeURIComponent(p.photos[0].name)}&maxwidth=400` : null,
            score: scored.score,
            label: publishedLabel(scored.score, describePredictionSupport(scored.predictionMethod, 0)),
            confidence_basis: describePredictionSupport(scored.predictionMethod, 0).basis,
            // NO `confidence` ON A PIN, and therefore no measurement block. A
            // pin publishes the score and the hedged word, both of which stand
            // on their own; the confidence integer is the field that cannot be
            // read without its provenance, so the rule is one field, not two:
            // publish the number and this block ships with it, or publish
            // neither. If a confidence is ever added to this row, add
            // `confidence_measurement: confidenceMeasurementFor(scored, <that
            // number>, 0)` in the same edit —
            // __tests__/confidenceForwarding.test.js fails if it is not.
          };
        } catch { return null; } // skip venues the model can't score
      }))).filter(Boolean);

      // Embed the busiest venue's full card so the section renders in ONE
      // round trip instead of venues -> card chaining.
      //
      // Round 14: "busiest" alone put a SHUT venue on the hero card — a 74%
      // red dial over the word "Closed", which is the worst card the demo can
      // draw. An open venue always wins the slot; a closed one only gets it
      // when the whole area is shut.
      let card = null;
      if (venues.length > 0) {
        try {
          const rank = (a, b) => (Number(b.is_open !== false) - Number(a.is_open !== false)) || (b.score - a.score);
          const feature = [...venues].sort(rank)[0];
          card = await buildCard(feature._shape, weather, feature._clock, feature._scored, feature._place);
        } catch { /* card arrives via the venue endpoint instead */ }
      }

      const result = {
        venues: venues.map(({ _place, _shape, _clock, _scored, ...v }) => v),
        ...(card ? { card } : {}),
      };

      setCache(cacheKey, result, 20 * 60_000);
      res.json(presentArea(result, req));
      warmDemoPhotos(result.venues, req);
    } catch (err) {
      console.error('[PublicDemo] venues error:', err.message);
      res.status(500).json({ error: DEMO_BUSY_MSG });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/public/demo/venue/:placeId — the full card: dial + forecast + best time
// ---------------------------------------------------------------------------
router.get('/demo/venue/:placeId',
  [
    param('placeId').trim().isLength({ min: 1, max: 200 }),
    query('localHour').optional().isInt({ min: 0, max: 23 }),
    query('localDay').optional().isInt({ min: 0, max: 6 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
      if (!API_KEY) return res.status(503).json({ error: DEMO_BUSY_MSG });

      const placeId = req.params.placeId;
      const { time: scoreTime, localHour, localDay } = clientNow(req);
      const cacheKey = `venue:${placeId}:${localDay}:${localHour}`;
      const cached = getCache(cacheKey);
      if (cached) return res.json(presentCard(cached, req));

      if (!allowDemo(req)) return res.status(429).json({ error: DEMO_BUSY_MSG });
      // One paid Place Details call per cache miss. Same reasoning as the area
      // search above: the per-IP demo gate is not a spending control.
      if (!allowGlobalPlacesCall(1)) return res.status(429).json({ error: DEMO_BUSY_MSG });

      // Round 11: same as the area search — an upstream failure used to read as
      // "Venue not found". Only a real upstream 404 is a 404 now.
      let resp;
      try {
        resp = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
          headers: {
            'X-Goog-Api-Key': API_KEY,
            'X-Goog-FieldMask': PLACE_FIELDS.replaceAll('places.', ''),
          },
          signal: upstreamSignal('places'), // round 12
        });
      } catch (netErr) {
        console.error('[PublicDemo] Places details unreachable:', netErr.message);
        recordPlacesResult(false, 'unreachable');
        return res.status(503).json({ error: DEMO_BUSY_MSG, unavailable: true });
      }
      if (!resp.ok) {
        // A 404 is Google ANSWERING, so it is health, not an outage.
        if (resp.status === 404) recordPlacesResult(true);
        if (resp.status === 404) return res.status(404).json({ error: 'Venue not found' });
        console.error(`[PublicDemo] Places details failed: HTTP ${resp.status}`);
        recordPlacesResult(false, `HTTP ${resp.status}`);
        return res.status(503).json({ error: DEMO_BUSY_MSG, unavailable: true });
      }

      const p = await resp.json();
      if (p.error || !p.id) return res.status(404).json({ error: 'Venue not found' });
      recordPlacesResult(true);

      const v = toVenueShape(p, req.query.localDay != null ? parseInt(req.query.localDay, 10) : null);
      const lat = v.location?.latitude;
      const lng = v.location?.longitude;
      const weather = (lat && lng) ? await getWeather(lat, lng, ANON).catch(() => null) : null;

      const result = await buildCard(v, weather, venueClock(p, { time: scoreTime, localHour, localDay }), null, p);
      setCache(cacheKey, result, 10 * 60_000);
      res.json(presentCard(result, req));
    } catch (err) {
      console.error('[PublicDemo] venue error:', err.message);
      res.status(500).json({ error: DEMO_BUSY_MSG });
    }
  }
);

// Test-only: puts the module back to a cold start so one test's spent
// addresses and day count don't leak into the next. clear() is correct HERE
// precisely because it is not reachable from a request.
function resetDemoLimitsForTest() {
  ipHits.clear();
  cache.clear();
  demoReveals.clear();
  dayKey = new Date().toISOString().slice(0, 10);
  dayCount = 0;
}

module.exports = router;
// Two of the subtlest card bugs live in these two helpers (a weekday
// difference read as a day count, and a cached card claiming to be fresh), so
// they are reachable from the tests rather than only from a live Google key.
// Only the three-a-day memory, for a test that needs a fresh visitor without
// throwing away the cache it is asserting about.
function resetDemoRevealsForTest() {
  demoReveals.clear();
}

module.exports.__testables = {
  clockFor, withAge, buildCard, toVenueShape, gateDemoCard, presentCard, presentArea,
  mayShowCrowd, evictDemoReveals, demoReveals, resetDemoRevealsForTest,
  coverDemoCard, coverDemoPin, DEMO_FREE_VENUES, REVEAL_MAX_ENTRIES, REVEAL_LOW_WATER,
  // Round 15 — the abuse-limit internals, so __tests__/publicDemoAbuse.test.js
  // can pin the eviction ORDER and the ceilings on a seeded map instead of
  // trusting the comments above (documented-but-untested is how the clear()
  // guard shipped in the first place).
  allowDemo, evictIpHits, ipHits, setCache, getCache, cache,
  visitorKey, relayVerdict, RELAY_MAX_SKEW_S,
  resetDemoLimitsForTest,
  demoState: () => ({ dayKey, dayCount, trackedIps: ipHits.size }),
  IP_LIMIT, IP_WINDOW_MS, IP_MAX_ENTRIES, IP_LOW_WATER,
  CACHE_MAX_ENTRIES, CACHE_LOW_WATER,
};
