const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requireVenueTier, venueBillingEnabled } = require('../services/venueEntitlements');
// The owner's live 0-100 reading: liveness, expiry and precedence rules all
// live in ONE service (routes/crowd.js applies them to every published
// number). This router only owns the write path.
const ownerReports = require('../services/ownerReports');
const venueLabel = require('../utils/venueLabel');
// Training-context capture for each slider reading (weather, nearby events,
// what Flock was serving, the venue's clock) — fire-and-forget, never on the
// POST's critical path. See services/ownerReportContext.js.
const ownerReportContext = require('../services/ownerReportContext');
const { rejectIfProfane } = require('../utils/moderation');
const { upstreamSignal } = require('../utils/upstream');
// Shape before content — see validators/shape.js. Nothing this router accepts
// is ever legitimately an array or an object, so every body field below is
// either scalarOnly (identifiers, numbers) or freeText (anything a person types
// that another person reads back).
const { scalarOnly, freeText } = require('../validators/shape');
// ONE definition of "is that a place id" — routes/checkin.js, routes/flocks.js,
// routes/feedback.js and sockets/handlers.js all validate against this, and so
// does routes/venueProfile.js as of the 2026-08-14 audit.
const { isPlaceIdShaped } = require('../utils/places');

const router = express.Router();
router.use(authenticate);

// Every :id here is a SERIAL, i.e. int4. `isInt()` with no ceiling let
// /promotions/99999999999999999999 satisfy the chain and reach Postgres, which
// answers 22003 "value out of range for type integer" — a 500 for what is
// plainly a 404. Same bound the other routers use (routes/messages.js et al).
const INT4_MAX = 2147483647;

// Paid-tier boundaries (VENUE-BILLING.md): promotions, events, the full
// incoming-flocks feed, the demand curve (/intelligence) and the competitive
// strip (/strip) are Insights ('premium') features. Server-enforced — the
// locked dashboard tabs are cosmetic. No-op until VENUE_BILLING_ENABLED.
//
// Tier assignment, from the VENUE-BILLING.md pricing table:
//   Free      = "Claimed profile, hours, logo, reviews + reply, 30-day
//                'groups considered you' count" — nothing model-powered.
//   Insights  = "Full incoming-flocks feed + history, demand curve,
//                promotions to nearby groups, events" — /intelligence IS the
//                demand curve, so it is premium by name.
//   Boost     = "Everything + promoted placement + slow-night push offers" —
//                advertising surfaces, not analytics.
// The competitive strip is named in NO row of that table (ambiguity flagged in
// the audit report). The conservative reading is to gate it rather than leave a
// headline paid analytic free; it is the same crowd model as the demand curve
// applied to the neighbours, so it sits with Insights, not with Boost's ad
// surfaces. Move it to 'pro' if the pricing table is ever made explicit.
const requirePremium = requireVenueTier('premium');

// The Pro line. As of the 2026-08-18 audit Pro sold nothing Premium lacks
// (/intelligence and /strip are both 'premium'); the deterministic weekly
// summary below is half of the intended fix. No-op until VENUE_BILLING_ENABLED,
// like every other gate here.
const requirePro = requireVenueTier('pro');

// The tiers that may have a paid benefit SERVED to end users on their behalf.
// Read at request time, never at claim/creation time: a venue that upgrades,
// creates promotions and then downgrades must stop being promoted.
const SERVING_TIERS = ['premium', 'pro'];

// Helper: get venue profile for current user
async function getVenueCtx(userId) {
  const { rows } = await pool.query(
    'SELECT id, google_place_id, verified, category, verification_requested_at FROM venue_profiles WHERE user_id = $1',
    [userId]
  );
  return rows[0] || null;
}

// The words users actually see on this venue's own reading (the category
// label from utils/venueLabel.js), resolved down a CHAIN rather than read off
// one column.
//
// venue_profiles.category is owner-typed and optional: a venue that signed up
// before the category chip existed, or through a path that never asked, has
// NULL there. Reading only that column meant those venues were captioned "the
// venue says" on both the dashboard and the consumer card while the corpus row
// beside them said 'bar' in plain text — the generic word on a surface whose
// entire job is being exactly right about whose claim the number is.
//
// So: the profile's own category first (the owner's word about their own
// room outranks anything inferred), then ml_venues.venue_category (the token
// the crowd model was trained on for this place id), then the Google types
// already stored on that row. Every step folds through utils/venueLabel.js,
// which returns null rather than guessing, and an unresolved chain ends at
// "the venue says", which is always true.
//
// The extra read only happens when the profile has no usable category, so the
// common case costs nothing, and a failed read degrades to the generic word
// instead of failing the request: this label decorates a number the route has
// already computed.
async function attributionCategory(ctx) {
  const own = venueLabel.normalizeCategory(ctx?.category);
  if (own) return own;
  if (!ctx?.google_place_id) return null;
  try {
    const { rows: [v] } = await pool.query(
      'SELECT venue_category, google_types FROM ml_venues WHERE google_place_id = $1 LIMIT 1',
      [ctx.google_place_id]
    );
    return venueLabel.normalizeCategory(v?.venue_category)
      || venueLabel.categoryFromTypes(v?.google_types)
      || null;
  } catch (err) {
    console.error('[VenueDashboard] category lookup failed, labelling generically:', err.message);
    return null;
  }
}

async function ownerAttributionFor(ctx) {
  return venueLabel.ownerAttribution(await attributionCategory(ctx));
}

// ─── PROMOTIONS ──────────────────────────────────────────────────────────────

// GET /api/venue-dashboard/promotions
router.get('/promotions', async (req, res) => {
  try {
    const venue = await getVenueCtx(req.user.id);
    if (!venue) return res.json({ promotions: [] });

    // venue_promotions grows with usage and one owner can create arbitrarily
    // many over time — this list had no ceiling. A generous cap bounds the worst
    // case without hiding any realistic set.
    // Round 18: hidden promotions stay VISIBLE to their author, unlike reviews.
    // The asymmetry is the point. A hidden review is somebody else's words about
    // this owner and they have no business reading it after a takedown; a hidden
    // promotion is the owner's OWN copy, and silently dropping it from their
    // list would leave them staring at a promotion that vanished with no reason
    // given, re-creating it, and having that hidden too.
    //
    // But it must be MARKED, not just present. Before this the row came back
    // through `SELECT *` looking exactly like a live one, so the dashboard
    // showed a taken-down promotion as running while /public-promotions refused
    // to serve it to a single user. `hidden_by_moderation` is stated explicitly
    // rather than leaving the frontend to infer it from a raw `is_hidden`
    // column that a future SELECT list could quietly drop.
    // Round 23: `owner_deleted_at IS NULL` — a row the owner deleted while a
    // report against it was open is retained as evidence (see the DELETE route
    // below), and to its owner it must answer like a deleted row everywhere,
    // starting with this list. The asymmetry with is_hidden is deliberate: a
    // hidden row stays HERE, marked, because the owner is owed the fact of a
    // takedown; a retired row was deleted by the owner themselves.
    const { rows } = await pool.query(
      'SELECT * FROM venue_promotions WHERE venue_user_id = $1 AND owner_deleted_at IS NULL ORDER BY created_at DESC LIMIT 200',
      [req.user.id]
    );
    const promotions = rows.map((p) => ({ ...p, hidden_by_moderation: p.is_hidden === true }));
    res.json({ promotions });
  } catch (err) {
    console.error('Get promotions error:', err);
    res.status(500).json({ error: 'Failed to get promotions' });
  }
});

// POST /api/venue-dashboard/promotions
// Round 20 (shape sweep): all four fields are PUBLIC UGC — /public-promotions
// serves title, description, time_slot and days to every user looking at the
// venue card — and not one of them was passed through stripHtml. The array form
// made that worse rather than merely equal: `title: ["<b>x</b>"]` satisfies
// isLength by coercion, skips .trim() (a sanitizer returns a non-string
// untouched), and is answered allowed:true by rejectIfProfane, so the one screen
// this route did run was skipped as well. It then reached VARCHAR(255) as the
// Postgres literal `{"<b>x</b>"}`. freeText settles the shape first, strips the
// markup, and measures the length AFTER stripping.
router.post('/promotions', requirePremium, [
  freeText(body('title'), 'title').isLength({ min: 1, max: 80 }).withMessage('Title is required (max 80 characters)'),
  freeText(body('description').optional({ nullable: true }), 'description').isLength({ max: 300 }).withMessage('Description is too long (max 300 characters)'),
  freeText(body('timeSlot').optional({ nullable: true }), 'time slot').isLength({ max: 60 }).withMessage('Time slot is too long (max 60 characters)'),
  freeText(body('days').optional({ nullable: true }), 'days').isLength({ max: 60 }).withMessage('Days is too long (max 60 characters)'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    // Promotions are public UGC — same screen as every user-writable field.
    // Round 20: all FOUR fields, not two. /public-promotions serves time_slot
    // and days to every user who opens the venue card, exactly as it serves
    // title and description, and neither was screened — so "Fri <slur>" in the
    // days field was published unscreened while the same string in the title
    // was refused. Screening runs on the STRIPPED value (freeText's sanitizer
    // has already fired), which also closes `f<b>u</b>ck`.
    for (const field of ['title', 'description', 'timeSlot', 'days']) {
      if (req.body[field] && rejectIfProfane(res, req.body[field])) return;
    }

    const venue = await getVenueCtx(req.user.id);
    if (!venue) return res.status(404).json({ error: 'No venue profile found' });

    const { title, description, timeSlot, days } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO venue_promotions (venue_user_id, google_place_id, title, description, time_slot, days)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.id, venue.google_place_id, title, description || null, timeSlot || null, days || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Create promotion error:', err);
    res.status(500).json({ error: 'Failed to create promotion' });
  }
});

