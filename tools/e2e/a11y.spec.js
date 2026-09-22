/* ACCESSIBILITY, PROVED IN A BROWSER.
 *
 * The sibling of `frontend/src/__tests__/accessibilitySweep.test.js`. That file
 * reads the source, which is the right tool for "does this call site pass an
 * aria-label". This one exists for the questions a source scan cannot answer,
 * and every test below is here because the answer was no:
 *
 *   1. A CONTROL CAN BE INVISIBLE AND STILL BE A TAB STOP. Three header navs
 *      in this app collapse by animating a container to `maxWidth: 0` with
 *      `overflow: hidden`, and Discover's live-events panel closes by parking
 *      itself at `translateX(100%)` behind `pointerEvents: none`. All four
 *      paint nothing. None of them removed anything from the tab order or
 *      from the accessibility tree, so Tab out of the flock chat's back arrow
 *      landed on "Vote on a venue", "Invite friends", "Search messages" and
 *      "Group cash pool" in sequence, all four of them zero pixels wide, and
 *      VoiceOver read four controls nobody could see. Reading the source
 *      cannot tell you that: `maxWidth: 0` looks like a layout value.
 *
 *   2. `visibility: visible` ON A CHILD BEATS `visibility: hidden` ON AN
 *      ANCESTOR, and the first version of the fix for (1) wrote exactly that.
 *      The whole Discover screen is held at `visibility: hidden` while another
 *      tab is on screen, so an explicit `visible` on its header nav put three
 *      Discover buttons into the tab order of EVERY OTHER SCREEN in the app.
 *      One property, opposite of the intended effect, and no source scan would
 *      have flinched at it. Test 4 is the general form of that check and would
 *      have caught it on any screen.
 *
 *   3. FOCUS THAT COMES BACK TO NOWHERE. Several controls hide themselves on
 *      the way to opening a sheet: "Vote on a venue" collapses the header nav
 *      as it goes. `.focus()` on a hidden element is a silent no-op, so the
 *      sheet's focus restore put the caret on <body> and a keyboard user was
 *      returned to the top of the screen.
 *
 * ONE OF THE THREE COLLAPSING NAVS IS GONE, AND TEST 1 CHANGED SHAPE FOR IT.
 * The flock chat's header rail was deleted in the chat rebuild: its five
 * controls are tiles in the composer's plus sheet now, and that sheet returns
 * null when it is shut rather than hiding itself. So the chat no longer HAS a
 * collapsed group to interrogate and collapsedGroupOf cannot be pointed at
 * one. What (1) is really about survives the move, and is what test 1 asserts
 * instead: the controls behind that door must not be focusable while the door
 * is shut, and must be focusable once it is open. Unmounting is the strongest
 * way to satisfy the first half, so the test pins that the sheet is ABSENT
 * rather than merely hidden. The day somebody re-renders it behind
 * visibility: hidden or maxWidth: 0, this goes red again for exactly the
 * reason it was written. Discover's rail still collapses the old way and test
 * 2 still reads it with collapsedGroupOf.
 *
 * WHAT IS DELIBERATELY NOT HERE. No screen reader is driven. VoiceOver cannot
 * be scripted from Playwright, and a spec that claimed to speak for it would
 * be fiction. What is asserted instead is the tree it reads: roles, names,
 * states, and whether the browser will put focus somewhere.
 *
 * HOW TO RUN
 *   node tools/e2e/stack.js         (once, wait for OPEN:)
 *   cd tools/e2e && npx playwright test a11y.spec.js --workers=1
 */
'use strict';

const path = require('path');
const { createRequire } = require('module');
const { test, expect, devices } = require('@playwright/test');
const { newEmail, adultDob, pinToLocalApi, failOnPageErrors } = require('./helpers');

const WEB = `http://127.0.0.1:${process.env.E2E_WEB_PORT || 3199}`;
const PG_PORT = Number(process.env.E2E_PG_PORT || 59610);

// pg the way stack.js resolves backend dependencies, matching flock.spec.js.
const backendRequire = createRequire(path.join(__dirname, '..', '..', 'backend', 'package.json'));
const { Client } = backendRequire('pg');

/** A client address of this test's own. See the header of signup.spec.js. */
function clientIp() {
  const r = () => Math.floor(Math.random() * 256);
  return `198.18.${r()}.${r()}`;
}

