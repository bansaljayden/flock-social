/* The front half of the core loop, driven through the screen.
 *
 * Create a flock, invite people to it, and answer the invite. Everything here
 * happens the way a person does it: tap the button that is on the screen, type
 * into the field that is on the screen, and then look at what the OTHER person
 * sees. Nothing is set up through the API and then asserted on in the UI,
 * because that is exactly the seam this codebase keeps shipping broken: a
 * membership row that exists and a screen that never mentions it.
 *
 * TWO PEOPLE, TWO BROWSERS. An invite is only real when it arrives, so the
 * specs that matter open a second browser context and sign a second account
 * into it. A single-context spec can prove a POST fired. It cannot prove
 * anybody was told.
 */
'use strict';

const path = require('path');
const { createRequire } = require('module');
const { test, expect, devices } = require('@playwright/test');
const { newEmail, adultDob, expectToast, pinToLocalApi, failOnPageErrors } = require('./helpers');

const WEB = `http://127.0.0.1:${process.env.E2E_WEB_PORT || 3199}`;
const PG_PORT = Number(process.env.E2E_PG_PORT || 59610);

// pg the way stack.js resolves backend dependencies. There is no pg in
// tools/e2e/node_modules and there should not be one; this is the same
// createRequire hop the stack itself makes.
const backendRequire = createRequire(path.join(__dirname, '..', '..', 'backend', 'package.json'));
const { Client } = backendRequire('pg');

/**
 * CLICK THE LINK IN THE EMAIL. That is all this is, and it is the only thing in
 * this file that does not go through the screen.
 *
 * Every door into a flock is behind `requireVerified`: POST /api/flocks, and
 * /:id/join, /:id/invite, /:id/invite-link, plus POST /api/guest/:token/join. A
 * password signup writes users.email_verified FALSE, so a brand new account
 * cannot create or join anything until it confirms its address. That is the
 * product working as designed and it is NOT what this file tests.
 *
 * The local stack has no RESEND_API_KEY, so no mail leaves the building. The
 * token is stored as a selector plus a SHA-256 verifier hash, so it cannot be
 * read back out of the database, and the only place the raw link exists is a
 * console.log in the stack's own stdout, which a spec cannot see.
 *
 * So the confirmation is written straight onto this account's own row, keyed on
 * an address no other spec can hold. A precondition, not a subject.
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

/** A phone context matching the project config, for the SECOND person. */
function phoneContext(browser) {
  return browser.newContext({ ...devices['iPhone 13'], baseURL: WEB, permissions: [] });
}

/**
 * A whole person: fresh context, fresh account, confirmed, standing on Nest.
 *
 * The surname is random because friend search is a substring match over every
 * user in a shared database, and a spec that searches for "Ada" finds four
 * other agents' accounts.
 */
async function newPerson(browser, tag, firstName) {
  const context = await phoneContext(browser);
  const page = await context.newPage();
  const errors = [];
  failOnPageErrors(page, errors);
  const offences = pinToLocalApi(page);

  const email = newEmail(tag);
  const surname = `Q${Math.random().toString(36).slice(2, 7)}`;
  const name = `${firstName} ${surname}`;

  await page.goto('/app');
  await page.getByRole('button', { name: /create an account/i }).click();
  await page.getByRole('textbox', { name: /^name$/i }).fill(name);
  await page.getByRole('textbox', { name: /email/i }).fill(email);
  await page.getByRole('textbox', { name: /password/i }).first().fill('E2eTesting!2026');
  const dob = page.getByRole('textbox', { name: /birth|date/i }).first();
  if (await dob.count()) await dob.fill(adultDob());
  await page.getByRole('button', { name: /create account|sign up|continue/i }).first().click();

  // A password signup does not land in the app. It lands on "Confirm your
  // email", which is correct and is why confirmEmail exists.
  await expect(page.getByRole('heading', { name: /confirm your email/i }))
    .toBeVisible({ timeout: 30_000 });
  const id = await confirmEmail(email);

  // Then back through the real sign-in screen, the way somebody who just
  // clicked the link in their inbox comes back.
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('textbox', { name: /email/i }).fill(email);
  await page.getByRole('textbox', { name: /password/i }).first().fill('E2eTesting!2026');
  await page.getByRole('button', { name: /^sign in$/i }).click();

  // Landed when the home greeting names them.
  await expect(page.getByRole('heading', { name: new RegExp(`hey, ${firstName}`, 'i') }))
    .toBeVisible({ timeout: 30_000 });

  return { context, page, email, name, firstName, surname, id, errors, offences };
}

