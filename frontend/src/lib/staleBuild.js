// A CHUNK THE SITE NO LONGER HAS, and the one reload that gets past it. For a
// tab that was open across a deploy.
//
// Every build names its scripts by their contents, and the main bundle holds
// the names of the lazy chunks it will ask for. Cloudflare Pages serves one
// deployment at a time, so a tab still running an earlier build can ask for a
// name the site no longer has, and is sent the 404 page where it wanted a
// script. The deploy keeps earlier builds' files on the site for 30 days
// (scripts/asset-history.js), which covers nearly every tab. This file is for
// the rest: a tab older than that, a deploy made with --drop-old, a file taken
// off the site on purpose. For those, "Try again" on the crash card asks for
// the same missing file for as long as the tab lives.
//
// THE SITE IS ASKED ABOUT THE FILE THAT FAILED, FIRST. A chunk fails far more
// often because the download died on a weak connection: the file is there,
// "Try again" gets it, and a reload would throw away the screen the person is
// on for nothing. webpack leaves the address it asked for on the error, so the
// question is a HEAD for that address. Only a 404, or a page where a script
// was asked for, goes further (measured on the live site 2026-11-11: 200
// application/javascript for a chunk it has, 404 text/html for one it does
// not). A file that is there, or no answer, leaves the card as it was.
//
// THEN TWO NAMES SAY WHETHER A RELOAD CAN HELP. The main bundle this page is
// running is named in its own script tags. The one the site serves now is
// named in /asset-manifest.json, which Pages answers with max-age=0,
// must-revalidate and which is asked for with no-store as well. Different
// names: a reload brings a build whose chunks all exist. The same name: the
// missing file belongs to the build that is live, a reload would ask for it
// again, and nothing is done.
//
// ONE RELOAD FOR EACH BUILD A TAB HAS RUN, counted in sessionStorage under the
// name of the main bundle that was reloaded away from. A reload that comes
// back with that same bundle (an old page held by something between here and
// the site) finds its own name there and stops, so this cannot loop. A browser
// that will not keep the note gets no reload at all, because nothing would
// then stop a second one. The key starts with "flock", so sign-out's sweep of
// this device (services/api.js clearLocalSession) takes it too, and the worst
// that follows is one more reload.
//
// ONLY THE WEBSITE. The iPhone and Android apps read every chunk from their
// own bundle, where a deploy of the site changes nothing.

import { isNativeShell } from './nativeShell';

export const RELOADED_FROM_KEY = 'flock_reloaded_from_build';

// What a crash card says once the reload is the person's to make.
export const NEWER_BUILD_NOTE = 'Flock was updated after this tab was opened. Reload to get the new version.';

// main.<content hash>.js, by the hash rule services/crashReport.js reads a
// build id with. A dev server's /static/js/bundle.js is not a build and has no
// name here.
const MAIN_FILE = /\/static\/js\/(main\.[0-9a-f]{6,}\.js)(?![\w.])/;

const mainName = (url) => {
  const found = MAIN_FILE.exec(typeof url === 'string' ? url : '');
  return found ? found[1] : null;
};

/** The main bundle this page is running, as "main.<hash>.js", or null. */
export function runningMain(doc = typeof document === 'undefined' ? null : document) {
  try {
    for (const script of Array.from((doc && doc.scripts) || [])) {
      // The prerendered pages start from cloudflare/paint-first.js, whose tag
      // names the main bundle in data-main and adds the script itself later.
      const name = mainName(script.src) || mainName(script.getAttribute && script.getAttribute('data-main'));
      if (name) return name;
    }
  } catch { /* no name is a fine answer */ }
  return null;
}

