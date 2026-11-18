'use strict';
// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// THE NIGHT-OF "STILL IN?" WINDOW
// (utils/reconfirm.js, services/reconfirmSweep.js, routes/flocks.js
//  POST /:id/reconfirm and PUT /:id, routes/guest.js POST /:token/reconfirm)
// ---------------------------------------------------------------------------
//
// WHY THIS FILE EXISTS. "Lock it in" is one person's tap, usually days out.
// The question the night turns on is asked a few hours before, in the group
// chat, by whoever is willing to type it, and answered by whoever happens to
// look. Migration 072 makes that a structured question with a count: a sweep
// opens a window a fixed lead before a confirmed plan, everyone who said yes
// says so again, once, from the app or from the invite link, and the plan
// shows "4 of 7 still in" against the deadline.
//
// What is pinned:
//   1. THE LEAD AND THE WORDS. reconfirmLeadHours is bounded and defaults;
//      the push names the plan's start on the venue's clock, with the venue
//      zone's name when the recipient's device reads another clock, on the
//      device's clock when the venue has no zone, with the day when the start
//      is not on the day the push lands (the weekday, or "tonight" for the
//      small hours, never "tomorrow", so the word stays true when delivery is
//      retried past midnight), and says a rounded distance only when
//      neither zone is known, so a push held until 08:00 does not land saying
//      "in about 3 hours" about a plan that is now one hour away.
//   2. THE STATE. reconfirmState reads one statement for open, deadline, count
//      and total over both rosters, answers the closed shape when there is no
//      row, and hands back numbers.
//   3. THE SWEEP. Which plans it opens (confirmed, no window yet, a time still
//      ahead and within the lead, untouched for the settle minutes), in time
//      order and bounded; whom it tells (each accepted member's room, and a
//      push to each); that it returns 0 and never rejects when the pool
//      throws; that FLOCK_SWEEP_ENABLED=false silences it; that server.js
//      actually registers it.
//   4. THE MEMBER TAP. 404 with no membership row, 403 when invited, 409
//      NOT_OPEN when the state says closed, 200 with count and total after
//      writing reconfirmed_at for an accepted member, and `already: true` on
//      a second tap with no second write.
//   5. THE GUEST TAP. 403 with no row, 409 NOT_IN when out, 409 NOT_OPEN; the
//      write is gated on status = 'in' and not hidden in the statement
//      itself; every member hears flock_reconfirmed with the new count; and
//      every tap past the NOT_IN check spends one action unit, the second tap
//      that answers `already` included.
//   6. THE RESET. PUT /:id with a new event_time, or with a status that is
//      neither confirmed nor completed, closes an open window and clears
//      every answer in it, members and guests, and does none of that when
//      no window had opened.
//   7. THE RSVP EDIT. A guest who says out loses their night-of answer in the
//      same statement that records the change, so "still in" cannot outlive
//      "in".
//
// No database. pool.query dispatches on the flattened statement: what is
// under test is which rows each statement claims and what each route does
// with the answer. An unrecognised statement answers empty and is recorded,
// so a case that depends on one can say so.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'reconfirm-window-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const pool = require('../config/database');

// -- Fixture plumbing --------------------------------------------------------
let handlers = [];
let log = [];
let unknownSql = [];

async function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params: params || [] });
  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(flat)) return { rows: [], rowCount: 0 };
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      // A handler that throws becomes a rejected query, which is what a
      // pool that lost its connection looks like to the code under test.
      const out = fn(params || [], flat);
      return out === undefined ? { rows: [], rowCount: 0 } : out;
    }
  }
  unknownSql.push(flat);
  return { rows: [], rowCount: 0 };
}
pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({ query: (sql, params) => dispatch(sql, params), release: () => {} });

function on(re, fn) { handlers.push([re, fn]); }
function ran(re) { return log.filter((q) => re.test(q.sql)); }

// Replaced BEFORE anything under test is required: the sweep, both routers and
// the fan-out helpers destructure these at module load.
const pushMod = require('../services/pushHelper');
let pushes = [];
let pushFailFor = null;
pushMod.pushIfOffline = async (_io, userId, title, body, data) => {
  pushes.push({ userId, title, body, data });
  if (pushFailFor === userId) throw new Error('FCM unavailable');
  return { sent: 1 };
};
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true, reason: 'test' });
pushMod.pushAlways = async () => ({ skipped: true, reason: 'test' });
// The zone each recipient's device reported (pushHelper.reportedZone),
// answered from a map the test fills: no entry is a recipient whose devices
// never named a zone. The clock quiet hours read (pushHelper.recipientZone)
// is that, or PUSH_QUIET_DEFAULT_TZ standing in for it, as in pushHelper.
let deviceZones = new Map();
pushMod.reportedZone = async (userId) => deviceZones.get(userId) || null;
pushMod.recipientZone = async (userId) => deviceZones.get(userId) || process.env.PUSH_QUIET_DEFAULT_TZ || null;

const authMod = require('../middleware/auth');
const ME = { id: 1, name: 'Ava', email_verified: true, role: 'user', is_banned: false };
authMod.authenticate = (req, _res, next) => { req.user = ME; next(); };
authMod.requireVerified = (_req, _res, next) => { next(); };

const {
  reconfirmLeadHours, reconfirmState, RECONFIRM_STATE_SQL,
  DEFAULT_LEAD_HOURS, MIN_LEAD_HOURS, MAX_LEAD_HOURS,
} = require('../utils/reconfirm');
const {
  runReconfirmSweep, hoursOutPhrase, reconfirmBody, RECONFIRM_SWEEP_INTERVAL_MS, SETTLE_MINUTES, SWEEP_BATCH_SIZE,
} = require('../services/reconfirmSweep');
const { guestEntryId } = require('../utils/guestRsvp');
const flocksRouter = require('../routes/flocks');
const guest = require('../routes/guest');

let emits = [];
const io = {
  to(room) { return { emit(event, payload) { emits.push({ room, event, payload }); } }; },
};

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/flocks', flocksRouter);
app.use('/api/guest', guest.router);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  unknownSql = [];
  emits = [];
  pushes = [];
  pushFailFor = null;
  deviceZones = new Map();
  delete process.env.FLOCK_RECONFIRM_LEAD_HOURS;
  delete process.env.FLOCK_SWEEP_ENABLED;
  delete process.env.PUSH_QUIET_DEFAULT_TZ;
  guest.guestActionLog.clear();
  guest.newGuestLog.clear();
});

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text, retryAfter: res.headers.get('retry-after') };
}

// The member tap fans out AFTER its response, so a test that wants to see the
// room hear it waits for the emit rather than for the reply.
async function until(pred, ms = 500) {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
}

const FLOCK = 42;
const LINK_TOKEN = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
// Synthetic counting patterns, resolved by the fixtures below and seen by
// nothing outside this file. The secret scanner flags them on entropy alone.
const GUEST_TOKEN = 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5'; // gitleaks:allow
const NOBODY = 'd1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5'; // gitleaks:allow
const GUEST_ID = 7;
const DEADLINE = '2026-09-16T23:00:00.000Z';

// utils/reconfirm.js RECONFIRM_STATE_SQL, answered from a small counter so the
// read after a write shows the write.
//
// The two writes are window-bound (utils/reconfirm.js): they join the flock,
// re-check the window and change only a row that has not answered THIS
// window, so the fixture answers them with the row count that rule would
// give: one when the person had not answered, zero when they had
// (`already`), and zero with the window shut afterwards when a time change
// lands between the read and the write (`closeAtWrite`).
function scriptWindow({ open = true, count = 2, total = 7, deadline = DEADLINE, already = false, closeAtWrite = false } = {}) {
  let answered = count;
  let shut = false;
  on(/AS open, f\.event_time AS deadline/, () => ({ rows: [{ open: open && !shut, deadline, count: answered, total }], rowCount: 1 }));
  const write = () => {
    if (closeAtWrite) { shut = true; return { rows: [], rowCount: 0 }; }
    if (already) return { rows: [], rowCount: 0 };
    answered += 1;
    return { rows: [{ '?column?': 1 }], rowCount: 1 };
  };
  on(/^UPDATE flock_members fm SET reconfirmed_at = NOW\(\) FROM flocks f WHERE /, write);
  on(/^UPDATE guest_rsvps g SET reconfirmed_at = NOW\(\), updated_at = NOW\(\) FROM flocks f WHERE /, write);
  // The two fan-out rosters (sockets/handlers.js), and the block set.
  on(/^SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2$/,
    () => ({ rows: [{ user_id: 2 }, { user_id: 3 }] }));
  on(/^SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'$/,
    () => ({ rows: [{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }] }));
  on(/FROM user_blocks/, () => ({ rows: [] }));
}
function scriptMembership(row) {
  on(/^SELECT status, reconfirmed_at FROM flock_members WHERE flock_id = \$1 AND user_id = \$2$/,
    () => (row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 }));
}
const link = (over = {}) => ({
  flock_id: FLOCK, name: 'Dinner', event_time: DEADLINE, venue_name: 'The Bar', status: 'confirmed',
  host_name: 'Ava Brooks', budget_enabled: false, budget_context: null, budget_locked: false,
  budget_ceiling: null, reconfirm_opened_at: '2026-09-16T20:00:00.000Z', ...over,
});
function scriptGuest(row, linkOver = {}) {
  on(/FROM flock_invite_links il/, (params) => (params[0] === LINK_TOKEN ? { rows: [link(linkOver)], rowCount: 1 } : { rows: [], rowCount: 0 }));
  on(/^SELECT id, name, status, reconfirmed_at FROM guest_rsvps WHERE guest_token = \$1 AND flock_id = \$2 AND COALESCE\(is_hidden, false\) = false$/,
    (params) => (row && String(params[0]).toLowerCase() === GUEST_TOKEN ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 }));
}
const guestRow = (over = {}) => ({ id: GUEST_ID, name: 'Cass', status: 'in', reconfirmed_at: null, ...over });

