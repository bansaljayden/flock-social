/* What Flock does when the network is bad, driven through the screen.
 *
 * This is not an edge case for this product. Flock is used at night, in bars,
 * on venue wifi that is captive or overloaded and on cell signal that comes and
 * goes. The only question these specs ask is whether the app tells the truth
 * when the wire is bad, or whether it lies, hangs, or loses what somebody typed.
 *
 * ---------------------------------------------------------------------------
 * TWO FAILURES THAT LOOK THE SAME AND ARE NOT. READ THIS BEFORE EDITING.
 * ---------------------------------------------------------------------------
 * 1. THE DEVICE KNOWS IT IS OFFLINE. navigator.onLine goes false, the browser
 *    fires 'offline', and OfflineGate in App.js paints a full-screen takeover.
 *    Reached here with context.setOffline(true).
 *
 * 2. THE DEVICE THINKS IT IS ONLINE AND NOTHING GETS THROUGH. Associated to
 *    venue wifi whose backhaul is dead, or a captive portal, or the backend
 *    being down. navigator.onLine stays TRUE, so OfflineGate never appears and
 *    every request has to fail on its own. Reached here with page.route.
 *
 * The second one is the one that actually happens in a bar, and it is the one
 * most of this file is about.
 *
 * A THIRD THING HAD TO BE KILLED BY HAND. A flock message goes out over the
 * socket when the socket is connected, and only falls back to HTTP when it is
 * not. page.route does not touch an already-open WebSocket, so a spec that
 * blocks HTTP and then sends is testing nothing: the message leaves over the
 * live socket and arrives. Three drafts of this file passed for exactly that
 * reason. killSocket() installs the WebSocket and long-polling blocks and then
 * RELOADS, so the socket can never come up, which is what puts the send on the
 * HTTP path where the network copy lives.
 *
 * X-Forwarded-For, per context: server.js caps socket handshakes at 10 a minute
 * per IP and does not lift that in development, and other agents are on this
 * same stack from the same loopback address. See the long note at the top of
 * signup.spec.js for why that header is closer to production, not a trick.
 */
'use strict';

const path = require('path');
const { createRequire } = require('module');
const { test, expect, devices } = require('@playwright/test');
const { newEmail, adultDob, pinToLocalApi, failOnPageErrors } = require('./helpers');

const WEB = `http://127.0.0.1:${process.env.E2E_WEB_PORT || 3199}`;
const PG_PORT = Number(process.env.E2E_PG_PORT || 59610);
const PASSWORD = 'E2eTesting!2026';

/** POST /api/flocks/:id/messages, which is where a flock message really goes. */
const SEND = '**/api/flocks/*/messages';

const backendRequire = createRequire(path.join(__dirname, '..', '..', 'backend', 'package.json'));
const { Client } = backendRequire('pg');

/** A client address of this test's own. 198.18.0.0/15 is RFC 2544, routes nowhere. */
function clientIp() {
  const r = () => Math.floor(Math.random() * 256);
  return `198.19.${r()}.${r()}`;
}

/**
 * Click the link in the email, the only thing here that does not go through the
 * screen. Every door into a flock is behind requireVerified and the local stack
 * sends no mail. Precondition, not subject. Same helper as flock.spec.js.
 */
async function confirmEmail(email) {
  const client = new Client({
    connectionString: `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_e2e`,
    ssl: false,
  });
  await client.connect();
  try {
    const r = await client.query(
      'UPDATE users SET email_verified = TRUE, verified_email = email WHERE LOWER(email) = LOWER($1) RETURNING id',
      [email]
    );
    if (r.rowCount !== 1) throw new Error(`no account to confirm for ${email}`);
    return r.rows[0].id;
  } finally {
    await client.end();
  }
}

function phoneContext(browser) {
  return browser.newContext({ ...devices['iPhone 13'], baseURL: WEB, permissions: [] });
}

