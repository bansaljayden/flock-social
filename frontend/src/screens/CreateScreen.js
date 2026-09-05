/**
 * START A FLOCK, THE CREATE SCREEN
 *
 * The screen behind the Nest's primary call to action: name the plan, pick
 * an optional venue, choose the day and the hour, invite people, and turn
 * the anonymous group budget on. It was 446 lines of App.js, declared as an
 * arrow function inside FlockAppInner and called rather than mounted. It
 * moved out on 2026-09-01, the ninth screen of the sweep that began with the
 * venue owner dashboard, for the reason every one of the eight before it
 * moved: a single file holding every screen in the product is a file nobody
 * can review.
 *
 * WHY THIS ONE IS A STATIC IMPORT
 *
 * The same call the flock chat, the DM thread and the flock plan detail
 * screen made. This is the first screen of the core loop and one of the two
 * calls to action a brand new account is given on an empty Nest, so
 * React.lazy would move it off the boot chunk and charge a round trip, plus
 * an empty Suspense fallback on a congested network, in front of a screen the
 * person opened deliberately. The flock chat header priced that exact trade
 * with three production builds and it came out negative for a screen users
 * open immediately. No fresh byte number was measured here, for the reason
 * DmDetail.js gives: the reasoning decides it, and inventing a number would
 * be worse than citing the sibling that measured one.
 *
 * WHY EVERYTHING ARRIVES AS A PROP
 *
 * The old arrow function closed over 61 names. Forty-one are declared in
 * FlockAppInner: the form state, the setters behind it, the invite search
 * handler, the shared style objects and the Toggle control. Thirteen more
 * are module-level helpers, constants and components that App.js declares
 * once, so they stay declared there and arrive here. Those 54 are the
 * parameters below, built at the call site with object shorthand so the name
 * there and the parameter here cannot drift apart. The remaining seven are
 * module imports App.js already pulls in from '../services/api',
 * '../services/haptics', '../components/ui/BirdieBird' and
 * '../components/ui/Icons', so this file imports them straight from the
 * source rather than taking them as props. The names were not read off the
 * page. They came from a Babel scope walk of the block, every referenced
 * identifier whose binding resolves outside it, and the parameter list below
 * and the props object at the call site were both generated from that one
 * array, so they cannot drift apart.
 *
 * The state and the effects behind these props deliberately did NOT move.
 * They live in FlockAppInner, which does not unmount when the user leaves
 * this screen, so a half-typed plan name, the friends already picked and the
 * chosen day and hour all survive a trip elsewhere exactly as they did
 * before. selectedVenueForCreate is the one that matters most: Browse venues
 * navigates to the Discover tab and comes back, so the picked venue has to
 * outlive a screen change or the control would lose the answer it just
 * collected.
 *
 * Toggle arrives as a prop rather than an import because it is still
 * declared inside FlockAppInner, and that is neither new nor an oversight.
 * This screen was called rather than mounted before the move, so Toggle was
 * already rebuilt on every render of the shell; moving the screen out does
 * not change that, because this is a move and not a fix. What did change is
 * who can see it: remountedSurfaces.test.js used to reach Toggle by walking
 * FlockAppInner's own JSX, and the mount is in this file now, so that suite
 * was widened in the same change to sweep the components FlockAppInner
 * declares and hands to a screen.
 *
 * The move on 2026-09-01 carried the old block across verbatim. Later the
 * same day the RENDER half was rebuilt (Jayden, TestFlight: "needs to be a
 * lot more detailed and needs to look a lot better. Follow the slop MD, and
 * I would add one or two of my bird graphics in there"), so the JSX below is
 * no longer a character-for-character copy of the deleted lines. handleCreate,
 * StarRating, priceLabel and dmTarget are untouched, every control is still
 * wired to exactly the prop it was wired to, and every string a test or the
 * Maestro flow reads is still here: the h1 "Start a Flock", the "Create
 * Flock" submit, the "Movie night, dinner, party..." placeholder, the "Search
 * by name..." invite field and every aria-label.
 *
 * WHAT THE REBUILD CHANGED, AND WHY
 *
 * The screen read as a settings form: four containers of equal weight, each
 * under an uppercase micro eyebrow, with one small mascot at the top and the
 * commit button under the budget toggle. Now:
 *
 *   - The warm bird opens the screen at a size that reads as a brand moment,
 *     beside the one sentence a first-time user needs. Warm, not cobalt: in
 *     this app cobalt Birdie is the AI (ChatDetail.js records the rule), and
 *     starting a flock is a thing people do, not a thing Birdie does.
 *   - Group labels sit outside their containers at the section-label size
 *     (SLOP-AUDIT section S, rule 4). index.css caps micro eyebrows at two per
 *     screen and there are four groups here, so the eyebrow label FormGroup
 *     draws is not used; GroupLabel below is the same shape the You tab uses.
 *     The label row also carries the group's current answer on the right,
 *     the way a settings row shows its value inline (section S, rule 2).
 *   - The venue and budget controls are rows in the shape every other list
 *     row in the app has: a 32px icon box, a title, a one-line fact, and the
 *     control at the right edge.
 *   - The roster row shows the second bird while the plan is just you, the
 *     exact composition FlockDetail uses for the same fact, and the bird
 *     leaves the moment a person is added.
 *   - The footer reads the whole plan back, name included, before it asks
 *     for the tap.
 *
 * Nothing on the screen claims a feature that does not ship. "Invites go out
 * as soon as the flock exists" is POST /api/flocks: a socket event to anyone
 * online and pushInvitesToOffline for everyone else.
 */