/**
 * Type into one of the app's debounced fields.
 *
 * SearchInputLocal holds the keystrokes locally and commits to React state on a
 * 120ms timer, so a fill() followed immediately by a click reaches the handler
 * with the OLD state. Every flock name, friend search and people search on
 * these screens is one of those.
 */
async function typeInto(locator, value) {
  await locator.fill(value);
  await expect(locator).toHaveValue(value);
  await locator.page().waitForTimeout(250);
}

/**
 * Go to one of the five tabs.
 *
 * The bottom tab bar only exists on the main screens: a flock's chat and a
 * flock's detail screen both draw over it, and the only way out of either is
 * their own back arrow. So this steps back first when the bar is not there,
 * which is exactly what a person does.
 */
async function goTab(page, label) {
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (let i = 0; i < 3; i += 1) {
    if (await nav.isVisible().catch(() => false)) break;
    const back = page.getByRole('button', { name: /^back/i }).first();
    if (!(await back.count())) break;
    await back.click();
  }
  await nav.getByRole('button', { name: label, exact: true }).click();
}

/** Create a flock from the home screen with nothing but a name. */
async function createFlockNamed(page, name) {
  await goTab(page, 'Nest');
  await page.getByRole('button', { name: /start a flock/i }).first().click();
  await expect(page.getByRole('heading', { name: /start a flock/i })).toBeVisible();
  await typeInto(page.getByLabel(/what.s the plan/i), name);
  await page.getByRole('button', { name: /create flock/i }).click();
  // Creating drops you straight into the flock's own chat.
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 25_000 });
}

/**
 * Open the flock chat's invite sheet.
 *
 * A brand new flock puts the control in the empty chat. Once there are
 * messages it only exists behind the Features button in the header, which is
 * why this has two doors rather than one.
 */
async function openInviteSheet(page) {
  const invite = page.getByRole('button', { name: /^invite friends$/i });
  if ((await invite.count()) > 1) {
    await invite.last().click();
  } else {
    await page.getByRole('button', { name: 'Features', exact: true }).click();
    await invite.first().click();
  }
  await expect(page.getByRole('heading', { name: /invite friends/i })).toBeVisible();
}

/** Two accounts become friends: search, request, accept. Through the screens. */
async function becomeFriends(requester, target) {
  await goTab(requester.page, 'Nest');
  await requester.page.getByRole('button', { name: /add friends/i }).first().click();
  await expect(requester.page.getByRole('heading', { name: /add friends/i })).toBeVisible();

  await typeInto(requester.page.getByLabel(/search by name/i), target.surname);
  await expect(requester.page.getByText(target.name, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await requester.page.getByRole('button', { name: 'Add', exact: true }).first().click();
  // The row has to say so afterwards. A request that leaves the button reading
  // "Add" is one nobody can tell they sent.
  await expect(requester.page.getByText('Pending').first()).toBeVisible({ timeout: 20_000 });

  await goTab(target.page, 'Nest');
  await target.page.getByRole('button', { name: /add friends/i }).first().click();
  await expect(target.page.getByRole('heading', { name: /friend requests/i })).toBeVisible({ timeout: 20_000 });
  await expect(target.page.getByText(requester.name, { exact: true }).first()).toBeVisible();
  await target.page.getByRole('button', { name: /accept friend request/i }).click();
  await expect(target.page.getByRole('heading', { name: /friend requests/i })).toHaveCount(0, { timeout: 20_000 });
  await goTab(target.page, 'Nest');
}

/** Invite one friend to the open flock, from the friends list in the sheet. */
async function inviteFriend(page, person) {
  await openInviteSheet(page);
  await expect(page.getByText(/your friends/i)).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: new RegExp(`${person.name}\\s*Add`) }).click();
  await page.getByRole('button', { name: /invite 1 friend/i }).click();
  await expectToast(page, /invited 1/i);
}

/** Open the invite sheet and read the shareable link off the screen. */
async function copyInviteLink(page) {
  await openInviteSheet(page);
  await page.getByRole('button', { name: /share invite link/i }).click();
  // Either branch of the share ends with the URL on screen, because a copy can
  // fail on a denied permission and the user must never be left with nothing.
  const box = page.getByRole('status').filter({ hasText: /anyone with this link/i });
  await expect(box).toBeVisible({ timeout: 20_000 });
  const m = /https?:\/\/\S+/.exec(await box.innerText());
  expect(m, 'the invite sheet printed a link').not.toBeNull();
  return m[0].trim();
}

