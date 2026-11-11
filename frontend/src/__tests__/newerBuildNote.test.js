/**
 * A "DID NOT LOAD" SHEET OFFERS THE RELOAD WHEN THE SITE HAS MOVED ON.
 *
 * Nine overlays in App.js resolve a failed download to a "This did not load"
 * sheet whose way out re-arms the lazy, so the next tap asks the network
 * again. For a tab left open across a deploy, past the 30 days the site keeps
 * earlier builds' files, the file is gone and every later tap asks for the
 * same missing file: only a reload gets the overlay. The crash net reloads by
 * itself (staleBuild.test.js); these sheets open over a live screen, a chat
 * with a half-typed message among them, so they offer the reload instead.
 *
 * Pinned here:
 *   1. lib/staleBuild.js checkStaleBuild asks the site the crash net's two
 *      questions and never reloads, whatever the answer;
 *   2. components/ui/NewerBuildNote.js draws the crash cards' line and a
 *      Reload button for 'newer' and nothing for any other answer, asks
 *      nothing without an error, and sets nothing after the sheet is gone;
 *   3. App.js hands each of the nine sheets its loader's error and each sheet
 *      draws the note above its own way out.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern newerBuildNote
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import NewerBuildNote from '../components/ui/NewerBuildNote';
import { checkStaleBuild, NEWER_BUILD_NOTE, RELOADED_FROM_KEY } from '../lib/staleBuild';

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');

const RUNNING = 'main.aaaaaaaa.js';
const LIVE = 'main.bbbbbbbb.js';
const CHUNK_URL = 'http://localhost/static/js/8970.157081c6.chunk.js';
const chunkError = () => Object.assign(new Error(`Loading chunk 8970 failed.\n(missing: ${CHUNK_URL})`), { name: 'ChunkLoadError', type: 'missing', request: CHUNK_URL });
const DOC = { scripts: [{ src: `http://localhost/static/js/${RUNNING}`, getAttribute: () => null }] };
const manifestFor = (main) => ({ files: { 'main.js': `/static/js/${main}` } });

// The site: its answer about the chunk, and /asset-manifest.json.
function site({ file = { status: 404, type: 'text/html' }, manifest = manifestFor(LIVE), fail = false } = {}) {
  return jest.fn(async (url, init = {}) => {
    if (fail) throw new TypeError('Failed to fetch');
    if (String(url) === CHUNK_URL && init.method === 'HEAD') {
      return { ok: file.status < 400, status: file.status, headers: { get: () => file.type } };
    }
    if (String(url) === '/asset-manifest.json') return { ok: true, status: 200, json: async () => manifest };
    return { ok: false, status: 404, headers: { get: () => 'text/html' } };
  });
}
const ask = (fetchImpl) => checkStaleBuild(chunkError(), { doc: DOC, fetchImpl, native: false });

describe('checkStaleBuild asks and never reloads', () => {
  let reload;
  beforeEach(() => {
    reload = jest.fn();
    // Nothing in this file may reach the real one; healStaleBuild's default
    // reload is the only reload staleBuild.js has.
    delete window.location;
    window.location = { href: 'http://localhost/', reload };
    window.sessionStorage.clear();
  });

  test('the file is gone and the site is newer: "newer", and no reload, no note written', async () => {
    const fetchImpl = site();
    await expect(ask(fetchImpl)).resolves.toBe('newer');
    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(RELOADED_FROM_KEY)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('the file is gone from the build that is live: "current"', async () => {
    await expect(ask(site({ manifest: manifestFor(RUNNING) }))).resolves.toBe('current');
  });

  test('the file is there (the download died): "there", and the manifest is not read', async () => {
    const fetchImpl = site({ file: { status: 200, type: 'application/javascript' } });
    await expect(ask(fetchImpl)).resolves.toBe('there');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('no answer, or an error with no file of this site\'s: "unknown"', async () => {
    await expect(ask(site({ fail: true }))).resolves.toBe('unknown');
    const fetchImpl = site();
    await expect(checkStaleBuild(new Error('boom'), { doc: DOC, fetchImpl, native: false })).resolves.toBe('unknown');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('the note on the sheet', () => {
  test('a newer build: the crash cards\' line and Reload the app, which reloads', async () => {
    const reload = jest.fn();
    const check = jest.fn(async () => 'newer');
    const error = chunkError();
    render(<NewerBuildNote error={error} check={check} reload={reload} />);
    expect(await screen.findByText(NEWER_BUILD_NOTE)).toBeTruthy();
    expect(check).toHaveBeenCalledWith(error);
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload the app' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test.each(['current', 'there', 'unknown'])('"%s" draws nothing', async (answer) => {
    const check = jest.fn(async () => answer);
    const { container } = render(<NewerBuildNote error={chunkError()} check={check} />);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(container.innerHTML).toBe('');
  });

  test('a check that throws draws nothing', async () => {
    const check = jest.fn(async () => { throw new Error('no'); });
    const { container } = render(<NewerBuildNote error={chunkError()} check={check} />);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(container.innerHTML).toBe('');
  });

  test('no error: nothing is asked', async () => {
    const check = jest.fn(async () => 'newer');
    const { container } = render(<NewerBuildNote error={null} check={check} />);
    await act(async () => { await Promise.resolve(); });
    expect(check).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe('');
  });

  test('a late answer about an earlier failure does not paint over the current one', async () => {
    // The sheet re-armed and failed again; the site's answer about the first
    // failure arrives after the second one's. Only the current one counts.
    const first = chunkError();
    const second = chunkError();
    let answerFirst;
    const check = jest.fn((error) => (error === first
      ? new Promise((resolve) => { answerFirst = resolve; })
      : Promise.resolve('there')));
    const { container, rerender } = render(<NewerBuildNote error={first} check={check} />);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    rerender(<NewerBuildNote error={second} check={check} />);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    await act(async () => { answerFirst('newer'); await Promise.resolve(); await Promise.resolve(); });
    expect(container.innerHTML).toBe('');
  });
});

describe('App.js: all nine sheets carry the error and the note', () => {
  const APP = read('App.js');
  const SHEETS = [
    ['AttendanceSheetUnavailable', 'onClick={close}'],
    ['EventDetailUnavailable', 'onClick={close}'],
    ['PaymentSheetsUnavailable', 'onClick={close}'],
    ['SearchResultsUnavailable', 'onClick={close}'],
    ['VenueDetailUnavailable', 'onClick={close}'],
    ['BirdiePanelUnavailable', 'onClick={close}'],
    ['ModerationSheetUnavailable', 'onClick={close}'],
    ['PaywallSheetUnavailable', 'onClick={close}'],
    ['VenueLoginUnavailable', 'onClick={back}'],
  ];

  test('every loader that resolves to a sheet hands it the error', () => {
    for (const [name] of SHEETS) {
      expect(APP).toContain(`return { default: chunkFallback(${name}, err) };`);
      expect(APP).not.toContain(`return { default: ${name} };`);
    }
    // And there is no tenth, bare, one.
    expect(APP).not.toMatch(/return \{ default: \w+Unavailable \};/);
    expect(APP).toMatch(/const WithChunkError = \(props\) => <Sheet \{\.\.\.props\} chunkError=\{chunkError\} \/>;/);
  });

  test.each(SHEETS)('%s takes chunkError and draws the note above its way out', (name, way) => {
    const start = APP.indexOf(`const ${name} = (`);
    expect(start).toBeGreaterThan(-1);
    const body = APP.slice(start, APP.indexOf('\n};', start));
    expect(body).toMatch(new RegExp(`^const ${name} = \\(\\{[^}]*\\bchunkError \\}\\) => \\{`));
    const note = body.indexOf('<NewerBuildNote error={chunkError} />');
    const out = body.indexOf(`<button className="hit44" ${way}`);
    expect(note).toBeGreaterThan(-1);
    expect(out).toBeGreaterThan(note);
    // The reload is the person's: nothing in a sheet reloads by itself.
    expect(body).not.toMatch(/location\.reload|healStaleBuild/);
  });
});
