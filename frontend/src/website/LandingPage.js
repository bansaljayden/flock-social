import React, { Suspense, useEffect, useRef, useState } from 'react';
import './LandingPage.css';
import BirdieBird, { WARM_BIRD } from '../components/ui/BirdieBird';
import SiteFooter from './SiteFooter';
import frauncesUrl from '../fonts/Fraunces-var.woff2';

/* The live demo is code-split, and this is load-bearing rather than tidiness.
   LiveDemo pulls in maplibre-gl, which webpack emits as a 1.06 MB chunk. As a
   static import it landed in this page's chunk GROUP, and React.lazy does not
   resolve until every chunk in the group has arrived — so the marketing page
   rendered nothing at all until a map engine nobody has scrolled to yet had
   finished downloading. Measured before the split: first contentful paint of
   the hero waited on 1.3 MB of JavaScript; the map then opened six requests to
   api.maptiler.com at 411 ms, while the reader was still on the headline.
   Split out and mounted on approach, the hero's critical path is ~280 KB and
   the map does not touch the network until you are within a screen of it. */
const LiveDemo = React.lazy(() => import('./LiveDemo'));

const API = process.env.REACT_APP_API_URL || 'https://flock-app-production.up.railway.app';

/* Fraunces sets the h1, which is this page's largest contentful element. Left
   to itself the browser does not discover the face until layout runs, i.e.
   after the chunk has downloaded, parsed and rendered: measured at 378 ms
   against a 48 ms first paint. Asking for it the moment this module evaluates
   moves the request ahead of React's first commit. `crossorigin` is not
   optional — fonts are fetched in CORS mode even same-origin, and a preload
   without it is a second, wasted download rather than a hit. */
if (typeof document !== 'undefined' && !document.querySelector('link[data-lp-font]')) {
  const l = document.createElement('link');
  l.rel = 'preload';
  l.as = 'font';
  l.type = 'font/woff2';
  l.href = frauncesUrl;
  l.crossOrigin = 'anonymous';
  l.setAttribute('data-lp-font', '');
  document.head.appendChild(l);
}

// Flock's real App Store record (Apple ID 6781442127). The URL is already
// correct: it starts resolving the moment the app is approved. Flip
// APP_STORE_LIVE to true then, and the badge replaces the "in review" note.
// Don't flip it early: linking users at a 404 is worse than saying "soon".
const APP_STORE_URL = 'https://apps.apple.com/app/id6781442127';
const APP_STORE_LIVE = false;
// Inbound mail: Cloudflare Email Routing forwards this to Jayden's Gmail
// (set up 2026-08-12). Outbound stays on Resend.
const CONTACT_EMAIL = 'social@flockcorp.com';

/* Every destination in the page menu. Same six sections the header used to
   list inline, all of which exist on this page. */
const NAV_LINKS = [
  { href: '#how', label: 'How it works' },
  { href: '#try', label: 'Try it live' },
  { href: '#birdie', label: 'Birdie' },
  { href: '#money', label: 'Money' },
  { href: '#safety', label: 'Safety' },
  { href: '#pricing', label: 'Pricing' },
];

/* The Flock mark: the actual logo (same asset as the app icon), not a
   hand-drawn stand-in. */
const Mark = ({ size = 32, lazy = false }) => (
  <img
    src="/logo192.png"
    width={size} height={size}
    alt=""
    aria-hidden="true"
    {...(lazy ? { loading: 'lazy', fetchPriority: 'low' } : {})}
    style={{ borderRadius: '50%', display: 'block' }}
  />
);

/* The App Store badge is always on the page. Before Apple approves the app it
   points at the waitlist and says so, rather than sending people to a 404;
   after approval (APP_STORE_LIVE = true) it becomes the real download link. */
/* WCAG 2.5.3 (Label in Name): the accessible name has to CONTAIN the visible
   one, in order, or speech input cannot address the control. This badge reads
   "Coming soon to the App Store" / "Download on the App Store" on screen, and
   the labels were "Flock is coming to the App Store. Join the waitlist." and
   "Download Flock on the App Store". Neither contained its own visible string:
   one drops "soon", the other inserts "Flock" mid-phrase. So "click download
   on the App Store" matched nothing at all. The visible text leads now, and
   the extra context follows it. */
const AppStoreBadge = () => {
  const live = APP_STORE_LIVE;
  return (
    <a
      className={`lp-appstore ${live ? '' : 'is-soon'}`}
      href={live ? APP_STORE_URL : '#get'}
      {...(live ? { target: '_blank', rel: 'noreferrer' } : {})}
      aria-label={live
        ? 'Download on the App Store'
        : 'Coming soon to the App Store. Join the waitlist.'}
    >
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M17.05 12.54c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.72-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.87-.76-1.48.02-2.84.86-3.6 2.18-1.53 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.24 2.74 2.2 1.1-.05 1.52-.71 2.85-.71 1.33 0 1.7.71 2.87.69 1.18-.02 1.93-1.07 2.65-2.13.84-1.22 1.18-2.4 1.2-2.46-.03-.01-2.28-.88-2.3-3.48zM14.9 5.6c.6-.74 1.01-1.76.9-2.78-.87.04-1.93.58-2.56 1.31-.56.65-1.05 1.69-.92 2.68.97.08 1.97-.49 2.58-1.21z" />
      </svg>
      {/* The explicit space matters: the <span> is display:grid, so these are
          two rows on screen and read as "Coming soon to the App Store", but
          without it textContent concatenates to "...to theApp Store". That is
          what an accessible-name comparison and any text-extraction tool sees. */}
      <span>
        <small>{live ? 'Download on the' : 'Coming soon to the'}</small>{' '}
        App Store
      </span>
    </a>
  );
};

