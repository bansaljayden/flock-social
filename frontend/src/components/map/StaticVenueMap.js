// A still map of the block a venue is on, under a plan's address or in place
// of a missing venue photo. lib/staticMapUrl.js builds the URL and explains the
// rules it keeps (venues only, no proxy, the device cache and nothing else).
//
// WHAT THIS ADDS TO THE URL:
//
// - A box that never changes size. The height is fixed and the image fills it,
//   so a slow or failed load never moves the address or the buttons under it.
//   Until the picture arrives the box is the map's own land colour: no
//   spinner, because a still image filling in is not an action anyone waits on.
// - Lazy loading. A card scrolled past costs nothing, and each image is 15
//   requests out of the monthly pool.
// - The credit. The request asks MapTiler not to bake the attribution into the
//   image, so the licence's "text on or next to the image" is this line, drawn
//   at the 12px floor. It renders with the picture or not at all.
// - A tap that does what tapping a map should: it opens the maps chooser the
//   caller passes as onOpen (components/ui/MapsChooser.js).
// - Nothing on failure. A missing key, a bad coordinate, a spending cap that
//   switched the key off, or a pin icon that is not deployed yet all end the
//   same way: the caller's fallback, which is whatever the card drew before.
//
// The theme arrives as the `dark` prop. This file does not read the theme
// context, because the screens that use it are rendered on their own in tests
// with no provider, and because the colors they already hold say which theme
// is on screen (paletteIsDark below).
import React from 'react';
import { venueStaticMapUrl, STATIC_MAP_BUCKETS, STATIC_MAP_CREDIT } from '../../lib/staticMapUrl';

// The app's palette objects both name their page ground `cream`: paper in the
// light palette, navy in the dark one. A dark ground means the dark theme. Read
// by brightness rather than by comparing to a hex, so a tuned shade does not
// flip the map to the wrong theme. Anything unreadable counts as light.
export function paletteIsDark(colors) {
  const hex = colors && typeof colors.cream === 'string' ? colors.cream.trim() : '';
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
}

// The land colour of each map, so an image that has not arrived is a quiet
// patch of map ground rather than a hole.
const GROUND = { light: '#f1ede0', dark: '#0f172a' };

const CORNERS = {
  bottomright: { right: '6px', bottom: '6px' },
  topleft: { left: '6px', top: '6px' },
};

export default function StaticVenueMap({
  lat,
  lng,
  name,
  size = 'strip',
  dark = false,
  height,
  onOpen,
  fallback = null,
  creditCorner = 'bottomright',
  style,
}) {
  // The URL that failed, not a flag: a venue or theme change is a new URL and
  // deserves its own try.
  const [failedSrc, setFailedSrc] = React.useState(null);
  const src = venueStaticMapUrl({ lat, lng, size, dark });
  if (!src || failedSrc === src) return fallback;

  const bucket = STATIC_MAP_BUCKETS[size];
  const theme = dark ? 'dark' : 'light';
  const place = name || 'the venue';
  const box = {
    position: 'relative',
    display: 'block',
    width: '100%',
    height: `${height || bucket.height}px`,
    overflow: 'hidden',
    backgroundColor: GROUND[theme],
    ...style,
  };

  const content = (
    <>
      <img
        src={src}
        // Inside the button the button carries the name, so the picture is
        // not announced twice.
        alt={onOpen ? '' : `Map of the streets around ${place}`}
        width={bucket.width}
        height={bucket.height}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailedSrc(src)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
      <span
        data-map-credit="true"
        style={{
          position: 'absolute',
          ...(CORNERS[creditCorner] || CORNERS.bottomright),
          maxWidth: 'calc(100% - 12px)',
          padding: '0 5px',
          borderRadius: '4px',
          fontSize: '12px',
          lineHeight: '16px',
          fontWeight: 500,
          // Wraps rather than truncates: on a 320px phone the strip inside a
          // padded card is about 264px wide, and a credit cut to an ellipsis
          // is not a credit.
          whiteSpace: 'normal',
          pointerEvents: 'none',
          color: dark ? '#e2e8f0' : '#1e293b',
          backgroundColor: dark ? 'rgba(15,23,42,0.82)' : 'rgba(255,255,255,0.86)',
        }}
      >
        {STATIC_MAP_CREDIT}
      </span>
    </>
  );

  if (typeof onOpen === 'function') {
    return (
      <button
        type="button"
        data-static-map={size}
        aria-label={`Map of ${place}. Open it in a maps app`}
        onClick={onOpen}
        style={{ ...box, padding: 0, margin: 0, border: 'none', cursor: 'pointer', textAlign: 'left' }}
      >
        {content}
      </button>
    );
  }
  return <div data-static-map={size} style={box}>{content}</div>;
}
