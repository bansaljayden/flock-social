/* Directions offers Apple Maps, driven through the screen.
 *
 * App Review rejected 1.0 under Guideline 4 on 2026-10-07: every way from the
 * app to a map went to Google Maps, and Apple asked for "the option to launch
 * the native Apple Maps app". A plan's Directions and the venue card's Get
 * Directions now open one "Open in" sheet (components/ui/MapsChooser.js).
 * This walks both on the suite's WebKit iPhone, where Apple Maps is listed
 * first, and checks the link each choice opens. The map hosts are answered
 * locally, so nothing leaves the machine.
 *
 * SETUP THAT CANNOT COME THROUGH THE SCREEN, the same two pieces venue.spec.js
 * explains: email confirmation (verifyByHand runs the statement the real
 * route runs), and a venue on the plan, because stack.js has no Places key so
 * no search can put one there. The venue details request is answered with the
 * shape GET /api/venues/details returns, for the same reason.
 */
'use strict';

const path = require('path');
const { createRequire } = require('module');
const { test, expect, devices } = require('@playwright/test');
const { newEmail, adultDob, pinToLocalApi, failOnPageErrors, randomTag } = require('./helpers');

const WEB_BASE = `http://127.0.0.1:${process.env.E2E_WEB_PORT || 3199}`;
const PHONE = { ...devices['iPhone 13'], baseURL: WEB_BASE, permissions: [] };

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
  if (!rows[0]) throw new Error(`verifyByHand matched no account for ${email}`);
  return rows[0].id;
}

const PASSWORD = 'E2eTesting!2026';
const FLOCK_NAME = 'Map Night';
const VENUE = {
  id: 'ChIJwrenRoomMapsTest01',
  name: 'The Wren Room',
  address: '12 Aviary Lane, Bethlehem, PA 18015',
  lat: 40.6112,
  lng: -75.3746,
  googleUrl: 'https://maps.google.com/?cid=4242',
};

