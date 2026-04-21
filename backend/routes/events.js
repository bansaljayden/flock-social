const express = require('express');
const { query, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const TM_API_KEY = process.env.TICKETMASTER_API_KEY;

// Server-side event cache (1 hour TTL — Ticketmaster free tier has 5K calls/day limit)
const eventCache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

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

// Get the best event image — prefer non-fallback, then check attractions, then fallback
function getBestImage(event) {
  const imgs = event.images || [];
  // Prefer non-fallback 16:9 images
  const real = imgs.filter(i => !i.fallback);
  const best = real.find(i => i.ratio === '16_9' && i.width >= 500)
    || real.find(i => i.ratio === '16_9')
    || real[0];
  if (best) return best.url;

  // Check attraction images (artist/team photos)
  const attractions = event._embedded?.attractions || [];
  for (const a of attractions) {
    const aImgs = (a.images || []).filter(i => !i.fallback);
    const aBest = aImgs.find(i => i.ratio === '16_9' && i.width >= 500)
      || aImgs.find(i => i.ratio === '16_9')
      || aImgs[0];
    if (aBest) return aBest.url;
  }

  // Last resort: any image including fallbacks
  const fallback = imgs.find(i => i.ratio === '16_9' && i.width >= 500)
    || imgs.find(i => i.ratio === '16_9')
    || imgs[0];
  return fallback?.url || null;
}

// Map a raw Ticketmaster event to our clean format
function mapEvent(e) {
  const venue = e._embedded?.venues?.[0];
  const attraction = e._embedded?.attractions?.[0];

  return {
    id: e.id,
    name: e.name,
    category: mapEventCategory(e.classifications),
    date: e.dates?.start?.localDate || null,
    time: e.dates?.start?.localTime || null,
    datetime_utc: e.dates?.start?.dateTime || null,
    venue_name: venue?.name || null,
    venue_address: [venue?.address?.line1, venue?.city?.name, venue?.state?.stateCode].filter(Boolean).join(', '),
    venue_city: venue?.city?.name || null,
    venue_state: venue?.state?.stateCode || null,
    location: venue?.location ? {
      latitude: parseFloat(venue.location.latitude),
      longitude: parseFloat(venue.location.longitude),
    } : null,
    image_url: getBestImage(e),
    price_range: formatPriceRange(e.priceRanges),
    url: e.url || null,
    status: e.dates?.status?.code || null,
    genre: e.classifications?.[0]?.genre?.name || null,
    subgenre: e.classifications?.[0]?.subGenre?.name || null,
    segment: e.classifications?.[0]?.segment?.name || null,
    attraction_name: attraction?.name || null,
    seatmap_url: e.seatmap?.staticUrl || null,
    info: e.info || null,
    please_note: e.pleaseNote || null,
    distance_miles: e.distance || null,
  };
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

      // Search with location bias
      const localParams = new URLSearchParams({
        apikey: TM_API_KEY,
        latlong: `${lat},${lng}`,
        radius: radiusMiles,
        unit: 'miles',
        size: 20,
        sort: 'date,asc',
      });

      if (searchQuery) localParams.set('keyword', searchQuery);
      if (categoryFilter) {
        const segMap = { concert: 'Music', sports: 'Sports', arts: 'Arts & Theatre', film: 'Film', comedy: 'Arts & Theatre' };
        if (segMap[categoryFilter]) localParams.set('classificationName', segMap[categoryFilter]);
      }

      // If user typed a keyword, also search without location (catches team names, artists, etc.)
      const fetches = [fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${localParams}`)];
      if (searchQuery) {
        const wideParams = new URLSearchParams({
          apikey: TM_API_KEY,
          keyword: searchQuery,
          size: 15,
          sort: 'date,asc',
          countryCode: 'US',
        });
        if (categoryFilter) {
          const segMap = { concert: 'Music', sports: 'Sports', arts: 'Arts & Theatre', film: 'Film', comedy: 'Arts & Theatre' };
          if (segMap[categoryFilter]) wideParams.set('classificationName', segMap[categoryFilter]);
        }
        fetches.push(fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${wideParams}`));
      }

      const responses = await Promise.all(fetches);

      // Handle Ticketmaster rate limits gracefully — return empty instead of 500
      if (responses[0].status === 429) {
        console.warn('[Events] Ticketmaster rate limited — returning empty');
        const empty = { events: [], total: 0 };
        setCache(cacheKey, empty); // cache the empty result so we don't re-hit
        return res.json(empty);
      }

      const localData = responses[0].ok ? await responses[0].json() : {};
      const wideData = responses[1]?.ok ? await responses[1].json() : {};

      // Merge: local results first, then wide results (deduped)
      const localEvents = localData._embedded?.events || [];
      const wideEvents = wideData._embedded?.events || [];
      const seenIds = new Set(localEvents.map(e => e.id));
      const rawEvents = [...localEvents, ...wideEvents.filter(e => !seenIds.has(e.id))].slice(0, 30);

      const events = rawEvents.map(mapEvent);

      const result = { events, total: events.length };
      setCache(cacheKey, result);
      res.json(result);
    } catch (err) {
      console.error('[Events] Search error:', err);
      res.json({ events: [], total: 0 }); // graceful degradation — never 500 for events
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

      if (response.status === 429 || !response.ok) {
        // Rate limited or failed — gracefully return empty, cache it
        console.warn('[Events] Featured: Ticketmaster', response.status, '— returning empty');
        const empty = { events: [], total: 0 };
        setCache(cacheKey, empty);
        return res.json(empty);
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

      const events = rawEvents.map(mapEvent);

      const result = { events, total: events.length };
      setCache(cacheKey, result);
      res.json(result);
    } catch (err) {
      console.error('[Events] Featured error:', err);
      res.status(500).json({ error: 'Failed to get featured events' });
    }
  }
);

