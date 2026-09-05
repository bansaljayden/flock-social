/**
 * ADD FRIENDS SCREEN
 *
 * This screen was 474 lines of `App.js`, declared as an arrow function inside
 * `FlockAppInner` and called rather than mounted. It moved out for the same
 * reason the venue owner dashboard did, which is that a single file holding
 * every screen in the product is a file nobody can review. It did NOT move
 * behind `React.lazy`, and that is a decision rather than an oversight.
 *
 * WHY THIS ONE IS A STATIC IMPORT
 *
 * The dashboard is the paid venue product, gated behind a role, and no
 * consumer can reach it, so a chunk fetch costs its audience nothing. Add
 * Friends is the opposite. It is one of the two calls to action on the empty
 * home screen, a brand new account opens it within seconds of signing up, and
 * the phone doing that is usually on a bar network. Three production builds
 * were measured to price it. With the screen in App.js the app chunk gzips to
 * 189,615 bytes. With it here and imported normally, 190,952. With it here and
 * behind React.lazy, 186,520, plus a 5,261 byte chunk fetched the first time
 * anyone opens the screen. So splitting it would save 4.33 kB gzipped, which
 * is a few tens of milliseconds of transfer, in exchange for one more round
 * trip at the exact moment a new account taps Add Friends on a congested
 * network. A round trip there costs hundreds of milliseconds when it works and
 * an empty Suspense fallback when it does not. 4.33 kB does not buy that.
 *
 * The honest other half of that measurement: extracting at all cost 1.31 kB,
 * because 53 prop names appear twice in the output and a property name is one
 * of the few things a minifier cannot rename. That is the price of the
 * parameter list below, and it is worth paying for the reason in the next
 * paragraph.
 *
 * WHY EVERYTHING ARRIVES AS A PROP
 *
 * The old arrow function closed over 53 names in `FlockAppInner`: state, setters,
 * handlers, and three module-level components that `App.js` shares with screens
 * other than this one. A context would have had to enumerate exactly the same
 * 53 names into a provider value, so it buys nothing and hides the dependency
 * surface behind a hook. They are parameters instead, so the whole dependency
 * surface of this file is its parameter list plus its imports, and a name this
 * component reads and does not receive is an undefined identifier that
 * `no-undef` fails the build on, rather than a prop that is silently
 * `undefined` at runtime and renders as nothing.
 *
 * The state and the effects behind these props deliberately did NOT move. They
 * live in `FlockAppInner`, which does not unmount when the user leaves this
 * screen, so a typed search, a contacts result and a pending friend request
 * survive a trip elsewhere exactly as they did before.
 *
 * Nothing about the contacts flow changed. The system permission prompt still
 * fires only from the "Check my contacts" tap and never from an effect,
 * because iOS asks once per install and a denial stands until the person walks
 * into Settings. The four states of that tab, and the `contactsSupported`
 * fallback that redirects the tab when the plugin is absent, are the same lines
 * they were.
 *
 * The body below is the old block verbatim, including its original four-space
 * indentation, so it can be diffed against the deleted lines character for
 * character. Nothing was renamed, reformatted or improved on the way across.
 */
import React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { BirdieStill, BirdNote, WARM_BIRD } from '../components/ui/BirdieBird';
import Icons from '../components/ui/Icons';

