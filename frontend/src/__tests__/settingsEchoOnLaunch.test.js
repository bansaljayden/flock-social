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
const { sameAsAccount, queueSync, queuedSincePull, pullSettings } = require('../services/userSettings');

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

describe('queuedSincePull', () => {
  // A change made while the pull is on the wire (a pin on a slow connection)
  // is newer on this device than the pull's answer.
  test('a key queued after the pull asked is newer here; one queued before is not', async () => {
    let answer;
    api.isLoggedIn.mockReturnValue(true);
    api.getUserSettings.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    queueSync({ flockOrder: [1] });
    await new Promise((r) => setTimeout(r, 5));
    const pulling = pullSettings();
    expect(queuedSincePull('flockOrder')).toBe(false);
    expect(queuedSincePull('pinnedFlockIds')).toBe(false);
    queueSync({ pinnedFlockIds: [7] });
    expect(queuedSincePull('pinnedFlockIds')).toBe(true);
    answer({ settings: { pinnedFlockIds: [], flockOrder: [1] } });
    await pulling;
  });
});

test('the listener records what it adopts, and all three effects ask before sending', () => {
  expect(app).toContain("const fresh = (key) => s[key] !== undefined && s[key] !== null && !queuedSincePull(key);");
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
