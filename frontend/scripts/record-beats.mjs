/**
 * record-beats.mjs — film the product doing the thing, against real data.
 *
 * WHY THIS EXISTS. The demonstration film is cut from a Simulator recording of
 * an account that had never voted, never answered a budget and never split a
 * bill. Three of its beats therefore show the app drawing exactly what it
 * should draw for an empty plan: a vote sheet reading zero votes cast, a
 * budget with no amounts behind it, and a bill form sitting on a zero total
 * with its create button greyed out. The narration over those windows
 * describes the opposite. No better window exists in that tape, so the tape is
 * the thing that has to change, not the edit.
 *
 * capture-screenshots.mjs already solves the hard half: embedded Postgres, a
 * seeded flock with real votes and real amounts, the real frontend built
 * against it, and a static server in front. Run that with --keep-alive and the
 * stack stays up. This script drives it and records video rather than stills.
 *
 * WHAT IT IS NOT. It does not seed, build or serve. Boot the stack first:
 *
 *   node scripts/capture-screenshots.mjs --only=chat --set=web --modes=light \
 *        --keep-alive --out=<somewhere temporary>
 *
 * then, in another shell:
 *
 *   node scripts/record-beats.mjs --out=<dir>
 *   node scripts/record-beats.mjs --out=<dir> --only=bill,override
 *
 * SIZE. 402x874 at deviceScaleFactor 3 is 1206x2622, the recording's own
 * frame, so a replaced beat needs no rescale to sit beside the ones that stay.
 *
 * AND THE SAFE AREA, which is the difference between "the same app" and "the
 * same picture". A browser reports no inset, so every screen draws with its
 * header against the top edge, while the phone holds 62 points back for the
 * clock and the island. index.css defines --safe-top over an overridable
 * --safe-area-inset-top for exactly this, so setting that one variable lays
 * the whole app out the way the handset does: measured against the recording,
 * the chat's navy header starts on the same pixel row in both. The status bar
 * itself is composited afterwards from the recording's own frames rather than
 * drawn here, so the clock, the island and the battery are the real ones.
 *
 * ORDER MATTERS, AND IT IS THE FILM'S ORDER, NOT A CONVENIENT ONE. Each beat
 * consumes the state it films: the vote beat locks the venue, the budget beat
 * settles the budget. Shot in the other order the clips still look right one
 * at a time and the cut does not: the first take had the budget settling
 * first, so the plan read as locked in the vote beat and went back to still
 * voting in the budget beat that follows it. Anything added here goes in the
 * position its line holds in the narration.
 *
 * FRAMES, THEN MP4. The camera is the devtools screencast rather than
 * Playwright's own recorder; see the note above startScreencast for why. It
 * writes one JPEG per painted frame with the time it was painted, and those
 * times drive the encode, so the holds between taps survive. ffmpeg must be on
 * PATH, as it already is for the film.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const API_ORIGIN = 'http://127.0.0.1:5210';
const WEB_ORIGIN = 'http://127.0.0.1:3410';
const PASSWORD = 'Screenshot1';
const CAMERA = 'maya@shots.flock.local';
const OWNER = 'owner@shots.flock.local';

/* The handset's own insets, in CSS pixels. 62 is measured off the recording,
   not looked up: the status bar there is 186 device pixels at a scale factor
   of 3. With it applied the chat's navy header begins on row 186 in both, so
   the two sources cut together without a nudge. */
const SAFE_TOP = 62;
const SAFE_BOTTOM = 34;

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const OUT_DIR = path.resolve(arg('out', path.join(process.cwd(), 'beat-footage')));
const ONLY = (arg('only') || '').split(',').map((s) => s.trim()).filter(Boolean);

const log = (m) => console.log(`[beats] ${m}`);
const die = (m) => { console.error(`[beats] FATAL: ${m}`); process.exit(1); };

/* The stack is somebody else's process. Say so plainly rather than failing
   thirty seconds later inside Playwright, naming the wrong thing. */
async function assertStackUp() {
  for (const [what, url] of [['API', `${API_ORIGIN}/api/health`], ['web', `${WEB_ORIGIN}/app`]]) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(String(r.status));
    } catch (err) {
      die(`${what} is not answering at ${url}. Boot the stack with `
        + 'capture-screenshots.mjs --keep-alive first (see this file\'s header).');
    }
  }
}

