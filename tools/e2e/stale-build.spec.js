/* A tab left open across a deploy, in a real browser.
 *
 * The site serves one build at a time and each build names its lazy files by
 * hash. A tab opened before a deploy still runs the old main script, so the
 * first screen it has not downloaded yet is a file the site no longer has: the
 * download fails, the card says "Part of the app didn't load", and Try again
 * asks for the same missing file. lib/staleBuild.js tells that apart from a
 * weak connection and components/ErrorBoundary.js acts on the answer: reload
 * into the new build, once, and never twice from the same build.
 *
 * The unit tests hold every branch of that against fakes. These hold the path
 * against what the fakes stand in for: webpack's own chunk error and the
 * address on it, a HEAD and a manifest read sent by the page under the site's
 * Content Security Policy, a real location.reload(), and sessionStorage across
 * it. Three tabs:
 *
 *   1. the file is gone and a newer build is live: one reload, and the screen
 *      opens on the far side of it;
 *   2. the reload brings the same old build back: no second reload, and both
 *      crash cards say what happened and offer the reload as a button;
 *   3. the two cases that must NOT reload (the download died but the file is
 *      still there; the file is gone but the site's build is still this tab's):
 *      the card keeps Try again, and Try again works once the file is back.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const { signUp, failOnPageErrors } = require('./helpers');

// The words on the two cards, and what lib/staleBuild.js leaves in the tab.
const CARD = "Part of the app didn't load";
const MAP_CARD = 'The map stopped working';
const NEWER_BUILD_NOTE = 'Flock was updated after this tab was opened. Reload to get the new version.';
const RELOADED_FROM_KEY = 'flock_reloaded_from_build';

// A lazy file of the build: /static/js/<id>.<hash>.chunk.js, or its css.
const CHUNK = /^\/static\/(?:js|css)\/[^/]+\.chunk\.(?:js|css)$/;

/* A client address of this test's own. The server caps socket handshakes per
   address per minute and every load of the app spends one, reloads included
   (signup.spec.js has the full account of why the header is believed). */
function clientIp() {
  const r = () => Math.floor(Math.random() * 256);
  return `198.18.${r()}.${r()}`;
}

/* A CONNECTION THAT ASKED FOR LESS DATA.
 *
 * Once it is up the app downloads its other screens in the background
 * (warmScreenChunks in App.js), and a screen already in memory cannot fail to
 * download. It skips that on a save-data connection, which is one way a real
 * tab ends up on a build whose You screen it has never fetched. WebKit has no
 * navigator.connection, so the page is given one before any script runs, on
 * every load.
 */
async function onSaveData(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { saveData: true, effectiveType: '4g', addEventListener() {}, removeEventListener() {} },
    });
  });
}

/* THE SITE, AS THIS TAB SEES IT.
 *
 * The stack serves one build and keeps serving it, so the deploy is made in
 * front of the tab. Until deploy() nothing is touched. From then on a lazy file
 * the tab had not downloaded by that moment is `missing`, one of two ways:
 *
 *   'gone'     the site no longer has it. Answered as www.flockcorp.com
 *              answered a chunk name it does not have on 2026-11-11: 404,
 *              text/html, no-store, to GET and to HEAD alike.
 *   'dropped'  the download died on the way and the file is still on the
 *              site: the script request is aborted, a HEAD reaches the file.
 *
 * Files the tab already holds are left alone, as in a real tab, where they are
 * in memory and that is why it still runs. `newerLive` is what the manifest
 * says the site's main script is: another build's, or the real answer.
 */
