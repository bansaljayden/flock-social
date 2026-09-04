// loadDmConversations keeps an empty dependency list on purpose: its identity
// is what the recovery and reconnect effects key on. That made a closure over
// deletedDmUserIds freeze the hidden list at its mount-time value, so a
// conversation deleted during the session came back on the next list refetch.
// With the reconnect catch-up, a refetch happens on every return from the
// background, so the loader has to read the CURRENT list through a ref.
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

test('the DM loader filters by the current hidden list, read through a ref', () => {
  const start = app.indexOf('const loadDmConversations = useCallback(() => {');
  expect(start).toBeGreaterThan(-1);
  const body = app.slice(start, app.indexOf('}, []);', start));
  expect(body).toMatch(/const hidden = deletedDmUserIdsRef\.current;/);
  expect(body).not.toMatch(/const hidden = deletedDmUserIds;/);
  // the ref is kept current on every render, right above the loader
  const above = app.slice(start - 400, start);
  expect(above).toMatch(/deletedDmUserIdsRef\.current = deletedDmUserIds;/);
});
