/**
 * FLOCK DIRECT MESSAGE SCREEN
 *
 * The one-to-one DM thread. It was 746 lines of `App.js`, declared as an arrow
 * function inside `FlockAppInner` and called rather than mounted. It moved out
 * for the same reason the venue owner dashboard, the flock chat detail and Add
 * Friends did, which is that a single file holding every screen in the product
 * is a file nobody can review. It is the fourth screen of that sweep, and the
 * one the flock chat extraction named when it deferred this move. That file's
 * header documents the deferral and the shared shape: this screen and the flock
 * chat share about half their behaviour, so moving both in one commit would
 * have made either verbatim diff unreadable, and that diff is the only thing
 * proving nothing changed on the way across.
 *
 * WHY THIS ONE IS A STATIC IMPORT
 *
 * The same call the flock chat and Add Friends made, for the same reason. The
 * venue dashboard is the paid product, gated behind a role and reachable by no
 * consumer, so its own chunk costs its audience nothing. A DM thread is the far
 * end of that scale: every user opens it, most open it more than once in a
 * session, and they do it on a bar network. React.lazy would move this screen
 * off the boot chunk and charge a round trip, plus an empty Suspense fallback
 * on a congested network, in front of a screen the person opened deliberately.
 * The flock chat header priced that exact trade with three production builds
 * and it came out negative for a screen users open immediately. This screen is
 * opened the same way, so it is imported normally and stays in the app chunk.
 * It was not re-measured in bytes here, because the reasoning, not a fresh
 * number, is what decides it, and inventing a number would be worse than
 * citing the sibling that measured one.
 *
 * WHY EVERYTHING ARRIVES AS A PROP
 *
 * The old arrow function closed over 101 names: 83 declared in `FlockAppInner`,
 * which is its state, setters, handlers and a couple of local constants, and
 * ten module-level helpers, constants and components that `App.js` shares with
 * screens other than this one. Those 93 are the parameters below. The remaining
 * eight are module imports `App.js` already pulls in from `../services/api`,
 * `../services/socket`, `../components/ui/Icons` and this screen's own sibling
 * `./ChatDetail`, so this file imports them straight from the source rather than
 * taking them as props. A context would have had to enumerate the same 93 names
 * into a provider value, so it buys nothing and hides the dependency surface
 * behind a hook. As parameters, the whole dependency surface of this file is its
 * parameter list plus its imports, and a name this component reads and does not
 * receive is an undefined identifier that `no-undef` fails the build on, rather
 * than a prop that is silently `undefined` at runtime and renders as nothing.
 *
 * The names were not read off the page. They came from a Babel scope walk of the
 * block, every `ReferencedIdentifier` whose binding resolves outside it, and the
 * parameter list below and the props object at the call site were both generated
 * from that one array, so they cannot drift apart.
 *
 * The state and the effects behind these props deliberately did NOT move. They
 * live in `FlockAppInner`, which does not unmount when the user leaves this
 * screen, so the DM socket wiring, the scrollback cursor, the message cache and
 * a half-typed message survive a trip elsewhere exactly as they did before.
 *
 * SHARED EXPLANATIONS. The flock chat header said this file holds the two
 * standing explanations it has no copy of: the one for a pair with no connection
 * yet and the one for a blocked pair. Both are here, in the body, where they
 * always were. Everywhere the two screens share a fix, the comment names
 * `screens/ChatDetail.js` and does not restate it: the collapsed feature rail,
 * the typing indicator's visibility toggle, the composer's flex rules and the
 * reaction grouping. Those cross-references moved across verbatim with the rest
 * of the body.
 *
 * The body below is the old block verbatim, including its original four-space
 * indentation, so it can be diffed against the deleted lines character for
 * character. Nothing was renamed, reformatted or improved on the way across, and
 * unlike the flock chat extraction no defect was fixed in transit: this is a
 * move. Anything found while moving it was logged to tools/e2e/FINDINGS.md as a
 * new row rather than changed here.
 */
import React from 'react';
import { sendFriendRequest, trackDmVenueVote, getDmMessageImage } from '../services/api';
import { dmReact, dmRemoveReact, dmStopSharingLocation, dmVoteVenue, getSocket } from '../services/socket';
import { groupReactions } from './ChatDetail';
import Icons from '../components/ui/Icons';
import { BirdieStill, BirdNote, WARM_BIRD } from '../components/ui/BirdieBird';

// Day separators. Long threads used to be one undifferentiated scroll where
// last Tuesday touched tonight with nothing between them. A row draws a
// divider when its calendar day differs from the previous row's; rows with no
// sentAt (old cached rows, failed sends) inherit the previous day so a
// missing timestamp can never invent a boundary. Mirrored in ChatDetail.js
// and DmDetail.js by design; the copy vocabulary is Today / Yesterday / the
// dated weekday.
const dayKeyOf = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};
const dayLabelOf = (iso) => {
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today - that) / 86400000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
};
const daySeparatorFor = (rows, idx) => {
  const cur = dayKeyOf(rows[idx]?.sentAt);
  if (!cur) return null;
  for (let i = idx - 1; i >= 0; i--) {
    const prev = dayKeyOf(rows[i]?.sentAt);
    if (prev) return prev === cur ? null : dayLabelOf(rows[idx].sentAt);
  }
  // First dated row in the thread: label it so history opens with its day.
  return dayLabelOf(rows[idx].sentAt);
};


// Same cadence the flock header samples at (ChatDetail SOCKET_SAMPLE_MS).
const DM_SOCKET_SAMPLE_MS = 2000;

