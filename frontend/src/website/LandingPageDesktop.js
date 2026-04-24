import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import ShaderParticles from './scene/ShaderParticles';
import BackgroundStars from './scene/BackgroundStars';
import FlockBirds from './scene/FlockBirds';
import CityScene from './scene/CityScene';
import CameraRig from './scene/CameraRig';
// FollowLight removed - using meshBasicMaterial everywhere now
import useScrollProgress from './hooks/useScrollProgress';
import useTiltCard from './hooks/useTiltCard';
import Marquee from './components/Marquee';
import CountUpScramble from './components/CountUpScramble';

const Spline = lazy(() => import('@splinetool/react-spline'));

gsap.registerPlugin(ScrollTrigger);

/* ── Inline SVG Helpers ── */
function IcoCheck() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function IcoPin() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function IcoLock() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function IcoChat() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function IcoNavigation() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="3 11 22 2 13 21 11 13 3 11" />
    </svg>
  );
}

function IcoShield() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function IcoStar() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

/* ── Section-to-particle shape mapping ── */
/* ── Feature data ── */
const FEATURES = [
  { icon: <IcoPin />, bg: 'rgba(13,148,136,0.12)', title: 'Venue Voting', desc: 'Everyone votes on real venues pulled from Google Places. Highest votes wins. No more "idc you pick."' },
  { icon: <IcoLock />, bg: 'rgba(245,158,11,0.12)', title: 'Anonymous Budget', desc: 'Submit your max privately. Nobody sees your number. Only venues that fit everyone appear.' },
  { icon: <IcoChat />, bg: 'rgba(6,182,212,0.12)', title: 'Flock Chat', desc: 'Built-in group chat per flock. Share venue cards, react, discuss. Everything stays in one place.' },
  { icon: <IcoNavigation />, bg: 'rgba(74,222,128,0.12)', title: 'Real-Time Location', desc: 'Opt-in location sharing so everyone knows who is on the way and who is running late.' },
  { icon: <IcoShield />, bg: 'rgba(239,68,68,0.12)', title: 'Safety Features', desc: 'Trusted contacts, SOS alerts with live location, and emergency notifications sent instantly.' },
  { icon: <IcoStar />, bg: 'rgba(168,85,247,0.12)', title: 'Reliability Score', desc: 'Track who actually shows up. Your score follows you. No more chronic flakers ruining plans.' },
];

/* ── Pricing data ── */
const FREE_FEATURES = [
  'Create up to 3 active flocks',
  'Venue voting & budget matching',
  'Group chat per flock',
  'Friend system & QR invites',
  'Basic safety features',
];

const PREMIUM_FEATURES = [
  'Unlimited active flocks',
  'AI crowd forecasting',
  'Birdie AI assistant',
  'Priority venue data',
  'Advanced safety suite',
  'Reliability analytics',
  'Custom flock themes',
  'Early access to new features',
];

/* ── Venue dashboard data ── */
const DASH_BARS = [35, 52, 28, 68, 85, 72, 45];
const DASH_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DASH_METRICS = [
  { label: 'Flocks Nearby', value: '127', change: '+18%' },
  { label: 'Avg Group Size', value: '5.2', change: '+0.8' },
  { label: 'Peak Hour', value: '8 PM', change: '' },
];

/* ── Schools for marquee ── */
const SCHOOLS = [
  'Penn State', 'Temple', 'Drexel', 'Villanova', 'UPenn', 'St. Joe\'s',
  'Lehigh', 'Pitt', 'Carnegie Mellon', 'West Chester', 'Rutgers', 'NYU',
  'Georgetown', 'Boston College', 'UMD', 'Virginia Tech',
];