/** Click the link in the email, without the email. A precondition, not a subject. */
async function confirmEmail(email) {
  const client = new Client({
    connectionString: `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_e2e`,
    ssl: false,
  });
  await client.connect();
  try {
    const r = await client.query(
      'UPDATE users SET email_verified = TRUE, verified_email = email WHERE LOWER(email) = LOWER($1) RETURNING id',
      [email],
    );
    if (r.rowCount !== 1) throw new Error(`no account to confirm for ${email}`);
    return r.rows[0].id;
  } finally {
    await client.end();
  }
}

/** A signed-in person standing on Nest, in their own phone context. */
async function newPerson(browser, firstName) {
  const context = await browser.newContext({ ...devices['iPhone 13'], baseURL: WEB, permissions: [] });
  const page = await context.newPage();
  const errors = [];
  failOnPageErrors(page, errors);
  pinToLocalApi(page);
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': clientIp() });

  const email = newEmail('a11y');
  const name = `${firstName} Q${Math.random().toString(36).slice(2, 7)}`;

  await page.goto('/app');
  await page.getByRole('button', { name: /create an account/i }).click();
  await page.getByRole('textbox', { name: /^name$/i }).fill(name);
  await page.getByRole('textbox', { name: /email/i }).fill(email);
  await page.getByRole('textbox', { name: /password/i }).first().fill('E2eTesting!2026');
  const dob = page.getByRole('textbox', { name: /birth|date/i }).first();
  if (await dob.count()) await dob.fill(adultDob());
  await page.getByRole('button', { name: /create account|sign up|continue/i }).first().click();
  await expect(page.getByRole('heading', { name: /confirm your email/i })).toBeVisible({ timeout: 30_000 });
  await confirmEmail(email);

  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.getByRole('textbox', { name: /email/i }).fill(email);
  await page.getByRole('textbox', { name: /password/i }).first().fill('E2eTesting!2026');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`hey, ${firstName}`, 'i') }))
    .toBeVisible({ timeout: 30_000 });
  return { context, page, email, name, errors };
}

async function createFlock(page, name) {
  await page.getByRole('button', { name: /start a flock/i }).first().click();
  await expect(page.getByRole('heading', { name: /start a flock/i })).toBeVisible();
  // SearchInputLocal commits on a 120ms timer; fill then let it land.
  await page.getByLabel(/what.s the plan/i).fill(name);
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /create flock/i }).click();
  // Creating ends on the share step the guest-link work added, not in the
  // chat: "<name> is made." and a choice between sending the link and going in
  // quietly. "Not now" is the quiet door.
  await expect(page.getByRole('heading', { name: `${name} is made.`, exact: true }))
    .toBeVisible({ timeout: 25_000 });
  await page.getByRole('button', { name: /^not now$/i }).click();
  // THE CHAT NO LONGER HAS A HEADING TO WAIT FOR. The header carried the plan's
  // name as an <h2> until the rebuild made it a <span> inside the button that
  // opens the plan, on the ground that ARIA gives a button presentational
  // children and the heading was therefore announced by nothing. The name is
  // still on screen, in the one control that carries it, so that is what says
  // the chat is open.
  await expect(page.getByRole('button', { name: 'Open the plan' }))
    .toContainText(name, { timeout: 25_000 });
}

// ---------------------------------------------------------------------------
// The one question every test below asks the page, in the page.
// ---------------------------------------------------------------------------

/**
 * Everything the browser will put focus on, and whether the eye can find it.
 *
 * `visibility` is what separates the two. It is inherited, it survives having
 * a box, and it is the property the browser consults before granting focus.
 * An element with `maxWidth: 0; overflow: hidden` around it keeps a 36x36 box
 * and full `visibility: visible`, which is exactly why the box alone is not
 * the test and why `clipped` below walks the ancestors instead.
 *
 * An ancestor that scrolls does NOT hide anything: content below the fold is
 * reachable, so the walk stops checking an axis the moment it passes a
 * scroller. Only `overflow: hidden` and `overflow: clip`, which no user can
 * scroll, count as hiding.
 */
