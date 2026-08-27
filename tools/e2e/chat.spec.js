/* CHAT: flock threads and direct messages, driven through the screen.
 *
 * Chat is the one part of this product that cannot be tested with one browser.
 * "Did it arrive?" is a question about a second person, and every real defect
 * in here so far has been a half-wired feature: a control whose server side was
 * complete and whose client side never called it, or called it with the wrong
 * shape. So every spec below that says "the other person" really does have a
 * second browser context, with a second account, watching the same thread.
 *
 * WHY THERE IS A DATABASE WRITE IN A UI SUITE.
 * An account cannot start a flock, invite anybody, or send or accept a friend
 * request until its email is confirmed (UNVERIFIED_DENY in
 * backend/middleware/auth.js), and the confirmation link is MAILED. This stack
 * deliberately has no RESEND_API_KEY, so backend/routes/auth.js prints the link
 * to the server's own stdout and nothing else. There is no browser path to it.
 *
 * So `confirmEmail` below runs exactly the UPDATE that clicking the link runs,
 * against the throwaway embedded Postgres, and nothing else. It is signup
 * plumbing, not the thing under test: every assertion in this file is still
 * made against what a person sees on the screen, and every action that a
 * person would take is still taken by clicking and typing.
 *
 * WHAT THIS STACK CANNOT DO, AS OF 2026-08-26.
 * Its embedded Postgres was created with the Windows default encoding,
 * WIN1252, rather than UTF8 (`SHOW server_encoding` says so, and
 * tools/e2e/stack.js calls createDatabase with no encoding). Nothing outside
 * Latin-1 can be stored, so every emoji reaction is a 500 and any message
 * carrying an emoji is refused. Railway's Postgres is UTF8, so this is the
 * harness and not the product. The emoji specs below are left as they are
 * rather than weakened around it: they are what the product has to do, and
 * they say what is wrong the moment anybody runs them.
 *
 * WHY THE CAST IS CACHED ON DISK.
 * Playwright throws the worker process away after a failed test and starts a
 * fresh one, which re-runs beforeAll. This file is meant to have red specs in
 * it, so that would mean signing five accounts up again for every defect it
 * finds, and server.js caps socket handshakes at 10 a minute per IP. The cast
 * file lets a restarted worker sign the same people back in instead. It is a
 * convenience only: if anything about it does not work, the setup falls all
 * the way back to fresh signups.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const { test, expect, devices } = require('@playwright/test');
const { signUp, failOnPageErrors, pinToLocalApi } = require('./helpers');

const backendRequire = createRequire(path.join(__dirname, '..', '..', 'backend', 'package.json'));
const { Client } = backendRequire('pg');

const PG_PORT = Number(process.env.E2E_PG_PORT || 59610);
const WEB = `http://127.0.0.1:${process.env.E2E_WEB_PORT || 3199}`;
const PG_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_e2e`;

/** The one UPDATE that clicking a verification link performs. See the header. */
async function confirmEmail(email) {
  const client = new Client({ connectionString: PG_URL });
  await client.connect();
  try {
    const result = await client.query(
      'UPDATE users SET email_verified = TRUE, verified_email = email WHERE LOWER(email) = LOWER($1) RETURNING id',
      [email]
    );
    if (result.rowCount !== 1) throw new Error(`no account to confirm for ${email}`);
    return result.rows[0].id;
  } finally {
    await client.end();
  }
}

/** A phone, because that is what Flock is. browser.newContext() inherits none
 *  of the config's `use` block, so the second person has to be handed the same
 *  device, the same base URL and the same denied permissions explicitly. */
async function openPhone(browser) {
  return browser.newContext({ ...devices['iPhone 13'], baseURL: WEB, permissions: [] });
}

// The password helpers.js signs everybody up with.
const PASSWORD = 'E2eTesting!2026';
const CAST_FILE = path.join(os.tmpdir(), 'flock-e2e-chat-cast.json');
const CAST_MAX_AGE_MS = 45 * 60 * 1000;

function readCast(key) {
  try {
    const entry = JSON.parse(fs.readFileSync(CAST_FILE, 'utf8'))[key];
    if (entry && Date.now() - entry.at < CAST_MAX_AGE_MS) return entry;
  } catch { /* first run, or a file from a stack that no longer exists */ }
  return null;
}

function writeCast(key, value) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(CAST_FILE, 'utf8')); } catch { /* first run */ }
  all[key] = { ...value, at: Date.now() };
  try { fs.writeFileSync(CAST_FILE, JSON.stringify(all)); } catch { /* not worth failing over */ }
}

/**
 * Count this page's live connection.
 *
 * Real-time delivery is what most of this file is about, so a spec that fails
 * because the socket never opened has to be able to say so instead of blaming
 * the feature. Attached before the first navigation, because the handshake
 * happens the moment a session exists.
 */
