/* The back half of the core loop, driven through the screen.
 *
 * Venues, voting, budget matching and confirming the plan, plus Discover.
 *
 * THE CONDITION THIS RUNS UNDER, WHICH IS THE POINT RATHER THAN A PROBLEM.
 * tools/e2e/stack.js sets no GOOGLE_PLACES_API_KEY and no MapTiler key, on
 * purpose, so a run that clicks every button a few hundred times cannot spend
 * money. So venue SEARCH fails on every call and the basemap has no tiles.
 * What these specs judge is not whether venues appear. It is whether a person
 * is TOLD what went wrong, in words they can act on, instead of being shown a
 * blank panel, a spinner that never ends, or invented venues. Both of those
 * last two have shipped here before: a failed search once rendered as eight
 * fabricated Lehigh Valley bars with invented ratings, and a missing location
 * once rendered as a silent claim that the user was standing in Bethlehem, PA.
 */
'use strict';

const path = require('path');
const { createRequire } = require('module');
const { test, expect, devices } = require('@playwright/test');
const { newEmail, adultDob, pinToLocalApi, failOnPageErrors } = require('./helpers');

const WEB_BASE = `http://127.0.0.1:${process.env.E2E_WEB_PORT || 3199}`;

// Every context is built explicitly rather than leaning on the config's `use`,
// because the multi person specs below make their own contexts and a context
// that quietly picked up a desktop viewport or a GRANTED location permission
// would be testing something other than the product on a phone.
const PHONE = { ...devices['iPhone 13'], baseURL: WEB_BASE, permissions: [] };

