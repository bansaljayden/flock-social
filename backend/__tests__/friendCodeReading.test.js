// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// A FRIEND CODE READS BACK FROM EVERY SHAPE IT IS HANDED OVER IN.
// ---------------------------------------------------------------------------
// On a phone the code box took FLOCK-XXXXXXXX exactly and nothing else: the
// eight characters typed without the prefix, a space after FLOCK-, a full stop
// from the end of a sentence, a pasted invite, the QR code's link and its old
// JSON were all 'Invalid friend code format' (Add Friends audit, 2026-11-23).
// utils/friendCode.js reads all of them, for POST /add-by-code and GET
// /by-code/:code, and these are the lines it has to hold:
//
//   1. Every spelling of a code a person can be handed reads back as that
//      code, for every code the issuer can draw.
//   2. The one shape the route always took, FLOCK- and letters and digits,
//      still passes whatever follows the hyphen, so an old id-shaped code
//      reaches the lookup and misses like a code nobody holds
//      (friendCodeAgreement.test.js holds the miss itself).
//   3. Nothing that is not a code turns into one: a sentence without a code,
//      a link on somebody else's host (even with a code in its path), JSON
//      that is not the QR's, a wrong length.
//   4. A link this deployment mints reads back on this deployment, whatever
//      host GET /my-code put it on.
const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'friend-code-reading-test-secret';

const { createFriendCodeReader, FLOCK_HOSTS } = require('../utils/friendCode');

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const read = createFriendCodeReader({ alphabet: ALPHABET, length: 8 });
const CODE = 'FLOCK-7HNPQ3RW';

// Every way the one code above reaches a server.
const SPELLINGS = (code) => {
  const body = code.slice('FLOCK-'.length);
  return [
    code,
    code.toLowerCase(),
    `  ${code}  `,
    body,
    body.toLowerCase(),
    `${body.slice(0, 4)} ${body.slice(4)}`,
    `${body.slice(0, 4)}-${body.slice(4)}`,
    `FLOCK- ${body}`,
    `FLOCK ${body}`,
    `FLOCK${body}`,
    `flock:${body.toLowerCase()}`,
    `${code}.`,
    `${code}!`,
    `FLOCK${String.fromCharCode(0x2014)}${body}`, // a hyphen an autocorrecting keyboard turned into a dash
    `FLOCK${String.fromCharCode(0x200b)}-${body}`, // a zero-width space a copy from a web page carries
    `"${code}"`,
    `Add me on Flock, my code is ${code}. https://apps.apple.com/app/id6781442127`,
    `Add me on Flock. My code is ${code}.`,
    `flock ${body.toLowerCase()} please`,
    `https://www.flockcorp.com/add/${code}`,
    `https://flockcorp.com/add/${body.toLowerCase()}`,
    `https://www.flockcorp.com/add/${code}/`,
    `https://www.flockcorp.com/add/${code}?utm_source=share`,
    `https://www.flockcorp.com/add/${code}.`,
    `(https://www.flockcorp.com/add/${code})`,
    `https://www.flockcorp.com/add/${encodeURIComponent(code)}`,
    `Add me on Flock: https://www.flockcorp.com/add/${code}`,
    JSON.stringify({ type: 'flock_friend', code }),
    JSON.stringify({ type: 'flock_friend', code: body.toLowerCase() }),
  ];
};

test('every spelling of a code reads back as the code', () => {
  for (const text of SPELLINGS(CODE)) {
    assert.strictEqual(read(text), CODE, `${JSON.stringify(text)} did not read as ${CODE}`);
  }
});

test('every code the issuer can draw reads back from every spelling', () => {
  // The route's own reader, so the alphabet it was built with is the one the
  // issuer draws from.
  const { newFriendCode, readFriendCode } = require('../routes/friends').__test;
  for (let i = 0; i < 200; i += 1) {
    const code = newFriendCode();
    for (const text of SPELLINGS(code)) {
      assert.strictEqual(readFriendCode(text), code, `${JSON.stringify(text)} did not read as ${code}`);
    }
  }
});

test('the shape the route always took still passes, whatever follows the hyphen', () => {
  // An id-shaped code from before migration 079, the guesses spamBudgets.test.js
  // sends, and one longer than any issued code: each has to reach the lookup
  // and miss there, not be refused here as a different answer.
  for (const code of ['FLOCK-0016', 'FLOCK-0002', 'FLOCK-GUESS100', 'FLOCK-ZZZZZZZZZZ', 'FLOCK-7HNPQ3RWX']) {
    assert.strictEqual(read(code), code);
    assert.strictEqual(read(code.toLowerCase()), code);
  }
});

