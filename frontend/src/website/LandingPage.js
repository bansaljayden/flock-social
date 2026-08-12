import React, { useEffect, useRef, useState } from 'react';
import './LandingPage.css';

const API = process.env.REACT_APP_API_URL || 'https://flock-app-production.up.railway.app';

// Flock's real App Store record (Apple ID 6781442127). The URL is already
// correct — it starts resolving the moment the app is approved. Flip
// APP_STORE_LIVE to true then, and the badge replaces the "in review" note.
// Don't flip it early: linking users at a 404 is worse than saying "soon".
const APP_STORE_URL = 'https://apps.apple.com/app/id6781442127';
const APP_STORE_LIVE = false;
const CONTACT_EMAIL = 'noreply.flockapp@gmail.com';

/* Inline stroke icons — one visual family, sized by the caller. */
const Ico = {
  vote: (c) => <svg viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>,
  crowd: (c) => <svg viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>,
  split: (c) => <svg viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>,
  pin: (c) => <svg viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></svg>,
  shield: (c) => <svg viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>,
  chat: (c) => <svg viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z" /></svg>,
  calendar: (c) => <svg viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>,
  bird: (c) => <svg viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M16 7h.01" /><path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20" /><path d="M20 7l2 .5-2 .5" /><path d="M10 18v3" /><path d="M14 17.75V21" /></svg>,
};

/* The Flock mark: three birds in flight, drawn so it stays crisp at any size. */
const Mark = ({ size = 26, color = '#f4efe3' }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true"
       stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 12.5c1.8-2.6 3.6-2.6 5.4 0 1.8-2.6 3.6-2.6 5.4 0" />
    <path d="M16.6 8.5c1.6-2.3 3.2-2.3 4.8 0 1.6-2.3 3.2-2.3 4.8 0" opacity="0.75" />
    <path d="M11.4 21c1.6-2.3 3.2-2.3 4.8 0 1.6-2.3 3.2-2.3 4.8 0" opacity="0.55" />
  </svg>
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
      aria-label={live ? 'Download Flock on the App Store' : 'Flock is coming to the App Store — join the waitlist'}
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

/* Reveal on scroll-in. The hidden state is applied ONLY after JS confirms it
   can animate (the .lp-anim root class), and a failsafe reveals everything
   after 1.4s — a section must never be able to ship blank. */
function useReveal() {
  const ref = useRef(null);
  // React owns the class — never toggled imperatively, or a re-render wipes it
  // and the section silently disappears.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined'
        || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setShown(true); io.disconnect(); } },
      { rootMargin: '0px 0px -10% 0px' }
    );
    io.observe(el);
    const failsafe = setTimeout(() => setShown(true), 1400);
    return () => { io.disconnect(); clearTimeout(failsafe); };
  }, []);
  return [ref, shown];
}

const Reveal = ({ as: Tag = 'div', className = '', children, ...rest }) => {
  const [ref, shown] = useReveal();
  return (
    <Tag ref={ref} className={`lp-reveal ${shown ? 'is-in' : ''} ${className}`} {...rest}>
      {children}
    </Tag>
  );
};

