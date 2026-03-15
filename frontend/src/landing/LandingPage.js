import React, { useState, useEffect, useRef, useCallback } from 'react';
import './LandingPage.css';

/* ─── Bird logo SVG (matches flock-logo.png: 3 birds in formation) ─── */
function BirdLogo({ size = 32, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill={color} xmlns="http://www.w3.org/2000/svg">
      <path d="M38 18c-3-5-9-8-15-6 4-1 8 0 11 3-2-2-5-4-9-3 5-2 10 0 13 6z" />
      <path d="M48 10c-3-5-9-8-15-6 4-1 8 0 11 3-2-2-5-4-9-3 5-2 10 0 13 6z" />
      <path d="M28 28c-3-5-9-8-15-6 4-1 8 0 11 3-2-2-5-4-9-3 5-2 10 0 13 6z" />
    </svg>
  );
}

/* ─── Section icons ─── */
function IconPlus() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="14" cy="14" r="12" /><line x1="14" y1="8" x2="14" y2="20" /><line x1="8" y1="14" x2="20" y2="14" />
    </svg>
  );
}
function IconShield() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3L4 8v6c0 6.5 4.3 12.6 10 14 5.7-1.4 10-7.5 10-14V8L14 3z" />
      <path d="M10 14l3 3 5-6" />
    </svg>
  );
}
function IconPin() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3C9.6 3 6 6.4 6 10.5 6 17 14 25 14 25s8-8 8-14.5C22 6.4 18.4 3 14 3z" />
      <circle cx="14" cy="10.5" r="3" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 15l5 5L22 8" />
    </svg>
  );
}
function IconShieldSmall() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L3 7v5c0 5.5 3.8 10.7 9 12 5.2-1.3 9-6.5 9-12V7L12 2z" />
    </svg>
  );
}

/* ─── Scroll animation hook ─── */
function useScrollFade() {
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('landed-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    const els = document.querySelectorAll('.land-fade');
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);
}

/* ─── Count-up animation ─── */
function CountUp({ target, suffix = '', prefix = '' }) {
  const ref = useRef(null);
  const animated = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !animated.current) {
          animated.current = true;
          const duration = 1500;
          const start = performance.now();
          const step = (now) => {
            const t = Math.min((now - start) / duration, 1);
            const ease = 1 - Math.pow(1 - t, 3);
            const val = Math.floor(ease * target);
            el.textContent = prefix + val.toLocaleString() + suffix;
            if (t < 1) requestAnimationFrame(step);
            else el.textContent = prefix + target.toLocaleString() + suffix;
          };
          requestAnimationFrame(step);
          observer.unobserve(el);
        }
      },
      { threshold: 0.5 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [target, suffix, prefix]);

  return <span ref={ref}>0</span>;
}

/* ─── Phone Mockup ─── */
function PhoneMockup() {
  return (
    <div className="phone-frame">
      <div className="phone-notch" />
      <div className="phone-screen">
        <div className="phone-header">
          <span className="phone-greeting">Good evening,</span>
          <span className="phone-name">Jayden</span>
        </div>
        <div className="phone-card">
          <div className="phone-card-badge" style={{ background: '#0d9488' }}>Tonight</div>
          <div className="phone-card-title">Friday Dinner</div>
          <div className="phone-card-meta">5 going &middot; 8:00 PM</div>
          <div className="phone-card-avatars">
            <div className="phone-avatar" style={{ background: '#0d9488' }}>J</div>
            <div className="phone-avatar" style={{ background: '#6366f1' }}>S</div>
            <div className="phone-avatar" style={{ background: '#f59e0b' }}>M</div>
            <div className="phone-avatar" style={{ background: '#ec4899' }}>T</div>
            <div className="phone-avatar" style={{ background: '#8b5cf6' }}>A</div>
          </div>
        </div>
        <div className="phone-card">
          <div className="phone-card-badge" style={{ background: '#f59e0b' }}>Saturday</div>
          <div className="phone-card-title">Weekend Plans</div>
          <div className="phone-card-meta">3 going &middot; 2:00 PM</div>
          <div className="phone-card-avatars">
            <div className="phone-avatar" style={{ background: '#0d9488' }}>J</div>
            <div className="phone-avatar" style={{ background: '#ec4899' }}>T</div>
            <div className="phone-avatar" style={{ background: '#6366f1' }}>S</div>
          </div>
        </div>
        <div className="phone-nav">
          <div className="phone-nav-item phone-nav-active">
            <div className="phone-nav-dot" />Home
          </div>
          <div className="phone-nav-item">Explore</div>
          <div className="phone-nav-item">Friends</div>
          <div className="phone-nav-item">Profile</div>
        </div>
      </div>
    </div>
  );
}

