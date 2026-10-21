// ---------------------------------------------------------------------------
// GOOGLE'S CREDIT FOR ONE PLACES PHOTO, in the shape the app draws it.
// ---------------------------------------------------------------------------
// Google's Places policies: "You must always credit the author when displaying
// photos or reviews", with the author's name and profile link, positioned so
// the credit is clearly tied to that photo, and "end-users must always have
// access to view the individual source photo or review on Google Maps"
// (developers.google.com/maps/documentation/places/web-service/policies).
// Until 2026-10-21 every venue photo in the app went out with neither: the
// proxy URL was all a client ever received.
//
// Every Places (New) Photo object already carries both, under the `photos`
// field the search and details masks were paying for anyway, so this costs no
// new field and no new SKU:
//   photos[i].authorAttributions[]  { displayName, uri, photoUri }
//   photos[i].googleMapsUri         the photo's own page on Google Maps
//
// What goes to the client is { name, uri, maps_uri }, any of which may be
// null, or null for the whole credit when Google sent nothing usable.
//
// SANITIZED BECAUSE A DISPLAY NAME IS ANYBODY'S TEXT. A Google account names
// itself, so the name is trimmed, stripped of control and bidi characters and
// capped. Links are https only, on a Google host, with no credentials in them.
// Google documents some of these URIs as protocol relative ("//maps.google.com
// /maps/contrib/..."), so a leading `//` becomes https and nothing else is
// repaired. The avatar (`photoUri`) is not forwarded: the app draws the name
// and the link, and an avatar would be one more Google image request per card.
// ---------------------------------------------------------------------------

const MAX_NAME_CHARS = 80;
const MAX_URL_CHARS = 2048;

// C0 and C1 controls, zero-width and bidi overrides and isolates. A name that
// carries any of them can reverse or hide the text drawn after it.
const INVISIBLE_RE = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const s = value.replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > MAX_NAME_CHARS ? `${s.slice(0, MAX_NAME_CHARS - 1).trimEnd()}…` : s;
}

function isGoogleHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'google.com' || h.endsWith('.google.com') || h === 'goo.gl' || h.endsWith('.goo.gl');
}

function googleHttpsUrl(value) {
  if (typeof value !== 'string') return null;
  let s = value.trim();
  if (!s || s.length > MAX_URL_CHARS) return null;
  if (s.startsWith('//')) s = `https:${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (!isGoogleHost(u.hostname)) return null;
  return u.toString();
}

// One Places (New) Photo object in, one credit (or null) out.
function photoCredit(photo) {
  if (!photo || typeof photo !== 'object') return null;
  const authors = Array.isArray(photo.authorAttributions) ? photo.authorAttributions : [];
  const author = authors.find((a) => a && typeof a === 'object' && cleanName(a.displayName)) || null;
  const name = author ? cleanName(author.displayName) : null;
  const uri = author ? googleHttpsUrl(author.uri) : null;
  const mapsUri = googleHttpsUrl(photo.googleMapsUri);
  if (!name && !mapsUri) return null;
  return { name, uri: name ? uri : null, maps_uri: mapsUri };
}

module.exports = { photoCredit, cleanName, googleHttpsUrl, MAX_NAME_CHARS };
