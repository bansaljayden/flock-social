/**
 * The recording rig's location seed, and the fence around it.
 *
 * services/geolocation.js answers a native read with a fixed coordinate, at
 * once and without asking the device, when REACT_APP_REVIEW_LOCATION is set at
 * build time. The Simulator that Maestro launches never delivers one (builds
 * 46 to 48 opened Discover on "Could not get your location just now" with the
 * grant and `simctl location set` both in place; build 50, which waited for
 * the read to fail before seeding, sat on "Finding where you are" instead;
 * mobile-dev-inc/maestro#1458). Two things have to stay true for the seed to
 * be harmless:
 *
 *   1. Only the review-recording workflow sets the variable. The TestFlight
 *      workflow and Vercel never do, and .env.example lists it empty under a
 *      warning, so a production bundle compiles the seed to null.
 *   2. Without the variable the module behaves exactly as before: a read that
 *      never answers is a TIMEOUT error, not a coordinate.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const CODEMAGIC = fs.readFileSync(path.join(ROOT, 'codemagic.yaml'), 'utf8');
const ENV_EXAMPLE = fs.readFileSync(path.join(ROOT, 'frontend', '.env.example'), 'utf8');

const NATIVE = { isNativePlatform: () => true };

let mockPluginBehaviour = () => new Promise(() => {});
let mockCalls = 0;
jest.mock('@capacitor/geolocation', () => ({
  Geolocation: {
    getCurrentPosition: (...args) => { mockCalls += 1; return mockPluginBehaviour(...args); },
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
    mockCalls = 0;
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

  test('the read is answered with the seed at once, and the device is never asked', async () => {
    mockPluginBehaviour = () => new Promise(() => {});
    const onSuccess = jest.fn();
    const onError = jest.fn();

    getCurrentPosition(onSuccess, onError, { timeout: 10000 });
    await flush();
    expect(onSuccess).not.toHaveBeenCalled();
    jest.advanceTimersByTime(300);

    expect(onError).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    const { coords } = onSuccess.mock.calls[0][0];
    expect(coords.latitude).toBeCloseTo(39.9526, 4);
    expect(coords.longitude).toBeCloseTo(-75.1652, 4);
    expect(mockCalls).toBe(0);
  });

  test('the caller\'s timeout never fires on top of the seed', async () => {
    mockPluginBehaviour = () => new Promise(() => {});
    const onSuccess = jest.fn();
    const onError = jest.fn();

    getCurrentPosition(onSuccess, onError, { timeout: 10000 });
    jest.advanceTimersByTime(300);
    await flush();
    jest.advanceTimersByTime(10000);

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
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
