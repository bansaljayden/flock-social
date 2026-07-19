const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// Auto-create table on boot (same pattern as availability.js)
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS calendar_events (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(120) NOT NULL,
        venue VARCHAR(200),
        event_date DATE NOT NULL,
        time_label VARCHAR(20),
        color VARCHAR(30),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_calendar_events_user_date ON calendar_events(user_id, event_date)`);
  } catch (err) {
    console.error('Failed to ensure calendar_events table:', err.message);
  }
})();

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
  query('start').optional().isISO8601(),
  query('end').optional().isISO8601(),
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
  body('title').trim().notEmpty().withMessage('Title is required').isLength({ max: 120 }),
  body('date').notEmpty().isISO8601().withMessage('Valid date is required'),
  body('venue').optional({ nullable: true }).trim().isLength({ max: 200 }),
  body('time').optional({ nullable: true }).trim().isLength({ max: 20 }),
  body('color').optional({ nullable: true }).trim().isLength({ max: 30 }),
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
  param('id').isInt(),
  body('title').optional().trim().notEmpty().isLength({ max: 120 }),
  body('date').optional().isISO8601(),
  body('venue').optional({ nullable: true }).trim().isLength({ max: 200 }),
  body('time').optional({ nullable: true }).trim().isLength({ max: 20 }),
  body('color').optional({ nullable: true }).trim().isLength({ max: 30 }),
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
router.delete('/:id', [param('id').isInt()], async (req, res) => {
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
