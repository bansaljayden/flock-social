/* A BUILD WITH NO GOOGLE CLIENT ID STILL HAS A SIGN-IN SCREEN.
 *
 * @react-oauth/google calls google.accounts.oauth2.initTokenClient from an
 * effect once Google's script loads, and with an empty client id that throws
 * ("Missing required parameter client_id") inside the hook every auth screen
 * calls. It sent the whole sign-in screen to the crash screen, email and
 * password included, and every browser test on the local stack with it (that
 * build carries no id). useGoogleAuth now never starts the library without an
 * id: the mock below throws the way Google's script did, and must never run.
 */
delete process.env.REACT_APP_GOOGLE_CLIENT_ID;

const React = require('react');
const { render, act } = require('@testing-library/react');

const mockGoogleLibrary = jest.fn(() => { throw new Error('Missing required parameter client_id.'); });
jest.mock('@react-oauth/google', () => ({
  useGoogleLogin: (...args) => mockGoogleLibrary(...args),
  GoogleOAuthProvider: ({ children }) => children,
}));
jest.mock('../services/api', () => ({ googleLogin: jest.fn(), googleLoginWithToken: jest.fn() }));

const useGoogleAuth = require('../components/auth/useGoogleAuth').default;
const { WEB_GOOGLE_CONFIGURED } = require('../components/auth/useGoogleAuth');

test('with no client id the Google library is never started, and the button says why', () => {
  expect(WEB_GOOGLE_CONFIGURED).toBe(false);
  const onError = jest.fn();
  let start = null;
  function Probe() {
    start = useGoogleAuth({ onSuccess: jest.fn(), onError, setBusy: jest.fn() });
    return null;
  }
  expect(() => render(React.createElement(Probe))).not.toThrow();
  expect(mockGoogleLibrary).not.toHaveBeenCalled();
  act(() => { start(); });
  expect(onError).toHaveBeenCalledWith('Google sign-in is not set up in this build.');
});
