const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
// Shape before content — see validators/shape.js. Every scalar field on these
// two routes gets the guard; goals / operatingHours / notificationPrefs are
// LEGITIMATELY structured and have their own custom() shape rules instead.
//
// The four owner-typed PROSE fields (businessName, category, location,
// description) use freeText rather than a bare trim. freeText is
// shape -> trim -> stripHtml -> trim, and the reason they need the strip is that
// business_name and location are rendered to somebody other than their author:
// routes/admin.js reads both into the venue verification queue. A value that can
// BE markup on the way into a column is a value nobody downstream can assume is
// text. phone, photoUrl and googlePlaceId keep the plain scalar guard: stripping
// a URL or an id would corrupt it, and each has a stricter rule of its own below.
// goals and operatingHours are owner-only (nothing reads them but the dashboard
// that wrote them), so they are bounded rather than screened.
const { scalarOnly, freeText } = require('../validators/shape');
// ONE definition of "is that a place id", shared with routes/checkin.js,
// routes/flocks.js, routes/feedback.js and sockets/handlers.js. See the note on
// placeIdRule below for why this router is the one that had to adopt it.
const { isPlaceIdShaped } = require('../utils/places');

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
//
// MARKUP, BUT NOT A WORDLIST (2026-08-14). The four prose fields go through
// freeText now, so nothing stored here can BE markup. They are deliberately NOT
// run through rejectIfProfane, unlike every personal free-text field in
// routes/users.js and routes/messages.js: this is a business's own name and
// address, chosen by its owner and printed on its door, and content-checker's
// wordlist refuses plenty of real ones. What screens a venue is the human step
// the venue path already has, which is that nothing a venue says reaches a user
// until an admin sets verified (routes/admin.js). A wordlist here would refuse
// honest businesses and catch nothing a person would not.
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

// How many keys a notificationPrefs object may carry.
//
// AUDIT 2026-08-14. This field had no maximum of ITS OWN. The rule below checked
// that the value was an object and stopped there, so the only thing deciding how
// big that object could be was express.json()'s limit in server.js, which was
// just moved from 1MB to 64KB for reasons that had nothing to do with this
// route. A bound that lives in another file is a bound that changes when nobody
// is looking at this one.
//
// 12 is four times the three switches the dashboard renders (PREF_KEYS below).
// A client can only round-trip keys this dashboard has ever produced, and it has
// only ever produced three, so four times that already covers a stale build
// posting an older shape back at us. Unknown keys are still ACCEPTED and
// dropped, exactly as before, because refusing them would break that stale
// client; what is refused is somebody using the column as a bucket.
//
// The VALUES are deliberately not bounded, and that is not the same oversight
// wearing a different hat: sanitizePrefs keeps only booleans, and only for the
// three known keys, so nothing a value contains can reach the column. Bounding
// the values would refuse requests that are already harmless, and one of them is
// a case __tests__/venueOwner.test.js pins as having to succeed.
const MAX_PREF_KEYS = 12;

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
  if (Object.keys(v).length > MAX_PREF_KEYS) {
    throw new Error(`Too many notification preferences (max ${MAX_PREF_KEYS})`);
  }
  return true;
});