const FOCUSABLE_PROBE = `(() => {
  const SEL = ['a[href]','button:not([disabled])','input:not([disabled]):not([type=hidden])',
    'select:not([disabled])','textarea:not([disabled])','[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]'].join(',');
  const named = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '')
    .replace(/\\s+/g, ' ').trim().slice(0, 60);
  const rows = [];
  for (const el of document.querySelectorAll(SEL)) {
    const cs = getComputedStyle(el);
    const box = el.offsetWidth || el.offsetHeight || el.getClientRects().length;
    // Not rendered at all, or hidden: the browser refuses focus. Correct, and
    // therefore not this probe's business.
    if (!box || cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.display === 'none') continue;
    const r = el.getBoundingClientRect();
    let clipped = false, clipper = '', checkX = true, checkY = true;
    let p = el.parentElement;
    while (p && p !== document.documentElement && (checkX || checkY)) {
      const pcs = getComputedStyle(p);
      const pr = p.getBoundingClientRect();
      if (/auto|scroll/.test(pcs.overflowY)) checkY = false;
      if (/auto|scroll/.test(pcs.overflowX)) checkX = false;
      const cutX = checkX && /hidden|clip/.test(pcs.overflowX) && (r.right <= pr.left + 0.5 || r.left >= pr.right - 0.5);
      const cutY = checkY && /hidden|clip/.test(pcs.overflowY) && (r.bottom <= pr.top + 0.5 || r.top >= pr.bottom - 0.5);
      if (cutX || cutY) {
        clipped = true;
        clipper = p.tagName + ' ' + Math.round(pr.width) + 'x' + Math.round(pr.height);
        break;
      }
      p = p.parentElement;
    }
    rows.push({ tag: el.tagName.toLowerCase(), name: named(el), clipped, clipper,
      w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) });
  }
  return rows;
})()`;

/** Names of controls the browser WILL focus, hidden or not. */
async function focusableNames(page) {
  const rows = await page.evaluate(FOCUSABLE_PROBE);
  return rows.map((r) => r.name);
}

/** Anything focusable that is painted inside a container clipping it to nothing. */
async function invisibleTabStops(page) {
  const rows = await page.evaluate(FOCUSABLE_PROBE);
  return rows.filter((r) => r.clipped)
    .map((r) => `<${r.tag}> "${r.name}" ${r.w}x${r.h} at ${r.x},${r.y} inside ${r.clipper}`);
}

/** Walk Tab n times and report where focus landed, with visibility. */
async function tabWalk(page, steps) {
  await page.evaluate('if (document.activeElement && document.activeElement.blur) document.activeElement.blur();');
  const seen = [];
  for (let i = 0; i < steps; i += 1) {
    await page.keyboard.press('Tab');
    seen.push(await page.evaluate(`(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { name: '(body)', onScreen: true };
      const r = el.getBoundingClientRect();
      return {
        name: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '')
          .replace(/\\s+/g, ' ').trim().slice(0, 60),
        onScreen: r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0
          && r.left < window.innerWidth && r.top < window.innerHeight,
      };
    })()`));
  }
  return seen;
}

// Three of the tiles behind the flock chat's "+". These descend from the four
// that used to hang off the header's "Features" pill, and two were renamed on
// the way ("Search messages" became "Search chat", "Group cash pool" became
// "Cash pool"). "Invite friends" is deliberately NOT in this list even though
// the sheet holds one: the empty chat body has a second button by that exact
// name which is on screen and must stay reachable, so a name-only assertion
// cannot tell the two apart. Same exclusion, same reason, as when these lived
// in the header.
const CHAT_PLUS_UNIQUE = ['Vote on a venue', 'Search chat', 'Cash pool'];
const DISCOVER_NAV = ['Recenter the map on me', 'Events', 'Friends'];

/**
 * The collapsing container a given control sits in, and the visibility of
 * every control inside it. Anchored on a control rather than on a class name
 * or a position, so restructuring the header does not quietly make this pass
 * on an empty result.
 */
async function collapsedGroupOf(page, anchorLabel) {
  return page.evaluate(`(() => {
    const anchor = document.querySelector('button[aria-label=' + JSON.stringify(${JSON.stringify(anchorLabel)}) + ']');
    if (!anchor) return { found: false };
    const group = anchor.parentElement;
    const buttons = Array.from(group.querySelectorAll('button')).map((b) => ({
      name: b.getAttribute('aria-label') || (b.textContent || '').trim().slice(0, 30),
      vis: getComputedStyle(b).visibility,
    }));
    return { found: true, vis: getComputedStyle(group).visibility, buttons };
  })()`);
}

// ===========================================================================
// 1. THE FLOCK CHAT'S HIDDEN CONTROLS
// ===========================================================================

