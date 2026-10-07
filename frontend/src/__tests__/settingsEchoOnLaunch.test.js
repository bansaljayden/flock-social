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
const { sameAsAccount, queueSync, pullSettings, latestPull } = require('../services/userSettings');

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
    // The older answer lands last. An answer older than one already applied
    // is the account as it was, so it is neither written nor handed on.
    first.answer({ settings: { pinnedFlockIds: [] } });
    expect(await handedOn(pullA)).toBeNull();
    expect(localStorage.getItem('flock_pinned')).toBe(JSON.stringify([3]));
  });

  test('an older answer is not applied even when nothing changed on this device', async () => {
    // Another device changed the pins between two pulls; the older answer
    // landing last must not step the screen back.
    const first = held();
    api.getUserSettings.mockImplementationOnce(() => first.promise);
    const pullA = pullSettings();
    await wait(5);
    api.getUserSettings.mockImplementationOnce(() => Promise.resolve({ settings: { pinnedFlockIds: [1, 2] } }));
    expect(await handedOn(pullSettings())).toEqual({ pinnedFlockIds: [1, 2] });
    first.answer({ settings: { pinnedFlockIds: [1] } });
    expect(await handedOn(pullA)).toBeNull();
    expect(localStorage.getItem('flock_pinned')).toBe(JSON.stringify([1, 2]));
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
  // values itself, through the same one-at-a-time path as every save.
  test('a failed initial push stays owed, and an edit made while it was on the wire goes up over it', async () => {
    localStorage.setItem('flock_interests', JSON.stringify(['Sports']));
    localStorage.setItem('flock_order', JSON.stringify([4]));
    api.getUserSettings.mockImplementation(() => Promise.resolve({ settings: {} }));
    let fail;
    api.updateUserSettings.mockImplementationOnce(() => new Promise((resolve, reject) => { fail = reject; }));
    const pulling = pullSettings();
    await wait(5); // the initial push is on the wire
    expect(api.updateUserSettings).toHaveBeenCalledWith({ flockOrder: [4], userInterests: ['Sports'] });
    queueSync({ flockOrder: [8] }); // an edit meanwhile
    fail(Object.assign(new Error('offline'), { isNetworkError: true }));
    expect(await handedOn(pulling)).toEqual({});
    window.dispatchEvent(new Event('online'));
    await wait(700);
    expect(api.updateUserSettings).toHaveBeenLastCalledWith({ flockOrder: [8], userInterests: ['Sports'] });
  });
});

describe('the queue', () => {
  beforeEach(() => {
    localStorage.clear();
    api.isLoggedIn.mockReturnValue(true);
    api.updateUserSettings.mockReset();
    api.updateUserSettings.mockImplementation(() => Promise.resolve({}));
  });

  test('one save is on the wire at a time, and what queued meanwhile goes next', async () => {
    const send = held();
    api.updateUserSettings.mockImplementationOnce(() => send.promise);
    queueSync({ pinnedFlockIds: [1] });
    await wait(700);
    queueSync({ pinnedFlockIds: [1, 2] });
    await wait(700);
    expect(api.updateUserSettings).toHaveBeenCalledTimes(1); // still waiting on the first
    send.answer({});
    await wait(5);
    expect(api.updateUserSettings).toHaveBeenCalledTimes(2);
    expect(api.updateUserSettings).toHaveBeenLastCalledWith({ pinnedFlockIds: [1, 2] });
  });

  test('an older save that fails cannot be sent again over a newer value', async () => {
    let fail;
    api.updateUserSettings.mockImplementationOnce(() => new Promise((resolve, reject) => { fail = reject; }));
    queueSync({ pinnedFlockIds: [1] });
    await wait(700);
    queueSync({ pinnedFlockIds: [1, 2] });
    fail(Object.assign(new Error('offline'), { isNetworkError: true }));
    window.dispatchEvent(new Event('online'));
    await wait(700);
    expect(api.updateUserSettings).toHaveBeenLastCalledWith({ pinnedFlockIds: [1, 2] });
  });

  test('a save lost while the device says it is online is tried again by itself', async () => {
    api.updateUserSettings.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('blip'), { isNetworkError: true })));
    queueSync({ safetyOn: 'false' });
    await wait(700);
    expect(api.updateUserSettings).toHaveBeenCalledTimes(1);
    await wait(5200); // the first retry waits 5 s; no 'online' event comes
    expect(api.updateUserSettings).toHaveBeenCalledTimes(2);
    expect(api.updateUserSettings).toHaveBeenLastCalledWith({ safetyOn: 'false' });
  }, 15000);
});

