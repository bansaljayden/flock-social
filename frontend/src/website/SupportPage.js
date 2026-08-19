import React, { useEffect } from 'react';
import './PrivacyPolicy.css';
import SiteFooter from './SiteFooter';

const SUPPORT_EMAIL = 'social@flockcorp.com';

// See the same constant in AboutPage.js for the history. Short version: this
// override predates the fix to --pp-ink-3 (once #6b7a8c at a failing 3.75:1,
// now #586473 at 5.14:1 in PrivacyPolicy.css). It stays because
// marketingSiteAccessibility.test.js pins it by source scan and --pp-ink-2
// (8.14:1 light, 10.12:1 dark) reads better for these strings anyway.
const READABLE = { color: 'var(--pp-ink-2)' };

// PER-ROUTE <title> AND <meta name="description">.
//
// CRA has no server rendering, so public/index.html is the byte-for-byte
// response for /, /about, /support, /privacy, /terms, /guidelines and
// /delete-account alike, and its one static description was therefore the
// description all six subpages shipped with: /privacy described itself to
// searchers as "Vote on where to go, see how busy it is before you leave".
// There is no head manager in this app and adding one is a dependency, so the
// mechanism is the one LandingPage.js already uses: rewrite the tag that
// index.html ships, from this route's own effect. Googlebot renders JS and
// reads the rewritten value. Scrapers that do not run JS (iMessage, Slack,
// Discord) keep the static og: block in index.html, which is why that block
// has to stay generic and true.
const DESCRIPTION = 'Answers on signing in, notifications, location, deleting your account, how budget matching stays private, and what happens when you tap SOS.';

// The seven questions below are the ones rendered on this page, and the answers
// are the paragraphs under them word for word. Structured data that describes
// content the page does not carry is fabricated markup, so
// __tests__/marketingRouteMetadata.test.js renders the page and compares every
// question and answer here against the DOM rather than trusting this list.
const FAQ = [
  {
    q: "Why can't I sign in to Flock?",
    a: 'Check that the email matches the one you signed up with. If you signed up with Google '
      + 'or Apple, use the same button. A password account isn\'t created automatically. '
      + 'Still stuck? Email me with the email you tried.',
  },
  {
    q: 'Why am I not getting Flock notifications?',
    a: 'Open Settings → Notifications → Flock and confirm Allow Notifications is on. On iOS, '
      + "also check that Focus modes aren't silencing them. Inside the app, go to Profile and "
      + 'check that Push Notifications shows as enabled.',
  },
  {
    q: "Why isn't the map showing my location?",
    a: 'Settings → Privacy & Security → Location Services → Flock should be set to "While '
      + 'Using the App." If it\'s set to Never, the Discover map won\'t be able to center on you.',
  },
  {
    q: 'How do I delete my account?',
    a: "Open Flock and go to Profile → Delete account, then type DELETE to confirm. You'll "
      + 'also enter your password (or sign in again if you use Apple or Google) so nobody else '
      + 'can delete your account from a borrowed phone. This immediately and permanently '
      + 'removes your account, messages, flocks you created, friend connections, and personal '
      + "info. If you can't sign in to delete it yourself, email me from the address on the "
      + "account and I'll do it.",
  },
  {
    q: 'How does the budget feature stay anonymous?',
    a: 'The app server never sends individual budget amounts back to the group. It only sends '
      + 'the aggregate ceiling, the submission count, and whether everyone has submitted. No member '
      + '(including the flock creator) sees what you personally entered.',
  },
  {
    q: 'What happens when I tap SOS?',
    a: 'Your trusted contacts (Profile → Safety → Trusted Contacts) get an email with your '
      + 'current location and a timestamp. Add at least one contact before you need it.',
  },
  {
    q: 'How do I report a bug or suggest a feature?',
    a: `Email ${SUPPORT_EMAIL} with "Bug" or "Feature" `
      + 'in the subject. I go through them every week.',
  },
];

const FAQ_SCHEMA = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  '@id': 'https://www.flockcorp.com/support#faq',
  mainEntity: FAQ.map(({ q, a }) => ({
    '@type': 'Question',
    name: q,
    acceptedAnswer: { '@type': 'Answer', text: a },
  })),
};