// ---------------------------------------------------------------------------
// CREATING
// ---------------------------------------------------------------------------

test('a flock can be made with nothing but a name', async ({ browser }) => {
  const host = await newPerson(browser, 'flock-min', 'Ada');
  const name = `Minimum ${host.surname}`;

  await createFlockNamed(host.page, name);
  await expect(host.page.getByText(/nothing here yet/i)).toBeVisible();

  // Back on Nest the plan is on the list. A create that only lives in the chat
  // you were pushed into is the failure this looks for.
  await goTab(host.page, 'Nest');
  await expect(host.page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 20_000 });

  // And it survives a reload, which is the difference between a row in the
  // database and a value in React state.
  await host.page.reload();
  await expect(host.page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 30_000 });

  expect(host.errors).toEqual([]);
  expect(host.offences).toEqual([]);
  await host.context.close();
});

test('a flock with no name is refused on the field, not silently', async ({ browser }) => {
  const host = await newPerson(browser, 'flock-noname', 'Ada');

  await goTab(host.page, 'Nest');
  await host.page.getByRole('button', { name: /start a flock/i }).first().click();
  await expect(host.page.getByRole('heading', { name: /start a flock/i })).toBeVisible();
  await host.page.getByRole('button', { name: /create flock/i }).click();

  // Said twice on purpose: an alert under the field and a toast.
  await expect(host.page.getByRole('alert')).toContainText(/give the plan a name/i);
  await expectToast(host.page, /name your plan first/i);
  // And nothing was created.
  await expect(host.page.getByRole('heading', { name: /start a flock/i })).toBeVisible();

  expect(host.errors).toEqual([]);
  await host.context.close();
});

/** The instant the "Tomorrow" + "8 PM" chips mean, in this browser's own zone. */
function tomorrowAt8pm() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(20, 0, 0, 0);
  return d;
}

test('the day and time you pick are the day and time the flock says', async ({ browser }) => {
  const host = await newPerson(browser, 'flock-when', 'Ada');
  const name = `When ${host.surname}`;
  const page = host.page;

  await goTab(page, 'Nest');
  await page.getByRole('button', { name: /start a flock/i }).first().click();
  await typeInto(page.getByLabel(/what.s the plan/i), name);

  await page.getByRole('button', { name: 'Tomorrow', exact: true }).click();
  await page.getByRole('button', { name: '8 PM', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Tomorrow', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '8 PM', exact: true })).toHaveAttribute('aria-pressed', 'true');

  const when = tomorrowAt8pm();
  const shortWhen = when.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const longWhen = when.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  // The screen already agrees before the tap: the resolved-date row and the
  // footer read-back both print tomorrow at 8.
  await expect(page.getByText(/8:00 PM/).first()).toBeVisible();

  await page.getByRole('button', { name: /create flock/i }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 25_000 });

  // Now off the server, which is the only version anybody else will ever see.
  // Reload first so nothing here is the value the create screen was holding.
  await page.reload();
  await goTab(page, 'Nest');
  await page.getByRole('heading', { name, exact: true }).click();

  // Two places print it, and both have to say what was chosen.
  await expect(page.getByText(shortWhen, { exact: false })).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText(longWhen, { exact: false })).toBeVisible();

  expect(host.errors).toEqual([]);
  await host.context.close();
});

test('a group budget asked for at create time is there in the flock', async ({ browser }) => {
  const host = await newPerson(browser, 'flock-max', 'Ada');
  const name = `Everything ${host.surname}`;
  const page = host.page;

  await goTab(page, 'Nest');
  await page.getByRole('button', { name: /start a flock/i }).first().click();
  await typeInto(page.getByLabel(/what.s the plan/i), name);

  // The toggle opens a second row of choices, so this proves it is wired
  // rather than decorative.
  await page.getByRole('switch', { name: /shared cash pool/i }).click();
  await expect(page.getByText(/what.s this for\?/i)).toBeVisible();
  await page.getByRole('button', { name: /^drinks$/i }).click();

  // THE READ-BACK, the last thing seen before committing.
  await expect(page.getByText(/just you so far/i)).toBeVisible();

  await page.getByRole('button', { name: /create flock/i }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 25_000 });

  // Reload so this reads the server's copy, not the create screen's.
  await page.reload();
  await goTab(page, 'Messages');
  await page.locator('button').filter({ hasText: name }).first().click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 25_000 });

  await page.getByRole('button', { name: 'Features', exact: true }).click();
  await page.getByRole('button', { name: 'Group cash pool', exact: true }).click();
  await expect(page.getByRole('heading', { name: /group budget/i })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/what.s your budget tonight\?/i)).toBeVisible();
  // The context, which is what picks the preset amounts everyone is offered.
  await expect(page.getByText(/for drinks/i)).toBeVisible();

  expect(host.errors).toEqual([]);
  await host.context.close();
});

