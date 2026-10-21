import React, { Suspense, useEffect, useRef, useState } from 'react';
import './LandingPage.css';
import SiteFooter from './SiteFooter';
import AnnotatedShot from './AnnotatedShot';
import { ANNOTATIONS } from './landingAnnotations';
import displayFontUrl from '../fonts/Literata-Display-600.woff2';
import { NAV_LINKS, MENU_LINKS } from './SiteNav';

/* The live demo is code-split, and this is load-bearing rather than tidiness.
   LiveDemo pulls in maplibre-gl, which webpack emits as a 1.06 MB chunk. As a
   static import it landed in this page's chunk GROUP, and React.lazy does not
   resolve until every chunk in the group has arrived, so the marketing page
   rendered nothing at all until a map engine nobody had scrolled to yet had
   finished downloading. Split out and mounted on approach, the hero's critical
   path stays small and the map does not touch the network until you are within
   a screen of it. */
const LiveDemo = React.lazy(() => import('./LiveDemo'));

const API = process.env.REACT_APP_API_URL || 'https://api.flockcorp.com';

/* Literata Display sets the h1, this page's largest contentful element. The
   Pages build already sends it as a preload with the HTML (build-cloudflare.js
   routePreloads); this covers every other host and a local build. `crossorigin`
   is not optional: fonts are fetched in CORS mode even same-origin, and a
   preload without it is a second, wasted download rather than a hit. */
if (typeof document !== 'undefined' && !document.querySelector('link[data-lp-font]')) {
  const l = document.createElement('link');
  l.rel = 'preload';
  l.as = 'font';
  l.type = 'font/woff2';
  l.href = displayFontUrl;
  l.crossOrigin = 'anonymous';
  l.setAttribute('data-lp-font', '');
  document.head.appendChild(l);
}

// Inbound mail: Cloudflare Email Routing forwards this to the maintainer's
// inbox (set up 2026-08-12). Outbound stays on Resend.
const CONTACT_EMAIL = 'social@flockcorp.com';

/* The hero capture. Real screens of the shipping web app, captured by
   scripts/capture-screenshots.mjs against seeded demo data. The AVIF is the
   capture cut to the part the plate shows (390:658 from the top), 25 KB
   against the WebP's 57; the preload in vercel.json, cloudflare/_headers and
   functions/_middleware.js names HERO_SHOT.avif, and siteSpeedPass.test.js
   checks they agree. */
const HERO_SHOT = {
  avif: '/screenshots/nest-dark-hero.avif',
  webp: '/screenshots/nest-dark@2x.webp',
  png: '/screenshots/nest-dark@2x.png',
  alt: 'The Flock home screen: tonight’s status, your flocks, and a plan that still needs votes.',
};

/* The Flock mark: the actual logo, served from a 64px derivative. The nav mark
   renders at 32 CSS px and the footer one at 24, so 64 covers both at 2x;
   /logo192.png stays for index.html's icon link and the manifest. */
const Mark = ({ size = 32, lazy = false }) => (
  <img
    src="/marks/logo-64.png?v=2"
    width={size} height={size}
    alt=""
    aria-hidden="true"
    {...(lazy ? { loading: 'lazy', fetchPriority: 'low' } : {})}
    style={{ borderRadius: '50%', display: 'block' }}
  />
);

/* No App Store badge until Apple approves the app. The homemade "Coming soon
   to the App Store" badge used a standalone Apple logo and a modifier Apple
   does not provide (its marketing guidelines allow only "Download on the" and
   "Pre-order on the", and only Apple's own artwork, for an app that is
   available). Until approval the page says it in words. On approval, add
   Apple's official badge file, unmodified, linking to
   https://apps.apple.com/app/id6781442127. */

/* No scroll-reveal animation on this page, deliberately. Sections sliding in
   as you scroll is the most recognizable AI-built-site tell (DESIGN-STANDARD.md
   A10), and the content is better off just being there. */

/* Holds a below-the-fold thing's space and only mounts it once you are within
   a screen of it. This is NOT a reveal: nothing fades, nothing moves, and the
   box is the same size before and after, so the page does not shift. It exists
   because the live demo's map engine is expensive at load and useless at the
   top of the page. No IntersectionObserver (old Safari, any prerender) means
   render now. A first Tab press mounts everything, so the keyboard order never
   steps over an unmounted control. */
