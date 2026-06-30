import React, { useEffect } from 'react';
import './PrivacyPolicy.css';

const SUPPORT_EMAIL = 'support@flockcorp.com';

export default function SupportPage() {
  useEffect(() => {
    document.title = 'Support — Flock';
  }, []);

  return (
    <main className="pp">
      <a href="/landing" className="pp-back">&larr; flockcorp.com</a>

      <header className="pp-header">
        <h1>Support</h1>
        <p className="pp-meta">We're a small team. We read every message.</p>
      </header>

      <section>
        <h2>Contact us</h2>
        <p>
          The fastest way to reach us is email:{' '}
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

        <h3>I can't sign in.</h3>
        <p>
          Check that the email matches the one you signed up with. If you signed up with Google
          or Apple, use the same button — a password account isn't created automatically.
          Still stuck? Email us with the email you tried.
        </p>

        <h3>I'm not getting notifications.</h3>
        <p>
          Open Settings → Notifications → Flock and confirm Allow Notifications is on. On iOS,
          also check that Focus modes aren't silencing them. Inside the app, go to Profile →
          Notifications to confirm each notification type is enabled.
        </p>

        <h3>The map isn't showing my location.</h3>
        <p>
          Settings → Privacy & Security → Location Services → Flock should be set to "While
          Using the App." If it's set to Never, the Discover map won't be able to center on you.
        </p>

        <h3>How do I delete my account?</h3>
        <p>
          Open Flock and go to Profile → Delete account, then type DELETE to confirm. This
          immediately and permanently removes your account, messages, flocks you created,
          friend connections, and personal info. If you can't sign in to delete it yourself,
          email us from the address on the account and we'll do it.
        </p>

        <h3>How does the budget feature stay anonymous?</h3>
        <p>
          The app server never sends individual budget amounts back to the group — only the
          aggregate ceiling, the submission count, and whether everyone has submitted. No member
          (including the flock creator) sees what you personally entered.
        </p>

        <h3>What happens when I tap SOS?</h3>
        <p>
          Your trusted contacts (Profile → Safety → Trusted Contacts) get an email with your
          current location and a timestamp. Add at least one contact before you need it.
        </p>

        <h3>I want to report a bug or suggest a feature.</h3>
        <p>
          Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> with "Bug" or "Feature"
          in the subject. We triage every week.
        </p>
      </section>

      <section>
        <h2>Privacy</h2>
        <p>
          Read our <a href="/privacy">Privacy Policy</a> for details on what we collect and
          how we use it.
        </p>
      </section>

      <footer className="pp-footer">
        <p>
          Flock &middot; <a href="/landing">flockcorp.com</a> &middot;{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </p>
      </footer>
    </main>
  );
}