test('picking exactly one person turns Create Flock into a message, and says so first', async ({ browser }) => {
  test.slow();
  const host = await newPerson(browser, 'flock-dm', 'Ada');
  const mate = await newPerson(browser, 'flock-dm2', 'Bea');

  await goTab(host.page, 'Nest');
  await host.page.getByRole('button', { name: /start a flock/i }).first().click();
  await typeInto(host.page.getByLabel(/what.s the plan/i), `Solo ${host.surname}`);

  // The create screen's own people search reaches any account, friend or not.
  await typeInto(host.page.getByLabel(/search people by name or email/i), mate.surname);
  await host.page.getByRole('button', { name: new RegExp(`${mate.name}[\\s\\S]*Add`) }).click({ timeout: 20_000 });

  // SAID BEFORE THE TAP. One person is a DM, not a flock, and the footer and
  // the button both have to name that before anything happens.
  await expect(host.page.getByText(/one person is a message, not a flock/i)).toBeVisible();
  await expect(host.page.getByRole('button', { name: new RegExp(`message ${mate.firstName}`, 'i') })).toBeVisible();
  await expect(host.page.getByRole('button', { name: /create flock/i })).toHaveCount(0);

  expect(host.errors).toEqual([]);
  await host.context.close();
  await mate.context.close();
});

// ---------------------------------------------------------------------------
// FRIENDS, THEN INVITING
// ---------------------------------------------------------------------------

test('Add Friends remembers who you are already friends with', async ({ browser }) => {
  test.slow();
  const host = await newPerson(browser, 'friendstate-host', 'Ada');
  const mate = await newPerson(browser, 'friendstate-mate', 'Bea');

  await becomeFriends(mate, host);

  // Bea comes back later and looks Ada up. They are friends, and both of them
  // have to be told so by the row. This is the state the app carries only in
  // memory: friendStatuses is written by sending, accepting and by the socket,
  // and nothing seeds it from the server, so a reload loses it.
  await mate.page.reload();
  await goTab(mate.page, 'Nest');
  await mate.page.getByRole('button', { name: /add friends/i }).first().click();
  await typeInto(mate.page.getByLabel(/search by name/i), host.surname);
  await expect(mate.page.getByText(host.name, { exact: true }).first()).toBeVisible({ timeout: 25_000 });
  await expect(mate.page.getByText('Friends', { exact: true })).toBeVisible({ timeout: 20_000 });
  // Offering to add somebody who is already on your list is the tell.
  await expect(mate.page.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0);

  expect(host.errors).toEqual([]);
  expect(mate.errors).toEqual([]);
  await host.context.close();
  await mate.context.close();
});

