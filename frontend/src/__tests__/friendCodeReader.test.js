/**
 * ONE READER FOR A FRIEND'S CODE, IN EVERY SHAPE IT ARRIVES IN (2026-11-23).
 *
 * A code only worked typed exactly as FLOCK-XXXXXXXX inside Flock: a pasted
 * invite left "ADD ME ON FLOCK" in the box, a missing prefix, a space or a
 * full stop was "Invalid friend code format", and the QR held JSON that the
 * iPhone's own camera offered to search the web for. lib/friendCode.js reads
 * them all, and the scanner, the code box, the deep link and the website page
 * all use it. What is pinned here:
 *
 *   1. friendCodeFrom: the link (ours only), the old JSON, a pasted invite,
 *      a bare code in any case with any spacing.
 *   2. The link is built on the site, the QR carries what the server says
 *      (the JSON every build reads until then), and a code waiting through a
 *      sign-in is kept for a day and no longer.
 *   3. Neither a code nor its preview read rides out in an analytics or crash
 *      payload (lib/scrubUrlTokens.js).
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false friendCodeReader
 */
import {
  FRIEND_CODE_ALPHABET,
  friendCodeFrom,
  friendCodeLink,
  friendQrText,
  qrTextIsLink,
  normalizeFriendCode,
  rememberFriendCode,
  pendingFriendCode,
  forgetFriendCode,
  PENDING_FRIEND_CODE_KEY,
} from '../lib/friendCode';
import { scrubUrlTokens } from '../lib/scrubUrlTokens';

const fs = require('fs');
const path = require('path');

describe('the alphabet is the server\'s', () => {
  test('the same 31 characters routes/friends.js issues codes from', () => {
    const backend = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'friends.js'), 'utf8');
    expect(backend).toContain(`const FRIEND_CODE_ALPHABET = '${FRIEND_CODE_ALPHABET}';`);
    expect(FRIEND_CODE_ALPHABET).toHaveLength(31);
    // No look-alikes: 0 and O, 1, I and L are none of them in it.
    expect(FRIEND_CODE_ALPHABET).not.toMatch(/[01ILO]/);
  });
});

