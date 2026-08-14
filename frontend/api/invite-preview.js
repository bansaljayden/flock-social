'use strict';

// ---------------------------------------------------------------------------
// /api/invite-preview - per-request share tags for guest invite links.
//
// WHY THIS EXISTS
// One index.html is served for every route (CRA has no server rendering), so
// an invite shared into iMessage or a group chat previews with the marketing
// tags: "Flock | Plans that actually happen". The link that spreads the product
// says nothing about who sent it or what it is. This function answers the
// preview bots instead, with the host's first name and the plan.
//
// It is reached ONLY through a UA-conditional rewrite in vercel.json. Humans
// still get the React app at the same URL.
//
// ---------------------------------------------------------------------------
// THE vercel.json WIRING (documented here because vercel.json is validated
// against Vercel's own schema, rejects unknown keys, and so can carry no
// comments of its own. Same arrangement as the head block in public/index.html.)
//
// Three rewrites, in this order, because the first match wins:
//
//   1. /i/:token?open=1            -> /index.html
//      The escape hatch. The anchor on the page this function renders points
//      here, so that a human who reached the preview by accident lands on the
//      real app instead of reloading the page they are already on. It must come
//      FIRST or rule 2 would swallow it for a bot-shaped user agent.
//
//   2. /i/:token  (user-agent matches the preview-bot list)
//                                  -> /api/invite-preview?token=:token
//
//   3. /(.*)                       -> /index.html
//      The SPA fallback, restated explicitly. Create React App's framework
//      preset supplies one implicitly, but that implicit route is exactly the
//      kind of thing that changes shape when a rewrites block is introduced, and
//      if it disappeared every deep route on the site (/about, /privacy, /i/,
//      /app) would 404. Declaring it costs one line and removes the dependency.
//      It cannot shadow the function or the static assets: Vercel gives "
//      precedence to the filesystem prior to rewrites being applied".
//
// Rewrites 1 and 2 use `source: "/i/:token"`, which matches exactly one path
// segment, so a bare /i and a truncated /i/ both fall through to the SPA and get
// the invite page's own "that link isn't complete" state.
//
// TWO COPIES OF THE BOT REGEX, AND WHY
// The same user-agent pattern appears in rewrite 2 (as `has`) and in the
// /i/(.*) Cache-Control header rule (as `missing`). JSON has no variables, so
// they cannot be shared. If they ever drift:
//   - a bot that matches the rewrite but not the header rule just loses CDN
//     caching, which is a performance change and nothing else;
//   - a human who matched the header rule but not the rewrite loses no-store on
//     index.html, which carries no invite data at all (the invite page fetches
//     everything client side), so the exposure is a cached copy of the same
//     shell every route already serves.
// Neither is a correctness or disclosure problem. Keep them identical anyway.
//
// The list is exact-cased on purpose: every entry is the literal string the bot
// actually sends. A bot that changes its casing stops matching and falls back to
// the generic tags, which is the same thing the site does today. Failing to the
// current behaviour is the intended failure mode for everything in this file.
// ---------------------------------------------------------------------------
//
// THE FIVE RULES THIS FILE IS HELD TO
//
// 1. NEVER return a non-200, and never throw out of the handler. A scraper
//    that gets a 500 caches the failure, and a cached failure poisons every
//    future share of that link, including the ones sent after the backend came
//    back. Every failure path below returns 200 with the generic tags, which is
//    exactly what the site serves today, so the worst case is "no worse than
//    before" rather than "broken preview forever".
//
// 2. HTML-escape every interpolated value. `flocks.name` is user-authored and
//    is NOT stripped on write on every path: backend/routes/flocks.js applies
//    `customSanitizer(stripHtml)` to `name` / `venue_name` on POST / (create)
//    but the PUT /:id (update) validators do not, so a host can RENAME a flock
//    to markup and it is stored raw. `rejectIfProfane` does not strip tags. So
//    this file is the only thing standing between a renamed flock and script
//    execution on flockcorp.com. esc() runs on every single value.
//
// 3. Never log the token and never put it in an image URL. og:image is the
//    static marketing image. (Vercel's own request logs still record the
//    invoked path, which carries the token; that is pre-existing for every
//    /i/ request and is not something this file can change.)
//
// 4. No bundle and no meta refresh. A refresh would re-enter the same rewrite
//    and can loop. The page is a real document with a real anchor.
//
// 5. Copy follows SLOP-AUDIT.md: no em dashes, plain sentences, and no claim
//    that is not true of the shipping build.
//
// SERVER CONTRACT (verified against backend/routes/guest.js on 2026-08-14)
//   GET /api/guest/:token
//     400  malformed token   (param('token').isLength({ min: 8, max: 20 }))
//     404  revoked or unknown link
//     200  { flock: { name, when, chosenVenue, status }, host, going, venues[] }
//   `host` is already first-name-only server-side. `when` is flocks.event_time
//   serialized as an ISO string, or null. `status` is one of planning /
//   confirmed / completed / cancelled (CHECK constraint, database/schema.sql).
// ---------------------------------------------------------------------------

