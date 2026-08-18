const express = require('express');
const { param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { getWeather } = require('../services/weatherService');
const mlPredictor = require('../services/mlPredictor');
const { upstreamSignal } = require('../utils/upstream');
const { allowGlobalPlacesCall } = require('../utils/placesBudget');
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
const cache = new Map();
const TTL = 15 * 60 * 1000;

const LABEL_COLORS = {
  // label -> [dot, text] on the cream badge
  Quiet: ['#22c55e', 'Quiet right now'],
  'Not Busy': ['#22c55e', 'Quiet right now'],
  Moderate: ['#f59e0b', 'Filling up'],
  Busy: ['#ef4444', 'Busy right now'],
  Packed: ['#ef4444', 'Packed right now'],
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

      const hit = cache.get(placeId);
      if (hit && Date.now() - hit.ts < TTL) {
        res.set('Content-Type', 'image/svg+xml');
        res.set('Cache-Control', 'public, max-age=900');
        return res.send(hit.svg);
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
        return res.status(503).send('');
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
        const weather = venue.location
          ? await getWeather(venue.location.latitude, venue.location.longitude).catch(() => null)
          : null;
        const { scoreTime } = venueLocalTime(
          venue.location?.latitude, venue.location?.longitude
        );
        const pred = await mlPredictor.predictBusyness(venue, weather, scoreTime);
        const [dot, text] = LABEL_COLORS[pred.label] || ['#2d5a87', `${pred.label} right now`];
        svg = svgBadge(text, dot);
      }

      cache.set(placeId, { ts: Date.now(), svg });
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