const memberTap = () => call('POST', `/api/flocks/${FLOCK}/reconfirm`);
const guestTap = (token = GUEST_TOKEN) => call('POST', `/api/guest/${LINK_TOKEN}/reconfirm`, { guestToken: token });
const MEMBER_WRITE = /^UPDATE flock_members fm SET reconfirmed_at = NOW\(\)/;
const GUEST_WRITE = /^UPDATE guest_rsvps g SET reconfirmed_at = NOW\(\)/;
const MEMBER_WRITE_SQL = "UPDATE flock_members fm SET reconfirmed_at = NOW() FROM flocks f WHERE fm.flock_id = $1 AND fm.user_id = $2 AND fm.status = 'accepted' AND f.id = fm.flock_id AND f.reconfirm_opened_at IS NOT NULL AND f.status = 'confirmed' AND f.event_time > (NOW() AT TIME ZONE 'UTC') AND (fm.reconfirmed_at IS NULL OR fm.reconfirmed_at < f.reconfirm_opened_at) RETURNING 1";
const GUEST_WRITE_SQL = "UPDATE guest_rsvps g SET reconfirmed_at = NOW(), updated_at = NOW() FROM flocks f WHERE g.id = $1 AND g.flock_id = $2 AND g.status = 'in' AND COALESCE(g.is_hidden, false) = false AND f.id = g.flock_id AND f.reconfirm_opened_at IS NOT NULL AND f.status = 'confirmed' AND f.event_time > (NOW() AT TIME ZONE 'UTC') AND (g.reconfirmed_at IS NULL OR g.reconfirmed_at < f.reconfirm_opened_at) RETURNING 1";

// ===========================================================================
// 1. The lead and the words
// ===========================================================================

test('the lead defaults to three hours and is bounded to a sane band', () => {
  assert.strictEqual(DEFAULT_LEAD_HOURS, 3);
  assert.strictEqual(MIN_LEAD_HOURS, 1);
  assert.strictEqual(MAX_LEAD_HOURS, 24);
  for (const unset of [undefined, '', '   ']) {
    if (unset === undefined) delete process.env.FLOCK_RECONFIRM_LEAD_HOURS;
    else process.env.FLOCK_RECONFIRM_LEAD_HOURS = unset;
    assert.strictEqual(reconfirmLeadHours(), 3, `"${unset}" must fall back`);
  }
  for (const [raw, want] of [['6', 6], ['1', 1], ['24', 24], ['2.4', 2], ['2.6', 3], [' 4 ', 4]]) {
    process.env.FLOCK_RECONFIRM_LEAD_HOURS = raw;
    assert.strictEqual(reconfirmLeadHours(), want, `"${raw}"`);
  }
  // A typo must not open every window a day early or a minute late.
  for (const bad of ['0', '25', '-3', 'soon', 'NaN', '1e9', 'Infinity', '0.4']) {
    process.env.FLOCK_RECONFIRM_LEAD_HOURS = bad;
    assert.strictEqual(reconfirmLeadHours(), 3, `"${bad}" must not become the live lead`);
  }
});

test('hoursOutPhrase rounds to whole hours and never prints a clock time', () => {
  for (const [hours, want] of [
    [0, 'soon'], [0.5, 'soon'], [0.74, 'soon'],
    [0.75, 'in about an hour'], [1, 'in about an hour'], [1.49, 'in about an hour'],
    [1.5, 'in about 2 hours'], [2.6, 'in about 3 hours'], [3, 'in about 3 hours'], ['3', 'in about 3 hours'],
    [NaN, 'soon'], [-2, 'soon'], [undefined, 'soon'], [null, 'soon'],
  ]) {
    assert.strictEqual(hoursOutPhrase(hours), want, `hoursOutPhrase(${hours})`);
  }
  for (const h of [0, 0.9, 1, 2.5, 3, 12]) {
    assert.ok(!/\d{1,2}:\d{2}/.test(hoursOutPhrase(h)), 'the distance is the fallback with no zone, so it never names a clock');
  }
});

