import React, { useEffect, useRef, useState } from 'react';
import './LandingPage.css';
import LiveDemo from './LiveDemo';
import BirdieBird, { WARM_BIRD } from '../components/ui/BirdieBird';
import { Icons } from '../components/ui/Icons';

const API = process.env.REACT_APP_API_URL || 'https://flock-app-production.up.railway.app';

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
const Mark = ({ size = 32 }) => (
  <img
    src="/logo192.png"
    width={size} height={size}
    alt=""
    aria-hidden="true"
    style={{ borderRadius: '50%', display: 'block' }}
  />
);

/* The App Store badge is always on the page. Before Apple approves the app it
   points at the waitlist and says so, rather than sending people to a 404;
   after approval (APP_STORE_LIVE = true) it becomes the real download link. */
const AppStoreBadge = () => {
  const live = APP_STORE_LIVE;
  return (
    <a
      className={`lp-appstore ${live ? '' : 'is-soon'}`}
      href={live ? APP_STORE_URL : '#get'}
      {...(live ? { target: '_blank', rel: 'noreferrer' } : {})}
      aria-label={live ? 'Download Flock on the App Store' : 'Flock is coming to the App Store. Join the waitlist.'}
    >
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M17.05 12.54c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.72-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.87-.76-1.48.02-2.84.86-3.6 2.18-1.53 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.24 2.74 2.2 1.1-.05 1.52-.71 2.85-.71 1.33 0 1.7.71 2.87.69 1.18-.02 1.93-1.07 2.65-2.13.84-1.22 1.18-2.4 1.2-2.46-.03-.01-2.28-.88-2.3-3.48zM14.9 5.6c.6-.74 1.01-1.76.9-2.78-.87.04-1.93.58-2.56 1.31-.56.65-1.05 1.69-.92 2.68.97.08 1.97-.49 2.58-1.21z" />
      </svg>
      <span>
        <small>{live ? 'Download on the' : 'Coming soon to the'}</small>
        App Store
      </span>
    </a>
  );
};

/* No scroll-reveal animation on this page, deliberately. Sections sliding in
   from the bottom as you scroll is the most recognizable AI-built-site tell
   (SLOP-AUDIT.md A10), and the content is better off just being there. */