import React, { useEffect } from 'react';
import { createFlock as apiCreateFlock, sendMessage as apiSendMessage } from '../services/api';
import { hapticSuccess } from '../services/haptics';
import { BirdieStill, BirdNote, WARM_BIRD } from '../components/ui/BirdieBird';
import Icons from '../components/ui/Icons';

// The group signpost, outside the container. Section-label size in tertiary
// grey, with an optional right-aligned value so the label row answers "what
// is this set to" without the eye dropping into the card. Module scope on
// purpose: a component declared inside the screen body is a new type on
// every render and React remounts its subtree each time.
const GroupLabel = ({ children, aside }) => (
  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', margin: '0 4px 6px' }}>
    <h2 style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-tertiary)', margin: 0 }}>{children}</h2>
    {aside && (
      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-tertiary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{aside}</span>
    )}
  </div>
);

// The 32px icon box the You tab's rows lead with. One per row, never a grid
// of them, which is the difference between a list row and the tile grid A14
// bans.
const IconBox = ({ children }) => (
  <div aria-hidden="true" style={{ width: '32px', height: '32px', borderRadius: '8px', backgroundColor: 'var(--icon-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{children}</div>
);

// A small caption under a control. Tertiary, 1.5 leading, no margin above
// the first line so it hangs off the control it explains.
const Hint = ({ children, style }) => (
  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '6px 0 0', lineHeight: 1.5, ...style }}>{children}</p>
);