/* ─── Feature Mockups ─── */
function BudgetMockup() {
  return (
    <div className="mockup-card">
      <div className="mockup-label">Your Budget</div>
      <div className="mockup-sublabel">Private &middot; no one sees your amount</div>
      <div className="mockup-budget-grid">
        <button className="mockup-budget-btn">$20</button>
        <button className="mockup-budget-btn">$40</button>
        <button className="mockup-budget-btn mockup-budget-selected">$60</button>
        <button className="mockup-budget-btn">$80+</button>
      </div>
      <div className="mockup-privacy">
        <IconShield />
        <span>Only you can see this amount</span>
      </div>
      <button className="mockup-cta-btn">Submit Budget</button>
    </div>
  );
}

function CrowdMockup() {
  return (
    <div className="mockup-card">
      <div className="mockup-venue-name">The Corner Spot</div>
      <div className="mockup-gauge">
        <div className="mockup-gauge-ring">
          <span className="mockup-gauge-num">62</span>
          <span className="mockup-gauge-label">Moderate</span>
        </div>
      </div>
      <div className="mockup-bars">
        {[25, 35, 50, 72, 85, 62, 40, 30].map((h, i) => (
          <div key={i} className="mockup-bar-col">
            <div className="mockup-bar" style={{ height: `${h}%` }} />
            <span>{i + 5}pm</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SplitMockup() {
  const people = [
    { name: 'Jayden', init: 'J', color: '#0d9488', done: true },
    { name: 'Sarah', init: 'S', color: '#6366f1', done: true },
    { name: 'Marcus', init: 'M', color: '#f59e0b', done: false },
    { name: 'Tyler', init: 'T', color: '#ec4899', done: false },
  ];
  return (
    <div className="mockup-card">
      <div className="mockup-label">Split the Bill</div>
      <div className="mockup-total">Total: $127.50</div>
      <div className="mockup-split-list">
        {people.map((p) => (
          <div key={p.name} className="mockup-split-row">
            <div className="mockup-split-avatar" style={{ background: p.color }}>{p.init}</div>
            <span className="mockup-split-name">{p.name}</span>
            <span className="mockup-split-amount">$31.88</span>
            <span className={`mockup-split-check ${p.done ? 'done' : ''}`}>{p.done ? '\u2713' : ''}</span>
          </div>
        ))}
      </div>
      <button className="mockup-cta-btn mockup-venmo">Open Venmo</button>
    </div>
  );
}

function ChatMockup() {
  return (
    <div className="mockup-card mockup-chat">
      <div className="mockup-chat-header">Friday Dinner</div>
      <div className="mockup-chat-msgs">
        <div className="mockup-msg mockup-msg-other">
          <div className="mockup-msg-avatar" style={{ background: '#6366f1' }}>S</div>
          <div className="mockup-msg-bubble">8pm works for me!</div>
        </div>
        <div className="mockup-msg-venue">
          <div className="mockup-msg-venue-name">The Smith</div>
          <div className="mockup-msg-venue-meta">4.7 &middot; $$ &middot; American</div>
          <div className="mockup-msg-venue-votes">
            <span className="mockup-vote up">2</span>
            <span className="mockup-vote down">0</span>
          </div>
        </div>
        <div className="mockup-msg mockup-msg-other">
          <div className="mockup-msg-avatar" style={{ background: '#f59e0b' }}>M</div>
          <div className="mockup-msg-bubble">I'm in</div>
        </div>
        <div className="mockup-typing">
          <div className="mockup-typing-dot" /><div className="mockup-typing-dot" /><div className="mockup-typing-dot" />
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   LANDING PAGE
   ═══════════════════════════════════════════════════ */

export default function LandingPage() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);

  useScrollFade();

  /* Nav background on scroll */
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 80);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  /* SEO */
  useEffect(() => {
    document.title = 'Flock \u2014 Social Coordination Simplified';
  }, []);

  const scrollTo = useCallback((id) => {
    setMenuOpen(false);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const [waitlistMsg, setWaitlistMsg] = useState('');

  const handleWaitlist = async (e) => {
    e.preventDefault();
    if (!email) return;
    try {
      const API = process.env.REACT_APP_API_URL || 'https://flock-app-production.up.railway.app';
      const res = await fetch(`${API}/api/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (res.ok) {
        setSubmitted(true);
        setWaitlistMsg(data.message || "You're on the list.");
        setEmail('');
      } else {
        setWaitlistMsg(data.error || 'Something went wrong.');
      }
    } catch {
      // Fallback to localStorage if backend is down
      const list = JSON.parse(localStorage.getItem('flock_waitlist') || '[]');
      list.push({ email, ts: Date.now() });
      localStorage.setItem('flock_waitlist', JSON.stringify(list));
      setSubmitted(true);
      setWaitlistMsg("You're on the list.");
      setEmail('');
    }
  };

  return (
    <div className="landing">

      {/* ── NAV ── */}
      <nav className={`land-nav${scrolled ? ' land-nav--solid' : ''}`}>
        <div className="land-nav-inner">
          <div className="land-logo" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
            <BirdLogo size={28} color="#f5f0e8" />
            <span>FLOCK</span>
          </div>
          <div className={`land-nav-links${menuOpen ? ' open' : ''}`}>
            <button onClick={() => scrollTo('features')}>Features</button>
            <button onClick={() => scrollTo('how-it-works')}>How It Works</button>
            <button onClick={() => scrollTo('about')}>About</button>
            <button className="land-nav-cta" onClick={() => scrollTo('early-access')}>Get Early Access</button>
          </div>
          <button className={`land-hamburger${menuOpen ? ' open' : ''}`} onClick={() => setMenuOpen(!menuOpen)} aria-label="Menu">
            <span /><span /><span />
          </button>
        </div>
      </nav>

      {/* ── HERO ── */}
      <section className="land-hero">
        <div className="land-hero-content">
          <div className="land-hero-text">
            <h1>Plans fall apart.<br />Flock fixes that.</h1>
            <p>The app that turns &ldquo;idk what do you wanna do&rdquo; into a confirmed plan with a venue, a budget, and everyone committed.</p>
            <div className="land-hero-ctas">
              <button className="land-btn-primary" onClick={() => scrollTo('early-access')}>Get Early Access</button>
              <button className="land-btn-outline" onClick={() => scrollTo('how-it-works')}>See How It Works</button>
            </div>
          </div>
          <div className="land-hero-visual">
            <PhoneMockup />
          </div>
        </div>
        <div className="land-scroll-hint">
          <div className="land-scroll-line" />
        </div>
      </section>

      {/* ── SOCIAL PROOF ── */}
      <section className="land-proof">
        <span className="land-proof-label">Recognized by</span>
        <div className="land-proof-badges">
          <div className="land-badge">DECA ICDC 2026</div>
          <div className="land-badge">1st Place &mdash; PA State</div>
          <div className="land-badge">Built at Moravian Academy</div>
        </div>
      </section>

      {/* ── PROBLEM ── */}
      <section className="land-problem">
        <div className="land-problem-inner land-fade">
          <blockquote>
            The average group chat takes 37 messages to pick a restaurant. Half the time, the plan still dies.
          </blockquote>
          <p className="land-problem-tag">Sound familiar?</p>
        </div>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section className="land-how" id="how-it-works">
        <div className="land-section-inner">
          <h2 className="land-section-title land-fade">How Flock Works</h2>
          <div className="land-steps">
            {[
              { num: '01', icon: <IconPlus />, title: 'Start a Flock', desc: 'Name it, set the vibe, invite your people.' },
              { num: '02', icon: <IconShield />, title: 'Set Budgets Anonymously', desc: 'Everyone enters their max. No one sees yours. Venues filter automatically.' },
              { num: '03', icon: <IconPin />, title: 'Vote on Venues', desc: 'AI crowd predictions show what\u2019s busy and what\u2019s not. Group votes. Best spot wins.' },
              { num: '04', icon: <IconCheck />, title: 'Go', desc: 'Time, place, budget\u2014locked. One tap splits the bill through Venmo after.' },
            ].map((step, i) => (
              <div className={`land-step land-fade`} key={step.num} style={{ transitionDelay: `${i * 100}ms` }}>
                <span className="land-step-num">{step.num}</span>
                <div className="land-step-icon">{step.icon}</div>
                <h3>{step.title}</h3>
                <p>{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section className="land-features" id="features">
        {/* Feature 1 — Budget */}
        <div className="land-feature land-feature--dark">
          <div className="land-section-inner land-feature-row land-fade">
            <div className="land-feature-text">
              <span className="land-feature-label">BUDGET MATCHING</span>
              <h2>Money doesn&rsquo;t kill the plan anymore</h2>
              <p>Everyone privately sets their max budget. Flock calculates the group ceiling without revealing who set it. Venues filter automatically. No awkward conversations. No one gets left out.</p>
            </div>
            <div className="land-feature-visual">
              <BudgetMockup />
            </div>
          </div>
        </div>

        {/* Feature 2 — Crowd AI */}
        <div className="land-feature land-feature--light">
          <div className="land-section-inner land-feature-row land-feature-row--reverse land-fade">
            <div className="land-feature-text">
              <span className="land-feature-label">AI CROWD FORECASTING</span>
              <h2>Know before you go</h2>
              <p>Our ML model trained on 870,000+ real foot traffic data points predicts venue busyness across 13 cities. Live weather adjustments. Hourly forecasts. Quieter alternatives suggested automatically.</p>
            </div>
            <div className="land-feature-visual">
              <CrowdMockup />
            </div>
          </div>
        </div>

        {/* Feature 3 — Bill Split */}
        <div className="land-feature land-feature--dark">
          <div className="land-section-inner land-feature-row land-fade">
            <div className="land-feature-text">
              <span className="land-feature-label">SETTLE UP</span>
              <h2>Split it. Venmo it. Done.</h2>
              <p>After the hangout, one tap creates the split. One tap opens Venmo pre-filled. No payment processing. No fees. Ghost Mode lets you pre-commit your share before arriving&mdash;so people actually show.</p>
            </div>
            <div className="land-feature-visual">
              <SplitMockup />
            </div>
          </div>
        </div>

        {/* Feature 4 — Real-time */}
        <div className="land-feature land-feature--light">
          <div className="land-section-inner land-feature-row land-feature-row--reverse land-fade">
            <div className="land-feature-text">
              <span className="land-feature-label">LIVE COORDINATION</span>
              <h2>Everything happens in real time</h2>
              <p>Messages, typing indicators, venue votes, RSVP updates, location sharing&mdash;all instant via WebSockets. When someone confirms, everyone knows.</p>
            </div>
            <div className="land-feature-visual">
              <ChatMockup />
            </div>
          </div>
        </div>
      </section>

      {/* ── STATS ── */}
      <section className="land-stats">
        <div className="land-section-inner">
          <div className="land-stats-grid">
            <div className="land-stat land-fade">
              <div className="land-stat-num"><CountUp target={870} suffix="K+" /></div>
              <div className="land-stat-label">Training data points for crowd AI</div>
            </div>
            <div className="land-stat land-fade" style={{ transitionDelay: '100ms' }}>
              <div className="land-stat-num"><CountUp target={13} /></div>
              <div className="land-stat-label">Cities with ML coverage</div>
            </div>
            <div className="land-stat land-fade" style={{ transitionDelay: '200ms' }}>
              <div className="land-stat-num"><CountUp target={0} prefix="$" /></div>
              <div className="land-stat-label">Payment processing fees</div>
            </div>
            <div className="land-stat land-fade" style={{ transitionDelay: '300ms' }}>
              <div className="land-stat-num"><CountUp target={0} prefix="$" /></div>
              <div className="land-stat-label">API cost per prediction</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── SAFETY ── */}
      <section className="land-safety land-fade">
        <div className="land-section-inner land-safety-inner">
          <div className="land-safety-icon"><IconShieldSmall /></div>
          <div>
            <h3>Safety built in, not bolted on</h3>
            <p>One-tap SOS sends your live GPS to trusted contacts. Emergency alerts via email. Location sharing in every flock. Because plans should be fun, not stressful.</p>
          </div>
        </div>
      </section>

      {/* ── EARLY ACCESS CTA ── */}
      <section className="land-cta" id="early-access">
        <div className="land-section-inner land-cta-inner land-fade">
          <h2>Stop planning in group chats</h2>
          <p>Flock is launching soon. Get early access.</p>
          {submitted ? (
            <div className="land-cta-confirmed">{waitlistMsg}</div>
          ) : (
            <form className="land-cta-form" onSubmit={handleWaitlist}>
              <input
                type="email"
                placeholder="you@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <button type="submit">Join Waitlist</button>
            </form>
          )}
          <span className="land-cta-note">Available on iOS and Android &mdash; 2026</span>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="land-footer" id="about">
        <div className="land-section-inner land-footer-inner">
          <div className="land-footer-brand">
            <div className="land-logo">
              <BirdLogo size={24} color="#f5f0e8" />
              <span>FLOCK</span>
            </div>
            <span className="land-footer-tagline">Social Coordination Simplified</span>
          </div>
          <div className="land-footer-links">
            <button onClick={() => scrollTo('features')}>Features</button>
            <button onClick={() => scrollTo('how-it-works')}>How It Works</button>
            <button onClick={() => scrollTo('early-access')}>Early Access</button>
          </div>
          <div className="land-footer-credit">
            <span>Built by Jayden Bansal</span>
            <span>1st Place PA DECA</span>
          </div>
        </div>
        <div className="land-footer-copy">&copy; 2026 Flock. All rights reserved.</div>
      </footer>
    </div>
  );
}
