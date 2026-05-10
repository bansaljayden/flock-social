import React, { useEffect } from 'react';
import './PrivacyPolicy.css';

const EFFECTIVE_DATE = 'May 3, 2026';
const SUPPORT_EMAIL = 'support@flockcorp.com';

export default function PrivacyPolicy() {
  useEffect(() => {
    document.title = 'Privacy Policy — Flock';
  }, []);

  return (
    <main className="pp">
      <a href="/landing" className="pp-back">&larr; flockcorp.com</a>

      <header className="pp-header">
        <h1>Privacy Policy</h1>
        <p className="pp-meta">Effective {EFFECTIVE_DATE}</p>
      </header>

      <section>
        <p>
          Flock is a social coordination app that helps you plan nights out with friends.
          This policy explains what we collect, how we use it, and the choices you have.
          We tried to write it in plain language. If anything is unclear, email us at{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
      </section>

      <section>
        <h2>1. Who we are</h2>
        <p>
          Flock ("we", "us", "our") is operated by Flock Corp. We are the data controller
          for personal information processed through the Flock app and flockcorp.com.
        </p>
      </section>

      <section>
        <h2>2. What we collect</h2>

        <h3>You provide directly</h3>
        <ul>
          <li><strong>Account info:</strong> email, password (stored as a one-way hash, we never see your password), display name, optional avatar, optional phone number, friend code.</li>
          <li><strong>Trusted contacts:</strong> if you add emergency contacts, we store the name, phone, and email you give us so we can notify them when you trigger an SOS.</li>
          <li><strong>Messages and content:</strong> flock chat messages, direct messages, emoji reactions, stories (auto-deleted after 24 hours), images you upload.</li>
          <li><strong>Plans and votes:</strong> flocks you create or join, RSVPs, venue votes, budget submissions, check-ins.</li>
          <li><strong>Sign-in tokens:</strong> if you sign in with Apple or Google, we receive an identity token from the provider, verify it, and issue our own session token. We do not store the provider token after verification.</li>
        </ul>

        <h3>We collect automatically</h3>
        <ul>
          <li><strong>Device and usage data:</strong> approximate session activity (screens visited, features used, errors) via PostHog. Identifiers are pseudonymous and used to improve the product.</li>
          <li><strong>Push notification tokens:</strong> if you enable notifications, we store the device token issued by Apple Push Notification service or Firebase Cloud Messaging.</li>
          <li><strong>Connection metadata:</strong> IP address and user agent for security, abuse prevention, and rate limiting. Stored short-term in server logs.</li>
        </ul>

        <h3>Location</h3>
        <ul>
          <li><strong>Live location share:</strong> only when you explicitly turn it on inside an active flock, and only for as long as that flock is active. You can stop it at any time.</li>
          <li><strong>SOS:</strong> when you press SOS, your current location is sent to your trusted contacts and to our safety system so we can help. We do not collect background location.</li>
          <li><strong>Map and venue search:</strong> the app uses your device location locally to center the map. We do not record this on our servers.</li>
        </ul>

        <h3>Anonymous budget data</h3>
        <p>
          Budget submissions are stored on our servers but the system is designed so individual
          amounts are <strong>never</strong> returned to other flock members. Other members only
          see aggregated values (group ceiling, count of submissions, ready state). This is a
          core product guarantee enforced in code.
        </p>
      </section>

      <section>
        <h2>3. How we use your information</h2>
        <ul>
          <li>Operate the core product (auth, flocks, chat, voting, notifications).</li>
          <li>Send transactional email (sign-up confirmation, password reset, SOS alerts) via Resend.</li>
          <li>Send push notifications you opted into.</li>
          <li>Improve product quality (usage analytics, crash diagnostics).</li>
          <li>Detect abuse, spam, and security incidents.</li>
          <li>Comply with legal obligations.</li>
        </ul>
        <p>
          We do not sell your personal information. We do not use your messages or content
          to train third-party advertising models.
        </p>
      </section>

      <section>
        <h2>4. Who we share with</h2>
        <p>
          We share information only with service providers that help us run Flock, and only
          to the extent needed for that work. Current providers include:
        </p>
        <ul>
          <li><strong>Vercel</strong> (web hosting), <strong>Railway</strong> (server + PostgreSQL hosting).</li>
          <li><strong>Resend</strong> (transactional email).</li>
          <li><strong>Apple Push Notification service</strong> and <strong>Firebase Cloud Messaging</strong> (push delivery).</li>
          <li><strong>Google Places</strong> (venue search results &mdash; we send the query, not your account).</li>
          <li><strong>OpenWeatherMap</strong> (weather context for crowd predictions &mdash; no personal info sent).</li>
          <li><strong>Ticketmaster</strong> (event listings &mdash; no personal info sent).</li>
          <li><strong>BestTime</strong> (aggregate venue popularity data &mdash; no personal info sent).</li>
          <li><strong>PostHog</strong> (product analytics, pseudonymous).</li>
          <li><strong>Apple</strong> and <strong>Google</strong> (sign-in identity verification, only when you choose those options).</li>
          <li><strong>RevenueCat</strong> (subscription receipt verification, if you subscribe).</li>
        </ul>
        <p>
          Other flock members see content you share inside that flock (messages, RSVP status,
          live location while you have it on). Your trusted contacts receive an SOS message
          and your current location when you press SOS.
        </p>
        <p>
          We may disclose information to comply with a valid legal process, to protect users
          from imminent harm, or in connection with a corporate transaction (we will notify you).
        </p>
      </section>

      <section>
        <h2>5. How long we keep it</h2>
        <ul>
          <li><strong>Account data:</strong> until you delete your account.</li>
          <li><strong>Stories:</strong> auto-deleted 24 hours after posting.</li>
          <li><strong>Messages and flocks:</strong> retained while your account exists; deleted with your account.</li>
          <li><strong>Server logs:</strong> short-term (typically 30 days) for security and debugging.</li>
          <li><strong>Backups:</strong> rolling backups may retain data for up to 30 days after deletion before they roll off.</li>
        </ul>
      </section>

      <section>
        <h2>6. Your choices and rights</h2>
        <ul>
          <li><strong>Access, correction, export, deletion:</strong> you can request any of these by emailing <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. Account deletion is also available inside the app under Settings.</li>
          <li><strong>Push notifications:</strong> turn off in your device settings or inside Flock.</li>
          <li><strong>Live location:</strong> stop sharing at any time from within the flock.</li>
          <li><strong>Marketing email:</strong> we don't send marketing email. Transactional email (security, SOS) cannot be turned off while your account is active.</li>
          <li><strong>EU/UK users (GDPR):</strong> you have rights to access, rectification, erasure, restriction, objection, and portability. Contact us to exercise them. The lawful basis for our processing is performance of the user agreement and our legitimate interest in operating a safe service.</li>
          <li><strong>California users (CCPA/CPRA):</strong> you have rights to know, delete, correct, and opt out of "selling" or "sharing" of personal information. We do not sell or share for cross-context behavioral advertising.</li>
        </ul>
      </section>

      <section>
        <h2>7. Children</h2>
        <p>
          Flock is intended for users <strong>13 and older</strong>. We do not knowingly
          collect personal information from children under 13. If you believe a child under
          13 has created an account, contact us and we will delete it.
        </p>
      </section>

      <section>
        <h2>8. Security</h2>
        <p>
          We use industry-standard safeguards: passwords hashed with bcrypt, parameterized
          database queries, rate limiting, HTTPS everywhere, JWT session tokens, security
          headers via Helmet. No system is perfectly secure; we work to mitigate and disclose
          incidents promptly.
        </p>
      </section>

      <section>
        <h2>9. International transfers</h2>
        <p>
          Our servers are located in the United States. If you use Flock from outside the
          U.S., your information will be transferred to and processed in the U.S. By using
          Flock, you consent to this transfer.
        </p>
      </section>

      <section>
        <h2>10. Changes to this policy</h2>
        <p>
          We may update this policy. We will post the new effective date at the top and, for
          material changes, give in-app notice before the change takes effect.
        </p>
      </section>

      <section>
        <h2>11. Contact</h2>
        <p>
          Questions, requests, or concerns: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
      </section>

      <footer className="pp-footer">
        <p>&copy; {new Date().getFullYear()} Flock Corp.</p>
      </footer>
    </main>
  );
}