test('two strangers become friends and an invite from the friends list arrives', async ({ browser }) => {
  test.slow();
  const host = await newPerson(browser, 'flock-host', 'Ada');
  const mate = await newPerson(browser, 'flock-mate', 'Bea');

  await becomeFriends(mate, host);

  const name = `Friends ${host.surname}`;
  await createFlockNamed(host.page, name);
  await inviteFriend(host.page, mate);

  // ── DOES THE INVITED PERSON ACTUALLY LEARN? ─────────────────────────────
  // The whole point of this file, and asserted after a reload on purpose. A
  // socket payload can paint a card that vanishes; a reload is the only proof
  // the server will tell her again tomorrow.
  // A live socket paints the invite card by itself, and this suite
  // deliberately does not lean on that: what matters is that the invite is
  // still there when she next opens the app.
  await mate.page.reload();
  await goTab(mate.page, 'Messages');
  await expect(mate.page.getByText(/pending invites/i)).toBeVisible({ timeout: 30_000 });
  await expect(mate.page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(mate.page.getByText(new RegExp(`invited by[\\s\\S]*${host.name}`, 'i'))).toBeVisible();

  expect(host.errors).toEqual([]);
  expect(mate.errors).toEqual([]);
  await host.context.close();
  await mate.context.close();
});

// ---------------------------------------------------------------------------
// RSVP
// ---------------------------------------------------------------------------

test('accepting puts the guest on the roster and the headcount agrees everywhere', async ({ browser }) => {
  test.slow();
  const host = await newPerson(browser, 'rsvp-host', 'Ada');
  const mate = await newPerson(browser, 'rsvp-mate', 'Bea');

  await becomeFriends(mate, host);
  const name = `RSVP ${host.surname}`;
  await createFlockNamed(host.page, name);
  await inviteFriend(host.page, mate);

  // Reload first. A live socket paints the invite card by itself, and this
  // suite deliberately does not lean on that: what matters is that the invite
  // is still there when she next opens the app.
  await mate.page.reload();
  await goTab(mate.page, 'Messages');
  await expect(mate.page.getByText(/pending invites/i)).toBeVisible({ timeout: 30_000 });
  await mate.page.getByRole('button', { name: /accept invite/i }).click();
  await expectToast(mate.page, new RegExp(`joined ${name}`, 'i'));
  await expect(mate.page.getByText(/pending invites/i)).toHaveCount(0);

  // ── THE HEADCOUNT, IN ALL THREE PLACES IT APPEARS ───────────────────────
  await host.page.reload();

  // 1. The Messages list, which prints a number beside a people icon.
  await goTab(host.page, 'Messages');
  const row = host.page.locator('button').filter({ hasText: name }).first();
  await expect(row).toContainText('2', { timeout: 30_000 });

  // 2. The home card on Nest, whose left-hand side under the title is the
  //    faces of the people coming, each drawn as their initial. Two people are
  //    coming, so both initials are on the card.
  //
  //    SOFT, so one run reports every surface that disagrees rather than
  //    stopping at the first. The test still fails.
  await goTab(host.page, 'Nest');
  const card = host.page.locator('button').filter({ has: host.page.getByRole('heading', { name, exact: true }) });
  await expect.soft(card.getByText(host.firstName[0], { exact: true }),
    'the host is one of the faces on the home card').toBeVisible();
  await expect.soft(card.getByText(mate.firstName[0], { exact: true }),
    'the person who accepted is one of the faces on the home card').toBeVisible();

  // 3. The detail screen: the header line and the roster heading.
  await host.page.getByRole('heading', { name, exact: true }).click();
  await expect.soft(host.page.getByText(/2 going/i)).toBeVisible({ timeout: 20_000 });
  await expect.soft(host.page.getByRole('heading', { name: /going \(2\)/i })).toBeVisible();
  // And the roster names the person, not just a count.
  await expect.soft(host.page.getByText(mate.firstName, { exact: true }).first()).toBeVisible();

  // Bea reads the same two.
  await goTab(mate.page, 'Nest');
  await mate.page.getByRole('heading', { name, exact: true }).click();
  await expect(mate.page.getByText(/2 going/i)).toBeVisible({ timeout: 20_000 });

  expect(host.errors).toEqual([]);
  expect(mate.errors).toEqual([]);
  await host.context.close();
  await mate.context.close();
});

test('declining is honoured and the host roster does not grow', async ({ browser }) => {
  test.slow();
  const host = await newPerson(browser, 'decline-host', 'Ada');
  const mate = await newPerson(browser, 'decline-mate', 'Bea');

  await becomeFriends(mate, host);
  const name = `Declined ${host.surname}`;
  await createFlockNamed(host.page, name);
  await inviteFriend(host.page, mate);

  // Reload first. A live socket paints the invite card by itself, and this
  // suite deliberately does not lean on that: what matters is that the invite
  // is still there when she next opens the app.
  await mate.page.reload();
  await goTab(mate.page, 'Messages');
  await expect(mate.page.getByText(/pending invites/i)).toBeVisible({ timeout: 30_000 });
  await mate.page.getByRole('button', { name: /decline invite/i }).click();
  await expectToast(mate.page, /invite declined/i);
  await expect(mate.page.getByText(/pending invites/i)).toHaveCount(0);

  await host.page.reload();
  await goTab(host.page, 'Nest');
  await host.page.getByRole('heading', { name, exact: true }).click();
  await expect(host.page.getByRole('heading', { name: /going \(1\)/i })).toBeVisible({ timeout: 25_000 });

  expect(host.errors).toEqual([]);
  expect(mate.errors).toEqual([]);
  await host.context.close();
  await mate.context.close();
});

test('somebody who declined can change their mind', async ({ browser }) => {
  test.slow();
  const host = await newPerson(browser, 'mind-host', 'Ada');
  const mate = await newPerson(browser, 'mind-mate', 'Bea');

  await becomeFriends(mate, host);
  const name = `Changed ${host.surname}`;
  await createFlockNamed(host.page, name);
  await inviteFriend(host.page, mate);

  // Reload first. A live socket paints the invite card by itself, and this
  // suite deliberately does not lean on that: what matters is that the invite
  // is still there when she next opens the app.
  await mate.page.reload();
  await goTab(mate.page, 'Messages');
  await expect(mate.page.getByText(/pending invites/i)).toBeVisible({ timeout: 30_000 });
  await mate.page.getByRole('button', { name: /decline invite/i }).click();
  await expectToast(mate.page, /invite declined/i);

  // Free on Friday after saying no on Tuesday is the ordinary case for this
  // product, not an edge one. After a reload SOMETHING on Bea's screen has to
  // still name this plan and offer a way back in. The server still sends the
  // flock down with member_status 'declined' on every load, so the data for it
  // is already in the client's hands.
  await mate.page.reload();
  await goTab(mate.page, 'Messages');
  await expect(mate.page.getByText(name)).toBeVisible({ timeout: 30_000 });

  expect(host.errors).toEqual([]);
  expect(mate.errors).toEqual([]);
  await host.context.close();
  await mate.context.close();
});

test('leaving a flock removes you from it and from everyone else', async ({ browser }) => {
  test.slow();
  const host = await newPerson(browser, 'leave-host', 'Ada');
  const mate = await newPerson(browser, 'leave-mate', 'Bea');

  await becomeFriends(mate, host);
  const name = `Leaving ${host.surname}`;
  await createFlockNamed(host.page, name);
  await inviteFriend(host.page, mate);

  // Reload first. A live socket paints the invite card by itself, and this
  // suite deliberately does not lean on that: what matters is that the invite
  // is still there when she next opens the app.
  await mate.page.reload();
  await goTab(mate.page, 'Messages');
  await expect(mate.page.getByText(/pending invites/i)).toBeVisible({ timeout: 30_000 });
  await mate.page.getByRole('button', { name: /accept invite/i }).click();
  await expectToast(mate.page, new RegExp(`joined ${name}`, 'i'));

  // Bea walks out through the chat's own menu.
  await goTab(mate.page, 'Messages');
  await mate.page.locator('button').filter({ hasText: name }).first().click();
  await expect(mate.page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 25_000 });
  await mate.page.getByRole('button', { name: /more options/i }).click();
  await mate.page.getByRole('button', { name: /leave flock/i }).click();
  await mate.page.getByRole('button', { name: 'Leave', exact: true }).click();

  // Gone from her list, and still gone after a reload.
  await mate.page.reload();
  await goTab(mate.page, 'Messages');
  await expect(mate.page.getByText(name)).toHaveCount(0, { timeout: 30_000 });

  // And the host's roster drops back to one.
  await host.page.reload();
  await goTab(host.page, 'Nest');
  await host.page.getByRole('heading', { name, exact: true }).click();
  await expect(host.page.getByRole('heading', { name: /going \(1\)/i })).toBeVisible({ timeout: 25_000 });

  expect(host.errors).toEqual([]);
  expect(mate.errors).toEqual([]);
  await host.context.close();
  await mate.context.close();
});