export default function LandingPage() {
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
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
    if (!value) { setMsg('Enter your email first.'); return; }
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`${API}/api/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      setMsg("You’re on the list. We’ll email you when it opens up.");
      setEmail('');
    } catch (err) {
      setMsg(err.message || 'Could not sign you up. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lp">
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

      {/* ---------------- hero ----------------
          The headline spans the full measure and the rest of the fold hangs
          under it: two sentences at 72px need ~900px to sit on two lines, and
          in a half-width column they broke into four ragged ones. The phone is
          a plate in the right margin with a caption, which is the field guide's
          own device and the honest way to say the screenshot is real. */}
      <section className="lp-hero lp-on-navy">
        <div className="lp-wrap lp-hero-in">
          {/* "they happen." is held together: text-wrap balance, pretty and
              auto all break this sentence 4+1 at phone widths and leave
              "happen." alone on line four. */}
          <h1>Plans die in the group chat.<br />Flock is where <span className="lp-keep">they happen.</span></h1>
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
            <AppStoreBadge />
            <p className="lp-hero-note">
              Free, and it runs in your browser right now. It won 1st place at PA
              DECA States.
            </p>
          </div>

          <figure className="lp-phone-wrap">
            {/* Real capture of the shipping app, not a mockup. */}
            <img
              className="lp-shot lp-shot-hero"
              src="/screenshots/app-nest.png"
              width="390" height="844"
              alt="The Flock home screen: tonight's status, your flocks, and a plan that needs votes."
            />
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
      <section className="lp-sec lp-sec-paper">
        <div className="lp-wrap lp-turn-grid">
          <div>
            <h2 className="lp-turn">Six people say yes. Then the chat goes quiet.</h2>
            <p className="lp-lead" style={{ marginTop: 18 }}>
              The plan doesn’t fall apart because people don't want to go. It falls
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
      <section className="lp-sec lp-sec-paper lp-sec-ruled" id="how">
        <div className="lp-wrap">
          <div>
            {/* Two birds already on the wire and a third flying in: the plans
                mark. It used to sit on the navy Safety section, where it was
                the wrong subject and needed a CSS invert to be visible at all.
                This is the section it actually describes. */}
            <span className="lp-mark" aria-hidden="true">{Icons.calendar('currentColor', 64)}</span>
            <p className="lp-kicker">How it works</p>
            <h2>Four steps, then you’re out the door.</h2>
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
      <section className="lp-sec lp-sec-navy lp-on-navy" id="crowds">
        <div className="lp-wrap">
          <div className="lp-demo-head">
            <div>
              <p className="lp-kicker">Crowd levels</p>
              <h2>Know how busy it is before you leave.</h2>
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

          <p className="lp-demo-proof" id="try">
            Everything below is live. The map, the pins, and the numbers come
            from the same model that ships inside Flock. Pick a pin.
          </p>
          <LiveDemo />
        </div>
      </section>

      {/* ---------------- birdie ---------------- */}
      <section className="lp-sec lp-sec-paper" id="birdie">
        <div className="lp-wrap lp-row">
          <div className="lp-row-media">
            {/* Real capture of the shipping app, not a mockup. */}
            <img
              className="lp-shot"
              src="/screenshots/app-birdie.png"
              width="390" height="844"
              loading="lazy"
              alt="Birdie answering 'Where's poppin in Philadelphia rn?' with a recommendation and venue cards."
            />
          </div>
          <div>
            {/* The character himself, not a linocut plate of him. This is the
                one section where the mascot IS the subject, so he stands in
                the text column and follows the reader's cursor. Sized by
                aspect ratio so he can never push the column wide on a phone.
                (The idle mp4 is unused here: its ground is white and this
                section is cream, so the cutout PNG is the honest asset.) */}
            <BirdieBird
              size={150}
              style={{
                width: 'clamp(112px, 13vw, 168px)',
                height: 'auto',
                aspectRatio: '316 / 400',
                margin: '0 0 16px',
              }}
            />
            <h2>“Idk, you pick.” Birdie picks.</h2>
            <p className="lp-lead">
              The argument is always the same one: where. Ask Birdie the way you’d
              ask a friend who knows the city, and it answers with tonight’s crowd
              numbers already checked.
            </p>
            <ul className="lp-list">
              <li>Ask in plain words. “Where’s poppin rn” works.</li>
              <li>Every pick is scored by the crowd model before it reaches you.</li>
              <li>Tap a card to see details, share it to the group, or start the plan.</li>
            </ul>
          </div>
        </div>
      </section>

      {/* ---------------- money ----------------
          The old headline was "Money kills more plans than distance", the third
          plans-die construction on one page after the hero and Birdie. The
          section's best line was buried in the lead; it is the headline now. */}
      <section className="lp-sec lp-sec-paper lp-sec-ruled" id="money">
        <div className="lp-wrap lp-row lp-row-flip">
          <div>
            <span className="lp-mark" aria-hidden="true">{Icons.dollar('currentColor', 64)}</span>
            <h2>Nobody wants to say “that’s too expensive” out loud.</h2>
            <p className="lp-lead">
              In Flock nobody has to. Everyone types a number privately, and the
              group only ever sees a ceiling that works for all of them.
            </p>
            <ul className="lp-list">
              <li>Nobody ever sees an individual amount</li>
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

      {/* ---------------- safety ---------------- */}
      <section className="lp-sec lp-sec-navy lp-on-navy" id="safety">
        <div className="lp-wrap lp-row">
          <div>
            {/* No plate here on purpose. The marks are navy ink with no dark
                variant, and the SOS email beside this column is already the
                section's visual. */}
            <p className="lp-kicker">Safety</p>
            <h2>Getting home matters as much as getting out.</h2>
            <p className="lp-lead">
              Share your live location with your group while the night is on, and
              only while it’s on. If something goes wrong, one button tells the
              people you picked where you are.
            </p>
            <ul className="lp-list">
              <li>One-tap SOS to your trusted contacts</li>
              <li>Live location inside the flock, off by default</li>
              <li>No background tracking, ever</li>
              <li>Report and block on any message or profile</li>
            </ul>
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
        </div>
      </section>

      {/* ---------------- pricing ---------------- */}
      <section className="lp-sec lp-sec-paper" id="pricing">
        <div className="lp-wrap">
          <div>
            {/* The only place on the page where both birds appear together,
                and the one section whose subject is a group rather than a
                feature. They each watch the cursor on their own, so they
                never move in lockstep the way a two-up graphic would. */}
            <div className="lp-pair">
              <BirdieBird bird={WARM_BIRD} size={112} style={{ width: 'clamp(84px, 9vw, 112px)', height: 'auto', aspectRatio: '332 / 333' }} />
              <BirdieBird size={128} style={{ width: 'clamp(92px, 10vw, 128px)', height: 'auto', aspectRatio: '316 / 400' }} />
            </div>
            <p className="lp-kicker">Pricing</p>
            <h2>Free for your friend group.</h2>
            <p className="lp-lead" style={{ marginTop: 16 }}>
              You and your friends don’t pay. Venues pay to show up in front of
              groups that are picking a place right now.
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
              <p className="lp-plan-note">
                Reach groups at the exact moment they’re picking a place, before they
                end up somewhere else.
              </p>
              {/* "See how many groups considered you" was cut: the venue
                  analytics tab it described was deleted from the product on
                  2026-08-12, and the page cannot sell a screen that no longer
                  exists. */}
              <ul className="lp-list">
                <li>Show up in venue voting near you</li>
                <li>Post deals and events to nearby groups</li>
                <li>Put an offer up on a slow night</li>
              </ul>
              <a className="lp-btn lp-btn-navy" href={`mailto:${CONTACT_EMAIL}?subject=Flock%20for%20venues`}>
                Get in touch
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- cta ---------------- */}
      <section className="lp-cta lp-on-navy" id="get">
        <div className="lp-wrap lp-cta-in">
          <div>
            <h2>Give the next plan a fighting chance.</h2>
            <p className="lp-lead" style={{ marginTop: 16 }}>
              Open Flock in your browser, or leave your email and we’ll tell you the
              moment the iPhone app is out.
            </p>
            <div className="lp-cta-row">
              <a className="lp-btn lp-btn-cream lp-btn-lg" href="/signup">Create your account</a>
              <a className="lp-btn lp-btn-ghost lp-btn-lg" href="/app">Log in</a>
            </div>
            <form className="lp-form" onSubmit={join}>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@email.com"
                aria-label="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button type="submit" className="lp-btn lp-btn-cream lp-btn-lg" disabled={busy}>
                {busy ? 'Adding you…' : 'Join the waitlist'}
              </button>
            </form>
            <p className="lp-form-msg" role="status">{msg}</p>
          </div>
        </div>
      </section>

      {/* ---------------- footer ---------------- */}
      <footer className="lp-footer">
        <div className="lp-wrap">
          <div className="lp-footer-grid">
            <div>
              <a className="lp-brand" href="/"><Mark size={24} /> Flock</a>
              <p className="lp-footer-blurb">
                The app that turns “we should hang out” into an actual night out.
              </p>
            </div>
            <div>
              <h4>Product</h4>
              <ul>
                <li><a href="/signup">Create an account</a></li>
                <li><a href="/app">Log in</a></li>
                <li><a href="#how">How it works</a></li>
                <li><a href="#crowds">Crowd levels</a></li>
                <li><a href="#safety">Safety</a></li>
              </ul>
            </div>
            <div>
              <h4>Company</h4>
              <ul>
                <li><a href="/about">About</a></li>
                <li><a href="/support">Support</a></li>
                <li><a href="/privacy">Privacy Policy</a></li>
                <li><a href="/terms">Terms of Service</a></li>
                <li><a href="/guidelines">Community Guidelines</a></li>
                <li><a href="/delete-account">Delete your account</a></li>
              </ul>
            </div>
          </div>
          <div className="lp-footer-base">
            <span>© {new Date().getFullYear()} Flock Corp.</span>
            <span>Made by Jayden Bansal</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
