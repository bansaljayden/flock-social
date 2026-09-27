/**
 * Two failure paths where the words shown were not written for a person.
 *
 *   1. THE HOMEPAGE WAITLIST FORM. It printed whatever its Error carried. A
 *      dropped connection read as the browser's own "Load failed" (Safari) or
 *      "Failed to fetch" (Chrome); a 500 read as the backend's literal
 *      "Server error"; and a repeat signup was welcomed as if it were new,
 *      because the page ignored the server's answer on a 201. While the app is
 *      in review the App Store badge points at this form, so it is how every
 *      iPhone visitor gets in line.
 *
 *   2. REMOVING A TRUSTED CONTACT that is already gone. The server answers 404
 *      "Contact not found" when it was removed on another device, and the app
 *      answered every failure with "Could not remove that contact. Try again."
 *      The row stayed and no retry could ever work.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, waitFor } = require('@testing-library/react');

// Same stubs as marketingSiteAccessibility.test.js: LiveDemo pulls maplibre-gl
// and BirdieBird runs a rAF loop, and neither is under test.
jest.mock('../website/LiveDemo', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../components/ui/BirdieBird', () => ({
  __esModule: true,
  default: () => null,
  WARM_BIRD: { body: '', head: '', flap: null, neck: '0 0' },
  BIRDIE: { body: '', head: '', flap: null, neck: '0 0' },
}));

const LandingPageModule = require('../website/LandingPage');
const LandingPage = LandingPageModule.default;
const { waitlistReply } = LandingPageModule;

const JOINED = 'You’re on the list. You’ll get an email when it opens up.';
const ALREADY = 'You’re already on the list. You’ll get an email when it opens up.';
const FAILED = 'Could not sign you up. Try again in a moment.';
const OFFLINE = 'Couldn’t reach Flock. Check your connection and try again.';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: body === undefined
      ? () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0'))
      : () => Promise.resolve(body),
  };
}

// Submits the real form with fetch answering `answer`, and returns what the
// two live regions and the field hold once the request settles.
async function submitWith(answer) {
  global.fetch = jest.fn(answer);
  const { container, unmount } = render(React.createElement(LandingPage));
  const input = screen.getByLabelText(/email address/i);
  fireEvent.change(input, { target: { value: 'someone@example.com' } });
  const submit = Array.from(container.querySelectorAll('button'))
    .find((b) => /join the waitlist/i.test(b.textContent));
  fireEvent.click(submit);
  await waitFor(() => expect(submit.getAttribute('aria-disabled')).not.toBe('true'));
  await waitFor(() => {
    const said = container.querySelector('[role="status"]').textContent
      + container.querySelector('[role="alert"]').textContent;
    expect(said).not.toBe('');
  });
  const out = {
    status: container.querySelector('[role="status"]').textContent,
    alert: container.querySelector('[role="alert"]').textContent,
    field: input.value,
    invalid: input.getAttribute('aria-invalid'),
  };
  unmount();
  return out;
}

afterEach(() => {
  delete global.fetch;
});

describe('the waitlist form, rendered, for every way the request ends', () => {
  test('a dropped connection says so in words, not in the browser\'s', async () => {
    for (const browserSays of ['Load failed', 'Failed to fetch', 'NetworkError when attempting to fetch resource.']) {
      // eslint-disable-next-line no-await-in-loop
      const out = await submitWith(() => Promise.reject(new TypeError(browserSays)));
      expect(out.alert).toBe(OFFLINE);
      expect(out.status).toBe('');
      expect(out.invalid).toBe('true');
      // The address stays, so trying again is one tap.
      expect(out.field).toBe('someone@example.com');
    }
  });

  test('a 500 carrying the route\'s "Server error" placeholder gets a sentence instead', async () => {
    const out = await submitWith(() => Promise.resolve(response(500, { error: 'Server error' })));
    expect(out.alert).toBe(FAILED);
    expect(out.alert).not.toMatch(/Server error/);
  });

  test('a gateway error page that is not JSON gets the same sentence', async () => {
    const out = await submitWith(() => Promise.resolve(response(502)));
    expect(out.alert).toBe(FAILED);
    expect(out.alert).not.toMatch(/Unexpected token/);
  });

  test('the sentences the route wrote for a visitor are kept', async () => {
    const tooMany = 'Too many signups from this connection. Try again later.';
    let out = await submitWith(() => Promise.resolve(response(429, { error: tooMany })));
    expect(out.alert).toBe(tooMany);
    out = await submitWith(() => Promise.resolve(response(400, { error: 'Valid email is required' })));
    expect(out.alert).toBe('Valid email is required');
  });

  test('a repeat signup is told it was already on the list', async () => {
    const out = await submitWith(() => Promise.resolve(response(201, {
      success: true, alreadyOnList: true, message: "You're already on the list.",
    })));
    expect(out.status).toBe(ALREADY);
    expect(out.alert).toBe('');
    expect(out.field).toBe('');
    expect(out.invalid).toBeNull();
  });

  test('a new signup still gets the page\'s own confirmation', async () => {
    const out = await submitWith(() => Promise.resolve(response(201, {
      success: true, alreadyOnList: false, message: "You're on the list.",
    })));
    expect(out.status).toBe(JOINED);
    expect(out.field).toBe('');
  });
});

describe('waitlistReply, the mapping on its own', () => {
  test('success, with and without the flag', () => {
    expect(waitlistReply(201, { alreadyOnList: true })).toEqual({ msg: ALREADY, bad: false });
    expect(waitlistReply(201, { alreadyOnList: false })).toEqual({ msg: JOINED, bad: false });
    // An older backend that sends no flag is treated as a new signup.
    expect(waitlistReply(201, {})).toEqual({ msg: JOINED, bad: false });
  });

  test('only 400 and 429 pass the server\'s words through, and never the placeholder', () => {
    expect(waitlistReply(400, { error: 'Server error' })).toEqual({ msg: FAILED, bad: true });
    expect(waitlistReply(429, {})).toEqual({ msg: FAILED, bad: true });
    for (const status of [401, 403, 404, 500, 502, 503, 504]) {
      expect(waitlistReply(status, { error: 'Internal thing' })).toEqual({ msg: FAILED, bad: true });
    }
  });

  test('the copy has no em dash and names no browser error', () => {
    for (const line of [JOINED, ALREADY, FAILED, OFFLINE]) {
      expect(line).not.toMatch(/—/);
      expect(line).not.toMatch(/Load failed|Failed to fetch|Server error/);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('removing a trusted contact that is already gone', () => {
  // The REAL handler from App.js, compiled and run against stubs, so this
  // fails if the shipped branch regresses rather than if a string moves.
  const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
  const start = APP.indexOf('const handleDeleteContact = useCallback(');
  const end = APP.indexOf('}, [showToast]);', start);
  // Up to and including the arrow's closing brace, which is the `}` that
  // opens `}, [showToast]);`.
  const body = APP.slice(start + 'const handleDeleteContact = useCallback('.length, end + 1).trim();

  function run(deleteImpl) {
    let rows = [{ id: 1, contact_name: 'Mum' }, { id: 2, contact_name: 'Dad' }];
    const toasts = [];
    // eslint-disable-next-line no-new-func
    const handler = new Function(
      'deleteTrustedContact', 'setTrustedContacts', 'showToast', 'window',
      `return (${body});`
    )(
      deleteImpl,
      (fn) => { rows = fn(rows); },
      (msg, type) => toasts.push([msg, type || 'info']),
      { confirm: () => true }
    );
    return { handler, rows: () => rows, toasts };
  }

  test('the source still has the shape this suite compiles', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toMatch(/^async \(contactId\) => \{/);
    expect(body).toMatch(/\}$/);
  });

  test('a 404 removes the row and says it is removed', async () => {
    const t = run(async () => {
      const err = new Error('Contact not found');
      err.status = 404;
      throw err;
    });
    await t.handler(1);
    expect(t.rows().map((c) => c.id)).toEqual([2]);
    expect(t.toasts).toEqual([['Contact removed', 'info']]);
  });

  test('any other failure keeps the row and shows the reason it was given', async () => {
    const t = run(async () => {
      const err = new Error("Couldn't reach Flock. Give it a second and try again.");
      err.status = 0;
      throw err;
    });
    await t.handler(1);
    expect(t.rows().map((c) => c.id)).toEqual([1, 2]);
    expect(t.toasts).toEqual([["Couldn't reach Flock. Give it a second and try again.", 'error']]);
  });

  test('a success removes the row, as before', async () => {
    const t = run(async () => ({ success: true }));
    await t.handler(2);
    expect(t.rows().map((c) => c.id)).toEqual([1]);
    expect(t.toasts).toEqual([['Contact removed', 'info']]);
  });
});