async function tokenFor(email) {
  const r = await fetch(`${API_ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!r.ok) die(`login failed for ${email}: ${r.status}`);
  const data = await r.json();
  if (!data.token) die(`login for ${email} returned no token`);
  return data.token;
}

const hold = (page, ms) => page.waitForTimeout(ms);

/* A tap the camera can follow. A click and the screen it opens landing on the
   same frame reads as a glitch rather than a press, so every tap sits still
   either side of itself. */
async function tap(page, locator, { before = 550, after = 900 } = {}) {
  await hold(page, before);
  await locator.click({ timeout: 20_000 });
  await hold(page, after);
}

/* Frames pulled out alongside the video, one per named moment, so a beat can
   be checked without scrubbing the clip. */
const still = async (page, name) => {
  const dir = path.join(OUT_DIR, 'frames');
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
};

async function openApp(page, { venue = false, chooser = false } = {}) {
  await page.goto(`${WEB_ORIGIN}/app${venue ? '?venue=true' : ''}`, { waitUntil: 'domcontentloaded' });
  if (chooser) {
    // The screen a signed-in account with no mode chosen lands on. The consent
    // bar is up here too and is not in the film, so it is answered before the
    // early return rather than after it.
    await page.getByRole('button', { name: /Venue Dashboard/i }).first().waitFor({ timeout: 40_000 });
    const ask = page.locator('.cb-wrap .cb-btn', { hasText: 'No thanks' });
    if (await ask.count()) {
      await ask.first().click();
      await page.locator('.cb-wrap').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }
    await hold(page, 1200);
    return;
  }
  if (venue) {
    await page.getByText('Welcome,').first().waitFor({ timeout: 40_000 });
  } else {
    await page.getByRole('navigation', { name: 'Main' }).waitFor({ timeout: 40_000 });
  }
  // The analytics consent bar is up on a fresh profile and is not in the film.
  const no = page.locator('.cb-wrap .cb-btn', { hasText: 'No thanks' });
  if (await no.count()) {
    await no.first().click();
    await page.locator('.cb-wrap').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  }
  await hold(page, 1400);
}

const openFlock = async (page, name) => {
  const nav = page.getByRole('navigation', { name: 'Main' });
  await tap(page, nav.getByRole('button', { name: /^Messages/ }));
  await tap(page, page.getByRole('button', { name: new RegExp(name) }).filter({ visible: true }).first());
  await page.locator('.chat-composer-field').first().waitFor({ timeout: 25_000 });
  await hold(page, 1200);
};

/* ── The beats ──────────────────────────────────────────────────────────── */

const BEATS = {
  /* Beat 9, filmed after the vote, because that is the order the film runs
     them in and this plan carries both.
     The line under this is about everyone quietly saying what they can afford
     and one number coming back that clears for all of them, with nobody's
     own amount on screen. So: the strip that says how many have answered, the
     sheet behind it, and the number landing when it settles. */
  budget: {
    who: 'camera',
    async drive(page) {
      await openFlock(page, 'Friday Night Crew');
      await still(page, 'budget-1-chat');
      await tap(page, page.getByRole('button', { name: 'Open group cash pool' }).first(), { after: 1600 });
      await still(page, 'budget-2-sheet');
      await hold(page, 1800);
      const lock = page.getByRole('button', { name: /Lock Budget/i }).first();
      if (await lock.count()) {
        await tap(page, lock, { after: 2600 });
        await still(page, 'budget-3-locked');
      } else {
        log('  budget: no Lock Budget control (already settled, or not the creator)');
      }
      await hold(page, 1600);
      /* Back to the chat, where the strip now carries the number rather than a
         count of who is still missing. */
      const close = page.getByRole('button', { name: 'Close' }).first();
      if (await close.count()) await tap(page, close, { after: 1500 });
      await still(page, 'budget-4-strip');
      await hold(page, 1200);
    },
  },

  /* Beat 8. Everyone votes, one place takes it, and locking it in turns the
     chat from a conversation into a place at a time. The tape opened this
     sheet on nothing; here it opens on a real tally with the voters named. */
  vote: {
    who: 'camera',
    async drive(page) {
      await openFlock(page, 'Friday Night Crew');
      /* The poll card sits inline in the stream. Scroll it into frame before
         the sheet opens, so the beat can be cut from either. */
      const poll = page.getByText('Where are we going?').first();
      if (await poll.count()) await poll.scrollIntoViewIfNeeded().catch(() => {});
      await hold(page, 1400);
      await still(page, 'vote-1-poll');
      await tap(page, page.getByRole('button', { name: 'Open the venue vote' }).first(), { after: 1800 });
      await still(page, 'vote-2-sheet');
      await hold(page, 2200);
      const lockIn = page.getByRole('button', { name: /^Lock in /i }).first();
      if (await lockIn.count()) {
        await tap(page, lockIn, { after: 3000 });
        await still(page, 'vote-3-locked');
      } else {
        log('  vote: no lock-in control on the sheet');
      }
      await hold(page, 2000);
      await still(page, 'vote-4-chat');
    },
  },

  /* Beat 10. The bill goes in after the night: who covered it, what it came
     to, whether you are tipping, and a link each to settle up. The confirmed
     plan is the one that offers it, which is why this beat is not on the same
     flock as the two above. */
  bill: {
    who: 'camera',
    async drive(page) {
      /* THE SAME PLAN AS THE TWO BEATS BEFORE IT. The bill only appears once a
         plan is locked in, which the vote beat has just done, so the whole run
         from the vote through the group number to the split is one night with
         one set of names on it. Shot on a second plan it still reads correctly
         beat by beat, and the film then changes plan twice in thirty seconds
         under narration about one Friday. */
      await openFlock(page, 'Friday Night Crew');
      await tap(page, page.getByRole('button', { name: 'Open group cash pool' }).first(), { after: 1500 });
      await still(page, 'bill-1-pool');
      await tap(page, page.getByRole('button', { name: /Split the Bill/i }).first(), { after: 1600 });
      await still(page, 'bill-2-form');

      const total = page.locator('input[type="number"]').first();
      await tap(page, total, { after: 400 });
      /* Typed, not filled. A total that appears whole is a screenshot; the
         beat is a person entering it. */
      /* Five people and a number that lands UNDER the group's own published
         ceiling. The budget beat settles at twenty-five a head, so a subtotal
         of 104.60 plus the eighteen per cent tip is 24.69 each: the plan came
         in inside the number the group agreed, which is the whole point of
         having asked. */
      await total.type('104.60', { delay: 130 });
      await hold(page, 1100);
      await still(page, 'bill-3-typed');
      await tap(page, page.getByRole('button', { name: '18%', exact: true }).first(), { after: 1300 });
      await still(page, 'bill-4-tipped');
      const create = page.getByRole('button', { name: /Create Split/i }).first();
      if (await create.isDisabled()) {
        log('  bill: Create Split is still disabled after a total and a tip');
      } else {
        await tap(page, create, { after: 3000 });
      }
      /* The created bill lands at the BOTTOM of the sheet, under whatever the
         budget section is still saying, so the frame that matters is off
         screen until the sheet is scrolled to it. */
      const sheet = page.locator('.modal-content').first();
      await sheet.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await hold(page, 1800);
      await still(page, 'bill-5-created');
      await hold(page, 1400);
      /* Out of the sheet and onto the card the whole flock sees, which is
         where the link to settle up lives. */
      await tap(page, page.getByRole('button', { name: 'Close' }).first(), { after: 1400 });
      const card = page.getByRole('button', { name: /Bill \$.*Open the bill/i }).first();
      if (await card.count()) {
        await tap(page, card, { after: 2400 });
        await still(page, 'bill-6-shares');
        await hold(page, 2000);
      } else {
        log('  bill: no bill card in the chat to open');
        await still(page, 'bill-6-shares');
      }
    },
  },

  /* Beat 4. The invite, and this one replaces a window that was frozen for
     6.7 of its 8.9 seconds AND had "Sam Review" in it, which is the App Store
     reviewer account rather than anybody in the story. The sheet here carries
     the plan's own friends, and the share row above them is the second half of
     the line: a link that wants no account. */
  invite: {
    who: 'camera',
    async drive(page) {
      await openFlock(page, 'Sunday Brunch');
      await tap(page, page.getByRole('button', { name: 'Open the plan' }).first(), { after: 1800 });
      await still(page, 'invite-1-plan');
      await tap(page, page.getByRole('button', { name: 'Invite', exact: true }).first(), { after: 2000 });
      await still(page, 'invite-2-sheet');
      await hold(page, 2200);
      /* The friend the line names, BY NAME. Taking the second Add control in
         the list added whoever happened to be sorted there, which was not the
         person the narration says gets one. */
      const sheet = page.locator('[role="dialog"]').last();
      /* MATCHED BY ROW, NOT BY ANCESTOR TEXT. Walking up from the control to
         find a container mentioning the name climbs past the row into the list
         itself, whose text mentions everybody, so the first control matched and
         the wrong friend was added. The name and its own control share a line;
         that is the thing that identifies the row. */
      const adds = sheet.getByRole('button', { name: 'Add' });
      const nameBox = await sheet.getByText('Sam Rivera', { exact: true }).first().boundingBox();
      let add = null;
      let best = Infinity;
      for (let i = 0; i < await adds.count(); i += 1) {
        const box = await adds.nth(i).boundingBox();
        if (!box || !nameBox) continue;
        const gap = Math.abs((box.y + box.height / 2) - (nameBox.y + nameBox.height / 2));
        if (gap < best) { best = gap; add = adds.nth(i); }
      }
      if (add && best < 24) {
        await tap(page, add, { after: 1600 });
        await still(page, 'invite-3-picked');
        // Adding stages the pick; the button under the list is what sends it.
        const send = sheet.getByRole('button', { name: /^Invite \d+ Friend/ }).first();
        if (await send.count()) await tap(page, send, { after: 2600 });
      } else {
        log('  invite: no Add control for the friend the line names');
      }
      await still(page, 'invite-4-sent');
      await hold(page, 2000);
    },
  },

  /* Beat 5. The map, coloured by what the model expects right now.

     THIS BEAT MAKES PAID CALLS. Opening Discover runs a venue search against
     Google Places, charged to the shared daily budget in
     backend/utils/placesBudget.js, and the same budget meters the owner
     dashboard, so a run here takes lookups away from that. The crowd scores
     painted over the pins are by-id and are not metered. Take the footage in
     one pass rather than iterating on the framing.

     The map debug handle is what the camera move goes through. It is a
     read-and-zoom handle the app only exposes under a flag, so nothing about
     what is drawn changes; a wheel gesture would do the same job with less
     control over how long the move takes. */
  discover: {
    who: 'camera',
    mapDebug: true,
    async drive(page) {
      const nav = page.getByRole('navigation', { name: 'Main' });
      await tap(page, nav.getByRole('button', { name: 'Discover' }), { after: 1000 });
      await page.getByText('Finding venues near you...').waitFor({ state: 'detached', timeout: 90_000 }).catch(() => {});
      await page.locator('.mlb-venue-marker').first().waitFor({ timeout: 90_000 });
      /* MapLibre draws its credit expanded and it reads as a bar of legal text
         across the shot. Dropping the class is the state one tap reaches, and
         the credit stays one tap away, so it is still carried. */
      await page.evaluate(() => {
        document.querySelectorAll('.maplibregl-ctrl-attrib.maplibregl-compact-show')
          .forEach((el) => el.classList.remove('maplibregl-compact-show'));
      }).catch(() => {});
      /* Every pin paints a lettered placeholder first and swaps to the venue's
         photo when it resolves. Filming before the swap makes the map look
         like it failed to load. */
      await page.waitForFunction(
        () => document.querySelectorAll('.mlb-venue-marker img').length > 2,
        { timeout: 60_000 }
      ).catch(() => {});
      /* WARM THE TILES BEFORE THE CAMERA MOVES. The basemap fetches a fresh
         set per zoom level, and a push in that arrives before they do lands on
         MapLibre's empty background: the first take of this beat zoomed into a
         screen of flat dark blue. Jumping to the end of the move with no
         duration, waiting for the tiles, and jumping back leaves them cached,
         so the move that gets filmed has something to draw. */
      const zoom = (z, ms) => page.evaluate(([to, dur]) => {
        const m = window.__flockMapDebug;
        if (m && m.zoomTo) m.zoomTo(to, dur);
      }, [z, ms]).catch(() => {});

      await zoom(14.0, 0);
      await hold(page, 5000);
      await zoom(13.7, 0);
      await hold(page, 2800);

      /* IT PULLS BACK, IT DOES NOT PUSH IN, and the reason is a threshold in
         the basemap rather than taste. Somewhere just above zoom 13.7 the
         style swaps to dark building footprints, and across that line the heat
         this beat is about stops being the thing you look at: two takes pushed
         in and both ended on a street map with the colour washed out of it.
         Pulling back stays under the threshold the whole way and finishes on
         the widest, reddest frame, which is the one the line is describing. */
      await still(page, 'discover-1-map');
      await hold(page, 2200);
      await zoom(13.05, 6000);
      await hold(page, 6600);
      await still(page, 'discover-2-wider');
      await hold(page, 2000);
    },
  },

  /* Beat 6. The same places as a list, each carrying the model's number beside
     the star rating it is not. Same paid search as the beat above. */
  list: {
    who: 'camera',
    async drive(page) {
      const nav = page.getByRole('navigation', { name: 'Main' });
      await tap(page, nav.getByRole('button', { name: 'Discover' }), { after: 900 });
      await page.getByText('Finding venues near you...').waitFor({ state: 'detached', timeout: 90_000 }).catch(() => {});
      const search = page.locator('#search-input');
      await search.waitFor({ timeout: 30_000 });
      const batch = page.waitForResponse((r) => r.url().includes('/api/crowd/batch'), { timeout: 120_000 }).catch(() => null);
      await tap(page, search, { after: 300 });
      await search.type('bars', { delay: 160 });
      await batch;
      await hold(page, 1600);
      await tap(page, page.getByText(/See All Results/).first(), { after: 1800 });
      /* The pill by its accessible name, not by a percent sign: a crowd score
         is a position on a 0 to 100 ladder, not a share of a room's capacity,
         and the app is right not to print one. */
      await page.getByLabel(/out of 100/).first().waitFor({ timeout: 60_000 });
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await hold(page, 2600);
      await still(page, 'list-1-results');
      // Scrolled slowly, so more than one number passes the camera.
      for (let i = 0; i < 5; i += 1) {
        await page.mouse.wheel(0, 230);
        await hold(page, 820);
      }
      await still(page, 'list-2-scrolled');
      await hold(page, 1800);
    },
  },

  /* Beat 13. The same login the app uses, landing somewhere else entirely, so
     the beat has to START at the chooser rather than inside the dashboard. It
     also has to be THIS bar: the film has just spent three beats on the plan
     that picked it, and the line says "the bar", so a dashboard belonging to
     some other business in another state is a different claim than the one
     being made. */
  venue: {
    who: 'owner',
    chooser: true,
    async drive(page) {
      await hold(page, 2600);
      await still(page, 'venue-1-chooser');
      await tap(page, page.getByRole('button', { name: /Venue Dashboard/i }).first(), { after: 1200 });
      await page.getByText('Welcome,').first().waitFor({ timeout: 40_000 });
      const no = page.locator('.cb-wrap .cb-btn', { hasText: 'No thanks' });
      if (await no.count()) await no.first().click();
      await hold(page, 3400);
      await still(page, 'venue-2-landed');
      await hold(page, 1800);
    },
  },

  /* Beat 14. What the bar can do once it is in there: see who is circling it
     tonight, put up a deal or an event, and answer the reviews where they were
     left. Four windows in the cut, so four places to stop. */
  tabs: {
    who: 'owner',
    async drive(page) {
      await hold(page, 2000);
      await still(page, 'tabs-1-analytics');
      for (const [label, frame] of [['Promotions', 'tabs-2-promotions'], ['Events', 'tabs-3-events'], ['Reviews', 'tabs-4-reviews']]) {
        await tap(page, page.getByRole('button', { name: label, exact: true }).first(), { after: 2400 });
        await still(page, frame);
        await hold(page, 1200);
      }
    },
  },

  /* Beat 15, and the one the tape never managed at all: an override that
     overrides. The slider moves, the number is posted, and the screen says
     back that this is now the number everybody sees. */
  override: {
    who: 'owner',
    /* A live reading expires by itself after ninety minutes, which is longer
       than a second take. With one still standing the control reads "update"
       rather than "set" and the line over this beat is about the first time
       somebody corrects the model, so the room is cleared before the camera
       rolls. This is the venue's own endpoint, the one the Clear control on
       that screen calls. */
    async before(tokens) {
      const r = await fetch(`${API_ORIGIN}/api/venue-dashboard/busy-now`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokens.owner}` },
      });
      log(`  override: cleared any live reading (${r.status})`);
    },
    async drive(page) {
      const slider = page.locator('input[type="range"]').first();
      await slider.waitFor({ timeout: 20_000 });
      await slider.scrollIntoViewIfNeeded().catch(() => {});
      await hold(page, 1600);
      await still(page, 'override-1-slider');
      const box = await slider.boundingBox();
      if (!box) die('the live-number slider has no box to drag');
      /* Dragged in steps, at thumb speed. One jump to the end point would
         move the handle in a single frame. */
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
      await page.mouse.down();
      for (let i = 51; i <= 82; i += 1) {
        await page.mouse.move(box.x + box.width * (i / 100), box.y + box.height / 2);
        await page.waitForTimeout(28);
      }
      await page.mouse.up();
      await hold(page, 1400);
      await still(page, 'override-2-dragged');
      await tap(page, page.getByRole('button', { name: /Set live number/i }).first(), { after: 3000 });
      await still(page, 'override-3-live');
      await hold(page, 2200);
    },
  },
};