/** The tiles inside the composer's plus sheet, and whether the sheet is there. */
async function plusSheetTiles(page) {
  return page.evaluate(`(() => {
    const sheet = document.querySelector('[data-testid="composer-plus-sheet"]');
    if (!sheet) return { mounted: false, tiles: [] };
    const tiles = Array.from(sheet.querySelectorAll('button')).map((b) => ({
      name: (b.getAttribute('aria-label') || b.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30),
      vis: getComputedStyle(b).visibility,
    }));
    return { mounted: true, tiles };
  })()`);
}

test("the flock chat keeps the plus sheet's controls out of the keyboard until it is open", async ({ browser }) => {
  test.setTimeout(150_000);
  const me = await newPerson(browser, 'Wren');
  const page = me.page;
  await createFlock(page, `Plus Sheet ${Math.random().toString(36).slice(2, 6)}`);
  await page.waitForTimeout(1200);

  // NOT MOUNTED, not hidden, and the distinction is the whole test. The
  // controls these replaced were hidden with `maxWidth: 0` on a container that
  // kept them focusable, which is the defect this file was opened for.
  // ComposerPlusSheet answers `open === false` with null, so there is nothing
  // for the browser to focus at all. Asserting the absence rather than the
  // visibility is what keeps this honest: re-render it behind a hidden style
  // and this line goes red before anybody tabs into a sheet they cannot see.
  const shut = await plusSheetTiles(page);
  expect(shut.mounted, 'the plus sheet is in the DOM while it is closed').toBe(false);

  const closed = await focusableNames(page);
  for (const label of CHAT_PLUS_UNIQUE) {
    expect(closed, `"${label}" is focusable while the plus sheet is closed`).not.toContain(label);
  }
  // The door itself is reachable, which is the other half: hiding the controls
  // by removing the way to them would "pass" the line above.
  expect(closed).toContain('More to send');

  // And nothing else on this screen is a tab stop the eye cannot find.
  expect(await invisibleTabStops(page)).toEqual([]);

  // Tab from the top of the screen never reaches them either, and never lands
  // anywhere off screen.
  const walk = await tabWalk(page, 14);
  for (const stop of walk) {
    expect(CHAT_PLUS_UNIQUE, `Tab landed on the closed sheet's "${stop.name}"`).not.toContain(stop.name);
    expect(stop.onScreen, `Tab landed off screen on "${stop.name}"`).toBe(true);
  }

  // Opening it puts every one of them back, which is the other half of the fix:
  // dropping them permanently would "pass" this test and break the product. The
  // count floor is what stops this passing on an empty querySelectorAll after
  // somebody restructures the sheet.
  await page.getByRole('button', { name: 'More to send', exact: true }).click();
  await page.waitForTimeout(700);
  const open = await plusSheetTiles(page);
  expect(open.mounted, 'the plus sheet did not open').toBe(true);
  expect(open.tiles.length).toBeGreaterThanOrEqual(4);
  for (const t of open.tiles) {
    expect(t.vis, `"${t.name}" is unreachable even with the sheet open`).not.toBe('hidden');
  }
  const opened = await focusableNames(page);
  for (const label of CHAT_PLUS_UNIQUE) {
    expect(opened, `"${label}" is unreachable even with the sheet open`).toContain(label);
  }
  // The sheet scrolls inside its own maximum height, so it owns an `overflow`
  // of its own and can clip its last row out of sight while leaving it
  // focusable. That is the same defect, one surface along.
  expect(await invisibleTabStops(page)).toEqual([]);
  await me.context.close();
});

// ===========================================================================
// 2. DISCOVER: THE COLLAPSED HEADER AND THE PARKED EVENTS PANEL
// ===========================================================================

// The Messages tab renames itself when something is waiting on it: its
// accessible name becomes "Messages, 2 unread and 1 invite" and an exact match
// on "Messages" then finds nothing, which is a 135 second timeout rather than a
// failed assertion. Match the label as a prefix, for every tab, so the same
// thing on any other tab is a passing test and not a hang.
const tabName = (label) => new RegExp(`^${label}(,|$)`);