/** A whole person: own context, own address, own account, standing on Nest. */
async function newPerson(browser, tag, firstName = 'Ada') {
  const context = await phoneContext(browser);
  const page = await context.newPage();
  const errors = [];
  failOnPageErrors(page, errors);
  const offences = pinToLocalApi(page);
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': clientIp() });

  const email = newEmail(tag);
  const surname = `Z${Math.random().toString(36).slice(2, 7)}`;
  const name = `${firstName} ${surname}`;

  await page.goto('/app');
  await page.getByRole('button', { name: /create an account/i }).click();
  await page.getByRole('textbox', { name: /^name$/i }).fill(name);
  await page.getByRole('textbox', { name: /email/i }).fill(email);
  await page.getByRole('textbox', { name: /password/i }).first().fill(PASSWORD);
  const dob = page.getByRole('textbox', { name: /birth|date/i }).first();
  if (await dob.count()) await dob.fill(adultDob());
  await page.getByRole('button', { name: /create account|sign up|continue/i }).first().click();

  await expect(page.getByRole('heading', { name: /confirm your email/i })).toBeVisible({ timeout: 30_000 });
  await confirmEmail(email);

  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('textbox', { name: /email/i }).fill(email);
  await page.getByRole('textbox', { name: /password/i }).first().fill(PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`hey, ${firstName}`, 'i') }))
    .toBeVisible({ timeout: 30_000 });

  return { context, page, email, name, firstName, surname, errors, offences };
}

// The Messages tab renames itself when something is waiting on it: its
// accessible name becomes "Messages, 2 unread and 1 invite" and an exact match
// on "Messages" then finds nothing, which is a 135 second timeout rather than a
// failed assertion. Match the label as a prefix, for every tab, so the same
// thing on any other tab is a passing test and not a hang.
const tabName = (label) => new RegExp(`^${label}(,|$)`);
/** Go to one of the five tabs, stepping back out of a chat first if need be. */
async function goTab(page, label) {
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (let i = 0; i < 3; i += 1) {
    if (await nav.isVisible().catch(() => false)) break;
    const back = page.getByRole('button', { name: /^back/i }).first();
    if (!(await back.count())) break;
    await back.click();
  }
  await nav.getByRole('button', { name: tabName(label) }).click();
}

/** SearchInputLocal commits on a 120ms timer, so a fill then click loses it. */
async function typeInto(locator, value) {
  await locator.fill(value);
  await expect(locator).toHaveValue(value);
  await locator.page().waitForTimeout(250);
}

async function createFlockNamed(page, name) {
  await goTab(page, 'Nest');
  await page.getByRole('button', { name: /start a flock/i }).first().click();
  await expect(page.getByRole('heading', { name: /start a flock/i })).toBeVisible();
  await typeInto(page.getByLabel(/what.s the plan/i), name);
  await page.getByRole('button', { name: /create flock/i }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 25_000 });
}

async function openFlockChat(page, flockName) {
  await goTab(page, 'Messages');
  await page.getByRole('button', { name: new RegExp(flockName) }).first().click({ timeout: 25_000 });
  await expect(page.locator('#chat-input')).toBeVisible({ timeout: 20_000 });
}

async function sendInFlock(page, text) {
  await page.locator('#chat-input').fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
}

/**
 * Take the live socket away for good, without touching navigator.onLine and
 * without touching HTTP. The reload is the point: routing cannot reach a
 * WebSocket that is already open, so the connection has to be prevented rather
 * than interrupted. Everything sent afterwards takes the HTTP fallback.
 */
async function killSocket(page) {
  await page.routeWebSocket('**/socket.io/**', (ws) => ws.close());
  await page.route('**/socket.io/**', (route) => route.abort('connectionrefused'));
  await page.reload();
}

/** Venue wifi that is associated and dead: every request refused, onLine true. */
async function cutTheWire(page) {
  await page.route('**/api/**', (route) => route.abort('connectionrefused'));
}

/** What a person can actually SEE. toBeVisible does not know about occlusion. */
function isOnTop(locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === el || el.contains(hit));
  });
}