// The order they change state in. --only picks a subset without reordering it.
// The order the narration runs in: beat 8 is the vote, beat 9 the budget.
const ORDER = ['invite', 'discover', 'list', 'vote', 'budget', 'bill', 'venue', 'tabs', 'override'];

/* ── The camera ─────────────────────────────────────────────────────────────
 *
 * NOT Playwright's own recordVideo, and the reason is worth keeping. That
 * records at the page's CSS size and will only ever scale a frame DOWN to the
 * size asked for, so a 402-point viewport at scale factor 3 asked to write
 * 1206x2622 does not render at 1206: it writes 402x874 of picture into the
 * corner of a 1206x2622 grey canvas. The first take of these beats came back
 * exactly like that, a third of the resolution with a grey letterbox, which
 * looks like a correct file until the pixels are sampled.
 *
 * The devtools screencast has no such rule. It hands over what the compositor
 * actually drew, which at scale factor 3 is 1206x2622 device pixels, the same
 * frame the recording it sits beside was made at.
 *
 * Frames arrive only when something changes, each stamped with the time it was
 * painted. That is what the hold between taps is for and it must survive into
 * the file, so the encode is driven off those stamps rather than a fixed rate:
 * a frame stays on screen until the next one was painted, and the run ends on
 * the last frame held for a beat rather than cut on it.
 */