function trackLiveConnection(page) {
  const live = { open: 0, complaints: [] };
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/socket.io/')) return;
    live.open += 1;
    ws.on('close', () => { live.open -= 1; });
  });
  // services/socket.js console.warns every refusal, and the refusal worth
  // recognising here is the server's own connection ceiling: server.js caps
  // socket handshakes at 10 per minute per IP and does NOT disable that in
  // development, so several browsers on one address starve each other.
  page.on('console', (msg) => {
    const text = msg.text();
    if (/socket (connection )?error/i.test(text)) live.complaints.push(text.slice(0, 120));
  });
  return live;
}

/** Wait for this page's live connection. Answers whether it came. */
async function waitForLive(page, live, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (live.open > 0) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

/**
 * Refuse to judge real-time delivery on a page that has no live connection.
 *
 * Setup does NOT insist on one, because server.js caps socket handshakes at 10
 * a minute per IP and does not lift that in development, so several suites on
 * one machine starve each other and a whole run would be lost to it. The specs
 * that do not need a socket still have things to say. The ones that do fail
 * here, saying which of the two it was.
 */
async function requireLive(...people) {
  for (const person of people) {
    if (person.live.open > 0) continue;
    // The connection is missing right this second. Buy the spec enough room to
    // wait for it AND to report the wait, because a real-time spec that goes
    // red on a generic timeout teaches nobody anything. Only reached when
    // there is actually something to wait for.
    test.setTimeout(180_000);
    const came = await waitForLive(person.page, person.live, 60_000);
    if (came) continue;
    throw new Error(
      `${person.name} has no live connection to the server, so this spec cannot tell a broken `
      + `feature from a missing socket. The server refused the handshake: `
      + `${JSON.stringify(person.live.complaints.slice(-2))}`
    );
  }
}

/** A real account, made through the real screens, standing in the app. */
async function newPerson(browser, name, errors, { live: needsLive = true } = {}) {
  const context = await openPhone(browser);
  const page = await context.newPage();
  failOnPageErrors(page, errors);
  const live = trackLiveConnection(page);
  const { email, offences } = await signUp(page, 'chat', name);
  await expect(page.getByRole('heading', { name: /confirm your email/i })).toBeVisible({ timeout: 25_000 });
  await confirmEmail(email);
  await page.goto('/app');
  await expect(page.getByRole('button', { name: 'Messages' })).toBeVisible({ timeout: 25_000 });
  if (needsLive) await waitForLive(page, live, 60_000);
  return { context, page, email, name, offences, live };
}

/** The same person again, on a later worker. Sign in, do not sign up. */
async function returningPerson(browser, person, errors) {
  const context = await openPhone(browser);
  const page = await context.newPage();
  failOnPageErrors(page, errors);
  const live = trackLiveConnection(page);
  const offences = pinToLocalApi(page);
  await page.goto('/app');
  await page.getByRole('textbox', { name: /email/i }).fill(person.email);
  await page.getByRole('textbox', { name: /password/i }).first().fill(PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByRole('button', { name: 'Messages' })).toBeVisible({ timeout: 25_000 });
  await waitForLive(page, live, 60_000);
  return { context, page, ...person, offences, live };
}

/**
 * Two people who can talk to each other, however they have to be got.
 * `make` builds them from scratch and records them; a later worker signs the
 * recorded pair back in, and anything at all going wrong with that falls
 * through to building them from scratch again.
 */
async function cast(key, browser, errors, make) {
  const saved = readCast(key);
  if (saved) {
    const people = [];
    try {
      for (const person of saved.people) people.push(await returningPerson(browser, person, errors));
      return { people, extra: saved.extra || null };
    } catch {
      // Most likely a stack that has been thrown away and rebuilt since, so
      // the accounts no longer exist. Drop whatever did open and make new ones.
      for (const p of people) { try { await p.context.close(); } catch { /* gone */ } }
    }
  }
  const built = await make();
  writeCast(key, {
    people: built.people.map((p) => ({ email: p.email, name: p.name })),
    extra: built.extra || null,
  });
  return built;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Put someone on the create screen's invite list, by searching for them. */
async function inviteWhileCreating(page, personName) {
  await page.getByRole('textbox', { name: /search people by name/i }).fill(personName);
  await page.getByText(personName, { exact: true }).first().click({ timeout: 20_000 });
  // The chip carries the first name only, and the group label counts them.
  await expect(page.getByText(personName.split(' ')[0], { exact: true })).toBeVisible({ timeout: 10_000 });
}

/**
 * Step out of a full-screen chat thread if the page is sitting inside one.
 *
 * The flock chat and the one-to-one DM thread are full-screen by design: the
 * composer runs along the bottom edge and the only way out is the Back arrow in
 * the header, so neither screen carries the bottom tab bar. A person leaving one
 * conversation to open another taps that arrow first, because there is no
 * "Messages" tab on the screen to tap. openFlockChat and openDmWith both start
 * from the Messages list, so when a previous spec has left the pair inside a
 * thread this puts them back where a person would be before navigating, rather
 * than waiting out the timeout for a tab that is not there.
 */
async function leaveOpenThread(page) {
  if (await page.getByRole('button', { name: 'Messages' }).count()) return;
  const back = page.getByRole('button', { name: 'Back', exact: true }).first();
  if (await back.count()) {
    await back.click();
    await page.getByRole('button', { name: 'Messages' }).first().waitFor({ state: 'visible', timeout: 15_000 });
  }
}

/** Open a flock's chat from the Messages list. */
async function openFlockChat(page, flockName) {
  await leaveOpenThread(page);
  await page.getByRole('button', { name: 'Messages' }).click();
  await page.getByRole('button', { name: new RegExp(escapeRe(flockName)) }).first().click({ timeout: 25_000 });
  await expect(page.locator('#chat-input')).toBeVisible({ timeout: 20_000 });
}

/**
 * Close the app and open it again, and wait until it is live once more.
 *
 * A reload throws the socket away and asks the server for a new handshake,
 * and server.js only grants ten of those a minute per address. Every reload
 * in this file therefore goes through here, so that a spec which reloads
 * cannot leave the NEXT spec waiting on a connection it silently spent.
 */
async function reopenApp(person, budgetMs = 45_000) {
  await person.page.reload();
  await expect(person.page.getByRole('button', { name: 'Messages' })).toBeVisible({ timeout: 25_000 });
  await waitForLive(person.page, person.live, budgetMs);
}

/** Type into the flock composer and press Send. */
async function sendInFlock(page, text) {
  await page.locator('#chat-input').fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
}

/**
 * Open the one-to-one thread with somebody, from the Messages screen.
 *
 * The name goes into the New Message box with fill(), which sets the whole
 * value in one event. That is setup, and it is deliberate: typing the name a
 * key at a time does not work, which is its own spec below.
 */
async function openDmWith(page, personName) {
  await leaveOpenThread(page);
  await page.getByRole('button', { name: 'Messages' }).click();
  const row = page.getByRole('button', { name: new RegExp(escapeRe(personName)) }).first();
  if (await row.count()) {
    await row.click();
  } else {
    await page.getByRole('button', { name: 'New message' }).click();
    await page.getByRole('textbox', { name: /search people by name/i }).fill(personName);
    await page.getByText(personName, { exact: true }).first().click({ timeout: 25_000 });
  }
  await expect(page.locator('[data-dm-input]')).toBeVisible({ timeout: 25_000 });
}

// ---------------------------------------------------------------------------
// FLOCK CHAT
//
// The group is built once, in beforeAll. Three accounts, because a flock with
// exactly one invitee is not a flock: the create screen turns it into a direct
// message on purpose, so a two-person flock cannot be made from that screen at
// all. Cy is invited so that Bo has a flock to accept, and is never used again.
//
// NOT serial, deliberately. Serial mode stops the file at the first failure,
// and this suite exists to report every defect in one run rather than the
// first one alphabetically. Each spec below therefore sends its own messages
// and leaves the pair where it found them. The one exception is the empty-room
// spec, which has to run while the room is still empty, so it is declared
// first and the file is run with a single worker.
// ---------------------------------------------------------------------------
test.describe('flock chat, with two people watching it', () => {
  const errors = [];
  let ada;
  let bo;
  let flockName;
  const dialogs = [];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);

    const { people, extra } = await cast('flock-chat', browser, errors, async () => {
      const tag = Math.random().toString(36).slice(2, 7);
      const madeAda = await newPerson(browser, `Ada Zq${tag}`, errors);
      const madeBo = await newPerson(browser, `Bo Zq${tag}`, errors);
      // Cy exists only to make the flock a flock. Nobody ever drives that
      // browser, so it does not need a live connection and does not keep one.
      const madeCy = await newPerson(browser, `Cy Zq${tag}`, errors, { live: false });
      await madeCy.context.close();
      return { people: [madeAda, madeBo], extra: { cyName: madeCy.name } };
    });
    [ada, bo] = people;

    // A brand new flock every run, so the empty-room spec has an empty room.
    flockName = `Zq${Math.random().toString(36).slice(2, 7)} Night`;

    ada.page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
    bo.page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });

    await ada.page.getByRole('button', { name: 'Nest' }).click();
    await ada.page.getByRole('button', { name: /start a flock/i }).first().click();
    await ada.page.locator('#flock-name-input').fill(flockName);
    await inviteWhileCreating(ada.page, bo.name);
    await inviteWhileCreating(ada.page, extra.cyName);
    await expect(ada.page.getByText('Who (2 invited)')).toBeVisible();
    await ada.page.getByRole('button', { name: 'Create Flock' }).click();
    await expect(ada.page.locator('#chat-input')).toBeVisible({ timeout: 25_000 });

    // Bo takes the invite, through the invite card on the Messages screen.
    // The reload is a fallback, not an assertion: whether an invite appears
    // without one belongs to whoever owns invites, and this file owns what
    // happens after two people are in the same room. It is a fallback rather
    // than the first move because reloading spends Bo's live connection, and
    // the specs below need it.
    await bo.page.getByRole('button', { name: 'Messages' }).click();
    const invite = bo.page.getByText(flockName);
    try {
      await expect(invite).toBeVisible({ timeout: 20_000 });
    } catch {
      await reopenApp(bo, 60_000);
      await bo.page.getByRole('button', { name: 'Messages' }).click();
      await expect(invite).toBeVisible({ timeout: 25_000 });
    }
    await bo.page.getByRole('button', { name: 'Accept invite' }).first().click();
    await openFlockChat(bo.page, flockName);

    // Nothing below can tell a broken feature from a missing socket, so give
    // the pair every chance to have one before the first spec runs.
    await waitForLive(ada.page, ada.live, 120_000);
    await waitForLive(bo.page, bo.live, 120_000);
  });

  test.afterAll(async () => {
    await ada?.context.close();
    await bo?.context.close();
  });

  test('a brand new flock chat says what the room is for instead of showing a blank rectangle', async () => {
    // Ada is standing in the chat she just created and has said nothing in it.
    await expect(ada.page.getByText('Nothing here yet')).toBeVisible();
    await expect(ada.page.getByText(`This is where ${flockName} gets sorted out`, { exact: false })).toBeVisible();
    // Both openers it offers must exist, because an empty room with two dead
    // buttons is worse than an empty room.
    await expect(ada.page.getByRole('button', { name: /invite friends/i }).first()).toBeEnabled();
    await expect(ada.page.getByRole('button', { name: /suggest a place/i })).toBeEnabled();
    expect(errors).toEqual([]);
    expect(ada.offences).toEqual([]);
    expect(bo.offences).toEqual([]);
  });

  test('a message sent in a flock reaches the other person without them reloading', async () => {
    const before = errors.length;
    await requireLive(ada, bo);
    const said = 'first light on the water';

    await sendInFlock(ada.page, said);

    // The whole point. Bo does not reload, does not navigate, does not poll.
    await expect(bo.page.getByText(said)).toBeVisible({ timeout: 20_000 });

    // And Ada's own bubble has to settle. A socket send with no echo flips to
    // "Didn't send. Tap to retry" after eight seconds, which is the failure
    // this assertion exists to catch.
    await expect(ada.page.getByText(said)).toBeVisible();
    await ada.page.waitForTimeout(9_000);
    await expect(ada.page.getByText("Didn't send. Tap to retry")).toHaveCount(0);
    expect(errors.slice(before)).toEqual([]);
  });

  test('the other person sees you typing, and sees it stop', async () => {
    const before = errors.length;
    await requireLive(ada, bo);
    // The indicator is always in the DOM at opacity 0, so visibility is the
    // wrong question to ask it. Opacity is the thing a person can see.
    const typingOpacity = () => ada.page.evaluate(() => {
      const nodes = [...document.querySelectorAll('div')];
      const row = nodes.find((n) => n.style && n.style.height === '58px' && n.style.overflow === 'hidden');
      return row ? Number(getComputedStyle(row).opacity) : -1;
    });

    expect(await typingOpacity()).toBe(0);
    await bo.page.locator('#chat-input').fill('typing this out');
    await expect.poll(typingOpacity, { timeout: 15_000 }).toBe(1);
    // And it names who it is, in the header, rather than leaving the bubble's
    // "Someone" placeholder to speak for a named person.
    await expect(ada.page.getByText(`${bo.name} is typing...`)).toBeVisible();

    // Stops on its own two seconds after the last keystroke.
    await expect.poll(typingOpacity, { timeout: 15_000 }).toBe(0);
    await expect(ada.page.getByText('online')).toBeVisible();
    await bo.page.locator('#chat-input').fill('');
    expect(errors.slice(before)).toEqual([]);
  });

  test('a reaction reaches the other person and is still there after a reload', async () => {
    const before = errors.length;
    test.setTimeout(120_000);
    await requireLive(ada, bo);
    const said = 'reaction target one';
    await sendInFlock(ada.page, said);
    await expect(bo.page.getByText(said)).toBeVisible({ timeout: 20_000 });

    // Bo taps Ada's message, then taps a heart in the picker.
    await bo.page.getByText(said).click();
    await bo.page.getByRole('button', { name: 'React with ❤️' }).click();

    // Bo sees his own reaction, counted once and marked as his.
    await expect(bo.page.getByRole('button', { name: /^❤️ 1, including you/ })).toBeVisible({ timeout: 15_000 });
    // Ada sees it arrive without reloading. This is the half that could never
    // fire while the send was local-only state.
    await expect(ada.page.getByRole('button', { name: /^❤️ 1\. Tap to react/ })).toBeVisible({ timeout: 20_000 });

    // And it survives. A reaction that vanishes on reload was never stored.
    await reopenApp(bo);
    await openFlockChat(bo.page, flockName);
    await expect(bo.page.getByRole('button', { name: /^❤️ 1/ })).toBeVisible({ timeout: 20_000 });
    expect(errors.slice(before)).toEqual([]);
  });

  test('after a reload you can still take your own reaction back', async () => {
    const before = errors.length;
    test.setTimeout(120_000);
    await requireLive(ada, bo);
    const said = 'reaction target two';
    await sendInFlock(ada.page, said);
    await expect(bo.page.getByText(said)).toBeVisible({ timeout: 20_000 });

    await bo.page.getByText(said).click();
    await bo.page.getByRole('button', { name: 'React with 🔥' }).click();
    await expect(bo.page.getByRole('button', { name: /^🔥 1, including you/ })).toBeVisible({ timeout: 15_000 });

    // Now come back to it the way anybody would: close the app, open it again.
    // The pill has to still know it is yours, because tapping your own pill is
    // the only way the product offers to take a reaction back.
    await reopenApp(bo);
    await openFlockChat(bo.page, flockName);
    const pill = bo.page.getByRole('button', { name: /^🔥 1/ });
    await expect(pill).toBeVisible({ timeout: 20_000 });
    await expect(bo.page.getByRole('button', { name: /^🔥 1, including you/ })).toBeVisible();

    await pill.click();

    // It goes for Bo, it goes for Ada, and nothing claims it failed to save.
    await expect(bo.page.getByRole('button', { name: /^🔥/ })).toHaveCount(0, { timeout: 15_000 });
    await expect(ada.page.getByRole('button', { name: /^🔥/ })).toHaveCount(0, { timeout: 20_000 });
    await expect(bo.page.getByText(/didn't save/i)).toHaveCount(0);
    expect(errors.slice(before)).toEqual([]);
  });

  test('the Send button is never offered for a message with nothing in it', async () => {
    const before = errors.length;
    const send = ada.page.getByRole('button', { name: 'Send message' });
    const input = ada.page.locator('#chat-input');

    await input.fill('');
    await expect(send).toBeDisabled();

    // Spaces are nothing. A button that lights up, takes the tap and does
    // absolutely nothing with it is the dead control SLOP-AUDIT rule 5 bans.
    await input.fill('     ');
    await expect(send).toBeDisabled();
    expect(errors.slice(before)).toEqual([]);
  });

  test('text that looks like markup arrives as text, never as markup', async () => {
    const before = errors.length;
    const dialogsBefore = dialogs.length;
    await requireLive(ada, bo);
    const said = `<b>bold</b> <script>alert('xss')</script> 5 < 3 and 4 > 2 &amp; more`;

    await sendInFlock(ada.page, said);

    // What Bo must end up with is the punctuation, rendered literally.
    await expect(bo.page.getByText('5 < 3 and 4 > 2', { exact: false })).toBeVisible({ timeout: 20_000 });
    await expect(bo.page.getByText('&amp; more', { exact: false })).toBeVisible();

    // And what he must NOT end up with is any of it as elements. Read off the
    // bubble itself rather than the page, because the page legitimately holds
    // the app's own script tags and counting those proves nothing.
    const bubble = bo.page.locator('p', { hasText: '5 < 3 and 4 > 2' }).first();
    const html = await bubble.innerHTML();
    expect(html).not.toMatch(/<\s*\/?\s*(script|b|i|img|svg)\b/i);
    // The angle brackets arrived as characters, which is the whole point.
    expect(html).toContain('&lt;');
    expect(dialogs.slice(dialogsBefore)).toEqual([]);
    expect(errors.slice(before)).toEqual([]);
  });

  test('a message with an emoji in it sends like any other message', async () => {
    const before = errors.length;
    // Flock is for people aged 15 to 22. A message with an emoji in it is not
    // an edge case here, it is the median message, and every reaction the
    // product offers is one too.
    await requireLive(ada, bo);
    const said = 'bringing snacks 🔥🎉';

    await sendInFlock(ada.page, said);

    await expect(bo.page.getByText(said)).toBeVisible({ timeout: 25_000 });
    await expect(ada.page.getByText(/didn't send|too long|can't be sent/i)).toHaveCount(0);
    expect(errors.slice(before)).toEqual([]);
  });

  test('a very long message wraps instead of dragging the phone sideways', async () => {
    const before = errors.length;
    // No spaces anywhere, which is the case that used to give the whole thread
    // a horizontal scrollbar. 1200 characters is a long paste, well under the
    // server's 5000 ceiling.
    await requireLive(ada, bo);
    const wall = `wall${'x'.repeat(1200)}end`;

    await sendInFlock(ada.page, wall);
    await expect(bo.page.getByText(wall)).toBeVisible({ timeout: 25_000 });

    for (const who of [ada.page, bo.page]) {
      const overflow = await who.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    }
    expect(errors.slice(before)).toEqual([]);
  });

  test('a photo picked from the library reaches the other person', async () => {
    const before = errors.length;
    await requireLive(ada, bo);
    const photo = path.join(__dirname, '..', '..', 'frontend', 'public', 'logo192.png');

    const imagesBefore = await bo.page.locator('img[alt="Shared"]').count();
    await ada.page.locator('input[type="file"]').first().setInputFiles(photo);

    // The preview is the confirm step. If it never appears the picker is dead.
    await expect(ada.page.getByRole('button', { name: 'Send photo' })).toBeVisible({ timeout: 20_000 });
    await ada.page.getByRole('button', { name: 'Send photo' }).click();

    await expect(bo.page.locator('img[alt="Shared"]')).toHaveCount(imagesBefore + 1, { timeout: 25_000 });
    await expect(ada.page.getByText("Didn't send. Tap to retry")).toHaveCount(0);
    expect(errors.slice(before)).toEqual([]);
  });

  test('new messages land at the bottom and the thread is already scrolled there', async () => {
    const before = errors.length;
    test.setTimeout(120_000);
    await requireLive(ada, bo);

    for (let i = 1; i <= 14; i += 1) {
      await sendInFlock(ada.page, `filler line ${i}`);
      await ada.page.waitForTimeout(150);
    }
    await expect(bo.page.getByText('filler line 14')).toBeVisible({ timeout: 25_000 });

    // Newest at the bottom, oldest pushed off the top: the arrangement every
    // chat on earth uses, and the one thing a person notices instantly if it
    // is wrong.
    const order = await bo.page.evaluate(() => {
      const texts = [...document.querySelectorAll('p')].map((p) => p.textContent);
      return texts.filter((t) => /^filler line \d+$/.test(t));
    });
    expect(order).toEqual(order.slice().sort((a, b) => Number(a.split(' ')[2]) - Number(b.split(' ')[2])));
    expect(order[order.length - 1]).toBe('filler line 14');

    // Bo never scrolled. The newest line has to be on screen anyway.
    await expect(bo.page.getByText('filler line 14')).toBeInViewport();
    await expect(bo.page.getByText('filler line 1', { exact: true })).not.toBeInViewport();

    // And one more arriving live goes underneath, not on top.
    await sendInFlock(ada.page, 'the last word');
    await expect(bo.page.getByText('the last word')).toBeVisible({ timeout: 20_000 });
    await expect(bo.page.getByText('the last word')).toBeInViewport();
    expect(errors.slice(before)).toEqual([]);
  });

  test('the chat header controls all open something, and close again', async () => {
    const before = errors.length;
    // Every one of these sits behind the Features toggle in the chat header,
    // and a header control that opens nothing is the dead button SLOP-AUDIT
    // rule 5 bans. The vote panel is the one worth naming: on this stack there
    // is no Places key and location is denied, so it has nothing to list, and
    // an empty sheet with no sentence in it is where a user with location off
    // actually lands.
    await ada.page.getByRole('button', { name: 'Features' }).click();
    await ada.page.getByRole('button', { name: 'Vote on a venue' }).click();
    await expect(ada.page.getByText('No votes yet. Be the first to suggest a venue!')).toBeVisible({ timeout: 15_000 });
    await ada.page.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(ada.page.locator('#chat-input')).toBeVisible();

    await ada.page.getByRole('button', { name: 'Features' }).click();
    await ada.page.getByRole('button', { name: 'Invite friends' }).first().click();
    await expect(ada.page.getByRole('heading', { name: 'Invite Friends' })).toBeVisible({ timeout: 15_000 });
    await ada.page.getByRole('button', { name: 'Close', exact: true }).first().click();

    await ada.page.getByRole('button', { name: 'Features' }).click();
    await ada.page.getByRole('button', { name: 'Search messages' }).first().click();
    await expect(ada.page.getByRole('textbox', { name: /search messages in this flock/i })).toBeVisible({ timeout: 15_000 });
    await ada.page.getByRole('button', { name: 'Close search' }).click();
    await expect(ada.page.locator('#chat-input')).toBeVisible();
    expect(errors.slice(before)).toEqual([]);
  });

  test('searching the chat finds a message you can see and says so when nothing matches', async () => {
    const before = errors.length;
    const tag = Math.random().toString(36).slice(2, 6);
    const needle = `needle ${tag}`;
    const haystack = `haystack ${tag}`;
    // Both sent here, so this spec owns everything it filters and cannot pass
    // by finding nothing to filter.
    await sendInFlock(ada.page, haystack);
    await sendInFlock(ada.page, needle);
    await expect(ada.page.getByText(needle)).toBeVisible({ timeout: 20_000 });

    await ada.page.getByRole('button', { name: 'Features' }).click();
    await ada.page.getByRole('button', { name: 'Search messages' }).first().click();
    const box = ada.page.getByRole('textbox', { name: /search messages in this flock/i });
    await box.fill(needle);

    await expect(ada.page.getByText(needle)).toBeVisible({ timeout: 15_000 });
    await expect(ada.page.getByText(haystack)).toHaveCount(0);

    await box.fill('zzzz nothing matches this zzzz');
    await expect(ada.page.getByText(needle)).toHaveCount(0, { timeout: 15_000 });
    // Filtering everything away and drawing nothing at all reads as a broken
    // chat rather than as a search that found nothing.
    await expect(ada.page.getByText('No messages match "zzzz nothing matches this zzzz"')).toBeVisible({ timeout: 10_000 });

    await ada.page.getByRole('button', { name: 'Close search' }).click();
    expect(errors.slice(before)).toEqual([]);
  });

  // Declared last: it walks Ada out of the flock chat and into a private
  // thread, and every spec above expects to find her in the flock chat.
  test('a half-written flock message cannot follow you into a private thread', async () => {
    const before = errors.length;
    test.setTimeout(120_000);
    await requireLive(ada, bo);
    const draft = `not meant for one person ${Math.random().toString(36).slice(2, 6)}`;

    // Ada starts writing to the whole flock, and does not send it.
    await openFlockChat(ada.page, flockName);
    await ada.page.locator('#chat-input').fill(draft);

    // Then leaves the way the screen itself offers, by going to put a place on
    // the table, rather than by the back arrow. The back arrow is the only
    // exit that clears the composer, and nothing on the screen says so.
    await ada.page.getByRole('button', { name: /add a venue/i }).first().click();
    await expect(ada.page.getByRole('button', { name: 'Messages' })).toBeVisible({ timeout: 20_000 });

    // And opens a one-to-one conversation with one of the people in it.
    await openDmWith(ada.page, bo.name);
    const box = ada.page.locator('[data-dm-input]');
    const send = ada.page.getByRole('button', { name: 'Send', exact: true });

    // This box is empty. There is nothing here to send to this person, and a
    // Send button that is armed over an empty box is an invitation to send
    // something you cannot see.
    await expect(box).toHaveValue('');
    expect.soft(await send.isDisabled()).toBe(true);

    // Whatever tapping it does, the sentence Ada was writing to a group of
    // people must not turn up in a private thread with one of them.
    await send.click({ force: true });
    await ada.page.waitForTimeout(4_000);
    await expect(ada.page.getByText(draft)).toHaveCount(0);

    // Put her back where the rest of the file expects to find her.
    await openFlockChat(ada.page, flockName);
    expect(errors.slice(before)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DIRECT MESSAGES
//
// Not serial, for the reason the flock block is not: one red spec must not
// hide the next. The pair is wired up once in beforeAll, and each spec puts
// the two of them back on the thread itself. Fay is a third account nobody is
// connected to, so the "you are not connected yet" state and the typing state
// can both be tested without unpicking the connected pair.
// ---------------------------------------------------------------------------
test.describe('direct messages, with two people watching them', () => {
  const errors = [];
  let dee;
  let eli;
  let fay;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    const { people } = await cast('direct-messages', browser, errors, async () => {
      const tag = Math.random().toString(36).slice(2, 7);
      return {
        people: [
          await newPerson(browser, `Dee Wm${tag}`, errors),
          await newPerson(browser, `Eli Wm${tag}`, errors),
          await newPerson(browser, `Fay Wm${tag}`, errors, { live: false }),
        ],
      };
    });
    [dee, eli, fay] = people;

    // Dee starts the thread, which is also what sends the friend request.
    await openDmWith(dee.page, eli.name);
    // Eli takes it, from the friends screen. Conditional, because on a rerun
    // with the same cast the two of them are already connected and there is
    // nothing sitting there to accept.
    await eli.page.getByRole('button', { name: 'Nest' }).click();
    await eli.page.getByRole('button', { name: /add friends/i }).first().click();
    const accept = eli.page.getByRole('button', { name: 'Accept friend request' }).first();
    await eli.page.getByRole('textbox', { name: /search by name/i }).waitFor({ timeout: 30_000 });
    await eli.page.waitForTimeout(2_000); // the pending-request read lands after the screen
    if (await accept.count()) await accept.click();
    await openDmWith(eli.page, dee.name);

    await waitForLive(dee.page, dee.live, 120_000);
    await waitForLive(eli.page, eli.live, 120_000);
  });

  test.afterAll(async () => {
    await dee?.context.close();
    await eli?.context.close();
    await fay?.context.close();
  });

  test('typing a name into New Message searches for that name', async () => {
    const before = errors.length;
    // Typed one key at a time, because that is the only way anybody has ever
    // entered a name. Every other spec in this file reaches this box with
    // fill(), which sets the whole value in a single event and is therefore
    // the one input method a person cannot perform.
    await fay.page.getByRole('button', { name: 'Messages' }).click();
    await fay.page.getByRole('button', { name: 'New message' }).click();
    const box = fay.page.getByRole('textbox', { name: /search people by name/i });
    await box.click();
    await fay.page.keyboard.type(dee.name, { delay: 90 });

    // What you typed is what is in the box, and the box still has the caret,
    // which on a phone is the difference between the keyboard being up and the
    // keyboard being gone.
    await expect(box).toHaveValue(dee.name);
    await expect(box).toBeFocused();
    await expect(fay.page.getByText(dee.name, { exact: true })).toBeVisible({ timeout: 20_000 });
    expect(errors.slice(before)).toEqual([]);
  });

  test('a DM to somebody who has not accepted you yet says so instead of failing quietly', async () => {
    const before = errors.length;
    await requireLive(dee);
    // Dee has never met Fay, so this is the cold-start case.
    await openDmWith(dee.page, fay.name);
    await dee.page.locator('[data-dm-input]').fill('are you there');
    await dee.page.getByRole('button', { name: 'Send', exact: true }).click();

    // Nothing is delivered until the request is accepted, so the screen has to
    // say that in words rather than leave a sent-looking bubble sitting there.
    await expect(dee.page.getByText(`You are not connected to ${fay.name} yet`)).toBeVisible({ timeout: 25_000 });
    await expect(dee.page.getByText('Until then nothing you send here is delivered', { exact: false })).toBeVisible();
    expect(errors.slice(before)).toEqual([]);
  });

  test('a DM reaches the other person without them reloading', async () => {
    const before = errors.length;
    test.setTimeout(120_000);
    await requireLive(dee, eli);
    await openDmWith(dee.page, eli.name);
    await openDmWith(eli.page, dee.name);

    // Tagged per run for the same reason the reaction spec below tags its
    // message: the dee and eli accounts are reused across runs from the cast
    // file, so a fixed string accumulates in the thread and a second run finds
    // two of it, which trips Playwright's strict mode before the socket is ever
    // in question. A unique line each run keeps the assertion about delivery.
    const tag = Math.random().toString(36).slice(2, 6);
    const said = `meet at the corner by nine ${tag}`;
    await dee.page.locator('[data-dm-input]').fill(said);
    await dee.page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(eli.page.getByText(said)).toBeVisible({ timeout: 25_000 });
    await expect(dee.page.getByText(said)).toBeVisible();

    // And back the other way, because a one-directional socket is still broken.
    const replied = `yes, bring the cards ${tag}`;
    await eli.page.locator('[data-dm-input]').fill(replied);
    await eli.page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(dee.page.getByText(replied)).toBeVisible({ timeout: 25_000 });
    expect(errors.slice(before)).toEqual([]);
  });

  test('a DM reaction reaches the other person and survives a reload', async () => {
    const before = errors.length;
    test.setTimeout(140_000);
    await requireLive(dee, eli);
    await openDmWith(dee.page, eli.name);
    await openDmWith(eli.page, dee.name);

    const said = `pin this one ${Math.random().toString(36).slice(2, 6)}`;
    await dee.page.locator('[data-dm-input]').fill(said);
    await dee.page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(eli.page.getByText(said)).toBeVisible({ timeout: 25_000 });

    // Eli taps Dee's message and picks a heart.
    await eli.page.getByText(said).click();
    await eli.page.getByRole('button', { name: 'React with ❤️' }).click({ timeout: 15_000 });

    const pill = (page) => page.locator('span').filter({ hasText: /^❤️/ }).first();
    await expect(pill(eli.page)).toBeVisible({ timeout: 15_000 });
    // Dee sees it without reloading.
    await expect(pill(dee.page)).toBeVisible({ timeout: 25_000 });

    // And it is still there after a reload, for the person who left it.
    await reopenApp(eli);
    await openDmWith(eli.page, dee.name);
    await expect(pill(eli.page)).toBeVisible({ timeout: 25_000 });
    expect(errors.slice(before)).toEqual([]);
  });
});
