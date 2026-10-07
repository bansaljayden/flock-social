/**
 * The account's pins, flock order and interests are not sent back to it on
 * every launch.
 *
 * pullSettings delivers them and the flock-settings-loaded listener in App.js
 * adopts them as fresh arrays, which re-ran the effects that persist them, and
 * those queued the same three lists straight back: a PATCH
 * /api/users/settings on every boot (measured 2026-10-07 on the local stack,
 * body {"pinnedFlockIds":[],"flockOrder":[],"userInterests":[]}). One that
 * lands just after a change made on another device writes that change away.
 */
const fs = require('fs');
const path = require('path');
jest.mock('../services/api', () => ({
  getUserSettings: jest.fn(),
  updateUserSettings: jest.fn(() => Promise.resolve({})),
  isLoggedIn: jest.fn(() => true),
}));
const api = require('../services/api');
const { sameAsAccount, queueSync, pullSettings } = require('../services/userSettings');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// What a pull hands on to the screen (the flock-settings-loaded detail).
async function handedOn(pulling) {
  let detail = null;
  const on = (e) => { detail = e.detail; };
  window.addEventListener('flock-settings-loaded', on);
  try { await pulling; } finally { window.removeEventListener('flock-settings-loaded', on); }
  return detail;
}
function held() {
  let answer;
  const promise = new Promise((resolve) => { answer = resolve; });
  return { promise, answer };
}

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

describe('sameAsAccount', () => {
  test('a list the account holds is not sent; a changed one is, and is then held', () => {
    const held = { pinnedFlockIds: JSON.stringify([3, 1]) };
    expect(sameAsAccount(held, 'pinnedFlockIds', [3, 1])).toBe(true);
    expect(sameAsAccount(held, 'pinnedFlockIds', [3])).toBe(false);
    expect(held.pinnedFlockIds).toBe('[3]');
    // Changing it back is a change too: the account holds [3] now.
    expect(sameAsAccount(held, 'pinnedFlockIds', [3, 1])).toBe(false);
  });

  test('a key never delivered or sent counts as not held', () => {
    const held = {};
    expect(sameAsAccount(held, 'flockOrder', [])).toBe(false);
    expect(sameAsAccount(held, 'flockOrder', [])).toBe(true);
  });
});

