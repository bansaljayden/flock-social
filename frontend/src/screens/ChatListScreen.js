/**
 * CHAT LIST SCREEN
 *
 * The Messages tab: the direct message rows, the pending flock invites, the
 * flocks themselves with the pin-and-reorder edit mode, the declined plans
 * kept so a no on Tuesday has a way back on Friday, and the loading, failed
 * read and empty states underneath them.
 *
 * It was 395 lines of App.js, declared as an arrow function inside
 * FlockAppInner and CALLED rather than mounted, which is the same shape the
 * Plans tab, the venue dashboard, the flock chat, the DM thread, Add Friends,
 * the profile and settings screen, the flock detail screen, the create screen
 * and past flocks were in before they moved out. App.js is the bulk of the
 * boot chunk, and every byte of this screen was downloaded before the Nest
 * painted, including by the accounts that never open Messages at all.
 *
 * WHY THIS ONE IS LAZY
 *
 * currentScreen starts at 'main' (or 'nfcCheckin' on a tag) with currentTab at
 * 'home', never at 'chat', and nothing routes here from a URL, so this screen
 * cannot be on screen at first paint. It is reached by a deliberate tap on
 * Messages in the bottom nav, and the idle prefetch in App.js warms the chunk
 * once the Nest has painted, so that tap resolves from the module cache and
 * renders in the same commit.
 *
 * WHY IT IS WARMED FIRST OF ALL OF THEM
 *
 * The Plans tab can afford to sit seventh in that warm list. This one cannot.
 * Messages is opened within seconds of signing in, which is the one window in
 * which a bare lazy would still be on the wire when the tap lands, so it goes
 * at the head of the idle warm, ahead of the flock chat and the DM thread it
 * is the door to. It can afford to be first: at a fraction of their size it
 * takes almost nothing of the connection the order below it was measured on,
 * and both of those screens are reached THROUGH this list anyway, so warming
 * the list first is warming the path in the order a person walks it.
 *
 * WHY EVERYTHING ARRIVES AS A PROP
 *
 * The old arrow function closed over 51 names. Forty-six are declared in
 * FlockAppInner or at App.js module scope and are the parameters below, built
 * at the call site with object shorthand so the name there and the parameter
 * here cannot drift apart. Three of them (conversationStamp, flockTileInitial,
 * flockTileSwatch) are App.js module-scope helpers this screen is now the only
 * reader of, and they stayed behind on purpose: chatSurface.test.js executes
 * conversationStamp by extracting its declaration out of App.js, and moving
 * helpers is a second move. Four more (EmptyMark, ListSkeleton,
 * SearchInputLocal, messagePreview) are module-scope declarations App.js still
 * hands to screens other than this one.
 *
 * The other five (BirdieStill, BirdNote, WARM_BIRD, Icons, onVenuePhotoError)
 * are module imports App.js already pulls from '../components/ui/BirdieBird',
 * '../components/ui/Icons' and '../lib/venuePhoto', so this file imports them
 * straight from the source rather than taking them as props. The list came
 * from a Babel scope walk over the block, not from reading it, so nothing was
 * missed.
 *
 * WHAT DID NOT MOVE
 *
 * Every piece of state the screen reads stays declared in FlockAppInner, which
 * does not unmount when the tab changes. So the pinned flocks, the custom
 * order, whether the list is in edit mode, whether the search box is open and
 * what is typed in it all survive leaving Messages and coming back, exactly as
 * they did when this function was declared there.
 *
 * This is a MOVE. The body below is the block that was in App.js, character
 * for character, at the indentation it had there. Nothing was renamed,
 * reformatted or improved on the way across, and no defect was fixed in
 * transit.
 */
import React from 'react';
import { BirdieStill, BirdNote, WARM_BIRD } from '../components/ui/BirdieBird';
import Icons from '../components/ui/Icons';
import { onVenuePhotoError } from '../lib/venuePhoto';