/** Open the invite sheet and read the shareable link off the screen. */
async function copyInviteLink(page) {
  const invite = page.getByRole('button', { name: /^invite friends$/i });
  if ((await invite.count()) > 1) {
    await invite.last().click();
  } else {
    await page.getByRole('button', { name: 'Features', exact: true }).click();
    await invite.first().click();
  }
  await expect(page.getByRole('heading', { name: /invite friends/i })).toBeVisible();
  await page.getByRole('button', { name: /share invite link/i }).click();
  const box = page.getByRole('status').filter({ hasText: /anyone with this link/i });
  await expect(box).toBeVisible({ timeout: 20_000 });
  const m = /https?:\/\/\S+/.exec(await box.innerText());
  expect(m, 'the invite sheet printed a link').not.toBeNull();
  return m[0].trim();
}

// ---------------------------------------------------------------------------
// THE DEVICE KNOWS IT IS OFFLINE
// ---------------------------------------------------------------------------

test('going offline is said in words, and coming back does not cost you what you typed', async ({ browser }) => {
  test.slow();
  const ada = await newPerson(browser, 'offline-gate');
  const name = `Signal ${ada.surname}`;
  await createFlockNamed(ada.page, name);

  // Half a message, composed and not sent. Losing this is the worst outcome.
  await ada.page.locator('#chat-input').fill('meet you out front in ten');

  await ada.context.setOffline(true);
  await expect(ada.page.getByRole('heading', { name: /you.re offline/i }))
    .toBeVisible({ timeout: 10_000 });
  // Words, not a spinner and not a generic failure. And the promise it makes
  // has to be one the app keeps, which is what the rest of this checks.
  await expect(ada.page.getByText(/flock reconnects on its own/i)).toBeVisible();

  // Back on signal. Nothing is tapped: the app has to do this by itself.
  await ada.context.setOffline(false);
  await expect(ada.page.getByRole('heading', { name: /you.re offline/i }))
    .toHaveCount(0, { timeout: 20_000 });

  // Still signed in, still in the same chat, still holding the sentence.
  await expect(ada.page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(ada.page.locator('#chat-input')).toHaveValue('meet you out front in ten');

  expect(ada.errors).toEqual([]);
  expect(ada.offences).toEqual([]);
  await ada.context.close();
});

test('going offline anywhere brings up the bird game, and the game itself needs no network', async ({ browser }) => {
  test.slow();
  // DECIDED, NOT DEFECTIVE. This spec shipped red under the name "the offline
  // screen buries the plan you are standing in the middle of", arguing the
  // plan's name and address should stay readable. Jayden ruled the other way
  // on 2026-08-26: anytime anything goes offline, the game is the screen,
  // everywhere. So what this pins now is HIS design, in both halves:
  //
  //   1. The takeover really happens on every screen, including mid chat.
  //      A gate that only covered some screens would be the defect now.
  //   2. The game genuinely runs offline. FlockBirdGame is pure canvas
  //      drawing, no image files, no fetches, so cutting the network before
  //      it ever mounts must still produce a live, playable game. If somebody
  //      ever gives the bird a fetched sprite sheet, this goes red in the one
  //      place that would notice.
  const ada = await newPerson(browser, 'offline-game');
  const name = `Buried ${ada.surname}`;
  await createFlockNamed(ada.page, name);
  await sendInFlock(ada.page, 'address is the side door on 3rd');
  await expect(ada.page.getByText('address is the side door on 3rd')).toBeVisible({ timeout: 20_000 });

  await ada.context.setOffline(true);
  await expect(ada.page.getByRole('heading', { name: /you.re offline/i }))
    .toBeVisible({ timeout: 10_000 });

  // The game is front and centre: the top element at screen centre is the
  // canvas, which is exactly the measurement that used to prove the burial.
  const centreIsGame = await ada.page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return el ? el.tagName : null;
  });
  expect(centreIsGame, 'the game canvas is the screen while offline').toBe('CANVAS');

  // And it is a running game, not a frozen picture: the canvas repaints. Two
  // snapshots of the pixels a beat apart must differ while the loop animates.
  const animates = await ada.page.evaluate(() => new Promise((resolve) => {
    const c = document.querySelector('canvas');
    if (!c) return resolve(false);
    const a = c.toDataURL();
    setTimeout(() => resolve(c.toDataURL() !== a), 450);
  }));
  expect(animates, 'the bird game is animating with no network at all').toBe(true);

  // Playable: a tap reaches the canvas (the flap control) rather than being
  // swallowed by something above it.
  await ada.page.mouse.click(195, 300);
  const stillGame = await ada.page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return el ? el.tagName : null;
  });
  expect(stillGame, 'tapping the game does not dismiss or break it').toBe('CANVAS');

  // Coming back online returns the plan untouched.
  await ada.context.setOffline(false);
  await expect(ada.page.getByText('address is the side door on 3rd')).toBeVisible({ timeout: 20_000 });

  await ada.context.close();
});

