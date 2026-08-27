/**
 * GETTING A COPY OF YOUR OWN DATA.
 *
 * GET /api/users/export was built, metered, and gated behind a proof of
 * identity, and nothing in the app called it. The privacy policy told people to
 * email and ask instead, so every request was answered by hand using a route
 * that already did the whole job in one call.
 *
 * The hard part is not the request, it is the delivery. A fetch() ignores the
 * server's Content-Disposition, so the client decides what "give this to the
 * person" means, and inside the Capacitor shell the browser answer does not
 * hold: WKWebView treats an anchor download inconsistently and the app ships no
 * Filesystem or Share plugin. So there are three routes out and the last one
 * always works, which is what keeps this from being a control that silently
 * does nothing on the platform the app actually ships on.
 *
 * These pin the order, the fallback, and the honesty of what the person is
 * told afterwards.
 */

import {
  deliverExport,
  exportText,
  assertNoInlineImages,
  EXPORT_FILENAME,
  EXPORT_MIME,
} from '../services/dataExport';

const fs = require('fs');
const path = require('path');

// The "Get a copy of my data" control and its sheet live on the profile and
// settings screen (the You tab), which left App.js on 2026-08-27 for
// screens/ProfileSettings.js, so both files are read as one.
const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'ProfileSettings.js'), 'utf8');
const API = fs.readFileSync(path.join(__dirname, '..', 'services', 'api.js'), 'utf8');

const PAYLOAD = { generated_at: '2026-08-26T00:00:00.000Z', flocks: [{ name: 'Friday' }] };

/** A navigator/document stand-in with only the pieces each branch needs. */
function harness({ canShare = false, shareImpl, clipboard = true, dom = true } = {}) {
  const calls = { shared: 0, clicked: 0, copied: 0, downloadName: null, blobType: null };
  const nav = {};
  if (shareImpl || canShare) {
    nav.canShare = () => canShare;
    nav.share = async (...args) => { calls.shared += 1; if (shareImpl) return shareImpl(...args); return undefined; };
  }
  if (clipboard) nav.clipboard = { writeText: async () => { calls.copied += 1; } };

  const anchor = {
    href: '', style: {},
    setAttribute(k, v) { if (k === 'download') calls.downloadName = v; },
    click() { calls.clicked += 1; },
    remove() {},
  };
  const doc = dom ? { createElement: () => anchor, body: { appendChild() {} } } : undefined;
  const urlApi = dom ? { createObjectURL: () => 'blob:x', revokeObjectURL() {} } : undefined;
  const BlobCtor = dom ? function BlobStub(parts, opts) { calls.blobType = opts && opts.type; } : undefined;
  const FileCtor = function FileStub(parts, name, opts) { this.name = name; this.type = opts && opts.type; };

  return { calls, deps: { nav, doc, urlApi, BlobCtor, FileCtor } };
}

describe('the payload itself', () => {
  it('is pretty-printed, because a person is going to open it', () => {
    expect(exportText(PAYLOAD)).toContain('\n  ');
  });

  it('recognises inline image bytes, which the export is not allowed to carry', () => {
    expect(assertNoInlineImages('{"image_url":null}')).toBe(true);
    expect(assertNoInlineImages('{"image_url":"data:image/png;base64,AAAA"}')).toBe(false);
  });

  it('refuses to deliver a payload carrying image bytes rather than copying them', async () => {
    // The server strips these (exportImage -> image_omitted), so reaching here
    // means that changed. Putting megabytes of picture data on a clipboard is
    // the wrong way to find out.
    const { deps } = harness({ clipboard: true, dom: false });
    await expect(deliverExport({ image_url: 'data:image/png;base64,AAAA' }, deps))
      .rejects.toThrow(/image data/i);
  });
});

