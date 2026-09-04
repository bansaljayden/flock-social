// Where a link in an email actually lands. Found by tracing every URL the
// backend mails against the web entry points in frontend/src/index.js: on
// the web "/" is the marketing site, and "/app" is the app.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the "no password to reset" mail opens the app, not the landing page', () => {
  const src = read('services/emailService.js');
  const start = src.indexOf('There is no password to reset');
  assert.ok(start > -1);
  const block = src.slice(start, start + 4000);
  assert.match(block, /href="\$\{baseWebUrl\(\)\}\/app"[^>]*>Open Flock<\/a>/);
  // and the plain-text half carries the same destination
  assert.match(block, /`\$\{baseWebUrl\(\)\}\/app`,/);
});

test('the venue digest links the dashboard its pointer line names', () => {
  const src = read('templates/venueDigestEmail.js');
  assert.match(src, /const \{ escapeHtml, baseWebUrl \} = require\('\.\.\/services\/emailService'\);/);
  assert.match(src, /l === MORE_LINE/);
  assert.match(src, /href="\$\{escapeHtml\(baseWebUrl\(\)\)\}\/app\?venue=true"/);
});
