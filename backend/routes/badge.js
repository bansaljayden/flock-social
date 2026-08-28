const express = require('express');
const { param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { getWeather } = require('../services/weatherService');
const mlPredictor = require('../services/mlPredictor');
const { upstreamSignal } = require('../utils/upstream');
// The ONE shape rule for a Google place id. routes/checkin.js, flocks.js,
// feedback.js, venueProfile.js, venueDashboard.js, venueSearch.js, crowd.js and
// sockets/handlers.js all gate on this; the badge was the last paid Places
// surface that did not. Imported, never re-typed: a second copy of the regex is
// a second thing to keep in step with the first.
const { isPlaceIdShaped } = require('../utils/places');
const { allowGlobalPlacesCall, GLOBAL_DAILY } = require('../utils/placesBudget');
const { setRetryAfter, msUntilUtcMidnight } = require('../utils/retryAfter');
const { weekdayOffset } = require('../services/crowdEngine');

const router = express.Router();

// ---------------------------------------------------------------------------
// Embeddable live-busyness badge (public, no auth).
//   <img src="https://.../api/badge/<placeId>.svg" alt="How busy is it?">
// A venue drops this on its website; every embed shows Flock's name on the
// venue's own audience. Zero-user venue value: powered by the crowd model,
// needs no consumer accounts.
//
// Abuse control: badges are served ONLY for venues that exist in
// venue_profiles (claimed venues). Unknown placeIds cost us nothing — no
// Google fetch, just a 404 — so the public endpoint can't be used to burn
// Places API quota. Results cache for 15 minutes.
//
// ---------------------------------------------------------------------------
// THIS ROUTE IS DELIBERATELY NOT BEHIND THE FLOCK PRO FORECAST GATE.
//
// Round 20 gated the forecast on every other surface that serves it
// (routes/crowd.js, routes/publicCrowd.js, routes/ai.js). This one was audited
// in the same pass and left open, on purpose, for three reasons:
//
//   1. THERE IS NOTHING HERE TO GATE. The gate sells three things: the best
//      time to go, the peak window, and the 24-hour curve. This endpoint
//      computes none of them. It calls predictBusyness once, for right now, and
//      renders the resulting LABEL as five words on a pill. "How busy is it
//      right now" is the free half on every other surface too, and gating it
//      here would gate the free tier.
//   2. THE AUDIENCE IS THE VENUE'S OWN CUSTOMERS. A person reading this is on a
//      bar's website deciding whether to walk over. They are not a Flock user
//      routing around a wall; most of them have never heard of Flock, which is
//      the entire point of the wordmark in the corner. This is distribution.
//   3. IT IS ALREADY EARNED. Only a CLAIMED and VERIFIED venue gets a badge,
//      which is a venue-side entitlement check (see the query below), not an
//      absence of one.
//
// The reconstruction question, asked and answered: polling this URL hourly for
// a day yields 24 OBSERVED labels for one venue, which is a log of what
// happened, not a forecast of what will. It also takes 24 hours per venue and
// only works on venues that already chose to publish the number. The 15-minute
// cache means you cannot go faster.
//
// WHAT WOULD CHANGE THIS: any badge variant that prints a time. "Best time to
// go tonight", "quiet after 10", a sparkline, an hourly strip. The moment this
// file calls predictHourlyForecast, findPeakTime or recommendBestTime it is
// serving the paid product to an unauthenticated caller with no meter, and it
// needs the gate that routes/publicCrowd.js now has.
// __tests__/forecastGateParity.test.js fails if any of those three appear here.
// ---------------------------------------------------------------------------

const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;

// ---------------------------------------------------------------------------
// The badge cache (round 23: it had no bound at all).
// ---------------------------------------------------------------------------
// This was `const cache = new Map()` with a read-time TTL check and nothing
// else — no maxEntries, no sweep. Writes are gated behind "the venue exists in
// venue_profiles AND verified = true", so in practice the stored key space is
// the verified-venue set and it is small today. That is an argument about the
// data, not a bound in the code: the day the verified set is large, or the day
// somebody relaxes that WHERE clause, this map grows until the process dies,
// and an expired entry that is never read again is never deleted. Give it the
// bound its siblings have (services/weatherService.js, routes/venueSearch.js):
// expire first, then oldest-first down to a low-water mark, with a
// delete-before-set so a refreshed key moves to the END of insertion order.
// Without that, Map.set keeps a key's original position and oldest-first
// evicts the HOTTEST badge in the map.
const cache = new Map();
const TTL = 15 * 60 * 1000;
const BADGE_CACHE_MAX = 500;
const BADGE_CACHE_LOW_WATER = Math.floor(BADGE_CACHE_MAX * 0.9);

function getBadge(placeId) {
  const hit = cache.get(placeId);
  if (!hit) return null;
  if (Date.now() - hit.ts >= TTL) { cache.delete(placeId); return null; }
  return hit.svg;
}

function setBadge(placeId, svg) {
  cache.delete(placeId);
  cache.set(placeId, { ts: Date.now(), svg });
  if (cache.size <= BADGE_CACHE_MAX) return;
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.ts >= TTL) cache.delete(k);
  if (cache.size <= BADGE_CACHE_MAX) return;
  while (cache.size > BADGE_CACHE_LOW_WATER) cache.delete(cache.keys().next().value);
}

