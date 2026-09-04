/**
 * EDIT PROFILE.
 *
 * This was an arrow function declared inside `ProfileScreen`, which is itself
 * declared inside `FlockAppInner`, and it was mounted as `<EditProfileForm />`.
 * A component whose identity is rebuilt on every parent render is a new
 * component TYPE to React, and a new type is not reconciled: React unmounts
 * the old subtree and mounts a fresh one. Every piece of state below, and the
 * DOM holding what the person had typed, was destroyed and rebuilt on every
 * unrelated render of the app shell.
 *
 * What that looked like on a phone. You typed your bio, paused to think, and
 * about a second later the box was empty again, because something elsewhere in
 * the shell had re-rendered and the form had been rebuilt from
 * `profileBio`. Tapping the photo button at the top of this form emptied every
 * field for the same reason. And the save worked: the PUT went out, the server
 * stored the change, and then `setProfileName` and `setProfileBio` in the
 * handler below re-rendered the parent, which remounted this form and threw
 * away the `editSuccess` message the handler had just set. So the one form in
 * the app that asks for a password answered a correct password with a blanked
 * password field and no confirmation at all.
 *
 * Binding it at module scope gives it one identity for the life of the page,
 * so the local state below lives as long as the screen does. It still resets
 * when the screen closes, because `profileScreen === 'edit'` stops rendering
 * it and React unmounts it for real, which is what makes a saved bio reappear
 * in the box on the next visit.
 *
 * Everything from `FlockAppInner` arrives as a prop, the same contract
 * VenueDashboard, ChatDetail and AddFriends use and
 * `__tests__/extractionEquivalence.test.js` enforces. `updateProfile` and
 * `Icons` are imported here because they are modules, not parent state.
 *
 * The body below is the old block verbatim, including its original
 * indentation, so it can be diffed against the deleted lines character for
 * character. Nothing was renamed or reformatted on the way across.
 */
import React from 'react';
import Icons from './ui/Icons';
import { updateProfile, resendVerificationEmail } from '../services/api';