// GET /api/events/details?id=xxx — Full event details (like venue details page)
router.get('/details',
  query('id').trim().isLength({ min: 1 }).withMessage('Event ID is required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      if (!TM_API_KEY) {
        return res.status(500).json({ error: 'Ticketmaster API key not configured' });
      }

      const eventId = req.query.id;
      const cacheKey = `event_detail:${eventId}`;
      const cached = getCached(cacheKey);
      if (cached) return res.json(cached);

      const response = await fetch(`https://app.ticketmaster.com/discovery/v2/events/${eventId}?apikey=${TM_API_KEY}`);

      if (!response.ok) {
        return res.status(response.status === 404 ? 404 : 502).json({ error: 'Event not found' });
      }

      const e = await response.json();
      const venue = e._embedded?.venues?.[0];
      const attraction = e._embedded?.attractions?.[0];

      // Collect unique images — TM serves same photo in many sizes, dedupe by base filename
      const getImageKey = (url) => {
        // Extract the unique image hash from URL (e.g. "c9d1f714-57de-4e29-9d62-cb403420d615")
        const match = url.match(/\/([a-f0-9-]{20,})_/);
        return match ? match[1] : url;
      };
      const allImgs = (e.images || []).filter(i => !i.fallback);
      const attractionImgs = (attraction?.images || []).filter(i => !i.fallback);
      const seenKeys = new Set();
      const photos = [...allImgs, ...attractionImgs]
        .filter(i => i.ratio === '16_9' && i.width >= 500)
        .sort((a, b) => (b.width || 0) - (a.width || 0))
        .filter(i => { const k = getImageKey(i.url); if (seenKeys.has(k)) return false; seenKeys.add(k); return true; })
        .slice(0, 4)
        .map(i => i.url);

      const result = {
        event: {
          ...mapEvent(e),
          // Extended details
          photos,
          venue_details: venue ? {
            name: venue.name,
            address: venue.address?.line1 || null,
            city: venue.city?.name || null,
            state: venue.state?.stateCode || null,
            postal_code: venue.postalCode || null,
            country: venue.country?.name || null,
            location: venue.location ? {
              latitude: parseFloat(venue.location.latitude),
              longitude: parseFloat(venue.location.longitude),
            } : null,
            upcoming_events: venue.upcomingEvents?._total || 0,
          } : null,
          attractions: (e._embedded?.attractions || []).map(a => ({
            name: a.name,
            url: a.url || null,
            image_url: getBestImage({ images: a.images || [], _embedded: {} }),
          })),
          date_end: e.dates?.end?.localDate || null,
          time_end: e.dates?.end?.localTime || null,
          timezone: e.dates?.timezone || null,
          on_sale: e.dates?.status?.code === 'onsale',
          ticketing: e.ticketing ? {
            safe_tix: e.ticketing.safeTix?.enabled || false,
          } : null,
        },
      };

      setCache(cacheKey, result);
      res.json(result);
    } catch (err) {
      console.error('[Events] Details error:', err);
      res.status(500).json({ error: 'Failed to get event details' });
    }
  }
);

module.exports = router;