// The start, said the way the app's other clock words say an hour
// (services/clockWords.js): "8:30 PM", "9 PM", "midnight", "noon".
const at = (iso) => `${Date.parse(iso)}.000000`;   // EXTRACT(EPOCH ...) * 1000 arrives as a numeric string
// `nowMs` is when the push lands; by default the instant `hoursOut` before
// the plan, which is what the sweep's row says.
const body = (o) => reconfirmBody({
  nowMs: o.eventMs == null ? undefined : Number(o.eventMs) - (o.hoursOut || 0) * 3600000, ...o,
});
test('reconfirmBody names the start on the venue\'s clock, the device\'s without one, and a distance only without either', () => {
  const tail = " Tap to say you're still coming.";
  const NY = 'America/New_York';
  const CHI = 'America/Chicago';
  const cases = [
    // 00:30 UTC on the 17th is 8:30 PM on the 16th in New York (EDT).
    [{ where: 'Dinner at The Bar', eventMs: at('2026-09-17T00:30:00Z'), venueZone: NY, deviceZone: NY, hoursOut: 2.9 },
      'Dinner at The Bar starts at 8:30 PM.'],
    // The same instant at a Chicago venue, for a phone that says Chicago, or
    // never said, or is on another zone whose clock reads the same (the app's
    // rule, frontend lib/eventWhereWhen.js: a label only when the clocks differ).
    [{ where: 'Dinner at The Bar', eventMs: at('2026-09-17T00:30:00Z'), venueZone: CHI, deviceZone: CHI, hoursOut: 2.9 },
      'Dinner at The Bar starts at 7:30 PM.'],
    [{ where: 'Dinner at The Bar', eventMs: at('2026-09-17T00:30:00Z'), venueZone: CHI, deviceZone: null, hoursOut: 2.9 },
      'Dinner at The Bar starts at 7:30 PM.'],
    [{ where: 'Dinner at The Bar', eventMs: at('2026-09-17T00:30:00Z'), venueZone: CHI, deviceZone: 'America/Winnipeg', hoursOut: 2.9 },
      'Dinner at The Bar starts at 7:30 PM.'],
    // THE TRAVELLER: a phone whose row still says New York, at a Chicago plan.
    // The venue's clock, and its zone, because the phone's clock reads 8:30.
    [{ where: 'Dinner at The Bar', eventMs: at('2026-09-17T00:30:00Z'), venueZone: CHI, deviceZone: NY, hoursOut: 2.9 },
      'Dinner at The Bar starts at 7:30 PM CDT.'],
    // A zone with no short English name is labelled as Intl labels it.
    [{ where: 'Dinner', eventMs: at('2026-09-16T19:00:00Z'), venueZone: 'Europe/London', deviceZone: NY, hoursOut: 3 },
      'Dinner starts at 8 PM GMT+1.'],
    // No venue zone: the phone's own clock, no label.
    [{ where: 'Dinner', eventMs: at('2026-09-17T00:30:00Z'), venueZone: null, deviceZone: NY, hoursOut: 2.9 }, 'Dinner starts at 8:30 PM.'],
    // On the hour, no minutes; midnight and noon as words.
    [{ where: 'Drinks', eventMs: at('2026-09-17T01:00:00Z'), venueZone: NY, hoursOut: 3 }, 'Drinks starts at 9 PM.'],
    [{ where: 'Brunch', eventMs: at('2026-09-17T16:00:00Z'), venueZone: NY, hoursOut: 3 }, 'Brunch starts at noon.'],
    // The morning the decision named: an early plan whose push waited for 08:00.
    [{ where: 'Run club', eventMs: at('2026-09-17T12:30:00Z'), venueZone: NY, hoursOut: 2.5 }, 'Run club starts at 8:30 AM.'],
    // A half-hour zone keeps its own minutes.
    [{ where: 'Dinner', eventMs: at('2026-09-16T15:00:00Z'), venueZone: 'Asia/Kolkata', hoursOut: 3 }, 'Dinner starts at 8:30 PM.'],
    // No name and no venue: the plan is still the subject.
    [{ where: '', eventMs: at('2026-09-17T01:00:00Z'), deviceZone: NY, hoursOut: 3 }, 'Your plan starts at 9 PM.'],
    // THE DAY. With FLOCK_RECONFIRM_LEAD_HOURS at 24, the plan can be on the
    // next day: 9 PM Wednesday, for 8:30 PM Thursday. The weekday, never
    // "tomorrow" (the day word stays true when the push is late, below).
    [{ where: 'Dinner', eventMs: at('2026-09-18T00:30:00Z'), venueZone: NY, nowMs: Date.parse('2026-09-17T01:00:00Z') },
      'Dinner starts Thursday at 8:30 PM.'],
    [{ where: 'Dinner', eventMs: at('2026-09-18T00:30:00Z'), venueZone: CHI, deviceZone: NY, nowMs: Date.parse('2026-09-17T01:00:00Z') },
      'Dinner starts Thursday at 7:30 PM CDT.'],
    // Just after midnight is tonight, said at 9:30 PM: the small hours belong
    // to the night before (routes/advisor.js, THE SMALL HOURS).
    [{ where: 'Late one', eventMs: at('2026-09-17T04:30:00Z'), venueZone: NY, nowMs: Date.parse('2026-09-17T01:30:00Z') },
      'Late one starts tonight at 12:30 AM.'],
    [{ where: 'Late one', eventMs: at('2026-09-17T04:00:00Z'), venueZone: NY, nowMs: Date.parse('2026-09-17T01:00:00Z') },
      'Late one starts tonight at midnight.'],
    // Said in the small hours, "tomorrow" is heard both ways, so the day is
    // named: at 1 AM Friday, a plan for 12:30 AM Saturday.
    [{ where: 'Late one', eventMs: at('2026-09-19T04:30:00Z'), venueZone: NY, nowMs: Date.parse('2026-09-18T05:00:00Z') },
      'Late one starts Saturday at 12:30 AM.'],
    // Inside the small hours, a plan later the same night needs no day.
    [{ where: 'Late one', eventMs: at('2026-09-18T07:00:00Z'), venueZone: NY, nowMs: Date.parse('2026-09-18T05:00:00Z') },
      'Late one starts at 3 AM.'],
    // Two days or more ahead: the weekday.
    [{ where: 'Dinner', eventMs: at('2026-09-19T00:30:00Z'), venueZone: NY, nowMs: Date.parse('2026-09-17T01:00:00Z') },
      'Dinner starts Friday at 8:30 PM.'],
    // The week the clocks change: 9 PM EDT Saturday 31 October, for 7:30 PM
    // EST on Sunday, and the traveller's label is the zone's name on the night.
    [{ where: 'Dinner', eventMs: at('2026-11-02T00:30:00Z'), venueZone: NY, nowMs: Date.parse('2026-11-01T01:00:00Z') },
      'Dinner starts Sunday at 7:30 PM.'],
    [{ where: 'Dinner', eventMs: at('2026-11-02T00:30:00Z'), venueZone: NY, deviceZone: 'Europe/London', nowMs: Date.parse('2026-11-01T01:00:00Z') },
      'Dinner starts Sunday at 7:30 PM EST.'],
    [{ where: 'Dinner', eventMs: at('2026-10-31T23:30:00Z'), venueZone: NY, deviceZone: 'Europe/London', nowMs: Date.parse('2026-10-31T21:00:00Z') },
      'Dinner starts at 7:30 PM EDT.'],
    // No usable zone either side: the distance.
    [{ where: 'Dinner', eventMs: at('2026-09-17T01:00:00Z'), hoursOut: 2.9 }, 'Dinner is in about 3 hours.'],
    [{ where: 'Dinner', eventMs: at('2026-09-17T01:00:00Z'), venueZone: 'Mars/Olympus_Mons', deviceZone: 'Not/A_Zone', hoursOut: 2.9 },
      'Dinner is in about 3 hours.'],
    [{ where: 'Dinner', eventMs: null, venueZone: NY, hoursOut: 0.4 }, 'Dinner is soon.'],
  ];
  for (const [input, want] of cases) {
    assert.strictEqual(body(input), want + tail, JSON.stringify(input));
  }
});

// THE DAY WORD STAYS TRUE WHEN THE PUSH IS LATE (2026-11-18). pushHelper
// stores the body once and sends it as stored: a failed delivery is retried a
// minute later, then at growing gaps, for up to half an hour (RETRY_TTL_MS).
// So the day word, said for the moment the push was meant to land, has to stay
// true for that half hour, across midnight too. "Tomorrow" cannot: said at
// 11:59:30 PM about 7 PM the next day, it is wrong by the one-minute retry. It
// is never said. The weekday is, and "tonight" for a start in the small hours
// said before midnight, which is still the night after it.
const NY_WALL = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23', weekday: 'long',
});
function nyWall(ms) {
  const p = Object.fromEntries(NY_WALL.formatToParts(ms).map((x) => [x.type, x.value]));
  return { date: Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 86400000, hour: Number(p.hour) % 24, weekday: p.weekday };
}
// Whether the day word in `text` is true when read at `readMs`, about a start
// at `planMs`, on New York's clock. Worked out here, not by the module.
function dayWordHolds(text, planMs, readMs) {
  const m = / starts (?:(\w+) )?at /.exec(text);
  if (!m) return false;
  const word = m[1] || '';
  const plan = nyWall(planMs);
  const read = nyWall(readMs);
  const days = plan.date - read.date;
  if (word === '') return days === 0;
  // The small hours belong to the night before (routes/advisor.js).
  if (word === 'tonight') return plan.hour < 5 && ((days === 1 && read.hour >= 5) || (days === 0 && read.hour < 5));
  return word === plan.weekday && days >= 0 && days <= 6;
}

