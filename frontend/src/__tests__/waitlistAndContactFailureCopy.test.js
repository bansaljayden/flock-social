/**
 * Two failure paths where the words shown were not written for a person.
 *
 *   1. THE HOMEPAGE WAITLIST FORM, RETIRED. It printed whatever its Error
 *      carried until this file pinned it: the browser's own "Load failed",
 *      the backend's literal "Server error", and a repeat signup welcomed as
 *      new. It collected emails "to hear the moment the iPhone app is out",
 *      and on 2026-11-04 Apple released the app, so on 2026-11-05 the form
 *      left the page and #get became Apple's badge and the web sign-up. What
 *      is pinned now is that it stays gone, and that the backend route it
 *      posted to stays, because the addresses it holds and their unsubscribe
 *      links still depend on it.
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
const { render } = require('@testing-library/react');

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

afterEach(() => {
  delete global.fetch;
});

describe('the retired waitlist form stays retired', () => {
  test('the home page has no form, no email field and asks nothing of the waitlist', () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }));
    const { container, unmount } = render(React.createElement(LandingPage));
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('input[type="email"]')).toBeNull();
    expect(container.textContent).not.toMatch(/waitlist|get an email when it opens up|the moment the iPhone app is out/i);
    // The page asks the API one thing on load, the Pro offer, and never the waitlist.
    for (const [url] of global.fetch.mock.calls) expect(String(url)).not.toMatch(/waitlist/);
    unmount();
  });

  test('its client code went with it', () => {
    expect(LandingPageModule.waitlistReply).toBeUndefined();
    const src = fs.readFileSync(path.join(__dirname, '..', 'website', 'LandingPage.js'), 'utf8');
    expect(src).not.toMatch(/api\/waitlist/);
  });

  test('the backend route stays, for the addresses it holds and their unsubscribe links', () => {
    const route = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'routes', 'waitlist.js'), 'utf8');
    expect(route).toMatch(/router\.post\('\/'/);
    expect(route).toMatch(/INSERT INTO waitlist \(email\)/);
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
      'deleteTrustedContact', 'setTrustedContacts', 'showToast', 'window', 'userMessage',
      `return (${body});`
    )(
      deleteImpl,
      (fn) => { rows = fn(rows); },
      (msg, type) => toasts.push([msg, type || 'info']),
      { confirm: () => true },
      // api.js's own: an error's text is shown only when api.js wrote it for people.
      jest.requireActual('../services/api').userMessage
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
      // api.js's network failure: its own sentence, marked as one.
      const err = new Error("Couldn't reach Flock. Give it a second and try again.");
      err.status = 0;
      err.isNetworkError = true;
      throw err;
    });
    await t.handler(1);
    expect(t.rows().map((c) => c.id)).toEqual([1, 2]);
    expect(t.toasts).toEqual([["Couldn't reach Flock. Give it a second and try again.", 'error']]);
  });

  test("a failure whose text nobody wrote for people keeps the row and says the handler's own words", async () => {
    const t = run(async () => { throw new TypeError("Cannot read properties of undefined (reading 'id')"); });
    await t.handler(1);
    expect(t.rows().map((c) => c.id)).toEqual([1, 2]);
    expect(t.toasts).toEqual([['Could not remove that contact. Try again.', 'error']]);
  });

  test('a success removes the row, as before', async () => {
    const t = run(async () => ({ success: true }));
    await t.handler(2);
    expect(t.rows().map((c) => c.id)).toEqual([1]);
    expect(t.toasts).toEqual([['Contact removed', 'info']]);
  });
});
