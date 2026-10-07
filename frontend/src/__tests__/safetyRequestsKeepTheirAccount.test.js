/**
 * The SOS alert and "Share location with contacts" ask the phone for a fix
 * before they send, which can take seconds. A sign-out and another sign-in in
 * that time sent the first person's alert or position from the second
 * person's account (code review 12, 2026-10-07). They capture the account
 * before the wait (currentAccount) and request() refuses to send for anyone
 * else.
 */
import { currentAccount, sendEmergencyAlert, shareLocationWithContacts, cancelEmergencyAlert, uploadProfileImage, saveProfileImageUrl, removeProfileImage } from '../services/api';

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

// code review 13: the other waits that ended in a request.
describe('the stand-down and the profile picture keep to the account that asked', () => {
  const switched = () => {
    localStorage.setItem('flockToken', tokenFor(41));
    const account = currentAccount();
    localStorage.setItem('flockToken', tokenFor(42));
    return account;
  };

  test('an all-clear asked for by one account does not withdraw the next one\'s alert', async () => {
    const account = switched();
    await expect(cancelEmergencyAlert({ account })).rejects.toMatchObject({ sessionEnded: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a picture upload, a generated avatar and a removal are not made for the next account', async () => {
    const account = switched();
    const file = new File(['x'], 'profile.jpg', { type: 'image/jpeg' });
    await expect(uploadProfileImage(file, { account })).rejects.toMatchObject({ sessionEnded: true });
    await expect(saveProfileImageUrl('https://example.com/a.svg', { account })).rejects.toMatchObject({ sessionEnded: true });
    await expect(removeProfileImage({ account })).rejects.toMatchObject({ sessionEnded: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('App.js takes the account before each of those waits', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');
    expect(app).toMatch(/const account = currentAccount\(\);\s*try \{\s*await sosFollowUp\.settled\(\);\s*const data = await cancelEmergencyAlert\(\{ account \}\);/);
    // A photo message goes only if the account that sent it is still signed in.
    expect(app).toMatch(/const sentBy = currentAccount\(\);\s*const thumb = image \? await makeChatThumb\(image\) : null;\s*if \(image && currentAccount\(\) !== sentBy\) return;/);
    expect(app).toMatch(/const sentBy = currentAccount\(\);\s*const dmThumb = payload\.image_url \? await makeChatThumb\(payload\.image_url\) : null;\s*if \(payload\.image_url && currentAccount\(\) !== sentBy\) return;/);
    // The refit is held to its account and ends with the screen.
    expect(app).toMatch(/uploadProfileImage\(new File\(\[blob\], 'profile\.jpg', \{ type: 'image\/jpeg' \}\), \{ account \}\)/);
    expect(app).toContain('return () => { ended = true; };');
  });
});

// The queue every profile picture change goes through, lifted out of App.js
// and run: a removal made while an upload is pending goes after it, and only
// the newest change may draw.
describe('one profile picture change at a time', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = app.indexOf('const changePicture = useCallback(');
  const fnStart = app.indexOf('(run) => {', start);
  const fnEnd = app.indexOf('\n  }, []);', fnStart);
  const fnText = app.slice(fnStart, fnEnd + '\n  }'.length);
  // eslint-disable-next-line no-new-func
  const make = () => new Function('pictureChainRef', 'pictureChangeRef', `return ${fnText};`)({ current: Promise.resolve() }, { current: 0 });

  test('a removal made while an upload is pending runs after it, and the upload may not draw', async () => {
    const changePicture = make();
    const order = [];
    let finishUpload;
    let uploadWasNewest = null;
    const upload = changePicture(async (isNewest) => {
      order.push('upload sent');
      await new Promise((r) => { finishUpload = r; });
      order.push('upload stored');
      uploadWasNewest = isNewest();
    });
    const removal = changePicture(async () => { order.push('removal sent'); });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['upload sent']);
    finishUpload();
    await upload;
    await removal;
    expect(order).toEqual(['upload sent', 'upload stored', 'removal sent']);
    expect(uploadWasNewest).toBe(false);
  });

  test('a change that fails does not stop the next one', async () => {
    const changePicture = make();
    const failed = changePicture(async () => { throw new Error('refused'); });
    await expect(failed).rejects.toThrow('refused');
    let ran = false;
    await changePicture(async (isNewest) => { ran = isNewest(); });
    expect(ran).toBe(true);
  });
});
