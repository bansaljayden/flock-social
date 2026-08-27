/* Signup, the age gate, and the first five minutes of a brand new account.
 *
 * Everything here is driven through the screen. Nothing calls the API to set up
 * state and then asserts on the UI, because the wiring between the two halves is
 * exactly what has broken repeatedly in this codebase.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY TEST SETS AN X-Forwarded-For HEADER. READ THIS BEFORE REMOVING IT.
 * ---------------------------------------------------------------------------
 * The under-13 refusal in backend/routes/auth.js writes THREE memories, and one
 * of them is keyed on the caller's IP alone for fifteen minutes
 * (UNDERAGE_IP_TTL_MS). While that key is live, `underageBlocked` refuses every
 * signup from that IP even with a perfectly good date of birth.
 *
 * Every browser on this machine reaches the local API from 127.0.0.1. So a
 * single under-13 test, run bare, would refuse every signup in every other spec
 * file for the next fifteen minutes, and the failures would look like a broken
 * signup route rather than like this file.
 *
 * server.js sets `app.set('trust proxy', 1)`, which is how it reads a real
 * client address behind Railway's proxy. With one trusted hop, Express takes
 * req.ip from the last entry of X-Forwarded-For. Giving each test its own
 * synthetic address is therefore not a trick: it is closer to production than
 * sharing one loopback address is, because in production every user has their
 * own IP. It also makes the lockout assertions deterministic instead of
 * dependent on what some other spec did a minute ago.
 *
 * 198.18.0.0/15 is the benchmarking range from RFC 2544. It routes nowhere.
 */
'use strict';

const { test, expect } = require('@playwright/test');
const { newEmail, adultDob, pinToLocalApi, failOnPageErrors } = require('./helpers');

const PASSWORD = 'E2eTesting!2026';

/** A client address of this test's own, so one test's lockout is one test's. */
function clientIp() {
  const r = () => Math.floor(Math.random() * 256);
  return `198.18.${r()}.${r()}`;
}

/** Land on the signup form the way a new person does: from the sign-in screen. */
async function openSignupForm(page) {
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': clientIp() });
  await page.goto('/app');
  await page.getByRole('button', { name: /create an account/i }).click();
  await expect(page.getByRole('heading', { name: /create your account/i })).toBeVisible();
}

/** Fill the four fields and tap Create account. */
async function submitSignup(page, { name = 'Ada Tester', email, dob = adultDob(), password = PASSWORD }) {
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Date of birth', { exact: true }).fill(dob);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /^create account$/i }).click();
}

/**
 * The real path a new account takes into the app.
 *
 * Signup ends on "Confirm your email", not inside the product, because the
 * server answers every /signup with emailVerificationRequired. The screen's own
 * way onward is its "Sign in" link, and that is what a person taps when the
 * email has not arrived yet. So this signs up and then signs in, which is how
 * most new accounts actually reach the first screen.
 */
async function signUpAndSignIn(page, tag, name = 'Ada Tester') {
  const email = newEmail(tag);
  await openSignupForm(page);
  await submitSignup(page, { email, name });
  await expect(page.getByRole('heading', { name: /confirm your email/i })).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByText(/no flocks yet/i)).toBeVisible({ timeout: 25_000 });
  return email;
}

const normalise = (s) => s.replace(/\s+/g, ' ').trim();

// Written as an escape on purpose, so this file does not itself contain the
// character it is here to keep out of the product.
const EM_DASH = '\u2014';

// ---------------------------------------------------------------------------
// Getting an account
// ---------------------------------------------------------------------------

test('a good signup lands somewhere that names the address and says what to do next', async ({ page }) => {
  const errors = [];
  failOnPageErrors(page, errors);
  const offences = pinToLocalApi(page);

  const email = newEmail('signup');
  await openSignupForm(page);
  await submitSignup(page, { email });

  // Not "a screen appeared". The person has to be able to tell WHICH mailbox
  // this account is waiting on, otherwise a typo in the address is unrecoverable
  // and invisible.
  await expect(page.getByRole('heading', { name: /confirm your email/i })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(email, { exact: false })).toBeVisible();
  // And a way onward, not a cul de sac. The button reads "Send the link again"
  // when the mail left and "Send the link" when it did not (linkSent, from
  // data.verificationSent). This stack sets no Resend key on purpose, so it
  // lands on the honest did-not-go-out branch; both are the same onward path and
  // the test defends its presence, not which of the two truths it is telling.
  await expect(page.getByRole('button', { name: /send the link( again)?/i })).toBeEnabled();
  await expect(page.getByRole('button', { name: /^sign in$/i })).toBeEnabled();

  expect(errors).toEqual([]);
  expect(offences).toEqual([]);
});

