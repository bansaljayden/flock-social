/**
 * VENUE ONBOARDING SCREEN
 *
 * This was the twelve-step venue signup, several hundred lines of `App.js`,
 * declared as an arrow function inside `FlockAppInner` and CALLED rather than
 * mounted. It moved out for the same reason the venue owner dashboard, the
 * flock chat screen and Add Friends did: a single file holding every screen in
 * the product is a file nobody can review.
 *
 * It is what a venue-mode login lands on the first time, before the dashboard
 * exists. The first five steps set up the listing (the Google Places pick,
 * category, location, goals, a one-line description); steps six through eleven
 * are the things about a room that no dataset holds, every one of them
 * skippable.
 *
 * WHY IT IS A STATIC IMPORT, NOT React.lazy. Only a venue-mode login reaches
 * it, and it reaches it once. The dashboard behind it is the paid product and
 * is lazy for a real audience reason; this is the small screen in front of that
 * gate, and splitting a screen this size behind a chunk fetch would charge a
 * venue owner a round trip in the middle of their own signup to buy back a few
 * kilobytes a consumer never downloads anyway. It is imported the way
 * AddFriends and ChatDetail are, and mounts in the app chunk.
 *
 * WHY EVERYTHING ARRIVES AS A PROP. The old arrow closed over FlockAppInner's
 * state, its setters and a handful of that component's own helpers and
 * constants: the venue-field renderers, the option lists, and the Google-hours
 * parser. None of those moved, because FlockAppInner does not unmount when the
 * owner leaves this screen, so the search box, the debounce timer and every
 * answer typed so far survive a trip elsewhere exactly as before. They are
 * parameters now, so the whole dependency surface of this file is its parameter
 * list plus its imports, and a name it reads and does not receive is an
 * undefined identifier `no-undef` fails the build on, rather than a prop that
 * is silently `undefined` at runtime and renders as nothing.
 *
 * The names below were not read off the page. They are the free identifiers of
 * the block from a Babel scope walk, minus the platform globals and the five
 * module imports, and the props object at the call site in `renderScreen` was
 * built from the same list, so the two cannot drift apart.
 *
 * The body is the old block verbatim, including its original four-space
 * indentation, so it diffs against the deleted lines character for character.
 * This screen reads no hooks of its own: it is a pure function of its props.
 */
import React from 'react';
import { checkVenueClaim, createVenueProfile, getVenueDetails, searchVenues } from '../services/api';
import { BirdieStill, WARM_BIRD } from '../components/ui/BirdieBird';