export default function CreateScreen({
  // Module-level helpers, constants and components that live in App.js and
  // are shared with screens other than this one, or are simply declared once
  // there, so they stay declared there and arrive here.
  ChoiceChip,
  DialogBehavior,
  FLOCK_DAY_CHOICES,
  FLOCK_HOUR_CHOICES,
  FormGroup,
  FormRow,
  ListSkeleton,
  SearchInputLocal,
  formatEventTime,
  isServerId,
  onVenuePhotoError,
  persistFailedFlockMessage,
  resolveEventTime,
  // Everything else is declared in FlockAppInner and stays declared there.
  Toggle,
  authUser,
  colors,
  flockBudgetContext,
  flockCashPool,
  flockDate,
  flockFriends,
  flockGhostMode,
  flockName,
  flockNameError,
  flockTime,
  handleInviteSearch,
  inviteResults,
  inviteSearch,
  inviteSearchError,
  inviteSearching,
  isLoading,
  needsEmailVerification,
  newlyCreatedFlockRef,
  selectedVenueForCreate,
  setCurrentScreen,
  setCurrentTab,
  setFlockBudgetContext,
  setFlockCashPool,
  setFlockDate,
  setFlockFriends,
  setFlockGhostMode,
  setFlockName,
  setFlockNameError,
  setFlockTime,
  setFlocks,
  setInviteResults,
  setInviteSearch,
  setIsLoading,
  setPickingVenueForCreate,
  setSelectedFlockId,
  setSelectedVenueForCreate,
  showToast,
  startNewDmWithUser,
  styles,
  suggestedUsers,
}) {
    const priceLabel = (level) => {
      if (!level) return '';
      return '$'.repeat(level);
    };

    // System stars, not a local drawing. The hand-rolled version predated the
    // icon system, reused id="halfStar" on every instance (duplicate DOM ids),
    // and was five silent glyphs. Rounding replaces the half-star gradient:
    // every other star row in the app rounds, and the exact figure is carried
    // by the label and the number printed beside the row.
    const StarRating = ({ rating }) => {
      if (!rating) return null;
      return (
        <div role="img" aria-label={`${rating} out of 5 stars`} style={{ display: 'flex', gap: '1px' }}>
          {[1, 2, 3, 4, 5].map(s => <React.Fragment key={s}>{s <= Math.round(rating) ? Icons.starFilled(colors.amber, 12) : Icons.star('var(--star-empty)', 12)}</React.Fragment>)}
        </div>
      );
    };

    // Exactly one person picked, and that person is a real account. The whole
    // footer changes shape around this: what the button does, what it says, and
    // what the read-back line above it claims is about to happen.
    const dmTarget = flockFriends.length === 1 && flockFriends[0]?.id ? flockFriends[0] : null;
    const dmFirstName = dmTarget ? String(dmTarget.name || '').split(' ')[0] : '';

    const handleCreate = async () => {
      if (!flockName.trim()) {
        setFlockNameError('Give the plan a name so your friends know what they are saying yes to.');
        showToast('Name your plan first', 'error');
        const input = document.getElementById('flock-name-input');
        if (input) { try { input.focus(); } catch { /* detached */ } }
        return;
      }
      setFlockNameError('');
      // ONE PERSON MEANS A DIRECT MESSAGE, AND THE SCREEN SAYS SO FIRST.
      //
      // Two people is a conversation, not a plan with a roster, so this path
      // stays. What it used to do is the defect: it fired silently from a
      // button labelled Create Flock, under a footer reading "You and 1 more",
      // and then wiped the name, the venue, the date, the time and the budget
      // on the way out, with no toast and no undo. The footer and the button
      // now name the DM and the person before the tap (see dmTarget below), and
      // NOTHING is cleared here: come back, add a second person, and everything
      // you typed is still on the screen.
      const invitedFriends = flockFriends.filter(f => f.id);
      if (invitedFriends.length === 1) {
        const friend = invitedFriends[0];
        startNewDmWithUser({ id: friend.id, name: friend.name, profile_image_url: friend.profile_image_url || null });
        return;
      }
      setIsLoading(true);

      // Capture form values before clearing
      const capturedName = flockName;
      const capturedVenue = selectedVenueForCreate;
      const capturedFriends = [...flockFriends];
      const venueName = capturedVenue?.name || null;
      const venueAddr = capturedVenue?.addr || capturedVenue?.formatted_address || null;
      const venueId = capturedVenue?.place_id || null;
      const venuePhoto = capturedVenue?.photo_url || null;
      const venueRating = capturedVenue?.rating || capturedVenue?.stars || null;
      const venuePriceLevel = capturedVenue?.price_level || null;
      const venueLat = capturedVenue?.lat || capturedVenue?.location?.latitude || null;
      const venueLng = capturedVenue?.lng || capturedVenue?.location?.longitude || null;
      const invitedIds = capturedFriends.map(f => f.id).filter(Boolean);
      // The When/Time chips were being collected and then thrown away: the POST
      // body carried no event_time at all, so every flock was created "TBD".
      const capturedFixedIso = capturedVenue?.event_datetime_utc
        || (capturedVenue?.event_date && capturedVenue?.event_time ? `${capturedVenue.event_date}T${capturedVenue.event_time}` : null);
      const capturedFixedAt = capturedFixedIso && !Number.isNaN(new Date(capturedFixedIso).getTime()) ? new Date(capturedFixedIso) : null;
      const capturedEventTime = (capturedFixedAt || resolveEventTime(flockDate, flockTime)).toISOString();

      // Clear form immediately for snappy feel
      const capturedBudget = flockCashPool;
      const capturedBudgetCtx = flockBudgetContext;
      const capturedGhostMode = flockGhostMode;
      setFlockName(''); setFlockFriends([]); setInviteSearch(''); setInviteResults([]); setFlockCashPool(false); setFlockBudgetContext('dinner'); setFlockGhostMode(true); setSelectedVenueForCreate(null);

      try {
        const data = await apiCreateFlock({ name: capturedName, venue_name: venueName, venue_address: venueAddr, venue_id: venueId, venue_latitude: venueLat || undefined, venue_longitude: venueLng || undefined, venue_rating: venueRating || undefined, venue_photo_url: venuePhoto || undefined, event_time: capturedEventTime, invited_user_ids: invitedIds.length > 0 ? invitedIds : undefined, budget_enabled: capturedBudget || undefined, budget_context: capturedBudget ? capturedBudgetCtx : undefined, ghost_mode_enabled: capturedBudget ? capturedGhostMode : undefined });
        const f = data.flock;
        const initialMessages = [];
        if (venueName) {
          const venueCardData = { name: venueName, addr: venueAddr, place_id: venueId, photo_url: venuePhoto, rating: venueRating, stars: venueRating, price: venuePriceLevel ? '$'.repeat(venuePriceLevel) : null, price_level: venuePriceLevel, type: capturedVenue?.type || (capturedVenue?.types?.[0] ? capturedVenue.types[0].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Place'), category: capturedVenue?.category || null, crowd: (typeof capturedVenue?.crowd === 'number' ? capturedVenue.crowd : null), lat: venueLat, lng: venueLng };
          const venueCardTempId = Date.now();
          initialMessages.push({
            id: venueCardTempId,
            sender: 'You',
            senderId: authUser?.id,
            time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
            text: `Check out ${venueName}!`,
            reactions: [],
            message_type: 'venue_card',
            venue_data: venueCardData,
            pending: true,
          });
          // THE CARD THAT STARTS THE PLAN, and it used to be fire and forget.
          //
          // This is the first thing everyone invited sees, and the whole
          // reason it is posted as a message rather than held on the flock
          // row. The old `.catch(() => {})` meant a refused write left the
          // card sitting in the creator's chat and nowhere else: they had
          // shared the venue, nobody else had it, and nothing on either
          // screen said so. It now rides the same pending / failed contract
          // as every other chat message, so a miss shows "Didn't send. Tap
          // to retry" on the card itself and retryFailedMessage resends it.
          apiSendMessage(f.id, `Check out ${venueName}!`, { message_type: 'venue_card', venue_data: venueCardData })
            .then((sent) => {
              // isServerId for the same reason transmitFlockMessage uses it:
              // adopting anything the server did not issue puts a settled
              // bubble into mergeHistory's id comparison forever.
              const savedId = sent?.message?.id;
              setFlocks(prev => prev.map(fl => (fl.id !== f.id ? fl : {
                ...fl,
                messages: (fl.messages || []).map(m => (m.id === venueCardTempId
                  ? { ...m, ...(isServerId(savedId) ? { id: savedId } : {}), pending: false }
                  : m)),
              })));
            })
            .catch((err) => {
              setFlocks(prev => prev.map(fl => (fl.id !== f.id ? fl : {
                ...fl,
                messages: (fl.messages || []).map(m => (m.id === venueCardTempId ? { ...m, pending: false, failed: true } : m)),
              })));
              persistFailedFlockMessage(f.id, { id: venueCardTempId, sender: 'You', senderId: authUser?.id, time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), text: `Check out ${venueName}!`, reactions: [], message_type: 'venue_card', venue_data: venueCardData, failed: true });
              if (err?.sessionExpired) return;
              const lead = "The flock is created, but the venue card didn't reach the chat.";
              showToast(err?.message ? `${lead} ${err.message}` : `${lead} Tap it to retry.`, 'error');
            });
        }
        const invitedNames = capturedFriends.map(fr => fr.name);
        // The server drops invitees it could not seat (a blocked pair, the
        // hourly budget) and echoes the ids it kept; the chat header used to
        // count everyone asked for.
        const acceptedInvites = Array.isArray(f.invited_user_ids) ? f.invited_user_ids.length : invitedIds.length;
        if (invitedIds.length > 0 && acceptedInvites < invitedIds.length) {
          showToast(`Invited ${acceptedInvites} of ${invitedIds.length}. The rest can join from the invite link.`);
        }
        const newFlock = { id: f.id, name: f.name, host: authUser?.name || 'You', creatorId: f.creator_id, members: [], invited: invitedNames, memberCount: 1, time: formatEventTime(f.event_time || capturedEventTime), eventTime: f.event_time || capturedEventTime, status: 'voting', venue: f.venue_name || 'TBD', venueAddress: venueAddr, venueId: venueId, venuePhoto: venuePhoto, venueRating: venueRating, venuePriceLevel: venuePriceLevel, venueLat: venueLat, venueLng: venueLng, cashPool: null, budgetEnabled: f.budget_enabled || capturedBudget, budgetContext: f.budget_context || capturedBudgetCtx, budgetLocked: false, budgetCeiling: null, ghostModeEnabled: f.ghost_mode_enabled || capturedGhostMode, votes: [], messages: initialMessages };

        // Batch all state updates together — navigate immediately
        hapticSuccess();
      newlyCreatedFlockRef.current = f.id;
        setFlocks(prev => [...prev, newFlock]);
        setSelectedFlockId(f.id);
        setCurrentScreen('chatDetail');
        setIsLoading(false);
      } catch (err) {
        if (!needsEmailVerification(err, 'start a flock')) showToast(err.message || "That plan didn't get created. Try again.", 'error');
        // The form is wiped before the request goes out so the screen feels
        // instant. That is fine when it works, and cruel when it does not: a
        // failed create used to leave the user staring at an empty form with
        // the name, the friends, the venue and the budget setting all gone.
        // Put every captured value back so the retry is one tap.
        setFlockName(capturedName);
        setFlockFriends(capturedFriends);
        setSelectedVenueForCreate(capturedVenue);
        setFlockCashPool(capturedBudget);
        setFlockBudgetContext(capturedBudgetCtx);
        setFlockGhostMode(capturedGhostMode);
        setIsLoading(false);
      }
    };

    // Read-backs the labels and the footer share. All of it is state the user
    // set on this screen; nothing here is computed from anything else.
    // A flock started from an event is for the event's own instant, not for
    // Tonight at 9: the chips used to win and the plan landed on the wrong day.
    const fixedEventIso = selectedVenueForCreate?.event_datetime_utc
      || (selectedVenueForCreate?.event_date && selectedVenueForCreate?.event_time ? `${selectedVenueForCreate.event_date}T${selectedVenueForCreate.event_time}` : null);
    const fixedEventAt = fixedEventIso && !Number.isNaN(new Date(fixedEventIso).getTime()) ? new Date(fixedEventIso) : null;
    const eventAt = fixedEventAt || resolveEventTime(flockDate, flockTime);
    // The event's name is the obvious name for the plan; seeded once into an
    // empty box, never over something typed.
    const eventName = selectedVenueForCreate?.event_name || '';
    useEffect(() => {
      if (eventName && !flockName) setFlockName(eventName);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [eventName]);
    const whenShort = eventAt.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const whenLong = eventAt.toLocaleString([], { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const trimmedName = flockName.trim();
    const suggestedToShow = suggestedUsers.filter(u => !flockFriends.some(f => f.id === u.id));
    const openVenuePicker = () => { setPickingVenueForCreate(true); setCurrentTab('explore'); setCurrentScreen('main'); };
    const leave = () => { setCurrentScreen('main'); setFlockName(''); setFlockNameError(''); setFlockFriends([]); setInviteSearch(''); setInviteResults([]); setSelectedVenueForCreate(null); };

    return (
      <div key="create-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--bg-card-solid)' }}>
        <DialogBehavior modal={false} onClose={leave} />
        <div style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid var(--divider)', backgroundColor: 'var(--bg-card-solid)', flexShrink: 0 }}>
          <button aria-label="Back" className="hit44" onClick={leave} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'transparent', color: colors.navy, fontSize: 'var(--t-title)', cursor: 'pointer' }}>←</button>
          <h1 style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.005em', fontSize: 'var(--t-title)', fontWeight: '600', color: colors.navy, margin: 0 }}>Start a Flock</h1>
        </div>

        <div style={{ flex: 1, padding: '16px 16px 8px', overflowY: 'auto', backgroundColor: 'var(--bg-primary)' }}>

          {/* THE OPENER. The warm bird, feet on the same line as the words,
              at a size that reads as the brand rather than an icon. Eager,
              because this is the first paint of the screen and a lazy photo
              here pops in after the form. One sentence of orientation for
              the person who has never made a flock; nothing to scroll past
              for the person who has. */}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '14px', padding: '0 2px 20px' }}>
            <BirdieStill bird={WARM_BIRD} size={92} eager style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0, paddingBottom: '8px' }}>
              <p style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: '0 0 4px', lineHeight: 1.3 }}>Name it and say when.</p>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>The venue can wait, because everyone you invite gets to vote on where.</p>
            </div>
          </div>

          <GroupLabel aside={selectedVenueForCreate ? selectedVenueForCreate.name : 'Venue optional'}>The plan</GroupLabel>
          <FormGroup>
            <FormRow>
              <label htmlFor="flock-name-input" style={{ display: 'block', fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, marginBottom: '6px' }}>What's the plan?</label>
              <SearchInputLocal aria-invalid={flockNameError ? 'true' : undefined} aria-describedby={flockNameError ? 'flock-name-error' : undefined} key="flock-name-input" id="flock-name-input" maxLength={255} enterKeyHint="done" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} type="text" initialValue={flockName} onCommit={(v) => { setFlockName(v); if (v.trim()) setFlockNameError(''); }} placeholder="Movie night, dinner, party..." style={flockNameError ? { ...styles.input, borderColor: colors.red } : styles.input} autoComplete="off" />
              {flockNameError ? (
                <p id="flock-name-error" role="alert" style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.redText, margin: '6px 0 0' }}>{flockNameError}</p>
              ) : (
                <Hint>This is the name your friends see on the invite.</Hint>
              )}
            </FormRow>

            {/* VENUE. A list row, not a dashed button: icon box, what it is,
                what happens if you skip it, and a chevron because it goes to
                Discover and comes back. Once a venue is picked the same row
                holds the photo and the facts instead, with Change at the edge. */}
            {selectedVenueForCreate ? (
              <FormRow divided>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px', marginBottom: '8px' }}>
                  <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>Venue</span>
                  <span style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', fontWeight: '600' }}>Optional</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  {selectedVenueForCreate.photo_url ? (
                    <img src={selectedVenueForCreate.photo_url} alt="" style={{ width: '48px', height: '48px', borderRadius: '8px', objectFit: 'cover', flexShrink: 0 }} onError={onVenuePhotoError} />
                  ) : (
                    <div style={{ width: '48px', height: '48px', borderRadius: '8px', backgroundColor: 'var(--icon-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{Icons.mapPin(colors.navy, 20)}</div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedVenueForCreate.name}</p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                      {selectedVenueForCreate.rating && <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>{selectedVenueForCreate.rating}</span>}
                      {selectedVenueForCreate.rating && <StarRating rating={selectedVenueForCreate.rating} />}
                      {selectedVenueForCreate.price_level && <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', fontWeight: '500' }}>{priceLabel(selectedVenueForCreate.price_level)}</span>}
                    </div>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedVenueForCreate.addr}</p>
                  </div>
                  <button className="hit44 glass-btn glass-secondary" onClick={openVenuePicker} style={{ padding: '6px 12px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, backgroundColor: 'var(--icon-bg)', color: colors.navy, fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer', flexShrink: 0 }}>Change</button>
                </div>
                <Hint style={{ marginTop: '8px' }}>It goes into the chat as the first card, and the group can still vote on somewhere else.</Hint>
              </FormRow>
            ) : (
              <FormRow divided style={{ padding: 0 }}>
                {/* Plain hit44, not glass-secondary: that class paints its own
                    background and border with !important, which would put a
                    box inside the card. A row is flat; the hairline above it
                    is the frame. */}
                <button className="hit44" onClick={openVenuePicker} style={{ width: '100%', padding: '12px', border: 'none', backgroundColor: 'transparent', cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '12px', borderBottomLeftRadius: '13px', borderBottomRightRadius: '13px' }}>
                  <IconBox>{Icons.mapPin(colors.navy, 18)}</IconBox>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy }}>Browse venues</span>
                    <span style={{ display: 'block', fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', lineHeight: 1.45, marginTop: '1px' }}>Leave it blank and the group votes on where to go.</span>
                  </span>
                  <span style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', fontWeight: '600', flexShrink: 0 }}>Optional</span>
                  <span aria-hidden="true" style={{ display: 'flex', flexShrink: 0 }}>{Icons.chevronRight('var(--text-tertiary)', 16)}</span>
                </button>
              </FormRow>
            )}
          </FormGroup>

          <GroupLabel aside={whenShort}>When</GroupLabel>
          <FormGroup>
            {fixedEventAt ? (
            <FormRow>
              <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: '0 0 4px' }}>When the event is</p>
              <p style={{ fontSize: 'var(--t-body)', color: 'var(--text-secondary)', margin: 0 }}>{whenLong}. The time comes from the event listing.</p>
            </FormRow>
            ) : (<>
            <FormRow>
              <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: '0 0 8px' }}>Which day?</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                {FLOCK_DAY_CHOICES.map(d => (
                  <ChoiceChip key={d} selected={flockDate === d} onClick={() => setFlockDate(d)}>{d}</ChoiceChip>
                ))}
              </div>
            </FormRow>
            <FormRow divided>
              <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: '0 0 8px' }}>What time?</p>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {FLOCK_HOUR_CHOICES.map(t => (
                  <ChoiceChip key={t} selected={flockTime === t} onClick={() => setFlockTime(t)} style={{ flex: '1 1 auto', padding: '9px 10px', fontSize: 'var(--t-meta)' }}>{t}</ChoiceChip>
                ))}
              </div>
            </FormRow>
            </>)}
            {/* The answer the two rows above add up to, on its own row and on
                the page background so it reads as a result, not a caption. */}
            <FormRow divided style={{ padding: '10px 12px', backgroundColor: 'var(--bg-primary)', borderBottomLeftRadius: '13px', borderBottomRightRadius: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span aria-hidden="true" style={{ display: 'flex', flexShrink: 0 }}>{Icons.calendar(colors.steel, 14)}</span>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, fontWeight: '600' }}>{whenLong}</p>
            </FormRow>
          </FormGroup>

          {/* 25 is the server's ceiling for one create; more join from the chat. */}
          <GroupLabel aside={flockFriends.length >= 25 ? '25 invited, the most at once. Add more from the chat.' : flockFriends.length > 0 ? `${flockFriends.length} invited` : 'Just you'}>Who</GroupLabel>
          <FormGroup>
            <FormRow>
              {/* THE ROSTER. Picked people as chips. While it is just you, the
                  second bird sits here beside the fact, the same composition
                  FlockDetail uses for a plan with one accepted member, and it
                  leaves the moment someone is added. */}
              {flockFriends.length > 0 ? (
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '12px' }}>
                  {flockFriends.map(f => (
                    <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px 4px 4px', borderRadius: '20px', backgroundColor: colors.navyBg, color: 'white' }}>
                      <div style={{ width: '22px', height: '22px', borderRadius: '11px', backgroundColor: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-meta)', fontWeight: '500' }}>
                        {f.profile_image_url ? <img src={f.profile_image_url} alt="" style={{ width: '22px', height: '22px', borderRadius: '11px', objectFit: 'cover' }} /> : f.name[0]?.toUpperCase()}
                      </div>
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500' }}>{f.name.split(' ')[0]}</span>
                      <button aria-label={`Remove ${f.name}`} className="hit44" onClick={() => setFlockFriends(prev => prev.filter(x => x.id !== f.id))} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', display: 'flex', alignItems: 'center' }}>{Icons.x('rgba(255,255,255,0.7)', 12)}</button>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px', minWidth: 0 }}>
                  <BirdieStill bird={WARM_BIRD} size={54} style={{ flexShrink: 0 }} />
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.45 }}>
                    {suggestedToShow.length > 0
                      ? 'Just you so far. Tap a name below or search for anyone on Flock.'
                      : 'Just you so far. Search for anyone on Flock, or make the flock now and invite people from the chat.'}
                  </p>
                </div>
              )}

              {/* Suggested friends, one tap to add. Meta size, not an eyebrow. */}
              {suggestedToShow.length > 0 && (
                <div style={{ marginBottom: '10px' }}>
                  <p style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--text-tertiary)', margin: '0 0 6px' }}>Suggested</p>
                  <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '4px' }}>
                    {suggestedToShow.slice(0, 5).map(user => (
                      <button key={user.id} className="hit44 glass-btn glass-secondary" disabled={flockFriends.length >= 25} onClick={() => setFlockFriends(prev => (prev.length >= 25 ? prev : [...prev, user]))} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px', borderRadius: '20px', border: `1.5px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer', flexShrink: 0, transition: 'opacity 0.15s ease' }}>
                        <div style={{ width: '24px', height: '24px', borderRadius: '12px', backgroundColor: colors.navyMidBg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-meta)', fontWeight: '500', color: 'white', overflow: 'hidden', flexShrink: 0 }}>
                          {user.profile_image_url ? <img src={user.profile_image_url} alt="" style={{ width: '24px', height: '24px', borderRadius: '12px', objectFit: 'cover' }} /> : user.name[0]?.toUpperCase()}
                        </div>
                        <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, whiteSpace: 'nowrap' }}>{user.name.split(' ')[0]}</span>
                        <span style={{ fontSize: 'var(--t-meta)', color: colors.steel, fontWeight: '500' }}>+</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Search input */}
              <div style={{ position: 'relative' }}>
                <input aria-label="Search people by name"
                  type="text"
                  value={inviteSearch}
                  onChange={(e) => handleInviteSearch(e.target.value)}
                  placeholder="Search by name..."
                  style={{ ...styles.input, paddingLeft: '36px', paddingRight: inviteSearch ? '36px' : '12px', fontSize: 'var(--t-meta)' }}
                  autoComplete="off"
                />
                <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }}>{Icons.search(colors.textTertiary, 14)}</span>
                {inviteSearch && (
                  <button aria-label="Clear search" className="hit44" onClick={() => { setInviteSearch(''); setInviteResults([]); }} style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>{Icons.x(colors.textTertiary, 14)}</button>
                )}
              </div>

              {/* Search results */}
              {inviteSearching && (
                <div style={{ marginTop: '6px' }}>
                  <ListSkeleton count={3} thumb={32} thumbRadius={16} label="Searching people" />
                </div>
              )}
              {!inviteSearching && inviteSearch.trim().length >= 1 && inviteResults.length > 0 && (
                <div style={{ maxHeight: '160px', overflowY: 'auto', borderRadius: '10px', border: `1px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', marginTop: '6px' }}>
                  {inviteResults.filter(u => !flockFriends.some(f => f.id === u.id)).map((user, i, arr) => (
                    <button className="hit44" key={user.id} onClick={() => {
                      setFlockFriends(prev => [...prev, user]);
                      setInviteSearch('');
                      setInviteResults([]);
                    }} style={{ width: '100%', padding: '8px 10px', display: 'flex', alignItems: 'center', gap: '10px', border: 'none', borderBottom: i < arr.length - 1 ? `1px solid ${colors.creamDark}` : 'none', backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer', textAlign: 'left' }}>
                      <div style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: colors.navyMidBg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-meta)', fontWeight: '500', color: 'white', flexShrink: 0, overflow: 'hidden' }}>
                        {user.profile_image_url ? <img src={user.profile_image_url} alt="" style={{ width: '32px', height: '32px', borderRadius: '16px', objectFit: 'cover' }} /> : user.name[0]?.toUpperCase()}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontWeight: '600', fontSize: 'var(--t-label)', color: colors.navy, margin: 0 }}>{user.name}</p>
                        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '1px 0 0' }}>{user.email}</p>
                      </div>
                      <div style={{ padding: '4px 10px', borderRadius: '8px', backgroundColor: 'var(--icon-bg)', color: colors.steel, fontSize: 'var(--t-meta)', fontWeight: '500', flexShrink: 0 }}>Add</div>
                    </button>
                  ))}
                </div>
              )}
              {/* A search that hit a network or server error, not an empty
                  result. Its own line, so "Nobody by that name" never stands in
                  for "the search did not run". */}
              {!inviteSearching && inviteSearchError && (
                <p role="status" style={{ fontSize: 'var(--t-label)', color: 'var(--accent-red-text, #b91c1c)', textAlign: 'center', padding: '16px 8px', margin: '10px 0 0', lineHeight: 1.5 }}>{inviteSearchError}</p>
              )}
              {/* A search that found nobody. Warm bird, because this is about
                  the user's own people rather than a Flock-wide list. */}
              {!inviteSearching && !inviteSearchError && inviteSearch.trim().length >= 1 && inviteResults.length === 0 && (
                <BirdNote
                  layout="row"
                  size={48}
                  bird={WARM_BIRD}
                  title="Nobody by that name"
                  body="Check the spelling, or try the email they signed up with."
                  style={{ marginTop: '10px' }}
                />
              )}
            </FormRow>
            {/* What adding someone does. A fact from POST /api/flocks: a
                socket event to anyone online, a push to everyone else. Hidden
                for the one-person case, where the footer explains the DM. */}
            {!dmTarget && (
              <FormRow divided style={{ padding: '10px 12px', backgroundColor: 'var(--bg-primary)', borderBottomLeftRadius: '13px', borderBottomRightRadius: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span aria-hidden="true" style={{ display: 'flex', flexShrink: 0 }}>{Icons.bell(colors.steel, 14)}</span>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, fontWeight: '500' }}>Invites go out as soon as the flock exists.</p>
              </FormRow>
            )}
          </FormGroup>

          <GroupLabel aside={flockCashPool ? `On, for ${flockBudgetContext}` : 'Off'}>Money</GroupLabel>
          <FormGroup>
            <FormRow>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <IconBox>{Icons.dollar(colors.navy, 18)}</IconBox>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy }}>Group budget</span>
                  <span style={{ display: 'block', fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', lineHeight: 1.45, marginTop: '1px' }}>
                    {flockCashPool ? 'Everyone sets a number nobody else can see.' : 'Turn this on and everyone sets a number nobody else can see.'}
                  </span>
                </div>
                <Toggle label="Shared cash pool" on={flockCashPool} onChange={() => setFlockCashPool(!flockCashPool)} />
              </div>
            </FormRow>
            {flockCashPool && (
              <>
                <FormRow divided>
                  <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: '0 0 8px' }}>What's this for?</p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    {['dinner', 'drinks', 'movie', 'concert', 'activity'].map(ctx => (
                      <ChoiceChip key={ctx} selected={flockBudgetContext === ctx} onClick={() => setFlockBudgetContext(ctx)} style={{ padding: '7px 13px', fontSize: 'var(--t-meta)', textTransform: 'capitalize' }}>
                        {ctx}
                      </ChoiceChip>
                    ))}
                  </div>
                  <Hint style={{ marginTop: '8px' }}>Members will set their own budget anonymously after joining</Hint>
                </FormRow>
                <FormRow divided>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <IconBox>{Icons.eyeOff(colors.navy, 18)}</IconBox>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy }}>Ghost Mode</span>
                      <span style={{ display: 'block', fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', lineHeight: 1.45, marginTop: '1px' }}>Members can quietly commit their share of the bill up front, before anyone pays, so the plan never waits on money</span>
                    </div>
                    <Toggle label="Ghost mode" on={flockGhostMode} onChange={() => setFlockGhostMode(!flockGhostMode)} />
                  </div>
                </FormRow>
              </>
            )}
          </FormGroup>
        </div>

        {/* THE READ-BACK, then the commit. Every fact on these lines is state
            the screen already holds; nothing here is computed from anything
            the user did not choose. The name leads when there is one, because
            it is the thing the invite will say. */}
        <div style={{ padding: '10px 16px 16px', flexShrink: 0, backgroundColor: 'var(--bg-card-solid)', borderTop: '1px solid var(--divider)' }}>
          {trimmedName && (
            <p style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.005em', fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: '0 0 2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{trimmedName}</p>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '0 0 10px', minWidth: 0 }}>
            <span style={{ fontSize: 'var(--t-meta)', fontWeight: '700', color: colors.navy, whiteSpace: 'nowrap', flexShrink: 0 }}>
              {whenShort}
            </span>
            <span aria-hidden="true" style={{ width: '3px', height: '3px', borderRadius: '2px', backgroundColor: 'var(--text-tertiary)', flexShrink: 0 }} />
            <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
              {dmTarget ? `Just ${dmTarget.name}` : flockFriends.length === 0 ? 'Just you so far' : `You and ${flockFriends.length} more`}
              {selectedVenueForCreate && !dmTarget ? ` at ${selectedVenueForCreate.name}` : ''}
              {!selectedVenueForCreate && !dmTarget ? ', venue by vote' : ''}
            </span>
          </div>
          {/* Said before the tap, not discovered after it. */}
          {dmTarget && (
            <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.5 }}>
              One person is a message, not a flock. This opens a direct message with {dmTarget.name}. A message carries no venue, time or budget, so anything you set here stays on this screen. Add someone else to make it a flock.
            </p>
          )}
          <button className="hit44 glass-btn glass-primary" onClick={handleCreate} disabled={isLoading} style={{
            width: '100%', padding: '16px', borderRadius: '16px', border: 'none',
            background: colors.navy,
            color: 'white', fontWeight: '600', fontSize: 'var(--t-body)', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            opacity: isLoading ? 0.6 : 1,
            boxShadow: '0 1px 2px rgba(30,41,59,0.10)',
          }}>
            {isLoading
              ? <><span style={{ display: 'inline-flex', animation: 'spin 1s linear infinite' }}>{Icons.activity('white', 16)}</span> Creating...</>
              : dmTarget
                ? <>{Icons.chat('white', 18)} Message {dmFirstName || dmTarget.name}</>
                : <>{Icons.users('white', 18)} Create Flock</>}
          </button>
        </div>
      </div>
    );
}