// PUT /api/venue-dashboard/promotions/:id
// Same four public fields, same guard. `optional({ nullable: true })` rather
// than `optional()` throughout: express-validator 7 skips only `undefined`, and
// the handler below already reads a null as "leave this one alone" (`title ||
// null` feeding a COALESCE), so a client that spells "no change" as an explicit
// null was being answered 400 by the chain for a request the route knows how to
// serve.
router.put('/promotions/:id', requirePremium, [
  param('id').isInt({ min: 1, max: INT4_MAX }),
  freeText(body('title').optional({ nullable: true }), 'title').isLength({ min: 1, max: 80 }).withMessage('Title too long (max 80 characters)'),
  freeText(body('description').optional({ nullable: true }), 'description').isLength({ max: 300 }).withMessage('Description is too long (max 300 characters)'),
  freeText(body('timeSlot').optional({ nullable: true }), 'time slot').isLength({ max: 60 }).withMessage('Time slot is too long (max 60 characters)'),
  freeText(body('days').optional({ nullable: true }), 'days').isLength({ max: 60 }).withMessage('Days is too long (max 60 characters)'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    // Edits are the same public UGC surface as creation (round 8), across the
    // same four fields the create route screens (round 20).
    for (const field of ['title', 'description', 'timeSlot', 'days']) {
      if (req.body[field] && rejectIfProfane(res, req.body[field])) return;
    }

    // Round 18: an edit to a taken-down promotion is REFUSED, and refused by
    // name. The old statement happily updated a hidden row and answered 200 with
    // it, so the owner retitled a promotion, was told it saved, and it stayed
    // invisible to every user because /public-promotions filters is_hidden. An
    // endpoint that reports success for work the product then declines to honour
    // is worse than one that says no.
    //
    // Unlike the reply route, naming the takedown here leaks nothing: it is the
    // owner's own promotion, GET /promotions already returns it flagged, and
    // "why can I not edit this" has no other answer.
    //
    // One statement, not a SELECT-then-UPDATE: `target` names the row, the
    // UPDATE simply does not fire when it is hidden, and the outer SELECT still
    // returns a row whenever the promotion exists — so "not yours / gone" (0
    // rows) stays distinguishable from "taken down" (a row whose UPDATE half is
    // missing) with no window between the check and the write. Same shape as the
    // verify route in routes/admin.js.
    const { title, description, timeSlot, days } = req.body;
    const { rows } = await pool.query(
      `WITH target AS (
         SELECT id, COALESCE(is_hidden, false) AS is_hidden
         FROM venue_promotions WHERE id = $5 AND venue_user_id = $6 AND owner_deleted_at IS NULL
       ),
       upd AS (
         UPDATE venue_promotions SET
           title = COALESCE($1, title),
           description = COALESCE($2, description),
           time_slot = COALESCE($3, time_slot),
           days = COALESCE($4, days),
           updated_at = NOW()
         WHERE id = $5 AND venue_user_id = $6
           AND EXISTS (SELECT 1 FROM target t WHERE t.is_hidden = false)
         RETURNING *
       )
       SELECT t.is_hidden AS target_hidden, u.*
       FROM target t LEFT JOIN upd u ON true`,
      [title || null, description || null, timeSlot || null, days || null, req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Promotion not found' });
    const row = rows[0];
    // The refusal is read off the UPDATE, never off `target_hidden` alone: the
    // missing updated row IS the refusal, and nothing else can stop the write.
    if (row.id == null) {
      return res.status(409).json({
        // SLOP-AUDIT.md rule 5: this names only things that exist. Nothing in
        // the codebase emails a content author about a takedown, so an earlier
        // draft of this line ("reply to the moderation email") pointed at a
        // feature that has never been built. Delete and re-create both work on
        // a hidden row today, so that is what it says.
        error: 'This promotion was taken down by moderation and cannot be edited. Delete it and create a new one if you want to run something different.',
        code: 'CONTENT_HIDDEN',
      });
    }
    const { target_hidden: _targetHidden, ...promotion } = row;
    res.json(promotion);
  } catch (err) {
    console.error('Update promotion error:', err);
    res.status(500).json({ error: 'Failed to update promotion' });
  }
});

// DELETE /api/venue-dashboard/promotions/:id
//
// Round 23: THE DELETE CAN NO LONGER DESTROY EVIDENCE. While a report against
// this promotion is open or under review, the row is the thing a moderator has
// been asked to judge — and its owner is the person with the strongest reason
// to make it vanish. Hide preserved the evidence; this route erased it.
// routes/stories.js solved the identical problem for story deletion and these
// semantics are its, matched clause for clause (adminAuditTrail.test.js pins
// the two status lists together):
//
//   * The report check is a predicate INSIDE the delete, never a SELECT before
//     it — read first, delete second and there is a window, exactly the window
//     a reported owner is racing for, in which the report lands after the
//     check and the evidence is destroyed anyway.
//   * When the guard holds, the row is RETIRED (owner_deleted_at, migration
//     020) with the same 200 and the same body as a real delete. The silence
//     is load-bearing, and it is why this is not a 409 like the hidden-row
//     edit refusal above: a hidden row is a takedown the owner already knows
//     about, but an OPEN report is one they must not be told about, because
//     the edit route would let them sanitize the words before a moderator
//     reads them. To the owner a retired row answers exactly like a deleted
//     one everywhere: gone from their list (GET above filters it), a 404 from
//     the edit CTE, off the public card (active = false, which is what
//     /public-promotions serves by).
//   * Deleting hidden-but-UNREPORTED content still works — no is_hidden here,
//     on purpose. After a resolved takedown, cleanup is legitimately the
//     owner's to do, and the 409 CONTENT_HIDDEN copy above promises exactly
//     that. (venueTakedownVisibility.test.js holds this route to it.)
//   * The `owner_deleted_at IS NOT NULL` arm is the retention window closing:
//     stories has a purge that removes retired evidence once its report is
//     resolved; venues have no purge loop, so the owner's NEXT delete sweeps
//     any of their retired rows whose reports have since closed. Until then
//     the row is readable only by the moderation queue.
router.delete('/promotions/:id', requirePremium, param('id').isInt({ min: 1, max: INT4_MAX }), async (req, res) => {
  try {
    // param('id').isInt() was declared but its result was never read, so a
    // non-numeric id (e.g. /promotions/abc) reached Postgres as a string and came
    // back a 500 instead of a 404 (same class as the PUT routes above already guard).
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(404).json({ error: 'Promotion not found' });
    const promotionId = parseInt(req.params.id, 10);
    const del = await pool.query(
      `DELETE FROM venue_promotions
        WHERE venue_user_id = $2
          AND (id = $1 OR owner_deleted_at IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM content_reports r
             WHERE r.content_type = 'venue_promotion'
               AND r.content_id = venue_promotions.id
               AND r.status IN ('open', 'under_review')
          )
        RETURNING id`,
      [promotionId, req.user.id]
    );
    if (del.rows.some((row) => row.id === promotionId)) return res.json({ success: true });

    // The delete did not take the target: no such promotion, not this owner's,
    // or the evidence guard held. Only the last is still actionable, and for
    // the owner it must look exactly like a delete (see the note above).
    // `owner_deleted_at IS NULL` keeps a second delete of a retired row a 404,
    // which is what a genuinely deleted row would answer.
    const retired = await pool.query(
      `UPDATE venue_promotions
          SET owner_deleted_at = NOW(), active = false
        WHERE id = $1 AND venue_user_id = $2 AND owner_deleted_at IS NULL
        RETURNING id`,
      [promotionId, req.user.id]
    );
    if (retired.rows.length === 0) return res.status(404).json({ error: 'Promotion not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete promotion error:', err);
    res.status(500).json({ error: 'Failed to delete promotion' });
  }
});

// ─── EVENTS ──────────────────────────────────────────────────────────────────

// GET /api/venue-dashboard/events
router.get('/events', async (req, res) => {
  try {
    const venue = await getVenueCtx(req.user.id);
    if (!venue) return res.json({ events: [] });

    // Same unbounded-growth cap as the promotions list above.
    //
    // Round 22: and the same MARKING, which events were passed over for. A
    // hidden event stays visible to its author for the reason round 18 gives
    // for promotions — it is the owner's own copy, and dropping it silently
    // leaves them staring at an event that vanished with no reason given — but
    // it has to be marked, not merely present. `SELECT *` handed a taken-down
    // event back looking exactly like a running one, so the one screen that
    // could tell an owner a moderator had acted said nothing at all.
    // venue_events only grew is_hidden in migration 019; this is the read side
    // catching up with it.
    // Round 23: same owner_deleted_at filter as the promotions list, for the
    // same reason — a retired evidence row must look deleted to its owner.
    const { rows } = await pool.query(
      'SELECT * FROM venue_events WHERE venue_user_id = $1 AND owner_deleted_at IS NULL ORDER BY created_at DESC LIMIT 200',
      [req.user.id]
    );
    // Stated explicitly rather than leaving the dashboard to infer it from a raw
    // is_hidden column a future SELECT list could quietly drop — same contract,
    // same field name, as the promotions list.
    const events = rows.map((e) => ({ ...e, hidden_by_moderation: e.is_hidden === true }));
    res.json({ events });
  } catch (err) {
    console.error('Get events error:', err);
    res.status(500).json({ error: 'Failed to get events' });
  }
});

// POST /api/venue-dashboard/events
// Event titles are the same story as promotion titles: owner-typed, read back
// on the dashboard and (via venue_events) intended for the venue card, screened
// by rejectIfProfane and by nothing else. An array skipped even that.
//
// Round 22: the OTHER two strings on an event were screened by nothing at all.
// `eventDate` and `eventTime` are 40 characters of owner-typed free text each —
// not a DATE and not a TIME column, so "this Friday" and "doors 9, band 10" are
// the normal values — and they sat beside a title that was screened. Exactly the
// gap round 20 closed on promotions, where time_slot and days were published
// unscreened while the same string in the title was refused. Same rule here.
//
// `capacity` had a second problem of its own. `isInt({ min: 1 })` has no
// ceiling, and the column is INTEGER — so `capacity: 3000000000` was a 22003
// from Postgres, a 500 for a plainly bad request. Bound it to int4 the same way
// the :id params are.
router.post('/events', requirePremium, [
  freeText(body('title'), 'title').isLength({ min: 1, max: 120 }).withMessage('Title is required (max 120 characters)'),
  freeText(body('eventDate').optional({ nullable: true }), 'event date').isLength({ max: 40 }).withMessage('Event date is too long (max 40 characters)'),
  freeText(body('eventTime').optional({ nullable: true }), 'event time').isLength({ max: 40 }).withMessage('Event time is too long (max 40 characters)'),
  scalarOnly(body('capacity').optional({ nullable: true }), 'capacity').isInt({ min: 1, max: INT4_MAX }).withMessage('Capacity must be a whole number of people'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    // All THREE owner-typed strings, not just the title — same list, same shape
    // and same placement as the promotions routes above. Screening runs on the
    // STRIPPED value (freeText's sanitizer has already fired in the chain), so
    // `f<b>u</b>ck` in an event date cannot split a word past the filter either.
    for (const field of ['title', 'eventDate', 'eventTime']) {
      if (req.body[field] && rejectIfProfane(res, req.body[field])) return;
    }

    const venue = await getVenueCtx(req.user.id);
    if (!venue) return res.status(404).json({ error: 'No venue profile found' });

    const { title, eventDate, eventTime, capacity } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO venue_events (venue_user_id, google_place_id, title, event_date, event_time, capacity)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.id, venue.google_place_id, title, eventDate || null, eventTime || null, capacity || 50]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Create event error:', err);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// PUT /api/venue-dashboard/events/:id
// An edit is the same surface as a creation, across the same three text fields
// (round 22) — the promotions PUT has screened its full set since round 20, and
// an unscreened edit route makes a screened create route decorative: post a
// clean event, then rename the date to a slur.
router.put('/events/:id', requirePremium, [
  param('id').isInt({ min: 1, max: INT4_MAX }),
  freeText(body('title').optional({ nullable: true }), 'title').isLength({ min: 1, max: 120 }).withMessage('Title too long (max 120 characters)'),
  freeText(body('eventDate').optional({ nullable: true }), 'event date').isLength({ max: 40 }).withMessage('Event date is too long (max 40 characters)'),
  freeText(body('eventTime').optional({ nullable: true }), 'event time').isLength({ max: 40 }).withMessage('Event time is too long (max 40 characters)'),
  scalarOnly(body('capacity').optional({ nullable: true }), 'capacity').isInt({ min: 1, max: INT4_MAX }).withMessage('Capacity must be a whole number of people'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    for (const field of ['title', 'eventDate', 'eventTime']) {
      if (req.body[field] && rejectIfProfane(res, req.body[field])) return;
    }

    // Round 22: an edit to a taken-down event is REFUSED, and refused by name —
    // the rule the promotions PUT has followed since round 18, arriving here now
    // that migration 019 has given venue_events an is_hidden column to read. The
    // old statement updated a hidden row and answered 200 with it, so an owner
    // retitled an event a moderator had removed, was told it saved, and nothing
    // on any screen disagreed. An endpoint that reports success for work the
    // product declines to honour is worse than one that says no.
    //
    // Naming the takedown leaks nothing: it is the owner's own event, GET
    // /events now returns it flagged, and "why can I not edit this" has no other
    // answer.
    //
    // One statement, not a SELECT-then-UPDATE, for the same reason as
    // promotions: `target` names the row, the UPDATE simply does not fire when
    // it is hidden, and the outer SELECT still returns a row whenever the event
    // exists — so "not yours / gone" (0 rows) stays distinguishable from "taken
    // down" (a row whose UPDATE half is missing) with no window between the
    // check and the write.
    const { title, eventDate, eventTime, capacity } = req.body;
    const { rows } = await pool.query(
      `WITH target AS (
         SELECT id, COALESCE(is_hidden, false) AS is_hidden
         FROM venue_events WHERE id = $5 AND venue_user_id = $6 AND owner_deleted_at IS NULL
       ),
       upd AS (
         UPDATE venue_events SET
           title = COALESCE($1, title),
           event_date = COALESCE($2, event_date),
           event_time = COALESCE($3, event_time),
           capacity = COALESCE($4, capacity),
           updated_at = NOW()
         WHERE id = $5 AND venue_user_id = $6
           AND EXISTS (SELECT 1 FROM target t WHERE t.is_hidden = false)
         RETURNING *
       )
       SELECT t.is_hidden AS target_hidden, u.*
       FROM target t LEFT JOIN upd u ON true`,
      [title || null, eventDate || null, eventTime || null, capacity || null, req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    const row = rows[0];
    // Read off the UPDATE, never off `target_hidden` alone: the missing updated
    // row IS the refusal, and nothing else can stop the write.
    if (row.id == null) {
      return res.status(409).json({
        // SLOP-AUDIT.md rule 5: names only things that exist. Nothing in this
        // codebase emails a content author about a takedown. Delete and
        // re-create both work on a hidden row today, so that is what it says.
        error: 'This event was taken down by moderation and cannot be edited. Delete it and create a new one if you want to run something different.',
        code: 'CONTENT_HIDDEN',
      });
    }
    const { target_hidden: _targetHidden, ...event } = row;
    res.json(event);
  } catch (err) {
    console.error('Update event error:', err);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

// DELETE /api/venue-dashboard/events/:id
//
// Round 23: same evidence guard, same retirement, same silence as the
// promotions DELETE above — the full reasoning lives there. The only
// difference is that venue_events has no `active` column and no public route,
// so retirement touches nothing but owner_deleted_at.
router.delete('/events/:id', requirePremium, param('id').isInt({ min: 1, max: INT4_MAX }), async (req, res) => {
  try {
    // Same unenforced validator as the promotions DELETE: read it so a
    // non-numeric id is a 404 rather than a Postgres 500.
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(404).json({ error: 'Event not found' });
    const eventId = parseInt(req.params.id, 10);
    const del = await pool.query(
      `DELETE FROM venue_events
        WHERE venue_user_id = $2
          AND (id = $1 OR owner_deleted_at IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM content_reports r
             WHERE r.content_type = 'venue_event'
               AND r.content_id = venue_events.id
               AND r.status IN ('open', 'under_review')
          )
        RETURNING id`,
      [eventId, req.user.id]
    );
    if (del.rows.some((row) => row.id === eventId)) return res.json({ success: true });

    const retired = await pool.query(
      `UPDATE venue_events
          SET owner_deleted_at = NOW()
        WHERE id = $1 AND venue_user_id = $2 AND owner_deleted_at IS NULL
        RETURNING id`,
      [eventId, req.user.id]
    );
    if (retired.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete event error:', err);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// ─── INCOMING FLOCKS ─────────────────────────────────────────────────────────

// THE WINDOW, AND WHY IT IS THIS ONE.
//
// This feed had NO `event_time` predicate at all and ordered `event_time DESC`,
// so what it returned was "the furthest-future non-cancelled flock that ever
// voted for my place id", forever. In production that is flock 117, a confirmed
// Birthday Dinner whose event_time was 2026-04-26 — four months in the past and
// still sitting at the top of a card headed "Incoming Flocks". A feed that never
// forgets is not a demand feed, it is a scoreboard of one stale row, and an
// owner who staffed against it would be staffing for a party that already
// happened.
//
// WHAT "INCOMING" MEANS HERE. The owner reads this to decide staffing, stock and
// whether to run a promotion. That is a decision with a lead time, so the window
// has to be a horizon, not an instant.
//
// LOWER BOUND: 12 hours BEHIND now, not now.
//   A flock whose event_time was two hours ago is standing in the building. The
//   app already has one definition of "this flock is at this venue right now" —
//   routes/checkin.js accepts a check-in for `NOW() BETWEEN event_time -
//   INTERVAL '3 hours' AND event_time + INTERVAL '12 hours'` — and there must
//   not be a second. Reusing the tail of that window means the feed stops
//   showing a group at exactly the moment the app stops letting that group
//   check in. Cutting at NOW() instead would drop the party mid-visit, which is
//   the one moment the owner most wants it on screen.
//
// UPPER BOUND: 7 days.
//   Measured against production rather than guessed. Of the eight flocks that
//   have ever carried an event_time, the longest gap between `created_at` and
//   `event_time` is flock 117's 2.7 days; every other real one is under two.
//   So 7 days covers every plan this product has ever seen with better than 2x
//   headroom while excluding nothing. "Tonight" (24h) was the tempting choice
//   and it is wrong: it would hide the only multi-day plan in the corpus during
//   precisely the days an owner could still act on it, and it would leave the
//   card empty almost always. A month would put February's plans under a
//   heading that says they are coming.
//
// UNDATED FLOCKS ARE EXCLUDED, and that costs nothing today: all six
// production flocks with a NULL event_time are status 'planning', which this
// query already refuses. An undated flock is not schedulable, so it cannot be
// placed inside any window honestly — it would have to be pinned to the top or
// the bottom by fiat, and either is a claim about when those people are coming.
//
// ORDER IS ASCENDING NOW. `DESC` put the furthest-away plan first, which is
// backwards for a feed whose whole job is "what is about to hit me".
//
// KNOWN AND DELIBERATELY NOT CHANGED HERE: `'active'` is not a value
// `flocks.status` can hold. The CHECK constraint (database/schema.sql) allows
// planning / confirmed / completed / cancelled, so this predicate resolves to
// "confirmed, or NULL" and every flock still in the voting stage — which is
// exactly when a venue is being considered — is filtered out. That is a
// separate product decision about who may see an unconfirmed group's plans, not
// a window bug, and it is not made in this change.
const INCOMING_PAST_HOURS = 12;   // = the tail of the routes/checkin.js window
const INCOMING_AHEAD_HOURS = 168; // = 7 days

// GET /api/venue-dashboard/incoming-flocks — flocks that selected this venue
router.get('/incoming-flocks', requirePremium, async (req, res) => {
  try {
    const venue = await getVenueCtx(req.user.id);
    if (!venue || !venue.google_place_id) return res.json({ flocks: [] });
    // Verified claims only (round 3): an unverified claim on an arbitrary
    // place id must not expose which groups are privately considering it.
    // getVenueCtx already selected `verified` — the second SELECT this used to
    // run against the same row was a duplicate read, not a second opinion.
    if (!venue.verified) return res.json({ flocks: [], unverified: true });

    // Find flocks where venue_votes reference this venue's place_id (venue_id
    // column), inside the window argued above. The intervals are SQL literals
    // rather than bound parameters on purpose: the only bound value here is the
    // server-derived place id, and the object-authz suite pins that fact.
    // f.name IS NOT SELECTED, and that is the whole of this change.
    //
    // SECURITY ROUND 5, 2026-08-20. This feed used to hand the venue
    // `f.name AS title` — the private group's own name for their night, typed
    // by whoever created the flock, rendered by App.js as the heading of the
    // card. Group names are not neutral strings. "Emma's 21st", "Sarah's
    // leaving do", "Dan + Priya anniversary" are the normal case, and each one
    // pairs a real first name with a venue, a date and a time, delivered to a
    // business that will be standing at the door when those people walk in.
    //
    // Three things make it worse than it first reads:
    //   * NOBODY IN THE GROUP CHOSE THIS. The name is typed on the create
    //     screen for the group's own use. Nothing on that screen says a
    //     business will read it, and the group never sees the venue dashboard.
    //   * THE PRIVACY POLICY DOES NOT SAY IT HAPPENS. Section "Who we share
    //     with" names service providers, other flock members, and trusted
    //     contacts. Venue owners are not on the list, and a paid feed of
    //     user-authored text to a party the policy never mentions is the
    //     disclosure gap, not just the leak.
    //   * THE PRODUCT'S OWN VOICE ALREADY FORBIDS IT. Roost refuses this
    //     question in so many words (services/advisorFreeText.js,
    //     REFUSAL_BY_REASON.private_people): "We never report anything about
    //     the individual people who use Flock: who they are ... or what they
    //     planned. That stays private, including from you." The chat refused
    //     it while the card above the chat printed it.
    //
    // WHAT THE VENUE ACTUALLY NEEDS is the operational shape of the night, and
    // that is what the feed keeps: how many people, when, and whether the plan
    // is confirmed. `title` stays as a KEY so App.js needs no change, but the
    // server writes it now, from the party size, and it is derived from a
    // COUNT rather than from anything a user typed. Nothing user-authored
    // crosses this boundary any more.
    const { rows } = await pool.query(
      `SELECT DISTINCT f.id, f.event_time, f.status,
              (SELECT COUNT(*) FROM flock_members fm WHERE fm.flock_id = f.id AND fm.status = 'accepted') AS member_count
       FROM flocks f
       JOIN venue_votes vv ON vv.flock_id = f.id
       WHERE vv.venue_id = $1
         AND (f.status IS NULL OR f.status IN ('active', 'confirmed'))
         AND f.event_time IS NOT NULL
         AND f.event_time > NOW() - INTERVAL '12 hours'
         AND f.event_time < NOW() + INTERVAL '7 days'
       ORDER BY f.event_time ASC
       LIMIT 20`,
      [venue.google_place_id]
    );

    res.json({
      // The heading the venue reads, built here rather than selected. A group
      // whose accepted count has not landed yet is "A group", not "Party of
      // 0": the count is the thing being said, so saying it wrong is worse
      // than not saying it.
      flocks: rows.map((f) => {
        const n = Number(f.member_count);
        return { ...f, title: Number.isFinite(n) && n > 0 ? `Party of ${n}` : 'A group' };
      }),
      // The window is published because the list alone cannot distinguish "no
      // group is coming" from "the feed only looks a day ahead". A client that
      // ignores this keeps its old behaviour.
      window: { pastHours: INCOMING_PAST_HOURS, aheadHours: INCOMING_AHEAD_HOURS },
      unattributed: await countUnattributedVotes(venue),
    });
  } catch (err) {
    console.error('Get incoming flocks error:', err);
    res.status(500).json({ error: 'Failed to get incoming flocks' });
  }
});

// WHY THIS COUNTS AND DOES NOT ATTRIBUTE.
//
// `venue_votes.venue_id` is the Google place id and it is NULLABLE and
// best-effort. sockets/handlers.js writes it with
// `COALESCE(EXCLUDED.venue_id, venue_votes.venue_id)` precisely because the
// client re-sends its current pick without an id whenever the tally moves, so
// rows arrive carrying `venue_name` and nothing else. The feed above joins on
// the id, so those votes are invisible to the owner they belong to.
//
// HOW BIG IS IT, measured read-only against production 2026-08-18: 6 rows in
// venue_votes, 2 with a NULL venue_id — a third of the table. Both NULL rows
// name a venue ("Social Still", "E2E Test Tavern") that appears nowhere else
// with an id, so there is no id to recover them from either. It is a third of a
// six-row table, which is a shape, not a rate.
//
// WHY THE FEED IS NOT FIXED BY MATCHING ON THE NAME. Attribution here is an
// AUTHORIZATION decision: it picks which business gets to read which private
// group's plans. `venue_name` is a free-text string a client sent, it is not
// unique, and it is not scoped to a city — one row for "Starbucks" would be
// handed to whichever Starbucks claimed a profile first, and one typo'd or
// truncated name would hand a group's plan to a business those people never
// chose. Every safe version of that match needs a discriminator this table does
// not have (a location, a chain id, an owner confirmation step). Guessing would
// trade a visible gap for an invisible leak, and the leak is the worse defect.
//
// SO THE GAP IS PUBLISHED INSTEAD. The owner gets a COUNT of flocks in the same
// window that named a venue spelled like theirs with no place id attached, and
// nothing else: no flock id, no name, no member count, no date. A count cannot
// be acted on against the wrong group, and the pricing table in VENUE-BILLING.md
// already sells a count ("30-day 'groups considered you' count") as a legitimate
// product, so the shape is not novel. The name comparison is trimmed and
// case-folded and never leaves the database, and the name it compares against
// comes from the owner's own profile row by id, never from the request.
//
// Auxiliary by construction: this must never take the feed down with it, so a
// failure here is a null count — "we do not know" — not a 500.
async function countUnattributedVotes(venue) {
  const unknown = { count: null, basis: 'venue_name_only', reason: 'lookup_failed' };
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT f.id)::int AS n
       FROM venue_votes vv
       JOIN flocks f ON f.id = vv.flock_id
       JOIN venue_profiles vp ON vp.id = $1
       WHERE vv.venue_id IS NULL
         AND vp.business_name IS NOT NULL
         AND LOWER(BTRIM(vv.venue_name)) = LOWER(BTRIM(vp.business_name))
         AND (f.status IS NULL OR f.status IN ('active', 'confirmed'))
         AND f.event_time IS NOT NULL
         AND f.event_time > NOW() - INTERVAL '12 hours'
         AND f.event_time < NOW() + INTERVAL '7 days'`,
      [venue.id]
    );
    const n = rows && rows[0] ? Number(rows[0].n) : NaN;
    if (!Number.isInteger(n)) return unknown;
    return {
      count: n,
      // What the number IS, so nobody reads it as "flocks coming here". These
      // votes were NOT confirmed to be for this venue and are not in the list
      // above for that reason.
      basis: 'venue_name_only',
      reason: 'no_place_id',
    };
  } catch (err) {
    console.error('Unattributed vote count failed:', err.message);
    return unknown;
  }
}

// ─── REVIEWS ─────────────────────────────────────────────────────────────────

// Reviews are unbounded user-generated rows. Both review routes below used to
// SELECT the whole set (or a 50-row window) and reduce it in JavaScript, so the
// response grew without limit and the numbers drifted from the truth. The stats
// are computed by Postgres over EVERY row now, and the row list is a page.
const REVIEW_PAGE_DEFAULT = 50;
const REVIEW_PAGE_MAX = 100;
function reviewPageSize(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) return REVIEW_PAGE_DEFAULT;
  return Math.min(n, REVIEW_PAGE_MAX);
}

// GET /api/venue-dashboard/reviews — get Flock reviews for this venue
router.get('/reviews', async (req, res) => {
  try {
    const venue = await getVenueCtx(req.user.id);
    if (!venue || !venue.google_place_id) return res.json({ reviews: [], stats: null });

    const limit = reviewPageSize(req.query.limit);

    // Aggregates in SQL over the full set. Loading every review ever written
    // just to average five integers meant the dashboard's memory and payload
    // grew with the venue's popularity, and one busy venue could return tens of
    // thousands of rows including full review text.
    const statsResult = await pool.query(
      // Same JOIN as the list below, so the two can never disagree about which
      // rows count (venue_reviews.user_id is nullable; the join is the rule).
      // Round 18: `AND COALESCE(vr.is_hidden, false) = false`, the same
      // predicate /public-reviews has carried since the takedown shipped. The
      // owner tab ignored takedowns entirely, in both queries. Two consequences,
      // and the second is the worse one:
      //   * a review taken down FOR HARASSING THIS OWNER was still served to
      //     them in full text, so moderation removed it from everyone except
      //     the person it was aimed at;
      //   * the hidden row still moved the average and the star distribution the
      //     owner sees, so the owner's number permanently disagreed with the
      //     public one and there was nothing on the screen to explain the gap.
      `SELECT COUNT(*)::int AS total,
              AVG(vr.rating)::float AS average,
              COUNT(*) FILTER (WHERE vr.rating = 1)::int AS r1,
              COUNT(*) FILTER (WHERE vr.rating = 2)::int AS r2,
              COUNT(*) FILTER (WHERE vr.rating = 3)::int AS r3,
              COUNT(*) FILTER (WHERE vr.rating = 4)::int AS r4,
              COUNT(*) FILTER (WHERE vr.rating = 5)::int AS r5
       FROM venue_reviews vr
       JOIN users u ON u.id = vr.user_id
       WHERE vr.google_place_id = $1
         AND COALESCE(vr.is_hidden, false) = false`,
      [venue.google_place_id]
    );
    const s = statsResult.rows[0] || {};
    const total = s.total || 0;

    const { rows } = await pool.query(
      // Same visibility predicate as the stats above, for the same reason the
      // JOIN is duplicated: the two must never disagree about which rows count.
      `SELECT vr.*, u.name, u.profile_image_url
       FROM venue_reviews vr
       JOIN users u ON u.id = vr.user_id
       WHERE vr.google_place_id = $1
         AND COALESCE(vr.is_hidden, false) = false
       ORDER BY vr.created_at DESC
       LIMIT $2`,
      [venue.google_place_id, limit]
    );

    res.json({
      reviews: rows,
      stats: {
        // Rounded the same way the old .toFixed(1) rounded, so the displayed
        // number does not move for venues that already had fewer than 50.
        average: total > 0 ? parseFloat(Number(s.average).toFixed(1)) : 0,
        total,
        distribution: [s.r1 || 0, s.r2 || 0, s.r3 || 0, s.r4 || 0, s.r5 || 0],
      },
      // The list is a page now; `total` above is the real count.
      hasMore: total > rows.length,
    });
  } catch (err) {
    console.error('Get reviews error:', err);
    res.status(500).json({ error: 'Failed to get reviews' });
  }
});

// POST /api/venue-dashboard/reviews/:id/reply — venue owner replies to a review
// `reply` is the single most publicly-visible string this router writes: it
// rides the verified badge on the venue card in /public-reviews, addressed to
// every user who reads that venue's reviews. It had no stripHtml, and
// `reply: ["<img src=x onerror=…>"]` also walked past the rejectIfProfane call
// two lines below — the only screen it had.
router.post('/reviews/:id/reply', [
  param('id').isInt({ min: 1, max: INT4_MAX }),
  freeText(body('reply'), 'reply').isLength({ min: 1, max: 1000 }).withMessage('Reply is required (max 1000 characters)'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    // Round 5: only the VERIFIED claim holder speaks as the business. An
    // unverified claim on the same place id must never write a reply that
    // later rides the legitimate owner's verified badge.
    const venue = await getVenueCtx(req.user.id);
    if (!venue) return res.status(403).json({ error: 'Not a venue owner' });
    if (!venue.verified) return res.status(403).json({ error: 'Replies unlock once your venue is verified' });
    if (rejectIfProfane(res, req.body.reply)) return;

    // Round 18: a hidden review is not repliable, and `RETURNING *` on one was
    // the worst leak of the three on this file. The route had no is_hidden
    // predicate at all, so an owner holding an id their client cached before the
    // takedown could POST a one-character reply and get the full row back —
    // rating, text, author — reading taken-down content straight through a write
    // endpoint. Writing the reply was itself a bypass: replies ride the verified
    // badge on the public card, so it attached business speech to a review
    // moderation had removed.
    //
    // 404 rather than a named refusal, and that is the deliberate answer: the
    // GET above no longer lists hidden reviews, so from this owner's side the
    // review genuinely is not there. Saying "that review was taken down" would
    // confirm the existence and the moderation state of a row we just decided
    // they may not see, and it would tell a harassing owner that their complaint
    // landed on a specific review.
    const { rows } = await pool.query(
      `UPDATE venue_reviews SET venue_reply = $1, venue_replied_at = NOW()
       WHERE id = $2 AND google_place_id = $3
         AND COALESCE(is_hidden, false) = false
       RETURNING *`,
      [req.body.reply, req.params.id, venue.google_place_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Review not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Reply to review error:', err);
    res.status(500).json({ error: 'Failed to reply to review' });
  }
});

// ─── PUBLIC: User submits a review (no venue-owner auth needed) ──────────────

// POST /api/venue-dashboard/submit-review — any logged-in user can review a venue
router.post('/submit-review', [
  // Round 12: venue_reviews.google_place_id is VARCHAR(255) — an unbounded id
  // overflowed it and surfaced as a 500 instead of a 400.
  // Round 20 (shape sweep). All three fields were reachable as arrays:
  //   * googlePlaceId fed the presence query AND a VARCHAR(255) column;
  //   * rating fed an INTEGER column behind CHECK (rating BETWEEN 1 AND 5), so
  //     `rating: [3]` satisfied isInt by coercion and came back 22P02 — a 500;
  //   * `text` is the review body itself. It is PUBLIC UGC about someone else's
  //     business, shown on the venue card and on the owner's dashboard, and it
  //     had no stripHtml on any path. `text: ["<b>x</b>"]` cleared isLength by
  //     coercion and was answered allowed:true by rejectIfProfane, so the
  //     profanity screen five lines down never saw it either.
  // Round 21: shape, not only width. This id is STORED (venue_reviews
  // .google_place_id) and it is the key the public venue card aggregates on, so
  // an unshaped one mints a review row for a "venue" that no flock can name
  // (routes/flocks.js validates flocks.venue_id with this same predicate) and
  // that utils/places.isKnownVenue will never recognise. Same rule
  // routes/feedback.js already enforces on venue_place_id, which is the file
  // this route's presence check is kept in step with.
  scalarOnly(body('googlePlaceId'), 'place id').trim().isLength({ min: 1, max: 200 }).withMessage('Place ID is required').bail()
    .custom(isPlaceIdShaped).withMessage('Place ID is not a valid place id'),
  scalarOnly(body('rating'), 'rating').isInt({ min: 1, max: 5 }).withMessage('Rating 1-5 required'),
  freeText(body('text').optional({ nullable: true }), 'review').isLength({ max: 1000 }).withMessage('Review is too long (max 1000 characters)'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const { googlePlaceId, rating, text } = req.body;
    // Reviews are UGC — same text screen as every other user-writable field.
    if (text && rejectIfProfane(res, text)) return;

    // Round 16: you may only review a venue you can be shown to have visited.
    // ON CONFLICT (google_place_id, user_id) already stopped ONE account from
    // stuffing repeats, but nothing stopped an account from rating a place it
    // had never been to — including a competitor's, one star at a time, from as
    // many accounts as someone cares to make. The public rating on the venue
    // card is derived from these rows.
    //
    // This is the same trust rule venue_feedback.verified uses (routes/
    // feedback.js VERIFIED_PRESENCE_SQL): an HMAC-signed NFC tap ('nfc';
    // unsigned URL visits are stored as 'nfc_unverified' by migration 004 and
    // prove nothing), OR accepted membership in a flock that met at this venue.
    // Both halves are required to keep the real flow working — almost no venue
    // has an NFC tag yet, so check-ins alone would refuse nearly every honest
    // review, and the flock signal is what the product's own loop produces.
    //
    // THE CONDITIONS ARE NOW IDENTICAL TO feedback.js; ONLY THE WINDOWS DIFFER.
    // That was not true until this round. The flock branch was missing the
    // "at least two accepted members" clause while the comment above it claimed
    // parity, and the missing clause is the load-bearing one: creating a flock
    // is a single POST with a client-supplied venue_id, so a solo flock is
    // self-certification. One account could mint a five-star review — or a
    // one-star review of a competitor — for any Google place id on earth, at
    // will, and the public star rating on the venue card is derived from these
    // rows. Requiring a second account to ACCEPT does not make forgery
    // impossible; it changes the cost from one request to a second real account
    // that also has to accept, per fabricated venue. Flock is a group product,
    // and a hangout of one is not what a venue review is supposed to describe.
    // Keep this clause in step with feedback.js — __tests__/presenceParity
    // .test.js compares the two statements clause by clause.
    //
    // DELIBERATE DIFFERENCES, kept on purpose (the test above asserts these too,
    // so they cannot be "fixed" into a false equivalence):
    //   * Windows. Feedback is a LIVE crowd report, so it trusts a 3-hour tap
    //     and a ±12-hour event. A review is written after the fact, often the
    //     next morning, so presence counts for 30 days on both signals.
    //     Reviewing while you are still there also works: the event window
    //     keeps feedback's 12-hour lead.
    //   * The third EXISTS below has no counterpart in feedback.js, because
    //     feedback INSERTs and this route UPSERTs. See the note on it.
    // Shared with feedback.js and NOT a difference: a cancelled flock is an
    // explicit "we did not go" and proves nothing, and a flock with no
    // event_time cannot be dated and is not counted either.
    //
    // Honest about what this is: it raises the cost of a fabricated review from
    // one POST to a fabricated flock with a second consenting account, and it is
    // the strongest presence signal this codebase has. It is not proof against a
    // determined script with two accounts. Closing that needs the NFC/geo
    // signal, which almost no venue has hardware for yet. The same limit applies
    // to venue_feedback.verified today.
    const presence = await pool.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM venue_checkins
           WHERE user_id = $1
             AND venue_place_id = $2
             AND checkin_source = 'nfc'
             AND created_at > NOW() - INTERVAL '30 days'
         )
         OR EXISTS (
           SELECT 1
           FROM flock_members fm
           JOIN flocks f ON f.id = fm.flock_id
           WHERE fm.user_id = $1
             AND fm.status = 'accepted'
             AND f.venue_id = $2
             AND f.status IS DISTINCT FROM 'cancelled'
             AND f.event_time BETWEEN NOW() - INTERVAL '30 days'
                                  AND NOW() + INTERVAL '12 hours'
             AND (
               SELECT COUNT(*) FROM flock_members m
               WHERE m.flock_id = f.id AND m.status = 'accepted'
             ) >= 2
         )
         -- This route is an upsert: the same POST edits an existing review.
         -- Presence is proved when the review is FIRST written, and it would be
         -- absurd to lock someone out of correcting their own words two months
         -- later. Rows that predate this rule keep their author's edit rights
         -- for the same reason nothing backfills them away.
         OR EXISTS (
           SELECT 1 FROM venue_reviews
           WHERE user_id = $1 AND google_place_id = $2
         ) AS visited`,
      [req.user.id, googlePlaceId]
    );
    if (presence.rows[0]?.visited !== true) {
      return res.status(403).json({
        error: 'You can review a venue after you have been there with a flock.',
        code: 'VISIT_REQUIRED',
      });
    }

    // Round 20: an edit that CHANGES the review drops the owner's reply.
    //
    // This is an upsert, so the same POST rewrites an existing review — and the
    // DO UPDATE list left venue_reply and venue_replied_at alone. On the public
    // card a reply is rendered underneath the review it answers, carrying the
    // verified badge, so the sequence "write a fair review -> owner replies
    // 'thanks for coming' -> rewrite the review as an abusive one" left the
    // owner's name attached to, and apparently endorsing, words they never saw.
    // The owner had no way to notice and no way to retract it: the reply route
    // only ever sets a reply, never clears one.
    //
    // Only a real change clears it. A resubmit of identical content — which is
    // what a double-tapped Submit button sends — must not throw away a reply
    // the owner wrote, so the CASE compares the incoming values with
    // IS DISTINCT FROM rather than clearing unconditionally. is_hidden is
    // deliberately still untouched: a taken-down review stays taken down
    // however many times its author rewrites it.
    //
    // A cleared reply is a deletion, not a takedown, so nothing is said about
    // it here; the owner sees the reply gone from their reviews tab and can
    // reply again to the words that are actually there now.
    const { rows } = await pool.query(
      `INSERT INTO venue_reviews (google_place_id, user_id, rating, text)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (google_place_id, user_id) DO UPDATE SET
         rating = EXCLUDED.rating,
         text = EXCLUDED.text,
         created_at = NOW(),
         venue_reply = CASE
           WHEN EXCLUDED.rating IS DISTINCT FROM venue_reviews.rating
             OR EXCLUDED.text IS DISTINCT FROM venue_reviews.text
           THEN NULL ELSE venue_reviews.venue_reply END,
         venue_replied_at = CASE
           WHEN EXCLUDED.rating IS DISTINCT FROM venue_reviews.rating
             OR EXCLUDED.text IS DISTINCT FROM venue_reviews.text
           THEN NULL ELSE venue_reviews.venue_replied_at END
       RETURNING *`,
      [googlePlaceId, req.user.id, rating, text || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Submit review error:', err);
    res.status(500).json({ error: 'Failed to submit review' });
  }
});

// google_place_id is VARCHAR(255) everywhere it is stored, so a longer path
// segment can never match a row — it is only an index scan we pay for. Bound it
// at the column width and READ the result: a declared-but-unread chain is the
// decorative-validator bug this file has already been fixed for twice.
//
// Round 21: shaped, not merely bounded — the same predicate routes/feedback.js
// puts on its own public per-venue read (GET /api/feedback/venue/:placeId), so
// the two user-facing venue-card reads no longer disagree about what a place id
// is. Nothing legitimate is refused: every venue a user can actually be at
// reached them through a flock, and routes/flocks.js already validates
// flocks.venue_id against this predicate.
const placeIdParam = param('placeId').isString().isLength({ min: 1, max: 255 })
  .withMessage('placeId required').bail()
  .custom(isPlaceIdShaped).withMessage('placeId is not a valid place id');

// GET /api/venue-dashboard/public-reviews/:placeId — get reviews for any venue (for user-facing venue cards)
router.get('/public-reviews/:placeId', placeIdParam, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const limit = reviewPageSize(req.query.limit);

    // `average` and `total` were derived from the 50-row page, so past 50
    // reviews a venue's public rating silently became "average of the newest
    // 50" and the count froze at 50 — the number users compare venues on was
    // wrong precisely for the venues with the most reviews. Aggregate over
    // every visible row, with the SAME visibility rules as the list below so
    // the two cannot disagree.
    const statsResult = await pool.query(
      `SELECT COUNT(*)::int AS total, AVG(vr.rating)::float AS average
       FROM venue_reviews vr
       JOIN users u ON u.id = vr.user_id
       WHERE vr.google_place_id = $1
         AND COALESCE(vr.is_hidden, false) = false
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $2 AND b.blocked_id = vr.user_id)
              OR (b.blocker_id = vr.user_id AND b.blocked_id = $2)
         )`,
      [req.params.placeId, req.user.id]
    );
    const total = statsResult.rows[0]?.total || 0;
    const average = total > 0 ? parseFloat(Number(statsResult.rows[0].average).toFixed(1)) : 0;

    // venue_reply comes from whoever claimed the place — expose it publicly
    // only when that claim is verified. User reviews themselves always show.
    // EXISTS rather than the previous LEFT JOIN on venue_profiles: nothing
    // makes google_place_id unique in that table, so two verified claims on one
    // place duplicated every review row in this response (and would have
    // double-weighted them in the average).
    const { rows } = await pool.query(
      `SELECT vr.id, vr.rating, vr.text,
              CASE WHEN EXISTS (
                SELECT 1 FROM venue_profiles vp
                WHERE vp.google_place_id = vr.google_place_id AND vp.verified = true
              ) THEN vr.venue_reply ELSE NULL END AS venue_reply,
              CASE WHEN EXISTS (
                SELECT 1 FROM venue_profiles vp
                WHERE vp.google_place_id = vr.google_place_id AND vp.verified = true
              ) THEN vr.venue_replied_at ELSE NULL END AS venue_replied_at,
              vr.created_at, u.name, u.profile_image_url
       FROM venue_reviews vr
       JOIN users u ON u.id = vr.user_id
       WHERE vr.google_place_id = $1
         AND COALESCE(vr.is_hidden, false) = false
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $2 AND b.blocked_id = vr.user_id)
              OR (b.blocker_id = vr.user_id AND b.blocked_id = $2)
         )
       ORDER BY vr.created_at DESC
       LIMIT $3`,
      [req.params.placeId, req.user.id, limit]
    );

    res.json({ reviews: rows, average, total, hasMore: total > rows.length });
  } catch (err) {
    console.error('Get public reviews error:', err);
    res.status(500).json({ error: 'Failed to get reviews' });
  }
});

// ─── PROMOTION VIEW COUNTING ─────────────────────────────────────────────────
//
// `views` is not decoration. It is the one usage number the dashboard shows a
// venue owner about their own paid content, and VENUE-BILLING.md prices the
// venue product on exactly this class of figure — so a counter an owner can
// move by refreshing is a number we would be charging them to read back to
// themselves. Before this it was `views = views + 1` on EVERY authenticated
// GET of the venue card, with no idea who was asking.
//
// Two rules, closing two different holes:
//
//   1. THE OWNER'S OWN VIEWS DO NOT COUNT. The owner opening their own venue
//      card in the consumer app is the cheapest self-inflation there is, and it
//      also happens by accident — an owner checking that a promotion looks
//      right inflates the metric they are checking. Enforced in the UPDATE
//      (`venue_user_id <> $2`) rather than by an early return, so it holds per
//      ROW for every promotion in the batch and cannot be lost to a later edit
//      that reorders the JavaScript above it. `<>` and not IS DISTINCT FROM on
//      purpose: a NULL venue_user_id would then be counted, and such a row can
//      never be served at all (the public SELECT INNER JOINs venue_profiles on
//      that column), so the only difference the two spellings could ever make
//      is on a row nobody can see.
//
//   2. ONE ACCOUNT COUNTS ONCE PER PROMOTION PER WINDOW. Pull-to-refresh, a
//      re-render, or a script in a loop were each a view. A "view" is a person
//      seeing the promotion, so repeats inside a short window are the same
//      view.
//
// WHAT THIS IS NOT. Rule 2 is an IN-PROCESS window, because the honest fix
// needs storage this change is not allowed to add. Its limits, stated so they
// are not mistaken for a solved problem:
//   * it is per Node process, so N Railway instances allow up to N counts per
//     window, and a deploy or a restart clears it;
//   * it is bounded (VIEW_DEDUPE_MAX), and an evicted key can be counted again
//     — eviction degrades toward the OLD behaviour, never below it;
//   * it does nothing about a second account. Nothing without identity can;
//   * evicting a key costs an attacker one fetch per OTHER live promotion in
//     the map before their own entry is the oldest again, so the eviction path
//     is a bad trade for them and a cheap safety valve for us. It is also the
//     least-harmful policy available: the oldest entries are the ones closest
//     to expiring anyway.
// The durable version is a `venue_promotion_views (promotion_id, user_id,
// viewed_at)` table with UNIQUE (promotion_id, user_id, day) and `views` read
// as a COUNT rather than kept as a running total — see the report note.
//
// A view is marked BEFORE the UPDATE and is NOT un-marked if that UPDATE fails,
// so a database error loses at most one view per account per promotion per
// window. That direction is deliberate: under-counting an analytic somebody
// will be billed on is a smaller wrong than a retry loop that counts.
const VIEW_DEDUPE_MS = 30 * 60 * 1000;
const VIEW_DEDUPE_MAX = 20000;
// `${userId}:${promotionId}` -> last counted at. Both halves are integers we
// generated (users.id from the JWT, venue_promotions.id straight off the row),
// so the key cannot be forged into a collision with another user's.
const recentPromotionViews = new Map();

// A Map iterates in insertion order and `set` on an EXISTING key keeps that
// key's original position, so a refresh has to delete before it sets —
// otherwise a promotion viewed constantly looks permanently old to the
// age-ordered pass below. Same reasoning as utils/places.rememberKnownVenue.
function claimPromotionViews(userId, ids) {
  const now = Date.now();
  const countable = [];
  for (const id of ids) {
    const key = `${userId}:${id}`;
    const seen = recentPromotionViews.get(key);
    if (seen !== undefined && now - seen < VIEW_DEDUPE_MS) continue;
    recentPromotionViews.delete(key);
    recentPromotionViews.set(key, now);
    countable.push(id);
  }
  if (recentPromotionViews.size > VIEW_DEDUPE_MAX) {
    for (const [k, ts] of recentPromotionViews) {
      if (now - ts >= VIEW_DEDUPE_MS) recentPromotionViews.delete(k);
    }
    while (recentPromotionViews.size > VIEW_DEDUPE_MAX) {
      recentPromotionViews.delete(recentPromotionViews.keys().next().value);
    }
  }
  return countable;
}

// GET /api/venue-dashboard/public-promotions/:placeId — get active promotions for a venue (user-facing)
router.get('/public-promotions/:placeId', placeIdParam, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    // Only VERIFIED venues publish publicly — an unverified claim on a Google
    // Place ID must not let a stranger speak as that business (audit 2026-08-12).
    // Round 4: the join is on the promotion AUTHOR's own profile, not the place
    // id alone — matching by place id let an unverified claimant's promotion
    // ride on someone else's verified claim for the same place.
    //
    // Round 16: `verified` is a permanent property of the claim, so gating on it
    // alone meant upgrade -> create promotions -> downgrade kept the benefit
    // forever. "Promotions to nearby groups" is an Insights line item in the
    // VENUE-BILLING.md pricing table, so the SERVING of one is gated on the tier
    // the author holds right now, exactly as creating one is (requirePremium).
    // The kill switch is a bound PARAMETER, not string-built SQL: one query
    // shape, no request data anywhere near the text, and "flag off => every
    // venue owner acts Pro" holds for this public route the same way
    // requireVenueTier makes it hold for the owner-facing ones. A NULL tier
    // fails the ANY test, so an unrecognised tier is not served either.
    const { rows } = await pool.query(
      `SELECT p.id, p.title, p.description, p.time_slot, p.days FROM venue_promotions p
       JOIN venue_profiles vp ON vp.user_id = p.venue_user_id
         AND vp.google_place_id = p.google_place_id
         AND vp.verified = true
         AND ($2::boolean = false OR vp.tier = ANY($3::text[]))
       WHERE p.google_place_id = $1 AND p.active = true AND COALESCE(p.is_hidden, false) = false
       ORDER BY p.created_at DESC
       LIMIT 100`,
      [req.params.placeId, venueBillingEnabled(), SERVING_TIERS]
    );
    // Count the view — see the two rules above claimPromotionViews. Bounded by
    // the LIMIT above, so the ANY($1) set never grows without limit either.
    //
    // A failure here must NOT cost the reader their promotions: the analytic is
    // worth less than the content it is counting, and the old code let an
    // UPDATE error fall into the outer catch and answer 500 with a perfectly
    // good result set already in hand.
    if (rows.length > 0) {
      const countable = claimPromotionViews(req.user.id, rows.map((r) => r.id));
      if (countable.length > 0) {
        try {
          await pool.query(
            // The owner is excluded per ROW, not per request: one owner's
            // promotion sitting in a batch cannot make the whole batch
            // uncountable, and one stranger's request cannot count a row for
            // the owner who is asking.
            'UPDATE venue_promotions SET views = views + 1 WHERE id = ANY($1) AND venue_user_id <> $2',
            [countable, req.user.id]
          );
        } catch (viewErr) {
          console.error('Promotion view count failed:', viewErr.message);
        }
      }
    }
    res.json({ promotions: rows });
  } catch (err) {
    console.error('Get public promotions error:', err);
    res.status(500).json({ error: 'Failed to get promotions' });
  }
});

// ─── VENUE INTELLIGENCE ──────────────────────────────────────────────────────
// Real, model-powered analytics for the venue owner. This is the zero-user
// venue product: their own forecast and the competitive strip view, computed
// by the same crowd model users see. It replaces the hardcoded demo numbers
// the old Analytics tab showed (VENUE-BILLING.md finding #3): nothing here is
// invented; if we can't compute it, the field is null and the UI says so.

const { getWeather } = require('../services/weatherService');
const mlPredictor = require('../services/mlPredictor');
// Round 15: the owner dashboard scored on Railway's UTC clock. venueLocalNow +
// weekdayOffset move scoring onto the venue's wall clock, same as routes/crowd.js.
const crowdEngine = require('../services/crowdEngine');
// Round 9: these Places fetches bypassed the shared paid-call budget that
// venueSearch and crowd.js are both charged against.
const { allowPlacesSearch } = require('../utils/placesBudget');
const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;
const BUDGET_MESSAGE = 'Too many venue lookups right now. Try again in a little while.';

// 60-min cache: Google calls cost money and forecasts don't move fast.
const intelCache = new Map();
const INTEL_TTL = 60 * 60 * 1000;
const INTEL_MAX = 500;
const cacheGet = (k) => {
  const hit = intelCache.get(k);
  if (hit && Date.now() - hit.ts < INTEL_TTL) return hit.data;
  intelCache.delete(k);
  return null;
};
const cacheSet = (k, data) => {
  intelCache.set(k, { ts: Date.now(), data });
  // Round 9: unbounded before — one entry per place id the owner can relink to.
  if (intelCache.size > INTEL_MAX) {
    const now = Date.now();
    for (const [key, v] of intelCache) {
      if (now - v.ts > INTEL_TTL) intelCache.delete(key);
    }
    // Fresh-but-oversized: evict oldest first (same pattern as crowd.js).
    while (intelCache.size > INTEL_MAX) intelCache.delete(intelCache.keys().next().value);
  }
};

// Returned instead of a venue when the shared Places budget is spent, so the
// route can answer 429 rather than pretend Google was unreachable.
const BUDGET_EXCEEDED = Symbol('places_budget_exceeded');

// Google Places v1 returns price as an enum; the crowd model and the rule
// engine both want the legacy 0-4 number. Same map as routes/crowd.js,
// routes/publicCrowd.js, routes/badge.js and routes/ai.js.
//
// Round 20: this file had no such converter AT ALL, which is how both venue
// shapes below came to omit `price_level` — see the note on fetchVenueBasics.
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

async function fetchVenueBasics(placeId, userId) {
  if (!GOOGLE_KEY) return null;
  // Round 9: charge the shared budget before every paid upstream call.
  if (!allowPlacesSearch(userId)) return BUDGET_EXCEEDED;
  // ENCODED, same reason as routes/crowd.js fetchVenueFromGoogle: a `/../` or a
  // `?` in this id re-points the call at a different Google endpoint carrying
  // our API key.
  //
  // Round 21 UPDATE — the sentence that used to be here ("nothing on that write
  // path constrains it to utils/places.isPlaceIdShaped") is no longer true, and
  // it is why routes/venueProfile.js was fixed rather than this line hardened
  // further: the encoding was covering for a missing validation instead of
  // being belt and braces. Both venue-profile routes now validate against the
  // shared predicate, so a value written today cannot contain any of these
  // characters at all.
  //
  // THE ENCODING STAYS ANYWAY, for two reasons that outlive that fix. Rows
  // written BEFORE the validation landed are grandfathered and can still hold
  // anything (see the cleanup query in the audit report), and this function is
  // one `require` away from being called with an id that came from somewhere
  // else. A call that spends money and carries a server-restricted key does not
  // get to rely on a guarantee made in another file.
  const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: {
      'X-Goog-Api-Key': GOOGLE_KEY,
      // Round 15: utcOffsetMinutes drives the venue-clock scoring below and the
      // event window in predictBusyness (trueEventInstant). Dropping it reverts
      // both to the server clock — mirrors the crowd.js field mask.
      'X-Goog-FieldMask': 'id,displayName,rating,userRatingCount,priceLevel,types,location,currentOpeningHours,utcOffsetMinutes',
    },
    signal: upstreamSignal('places'), // round 12 — see utils/upstream.js
  });
  const p = await r.json();
  if (p.error) return null;
  return {
    place_id: p.id,
    name: p.displayName?.text || '',
    rating: p.rating || null,
    user_ratings_total: p.userRatingCount || 0,
    // Round 20: THE FIELD MASK ABOVE HAS ALWAYS ASKED GOOGLE FOR `priceLevel`
    // AND THIS SHAPE HAS NEVER CARRIED IT. services/mlPredictor.js
    // buildFeatureMap reads `venue.price_level != null ? venue.price_level :
    // (metadata.median_price_level || 2)`, so the owner's own venue was scored
    // at the corpus MEDIAN price level on every dashboard load: a dive bar and
    // a steakhouse were handed to the model as the same price tier, and
    // `price_level` is a trained feature, so the number that came back was
    // real-looking and systematically wrong. Same class as the coordinate bug
    // round 15 found one layer down (a field read at inference that no live
    // caller populated the way training did). We paid for this field on every
    // call and then threw it away.
    price_level: priceLevelToNum(p.priceLevel),
    types: p.types || [],
    location: p.location || null,
    isOpen: p.currentOpeningHours?.openNow ?? null,
    // Nullable: Google omits it for some places, and callers fall back to the
    // server clock when it is null.
    utcOffsetMinutes: p.utcOffsetMinutes != null ? p.utcOffsetMinutes : null,
  };
}

// Both routes below are gated the same way, and BOTH checks run before the
// cache read: the cache is keyed by place id, so an unverified claimant on the
// same place id would otherwise be handed the verified owner's cached forecast
// without a single Google call to notice.
//
//   requirePremium — the demand curve is an Insights line item in the
//   VENUE-BILLING.md pricing table (see the tier note at the top of this file).
//   403 UPGRADE_REQUIRED, the contract the frontend already forwards.
//
//   verified — an unverified claim is an unproven one. Serving these two costs
//   real money (each spends the shared Places budget) and the strip hands out
//   competitive data about the neighbours, so a mere claim on an arbitrary
//   Google place id must not buy either. Answered as `available: false` with a
//   reason rather than a 403 so the dashboard can say what to do about it —
//   same shape incoming-flocks already uses for the same condition.
// One definition, shared with routes/advisor.js (utils/verificationCopy.js).
// The sentence that stood here was an instruction with no path: it told the
// owner to verify their venue, and TestFlight 2026-08-21 found nothing
// anywhere started a verification. The copy now names the request route, and
// switches once the request is pending, which is why the ctx (whose SELECT
// above carries verification_requested_at) is passed at every use site.
const { unverifiedReason, liveNumberRefusal } = require('../utils/verificationCopy');

// GET /api/venue-dashboard/intelligence — the owner's own forecast
router.get('/intelligence', requirePremium, async (req, res) => {
  try {
    const ctx = await getVenueCtx(req.user.id);
    if (!ctx?.google_place_id) {
      return res.json({ available: false, reason: 'Link your Google listing in Edit Profile to unlock forecasts' });
    }
    if (!ctx.verified) return res.json({ available: false, unverified: true, reason: unverifiedReason(ctx) });
    const cached = cacheGet(`intel:${ctx.google_place_id}`);
    if (cached) return res.json(cached);

    const venue = await fetchVenueBasics(ctx.google_place_id, req.user.id);
    if (venue === BUDGET_EXCEEDED) return res.status(429).json({ error: BUDGET_MESSAGE });
    // A lookup that did not answer is the one unavailable state here that a
    // second attempt can change, so it says so and the dashboard puts a Try
    // again under it. The two above it (no listing, unverified) are settled,
    // and a retry button under a settled fact is a button that lies.
    if (!venue) return res.json({ available: false, code: 'lookup_failed', reason: 'Could not reach your Google listing right now' });

    const lat = venue.location?.latitude;
    const lng = venue.location?.longitude;
    const weather = (lat && lng) ? await getWeather(lat, lng).catch(() => null) : null;

    const now = new Date();
    // Score on the VENUE's wall clock, not Railway's UTC. Same contract as
    // routes/crowd.js: venueLocalNow turns Google's utcOffsetMinutes into the
    // hour/day the doors actually run on, and weekdayOffset lands the base date
    // on the venue's own weekday (nearest match) so the holiday / special-night
    // features and the 6-day outlook walk the venue's calendar, not the
    // server's. Falls back to the server clock when Google gives us no offset.
    const venueClock = crowdEngine.venueLocalNow(venue.utcOffsetMinutes, now);
    const localHour = venueClock ? venueClock.hour : now.getHours();
    const localDay = venueClock ? venueClock.day : now.getDay();
    const venueBase = new Date(now);
    venueBase.setDate(venueBase.getDate() + crowdEngine.weekdayOffset(venueBase.getDay(), localDay));
    const scoreTime = new Date(venueBase);
    scoreTime.setHours(localHour, 0, 0, 0);

    const current = await mlPredictor.predictBusyness(venue, weather, scoreTime);
    // Full day today (6 AM start), then evening curves for the next 6 days.
    const todayHourly = await mlPredictor.predictHourlyForecast(venue, weather, 6, 18, venueBase);
    const week = [];
    for (let d = 1; d <= 6; d++) {
      const day = new Date(venueBase);
      day.setDate(day.getDate() + d);
      day.setHours(17, 0, 0, 0);
      const evening = await mlPredictor.predictHourlyForecast(venue, weather, 17, 7, day);
      // WHICH evening hour is the peak is an ordering question, and ordering
      // is not the model's job any more: on within-night hour pairs the
      // trained delta layer scores 62.7% against the popular-times curve's
      // 63.1%, negative in every gap bucket (scripts/ml/HOUR-RANKING-EVAL.md).
      // crowdEngine.orderingAxis is the one definition of which number ranks
      // hours, and it picks the axis for the whole evening at once, falling
      // back to model scores when any hour lacks a baseline. HOW BUSY that
      // hour is stays the model's number, read at the hour just named, so the
      // pair the owner reads describes one hour rather than two.
      const rank = crowdEngine.orderingAxis(evening).valueOf;
      const peak = evening.length
        ? evening.reduce((a, b) => (rank(b) > rank(a) ? b : a), evening[0])
        : null;
      week.push({
        date: day.toISOString().slice(0, 10),
        weekday: day.toLocaleDateString('en-US', { weekday: 'short' }),
        peakScore: peak ? (peak.score ?? null) : null,
        peakHour: peak ? (peak.hour ?? null) : null,
      });
    }

    const result = {
      available: true,
      venue: { name: venue.name, placeId: venue.place_id },
      now: { score: current.score, label: current.label, method: current.predictionMethod || (current.dataSourcesUsed?.includes('ml_model') ? 'ml' : 'rule_engine') },
      // `baselineScore` is a SERVE-PATH field, dropped here exactly as
      // routes/crowd.js drops it from the consumer card: it is the number
      // orderingAxis ranks on, and publishing it invites a client to re-derive
      // an ordering of its own beside the one the server already decided. The
      // published level per hour is the model's, which is what these bars are.
      todayHourly: todayHourly.map(({ baselineScore, ...bar }) => bar),
      week,
      model: current.modelVersion || null,
      generatedAt: new Date().toISOString(),
    };
    cacheSet(`intel:${ctx.google_place_id}`, result);
    res.json(result);
  } catch (err) {
    console.error('Venue intelligence error:', err);
    res.status(500).json({ error: 'Failed to build venue intelligence' });
  }
});

// GET /api/venue-dashboard/strip — you vs the venues around you, tonight.
// Google Popular Times cannot do this: it is per-venue, read-only, no API.
router.get('/strip', requirePremium, async (req, res) => {
  try {
    const ctx = await getVenueCtx(req.user.id);
    if (!ctx?.google_place_id) {
      return res.json({ available: false, reason: 'Link your Google listing in Edit Profile to unlock the strip view' });
    }
    if (!ctx.verified) return res.json({ available: false, unverified: true, reason: unverifiedReason(ctx) });
    const cached = cacheGet(`strip:${ctx.google_place_id}`);
    if (cached) return res.json(cached);
    if (!GOOGLE_KEY) return res.json({ available: false, reason: 'Search unavailable right now' });

    const me = await fetchVenueBasics(ctx.google_place_id, req.user.id);
    if (me === BUDGET_EXCEEDED) return res.status(429).json({ error: BUDGET_MESSAGE });
    if (!me?.location) return res.json({ available: false, reason: 'Could not reach your Google listing right now' });

    // Same-category venues within walking distance.
    const wanted = ['bar', 'night_club', 'restaurant'].filter((t) => me.types.includes(t));
    // Round 9: searchNearby is a second paid call — charge it separately.
    if (!allowPlacesSearch(req.user.id)) return res.status(429).json({ error: BUDGET_MESSAGE });
    const nearbyRes = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_KEY,
        // Round 15: utcOffsetMinutes so each competitor is scored on its own
        // wall clock (see scoreOne) instead of the server's.
        // Round 20: userRatingCount, because the model's `review_count` feature
        // was reading 0 for every competitor. See the shaping below.
        'X-Goog-FieldMask': 'places.id,places.displayName,places.types,places.location,places.priceLevel,places.rating,places.userRatingCount,places.currentOpeningHours,places.utcOffsetMinutes',
      },
      body: JSON.stringify({
        includedTypes: wanted.length ? wanted : ['bar'],
        maxResultCount: 8,
        locationRestriction: {
          circle: { center: { latitude: me.location.latitude, longitude: me.location.longitude }, radius: 1500 },
        },
      }),
      signal: upstreamSignal('places'), // round 12
    });
    // The verdict is read from the RESPONSE as well as from the body. Round 19
    // checked `nearby.error` alone, which is Google's own error envelope and
    // covers Google's own failures — but not the two that arrive without one: a
    // gateway or proxy in front of Places answering a non-2xx with a body that
    // is not that envelope, and a body that is not JSON at all (which used to
    // throw out of the old `.then(r => r.json())` and land in the outer catch as
    // a 500). Both previously left `places` undefined, which `(nearby.places ||
    // [])` below reads as a successful search that found nobody — the exact
    // false answer round 19 removed, through a different door.
    let nearby = null;
    try { nearby = await nearbyRes.json(); } catch { /* not JSON: handled below */ }

    // Round 19: `(nearby.places || [])` swallowed an upstream failure. A quota,
    // auth or Places outage comes back as `{ error: ... }` with no `places` key,
    // which read as a successful search that found nothing — so the strip view
    // answered `available: true` with an empty competitor list and told a venue
    // owner there is nobody around them tonight. Worse, that answer was written
    // into the 60-minute cache, so one blip froze the false reading for an hour
    // while the owner's own dial kept updating beside it. An honest refusal the
    // dashboard can explain, and nothing cached, so the next request retries.
    // (Same rule routes/publicCrowd.js already follows for its two searches, and
    // the same one fetchVenueBasics above follows for the owner's own listing.)
    if (!nearby || nearby.error || nearbyRes.status >= 400) {
      console.error('[VenueStrip] Places searchNearby failed:',
        nearby?.error?.message || nearby?.error?.status || `HTTP ${nearbyRes.status}`);
      return res.json({
        available: false,
        reason: 'Could not load the venues around you right now. Try again in a few minutes.',
      });
    }

    const weather = await getWeather(me.location.latitude, me.location.longitude).catch(() => null);
    const now = new Date();

    const scoreOne = async (v) => {
      // Each venue is scored on ITS OWN wall clock (same contract as
      // routes/crowd.js), not Railway's UTC. Competitors sit beside `me` so
      // they share a zone in practice, but reading the offset per venue keeps
      // this correct regardless, and lets trueEventInstant land the event
      // window on the real instant. Server clock is the fallback when Google
      // gave us no offset.
      const clock = crowdEngine.venueLocalNow(v.utcOffsetMinutes, now);
      const localHour = clock ? clock.hour : now.getHours();
      const localDay = clock ? clock.day : now.getDay();
      const base = new Date(now);
      base.setDate(base.getDate() + crowdEngine.weekdayOffset(base.getDay(), localDay));
      const scoreTime = new Date(base);
      scoreTime.setHours(localHour, 0, 0, 0);
      const [current, evening] = await Promise.all([
        mlPredictor.predictBusyness(v, weather, scoreTime),
        mlPredictor.predictHourlyForecast(v, weather, 17, 7, base),
      ]);
      const peak = evening.reduce((a, b) => (b.score > a.score ? b : a), { score: -1 });
      return {
        name: v.name,
        score: current.score,
        label: current.label,
        peakScore: peak.score ?? null,
        peakHour: peak.hour ?? null,
        // What produced the number. A rule-engine row is a CATEGORY PRIOR —
        // the same figure for every same-category venue — and dressing one as
        // a model reading is exactly how the strip lies. The client labels
        // these, and stripOrderingClaim below refuses to rank them at all.
        method: current.predictionMethod || null,
      };
    };

    const competitors = (nearby.places || [])
      .filter((p) => p.id !== me.place_id)
      .slice(0, 6)
      .map((p) => ({
        place_id: p.id,
        name: p.displayName?.text || '',
        types: p.types || [],
        location: p.location || null,
        rating: p.rating || null,
        // Round 20: BOTH OF THESE WERE MISSING, and both are trained features
        // the model reads at inference (services/mlPredictor.js
        // buildFeatureMap). The shape decides what the model sees, and what it
        // saw was:
        //   * `review_count` = 0 for every competitor, because
        //     `venue.user_ratings_total || venue.review_count || 0` fell all
        //     the way through. Every bar on the strip was scored as a venue
        //     nobody has ever reviewed.
        //   * `price_level` = the corpus median (2), because the fallback is
        //     `venue.price_level != null ? ... : (metadata.median_price_level
        //     || 2)`. The dive and the cocktail bar next door were the same
        //     price tier as far as the model was concerned.
        // Neither showed up as an error anywhere. The strip returned a
        // plausible-looking score per competitor and the owner compared their
        // own dial against it, which is the whole product of this view. Same
        // failure class as the coordinate bug in round 15: a field read at
        // inference that no live caller populated the way training did.
        //
        // The field mask above now requests userRatingCount for this. Both were
        // already fetched-or-fetchable and thrown away, so this costs no extra
        // Google call.
        user_ratings_total: p.userRatingCount || 0,
        price_level: priceLevelToNum(p.priceLevel),
        isOpen: p.currentOpeningHours?.openNow ?? null,
        // Scored on the competitor's own clock in scoreOne; null -> server clock.
        utcOffsetMinutes: p.utcOffsetMinutes != null ? p.utcOffsetMinutes : null,
      }));

    const you = await scoreOne(me);
    const scored = await Promise.all(competitors.map(scoreOne));
    const result = {
      available: true,
      you,
      // Each row says whether an ordering may be CLAIMED against it, decided
      // server-side by stripOrderingClaim so the client cannot re-derive a
      // ranking the measurement refused. Rows below the gap still show their
      // numbers — the numbers are honest — they just carry no ranking sentence.
      competitors: scored.map((c) => ({ ...c, orderingClaim: stripOrderingClaim(you, c) })),
      // Published so the dashboard can say WHY two venues are not ranked
      // instead of leaving a gap the owner reads as a bug.
      orderingMinGap: STRIP_ORDERING_MIN_GAP,
      generatedAt: new Date().toISOString(),
    };
    cacheSet(`strip:${ctx.google_place_id}`, result);
    res.json(result);
  } catch (err) {
    console.error('Venue strip error:', err);
    res.status(500).json({ error: 'Failed to build the strip view' });
  }
});

// ─── THE STRIP HEDGE ─────────────────────────────────────────────────────────
//
// The strip is implicitly a RANKING, and the ranking was measured: pairwise
// ordering of same-night venue pairs on held-out rows came back 43.1% BACKWARDS
// (2026-08-19 model-defect hunt). A coin flip is 50%, so a raw "they're busier
// than you tonight" read off two model scores is slightly worse than guessing,
// delivered to a paying business as analytics. The numbers themselves stay —
// each is the same honestly-derived figure the consumer card shows — but a
// SENTENCE about their order is a second claim with its own (failed) accuracy,
// so it is only drawn when the gap is too wide for the measured noise to flip.
//
// WHY 25. Labels change every 20 points (crowdEngine.getLabel), so anything
// inside one band is two venues the product itself describes with the same
// word; TIE_MARGIN (5) is what crowdEngine already refuses to act on as noise
// within one venue. One full band plus that margin is the first gap where the
// ordering sentence and the labels cannot contradict each other. It is a floor
// argued from the product's own vocabulary, not a measured decision boundary —
// the 43.1% figure says the measurement cannot currently supply one.
const STRIP_ORDERING_MIN_GAP = 25;

// null = no claim. 'busier' / 'quieter' = the competitor relative to you.
// Rule-engine rows never claim, whatever the gap: two category priors differ
// about the categories, not about tonight — and a prior against a model score
// is a comparison of two different kinds of number wearing one axis.
function stripOrderingClaim(you, competitor) {
  if (!you || !competitor) return null;
  if (you.method !== 'ml' || competitor.method !== 'ml') return null;
  // == null before Number(): Number(null) is 0, and "no peak" scored as
  // "empty" would claim 'quieter' about a venue nothing was measured for.
  if (you.peakScore == null || competitor.peakScore == null) return null;
  const mine = Number(you.peakScore);
  const theirs = Number(competitor.peakScore);
  if (!Number.isFinite(mine) || !Number.isFinite(theirs)) return null;
  const gap = theirs - mine;
  if (Math.abs(gap) < STRIP_ORDERING_MIN_GAP) return null;
  return gap > 0 ? 'busier' : 'quieter';
}

// ─── OWNER BUSY SLIDER — "we are at X% right now" ────────────────────────────
//
// FREE AT EVERY TIER, PERMANENTLY. None of these three routes may ever take
// requireVenueTier (pinned as source text by __tests__/ownerBusyReports
// .test.js). The reading replaces a number CONSUMERS act on, and a paid tier
// that buys influence over a consumer-shown number is the LendEDU shape — the
// FTC's 2020 order against ratings that were sold rather than measured. What
// keeps this a disclosure instead of an advertisement is enforced in
// services/ownerReports.js, not in a pricing table: every surface labels the
// number as the venue's own claim (the category-derived attribution from
// utils/venueLabel.js — "the cafe says", "the club says"), it expires in 90
// minutes on its own, three verified user reports outrank it, and repeated
// divergence from those reports suppresses the override entirely.
//
// VERIFIED CLAIMS ONLY, same rule as /incoming-flocks: an unverified claim on
// an arbitrary place id must not set the public number for a business the
// claimant does not own. That is the anti-spoof gate, so the POST answers 403,
// not a soft available:false.
//
// RATE LIMITS live in SQL against the same table the reading lands in, so
// there is no module-scope counter to inventory and no second clock to drift:
// one write a minute (a human adjusting a slider, not a script sawtoothing the
// public number) and 48 a day (one every half hour around the clock — nobody
// legitimate reaches it, and it bounds what one account can mint as training
// rows for the export path).
const OWNER_REPORT_DAILY_CAP = 48;

// What the owner's dashboard needs to render the control truthfully: the
// reading users currently see (null when expired, retracted or suppressed) and
// whether the venue is strike-suppressed — in which case a fresh reading is
// still RECORDED (it is an observation, and observations are the training
// corpus) but not SERVED, and the owner is told so instead of being left to
// wonder why users see the forecast.
async function ownerBusyState(placeId) {
  const byPlace = await ownerReports.getLiveOwnerReports([placeId]);
  const live = ownerReports.liveOwnerReport(byPlace[placeId]);
  const { rows: [s] } = await pool.query(
    `SELECT COUNT(*)::int AS strikes FROM venue_owner_reports
      WHERE google_place_id = $1 AND diverged = true
        AND created_at > NOW() - INTERVAL '${ownerReports.OWNER_STRIKE_WINDOW_DAYS} days'`,
    [placeId]
  );
  const strikes = s?.strikes || 0;
  return { live, suppressed: strikes >= ownerReports.OWNER_DIVERGENCE_STRIKES };
}

// GET /api/venue-dashboard/busy-now — what users currently see from you.
router.get('/busy-now', async (req, res) => {
  try {
    const ctx = await getVenueCtx(req.user.id);
    if (!ctx?.google_place_id) {
      return res.json({ available: false, reason: 'Link your Google listing in Edit Profile to set a live number' });
    }
    if (!ctx.verified) return res.json({ available: false, unverified: true, reason: unverifiedReason(ctx) });
    const state = await ownerBusyState(ctx.google_place_id);
    res.json({
      available: true,
      ttlMinutes: ownerReports.OWNER_REPORT_TTL_MINUTES,
      // The exact words users see on the reading, so the dashboard's "shown
      // to users as ..." copy quotes the real label instead of guessing one.
      // Profile category, then the corpus row, then Google's types — see
      // attributionCategory.
      attribution: await ownerAttributionFor(ctx),
      ...state,
    });
  } catch (err) {
    console.error('Get busy-now error:', err);
    res.status(500).json({ error: 'Failed to load your live number' });
  }
});

// POST /api/venue-dashboard/busy-now { percent }
router.post('/busy-now', [
  // scalarOnly FIRST, like every other body field in this router — the header
  // at the top of the file says so and this one field was missing it. It is not
  // cosmetic here: express-validator coerces before it tests, so
  // `{ "percent": [80] }` satisfies isInt({ min: 0, max: 100 }) on the joined
  // string and then STAYS an array in req.body, because sanitizers leave
  // non-strings alone. `Number(req.body.percent)` below reads Number(['80'])
  // as 80 and the reading lands — but a two-element array is Number(['8','0'])
  // = NaN, which reaches a NOT NULL SMALLINT column with a CHECK on it and
  // comes back a 500 instead of a 400. Same shape guard, same position, same
  // reason as validators/shape.js documents.
  scalarOnly(body('percent'), 'percent').isInt({ min: 0, max: 100 }).withMessage('percent must be a whole number from 0 to 100'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }
    const ctx = await getVenueCtx(req.user.id);
    if (!ctx?.google_place_id) {
      return res.status(400).json({ error: 'Link your Google listing in Edit Profile first' });
    }
    if (!ctx.verified) {
      return res.status(403).json({ error: liveNumberRefusal(ctx) });
    }

    // BOTH CEILINGS AND THE INSERT RUN IN ONE TRANSACTION UNDER A PER-OWNER
    // ADVISORY LOCK. As two autocommit statements this was a count-then-insert
    // race — every concurrent POST read the same pre-insert counts, so all of
    // them passed and all of them landed. That is not an off-by-one on a spam
    // ceiling: these two limits are what stop an owner writing the number users
    // see faster than the 90-minute reading can expire, and the daily cap is
    // the only bound on how many owner-authored TRAINING LABELS one account can
    // manufacture in a day (scripts/ml/train/ownerLabelExport.js reads every
    // non-diverged row). Twenty parallel requests defeated both.
    //
    // Same shape routes/safety.js round 9 and routes/feedback.js round 4 use
    // for the same bug, down to the one-argument hashtext('domain:id') lock
    // form: a serialised read-then-write per user, with a distinct namespace
    // string so it collides with nothing else. A CTE would NOT have fixed this
    // — under READ COMMITTED both transactions still read a snapshot taken
    // before either insert, and there is no counter row here to take a row
    // lock on, because the table is an append-only log.
    const client = await pool.connect();
    let inserted;
    let refusal = null;
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('owner_busy:' || $1::text))", [String(req.user.id)]);

      const { rows: [recent] } = await client.query(
        `SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '60 seconds')::int AS last_minute,
                COUNT(*)::int AS last_day
           FROM venue_owner_reports
          WHERE venue_user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
        [req.user.id]
      );
      if ((recent?.last_minute || 0) > 0) {
        refusal = { status: 429, body: { error: 'One update a minute. The last one is still live.' } };
      } else if ((recent?.last_day || 0) >= OWNER_REPORT_DAILY_CAP) {
        refusal = { status: 429, body: { error: 'Daily limit reached. The number falls back to the forecast on its own.' } };
      } else {
        const result = await client.query(
          `INSERT INTO venue_owner_reports (venue_user_id, google_place_id, busy_percent)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [req.user.id, ctx.google_place_id, Number(req.body.percent)]
        );
        inserted = result.rows[0];
      }

      // A refusal COMMITs rather than rolling back: nothing was written, and
      // the commit is what releases the lock promptly for the owner's next
      // legitimate update. The rollback path below is for real failures.
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    if (refusal) return res.status(refusal.status).json(refusal.body);

    // Fire-and-forget, deliberately un-awaited: the reading is a training
    // label, and a label without its moment's context (weather, events, what
    // Flock itself was serving) is weak. The capture never blocks and never
    // fails this response — a missing source stores NULLs.
    //
    // Started AFTER the transaction commits, not inside it: the capture reads
    // its own connection out of the pool, and a row that is not committed yet
    // is a row it cannot see.
    if (inserted?.id != null) {
      ownerReportContext
        .captureOwnerReportContext(inserted.id, { placeId: ctx.google_place_id, userId: req.user.id })
        .catch(() => { /* capture never rejects; belt and braces */ });
    }
    const state = await ownerBusyState(ctx.google_place_id);
    // Same shape as the GET, attribution included: the dashboard replaces its
    // whole busy-now state with this response.
    res.status(201).json({
      available: true,
      ttlMinutes: ownerReports.OWNER_REPORT_TTL_MINUTES,
      attribution: await ownerAttributionFor(ctx),
      ...state,
    });
  } catch (err) {
    console.error('Set busy-now error:', err);
    res.status(500).json({ error: 'Failed to set your live number' });
  }
});

