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
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 25_000 });
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

// The four in the flock chat header. "Invite friends" is deliberately NOT in
// this list even though the header holds one: the empty chat body has a second
// button by that exact name which is on screen and must stay reachable, so a
// name-only assertion cannot tell the two apart. The header group as a whole is
// checked by `collapsedGroupOf` instead, which reads the DOM rather than names.
const CHAT_NAV_UNIQUE = ['Vote on a venue', 'Search messages', 'Group cash pool'];
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
// 1. THE COLLAPSED FLOCK CHAT HEADER
// ===========================================================================

test('the flock chat header nav is out of the keyboard and the tree while collapsed', async ({ browser }) => {
  test.setTimeout(150_000);
  const me = await newPerson(browser, 'Wren');
  const page = me.page;
  await createFlock(page, `Collapsed Nav ${Math.random().toString(36).slice(2, 6)}`);
  await page.waitForTimeout(1200);

  // The whole group, read out of the DOM. All four are still there, which is
  // the point: the defect was never that they exist, it is that the browser
  // would focus them. The count floor is what stops this passing on an empty
  // querySelectorAll after somebody restructures the header.
  const collapsedGroup = await collapsedGroupOf(page, 'Vote on a venue');
  expect(collapsedGroup.found, 'no "Vote on a venue" control in the flock chat header').toBe(true);
  expect(collapsedGroup.buttons.length).toBeGreaterThanOrEqual(4);
  expect(collapsedGroup.vis).toBe('hidden');
  for (const b of collapsedGroup.buttons) {
    expect(b.vis, `"${b.name}" is still visible inside the collapsed header group`).toBe('hidden');
  }

  const collapsed = await focusableNames(page);
  for (const label of CHAT_NAV_UNIQUE) {
    expect(collapsed, `"${label}" is focusable while the header nav is collapsed`).not.toContain(label);
  }
  expect(collapsed).toContain('Features');

  // And nothing else on this screen is a tab stop the eye cannot find.
  expect(await invisibleTabStops(page)).toEqual([]);

  // Tab from the top of the screen never reaches them either, and never lands
  // anywhere off screen.
  const walk = await tabWalk(page, 14);
  for (const stop of walk) {
    expect(CHAT_NAV_UNIQUE, `Tab landed on the collapsed "${stop.name}"`).not.toContain(stop.name);
    expect(stop.onScreen, `Tab landed off screen on "${stop.name}"`).toBe(true);
  }

  // Opening the group puts all four back, which is the other half of the fix:
  // hiding them permanently would "pass" this test and break the product.
  await page.getByRole('button', { name: 'Features', exact: true }).click();
  await page.waitForTimeout(700);
  const openedGroup = await collapsedGroupOf(page, 'Vote on a venue');
  for (const b of openedGroup.buttons) {
    expect(b.vis, `"${b.name}" is unreachable even with the nav open`).not.toBe('hidden');
  }
  const opened = await focusableNames(page);
  for (const label of CHAT_NAV_UNIQUE) {
    expect(opened, `"${label}" is unreachable even with the nav open`).toContain(label);
  }
  await me.context.close();
});

// ===========================================================================
// 2. DISCOVER: THE COLLAPSED HEADER AND THE PARKED EVENTS PANEL
// ===========================================================================

test('Discover hides its collapsed nav and its closed events panel from the keyboard', async ({ browser }) => {
  test.setTimeout(150_000);
  const me = await newPerson(browser, 'Robin');
  const page = me.page;

  await page.getByRole('navigation', { name: 'Main' })
    .getByRole('button', { name: 'Discover', exact: true }).click();
  // The map and its "we could not place you" path both settle inside this.
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
    .getByRole('button', { name: /^Messages(, .* unread)?$/ }).click();
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
  // Features pill, open it with a key, Tab to the control, open it with a key.
  await page.evaluate('if (document.activeElement && document.activeElement.blur) document.activeElement.blur();');
  const reach = async (label) => {
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press('Tab');
      const at = await page.evaluate(`(document.activeElement && (document.activeElement.getAttribute('aria-label') || '')) || ''`);
      if (at === label) return true;
    }
    return false;
  };
  expect(await reach('Features'), 'Tab never reached the Features button').toBe(true);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  expect(await reach('Vote on a venue'), 'Tab never reached the vote control once the nav was open').toBe(true);
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
  // the assertion that used to fail: the control that opened this sheet hides
  // itself on the way, focus() on it is a silent no-op, and the caret ended up
  // on <body> with the screen scrolled back to the top.
  const after = await page.evaluate(`(() => {
    const dialogs = document.querySelectorAll('[role="dialog"]').length;
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
    await nav().getByRole('button', { name: tab, exact: true }).click();
    await page.waitForTimeout(tab === 'Discover' ? 2500 : 1500);
    await check(tab);
  }

  await nav().getByRole('button', { name: 'Nest', exact: true }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: /start a flock/i }).first().click();
  await expect(page.getByRole('heading', { name: /start a flock/i })).toBeVisible();
  await check('Start a flock');

  const flockName = `Sweep ${Math.random().toString(36).slice(2, 6)}`;
  await page.getByLabel(/what.s the plan/i).fill(flockName);
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /create flock/i }).click();
  await expect(page.getByRole('heading', { name: flockName, exact: true })).toBeVisible({ timeout: 25_000 });
  await page.waitForTimeout(1500);
  await check('Flock chat');

  await page.getByRole('button', { name: 'Features', exact: true }).click();
  await page.waitForTimeout(700);
  await check('Flock chat, features open');
  await me.context.close();
});