/* No scroll-reveal animation on this page, deliberately. Sections sliding in
   from the bottom as you scroll is the most recognizable AI-built-site tell
   (SLOP-AUDIT.md A10), and the content is better off just being there. */

/* Holds a below-the-fold thing's space and only mounts it once you are within
   a screen of it. This is NOT a reveal: nothing fades, nothing moves, and the
   box is the same size before and after, so the page does not shift. It exists
   because two things here are expensive at load and useless at the top of the
   page — the live demo's map engine, and the two photographed birds, whose
   four cutout PNGs (89.9 KB) were being fetched at t=87 ms, inside the window
   the hero needs.

   The reservation matters as much as the gating: mounting something into an
   unreserved box IS a layout shift, which is the thing lazy-loading is usually
   trying to avoid. Every caller below passes the real box.

   No IntersectionObserver (old Safari, and any prerender) means render now. A
   visitor on a browser without it gets the old behaviour, not a blank page. */
function WhenNear({ margin = '700px', className, hold, children }) {
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

    /* Tab is the other way in, and without this the gating quietly costs a
       keyboard user the demo. Tabbing jumps focus between focusable elements,
       and an unmounted subtree has none, so measured on the gated build the
       forward tab order ran hero badge -> pricing button and stepped straight
       over the live demo's search field and buttons. The browser only scrolls
       once focus lands, by which point it has already gone past. A first Tab
       press is a reliable signal that this visitor navigates by keyboard, so
       they get the whole page from that moment. Nobody using a mouse or a
       thumb ever pays for it. */
    const onKey = (e) => { if (e.key === 'Tab') setNear(true); };
    window.addEventListener('keydown', onKey);

    return () => {
      io.disconnect();
      window.removeEventListener('keydown', onKey);
    };
  }, [near, margin]);

  return (
    <div ref={ref} className={className} style={hold}>
      {near ? children : null}
    </div>
  );
}

