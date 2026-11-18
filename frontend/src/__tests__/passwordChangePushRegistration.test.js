/**
 * A PASSWORD CHANGE KEEPS THIS PHONE'S PUSH.
 *
 * Changing the password in Edit profile ends every session the account has,
 * and the server deletes every device row with them (backend
 * middleware/auth.js revokeUserSessions), this device's included, before it
 * hands this device a new session. The form re-dialled the socket and nothing
 * else, and the push watcher in services/firebase.js registers again only on a
 * focus, a reconnect, a storage event or a return to the app. So the phone in
 * the person's hand stopped receiving notifications until the next time it
 * was backgrounded and reopened. The form now registers this device again
 * under the new session, after that session is stored, and only when the
 * password changed. The server still deletes every device's row: the other
 * devices have to sign in again.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test passwordChangePushRegistration --watchAll=false
 */

const React = require('react');
const { render, screen, fireEvent, waitFor } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  updateProfile: jest.fn(),
  resendVerificationEmail: jest.fn(),
  userMessage: jest.requireActual('../services/api').userMessage,
}));
jest.mock('../services/socket', () => ({ connectSocket: jest.fn() }));
jest.mock('../services/firebase', () => ({ syncPushRegistration: jest.fn() }));

const api = require('../services/api');
const { connectSocket } = require('../services/socket');
const { syncPushRegistration } = require('../services/firebase');
const EditProfileForm = require('../components/EditProfileForm').default;

const openEditProfile = () => render(React.createElement(EditProfileForm, {
  authUser: { email: 'sam@example.com', sign_in_method: 'password' },
  colors: { navy: '#000', navyBg: '#111', steel: '#222', red: '#f00', redText: '#c00', creamDark: '#eee' },
  styles: { input: {}, gradientButton: {} },
  confirmClick: jest.fn(),
  profileBio: '',
  profileName: 'Sam',
  profilePhone: '',
  profilePic: null,
  setCropImageSrc: jest.fn(),
  setCropOffset: jest.fn(),
  setCropZoom: jest.fn(),
  setProfileBio: jest.fn(),
  setProfileName: jest.fn(),
  setProfilePhone: jest.fn(),
  onUserUpdated: jest.fn(),
  setShowPicModal: jest.fn(),
}));

// The session api.js stores out of the answer, before updateProfile returns.
let sessionStored = false;
let storedWhenRegistered = null;

beforeEach(() => {
  sessionStored = false;
  storedWhenRegistered = null;
  api.updateProfile.mockImplementation(async () => {
    sessionStored = true;
    return { user: { name: 'Sam', email: 'sam@example.com', bio: '' }, token: 'new-session' };
  });
  syncPushRegistration.mockImplementation(async () => {
    storedWhenRegistered = sessionStored;
    return 'device-token';
  });
});

afterEach(() => {
  jest.clearAllMocks();
});

it('registers this device again under the new session after a password change', async () => {
  openEditProfile();
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'Password1' } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'Password2' } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'Password2' } });
  fireEvent.click(screen.getByText('Save changes'));

  await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(1));
  expect(api.updateProfile.mock.calls[0][0].new_password).toBe('Password2');
  expect(connectSocket).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(syncPushRegistration).toHaveBeenCalledTimes(1));
  expect(storedWhenRegistered).toBe(true);
});

it('leaves the registration alone when the password did not change', async () => {
  openEditProfile();
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'Password1' } });
  fireEvent.click(screen.getByText('Save changes'));

  await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('Profile updated successfully!')).toBeTruthy();
  expect(connectSocket).not.toHaveBeenCalled();
  expect(syncPushRegistration).not.toHaveBeenCalled();
});