function theSite(page) {
  const site = {
    asked: new Set(),                   // lazy files this tab has requested
    held: new Set(),                    // the ones it had when the deploy happened
    documents: { asked: 0, loaded: 0 }, // the first load, then one per reload
    missing: null,
    newerLive: false,
    headChecks: 0,                      // HEADs the page sent for a missing file
    manifestReads: 0,                   // since the deploy
  };
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) site.documents.asked += 1;
    if (request.method() === 'GET' && CHUNK.test(pathname)) site.asked.add(pathname);
  });
  page.on('load', () => { site.documents.loaded += 1; });

  site.deploy = async ({ missing, newerLive }) => {
    site.held = new Set(site.asked);
    site.missing = missing;
    site.newerLive = newerLive;
    await page.route((url) => CHUNK.test(url.pathname), (route) => {
      const request = route.request();
      const head = request.method() === 'HEAD';
      if (!site.missing || site.held.has(new URL(request.url()).pathname)) return route.continue();
      if (head) site.headChecks += 1;
      if (site.missing === 'dropped') return head ? route.continue() : route.abort('connectionreset');
      return route.fulfill({
        status: 404,
        contentType: 'text/html; charset=utf-8',
        headers: { 'cache-control': 'no-store' },
        body: head ? '' : '<!doctype html><title>Not found</title>',
      });
    });
    await page.route((url) => url.pathname === '/asset-manifest.json', (route) => {
      site.manifestReads += 1;
      if (!site.missing || !site.newerLive) return route.continue();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ files: { 'main.js': '/static/js/main.0a1b2c3d.js' } }),
      });
    });
  };

  /** Files asked for since the deploy that the tab did not already hold. */
  site.lost = () => [...site.asked].filter((file) => !site.held.has(file));

  /** The tab has asked for `n` documents so far and the last one is the one on screen. */
  site.onDocument = (n) => expect
    .poll(() => ({ ...site.documents }), { timeout: 30_000 })
    .toEqual({ asked: n, loaded: n });

  return site;
}

// Past the confirm-your-email screen a brand new account lands on, to the tab bar.
async function intoTheApp(page) {
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (let i = 0; i < 6 && !(await nav.isVisible().catch(() => false)); i += 1) {
    const out = page.getByRole('button', { name: /^(not now|skip|continue for now, confirm later)$/i }).first();
    if (await out.count()) await out.click().catch(() => {});
    await page.waitForTimeout(1500);
  }
  await expect(nav).toBeVisible({ timeout: 30_000 });
  return nav;
}

// The tab has stopped asking for files: nothing new for two seconds.
async function quiet(page, site) {
  let size = -1;
  let quietFor = 0;
  while (quietFor < 2000) {
    await page.waitForTimeout(500);
    quietFor = site.asked.size === size ? quietFor + 500 : 0;
    size = site.asked.size;
  }
}

/** A new account standing on the Nest, in a tab holding only what got it there. */
async function openTab(page, tag) {
  const errors = [];
  failOnPageErrors(page, errors);
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': clientIp() });
  await onSaveData(page);
  const site = theSite(page);
  await signUp(page, tag);
  const nav = await intoTheApp(page);
  await quiet(page, site);
  return { site, nav, errors };
}

/** The main script this tab is running, by the name on its own script tag. */
function runningMain(page) {
  return page.evaluate(() => {
    const tag = [...document.scripts].find((s) => /\/static\/js\/main\.[0-9a-f]+\.js$/.test(s.src));
    return tag ? tag.src.split('/').pop() : null;
  });
}

test('a tab on an old build reloads into the new one, once', async ({ page }) => {
  test.setTimeout(150_000);
  const { site, nav, errors } = await openTab(page, 'stale-heal');
  const running = await runningMain(page);
  expect(running).toMatch(/^main\.[0-9a-f]+\.js$/);
  const you = nav.getByRole('button', { name: /^you/i });

  await site.deploy({ missing: 'gone', newerLive: true });
  await you.click();
  await expect
    .poll(() => site.lost().length, { message: 'the You screen was already in the tab, so there was nothing to fail' })
    .toBeGreaterThan(0);
  await site.onDocument(2);

  // The tab is on the new build now, and the new build has its You screen.
  site.missing = null;
  await intoTheApp(page);
  await expect(nav.getByRole('button', { name: /^nest/i })).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate((key) => sessionStorage.getItem(key), RELOADED_FROM_KEY)).toBe(running);
  await you.click();
  await expect(page.getByRole('button', { name: /interests/i }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('alert').filter({ hasText: CARD })).toHaveCount(0);
  expect(site.documents).toEqual({ asked: 2, loaded: 2 });
  expect(errors).toEqual([]);
});

