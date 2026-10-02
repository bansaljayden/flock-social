import React, { useEffect, useRef, useState } from 'react';

/* The site menu, for pages other than the landing page. LandingPage.js keeps
   its own copy of the same header and panel (it is pinned by its own tests);
   this one renders the identical markup on the landing page's classes, so a
   page that loads LandingPage.css gets the same bar, the same corner block and
   the same full-screen panel.

   NAV_LINKS is the one list both menus read, so the two can never offer
   different destinations. The first six are sections of the landing page;
   off it they point at /#section. /research is the one destination off the
   page, and the menu is the only place it is linked. */
export const NAV_LINKS = [
  { href: '#how', label: 'How it works' },
  { href: '#try', label: 'Try it live' },
  { href: '#birdie', label: 'Birdie' },
  { href: '#money', label: 'Money' },
  { href: '#safety', label: 'Safety' },
  { href: '#pricing', label: 'Pricing' },
  { href: '/research', label: 'Research' },
];

/* Open/close state and the behaviour the landing page's menu has: while open,
   page scroll is locked on the ROOT element (a lock on <body> breaks the
   sticky bar; LandingPage.js has the full story), Escape closes, Tab cycles
   through the corner block and the panel's links, and closing hands focus back
   to the block that opened it. */
export function useSiteMenu() {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const menuBtnRef = useRef(null);
  const wasMenuOpen = useRef(false);
  // Set when the menu closed because the screen widened past the button.
  const closedWideRef = useRef(false);

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

    // From 1200px the bar carries the section links and the menu button is
    // display: none, so a menu still open at that width has no close control,
    // and the Tab trap below cycles onto a button that cannot take focus.
    // Rotating a tablet to landscape does exactly that, so crossing the
    // breakpoint closes the menu. (The 1200 is .lp-nav-links' in the CSS.)
    const wide = typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 1200px)') : null;
    const onWide = (e) => {
      if (!e.matches) return;
      closedWideRef.current = true;
      setMenuOpen(false);
    };
    if (wide && wide.addEventListener) wide.addEventListener('change', onWide);
    else if (wide && wide.addListener) wide.addListener(onWide);

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (wide && wide.removeEventListener) wide.removeEventListener('change', onWide);
      else if (wide && wide.removeListener) wide.removeListener(onWide);
      root.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPad;
      document.body.style.removeProperty('--lp-scrollbar');
    };
  }, [menuOpen]);

  useEffect(() => {
    if (wasMenuOpen.current && !menuOpen && menuBtnRef.current) {
      // Closed by widening, the button is display: none and cannot take focus,
      // so focus would fall to the body once the panel hides. It goes to the
      // first section link in the bar instead: the control that replaced it.
      const bar = closedWideRef.current ? menuBtnRef.current.closest('.lp-nav-in') : null;
      const link = bar ? bar.querySelector('.lp-nav-links a') : null;
      (link || menuBtnRef.current).focus();
    }
    closedWideRef.current = false;
    wasMenuOpen.current = menuOpen;
  }, [menuOpen]);

  return { menuOpen, setMenuOpen, menuRef, menuBtnRef };
}

/* The bar and the panel. `current` is this page's path, so its own link is
   marked aria-current and the landing sections become /#section links. */
export default function SiteNav({ menu, current }) {
  const { menuOpen, setMenuOpen, menuRef, menuBtnRef } = menu;
  const close = () => setMenuOpen(false);
  const links = NAV_LINKS.map((l) => ({ ...l, href: l.href.startsWith('#') ? `/${l.href}` : l.href }));

  return (
    <>
      <header className={`lp-nav${menuOpen ? ' is-menu-open' : ''}`}>
        <div className="lp-wrap lp-nav-in">
          <a className="lp-brand" href="/">
            <img
              src="/marks/logo-64.png"
              width="32"
              height="32"
              alt=""
              aria-hidden="true"
              style={{ borderRadius: '50%', display: 'block' }}
            />
            Flock
          </a>
          <nav className="lp-nav-links" aria-label="Sections">
            {links.map((l) => (
              <a key={l.href} href={l.href} aria-current={l.href === current ? 'page' : undefined}>
                {l.label}
              </a>
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

      <div id="lp-menu" ref={menuRef} className={`lp-menu${menuOpen ? ' is-open' : ''}`}>
        <nav className="lp-menu-in" aria-label="Site menu">
          {links.map((l, i) => (
            <a
              key={l.href}
              className={`lp-menu-link${i === links.length - 1 ? ' is-last' : ''}`}
              href={l.href}
              aria-current={l.href === current ? 'page' : undefined}
              onClick={close}
            >
              {l.label}
            </a>
          ))}
          <a className="lp-btn lp-btn-cream lp-btn-lg lp-menu-cta" href="/app" onClick={close}>
            Open Flock
          </a>
        </nav>
      </div>
    </>
  );
}