test('Discover hides its collapsed nav and its closed events panel from the keyboard', async ({ browser }) => {
  test.setTimeout(150_000);
  const me = await newPerson(browser, 'Robin');
  const page = me.page;

  await page.getByRole('navigation', { name: 'Main' })
    .getByRole('button', { name: tabName('Discover') }).click();
  // The map and its "we could not place you" path both settle inside this.
  //
  // THE PAUSE WAS NOT THE PROBLEM, AND LENGTHENING IT WAS THE WRONG FIX. A
  // previous pass read the clipped zoom controls below as a settle artefact and
  // recommended waiting longer. Measured on 2026-09-22, at 390x664 with
  // location denied and the analytics banner still unanswered: the map surface
  // is [0, 147, 390, 131] at 1.5s and still [0, 147, 390, 131] at 11s, with
  // MapLibre's canvas up and "Loading map..." long gone. It does not grow. The
  // controls sit at y 13 to 142, above the surface's own top edge, because they
  // are anchored 184px, 132px and 80px off the BOTTOM of a flex:1 box that is
  // shorter than 184px. So three of them paint nothing and stay in the
  // tab order, which is this file's founding defect, and it is the product's.
  // The wait stays where it was; the assertion below is right to be red.
  await page.waitForTimeout(2500);

  const collapsed = await focusableNames(page);
  for (const label of DISCOVER_NAV) {
    expect(collapsed, `"${label}" is focusable while the Discover nav is collapsed`).not.toContain(label);
  }
  // The events panel is parked off the right edge at translateX(100%). Its own
  // back arrow and its search box must not be reachable from the map.
  expect(collapsed, 'the closed events panel is still in the tab order').not.toContain('Search events');

  expect(await invisibleTabStops(page)).toEqual([]);

  const walk = await tabWalk(page, 14);
  for (const stop of walk) {
    expect(DISCOVER_NAV, `Tab landed on the collapsed "${stop.name}"`).not.toContain(stop.name);
    expect(stop.onScreen, `Tab landed off screen on "${stop.name}"`).toBe(true);
  }

  await page.getByRole('button', { name: 'Features', exact: true }).click();
  await page.waitForTimeout(700);
  const opened = await focusableNames(page);
  for (const label of DISCOVER_NAV) {
    expect(opened, `"${label}" is unreachable even with the nav open`).toContain(label);
  }

  // THE REGRESSION THAT WAS SHIPPED AND CAUGHT HERE. With the nav left open,
  // walk to another tab. The whole Discover screen goes `visibility: hidden`,
  // and a child that names `visibility: visible` for itself overrides that,
  // which put these three into the tab order of every other screen.
  await page.getByRole('navigation', { name: 'Main' })
    .getByRole('button', { name: tabName('Messages') }).click();
  await page.waitForTimeout(1500);
  const elsewhere = await focusableNames(page);
  for (const label of DISCOVER_NAV) {
    expect(elsewhere, `Discover's "${label}" leaked into the Messages tab`).not.toContain(label);
  }
  expect(await invisibleTabStops(page)).toEqual([]);
  await me.context.close();
});

// ===========================================================================
// 3. A SHEET, FROM THE KEYBOARD ONLY
// ===========================================================================