// Only the three switches the dashboard actually renders are stored. Unknown
// keys are dropped rather than rejected, so a client round-tripping an older
// shape still saves, but nobody can use this column as a JSON bucket.
//
// ─── OPEN FINDING: nothing reads this column, and nothing can ────────────────
//
// notification_prefs is written here and read NOWHERE in the backend. The
// obvious fix is "make the send paths honour it", and that fix cannot be
// written, because none of the three sends exists. Checked, 2026-08-14:
//
//   * "New bookings / Get notified when a flock books" — no notification of any
//     kind is ever addressed to a venue owner. Every pushAlways / pushIfOffline
//     / pushIfOfflineDebounced call in routes/, services/ and sockets/ targets a
//     flock member, a DM recipient, a flock creator or an admin. A flock naming
//     this venue shows up only when the owner pulls
//     GET /api/venue-dashboard/incoming-flocks.
//   * "New reviews / Alerts for customer reviews" — routes/venueDashboard.js
//     inserts into venue_reviews and notifies nobody.
//   * "Weekly reports / Performance summary emails" — services/emailService.js
//     sends exactly two kinds of mail, verification and password reset. There is
//     no digest, no scheduler for one, and no template.
//
// So this is not a control somebody forgot to wire. It is a control for a
// feature that was never built, which is the thing SLOP-AUDIT rule 5 forbids:
// the owner flips a switch, we store the flip, and nothing anywhere changes.
// Wiring it would mean INVENTING three owner notifications days before
// submission, which is not a fix for a dead switch; the fix is to remove the
// panel (it lives in frontend/src/App.js, near the "Get notified when a flock
// books" copy) or to build the sends.
//
// The WRITE stays as it is meanwhile. Deleting it would make the switch look
// saved and silently forget, which is strictly worse than storing a preference
// nothing consumes yet, and it would throw away the setting the day a real send
// lands. What guards the gap is a test, not this comment:
// __tests__/alertPreferences.test.js fails the moment any file grows both a
// venue-owner lookup and a send without also reading notification_prefs.
//
// ─── AND THE WRITE MERGES, IT DOES NOT REPLACE (audit 2026-08-14) ────────────
//
// sanitizePrefs returns only the keys the request actually SENT, and the write
// used to be `notification_prefs = COALESCE($8, notification_prefs)`. COALESCE
// picks one side or the other, so `{"bookings": false}` replaced the whole
// column with `{"bookings": false}` and the owner's reviews and weekly settings
// were gone. Worse in kind: `{"junk": 1}` sanitizes to `{}`, which is not null,
// so it replaced the column with an empty object and silently cleared all three.
//
// That is inert today only because nothing reads the column. It stops being
// inert on the day the first owner notification ships, and by then the wrong
// values are already stored, so the fix belongs here now rather than in the
// change that finally reads it. The statement below merges with jsonb `||`,
// which is per-key and leaves the keys this request did not mention alone.
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
// Round 19 (shape sweep): the custom() below tests `v` with a REGEX, and a
// regex stringifies its argument — so `photoUrl: ["https://evil.example/x"]`
// satisfied the https branch, skipped the trim, and went to the column as an
// array. The scheme allowlist is the whole point of this rule, so it has to be
// reading a string.
const photoRule = scalarOnly(body('photoUrl').optional({ nullable: true }), 'photo URL').trim()
  .isLength({ max: MAX_PHOTO_URL }).withMessage('Photo URL is too long')
  .custom((v) => {
    if (v === '') return true;
    if (/^\/[^/\\]/.test(v)) return true;
    if (/^https:\/\/[^/\\]/i.test(v)) return true;
    throw new Error('Photo URL must be an https link or an uploaded file');
  });