test('the password rules printed on the screen are the rules the server enforces', async ({ page }) => {
  const errors = [];
  failOnPageErrors(page, errors);

  await openSignupForm(page);

  // A password that breaks two of the three printed rules. The checklist has to
  // say so, and the form has to refuse.
  await page.getByLabel('Password', { exact: true }).fill('aaaaaaaa');
  const checklist = page.getByRole('list', { name: /password requirements/i });
  await expect(checklist).toContainText(/8 characters, met/i);
  await expect(checklist).toContainText(/one uppercase letter, not met/i);
  await expect(checklist).toContainText(/one number, not met/i);

  await page.getByLabel('Name', { exact: true }).fill('Ada Tester');
  await page.getByLabel('Email', { exact: true }).fill(newEmail('pwbad'));
  await page.getByLabel('Date of birth', { exact: true }).fill(adultDob());
  await page.getByRole('button', { name: /^create account$/i }).click();
  await expect(page.getByText(/password is missing a requirement/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: /create your account/i })).toBeVisible();

  // Now the weakest password the checklist is willing to call complete. This is
  // the half that matters: a checklist that turns green over a password the
  // server then bounces is the defect. Eight characters, one capital, one digit,
  // nothing else.
  const email = newEmail('pwmin');
  await page.getByLabel('Password', { exact: true }).fill('Aaaaaaa1');
  await expect(checklist).toContainText(/8 characters, met/i);
  await expect(checklist).toContainText(/one uppercase letter, met/i);
  await expect(checklist).toContainText(/one number, met/i);
  await expect(checklist).not.toContainText(/not met/i);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: /^create account$/i }).click();

  await expect(page.getByRole('heading', { name: /confirm your email/i })).toBeVisible({ timeout: 20_000 });
  expect(errors).toEqual([]);
});

