// When the last member leaves, the backend deletes the plan and tells the host
// with a flock_deleted event whose payload carries reason: 'emptied' and,
// deliberately, no name: nobody deleted the plan, and the leaver's name would
// be a block leak. The toast has to word that case by reason rather than fall
// through to "was deleted by undefined".
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

test('the flock_deleted handler words an emptied plan without naming anyone', () => {
  const handler = app.slice(app.indexOf('onFlockDeleted((data) =>'));
  const body = handler.slice(0, handler.indexOf('return unsub;'));
  expect(body).toMatch(/data\.reason === 'emptied'/);
  expect(body).toMatch(/Everybody left \$\{data\.flockName \|\| 'your plan'\}, so it is closed\./);
  // the other branch still names the person who deleted it
  expect(body).toMatch(/was deleted by \$\{data\.deletedBy\}/);
});
