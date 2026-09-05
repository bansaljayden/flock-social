/**
 * PROFILE AND SETTINGS SCREEN (the You tab)
 *
 * This screen was 847 lines of `App.js`, declared as an arrow function inside
 * `FlockAppInner` and called rather than mounted. It moved out for the same
 * reason the venue owner dashboard, the flock chat detail and Add Friends did,
 * which is that a single file holding every screen in the product is a file
 * nobody can review. It is where today's worst remount bugs lived: Edit
 * Profile self-erasing on every keystroke was one subscreen of it, fixed by
 * lifting the form into its own component, and the rest of the settings list
 * shares the render that made that happen.
 *
 * WHY THIS ONE IS A STATIC IMPORT
 *
 * The venue dashboard is the paid product, gated behind a role, and no
 * consumer reaches it, so a chunk fetch costs its audience nothing. This is
 * the opposite. It is one of the four bottom-tab screens, the `case 'profile'`
 * arm of the tab switch, so every signed-in person is one tap from it and most
 * of them open it more than once. Splitting it behind `React.lazy` would spend
 * a round trip on a bar network in front of a tab, and take the tab bar it
 * draws itself down with the Suspense fallback while the chunk arrives. Add
 * Friends and the chat detail were both kept as plain static imports for the
 * same reason and with the same math, and this screen sits further along that
 * scale than either. So it is a normal import, mounted as
 * `<ProfileSettings {...props} />`, and it lives in the app chunk.
 *
 * WHY EVERYTHING ARRIVES AS A PROP
 *
 * The old arrow function closed over 121 names: 115 declared in
 * `FlockAppInner`, which is state, setters and handlers, and six module-level
 * helpers, constants and components that `App.js` shares with screens other
 * than this one. A context would have had to enumerate exactly the same 121
 * names into a provider value, so it buys nothing and hides the dependency
 * surface behind a hook. They are parameters instead, so the whole dependency
 * surface of this file is its parameter list plus its imports, and a name this
 * component reads and does not receive is an undefined identifier that
 * `no-undef` fails the build on, rather than a prop that is silently
 * `undefined` at runtime and renders as nothing.
 *
 * The 121 names were not read off the page. They came from a Babel scope walk
 * of the block, every `ReferencedIdentifier` whose binding resolves outside
 * it, and the parameter list below and the props object at the call site were
 * both generated from that one array, so they cannot drift apart.
 *
 * The state and the effects behind these props deliberately did NOT move. They
 * live in `FlockAppInner`, which does not unmount when the user leaves this
 * screen, so a half-typed trusted contact, an open delete-account sheet and
 * the blocked list all survive a trip elsewhere exactly as they did before.
 * Moving them down would have reset all of it on every exit, which is the
 * remount class this whole sweep exists to close.
 *
 * The Edit Profile subscreen mounts `./components/EditProfileForm`, which was
 * lifted out on its own earlier for the self-erasing bug, and it keeps being
 * imported here.
 *
 * The body below is the old block verbatim, including its original four-space
 * indentation, so it can be diffed against the deleted lines character for
 * character. Nothing was renamed, reformatted or improved on the way across.
 */
import React from 'react';
import { deleteAccount, trackNotificationPermission, updatePaymentMethods, logoutAll, getCurrentUser, clearLocalSession } from '../services/api';
import { getNotificationStatus, requestNotificationPermission } from '../services/firebase';
import { BirdieStill, BirdNote, WARM_BIRD } from '../components/ui/BirdieBird';
import Icons from '../components/ui/Icons';
import EditProfileForm from '../components/EditProfileForm';

