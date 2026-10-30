// Birdie's context, meter and bubbles tell the truth. From the Birdie
// trace of 2026-09-04. Source contracts.
const fs = require('fs');
const path = require('path');

// THE PANEL LEFT App.js ON 2026-09-13 for components/birdie/BirdiePanel.js, so
// the chirp meter line and the vote card this file reads are in that file now.
// Both are read, App.js first, and nothing asserted below changed.
const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n')
  + fs.readFileSync(path.join(__dirname, '..', 'components', 'birdie', 'BirdiePanel.js'), 'utf8').replace(/\r\n/g, '\n');
const api = fs.readFileSync(path.join(__dirname, '..', 'services', 'api.js'), 'utf8').replace(/\r\n/g, '\n');

test('"this flock" is a flock the person is looking at', () => {
  expect(app).toMatch(/const onFlock = currentScreen === 'chatDetail' \|\| currentScreen === 'detail';\s*const flock = onFlock \? \(flocks\.find\(f => f\.id === selectedFlockId\) \|\| null\) : null;/);
  // Built by toAiWireContext since the names were cut to the prompt's width
  // (birdieWindowAndDemoLock.test.js runs it).
  expect(app).toMatch(/venue: c\.flock\.venue && c\.flock\.venue !== 'TBD' \? aiContextName\(c\.flock\.venue\) : null,/);
});

test('error bubbles never go back to the model as its own words', () => {
  expect(app).toMatch(/const toAiWireMessages = \(messages\) => \(Array\.isArray\(messages\) \? messages : \[\]\)\.filter\(\(m\) => !m\?\.error\)\.map/);
  expect((app.match(/\{ role: 'assistant', error: true, text:/g) || []).length).toBe(3);
  // The catch-all bubble reads the server only through birdieRefusalText
  // (run below), which replaced a guard that dropped one generic sentence
  // and let every other error's text through.
  expect(app).toContain("const serverSaid = birdieRefusalText(err);");
  expect(app).toContain("text: serverSaid || 'hmm gimme a sec, hit me again' }");
});

test("a failed turn shows the server's words only for a refusal written for the person", () => {
  const m = app.match(/const birdieRefusalText = \(err\) => \(([\s\S]*?)\n\);/);
  expect(m).not.toBeNull();
  // eslint-disable-next-line no-new-func
  const birdieRefusalText = new Function('err', `return (${m[1]});`);
  const said = (status, message, userFacing = true) => Object.assign(new Error(message), { status, userFacing });
  // Birdie's own refusals in routes/ai.js, as api.js hands them over.
  expect(birdieRefusalText(said(429, 'one sec, lots of people chatting rn. try that again'))).toBe('one sec, lots of people chatting rn. try that again');
  expect(birdieRefusalText(said(400, 'type something first'))).toBe('type something first');
  expect(birdieRefusalText(said(403, "Birdie isn't on for this account."))).toBe("Birdie isn't on for this account.");
  // A 5xx, even one api.js wrote a sentence for, is not a refusal.
  expect(birdieRefusalText(said(503, "Flock's servers are having a moment. Try again in a minute."))).toBeNull();
  expect(birdieRefusalText(said(500, 'Something went wrong on our end. Try again.', false))).toBeNull();
  // A 4xx whose text api.js did not write for people (its generic fallback).
  expect(birdieRefusalText(said(429, 'Something went wrong on our end. Try again.', false))).toBeNull();
  // The network, and a crash in the send.
  expect(birdieRefusalText(Object.assign(new Error('Failed to fetch'), { isNetworkError: true }))).toBeNull();
  expect(birdieRefusalText(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBeNull();
  expect(birdieRefusalText(null)).toBeNull();
  // A refusal too short to be a sentence.
  expect(birdieRefusalText(said(400, 'Bad'))).toBeNull();
});

test('the meter is seeded on boot and closes the box at zero', () => {
  // Every snapshot read goes through applyEntitlements (it drops an answer
  // older than the last applied), and that is where the meter is seeded.
  expect(app).toMatch(/const applyEntitlements = useCallback\(\(seq, data\) => \{[\s\S]*?setEntitlements\(data\);[\s\S]*?setAiRemaining\(data\.birdie\.remaining\);/);
  expect(app).toMatch(/const refreshEntitlements = useCallback\(\(\) => \{\s*const seq = \+\+entitlementsSentRef\.current;\s*\(takeBootRead\('entitlements'\) \|\| getEntitlements\(\)\)\.then\(\(data\) => applyEntitlements\(seq, data\)\)/);
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
