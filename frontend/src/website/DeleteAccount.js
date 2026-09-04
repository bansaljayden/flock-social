import React, { useEffect } from 'react';
import './PrivacyPolicy.css';
import SiteFooter from './SiteFooter';

const SUPPORT_EMAIL = 'social@flockcorp.com';

// Public account-deletion page (Google Play requires a public URL where users
// who uninstalled can still request deletion). Routed at /delete-account.
// PER-ROUTE <meta name="description">. CRA has no server rendering, so
// public/index.html is the response for every route and its one static
// description was the description this page shipped with. There is no head
// manager in this app and adding one is a dependency, so the mechanism is the
// one LandingPage.js already uses: rewrite the tag index.html ships, from this
// route's own effect. Googlebot renders JS and reads the rewritten value.
const DESCRIPTION = 'How to delete your Flock account from inside the app or by email, and exactly what data is removed when you do.';

export default function DeleteAccount() {
  useEffect(() => {
    document.title = 'Delete your account | Flock';
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', DESCRIPTION);
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
      {/* First focusable element on the page (SLOP-AUDIT Q1), off-screen
          until focused. The header carries tabIndex -1 so activating this
          moves focus with the scroll instead of leaving it behind here. */}
      <a className="pp-skip" href="#pp-content">Skip to the main content</a>

      {/* The arrow is decoration and must stay out of the link's accessible
          name, or it is announced as "left arrow flockcorp.com". */}
      <a href="/" className="pp-back">
        <span aria-hidden="true">&larr;</span> flockcorp.com
      </a>

      <header className="pp-header" id="pp-content" tabIndex={-1}>
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
          Open Flock &rarr; <strong>You</strong> (the last tab) &rarr; scroll to the bottom &rarr; <strong>Delete account</strong>, then
          type DELETE to confirm. If your account has a password, you'll enter it to prove it's
          you. If you sign in with Apple or Google, you may be asked to sign in again first.
          Your account and data are then deleted immediately.
        </p>
        {/*
          APPLE REVOCATION IS LIVE (promise restored 2026-08-18). All five
          APPLE_* variables (APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY,
          APPLE_CLIENT_ID, APPLE_BUNDLE_ID) were confirmed set on the Railway
          production service on 2026-08-16, so `services/appleAuth.js`
          `isConfigured()` is true, routes/auth.js stores the refresh token at
          sign-in, and routes/users.js revokes it on deletion. If those
          variables are ever removed, revocation silently stops: withdraw this
          promise again, update the matching note in PrivacyPolicy.js, and flip
          the pinning test in legalPagesMatchCode.test.js back. Apple 5.1.1(v)
          is checked by a human.
        */}
        <p>
          <strong>If you signed in with Apple:</strong> when you delete your account, we
          also revoke Flock's Sign in with Apple access, so Flock stops appearing as a
          connected app on your Apple ID. You can check this yourself: on your iPhone
          open <strong>Settings</strong>, tap your name, then{' '}
          <strong>Sign in with Apple</strong>. If Flock still shows there, tap{' '}
          <strong>Flock</strong>, then <strong>Stop using Apple ID</strong> to remove it
          by hand.
        </p>
      </section>

      <section>
        <h2>If you've uninstalled the app</h2>
        <p>
          Email me from the address on your account and I'll delete it for you:
        </p>
        <p>
          {/* This is the whole deletion path for someone who has already
              uninstalled, so its name has to survive being read aloud. The
              arrow is decoration; the parenthetical says out loud that the
              link hands off to a mail app with a draft already written, which
              is otherwise a surprise you only discover by activating it. */}
          <a href={mailto}>
            Request deletion by email
            <span className="pp-sr-only"> (opens a new message in your email app)</span>
            <span aria-hidden="true"> &rarr;</span>
          </a>{' '}
          (or write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>)
        </p>
        {/* "We action verified requests promptly" claimed both a team and a
            response time, and Flock is one person. The retention paragraphs
            below keep the first-person plural on purpose: those are statements
            about what the company does with data, not about who reads the
            mail. */}
        <p>
          Include the email on the account so I can verify the request. Once it checks out,
          I delete the account.
        </p>
      </section>

      <section>
        <h2>What gets deleted</h2>
        <p>
          Deleting your account removes your profile, chat messages, direct messages,
          friendships, RSVPs and votes, budget submissions, trusted contacts, SOS records,
          venue reviews, check-ins, and notification tokens.
        </p>
        <p>
          It also deletes <strong>every flock you created</strong>, and everything inside
          those flocks: the whole chat, the RSVPs, and the votes, for every person who was
          in them. They are not moved to another owner. Flocks you only joined are left
          alone; you are removed from them, and the messages you sent in them go with you.
          The people who were going to a plan you created are told it is off: in the app if
          they have it open, and by notification if they do not. Nobody is left holding a plan
          that no longer exists.
        </p>
        <p>
          Direct messages go too, on both sides. A DM belongs to the two people in it, so
          deleting your account removes that conversation from the other person's app as
          well.
        </p>
        <p>
          Information you deleted can still sit in a database backup until that backup is
          deleted. Our rule is that no backup is kept longer than 90 days, except an
          occasional archive we keep so our crowd-model training data is never lost, which
          today is a copy of the whole database. We may also keep the minimum required for
          legal or security obligations.
        </p>
        <p>
          Some things survive a deletion. Every one of them is listed in our{' '}
          <a href="/privacy">Privacy Policy</a> under <em>What survives, and why</em>, and these are
          the ones that can involve you.
        </p>
        <ul>
          <li>
            Reports and moderation records are kept, with your account unlinked from them.
          </li>
          <li>
            If your account was banned when you deleted it, a one-way hashed code of its
            email, phone number, and sign-in ID is kept for 12 months to stop the ban from
            being dodged. That code can't be turned back into your info and expires on its
            own. Nothing like it is kept for an account that was not banned.
          </li>
          <li>
            One row per finished plan describing how it went: group size, whether a budget was
            used, whether it was confirmed, where it stalled. It carries no names, no
            messages, and no individual budget amounts.
          </li>
          <li>
            <strong>Your email address, if it is on our do-not-mail list.</strong> An address
            goes on that list when mail to it hard-bounces, when someone reports us as spam,
            or when someone uses an unsubscribe link. The list is keyed on the address itself
            and has no link to your account, so deleting the account does not take the address
            off it, and it has no expiry. It is there so we do not mail an address that should
            not be mailed. Ask me at{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and I will remove it.
          </li>
          <li>
            Two references in other people's plans stop pointing at you rather than being
            deleted: who paid, on a bill split inside a plan you did not create, and who made
            an invite link that somebody else's flock still holds. Neither says anything about
            you once your account is gone.
          </li>
        </ul>
      </section>

      {/* The shared SiteFooter: legal links, the one real mailbox, and the
          copyright. It stays inside main.pp because .pp paints the page. */}
      <SiteFooter className="pp-footer" />
    </main>
  );
}
