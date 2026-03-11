const express = require('express');
const { query, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const TM_API_KEY = process.env.TICKETMASTER_API_KEY;

// Server-side event cache (10 min TTL — events don't change often)
const eventCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function getCached(key) {
  const entry = eventCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  if (entry) eventCache.delete(key);
  return null;
}

function setCache(key, data) {
  eventCache.set(key, { data, ts: Date.now() });
  if (eventCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of eventCache) {
      if (now - v.ts > CACHE_TTL) eventCache.delete(k);
    }
  }
}

// Map Ticketmaster segment to simple category
function mapEventCategory(classifications) {
  if (!classifications || !classifications[0]) return 'other';
  const seg = (classifications[0].segment?.name || '').toLowerCase();
  const genre = (classifications[0].genre?.name || '').toLowerCase();
  if (seg.includes('music')) return 'concert';
  if (seg.includes('sport')) return 'sports';
  if (seg.includes('arts') || seg.includes('theatre') || seg.includes('theater')) return 'arts';
  if (seg.includes('film')) return 'film';
  if (genre.includes('comedy')) return 'comedy';
  if (genre.includes('festival')) return 'festival';
  return 'other';
}

// Format price range
function formatPriceRange(priceRanges) {
  if (!priceRanges || !priceRanges[0]) return null;
  const p = priceRanges[0];
  if (p.min && p.max) return { min: p.min, max: p.max, currency: p.currency || 'USD' };
  if (p.min) return { min: p.min, max: null, currency: p.currency || 'USD' };
  return null;
}

// All routes require auth
router.use(authenticate);