export default function DmDetail({
  // Module-level helpers, constants and components that live in App.js and
  // are shared with screens other than this one, so they stay declared there
  // and arrive here.
  ChatSkeleton,
  DM_PAGE_SIZE,
  DialogBehavior,
  SearchInputLocal,
  VenueCard,
  colorsLight,
  messagePreview,
  oldestServerId,
  onVenuePhotoError,
  resolveVenuePhoto,
  // Everything else is declared in FlockAppInner and stays declared there.
  allVenues,
  authUser,
  chatInputHasText,
  colors,
  confirmClick,
  currentScreen,
  deletedDmUserIds,
  dmAtTop,
  dmBlocked,
  dmChatEndRef,
  dmNearBottomRef,
  dmChatSearch,
  dmChatSearchRef,
  dmGalleryInputRef,
  dmIsTyping,
  dmMemberLocation,
  dmMessagesLoading,
  dmNavOpen,
  dmNotConnected,
  dmPendingImage,
  dmPinnedVenue,
  dmReactions,
  dmReplyingTo,
  dmRequestSending,
  dmSharingLocation,
  dmTypingUser,
  dmVenueVotes,
  dmVenueVotesError,
  getCategoryColor,
  getRelativeTime,
  handleDmImageSelect,
  handleDmInputChange,
  isDark,
  loadDmVenueVotes,
  loadOlderDms,
  loadPopularVenues,
  olderLoading,
  openCameraViewfinder,
  openUserProfile,
  openVenueDetail,
  popularVenues,
  profilePic,
  retryFailedDm,
  selectedDm,
  selectedDmId,
  sendDmMessage,
  setChatInput,
  setCurrentScreen,
  setCurrentTab,
  setDeletedDmUserIds,
  setDirectMessages,
  setDmChatSearch,
  setDmMemberLocation,
  setDmNavOpen,
  setDmPendingImage,
  setDmReplyingTo,
  setDmRequestSending,
  setDmSharingLocation,
  setDmVenueVotes,
  setModerationTarget,
  setPickingVenueForCreate,
  setPickingVenueForDm,
  setShowDeleteDmConfirm,
  setShowDmChatSearch,
  setShowDmImagePreview,
  setShowDmMenu,
  setShowDmReactionPicker,
  setShowDmVenueSearch,
  setShowDmVotePanel,
  setVenueDetailReturnTo,
  showDeleteDmConfirm,
  showDmChatSearch,
  showDmImagePreview,
  showDmMenu,
  showDmReactionPicker,
  showDmVenueSearch,
  showDmVotePanel,
  showToast,
  // Added after the extraction, not part of the original 93. Both empty states
  // below have to tell a missing coordinate apart from a broken venue search,
  // and without this prop this screen structurally could not.
  userLocation,
  handleUnsendDm,
}) {
  // LEAVING THIS SCREEN, WRITTEN ONCE. The composer ref and its armed flag
  // are shared with the flock side (App.js chatInputRef), so a draft left
  // behind here rides into the NEXT thread anybody opens: the input remounts
  // visually empty, the Send button is still armed, and one tap sends the
  // abandoned draft, written for one person, to another. c7563c6 shut exactly
  // this class on the flock side with leaveChatScreen() and an AST guard that
  // counts every navigation against a call to the clear; this is the DM half,
  // which that commit never touched, pinned the same way by
  // __tests__/dmComposerLeave.test.js. Location sharing ends here too: the
  // back arrow used to be the only exit that stopped it, so leaving through
  // Map or a venue card kept the GPS emit loop running with no indicator
  // anywhere else in the app.
  const leaveDmScreen = () => {
    setChatInput('');
    setShowDmMenu(false);
    setShowDeleteDmConfirm(false);
    setShowDmChatSearch(false);
    setDmChatSearch('');
    setShowDmVotePanel(false);
    setShowDmVenueSearch(false);
    setDmReplyingTo(null);
    setDmNavOpen(false);
    if (dmSharingLocation) { dmStopSharingLocation(dmSharingLocation); setDmSharingLocation(null); }
  };

  // Three states, not two, with the same sampling and the same words as the
  // flock header. 9d87b73 fixed the hardcoded "online" in ChatDetail only;
  // this screen was extracted with the old literal frozen in, so a dead
  // socket kept a green dot and the word online over it.
  const readConnection = () => {
    if (getSocket()?.connected) return 'online';
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
    return 'reconnecting';
  };
  // Full-size photo viewer, the same shape ChatDetail carries: history rows
  // hold only the thumbnail, the original is one gated fetch away.

  // Jump-to-latest. Scrolled deep into history, the way back down was a long
  // manual drag and a live message arriving off-screen was invisible. The
  // pill appears once the reader is more than ~600px from the bottom and one
  // tap returns them to now. Sticky inside the scroll container, so it needs
  // no coordination with the composer's layout.
  const [showJumpPill, setShowJumpPill] = React.useState(false);
  const dmEndRef = React.useRef(null);
  const [imageViewer, setImageViewer] = React.useState(null);
  const openImageViewer = (m) => {
    if (m.image_url) { setImageViewer({ src: m.image_url }); return; }
    setImageViewer({ loading: true });
    getDmMessageImage(m.id)
      .then((d) => setImageViewer((prev) => (prev && prev.loading ? { src: d.image } : prev)))
      .catch(() => setImageViewer((prev) => (prev && prev.loading ? { error: "Couldn't load the full photo. Try again." } : prev)));
  };

  const [connectionState, setConnectionState] = React.useState(readConnection);
  React.useEffect(() => {
    const sample = () => setConnectionState(readConnection());
    sample();
    const id = setInterval(sample, DM_SOCKET_SAMPLE_MS);
    window.addEventListener('online', sample);
    window.addEventListener('offline', sample);
    return () => {
      clearInterval(id);
      window.removeEventListener('online', sample);
      window.removeEventListener('offline', sample);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return currentScreen === 'dmDetail' && selectedDm && (
    <div key="dm-detail-screen" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--bg-card-solid)' }}>
      {/* Header */}
      <div style={{ padding: '6px 10px 5px 4px', background: colors.navyBg, flexShrink: 0, boxShadow: '0 2px 10px rgba(0,0,0,0.1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button aria-label="Back" className="hit44" onClick={() => { setCurrentScreen('main'); leaveDmScreen(); }} style={{ width: '34px', height: '34px', borderRadius: '17px', background: 'none', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{Icons.arrowLeft('white', 20)}</button>
          {/* The avatar opens the person card. The overflow menu already carries
              report/block for this thread, but the face is where people reach
              first, and it is the same control the roster now has.
              No overflow:hidden on the button: it would clip .hit44's pseudo
              hit box, and at 34px the 44pt target is the whole point of the
              class. The <img> already rounds itself. */}
          <button
            className="hit44"
            aria-label={`About ${selectedDm.name}`}
            onClick={() => openUserProfile({ id: selectedDmId, name: selectedDm.name, image: selectedDm.image })}
            style={{ width: '34px', height: '34px', borderRadius: '17px', backgroundColor: 'rgba(255,255,255,0.2)', border: 'none', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-label)', fontWeight: '600', color: 'white', flexShrink: 0, cursor: 'pointer' }}
          >
            {selectedDm.image ? <img src={selectedDm.image} alt="" style={{ width: '34px', height: '34px', borderRadius: '17px', objectFit: 'cover' }} /> : (selectedDm.name?.[0]?.toUpperCase() || '?')}
          </button>
          <h2 style={{ flex: 1, fontFamily: 'var(--font-display)', letterSpacing: '-0.005em', fontWeight: '600', color: 'white', fontSize: 'var(--t-title)', margin: 0, lineHeight: '1.3', minWidth: 0 }}>{selectedDm.name}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
            {/* Collapsed means gone. See the same fix on the flock chat
                header in screens/ChatDetail.js: a zero max-width with hidden
                overflow paints nothing and leaves every button inside it
                focusable and readable. */}
            <div style={{ display: 'flex', gap: '4px', overflow: 'hidden', maxWidth: dmNavOpen ? '114px' : '0px', opacity: dmNavOpen ? 1 : 0, visibility: dmNavOpen ? undefined : 'hidden', transition: `max-width 0.3s ease, opacity 0.25s ease, visibility 0s linear ${dmNavOpen ? '0s' : '0.3s'}` }}>
              <button aria-label="Venue voting" className="hit44 glass-btn" onClick={() => { setDmNavOpen(false); setShowDmVotePanel(!showDmVotePanel); if (!showDmVotePanel) loadPopularVenues(); }} style={{ width: '34px', height: '34px', minWidth: '34px', borderRadius: '17px', border: 'none', backgroundColor: 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.vote('white', 14)}</button>
              <button aria-label="Search" className="hit44 glass-btn" onClick={() => { setDmNavOpen(false); setShowDmChatSearch(!showDmChatSearch); }} style={{ width: '34px', height: '34px', minWidth: '34px', borderRadius: '17px', border: 'none', backgroundColor: showDmChatSearch ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.search('white', 15)}</button>
            </div>
            <button aria-label="Features" aria-expanded={dmNavOpen} className="hit44" onClick={() => setDmNavOpen(!dmNavOpen)} style={{ height: '34px', minWidth: dmNavOpen ? '34px' : 'auto', width: dmNavOpen ? '34px' : 'auto', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.18)', backgroundColor: dmNavOpen ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.1)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', padding: dmNavOpen ? '0' : '0 12px', fontSize: 'var(--t-meta)', fontWeight: '600', flexShrink: 0, transition: 'all 0.3s ease', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12)' }}>{dmNavOpen ? Icons.x('white', 14) : <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500' }}>Features</span>}</button>
          </div>
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button aria-label="More options" className="hit44" onClick={() => setShowDmMenu(!showDmMenu)} style={{ width: '34px', height: '34px', borderRadius: '17px', border: 'none', backgroundColor: 'rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.moreVertical('white', 16)}</button>
            {showDmMenu && (
              <div style={{ position: 'absolute', top: '38px', right: 0, backgroundColor: 'var(--bg-card-solid)', borderRadius: '14px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', minWidth: '200px', zIndex: 60, overflow: 'hidden', border: '1px solid var(--border-subtle)' }}>
                <button className="hit44 glass-btn" onClick={() => { setShowDmMenu(false); setModerationTarget({ userId: selectedDmId, userName: selectedDm.name, contentType: 'profile' }); }} style={{ width: '100%', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '10px', border: 'none', borderBottom: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer', fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--text-primary)' }}>
                  <span aria-hidden style={{ display: 'inline-flex' }}>{Icons.flag('currentColor', 15)}</span> Report or block {selectedDm.name}
                </button>
                <button className="hit44 glass-btn glass-danger" onClick={() => { setShowDmMenu(false); setShowDeleteDmConfirm(true); }} style={{ width: '100%', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '10px', border: 'none', backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer', fontSize: 'var(--t-body)', fontWeight: '600', color: '#EF4444' }}>
                  {Icons.x('#EF4444', 16)} Delete Conversation
                </button>
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', paddingLeft: '74px', marginTop: '2px' }}>
          {dmIsTyping ? <span style={{ fontSize: 'var(--t-meta)', color: '#86EFAC', fontWeight: '500' }}>{dmTypingUser || selectedDm.name} is typing...</span> : dmSharingLocation ? <span style={{ fontSize: 'var(--t-meta)', color: '#34d399', fontWeight: '500', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>{Icons.mapPin('#34d399', 12)}sharing location</span> : <><span style={{ width: '5px', height: '5px', borderRadius: '3px', backgroundColor: connectionState === 'online' ? '#22c55e' : connectionState === 'offline' ? '#9CA3AF' : '#F59E0B', boxShadow: 'none' }} /><span style={{ fontSize: 'var(--t-meta)', color: 'rgba(255,255,255,0.55)', fontWeight: '500' }}>{connectionState === 'online' ? 'online' : connectionState === 'offline' ? 'offline' : 'reconnecting...'}</span></>}
        </div>
      </div>

      {/* Dismiss DM menu */}
      {showDmMenu && <div onClick={() => setShowDmMenu(false)} style={{ position: 'absolute', inset: 0, zIndex: 55 }} />}

      {/* Chat search bar */}
      {showDmChatSearch && (
        <div style={{ padding: '8px 12px', backgroundColor: 'var(--bg-card-solid)', borderBottom: '1px solid var(--divider)', display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
          <SearchInputLocal aria-label="Search messages" inputRef={dmChatSearchRef} type="text" initialValue={dmChatSearch} onCommit={setDmChatSearch} placeholder="Search messages..." style={{ flex: 1, padding: '8px 12px', borderRadius: '20px', backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)', border: 'none', fontSize: 'var(--t-label)', outline: 'none' }} />
          {dmChatSearch && <button aria-label="Clear search" className="hit44" onClick={() => setDmChatSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>{Icons.x(colors.textSecondary, 14)}</button>}
        </div>
      )}

      {/* Location sharing indicator */}
      {dmSharingLocation && (
        <div style={{ padding: '8px 14px', background: 'linear-gradient(135deg, #059669, #047857)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ width: '8px', height: '8px', borderRadius: '4px', backgroundColor: '#34d399', animation: 'pulse 2s ease-in-out infinite', boxShadow: 'none' }} />
          <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'white', margin: 0, flex: 1 }}>Sharing live location with {selectedDm.name}</p>
          {dmMemberLocation && <span style={{ fontSize: 'var(--t-meta)', color: '#a7f3d0', fontWeight: '500' }}>{selectedDm.name} sharing too</span>}
          <button className="hit44" onClick={() => { dmStopSharingLocation(dmSharingLocation); setDmSharingLocation(null); }} style={{ padding: '4px 10px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.3)', background: 'rgba(255,255,255,0.15)', color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>Stop</button>
        </div>
      )}

      {/* Pinned Venue Banner — top-voted or manually pinned venue */}
      {dmPinnedVenue ? (
        <div style={{ padding: '10px 14px', background: `linear-gradient(135deg, ${colors.navy}08, ${colors.steel}12)`, borderBottom: `1px solid ${colors.creamDark}`, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {dmPinnedVenue.photo_url ? (
              <img src={dmPinnedVenue.photo_url} alt="" style={{ width: '52px', height: '52px', borderRadius: '12px', objectFit: 'cover', flexShrink: 0, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }} onError={onVenuePhotoError} />
            ) : (
              <div style={{ width: '52px', height: '52px', borderRadius: '12px', background: colors.navyBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 2px 8px rgba(13,40,71,0.10)' }}>
                {Icons.mapPin('white', 22)}
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <h4 style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dmPinnedVenue.name}</h4>
                {dmPinnedVenue.rating && <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: '#F59E0B', display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>{Icons.starFilled('#F59E0B', 12)} {dmPinnedVenue.rating}</span>}
              </div>
              {dmPinnedVenue.addr && <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dmPinnedVenue.addr}</p>}
            </div>
            <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
              <button
                className="hit44 glass-btn glass-navy"
                onClick={() => {
                  leaveDmScreen();
                  setVenueDetailReturnTo({ tab: 'chat', screen: 'dmDetail', dmId: selectedDmId });
                  setCurrentTab('explore');
                  setCurrentScreen('main');
                  if (dmPinnedVenue.place_id) {
                    setTimeout(() => {
                      if (window.__flockPanToVenue) {
                        window.__flockPanToVenue({ place_id: dmPinnedVenue.place_id, name: dmPinnedVenue.name, address: dmPinnedVenue.addr, rating: dmPinnedVenue.rating, photo_url: dmPinnedVenue.photo_url });
                      }
                    }, 300);
                  }
                }}
                style={{ padding: '8px 10px', borderRadius: '10px', border: 'none', background: colors.steel, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', boxShadow: '0 1px 2px rgba(30,41,59,0.10)' }}
              >
                {Icons.mapPin('white', 12)} Map
              </button>
              <button className="hit44 glass-btn glass-secondary" onClick={() => { leaveDmScreen(); setPickingVenueForDm(true); setPickingVenueForCreate(true); setCurrentTab('explore'); setCurrentScreen('main'); }} style={{ padding: '8px 10px', borderRadius: '10px', border: `1px solid ${colors.creamDark}`, background: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '3px' }}>
                Change
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button className="hit44 glass-btn glass-secondary" onClick={() => { leaveDmScreen(); setPickingVenueForDm(true); setPickingVenueForCreate(true); setCurrentTab('explore'); setCurrentScreen('main'); }} style={{ margin: '0', padding: '10px 14px', background: `linear-gradient(135deg, var(--bg-primary), var(--bg-card-solid))`, borderBottom: `1px solid ${colors.creamDark}`, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', width: '100%', flexShrink: 0 }}>
          <div style={{ width: '40px', height: '40px', borderRadius: '12px', border: `2px dashed ${colors.steel}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.mapPin(colors.steel, 18)}</div>
          <div style={{ flex: 1, textAlign: 'left' }}>
            <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: 0 }}>Add a Venue</p>
            <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '1px 0 0' }}>Pick a spot on the map</p>
          </div>
          <div style={{ color: colors.steel, fontWeight: '700', fontSize: 'var(--t-title)' }}>+</div>
        </button>
      )}

      {/* Vote panel — identical to flock with optimistic local updates */}
      {showDmVotePanel && (() => {
        const myName = authUser?.name;
        const totalVoters = new Set(dmVenueVotes.flatMap(v => v.voters || [])).size;
        const myVote = dmVenueVotes.find(v => (v.voters || []).includes(myName))?.venue_name || null;
        const pinnedName = dmPinnedVenue?.name || null;

        const handleDmQuickVote = (venueName, venueId) => {
          const existing = dmVenueVotes.find(v => v.venue_name === venueName);
          if (existing) {
            if ((existing.voters || []).includes(myName)) return; // already voted here
            // Switch vote: remove from old, add to new
            const newVotes = dmVenueVotes.map(v => ({
              ...v,
              voters: v.venue_name === venueName
                ? [...(v.voters || []), myName]
                : (v.voters || []).filter(x => x !== myName),
              vote_count: v.venue_name === venueName
                ? parseInt(v.vote_count || 0) + 1
                : (v.voters || []).includes(myName) ? parseInt(v.vote_count || 0) - 1 : parseInt(v.vote_count || 0),
            })).filter(v => parseInt(v.vote_count || 0) > 0 || v.venue_name === venueName);
            setDmVenueVotes(newVotes);
          } else {
            // New vote: remove from old venues, add new entry
            const newVotes = [
              ...dmVenueVotes.map(v => ({
                ...v,
                voters: (v.voters || []).filter(x => x !== myName),
                vote_count: (v.voters || []).includes(myName) ? parseInt(v.vote_count || 0) - 1 : parseInt(v.vote_count || 0),
              })).filter(v => parseInt(v.vote_count || 0) > 0),
              { venue_name: venueName, venue_id: venueId || null, vote_count: 1, voters: [myName] },
            ];
            setDmVenueVotes(newVotes);
          }
          dmVoteVenue(selectedDmId, venueName, venueId);
          trackDmVenueVote();
                 };

        const handleDmUnvote = () => {
          const newVotes = dmVenueVotes.map(v => ({
            ...v,
            voters: (v.voters || []).filter(x => x !== myName),
            vote_count: (v.voters || []).includes(myName) ? parseInt(v.vote_count || 0) - 1 : parseInt(v.vote_count || 0),
          })).filter(v => parseInt(v.vote_count || 0) > 0);
          setDmVenueVotes(newVotes);
          if (myVote) dmVoteVenue(selectedDmId, myVote, dmVenueVotes.find(v => v.venue_name === myVote)?.venue_id);
        };

        const votesWithPinned = pinnedName && !dmVenueVotes.find(v => v.venue_name === pinnedName)
          ? [{ venue_name: pinnedName, venue_id: dmPinnedVenue?.place_id, vote_count: 0, voters: [], isPinned: true }, ...dmVenueVotes]
          : dmVenueVotes.map(v => ({ ...v, isPinned: v.venue_name === pinnedName }));
        const sortedVotes = [...votesWithPinned].sort((a, b) => {
          if (a.isPinned && !b.isPinned) return -1;
          if (b.isPinned && !a.isPinned) return 1;
          return parseInt(b.vote_count || 0) - parseInt(a.vote_count || 0);
        });
        const suggestedVenues = popularVenues.filter(v => !votesWithPinned.find(fv => fv.venue_name === v.name)).slice(0, 8);

        return (
          <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
            <DialogBehavior onClose={() => setShowDmVotePanel(false)} label="Vote on a venue" />
            <div className="modal-content" style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '20px 20px 0 0', padding: '20px', width: '100%', maxHeight: '80%', overflowY: 'auto' }}>
              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <div>
                  <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>{Icons.vote(colors.navy, 20)} Vote for a Venue</h2>
                  {/* The tally is a count of other people, so it is only
                      printed when the read that produced it landed. */}
                  {!dmVenueVotesError && (
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '2px 0 0' }}>{totalVoters} vote{totalVoters !== 1 ? 's' : ''} cast{myVote ? ` • You voted for ${myVote}` : ''}</p>
                  )}
                </div>
                <button aria-label="Close" className="hit44" onClick={() => setShowDmVotePanel(false)} style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: 'var(--bg-hover)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x(colors.textSecondary, 18)}</button>
              </div>

              {/* A failed read is said once, above the list, because the list
                  can be non empty on a failure: the pinned venue is added to
                  it locally and would otherwise sit there under a tally of
                  zero that nobody measured. */}
              {dmVenueVotesError && (
                <BirdNote
                  layout="row"
                  size={48}
                  role="alert"
                  body={dmVenueVotesError}
                  style={{ padding: '14px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '14px', marginBottom: '12px' }}
                  action={<button className="hit44 glass-btn glass-navy" onClick={() => loadDmVenueVotes(selectedDmId)} style={{ padding: '8px 14px', borderRadius: '10px', border: 'none', background: colors.navyMidBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer' }}>Try again</button>}
                />
              )}

              {/* Current votes */}
              {sortedVotes.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
                  {sortedVotes.map((v, idx) => {
                    const isMyVote = (v.voters || []).includes(myName);
                    const voteCount = parseInt(v.vote_count || 0);
                    const votePercent = totalVoters > 0 ? Math.round((voteCount / totalVoters) * 100) : 0;
                    const isLeading = !v.isPinned && idx === 0 && voteCount > 0;
                    const iconBg = v.isPinned
                      ? colors.navyBg
                      : isLeading ? colors.steel : `linear-gradient(135deg, ${colors.navy}15, ${colors.navy}25)`;
                    return (
                      <button key={v.venue_name} className="hit44 glass-btn glass-secondary" onClick={(e) => { confirmClick(e); isMyVote ? handleDmUnvote() : handleDmQuickVote(v.venue_name, v.venue_id); }} style={{ width: '100%', textAlign: 'left', padding: '12px 14px', borderRadius: '14px', border: v.isPinned ? `2px solid ${colors.navy}` : isMyVote ? `2px solid ${colors.navy}` : '1.5px solid var(--border-default)', backgroundColor: v.isPinned ? `${colors.navy}05` : isMyVote ? `${colors.navy}06` : 'var(--bg-card-solid)', cursor: 'pointer', position: 'relative', overflow: 'hidden', transition: 'opacity 0.2s' }}>
                        {/* Progress bar background */}
                        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${votePercent}%`, backgroundColor: isMyVote ? `${colors.navy}10` : 'var(--bg-tertiary)', transition: 'width 0.4s ease', borderRadius: '14px' }} />
                        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            {v.isPinned ? Icons.mapPin('white', 16) : isLeading ? Icons.flame('#fff', 18) : Icons.mapPin(colors.navy, 16)}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <h4 style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.venue_name}</h4>
                              {v.isPinned && <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'white', backgroundColor: colors.navyBg, padding: '1px 6px', borderRadius: '6px', flexShrink: 0 }}>Pinned</span>}
                              {isLeading && <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.steel, backgroundColor: `${colors.steel}15`, padding: '1px 6px', borderRadius: '6px', flexShrink: 0 }}>Leading</span>}
                            </div>
                            <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '1px 0 0' }}>{(v.voters || []).length > 0 ? (v.voters || []).join(', ') : v.isPinned ? 'Current pinned venue. Tap to vote' : 'No votes yet'}</p>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                            {voteCount > 0 && <span style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: isMyVote ? colors.navy : colors.textTertiary }}>{voteCount}</span>}
                            {isMyVote && <div style={{ width: '20px', height: '20px', borderRadius: '10px', backgroundColor: colors.navyBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.check('white', 12)}</div>}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : !dmVenueVotesError && (
                /* Somebody else may well have voted. Saying nobody has, on the
                   strength of a request that never came back, is the version
                   of this panel that changes what the user does next. */
                <div style={{ padding: '20px', textAlign: 'center', backgroundColor: 'var(--bg-tertiary)', borderRadius: '14px', marginBottom: '16px' }}>
                  {userLocation ? (
                    <>
                      <BirdieStill bird={WARM_BIRD} size={64} style={{ margin: '0 auto 8px' }} />
                      <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-tertiary)', margin: 0, fontWeight: '500' }}>{suggestedVenues.length > 0
                        ? 'No votes yet. Vote for a place below, or share one of your own.'
                        : 'No votes yet. Be the first to suggest a venue!'}</p>
                    </>
                  ) : (
                    /* The DM half of the fix ChatDetail already carries. With no
                       coordinate, suggestedVenues is location-fed and stays
                       empty, so this panel told a fresh account to "be the first
                       to suggest a venue" with nothing to suggest from, and the
                       only other door (Share a venue to chat) then claimed venue
                       search was down. Two screens in a row, both wrong about
                       the cause. Name the real one and open the door to it. */
                    <>
                      <BirdieStill bird={WARM_BIRD} size={64} style={{ margin: '0 auto 8px' }} />
                      <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-tertiary)', margin: '0 0 12px', fontWeight: '500' }}>No votes yet. To see places to suggest, Flock needs your location.</p>
                      <button className="hit44 glass-btn glass-secondary" onClick={() => { leaveDmScreen(); setPickingVenueForDm(true); setPickingVenueForCreate(true); setCurrentTab('explore'); setCurrentScreen('main'); }} style={{ padding: '10px 18px', borderRadius: '12px', border: `1.5px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer' }}>Browse venues on Discover</button>
                    </>
                  )}
                </div>
              )}

              {/* Popular chains nearby */}
              {suggestedVenues.length > 0 && (
                <>
                  <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-tertiary)', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Popular Chains Nearby</p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {suggestedVenues.map(venue => (
                      <button key={venue.id || venue.name} className="hit44 glass-btn glass-secondary" onClick={(e) => { confirmClick(e); handleDmQuickVote(venue.name, venue.place_id); }} style={{ width: '100%', textAlign: 'left', padding: '10px 12px', borderRadius: '12px', border: '1px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', transition: 'opacity 0.2s', position: 'relative', overflow: 'hidden' }}>
                        {venue.photo_url ? (
                          <img src={venue.photo_url} alt="" style={{ width: '36px', height: '36px', borderRadius: '8px', objectFit: 'cover', flexShrink: 0 }} onError={onVenuePhotoError} />
                        ) : (
                          <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: `linear-gradient(135deg, ${getCategoryColor(venue.category)}, ${getCategoryColor(venue.category)}cc)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            {Icons.mapPin('white', 14)}
                          </div>
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{venue.name}</p>
                          <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '1px 0 0' }}>{venue.type || venue.category}{venue.stars ? <> • {venue.stars} {Icons.starFilled('currentColor', 12)}</> : ''}{venue.price ? ` • ${venue.price}` : ''}</p>
                        </div>
                        <div style={{ padding: '6px 12px', borderRadius: '10px', backgroundColor: `${colors.navy}08`, color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '500', flexShrink: 0 }}>
                          {Icons.vote(colors.navy, 12)} Vote
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {/* Browse more button */}
              <button className="hit44 glass-btn glass-secondary" onClick={() => { setShowDmVotePanel(false); setShowDmVenueSearch(true); }} style={{ width: '100%', padding: '12px', borderRadius: '12px', border: `2px dashed ${colors.creamDark}`, backgroundColor: 'transparent', color: 'var(--text-tertiary)', fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer', marginTop: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                {Icons.plus(colors.textTertiary, 14)} Share a venue to chat
              </button>
            </div>
          </div>
        );
      })()}

      {/* Venue Share Modal — matches flock style exactly */}
      {showDmVenueSearch && (
        <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
            <DialogBehavior onClose={() => setShowDmVenueSearch(false)} label="Share a venue" />
          <div className="modal-content" style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '20px 20px 0 0', padding: '20px', width: '100%', maxHeight: '70%', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>{Icons.mapPin(colors.navy, 20)} Share a Venue</h2>
              <button aria-label="Close" className="hit44" onClick={() => setShowDmVenueSearch(false)} style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: 'var(--bg-hover)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x(colors.textSecondary, 18)}</button>
            </div>

            {/* Current pinned venue display */}
            {dmPinnedVenue ? (
              <div style={{ padding: '12px', borderRadius: '14px', background: `linear-gradient(135deg, ${colors.navy}08, ${colors.steel}15)`, border: `2px solid ${colors.steel}40`, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: colors.steel, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {Icons.mapPin('white', 18)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: colors.steel, margin: '0 0 2px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Pinned Venue</p>
                  <p style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dmPinnedVenue.name}</p>
                  {dmPinnedVenue.addr && <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dmPinnedVenue.addr}</p>}
                </div>
                <button className="hit44 glass-btn glass-primary" onClick={(e) => { confirmClick(e); sendDmMessage({ text: `Check out ${dmPinnedVenue.name}!`, message_type: 'venue_card', venue_data: { name: dmPinnedVenue.name, addr: dmPinnedVenue.addr, stars: dmPinnedVenue.rating, rating: dmPinnedVenue.rating, photo_url: dmPinnedVenue.photo_url, place_id: dmPinnedVenue.place_id }, noReply: true }); setShowDmVenueSearch(false); }} style={{ padding: '8px 12px', borderRadius: '10px', border: 'none', background: colors.steel, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', whiteSpace: 'nowrap', position: 'relative', overflow: 'hidden' }}>Share This</button>
              </div>
            ) : (
              <div style={{ padding: '10px 12px', borderRadius: '12px', backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-default)', marginBottom: '16px' }}>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, fontStyle: 'italic' }}>No venue pinned. Pick one below:</p>
              </div>
            )}

            <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Or select a different venue:</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {allVenues.length === 0 ? (
                /* Venue search down = an empty list under "Or select a
                   different venue", the blank dead end B3 fixed on the flock
                   sheet (ChatDetail). Same honesty here: say why, offer the
                   one real exit. */
                <div style={{ padding: '16px', borderRadius: '14px', backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-default)', textAlign: 'center' }}>
                  <BirdieStill size={64} style={{ margin: '0 auto 8px' }} />
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 12px', lineHeight: '1.5' }}>{userLocation
                    ? 'No venues to show here. Venue search is unavailable right now, so there is nothing to pick from yet.'
                    /* allVenues is only ever filled by loadVenuesAtLocation, so
                       with no coordinate it is empty because nothing was ever
                       asked, not because the ask failed. Blaming search told a
                       fresh account a working feature was broken, which is the
                       sentence ChatDetail's own comment says it fixed there. */
                    : "No venues to show yet, because Flock doesn't have your location. Turn it on from the Discover tab and this list fills in."}</p>
                  <button className="hit44 glass-btn glass-secondary" onClick={() => setShowDmVenueSearch(false)} style={{ padding: '10px 20px', borderRadius: '12px', border: `1.5px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer' }}>Close</button>
                </div>
              ) : allVenues.map(venue => (
                <button className="hit44"
                  key={venue.id}
                  onClick={(e) => {
                    confirmClick(e);
                    sendDmMessage({ text: `Check out ${venue.name}!`, message_type: 'venue_card', venue_data: { name: venue.name, addr: venue.addr, stars: venue.stars, rating: venue.rating || venue.stars, price: venue.price, price_level: venue.price_level, photo_url: venue.photo_url, place_id: venue.place_id, category: venue.category, type: venue.type, crowd: venue.crowd }, noReply: true });
                    setShowDmVenueSearch(false);
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', borderRadius: '14px', border: '1px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer', textAlign: 'left', transition: 'opacity 0.2s ease' }}
                >
                  {/* The row is about to SEND this venue's photo_url to the
                      other person, and it was drawing a category gradient
                      instead of showing it. The "Popular Chains Nearby" rows
                      thirty lines up already render a 36px photo, so the
                      gradient here was the outlier, not the standard. The icon
                      tile stays as the fallback for a venue Google has no photo
                      of, which is the only reason to show none. */}
                  {venue.photo_url ? (
                    <img
                      src={resolveVenuePhoto(venue.photo_url)}
                      alt=""
                      style={{ width: '44px', height: '44px', borderRadius: '12px', objectFit: 'cover', flexShrink: 0 }}
                      onError={(e) => { e.target.onerror = null; e.target.src = '/marks/venue-placeholder.jpg'; }}
                    />
                  ) : (
                    <div style={{ width: '44px', height: '44px', borderRadius: '12px', background: `linear-gradient(135deg, ${getCategoryColor(venue.category)}, ${getCategoryColor(venue.category)}cc)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {venue.category === 'Food' ? Icons.pizza('white', 20) : venue.category === 'Nightlife' ? Icons.cocktail('white', 20) : venue.category === 'Live Music' ? Icons.music('white', 20) : Icons.sports('white', 20)}
                    </div>
                  )}
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: 0 }}>{venue.name}</p>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0' }}>{venue.type} {venue.price ? `\u2022 ${venue.price}` : ''}</p>
                  </div>
                  {typeof venue.crowd === 'number' && <div style={{ padding: '4px 10px', borderRadius: '12px', backgroundColor: venue.crowd > 84 ? '#FEE2E2' : venue.crowd > 39 ? '#FEF3C7' : '#D1FAE5', color: venue.crowd > 84 ? colors.red : venue.crowd > 39 ? colors.amber : colors.steel, fontSize: 'var(--t-meta)', fontWeight: '500' }}>
                    {venue.crowd}%
                  </div>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Delete DM Confirmation Modal */}
      {showDeleteDmConfirm && (
        <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: '16px' }}>
            <DialogBehavior onClose={() => setShowDeleteDmConfirm(false)} label="Delete conversation" />
          <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '24px', padding: '24px', width: '100%', maxWidth: '300px' }}>
            <div style={{ textAlign: 'center', marginBottom: '16px' }}>
              <div style={{ width: '48px', height: '48px', borderRadius: '24px', backgroundColor: 'var(--accent-red-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>{Icons.x('#EF4444', 24)}</div>
              <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 8px' }}>Delete Conversation?</h3>
              <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>Delete this conversation with {selectedDm.name}? Messages will be removed from your view.</p>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="hit44 glass-btn glass-secondary" onClick={() => setShowDeleteDmConfirm(false)} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: `2px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontWeight: '600', fontSize: 'var(--t-body)', cursor: 'pointer' }}>Cancel</button>
              <button className="hit44 glass-btn glass-danger" onClick={() => {
                const dmUserId = selectedDm.userId;
                setDirectMessages(prev => prev.filter(d => d.userId !== dmUserId));
                const updated = [...deletedDmUserIds, dmUserId];
                setDeletedDmUserIds(updated);
                try { localStorage.setItem('flock_deleted_dms', JSON.stringify(updated)); } catch {}
                leaveDmScreen();
                setCurrentScreen('main');
                             }} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: 'none', backgroundColor: '#EF4444', color: 'white', fontWeight: '600', fontSize: 'var(--t-body)', cursor: 'pointer' }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Image preview modal */}
      {showDmImagePreview && dmPendingImage && (
        <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.9)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '20px' }}>
          <DialogBehavior onClose={() => { setShowDmImagePreview(false); setDmPendingImage(null); }} label="Send this photo" />
          <img src={dmPendingImage} alt="Preview" style={{ maxWidth: '100%', maxHeight: '60%', borderRadius: '12px', objectFit: 'contain' }} />
          <div style={{ display: 'flex', gap: '12px', marginTop: '20px' }}>
            <button className="hit44 glass-btn glass-secondary" onClick={() => { setShowDmImagePreview(false); setDmPendingImage(null); }} style={{ padding: '12px 24px', borderRadius: '24px', border: '2px solid var(--bg-card-solid)', backgroundColor: 'transparent', color: 'white', fontSize: 'var(--t-body)', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
            {/* An image-only message: text is '', not the word "Photo". The
                explicit '' also stops the composer's half-typed draft from
                being swept in as a caption. */}
            <button className="hit44 glass-btn glass-navy" onClick={() => { const img = dmPendingImage; setShowDmImagePreview(false); setDmPendingImage(null); sendDmMessage({ text: '', message_type: 'image', image_url: img, noReply: true }); }} style={{ padding: '12px 24px', borderRadius: '24px', border: 'none', background: colors.navyBg, color: 'white', fontSize: 'var(--t-body)', fontWeight: '600', cursor: 'pointer' }}>Send</button>
          </div>
        </div>
      )}

      {/* Messages area */}
      {imageViewer && (
        <div className="modal-backdrop" style={{ position: 'fixed', inset: 0, zIndex: 400, backgroundColor: 'rgba(6,16,31,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
        <DialogBehavior onClose={() => setImageViewer(null)} label="Photo" />
          <button aria-label="Close photo" className="hit44" onClick={() => setImageViewer(null)} style={{ position: 'absolute', top: 'calc(env(safe-area-inset-top, 0px) + 14px)', right: '14px', width: '40px', height: '40px', borderRadius: '20px', border: 'none', background: 'rgba(255,255,255,0.16)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1 }}>{Icons.x('white', 18)}</button>
          {imageViewer.src ? (
            <img src={imageViewer.src} alt="Full size" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '10px' }} />
          ) : (
            <p role="status" style={{ color: 'white', fontSize: 'var(--t-body)', textAlign: 'center' }}>{imageViewer.error || 'Loading the full photo\u2026'}</p>
          )}
        </div>
      )}

      <div onScroll={(e) => {
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.blur();
        const c = e.currentTarget;
        const fromBottom = c.scrollHeight - c.scrollTop - c.clientHeight;
        setShowJumpPill((prev) => {
          const next = prev ? fromBottom > 200 : fromBottom > 600;
          // Same hysteresis band, read by App.js's tail-follow effect. See
          // the flock twin in ChatDetail.js.
          dmNearBottomRef.current = !next;
          return next;
        });
      }} style={{ flex: 1, padding: '16px', overflowY: 'auto', overflowX: 'hidden', background: `linear-gradient(180deg, ${colors.cream} 0%, ${colors.cream}cc 100%)`, scrollBehavior: 'smooth' }}>
        {showDmChatSearch && dmChatSearch.trim() && selectedDm.messages.filter(m => {
          const q = dmChatSearch.toLowerCase();
          return m.text?.toLowerCase().includes(q) || m.sender?.toLowerCase().includes(q);
        }).length > 0 && (
          <div style={{ textAlign: 'center', marginBottom: '12px' }}>
            <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', backgroundColor: 'var(--bg-card)', padding: '4px 12px', borderRadius: '12px' }}>
              {selectedDm.messages.filter(m => { const q = dmChatSearch.toLowerCase(); return m.text?.toLowerCase().includes(q) || m.sender?.toLowerCase().includes(q); }).length} matching messages
            </span>
          </div>
        )}
        {/* Scrollback. Only offered when the thread is showing a full page,
            which is the only case where there can be anything behind it, and
            it retires itself the moment the server hands back a short page. */}
        {!dmMessagesLoading && !showDmChatSearch && !dmAtTop[selectedDmId] && selectedDm.messages.length >= DM_PAGE_SIZE && (
          <div style={{ textAlign: 'center', marginBottom: '14px' }}>
            <button
              className="hit44"
              disabled={olderLoading}
              onClick={() => loadOlderDms(selectedDmId, oldestServerId(selectedDm.messages))}
              style={{ padding: '8px 14px', borderRadius: '14px', border: '1px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: olderLoading ? 'default' : 'pointer', opacity: olderLoading ? 0.6 : 1 }}
            >
              {olderLoading ? 'Loading' : 'Load earlier messages'}
            </button>
          </div>
        )}
        {dmMessagesLoading && selectedDm.messages.length === 0 ? (
          <ChatSkeleton label={`Loading your messages with ${selectedDm.name}`} />
        ) : selectedDm.messages.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <div style={{ width: '60px', height: '60px', borderRadius: '30px', background: colors.navyBg, margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-display)', fontWeight: '600', color: 'white', overflow: 'hidden' }}>
              {selectedDm.image ? <img src={selectedDm.image} alt="" style={{ width: '60px', height: '60px', borderRadius: '30px', objectFit: 'cover' }} /> : (selectedDm.name?.[0]?.toUpperCase() || '?')}
            </div>
            <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 4px' }}>{dmBlocked[String(selectedDmId)] ? selectedDm.name : `Chat with ${selectedDm.name}`}</h3>
            {/* A blocked pair is shown no messages at all, so this is where a
                conversation with months of history landed. It must not read as
                a fresh chat waiting for a hello. */}
            <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>{dmBlocked[String(selectedDmId)] ? 'These messages are not available.' : 'Say hi to start the conversation.'}</p>
            <BirdieStill bird={WARM_BIRD} size={64} style={{ margin: '16px auto 0' }} />
          </div>
        ) : (
          (() => {
            const dmRows = showDmChatSearch && dmChatSearch.trim()
              ? selectedDm.messages.filter(m => { const q = dmChatSearch.toLowerCase(); return m.text?.toLowerCase().includes(q) || m.sender?.toLowerCase().includes(q); })
              : selectedDm.messages;
            return dmRows.map((m, idx) => {
            const separatorLabel = daySeparatorFor(dmRows, idx);
            return (
            <React.Fragment key={m.id}>
                {separatorLabel && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '4px 0 14px' }}>
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--text-tertiary)', background: 'var(--bg-hover)', padding: '3px 12px', borderRadius: '10px' }}>{separatorLabel}</span>
                  </div>
                )}
            <div style={{ display: 'flex', gap: '10px', marginBottom: '12px', flexDirection: m.sender === 'You' ? 'row-reverse' : 'row' }}>
              <div style={{ width: '32px', height: '32px', borderRadius: '16px', background: colors.navyBg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-meta)', color: 'white', fontWeight: '500', flexShrink: 0, overflow: 'hidden' }}>
                {m.sender === 'You'
                  ? (profilePic ? <img src={profilePic} alt="" style={{ width: '32px', height: '32px', borderRadius: '16px', objectFit: 'cover' }} /> : 'Y')
                  : (selectedDm.image ? <img src={selectedDm.image} alt="" style={{ width: '32px', height: '32px', borderRadius: '16px', objectFit: 'cover' }} /> : (selectedDm.name?.[0]?.toUpperCase() || '?'))
                }
              </div>
              {/* A send in flight is dimmed and says so below. `pending` has
                  been set on every optimistic bubble since the echo work
                  landed and nothing ever rendered it, so a message sat looking
                  exactly like a delivered one until either the server echoed
                  it or the 8 second timer turned it red. On a slow phone that
                  is eight seconds of a photo that looks sent and is not. */}
              <div style={{ maxWidth: '75%', position: 'relative', opacity: m.pending ? 0.6 : 1, transition: 'opacity 0.2s ease' }}>
                {/* Reply reference. A quoted photo has no text of its own, so
                    the quote says what it is instead of sitting empty. */}
                {m.reply_to && (
                  <div style={{ padding: '4px 10px', marginBottom: '2px', borderRadius: '8px', backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-default)' }}>
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>{m.reply_to.sender}</span>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '1px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{messagePreview({ ...m.reply_to, hadContent: true })}</p>
                  </div>
                )}
                {/* A send the server never acknowledged. The photo is still in
                    this bubble, so retrying costs one tap and never asks for
                    the picture again (upload contract, SLOP-AUDIT J3). */}
                {m.failed && (
                  <div role="alert">
                    {/* role="alert" on a wrapper, not on the button: a button
                        that claims the alert role stops announcing as a
                        button. This text arrives on an eight second timeout
                        with no keypress behind it, so without a region a
                        screen reader user is left believing it sent. */}
                  <button className="hit44" onClick={() => retryFailedDm(selectedDmId, m)} style={{ background: 'none', border: 'none', padding: '0 4px 4px', cursor: 'pointer', fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--accent-red-text, #b91c1c)', display: 'block', marginLeft: 'auto' }}>
                    Didn't send. Tap to retry
                  </button>
                  </div>
                )}
                {/* Venue card message. Same VenueCard as flocks, and wrapped in
                    the same tap target as text and photo bubbles so it can be
                    reported. The card's own buttons stop propagation. */}
                {m.message_type === 'venue_card' && m.venue_data ? (
                  <div
                    onClick={() => setShowDmReactionPicker(showDmReactionPicker === m.id ? null : m.id)}
                    /* The DM picker is absolutely positioned against the bottom
                       of the row. On a venue card that is exactly where View
                       Details and Vote sit, so open the space rather than cover
                       the buttons with the row that reports them. */
                    style={{ cursor: 'pointer', paddingBottom: showDmReactionPicker === m.id ? '40px' : 0 }}
                  >
                  <VenueCard
                    venue={m.venue_data}
                    colors={colors}
                    Icons={Icons}
                    getCategoryColor={getCategoryColor}
                    onViewDetails={() => {
                      const vd = m.venue_data;
                      const pid = vd.place_id;
                      if (pid) {
                        leaveDmScreen();
                        setVenueDetailReturnTo({ tab: 'chat', screen: 'dmDetail', dmId: selectedDmId });
                        setCurrentTab('explore');
                        setCurrentScreen('main');
                        setTimeout(() => {
                          openVenueDetail(pid, { name: vd.name, formatted_address: vd.addr, place_id: pid, rating: vd.stars || vd.rating, photo_url: vd.photo_url }, { panMap: true });
                        }, 500);
                      }
                    }}
                    onVote={() => {
                      const vName = m.venue_data.name;
                      const vId = m.venue_data.place_id;
                      const mn = authUser?.name;
                      const existing = dmVenueVotes.find(v => v.venue_name === vName);
                      if (existing && (existing.voters || []).includes(mn)) return;
                      if (existing) {
                        setDmVenueVotes(prev => prev.map(v => ({ ...v, voters: v.venue_name === vName ? [...(v.voters || []), mn] : (v.voters || []).filter(x => x !== mn), vote_count: v.venue_name === vName ? parseInt(v.vote_count || 0) + 1 : (v.voters || []).includes(mn) ? parseInt(v.vote_count || 0) - 1 : parseInt(v.vote_count || 0) })).filter(v => parseInt(v.vote_count || 0) > 0 || v.venue_name === vName));
                      } else {
                        setDmVenueVotes(prev => [...prev.map(v => ({ ...v, voters: (v.voters || []).filter(x => x !== mn), vote_count: (v.voters || []).includes(mn) ? parseInt(v.vote_count || 0) - 1 : parseInt(v.vote_count || 0) })).filter(v => parseInt(v.vote_count || 0) > 0), { venue_name: vName, venue_id: vId, vote_count: 1, voters: [mn] }]);
                      }
                      dmVoteVenue(selectedDmId, vName, vId);
                      trackDmVenueVote();
                    }}
                  />
                  </div>
                ) : m.message_type === 'image' && (m.image_url || m.thumb_url) ? (
                  /* Image message */
                  <button type="button" onClick={() => setShowDmReactionPicker(showDmReactionPicker === m.id ? null : m.id)} style={{ borderRadius: '18px', overflow: 'hidden', boxShadow: '0 2px 10px rgba(0,0,0,0.1)', borderTopRightRadius: m.sender === 'You' ? '4px' : '18px', borderTopLeftRadius: m.sender === 'You' ? '18px' : '4px', cursor: 'pointer', lineHeight: 0, padding: 0, border: 'none', background: 'none', display: 'block' }}>
                    {/* alt was the empty string, which told VoiceOver this
                        message had no content at all: an empty bubble where a
                        photo should be. */}
                    <img src={m.thumb_url || m.image_url} alt={`From ${m.sender}`} loading="lazy" style={{ width: '100%', maxWidth: '260px', maxHeight: '340px', objectFit: 'cover', display: 'block' }} />
                  </button>
                ) : (
                  /* Text message */
                  /* overflowWrap: 'anywhere' is load-bearing, not polish. The
                     row caps at 75% but a message with no spaces in it (a
                     pasted link, a keysmash, a wall of one repeated character)
                     has nowhere to break, so the bubble grew past the phone and
                     took the chat's horizontal scrollbar with it. SLOP-AUDIT
                     H19: nothing cut off at 320-390px. */
                  <button type="button" onClick={() => setShowDmReactionPicker(showDmReactionPicker === m.id ? null : m.id)} style={{ borderRadius: '16px', padding: '10px 14px', fontSize: 'var(--t-label)', overflowWrap: 'anywhere', backgroundColor: m.sender === 'You' ? (isDark ? '#1e3a5c' : colorsLight.navy) : 'var(--msg-received-bg)', color: m.sender === 'You' ? 'white' : 'var(--msg-received-text)', borderTopRightRadius: m.sender === 'You' ? '4px' : '16px', borderTopLeftRadius: m.sender === 'You' ? '16px' : '4px', boxShadow: 'var(--card-shadow-sm)', cursor: 'pointer', textAlign: 'left', font: 'inherit', display: 'inline-block', border: 'none' }}>
                    {showDmChatSearch && dmChatSearch.trim() && m.text?.toLowerCase().includes(dmChatSearch.toLowerCase()) ? (
                      m.text.split(new RegExp(`(${dmChatSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')).map((part, pi) =>
                        part.toLowerCase() === dmChatSearch.toLowerCase() ? <mark key={pi} style={{ background: 'var(--search-highlight)', color: 'inherit', borderRadius: '2px', padding: '0 1px' }}>{part}</mark> : part
                      )
                    ) : m.text}
                  </button>
                )}
                {/* Reactions display. groupReactions, the same helper the flock
                    side uses, so a DM reaction read back from history keeps the
                    id of who left it and ownership is compared as a string. The
                    old inline reduce dropped user_id from the key and compared
                    r.user_id === authUser.id with ===, so a reaction survived a
                    reload as a pill you could see but could no longer take back:
                    the REST history hands user_id back as a number while the
                    live socket payload hands it back as a string, so strict
                    equality answered false for your own reaction after a reload. */}
                {m.reactions && m.reactions.length > 0 && (
                  <div style={{ display: 'flex', gap: '4px', marginTop: '4px', flexWrap: 'wrap', justifyContent: m.sender === 'You' ? 'flex-end' : 'flex-start' }}>
                    {groupReactions(m.reactions).map((g) => {
                      const mine = g.userIds.some((id) => String(id) === String(authUser?.id));
                      return (
                        <button
                          key={g.emoji}
                          type="button"
                          className="reaction-pop hit44"
                          aria-pressed={mine}
                          aria-label={`${g.emoji} ${g.count}${mine ? ', including you. Tap to remove your reaction' : '. Tap to react'}`}
                          onClick={() => { const otherUser = selectedDmId; if (mine) { dmRemoveReact(m.id, g.emoji, otherUser); } else { dmReact(m.id, g.emoji, otherUser); } }}
                          style={{ fontSize: 'var(--t-meta)', backgroundColor: 'var(--bg-card-solid)', border: mine ? `1px solid ${colors.steel}` : '1px solid var(--border-default)', borderRadius: '12px', padding: '2px 6px', cursor: 'pointer', boxShadow: 'var(--card-shadow-sm)', display: 'inline-flex', alignItems: 'center', gap: '3px', minHeight: 'auto' }}
                        >{g.emoji} {g.count > 1 ? g.count : ''}</button>
                      );
                    })}
                  </div>
                )}
                {/* Reaction picker */}
                {showDmReactionPicker === m.id && (
                  <div style={{ display: 'flex', gap: '4px', marginTop: '4px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '16px', padding: '4px 8px', boxShadow: '0 2px 12px rgba(0,0,0,0.15)', position: 'absolute', [m.sender === 'You' ? 'right' : 'left']: 0, bottom: '-8px', zIndex: 5 }}>
                    {dmReactions.map(emoji => (
                      <button aria-label={`React with ${emoji}`} className="hit44" key={emoji} onClick={(e) => { e.stopPropagation(); dmReact(m.id, emoji, selectedDmId); setShowDmReactionPicker(null); }} style={{ fontSize: 'var(--t-title)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px', borderRadius: '8px', transition: 'transform 0.15s' }}
                        onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.3)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
                      >{emoji}</button>
                    ))}
                    {m.sender === 'You' && typeof m.id === 'number' && m.id <= 2147483647 && (
                      <button aria-label="Unsend message" className="hit44" onClick={(e) => { e.stopPropagation(); setShowDmReactionPicker(null); handleUnsendDm(m.id); }} style={{ fontSize: 'var(--t-meta)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: '8px', color: 'var(--text-secondary)', fontWeight: '600' }} title="Unsend">Unsend</button>
                    )}
                    {m.message_type === 'image' && (m.image_url || m.thumb_url) && (
                      <button aria-label="View photo full size" className="hit44" onClick={(e) => { e.stopPropagation(); setShowDmReactionPicker(null); openImageViewer(m); }} style={{ fontSize: 'var(--t-body)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: '8px', color: colors.navy, fontWeight: '600' }} title="View photo">{Icons.eye(colors.navy, 14)}</button>
                    )}
                    <button aria-label="Reply" className="hit44" onClick={(e) => { e.stopPropagation(); setDmReplyingTo(m); setShowDmReactionPicker(null); }} style={{ fontSize: 'var(--t-body)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: '8px', color: colors.navy, fontWeight: '600' }} title="Reply">{Icons.reply(colors.navy, 14)}</button>
                    {m.sender !== 'You' && (
                      <button aria-label="Report" className="hit44" onClick={(e) => { e.stopPropagation(); setShowDmReactionPicker(null); setModerationTarget({ userId: selectedDmId, userName: selectedDm.name, contentType: 'dm', contentId: m.id }); }} style={{ fontSize: 'var(--t-body)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: '8px', color: '#EF4444', fontWeight: '600' }} title="Report">{Icons.flag('#EF4444', 15)}</button>
                    )}
                  </div>
                )}
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '4px 4px 0', textAlign: m.sender === 'You' ? 'right' : 'left' }}>{m.pending ? 'Sending' : getRelativeTime(m.time)}</p>
              </div>
            </div>
            </React.Fragment>
            );
            });
          })()
        )}
        {/* Typing indicator */}
        {/* `visibility` as well as opacity. See the same indicator in
            screens/ChatDetail.js: opacity alone leaves the name in the
            accessibility tree when nobody is typing. */}
        <div style={{ height: '50px', overflow: 'hidden', opacity: dmIsTyping ? 1 : 0, visibility: dmIsTyping ? undefined : 'hidden', transition: `opacity 0.2s ease, visibility 0s linear ${dmIsTyping ? '0s' : '0.2s'}`, pointerEvents: dmIsTyping ? 'auto' : 'none' }}>
          <div style={{ display: 'flex', gap: '10px' }}>
            <div style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: 'var(--bg-card-solid)', border: '2px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>{selectedDm.name?.[0] || '?'}</div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
              <span style={{ fontSize: 'var(--t-meta)', color: colors.navy, fontWeight: '500', marginBottom: '4px', paddingLeft: '4px' }}>{dmTypingUser || selectedDm.name}</span>
              <div style={{ padding: '10px 16px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '18px', borderBottomLeftRadius: '4px', boxShadow: '0 2px 10px rgba(0,0,0,0.05)', display: 'flex', alignItems: 'center', gap: '3px' }}>
                <div style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: colors.navyBg, animation: 'typingDot 1.4s ease-in-out infinite', opacity: 0.7 }} />
                <div style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: colors.navyBg, animation: 'typingDot 1.4s ease-in-out 0.2s infinite', opacity: 0.7 }} />
                <div style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: colors.navyBg, animation: 'typingDot 1.4s ease-in-out 0.4s infinite', opacity: 0.7 }} />
              </div>
            </div>
          </div>
        </div>
        {showJumpPill && (
          <div style={{ position: 'sticky', bottom: '8px', display: 'flex', justifyContent: 'center', zIndex: 5, pointerEvents: 'none' }}>
            <button className="hit44" onClick={() => dmEndRef?.current?.scrollIntoView({ behavior: 'smooth' })} style={{ pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px', borderRadius: '18px', border: '1px solid var(--border-default)', background: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,0.14)' }}>
              {Icons.chevronDown(colors.navy, 14)} Jump to latest
            </button>
          </div>
        )}
        <div ref={dmEndRef} />
        <div ref={dmChatEndRef} />
      </div>

      {/* The server refused this conversation. Standing, not a toast: retrying
          will be refused identically, so the screen has to say what is wrong
          and offer the one action that changes the answer. The wording covers
          both halves of the server's single refusal, since the account may not
          exist at all, without telling the sender which one it was, which
          whole reason that refusal is one sentence. */}
      {/* Blocked, either direction. The composer below is replaced rather than
          disabled: a greyed-out text field with no explanation is the state
          this is fixing. */}
      {dmBlocked[String(selectedDmId)] && (
        <div style={{ padding: '14px 16px calc(14px + var(--safe-bottom))', borderTop: '1px solid var(--divider)', backgroundColor: 'var(--bg-tertiary)', flexShrink: 0 }}>
          <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-primary)', margin: '0 0 4px' }}>You can no longer message {selectedDm.name}</p>
          <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
            This conversation is closed on both sides. Anyone you have blocked yourself can be unblocked in Settings, under Blocked accounts.
          </p>
        </div>
      )}

      {!dmBlocked[String(selectedDmId)] && dmNotConnected[selectedDmId] && (
        <div style={{ padding: '12px 14px', borderTop: '1px solid var(--divider)', backgroundColor: 'var(--bg-tertiary)', flexShrink: 0 }}>
          <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-primary)', margin: '0 0 4px' }}>You are not connected to {selectedDm.name} yet</p>
          <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.5 }}>
            Messages start going through once they accept your friend request. Until then nothing you send here is delivered.
          </p>
          <button
            className="hit44 glass-btn glass-secondary"
            disabled={dmRequestSending}
            onClick={async () => {
              setDmRequestSending(true);
              try {
                await sendFriendRequest(selectedDmId);
                showToast(`Friend request sent to ${selectedDm.name}.`);
              } catch (err) {
                showToast(err?.message || "That request didn't send. Try again.", 'error');
              } finally {
                setDmRequestSending(false);
              }
            }}
            style={{ padding: '10px 14px', borderRadius: '12px', border: `1.5px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-label)', fontWeight: '600', cursor: dmRequestSending ? 'default' : 'pointer', opacity: dmRequestSending ? 0.6 : 1 }}
          >
            {dmRequestSending ? 'Sending request' : 'Send a friend request'}
          </button>
        </div>
      )}

      {/* Reply bar */}
      {dmReplyingTo && (
        <div style={{ padding: '8px 12px', borderTop: '1px solid var(--divider)', backgroundColor: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          <div style={{ flex: 1, paddingLeft: '10px', borderRadius: '8px', backgroundColor: 'var(--bg-tertiary)', padding: '6px 10px' }}>
            <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>Replying to {dmReplyingTo.sender}</span>
            <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '1px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{messagePreview(dmReplyingTo)}</p>
          </div>
          <button aria-label="Cancel reply" className="hit44" onClick={() => setDmReplyingTo(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>{Icons.x(colors.textSecondary, 14)}</button>
        </div>
      )}

      {/* Input bar — text + camera + venue search + send */}
      {/* DM composer. The DM conversation screen does not render the tab bar,
          so this row IS the bottom of the phone and carries the home-indicator
          inset itself (SAFE-AREA CONTRACT in index.css). It is not rendered at
          all for a blocked pair: the bar above has taken its place and its
          safe-area inset with it. */}
      {!dmBlocked[String(selectedDmId)] && (
      <div style={{ padding: '10px 12px calc(10px + var(--safe-bottom))', borderTop: '1px solid var(--divider)', backgroundColor: 'var(--bg-card-solid)' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {/* Camera and camera roll, both one tap (see the flock composer). */}
          <button aria-label="Take a photo" className="hit44" onClick={() => openCameraViewfinder('dm')} style={{ width: '36px', height: '36px', borderRadius: '18px', backgroundColor: 'var(--bg-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, border: 'none', position: 'relative' }}>
            {Icons.camera(colors.textSecondary, 16)}
          </button>
          <button aria-label="Choose a photo from your library" className="hit44" onClick={() => dmGalleryInputRef.current?.click()} style={{ width: '36px', height: '36px', borderRadius: '18px', backgroundColor: 'var(--bg-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, border: 'none' }}>
            {Icons.image(colors.textSecondary, 16)}
          </button>
          <input ref={dmGalleryInputRef} type="file" accept="image/*" onChange={handleDmImageSelect} style={{ display: 'none' }} />
          {/* Location share button */}
          <button aria-label="Share your location" className="hit44" onClick={() => { if (dmSharingLocation) { dmStopSharingLocation(dmSharingLocation); setDmSharingLocation(null); setDmMemberLocation(null); } else { setDmSharingLocation(selectedDmId); } }} style={{ width: '36px', height: '36px', borderRadius: '18px', backgroundColor: dmSharingLocation ? '#10b981' : 'var(--bg-hover)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>{Icons.mapPin(dmSharingLocation ? 'white' : colors.textSecondary, 16)}</button>
          {/* minWidth:0 / flexShrink:0 — same story as the flock composer. */}
          <input data-dm-input aria-label="Message" type="text" defaultValue="" onChange={handleDmInputChange} onKeyDown={(e) => e.key === 'Enter' && sendDmMessage()} placeholder={dmReplyingTo ? `Reply...` : `Message ${selectedDm.name}...`} style={{ flex: '1 1 0%', minWidth: 0, padding: '15px 18px', borderRadius: '24px', backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', fontSize: '16px', outline: 'none' }} autoComplete="off" />
          <button aria-label="Send" className="hit44 glass-btn glass-navy" onClick={() => sendDmMessage()} disabled={!chatInputHasText} style={{ width: '42px', height: '42px', minWidth: '42px', flexShrink: 0, borderRadius: '21px', border: 'none', background: chatInputHasText ? colors.navyBg : 'var(--pill-bg)', color: 'white', cursor: chatInputHasText ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.send('white', 18)}</button>
        </div>
      </div>
      )}

    </div>
  );
}