export default function ChatListScreen({
  // Declared at App.js module scope and shared with screens other than this
  // one, so they stay declared there and arrive here.
  EmptyMark,
  ListSkeleton,
  SearchInputLocal,
  messagePreview,
  // Also App.js module scope, and read by this screen alone now. Left there
  // rather than moved because a suite extracts conversationStamp out of App.js
  // to run it, and because moving them would be a second move.
  conversationStamp,
  flockTileInitial,
  flockTileSwatch,
  // Everything else is declared in FlockAppInner and stays declared there.
  BottomNav,
  SafetyButton,
  chatListSearchRef,
  chatSearch,
  colors,
  declinedFlockInvites,
  directMessages,
  dmsError,
  dmsLoading,
  editingFlockList,
  feedScroll,
  flockOrder,
  flocks,
  flocksError,
  flocksLoading,
  getRelativeTime,
  handleAcceptFlockInvite,
  handleDeclineFlockInvite,
  handleRejoinDeclinedFlock,
  highlightedInviteId,
  loadDmConversations,
  loadFlocks,
  openUserProfile,
  pendingFlockInvites,
  pinnedFlockIds,
  setChatSearch,
  setCurrentScreen,
  setCurrentTab,
  setDirectMessages,
  setEditingFlockList,
  setFlockOrder,
  setPinnedFlockIds,
  setSelectedDmId,
  setSelectedFlockId,
  setShowChatSearch,
  setShowNewDmModal,
  showChatSearch,
  simulateTyping,
  styles,
}) {
    const totalConversations = flocks.length + directMessages.length;
    // Both lists on this screen fetch on mount. Until they answer, the screen
    // shows skeleton rows rather than "No conversations yet".
    const conversationsLoading = (flocksLoading || dmsLoading) && totalConversations === 0;
    // And if either read FAILED, the screen has not learned that this inbox is
    // empty, so it may not say so. One card covers both, because a user does
    // not care which of two fetches missed, and the retry runs whichever did.
    const conversationsError = flocksError || dmsError;
    const retryConversations = () => {
      if (flocksError) loadFlocks();
      if (dmsError) loadDmConversations();
    };

    // Sort flocks: pinned first, then by custom order, then default
    const sortedFlocks = [...flocks].sort((a, b) => {
      const aPinned = pinnedFlockIds.includes(a.id);
      const bPinned = pinnedFlockIds.includes(b.id);
      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;
      const aOrder = flockOrder.indexOf(a.id);
      const bOrder = flockOrder.indexOf(b.id);
      if (aOrder !== -1 && bOrder !== -1) return aOrder - bOrder;
      if (aOrder !== -1) return -1;
      if (bOrder !== -1) return 1;
      return 0;
    });

    const filteredDms = directMessages.filter(dm => !chatSearch || dm.name.toLowerCase().includes(chatSearch.toLowerCase()));
    const filteredFlocks = sortedFlocks.filter(f => !chatSearch || f.name.toLowerCase().includes(chatSearch.toLowerCase()));
    const filteredDeclinedInvites = declinedFlockInvites.filter(f => !chatSearch || f.name.toLowerCase().includes(chatSearch.toLowerCase()));

    // The swap happens between the two VISIBLE neighbours but is written into
    // the full order; writing the filtered list as the order threw away every
    // plan the search had hidden, on every device (lifecycle audit,
    // 2026-09-05).
    const swapInFullOrder = (flockId, otherId) => {
      const full = sortedFlocks.map(f => f.id);
      const i = full.indexOf(flockId);
      const j = full.indexOf(otherId);
      if (i === -1 || j === -1) return;
      [full[i], full[j]] = [full[j], full[i]];
      setFlockOrder(full);
    };

    const moveFlockUp = (flockId) => {
      const visible = filteredFlocks.map(f => f.id);
      const idx = visible.indexOf(flockId);
      if (idx <= 0) return;
      // Only swap within the same group (pinned/unpinned)
      const isPinned = pinnedFlockIds.includes(flockId);
      const aboveIsPinned = pinnedFlockIds.includes(visible[idx - 1]);
      if (isPinned !== aboveIsPinned) return;
      swapInFullOrder(flockId, visible[idx - 1]);
    };

    const moveFlockDown = (flockId) => {
      const visible = filteredFlocks.map(f => f.id);
      const idx = visible.indexOf(flockId);
      if (idx === -1 || idx >= visible.length - 1) return;
      const isPinned = pinnedFlockIds.includes(flockId);
      const belowIsPinned = pinnedFlockIds.includes(visible[idx + 1]);
      if (isPinned !== belowIsPinned) return;
      swapInFullOrder(flockId, visible[idx + 1]);
    };

    const togglePin = (flockId) => {
      setPinnedFlockIds(prev => prev.includes(flockId) ? prev.filter(id => id !== flockId) : [...prev, flockId]);
    };

    return (
      <div key="chat-list-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--bg-primary)' }}>
        {/* Header */}
        <div style={{ padding: '20px 16px 16px', background: colors.navyBg, flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--t-display)', fontWeight: '600', color: 'white', margin: 0, letterSpacing: '-0.005em' }}>Messages</h1>
              <p style={{ fontSize: 'var(--t-meta)', color: 'rgba(255,255,255,0.5)', margin: '2px 0 0', fontWeight: '500' }}>{totalConversations} conversation{totalConversations !== 1 ? 's' : ''}</p>
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button aria-label="Reorder your flocks" className="hit44" onClick={() => setEditingFlockList(!editingFlockList)} style={{ width: '36px', height: '36px', borderRadius: '12px', border: editingFlockList ? '2px solid white' : 'none', backgroundColor: editingFlockList ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.12)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'opacity 0.2s' }}>
                {Icons.gripVertical('white', 16)}
              </button>
              <button aria-label="New message" className="hit44" onClick={() => setShowNewDmModal(true)} style={{ width: '36px', height: '36px', borderRadius: '12px', border: 'none', backgroundColor: 'var(--icon-bg)', color: colors.navy, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'opacity 0.2s', boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
                {Icons.plus(colors.navy, 16)}
              </button>
              <button aria-label="Search chats" className="hit44" onClick={() => { setShowChatSearch(!showChatSearch); if (!showChatSearch) setTimeout(() => chatListSearchRef.current?.focus(), 50); }} style={{ width: '36px', height: '36px', borderRadius: '12px', border: 'none', backgroundColor: showChatSearch ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.12)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'opacity 0.2s' }}>
                {Icons.search('white', 16)}
              </button>
            </div>
          </div>

          {/* Search bar */}
          {showChatSearch && (
            <div style={{ marginTop: '12px', position: 'relative' }}>
              <SearchInputLocal aria-label="Search conversations" inputRef={chatListSearchRef} type="text" initialValue={chatSearch} onCommit={setChatSearch} placeholder="Search conversations..." style={{ width: '100%', padding: '10px 14px 10px 36px', borderRadius: '12px', border: 'none', fontSize: 'var(--t-label)', fontWeight: '500', outline: 'none', backgroundColor: 'var(--bg-input)', color: 'var(--text-primary)', boxSizing: 'border-box' }} autoComplete="off" />
              <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }}>{Icons.search(colors.textTertiary, 14)}</span>
            </div>
          )}

          {/* Edit mode banner */}
          {editingFlockList && (
            <div style={{ marginTop: '10px', padding: '8px 12px', backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: '10px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: 'var(--t-meta)', color: 'rgba(255,255,255,0.9)', fontWeight: '500', flex: 1 }}>Tap arrows to reorder, pin to keep on top</span>
              <button className="hit44" onClick={() => setEditingFlockList(false)} style={{ background: 'none', border: 'none', color: colors.cream, cursor: 'pointer', fontSize: 'var(--t-meta)', fontWeight: '600', padding: '2px 8px' }}>Done</button>
            </div>
          )}
        </div>

        <div ref={feedScroll.chat.ref} onScroll={feedScroll.chat.onScroll} style={{ flex: 1, overflowY: 'auto', padding: '8px 12px 12px' }}>
          {/* Direct Messages section */}
          {filteredDms.length > 0 && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 4px 8px' }}>
                <span style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Direct Messages</span>
                <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--pill-bg)' }} />
              </div>
              {filteredDms.map((dm) => {
                // GET /api/dm returns the stored body and no message_type, so a
                // conversation whose last message was a photo arrives with an
                // empty string. `hadContent` is what tells the preview that an
                // empty body here is a real message, not an empty inbox.
                const lastMsg = dm.messages?.length > 0
                  ? dm.messages[dm.messages.length - 1]
                  : (dm.lastMessage || dm.lastMessageTime
                      ? { text: dm.lastMessage || '', sender: dm.lastMessageIsYou ? 'You' : dm.name, hadContent: true }
                      : null);
                const lastMsgPreview = messagePreview(lastMsg);
                return (
                  <button className="hit44" key={`dm-${dm.userId}`} onClick={() => { setSelectedDmId(dm.userId); setCurrentScreen('dmDetail'); setDirectMessages(prev => prev.map(d => d.userId === dm.userId ? { ...d, unread: 0 } : d)); }} style={{ width: '100%', textAlign: 'left', backgroundColor: 'var(--bg-card-solid)', borderRadius: '16px', padding: '12px 14px', marginBottom: '6px', border: dm.unread ? `1.5px solid ${colors.navy}15` : `1px solid var(--border-default)`, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px', transition: 'opacity 0.2s', boxShadow: dm.unread ? '0 2px 12px rgba(13,40,71,0.08)' : '0 1px 4px rgba(0,0,0,0.03)' }}>
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <div style={{ width: '46px', height: '46px', borderRadius: '23px', background: colors.navyBg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-title)', fontWeight: '700', color: 'white', overflow: 'hidden' }}>
                        {dm.image ? <img src={dm.image} alt="" style={{ width: '46px', height: '46px', borderRadius: '23px', objectFit: 'cover' }} /> : (dm.name?.[0]?.toUpperCase() || '?')}
                      </div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '3px' }}>
                        <h2 style={{ fontSize: 'var(--t-body)', fontWeight: dm.unread ? '600' : '600', color: colors.navy, margin: 0 }}>{dm.name}</h2>
                        {dm.lastMessageTime && <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', fontWeight: '500' }}>{conversationStamp(dm.lastMessageTime)}</span>}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                <p style={{ fontSize: 'var(--t-meta)', color: dm.unread ? colors.navy : 'var(--text-tertiary)', fontWeight: dm.unread ? '500' : '400', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lastMsgPreview && lastMsg?.sender === 'You' ? 'You: ' : ''}{lastMsgPreview || 'Start a conversation'}</p>
                      </div>
                    </div>
                    {dm.unread > 0 && (
                      <div style={{ minWidth: '20px', height: '20px', padding: '0 6px', borderRadius: '10px', background: 'linear-gradient(135deg, #EF4444, #DC2626)', color: 'white', fontSize: 'var(--t-meta)', fontWeight: '500', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        {dm.unread > 99 ? '99+' : dm.unread}<span className="sr-only"> unread messages</span>
                      </div>
                    )}
                  </button>
                );
              })}
            </>
          )}

          {/* Pending Flock Invites */}
          {pendingFlockInvites.length > 0 && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 4px 8px' }}>
                <span style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: '#F59E0B', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Pending Invites</span>
                <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--pill-bg)' }} />
                <span style={{ width: '18px', height: '18px', borderRadius: '9px', background: '#F59E0B', color: 'white', fontSize: 'var(--t-meta)', fontWeight: '500', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{pendingFlockInvites.length}</span>
              </div>
              {pendingFlockInvites.map((f) => {
                // A notification tap for this invite lands on this list, so the
                // card it meant is called out and scrolled to. Without it the
                // tap drops you on a list and leaves you to work out which row
                // the buzz was about.
                const tapped = highlightedInviteId === f.id;
                return (
                <div
                  key={`invite-${f.id}`}
                  ref={tapped ? (el) => { if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); } : undefined}
                  style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '16px', padding: '12px 14px', marginBottom: '6px', border: tapped ? '2px solid #F59E0B' : '1.5px solid #FDE68A', display: 'flex', alignItems: 'center', gap: '12px', boxShadow: tapped ? '0 0 0 4px rgba(245,158,11,0.18)' : '0 2px 12px rgba(245,158,11,0.08)' }}
                >
                  <div style={{ width: '46px', height: '46px', borderRadius: '14px', background: '#F59E0B', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 8px rgba(245,158,11,0.2)', flexShrink: 0 }}>
                    {Icons.mail('white', 20)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h2 style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: '0 0 2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</h2>
                    {/* An invite can arrive from someone you have never met and
                        whose flock you cannot see yet, so this name was the one
                        place in the app with a person and no way to act on
                        them. Tapping it opens the person card. */}
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>
                      Invited by{' '}
                      {f.hostId != null ? (
                        <button
                          aria-label={`About ${f.host}`}
                          onClick={() => openUserProfile({ id: f.hostId, name: f.host })}
                          style={{ background: 'none', border: 'none', padding: 0, fontSize: 'inherit', fontFamily: 'inherit', fontWeight: '600', color: colors.navy, textDecoration: 'underline', cursor: 'pointer' }}
                        >
                          {f.host}
                        </button>
                      ) : f.host}
                    </p>
                    {/* A decision needs the when, the where and the who. */}
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.time && f.time !== 'TBD' ? f.time : 'Time still open'} · {f.venue && f.venue !== 'TBD' ? f.venue : 'Venue still open'} · {f.memberCount || 1} going
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                    <button aria-label="Decline invite" className="hit44" onClick={() => handleDeclineFlockInvite(f.id)} style={{ width: '32px', height: '32px', borderRadius: '10px', border: '1.5px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {Icons.x(colors.textTertiary, 14)}
                    </button>
                    <button aria-label="Accept invite" className="hit44" onClick={() => handleAcceptFlockInvite(f.id)} style={{ width: '32px', height: '32px', borderRadius: '10px', border: 'none', background: colors.navyBg, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {Icons.check('white', 14)}
                    </button>
                  </div>
                </div>
                );
              })}
            </>
          )}

          {/* Flocks section */}
          {filteredFlocks.length > 0 && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 4px 8px' }}>
                <span style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Flocks</span>
                <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--pill-bg)' }} />
                <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', fontWeight: '500' }}>{filteredFlocks.length}</span>
              </div>
              {filteredFlocks.map((f, idx) => {
                const isPinned = pinnedFlockIds.includes(f.id);
                const lastMsg = f.messages[f.messages.length - 1];
                // A photo posted to a flock has no text, so the row said
                // "You: " and stopped. One line gets one label.
                const lastMsgPreview = messagePreview(lastMsg);
                // Server-backed since migration 056: unread_count seeds this
                // on every list load, the socket handler increments it live,
                // and opening the chat zeroes it and advances the cursor.
                // flockSeen is only the PUT watermark now, not the badge.
                const hasUnread = (f.unread || 0) > 0;
                const statusColor = f.status === 'completed' ? '#4a7ba7' : f.status === 'confirmed' ? '#22C55E' : f.status === 'voting' ? '#F59E0B' : colors.steel;
                // statusColor is the DOT (decorative, keeps the vivid hue). The chip
                // LABEL sits on a 8%-alpha wash of the same hue, where the vivid
                // versions measured 2.02:1 ("Voting") to 2.28:1. These tokens are
                // theme-aware and clear 4.5:1 on both the light and dark card.
                const statusTextColor = f.status === 'completed' ? 'var(--accent-blue-text)' : f.status === 'confirmed' ? 'var(--accent-green-text)' : f.status === 'voting' ? 'var(--accent-amber-text)' : 'var(--accent-purple-text)';
                const statusLabel = f.status === 'completed' ? 'Done' : f.status === 'confirmed' ? 'Confirmed' : f.status === 'voting' ? 'Voting' : 'Planning';

                return (
                  <div key={`flock-${f.id}`} style={{ display: 'flex', alignItems: 'stretch', gap: '0', marginBottom: '6px' }}>
                    {/* Edit controls */}
                    {editingFlockList && (
                      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '2px', paddingRight: '6px', flexShrink: 0 }}>
                        <button aria-label="Move up" className="hit44" onClick={(e) => { e.stopPropagation(); moveFlockUp(f.id); }} style={{ width: '26px', height: '26px', borderRadius: '8px', border: 'none', backgroundColor: idx === 0 ? 'var(--bg-hover)' : 'var(--bg-card-solid)', cursor: idx === 0 ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', opacity: idx === 0 ? 0.4 : 1 }}>
                          {Icons.chevronUp(colors.navy, 14)}
                        </button>
                        <button aria-label="Move down" className="hit44" onClick={(e) => { e.stopPropagation(); moveFlockDown(f.id); }} style={{ width: '26px', height: '26px', borderRadius: '8px', border: 'none', backgroundColor: idx === filteredFlocks.length - 1 ? 'var(--bg-hover)' : 'var(--bg-card-solid)', cursor: idx === filteredFlocks.length - 1 ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', opacity: idx === filteredFlocks.length - 1 ? 0.4 : 1 }}>
                          {Icons.chevronDown(colors.navy, 14)}
                        </button>
                      </div>
                    )}

                    {/* Flock card */}
                    <button className="hit44" onClick={() => { if (editingFlockList) return; setSelectedFlockId(f.id); setCurrentScreen('chatDetail'); simulateTyping(); }} style={{ flex: 1, textAlign: 'left', backgroundColor: isPinned ? `${colors.navy}06` : 'var(--bg-card-solid)', borderRadius: '16px', padding: '12px 14px', border: isPinned ? `1.5px solid ${colors.navy}18` : `1px solid var(--border-default)`, cursor: editingFlockList ? 'default' : 'pointer', display: 'flex', alignItems: 'center', gap: '12px', transition: 'opacity 0.2s', boxShadow: isPinned ? '0 2px 12px rgba(13,40,71,0.06)' : '0 1px 4px rgba(0,0,0,0.03)', position: 'relative', overflow: 'hidden' }}>
                      {/* Tile — the flock's venue photo if it has picked one,
                          otherwise its initial on a colour keyed to its id. */}
                      <div style={{ position: 'relative', flexShrink: 0 }}>
                        {(() => {
                          const swatch = flockTileSwatch(f.id);
                          return (
                            <div style={{ width: '46px', height: '46px', borderRadius: '14px', overflow: 'hidden', boxShadow: '0 2px 10px rgba(13,40,71,0.18)', backgroundColor: swatch.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              {f.venuePhoto ? (
                                <img src={f.venuePhoto} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={onVenuePhotoError} />
                              ) : (
                                <span aria-hidden="true" style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--t-title)', fontWeight: '600', color: swatch.fg, lineHeight: 1, letterSpacing: '-0.01em' }}>{flockTileInitial(f.name)}</span>
                              )}
                            </div>
                          );
                        })()}
                        {/* Status dot */}
                        <div style={{ position: 'absolute', bottom: '-1px', right: '-1px', width: '14px', height: '14px', borderRadius: '7px', backgroundColor: statusColor, border: '2px solid var(--bg-card-solid)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {f.status === 'confirmed' && <span style={{ fontSize: 'var(--t-meta)', color: 'white', fontWeight: '500' }}>&#10003;</span>}
                        </div>
                      </div>

                      {/* Content */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0 }}>
                            {isPinned && <span style={{ flexShrink: 0 }}>{Icons.pinFilled(colors.navy, 12)}</span>}
                            <h2 style={{ fontSize: 'var(--t-body)', fontWeight: hasUnread ? '600' : '600', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</h2>
                          </div>
                          <span style={{ fontSize: 'var(--t-meta)', color: hasUnread ? colors.navy : '#b0b0b0', fontWeight: hasUnread ? '500' : '400', flexShrink: 0, marginLeft: '8px' }}>{getRelativeTime(lastMsg?.time)}</span>
                        </div>

                        {/* Venue + status row */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px' }}>
                          <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: statusTextColor, backgroundColor: `${statusColor}15`, padding: '1px 6px', borderRadius: '6px' }}>{statusLabel}</span>
                          {f.venue && f.venue !== 'TBD' && (
                            <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.venue}</span>
                          )}
                          <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', marginLeft: 'auto', flexShrink: 0 }}>{f.memberCount || 0} {Icons.users(colors.textTertiary, 12)}</span>
                        </div>

                        {/* Last message. Only drawn when there IS one to draw.
                            Flocks arrive from GET /api/flocks with no messages
                            attached and the history is fetched per chat on
                            entry, so on a cold start every row here said "No
                            messages yet", including flocks holding hundreds.
                            The row still carries the name, the stage, the venue
                            and the headcount, so an absent line is quieter than
                            a wrong sentence. */}
                        {lastMsg && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <p style={{ fontSize: 'var(--t-meta)', color: hasUnread ? colors.navy : 'var(--text-tertiary)', fontWeight: hasUnread ? '500' : '400', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{`${lastMsg.sender === 'You' ? 'You' : lastMsg.sender}: ${lastMsgPreview}`}</p>
                          </div>
                        )}
                      </div>

                      {/* Pin button (edit mode) or unread badge */}
                      {editingFlockList ? (
                        <button aria-label={isPinned ? 'Unpin' : 'Pin'} aria-pressed={isPinned} className="hit44" onClick={(e) => { e.stopPropagation(); togglePin(f.id); }} style={{ width: '32px', height: '32px', borderRadius: '10px', border: 'none', backgroundColor: isPinned ? `${colors.navy}12` : 'var(--bg-tertiary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'opacity 0.2s' }}>
                          {isPinned ? Icons.pinFilled(colors.navy, 16) : Icons.pin(colors.textTertiary, 16)}
                        </button>
                      ) : hasUnread && (
                        <div style={{ minWidth: '20px', height: '20px', borderRadius: '10px', padding: '0 6px', background: 'linear-gradient(135deg, #EF4444, #DC2626)', color: 'white', fontSize: 'var(--t-meta)', fontWeight: '500', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          {f.unread > 99 ? '99+' : f.unread}
                          <span className="sr-only"> unread messages</span>
                        </div>
                      )}
                    </button>
                  </div>
                );
              })}
            </>
          )}

          {/* Declined — plans this person said no to. Kept so a no on Tuesday
              has a way back when Friday frees up, following the server, which
              still returns these on every load. Never folded into the main
              flock list above: re-joining is one deliberate tap. */}
          {filteredDeclinedInvites.length > 0 && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 4px 8px' }}>
                <span style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Declined</span>
                <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--pill-bg)' }} />
              </div>
              {filteredDeclinedInvites.map((f) => (
                <div key={`declined-${f.id}`} style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '16px', padding: '12px 14px', marginBottom: '6px', border: '1px solid var(--border-default)', display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div style={{ width: '46px', height: '46px', borderRadius: '14px', backgroundColor: 'var(--icon-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <span aria-hidden="true" style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--t-title)', fontWeight: '600', color: 'var(--text-secondary)', lineHeight: 1 }}>{flockTileInitial(f.name)}</span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h2 style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: '0 0 2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</h2>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>You said you could not make it{f.host ? `. From ${f.host}` : ''}</p>
                  </div>
                  <button aria-label={`Join ${f.name}`} className="hit44 glass-btn glass-navy" onClick={() => handleRejoinDeclinedFlock(f.id)} style={{ padding: '8px 16px', borderRadius: '20px', border: 'none', background: colors.navyBg, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', flexShrink: 0, position: 'relative', overflow: 'hidden' }}>Join</button>
                </div>
              ))}
            </>
          )}

          {/* Loading */}
          {conversationsLoading && <ListSkeleton label="Loading conversations" />}

          {/* Failed read. Never suppressed by a search box: a search over a
              list that did not load is not a search that found nothing. */}
          {!conversationsLoading && conversationsError && (
            <div style={{ ...styles.card, marginBottom: '10px' }}>
              <BirdNote
                layout="row"
                size={48}
                bird={WARM_BIRD}
                role="alert"
                title={conversationsError}
                body="Nothing has been deleted. This is the list failing to load."
                action={<button className="hit44 glass-btn glass-navy" onClick={retryConversations} style={{ padding: '10px 16px', borderRadius: '10px', border: 'none', background: colors.navyMidBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-label)', cursor: 'pointer' }}>Try again</button>}
              />
            </div>
          )}

          {/* Empty state */}
          {!conversationsLoading && !conversationsError && filteredDms.length === 0 && filteredFlocks.length === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '8px 20px 24px', minHeight: chatSearch ? '0' : 'calc(100vh - 300px)' }}>
              {/* The mark belongs to the true-empty inbox. A search that found
                  nothing is a different state and gets the small icon. */}
              {chatSearch ? <BirdieStill bird={WARM_BIRD} size={72} /> : <EmptyMark name="crowd" />}
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: chatSearch ? 'var(--t-title)' : 'var(--t-display)', fontWeight: '600', color: 'var(--text-primary)', margin: '14px 0 0', letterSpacing: '-0.005em', lineHeight: 1.15 }}>{chatSearch ? 'No results found' : 'No conversations yet'}</h3>
              <p style={{ fontSize: 'var(--t-body)', color: 'var(--text-secondary)', margin: '6px 0 0', maxWidth: '280px' }}>{chatSearch ? 'Try a different search.' : 'Every flock gets its own chat. Start one and it shows up here.'}</p>
              {!chatSearch && (
                <button className="hit44" onClick={() => { setCurrentTab('home'); setCurrentScreen('create'); }} style={{ marginTop: '14px', minHeight: '44px', padding: '10px 14px', background: 'none', border: 'none', color: 'var(--accent-purple-text)', fontSize: 'var(--t-body)', fontWeight: '600', cursor: 'pointer' }}>Start a flock</button>
              )}
            </div>
          )}
        </div>
        {SafetyButton()}
        {BottomNav()}
      </div>
    );
}