describe('the end of a session', () => {
  beforeEach(() => {
    localStorage.clear();
    api.isLoggedIn.mockReturnValue(true);
    api.updateUserSettings.mockReset();
    api.updateUserSettings.mockImplementation(() => Promise.resolve({}));
  });
  const endSession = () => window.dispatchEvent(new CustomEvent('flock-session-cleared'));

  test("a queued save does not go up under the next account", async () => {
    queueSync({ userInterests: ['A'] });
    endSession();
    await wait(700);
    expect(api.updateUserSettings).not.toHaveBeenCalled();
  });

  test("a save that fails after the session ended is not queued for the next account", async () => {
    let fail;
    api.updateUserSettings.mockImplementationOnce(() => new Promise((resolve, reject) => { fail = reject; }));
    queueSync({ userInterests: ['A'] });
    await wait(700);
    endSession();
    fail(Object.assign(new Error('offline'), { isNetworkError: true }));
    window.dispatchEvent(new Event('online'));
    await wait(700);
    expect(api.updateUserSettings).toHaveBeenCalledTimes(1);
  });

  test("a pull asked for the last account is not written or handed to the next one", async () => {
    const answer = held();
    api.getUserSettings.mockImplementationOnce(() => answer.promise);
    const pulling = pullSettings();
    endSession();
    answer.answer({ settings: { userInterests: ['A'] } });
    expect(await handedOn(pulling)).toBeNull();
    expect(localStorage.getItem('flock_interests')).toBeNull();
  });

  test('the sign-out sweep announces it, and adopting Location sends nothing back', () => {
    const api = fs.readFileSync(path.join(__dirname, '..', 'services', 'api.js'), 'utf8');
    const sweep = api.slice(api.indexOf('export function clearLocalSession('));
    expect(sweep.slice(0, sweep.indexOf('\n}\n'))).toContain("window.dispatchEvent(new CustomEvent('flock-session-cleared'))");
    expect(app).toContain("if (!fromAccount) queueSync({ locationEnabled: enable ? 'true' : 'false' });");
    expect(app).toContain('toggleLocation(on, { fromAccount: true })');
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

describe('an answer that lands before the screen is listening', () => {
  beforeEach(() => {
    localStorage.clear();
    window.dispatchEvent(new CustomEvent('flock-session-cleared'));
    api.isLoggedIn.mockReturnValue(true);
    api.updateUserSettings.mockReset();
    api.updateUserSettings.mockImplementation(() => Promise.resolve({}));
  });

  test('is kept, numbered, and checked again against what this device changed since', async () => {
    api.getUserSettings.mockImplementation(() => Promise.resolve({ settings: { pinnedFlockIds: [1, 5], flockOrder: [5, 1] } }));
    let seq = null;
    const on = (e) => { seq = e.pullSeq; };
    window.addEventListener('flock-settings-loaded', on);
    await pullSettings();
    window.removeEventListener('flock-settings-loaded', on);
    expect(seq).toBeGreaterThan(0);
    expect(latestPull()).toEqual({ seq, values: { pinnedFlockIds: [1, 5], flockOrder: [5, 1] } });
    queueSync({ flockOrder: [1, 5] }); // changed here after the pull asked
    expect(latestPull()).toEqual({ seq, values: { pinnedFlockIds: [1, 5] } });
    await wait(700);
  });

  test("is not kept past the session's end", async () => {
    api.getUserSettings.mockImplementation(() => Promise.resolve({ settings: { userInterests: ['A'] } }));
    await pullSettings();
    expect(latestPull()).not.toBeNull();
    window.dispatchEvent(new CustomEvent('flock-session-cleared'));
    expect(latestPull()).toBeNull();
  });

  test('the main screen takes it when its listener attaches, once', () => {
    expect(app).toContain('const missed = latestPull();');
    expect(app).toContain('if (missed && missed.seq > appliedPullRef.current) onSettings({ detail: missed.values, pullSeq: missed.seq });');
    expect(app).toContain('if (e.pullSeq) appliedPullRef.current = Math.max(appliedPullRef.current, e.pullSeq);');
  });
});

describe('a save while the device wrongly says it is offline', () => {
  test('is still tried again', async () => {
    const was = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });
    try {
      api.isLoggedIn.mockReturnValue(true);
      api.updateUserSettings.mockReset();
      api.updateUserSettings
        .mockImplementationOnce(() => Promise.reject(Object.assign(new Error('timeout'), { isNetworkError: true })))
        .mockImplementation(() => Promise.resolve({}));
      queueSync({ crowdAlerts: 'false' });
      await wait(700);
      expect(api.updateUserSettings).toHaveBeenCalledTimes(1);
      await wait(5200); // no 'online' event will come
      expect(api.updateUserSettings).toHaveBeenCalledTimes(2);
    } finally {
      if (was) Object.defineProperty(window.navigator, 'onLine', was);
      else delete window.navigator.onLine;
    }
  }, 15000);
});

test('every mode choice reaches the account, not only the picker', () => {
  // rememberMode writes this device's copy and queues the account's.
  expect(app).toContain("function rememberMode(mode) {");
  expect(app).toContain('queueSync({ userMode: mode || null });');
  // No mode write in App.js goes around it, except the first launch's default
  // for a regular user, which is not a choice.
  const writes = app.match(/localStorage\.(setItem|removeItem)\('flockUserMode'[^;]*;/g) || [];
  expect(writes).toEqual([
    "localStorage.setItem('flockUserMode', mode);",
    "localStorage.removeItem('flockUserMode');",
  ]);
  expect(app.match(/lsSet\('flockUserMode', '[a-z]+'\);/g)).toEqual(["lsSet('flockUserMode', 'user');"]);
  for (const call of ["rememberMode('venue');", "rememberMode('admin');", "rememberMode('user');", 'rememberMode(mode);', 'rememberMode(null);']) {
    expect(app).toContain(call);
  }
  const onboarding = fs.readFileSync(path.join(__dirname, '..', 'screens', 'VenueOnboarding.js'), 'utf8');
  expect(onboarding).toContain("queueSync({ userMode: 'venue' });");
  expect(onboarding).toContain("queueSync({ userMode: 'user' });");
});