describe('the three routes out, in order', () => {
  it('prefers the share sheet when it will actually take the file', async () => {
    const { calls, deps } = harness({ canShare: true });
    const how = await deliverExport(PAYLOAD, deps);
    expect(how).toBe('shared');
    expect(calls.shared).toBe(1);
    expect(calls.clicked).toBe(0);
    expect(calls.copied).toBe(0);
  });

  it('does not call share when canShare says it will refuse the file', async () => {
    // navigator.share EXISTS on iOS and rejects files, so calling it blind
    // turns the good path into a thrown error and skips straight to fallback.
    const { calls, deps } = harness({ canShare: false });
    const how = await deliverExport(PAYLOAD, deps);
    expect(calls.shared).toBe(0);
    expect(how).toBe('downloaded');
  });

  it('treats a cancelled share as done, not as a route that failed', async () => {
    // The person saw the sheet and said no. Falling through would download a
    // file they just declined to save.
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const { calls, deps } = harness({ canShare: true, shareImpl: () => { throw abort; } });
    const how = await deliverExport(PAYLOAD, deps);
    expect(how).toBe('shared');
    expect(calls.clicked).toBe(0);
    expect(calls.copied).toBe(0);
  });

  it('falls through to the download when the share throws for any other reason', async () => {
    const { calls, deps } = harness({ canShare: true, shareImpl: () => { throw new Error('not supported'); } });
    const how = await deliverExport(PAYLOAD, deps);
    expect(how).toBe('downloaded');
    expect(calls.clicked).toBe(1);
  });

  it('names the file and pins the MIME to JSON on the download path', async () => {
    const { calls, deps } = harness({ canShare: false });
    await deliverExport(PAYLOAD, deps);
    expect(calls.downloadName).toBe(EXPORT_FILENAME);
    expect(calls.blobType).toBe(EXPORT_MIME);
    expect(EXPORT_MIME).toBe('application/json');
  });

  it('lands on the clipboard when there is no DOM to download with', async () => {
    // The shell case: no anchor download, no plugin, no file system.
    const { calls, deps } = harness({ canShare: false, dom: false });
    const how = await deliverExport(PAYLOAD, deps);
    expect(how).toBe('copied');
    expect(calls.copied).toBe(1);
  });

  it('throws rather than reporting success when no route exists at all', async () => {
    const { deps } = harness({ canShare: false, dom: false, clipboard: false });
    await expect(deliverExport(PAYLOAD, deps)).rejects.toThrow(/could not be saved/i);
  });
});

describe('the request', () => {
  const fn = API.slice(API.indexOf('export async function exportMyData'));
  const body = fn.slice(0, fn.indexOf('\n}'));

  it('opts out of the automatic retry, because every call spends an export slot', () => {
    // It is a GET with a server-side effect (exportRequests.record), so the
    // 502/503/504 retry would burn three of the owner's slots on one tap.
    expect(body).toContain('retry: false');
  });

  it('sends the proof in the header the backend reads, not in a body', () => {
    // GET has no body. deleteAccount sends its proof in one because DELETE
    // does; the two are not interchangeable.
    expect(body).toContain("'x-export-password'");
    expect(body).not.toContain('JSON.stringify');
  });

  it('gets a longer leash than the default', () => {
    expect(body).toContain('timeout: 30000');
  });
});

describe('the screen', () => {
  const handler = (() => {
    const from = APP.indexOf('const handleExportData');
    const to = APP.indexOf('const handleShareLocationWithContacts', from);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const src = APP.slice(from, to);
    expect(src.length).toBeGreaterThan(400);
    expect(src.length).toBeLessThan(6000);
    return src;
  })();

  it('offers the copy from settings', () => {
    expect(APP).toContain('Get a copy of my data');
    expect(APP).toContain('setShowExportData(true)');
  });

  it('sits above Delete account, so leaving with your things is offered first', () => {
    expect(APP.indexOf('Get a copy of my data')).toBeLessThan(APP.indexOf('>Delete account<'));
  });

  it('treats a 401 as a re-prompt rather than a failure', () => {
    // reauthRequired is the server asking a question: 'password' when it wants
    // one, 'reauth' when an OAuth session is too old to count as proof.
    expect(handler).toContain('reauthRequired');
    expect(handler).toContain("reauth === 'password'");
    expect(handler).toContain("reauth === 'reauth'");
  });

  it('tells the person which of the three things actually happened', () => {
    // "Downloaded" after a clipboard copy sends somebody hunting through Files
    // for a file that was never written.
    expect(handler).toContain("how === 'shared'");
    expect(handler).toContain("how === 'downloaded'");
    expect(handler).toContain('clipboard');
  });

  it('clears the typed password once the export succeeds', () => {
    expect(handler).toContain("setExportPassword('')");
  });
});
