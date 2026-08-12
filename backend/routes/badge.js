const express = require('express');
const { param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { getWeather } = require('../services/weatherService');
const mlPredictor = require('../services/mlPredictor');

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

      // Claimed venues only.
      const claimed = await pool.query(
        'SELECT 1 FROM venue_profiles WHERE google_place_id = $1 LIMIT 1',
        [placeId]
      );
      if (!claimed.rows.length) return res.status(404).send('');
      if (!GOOGLE_KEY) return res.status(503).send('');

      const r = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
        headers: {
          'X-Goog-Api-Key': GOOGLE_KEY,
          'X-Goog-FieldMask': 'id,displayName,types,location,priceLevel,currentOpeningHours',
        },
      });
      const p = await r.json();
      if (p.error) return res.status(404).send('');

      const venue = {
        place_id: p.id,
        name: p.displayName?.text || '',
        types: p.types || [],
        location: p.location || null,
        isOpen: p.currentOpeningHours?.openNow ?? null,
      };

      let svg;
      if (venue.isOpen === false) {
        svg = svgBadge('Closed right now', '#98937f');
      } else {
        const weather = venue.location
          ? await getWeather(venue.location.latitude, venue.location.longitude).catch(() => null)
          : null;
        const pred = await mlPredictor.predictBusyness(venue, weather, new Date());
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
