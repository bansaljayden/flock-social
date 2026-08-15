/**
 * THE INVITE SCREEN, REBUILT — /i/:token, 2026-08-14.
 *
 * Jayden's report was three things at once: "when I send an invite they don't
 * get a direct link to being able to text in that flock", "the screen should be
 * better", and "it should tell what that person says in the flock whether they
 * are going or not".
 *
 * The deep accessibility contract for this page (labels, live regions, focus
 * moves, contrast, hover) is owned by marketingSiteAccessibility.test.js and
 * websiteA11y.test.js, and nothing here duplicates it. This file pins the three
 * things the rebuild is FOR:
 *
 *   1. THE WAY IN. Joining is the page's primary action, it stashes the invite
 *      token where the app will find it after signup or login, and it is the
 *      only filled control on the page so it cannot be lost among the others.
 *   2. THE ROSTER. Every person, by name, with going / not going / no answer,
 *      carried by an icon AND a word AND the row's weight rather than by a tint.
 *   3. NO DEAD ENDS. A plan that is over shows no action that cannot work, and
 *      a link that is longer than the old client-side cap still opens.
 *
 * Plus the handoff service the first of those depends on, which is the piece
 * that has to survive a full page load and an OAuth round trip.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, waitFor, act } = require('@testing-library/react');

const WEBSITE = path.join(__dirname, '..', 'website');
const readSrc = (f) => fs.readFileSync(path.join(WEBSITE, f), 'utf8');

// A 24-character token: exactly what backend/routes/guest.js mints today
// (LINK_TOKEN_LENGTH). The page used to cap tokens at 20 characters, so every
// freshly created invite link died on this client before it reached the server.
const NEW_TOKEN = 'AbCdEfGhJkLmNpQrStUvWxYz';

const PLAN = {
  flock: { name: 'Friday Night Out', when: null, status: 'planning', chosenVenue: null },
  host: 'Maya',
  going: 3,
  people: [
    { name: 'Maya', rsvp: 'in', kind: 'member' },
    { name: 'Jordan', rsvp: 'in', kind: 'member' },
    { name: 'Sam', rsvp: 'in', kind: 'guest' },
    { name: 'Noor', rsvp: 'out', kind: 'member' },
    { name: 'Theo', rsvp: 'none', kind: 'member' },
  ],
  venues: [{ venue_name: 'The Bookstore Speakeasy', votes: 2 }],
};

const okWith = (body) => () => Promise.resolve({
  ok: true, status: 200, json: () => Promise.resolve(body),
});

describe('GuestInvite: the rebuilt screen', () => {
  // eslint-disable-next-line global-require
  const GuestInvite = require('../website/GuestInvite').default;

  const mount = (respond, token = NEW_TOKEN) => {
    window.history.pushState({}, '', `/i/${token}`);
    global.fetch = jest.fn(respond);
    return render(React.createElement(GuestInvite));
  };

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  // ── 1. the way in ───────────────────────────────────────────────────────

  test('a 24-character token, the length the server mints, actually opens', async () => {
    // The regression this page shipped with: TOKEN_MAX was 20, the generator
    // was widened to 24, and the page answered every new link with "That link
    // isn't complete" without ever asking the server.
    const { container } = mount(okWith(PLAN));
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });
    expect(container.textContent).not.toMatch(/isn't complete/i);
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining(NEW_TOKEN));

    // And the bound the page enforces is the bound the server enforces.
    const src = readSrc('GuestInvite.js');
    expect(src).toMatch(/const TOKEN_MIN = 8;/);
    expect(src).toMatch(/const TOKEN_MAX = 64;/);
  });

  // jsdom's Location is sealed: `assign` is neither writable nor configurable,
  // so the navigation itself cannot be observed from a test. The half that can
  // go wrong silently IS observable, and it is the one that matters: the token
  // must be in storage BEFORE the browser is sent anywhere, or the person
  // arrives at signup with nothing to redeem. The destinations are pinned by a
  // source scan directly below, so both halves are held.
  test('joining is the primary action and it hands the token to the app first', async () => {
    mount(okWith(PLAN));
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });

    fireEvent.click(screen.getByRole('button', { name: /^join/i }));

    const saved = JSON.parse(window.localStorage.getItem('flock_pending_invite'));
    expect(saved.token).toBe(NEW_TOKEN);
    expect(saved.flockName).toBe('Friday Night Out');
    expect(typeof saved.at).toBe('number');
  });

  test('the sign-in route carries the token too, so a returning user is not dropped', async () => {
    mount(okWith(PLAN));
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });

    fireEvent.click(screen.getByRole('button', { name: /sign in and join/i }));
    expect(JSON.parse(window.localStorage.getItem('flock_pending_invite')).token).toBe(NEW_TOKEN);
  });

  test('both ways in stash before they navigate, and they go where the app lives', () => {
    const src = readSrc('GuestInvite.js');
    // One function does both, and the write is unconditionally first: a plain
    // <a href> would race the storage write, which is why this is a button.
    expect(src).toMatch(
      /const goJoin = \(where\) => \{\s*stashInvite\(token, flockName\);\s*window\.location\.assign\(where\);/
    );
    // index.js routes /signup into App.js on the create-account screen, and
    // /app is the canonical web entry for a session that already exists.
    expect(src).toContain("goJoin('/signup')");
    expect(src).toContain("goJoin('/app')");
    const routes = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    expect(routes).toMatch(/\/\^\\\/signup\$\//);
    expect(routes).toMatch(/\/\^\\\/app\(\\\/\|\$\)\//);
  });

  test('a long flock name does not turn the primary button into a paragraph', async () => {
    // flocks.name is long enough that a real title made the one primary action
    // on the page five lines tall at 320px. Short names still get the specific
    // label, because it is better when it fits.
    const { container } = mount(okWith(PLAN));
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });
    expect(container.querySelector('.gi-join-btn').textContent).toBe('Join "Friday Night Out"');

    const long = 'A'.repeat(60);
    const { container: c2 } = mount(okWith({ ...PLAN, flock: { ...PLAN.flock, name: long } }));
    await waitFor(() => expect(c2.querySelector('h1').textContent).toBe(long));
    expect(c2.querySelector('.gi-join-btn').textContent).toBe('Join this flock');
    // The token handed to the app is still the real one, and the name it
    // carries is still capped by the service.
    fireEvent.click(c2.querySelector('.gi-join-btn'));
    expect(JSON.parse(window.localStorage.getItem('flock_pending_invite')).flockName).toBe(long);
  });

  test('the join band is the only filled control, so nothing competes with it', async () => {
    const { container } = mount(okWith(PLAN));
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });

    // The RSVP answers used to carry gi-btn-primary, which put a second
    // ink-filled button on the page arguing with the real one.
    for (const btn of container.querySelectorAll('.gi-row .gi-btn')) {
      expect(btn.className).not.toMatch(/gi-btn-primary|gi-btn-strong/);
    }
    expect(container.querySelectorAll('.gi-join-btn')).toHaveLength(1);
  });

  test('the guest path says plainly that it does not reach the chat', async () => {
    // The honest half of the same decision the backend enforces: guest RSVP is
    // not a quieter way into the conversation, and implying it was would be a
    // promise the product deliberately does not keep.
    const { container } = mount(okWith(PLAN));
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });
    expect(container.textContent).toMatch(/does not put you in the chat/i);
  });

  // ── 2. the roster ───────────────────────────────────────────────────────

  test('every person is named with their own answer', async () => {
    const { container } = mount(okWith(PLAN));
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });

    const rows = Array.from(container.querySelectorAll('.gi-who-row'));
    expect(rows).toHaveLength(5);

    const read = (row) => ({
      name: row.querySelector('.gi-who-name').textContent,
      // Visually the answer is the glyph plus the legend above the list; this
      // is the spelled-out copy of it that a screen reader gets.
      state: row.querySelector('.gi-sr').textContent,
      guest: !!row.querySelector('.gi-who-kind'),
    });
    // Yes first, then no, then silence: the most useful line is the first one.
    expect(rows.map(read)).toEqual([
      { name: 'Maya', state: 'Going', guest: false },
      { name: 'Jordan', state: 'Going', guest: false },
      { name: 'Sam', state: 'Going', guest: true },
      { name: 'Noor', state: 'Out', guest: false },
      { name: 'Theo', state: 'No answer', guest: false },
    ]);
  });

  test('an answer is carried by a glyph AND a word, never by colour alone', async () => {
    const { container } = mount(okWith(PLAN));
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });

    for (const row of container.querySelectorAll('.gi-who-row')) {
      // The glyph comes from the icon system, and it is decoration: the word
      // beside it is what a screen reader reads.
      const mark = row.querySelector('.gi-who-mark svg');
      expect(mark).not.toBeNull();
      expect(Number(mark.getAttribute('width'))).toBeGreaterThanOrEqual(12);
      expect(row.querySelector('.gi-who-mark [aria-hidden="true"], .gi-who-mark[aria-hidden="true"]')
        || row.querySelector('.gi-who-mark span[aria-hidden="true"]')).not.toBeNull();
      expect(row.querySelector('.gi-sr').textContent.trim().length).toBeGreaterThan(0);
    }
  });

  test('the tally reads the roster, so the numbers can never disagree with the names', async () => {
    const { container } = mount(okWith(PLAN));
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });

    const cells = Array.from(container.querySelectorAll('.gi-tally-cell')).map((c) => [
      c.querySelector('.gi-tally-n').textContent,
      c.querySelector('.gi-tally-k').textContent,
    ]);
    expect(cells).toEqual([['3', 'Going'], ['1', 'Out'], ['1', 'No answer']]);

    // The strip is also the legend: each count carries the glyph the list will
    // use for that answer, which is what lets the rows drop the repeated word.
    for (const cell of container.querySelectorAll('.gi-tally-k')) {
      expect(cell.querySelector('svg')).not.toBeNull();
    }
  });

  test('an unknown answer reads as "no answer" instead of rendering undefined', async () => {
    // The payload is server-controlled, but a client that renders `undefined`
    // at somebody because a field was renamed is a client that will do it in
    // production before anyone notices.
    const { container } = mount(okWith({
      ...PLAN,
      people: [{ name: 'Ada', rsvp: 'maybe', kind: 'member' }, { name: '   ', rsvp: 'in', kind: 'guest' }],
    }));
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });

    const rows = container.querySelectorAll('.gi-who-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.gi-who-name').textContent).toBe('Ada');
    expect(rows[0].querySelector('.gi-sr').textContent).toBe('No answer');
    expect(container.textContent).not.toMatch(/undefined/);
  });

  test('an empty roster invites rather than reading as broken', async () => {
    const { container } = mount(okWith({ ...PLAN, people: [], going: 0 }));
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });
    expect(container.querySelector('.gi-tally')).toBeNull();
    expect(container.textContent).toMatch(/you would be the first/i);
  });

  test('an old server with no roster is not reported as nobody answering', async () => {
    // The frontend deploys to Vercel and the backend to Railway, separately, so
    // there is always a window where the page is newer than the API. Rendering
    // "nobody has answered yet" over a plan that five people are going to would
    // be the page inventing a fact, in the direction that costs a join.
    const { people, ...oldPayload } = PLAN;
    const { container } = mount(okWith({ ...oldPayload, going: 5 }));
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });
    expect(container.textContent).not.toMatch(/nobody has answered/i);
    expect(container.textContent).toMatch(/5 people are in so far/i);
  });

  test('a long roster is bounded and says so, rather than becoming a directory', async () => {
    const many = Array.from({ length: 22 }, (_, i) => ({ name: `Person${i}`, rsvp: 'in', kind: 'member' }));
    const { container } = mount(okWith({ ...PLAN, people: many }));
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });

    expect(container.querySelectorAll('.gi-who-row')).toHaveLength(14);
    expect(container.textContent).toMatch(/and 8 more people on the plan/i);
  });

  // ── 3. no dead ends ─────────────────────────────────────────────────────

  test('a plan that is over shows no action that cannot work', async () => {
    // SLOP-AUDIT H5 / Apple K1: a reviewer finding one button that does
    // nothing rejects the app, and a button that answers "this is closed" is
    // worse than no button at all.
    const { container } = mount(okWith({
      ...PLAN,
      flock: { ...PLAN.flock, status: 'cancelled' },
    }));
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });

    expect(container.querySelector('.gi-join')).toBeNull();
    expect(container.querySelector('#gi-name')).toBeNull();
    expect(screen.queryByRole('button', { name: /^join/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /i'm in/i })).toBeNull();
    // The record of the plan is still readable, which is why the page stays up.
    expect(container.textContent).toMatch(/called off/i);
    expect(container.querySelectorAll('.gi-who-row')).toHaveLength(5);
  });

  test('a plan with no time and no venue says so rather than leaving a blank', async () => {
    const { container } = mount(okWith({ ...PLAN, venues: [] }));
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });

    const facts = Array.from(container.querySelectorAll('.gi-fact')).map((f) => [
      f.querySelector('.gi-fact-k').textContent.trim(),
      f.querySelector('.gi-fact-v').textContent.trim(),
    ]);
    expect(facts).toEqual([['When', 'Not set yet'], ['Where', 'Not decided yet']]);
  });

  test('a host\'s starting venue is not reported as the group\'s decision', async () => {
    // flocks.venue_name can be set at creation, before a single vote exists.
    // Calling that "where it is" would be the page inventing a fact.
    const { container } = mount(okWith({
      ...PLAN,
      flock: { ...PLAN.flock, status: 'planning', chosenVenue: 'Good Dog Bar' },
    }));
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });
    const where = container.querySelectorAll('.gi-fact-v')[1].textContent;
    expect(where).toMatch(/if the vote holds/i);

    // Confirmed is the status that means the group actually chose.
    const { container: c2 } = mount(okWith({
      ...PLAN,
      flock: { ...PLAN.flock, status: 'confirmed', chosenVenue: 'Good Dog Bar' },
    }));
    await waitFor(() => expect(c2.querySelectorAll('.gi-fact-v')[1].textContent).toBe('Good Dog Bar'));
  });

  // ── the look, in the places a source scan can hold it ───────────────────

  test('the page carries no tile grid, no badge, no gradient and no shadow', () => {
    const raw = fs.readFileSync(path.join(WEBSITE, 'GuestInvite.css'), 'utf8');
    // Comments carry the reasoning and are allowed to name a banned pattern;
    // only what the browser applies is under this rule.
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/gradient/i);
    expect(css).not.toMatch(/box-shadow/i);
    // One inverted band is the page's only fill, and it is a full-bleed band
    // rather than a floating card: it breaks out of the reading column by
    // exactly the page gutter.
    expect(css).toMatch(/\.gi-join \{[^}]*margin: [^;]*calc\(-1 \* var\(--gi-gutter\)\)/);
    expect(css).toMatch(/--gi-gutter: clamp\(16px, 5vw, 40px\)/);
  });

  test('every glyph on the page comes from the icon system, at or above the 12px floor', () => {
    const src = readSrc('GuestInvite.js');
    expect(src).toMatch(/import Icons from '\.\.\/components\/ui\/Icons'/);
    const sizes = [...src.matchAll(/Icons\[[a-zA-Z.]+\]\([^,]+,\s*(\d+)\)/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    for (const s of sizes) expect(s).toBeGreaterThanOrEqual(12);
    // No emoji standing in for an icon (SLOP-AUDIT H14).
    expect(src).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  test('the brand bird is a composite and is never a tiny functional glyph', () => {
    const src = readSrc('GuestInvite.js');
    const css = fs.readFileSync(path.join(WEBSITE, 'GuestInvite.css'), 'utf8');
    // Body and head on the same canvas: a bare body is a blurry-faced bird.
    expect(src).toContain('/birdie/warm-bird-400.webp');
    expect(src).toContain('/birdie/warm-bird-head-400.webp');
    // WebP with the PNG kept as the fallback, and it never blocks the plan.
    expect(src).toMatch(/loading="lazy"/);
    // Above the ~40px floor at every width this page is read at.
    expect(css).toMatch(/\.gi-join-bird \{[^}]*width: clamp\(66px, 21vw, 108px\)/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The handoff service: what has to survive signup, login, the Google popup and
// the native Sign in with Apple sheet.
// ───────────────────────────────────────────────────────────────────────────

jest.mock('../services/api', () => ({ joinFlockByInviteToken: jest.fn() }));
jest.mock('../services/pushNavigation', () => ({ emitPushNavigation: jest.fn() }));

describe('inviteHandoff: carrying the token across the auth round trip', () => {
  // eslint-disable-next-line global-require
  const { joinFlockByInviteToken } = require('../services/api');
  // eslint-disable-next-line global-require
  const { emitPushNavigation } = require('../services/pushNavigation');
  // eslint-disable-next-line global-require
  const handoff = require('../services/inviteHandoff');

  const KEY = 'flock_pending_invite';

  beforeEach(() => {
    window.localStorage.clear();
    joinFlockByInviteToken.mockReset();
    emitPushNavigation.mockReset();
  });

  const fail = (status, data) => {
    const err = new Error('nope');
    err.status = status;
    if (data) err.data = data;
    return err;
  };

  test('a remembered invite comes back, and the page and the service agree on the key', () => {
    expect(handoff.rememberInvite(NEW_TOKEN, { flockName: 'Friday Night Out' })).toBe(true);
    expect(handoff.pendingInvite()).toEqual({ token: NEW_TOKEN, flockName: 'Friday Night Out' });

    // GuestInvite writes this entry itself rather than importing the service
    // (which would drag the whole REST client into the marketing chunk), so the
    // two spellings of the key have to be pinned together or the handoff
    // silently stops happening.
    expect(readSrc('GuestInvite.js')).toContain(`const HANDOFF_KEY = '${KEY}'`);
  });

  test('a token that was never a token is not stored', () => {
    expect(handoff.rememberInvite('short')).toBe(false);
    expect(handoff.rememberInvite('x'.repeat(65))).toBe(false);
    expect(handoff.rememberInvite(null)).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  test('an invite older than a day is forgotten rather than fired', () => {
    // A promise with no expiry is a surprise: nobody wants last month's link to
    // quietly pull them into a plan the first time they sign in.
    window.localStorage.setItem(KEY, JSON.stringify({
      token: NEW_TOKEN, at: Date.now() - 25 * 60 * 60 * 1000,
    }));
    expect(handoff.pendingInvite()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  test('a corrupt or clock-skewed entry fails toward forgetting', () => {
    for (const bad of ['{not json', JSON.stringify({ token: NEW_TOKEN }),
      JSON.stringify({ token: NEW_TOKEN, at: Date.now() + 60 * 60 * 1000 })]) {
      window.localStorage.setItem(KEY, bad);
      expect(handoff.pendingInvite()).toBeNull();
    }
  });

  test('redeeming answers the flock to open, and clears the stash', async () => {
    handoff.rememberInvite(NEW_TOKEN, { flockName: 'Friday Night Out' });
    joinFlockByInviteToken.mockResolvedValue({ flockId: 42, flockName: 'Friday Night Out', joined: true });

    const result = await handoff.redeemPendingInvite();
    expect(joinFlockByInviteToken).toHaveBeenCalledWith(NEW_TOKEN);
    expect(result).toEqual({ flockId: 42, flockName: 'Friday Night Out', joined: true });
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  test('someone who was already a member is still taken to the chat', async () => {
    handoff.rememberInvite(NEW_TOKEN);
    joinFlockByInviteToken.mockResolvedValue({ flockId: 42, flockName: 'Dinner', joined: false });
    const result = await handoff.redeemPendingInvite();
    expect(result.flockId).toBe(42);
    expect(result.joined).toBe(false);
  });

  test('nothing stashed costs nothing and asks nothing', async () => {
    expect(await handoff.redeemPendingInvite()).toBeNull();
    expect(joinFlockByInviteToken).not.toHaveBeenCalled();
  });

  test('a refusal that will never change clears the stash', async () => {
    for (const status of [400, 403, 404, 409, 429]) {
      handoff.rememberInvite(NEW_TOKEN);
      joinFlockByInviteToken.mockRejectedValue(fail(status));
      expect(await handoff.redeemPendingInvite()).toBeNull();
      expect(window.localStorage.getItem(KEY)).toBeNull();
    }
  });

  test('a refusal that resolves itself keeps the stash', async () => {
    // Unverified email is the one 403 that fixes itself: they click the link in
    // their mail and the next boot finishes the join. A dropped connection is
    // the same shape, for the same reason.
    handoff.rememberInvite(NEW_TOKEN);
    joinFlockByInviteToken.mockRejectedValue(fail(403, { emailVerificationRequired: true }));
    expect(await handoff.redeemPendingInvite()).toBeNull();
    expect(handoff.pendingInvite()).not.toBeNull();

    const netErr = new Error('offline');
    netErr.isNetworkError = true;
    joinFlockByInviteToken.mockRejectedValue(netErr);
    expect(await handoff.redeemPendingInvite()).toBeNull();
    expect(handoff.pendingInvite()).not.toBeNull();
  });

  test('a redeem never rejects, because it runs on the app boot path', async () => {
    handoff.rememberInvite(NEW_TOKEN);
    joinFlockByInviteToken.mockRejectedValue(new Error('something unexpected'));
    await expect(handoff.redeemPendingInvite()).resolves.toBeNull();
  });

  test('a 200 with no usable flock id opens nothing', async () => {
    handoff.rememberInvite(NEW_TOKEN);
    joinFlockByInviteToken.mockResolvedValue({ joined: true });
    expect(await handoff.redeemPendingInvite()).toBeNull();
    expect(handoff.openJoinedFlock(null)).toBe(false);
    expect(emitPushNavigation).not.toHaveBeenCalled();
  });

  test('opening the flock reuses the one navigation bus App.js already listens on', () => {
    expect(handoff.openJoinedFlock({ flockId: 42, joined: true })).toBe(true);
    expect(emitPushNavigation).toHaveBeenCalledWith({
      screen: 'flock', flockId: 42, type: 'invite_link',
    });
  });

  test('App.js joins BEFORE it loads flocks, and opens the chat only after', () => {
    // Ordering is the whole correctness of the handoff: joining after the list
    // has loaded leaves the new flock missing, and navigating before the list
    // lands drops the person in an empty room.
    const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
    const start = app.indexOf('redeemPendingInvite()');
    expect(start).toBeGreaterThan(-1);
    const block = app.slice(start, start + 9000);
    const load = block.indexOf('getFlocks()');
    const open = block.indexOf('openJoinedFlock(invite)');
    expect(load).toBeGreaterThan(0);
    expect(open).toBeGreaterThan(load);
    expect(block.indexOf('setFlocks(')).toBeLessThan(open);
  });
});
