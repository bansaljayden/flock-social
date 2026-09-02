/* THE ACCOUNT SURFACE, driven through the screen.
 *
 * Profile, settings, blocking, safety and SOS, the data export, and account
 * deletion. Every test signs up its own account through the real signup screen
 * and only ever touches accounts it created, because the database is shared
 * with four other suites running at the same time.
 *
 * ONE THING HAPPENS OUTSIDE THE BROWSER, and only one: marking an address
 * confirmed. Signup mails a link, the local stack has no Resend key, and the
 * link is printed to the server's console where a browser cannot reach it.
 * Opening a link in your own inbox happens outside the app anyway, so
 * confirmEmail() does what that link does, for the one address the test just
 * created. Nothing a test ASSERTS is set up that way; it is all driven through
 * the screen.
 */
'use strict';

const path = require('path');
const { createRequire } = require('module');
const { test, expect, devices } = require('@playwright/test');
const { signUp, failOnPageErrors } = require('./helpers');

const backendRequire = createRequire(path.join(__dirname, '..', '..', 'backend', 'package.json'));
const PG_URL = `postgresql://postgres:postgres@127.0.0.1:${process.env.E2E_PG_PORT || 59610}/flock_e2e`;
const WEB = `http://127.0.0.1:${process.env.E2E_WEB_PORT || 3199}`;

const PASSWORD = 'E2eTesting!2026';

/** Open the link the signup email would have carried, for ONE address. */
async function confirmEmail(email) {
  const { Client } = backendRequire('pg');
  const c = new Client({ connectionString: PG_URL });
  await c.connect();
  try {
    const r = await c.query(
      'UPDATE users SET email_verified = TRUE, verified_email = email WHERE email = $1 RETURNING id',
      [email]
    );
    expect(r.rowCount, `confirmEmail found no account for ${email}`).toBe(1);
    return r.rows[0].id;
  } finally {
    await c.end();
  }
}

/** A second phone, for the tests that need two people. */
async function newPhone(browser) {
  const context = await browser.newContext({ ...devices['iPhone 13'], baseURL: WEB, permissions: [] });
  const page = await context.newPage();
  return { context, page };
}

/**
 * Sign up and land INSIDE the app.
 *
 * The signup screen ends on "Confirm your email", which is where a person stops
 * until they open the link. The account already holds a session, so a reload is
 * what happens next with the app still in front of them.
 */
async function enterApp(page, name) {
  const errors = [];
  failOnPageErrors(page, errors);
  const acct = await signUp(page, 'account', name);
  await expect(page.getByRole('heading', { name: /confirm your email/i })).toBeVisible({ timeout: 20_000 });
  await page.reload();
  await expect(page.getByRole('button', { name: 'You', exact: true })).toBeVisible({ timeout: 20_000 });
  return { ...acct, errors };
}

/**
 * Get back to the settings screen from wherever the test currently is: the tab
 * if the tab bar is on screen, and back out of a full screen (Add Friends) or a
 * settings sub-screen (Blocked accounts) first if it is not.
 */