/* ── How It Works steps ── */
const HOW_STEPS = [
  {
    num: '01', title: 'Create a Flock', accent: '#0d9488',
    desc: 'Name your hangout, set a vibe (dinner, drinks, adventure), pick a date range. Your flock goes live in under 10 seconds. Friends get notified instantly.',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />
      </svg>
    ),
  },
  {
    num: '02', title: 'Invite Your Friends', accent: '#06b6d4',
    desc: 'Share a link or QR code. Friends tap to join and RSVP: going, maybe, or can\'t make it. No app download required to respond.',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  },
  {
    num: '03', title: 'Submit Your Budget', accent: '#4ade80',
    desc: 'Everyone privately enters their max spend. Nobody sees anyone else\'s number. The app calculates a group ceiling without revealing who set it.',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
  },
  {
    num: '04', title: 'Vote on Venues', accent: '#f59e0b',
    desc: 'Only spots that fit everyone\'s budget appear. The group votes. Highest votes wins. Built-in tiebreakers keep things moving.',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" />
      </svg>
    ),
  },
  {
    num: '05', title: 'Go', accent: '#ec4899',
    desc: 'Flock confirmed. Everyone gets the details, location, and time. Real-time location sharing so you know when your crew is on the way.',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
      </svg>
    ),
  },
];

/* ── Birdie features ── */
const BIRDIE_FEATURES = [
  'Natural language planning: "find a sushi spot for 6 under $25 each"',
  'Real-time crowd intelligence that knows when places are packed',
  'Group preference learning that gets smarter with every flock',
  'Budget-aware suggestions that never recommend out of range',
];

/* ── Helper: smooth scroll ── */
function scrollTo(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
}

/* ── Feature Card wrapper (uses useTiltCard) ── */
function FeatureCard({ icon, bg, title, desc }) {
  const cardRef = useRef(null);
  useTiltCard(cardRef);
  return (
    <div className="lp-feature-card gsap-stagger-item" ref={cardRef}>
      <div className="lp-feature-icon" style={{ background: bg }}>
        {icon}
      </div>
      <h3>{title}</h3>
      <p>{desc}</p>
    </div>
  );
}