export default function AddFriends({
  // Module-level helpers and components that live in App.js and are shared
  // with screens that are not this one, so they stay there and come in here.
  DialogBehavior,
  ListSkeleton,
  SearchInputLocal,
  // Everything else is declared in FlockAppInner and stays declared there.
  BottomNav,
  addFriendsError,
  addFriendsResults,
  addFriendsSearch,
  addFriendsSearching,
  addFriendsTab,
  colors,
  confirmClick,
  contactsDenied,
  contactsLoading,
  contactsResult,
  contactsSupported,
  contactsUnavailable,
  contactsUsers,
  friendCodeInput,
  friendCodeLoading,
  friendStatuses,
  friendSuggestions,
  friendSuggestionsError,
  handleAcceptFriendRequest,
  handleAddByCode,
  handleAddFriendsSearch,
  handleCancelOutgoingRequest,
  handleDeclineFriendRequest,
  handleInviteFriend,
  handleLookupByNumber,
  handleSendFriendRequest,
  handleSyncContacts,
  loadAddFriendsData,
  myFriendCode,
  openUserProfile,
  outgoingRequests,
  pendingRequests,
  pendingRequestsError,
  phoneLookupError,
  phoneLookupInput,
  phoneLookupLoading,
  phoneLookupUsers,
  qrScanError,
  qrScannerDivId,
  setAddFriendsResults,
  setAddFriendsSearch,
  setAddFriendsTab,
  setCurrentScreen,
  setFriendCodeInput,
  setPhoneLookupError,
  setPhoneLookupInput,
  setPhoneLookupUsers,
  showQrScanner,
  showToast,
  startNewDmWithUser,
  startQrScanner,
  stopQrScanner,
  styles,
}) {
    // Contacts only appears where an address book can actually be read. See
    // contactsAvailable() in services/contacts.js, which is true inside the iOS
    // app and false in a desktop browser without the Contacts Picker.
    const tabs = [
      { id: 'username', label: 'Search', icon: Icons.search },
      { id: 'suggestions', label: 'Quick Add', icon: Icons.users },
      { id: 'qr', label: 'QR', icon: Icons.layers },
      ...(contactsSupported ? [{ id: 'contacts', label: 'Contacts', icon: Icons.phone }] : []),
    ];
    // A tab that is not on screen must not be the one rendering. Nothing sets
    // addFriendsTab to 'contacts' except pressing the tab, but this keeps a
    // future deep link from landing on an empty pane.
    const activeTab = addFriendsTab === 'contacts' && !contactsSupported ? 'username' : addFriendsTab;

    return (
      <div key="add-friends-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--bg-primary)' }}>
        {/* Header */}
        <div style={{ padding: '16px', background: colors.navyBg, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
            <button aria-label="Back" className="hit44" onClick={() => setCurrentScreen('main')} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.arrowLeft('white', 18)}</button>
            <h1 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: 'white', margin: 0, flex: 1 }}>Add Friends</h1>
            {pendingRequests.length > 0 && (
              <span style={{ padding: '4px 10px', borderRadius: '12px', backgroundColor: colors.amber, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '500' }}>{pendingRequests.length} new</span>
            )}
          </div>

          {/* Tab Navigation */}
          <div style={{ display: 'flex', gap: '4px', paddingBottom: '2px' }}>
            {tabs.map(tab => (
              <button className="hit44" key={tab.id} onClick={() => setAddFriendsTab(tab.id)} style={{
                flex: 1, padding: '8px 4px', borderRadius: '16px', border: 'none', cursor: 'pointer', fontSize: 'var(--t-meta)', fontWeight: '600', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px', transition: 'opacity 0.2s ease',
                backgroundColor: activeTab === tab.id ? 'white' : 'rgba(255,255,255,0.15)',
                color: activeTab === tab.id ? colors.navy : 'rgba(255,255,255,0.8)',
              }}>
                {tab.icon(activeTab === tab.id ? colors.navy : 'rgba(255,255,255,0.8)', 16)}
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>

          {/* A failed read of the requests is said, with a retry, and never
              rendered as "no requests" (friends audit, 2026-09-05). Plain
              text, no bird: an error must not read like an empty inbox. */}
          {pendingRequestsError && (
            <div role="status" style={{ marginBottom: '16px', padding: '10px 12px', borderRadius: '8px', backgroundColor: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>{pendingRequestsError}</p>
              <button className="hit44" onClick={() => loadAddFriendsData()} style={{ padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border-mid)', backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer', flexShrink: 0 }}>Try again</button>
            </div>
          )}

          {/* Pending Friend Requests (always visible at top if any) */}
          {pendingRequests.length > 0 && (
            <div style={{ marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                <div style={{ width: '28px', height: '28px', borderRadius: '14px', backgroundColor: 'var(--accent-amber-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.userPlus('var(--accent-amber-text)', 14)}</div>
                <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: 0 }}>Friend Requests</h2>
                <span style={{ padding: '2px 8px', borderRadius: '10px', backgroundColor: colors.amber, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '500' }}>{pendingRequests.length}</span>
              </div>
              {pendingRequests.map(req => (
                <div key={req.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px', borderRadius: '14px', backgroundColor: 'var(--bg-card-solid)', marginBottom: '8px', border: `1.5px solid #fde68a`, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                  {/* An incoming request from a stranger is one of the places
                      someone most needs the block, and there is no content to
                      hang it off. The face opens the person card. */}
                  <button className="hit44" aria-label={`About ${req.name}`} onClick={() => openUserProfile({ id: req.id, name: req.name, image: req.profile_image_url })} style={{ width: '44px', height: '44px', borderRadius: '22px', backgroundColor: colors.navyMidBg, border: 'none', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-body)', fontWeight: '600', color: 'white', flexShrink: 0, cursor: 'pointer' }}>
                    {req.profile_image_url ? <img src={req.profile_image_url} alt="" style={{ width: '44px', height: '44px', borderRadius: '22px', objectFit: 'cover' }} /> : req.name[0]?.toUpperCase()}
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy, margin: 0 }}>{req.name}</p>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '2px 0 0' }}>Wants to be your friend</p>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                    {/* Ripple container clips overflow, so .hit44's pseudo hit area
                        would be clipped — this pair gets the real 44px box. */}
                    <button aria-label="Accept friend request" onClick={(e) => { confirmClick(e); handleAcceptFriendRequest(req.id); }} style={{ width: '44px', height: '44px', borderRadius: '22px', border: 'none', backgroundColor: '#047857', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>{Icons.check('white', 18)}</button>
                    <button aria-label="Decline friend request" className="hit44" onClick={() => handleDeclineFriendRequest(req.id)} style={{ width: '36px', height: '36px', borderRadius: '18px', border: 'none', backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x(colors.textSecondary, 16)}</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Outgoing Requests */}
          {outgoingRequests.length > 0 && activeTab === 'username' && (
            <div style={{ marginBottom: '16px' }}>
              <h4 style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-tertiary)', margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Sent Requests</h4>
              {outgoingRequests.map(req => (
                <div key={req.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px', borderRadius: '12px', backgroundColor: 'var(--bg-card-solid)', marginBottom: '6px' }}>
                  <button className="hit44" aria-label={`About ${req.name}`} onClick={() => openUserProfile({ id: req.id, name: req.name, image: req.profile_image_url })} style={{ width: '38px', height: '38px', borderRadius: '19px', backgroundColor: colors.navyMidBg, border: 'none', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-body)', fontWeight: '600', color: 'white', flexShrink: 0, cursor: 'pointer' }}>
                    {req.profile_image_url ? <img src={req.profile_image_url} alt="" style={{ width: '38px', height: '38px', borderRadius: '19px', objectFit: 'cover' }} /> : req.name[0]?.toUpperCase()}
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontWeight: '600', fontSize: 'var(--t-label)', color: colors.navy, margin: 0 }}>{req.name}</p>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '1px 0 0' }}>Pending</p>
                  </div>
                  <button className="hit44 glass-btn glass-secondary" onClick={() => handleCancelOutgoingRequest(req.id)} style={{ padding: '6px 12px', borderRadius: '16px', border: `1px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-secondary)', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
                </div>
              ))}
            </div>
          )}

          {/* TAB: Add by Name */}
          {activeTab === 'username' && (
            <div>
              <div style={{ position: 'relative', marginBottom: '12px' }}>
                <SearchInputLocal aria-label="Search by name" type="text" initialValue={addFriendsSearch} onCommit={handleAddFriendsSearch} placeholder="Search by name..." autoComplete="off"
                  style={{ width: '100%', padding: '12px 12px 12px 38px', borderRadius: '14px', border: `1.5px solid ${addFriendsSearch ? colors.navy : colors.borderDefault}`, fontSize: 'var(--t-body)', outline: 'none', boxSizing: 'border-box', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-primary)', fontWeight: '500', transition: 'opacity 0.2s ease' }}
                />
                <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }}>{Icons.search(addFriendsSearch ? colors.navy : colors.textTertiary, 16)}</span>
                {addFriendsSearch && <button aria-label="Clear search" className="hit44" onClick={() => handleAddFriendsSearch('')} style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>{Icons.x(colors.textTertiary, 14)}</button>}
              </div>

              {addFriendsSearching && (
                <div style={{ textAlign: 'center', padding: '24px 0' }}>
                  <div style={{ display: 'inline-block', width: '18px', height: '18px', border: `2px solid ${colors.creamDark}`, borderTopColor: colors.navy, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '8px 0 0' }}>Searching...</p>
                </div>
              )}

              {/* A network or server failure, in the server's own words, rather
                  than "No users found" drawn over a search that never ran. The
                  value is set in App.js's handleAddFriendsSearch catch and
                  arrives through addFriendsProps. */}
              {!addFriendsSearching && addFriendsError && (
                <BirdNote layout="row" size={48} role="status" body={addFriendsError} style={{ padding: '16px 8px' }} />
              )}

              {!addFriendsSearching && !addFriendsError && addFriendsSearch.trim().length >= 1 && addFriendsResults.length === 0 && (
                <BirdNote size={64} title={`No users found for "${addFriendsSearch}"`} />
              )}

              {!addFriendsSearching && addFriendsResults.map(user => {
                const status = friendStatuses[user.id] || 'none';
                return (
                  <div key={user.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px', borderRadius: '14px', backgroundColor: 'var(--bg-card-solid)', marginBottom: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                    <button className="hit44" aria-label={`About ${user.name}`} onClick={() => openUserProfile({ id: user.id, name: user.name, image: user.profile_image_url })} style={{ width: '44px', height: '44px', borderRadius: '22px', backgroundColor: colors.navyMidBg, border: 'none', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-body)', fontWeight: '600', color: 'white', flexShrink: 0, cursor: 'pointer' }}>
                      {user.profile_image_url ? <img src={user.profile_image_url} alt="" style={{ width: '44px', height: '44px', borderRadius: '22px', objectFit: 'cover' }} /> : user.name[0]?.toUpperCase()}
                    </button>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy, margin: 0 }}>{user.name}</p>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                      {status === 'accepted' ? (
                        <span style={{ padding: '6px 14px', borderRadius: '20px', backgroundColor: 'var(--accent-green-bg)', color: 'var(--accent-green-text)', fontSize: 'var(--t-meta)', fontWeight: '500' }}>Friends</span>
                      ) : status === 'pending' ? (
                        <span style={{ padding: '6px 14px', borderRadius: '20px', backgroundColor: 'var(--pill-bg)', color: 'var(--text-secondary)', fontSize: 'var(--t-meta)', fontWeight: '500' }}>Pending</span>
                      ) : (
                        <button className="hit44 glass-btn glass-navy" onClick={(e) => { confirmClick(e); handleSendFriendRequest(user); }} style={{ padding: '8px 16px', borderRadius: '20px', border: 'none', background: colors.navyBg, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>Add</button>
                      )}
                      <button aria-label="Message" className="hit44 glass-btn glass-secondary" onClick={() => { setCurrentScreen('main'); startNewDmWithUser(user); }} style={{ padding: '8px 12px', borderRadius: '20px', border: `1.5px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>{Icons.messageSquare(colors.navy, 14)}</button>
                    </div>
                  </div>
                );
              })}

              {!addFriendsSearch && (
                /* This is the default tab of the screen the home empty state
                   sends a new account to, so it is one of the first things
                   anybody sees, and it was an icon in a rounded square, which
                   is the bubble-tile shape SLOP-AUDIT A14 bans and the one
                   empty state on this screen with no bird on it. */
                <BirdNote
                  bird={WARM_BIRD}
                  size={96}
                  title="Find people you know"
                  body="Search by the name they signed up with."
                  style={{ padding: '32px 16px 16px' }}
                />
              )}
            </div>
          )}

          {/* TAB: Quick Add / Suggestions */}
          {activeTab === 'suggestions' && (
            <div>
              {/* Same rule as the requests above: a failed read is its own
                  sentence with a retry, and the empty state below is
                  suppressed while it stands, because "No suggestions yet"
                  over a read that never landed told a person with twenty
                  friends they had none (friends audit, 2026-09-05). */}
              {friendSuggestionsError && (
                <div role="status" style={{ padding: '10px 12px', borderRadius: '8px', backgroundColor: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>{friendSuggestionsError}</p>
                  <button className="hit44" onClick={() => loadAddFriendsData()} style={{ padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border-mid)', backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer', flexShrink: 0 }}>Try again</button>
                </div>
              )}
              {friendSuggestionsError ? null : friendSuggestions.length === 0 ? (
                /* Quick Add is mutual friends only, so it is empty by
                   construction for a new account. The old copy told that
                   account to "add more friends to see people you may know",
                   which is the one thing it cannot do yet and reads as a
                   reprimand on day one. Say why the tab is empty instead, and
                   keep the button pointing at the tab that can find somebody
                   now. Same bubble-tile and missing-bird fix as the state
                   above it. */
                <BirdNote
                  bird={WARM_BIRD}
                  size={96}
                  title="No suggestions yet"
                  body="Quick Add shows people your friends already know, so it starts working once you have a friend or two here."
                  action={(
                    <button className="hit44 glass-btn glass-navy" onClick={(e) => { confirmClick(e); setAddFriendsTab(contactsSupported ? 'contacts' : 'username'); }}
                      style={{ padding: '12px 24px', borderRadius: '12px', border: 'none', background: colors.navyBg, color: 'white', fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>
                      {contactsSupported ? 'Check your contacts' : 'Search for people'}
                    </button>
                  )}
                  style={{ padding: '32px 16px 16px' }}
                />
              ) : (
                <>
                  <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.zap(colors.amber, 16)} Quick Add</h2>
                  {friendSuggestions.map(user => {
                    const status = friendStatuses[user.id] || 'none';
                    return (
                      <div key={user.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px', borderRadius: '14px', backgroundColor: 'var(--bg-card-solid)', marginBottom: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                        <button className="hit44" aria-label={`About ${user.name}`} onClick={() => openUserProfile({ id: user.id, name: user.name, image: user.profile_image_url })} style={{ width: '44px', height: '44px', borderRadius: '22px', backgroundColor: colors.navyMidBg, border: 'none', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-body)', fontWeight: '600', color: 'white', flexShrink: 0, cursor: 'pointer' }}>
                          {user.profile_image_url ? <img src={user.profile_image_url} alt="" style={{ width: '44px', height: '44px', borderRadius: '22px', objectFit: 'cover' }} /> : user.name[0]?.toUpperCase()}
                        </button>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy, margin: 0 }}>{user.name}</p>
                          <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0' }}>{user.shared_flocks != null
                            ? `${user.shared_flocks} plan${parseInt(user.shared_flocks) !== 1 ? 's' : ''} together`
                            : `${user.mutual_count} mutual friend${parseInt(user.mutual_count) !== 1 ? 's' : ''}`}</p>
                        </div>
                        {status === 'accepted' ? (
                          <span style={{ padding: '6px 14px', borderRadius: '20px', backgroundColor: 'var(--accent-green-bg)', color: 'var(--accent-green-text)', fontSize: 'var(--t-meta)', fontWeight: '500' }}>Friends</span>
                        ) : status === 'pending' ? (
                          <span style={{ padding: '6px 14px', borderRadius: '20px', backgroundColor: 'var(--pill-bg)', color: 'var(--text-secondary)', fontSize: 'var(--t-meta)', fontWeight: '500' }}>Pending</span>
                        ) : (
                          <button className="hit44 glass-btn glass-navy" onClick={(e) => { confirmClick(e); handleSendFriendRequest(user); }} style={{ padding: '8px 16px', borderRadius: '20px', border: 'none', background: colors.navyBg, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>Add</button>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}

          {/* TAB: QR Code */}
          {activeTab === 'qr' && (
            <div>
              {/* My QR Code */}
              <div style={{ textAlign: 'center', padding: '20px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '20px', marginBottom: '16px', boxShadow: '0 2px 12px rgba(0,0,0,0.08)' }}>
                <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 4px' }}>My Flock Code</h2>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '0 0 16px' }}>Friends can scan this to add you</p>
                <div style={{ display: 'inline-block', padding: '16px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '16px', border: `3px solid ${colors.cream}` }}>
                  {myFriendCode ? (
                    <QRCodeSVG value={JSON.stringify({ type: 'flock_friend', code: myFriendCode })} size={180} level="H" bgColor="white" fgColor={colors.navy} />
                  ) : (
                    <div style={{ width: '180px', height: '180px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <div style={{ width: '20px', height: '20px', border: `2px solid ${colors.creamDark}`, borderTopColor: colors.navy, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                    </div>
                  )}
                </div>
                {myFriendCode && (
                  <div style={{ marginTop: '14px' }}>
                    <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Your Code</p>
                    <button className="hit44 glass-btn glass-secondary" onClick={() => { navigator.clipboard?.writeText(myFriendCode); showToast('Code copied!'); }} style={{ padding: '8px 20px', borderRadius: '10px', border: `2px solid ${colors.cream}`, backgroundColor: 'var(--icon-bg)', color: colors.navy, fontSize: 'var(--t-body)', fontWeight: '600', cursor: 'pointer', letterSpacing: '2px', fontFamily: 'monospace' }}>{myFriendCode}</button>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '6px 0 0' }}>Tap to copy</p>
                  </div>
                )}
              </div>

              {/* Scan button */}
              <button className="hit44 glass-btn glass-navy" onClick={startQrScanner} style={{ width: '100%', padding: '14px', borderRadius: '14px', border: 'none', background: colors.navyBg, color: 'white', fontSize: 'var(--t-body)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '16px', boxShadow: '0 4px 12px rgba(13,40,71,0.10)' }}>
                {Icons.camera('white', 18)} Scan a Friend's Code
              </button>

              {/* Enter friend's code */}
              <div style={{ padding: '16px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '16px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
                <h4 style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: '0 0 4px' }}>Or Enter Code Manually</h4>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '0 0 10px' }}>Ask your friend for their Flock code</p>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input aria-label="Friend code" type="text" value={friendCodeInput} onChange={(e) => setFriendCodeInput(e.target.value.toUpperCase())} placeholder="FLOCK-XXXX" maxLength={15}
                    style={{ flex: 1, padding: '12px', borderRadius: '12px', border: `1.5px solid ${friendCodeInput ? colors.navy : colors.borderDefault}`, fontSize: 'var(--t-body)', fontWeight: '600', fontFamily: 'monospace', letterSpacing: '1px', outline: 'none', boxSizing: 'border-box', textAlign: 'center' }}
                  />
                  <button className="hit44 glass-btn glass-navy" onClick={(e) => { if (!friendCodeLoading) { confirmClick(e); handleAddByCode(); } }} disabled={friendCodeLoading || !friendCodeInput.trim()}
                    style={{ padding: '12px 20px', borderRadius: '12px', border: 'none', background: friendCodeInput.trim() ? colors.navyBg : 'var(--pill-bg)', color: friendCodeInput.trim() ? 'white' : 'var(--text-tertiary)', fontSize: 'var(--t-body)', fontWeight: '600', cursor: friendCodeInput.trim() ? 'pointer' : 'default', position: 'relative', overflow: 'hidden', opacity: friendCodeLoading ? 0.7 : 1 }}>
                    {friendCodeLoading ? '...' : 'Add'}
                  </button>
                </div>
              </div>

              {/* QR Scanner Modal */}
              {showQrScanner && (
                <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.95)', zIndex: 1000, display: 'flex', flexDirection: 'column' }}>
            <DialogBehavior onClose={() => stopQrScanner()} label="Scan Flock code" />
                  {/* Fixed overlay covers the Dynamic Island: pad the header by the top inset. */}
                  <div style={{ padding: 'calc(16px + var(--safe-top)) 16px 16px', display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
                    <button aria-label="Close" className="hit44" onClick={stopQrScanner} style={{ width: '36px', height: '36px', borderRadius: '18px', border: 'none', backgroundColor: 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('white', 18)}</button>
                    <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: 'white', margin: 0 }}>Scan Flock Code</h3>
                  </div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
                    <div id={qrScannerDivId} style={{ width: '100%', maxWidth: '340px', borderRadius: '20px', overflow: 'hidden' }} />
                    {qrScanError && (
                      <div role="alert" style={{ marginTop: '16px', padding: '10px 20px', borderRadius: '12px', backgroundColor: 'rgba(239,68,68,0.2)', border: '1px solid rgba(239,68,68,0.4)' }}>
                        <p style={{ fontSize: 'var(--t-label)', color: '#fca5a5', margin: 0, textAlign: 'center' }}>{qrScanError}</p>
                      </div>
                    )}
                    <p style={{ fontSize: 'var(--t-label)', color: 'rgba(255,255,255,0.5)', marginTop: '20px', textAlign: 'center' }}>Point your camera at a Flock QR code</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB: Contacts */}
          {/* ------------------------------------------------------------------
              This tab has four states and every one of them is load-bearing.

              1. BEFORE THE TAP. This screen IS the pre-prompt. iOS asks for the
                 address book once per install and a denial stands until the
                 person walks into Settings, so the explanation has to come
                 before the system dialog rather than after it. Nothing on this
                 screen speaks to the contacts service until the button is
                 pressed.
              2. DENIED. One sentence saying where the switch is, the typed
                 number field underneath it, and no second prompt. Asking again
                 cannot work, so asking again would only be nagging.
              3. MATCHES. Flock name and photo, nothing else. The server never
                 says which uploaded number produced which person, and a row
                 that named the contact would rebuild the enumeration oracle
                 that refusal exists to prevent.
              4. NOBODY MATCHED, which is the ordinary answer at launch. It uses
                 the counts, because "no Flock users found" is a claim about
                 every number on the phone and a throttled run only looked at
                 some of them.
              ------------------------------------------------------------------ */}
          {activeTab === 'contacts' && (() => {
            const matched = !!contactsResult && contactsUsers.length > 0;
            const emptyAfterCheck = !!contactsResult && contactsUsers.length === 0;
            // True when the phone held more numbers than this run reached, for
            // either reason: the hourly allowance ran out, or the book is
            // bigger than one run can cover.
            const partial = !!contactsResult && (contactsResult.throttled || contactsResult.checked < contactsResult.total);

            const personRow = (user, subtitle) => {
              const status = friendStatuses[user.id] || user.friendship_status || 'none';
              return (
                <div key={user.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px', borderRadius: '14px', backgroundColor: 'var(--bg-card-solid)', marginBottom: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                  <button className="hit44" aria-label={`About ${user.name}`} onClick={() => openUserProfile({ id: user.id, name: user.name, image: user.profile_image_url })} style={{ width: '44px', height: '44px', borderRadius: '22px', backgroundColor: colors.navyMidBg, border: 'none', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-body)', fontWeight: '600', color: 'white', flexShrink: 0, cursor: 'pointer' }}>
                    {user.profile_image_url ? <img src={user.profile_image_url} alt="" style={{ width: '44px', height: '44px', borderRadius: '22px', objectFit: 'cover' }} /> : user.name[0]?.toUpperCase()}
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy, margin: 0 }}>{user.name}</p>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0' }}>{subtitle}</p>
                  </div>
                  {status === 'accepted' ? (
                    <span style={{ padding: '6px 14px', borderRadius: '20px', backgroundColor: 'var(--accent-green-bg)', color: 'var(--accent-green-text)', fontSize: 'var(--t-meta)', fontWeight: '500' }}>Friends</span>
                  ) : status === 'pending' ? (
                    <span style={{ padding: '6px 14px', borderRadius: '20px', backgroundColor: 'var(--pill-bg)', color: 'var(--text-secondary)', fontSize: 'var(--t-meta)', fontWeight: '500' }}>Pending</span>
                  ) : (
                    <button className="hit44 glass-btn glass-navy" onClick={(e) => { confirmClick(e); handleSendFriendRequest(user); }} style={{ padding: '8px 16px', borderRadius: '20px', border: 'none', background: colors.navyBg, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>Add</button>
                  )}
                </div>
              );
            };

            const checkAgainButton = (
              <button className="hit44 glass-btn glass-secondary" onClick={(e) => { confirmClick(e); handleSyncContacts(); }} disabled={contactsLoading} style={{ width: '100%', padding: '12px', borderRadius: '12px', border: `1.5px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer', marginTop: '8px', position: 'relative', overflow: 'hidden' }}>Check again</button>
            );

            return (
              <div>
                {/* The list is feed-shaped, so the wait draws the layout it is
                    about to fill rather than a spinner (SLOP-AUDIT rule 10). */}
                {contactsLoading && (
                  <ListSkeleton count={3} thumb={44} thumbRadius={22} label="Checking your contacts" />
                )}

                {!contactsLoading && contactsDenied && (
                  <div style={styles.card}>
                    <BirdNote
                      layout="row"
                      size={48}
                      bird={WARM_BIRD}
                      title="Contacts are turned off for Flock"
                      body="Flock does not have permission to read your contacts. You can turn it on in Settings, under Flock, or add someone by their number below."
                    />
                  </div>
                )}

                {!contactsLoading && !contactsDenied && contactsUnavailable && (
                  <div style={styles.card}>
                    <p style={{ fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy, margin: '0 0 4px' }}>This device has no address book Flock can read</p>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.5' }}>Add someone by their number below instead.</p>
                  </div>
                )}

                {/* STATE 1: before the tap. Nothing above this line has spoken
                    to the contacts service, so the system prompt has not fired
                    and cannot fire until the button below is pressed. */}
                {!contactsLoading && !contactsDenied && !contactsUnavailable && !contactsResult && (
                  <div style={styles.card}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
                      <div style={{ width: '40px', height: '40px', borderRadius: '12px', backgroundColor: 'var(--icon-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{Icons.phone(colors.navy, 20)}</div>
                      <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: 0 }}>Find friends from your contacts</h2>
                    </div>
                    {/* Every clause here is something services/contacts.js and
                        backend/routes/friends.js actually do: the projection is
                        phones only, matching is gated on the other person's own
                        opt-in, and a number belonging to a non-user is never
                        written down. */}
                    <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', margin: '0 0 14px', lineHeight: '1.5' }}>Flock sends only phone numbers, checks them against people who chose to be findable, and keeps nothing. Names and everything else stay on your phone.</p>
                    <button className="hit44 glass-btn glass-navy" onClick={(e) => { confirmClick(e); handleSyncContacts(); }} disabled={contactsLoading}
                      style={{ width: '100%', padding: '14px', borderRadius: '14px', border: 'none', background: colors.navyBg, color: 'white', fontSize: 'var(--t-body)', fontWeight: '600', cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>
                      Check my contacts
                    </button>
                  </div>
                )}

                {/* STATE 3: matches. Flock name and photo only. */}
                {!contactsLoading && !contactsDenied && matched && (
                  <>
                    <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 4px' }}>Contacts on Flock</h2>
                    {partial ? (
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 10px' }}>We checked {contactsResult.checked} of your {contactsResult.total} numbers. Try the rest in an hour.</p>
                    ) : (
                      <div style={{ height: '6px' }} />
                    )}
                    {contactsUsers.map(user => personRow(user, 'From your contacts'))}
                    {checkAgainButton}
                  </>
                )}

                {/* STATE 4: nobody matched. The counts, not a claim about the
                    whole address book. */}
                {!contactsLoading && !contactsDenied && emptyAfterCheck && (
                  <div style={{ ...styles.card, textAlign: 'center', padding: '24px 20px' }}>
                    <BirdieStill bird={WARM_BIRD} size={84} style={{ margin: '0 auto 10px' }} />
                    <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', margin: '0 0 4px', lineHeight: '1.5' }}>
                      {contactsResult.total === 0
                        ? 'None of your contacts have a phone number Flock can check. Add someone by their number below.'
                        : partial
                          ? `We checked ${contactsResult.checked} of your ${contactsResult.total} numbers and none of them are on Flock yet. Try the rest in an hour.`
                          : `None of the ${contactsResult.checked} numbers we checked are on Flock yet. Invite someone below and they will show up here.`}
                    </p>
                    {checkAgainButton}
                  </div>
                )}

                {/* BY NUMBER. The half that needs no permission and no plugin,
                    so it works on every platform and in every one of the states
                    above, including the one where the address book is closed
                    for good. */}
                <div style={styles.card}>
                  <h3 style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: '0 0 4px' }}>By number</h3>
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '0 0 10px' }}>Add one person with the number you already have for them</p>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input aria-label="Phone number" type="tel" inputMode="tel" autoComplete="tel" value={phoneLookupInput}
                      onChange={(e) => { setPhoneLookupInput(e.target.value); setPhoneLookupError(''); setPhoneLookupUsers(null); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !phoneLookupLoading) handleLookupByNumber(); }}
                      placeholder="(555) 555-0123" maxLength={20}
                      style={{ flex: 1, padding: '12px', borderRadius: '12px', border: `1.5px solid ${phoneLookupInput ? colors.navy : colors.borderDefault}`, fontSize: 'var(--t-body)', fontWeight: '600', outline: 'none', boxSizing: 'border-box', backgroundColor: 'var(--bg-input)', color: 'var(--text-primary)' }}
                    />
                    <button className="hit44 glass-btn glass-navy" onClick={(e) => { if (!phoneLookupLoading && phoneLookupInput.trim()) { confirmClick(e); handleLookupByNumber(); } }} disabled={phoneLookupLoading || !phoneLookupInput.trim()}
                      style={{ padding: '12px 20px', borderRadius: '12px', border: 'none', background: phoneLookupInput.trim() ? colors.navyBg : 'var(--pill-bg)', color: phoneLookupInput.trim() ? 'white' : 'var(--text-tertiary)', fontSize: 'var(--t-body)', fontWeight: '600', cursor: phoneLookupInput.trim() ? 'pointer' : 'default', position: 'relative', overflow: 'hidden', opacity: phoneLookupLoading ? 0.7 : 1 }}>
                      {phoneLookupLoading ? '...' : 'Look up'}
                    </button>
                  </div>

                  {phoneLookupError && (
                    <p role="alert" style={{ fontSize: 'var(--t-meta)', color: colors.redText, fontWeight: '600', margin: '10px 0 0', lineHeight: '1.4' }}>{phoneLookupError}</p>
                  )}

                  {!phoneLookupError && phoneLookupUsers && phoneLookupUsers.length > 0 && (
                    <div style={{ marginTop: '10px' }}>
                      {phoneLookupUsers.map(user => personRow(user, 'Matches the number you typed'))}
                    </div>
                  )}

                  {/* "Not on Flock" would be a false statement about somebody
                      who has an account and simply has not opted in to being
                      found by their number. The server cannot tell those two
                      apart on purpose, so neither may this line. */}
                  {!phoneLookupError && phoneLookupUsers && phoneLookupUsers.length === 0 && (
                    <BirdNote layout="row" bird={WARM_BIRD} size={48} body="Nobody on Flock has that number, or they have not turned on being found by it." style={{ marginTop: '10px' }} />
                  )}
                </div>

                {/* INVITE. One button, never one per contact: a per-contact
                    invite would need the server to say which number produced
                    which person, which is the one thing find-by-phone refuses
                    to answer. Messages picks the recipient, and Flock never
                    learns who it was. */}
                <div style={styles.card}>
                  <h3 style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: '0 0 4px' }}>Nobody there yet?</h3>
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '0 0 10px' }}>Send someone your code and they can add you the moment they sign up</p>
                  <button className="hit44 glass-btn glass-secondary" onClick={(e) => { confirmClick(e); handleInviteFriend(); }} disabled={!myFriendCode}
                    style={{ width: '100%', padding: '12px', borderRadius: '12px', border: `1.5px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-label)', fontWeight: '600', cursor: myFriendCode ? 'pointer' : 'default', opacity: myFriendCode ? 1 : 0.6, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', position: 'relative', overflow: 'hidden' }}>
                    {Icons.share(colors.navy, 16)} Invite a friend
                  </button>
                </div>
              </div>
            );
          })()}
        </div>

        {BottomNav()}
      </div>
    );
}
