import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

   THE BUDGET, and why it is written down. Before the backdrop moved, the
   whole route was a 1.4 KB JS chunk, a 1.3 KB CSS chunk, a 22 KB still and a
   32 KB logo. bg-city.mp4 is 810 KB. That is not a rounding error against
   this page, it is thirteen times everything else combined, so the clip is
   allowed on exactly the terms below and no others:

     • it is never in the markup at mount. The <video> ships with no src, so
       the network has nothing to queue ahead of the logo, the headline or
       the buttons. They paint first, every time, on every connection.
     • the 22 KB poster is the design. The clip fades in OVER a page that was
       already finished, and if it is refused, blocked, throttled or simply
       slow, what stays on screen is the page as designed rather than a hole
       where a video was going to be.
     • it is not fetched at all when the OS or the connection has said no:
       prefers-reduced-motion, Data Saver, or a 2g effective type.

   Same contract the login and signup screens run (components/auth/AuthShell.js,
   AuthBackdrop) and the same code, copied rather than imported for the reason
   the stylesheet gives about its tokens: AuthShell also carries the icon set
   and a 400-line stylesheet, and this route is the one where the connection is
   worst. Fifteen lines duplicated is cheaper than that import. If the swap
   logic changes there, change it here too.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── SWITCH 1 OF 2: THE APP STORE BUTTON ────────────────────────────────────
   Flip to true on the day Apple approves the listing, and not one day before.
   The id below is real (it is the same one LandingPage.js holds) but the
   listing 404s until approval, so with this false the button is not rendered
   at all rather than rendered pointing somewhere broken. A judge who taps
   "App Store" and lands on Apple's error page has learned something false
   about how finished this is.

   The layout underneath it is built for FOUR buttons, not three. The
   secondary row is a fixed 48px against the primary's 54px and the column was
   measured with this flag forced true at 390 / 768 / 1440 and at 667px tall,
   so flipping it adds a button to a composition that already has room for it
   rather than pushing the /about link under the fold. Re-measure at 390px if
   you ever add a fifth.

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
   Do not flip this to true and hope. Open the URL in a private window first.

   2026-08-25: condition 1 is met. The old mirror was deleted because a real
   reused password had reached its history inside a seed file, and a fresh
   public repository was published in its place with that literal redacted from
   all 998 commits and the full timeline from 2026-01-18 preserved. Verified
   unauthenticated before flipping: the repository page and the raw README both
   answer 200 with no login wall. */
const GITHUB_LIVE = true;
const GITHUB_URL = 'https://github.com/bansaljayden/flock-social';

/* The home page. Absolute rather than "/" on purpose: this component also
   renders inside the Capacitor shell's origin, where a root-relative link
   points at the app bundle and not at the website. */
const SITE_URL = 'https://www.flockcorp.com';

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
   absent, is reported honestly as 'unknown' rather than guessed at.

   ?src= is accepted as the same thing, and that is not tidiness. An NFC chip
   is programmed once and then physically handed to somebody, so a URL that
   went onto a card is unfixable from here: no deploy reaches a card already
   sitting in a judge's wallet. The ordering plan for the cards was written
   with ?src=card, this page was built reading ?s=, and either spelling being
   silently scored 'unknown' would lose the one measurement the cards exist to
   produce, with nothing on the screen to show anything was wrong. Reading both
   costs one line. ?s wins when both are present, because it is the spelling
   already programmed into the taps PostHog has recorded. */
const TAG_PARAMS = ['s', 'src'];
const UNKNOWN_TAG = 'unknown';

function readTag() {
  try {
    const params = new URLSearchParams(window.location.search);
    let raw = null;
    for (const name of TAG_PARAMS) {
      raw = params.get(name);
      if (raw) break;
    }
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

/* ── THE BACKDROP ───────────────────────────────────────────────────────────
   Two reasons to never fetch the 810 KB clip: the user asked the OS for less
   motion, or the connection/OS asked us for less data. Both are checked once,
   before the src is ever assigned, so a "no" here costs zero bytes rather
   than a cancelled request. Verbatim from AuthShell's wantsStill(). */
const POSTER = '/bg-city-poster.jpg';
const VIDEO = '/bg-city.mp4';

const wantsStill = () => {
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return true;
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ''))) return true;
  } catch (e) { /* no matchMedia / no NetworkInformation: fall through */ }
  return false;
};

/* requestIdleCallback is the whole point: it will not run until the browser
   has finished the work that paints the page. Safari got it in 16.4, so older
   WebViews take the timeout instead. */
const whenIdle = (fn) => (typeof window.requestIdleCallback === 'function'
  ? window.requestIdleCallback(fn, { timeout: 2500 })
  : window.setTimeout(fn, 700));
const cancelIdle = (id) => (typeof window.cancelIdleCallback === 'function'
  ? window.cancelIdleCallback(id)
  : window.clearTimeout(id));

/* The still and the clip are the same footage at the same treatment, so the
   swap reads as the photograph starting to move rather than as a second
   picture arriving. Everything that dims them lives on the wrapper (see
   TapPage.css), which is what lets the video cross-fade over the plate
   without the two briefly compositing to a brighter image than either.

   Two ways this can go wrong and one way out of both. play() can be refused
   (WKWebView does that when the muted ATTRIBUTE has not landed on the element
   yet), or the file can never arrive at all: a 404, a captive portal, a
   proxy that eats video. Either way the element stands down, the src is
   dropped, and the still underneath is what stays on screen. No grey iOS
   play glyph, no black rectangle, no second attempt.

   standDown() clears `live` as well as the src, and that is the half that is
   easy to leave out. A 404 in Chrome still resolves play(), so without it the
   video sits at opacity 1 over the plate and the page only looks right
   because the poster ATTRIBUTE happens to be the same image. That is a
   correct page resting on a coincidence, and the day someone drops the
   poster attribute it becomes a black rectangle. */
