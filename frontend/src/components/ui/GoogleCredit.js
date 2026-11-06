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
 * sheet, whose header photo is credited. So do a venue card in a flock chat or
 * a DM, the pinned venue over either, and the picked venue on the Create
 * screen. Where a thumbnail cannot reach a sheet it draws no Google photo: a
 * chat card with no place_id shows the placeholder instead.
 *
 * Two thumbnails reach the larger version another way:
 *   - a row whose own tap votes or shares (the vote panels and the
 *     share-a-venue lists in both chat screens) gives its photo a button of
 *     its own, ThumbToSheet below, which opens the sheet;
 *   - the chat list's 46px plan tile opens the chat, and from there the route
 *     is the chat, then "Open the plan" (the chat header), then the plan
 *     screen's header photo (screens/FlockDetail.js), which is credited.
 *
 * A PLACES PHOTO WITH NO CREDIT IN HAND IS NOT DRAWN LARGE. The plan row keeps
 * its photo's URL and not who took it, so the plan header asks the server when
 * the plan opens (lib/planPhotoCredit.js) and draws the block the venue is on
 * until the answer names the photographer. The venue sheet does the same with
 * a seed photo that came without its credit, until Place Details answers.
 */
import React from 'react';
import Icons from './Icons';
import { onVenuePhotoError } from '../../lib/venuePhoto';

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

// A photo the app's Places photo proxy serves, which is Google's, as against
// an event listing's own image, which is not and needs no Google credit.
export function isPlacesPhotoUrl(u) {
  return typeof u === 'string' && u.includes('/api/venues/photo?');
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

// A large photo and Google's credit for it, as one piece, keyed by photo by
// the caller so each photo starts clean. A photo that fails to load becomes the
// placeholder bird, and the credit goes with it: the bird is not the
// photographer's. Fills its parent, which sets the size and position:relative.
// The venue sheet's header and the plan screen's header both draw this.
export function CreditedPhoto({ src, credit }) {
  const [failed, setFailed] = React.useState(false);
  return (
    <>
      <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} onError={(e) => { setFailed(true); onVenuePhotoError(e); }} />
      {!failed && (
        // Top left, the one corner the sheet's close button, arrows, dots and
        // name leave free.
        <PhotoCredit credit={credit} style={{ position: 'absolute', top: '12px', left: '12px', maxWidth: 'calc(100% - 70px)', zIndex: 1 }} />
      )}
    </>
  );
}

// THE PHOTO'S OWN DOOR TO THE VENUE SHEET, for a row whose tap does something
// else. A vote row votes and a share row shares, so their thumbnail never
// reached the sheet that credits it. This is a button laid over the photo, a
// sibling of the row's own button rather than a child (a button inside a button
// is not a control anybody can rely on), so the row keeps its paint and its tap
// and the photo opens the sheet. The parent is position:relative; `left`,
// `size` and `radius` are the photo's own box inside the row.
export const ThumbToSheet = ({ label, onOpen, left, size, radius }) => (
  <button
    type="button"
    className="hit44"
    aria-label={label}
    title={label}
    onClick={(e) => { e.stopPropagation(); onOpen(); }}
    style={{ position: 'absolute', left, top: '50%', transform: 'translateY(-50%)', width: size, height: size, padding: 0, margin: 0, border: 'none', borderRadius: radius, background: 'transparent', cursor: 'pointer', zIndex: 1 }}
  />
);
