// Run: node --test  (from backend/)
//
// utils/sanitize.js is the one control between UGC and every text column in
// the database, so this file has to prove BOTH halves of its contract at once:
//
//   1. Ordinary text comes back byte-for-byte. The old implementation
//      entity-encoded `>` and ate everything after a bare `<`, and the damage
//      was stored, not cosmetic — a flock really was named "5 &gt; 3".
//   2. Nothing that comes back can be markup, however the input was written.
//
// A change that satisfies only one half is a regression whichever half it is.
const test = require('node:test');
const assert = require('node:assert');
const { stripHtml, sanitizeArray } = require('../utils/sanitize');

const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(127);

// A tag can only ever start with `<` followed by a letter, `/`, `!` or `?`.
// If no such sequence survives, the value cannot become an element, a comment
// or a doctype in ANY html context, no matter what it is concatenated with.
const TAG_OPEN = /<[a-zA-Z!/?]/;

// ===========================================================================
// 1. The bug: ordinary text must survive exactly as typed
// ===========================================================================

const ORDINARY = [
  '5 > 3',
  'a < b',
  'pizza < tacos',
  '5 > 3 people',
  '5 <= 6 >= 4',
  'I <3 you',
  'me <3 u 4ever',
  'tacos<3pizza',
  'x > y and y < z',
  '-> the roof',
  '<-- this way',
  'Joe\'s Bar & Grill',
  'AT&T store',
  'O\'Brien & Sons, 5 & 6 High St',
  'Rooftop @ 8 (bring $20)',
  'burgers, fries + shakes',
  'Chick-fil-A drive-thru',
  '100% down',
  'cafe "Le Petit"',
  'birthday 🎂 party 🎉',
  'multi\nline\nnote',
  'tabs\tand spaces',
  '',
  ' ',
  '<',
  '>',
  '><',
  '< ',
  '<= >=',
  'a<>b',
  '#1 spot',
  'C++ and C#',
  'math: if a<= b then',
];

test('ordinary text is returned unchanged, character for character', () => {
  for (const s of ORDINARY) {
    assert.strictEqual(stripHtml(s), s, `stripHtml corrupted ordinary text: ${JSON.stringify(s)}`);
  }
});

test('the two reported corruptions specifically', () => {
  // These are the exact strings from the bug report. They are pinned
  // separately so a future "hardening" that reintroduces either one fails
  // with an obvious name.
  assert.strictEqual(stripHtml('5 > 3'), '5 > 3', 'no entity encoding of >');
  assert.strictEqual(stripHtml('a < b'), 'a < b', 'a bare < must not eat the rest of the string');
  assert.ok(!stripHtml('5 > 3').includes('&gt;'));
  assert.ok(!stripHtml('a & b').includes('&amp;'));
});

test('the output is not trimmed and whitespace is not collapsed', () => {
  // Callers trim and length-check themselves; several routes depend on the
  // leading/trailing space being theirs to remove.
  assert.strictEqual(stripHtml('  Rooftop  '), '  Rooftop  ');
  assert.strictEqual(stripHtml('a  b'), 'a  b');
});

// ===========================================================================
// 2. Markup is still neutralised
// ===========================================================================

