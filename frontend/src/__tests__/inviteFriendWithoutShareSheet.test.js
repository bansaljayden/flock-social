// "INVITE A FRIEND" DOES SOMETHING ON A COMPUTER, AND CARRIES THE LINK.
//
// The button on Add friends shared the invite through the share sheet and,
// where there was none, sent it to an sms: link. A desktop browser has no app
// for sms:, so on the website the button did nothing at all (the 2026-10-20
// button sweep: "no visible effect", plus a failed navigation). It falls to the
// clipboard, like the plan invite in ChatDetail.js and CreateScreen.js.
//
// Since 2026-11-23 it shares the friend's link (/add/<code>) as the share
// sheet's own url, with the code in the sentence, instead of an App Store link
// and a code to retype: the link's page offers the App Store and the web app,
// and keeps the code through the sign-up. The QR card's Share button sends the
// same. Both go through lib/friendCode.js shareFriendCode, which runs here
// against stand-ins, so this fails when the shipped branch regresses.

import fs from 'fs';
import path from 'path';
import { shareFriendCode } from '../lib/friendCode';

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

const CODE = 'FLOCK-KP5ETGZF';
const URL_ = 'https://www.flockcorp.com/add/FLOCK-KP5ETGZF';

function run(nav, over = {}) {
  const toasts = [];
  const showToast = (msg, type) => toasts.push([msg, type || 'success']);
  const go = () => shareFriendCode({ code: CODE, url: URL_, showToast, copiedNote: 'Invite copied. Paste it into a text.', nav, ...over });
  return { go, toasts };
}

test('both App.js buttons share through it, with the code and its link', () => {
  expect(APP).toMatch(/const handleInviteFriend = useCallback\(async \(\) => \{\s*await shareFriendCode\(\{ code: myFriendCode, url: myFriendCodeUrl, showToast, copiedNote: 'Invite copied\. Paste it into a text\.' \}\);/);
  expect(APP).toMatch(/const handleShareMyCode = useCallback\(async \(\) => \{\s*await shareFriendCode\(\{ code: myFriendCode, url: myFriendCodeUrl, showToast \}\);/);
  // No App Store link and no code to retype any more: the link's page has both.
  expect(APP).not.toMatch(/Add me on Flock, my code is/);
});

test('the share sheet carries the link as its own field and the code in the sentence', async () => {
  const share = jest.fn().mockResolvedValue(undefined);
  const writeText = jest.fn();
  const { go, toasts } = run({ share, clipboard: { writeText } });
  await expect(go()).resolves.toBe('shared');
  expect(share).toHaveBeenCalledTimes(1);
  const [payload] = share.mock.calls[0];
  expect(payload.url).toBe(URL_);
  expect(payload.text).toContain(CODE);
  expect(payload.title).toBe('Add me on Flock');
  expect(payload.text).not.toMatch(/apps\.apple\.com/);
  expect(writeText).not.toHaveBeenCalled();
  expect(toasts).toEqual([]);
});

test('closing the share sheet is an answer, so nothing is copied or said', async () => {
  const abort = Object.assign(new Error('closed'), { name: 'AbortError' });
  const share = jest.fn().mockRejectedValue(abort);
  const writeText = jest.fn();
  const { go, toasts } = run({ share, clipboard: { writeText } });
  await expect(go()).resolves.toBe('closed');
  expect(writeText).not.toHaveBeenCalled();
  expect(toasts).toEqual([]);
});

test('a share sheet that refuses for any other reason falls to the clipboard', async () => {
  const refused = Object.assign(new Error('no'), { name: 'NotAllowedError' });
  const share = jest.fn().mockRejectedValue(refused);
  const writeText = jest.fn().mockResolvedValue(undefined);
  const { go, toasts } = run({ share, clipboard: { writeText } });
  await go();
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(toasts).toEqual([['Invite copied. Paste it into a text.', 'success']]);
});

test('no share sheet: the invite and its link are copied and the toast says so, with no sms: link', async () => {
  const writeText = jest.fn().mockResolvedValue(undefined);
  const { go, toasts } = run({ clipboard: { writeText } });
  await go();
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(writeText.mock.calls[0][0]).toContain(CODE);
  expect(writeText.mock.calls[0][0]).toContain(URL_);
  expect(writeText.mock.calls[0][0]).not.toMatch(/sms:/);
  expect(toasts).toEqual([['Invite copied. Paste it into a text.', 'success']]);
});

test('the QR card says it copied a link', async () => {
  const writeText = jest.fn().mockResolvedValue(undefined);
  const toasts = [];
  await shareFriendCode({ code: CODE, url: URL_, showToast: (m, t) => toasts.push([m, t || 'success']), nav: { clipboard: { writeText } } });
  expect(toasts).toEqual([['Link copied. Paste it into a text.', 'success']]);
});

test('a copy that fails still hands over the code', async () => {
  const writeText = jest.fn().mockRejectedValue(new Error('denied'));
  const { go, toasts } = run({ clipboard: { writeText } });
  await go();
  expect(toasts).toEqual([[`Couldn't copy it. Your code is ${CODE}.`, 'error']]);
});

test('no clipboard at all (an insecure origin) is the same failure, not a throw', async () => {
  const { go, toasts } = run({});
  await expect(go()).resolves.toBe('failed');
  expect(toasts).toEqual([[`Couldn't copy it. Your code is ${CODE}.`, 'error']]);
});

test('a code still loading is said, rather than waited for behind the tap', async () => {
  const share = jest.fn();
  const { go, toasts } = run({ share }, { code: '' });
  await expect(go()).resolves.toBe('waiting');
  expect(share).not.toHaveBeenCalled();
  expect(toasts).toEqual([['Your code is still loading. Try again in a moment.', 'error']]);
});

test('with no link from the server, the link is built on the site', async () => {
  const share = jest.fn().mockResolvedValue(undefined);
  const { go } = run({ share }, { url: '' });
  await go();
  expect(share.mock.calls[0][0].url).toBe('https://www.flockcorp.com/add/FLOCK-KP5ETGZF');
});
