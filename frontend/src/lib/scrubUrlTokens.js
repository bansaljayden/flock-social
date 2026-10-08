// Bearer tokens ride in URLs in two places. Guest invites carry one in the
// path (/i/<token>): anyone holding it can RSVP and vote as that guest. The
// password reset email lands with one in the fragment (#token=...) or, after
// a mail scanner rewrites the link, in the query (?token=...) --
// components/auth/PasswordReset.js accepts both, and it strips the token from
// the address bar only AFTER mount, which is after the $pageview has already
// been built from window.location.href. Anyone holding a reset token can take
// the account. Both patterns are scrubbed from every analytics and error
// payload that leaves the device.
//
// SO DO COORDINATES, and that is the newer half of this function.
//
// Four first-party endpoints take the handset's live GPS fix as a query
// string: /api/weather?lat=&lon=, /api/weather/forecast?lat=&lon=, and
// /api/events/search and /api/events/featured, which are handed
// `${userLocation.lat},${userLocation.lng}` as their `location` value
// (services/api.js). Sending that to our own backend is the feature working.
// The leak is what happens NEXT: Sentry records the URL of every fetch as a
// breadcrumb, as event.request.url, as a transaction name and as a span
// description, and PostHog copies whatever URL strings it finds into event
// properties. None of those are our servers. analyticsPrivacy.test.js already
// forbids a tracked property KEY that could carry coordinates; nothing stopped
// the same coordinates arriving inside a URL, attached to the account id that
// api.js identifies with. The youngest permitted user is 13.
//
// Only a value that IS a coordinate is touched. `?location=Bethlehem` is a
// place name a person typed and stays readable; `?location=40.6,-75.4` is a
// person's position and does not. A parameter has to be the whole name after
// ? # or & to match, so `?flat=`, `?tokens=` and `?relocation=` are untouched.
//
// AND THE STATIC MAP PREVIEWS, which carry both at once. lib/staticMapUrl.js
// puts a venue's coordinates in the URL PATH (/static/<lng>,<lat>,<zoom>/) and
// again in the markers= value, and the MapTiler key in key=. Sentry's resource
// spans record image URLs, so all three would ride out with the account id.
// The previews are venues only, but this sweep does not get to know that: the
// path rule takes any /static/ segment made of two to four numbers, and
// markers= goes whole. key= is redacted on every host, which also covers the
// live map's style and tile requests, the other place the same key rides in a
// URL. The key is public in the bundle and guarded by its origin rules, but a
// bug report or a pasted breadcrumb is not where it should be read from.
// `/static/js/main.js` and `/static/auto/` have no numbers and are untouched.
//
// It lives here rather than in index.js so the crash report
// (services/crashReport.js, reached from components/ErrorBoundary.js) can use
// the same rules without importing the entry module that imports it. index.js
// re-exports it, which is where src/__tests__/analyticsPrivacy.test.js reads it.
const COORD = '-?\\d{1,3}(?:\\.\\d+)?';
export const scrubUrlTokens = (v) =>
  (typeof v === 'string'
    ? v
      .replace(/\/i\/[A-Za-z0-9_-]+/g, '/i/:token')
      .replace(/([?#&]token=)[^&#\s"']*/gi, '$1redacted')
      .replace(/([?#&](?:lat|lon|lng|latitude|longitude)=)[^&#\s"']*/gi, '$1redacted')
      .replace(
        new RegExp(`([?#&]location=)${COORD}(?:,|%2C)${COORD}`, 'gi'),
        '$1redacted',
      )
      .replace(new RegExp(`(/static/)${COORD}(?:(?:,|%2C)${COORD}){1,3}(?=/)`, 'gi'), '$1redacted')
      .replace(/([?#&]markers=)[^&#\s"']*/gi, '$1redacted')
      .replace(/([?#&]key=)[^&#\s"']*/gi, '$1redacted')
    : v);