// [input, what must be left]. `undefined` means "only the no-markup
// invariants below are asserted", for inputs where the exact residue is not
// interesting.
const ATTACKS = [
  ['<script>alert(1)</script>', ''],
  ['<script>alert(1)</script>hello', 'hello'],
  ['<SCRIPT>alert(1)</SCRIPT>hello', 'hello'],
  ['<ScRiPt >alert(1)</ScRiPt >hello', 'hello'],
  ['<script src="//evil.example/x.js"></script>ok', 'ok'],
  ['<script>fetch("/steal")</script>12 Main St', '12 Main St'],
  ['<style>body{background:url(//evil)}</style>Bar', 'Bar'],
  ['<img src=x onerror=alert(1)>Rooftop', 'Rooftop'],
  ['<img src="x" onerror="alert(1)">Rooftop', 'Rooftop'],
  ['<IMG SRC=x ONERROR=alert(1)>Rooftop', 'Rooftop'],
  ['<svg/onload=alert(1)>Park', 'Park'],
  ['<svg><animate onbegin=alert(1)>Park</svg>', 'Park'],
  ['<iframe src="//evil.example"></iframe>Bar', 'Bar'],
  ['<body onload=alert(1)>Bar', 'Bar'],
  ['<a href="javascript:alert(1)">Joe\'s</a>', "Joe's"],
  ['<a href=\'javascript:alert(1)\'>Joe</a>', 'Joe'],
  ['<b>Joe\'s</b> Bar', "Joe's Bar"],
  ['<i>drinks</i> + food', 'drinks + food'],
  ['<b> </b>', ' '],
  ['<div></div>', ''],
  ['<!-- comment -->Rooftop', 'Rooftop'],
  ['<!-->Rooftop', 'Rooftop'],
  ['<!--->Rooftop', 'Rooftop'],
  ['<!--<script>alert(1)</script>-->Rooftop', 'Rooftop'],
  ['<!doctype html>Rooftop', 'Rooftop'],
  ['<![CDATA[<script>alert(1)</script>]]>Rooftop', undefined],
  ['<?php echo 1 ?>Rooftop', 'Rooftop'],
  ['</>Rooftop', 'Rooftop'],
  ['</b>Rooftop', 'Rooftop'],
  // Nested / malformed: stripping once splices `<` next to `/script>` and
  // makes a NEW end tag, which is why the implementation runs to a fixed
  // point rather than once.
  ['<<script>script>alert(1)<</script>/script>', ''],
  ['<scr<script>ipt>alert(1)</scr</script>ipt>', undefined],
  ['<<>>Rooftop', undefined],
  ['<img src=x onerror=alert(1)', ''],
  ['<b<b>>Rooftop', undefined],
  ['<b>>Rooftop', '>Rooftop'],
  // An unquoted `>` inside a quoted attribute value does not end the tag.
  ['<a title="a > b" onclick="alert(1)">Joe</a>', 'Joe'],
  ["<a title='a > b'>Joe</a>", 'Joe'],
  // Null byte and other control-character smuggling.
  [`<scr${NUL}ipt>alert(1)</scr${NUL}ipt>Bar`, 'Bar'],
  [`<img src=x on${NUL}error=alert(1)>Bar`, 'Bar'],
  [`Rooftop${NUL}`, 'Rooftop'],
  [`Roof${DEL}top`, 'Rooftop'],
  // Entity-encoded payloads. They are NOT decoded: they stay inert text, and
  // the thing that matters is that no real tag appears in the output.
  ['&lt;script&gt;alert(1)&lt;/script&gt;', '&lt;script&gt;alert(1)&lt;/script&gt;'],
  ['&#60;script&#62;alert(1)&#60;/script&#62;', '&#60;script&#62;alert(1)&#60;/script&#62;'],
  ['&amp;lt;script&amp;gt;', '&amp;lt;script&amp;gt;'],
];

