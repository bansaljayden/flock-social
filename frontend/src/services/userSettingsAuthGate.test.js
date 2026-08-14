/**
 * services/userSettings.js must ask api.js whether anyone is signed in.
 *
 * Both of its guards used to be `localStorage.getItem('flockToken')` — a second,
 * silent copy of a contract api.js owns. api.js decides where the token lives,
 * and it CLEARS that key itself on a fatal auth failure, so a duplicate read is
 * a place where the two can disagree about whether there is a session: rename or
 * move the key and settings would go on POSTing for an account api.js had
 * already given up on, or stop syncing for one it had not.
 *
 * These tests pin the direction of the dependency rather than the spelling of a
 * line. `isLoggedIn` is mocked to DISAGREE with localStorage in both directions,
 * so a module that reads the key behind api.js's back fails no matter which way
 * it guesses.
 *
 * Run: cd frontend && CI=true npx react-scripts test --watchAll=false
 */

/* eslint-env jest */

const TOKEN_KEY = 'flockToken';

let api;
let settings;

function load({ loggedIn }) {
  jest.resetModules();
  jest.doMock('./api', () => ({
    __esModule: true,
    isLoggedIn: jest.fn(() => loggedIn),
    getUserSettings: jest.fn(async () => ({ settings: { theme: 'dark' } })),
    updateUserSettings: jest.fn(async () => ({})),
  }));
  // eslint-disable-next-line global-require
  api = require('./api');
  // eslint-disable-next-line global-require
  settings = require('./userSettings');
}

beforeEach(() => {
  jest.useFakeTimers();
  window.localStorage.clear();
});

afterEach(() => {
  jest.useRealTimers();
  jest.resetModules();
});

describe('pullSettings', () => {
  test('reads the server when api.js says there is a session, with no token in localStorage', async () => {
    load({ loggedIn: true });

    const result = await settings.pullSettings();

    expect(api.isLoggedIn).toHaveBeenCalled();
    expect(api.getUserSettings).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ theme: 'dark' });
  });

  test('does nothing when api.js says there is no session, even with a token still in localStorage', async () => {
    load({ loggedIn: false });
    window.localStorage.setItem(TOKEN_KEY, 'stale-token');

    const result = await settings.pullSettings();

    expect(result).toBeNull();
    expect(api.getUserSettings).not.toHaveBeenCalled();
  });
});

describe('queueSync', () => {
  test('pushes the debounced payload when api.js says there is a session', () => {
    load({ loggedIn: true });

    settings.queueSync({ theme: 'dark' });
    settings.queueSync({ mapType: 'satellite' });
    jest.advanceTimersByTime(600);

    // One request, not two: the whole point of the 600ms window.
    expect(api.updateUserSettings).toHaveBeenCalledTimes(1);
    expect(api.updateUserSettings).toHaveBeenCalledWith({ theme: 'dark', mapType: 'satellite' });
  });

  test('drops the payload when api.js says there is no session', () => {
    load({ loggedIn: false });
    window.localStorage.setItem(TOKEN_KEY, 'stale-token');

    settings.queueSync({ theme: 'dark' });
    jest.advanceTimersByTime(600);

    expect(api.updateUserSettings).not.toHaveBeenCalled();
  });
});
