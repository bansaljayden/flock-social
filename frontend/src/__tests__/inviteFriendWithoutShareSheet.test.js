// "INVITE A FRIEND" DOES SOMETHING ON A COMPUTER.
//
// The button on Add friends shared the invite through the share sheet and,
// where there was none, sent it to an sms: link. A desktop browser has no app
// for sms:, so on the website the button did nothing at all (the 2026-10-20
// button sweep: "no visible effect", plus a failed navigation). It now falls
// to the clipboard, like the plan invite in ChatDetail.js and CreateScreen.js.
//
// The REAL handler from App.js is compiled and run against stubs, so this
// fails when the shipped branch regresses, not when a string moves.

import fs from 'fs';
import path from 'path';

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
const HEAD = 'const handleInviteFriend = useCallback(';
const start = APP.indexOf(HEAD);
const end = APP.indexOf('}, [myFriendCode, showToast]);', start);
const body = APP.slice(start + HEAD.length, end + 1).trim();

const CODE = 'FLOCK-AB12CD34';

function run(nav) {
  const toasts = [];
  const location = { href: 'https://www.flockcorp.com/app' };
  // eslint-disable-next-line no-new-func
  const handler = new Function(
    'myFriendCode', 'showToast', 'navigator', 'window',
    `return (${body});`
  )(CODE, (msg, type) => toasts.push([msg, type || 'success']), nav, { location });
  return { handler, toasts, location };
}

test('the source still has the shape this suite compiles', () => {
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  expect(body).toMatch(/^async \(\) => \{/);
});

test('the share sheet carries the code and the App Store link', async () => {
  const share = jest.fn().mockResolvedValue(undefined);
  const writeText = jest.fn();
  const { handler, toasts } = run({ share, clipboard: { writeText } });
  await handler();
  expect(share).toHaveBeenCalledTimes(1);
  expect(share.mock.calls[0][0].text).toContain(CODE);
  expect(share.mock.calls[0][0].text).toContain('https://apps.apple.com/app/id6781442127');
  expect(writeText).not.toHaveBeenCalled();
  expect(toasts).toEqual([]);
});

test('closing the share sheet is an answer, so nothing is copied or said', async () => {
  const abort = Object.assign(new Error('closed'), { name: 'AbortError' });
  const share = jest.fn().mockRejectedValue(abort);
  const writeText = jest.fn();
  const { handler, toasts } = run({ share, clipboard: { writeText } });
  await handler();
  expect(writeText).not.toHaveBeenCalled();
  expect(toasts).toEqual([]);
});

test('a share sheet that refuses for any other reason falls to the clipboard', async () => {
  const refused = Object.assign(new Error('no'), { name: 'NotAllowedError' });
  const share = jest.fn().mockRejectedValue(refused);
  const writeText = jest.fn().mockResolvedValue(undefined);
  const { handler, toasts } = run({ share, clipboard: { writeText } });
  await handler();
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(toasts).toEqual([['Invite copied. Paste it into a text.', 'success']]);
});

test('no share sheet: the invite is copied and the toast says so, with no sms: link', async () => {
  const writeText = jest.fn().mockResolvedValue(undefined);
  const { handler, toasts, location } = run({ clipboard: { writeText } });
  await handler();
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(writeText.mock.calls[0][0]).toContain(CODE);
  expect(toasts).toEqual([['Invite copied. Paste it into a text.', 'success']]);
  expect(location.href).toBe('https://www.flockcorp.com/app');
});

test('a copy that fails still hands over the code', async () => {
  const writeText = jest.fn().mockRejectedValue(new Error('denied'));
  const { handler, toasts } = run({ clipboard: { writeText } });
  await handler();
  expect(toasts).toEqual([[`Couldn't copy it. Your code is ${CODE}.`, 'error']]);
});

test('no clipboard at all (an insecure origin) is the same failure, not a throw', async () => {
  const { handler, toasts } = run({});
  await expect(handler()).resolves.toBeUndefined();
  expect(toasts).toEqual([[`Couldn't copy it. Your code is ${CODE}.`, 'error']]);
});
