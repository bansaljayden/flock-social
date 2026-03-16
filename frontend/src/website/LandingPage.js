import React, { useState, useEffect, useRef, useCallback, useMemo, Suspense, lazy } from 'react';
import './LandingPage.css';

const Spline = lazy(() => import('@splinetool/react-spline'));

/* ─── Scroll Reveal Hook ─── */
function useScrollReveal() {
  useEffect(() => {
    // Small delay to ensure DOM is painted before observing
    const timer = setTimeout(() => {
      const obs = new IntersectionObserver(
        (entries) => entries.forEach((e) => {
          if (e.isIntersecting) { e.target.classList.add('lp-visible'); obs.unobserve(e.target); }
        }),
        { threshold: 0.08 }
      );
      document.querySelectorAll('.lp-reveal').forEach((el) => obs.observe(el));
      return () => obs.disconnect();
    }, 100);
    return () => clearTimeout(timer);
  }, []);
}

/* ─── Parallax Hook ─── */
function useParallax(refs, factors) {
  useEffect(() => {
    let raf;
    const onScroll = () => {
      raf = requestAnimationFrame(() => {
        const y = window.scrollY;
        refs.forEach((r, i) => {
          if (r.current) r.current.style.transform = `translateY(${y * factors[i]}px)`;
        });
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
  }, [refs, factors]);
}

/* ─── Bird Logo ─── */
function BirdLogo({ size = 28, color = '#f5f0e8' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill={color}>
      <path d="M38 18c-3-5-9-8-15-6 4-1 8 0 11 3-2-2-5-4-9-3 5-2 10 0 13 6z" />
      <path d="M48 10c-3-5-9-8-15-6 4-1 8 0 11 3-2-2-5-4-9-3 5-2 10 0 13 6z" />
      <path d="M28 28c-3-5-9-8-15-6 4-1 8 0 11 3-2-2-5-4-9-3 5-2 10 0 13 6z" />
    </svg>
  );
}

/* ─── Icons ─── */
function IcoCheck({ size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 8.5l3 3 7-7.5" /></svg>;
}
function IcoPin({ size = 22 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" /></svg>;
}
function IcoLock({ size = 22 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" /></svg>;
}
function IcoChat({ size = 22 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" /></svg>;
}
function IcoNav({ size = 22 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z" /></svg>;
}
function IcoShieldFill({ size = 22 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z" /></svg>;
}
function IcoStar({ size = 22 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" /></svg>;
}

/* ─── CountUp ─── */
function CountUp({ target, prefix = '', suffix = '' }) {
  const ref = useRef(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !done.current) {
        done.current = true;
        const dur = 1500, start = performance.now();
        const step = (now) => {
          const t = Math.min((now - start) / dur, 1);
          const ease = 1 - Math.pow(1 - t, 3);
          el.textContent = prefix + Math.floor(ease * target).toLocaleString() + suffix;
          if (t < 1) requestAnimationFrame(step);
          else el.textContent = prefix + target.toLocaleString() + suffix;
        };
        requestAnimationFrame(step);
        obs.unobserve(el);
      }
    }, { threshold: 0.5 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [target, prefix, suffix]);
  return <span ref={ref}>0</span>;
}

/* ─── StarField ─── */
function StarField() {
  const stars = useMemo(() =>
    Array.from({ length: 40 }, (_, i) => ({
      id: i,
      top: `${Math.random() * 100}%`,
      left: `${Math.random() * 100}%`,
      delay: `${Math.random() * 7}s`,
      dur: `${3 + Math.random() * 4}s`,
    })), []);
  return <>
    {stars.map((s) => (
      <div key={s.id} className="lp-star" style={{
        top: s.top, left: s.left,
        animation: `twinkle ${s.dur} ease-in-out ${s.delay} infinite`,
      }} />
    ))}
  </>;
}

/* ─── How It Works Step Cards ─── */
const HOW_STEPS = [
  { num: '01', eye: 'STEP 1 OF 5', title: 'Create a Flock', desc: 'Name it, set a vibe, pick a date range. Takes 10 seconds.' },
  { num: '02', eye: 'STEP 2 OF 5', title: 'Invite Your Friends', desc: 'Share via QR code or link. Friends RSVP going, maybe, or can\'t make it.' },
  { num: '03', eye: 'STEP 3 OF 5', title: 'Submit Your Budget', desc: 'Everyone enters their max privately. Nobody sees anyone else\'s number. The app does the math.' },
  { num: '04', eye: 'STEP 4 OF 5', title: 'Vote on Venues', desc: 'Only spots that work for everyone\'s budget appear. Group votes. Highest votes wins.' },
  { num: '05', eye: 'STEP 5 OF 5', title: 'Go', desc: 'Flock confirmed. Everyone gets the details. You actually go.' },
];

/* ─── Venue Dashboard ─── */
function VenueDashboard() {
  const bars = [28, 42, 65, 38, 55, 72, 88];
  const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  return (
    <div className="lp-venue-dash">
      <div className="lp-dash-title">Taphouse 42 — Dashboard</div>
      <div className="lp-dash-sub">Last 30 days</div>
      <div className="lp-dash-metrics">
        <div className="lp-dash-metric"><span className="lp-dash-metric-label">Groups viewed</span><span className="lp-dash-metric-val">47<span className="lp-dash-metric-up"> +12%</span></span></div>
        <div className="lp-dash-metric"><span className="lp-dash-metric-label">Chose Taphouse</span><span className="lp-dash-metric-val">12<span className="lp-dash-metric-up"> +8%</span></span></div>
        <div className="lp-dash-metric"><span className="lp-dash-metric-label">Conversion</span><span className="lp-dash-metric-val">25.5%<span className="lp-dash-metric-up"> vs 14.2% avg</span></span></div>
      </div>
      <div className="lp-dash-bars">
        {bars.map((h, i) => (
          <div key={i} className={`lp-dash-bar${i === 6 ? ' lp-dash-bar--today' : ''}`} style={{ height: `${h}%` }} />
        ))}
      </div>
      <div className="lp-dash-days">{days.map((d, i) => <span key={i} className="lp-dash-day">{d}</span>)}</div>
    </div>
  );
}

/* ═══════════ MAIN COMPONENT ═══════════ */

export default function LandingPage() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [waitlistMsg, setWaitlistMsg] = useState('');
  const [annual, setAnnual] = useState(false);

  const counterRef = useRef(null);
  const orb1 = useRef(null);
  const orb2 = useRef(null);
  const orb3 = useRef(null);

  const orbRefs = useMemo(() => [orb1, orb2, orb3], []);
  const orbFactors = useMemo(() => [-0.15, -0.1, -0.05], []);

  useScrollReveal();
  useParallax(orbRefs, orbFactors);

  /* Nav scroll */
  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 60);
    window.addEventListener('scroll', fn, { passive: true });
    return () => window.removeEventListener('scroll', fn);
  }, []);

  /* Title */
  useEffect(() => { document.title = 'Flock \u2014 Social Coordination Simplified'; }, []);

  /* Live counter */
  useEffect(() => {
    let count = 2847;
    const el = counterRef.current;
    if (!el) return;
    el.textContent = count.toLocaleString();
    const id = setInterval(() => {
      count += Math.floor(Math.random() * 8) + 1;
      el.textContent = count.toLocaleString();
      el.classList.add('pulse');
      setTimeout(() => el.classList.remove('pulse'), 300);
    }, 3000 + Math.random() * 2000);
    return () => clearInterval(id);
  }, []);


  const scrollTo = useCallback((id) => {
    setMenuOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const handleWaitlist = async (e) => {
    e.preventDefault();
    if (!email) return;
    try {
      const API = process.env.REACT_APP_API_URL || 'https://flock-app-production.up.railway.app';
      const res = await fetch(`${API}/api/waitlist`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (res.ok) { setSubmitted(true); setWaitlistMsg(data.message || "You're on the list."); setEmail(''); }
      else setWaitlistMsg(data.error || 'Something went wrong.');
    } catch {
      const list = JSON.parse(localStorage.getItem('flock_waitlist') || '[]');
      list.push({ email, ts: Date.now() });
      localStorage.setItem('flock_waitlist', JSON.stringify(list));
      setSubmitted(true); setWaitlistMsg("You're on the list."); setEmail('');
    }
  };

  const FEATURES = [
    { title: 'Venue Voting', desc: 'Everyone votes on spots. Highest votes wins. Built-in tiebreakers keep things moving.', bg: 'rgba(124,92,252,0.12)', color: '#7c5cfc', icon: <IcoPin /> },
    { title: 'Anonymous Budget Matching', desc: 'Private max budgets. Server calculates the floor. Nobody\'s financial comfort gets exposed.', bg: 'rgba(34,197,94,0.1)', color: '#4ade80', icon: <IcoLock /> },
    { title: 'Flock Chat', desc: 'Real-time group chat inside every flock. Venue cards, image sharing, emoji reactions.', bg: 'rgba(6,182,212,0.1)', color: '#22d3ee', icon: <IcoChat /> },
    { title: 'Real-Time Location', desc: 'Share your location within a flock so everyone knows when you\'re on your way.', bg: 'rgba(249,115,22,0.1)', color: '#fb923c', icon: <IcoNav /> },
    { title: 'Safety Features', desc: 'Add trusted contacts. One-tap SOS sends your location to people who need to know.', bg: 'rgba(239,68,68,0.1)', color: '#f87171', icon: <IcoShieldFill /> },
    { title: 'Reliability Score', desc: 'Track who actually shows up. Subtle, private scores help you plan with people you can count on.', bg: 'rgba(234,179,8,0.1)', color: '#fbbf24', icon: <IcoStar /> },
  ];


  return (
    <div className="landing">

      {/* ── NAV ── */}
      <nav className={`lp-nav${scrolled ? ' lp-nav--solid' : ''}`}>
        <div className="lp-nav-inner">
          <div className="lp-nav-brand" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
            <BirdLogo /><span className="lp-nav-wordmark">Flock</span>
          </div>
          <div className="lp-nav-center">
            <button onClick={() => scrollTo('features')}>Features</button>
            <button onClick={() => scrollTo('how-it-works')}>How It Works</button>
            <button onClick={() => scrollTo('venues')}>For Venues</button>
            <button onClick={() => scrollTo('pricing')}>Pricing</button>
          </div>
          <div className="lp-nav-right">
            <button className="lp-nav-login" onClick={() => { window.location.href = '/login'; }}>Log in</button>
            <button className="lp-nav-cta" onClick={() => scrollTo('early-access')}>Get early access</button>
          </div>
          <button className={`lp-hamburger${menuOpen ? ' open' : ''}`} onClick={() => setMenuOpen(!menuOpen)} aria-label="Menu">
            <span /><span /><span />
          </button>
        </div>
      </nav>
      <div className={`lp-mobile-menu${menuOpen ? ' open' : ''}`}>
        <button onClick={() => scrollTo('features')}>Features</button>
        <button onClick={() => scrollTo('how-it-works')}>How It Works</button>
        <button onClick={() => scrollTo('venues')}>For Venues</button>
        <button onClick={() => scrollTo('pricing')}>Pricing</button>
        <button className="lp-btn-primary" onClick={() => scrollTo('early-access')}>Get early access</button>
      </div>

      {/* ── HERO ── */}
      <section className="lp-hero">
        <div className="lp-orb lp-orb--1" ref={orb1} />
        <div className="lp-orb lp-orb--2" ref={orb2} />
        <div className="lp-orb lp-orb--3" ref={orb3} />

        <div className="lp-hero-content">
          <div className="lp-hero-eyebrow">
            <span className="lp-eyebrow-dot" /> 1st Place · PA DECA States 2025
          </div>
          <h1>
            Plans die in group chats.<br />
            <span className="lp-gradient-text">Flock</span> fixes that.
          </h1>
          <p className="lp-hero-sub">
            Create a flock. Invite friends. Match budgets without the awkwardness. Vote on venues. Actually go.
          </p>
          <div className="lp-hero-ctas">
            <button className="lp-btn-primary" onClick={() => scrollTo('early-access')}>Get early access</button>
            <button className="lp-btn-ghost" onClick={() => scrollTo('how-it-works')}>See how it works &rarr;</button>
          </div>
          <div className="lp-counter-bar">
            <span className="lp-counter-dot" />
            Built at Moravian Academy · 1st Place PA DECA States 2025 ·&nbsp;
            <span className="lp-counter-num" ref={counterRef}>2,847</span>&nbsp;group plans coordinated
          </div>
        </div>

        <div className="lp-preview" style={{ animation: 'heroFloat 4s ease-in-out infinite' }}>
          <div className="lp-hero-screenshots">
            <div className="lp-screenshot-phone">
              <img src="/screenshots/messages.png" alt="Flock messages" />
            </div>
            <div className="lp-screenshot-phone">
              <img src="/screenshots/home.png" alt="Flock home screen" />
            </div>
            <div className="lp-screenshot-phone">
              <img src="/screenshots/crowd.png" alt="Flock crowd prediction" />
            </div>
          </div>
        </div>

        <div className="lp-scroll-hint"><div className="lp-scroll-line" /></div>
      </section>

      <div className="lp-section-divider" />

      {/* ── SOCIAL PROOF ── */}
      <section className="lp-proof">
        <div className="lp-proof-inner">
          <div className="lp-proof-schools">Moravian Academy · Liberty High School · Freedom High School · Emmaus High School · Parkland High School</div>
          <div className="lp-proof-chips">
            <span className="lp-chip">DECA ICDC 2026</span>
            <span className="lp-chip">870K+ Data Points</span>
            <span className="lp-chip">13 Cities</span>
          </div>
        </div>
      </section>

      <div className="lp-section-divider" />

      {/* ── HOW IT WORKS ── */}
      <section className="lp-how-section" id="how-it-works">
        <div className="lp-inner">
          <div className="lp-eyebrow lp-reveal">THE CORE LOOP</div>
          <h2 className="lp-how-title lp-reveal">Five steps. Zero group chat chaos.</h2>
          <div className="lp-how-grid">
            {HOW_STEPS.map((step, i) => (
              <div key={step.num} className="lp-how-step-card lp-reveal" style={{ transitionDelay: `${i * 0.1}s` }}>
                <div className="lp-how-step-num">{step.num}</div>
                <h3 className="lp-how-step-title">{step.title}</h3>
                <p className="lp-how-step-desc">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="lp-section-divider" />

      {/* ── BUDGET SPOTLIGHT ── */}
      <section className="lp-budget-section" id="features">
        <div className="lp-budget-inner">
          <div className="lp-budget-copy lp-reveal">
            <span className="lp-eyebrow">THE FEATURE THAT CHANGES EVERYTHING</span>
            <h2>Money kills more plans than distance.</h2>
            <p>Someone suggests somewhere expensive. Two people go quiet — they can't afford it, but they won't say so. The plan dies. Everyone stays home.</p>
            <p>Flock's anonymous budget matching changes this. Everyone privately submits their max. The app calculates the group ceiling — the lowest budget in the room — without revealing who set it. Venues filter automatically.</p>
            <div className="lp-budget-checks">
              <div className="lp-budget-check"><IcoCheck /> Only you see your budget</div>
              <div className="lp-budget-check"><IcoCheck /> No averages, no distributions, no hints</div>
              <div className="lp-budget-check"><IcoCheck /> The group ceiling deletes 24h after the flock ends</div>
            </div>
          </div>
          <div className="lp-budget-right lp-reveal lp-delay-2">
            <div className="lp-screenshot-phone">
              <img src="/screenshots/split.png" alt="Flock split the bill feature" />
            </div>
          </div>
        </div>
      </section>

      <div className="lp-section-divider" />

      {/* ── FEATURE GRID ── */}
      <section className="lp-features">
        <div className="lp-features-inner">
          <h2 className="lp-reveal">Everything your friend group needs.</h2>
          <p className="lp-features-sub lp-reveal">Built for the planner who's tired of doing it all.</p>
          <div className="lp-features-grid">
            {FEATURES.map((f, i) => (
              <div key={f.title} className="lp-feature-card lp-reveal" style={{ transitionDelay: `${i * 0.08}s` }}>
                <div className="lp-feature-icon" style={{ background: f.bg, color: f.color }}>{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="lp-section-divider" />

      {/* ── STATS ── */}
      <section className="lp-stats">
        <div className="lp-stats-inner">
          <div className="lp-stats-grid">
            <div className="lp-reveal">
              <div className="lp-stat-num lp-gradient-text">15–22</div>
              <div className="lp-stat-label">Target age group — the prime coordination years</div>
            </div>
            <div className="lp-reveal lp-delay-1">
              <div className="lp-stat-num lp-gradient-text">3–8</div>
              <div className="lp-stat-label">Ideal flock size — large enough to need coordination</div>
            </div>
            <div className="lp-reveal lp-delay-2">
              <div className="lp-stat-num lp-gradient-text">~<CountUp target={47} suffix="%" /></div>
              <div className="lp-stat-label">of Gen Z say money stress affects social plans</div>
            </div>
            <div className="lp-reveal lp-delay-3">
              <div className="lp-stat-num lp-gradient-text">#<CountUp target={1} /></div>
              <div className="lp-stat-label">PA DECA Innovation Plan — out of 43 competitors</div>
            </div>
          </div>
        </div>
      </section>

      <div className="lp-section-divider" />

      {/* ── FOR VENUES ── */}
      <section className="lp-venues" id="venues">
        <div className="lp-venues-inner">
          <div className="lp-venues-copy lp-reveal">
            <span className="lp-eyebrow">FOR VENUES</span>
            <h2>Reach groups when they're deciding — not scrolling.</h2>
            <p>When someone opens Flock, they're actively planning where to go right now. That's 10x more valuable than a passive Instagram ad.</p>
            <div className="lp-venues-bullets">
              <div className="lp-venues-bullet">Your venue appears when groups in your area search</div>
              <div className="lp-venues-bullet">Real conversion data: how many groups viewed and chose you</div>
              <div className="lp-venues-bullet">$50–200/month — fraction of a traditional ad buy</div>
            </div>
            <button className="lp-btn-outline" onClick={() => scrollTo('early-access')}>Claim your venue</button>
          </div>
          <div className="lp-reveal lp-delay-2">
            <VenueDashboard />
          </div>
        </div>
      </section>

      <div className="lp-section-divider" />

      {/* ── PRICING ── */}
      <section className="lp-pricing" id="pricing">
        <div className="lp-reveal">
          <span className="lp-eyebrow">EARLY ACCESS</span>
          <h2>Free while we're in beta.</h2>
          <p className="lp-pricing-sub">Flock is actively being used and developed. Get early access now and help shape what it becomes.</p>
        </div>
        <div className="lp-pricing-cards">
          <div className="lp-price-card lp-reveal">
            <div className="lp-price-tier">Free</div>
            <div className="lp-price-amount">$0</div>
            <div className="lp-price-period">Forever free core features</div>
            <div className="lp-price-features">
              {['Create unlimited flocks', 'Anonymous budget matching', 'Venue voting', 'Real-time flock chat', 'Friend system + QR codes', 'Safety features'].map((f) => (
                <div key={f} className="lp-price-feature"><IcoCheck size={14} /> {f}</div>
              ))}
            </div>
            <button className="lp-btn-outline" onClick={() => scrollTo('early-access')}>Get started free</button>
          </div>
          <div className="lp-price-card lp-price-card--premium lp-reveal lp-delay-1">
            <span className="lp-price-badge">Coming soon</span>
            <div className="lp-price-tier">Flock Premium</div>
            <div className="lp-price-amount">{annual ? '$24.99' : '$2.99'}</div>
            <div className="lp-price-period">{annual ? '/year' : '/month'}{annual && <span className="lp-price-save">Save 30%</span>}</div>
            <div className="lp-price-toggle">
              <span className={`lp-price-toggle-label${!annual ? ' lp-price-toggle-label--active' : ''}`}>Monthly</span>
              <div className={`lp-toggle-track${annual ? ' lp-toggle-track--on' : ''}`} onClick={() => setAnnual(!annual)}>
                <div className="lp-toggle-thumb" />
              </div>
              <span className={`lp-price-toggle-label${annual ? ' lp-price-toggle-label--active' : ''}`}>Annual</span>
            </div>
            <div className="lp-price-features">
              {['Everything in Free', 'Flock templates', 'AI venue recommendations', 'Unlimited flock history', 'Advanced reliability analytics', 'Priority support'].map((f) => (
                <div key={f} className="lp-price-feature"><IcoCheck size={14} /> {f}</div>
              ))}
            </div>
            <button className="lp-btn-primary" onClick={() => scrollTo('early-access')}>Join waitlist</button>
          </div>
        </div>
      </section>

      {/* ── MEET BIRDIE ── */}
      <section className="lp-birdie">
        {/* Spotlight SVG */}
        <svg
          className="lp-birdie-spotlight"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 3787 2842"
          fill="none"
        >
          <g filter="url(#birdie-glow)">
            <ellipse
              cx="1924.71" cy="273.501" rx="1924.71" ry="273.501"
              transform="matrix(-0.822377 -0.568943 -0.568943 0.822377 3631.88 2291.09)"
              fill="white" fillOpacity="0.21"
            />
          </g>
          <defs>
            <filter id="birdie-glow" x="0.860352" y="0.838989" width="3785.16" height="2840.26" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
              <feFlood floodOpacity="0" result="BackgroundImageFix" />
              <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
              <feGaussianBlur stdDeviation="151" result="effect1_foregroundBlur" />
            </filter>
          </defs>
        </svg>

        <div className="lp-birdie-inner">
          {/* Left — text */}
          <div className="lp-birdie-copy lp-reveal">
            <span className="lp-eyebrow">AI-POWERED</span>
            <h2 className="lp-birdie-title">
              Meet <span className="lp-gradient-text">Birdie</span>
            </h2>
            <p className="lp-birdie-desc">
              Your AI planning assistant that lives inside every flock. Birdie suggests venues based on your group's vibe, budget, and location — so you spend less time deciding and more time going.
            </p>
            <div className="lp-birdie-features">
              <div className="lp-birdie-feat">
                <div className="lp-birdie-feat-dot" />
                <span>Smart venue recommendations based on group preferences</span>
              </div>
              <div className="lp-birdie-feat">
                <div className="lp-birdie-feat-dot" />
                <span>Real-time crowd predictions so you avoid the wait</span>
              </div>
              <div className="lp-birdie-feat">
                <div className="lp-birdie-feat-dot" />
                <span>Knows your budget, your vibe, your crew</span>
              </div>
            </div>
          </div>

          {/* Right — 3D robot */}
          <div className="lp-birdie-scene lp-reveal lp-delay-2">
            <Suspense fallback={<div className="lp-birdie-loader"><span className="lp-birdie-spinner" /></div>}>
              <Spline scene="https://prod.spline.design/kZDDjO5HuC9GJUM2/scene.splinecode" />
            </Suspense>
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ── */}
      <section className="lp-final-cta" id="early-access">
        <div className="lp-final-glow" />
        <StarField />
        <div className="lp-final-content lp-reveal">
          <h2>Your friend group's plans are dying in a group chat.</h2>
          <p className="lp-final-cta-sub">Flock fixes the coordination. Fixes the money awkwardness. Gets you all in the same room.</p>
          {submitted ? (
            <div className="lp-cta-confirmed">{waitlistMsg}</div>
          ) : (
            <form className="lp-cta-form" onSubmit={handleWaitlist}>
              <input className="lp-cta-input" type="email" placeholder="you@email.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <button className="lp-btn-primary" type="submit">Join Waitlist</button>
            </form>
          )}
          <span className="lp-cta-note">No credit card. No commitment. Takes 30 seconds.</span>
          <span className="lp-cta-fine">Available on iOS and Android — 2026</span>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="lp-footer">
        <div className="lp-footer-inner">
          <div className="lp-footer-brand">
            <div className="lp-nav-brand"><BirdLogo size={20} /><span className="lp-nav-wordmark">Flock</span></div>
            <span className="lp-footer-tagline">Social Coordination Simplified</span>
            <span className="lp-footer-copy-line">&copy; 2026 Flock</span>
          </div>
          <div className="lp-footer-links">
            <h4>Product</h4>
            <button onClick={() => scrollTo('features')}>Features</button>
            <button onClick={() => scrollTo('pricing')}>Pricing</button>
            <button onClick={() => scrollTo('venues')}>For Venues</button>
          </div>
          <div className="lp-footer-credit">
            <span>Built by Jayden Bansal</span>
            <span>1st Place PA DECA</span>
            <span>flockcorp.com</span>
          </div>
        </div>
        <div className="lp-footer-bottom">&copy; 2026 Flock. All rights reserved.</div>
      </footer>
    </div>
  );
}
