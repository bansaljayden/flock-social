/**
 * The SOS alert and "Share location with contacts" ask the phone for a fix
 * before they send, which can take seconds. A sign-out and another sign-in in
 * that time sent the first person's alert or position from the second
 * person's account (code review 12, 2026-10-07). They capture the account
 * before the wait (currentAccount) and request() refuses to send for anyone
 * else.
 */
import { currentAccount, sendEmergencyAlert, shareLocationWithContacts } from '../services/api';

jest.mock('@capgo/capacitor-social-login', () => ({ SocialLogin: { logout: jest.fn() } }));

const fs = require('fs');
const path = require('path');

// An unsigned token is enough: api.js reads the claims, the server checks the
// signature. Expiry far out so no renewal runs first.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const tokenFor = (userId) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ userId, exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;
const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  json: async () => body,
  text: async () => JSON.stringify(body),
  clone() { return this; },
});

beforeEach(() => {
  localStorage.clear();
  global.fetch = jest.fn(() => Promise.resolve(jsonRes({ message: 'ok', alertId: 1 })));
});

test('the account is read from the stored session', () => {
  expect(currentAccount()).toBeNull();
  localStorage.setItem('flockToken', tokenFor(41));
  expect(currentAccount()).toBe('41');
});

test('a share asked for by one account is not sent once another has signed in', async () => {
  localStorage.setItem('flockToken', tokenFor(41));
  const account = currentAccount();
  localStorage.setItem('flockToken', tokenFor(42));
  await expect(shareLocationWithContacts({ latitude: 1, longitude: 2, account })).rejects.toMatchObject({ sessionEnded: true });
  expect(global.fetch).not.toHaveBeenCalled();
});

test('an SOS asked for by one account is not sent once another has signed in', async () => {
  localStorage.setItem('flockToken', tokenFor(41));
  const account = currentAccount();
  localStorage.setItem('flockToken', tokenFor(42));
  await expect(sendEmergencyAlert({ includeLocation: false, fresh: true, account })).rejects.toMatchObject({ sessionEnded: true });
  expect(global.fetch).not.toHaveBeenCalled();
});

test('in the same session both go out as before', async () => {
  localStorage.setItem('flockToken', tokenFor(41));
  const account = currentAccount();
  await shareLocationWithContacts({ latitude: 1, longitude: 2, account });
  await sendEmergencyAlert({ includeLocation: false, fresh: true, account });
  expect(global.fetch).toHaveBeenCalledTimes(2);
  // The account is held in memory, never sent.
  for (const [, init] of global.fetch.mock.calls) expect(JSON.parse(init.body)).not.toHaveProperty('account');
});

test('captured with nobody signed in, nothing is sent for anyone', async () => {
  const account = currentAccount();
  localStorage.setItem('flockToken', tokenFor(42));
  await expect(shareLocationWithContacts({ latitude: 1, longitude: 2, account })).rejects.toMatchObject({ sessionEnded: true });
  expect(global.fetch).not.toHaveBeenCalled();
});

test('App.js takes the account before each wait for a fix and sends with it', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');
  expect(app).toMatch(/const account = currentAccount\(\);\s*const first = geolocationAvailable\(\) \? await getSosPosition\(/);
  expect(app).toMatch(/includeLocation: !!loc,\s*fresh: true,\s*account,\s*\}\);/);
  expect(app).toMatch(/const account = currentAccount\(\);\s*const pos = await new Promise\(/);
  expect(app).toMatch(/longitude: pos\.coords\.longitude,\s*account,\s*\}\);/);
});
