// Attendance and the reliability score, traced 2026-09-04. Source contracts.
//
// The score is the anti-flake feature, and attendance is the only thing that
// writes it. Everything pinned here is a place where the client and the server
// disagreed about what had been recorded.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('App.js');
const detail = read('screens/FlockDetail.js');
const admin = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'admin.js'), 'utf8');

test('the sheet reopens showing what was recorded, not everybody ticked', () => {
  const i = app.indexOf('const openAttendanceSheet = useCallback(');
  const fn = app.slice(i, i + 2200);
  expect(fn).toMatch(/checks\[m\.id\] = \(m\.attendance \|\| 'unmarked'\) !== 'no_show';/);
  // The all-true seed is gone. It is what let a second tap rewrite a recorded
  // no-show back to 100.
  expect(fn).not.toMatch(/accepted\.forEach\(m => \{ checks\[m\.id\] = true; \}\);/);
});

test('a saved sheet clears the banner that asks for it', () => {
  // attendanceOwed tests for 'unmarked', so the save has to write the answer
  // into the roster this screen holds or the prompt survives its own answer.
  expect(detail).toMatch(/const attendanceOwed = isCompleted && acceptedMembers\.some\(m => typeof m === 'object' && \(m\.attendance \|\| 'unmarked'\) === 'unmarked'\);/);
  expect(app).toMatch(/\{ \.\.\.m, attendance: attendanceChecks\[m\.id\] \? 'attended' : 'no_show' \}/);
});

test('a person the server could not score is named, not counted as saved', () => {
  expect(app).toMatch(/const saved = await submitAttendance\(attendanceFlockId,/);
  expect(app).toMatch(/const missed = Array\.isArray\(saved\?\.unrecorded\) \? saved\.unrecorded\.map\(String\) : \[\];/);
  expect(app).toMatch(/left the flock, so there was nothing to mark for them\./);
  // And their row keeps whatever it had, because nothing was written for them.
  expect(app).toMatch(/&& !missed\.includes\(String\(m\.id\)\)\)/);
});

test('a reliability score of exactly zero is a score', () => {
  expect(app).toMatch(/const readReliability = \(v\) => \{/);
  expect(app).toMatch(/return Number\.isFinite\(n\) \? n : null;/);
  // All three readers go through it, and none of them coalesce on falsiness.
  expect((app.match(/setReliabilityScore\(readReliability\(/g) || []).length).toBe(3);
  expect(app).not.toMatch(/setReliabilityScore\((?:d|data)\.reliabilityScore \|\| null\)/);
});

test('the admin distribution has no gap the flakiest users fall into', () => {
  expect(admin).toMatch(/COUNT\(\*\) FILTER \(WHERE reliability_score >= 0 AND reliability_score < 50\) AS flaky,/);
  expect(admin).not.toMatch(/reliability_score > 0 AND reliability_score < 50/);
});

test('a report from somebody the host marked absent is not verified evidence', () => {
  const feedback = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'feedback.js'), 'utf8');
  expect(feedback).toMatch(/AND fm\.attendance IS DISTINCT FROM 'no_show'/);
});

test('the post-hangout thank-you says whether the report counts', () => {
  // The sweep completes a flock 12 hours after the event and the verification
  // window is the same 12 hours, so a report left the next morning is
  // unverified by construction. Thanking everybody identically claimed
  // otherwise on the majority path.
  expect(detail).toMatch(/const filed = await submitVenueFeedback\(\{/);
  expect(detail).toMatch(/showToast\(filed\?\.verified/);
  expect(detail).toMatch(/Thanks\. Real reports sharpen the forecast for everyone\./);
  expect(detail).toMatch(/Thanks\. Reports from a night here with your flock go into the forecast; this one is noted\./);
  expect(detail).not.toMatch(/Thanks! This helps Flock get smarter/);
});

test('a tap in the app is not reported as a tap on a tag', () => {
  // routes/sensors.js counts venue_checkins with no checkin_source filter, and
  // the in-app Check in button writes 'manual'.
  expect(app).toMatch(/check-in\{sensorData\.recent_checkins === 1 \? '' : 's'\} here in the last hour/);
  expect(app).not.toMatch(/by tag in the last hour/);
});