// ---------------------------------------------------------------------------
// The badge's caller dimension (round 23).
// ---------------------------------------------------------------------------
// utils/placesBudget.js names this itself as "THE REMAINING HOLE": the paid
// surfaces with no authenticated user charge GLOBAL_DAILY and nothing else, so
// the shared 3000-call day is a denial lever for anyone who can show up often
// enough. Of the three such doors, the public demo already carries a per-IP
// gate (20/IP/hour) AND its own 600/day sub-ceiling, and the photo proxy
// carries 300/IP/hour; the badge carried NEITHER. It had a 15-minute cache and
// a verified-venue check, which bound how often ONE venue costs money but put
// no ceiling at all on one address, and — before the shape gate below — no
// ceiling on how many unauthenticated Postgres lookups one address could force
// with 300-character junk.
//
// A per-account budget cannot apply where there is no account, so the honest
// dimension here is the source address, in the same shape routes/publicCrowd.js
// uses: expire first, evict LEAST CONSUMED first, never clear(). Consumption
// order for the reason that file spells out — a flooder spends their allowance
// and only then sprays fresh addresses, so their own entry is both the oldest
// and the fullest, and any age-ordered drop deletes precisely the counter they
// wanted gone.
//
// THE PIN: BADGE_DAILY (600) < GLOBAL_DAILY (3000). A sub-ceiling that sits
// above the ceiling it is meant to be under is not a sub-ceiling, it is a
// comment. (routes/venueSearch.js's photo leg was exactly that until this
// round.) At 600 the badge surface can never spend more than a fifth of the
// day's Google invoice, so a flood of badge misses cannot deny Places to the
// authenticated product.
//
// Cache HITS are free and never counted: an embed on a busy venue page serves
// thousands of readers off one entry, and charging them would refuse the badge
// to the audience it exists to reach. Only a MISS — the thing that costs a
// Postgres round trip and possibly a paid Place Details call — is metered.
// See the note at the weather call below: this file has no authenticated caller,
// so its upstream spend belongs in the unauthenticated share of each ledger.
const ANON = Object.freeze({ anonymous: true });

const BADGE_IP_HOURLY = 120;
const BADGE_IP_WINDOW_MS = 3600_000;
const BADGE_DAILY = 600;
const BADGE_IP_MAX_ENTRIES = 5000;
const BADGE_IP_LOW_WATER = Math.floor(BADGE_IP_MAX_ENTRIES * 0.9);
const badgeIpHits = new Map(); // ip -> [timestamps]
let badgeDayKey = new Date().toISOString().slice(0, 10);
let badgeDayCount = 0;

function evictBadgeIpHits(now) {
  for (const [k, v] of badgeIpHits) {
    const live = v.filter((t) => now - t < BADGE_IP_WINDOW_MS);
    if (live.length === 0) badgeIpHits.delete(k);
    else if (live.length !== v.length) badgeIpHits.set(k, live);
  }
  if (badgeIpHits.size <= BADGE_IP_MAX_ENTRIES) return;
  const byConsumption = [...badgeIpHits.entries()].sort((a, b) => a[1].length - b[1].length);
  for (const [k] of byConsumption) {
    if (badgeIpHits.size <= BADGE_IP_LOW_WATER) break;
    badgeIpHits.delete(k);
  }
}

