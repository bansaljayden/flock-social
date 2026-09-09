/**
 * The recording rig's location seed, and the fence around it.
 *
 * services/geolocation.js answers a failed native read with a fixed coordinate
 * when REACT_APP_REVIEW_LOCATION is set at build time, because the Simulator
 * that Maestro launches never delivers one (builds 46 and 47 opened Discover
 * on "Could not get your location just now" with the grant and `simctl
 * location set` both in place; mobile-dev-inc/maestro#1458). Two things have
 * to stay true for that to be harmless:
 *
 *   1. Only the review-recording workflow sets the variable. The TestFlight
 *      workflow, Vercel and .env.example never mention it, so a production
 *      bundle compiles the seed to null and the banner behaves as before.
 *   2. A refused permission is never seeded. A missing grant films as the
 *      "Location is off" banner, which is what a take like that should show.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const CODEMAGIC = fs.readFileSync(path.join(ROOT, 'codemagic.yaml'), 'utf8');
const ENV_EXAMPLE = fs.readFileSync(path.join(ROOT, 'frontend', '.env.example'), 'utf8');

const NATIVE = { isNativePlatform: () => true };

let mockPluginBehaviour = () => new Promise(() => {});
jest.mock('@capacitor/geolocation', () => ({
  Geolocation: {
    getCurrentPosition: (...args) => mockPluginBehaviour(...args),
  },
}), { virtual: true });

const flush = async () => {
  for (let i = 0; i < 25; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

/* The workflow bodies, cut at the next top-level workflow key, so a line can
   be attributed to the workflow it lives in rather than to the file. */
function workflowBody(key) {
  const start = CODEMAGIC.indexOf(`\n  ${key}:`);
  expect(start).toBeGreaterThan(-1);
  const rest = CODEMAGIC.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z0-9-]+:\s*\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('where REACT_APP_REVIEW_LOCATION is set', () => {
  test('the review-recording workflow builds the web app with it', () => {
    const body = workflowBody('ios-review-recording');
    expect(body).toMatch(/REACT_APP_REVIEW_LOCATION=39\.9526,-75\.1652 npm run build/);
  });

  test('the TestFlight workflow does not', () => {
    const body = workflowBody('ios-capacitor');
    expect(body).not.toMatch(/REACT_APP_REVIEW_LOCATION/);
  });

  test('.env.example lists it EMPTY, with the warning, so nobody fills it in on Vercel', () => {
    // iosShellConfigMatchesCode.test.js requires every REACT_APP_* the source
    // reads to appear in .env.example, so the variable is documented there.
    // The fence is that the documented value is empty and the line above it
    // says which build sets it.
    expect(ENV_EXAMPLE).toMatch(/^REACT_APP_REVIEW_LOCATION=$/m);
    const at = ENV_EXAMPLE.indexOf('REACT_APP_REVIEW_LOCATION=');
    expect(ENV_EXAMPLE.slice(Math.max(0, at - 900), at)).toMatch(/recording/i);
  });
});

describe('getCurrentPosition on a device, with the seed compiled in', () => {
  let getCurrentPosition;
  const previous = process.env.REACT_APP_REVIEW_LOCATION;

  beforeEach(() => {
    process.env.REACT_APP_REVIEW_LOCATION = '39.9526,-75.1652';
    jest.resetModules();
    jest.useFakeTimers();
    window.Capacitor = NATIVE;
    // eslint-disable-next-line global-require
    ({ getCurrentPosition } = require('../services/geolocation'));
  });

  afterEach(() => {
    jest.useRealTimers();
    delete window.Capacitor;
    if (previous === undefined) delete process.env.REACT_APP_REVIEW_LOCATION;
    else process.env.REACT_APP_REVIEW_LOCATION = previous;
  });

  test('a timed-out read is answered with the seed, as a success', async () => {
    mockPluginBehaviour = () => new Promise(() => {});
    const onSuccess = jest.fn();
    const onError = jest.fn();

    getCurrentPosition(onSuccess, onError, { timeout: 10000 });
    await flush();
    jest.advanceTimersByTime(10000);

    expect(onError).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    const { coords } = onSuccess.mock.calls[0][0];
    expect(coords.latitude).toBeCloseTo(39.9526, 4);
    expect(coords.longitude).toBeCloseTo(-75.1652, 4);
  });

  test('a plugin failure that is not a refusal is answered with the seed', async () => {
    mockPluginBehaviour = () => Promise.reject({ code: 'OS-PLUG-GLOC-0002', message: 'Position unavailable' });
    const onSuccess = jest.fn();
    const onError = jest.fn();

    getCurrentPosition(onSuccess, onError, { timeout: 10000 });
    await flush();

    expect(onError).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess.mock.calls[0][0].coords.latitude).toBeCloseTo(39.9526, 4);
  });

  test('a refused permission is still a refusal', async () => {
    mockPluginBehaviour = () => Promise.reject({ code: 'OS-PLUG-GLOC-0003', message: 'Permission denied' });
    const onSuccess = jest.fn();
    const onError = jest.fn();

    getCurrentPosition(onSuccess, onError, { timeout: 10000 });
    await flush();

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].code).toBe(1);
  });

  test('a real fix still wins, and the seed never overwrites it', async () => {
    const real = { coords: { latitude: 40.0, longitude: -75.0 }, timestamp: 1 };
    mockPluginBehaviour = () => Promise.resolve(real);
    const onSuccess = jest.fn();
    const onError = jest.fn();

    getCurrentPosition(onSuccess, onError, { timeout: 10000 });
    await flush();
    jest.advanceTimersByTime(10000);

    expect(onError).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess.mock.calls[0][0].coords.latitude).toBe(40.0);
  });
});

describe('getCurrentPosition on a device, without the seed', () => {
  test('a timed-out read is still a TIMEOUT error', async () => {
    const previous = process.env.REACT_APP_REVIEW_LOCATION;
    delete process.env.REACT_APP_REVIEW_LOCATION;
    jest.resetModules();
    jest.useFakeTimers();
    window.Capacitor = NATIVE;
    // eslint-disable-next-line global-require
    const { getCurrentPosition } = require('../services/geolocation');
    mockPluginBehaviour = () => new Promise(() => {});
    const onSuccess = jest.fn();
    const onError = jest.fn();

    getCurrentPosition(onSuccess, onError, { timeout: 10000 });
    await flush();
    jest.advanceTimersByTime(10000);

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].code).toBe(3);

    jest.useRealTimers();
    delete window.Capacitor;
    if (previous !== undefined) process.env.REACT_APP_REVIEW_LOCATION = previous;
  });
});