async function openSettings(page) {
  const editRow = page.getByRole('button', { name: /^Edit Profile/ });
  for (let i = 0; i < 6; i += 1) {
    if (await editRow.isVisible().catch(() => false)) return;
    const you = page.getByRole('button', { name: 'You', exact: true });
    if (await you.isVisible().catch(() => false)) await you.click({ timeout: 3000 }).catch(() => {});
    else await page.getByRole('button', { name: 'Back' }).first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
  await expect(editRow).toBeVisible({ timeout: 15_000 });
}

async function openEditProfile(page) {
  await openSettings(page);
  await page.getByRole('button', { name: /^Edit Profile/ }).click();
  await expect(page.getByLabel('Display Name *')).toBeVisible();
}

/** The find-people screen, searched by name. Returns the row for that person. */
async function searchPeople(page, name) {
  await openSettings(page);
  await page.getByRole('button', { name: /^Add Friends/ }).click();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const box = page.getByRole('textbox', { name: 'Search by name' });
  await expect(box).toBeVisible({ timeout: 15_000 });
  // Cleared first: the screen remembers the last query, and re-typing the same
  // string into a box that already holds it is not a change at all.
  await box.fill('');
  await box.fill(name);
  return page.getByRole('button', { name: new RegExp(`About ${name}`, 'i') });
}

/** Start a chat with somebody, from the message button on their search row. */
async function openDmWith(page, name) {
  const row = await searchPeople(page, name);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Message', exact: true }).first().click();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible({ timeout: 15_000 });
}

/* ═══ PROFILE ══════════════════════════════════════════════════════════════ */

test('what you type into Edit Profile is still there two seconds later', async ({ page }) => {
  const { errors } = await enterApp(page, 'Typing Tester');
  await openEditProfile(page);

  await page.getByLabel('Bio').fill('I am halfway through writing this sentence');
  // Nothing else happens. Nobody taps anything. This is a person pausing to
  // think about the next word, which is what people do in a bio box.
  await page.waitForTimeout(2500);
  await expect(page.getByLabel('Bio')).toHaveValue('I am halfway through writing this sentence');
  expect(errors).toEqual([]);
});

test('tapping the photo button does not throw away what you have typed', async ({ page }) => {
  const { errors } = await enterApp(page, 'Photo Tester');
  await openEditProfile(page);

  await page.getByLabel('Bio').fill('Half way through writing this.');
  await page.getByLabel('Display Name *').fill('Half Typed Name');

  // The photo sits at the top of this screen, so tapping it partway through
  // filling the form in is an ordinary thing to do.
  await page.getByRole('button', { name: 'Change your profile photo' }).click();
  await expect(page.getByRole('heading', { name: /profile picture/i })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  await expect(page.getByLabel('Display Name *')).toHaveValue('Half Typed Name');
  await expect(page.getByLabel('Bio')).toHaveValue('Half way through writing this.');
  expect(errors).toEqual([]);
});

test('saving a new display name says so, and the new name sticks', async ({ page }) => {
  const { errors } = await enterApp(page, 'Nameless Tester');
  await openEditProfile(page);

  const newName = 'Renamed Tester';
  await page.getByLabel('Display Name *').fill(newName);
  await page.getByRole('textbox', { name: 'Current password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Save Changes' }).click();

  // Something has to confirm it. A form that answers a tap with no message at
  // all is indistinguishable from a broken one.
  await expect(page.getByText(/profile updated successfully/i)).toBeVisible({ timeout: 15_000 });

  await page.reload();
  await openSettings(page);
  await expect(page.getByRole('heading', { name: newName })).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});

test('the bio you saved is still in the box when you come back', async ({ page }) => {
  const { errors } = await enterApp(page, 'Bio Tester');
  await openEditProfile(page);

  const bio = 'I run the trivia night at the diner on Fourth.';
  await page.getByLabel('Bio').fill(bio);
  await page.getByRole('textbox', { name: 'Current password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await page.waitForResponse((r) => r.url().includes('/api/users/profile') && r.request().method() === 'PUT', { timeout: 15_000 });

  await page.reload();
  await openEditProfile(page);
  // A bio the server is holding but the box shows as empty reads, to the person
  // who wrote it, exactly like a bio that never saved.
  await expect(page.getByLabel('Bio')).toHaveValue(bio);
  expect(errors).toEqual([]);
});

// The Edit Profile "no editable Username box" guard lived here. It was a stale
// spec (57661bb) that filled a Username box and expected the value to survive;
// A8 (68a29f5) deleted that dead control, because there is no username column.
// signup.spec.js "the profile has no Username field, because there is no column
// behind one" now defends the absence from the same screen and also checks the
// fields that DO persist, so a second copy here was pure duplication and was
// removed on 2026-08-27 rather than kept as a weaker twin.

/* ═══ BLOCKING ═════════════════════════════════════════════════════════════ */

test('a block shuts the chat on the other screen while it is open, and empties search', async ({ browser }) => {
  test.setTimeout(150_000);
  const alpha = await newPhone(browser);
  const beta = await newPhone(browser);
  try {
    const stamp = Date.now().toString(36).slice(-5);
    const alphaName = `Alpha ${stamp}`;
    const betaName = `Beta ${stamp}`;
    const a = await enterApp(alpha.page, alphaName);
    const b = await enterApp(beta.page, betaName);
    await confirmEmail(a.email);
    await confirmEmail(b.email);

    // They become friends first. Nothing sent in a DM is delivered until the
    // other person accepts, and the app says so on the chat screen.
    const betaRow = await searchPeople(alpha.page, betaName);
    await expect(betaRow).toBeVisible({ timeout: 15_000 });
    await alpha.page.getByRole('button', { name: 'Add', exact: true }).first().click();
    await searchPeople(beta.page, alphaName);
    await beta.page.getByRole('button', { name: 'Accept friend request' }).first().click();
    await expect(beta.page.getByText('Friends').first()).toBeVisible({ timeout: 15_000 });

    // Alpha starts a conversation, so there is a real thread to close.
    await openDmWith(alpha.page, betaName);
    await alpha.page.getByRole('textbox', { name: 'Message' }).fill('are you out tonight');
    await alpha.page.getByRole('textbox', { name: 'Message' }).press('Enter');
    await expect(alpha.page.getByText('are you out tonight')).toBeVisible({ timeout: 15_000 });
    await expect(alpha.page.getByText('Sending')).toHaveCount(0, { timeout: 15_000 });

    // Beta reads it, then blocks Alpha from the person card on the chat header.
    await beta.page.reload();
    await beta.page.getByRole('button', { name: /^Messages(, .* unread)?$/ }).click();
    await beta.page.getByText(alphaName).first().click();
    await expect(beta.page.getByText('are you out tonight')).toBeVisible({ timeout: 15_000 });
    await beta.page.getByRole('button', { name: new RegExp(`About ${alphaName}`, 'i') }).click();
    await beta.page.getByRole('button', { name: new RegExp(`^Block ${alphaName}`) }).click();
    await beta.page.getByRole('button', { name: new RegExp(`^Block ${alphaName}`) }).click();
    await expect(beta.page.getByText(`${alphaName} blocked`)).toBeVisible({ timeout: 15_000 });

    // Alpha has not touched anything. The chat that was open in front of them
    // has to close itself and say why, rather than sitting there accepting
    // messages that go nowhere.
    await expect(alpha.page.getByText(`You can no longer message ${betaName}`)).toBeVisible({ timeout: 20_000 });
    await expect(alpha.page.getByRole('textbox', { name: 'Message' })).toHaveCount(0);

    // Neither of them can find the other by name any more, in either direction.
    await expect(await searchPeople(beta.page, alphaName)).toHaveCount(0, { timeout: 15_000 });
    await expect(beta.page.getByText(`No users found for "${alphaName}"`)).toBeVisible();
    await alpha.page.reload();
    await expect(await searchPeople(alpha.page, betaName)).toHaveCount(0, { timeout: 15_000 });
    await expect(alpha.page.getByText(`No users found for "${betaName}"`)).toBeVisible();

    // The friendship is gone with it, on Alpha's side too. That edge is what
    // every "who is free tonight" read is joined against, so a block that left
    // it standing would leave a blocked person's status and free-text note
    // still arriving.
    await openSettings(alpha.page);
    await alpha.page.getByRole('button', { name: 'Nest', exact: true }).click();
    await expect(alpha.page.getByText('0 friends')).toBeVisible({ timeout: 15_000 });

    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  } finally {
    await alpha.context.close();
    await beta.context.close();
  }
});

test('Blocked accounts lists who you blocked, and unblocking puts them back', async ({ browser }) => {
  test.setTimeout(150_000);
  const alpha = await newPhone(browser);
  const beta = await newPhone(browser);
  try {
    const stamp = Date.now().toString(36).slice(-5);
    const alphaName = `Alfa ${stamp}`;
    const betaName = `Bravo ${stamp}`;
    const a = await enterApp(alpha.page, alphaName);
    const b = await enterApp(beta.page, betaName);
    await confirmEmail(a.email);
    await confirmEmail(b.email);

    // Before anything: the list says empty because it IS empty, and the
    // settings row agrees.
    await openSettings(beta.page);
    await expect(beta.page.getByRole('button', { name: /Blocked accounts\s*None/ })).toBeVisible();
    await beta.page.getByRole('button', { name: /^Blocked accounts/ }).click();
    await expect(beta.page.getByText('You have not blocked anyone')).toBeVisible();

    // Block Alfa from the find-people screen, which is where you meet a
    // stranger you want nothing to do with.
    const row = await searchPeople(beta.page, alphaName);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await beta.page.getByRole('button', { name: new RegExp(`^Block ${alphaName}`) }).click();
    await beta.page.getByRole('button', { name: new RegExp(`^Block ${alphaName}`) }).click();
    await expect(beta.page.getByText(`${alphaName} blocked`)).toBeVisible({ timeout: 15_000 });

    // The list names them.
    await openSettings(beta.page);
    await beta.page.getByRole('button', { name: /^Blocked accounts/ }).click();
    await expect(beta.page.getByRole('heading', { name: 'Blocked (1)' })).toBeVisible();
    await expect(beta.page.getByText(alphaName, { exact: true })).toBeVisible();

    // Unblock, with the confirm step in between.
    await beta.page.getByRole('button', { name: `Unblock ${alphaName}` }).click();
    await expect(beta.page.getByRole('heading', { name: `Unblock ${alphaName}?` })).toBeVisible();
    await beta.page.getByRole('button', { name: 'Unblock', exact: true }).click();
    await expect(beta.page.getByText('You have not blocked anyone')).toBeVisible({ timeout: 15_000 });

    // And it really lifted: they are findable again.
    await expect(await searchPeople(beta.page, alphaName)).toBeVisible({ timeout: 15_000 });

    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  } finally {
    await alpha.context.close();
    await beta.context.close();
  }
});

test('the New Message search finds somebody by name', async ({ browser }) => {
  test.setTimeout(150_000);
  const alpha = await newPhone(browser);
  const beta = await newPhone(browser);
  try {
    const stamp = Date.now().toString(36).slice(-5);
    const alphaName = `Echo ${stamp}`;
    const a = await enterApp(alpha.page, alphaName);
    const b = await enterApp(beta.page, `Foxtrot ${stamp}`);
    await confirmEmail(a.email);
    await confirmEmail(b.email);

    // The compose button on Messages is the front door to starting a chat, so
    // typing a name into it has to produce that person.
    await beta.page.getByRole('button', { name: /^Messages(, .* unread)?$/ }).click();
    await beta.page.getByRole('button', { name: 'New message' }).click();
    const box = beta.page.getByRole('textbox', { name: /search people by name/i });
    await box.fill(alphaName);
    // The name has to still be in the box a moment later, or nothing can be
    // searched for from here at all.
    await beta.page.waitForTimeout(2500);
    await expect(box).toHaveValue(alphaName);
    await expect(beta.page.getByText(alphaName)).toBeVisible({ timeout: 15_000 });

    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  } finally {
    await alpha.context.close();
    await beta.context.close();
  }
});

test('the settings row says how many accounts you have blocked', async ({ browser }) => {
  test.setTimeout(150_000);
  const alpha = await newPhone(browser);
  const beta = await newPhone(browser);
  try {
    const stamp = Date.now().toString(36).slice(-5);
    const alphaName = `Charlie ${stamp}`;
    const a = await enterApp(alpha.page, alphaName);
    const b = await enterApp(beta.page, `Delta ${stamp}`);
    await confirmEmail(a.email);
    await confirmEmail(b.email);

    const row = await searchPeople(beta.page, alphaName);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await beta.page.getByRole('button', { name: new RegExp(`^Block ${alphaName}`) }).click();
    await beta.page.getByRole('button', { name: new RegExp(`^Block ${alphaName}`) }).click();
    await expect(beta.page.getByText(`${alphaName} blocked`)).toBeVisible({ timeout: 15_000 });

    // The row on the settings screen prints a count precisely so somebody can
    // check that a block took. "None", straight after blocking somebody, is the
    // one answer it must never give.
    await openSettings(beta.page);
    await expect(beta.page.getByRole('button', { name: /Blocked accounts\s*1 person/ })).toBeVisible({ timeout: 15_000 });

    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  } finally {
    await alpha.context.close();
    await beta.context.close();
  }
});

/* ═══ LOCATION SERVICES ════════════════════════════════════════════════════ */

test('turning Location services off stops the app asking, and Discover says so', async ({ page }) => {
  // Count every geolocation call the page makes, before anything loads.
  await page.addInitScript(() => {
    window.__geoCalls = 0;
    const g = navigator.geolocation;
    if (!g) return;
    const realGet = g.getCurrentPosition.bind(g);
    const realWatch = g.watchPosition.bind(g);
    g.getCurrentPosition = (...args) => { window.__geoCalls += 1; return realGet(...args); };
    g.watchPosition = (...args) => { window.__geoCalls += 1; return realWatch(...args); };
  });
  const { errors } = await enterApp(page, 'Location Tester');

  // Baseline: with the switch on, Discover does ask.
  await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__geoCalls), { timeout: 15_000 }).toBeGreaterThan(0);

  await openSettings(page);
  const sw = page.getByRole('switch', { name: 'Location services' });
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText('Location is turned off')).toBeVisible();

  await page.evaluate(() => { window.__geoCalls = 0; });
  await page.getByRole('button', { name: 'Discover', exact: true }).click();
  // Discover explains itself rather than opening a generic map with no pin.
  await expect(page.getByText(/location services are off/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Turn on' })).toBeVisible();
  // And the switch is real: nothing on this screen asks the device where it is.
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => window.__geoCalls)).toBe(0);

  // The offer works from here, without sending anyone back to Settings.
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByText(/location services are off/i)).toHaveCount(0, { timeout: 15_000 });
  expect(await page.evaluate(() => window.__geoCalls)).toBeGreaterThan(0);

  // And the choice survives the app being closed and reopened. The wait is the
  // settings sync's own debounce, so this is a person who turned it off and put
  // their phone down, not a race.
  await openSettings(page);
  await page.getByRole('switch', { name: 'Location services' }).click();
  await page.waitForTimeout(2500);
  await page.reload();
  await openSettings(page);
  await expect(page.getByRole('switch', { name: 'Location services' })).toHaveAttribute('aria-checked', 'false');
  expect(errors).toEqual([]);
});

