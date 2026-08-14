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

// ---------------------------------------------------------------------------
// A DATE COLUMN TAKES A REAL DAY, AND isISO8601() IS NOT THAT TEST (round 21)
// ---------------------------------------------------------------------------
// validator's isISO8601() is NON-STRICT by default: it checks the SHAPE of an
// ISO string, not whether the day it names exists. So `2026-02-31`,
// `2026-09-31` and `2026-02-30T00:00:00Z` all passed the chain and reached
// `event_date` (DATE), where Postgres answered 22008 "date/time field value out
// of range" — a 500 for a value the caller supplies, on POST, on PUT, and on
// the GET range. `0000-01-01` is the same story: there is no year zero.
//
// isISO8601({ strict: true }) is NOT the fix. It closes the impossible days and
// still admits the truncated forms `2026` and `2026-09`, which are valid
// ISO 8601 and are not days Postgres will take either (22007).
//
// So the test is the one the column actually applies: four-digit year, real
// month, real day-of-month for that month and that year. The lower year bound
// is 1000 rather than 0001 because the text form here is four digits and
// Postgres has no year zero; the upper is 9999 for the same reason. Everything
// the shipping client can produce is inside that: App.js sends `formatDateStr`,
// i.e. YYYY-MM-DD assembled from a local Date, and the derived-flock path sends
// the same string.
//
// An optional trailing time is accepted and dropped, because a caller with a
// timestamp in hand should not have to slice it themselves — but it is dropped
// HERE, by the sanitizer, so the handler below never has to.
//
// Both ISO spellings of a day are accepted, `2026-09-01` and the basic
// `20260901`, because Postgres takes both and because a NUMBER spelled
// `20260901` is the round-20 case: a number is a scalar, no shape guard refuses
// it, and it must be coerced rather than handed to a string method. The
// coercion is the `.trim()` in the chain fragment below — express-validator
// converts a value to a string before running a standard sanitizer and writes
// the string back, so by the time this function runs, `20260901` is already
// "20260901". This function does NOT repeat that conversion: two places
// deciding the same thing is how they drift apart.
//
// The separator style is not mixed and not rewritten: `2026-0901` is refused
// rather than quietly repaired, and whichever form came in is the form that
// goes to the column.
const CAL_DATE_RE = /^(?:(\d{4})-(\d{2})-(\d{2})|(\d{4})(\d{2})(\d{2}))(?:[T ][\s\S]*)?$/;
function toCalendarDate(value) {
  if (typeof value !== 'string') return null;
  const m = CAL_DATE_RE.exec(value.trim());
  if (!m) return null;
  const hyphenated = m[1] !== undefined;
  const [y, mo, d] = hyphenated ? [m[1], m[2], m[3]] : [m[4], m[5], m[6]];
  const [year, month, day] = [Number(y), Number(mo), Number(d)];
  // The regex already fixes the year at four digits, and the round-trip below
  // rejects every out-of-range month and day (month 13 rolls into the next
  // year, day 32 into the next month, and both change what comes back). So the
  // only bound left to state is the low year: Postgres has no year zero, and
  // `Date.UTC` maps a two-digit year onto 1900, which would let `0026-01-01`
  // through as 1926. 1000 is the floor because the text form here is four
  // digits; nothing an interface can produce comes near it.
  if (year < 1000) return null;
  // Date.UTC, not the local constructor: this is an existence check on a
  // calendar day, and it must not depend on the server's timezone.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return hyphenated ? `${y}-${mo}-${d}` : `${y}${mo}${d}`;
}
const isCalendarDate = (value) => toCalendarDate(value) !== null;

// Shape guard first (a number is a scalar and still breaks a string method, so
// the type has to be settled too), then the day check, then the canonicalising
// sanitizer. Everything downstream reads a plain YYYY-MM-DD.
const calendarDate = (chain, label) =>
  scalarOnly(chain, label)
    .trim()
    .custom(isCalendarDate).withMessage(`Enter a real ${label} (YYYY-MM-DD)`)
    .customSanitizer(toCalendarDate);

// ---------------------------------------------------------------------------
// A DAY'S PLANS COME BACK IN THE ORDER THEY HAPPEN (round 21 re-audit)
// ---------------------------------------------------------------------------
// `ORDER BY event_date, time_label` reads like chronological order and is not:
// time_label is free text, so the sort is lexicographic and "10:00 PM" lands
// before "8:00 PM". A day with an early dinner and a late show rendered them
// backwards, and the client does not re-sort — App.js's getEventsForDate only
// filters. The date half of that ORDER BY is correct and stays in SQL; the time
// half is settled here, where the label can actually be read.
//
// The labels this route stores come from the client's
// `toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })`, i.e.
// "8:00 PM", plus the literal "TBD" when no time was given. A 24-hour label is
// read too, because a device set to a 24-hour locale produces one.
const minutesOfDay = (label) => {
  const m = /^(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?$/.exec(String(label || '').trim())
    || /^(\d{1,2}):(\d{2})$/.exec(String(label || '').trim());
  if (!m) return null;
  const minutes = Number(m[2]);
  let hour = Number(m[1]);
  if (m[3]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0);
  } else if (hour > 23) return null;
  if (minutes > 59) return null;
  return hour * 60 + minutes;
};