export default function ProfileSettings({
  // Module-level helpers, constants and components that live in App.js and are
  // shared with screens other than this one, so they stay declared there and
  // arrive here.
  DialogBehavior,
  ListSkeleton,
  PROFILE_SUBSCREEN_TITLES,
  SearchInputLocal,
  openExternal,
  sessionEndCopy,
  // Everything else is declared in FlockAppInner and stays declared there.
  BottomNav,
  SafetyButton,
  Toggle,
  authUser,
  blockedError,
  blockedLoading,
  blockedUsers,
  cashappCashtag,
  colors,
  confirmClick,
  crowdAlertsOn,
  deleteAlertRef,
  deleteConfirmText,
  deleteError,
  deleteNeedsReauth,
  deletePassword,
  deletingAccount,
  editingContact,
  entitlements,
  exportError,
  exportNeedsReauth,
  exportPassword,
  exportingData,
  flocks,
  flocksError,
  friendCount,
  handleDeleteContact,
  handleEditContact,
  handleExportData,
  handleSaveContact,
  handleTogglePhoneDiscovery,
  handleUnblock,
  isDark,
  isNightModeActive,
  isPro,
  loadBlockedUsers,
  loadPhoneDiscovery,
  loadTrustedContacts,
  locationEnabled,
  needsEmailVerification,
  newContact,
  newInterest,
  notifStatus,
  onLogout,
  openVenueDashboard,
  onUserUpdated,
  paymentSaving,
  pendingRequests,
  phoneDiscoverable,
  phoneDiscoveryBusy,
  phoneDiscoveryError,
  phoneDiscoveryNeedsNumber,
  profileBio,
  profileHandle,
  profileName,
  profilePhone,
  profilePic,
  profileScreen,
  reliabilityScore,
  safetyLoading,
  safetyOn,
  setAutoMode,
  setCashappCashtag,
  setCropImageSrc,
  setCropOffset,
  setCropZoom,
  setCrowdAlertsEnabled,
  setCurrentScreen,
  setDeleteConfirmText,
  setDeleteError,
  setDeleteNeedsReauth,
  setDeletePassword,
  setDeletingAccount,
  setEditingContact,
  setExportError,
  setExportNeedsReauth,
  setExportPassword,
  setNewContact,
  setNewInterest,
  setNotifStatus,
  setPaymentSaving,
  setPaywallTrigger,
  setPhoneDiscoveryError,
  setPhoneDiscoveryNeedsNumber,
  setProfileBio,
  setProfileName,
  setProfilePhone,
  setProfileScreen,
  setSafetyEnabled,
  setShowAddContact,
  setShowAdminPrompt,
  setShowDeleteAccount,
  setShowExportData,
  setShowPicModal,
  setUnblockTarget,
  setUserInterests,
  setVenmoUsername,
  setZelleIdentifier,
  showAddContact,
  showDeleteAccount,
  showExportData,
  showToast,
  streak,
  styles,
  suggestedInterests,
  switchMode,
  themeMode,
  toggleLocation,
  toggleTheme,
  trustedContacts,
  trustedContactsError,
  trustedContactsLoaded,
  unblockTarget,
  unblockingId,
  userInterests,
  userMode,
  venmoUsername,
  zelleIdentifier,
}) {
    if (profileScreen !== 'main') {
      return (
        <div key={`profile-${profileScreen}-container`} style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--bg-primary)' }}>
          <div style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid var(--divider)', backgroundColor: 'var(--bg-card-solid)', flexShrink: 0 }}>
            <button aria-label="Back" className="hit44" onClick={() => setProfileScreen('main')} style={{ background: 'none', border: 'none', color: colors.navy, fontSize: 'var(--t-title)', cursor: 'pointer' }}>←</button>
            <h1 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: 0 }}>{PROFILE_SUBSCREEN_TITLES[profileScreen] || 'Payment'}</h1>
          </div>
          <div style={{ flex: 1, padding: '16px', overflowY: 'auto' }}>
            {profileScreen === 'edit' && (() => {
              // Edit Profile lives in ./components/EditProfileForm.js now. It
              // was declared right here, inside this render, and mounted as an
              // element, so React rebuilt its type on every render of the shell
              // and threw away the DOM holding whatever had been typed. Every
              // value it reads is named once, in this object, in shorthand, so
              // a name here and the matching parameter over there cannot drift
              // apart. Built inside this branch for the same reason
              // addFriendsProps is: several of these are declared further down
              // this component and reading them any earlier is a temporal dead
              // zone throw.
              const editProfileFormProps = {
                authUser,
                colors,
                // The shell's copy of the account is a prop that never
                // refreshes, and this form is the one screen that can move the
                // ADDRESS on it. Without this, everything downstream kept
                // naming the old one.
                onUserUpdated,
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
              };
              return <EditProfileForm {...editProfileFormProps} />;
            })()}
            {profileScreen === 'safety' && (
              <div>
                {/* Safety toggle */}
                <div style={styles.card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <p style={{ fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy, margin: 0 }}>SOS button</p>
                      {/* What this toggle ACTUALLY gates is the emergency
                          button itself, and the old copy ("Quick exit &
                          check-ins") described two features that do not exist
                          while hiding what turning it off really does: remove
                          the only way to open the emergency sheet. Say the
                          true thing, on the one screen where a wrong sentence
                          costs the most. */}
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>Turning this off hides the emergency SOS button everywhere in the app. Saves as you switch it.</p>
                    </div>
                    <Toggle label="SOS button" on={safetyOn} onChange={() => setSafetyEnabled(!safetyOn)} />
                  </div>
                </div>

                {/* Info card */}
                <div style={{ ...styles.card, display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                  <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'var(--accent-red-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{Icons.shield(colors.red, 18)}</div>
                  <div>
                    <p style={{ fontWeight: '600', fontSize: 'var(--t-label)', color: colors.navy, margin: '0 0 4px' }}>Emergency Contacts</p>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>Trusted contacts get an email when you press SOS. It includes your location if your phone has a fix at the time, and Flock keeps trying for one just after.</p>
                  </div>
                </div>

                {/* Trusted contacts list */}
                <div style={styles.card}>
                  {/* The count is only shown once a read has landed. A "(0)"
                      over a list nobody could fetch is the same false claim as
                      the empty state underneath it. */}
                  <h2 style={{ fontWeight: '700', fontSize: 'var(--t-title)', color: colors.navy, margin: '0 0 12px' }}>Trusted Contacts{trustedContactsLoaded ? ` (${trustedContacts.length})` : ''}</h2>

                  {safetyLoading && trustedContacts.length === 0 && (
                    <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', textAlign: 'center', padding: '16px 0' }}>Loading...</p>
                  )}

                  {/* A failed read, said out loud, with the retry beside it.
                      This is the surface an emergency runs through, so the one
                      thing it may never do is show a person an empty list and
                      let them believe it. */}
                  {!safetyLoading && trustedContactsError && (
                    <BirdNote
                      layout="row"
                      bird={WARM_BIRD}
                      size={56}
                      role="alert"
                      title={trustedContactsError}
                      body="Nothing has been lost. Anyone you have added is still on your account."
                      style={{ padding: '14px 0' }}
                      action={<button className="hit44 glass-btn glass-navy" onClick={loadTrustedContacts} style={{ padding: '10px 16px', borderRadius: '10px', border: 'none', background: colors.navyMidBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-label)', cursor: 'pointer' }}>Try again</button>}
                    />
                  )}

                  {!safetyLoading && !trustedContactsError && trustedContactsLoaded && trustedContacts.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '20px 0' }}>
                      <BirdieStill size={64} style={{ margin: '0 auto 8px' }} />
                      <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', margin: 0 }}>No trusted contacts yet</p>
                    </div>
                  )}

                  {trustedContacts.map(c => (
                    <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 0', borderBottom: '1px solid var(--border-light)' }}>
                      <div style={{ width: '40px', height: '40px', borderRadius: '20px', backgroundColor: 'var(--icon-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy, flexShrink: 0 }}>{c.contact_name?.[0]?.toUpperCase() || '?'}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy, margin: 0 }}>{c.contact_name}</p>
                        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0' }}>{c.contact_phone}</p>
                        {c.contact_email && <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '1px 0 0' }}>{c.contact_email}</p>}
                        {/* Email is the only channel an SOS has. The backend no
                            longer lets a bounced or complained address block an
                            emergency send (services/emailSuppression.js
                            EMERGENCY_CATEGORY), which means a broken address now
                            fails silently at the provider instead of loudly at
                            us. So the person who can fix it has to be told.
                            Deliberately does not say bounce or spam: what the
                            user needs is that the address is not working. */}
                        {c.contact_email && c.email_deliverable === false && (
                          <p style={{ fontSize: 'var(--t-meta)', color: colors.redText, fontWeight: '600', margin: '3px 0 0' }}>
                            Mail to this address has been failing. Check it with them and update it, or alerts may not arrive.
                          </p>
                        )}
                        {c.relationship && <span style={{ display: 'inline-block', marginTop: '3px', padding: '1px 8px', background: 'var(--icon-bg)', borderRadius: '10px', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', textTransform: 'capitalize' }}>{c.relationship}</span>}
                      </div>
                      <button className="hit44" onClick={() => handleEditContact(c)} style={{ background: 'none', border: 'none', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>Edit</button>
                      <button className="hit44" onClick={() => handleDeleteContact(c.id)} style={{ background: 'none', border: 'none', color: colors.redText, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>Remove</button>
                    </div>
                  ))}

                  {/* Add contact button */}
                  <button className="hit44 glass-btn glass-secondary" onClick={() => setShowAddContact(true)} style={{ width: '100%', padding: '12px', borderRadius: '10px', border: `2px dashed ${colors.creamDark}`, backgroundColor: 'transparent', color: colors.navy, fontWeight: '600', fontSize: 'var(--t-label)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', marginTop: '12px' }}>
                    {Icons.plus(colors.navy, 14)} Add Trusted Contact
                  </button>
                </div>

                {/* Add Contact Modal */}
                {showAddContact && (
                  <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', zIndex: 1000 }}>
                    {/* A four-field form sheet over the safety settings, and
                        until now it moved no focus, answered no Escape and
                        let Tab walk out into the settings list behind it. */}
                    <DialogBehavior
                      onClose={() => { setShowAddContact(false); setEditingContact(null); setNewContact({ name: '', phone: '', email: '', relationship: '' }); }}
                      label={editingContact ? 'Edit contact' : 'Add trusted contact'}
                    />
                    <div style={{ background: 'var(--bg-card-solid)', width: '100%', borderRadius: '20px 20px 0 0', padding: '20px', maxHeight: '80vh', overflowY: 'auto', paddingBottom: 'calc(20px + var(--safe-bottom))' }}>
                      <h3 style={{ fontWeight: '700', fontSize: 'var(--t-title)', color: colors.navy, margin: '0 0 16px' }}>{editingContact ? 'Edit Contact' : 'Add Trusted Contact'}</h3>

                      <div style={{ marginBottom: '10px' }}>
                        <label style={{ display: 'block', fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '4px' }}>Name *</label>
                        <SearchInputLocal aria-label="Contact name" type="text" initialValue={newContact.name} onCommit={(v) => setNewContact(prev => ({ ...prev, name: v }))} placeholder="Contact name" style={{ ...styles.input, width: '100%' }} autoComplete="off" />
                      </div>

                      <div style={{ marginBottom: '10px' }}>
                        <label style={{ display: 'block', fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '4px' }}>Phone Number *</label>
                        <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '0 0 4px' }}>So you can tell your contacts apart. Alerts go out by email; Flock never texts or calls this number.</p>
                        <SearchInputLocal aria-label="Phone number" type="tel" initialValue={newContact.phone} onCommit={(v) => setNewContact(prev => ({ ...prev, phone: v }))} placeholder="+1 234 567 8900" style={{ ...styles.input, width: '100%' }} autoComplete="off" />
                      </div>

                      <div style={{ marginBottom: '10px' }}>
                        <label style={{ display: 'block', fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '4px' }}>Email * <span style={{ fontWeight: '400', color: 'var(--text-tertiary)' }}>(alerts sent here)</span></label>
                        <SearchInputLocal aria-label="Email address" type="email" initialValue={newContact.email} onCommit={(v) => setNewContact(prev => ({ ...prev, email: v }))} placeholder="email@example.com" style={{ ...styles.input, width: '100%' }} autoComplete="off" />
                      </div>

                      <div style={{ marginBottom: '16px' }}>
                        <label style={{ display: 'block', fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '4px' }} htmlFor="contact-relationship">Relationship (optional)</label>
                        <select id="contact-relationship" value={newContact.relationship} onChange={(e) => setNewContact({ ...newContact, relationship: e.target.value })} style={{ ...styles.input, width: '100%', appearance: 'auto' }}>
                          <option value="">Select...</option>
                          <option value="parent">Parent</option>
                          <option value="sibling">Sibling</option>
                          <option value="partner">Partner</option>
                          <option value="friend">Friend</option>
                          <option value="roommate">Roommate</option>
                          <option value="other">Other</option>
                        </select>
                      </div>

                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button className="hit44 glass-btn glass-secondary" onClick={() => { setShowAddContact(false); setEditingContact(null); setNewContact({ name: '', phone: '', email: '', relationship: '' }); }} style={{ flex: 1, padding: '12px', borderRadius: '10px', border: '1px solid var(--border-mid)', backgroundColor: 'var(--bg-card-solid)', fontWeight: '600', fontSize: 'var(--t-body)', cursor: 'pointer', color: colors.navy }}>Cancel</button>
                        <button className="hit44 glass-btn glass-navy" disabled={safetyLoading} onClick={handleSaveContact} style={{ flex: 1, padding: '12px', borderRadius: '10px', border: 'none', background: colors.navyMidBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-body)', cursor: 'pointer', opacity: safetyLoading ? 0.6 : 1 }}>{safetyLoading ? 'Saving...' : editingContact ? 'Save Changes' : 'Add Contact'}</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
            {profileScreen === 'blocked' && (
              <div>
                <div style={{ ...styles.card, display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                  <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'var(--accent-red-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{Icons.ban(colors.red, 18)}</div>
                  <div>
                    <p style={{ fontWeight: '600', fontSize: 'var(--t-label)', color: colors.navy, margin: '0 0 4px' }}>What blocking does</p>
                    {/* Every clause here is something the server actually
                        enforces: mutual invisibility across DMs, messages,
                        invites and friend requests, and the friendship row is
                        deleted outright when the block is created. Unblocking
                        does not put it back, so this must not imply it does. */}
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>Blocked accounts cannot message you or see your activity, and you will not see theirs. Blocking also removes the friendship. Unblocking lets you contact each other again, but it does not add them back as a friend.</p>
                  </div>
                </div>

                {blockedLoading && blockedUsers.length === 0 && (
                  <ListSkeleton count={2} thumb={40} thumbRadius={20} label="Loading blocked accounts" />
                )}

                {!blockedLoading && blockedError && (
                  <div style={styles.card}>
                    <BirdNote
                      layout="row"
                      size={48}
                      role="alert"
                      title={blockedError}
                      body="Nobody has been unblocked. This is the list failing to load, not the list being empty."
                      action={<button className="hit44 glass-btn glass-navy" onClick={loadBlockedUsers} style={{ padding: '10px 16px', borderRadius: '10px', border: 'none', background: colors.navyMidBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-label)', cursor: 'pointer' }}>Try again</button>}
                    />
                  </div>
                )}

                {!blockedLoading && !blockedError && blockedUsers.length === 0 && (
                  <div style={{ ...styles.card, textAlign: 'center', padding: '28px 20px' }}>
                    <BirdieStill bird={WARM_BIRD} size={84} style={{ margin: '0 auto 10px' }} />
                    <p style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: '0 0 4px' }}>You have not blocked anyone</p>
                    {/* Both routes verified against the code they describe: a
                        tap on a message bubble opens the actions row with the
                        report flag in it, and the direct message header menu
                        reads "Report or block". Neither is a long press. */}
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>To block someone, tap one of their messages in a chat and pick the flag, or open the menu at the top of a direct message.</p>
                  </div>
                )}

                {/* Deliberately not gated on blockedError: a failed refresh
                    should not delete the list the user is looking at. The error
                    card sits above it and says the refresh did not land. */}
                {blockedUsers.length > 0 && (
                  <div style={styles.card}>
                    <h2 style={{ fontWeight: '700', fontSize: 'var(--t-title)', color: colors.navy, margin: '0 0 4px' }}>Blocked ({blockedUsers.length})</h2>
                    {blockedUsers.map((b, i) => {
                      const id = String(b.user_id);
                      const busy = unblockingId === id;
                      return (
                        <div key={id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 0', borderBottom: i === blockedUsers.length - 1 ? 'none' : '1px solid var(--border-light)' }}>
                          <div style={{ width: '40px', height: '40px', borderRadius: '20px', backgroundColor: 'var(--icon-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
                            {b.profile_image_url
                              ? <img src={b.profile_image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                              : <span style={{ fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy }}>{b.name?.[0]?.toUpperCase() || '?'}</span>}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name || 'Deleted account'}</p>
                            {b.created_at && <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '2px 0 0' }}>Blocked {new Date(b.created_at).toLocaleDateString()}</p>}
                          </div>
                          {/* The row is only ever removed by a confirmed
                              unblock. A failure leaves it here, still saying
                              Unblock, because the block is still real and a
                              row that vanished would claim otherwise. */}
                          <button
                            className="hit44"
                            // Every row's button reads "Unblock", so on its own
                            // it tells a screen reader nothing about which one.
                            aria-label={`Unblock ${b.name || 'this account'}`}
                            disabled={busy}
                            onClick={() => setUnblockTarget(b)}
                            style={{ padding: '8px 14px', borderRadius: '10px', border: `1px solid ${colors.navy}`, backgroundColor: 'transparent', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1, flexShrink: 0 }}
                          >{busy ? 'Unblocking…' : 'Unblock'}</button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {unblockTarget && (
                  <div onClick={() => { if (!unblockingId) setUnblockTarget(null); }} style={{ position: 'absolute', inset: 0, zIndex: 210, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
                    <DialogBehavior onClose={() => setUnblockTarget(null)} label={`Unblock ${unblockTarget.name || 'this account'}`} />
                    <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: '360px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '18px', padding: '22px', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }}>
                      <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: 'var(--text-primary)', margin: '0 0 8px' }}>Unblock {unblockTarget.name || 'this account'}?</h3>
                      <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', margin: '0 0 18px', lineHeight: 1.5 }}>They will be able to message you and see your activity again. You can block them again at any time.</p>
                      <div style={{ display: 'flex', gap: '10px' }}>
                        <button className="hit44" disabled={!!unblockingId} onClick={() => setUnblockTarget(null)} style={{ flex: 1, padding: '13px', borderRadius: '12px', border: '1px solid var(--border-default)', backgroundColor: 'transparent', color: 'var(--text-secondary)', fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
                        <button className="hit44" disabled={!!unblockingId} onClick={() => handleUnblock(unblockTarget)} style={{ flex: 2, padding: '13px', borderRadius: '12px', border: 'none', background: colors.navyMidBg, color: 'white', fontSize: 'var(--t-label)', fontWeight: '700', cursor: unblockingId ? 'wait' : 'pointer', opacity: unblockingId ? 0.6 : 1 }}>{unblockingId ? 'Unblocking…' : 'Unblock'}</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
            {profileScreen === 'phonediscovery' && (
              <div>
                <div style={styles.card}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
                    <div style={{ width: '36px', height: '36px', borderRadius: '10px', backgroundColor: 'var(--icon-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{Icons.phone(colors.navy, 18)}</div>
                    {/* The privacy policy names this control in exactly these
                        words. A policy that describes a switch nobody can find
                        under that name is not one anybody can act on, so the
                        heading is the policy string verbatim. The settings row
                        that leads here carries the short label, because the
                        list layout gives it about half a line. */}
                    <h2 style={{ flex: 1, minWidth: 0, fontWeight: '700', fontSize: 'var(--t-label)', color: colors.navy, margin: 0, lineHeight: 1.3 }}>Let friends find me by my phone number</h2>
                    <Toggle label="Let friends find me by my phone number" on={!!phoneDiscoverable} onChange={() => { if (!phoneDiscoveryBusy) handleTogglePhoneDiscovery(); }} />
                  </div>
                  {/* Each sentence is something PUT /api/users/phone-discovery
                      does: the match is gated on this flag, the column defaults
                      false, and turning it off erases users.phone_hash rather
                      than only clearing the flag. */}
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.5' }}>People who already have your number in their contacts can find your Flock account. Off until you turn it on. Turning it off erases the code we match against.</p>

                  {phoneDiscoveryError && (
                    <div role="alert" style={{ marginTop: '12px', padding: '10px 12px', borderRadius: '10px', backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)' }}>
                      <p style={{ fontSize: 'var(--t-meta)', color: colors.redText, fontWeight: '600', margin: 0, lineHeight: '1.4' }}>{phoneDiscoveryError}</p>
                    </div>
                  )}

                  {/* The number is added in Edit Profile and nowhere else, so
                      this is a real destination rather than a sentence with no
                      door behind it. Shown before the tap when the account has
                      no number at all, and after it when the server says so. */}
                  {(phoneDiscoveryNeedsNumber || (!profilePhone && phoneDiscoverable === false)) && (
                    <div style={{ marginTop: '12px' }}>
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 8px', lineHeight: '1.4' }}>There is no phone number on your account yet. Add one in Edit Profile and this switch will have something to match against.</p>
                      <button className="hit44 glass-btn glass-secondary" onClick={() => setProfileScreen('edit')} style={{ padding: '10px 16px', borderRadius: '10px', border: `1.5px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer' }}>Go to Edit Profile</button>
                    </div>
                  )}
                </div>
              </div>
            )}
            {profileScreen === 'interests' && (
              <div>
                <div style={styles.card}>
                  <h2 style={{ fontWeight: '700', fontSize: 'var(--t-title)', color: colors.navy, margin: '0 0 12px' }}>Your Interests</h2>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
                    {userInterests.map(interest => (
                      <div key={interest} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', borderRadius: '20px', background: colors.navyMidBg, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '500' }}>
                        {interest}
                        <button aria-label="Remove interest" className="hit44" onClick={(e) => { confirmClick(e); setUserInterests(userInterests.filter(i => i !== interest)); }} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', padding: 0, display: 'flex', position: 'relative', overflow: 'hidden' }}>{Icons.x('rgba(255,255,255,0.7)', 14)}</button>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <SearchInputLocal aria-label="Add an interest" type="text" initialValue={newInterest} onCommit={setNewInterest} placeholder="Add an interest..." style={{ ...styles.input, flex: 1 }} autoComplete="off" />
                    <button className="hit44 glass-btn glass-navy" onClick={(e) => { if (newInterest.trim() && !userInterests.includes(newInterest.trim())) { confirmClick(e); setUserInterests([...userInterests, newInterest.trim()]); setNewInterest(''); }}} style={{ padding: '0 16px', borderRadius: '8px', border: 'none', background: colors.navyMidBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-body)', cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>Add</button>
                  </div>
                </div>
                <div style={styles.card}>
                  <h2 style={{ fontWeight: '700', fontSize: 'var(--t-title)', color: colors.navy, margin: '0 0 12px' }}>Suggested Interests</h2>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                    {suggestedInterests.filter(s => !userInterests.includes(s)).map(interest => (
                      <button key={interest} className="hit44 glass-btn glass-secondary" onClick={(e) => { confirmClick(e); setUserInterests([...userInterests, interest]); }} style={{ padding: '6px 12px', borderRadius: '20px', border: `1px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '500', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', position: 'relative', overflow: 'hidden' }}>
                        {Icons.plus(colors.navy, 12)} {interest}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {profileScreen === 'payment' && (
              <div>
                <div style={styles.card}>
                  <h2 style={{ fontWeight: '700', fontSize: 'var(--t-title)', color: colors.navy, margin: '0 0 4px' }}>Payment Methods</h2>
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 16px' }}>Add your handles so friends can pay you after a hangout</p>

                  {/* Venmo */}
                  <div style={{ marginBottom: '16px' }}>
                    <label style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, marginBottom: '6px', display: 'block' }}>Venmo</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy }}>@</span>
                      <SearchInputLocal aria-label="Venmo username" type="text" initialValue={venmoUsername} onCommit={setVenmoUsername} transform={(v) => v.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50)} placeholder="your-venmo-username" style={{ ...styles.input, flex: 1 }} autoComplete="off" />
                    </div>
                  </div>

                  {/* Cash App */}
                  <div style={{ marginBottom: '16px' }}>
                    <label style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, marginBottom: '6px', display: 'block' }}>Cash App</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy }}>$</span>
                      <SearchInputLocal aria-label="Cash App cashtag" type="text" initialValue={cashappCashtag} onCommit={setCashappCashtag} transform={(v) => v.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 50)} placeholder="your-cashtag" style={{ ...styles.input, flex: 1 }} autoComplete="off" />
                    </div>
                  </div>

                  {/* Zelle */}
                  <div style={{ marginBottom: '16px' }}>
                    <label style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, marginBottom: '6px', display: 'block' }}>Zelle</label>
                    {/* Trimmed, unlike the other two, which strip whitespace
                        already through their character filter. An email or a
                        phone number contains no spaces, and a value of nothing
                        BUT spaces is truthy to the payment-links route, which
                        would build a Zelle method whose handle names nobody. */}
                    <SearchInputLocal aria-label="Zelle email or phone number" type="text" initialValue={zelleIdentifier} onCommit={setZelleIdentifier} transform={(v) => v.trim().slice(0, 255)} placeholder="email or phone number" style={{ ...styles.input, width: '100%', boxSizing: 'border-box' }} autoComplete="off" />
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '4px 0 0' }}>Enter the email or phone registered with your bank for Zelle</p>
                  </div>

                  <button className="hit44 glass-btn glass-primary" disabled={paymentSaving} onClick={async (e) => {
                    confirmClick(e);
                    setPaymentSaving(true);
                    try {
                      await updatePaymentMethods({ venmo_username: venmoUsername, cashapp_cashtag: cashappCashtag, zelle_identifier: zelleIdentifier });
                      // The row this screen reads back from is authUser, which
                      // nothing refreshed, so a saved handle read as blank on
                      // the next visit.
                      onUserUpdated?.({ venmo_username: venmoUsername, cashapp_cashtag: cashappCashtag, zelle_identifier: zelleIdentifier });
                      showToast('Payment methods saved');
                    } catch (err) { if (!needsEmailVerification(err, 'save a payment handle')) showToast(err.message, 'error'); }
                    setPaymentSaving(false);
                  }} style={{ ...styles.gradientButton, marginTop: '4px', opacity: paymentSaving ? 0.5 : 1 }}>
                    {paymentSaving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            )}
          </div>
          {/* There used to be a footer "Save" here on the safety, interests and
              payment screens. It sent nothing: it only navigated back. Safety
              and interests now write the moment you change them, and payment
              has its own real Save inside the card, so the button was a lie
              rather than a feature. Removed; the header arrow goes back. */}
        </div>
      );
    }

    return (
      <div key="profile-main-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--bg-primary)' }}>
        <div style={{ padding: '20px', textAlign: 'center', background: colors.navyBg, flexShrink: 0 }}>
          <button aria-label="Change your profile photo" className="hit44" onClick={() => setShowPicModal(true)} style={{ width: '80px', height: '80px', borderRadius: '40px', margin: '0 auto', backgroundColor: 'rgba(255,255,255,0.2)', border: '4px solid rgba(255,255,255,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', cursor: 'pointer' }}>
            {profilePic ? <img src={profilePic} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : Icons.user('white', 32)}
          </button>
          <button className="hit44" onClick={() => { if (profilePic) { setCropImageSrc(profilePic); setCropZoom(1); setCropOffset({ x: 0, y: 0 }); } else { setShowPicModal(true); } }} style={{ display: 'block', margin: '4px auto 8px', padding: '2px 10px', borderRadius: '6px', border: 'none', backgroundColor: 'transparent', color: 'rgba(255,255,255,0.7)', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>Edit Photo</button>
          <h1 style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.005em', fontSize: 'var(--t-title)', fontWeight: '600', color: 'white', margin: 0 }}>{profileName}</h1>
          <p style={{ fontSize: 'var(--t-meta)', color: 'rgba(255,255,255,0.6)', margin: 0 }}>@{profileHandle}</p>
        </div>

        <div style={{ flex: 1, padding: '12px', overflowY: 'auto', marginTop: '-8px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', marginBottom: '12px' }}>
            {[{ l: 'Flocks', v: flocksError ? '\u2013' : flocks.length }, { l: 'Friends', v: friendCount ?? '\u2013' }, { l: 'Streak', v: streak ?? '\u2013', hasIcon: streak != null }, { l: 'Reliable', v: reliabilityScore != null ? `${Math.round(reliabilityScore)}%` : '–' }].map(s => (
              <div key={s.l} style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '8px', textAlign: 'center', boxShadow: 'var(--card-shadow-sm)' }}>
                <p style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>{s.v}{s.hasIcon && Icons.flame('#F59E0B', 16)}</p>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>{s.l}</p>
              </div>
            ))}
          </div>

          {/* Add Friends Button */}
          <button className="hit44 glass-btn glass-secondary" onClick={() => setCurrentScreen('addFriends')} style={{ width: '100%', padding: '14px', borderRadius: '14px', border: 'none', background: 'var(--bg-card-solid)', color: colors.navy, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px', boxShadow: 'var(--card-shadow-sm)', position: 'relative', overflow: 'hidden' }}>
            {/* The inline navy background on this button has been dead since
                .glass-secondary started forcing a light surface with
                !important (index.css:534), so the row paints cream while the
                icon inside it was still drawn white: an invisible glyph on a
                white-on-cream chip. Repainted in the same language as the
                grouped rows below it, which is the one visual system this
                screen has. */}
            <div style={{ width: '36px', height: '36px', borderRadius: '12px', backgroundColor: 'var(--icon-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.userPlus(colors.navy, 18)}</div>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <span className="shimmer-text" style={{ fontWeight: '600', fontSize: 'var(--t-body)', display: 'block' }}>Add Friends</span>
              {/* This used to drop "contacts" inside the iOS app, which was
                  right while the tab could not exist there and is a lie now
                  that it can. Contacts is reachable on every platform this
                  ships to, so the line names all three ways in. */}
              <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }}>Find people, scan a QR code, check your contacts</span>
            </div>
            {pendingRequests.length > 0 && <span style={{ padding: '4px 10px', borderRadius: '12px', backgroundColor: colors.amber, color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '500' }}>{pendingRequests.length}</span>}
            <span style={{ color: 'var(--text-tertiary)' }}>›</span>
          </button>

          {/* SLOP-AUDIT sec S. Eight identical rows in one container was a
              list that had grown, not been designed: every row carried the
              same weight, so finding one meant reading all eight. Grouped by
              what the rows are about, labels OUTSIDE the containers (rule 4),
              groups separated by page background (rule 3). Rows whose
              destination holds a current value say it inline, grey, left of
              the chevron (rule 2): Payment names the saved handles, Interests
              counts the picks, Blocked accounts counts the list. The screen
              already knows all three. Blocked shows nothing rather than a
              zero it did not measure when the boot-time load failed. The
              labels are --t-label ("section labels" in the scale), not
              --t-micro eyebrows: index.css caps those at two per screen and
              there are three groups here. */}
          {[
            {
              g: 'Account',
              rows: [
                { l: 'Edit Profile', s: 'edit', icon: Icons.edit },
                // The door the welcome screen promised. Owners and admins only.
                ...((authUser?.role === 'venue_owner' || authUser?.role === 'admin') ? [{ l: 'Venue dashboard', s: 'venue', icon: Icons.mapPin }] : []),
                { l: 'Interests', s: 'interests', icon: Icons.target, v: userInterests.length > 0 ? `${userInterests.length} interests` : 'None yet' },
                { l: 'Payment', s: 'payment', icon: Icons.creditCard, v: [authUser?.venmo_username && 'Venmo', authUser?.cashapp_cashtag && 'Cash App', authUser?.zelle_identifier && 'Zelle'].filter(Boolean).join(', ') || 'Not set' },
              ],
            },
            {
              g: 'Safety and privacy',
              rows: [
                { l: 'Safety', s: 'safety', icon: Icons.shield },
                { l: 'Blocked accounts', s: 'blocked', icon: Icons.ban, v: blockedError ? null : (blockedUsers.length > 0 ? `${blockedUsers.length} ${blockedUsers.length === 1 ? 'person' : 'people'}` : 'None') },
                // Nothing in contact discovery can find anybody until this is
                // on, so it is the switch the feature runs on rather than
                // polish. Blank, not 'Off', until the read that knows lands.
                { l: 'Find me by phone', s: 'phonediscovery', icon: Icons.phone, v: phoneDiscoverable === null ? null : (phoneDiscoverable ? 'On' : 'Off') },
              ],
            },
          ].map(group => (
            <div key={group.g} style={{ marginBottom: '16px' }}>
              <h4 style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-tertiary)', margin: '0 0 6px' }}>{group.g}</h4>
              <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', boxShadow: 'var(--card-shadow-sm)', overflow: 'hidden' }}>
                {group.rows.map((m, i) => (
                  <button key={m.s} className="hit44 glass-btn glass-secondary" onClick={() => { if (m.s === 'venue') { openVenueDashboard(); return; } setProfileScreen(m.s); if (m.s === 'safety') loadTrustedContacts(); if (m.s === 'blocked') { setUnblockTarget(null); loadBlockedUsers(); } if (m.s === 'payment') { setVenmoUsername(authUser?.venmo_username || ''); setCashappCashtag(authUser?.cashapp_cashtag || ''); setZelleIdentifier(authUser?.zelle_identifier || ''); } if (m.s === 'phonediscovery') { setPhoneDiscoveryError(''); setPhoneDiscoveryNeedsNumber(false); loadPhoneDiscovery(); } }} style={{ width: '100%', padding: '12px', textAlign: 'left', borderBottom: i < group.rows.length - 1 ? '1px solid var(--border-light)' : 'none', display: 'flex', alignItems: 'center', gap: '12px', backgroundColor: 'var(--bg-card-solid)', border: 'none', cursor: 'pointer' }}>
                    <div style={{ width: '32px', height: '32px', borderRadius: '8px', backgroundColor: 'var(--icon-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{m.icon(colors.navy, 18)}</div>
                    <span style={{ flex: 1, fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy }}>{m.l}</span>
                    {m.v && <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.v}</span>}
                    <span style={{ color: 'var(--text-tertiary)' }}>›</span>
                  </button>
                ))}
              </div>
            </div>
          ))}

          <h4 style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-tertiary)', margin: '0 0 6px' }}>Device</h4>
          <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', boxShadow: 'var(--card-shadow-sm)', overflow: 'hidden' }}>
            {/* Location Toggle */}
            <div style={{ width: '100%', padding: '12px', backgroundColor: 'var(--bg-card-solid)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '32px', height: '32px', borderRadius: '8px', backgroundColor: 'var(--icon-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.mapPin(colors.navy, 18)}</div>
                <div style={{ flex: 1 }}>
                  <span style={{ fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy, display: 'block' }}>Location</span>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }}>{locationEnabled ? 'Venues and maps use your location' : 'Location is turned off'}</span>
                </div>
                <Toggle label="Location services" on={locationEnabled} onChange={() => toggleLocation(!locationEnabled)} />
              </div>
            </div>
            {/* Smart Night Mode */}
            <div style={{ width: '100%', padding: '12px', backgroundColor: 'var(--bg-card-solid)', borderTop: '1px solid var(--border-light)' }}>
              {/* Auto Night Mode toggle */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '32px', height: '32px', borderRadius: '8px', backgroundColor: 'var(--icon-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.moon(colors.navy, 18)}</div>
                <div style={{ flex: 1 }}>
                  <span style={{ fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy, display: 'block' }}>Smart Night Mode</span>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }}>Auto dark at 8 PM, light at 6 AM</span>
                </div>
                <Toggle label="Smart Night Mode" on={themeMode === 'auto'} onChange={() => setAutoMode(themeMode !== 'auto')} />
              </div>
              {/* Night mode active badge */}
              {themeMode === 'auto' && isNightModeActive && (
                <div style={{ marginTop: '8px', marginLeft: '44px', display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '4px 10px', borderRadius: '8px', backgroundColor: 'var(--accent-purple-bg)', fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--accent-purple-text)' }}>
                  {Icons.moon('var(--accent-purple-text)', 12)} Night mode active
                </div>
              )}
              {/* Manual dark mode toggle — only when auto is off */}
              {themeMode !== 'auto' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border-light)' }}>
                  <div style={{ width: '32px', height: '32px', borderRadius: '8px', backgroundColor: 'var(--icon-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{isDark ? Icons.moon(colors.navy, 18) : Icons.sun(colors.navy, 18)}</div>
                  <span style={{ flex: 1, fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy }}>Dark Mode</span>
                  <Toggle label="Dark mode" on={isDark} onChange={toggleTheme} />
                </div>
              )}
            </div>
            {/* Notifications */}
            <div style={{ width: '100%', padding: '12px', backgroundColor: 'var(--bg-card-solid)', borderTop: '1px solid var(--border-light)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '32px', height: '32px', borderRadius: '8px', backgroundColor: 'var(--icon-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.bell(colors.navy, 18)}</div>
                <span style={{ flex: 1, fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy }}>Push Notifications</span>
                {notifStatus === 'granted' ? (
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: '#22c55e' }}>On</span>
                ) : notifStatus === 'denied' || notifStatus === 'unsupported' ? (
                  // THERE IS NO BROWSER IN THE iOS APP, and this said there
                  // was. It is the only state a user can reach where the app
                  // cannot fix itself: iOS gives an app one notification prompt
                  // per install and a denial is permanent, so the only way back
                  // is the OS settings page, and the one line telling them so
                  // was naming a thing that does not exist on the platform this
                  // app ships on. The note under it says where to go, because
                  // "Blocked" on its own is a dead end wearing a status label.
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>
                    {window.Capacitor?.isNativePlatform?.() === true ? 'Blocked in Settings' : 'Blocked in browser'}
                  </span>
                ) : (
                    <button className="hit44 glass-btn glass-secondary" onClick={() => requestNotificationPermission().then((token) => {
                      trackNotificationPermission(token ? 'granted' : getNotificationStatus(), 'settings');
                      // null = denied or registration failed — saying
                      // "enabled" without a registered token was a lie.
                      if (token) { setNotifStatus('granted'); showToast('Notifications enabled!'); }
                      else { setNotifStatus(getNotificationStatus()); showToast("Notifications aren't on. Check your device settings.", 'error'); }
                    }).catch(() => showToast("Notifications aren't on. Check your device settings.", 'error'))} style={{ padding: '6px 12px', borderRadius: '8px', border: `1px solid ${colors.navy}`, backgroundColor: 'var(--icon-bg)', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>Enable</button>
                )}
              </div>
              {notifStatus === 'unsupported' && (
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '6px 0 0 44px', lineHeight: 1.45 }}>This browser cannot show notifications. Install Flock from the App Store to get them.</p>
              )}
              {notifStatus === 'denied' && (
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '4px 0 0 44px', lineHeight: 1.35 }}>
                  {window.Capacitor?.isNativePlatform?.() === true
                    ? 'Turn them back on in the Settings app, under Notifications and then Flock. Flock cannot ask again.'
                    : 'Turn them back on in your browser, under site settings for this page.'}
                </p>
              )}
              {/* Crowd alerts opt-out. This switch controls ONLY the pre-peak
                  crowd push (backend/services/crowdAlerts.js), so the label
                  stays that narrow. The backend treats an absent key as ON. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border-light)' }}>
                <div style={{ width: '32px', height: '32px', borderRadius: '8px', backgroundColor: 'var(--icon-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.users(colors.navy, 18)}</div>
                <div style={{ flex: 1 }}>
                  <span style={{ fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy, display: 'block' }}>Crowd alerts</span>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }}>A heads up before your flock's venue gets busy</span>
                </div>
                <Toggle label="Crowd alerts" on={crowdAlertsOn} onChange={() => setCrowdAlertsEnabled(!crowdAlertsOn)} />
              </div>
            </div>
          </div>

            {/* Flock Pro — hidden until the backend flips PAYWALL_ENABLED (or the user is already Pro) */}
            {(entitlements?.paywallEnabled || isPro) && (
              <button className="hit44 glass-btn glass-secondary" onClick={() => { if (!isPro) setPaywallTrigger('settings'); }} style={{ width: '100%', marginTop: '16px', padding: '12px', textAlign: 'left', borderRadius: '12px', boxShadow: 'var(--card-shadow-sm)', display: 'flex', alignItems: 'center', gap: '12px', backgroundColor: 'var(--bg-card-solid)', border: 'none', cursor: isPro ? 'default' : 'pointer' }}>
                <div style={{ width: '32px', height: '32px', borderRadius: '8px', backgroundColor: 'var(--icon-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.sparkles(colors.navy, 18)}</div>
                <span style={{ flex: 1, fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy }}>Flock Pro</span>
                {isPro ? (
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: '#22c55e' }}>Active</span>
                ) : (
                  <span style={{ color: 'var(--text-tertiary)' }}>›</span>
                )}
              </button>
            )}
            {/* .glass-danger paints this solid red with white text (both !important),
                so the icon must be white too — colors.red on red was invisible. */}
            {/* Every device at once. The server route has existed since the
                token-version claim shipped; nothing in the app reached it. */}
            <button className="hit44 glass-btn glass-secondary" onClick={async () => {
              // The server call is the only thing that signs the other devices
              // out. When it fails, this phone still signs out, and the login
              // screen says which one happened instead of claiming both
              // (settings audit, 2026-09-05).
              let everywhere = true;
              try { await logoutAll(); } catch (_) { everywhere = false; }
              if (onLogout) onLogout(sessionEndCopy ? sessionEndCopy(everywhere ? 'signed_out_everywhere' : 'signed_out_here_only') : undefined);
            }} style={{ width: '100%', minHeight: '44px', marginTop: '16px', padding: '12px', textAlign: 'left', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '12px', border: '1px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-primary)', cursor: 'pointer', fontWeight: '600' }}>
              Sign out everywhere
            </button>
            <button className="hit44 glass-btn glass-danger" onClick={() => { if (onLogout) onLogout(); }} style={{ width: '100%', minHeight: '44px', marginTop: '16px', padding: '12px', textAlign: 'left', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '12px', border: 'none', cursor: 'pointer' }}>
              {Icons.logout('#ffffff', 18)}
              <span style={{ fontWeight: '600', fontSize: 'var(--t-body)' }}>Log Out</span>
            </button>
            {/* Your data, before you decide anything else about the account.
                It sits above Delete on purpose: somebody who has come to this
                part of the screen to leave should see that they can take their
                things with them BEFORE they hit the irreversible one. */}
            <button className="hit44" onClick={() => { setExportPassword(''); setExportError(''); setExportNeedsReauth(false); setShowExportData(true); }} style={{ width: '100%', marginTop: '10px', padding: '12px', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '12px', backgroundColor: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)' }}>
              {Icons.download('var(--text-tertiary)', 18)}
              <span style={{ fontWeight: '600', fontSize: 'var(--t-body)' }}>Get a copy of my data</span>
            </button>

            {/* Delete account (Apple Guideline 5.1.1(v)) — permanent, in-app */}
            <button className="hit44" onClick={() => { setDeleteConfirmText(''); setDeletePassword(''); setDeleteError(''); setDeleteNeedsReauth(false); setShowDeleteAccount(true); }} style={{ width: '100%', marginTop: '10px', padding: '12px', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '12px', backgroundColor: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)' }}>
              {Icons.trash('var(--text-tertiary)', 18)}
              <span style={{ fontWeight: '600', fontSize: 'var(--t-body)' }}>Delete account</span>
            </button>

          {/* Get a copy of my data. Same proof of identity deletion asks for,
              and for a comparable reason: this file is every message, every
              flock and every trusted contact in one place, so a stolen 24h
              token must not be enough to lift it. */}
          {showExportData && (
            <div onClick={() => !exportingData && setShowExportData(false)} style={{ position: 'absolute', inset: 0, zIndex: 210, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
            <DialogBehavior onClose={() => setShowExportData(false)} label="Get a copy of my data" />
              <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: '360px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '18px', padding: '22px', boxShadow: '0 8px 24px rgba(0,0,0,0.15)', fontFamily: "'Hanken Grotesk', -apple-system, BlinkMacSystemFont, sans-serif" }}>
                <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: 'var(--text-primary)', margin: '0 0 8px' }}>Get a copy of my data</h3>
                <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', margin: '0 0 16px', lineHeight: 1.5 }}>A JSON file with your profile, flocks, messages, votes, budgets, reviews, check-ins, friends and trusted contacts. Photos in messages and your profile photo are not included; they stay visible in the app. Our Privacy Policy lists the few things left out and why.</p>
                {/* An Apple or Google account has no password here, and the box
                    invited them to type the one they use with Apple or Google
                    into Flock, which the server then ignored. Only an account
                    that signs in with a password gets the box; the others get
                    the rule, said before the tap. Unknown (an older payload)
                    keeps the box. */}
                {!exportNeedsReauth && authUser?.sign_in_method && authUser.sign_in_method !== 'password' && (
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 12px', lineHeight: 1.5 }}>You sign in with {authUser.sign_in_method === 'apple' ? 'Apple' : 'Google'}. If it has been more than five minutes since you signed in, Flock will ask you to sign in again first.</p>
                )}
                {!exportNeedsReauth && !(authUser?.sign_in_method && authUser.sign_in_method !== 'password') && (
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={exportPassword}
                    onChange={(e) => { setExportPassword(e.target.value); if (exportError) setExportError(''); }}
                    placeholder="Your password"
                    aria-label="Your password"
                    disabled={exportingData}
                    style={{ width: '100%', padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border-mid)', backgroundColor: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 'var(--t-body)', marginBottom: '10px', boxSizing: 'border-box' }}
                  />
                )}
                {exportError && (
                  <p role="alert" style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: '#EF4444', margin: '0 0 10px' }}>{exportError}</p>
                )}
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button className="hit44 glass-btn glass-secondary" disabled={exportingData} onClick={() => setShowExportData(false)} style={{ flex: 1, minHeight: '44px', borderRadius: '10px', border: '1px solid var(--border-mid)', backgroundColor: 'transparent', color: 'var(--text-secondary)', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
                  <button className="hit44 glass-btn glass-primary" disabled={exportingData || exportNeedsReauth} onClick={handleExportData} style={{ flex: 1, minHeight: '44px', borderRadius: '10px', border: 'none', backgroundColor: colors.navy, color: '#ffffff', fontWeight: '700', cursor: exportingData ? 'default' : 'pointer' }}>{exportingData ? 'Preparing…' : 'Get my data'}</button>
                </div>
              </div>
            </div>
          )}
          {/* Delete-account confirmation — requires typing DELETE; hard-delete is irreversible */}
          {showDeleteAccount && (
            <div onClick={() => !deletingAccount && setShowDeleteAccount(false)} style={{ position: 'absolute', inset: 0, zIndex: 210, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
            <DialogBehavior onClose={() => setShowDeleteAccount(false)} label="Delete account" />
              <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: '360px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '18px', padding: '22px', boxShadow: '0 8px 24px rgba(0,0,0,0.15)', fontFamily: "'Hanken Grotesk', -apple-system, BlinkMacSystemFont, sans-serif" }}>
                <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: 'var(--text-primary)', margin: '0 0 8px' }}>Delete your account?</h3>
                <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', margin: '0 0 16px', lineHeight: 1.5 }}>This permanently deletes your account, messages, friends and payment settings. <strong>Any flock you created is deleted for everyone in it</strong>, along with its chat and votes, and they are told it was cancelled. Your direct messages disappear from the other person's app too. A few things are kept, and our Privacy Policy lists them. <strong>This cannot be undone.</strong></p>
                {/* Only once there is a subscription to speak of; Apple expects
                    the sheet to say deletion does not cancel one. */}
                {(entitlements?.paywallEnabled || isPro) && (
                  <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', margin: '0 0 16px', lineHeight: 1.5 }}>Deleting your account does not cancel a Flock Pro subscription. Cancel it first in your Apple ID settings, under Subscriptions.</p>
                )}
                {/* Both inputs below close the keyboard on Return
                    (enterKeyHint done + blur). In WKWebView a tap on a button
                    does not blur a focused field, so without this the
                    keyboard kept covering Cancel and the confirm button;
                    CreateScreen.js does the same for the plan name. */}
                {/* Proof of identity. The server requires the password for a
                    password account and a sign-in inside the last five minutes
                    for an OAuth one, so a stolen token alone can no longer
                    destroy an account. Deletion always stays possible; it just
                    needs proof it is really you. */}
                {!deleteNeedsReauth && authUser?.sign_in_method && authUser.sign_in_method !== 'password' && (
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 14px', lineHeight: 1.5 }}>You sign in with {authUser.sign_in_method === 'apple' ? 'Apple' : 'Google'}. If it has been more than five minutes since you signed in, Flock will ask you to sign in again first.</p>
                )}
                {!deleteNeedsReauth && !(authUser?.sign_in_method && authUser.sign_in_method !== 'password') && (
                  <>
                    <label htmlFor="delete-password" style={{ display: 'block', fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)', margin: '0 0 6px' }}>Your password</label>
                    <input
                      id="delete-password"
                      type="password"
                      autoComplete="current-password"
                      value={deletePassword}
                      onChange={(e) => { setDeletePassword(e.target.value); if (deleteError) setDeleteError(''); }}
                      placeholder="Password"
                      enterKeyHint="done"
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '12px', borderRadius: '12px', border: `1px solid ${deleteError ? '#EF4444' : 'var(--border-default)'}`, backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)', fontSize: 'var(--t-body)', marginBottom: '6px' }}
                    />
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '0 0 14px' }}>Signed in with Google or Apple? Leave this blank.</p>
                  </>
                )}

                {/* This panel answers a server 403 in a destructive flow. It is
                    an alert exactly like its deleteError sibling below: shown
                    but never announced, a screen-reader user heard the Delete
                    button go dead and nothing else. */}
                {deleteNeedsReauth && (
                  <div role="alert" tabIndex={-1} ref={deleteAlertRef} style={{ padding: '12px', borderRadius: '12px', backgroundColor: 'var(--accent-amber-bg)', marginBottom: '14px' }}>
                    <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--accent-amber-text)', margin: '0 0 4px' }}>Sign in again first</p>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--accent-amber-text)', margin: 0, lineHeight: 1.5 }}>Your account uses Google or Apple to sign in, and this session is older than five minutes. Log out, sign back in, then come straight here. Your account can still be deleted.</p>
                  </div>
                )}

                {deleteError && !deleteNeedsReauth && (
                  <p role="alert" tabIndex={-1} ref={deleteAlertRef} style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: '#EF4444', margin: '0 0 14px' }}>{deleteError}</p>
                )}

                <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)', margin: '0 0 6px' }}>Type <strong>DELETE</strong> to confirm</p>
                <input aria-label="Type DELETE to confirm" value={deleteConfirmText} onChange={(e) => setDeleteConfirmText(e.target.value)} placeholder="DELETE" autoCapitalize="characters" enterKeyHint="done" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} style={{ width: '100%', boxSizing: 'border-box', padding: '12px', borderRadius: '12px', border: '1px solid var(--border-default)', backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)', fontSize: 'var(--t-body)', outline: 'none', marginBottom: '16px', fontFamily: 'inherit' }} />
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button className="hit44" onClick={() => setShowDeleteAccount(false)} disabled={deletingAccount} style={{ flex: 1, padding: '13px', borderRadius: '12px', border: '1px solid var(--border-default)', backgroundColor: 'transparent', color: 'var(--text-secondary)', fontSize: 'var(--t-body)', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
                  <button className="hit44"
                    aria-label="Delete account, permanently"
                    disabled={deletingAccount || deleteNeedsReauth || deleteConfirmText.trim().toUpperCase() !== 'DELETE'}
                    onClick={async () => {
                      setDeletingAccount(true);
                      setDeleteError('');
                      try {
                        await deleteAccount(deletePassword || undefined);
                        setShowDeleteAccount(false);
                        // No toast here. setAuthUser(null) unmounts this tree in
                        // the same commit, so a toast raised on it is never
                        // painted. The login screen carries the message instead,
                        // which is the surface that actually survives.
                        if (onLogout) onLogout(sessionEndCopy('account_deleted'));
                      } catch (err) {
                        const reauth = err?.data?.reauthRequired;
                        if (err?.isNetworkError || err?.isTimeout) {
                          // The server commits, cuts the sockets, then answers, so a
                          // reply lost after the commit looked like a failed request
                          // and the next request said the session had expired.
                          let gone = false;
                          try { await getCurrentUser(); } catch (probe) { gone = probe?.status === 401; }
                          if (gone) {
                            clearLocalSession();
                            if (onLogout) onLogout(sessionEndCopy('account_deleted'));
                            return;
                          }
                        }
                        if (err?.status === 429) {
                          // The server names the real window (utils/retryAfter.js
                          // in the backend) and api.js carries that sentence.
                          // This used to write a fixed number of minutes over
                          // it, which was wrong for every lockout but a fresh one.
                          setDeleteError(err?.message || 'Too many tries. Wait a few minutes and try again.');
                        } else if (reauth === 'reauth') {
                          setDeleteNeedsReauth(true);
                          setDeleteError('');
                        } else if (reauth === 'password') {
                          setDeleteError(deletePassword ? 'That password is not right. Try again.' : 'Enter your password to confirm it is you.');
                        } else {
                          setDeleteError(err.message || 'Could not delete account. Try again.');
                        }
                        setDeletingAccount(false);
                      }
                    }}
                    style={{ flex: 1.6, padding: '13px', borderRadius: '12px', border: 'none', backgroundColor: '#EF4444', color: 'white', fontSize: 'var(--t-body)', fontWeight: '600', cursor: (deletingAccount || deleteNeedsReauth || deleteConfirmText.trim().toUpperCase() !== 'DELETE') ? 'not-allowed' : 'pointer', opacity: (deletingAccount || deleteNeedsReauth || deleteConfirmText.trim().toUpperCase() !== 'DELETE') ? 0.5 : 1 }}
                  >{deletingAccount ? 'Deleting…' : 'Delete account'}</button>
                </div>
              </div>
            </div>
          )}

          {/* Admin Access Button - Small and subtle at bottom */}
          {/* Admin Access — admin role only */}
          {authUser?.role === 'admin' && (
            <button className="hit44"
              onClick={() => setShowAdminPrompt(true)}
              style={{
                marginTop: '16px',
                padding: '8px 12px',
                borderRadius: '8px',
                border: `1px dashed ${colors.creamDark}`,
                backgroundColor: 'transparent',
                color: 'var(--text-tertiary)',
                fontSize: 'var(--t-meta)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                justifyContent: 'center'
              }}
            >
              {Icons.settings(colors.textTertiary, 12)} Admin
            </button>
          )}

          {/* Venue Dashboard — venue_owner or admin only */}
          {(authUser?.role === 'venue_owner' || authUser?.role === 'admin') && (
            <button className="hit44"
              onClick={() => setCurrentScreen('venueDashboard')}
              style={{
                marginTop: '8px',
                padding: '8px 12px',
                borderRadius: '8px',
                border: `1px dashed ${colors.creamDark}`,
                backgroundColor: 'transparent',
                color: 'var(--text-tertiary)',
                fontSize: 'var(--t-meta)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                justifyContent: 'center'
              }}
            >
              {Icons.home(colors.textTertiary, 12)} Venue Dashboard
            </button>
          )}

          {/* Switch Mode Button — only show if user has multiple modes */}
          {userMode && (authUser?.role === 'venue_owner' || authUser?.role === 'admin') && (
            <button className="hit44"
              onClick={switchMode}
              style={{
                marginTop: '8px',
                padding: '8px 12px',
                borderRadius: '8px',
                border: '1px solid #EF4444',
                backgroundColor: 'rgba(239,68,68,0.1)',
                color: '#EF4444',
                fontSize: 'var(--t-meta)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                justifyContent: 'center'
              }}
            >
              {Icons.repeat('#EF4444', 12)} Switch Mode (Current: {userMode === 'user' ? 'User' : userMode === 'venue' ? 'Venue' : 'Admin'})
            </button>
          )}

          {/* Legal Links */}
          <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: `1px solid ${colors.creamDark}` }}>
            <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', marginBottom: '12px', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Legal</p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
              <button
                className="hit44 glass-btn glass-secondary" onClick={() => openExternal('https://www.flockcorp.com/terms')}
                style={{
                  padding: '10px 16px',
                  borderRadius: '10px',
                  border: `1px solid ${colors.creamDark}`,
                  backgroundColor: 'var(--bg-card-solid)',
                  color: colors.navy,
                  fontSize: 'var(--t-meta)',
                  fontWeight: '600',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                {Icons.fileText(colors.navy, 14)} Terms of Service
              </button>
              <button
                className="hit44 glass-btn glass-secondary" onClick={() => openExternal('https://www.flockcorp.com/privacy')}
                style={{
                  padding: '10px 16px',
                  borderRadius: '10px',
                  border: `1px solid ${colors.creamDark}`,
                  backgroundColor: 'var(--bg-card-solid)',
                  color: colors.navy,
                  fontSize: 'var(--t-meta)',
                  fontWeight: '600',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                {Icons.shield(colors.navy, 14)} Privacy Policy
              </button>
            </div>
            <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', marginTop: '16px', textAlign: 'center' }}>Flock v1.0.0</p>
          </div>

        </div>

        {SafetyButton()}
        {BottomNav()}
      </div>
    );
}