test('nothing that is not a code turns into one', () => {
  const NOT_CODES = [
    '', '   ', 'FLOCK', 'FLOCK-', 'Flock rocks', 'ADD ME ON FLOCK', 'Add me on Flock',
    '7HNPQ3R',            // one short
    '7HNPQ3RWX',          // one long, without the prefix
    '7HNPQ3R0',           // 0 is never drawn
    'FLOCK-0016.',        // the old shape with a sentence's full stop: refused before, refused now
    'my flock code is 7HNPQ3RW',
    // Somebody else's host, even with a perfect code in the path. The app's
    // scanner adds on a read, so a printed QR must not pick who you add.
    `https://evil.example/add/${CODE}`,
    `look at this https://evil.example/add/${CODE}`,
    `https://flockcorp.com.evil.example/add/${CODE}`,
    // Flock's host, but not the page a code lives at.
    `https://www.flockcorp.com/i/${CODE}`,
    `https://www.flockcorp.com/add/${CODE}/extra`,
    `ftp://www.flockcorp.com/add/${CODE}`,
    // JSON that is not the QR's payload, and text that only opens like JSON.
    JSON.stringify({ type: 'other', code: CODE }),
    JSON.stringify({ code: CODE }),
    `{${CODE}}`,
    'javascript:alert(1)',
  ];
  for (const text of NOT_CODES) {
    assert.strictEqual(read(text), null, `${JSON.stringify(text)} read as a code`);
  }
  for (const junk of [null, undefined, 12345678, ['FLOCK-7HNPQ3RW'], { code: CODE }, true]) {
    assert.strictEqual(read(junk), null, `${JSON.stringify(junk)} read as a code`);
  }
  assert.strictEqual(read(`${CODE} `.repeat(200)), null, 'an over-long text was walked');
});

test('a link reads on the host it was minted on, and only on Flock hosts otherwise', () => {
  const local = `http://127.0.0.1:3519/add/${CODE}`;
  assert.strictEqual(read(local), null, 'a local link read without its origin being given');
  assert.strictEqual(read(local, { origins: ['http://127.0.0.1:3519'] }), CODE);
  assert.strictEqual(read(local, { origins: ['http://127.0.0.1:9999'] }), null, 'the port is part of the host');
  assert.strictEqual(read(local, { origins: ['not a url'] }), null);
  assert.deepStrictEqual(FLOCK_HOSTS, ['flockcorp.com', 'www.flockcorp.com']);
});

test('the route reads links on the host GET /my-code mints them on', () => {
  const { readFriendCode } = require('../routes/friends').__test;
  const saved = { web: process.env.PUBLIC_WEB_URL, env: process.env.NODE_ENV };
  try {
    process.env.NODE_ENV = 'test';
    process.env.PUBLIC_WEB_URL = 'http://127.0.0.1:3519';
    assert.strictEqual(readFriendCode(`http://127.0.0.1:3519/add/${CODE}`), CODE);
    // Unreadable text comes back as '', which the format check at each door
    // refuses, never as something it guessed.
    assert.strictEqual(readFriendCode('not a code'), '');
    assert.strictEqual(readFriendCode(`http://127.0.0.1:4000/add/${CODE}`), '');
  } finally {
    if (saved.web === undefined) delete process.env.PUBLIC_WEB_URL; else process.env.PUBLIC_WEB_URL = saved.web;
    if (saved.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.env;
  }
});

test('the reader is built from the issuing scheme and refuses one it cannot use', () => {
  assert.throws(() => createFriendCodeReader({ alphabet: 'abc', length: 8 }));
  assert.throws(() => createFriendCodeReader({ alphabet: ALPHABET, length: 0 }));
  assert.throws(() => createFriendCodeReader({ alphabet: '[A-Z]', length: 8 }), 'a pattern smuggled in as an alphabet');
  // A narrower scheme reads narrower codes, so the alphabet really is the one
  // passed in rather than a copy kept here.
  const digitsOnly = createFriendCodeReader({ alphabet: '23456789', length: 4 });
  assert.strictEqual(digitsOnly('2345'), 'FLOCK-2345');
  assert.strictEqual(digitsOnly('7HNPQ3RW'), null);
});
