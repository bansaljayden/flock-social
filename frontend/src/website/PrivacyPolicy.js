import React, { useEffect, useRef, useState } from 'react';
import './PrivacyPolicy.css';

const EFFECTIVE_DATE = 'August 14, 2026';
const CONTACT_EMAIL = 'social@flockcorp.com';

// Section order drives both the document and the contents rail.
const SECTIONS = [
  { id: 'who-we-are', title: 'Who we are' },
  { id: 'what-we-collect', title: 'What we collect' },
  { id: 'how-we-use-it', title: 'How we use your information' },
  { id: 'who-we-share-with', title: 'Who we share with' },
  { id: 'how-long', title: 'How long we keep it' },
  { id: 'your-choices', title: 'Your choices and rights' },
  { id: 'children', title: 'Children' },
  { id: 'security', title: 'Security' },
  { id: 'international', title: 'International transfers' },
  { id: 'changes', title: 'Changes to this policy' },
  { id: 'contact', title: 'Contact' },
];

export default function PrivacyPolicy() {
  const [activeId, setActiveId] = useState(SECTIONS[0].id);
  const pinnedRef = useRef(null);

  useEffect(() => {
    document.title = 'Privacy Policy · Flock';
  }, []);

  // Highlight the section you're reading in the contents rail. Scroll-based
  // rather than IntersectionObserver: the last sections are short and never
  // reach an observer's top band, which left the rail stuck on an earlier
  // section while you were looking at Contact.
  useEffect(() => {
    const ids = SECTIONS.map((s) => s.id);
    let raf = 0;

    const update = () => {
      raf = 0;
      // A section you jumped to stays highlighted even when the page has run
      // out of scroll and can't bring it to the top. Cleared on your next scroll.
      if (pinnedRef.current) {
        setActiveId(pinnedRef.current);
        return;
      }
      const doc = document.documentElement;
      if (window.innerHeight + window.scrollY >= doc.scrollHeight - 4) {
        setActiveId(ids[ids.length - 1]);
        return;
      }
      const threshold = 140;
      let current = ids[0];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= threshold) current = id;
      }
      setActiveId(current);
    };

    const onScroll = () => { if (!raf) raf = window.requestAnimationFrame(update); };
    const releasePin = () => { pinnedRef.current = null; };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    // Only a deliberate scroll gesture releases the pin, not the smooth-scroll
    // the click itself triggers.
    window.addEventListener('wheel', releasePin, { passive: true });
    window.addEventListener('touchmove', releasePin, { passive: true });
    window.addEventListener('keydown', releasePin);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('wheel', releasePin);
      window.removeEventListener('touchmove', releasePin);
      window.removeEventListener('keydown', releasePin);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  const mail = <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>;
  const num = (i) => <span className="pp-num">{String(i).padStart(2, '0')}</span>;

  return (
    <main className="pp">
      <a href="/landing" className="pp-back">&larr; flockcorp.com</a>

      <div className="pp-shell">
        <nav className="pp-toc" aria-label="Sections">
          <div className="pp-toc-inner">
          <p className="pp-toc-label">Contents</p>
          <ol>
            {SECTIONS.map((s, i) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  aria-current={activeId === s.id ? 'true' : undefined}
                  onClick={() => { pinnedRef.current = s.id; setActiveId(s.id); }}
                >
                  <span className="pp-toc-num">{String(i + 1).padStart(2, '0')}</span>
                  <span>{s.title}</span>
                </a>
              </li>
            ))}
          </ol>
          </div>
        </nav>

        <div>
          <header className="pp-header">
            <h1>Privacy Policy</h1>
            <p className="pp-meta">Effective {EFFECTIVE_DATE}</p>
          </header>

          <aside className="pp-summary">
            <h2>The short version</h2>
            <ul>
              <li>We collect what Flock needs to work: your account, your plans, your messages.</li>
              <li>Location is used only while you're using the app. Never in the background.</li>
              <li>We don't sell your information, and we don't run ads.</li>
              <li>Budget amounts are never shown to other people. The group only sees a shared ceiling.</li>
              <li>You can delete your account from inside the app. It's a real delete, not a deactivation.</li>
            </ul>
            <p>
              The full detail is below. It's written in plain language on purpose. If
              anything is unclear, email {mail}.
            </p>
          </aside>

          <div className="pp-doc">
            <section id="who-we-are">
              <h2>{num(1)} Who we are</h2>
              <p>
                Flock is a social coordination app that helps you plan nights out with
                friends. Flock ("we", "us", "our") is operated by Flock Corp. We are the
                data controller for personal information processed through the Flock app
                and flockcorp.com.
              </p>
            </section>

            <section id="what-we-collect">
              <h2>{num(2)} What we collect</h2>

              <h3>You provide directly</h3>
              <ul>
                <li><strong>Account info:</strong> email, password (stored as a one-way hash, we never see your password), display name, optional avatar, friend code. We send a link to your email at sign-up to confirm it's really yours.</li>
                <li><strong>Phone number (optional):</strong> sign-up never asks for one. You can add a phone number later from your profile so friends who already have your number can find you. Adding one requires confirming your password or a recent sign-in.</li>
                <li><strong>Contacts you choose to match (optional):</strong> if you use "Add friends" from your phone contacts, the numbers you pick are sent to our server once to check for existing Flock accounts. We run the lookup and don't store those numbers.</li>
                <li><strong>Date of birth:</strong> collected at sign-up so we can confirm you're 13 or older.</li>
                <li><strong>Trusted contacts:</strong> if you add emergency contacts, we store the name, phone, and email you give us so we can notify them when you trigger an SOS.</li>
                <li><strong>Messages and content:</strong> flock chat messages, direct messages, emoji reactions, stories (visible for 24 hours), images you upload.</li>
                <li><strong>Plans and votes:</strong> flocks you create or join, RSVPs, venue votes, budget submissions, check-ins.</li>
                <li><strong>Payment handles (optional):</strong> if you add them for bill-splitting, we store your Venmo username, Cash App cashtag, or Zelle identifier so flockmates can pay you back. These are usernames/handles only. Flock never collects or processes card, bank-account, or payment-card numbers.</li>
                <li><strong>Sign-in tokens:</strong> if you sign in with Apple or Google, we receive an identity token from the provider, verify it, and issue our own session token. For Apple accounts we also keep the refresh token Apple gives us for one purpose: revoking Flock's access to your Apple ID when you delete your account, which Apple requires.</li>
              </ul>

              <h3>We collect automatically</h3>
              <ul>
                <li><strong>Product analytics:</strong> we use PostHog to understand how Flock is used: pages viewed, features used, and events like creating a flock or sharing an invite link. Events are tied to your account ID, not your name or email. Your messages, votes, budgets, and location are never sent to PostHog.</li>
                <li><strong>Push notification tokens:</strong> if you enable notifications, we store the device token issued by Apple Push Notification service or Firebase Cloud Messaging.</li>
                <li><strong>Connection metadata:</strong> IP address and user agent for security, abuse prevention, and rate limiting. Stored short-term in server logs and security records.</li>
              </ul>

              <h3>Location</h3>
              <ul>
                <li><strong>Live location share:</strong> only when you explicitly turn it on inside an active flock, and only for as long as that flock is active. You can stop it at any time.</li>
                <li><strong>SOS:</strong> when you press SOS, your current location is sent to your trusted contacts and to our safety system so we can help. We do not collect background location.</li>
                <li><strong>Map and venue search:</strong> the app uses your device location locally to center the map. We do not record this on our servers.</li>
              </ul>

              <h3>Anonymous budget data</h3>
              <p>
                Budget submissions are stored on our servers but the system is designed so
                individual amounts are <strong>never</strong> returned to other flock
                members. Other members only see aggregated values (group ceiling, count of
                submissions, ready state). This is a core product guarantee enforced in code.
              </p>
            </section>

            <section id="how-we-use-it">
              <h2>{num(3)} How we use your information</h2>
              <ul>
                <li>Operate the core product (auth, flocks, chat, voting, notifications).</li>
                <li>Send transactional email (email verification at sign-up, SOS alerts) via Resend.</li>
                <li>Send push notifications you opted into.</li>
                <li>Monitor reliability and diagnose errors to keep the app working.</li>
                <li>Detect abuse, spam, and security incidents.</li>
                <li>Comply with legal obligations.</li>
              </ul>
              <p>
                We do not sell your personal information. We do not use your messages or
                content to train third-party advertising models.
              </p>
            </section>

            <section id="who-we-share-with">
              <h2>{num(4)} Who we share with</h2>
              <p>
                We share information only with service providers that help us run Flock, and
                only to the extent needed for that work. Current providers include:
              </p>
              <ul>
                <li><strong>Vercel</strong> (web hosting), <strong>Railway</strong> (server + PostgreSQL hosting).</li>
                <li><strong>Resend</strong> (transactional email).</li>
                <li><strong>Apple Push Notification service</strong> and <strong>Firebase Cloud Messaging</strong> (push delivery).</li>
                <li><strong>Google Places</strong> (venue search results; we send the search text and map area, not your account).</li>
                <li><strong>MapTiler</strong> (the maps in the app; your device loads map tiles directly from MapTiler, which sees your IP address and the area of the map you're viewing, not your account).</li>
                <li><strong>Google Cloud Vision</strong> (checks images you upload against our content rules before anyone can see them; the image is sent for that check only).</li>
                <li><strong>OpenWeatherMap</strong> (weather context for crowd predictions; no personal info sent).</li>
                <li><strong>Ticketmaster</strong> (event listings near you; we send the search area, not your account).</li>
                <li><strong>BestTime</strong> (aggregate venue popularity data; no personal info sent).</li>
                <li><strong>Apple</strong> and <strong>Google</strong> (sign-in identity verification, only when you choose those options).</li>
                <li><strong>RevenueCat</strong> (subscription receipt verification, if you subscribe).</li>
                <li><strong>PostHog</strong> (product analytics; usage events tied to account ID only).</li>
                <li><strong>Google Gemini</strong> (powers Birdie, the in-app assistant). When you chat with Birdie, your messages in that conversation, your first name, your age bracket (under 18, under 21, or adult, never your birthday), and your approximate location (rounded to about a kilometer, only if you've allowed location) are sent to Google to generate the reply. If you ask Birdie about your plans or friends, the names, venues, and times of your flocks and your friends' display names are included so it can answer. Birdie conversations are not used by us for advertising, and we don't send your email, exact coordinates, or messages from your flocks or DMs.</li>
              </ul>
              <p>
                Other flock members see content you share inside that flock (messages, RSVP
                status, live location while you have it on). Your trusted contacts receive
                an SOS message and your current location when you press SOS.
              </p>
              <p>
                We may disclose information to comply with a valid legal process, to protect
                users from imminent harm, or in connection with a corporate transaction (we
                will notify you).
              </p>
            </section>

            <section id="how-long">
              <h2>{num(5)} How long we keep it</h2>
              <ul>
                <li><strong>Account data:</strong> until you delete your account.</li>
                <li><strong>Stories:</strong> visible for 24 hours after posting, then hidden from everyone; the underlying data is deleted with your account.</li>
                <li><strong>Messages and flocks:</strong> retained while your account exists; deleted with your account.</li>
                <li><strong>Push notification tokens:</strong> deleted when you sign out on that device or delete your account.</li>
                <li><strong>Reports and moderation records:</strong> kept after an account is deleted so our moderation history stays intact, but with the deleted account unlinked from them.</li>
                <li><strong>Banned accounts:</strong> if an account is banned and its owner then deletes it, we keep a one-way hashed code of its email, phone number, and Apple or Google sign-in ID for 12 months. This stops a banned person from signing straight back up. The code can't be turned back into the original email or number, contains no name or content, and expires on its own after 12 months. Nothing like this is kept for accounts that weren't banned.</li>
                <li><strong>Server logs:</strong> short-term (typically 30 days) for security and debugging.</li>
                <li><strong>Backups:</strong> rolling backups may retain data for up to 30 days after deletion before they roll off.</li>
              </ul>
            </section>

            <section id="your-choices">
              <h2>{num(6)} Your choices and rights</h2>
              <ul>
                <li><strong>Access, correction, export, deletion:</strong> you can request any of these by emailing {mail}. You can delete your account in the app (Profile &rarr; Delete account) or from our <a href="/delete-account">account deletion page</a>. To protect your account, deleting it asks you to confirm your password, or to sign in again if you use Apple or Google.</li>
                <li><strong>Push notifications:</strong> turn off in your device settings or inside Flock.</li>
                <li><strong>Live location:</strong> stop sharing at any time from within the flock.</li>
                <li><strong>Marketing email:</strong> we don't send marketing email. Transactional email (security, SOS) cannot be turned off while your account is active.</li>
                <li><strong>EU/UK users (GDPR):</strong> you have rights to access, rectification, erasure, restriction, objection, and portability. Contact us to exercise them. The lawful basis for our processing is performance of the user agreement and our legitimate interest in operating a safe service.</li>
                <li><strong>California users (CCPA/CPRA):</strong> you have rights to know, delete, correct, and opt out of "selling" or "sharing" of personal information. We do not sell or share for cross-context behavioral advertising.</li>
              </ul>
            </section>

            <section id="children">
              <h2>{num(7)} Children</h2>
              <p>
                Flock is intended for users <strong>13 and older</strong>. We do not
                knowingly collect personal information from children under 13. If you
                believe a child under 13 has created an account, contact us and we will
                delete it.
              </p>
            </section>

            <section id="security">
              <h2>{num(8)} Security</h2>
              <p>
                We use industry-standard safeguards: passwords hashed with bcrypt,
                parameterized database queries, rate limiting, HTTPS everywhere, JWT session
                tokens, security headers via Helmet. No system is perfectly secure; we work
                to mitigate and disclose incidents promptly.
              </p>
            </section>

            <section id="international">
              <h2>{num(9)} International transfers</h2>
              <p>
                Our servers are located in the United States. If you use Flock from outside
                the U.S., your information will be transferred to and processed in the U.S.
                By using Flock, you consent to this transfer.
              </p>
            </section>

            <section id="changes">
              <h2>{num(10)} Changes to this policy</h2>
              <p>
                We may update this policy. We will post the new effective date at the top
                and, for material changes, give in-app notice before the change takes effect.
              </p>
            </section>

            <section id="contact">
              <h2>{num(11)} Contact</h2>
              <p>Questions, requests, or concerns? A human reads this inbox:</p>
              <div className="pp-contact">
                <a className="pp-contact-mail" href={`mailto:${CONTACT_EMAIL}`}>
                  {CONTACT_EMAIL}
                </a>
              </div>
            </section>
          </div>

          <footer className="pp-footer">
            <span>&copy; {new Date().getFullYear()} Flock Corp.</span>
            <span>
              <a href="/terms">Terms</a> · <a href="/guidelines">Community Guidelines</a> ·{' '}
              <a href="/delete-account">Delete account</a>
            </span>
          </footer>
        </div>
      </div>
    </main>
  );
}
