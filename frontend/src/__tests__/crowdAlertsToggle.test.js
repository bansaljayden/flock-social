/**
 * CROWD ALERTS OPT-OUT — the client half of the pre-peak push switch.
 *
 * The backend half (backend/services/pushHelper.js wantsCrowdAlerts, enforced
 * again at the deliver() chokepoint) already reads user_settings.settings
 * .crowdAlerts with ABSENT = ON. Until this drop the client had no way to
 * write that key, so a user could not opt out at all. What shipped:
 *
 *   1. ONE ROW on the settings screen, inside the Push Notifications card:
 *      label exactly "Crowd alerts" plus one quiet line of description. It
 *      controls only the pre-peak crowd push, so it is labeled that narrowly.
 *
 *   2. SYNC through the existing userSettings pipeline: flipping the switch
 *      writes localStorage 'flock_crowd_alerts' and queueSync({ crowdAlerts }),
 *      exactly the safetyOn pattern ('true'/'false' strings, the key is never
 *      removed once written).
 *
 *   3. THE String() LANDMINE, handled. pullSettings stores every synced value
 *      through String(value), so a server-side false lands in localStorage as
 *      the STRING 'false' — which is truthy. Every reader here compares
 *      against the string ( !== 'false' ), never truthiness. The tests below
 *      execute the actual initializer expression from App.js against a store
 *      containing 'false' and require it to come up OFF.
 *
 * Source-scanning for the App.js facts (same reason as every other App.js
 * suite: each fact is a call-site choice in a 16,500-line monolith), plus
 * behavioral tests through the real pullSettings.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

import { pullSettings } from '../services/userSettings';

const fs = require('fs');
const path = require('path');

// The crowd-alerts settings row lives on the profile and settings screen (the
// You tab), which left App.js on 2026-08-27 for screens/ProfileSettings.js. The
// crowdAlertsOn initializer this suite compiles and runs stayed in App.js, so
// both files are read: the initializer resolves in the first, the row in the
// second.
const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'ProfileSettings.js'), 'utf8');
const SETTINGS = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'userSettings.js'),
  'utf8'
);

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** The REAL initializer expression from App.js, compiled and run against the
 *  real (jsdom) localStorage — so these tests fail if the comparison in the
 *  shipped source regresses to truthiness, not just if a pinned string moves. */
function initialToggleValue() {
  const m = APP.match(/const \[crowdAlertsOn, setCrowdAlertsOn\] = useState\(\(\) => (.*?)\);/);
  expect(m).not.toBeNull();
  // eslint-disable-next-line no-new-func
  return new Function('localStorage', `return (${m[1]});`)(window.localStorage);
}

beforeEach(() => {
  global.fetch = jest.fn();
  localStorage.clear();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. The row on the settings screen
// ═══════════════════════════════════════════════════════════════════════════

describe('the settings row', () => {
  it('is a Toggle labeled exactly "Crowd alerts", wired to the crowd-alerts state', () => {
    expect(APP).toContain(
      '<Toggle label="Crowd alerts" on={crowdAlertsOn} onChange={() => setCrowdAlertsEnabled(!crowdAlertsOn)} />'
    );
  });

  it('carries one plain line of description under the label', () => {
    expect(APP).toContain("A heads up before your flock's venue gets busy");
  });

  it('lives inside the Push Notifications card, after the permission row', () => {
    const cardAt = APP.indexOf('Push Notifications</span>');
    const rowAt = APP.indexOf('<Toggle label="Crowd alerts"');
    const nextCardAt = APP.indexOf('Flock Pro</span>');
    expect(cardAt).toBeGreaterThan(-1);
    expect(rowAt).toBeGreaterThan(cardAt);
    expect(nextCardAt).toBeGreaterThan(rowAt);
  });

  it('label and description claim nothing broader than crowd alerts, with no em dash', () => {
    const start = APP.indexOf('Crowd alerts</span>');
    expect(start).toBeGreaterThan(-1);
    const row = APP.slice(start, APP.indexOf('</div>', APP.indexOf('<Toggle label="Crowd alerts"')));
    expect(row).not.toContain('—');
    // The switch controls one push type; a broad label would promise more
    // than it ships.
    expect(row).not.toContain('Notifications');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The String('false') landmine
// ═══════════════════════════════════════════════════════════════════════════

describe('the "false"-string landmine', () => {
  it('the initializer compares against the string, never truthiness', () => {
    expect(APP).toContain(
      "useState(() => localStorage.getItem('flock_crowd_alerts') !== 'false')"
    );
  });

  it("a settings store containing the STRING 'false' initializes the toggle OFF", () => {
    // This is the exact round-trip: pullSettings writes String(false), and
    // 'false' is truthy, so a truthiness reader would show the switch ON for
    // a user who turned it off.
    localStorage.setItem('flock_crowd_alerts', 'false');
    expect(initialToggleValue()).toBe(false);
  });

  it('an ABSENT key initializes the toggle ON, matching the backend default', () => {
    expect(localStorage.getItem('flock_crowd_alerts')).toBeNull();
    expect(initialToggleValue()).toBe(true);
  });

  it("the STRING 'true' initializes the toggle ON", () => {
    localStorage.setItem('flock_crowd_alerts', 'true');
    expect(initialToggleValue()).toBe(true);
  });

  it("the settings-loaded adoption compares String(s.crowdAlerts) !== 'false'", () => {
    // Second reader, same rule: a pull on another device broadcasts the raw
    // server value (boolean OR string) through flock-settings-loaded.
    expect(APP).toContain("String(s.crowdAlerts) !== 'false'");
    expect(APP).toContain('setCrowdAlertsOn(on);');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Cross-device sync through userSettings
// ═══════════════════════════════════════════════════════════════════════════

describe('sync wiring', () => {
  it('crowdAlerts is a registered synced key mapped to flock_crowd_alerts', () => {
    expect(SETTINGS).toContain("crowdAlerts: 'flock_crowd_alerts',");
  });

  it('flipping the switch writes localStorage and queues the sync, house pattern', () => {
    // Same shape as setSafetyEnabled: explicit 'true'/'false' strings both
    // directions; toggling back ON writes 'true' rather than removing the key.
    expect(APP).toContain("localStorage.setItem('flock_crowd_alerts', on ? 'true' : 'false');");
    expect(APP).toContain("queueSync({ crowdAlerts: on ? 'true' : 'false' });");
  });

  it('a server-side false lands locally as the string the readers expect, and reads OFF', async () => {
    localStorage.setItem('flockToken', 't');
    global.fetch.mockResolvedValue(jsonRes({
      settings: { crowdAlerts: false }, // opted out on another device
    }));
    const settings = await pullSettings();
    expect(settings).not.toBeNull();
    expect(localStorage.getItem('flock_crowd_alerts')).toBe('false');
    // ...and the App.js initializer reads that store as OFF.
    expect(initialToggleValue()).toBe(false);
  });

  it('a first-time sync pushes a local opt-out up to the account', async () => {
    localStorage.setItem('flockToken', 't');
    localStorage.setItem('flock_crowd_alerts', 'false');
    global.fetch
      .mockResolvedValueOnce(jsonRes({ settings: {} })) // GET: server empty
      .mockResolvedValueOnce(jsonRes({ settings: {} })); // PATCH echo
    await pullSettings();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const [, patchOpts] = global.fetch.mock.calls[1];
    expect(patchOpts.method).toBe('PATCH');
    // 'false' is one of backend wantsCrowdAlerts' OFF_VALUES, so this exact
    // string is enough to stop the push server-side.
    expect(JSON.parse(patchOpts.body).crowdAlerts).toBe('false');
  });
});