// ---------------------------------------------------------------------------
// THE DEVICE THINKS IT IS ONLINE AND NOTHING GETS THROUGH
// ---------------------------------------------------------------------------

test('a cold start that cannot reach Flock does not silently show a signed-in person the sign-in screen', async ({ browser }) => {
  test.slow();
  const ada = await newPerson(browser, 'offline-cold');

  // The token is still on the device and the account is fine. Only the wire is
  // dead, and navigator.onLine is true, so OfflineGate never fires.
  await cutTheWire(ada.page);
  await ada.page.reload();
  await ada.page.waitForTimeout(6000);

  expect(await ada.page.evaluate(() => navigator.onLine),
    'the device still believes it is online, which is the whole point').toBe(true);
  expect(await ada.page.evaluate(() => window.localStorage.getItem('flockToken')),
    'the session was kept, so nobody has actually been signed out').not.toBeNull();

  const onSignIn = await ada.page.getByRole('heading', { name: /welcome back/i }).isVisible();
  const toldWhy = await ada.page
    .getByText(/couldn.t reach flock|you.re offline|check your (signal|connection)|no connection/i)
    .count();

  // Being shown "Welcome back. Sign in" is being told you are signed out. If
  // the app is going to show that to somebody who is not, it has to say why,
  // or the next thing that happens is they type their password into a form
  // that cannot possibly work.
  expect(onSignIn && toldWhy === 0,
    'a signed-in person whose phone cannot reach the server was dropped on the sign-in form with nothing said')
    .toBe(false);

  await ada.context.close();
});

test('a send that cannot reach Flock says so, and the sentence stays on the screen', async ({ browser }) => {
  test.slow();
  const ada = await newPerson(browser, 'offline-send');
  const name = `Send ${ada.surname}`;
  await createFlockNamed(ada.page, name);
  await killSocket(ada.page);
  await openFlockChat(ada.page, name);

  await cutTheWire(ada.page);
  await sendInFlock(ada.page, 'running twenty minutes late sorry');

  // The exact sentence api.js writes for a fetch that dies while the device
  // still believes it is online. Not "you're offline", because they are not,
  // and not a raw TypeError, which is what used to reach the screen.
  await expect(ada.page.getByText(/couldn.t reach flock\. give it a second and try again\./i))
    .toBeVisible({ timeout: 20_000 });
  // And the bubble is marked, so the failure outlives the toast.
  await expect(ada.page.getByText(/didn.t send\. tap to retry/i)).toBeVisible();
  // The words themselves are still on screen. The composer is cleared on send,
  // so the failed bubble is the only copy that exists.
  await expect(ada.page.getByText('running twenty minutes late sorry')).toBeVisible();

  await ada.context.close();
});

