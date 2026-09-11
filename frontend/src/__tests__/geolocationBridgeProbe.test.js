/**
 * The bridge is asked a question before it is asked for a fix.
 *
 * On a device the plugin can fail to answer at all: not a denial, not a
 * timeout from CoreLocation, but a call that never reaches native
 * (ionic-team/capacitor-plugins#2525, iOS 26). From the user's side that is
 * no permission sheet, a spinner, and "Could not get your location just now"
 * on every try, with the permission granted the whole time. So every request
 * opens with checkPermissions, which has no side effect, and what comes back
 * decides the path:
 *
 *   silence   the bridge is not delivering; WebKit's own API gets the request,
 *             and every later one, until the plugin answers something
 *   denied    code 1 at once, no request spent
 *   prompt    the request will raise the system sheet, so the clock on it is
 *             PROMPT_WINDOW rather than the ten seconds a person cannot read
 *             a sheet inside
 *   granted   the ordinary attempt, with the coarse retry behind it
 */
const NATIVE = { isNativePlatform: () => true };

let mockProbe = () => Promise.resolve({ location: 'granted', coarseLocation: 'granted' });
let mockPluginBehaviour = () => new Promise(() => {});
jest.mock('@capacitor/geolocation', () => ({
  Geolocation: {
    checkPermissions: (...args) => mockProbe(...args),
    getCurrentPosition: (...args) => mockPluginBehaviour(...args),
  },
}), { virtual: true });

