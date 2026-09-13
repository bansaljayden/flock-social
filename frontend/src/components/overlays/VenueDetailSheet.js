/**
 * THE VENUE DETAIL SHEET.
 *
 * Moved out of `FlockAppInner` in App.js, where it was inline JSX inside a
 * 16,300 line component and therefore rode the blocking boot chunk that every
 * account downloads before the Nest paints. App.js is 515,117 of the 605,663
 * raw bytes in that chunk; this sheet is 38,471 of them, about 33,300 once the
 * comments are stripped, which makes it the largest single overlay on that
 * path. Nobody sees it until they tap a venue, a map pin, a venue card in a
 * chat or a venue deep link, so it has no business being fetched on the way to
 * first paint. It is its own chunk now, pulled the first time
 * `venueDetailModal` turns truthy.
 *
 * Everything it reads arrives as a prop, which is what AttendanceModal,
 * NewDmModal and the nine extracted screens already do. Four of those props
 * deserve a note.
 *
 * `colors` is a prop and MUST stay one. FlockAppInner builds its own `colors`
 * with `useMemo(() => isDark ? colorsDark : colorsLight, [isDark])`, which
 * SHADOWS the module scope `const colors = colorsLight` in App.js. Importing a
 * palette here instead would compile clean, pass every test, and silently
 * paint the light navy, steel and amber over dark mode across 52 reads.
 *
 * `DialogBehavior` and `SearchInputLocal` are props because they live at module
 * scope in App.js and are not exported. Same reason ChatDetail takes both.
 *
 * `httpUrl` is a prop for the same reason. It is the gate that decides whether
 * an external link opens at all, so it is reached rather than copied: a second
 * copy here is the shape that lets one of them be tightened and the other left
 * behind, and there is a suite pinning that gate by its source text.
 *
 * `venueDetailPlaceId` is `venueDetailModal?.place_id` in App.js and could be
 * derived here. It is passed instead so the reviews retry button reads the same
 * value the reviews loader was keyed on, from one definition rather than two.
 *
 * THE GATE STAYS IN App.js. `{venueDetailModal && <VenueDetailSheet ... />}` is
 * what makes this lazy at all. Mounting it unconditionally and letting it
 * return null would fetch the chunk during boot and cost a request for nothing.
 * The early return below is a seatbelt for a future caller, not a licence to
 * drop that gate.
 *
 * Bound at module scope, not inside a render, so React sees one component type
 * for the life of the page and reconciles the sheet instead of remounting it.
 * A rebuilt type would throw the half-written review away on every unrelated
 * state change, which is the defect NewDmModal records in its own header: it
 * cleared a debounce timer and yanked focus mid word.
 *
 * The body below is the old block verbatim, including its original eight space
 * indentation, so the move is provable line for line against the deleted
 * source. One sentence of the footer comment changed: it named the person who
 * reported the button inversion, and a tracked comment carries the reason.
 */
import React from 'react';
import Icons from '../ui/Icons';
import { BirdNote, WARM_BIRD } from '../ui/BirdieBird';
import { onVenuePhotoError } from '../../lib/venuePhoto';
import { submitVenueReview, getPublicReviews } from '../../services/api';

