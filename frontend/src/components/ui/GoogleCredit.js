/**
 * GOOGLE'S CREDITS, the two Google's Places policies require.
 *
 * GoogleMapsMark is the text attribution, "Google Maps", for any container
 * that shows Places data (a venue's name, address, rating, hours or photos)
 * anywhere but on a Google map. Every map in this app is MapLibre over
 * MapTiler, so that is every venue surface. Google's spec for the text form:
 * Roboto or the product's own sans serif, normal weight, 12 to 16 px, white,
 * #1F1F1F or #5E5E5E at 4.5:1 contrast, never wrapped, recapitalised or
 * translated.
 *
 * PhotoCredit is who took a Places photo, drawn on that photo: the author's
 * name, linked to their Google profile, and an arrow to the photo's own page
 * on Google Maps, where it can be seen in full or reported. The server sends
 * { name, uri, maps_uri } beside each photo URL (backend
 * utils/placePhotoCredit.js). A drawn picture or an owner's upload has no
 * credit, so nothing is drawn on it.
 *
 * THUMBNAILS CARRY NONE, ON PURPOSE. Google lets a gallery or a thumbnail go
 * uncredited "provided that the user is able to access a larger version of the
 * image that includes the full author attribution". A map pin, a search card,
 * an Explore row, a Birdie card and the map's venue card all open the venue
 * sheet, whose header photo is credited.
 */
import React from 'react';
import Icons from './Icons';

// Google hosts over https only. These links are Google's own, so anything else
// arriving in those fields is not a credit and is not drawn as a link.
export function googleLink(u) {
  if (typeof u !== 'string' || !u.trim()) return null;
  let url;
  try { url = new URL(u.trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const h = url.hostname.toLowerCase();
  const google = h === 'google.com' || h.endsWith('.google.com') || h === 'goo.gl' || h.endsWith('.goo.gl');
  return google ? url.toString() : null;
}

// A credit worth drawing, or null: a name, or at least the photo's page.
export function usableCredit(c) {
  if (!c || typeof c !== 'object') return null;
  const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : null;
  const mapsUri = googleLink(c.maps_uri);
  if (!name && !mapsUri) return null;
  return { name, uri: name ? googleLink(c.uri) : null, maps_uri: mapsUri };
}

// The credit for photo i of a list the server sent index-aligned with it.
export function creditAt(credits, i) {
  return Array.isArray(credits) ? usableCredit(credits[i]) : null;
}

// `dark` true or false picks white or gray outright (the venue sheet knows its
// palette); left out, the app theme's --google-maps-attribution decides
// (index.css), which is white in the dark theme and #5E5E5E in the light one.
export const GoogleMapsMark = ({ dark, style }) => (
  <span
    translate="no"
    data-testid="google-maps-attribution"
    style={{
      fontFamily: 'Roboto, var(--font-body, system-ui), sans-serif',
      fontStyle: 'normal',
      fontWeight: 400,
      fontSize: '12px',
      lineHeight: '16px',
      letterSpacing: 'normal',
      whiteSpace: 'nowrap',
      color: dark === true ? '#FFFFFF' : (dark === false ? '#5E5E5E' : 'var(--google-maps-attribution, #5E5E5E)'),
      ...style,
    }}
  >
    Google Maps
  </span>
);

// A link inside a credit must not also trigger whatever the photo sits in.
const stop = (e) => e.stopPropagation();

export const PhotoCredit = ({ credit, style }) => {
  const c = usableCredit(credit);
  if (!c) return null;
  return (
    <span
      data-testid="photo-credit"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        maxWidth: '100%',
        boxSizing: 'border-box',
        padding: '3px 8px',
        borderRadius: '999px',
        backgroundColor: 'rgba(0,0,0,0.55)',
        color: '#FFFFFF',
        fontSize: '12px',
        lineHeight: '16px',
        fontWeight: 500,
        ...style,
      }}
    >
      {c.name && (
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {'Photo: '}
          {c.uri ? (
            <a href={c.uri} target="_blank" rel="noopener noreferrer" onClick={stop} style={{ color: 'inherit', textDecoration: 'underline', textUnderlineOffset: '2px' }}>
              {c.name}
            </a>
          ) : c.name}
        </span>
      )}
      {c.maps_uri && (
        <a
          className="hit44"
          href={c.maps_uri}
          target="_blank"
          rel="noopener noreferrer"
          onClick={stop}
          aria-label="See this photo on Google Maps"
          title="See this photo on Google Maps"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', flexShrink: 0, color: 'inherit', textDecoration: 'none' }}
        >
          {!c.name && 'Photo'}
          {Icons.externalLink('#FFFFFF', 12)}
        </a>
      )}
    </span>
  );
};
