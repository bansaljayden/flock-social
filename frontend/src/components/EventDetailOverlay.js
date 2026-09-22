/**
 * THE EVENT DETAIL OVERLAY.
 *
 * The full-bleed screen a tap on "Details" on an event card opens: hero image,
 * on-sale badge, date and time, price range, venue block, seat map, the About
 * and "Please note" copy from the listing, the retry line when the rest of the
 * event did not load, the distance line, and the bottom bar that starts a flock
 * at the event or opens the ticket page.
 *
 * WHY IT MOVED, 2026-09-12
 *
 * App.js is 21,920 lines and contributes 85% of the raw bytes in the boot
 * chunk. Everything in it is paid for on first paint whether or not it is ever
 * drawn. This overlay is never drawn on first paint: `eventDetail` starts null
 * and the only thing that sets it is the Details button on an event card, which
 * is two taps in from the Nest. So these 132 lines were boot weight for a
 * screen most sessions never open, which makes it a clean candidate to move off
 * the boot chunk and fetch on the tap that needs it.
 *
 * WHY EVERYTHING ARRIVES AS A PROP
 *
 * The block was declared inside `FlockAppInner` and read nineteen free names.
 * Three are platform globals (Boolean, Date, Number). Two are module imports
 * App.js already pulls in, so this file imports them from the source rather
 * than taking them as props: `Icons` from './ui/Icons' and
 * `getEventDetails` from '../services/api'. Five are module-level helpers and
 * constants that App.js declares at its own top level and shares with screens
 * other than this one, so they stay declared there and arrive here:
 * `DialogBehavior`, `colors`, `fmtMoney`, `httpUrl`, `openExternal`. That is
 * the same route AddFriends, VerifyEmailSheet and FlockDetail take for
 * `DialogBehavior`. The remaining nine are FlockAppInner's own state and
 * setters. All fourteen are parameters below, built at the call site with
 * object shorthand so the name there and the parameter here cannot drift apart,
 * and none of them carries a default value: a default turns "this prop went
 * missing" into a plausible looking wrong value, which is worse than a crash.
 * The list came from a Babel scope walk of the block, not from reading it.
 *
 * WHY THE `eventDetail &&` GUARD STAYED BEHIND
 *
 * VerifyEmailSheet keeps its own `verifyPrompt &&` guard and is mounted
 * unconditionally, because it is a static import and there is nothing to
 * defer. This one is fetched. A component mounted unconditionally is a chunk
 * requested on first paint, which is the entire cost this move exists to
 * remove, so the guard sits in App.js and this component is only ever mounted
 * with a real event in hand. It does not re-check.
 *
 * The body below is the old block verbatim, including its original
 * indentation, so it can be diffed against the deleted lines character for
 * character. No hooks were called inside it, then or now.
 */
import React from 'react';
import Icons from './ui/Icons';
import { getEventDetails } from '../services/api';