// ---------------------------------------------------------------------------
// THE TWO PIECES OF SETUP THAT CANNOT COME THROUGH THE SCREEN, AND WHY.
// ---------------------------------------------------------------------------
// Everything these specs ASSERT on is driven through the UI. Two things they
// only SET UP are not reachable that way in this stack, and both would
// otherwise make the whole area untestable:
//
//   1. Email confirmation. Signup ends on a wall that says "Confirm your
//      email", and POST /api/flocks sits behind requireVerified, so an account
//      that cannot open the link can never create a flock. There is no Resend
//      key here so the mail is never sent; the backend prints the link to its
//      own stdout, which a spec in another process cannot read, and the
//      token's secret half is stored only as a hash so it cannot be recovered
//      from the database either. verifyByHand runs the SAME statement the real
//      route runs (routes/auth.js: email_verified TRUE, verified_email =
//      email) and nothing else.
//
//   2. One venue to vote on. With Places dead there is NO path in the product
//      that puts a venue in front of a flock: search is down, the map has no
//      pins, and the vote panel's suggestions come from that same dead search.
//      That absence is itself asserted below. So the voting specs seed a venue
//      as a row that already exists, which is what the brief allows, and then
//      do every vote through the screen.
const backendRequire = createRequire(path.join(__dirname, '..', '..', 'backend', 'package.json'));
const { Client } = backendRequire('pg');
const PG_PORT = Number(process.env.E2E_PG_PORT || 59610);
const DB_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_e2e`;

async function withDb(fn) {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function verifyByHand(email) {
  const rows = await withDb((c) => c.query(
    'UPDATE users SET email_verified = TRUE, verified_email = email WHERE email = $1 RETURNING id',
    [email],
  ).then((r) => r.rows));
  // Loud on purpose. Addresses are lowercased on the way in, so a tag carrying
  // a capital letter silently matched nothing here, every account stayed
  // unverified, and the first sign of trouble was a 403 several screens later
  // that looked exactly like a product bug.
  if (!rows[0]) throw new Error(`verifyByHand matched no account for ${email}`);
  return rows[0].id;
}

const PASSWORD = 'E2eTesting!2026';
const FLOCK_NAME = 'Vote Night';

/** Sign up through the real screens, confirm, then sign in. */
async function signUpVerified(page, name) {
  const email = newEmail('venue');
  await page.goto('/app');
  await page.getByRole('button', { name: /create an account/i }).click();
  await page.getByRole('textbox', { name: /^name$/i }).fill(name);
  await page.getByRole('textbox', { name: /email/i }).fill(email);
  await page.getByRole('textbox', { name: /password/i }).first().fill(PASSWORD);
  const dob = page.getByRole('textbox', { name: /birth|date/i }).first();
  if (await dob.count()) await dob.fill(adultDob());
  await page.getByRole('button', { name: /create account|sign up|continue/i }).first().click();

  await expect(page.getByRole('heading', { name: /confirm your email/i })).toBeVisible({ timeout: 25_000 });
  const id = await verifyByHand(email);

  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.getByRole('textbox', { name: /email/i }).fill(email);
  await page.getByRole('textbox', { name: /password/i }).first().fill(PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByRole('button', { name: /^start a flock$/i })).toBeVisible({ timeout: 40_000 });
  return { email, id, name };
}

/** A phone, signed in, with the network pinned to the local API. */
async function newSignedInPhone(browser, name, errors) {
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  failOnPageErrors(page, errors);
  const offences = pinToLocalApi(page);
  const account = await signUpVerified(page, name);
  return { context, page, account, offences };
}

/**
 * Create a flock through the create screen, inviting the named people.
 *
 * Two invitees, never one. A flock of two is a direct message in this product
 * (the create screen swaps its own button for "Message ..."), and three is
 * also the floor the budget's privacy rule needs.
 */
async function createFlock(page, inviteeNames, { budget = false } = {}) {
  await page.getByRole('button', { name: /^start a flock$/i }).click();
  await page.getByRole('textbox', { name: /what's the plan/i }).fill(FLOCK_NAME);
  if (budget) await page.getByRole('switch', { name: 'Shared cash pool' }).click();
  for (const who of inviteeNames) {
    await page.getByRole('textbox', { name: /search people by name/i }).fill(who);
    await expect(page.getByRole('button', { name: new RegExp(who) }).first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: new RegExp(who) }).first().click();
  }
  await page.getByRole('button', { name: /create flock/i }).click();
  // The creator lands straight in the flock chat.
  await expect(page.getByRole('button', { name: 'Features' })).toBeVisible({ timeout: 40_000 });
}

/** Accept the invite from where the product actually puts it, the Messages tab. */
async function acceptInvite(page) {
  await page.reload();
  await page.getByRole('button', { name: /^Messages(, .* unread)?$/ }).click();
  await page.getByRole('button', { name: /accept invite/i }).click({ timeout: 40_000 });
  await expect(page.getByRole('button', { name: new RegExp(FLOCK_NAME) }).first()).toBeVisible({ timeout: 25_000 });
}

/** Open the flock chat from wherever we are. */
async function openFlock(page) {
  if (await page.getByRole('button', { name: 'Features' }).count()) return;
  await page.getByRole('button', { name: /^Messages(, .* unread)?$/ }).click();
  await page.getByRole('button', { name: new RegExp(FLOCK_NAME) }).first().click();
  await expect(page.getByRole('button', { name: 'Features' })).toBeVisible({ timeout: 25_000 });
}

/**
 * Leave the flock and come back.
 *
 * This is how the peer assertions below read a change, rather than waiting on
 * a socket. Re-entering refetches the tallies and the budget over REST, so the
 * assertion is about what the other person SEES rather than about whether one
 * particular transport happened to be up. That is deliberate: the live push was
 * watched working by hand, but a spec that depends on a socket being connected
 * fails for reasons that have nothing to do with the product. It was starving
 * outright while this was written, because the handshake ceiling counted every
 * browser on 127.0.0.1 as one client; server.js has since been raised, and the
 * assertions here still do not lean on it.
 */
async function reenterFlock(page) {
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: /^Messages(, .* unread)?$/ }).click();
  await page.getByRole('button', { name: new RegExp(FLOCK_NAME) }).first().click();
  await expect(page.getByRole('button', { name: 'Features' })).toBeVisible({ timeout: 25_000 });
}

/** The vote panel lives behind the collapsed header nav. */
async function openVotePanel(page) {
  await page.getByRole('button', { name: 'Features' }).click();
  await page.getByRole('button', { name: 'Vote on a venue' }).click();
  await expect(page.getByRole('heading', { name: /vote for a venue/i })).toBeVisible({ timeout: 20_000 });
}

/**
 * So does the cash pool, and this route is used rather than the strip in the
 * chat body on purpose: the strip is missing for anyone who joined by accepting
 * an invite in this session, which is its own finding and has its own spec
 * below. Everything else about the budget has to be testable regardless.
 */
async function openCashPool(page) {
  await page.getByRole('button', { name: 'Features' }).click();
  await page.getByRole('button', { name: 'Group cash pool', exact: true }).click();
  await expect(sheet(page)).toBeVisible({ timeout: 20_000 });
}

function sheet(page) {
  return page.locator('.modal-content').last();
}

/** Tap a venue row without hitting the Confirm button nested at its right end. */
async function tapVenueRow(page, venue) {
  await sheet(page).getByRole('button', { name: new RegExp(`^${venue}`) }).first()
    .click({ position: { x: 60, y: 25 } });
}

/** Give the newest flock a venue, plus one venue somebody already suggested. */
async function seedVenuesOnLatestFlock(suggesterName) {
  return withDb(async (c) => {
    const flockId = (await c.query('SELECT id FROM flocks ORDER BY id DESC LIMIT 1')).rows[0].id;
    const suggester = (await c.query('SELECT id FROM users WHERE name = $1', [suggesterName])).rows[0].id;
    await c.query(
      "UPDATE flocks SET venue_name = 'The Wren Room', venue_address = '12 Aviary Lane' WHERE id = $1",
      [flockId],
    );
    // The same row shape POST /api/flocks/:id/vote writes, so the second venue
    // is a thing a member put on the table rather than a fixture the UI has to
    // understand specially.
    await c.query(
      "INSERT INTO venue_votes (flock_id, user_id, venue_name) VALUES ($1, $2, 'Corvid Coffee')",
      [flockId, suggester],
    );
    return flockId;
  });
}

function tag() {
  return Math.random().toString(36).slice(2, 7);
}

// ===========================================================================
// DISCOVER, AND THE LOCATION SWITCH THAT GOVERNS IT
// ===========================================================================

test('Discover explains a refused location instead of pretending to know where you are', async ({ browser }) => {
  test.setTimeout(150_000);
  const errors = [];
  const me = await newSignedInPhone(browser, 'Wren Denied', errors);

  await me.page.getByRole('button', { name: 'Discover', exact: true }).click();

  // Geolocation is denied in the config, so this is the path a real person who
  // taps "Don't allow" takes. It has to be said on the screen.
  await expect(me.page.getByText(/location is off/i).first()).toBeVisible({ timeout: 25_000 });

  // And no invented location. The fallback used to be a fixed point in
  // Bethlehem, Pennsylvania, WRITTEN to localStorage, so the blue dot, the
  // search bias and every distance label came from a town the user had never
  // been to.
  await expect(me.page.locator('body')).not.toContainText(/bethlehem/i);
  const saved = await me.page.evaluate(() => [
    localStorage.getItem('flock_user_lat'),
    localStorage.getItem('flock_user_lng'),
  ]);
  expect(saved).toEqual([null, null]);

  expect(errors).toEqual([]);
  expect(me.offences).toEqual([]);
  await me.context.close();
});

test('with Location services off, Discover says so and nothing asks the device anyway', async ({ browser }) => {
  test.setTimeout(150_000);
  const errors = [];
  const context = await browser.newContext(PHONE);

  // Record every geolocation ask before any app code runs. A switch that
  // reports a state it does not enforce is worse than no switch at all,
  // because the person believes they have already handled it.
  await context.addInitScript(() => {
    window.__geoAsks = [];
    const geo = navigator.geolocation;
    if (!geo) return;
    const get = geo.getCurrentPosition.bind(geo);
    geo.getCurrentPosition = function (...args) { window.__geoAsks.push('getCurrentPosition'); return get(...args); };
    const watch = geo.watchPosition.bind(geo);
    geo.watchPosition = function (...args) { window.__geoAsks.push('watchPosition'); return watch(...args); };
  });

  const page = await context.newPage();
  failOnPageErrors(page, errors);
  await signUpVerified(page, 'Wren Switch');

  await page.getByRole('button', { name: 'You', exact: true }).click();
  const toggle = page.getByRole('switch', { name: 'Location services' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText(/location is turned off/i)).toBeVisible();

  // Turning the switch off must not itself ask.
  expect(await page.evaluate(() => window.__geoAsks)).toEqual([]);

  await page.getByRole('button', { name: 'Discover', exact: true }).click();

  // The screen the setting governs says what the setting did, and offers the
  // way back rather than sending the person to Settings to find the row again.
  await expect(page.getByText(/location services are off/i)).toBeVisible({ timeout: 25_000 });
  await expect(page.getByRole('button', { name: /^turn on$/i })).toBeVisible();

  // THE WHOLE POINT OF THE SWITCH. With it off, neither Discover nor the map
  // may ask the device where you are. On a phone each of these calls raises an
  // OS permission prompt, which is the exact thing the person just declined.
  await page.waitForTimeout(5000);
  expect(await page.evaluate(() => window.__geoAsks)).toEqual([]);

  expect(errors).toEqual([]);
  await context.close();
});

test('tapping Turn on when the device refuses still leaves a sentence on the screen', async ({ browser }) => {
  test.setTimeout(150_000);
  const errors = [];
  const me = await newSignedInPhone(browser, 'Wren Recover', errors);
  const { page } = me;

  await page.getByRole('button', { name: 'You', exact: true }).click();
  await page.getByRole('switch', { name: 'Location services' }).click();
  await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await expect(page.getByText(/location services are off/i)).toBeVisible({ timeout: 25_000 });

  await page.getByRole('button', { name: /^turn on$/i }).click();

  // The device permission is denied, so switching the setting back on cannot
  // give the app a location. The banner that WAS explaining the empty map
  // disappears the moment the setting flips, so unless something replaces it
  // the person is left holding a map that knows nothing about them and a
  // button that looked like it worked.
  await expect(page.getByText(/location (services are|is) off/i).first())
    .toBeVisible({ timeout: 20_000 });

  expect(errors).toEqual([]);
  await me.context.close();
});

test('a venue search that fails says so in words a person can act on, and invents nothing', async ({ browser }) => {
  test.setTimeout(150_000);
  const errors = [];
  const me = await newSignedInPhone(browser, 'Wren Search', errors);
  const { page } = me;

  await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await page.getByRole('textbox', { name: /search venues/i }).fill('pizza');

  // Something has to appear. A search that fails silently, or spins forever,
  // is half of what this file exists to catch.
  const failure = page.getByRole('alert').first();
  await expect(failure).toBeVisible({ timeout: 30_000 });

  // The other half. Eight hardcoded bars with invented ratings and place ids
  // of seed_1 through seed_8 used to be swapped in on exactly this path.
  await expect(page.getByRole('button', { name: /see all results/i })).toHaveCount(0);

  // And it must not be the server's internal wording either. "Google Places
  // API key not configured" tells a person nothing they can act on, and names
  // a piece of server configuration on a consumer screen.
  const said = (await failure.innerText()).trim();
  expect(said, 'the failure copy shown to the user').not.toMatch(/api key|api_key|not configured/i);

  expect(errors).toEqual([]);
  expect(me.offences).toEqual([]);
  await me.context.close();
});

// ===========================================================================
// PUTTING A VENUE ON THE TABLE WHEN SEARCH IS DOWN
// ===========================================================================

test('the last route to a venue is not a blank panel', async ({ browser }) => {
  test.setTimeout(300_000);
  const errors = [];
  const t = tag();
  const alpha = await newSignedInPhone(browser, `Alpha ${t}`, errors);
  const bravo = await newSignedInPhone(browser, `Bravo ${t}`, errors);
  const charlie = await newSignedInPhone(browser, `Charlie ${t}`, errors);

  await createFlock(alpha.page, [`Bravo ${t}`, `Charlie ${t}`]);
  await openVotePanel(alpha.page);

  // Nothing to vote on, which is honest and correct with search down.
  await expect(sheet(alpha.page).getByText(/no votes yet/i)).toBeVisible();

  // The one action the panel still offers.
  await sheet(alpha.page).getByRole('button', { name: /share a venue to chat/i }).click();
  await expect(alpha.page.getByRole('heading', { name: /share a venue/i })).toBeVisible({ timeout: 20_000 });

  // A sheet that says "Pick one below" and then lists nothing, with no reason
  // given and no way forward, IS the blank panel. Either it offers a venue or
  // it says why it cannot.
  const share = sheet(alpha.page);
  const controls = await share.getByRole('button').count();
  const text = await share.innerText();
  const explains = /not answering|not responding|cannot|can't|unavailable|try again|no venue/i.test(text);
  expect(
    controls > 1 || explains,
    `The share sheet offered no venue and no explanation. It said: ${JSON.stringify(text)}`,
  ).toBe(true);

  expect(errors).toEqual([]);
  for (const p of [alpha, bravo, charlie]) await p.context.close();
});

// ===========================================================================
// VOTING
// ===========================================================================

test('a vote can be cast, moved and taken back, and every surface agrees', async ({ browser }) => {
  test.setTimeout(420_000);
  const errors = [];
  const t = tag();
  const alpha = await newSignedInPhone(browser, `Alpha ${t}`, errors);
  const bravo = await newSignedInPhone(browser, `Bravo ${t}`, errors);
  const charlie = await newSignedInPhone(browser, `Charlie ${t}`, errors);

  await createFlock(alpha.page, [`Bravo ${t}`, `Charlie ${t}`]);
  await acceptInvite(bravo.page);
  await acceptInvite(charlie.page);
  await seedVenuesOnLatestFlock(`Charlie ${t}`);

  await alpha.page.reload();
  await openFlock(alpha.page);
  await openVotePanel(alpha.page);
  await expect(sheet(alpha.page).getByText(/^1 vote cast/)).toBeVisible({ timeout: 20_000 });

  // CAST. Tapping the flock's own venue is a vote for it.
  await tapVenueRow(alpha.page, 'The Wren Room');
  await expect(sheet(alpha.page).getByText(/you voted for The Wren Room/i)).toBeVisible({ timeout: 20_000 });
  await expect(sheet(alpha.page).getByText(/^2 votes cast/)).toBeVisible();

  // MOVE. One vote per person, so this has to leave the first venue behind.
  await tapVenueRow(alpha.page, 'Corvid Coffee');
  await expect(sheet(alpha.page).getByText(/you voted for Corvid Coffee/i)).toBeVisible({ timeout: 20_000 });
  await expect(sheet(alpha.page).getByText(/^2 votes cast/)).toBeVisible();
  await expect(sheet(alpha.page).getByRole('button', { name: /^The Wren Room/ })).toContainText(/tap to vote/i);

  // THE OTHER PERSON SEES IT.
  await openFlock(bravo.page);
  await openVotePanel(bravo.page);
  await expect(sheet(bravo.page).getByRole('button', { name: /^Corvid Coffee/ })).toContainText(`Alpha ${t}`);
  await expect(sheet(bravo.page).getByText(/^2 votes cast/)).toBeVisible();
  // Bravo has cast nothing, so nothing on Bravo's screen may claim otherwise.
  await expect(sheet(bravo.page).getByText(/you voted for/i)).toHaveCount(0);

  // THE SECOND SURFACE THAT SHOWS TALLIES, which is the flock detail screen.
  await sheet(alpha.page).getByRole('button', { name: /^close$/i }).click();
  await alpha.page.getByRole('button', { name: 'Back', exact: true }).click();
  await alpha.page.getByRole('button', { name: 'Nest', exact: true }).click();
  await alpha.page.getByRole('button', { name: new RegExp(FLOCK_NAME) }).first().click();
  await expect(alpha.page.getByText(/venue votes/i)).toBeVisible({ timeout: 25_000 });
  await expect(alpha.page.getByRole('button', { name: /^Corvid Coffee/ })).toContainText('2');

  // WITHDRAW, back in the panel.
  await alpha.page.getByRole('button', { name: /open chat/i }).click();
  await openVotePanel(alpha.page);
  await tapVenueRow(alpha.page, 'Corvid Coffee');
  await expect(sheet(alpha.page).getByText(/^1 vote cast/)).toBeVisible({ timeout: 20_000 });
  await expect(sheet(alpha.page).getByText(/you voted for/i)).toHaveCount(0);

  // And taking it back reaches the other person too, rather than living only
  // in the browser that did it.
  await sheet(bravo.page).getByRole('button', { name: /^close$/i }).click();
  await reenterFlock(bravo.page);
  await openVotePanel(bravo.page);
  await expect(sheet(bravo.page).getByText(/^1 vote cast/)).toBeVisible({ timeout: 20_000 });
  await expect(sheet(bravo.page).getByRole('button', { name: /^Corvid Coffee/ })).not.toContainText(`Alpha ${t}`);

  expect(errors).toEqual([]);
  for (const p of [alpha, bravo, charlie]) await p.context.close();
});

test('the home screen stops asking for a vote once you have cast one', async ({ browser }) => {
  test.setTimeout(360_000);
  const errors = [];
  const t = tag();
  const alpha = await newSignedInPhone(browser, `Alpha ${t}`, errors);
  const bravo = await newSignedInPhone(browser, `Bravo ${t}`, errors);
  const charlie = await newSignedInPhone(browser, `Charlie ${t}`, errors);

  await createFlock(alpha.page, [`Bravo ${t}`, `Charlie ${t}`]);
  await acceptInvite(bravo.page);
  await acceptInvite(charlie.page);
  await seedVenuesOnLatestFlock(`Charlie ${t}`);

  await alpha.page.reload();
  await openFlock(alpha.page);
  await openVotePanel(alpha.page);
  await tapVenueRow(alpha.page, 'Corvid Coffee');
  await expect(sheet(alpha.page).getByText(/you voted for Corvid Coffee/i)).toBeVisible({ timeout: 20_000 });

  await sheet(alpha.page).getByRole('button', { name: /^close$/i }).click();
  await alpha.page.getByRole('button', { name: 'Back', exact: true }).click();
  await alpha.page.getByRole('button', { name: 'Nest', exact: true }).click();
  await expect(alpha.page.getByRole('button', { name: new RegExp(FLOCK_NAME) }).first())
    .toBeVisible({ timeout: 25_000 });

  // The card that pulls you into a flock is the first thing on the home
  // screen and it is addressed to YOU. Telling somebody who has just voted
  // that their vote is still needed is the app being wrong about the one fact
  // it certainly knows.
  await expect(alpha.page.getByText(/needs your vote/i)).toHaveCount(0);

  expect(errors).toEqual([]);
  for (const p of [alpha, bravo, charlie]) await p.context.close();
});

// ===========================================================================
// BUDGET MATCHING
// ===========================================================================

/*
 * The three amounts are chosen so the published number equals none of them.
 * The ceiling is the MINIMUM, banded downward, so 277.11 publishes as 270. If
 * the band ever stopped being applied, the screen would read 277.11 and this
 * spec would say so.
 *
 * They carry cents for a second reason: the leak scan below looks for these
 * exact figures anywhere in anything Bravo's browser receives, and a bare
 * integer would eventually collide with an unrelated id or count in a shared
 * database whose serials keep climbing. "413.37" collides with nothing.
 */
const AMOUNT_ALPHA = 413.37;
const AMOUNT_BRAVO = 277.11;
const AMOUNT_CHARLIE = 529.53;
const EXPECTED_BAND = 270;

async function submitBudget(page, amount) {
  await openCashPool(page);
  const pool = sheet(page);
  await expect(pool.getByText(/what's your budget tonight/i)).toBeVisible({ timeout: 20_000 });
  const field = pool.getByRole('spinbutton', { name: /amount/i });
  await field.fill(String(amount));
  // The amount box hands its value up on a 120ms debounce rather than on blur
  // (SearchInputLocal in App.js), so a Submit tapped straight after typing
  // reads an empty amount and answers "Select or enter an amount". Wait past
  // the debounce, then hold the request itself rather than trusting the toast:
  // a submission that never left the browser and a toast that came and went
  // look identical from here, and only one of them is a working product.
  await page.waitForTimeout(600);
  const posted = page.waitForResponse(
    (r) => /\/api\/budget\/\d+\/submit/.test(r.url()) && r.request().method() === 'POST',
    { timeout: 30_000 },
  );
  // Both watches are armed BEFORE the tap. The person who answers last settles
  // the budget, and their screen gets two messages in quick succession, the
  // submission's own and the one announcing the group number, in a single toast
  // slot. Whichever is on screen when this looks, something told them it
  // worked, which is the thing being asserted.
  const said = expect(page.getByText(/budget submitted|budget set/i).first())
    .toBeVisible({ timeout: 30_000 });
  await pool.getByRole('button', { name: /^submit$/i }).click();
  expect((await posted).status(), 'the budget submission').toBe(200);
  await said;
  // And the form is gone, rather than sitting there still asking.
  await expect(page.getByText(/what's your budget tonight/i)).toHaveCount(0, { timeout: 20_000 });
}

/** Record every response body and every socket frame this page receives. */
function recordInbound(page) {
  const seen = [];
  page.on('response', async (res) => {
    if (!res.url().includes('/api/')) return;
    let body = '';
    try { body = await res.text(); } catch { return; }
    seen.push({ where: res.url().replace(/^https?:\/\/[^/]+/, ''), body });
  });
  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => seen.push({ where: 'socket', body: String(frame.payload) }));
  });
  return seen;
}

test('the group budget is one band everyone shares, and nobody else ever sees your number', async ({ browser }) => {
  test.setTimeout(420_000);
  const errors = [];
  const t = tag();
  const alpha = await newSignedInPhone(browser, `Alpha ${t}`, errors);
  const bravo = await newSignedInPhone(browser, `Bravo ${t}`, errors);
  const charlie = await newSignedInPhone(browser, `Charlie ${t}`, errors);

  await createFlock(alpha.page, [`Bravo ${t}`, `Charlie ${t}`], { budget: true });
  await acceptInvite(bravo.page);
  await acceptInvite(charlie.page);

  // Reopen the app for the two who joined by invite. This is a workaround for
  // the defect the previous spec pins, not a normal step: until the app is
  // loaded fresh, their copy of the flock is the trimmed preview the server
  // hands a non member, so it carries no budget flag and the cash pool shows
  // them bill splitting instead. Without this the privacy proof below could
  // not run at all, and the privacy proof is the more important of the two.
  await bravo.page.reload();
  await charlie.page.reload();

  // Watch Bravo's wire from the moment Bravo walks into the flock.
  const bravoSaw = recordInbound(bravo.page);
  await openFlock(bravo.page);
  await openFlock(charlie.page);
  await openFlock(alpha.page);

  await submitBudget(alpha.page, AMOUNT_ALPHA);
  await submitBudget(bravo.page, AMOUNT_BRAVO);
  await submitBudget(charlie.page, AMOUNT_CHARLIE);

  // ONE NUMBER, THE SAME ONE, FOR EVERYONE.
  for (const p of [alpha, bravo, charlie]) {
    await reenterFlock(p.page);
    await openCashPool(p.page);
    await expect(sheet(p.page).getByText(new RegExp(`up to \\$${EXPECTED_BAND} per person`, 'i')))
      .toBeVisible({ timeout: 25_000 });
  }

  // THE PRIVACY RULE, WHICH IS ABSOLUTE. Bravo's browser may know Bravo's own
  // amount and the published band. It may not learn Alpha's or Charlie's, on
  // any transport, at any moment.
  const forbidden = [AMOUNT_ALPHA, AMOUNT_CHARLIE].map(String);
  const leaks = bravoSaw.filter((e) => forbidden.some((n) => e.body.includes(n)));
  expect(leaks.map((l) => `${l.where}: ${l.body.slice(0, 300)}`)).toEqual([]);

  // And the budget payloads carry nothing but the aggregate plus the caller's
  // own answer. Written as an allowlist rather than as an absence, because a
  // field added later leaks by existing.
  const allowed = new Set([
    'budgetEnabled', 'budgetContext', 'budgetLocked', 'ceiling', 'submissionCount',
    'totalMembers', 'isReady', 'skipCount', 'userSubmitted', 'userAmount', 'userSkipped',
    'submitted', 'error',
  ]);
  const budgetPayloads = bravoSaw.filter((e) => e.where.includes('/api/budget/'));
  expect(budgetPayloads.length).toBeGreaterThan(0);
  for (const payload of budgetPayloads) {
    const json = JSON.parse(payload.body);
    for (const key of Object.keys(json)) {
      expect(allowed.has(key), `unexpected budget field ${key} in ${payload.where}`).toBe(true);
    }
    if (json.userAmount != null) expect(json.userAmount).toBe(AMOUNT_BRAVO);
  }

  expect(errors).toEqual([]);
  for (const p of [alpha, bravo, charlie]) await p.context.close();
});

test('someone who just accepted an invite can set the budget they were invited to', async ({ browser }) => {
  test.setTimeout(360_000);
  const errors = [];
  const t = tag();
  const alpha = await newSignedInPhone(browser, `Alpha ${t}`, errors);
  const bravo = await newSignedInPhone(browser, `Bravo ${t}`, errors);
  const charlie = await newSignedInPhone(browser, `Charlie ${t}`, errors);

  await createFlock(alpha.page, [`Bravo ${t}`, `Charlie ${t}`], { budget: true });
  await acceptInvite(bravo.page);
  await openFlock(bravo.page);

  // GET /api/budget/:id answers budgetEnabled true for this person the moment
  // they open the chat, and the strip across the top of the chat is the only
  // thing on that screen that mentions money at all.
  await expect(bravo.page.getByRole('button', { name: 'Open group cash pool' }))
    .toBeVisible({ timeout: 25_000 });

  // And the sheet behind it has to be the budget. Anonymous budget matching is
  // the reason this flock exists; somebody who has just joined it must be able
  // to put their number in without closing and reopening the whole app.
  await openCashPool(bravo.page);
  await expect(sheet(bravo.page).getByText(/what's your budget tonight/i))
    .toBeVisible({ timeout: 25_000 });

  expect(errors).toEqual([]);
  for (const p of [alpha, bravo, charlie]) await p.context.close();
});

// ===========================================================================
// CONFIRMING THE PLAN
// ===========================================================================

test('only the host can lock the plan in, and locking it changes what everyone sees', async ({ browser }) => {
  test.setTimeout(420_000);
  const errors = [];
  const t = tag();
  const alpha = await newSignedInPhone(browser, `Alpha ${t}`, errors);
  const bravo = await newSignedInPhone(browser, `Bravo ${t}`, errors);
  const charlie = await newSignedInPhone(browser, `Charlie ${t}`, errors);

  await createFlock(alpha.page, [`Bravo ${t}`, `Charlie ${t}`]);
  await acceptInvite(bravo.page);
  await acceptInvite(charlie.page);
  await seedVenuesOnLatestFlock(`Charlie ${t}`);

  await alpha.page.reload();
  await bravo.page.reload();

  const openDetail = async (page) => {
    await page.getByRole('button', { name: 'Nest', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(FLOCK_NAME) }).first().click();
    await expect(page.getByText(/still planning|locked in/i).first()).toBeVisible({ timeout: 30_000 });
  };
  await openDetail(alpha.page);
  await openDetail(bravo.page);

  // A member who did not create the flock cannot lock it. PUT /api/flocks/:id
  // answers 403, so offering the control would be a lie.
  await expect(bravo.page.getByRole('button', { name: /^lock it in$/i })).toHaveCount(0);
  await expect(bravo.page.getByText(/still planning/i)).toBeVisible();

  // The host can, and is told what it does before tapping it.
  await expect(alpha.page.getByText(/locking it in tells everyone the plan is on/i)).toBeVisible();
  await alpha.page.getByRole('button', { name: /^lock it in$/i }).click();

  await expect(alpha.page.getByText(/locked in\. everyone in the flock has been told/i))
    .toBeVisible({ timeout: 30_000 });
  // Locking is what makes the done step exist at all, but since 43b974c
  // (2026-08-27) it is also time-gated: a plan confirmed before its hour must
  // not ask "Hangout done?" for days, so with tomorrow's time still ahead the
  // slider stays hidden, and that absence is the behaviour worth defending.
  await expect(alpha.page.getByText(/slide to mark done/i)).toHaveCount(0);

  // And the other person's screen agrees the next time they open the app.
  //
  // Asserted after a reload rather than on the live push. The push was watched
  // working by hand, but the floor is what matters: somebody who was not
  // looking at their phone when the host tapped the button must still find the
  // plan locked in the next time they open it.
  await bravo.page.reload();
  await openDetail(bravo.page);
  await expect(bravo.page.getByText(/still planning/i)).toHaveCount(0);
  await expect(bravo.page.getByText(/locked in/i).first()).toBeVisible();

  expect(errors).toEqual([]);
  for (const p of [alpha, bravo, charlie]) await p.context.close();
});
