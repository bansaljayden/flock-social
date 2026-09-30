// Run: node --test  (from backend/)
//
// THE COMPILED PROFANITY SCREENS GIVE THE LIBRARY'S VERDICT.
//
// utils/moderation.js compiles content-checker's per-word test once instead
// of letting isProfane build every RegExp again on each call. This holds each
// of the three screens (full, chat, provider) to the library instance it was
// compiled from, over every word on the list in the shapes a message puts
// them in, over the allow-listed words, and over ordinary text and real venue
// names. One disagreement anywhere fails the file.

const test = require('node:test');
const assert = require('node:assert');

const mod = require('../utils/moderation');

const { screens } = mod.__test;

function shapesOf(word) {
  return [
    word,
    word.toUpperCase(),
    `${word[0].toUpperCase()}${word.slice(1)}`,
    `you ${word} there`,
    `${word}!`,
    `(${word})`,
    `${word}${word}`,
    `${word}s`,
    `un${word}`,
    `${word}_x`,
    `x${word}y`,
    `${word}-${word}`,
    `${word}'s place`,
    `  ${word}  `,
    `line one\n${word}`,
  ];
}

const ORDINARY = [
  'see you at 9', 'running late, save me a seat', 'Scunthorpe United', 'Essex', 'Sussex',
  'classic', 'assassin', 'cocktail hour', 'Dick\'s Sporting Goods', 'Cox Farms', 'Wang\'s Kitchen',
  'Hell\'s Kitchen', 'Sexy Fish', 'Bloody Run Road', 'Butt Rd', 'Hooters', 'Big Johnson\'s',
  'fuck you lol', 'this is shit', 'damn that\'s good', 'what the hell', '', ' ', '🔥🔥🔥',
  'mañana', 'naïve café', 'ok', 'a'.repeat(4000), 'The Owl & The Pussycat',
];

for (const [name, [lib, screen]] of Object.entries(screens)) {
  test(`${name}: every listed word, in every shape, gets the library's verdict`, () => {
    const words = [...new Set(lib.list)];
    assert.ok(words.length > 400, `the list is the library's (${words.length} words)`);
    const disagreements = [];
    for (const word of words) {
      for (const text of shapesOf(word)) {
        const want = lib.isProfane(text);
        const got = screen(text);
        if (want !== got) disagreements.push({ text, want, got });
      }
    }
    assert.deepStrictEqual(disagreements.slice(0, 10), []);
  });

  test(`${name}: allow-listed words, ordinary text and venue names get the library's verdict`, () => {
    const texts = [...ORDINARY, ...mod.CHAT_ALLOWED, ...mod.PROVIDER_ALLOWED,
      ...mod.CHAT_ALLOWED.map((w) => `oh ${w} off`), ...mod.PROVIDER_ALLOWED.map((w) => `${w} Street`)];
    for (const text of texts) {
      assert.strictEqual(screen(text), lib.isProfane(text), JSON.stringify(text.slice(0, 60)));
    }
  });

  test(`${name}: the same text twice gets the same answer (no state between calls)`, () => {
    const hit = lib.list.find((w) => /^[a-z]{4,}$/.test(w) && lib.isProfane(w));
    for (let i = 0; i < 5; i += 1) {
      assert.strictEqual(screen(`well ${hit} then`), lib.isProfane(`well ${hit} then`));
      assert.strictEqual(screen('see you at 9'), false);
    }
  });
}

test('the three screens still differ where the allow-lists say they do', () => {
  assert.strictEqual(mod.moderateChatText('fuck you lol').allowed, true);
  assert.strictEqual(mod.moderateText('fuck you lol').allowed, false);
  assert.strictEqual(mod.moderateVenueText("Dick's Sporting Goods", 'ChIJN1t_tDeuEmsRUsoyG83frY4').allowed, true);
  assert.strictEqual(mod.moderateVenueText("Dick's Sporting Goods", null).allowed, false);
});

test('a screen is at least ten times faster than the library on a clean message', () => {
  const [lib, screen] = screens.chat;
  const text = 'running late, save me a seat by the window';
  const time = (fn) => { const t = process.hrtime.bigint(); for (let i = 0; i < 200; i += 1) fn(text); return Number(process.hrtime.bigint() - t); };
  time((t) => lib.isProfane(t)); time(screen); // warm both
  const libNs = time((t) => lib.isProfane(t));
  const screenNs = time(screen);
  assert.ok(screenNs * 10 < libNs, `library ${(libNs / 200 / 1000).toFixed(1)} µs, screen ${(screenNs / 200 / 1000).toFixed(1)} µs per call`);
});