test('the Invite button on a flock detail screen opens the invite sheet', async ({ browser }) => {
  const host = await newPerson(browser, 'invitebtn', 'Ada');
  const name = `Invite ${host.surname}`;
  await createFlockNamed(host.page, name);

  // The roster header's own Invite control. It is the one control in this area
  // that does not open anything itself: it navigates to the chat and then sets
  // a 100ms timer to open the sheet, so it is worth proving it lands.
  await goTab(host.page, 'Nest');
  await host.page.getByRole('heading', { name, exact: true }).click();
  await expect(host.page.getByRole('heading', { name: /going \(1\)/i })).toBeVisible({ timeout: 20_000 });
  await host.page.getByRole('button', { name: 'Invite', exact: true }).click();

  await expect(host.page.getByRole('heading', { name: /invite friends/i })).toBeVisible({ timeout: 20_000 });
  await expect(host.page.getByRole('button', { name: /share invite link/i })).toBeVisible();

  expect(host.errors).toEqual([]);
  await host.context.close();
});

// ---------------------------------------------------------------------------
// THE SHARE LINK
// ---------------------------------------------------------------------------

test('a stranger who is not signed in can open the share link and answer', async ({ browser }) => {
  test.slow();
  const host = await newPerson(browser, 'link-host', 'Ada');
  const name = `Linked ${host.surname}`;
  await createFlockNamed(host.page, name);

  const url = await copyInviteLink(host.page);
  expect(url).toMatch(new RegExp(`^${WEB}/i/[A-Za-z0-9_-]+$`));

  // A COMPLETE STRANGER. No account, no session, nothing.
  const strangerCtx = await phoneContext(browser);
  const stranger = await strangerCtx.newPage();
  const strangerErrors = [];
  failOnPageErrors(stranger, strangerErrors);
  pinToLocalApi(stranger);
  await stranger.goto(url);

  // What a stranger gets has to be the plan, by name, not a login wall.
  await expect(stranger.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(stranger.getByRole('heading', { name: /get in the chat/i })).toBeVisible();
  await expect(stranger.getByRole('button', { name: new RegExp(`join "${name}"|join this flock`, 'i') })).toBeVisible();

  // And they can answer without an account, which is the whole growth channel.
  await expect(stranger.getByRole('heading', { name: /or just answer/i })).toBeVisible();
  await stranger.getByLabel(/your name/i).fill('Maya Stranger');
  await stranger.getByRole('button', { name: /i'm in/i }).click();
  await expect(stranger.getByText(/you're down as coming/i)).toBeVisible({ timeout: 25_000 });

  // ── DOES THE HOST LEARN? ────────────────────────────────────────────────
  // A guest has no account, so this answer only exists on the flock. Reloaded,
  // because that is the copy every other member will read too.
  await host.page.reload();
  await goTab(host.page, 'Nest');
  await host.page.getByRole('heading', { name, exact: true }).click();
  await expect(host.page.getByText(/2 going/i)).toBeVisible({ timeout: 30_000 });
  await expect(host.page.getByText('Maya', { exact: true })).toBeVisible();
  await expect(host.page.getByText('GUEST')).toBeVisible();

  // Changing their mind, from the same page.
  await stranger.getByRole('button', { name: /can.t make it/i }).click();
  await expect(stranger.getByText(/you're down as out/i)).toBeVisible({ timeout: 25_000 });
  await host.page.reload();
  await goTab(host.page, 'Nest');
  await host.page.getByRole('heading', { name, exact: true }).click();
  await expect(host.page.getByText(/1 going/i)).toBeVisible({ timeout: 30_000 });

  expect(strangerErrors).toEqual([]);
  expect(host.errors).toEqual([]);
  await strangerCtx.close();
  await host.context.close();
});

test('the share link opened by a different signed-in account puts them in the flock', async ({ browser }) => {
  test.slow();
  const host = await newPerson(browser, 'link2-host', 'Ada');
  const other = await newPerson(browser, 'link2-other', 'Cal');

  const name = `Handoff ${host.surname}`;
  await createFlockNamed(host.page, name);
  const url = await copyInviteLink(host.page);

  // Cal is already signed in, in his own browser, and opens the texted link.
  await other.page.goto(url);
  await expect(other.page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 30_000 });
  await other.page.getByRole('button', { name: /sign in and join/i }).click();

  // Already signed in, so the app finishes the join itself and lands him in
  // the plan rather than on a login screen or an empty home.
  await expect(other.page.getByRole('heading', { name: /welcome back/i })).toHaveCount(0, { timeout: 30_000 });
  await expect(other.page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 30_000 });

  // He is a real member: the flock is on his list after a reload.
  await other.page.reload();
  await goTab(other.page, 'Nest');
  await expect(other.page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 30_000 });

  // And the host counts him.
  await host.page.reload();
  await goTab(host.page, 'Nest');
  await host.page.getByRole('heading', { name, exact: true }).click();
  await expect(host.page.getByText(/2 going/i)).toBeVisible({ timeout: 25_000 });

  expect(host.errors).toEqual([]);
  expect(other.errors).toEqual([]);
  await host.context.close();
  await other.context.close();
});