// DELETE /api/venue-dashboard/busy-now — the owner's own kill switch.
// Retracts, never deletes: an expired or retracted reading is still a labelled
// observation for the training export; it just stops being served.
router.delete('/busy-now', async (req, res) => {
  try {
    const ctx = await getVenueCtx(req.user.id);
    if (!ctx?.google_place_id) return res.status(400).json({ error: 'No linked listing' });
    const result = await pool.query(
      `UPDATE venue_owner_reports SET retracted = true
        WHERE venue_user_id = $1 AND retracted = false
          AND created_at > NOW() - INTERVAL '${ownerReports.OWNER_REPORT_TTL_MINUTES} minutes'`,
      [req.user.id]
    );
    res.json({ cleared: result.rowCount > 0 });
  } catch (err) {
    console.error('Clear busy-now error:', err);
    res.status(500).json({ error: 'Failed to clear your live number' });
  }
});

// ─── "THIS WEEK" — deterministic, computed, no language model ────────────────
//
// The venue-advisor research (VENUE-ADVISOR.md, 2026-08-19) landed on one
// conclusion worth building first: most of what owners actually ask collapses
// into a handful of computed facts, and the LLM was only ever decorative for
// the analysis. This panel is those facts — every number is a SQL aggregate
// over this venue's own rows, each labelled with where it came from, and
// anything that cannot be computed says so instead of being invented
// (SLOP-AUDIT rule 5; the fabricated-stats box deleted from this exact
// dashboard on 2026-08-14 is the cautionary tale).
//
// Gated 'pro' deliberately: this is half of the Pro-sells-nothing fix (the
// board, 2026-08-19). No model output ships here, so the gate is a pricing
// decision, not an accuracy hedge — and the slider above stays free either way.
// ─── THE ROLLING WINDOW IS THE HOLE THE FLOOR DID NOT CLOSE ─────────────────
//
// SECURITY ROUND 5, 2026-08-20. The k-anonymity floor added below stops a thin
// group's average being published at ONE INSTANT. It does nothing about the
// same average published every day over a window that MOVES, and the panel is
// a seven-day window that moves.
//
// THE ATTACK, arithmetically, against the code as it stood this morning:
//   venue_feedback.crowd_level is a SMALLINT in {1,2,3} (migration 001).
//   The panel published `thisWeek` (an exact row count, n) beside
//   `avgLevel` (the mean, rounded to one decimal). n and the mean give the
//   SUM, and because the true sum is an integer, one decimal place is enough
//   to recover it exactly for any small n: a published 2.3 over 4 rows can
//   only be a sum of 9.
//
//   So the owner polls this endpoint once a day and keeps a column of
//   (n, sum). The window drops whatever turned seven days old overnight and
//   adds whatever arrived. On any night where n falls by exactly one and
//   nothing new came in — the common case for a venue with a handful of
//   reports a week — sum(yesterday) - sum(today) IS the crowd level a single
//   named-in-practice person filed, exactly, with its date. The owner has an
//   incoming-flocks feed, a reviews tab with real names on it, and their own
//   door; putting a person against a date is the easy half.
//
//   That is the precise thing the floor exists to prevent, reached by
//   subtraction instead of by reading one number.
//
// WHY COARSENING AND NOT A WIDER FLOOR. A wider floor delays the attack by a
// few reporters and does not stop it: the differencing works at any n, it just
// needs the mean to be precise enough to invert. Removing the precision
// removes the inversion at every n at once. This is the same guard
// services/advisorCohort.js already applies to the cohort median for the same
// reason (guard 4, "COARSENING"), and reusing the shape rather than inventing
// a second one is the point.
//
// WHY HALF A POINT. crowd_level runs 1 to 3, so the grid has to be read
// against a two-point range, not a hundred-point one. At 0.5 the published
// value is one of {1, 1.5, 2, 2.5, 3} — still the five distinctions the
// three-level scale can actually support ("quiet", "quiet-ish", "moderate",
// "busy-ish", "packed") — while the true mean is only known to ±0.25. Over n
// reporters the sum is known to ±0.25n, so differencing two days at n = 5 and
// n = 4 leaves the departed value uncertain by ±2.25 on a scale whose whole
// range is 2. The estimate is wider than knowing nothing, which is the
// definition of the attack being dead rather than merely harder.
//
// The COUNTS are untouched, for the reason the floor's own note gives: volume
// is a fact about the venue. It is the CONTENT that had to lose its last
// decimal place.
const LEVEL_GRID = 0.5;
function coarsenLevel(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.round(n / LEVEL_GRID) * LEVEL_GRID;
}

