'use strict';
// ---------------------------------------------------------------------------
// TABLE INSIGHTS, the owner's read: mounted at /api/venue/tables (server.js).
//
//   GET /:placeId/last-night         { last_night: { date, timeZone, seatings,
//                                      waited, turn_minutes, full_hours,
//                                      sentences, text } }
//   GET /:placeId/free-forecast?dow=&hour=
//                                    { forecast: { dow, hour, weeks,
//                                      free_weeks, share, timeZone } }
//
// Both are services/tableInsights.js, deterministic, no model call. The gate
// is the one the owner's table routes use (routes/sensors.js): signed in, the
// VERIFIED owner of this place (anyone else is told only that), then Roost
// through checkVenueTier, so with venue billing off every verified owner is
// through. The forecast is owner side only and has no public twin: the Flock
// app's table summary (counts and minutes) never carries it.
//
// Nothing here is about a person: counts of seatings, minutes, hours.
// ---------------------------------------------------------------------------
const express = require('express');
const { param, query, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { checkVenueTier } = require('../services/venueEntitlements');
const tableInsights = require('../services/tableInsights');

const router = express.Router();

const NOT_THE_OWNER = { error: 'Table monitoring is for the verified owner of this venue.' };

async function ownerMay(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: errors.array()[0].msg });
    return false;
  }
  const owns = await pool.query(
    'SELECT 1 FROM venue_profiles WHERE user_id = $1 AND google_place_id = $2 AND verified = true LIMIT 1',
    [req.user.id, req.params.placeId]
  );
  if (!owns.rows.length) {
    res.status(403).json(NOT_THE_OWNER);
    return false;
  }
  const plan = await checkVenueTier(req.user.id, 'pro');
  if (!plan.ok) {
    res.status(403).json(plan.body);
    return false;
  }
  return true;
}

const placeIdParam = () => param('placeId').isString().isLength({ min: 1, max: 255 }).withMessage('placeId required');

router.get('/:placeId/last-night', authenticate, [placeIdParam()], async (req, res) => {
  try {
    if (!(await ownerMay(req, res))) return undefined;
    const lastNight = await tableInsights.lastNightSummary(req.params.placeId);
    return res.json({ last_night: lastNight });
  } catch (err) {
    console.error('Table last night error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:placeId/free-forecast', authenticate, [
  placeIdParam(),
  query('dow').isInt({ min: 0, max: 6 }).withMessage('dow must be 0 (Sunday) to 6').toInt(),
  query('hour').isInt({ min: 0, max: 23 }).withMessage('hour must be 0 to 23').toInt(),
], async (req, res) => {
  try {
    if (!(await ownerMay(req, res))) return undefined;
    const forecast = await tableInsights.freeForecast(req.params.placeId, req.query.dow, req.query.hour);
    return res.json({ forecast });
  } catch (err) {
    console.error('Table free forecast error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