/* ── Inline VenueDashboard ── */
function VenueDashboard() {
  return (
    <div className="lp-venue-dash">
      <div className="lp-dash-title">Venue Insights Dashboard</div>
      <div className="lp-dash-sub">Real-time data from Flock users</div>
      <div className="lp-dash-metrics">
        {DASH_METRICS.map((m, i) => (
          <div className="lp-dash-metric" key={i}>
            <span className="lp-dash-metric-label">{m.label}</span>
            <span>
              <span className="lp-dash-metric-val">{m.value}</span>
              {m.change && <span className="lp-dash-metric-up">{m.change}</span>}
            </span>
          </div>
        ))}
      </div>
      <div className="lp-dash-bars">
        {DASH_BARS.map((h, i) => (
          <div
            key={i}
            className={`lp-dash-bar${i === 4 ? ' lp-dash-bar--today' : ''}`}
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
      <div className="lp-dash-days">
        {DASH_DAYS.map((d, i) => (
          <div key={i} className="lp-dash-day">{d}</div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   LandingPageDesktop.Main Component
   ═══════════════════════════════════════════════════ */
export default function LandingPageDesktop() {
  // ── State ──
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [waitlistMsg, setWaitlistMsg] = useState('');
  const [annual, setAnnual] = useState(true);
  const [howProgress, setHowProgress] = useState(0);
  const [heroVisible, setHeroVisible] = useState(false);

  // Scroll progress from hook
  const { containerRef, progress: scrollProgress, activeSection, sectionProgress } = useScrollProgress();

  // Refs
  const howStripRef = useRef(null);
  const statsLineRef = useRef(null);

  // ── Mouse tracking for 3D interaction ──
  const mouseRef = useRef({ x: 0, y: 0 });
  // Force body background to navy so nothing is ever black
  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = '#0b1a2e';
    document.documentElement.style.background = '#0b1a2e';
    return () => { document.body.style.background = prev; document.documentElement.style.background = ''; };
  }, []);

  useEffect(() => {
    const onMove = (e) => {
      mouseRef.current.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouseRef.current.y = -(e.clientY / window.innerHeight) * 2 + 1;
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  // ── Nav scroll listener ──
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 60);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // ── Hero entrance animation ──
  useEffect(() => {
    const timer = setTimeout(() => setHeroVisible(true), 200);
    return () => clearTimeout(timer);
  }, []);

  // ── GSAP: How-It-Works horizontal scroll + stats line ──
  useEffect(() => {
    const strip = howStripRef.current;
    if (!strip) return;

    const totalCards = 5;
    const cardWidth = 552; // 520 + 32 gap
    const totalStripWidth = (totalCards - 1) * cardWidth;

    const howTrigger = ScrollTrigger.create({
      trigger: '.lp-how-pin-wrap',
      start: 'top top',
      end: `+=${totalStripWidth}`,
      pin: true,
      scrub: 1,
      onUpdate: (self) => {
        const p = self.progress;
        strip.style.transform = `translateX(${-p * totalStripWidth}px)`;
        setHowProgress(p);
      },
    });

    // Stats SVG line draw
    const statsLine = statsLineRef.current;
    let statsTrigger;
    if (statsLine) {
      statsTrigger = ScrollTrigger.create({
        trigger: statsLine,
        start: 'top 80%',
        once: true,
        onEnter: () => statsLine.classList.add('drawn'),
      });
    }

    // ── Scroll reveal animations for ALL content ──
    const reveals = gsap.utils.toArray('.gsap-reveal');
    const revealTriggers = reveals.map(el => {
      gsap.set(el, { opacity: 0, y: 40 });
      return ScrollTrigger.create({
        trigger: el,
        start: 'top 85%',
        once: true,
        onEnter: () => {
          gsap.to(el, { opacity: 1, y: 0, duration: 0.8, ease: 'power3.out' });
        },
      });
    });

    // Staggered card reveals
    const cardGroups = gsap.utils.toArray('.gsap-stagger-group');
    const cardTriggers = cardGroups.map(group => {
      const cards = group.querySelectorAll('.gsap-stagger-item');
      gsap.set(cards, { opacity: 0, y: 30, rotateX: 8 });
      return ScrollTrigger.create({
        trigger: group,
        start: 'top 80%',
        once: true,
        onEnter: () => {
          gsap.to(cards, { opacity: 1, y: 0, rotateX: 0, duration: 0.6, ease: 'power3.out', stagger: 0.08 });
        },
      });
    });

    return () => {
      howTrigger.kill();
      if (statsTrigger) statsTrigger.kill();
      revealTriggers.forEach(t => t.kill());
      cardTriggers.forEach(t => t.kill());
    };
  }, []);

  // ── Waitlist handler ──
  const handleWaitlist = useCallback(async (e) => {
    e.preventDefault();
    if (!email || !email.includes('@')) {
      setWaitlistMsg('Please enter a valid email.');
      return;
    }

    setSubmitted(true);
    setWaitlistMsg('');

    try {
      const apiUrl = process.env.REACT_APP_API_URL || 'https://flock-app-production.up.railway.app';
      const res = await fetch(`${apiUrl}/api/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      if (res.ok) {
        setWaitlistMsg('You\'re on the list! We\'ll be in touch.');
      } else {
        const data = await res.json().catch(() => ({}));
        setWaitlistMsg(data.error || 'Something went wrong. Try again.');
        setSubmitted(false);
      }
    } catch (err) {
      // Fallback to localStorage
      try {
        const existing = JSON.parse(localStorage.getItem('flock_waitlist') || '[]');
        existing.push({ email, ts: Date.now() });
        localStorage.setItem('flock_waitlist', JSON.stringify(existing));
        setWaitlistMsg('You\'re on the list! We\'ll be in touch.');
      } catch {
        setWaitlistMsg('Something went wrong. Try again.');
        setSubmitted(false);
      }
    }
  }, [email]);

  // ═══════════ RENDER ═══════════
  return (
    <div className="landing">
      {/* ── 3D Canvas (fixed behind content) ── */}
      <div className="lp-canvas-wrap">
        <Canvas camera={{ position: [0, 35, 20], fov: 65, near: 0.5, far: 120 }} dpr={[1, 1.5]} onCreated={({ gl }) => { gl.setClearColor(0x0b1a2e, 1); }}>
          {/* scene clears to brand navy - never black */}
          <ambientLight intensity={0.3} />
          <BackgroundStars />
          <FlockBirds scatter={activeSection === 'hero' ? sectionProgress : 1} />
          <CityScene scrollProgress={scrollProgress} />
          <ShaderParticles
            scrollProgress={scrollProgress}
            activeSection={activeSection}
            sectionProgress={sectionProgress}
            mouseX={mouseRef.current.x}
            mouseY={mouseRef.current.y}
          />
          <CameraRig progress={scrollProgress} />
        </Canvas>
      </div>

      {/* ── NAV ── */}
      <nav className={`lp-nav${scrolled ? ' lp-nav--solid' : ''}`}>
        <div className="lp-nav-inner">
          <div className="lp-nav-brand" onClick={() => scrollTo('hero')}>
            <img src="/flock-logo.png" alt="Flock" width="28" height="28" />
            <span className="lp-nav-wordmark">Flock</span>
          </div>

          <div className="lp-nav-center">
            <button onClick={() => scrollTo('how')}>How It Works</button>
            <button onClick={() => scrollTo('features')}>Features</button>
            <button onClick={() => scrollTo('pricing')}>Pricing</button>
            <button onClick={() => scrollTo('birdie')}>Birdie AI</button>
          </div>

          <div className="lp-nav-right">
            <button className="lp-nav-login" onClick={() => scrollTo('cta')}>Log In</button>
            <button className="lp-nav-cta" onClick={() => scrollTo('cta')}>Get Early Access</button>
          </div>

          <button
            className={`lp-hamburger${menuOpen ? ' open' : ''}`}
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label="Menu"
          >
            <span /><span /><span />
          </button>
        </div>
      </nav>

      {/* Mobile Menu */}
      <div className={`lp-mobile-menu${menuOpen ? ' open' : ''}`}>
        <button onClick={() => { scrollTo('how'); setMenuOpen(false); }}>How It Works</button>
        <button onClick={() => { scrollTo('features'); setMenuOpen(false); }}>Features</button>
        <button onClick={() => { scrollTo('pricing'); setMenuOpen(false); }}>Pricing</button>
        <button onClick={() => { scrollTo('birdie'); setMenuOpen(false); }}>Birdie AI</button>
        <button className="lp-btn-primary" onClick={() => { scrollTo('cta'); setMenuOpen(false); }}>Get Early Access</button>
      </div>

      {/* ── Scroll Container ── */}
      <div className="lp-scroll-container" ref={containerRef}>

        {/* ═══════════ HERO ═══════════ */}
        <section className="lp-section lp-hero" id="hero">
          <div className="lp-hero-content">
            <div className={`lp-hero-badge${heroVisible ? ' visible' : ''}`}>
              <span className="lp-hero-badge-dot" />
              1st Place &middot; PA DECA States 2025
            </div>

            <h1>
              {'Plans die in group chats.'.split('').map((char, i) => (
                <span
                  key={`l1-${i}`}
                  className={`char${heroVisible ? ' visible' : ''}`}
                  style={{ transitionDelay: `${i * 25}ms` }}
                >
                  {char === ' ' ? '\u00A0' : char}
                </span>
              ))}
              <br />
              {['F','l','o','c','k'].map((char, i) => (
                <span
                  key={`flock-${i}`}
                  className={`char lp-gradient-text${heroVisible ? ' visible' : ''}`}
                  style={{ transitionDelay: `${(25 + i) * 25}ms` }}
                >
                  {char}
                </span>
              ))}
              {' fixes that.'.split('').map((char, i) => (
                <span
                  key={`l2-${i}`}
                  className={`char${heroVisible ? ' visible' : ''}`}
                  style={{ transitionDelay: `${(30 + i) * 25}ms` }}
                >
                  {char === ' ' ? '\u00A0' : char}
                </span>
              ))}
            </h1>

            <p className={`lp-hero-sub${heroVisible ? ' visible' : ''}`}>
              The app that turns "we should hang out" into an actual plan.
              Budget matching, venue voting, and zero awkwardness.
            </p>

            <div className={`lp-hero-ctas${heroVisible ? ' visible' : ''}`}>
              <button className="lp-btn-primary" onClick={() => scrollTo('cta')}>
                Join the Waitlist
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
              <button className="lp-btn-ghost" onClick={() => scrollTo('how')}>
                See How It Works &darr;
              </button>
            </div>

            <div className={`lp-hero-screenshots${heroVisible ? ' visible' : ''}`}>
              <div className="lp-screenshot-phone">
                <img src="/screenshots/discover.png" alt="Discover venues" />
              </div>
              <div className="lp-screenshot-phone">
                <img src="/screenshots/home.png" alt="Flock home" />
              </div>
              <div className="lp-screenshot-phone">
                <img src="/screenshots/chat.png" alt="Group chat" />
              </div>
            </div>

            <div className={`lp-counter-bar${heroVisible ? ' visible' : ''}`}>
              <span>Trusted by students at 40+ universities</span>
              <span>&middot;</span>
              <span>Built in PA</span>
            </div>
          </div>
        </section>

        {/* ═══════════ SOCIAL PROOF ═══════════ */}
        <section className="lp-section lp-proof" id="proof">
          <div className="lp-proof-inner">
            <Marquee speed={40}>
              {SCHOOLS.map((school, i) => (
                <span key={i} style={{ padding: '0 32px', fontSize: '14px', color: 'rgba(245,240,232,0.35)', fontWeight: 500 }}>
                  {school}
                </span>
              ))}
            </Marquee>
            <div className="lp-proof-chips">
              <span className="lp-chip">DECA ICDC 2026</span>
              <span className="lp-chip">2M+ Data Points</span>
              <span className="lp-chip">21 Cities and Growing</span>
            </div>
          </div>
        </section>

        <div className="lp-divider" />

        {/* ═══════════ HOW IT WORKS ═══════════ */}
        <section className="lp-section lp-how-section" id="how">
          <div className="lp-how-pin-wrap">
            <div className="lp-how-header">
              <span className="lp-eyebrow">How It Works</span>
              <h2>Five steps. Zero drama.</h2>
              <div className="lp-how-progress">
                <div className="lp-how-progress-fill" style={{ width: `${howProgress * 100}%` }} />
              </div>
            </div>
            <div className="lp-how-strip" ref={howStripRef}>
              {HOW_STEPS.map((step, i) => (
                <div className="lp-how-card gsap-stagger-item" key={i} style={{ borderTop: `3px solid ${step.accent}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
                    <div style={{ width: 48, height: 48, borderRadius: 12, background: `${step.accent}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: step.accent, flexShrink: 0 }}>
                      {step.icon}
                    </div>
                    <div className="lp-how-card-num">{step.num}</div>
                  </div>
                  <h3>{step.title}</h3>
                  <p>{step.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Spacer for 3D timing after pinned section */}
        <div style={{ height: '60vh' }} />

        {/* ═══════════ BUDGET SPOTLIGHT ═══════════ */}
        <section className="lp-section lp-budget-section" id="budget">
          <div className="lp-budget-inner">
            <div className="lp-budget-copy gsap-reveal">
              <span className="lp-eyebrow">Anonymous Budget Matching</span>
              <h2>Money kills more plans than distance.</h2>
              <p>
                Everyone has a different budget. Nobody wants to be the one to say it.
                Flock lets every member submit their max privately. We surface only venues
                that fit the group's combined range. No judgment. No awkwardness.
              </p>
              <div className="lp-budget-checks">
                <div className="lp-budget-check"><IcoCheck /> Submissions are 100% anonymous</div>
                <div className="lp-budget-check"><IcoCheck /> Only aggregate data is shared</div>
                <div className="lp-budget-check"><IcoCheck /> Venues auto-filter to match budgets</div>
                <div className="lp-budget-check"><IcoCheck /> Skip option for flexible members</div>
              </div>
            </div>
            <div className="lp-budget-right gsap-reveal">
              <div className="lp-screenshot-phone">
                <img src="/screenshots/split.png" alt="Budget matching" />
              </div>
            </div>
          </div>
        </section>

        <div className="lp-divider" />

        {/* ═══════════ FEATURES ═══════════ */}
        <section className="lp-section lp-features" id="features">
          <div className="lp-features-inner">
            <span className="lp-eyebrow gsap-reveal">Features</span>
            <h2 className="gsap-reveal">Everything your friend group needs.</h2>
            <p className="lp-features-sub">
              No more app switching. No more dead plans. One place for everything.
            </p>
            <div className="lp-features-grid gsap-stagger-group">
              {FEATURES.map((f, i) => (
                <FeatureCard key={i} icon={f.icon} bg={f.bg} title={f.title} desc={f.desc} />
              ))}
            </div>
          </div>
        </section>

        {/* ═══════════ STATS ═══════════ */}
        <section className="lp-section lp-stats" id="stats">
          <div className="lp-stats-inner">
            <svg className="lp-stats-line" ref={statsLineRef} viewBox="0 0 800 2" preserveAspectRatio="none">
              <line x1="0" y1="1" x2="800" y2="1" />
            </svg>
            <div className="lp-stats-grid gsap-stagger-group">
              <div className="gsap-stagger-item">
                <div className="lp-stat-num">
                  <CountUpScramble target="15" suffix="-22" />
                </div>
                <div className="lp-stat-label">Target age range</div>
              </div>
              <div className="gsap-stagger-item">
                <div className="lp-stat-num">
                  <CountUpScramble target="3" suffix="-8" />
                </div>
                <div className="lp-stat-label">Ideal flock size</div>
              </div>
              <div className="gsap-stagger-item">
                <div className="lp-stat-num">
                  <CountUpScramble prefix="~" target="47" suffix="%" />
                </div>
                <div className="lp-stat-label">Of Gen Z say money stress kills plans</div>
              </div>
              <div className="gsap-stagger-item">
                <div className="lp-stat-num">
                  <CountUpScramble prefix="#" target="1" />
                </div>
                <div className="lp-stat-label">PA DECA States 2025</div>
              </div>
            </div>
          </div>
        </section>

        <div className="lp-divider" />

        {/* ═══════════ FOR VENUES ═══════════ */}
        <section className="lp-section lp-venues" id="venues">
          <div className="lp-venues-inner">
            <div className="lp-venues-copy gsap-reveal">
              <span className="lp-eyebrow">For Venues</span>
              <h2>Turn foot traffic into guaranteed groups.</h2>
              <p>
                Flock sends real groups to real places. Our venue dashboard gives you
                insights no other platform can: group sizes, budgets, peak coordination
                times, and direct visibility to users actively making plans.
              </p>
              <div className="lp-venues-bullets">
                <div className="lp-venues-bullet">See real-time flock activity near your venue</div>
                <div className="lp-venues-bullet">Offer promotions to groups matching your capacity</div>
                <div className="lp-venues-bullet">Access anonymized budget and preference data</div>
                <div className="lp-venues-bullet">Get featured in venue voting for nearby flocks</div>
              </div>
              <button className="lp-btn-outline" onClick={() => scrollTo('cta')}>
                Partner With Us
              </button>
            </div>
            <VenueDashboard />
          </div>
        </section>

        {/* Spacer for 3D timing */}
        <div style={{ height: '40vh' }} />

        {/* ═══════════ PRICING ═══════════ */}
        <section className="lp-section lp-pricing" id="pricing">
          <span className="lp-eyebrow gsap-reveal">Pricing</span>
          <h2 className="gsap-reveal">Simple. Transparent. Worth it.</h2>
          <p className="lp-pricing-sub">
            Free forever for casual use. Premium for the friend group that never stops planning.
          </p>

          <div className="lp-pricing-cards gsap-stagger-group">
            {/* Free Card */}
            <div className="lp-price-card gsap-stagger-item">
              <div className="lp-price-tier">Free</div>
              <div className="lp-price-amount">$0</div>
              <div className="lp-price-period">forever</div>
              <div className="lp-price-features">
                {FREE_FEATURES.map((f, i) => (
                  <div className="lp-price-feature" key={i}>
                    <IcoCheck /> {f}
                  </div>
                ))}
              </div>
              <button className="lp-btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => scrollTo('cta')}>
                Get Started
              </button>
            </div>

            {/* Premium Card */}
            <div className="lp-price-card lp-price-card--premium gsap-stagger-item">
              <span className="lp-price-badge">Most Popular</span>
              <div className="lp-price-tier">Premium</div>
              <div className="lp-price-amount">
                {annual ? '$24.99' : '$2.99'}
                {annual && <span className="lp-price-save">Save 30%</span>}
              </div>
              <div className="lp-price-period">{annual ? 'per year' : 'per month'}</div>

              <div className="lp-price-toggle">
                <span className={`lp-price-toggle-label${!annual ? ' lp-price-toggle-label--active' : ''}`}>Monthly</span>
                <div
                  className={`lp-toggle-track${annual ? ' lp-toggle-track--on' : ''}`}
                  onClick={() => setAnnual(!annual)}
                >
                  <div className="lp-toggle-thumb" />
                </div>
                <span className={`lp-price-toggle-label${annual ? ' lp-price-toggle-label--active' : ''}`}>Annual</span>
              </div>

              <div className="lp-price-features">
                {PREMIUM_FEATURES.map((f, i) => (
                  <div className="lp-price-feature" key={i}>
                    <IcoCheck /> {f}
                  </div>
                ))}
              </div>
              <button className="lp-btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => scrollTo('cta')}>
                Join Waitlist
              </button>
            </div>
          </div>
        </section>

        <div className="lp-divider" />

        {/* ═══════════ BIRDIE AI ═══════════ */}
        <section className="lp-section lp-birdie" id="birdie">
          <div className="lp-birdie-inner">
            <div className="lp-birdie-copy gsap-reveal">
              <span className="lp-eyebrow">AI Assistant</span>
              <h1 className="lp-birdie-title">
                Meet <span className="lp-gradient-text">Birdie</span>.
              </h1>
              <p className="lp-birdie-desc">
                Your flock's AI planning assistant. Birdie knows crowd levels, matches budgets,
                and suggests perfect spots, all in natural language. Like having a friend
                who's been everywhere and knows everyone's vibe.
              </p>
              <div className="lp-birdie-features">
                {BIRDIE_FEATURES.map((f, i) => (
                  <div className="lp-birdie-feat" key={i}>
                    <span className="lp-birdie-feat-dot" />
                    {f}
                  </div>
                ))}
              </div>
            </div>
            <div className="lp-birdie-scene">
              <Suspense fallback={
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ width: 40, height: 40, borderRadius: '50%', border: '3px solid rgba(245,240,232,0.1)', borderTopColor: 'var(--lp-accent)', animation: 'spin 0.8s linear infinite' }} />
                </div>
              }>
                <Spline scene="https://prod.spline.design/kZDDjO5HuC9GJUM2/scene.splinecode" />
              </Suspense>
            </div>
          </div>
        </section>

        {/* Spacer for 3D timing */}
        <div style={{ height: '40vh' }} />

        {/* ═══════════ FINAL CTA ═══════════ */}
        <section className="lp-section lp-final-cta" id="cta">
          <div className="lp-final-content gsap-reveal">
            <h2>Your friend group's plans are dying in a group chat.</h2>
            <p className="lp-final-cta-sub">
              Join the waitlist. Be first to coordinate like you actually mean it.
            </p>

            {submitted && waitlistMsg ? (
              <div className="lp-cta-confirmed">{waitlistMsg}</div>
            ) : (
              <form className="lp-cta-form" onSubmit={handleWaitlist}>
                <input
                  className="lp-cta-input"
                  type="email"
                  placeholder="your@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
                <button className="lp-btn-primary" type="submit">
                  Join Waitlist
                </button>
              </form>
            )}
            {waitlistMsg && !submitted && (
              <span style={{ color: '#ef4444', fontSize: '13px' }}>{waitlistMsg}</span>
            )}
            <span className="lp-cta-note">Free forever. No spam. Unsubscribe anytime.</span>
          </div>
        </section>

        {/* ═══════════ FOOTER ═══════════ */}
        <footer className="lp-footer" id="footer">
          <div className="lp-footer-inner">
            <div className="lp-footer-brand">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <img src="/flock-logo.png" alt="Flock" width="24" height="24" />
                <span style={{ fontWeight: 700, fontSize: '16px' }}>Flock</span>
              </div>
              <span className="lp-footer-tagline">Social coordination, simplified.</span>
              <span className="lp-footer-copy-line">&copy; {new Date().getFullYear()} Flock. All rights reserved.</span>
            </div>
            <div className="lp-footer-links">
              <h4>Product</h4>
              <button onClick={() => scrollTo('how')}>How It Works</button>
              <button onClick={() => scrollTo('features')}>Features</button>
              <button onClick={() => scrollTo('pricing')}>Pricing</button>
              <button onClick={() => scrollTo('birdie')}>Birdie AI</button>
              <button onClick={() => scrollTo('venues')}>For Venues</button>
            </div>
            <div className="lp-footer-credit">
              <span>Built by Jayden Bansal</span>
              <span>Pennsylvania, USA</span>
              <span style={{ marginTop: '8px' }}>
                <a href="https://github.com/bansaljayden/Flock-app-" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>
                  GitHub
                </a>
              </span>
            </div>
          </div>
          <div className="lp-footer-bottom">
            Made with conviction, not permission.
          </div>
        </footer>

      </div>
    </div>
  );
}
