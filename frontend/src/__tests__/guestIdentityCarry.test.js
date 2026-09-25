/**
 * A LINK ANSWER AND AN ACCEPTED INVITE ARE ONE PERSON.
 *
 * Somebody who answered a plan's share link by name and then accepted the
 * in-app invite to the same plan stayed on it twice: a guest row and a
 * membership, so "going", momentum, the link's roster and both venue tallies
 * counted them twice. POST /api/flocks/:id/join now retires the guest row it
 * is handed, in the accept's own transaction (backend
 * inviteAcceptRetiresGuestRow.test.js). This file pins the app half: which
 * identities are handed over, and that both accepts and the universal-link
 * redeem hand them over.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');

process.env.REACT_APP_POSTHOG_KEY = '';

const { storedGuestTokens } = require('../services/inviteHandoff');

const A = '11111111-2222-4333-8444-555555555555';
const B = '22222222-3333-4444-8555-666666666666';
const C = '33333333-4444-4555-8666-777777777777';

const keep = (linkToken, entry) => window.localStorage.setItem(`flock_guest_${linkToken}`, JSON.stringify(entry));

describe('storedGuestTokens: the identities on this device that are this person\'s', () => {
  beforeEach(() => { window.localStorage.clear(); });

  test('carries the identities answered under this person\'s whole name, from any link', () => {
    keep('LinkOne12345', { guestToken: A, name: 'Sam Rivera', status: 'in' });
    // Case, surrounding space and doubled spaces are one name, as on the server.
    keep('LinkTwo12345', { guestToken: B, name: '  sam   RIVERA ', status: 'out' });
    expect(storedGuestTokens({ name: 'Sam Rivera' }).sort()).toEqual([A, B].sort());
  });

  test('never an answer that only shares a first name: another Sam on this browser could have given it', () => {
    // The shared-browser case: one Sam answered the link, a different Sam
    // accepts in the app. Presented, the first Sam's row would be retired,
    // their budget answer dropped from the total and their vote handed over.
    keep('LinkOne12345', { guestToken: A, name: 'Sam', status: 'in' });
    keep('LinkTwo12345', { guestToken: B, name: 'sam r', status: 'in' });
    keep('LinkThree123', { guestToken: C, name: 'Sam Smith', status: 'in' });
    expect(storedGuestTokens({ name: 'Sam Jones' })).toEqual([]);
    expect(storedGuestTokens({ name: 'Sam Rivera' })).toEqual([]);
  });

  test('never somebody else\'s answer on a borrowed handset', () => {
    keep('LinkOne12345', { guestToken: A, name: 'Maya Chen', status: 'in' });
    keep('LinkTwo12345', { guestToken: B, name: 'Sam Rivera', status: 'in' });
    expect(storedGuestTokens({ name: 'Sam Rivera' })).toEqual([B]);
  });

  test('an account whose name is one word carries nothing, since the name cannot say which person it is', () => {
    keep('LinkOne12345', { guestToken: A, name: 'Sam', status: 'in' });
    expect(storedGuestTokens({ name: 'Sam' })).toEqual([]);
  });

  test('no name, no identities: nothing is guessed', () => {
    keep('LinkOne12345', { guestToken: A, name: 'Sam Rivera', status: 'in' });
    expect(storedGuestTokens({})).toEqual([]);
    expect(storedGuestTokens({ name: '   ' })).toEqual([]);
  });

  test('narrows to one link\'s identity when asked', () => {
    keep('LinkOne12345', { guestToken: A, name: 'Sam Rivera', status: 'in' });
    keep('LinkTwo12345', { guestToken: B, name: 'Sam Rivera', status: 'in' });
    expect(storedGuestTokens({ name: 'Sam Rivera', linkToken: 'LinkTwo12345' })).toEqual([B]);
  });

  test('shapeless or corrupt entries are skipped, spellings are one identity, and other keys are ignored', () => {
    window.localStorage.setItem('flock_guest_Broken12345', '{not json');
    keep('NoToken12345', { name: 'Sam Rivera', status: 'in' });
    keep('BadToken1234', { guestToken: 'not-a-uuid', name: 'Sam Rivera' });
    keep('Upper1234567', { guestToken: C.toUpperCase(), name: 'Sam Rivera' });
    keep('Lower1234567', { guestToken: C, name: 'Sam Rivera' });
    window.localStorage.setItem('flock_pending_invite', JSON.stringify({ token: 'x', guestToken: A }));
    expect(storedGuestTokens({ name: 'Sam Rivera' })).toEqual([C]);
  });
});

describe('acceptFlockInvite carries them in the body, and only when there are some', () => {
  const api = require('../services/api');
  const jsonResponse = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });

  beforeEach(() => {
    window.localStorage.clear();
    global.fetch = jest.fn(() => Promise.resolve(jsonResponse(200, { member: { status: 'accepted' } })));
  });

  test('with identities: a POST body, never the URL', async () => {
    await api.acceptFlockInvite(7, [A, B]);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toMatch(/\/api\/flocks\/7\/join$/);
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ guestTokens: [A, B] });
  });

  test('without: the same bodiless accept it always was', async () => {
    await api.acceptFlockInvite(7);
    await api.acceptFlockInvite(8, []);
    for (const [, opts] of global.fetch.mock.calls) expect(opts.body).toBeUndefined();
  });
});

describe('App.js hands them over on every path that joins', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

  test('both in-app accepts carry this person\'s identities', () => {
    const calls = app.match(/await acceptFlockInvite\(flockId, storedGuestTokens\(\{ name: meRef\.current\?\.name \}\)\);/g) || [];
    expect(calls).toHaveLength(2);
    expect(app).not.toMatch(/await acceptFlockInvite\(flockId\);/);
  });

  test('the universal link remembers the identity kept for that link, as the invite page does', () => {
    expect(app).toMatch(/rememberInvite\(intent\.token, \{\s*guestToken: storedGuestTokens\(\{ name: meRef\.current\?\.name, linkToken: intent\.token \}\)\[0\] \|\| null,\s*\}\);/);
  });
});