test('the message that did not send is still there the next time the app opens', async ({ browser }) => {
  test.slow();
  const ada = await newPerson(browser, 'offline-lost');
  const name = `Lost ${ada.surname}`;
  await createFlockNamed(ada.page, name);
  await killSocket(ada.page);
  await openFlockChat(ada.page, name);

  await cutTheWire(ada.page);
  await sendInFlock(ada.page, 'i got us a table by the window');
  await expect(ada.page.getByText(/didn.t send\. tap to retry/i)).toBeVisible({ timeout: 20_000 });

  // Signal comes back and the app is opened again. On a phone this is the
  // ordinary case, not an unusual one: the tab reloads, or iOS evicts the web
  // view, or the person closes Flock and comes back to it. The failed bubble
  // is React state and nothing else, so everything they typed goes with it,
  // and so does the "Tap to retry" they were told to come back to.
  await ada.page.unroute('**/api/**');
  await ada.page.reload();
  await openFlockChat(ada.page, name);
  await ada.page.waitForTimeout(2000);

  await expect(ada.page.getByText('i got us a table by the window'),
    'the sentence somebody typed survived the app being reopened').toBeVisible({ timeout: 15_000 });

  await ada.context.close();
});

test('a create that cannot reach Flock puts back everything that was typed', async ({ browser }) => {
  test.slow();
  const ada = await newPerson(browser, 'offline-create');

  await goTab(ada.page, 'Nest');
  await ada.page.getByRole('button', { name: /start a flock/i }).first().click();
  await expect(ada.page.getByRole('heading', { name: /start a flock/i })).toBeVisible();
  await typeInto(ada.page.getByLabel(/what.s the plan/i), 'Basement gig on Wednesday');

  await ada.page.route('**/api/flocks', (route) => route.abort('connectionrefused'));
  await ada.page.getByRole('button', { name: /create flock/i }).click();

  await expect(ada.page.getByText(/couldn.t reach flock/i)).toBeVisible({ timeout: 20_000 });
  // The form is wiped before the request goes out so the screen feels instant.
  // A failed create has to hand it all back or the retry is a retype.
  await expect(ada.page.getByLabel(/what.s the plan/i)).toHaveValue('Basement gig on Wednesday');
  await expect(ada.page.getByRole('heading', { name: /start a flock/i })).toBeVisible();

  await ada.context.close();
});

// ---------------------------------------------------------------------------
// THE SERVER ANSWERS, BADLY
// ---------------------------------------------------------------------------

test('a 502 and a 500 both mark the message as not sent instead of leaving it looking delivered', async ({ browser }) => {
  test.slow();
  const ada = await newPerson(browser, 'offline-5xx');
  const name = `Gateway ${ada.surname}`;
  await createFlockNamed(ada.page, name);
  await killSocket(ada.page);
  await openFlockChat(ada.page, name);

  // A real 502 body is a gateway's HTML error page. Rendering it verbatim is
  // the failure api.js's rewrite exists to stop.
  await ada.page.route(SEND, (route) => route.fulfill({
    status: 502,
    contentType: 'text/html',
    body: '<html><body><h1>502 Bad Gateway</h1><p>nginx</p></body></html>',
  }));
  await sendInFlock(ada.page, 'five oh two');
  await expect(ada.page.getByText(/flock.s servers are having a moment\. try again in a minute\./i))
    .toBeVisible({ timeout: 20_000 });
  await expect(ada.page.getByText(/didn.t send\. tap to retry/i)).toBeVisible();
  await expect(ada.page.getByText(/bad gateway|nginx/i)).toHaveCount(0);
  await ada.page.unroute(SEND);

  // A 500 is a different fact and does not get the gateway sentence, but it
  // must not render as a delivered message either.
  await ada.page.route(SEND, (route) => route.fulfill({
    status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Server error' }),
  }));
  await sendInFlock(ada.page, 'five hundred');
  await expect(ada.page.getByText(/didn.t send\. tap to retry/i)).toHaveCount(2, { timeout: 20_000 });
  // Nothing raw from the runtime reaches a person.
  await expect(ada.page.getByText(/\[object Object\]|TypeError|Failed to fetch/i)).toHaveCount(0);

  expect(ada.errors).toEqual([]);
  await ada.context.close();
});

// ---------------------------------------------------------------------------
// A REQUEST THAT HANGS, WHICH IS NOT THE SAME AS ONE THAT FAILS
// ---------------------------------------------------------------------------

