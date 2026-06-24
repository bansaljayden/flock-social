import React, { useEffect } from 'react';
import './PrivacyPolicy.css';

const SUPPORT_EMAIL = 'support@flockcorp.com';

// Public account-deletion page (Google Play requires a public URL where users
// who uninstalled can still request deletion). Routed at /delete-account.
export default function DeleteAccount() {
  useEffect(() => {
    document.title = 'Delete Your Account — Flock';
  }, []);

  const mailto =
    `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Delete my Flock account')}` +
    `&body=${encodeURIComponent(
      'Please delete my Flock account and associated data.\n\n' +
      'Email on the account: \n' +
      'Display name (if known): \n'
    )}`;

  return (
    <main className="pp">
      <a href="/landing" className="pp-back">&larr; flockcorp.com</a>

      <header className="pp-header">
        <h1>Delete your Flock account</h1>
      </header>

      <section>
        <p>
          You can permanently delete your Flock account and associated data at any time. This
          is irreversible.
        </p>
      </section>

      <section>
        <h2>In the app (fastest)</h2>
        <p>
          Open Flock &rarr; <strong>Profile</strong> &rarr; <strong>Delete account</strong>, then
          confirm. Your account and data are deleted immediately. If you signed in with Apple,
          we also revoke your Sign in with Apple tokens.
        </p>
      </section>

      <section>
        <h2>If you've uninstalled the app</h2>
        <p>
          Email us from the address on your account and we'll delete it for you:
        </p>
        <p>
          <a href={mailto}>Request deletion by email &rarr;</a>{' '}
          (or write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>)
        </p>
        <p>
          Include the email on the account so we can verify the request. We action verified
          requests promptly.
        </p>
      </section>

      <section>
        <h2>What gets deleted</h2>
        <p>
          Deleting your account removes your profile, messages, direct messages, flocks you
          created, friendships, budgets, trusted contacts, and notification tokens. Some records
          may persist briefly in encrypted backups (typically up to 30 days) before they roll
          off, and we may retain the minimum required for legal or security obligations. See our{' '}
          <a href="/privacy">Privacy Policy</a> for details.
        </p>
      </section>

      <footer className="pp-footer">
        <p>&copy; {new Date().getFullYear()} Flock Corp.</p>
      </footer>
    </main>
  );
}