const flush = async () => {
  for (let i = 0; i < 25; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('the bridge probe', () => {
  let geo;
  let web;
  let PROBE_WINDOW;
  let PROMPT_WINDOW;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    window.Capacitor = NATIVE;
    web = {
      getCurrentPosition: jest.fn(),
      watchPosition: jest.fn(() => 7),
      clearWatch: jest.fn(),
    };
    Object.defineProperty(window.navigator, 'geolocation', { value: web, configurable: true });
    mockProbe = () => Promise.resolve({ location: 'granted', coarseLocation: 'granted' });
    mockPluginBehaviour = jest.fn(() => new Promise(() => {}));
    // eslint-disable-next-line global-require
    geo = require('../services/geolocation');
    ({ PROBE_WINDOW, PROMPT_WINDOW } = geo);
  });

  afterEach(() => {
    jest.useRealTimers();
    delete window.Capacitor;
    delete window.navigator.geolocation;
  });

  test('a silent bridge hands the request to WebKit with the same options', async () => {
    mockProbe = () => new Promise(() => {});
    const onSuccess = jest.fn();
    const onError = jest.fn();
    const options = { enableHighAccuracy: true, timeout: 10000 };
    web.getCurrentPosition.mockImplementation((ok) => ok({ coords: { latitude: 39.95, longitude: -75.16 } }));

    geo.getCurrentPosition(onSuccess, onError, options);
    await flush();
    jest.advanceTimersByTime(PROBE_WINDOW - 1);
    await flush();
    expect(web.getCurrentPosition).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await flush();

    expect(mockPluginBehaviour).not.toHaveBeenCalled();
    expect(web.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(web.getCurrentPosition.mock.calls[0][2]).toBe(options);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess.mock.calls[0][0].coords.latitude).toBe(39.95);
    expect(onError).not.toHaveBeenCalled();
  });

  test('a WebKit failure on that path says where it came from', async () => {
    mockProbe = () => new Promise(() => {});
    web.getCurrentPosition.mockImplementation((ok, err) => err({ code: 1, message: 'User denied Geolocation' }));
    const onError = jest.fn();

    geo.getCurrentPosition(jest.fn(), onError, { enableHighAccuracy: true, timeout: 10000 });
    await flush();
    jest.advanceTimersByTime(PROBE_WINDOW);
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].code).toBe(1);
    expect(onError.mock.calls[0][0].detail).toBe('webkit/bridge-silent');
  });

  test('once judged silent, the next request goes to WebKit without waiting again', async () => {
    mockProbe = () => new Promise(() => {});
    geo.getCurrentPosition(jest.fn(), jest.fn(), { timeout: 10000 });
    await flush();
    jest.advanceTimersByTime(PROBE_WINDOW);
    await flush();
    expect(web.getCurrentPosition).toHaveBeenCalledTimes(1);

    geo.getCurrentPosition(jest.fn(), jest.fn(), { timeout: 10000 });
    await flush();
    expect(web.getCurrentPosition).toHaveBeenCalledTimes(2);
    expect(mockPluginBehaviour).not.toHaveBeenCalled();
  });

  test('a late answer from the plugin restores it for the requests after', async () => {
    const late = deferred();
    mockProbe = () => late.promise;
    geo.getCurrentPosition(jest.fn(), jest.fn(), { timeout: 10000 });
    await flush();
    jest.advanceTimersByTime(PROBE_WINDOW);
    await flush();
    expect(web.getCurrentPosition).toHaveBeenCalledTimes(1);

    late.resolve({ location: 'granted', coarseLocation: 'granted' });
    await flush();
    mockProbe = () => Promise.resolve({ location: 'granted', coarseLocation: 'granted' });
    geo.getCurrentPosition(jest.fn(), jest.fn(), { timeout: 10000 });
    await flush();

    expect(web.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(mockPluginBehaviour).toHaveBeenCalledTimes(1);
  });

  test('a denied answer is code 1 at once, and no request is spent', async () => {
    mockProbe = () => Promise.resolve({ location: 'denied', coarseLocation: 'denied' });
    const onError = jest.fn();

    geo.getCurrentPosition(jest.fn(), onError, { enableHighAccuracy: true, timeout: 10000 });
    await flush();

    expect(mockPluginBehaviour).not.toHaveBeenCalled();
    expect(web.getCurrentPosition).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].code).toBe(1);
    expect(onError.mock.calls[0][0].detail).toBe('probe-denied');
  });

  test('Location Services off device-wide (0007) is code 1 with the plugin code kept', async () => {
    mockProbe = () => Promise.reject({ code: 'OS-PLUG-GLOC-0007', message: 'Location services are disabled' });
    const onError = jest.fn();

    geo.getCurrentPosition(jest.fn(), onError, { enableHighAccuracy: true, timeout: 10000 });
    await flush();

    expect(mockPluginBehaviour).not.toHaveBeenCalled();
    expect(onError.mock.calls[0][0].code).toBe(1);
    expect(onError.mock.calls[0][0].detail).toBe('OS-PLUG-GLOC-0007');
  });

  test('while the system sheet is up, the ten-second clock does not run', async () => {
    mockProbe = () => Promise.resolve({ location: 'prompt', coarseLocation: 'prompt' });
    const answered = deferred();
    mockPluginBehaviour = jest.fn(() => answered.promise);
    const onSuccess = jest.fn();
    const onError = jest.fn();

    geo.getCurrentPosition(onSuccess, onError, { enableHighAccuracy: true, timeout: 10000 });
    await flush();
    // The plugin still receives the caller's timeout: that is its own timer,
    // which starts after the grant.
    expect(mockPluginBehaviour).toHaveBeenCalledTimes(1);
    expect(mockPluginBehaviour.mock.calls[0][0].timeout).toBe(10000);

    jest.advanceTimersByTime(45000);
    await flush();
    expect(onError).not.toHaveBeenCalled();

    answered.resolve({ coords: { latitude: 1, longitude: 2 } });
    await flush();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  test('a sheet nobody answers inside PROMPT_WINDOW fails once, and is not retried', async () => {
    mockProbe = () => Promise.resolve({ location: 'prompt', coarseLocation: 'prompt' });
    const onError = jest.fn();

    geo.getCurrentPosition(jest.fn(), onError, { enableHighAccuracy: true, timeout: 10000 });
    await flush();
    jest.advanceTimersByTime(PROMPT_WINDOW);
    await flush();

    expect(mockPluginBehaviour).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].code).toBe(3);
    expect(onError.mock.calls[0][0].detail).toBe('prompt-timer');
    expect(onError.mock.calls[0][0].retried).toBe(false);
  });

  test('a sheet answered with Deny reaches the caller as code 1', async () => {
    mockProbe = () => Promise.resolve({ location: 'prompt', coarseLocation: 'prompt' });
    mockPluginBehaviour = jest.fn(() => Promise.reject({ code: 'OS-PLUG-GLOC-0003', message: 'Location permission was denied' }));
    const onError = jest.fn();

    geo.getCurrentPosition(jest.fn(), onError, { enableHighAccuracy: true, timeout: 10000 });
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].code).toBe(1);
    expect(onError.mock.calls[0][0].detail).toBe('OS-PLUG-GLOC-0003');
  });

  test('granted after the sheet, then a precise timeout, still gets the coarse retry', async () => {
    mockProbe = () => Promise.resolve({ location: 'prompt', coarseLocation: 'prompt' });
    const calls = [];
    mockPluginBehaviour = jest.fn((opts) => {
      calls.push(opts);
      if (opts.enableHighAccuracy) return Promise.reject({ code: 'OS-PLUG-GLOC-0010', message: 'Timeout' });
      return Promise.resolve({ coords: { latitude: 3, longitude: 4 } });
    });
    const onSuccess = jest.fn();

    geo.getCurrentPosition(onSuccess, jest.fn(), { enableHighAccuracy: true, timeout: 10000 });
    await flush();

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(geo.COARSE_RETRY);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  test('a silent bridge sends watchPosition to WebKit as well, and clearWatch takes the number back', async () => {
    mockProbe = () => new Promise(() => {});
    geo.getCurrentPosition(jest.fn(), jest.fn(), { timeout: 10000 });
    await flush();
    jest.advanceTimersByTime(PROBE_WINDOW);
    await flush();

    const id = geo.watchPosition(jest.fn(), jest.fn(), { enableHighAccuracy: true });
    expect(web.watchPosition).toHaveBeenCalledTimes(1);
    expect(id).toBe(7);
    geo.clearWatch(id);
    expect(web.clearWatch).toHaveBeenCalledWith(7);
  });
});

