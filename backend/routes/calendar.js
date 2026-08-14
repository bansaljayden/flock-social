const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
// Shape before content — see validators/shape.js.
const { scalarOnly } = require('../validators/shape');

const router = express.Router();

// ---------------------------------------------------------------------------
// SHAPE BEFORE CONTENT (round 20)
// ---------------------------------------------------------------------------
// Every column this router writes is narrow and typed — title VARCHAR(120) NOT
// NULL, venue VARCHAR(200), time_label VARCHAR(20), color VARCHAR(30),
// event_date DATE — and every validator below coerces its value before testing
// it. So `{"title": ["<b>x</b>"]}` satisfied isLength({ max: 120 }), stayed an
// array in req.body, and reached node-postgres as a text[] parameter for a
// VARCHAR column: a 500 for a body shape the caller picks. `{"date": ["..."]}`
// was worse in kind, because `date.slice(0, 10)` is Array.prototype.slice on an
// array, which returns the array unchanged and hands it to a DATE column.
//
// The ids get the same treatment for the same reason: `param('id').isInt()`
// with no ceiling accepted 99999999999, which is out of range for the int4
// SERIAL it is compared against — 22003, another 500 where a 400 belongs. This
// is the id-range guard validators/shape.js calls the shape guard's twin.
const MAX_EVENT_ID = 2147483647;
const eventId = () => param('id').isInt({ min: 1, max: MAX_EVENT_ID }).withMessage('Invalid event id');
router.use(authenticate);

// calendar_events table lives in migrations/003 — route-owned DDL raced the
// migration runner on fresh deployments (see REVIEW-ROUND5).

const rowToEvent = (r) => ({
  id: r.id,
  title: r.title,
  venue: r.venue || 'TBD',
  // DATE comes back as a JS Date at UTC midnight; format as YYYY-MM-DD without TZ drift
  date: typeof r.event_date === 'string' ? r.event_date.slice(0, 10) : r.event_date.toISOString().slice(0, 10),
  time: r.time_label || '',
  color: r.color || null,
  members: 1,
});

// GET /api/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD — the signed-in user's events
router.get('/', [
  // `?start[]=2026-01-01` is parsed by express as an array and satisfies
  // isISO8601 by coercion, then goes to `event_date BETWEEN $2 AND $3` as a
  // text[] parameter against a DATE column.
  scalarOnly(query('start').optional({ nullable: true }), 'start date').isISO8601(),
  scalarOnly(query('end').optional({ nullable: true }), 'end date').isISO8601(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }
    const { start, end } = req.query;
    let result;
    if (start && end) {
      result = await pool.query(
        'SELECT * FROM calendar_events WHERE user_id = $1 AND event_date BETWEEN $2 AND $3 ORDER BY event_date, time_label',
        [req.user.id, start, end]
      );
    } else {
      result = await pool.query(
        'SELECT * FROM calendar_events WHERE user_id = $1 ORDER BY event_date, time_label',
        [req.user.id]
      );
    }
    res.json(result.rows.map(rowToEvent));
  } catch (err) {
    console.error('Calendar list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/calendar — create an event
router.post('/', [
  scalarOnly(body('title'), 'title').trim().notEmpty().withMessage('Title is required').isLength({ max: 120 }),
  // `.trim()` is not cosmetic here, it is the coercion that makes `date` a
  // STRING. Round 20 re-audit: every other field on this route already carried
  // a sanitizer, `date` carried none, and isISO8601 accepts the basic form — so
  // `{"date": 20260901}` passed the whole chain as a NUMBER and reached
  // `date.slice(0, 10)` below, which is a TypeError on a number and a 500 on
  // the response. A scalar guard alone does not close that: a number IS a
  // scalar. Settling the shape means settling the type too.
  scalarOnly(body('date'), 'date').trim().notEmpty().isISO8601().withMessage('Valid date is required'),
  scalarOnly(body('venue').optional({ nullable: true }), 'venue').trim().isLength({ max: 200 }),
  scalarOnly(body('time').optional({ nullable: true }), 'time').trim().isLength({ max: 20 }),
  scalarOnly(body('color').optional({ nullable: true }), 'color').trim().isLength({ max: 30 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }
    const { title, date, venue, time, color } = req.body;
    const result = await pool.query(
      `INSERT INTO calendar_events (user_id, title, venue, event_date, time_label, color)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.id, title, venue || null, date.slice(0, 10), time || null, color || null]
    );
    res.status(201).json(rowToEvent(result.rows[0]));
  } catch (err) {
    console.error('Calendar create error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/calendar/:id — update own event
router.put('/:id', [
  eventId(),
  // `optional({ nullable: true })` on title and date, because the handler below
  // already reads a null as "leave this column alone" (`title || null`,
  // `date ? … : null`) while `optional()` skips only `undefined` — so a partial
  // update that spelled an untouched field as null was refused by the chain
  // rather than served.
  scalarOnly(body('title').optional({ nullable: true }), 'title').trim().notEmpty().isLength({ max: 120 }),
  scalarOnly(body('date').optional({ nullable: true }), 'date').trim().isISO8601(),
  scalarOnly(body('venue').optional({ nullable: true }), 'venue').trim().isLength({ max: 200 }),
  scalarOnly(body('time').optional({ nullable: true }), 'time').trim().isLength({ max: 20 }),
  scalarOnly(body('color').optional({ nullable: true }), 'color').trim().isLength({ max: 30 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }
    const { title, date, venue, time, color } = req.body;
    const result = await pool.query(
      `UPDATE calendar_events SET
         title = COALESCE($1, title),
         event_date = COALESCE($2, event_date),
         venue = COALESCE($3, venue),
         time_label = COALESCE($4, time_label),
         color = COALESCE($5, color),
         updated_at = NOW()
       WHERE id = $6 AND user_id = $7 RETURNING *`,
      [title || null, date ? date.slice(0, 10) : null, venue ?? null, time ?? null, color ?? null, req.params.id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(rowToEvent(result.rows[0]));
  } catch (err) {
    console.error('Calendar update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/calendar/:id — delete own event
router.delete('/:id', [eventId()], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }
    const result = await pool.query(
      'DELETE FROM calendar_events WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Calendar delete error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
