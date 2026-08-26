/**
 * The moderation REASON, end to end across the console:
 *
 *   src/website/ModerationDashboard.js
 *
 * moderation_actions.reason is the recorded rationale for every takedown and
 * ban. The server has accepted it for as long as the column has existed; the
 * console is the only writer and the only reader, so a break on either side of
 * this file means takedowns happen with no recorded why. This file pins the
 * whole loop:
 *
 *   1. SENDING. The typed reason rides in the PUT body with whichever action
 *      is clicked; it is trimmed; an empty or whitespace-only draft is OMITTED
 *      (the server stores what it is sent verbatim, and a stored '' reads as a
 *      moderator who wrote nothing on purpose). A draft typed on one card must
 *      never attach itself to an action on another card, and a sent draft must
 *      not survive to ride with the NEXT action on the same card.
 *
 *   2. RENDERING. A stored reason shows on its audit row as plain text. A row
 *      whose reason is missing entirely (an older backend, or a route that
 *      never wrote one) renders NOTHING for it: no "undefined", no "null", no
 *      empty styled block.
 *
 *   3. HOSTILE INPUT. The reason is free text a moderator typed, stored and
 *      played back. HTML in it must come back as characters, not markup. The
 *      full 1000-character cap must survive the round trip, and the input must
 *      not be able to compose a reason the server would refuse.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const React = require('react');
const { render, screen, fireEvent, waitFor, within } = require('@testing-library/react');

// services/api opens PostHog and a fetch wrapper on import; the console needs
// two names off it. Plain functions, not jest.fn(): react-scripts sets
// resetMocks: true, which strips implementations off jest mocks between tests.
jest.mock('../services/api', () => ({
  BASE_URL: 'https://api.test',
  getToken: () => 'test-token',
}));

const ModerationDashboard = require('../website/ModerationDashboard').default;

const REPORTS = '/api/admin/reports';
const ACTIONS = '/api/admin/moderation-actions';
// Both the unverified list and a decision PUT sit under this prefix, and the
// longest-match lookup above resolves the specific one a test registers.
const VENUES = '/api/admin/venues';

let routes;
let calls;

const respond = (body, { ok = true, status = 200 } = {}) => ({
  ok, status, json: () => Promise.resolve(body),
});

const aReport = (over = {}) => ({
  id: 1,
  status: 'open',
  reason: 'harassment',
  content_type: 'flock_message',
  content_id: 55,
  reported_user_id: 9,
  reported_user_name: 'Sam',
  reported_user_banned: false,
  reporter_name: 'Rae',
  created_at: '2026-08-14T10:00:00Z',
  details: '',
  content_excerpt: 'the reported words',
  content_excerpt_clipped: false,
  content_has_image: false,
  content_image_url: null,
  content_image_deferred: false,
  content_created_at: '2026-08-14T09:00:00Z',
  content_is_hidden: false,
  content_missing: false,
  ...over,
});

const queueBody = (reports) => ({
  reports,
  counts: [
    { status: 'open', count: reports.length },
    { status: 'resolved', count: 0 },
    { status: 'dismissed', count: 0 },
  ],
});

beforeEach(() => {
  calls = [];
  routes = {};
  global.fetch = (url, options) => {
    const p = String(url).replace('https://api.test', '');
    // A PUT lands on /api/admin/reports/:id; longest match first so it is not
    // mistaken for the queue read.
    const key = routes[p] ? p : Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => p.startsWith(k));
    calls.push({ path: p, method: (options && options.method) || 'GET', body: options && options.body });
    const handler = key ? routes[key] : null;
    if (!handler) return Promise.resolve(respond({ error: `no stub for ${p}` }, { ok: false, status: 404 }));
    return Promise.resolve(handler(p, options));
  };
  // jsdom implements neither; the console calls both.
  // The console reads THREE lists on mount: the queue, the audit log and the
  // unverified venue claims. A default stub for the third so every test written
  // before it existed still describes a console whose other two reads worked;
  // any test that cares overrides this key.
  routes[VENUES] = () => respond({ venues: [] });
  window.confirm = () => true;
  window.alert = () => {};
});

const renderConsole = async () => {
  const view = render(React.createElement(ModerationDashboard));
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  return view;
};

// Collect PUT bodies while still answering the background reload the action
// triggers with a sane queue.
const capturePuts = (reloadReports) => {
  const puts = [];
  routes[REPORTS] = (p, options) => {
    if (options && options.method === 'PUT') {
      puts.push({ path: p, body: JSON.parse(options.body) });
      return respond({ message: 'Action applied', status: 'resolved' });
    }
    return respond(queueBody(reloadReports));
  };
  return puts;
};

const REASON_INPUT = 'Reason for actions on this report';

// ═══════════════════════════════════════════════════════════════════════════
// 1. Sending
// ═══════════════════════════════════════════════════════════════════════════
describe('the typed reason is sent with the action', () => {
  test('a reason rides in the PUT body with a hide, trimmed', async () => {
    routes[REPORTS] = () => respond(queueBody([aReport()]));
    routes[ACTIONS] = () => respond({ actions: [] });
    await renderConsole();

    const puts = capturePuts([aReport({ status: 'resolved', content_is_hidden: true })]);

    fireEvent.change(screen.getByLabelText(REASON_INPUT), { target: { value: '  slur in a group chat  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hide content' }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].path).toBe('/api/admin/reports/1');
    expect(puts[0].body).toEqual({ action: 'hide', reason: 'slur in a group chat' });
  });

  test('an empty draft sends no reason key at all, not reason: ""', async () => {
    routes[REPORTS] = () => respond(queueBody([aReport()]));
    routes[ACTIONS] = () => respond({ actions: [] });
    await renderConsole();

    const puts = capturePuts([]);

    // Whitespace-only is the adversarial form of empty: it must trim away and
    // then be omitted, because the server stores what it is sent verbatim.
    fireEvent.change(screen.getByLabelText(REASON_INPUT), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ban user' }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body).toEqual({ action: 'ban' });
    expect(Object.prototype.hasOwnProperty.call(puts[0].body, 'reason')).toBe(false);
  });

  test('a draft on one card never rides with an action on another card', async () => {
    routes[REPORTS] = () => respond(queueBody([
      aReport({ id: 1, content_id: 55 }),
      aReport({ id: 2, content_id: 56, reported_user_name: 'Kit' }),
    ]));
    routes[ACTIONS] = () => respond({ actions: [] });
    await renderConsole();

    const puts = capturePuts([aReport({ id: 1, content_id: 55 })]);

    // Type on card 1, act on card 2.
    const inputs = screen.getAllByLabelText(REASON_INPUT);
    expect(inputs).toHaveLength(2);
    fireEvent.change(inputs[0], { target: { value: 'about the first report' } });
    const dismissButtons = screen.getAllByRole('button', { name: 'Dismiss' });
    fireEvent.click(dismissButtons[1]);

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].path).toBe('/api/admin/reports/2');
    expect(puts[0].body).toEqual({ action: 'dismiss' });
  });

  test('a sent reason is cleared and does not ride with the next action on the card', async () => {
    routes[REPORTS] = () => respond(queueBody([aReport()]));
    routes[ACTIONS] = () => respond({ actions: [] });
    await renderConsole();

    // The reload serves the same card, still actionable, so a second action
    // can be clicked on it.
    const puts = capturePuts([aReport({ reported_user_banned: true })]);

    fireEvent.change(screen.getByLabelText(REASON_INPUT), { target: { value: 'first strike, hide only' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ban user' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body).toEqual({ action: 'ban', reason: 'first strike, hide only' });

    // The background reload settles; the draft box comes back empty.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unban user' })).toBeEnabled());
    expect(screen.getByLabelText(REASON_INPUT).value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Unban user' }));
    await waitFor(() => expect(puts).toHaveLength(2));
    // The stale draft must not attach itself to this second, different action.
    expect(puts[1].body).toEqual({ action: 'unban' });
  });

  test('a reason at the full 1000-character cap survives the trip intact', async () => {
    routes[REPORTS] = () => respond(queueBody([aReport()]));
    routes[ACTIONS] = () => respond({ actions: [] });
    await renderConsole();

    const puts = capturePuts([]);
    const long = 'x'.repeat(1000);
    fireEvent.change(screen.getByLabelText(REASON_INPUT), { target: { value: long } });
    fireEvent.click(screen.getByRole('button', { name: 'Hide content' }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body.reason).toHaveLength(1000);
    expect(puts[0].body.reason).toBe(long);
  });

  test('the rendered input cannot compose a reason the server would refuse', async () => {
    // PUT /api/admin/reports/:id refuses reason.length > 1000. Read the cap
    // off the RENDERED element, not the source, so a refactor that moves the
    // attribute cannot fake a pass.
    routes[REPORTS] = () => respond(queueBody([aReport()]));
    routes[ACTIONS] = () => respond({ actions: [] });
    await renderConsole();

    const input = screen.getByLabelText(REASON_INPUT);
    expect(Number(input.getAttribute('maxlength'))).toBeLessThanOrEqual(1000);
    expect(Number(input.getAttribute('maxlength'))).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Rendering
// ═══════════════════════════════════════════════════════════════════════════
describe('the audit log shows the reason when it exists and nothing when it does not', () => {
  const logWith = (actions) => {
    routes[REPORTS] = () => respond(queueBody([]));
    routes[ACTIONS] = () => respond({ actions });
  };

  test('a present reason renders on its row; an absent one leaves no artifact', async () => {
    logWith([
      { id: 1, action: 'user_banned', target_user_name: 'Sam', moderator_name: 'Jay', created_at: '2026-08-14T11:00:00Z', reason: 'threats in DMs after a warning' },
      // No reason key at all: the shape an older backend serves. The other
      // agent's GET work adds the field; this row is the world before it.
      { id: 2, action: 'content_hidden', content_type: 'dm', content_id: 9, moderator_name: 'Jay', created_at: '2026-08-14T11:01:00Z' },
      // Explicit null, the shape a backend that selects the column serves for
      // an action taken with no reason typed.
      { id: 3, action: 'dismissed', moderator_name: 'Jay', created_at: '2026-08-14T11:02:00Z', reason: null },
    ]);
    await renderConsole();

    // The stored words are on the banned row, verbatim.
    const bannedRow = screen.getByText('User banned').closest('div');
    expect(within(bannedRow).getByText('threats in DMs after a warning')).toBeInTheDocument();

    // The reason-less rows carry no leftovers of any kind.
    const hiddenRow = screen.getByText('Content hidden').closest('div');
    const dismissedRow = screen.getByText('Report dismissed').closest('div');
    for (const row of [hiddenRow, dismissedRow]) {
      expect(row.textContent).not.toMatch(/undefined/);
      expect(row.textContent).not.toMatch(/\bnull\b/);
      // No empty styled block either: the reason div is italic, and these rows
      // must not render one at all.
      expect([...row.querySelectorAll('div')].filter((d) => d.style.fontStyle === 'italic')).toHaveLength(0);
    }
    expect(within(bannedRow).getAllByText('threats in DMs after a warning')).toHaveLength(1);
  });

  test('a 1000-character stored reason renders whole and cannot widen the page', async () => {
    const long = 'w'.repeat(1000);
    logWith([{ id: 1, action: 'user_banned', target_user_name: 'Sam', moderator_name: 'Jay', created_at: '2026-08-14T11:00:00Z', reason: long }]);
    await renderConsole();

    const reasonEl = screen.getByText(long);
    expect(reasonEl.textContent).toHaveLength(1000);
    // jsdom does no layout, so the overflow discipline is read off the
    // rendered style: an unbroken kilobyte must be allowed to break anywhere.
    expect(reasonEl.style.overflowWrap).toBe('anywhere');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Hostile input
// ═══════════════════════════════════════════════════════════════════════════
describe('a reason containing HTML renders as characters, not markup', () => {
  test('script and img payloads in a stored reason come back inert', async () => {
    const hostile = '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script><b>not bold</b>';
    routes[REPORTS] = () => respond(queueBody([]));
    routes[ACTIONS] = () => respond({
      actions: [{ id: 1, action: 'user_banned', target_user_name: 'Sam', moderator_name: 'Jay', created_at: '2026-08-14T11:00:00Z', reason: hostile }],
    });
    const { container } = await renderConsole();

    // The characters are all on screen…
    expect(screen.getByText(hostile)).toBeInTheDocument();
    // …and none of them became elements. The queue is empty, so any <img> or
    // <script> in the document could only have come from the reason.
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('script')).toHaveLength(0);
    expect(window.pwned).toBeUndefined();
    // The <b>not bold</b> did not become a bold element: the only <b> tags on
    // the page are the ones the console renders itself, and none says this.
    const bolds = [...container.querySelectorAll('b')].map((el) => el.textContent);
    expect(bolds).not.toContain('not bold');
  });

  test('the console never renders any HTML string raw', () => {
    // Belt to the behavioral test above: the mechanism that would break it is
    // dangerouslySetInnerHTML, and the file must not contain one.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'website', 'ModerationDashboard.js'), 'utf8');
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    expect(src).not.toMatch(/innerHTML/);
  });
});
