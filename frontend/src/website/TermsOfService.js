import React, { useEffect } from 'react';
import './PrivacyPolicy.css';

const EFFECTIVE_DATE = 'June 16, 2026';
const SUPPORT_EMAIL = 'support@flockcorp.com';

export default function TermsOfService() {
  useEffect(() => {
    document.title = 'Terms of Service — Flock';
  }, []);

  return (
    <main className="pp">
      <a href="/landing" className="pp-back">&larr; flockcorp.com</a>

      <header className="pp-header">
        <h1>Terms of Service &amp; EULA</h1>
        <p className="pp-meta">Effective {EFFECTIVE_DATE}</p>
      </header>

      <section>
        <p>
          These Terms of Service ("Terms") are a binding agreement between you and Flock Corp
          ("Flock", "we", "us"). By creating an account or using the Flock app, you agree to
          these Terms and to our{' '}
          <a href="/privacy">Privacy Policy</a> and{' '}
          <a href="/guidelines">Community Guidelines</a>. If you do not agree, do not use Flock.
        </p>
      </section>

      <section>
        <h2>1. Eligibility</h2>
        <p>
          You must be at least 13 years old to use Flock. By using Flock you represent that you
          are 13 or older and that you can form a binding contract with us.
        </p>
      </section>

      <section>
        <h2>2. Your account</h2>
        <p>
          You are responsible for your account and for keeping your credentials secure. You
          agree to provide accurate information and to be responsible for activity on your
          account. You may delete your account at any time (see Section 8).
        </p>
      </section>

      <section>
        <h2>3. Acceptable use &amp; zero tolerance</h2>
        <p>
          <strong>
            Flock has zero tolerance for objectionable content and abusive users.
          </strong>{' '}
          You agree not to post, send, or share content that is unlawful, harassing, bullying,
          hateful, threatening, sexually explicit, exploitative of minors, or otherwise
          objectionable, and not to harass, abuse, impersonate, stalk, or harm other users.
          Our <a href="/guidelines">Community Guidelines</a> describe prohibited content and
          behavior in detail and are part of these Terms.
        </p>
        <p>
          We may remove content and suspend or terminate accounts that violate these Terms. We
          act on reports of objectionable content and abusive behavior promptly — typically
          removing violating content and ejecting the responsible user — and we may report
          illegal content to the appropriate authorities.
        </p>
      </section>

      <section>
        <h2>4. User content</h2>
        <p>
          You retain ownership of the content you create. You grant Flock a limited license to
          host, store, and display your content solely to operate the service (for example,
          showing your messages to other members of your flock). You are responsible for the
          content you share and confirm you have the rights to share it.
        </p>
      </section>

      <section>
        <h2>5. Reporting &amp; moderation</h2>
        <p>
          Flock provides in-app tools to report objectionable content and to block abusive
          users. We review reports and take action under our Community Guidelines. You can also
          reach our team at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
      </section>

      <section>
        <h2>6. Intellectual property &amp; DMCA</h2>
        <p>
          Flock and its branding are owned by Flock Corp. If you believe content on Flock
          infringes your copyright, contact <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>{' '}
          with enough detail to identify the work and the allegedly infringing content, and we
          will respond in accordance with applicable law.
        </p>
      </section>

      <section>
        <h2>7. Payments</h2>
        <p>
          Flock is currently free to use. If we offer paid subscriptions in the future, the
          applicable price and terms will be shown at the point of purchase and billed through
          the App Store or Google Play. Subscriptions auto-renew unless cancelled through your
          store account.
        </p>
      </section>

      <section>
        <h2>8. Termination</h2>
        <p>
          You may stop using Flock and delete your account at any time from the app (Profile
          &rarr; Delete account) or via our <a href="/delete-account">account deletion page</a>.
          We may suspend or terminate your access for violations of these Terms.
        </p>
      </section>

      <section>
        <h2>9. Disclaimers &amp; limitation of liability</h2>
        <p>
          Flock is provided "as is" without warranties of any kind. To the maximum extent
          permitted by law, Flock is not liable for indirect, incidental, or consequential
          damages arising from your use of the service. Flock helps coordinate plans; you are
          responsible for your own safety and decisions when meeting others or going out.
        </p>
      </section>

      <section>
        <h2>10. Governing law &amp; changes</h2>
        <p>
          These Terms are governed by the laws of the United States and the State of
          Pennsylvania, without regard to conflict-of-laws rules. We may update these Terms; we
          will post the new effective date and, for material changes, provide in-app notice.
        </p>
      </section>

      <section>
        <h2>11. Contact</h2>
        <p>
          Questions about these Terms: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
      </section>

      <footer className="pp-footer">
        <p>&copy; {new Date().getFullYear()} Flock Corp.</p>
      </footer>
    </main>
  );
}
