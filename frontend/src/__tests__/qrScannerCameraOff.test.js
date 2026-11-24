/**
 * The friend-code scanner's camera goes off whenever the scanner does (app
 * audit 2026-10-03, and the Add Friends rebuild of 2026-11-23). Starting it is
 * a fetched library and a camera prompt; Close, or leaving the screen, during
 * either used to find nothing to stop, and the camera came on afterwards
 * behind a closed screen. Each start and stop takes a session number, and a
 * start that lands late stops itself.
 *
 * The scanner is its own component now (components/QrScanner.js), mounted at
 * the app's root, so this runs the real component against a stand-in for
 * html5-qrcode and checks every way out: Close, unmount, Type the code
 * instead, a hidden page, a close made mid-start, and App.js closing it when
 * Add Friends is left. FRONTEND test (jest via react-scripts).
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false qrScannerCameraOff
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

const fs = require('fs');
const path = require('path');

// The stand-in library. Each start() is settled by the test, so a close can
// land while the camera is still coming up.
const lib = { instances: [], starts: [] };
jest.mock('html5-qrcode', () => {
  class FakeScanner {
    constructor(id, config) {
      this.id = id;
      this.config = config;
      this.running = false;
      this.stops = 0;
      lib.instances.push(this);
    }

    start(camera, config, onSuccess) {
      this.onSuccess = onSuccess;
      this.startConfig = config;
      return new Promise((resolve, reject) => {
        lib.starts.push({
          scanner: this,
          config,
          resolve: () => { this.running = true; resolve(null); },
          reject,
        });
      });
    }

    stop() {
      if (!this.running) return Promise.reject(new Error('Cannot stop, scanner is not running or paused.'));
      this.running = false;
      this.stops += 1;
      return Promise.resolve();
    }

    clear() {}
  }
  return { Html5Qrcode: FakeScanner, Html5QrcodeSupportedFormats: { QR_CODE: 0 } };
});

// eslint-disable-next-line import/first
import QrScanner, { QR_READER_ID } from '../components/QrScanner';

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

function mount(over = {}) {
  const props = {
    DialogBehavior: () => null,
    myFriendCode: 'FLOCK-KP5ETGZF',
    native: true,
    onAdd: jest.fn(() => Promise.resolve({ ok: true, message: 'Friend request sent to Casey' })),
    onClose: jest.fn(),
    onOpenSettings: jest.fn(),
    onTypeCode: jest.fn(),
    ...over,
  };
  const view = render(React.createElement(QrScanner, props));
  return { props, ...view };
}

const lastStart = () => lib.starts[lib.starts.length - 1];

beforeEach(() => {
  lib.instances.length = 0;
  lib.starts.length = 0;
  Object.defineProperty(window.navigator, 'mediaDevices', {
    value: { getUserMedia: jest.fn() },
    configurable: true,
  });
});

afterEach(() => {
  delete window.navigator.mediaDevices;
});

describe('the scanner reads QR codes only, on a box sized from the viewfinder', () => {
  test('one format, the system decoder where there is one, no mirrored retry, about 10 to 12 frames a second', async () => {
    mount();
    await flush();
    const [scanner] = lib.instances;
    expect(scanner.id).toBe(QR_READER_ID);
    expect(scanner.config.formatsToSupport).toEqual([0]);
    expect(scanner.config.useBarCodeDetectorIfSupported).toBe(true);
    const { config } = lastStart();
    expect(config.disableFlip).toBe(true);
    expect(config.fps).toBeGreaterThanOrEqual(10);
    expect(config.fps).toBeLessThanOrEqual(12);
    // Seventy percent of the viewfinder's shorter side, whichever it is.
    expect(config.qrbox(786, 1398)).toEqual({ width: 550, height: 550 });
    expect(config.qrbox(1280, 720)).toEqual({ width: 504, height: 504 });
    // A sharper stream is asked for, so the box has pixels to decode.
    expect(config.videoConstraints.width).toEqual({ ideal: 1280 });
  });

  test('the element the library draws into holds nothing React renders', async () => {
    mount();
    await flush();
    const el = document.getElementById(QR_READER_ID);
    expect(el).not.toBeNull();
    expect(el.children).toHaveLength(0);
  });
});

describe('the camera goes off on every way out', () => {
  test('Close stops a running camera', async () => {
    const { props } = mount();
    await flush();
    await act(async () => { lastStart().resolve(); });
    await flush();
    const [scanner] = lib.instances;
    expect(scanner.running).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close the scanner' }));
    await flush();
    expect(scanner.running).toBe(false);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  test('a close made while the camera is still coming up turns it off when it arrives', async () => {
    const { unmount } = mount();
    await flush();
    const pending = lastStart();
    // App.js unmounts the scanner on Close; the start has not landed yet.
    unmount();
    await act(async () => { pending.resolve(); });
    await flush();
    expect(pending.scanner.running).toBe(false);
    expect(pending.scanner.stops).toBe(1);
  });

  test('unmounting stops a running camera', async () => {
    const { unmount } = mount();
    await flush();
    await act(async () => { lastStart().resolve(); });
    await flush();
    const [scanner] = lib.instances;
    unmount();
    await flush();
    expect(scanner.running).toBe(false);
  });

  test('Type the code instead stops the camera and hands over to the code field', async () => {
    const { props } = mount();
    await flush();
    await act(async () => { lastStart().resolve(); });
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Type the code instead' }));
    await flush();
    expect(lib.instances[0].running).toBe(false);
    expect(props.onTypeCode).toHaveBeenCalledWith('asked');
  });

  test('a hidden page takes the camera, and coming back starts it again', async () => {
    mount();
    await flush();
    await act(async () => { lastStart().resolve(); });
    await flush();
    const first = lib.instances[0];
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
    expect(first.running).toBe(false);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
    expect(lib.starts.length).toBe(2);
  });

  test('a browser with no camera API goes straight to the code field', async () => {
    delete window.navigator.mediaDevices;
    const { props } = mount();
    await flush();
    expect(props.onTypeCode).toHaveBeenCalledWith('unsupported');
    expect(lib.instances).toHaveLength(0);
  });
});

describe('what a read does', () => {
  const live = async (over) => {
    const view = mount(over);
    await flush();
    await act(async () => { lastStart().resolve(); });
    await flush();
    return view;
  };

  test("a friend's link sends once, stops the camera and says the server's answer", async () => {
    jest.useFakeTimers();
    try {
      const { props } = await live();
      const scanner = lib.instances[0];
      await act(async () => { scanner.onSuccess('https://www.flockcorp.com/add/FLOCK-NJQXUGUM'); });
      // A second frame of the same code while the first is out sends nothing.
      await act(async () => { scanner.onSuccess('https://www.flockcorp.com/add/FLOCK-NJQXUGUM'); });
      await flush();
      expect(props.onAdd).toHaveBeenCalledTimes(1);
      expect(props.onAdd).toHaveBeenCalledWith('FLOCK-NJQXUGUM');
      expect(scanner.running).toBe(false);
      expect(screen.getByRole('status').textContent).toBe('Friend request sent to Casey');
      await act(async () => { jest.advanceTimersByTime(1300); });
      expect(props.onClose).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('the JSON older builds drew still reads', async () => {
    const { props } = await live();
    await act(async () => { lib.instances[0].onSuccess('{"type":"flock_friend","code":"FLOCK-JT3J9W98"}'); });
    await flush();
    expect(props.onAdd).toHaveBeenCalledWith('FLOCK-JT3J9W98');
  });

  test('something that is not a Flock code is said, and the camera keeps looking', async () => {
    const { props } = await live();
    await act(async () => { lib.instances[0].onSuccess('https://example.com/add/FLOCK-NJQXUGUM'); });
    expect(screen.getByRole('status').textContent).toBe("That isn't a Flock code.");
    expect(props.onAdd).not.toHaveBeenCalled();
    expect(lib.instances[0].running).toBe(true);
  });

  test('your own code is caught here, with no request', async () => {
    const { props } = await live();
    await act(async () => { lib.instances[0].onSuccess('https://www.flockcorp.com/add/FLOCK-KP5ETGZF'); });
    expect(screen.getByRole('status').textContent).toBe("That's your own code.");
    expect(props.onAdd).not.toHaveBeenCalled();
    expect(lib.instances[0].running).toBe(true);
  });

  test('a refusal stays open with the sentence and a way to scan again', async () => {
    const { props } = await live({ onAdd: jest.fn(() => Promise.resolve({ ok: false, message: 'No user found with this code' })) });
    await act(async () => { lib.instances[0].onSuccess('FLOCK-NJQXUGUM'); });
    await flush();
    expect(screen.getByRole('status').textContent).toBe('No user found with this code');
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Scan again' }));
    await flush();
    expect(lib.starts.length).toBe(2);
  });

  test('an unconfirmed email closes the scanner so the confirm sheet is not under it', async () => {
    const { props } = await live({ onAdd: jest.fn(() => Promise.resolve({ ok: false, close: true })) });
    await act(async () => { lib.instances[0].onSuccess('FLOCK-NJQXUGUM'); });
    await flush();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

describe('a camera that does not start says why, with somewhere to go', () => {
  test('refused inside the app: the sentence and Open Settings', async () => {
    const { props } = mount();
    await flush();
    await act(async () => { lastStart().reject('Error getting userMedia, error = NotAllowedError: Permission denied'); });
    await flush();
    expect(screen.getByRole('status').textContent).toBe("Flock can't use the camera.");
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  test('any other failure is tried once more, then says so with Try again', async () => {
    mount();
    await flush();
    await act(async () => { lastStart().reject(new Error('Could not start video source')); });
    await flush();
    // The second ask, for whatever the camera has.
    expect(lib.starts.length).toBe(2);
    await act(async () => { lastStart().reject(new Error('Could not start video source')); });
    await flush();
    expect(screen.getByRole('status').textContent).toBe("The camera didn't start.");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();
    expect(lib.starts.length).toBe(3);
  });
});

describe('App.js', () => {
  const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

  test('leaving Add Friends closes the scanner, and closing it is what turns the camera off', () => {
    expect(APP).toMatch(/useEffect\(\(\) => \{\s*if \(currentScreen !== 'addFriends'\) setQrScannerOpen\(false\);\s*\}, \[currentScreen\]\);/);
  });

  test('the scanner is mounted at the root, behind its own gate, never inside the screen', () => {
    expect(APP).toMatch(/\{qrScannerOpen && \(\s*<React\.Suspense fallback=\{<QrScannerLoading onClose=\{closeQrScanner\} \/>\}>\s*<QrScanner/);
    const screenSrc = fs.readFileSync(path.join(__dirname, '..', 'screens', 'AddFriends.js'), 'utf8');
    expect(screenSrc).not.toMatch(/new Html5Qrcode\(|import\(\s*['"]html5-qrcode['"]\s*\)/);
  });
});