export default function LandingPage() {
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = 'Flock — Plans that actually happen';
    const d = document.querySelector('meta[name="description"]');
    if (d) d.setAttribute('content', 'Flock turns "we should hang out" into a real night out. Vote on where to go, see how busy it is before you leave, split the bill, and go.');

    // Opt in to reveal animations only once JS is running and motion is welcome.
    // Until this class exists, every section renders fully visible.
    if (typeof IntersectionObserver !== 'undefined'
        && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      document.documentElement.classList.add('lp-anim');
    }
    return () => document.documentElement.classList.remove('lp-anim');
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
      setMsg("You're on the list. We'll email you when it opens up.");
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
      <header className="lp-nav">
        <div className="lp-wrap lp-nav-in">
          <a className="lp-brand" href="/"><Mark /> Flock</a>
          <nav className="lp-nav-links">
            <a href="#how">How it works</a>
            <a href="#crowds">Crowd levels</a>
            <a href="#money">Money</a>
            <a href="#safety">Safety</a>
            <a href="#pricing">Pricing</a>
          </nav>
          <a className="lp-btn lp-btn-cream" href="/app">Open Flock</a>
        </div>
      </header>

      {/* ---------------- hero ---------------- */}
      <section className="lp-hero lp-on-navy">
        <div className="lp-hero-glow" aria-hidden="true" />
        <div className="lp-wrap lp-hero-in">
          <div>
            <span className="lp-badge"><b>1st Place</b> · PA DECA States</span>
            <h1>Plans die in the group chat.<br />Flock is where they happen.</h1>
            <p className="lp-lead">
              Start a flock, invite your people, vote on where to go, and see how busy
              it is before you leave. Everyone lands on the same plan — without the
              200-message thread.
            </p>
            <div className="lp-hero-cta">
              <a className="lp-btn lp-btn-cream lp-btn-lg" href="/signup">Create your account</a>
              <a className="lp-btn lp-btn-ghost lp-btn-lg" href="#how">See how it works</a>
            </div>
            <AppStoreBadge />
            <p className="lp-hero-note">
              Free to use. Works in your browser today.
            </p>
          </div>

          <Reveal className="lp-phone-wrap">
            {/* Real capture of the shipping app, not a mockup. */}
            <img
              className="lp-shot lp-shot-hero"
              src="/screenshots/app-nest.png"
              width="390" height="844"
              alt="The Flock home screen: tonight's status, your flocks, and a plan that needs votes."
            />
            <div className="lp-phone" hidden>
              <div className="lp-phone-screen">
                <div className="lp-ph-top">
                  <div>
                    <div className="lp-ph-hi">Who's free tonight?</div>
                    <div className="lp-ph-name">Friday Night Out</div>
                  </div>
                  <span className="lp-chip lp-chip-steel">4 in</span>
                </div>

                <div className="lp-ph-card">
                  <div className="lp-ph-card-row">
                    <div>
                      <div className="lp-ph-title">The Wooden Match</div>
                      <div className="lp-ph-sub">0.4 mi · $$ · closes 2 AM</div>
                    </div>
                    <span className="lp-chip lp-chip-quiet">Quiet now</span>
                  </div>
                  <div className="lp-ph-bar"><i style={{ width: '72%' }} /></div>
                  <div className="lp-ph-sub" style={{ marginTop: 8 }}>3 of 5 votes</div>
                </div>

                <div className="lp-ph-card">
                  <div className="lp-ph-card-row">
                    <div>
                      <div className="lp-ph-title">Porters Pub</div>
                      <div className="lp-ph-sub">1.1 mi · $$ · closes 1 AM</div>
                    </div>
                    <span className="lp-chip lp-chip-mid">Filling up</span>
                  </div>
                  <div className="lp-ph-bar"><i style={{ width: '34%' }} /></div>
                  <div className="lp-ph-sub" style={{ marginTop: 8 }}>2 of 5 votes</div>
                </div>

                <div className="lp-ph-foot">
                  <span>Budget matched · $25 ceiling</span>
                  <b>Lock it in</b>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------------- the turn ---------------- */}
      <section className="lp-sec lp-sec-paper">
        <div className="lp-wrap lp-turn-grid">
          <Reveal>
            <p className="lp-kicker">The problem</p>
            <h2 className="lp-turn">Everyone says yes. Nobody picks a place.</h2>
            <p className="lp-lead" style={{ marginTop: 18 }}>
              The plan doesn't fall apart because people don't want to go. It falls
              apart because deciding is annoying — and one person has to carry it.
            </p>
          </Reveal>

          <Reveal className="lp-chat">
            <div className="lp-msg">we should all hang out this weekend</div>
            <div className="lp-msg lp-msg-me">yesss I'm down</div>
            <div className="lp-msg">same, where tho</div>
            <div className="lp-msg lp-msg-me">idk what do you guys want</div>
            <div className="lp-msg">I'm good with anything</div>
            <div className="lp-msg lp-msg-dead">Seen by 6 · nobody went</div>
          </Reveal>
        </div>
      </section>

      {/* ---------------- how it works ---------------- */}
      <section className="lp-sec lp-sec-paper-2" id="how">
        <div className="lp-wrap">
          <Reveal>
            <p className="lp-kicker">How it works</p>
            <h2>Four steps, then you're out the door.</h2>
          </Reveal>
          <Reveal className="lp-steps">
            {[
              { n: '01', t: 'Start a flock', d: 'Name the night, pick a date, invite your people. They RSVP in one tap.' },
              { n: '02', t: 'Vote on where', d: 'Everyone throws in places. The group votes. No one has to be the decider.' },
              { n: '03', t: 'Match budgets', d: 'Everyone enters what they can spend — privately. Flock only shows the group ceiling.' },
              { n: '04', t: 'Lock it in', d: 'The plan confirms, everyone gets it, and the night is actually happening.' },
            ].map((s) => (
              <div className="lp-step" key={s.n}>
                <div className="lp-step-n">{s.n}</div>
                <h3>{s.t}</h3>
                <p>{s.d}</p>
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      {/* ---------------- crowd intelligence ---------------- */}
      <section className="lp-sec lp-sec-paper" id="crowds">
        <div className="lp-wrap lp-row">
          <Reveal>
            <p className="lp-kicker">Crowd levels</p>
            <h2>Know how busy it is before you leave.</h2>
            <p className="lp-lead">
              Flock forecasts how packed a place will be, hour by hour, so you don't
              drive across town to stand in a line. Live conditions, not guesswork.
            </p>
            <ul className="lp-list">
              <li><i className="lp-tick" />Hour-by-hour forecast for tonight</li>
              <li><i className="lp-tick" />The best time to show up</li>
              <li><i className="lp-tick" />Wait estimates for your group size</li>
              <li><i className="lp-tick" />A heads-up when your spot is about to peak</li>
            </ul>
          </Reveal>

          <Reveal className="lp-row-media">
            <img
              className="lp-shot"
              src="/screenshots/app-crowd.png"
              width="390" height="844"
              loading="lazy"
              alt="Venues near you with live crowd levels: 40% not busy, 46% moderate, plus a 12-hour forecast for each."
            />
            
          </Reveal>
        </div>
      </section>

      {/* ---------------- money ---------------- */}
      <section className="lp-sec lp-sec-paper-2" id="money">
        <div className="lp-wrap lp-row lp-row-flip">
          <Reveal>
            <p className="lp-kicker">Money</p>
            <h2>Money kills more plans than distance.</h2>
            <p className="lp-lead">
              Nobody wants to say "that's too expensive" in front of everyone. So Flock
              never makes them. Budgets go in privately — the group only ever sees the
              ceiling everyone can actually afford.
            </p>
            <ul className="lp-list">
              <li><i className="lp-tick" />Individual amounts are never shown to anyone</li>
              <li><i className="lp-tick" />Venue suggestions respect the group's real budget</li>
              <li><i className="lp-tick" />Split the bill and send Venmo, Cash App, or Zelle links</li>
            </ul>
          </Reveal>

          <Reveal className="lp-row-media">
            <div className="lp-split">
              <div className="lp-split-total"><span>Friday Night Out</span><b>$116.82</b></div>
              <div className="lp-split-row"><span>Jayden</span><b>$23.36</b></div>
              <div className="lp-split-row"><span>Sam</span><b>$23.36</b></div>
              <div className="lp-split-row"><span>Riley</span><b>$23.36</b></div>
              <div className="lp-split-row"><span>Jordan</span><b>$23.37</b></div>
              <div className="lp-split-row"><span>Alex</span><b>$23.37</b></div>
              <div className="lp-split-note">Group budget ceiling was $25 each. Nobody saw anyone else's number.</div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------------- everything else ---------------- */}
      <section className="lp-sec lp-sec-paper">
        <div className="lp-wrap">
          <Reveal>
            <p className="lp-kicker">In the app</p>
            <h2>Everything the night needs.</h2>
          </Reveal>
          <Reveal className="lp-grid">
            {[
              { i: Ico.vote, t: 'Venue voting', d: 'Put places up, vote, and watch the group converge without a single argument.' },
              { i: Ico.crowd, t: 'Live crowd levels', d: 'See how packed somewhere is right now and when it peaks tonight.' },
              { i: Ico.split, t: 'Budget matching', d: 'Private budgets in, one honest ceiling out. Then split the bill.' },
              { i: Ico.chat, t: 'Group chat that plans', d: 'Chat, venue cards, and votes in one place instead of five apps.' },
              { i: Ico.calendar, t: 'Plans calendar', d: 'Everything you said yes to, in one place, so nothing gets double-booked.' },
              { i: Ico.bird, t: 'Birdie', d: 'Ask for somewhere quiet, cheap, and close — get real answers, not a search box.' },
            ].map((f) => (
              <div className="lp-card" key={f.t}>
                <span className="lp-card-ico">{f.i('#2d5a87')}</span>
                <h3>{f.t}</h3>
                <p>{f.d}</p>
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      {/* ---------------- safety ---------------- */}
      <section className="lp-sec lp-sec-navy lp-on-navy" id="safety">
        <div className="lp-wrap lp-row">
          <Reveal>
            <p className="lp-kicker">Safety</p>
            <h2>Getting home matters as much as getting out.</h2>
            <p className="lp-lead">
              Share your live location with your group while the night is on — and
              only while it's on. If something goes wrong, one button tells the people
              you picked where you are.
            </p>
            <ul className="lp-list">
              <li><i className="lp-tick" />One-tap SOS to your trusted contacts</li>
              <li><i className="lp-tick" />Live location inside the flock, off by default</li>
              <li><i className="lp-tick" />Never tracked in the background. Ever.</li>
              <li><i className="lp-tick" />Report and block on any message or profile</li>
            </ul>
          </Reveal>
          <Reveal className="lp-row-media">
            <div className="lp-safety">
              <span className="lp-safety-ico">{Ico.shield('#6d9ac3')}</span>
              <div className="lp-safety-title">Trusted contacts notified</div>
              <div className="lp-safety-sub">Location shared · 11:42 PM</div>
              <div className="lp-safety-row"><span>{Ico.pin('#98937f')}</span> 41 W Broad St, Bethlehem</div>
              <div className="lp-safety-row"><span>{Ico.crowd('#98937f')}</span> 2 contacts reached</div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------------- pricing ---------------- */}
      <section className="lp-sec lp-sec-paper-2" id="pricing">
        <div className="lp-wrap">
          <Reveal>
            <p className="lp-kicker">Pricing</p>
            <h2>Free for your friend group.</h2>
            <p className="lp-lead" style={{ marginTop: 16 }}>
              Planning a night out shouldn't cost anything, so it doesn't. Venues
              pay to reach groups who are deciding where to go right now.
            </p>
          </Reveal>

          <Reveal className="lp-plans">
            <div className="lp-plan">
              <h3>Free</h3>
              <div className="lp-plan-price">$0<small>forever</small></div>
              <p className="lp-plan-note">Everything you need to plan and go.</p>
              <ul className="lp-list">
                <li><i className="lp-tick" />Unlimited flocks and friends</li>
                <li><i className="lp-tick" />Venue voting and group chat</li>
                <li><i className="lp-tick" />Live crowd levels</li>
                <li><i className="lp-tick" />Budget matching and bill splitting</li>
                <li><i className="lp-tick" />SOS and trusted contacts</li>
              </ul>
              <a className="lp-btn lp-btn-navy" href="/signup">Create your account</a>
            </div>

            <div className="lp-plan lp-plan-venue">
              <h3>For venues</h3>
              <div className="lp-plan-price">Let's talk<small>bars, clubs, restaurants</small></div>
              <p className="lp-plan-note">
                Reach groups at the moment they're picking a place — not after they've gone somewhere else.
              </p>
              <ul className="lp-list">
                <li><i className="lp-tick" />Show up in venue voting near you</li>
                <li><i className="lp-tick" />Post deals and events to nearby groups</li>
                <li><i className="lp-tick" />See demand: how many groups considered you</li>
                <li><i className="lp-tick" />Fill slow nights with targeted offers</li>
              </ul>
              <a className="lp-btn lp-btn-navy" href={`mailto:${CONTACT_EMAIL}?subject=Flock%20for%20venues`}>
                Get in touch
              </a>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------------- cta ---------------- */}
      <section className="lp-cta lp-on-navy" id="get">
        <div className="lp-wrap lp-cta-in">
          <Reveal>
            <h2>Your group's next plan shouldn't die in a thread.</h2>
            <p className="lp-lead" style={{ marginTop: 16 }}>
              Open Flock in your browser, or leave your email and we'll tell you the
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
          </Reveal>
        </div>
      </section>

      {/* ---------------- footer ---------------- */}
      <footer className="lp-footer">
        <div className="lp-wrap">
          <div className="lp-footer-grid">
            <div>
              <a className="lp-brand" href="/"><Mark size={24} /> Flock</a>
              <p className="lp-footer-blurb">
                The app that turns "we should hang out" into an actual night out.
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
            <span>Made in Bethlehem, PA</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
