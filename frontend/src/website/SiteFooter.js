import React from 'react';

/* The one footer for the seven public pages: LandingPage, AboutPage,
   SupportPage, PrivacyPolicy, TermsOfService, CommunityGuidelines and
   DeleteAccount. Each of them used to hand-roll its own, and the seven had
   already drifted three ways: About and Support carried a brand line and the
   mailbox but no legal links, Privacy carried legal links but no mailbox, and
   Terms, Guidelines and Delete account carried nothing but a copyright line.

   THE CONTRACT this component carries, on every page that adopts it:

     - The four legal links (DESIGN-STANDARD A5): /privacy, /terms, /guidelines and
       /delete-account. /delete-account is also the public URL Google Play
       requires, so it must be reachable from everywhere.
     - The contact mailbox, and ONLY the social@ one (see CONTACT_EMAIL
       below). It is the one address that is actually forwarded and read;
       __tests__/legalPagesMatchCode.test.js pins that no other address at
       the flock domain appears on the legal pages, and
       __tests__/siteFooter.test.js pins it for this file.
     - The copyright line.
     - A real <footer> element. On the landing page it sits OUTSIDE <main> and
       is therefore a contentinfo landmark. On the legal pages it must sit
       INSIDE <main class="pp">, because .pp paints the whole page (tokens,
       paper background, padding) and a footer outside it would lose all of
       them; a nested <footer> is the footer of the document there, and it is
       deliberately NOT given role="contentinfo", which axe flags when nested
       inside another landmark.
     - The surface class comes from the caller (pp-footer / lp-footer), so
       each surface keeps the contrast tokens its accessibility pass settled:
       --pp-ink-3 (#586473 light, 5.14:1 on paper) for the legal pages,
       --cream-3 on --navy-deep (pinned at 4.5:1 by
       marketingSiteAccessibility.test.js) for the landing page. Both token
       sets are themselves under test; nothing here declares a colour.

   linkStyle threads an inline colour override onto every link the legal
   variant renders. Support passes its READABLE token
   ({ color: 'var(--pp-ink-2)' }): marketingSiteAccessibility.test.js pins, by
   source scan of that file, that every footer anchor there carries
   style={READABLE}, which is also why it passes its lead line as children
   with the anchor written out in its own source. (/about carried the same
   override until it moved to the landing variant on 2026-10-21.) The pin wins;
   this component adapts to it.

   House copy rules apply (DESIGN-STANDARD A2): no em dashes anywhere in what this
   file renders. Separators are middle dots, like the pages it replaced. */

const CONTACT_EMAIL = 'social@flockcorp.com';
const YOUTUBE_URL = 'https://www.youtube.com/@flock-social2026';

const LEGAL_LINKS = [
  { href: '/privacy', label: 'Privacy Policy' },
  { href: '/terms', label: 'Terms of Service' },
  { href: '/guidelines', label: 'Community Guidelines' },
  { href: '/delete-account', label: 'Delete your account' },
];

export default function SiteFooter({
  variant = 'legal',
  className,
  linkStyle,
  brand,
  children,
  ...rest
}) {
  const year = new Date().getFullYear();

  if (variant === 'landing') {
    /* The landing footer, used by the landing page and the other pages built
       on its stylesheet (/how-it-works, /about, /research). Two plain lines and one row of links
       rather than the three-column Product / Company grid every generated
       site ends on. Every link is absolute, so it works from any page. The
       legal links come from the same LEGAL_LINKS the legal pages render, so
       the two variants cannot drift apart. `rest` carries the page's inert
       spread: the whole footer goes inert behind the open menu. */
    return (
      <footer className={className} {...rest}>
        <div className="lp-wrap">
          <div className="lp-footer-top">
            {brand}
            <p className="lp-footer-blurb">
              Flock Social LLC, a Pennsylvania company. Made by Jayden Bansal and Asad Ali.
            </p>
          </div>
          <ul className="lp-footer-links">
            <li><a href="/how-it-works">How it works</a></li>
            <li><a href="/research">Research</a></li>
            <li><a href="/about">About</a></li>
            <li><a href="/support">Support</a></li>
            <li><a href="/app">Sign in</a></li>
            <li><a href={YOUTUBE_URL} target="_blank" rel="noopener noreferrer">YouTube</a></li>
            {LEGAL_LINKS.map((l) => (
              <li key={l.href}><a href={l.href}>{l.label}</a></li>
            ))}
            <li><a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></li>
          </ul>
          <div className="lp-footer-base">
            <span>&copy; {year} Flock Social LLC.</span>
            {/* The data credit doubles as BestTime's standing backlink offer
                (free credits for a link). A plain factual credit in the base
                row, the same register as the copyright beside it: crowd
                forecasts really are built on their foot-traffic data. */}
            <span>Crowd data by <a href="https://besttime.app" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>BestTime.app</a></span>
          </div>
        </div>
      </footer>
    );
  }

  /* The legal-page footer. `children` is an optional lead line a page can put
     above the shared rows (About and Support keep their brand line there);
     PrivacyPolicy.css gives it its own full-width row. */
  return (
    <footer className={className}>
      {children}
      <span>&copy; {year} Flock Social LLC.</span>
      <span>
        {LEGAL_LINKS.map((l, i) => (
          <React.Fragment key={l.href}>
            {i > 0 ? <> &middot; </> : null}
            <a href={l.href} style={linkStyle}>{l.label}</a>
          </React.Fragment>
        ))}
        <> &middot; </>
        <a href={`mailto:${CONTACT_EMAIL}`} style={linkStyle}>{CONTACT_EMAIL}</a>
      </span>
    </footer>
  );
}
