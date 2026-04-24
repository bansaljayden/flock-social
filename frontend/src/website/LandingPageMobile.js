import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Marquee from './components/Marquee';
import CountUpScramble from './components/CountUpScramble';

gsap.registerPlugin(ScrollTrigger);

const Spline = lazy(() => import('@splinetool/react-spline'));


function IcoCheck({ size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 8.5l3 3 7-7.5" /></svg>;
}

const FEATURES = [
  { title: 'Venue Voting', desc: 'Everyone votes on spots. Highest votes wins. Built-in tiebreakers.', bg: 'rgba(124,92,252,0.12)', color: '#7c5cfc', icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg> },
  { title: 'Anonymous Budget', desc: "Private max budgets. Server calculates the floor. Nobody's comfort gets exposed.", bg: 'rgba(34,197,94,0.1)', color: '#4ade80', icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg> },
  { title: 'Flock Chat', desc: 'Real-time group chat inside every flock. Venue cards, image sharing, reactions.', bg: 'rgba(6,182,212,0.1)', color: '#22d3ee', icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg> },
  { title: 'Real-Time Location', desc: "Share your location within a flock so everyone knows when you're on your way.", bg: 'rgba(249,115,22,0.1)', color: '#fb923c', icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z"/></svg> },
  { title: 'Safety Features', desc: 'Add trusted contacts. One-tap SOS sends your location to people who need to know.', bg: 'rgba(239,68,68,0.1)', color: '#f87171', icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg> },
  { title: 'Reliability Score', desc: 'Track who actually shows up. Private scores help you plan with people you count on.', bg: 'rgba(234,179,8,0.1)', color: '#fbbf24', icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg> },
];

const HOW_STEPS = [
  { num: '01', title: 'Create a Flock', desc: 'Name it, set a vibe, pick a date range. Takes 10 seconds.' },
  { num: '02', title: 'Invite Your Friends', desc: "Share via QR code or link. Friends RSVP going, maybe, or can't make it." },
  { num: '03', title: 'Submit Your Budget', desc: "Everyone enters their max privately. Nobody sees anyone else's number." },
  { num: '04', title: 'Vote on Venues', desc: "Only spots that work for everyone's budget appear. Group votes." },
  { num: '05', title: 'Go', desc: 'Flock confirmed. Everyone gets the details. You actually go.' },
];

export default function LandingPageMobile() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [waitlistMsg, setWaitlistMsg] = useState('');
  const [annual, setAnnual] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 60);
    window.addEventListener('scroll', fn, { passive: true });
    return () => window.removeEventListener('scroll', fn);
  }, []);

  // GSAP scroll reveals
  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.utils.toArray('.gsap-reveal').forEach((el) => {
        gsap.from(el, {
          y: 40, opacity: 0, duration: 0.8,
          ease: 'power3.out',
          scrollTrigger: { trigger: el, start: 'top 85%', once: true },
        });
      });
    }, containerRef);
    return () => ctx.revert();
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

  return (
    <div className="landing" ref={containerRef}>
      {/* NAV */}
      <nav className={`lp-nav${scrolled ? ' lp-nav--solid' : ''}`}>
        <div className="lp-nav-inner">
          <div className="lp-nav-brand" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
            <span className="lp-nav-wordmark">Flock</span>
          </div>
          <button className="lp-nav-cta" onClick={() => scrollTo('early-access')}>Get early access</button>
          <button className={`lp-hamburger${menuOpen ? ' open' : ''}`} onClick={() => setMenuOpen(!menuOpen)} aria-label="Menu">
            <span /><span /><span />
          </button>
        </div>
      </nav>
      <div className={`lp-mobile-menu${menuOpen ? ' open' : ''}`}>
        <button onClick={() => scrollTo('features')}>Features</button>
        <button onClick={() => scrollTo('how-it-works')}>How It Works</button>
        <button onClick={() => scrollTo('pricing')}>Pricing</button>
        <button className="lp-btn-primary" onClick={() => scrollTo('early-access')}>Get early access</button>
      </div>

      {/* HERO */}
      <section className="lp-hero">
        <div className="lp-hero-content">
          <div className="lp-hero-badge visible">
            <span className="lp-hero-badge-dot" /> 1st Place &middot; PA DECA States 2025
          </div>
          <h1>
            Plans die in group chats.<br />
            <span className="lp-gradient-text">Flock</span> fixes that.
          </h1>
          <p className="lp-hero-sub visible">
            Create a flock. Invite friends. Match budgets without the awkwardness. Vote on venues. Actually go.
          </p>
          <div className="lp-hero-ctas visible">
            <button className="lp-btn-primary" onClick={() => scrollTo('early-access')}>Get early access</button>
            <button className="lp-btn-ghost" onClick={() => scrollTo('how-it-works')}>See how it works &rarr;</button>
          </div>
          <div className="lp-hero-screenshots visible">
            <div className="lp-screenshot-phone"><img src="/screenshots/messages.png" alt="Messages" /></div>
            <div className="lp-screenshot-phone"><img src="/screenshots/home.png" alt="Home" /></div>
            <div className="lp-screenshot-phone"><img src="/screenshots/crowd.png" alt="Crowd" /></div>
          </div>
        </div>
      </section>

      {/* SOCIAL PROOF */}
      <section className="lp-proof">
        <div className="lp-proof-inner">
          <Marquee speed={25}>
            <span style={{ padding: '0 32px', fontSize: '14px', fontWeight: 500, color: 'var(--lp-text-3)' }}>
              Moravian Academy &nbsp;&middot;&nbsp; Liberty High School &nbsp;&middot;&nbsp; Freedom High School &nbsp;&middot;&nbsp; Emmaus High School &nbsp;&middot;&nbsp; Parkland High School &nbsp;&middot;&nbsp;
            </span>
          </Marquee>
          <div className="lp-proof-chips">
            <span className="lp-chip">DECA ICDC 2026</span>
            <span className="lp-chip">2M+ Data Points</span>
            <span className="lp-chip">21 Cities and Growing</span>
          </div>
        </div>
      </section>

      <div className="lp-divider" />

      {/* HOW IT WORKS */}
      <section className="lp-section" id="how-it-works">
        <div className="lp-inner">
          <div className="gsap-reveal">
            <span className="lp-eyebrow">THE CORE LOOP</span>
            <h2 style={{ fontSize: 'clamp(28px, 4vw, 48px)', fontWeight: 800, letterSpacing: '-0.025em', marginBottom: 48 }}>
              Five steps. Zero group chat chaos.
            </h2>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {HOW_STEPS.map((step, i) => (
              <div key={step.num} className="gsap-reveal" style={{ background: 'var(--lp-elevated)', border: '1px solid var(--lp-border)', borderRadius: 16, padding: 24 }}>
                <div style={{ fontSize: 48, fontWeight: 900, color: 'rgba(13,148,136,0.15)', lineHeight: 1, marginBottom: 8 }}>{step.num}</div>
                <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{step.title}</h3>
                <p style={{ fontSize: 14, color: 'var(--lp-text-2)', lineHeight: 1.6 }}>{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="lp-divider" />

      {/* BUDGET */}
      <section className="lp-section" id="features">
        <div className="lp-inner">
          <div className="gsap-reveal">
            <span className="lp-eyebrow">THE FEATURE THAT CHANGES EVERYTHING</span>
            <h2 style={{ fontSize: 'clamp(28px, 4vw, 48px)', fontWeight: 800, lineHeight: 1.1, margin: '12px 0 20px' }}>Money kills more plans than distance.</h2>
            <p style={{ fontSize: 17, lineHeight: 1.65, color: 'var(--lp-text-2)', marginBottom: 24 }}>
              Someone suggests somewhere expensive. Two people go quiet. The plan dies. Flock's anonymous budget matching changes this.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 32 }}>
              <div className="lp-budget-check"><IcoCheck /> Only you see your budget</div>
              <div className="lp-budget-check"><IcoCheck /> No averages, no distributions, no hints</div>
              <div className="lp-budget-check"><IcoCheck /> The group ceiling deletes 24h after the flock ends</div>
            </div>
          </div>
          <div className="gsap-reveal" style={{ display: 'flex', justifyContent: 'center' }}>
            <div className="lp-screenshot-phone" style={{ width: 260 }}>
              <img src="/screenshots/split.png" alt="Budget matching" />
            </div>
          </div>
        </div>
      </section>

      <div className="lp-divider" />

      {/* FEATURES */}
      <section className="lp-section">
        <div className="lp-inner">
          <div className="gsap-reveal">
            <h2 style={{ fontSize: 'clamp(28px, 4vw, 48px)', fontWeight: 800, marginBottom: 8 }}>Everything your friend group needs.</h2>
            <p style={{ fontSize: 17, color: 'var(--lp-text-2)', marginBottom: 48 }}>Built for the planner who's tired of doing it all.</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {FEATURES.map((f, i) => (
              <div key={f.title} className="gsap-reveal" style={{ background: 'var(--lp-elevated)', border: '1px solid var(--lp-border)', borderRadius: 16, padding: 24 }}>
                <div style={{ width: 44, height: 44, borderRadius: 10, background: f.bg, color: f.color, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>{f.icon}</div>
                <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>{f.title}</h3>
                <p style={{ fontSize: 14, color: 'var(--lp-text-2)', lineHeight: 1.6 }}>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="lp-divider" />

      {/* STATS */}
      <section className="lp-section">
        <div className="lp-inner">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 24, textAlign: 'center' }}>
            {[
              { num: '15\u201322', label: 'Target age group \u2014 the prime coordination years' },
              { num: '3\u20138', label: 'Ideal flock size \u2014 large enough to need coordination' },
            ].map(s => (
              <div key={s.num} className="gsap-reveal">
                <div className="lp-stat-num lp-gradient-text">{s.num}</div>
                <div className="lp-stat-label">{s.label}</div>
              </div>
            ))}
            <div className="gsap-reveal">
              <div className="lp-stat-num lp-gradient-text">~<CountUpScramble target={47} suffix="%" /></div>
              <div className="lp-stat-label">of Gen Z say money stress affects social plans</div>
            </div>
            <div className="gsap-reveal">
              <div className="lp-stat-num lp-gradient-text">#<CountUpScramble target={1} /></div>
              <div className="lp-stat-label">PA DECA Innovation Plan</div>
            </div>
          </div>
        </div>
      </section>

      <div className="lp-divider" />

      {/* PRICING */}
      <section className="lp-section" id="pricing">
        <div className="lp-inner" style={{ textAlign: 'center' }}>
          <div className="gsap-reveal">
            <span className="lp-eyebrow">EARLY ACCESS</span>
            <h2 style={{ fontSize: 'clamp(28px, 4vw, 48px)', fontWeight: 800, marginBottom: 8 }}>Free while we're in beta.</h2>
            <p className="lp-pricing-sub">Flock is actively being used and developed. Get early access now.</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
            <div className="lp-price-card gsap-reveal" style={{ maxWidth: 380, width: '100%' }}>
              <div className="lp-price-tier">Free</div>
              <div className="lp-price-amount">$0</div>
              <div className="lp-price-period">Forever free core features</div>
              <div className="lp-price-features">
                {['Create unlimited flocks', 'Anonymous budget matching', 'Venue voting', 'Real-time flock chat', 'Friend system + QR codes', 'Safety features'].map(f => (
                  <div key={f} className="lp-price-feature"><IcoCheck size={14} /> {f}</div>
                ))}
              </div>
              <button className="lp-btn-outline" onClick={() => scrollTo('early-access')}>Get started free</button>
            </div>
            <div className="lp-price-card lp-price-card--premium gsap-reveal" style={{ maxWidth: 380, width: '100%' }}>
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
                {['Everything in Free', 'Flock templates', 'AI venue recommendations', 'Unlimited flock history', 'Advanced reliability analytics', 'Priority support'].map(f => (
                  <div key={f} className="lp-price-feature"><IcoCheck size={14} /> {f}</div>
                ))}
              </div>
              <button className="lp-btn-primary" onClick={() => scrollTo('early-access')}>Join waitlist</button>
            </div>
          </div>
        </div>
      </section>

      <div className="lp-divider" />

      {/* BIRDIE */}
      <section className="lp-birdie">
        <div className="lp-birdie-inner" style={{ flexDirection: 'column', textAlign: 'center' }}>
          <div className="gsap-reveal">
            <span className="lp-eyebrow">AI-POWERED</span>
            <h2 className="lp-birdie-title">Meet <span className="lp-gradient-text">Birdie</span></h2>
            <p className="lp-birdie-desc" style={{ marginLeft: 'auto', marginRight: 'auto' }}>
              Your AI planning assistant that lives inside every flock. Birdie suggests venues based on your group's vibe, budget, and location.
            </p>
            <div className="lp-birdie-features" style={{ alignItems: 'center' }}>
              <div className="lp-birdie-feat"><div className="lp-birdie-feat-dot" /><span>Smart venue recommendations</span></div>
              <div className="lp-birdie-feat"><div className="lp-birdie-feat-dot" /><span>Real-time crowd predictions</span></div>
              <div className="lp-birdie-feat"><div className="lp-birdie-feat-dot" /><span>Knows your budget, your vibe, your crew</span></div>
            </div>
          </div>
          <div className="gsap-reveal" style={{ width: '100%', height: 400 }}>
            <Suspense fallback={<div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div style={{ width: 40, height: 40, borderRadius: '50%', border: '3px solid rgba(245,240,232,0.1)', borderTopColor: 'var(--lp-accent)', animation: 'spin 0.8s linear infinite' }} /></div>}>
              <Spline scene="https://prod.spline.design/kZDDjO5HuC9GJUM2/scene.splinecode" />
            </Suspense>
          </div>
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="lp-final-cta" id="early-access">
        <div className="lp-final-content gsap-reveal">
          <h2>Your friend group's plans are dying in a group chat.</h2>
          <p className="lp-final-cta-sub">Flock fixes the coordination. Fixes the money awkwardness. Gets you all in the same room.</p>
          {submitted ? (
            <div className="lp-cta-confirmed">{waitlistMsg}</div>
          ) : (
            <form className="lp-cta-form" onSubmit={handleWaitlist}>
              <input className="lp-cta-input" type="email" placeholder="you@email.com" value={email} onChange={e => setEmail(e.target.value)} required />
              <button className="lp-btn-primary" type="submit">Join Waitlist</button>
            </form>
          )}
          <span className="lp-cta-note">No credit card. No commitment. Takes 30 seconds.</span>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="lp-footer">
        <div className="lp-footer-inner">
          <div className="lp-footer-brand">
            <div className="lp-nav-brand"><span className="lp-nav-wordmark">Flock</span></div>
            <span className="lp-footer-tagline">Social Coordination Simplified</span>
            <span className="lp-footer-copy-line">&copy; 2026 Flock</span>
          </div>
          <div className="lp-footer-links">
            <h4>Product</h4>
            <button onClick={() => scrollTo('features')}>Features</button>
            <button onClick={() => scrollTo('pricing')}>Pricing</button>
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