test('a send that hangs is given up on and reported, and the composer works again', async ({ browser }) => {
  test.setTimeout(120_000);
  const ada = await newPerson(browser, 'offline-hang');
  const name = `Hang ${ada.surname}`;
  await createFlockNamed(ada.page, name);
  await killSocket(ada.page);
  await openFlockChat(ada.page, name);

  // Answered by nobody, ever. A stalled connection, not a refused one, which
  // is what an overloaded venue wifi actually does.
  await ada.page.route(SEND, async () => { /* never answer */ });

  const started = Date.now();
  await sendInFlock(ada.page, 'is anyone still here');
  await expect(ada.page.getByText(/that took too long\. check your signal and try again\./i))
    .toBeVisible({ timeout: 30_000 });
  const waited = (Date.now() - started) / 1000;

  // DEFAULT_TIMEOUT_MS is 15s. Much past that and a person has put the phone
  // away believing the message went.
  expect(waited, 'seconds a person waited before being told').toBeLessThan(25);
  await expect(ada.page.getByText(/didn.t send\. tap to retry/i)).toBeVisible();

  // And the screen is usable afterwards: no spinner still running and no dead
  // composer. Send is disabled while the box is empty by design, so this types
  // first; asserting it enabled on an empty composer was a spec bug, not a
  // product one, and it cost a run to find out.
  await ada.page.locator('#chat-input').fill('typing again');
  await expect(ada.page.locator('#chat-input')).toHaveValue('typing again');
  await expect(ada.page.getByRole('button', { name: 'Send message' })).toBeEnabled();

  await ada.context.close();
});

test('a hung write hands the control back instead of leaving it disabled', async ({ browser }) => {
  test.setTimeout(120_000);
  const ada = await newPerson(browser, 'offline-hangctl');

  await goTab(ada.page, 'Nest');
  const down = ada.page.getByRole('button', { name: 'Tonight: Down' });
  await expect(down).toBeVisible({ timeout: 20_000 });

  await ada.page.route('**/api/availability**', async () => { /* never answer */ });
  await down.click();
  // It disables the three buttons while it saves, which is right. What matters
  // is that the disable ENDS. A hang is the case where it might not.
  await expect(down).toBeDisabled({ timeout: 5_000 });
  await expect(down).toBeEnabled({ timeout: 30_000 });
  await expect(ada.page.getByText(/that took too long/i)).toBeVisible();
  await expect(down).toHaveAttribute('aria-pressed', 'false');

  await ada.context.close();
});

// ---------------------------------------------------------------------------
// OPTIMISTIC UI THAT HAS TO BE RECONCILED
// ---------------------------------------------------------------------------

test('a reaction the server never got is taken back off the screen, and the toast names it', async ({ browser }) => {
  test.slow();
  const ada = await newPerson(browser, 'offline-react');
  const name = `React ${ada.surname}`;
  await createFlockNamed(ada.page, name);
  await sendInFlock(ada.page, 'react to me');
  await expect(ada.page.getByText('react to me')).toBeVisible({ timeout: 20_000 });
  await ada.page.waitForTimeout(2500); // let the socket echo settle the real id

  await killSocket(ada.page);
  await openFlockChat(ada.page, name);
  await expect(ada.page.getByText('react to me')).toBeVisible({ timeout: 20_000 });

  await cutTheWire(ada.page);
  await ada.page.getByText('react to me').first().click();
  const heart = ada.page.getByRole('button', { name: 'React with ❤️' });
  await expect(heart).toBeVisible({ timeout: 10_000 });
  await heart.click();

  // The reaction moves on the tap. Then it has to move back, and the sentence
  // has to name the action, or the movement reads as a bug rather than a
  // refusal.
  await expect(ada.page.getByText(/your reaction didn.t save\./i)).toBeVisible({ timeout: 20_000 });
  await expect(ada.page.getByText(/couldn.t reach flock/i)).toBeVisible();

  // Reload with the wire back: the server never stored it and neither did the
  // screen. A reaction that survives locally and nowhere else is the lie.
  await ada.page.unroute('**/api/**');
  await ada.page.reload();
  await openFlockChat(ada.page, name);
  await expect(ada.page.getByText('react to me')).toBeVisible({ timeout: 20_000 });
  await expect(ada.page.getByText('❤️')).toHaveCount(0);

  await ada.context.close();
});

