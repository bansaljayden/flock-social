/**
 * DELIVERING A DATA EXPORT FROM A WEB VIEW.
 *
 * GET /api/users/export answers with the account's data as JSON and a
 * Content-Disposition of its own, which a fetch() never acts on: the body comes
 * back as a value and the client has to decide what "give this to the person"
 * means. On a browser that is a download. Inside the Capacitor shell it is not,
 * because WKWebView handles an anchor download inconsistently and the app ships
 * no Filesystem or Share plugin (adding one is a native rebuild, and the app is
 * in review).
 *
 * So there are three routes out, tried in order, and the last one always works:
 *
 *   1. The system share sheet, when it will accept a file. On iOS that is the
 *      one path that reliably ends with the file in Files or Mail.
 *   2. An anchor download, which is correct and unremarkable on the web.
 *   3. The clipboard, which needs no permission, no plugin and no file system.
 *
 * The fallback matters more than it looks. A control that cannot complete on
 * the platform the app actually ships on is a dead button, and the design
 * standard forbids those outright. Every branch here ends with the data in the
 * person's hands, and the caller is told WHICH branch ran so it can say so
 * rather than claiming a download that did not happen.
 *
 * WHY THE PAYLOAD IS SAFE TO PUT ON A CLIPBOARD. routes/users.js exportImage()
 * replaces any stored data: URL with { image_omitted: true }, so the export
 * carries references and text and never image bytes. With EXPORT_ROW_CAP at
 * 2000 rows a section, a real account's export is tens of kilobytes. If that
 * ever changes, the clipboard branch is the first thing that stops being
 * reasonable — assertNoInlineImages() below fails the moment it does.
 */

export const EXPORT_FILENAME = 'flock-data-export.json';
export const EXPORT_MIME = 'application/json';

/** Pretty-printed, because a person opening this should be able to read it. */
export function exportText(payload) {
  return JSON.stringify(payload, null, 2);
}

/**
 * The export must never carry image bytes.
 *
 * Not defensive noise: it is what makes the clipboard branch reasonable and
 * what keeps this file clear of the iOS photo-library permission question
 * entirely. A base64 image in here would be both a many-megabyte clipboard and
 * a write of picture data to the device.
 */
export function assertNoInlineImages(text) {
  return !/"data:image\//.test(text);
}

/**
 * Hand the export to the person. Resolves to how it was delivered:
 * 'shared' | 'downloaded' | 'copied', or throws if every route failed.
 */
export async function deliverExport(payload, deps = {}) {
  const {
    nav = typeof navigator === 'undefined' ? undefined : navigator,
    doc = typeof document === 'undefined' ? undefined : document,
    urlApi = typeof URL === 'undefined' ? undefined : URL,
    FileCtor = typeof File === 'undefined' ? undefined : File,
    BlobCtor = typeof Blob === 'undefined' ? undefined : Blob,
  } = deps;

  const text = exportText(payload);
  if (!assertNoInlineImages(text)) {
    // Refusing beats quietly putting picture data on a clipboard.
    throw new Error('The export contained image data, which it is not supposed to. Nothing was copied.');
  }

  // 1. Share sheet, only when it will actually take the file. canShare is the
  //    check that matters: navigator.share exists on iOS and rejects files, so
  //    calling it blind turns the good path into a thrown error.
  if (nav && typeof nav.share === 'function' && typeof nav.canShare === 'function' && FileCtor) {
    try {
      const file = new FileCtor([text], EXPORT_FILENAME, { type: EXPORT_MIME });
      if (nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: 'Flock data export' });
        return 'shared';
      }
    } catch (err) {
      // A share the person CANCELS throws AbortError, and that is not a failure
      // to fall through on: they saw the sheet and said no. Anything else means
      // the route did not work and the next one should be tried.
      if (err && err.name === 'AbortError') return 'shared';
    }
  }

  // 2. Anchor download. JSON only, and the MIME is pinned right here so this
  //    can never become a way to write an image to the device.
  if (doc && urlApi && BlobCtor && typeof urlApi.createObjectURL === 'function') {
    try {
      const blob = new BlobCtor([text], { type: EXPORT_MIME });
      const href = urlApi.createObjectURL(blob);
      const a = doc.createElement('a');
      a.href = href;
      a.setAttribute('download', EXPORT_FILENAME);
      a.style.display = 'none';
      doc.body.appendChild(a);
      a.click();
      a.remove();
      // Revoked on a later tick: revoking synchronously has raced the click in
      // Safari and produced an empty file.
      setTimeout(() => { try { urlApi.revokeObjectURL(href); } catch (_) { /* already gone */ } }, 30000);
      return 'downloaded';
    } catch (_) { /* fall through to the clipboard */ }
  }

  // 3. The clipboard. No permission, no plugin, no file system.
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    await nav.clipboard.writeText(text);
    return 'copied';
  }

  throw new Error('Your data could not be saved on this device. Try again from a browser.');
}
