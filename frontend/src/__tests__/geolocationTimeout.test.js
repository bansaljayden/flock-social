/**
 * The native path must answer. That is the whole of this file.
 *
 * `timeout` is part of the geolocation API's contract and App.js has always
 * passed 10000, with a code-3 branch written for it. On the web the browser
 * enforces it. Across the Capacitor bridge nobody did: CoreLocation on a device
 * that cannot get a fix produces no fix, no error and no callback, so the
 * caller's error branch was unreachable and the user got a spinner with nothing
 * behind it. A Simulator with no location set reproduces it exactly, which is
 * how the demonstration recording found it (build 40).
 */

const NATIVE = {
  isNativePlatform: () => true,
};

/* The plugin is behind a dynamic import inside a native guard, so it is mocked
   rather than installed here: these tests are about what this module does with
   the plugin's answers and silences, not about the plugin. */
// `mock`-prefixed so jest's module factory is allowed to close over it.
let mockPluginBehaviour = () => new Promise(() => {});
jest.mock('@capacitor/geolocation', () => ({
  Geolocation: {
    getCurrentPosition: (...args) => mockPluginBehaviour(...args),
  },
}), { virtual: true });

/* The plugin arrives through a dynamic import, so every answer is at least
   three microtask turns behind the call. Draining the queue is what a real
   tick would do; a fixed number of awaits is a guess that changes with the
   module's internals. */
const flush = async () => {
  for (let i = 0; i < 25; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

describe('getCurrentPosition on a device', () => {
  let getCurrentPosition;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    window.Capacitor = NATIVE;
    // eslint-disable-next-line global-require
    ({ getCurrentPosition } = require('../services/geolocation'));
  });

  afterEach(() => {
    jest.useRealTimers();
    delete window.Capacitor;
  });

  test('a request that never answers fails with TIMEOUT, not silence', async () => {
    mockPluginBehaviour = () => new Promise(() => {});
    const onSuccess = jest.fn();
    const onError = jest.fn();

    getCurrentPosition(onSuccess, onError, { timeout: 10000 });
    await flush();
    expect(onError).not.toHaveBeenCalled();

    jest.advanceTimersByTime(10000);

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    // 3 is TIMEOUT, and the number is what matters: every call site branches on
    // err.code as a number to choose between "turn it on in Settings" and
    // "try again in a second".
    expect(onError.mock.calls[0][0].code).toBe(3);
  });

  test('a fix that arrives late does not overwrite the failure already reported', async () => {
    let resolvePlugin;
    mockPluginBehaviour = () => new Promise((resolve) => { resolvePlugin = resolve; });
    const onSuccess = jest.fn();
    const onError = jest.fn();

    getCurrentPosition(onSuccess, onError, { timeout: 10000 });
    await flush();
    jest.advanceTimersByTime(10000);
    expect(onError).toHaveBeenCalledTimes(1);

    resolvePlugin({ coords: { latitude: 39.9526, longitude: -75.1652 } });
    await flush();

    // The caller has already been told the request failed and has already acted
    // on it. A coordinate arriving afterwards is not an answer to a question
    // anyone is still asking.
    expect(onSuccess).not.toHaveBeenCalled();
  });

  test('a fix inside the window is delivered and cancels the timer', async () => {
    mockPluginBehaviour = () => Promise.resolve({ coords: { latitude: 1, longitude: 2 } });
    const onSuccess = jest.fn();
    const onError = jest.fn();

    getCurrentPosition(onSuccess, onError, { timeout: 10000 });
    await flush();

    expect(onSuccess).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(30000);
    expect(onError).not.toHaveBeenCalled();
  });

  test('no timeout asked for is no timeout imposed', async () => {
    mockPluginBehaviour = () => new Promise(() => {});
    const onSuccess = jest.fn();
    const onError = jest.fn();

    getCurrentPosition(onSuccess, onError, { enableHighAccuracy: true });
    await flush();
    jest.advanceTimersByTime(600000);

    // The web API waits forever with the option absent, and a caller that wants
    // to wait keeps that by passing nothing.
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