test('the Tonight control does not light up for a write that never landed', async ({ browser }) => {
  test.slow();
  const ada = await newPerson(browser, 'offline-pulse');

  await goTab(ada.page, 'Nest');
  const down = ada.page.getByRole('button', { name: 'Tonight: Down' });
  await expect(down).toBeVisible({ timeout: 20_000 });
  await expect(down).toHaveAttribute('aria-pressed', 'false');

  await ada.page.route('**/api/availability**', (route) => route.abort('connectionrefused'));
  await down.click();

  await expect(ada.page.getByText(/couldn.t reach flock/i)).toBeVisible({ timeout: 20_000 });
  // Friends read this. A control that stays lit is telling them you are out
  // tonight when the server was never told anything.
  await expect(down).toHaveAttribute('aria-pressed', 'false');
  await expect(down).toBeEnabled();

  await ada.context.close();
});

// ---------------------------------------------------------------------------
// COMING BACK
// ---------------------------------------------------------------------------

test('coming back online sends nothing by itself, and a tapped retry sends exactly once', async ({ browser }) => {
  test.setTimeout(150_000);
  const ada = await newPerson(browser, 'offline-retry');
  const name = `Retry ${ada.surname}`;
  await createFlockNamed(ada.page, name);
  await killSocket(ada.page);
  await openFlockChat(ada.page, name);

  await cutTheWire(ada.page);
  await sendInFlock(ada.page, 'we are at the bar upstairs');
  await expect(ada.page.getByText(/didn.t send\. tap to retry/i)).toBeVisible({ timeout: 20_000 });

  // Signal returns. Nothing is tapped. A write that re-fires itself on
  // reconnect is how one message becomes two, and a duplicate is worse than a
  // failure because nobody can tell which one the group answered.
  await ada.page.unroute('**/api/**');
  await ada.page.waitForTimeout(8000);
  await expect(ada.page.getByText(/didn.t send\. tap to retry/i)).toBeVisible();
  await expect(ada.page.getByText('we are at the bar upstairs')).toHaveCount(1);

  // The person decides, and it goes exactly once.
  await ada.page.getByText(/didn.t send\. tap to retry/i).click();
  await expect(ada.page.getByText(/didn.t send\. tap to retry/i)).toHaveCount(0, { timeout: 20_000 });
  await expect(ada.page.getByText('we are at the bar upstairs')).toHaveCount(1);

  // And exactly once in the database, which is what a reload reads back.
  await ada.page.reload();
  await openFlockChat(ada.page, name);
  await expect(ada.page.getByText('we are at the bar upstairs')).toHaveCount(1, { timeout: 20_000 });

  await ada.context.close();
});

// ---------------------------------------------------------------------------
// THE SOCKET
// ---------------------------------------------------------------------------

test('the chat header does not claim you are online when nothing is connected', async ({ browser }) => {
  test.slow();
  const ada = await newPerson(browser, 'offline-socket');
  const name = `Live ${ada.surname}`;
  await createFlockNamed(ada.page, name);

  await killSocket(ada.page);
  await openFlockChat(ada.page, name);
  await cutTheWire(ada.page);
  await ada.page.waitForTimeout(2000);

  // Nothing is connected: no socket, no HTTP. Real-time delivery is dead, so
  // anything the rest of the flock says will not arrive, and there is no other
  // channel that would catch it up. The header is the one place a person
  // looks, and it carries a green dot and the word "online" that are a
  // hardcoded literal in screens/ChatDetail.js, wired to nothing at all.
  await expect(ada.page.getByText('online', { exact: true }),
    'the header claims a live connection that does not exist')
    .toHaveCount(0);

  await ada.context.close();
});

// ---------------------------------------------------------------------------
// THE PAGE PEOPLE ACTUALLY OPEN IN A VENUE
// ---------------------------------------------------------------------------