// The server issues 12 characters from a 55-char alphanumeric alphabet
// (newLinkToken in backend/routes/guest.js) and validates 8 to 20 on read.
// Matching that range here means a truncated paste never costs a round trip,
// and the token is proven alphanumeric before it is ever concatenated into a
// URL or written into an attribute.
const TOKEN_RE = /^[A-Za-z0-9]{8,20}$/;

const CANONICAL_HOST = 'https://www.flockcorp.com';

// Absolute, on the canonical host, because several scrapers do not follow the
// apex -> www redirect when fetching an image. Same file and same dimensions as
// the default tags in public/index.html; keep them in sync.
const OG_IMAGE = CANONICAL_HOST + '/og-image.png';
const OG_IMAGE_ALT = 'Flock. Plans die in the group chat. Flock is where they happen.';

// Preview bots give up fast. Facebook's scraper allows a few seconds and
// iMessage is stricter, so a slow backend must not turn into a dead preview:
// aborting at 2.5s and falling back to the generic tags beats timing out and
// letting the bot cache nothing at all. Railway cold starts can exceed this,
// which is the main reason a miss must stay uncached (see cacheHeaders below).
const UPSTREAM_TIMEOUT_MS = 2500;

// The instant is correct (event_time round-trips through UTC), but the reader's
// timezone is unknowable here: the fetch comes from a scraper's datacenter, not
// from the person the link was sent to. So the time is rendered in one fixed
// zone WITH its short name attached, which makes it true for everyone rather
// than merely convenient for some. "9:00 PM EDT" read in California is correct
// and legible; a bare "9:00 PM" would have been a guess. The invite page itself
// re-renders in the visitor's own locale the moment they tap through.
const DISPLAY_TZ = 'America/New_York';

// Verbatim from public/index.html, so a fallback preview is indistinguishable
// from what the site serves today.
const DEFAULT_TITLE = 'Flock | Plans that actually happen';
const DEFAULT_DESCRIPTION =
  'Vote on where to go, see how busy it is before you leave, and split the bill after. Free.';

// Escaped rather than literal so this file stays pure ASCII and cannot pick up
// mojibake from a tool that guesses the encoding wrong. Same convention as
// src/website/GuestInvite.js.
const DOT = String.fromCharCode(0xb7);
const ELLIPSIS = String.fromCharCode(0x2026);

// Trailing slashes would produce "//api/guest/..." against the backend. The
// fallback is the same one services/api.js and website/GuestInvite.js use, and
// REACT_APP_API_URL is currently unset in the Vercel project, so the fallback is
// what actually runs today.
const API_BASE = String(
  process.env.REACT_APP_API_URL || 'https://flock-app-production.up.railway.app'
).replace(/\/+$/, '');

// ---------------------------------------------------------------------------
// Escaping and text hygiene
// ---------------------------------------------------------------------------