describe('the plugin chunk that did not load', () => {
  let geo;
  let web;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    window.Capacitor = NATIVE;
    web = { getCurrentPosition: jest.fn(), watchPosition: jest.fn(() => 9), clearWatch: jest.fn() };
    Object.defineProperty(window.navigator, 'geolocation', { value: web, configurable: true });
    jest.doMock('@capacitor/geolocation', () => { throw new Error('chunk failed'); }, { virtual: true });
    // eslint-disable-next-line global-require
    geo = require('../services/geolocation');
  });

  afterEach(() => {
    jest.useRealTimers();
    delete window.Capacitor;
    delete window.navigator.geolocation;
  });

  test('getCurrentPosition falls back to WebKit and says so on failure', async () => {
    web.getCurrentPosition.mockImplementation((ok, err) => err({ code: 2, message: 'unavailable' }));
    const onError = jest.fn();

    geo.getCurrentPosition(jest.fn(), onError, { enableHighAccuracy: true, timeout: 10000 });
    await flush();

    expect(web.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].code).toBe(2);
    expect(onError.mock.calls[0][0].detail).toBe('webkit/no-plugin');
  });

  test('watchPosition falls back to WebKit and the handle still clears it', async () => {
    const handle = geo.watchPosition(jest.fn(), jest.fn(), {});
    await flush();

    expect(web.watchPosition).toHaveBeenCalledTimes(1);
    geo.clearWatch(handle);
    expect(web.clearWatch).toHaveBeenCalledWith(9);
  });
});