export default function SupportPage() {
  useEffect(() => {
    document.title = 'Support and common questions | Flock';
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', DESCRIPTION);

    // FAQPage belongs on this route and NOT in public/index.html: that file is
    // the response for every route, so a FAQPage in it would claim /privacy and
    // /terms carry these questions too. index.html's own JSON-LD comment says
    // the same thing and names this file as where it goes.
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.text = JSON.stringify(FAQ_SCHEMA);
    document.head.appendChild(script);
    return () => { script.remove(); };
  }, []);

  return (
    <main className="pp">
      {/* First focusable element on the page (SLOP-AUDIT Q1), off-screen
          until focused. The header carries tabIndex -1 so activating this
          moves focus with the scroll instead of leaving it behind here. */}
      <a className="pp-skip" href="#pp-content">Skip to the main content</a>

      <a href="/" className="pp-back" style={READABLE}>
        <span aria-hidden="true">&larr;</span> flockcorp.com
      </a>

      <header className="pp-header" id="pp-content" tabIndex={-1}>
        <h1>Support</h1>
        {/* "We're a small team" was neither true nor the strongest thing this
            page could say. /about names one person, a student founder in
            Bethlehem, and a support page that answers in the same voice is a
            better trust signal than an implied headcount. */}
        <p className="pp-meta" style={READABLE}>I read every message.</p>
      </header>

      <section>
        <h2>Contact</h2>
        <p>
          The fastest way to reach me is email:{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </p>
        <p>
          Please include your username, your device (iPhone model + iOS version, or Android model
          + version), and a short description of what you were doing when the issue happened.
          Screenshots help.
        </p>
      </section>

      <section>
        <h2>Common questions</h2>

        <h3>Why can't I sign in to Flock?</h3>
        <p>
          Check that the email matches the one you signed up with. If you signed up with Google
          or Apple, use the same button. A password account isn't created automatically.
          Still stuck? Email me with the email you tried.
        </p>

        <h3>Why am I not getting Flock notifications?</h3>
        <p>
          Open Settings → Notifications → Flock and confirm Allow Notifications is on. On iOS,
          also check that Focus modes aren't silencing them. Inside the app, go to Profile and
          check that Push Notifications shows as enabled.
        </p>

        <h3>Why isn't the map showing my location?</h3>
        <p>
          Settings → Privacy & Security → Location Services → Flock should be set to "While
          Using the App." If it's set to Never, the Discover map won't be able to center on you.
        </p>

        <h3>How do I delete my account?</h3>
        <p>
          Open Flock and go to Profile → Delete account, then type DELETE to confirm. You'll
          also enter your password (or sign in again if you use Apple or Google) so nobody else
          can delete your account from a borrowed phone. This immediately and permanently
          removes your account, messages, flocks you created, friend connections, and personal
          info. If you can't sign in to delete it yourself, email me from the address on the
          account and I'll do it.
        </p>

        <h3>How does the budget feature stay anonymous?</h3>
        <p>
          The app server never sends individual budget amounts back to the group. It only sends
          the aggregate ceiling, the submission count, and whether everyone has submitted. No member
          (including the flock creator) sees what you personally entered.
        </p>

        <h3>What happens when I tap SOS?</h3>
        <p>
          Your trusted contacts (Profile → Safety → Trusted Contacts) get an email with your
          current location and a timestamp. Add at least one contact before you need it.
        </p>

        <h3>How do I report a bug or suggest a feature?</h3>
        <p>
          Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> with "Bug" or "Feature"
          in the subject. I go through them every week.
        </p>
      </section>

      <section>
        <h2>Privacy</h2>
        <p>
          Read the <a href="/privacy">Privacy Policy</a> for details on what Flock collects
          and how it is used.
        </p>
      </section>

      {/* The shared SiteFooter carries the legal links, the mailbox and the
          copyright; the lead line below keeps this page's brand row. The
          anchor is written out here, not defaulted inside SiteFooter, because
          marketingSiteAccessibility.test.js pins BY SOURCE SCAN of this file
          that every footer link carries the READABLE override; linkStyle
          threads the same override onto the links SiteFooter renders. */}
      <SiteFooter className="pp-footer" linkStyle={READABLE}>
        <p>
          Flock &middot; <a href="/" style={READABLE}>flockcorp.com</a>
        </p>
      </SiteFooter>
    </main>
  );
}
