const express = require('express');
const { query, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

// Server-side venue search cache (5 min TTL)
const venueCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(key) {
  const entry = venueCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  if (entry) venueCache.delete(key);
  return null;
}

function setCache(key, data) {
  venueCache.set(key, { data, ts: Date.now() });
  // Evict old entries if cache grows too large
  if (venueCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of venueCache) {
      if (now - v.ts > CACHE_TTL) venueCache.delete(k);
    }
  }
}

// Build photo URL from a Places API (New) photo resource name
function photoUrl(photoName, maxWidth = 400) {
  return `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${maxWidth}&key=${API_KEY}`;
}

// Map price level enum to numeric
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

// GET /api/venues/search?query=restaurants+wildwood&location=lat,lng
router.get('/search',
  [
    query('query').trim().isLength({ min: 1 }).withMessage('Search query is required'),
    query('location').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      if (!API_KEY) {
        return res.status(500).json({ error: 'Google Places API key not configured' });
      }

      const searchQuery = req.query.query;
      const location = req.query.location; // "lat,lng"

      // Check server-side cache first
      const cacheKey = `search:${searchQuery}|${location || ''}`;
      const cached = getCached(cacheKey);
      if (cached) {
        return res.json(cached);
      }

      // Use Places API (New) - Text Search
      const body = { textQuery: searchQuery };
      if (location) {
        const [lat, lng] = location.split(',').map(Number);
        body.locationBias = {
          circle: { center: { latitude: lat, longitude: lng }, radius: 20000.0 }
        };
      }

      const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': API_KEY,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.priceLevel,places.photos,places.types,places.currentOpeningHours,places.location',
        },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (data.error) {
        console.error('Places API error:', data.error.status, data.error.message);
        return res.status(502).json({ error: `Places API: ${data.error.message}` });
      }

      // Map results to clean venue objects
      const venues = (data.places || []).map(place => {
        let photo = null;
        if (place.photos && place.photos.length > 0) {
          photo = photoUrl(place.photos[0].name);
        }

        return {
          place_id: place.id,
          name: place.displayName?.text || '',
          formatted_address: place.formattedAddress || '',
          rating: place.rating || null,
          user_ratings_total: place.userRatingCount || 0,
          price_level: priceLevelToNum(place.priceLevel),
          photo_url: photo,
          types: place.types || [],
          opening_hours: place.currentOpeningHours || null,
          location: place.location || null,
        };
      });

      const result = { venues, total: venues.length };
      setCache(cacheKey, result);
      res.json(result);
    } catch (err) {
      console.error('Venue search error:', err);
      res.status(500).json({ error: 'Failed to search venues' });
    }
  }
);

// GET /api/venues/details?place_id=xxx - Get full details for a venue
router.get('/details',
  query('place_id').trim().isLength({ min: 1 }).withMessage('place_id is required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      if (!API_KEY) {
        return res.status(500).json({ error: 'Google Places API key not configured' });
      }

      const placeId = req.query.place_id;

      const detailCacheKey = `detail:${placeId}`;
      const cached = getCached(detailCacheKey);
      if (cached) return res.json(cached);

      const response = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
        headers: {
          'X-Goog-Api-Key': API_KEY,
          'X-Goog-FieldMask': 'id,displayName,formattedAddress,nationalPhoneNumber,websiteUri,rating,userRatingCount,priceLevel,photos,currentOpeningHours,types,location,googleMapsUri',
        },
      });

      const p = await response.json();

      if (p.error) {
        return res.status(502).json({ error: `Places API: ${p.error.message}` });
      }

      const photos = (p.photos || []).slice(0, 5).map(photo => photoUrl(photo.name, 600));

      const result = {
        venue: {
          place_id: p.id,
          name: p.displayName?.text || '',
          formatted_address: p.formattedAddress || '',
          formatted_phone_number: p.nationalPhoneNumber || null,
          website: p.websiteUri || null,
          rating: p.rating || null,
          user_ratings_total: p.userRatingCount || 0,
          price_level: priceLevelToNum(p.priceLevel),
          photos,
          opening_hours: p.currentOpeningHours || null,
          types: p.types || [],
          location: p.location || null,
          google_maps_url: p.googleMapsUri || null,
        },
      };
      setCache(detailCacheKey, result);
      res.json(result);
    } catch (err) {
      console.error('Venue details error:', err);
      res.status(500).json({ error: 'Failed to get venue details' });
    }
  }
);

module.exports = router;