async function startScreencast(context, page, dir) {
  const cdp = await context.newCDPSession(page);
  const frames = [];
  let seq = 0;
  let stopped = false;

  cdp.on('Page.screencastFrame', async (f) => {
    if (!stopped) {
      const file = path.join(dir, `f${String(seq++).padStart(5, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
      frames.push({ file, t: f.metadata.timestamp });
    }
    /* The acknowledgement is what asks for the next frame. Without it the
       screencast delivers one and stops, which reads as a frozen recording. */
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch (err) { /* closing */ }
  });

  await cdp.send('Page.startScreencast', {
    format: 'jpeg', quality: 92, maxWidth: 1206, maxHeight: 2622, everyNthFrame: 1,
  });

  return {
    frames,
    async stop() {
      stopped = true;
      try { await cdp.send('Page.stopScreencast'); } catch (err) { /* already gone */ }
    },
  };
}

/** Width and height of a captured frame, read from the JPEG itself. */
function frameSize(file) {
  const buf = fs.readFileSync(file);
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    // SOF0..SOF15, minus the four that are not frame headers.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return { width: 0, height: 0 };
}

/* The captured frames, at the times they were painted, encoded to constant
   rate. The film's own source is CFR and assemble.py retimes every window to
   the length of its line, which a variable rate turns from a calculation into
   a guess. */
function encodeFrames(cam, out) {
  const { frames } = cam;
  const listFile = path.join(path.dirname(frames[0].file), 'frames.txt');
  const lines = [];
  for (let i = 0; i < frames.length; i += 1) {
    const next = frames[i + 1];
    // The last frame has no successor to end it, so it gets a beat of its own.
    const dur = next ? Math.max(next.t - frames[i].t, 1 / 240) : 0.5;
    lines.push(`file '${frames[i].file.replace(/\\/g, '/')}'`);
    lines.push(`duration ${dur.toFixed(4)}`);
  }
  // concat needs the final file named twice or it drops the last duration.
  lines.push(`file '${frames[frames.length - 1].file.replace(/\\/g, '/')}'`);
  fs.writeFileSync(listFile, `${lines.join('\n')}\n`);

  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-vf', 'fps=30', '-c:v', 'libx264', '-crf', '17', '-preset', 'medium',
      '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', out,
    ], { stdio: 'inherit' });
    ff.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}`))));
    ff.on('error', reject);
  });
}

