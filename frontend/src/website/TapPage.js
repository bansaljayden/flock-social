import React, { useCallback, useEffect, useMemo } from 'react';
import './TapPage.css';

/* ═══════════════════════════════════════════════════════════════════════════
   /tap. The one URL that is printed into every physical NFC tag.

   An NFC chip holds exactly one URL and reprogramming a stack of business
   cards is not a thing anyone does twice, so every tag points here and this
   page is the hub. Change what Flock links to by editing this file, never by
   re-writing tags.

   The tags, and the URL each one carries:
     acrylic table stand at the booth   https://flockcorp.com/tap?s=stand
     business cards handed to judges    https://flockcorp.com/tap?s=card

   THE READER is a DECA judge who has never heard of Flock, tapping a phone at
   a competition on venue wifi, who will look at this for about fifteen
   seconds. Every decision below falls out of that: one screen, one sentence
   saying what Flock is, one obviously primary action, and nothing on the
   critical path that the network can stall.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── SWITCH 1 OF 2: THE APP STORE BUTTON ────────────────────────────────────
   Flip to true on the day Apple approves the listing, and not one day before.
   The id below is real (it is the same one LandingPage.js holds) but the
   listing 404s until approval, so with this false the button is not rendered
   at all rather than rendered pointing somewhere broken. A judge who taps
   "App Store" and lands on Apple's error page has learned something false
   about how finished this is.

   LandingPage.js carries its own APP_STORE_LIVE for the hero badge. Flip both
   in the same change, along with the App Store `sameAs` note in
   public/index.html's JSON-LD block, which says the same thing. */
const APP_STORE_LIVE = false;
const APP_STORE_URL = 'https://apps.apple.com/app/id6781442127';

/* ── SWITCH 2 OF 2: THE GITHUB BUTTON ───────────────────────────────────────
   OFF, and this one is a decision waiting on Jayden rather than a date on a
   calendar.

   Flock has two repositories. `bansaljayden/Flock-app-` is the private one
   everything is pushed to. `bansaljayden/flock-social` was the public mirror,
   the one built to be read by anyone evaluating the project, and it was made
   PRIVATE and its push-publishing deliberately switched off. So there is no
   public repository today, and a GitHub button on this page would hand a judge
   either a 404 or a GitHub login wall. Both are worse than no button: the
   button promises "the code is open, go look", and the page then fails to
   deliver in front of the person scoring him.

   To turn this on, one of two things has to happen first, and both are
   Jayden's calls, not a code change:
     1. publish a public repository again (that is what tools/publish/
        publish-public.sh exists for, and it must not be run on his behalf),
        then set the URL below to whatever it ends up being, or
     2. decide the source stays private, in which case delete this constant,
        the URL, the button and the icon rather than leaving a dead switch
        sitting in the file.
   Do not flip this to true and hope. Open the URL in a private window first. */
const GITHUB_LIVE = false;
const GITHUB_URL = 'https://github.com/bansaljayden/flock-social';

/* CRA does no server rendering, so public/index.html is the byte-for-byte
   response on this route too and its homepage description would otherwise be
   this page's. Same mechanism every other page in this directory uses: rewrite
   the tag index.html ships, from this route's own effect. There is no
   <meta name="robots"> written here on purpose. /tap is noindex, and that is
   served as an X-Robots-Tag header from frontend/vercel.json, which works for
   the crawlers that never run JavaScript as well as the ones that do. */
const TITLE = 'Flock';
const DESCRIPTION = 'Flock is a free app where a group votes on where to go out, checks how busy it is, and splits the bill after.';

/* ── WHICH TAG WAS TAPPED ───────────────────────────────────────────────────
   ?s= is the only thing that tells the table stand apart from the cards, and
   it arrives from a URL, which means it arrives from anyone. It is bounded
   here before it is ever sent anywhere: lowercased, reduced to the characters
   a tag name can contain, and cut to 32. Anything left over, and anything
   absent, is reported honestly as 'unknown' rather than guessed at. */
const TAG_PARAM = 's';
const UNKNOWN_TAG = 'unknown';

function readTag() {
  try {
    const raw = new URLSearchParams(window.location.search).get(TAG_PARAM);
    if (!raw) return UNKNOWN_TAG;
    const cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
    return cleaned || UNKNOWN_TAG;
  } catch (e) {
    return UNKNOWN_TAG;
  }
}

/* ── ANALYTICS, OFF THE CRITICAL PATH ───────────────────────────────────────
   Two rules collide here and this is what satisfies both.

   Rule one: every PostHog capture call in this app lives in services/api.js
   and nowhere else, which __tests__/analyticsPrivacy.test.js enforces by
   scanning all of src/ for the call itself, comments included. That file is
   the review chokepoint for what leaves a 13-year-old's device, so this page
   routes through it instead of reaching for the SDK. trackNfcTap and
   trackNfcAction are its two exports for this page.

   Rule two: services/api.js is the whole REST client, and this is the route
   where the connection is worst. So it is a DYNAMIC import, not a static one.
   It is not in this page's chunk, it is not on the path to first paint, and
   if it never loads the page is completely unaffected. The promise is cached
   at module scope, and the load event on mount is what warms it, so by the
   time a judge has read the screen and tapped something the module is already
   there to record the tap. */
