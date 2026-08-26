'use strict';
// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// THE VENUE DASHBOARD'S NAIVE-COLUMN CLOCK: EVERY event_time COMPARISON MUST
// BE MEASURED IN UTC, NOT IN THE DATABASE SESSION ZONE.
// ---------------------------------------------------------------------------
//
// `flocks.event_time` is TIMESTAMP WITHOUT TIME ZONE holding a UTC wall clock.
// Compared against a bare NOW() (a timestamptz), Postgres casts the naive side
// at the DATABASE SESSION's TimeZone, so the window is measured on the Postgres
// server's zone rather than on UTC. Railway's session is UTC, so these landed
// correctly by coincidence; on a server set to anything else every one of these
// windows sits off by that offset, silently, with nothing in a log.
//
// services/flockSweep.js and services/crowdAlerts.js were fixed to compare
// against `(NOW() AT TIME ZONE 'UTC')`. routes/venueDashboard.js had the
// identical latent bug in THREE places: the incoming-flocks feed, the
// unattributed-vote count, and the review presence check. This pins all three
// and refuses a bare NOW() against event_time anywhere in the file.
//
// Source-read rather than executed: what is under test is the SQL text the
// route issues, and the fix is a text change, so a bare NOW() reappearing is
// exactly what a source scan catches and a live query on a UTC database would
// not.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'routes', 'venueDashboard.js'),
  'utf8'
);

test('no event_time is compared against a bare NOW() in venueDashboard.js', () => {
  // The whole class in one assertion: any comparison operator or BETWEEN that
  // puts event_time next to a NOW() with no AT TIME ZONE 'UTC' between them is
  // the bug. `[^)]` keeps the match on one clause so an unrelated NOW() later
  // in the statement cannot mask a bare one attached to event_time.
  const bare = /event_time[^;]{0,40}?(?:[<>]=?|BETWEEN)\s*NOW\(\)(?!\s*AT TIME ZONE)/i;
  assert.ok(
    !bare.test(SRC),
    'a bare NOW() against the naive event_time column borrows the Postgres '
    + "session TimeZone; compare against (NOW() AT TIME ZONE 'UTC') instead"
  );
});

test('every event_time window in the file is anchored to UTC', () => {
  // There are three of them: the incoming feed, the unattributed count, and the
  // review presence check. Count the anchored comparisons so a regression that
  // deletes one and leaves the other two cannot slip through the negative test
  // above (which would still pass on two-of-three).
  // The zone NAME is read in either case, and that is not laxity. Postgres
  // resolves time zone names case-insensitively, services/photoStore.js already
  // writes AT TIME ZONE 'utc' in lower case, and flockCompletionSweep.test.js
  // already reads this same literal with the i flag. Pinning the capitals would
  // fail a correct rewrite on the case of three letters, which is the defect
  // this pattern exists to stop making.
  const anchored = SRC.match(
    /f\.event_time\s*(?:[<>]=?|BETWEEN)\s*\(NOW\(\) AT TIME ZONE '[Uu][Tt][Cc]'\)/g
  ) || [];
  assert.ok(
    anchored.length >= 4,
    'expected the two range bounds each in the incoming feed and the '
    + 'unattributed count (four), plus the review BETWEEN, all anchored to '
    + `UTC; found ${anchored.length}`
  );
});