describe('friendCodeFrom', () => {
  const CODE = 'FLOCK-NJQXUGUM';

  test.each([
    ['the issued shape', 'FLOCK-NJQXUGUM'],
    ['lower case', 'flock-njqxugum'],
    ['no prefix', 'NJQXUGUM'],
    ['no prefix, lower case', 'njqxugum'],
    ['a space after the prefix', 'FLOCK- NJQXUGUM'],
    ['a space in the middle', 'njqx ugum'],
    ['a full stop on the end', 'FLOCK-NJQXUGUM.'],
    ['spaces round it', '   FLOCK-NJQXUGUM  '],
    ['a space for the dash', 'FLOCK NJQXUGUM'],
  ])('a code typed: %s', (_, typed) => {
    expect(friendCodeFrom(typed, { origin: '' })).toBe(CODE);
  });

  test('a pasted invite, as a long press in Messages copies it', () => {
    expect(friendCodeFrom('Add me on Flock. My code is FLOCK-NJQXUGUM. https://apps.apple.com/app/id6781442127', { origin: '' })).toBe(CODE);
    expect(friendCodeFrom('Add me on Flock, my code is FLOCK-NJQXUGUM', { origin: '' })).toBe(CODE);
  });

  test("the link the QR and the share sheet carry, on either of the site's hosts", () => {
    expect(friendCodeFrom('https://www.flockcorp.com/add/FLOCK-NJQXUGUM', { origin: '' })).toBe(CODE);
    expect(friendCodeFrom('https://flockcorp.com/add/FLOCK-NJQXUGUM/', { origin: '' })).toBe(CODE);
    expect(friendCodeFrom('https://WWW.FLOCKCORP.COM/add/flock-njqxugum', { origin: '' })).toBe(CODE);
    expect(friendCodeFrom('Add me on Flock https://www.flockcorp.com/add/FLOCK-NJQXUGUM', { origin: '' })).toBe(CODE);
  });

  test("the page's own origin reads its own links, which is what the local stack serves", () => {
    expect(friendCodeFrom('http://127.0.0.1:3519/add/FLOCK-NJQXUGUM', { origin: 'http://127.0.0.1:3519' })).toBe(CODE);
    expect(friendCodeFrom('http://127.0.0.1:3519/add/FLOCK-NJQXUGUM', { origin: 'https://www.flockcorp.com' })).toBeNull();
  });

  test("a link on anybody else's domain is not read, even when its path looks right", () => {
    // The scanner sends a request the moment it reads a code.
    expect(friendCodeFrom('https://example.com/add/FLOCK-NJQXUGUM', { origin: '' })).toBeNull();
    expect(friendCodeFrom('https://flockcorp.com.example.com/add/FLOCK-NJQXUGUM', { origin: '' })).toBeNull();
    expect(friendCodeFrom('see https://example.com/add/FLOCK-NJQXUGUM', { origin: '' })).toBeNull();
    // Our host with some other path is not a friend's link either.
    expect(friendCodeFrom('https://www.flockcorp.com/i/FLOCK-NJQXUGUM', { origin: '' })).toBeNull();
    // A link in any other scheme is set aside, not read as words with a code
    // inside, on our host too. The server's reader refuses the same ones, and
    // the scanner sends the code it read rather than the text, so the two have
    // to agree here (backend __tests__/friendCodeReading.test.js).
    expect(friendCodeFrom('ftp://www.flockcorp.com/add/FLOCK-NJQXUGUM', { origin: '' })).toBeNull();
    expect(friendCodeFrom('ftp://example.com/add/FLOCK-NJQXUGUM', { origin: '' })).toBeNull();
    expect(friendCodeFrom('open otherapp://add/FLOCK-NJQXUGUM now', { origin: '' })).toBeNull();
    // And a sentence with a code still reads when a link beside it is set aside.
    expect(friendCodeFrom('My code is FLOCK-NJQXUGUM. ftp://example.com/x', { origin: '' })).toBe(CODE);
  });

  test('the JSON older builds drew into their QR', () => {
    expect(friendCodeFrom('{"type":"flock_friend","code":"FLOCK-NJQXUGUM"}', { origin: '' })).toBe(CODE);
    expect(friendCodeFrom('{"type":"flock_invite","code":"FLOCK-NJQXUGUM"}', { origin: '' })).toBeNull();
    expect(friendCodeFrom('{not json', { origin: '' })).toBeNull();
  });

  test('what is not a code is not one', () => {
    for (const text of ['', '   ', 'ADD ME ON FLOCK', 'hello', 'FLOCK-NJQX', 'FLOCK-NJQXUGUMX', 'FLOCK-NJQXUGU0', 'flock together', null, undefined, 42]) {
      expect([text, friendCodeFrom(text, { origin: '' })]).toEqual([text, null]);
    }
    expect(friendCodeFrom('x'.repeat(3000), { origin: '' })).toBeNull();
  });

  test('normalizeFriendCode takes the prefix off only when it is the prefix', () => {
    expect(normalizeFriendCode('FLOCKNJQXUGUM')).toBe(CODE);
    expect(normalizeFriendCode('FLOCK-NJQXUGUM-')).toBe(CODE);
    expect(normalizeFriendCode('FLOCK')).toBeNull();
  });
});