// True when this address may pay for one badge MISS. A refusal consumes
// nothing, so a throttled address recovers on the window rather than being
// pushed further out by its own retries.
// How long this address, or the whole process, waits. Non-consuming, and only
// meaningful once allowBadgeMiss has already refused. Both legs are knowable
// exactly: BADGE_DAILY rolls at UTC midnight, and the per-address window is a
// rolling hour whose oldest live hit is already in the map.
function badgeRetryMs(req) {
  const today = new Date().toISOString().slice(0, 10);
  if (today === badgeDayKey && badgeDayCount >= BADGE_DAILY) return msUntilUtcMidnight();
  const now = Date.now();
  const hits = (badgeIpHits.get(req.ip || 'unknown') || []).filter((t) => now - t < BADGE_IP_WINDOW_MS);
  if (hits.length < BADGE_IP_HOURLY) return 0;
  return Math.max(1, hits[hits.length - BADGE_IP_HOURLY] + BADGE_IP_WINDOW_MS - now);
}

function allowBadgeMiss(req) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== badgeDayKey) { badgeDayKey = today; badgeDayCount = 0; }
  if (badgeDayCount >= BADGE_DAILY) return false;

  const now = Date.now();
  const ip = req.ip || 'unknown';
  const hits = (badgeIpHits.get(ip) || []).filter((t) => now - t < BADGE_IP_WINDOW_MS);
  if (hits.length >= BADGE_IP_HOURLY) return false;
  hits.push(now);
  badgeIpHits.set(ip, hits);
  if (badgeIpHits.size > BADGE_IP_MAX_ENTRIES) evictBadgeIpHits(now);
  badgeDayCount++;
  return true;
}

const LABEL_COLORS = {
  // label -> [dot, text] on the cream badge. Re-cut 2026-08-28 with the
  // ladder (crowdEngine.js getLabel): red is reserved for Packed, because
  // under the calibrated venue-relative scale Busy is a normal good evening,
  // not an alarm. 'Moderate' and 'Very Busy' stay as legacy aliases for
  // anything upstream still caching the old words.
  Quiet: ['#22c55e', 'Quiet right now'],
  'Not Busy': ['#22c55e', 'Quiet right now'],
  Steady: ['#f59e0b', 'Steady for this spot'],
  Moderate: ['#f59e0b', 'Steady for this spot'],
  Busy: ['#f59e0b', 'Busy for this spot'],
  Packed: ['#ef4444', 'Packed right now'],
  'Very Busy': ['#ef4444', 'Packed right now'],
};

// Google Places v1 returns price as an enum; the crowd model and the rule
// engine both want the legacy 0–4 number.
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

// Round 10: the badge used to score venues with `new Date()`, i.e. the Railway
// process clock (UTC). The predictor reads day/hour off that Date, so a Tokyo
// venue at 9 PM local was scored as noon, and either side of midnight it was
// scored on the wrong DAY. Authenticated routes take localHour/localDay from
// the client (see routes/crowd.js); a badge is an <img> on someone else's
// website, so there is no client clock to ask — the venue's own coordinates
// are the only time signal available.
//
// Approach: estimate the venue's UTC offset from longitude (15° per hour),
// then build a Date whose SERVER-local fields read as the venue's wall clock —
// the same shifted-Date contract crowd.js uses for localHour/localDay.
//
// Accuracy limits, deliberately accepted for a 15-minute-cached status pill:
//   - No DST. Off by an hour for roughly half the year in DST regions.
//   - No political timezone borders. Wrong by 1–3 h where a country runs one
//     clock across many meridians (China ~+2 h, Spain ~+1 h, India/Nepal and
//     other :30/:45 offsets round to the nearest hour).
//   - Worst realistic case is ~3 h, which can move a venue one busyness band
//     and, near midnight, one weekday.
// A real tz lookup (tz-lookup / Intl with an IANA zone from a boundary file)
// would fix all three, but every option is a new dependency. If the badge ever
// carries more than a pill, store the IANA zone on venue_profiles at claim
// time and format with Intl.DateTimeFormat instead.
function venueLocalTime(lat, lng, now = new Date()) {
  const offsetHours = Math.max(-12, Math.min(14, Math.round((Number(lng) || 0) / 15)));
  const wallMs = now.getTime() + offsetHours * 3600 * 1000;
  const asIfUtc = new Date(wallMs);
  const localHour = asIfUtc.getUTCHours();
  const localDay = asIfUtc.getUTCDay();

  // Same construction as routes/crowd.js: shift the server-local Date so its
  // getDay()/getHours() report the venue's wall clock.
  //
  // Round 20: this said "same construction as routes/crowd.js" while doing the
  // thing round 14 removed from routes/crowd.js. `localDay - getDay()` is a
  // SIGNED WEEKDAY DIFFERENCE being used as a number of days: on a UTC Sunday a
  // venue west of the date line is still on Saturday, so it computed 6 - 0 = +6
  // and built a timestamp SIX DAYS IN THE FUTURE. The weekday and the hour come
  // out right, which is exactly why it hid for six rounds, but the DATE feeds
  // is_holiday, is_school_break, the v2.5 special-night features and the
  // Ticketmaster event window, so the badge on a venue's own website was scored
  // against next week's calendar. crowdEngine.weekdayOffset is the nearest
  // matching weekday (-3..+3), which is the only reading that means "this
  // venue, now", and it is what every other caller in the repo already uses.
  const scoreTime = new Date(now);
  scoreTime.setDate(scoreTime.getDate() + weekdayOffset(scoreTime.getDay(), localDay));
  scoreTime.setHours(localHour, 0, 0, 0);
  return { localHour, localDay, offsetHours, scoreTime };
}