function WhenNear({ margin = '700px', className, hold, id, children }) {
  const ref = useRef(null);
  const [near, setNear] = useState(typeof IntersectionObserver !== 'function');

  useEffect(() => {
    if (near) return undefined;
    const el = ref.current;
    if (!el) return undefined;

    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setNear(true);
    }, { rootMargin: margin });
    io.observe(el);

    const onKey = (e) => { if (e.key === 'Tab') setNear(true); };
    window.addEventListener('keydown', onKey);

    return () => {
      io.disconnect();
      window.removeEventListener('keydown', onKey);
    };
  }, [near, margin]);

  return (
    <div ref={ref} id={id} className={className} style={hold}>
      {near ? children : null}
    </div>
  );
}

/* THE FLOCK PRO LINE EXISTS ONLY WHILE PRO IS ON SALE. It asks the public
   /api/pro-offer endpoint, which answers available only when web checkout is
   switched on and every part of it is configured, and carries the prices
   Stripe will charge. Until then nothing renders, so the homepage never
   advertises something nobody can buy and never prints a price the checkout
   would not charge. A failed request is the same as "not on sale". The limits
   are the ones the backend enforces with the paywall on:
   services/birdieUsage.js (10 a day free, 150 with Pro) and
   services/forecastUsage.js (30 a month free). */
