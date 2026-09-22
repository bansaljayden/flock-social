/**
 * EXPLORE SCREEN (Discover)
 *
 * The Discover tab: the venue search box with its dropdown, the Features rail
 * behind it, the location and empty-map banners, the map layer itself, the
 * live-location strip, the Find Your People panel, the venue card a pin opens,
 * the Live Events drawer and the category filter bar.
 *
 * It was 588 lines of App.js, declared as an arrow function inside
 * FlockAppInner, which is the shape the Plans tab, the Messages tab, the venue
 * dashboard, the flock chat, the DM thread, Add Friends, the profile and
 * settings screen, the flock detail screen, the create screen and past flocks
 * were all in before they moved out. It is the last screen in the file to move
 * and by some distance the most tangled: it read 92 names it did not declare.
 *
 * WHY THIS ONE IS LAZY, AND WHY THAT IS SAFE HERE
 *
 * Discover is NOT part of the screen switch. Its map layer is mounted once and
 * never unmounted again, so a tab switch is instant and the camera survives it.
 * That sounds like an argument against a lazy: a screen mounted for the life of
 * the session sounds like a screen on the first paint path. It is not one. The
 * mount is latched behind exploreEverVisibleRef, so nothing about this screen
 * exists until somebody actually opens Discover, and currentTab starts at
 * 'home' with nothing routing here from a URL. The chunk is warmed on idle in
 * warmScreenChunks once the Nest has painted, so the tap that opens Discover
 * resolves from the module cache.
 *
 * The latch is also why the re-arm for this chunk is guarded rather than
 * unconditional. Once Discover has been visited this module is live for the
 * rest of the session, and a fresh React.lazy is a fresh element type: an
 * unconditional rebuild would remount the whole screen, unmount MapLibre and
 * take the city, the zoom and the open pin with it, every time some unrelated
 * screen's "Try again" ran the blanket re-arm. loadExploreScreen records
 * whether the chunk actually rejected and rearmExploreScreen does nothing
 * unless it did, which is the rule loadMapLibreMapView already follows for the
 * map inside this screen.
 *
 * WHY EVERYTHING ARRIVES AS A PROP
 *
 * The old arrow function closed over 92 names. Eighty-five are declared in
 * FlockAppInner or at App.js module scope, and those are the parameters below,
 * built at the call site with object shorthand so the name there and the
 * parameter here cannot drift apart. Six of the eighty-five are App.js module
 * scope rather than state: the dialog behaviour, the empty mark, the list
 * skeleton, the map wrapper, the review build flag and the money formatter.
 * They are shared with surfaces that are not this screen, so they stay declared
 * there and travel, because a second copy here would be free to drift from the
 * one every other surface draws.
 *
 * The remaining seven are module imports App.js already pulls from
 * '../components/ui/BirdieBird', '../components/ui/Icons', '../lib/venuePhoto',
 * '../services/api' and 'framer-motion', so this file imports them straight
 * from the source rather than taking them as props. The list came from a Babel
 * scope walk of the block, every referenced identifier whose binding resolves
 * outside it, not from reading the page.
 *
 * colors HAS to travel. FlockAppInner's useMemo SHADOWS the module scope
 * `const colors = colorsLight` in App.js, so a screen that imported a palette
 * instead would compile, pass, and paint the light one over dark mode.
 *
 * The move itself called no hook, so nothing about it changed hook order in
 * FlockAppInner. That constraint did not survive the move and no longer binds
 * this file: the screen is mounted as its own element (ExploreScreenView in
 * App.js), so a hook declared here belongs to this component and FlockAppInner
 * never sees it. There is exactly one, below the parameter list, and the Live
 * Events drawer it serves says why.
 *
 * The state and the effects behind these props deliberately did NOT move. They
 * live in FlockAppInner, which does not unmount when the user leaves this tab,
 * so the search text, the open Features rail, the category filter, the Find
 * Your People results and the Live Events drawer all survive a trip elsewhere
 * exactly as they did before.
 *
 * The body below is the old block verbatim, including its original four-space
 * indentation, so it can be diffed against the deleted lines character for
 * character. Nothing was renamed, reformatted or improved on the way across,
 * and no defect was fixed in transit: this is a move.
 *
 * ONE THING HAS CHANGED SINCE, and it is deliberately kept cheap to diff: the
 * Live Events drawer's contents sit behind a mount gate now. The gated lines
 * keep their old indentation instead of being shifted a level, so that
 * character-for-character comparison still holds for everything except the two
 * lines that open and close the gate.
 */
import React from 'react';
import { AnimatePresence } from 'framer-motion';
import { BirdieStill, BirdNote, WARM_BIRD } from '../components/ui/BirdieBird';
import Icons from '../components/ui/Icons';
import { onVenuePhotoError } from '../lib/venuePhoto';
import { getEventDetails } from '../services/api';

