/**
 * A TAB LEFT OPEN ACROSS A DEPLOY, AND THE ONE RELOAD THAT GETS IT PAST A CHUNK
 * THE SITE NO LONGER HAS.
 *
 * Every build names its scripts by their contents, and Cloudflare Pages serves
 * one deployment at a time. A tab still running an earlier build can ask for a
 * lazy chunk the site no longer has, and "Try again" on the crash card asks for
 * that same missing file for as long as the tab lives. The deploy keeps earlier
 * builds' files for 30 days (assetHistory.test.js); lib/staleBuild.js is for
 * the tabs that outlive that. Pinned here:
 *
 *   1. the two names that are compared: the main bundle this page runs, read
 *      off its script tags, and the one the site serves now, read off
 *      /asset-manifest.json;
 *   2. the site is asked about the file that failed FIRST, so a download that
 *      died on a weak connection is never reloaded: only a file the site says
 *      it does not have goes on to the manifest;
 *   3. one reload for each build a tab has run, with the note written and read
 *      back before the reload is asked for, and no reload at all in a browser
 *      that will not keep the note;
 *   4. the apps, a dev server and an error that names no file ask the network
 *      nothing;
 *   5. the crash net (components/ErrorBoundary.js) runs it for a chunk error
 *      and nothing else, does not reload somebody who has left the broken
 *      screen, and tells its cards when the reload is theirs to offer;
 *   6. App.js's two screen cards make Reload the button then.
 *
 * The crash-net tests run the real helper against jsdom's own document and
 * sessionStorage and a stand-in for the site, so what is tested is the two
 * files together.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern staleBuild
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import ErrorBoundary, { CHUNK_ERROR_TITLE } from '../components/ErrorBoundary';
import {
  runningMain, liveMain, failedFileState, healStaleBuild, RELOADED_FROM_KEY, NEWER_BUILD_NOTE,
} from '../lib/staleBuild';

const fs = require('fs');
const path = require('path');

const mockShell = { native: false };
jest.mock('../lib/nativeShell', () => ({
  ...jest.requireActual('../lib/nativeShell'),
  isNativeShell: () => mockShell.native,
}));

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');

const RUNNING = 'main.aaaaaaaa.js';
const LIVE = 'main.bbbbbbbb.js';
// jsdom's page is http://localhost/, so this is one of "this site's" files.
const CHUNK_URL = 'http://localhost/static/js/8970.157081c6.chunk.js';
const MANIFEST_URL = '/asset-manifest.json';

// What Cloudflare Pages answered on 2026-11-11 for a chunk it does not have,
// and for one it has.
const GONE = { status: 404, type: 'text/html; charset=utf-8' };
const THERE = { status: 200, type: 'application/javascript' };

// The error webpack rejects a lazy import with: its runtime leaves the address
// it asked for on `request`.
const chunkError = (request = CHUNK_URL) => Object.assign(
  new Error(`Loading chunk 8970 failed.\n(missing: ${request})`),
  { name: 'ChunkLoadError', type: 'missing', request },
);

// A page's script tags, as much of them as the helper reads.
const docWith = (...scripts) => ({
  scripts: scripts.map(({ src = '', dataMain = null }) => ({
    src,
    getAttribute: (name) => (name === 'data-main' ? dataMain : null),
  })),
});
const RUNNING_DOC = docWith({ src: `http://localhost/static/js/${RUNNING}` });

const manifestFor = (main) => ({ files: { 'main.js': `/static/js/${main}`, 'index.html': '/index.html' } });

// A stand-in for the site. `file` is its answer about the chunk, `manifest`
// the body of /asset-manifest.json (null: not there, an Error: no answer), and
// `until` holds the first answer back until the test lets it go.
function site({ file = GONE, manifest = manifestFor(LIVE), until = null } = {}) {
  const calls = [];
  const fetchImpl = jest.fn(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', cache: init.cache, signal: init.signal });
    if (until) await until;
    if (String(url).endsWith(MANIFEST_URL)) {
      if (manifest instanceof Error) throw manifest;
      if (manifest === null) return { ok: false, status: 404, json: async () => { throw new SyntaxError('Unexpected token <'); } };
      return { ok: true, status: 200, json: async () => manifest };
    }
    if (file instanceof Error) throw file;
    return {
      ok: file.status >= 200 && file.status < 300,
      status: file.status,
      headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? (file.type || null) : null) },
    };
  });
  return { fetchImpl, calls };
}

// A request that never answers on its own and gives up when its signal says so,
// which is what the browser's fetch does.
const neverAnswers = () => jest.fn((url, init) => new Promise((resolve, reject) => {
  init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
}));

function memoryStore(kept = {}) {
  const store = { ...kept };
  return {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
  };
}

const gate = () => {
  let open;
  const until = new Promise((resolve) => { open = resolve; });
  return { until, open };
};

// Long enough for every answer the stand-in has given to be read.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  mockShell.native = false;
});

describe('the main bundle this page is running', () => {
  test('is read off the script tag', () => {
    expect(runningMain(RUNNING_DOC)).toBe(RUNNING);
    expect(runningMain(docWith(
      { src: 'https://www.flockcorp.com/static/js/453.0a1b2c3d.chunk.js' },
      { src: 'https://www.flockcorp.com/static/js/main.92be2bec.js' },
    ))).toBe('main.92be2bec.js');
  });

  test('is read off data-main on a prerendered page, whose tag is the paint-first loader', () => {
    expect(runningMain(docWith({
      src: 'https://www.flockcorp.com/static/js/paint-first.1f2e3d4c.js',
      dataMain: '/static/js/main.a7f2e0c7.js',
    }))).toBe('main.a7f2e0c7.js');
  });

  test('has no name on a dev server, on a page with no scripts, or from anything that is not the bundle itself', () => {
    expect(runningMain(docWith({ src: 'http://localhost:3000/static/js/bundle.js' }))).toBeNull();
    expect(runningMain(docWith())).toBeNull();
    expect(runningMain(null)).toBeNull();
    // A source map and a chunk carry "main" or a hash without being the bundle.
    expect(runningMain(docWith({ src: 'https://www.flockcorp.com/static/js/main.a7f2e0c7.js.map' }))).toBeNull();
    expect(runningMain(docWith({ src: 'https://www.flockcorp.com/static/js/main.a7f2e0c7.chunk.js' }))).toBeNull();
    expect(runningMain(docWith({ src: 'https://www.flockcorp.com/static/css/main.a7f2e0c7.css' }))).toBeNull();
    // jsdom's own document, which is what every other test file renders into.
    expect(runningMain()).toBeNull();
  });

  test('a document that throws is no name, not a crash inside the crash net', () => {
    const hostile = { get scripts() { throw new Error('no'); } };
    expect(runningMain(hostile)).toBeNull();
  });
});

describe('the main bundle the site serves now', () => {
  test('is read off the manifest, asked for past every cache', async () => {
    const { fetchImpl, calls } = site();
    await expect(liveMain({ fetchImpl })).resolves.toBe(LIVE);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: MANIFEST_URL, method: 'GET', cache: 'no-store' });
  });

  test('anything that is not the manifest is no answer', async () => {
    await expect(liveMain({ fetchImpl: site({ manifest: null }).fetchImpl })).resolves.toBeNull();
    await expect(liveMain({ fetchImpl: site({ manifest: new TypeError('Failed to fetch') }).fetchImpl })).resolves.toBeNull();
    await expect(liveMain({ fetchImpl: site({ manifest: {} }).fetchImpl })).resolves.toBeNull();
    await expect(liveMain({ fetchImpl: site({ manifest: { files: {} } }).fetchImpl })).resolves.toBeNull();
    await expect(liveMain({ fetchImpl: site({ manifest: { files: { 'main.js': '/static/js/bundle.js' } } }).fetchImpl })).resolves.toBeNull();
    // A sign-in page a hotel network answers every address with: 200, not JSON.
    const portal = jest.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
    await expect(liveMain({ fetchImpl: portal })).resolves.toBeNull();
    // An error is not the manifest even when its body would parse as one.
    const failing = jest.fn(async () => ({ ok: false, status: 503, json: async () => manifestFor(LIVE) }));
    await expect(liveMain({ fetchImpl: failing })).resolves.toBeNull();
    // A fetch that throws where it should have returned a promise.
    await expect(liveMain({ fetchImpl: () => { throw new Error('blocked'); } })).resolves.toBeNull();
    await expect(liveMain({ fetchImpl: null })).resolves.toBeNull();
  });

  test('an answer that never comes is given up on at the deadline', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = neverAnswers();
      let answer = 'pending';
      liveMain({ fetchImpl, timeoutMs: 5000 }).then((name) => { answer = name; });
      jest.advanceTimersByTime(4999);
      await Promise.resolve();
      expect(answer).toBe('pending');
      jest.advanceTimersByTime(1);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      expect(answer).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test('the deadline covers reading the answer, not only waiting for its first line', async () => {
    jest.useFakeTimers();
    try {
      // Headers at once, a body that stalls until the signal gives up on it.
      const fetchImpl = jest.fn(async (url, init) => ({
        ok: true,
        status: 200,
        json: () => new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
      }));
      let answer = 'pending';
      liveMain({ fetchImpl, timeoutMs: 5000 }).then((name) => { answer = name; });
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      expect(answer).toBe('pending');
      jest.advanceTimersByTime(5000);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      expect(answer).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('what the site says about the file that would not load', () => {
  test('the question is a HEAD for the address webpack asked for, past every cache', async () => {
    const { fetchImpl, calls } = site();
    await failedFileState(chunkError(), { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: CHUNK_URL, method: 'HEAD', cache: 'no-store' });
  });

  test('a 404, a 410 and a page where a script was asked for are a file the site does not have', async () => {
    await expect(failedFileState(chunkError(), { fetchImpl: site({ file: GONE }).fetchImpl })).resolves.toBe('gone');
    await expect(failedFileState(chunkError(), { fetchImpl: site({ file: { status: 410, type: 'text/plain' } }).fetchImpl })).resolves.toBe('gone');
    // A host that answers every unknown address with its front page.
    await expect(failedFileState(chunkError(), { fetchImpl: site({ file: { status: 200, type: 'text/html; charset=utf-8' } }).fetchImpl })).resolves.toBe('gone');
    await expect(failedFileState(chunkError(), { fetchImpl: site({ file: { status: 200, type: 'TEXT/HTML' } }).fetchImpl })).resolves.toBe('gone');
  });

  test('a script answered as a script is there: the download died on the way', async () => {
    await expect(failedFileState(chunkError(), { fetchImpl: site({ file: THERE }).fetchImpl })).resolves.toBe('there');
    await expect(failedFileState(chunkError(), { fetchImpl: site({ file: { status: 200 } }).fetchImpl })).resolves.toBe('there');
    const css = 'http://localhost/static/css/8970.0f1e2d3c.chunk.css';
    const { fetchImpl, calls } = site({ file: { status: 200, type: 'text/css' } });
    await expect(failedFileState(chunkError(css), { fetchImpl })).resolves.toBe('there');
    expect(calls[0].url).toBe(css);
  });

  test('a server error, a dead network and a deadline are no answer either way', async () => {
    await expect(failedFileState(chunkError(), { fetchImpl: site({ file: { status: 500, type: 'text/html' } }).fetchImpl })).resolves.toBe('unknown');
    await expect(failedFileState(chunkError(), { fetchImpl: site({ file: { status: 503 } }).fetchImpl })).resolves.toBe('unknown');
    await expect(failedFileState(chunkError(), { fetchImpl: site({ file: new TypeError('Failed to fetch') }).fetchImpl })).resolves.toBe('unknown');
    await expect(failedFileState(chunkError(), { fetchImpl: null })).resolves.toBe('unknown');

    jest.useFakeTimers();
    try {
      let answer = 'pending';
      failedFileState(chunkError(), { fetchImpl: neverAnswers(), timeoutMs: 5000 }).then((state) => { answer = state; });
      jest.advanceTimersByTime(5000);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      expect(answer).toBe('unknown');
    } finally {
      jest.useRealTimers();
    }
  });

  test('nothing is asked about an address that is not one of this site\'s built files', async () => {
    const { fetchImpl } = site();
    const noFile = Object.assign(new Error('Loading chunk 7 failed.'), { name: 'ChunkLoadError' });
    for (const error of [
      noFile,
      null,
      chunkError(''),
      chunkError(42),
      chunkError('https://cdn.example.com/static/js/8970.157081c6.chunk.js'),
      chunkError('http://localhost/api/flocks'),
      chunkError('http://localhost/static/../api/flocks'),
      chunkError('http://[not a url'),
    ]) {
      await expect(failedFileState(error, { fetchImpl })).resolves.toBe('unknown');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('an address written from the root is read against the page it failed on', async () => {
    const { fetchImpl, calls } = site();
    await expect(failedFileState(chunkError('/static/js/8970.157081c6.chunk.js'), {
      fetchImpl, base: 'https://www.flockcorp.com/app',
    })).resolves.toBe('gone');
    expect(calls[0].url).toBe('https://www.flockcorp.com/static/js/8970.157081c6.chunk.js');
    // And the same address is another site's when the page is somewhere else.
    await expect(failedFileState(chunkError(CHUNK_URL), {
      fetchImpl, base: 'https://www.flockcorp.com/app',
    })).resolves.toBe('unknown');
    expect(calls).toHaveLength(1);
  });
});

describe('the one reload', () => {
  function given({ file, manifest, kept, doc = RUNNING_DOC } = {}) {
    const { fetchImpl, calls } = site({ file, manifest });
    const storage = memoryStore(kept);
    const reload = jest.fn();
    return { fetchImpl, calls, storage, reload, options: { doc, fetchImpl, storage, reload, native: false } };
  }

  test('the file is gone and the site serves a newer build: the name is kept, then the page reloads', async () => {
    const { calls, storage, options } = given();
    let keptAtReload = 'not reloaded';
    const reload = jest.fn(() => { keptAtReload = storage.getItem(RELOADED_FROM_KEY); });
    await expect(healStaleBuild(chunkError(), { ...options, reload })).resolves.toBe('reloading');
    expect(reload).toHaveBeenCalledTimes(1);
    // Written before the reload, or a reload that comes back the same has
    // nothing to stop it.
    expect(keptAtReload).toBe(RUNNING);
    expect(calls.map((call) => [call.method, call.url])).toEqual([['HEAD', CHUNK_URL], ['GET', MANIFEST_URL]]);
  });

  test('the note goes with everything else this device holds at sign-out: its key starts with flock', () => {
    // services/api.js clearLocalSession sweeps both stores by that prefix
    // (signOutClearsDevice.test.js). Swept, the worst that follows is one more
    // reload.
    expect(RELOADED_FROM_KEY).toBe('flock_reloaded_from_build');
  });

  test('a tab that comes back from that reload on the same build is not reloaded again', async () => {
    const { storage, reload, options } = given({ kept: { [RELOADED_FROM_KEY]: RUNNING } });
    await expect(healStaleBuild(chunkError(), options)).resolves.toBe('newer');
    expect(reload).not.toHaveBeenCalled();
    expect(storage.getItem(RELOADED_FROM_KEY)).toBe(RUNNING);
  });

  test('the note is for one build: a later build this tab runs gets its own reload', async () => {
    const { storage, reload, options } = given({ kept: { [RELOADED_FROM_KEY]: 'main.00000000.js' } });
    await expect(healStaleBuild(chunkError(), options)).resolves.toBe('reloading');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(RELOADED_FROM_KEY)).toBe(RUNNING);
  });

  test('the file is gone from the build that is live: a reload would ask for it again, so there is none', async () => {
    const { storage, reload, options } = given({ manifest: manifestFor(RUNNING) });
    await expect(healStaleBuild(chunkError(), options)).resolves.toBe('current');
    expect(reload).not.toHaveBeenCalled();
    expect(storage.getItem(RELOADED_FROM_KEY)).toBeNull();
  });

  test('the site has the file: no reload, and the manifest is never asked for', async () => {
    const { calls, storage, reload, options } = given({ file: THERE });
    await expect(healStaleBuild(chunkError(), options)).resolves.toBe('there');
    expect(reload).not.toHaveBeenCalled();
    expect(storage.getItem(RELOADED_FROM_KEY)).toBeNull();
    expect(calls.map((call) => call.method)).toEqual(['HEAD']);
  });

  test('no answer about the file, or about the build, changes nothing', async () => {
    for (const answers of [
      { file: new TypeError('Failed to fetch') },
      { file: { status: 500 } },
      { manifest: null },
      { manifest: new TypeError('Failed to fetch') },
      { manifest: { files: { 'main.js': '/static/js/bundle.js' } } },
    ]) {
      const { storage, reload, options } = given(answers);
      await expect(healStaleBuild(chunkError(), options)).resolves.toBe('unknown');
      expect(reload).not.toHaveBeenCalled();
      expect(storage.getItem(RELOADED_FROM_KEY)).toBeNull();
    }
  });

  test('a browser that will not keep the note is not reloaded, because nothing would stop a second reload', async () => {
    const refuses = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
    const forgets = { getItem: () => null, setItem: () => {} };
    const unreadable = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => {} };
    for (const storage of [null, refuses, forgets, unreadable]) {
      const { reload, options } = given();
      await expect(healStaleBuild(chunkError(), { ...options, storage })).resolves.toBe('newer');
      expect(reload).not.toHaveBeenCalled();
    }
  });

  test('somebody who has left the broken screen by the time the site answers is not reloaded', async () => {
    const { calls, storage, reload, options } = given();
    let answersByThen = -1;
    const stillWanted = jest.fn(() => { answersByThen = calls.length; return false; });
    await expect(healStaleBuild(chunkError(), { ...options, stillWanted })).resolves.toBe('newer');
    expect(stillWanted).toHaveBeenCalledTimes(1);
    // Asked after both answers are in, which is when it can have changed.
    expect(answersByThen).toBe(2);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.getItem(RELOADED_FROM_KEY)).toBeNull();
  });

  test('stillWanted is not asked when there is nothing to reload into', async () => {
    const stillWanted = jest.fn(() => true);
    await healStaleBuild(chunkError(), { ...given({ file: THERE }).options, stillWanted });
    await healStaleBuild(chunkError(), { ...given({ manifest: manifestFor(RUNNING) }).options, stillWanted });
    expect(stillWanted).not.toHaveBeenCalled();
  });

  test('the apps read their chunks from their own bundle and ask the site nothing', async () => {
    const { fetchImpl, reload, options } = given();
    await expect(healStaleBuild(chunkError(), { ...options, native: true })).resolves.toBe('unknown');
    // And with nothing passed in, the answer is the shell's own.
    mockShell.native = true;
    const { native, ...asShipped } = options;
    expect(native).toBe(false);
    await expect(healStaleBuild(chunkError(), asShipped)).resolves.toBe('unknown');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  test('a page with no build name (a dev server, a test) asks the site nothing', async () => {
    const dev = docWith({ src: 'http://localhost:3000/static/js/bundle.js' });
    const { fetchImpl, reload, options } = given({ doc: dev });
    await expect(healStaleBuild(chunkError(), options)).resolves.toBe('unknown');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  test('an error that names no file is not reloaded on the manifest alone', async () => {
    // The manifest naming another build says a deploy happened. It does not say
    // this failure was the deploy, and the common failure is a weak connection.
    const { fetchImpl, reload, options } = given();
    const noFile = Object.assign(new Error('Loading chunk 7 failed.'), { name: 'ChunkLoadError' });
    await expect(healStaleBuild(noFile, options)).resolves.toBe('unknown');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  test('never throws, whatever it is handed', async () => {
    const { options } = given();
    await expect(healStaleBuild(chunkError(), { ...options, reload: () => { throw new Error('no'); } })).resolves.toBe('unknown');
    await expect(healStaleBuild(chunkError(), { ...options, stillWanted: () => { throw new Error('no'); } })).resolves.toBe('unknown');
    await expect(healStaleBuild(chunkError(), { ...options, doc: { get scripts() { throw new Error('no'); } } })).resolves.toBe('unknown');
    await expect(healStaleBuild(undefined, options)).resolves.toBe('unknown');
  });
});

function Boom({ error }) {
  throw error;
}

describe('the crash net', () => {
  let realFetch;
  let realError;
  let reload;
  let tag;

  beforeEach(() => {
    realFetch = global.fetch;
    realError = console.error;
    console.error = () => {};
    window.sessionStorage.clear();
    // The boundary binds this in its constructor, and jsdom's own
    // location.reload cannot be watched.
    reload = jest.spyOn(ErrorBoundary.prototype, 'reload').mockImplementation(() => {});
    // The page is running a build: its script tag says which. jsdom does not
    // fetch it.
    tag = document.createElement('script');
    tag.src = `/static/js/${RUNNING}`;
    document.head.appendChild(tag);
  });

  afterEach(() => {
    global.fetch = realFetch;
    console.error = realError;
    reload.mockRestore();
    tag.remove();
    window.sessionStorage.clear();
  });

  const crashed = (error, props = {}) => (
    <ErrorBoundary label="screen:chat" {...props}>
      <Boom error={error} />
    </ErrorBoundary>
  );

  test('a chunk the site no longer has, with a newer build live, reloads the page once', async () => {
    const { fetchImpl, calls } = site();
    global.fetch = fetchImpl;
    render(crashed(chunkError()));
    // The card is up while the site is asked.
    expect(screen.getByText(CHUNK_ERROR_TITLE)).toBeTruthy();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(window.sessionStorage.getItem(RELOADED_FROM_KEY)).toBe(RUNNING);
    expect(calls.map((call) => [call.method, call.url])).toEqual([['HEAD', CHUNK_URL], ['GET', MANIFEST_URL]]);
    await act(async () => { await settle(); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('back from that reload on the same build, the card says what happened and offers the reload', async () => {
    window.sessionStorage.setItem(RELOADED_FROM_KEY, RUNNING);
    global.fetch = site().fetchImpl;
    render(crashed(chunkError()));
    expect(screen.getByText('Reloading gets you back in.')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(NEWER_BUILD_NOTE)).toBeTruthy());
    expect(screen.queryByText('Reloading gets you back in.')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    // The button on the app-wide card was Reload all along.
    fireEvent.click(screen.getByRole('button', { name: 'Reload the app' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('a card of its own is told, and is handed the reload to offer', async () => {
    window.sessionStorage.setItem(RELOADED_FROM_KEY, RUNNING);
    global.fetch = site().fetchImpl;
    const told = [];
    const fallback = ({ newerBuild, reload: go, reset }) => {
      told.push(newerBuild);
      return newerBuild
        ? <button type="button" onClick={go}>Reload the app</button>
        : <button type="button" onClick={reset}>Try again</button>;
    };
    render(crashed(chunkError(), { fallback }));
    expect(told[0]).toBe(false);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    const button = await screen.findByRole('button', { name: 'Reload the app' });
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    fireEvent.click(button);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('a download that died is not reloaded, and its card keeps Try again', async () => {
    const { fetchImpl, calls } = site({ file: THERE });
    global.fetch = fetchImpl;
    const told = [];
    const fallback = ({ newerBuild }) => { told.push(newerBuild); return <p>card</p>; };
    render(crashed(chunkError(), { fallback }));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await act(async () => { await settle(); });
    expect(calls.map((call) => call.method)).toEqual(['HEAD']);
    expect(reload).not.toHaveBeenCalled();
    expect(told.every((newer) => newer === false)).toBe(true);
    expect(window.sessionStorage.getItem(RELOADED_FROM_KEY)).toBeNull();
  });

  test('a file missing from the build that is live is not reloaded and not called an update', async () => {
    const { fetchImpl } = site({ manifest: manifestFor(RUNNING) });
    global.fetch = fetchImpl;
    render(crashed(chunkError()));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await act(async () => { await settle(); });
    expect(reload).not.toHaveBeenCalled();
    expect(screen.queryByText(NEWER_BUILD_NOTE)).toBeNull();
    expect(screen.getByText('Reloading gets you back in.')).toBeTruthy();
  });

  test('a crash that is not a chunk asks the site nothing', async () => {
    const { fetchImpl } = site();
    global.fetch = fetchImpl;
    // Even one that carries an address, as a failed request of the app's can.
    render(crashed(Object.assign(new TypeError('votes is undefined'), { request: CHUNK_URL })));
    await act(async () => { await settle(); });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  test('inside the apps a chunk error asks the site nothing', async () => {
    mockShell.native = true;
    const { fetchImpl } = site();
    global.fetch = fetchImpl;
    render(crashed(chunkError()));
    await act(async () => { await settle(); });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  test('a page with no build to compare asks the site nothing', async () => {
    tag.remove();
    const { fetchImpl } = site();
    global.fetch = fetchImpl;
    render(crashed(chunkError()));
    await act(async () => { await settle(); });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  test('somebody who left the broken screen before the site answered is not reloaded out of the next one', async () => {
    const { until, open } = gate();
    const { fetchImpl } = site({ until });
    global.fetch = fetchImpl;
    const view = render(crashed(chunkError(), { resetKey: 'chat' }));
    expect(screen.getByText(CHUNK_ERROR_TITLE)).toBeTruthy();
    view.rerender(
      <ErrorBoundary label="screen:chat" resetKey="nest">
        <p>The Nest</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('The Nest')).toBeTruthy();
    await act(async () => { open(); await settle(); });
    // The site did answer, and what it said was "gone, and a newer build".
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(RELOADED_FROM_KEY)).toBeNull();
    expect(screen.getByText('The Nest')).toBeTruthy();
  });

  test('a different crash on screen by then is not reloaded, and its card is not told about an update', async () => {
    const { until, open } = gate();
    const { fetchImpl } = site({ until });
    global.fetch = fetchImpl;
    const told = [];
    const fallback = ({ error, newerBuild }) => { told.push([error.name, newerBuild]); return <p>{error.name}</p>; };
    const view = render(crashed(chunkError(), { resetKey: 'chat', fallback }));
    expect(screen.getByText('ChunkLoadError')).toBeTruthy();
    view.rerender(crashed(new TypeError('votes is undefined'), { resetKey: 'plans', fallback }));
    expect(screen.getByText('TypeError')).toBeTruthy();
    await act(async () => { open(); await settle(); });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
    expect(told.some(([name]) => name === 'TypeError')).toBe(true);
    expect(told.every(([, newer]) => newer === false)).toBe(true);
  });

  test('a boundary that is gone by then reloads nothing', async () => {
    const { until, open } = gate();
    const { fetchImpl } = site({ until });
    global.fetch = fetchImpl;
    const view = render(crashed(chunkError()));
    view.unmount();
    await act(async () => { open(); await settle(); });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(RELOADED_FROM_KEY)).toBeNull();
  });

  test('the update is forgotten with the crash it belonged to', async () => {
    window.sessionStorage.setItem(RELOADED_FROM_KEY, RUNNING);
    global.fetch = site().fetchImpl;
    const fallback = ({ error, newerBuild }) => <p>{`${error.name}: ${newerBuild ? 'reload' : 'try again'}`}</p>;
    const view = render(crashed(chunkError(), { resetKey: 'chat', fallback }));
    await screen.findByText('ChunkLoadError: reload');
    // The next crash this boundary catches is a bug in a screen that did load.
    view.rerender(crashed(new TypeError('votes is undefined'), { resetKey: 'plans', fallback }));
    expect(screen.getByText('TypeError: try again')).toBeTruthy();
    await act(async () => { await settle(); });
    expect(screen.getByText('TypeError: try again')).toBeTruthy();
  });
});

describe('the words and the two screen cards in App.js', () => {
  const app = read('App.js');
  const cards = [
    ['the screen card', app.slice(app.indexOf('const screenCrashFallback = ('), app.indexOf('const exploreCrashFallback = ('))],
    ['the map card', app.slice(app.indexOf('const exploreCrashFallback = ('), app.indexOf('const verifyEmailSheetProps = {'))],
  ];

  test('the note is plain, and App.js shows the same one the app-wide card does', () => {
    expect(NEWER_BUILD_NOTE).toBe('Flock was updated after this tab was opened. Reload to get the new version.');
    expect(app).toContain("import { NEWER_BUILD_NOTE } from './lib/staleBuild';");
    expect(read('components', 'ErrorBoundary.js')).toContain("import { healStaleBuild, NEWER_BUILD_NOTE } from '../lib/staleBuild';");
  });

  test.each(cards)('%s takes the reload and the news from the boundary', (name, card) => {
    expect(card.length).toBeGreaterThan(500);
    expect(card).toMatch(/^const \w+ = \(\{ error, (eventId, )?reload, reset, newerBuild, componentStack, label \}\) =>/);
    expect(card).toContain('NEWER_BUILD_NOTE');
  });

  test.each(cards)('%s makes Reload the button once the site is known to be ahead, and keeps Try again otherwise', (name, card) => {
    const swap = card.slice(card.indexOf('{newerBuild ? (\n'));
    expect(swap.startsWith('{newerBuild ? (\n')).toBe(true);
    const reloadAt = swap.indexOf('onClick={reload}');
    const wordsAt = swap.indexOf('Reload the app');
    const elseAt = swap.indexOf(') : (');
    const retryAt = swap.indexOf('Try again');
    expect(reloadAt).toBeGreaterThan(0);
    expect(wordsAt).toBeGreaterThan(reloadAt);
    expect(elseAt).toBeGreaterThan(wordsAt);
    expect(retryAt).toBeGreaterThan(elseAt);
    // The reload is the boundary's, handed in: one way to reload, one place.
    expect(card).not.toMatch(/location\.reload/);
    // And the way back in that re-arms the chunk is still under the else.
    const rearm = swap.search(/onClick=\{\(\) => \{ rearm\w+\(\);( rearm\w+\(\);)? reset\(\); \}\}/);
    expect(rearm).toBeGreaterThan(elseAt);
    expect(rearm).toBeLessThan(retryAt);
  });
});