// googlePlaceId is the claim key: it is compared against other owners' rows in
// claimedByAnother() and then written to venue_profiles.google_place_id, so an
// array reached both the ownership query and a VARCHAR column as a literal.
//
// SHAPE, not just width (audit 2026-08-14). This was THE write path for
// venue_profiles.google_place_id and it constrained the length and nothing
// else, so any string at all could be stored as a venue's Google listing. Two
// consequences, and the first is why a sibling route carries a defensive
// workaround instead of being safe by construction:
//
//   * routes/venueDashboard.js fetchVenueBasics interpolates this exact column
//     into `https://places.googleapis.com/v1/places/${id}` with our
//     server-restricted API key attached. It has to encodeURIComponent() it —
//     and its own comment says why: "nothing on that write path constrains it
//     to utils/places.isPlaceIdShaped". This is that write path. The encoding
//     stays (defence in depth, and it also covers the rows written before
//     today), but the value is now sound before it is stored rather than only
//     at the one call site that remembered.
//
//   * A stored id that fails this predicate is a SILENTLY BROKEN PROFILE, not
//     merely an ugly one. utils/places.isKnownVenue shape-checks before it
//     queries, so such a venue can never accept an NFC tap or a join_venue
//     subscription; routes/flocks.js validates flocks.venue_id with the same
//     predicate, so no flock can ever name it and /incoming-flocks is
//     permanently empty. The owner sees a saved profile that does nothing.
//
// '' is still accepted and still means "leave it alone" — the handlers below
// spell that `googlePlaceId || null` into a COALESCE, and refusing the empty
// string would 400 a client that round-trips a blank field.
//
// GRANDFATHERING: this guards the WRITE only. Rows stored before today keep
// whatever they hold, and a PUT that does not mention googlePlaceId never
// touches them, so nothing that saves today stops saving. See the report note
// on the cleanup query for finding those rows.
const placeIdRule = scalarOnly(body('googlePlaceId').optional({ nullable: true }), 'Google place id').trim()
  .isLength({ max: MAX_PLACE_ID }).withMessage('Google place id is too long').bail()
  .custom((v) => v === '' || isPlaceIdShaped(v)).withMessage('That is not a valid Google place id');

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
  // Round 19 (shape sweep): every one of these lands in a bounded column, and
  // an array satisfied isLength by coercion while skipping trim (a sanitizer
  // returns a non-string untouched) — so the 22001-instead-of-400 bug the
  // bounds were added for was still reachable, just through a different door.
  freeText(body('businessName'), 'business name')
    .isLength({ min: 1 }).withMessage('Business name is required')
    .isLength({ max: MAX_BUSINESS_NAME }).withMessage('Business name is too long'),
  freeText(body('category').optional({ nullable: true }), 'category').isLength({ max: MAX_CATEGORY }).withMessage('Category is too long'),
  freeText(body('location').optional({ nullable: true }), 'location').isLength({ max: MAX_LOCATION }).withMessage('Location is too long'),
  freeText(body('description').optional({ nullable: true }), 'description').isLength({ max: MAX_DESCRIPTION }).withMessage('Description is too long'),
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
  // Same shape rule as the create route — the two must not drift.
  freeText(body('businessName').optional({ nullable: true }), 'business name').isLength({ max: MAX_BUSINESS_NAME }).withMessage('Business name is too long'),
  freeText(body('category').optional({ nullable: true }), 'category').isLength({ max: MAX_CATEGORY }).withMessage('Category is too long'),
  freeText(body('location').optional({ nullable: true }), 'location').isLength({ max: MAX_LOCATION }).withMessage('Location is too long'),
  freeText(body('description').optional({ nullable: true }), 'description').isLength({ max: MAX_DESCRIPTION }).withMessage('Description is too long'),
  goalsRule,
  scalarOnly(body('phone').optional({ nullable: true }), 'phone number').trim().isLength({ max: 50 }).withMessage('Phone number is too long'),
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
        -- Merge, do not replace. jsonb_typeof rather than a bare COALESCE on
        -- the left: concatenating an object with a jsonb scalar raises
        -- "invalid concatenation of jsonb objects", so a row that somehow
        -- holds anything but an object would turn every save into a 500
        -- instead of being overwritten by the first one. NULL and a drifted
        -- value both read as "start from empty".
        -- (NO BACKTICKS IN HERE. This is inside a template literal, so one
        -- ends the string, and the rest of the statement silently becomes a
        -- second literal joined with ||. The query still parses as JavaScript
        -- and reaches Postgres truncated at that point.)
        notification_prefs = CASE WHEN $8::jsonb IS NULL THEN notification_prefs
                                  ELSE (CASE WHEN jsonb_typeof(notification_prefs) = 'object'
                                             THEN notification_prefs ELSE '{}'::jsonb END) || $8::jsonb END,
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
