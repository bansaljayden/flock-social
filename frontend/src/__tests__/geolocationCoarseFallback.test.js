/**
 * A precise fix that does not come is not the end of the request.
 *
 * Every caller asks for high accuracy with a ten-second window. Indoors, on a
 * granted device, that can time out or come back unavailable while a coarse
 * fix (cell, Wi-Fi, the one from a few minutes ago) is there for the asking.
 * What a person saw was "Could not get your location just now. Try again",
 * again and again, with the permission fine the whole time and no prompt to
 * answer because it had been answered at install. So the native path tries
 * once more at low accuracy before the caller hears a failure. A refused
 * permission is not retried: the answer would not change and the code-1 words
 * are the right ones.
 */
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

describe('a precise request that fails is retried once, coarsely', () => {
  let getCurrentPosition;
  let COARSE_RETRY;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    window.Capacitor = NATIVE;
    // eslint-disable-next-line global-require
    ({ getCurrentPosition, COARSE_RETRY } = require('../services/geolocation'));
  });

  afterEach(() => {
    jest.useRealTimers();
    delete window.Capacitor;
  });

  test('a precise timeout is followed by one low-accuracy attempt whose fix is delivered', async () => {
    const calls = [];
    mockPluginBehaviour = (opts) => {
      calls.push(opts);
      if (opts.enableHighAccuracy) return new Promise(() => {});
      return Promise.resolve({ coords: { latitude: 40.6, longitude: -75.3 } });
    };
    const onSuccess = jest.fn();
    const onError = jest.fn();

    getCurrentPosition(onSuccess, onError, { enableHighAccuracy: true, timeout: 10000 });
    await flush();
    jest.advanceTimersByTime(10000);
    await flush();

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(COARSE_RETRY);
    expect(calls[1].enableHighAccuracy).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess.mock.calls[0][0].coords.latitude).toBe(40.6);
  });

  test('a precise "position unavailable" from the plugin is retried the same way', async () => {
    const calls = [];
    mockPluginBehaviour = (opts) => {
      calls.push(opts);
      if (opts.enableHighAccuracy) return Promise.reject({ code: 'OS-PLUG-GLOC-0002', message: 'Position unavailable' });
      return Promise.resolve({ coords: { latitude: 1, longitude: 2 } });
    };
    const onSuccess = jest.fn();
    const onError = jest.fn();

    getCurrentPosition(onSuccess, onError, { enableHighAccuracy: true, timeout: 10000 });
    await flush();

    expect(calls).toHaveLength(2);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  test('when the coarse attempt fails too, the caller hears exactly one failure', async () => {
    const calls = [];
    mockPluginBehaviour = (opts) => {
      calls.push(opts);
      return new Promise(() => {});
    };
    const onSuccess = jest.fn();
    const onError = jest.fn();

    getCurrentPosition(onSuccess, onError, { enableHighAccuracy: true, timeout: 10000 });
    await flush();
    jest.advanceTimersByTime(10000);
    await flush();
    expect(onError).not.toHaveBeenCalled();
    jest.advanceTimersByTime(COARSE_RETRY.timeout);
    await flush();

    expect(calls).toHaveLength(2);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].code).toBe(3);
    // The failure says which attempt decided it and that the retry ran, so a
    // report from a device can tell this apart from a first-attempt refusal.
    expect(onError.mock.calls[0][0].detail).toBe('client-timer');
    expect(onError.mock.calls[0][0].retried).toBe(true);
  });

  test('a refused permission is not retried and reaches the caller as code 1', async () => {
    const calls = [];
    mockPluginBehaviour = (opts) => {
      calls.push(opts);
      return Promise.reject({ code: 'OS-PLUG-GLOC-0003', message: 'Location permission was denied' });
    };
    const onSuccess = jest.fn();
    const onError = jest.fn();

    getCurrentPosition(onSuccess, onError, { enableHighAccuracy: true, timeout: 10000 });
    await flush();

    expect(calls).toHaveLength(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].code).toBe(1);
    expect(onError.mock.calls[0][0].detail).toBe('OS-PLUG-GLOC-0003');
    expect(onError.mock.calls[0][0].retried).toBe(false);
  });

  test('a request that did not ask for precision is not retried', async () => {
    const calls = [];
    mockPluginBehaviour = (opts) => {
      calls.push(opts);
      return new Promise(() => {});
    };
    const onSuccess = jest.fn();
    const onError = jest.fn();

    getCurrentPosition(onSuccess, onError, { timeout: 10000 });
    await flush();
    jest.advanceTimersByTime(10000);
    await flush();

    expect(calls).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].code).toBe(3);
  });
});