const VenueDetailSheet = ({
  // Module scope helpers and components that live in App.js and are not
  // exported, so they stay declared there and arrive here.
  DialogBehavior,
  SearchInputLocal,
  httpUrl,
  // The theme aware palette. See the note above: never import this.
  colors,
  // The sheet and its own view state.
  venueDetailModal,
  setVenueDetailModal,
  venueDetailPhotoIdx,
  setVenueDetailPhotoIdx,
  venueDetailPlaceId,
  venueDetailPromos,
  venueDetailReviews,
  setVenueDetailReviews,
  venueDetailReviewTotal,
  setVenueDetailReviewTotal,
  venueDetailReviewsError,
  loadVenueDetailReviews,
  // Where the card came from, and the stack it can walk back up.
  venueDetailReturnTo,
  setVenueDetailReturnTo,
  setVenueDetailHistory,
  // The review form.
  showReviewForm,
  setShowReviewForm,
  reviewRating,
  setReviewRating,
  reviewText,
  setReviewText,
  reviewSubmitting,
  setReviewSubmitting,
  // Which pick the card is serving, which is what the primary button does.
  pickingVenueForDm,
  setPickingVenueForDm,
  pickingVenueForFlockId,
  setPickingVenueForFlockId,
  setPickingVenueForCreate,
  setSelectedVenueForCreate,
  // Navigation out of the sheet.
  selectedDmId,
  setSelectedDmId,
  setSelectedFlockId,
  setCurrentTab,
  setCurrentScreen,
  // `flocks` gates the review form at render time. The footer tap reads
  // `flocksRef` and `meRef` instead, because that handler has to see the
  // current flock list and the current account rather than the ones that
  // existed when the sheet opened.
  flocks,
  flocksRef,
  meRef,
  // Carried onto the plan the footer creates.
  crowdData,
  // Shared behaviour.
  confirmClick,
  showToast,
  setModerationTarget,
  pinDmVenueNow,
  updateFlockVenue,
  updateFlockVotes,
  shareVenueToChat,
}) => {
  // The gate lives in App.js; this only stops a future caller crashing on
  // venueDetailModal.name before the sheet has anything to draw.
  if (!venueDetailModal) return null;
        const closeVenueDetail = () => { setVenueDetailModal(null); };
        const returnToChat = () => {
          setVenueDetailModal(null);
          setVenueDetailHistory([]);
          const ret = venueDetailReturnTo;
          if (ret) {
            setVenueDetailReturnTo(null);
            setCurrentTab(ret.tab);
            setCurrentScreen(ret.screen);
            if (ret.flockId) setSelectedFlockId(ret.flockId);
            if (ret.dmId) setSelectedDmId(ret.dmId);
          }
        };
        // THE FOOTER'S FILL BELONGS TO WHATEVER THE ROW ACTUALLY DOES.
        // The bottom row is [Get Directions][primary], and the primary's label
        // is a four-way ternary: "Pin to DM", "Back to Chat", "Suggest to
        // flock", "Add to Flock". Three of those four are things that happen to
        // the world, so the fill is theirs and the row was always right. The
        // fourth is not an action at all. It appears when you reached this card
        // by tapping a venue in a chat, and all it does is put you back in that
        // chat, which is the one thing in the row nobody needs help finding.
        // The map sheet had the identical inversion and was corrected there
        // first, so this is the same fix applied before the same row has to be
        // reported twice: when the primary slot is only carrying a way out,
        // Get Directions takes the fill and the way out takes the outline that
        // Get Directions was already wearing. Both treatments are the ones this
        // footer already ships, so the row swaps paint and not geometry.
        //
        // The directions link is conditional, and that is the whole reason for
        // the second flag. The card opens on a seed object while Places is
        // still answering, and one caller (a push deep link) has no seed at
        // all, so there is a real moment with no google_maps_url and no
        // place_id and therefore no left-hand button. Demoting the primary in
        // that moment would leave a row of one outlined control and nothing
        // filled anywhere. A lone button is not competing with anything, so it
        // keeps the fill. The rule is that the loudest control is the most
        // consequential one present, not that back buttons are always quiet.
        //
        // One mechanical note for whoever edits the row next: the demoted state
        // has to drop the glass-primary CLASS as well as the inline colors.
        // That class sets background, border and color with !important, so
        // leaving it on paints a solid navy slab straight over every outlined
        // value in the style object and the change looks like it silently did
        // not apply. Plain glass-btn keeps the press-scale and the blur, which
        // carry no color of their own, and .hit44 keeps the 44pt target in both
        // states. The two paints also keep the same 2px border box rather than
        // swapping one side to `border: none`, so promoting or demoting never
        // moves the row by four pixels.
        const footerReturnsToChat = !pickingVenueForDm && !!venueDetailReturnTo;
        const footerHasDirections = !!(httpUrl(venueDetailModal.google_maps_url) || venueDetailModal.place_id);
        const directionsIsPrimary = footerReturnsToChat && footerHasDirections;
        return (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.85)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={(e) => { if (e.target === e.currentTarget) closeVenueDetail(); }}
        >
          {/* The busiest overlay in the product had no dialog behaviour at
              all: focus stayed on whatever opened it, Escape did nothing,
              and Tab walked straight out of the card into the Discover map
              underneath while the card covered the screen. */}
          <DialogBehavior onClose={closeVenueDetail} label={venueDetailModal.name || 'Venue'} />
          <div style={{ width: '100%', maxWidth: '420px', maxHeight: '92vh', backgroundColor: 'var(--bg-primary)', borderRadius: '20px', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
            {/* Photo area */}
            <div style={{ position: 'relative', height: '220px', flexShrink: 0, overflow: 'hidden' }}>
              {venueDetailModal.photos && venueDetailModal.photos.length > 0 ? (
                <>
                  <img src={venueDetailModal.photos[venueDetailPhotoIdx] || venueDetailModal.photos[0]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} onError={onVenuePhotoError} />
                  {venueDetailModal.photos.length > 1 && (
                    <>
                      <button aria-label="Previous" className="hit44" onClick={(e) => { e.stopPropagation(); setVenueDetailPhotoIdx(i => i > 0 ? i - 1 : venueDetailModal.photos.length - 1); }} style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', width: '32px', height: '32px', borderRadius: '16px', backgroundColor: 'rgba(0,0,0,0.5)', border: 'none', color: 'white', cursor: 'pointer', fontSize: 'var(--t-body)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>‹</button>
                      <button aria-label="Next" className="hit44" onClick={(e) => { e.stopPropagation(); setVenueDetailPhotoIdx(i => i < venueDetailModal.photos.length - 1 ? i + 1 : 0); }} style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', width: '32px', height: '32px', borderRadius: '16px', backgroundColor: 'rgba(0,0,0,0.5)', border: 'none', color: 'white', cursor: 'pointer', fontSize: 'var(--t-body)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>›</button>
                      <div style={{ position: 'absolute', bottom: '10px', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '5px' }}>
                        {venueDetailModal.photos.map((_, i) => (
                          <div key={i} style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: i === venueDetailPhotoIdx ? 'white' : 'rgba(255,255,255,0.4)', transition: 'background-color 0.2s' }} />
                        ))}
                      </div>
                    </>
                  )}
                </>
              ) : venueDetailModal.photo_url ? (
                <img src={venueDetailModal.photo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} onError={onVenuePhotoError} />
              ) : (
                <div style={{ width: '100%', height: '100%', background: colors.navyBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.mapPin('rgba(255,255,255,0.3)', 48)}</div>
              )}
              {/* Overlay gradient */}
              <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '80px', background: 'linear-gradient(transparent, rgba(0,0,0,0.7))' }} />
              {/* Close button */}
              <button aria-label="Close" className="hit44" onClick={closeVenueDetail} style={{ position: 'absolute', top: '12px', right: '12px', width: '34px', height: '34px', borderRadius: '17px', backgroundColor: 'rgba(0,0,0,0.5)', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(10px)' }}>{Icons.x('white', 18)}</button>
              {/* Name overlay */}
              <div style={{ position: 'absolute', bottom: '12px', left: '14px', right: '14px' }}>
                <h2 style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.005em', color: 'white', fontSize: 'var(--t-title)', fontWeight: '600', margin: 0, textShadow: '0 2px 8px rgba(0,0,0,0.5)' }}>{venueDetailModal.name}</h2>
                {venueDetailModal.formatted_address && <p style={{ color: 'rgba(255,255,255,0.85)', fontSize: 'var(--t-meta)', margin: '3px 0 0', textShadow: '0 1px 4px rgba(0,0,0,0.5)' }}>{venueDetailModal.formatted_address}</p>}
              </div>
            </div>

            {/* Content */}
            {/* THE ONE SCROLLING REGION, and it has to contain everything
                between the photo and the buttons.

                Only the details block used to scroll. Promotions and reviews
                were written as SIBLINGS of it, so the sheet's column was
                photo + scroller + promotions + reviews + footer, and the two
                new blocks carried their own height with nothing to give: a
                venue with a promotion and three reviews measured 810px of
                children inside a 776px sheet, and the sheet clips what does
                not fit. What did not fit was the footer, which is where Get
                Directions and Add to Flock live. At 390 wide the buttons were
                cut in half; at 320 the whole row was 321px past the bottom
                edge, so the sheet's primary action could not be reached at
                all on a small phone.

                minHeight: 0 is load-bearing. A column flex item will not
                shrink below its content without it, so the region would hold
                its full height and push the footer straight back out. */}
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <div style={{ padding: '16px' }}>
              {venueDetailModal.loading ? (
                <div style={{ textAlign: 'center', padding: '30px 0' }}>
                  <div style={{ display: 'inline-block', width: '24px', height: '24px', border: `3px solid ${colors.creamDark}`, borderTopColor: colors.navy, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '10px 0 0' }}>Loading details...</p>
                </div>
              ) : (
                <>
                  {/* Stats row */}
                  <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                    {venueDetailModal.rating && (
                      <div style={{ flex: 1, backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '10px', textAlign: 'center', border: '1px solid var(--border-subtle)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '3px', marginBottom: '2px' }}>
                          {Icons.starFilled('#F59E0B', 16)}
                          <span style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy }}>{venueDetailModal.rating}</span>
                        </div>
                        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>{venueDetailModal.user_ratings_total ? `${venueDetailModal.user_ratings_total} reviews` : 'Rating'}</p>
                      </div>
                    )}
                    {venueDetailModal.price_level > 0 && (
                      <div style={{ flex: 1, backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '10px', textAlign: 'center', border: '1px solid var(--border-subtle)' }}>
                        <p style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 2px' }}>{'$'.repeat(venueDetailModal.price_level)}</p>
                        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>Price</p>
                      </div>
                    )}
                    {venueDetailModal.opening_hours && (
                      <div style={{ flex: 1, backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '10px', textAlign: 'center', border: '1px solid var(--border-subtle)' }}>
                        <div style={{ marginBottom: '2px' }}>{Icons.clock(venueDetailModal.opening_hours.openNow ? colors.steel : colors.red, 18)}</div>
                        <p style={{ fontSize: 'var(--t-meta)', color: venueDetailModal.opening_hours.openNow ? colors.steel : colors.red, fontWeight: '500', margin: 0 }}>{venueDetailModal.opening_hours.openNow ? 'Open Now' : 'Closed'}</p>
                      </div>
                    )}
                  </div>

                  {/* Hours */}
                  {venueDetailModal.opening_hours?.weekdayDescriptions && (
                    <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', marginBottom: '14px', border: '1px solid var(--border-subtle)' }}>
                      <h4 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.clock(colors.navy, 14)} Hours</h4>
                      {venueDetailModal.opening_hours.weekdayDescriptions.map((day, i) => {
                        const today = new Date().getDay();
                        const isToday = i === (today === 0 ? 6 : today - 1);
                        return <p key={i} style={{ fontSize: 'var(--t-meta)', color: isToday ? colors.navy : colors.textSecondary, fontWeight: isToday ? '500' : '400', margin: '3px 0', padding: isToday ? '3px 6px' : '0', backgroundColor: isToday ? `${colors.navy}10` : 'transparent', borderRadius: '6px' }}>{day}</p>;
                      })}
                    </div>
                  )}

                  {/* Contact */}
                  {(venueDetailModal.formatted_phone_number || venueDetailModal.website) && (
                    <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', marginBottom: '14px', border: '1px solid var(--border-subtle)' }}>
                      <h4 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 8px' }}>Contact</h4>
                      {venueDetailModal.formatted_phone_number && (
                        <a href={`tel:${venueDetailModal.formatted_phone_number}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '10px', textDecoration: 'none', marginBottom: venueDetailModal.website ? '6px' : 0 }}>
                          {Icons.phone(colors.navy, 16)}
                          <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>{venueDetailModal.formatted_phone_number}</span>
                        </a>
                      )}
                      {httpUrl(venueDetailModal.website) && (
                        <a href={httpUrl(venueDetailModal.website)} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '10px', textDecoration: 'none' }}>
                          {Icons.externalLink(colors.navy, 16)}
                          <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Website</span>
                        </a>
                      )}
                    </div>
                  )}

                  {/* View Menu */}
                  {!venueDetailModal.loading && (
                    <a href={httpUrl(venueDetailModal.menu_url) || `https://www.google.com/search?q=${encodeURIComponent((venueDetailModal.name || '') + ' ' + (venueDetailModal.formatted_address || '') + ' menu')}`} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', border: '1px solid var(--border-subtle)', textDecoration: 'none', marginBottom: '14px', transition: 'background-color 0.15s' }}>
                      <svg aria-hidden="true" focusable="false" width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={colors.navy} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="20" y2="6"></line><line x1="4" y1="10" x2="20" y2="10"></line><line x1="4" y1="14" x2="16" y2="14"></line><line x1="4" y1="18" x2="12" y2="18"></line></svg>
                      <div style={{ flex: 1 }}>
                        <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>View Menu</span>
                        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '1px 0 0' }}>{venueDetailModal.menu_url ? 'Official menu' : 'Search online'}</p>
                      </div>
                      {Icons.externalLink(colors.textTertiary, 14)}
                    </a>
                  )}

                  {/* Types/Tags */}
                  {venueDetailModal.types && venueDetailModal.types.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '16px' }}>
                      {venueDetailModal.types.slice(0, 6).map((t, i) => (
                        <span key={i} style={{ fontSize: 'var(--t-meta)', padding: '4px 10px', borderRadius: '20px', backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontWeight: '500', border: '1px solid var(--border-subtle)' }}>{t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</span>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Active Promotions */}
            {venueDetailPromos.length > 0 && (
              <div style={{ padding: '0 16px 12px' }}>
                <h4 style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-primary)', margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.gift(colors.steel, 14)} Deals & Promotions</h4>
                {venueDetailPromos.map(p => (
                  <div key={p.id} style={{ padding: '10px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '10px', marginBottom: '6px', border: `1px solid ${colors.steel}33` }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
                      <p style={{ flex: 1, minWidth: 0, fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-primary)', margin: 0 }}>{p.title}</p>
                      {/* A promotion is owner-typed UGC served to every user who
                          opens this card, it is a reportable content type the
                          queue can already action (routes/moderation.js
                          VALID_CONTENT_TYPES, routes/admin.js TAKEDOWN_TARGETS),
                          and ModerationSheet has carried the noun for it all
                          along. The only missing piece was the control, so the
                          one public surface that shows a promotion had no way
                          to report one. No userId: /public-promotions does not
                          serve the owner's id and does not need to, because the
                          report route reads venue_user_id off the row itself.
                          The sheet then offers report without block, exactly as
                          it already does for a guest RSVP. */}
                      <button aria-label="Report promotion" className="hit44" onClick={() => setModerationTarget({ userName: 'this venue', contentType: 'venue_promotion', contentId: p.id })} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', flexShrink: 0, fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }} title="Report promotion">{Icons.flag('currentColor', 13)}</button>
                    </div>
                    {p.description && <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0' }}>{p.description}</p>}
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '2px 0 0' }}>{p.time_slot}{p.days ? ` · ${p.days}` : ''}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Flock Reviews */}
            <div style={{ padding: '0 16px 12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h4 style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-primary)', margin: 0 }}>{Icons.star(colors.amber, 14)} Flock Reviews{venueDetailReviews ? ` (${venueDetailReviewTotal ?? venueDetailReviews.length})` : ''}</h4>
                {!showReviewForm && (
                  <button className="hit44 glass-btn glass-secondary" onClick={() => { setShowReviewForm(true); setReviewRating(0); setReviewText(''); }} style={{ padding: '4px 10px', borderRadius: '6px', border: `1px solid ${colors.navy}`, backgroundColor: 'transparent', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>
                    Write Review
                  </button>
                )}
              </div>
              {/* The server refuses a review from anyone who has not been here
                  with a flock (or checked in by tag), and it used to say so only
                  AFTER the review was written. If no plan of yours at this place
                  had two people, the sentence comes first. A tag check-in this
                  client cannot see still gets through: the form stays. */}
              {showReviewForm && !flocks.some(f => String(f.venueId) === String(venueDetailModal.place_id) && (f.memberCount || 0) >= 2) && (
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 8px', lineHeight: 1.5 }}>You can review a venue after you have been there with a flock. Reviews from a flock with at least two people are the ones that count.</p>
              )}
              <div style={{ display: 'none' }}>
              </div>

              {/* Review Form */}
              {showReviewForm && (
                <div style={{ padding: '12px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '10px', marginBottom: '8px' }}>
                  <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-primary)', margin: '0 0 6px' }}>Your Rating</p>
                  <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
                    {/* Two things were wrong here, and this is the rating INPUT,
                        so both cost more than they do on a display row.
                        Unselected stars were colors.disabled (#e5e7eb) on
                        --bg-tertiary (#e8e0d5): 1.1:1, invisible, so before you
                        tapped anything there was no visible five-star scale to
                        aim at — the control looked empty. --star-empty is barely
                        better on this particular surface, so the unselected
                        state uses --text-tertiary, which is a real outline.
                        And all five buttons were labelled "Rate", so a screen
                        reader offered five identical buttons and no way to pick
                        a number. */}
                    {[1, 2, 3, 4, 5].map(s => (
                      <button aria-label={`Rate ${s} star${s === 1 ? '' : 's'}`} aria-pressed={reviewRating === s} className="hit44" key={s} onClick={() => setReviewRating(s)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px' }}>
                        {s <= reviewRating ? Icons.starFilled(colors.amber, 22) : Icons.star('var(--text-tertiary)', 22)}
                      </button>
                    ))}
                  </div>
                  <SearchInputLocal aria-label="Your review" as="textarea" initialValue={reviewText} onCommit={setReviewText} placeholder="How was your experience?" rows={3} style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border-subtle)', fontSize: 'var(--t-meta)', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-primary)', resize: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }} />
                  <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                    <button className="hit44 glass-btn glass-primary" disabled={!reviewRating || reviewSubmitting} onClick={async () => {
                      setReviewSubmitting(true);
                      try {
                        await submitVenueReview(venueDetailModal.place_id, reviewRating, reviewText);
                        const updated = await getPublicReviews(venueDetailModal.place_id);
                        setVenueDetailReviews(updated.reviews || []);
                        setVenueDetailReviewTotal(Number.isFinite(updated.total) ? updated.total : null);
                        setShowReviewForm(false);
                      } catch (e) {
                        // The server refuses this for reasons the reviewer can
                        // act on — no verified visit to this venue, one review
                        // per person, the text failed the profanity screen —
                        // and every one of them used to be a console line. The
                        // button spun, said "Submitting...", and then sat back
                        // down with the review still in the box and no reason.
                        showToast(e?.message || "That review didn't post. Try again.", 'error');
                      }
                      setReviewSubmitting(false);
                    }} style={{ flex: 1, padding: '8px', borderRadius: '8px', border: 'none', backgroundColor: reviewRating ? colors.navy : colors.disabled, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: reviewRating ? 'pointer' : 'not-allowed' }}>
                      {reviewSubmitting ? 'Submitting...' : 'Submit Review'}
                    </button>
                    <button className="hit44 glass-btn glass-secondary" onClick={() => setShowReviewForm(false)} style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-secondary)', fontSize: 'var(--t-meta)', cursor: 'pointer' }}>Cancel</button>
                  </div>
                </div>
              )}

              {/* Review List */}
              {venueDetailReviews && venueDetailReviews.length > 0 ? venueDetailReviews.slice(0, 5).map(r => (
                <div key={r.id} style={{ padding: '10px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '8px', marginBottom: '6px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <div style={{ width: '24px', height: '24px', borderRadius: '12px', backgroundColor: colors.navyBg, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: 'var(--t-meta)', fontWeight: '500' }}>
                        {(r.name || '?').charAt(0).toUpperCase()}
                      </div>
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-primary)' }}>{r.name || 'Anonymous'}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {/* Same invisible-empty-star defect as the venue
                          dashboard's own review list: colors.disabled is
                          #e5e7eb, 1.2:1 on this card, so a 2-star review read
                          as a 2-star scale. --star-empty, 12px floor, and one
                          label for the row rather than five silent glyphs. */}
                      <div role="img" aria-label={`${r.rating} out of 5 stars`} style={{ display: 'flex', gap: '1px' }}>
                        {[1, 2, 3, 4, 5].map(s => <React.Fragment key={s}>{s <= r.rating ? Icons.starFilled(colors.amber, 12) : Icons.star('var(--star-empty)', 12)}</React.Fragment>)}
                      </div>
                      <button aria-label="Report review" className="hit44" onClick={() => setModerationTarget({ userId: r.user_id, userName: r.name || 'this reviewer', contentType: 'venue_review', contentId: r.id })} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }} title="Report review">{Icons.flag('currentColor', 13)}</button>
                    </div>
                  </div>
                  {r.text && <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '4px 0 0', lineHeight: '1.4' }}>{r.text}</p>}
                  {/* Owner reply. No 2px side stripe — banned pattern
                      (project documentation, DESIGN-STANDARD.md). The reply is set apart
                      by its own surface and an indent instead. */}
                  {r.venue_reply && (
                    <div style={{ marginTop: '6px', marginLeft: '10px', padding: '8px 10px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
                      <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.steel, margin: '0 0 1px' }}>Owner Reply</p>
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>{r.venue_reply}</p>
                    </div>
                  )}
                </div>
              )) : venueDetailReviewsError ? (
                /* A read that failed, never an empty venue. "Be the first!" is
                   a claim about everyone who has been here, and it is not this
                   card's to make when the request did not come back. */
                <BirdNote
                  layout="row"
                  size={48}
                  role="alert"
                  body={venueDetailReviewsError}
                  style={{ padding: '8px 4px' }}
                  action={<button className="hit44 glass-btn glass-secondary" onClick={() => loadVenueDetailReviews(venueDetailPlaceId)} style={{ padding: '6px 12px', borderRadius: '8px', border: `1px solid ${colors.navy}`, backgroundColor: 'transparent', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>Try again</button>}
                />
              ) : !venueDetailReviews ? (
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', textAlign: 'center', padding: '12px' }}>Loading reviews...</p>
              ) : !showReviewForm && (
                <BirdNote layout="row" bird={WARM_BIRD} size={48} body="No reviews yet. Be the first!" style={{ padding: '8px 4px' }} />
              )}
            </div>
            {/* end of the scrolling region opened above the details block */}
            </div>

            {/* Bottom action buttons */}
            <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-card-solid)', flexShrink: 0, display: 'flex', gap: '8px' }}>
              {httpUrl(venueDetailModal.google_maps_url) ? (
                <a href={httpUrl(venueDetailModal.google_maps_url)} target="_blank" rel="noopener noreferrer" style={{ flex: 1, padding: '12px', borderRadius: '12px', border: `2px solid ${directionsIsPrimary ? colors.navyBg : colors.navy}`, backgroundColor: directionsIsPrimary ? colors.navyBg : 'var(--bg-card-solid)', color: directionsIsPrimary ? 'white' : colors.navy, fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', textDecoration: 'none', boxShadow: directionsIsPrimary ? '0 4px 12px rgba(13,40,71,0.10)' : 'none' }}>
                  {Icons.mapPin(directionsIsPrimary ? 'white' : colors.navy, 16)} Get Directions
                </a>
              ) : venueDetailModal.place_id ? (
                <a href={`https://www.google.com/maps/place/?q=place_id:${venueDetailModal.place_id}`} target="_blank" rel="noopener noreferrer" style={{ flex: 1, padding: '12px', borderRadius: '12px', border: `2px solid ${directionsIsPrimary ? colors.navyBg : colors.navy}`, backgroundColor: directionsIsPrimary ? colors.navyBg : 'var(--bg-card-solid)', color: directionsIsPrimary ? 'white' : colors.navy, fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', textDecoration: 'none', boxShadow: directionsIsPrimary ? '0 4px 12px rgba(13,40,71,0.10)' : 'none' }}>
                  {Icons.mapPin(directionsIsPrimary ? 'white' : colors.navy, 16)} Get Directions
                </a>
              ) : null}
              <button onClick={(e) => {
                confirmClick(e);
                const photoUrl = (venueDetailModal.photos && venueDetailModal.photos[0]) || venueDetailModal.photo_url || null;
                if (pickingVenueForDm) {
                  const v = { name: venueDetailModal.name, addr: venueDetailModal.formatted_address, place_id: venueDetailModal.place_id, rating: venueDetailModal.rating, photo_url: photoUrl };
                  pinDmVenueNow(selectedDmId, v);
                  setVenueDetailModal(null);
                  setPickingVenueForCreate(false);
                  setPickingVenueForDm(false);
                  setCurrentTab('chat');
                  setCurrentScreen('dmDetail');
                } else if (pickingVenueForFlockId) {
                  // Only the creator may set the venue (the route is creator-only,
                  // and a member used to get a 403 toast and a revert). A member
                  // puts it on the table instead: a venue card in the chat, with
                  // their vote on it.
                  const picked = flocksRef.current.find(f => f.id === pickingVenueForFlockId);
                  const pickerIsCreator = !picked || String(picked.creatorId) === String(meRef.current?.id);
                  const pickedVenue = { name: venueDetailModal.name, addr: venueDetailModal.formatted_address, place_id: venueDetailModal.place_id, rating: venueDetailModal.rating, stars: venueDetailModal.rating, photo_url: photoUrl, location: venueDetailModal.geometry?.location ? { latitude: venueDetailModal.geometry.location.lat, longitude: venueDetailModal.geometry.location.lng } : undefined, type: venueDetailModal.category || null };
                  if (pickerIsCreator) {
                  updateFlockVenue(pickingVenueForFlockId, { name: venueDetailModal.name, addr: venueDetailModal.formatted_address, place_id: venueDetailModal.place_id, rating: venueDetailModal.rating, photo_url: photoUrl, lat: venueDetailModal.location?.latitude, lng: venueDetailModal.location?.longitude });
                  } else {
                    shareVenueToChat(pickingVenueForFlockId, pickedVenue);
                    const current = picked.votes || [];
                    updateFlockVotes(pickingVenueForFlockId, [
                      ...current.map(v => ({ ...v, voters: v.voters.filter(x => x !== 'You') })),
                      { venue: pickedVenue.name, type: pickedVenue.type, place_id: pickedVenue.place_id || null, voters: ['You'] },
                    ]);
                    showToast(`${pickedVenue.name} is on the table, with your vote.`);
                  }
                  setVenueDetailModal(null);
                  setPickingVenueForCreate(false);
                  setSelectedFlockId(pickingVenueForFlockId);
                  setPickingVenueForFlockId(null);
                  setCurrentTab('chat');
                  setCurrentScreen('chatDetail');
                } else if (venueDetailReturnTo) {
                  returnToChat();
                } else {
                  setSelectedVenueForCreate({ name: venueDetailModal.name, addr: venueDetailModal.formatted_address, place_id: venueDetailModal.place_id, rating: venueDetailModal.rating, stars: venueDetailModal.rating, price_level: venueDetailModal.price_level, price: venueDetailModal.price_level ? '$'.repeat(venueDetailModal.price_level) : null, photo_url: photoUrl, type: venueDetailModal.types?.[0]?.replace(/_/g, ' ')?.replace(/\b\w/g, c => c.toUpperCase()) || 'Venue', crowd: (typeof crowdData?.score === 'number' ? crowdData.score : null), crowdLabel: crowdData?.label || null, lat: venueDetailModal.location?.latitude, lng: venueDetailModal.location?.longitude });
                  setVenueDetailModal(null);
                  setCurrentScreen('create');
                }
              }} className={directionsIsPrimary ? 'hit44 glass-btn' : 'hit44 glass-btn glass-primary'} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: `2px solid ${directionsIsPrimary ? colors.navy : colors.navyBg}`, background: directionsIsPrimary ? 'var(--bg-card-solid)' : colors.navyBg, color: directionsIsPrimary ? colors.navy : 'white', fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', boxShadow: directionsIsPrimary ? 'none' : '0 4px 12px rgba(13,40,71,0.10)', position: 'relative', overflow: 'hidden' }}>
                {/* THE GLYPH FOLLOWS THE SAME TEST AS THE WORDS. It used to key on
                    venueDetailReturnTo alone while the label below checks
                    pickingVenueForDm first, so a card opened from a chat WHILE
                    picking a venue for a DM drew a back arrow next to the words
                    "Pin to DM": the icon said leave and the label said pin, on the
                    same button. Both read the branches in the same order now, so
                    they cannot disagree. */}
                {pickingVenueForDm ? Icons.pin(directionsIsPrimary ? colors.navy : 'white', 16) : venueDetailReturnTo ? Icons.arrowLeft(directionsIsPrimary ? colors.navy : 'white', 16) : Icons.plus('white', 16)} {pickingVenueForDm ? 'Pin to DM' : venueDetailReturnTo ? 'Back to Chat' : (pickingVenueForFlockId && String(flocksRef.current.find(f => f.id === pickingVenueForFlockId)?.creatorId) !== String(meRef.current?.id)) ? 'Suggest to flock' : 'Add to Flock'}
              </button>
            </div>
          </div>
        </div>
        );
};

export default VenueDetailSheet;