test('the day word is never "tomorrow", and stays true when delivery is retried across midnight', () => {
  const NY = 'America/New_York';
  const tail = " Tap to say you're still coming.";
  const ms = (iso) => Date.parse(iso);
  // The review's case: composed at 11:59:30 PM Wednesday, for 7 PM Thursday,
  // and delivered by the retry at 12:00:30 AM Thursday.
  const dinner = reconfirmBody({ where: 'Dinner', eventMs: at('2026-09-17T23:00:00Z'), venueZone: NY, nowMs: ms('2026-09-17T03:59:30Z') });
  assert.strictEqual(dinner, `Dinner starts Thursday at 7 PM.${tail}`);
  assert.ok(dayWordHolds(dinner, ms('2026-09-17T23:00:00Z'), ms('2026-09-17T04:00:30Z')));
  // A 12:30 AM start composed at 11:59 PM and delivered at 12:01 AM: "tonight
  // at 12:30 AM" is true at both.
  const late = reconfirmBody({ where: 'Late one', eventMs: at('2026-09-17T04:30:00Z'), venueZone: NY, nowMs: ms('2026-09-17T03:59:00Z') });
  assert.strictEqual(late, `Late one starts tonight at 12:30 AM.${tail}`);
  assert.ok(dayWordHolds(late, ms('2026-09-17T04:30:00Z'), ms('2026-09-17T03:59:00Z')));
  assert.ok(dayWordHolds(late, ms('2026-09-17T04:30:00Z'), ms('2026-09-17T04:01:00Z')));
  // The predicate itself: "tomorrow" at 12:01 AM about 7 PM that day is false.
  assert.ok(!dayWordHolds('Dinner starts tomorrow at 7 PM.', ms('2026-09-17T23:00:00Z'), ms('2026-09-17T04:01:00Z')));

  // Every landing ten minutes apart from 6 PM Wednesday to 6 AM Thursday, every
  // start half an hour apart up to the 24-hour lead, read on time and after
  // each retry inside the half hour, until the start.
  const RETRIED_AFTER_MIN = [0, 1, 3, 7, 15, 30];
  const first = ms('2026-09-16T22:00:00Z');
  let checked = 0;
  for (let land = first; land <= first + 12 * 3600000; land += 10 * 60000) {
    for (let ahead = 30; ahead <= 24 * 60; ahead += 30) {
      const planMs = land + ahead * 60000;
      const text = reconfirmBody({ where: 'Plan', eventMs: `${planMs}.000000`, venueZone: NY, nowMs: land });
      const said = `"${text}" composed for ${new Date(land).toISOString()}`;
      assert.doesNotMatch(text, /tomorrow/, said);
      for (const lateBy of RETRIED_AFTER_MIN) {
        const readMs = land + lateBy * 60000;
        if (readMs >= planMs) continue;
        assert.ok(dayWordHolds(text, planMs, readMs), `${said}, read at ${new Date(readMs).toISOString()}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 15000, `only ${checked} readings checked`);
});

// ===========================================================================
// 2. The state
// ===========================================================================

test('reconfirmState answers the closed shape when there is no row', async () => {
  for (const answer of [{ rows: [] }, { rows: undefined }, {}, undefined, null]) {
    const s = await reconfirmState(async () => answer, FLOCK);
    assert.deepStrictEqual(s, { open: false, deadline: null, count: 0, total: 0 });
  }
});

test('reconfirmState runs the one statement, hands back numbers, and reads open as a strict boolean', async () => {
  let asked = null;
  const s = await reconfirmState(async (sql, params) => {
    asked = { sql, params };
    return { rows: [{ open: true, deadline: DEADLINE, count: '4', total: '7' }] };
  }, FLOCK);
  assert.strictEqual(asked.sql, RECONFIRM_STATE_SQL, 'the exported statement is the one that runs');
  assert.deepStrictEqual(asked.params, [FLOCK]);
  assert.deepStrictEqual(s, { open: true, deadline: DEADLINE, count: 4, total: 7 });
  assert.strictEqual(typeof s.count, 'number');
  assert.strictEqual(typeof s.total, 'number');

  // Anything that is not the boolean true reads closed: the fail-safe
  // direction for a gate that lets a write through.
  for (const open of ['t', 'true', 1, null, undefined]) {
    const r = await reconfirmState(async () => ({ rows: [{ open, deadline: DEADLINE, count: 1, total: 2 }] }), FLOCK);
    assert.strictEqual(r.open, false, `open=${JSON.stringify(open)}`);
  }
  // Unreadable counts are zero, not NaN on a screen.
  const g = await reconfirmState(async () => ({ rows: [{ open: false, deadline: null, count: 'x', total: null }] }), FLOCK);
  assert.deepStrictEqual(g, { open: false, deadline: null, count: 0, total: 0 });
});

test('the state statement decides open in SQL and counts over both rosters', () => {
  const flat = RECONFIRM_STATE_SQL.replace(/\s+/g, ' ').trim();
  assert.match(flat, /\(f\.reconfirm_opened_at IS NOT NULL AND f\.status = 'confirmed' AND f\.event_time > \(NOW\(\) AT TIME ZONE 'UTC'\)\) AS open/);
  assert.match(flat, /f\.event_time AS deadline/);
  // A banned member is left out of both sides: the roster no longer shows
  // them and they can never sign in to answer.
  const notBanned = "NOT EXISTS \\(SELECT 1 FROM users bu WHERE bu\\.id = flock_members\\.user_id AND bu\\.is_banned IS TRUE\\)";
  assert.match(flat, new RegExp(`\\(SELECT COUNT\\(\\*\\) FROM flock_members WHERE flock_id = f\\.id AND status = 'accepted' AND reconfirmed_at IS NOT NULL AND reconfirmed_at >= f\\.reconfirm_opened_at AND ${notBanned}\\)::int \\+ \\(SELECT COUNT\\(\\*\\) FROM guest_rsvps WHERE flock_id = f\\.id AND status = 'in' AND COALESCE\\(is_hidden, false\\) = false AND reconfirmed_at IS NOT NULL AND reconfirmed_at >= f\\.reconfirm_opened_at\\)::int AS count`),
    'count is accepted members plus visible in guests who answered THIS window: an older timestamp is an answer to an earlier question');
  assert.match(flat, new RegExp(`\\(SELECT COUNT\\(\\*\\) FROM flock_members WHERE flock_id = f\\.id AND status = 'accepted' AND ${notBanned}\\)::int \\+ \\(SELECT COUNT\\(\\*\\) FROM guest_rsvps WHERE flock_id = f\\.id AND status = 'in' AND COALESCE\\(is_hidden, false\\) = false\\)::int AS total`),
    'total is the members the roster shows plus the visible in guests');
  assert.match(flat, /FROM flocks f WHERE f\.id = \$1$/);
  // event_time is a naive TIMESTAMP holding UTC wall clock. Compared against a
  // bare NOW() the answer depends on the database session's zone.
  assert.ok(!/NOW\(\)(?! AT TIME ZONE 'UTC')/.test(flat), 'never a bare NOW() against a naive column');
});

// ===========================================================================
// 3. The sweep
// ===========================================================================

test('the sweep claims confirmed plans inside the lead that nobody has touched lately, in time order, bounded', async () => {
  const n = await runReconfirmSweep(io);
  assert.strictEqual(n, 0);
  assert.strictEqual(log.length, 1, 'one statement when nothing is due');
  const { sql, params } = log[0];
  assert.match(sql, /^UPDATE flocks SET reconfirm_opened_at = NOW\(\), updated_at = NOW\(\) WHERE id IN \( SELECT id FROM flocks WHERE /);
  assert.match(sql, /status = 'confirmed'/, 'only a plan somebody locked in');
  assert.match(sql, /reconfirm_opened_at IS NULL/, 'never twice');
  assert.match(sql, /event_time IS NOT NULL/, 'a plan with no time has no night to be hours before');
  assert.match(sql, /event_time > \(NOW\(\) AT TIME ZONE 'UTC'\)/, 'a plan whose time has passed gets no window');
  assert.match(sql, /event_time <= \(NOW\(\) AT TIME ZONE 'UTC'\) \+ make_interval\(hours => \$1::int\)/, 'within the lead');
  assert.match(sql, /updated_at <= \(NOW\(\) AT TIME ZONE 'UTC'\) - make_interval\(mins => \$2::int\)/,
    'not on the heels of "It\'s happening!"');
  assert.match(sql, /ORDER BY event_time LIMIT \$3::int FOR UPDATE SKIP LOCKED \)/,
    'soonest first, never more than a batch, and the rows are taken, so a second sweep skips them rather than opening them twice');
  assert.match(sql, /\) AND status = 'confirmed' AND reconfirm_opened_at IS NULL RETURNING id, name, venue_name, event_time, /,
    'the outer update re-checks what another writer could have changed since the select');
  assert.match(sql, / RETURNING id, name, venue_name, event_time, EXTRACT\(EPOCH FROM \(event_time - \(NOW\(\) AT TIME ZONE 'UTC'\)\)\) \/ 3600 AS hours_out, EXTRACT\(EPOCH FROM \(event_time AT TIME ZONE 'UTC'\)\) \* 1000 AS event_ms, \(SELECT v\.timezone FROM ml_venues v WHERE v\.google_place_id = flocks\.venue_id LIMIT 1\) AS venue_zone$/,
    'the start as an instant (event_time is naive UTC; less hours_out, it is the database\'s now, for the day the push names), and the venue\'s zone, in the same round trip');
  assert.deepStrictEqual(params, [DEFAULT_LEAD_HOURS, SETTLE_MINUTES, SWEEP_BATCH_SIZE]);
  assert.strictEqual(SETTLE_MINUTES, 15);
  assert.strictEqual(SWEEP_BATCH_SIZE, 200);
  assert.ok(!/created_at/.test(sql), 'when the plan was made says nothing about when its night is');
  assert.ok(!/status (<>|!=)/.test(sql), 'a named status, never a negation');
  assert.ok(!/NOW\(\)(?! AT TIME ZONE 'UTC')/.test(sql.replace(/SET reconfirm_opened_at = NOW\(\), updated_at = NOW\(\)/, '')),
    'every comparison against a naive column is against a UTC reading');
  assert.strictEqual(ran(/FROM flock_members/).length, 0, 'nobody to tell, so nobody is read');
});

test('FLOCK_RECONFIRM_LEAD_HOURS moves the lead without a deploy', async () => {
  process.env.FLOCK_RECONFIRM_LEAD_HOURS = '6';
  await runReconfirmSweep(io);
  assert.deepStrictEqual(log[0].params, [6, SETTLE_MINUTES, SWEEP_BATCH_SIZE]);
});

// Plan 7 is at 8:30 PM in New York, 7:30 PM in Chicago, where its venue is.
// Plan 9's venue is outside the corpus, so it has no zone of its own.
const DINNER_AT = '2026-09-17T00:30:00.000Z';
function scriptOpened() {
  on(/^UPDATE flocks SET reconfirm_opened_at = NOW\(\)/, () => ({
    rows: [
      { id: 7, name: 'Dinner', venue_name: 'The Bar', event_time: DINNER_AT, hours_out: 2.9,
        event_ms: at(DINNER_AT), venue_zone: 'America/Chicago' },
      { id: 9, name: 'Late one', venue_name: null, event_time: '2026-09-17T01:00:00.000Z', hours_out: 0.4,
        event_ms: at('2026-09-17T01:00:00.000Z'), venue_zone: null },
    ],
    rowCount: 2,
  }));
  on(/^SELECT flock_id, user_id FROM flock_members WHERE flock_id = ANY\(\$1::int\[\]\) AND status = 'accepted'$/, () => ({
    rows: [{ flock_id: 7, user_id: 1 }, { flock_id: 7, user_id: 2 }, { flock_id: 9, user_id: 1 }],
    rowCount: 3,
  }));
}

test('an opened window is announced to each accepted member\'s room and pushed to each', async () => {
  scriptOpened();
  // Member 2's phone named New York; member 1's never named a zone.
  deviceZones.set(2, 'America/New_York');
  const n = await runReconfirmSweep(io);
  assert.strictEqual(n, 2);
  const members = ran(/FROM flock_members/)[0];
  assert.deepStrictEqual(members.params, [[7, 9]], 'the rosters of exactly the plans that opened');
  assert.deepStrictEqual(emits, [
    { room: 'user:1', event: 'flock_reconfirm_opened', payload: { flockId: 7, deadline: DINNER_AT } },
    { room: 'user:2', event: 'flock_reconfirm_opened', payload: { flockId: 7, deadline: DINNER_AT } },
    { room: 'user:1', event: 'flock_reconfirm_opened', payload: { flockId: 9, deadline: '2026-09-17T01:00:00.000Z' } },
  ]);
  // The plan and the place, and the start on the venue's clock, as the app
  // shows a plan's time: member 2's phone row says New York, so the time
  // carries Chicago's zone (it used to say 8:30 PM, the phone row's clock, to a
  // member who may well be in Chicago); member 1's phone never named a zone, so
  // no label. The rounded distance only with neither zone.
  assert.deepStrictEqual(pushes, [
    { userId: 1, title: 'Still in?', body: "Dinner at The Bar starts at 7:30 PM. Tap to say you're still coming.", data: { type: 'flock_reconfirm', flockId: '7' } },
    { userId: 2, title: 'Still in?', body: "Dinner at The Bar starts at 7:30 PM CDT. Tap to say you're still coming.", data: { type: 'flock_reconfirm', flockId: '7' } },
    { userId: 1, title: 'Still in?', body: "Late one is soon. Tap to say you're still coming.", data: { type: 'flock_reconfirm', flockId: '9' } },
  ]);
  assert.deepStrictEqual(unknownSql, []);
});

test('a phone zone ICU will not take is no zone: the venue\'s clock is used instead', async () => {
  scriptOpened();
  deviceZones.set(1, 'Not/A_Zone');
  await runReconfirmSweep(io);
  assert.strictEqual(pushes[0].body, "Dinner at The Bar starts at 7:30 PM. Tap to say you're still coming.");
});

test('PUSH_QUIET_DEFAULT_TZ is not anybody\'s clock: the venue\'s wins, unlabelled, and with no venue zone the distance', async () => {
  scriptOpened();
  process.env.PUSH_QUIET_DEFAULT_TZ = 'America/New_York';
  await runReconfirmSweep(io);
  assert.deepStrictEqual(pushes.map((p) => [p.userId, p.body]), [
    [1, "Dinner at The Bar starts at 7:30 PM. Tap to say you're still coming."],
    [2, "Dinner at The Bar starts at 7:30 PM. Tap to say you're still coming."],
    [1, "Late one is soon. Tap to say you're still coming."],
  ]);
});

test('with a 24-hour lead the push names the day, on the day it will land', async () => {
  process.env.FLOCK_RECONFIRM_LEAD_HOURS = '24';
  // 9 PM Wednesday in Chicago, for 8 PM Thursday and for 12:30 AM Thursday.
  on(/^UPDATE flocks SET reconfirm_opened_at = NOW\(\)/, () => ({
    rows: [
      { id: 11, name: 'Dinner', venue_name: 'The Bar', event_time: '2026-09-18T01:00:00.000Z', hours_out: 23,
        event_ms: at('2026-09-18T01:00:00.000Z'), venue_zone: 'America/Chicago' },
      { id: 12, name: 'Late one', venue_name: null, event_time: '2026-09-17T05:30:00.000Z', hours_out: 3.5,
        event_ms: at('2026-09-17T05:30:00.000Z'), venue_zone: 'America/Chicago' },
    ],
    rowCount: 2,
  }));
  on(/^SELECT flock_id, user_id FROM flock_members/, () => ({
    rows: [{ flock_id: 11, user_id: 3 }, { flock_id: 11, user_id: 4 }, { flock_id: 12, user_id: 3 }],
    rowCount: 3,
  }));
  deviceZones.set(3, 'America/Chicago');
  // Member 4's phone says London, where it is 3 AM: quiet hours hold the push
  // until 8 AM there, 2 AM Thursday in Chicago, and on Thursday the plan needs
  // no day. The words are for when it lands.
  deviceZones.set(4, 'Europe/London');
  await runReconfirmSweep(io);
  assert.deepStrictEqual(pushes.map((p) => [p.userId, p.body]), [
    [3, "Dinner at The Bar starts Thursday at 8 PM. Tap to say you're still coming."],
    [4, "Dinner at The Bar starts at 8 PM CDT. Tap to say you're still coming."],
    [3, "Late one starts tonight at 12:30 AM. Tap to say you're still coming."],
  ]);
});

test('with no socket server the pushes still go out', async () => {
  scriptOpened();
  const n = await runReconfirmSweep(undefined);
  assert.strictEqual(n, 2);
  assert.strictEqual(emits.length, 0);
  assert.strictEqual(pushes.length, 3);
});

test('a socket fan-out failure never reaches the timer, and the windows still count as opened', async () => {
  scriptOpened();
  const n = await runReconfirmSweep({ to: () => { throw new Error('adapter gone'); } });
  assert.strictEqual(n, 2);
  assert.strictEqual(pushes.length, 3, 'the push half is not skipped because the socket half failed');
});

test('one rejected push does not abort the rest', async () => {
  scriptOpened();
  pushFailFor = 1;
  const n = await runReconfirmSweep(io);
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(pushes.map((p) => p.userId), [1, 2, 1], 'every delivery was attempted');
});

test('a database failure resolves to 0 instead of crashing the timer', async () => {
  on(/^UPDATE flocks SET reconfirm_opened_at = NOW\(\)/, () => { throw new Error('connection terminated unexpectedly'); });
  const n = await runReconfirmSweep(io);
  assert.strictEqual(n, 0);
  assert.strictEqual(emits.length, 0);
  assert.strictEqual(pushes.length, 0);
});

test('a failure after the windows opened still reports them', async () => {
  // The UPDATE committed on its own, so those windows ARE open and the next
  // pass will not find them again; the count has to say so.
  scriptOpened();
  handlers = handlers.filter(([re]) => !re.test('SELECT flock_id, user_id FROM flock_members WHERE flock_id = ANY($1::int[]) AND status = \'accepted\''));
  on(/^SELECT flock_id, user_id FROM flock_members/, () => { throw new Error('canceling statement due to statement timeout'); });
  const n = await runReconfirmSweep(io);
  assert.strictEqual(n, 2);
});

test('the sweep can be switched off with the same switch as the completion sweep', async () => {
  process.env.FLOCK_SWEEP_ENABLED = 'false';
  const n = await runReconfirmSweep(io);
  assert.strictEqual(n, 0);
  assert.strictEqual(log.length, 0, 'a disabled sweep issues no statement at all');
});

test('the interval is five minutes, because the lead is measured in hours', () => {
  assert.strictEqual(RECONFIRM_SWEEP_INTERVAL_MS, 5 * 60 * 1000);
});

test('the sweep is registered on a timer in server.js and both handles are cleared in shutdown', () => {
  const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(SERVER, /require\('\.\/services\/reconfirmSweep'\)/);
  assert.match(SERVER, /reconfirmSweepInterval = setInterval\(\(\) => runReconfirmSweep\(io\), RECONFIRM_SWEEP_INTERVAL_MS\)/);
  assert.match(SERVER, /reconfirmSweepKickoff = setTimeout\(\(\) => runReconfirmSweep\(io\)/);
  const start = SERVER.indexOf('function shutdown(');
  assert.ok(start > -1);
  const body = SERVER.slice(start, SERVER.indexOf("process.on('SIGTERM'", start));
  assert.match(body, /clearInterval\(reconfirmSweepInterval\)/);
  assert.match(body, /clearTimeout\(reconfirmSweepKickoff\)/);
});

// ===========================================================================
// 4. The member tap: POST /api/flocks/:id/reconfirm
// ===========================================================================

test('no membership row: 404, no state read, no write', async () => {
  scriptMembership(null);
  scriptWindow();
  const res = await memberTap();
  assert.strictEqual(res.status, 404, res.text);
  assert.strictEqual(ran(/AS open, f\.event_time AS deadline/).length, 0, 'a stranger is not told whether a window exists');
  assert.strictEqual(ran(MEMBER_WRITE).length, 0);
});

test('an invitee who never said yes: 403 in words, no write', async () => {
  scriptMembership({ status: 'invited', reconfirmed_at: null });
  scriptWindow();
  const res = await memberTap();
  assert.strictEqual(res.status, 403, res.text);
  assert.match(res.body.error, /Say yes to the plan first/);
  assert.strictEqual(ran(MEMBER_WRITE).length, 0);
});

test('the window is closed: 409 NOT_OPEN, no write', async () => {
  scriptMembership({ status: 'accepted', reconfirmed_at: null });
  scriptWindow({ open: false });
  const res = await memberTap();
  assert.strictEqual(res.status, 409, res.text);
  assert.strictEqual(res.body.code, 'NOT_OPEN');
  assert.strictEqual(ran(MEMBER_WRITE).length, 0);
  assert.strictEqual(emits.length, 0);
});

test('an accepted member\'s tap writes once and answers with the count after it', async () => {
  scriptMembership({ status: 'accepted', reconfirmed_at: null });
  scriptWindow({ count: 2, total: 7 });
  const res = await memberTap();
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, { reconfirmed: true, count: 3, total: 7, deadline: DEADLINE });

  const writes = ran(MEMBER_WRITE);
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].sql, MEMBER_WRITE_SQL,
    'the write is gated on accepted AND on the window in the statement itself, and changes only a row that has not answered this window');
  assert.deepStrictEqual(writes[0].params, [FLOCK, ME.id]);
  // The count is read again after the write, so the number handed back
  // includes this tap.
  assert.strictEqual(ran(/AS open, f\.event_time AS deadline/).length, 2);

  // The room hears it after the response, minus the person who tapped.
  await until(() => emits.length >= 2);
  assert.deepStrictEqual(emits, [
    { room: 'user:2', event: 'flock_reconfirmed', payload: { flockId: FLOCK, userId: ME.id, name: 'Ava', isGuest: false, count: 3, total: 7 } },
    { room: 'user:3', event: 'flock_reconfirmed', payload: { flockId: FLOCK, userId: ME.id, name: 'Ava', isGuest: false, count: 3, total: 7 } },
  ]);
  assert.deepStrictEqual(unknownSql, []);
});

test('a tap that lands after the window shut is refused and changes nothing, even though the read said open', async () => {
  // The race the window-bound write exists for: the state read says open,
  // a time change clears the window before the write lands, and the write,
  // which re-checks the window in its own statement, changes no row. The
  // re-read then says closed, and the person is told the plan moved rather
  // than being counted into a window that no longer exists.
  scriptMembership({ status: 'accepted', reconfirmed_at: null });
  scriptWindow({ count: 2, total: 7, closeAtWrite: true });
  const res = await memberTap();
  assert.strictEqual(res.status, 409, res.text);
  assert.strictEqual(res.body.code, 'NOT_OPEN');
  assert.strictEqual(ran(MEMBER_WRITE).length, 1, 'the write ran and changed nothing: the window check is in the statement');
  assert.strictEqual(ran(/AS open, f\.event_time AS deadline/).length, 2, 'read before, read after');
  assert.strictEqual(emits.length, 0, 'nothing announced');
  assert.deepStrictEqual(unknownSql, []);
});

test('a second tap is already: true with the current count, and changes no row', async () => {
  scriptMembership({ status: 'accepted', reconfirmed_at: '2026-09-16T20:30:00.000Z' });
  scriptWindow({ count: 3, total: 7, already: true });
  const res = await memberTap();
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, { reconfirmed: true, already: true, count: 3, total: 7, deadline: DEADLINE });
  // The statement runs (it is the one that knows whether this window was
  // answered) and changes no row; "already" is read off its row count.
  assert.strictEqual(ran(MEMBER_WRITE).length, 1, 'one window-bound statement, no row changed');
  await until(() => emits.length > 0, 100);
  assert.strictEqual(emits.length, 0, 'and nothing to announce');
});

test('after the deadline a tap is 409 even from someone who had answered', async () => {
  // The screen may be stale; the server is not. A closed window has nothing
  // to count, so the already branch is not reached.
  scriptMembership({ status: 'accepted', reconfirmed_at: '2026-09-16T20:30:00.000Z' });
  scriptWindow({ open: false });
  const res = await memberTap();
  assert.strictEqual(res.status, 409, res.text);
  assert.strictEqual(res.body.code, 'NOT_OPEN');
});

// ===========================================================================
// 5. The guest tap: POST /api/guest/:token/reconfirm
// ===========================================================================

test('no RSVP row: 403, and the lookup applies the takedown filter', async () => {
  scriptGuest(null);
  scriptWindow();
  const res = await guestTap(NOBODY);
  assert.strictEqual(res.status, 403, res.text);
  const lookup = ran(/FROM guest_rsvps WHERE guest_token = \$1 AND flock_id = \$2/)[0];
  assert.ok(lookup, 'the guest is looked up by token');
  assert.match(lookup.sql, /COALESCE\(is_hidden, false\) = false/, 'a hidden row is no row');
  assert.strictEqual(ran(GUEST_WRITE).length, 0);
  assert.strictEqual(guest.guestActionLog.size, 0, 'an unknown token leaves nothing in the budget map');
});

test('an out guest: 409 NOT_IN, before the window is even read', async () => {
  scriptGuest(guestRow({ status: 'out' }));
  scriptWindow();
  const res = await guestTap();
  assert.strictEqual(res.status, 409, res.text);
  assert.strictEqual(res.body.code, 'NOT_IN');
  assert.strictEqual(ran(/AS open, f\.event_time AS deadline/).length, 0);
  assert.strictEqual(ran(GUEST_WRITE).length, 0);
});

test('the window is closed: 409 NOT_OPEN, no write', async () => {
  scriptGuest(guestRow());
  scriptWindow({ open: false });
  const res = await guestTap();
  assert.strictEqual(res.status, 409, res.text);
  assert.strictEqual(res.body.code, 'NOT_OPEN');
  assert.strictEqual(ran(GUEST_WRITE).length, 0);
  assert.strictEqual(emits.length, 0);
});

test('an in guest\'s tap writes only a visible in row, and every member hears the new count', async () => {
  scriptGuest(guestRow());
  scriptWindow({ count: 2, total: 7 });
  const res = await guestTap();
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, { reconfirmed: true, count: 3, total: 7, deadline: DEADLINE });

  const writes = ran(GUEST_WRITE);
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].sql, GUEST_WRITE_SQL,
    'the write re-checks in, not hidden AND the window in the statement, so a row or a plan that changed between the read and the write is not answered for');
  assert.deepStrictEqual(writes[0].params, [GUEST_ID, FLOCK]);

  // Announced through the same fan-out a guest RSVP uses, to every accepted
  // member, with the count the chat draws, and no guest token or row id.
  const heard = emits.filter((e) => e.event === 'flock_reconfirmed');
  assert.deepStrictEqual(heard.map((e) => e.room), ['user:1', 'user:2', 'user:3']);
  for (const e of heard) {
    assert.deepStrictEqual(e.payload, {
      flockId: FLOCK, guestId: guestEntryId(GUEST_ID), name: 'Cass', isGuest: true, count: 3, total: 7,
    });
    assert.ok(!JSON.stringify(e.payload).includes(GUEST_TOKEN));
  }
  assert.deepStrictEqual(unknownSql, []);
});

test('a guest\'s second tap is already: true, writes nothing, emits nothing, and costs one action unit', async () => {
  scriptGuest(guestRow({ reconfirmed_at: '2026-09-16T20:30:00.000Z' }));
  scriptWindow({ count: 3, total: 7, already: true });
  // All but one unit already spent, so the tap below is paying with the
  // last one, and the tap after it shows what it paid.
  for (let i = 0; i < guest.GUEST_ACTIONS_PER_HOUR - 1; i++) guest.allowGuestAction(GUEST_ID);
  const res = await guestTap();
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, { reconfirmed: true, already: true, count: 3, total: 7, deadline: DEADLINE });
  // The statement runs (it is the one that knows whether this window was
  // answered) and changes no row; "already" is read off its row count.
  assert.strictEqual(ran(GUEST_WRITE).length, 1, 'one window-bound statement');
  assert.strictEqual(ran(GUEST_WRITE)[0].rowCount, undefined, 'rows are the fixture\'s to report, not the log\'s');
  assert.strictEqual(emits.length, 0, 'and nothing to announce');
  // Coming back for the count IS an action now. The budget used to sit in
  // front of the write only, which left the NOT_OPEN and already-tapped
  // answers free, and each of them costs a four-subquery statement: a
  // tapped guest replaying them at the general limiter's rate was load
  // with nothing to show for it. So the budget is spent right after the
  // row lookup and the NOT_IN check, before the state is read, and a
  // second tap costs the same unit a first one does.
  assert.strictEqual(guest.guestActionLog.get(String(GUEST_ID)).count, guest.GUEST_ACTIONS_PER_HOUR,
    'the already answer spent the last unit');
  log = [];
  const again = await guestTap();
  assert.strictEqual(again.status, 429, again.text);
  assert.strictEqual(ran(/AS open, f\.event_time AS deadline/).length, 0, 'refused before the state is read');
  assert.strictEqual(ran(GUEST_WRITE).length, 0);
});

test('a spent guest is 429 with a real wait, and nothing is written', async () => {
  scriptGuest(guestRow());
  scriptWindow();
  for (let i = 0; i < guest.GUEST_ACTIONS_PER_HOUR; i++) guest.allowGuestAction(GUEST_ID);
  const res = await guestTap();
  assert.strictEqual(res.status, 429, res.text);
  assert.ok(res.retryAfter && Number(res.retryAfter) >= 1, 'Retry-After is set');
  assert.match(res.body.error, /You can answer again in/);
  assert.strictEqual(ran(GUEST_WRITE).length, 0);
  assert.strictEqual(emits.length, 0);
});

test('a plan that is over: 409 before the guest is looked up', async () => {
  scriptGuest(guestRow(), { status: 'completed' });
  scriptWindow();
  const res = await guestTap();
  assert.strictEqual(res.status, 409, res.text);
  assert.strictEqual(ran(/FROM guest_rsvps WHERE guest_token/).length, 0);
  assert.strictEqual(ran(GUEST_WRITE).length, 0);
});

// ===========================================================================
// 6. The reset: PUT /api/flocks/:id with a new event_time, or a status that
//    leaves confirmed
// ===========================================================================

const RESET_FLOCK = /^UPDATE flocks SET reconfirm_opened_at = NULL WHERE id = \$1$/;
const RESET_MEMBERS = /^UPDATE flock_members SET reconfirmed_at = NULL WHERE flock_id = \$1$/;
const RESET_GUESTS = /^UPDATE guest_rsvps SET reconfirmed_at = NULL WHERE flock_id = \$1$/;
const NEW_TIME = '2026-09-17T01:00:00.000Z';

function scriptPut({ opened }) {
  on(/^SELECT creator_id FROM flocks WHERE id = \$1$/, () => ({ rows: [{ creator_id: ME.id }], rowCount: 1 }));
  // The reopen check, asked only when a status is in the body: this plan is
  // confirmed, so any status may be written over it.
  on(/^SELECT status FROM flocks WHERE id = \$1$/, () => ({ rows: [{ status: 'confirmed' }], rowCount: 1 }));
  on(/^SELECT created_at, status FROM flocks WHERE id = \$1$/, () => ({
    rows: [{ created_at: '2026-01-01T00:00:00.000Z', status: 'confirmed' }], rowCount: 1,
  }));
  on(/^UPDATE flocks SET name = COALESCE\(\$1, name\)/, (params) => ({
    rows: [{
      id: FLOCK, name: params[0] || 'Dinner', venue_name: 'The Bar', venue_address: null, venue_id: null,
      venue_latitude: null, venue_longitude: null, venue_rating: null, venue_photo_url: null,
      event_time: params[8] || DEADLINE, status: params[9] || 'confirmed', budget_enabled: false, budget_locked: false,
      budget_ceiling: null, created_at: '2026-01-01T00:00:00.000Z', reconfirm_opened_at: opened,
    }],
    rowCount: 1,
  }));
  on(/status = 'invited' AND user_id != \$2/, () => ({ rows: [] }));
  on(/^SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2$/, () => ({ rows: [] }));
  on(/FROM user_blocks/, () => ({ rows: [] }));
}

test('a new event_time closes an open window and clears every answer, members and guests', async () => {
  // "Still in for 9?" answered yes is not an answer to "still in for 11?".
  scriptPut({ opened: '2026-09-16T20:00:00.000Z' });
  const res = await call('PUT', `/api/flocks/${FLOCK}`, { event_time: NEW_TIME });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.flock.reconfirm_opened_at, null, 'the response already shows the window closed');

  const sqls = log.map((q) => q.sql);
  const write = sqls.findIndex((s) => /^UPDATE flocks SET name = COALESCE/.test(s));
  const i1 = sqls.findIndex((s) => RESET_FLOCK.test(s));
  const i2 = sqls.findIndex((s) => RESET_MEMBERS.test(s));
  const i3 = sqls.findIndex((s) => RESET_GUESTS.test(s));
  assert.ok(write >= 0 && i1 > write && i2 > i1 && i3 > i2, `the three resets follow the move, in order: ${JSON.stringify(sqls)}`);
  for (const q of [log[i1], log[i2], log[i3]]) {
    assert.strictEqual(String(q.params[0]), String(FLOCK));
  }
  assert.strictEqual(ran(RESET_FLOCK).length, 1);
  assert.strictEqual(ran(RESET_MEMBERS).length, 1);
  assert.strictEqual(ran(RESET_GUESTS).length, 1);
});

test('the reset is absent when no window had opened', async () => {
  scriptPut({ opened: null });
  const res = await call('PUT', `/api/flocks/${FLOCK}`, { event_time: NEW_TIME });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(ran(RESET_FLOCK).length, 0);
  assert.strictEqual(ran(RESET_MEMBERS).length, 0);
  assert.strictEqual(ran(RESET_GUESTS).length, 0);
});

test('an edit that does not move the time leaves an open window and its answers alone', async () => {
  scriptPut({ opened: '2026-09-16T20:00:00.000Z' });
  const res = await call('PUT', `/api/flocks/${FLOCK}`, { name: 'Dinner, moved tables' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.flock.reconfirm_opened_at, '2026-09-16T20:00:00.000Z');
  assert.strictEqual(ran(RESET_FLOCK).length, 0);
  assert.strictEqual(ran(RESET_MEMBERS).length, 0);
  assert.strictEqual(ran(RESET_GUESTS).length, 0);
  assert.strictEqual(ran(/^SELECT created_at, status FROM flocks/).length, 0, 'and the time floor is not even read');
});

test('a status that leaves confirmed closes an open window and clears its answers; completed keeps them', async () => {
  // A plan moved back to planning, or cancelled, is not a plan anyone can be
  // still in for. Without the reset a later re-confirm would find the old
  // window open with the old answers in it and no push to say so, and the
  // sweep would never open a fresh one (reconfirm_opened_at IS NULL is what
  // it claims). Same three statements as a moved time, for the same reason.
  for (const status of ['planning', 'cancelled']) {
    handlers = [];
    log = [];
    scriptPut({ opened: '2026-09-16T20:00:00.000Z' });
    const res = await call('PUT', `/api/flocks/${FLOCK}`, { status });
    assert.strictEqual(res.status, 200, `${status}: ${res.text}`);
    assert.strictEqual(res.body.flock.status, status);
    assert.strictEqual(res.body.flock.reconfirm_opened_at, null, `${status}: the response already shows the window closed`);
    const sqls = log.map((q) => q.sql);
    const write = sqls.findIndex((s) => /^UPDATE flocks SET name = COALESCE/.test(s));
    const i1 = sqls.findIndex((s) => RESET_FLOCK.test(s));
    const i2 = sqls.findIndex((s) => RESET_MEMBERS.test(s));
    const i3 = sqls.findIndex((s) => RESET_GUESTS.test(s));
    assert.ok(write >= 0 && i1 > write && i2 > i1 && i3 > i2, `${status}: the three resets follow the write, in order: ${JSON.stringify(sqls)}`);
    assert.strictEqual(ran(/^SELECT created_at, status FROM flocks/).length, 0, `${status}: no time in the body, so the time floor is not read`);
  }

  // A completed plan keeps its answers: they are the record of the night.
  // And confirming a confirmed plan again is not leaving it.
  for (const status of ['completed', 'confirmed']) {
    handlers = [];
    log = [];
    scriptPut({ opened: '2026-09-16T20:00:00.000Z' });
    const res = await call('PUT', `/api/flocks/${FLOCK}`, { status });
    assert.strictEqual(res.status, 200, `${status}: ${res.text}`);
    assert.strictEqual(res.body.flock.reconfirm_opened_at, '2026-09-16T20:00:00.000Z', `${status}: the window stands`);
    assert.strictEqual(ran(RESET_FLOCK).length, 0, status);
    assert.strictEqual(ran(RESET_MEMBERS).length, 0, status);
    assert.strictEqual(ran(RESET_GUESTS).length, 0, status);
  }

  // And never when no window had opened, whatever the status.
  handlers = [];
  log = [];
  scriptPut({ opened: null });
  const res = await call('PUT', `/api/flocks/${FLOCK}`, { status: 'planning' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(ran(RESET_FLOCK).length, 0);
  assert.strictEqual(ran(RESET_MEMBERS).length, 0);
  assert.strictEqual(ran(RESET_GUESTS).length, 0);
});

test('a reset that fails takes the move back with it, and the answer says nothing changed', async () => {
  // The move used to commit on its own and the reset ran after it in a second
  // transaction whose failure was only logged, so this answered 200 with the
  // plan at its new time and the old window still open, every "still in for
  // 9" counting toward 11. One transaction now: the write, the three resets,
  // then COMMIT, and a failure anywhere in it is a ROLLBACK and a 500.
  scriptPut({ opened: '2026-09-16T20:00:00.000Z' });
  on(RESET_GUESTS, () => { throw new Error('canceling statement due to lock timeout'); });
  const res = await call('PUT', `/api/flocks/${FLOCK}`, { event_time: NEW_TIME });
  assert.strictEqual(res.status, 500, res.text);

  const sqls = log.map((q) => q.sql);
  const begin = sqls.indexOf('BEGIN');
  const write = sqls.findIndex((s) => /^UPDATE flocks SET name = COALESCE/.test(s));
  const rollback = sqls.indexOf('ROLLBACK');
  assert.ok(begin >= 0 && write > begin, `the move is written inside the transaction: ${JSON.stringify(sqls)}`);
  assert.ok(rollback > write, `and rolled back when the reset fails: ${JSON.stringify(sqls)}`);
  assert.strictEqual(sqls.indexOf('COMMIT'), -1, 'nothing was committed, the move included');
  assert.strictEqual(emits.filter((e) => e.event === 'flock_updated').length, 0, 'nobody is told the plan moved');
  assert.strictEqual(pushes.length, 0);

  // And an edit that cannot close a window is still the one statement it was.
  handlers = [];
  log = [];
  scriptPut({ opened: '2026-09-16T20:00:00.000Z' });
  const renamed = await call('PUT', `/api/flocks/${FLOCK}`, { name: 'Dinner, moved tables' });
  assert.strictEqual(renamed.status, 200, renamed.text);
  assert.strictEqual(log.filter((q) => /^(BEGIN|COMMIT|ROLLBACK)/.test(q.sql)).length, 0, 'a rename opened a transaction');
});

// ===========================================================================
// 7. The RSVP edit: POST /api/guest/:token/rsvp from a guest who has a row
// ===========================================================================

test('a guest who says out loses their night-of answer in the RSVP statement itself, and one who stays in keeps it', async () => {
  // reconfirmed_at is an answer to "still in?", and "out" is the opposite
  // answer. The two used to be separate columns that nothing reconciled, so
  // a guest who reconfirmed and then flipped to out was still counted as
  // still-in by RECONFIRM_STATE_SQL's guest arm right up until the row's
  // status was read. The CASE lives in the UPDATE, not in a branch of the
  // route: `status` on the right-hand side is the row's status BEFORE the
  // write, so only a guest who was in and stays in keeps the answer, and
  // both flips (in to out, out to in) clear it.
  scriptGuest(guestRow());
  scriptWindow();
  // Read once on the pool and again, locked, just before the write, which
  // decides from the second read (routes/guest.js).
  on(/^SELECT id, name, status, COALESCE\(is_hidden, false\) AS is_hidden FROM guest_rsvps WHERE guest_token = \$1 AND flock_id = \$2( FOR NO KEY UPDATE)?$/,
    (params) => (String(params[0]).toLowerCase() === GUEST_TOKEN
      ? { rows: [{ id: GUEST_ID, name: 'Cass', status: 'in', is_hidden: false }], rowCount: 1 }
      : { rows: [], rowCount: 0 }));
  on(/^UPDATE guest_rsvps SET name = \$1, status = \$2/, () => ({ rows: [{ id: GUEST_ID, guest_token: GUEST_TOKEN }], rowCount: 1 }));
  // The going count the edit is announced with.
  on(/::int AS members, .*::int AS guests$/, () => ({ rows: [{ members: 3, guests: 0 }], rowCount: 1 }));

  const res = await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, { guestToken: GUEST_TOKEN, name: 'Cass', status: 'out' });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, { guestToken: GUEST_TOKEN, status: 'out' });
  const writes = ran(/^UPDATE guest_rsvps SET name = \$1/);
  assert.strictEqual(writes.length, 1);
  /* THE RULE, NOT THE SPELLING. This pinned the statement character for
     character, and the statement has since had to cast $2 in both places:
     assigned bare into a VARCHAR column and compared as ::text, Postgres
     cannot give the parameter one type and refuses the whole UPDATE, which is
     a 500 on the only path a returning guest has. A fixture demanding the old
     spelling is demanding a statement the database will not run. What this
     test is for is unchanged: one statement, and the CASE inside it is what
     decides whether the night-of answer survives. */
  assert.match(writes[0].sql,
    /reconfirmed_at = CASE WHEN \$2(::text)? = 'in' AND status = 'in' THEN reconfirmed_at ELSE NULL END/,
    'the night-of answer survives only an in that stays in, decided in the statement');
  assert.match(writes[0].sql,
    /WHERE guest_token = \$3 AND flock_id = \$4 AND COALESCE\(is_hidden, false\) = false/,
    'a hidden row is never edited by this path');
  assert.deepStrictEqual(writes[0].params, ['Cass', 'out', GUEST_TOKEN, FLOCK]);
  assert.strictEqual(ran(/SET reconfirmed_at = COALESCE/).length, 0, 'an RSVP edit never records a reconfirmation');

  // The same statement carries an unchanged in: the route does not branch on
  // the answer, the CASE does.
  log = [];
  const same = await call('POST', `/api/guest/${LINK_TOKEN}/rsvp`, { guestToken: GUEST_TOKEN, name: 'Cass', status: 'in' });
  assert.strictEqual(same.status, 200, same.text);
  const again = ran(/^UPDATE guest_rsvps SET name = \$1/);
  assert.strictEqual(again.length, 1);
  assert.strictEqual(again[0].sql, writes[0].sql);
  assert.deepStrictEqual(again[0].params, ['Cass', 'in', GUEST_TOKEN, FLOCK]);
});

test('migration 072 adds the three columns the window is made of, and the index the sweep walks', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'migrations', '072_reconfirm_window.sql'), 'utf8').replace(/\s+/g, ' ');
  assert.match(src, /ALTER TABLE flocks ADD COLUMN IF NOT EXISTS reconfirm_opened_at TIMESTAMPTZ/);
  assert.match(src, /ALTER TABLE flock_members ADD COLUMN IF NOT EXISTS reconfirmed_at TIMESTAMPTZ/);
  assert.match(src, /ALTER TABLE guest_rsvps ADD COLUMN IF NOT EXISTS reconfirmed_at TIMESTAMPTZ/);
  assert.match(src, /CREATE INDEX IF NOT EXISTS idx_flocks_reconfirm_due ON flocks \(event_time\) WHERE status = 'confirmed' AND reconfirm_opened_at IS NULL/,
    'partial over exactly the rows the sweep claims');
});
