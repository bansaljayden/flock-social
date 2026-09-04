// Birdie sees the flocks that are still voting, and refuses in its own
// voice. From the Birdie trace of 2026-09-04. Source contracts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ai = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.js'), 'utf8');
const vd = fs.readFileSync(path.join(__dirname, '..', 'routes', 'venueDashboard.js'), 'utf8');

test('get_user_flocks filters on statuses the schema can hold', () => {
  const i = ai.indexOf('SELECT f.id, f.name, f.venue_name, f.event_time, f.status,');
  const q = ai.slice(i, i + 700);
  assert.match(q, /AND f\.status IN \('planning', 'confirmed'\)/);
  assert.doesNotMatch(q, /'active'/);
  assert.doesNotMatch(vd, /f\.status IN \('active', 'confirmed'\)/);
  assert.strictEqual((vd.match(/f\.status IN \('planning', 'confirmed'\)/g) || []).length, 2);
});

test('navigate_app teaches the model the tab id the enum accepts', () => {
  assert.match(ai, /description: 'The tab to switch to: "home", "explore", "chat", "calendar", "profile"'/);
});

test('the daily refusal is in voice and names its window', () => {
  const i = ai.indexOf("if (rateCheck.reason === 'daily') {");
  assert.ok(i > -1);
  const block = ai.slice(i, i + 700);
  assert.match(block, /const ms = msUntilUtcMidnight\(\);\s*return res\.status\(429\)\.json\(refusalBody\(res, ms, `that's my limit for today\. i'm back \$\{waitPhrase\(ms\)\}`\)\);/);
});

test('the turn budget is checked before the send that follows tool work', () => {
  const i = ai.indexOf('response = await sendWithRetry(functionResponses);');
  const before = ai.slice(i - 800, i);
  assert.match(before, /if \(Date\.now\(\) > turnDeadline\) \{[\s\S]*?break;\s*\}\s*try \{\s*$/);
});
