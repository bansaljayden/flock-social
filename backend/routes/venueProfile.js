const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ─── Bounds ──────────────────────────────────────────────────────────────────
// Column widths come from migrations/001_baseline.sql. Before the 2026-08-14
// audit nothing checked them, so an over-long business name / category /
// location / place id reached Postgres and came back as a 500 (error 22001)
// instead of a 400 — the same class of bug the review and vote routes already
// guard. description / goals / operating_hours / notification_prefs are TEXT,
// TEXT[] and JSONB, which do not overflow: they just store whatever they are
// given, so an authenticated owner could park unbounded JSON in their row.
const MAX_BUSINESS_NAME = 255;
const MAX_CATEGORY = 100;
const MAX_LOCATION = 255;
const MAX_DESCRIPTION = 2000;
const MAX_PLACE_ID = 255;
const MAX_PHOTO_URL = 500;
const MAX_GOALS = 20;
const MAX_GOAL_LEN = 80;
const MAX_HOURS_ROWS = 21;      // 7 days, up to three shifts each
const MAX_HOURS_FIELD = 60;

// goals is TEXT[]. node-pg will happily serialize objects into it
// ("[object Object]"), and a non-array value is a raw Postgres error, so the
// contents have to be checked and not just the fact that something arrived.
const goalsRule = body('goals').optional({ nullable: true }).custom((v) => {
  if (!Array.isArray(v)) throw new Error('Goals must be a list');
  if (v.length > MAX_GOALS) throw new Error(`Too many goals (max ${MAX_GOALS})`);
  for (const g of v) {
    if (typeof g !== 'string' || g.length > MAX_GOAL_LEN) {
      throw new Error(`Each goal must be text under ${MAX_GOAL_LEN} characters`);
    }
  }
  return true;
});

// operating_hours is JSONB: the dashboard writes rows of { days, open, close }
// and lets the owner add as many as they like. Shape + row cap keep the column
// from becoming free storage.
const hoursRule = body('operatingHours').optional({ nullable: true }).custom((v) => {
  if (!Array.isArray(v)) throw new Error('Operating hours must be a list');
  if (v.length > MAX_HOURS_ROWS) throw new Error(`Too many operating-hours rows (max ${MAX_HOURS_ROWS})`);
  for (const row of v) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('Each operating-hours row must be an object');
    }
    for (const key of Object.keys(row)) {
      if (!['days', 'open', 'close'].includes(key)) throw new Error('Unexpected field in operating hours');
      if (typeof row[key] !== 'string' || row[key].length > MAX_HOURS_FIELD) {
        throw new Error(`Operating-hours values must be text under ${MAX_HOURS_FIELD} characters`);
      }
    }
  }
  return true;
});

const prefsRule = body('notificationPrefs').optional({ nullable: true }).custom((v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Notification preferences must be an object');
  return true;
});

// Only the three switches the dashboard actually renders are stored. Unknown
// keys are dropped rather than rejected, so a client round-tripping an older
// shape still saves, but nobody can use this column as a JSON bucket.
const PREF_KEYS = ['bookings', 'reviews', 'weekly'];
function sanitizePrefs(prefs) {
  const out = {};
  for (const key of PREF_KEYS) {
    if (typeof prefs[key] === 'boolean') out[key] = prefs[key];
  }
  return out;
}

// photo_url is rendered as an <img src> in the dashboard. The only writer is
// our own upload endpoint, which returns a relative /uploads/... path, so
// accept that and https and nothing else (no javascript:, no data:, and no
// protocol-relative //host that would silently point at a third party).
const photoRule = body('photoUrl').optional({ nullable: true }).trim()
  .isLength({ max: MAX_PHOTO_URL }).withMessage('Photo URL is too long')
  .custom((v) => {
    if (v === '') return true;
    if (/^\/[^/\\]/.test(v)) return true;
    if (/^https:\/\/[^/\\]/i.test(v)) return true;
    throw new Error('Photo URL must be an https link or an uploaded file');
  });

const placeIdRule = body('googlePlaceId').optional({ nullable: true }).trim()
  .isLength({ max: MAX_PLACE_ID }).withMessage('Google place id is too long');

// ─── Claim integrity ─────────────────────────────────────────────────────────
// One venue, one owner. The hard invariant lives in the database — the partial
// unique index uq_venue_profiles_verified_place on google_place_id WHERE
// verified = true (migrations/002) — but that index only constrains the
// VERIFIED row, so a claim pointed at a place somebody else has already had
// verified used to be accepted silently and sit there as a live duplicate
// claim, waiting for an admin to verify it into a 500. Answer 409 at claim
// time, and translate the index's own 23505 the same way for the case where a
// verification lands between this check and the write.
const CLAIMED_MSG = 'That business is already claimed by a verified owner. Contact support if it is yours.';

async function claimedByAnother(placeId, userId) {
  if (!placeId) return false;
  const { rows } = await pool.query(
    'SELECT 1 FROM venue_profiles WHERE google_place_id = $1 AND verified = true AND user_id <> $2 LIMIT 1',
    [placeId, userId]
  );
  return rows.length > 0;
}