let apiChunk = null;
function withApi(fn) {
  if (!apiChunk) apiChunk = import('../services/api').catch(() => null);
  apiChunk.then((api) => {
    if (!api) return;
    try { fn(api); } catch (e) { /* analytics is never load-bearing */ }
  });
}

/* Apple's own mark, the same path LandingPage.js draws in its badge. Inline
   because one <svg> is cheaper than a request, and because this page must not
   depend on an icon module it would otherwise pull in whole. */
const AppleMark = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M17.05 12.54c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.72-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.87-.76-1.48.02-2.84.86-3.6 2.18-1.53 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.24 2.74 2.2 1.1-.05 1.52-.71 2.85-.71 1.33 0 1.7.71 2.87.69 1.18-.02 1.93-1.07 2.65-2.13.84-1.22 1.18-2.4 1.2-2.46-.03-.01-2.28-.88-2.3-3.48zM14.9 5.6c.6-.74 1.01-1.76.9-2.78-.87.04-1.93.58-2.56 1.31-.56.65-1.05 1.69-.92 2.68.97.08 1.97-.49 2.58-1.21z" />
  </svg>
);

const GitHubMark = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M12 2C6.48 2 2 6.58 2 12.23c0 4.51 2.87 8.34 6.84 9.69.5.09.68-.22.68-.5l-.01-1.72c-2.78.62-3.37-1.37-3.37-1.37-.45-1.19-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 2.5-.34c.85 0 1.71.12 2.5.34 1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.35 4.8-4.58 5.05.36.32.68.94.68 1.9l-.01 2.82c0 .28.18.6.69.5A10.05 10.05 0 0 0 22 12.23C22 6.58 17.52 2 12 2z" />
  </svg>
);

export default function TapPage() {
  const tag = useMemo(readTag, []);

  useEffect(() => {
    document.title = TITLE;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', DESCRIPTION);
    // One event per page load. StrictMode double-invokes effects in
    // development, so a dev run reports two; production builds do not.
    withApi((api) => api.trackNfcTap(tag));
  }, [tag]);

  // Landing is only half of what is worth knowing. This says what the judge
  // did next, which is the difference between "the tags work" and "the tags
  // work and people open the app".
  const record = useCallback((action) => {
    withApi((api) => api.trackNfcAction(tag, action));
  }, [tag]);

  return (
    <main className="tap">
      {/* Decorative, so alt is empty and the image is hidden from the
          accessibility tree. lazy + low priority is deliberate on an image
          that IS in the first viewport: it must never be queued ahead of the
          logo, the font or the JS, and the navy underneath it is what the
          page is actually designed against. */}
      <img
        className="tap-bg"
        src="/bg-city-poster.jpg"
        alt=""
        aria-hidden="true"
        width="640"
        height="360"
        loading="lazy"
        decoding="async"
        fetchPriority="low"
      />

      {/* NO SKIP LINK HERE, and that is a considered exception to SLOP-AUDIT
          §Q1 rather than an omission. WCAG 2.4.1 is about bypassing repeated
          blocks of content, and this page has none: there is no nav, no
          header, no menu. The first focusable element already IS the primary
          action, so a skip link would push "Open Flock" to second place for
          exactly the keyboard user it claims to help. Add one the moment this
          page grows anything above the fold worth skipping. */}
      <div className="tap-in">
        {/* logo192.png, not flock-logo.png, and they are the same artwork:
            the cream disc, the three birds, the FLOCK wordmark. flock-logo.png
            is the 512px master at 122 KB and this renders at 84 CSS px.
            logo192 is 32 KB, it is already the <link rel=icon> in index.html
            so a browser that painted the favicon has it cached, and it is what
            LandingPage.js's own mark uses. 90 KB is a real fraction of this
            page on venue wifi. */}
        <img
          className="tap-logo"
          src="/logo192.png"
          alt="Flock"
          width="84"
          height="84"
          decoding="async"
        />

        <h1>Flock is how a group decides where to go out.</h1>

        <p className="tap-lead">
          Everyone votes on the place, budgets stay private, and the bill
          splits after. It is free, and it runs in this browser, so there is
          nothing to download.
        </p>

        <div className="tap-actions">
          <a
            className="tap-btn tap-btn-primary"
            href="/app"
            onClick={() => record('open_app')}
          >
            Open Flock
          </a>

          {GITHUB_LIVE && (
            <a
              className="tap-btn tap-btn-ghost"
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => record('github')}
            >
              <GitHubMark />
              Read the source on GitHub
            </a>
          )}

          {APP_STORE_LIVE && (
            <a
              className="tap-btn tap-btn-ghost"
              href={APP_STORE_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => record('app_store')}
            >
              <AppleMark />
              Download on the App Store
            </a>
          )}
        </div>

        <p className="tap-more">
          <a href="/about" onClick={() => record('about')}>
            What Flock is, and why venues pay
          </a>
        </p>
      </div>
    </main>
  );
}
