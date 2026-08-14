// Venue-clock consistency for the three surfaces that were still scoring on the
// server (UTC) clock: the venue-owner dashboard (routes/venueDashboard.js), the
// Birdie concierge (routes/ai.js), and the proactive crowd-alert sweep
// (services/crowdAlerts.js). routes/crowd.js was fixed first; these mirror it.
//
// The dashboard and Birdie build their scoring timestamp inline inside route
// handlers wired to Google + the ML predictor + auth, so they are covered by
// the shared crowdEngine helpers they now call (venueLocalNow / weekdayOffset,
// already tested in crowdReaudit). The genuinely NEW logic is in crowdAlerts:
// it has no Google fetch, so it derives the offset from ml_venues.timezone.
// That derivation is what this file pins down.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { venueLocalNow, weekdayOffset } = require('../services/crowdEngine');
const { offsetMinutesForZone, venueWallClock } = require('../services/crowdAlerts').__testables;

test('offsetMinutesForZone uses Google\'s sign convention (UTC+offset = local)', () => {
  // A fixed instant so the assertion is deterministic across DST.
  const at = new Date('2026-07-01T12:00:00Z'); // July: US on daylight time

  // Los Angeles in July is UTC-7 (PDT) -> -420 minutes.
  assert.equal(offsetMinutesForZone('America/Los_Angeles', at), -420);
  // London in July is UTC+1 (BST) -> +60.
  assert.equal(offsetMinutesForZone('Europe/London', at), 60);
  // UTC is zero.
  assert.equal(offsetMinutesForZone('UTC', at), 0);
});

test('a January instant sees standard time, not summer time', () => {
  const at = new Date('2026-01-15T12:00:00Z');
  // LA in January is UTC-8 (PST) -> -480.
  assert.equal(offsetMinutesForZone('America/Los_Angeles', at), -480);
});

test('India\'s fractional +5:30 offset resolves to exactly 330 minutes', () => {
  // Asia/Kolkata has no DST, so any instant works. The half-hour zone is the
  // case a whole-hour offset assumption would silently get wrong.
  const at = new Date('2026-07-01T12:00:00Z');
  assert.equal(offsetMinutesForZone('Asia/Kolkata', at), 330);
  // Nepal is the +5:45 quarter-hour zone — even finer.
  assert.equal(offsetMinutesForZone('Asia/Kathmandu', at), 345);
});

test('a missing or invalid zone yields null (so the caller falls back cleanly)', () => {
  const at = new Date();
  assert.equal(offsetMinutesForZone(null, at), null);
  assert.equal(offsetMinutesForZone('', at), null);
  assert.equal(offsetMinutesForZone('Not/AZone', at), null);
  assert.equal(offsetMinutesForZone(12345, at), null);
});

test('venueWallClock with no offset returns the raw instant on the server clock', () => {
  const instant = new Date('2026-07-01T03:30:00Z');
  const r = venueWallClock(instant, null);
  assert.equal(r.local, false);
  assert.equal(r.time, instant); // unchanged reference — the documented fallback
  assert.equal(r.hour, instant.getHours()); // server-local hour, as before
});

test('venueWallClock builds a Date whose wall clock is the venue\'s hour and day', () => {
  const instant = new Date('2026-07-01T12:00:00Z');
  // India +330.
  const r = venueWallClock(instant, 330);
  const expected = venueLocalNow(330, instant); // { hour, day }
  assert.equal(r.local, true);
  assert.equal(r.hour, expected.hour);
  // The constructed Date reads back the venue's hour/day in the server's own
  // getHours()/getDay() — that is exactly what the rule engine consumes.
  assert.equal(r.time.getHours(), expected.hour);
  assert.equal(r.time.getDay(), expected.day);
});

test('west-of-UTC venue near UTC midnight is scored on YESTERDAY\'s date', () => {
  // Just past midnight UTC on Saturday. A Los Angeles venue is still on Friday
  // evening. The DATE (not just the hour) must be Friday, because holiday and
  // special-night features key off it. This is the exact class of bug the
  // weekdayOffset fix addresses.
  const instant = new Date('2026-07-04T00:30:00Z'); // Sat 00:30 UTC
  const r = venueWallClock(instant, -420); // PDT -> Fri 17:30 local
  const expected = venueLocalNow(-420, instant);
  assert.equal(expected.day, 5); // Friday
  assert.equal(r.time.getDay(), 5);
  assert.equal(r.time.getHours(), 17);
});

test('east-of-UTC venue near UTC midnight is scored on TOMORROW\'s date', () => {
  // Just before midnight UTC on Friday. A Tokyo venue (+540) has rolled into
  // Saturday morning.
  const instant = new Date('2026-07-03T23:30:00Z'); // Fri 23:30 UTC
  const r = venueWallClock(instant, 540); // JST -> Sat 08:30 local
  const expected = venueLocalNow(540, instant);
  assert.equal(expected.day, 6); // Saturday
  assert.equal(r.time.getDay(), 6);
  assert.equal(r.time.getHours(), 8);
});

test('a zero offset is a real venue clock, not the missing-offset fallback', () => {
  // offset 0 must NOT be confused with "no offset": local stays true and the
  // clock is the UTC wall clock, not the server's local one.
  const instant = new Date('2026-07-01T09:15:00Z');
  const r = venueWallClock(instant, 0);
  assert.equal(r.local, true);
  assert.equal(r.hour, 9);
  assert.equal(r.time.getHours(), 9);
});

test('venueWallClock day shift never exceeds the nearest-weekday window', () => {
  // Whatever the offset, the venue day is at most one calendar day from the
  // server day, so weekdayOffset must land within [-1, +1] here.
  const instant = new Date('2026-07-01T12:00:00Z');
  for (const off of [-720, -420, -330, 0, 330, 345, 540, 720]) {
    const r = venueWallClock(instant, off);
    const shift = weekdayOffset(instant.getDay(), venueLocalNow(off, instant).day);
    assert.ok(shift >= -1 && shift <= 1, `offset ${off} shifted ${shift} days`);
    assert.equal(r.time.getDay(), venueLocalNow(off, instant).day);
  }
});