router.get('/this-week', requirePro, async (req, res) => {
  try {
    const ctx = await getVenueCtx(req.user.id);
    if (!ctx?.google_place_id) {
      return res.json({ available: false, reason: 'Link your Google listing in Edit Profile to unlock the weekly summary' });
    }
    if (!ctx.verified) return res.json({ available: false, unverified: true, reason: unverifiedReason(ctx) });
    const placeId = ctx.google_place_id;

    // Cached on the same 60-minute clock as /intelligence and /strip, through
    // the same two helpers, keyed the same way. This route makes no paid Google
    // call, so the money argument those two make does not apply — but the other
    // half of it does: four fourteen-day aggregates over four tables run on
    // every dashboard mount, every tab switch back, and every refresh, for a
    // panel whose smallest unit is A WEEK. Nothing here can change meaningfully
    // inside an hour.
    //
    // The one number that CAN move faster is yourReadings, which counts the
    // owner's own slider posts — so an owner who sets a reading and looks at
    // this panel sees the previous hour's count. That is the accepted cost and
    // it is why the live reading has its own uncached endpoint (GET
    // /busy-now); this panel is the week, not the moment.
    const cached = cacheGet(`week:${placeId}`);
    if (cached) return res.json(cached);

    // Four aggregates, one venue, fourteen days. Week-over-week comes from one
    // scan per table with FILTER rather than two round trips.
    const [votes, feedback, reviews, readings] = await Promise.all([
      pool.query(
        `SELECT COUNT(DISTINCT flock_id) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS this_week,
                COUNT(DISTINCT flock_id) FILTER (WHERE created_at < NOW() - INTERVAL '7 days')::int AS last_week
           FROM venue_votes
          WHERE venue_id = $1 AND created_at >= NOW() - INTERVAL '14 days'`,
        [placeId]
      ),
      pool.query(
        // verified = true — the same restriction every other reader of this
        // table carries (routes/crowd.js, the export): unverified reports move
        // no number anyone sees, including this one.
        // reporters — DISTINCT accounts, not rows, and it exists to gate
        // avg_level below. Counting rows would let one person filing three
        // reports clear a floor whose whole purpose is that three PEOPLE were
        // there, which is the same distinction crowdEngine.
        // usableCalibrationReports already makes.
        // ONE VALUE PER PERSON, THEN THE AVERAGE — not the average of rows.
        //
        // The floor below counts DISTINCT accounts, and it does so because the
        // thing being protected is what a PERSON said. Averaging rows handed
        // that back through the other door: three reporters clear the floor,
        // and if one of them filed six of the eight rows the published mean is
        // substantially that one person's number, attributable to whoever the
        // owner remembers being in. The inner GROUP BY makes the unit of the
        // average the same unit the floor is counted in, which is the only way
        // the two can be describing the same thing.
        `WITH win AS (
           SELECT user_id, crowd_level, created_at
             FROM venue_feedback
            WHERE venue_place_id = $1 AND verified = true
              AND created_at >= NOW() - INTERVAL '14 days'
         ),
         per_reporter AS (
           SELECT AVG(crowd_level)::numeric AS lvl
             FROM win
            WHERE created_at >= NOW() - INTERVAL '7 days'
            GROUP BY user_id
         )
         SELECT (SELECT COUNT(*) FROM win WHERE created_at >= NOW() - INTERVAL '7 days')::int AS this_week,
                (SELECT COUNT(*) FROM win WHERE created_at < NOW() - INTERVAL '7 days')::int AS last_week,
                (SELECT COUNT(*) FROM per_reporter)::int AS reporters,
                (SELECT AVG(lvl) FROM per_reporter) AS avg_level`,
        [placeId]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS this_week,
                ROUND(AVG(rating)::numeric, 1) AS avg_rating
           FROM venue_reviews
          WHERE google_place_id = $1 AND COALESCE(is_hidden, false) = false
            AND created_at >= NOW() - INTERVAL '7 days'`,
        [placeId]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS this_week,
                ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY busy_percent))::int AS median_percent
           FROM venue_owner_reports
          WHERE google_place_id = $1 AND retracted = false
            AND created_at >= NOW() - INTERVAL '7 days'`,
        [placeId]
      ),
    ]);

    // THE K-ANONYMITY FLOOR ON avgLevel.
    //
    // This is the one field on this panel that is an average of what
    // IDENTIFIABLE PEOPLE said, published to a party who can put names to
    // them. An owner sees their incoming-flocks feed and their own door: with
    // one reporter, "verified user reports say 2.0 this week" IS that person's
    // report, attributable to whoever the owner remembers being in on Tuesday.
    // Two is barely better — the second value is recoverable from the mean the
    // moment one of them tells the owner what they filed.
    //
    // MIN_CALIBRATION_REPORTERS is the repo's existing answer for this exact
    // table, and reusing it is the point rather than a convenience: three is
    // already the number of DISTINCT verified accounts venue_feedback needs
    // before it is allowed to move the score users see (services/crowdEngine.js)
    // or to outrank the owner's own live reading (services/ownerReports.js).
    // A venue-facing readout of the same rows should not be looser than the
    // consumer-facing one it is derived from.
    //
    // The COUNTS stay. "Six reports this week, up from two" is a volume signal
    // about the venue and reveals nothing any individual said; it is the
    // CONTENT of a thin group's reports that has to be withheld. Withheld with
    // its own reason, not as a silent null, so the dashboard says why (SLOP
    // rule 5: if we can't show it, say so, don't invent a number).
    const reporters = feedback.rows[0]?.reporters ?? 0;
    const avgLevelShown = reporters >= crowdEngine.MIN_CALIBRATION_REPORTERS;
    const avgLevelValue = (avgLevelShown && feedback.rows[0]?.avg_level != null)
      ? coarsenLevel(feedback.rows[0].avg_level)
      : null;

    const result = {
      available: true,
      windowDays: 7,
      // A count of FLOCKS, not of votes: five friends voting in one group is
      // one group considering you.
      groupsConsidering: {
        thisWeek: votes.rows[0]?.this_week ?? 0,
        lastWeek: votes.rows[0]?.last_week ?? 0,
        source: 'venue votes in group plans',
      },
      crowdReports: {
        thisWeek: feedback.rows[0]?.this_week ?? 0,
        lastWeek: feedback.rows[0]?.last_week ?? 0,
        avgLevel: avgLevelValue,
        // Published so the dashboard can say "about 2.5" rather than "2.5" and
        // mean it. A number that has been coarsened on purpose and is printed
        // as if it were exact is the same small lie as a withheld number
        // printed as a zero.
        avgLevelPrecision: LEVEL_GRID,
        minReporters: crowdEngine.MIN_CALIBRATION_REPORTERS,
        // Never the reporter COUNT itself — that is the number the floor is
        // hiding behind, and "2 of 3 reporters" re-identifies just as well as
        // the average does.
        avgLevelWithheld: !avgLevelShown,
        avgLevelReason: avgLevelShown
          ? null
          : `The average stays hidden until ${crowdEngine.MIN_CALIBRATION_REPORTERS} different people have reported. Below that it would name them.`,
        source: 'verified user reports',
      },
      reviews: {
        thisWeek: reviews.rows[0]?.this_week ?? 0,
        avgRating: reviews.rows[0]?.avg_rating != null ? Number(reviews.rows[0].avg_rating) : null,
        source: 'reviews on Flock',
      },
      yourReadings: {
        thisWeek: readings.rows[0]?.this_week ?? 0,
        medianPercent: readings.rows[0]?.median_percent ?? null,
        source: 'your own live numbers',
      },
      generatedAt: new Date().toISOString(),
    };

    cacheSet(`week:${placeId}`, result);
    res.json(result);
  } catch (err) {
    console.error('Venue this-week error:', err);
    res.status(500).json({ error: 'Failed to build the weekly summary' });
  }
});

module.exports = router;

// Exposed for backend/__tests__/venueIntegrity.test.js only. The view window is
// process-wide state, so a test that cannot reset it or see its bound is a test
// that can only assert the happy path.
module.exports.__test = {
  recentPromotionViews,
  claimPromotionViews,
  VIEW_DEDUPE_MS,
  VIEW_DEDUPE_MAX,
  // The strip hedge (__tests__/stripHedge.test.js): the claim rule and its
  // threshold, so the test asserts the shipped arithmetic, not a copy.
  stripOrderingClaim,
  STRIP_ORDERING_MIN_GAP,
};