export default function LandingPage() {
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState('');
  // Both outcomes used to land in one role="status" paragraph, so a failure
  // was announced politely (queued behind whatever was being read) and looked
  // identical to a success: same 14px, same --cream-2, no marker on the field.
  // Kind splits them into a polite region and an assertive one, and drives
  // aria-invalid on the input.
  const [msgBad, setMsgBad] = useState(false);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const menuBtnRef = useRef(null);
  const wasMenuOpen = useRef(false);

  // While the panel is open: page scroll is locked, Escape closes, and Tab
  // cycles inside the panel (the corner block is part of that cycle, since it
  // is the close button).
  useEffect(() => {
    if (!menuOpen) return undefined;
    const panel = menuRef.current;
    const btn = menuBtnRef.current;
    if (!panel) return undefined;

    // Locking scroll removes the scrollbar, which would otherwise shove the
    // corner block sideways at the moment you click it. Hold its width.
    const bar = window.innerWidth - document.documentElement.clientWidth;
    const prevOverflow = document.body.style.overflow;
    const prevPad = document.body.style.paddingRight;
    document.body.style.overflow = 'hidden';
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
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPad;
      document.body.style.removeProperty('--lp-scrollbar');
    };
  }, [menuOpen]);

  // Closing hands focus back to the block that opened it.
  useEffect(() => {
    if (wasMenuOpen.current && !menuOpen && menuBtnRef.current) {
      menuBtnRef.current.focus();
    }
    wasMenuOpen.current = menuOpen;
  }, [menuOpen]);

  useEffect(() => {
    document.title = 'Flock | Plans that actually happen';
    const d = document.querySelector('meta[name="description"]');
    if (d) d.setAttribute('content', 'Flock turns “we should hang out” into a real night out. Vote on where to go, see how busy it is before you leave, split the bill, and go.');
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
      const res = await fetch(`${API}/api/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      // Same register fix as the lead above: the confirmation says what the
      // reader gets, not who is sending it.
      setMsg("You’re on the list. You’ll get an email when it opens up.");
      setMsgBad(false);
      setEmail('');
    } catch (err) {
      setMsg(err.message || 'Could not sign you up. Try again in a moment.');
      setMsgBad(true);
    } finally {
      setBusy(false);
    }
  };

  /* While the panel is open the rest of the document is inert. The visual
     modal was already right — scroll locked, Escape closes, Tab cycles inside
     the panel — but none of that reaches a screen reader's virtual cursor,
     which walks the DOM and does not care where the browser thinks focus is.
     Measured with the panel open in NVDA: down-arrow read straight past the
     six menu links into "Plans die in the group chat", the whole hero, and the
     footer, none of which was on screen. aria-modal is not the tool here (the
     close control is the corner block, which lives OUTSIDE the panel, and
     aria-modal would hide it); marking the page behind it inert is.

     `inert: true` and not `inert: ''` — React 19 treats an empty string on a
     boolean attribute as FALSE and warns, so the spread is conditional and the
     value is a real boolean. */
  const pageInert = menuOpen ? { inert: true } : {};

  return (
    <div className="lp">
      {/* First focusable thing in the document. The page is ~7 screens of
          content behind a sticky bar, and without this the only way past the
          header on a keyboard was to Tab through it every time. */}
      <a className="lp-skip" href="#lp-main">Skip to the main content</a>

      {/* ---------------- nav ---------------- */}
      <header className={`lp-nav${menuOpen ? ' is-menu-open' : ''}`}>
        <div className="lp-wrap lp-nav-in">
          <a className="lp-brand" href="/"><Mark /> Flock</a>
        </div>
        {/* One navigation affordance at every width: the corner block. The
            inline link row used to vanish under 860px, which meant phones had
            no menu at all. */}
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
            <span className="lp-menu-bar" />
          </span>
        </button>
      </header>

      {/* ---------------- menu panel ---------------- */}
      <div
        id="lp-menu"
        ref={menuRef}
        className={`lp-menu${menuOpen ? ' is-open' : ''}`}
      >
        {/* Deliberately not aria-modal: the close control is the corner block
            in the header, which sits outside this element, and aria-modal
            would hide it from screen readers. Escape and the focus trap give
            the modal behaviour instead. */}
        <nav className="lp-menu-in" aria-label="Site menu">
          {NAV_LINKS.map((l, i) => (
            <a
              key={l.href}
              className={`lp-menu-link${i === NAV_LINKS.length - 1 ? ' is-last' : ''}`}
              href={l.href}
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

      {/* The page had NO main landmark: <header>, a pile of unnamed <section>s
          and <footer>. An unnamed <section> is exposed as a generic container,
          not a region, so "jump to main content" had nothing to jump to and
          the landmark rotor listed two entries for an entire marketing site. */}
      <main id="lp-main" tabIndex={-1} {...pageInert}>

      {/* ---------------- hero ----------------
          The headline spans the full measure and the rest of the fold hangs
          under it: two sentences at 72px need ~900px to sit on two lines, and
          in a half-width column they broke into four ragged ones. The phone is
          a plate in the right margin with a caption, which is the field guide's
          own device and the honest way to say the screenshot is real. */}
      <section className="lp-hero lp-on-navy" aria-labelledby="lp-h-hero">
        <div className="lp-wrap lp-hero-in">
          {/* "they happen." is held together: text-wrap balance, pretty and
              auto all break this sentence 4+1 at phone widths and leave
              "happen." alone on line four. */}
          <h1 id="lp-h-hero">Plans die in the group chat.<br />Flock is where <span className="lp-keep">they happen.</span></h1>
          <hr className="lp-hero-rule" aria-hidden="true" />

          <div className="lp-hero-copy">
            <p className="lp-lead">
              Start a flock, invite your people, and vote on where to go. Everyone
              ends up on the same plan without the 200-message thread.
            </p>
            <div className="lp-hero-cta">
              <a className="lp-btn lp-btn-cream lp-btn-lg" href="/signup">Create your account</a>
              <a className="lp-btn lp-btn-ghost lp-btn-lg" href="#how">See how it works</a>
            </div>
            {/* The badge sits AFTER the note, not between the buttons and it.
                Pre-approval it is the one thing on the fold you cannot actually
                do, and stacked directly under the two real actions it made a
                phone read as three competing boxes with the Apple logo — the
                most eye-catching of the three — on the only one that goes
                nowhere. Actions, then the reason to believe them, then the
                channel that isn't open yet. */}
            <p className="lp-hero-note">
              Free, and it runs in your browser right now, so there’s nothing to
              download. Flock took 1st place at PA DECA States.
            </p>
            <AppStoreBadge />
          </div>

          <figure className="lp-phone-wrap">
            {/* Real capture of the shipping app, not a mockup. */}
            {/* WebP first, PNG fallback. Format choice cannot ride on srcSet:
                srcset entries carry only density and width descriptors, so
                there is nowhere to say "this one is WebP" and a browser that
                cannot decode it would still pick it and show a broken image.
                <source type> is the only mechanism that gates on format, and a
                browser that does not support the type skips the source and
                falls through to the <img> untouched. The <img> below is
                verbatim what shipped before this wrapper existed: same src,
                same intrinsic width/height, same priority hint, same alt. It
                is still the element the CSS styles and the only element that
                renders.

                Every KB figure in these five comments is bytes ON THE WIRE,
                measured off the built page at 1.6 Mbps rather than read off
                the filesystem, so it includes response headers. This one:
                224.7 KB of PNG against 29.1 KB of WebP, same 390x844 pixels.
                See the `picture` rule in LandingPage.css for what the wrapper
                does and, more usefully, what it does not do. */}
            <picture>
              <source type="image/webp" srcSet="/screenshots/nest-dark@2x.webp" />
              <img
                className="lp-shot lp-shot-hero"
                src="/screenshots/nest-dark@2x.png"
                width="390" height="844"
                fetchPriority="high"
                alt="The Flock home screen: tonight's status, your flocks, and a plan that needs votes."
              />
            </picture>
            <figcaption className="lp-plate-cap">
              The Nest, top of screen. Who is in tonight, and which plans still
              need votes.
            </figcaption>
          </figure>
        </div>
      </section>

      {/* ---------------- the turn ----------------
          No kicker here: "The problem" above a headline that states the problem
          is a label narrating its own sentence. */}
      <section className="lp-sec lp-sec-paper" aria-labelledby="lp-h-turn">
        <div className="lp-wrap lp-turn-grid">
          <div>
            <h2 className="lp-turn" id="lp-h-turn">Six people say yes. Then the chat goes quiet.</h2>
            <p className="lp-lead" style={{ marginTop: 18 }}>
              The plan doesn’t fall apart because people don’t want to go. It falls
              apart because deciding is annoying, and one person always ends up
              carrying it.
            </p>
          </div>

          <div className="lp-chat">
            <div className="lp-msg">we should all hang out this weekend</div>
            <div className="lp-msg lp-msg-me">yesss I'm down</div>
            <div className="lp-msg">same, where tho</div>
            <div className="lp-msg lp-msg-me">idk what do you guys want</div>
            <div className="lp-msg">I'm good with anything</div>
            <div className="lp-msg lp-msg-dead">Seen by 6 · nobody went</div>
          </div>
        </div>
      </section>

      {/* ---------------- how it works ---------------- */}
      <section className="lp-sec lp-sec-paper lp-sec-ruled" id="how" aria-labelledby="lp-h-how">
        <div className="lp-wrap">
          <div>
            {/* Two birds already on the wire and a third flying in: the plans
                mark. It used to sit on the navy Safety section, where it was
                the wrong subject and needed a CSS invert to be visible at all.
                This is the section it actually describes. */}
            {/* The -400 assets alone. They are 864-1024px wide against slots
                that never render past 520 CSS px, so they already carry 2x
                density everywhere. The old "2x" srcSet entries were the 2-8MB
                master files, and every retina phone downloaded all three of
                them (~15MB) for images this size. Do not re-add them. */}
            {/* fetchPriority low on all three section marks. They are
                decorative (alt=""), they are below the fold, and `loading=lazy`
                alone does not stop them competing: the browser's lazy threshold
                is generous, so mark-steps (124.7 KB) was already being fetched
                at 396 ms, inside the hero's window. Lazy decides WHEN, priority
                decides what it is allowed to slow down. */}
            {/* WebP first (see the hero for why this is <picture> and not
                srcSet). This mark's PNG is a palette image with a tRNS chunk,
                so it is transparent, and mark-steps-400.webp is VP8X with an
                ALPH chunk, which is the only WebP shape that keeps alpha under
                lossy compression. Verified rather than assumed: a plain "VP8 "
                WebP has no alpha channel at all and would have painted a solid
                box over the cream. 121.7 KB of PNG, 76.5 KB of WebP. */}
            <figure className="lp-flock lp-flock-steps">
              <picture>
                <source type="image/webp" srcSet="/marks/mark-steps-400.webp" />
                <img src="/marks/mark-steps-400.png" alt="" width="864" height="290" loading="lazy" decoding="async" fetchPriority="low" />
              </picture>
            </figure>
            {/* The "How it works" kicker was cut. An eyebrow is an ordinal
                device, and this section already has the strongest ordinal
                device on the page directly underneath it: a band numbered 01 to
                04. A label saying "How it works" above four numbered steps is
                narrating what the numbers already say. Two eyebrows survive on
                the page (Crowd levels, Safety) and they are the two whose
                headline never states the subject as a noun. */}
            <h2 id="lp-h-how">Four steps, then you’re out the door.</h2>
          </div>
          <div className="lp-steps">
            {[
              { n: '01', t: 'Start a flock', d: 'Name the night, pick a date, invite your people. They RSVP in one tap.' },
              { n: '02', t: 'Vote on where', d: 'Everyone throws in places. The group votes. No one has to be the decider.' },
              { n: '03', t: 'Match budgets', d: "Everyone types in what they can spend. The group only ever sees the ceiling, never anyone’s number." },
              { n: '04', t: 'Lock it in', d: "The plan locks, everyone gets the details, and you’re going out." },
            ].map((s) => (
              <div className="lp-step" key={s.n}>
                <div className="lp-step-n">{s.n}</div>
                <h3>{s.t}</h3>
                <p>{s.d}</p>
              </div>
            ))}
          </div>
          {/* The two features the cut "In the app" grid actually added, as one
              line under the thing they belong to. */}
          <p className="lp-steps-after">
            The chat, the venue cards and the votes all live in the flock, and
            everything you say yes to lands on one calendar.
          </p>
        </div>
      </section>

      {/* ---------------- crowds, and the proof ----------------
          These used to be two sections in a row: a claim about crowd levels
          illustrated with a screenshot, then the same claim again with a real
          working map under it. The screenshot version was strictly the weaker
          one and it came first, so the page argued before it proved. One
          section now, and it is navy: the demo is showing you tonight, and
          tonight is what navy means on this page. It also breaks what was
          otherwise a run of seven cream sections down the middle.

          Both old anchors survive — #crowds on the section, #try on the demo —
          so the footer link and the menu link each land somewhere sensible. */}
      <section className="lp-sec lp-sec-navy lp-on-navy" id="crowds" aria-labelledby="lp-h-crowds">
        <div className="lp-wrap">
          <div className="lp-demo-head">
            <div>
              {/* Transparent PNG, and the WebP is VP8X + ALPH, so the cutout
                  survives. This one has to keep its alpha more than the others
                  do: it sits on the navy section, where an opaque cream or
                  white ground would be unmissable. 300.6 KB PNG, 129.7 KB WebP. */}
              <figure className="lp-flock lp-flock-crowd">
                <picture>
                  <source type="image/webp" srcSet="/marks/mark-crowd-400.webp" />
                  <img src="/marks/mark-crowd-400.png" alt="" width="1024" height="498" loading="lazy" decoding="async" fetchPriority="low" />
                </picture>
              </figure>
              <p className="lp-kicker">Crowd levels</p>
              <h2 id="lp-h-crowds">Know how busy it is before you leave.</h2>
              <p className="lp-lead">
                Flock reads the hour, the weather, and how busy a place usually
                runs, then estimates how packed it will be tonight. You stop
                driving across town to stand in a line.
              </p>
            </div>
            <ul className="lp-list">
              <li>An hour-by-hour read on tonight</li>
              <li>The best time to show up</li>
              <li>Every spot near you, scored the same way</li>
            </ul>
          </div>

          {/* The training figures are the most checkable thing this site owns,
              and until now they only existed on /about, which is the page
              nobody reads. They belong here, one line above the demo that is
              about to run the model in front of you: "everything below is live"
              is an assertion, and 1.9 million observations across 30 cities is
              the reason to believe it.

              Both numbers are read straight out of
              backend/scripts/ml/models/model_metadata.json (training_rows
              1,934,988 and 30 entries in training_cities) and are pinned
              against that file in landingPageClaims.test.js, the same way
              AboutPage's five figures are pinned. If the model is retrained and
              the corpus changes, that test goes red and this sentence gets
              corrected rather than quietly becoming a lie. "venue-hour
              observations" is the unit /about uses; do not round it into
              "hours" or "venues", which are different quantities. */}
          <p className="lp-demo-proof" id="try">
            Everything below is live. The map, the pins, and the numbers come
            from the same model that ships inside Flock, trained on 1.9 million
            venue-hour observations across 30 cities. Pick a pin.
          </p>
          {/* 800px of lead: the demo is loading and drawing before it reaches
              the screen, so arriving here still feels like it was always
              there. The holder is the demo's own height, so nothing shifts
              when it mounts, and #try above still lands in the right place. */}
          <WhenNear className="lpd-hold" margin="800px">
            <Suspense fallback={null}><LiveDemo /></Suspense>
          </WhenNear>
        </div>
      </section>

      {/* ---------------- birdie ----------------
          Was .lp-row, i.e. media-left / text-right at half and half — which is
          the identical composition to the Money section two screens down. The
          two of them read as the same panel with different nouns in it. This is
          .lp-birdie now: the phone sits as a 300px plate in the right margin,
          the way the hero treats the same asset, and the text runs at a reading
          measure rather than filling half a page. Text first in the DOM, so a
          phone gets the heading before the screenshot instead of after it. */}
      <section className="lp-sec lp-sec-paper" id="birdie" aria-labelledby="lp-h-birdie">
        <div className="lp-wrap lp-birdie">
          <div>
            {/* The character himself, not a linocut plate of him. This is the
                one section where the mascot IS the subject, so he stands in
                the text column and follows the reader's cursor. Sized by
                aspect ratio so he can never push the column wide on a phone.
                (The idle mp4 is unused here: its ground is white and this
                section is cream, so the cutout PNG is the honest asset.) */}
            <WhenNear
              hold={{
                width: 'clamp(112px, 13vw, 168px)',
                aspectRatio: '316 / 400',
                margin: '0 0 16px',
              }}
            >
              <BirdieBird size={150} style={{ width: '100%', height: '100%' }} />
            </WhenNear>
            <h2 id="lp-h-birdie">“Idk, you pick.” Birdie picks.</h2>
            {/* Was "The argument is always the same one: where." — which is the
                FOURTH time this page says deciding where is hard, after the
                hero lead, the whole chat-goes-quiet section, and step 02. The
                h2 above already carries that setup in two words. This lead now
                advances the argument instead of restating it, and it hands off
                from the crowd section directly above rather than resetting. */}
            {/* Three claims checked against backend/routes/ai.js and the AI
                chat in App.js, because two of them were not true:

                "Every pick is scored by the crowd model before it reaches you"
                described a pipeline that does not exist. search_venues returns
                Google Places results with no score; the crowd number arrives
                only when Birdie calls get_crowd_prediction, which it does when
                it is relevant, not on every result.

                "or start the plan" claimed a third button. A Birdie venue card
                ships exactly two: Details, and Share to a flock or a DM.

                What IS true and is the better line anyway: the crowd numbers
                Birdie quotes are the app's own, and its hard rules forbid it
                from inventing one. */}
            <p className="lp-lead">
              Ask Birdie the way you’d ask a friend who knows the city. It comes
              back with real places near you, not a list it made up.
            </p>
            {/* FTC AI disclosure. The line above sells Birdie as a friend who
                knows the city, which is the framing the FTC treats as
                deceptive when the thing is software and the page never says
                so. The privacy policy already names Google Gemini; this is
                the same fact where the product is actually marketed, in the
                page's own voice rather than a footnote. It also carries the
                model attribution for the crowd numbers, so the claim sits
                next to the thing that produces it.
                Second .lp-lead in a row and `.lp :where(p)` zeroes every
                paragraph margin, so the gap is set here: LandingPage.css is
                owned elsewhere this pass and one inline value beats an
                unreviewed rule.
                MIRRORED in frontend/api/marketing-page.js PAGE_BLOCKS.home,
                immediately after the paragraph above. aiCrawlerSurface.test.js
                requires the two to match block for block. */}
            <p className="lp-lead" style={{ marginTop: 14 }}>
              Birdie is AI. It runs on Google Gemini, and the crowd numbers it
              quotes are the app’s own.
            </p>
            <ul className="lp-list">
              {/* No trailing periods, which is what every other list on this
                  page does. This one was the exception. */}
              <li>Ask in plain words. “Where’s poppin rn” works</li>
              <li>Crowd numbers come from the same model as the map above</li>
              <li>Tap a card for the details, or send it straight to your flock</li>
            </ul>
          </div>

          <div className="lp-row-media">
            {/* Real capture of the shipping app, not a mockup. WebP first, PNG
                fallback, and the <img> is byte-for-byte the one that shipped
                before, loading="lazy" included. 298.2 KB PNG, 53.7 KB WebP. */}
            <picture>
              <source type="image/webp" srcSet="/screenshots/birdie-dark@2x.webp" />
              <img
                className="lp-shot"
                src="/screenshots/birdie-dark@2x.png"
                width="390" height="844"
                loading="lazy"
                alt="Birdie answering 'Where's poppin in Philadelphia rn?' with a recommendation and venue cards."
              />
            </picture>
          </div>
        </div>
      </section>

      {/* ---------------- money ----------------
          The old headline was "Money kills more plans than distance", the third
          plans-die construction on one page after the hero and Birdie. The
          section's best line was buried in the lead; it is the headline now. */}
      <section className="lp-sec lp-sec-paper lp-sec-ruled" id="money" aria-labelledby="lp-h-money">
        <div className="lp-wrap lp-row lp-row-flip">
          <div>
            {/* The one mark whose WebP is a plain "VP8 " chunk with no ALPH,
                i.e. no alpha channel. That is correct here and only here:
                mark-money-400.png is a palette PNG with NO tRNS chunk, so the
                PNG is opaque too and the two are equivalent. Do not copy this
                pattern to the other two marks, whose PNGs are transparent. If
                this asset is ever regenerated as a cutout, the WebP has to be
                re-encoded as VP8X+ALPH or it will paint a box on the cream.
                424.6 KB PNG, 57.3 KB WebP, the biggest single win on the page. */}
            <figure className="lp-flock lp-flock-money">
              <picture>
                <source type="image/webp" srcSet="/marks/mark-money-400.webp" />
                <img src="/marks/mark-money-400.png" alt="" width="1024" height="1024" loading="lazy" decoding="async" fetchPriority="low" />
              </picture>
            </figure>
            <h2 id="lp-h-money">Nobody wants to say “that’s too expensive” out loud.</h2>
            <p className="lp-lead">
              In Flock nobody has to. Everyone types a number privately, and the
              group only ever sees a ceiling that works for all of them.
            </p>
            {/* "Nobody ever sees an individual amount" was cut: the lead
                directly above already says exactly that, so the section opened
                by restating itself. What replaced it is the part of the rule
                nobody would invent, and it is the one that actually proves the
                privacy claim: budget.js returns a null ceiling until three
                people have submitted, precisely so a group of two cannot read
                one person's number off the ceiling. */}
            <ul className="lp-list">
              <li>The ceiling stays hidden until three people have put a number in</li>
              <li>Venue picks stay under the group’s ceiling</li>
              <li>Split the bill and send Venmo, Cash App, or Zelle links</li>
            </ul>
          </div>

          <div className="lp-row-media">
            <div className="lp-split">
              <div className="lp-split-total"><span>Friday Night Out</span><b>$116.82</b></div>
              <div className="lp-split-row"><span>Jayden</span><b>$23.36</b></div>
              <div className="lp-split-row"><span>Sam</span><b>$23.36</b></div>
              <div className="lp-split-row"><span>Riley</span><b>$23.36</b></div>
              <div className="lp-split-row"><span>Jordan</span><b>$23.37</b></div>
              <div className="lp-split-row"><span>Alex</span><b>$23.37</b></div>
              <div className="lp-split-note">Group budget ceiling was $25 each. Nobody saw anyone else’s number.</div>
            </div>
          </div>
        </div>
      </section>

      {/* The "In the app" section was cut here. It was a six-card grid, and
          four of the six cards (venue voting, live crowd levels, budget
          matching, Birdie) were a fourth restatement of sections this page had
          already given a full spread each. The other two, group chat and the
          plans calendar, are now a single line at the end of the steps rather
          than a section of their own. A page that says the same six things four
          times is not thorough, it is unsure. */}

      {/* ---------------- safety ----------------
          The third .lp-row in a row was this one, and three identical panels is
          where a page stops reading as composed. It is two tiers now instead of
          two columns: the statement sits beside the real email, and the four
          rules run across the full width underneath as a 2x2 ruled block. The
          rules are the section's actual promise, so they get the width rather
          than being a sidebar to it, and the shape belongs to this section
          alone. */}
      <section className="lp-sec lp-sec-navy lp-on-navy" id="safety" aria-labelledby="lp-h-safety">
        <div className="lp-wrap lp-safety">
          <div>
            {/* No plate here on purpose. The marks are navy ink with no dark
                variant, and the SOS email beside this column is already the
                section's visual. */}
            <p className="lp-kicker">Safety</p>
            <h2 id="lp-h-safety">Getting home matters as much as getting out.</h2>
            <p className="lp-lead">
              Share your live location with your group while the night is on, and
              only while it’s on. If something goes wrong, one button tells the
              people you picked where you are.
            </p>
          </div>
          <div className="lp-row-media">
            {/* Excerpt of the real SOS email the backend sends — not a mock UI */}
            <div className="lp-sos-mail">
              <div className="lp-sos-meta">
                <span>To</span><span>Your trusted contacts</span>
                <span>Subject</span><span>Emergency Alert from Jordan</span>
              </div>
              <div className="lp-sos-body">
                <p className="lp-sos-headline">Jordan needs help</p>
                <p className="lp-sos-link">View location on map</p>
                <p className="lp-sos-fine">Sent 11:42 PM, exact coordinates included</p>
              </div>
              <p className="lp-sos-cap">The actual email. It goes out the moment you tap SOS.</p>
            </div>
          </div>

          <ul className="lp-list lp-safety-rules">
            <li>One-tap SOS to your trusted contacts</li>
            <li>Live location inside the flock, off by default</li>
            <li>No background tracking, ever</li>
            <li>Report and block on any message or profile</li>
          </ul>
        </div>
      </section>

      {/* ---------------- pricing ---------------- */}
      <section className="lp-sec lp-sec-paper" id="pricing" aria-labelledby="lp-h-pricing">
        <div className="lp-wrap">
          <div>
            {/* The only place on the page where both birds appear together,
                and the one section whose subject is a group rather than a
                feature. They each watch the cursor on their own, so they
                never move in lockstep the way a two-up graphic would. */}
            <WhenNear className="lp-pair">
              <BirdieBird bird={WARM_BIRD} size={112} style={{ width: 'clamp(84px, 9vw, 112px)', height: 'auto', aspectRatio: '332 / 333' }} />
              <BirdieBird size={128} style={{ width: 'clamp(92px, 10vw, 128px)', height: 'auto', aspectRatio: '316 / 400' }} />
            </WhenNear>
            {/* The "Pricing" kicker was cut for the same reason as "How it
                works": the section below it is two plan cards, one of which
                reads "$0", so nothing here was in any doubt about being the
                pricing. */}
            <h2 id="lp-h-pricing">Free for your friend group.</h2>
            {/* This line survived the first sweep of the venue card below it and
                should not have — it is the SAME promoted-placement pitch, one
                paragraph higher and in the present tense. "Venues pay to show
                up in front of groups that are picking a place right now" is two
                untrue things at once: nothing in the repo can put a venue in
                front of a group that is voting, and no venue has ever been
                charged anything. There is no `stripe` dependency in
                backend/package.json, VENUE_BILLING_ENABLED is unset on Railway,
                and the only writer of venue_profiles.tier is an admin comp
                route. The founder dashboard already had to be corrected to say
                this out loud; the homepage was still saying the opposite.

                The replacement is the honest version of the same reassurance,
                which is a better sentence anyway: the reader's question is "so
                what's the catch", and "nobody is paying yet" answers it more
                convincingly than a revenue model would. Caught by screenshot,
                not by grep — the phrasing dodged every pattern written for the
                card below. */}
            <p className="lp-lead" style={{ marginTop: 16 }}>
              You and your friends don’t pay. Venues are the side Flock is built
              to charge, and none of them is being charged yet.
            </p>
          </div>

          <div className="lp-plans">
            <div className="lp-plan">
              <h3>Free</h3>
              <div className="lp-plan-price">$0<small>no card needed</small></div>
              <p className="lp-plan-note">Plan the night and split the bill without paying us anything.</p>
              <ul className="lp-list">
                <li>Unlimited flocks and friends</li>
                <li>Venue voting and group chat</li>
                <li>Live crowd levels</li>
                <li>Budget matching and bill splitting</li>
                <li>SOS and trusted contacts</li>
              </ul>
              <a className="lp-btn lp-btn-navy" href="/signup">Create your account</a>
            </div>

            <div className="lp-plan lp-plan-venue">
              <h3>For venues</h3>
              <div className="lp-plan-price">Let’s talk<small>bars, clubs, restaurants</small></div>
              {/* EVERY LINE IN THIS CARD WAS RE-CHECKED AGAINST THE BACKEND on
                  2026-08-14, because the card ends in a sales mailto and a
                  venue reading it is being asked to start a conversation on the
                  strength of it. Three claims were selling things that do not
                  exist, and `.claude/CLAUDE.md` lists all three under "Not
                  built":

                  "Reach groups at the exact moment they're picking a place" and
                  "Show up in venue voting near you" are both promoted placement
                  in vote lists. There is no promoted placement. Vote rows come
                  from Google Places in plain distance order; nothing in the
                  repo can move a venue up one.

                  "Put an offer up on a slow night" is the slow-night push
                  offer. There is no code that pushes anything to a group
                  because a venue is quiet.

                  "Post deals and events to nearby groups" was half true and the
                  false half was the important one. Promotions really do reach
                  users — POST /api/venue-dashboard/promotions writes them and
                  GET /public-promotions/:placeId is read by the venue detail
                  screen in App.js. EVENTS DO NOT: there is no public-events
                  route at all, so a venue event is visible to the owner who
                  typed it and to nobody else. And neither one is delivered "to
                  nearby groups" — both sit on the venue's own card, waiting to
                  be opened.

                  What is below ships today, with the route behind each one:
                    GET /incoming-flocks   the flocks that chose this venue
                    POST /promotions + GET /public-promotions/:placeId
                    POST /reviews/:id/reply, over public reviews on the card
                    GET /intelligence      the owner's own forecast + demand curve

                  This is the fifth time this page has had to delete a claim
                  nothing implemented. Before adding a line here, find the route
                  that answers it and the screen that renders it. */}
              <p className="lp-plan-note">
                A dashboard for your door: who picked you tonight, how the week
                ahead looks, and a card inside the app that you write.
              </p>
              <ul className="lp-list">
                <li>See the flocks that chose you</li>
                <li>Put a deal on your venue’s card, where groups open it</li>
                <li>Reply to reviews from people who went</li>
                <li>Your own hour-by-hour forecast, from the model the app runs</li>
              </ul>
              <a className="lp-btn lp-btn-navy" href={`mailto:${CONTACT_EMAIL}?subject=Flock%20for%20venues`}>
                Get in touch
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- cta ---------------- */}
      <section className="lp-cta lp-on-navy" id="get" aria-labelledby="lp-h-get">
        <div className="lp-wrap lp-cta-in">
          <div>
            <h2 id="lp-h-get">Give the next plan a fighting chance.</h2>
            {/* "we'll tell you" became "you'll hear". Flock is one student, and
                /about says so in the first paragraph; a corporate we on the
                homepage and a solo founder on the about page is a register
                mismatch a reader can catch in two clicks. The rewrite is not a
                swap to "I" either — the waitlist mail is sent by a cron and a
                template, so nobody is telling anyone anything. Saying what
                happens to the reader is both truer and the better sentence. */}
            <p className="lp-lead" style={{ marginTop: 16 }}>
              Open Flock in your browser, or leave your email and you’ll hear the
              moment the iPhone app is out.
            </p>
            <div className="lp-cta-row">
              <a className="lp-btn lp-btn-cream lp-btn-lg" href="/signup">Create your account</a>
              <a className="lp-btn lp-btn-ghost lp-btn-lg" href="/app">Log in</a>
            </div>
            <form className="lp-form" onSubmit={join}>
              {/* A real <label>, not an aria-label. Same accessible name, but
                  it also makes the field's own text a click target and it is
                  the one form of naming that voice control ("click email
                  address") and machine translation both handle. Visually
                  hidden because the field is a single-purpose one in a CTA
                  band, where a printed label would be noise. */}
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
              {/* aria-disabled, not disabled. `disabled` on the button you just
                  pressed hands focus to <body>, so a keyboard user loses their
                  place on every submit. `join` already returns early while
                  busy, so the double submit is guarded in the handler. */}
              <button
                type="submit"
                className="lp-btn lp-btn-cream lp-btn-lg"
                aria-disabled={busy || undefined}
              >
                {busy ? 'Adding you…' : 'Join the waitlist'}
              </button>
            </form>
            {/* Both stay mounted with empty text: a live region has to exist
                before its content changes or the first announcement is missed.
                Same pattern as the guest invite page.

                The wrapper is not decoration. Both children collapse to zero
                height while empty, which is what keeps the pair one line tall
                once one of them fills — but at rest that meant BOTH were zero,
                so the first failed submit inserted a line and pushed the whole
                CTA band down under the reader's hands. The wrapper holds one
                line of space open from the start. It is a plain div, carries no
                role, and sits outside both live regions, so nothing about the
                announcements changes. */}
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

      {/* ---------------- footer ---------------- */}
      {/* The shared SiteFooter, landing variant: same grid, blurb and base
          line as the hand-rolled footer it replaced, with the Company column
          now built from the same LEGAL_LINKS array the legal pages render
          (plus the one real mailbox, which this footer previously lacked).
          The brand cell is passed in because Mark is this file's local
          component; pageInert is spread through so the whole footer still
          goes inert behind the open menu. The class stays lp-footer: the
          crawler-surface extraction excludes `footer.lp-footer` by that exact
          selector, and the a11y contrast pins name its tokens. */}
      <SiteFooter
        variant="landing"
        className="lp-footer"
        brand={<a className="lp-brand" href="/"><Mark size={24} lazy /> Flock</a>}
        {...pageInert}
      />
    </div>
  );
}