// POST /api/venue-profile — create venue profile (onboarding)
router.post('/', [
  body('businessName').trim()
    .isLength({ min: 1 }).withMessage('Business name is required')
    .isLength({ max: MAX_BUSINESS_NAME }).withMessage('Business name is too long'),
  body('category').optional({ nullable: true }).trim().isLength({ max: MAX_CATEGORY }).withMessage('Category is too long'),
  body('location').optional({ nullable: true }).trim().isLength({ max: MAX_LOCATION }).withMessage('Location is too long'),
  body('description').optional({ nullable: true }).trim().isLength({ max: MAX_DESCRIPTION }).withMessage('Description is too long'),
  goalsRule,
  placeIdRule,
  // tier and verified are intentionally NOT accepted here either — see the PUT.
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { businessName, category, location, description, goals, googlePlaceId } = req.body;

    if (await claimedByAnother(googlePlaceId, req.user.id)) {
      return res.status(409).json({ error: CLAIMED_MSG });
    }

    // Set user role to venue_owner.
    //
    // This is still self-serve (VENUE-BILLING.md finding 2 — gating it needs an
    // approval flow that does not exist yet). It is survivable because the role
    // grants nothing on its own: every venue capability that reaches real users
    // is gated on venue_profiles.verified, which only an admin can set
    // (routes/admin.js), and sockets/handlers.js:997 already treats the role as
    // forgeable.
    //
    // What it must NOT do is DOWNGRADE a role (audit 2026-08-13). The old
    // unconditional write let an admin who opened venue onboarding once demote
    // themselves to venue_owner permanently — nothing in the codebase grants
    // 'admin' back, so it locks the moderation dashboard, /api/admin/* and the
    // tier-comp endpoint out of the only account that has them.
    await pool.query(
      "UPDATE users SET role = $1 WHERE id = $2 AND role NOT IN ('admin', 'venue_owner')",
      ['venue_owner', req.user.id]
    );

    // Upsert venue profile
    const result = await pool.query(
      `INSERT INTO venue_profiles (user_id, business_name, category, location, description, goals, google_place_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE SET
         business_name = EXCLUDED.business_name,
         category = EXCLUDED.category,
         location = EXCLUDED.location,
         description = EXCLUDED.description,
         goals = EXCLUDED.goals,
         google_place_id = COALESCE(EXCLUDED.google_place_id, venue_profiles.google_place_id),
         -- Verification binds to the place: re-claiming with a different place
         -- id resets it (round 3: this reset existed only on the PUT path)
         verified = CASE WHEN EXCLUDED.google_place_id IS NOT NULL
                          AND EXCLUDED.google_place_id IS DISTINCT FROM venue_profiles.google_place_id
                         THEN false ELSE venue_profiles.verified END,
         updated_at = NOW()
       RETURNING *`,
      [req.user.id, businessName, category || null, location || null, description || null, goals || [], googlePlaceId || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: CLAIMED_MSG });
    console.error('Create venue profile error:', err);
    res.status(500).json({ error: 'Failed to create venue profile' });
  }
});

// GET /api/venue-profile — get current user's venue profile
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM venue_profiles WHERE user_id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No venue profile found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Get venue profile error:', err);
    res.status(500).json({ error: 'Failed to get venue profile' });
  }
});

// PUT /api/venue-profile — update venue profile (all settings)
router.put('/', [
  body('businessName').optional({ nullable: true }).trim().isLength({ max: MAX_BUSINESS_NAME }).withMessage('Business name is too long'),
  body('category').optional({ nullable: true }).trim().isLength({ max: MAX_CATEGORY }).withMessage('Category is too long'),
  body('location').optional({ nullable: true }).trim().isLength({ max: MAX_LOCATION }).withMessage('Location is too long'),
  body('description').optional({ nullable: true }).trim().isLength({ max: MAX_DESCRIPTION }).withMessage('Description is too long'),
  goalsRule,
  body('phone').optional({ nullable: true }).trim().isLength({ max: 50 }).withMessage('Phone number is too long'),
  hoursRule,
  prefsRule,
  placeIdRule,
  // tier is intentionally NOT accepted from the client — it maps to paid
  // plans and is set server-side only (audit 2026-08-12: clients could
  // PATCH themselves to 'pro'). `verified` is admin-only for the same
  // reason: it is what unlocks speaking publicly as the business.
  photoRule,
], async (req, res) => {
  try {
    // Audit 2026-08-14: every validator above this line was dead code. The
    // handler never called validationResult, so `goals: "free stuff"` reached
    // a TEXT[] column as a 500, notificationPrefs took any JSON at all, and
    // an over-long name was a Postgres error rather than a 400.
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { businessName, category, location, description, goals, phone, operatingHours, notificationPrefs, googlePlaceId, photoUrl } = req.body;

    if (await claimedByAnother(googlePlaceId, req.user.id)) {
      return res.status(409).json({ error: CLAIMED_MSG });
    }

    const result = await pool.query(
      `UPDATE venue_profiles SET
        business_name = COALESCE($1, business_name),
        category = COALESCE($2, category),
        location = COALESCE($3, location),
        description = COALESCE($4, description),
        goals = COALESCE($5, goals),
        phone = COALESCE($6, phone),
        operating_hours = COALESCE($7, operating_hours),
        notification_prefs = COALESCE($8, notification_prefs),
        google_place_id = COALESCE($9, google_place_id),
        -- Verification binds to the PLACE, not the profile row: changing the
        -- place id resets verified so a verified owner can't pivot their badge
        -- onto a business they don't own (audit 2026-08-12). CASE evaluates
        -- against the OLD row, so this compares new id vs current id.
        verified = CASE WHEN $9 IS NOT NULL AND $9 IS DISTINCT FROM google_place_id
                        THEN false ELSE verified END,
        photo_url = COALESCE($10, photo_url),
        updated_at = NOW()
      WHERE user_id = $11
      RETURNING *`,
      [businessName || null, category || null, location || null, description || null, goals || null,
       phone || null, operatingHours ? JSON.stringify(operatingHours) : null,
       notificationPrefs ? JSON.stringify(sanitizePrefs(notificationPrefs)) : null, googlePlaceId || null, photoUrl || null, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No venue profile found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: CLAIMED_MSG });
    console.error('Update venue profile error:', err);
    res.status(500).json({ error: 'Failed to update venue profile' });
  }
});

module.exports = router;