function TapBackdrop() {
  const ref = useRef(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const v = ref.current;
    if (!v || wantsStill()) return undefined;

    let cancelled = false;
    const idle = whenIdle(() => {
      if (cancelled || !v) return;
      v.muted = true;
      v.setAttribute('muted', '');
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      const standDown = () => {
        if (!cancelled) setLive(false);
        v.removeAttribute('src');
        v.load();
      };
      const play = () => {
        v.play().then(() => { if (!cancelled) setLive(true); }).catch(standDown);
      };
      v.addEventListener('canplay', play, { once: true });
      v.addEventListener('error', standDown, { once: true });
      v.src = VIDEO;
      v.load();
    });

    return () => { cancelled = true; cancelIdle(idle); };
  }, []);

  return (
    <div className="tap-bg" aria-hidden="true">
      {/* Decorative, so alt is empty and the whole group is hidden from the
          accessibility tree. lazy + low priority is deliberate on an image
          that IS in the first viewport: it must never be queued ahead of the
          logo, the font or the JS, and the navy underneath it is what the
          page is actually designed against. */}
      <img
        className="tap-plate"
        src={POSTER}
        alt=""
        width="640"
        height="360"
        loading="lazy"
        decoding="async"
        fetchPriority="low"
      />
      {/* No src. It is attached by the effect above, once, when the browser
          is idle and only if nothing has said no. preload is "metadata" and
          must never be "auto": auto is how an 810 KB clip gets in front of a
          32 KB logo on venue wifi. */}
      <video
        ref={ref}
        className={`tap-video${live ? ' is-live' : ''}`}
        preload="metadata"
        poster={POSTER}
        loop
        muted
        playsInline
        tabIndex={-1}
        disablePictureInPicture
      />
    </div>
  );
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

/* Stroked, not filled, because a filled globe at 20px is a dark blob next to
   two marks that read as shapes. Same 24-unit box as the other two. */
const SiteMark = () => (
  <svg className="tap-stroke" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3c2.4 2.5 3.8 5.7 3.8 9s-1.4 6.5-3.8 9c-2.4-2.5-3.8-5.7-3.8-9s1.4-6.5 3.8-9z" />
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
      <TapBackdrop />

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
          {/* Order is what a judge wants next, not what Flock is proudest of:
              open the thing, then read about the thing, then read the code,
              then install it. The primary is the only 54px control and the
              only filled one, so the answer to "what do I press" survives
              the row growing from two buttons to four. */}
          <a
            className="tap-btn tap-btn-primary"
            href="/app"
            onClick={() => record('open_app')}
          >
            Open Flock
          </a>

          {/* Same tab. This is a page on the site the judge is already on,
              so opening a second tab would be a new window for a navigation
              rather than an exit to somewhere else. The two below DO leave,
              which is what earns them target/rel. */}
          <a
            className="tap-btn tap-btn-ghost"
            href={SITE_URL}
            onClick={() => record('site')}
          >
            <SiteMark />
            Visit flockcorp.com
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

      {/* Birdie, standing on the bottom edge of the screen off to one side.

          One bird, not a flight of them: he is the brand showing up in person
          for a reader who has fifteen seconds, and a mascot parade on a page
          this small would be the decoration SLOP-AUDIT §I warns about rather
          than a character.

          He is absolutely positioned and pointer-events:none, so he costs the
          column no vertical space and can never push the /about link under
          the fold. The stylesheet keeps him clear of the text at every width
          rather than trusting the overlap not to happen. What moves is a 6s
          CSS breath on a transform, which the compositor owns and which
          reduced-motion removes.

          TWO LAYERS, NOT ONE, and that is not optional. The body file's own
          head is deliberately soft, because the sharp turning head normally
          sits over it and what shows through mid-turn should be more bird
          rather than a hole. A bare body <img> is a blurry-faced bird at any
          size. components/ui/BirdieBird.js owns that rule and
          __tests__/birdBrandMoments.test.js pins it; this is the same two
          layers on the same canvas, written out here for the two reasons
          below rather than imported from it.

          WHY NOT import BirdieStill. Both reasons are about this route
          specifically, and both were measured.

            1. BirdieBird.js is a shared chunk with the app (3.6 KB gzipped)
               and importing it here put that chunk, and the request for it,
               on the /tap waterfall. This page's whole JS was 1.5 KB.
            2. Its srcSets carry a 2x entry, which is right everywhere it is
               used and wrong here: the 2x body and head are 75 KB and 49 KB
               of WebP, so a retina phone tapping an NFC tag would pull 124 KB
               of decoration instead of 35 KB. The bird renders 99 CSS px wide
               on a phone and 148 on a desktop, and the -400 files are 315px
               across, which is already 3.2x and 2.1x. There is no second
               entry because there is nothing a second entry would buy.

          WebP first with the PNG kept as the fallback for an engine that
          cannot decode it. lazy + aria-hidden, so he queues behind the same
          things the poster queues behind and says nothing to a screen
          reader. */}
      <div className="tap-perch" aria-hidden="true">
        <picture>
          <source type="image/webp" srcSet="/birdie/birdie-body-400.webp" />
          <img src="/birdie/birdie-body-400.png" alt="" draggable={false} decoding="async" loading="lazy" />
        </picture>
        <picture>
          <source type="image/webp" srcSet="/birdie/birdie-head-400.webp" />
          <img src="/birdie/birdie-head-400.png" alt="" draggable={false} decoding="async" loading="lazy" />
        </picture>
      </div>
    </main>
  );
}
