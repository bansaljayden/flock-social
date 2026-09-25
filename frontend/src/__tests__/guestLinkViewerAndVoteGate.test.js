/**
 * THE INVITE PAGE, TWO THINGS IT TOLD THE SERVER WRONG.
 *
 * 1. WHO IS READING. GET /api/guest/:token narrows the page for a signed-in
 *    viewer (nobody they have a block with on the roster, no host name when
 *    the block is with the host; backend/routes/guest.js viewerFrom). The page
 *    talks to the guest routes with bare fetch and never sent the session, so
 *    that filter applied to nobody. It now sends the app's own session on the
 *    preview GET, the way services/api.js attaches it, and on nothing else. No
 *    session is the stranger's page, and a session the server will not take
 *    is asked again without it.
 *
 * 2. WHO MAY VOTE. A guest who said out could still vote, and the vote was
 *    counted on both tallies. The server now counts a guest vote only while the
 *    answer is in and refuses one from a guest who is out (NOT_IN). The page
 *    stops offering the rows as buttons to somebody who is out, says why, and
 *    takes the server's word when an answer changed on another device.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, waitFor } = require('@testing-library/react');

const TOKEN = 'AbCdEfGhJkLmNpQrStUvWxYz';
const KEY = `flock_guest_${TOKEN}`;

const PLAN = {
  flock: { name: 'Friday Night Out', when: null, status: 'planning', chosenVenue: null },
  host: 'Maya',
  going: 3,
  people: [
    { name: 'Maya', rsvp: 'in', kind: 'member' },
    { name: 'Sam', rsvp: 'out', kind: 'guest' },
  ],
  venues: [{ venue_name: 'Kome', votes: 2 }, { venue_name: 'Ramen', votes: 1 }],
};

const reply = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

describe('GuestInvite: the preview says who is reading, and only the preview', () => {
  // eslint-disable-next-line global-require
  const GuestInvite = require('../website/GuestInvite').default;

  // Every request, with the headers it carried.
  const mount = (routes) => {
    window.history.pushState({}, '', `/i/${TOKEN}`);
    const calls = [];
    global.fetch = jest.fn((url, opts = {}) => {
      const route = String(url).replace(/^.*\/api\/guest\/[^/?]+/, '');
      const auth = opts.headers && (opts.headers.Authorization || opts.headers.authorization);
      calls.push({ route, method: opts.method || 'GET', auth: auth || null });
      const handler = routes[route];
      return handler ? handler(calls.length, auth) : reply(404, {});
    });
    render(React.createElement(GuestInvite));
    return calls;
  };

  beforeEach(() => { window.localStorage.clear(); });
  afterEach(() => { window.history.pushState({}, '', '/'); });

  test('a signed-in viewer\'s session rides on the preview, in the app\'s own header', async () => {
    window.localStorage.setItem('flockToken', 'session-abc');
    const calls = mount({ '': () => reply(200, PLAN) });
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });
    expect(calls[0]).toEqual({ route: '', method: 'GET', auth: 'Bearer session-abc' });
  });

  test('nobody signed in sends no header at all and gets the page', async () => {
    const calls = mount({ '': () => reply(200, PLAN) });
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });
    expect(calls).toHaveLength(1);
    expect(calls[0].auth).toBeNull();
  });

  test('a session the server will not take is asked again without it, so the plan still loads', async () => {
    window.localStorage.setItem('flockToken', 'expired-session');
    const calls = mount({ '': (n) => (n === 1 ? reply(401, { error: 'expired' }) : reply(200, PLAN)) });
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });
    expect(calls.map((c) => c.auth)).toEqual(['Bearer expired-session', null]);
  });

  test('the guest writes never carry the session: the guest identity is their only credential', async () => {
    window.localStorage.setItem('flockToken', 'session-abc');
    const calls = mount({
      '': () => reply(200, PLAN),
      '/rsvp': () => reply(201, { guestToken: '11111111-2222-4333-8444-555555555555', status: 'in' }),
    });
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: 'Sam' } });
    fireEvent.click(screen.getByRole('button', { name: /i'm in/i }));
    await waitFor(() => expect(calls.some((c) => c.route === '/rsvp')).toBe(true));
    for (const c of calls.filter((x) => x.method === 'POST')) expect(c.auth).toBeNull();
  });

  test('the key it reads is the one the app keeps its session under', () => {
    const api = fs.readFileSync(path.join(__dirname, '..', 'services', 'api.js'), 'utf8');
    const page = fs.readFileSync(path.join(__dirname, '..', 'website', 'GuestInvite.js'), 'utf8');
    expect(api).toMatch(/return lsGet\('flockToken'\);/);
    expect(api).toMatch(/headers\['Authorization'\] = `Bearer \$\{token\}`;/);
    expect(page).toMatch(/const SESSION_KEY = 'flockToken';/);
    expect(page).toMatch(/\{ headers: \{ Authorization: `Bearer \$\{session\}` \} \}/);
    // And still no REST client in this chunk.
    expect(page).not.toMatch(/from '\.\.\/services\/api'/);
  });
});

describe('GuestInvite: a vote is for somebody who is going', () => {
  // eslint-disable-next-line global-require
  const GuestInvite = require('../website/GuestInvite').default;
  const IDENTITY = { guestToken: '11111111-2222-4333-8444-555555555555', name: 'Sam', status: 'out', vote: 'Ramen' };

  const mount = (routes) => {
    window.history.pushState({}, '', `/i/${TOKEN}`);
    global.fetch = jest.fn((url) => {
      const route = String(url).replace(/^.*\/api\/guest\/[^/?]+/, '');
      const handler = routes[route];
      return handler ? handler() : reply(404, {});
    });
    return render(React.createElement(GuestInvite));
  };

  beforeEach(() => { window.localStorage.clear(); });
  afterEach(() => { window.history.pushState({}, '', '/'); });

  test('a guest who is out sees the standings as rows, not buttons, and why', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(IDENTITY));
    const { container } = mount({ '': () => reply(200, PLAN) });
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });
    expect(container.textContent).toMatch(/The vote only counts people who are going\. Tap I'm in above if that changes\./);
    expect(screen.queryByRole('button', { name: /kome/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /ramen/i })).toBeNull();
    // Their old pick is not counted while they are out, so the row does not
    // claim it is theirs.
    expect(container.textContent).not.toMatch(/Your vote/);
  });

  test('a guest who is in can still vote, and the pick reads as theirs', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ ...IDENTITY, status: 'in' }));
    const { container } = mount({ '': () => reply(200, PLAN) });
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });
    expect(screen.getByRole('button', { name: /kome/i })).toBeTruthy();
    expect(container.textContent).toMatch(/Pick one\. You can change it\./);
    expect(container.textContent).toMatch(/Your vote/);
  });

  test('when the server says the answer is out, the page takes its word', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ ...IDENTITY, status: 'in' }));
    const { container } = mount({
      '': () => reply(200, PLAN),
      '/vote': () => reply(409, { code: 'NOT_IN', error: "Say you're in first. The vote only counts people who are going." }),
    });
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });
    fireEvent.click(screen.getByRole('button', { name: /kome/i }));
    await waitFor(() => expect(container.querySelector('#gi-problem-vote').textContent)
      .toMatch(/Tap I'm in first\. The vote only counts people who are going\./));
    expect(JSON.parse(window.localStorage.getItem(KEY)).status).toBe('out');
    expect(screen.queryByRole('button', { name: /kome/i })).toBeNull();
  });

  test('the refusal the page reads is the one the server sends', () => {
    const guest = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'guest.js'), 'utf8');
    const vote = guest.slice(guest.indexOf("router.post('/:token/vote',"), guest.indexOf("router.post('/:token/budget',"));
    expect(vote).toMatch(/SELECT id, status FROM guest_rsvps/);
    expect(vote).toMatch(/if \(guest\.rows\[0\]\.status !== 'in'\) \{\s*return res\.status\(409\)\.json\(\{\s*code: 'NOT_IN',/);
  });
});