test('a reload that brings the same old build back is not repeated', async ({ page }) => {
  test.setTimeout(150_000);
  const { site, nav, errors } = await openTab(page, 'stale-guard');
  const you = nav.getByRole('button', { name: /^you/i });

  await site.deploy({ missing: 'gone', newerLive: true });
  await you.click();
  await site.onDocument(2);

  // The same build came back (an edge that had not caught up, a page out of a
  // cache), so the You screen is still a file the site does not have. The note
  // is only drawn after the tab decided against reloading again.
  await intoTheApp(page);
  await you.click();
  const card = page.getByRole('alert').filter({ hasText: CARD });
  await expect(card).toContainText(NEWER_BUILD_NOTE, { timeout: 20_000 });
  await expect(card.getByRole('button', { name: 'Reload the app' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  expect(site.documents).toEqual({ asked: 2, loaded: 2 });

  // Discover has a card of its own, and it is told the same thing.
  await nav.getByRole('button', { name: 'Discover', exact: true }).click();
  const mapCard = page.getByRole('alert').filter({ hasText: MAP_CARD });
  await expect(mapCard).toContainText(NEWER_BUILD_NOTE, { timeout: 20_000 });
  await expect(mapCard.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  expect(site.documents).toEqual({ asked: 2, loaded: 2 });

  // The new build reaches this visitor, and the button on the card is the way in.
  site.missing = null;
  await mapCard.getByRole('button', { name: 'Reload the app' }).click();
  await site.onDocument(3);
  await intoTheApp(page);
  await you.click();
  await expect(page.getByRole('button', { name: /interests/i }).first()).toBeVisible({ timeout: 20_000 });
  expect(site.documents).toEqual({ asked: 3, loaded: 3 });
  expect(errors).toEqual([]);
});

test('a file that failed for any other reason is left to Try again', async ({ page }) => {
  test.setTimeout(150_000);
  const { site, nav, errors } = await openTab(page, 'stale-retry');
  const card = page.getByRole('alert').filter({ hasText: CARD });
  const again = card.getByRole('button', { name: 'Try again' });

  // The download died on the way. The file is still on the site, so the tab
  // has no reason to look further, though a newer build is in fact live.
  await site.deploy({ missing: 'dropped', newerLive: true });
  await nav.getByRole('button', { name: /^you/i }).click();
  await expect(again).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => site.headChecks, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  expect(site.manifestReads, 'the manifest was read for a file that is still on the site').toBe(0);
  await expect(card).not.toContainText(NEWER_BUILD_NOTE);
  await expect(again).toBeVisible();
  expect(site.documents).toEqual({ asked: 1, loaded: 1 });

  // The file is gone, and the build the site serves is still this tab's own.
  // Reloading would bring the same page back, so the tab stays where it is.
  site.missing = 'gone';
  site.newerLive = false;
  await again.click();
  await expect.poll(() => site.manifestReads, { timeout: 20_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  await expect(again).toBeVisible();
  await expect(card).not.toContainText(NEWER_BUILD_NOTE);
  expect(site.documents).toEqual({ asked: 1, loaded: 1 });

  // The file is back, and Try again is all it takes.
  site.missing = null;
  await again.click();
  await expect(page.getByRole('button', { name: /interests/i }).first()).toBeVisible({ timeout: 20_000 });
  await expect(card).toHaveCount(0);
  expect(site.documents).toEqual({ asked: 1, loaded: 1 });
  expect(errors).toEqual([]);
});
