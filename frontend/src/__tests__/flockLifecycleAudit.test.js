/**
 * FLOCK LIFECYCLE (audit 2026-09-05): client pins.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test flockLifecycleAudit --watchAll=false
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

test('a dead invite card leaves on 404 or 409 from accept or decline, and on deletion', () => {
  const app = read('App.js');
  expect((app.match(/if \(err\?\.status === 404 \|\| err\?\.status === 409\) \{\n\s+setPendingFlockInvites\(prev => prev\.filter\(f => f\.id !== flockId\)\);/g) || []).length).toBe(2);
  expect(app).toContain("setFlocks(prev => prev.filter(f => f.id !== data.flockId));\n      setPendingFlockInvites(prev => prev.filter(f => f.id !== data.flockId));");
});

test('an invite card follows a time or venue change and leaves when the plan finishes', () => {
  const app = read('App.js');
  expect(app).toContain("}).filter(f => f.status !== 'completed' && f.status !== 'cancelled'));");
  expect(app).toContain("time: data.event_time ? formatEventTime(data.event_time) : f.time,\n          eventTime: data.event_time || f.eventTime || null,\n          status: data.status === 'planning' ? 'voting' : (data.status || f.status),\n        };\n      }).filter(");
});

test('faces on the card follow joins and leaves', () => {
  const app = read('App.js');
  expect(app).toContain("? [...f.memberPreviews, { id: data.userId, name: data.userName, profile_image_url: data.userImage || null }]");
  expect(app).toContain("memberPreviews: Array.isArray(f.memberPreviews) ? f.memberPreviews.filter(m => m.id !== data.userId) : f.memberPreviews,");
});

test('reordering while searching keeps the hidden plans in the order', () => {
  const app = read('App.js');
  expect(app).toContain("const swapInFullOrder = (flockId, otherId) => {\n      const full = sortedFlocks.map(f => f.id);");
  expect(app).toContain("swapInFullOrder(flockId, visible[idx - 1]);");
  expect(app).toContain("swapInFullOrder(flockId, visible[idx + 1]);");
  expect(app).not.toContain("const ids = filteredFlocks.map(f => f.id);");
});

test('a new plan counts only the host as going, and a cancelled plan reads as finished', () => {
  const create = read('screens/CreateScreen.js');
  const detail = read('screens/FlockDetail.js');
  expect(create).toContain("members: [], invited: invitedNames, memberCount: 1,");
  expect(detail).toContain("const isCompleted = flock.status === 'completed' || flock.status === 'cancelled';");
  expect(detail).toContain("{isCompleted ? (flock.status === 'cancelled' ? 'Cancelled' : 'Done') : isConfirmed ? 'Locked In' : 'Planning'}");
});
