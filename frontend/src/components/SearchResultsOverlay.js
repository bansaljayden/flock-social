/**
 * FULL-SCREEN VENUE SEARCH RESULTS OVERLAY
 *
 * 232 lines of `App.js`, declared inline inside `FlockAppInner`'s returned
 * tree as `{showSearchResults && (() => { ... })()}`. It moved here so it can
 * be fetched on demand instead of riding the boot chunk.
 *
 * WHY THIS ONE IS LAZY
 *
 * The two doors into it are both taps: "See All Results (N)" under the search
 * dropdown and the "All N results" pill on the Discover map. `showSearchResults`
 * starts false and nothing but those two buttons sets it true, so this tree is
 * unreachable on first paint and its chunk is bytes every person who opens
 * Flock downloads and never executes. Mounted behind `React.lazy` and gated on
 * `showSearchResults` at the call site, the chunk is requested the first time
 * somebody asks to see the whole list, and resolves from the module cache on
 * every later tap.
 *
 * WHY EVERYTHING ARRIVES AS A PROP
 *
 * Same reasoning as the screens under `src/screens`. The block closed over 23
 * names in `FlockAppInner`, and a context would have to enumerate the same 23
 * into a provider value, so it buys nothing and hides the dependency surface.
 * They are parameters instead, which makes the whole dependency surface of this
 * file its parameter list plus its imports, and turns a name this component
 * reads but does not receive into a `no-undef` build failure rather than a prop
 * that is silently undefined and renders as nothing.
 *
 * The state, the setters and the search effects deliberately did NOT move. They
 * live in `FlockAppInner`, which does not unmount when this overlay closes, so
 * the typed query, the results and the chosen sort survive closing and
 * reopening it exactly as they did before.
 *
 * Six names arrive as props that are not state: `DialogBehavior`,
 * `EmptyMark`, `ListSkeleton`, `crowdColorFor`, `crowdInkFor` and
 * `ownerReportShown` are module-level definitions in `App.js` shared with
 * surfaces other than this one. Copying them here would be a second definition
 * free to drift from the first, so they stay there and come in.
 *
 * The body below is the old block verbatim, including its original indentation,
 * so it can be diffed against the deleted lines character for character.
 * Nothing was renamed, reformatted or improved on the way across.
 */
import React from 'react';
import Icons from './ui/Icons';
import { crowdLabelFor } from '../lib/crowd';
import { onVenuePhotoError } from '../lib/venuePhoto';