async function recordBeat(name, beat, browser, tokens) {
  // Anything a beat needs put right before the camera rolls.
  if (beat.before) await beat.before(tokens);
  const raw = path.join(OUT_DIR, '_raw', name);
  fs.mkdirSync(raw, { recursive: true });
  const isOwner = beat.who === 'owner';
  /* A beat that opens on the mode chooser must arrive with no mode chosen,
     which is the one thing the deep link and the stored mode both skip. */
  const onChooser = !!beat.chooser;
  const context = await browser.newContext({
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: ['geolocation'],
    geolocation: { latitude: 39.9526, longitude: -75.1652 },
  });
  await context.addInitScript(([jwt, mode, top, bottom, mapDebug]) => {
    localStorage.setItem('flock-theme-mode', 'manual');
    localStorage.setItem('flock-theme', 'light');
    localStorage.setItem('flock_notif_denied', 'true');
    if (mode) localStorage.setItem('flockUserMode', mode);
    if (mode === 'venue') localStorage.setItem('flockVenueOnboardingComplete', 'true');
    localStorage.setItem('flock_user_lat', '39.9526');
    localStorage.setItem('flock_user_lng', '-75.1652');
    localStorage.setItem('flockToken', jwt);
    if (mapDebug) window.__FLOCK_MAP_DEBUG__ = true;
    // The handset's insets, which a browser reports as zero. See the header.
    const el = document.createElement('style');
    el.textContent = `:root{--safe-area-inset-top:${top}px;--safe-area-inset-bottom:${bottom}px;}`;
    const attach = () => document.head && document.head.appendChild(el);
    if (document.head) attach();
    else document.addEventListener('DOMContentLoaded', attach);
  }, [isOwner ? tokens.owner : tokens.camera,
    onChooser ? '' : (isOwner ? 'venue' : 'user'), SAFE_TOP, SAFE_BOTTOM, !!beat.mapDebug]);

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 160)));

  const cam = await startScreencast(context, page, raw);
  try {
    await openApp(page, { venue: isOwner && !onChooser, chooser: onChooser });
    await beat.drive(page);
  } finally {
    await cam.stop();
    await context.close();
  }
  if (errors.length) log(`  ${name}: ${errors.length} page error(s), first: ${errors[0]}`);
  if (!cam.frames.length) { log(`  ${name}: no frames captured`); return null; }

  const mp4 = path.join(OUT_DIR, `${name}.mp4`);
  await encodeFrames(cam, mp4);
  const first = frameSize(cam.frames[0].file);
  log(`  ${name}: ${path.basename(mp4)} (${(fs.statSync(mp4).size / 1e6).toFixed(1)} MB, `
    + `${cam.frames.length} frames at ${first.width}x${first.height})`);
  return mp4;
}