async function signUpVerified(page, name) {
  const email = newEmail('maps');
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

async function newSignedInPhone(browser, name, errors) {
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  failOnPageErrors(page, errors);
  pinToLocalApi(page);
  const account = await signUpVerified(page, name);
  return { context, page, account };
}

const IN_CHAT = (page) => page.getByRole('button', { name: 'More to send' });

// Two invitees: a flock of two is a direct message in this product.
async function createFlock(page, inviteeNames) {
  await page.getByRole('button', { name: /^start a flock$/i }).click();
  await page.getByRole('textbox', { name: /what's the plan/i }).fill(FLOCK_NAME);
  for (const who of inviteeNames) {
    await page.getByRole('textbox', { name: /search people by name/i }).fill(who);
    await expect(page.getByRole('button', { name: new RegExp(who) }).first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: new RegExp(who) }).first().click();
  }
  await page.getByRole('button', { name: /create flock/i }).click();
  await expect(page.getByRole('heading', { name: `${FLOCK_NAME} is made.`, exact: true })).toBeVisible({ timeout: 40_000 });
  await page.getByRole('button', { name: /^not now$/i }).click();
  await expect(IN_CHAT(page)).toBeVisible({ timeout: 40_000 });
}

// The page a choice opens, answered locally.
async function nextMapPage(context, choose) {
  const opened = context.waitForEvent('page');
  await choose();
  const map = await opened;
  await map.waitForLoadState('domcontentloaded');
  const url = map.url();
  await map.close();
  return url;
}

test('a plan and its venue card each offer Apple Maps, first on an iPhone', async ({ browser }) => {
  test.setTimeout(300_000);
  const errors = [];
  const tag = randomTag(5);
  const names = [`Mara ${tag}`, `Ned ${tag}`, `Ola ${tag}`];
  const host = await newSignedInPhone(browser, names[0], errors);
  for (const name of names.slice(1)) {
    const other = await newSignedInPhone(browser, name, errors);
    await other.context.close();
  }
  await createFlock(host.page, names.slice(1));

  await withDb(async (c) => {
    const flockId = (await c.query('SELECT id FROM flocks WHERE creator_id = $1 ORDER BY id DESC LIMIT 1', [host.account.id])).rows[0].id;
    await c.query(
      'UPDATE flocks SET venue_name = $2, venue_address = $3, venue_id = $4, venue_latitude = $5, venue_longitude = $6 WHERE id = $1',
      [flockId, VENUE.name, VENUE.address, VENUE.id, VENUE.lat, VENUE.lng],
    );
  });

  // Nothing leaves the machine: both map hosts are answered here.
  await host.context.route(/^https:\/\/(maps\.apple\.com|maps\.google\.com|www\.google\.com)\//, (route) => route.fulfill({
    status: 200, contentType: 'text/html', body: '<!doctype html><title>map</title>',
  }));
  await host.page.route((url) => url.pathname === '/api/venues/details', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      venue: {
        place_id: VENUE.id,
        name: VENUE.name,
        formatted_address: VENUE.address,
        rating: 4.6,
        user_ratings_total: 12,
        photos: [],
        photo_url: null,
        types: ['bar'],
        location: { latitude: VENUE.lat, longitude: VENUE.lng },
        google_maps_url: VENUE.googleUrl,
      },
    }),
  }));

  // The venue sheet waits for its crowd reading as well as the details, and
  // with no BestTime key here that read can take a while: answered as none.
  await host.page.route((url) => url.pathname.startsWith('/api/crowd/'), (route) => route.fulfill({
    status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'No crowd data for this venue' }),
  }));

  // Reload so the plan is read with its venue, then open it.
  await host.page.reload();
  await host.page.getByRole('button', { name: /^Messages(,|$)/ }).click();
  await host.page.getByRole('button', { name: new RegExp(FLOCK_NAME) }).first().click();
  await expect(IN_CHAT(host.page)).toBeVisible({ timeout: 25_000 });
  await host.page.getByRole('button', { name: 'Open the plan' }).click();
  await expect(host.page.getByRole('heading', { name: VENUE.name })).toBeVisible({ timeout: 25_000 });

  // A plan's Directions: Apple Maps first on an iPhone, then Google Maps.
  const chooser = host.page.getByRole('dialog', { name: 'Open in a maps app' });
  await host.page.getByRole('button', { name: /^directions$/i }).click();
  await expect(chooser).toBeVisible();
  await expect(chooser.getByRole('button')).toHaveText(['Apple Maps', 'Google Maps', 'Cancel']);
  expect(await nextMapPage(host.context, () => chooser.getByRole('button', { name: 'Apple Maps' }).click()))
    .toBe('https://maps.apple.com/?ll=40.6112,-75.3746&q=The%20Wren%20Room');
  await expect(chooser).toBeHidden();

  await host.page.getByRole('button', { name: /^directions$/i }).click();
  expect(await nextMapPage(host.context, () => chooser.getByRole('button', { name: 'Google Maps' }).click()))
    .toBe(`https://www.google.com/maps/search/?api=1&query=The%20Wren%20Room&query_place_id=${VENUE.id}`);

  // The venue card's Get Directions, on top of the venue sheet. While the
  // details load, the sheet holds what the plan saved, coordinates included,
  // so Apple Maps gets the exact pin straight away.
  await host.page.getByRole('button', { name: /^details$/i }).click();
  const getDirections = host.page.getByRole('button', { name: /get directions/i });
  await expect(getDirections).toBeVisible({ timeout: 25_000 });
  await expect(host.page.getByText('Loading details...')).toBeHidden({ timeout: 25_000 });

  // Escape and a tap outside each close the chooser and leave the venue sheet.
  await getDirections.click();
  await expect(chooser).toBeVisible();
  await host.page.keyboard.press('Escape');
  await expect(chooser).toBeHidden();
  await expect(getDirections).toBeVisible();
  await getDirections.click();
  await expect(chooser).toBeVisible();
  await host.page.mouse.click(20, 20);
  await expect(chooser).toBeHidden();
  await expect(getDirections).toBeVisible();

  await getDirections.click();
  expect(await nextMapPage(host.context, () => chooser.getByRole('button', { name: 'Apple Maps' }).click()))
    .toBe('https://maps.apple.com/?ll=40.6112,-75.3746&q=The%20Wren%20Room');
  await getDirections.click();
  expect(await nextMapPage(host.context, () => chooser.getByRole('button', { name: 'Google Maps' }).click()))
    .toBe(VENUE.googleUrl);

  expect(errors).toEqual([]);
  await host.context.close();
});