// One question to the site, with a deadline that covers reading the answer.
// Null when there was no answer to read.
async function ask(url, init, read, { fetchImpl = typeof fetch === 'function' ? fetch : null, timeoutMs = 5000 } = {}) {
  if (!fetchImpl) return null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(url, { ...init, cache: 'no-store', signal: controller ? controller.signal : undefined });
    return response ? await read(response) : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The main bundle the site serves right now, as "main.<hash>.js", or null. */
export function liveMain(options) {
  // Anything that is not the manifest (the 404 page, a hotel network's sign-in
  // page) fails one of these three lines and is no answer.
  return ask('/asset-manifest.json', {}, async (response) => {
    if (!response.ok) return null;
    const manifest = await response.json();
    return mainName(manifest && manifest.files && manifest.files['main.js']);
  }, options);
}

// The address webpack asked for, when it is one of this site's own built
// files. Nothing else is ever asked about.
function failedFile(error, base = typeof window === 'undefined' ? '' : window.location.href) {
  try {
    const request = error && error.request;
    if (typeof request !== 'string' || !request) return null;
    const url = new URL(request, base);
    if (url.origin !== new URL(base).origin || !url.pathname.startsWith('/static/')) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * What the site says about the file that would not load: 'gone' when it has
 * no such file, 'there' when it does, 'unknown' when the error names no file
 * of this site's or the network gave no answer.
 */
export async function failedFileState(error, { base, ...options } = {}) {
  const url = failedFile(error, base);
  if (!url) return 'unknown';
  const state = await ask(url, { method: 'HEAD' }, (response) => {
    if (response.status === 404 || response.status === 410) return 'gone';
    if (!response.ok) return 'unknown';
    // A host that answers every unknown address with its front page says 200.
    const type = (response.headers && response.headers.get && response.headers.get('content-type')) || '';
    return /^text\/html/i.test(type) ? 'gone' : 'there';
  }, options);
  return state || 'unknown';
}

async function diagnose(error, { doc, base, fetchImpl, timeoutMs, native = isNativeShell() } = {}) {
  if (native) return { state: 'unknown' };
  // Read before anything goes out: a page with no build to compare (a dev
  // server, a test) asks the network nothing.
  const running = runningMain(doc);
  if (!running) return { state: 'unknown' };
  const file = await failedFileState(error, { base, fetchImpl, timeoutMs });
  if (file !== 'gone') return { state: file };
  const live = await liveMain({ fetchImpl, timeoutMs });
  if (!live) return { state: 'unknown' };
  return { state: live === running ? 'current' : 'newer', running };
}

const sessionStore = () => {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null; // a browser with site data blocked throws on the property itself
  }
};

const reloadedFrom = (storage) => {
  try {
    return storage ? storage.getItem(RELOADED_FROM_KEY) : null;
  } catch {
    return null;
  }
};

// Read back, so a store that takes the write and keeps nothing counts as no
// note.
const noteReload = (storage, name) => {
  try {
    if (!storage) return false;
    storage.setItem(RELOADED_FROM_KEY, name);
    return storage.getItem(RELOADED_FROM_KEY) === name;
  } catch {
    return false;
  }
};

/**
 * The same question with no reload in it, for a surface that must not throw
 * away the page under it by itself: the "did not load" sheets in App.js, which
 * open over a live screen that can be holding a half-typed message. Answers
 * one of the states healStaleBuild documents below ('newer', 'current',
 * 'there', 'unknown') and leaves the reload to a button the person presses
 * (components/ui/NewerBuildNote.js). At most a HEAD and a manifest read, each
 * with its own deadline. Never throws.
 */
export async function checkStaleBuild(error, options) {
  try {
    const { state } = await diagnose(error, options);
    return state;
  } catch {
    return 'unknown';
  }
}

/**
 * For a chunk that would not load. Reloads the page, once, when the site no
 * longer has the file and serves a newer build, and says what it found:
 *
 *   'reloading'  the reload has been asked for
 *   'newer'      the file is gone and the site is on a newer build, and this
 *                did not reload: the one reload for this build is spent, the
 *                note could not be kept, or stillWanted() said the failure is
 *                no longer on screen. Only a reload gets the screen back.
 *   'current'    the file is gone from the build that is live, so a reload
 *                would ask for it again
 *   'there'      the site has the file: the download died on the way, and
 *                trying again can work
 *   'unknown'    no answer (the apps, a dev server, no network, an error that
 *                names no file)
 *
 * stillWanted is asked after the site has answered, which can be seconds
 * after the failure: somebody who has since left the broken screen is not
 * reloaded out of the one they went to. Never throws.
 */
export async function healStaleBuild(error, {
  storage = sessionStore(),
  reload = () => window.location.reload(),
  stillWanted = () => true,
  ...options
} = {}) {
  try {
    const { state, running } = await diagnose(error, options);
    if (state !== 'newer') return state;
    if (!stillWanted()) return 'newer';
    if (reloadedFrom(storage) === running) return 'newer';
    if (!noteReload(storage, running)) return 'newer';
    reload();
    return 'reloading';
  } catch {
    return 'unknown';
  }
}
