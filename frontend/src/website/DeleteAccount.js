import React, { useEffect } from 'react';
import './PrivacyPolicy.css';

const SUPPORT_EMAIL = 'social@flockcorp.com';

// Public account-deletion page (Google Play requires a public URL where users
// who uninstalled can still request deletion). Routed at /delete-account.
export default function DeleteAccount() {
  useEffect(() => {
    document.title = 'Delete Your Account · Flock';
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
          type DELETE to confirm. If your account has a password, you'll enter it to prove it's
          you. If you sign in with Apple or Google, you may be asked to sign in again first.
          Your account and data are then deleted immediately. If you signed in with Apple, we
          also revoke Flock's Sign in with Apple access.
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
          off, and we may retain the minimum required for legal or security obligations.
        </p>
        <p>
          Two things survive a deletion, both explained in our{' '}
          <a href="/privacy">Privacy Policy</a>: reports and moderation records are kept with
          your account unlinked from them, and if your account was banned when you deleted it,
          a one-way hashed code of its email, phone number, and sign-in ID is kept for 12
          months to stop the ban from being dodged. That code can't be turned back into your
          info and expires on its own.
        </p>
      </section>

      <footer className="pp-footer">
        <p>&copy; {new Date().getFullYear()} Flock Corp.</p>
      </footer>
    </main>
  );
}