test('an address that already has an account is refused in words that say so', async ({ page }) => {
  const errors = [];
  failOnPageErrors(page, errors);

  const email = newEmail('taken');
  await openSignupForm(page);
  await submitSignup(page, { email });
  await expect(page.getByRole('heading', { name: /confirm your email/i })).toBeVisible({ timeout: 20_000 });

  // Signup stores a token, so /app would now open the product. Come back the way
  // somebody on a second device does: with nothing remembered.
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await openSignupForm(page);
  await submitSignup(page, { email });

  await expect(page.getByText(/already registered/i)).toBeVisible({ timeout: 20_000 });
  // Still on the form, with a route to the account they evidently have.
  await expect(page.getByRole('heading', { name: /create your account/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /^sign in$/i })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a throwaway mailbox is refused, and the refusal says what to use instead', async ({ page }) => {
  const errors = [];
  failOnPageErrors(page, errors);

  await openSignupForm(page);
  await submitSignup(page, { email: `e2e-signup-${Date.now().toString(36)}@mailinator.com` });

  await expect(page.getByText(/temporary email addresses cannot be used/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/use an address you keep/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: /create your account/i })).toBeVisible();
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// The age gate. It is deliberately neutral, and the tests are about that.
// ---------------------------------------------------------------------------

test('a plainly under 13 date is refused, and the refusal teaches no age', async ({ page }) => {
  const errors = [];
  failOnPageErrors(page, errors);

  await openSignupForm(page);

  // Nothing on the form may print the threshold or cap the picker. A screen that
  // does either tells a child which birthday to type instead of turning them
  // away, which is the whole point of the neutral screen.
  const dobField = page.getByLabel('Date of birth', { exact: true });
  expect(await dobField.getAttribute('max')).toBeNull();
  expect(await dobField.getAttribute('min')).toBeNull();
  const formText = normalise(await page.locator('form').innerText());
  expect(formText).not.toMatch(/\b(13|thirteen)\b/i);
  expect(formText).not.toMatch(/\d+\s*(\+|or older|years old|and over)/i);
  // The hint under the field says what the date is for and stops there.
  expect(normalise(await page.locator('#signup-dob-hint').innerText()))
    .toBe('We use this to check your age.');

  const nineYearsOld = `${new Date().getFullYear() - 9}-04-04`;
  await submitSignup(page, { email: newEmail('young'), dob: nineYearsOld });

  const refusal = page.getByText(/can't create a flock account for you/i);
  await expect(refusal).toBeVisible({ timeout: 20_000 });

  // The refusal itself must not name a number or an age either.
  const said = normalise(await refusal.innerText());
  expect(said).not.toMatch(/\d/);
  expect(said).not.toMatch(/age|old|young|birthday|13/i);
  expect(errors).toEqual([]);
});

test('typing an older date straight after being refused does not get in', async ({ page }) => {
  const errors = [];
  failOnPageErrors(page, errors);

  // One fixed address for the whole test, so this is the back button case and
  // not two unrelated attempts.
  const ip = clientIp();
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': ip });
  await page.goto('/app');
  await page.getByRole('button', { name: /create an account/i }).click();

  const email = newEmail('backbutton');
  await submitSignup(page, { email, dob: `${new Date().getFullYear() - 9}-04-04` });
  await expect(page.getByText(/can't create a flock account for you/i)).toBeVisible({ timeout: 20_000 });

  // Same mailbox, older year, form still filled in. This is the exact move the
  // lockout exists to answer.
  await page.getByLabel('Date of birth', { exact: true }).fill(adultDob());
  await page.getByRole('button', { name: /^create account$/i }).click();
  await expect(page.getByText(/can't create a flock account for you/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: /confirm your email/i })).toHaveCount(0);

  // A fresh mailbox from the same device does not get around it either.
  await page.getByLabel('Email', { exact: true }).fill(newEmail('backbutton2'));
  await page.getByRole('button', { name: /^create account$/i }).click();
  await expect(page.getByText(/can't create a flock account for you/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: /confirm your email/i })).toHaveCount(0);

  // And the other half of the same rule: the lockout is scoped to the device
  // that was refused. A different person on a different connection is not swept
  // up in it. If this ever fails, one refused child takes the whole product
  // down for everyone behind the same address.
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': clientIp() });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto('/app');
  await page.getByRole('button', { name: /create an account/i }).click();
  await submitSignup(page, { email: newEmail('bystander') });
  await expect(page.getByRole('heading', { name: /confirm your email/i })).toBeVisible({ timeout: 20_000 });

  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// What the confirmation screen claims
// ---------------------------------------------------------------------------

test('the confirm screen claim about the email matches what the server actually did', async ({ page }) => {
  const errors = [];
  failOnPageErrors(page, errors);

  // The signup response carries `verificationSent`, which is the server's own
  // answer to "did the mail go out". It is false whenever the provider is
  // missing or erroring, and also whenever the per-IP hourly send budget is
  // spent, which on a shared school or campus connection is an ordinary
  // Wednesday (RESEND_MAX_PER_HOUR_IP is 30).
  //
  // Whatever that answer is, the screen has to agree with it. Telling somebody a
  // link is in their inbox when nothing was sent leaves them refreshing mail
  // that will never arrive, unable to start a flock or add a friend, with the
  // only button on the screen repeating the same claim.
  let signupBody = null;
  page.on('response', async (res) => {
    if (res.url().includes('/api/auth/signup') && res.request().method() === 'POST') {
      signupBody = await res.json().catch(() => null);
    }
  });

  await openSignupForm(page);
  await submitSignup(page, { email: newEmail('claim') });
  await expect(page.getByRole('heading', { name: /confirm your email/i })).toBeVisible({ timeout: 20_000 });

  expect(signupBody, 'the signup response was not readable').not.toBeNull();
  const serverSentIt = signupBody.verificationSent === true;
  const screenSaysSent = (await page.getByText(/we sent a link/i).count()) > 0;
  expect(screenSaysSent, `screen claims a link was sent: ${screenSaysSent}; server reported verificationSent: ${signupBody.verificationSent}`)
    .toBe(serverSentIt);

  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// The first screen
// ---------------------------------------------------------------------------

test('nothing on the way in spins forever or flashes an error before the data lands', async ({ page }) => {
  const errors = [];
  failOnPageErrors(page, errors);
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': clientIp() });

  const badWords = /went wrong|failed|unable to|couldn't|could not|something broke/i;
  await page.goto('/app', { waitUntil: 'commit' });
  const beforeForm = [];
  for (let i = 0; i < 12; i++) {
    beforeForm.push(normalise(await page.locator('body').innerText().catch(() => '')));
    if (/welcome back/i.test(beforeForm[beforeForm.length - 1])) break;
    await page.waitForTimeout(250);
  }
  await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible({ timeout: 15_000 });
  for (const frame of beforeForm) expect(frame).not.toMatch(badWords);

  const email = newEmail('firstpaint');
  await page.getByRole('button', { name: /create an account/i }).click();
  await submitSignup(page, { email });
  await expect(page.getByRole('heading', { name: /confirm your email/i })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();

  await expect(page.getByText(/no flocks yet/i)).toBeVisible({ timeout: 25_000 });
  // Give every first-screen fetch time to finish, then insist nothing is still
  // pretending to load. A skeleton that never resolves is the failure this is
  // looking for.
  await page.waitForTimeout(6_000);
  const settled = normalise(await page.locator('body').innerText());
  expect(settled).not.toMatch(/loading|please wait|…$/i);
  expect(settled).not.toMatch(badWords);
  expect(errors).toEqual([]);
});

test('every empty panel a brand new account meets explains itself', async ({ page }) => {
  const errors = [];
  failOnPageErrors(page, errors);
  await signUpAndSignIn(page, 'empty');

  // Home. Zero flocks, zero friends.
  await expect(page.getByText(/no flocks yet/i)).toBeVisible();
  await expect(page.getByText(/start one and your people land right here/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /start a flock/i })).toBeEnabled();
  await expect(page.getByRole('button', { name: /add friends/i })).toBeEnabled();

  // Messages. An empty list has to say why it is empty and where chats come from.
  await page.getByRole('button', { name: 'Messages', exact: true }).click();
  await expect(page.getByText(/no conversations yet/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/every flock gets its own chat/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /start a flock/i })).toBeEnabled();

  // Plans.
  await page.getByRole('button', { name: 'Plans', exact: true }).click();
  await expect(page.getByText(/nothing on this day/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/flocks you join land here automatically/i)).toBeVisible();

  // Discover with location declined, which is the state the app must work in.
  await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await expect(page.getByText(/location is off/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/search for a place by name/i)).toBeVisible();

  // Past flocks, reached from home.
  await page.getByRole('button', { name: 'Nest', exact: true }).click();
  await page.getByRole('button', { name: /past flocks/i }).click();
  await expect(page.getByText(/nothing here yet/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/a flock lands here once its night has been and gone/i)).toBeVisible();

  expect(errors).toEqual([]);
});

test('the first screens carry no em dashes', async ({ page }) => {
  // SLOP-AUDIT rule A2, and section H18 calls this the number one regression
  // risk on any new copy. These are the screens a first-time user reads, so
  // this is where it is worth pinning.
  const errors = [];
  failOnPageErrors(page, errors);

  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': clientIp() });
  await page.goto('/app');
  await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH);

  await page.getByRole('button', { name: /create an account/i }).click();
  const email = newEmail('emdash');
  await submitSignup(page, { email });
  await expect(page.getByRole('heading', { name: /confirm your email/i })).toBeVisible({ timeout: 20_000 });
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH);

  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByText(/no flocks yet/i)).toBeVisible({ timeout: 25_000 });
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH);

  expect(errors).toEqual([]);
});

test('the two things the first screen offers cannot be done yet, and the app says so', async ({ page }) => {
  // A brand new account is unverified, and both buttons on its empty home screen
  // are on the UNVERIFIED_DENY list in backend/middleware/auth.js. Offering them
  // anyway is fine ONLY as long as the refusal names the reason and offers the
  // fix. A bare 403 toast here would be the worst first minute in the product.
  const errors = [];
  failOnPageErrors(page, errors);
  await signUpAndSignIn(page, 'gated');

  await page.getByRole('button', { name: /start a flock/i }).first().click();
  await page.locator('#flock-name-input').fill('Taco night');
  // The pause is not padding. The plan name is a SearchInputLocal, which holds
  // what you type locally and only hands it to the parent after a 120ms
  // debounce, so tapping Create Flock inside that window submits an empty name
  // and the screen answers "Name your plan first" over a field that visibly
  // reads Taco night. That is its own defect and it belongs to whoever owns the
  // create screen. This spec is about the verification gate, so it waits the
  // debounce out rather than tripping over it.
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /^create flock$/i }).click();

  await expect(page.getByRole('heading', { name: /confirm your email first/i })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/you can start a flock right away/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /send the link again/i })).toBeEnabled();
  await page.getByRole('button', { name: /not now/i }).click();

  // Still on the create screen after the sheet closes, so leave it the way the
  // arrow in its header does.
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByText(/no flocks yet/i)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /add friends/i }).first().click();
  await page.getByRole('textbox', { name: 'Search by name' }).fill('Ada');
  const addButton = page.getByRole('button', { name: /^add$/i }).first();
  await expect(addButton).toBeVisible({ timeout: 20_000 });
  await addButton.click();

  await expect(page.getByRole('heading', { name: /confirm your email first/i })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/you can add friends right away/i)).toBeVisible();

  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// The first thing a new account edits
// ---------------------------------------------------------------------------

async function openEditProfile(page) {
  await page.getByRole('button', { name: 'You', exact: true }).click();
  await page.getByRole('button', { name: /edit profile/i }).click();
  await expect(page.getByRole('button', { name: /save changes/i })).toBeVisible({ timeout: 15_000 });
}

test('saving the first profile edit tells the person whether it saved', async ({ page }) => {
  const errors = [];
  failOnPageErrors(page, errors);
  await signUpAndSignIn(page, 'savefeedback');

  let putStatus = null;
  page.on('response', (res) => {
    if (res.url().includes('/api/users/profile') && res.request().method() === 'PUT') putStatus = res.status();
  });

  await openEditProfile(page);
  await page.getByLabel(/display name/i).fill('Ada Renamed');
  await page.getByRole('textbox', { name: 'Current password' }).fill(PASSWORD);
  await page.getByRole('button', { name: /save changes/i }).click();

  // The save really does land, so this is not a failed request being reported
  // badly. It is a successful request being reported not at all.
  await expect.poll(() => putStatus, { timeout: 20_000 }).toBe(200);
  await expect(page.getByText(/updated successfully|saved/i)).toBeVisible({ timeout: 10_000 });

  expect(errors).toEqual([]);
});

test('the profile has no Username field, because there is no column behind one', async ({ page }) => {
  const errors = [];
  failOnPageErrors(page, errors);
  await signUpAndSignIn(page, 'username');

  await openEditProfile(page);
  // The field was a dead control: it prefilled with the email's local part,
  // took whatever you typed, sent none of it to the server, and reset itself on
  // save. There is no username column in the schema (backend .claude/CLAUDE.md
  // says so), so an editable field for it could only ever lie about persisting.
  // A field that cannot keep what you type is worse than no field, so it is
  // gone rather than pretending.
  await expect(page.getByLabel(/username/i)).toHaveCount(0);
  // The fields that actually persist are still here.
  await expect(page.getByLabel(/display name/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /save changes/i })).toBeVisible();

  expect(errors).toEqual([]);
});

test('Try again on the Discover banner answers the tap', async ({ page }) => {
  // Location is declined in this suite on purpose: SLOP-AUDIT section K3 says
  // the app has to work when every permission is refused, and an App Store
  // reviewer refuses them. So this is the state a reviewer sees, and K1 is that
  // one dead button rejects the app.
  const errors = [];
  failOnPageErrors(page, errors);
  await signUpAndSignIn(page, 'retry');

  await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await expect(page.getByText(/location is off/i)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const retry = page.getByRole('button', { name: /try again/i }).first();
  // Everything a person could possibly notice, in one string. The live regions
  // are read rather than counted, because the location banner is ITSELF a
  // role="status" element: counting them would make this assertion pass no
  // matter what the button did.
  const observable = async () => JSON.stringify({
    live: (await page.getByRole('status').allInnerTexts()).map(normalise).filter(Boolean).sort(),
    label: normalise(await retry.innerText().catch(() => 'gone')),
    disabled: await retry.isDisabled().catch(() => null),
  });
  const before = await observable();
  await retry.click();

  // One second later, not one frame later. The busy state this button does set
  // is gone again inside a single frame when the permission was already
  // refused, which is not a length of time a person can read. What is left is
  // the identical sentence, so nothing on the screen acknowledges the tap.
  await page.waitForTimeout(1_000);
  const after = await observable();
  expect(
    after,
    'a second after tapping Try again, nothing a person can see has changed',
  ).not.toBe(before);

  expect(errors).toEqual([]);
});
