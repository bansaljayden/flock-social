/**
 * THE INVITE SCREEN, REBUILT — /i/:token, 2026-08-14.
 *
 * the maintainer's report was three things at once: "when I send an invite they don't
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
    // Second argument, because every request this page makes now carries an
    // abort signal. See the request-clock tests below.
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(NEW_TOKEN),
      expect.objectContaining({ signal: expect.anything() }),
    );

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
    //
    // The pin used to require the two lines to be ADJACENT, which made it a
    // pin on the body of the function rather than on the rule the comment
    // above states. An analytics capture landed between them (the handoff out
    // of this page is the step that turns a stranger into an account, and it
    // has to be recorded before assign() tears the page down) and this went red
    // over a line that changes nothing about the race. What matters is the
    // ORDER and that the stash is unconditional, so that is what is asserted:
    // the stash first, the navigation last, and no branch anywhere in the four
    // lines between. Comments are stripped so a stray `// if (` in a note
    // cannot fail it either.
    const goJoinBody = (() => {
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n');
      const m = code.match(/const goJoin = \(where\) => \{([\s\S]*?)\n {2}\};/);
      // Trap: an unmatched anchor would leave every assertion below reading
      // undefined or the whole file, so the match is checked before it is used.
      expect(m).not.toBeNull();
      return m[1];
    })();
    expect(goJoinBody.length).toBeLessThan(1200);
    const stashAt = goJoinBody.indexOf('stashInvite(token, flockName, (fresh && fresh.guestToken) || (guest && guest.guestToken));');
    const assignAt = goJoinBody.indexOf('window.location.assign(where);');
    expect(stashAt).toBeGreaterThanOrEqual(0);
    expect(assignAt).toBeGreaterThan(stashAt);
    // UNCONDITIONALLY, which is the half an order check alone does not cover:
    // `if (token) stashInvite(...)` keeps the order and still loses the invite
    // on the case worth protecting. The WHOLE body is checked, not the gap
    // between the two calls, because a guard placed BEFORE the stash is
    // exactly as bad and sits outside any gap.
    expect(goJoinBody).not.toMatch(/\bif\b|\breturn\b|\bawait\b|\btry\b|\bcatch\b/);
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

  test('a full plan does not offer a join that the server will refuse', async () => {
    // POST /api/guest/:token/join answers a new account past
    // LINK_JOIN_MEMBER_CAP with a 429, and until the preview started saying so
    // this page happily sent a stranger through a whole signup that could not
    // end in this flock, then said nothing at all about why. A control whose
    // only job is to reject you is worse than no control (SLOP-AUDIT H5).
    const { container } = mount(okWith({ ...PLAN, full: true }));
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });

    expect(container.querySelector('.gi-join-btn')).toBeNull();
    expect(container.textContent).toMatch(/this plan is full/i);
    // Not a dead end: the guest answer below still works, and it is named as
    // the thing that does.
    expect(container.querySelector('#gi-name')).not.toBeNull();
    expect(screen.getByRole('button', { name: /i'm in/i })).toBeInTheDocument();
    // Somebody ALREADY on the plan tapping their own link is a 200 that opens
    // the chat, so that way in survives.
    expect(screen.getByRole('button', { name: /sign in and open it/i })).toBeInTheDocument();
  });

  test('an old server that does not send `full` is not read as a full plan', async () => {
    // The frontend deploys to Vercel and the backend to Railway, separately,
    // so there is always a window where one is newer. An absent key must read
    // as "not full", never as anything else. Same rule as hasRoster.
    const { container } = mount(okWith(PLAN));
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });
    expect(container.querySelector('.gi-join-btn')).not.toBeNull();
    expect(container.textContent).not.toMatch(/this plan is full/i);

    // And a truthy-but-not-true value is not enough either.
    const { container: c2 } = mount(okWith({ ...PLAN, full: 'yes' }));
    await waitFor(() => expect(c2.querySelector('.gi-join-btn')).not.toBeNull());
  });

  test('the join band names the email confirmation step instead of promising past it', async () => {
    // THE REPORTED FAILURE, on the copy side. A password signup writes
    // users.email_verified FALSE and the join route sits behind
    // requireVerified, so "making an account puts you in this group chat" was
    // not true of the default signup path at the moment it was read. SLOP-AUDIT
    // rule 5: never claim what the shipping build does not do.
    const { container } = mount(okWith(PLAN));
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });
    const note = container.querySelector('.gi-join-note');
    expect(note).not.toBeNull();
    expect(note.textContent).toMatch(/confirmation email/i);
  });

  test('a closed link says links expire, because that is the state most people hit', async () => {
    // migrations/028_invite_link_expiry.sql gave every link an expires_at, and
    // resolveLink answers an expired row exactly as it answers a revoked one.
    // Reporting only "switched off" told the most likely reader of this screen
    // that the host had shut them out on purpose.
    const { container } = mount(() => Promise.resolve({
      ok: false, status: 404, json: () => Promise.resolve({}),
    }));
    await screen.findByRole('heading', { level: 1, name: /this invite has closed/i });
    expect(container.textContent).toMatch(/stop working after/i);
    // And it says what to do next, naming who can do it.
    expect(container.textContent).toMatch(/ask whoever sent it to share the plan with you again/i);
    // Never a retry button on a link that will not start working again.
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
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

  // ── 4. the request clock ────────────────────────────────────────────────
  //
  // Every fetch on this page was bare, which on the network this page is most
  // often opened on meant no deadline at all. The two failures that bought are
  // the first two tests here, and neither of them showed the visitor anything:
  // the first was a skeleton that ran until the tab was closed, the second was
  // every control on the page frozen behind a button reading "Saving".
  //
  // The page keeps its own client rather than routing through services/api.js
  // (a JWT, a session-expiry bus and the PostHog funnel mean nothing to
  // somebody with no account, and it would drag the whole REST client into
  // this chunk), so the rails have to be pinned here rather than inherited.

  // A request that accepts the connection and then says nothing, which is the
  // shape of a venue wifi that has stopped forwarding. It settles only when
  // the page's own clock aborts it.
  const silence = () => (url, opts) => new Promise((_, reject) => {
    const signal = opts && opts.signal;
    if (!signal) return; // no clock: this promise never settles, which is the bug
    signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });

  const tick = async (ms) => {
    await act(async () => {
      jest.advanceTimersByTime(ms);
      await Promise.resolve();
    });
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  test('a first load that is answered with silence ends in a screen with a way out, not a skeleton forever', async () => {
    jest.useFakeTimers();
    const { container } = mount(silence());

    // Still the skeleton at fourteen seconds: a slow network is not a failure.
    await tick(14000);
    expect(container.querySelector('.gi-skel')).toBeTruthy();

    // The clock fires, and the read is retried ONCE, because the first request
    // a stranger's phone makes to Flock is the one most likely to land on a
    // cold container. Two full windows, then the page says so.
    await tick(2000);
    await tick(16000);

    await waitFor(() => expect(container.textContent).toMatch(/took too long/i));
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
    // Never blames the link, which is the one thing that is certainly fine.
    expect(container.textContent).not.toMatch(/isn't complete/i);
  });

  test('a stalled answer releases the page instead of freezing every control behind "Saving"', async () => {
    jest.useFakeTimers();
    const { container } = mount((url, opts) => (
      (opts && opts.method === 'POST')
        ? silence()(url, opts)
        : okWith(PLAN)()
    ));

    await waitFor(() => expect(container.textContent).toMatch(/friday night out/i));
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: 'Maya' } });
    fireEvent.click(screen.getByRole('button', { name: /i'm in/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /saving/i })).toBeTruthy());

    await tick(16000);

    // The button is a button again, and the failure is stated where the
    // control that produced it is, rather than being left as a stuck state.
    await waitFor(() => expect(screen.getByRole('button', { name: /i'm in/i })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /saving/i })).toBeNull();
    // Two live regions are always mounted (one per control group), so the
    // page is asked for all of them and the complaint is read off the pair.
    const alerts = screen.getAllByRole('alert').map((n) => n.textContent).join(' ');
    expect(alerts).toMatch(/took too long/i);
    // A WRITE is never re-sent. One preview, one RSVP, and nothing repeated.
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('a network that answers in Flock\'s place is named as the network, not as a broken invite', async () => {
    // A captive portal answers 200 with its own sign-in HTML for every URL.
    // Read as an empty payload this used to become "we couldn't load this
    // invite. The link is probably fine. Try it again", which loops forever.
    const { container } = mount(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    }));

    await waitFor(() => expect(container.textContent).toMatch(/answered instead of Flock/i));
    expect(container.textContent).toMatch(/sign-in page/i);
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  test('a gateway answering 502 with an HTML page is our fault, not the wifi\'s', async () => {
    // The same unreadable body, and the opposite cause. Railway's edge answers
    // a 502 with HTML, so a page that decided "not JSON, therefore captive
    // portal" would send a guest off to find a wifi sign-in screen that does
    // not exist. The status line is authoritative and is read first.
    const { container } = mount(() => Promise.resolve({
      ok: false,
      status: 502,
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    }));

    await waitFor(() => expect(container.textContent).toMatch(/couldn't load this invite/i));
    expect(container.textContent).not.toMatch(/answered instead of Flock/i);
    expect(container.textContent).not.toMatch(/sign-in page/i);
  });

  test('a plan called off while the page sits open closes the whole page, not one line beside a button', async () => {
    // The guest loaded a live plan, the host called it off, and the RSVP comes
    // back 409. Answering with one inline sentence would leave the roster in
    // the present tense and every other control still offering something the
    // server now refuses.
    const cancelled = {
      ...PLAN,
      flock: { ...PLAN.flock, status: 'cancelled' },
    };
    let previews = 0;
    const { container } = mount((url, opts) => {
      if (opts && opts.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: () => Promise.resolve({ error: 'This plan is no longer taking RSVPs' }),
        });
      }
      previews += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(previews === 1 ? PLAN : cancelled),
      });
    });

    await waitFor(() => expect(container.textContent).toMatch(/who is coming/i));
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: 'Maya' } });
    fireEvent.click(screen.getByRole('button', { name: /i'm in/i }));

    await waitFor(() => expect(container.textContent).toMatch(/was called off/i));
    // Past tense, and no control that cannot work.
    expect(container.textContent).toMatch(/who was coming/i);
    expect(screen.queryByRole('button', { name: /i'm in/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /can't make it/i })).toBeNull();
  });

  test('a refresh that left before the plan closed cannot reopen it when it lands', async () => {
    // The test above proves the 409 CLOSES the page. It closes it by taking the
    // current state, and every successful write starts one of those refreshes
    // too, so two are in flight together the moment a guest answers and then
    // taps a venue. The page's own clock allows a request up to thirty seconds
    // (fifteen, then the one retry), which is long enough for the second reply
    // to arrive first.
    //
    // Order, exactly as a phone on bar wifi produces it:
    //   answer the RSVP        -> refresh #1 leaves and stalls
    //   the host calls it off
    //   tap a venue            -> 409 -> refresh #2 returns `cancelled`, and
    //                             the page correctly goes to its closed shape
    //   refresh #1 lands       -> carrying the plan as it was BEFORE
    //
    // Whichever reply arrived last used to win. That put the notice, the past
    // tense, both RSVP buttons, the join band and the live vote rows back on a
    // plan the server had already started refusing, which is the state this
    // whole 409 path exists to prevent, reached the long way round.
    const cancelled = { ...PLAN, flock: { ...PLAN.flock, status: 'cancelled' } };
    let previews = 0;
    let landStaleRefresh;
    const { container } = mount((url, opts) => {
      if (opts && opts.method === 'POST') {
        return /\/vote$/.test(url)
          ? Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ error: 'This plan is no longer taking votes' }) })
          : Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ guestToken: 'g1' }) });
      }
      previews += 1;
      if (previews === 1) return okWith(PLAN)();
      // #2 is the post-RSVP refresh, held open until the assertion below wants it.
      if (previews === 2) {
        return new Promise((resolve) => {
          landStaleRefresh = () => resolve({ ok: true, status: 200, json: () => Promise.resolve(PLAN) });
        });
      }
      return okWith(cancelled)();
    });

    await screen.findByRole('heading', { level: 1, name: /friday night out/i });
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: 'Maya' } });
    fireEvent.click(screen.getByRole('button', { name: /i'm in/i }));
    await waitFor(() => expect(previews).toBe(2));

    const venue = await screen.findByRole('button', { name: /bookstore speakeasy/i });
    fireEvent.click(venue);
    await waitFor(() => expect(container.textContent).toMatch(/was called off/i));

    await act(async () => {
      landStaleRefresh();
      await Promise.resolve();
    });

    expect(container.textContent).toMatch(/was called off/i);
    expect(container.textContent).toMatch(/who was coming/i);
    expect(screen.queryByRole('button', { name: /i'm in/i })).toBeNull();
    expect(screen.queryAllByRole('button', { name: /join/i })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /bookstore speakeasy/i })).toBeNull();
  });

  test('a revoked link stays closed when the refresh that left before it lands', async () => {
    // The test above holds the LOAD against the LOAD. This one holds the WRITE
    // against the load, because counting only loads left the same undo open on
    // the other side and the page reopened there too.
    //
    // A vote that comes back 404 is the host revoking the link, and the page
    // closes itself on the spot: no load runs, so nothing takes a newer number
    // than the refresh already in the air. That refresh left when the RSVP
    // succeeded, before the link died, so it answers with the whole live plan,
    // and it was still the newest LOAD.
    //
    //   answer the RSVP        -> refresh #1 leaves and stalls
    //   the host revokes the link
    //   tap a venue            -> 404 -> "This invite has closed"
    //   refresh #1 lands       -> carrying the plan, live
    //
    // Driven against the page before the fix, that put the invite back over the
    // closed screen: the join band, both RSVP buttons and the vote buttons, all
    // working, on a link the server answers 404 to. Worse than the cancelled
    // case, because the 404 branch says nothing beside a control at all, so
    // there was not even a stale line left to contradict it.
    let previews = 0;
    let landStaleRefresh;
    const { container } = mount((url, opts) => {
      if (opts && opts.method === 'POST') {
        return /\/vote$/.test(url)
          ? Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'This invite link no longer exists' }) })
          : Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ guestToken: 'g1' }) });
      }
      previews += 1;
      if (previews === 1) return okWith(PLAN)();
      // The post-RSVP refresh, held open until the assertion below wants it.
      return new Promise((resolve) => {
        landStaleRefresh = () => resolve({ ok: true, status: 200, json: () => Promise.resolve(PLAN) });
      });
    });

    await screen.findByRole('heading', { level: 1, name: /friday night out/i });
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: 'Maya' } });
    fireEvent.click(screen.getByRole('button', { name: /i'm in/i }));
    await waitFor(() => expect(previews).toBe(2));

    fireEvent.click(await screen.findByRole('button', { name: /bookstore speakeasy/i }));
    await waitFor(() => expect(container.textContent).toMatch(/this invite has closed/i));

    await act(async () => {
      landStaleRefresh();
      await Promise.resolve();
    });

    expect(container.textContent).toMatch(/this invite has closed/i);
    expect(screen.queryByRole('button', { name: /i'm in/i })).toBeNull();
    expect(screen.queryAllByRole('button', { name: /join/i })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /bookstore speakeasy/i })).toBeNull();
  });

  test('a vote the server counted is not rolled back by the refresh that left before it', async () => {
    // The two tests above hold PHASE against a stale load. This one holds the
    // page's DATA against it, and it is the same defect a third time: the
    // generation was taken by the things that change `phase`, and a vote the
    // server counted changes no phase at all. It replaces the tally in place
    // with the rows the reply carries, which put that commit outside the rule.
    //
    //   answer the RSVP        -> refresh #1 leaves and stalls
    //   tap a venue            -> 200, and the reply carries the new tally
    //   refresh #1 lands       -> carrying the tally as it was BEFORE the vote
    //
    // Nothing here is a failure state, so nothing here is loud. Driven against
    // the page before the fix, the count under the venue the guest had just
    // picked went back down by one, under a row still reading "Your vote", and
    // stayed there: nothing followed a vote, so the page sat on a number the
    // server had already contradicted until the tab was reloaded.
    const TWO = { ...PLAN, venues: [{ venue_name: 'The Bookstore Speakeasy', votes: 2 }] };
    let previews = 0;
    let landStaleRefresh;
    const { container } = mount((url, opts) => {
      if (opts && opts.method === 'POST') {
        return /\/vote$/.test(url)
          ? Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ venues: [{ venue_name: 'The Bookstore Speakeasy', votes: 3 }] }),
          })
          : Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ guestToken: 'g1' }) });
      }
      previews += 1;
      if (previews === 1) return okWith(TWO)();
      // The post-RSVP refresh, held open until the assertion below wants it.
      if (previews === 2) {
        return new Promise((resolve) => {
          landStaleRefresh = () => resolve({ ok: true, status: 200, json: () => Promise.resolve(TWO) });
        });
      }
      // The refresh the vote itself starts, on the same bad network: it never
      // comes back. So the only thing holding the counted tally on screen is
      // the vote's own reply, which is what the stale refresh has to lose to.
      return new Promise(() => {});
    });

    await screen.findByRole('heading', { level: 1, name: /friday night out/i });
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: 'Maya' } });
    fireEvent.click(screen.getByRole('button', { name: /i'm in/i }));
    await waitFor(() => expect(previews).toBe(2));

    fireEvent.click(await screen.findByRole('button', { name: /bookstore speakeasy/i }));
    await waitFor(() => expect(container.textContent).toMatch(/3 votes/));

    await act(async () => {
      landStaleRefresh();
      await Promise.resolve();
    });

    expect(container.textContent).toMatch(/3 votes/);
    expect(container.textContent).not.toMatch(/2 votes/);
  });

  test('every request the page makes carries a deadline', () => {
    const src = readSrc('GuestInvite.js');
    // No bare fetch survives: every endpoint goes through the one helper that
    // owns the AbortController.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const fetches = [...code.matchAll(/[^a-zA-Z]fetch\(/g)].length;
    expect(fetches).toBe(1);
    expect(src).toMatch(/const REQUEST_TIMEOUT_MS = 15000;/);
    expect(src).toMatch(/setTimeout\(\(\) => controller\.abort\(\), REQUEST_TIMEOUT_MS\)/);
    // The clock covers the body read, not just the headers: the timer is
    // cleared in a finally around BOTH, never after the fetch resolves.
    expect(src).toMatch(/body = await res\.json\(\);[\s\S]{0,900}?finally \{\s*clearTimeout\(timer\);/);
    // And the page still ships its own client rather than the app's.
    expect(src).not.toMatch(/from '\.\.\/services\/api'/);
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
    expect(handoff.pendingInvite()).toEqual({ token: NEW_TOKEN, flockName: 'Friday Night Out', guestToken: null });

    // The guest identity rides only when it is UUID-shaped. The join uses it
    // to retire the by-name RSVP row the membership subsumes (the
    // convert-and-count-twice hole), and garbage must read as absent, never as
    // a value the server is asked about.
    const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    expect(handoff.rememberInvite(NEW_TOKEN, { flockName: 'Friday Night Out', guestToken: uuid })).toBe(true);
    expect(handoff.pendingInvite().guestToken).toBe(uuid);
    expect(handoff.rememberInvite(NEW_TOKEN, { flockName: 'Friday Night Out', guestToken: 'not-a-uuid' })).toBe(true);
    expect(handoff.pendingInvite().guestToken).toBeNull();

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
    // No guest identity was stashed, so the second argument reads as absent.
    expect(joinFlockByInviteToken).toHaveBeenCalledWith(NEW_TOKEN, undefined);
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
    await handoff.redeemPendingInvite();
    expect(handoff.pendingInvite()).not.toBeNull();

    const netErr = new Error('offline');
    netErr.isNetworkError = true;
    joinFlockByInviteToken.mockRejectedValue(netErr);
    expect(await handoff.redeemPendingInvite()).toBeNull();
    expect(handoff.pendingInvite()).not.toBeNull();
  });

  test('an unverified account is REPORTED, not swallowed into the same null as nothing-to-do', async () => {
    // THE REPORTED FAILURE. A password signup writes users.email_verified
    // FALSE, POST /api/guest/:token/join is behind requireVerified, and this
    // used to answer that 403 with the same bare null it answers an empty
    // stash with. The app therefore could not tell "we tried and they need to
    // confirm their email" from "there is nothing here", so somebody who made
    // an account specifically to get into a plan landed on an empty home
    // screen with nothing said. The refusal is correct; the silence was not.
    handoff.rememberInvite(NEW_TOKEN, { flockName: 'Friday Night Out' });
    joinFlockByInviteToken.mockRejectedValue(fail(403, { emailVerificationRequired: true }));

    const result = await handoff.redeemPendingInvite();
    expect(result).toEqual({ needsEmailVerification: true, flockName: 'Friday Night Out' });
    // Still kept, so the next boot after they click the link finishes the join.
    expect(handoff.pendingInvite()).not.toBeNull();

    // A plain 403 with no flag is a refusal that will never change, and it
    // stays silent and still clears.
    handoff.rememberInvite(NEW_TOKEN);
    joinFlockByInviteToken.mockRejectedValue(fail(403));
    expect(await handoff.redeemPendingInvite()).toBeNull();
    expect(handoff.pendingInvite()).toBeNull();
  });

  test('the verification result carries no flockId, so a caller that has not been taught it navigates nowhere', async () => {
    // The change has to be inert for App.js until App.js opts in: the old code
    // returned null here and the caller does `if (invite) openJoinedFlock(invite)`.
    handoff.rememberInvite(NEW_TOKEN);
    joinFlockByInviteToken.mockRejectedValue(fail(403, { emailVerificationRequired: true }));
    const result = await handoff.redeemPendingInvite();

    expect(result.flockId).toBeUndefined();
    expect(handoff.openJoinedFlock(result)).toBe(false);
    expect(emitPushNavigation).not.toHaveBeenCalled();
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

});

// ───────────────────────────────────────────────────────────────────────────
// The share preview: what the link looks like when it lands in a group chat.
//
// api/invite-preview.js answers the preview bots (iMessage, WhatsApp, Slack,
// Discord and the rest) through a user-agent rewrite in vercel.json, so the
// link that spreads the product can say who sent it and what the plan is
// instead of previewing as the marketing page. A bare-looking preview is a
// link nobody taps, so this is a growth surface and not a nicety.
// ───────────────────────────────────────────────────────────────────────────
describe('invite-preview: the card the link draws in a group chat', () => {
  // eslint-disable-next-line global-require
  const preview = require('../../api/invite-preview');

  const serverSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'guest.js'),
    'utf8'
  );

  test('a token of the length the server actually mints reaches the backend', () => {
    // THIS WAS A LIVE BUG, and it is the same one GuestInvite.js already had
    // and fixed. The regex here read {8,20} while newLinkToken mints
    // LINK_TOKEN_LENGTH = 24, so EVERY invite link created since that widening
    // failed the shape test, took the generic-tags branch, and previewed in
    // iMessage as "Flock | Plans that actually happen" with no host, no plan
    // and no time. Only the legacy 12-character tokens still previewed.
    expect(preview.TOKEN_RE.test(NEW_TOKEN)).toBe(true);
    expect(preview.readToken({ query: { token: NEW_TOKEN } })).toBe(NEW_TOKEN);
  });

  test('the accepted range is the range the server enforces, read out of the server', () => {
    // A comment claiming the bound is what let the last one rot. Derive it.
    const min = Number(/const LINK_TOKEN_PARAM_MIN = (\d+);/.exec(serverSrc)[1]);
    const max = Number(/const LINK_TOKEN_PARAM_MAX = (\d+);/.exec(serverSrc)[1]);
    const mint = Number(/const LINK_TOKEN_LENGTH = (\d+);/.exec(serverSrc)[1]);

    expect(preview.TOKEN_RE.test('a'.repeat(min))).toBe(true);
    expect(preview.TOKEN_RE.test('a'.repeat(max))).toBe(true);
    expect(preview.TOKEN_RE.test('a'.repeat(mint))).toBe(true);
    // And still bounded on both sides: this value is concatenated into og:url
    // and into an href.
    expect(preview.TOKEN_RE.test('a'.repeat(min - 1))).toBe(false);
    expect(preview.TOKEN_RE.test('a'.repeat(max + 1))).toBe(false);
    expect(preview.TOKEN_RE.test('has a space')).toBe(false);
    expect(preview.TOKEN_RE.test('../../etc')).toBe(false);
  });

  test('every character the generator can emit passes the shape test', () => {
    const alphabet = /const LINK_TOKEN_ALPHABET = '([^']+)'/.exec(serverSrc)[1];
    for (const ch of alphabet) {
      expect(preview.TOKEN_RE.test(ch.repeat(24))).toBe(true);
    }
  });

  test('a real plan previews with the host, the plan and the time, not the marketing tags', () => {
    const copy = preview.describe({
      flock: { name: 'Friday Night Out', when: null, chosenVenue: 'Good Dog Bar', status: 'planning' },
      host: 'Maya',
      going: 3,
    });
    expect(copy.title).toBe('Maya invited you to Friday Night Out');
    expect(copy.description).toMatch(/Good Dog Bar/);
    expect(copy.description).toMatch(/3 going/);
    expect(copy.title).not.toMatch(/Plans that actually happen/);
  });

  test('a cancelled plan is not previewed as an invitation', () => {
    const copy = preview.describe({
      flock: { name: 'Friday Night Out', when: null, chosenVenue: null, status: 'cancelled' },
      host: 'Maya',
      going: 3,
    });
    expect(copy.title).toMatch(/called off/i);
    expect(copy.title).not.toMatch(/invited you/i);
  });

  test('no em dash reaches a preview card', () => {
    // SLOP-AUDIT A2 / H18, on the one surface where the copy is read by people
    // who have never heard of the product.
    const html = preview.renderPage({
      title: 'Maya invited you to Friday Night Out',
      description: 'Fri, Jan 9 at 9:00 PM EST',
      token: NEW_TOKEN,
    });
    expect(html).not.toContain(String.fromCharCode(0x2014));
    expect(html).toContain('/i/' + NEW_TOKEN + '?open=1');
  });
});

describe('inviteHandoff: App.js wiring', () => {
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


describe('a regenerated link does not strand a guest who already answered', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'website', 'GuestInvite.js'), 'utf8');

  it('finds the identity this device holds for the name under an older link and resends it once', () => {
    // Identity is stored per link token; the server accepts a guest token by
    // flock. On the name-taken refusal (code NAME_TAKEN) the page looks for
    // the same name under any flock_guest_* key and retries with that token.
    expect(src).toMatch(/const carriedIdentityFor = \(name, exceptKey\) => \{/);
    expect(src).toMatch(/key\.startsWith\('flock_guest_'\)/);
    expect(src).toMatch(/body\.code === 'NAME_TAKEN' && !carried/);
    expect(src).toMatch(/return submitRsvp\(status, remembered\);/);
    expect(src).toMatch(/guestToken: carried \|\| \(guest && guest\.guestToken\)/);
  });

  it('compares names the way the server does', () => {
    expect(src).toMatch(/const sameGuestName = \(a, b\) => String\(a \|\| ''\)\.trim\(\)\.toLowerCase\(\)\.replace\(\/\\s\+\/g, ' '\)/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The link does what a member can do: the anonymous budget and the night-of
// "still in?", added 2026-09-16 because production data said no flock had ever
// had a second member. Every element here has to degrade to nothing on an old
// server, on a plan that is not asking, and on a plan that is over, and
// nothing here may put a second filled control on the page.
// ───────────────────────────────────────────────────────────────────────────
describe('GuestInvite: the budget and the still-in question, from the link', () => {
  // eslint-disable-next-line global-require
  const GuestInvite = require('../website/GuestInvite').default;

  const KEY = `flock_guest_${NEW_TOKEN}`;
  const IDENTITY = { guestToken: 'g-1', name: 'Sam', status: 'in' };

  // Two hours out, and the label is computed the way the page computes it,
  // so the assertion holds in whatever zone the test machine is in.
  const DEADLINE = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const deadlineLabel = new Date(DEADLINE).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  const BUDGET = { enabled: true, context: 'dinner', locked: false, submissionCount: 2, totalMembers: 6, isReady: false };
  const WINDOW = { open: true, deadline: DEADLINE, count: 2, total: 5 };
  // A server that has POST /:token/me sends both keys on every preview, null
  // when the plan is not asking. Their presence is what tells the page it may
  // ask; PLAN, which has neither, is an old server.
  const ASKING = { ...PLAN, budget: BUDGET, reconfirm: WINDOW };
  // What /me says about a guest who is in and has answered nothing yet.
  const ME = (over = {}) => ({
    name: 'Sam',
    status: 'in',
    reconfirmed: false,
    reconfirm: WINDOW,
    budget: { ...BUDGET, ceiling: null, userSubmitted: false, userAmount: null, userSkipped: false },
    ...over,
  });

  const reply = (status, body) => Promise.resolve({
    ok: status < 400, status, json: () => Promise.resolve(body),
  });

  // Routes each request by the path after the token, and records every POST
  // body so a test can read what the page actually sent.
  const mount = (routes) => {
    window.history.pushState({}, '', `/i/${NEW_TOKEN}`);
    const sent = [];
    global.fetch = jest.fn((url, opts) => {
      const route = String(url).replace(/^.*\/api\/guest\/[^/?]+/, '');
      if (opts && opts.method === 'POST') sent.push({ path: route, body: JSON.parse(opts.body) });
      const handler = routes[route];
      return handler ? handler() : reply(404, {});
    });
    const view = render(React.createElement(GuestInvite));
    return { ...view, sent };
  };

  const stored = () => JSON.parse(window.localStorage.getItem(KEY));
  const dollars = (text) => text.match(/\$[\d,]+(?:\.\d+)?/g) || [];

  beforeEach(() => { window.localStorage.clear(); });
  afterEach(() => { window.history.pushState({}, '', '/'); });

  // ── /me on load ─────────────────────────────────────────────────────────

  test('on load, the page asks /me for the identity it holds, and the server\'s word beats the store', async () => {
    // The store remembers $20 from an earlier visit; the server's row says
    // $40 (answered from another device, say), and the row is the server's.
    window.localStorage.setItem(KEY, JSON.stringify({ ...IDENTITY, budget: { amount: 20, skipped: false } }));
    const { container, sent } = mount({
      '': () => reply(200, { ...PLAN, budget: BUDGET, reconfirm: null }),
      '/me': () => reply(200, ME({
        reconfirm: null,
        budget: {
          ...BUDGET, locked: true, submissionCount: 6, totalMembers: 6, isReady: true,
          ceiling: 30, userSubmitted: true, userAmount: 40, userSkipped: false,
        },
      })),
    });
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });
    await waitFor(() => expect(container.textContent).toMatch(/You said \$40\./));
    expect(container.textContent).not.toMatch(/\$20/);
    expect(stored().budget).toEqual({ amount: 40, skipped: false });
    // The group's band, in the app's words, and only because /me sent it.
    expect(container.textContent).toMatch(/Group budget: up to \$30 per person\./);
    expect(container.textContent).toMatch(/6 of 6 answered\. This number is set and does not change\./);
    // Locked: their answer stands, with no way to change it offered.
    expect(screen.queryByRole('button', { name: /^change$/i })).toBeNull();
    // A bearer token travels in a POST body and never in a URL.
    expect(sent).toEqual([{ path: '/me', body: { guestToken: 'g-1' } }]);
    for (const [url] of global.fetch.mock.calls) expect(url).not.toMatch(/\?/);
    // The GET went first, and /me was asked once, not once per render.
    expect(global.fetch.mock.calls[0][1].method).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('a /me that refuses the identity drops it, says why, and does not steal focus on page open', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(IDENTITY));
    const { container } = mount({
      '': () => reply(200, ASKING),
      '/me': () => reply(403, { error: 'RSVP first' }),
    });
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });
    // The name field is back and the dead identity is gone from the store.
    const input = await screen.findByLabelText(/your name/i);
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(container.querySelector('#gi-problem-rsvp').textContent).toMatch(/not on this plan anymore/i);
    // Unlike the 403 on a vote, this runs at page open, so nobody's place on
    // the page is taken from them.
    expect(document.activeElement).not.toBe(input);
    // With no identity, both questions say to answer first and offer nothing.
    expect(screen.queryByRole('button', { name: /still in/i })).toBeNull();
    expect(container.querySelector('#gi-budget')).toBeNull();
    expect(container.textContent).toMatch(/Say I'm in below first/);
    expect(container.textContent).toMatch(/Answer above first\./);
  });

  test('a server that cannot answer /me leaves the page working on what the preview said', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(IDENTITY));
    const { container } = mount({
      '': () => reply(200, ASKING),
      '/me': () => reply(500, { error: 'Server error' }),
    });
    await waitFor(() => expect(container.textContent).toMatch(/2 of 6 answered/));
    await screen.findByRole('button', { name: /^i'm still in$/i });
    expect(container.querySelector('#gi-budget')).not.toBeNull();
    expect(stored().guestToken).toBe('g-1');
  });

  test('an old server, one whose preview has neither key, is never asked', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(IDENTITY));
    const { container, sent } = mount({ '': () => reply(200, PLAN) });
    await screen.findByRole('button', { name: /bookstore speakeasy/i });
    expect(sent).toEqual([]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // And nothing new is drawn.
    expect(container.querySelector('#gi-budget-h')).toBeNull();
    expect(container.querySelector('#gi-still-h')).toBeNull();
    expect(container.querySelector('.gi-who-still')).toBeNull();
  });

  // ── the budget ──────────────────────────────────────────────────────────

  test('the budget section is drawn when the plan is matching budgets, in the app\'s own words', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(IDENTITY));
    const { container } = mount({
      // A preview padded with a ceiling it must never carry, to show that the
      // page does not read one off the public read whatever it holds.
      '': () => reply(200, { ...ASKING, budget: { ...BUDGET, ceiling: 99 } }),
      '/me': () => reply(200, ME()),
    });
    await screen.findByRole('heading', { level: 2, name: /what's your budget tonight\?/i });
    expect(container.textContent).toMatch(/For dinner\./);
    expect(container.textContent).toMatch(/2 of 6 answered\./);
    expect(container.textContent).toMatch(/It takes three amounts before Flock can show one/);
    expect(container.textContent).toMatch(/This is anonymous\. No one sees your answer\./);
    // A labelled decimal field with the server's own length bound.
    const input = container.querySelector('#gi-budget');
    expect(input).not.toBeNull();
    expect(input.getAttribute('inputmode')).toBe('decimal');
    expect(input.getAttribute('maxlength')).toBe('7');
    expect(container.querySelector('label[for="gi-budget"]').textContent).toBe('Amount');
    expect(input.getAttribute('aria-describedby')).toBe('gi-problem-budget');
    expect(screen.getByRole('button', { name: /^that works$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^skip$/i })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Group budget/);
    expect(container.textContent).not.toMatch(/\$99/);
  });

  test('the budget section is absent without a block, absent on a closed plan, and offers a stranger no control', async () => {
    const { container: none } = mount({ '': () => reply(200, { ...PLAN, budget: null, reconfirm: null }) });
    await waitFor(() => expect(none.textContent).toMatch(/friday night out/i));
    expect(none.querySelector('#gi-budget-h')).toBeNull();
    expect(none.querySelector('#gi-still-h')).toBeNull();

    const { container: over } = mount({
      '': () => reply(200, { ...ASKING, flock: { ...PLAN.flock, status: 'cancelled' } }),
    });
    await waitFor(() => expect(over.textContent).toMatch(/called off/i));
    expect(over.querySelector('#gi-budget-h')).toBeNull();
    expect(over.querySelector('#gi-still-h')).toBeNull();

    const { container: fresh } = mount({ '': () => reply(200, ASKING) });
    await waitFor(() => expect(fresh.querySelector('#gi-budget-h')).not.toBeNull());
    expect(fresh.textContent).toMatch(/Answer above first\. The budget only counts people who are going\./);
    expect(fresh.querySelector('#gi-budget')).toBeNull();
    // The count is public and is still said.
    expect(fresh.textContent).toMatch(/2 of 6 answered\./);
  });

  test('answering the budget is stored beside the vote, and the only amount ever drawn is the guest\'s own', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(IDENTITY));
    let count = 2;
    const { container, sent } = mount({
      '': () => reply(200, { ...ASKING, budget: { ...BUDGET, submissionCount: count } }),
      '/me': () => reply(200, ME()),
      '/budget': () => {
        count = 3;
        // Padded with fields the server never sends, so the page can be shown
        // to draw none of them even if a reply ever carried them.
        return reply(200, {
          submitted: true, ceiling: null, submissionCount: 3, totalMembers: 6, isReady: false,
          skipCount: 0, budgetLocked: false, userSubmitted: true, amounts: [12, 45], lowest: 12,
        });
      },
    });
    const input = await screen.findByLabelText(/^amount$/i);
    fireEvent.change(input, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /^that works$/i }));

    await waitFor(() => expect(container.textContent).toMatch(/You said \$30\./));
    expect(sent.find((s) => s.path === '/budget').body).toEqual({ guestToken: 'g-1', amount: 30 });
    expect(stored().guestToken).toBe('g-1');
    expect(stored().budget).toEqual({ amount: 30, skipped: false });
    await waitFor(() => expect(container.textContent).toMatch(/3 of 6 answered\./));
    // Their own number, and nothing else on the page with a dollar sign.
    expect(dollars(container.textContent)).toEqual(['$30']);
    // The field is gone until they ask for it back, and it comes back filled.
    expect(container.querySelector('#gi-budget')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^change$/i }));
    expect((await screen.findByLabelText(/^amount$/i)).value).toBe('30');

    // A skip is the shape the app sends, and is remembered the same way.
    fireEvent.click(screen.getByRole('button', { name: /^skip$/i }));
    await waitFor(() => expect(container.textContent).toMatch(/You skipped\./));
    expect(sent.filter((s) => s.path === '/budget')[1].body).toEqual({ guestToken: 'g-1', amount: 0, skipped: true });
    expect(stored().budget).toEqual({ amount: null, skipped: true });
    expect(screen.getByRole('button', { name: /^set an amount$/i })).toBeInTheDocument();
  });

  test('a blank or out-of-range amount is refused on the page, marked on the field, with no request', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(IDENTITY));
    const { container, sent } = mount({ '': () => reply(200, ASKING), '/me': () => reply(200, ME()) });
    const input = await screen.findByLabelText(/^amount$/i);
    fireEvent.click(screen.getByRole('button', { name: /^that works$/i }));
    expect(container.querySelector('#gi-problem-budget').textContent).toMatch(/put an amount in first/i);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '20000' } });
    fireEvent.click(screen.getByRole('button', { name: /^that works$/i }));
    expect(container.querySelector('#gi-problem-budget').textContent).toMatch(/between \$0\.01 and \$10,000/);
    expect(sent.filter((s) => s.path === '/budget')).toEqual([]);
  });

  test('a budget refused as NOT_IN says to tap I\'m in first and takes the server\'s word about the answer', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(IDENTITY));
    const { container } = mount({
      '': () => reply(200, ASKING),
      '/me': () => reply(200, ME()),
      '/budget': () => reply(409, { code: 'NOT_IN', error: "Say you're in first. The budget only counts people who are going." }),
    });
    const input = await screen.findByLabelText(/^amount$/i);
    fireEvent.change(input, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /^that works$/i }));
    await waitFor(() => expect(container.querySelector('#gi-problem-budget').textContent).toMatch(/tap i'm in first/i));
    // The controls that could only 409 again are gone, and the store agrees.
    expect(container.querySelector('#gi-budget')).toBeNull();
    expect(stored().status).toBe('out');
    expect(stored().budget).toBeUndefined();
  });

  test('a budget refused as BUDGET_LOCKED says the budget is already set, and a 429 says the server\'s sentence', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(IDENTITY));
    let answers = 0;
    const { container } = mount({
      '': () => reply(200, ASKING),
      '/me': () => reply(200, ME()),
      '/budget': () => {
        answers += 1;
        return answers === 1
          ? reply(429, { error: 'You have changed this a lot in the last hour. You can change it again in 40 minutes.' })
          : reply(409, { code: 'BUDGET_LOCKED', error: 'The group budget is already set' });
      },
    });
    const input = await screen.findByLabelText(/^amount$/i);
    fireEvent.change(input, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /^that works$/i }));
    await waitFor(() => expect(container.querySelector('#gi-problem-budget').textContent)
      .toBe('You have changed this a lot in the last hour. You can change it again in 40 minutes.'));
    fireEvent.click(screen.getByRole('button', { name: /^that works$/i }));
    await waitFor(() => expect(container.querySelector('#gi-problem-budget').textContent)
      .toMatch(/already set/i));
    expect(stored().budget).toBeUndefined();
  });

  // ── still in? ───────────────────────────────────────────────────────────

  test('the still-in question is drawn while the window is open, above the RSVP, and one tap answers it', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(IDENTITY));
    let said = 2;
    const { container, sent } = mount({
      '': () => reply(200, { ...ASKING, reconfirm: { ...WINDOW, count: said } }),
      '/me': () => reply(200, ME({ reconfirm: { ...WINDOW, count: said } })),
      '/reconfirm': () => {
        said = 3;
        return reply(200, { reconfirmed: true, count: 3, total: 5, deadline: DEADLINE });
      },
    });
    await screen.findByRole('heading', { level: 2, name: /^still in\?$/i });
    expect(container.textContent).toContain(`2 of 5 have said so. Answer by ${deadlineLabel}.`);
    // On the night it is the question, so it sits above "Or just answer";
    // the budget stays below it.
    const order = Array.from(container.querySelectorAll('h2')).map((h) => h.id);
    expect(order.indexOf('gi-still-h')).toBeGreaterThan(order.indexOf('gi-join-h'));
    expect(order.indexOf('gi-still-h')).toBeLessThan(order.indexOf('gi-rsvp-h'));
    expect(order.indexOf('gi-rsvp-h')).toBeLessThan(order.indexOf('gi-budget-h'));

    fireEvent.click(screen.getByRole('button', { name: /^i'm still in$/i }));
    await waitFor(() => expect(container.textContent).toMatch(/You're in\. 3 of 5 still in\./));
    expect(sent.find((s) => s.path === '/reconfirm').body).toEqual({ guestToken: 'g-1' });
    expect(stored().reconfirmed).toBe(true);
    expect(screen.queryByRole('button', { name: /^i'm still in$/i })).toBeNull();
    // Announced, and the announcement names who can see it.
    expect(screen.getAllByRole('status').map((n) => n.textContent).join(' ')).toMatch(/Counted\. Maya can see you're still in\./);
  });

  test('the still-in question is absent outside the window, and never offers a tap the server would refuse', async () => {
    // Not asking: nothing drawn, even for a guest who is in.
    window.localStorage.setItem(KEY, JSON.stringify(IDENTITY));
    const { container: quiet } = mount({
      '': () => reply(200, { ...ASKING, reconfirm: null }),
      '/me': () => reply(200, ME({ reconfirm: null })),
    });
    await waitFor(() => expect(quiet.querySelector('#gi-budget-h')).not.toBeNull());
    expect(quiet.querySelector('#gi-still-h')).toBeNull();

    // A stranger: the question and the count, and a line to answer first.
    window.localStorage.clear();
    const { container: fresh } = mount({ '': () => reply(200, ASKING) });
    await waitFor(() => expect(fresh.querySelector('#gi-still-h')).not.toBeNull());
    expect(fresh.textContent).toMatch(/2 of 5 have said so\./);
    expect(fresh.textContent).toMatch(/Say I'm in below first/);
    expect(Array.from(fresh.querySelectorAll('button')).some((b) => /still in/i.test(b.textContent))).toBe(false);

    // Out: said so, no button.
    window.localStorage.setItem(KEY, JSON.stringify({ ...IDENTITY, status: 'out' }));
    const { container: out } = mount({
      '': () => reply(200, ASKING),
      '/me': () => reply(200, ME({ status: 'out' })),
    });
    await waitFor(() => expect(out.querySelector('#gi-still-h')).not.toBeNull());
    expect(out.textContent).toMatch(/You're down as out\./);
    expect(Array.from(out.querySelectorAll('button')).some((b) => /still in/i.test(b.textContent))).toBe(false);
  });

  test('a window that closes under the tap reloads the plan and says so, rather than leaving a dead button', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(IDENTITY));
    let open = true;
    const { container } = mount({
      '': () => reply(200, { ...ASKING, reconfirm: open ? WINDOW : null }),
      '/me': () => reply(200, ME()),
      '/reconfirm': () => {
        open = false;
        return reply(409, { code: 'NOT_OPEN', error: 'Flock asks this in the last few hours before a plan. Nothing to answer yet.' });
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: /^i'm still in$/i }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^i'm still in$/i })).toBeNull());
    // The line outlives the block the reload took away.
    await waitFor(() => expect(container.textContent).not.toMatch(/have said so/));
    expect(container.querySelector('#gi-problem-reconfirm').textContent).toMatch(/that question has closed/i);
    expect(stored().reconfirmed).toBeFalsy();
  });

  // ── the rules the rest of the page is held to ───────────────────────────

  test('with both questions on the page, the join band is still the only filled control', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(IDENTITY));
    const { container } = mount({ '': () => reply(200, ASKING), '/me': () => reply(200, ME()) });
    const still = await screen.findByRole('button', { name: /^i'm still in$/i });
    const works = await screen.findByRole('button', { name: /^that works$/i });
    expect(still.className).toBe('gi-btn');
    expect(works.className).toBe('gi-btn');
    expect(screen.getByRole('button', { name: /^skip$/i }).className).toBe('gi-btn-quiet');
    for (const btn of container.querySelectorAll('.gi-row .gi-btn')) {
      expect(btn.className).not.toMatch(/gi-btn-primary|gi-btn-strong/);
    }
    expect(container.querySelectorAll('.gi-join-btn')).toHaveLength(1);
    expect(container.querySelectorAll('.gi-btn-strong')).toHaveLength(0);
  });

  test('a roster mark for "still in" is a glyph and a word, and only while the window is open', async () => {
    const people = [
      { name: 'Maya', rsvp: 'in', kind: 'member', reconfirmed: true },
      { name: 'Jordan', rsvp: 'in', kind: 'member', reconfirmed: false },
      // An old server's row: no key at all, which must read as "has not said".
      { name: 'Sam', rsvp: 'in', kind: 'guest' },
      { name: 'Noor', rsvp: 'out', kind: 'member', reconfirmed: false },
    ];
    const { container } = mount({ '': () => reply(200, { ...ASKING, people }) });
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });
    const rows = Array.from(container.querySelectorAll('.gi-who-row'));
    const marks = rows.map((r) => r.querySelector('.gi-who-still'));
    expect(marks.map(Boolean)).toEqual([true, false, false, false]);
    // Glyph AND the words, from the icon system, at the 12px floor: never a
    // tint on its own, the same rule the RSVP answer is held to.
    expect(marks[0].textContent.trim()).toBe('still in');
    const svg = marks[0].querySelector('svg');
    expect(svg).not.toBeNull();
    expect(Number(svg.getAttribute('width'))).toBeGreaterThanOrEqual(12);
    // The RSVP answer is still the row's spoken state.
    expect(rows[0].querySelector('.gi-sr').textContent).toBe('Going');

    // Outside the window the same flag draws nothing.
    const { container: quiet } = mount({ '': () => reply(200, { ...ASKING, people, reconfirm: null }) });
    await waitFor(() => expect(quiet.querySelectorAll('.gi-who-row')).toHaveLength(4));
    expect(quiet.querySelector('.gi-who-still')).toBeNull();
  });
});
