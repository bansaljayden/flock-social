// flocks.event_time and created_at are TIMESTAMP WITHOUT TIME ZONE holding a
// UTC wall clock (migrations/000_bootstrap.sql). Comparing them with a bare
// NOW() (timestamptz) casts at the SESSION zone, so a database not set to UTC
// shifts every window by the offset: an SOS at 9 PM reaches nobody from the
// 9 PM plan, a check-in at the venue records no attendance, feedback reads as
// unverified. (NOW() AT TIME ZONE 'UTC') is naive UTC on both sides, the
// form services/flockSweep.js documents. This pins every event_time window.
//
// Scope: event_time only. Other tables' created_at windows (rate limits,
// recency) are the same class in principle but were not verified column by
// column on 2026-09-04, so they are not asserted here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('no route compares event_time against a bare NOW()', () => {
  const offenders = [];
  for (const f of ['routes/safety.js', 'routes/checkin.js', 'routes/feedback.js', 'routes/flocks.js', 'routes/users.js', 'services/flockSweep.js', 'services/crowdAlerts.js']) {
    const lines = read(f).split('\n');
    lines.forEach((line, i) => {
      if (!/event_time/.test(line) || !/\bNOW\(\)/.test(line)) return;
      // The two right forms: naive UTC on both sides, or event_time lifted to
      // timestamptz before it meets NOW() (the invite-expiry line, whose
      // target column is timestamptz).
      if (/NOW\(\) AT TIME ZONE 'UTC'/.test(line)) return;
      if (/event_time AT TIME ZONE 'UTC'/.test(line)) return;
      offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepStrictEqual(offenders, []);
});

test('the six windows found on 2026-09-04 read as naive UTC', () => {
  assert.match(read('routes/safety.js'), /f\.event_time BETWEEN \(NOW\(\) AT TIME ZONE 'UTC'\) - \(\$2::int \* INTERVAL '1 hour'\)/);
  assert.match(read('routes/checkin.js'), /\(NOW\(\) AT TIME ZONE 'UTC'\) BETWEEN event_time - INTERVAL '3 hours'/);
  assert.match(read('routes/feedback.js'), /f\.event_time BETWEEN \(NOW\(\) AT TIME ZONE 'UTC'\) - INTERVAL '12 hours'/);
  assert.match(read('routes/flocks.js'), /COALESCE\(f\.event_time, f\.created_at\) <= \(NOW\(\) AT TIME ZONE 'UTC'\) AS started/);
  assert.match(read('routes/flocks.js'), /COALESCE\(f3\.event_time, f3\.created_at\) <= \(NOW\(\) AT TIME ZONE 'UTC'\)/);
  assert.match(read('routes/users.js'), /> \(NOW\(\) AT TIME ZONE 'UTC'\) - make_interval\(hours => \$2::int\)\) AS upcoming/);
  // the invite expiry lands in a timestamptz column, so event_time is lifted
  // to timestamptz there rather than NOW() being dropped to naive
  assert.match(read('routes/flocks.js'), /COALESCE\(f\.event_time AT TIME ZONE 'UTC', NOW\(\)\) \+ INTERVAL '7 days'/);
});

test('a reconciliation is dated by the business day, not the UTC day', () => {
  const src = read('routes/admin.js');
  assert.match(src, /function businessToday\(\)/);
  assert.match(src, /timeZone: 'America\/New_York'/);
  assert.match(src, /if \(asOf > businessToday\(\)\) \{/);
  assert.match(src, /const today = businessToday\(\);/);
});