/* ═══ GET A COPY OF MY DATA ════════════════════════════════════════════════ */

test('the data export refuses a wrong password in words', async ({ page }) => {
  const { errors } = await enterApp(page, 'Export Tester');
  await openSettings(page);
  await page.getByRole('button', { name: 'Get a copy of my data' }).click();
  await expect(page.getByRole('heading', { name: 'Get a copy of my data' })).toBeVisible();

  await page.getByLabel('Your password').fill('not-my-password');
  await page.getByRole('button', { name: 'Get my data' }).click();

  await expect(page.getByRole('alert')).toContainText(/password is not right|not right|incorrect/i, { timeout: 15_000 });
  // And it is still open, so the person can just try again.
  await expect(page.getByRole('button', { name: 'Get my data' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the data export hands something over, and is honest about how', async ({ page }) => {
  const { email, errors } = await enterApp(page, 'Export Tester');

  const downloads = [];
  page.on('download', (d) => downloads.push(d));

  await openSettings(page);
  await page.getByRole('button', { name: 'Get a copy of my data' }).click();
  await page.getByLabel('Your password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Get my data' }).click();

  // One of the three sentences, and it has to match what actually happened.
  const toast = page.getByText(/your data (is ready to save|has been downloaded|was copied to your clipboard)/i);
  await expect(toast).toBeVisible({ timeout: 20_000 });
  const said = (await toast.innerText()).toLowerCase();

  if (said.includes('downloaded')) {
    // "Downloaded" has to mean a file. On a shell that cannot write one, this
    // sentence is what sends somebody hunting through Files for nothing.
    await expect.poll(() => downloads.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const body = await require('fs/promises').readFile(await downloads[0].path(), 'utf8');
    expect(JSON.parse(body).profile.email, 'the downloaded file is not this account').toBe(email);
  } else if (said.includes('clipboard')) {
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(JSON.parse(text).profile.email, 'the copied text is not this account').toBe(email);
  }
  expect(errors).toEqual([]);
});

/* ═══ SOS ══════════════════════════════════════════════════════════════════ */

test('the SOS sheet explains itself and Call 911 is the loudest thing on it', async ({ page }) => {
  const { errors } = await enterApp(page, 'Safety Tester');
  await page.getByRole('button', { name: /safety and emergency sos/i }).click();

  const sheet = page.getByRole('alertdialog');
  await expect(sheet.getByRole('heading', { name: 'Emergency' })).toBeVisible();
  // It says who would be told, before anyone presses anything.
  await expect(sheet.getByText('No trusted contacts set up')).toBeVisible();
  await expect(sheet.getByText(/alerts need at least one trusted contact/i)).toBeVisible();

  // Nothing on a safety sheet may look live and do nothing.
  await expect(sheet.getByRole('button', { name: /alert contacts/i })).toBeDisabled();
  await expect(sheet.getByRole('button', { name: /share location/i })).toBeDisabled();
  await expect(sheet.getByRole('button', { name: /add trusted contacts/i })).toBeEnabled();

  // Call 911 must read as THE action: at least as tall as the alert button, and
  // painted rather than transparent.
  const call = sheet.getByRole('link', { name: /call 911/i });
  await expect(call).toBeVisible();
  const callBox = await call.boundingBox();
  const alertBox = await sheet.getByRole('button', { name: /alert contacts/i }).boundingBox();
  expect(callBox.height).toBeGreaterThanOrEqual(alertBox.height);
  const fill = await call.evaluate((n) => getComputedStyle(n).backgroundColor);
  expect(fill, 'Call 911 is not painted as the primary action').not.toBe('rgba(0, 0, 0, 0)');
  expect(errors).toEqual([]);
});

test('after an alert has gone out there is a way to stand down', async ({ page }) => {
  const { errors } = await enterApp(page, 'Standdown Tester');

  // An alert went out earlier tonight. That is a state a person is genuinely in
  // when they reopen the app, and the app itself remembers it exactly this way.
  await page.evaluate(() => window.localStorage.setItem('flock.sosAlertAt', String(Date.now() - 60_000)));
  await page.reload();
  await expect(page.getByRole('button', { name: 'You', exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: /safety and emergency sos/i }).click();

  const sheet = page.getByRole('alertdialog');
  await expect(sheet.getByText(/your contacts were alerted/i)).toBeVisible();
  const ok = sheet.getByRole('button', { name: /tell them i'm ok/i });
  await expect(ok).toBeEnabled();

  await ok.click();
  // Whatever the server says, the app has to say something. Silence here is the
  // worst answer: the person cannot tell whether the all clear went out.
  await expect(page.getByText(/told|ok|no recent alert|could not/i).first()).toBeVisible({ timeout: 20_000 });
  expect(errors).toEqual([]);
});

/* ═══ DELETING THE ACCOUNT ═════════════════════════════════════════════════ */

test('deleting an account needs DELETE typed and the right password, then really deletes it', async ({ page }) => {
  const { email, errors } = await enterApp(page, 'Doomed Tester');
  await openSettings(page);
  await page.getByRole('button', { name: 'Delete account' }).click();

  await expect(page.getByRole('heading', { name: /delete your account/i })).toBeVisible();
  const confirmButton = page.getByRole('button', { name: 'Delete account' }).last();

  // 1. The guard. Nothing typed, and the button is not usable.
  await expect(confirmButton).toBeDisabled();
  await page.getByLabel('Type DELETE to confirm').fill('delete me');
  await expect(confirmButton).toBeDisabled();
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await expect(confirmButton).toBeEnabled();

  // 2. A wrong password is refused, in words, and the account survives it.
  await page.locator('#delete-password').fill('not-my-password');
  await confirmButton.click();
  await expect(page.getByRole('alert')).toContainText(/password is not right|not right|incorrect/i, { timeout: 15_000 });

  // 3. The real thing.
  await page.locator('#delete-password').fill(PASSWORD);
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await confirmButton.click();

  await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible({ timeout: 20_000 });

  // 4. And it is gone: the same credentials no longer get in.
  await page.getByRole('textbox', { name: /email/i }).fill(email);
  await page.getByRole('textbox', { name: /password/i }).first().fill(PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.locator('body')).toContainText(/incorrect|invalid|no account|check/i, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'You', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