describe('the link, and a code waiting through a sign-in', () => {
  beforeEach(() => localStorage.clear());

  test('the link is the site\'s /add/ path, with the server\'s base when it gave one', () => {
    expect(friendCodeLink('flock-njqxugum')).toBe('https://www.flockcorp.com/add/FLOCK-NJQXUGUM');
    expect(friendCodeLink('FLOCK-NJQXUGUM', 'http://127.0.0.1:3519/')).toBe('http://127.0.0.1:3519/add/FLOCK-NJQXUGUM');
    expect(friendCodeLink('nope')).toBe('');
  });

  test("the QR's text: the server's when it reads back to the code, the JSON every build reads when not", () => {
    // The scanner in the builds already on phones reads JSON.parse and
    // nothing else, so the link waits for the server to switch it on.
    const JSON_QR = '{"type":"flock_friend","code":"FLOCK-NJQXUGUM"}';
    const LINK = 'https://www.flockcorp.com/add/FLOCK-NJQXUGUM';
    expect(friendQrText('FLOCK-NJQXUGUM', LINK)).toBe(LINK);
    expect(friendQrText('FLOCK-NJQXUGUM', JSON_QR)).toBe(JSON_QR);
    for (const qr of [undefined, null, '', 42, 'https://www.flockcorp.com/add/FLOCK-KP5ETGZF', 'https://example.com/add/FLOCK-NJQXUGUM', 'hello']) {
      expect([qr, friendQrText('FLOCK-NJQXUGUM', qr)]).toEqual([qr, JSON_QR]);
    }
    // Spelled the way the code was issued, whatever it came in as.
    expect(friendQrText('njqx ugum')).toBe(JSON_QR);
    expect(friendQrText('')).toBe('');
    expect(friendQrText(undefined)).toBe('');
    // A phone's own camera opens only a link.
    expect(qrTextIsLink(LINK)).toBe(true);
    expect(qrTextIsLink(JSON_QR)).toBe(false);
    expect(qrTextIsLink('')).toBe(false);
  });

  test('a kept code comes back once normalised, under a flock* key the sign-out sweeps', () => {
    expect(PENDING_FRIEND_CODE_KEY.startsWith('flock')).toBe(true);
    expect(rememberFriendCode('njqxugum')).toBe(true);
    expect(pendingFriendCode()).toBe('FLOCK-NJQXUGUM');
    forgetFriendCode();
    expect(pendingFriendCode()).toBeNull();
    // Nothing that is not a code is kept.
    expect(rememberFriendCode('hello')).toBe(false);
    expect(localStorage.getItem(PENDING_FRIEND_CODE_KEY)).toBeNull();
  });

  test('a day at most, and a stamp that cannot be read is expired, not immortal', () => {
    localStorage.setItem(PENDING_FRIEND_CODE_KEY, JSON.stringify({ code: 'FLOCK-NJQXUGUM', at: Date.now() - 25 * 60 * 60 * 1000 }));
    expect(pendingFriendCode()).toBeNull();
    expect(localStorage.getItem(PENDING_FRIEND_CODE_KEY)).toBeNull();
    localStorage.setItem(PENDING_FRIEND_CODE_KEY, JSON.stringify({ code: 'FLOCK-NJQXUGUM' }));
    expect(pendingFriendCode()).toBeNull();
    localStorage.setItem(PENDING_FRIEND_CODE_KEY, '{broken');
    expect(pendingFriendCode()).toBeNull();
  });

  test('storage that throws is survived, not thrown', () => {
    const real = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
    try {
      expect(pendingFriendCode()).toBeNull();
    } finally {
      Storage.prototype.getItem = real;
    }
  });
});

describe('a code never rides out in an analytics or crash payload', () => {
  test("a friend's link and the preview read both become :code", () => {
    expect(scrubUrlTokens('https://www.flockcorp.com/add/FLOCK-NJQXUGUM')).toBe('https://www.flockcorp.com/add/:code');
    expect(scrubUrlTokens('GET https://api.flock/api/friends/by-code/FLOCK-NJQXUGUM')).toBe('GET https://api.flock/api/friends/by-code/:code');
    expect(scrubUrlTokens('/add/FLOCK-NJQXUGUM?utm=1')).toBe('/add/:code?utm=1');
    // Paths that only start the same way are left alone.
    expect(scrubUrlTokens('/api/friends/add-by-code')).toBe('/api/friends/add-by-code');
    expect(scrubUrlTokens('/address')).toBe('/address');
  });
});