async function main() {
  await assertStackUp();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tokens = { camera: await tokenFor(CAMERA), owner: await tokenFor(OWNER) };
  log(`signed in as ${CAMERA} and ${OWNER}`);

  const names = ORDER.filter((n) => ONLY.length === 0 || ONLY.includes(n));
  if (!names.length) die(`--only matched nothing. Beats: ${ORDER.join(', ')}`);

  /* THE FLAG IS WHAT MAKES THE RECORDING FULL SIZE, and the context option is
     not. A context's deviceScaleFactor tells the page what it is being drawn
     at, and page.screenshot honours it, but the devtools screencast this
     records through hands back the compositor's own surface, which without
     this flag is 402x874 whatever the page believes. Both are set: the flag so
     the frames are 1206x2622, the option so the stills pulled alongside them
     match. Measured, not assumed, after a take came back a third of the size
     with a grey letterbox around it. */
  const browser = await chromium.launch({ args: ['--force-device-scale-factor=3'] });
  try {
    for (const name of names) {
      log(`recording ${name}`);
      await recordBeat(name, BEATS[name], browser, tokens);
    }
  } finally {
    await browser.close();
  }
  log(`footage in ${OUT_DIR}`);
}

main().catch((err) => die(err && err.stack ? err.stack : String(err)));