// Same day: timed plans in clock order, then anything whose label is not a time
// ("TBD", ""), which belongs at the end of the day rather than the start.
// Array.prototype.sort is stable, so equal entries keep the SQL's order.
const byDayThenTime = (a, b) => {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const ta = minutesOfDay(a.time);
  const tb = minutesOfDay(b.time);
  if (ta === null && tb === null) return 0;
  if (ta === null) return 1;
  if (tb === null) return -1;
  return ta - tb;
};

// calendar_events table lives in migrations/003 — route-owned DDL raced the
// migration runner on fresh deployments (see REVIEW-ROUND5).

// ---------------------------------------------------------------------------
// THE DAY YOU SAVED IS THE DAY YOU READ BACK (round 21)
// ---------------------------------------------------------------------------
// The old comment here said "DATE comes back as a JS Date at UTC midnight".
// It does not. node-postgres parses a DATE (oid 1082) with pg-types' parser,
// which builds `new Date(year, month - 1, day)` — LOCAL midnight. Running
// `.toISOString().slice(0, 10)` on that is only correct at or WEST of UTC. East
// of it the instant falls on the previous UTC day, so every event on every
// user's calendar moves back one square: a Friday plan renders on Thursday.
//
// Railway currently runs UTC, so this was latent rather than live — but nothing
// in the repo pins TZ, and this is the same shape as the two date-across-zones
// bugs this codebase has already shipped. Read the day back out of the same
// LOCAL fields pg-types wrote it into, and no zone can move it. This is exactly
// what App.js's own `formatDateStr` does on the client side.
const pad2 = (n) => String(n).padStart(2, '0');
const dateOnly = (v) => (typeof v === 'string'
  ? v.slice(0, 10)
  : `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`);

const rowToEvent = (r) => ({
  id: r.id,
  title: r.title,
  venue: r.venue || 'TBD',
  date: dateOnly(r.event_date),
  time: r.time_label || '',
  color: r.color || null,
  // A personal calendar entry is one person's: this is not read from a column
  // and nothing writes one. The client renders an attendee count only when it
  // is above 1, so this stays honest rather than inventing a number.
  members: 1,
});

// GET /api/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD — the signed-in user's events
router.get('/', [
  // `?start[]=2026-01-01` is parsed by express as an array and satisfies a
  // coercing validator, then goes to the DATE comparison below as a text[]
  // parameter against a DATE column. calendarDate() carries the shape guard
  // that stops it, and the day-existence rule that stops `?start=2026-02-31`.
  calendarDate(query('start').optional({ nullable: true }), 'start date'),
  calendarDate(query('end').optional({ nullable: true }), 'end date'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }
    const { start, end } = req.query;
    // `if (start && end)` meant a request carrying only ONE bound silently got
    // the unfiltered query: the caller asked for September onwards and was
    // handed every event they have ever had, with nothing in the response to
    // say the filter had been dropped. Each bound now stands on its own.
    //
    // The fragments below are literals; only the values are parameters.
    const conditions = ['user_id = $1'];
    const params = [req.user.id];
    if (start) { params.push(start); conditions.push(`event_date >= $${params.length}`); }
    if (end) { params.push(end); conditions.push(`event_date <= $${params.length}`); }
    const result = await pool.query(
      `SELECT * FROM calendar_events WHERE ${conditions.join(' AND ')} ORDER BY event_date, time_label`,
      params
    );
    res.json(result.rows.map(rowToEvent).sort(byDayThenTime));
  } catch (err) {
    console.error('Calendar list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/calendar — create an event
router.post('/', [
  scalarOnly(body('title'), 'title').trim().notEmpty().withMessage('Title is required').isLength({ max: 120 }),
  // Round 20 established that `date` must be settled as a STRING as well as a
  // scalar: `{"date": 20260901}` is a scalar, and a number has no `.slice`.
  // Round 21 added the day itself — see calendarDate() above. Both live in the
  // one chain fragment now, and it also canonicalises, so the handler receives
  // a plain YYYY-MM-DD and needs no slicing of its own.
  calendarDate(body('date'), 'date'),
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
      [req.user.id, title, venue || null, date, time || null, color || null]
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
  calendarDate(body('date').optional({ nullable: true }), 'date'),
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
      [title || null, date || null, venue ?? null, time ?? null, color ?? null, req.params.id, req.user.id]
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

// Test hooks only. `rowToEvent` is the one piece of this router whose
// correctness depends on the PROCESS TIMEZONE, and a test cannot change that
// in-process — it has to re-run the shaping in a child with a different TZ, so
// it needs a handle on the function itself. `toCalendarDate` is exported beside
// it so the day-existence rule can be checked without a round trip.
module.exports.__rowToEvent = rowToEvent;
module.exports.__toCalendarDate = toCalendarDate;
