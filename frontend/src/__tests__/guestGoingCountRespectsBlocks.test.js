// A guest answering live used to set memberCount to the server's raw going
// count, while both REST loaders subtract the members this person has
// blocked. One RSVP re-inflated the count by that many until the next load.
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

test('the roster loader keeps the hidden count on the flock and the live guest count subtracts it', () => {
  expect(app).toMatch(/\{ \.\.\.f, members, guests, hiddenAccepted, memberCount: Math\.max\(0, \(data\.momentum\?\.accepted \?\? acceptedCount\) - hiddenAccepted\)/);
  expect(app).toMatch(/return \{ \.\.\.f, guests, memberCount: Math\.max\(0, Number\(data\.going\) - \(f\.hiddenAccepted \|\| 0\)\) \};/);
  expect(app).not.toMatch(/memberCount: data\.going \}/);
});
