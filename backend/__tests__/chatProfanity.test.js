/**
 * SWEARING SENDS IN CHAT; SLURS STILL DO NOT (2026-09-05).
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

// CHAT BLOCKS FIVE SLURS AND NOTHING ELSE (2026-11-14, the owner's "only 5
// words are blocked"): the rest of the general list refused "oh my god",
// "fuckin" and "sexy" between friends.
test('chat refuses the five slurs, in every spelling on its list', () => {
  const roots = new Set(mod.CHAT_BLOCKED.map((w) => w.replace(/[^a-z]/g, '').replace(/s$/, '').replace('n1gger', 'nigger')));
  assert.deepStrictEqual([...new Set(['nigger', 'faggot', 'kike', 'chink', 'spic'])].every((r) => mod.CHAT_BLOCKED.includes(r)), true);
  assert.ok(roots.size <= 8, 'five words, with their plurals and digit spellings');
  for (const w of mod.CHAT_BLOCKED) {
    assert.strictEqual(mod.moderateChatText(`hey ${w} lol`).allowed, false, w);
  }
});

test('words that are not slurs send in chat, and still fail in a name or bio', () => {
  for (const line of ['oh my god', 'that was sexy', 'fuckin hell', 'what a fart', 'poop emoji', 'sex ed is tomorrow', 'horny lol', 'pawn shop', 'nazi history essay']) {
    assert.strictEqual(mod.moderateChatText(line).allowed, true, line);
  }
  assert.strictEqual(mod.moderateText('oh my god').allowed, false, 'names, bios and flock names keep the full list');
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
