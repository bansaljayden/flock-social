/**
 * "HAPPENING HERE": a venue's own upcoming events, on its card.
 *
 * The events come from GET /api/venue-dashboard/public-events/:placeId, which
 * has already decided who may see each one (a verified owner, a real date that
 * has not gone by, not taken down, not reported by this reader, the 21 rule)
 * and put them soonest first. This draws them and nothing more.
 *
 * THE BACKGROUND IS THE VENUE'S OWN PHOTO, the same proxied Places photo URL
 * the top of the card is already showing (`photos[0]`, else `photo_url`). It is
 * fetched at runtime through the server's photo proxy like every venue photo,
 * so no Places photo is ever stored in the repo, and reusing the URL the header
 * has already loaded costs no second photo request and nothing against the
 * photo spend guards. When there is no photo (Places has none, or the spend cap
 * is reached and the server sends none) or it fails to load, the card falls
 * back to the drawn art below, which is code, not an image file.
 *
 * Every event carries its own Report control, which opens the same report
 * sheet the deals above it use. The server takes a 'venue_event' report, takes
 * the event off this reader's card at once, and a moderator's hide takes it off
 * everyone's (App.js drops it from this list live).
 */
import React from 'react';
import Icons from '../ui/Icons';
import { eventWhenLine } from '../../lib/venueEvents';

// Cards before "Show all". Three fill a phone screen without burying the deals
// and reviews below them.
export const FIRST_SHOWN = 3;

// Where the bulbs hang on the two loops of wire in the drawing, worked out from
// the path below at quarter steps so they sit on it.
const BULBS = [
  [42.5, 37.9], [95, 45.5], [147.5, 40.9], [200, 24], [252.5, 40.9], [305, 45.5], [357.5, 37.9],
];

// The fallback: a string of lights over a warm glow, drawn in the app's own
// navy and amber. Decorative, so hidden from screen readers.
export const EventArt = ({ colors }) => {
  const bulb = colors.amber || '#F5B942';
  return (
    <svg
      data-testid="venue-event-art"
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 400 124"
      preserveAspectRatio="xMidYMid slice"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
    >
      <rect width="400" height="124" fill={colors.navyBg || '#0d2847'} />
      <ellipse cx="200" cy="138" rx="210" ry="62" fill={bulb} opacity="0.12" />
      <path d="M -10 18 Q 95 70 200 24 Q 305 70 410 18" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="1.4" />
      {BULBS.map(([x, y]) => (
        <g key={x}>
          <line x1={x} y1={y} x2={x} y2={y + 5} stroke="rgba(255,255,255,0.3)" strokeWidth="1.4" />
          <circle cx={x} cy={y + 9} r="9" fill={bulb} opacity="0.16" />
          <circle cx={x} cy={y + 9} r="3.4" fill={bulb} />
        </g>
      ))}
    </svg>
  );
};

const VenueEventsSection = ({ events, photoUrl, colors, onReport }) => {
  const [photoFailed, setPhotoFailed] = React.useState(false);
  const [showAll, setShowAll] = React.useState(false);
  // A different venue's photo gets its own chance to load.
  React.useEffect(() => { setPhotoFailed(false); }, [photoUrl]);

  if (!Array.isArray(events) || events.length === 0) return null;
  const shown = showAll ? events : events.slice(0, FIRST_SHOWN);
  const usePhoto = typeof photoUrl === 'string' && photoUrl !== '' && !photoFailed;

  return (
    <section aria-labelledby="venue-events-heading" style={{ marginBottom: '16px' }}>
      <h4 id="venue-events-heading" style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-primary)', margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
        {Icons.calendar(colors.steel, 14)} Happening here
      </h4>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {shown.map((e) => {
          const when = eventWhenLine(e.event_date, e.event_time);
          return (
            <li key={e.id} style={{ position: 'relative', height: '124px', borderRadius: '12px', overflow: 'hidden', backgroundColor: colors.navyBg }}>
              {usePhoto ? (
                <img
                  src={photoUrl}
                  alt=""
                  onError={() => setPhotoFailed(true)}
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              ) : (
                <EventArt colors={colors} />
              )}
              {/* A plain black scrim, darker at the foot where the words sit,
                  so white text reads on any photo. */}
              <div aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0.12) 0%, rgba(0,0,0,0.32) 45%, rgba(0,0,0,0.78) 100%)' }} />
              <button
                aria-label={`Report ${e.title}`}
                title="Report event"
                className="hit44"
                onClick={() => onReport(e)}
                style={{ position: 'absolute', top: '8px', right: '8px', width: '30px', height: '30px', borderRadius: '15px', border: 'none', backgroundColor: 'rgba(0,0,0,0.45)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                {Icons.flag('white', 13)}
              </button>
              <div style={{ position: 'absolute', left: '12px', right: '48px', bottom: '10px' }}>
                {when && <p style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: 'rgba(255,255,255,0.9)', margin: 0, textShadow: '0 1px 4px rgba(0,0,0,0.5)' }}>{when}</p>}
                <p style={{ fontSize: 'var(--t-label)', fontWeight: '700', color: 'white', margin: '2px 0 0', lineHeight: 1.25, textShadow: '0 1px 6px rgba(0,0,0,0.5)', overflowWrap: 'anywhere' }}>{e.title}</p>
              </div>
            </li>
          );
        })}
      </ul>
      {events.length > FIRST_SHOWN && (
        <button
          className="hit44 glass-btn glass-secondary"
          aria-expanded={showAll}
          onClick={() => setShowAll((v) => !v)}
          style={{ marginTop: '8px', width: '100%', padding: '8px', borderRadius: '8px', border: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}
        >
          {showAll ? 'Show fewer' : `Show all ${events.length} events`}
        </button>
      )}
    </section>
  );
};

export default VenueEventsSection;
