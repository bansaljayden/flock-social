/**
 * EDIT PROFILE PASSES THE SERVER'S ANSWER UP, NOT ONLY WHAT WAS TYPED.
 *
 * PUT /api/users/profile answers with the row it stored, email_verified and
 * phone_discoverable included (backend routes/users.js). The form sent name,
 * email, bio and phone up to the app shell and dropped the rest, so:
 *
 *   - after an email change authUser.email_verified stayed true. App.js's
 *     emailUnconfirmed and the confirm-your-email line keyed off it did not
 *     run until a plan, request or payment handle came back 403.
 *   - after the phone was cleared, the server turned discovery off with it,
 *     and the You tab still read "Find me by phone: On".
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test editProfileServerAnswer --watchAll=false
 */
const fs = require('fs');
const path = require('path');
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
const EditProfileForm = require('../components/EditProfileForm').default;

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');

function openEditProfile(over = {}) {
  const props = {
    authUser: { email: 'sam@example.com', email_verified: true, sign_in_method: 'google' },
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
    setPhoneDiscoverable: jest.fn(),
    onUserUpdated: jest.fn(),
    setShowPicModal: jest.fn(),
    ...over,
  };
  render(React.createElement(EditProfileForm, props));
  return props;
}

afterEach(() => { jest.clearAllMocks(); });

test('an email change hands the app shell the account as unconfirmed', async () => {
  api.updateProfile.mockResolvedValue({
    user: { name: 'Sam', email: 'sam@new.example', bio: '', phone: null, phone_discoverable: false, email_verified: false },
    emailVerificationRequired: true,
  });
  api.resendVerificationEmail.mockResolvedValue({ verificationSent: true });
  const p = openEditProfile();
  fireEvent.change(screen.getByLabelText('Email *'), { target: { value: 'sam@new.example' } });
  fireEvent.click(screen.getByText('Save changes'));
  await waitFor(() => expect(p.onUserUpdated).toHaveBeenCalledTimes(1));
  expect(p.onUserUpdated).toHaveBeenCalledWith(expect.objectContaining({ email: 'sam@new.example', email_verified: false }));
});

test('an answer that does not carry email_verified leaves the shell copy alone', async () => {
  api.updateProfile.mockResolvedValue({ user: { name: 'Sam', email: 'sam@example.com', bio: '' } });
  const p = openEditProfile();
  fireEvent.click(screen.getByText('Save changes'));
  await waitFor(() => expect(p.onUserUpdated).toHaveBeenCalledTimes(1));
  expect('email_verified' in p.onUserUpdated.mock.calls[0][0]).toBe(false);
  expect(p.setPhoneDiscoverable).not.toHaveBeenCalled();
});

test('clearing the phone takes the find-me-by-phone row with it', async () => {
  api.updateProfile.mockResolvedValue({
    user: { name: 'Sam', email: 'sam@example.com', bio: '', phone: null, phone_discoverable: false, email_verified: true },
  });
  const p = openEditProfile({ profilePhone: '+15555550123' });
  fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '' } });
  fireEvent.click(screen.getByText('Save changes'));
  await waitFor(() => expect(p.setPhoneDiscoverable).toHaveBeenCalledWith(false));
  expect(api.updateProfile.mock.calls[0][0].phone).toBeNull();
  expect(p.onUserUpdated).toHaveBeenCalledWith(expect.objectContaining({ phone: null, email_verified: true }));
});

test('the setter reaches the form from the app shell, through the You tab', () => {
  const app = read('App.js');
  const settings = read('screens', 'ProfileSettings.js');
  const block = (src, start) => src.slice(src.indexOf(start), src.indexOf('};', src.indexOf(start)));
  expect(block(app, 'const profileSettingsProps = {')).toMatch(/\n\s+setPhoneDiscoverable,\n/);
  expect(block(settings, 'const editProfileFormProps = {')).toMatch(/\n\s+setPhoneDiscoverable,\n/);
  const signature = settings.slice(settings.indexOf('export default function ProfileSettings({'), settings.indexOf('}) {', settings.indexOf('export default function ProfileSettings({')));
  expect(signature).toMatch(/\n\s+setPhoneDiscoverable,\n/);
});