function svgBadge(text, dotColor) {
  // Simple pill: dot + status + wordmark. Width fits the text loosely.
  const width = 150 + text.length * 6;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="36" role="img" aria-label="${text} - live from Flock">
  <rect width="${width}" height="36" rx="18" fill="#f1ede0" stroke="#16283d" stroke-opacity="0.15"/>
  <circle cx="20" cy="18" r="5" fill="${dotColor}"/>
  <text x="33" y="23" font-family="Georgia, 'Times New Roman', serif" font-size="14" font-weight="600" fill="#16283d">${text}</text>
  <text x="${width - 12}" y="23" text-anchor="end" font-family="-apple-system, 'Segoe UI', sans-serif" font-size="11" font-weight="700" fill="#2d5a87">Flock</text>
</svg>`;
}

router.get('/:placeId.svg',
  param('placeId').trim().isLength({ min: 4, max: 300 }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).send('');
      const placeId = req.params.placeId;

      // SHAPE BEFORE ANYTHING THAT COSTS (round 23). `isLength({min:4,max:300})`
      // was the only thing standing between an unauthenticated caller and a
      // Postgres lookup: any 300-character string reached the query below, and a
      // spray of distinct junk strings was a spray of distinct unauthenticated
      // queries on the 20-connection primary pool. A non-shaped id cannot match
      // a google_place_id row, so refusing it here loses nothing and costs
      // nothing. 404 — the same answer an unknown venue already gets, so the
      // refusal is not a new oracle for which ids are the right shape.
      if (!isPlaceIdShaped(placeId)) return res.status(404).send('');

      const cachedSvg = getBadge(placeId);
      if (cachedSvg) {
        res.set('Content-Type', 'image/svg+xml');
        res.set('Cache-Control', 'public, max-age=900');
        return res.send(cachedSvg);
      }

      // Everything past this line costs: one Postgres round trip, and on a
      // verified venue a paid Place Details call. Meter the MISS, per address.
      //
      // THIS WAS THE ONLY 429 IN THE CODEBASE WITH NO BODY AT ALL. What the
      // venue saw was a broken image on their own homepage and nothing to
      // search for: no sentence, no status text they would ever read, and no
      // header telling their browser or their CDN when to come back. The person
      // best placed to notice was the one told least.
      //
      // So it answers with a real SVG saying so, and with Retry-After, which is
      // the one channel an <img> tag can act on. The status stays 429 because
      // that is what this is; browsers paint an image body regardless, and a
      // venue owner who opens the URL directly now reads a sentence.
      if (!allowBadgeMiss(req)) {
        const ms = badgeRetryMs(req);
        setRetryAfter(res, ms);
        res.set('Content-Type', 'image/svg+xml');
        // Never cache a refusal for the 15 minutes a real badge is cached for.
        res.set('Cache-Control', 'no-store');
        return res.status(429).send(svgBadge('Live status paused', '#98937f'));
      }

      // Claimed AND verified venues only — the badge burns Google quota and
      // speaks with Flock's name; unverified claims get neither.
      const claimed = await pool.query(
        'SELECT 1 FROM venue_profiles WHERE google_place_id = $1 AND verified = true LIMIT 1',
        [placeId]
      );
      if (!claimed.rows.length) return res.status(404).send('');
      if (!GOOGLE_KEY) return res.status(503).send('');

      // The claimed-and-verified check plus the 15-minute cache are a fine rate
      // limit, but they are not a spending limit: this is a PAID Place Details
      // call with no authenticated user to charge, so until now it spent Google
      // money entirely outside the "global" daily ceiling. Charged BEFORE the
      // fetch, because Google bills a request it received even if we abort it.
      // One unit: one Place Details call per cache miss.
      if (!allowGlobalPlacesCall(1)) {
        console.warn('[Badge] Global Places budget spent; serving no badge for', placeId);
        // Same empty-body defect one status code along, and this leg lasts
        // until UTC midnight rather than an hour, so a badge that says nothing
        // here is a badge that says nothing all evening.
        const ms = msUntilUtcMidnight();
        setRetryAfter(res, ms);
        res.set('Content-Type', 'image/svg+xml');
        res.set('Cache-Control', 'no-store');
        return res.status(503).send(svgBadge('Live status paused', '#98937f'));
      }

      const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
        headers: {
          'X-Goog-Api-Key': GOOGLE_KEY,
          // Round 10: rating/userRatingCount/priceLevel are all consumed by the
          // ML feature vector AND the rule fallback. Dropping them made the
          // public badge disagree with the in-app number for the same venue.
          'X-Goog-FieldMask': 'id,displayName,types,location,rating,userRatingCount,priceLevel,currentOpeningHours',
        },
        signal: upstreamSignal('places'), // round 12 — see utils/upstream.js
      });
      const p = await r.json();
      if (p.error) return res.status(404).send('');

      const venue = {
        place_id: p.id,
        name: p.displayName?.text || '',
        types: p.types || [],
        location: p.location || null,
        rating: p.rating ?? null,
        user_ratings_total: p.userRatingCount ?? 0,
        price_level: priceLevelToNum(p.priceLevel),
        isOpen: p.currentOpeningHours?.openNow ?? null,
      };

      let svg;
      if (venue.isOpen === false) {
        svg = svgBadge('Closed right now', '#98937f');
      } else {
        // NOBODY IS BEHIND THIS CALL. The badge is a public SVG: allowBadgeMiss
        // caps it per IP and at BADGE_DAILY, and the Places ledger has carried an
        // unauthenticated share since M5-1, but weather and Ticketmaster were
        // charged against their global ceilings alone. BADGE_DAILY (600) and the
        // demo's own 600 sum to 1200 against a WX_DAILY of 950, so the two doors
        // with no account could take the whole weather day between them. The
        // marker puts these in the unauthenticated bucket instead. See
        // services/weatherService.js WX_UNAUTH_DAILY and services/mlPredictor.js
        // EVENT_UNAUTH_DAILY.
        const weather = venue.location
          ? await getWeather(venue.location.latitude, venue.location.longitude, ANON).catch(() => null)
          : null;
        const { scoreTime } = venueLocalTime(
          venue.location?.latitude, venue.location?.longitude
        );
        const pred = await mlPredictor.predictBusyness(venue, weather, scoreTime, ANON);
        const [dot, text] = LABEL_COLORS[pred.label] || ['#2d5a87', `${pred.label} right now`];
        svg = svgBadge(text, dot);
      }

      setBadge(placeId, svg);
      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'public, max-age=900');
      res.send(svg);
    } catch (err) {
      console.error('Badge error:', err.message);
      res.status(500).send('');
    }
  }
);

module.exports = router;
// Exposed for backend/__tests__/forecastGateParity.test.js. The date this badge
// is scored on is invisible from the SVG it returns (the pill prints a label,
// never a date), which is exactly why the six-days-in-the-future bug above
// survived so long: no black-box test of this route could have seen it.
module.exports.__testables = { venueLocalTime };

// Round 23 — __tests__/badgeCacheBounds.test.js drives these directly. The
// budget constants are exported so the test pins the INEQUALITY
// (BADGE_DAILY < GLOBAL_DAILY) against both files' real numbers rather than
// against two copies that can drift apart.
module.exports.__test = {
  BADGE_CACHE_MAX,
  BADGE_CACHE_LOW_WATER,
  BADGE_IP_HOURLY,
  BADGE_DAILY,
  GLOBAL_DAILY,
  TTL,
  getBadge,
  setBadge,
  allowBadgeMiss,
  cacheSize: () => cache.size,
  resetBadgeBudget({ clearIps = true } = {}) {
    badgeDayKey = new Date().toISOString().slice(0, 10);
    badgeDayCount = 0;
    if (clearIps) badgeIpHits.clear();
    cache.clear();
  },
};