describe('what a pull hands on', () => {
  beforeEach(() => {
    // Each pull writes what it takes into localStorage; a value left by one
    // test must not reach the next one's initial push.
    localStorage.clear();
    api.isLoggedIn.mockReturnValue(true);
    api.updateUserSettings.mockReset();
    api.updateUserSettings.mockImplementation(() => Promise.resolve({}));
  });

  // A change made while the pull is on the wire (a pin on a slow connection)
  // is newer on this device than the pull's answer.
  test('a key sent before the pull asked is taken from the answer; one queued after it asked is not', async () => {
    queueSync({ flockOrder: [1] });
    await wait(700); // the debounce sends it, and it settles
    const answer = held();
    api.getUserSettings.mockImplementation(() => answer.promise);
    const pulling = pullSettings();
    queueSync({ pinnedFlockIds: [7] });
    answer.answer({ settings: { pinnedFlockIds: [], flockOrder: [1] } });
    expect(await handedOn(pulling)).toEqual({ flockOrder: [1] });
    await wait(700);
  });

  test('a key still waiting in the queue is left out, whenever the pull asked', async () => {
    queueSync({ crowdAlerts: 'false' });
    api.getUserSettings.mockImplementation(() => Promise.resolve({ settings: { crowdAlerts: 'true', safetyOn: 'true' } }));
    expect(await handedOn(pullSettings())).toEqual({ safetyOn: 'true' });
    await wait(700);
  });

  test('a key in a PATCH that has not settled is left out, and so is one that settled after the pull asked', async () => {
    const send = held();
    api.updateUserSettings.mockImplementation(() => send.promise);
    queueSync({ userInterests: ['A'] });
    await wait(700); // on the wire now, unsettled
    api.getUserSettings.mockImplementation(() => Promise.resolve({ settings: { userInterests: [], flockOrder: [2] } }));
    expect(await handedOn(pullSettings())).toEqual({ flockOrder: [2] });
    const answer = held();
    api.getUserSettings.mockImplementation(() => answer.promise);
    const pulling = pullSettings();
    send.answer({});
    await wait(5); // it settles after this pull asked
    answer.answer({ settings: { userInterests: [] } });
    expect(await handedOn(pulling)).toEqual({});
  });

  test('overlapping pulls are each judged by when they asked', async () => {
    const first = held();
    api.getUserSettings.mockImplementationOnce(() => first.promise);
    const pullA = pullSettings();
    await wait(5);
    queueSync({ pinnedFlockIds: [3] });
    await wait(700); // sent and settled
    await wait(5);
    api.getUserSettings.mockImplementationOnce(() => Promise.resolve({ settings: { pinnedFlockIds: [3] } }));
    expect(await handedOn(pullSettings())).toEqual({ pinnedFlockIds: [3] });
    // The older answer lands last. It asked before the pin, so it cannot pass for current.
    first.answer({ settings: { pinnedFlockIds: [] } });
    expect(await handedOn(pullA)).toEqual({});
  });

  test('the pull does not write its older value over one this device changed while it was on the wire', async () => {
    localStorage.setItem('flock_order', JSON.stringify([5]));
    let answer;
    api.getUserSettings.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const pulling = pullSettings();
    localStorage.setItem('flock_interests', JSON.stringify(['Food']));
    queueSync({ userInterests: ['Food'] });
    answer({ settings: { userInterests: [], flockOrder: [9] } });
    await pulling;
    expect(localStorage.getItem('flock_interests')).toBe(JSON.stringify(['Food']));
    // A key this device did not touch still takes the account's value.
    expect(localStorage.getItem('flock_order')).toBe(JSON.stringify([9]));
    await new Promise((r) => setTimeout(r, 700));
    localStorage.removeItem('flock_interests');
    localStorage.removeItem('flock_order');
  });

  // A brand-new account: the pull finds nothing and pushes this device's
  // values itself. When that push fails, the values must stay owed, and an
  // edit made while it was on the wire must not be overwritten by them.
  test('a failed initial push queues what is still owed, keeps a newer edit, and hands on neither', async () => {
    localStorage.setItem('flock_interests', JSON.stringify(['Sports']));
    localStorage.setItem('flock_order', JSON.stringify([4]));
    api.getUserSettings.mockImplementation(() => Promise.resolve({ settings: {} }));
    let fail;
    api.updateUserSettings.mockImplementationOnce(() => new Promise((resolve, reject) => { fail = reject; }));
    const pulling = pullSettings();
    await wait(5); // the initial push is on the wire
    queueSync({ flockOrder: [8] }); // an edit meanwhile
    fail(Object.assign(new Error('offline'), { isNetworkError: true }));
    expect(await handedOn(pulling)).toEqual({});
    await wait(700);
    expect(api.updateUserSettings).toHaveBeenLastCalledWith({ flockOrder: [8], userInterests: ['Sports'] });
    localStorage.removeItem('flock_interests');
    localStorage.removeItem('flock_order');
  });
});

test('the listener records what it adopts, and all three effects ask before sending', () => {
  expect(app).toContain('const fresh = (key) => s[key] !== undefined && s[key] !== null;');
  // Each effect's first run records this device's copy, so React's
  // development re-run of a mount effect sends nothing over the account.
  for (const key of ['pinnedFlockIds', 'flockOrder', 'userInterests']) {
    expect(app).toContain(`accountListsRef.current.${key} = JSON.stringify(${key});`);
  }
  expect(app).toContain("['userInterests', 'pinnedFlockIds', 'flockOrder'].forEach((key) => {\n        if (fresh(key) && Array.isArray(s[key])) accountListsRef.current[key] = JSON.stringify(s[key]);");
  // Every synced value the listener adopts goes through fresh().
  for (const key of ['safetyOn', 'crowdAlerts', 'locationEnabled']) {
    expect(app).toContain(`if (fresh('${key}')) {`);
  }
  expect(app).toContain("if (fresh('userInterests') && Array.isArray(s.userInterests)) setUserInterests(s.userInterests);");
  // Recorded before anything is adopted.
  const listener = app.indexOf('const onSettings = (e) => {');
  expect(app.indexOf('accountListsRef.current[key] = JSON.stringify(s[key])', listener))
    .toBeLessThan(app.indexOf('setUserInterests(s.userInterests)', listener));
  for (const key of ['pinnedFlockIds', 'flockOrder', 'userInterests']) {
    expect(app).toContain(`if (sameAsAccount(accountListsRef.current, '${key}', ${key})) return;\n    queueSync({ ${key} });`);
  }
  // Declared before the first effect that reads it.
  expect(app.indexOf('const accountListsRef = useRef({});')).toBeLessThan(app.indexOf("sameAsAccount(accountListsRef.current, 'pinnedFlockIds'"));
});