export default function ExploreScreen({
  // Declared at App.js module scope and shared with surfaces other than this
  // screen, so they stay declared there and arrive here.
  DialogBehavior,
  EmptyMark,
  ListSkeleton,
  MapLibreMapView,
  REVIEW_HIDE_LOCATION_BANNER,
  fmtMoney,
  // Everything else is declared in FlockAppInner and stays declared there.
  BottomNav,
  SafetyButton,
  activeVenue,
  allVenues,
  budgetFilteredVenues,
  budgetStatus,
  calcDistance,
  category,
  categoryExpanded,
  colors,
  confirmClick,
  connectResults,
  connectSearch,
  SearchInputLocal,
  connectSearchError,
  connectSearching,
  discoverNavOpen,
  eventsSearchQuery,
  eventsSearchTimerRef,
  featuredEvents,
  featuredEventsError,
  featuredEventsLoading,
  fetchFeaturedEvents,
  flockMemberLocations,
  friendStatuses,
  getCategoryColor,
  getMaxPriceLevel,
  handleConnectSearch,
  handleSendFriendRequest,
  handleVenueQueryChange,
  isDark,
  loadVenuesAtLocation,
  locationEnabled,
  // Whether Discover is actually the screen on show. It is kept mounted when
  // it is not, so the map has to be told, or it goes on doing marker work
  // behind a hidden layer for the rest of the session.
  isExploreVisible = true,
  locationError,
  locationLoading,
  mapVenuesLoaded,
  openUserProfile,
  openVenueDetail,
  pickingVenueForCreate,
  pickingVenueForDm,
  pickingVenueForFlockId,
  renderConsumerVenueCard,
  requestUserLocation,
  setActiveVenue,
  setCategory,
  setCategoryExpanded,
  setConnectResults,
  setConnectSearch,
  setCurrentScreen,
  setCurrentTab,
  setDiscoverNavOpen,
  setEventDetail,
  setEventDetailError,
  setEventDetailLoading,
  setEventsSearchQuery,
  setLocationError,
  setMapVenuesLoaded,
  setPickingVenueForCreate,
  setPickingVenueForDm,
  setPickingVenueForFlockId,
  setSelectedFlockId,
  setSelectedVenueForCreate,
  setShowConnectPanel,
  setShowEventsView,
  setShowSearchDropdown,
  setShowSearchResults,
  setVenueLoadError,
  setVenueQuery,
  setVenueResults,
  sharingLocationForFlock,
  showConnectPanel,
  showEventsView,
  showSearchDropdown,
  startNewDmWithUser,
  stopLocationSharing,
  toggleLocation,
  userLocation,
  venueLoadError,
  venueQuery,
  venueResults,
  venueSearching,
}) {
  // WHETHER THE LIVE EVENTS DRAWER'S CONTENTS EXIST AT ALL.
  //
  // The drawer's wrapper is mounted for the whole session and so was
  // everything inside it. Discover is parked at visibility:hidden rather than
  // unmounted, this screen is not memoised, and featuredEvents fills itself
  // from loadVenuesAtLocation whether or not anybody opens the drawer -- so
  // every render of the app re-ran the whole events list behind a hidden tab.
  // At the twenty the backend caps that list at (routes/events.js /featured
  // asks for size 20 and slices its top-up to the same) that is twenty
  // Date.parse calls in the filter, then per event a new Date, a
  // toLocaleDateString, a toLocaleTimeString (two fresh Intl.DateTimeFormat
  // builds), a regex pair, a haversine and about thirty-nine elements, plus
  // forty photograph badges kept alive for a panel parked off the right edge.
  // Those badges used to carry a backdrop-filter each, which made the parked
  // drawer a compositor cost as well as a render one; they are flat scrims
  // now, so what is left to avoid here is the render work.
  //
  // Held for the length of the slide rather than dropped on the tap: the panel
  // takes 0.35s to leave, and unmounting on the tap would animate an empty
  // rectangle off screen. That is the same 0.35s the wrapper's visibility
  // delay already waits out, for the same reason. Opening is NOT delayed --
  // showEventsView alone puts the contents back, so the slide in has them from
  // its first frame, and the wrapper and the sliding panel themselves stay
  // mounted so the transform has an old value to animate from.
  const [eventsDrawerHeld, setEventsDrawerHeld] = React.useState(false);
  const eventsDrawerMounted = showEventsView || eventsDrawerHeld;
  React.useEffect(() => {
    if (showEventsView) { setEventsDrawerHeld(true); return undefined; }
    if (!eventsDrawerHeld) return undefined;
    const t = setTimeout(() => setEventsDrawerHeld(false), 350);
    return () => clearTimeout(t);
  }, [showEventsView, eventsDrawerHeld]);

  return (
    <div key="explore-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--pill-bg)' }}>
      {/* Discover's title is the map itself, so there was no h1 at all here and
          a screen-reader user landed on a page with no name. */}
      <h1 className="sr-only">Discover</h1>
      {pickingVenueForCreate && (
        <div style={{ padding: '10px 14px', background: colors.navyMidBg, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, boxShadow: '0 2px 8px rgba(13,40,71,0.10)' }}>
          <span style={{ color: 'white', fontSize: 'var(--t-meta)', fontWeight: '500', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.mapPin('white', 14)} Tap venue to select</span>
          <button className="hit44 glass-btn glass-secondary" onClick={() => { setPickingVenueForCreate(false); if (pickingVenueForDm) { setPickingVenueForDm(false); setCurrentTab('chat'); setCurrentScreen('dmDetail'); } else if (pickingVenueForFlockId) { setSelectedFlockId(pickingVenueForFlockId); setPickingVenueForFlockId(null); setCurrentTab('chat'); setCurrentScreen('chatDetail'); } else { setCurrentScreen('create'); } }} style={{ backgroundColor: 'rgba(255,255,255,0.2)', border: 'none', borderRadius: '12px', padding: '4px 12px', color: 'white', fontSize: 'var(--t-meta)', cursor: 'pointer', fontWeight: '500', transition: 'opacity 0.2s ease' }}>Cancel</button>
        </div>
      )}

      <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: '6px', backgroundColor: 'var(--bg-card-solid)', boxShadow: '0 2px 12px rgba(0,0,0,0.08)', zIndex: 20, flexShrink: 0 }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <input aria-label="Search venues" key="search-input" id="search-input" type="text" value={venueQuery} onChange={(e) => handleVenueQueryChange(e.target.value)} placeholder="Search restaurants, bars, venues..." style={{ width: '100%', padding: '12px 14px 12px 38px', paddingRight: venueQuery ? '36px' : '14px', borderRadius: '14px', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: `2px solid ${venueQuery ? colors.navy : colors.borderDefault}`, fontSize: 'var(--t-label)', outline: 'none', boxSizing: 'border-box', transition: 'opacity 0.2s ease', fontWeight: '500' }} autoComplete="off" />
          <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', transition: 'opacity 0.2s ease' }}>{Icons.search(venueQuery ? colors.navy : colors.textTertiary, 16)}</span>
          {venueQuery && (
            <button aria-label="Clear search" className="hit44" onClick={() => { setVenueQuery(''); setVenueResults([]); setShowSearchDropdown(false); setShowSearchResults(false); setActiveVenue(null); const lat = parseFloat(localStorage.getItem('flock_user_lat')); const lng = parseFloat(localStorage.getItem('flock_user_lng')); if (lat && lng) { setMapVenuesLoaded(false); loadVenuesAtLocation(lat, lng); } else { setMapVenuesLoaded(false); requestUserLocation(false); } }} title="Clear search" style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('#64748b', 16)}</button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
          {/* Collapsed means gone. Same fix as the flock chat header: without
              it, Tab from the venue search box landed on "Recenter the map on
              me", "Events" and "Friends" while all three were painted at zero
              width behind a "Features" pill. */}
          <div style={{ display: 'flex', gap: '4px', overflow: 'hidden', maxWidth: discoverNavOpen ? '124px' : '0px', opacity: discoverNavOpen ? 1 : 0, visibility: discoverNavOpen ? undefined : 'hidden', transition: `max-width 0.3s ease, opacity 0.25s ease, visibility 0s linear ${discoverNavOpen ? '0s' : '0.3s'}` }}>
            <button aria-label="Recenter the map on me" className="hit44" onClick={() => { setDiscoverNavOpen(false); setMapVenuesLoaded(false); setVenueQuery(''); setVenueResults([]); setShowSearchDropdown(false); setShowSearchResults(false); setActiveVenue(null); requestUserLocation(true); }} style={{ width: '36px', height: '36px', minWidth: '36px', borderRadius: '12px', border: '1px solid var(--border-default)', background: 'var(--bg-card-solid)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: locationLoading ? 'spin 1s linear infinite' : 'none' }}>{Icons.crosshair('var(--text-primary)', 15)}</button>
            <button aria-label="Events" className="hit44" onClick={() => { setDiscoverNavOpen(false); setShowEventsView(true); setActiveVenue(null); if (userLocation && !featuredEventsLoading) { fetchFeaturedEvents(`${userLocation.lat},${userLocation.lng}`); } }} style={{ width: '36px', height: '36px', minWidth: '36px', borderRadius: '12px', border: '1px solid var(--border-default)', background: 'var(--bg-card-solid)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.zap('var(--text-primary)', 15)}</button>
            <button aria-label="Friends" className="hit44" onClick={() => { setDiscoverNavOpen(false); setShowConnectPanel(true); }} style={{ width: '36px', height: '36px', minWidth: '36px', borderRadius: '12px', border: '1px solid var(--border-default)', background: 'var(--bg-card-solid)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.users('var(--text-primary)', 15)}</button>
          </div>
          <button aria-label="Features" aria-expanded={discoverNavOpen} className="hit44" onClick={() => setDiscoverNavOpen(!discoverNavOpen)} style={{ height: '42px', minWidth: discoverNavOpen ? '42px' : 'auto', width: discoverNavOpen ? '42px' : 'auto', borderRadius: '14px', border: '1px solid var(--border-default)', background: 'var(--bg-card-solid)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', padding: discoverNavOpen ? '0' : '0 14px', fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--text-primary)', flexShrink: 0, transition: 'all 0.3s ease' }}>{discoverNavOpen ? Icons.x('var(--text-primary)', 16) : <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', whiteSpace: 'nowrap' }}>Features</span>}</button>
        </div>
      </div>

      {/* Location loading overlay */}
      {locationLoading && !mapVenuesLoaded && (
        <div style={{ position: 'relative', zIndex: 25, backgroundColor: 'var(--bg-card-solid)', borderBottom: '1px solid var(--border-default)', padding: '16px 0', textAlign: 'center' }}>
          <div style={{ display: 'inline-block', width: '24px', height: '24px', border: `3px solid var(--border-default)`, borderTopColor: colors.steel, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '8px 0 0', fontWeight: '500' }}>Finding venues near you...</p>
        </div>
      )}

      {/* Why the map is empty, when it is. Two separate facts, because they
          have two separate fixes: the app does not know where you are, and the
          venue search is not answering. Both used to be silent, one covered by
          a default city and the other by eight invented venues. */}
      {/* Location services is off, said on the screen the setting governs.
          Without this the map simply opens somewhere generic with no user pin
          and nothing explaining why, which reads as a broken map rather than as
          a setting the person chose. The button turns it back on here rather
          than sending them to Settings to find the row again. */}
      {/* Before the first answer the map behind the permission sheet was the
          whole country with no pins and no sentence. */}
      {locationLoading && (
        <div style={{ position: 'relative', zIndex: 25, backgroundColor: 'var(--bg-card-solid)', borderBottom: '1px solid var(--border-default)', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ flexShrink: 0, display: 'flex' }}>{Icons.mapPin('var(--text-tertiary)', 16)}</span>
          <p role="status" style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, flex: 1, minWidth: 0, lineHeight: 1.5 }}>Finding where you are. Venues near you show up once that lands.</p>
        </div>
      )}
      {!locationLoading && !locationEnabled && (
        <div style={{ position: 'relative', zIndex: 25, backgroundColor: 'var(--bg-card-solid)', borderBottom: '1px solid var(--border-default)', padding: '12px 14px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ flexShrink: 0, display: 'flex' }}>{Icons.mapPin('var(--text-tertiary)', 16)}</span>
          <p role="status" style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, flex: 1, minWidth: 0, lineHeight: 1.5 }}>Location services are off, so venues are not sorted by distance and the map does not show where you are. Search still works.</p>
          <button className="hit44" onClick={() => { toggleLocation(true); setMapVenuesLoaded(false); }} style={{ flexShrink: 0, padding: '7px 12px', borderRadius: '10px', border: '1px solid var(--border-mid)', background: 'transparent', color: 'var(--text-primary)', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>Turn on</button>
        </div>
      )}

      {/* Zero venues nearby used to be an empty map with nothing on it, which
          reads as broken. Say what it is and what to do. */}
      {!locationLoading && locationEnabled && !locationError && !venueLoadError && mapVenuesLoaded && allVenues.length === 0 && (
        <div style={{ position: 'relative', zIndex: 25, backgroundColor: 'var(--bg-card-solid)', borderBottom: '1px solid var(--border-default)', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <BirdieStill size={48} style={{ flexShrink: 0 }} />
          <p role="status" style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, flex: 1, minWidth: 0, lineHeight: 1.5 }}>No venues on Flock's map right here yet. Search a place by name, or move the map.</p>
        </div>
      )}

      {!locationLoading && locationEnabled && (locationError || venueLoadError) && !REVIEW_HIDE_LOCATION_BANNER && (
        <div style={{ position: 'relative', zIndex: 25, backgroundColor: 'var(--bg-card-solid)', borderBottom: '1px solid var(--border-default)', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <BirdieStill size={48} style={{ flexShrink: 0 }} />
          <p role="status" style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, flex: 1, minWidth: 0, lineHeight: 1.5 }}>{locationError || venueLoadError}</p>
          {!/again in \d+/i.test(venueLoadError || '') && <button className="hit44" onClick={() => { setLocationError(''); setVenueLoadError(''); setMapVenuesLoaded(false); requestUserLocation(true); }} style={{ flexShrink: 0, padding: '7px 12px', borderRadius: '10px', border: '1px solid var(--border-mid)', background: 'transparent', color: 'var(--text-primary)', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>Try again</button>}
        </div>
      )}

      {/* Search Results Overlay */}
      {showSearchDropdown && (venueSearching || venueResults.length > 0 || (venueQuery.trim().length >= 2 && !venueSearching && venueResults.length === 0)) && (
        <div style={{ position: 'relative', zIndex: 30, backgroundColor: 'var(--bg-card-solid)', borderBottom: '1px solid var(--border-default)', maxHeight: '260px', overflowY: 'auto' }}>
          {/* A list is loading, so it gets the list skeleton — the bare spinner
              that used to sit here told you nothing about what was coming. */}
          {venueSearching && (
            <div style={{ padding: '8px 12px 4px' }}>
              <ListSkeleton count={3} thumb={44} thumbRadius={10} label="Searching venues" />
            </div>
          )}
          {!venueSearching && venueResults.length > 0 && (
            <div style={{ padding: '4px 12px 8px' }}>
              {/* View All — first thing you see */}
              <button
                className="hit44 glass-btn glass-navy"
                onClick={() => { setShowSearchResults(true); setShowSearchDropdown(false); }}
                style={{ width: '100%', padding: '11px 14px', borderRadius: '12px', border: 'none', background: colors.navyBg, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', margin: '4px 0 8px', transition: 'opacity 0.2s', boxShadow: '0 2px 8px rgba(13,40,71,0.10)' }}
              >
                {Icons.filter('white', 13)}
                <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'white' }}>See All Results ({venueResults.length})</span>
                {Icons.arrowRight('white', 14)}
              </button>
              {venueResults.filter(v => { const mp = budgetStatus?.isReady && budgetStatus?.ceiling ? getMaxPriceLevel(budgetStatus.ceiling) : 4; return !v.price_level || v.price_level <= mp; }).slice(0, 4).map((venue) => (
                <button
                  key={venue.place_id}
                  onClick={() => {
                    setShowSearchDropdown(false);
                    // Pan map to this venue if it's in our markers
                    if (window.__flockPanToVenue) window.__flockPanToVenue(venue.place_id);
                    openVenueDetail(venue.place_id, { name: venue.name, formatted_address: venue.formatted_address, place_id: venue.place_id, rating: venue.rating, price_level: venue.price_level, photo_url: venue.photo_url });
                  }}
                  style={{ width: '100%', padding: '10px', display: 'flex', alignItems: 'center', gap: '10px', border: 'none', borderRadius: '12px', backgroundColor: 'var(--bg-tertiary)', cursor: 'pointer', textAlign: 'left', marginBottom: '6px', transition: 'background-color 0.15s' }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--bg-hover)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'; }}
                >
                  {venue.photo_url ? (
                    <img src={venue.photo_url} alt="" style={{ width: '48px', height: '48px', borderRadius: '10px', objectFit: 'cover', flexShrink: 0 }} onError={onVenuePhotoError} />
                  ) : (
                    <div style={{ width: '48px', height: '48px', borderRadius: '10px', backgroundColor: 'var(--pill-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{Icons.mapPin(colors.navyMid, 20)}</div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontWeight: '600', fontSize: 'var(--t-label)', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{venue.name}</p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px', flexWrap: 'wrap' }}>
                      {venue.rating && <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>{venue.rating} {Icons.starFilled('currentColor', 12)}</span>}
                      {venue.user_ratings_total > 0 && <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }}>({venue.user_ratings_total})</span>}
                      {venue.price_level && <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', fontWeight: '500' }}>{'$'.repeat(venue.price_level)}</span>}
                      {userLocation && venue.location && (() => {
                        const dLat = (venue.location.latitude - userLocation.lat) * Math.PI / 180;
                        const dLng = (venue.location.longitude - userLocation.lng) * Math.PI / 180;
                        const a = Math.sin(dLat/2)**2 + Math.cos(userLocation.lat*Math.PI/180)*Math.cos(venue.location.latitude*Math.PI/180)*Math.sin(dLng/2)**2;
                        const dist = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
                        return <span style={{ fontSize: 'var(--t-meta)', color: colors.steel, fontWeight: '500' }}>{dist < 1 ? `${Math.round(dist*1000)}m` : `${dist.toFixed(1)}km`}</span>;
                      })()}
                    </div>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{venue.formatted_address}</p>
                  </div>
                  <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '3px' }}>
                    {Icons.chevronRight(colors.navyMid, 16)}
                  </div>
                </button>
              ))}
            </div>
          )}
          {/* A failed search and an empty search are different things and now
              say different words. This block used to render "Try a different
              search" for both, so a 500 from a missing Places key read as the
              user having spelled a bar's name wrong. */}
          {!venueSearching && venueQuery.trim().length >= 2 && venueResults.length === 0 && venueLoadError && (
            <BirdNote layout="row" size={48} role="alert" body={venueLoadError} style={{ padding: '12px 16px' }} />
          )}
          {!venueSearching && venueQuery.trim().length >= 2 && venueResults.length === 0 && !venueLoadError && (
            <BirdNote layout="row" bird={WARM_BIRD} size={48} body="No venues found. Try a different search." style={{ padding: '12px 16px' }} />
          )}
        </div>
      )}


      {/* Premium Map */}
      <div onClick={() => { setShowSearchDropdown(false); }} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {/* MapLibre GL — Snap Map-style vector tiles (smooth, free, no API key) */}
        <MapLibreMapView
          venues={allVenues}
          filterCategory={category}
          userLocation={userLocation}
          activeVenue={activeVenue}
          setActiveVenue={setActiveVenue}
          getCategoryColor={getCategoryColor}
          pickingVenueForCreate={pickingVenueForCreate}
          setPickingVenueForCreate={setPickingVenueForCreate}
          setSelectedVenueForCreate={setSelectedVenueForCreate}
          setCurrentScreen={setCurrentScreen}
          openVenueDetail={openVenueDetail}
          flockMemberLocations={flockMemberLocations}
          calcDistance={calcDistance}
          locationAllowed={locationEnabled}
          mapVisible={isExploreVisible}
        />

        {/* Live location sharing indicator on map */}
        {sharingLocationForFlock && (
          <div style={{
            position: 'absolute', top: '8px', left: '8px', right: '8px',
            padding: '8px 12px', borderRadius: '14px',
            background: 'linear-gradient(135deg, #059669, #047857)',
            display: 'flex', alignItems: 'center', gap: '8px',
            zIndex: 35, boxShadow: '0 1px 3px rgba(5,150,105,0.15)',
          }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '4px', backgroundColor: '#34d399', animation: 'pulse 2s ease-in-out infinite', boxShadow: 'none', flexShrink: 0 }} />
            <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'white', margin: 0, flex: 1 }}>
              Live location · {Object.keys(flockMemberLocations).length > 0 ? `${Object.keys(flockMemberLocations).length} member${Object.keys(flockMemberLocations).length > 1 ? 's' : ''} nearby` : 'Waiting for others...'}
            </p>
            <button className="hit44" onClick={stopLocationSharing} style={{ padding: '4px 10px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.3)', background: 'rgba(255,255,255,0.15)', color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>Stop</button>
          </div>
        )}

        {/* Floating "See All Results" on map. It moved from the bottom-right to
            the top-right: the bottom-right band is the map's own control rail
            (zoom, satellite, locate) plus the OSM attribution plus the docked
            SOS button, and there is not 52px of clear height left in it. Under
            the search bar is also where a result count belongs. It steps down
            while the live-location banner is up so the two never stack.
            No `glass-secondary` here. That class is `background: rgba(255,255,
            255,0.07) !important` in dark, i.e. all but transparent, which is
            fine over an app surface and invisible over the dark basemap — and
            the !important beat any inline colour. This chip floats on tiles, so
            it carries its own opaque face: cream with navy text in dark, the
            same inversion the pins use. `glass-btn` stays for the press feel,
            which is all it carries now. It used to add a blur as well, and a
            blur under an opaque face over a redrawing basemap is the most
            expensive way in the app to render nothing. */}
        {/* THE COUNT THE OVERLAY WILL ACTUALLY SHOW. This printed
            allVenues.length, the unfiltered list, while the screen it opens
            lists budgetFilteredVenues -- the same venues with anything above
            the flock's settled ceiling removed. So "All 20 results" opened on
            eleven, and the overlay only explains itself at exactly zero. Both
            ends read the one list now, so the promise and the screen cannot
            drift apart again. */}
        {(budgetFilteredVenues || []).length > 0 && !activeVenue && !showConnectPanel && !pickingVenueForCreate && (
          <button
            className="hit44 glass-btn"
            onClick={() => { setShowSearchResults(true); setShowSearchDropdown(false); }}
            style={{ position: 'absolute', top: sharingLocationForFlock ? '58px' : '12px', right: '12px', padding: '5px 10px', borderRadius: '9px', border: isDark ? '1px solid rgba(15,23,42,0.35)' : '1px solid var(--border-default)', background: isDark ? '#f1ede0' : 'var(--bg-card-solid)', color: isDark ? '#1e293b' : 'var(--text-secondary)', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', boxShadow: isDark ? '0 2px 10px rgba(0,0,0,0.45)' : 'var(--card-shadow-sm)' }}
          >
            All {(budgetFilteredVenues || []).length} results
          </button>
        )}

        {/* Find Your People Panel */}
        {showConnectPanel && (
          <div style={{ position: 'absolute', left: '8px', right: '8px', top: '8px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '16px', boxShadow: '0 2px 8px rgba(0,0,0,0.10)', zIndex: 40, maxHeight: '70%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '12px', borderBottom: '1px solid var(--divider)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
              <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.users(colors.navy, 16)} Find Your People</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button className="hit44 glass-btn glass-secondary" onClick={() => { setShowConnectPanel(false); setConnectSearch(''); setConnectResults([]); setCurrentScreen('addFriends'); }} style={{ padding: '4px 10px', borderRadius: '10px', backgroundColor: 'var(--icon-bg)', border: 'none', cursor: 'pointer', fontSize: 'var(--t-meta)', fontWeight: '600', color: colors.navy }}>See All</button>
                <button aria-label="Close" className="hit44" onClick={() => { setShowConnectPanel(false); setConnectSearch(''); setConnectResults([]); }} style={{ width: '28px', height: '28px', borderRadius: '14px', backgroundColor: 'var(--bg-hover)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x(colors.textSecondary, 14)}</button>
              </div>
            </div>

            {/* Search input */}
            <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-light)', flexShrink: 0 }}>
              <div style={{ position: 'relative' }}>
                {/* Local state, committed on a debounce: as a controlled input
                    owned by App.js this re-rendered the whole app, and the
                    results list under it, once per character. */}
                <SearchInputLocal aria-label="Search people by name"
                  type="text"
                  initialValue={connectSearch}
                  onCommit={handleConnectSearch}
                  placeholder="Search by name..."
                  style={{ width: '100%', padding: '10px 12px 10px 34px', borderRadius: '10px', border: `1.5px solid ${connectSearch ? colors.navy : colors.borderDefault}`, fontSize: 'var(--t-label)', outline: 'none', boxSizing: 'border-box', backgroundColor: 'var(--bg-tertiary)', fontWeight: '500', transition: 'opacity 0.2s ease' }}
                  autoComplete="off"
                />
                <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }}>{Icons.search(connectSearch ? colors.navy : colors.textTertiary, 14)}</span>
                {connectSearch && (
                  <button aria-label="Clear search" className="hit44" onClick={() => { setConnectSearch(''); setConnectResults([]); }} style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>{Icons.x(colors.textTertiary, 14)}</button>
                )}
              </div>
            </div>

            {/* Results */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
              {connectSearching && (
                <div style={{ textAlign: 'center', padding: '20px 0' }}>
                  <div style={{ display: 'inline-block', width: '16px', height: '16px', border: `2px solid ${colors.creamDark}`, borderTopColor: colors.navy, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', marginLeft: '8px' }}>Searching...</span>
                </div>
              )}

              {/* A failed search, said in the server's own words, rather than as
                  "No users found" over a lookup that never completed. */}
              {!connectSearching && connectSearchError && (
                <BirdNote layout="row" size={48} role="status" body={connectSearchError} style={{ padding: '16px 8px' }} />
              )}

              {!connectSearching && !connectSearchError && connectSearch.trim().length >= 1 && connectResults.length === 0 && (
                <BirdNote size={64} title={`No users found for "${connectSearch}"`} />
              )}

              {!connectSearching && connectResults.length > 0 && connectResults.map(user => {
                const status = friendStatuses[user.id] || 'none';
                return (
                  <div key={user.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px', borderRadius: '12px', backgroundColor: 'var(--bg-card-solid)', marginBottom: '8px' }}>
                    <button className="hit44" aria-label={`About ${user.name}`} onClick={() => openUserProfile({ id: user.id, name: user.name, image: user.profile_image_url })} style={{ width: '42px', height: '42px', borderRadius: '21px', backgroundColor: colors.navyMidBg, border: 'none', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-body)', fontWeight: '600', color: 'white', flexShrink: 0, cursor: 'pointer' }}>
                      {user.profile_image_url ? <img src={user.profile_image_url} alt="" style={{ width: '42px', height: '42px', borderRadius: '21px', objectFit: 'cover' }} /> : user.name[0]?.toUpperCase()}
                    </button>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontWeight: '600', fontSize: 'var(--t-label)', color: colors.navy, margin: 0 }}>{user.name}</p>
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '1px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</p>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                      {status === 'accepted' ? (
                        <span style={{ padding: '6px 12px', borderRadius: '20px', backgroundColor: 'var(--accent-green-bg)', color: 'var(--accent-green-text)', fontSize: 'var(--t-meta)', fontWeight: '500' }}>Friends</span>
                      ) : status === 'pending' ? (
                        <span style={{ padding: '6px 12px', borderRadius: '20px', backgroundColor: 'var(--pill-bg)', color: 'var(--text-secondary)', fontSize: 'var(--t-meta)', fontWeight: '500' }}>Pending</span>
                      ) : (
                        <button className="hit44 glass-btn glass-navy" onClick={(e) => { confirmClick(e); handleSendFriendRequest(user); }} style={{ padding: '6px 12px', borderRadius: '20px', border: 'none', backgroundColor: colors.navyBg, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>Add Friend</button>
                      )}
                      <button className="hit44 glass-btn glass-secondary" onClick={() => {
                        setShowConnectPanel(false); setConnectSearch(''); setConnectResults([]);
                        startNewDmWithUser(user);
                      }} style={{ padding: '6px 12px', borderRadius: '20px', border: `1.5px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>Message</button>
                    </div>
                  </div>
                );
              })}

              {!connectSearching && connectSearch.trim().length === 0 && (
                <div style={{ textAlign: 'center', padding: '24px 16px' }}>
                  <div style={{ width: '48px', height: '48px', borderRadius: '24px', backgroundColor: 'var(--icon-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px' }}>{Icons.search(colors.navy, 22)}</div>
                  <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: '0 0 4px' }}>Search for people</p>
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: 0 }}>Find friends by name</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Venue Popup with AI Crowd Forecast */}
        <AnimatePresence>
        {!showConnectPanel && renderConsumerVenueCard()}
        </AnimatePresence>
      </div>

      {/* Live Events Panel, sliding in from the right.
          `pointerEvents: none` and a negative z-index stop a FINGER. They do
          nothing to a keyboard or to VoiceOver: with the panel closed and
          parked at translateX(100%), Tab still walked into its back arrow,
          its "Search events" box and every event row, all of them painted
          past the right edge of the phone. `visibility: hidden` is the one
          property that takes the subtree out of both the tab order and the
          accessibility tree, and the delay lets the 0.35s slide out finish
          before it applies. */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: showEventsView ? 45 : -1, pointerEvents: showEventsView ? 'auto' : 'none', visibility: showEventsView ? undefined : 'hidden', transition: `visibility 0s linear ${showEventsView ? '0s' : '0.35s'}` }}>
        {/* Conditional, because the wrapper is mounted for the whole session
            and an unconditional marker would grab focus at app start.
            modal={false}: this is a push with the tab bar still beside it. */}
        {showEventsView && <DialogBehavior modal={false} onClose={() => { setShowEventsView(false); setEventsSearchQuery(''); }} />}
        <div style={{ position: 'absolute', inset: 0, backgroundColor: 'var(--bg-primary)', display: 'flex', flexDirection: 'column', transform: showEventsView ? 'translateX(0)' : 'translateX(100%)', transition: 'transform 0.35s cubic-bezier(0.4, 0, 0.2, 1)', willChange: 'transform' }}>
        {/* The gate. eventsDrawerMounted is declared at the top of this file
            and the comment there is the whole argument. The lines it wraps are
            deliberately not re-indented. */}
        {eventsDrawerMounted && (<>
          {/* Events header */}
          <div style={{ backgroundColor: 'var(--bg-card-solid)', borderBottom: '1px solid var(--border-default)', flexShrink: 0 }}>
            <div style={{ padding: '12px 12px 8px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <button aria-label="Back" className="hit44" onClick={() => { setShowEventsView(false); setEventsSearchQuery(''); }} style={{ width: '38px', height: '38px', borderRadius: '12px', border: 'none', backgroundColor: 'var(--bg-tertiary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'opacity 0.2s' }}>
                {Icons.arrowLeft(colors.navy, 18)}
              </button>
              <div style={{ flex: 1, position: 'relative' }}>
                {/* The typed value lives in the box, not in App.js. Every
                    keystroke here used to set state at the top of the app and
                    re-render the whole tree behind this drawer, which is what
                    typing into it felt like on a phone. The box commits upward
                    once the typing pauses; the Ticketmaster call is still
                    debounced behind that, at 280ms instead of 400 so the wait
                    from the last keystroke to the request is the 400ms it
                    always was. */}
                <SearchInputLocal aria-label="Search events"
                  type="text"
                  placeholder={userLocation ? 'Search concerts, games, shows...' : 'Turn on location to search events'}
                  disabled={!userLocation}
                  initialValue={eventsSearchQuery}
                  onCommit={(typed) => {
                    setEventsSearchQuery(typed);
                    if (typed.length >= 2 && userLocation) {
                      clearTimeout(eventsSearchTimerRef.current);
                      eventsSearchTimerRef.current = setTimeout(() => {
                        fetchFeaturedEvents(`${userLocation.lat},${userLocation.lng}`, typed);
                      }, 280);
                    } else if (typed.length === 0 && userLocation) {
                      fetchFeaturedEvents(`${userLocation.lat},${userLocation.lng}`);
                    }
                  }}
                  style={{ width: '100%', padding: '10px 14px 10px 36px', borderRadius: '12px', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: `2px solid ${eventsSearchQuery ? '#F59E0B' : colors.borderDefault}`, fontSize: 'var(--t-label)', outline: 'none', boxSizing: 'border-box', fontWeight: '500', transition: 'opacity 0.2s' }}
                  autoComplete="off"
                />
                <span style={{ position: 'absolute', left: '11px', top: '50%', transform: 'translateY(-50%)' }}>{Icons.search(eventsSearchQuery ? '#F59E0B' : colors.textTertiary, 15)}</span>
                {eventsSearchQuery && (
                  <button aria-label="Clear search" className="hit44" onClick={() => {
                    setEventsSearchQuery('');
                    if (userLocation) fetchFeaturedEvents(`${userLocation.lat},${userLocation.lng}`);
                  }} style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px' }}>{Icons.x(colors.textTertiary, 14)}</button>
                )}
              </div>
            </div>
            {/* Header label */}
            <div style={{ padding: '0 14px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {Icons.zap('#F59E0B', 16)}
                <span style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy }}>Live Events</span>
              </div>
              <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-tertiary)' }}>{eventsSearchQuery ? 'Search results' : 'This week nearby'}</span>
            </div>
          </div>

          {/* Events list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px 80px' }}>
            {featuredEventsLoading && (
              <div style={{ textAlign: 'center', padding: '32px 0' }}>
                <div style={{ display: 'inline-block', width: '24px', height: '24px', border: '3px solid var(--border-default)', borderTopColor: '#F59E0B', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '10px 0 0', fontWeight: '500' }}>Finding events near you...</p>
              </div>
            )}
            {/* Three answers, never one. A read that failed says so and keeps
                the retry here rather than sending the user off to search for
                something the app never managed to ask about. */}
            {!featuredEventsLoading && featuredEventsError && (
              <div role="alert" style={{ textAlign: 'center', padding: '40px 20px' }}>
                <BirdieStill size={80} style={{ margin: '0 auto' }} />
                <p style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--text-secondary)', margin: '12px 0 4px' }}>{featuredEventsError}</p>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '0 0 12px' }}>Nothing is wrong with your plans. This is the events list only.</p>
                {userLocation && (
                  <button className="hit44 glass-btn glass-navy" onClick={() => fetchFeaturedEvents(`${userLocation.lat},${userLocation.lng}`, eventsSearchQuery)} style={{ padding: '10px 16px', borderRadius: '10px', border: 'none', background: colors.navyMidBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-label)', cursor: 'pointer' }}>Try again</button>
                )}
              </div>
            )}
            {/* No read has landed yet and none is running: the screen was
                opened before there was a location to ask about. */}
            {!featuredEventsLoading && !featuredEventsError && !featuredEvents && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '40px 20px' }}>
                <EmptyMark name="steps" height={96} />
                <p style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--text-secondary)', margin: '12px 0 4px' }}>Events need your location</p>
                {/* Three sentences, never one: the ask, the wait, the failure.
                    A tap that asked the device and heard nothing back for ten
                    seconds used to change nothing on this screen at all. The
                    Discover banner's own words are not reused here because they
                    talk about the map; only its denial-or-not is read. */}
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: 0 }}>
                  {locationLoading
                    ? 'Finding where you are. Events near you show up once that lands.'
                    : locationError
                      ? (/Settings/.test(locationError)
                        ? 'Location is off for Flock on this phone. Turn it on in Settings, then come back.'
                        : 'Could not get your location just now. Try again.')
                      : 'Turn location on for Flock to see what is on near you.'}
                </p>
                {/* The sentence used to be the whole screen: a request with no
                    control. Same "Turn on" as the Discover banner. */}
                <button className="hit44" disabled={locationLoading} onClick={() => { if (!locationEnabled) toggleLocation(true); else requestUserLocation(true); }} style={{ marginTop: '14px', minHeight: '44px', padding: '10px 16px', borderRadius: '10px', border: '1px solid var(--border-mid)', background: 'transparent', color: 'var(--text-primary)', fontSize: 'var(--t-body)', fontWeight: '600', cursor: locationLoading ? 'default' : 'pointer', opacity: locationLoading ? 0.6 : 1 }}>{locationLoading ? 'Finding where you are' : locationError ? 'Try again' : 'Turn on location'}</button>
              </div>
            )}
            {!featuredEventsLoading && !featuredEventsError && featuredEvents && featuredEvents.length === 0 && (
              <div style={{ textAlign: 'center', padding: '40px 20px' }}>
                <BirdieStill bird={WARM_BIRD} size={80} style={{ margin: '0 auto' }} />
                <p style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--text-secondary)', margin: '12px 0 4px' }}>No events found nearby</p>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: 0 }}>Try searching for a specific event or artist</p>
              </div>
            )}
            {!featuredEventsLoading && (featuredEvents || []).filter(event => !event.datetime_utc || Date.parse(event.datetime_utc) > Date.now()).map(event => {
              const eventDate = event.date ? new Date(event.date + 'T' + (event.time || '00:00:00')) : null;
              const dateStr = eventDate ? eventDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
              const timeStr = event.time ? new Date('2000-01-01T' + event.time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
              const categoryColors = { concert: '#4a7ba7', sports: '#22C55E', arts: '#EC4899', comedy: '#F59E0B', festival: '#EF4444', film: '#3B82F6', other: colors.navy };
              const catColor = categoryColors[event.category] || colors.navy;
              // Only an absolute http(s) URL with no quote or bracket may reach
              // the CSS url() below, so a hostile or malformed vendor string
              // cannot close the url() and inject a second declaration.
              const headerArt = typeof event.image_url === 'string'
                && /^https?:\/\//i.test(event.image_url)
                && !/["'()\\\s]/.test(event.image_url)
                ? event.image_url
                : null;
              const dist = event.location && userLocation ? (() => {
                const dLat = (event.location.latitude - userLocation.lat) * Math.PI / 180;
                const dLng = (event.location.longitude - userLocation.lng) * Math.PI / 180;
                const a = Math.sin(dLat/2)**2 + Math.cos(userLocation.lat*Math.PI/180)*Math.cos(event.location.latitude*Math.PI/180)*Math.sin(dLng/2)**2;
                return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
              })() : null;

              return (
                <div
                  key={event.id}
                  style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '16px', border: '1px solid var(--border-default)', marginBottom: '10px', overflow: 'hidden', boxShadow: '0 2px 10px rgba(0,0,0,0.04)' }}
                >
                  {/* Event header.
                      This used to be an <img> whose onError set the image to
                      display:none and its own parent to height:0. The badges
                      inside that parent were absolutely positioned, so
                      collapsing the box did not remove them: they landed on the
                      title underneath and clipped it. Every Ticketmaster image
                      was failing that way, because the CDN was missing from the
                      img-src allowlist, so the broken case was the only case
                      anyone ever saw.
                      A background image has no error event and no zero-height
                      state. The box keeps its height whatever happens to the
                      picture, an unreachable URL simply leaves the category tint
                      showing, and the badges cannot escape their container. The
                      header renders for every event now, with or without art,
                      so the layout is one shape rather than two. */}
                  <div style={{
                    position: 'relative',
                    height: '132px',
                    backgroundColor: catColor,
                    backgroundImage: headerArt
                      ? `linear-gradient(rgba(0,0,0,0.10), rgba(0,0,0,0.62)), url("${headerArt}")`
                      : `linear-gradient(140deg, ${catColor} 0%, ${colors.navy} 100%)`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: '8px',
                    padding: '10px',
                  }}>
                    {/* Both plates are flat, at the same 0.62 the header's own
                        gradient ends on. They were 0.45 over an 8px
                        backdrop-filter, two per event over a list the backend
                        caps at twenty, so a drawer nobody had opened still held
                        forty blurred patches of photograph in the compositor.
                        A denser flat scrim suppresses the art underneath at
                        least as well as a thinner blurred one, and white on it
                        goes from about 3.1:1 in the bad case to about 5:1. */}
                    <span style={{ padding: '4px 10px', borderRadius: '10px', backgroundColor: 'rgba(0,0,0,0.62)', fontSize: 'var(--t-micro)', fontWeight: '700', color: 'white', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>{event.category}</span>
                    {dateStr && (
                      <span style={{ padding: '4px 10px', borderRadius: '10px', backgroundColor: 'rgba(0,0,0,0.62)', fontSize: 'var(--t-meta)', fontWeight: '600', color: 'white', whiteSpace: 'nowrap' }}>{dateStr}</span>
                    )}
                  </div>
                  {/* Event details */}
                  <div style={{ padding: '12px 14px' }}>
                    <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 4px', lineHeight: '1.3' }}>{event.name}</h3>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginBottom: '6px' }}>
                      {event.venue_name && (
                        <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '3px' }}>
                          {Icons.mapPin('var(--text-tertiary)', 12)} {event.venue_name}
                        </span>
                      )}
                      {dist != null && (
                        <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.steel }}>{dist < 1 ? `${Math.round(dist*1000)}m` : `${dist.toFixed(1)}km`}</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      {timeStr && (
                        <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, display: 'flex', alignItems: 'center', gap: '3px' }}>
                          {Icons.clock(colors.navy, 12)} {timeStr}
                        </span>
                      )}
                      {event.genre && event.genre !== event.category && (
                        <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: catColor, backgroundColor: `${catColor}15`, padding: '2px 8px', borderRadius: '8px' }}>{event.genre}</span>
                      )}
                      {event.price_range && (
                        <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)' }}>
                          {event.price_range.min === 0 && !event.price_range.max ? 'Free' : `$${fmtMoney(event.price_range.min)}${event.price_range.max ? `\u2013$${fmtMoney(event.price_range.max)}` : '+'}`}
                        </span>
                      )}
                    </div>
                    {/* Action buttons */}
                    <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                      <button className="hit44 glass-btn glass-navy" onClick={(e) => {
                        e.stopPropagation();
                        setSelectedVenueForCreate({ name: event.venue_name || event.name, addr: event.venue_address, lat: event.location?.latitude, lng: event.location?.longitude, photo_url: event.image_url, event_name: event.name, event_date: event.date || null, event_time: event.time || null, event_datetime_utc: event.datetime_utc || null });
                        setShowEventsView(false);
                        setCurrentScreen('create');
                      }} style={{ flex: 1, padding: '9px', borderRadius: '10px', border: 'none', background: colors.navyBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
                        {Icons.users('white', 13)} Start Flock
                      </button>
                      <button className="hit44 glass-btn glass-secondary" onClick={(e) => {
                        e.stopPropagation();
                        setEventDetailLoading(true);
                        setEventDetailError('');
                        setEventDetail({ ...event, photos: [], venue_details: null });
                        getEventDetails(event.id)
                          // Merge, and keep the list's distance: the single-event
                          // payload has none, so the miles line used to vanish.
                          // AND ONLY INTO AN OVERLAY THAT IS STILL OPEN. Spreading
                          // into a null prev yields {}, which is truthy, so a read
                          // landing after the user closed the card built a new one
                          // out of nothing and put it back on screen.
                          .then(data => setEventDetail(prev => (prev ? { ...prev, ...(data?.event || {}), distance_miles: data?.event?.distance_miles ?? prev?.distance_miles ?? null } : null)))
                          .catch((err) => setEventDetailError(err?.message || 'The rest of this event did not load.'))
                          .finally(() => setEventDetailLoading(false));
                      }} style={{ padding: '9px 14px', borderRadius: '10px', border: `2px solid ${colors.navy}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
                        {Icons.eye(colors.navy, 13)} Details
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>)}
        </div>
      </div>


      {/* Categories — expandable filter bar (matches Features button pattern) */}
      <div style={{ padding: '6px 12px', backgroundColor: 'var(--bg-card-solid)', borderTop: '1px solid var(--border-light)', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', justifyContent: categoryExpanded ? 'flex-start' : 'center', overflow: 'hidden' }}>
          {categoryExpanded && (
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', overflowX: 'auto', scrollbarWidth: 'none', msOverflowStyle: 'none', WebkitOverflowScrolling: 'touch', flex: 1, minWidth: 0 }}>
              {['All', 'Food', 'Nightlife', 'Live Music', 'Sports'].map(c => (
                <button key={c} className="hit44 glass-btn glass-secondary" onClick={() => {
                  setActiveVenue(null); setCategoryExpanded(false);
                  if (c === 'All') { setCategory('All'); setVenueQuery(''); requestUserLocation(true); return; }
                  setCategory(c);
                }} style={{
                  padding: '6px 12px', borderRadius: '14px', border: 'none',
                  backgroundColor: category === c ? colors.navyBg : 'var(--bg-hover)',
                  color: category === c ? colors.cream : 'var(--text-primary)',
                  fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer', whiteSpace: 'nowrap',
                  flexShrink: 0, animation: 'fadeSlideIn 0.2s ease-out both',
                }}>
                  {c}
                </button>
              ))}
            </div>
          )}
          <button className="hit44" onClick={() => setCategoryExpanded(!categoryExpanded)} style={{
            height: '36px', minWidth: categoryExpanded ? '36px' : 'auto', width: categoryExpanded ? '36px' : '100%',
            borderRadius: '14px', border: '1px solid var(--border-default)', background: 'var(--bg-card-solid)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
            padding: categoryExpanded ? '0' : '0 14px', fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--text-primary)',
            flexShrink: 0, transition: 'all 0.3s ease',
          }}>
            {categoryExpanded ? Icons.x('var(--text-primary)', 16) : <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', whiteSpace: 'nowrap' }}>Filters{category !== 'All' ? ` · ${category}` : ''}</span>}
          </button>
        </div>
      </div>

      {SafetyButton()}
      {BottomNav()}
    </div>
  );
}