const EditProfileForm = ({
  authUser,
  colors,
  confirmClick,
  profileBio,
  profileName,
  profilePhone,
  profilePic,
  setCropImageSrc,
  setCropOffset,
  setCropZoom,
  setProfileBio,
  setProfileName,
  setProfilePhone,
  setShowPicModal,
  styles,
}) => {
                const [editName, setEditName] = React.useState(profileName);
                const [editEmail, setEditEmail] = React.useState(authUser?.email || '');
                const [editPhone, setEditPhone] = React.useState(profilePhone);
                const [editBio, setEditBio] = React.useState(profileBio);
                const [currentPw, setCurrentPw] = React.useState('');
                const [newPw, setNewPw] = React.useState('');
                const [confirmPw, setConfirmPw] = React.useState('');
                const [showCurrentPw, setShowCurrentPw] = React.useState(false);
                const [showNewPw, setShowNewPw] = React.useState(false);
                const [editError, setEditError] = React.useState('');
                const [editSuccess, setEditSuccess] = React.useState('');
                const [editLoading, setEditLoading] = React.useState(false);
                // Changing your address un-verifies the account (routes/users.js
                // clears both columns), and that route deliberately does not mail
                // the new link itself: it answers emailVerificationRequired and
                // the client asks for the link. That makes this form the ONLY
                // sender, and it used to fire and forget. So a resend that was
                // rate limited (one a minute, five an hour, and correcting a
                // typo in your own address inside a minute is the ordinary way
                // to hit that), refused because the mailbox had bounced before,
                // or accepted but never sent, all rendered as "We sent a link to
                // your new address". The person then waits for mail that will
                // never arrive while every plan, friend request and payment
                // handle answers 403, on a screen that offered no way to ask
                // again. These four carry the real answer and the way back.
                const [verifyPending, setVerifyPending] = React.useState(false);
                const [verifyLinkSent, setVerifyLinkSent] = React.useState(false);
                const [verifyRefused, setVerifyRefused] = React.useState(false);
                const [resendCooldown, setResendCooldown] = React.useState(0);

                React.useEffect(() => {
                  if (resendCooldown <= 0) return undefined;
                  const t = setTimeout(() => setResendCooldown((n) => n - 1), 1000);
                  return () => clearTimeout(t);
                }, [resendCooldown]);

                // The same three answers SignupScreen reads, worded the same way.
                // A 200 is not a send: the route reports `verificationSent`
                // separately, so a request that was accepted and never left is
                // not reported as one that arrived.
                const applyResendResult = (data) => {
                  const sent = data?.verificationSent !== false;
                  setVerifyLinkSent((was) => was || sent);
                  if (data?.mailRefused) setVerifyRefused(true);
                  setEditSuccess(data?.mailRefused
                    ? 'Saved. We cannot mail your new address: mail to it bounced or was reported as spam before. Email social@flockcorp.com from it and we will clear that.'
                    : sent
                      ? 'Saved. We sent a link to your new address; confirm it to keep making plans.'
                      : 'Saved, but the confirmation link did not go out. Nothing is wrong with your account, and the link is still worth asking for.');
                };

                const handleResendVerification = async () => {
                  if (resendCooldown > 0 || verifyRefused) return;
                  // Cooldown first, so a double tap cannot get through.
                  setResendCooldown(60);
                  try {
                    applyResendResult(await resendVerificationEmail());
                  } catch (err) {
                    // The server words a 429 with the real window and api.js
                    // carries that sentence. Render it rather than guessing.
                    setEditSuccess('Saved. ' + (err && err.message
                      ? err.message
                      : 'We could not send the confirmation link just now.'));
                  }
                };

                const EyeSvg = ({ show }) => (
                  <svg aria-hidden="true" focusable="false" width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {show ? (
                      <>
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </>
                    ) : (
                      <>
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </>
                    )}
                  </svg>
                );

                const handleSaveProfile = async () => {
                  setEditError('');
                  setEditSuccess('');

                  if (!editName.trim()) { setEditError('Name is required'); return; }
                  if (!editEmail.trim()) { setEditError('Email is required'); return; }
                  if (!currentPw) { setEditError('Current password is required to save changes'); return; }
                  if (newPw && newPw.length < 8) { setEditError('New password must be at least 8 characters'); return; }
                  if (newPw && newPw !== confirmPw) { setEditError('New passwords do not match'); return; }

                  setEditLoading(true);
                  // Optimistic: the bio shows everywhere it renders the moment
                  // Save is tapped, and rolls back if the server says no.
                  const trimmedBio = editBio.trim().slice(0, 200);
                  const prevBio = profileBio;
                  setProfileBio(trimmedBio);
                  try {
                    const payload = {
                      name: editName.trim(),
                      email: editEmail.trim(),
                      bio: trimmedBio,
                      current_password: currentPw,
                    };
                    // Left out entirely when the field is blank: undefined
                    // falls out of JSON.stringify, and the server reads an
                    // absent phone as "leave the column alone". Sending '' on
                    // every save would do the same thing, but only by accident.
                    if (editPhone.trim()) payload.phone = editPhone.trim();
                    // An emptied field on an account that HAD a number is a
                    // removal, spelled null: the server clears the number, its
                    // digest and the discovery switch together.
                    else if (profilePhone) payload.phone = null;
                    if (newPw) payload.new_password = newPw;

                    const data = await updateProfile(payload);
                    setProfileName(data.user.name);
                    // Keep the server's word for the bio when it gives one; a
                    // backend that has not learned the field yet answers
                    // without it, and the optimistic value stands.
                    if (typeof data.user.bio === 'string') setProfileBio(data.user.bio);
                    // The row of record, not what was typed, so the switch
                    // under Safety and privacy reads what actually got stored.
                    if ('phone' in data.user) setProfilePhone(data.user.phone || '');
                    if (data.emailVerificationRequired) {
                      // The address moved, so the account is unverified again
                      // and the next plan, request or payment handle would
                      // 403. Mail the link now (the server asked us to) and
                      // say so, instead of "updated successfully".
                      setVerifyPending(true);
                      setResendCooldown(60);
                      try {
                        applyResendResult(await resendVerificationEmail());
                      } catch (err) {
                        setEditSuccess('Saved. ' + (err && err.message
                          ? err.message
                          : 'We could not send the confirmation link just now.'));
                      }
                    } else {
                      setEditSuccess('Profile updated successfully!');
                    }
                    setCurrentPw('');
                    setNewPw('');
                    setConfirmPw('');
                                     } catch (err) {
                    setProfileBio(prevBio);
                    setEditError(err.message);
                  } finally {
                    setEditLoading(false);
                  }
                };

                const pwFieldStyle = { position: 'relative' };
                const eyeBtnStyle = { position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center' };

                return (
                  <div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '16px' }}>
                      <button aria-label="Change your profile photo" className="hit44" onClick={() => setShowPicModal(true)} style={{ width: '80px', height: '80px', borderRadius: '40px', background: colors.navyBg, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', position: 'relative' }}>
                        {profilePic ? <img src={profilePic} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : Icons.user('white', 32)}
                      </button>
                      <button className="hit44" onClick={() => { if (profilePic) { setCropImageSrc(profilePic); setCropZoom(1); setCropOffset({ x: 0, y: 0 }); } else { setShowPicModal(true); } }} style={{ marginTop: '6px', padding: '4px 12px', borderRadius: '8px', border: 'none', backgroundColor: 'transparent', color: colors.steel, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>
                        Edit Photo
                      </button>
                    </div>

                    {editError && (
                      <div role="alert" style={{ backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '10px 14px', marginBottom: '14px', color: colors.redText, fontSize: 'var(--t-label)', fontWeight: '600' }}>{editError}</div>
                    )}
                    {editSuccess && (
                      <div role="status" style={{ backgroundColor: 'rgba(45,90,135,0.10)', border: '1px solid rgba(45,90,135,0.35)', borderRadius: '10px', padding: '10px 14px', marginBottom: '14px', color: colors.steel, fontSize: 'var(--t-label)', fontWeight: '600' }}>
                        {editSuccess}
                        {/* Only after an address change, and only while the
                            mailbox is one we can still write to. A refused
                            address cannot be helped by pressing this. */}
                        {verifyPending && !verifyRefused && (
                          <button
                            type="button"
                            className="hit44"
                            onClick={handleResendVerification}
                            disabled={resendCooldown > 0}
                            style={{ display: 'block', marginTop: '8px', padding: 0, background: 'none', border: 'none', color: colors.navy, fontSize: 'var(--t-label)', fontWeight: '600', textDecoration: 'underline', cursor: resendCooldown > 0 ? 'not-allowed' : 'pointer', opacity: resendCooldown > 0 ? 0.5 : 1 }}
                          >
                            {/* "again" is a claim too. Nothing was sent when
                                verifyLinkSent is false, and a button that says
                                otherwise repeats the sentence above it. */}
                            {resendCooldown > 0
                              ? 'Try again in ' + resendCooldown + 's'
                              : (verifyLinkSent ? 'Send the link again' : 'Send the link')}
                          </button>
                        )}
                      </div>
                    )}

                    <div style={{ marginBottom: '12px' }}>
                      <label style={{ display: 'block', fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, marginBottom: '4px' }} htmlFor="profile-name-input">Display Name *</label>
                      <input id="profile-name-input" type="text" value={editName} onChange={(e) => setEditName(e.target.value)} style={styles.input} autoComplete="off" />
                    </div>
                    <div style={{ marginBottom: '12px' }}>
                      <label style={{ display: 'block', fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, marginBottom: '4px' }} htmlFor="profile-email-input">Email *</label>
                      <input id="profile-email-input" type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} style={styles.input} autoComplete="off" />
                    </div>
                    {/* Signup does not accept a phone number, on purpose, so
                        this field is the only way one ever reaches an account.
                        Without it "Let friends find me by my phone number"
                        could never be turned on by anybody, and every contact
                        check in the app would answer nobody forever. */}
                    <div style={{ marginBottom: '12px' }}>
                      <label htmlFor="profile-phone-input" style={{ display: 'block', fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, marginBottom: '4px' }}>Phone</label>
                      <input id="profile-phone-input" type="tel" inputMode="tel" value={editPhone} maxLength={20} onChange={(e) => setEditPhone(e.target.value)} placeholder="(555) 555-0123" style={styles.input} autoComplete="tel" />
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '4px 0 0', lineHeight: '1.4' }}>Used only to let friends who already have your number find you, and only while that switch is on under Safety and privacy. Leave it blank and nothing changes.</p>
                    </div>
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '4px' }}>
                        <label htmlFor="profile-bio-input" style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>Bio</label>
                        <span aria-hidden style={{ fontSize: 'var(--t-meta)', color: editBio.length >= 200 ? colors.red : 'var(--text-tertiary)', fontWeight: '500' }}>{editBio.length}/200</span>
                      </div>
                      <textarea
                        id="profile-bio-input"
                        value={editBio}
                        maxLength={200}
                        rows={3}
                        onChange={(e) => setEditBio(e.target.value.slice(0, 200))}
                        placeholder="A line or two about you. Friends see it on your card."
                        style={{ ...styles.input, width: '100%', resize: 'none', lineHeight: 1.4, fontFamily: 'inherit' }}
                        autoComplete="off"
                      />
                    </div>

                    <div style={{ borderTop: `1px solid ${colors.creamDark}`, marginTop: '16px', paddingTop: '16px' }}>
                      <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, marginBottom: '12px' }}>Security</p>

                      <div style={{ marginBottom: '12px' }}>
                        <label style={{ display: 'block', fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, marginBottom: '4px' }}>Current Password *</label>
                        <div style={pwFieldStyle}>
                          <input aria-label="Current password" type={showCurrentPw ? 'text' : 'password'} value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} placeholder="Required to save changes" style={{ ...styles.input, paddingRight: '40px' }} autoComplete="off" />
                          <button className="hit44" type="button" aria-label={showCurrentPw ? 'Hide current password' : 'Show current password'} onClick={() => setShowCurrentPw(!showCurrentPw)} style={eyeBtnStyle}><EyeSvg show={showCurrentPw} /></button>
                        </div>
                      </div>
                      <div style={{ marginBottom: '12px' }}>
                        <label style={{ display: 'block', fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, marginBottom: '4px' }}>New Password <span style={{ fontWeight: 'normal', color: 'var(--text-secondary)' }}>(optional)</span></label>
                        <div style={pwFieldStyle}>
                          <input aria-label="New password" type={showNewPw ? 'text' : 'password'} value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="Min 8 characters" style={{ ...styles.input, paddingRight: '40px' }} autoComplete="off" />
                          <button className="hit44" type="button" aria-label={showNewPw ? 'Hide new password' : 'Show new password'} onClick={() => setShowNewPw(!showNewPw)} style={eyeBtnStyle}><EyeSvg show={showNewPw} /></button>
                        </div>
                      </div>
                      {newPw && (
                        <div style={{ marginBottom: '12px' }}>
                          <label style={{ display: 'block', fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, marginBottom: '4px' }}>Confirm New Password</label>
                          <input aria-label="Confirm new password" type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} placeholder="Re-enter new password" style={styles.input} autoComplete="off" />
                          {confirmPw && newPw !== confirmPw && (
                            <p style={{ fontSize: 'var(--t-meta)', color: colors.redText, margin: '4px 0 0' }}>Passwords do not match</p>
                          )}
                        </div>
                      )}
                    </div>

                    <button
                      className="hit44 glass-btn glass-primary"
                      onClick={(e) => { confirmClick(e); handleSaveProfile(); }}
                      disabled={editLoading}
                      style={{ ...styles.gradientButton, marginTop: '8px', opacity: editLoading ? 0.7 : 1, position: 'relative', overflow: 'hidden' }}
                    >
                      {editLoading ? 'Saving...' : 'Save Changes'}
                    </button>
                  </div>
                );
};

export default EditProfileForm;