test('a guest RSVP that never reached Flock is not reported back as done', async ({ browser }) => {
  test.setTimeout(150_000);
  const host = await newPerson(browser, 'offline-guest');
  const name = `Guest ${host.surname}`;
  await createFlockNamed(host.page, name);
  const url = await copyInviteLink(host.page);

  // A stranger with no account, opening a texted link on the venue's wifi.
  const strangerCtx = await phoneContext(browser);
  const stranger = await strangerCtx.newPage();
  const strangerErrors = [];
  failOnPageErrors(stranger, strangerErrors);
  pinToLocalApi(stranger);
  await stranger.setExtraHTTPHeaders({ 'X-Forwarded-For': clientIp() });
  await stranger.goto(url);
  await expect(stranger.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 30_000 });

  // The wifi dies between loading the page and answering it.
  await cutTheWire(stranger);
  await stranger.getByLabel(/your name/i).fill('Maya Stranger');
  await stranger.getByRole('button', { name: /i'm in/i }).click();

  // "You're down as coming" is a promise to the host as much as to the guest.
  // It must not be printed for a write that never left the phone.
  await expect(stranger.getByText(/did not go through|try again|check your connection/i))
    .toBeVisible({ timeout: 20_000 });
  await expect(stranger.getByText(/you.re down as coming/i)).toHaveCount(0);

  // And the host's roster does not grow, because nothing happened.
  await host.page.reload();
  await goTab(host.page, 'Nest');
  await host.page.getByRole('heading', { name, exact: true }).click();
  await expect(host.page.getByText(/1 going/i)).toBeVisible({ timeout: 30_000 });
  await expect(host.page.getByText('Maya', { exact: true })).toHaveCount(0);

  expect(strangerErrors).toEqual([]);
  await strangerCtx.close();
  await host.context.close();
});

// ---------------------------------------------------------------------------
// THE BACKEND COMES BACK, AND NOBODY TOUCHES ANYTHING
//
// 2026-08-27: two real deploy blips stranded a signed-in person twice, once on
// the boot screen and once behind the flock list's failure card, and in both
// cases the app only recovered when a human acted. The boot screen literally
// says "It keeps trying on its own" and the list card implies a moment's
// patience is enough, so these hold both to their word: the server returns,
// and the app must come back with zero clicks, zero reloads, zero tab
// switches. The boot spec rides the 15s auth retry interval; the list spec
// rides the error-gated recovery tick, because in its scenario the socket
// never dropped and no reconnect, online or visibility signal is ever coming.
// ---------------------------------------------------------------------------

test('the boot screen recovers by itself when the server comes back', async ({ browser }) => {
  test.slow();
  test.setTimeout(120_000);
  const ada = await newPerson(browser, 'boot-recover');

  await cutTheWire(ada.page);
  await ada.page.reload();
  await expect(ada.page.getByText(/couldn.t reach flock/i).first()).toBeVisible({ timeout: 20_000 });

  // The server returns. Nothing else happens.
  await ada.page.unroute('**/api/**');

  await expect(ada.page.getByText(/hey, ada/i).first()).toBeVisible({ timeout: 40_000 });
  await ada.context.close();
});

test('a flock list that failed to load heals itself once the server is back', async ({ browser }) => {
  test.slow();
  test.setTimeout(120_000);
  const ada = await newPerson(browser, 'list-recover');

  // One bad gateway on exactly the list request, socket untouched. The
  // request wrapper retries a 502 twice in-layer, so the route stays bad
  // until unrouted or the card could never appear at all.
  await ada.page.route('**/api/flocks', (route) => route.fulfill({
    status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Bad gateway' }),
  }));
  await ada.page.reload();
  await expect(ada.page.getByText(/failing to load/i).first()).toBeVisible({ timeout: 30_000 });

  await ada.page.unroute('**/api/flocks');

  // No clicks. The card leaves on its own or this stays red.
  await expect(ada.page.getByText(/failing to load/i)).toHaveCount(0, { timeout: 45_000 });
  await ada.context.close();
});
