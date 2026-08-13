const express = require('express');
const { param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { getWeather } = require('../services/weatherService');
const mlPredictor = require('../services/mlPredictor');
const { upstreamSignal } = require('../utils/upstream');

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
  const scoreTime = new Date(now);
  scoreTime.setDate(scoreTime.getDate() + (localDay - scoreTime.getDay()));
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

      const r = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
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
