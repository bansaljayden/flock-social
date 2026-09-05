// What the SOS trace of 2026-09-04 found beyond the coordinates. Source
// contracts on routes/safety.js and the two services it leans on.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const safety = read('routes/safety.js');

test('the flock is told before the email verdict can end the request, on the alarm and the stand-down', () => {
  // `, emailsSent` since 2026-09-04: the flock alarm carries how many trusted
  // contacts were actually reached, so the flockmate's screen stops claiming
  // they were emailed when none were. The ordering this test guards is
  // unchanged: the leg still runs before the 502 can end the request.
  const alarmLeg = safety.indexOf("alertFlockMembers(req.app.get('io'), req.user, coords, emailsSent)");
  const alarm502 = safety.indexOf('if (emailsSent === 0) {');
  assert.ok(alarmLeg > 0 && alarm502 > alarmLeg, 'the alarm flock leg runs before the 502');
  const sdLeg = safety.indexOf("notifyFlockStandDown(req.app.get('io'), req.user, hoursSinceAlert)");
  const sd502 = safety.indexOf('if (told.length === 0) {');
  assert.ok(sdLeg > 0 && sd502 > sdLeg, 'the stand-down flock leg runs before its 502');
  assert.strictEqual((safety.match(/alertFlockMembers\(req\.app\.get\('io'\)/g) || []).length, 1);
  assert.strictEqual((safety.match(/notifyFlockStandDown\(req\.app\.get\('io'\)/g) || []).length, 1);
});

test('the stand-down window is widened by the time since the alarm', () => {
  assert.match(safety, /async function notifyFlockStandDown\(io, user, hoursSinceAlert = 0\)/);
  assert.match(safety, /const windowHours = SOS_FLOCK_WINDOW_HOURS \+ Math\.max\(0, Math\.ceil\(Number\(hoursSinceAlert\) \|\| 0\)\);/);
  assert.match(safety, /pool\.query\(SOS_FLOCK_AUDIENCE_SQL, \[user\.id, windowHours\]\)/);
});

test('the age of the last alert reads as naive UTC like the windows beside it', () => {
  assert.match(safety, /EXTRACT\(EPOCH FROM \(\(NOW\(\) AT TIME ZONE 'UTC'\) - created_at\)\) \* 1000 AS age_ms/);
});

test('the delivered count is retried once before it is only logged', () => {
  assert.match(safety, /await recordCount\(\)\.catch\(\(\) => recordCount\(\)\)\.catch\(/);
});

test('reached means a device took the push', () => {
  assert.strictEqual((safety.match(/\(r\.value\.sent \|\| 0\) > 0\)\.length/g) || []).length, 2);
});

test('the map pin keys are spent first in the push data budget', () => {
  assert.match(read('services/firebaseService.js'), /const DATA_PRIORITY = \['type', 'flockId', 'senderId', 'fromUserId', 'latitude', 'longitude'\];/);
});

test('a banned sender still rings the flock for an SOS and its stand-down', () => {
  assert.match(read('services/pushHelper.js'), /if \(row\.actor_banned && !RINGS_THROUGH_THE_NIGHT\.has\(data\?\.type\)\) return (?:false|CANNOT_SEE);/);
});