test('markup is removed and the result can never open a tag', () => {
  for (const [input, expected] of ATTACKS) {
    const out = stripHtml(input);
    if (expected !== undefined) {
      assert.strictEqual(out, expected, `unexpected residue for ${JSON.stringify(input)}`);
    }
    assert.ok(!TAG_OPEN.test(out), `a tag can still be opened from ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
    assert.ok(!/<\s*script/i.test(out), `script tag survived ${JSON.stringify(input)}`);
    assert.ok(!/\bon(error|load|click|begin)\s*=/i.test(out), `an event handler survived ${JSON.stringify(input)}`);
    assert.ok(!out.includes(NUL), `a null byte survived ${JSON.stringify(input)}`);
  }
});

test('sanitizing is idempotent — a stored value re-sanitized is unchanged', () => {
  // Routes sanitize on create AND on update, and moderation tooling re-reads
  // stored text. A second pass that changes anything means stored text drifts
  // every time it is touched (which is how "&amp;gt;" happens).
  for (const s of [...ORDINARY, ...ATTACKS.map(([i]) => i)]) {
    const once = stripHtml(s);
    assert.strictEqual(stripHtml(once), once, `not idempotent: ${JSON.stringify(s)}`);
  }
});

test('a name made only of markup sanitizes to blank, so the route can 400 it', () => {
  // routes/flocks.js sanitizes THEN measures. If any of these came back
  // non-empty the length check would pass and an empty name would be stored.
  for (const s of ['<script>alert(1)</script>', '<b> </b>', '<div></div>', '<!-- x -->', '<img src=x>']) {
    assert.strictEqual(stripHtml(s).trim(), '', `not blank: ${JSON.stringify(s)}`);
  }
});

test('an unterminated tag open takes the rest of the string, like a parser does', () => {
  // Documented consequence of the tokenizer rule, pinned so it is a decision
  // and not an accident: `<` + letter is a tag open even with no `>`, because
  // leaving `<img src=x onerror=alert(1)` in a stored value is one stray `>`
  // away from being live markup. `<` before a space or a digit is text.
  assert.strictEqual(stripHtml('3<x'), '3');
  assert.strictEqual(stripHtml('a<b'), 'a');
  assert.strictEqual(stripHtml('3 < x'), '3 < x');
  assert.strictEqual(stripHtml('3<4'), '3<4');
});

test('a huge adversarial string terminates quickly and safely', () => {
  const started = Date.now();
  for (const s of [
    '<'.repeat(5000),
    '<b'.repeat(2500),
    '<<script>'.repeat(500) + 'x',
    '<!--'.repeat(2000),
    ('<a href="' + 'x'.repeat(100) + '">hi</a>').repeat(50),
  ]) {
    const out = stripHtml(s);
    assert.ok(!TAG_OPEN.test(out), `tag open survived in ${s.slice(0, 20)}…`);
    assert.strictEqual(stripHtml(out), out);
  }
  assert.ok(Date.now() - started < 3000, 'sanitizing degenerate input got slow');
});

test('fuzz: no random mix of markup characters ever yields something tag-shaped', () => {
  const ALPHABET = ['<', '>', '/', '!', '?', '-', '"', "'", '=', ' ', 'a', 'b', 'script', 'img', 'onerror', '1', NUL, '&lt;'];
  let seed = 20260814;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 4000; i++) {
    let s = '';
    const len = 1 + rand(14);
    for (let j = 0; j < len; j++) s += ALPHABET[rand(ALPHABET.length)];
    const out = stripHtml(s);
    assert.ok(!TAG_OPEN.test(out), `tag open survived: ${JSON.stringify(s)} -> ${JSON.stringify(out)}`);
    assert.strictEqual(stripHtml(out), out, `not idempotent: ${JSON.stringify(s)}`);
    assert.ok(!out.includes(NUL));
  }
});

// ===========================================================================
// 3. Contract with the callers
// ===========================================================================

test('non-strings pass through untouched', () => {
  // Every route uses this as an express-validator customSanitizer, where a
  // missing field arrives as undefined. Returning a string here would turn a
  // "field absent" into "field present and empty".
  for (const v of [undefined, null, 42, true, { a: 1 }]) {
    assert.strictEqual(stripHtml(v), v);
  }
  const arr = ['<b>x</b>'];
  assert.strictEqual(stripHtml(arr), arr, 'an array is returned by identity, not stringified');
});

test('stripHtml ignores the extra arguments express-validator passes', () => {
  assert.strictEqual(stripHtml('5 > 3', { req: {}, location: 'body', path: 'name' }), '5 > 3');
});

test('sanitizeArray sanitizes strings and drops shapes that cannot be sanitized', () => {
  assert.deepStrictEqual(sanitizeArray(['music', '<b>art</b>', '5 > 3']), ['music', 'art', '5 > 3']);
  // interests is validated with isArray() alone, so element shape is checked
  // nowhere else. A nested array used to pass through stripHtml untouched
  // (non-strings are returned as-is) and reach a text[] column with its
  // markup intact.
  assert.deepStrictEqual(sanitizeArray([['<script>alert(1)</script>']]), []);
  assert.deepStrictEqual(sanitizeArray([{ x: '<script>alert(1)</script>' }]), []);
  assert.deepStrictEqual(sanitizeArray([null, undefined]), []);
  assert.deepStrictEqual(sanitizeArray(['music', 3, true]), ['music', 3, true]);
  assert.deepStrictEqual(sanitizeArray([]), []);
});

test('sanitizeArray returns non-arrays untouched', () => {
  for (const v of [undefined, null, 'music', 42, { a: 1 }]) {
    assert.strictEqual(sanitizeArray(v), v);
  }
});
