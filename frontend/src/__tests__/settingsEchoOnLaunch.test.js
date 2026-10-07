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
const { sameAsAccount, queueSync, localIsNewer, pullSettings } = require('../services/userSettings');

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

describe('localIsNewer', () => {
  beforeEach(() => {
    jest.useRealTimers();
    api.isLoggedIn.mockReturnValue(true);
    api.updateUserSettings.mockImplementation(() => Promise.resolve({}));
  });

  // A change made while the pull is on the wire (a pin on a slow connection)
  // is newer on this device than the pull's answer.
  test('a key queued after the pull asked is newer here; one already sent before it asked is not', async () => {
    queueSync({ flockOrder: [1] });
    await new Promise((r) => setTimeout(r, 700)); // the debounce sends it
    let answer;
    api.getUserSettings.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const pulling = pullSettings();
    expect(localIsNewer('flockOrder')).toBe(false);
    expect(localIsNewer('safetyOn')).toBe(false);
    queueSync({ pinnedFlockIds: [7] });
    expect(localIsNewer('pinnedFlockIds')).toBe(true);
    answer({ settings: { pinnedFlockIds: [], flockOrder: [1] } });
    await pulling;
  });

  test('a key still waiting in the queue is newer here, whenever the pull asked', async () => {
    queueSync({ crowdAlerts: 'false' });
    api.getUserSettings.mockImplementation(() => Promise.resolve({ settings: { crowdAlerts: 'true' } }));
    await pullSettings(); // asks after the queueing, answers before the debounce
    expect(localIsNewer('crowdAlerts')).toBe(true);
    await new Promise((r) => setTimeout(r, 700));
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
  // values itself. When that push fails, the values must stay owed.
  test('a failed initial push leaves the values queued, so they are retried and not taken as held', async () => {
    localStorage.setItem('flock_interests', JSON.stringify(['Sports']));
    api.getUserSettings.mockImplementation(() => Promise.resolve({ settings: {} }));
    api.updateUserSettings.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('offline'), { isNetworkError: true })));
    await pullSettings();
    expect(localIsNewer('userInterests')).toBe(true);
    await new Promise((r) => setTimeout(r, 700));
    expect(api.updateUserSettings).toHaveBeenLastCalledWith(expect.objectContaining({ userInterests: ['Sports'] }));
    localStorage.removeItem('flock_interests');
  });
});

test('the listener records what it adopts, and all three effects ask before sending', () => {
  expect(app).toContain("const fresh = (key) => s[key] !== undefined && s[key] !== null && !localIsNewer(key);");
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