export default function VenueOnboarding({
  VENUE_MAX_ANCHORS,
  parseGoogleHours,
  renderVenueChips,
  renderVenueField,
  renderVenueNumber,
  renderVenueTime,
  setCurrentScreen,
  setCurrentTab,
  setOperatingHours,
  setShowVenueOnboarding,
  setShowModeSelection,
  setUserMode,
  onUserPatch,
  setVenueInfo,
  setVenueOnboardingData,
  setVenueOnboardingError,
  setVenueOnboardingStep,
  setVenueSearchError,
  setVenueSearchQuery,
  setVenueSearchResults,
  setVenueSearchState,
  userLocation,
  venueAgePolicies,
  venueAnchorTypes,
  venueCategories,
  venueGoals,
  venueOnboardingData,
  venueOnboardingError,
  venueOnboardingStep,
  venueReservationPolicies,
  venueSearchError,
  venueSearchQuery,
  venueSearchResults,
  venueSearchState,
  venueSearchTimer,
  venueServiceStyles,
  venueWeekdays,
}) {

    const steps = [
      // Step 0: Welcome
      () => (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: '24px', textAlign: 'center' }}>
          <img src="/flock-logo.png" alt="Flock" style={{ width: '120px', height: '120px', borderRadius: '50%', objectFit: 'cover', marginBottom: '24px', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }} />
          <h1 style={{ fontSize: 'var(--t-display)', fontWeight: '600', color: '#f0ead8', margin: '0 0 8px' }}>Welcome to Flock for Venues</h1>
          {/* Was "so you can start reaching customers and tracking
              performance", which is the register of a plan page rather than a
              first screen, and names two outcomes nothing here delivers on its
              own. This says what the next twelve steps actually are. */}
          <p style={{ fontSize: 'var(--t-body)', color: 'rgba(148,163,184,0.7)', lineHeight: 1.5, maxWidth: '300px' }}>A few questions about your venue. The first five set up your listing, and the rest are things about the room that no dataset holds. Every one of those is skippable.</p>
        </div>
      ),
      // Step 1: pick the venue out of Google Places. THE PLACE ID IS THE POINT.
      //
      // This step used to accept a typed name and move on, and googlePlaceId
      // was set only if the owner happened to tap a suggestion. That made the
      // join key optional, and the join key is what everything downstream is
      // keyed on: ml_venue_baselines and ml_venues (so, whether the crowd model
      // can say anything at all about this venue), the venue badge, NFC taps,
      // incoming flocks, and the one-owner-per-place claim check. A profile
      // with no place id is a profile that can never receive any of it, and
      // nothing in the old flow told the owner that.
      //
      // So the pick is now required, and canAdvance() below enforces it.
      () => (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '24px' }}>
          <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: '#f0ead8', margin: '0 0 6px' }}>Find your venue</h2>
          <p style={{ fontSize: 'var(--t-label)', color: 'rgba(148,163,184,0.6)', margin: '0 0 24px' }}>Pick it from the list. That is how we match you to the crowd history we already hold for your address.</p>
          {venueOnboardingData.googlePlaceId ? (
            <div style={{ borderRadius: '14px', border: '1.5px solid rgba(240,234,216,0.35)', backgroundColor: 'rgba(240,234,216,0.08)', padding: '16px' }}>
              <div style={{ fontSize: 'var(--t-body)', fontWeight: '700', color: '#f0ead8' }}>{venueOnboardingData.businessName}</div>
              <div style={{ fontSize: 'var(--t-meta)', color: 'rgba(148,163,184,0.6)', marginTop: '2px' }}>{venueOnboardingData.location}</div>
              <button className="hit44" type="button" onClick={() => {
                setVenueOnboardingData(d => ({ ...d, googlePlaceId: '' }));
                setVenueSearchQuery('');
                setVenueSearchResults([]);
                setVenueSearchState('idle');
                setVenueSearchError('');
              }} style={{ background: 'none', border: 'none', padding: '8px 0 0', color: 'rgba(148,163,184,0.75)', fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer', textDecoration: 'underline' }}>Not this one</button>
            </div>
          ) : (
          <div style={{ position: 'relative' }}>
            <input aria-label="Venue name" maxLength={255} value={venueSearchQuery} onChange={(e) => {
              const val = e.target.value;
              setVenueSearchQuery(val);
              setVenueOnboardingData(d => ({ ...d, businessName: val }));
              if (venueSearchTimer.current) clearTimeout(venueSearchTimer.current);
              if (val.length < 2) { setVenueSearchResults([]); setVenueSearchState('idle'); setVenueSearchError(''); return; }
              setVenueSearchState('searching');
              setVenueSearchError('');
              // 300ms debounce, and it is a SPENDING control as much as a UX
              // one: GET /api/venues/search is a paid Google Text Search behind
              // backend/utils/placesBudget.js at 30 per user per hour. One call
              // per keystroke would burn an owner's whole hourly allowance
              // inside one venue name. The backend also caches each distinct
              // query for five minutes, so backspacing costs nothing.
              venueSearchTimer.current = setTimeout(async () => {
                try {
                  const loc = userLocation ? `${userLocation.lat},${userLocation.lng}` : null;
                  const data = await searchVenues(val, loc);
                  const found = (data.venues || []).slice(0, 5);
                  setVenueSearchResults(found);
                  setVenueSearchState(found.length > 0 ? 'idle' : 'none');
                } catch (e) {
                  // A throttle or an outage is not "your venue does not exist",
                  // and it is not nothing either. Say which it was.
                  setVenueSearchResults([]);
                  setVenueSearchState('idle');
                  setVenueSearchError(e?.message || 'Search is not responding. Try again in a moment.');
                }
              }, 300);
            }}
            placeholder="e.g. The Blue Heron Bar"
            autoComplete="off" data-lpignore="true" data-form-type="other"
            style={{ width: '100%', padding: '14px 16px', borderRadius: '12px', border: '1.5px solid rgba(148,163,184,0.15)', fontSize: '16px', fontWeight: '500', outline: 'none', boxSizing: 'border-box', backgroundColor: 'rgba(255,255,255,0.06)', color: 'white' }} autoFocus />
            {venueSearchResults.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: '4px', borderRadius: '12px', overflow: 'hidden', border: '1px solid rgba(148,163,184,0.15)', backgroundColor: 'rgba(15,23,42,0.95)', backdropFilter: 'blur(12px)', zIndex: 10 }}>
                {venueSearchResults.map((v, i) => (
                  <button className="hit44" key={v.place_id || i} onClick={() => {
                    const cat = (v.types || [])[0]?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || '';
                    const categoryMap = { 'Bar': 'Bar / Nightclub', 'Night Club': 'Bar / Nightclub', 'Restaurant': 'Restaurant', 'Cafe': 'Cafe / Coffee', 'Brewery': 'Brewery / Winery', 'Winery': 'Brewery / Winery' };
                    const matchedCat = Object.entries(categoryMap).find(([k]) => cat.toLowerCase().includes(k.toLowerCase()));
                    setVenueOnboardingData(d => ({
                      ...d,
                      businessName: v.name,
                      location: v.formatted_address || v.vicinity || d.location,
                      category: matchedCat ? matchedCat[1] : d.category,
                      googlePlaceId: v.place_id,
                    }));
                    setVenueSearchQuery(v.name);
                    setVenueSearchResults([]);
                    // Already claimed by a verified owner? Said here, under the
                    // pick, rather than after eleven more screens.
                    if (v.place_id) {
                      checkVenueClaim(v.place_id)
                        .then((r) => { if (r?.claimedByAnother) setVenueSearchError(r.message || 'That business is already claimed by a verified owner. If it is yours, email social@flockcorp.com.'); })
                        .catch(() => {});
                    }
                    // Fetch phone + hours from Google Places
                    if (v.place_id) {
                      getVenueDetails(v.place_id).then(data => {
                        const venue = data.venue || data;
                        if (venue.formatted_phone_number) {
                          setVenueInfo(prev => ({ ...prev, name: v.name, address: v.formatted_address || v.vicinity || prev.address, phone: venue.formatted_phone_number }));
                        }
                        if (venue.opening_hours?.weekdayDescriptions) {
                          const parsed = parseGoogleHours(venue.opening_hours.weekdayDescriptions);
                          if (parsed.length > 0) setOperatingHours(parsed);
                        }
                      }).catch(() => {});
                    }
                  }} style={{
                    width: '100%', padding: '12px 16px', border: 'none', borderBottom: i < venueSearchResults.length - 1 ? '1px solid rgba(148,163,184,0.08)' : 'none',
                    background: 'transparent', cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '2px',
                  }}>
                    <span style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: '#f0ead8' }}>{v.name}</span>
                    <span style={{ fontSize: 'var(--t-meta)', color: 'rgba(148,163,184,0.5)' }}>{v.formatted_address || v.vicinity || ''}</span>
                  </button>
                ))}
              </div>
            )}
            {venueSearchError && (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px', margin: '10px 0 0' }}>
                <BirdieStill size={56} style={{ flexShrink: 0 }} />
                <p role="alert" style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: '#fca5a5', margin: 0, lineHeight: 1.5, flex: 1, minWidth: 0 }}>{venueSearchError}</p>
              </div>
            )}
            {venueSearchState === 'searching' && (
              <p style={{ fontSize: 'var(--t-meta)', color: 'rgba(148,163,184,0.6)', margin: '10px 0 0' }}>Looking...</p>
            )}
            {venueSearchState === 'none' && !venueSearchError && (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px', margin: '10px 0 0' }}>
              <BirdieStill bird={WARM_BIRD} size={64} style={{ flexShrink: 0 }} />
              <p role="status" style={{ fontSize: 'var(--t-meta)', color: 'rgba(148,163,184,0.75)', margin: 0, lineHeight: 1.5, flex: 1, minWidth: 0 }}>
                No match. Flock links a venue to its Google Maps listing, so try the name exactly as it appears there. If your business has no listing yet, create one first, then come back. Stuck? <a href="mailto:social@flockcorp.com" style={{ color: '#f0ead8' }}>social@flockcorp.com</a>
              </p>
              </div>
            )}
          </div>
          )}
        </div>
      ),
      // Step 2: Category
      () => (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '24px' }}>
          <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: '#f0ead8', margin: '0 0 6px' }}>What type of venue?</h2>
          <p style={{ fontSize: 'var(--t-label)', color: 'rgba(148,163,184,0.6)', margin: '0 0 20px' }}>Pick the best fit. You can change this later.</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {venueCategories.map(cat => (
              <button className="hit44" key={cat} onClick={() => setVenueOnboardingData(d => ({ ...d, category: cat }))} style={{ padding: '10px 16px', borderRadius: '20px', border: venueOnboardingData.category === cat ? '2px solid #f0ead8' : '1.5px solid rgba(148,163,184,0.15)', backgroundColor: venueOnboardingData.category === cat ? 'rgba(240,234,216,0.12)' : 'rgba(255,255,255,0.04)', color: venueOnboardingData.category === cat ? '#f0ead8' : 'rgba(148,163,184,0.7)', fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer', transition: 'all 0.15s' }}>
                {cat}
              </button>
            ))}
          </div>
        </div>
      ),
      // Step 3: Location
      () => (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '24px' }}>
          <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: '#f0ead8', margin: '0 0 6px' }}>Where are you located?</h2>
          <p style={{ fontSize: 'var(--t-label)', color: 'rgba(148,163,184,0.6)', margin: '0 0 24px' }}>City or full address, so nearby customers can find you.</p>
          {/* maxLength mirrors the server's bounds (venueProfile.js: location
              255, description 2000). Without them the form let someone type
              past the limit and only found out at the very last step. */}
          <input aria-label="Venue address" maxLength={255} value={venueOnboardingData.location} onChange={(e) => setVenueOnboardingData(d => ({ ...d, location: e.target.value }))} placeholder="e.g. Austin, TX or 123 Main St" autoComplete="off" data-lpignore="true" data-form-type="other" style={{ width: '100%', padding: '14px 16px', borderRadius: '12px', border: '1.5px solid rgba(148,163,184,0.15)', fontSize: '16px', fontWeight: '500', outline: 'none', boxSizing: 'border-box', backgroundColor: 'rgba(255,255,255,0.06)', color: 'white' }} autoFocus />
        </div>
      ),
      // Step 4: Goals
      () => (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '24px' }}>
          <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: '#f0ead8', margin: '0 0 6px' }}>What are your goals?</h2>
          {/* "We'll customize your dashboard" was a promise nothing keeps.
              backend/routes/venueProfile.js says it in its own header: goals
              are owner-only and nothing reads them but the dashboard reading
              them back. The dashboard is the same six tabs whichever of these
              you tick. So the line now says the true thing, which is that we
              are asking what you want out of this and keeping the answer. */}
          <p style={{ fontSize: 'var(--t-label)', color: 'rgba(148,163,184,0.6)', margin: '0 0 20px' }}>Pick all that apply. You can change this later in Settings.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {venueGoals.map(goal => {
              const selected = venueOnboardingData.goals.includes(goal);
              return (
                <button className="hit44" key={goal} onClick={() => setVenueOnboardingData(d => ({ ...d, goals: selected ? d.goals.filter(g => g !== goal) : [...d.goals, goal] }))} style={{ padding: '12px 16px', borderRadius: '12px', border: selected ? '2px solid #f0ead8' : '1.5px solid rgba(148,163,184,0.15)', backgroundColor: selected ? 'rgba(240,234,216,0.1)' : 'rgba(255,255,255,0.04)', color: selected ? '#f0ead8' : 'rgba(148,163,184,0.7)', fontSize: 'var(--t-body)', fontWeight: '600', cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '10px', transition: 'all 0.15s' }}>
                  <div style={{ width: '20px', height: '20px', borderRadius: '6px', border: selected ? '2px solid #f0ead8' : '2px solid rgba(148,163,184,0.2)', backgroundColor: selected ? '#f0ead8' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {selected && <svg aria-hidden="true" focusable="false" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#0f172a" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
                  </div>
                  {goal}
                </button>
              );
            })}
          </div>
        </div>
      ),
      // Step 5: Quick description
      () => (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '24px' }}>
          <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: '#f0ead8', margin: '0 0 6px' }}>Describe your venue in a line</h2>
          <p style={{ fontSize: 'var(--t-label)', color: 'rgba(148,163,184,0.6)', margin: '0 0 24px' }}>What makes your place special? This shows on your Flock listing.</p>
          <textarea aria-label="Venue description" maxLength={2000} value={venueOnboardingData.description} onChange={(e) => setVenueOnboardingData(d => ({ ...d, description: e.target.value }))} placeholder="e.g. Craft cocktail bar with live jazz on weekends" rows={3} autoComplete="off" data-lpignore="true" data-form-type="other" style={{ width: '100%', padding: '14px 16px', borderRadius: '12px', border: '1.5px solid rgba(148,163,184,0.15)', fontSize: 'var(--t-body)', fontWeight: '500', outline: 'none', boxSizing: 'border-box', backgroundColor: 'rgba(255,255,255,0.06)', color: 'white', resize: 'none', fontFamily: 'inherit' }} autoFocus />
        </div>
      ),
      // ── Steps 6 to 11: the things only the owner knows ──────────────────────
      //
      // The crowd model is blind to venue identity on purpose (place id and
      // coordinates are on the forbidden-features list, so two bars of the same
      // price and rating band get the same prediction). Everything below is
      // context that no dataset holds and that turns a category-level number
      // into a sentence about THIS room.
      //
      // Every one of these steps is skippable, and the Skip button is on screen
      // rather than implied. A skipped answer means we stay quiet on that
      // subject; a guessed one would read as measurement.

      // Step 6: the room
      () => (
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
          <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: '#f0ead8', margin: '0 0 6px' }}>How big is the room?</h2>
          <p style={{ fontSize: 'var(--t-label)', color: 'rgba(148,163,184,0.6)', margin: '0 0 24px', lineHeight: 1.5 }}>We measure how busy you are on a 0 to 100 scale. Your numbers turn that into people.</p>
          {renderVenueField({
            label: 'How many people fit', hint: 'Comfortably full, not the fire-code maximum.',
            children: renderVenueNumber({ value: venueOnboardingData.capacity, onChange: (v) => setVenueOnboardingData(d => ({ ...d, capacity: v })), min: 1, max: 20000, placeholder: '220', ariaLabel: 'Capacity', suffix: 'people' }),
          })}
          {renderVenueField({
            label: 'How people are served',
            children: renderVenueChips({ label: 'Service style', options: venueServiceStyles, value: venueOnboardingData.serviceStyle, onChange: (v) => setVenueOnboardingData(d => ({ ...d, serviceStyle: v })) }),
          })}
          {renderVenueField({
            label: 'Outdoor seating', hint: 'We already read the forecast. A patio changes what a warm Thursday is worth to you.',
            children: renderVenueChips({
              label: 'Outdoor seating',
              options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
              value: venueOnboardingData.hasOutdoorSeating === true ? 'yes' : venueOnboardingData.hasOutdoorSeating === false ? 'no' : '',
              onChange: (v) => setVenueOnboardingData(d => ({ ...d, hasOutdoorSeating: v === 'yes' ? true : v === 'no' ? false : null })),
            }),
          })}
        </div>
      ),
      // Step 7: groups, which is the only thing this app plans
      () => (
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
          <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: '#f0ead8', margin: '0 0 6px' }}>What happens when a group shows up?</h2>
          <p style={{ fontSize: 'var(--t-label)', color: 'rgba(148,163,184,0.6)', margin: '0 0 24px', lineHeight: 1.5 }}>Flock plans groups, not solo visits. This is what we get asked before anyone leaves the house.</p>
          {renderVenueField({
            label: 'Bookings',
            children: renderVenueChips({ label: 'Reservation policy', options: venueReservationPolicies, value: venueOnboardingData.reservationPolicy, onChange: (v) => setVenueOnboardingData(d => ({ ...d, reservationPolicy: v })) }),
          })}
          {renderVenueField({
            label: 'Biggest group you will seat without a booking',
            children: renderVenueNumber({ value: venueOnboardingData.largestWalkinGroup, onChange: (v) => setVenueOnboardingData(d => ({ ...d, largestWalkinGroup: v })), min: 1, max: 200, placeholder: '6', ariaLabel: 'Largest walk-in group', suffix: 'people' }),
          })}
          {renderVenueField({
            label: 'How long a group usually stays', hint: 'Roughly. It is what tells someone waiting when the next table frees up.',
            children: renderVenueNumber({ value: venueOnboardingData.typicalDwellMinutes, onChange: (v) => setVenueOnboardingData(d => ({ ...d, typicalDwellMinutes: v })), min: 10, max: 600, placeholder: '90', ariaLabel: 'Typical visit length in minutes', suffix: 'minutes' }),
          })}
          {renderVenueField({
            label: 'Typical spend per person', hint: 'Groups in Flock often set a budget before they pick a place.',
            children: renderVenueNumber({ value: venueOnboardingData.typicalSpendPerPerson, onChange: (v) => setVenueOnboardingData(d => ({ ...d, typicalSpendPerPerson: v })), min: 1, max: 1000, placeholder: '35', ariaLabel: 'Typical spend per person in dollars', suffix: 'dollars' }),
          })}
        </div>
      ),
      // Step 8: the clock the front door does not show
      () => (
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
          <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: '#f0ead8', margin: '0 0 6px' }}>What closes before you do?</h2>
          <p style={{ fontSize: 'var(--t-label)', color: 'rgba(148,163,184,0.6)', margin: '0 0 24px', lineHeight: 1.5 }}>Google shows your opening hours. It does not show when the kitchen stops or when the door tightens up.</p>
          {renderVenueField({
            label: 'Kitchen stops taking orders at',
            children: renderVenueTime({ value: venueOnboardingData.kitchenLastOrder, onChange: (v) => setVenueOnboardingData(d => ({ ...d, kitchenLastOrder: v })), ariaLabel: 'Kitchen last order' }),
          })}
          {renderVenueField({
            label: 'Last call at', hint: 'Leave blank if you do not serve alcohol.',
            children: renderVenueTime({ value: venueOnboardingData.lastCall, onChange: (v) => setVenueOnboardingData(d => ({ ...d, lastCall: v })), ariaLabel: 'Last call' }),
          })}
          {renderVenueField({
            label: 'Who you let in',
            children: renderVenueChips({ label: 'Age policy', options: venueAgePolicies, value: venueOnboardingData.agePolicy, onChange: (v) => setVenueOnboardingData(d => ({ ...d, agePolicy: v, ageRestrictedAfter: v === 'all_ages' ? '' : d.ageRestrictedAfter })) }),
          })}
          {venueOnboardingData.agePolicy && venueOnboardingData.agePolicy !== 'all_ages' && renderVenueField({
            label: 'From what time', hint: 'Leave blank if the rule applies all day. Otherwise we can tell a group with a younger friend to come earlier instead of turning up and being refused.',
            children: renderVenueTime({ value: venueOnboardingData.ageRestrictedAfter, onChange: (v) => setVenueOnboardingData(d => ({ ...d, ageRestrictedAfter: v })), ariaLabel: 'Age restriction start time' }),
          })}
        </div>
      ),
      // Step 9: the week
      () => (
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
          <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: '#f0ead8', margin: '0 0 6px' }}>How does your week go?</h2>
          <p style={{ fontSize: 'var(--t-label)', color: 'rgba(148,163,184,0.6)', margin: '0 0 24px', lineHeight: 1.5 }}>We hold crowd history for a lot of venues. Where your answer and the history disagree is the useful part.</p>
          {renderVenueField({
            label: 'Nights you run something', hint: 'Trivia, live music, a league, a weekly special.',
            children: renderVenueChips({ label: 'Event nights', options: venueWeekdays, value: venueOnboardingData.eventNights, onChange: (v) => setVenueOnboardingData(d => ({ ...d, eventNights: v })), multi: true }),
          })}
          {venueOnboardingData.eventNights.length > 0 && renderVenueField({
            label: 'What runs on those nights',
            children: (
              <input aria-label="What runs on those nights" maxLength={120} value={venueOnboardingData.eventNote}
                onChange={(e) => setVenueOnboardingData(d => ({ ...d, eventNote: e.target.value }))}
                placeholder="e.g. Trivia at 8, live band after 10"
                autoComplete="off" data-lpignore="true" data-form-type="other"
                style={{ width: '100%', padding: '12px 14px', borderRadius: '12px', border: '1.5px solid rgba(148,163,184,0.15)', fontSize: '16px', fontWeight: '500', outline: 'none', boxSizing: 'border-box', backgroundColor: 'rgba(255,255,255,0.06)', color: 'white' }} />
            ),
          })}
          {renderVenueField({
            label: 'Nights you think are your busiest',
            children: renderVenueChips({ label: 'Busy nights', options: venueWeekdays, value: venueOnboardingData.ownerBusyNights, onChange: (v) => setVenueOnboardingData(d => ({ ...d, ownerBusyNights: v })), multi: true }),
          })}
          {renderVenueField({
            label: 'The one night you want fuller',
            children: renderVenueChips({ label: 'Night you want fuller', options: venueWeekdays, value: venueOnboardingData.targetNight, onChange: (v) => setVenueOnboardingData(d => ({ ...d, targetNight: v })) }),
          })}
        </div>
      ),
      // Step 10: the street
      () => (
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
          <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: '#f0ead8', margin: '0 0 6px' }}>What is near you?</h2>
          <p style={{ fontSize: 'var(--t-label)', color: 'rgba(148,163,184,0.6)', margin: '0 0 24px', lineHeight: 1.5 }}>Our model is not allowed to know where you are, on purpose. So a stadium across the road is invisible to it unless you say so.</p>
          {renderVenueField({
            label: `Within a short walk (pick up to ${VENUE_MAX_ANCHORS})`,
            children: renderVenueChips({ label: 'Nearby anchors', options: venueAnchorTypes, value: venueOnboardingData.anchorTypes, onChange: (v) => setVenueOnboardingData(d => ({ ...d, anchorTypes: v })), multi: true, max: VENUE_MAX_ANCHORS }),
          })}
          {venueOnboardingData.anchorTypes.length > 0 && renderVenueField({
            label: 'Name it', hint: 'The name is what lets us look up a schedule.',
            children: (
              <input aria-label="Nearby anchor detail" maxLength={200} value={venueOnboardingData.anchorNote}
                onChange={(e) => setVenueOnboardingData(d => ({ ...d, anchorNote: e.target.value }))}
                placeholder="e.g. Across from Lincoln Financial Field"
                autoComplete="off" data-lpignore="true" data-form-type="other"
                style={{ width: '100%', padding: '12px 14px', borderRadius: '12px', border: '1.5px solid rgba(148,163,184,0.15)', fontSize: '16px', fontWeight: '500', outline: 'none', boxSizing: 'border-box', backgroundColor: 'rgba(255,255,255,0.06)', color: 'white' }} />
            ),
          })}
        </div>
      ),
      // Step 11: the catch-all, which is where the best answers come from
      () => (
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
          <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: '#f0ead8', margin: '0 0 6px' }}>Anything a stranger would not guess?</h2>
          <p style={{ fontSize: 'var(--t-label)', color: 'rgba(148,163,184,0.6)', margin: '0 0 20px', lineHeight: 1.5 }}>The back room being quiet when the front is packed. Parking that fills by seven. Cash only after midnight. Write it how you would say it.</p>
          <textarea aria-label="What a stranger would not guess" maxLength={1000} rows={6}
            value={venueOnboardingData.quirks}
            onChange={(e) => setVenueOnboardingData(d => ({ ...d, quirks: e.target.value }))}
            placeholder="e.g. The patio holds 40 more but we close it when it drops below 55."
            autoComplete="off" data-lpignore="true" data-form-type="other"
            style={{ width: '100%', padding: '14px 16px', borderRadius: '12px', border: '1.5px solid rgba(148,163,184,0.15)', fontSize: 'var(--t-body)', fontWeight: '500', outline: 'none', boxSizing: 'border-box', backgroundColor: 'rgba(255,255,255,0.06)', color: 'white', resize: 'none', fontFamily: 'inherit' }} autoFocus />
          <p style={{ fontSize: 'var(--t-meta)', color: 'rgba(148,163,184,0.5)', margin: '8px 0 0', textAlign: 'right' }}>{venueOnboardingData.quirks.length} / 1000</p>
        </div>
      ),
    ];

    // Steps whose answers are optional. They get a visible Skip (SLOP-AUDIT
    // §G10) rather than relying on the owner guessing that Continue works on an
    // empty screen. Index 5 is the description, 6 to 11 are the intake steps.
    const skippableSteps = new Set([5, 6, 7, 8, 9, 10, 11]);

    const canAdvance = () => {
      if (venueOnboardingStep === 0) return true;
      // The place id, not the typed name. See the note on step 1: a profile
      // with no place id can never be matched to crowd history, claimed,
      // badged, or reached by an NFC tap, and the old check let one through.
      if (venueOnboardingStep === 1) return !!venueOnboardingData.googlePlaceId;
      if (venueOnboardingStep === 2) return venueOnboardingData.category !== '';
      if (venueOnboardingStep === 3) return venueOnboardingData.location.trim().length > 0;
      if (venueOnboardingStep === 4) return venueOnboardingData.goals.length > 0;
      return true;
    };

    const handleNext = async () => {
      // A stale rejection must not follow the owner around the flow.
      if (venueOnboardingError) setVenueOnboardingError('');
      if (venueOnboardingStep < steps.length - 1) {
        setVenueOnboardingStep(s => s + 1);
      } else {
        // Complete onboarding — save to backend.
        // The failure used to go to console.error and nowhere else: the flow
        // marched on to the dashboard, wrote the "onboarding complete" flag,
        // and the owner never learned their profile had not saved. The server
        // validates and bounds these fields, so a rejection is a real outcome.
        let created = null;
        try {
          created = await createVenueProfile(venueOnboardingData);
        } catch (err) {
          console.error('Failed to save venue profile:', err);
          // An unverified email is not a detail to check: say what to do.
          setVenueOnboardingError(err?.data?.emailVerificationRequired
            ? 'Confirm your email first. Open the link we sent to your inbox, then finish this step. Every answer here is kept.'
            : (err?.message || "That didn't save. Check your details and try again."));
          return; // stay on the last step with every answer still filled in
        }
        setVenueOnboardingError('');
        localStorage.setItem('flockVenueOnboardingComplete', 'true');
        // The server just made this account an owner and says so in its
        // answer. Without this the dashboard's role guard bounced a brand-new
        // owner to the consumer feed, and the auto-mode effect had written
        // 'user' to disk, so relaunching did the same.
        if (created?.role && typeof onUserPatch === 'function') onUserPatch({ role: created.role });
        setUserMode('venue');
        try { localStorage.setItem('flockUserMode', 'venue'); } catch (e) { /* storage blocked */ }
        if (typeof setShowModeSelection === 'function') setShowModeSelection(false);
        setShowVenueOnboarding(false);
        setCurrentScreen('venueDashboard');
      }
    };

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: '#0f172a' }}>
        {/* Progress bar */}
        <div style={{ padding: '16px 24px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: '4px' }}>
            {steps.map((_, i) => (
              <div key={i} style={{ flex: 1, height: '3px', borderRadius: '2px', backgroundColor: i <= venueOnboardingStep ? '#f0ead8' : 'rgba(148,163,184,0.15)', transition: 'background-color 0.3s' }} />
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            {venueOnboardingStep > 0 ? (
              <button className="hit44" onClick={() => setVenueOnboardingStep(s => s - 1)} style={{ background: 'none', border: 'none', color: 'rgba(148,163,184,0.6)', fontSize: 'var(--t-label)', cursor: 'pointer', padding: '8px 0', fontWeight: '500' }}>Back</button>
            ) : (
              /* THE EXIT (2026-08-27). A consumer who tapped "Run a venue?
                 Log in here" out of curiosity was trapped: step 0's only
                 control was Let's Go, advancing requires claiming a real
                 Google Places business, and the true escapes were
                 force-quitting the app or crashing the screen. This walks
                 them back to the consumer app they came from; a real owner
                 just doesn't tap it. */
              <button className="hit44" onClick={() => { setShowVenueOnboarding(false); setUserMode('user'); try { localStorage.setItem('flockUserMode', 'user'); } catch { /* mode still flips for this session */ } setCurrentTab('home'); setCurrentScreen('main'); }} style={{ background: 'none', border: 'none', color: 'rgba(148,163,184,0.6)', fontSize: 'var(--t-label)', cursor: 'pointer', padding: '8px 0', fontWeight: '500' }}>Not a venue? Back to Flock</button>
            )}
            {/* Visible skip on every optional step. The owner can fill any of
                these in later from Settings, and saying so here is what stops
                the longer form reading as a wall. */}
            {skippableSteps.has(venueOnboardingStep) && venueOnboardingStep < steps.length - 1 && (
              <button className="hit44" onClick={() => setVenueOnboardingStep(s => s + 1)} style={{ background: 'none', border: 'none', color: 'rgba(148,163,184,0.6)', fontSize: 'var(--t-label)', cursor: 'pointer', padding: '8px 0', fontWeight: '500' }}>Skip</button>
            )}
          </div>
        </div>

        {/* Step content */}
        {steps[venueOnboardingStep]()}

        {/* Next button. The 24px bottom is a design gap ABOVE the home
            indicator, not a substitute for the inset: onboarding renders no
            BottomNav either, so this footer is the last row in a 100dvh
            container and a flat 24px leaves the lower third of the primary
            CTA inside the strip iOS reserves for the swipe-up gesture. Adding
            var(--safe-bottom) keeps the same visual gap on every device and
            collapses to the original 24px on the web (SAFE-AREA CONTRACT,
            index.css). */}
        <div style={{ padding: '16px 24px calc(24px + var(--safe-bottom))', flexShrink: 0 }}>
          {venueOnboardingError && (
            <p role="alert" style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: '#fca5a5', margin: '0 0 10px', lineHeight: 1.5 }}>{venueOnboardingError}</p>
          )}
          <button className="hit44" onClick={handleNext} disabled={!canAdvance()} style={{
            width: '100%', padding: '14px', borderRadius: '14px', border: 'none',
            background: canAdvance() ? 'linear-gradient(135deg, #f0ead8 0%, #d4c9a8 100%)' : 'rgba(148,163,184,0.1)',
            color: canAdvance() ? '#1a2744' : 'rgba(148,163,184,0.3)',
            fontSize: 'var(--t-body)', fontWeight: '600', cursor: canAdvance() ? 'pointer' : 'not-allowed',
            boxShadow: canAdvance() ? '0 4px 16px rgba(240,234,216,0.15)' : 'none',
            transition: 'all 0.2s', letterSpacing: '0.3px',
          }}>
            {venueOnboardingStep === steps.length - 1 ? 'Launch Dashboard' : venueOnboardingStep === 0 ? "Let's Go" : 'Continue'}
          </button>
        </div>
      </div>
    );
}