// Every value that reaches the document goes through this. `&` is replaced
// first: doing it later would double-escape the entities introduced by the
// other replacements. Quotes matter most here because almost every value is
// interpolated into a `content="..."` attribute, and `<` / `>` matter because
// the same text is also rendered as element content in the body.
function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// C0 controls, DEL, and C1 controls become spaces. Written as a code point scan
// rather than a regex so no escape sequence has to survive being written to
// disk, and so it iterates by code point instead of by UTF-16 unit. They are
// flattened to spaces rather than dropped so text cannot silently weld itself
// together across a stripped newline.
function stripControls(text) {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    out += (code < 0x20 || (code >= 0x7f && code <= 0x9f)) ? ' ' : ch;
  }
  return out;
}

// Normalize then clamp. Order matters twice over:
//
//   - Clamping happens BEFORE escaping, never after. Cutting an escaped string
//     can slice "&amp;" into "&am", which is a broken entity in an attribute.
//   - The clamp counts CODE POINTS, not UTF-16 units. Flock names carry emoji,
//     and String.prototype.slice can cut a surrogate pair in half, which puts a
//     lone surrogate into the response body and shows up as a replacement
//     character in the preview.
function clean(value, max) {
  // Anything that is not already text is treated as absent rather than
  // stringified. Without this an object arriving where a name was expected
  // renders the literal "[object Object] invited you to ...", which is worse
  // than the generic tags because it looks like a real preview.
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const normalized = stripControls(String(value))
    .replace(/\s+/g, ' ')
    .trim();
  const points = Array.from(normalized);
  if (points.length <= max) return normalized;
  return points.slice(0, max - 1).join('').trimEnd() + ELLIPSIS;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

// Returns '' for a missing or unparseable time, which every caller treats as
// "no time yet" rather than as an error. A plan with no time set is normal
// early on, so this is a routine branch and not a failure.
function whenLabel(iso) {
  if (!iso) return '';
  const at = new Date(iso);
  if (isNaN(at.getTime())) return '';
  try {
    const dayOpts = { timeZone: DISPLAY_TZ, weekday: 'short', month: 'short', day: 'numeric' };
    // A plan five months out reading "Fri, Jan 9" with no year is the kind of
    // small ambiguity that makes someone answer for the wrong night. Same rule
    // as src/website/GuestInvite.js.
    if (at.getUTCFullYear() !== new Date().getUTCFullYear()) dayOpts.year = 'numeric';
    const day = new Intl.DateTimeFormat('en-US', dayOpts).format(at);
    const time = new Intl.DateTimeFormat('en-US', {
      timeZone: DISPLAY_TZ,
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(at);
    return day + ' at ' + time;
  } catch (err) {
    // A Node build without full ICU throws RangeError on a named timezone. The
    // date alone still beats saying nothing, and never throws.
    return at.toISOString().slice(0, 10);
  }
}

// Build the title and description a bot will show. Pure function of the
// payload: no I/O, no throwing, and it degrades one field at a time rather than
// falling off a cliff when something is missing.
// Preview surfaces truncate, and they truncate with no idea where a word ends.
// Clamping the ASSEMBLED strings rather than only the parts is the difference
// between "Sarah invited you to Friday Night..." and a title that gets cut mid
// entity by somebody else's renderer. Both parts and whole are clamped: the
// per-field limits keep one runaway field from eating the whole budget, and
// these keep the total inside what iMessage and Facebook actually show.
const MAX_TITLE = 90;
const MAX_DESCRIPTION = 160;

function composed(title, description) {
  return { title: clean(title, MAX_TITLE), description: clean(description, MAX_DESCRIPTION) };
}

function describe(payload) {
  const flock = (payload && payload.flock) || {};
  // flocks.name and flocks.venue_name are both VARCHAR(255); users.name feeds
  // `host`, which the server has already reduced to a first name.
  const name = clean(flock.name, 60);
  const host = clean(payload && payload.host, 24);
  const venue = clean(flock.chosenVenue, 48);
  const status = String(flock.status || '');
  const when = whenLabel(flock.when);

  const going = Number(payload && payload.going);
  const goingLabel = Number.isFinite(going) && going > 0 ? going + ' going' : '';

  // A plan that is off is not an invitation. Saying "Sarah invited you to
  // Friday Night Out" for something that was called off sends people to a dead
  // plan and burns the one impression the link gets. `completed` is the same
  // class of dishonesty, so it gets the same treatment.
  if (status === 'cancelled') {
    return composed(
      name ? name + ' was called off' : 'This plan was called off',
      when ? 'Nothing to answer. It was set for ' + when + '.' : 'Nothing to answer.'
    );
  }
  if (status === 'completed') {
    return composed(
      name ? name + ' already happened' : 'This plan already happened',
      when ? 'It was ' + when + '. Answers and votes are closed.' : 'Answers and votes are closed.'
    );
  }

  let title;
  if (host && name) title = host + ' invited you to ' + name;
  else if (host) title = host + ' invited you to a plan';
  else if (name) title = "You're invited to " + name;
  else title = DEFAULT_TITLE;

  // Date and time first, then where, then how many. Middot separated to match
  // how the invite page itself sets out the same three facts.
  const bits = [when || 'Time not set yet'];
  if (venue) bits.push(venue);
  if (goingLabel) bits.push(goingLabel);

  return composed(title, bits.join(' ' + DOT + ' '));
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

// Values mirror src/website/GuestInvite.css so the rare human who lands here
// sees the same paper, not an unstyled document. Kept deliberately small: this
// page is read by a machine almost every time it is served.
const PAGE_CSS = ''
  + ':root{--ip-paper:#f1ede0;--ip-ink:#16283d;--ip-ink-3:#55637a;--ip-accent:#2d5a87;--ip-on-accent:#f4efe3}'
  + '@media (prefers-color-scheme:dark){:root{--ip-paper:#0f172a;--ip-ink:#f4efe3;--ip-ink-3:#9aa4b2;'
  + '--ip-accent:#8fb4d6;--ip-on-accent:#0f172a;color-scheme:dark}}'
  + '*{box-sizing:border-box}'
  + 'body{margin:0;background:var(--ip-paper);color:var(--ip-ink-3);'
  + "font-family:'Hanken Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6}"
  + '.ip{max-width:34rem;margin:0 auto;padding:clamp(20px,5vw,48px) clamp(16px,5vw,40px) 72px}'
  + '.ip-brand{margin:0 0 clamp(24px,6vw,40px);font-size:15px;font-weight:800;letter-spacing:-.02em}'
  + '.ip-brand a{color:var(--ip-ink);text-decoration:none}'
  + 'h1{margin:0 0 12px;font-size:clamp(26px,6vw,38px);line-height:1.15;letter-spacing:-.02em;color:var(--ip-ink)}'
  + '.ip-meta{margin:0 0 28px;font-size:16px}'
  + '.ip-cta{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 20px;'
  + 'border-radius:10px;background:var(--ip-accent);color:var(--ip-on-accent);font-weight:600;text-decoration:none}'
  + '.ip-foot{margin:28px 0 0;font-size:14px}';

// og:url is the field that decides where the tap lands. Without it, Facebook and
// Messenger collapse the preview onto whatever they consider canonical and send
// the tap to the homepage instead of the invite. It is set ONLY when the token
// is well formed: pointing it at a mangled path would be worse than leaving it
// out, and with it absent a scraper falls back to the URL it actually fetched,
// which already resolves to the invite page's own "that link isn't complete"
// state. This is the same reasoning that keeps a static og:url out of
// public/index.html.
function renderPage(opts) {
  const title = esc(opts.title);
  const description = esc(opts.description);
  const url = opts.token ? esc(CANONICAL_HOST + '/i/' + opts.token) : '';
  // Relative so it stays on whichever host served the page (www, or a preview
  // deployment). ?open=1 exists so this anchor cannot land back on this same
  // page: vercel.json routes /i/:token?open=1 straight to the app, ahead of the
  // bot rewrite. Without it, anyone whose user agent matched the bot list by
  // accident would tap a button that reloads the page they are already on,
  // which is a dead button (SLOP-AUDIT H5 / K1).
  const href = opts.token ? esc('/i/' + opts.token + '?open=1') : '/';

  return '<!doctype html>\n'
    + '<html lang="en">\n'
    + '<head>\n'
    + '<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<meta name="robots" content="noindex, noarchive">\n'
    + '<title>' + title + '</title>\n'
    + '<meta name="description" content="' + description + '">\n'
    + '<meta property="og:type" content="website">\n'
    + '<meta property="og:site_name" content="Flock">\n'
    + '<meta property="og:locale" content="en_US">\n'
    + '<meta property="og:title" content="' + title + '">\n'
    + '<meta property="og:description" content="' + description + '">\n'
    + (url ? '<meta property="og:url" content="' + url + '">\n' : '')
    + '<meta property="og:image" content="' + OG_IMAGE + '">\n'
    + '<meta property="og:image:width" content="1200">\n'
    + '<meta property="og:image:height" content="630">\n'
    + '<meta property="og:image:type" content="image/png">\n'
    + '<meta property="og:image:alt" content="' + esc(OG_IMAGE_ALT) + '">\n'
    + '<meta name="twitter:card" content="summary_large_image">\n'
    + '<meta name="twitter:title" content="' + title + '">\n'
    + '<meta name="twitter:description" content="' + description + '">\n'
    + '<meta name="twitter:image" content="' + OG_IMAGE + '">\n'
    + '<meta name="twitter:image:alt" content="' + esc(OG_IMAGE_ALT) + '">\n'
    + '<style>' + PAGE_CSS + '</style>\n'
    + '</head>\n'
    + '<body>\n'
    + '<main class="ip">\n'
    + '<p class="ip-brand"><a href="/">Flock</a></p>\n'
    + '<h1>' + title + '</h1>\n'
    + '<p class="ip-meta">' + description + '</p>\n'
    + '<p><a class="ip-cta" href="' + href + '">Open the invite</a></p>\n'
    + '<p class="ip-foot">Flock is a free app for sorting out where a group is going.</p>\n'
    + '</main>\n'
    + '</body>\n'
    + '</html>\n';
}

// ---------------------------------------------------------------------------
// Cache policy
//
// This is the half of the design that decides whether a bad minute becomes a
// permanently bad link, so it is split by outcome rather than set once.
//
//   HIT  -> cacheable at the edge for 10 minutes. A link dropped into a 20
//           person group chat is fetched once per device by Apple's link
//           preview, so the same URL is scraped many times within seconds, and
//           every one of those is a request against a single Railway instance
//           behind a shared per-IP rate limit.
//
//           Vary: User-Agent is REQUIRED here, not decorative. The CDN cache key
//           is host + path + query and it knows nothing about the user-agent
//           condition that routed the request to this function. Without Vary, a
//           human tapping the same /i/<token> could be served this static page
//           out of the edge cache instead of the React app. Preview bots send
//           stable user agent strings, so the hit rate survives the split.
//
//   MISS -> private, no-store, unconditionally. This is the whole point. A
//           Railway cold start, a 429, or a two second blip must not be written
//           into a shared cache under the invite's URL, because every later
//           share of that same link would then preview generically for as long
//           as the entry lived. Per Vercel's cacheable-response rules `private`
//           and `no-store` each independently disqualify a response from the
//           CDN, so this is belt and braces on purpose.
// ---------------------------------------------------------------------------
function cacheHeaders(res, cacheable) {
  if (cacheable) {
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=600, stale-while-revalidate=3600');
    res.setHeader('Vary', 'User-Agent');
  } else {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  }
}

// Vercel applies a function's own headers over the ones vercel.json sets for the
// same route, so the /i/(.*) security headers are restated here rather than
// assumed. They are identical values, so the two can never disagree.
function send(res, html, cacheable) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Robots-Tag', 'noindex, noarchive');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  cacheHeaders(res, cacheable);
  // Node suppresses the body itself on a HEAD request, so this is correct for
  // both of the methods preview bots actually use.
  res.end(html);
}

function sendGeneric(res, token) {
  send(res, renderPage({
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    token: token || '',
  }), false);
}

// ---------------------------------------------------------------------------
// Token
//
// The rewrite supplies ?token=<path segment>, and Vercel merges the request's
// original query string in alongside it. So a crafted link like /i/AAA?token=BBB
// arrives as two values and the order is not defined. Rather than guess which
// one came from the path, an ambiguous token is treated as no token at all and
// the generic tags go out. A real share link never carries ?token=, so this
// costs nothing in practice.
// ---------------------------------------------------------------------------
function pickOne(values) {
  const distinct = values.filter((v, i) => values.indexOf(v) === i);
  return distinct.length === 1 ? distinct[0] : undefined;
}

function readToken(req) {
  let value;

  const raw = req && req.query ? req.query.token : undefined;
  if (Array.isArray(raw)) value = pickOne(raw);
  else if (typeof raw === 'string') value = raw;

  // req.query is supplied by Vercel's Node runtime. If that ever stops being
  // populated the feature would not fail loudly, it would quietly serve the
  // generic tags forever, which is the hardest kind of regression to notice. So
  // the query string is also read straight off req.url as a fallback.
  if (value === undefined && req && typeof req.url === 'string') {
    try {
      const all = new URL(req.url, 'http://localhost').searchParams.getAll('token');
      if (all.length === 1) value = all[0];
      else if (all.length > 1) value = pickOne(all);
    } catch (err) {
      // An unparseable url is just a missing token.
    }
  }

  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return TOKEN_RE.test(trimmed) ? trimmed : '';
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
async function handler(req, res) {
  let token = '';
  try {
    token = readToken(req);

    // Malformed, missing, or ambiguous.
    if (!token) {
      sendGeneric(res, '');
      return;
    }

    if (typeof fetch !== 'function') {
      sendGeneric(res, token);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    let payload = null;
    try {
      // The token is proven /^[A-Za-z0-9]{8,20}$/ above, so there is nothing
      // here that could alter the path. encodeURIComponent is a no-op on that
      // alphabet and is kept as a second line of defence if the regex is ever
      // widened.
      const upstream = await fetch(API_BASE + '/api/guest/' + encodeURIComponent(token), {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'FlockInvitePreview/1.0 (+https://www.flockcorp.com)',
        },
      });
      // 400 malformed, 404 revoked or unknown, 429 rate limited, 5xx down.
      // Every one of them is a generic preview, never an error page.
      if (upstream.status !== 200) {
        sendGeneric(res, token);
        return;
      }
      // Parsed inside the timeout window on purpose: the abort signal propagates
      // to the body stream, so a backend that answers headers quickly and then
      // stalls is still bounded by UPSTREAM_TIMEOUT_MS.
      payload = await upstream.json();
    } finally {
      clearTimeout(timer);
    }

    // A 200 whose body is not the documented shape is treated exactly like a
    // failed fetch. Guessing at a half-payload is how a preview ends up reading
    // "undefined invited you".
    if (!payload || typeof payload !== 'object'
      || !payload.flock || typeof payload.flock !== 'object') {
      sendGeneric(res, token);
      return;
    }

    const copy = describe(payload);
    send(res, renderPage({ title: copy.title, description: copy.description, token: token }), true);
  } catch (err) {
    // Aborts, DNS failures, malformed JSON, anything at all. The token is
    // deliberately absent from this line, and so is err.message: undici puts the
    // requested URL into some of its network error messages, and that URL
    // carries the token.
    console.error('invite-preview: falling back to default tags:', (err && err.name) || 'Error');
    try {
      sendGeneric(res, token);
    } catch (sendErr) {
      // Headers are already flushed. Nothing useful is left to do, and throwing
      // from here would be the 500 this whole file exists to avoid.
    }
  }
}

module.exports = handler;

// Named handles for unit testing. Vercel treats the function itself as the
// handler and ignores extra properties hung off it.
module.exports.describe = describe;
module.exports.esc = esc;
module.exports.clean = clean;
module.exports.whenLabel = whenLabel;
module.exports.renderPage = renderPage;
module.exports.readToken = readToken;
module.exports.TOKEN_RE = TOKEN_RE;
