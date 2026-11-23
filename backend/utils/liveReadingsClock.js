'use strict';
// ---------------------------------------------------------------------------
// WHEN THE HOUR'S LIVE READINGS REACH SERVING, AND HOW LONG A CACHED CROWD
// ANSWER MAY LIVE (2026-11-23).
//
// The BESTTIME collector's hourly sweep starts at :07 and ends between :59
// and :02 (server clock, UTC on Railway), and the rebuild after it stores each
// venue's newest live readings first (scripts/ml/buildRecentDeviation.js), so
// the reading of the hour that just ended is in ml_venue_recent_deviation by
// about a minute either side of the hour: at about 05:59:20 UTC on 2026-11-23,
// the first run after the readings went first. A number made before then carries
// the reading from two hours back, which on the rehearsal replay was within
// 10 points 63.4% of the time against 88.2% with the hour-old reading.
//
// So a cached crowd answer never lives past the next turn of the hour, and one
// made in the first READINGS_IN_BY_MINUTE minutes after a turn lives no
// further than that minute, by which that hour's readings are in. Each cache
// keeps its own TTL inside that: readingsExpiry is the earlier of the two.
// Minutes are read in UTC because the collector runs on the server's clock;
// for a venue whose zone is a whole number of hours from UTC that is also
// when its own hour turns.
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const READINGS_IN_BY_MINUTE = 3;

// The first boundary after `ms`: HH:03 when `ms` is in HH:00..HH:03, else the
// next HH:00.
function nextReadingsBoundary(ms) {
  const hourStart = Math.floor(ms / HOUR_MS) * HOUR_MS;
  const inBy = hourStart + READINGS_IN_BY_MINUTE * 60 * 1000;
  return ms < inBy ? inBy : hourStart + HOUR_MS;
}

// When an answer cached at `createdMs` with a time-to-live of `ttlMs` stops
// being served.
function readingsExpiry(createdMs, ttlMs) {
  return Math.min(createdMs + ttlMs, nextReadingsBoundary(createdMs));
}

// Whole seconds from `nowMs` until that expiry, never below zero: what an
// HTTP max-age may say about the same answer, so a browser keeps it no longer
// than the server would.
function secondsUntilReadingsExpiry(createdMs, ttlMs, nowMs) {
  return Math.max(0, Math.floor((readingsExpiry(createdMs, ttlMs) - nowMs) / 1000));
}

module.exports = {
  READINGS_IN_BY_MINUTE,
  nextReadingsBoundary,
  readingsExpiry,
  secondsUntilReadingsExpiry,
};
