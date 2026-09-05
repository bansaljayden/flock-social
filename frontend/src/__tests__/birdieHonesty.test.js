// Birdie's context, meter and bubbles tell the truth. From the Birdie
// trace of 2026-09-04. Source contracts.
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '..', 'services', 'api.js'), 'utf8');

test('"this flock" is a flock the person is looking at', () => {
  expect(app).toMatch(/const onFlock = currentScreen === 'chatDetail' \|\| currentScreen === 'detail';\s*const flock = onFlock \? \(flocks\.find\(f => f\.id === selectedFlockId\) \|\| null\) : null;/);
  expect(app).toMatch(/venue: ctx\.flock\.venue && ctx\.flock\.venue !== 'TBD' \? ctx\.flock\.venue : null,/);
});

test('error bubbles never go back to the model as its own words', () => {
  expect(app).toMatch(/const toAiWireMessages = \(messages\) => \(Array\.isArray\(messages\) \? messages : \[\]\)\.filter\(\(m\) => !m\?\.error\)\.map/);
  expect((app.match(/\{ role: 'assistant', error: true, text:/g) || []).length).toBe(3);
  expect(app).toMatch(/!\/\^Something went wrong\/\.test\(err\.message\)/);
});

test('the meter is seeded on boot and closes the box at zero', () => {
  expect(app).toMatch(/const refreshEntitlements = useCallback\(\(\) => \{\s*getEntitlements\(\)\.then\(\(data\) => \{\s*setEntitlements\(data\);[\s\S]*?setAiRemaining\(data\.birdie\.remaining\);/);
  expect(app).toMatch(/const outOfChirps = !!entitlements\?\.paywallEnabled && !isPro && aiRemaining === 0\n\s+&& \(!aiResetsAt \|\| Date\.now\(\) < Date\.parse\(aiResetsAt\)\);/);
  expect(app).toMatch(/const canSendAi = aiInputHasText && !aiTyping && !outOfChirps;/);
  expect(app).toMatch(/if \(outOfChirpsRef\.current\) return;/);
  expect(app).toMatch(/Out of chirps until \$\{new Date\(aiResetsAt\)/);
});

test('the vote card says the vote moves', () => {
  expect(app).toMatch(/One vote each, so it replaces any vote you already cast there\./);
  expect(app).toMatch(/'Voting\\u2026' : 'Vote for it'/);
  expect(app).not.toMatch(/Goes on the vote in/);
});

test('the client waits out the server\'s worst turn', () => {
  expect(api).toMatch(/^const AI_TIMEOUT_MS = 75000;/m);
});