function useProOffer() {
  const [offer, setOffer] = useState(null);
  useEffect(() => {
    let live = true;
    fetch(`${API}/api/pro-offer`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && d && d.available && Array.isArray(d.plans) && d.plans.length) setOffer(d); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return offer;
}

function ProOfferCard({ offer }) {
  const monthly = offer.plans.find((p) => p.id === 'monthly');
  const yearly = offer.plans.find((p) => p.id === 'yearly');
  const lead = monthly || yearly;
  const tax = offer.taxAdded ? ' plus tax' : '';
  return (
    <div className="lp-plan">
      <h3>Flock Pro</h3>
      <div className="lp-plan-price">
        {lead.label}
        <small>
          {lead.id === 'monthly' ? 'a month' : 'a year'}
          {monthly && yearly ? `, or ${yearly.label} a year` : ''}
          {tax}
        </small>
      </div>
      <p className="lp-plan-note">For whoever plans the most. Cancel online any time.</p>
      <ul className="lp-list">
        <li>Everything in Free</li>
        <li>150 Birdie messages a day instead of 10</li>
        <li>Crowd levels and forecasts for every venue, not just 30 a month</li>
        <li>A heads-up push before your spot gets packed</li>
      </ul>
      <a className="lp-btn lp-btn-navy" href="/pro">Get Flock Pro</a>
    </div>
  );
}

// What the waitlist form says when the request comes back. 400 and 429 carry
// sentences the route wrote for the visitor, so those are shown; anything else
// that failed gets one plain line; a repeat signup says so instead of
// welcoming them again. A dropped connection never shows the browser's own
// "Failed to fetch".
const WAITLIST_JOINED = 'You’re on the list. You’ll get an email when it opens up.';
const WAITLIST_ALREADY = 'You’re already on the list. You’ll get an email when it opens up.';
const WAITLIST_FAILED = 'Could not sign you up. Try again in a moment.';
const WAITLIST_OFFLINE = 'Couldn’t reach Flock. Check your connection and try again.';

export function waitlistReply(status, data) {
  if (status >= 200 && status < 300) {
    return { msg: data && data.alreadyOnList ? WAITLIST_ALREADY : WAITLIST_JOINED, bad: false };
  }
  const said = data && typeof data.error === 'string' ? data.error.trim() : '';
  if ((status === 400 || status === 429) && said && said !== 'Server error') {
    return { msg: said, bad: true };
  }
  return { msg: WAITLIST_FAILED, bad: true };
}

/* One Friday plan, the way it actually runs in the app. It replaced a
   numbered 01-04 grid and three feature spreads that each restated the
   product; the order is the order a group meets the features in. Every claim
   is checked against the code that does it:
     guests answer, vote and add a budget from a link   routes/guest.js, migration 071
     one rounded-down ceiling, published once           routes/budget.js bandCeiling + settledCeiling
     "Still in?" with a deadline                        ChatDetail.js, migration 072
     events show only on a verified venue's card        GET /public-events (venueDashboard.js)
     Venmo and Cash App links, Zelle instructions       the bill split sheet
   The plates beside the beats are real captures in <figure>s, which the
   crawler copy excludes (aiCrawlerSurface.test.js); the dead chat above them
   is the only mock, and it is a mock of a group chat, not of Flock. */

export default function LandingPage() {
  const proOffer = useProOffer();
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState('');
  const [msgBad, setMsgBad] = useState(false);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const menuBtnRef = useRef(null);
  const wasMenuOpen = useRef(false);

  // While the panel is open: page scroll is locked on the ROOT element (a lock
  // on <body> makes <body> the scroll container and the sticky bar sticks to
  // the document instead of the screen), Escape closes, and Tab cycles inside
  // the panel and the menu button.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const panel = menuRef.current;
    const btn = menuBtnRef.current;
    if (!panel) return undefined;

    const root = document.documentElement;
    const bar = window.innerWidth - root.clientWidth;
    const prevOverflow = root.style.overflow;
    const prevPad = document.body.style.paddingRight;
    root.style.overflow = 'hidden';
    if (bar > 0) {
      document.body.style.paddingRight = `${bar}px`;
      document.body.style.setProperty('--lp-scrollbar', `${bar}px`);
    }

    const first = panel.querySelector('a[href]');
    if (first) first.focus();

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuOpen(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [btn, ...panel.querySelectorAll('a[href]')].filter(Boolean);
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      const next = e.shiftKey
        ? items[(i <= 0 ? items.length : i) - 1]
        : items[i === -1 || i === items.length - 1 ? 0 : i + 1];
      e.preventDefault();
      next.focus();
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      root.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPad;
      document.body.style.removeProperty('--lp-scrollbar');
    };
  }, [menuOpen]);

  // Closing hands focus back to the button that opened it.
  useEffect(() => {
    if (wasMenuOpen.current && !menuOpen && menuBtnRef.current) {
      menuBtnRef.current.focus();
    }
    wasMenuOpen.current = menuOpen;
  }, [menuOpen]);

  useEffect(() => {
    document.title = 'Flock | Nurturing friendship, one flock at a time';
    const d = document.querySelector('meta[name="description"]');
    if (d) d.setAttribute('content', 'Flock is how a group decides where to go out. Your friends vote on the place, and everyone’s budget stays private.');
  }, []);

  const join = async (e) => {
    e.preventDefault();
    if (busy) return;
    const value = email.trim();
    if (!value) {
      setMsg('Enter your email first.');
      setMsgBad(true);
      if (emailRef.current) emailRef.current.focus();
      return;
    }
    setBusy(true);
    setMsg('');
    setMsgBad(false);
    try {
      let res;
      try {
        res = await fetch(`${API}/api/waitlist`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: value }),
        });
      } catch {
        // fetch rejects only when no response arrived at all.
        setMsg(WAITLIST_OFFLINE);
        setMsgBad(true);
        return;
      }
      const data = await res.json().catch(() => ({}));
      const reply = waitlistReply(res.status, data);
      setMsg(reply.msg);
      setMsgBad(reply.bad);
      if (!reply.bad) setEmail('');
    } catch {
      setMsg(WAITLIST_FAILED);
      setMsgBad(true);
    } finally {
      setBusy(false);
    }
  };

  /* While the panel is open the rest of the document is inert, so a screen
     reader's virtual cursor cannot walk into the page behind it. Not
     aria-modal: the close control is the menu button in the header, outside
     the panel. `inert: true`, a real boolean (React 19 treats '' as false). */
  const pageInert = menuOpen ? { inert: true } : {};

  return (
    <div className="lp">
      <a className="lp-skip" href="#lp-main">Skip to the main content</a>

      {/* ---------------- nav ---------------- */}
      <header className={`lp-nav${menuOpen ? ' is-menu-open' : ''}`}>
        <div className="lp-wrap lp-nav-in">
          <a className="lp-brand" href="/"><Mark /> Flock</a>
          <nav className="lp-nav-links" aria-label="Sections">
            {NAV_LINKS.map((l) => (
              <a key={l.href} href={l.href}>{l.label}</a>
            ))}
          </nav>
          <a className="lp-btn lp-btn-cream lp-nav-open" href="/app">Open Flock</a>
          <button
            type="button"
            ref={menuBtnRef}
            className={`lp-menu-btn${menuOpen ? ' is-open' : ''}`}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-controls="lp-menu"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span className="lp-menu-bars" aria-hidden="true">
              <span className="lp-menu-bar" />
              <span className="lp-menu-bar" />
            </span>
          </button>
        </div>
      </header>

      {/* ---------------- menu panel ---------------- */}
      <div
        id="lp-menu"
        ref={menuRef}
        className={`lp-menu${menuOpen ? ' is-open' : ''}`}
      >
        <nav className="lp-menu-in" aria-label="Site menu">
          {MENU_LINKS.map((l) => (
            <a
              key={l.href}
              className="lp-menu-link"
              href={l.href}
              aria-current={l.href === '/' ? 'page' : undefined}
              onClick={() => setMenuOpen(false)}
            >
              {l.label}
            </a>
          ))}
          <a
            className="lp-btn lp-btn-cream lp-btn-lg lp-menu-cta"
            href="/app"
            onClick={() => setMenuOpen(false)}
          >
            Open Flock
          </a>
        </nav>
      </div>

      <main id="lp-main" tabIndex={-1} {...pageInert}>

      {/* ---------------- hero ----------------
          The tagline, then what Flock is for in plain words, one action, then
          the honest status of the iPhone app. Flat navy: the soft glow at the top of a
          dark hero is the stock generated-site hero, and nothing in a printed
          field guide glows. The phone is a plate in the margin with a caption,
          the field guide's own device and the honest way to say the screen is
          real. */}
      <section className="lp-hero lp-on-navy" aria-labelledby="lp-h-hero">
        <div className="lp-wrap lp-hero-in">
          <div className="lp-hero-copy">
            <h1 id="lp-h-hero">Nurturing friendship, <span className="lp-keep">one flock at a time.</span></h1>
            <p className="lp-lead">
              Flock is how a group decides where to go out. Everybody votes on the
              place, and nobody has to say their budget out loud.
            </p>
            <div className="lp-hero-cta">
              <a className="lp-btn lp-btn-cream lp-btn-lg" href="/signup">Start a plan</a>
            </div>
            <p className="lp-hero-note">
              Free, and it works in your browser today. The iPhone app is still in
              App Store review (<a href="#get">get an email when it’s out</a>).
              Flock took 1st place at PA DECA States.
            </p>
          </div>

          <figure className="lp-phone-wrap">
            {/* Literal paths, not HERO_SHOT's, so siteSpeedPass.test.js can see
                the file the Link preload names is the one this requests. */}
            <picture>
              <source type="image/avif" srcSet="/screenshots/nest-dark-hero.avif" />
              <source type="image/webp" srcSet="/screenshots/nest-dark@2x.webp" />
              <img
                className="lp-shot lp-shot-hero"
                src="/screenshots/nest-dark@2x.png"
                width="390" height="844"
                fetchPriority="high"
                alt={HERO_SHOT.alt}
              />
            </picture>
            <figcaption className="lp-plate-cap">
              Who’s in tonight, and which plans need votes.
            </figcaption>
          </figure>
        </div>
      </section>

      {/* ---------------- crowd levels, live ----------------
          The one thing on the page a generator cannot fake, so it comes second,
          straight after the hero. #crowds stays on the section and #try on the
          demo, so the footer link and the menu link each land somewhere. */}
      <section className="lp-sec lp-sec-paper lp-live" id="crowds" aria-labelledby="lp-h-crowds">
        <div className="lp-wrap">
          <div className="lp-live-top">
          <div className="lp-live-head">
            <h2 id="lp-h-crowds">See how busy it is before anyone leaves.</h2>
            {/* What crowdEngine and the forecast actually do: a venue's usual
                pattern for the hour, moved by its newest live readings where
                Flock has them, and an estimate from places like it everywhere
                else. The quieter pick is the venue card's own suggestion. */}
            <p className="lp-lead">
              Search any place below. Flock starts from how busy it usually gets at
              this hour and adjusts with live readings when it has them. Packed?
              It suggests a quieter spot nearby.
            </p>
            {/* crowdEngine.js needs MIN_CALIBRATION_REPORTERS (3) distinct
                verified reporters in the same weekly day-and-hour bucket before
                reports move anything; below that the model's answer stands.
                Check-ins do not feed the number at all. */}
            <p className="lp-live-note">
              Three reports from people at a venue move its score for that night and hour.
            </p>
            {/* The two pages behind this number, as one line: /ai for the
                models (it says plainly what the card serves today), /flux for
                the counter being built. Teasers only; the 3D lives on /flux. */}
            <p className="lp-live-note lp-live-more">
              We’re building <a href="/flux">Flux</a>, a box that counts the people
              in a venue and sends Flock only numbers. The four models in Flock are
              on <a href="/ai">How the AI works</a>.
            </p>
          </div>
          <img
            className="lp-art lp-live-art"
            src="/art/crowd-busy-480.webp"
            srcSet="/art/crowd-busy-480.webp 480w, /art/crowd-busy-960.webp 960w"
            sizes="(min-width: 960px) 420px, min(360px, 90vw)"
            width="480" height="154"
            loading="lazy" decoding="async"
            alt=""
          />
          </div>
          {/* 800px of lead: the demo is loading and drawing before it reaches
              the screen. The holder is the demo's own height, so nothing shifts
              when it mounts. It is #try, the menu's "Try it live". */}
          <WhenNear id="try" className="lpd-hold" margin="800px">
            <Suspense fallback={null}><LiveDemo /></Suspense>
          </WhenNear>
        </div>
      </section>

      {/* ---------------- one Friday plan ----------------
          The Friday is the one in the captures: the Friday Night Crew flock,
          The Copper Finch, Asad's bill. Each plate is a real screen of the
          web app (scripts/capture-screenshots.mjs, seeded demo data, venue
          pictures drawn rather than photographed), so the story and the
          pictures are the same night. The dead chat that opens it sits on
          navy (the maintainer, 2026-10-21), so its bird is a beige sparrow: the
          navy wrens vanish on a navy band. */}
      <section className="lp-sec lp-sec-navy lp-on-navy" id="how" aria-labelledby="lp-h-how">
        <div className="lp-wrap">
          <h2 id="lp-h-how" className="lp-friday-title">Everyone said yes. Then the chat went quiet.</h2>
          <p className="lp-lead lp-friday-lead">
            Here’s that same Friday in Flock: five steps, and nobody has to carry it.
          </p>

          {/* The dead chat beside a sparrow taking off: everyone flew, and
              nobody went. No words added. */}
          <div className="lp-friday-open">
          <figure className="lp-chat lp-friday-chat">
            <div className="lp-msg">we should all hang out this weekend</div>
            <div className="lp-msg lp-msg-me">yesss I'm down</div>
            <div className="lp-msg">same, where tho</div>
            <div className="lp-msg lp-msg-me">idk what do you guys want</div>
            <div className="lp-msg">I'm good with anything</div>
            <div className="lp-msg lp-msg-dead">Seen by 5 · nobody went</div>
          </figure>
          <img
            className="lp-art lp-friday-art"
            src="/art/spot-flap-240.webp"
            srcSet="/art/spot-flap-240.webp 240w, /art/spot-flap-480.webp 480w"
            sizes="(min-width: 900px) 290px, 180px"
            width="240" height="308"
            loading="lazy" decoding="async"
            alt=""
          />
          </div>

        </div>
      </section>

      {/* ---------------- the five beats ----------------
          Each beat is its own full-width band, paper and navy in turn, so each
          step of the night reads as its own (the maintainer, 2026-10-21: "cream, then
          dark blue, then cream"). Since his second look the same day ("a lot
          of open space ... put the screenshot in the middle and draw arrows to
          explain"), a beat is its time, headline and line, centred, with the
          capture under it and its parts named (AnnotatedShot), or, where the
          beat has no screen, a painted scene: above the words for the
          invitation, flying off under them for "Still in?". Flat grounds, no
          gradients and no shadows. Every capture on the site is the dark
          theme, the hero's own. #birdie and #money stay on the beats they
          always named, for old links. The notes, and the measured box of
          each thing they name, are in landingAnnotations.js. */}
      <section className="lp-sec lp-sec-paper lp-beat-band" aria-labelledby="lp-h-beat-1">
        <div className="lp-wrap">
          {/* The invitation: a wren holding the folded note while two
              sparrows lean in. */}
          <img
            className="lp-art lp-beat-scene is-invite"
            src="/art/step-start-480.webp"
            srcSet="/art/step-start-480.webp 480w, /art/step-start-960.webp 960w"
            sizes="min(400px, 84vw)"
            width="480" height="243"
            loading="lazy" decoding="async"
            alt=""
          />
          <div className="lp-beat">
            <p className="lp-beat-when">Thursday, 4:10 PM</p>
            <h3 id="lp-h-beat-1">the maintainer starts a flock.</h3>
            <p>
              Friday Night Crew, 8 o’clock, four friends invited. Anyone without
              the app joins from a link (budget too), no account needed.
            </p>
          </div>
        </div>
      </section>
      <section className="lp-sec lp-sec-navy lp-on-navy lp-beat-band" id="birdie" aria-labelledby="lp-h-beat-2">
        <div className="lp-wrap">
          <div className="lp-beat">
            <p className="lp-beat-when">Thursday, 6:30 PM</p>
            <h3 id="lp-h-beat-2">Three places go to a vote.</h3>
            <p>
              Nick asks Birdie for somewhere cheaper, the way you’d ask a friend
              who knows the city, and drops its pick in the chat.
            </p>
            {/* FTC AI disclosure, in the page's own voice where Birdie is
                marketed. MIRRORED in api/marketing-page.js PAGE_BLOCKS.home;
                aiCrawlerSurface.test.js requires the two to match. */}
            <p className="lp-beat-note">
              Birdie is AI. It runs on Google Gemini, and the crowd numbers it
              quotes are the app’s own.
            </p>
          </div>
          <AnnotatedShot id="vote" {...ANNOTATIONS.vote} />
        </div>
      </section>
      <section className="lp-sec lp-sec-paper lp-beat-band" id="money" aria-labelledby="lp-h-beat-3">
        <div className="lp-wrap">
          <div className="lp-beat">
            <p className="lp-beat-when">Friday, noon</p>
            <h3 id="lp-h-beat-3">The budgets come in privately.</h3>
            {/* budget.js publishes nothing until the budget settles (everyone
                going has answered with at least three members' amounts in, or
                the creator locks it once three have), and then a figure
                rounded down to a band so it is nobody's own number (bandCeiling). The
                vote and Discover then drop places priced over it
                (getMaxPriceLevel in ChatDetail.js and ExploreScreen.js). */}
            <p>
              Everyone types what they can spend. The group only ever sees one
              number, rounded down, and the places Flock suggests stay under it.
            </p>
            <p className="lp-beat-note">
              It appears when everyone going has answered or the creator locks
              it, and only once at least three members have shared an amount.
            </p>
          </div>
          <AnnotatedShot id="budget" {...ANNOTATIONS.budget} />
        </div>
      </section>
      <section className="lp-sec lp-sec-navy lp-on-navy lp-beat-band" aria-labelledby="lp-h-beat-4">
        <div className="lp-wrap">
          <div className="lp-beat">
            <p className="lp-beat-when">Friday, 7:15 PM</p>
            <h3 id="lp-h-beat-4">“Still in?”</h3>
            <p>
              Before the deadline, the chat asks who’s still in. All five say
              yes, and one last crowd check shows The Copper Finch filling up.
            </p>
          </div>
          {/* All five said yes, so the flock heads out together, flying off
              to the right under the words. Five beige sparrows and two wrens:
              on navy the wrens hold by their white breasts and the pale edges
              of their wings. */}
          <img
            className="lp-art lp-beat-scene is-flight"
            src="/art/step-go-480.webp"
            srcSet="/art/step-go-480.webp 480w, /art/step-go-960.webp 960w"
            sizes="min(520px, 90vw)"
            width="480" height="243"
            loading="lazy" decoding="async"
            alt=""
          />
        </div>
      </section>
      <section className="lp-sec lp-sec-paper lp-beat-band" aria-labelledby="lp-h-beat-5">
        <div className="lp-wrap">
          <div className="lp-beat">
            <p className="lp-beat-when">Saturday morning</p>
            <h3 id="lp-h-beat-5">Asad paid, so Flock splits it.</h3>
            <p>$142.60 with the tip comes to $28.52 each.</p>
          </div>
          <AnnotatedShot id="bill" {...ANNOTATIONS.bill} />
          <p className="lp-friday-more">
            Every step, and the two-minute pitch video, is on{' '}
            <a href="/how-it-works">How it works</a>.
          </p>
        </div>
      </section>

      {/* ---------------- safety ----------------
          What SOS does, in the order a person needs it, beside the two real
          things: the sheet the app shows and the email it sends. Every line
          below is checked against the code that does it:
            two taps, armed then sent                 EmergencySheet.js (4 s arm)
            email to the trusted contacts             routes/safety.js POST /alert
            in-app alert to a confirmed plan's people  SOS_FLOCK_WINDOW_HOURS = 12
            an update when a fix comes in later       updateKind 'location' | 'moved'
            "Tell them I'm OK", the all clear          POST /alert/cancel, safety_alert_cancelled
            Flock does not call 911                   the sheet's own line
          On the light stone band, where the watcher-bird painting reads. The
          email is set as a document, exactly the lines the backend sends
          (landingPageClaims.test.js checks each one), with no decoration. */}
      <section className="lp-sec lp-sec-sand" id="safety" aria-labelledby="lp-h-safety">
        <div className="lp-wrap lp-safety">
          <div className="lp-safety-head">
            <img
              className="lp-art lp-safety-art"
              src="/art/safety-360.webp"
              srcSet="/art/safety-360.webp 360w, /art/safety-720.webp 720w"
              sizes="(min-width: 900px) 260px, 220px"
              width="360" height="289"
              loading="lazy" decoding="async"
              alt=""
            />
            <h2 id="lp-h-safety">If something goes wrong, two taps tell your people where you are.</h2>
            <p className="lp-lead">
              Sharing your live location with the flock is optional, and off until
              you turn it on. SOS is separate. Here’s exactly what it does.
            </p>
          </div>
          <div className="lp-safety-body">
            <div className="lp-safety-facts">
              <div>
                <h3>Who hears</h3>
                <p>
                  Your trusted contacts, by email. Anyone on a confirmed plan with
                  you that starts within twelve hours either side gets an alert in
                  the app.
                </p>
              </div>
              <div>
                <h3>What they get</h3>
                <p>
                  Your name, the time, a map link if your phone has a fix, and how
                  accurate that fix is. A fix that comes in late follows as an update.
                </p>
              </div>
              <div>
                <h3>When you’re OK</h3>
                <p>
                  Tap “Tell them I’m OK” and everyone it reached gets the all clear.
                </p>
              </div>
              <div>
                <h3>What it won’t do</h3>
                <p>
                  Call 911 for you. That’s why it’s the first button on the sheet.
                </p>
              </div>
            </div>
            <ul className="lp-list lp-safety-rules">
              <li>No background tracking, ever</li>
              <li>Report and block on any message or profile</li>
            </ul>
          </div>
          {/* The sheet with its three buttons named, and beside it the email
              the second button sends. Share Location emails the same
              contacts your location alone (POST /api/safety/share-location). */}
          <div className="lp-safety-exhibits">
            <AnnotatedShot id="sos" {...ANNOTATIONS.sos} />
            {/* Excerpt of the real SOS email the backend sends, not a mock UI.
                Every line is copied from the template in routes/safety.js, and
                landingPageClaims.test.js checks each one against it. */}
            <div className="lp-sos-mail">
              <div className="lp-sos-meta">
                <span>From</span><span>Flock</span>
                <span>To</span><span>Your trusted contacts</span>
                <span>Subject</span><span>🚨 Emergency Alert from the maintainer</span>
              </div>
              <div className="lp-sos-body">
                <p className="lp-sos-headline">the maintainer needs help</p>
                <p className="lp-sos-intro">the maintainer has triggered an emergency alert on the Flock app and may need your assistance.</p>
                <p className="lp-sos-link">View Location on Map</p>
                <p className="lp-sos-fine">Accurate to about 15 m.</p>
                <p className="lp-sos-fine">You are one of 2 people the maintainer asked us to alert.</p>
              </div>
              <div className="lp-sos-foot">
                <p className="lp-sos-fine">Alert sent at 9/26/2026, 11:42:04 PM EDT</p>
                <p className="lp-sos-small">This is an automated safety alert from the Flock app. If this is an emergency, call your local emergency number. Replying to this message does not reach the maintainer.</p>
              </div>
              <p className="lp-sos-cap">The actual email, word for word.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- venues ----------------
          EVERY LINE WAS CHECKED AGAINST THE BACKEND. A free venue account:
          GET /incoming-flocks (flocks with the venue in their vote, seven days
          ahead), POST /promotions + GET /public-promotions/:placeId (deals on the
          card), events through GET /public-events/:placeId (verified venues
          only), and replies over public reviews. Roost, the venue plan, carries
          GET /intelligence and the advisor (requirePro); nothing is charged
          while VENUE_BILLING_ENABLED is off. There is no promoted placement and
          no slow-night push: do not add either until a route does it.
          Deals, like events, are served only for a verified venue
          (GET /public-promotions joins vp.verified = true).
          On navy since 2026-10-21 (the maintainer), one paragraph and one button; the
          rest of the venue offer is the venue column under Pricing. */}
      <section className="lp-sec lp-sec-navy lp-on-navy lp-venues" id="venues" aria-labelledby="lp-h-venues">
        <div className="lp-wrap lp-venues-in">
          <div className="lp-venues-copy">
            <h2 id="lp-h-venues">Run a bar or a restaurant?</h2>
            <p className="lp-lead">
              A free venue account shows which flocks have you in their vote this
              week. Once you’re verified, you can put a deal on your venue’s card
              while they decide.
            </p>
            <div className="lp-venues-actions">
              <a className="lp-btn lp-btn-cream" href={`mailto:${CONTACT_EMAIL}?subject=Flock%20for%20venues`}>
                Get in touch
              </a>
            </div>
          </div>
          {/* The dashboard with two of its parts named: Create Event, and
              the Flocks With You in Their Vote panel. Events show on the card
              only for a verified venue, and the note says so. */}
          <AnnotatedShot id="venue" {...ANNOTATIONS.venue} />
        </div>
      </section>

      {/* ---------------- pricing ----------------
          A rate sheet, not a SaaS table: free for the people planning, Pro only
          while it is really on sale (useProOffer), and the venue plan named
          for what it is. */}
      <section className="lp-sec lp-sec-sand" id="pricing" aria-labelledby="lp-h-pricing">
        <div className="lp-wrap">
          <div className="lp-pricing-head">
          <div>
          <h2 id="lp-h-pricing">Free for your friend group.</h2>
          <p className="lp-lead lp-pricing-lead">
            {proOffer
              ? 'Planning with your friends is free, with no ads. Flock Pro is optional, for whoever plans the most. Venues are where Flock will make its money, and none is being charged yet.'
              : 'You and your friends don’t pay, and there are no ads. Venues are where Flock will make its money, and none is being charged yet.'}
          </p>
          </div>
          <img
            className="lp-art lp-pricing-art"
            src="/art/spot-seed-240.webp"
            srcSet="/art/spot-seed-240.webp 240w, /art/spot-seed-480.webp 480w"
            sizes="160px"
            width="240" height="232"
            loading="lazy" decoding="async"
            alt=""
          />
          </div>

          <div className={proOffer ? 'lp-plans lp-plans-3' : 'lp-plans'}>
            <div className="lp-plan">
              <h3>Free</h3>
              <div className="lp-plan-price">$0<small>no card needed</small></div>
              <ul className="lp-list">
                <li>Unlimited flocks and friends</li>
                <li>Venue voting and group chat</li>
                {/* With Pro on sale the free tier is 30 venues a month
                    (services/forecastUsage.js); before that it is every venue.
                    "Before that" is the global switch, PAYWALL_ENABLED, and this
                    page speaks to the public, for whom it is the only switch.
                    The review list (PAYWALL_PREVIEW_USER_IDS) meters a few named
                    accounts, App Review's demo account among them, while the
                    switch is off; /api/pro-offer is asked without an account and answers for
                    the public, so this line changes only when the switch flips. */}
                <li>{proOffer ? 'Crowd levels for 30 venues a month' : 'Live crowd levels'}</li>
                <li>Budget matching and bill splitting</li>
                <li>SOS and trusted contacts</li>
              </ul>
              <a className="lp-btn lp-btn-navy" href="/signup">Create your account</a>
            </div>

            {proOffer && <ProOfferCard offer={proOffer} />}

            <div className="lp-plan">
              <h3>For venues</h3>
              <div className="lp-plan-price">Free account<small>Roost, the paid plan, is not on sale yet</small></div>
              <p className="lp-plan-note">Roost adds your own hour-by-hour forecast.</p>
              <ul className="lp-list">
                <li>See the flocks with you in their vote this week</li>
                <li>Put deals on your card once your venue is verified</li>
                <li>List your events there too, once verified</li>
                <li>Reply to reviews from people who went</li>
              </ul>
              <a className="lp-btn lp-btn-navy" href={`mailto:${CONTACT_EMAIL}?subject=Flock%20for%20venues`}>
                Email us
              </a>
              <p className="lp-venue-signin">
                Already have a venue account? <a href="/app?venue=true">Sign in</a>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- cta ---------------- */}
      <section className="lp-cta lp-on-navy" id="get" aria-labelledby="lp-h-get">
        <div className="lp-wrap lp-cta-in">
          <div>
            <h2 id="lp-h-get">Give the next plan a fighting chance.</h2>
            <p className="lp-lead" style={{ marginTop: 16 }}>
              Use Flock in your browser today, or leave your email to hear the
              moment the iPhone app is out.
            </p>
            <div className="lp-cta-row">
              <a className="lp-btn lp-btn-cream lp-btn-lg" href="/signup">Create your account</a>
            </div>
            <form className="lp-form" onSubmit={join}>
              <label className="lp-sr" htmlFor="lp-waitlist-email">Email address</label>
              <input
                id="lp-waitlist-email"
                ref={emailRef}
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@email.com"
                value={email}
                onChange={(e) => { setEmail(e.target.value); if (msgBad) setMsgBad(false); }}
                aria-invalid={msgBad ? 'true' : undefined}
                aria-describedby="lp-form-problem"
              />
              {/* aria-disabled, not disabled: `disabled` on the button you just
                  pressed hands focus to <body>. `join` returns early while busy. */}
              <button
                type="submit"
                className="lp-btn lp-btn-cream lp-btn-lg"
                aria-disabled={busy || undefined}
              >
                {busy ? 'Adding you…' : 'Join the waitlist'}
              </button>
            </form>
            {/* Both live regions stay mounted with empty text, and the wrapper
                holds one line open, so the first message neither goes
                unannounced nor pushes the band down under the reader's hands. */}
            <div className="lp-form-status">
              <p className="lp-form-msg" role="status">{msgBad ? '' : msg}</p>
              <p className="lp-form-msg lp-form-msg-bad" id="lp-form-problem" role="alert">
                {msgBad ? msg : ''}
              </p>
            </div>
          </div>
        </div>
      </section>
      </main>

      {/* ---------------- footer ----------------
          The shared SiteFooter, landing variant. The class stays lp-footer: the
          crawler-surface extraction excludes `footer.lp-footer` by that exact
          selector. pageInert is spread through so the footer goes inert behind
          the open menu. */}
      <SiteFooter
        variant="landing"
        className="lp-footer"
        brand={<a className="lp-brand" href="/"><Mark size={24} lazy /> Flock</a>}
        {...pageInert}
      />
    </div>
  );
}
