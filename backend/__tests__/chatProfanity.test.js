/**
 * SWEARING SENDS IN CHAT; SLURS STILL DO NOT (Jayden, 2026-09-05).
 *
 * "fuck you" in a flock chat or a DM used to be refused as not fitting the
 * community guidelines. Ordinary cursing between friends is not a guideline
 * problem, and a refused message is a reason to leave the app. Chat bodies
 * are screened on a list with the everyday curse family removed; every
 * other field keeps the full list.
 *
 * HOW TO RUN
 *   cd backend && node --test __tests__/chatProfanity.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mod = require('../utils/moderation');

test('everyday swearing passes in chat and still fails everywhere else', () => {
  for (const line of ['fuck you', 'this is bullshit', 'holy shit that was fun', 'damn, ok', 'you absolute asshole', 'hell yes']) {
    assert.strictEqual(mod.moderateChatText(line).allowed, true, line);
  }
  assert.strictEqual(mod.moderateText('fuck you').allowed, false, 'a name or bio keeps the full list');
});

test('a word that stays on the list is still refused in chat', () => {
  const kept = (mod.filter.list || []).filter((w) => /^[a-z]{4,}$/.test(w) && !mod.CHAT_ALLOWED.includes(w));
  assert.ok(kept.length > 100, 'the chat list removed only the curse family, not the list');
  let refused = 0;
  for (const w of kept.slice(0, 40)) {
    if (!mod.moderateChatText(`hey ${w} lol`).allowed) refused += 1;
  }
  assert.ok(refused >= 30, `words still on the list are refused (${refused}/40)`);
});

test('the four chat doors use the chat list and nothing else does', () => {
  const messages = fs.readFileSync(path.join(__dirname, '..', 'routes', 'messages.js'), 'utf8');
  const handlers = fs.readFileSync(path.join(__dirname, '..', 'sockets', 'handlers.js'), 'utf8');
  assert.strictEqual((messages.match(/rejectIfProfaneChat\(res, message_text\)/g) || []).length, 2, 'flock POST and DM POST');
  assert.ok(!/rejectIfProfane\(res, message_text\)/.test(messages), 'no chat body on the full list');
  assert.match(messages, /rejectIfProfane\(res, venue_name\)/, 'venue text keeps the full list');
  assert.match(handlers, /if \(!moderateChatText\(message_text\)\.allowed\) \{/);
  assert.match(handlers, /if \(!moderateChatText\(text\)\.allowed\) \{/);
  assert.match(handlers, /moderateText\(venue_name\)\.allowed/, 'venue text keeps the full list on the socket too');
});