export default function EventDetailOverlay({
  // Module-level helpers, constants and components that live in App.js and are
  // shared with screens other than this one, so they stay declared there and
  // arrive here.
  DialogBehavior,
  colors,
  fmtMoney,
  httpUrl,
  openExternal,
  // Everything else is declared in FlockAppInner and stays declared there.
  eventDetail,
  eventDetailError,
  eventDetailLoading,
  setCurrentScreen,
  setEventDetail,
  setEventDetailError,
  setEventDetailLoading,
  setSelectedVenueForCreate,
  setShowEventsView,
}) {
  return (
        <div style={{ position: 'fixed', inset: 0, zIndex: 200, backgroundColor: 'var(--bg-primary)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* An opaque full-bleed overlay with the whole app still tabbable
              behind it. Focus-in, Escape and focus-return, same as every
              other sheet. */}
          <DialogBehavior onClose={() => setEventDetail(null)} label={eventDetail.name || 'Event'} />
          {/* Header image. position:fixed escapes the app shell, so this overlay
              covers the Dynamic Island and the home indicator itself and has to
              carry both insets (SAFE-AREA CONTRACT in index.css). The image grows
              by the top inset rather than shifting down, so it still bleeds into
              the status bar the way a native hero header does. */}
          <div style={{ position: 'relative', height: 'calc(220px + var(--safe-top))', flexShrink: 0, backgroundColor: colors.navyBg }}>
            {(eventDetail.photos?.[0] || eventDetail.image_url) && (
              <img src={eventDetail.photos?.[0] || eventDetail.image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={(e) => { e.target.style.display = 'none'; }} />
            )}
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(transparent 30%, rgba(0,0,0,0.8) 100%)' }} />
            <button aria-label="Back" className="hit44" onClick={() => setEventDetail(null)} style={{ position: 'absolute', top: 'calc(12px + var(--safe-top))', left: '12px', width: '36px', height: '36px', borderRadius: '18px', border: 'none', backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.arrowLeft('white', 18)}</button>
            {eventDetail.status === 'onsale' && (
              <div style={{ position: 'absolute', top: 'calc(12px + var(--safe-top))', right: '12px', padding: '5px 12px', borderRadius: '10px', backgroundColor: '#22C55E' }}>
                <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'white' }}>On Sale</span>
              </div>
            )}
            <div style={{ position: 'absolute', bottom: '14px', left: '14px', right: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                {(() => { const cc = { concert: '#4a7ba7', sports: '#22C55E', arts: '#EC4899', comedy: '#F59E0B', festival: '#EF4444', film: '#3B82F6', other: 'white' }; return (
                  <span style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: cc[eventDetail.category] || 'white', textTransform: 'uppercase', letterSpacing: '1px' }}>{eventDetail.segment || eventDetail.category}</span>
                ); })()}
                {eventDetail.genre && <span style={{ fontSize: 'var(--t-meta)', color: 'rgba(255,255,255,0.7)' }}>{eventDetail.genre}{eventDetail.subgenre && eventDetail.subgenre !== eventDetail.genre ? ` / ${eventDetail.subgenre}` : ''}</span>}
              </div>
              <h1 style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.005em', margin: 0, fontSize: 'var(--t-display)', fontWeight: '600', color: 'white', lineHeight: '1.2' }}>{eventDetail.name}</h1>
            </div>
          </div>

          {/* Loading */}
          {eventDetailLoading && (
            <div style={{ padding: '20px', textAlign: 'center' }}>
              <div style={{ display: 'inline-block', width: '20px', height: '20px', border: '3px solid var(--border-default)', borderTopColor: '#F59E0B', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            </div>
          )}

          {/* Content */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
            {/* Date & Time */}
            <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' }}>
              {eventDetail.date && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', borderRadius: '12px', backgroundColor: 'var(--bg-tertiary)', flex: 1, minWidth: '140px' }}>
                  {Icons.calendar(colors.navy, 18)}
                  <div>
                    <p style={{ margin: 0, fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>{new Date(eventDetail.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p>
                    {eventDetail.time && <p style={{ margin: '2px 0 0', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', fontWeight: '500' }}>{new Date('2000-01-01T' + eventDetail.time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}{eventDetail.time_end ? ` – ${new Date('2000-01-01T' + eventDetail.time_end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}</p>}
                  </div>
                </div>
              )}
              {eventDetail.price_range && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', borderRadius: '12px', backgroundColor: 'var(--bg-tertiary)' }}>
                  {Icons.dollar(colors.navy, 18)}
                  <div>
                    <p style={{ margin: 0, fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>${fmtMoney(eventDetail.price_range.min)}{eventDetail.price_range.max ? ` – $${fmtMoney(eventDetail.price_range.max)}` : '+'}</p>
                    <p style={{ margin: '2px 0 0', fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }}>{eventDetail.price_range.currency}</p>
                  </div>
                </div>
              )}
            </div>

            {/* Venue info */}
            {(eventDetail.venue_details || eventDetail.venue_name) && (
              <div style={{ padding: '14px', borderRadius: '14px', backgroundColor: 'var(--bg-tertiary)', marginBottom: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                  {Icons.mapPin(colors.navy, 18)}
                  <div style={{ flex: 1 }}>
                    <p style={{ margin: 0, fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy }}>{eventDetail.venue_details?.name || eventDetail.venue_name}</p>
                    <p style={{ margin: '3px 0 0', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>{eventDetail.venue_details ? [eventDetail.venue_details.address, eventDetail.venue_details.city, eventDetail.venue_details.state, eventDetail.venue_details.postal_code].filter(Boolean).join(', ') : eventDetail.venue_address}</p>
                    {eventDetail.venue_details?.upcoming_events > 0 && (
                      <p style={{ margin: '4px 0 0', fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', fontWeight: '500' }}>{eventDetail.venue_details.upcoming_events} upcoming events at this venue</p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Seatmap */}
            {eventDetail.seatmap_url && (
              <div style={{ marginBottom: '16px' }}>
                <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: '0 0 8px' }}>Seat Map</p>
                <img src={eventDetail.seatmap_url} alt="Seat map" style={{ width: '100%', borderRadius: '12px', border: '1px solid var(--border-default)' }} onError={(e) => { e.target.style.display = 'none'; }} />
              </div>
            )}

            {/* Info / Notes */}
            {eventDetail.info && (
              <div style={{ marginBottom: '16px' }}>
                <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: '0 0 6px' }}>About</p>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', lineHeight: '1.5', margin: 0 }}>{eventDetail.info}</p>
              </div>
            )}
            {eventDetail.please_note && (
              <div style={{ marginBottom: '16px', padding: '12px', borderRadius: '12px', backgroundColor: '#FEF3C7', border: '1px solid #FDE68A' }}>
                <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: '#92400E', margin: '0 0 4px' }}>Please note</p>
                <p style={{ fontSize: 'var(--t-meta)', color: '#78350F', lineHeight: '1.4', margin: 0 }}>{eventDetail.please_note}</p>
              </div>
            )}


            {eventDetailError && (
              <p role="alert" style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 12px', lineHeight: 1.5 }}>
                {eventDetailError}{' '}
                <button className="hit44" onClick={() => { if (!eventDetail?.id) return; setEventDetailLoading(true); setEventDetailError(''); getEventDetails(eventDetail.id).then(data => setEventDetail(prev => (prev ? { ...prev, ...(data?.event || {}), distance_miles: data?.event?.distance_miles ?? prev?.distance_miles ?? null } : null))).catch((err) => setEventDetailError(err?.message || 'The rest of this event did not load.')).finally(() => setEventDetailLoading(false)); }} style={{ background: 'none', border: 'none', padding: 0, color: colors.navy, fontWeight: '600', fontSize: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}>Try again</button>
              </p>
            )}
            {/* Distance */}
            {eventDetail.distance_miles != null && Number.isFinite(Number(eventDetail.distance_miles)) && (
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', fontWeight: '500', marginBottom: '16px' }}>{Icons.mapPin(colors.steel, 12)} {(Number(eventDetail.distance_miles) * 1.609).toFixed(1)} km away</p>
            )}
          </div>

          {/* Bottom action bar. Sits on the physical screen edge (fixed overlay),
              so it carries the home-indicator inset. */}
          <div style={{ padding: '12px 16px calc(12px + var(--safe-bottom))', backgroundColor: 'var(--bg-card-solid)', borderTop: '1px solid var(--border-default)', display: 'flex', gap: '10px', flexShrink: 0 }}>
            <button className="hit44" onClick={() => {
              setSelectedVenueForCreate({ name: eventDetail.venue_name || eventDetail.name, addr: eventDetail.venue_address, lat: eventDetail.location?.latitude, lng: eventDetail.location?.longitude, photo_url: eventDetail.image_url, event_name: eventDetail.name , event_date: eventDetail.date || null, event_time: eventDetail.time || null, event_datetime_utc: eventDetail.datetime_utc || null});
              setEventDetail(null);
              setShowEventsView(false);
              setCurrentScreen('create');
            }} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: 'none', background: colors.navyBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-body)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
              {Icons.users('white', 16)} Start Flock
            </button>
            {httpUrl(eventDetail.url) && (
              <button className="hit44" onClick={() => openExternal(eventDetail.url)} style={{ padding: '12px 20px', borderRadius: '12px', border: `2px solid ${colors.navy}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontWeight: '600', fontSize: 'var(--t-body)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                Tickets {Icons.arrowRight(colors.navy, 14)}
              </button>
            )}
          </div>
        </div>
  );
}
