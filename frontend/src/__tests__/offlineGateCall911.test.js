// The offline gate covers the whole app whenever the browser says it is
// offline, which hid the SOS button and the sheet's Call 911 from the person
// in a dead zone. A phone call does not need the network.
const fs = require('fs');
const path = require('path');

test('the offline gate carries a Call 911 link above the game', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
  const gate = app.slice(app.indexOf('const OfflineGate = () => {'), app.indexOf('<FlockBirdGame />'));
  expect(gate).toMatch(/<a className="hit44" href="tel:911"/);
  expect(gate).toMatch(/>Call 911<\/a>/);
});
