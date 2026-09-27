/**
 * The confirmation link in the signup email lands on
 * src/components/auth/VerifyEmailPage.js, and the page must not confirm
 * anything until a person presses its button.
 *
 * The link used to point at the API, whose GET confirmed the address on
 * arrival. School and work mail gateways fetch every link in a message as it
 * arrives, so a squatter who signed up on somebody's school address had it
 * confirmed by the gateway with nobody clicking. The server half of the fix is
 * pinned by backend/__tests__/emailVerification.test.js (the GET spends
 * nothing); this is the page half: rendering the page, which is as far as a
 * scanner that runs scripts gets, sends nothing, and the button sends exactly
 * the one POST that spends the token.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react');

// CRA's jest config resets mock implementations before every test, so each
// test sets its own answer with mock*ValueOnce.
jest.mock('../services/api', () => ({ __esModule: true, default: jest.fn() }));

const request = require('../services/api').default;
const VerifyEmailPage = require('../components/auth/VerifyEmailPage').default;

// The shape the server mints: 32 hex characters, a dot, a base64url verifier.
const TOKEN = `${'0123456789abcdef'.repeat(2)}.${'Ab-_'.repeat(11)}`;

const realLocation = window.location;
const realReplaceState = window.history.replaceState;
let replaced;

function landOnPage(hash) {
  replaced = [];
  delete window.location;
  window.location = {
    hash,
    search: '',
    pathname: '/verify-email',
    replace: (url) => { replaced.push(url); },
  };
  window.history.replaceState = jest.fn();
}

afterEach(() => {
  window.location = realLocation;
  window.history.replaceState = realReplaceState;
});

test('opening the page sends nothing: only the button spends the token', async () => {
  landOnPage(`#token=${TOKEN}`);
  const { getByRole } = render(React.createElement(VerifyEmailPage));

  // What a link scanner that runs the page's scripts gets as far as.
  await new Promise((r) => setTimeout(r, 20));
  expect(request).not.toHaveBeenCalled();
  expect(replaced).toEqual([]);
  // And the token is taken out of the address bar.
  expect(window.history.replaceState).toHaveBeenCalledWith({}, '', '/verify-email');

  request.mockResolvedValueOnce({ message: 'Email confirmed.', email_verified: true });
  fireEvent.click(getByRole('button', { name: 'Confirm my email' }));

  await waitFor(() => expect(replaced).toEqual(['/?email_verified=1']));
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith('/api/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token: TOKEN }),
  });
});

test('the server\'s verdict on a dead link goes to the outcome App.js already explains', async () => {
  landOnPage(`#token=${TOKEN}`);
  const { getByRole } = render(React.createElement(VerifyEmailPage));
  const expired = Object.assign(new Error('That link has expired. Ask for a new one.'), {
    status: 400, data: { reason: 'expired' },
  });
  request.mockRejectedValueOnce(expired);
  fireEvent.click(getByRole('button', { name: 'Confirm my email' }));
  await waitFor(() => expect(replaced).toEqual(['/?email_verified=expired']));
});

test('a network failure keeps the person on the page with the button, rather than calling the link dead', async () => {
  landOnPage(`#token=${TOKEN}`);
  const { getByRole, findByRole } = render(React.createElement(VerifyEmailPage));
  request.mockRejectedValueOnce(Object.assign(new Error("Couldn't reach Flock. Check your connection."), { isNetworkError: true }));
  fireEvent.click(getByRole('button', { name: 'Confirm my email' }));

  expect((await findByRole('alert')).textContent).toMatch(/reach Flock/);
  expect(replaced).toEqual([]);
  expect(getByRole('button', { name: 'Confirm my email' }).disabled).toBe(false);
});

test('a link with no usable token goes straight to "did not work" and never asks the server', async () => {
  landOnPage('#token=cut-in-half');
  render(React.createElement(VerifyEmailPage));
  await waitFor(() => expect(replaced).toEqual(['/?email_verified=invalid']));
  expect(request).not.toHaveBeenCalled();
});