export default function SearchResultsOverlay({
  // Module-level helpers and components that live in App.js and are shared with
  // surfaces that are not this one, so they stay there and come in here.
  DialogBehavior,
  EmptyMark,
  ListSkeleton,
  crowdColorFor,
  crowdInkFor,
  ownerReportShown,
  // Everything else is declared in FlockAppInner and stays declared there.
  allVenues,
  budgetFilteredVenues,
  colors,
  crowdPredictions,
  handleVenueQueryChange,
  openVenueDetail,
  searchResultsInputRef,
  searchResultsSort,
  setSearchResultsSort,
  setShowSearchDropdown,
  setShowSearchResults,
  setVenueQuery,
  setVenueResults,
  userLocation,
  venueLoadError,
  venueQuery,
  SearchInputLocal,
  venueSearching,
}) {
            const calcDist = (vLoc) => {
              if (!userLocation || !vLoc) return null;
              const dLat = (vLoc.latitude - userLocation.lat) * Math.PI / 180;
              const dLng = (vLoc.longitude - userLocation.lng) * Math.PI / 180;
              const a = Math.sin(dLat/2)**2 + Math.cos(userLocation.lat*Math.PI/180)*Math.cos(vLoc.latitude*Math.PI/180)*Math.sin(dLng/2)**2;
              return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            };

            const filtered = budgetFilteredVenues;
            const sorted = [...filtered].sort((a, b) => {
              if (searchResultsSort === 'rating') return (b.stars || 0) - (a.stars || 0);
              if (searchResultsSort === 'distance') {
                const dA = calcDist(a.location);
                const dB = calcDist(b.location);
                if (dA == null && dB == null) return 0;
                if (dA == null) return 1;
                if (dB == null) return -1;
                return dA - dB;
              }
              // 'recommended' - AI interest matching (coming soon), using weighted score for now
              // No crowd score yet ranks neutral rather than as a mid-busy venue.
              const scoreA = (a.stars || 0) * 20 - (typeof a.crowd === 'number' ? a.crowd : 50) + (a.topRated ? 30 : 0);
              const scoreB = (b.stars || 0) * 20 - (typeof b.crowd === 'number' ? b.crowd : 50) + (b.topRated ? 30 : 0);
              return scoreB - scoreA;
            });

            return (
              <div style={{ position: 'absolute', inset: 0, zIndex: 100, display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg-primary)' }}>
                {/* modal={false} because this is a push over Discover rather
                    than an overlay on top of everything: the bottom tab bar
                    is still on screen beside it, so trapping Tab would take
                    a control the eye can see away from the keyboard. What it
                    buys is focus-in, Escape, and focus back where it was. */}
                <DialogBehavior modal={false} onClose={() => setShowSearchResults(false)} />
                {/* Search bar header */}
                <div style={{ backgroundColor: 'var(--bg-card-solid)', flexShrink: 0, boxShadow: '0 2px 12px rgba(0,0,0,0.06)' }}>
                  <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{ flex: 1, position: 'relative' }}>
                      {/* LOCAL STATE, COMMITTED ON A DEBOUNCE. This was a
                          controlled input whose value lived at the top of the
                          app, so every character re-rendered the whole tree AND
                          this list of venue cards underneath it. Nothing here
                          is timing-sensitive: the network search behind
                          handleVenueQueryChange is already on an 800ms debounce
                          of its own, so the only thing the 120ms commit delays
                          is the box's own echo. */}
                      <SearchInputLocal aria-label="Search venues"
                        inputRef={searchResultsInputRef}
                        type="text"
                        initialValue={venueQuery}
                        onCommit={handleVenueQueryChange}
                        placeholder="Search restaurants, bars, venues..."
                        /* NO autoFocus. Both doors into this list are "View
                           all" / "All N results" buttons: the person tapped to
                           SEE the results, and on a phone focusing this field
                           raised the keyboard over the bottom two thirds of
                           the list they had just asked for. A field they can
                           tap is a field they can still search with. */
                        style={{ width: '100%', padding: '12px 40px 12px 38px', borderRadius: '14px', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: `2px solid ${venueQuery ? colors.navy : colors.borderDefault}`, fontSize: 'var(--t-label)', outline: 'none', boxSizing: 'border-box', transition: 'opacity 0.2s ease', fontWeight: '500' }}
                        autoComplete="off"
                      />
                      <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }}>{Icons.search(venueQuery ? colors.navy : colors.textTertiary, 16)}</span>
                      {venueQuery && (
                        <button aria-label="Clear search" className="hit44" onClick={() => { setShowSearchResults(false); setVenueQuery(''); setVenueResults([]); setShowSearchDropdown(false); }} style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px' }}>{Icons.x(colors.textTertiary, 16)}</button>
                      )}
                    </div>
                  </div>

                  {/* Back to map + count + sort */}
                  <div style={{ padding: '0 12px 10px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <button className="hit44" onClick={() => setShowSearchResults(false)} style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', flexShrink: 0 }}>
                      {Icons.arrowLeft(colors.navy, 14)}
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>Map</span>
                    </button>
                    <div style={{ width: '1px', height: '16px', backgroundColor: 'var(--pill-bg)', flexShrink: 0 }} />
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-tertiary)', flexShrink: 0 }}>{sorted.length} result{sorted.length !== 1 ? 's' : ''}</span>
                    <div style={{ flex: 1 }} />
                    <div style={{ display: 'flex', gap: '4px' }}>
                      {[
                        { id: 'rating', label: 'Best Rated' },
                        { id: 'recommended', label: 'Recommended' },
                        { id: 'distance', label: 'Closest' },
                      ].map(s => (
                        <button className="hit44" key={s.id} onClick={() => setSearchResultsSort(s.id)} style={{ padding: '5px 10px', borderRadius: '8px', border: 'none', backgroundColor: searchResultsSort === s.id ? colors.navyBg : 'var(--bg-hover)', color: searchResultsSort === s.id ? 'white' : 'var(--text-secondary)', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', transition: 'background-color 0.15s ease' }}>
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Results list */}
                <div style={{ flex: 1, overflowY: 'auto', padding: '4px 12px 80px' }}>
                  {/* Skeleton cards while searching, matching the real card layout */}
                  {venueSearching && <ListSkeleton count={4} thumb={72} thumbRadius={10} label="Searching venues" />}
                  {!venueSearching && sorted.length === 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '24px 20px 40px' }}>
                      <EmptyMark name="crowd" />
                      {/* Same split as the dropdown: a search that failed must
                          not be reported as a search that found nothing. */}
                      <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--t-title)', fontWeight: '600', color: 'var(--text-primary)', margin: '12px 0 0', letterSpacing: '-0.005em' }}>{venueLoadError ? 'Search is not answering' : 'No venues found'}</h3>
                      <p style={{ fontSize: 'var(--t-body)', color: 'var(--text-secondary)', margin: '6px 0 0', maxWidth: '280px' }}>{venueLoadError || (allVenues.length > 0 && budgetFilteredVenues.length === 0 ? `All ${allVenues.length} spots here are above your group's budget, so none show. The search worked.` : 'Try a different search or location.')}</p>
                    </div>
                  ) : !venueSearching && sorted.map((venue) => {
                    const dist = calcDist(venue.location);
                    const prediction = crowdPredictions[venue.place_id];
                    const crowdScore = prediction ? prediction.score : venue.crowd;
                    const crowdColor = crowdColorFor(crowdScore) || 'var(--border-mid)';
                    const crowdInk = crowdInkFor(crowdScore, colors) || 'var(--text-secondary)';
                    const crowdLabel = prediction ? prediction.label : crowdLabelFor(crowdScore);
                    // The 12 hour sparkline that used to sit here was built from a
                    // hand-written table of hour offsets applied to the current
                    // score. The detail card for the same venue, one tap away,
                    // renders the server's real forecast, so the two disagreed
                    // about one venue inches apart in the flow. Deleted rather
                    // than reconciled: the list has no real hourly data to draw.

                    return (
                      <button className="hit44"
                        key={venue.place_id || venue.id}
                        onClick={() => {
                          setShowSearchResults(false);
                          if (window.__flockPanToVenue) window.__flockPanToVenue(venue.place_id || venue);
                          openVenueDetail(venue.place_id, { name: venue.name, formatted_address: venue.addr, place_id: venue.place_id, rating: venue.stars, price_level: venue.price ? venue.price.length : null, photo_url: venue.photo_url });
                        }}
                        style={{ width: '100%', textAlign: 'left', backgroundColor: 'var(--bg-card-solid)', borderRadius: '16px', border: `1px solid var(--border-default)`, padding: 0, marginBottom: '10px', cursor: 'pointer', overflow: 'hidden', boxShadow: '0 2px 10px rgba(0,0,0,0.04)', transition: 'opacity 0.2s' }}
                      >
                        {/* Photo + overlay info */}
                        <div style={{ position: 'relative', height: venue.photo_url ? '120px' : '0' }}>
                          {venue.photo_url && (
                            <>
                              <img src={venue.photo_url} alt="" style={{ width: '100%', height: '120px', objectFit: 'cover', display: 'block' }} onError={onVenuePhotoError} />
                              <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(transparent 40%, rgba(0,0,0,0.6) 100%)' }} />
                              {venue.topRated && (
                                <div style={{ position: 'absolute', top: '8px', left: '8px', padding: '3px 8px', borderRadius: '8px', backgroundColor: 'var(--accent-amber-bg)', display: 'flex', alignItems: 'center', gap: '3px' }}>
                                  {Icons.flame('var(--accent-amber-text)', 12)}
                                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--accent-amber-text)' }}>Top Rated</span>
                                </div>
                              )}
                              {crowdScore != null && (
                              /* THE FIGURE IS DRAWN, THE MEANING IS SPOKEN.
                                 This pill was a coloured dot and a bare number,
                                 so a screen reader met "43" with no scale and
                                 no unit attached to it: 43 of what, out of
                                 what, high or low. The chat module's CrowdDial
                                 already settled this exact question and says
                                 so in its own header, so this follows it
                                 rather than inventing a second answer.

                                 role="img" makes the pill one leaf with this
                                 name, instead of an unnamed group whose
                                 aria-label a screen reader is free to ignore,
                                 and it stops the number being announced twice.

                                 "out of 100" and not "percent", deliberately.
                                 A BestTime score is relative busyness on a
                                 0-100 ladder, not a share of capacity, and
                                 calling it a percentage would be a claim about
                                 how full the room is that nothing here can
                                 support. */
                              <div
                                role="img"
                                aria-label={ownerReportShown(prediction)
                                  ? `${prediction?.ownerReport?.noun || 'venue'} says ${crowdScore} out of 100${crowdLabelFor(crowdScore) ? `, ${crowdLabelFor(crowdScore)}` : ''}`
                                  : `Crowd level ${crowdScore} out of 100${crowdLabelFor(crowdScore) ? `, ${crowdLabelFor(crowdScore)}` : ''}`}
                                style={{ position: 'absolute', top: '8px', right: '8px', padding: '4px 8px', borderRadius: '10px', backgroundColor: `${crowdColor}18`, backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <div style={{ width: '6px', height: '6px', borderRadius: '3px', backgroundColor: crowdColor }} />
                                {/* An owner-asserted number carries its source
                                    even at list size — "{venue-type} says" is
                                    the label that keeps it honest (noun is
                                    category-derived server-side), and the
                                    detail card one tap away says the rest. */}
                                <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: crowdColor }}>{ownerReportShown(prediction) ? `${prediction?.ownerReport?.noun || 'venue'} says ${crowdScore}` : `${crowdScore}`}</span>
                              </div>
                              )}
                            </>
                          )}
                        </div>

                        {/* Content */}
                        <div style={{ padding: '12px 14px' }}>
                          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', marginBottom: '6px' }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <h3 style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{venue.name}</h3>
                              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '2px 0 0', fontWeight: '500' }}>{venue.type}{venue.price ? ` • ${venue.price}` : ''}</p>
                            </div>
                            {venue.stars && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '3px', padding: '3px 8px', borderRadius: '8px', backgroundColor: '#FEF3C7', flexShrink: 0 }}>
                                {Icons.starFilled('#F59E0B', 12)}
                                <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: '#92400E' }}>{venue.stars}</span>
                              </div>
                            )}
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
                            {dist != null && (
                              <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.steel, display: 'flex', alignItems: 'center', gap: '3px' }}>
                                {Icons.mapPin(colors.steel, 12)} {dist < 1 ? `${Math.round(dist*1000)}m` : `${dist.toFixed(1)}km`}
                              </span>
                            )}
                            {!venue.photo_url && crowdScore != null && (
                              <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: crowdInk, backgroundColor: `${crowdColor}12`, padding: '2px 8px', borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '3px' }}>
                                <div style={{ width: '5px', height: '5px', borderRadius: '3px', backgroundColor: crowdColor }} />
                                {ownerReportShown(prediction) ? `${((prediction?.ownerReport?.noun || 'venue').charAt(0).toUpperCase())}${(prediction?.ownerReport?.noun || 'venue').slice(1)} says ${crowdScore}` : `${crowdLabel} ${crowdScore}`}
                              </span>
                            )}
                            {/* Photo cards carry the bare percentage in their
                                overlay, so this names it. Photo-less cards
                                already printed "{label} {score}%" one span to
                                the left, so here this line said the same word
                                twice on one row. */}
                            {crowdLabel && (venue.photo_url || crowdScore == null) && (
                            <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, display: 'flex', alignItems: 'center', gap: '3px' }}>
                              {/* ESTIMATE FRAMING ON THE BROWSE SURFACE. The venue
                                  DETAIL sheet carries a LIVE/ESTIMATED chip and a
                                  four-way attribution line naming where the number
                                  came from; the list card printed a bare label. An
                                  app was rejected by App Review for showing model
                                  output it could not source, and a crowd forecast
                                  is exactly that shape. Owner-reported readings are
                                  already labelled as the venue's own word, so only
                                  the model's own guess needs the qualifier. */}
                              {Icons.clock(colors.navy, 12)} {ownerReportShown(prediction) ? crowdLabel : `${crowdLabel} (est.)`}
                            </span>
                            )}
                          </div>

                          {venue.addr && (
                            <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '0 0 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{venue.addr}</p>
                          )}

                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
}