test('a sheet takes focus, traps Tab, closes on Escape and hands focus back to something visible', async ({ browser }) => {
  test.setTimeout(150_000);
  const me = await newPerson(browser, 'Lark');
  const page = me.page;
  await createFlock(page, `Sheet Focus ${Math.random().toString(36).slice(2, 6)}`);
  await page.waitForTimeout(1200);

  // Reach the vote sheet the way somebody with no pointer does: Tab to the
  // plus at the end of the composer, open it with a key, Tab to the control,
  // open it with a key. That route used to run through a "Features" pill in
  // the header; the pill is gone and the plus is the door now, and the point
  // of the test is that the door can be worked without a pointer at all.
  await page.evaluate('if (document.activeElement && document.activeElement.blur) document.activeElement.blur();');
  // MATCHED ON THE ACCESSIBLE NAME, not on aria-label alone. The header's
  // controls were icon-only and carried labels; the sheet's tiles are a glyph
  // and a VISIBLE word, so the word is the name and there is no aria-label to
  // read. An aria-label-only match walks past every tile and then reports that
  // Tab never reached one.
  const reach = async (label) => {
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Tab');
      const at = await page.evaluate(`(() => {
        const el = document.activeElement;
        if (!el) return '';
        return (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim();
      })()`);
      if (at === label) return true;
    }
    return false;
  };
  expect(await reach('More to send'), "Tab never reached the composer's plus button").toBe(true);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  expect(await reach('Vote on a venue'), 'Tab never reached the vote tile once the plus sheet was open').toBe(true);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);

  // The sheet is a dialog with a name, and focus is inside it.
  const opened = await page.evaluate(`(() => {
    const el = document.activeElement;
    const dlg = el && el.closest ? el.closest('[role="dialog"]') : null;
    return { inDialog: !!dlg, label: dlg && dlg.getAttribute('aria-label'), modal: dlg && dlg.getAttribute('aria-modal') };
  })()`);
  expect(opened.inDialog, 'opening the vote sheet left focus outside it').toBe(true);
  expect(opened.label).toBe('Vote on a venue');
  expect(opened.modal).toBe('true');

  // Tab stays inside for a full lap and more.
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(`!!(document.activeElement && document.activeElement.closest && document.activeElement.closest('[role="dialog"]'))`);
    expect(inside, `Tab escaped the vote sheet on press ${i + 1}`).toBe(true);
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);

  // Closed, and focus is on something a sighted keyboard user can see. This is
  // the assertion that used to fail: the control that opened this sheet hid
  // itself on the way, focus() on a hidden element is a silent no-op, and the
  // caret ended up on <body> with the screen scrolled back to the top.
  //
  // The route is new and the trap is WORSE on it, which is why this assertion
  // still earns its lines. The tile that opened the vote sheet lived in the
  // plus sheet, and the plus sheet shut itself on the way through and
  // UNMOUNTED: the element to hand focus back to is not hidden now, it is gone
  // from the document. Anything restoring to a detached node lands on <body>
  // just the same, and this catches it the same way.
  const after = await page.evaluate(`(() => {
    // THE VOTE SHEET, not every dialog on the page. The analytics consent
    // banner is a role="dialog" of its own and it sits on every signed-in
    // screen until somebody answers it, so a bare count is never 0: this read
    // "Escape did not close the vote sheet" about a chat that had closed it
    // perfectly. Naming the sheet is the stricter claim anyway, because a
    // count can also fall to zero because the wrong thing closed.
    const dialogs = document.querySelectorAll('[role="dialog"][aria-label="Vote on a venue"]').length;
    const el = document.activeElement;
    if (!el || el === document.body) return { dialogs, name: '(body)', onScreen: false, vis: 'n/a' };
    const r = el.getBoundingClientRect();
    return {
      dialogs,
      name: (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
      onScreen: r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0
        && r.left < window.innerWidth && r.top < window.innerHeight,
      vis: getComputedStyle(el).visibility,
    };
  })()`);
  expect(after.dialogs, 'Escape did not close the vote sheet').toBe(0);
  expect(after.name, 'closing the sheet dropped focus on the document body').not.toBe('(body)');
  expect(after.vis).toBe('visible');
  expect(after.onScreen, `focus came back to "${after.name}", which is off screen`).toBe(true);
  await me.context.close();
});

// ===========================================================================
// 4. THE GENERAL SWEEP
// ===========================================================================

test('no screen in the core loop has a tab stop the eye cannot find', async ({ browser }) => {
  test.setTimeout(200_000);
  const me = await newPerson(browser, 'Finch');
  const page = me.page;
  const nav = () => page.getByRole('navigation', { name: 'Main' });

  const check = async (label) => {
    const bad = await invisibleTabStops(page);
    expect(bad, `${label} has focusable controls clipped out of sight`).toEqual([]);
  };

  await check('Nest');

  for (const tab of ['Discover', 'Plans', 'Messages', 'You']) {
    await nav().getByRole('button', { name: tabName(tab) }).click();
    await page.waitForTimeout(tab === 'Discover' ? 2500 : 1500);
    await check(tab);
  }

  await nav().getByRole('button', { name: tabName('Nest') }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: /start a flock/i }).first().click();
  await expect(page.getByRole('heading', { name: /start a flock/i })).toBeVisible();
  await check('Start a flock');

  const flockName = `Sweep ${Math.random().toString(36).slice(2, 6)}`;
  await page.getByLabel(/what.s the plan/i).fill(flockName);
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /create flock/i }).click();
  // The share step is a screen of the core loop too, and it is the one every
  // new flock passes through, so it gets swept before "Not now" goes past it.
  await expect(page.getByRole('heading', { name: `${flockName} is made.`, exact: true }))
    .toBeVisible({ timeout: 25_000 });
  await check('The share step');
  await page.getByRole('button', { name: /^not now$/i }).click();
  await expect(page.getByRole('button', { name: 'Open the plan' }))
    .toContainText(flockName, { timeout: 25_000 });
  await page.waitForTimeout(1500);
  await check('Flock chat');

  // The five controls the header used to carry are behind this now.
  await page.getByRole('button', { name: 'More to send', exact: true }).click();
  await page.waitForTimeout(700);
  await check('Flock chat, plus sheet open');
  await me.context.close();
});