// GET /api/events/search?location=lat,lng&query=concerts&radius=30
router.get('/search',
  [
    query('location').trim().isLength({ min: 3 }).withMessage('Location (lat,lng) is required'),
    query('query').optional().trim(),
    query('radius').optional().isInt({ min: 1, max: 100 }),
    query('category').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      if (!TM_API_KEY) {
        return res.status(500).json({ error: 'Ticketmaster API key not configured' });
      }

      const location = req.query.location;
      const searchQuery = req.query.query || '';
      const radiusMiles = parseInt(req.query.radius) || 50;
      const categoryFilter = req.query.category || '';

      const cacheKey = `events:${location}|${searchQuery}|${radiusMiles}|${categoryFilter}`;
      const cached = getCached(cacheKey);
      if (cached) return res.json(cached);

      const [lat, lng] = location.split(',').map(Number);

      const params = new URLSearchParams({
        apikey: TM_API_KEY,
        latlong: `${lat},${lng}`,
        radius: radiusMiles,
        unit: 'miles',
        size: 30,
        sort: 'date,asc',
      });

      if (searchQuery) params.set('keyword', searchQuery);
      if (categoryFilter) {
        const segMap = { concert: 'Music', sports: 'Sports', arts: 'Arts & Theatre', film: 'Film', comedy: 'Arts & Theatre' };
        if (segMap[categoryFilter]) params.set('classificationName', segMap[categoryFilter]);
      }

      const response = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`);

      if (!response.ok) {
        console.error('[Events] Ticketmaster API error:', response.status);
        return res.status(502).json({ error: 'Event search failed' });
      }

      const data = await response.json();
      const rawEvents = data._embedded?.events || [];

      const events = rawEvents.map(e => {
        const venue = e._embedded?.venues?.[0];
        const image = e.images?.find(img => img.ratio === '16_9' && img.width >= 500)
          || e.images?.find(img => img.ratio === '16_9')
          || e.images?.[0];

        return {
          id: e.id,
          name: e.name,
          category: mapEventCategory(e.classifications),
          date: e.dates?.start?.localDate || null,
          time: e.dates?.start?.localTime || null,
          datetime_utc: e.dates?.start?.dateTime || null,
          venue_name: venue?.name || null,
          venue_address: [venue?.address?.line1, venue?.city?.name, venue?.state?.stateCode].filter(Boolean).join(', '),
          location: venue?.location ? {
            latitude: parseFloat(venue.location.latitude),
            longitude: parseFloat(venue.location.longitude),
          } : null,
          image_url: image?.url || null,
          price_range: formatPriceRange(e.priceRanges),
          url: e.url || null,
          status: e.dates?.status?.code || null,
          genre: e.classifications?.[0]?.genre?.name || null,
        };
      });

      const result = { events, total: events.length };
      setCache(cacheKey, result);
      res.json(result);
    } catch (err) {
      console.error('[Events] Search error:', err);
      res.status(500).json({ error: 'Failed to search events' });
    }
  }
);

// GET /api/events/featured?location=lat,lng&interests=Live+Music,Sports — curated "what's happening nearby"
router.get('/featured',
  [
    query('location').trim().isLength({ min: 3 }).withMessage('Location (lat,lng) is required'),
    query('interests').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      if (!TM_API_KEY) {
        return res.status(500).json({ error: 'Ticketmaster API key not configured' });
      }

      const location = req.query.location;
      const interests = req.query.interests || '';
      const cacheKey = `featured:${location}|${interests}`;
      const cached = getCached(cacheKey);
      if (cached) return res.json(cached);

      const [lat, lng] = location.split(',').map(Number);

      // Map user interests to Ticketmaster classification keywords
      const interestToTM = {
        'live music': 'Music',
        'cocktails': '',
        'beer & brews': '',
        'sports': 'Sports',
        'dancing': 'Music',
        'karaoke': 'Music',
        'comedy': 'Arts & Theatre',
        'wine': '',
        'gaming': '',
        'art & culture': 'Arts & Theatre',
        'food': '',
        'chill vibes': '',
        'nightlife': 'Music',
      };

      // Build classification filter from interests
      const tmClassifications = [...new Set(
        interests.toLowerCase().split(',').map(i => interestToTM[i.trim()]).filter(Boolean)
      )];

      // Fetch upcoming events in the next 7 days
      const startDate = new Date();
      const endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const fmt = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

      const params = new URLSearchParams({
        apikey: TM_API_KEY,
        latlong: `${lat},${lng}`,
        radius: 30,
        unit: 'miles',
        size: 20,
        sort: 'relevance,desc',
        startDateTime: fmt(startDate),
        endDateTime: fmt(endDate),
      });

      // If user has relevant interests, filter by classification
      if (tmClassifications.length > 0 && tmClassifications.length <= 2) {
        params.set('classificationName', tmClassifications.join(','));
      }

      const response = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`);

      if (!response.ok) {
        return res.status(502).json({ error: 'Event search failed' });
      }

      const data = await response.json();
      let rawEvents = data._embedded?.events || [];

      // If we filtered by classification and got few results, fetch more without filter
      if (tmClassifications.length > 0 && rawEvents.length < 5) {
        params.delete('classificationName');
        const fallbackRes = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`);
        if (fallbackRes.ok) {
          const fallbackData = await fallbackRes.json();
          const fallbackEvents = fallbackData._embedded?.events || [];
          // Merge: interest-matched first, then others
          const existingIds = new Set(rawEvents.map(e => e.id));
          rawEvents = [...rawEvents, ...fallbackEvents.filter(e => !existingIds.has(e.id))].slice(0, 20);
        }
      }

      const events = rawEvents.map(e => {
        const venue = e._embedded?.venues?.[0];
        const image = e.images?.find(img => img.ratio === '16_9' && img.width >= 500)
          || e.images?.find(img => img.ratio === '16_9')
          || e.images?.[0];

        return {
          id: e.id,
          name: e.name,
          category: mapEventCategory(e.classifications),
          date: e.dates?.start?.localDate || null,
          time: e.dates?.start?.localTime || null,
          datetime_utc: e.dates?.start?.dateTime || null,
          venue_name: venue?.name || null,
          venue_address: [venue?.address?.line1, venue?.city?.name, venue?.state?.stateCode].filter(Boolean).join(', '),
          location: venue?.location ? {
            latitude: parseFloat(venue.location.latitude),
            longitude: parseFloat(venue.location.longitude),
          } : null,
          image_url: image?.url || null,
          price_range: formatPriceRange(e.priceRanges),
          url: e.url || null,
          genre: e.classifications?.[0]?.genre?.name || null,
        };
      });

      const result = { events, total: events.length };
      setCache(cacheKey, result);
      res.json(result);
    } catch (err) {
      console.error('[Events] Featured error:', err);
      res.status(500).json({ error: 'Failed to get featured events' });
    }
  }
);

module.exports = router;
