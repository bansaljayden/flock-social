import React, { useEffect } from 'react';
import './PrivacyPolicy.css';
import SiteFooter from './SiteFooter';

const EFFECTIVE_DATE = 'August 14, 2026';
const SUPPORT_EMAIL = 'social@flockcorp.com';
// Deliberately the same mailbox as SUPPORT_EMAIL. A designated child-safety
// contact is a real commitment, and safety@ was named here before it existed,
// so a report about a child's safety would have bounced. Point it at an address
// that is actually monitored (Cloudflare forwards social@ to a real inbox).
// Split it out again only after the dedicated mailbox exists and is watched.
const CHILD_SAFETY_EMAIL = SUPPORT_EMAIL;

// PER-ROUTE <meta name="description">. CRA has no server rendering, so
// public/index.html is the response for every route and its one static
// description was the description this page shipped with. There is no head
// manager in this app and adding one is a dependency, so the mechanism is the
// one LandingPage.js already uses: rewrite the tag index.html ships, from this
// route's own effect. Googlebot renders JS and reads the rewritten value.
const DESCRIPTION = 'What you may not post on Flock, the zero-tolerance child safety policy, how to report or block, and what happens after a report.';

export default function CommunityGuidelines() {
  useEffect(() => {
    document.title = 'Community Guidelines | Flock';
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', DESCRIPTION);
  }, []);

  return (
    <main className="pp">
      {/* The arrow is decoration and must stay out of the link's accessible
          name, or it is announced as "left arrow flockcorp.com". */}
      <a href="/" className="pp-back">
        <span aria-hidden="true">&larr;</span> flockcorp.com
      </a>

      <header className="pp-header">
        <h1>Community Guidelines</h1>
        <p className="pp-meta">Effective {EFFECTIVE_DATE}</p>
      </header>

      <section>
        <p>
          Flock is for coordinating real plans with friends. To keep it safe, everyone agrees
          to these guidelines. <strong>Flock has zero tolerance for objectionable content and
          abusive users.</strong> Breaking these rules can get your content removed and your
          account suspended or permanently banned.
        </p>
      </section>

      <section>
        <h2>Don't post or send</h2>
        <ul>
          <li>Harassment, bullying, threats, or targeted abuse.</li>
          <li>Hate speech or symbols attacking people based on protected characteristics.</li>
          <li>Sexually explicit or pornographic content, or unsolicited sexual advances.</li>
          <li>Violence, gore, or content that promotes self-harm.</li>
          <li>Illegal content, or content promoting illegal drugs, weapons, or activity.</li>
          <li>Spam, scams, phishing, or impersonation of other people or brands.</li>
          <li>Private or personal information about others without consent (doxxing).</li>
          <li>Anything that exploits or endangers minors (see below).</li>
        </ul>
      </section>

      <section>
        <h2>Child safety: zero tolerance (CSAE)</h2>
        <p>
          Flock has <strong>zero tolerance for child sexual abuse and exploitation (CSAE)</strong>,
          including any child sexual abuse material (CSAM), grooming, sextortion, or
          sexualization of minors. This is strictly prohibited anywhere on Flock.
        </p>
        <ul>
          <li>We remove CSAE content on actual knowledge and disable the responsible account.</li>
          <li>
            We report apparent CSAM to the National Center for Missing &amp; Exploited Children
            (NCMEC) and/or the relevant authorities, as required by law.
          </li>
          <li>
            Flock is intended for users 13 and older. Sign-up asks for a date of birth, our
            server recalculates the age from it rather than trusting the app, and anyone
            under 13 is refused an account. We do not knowingly allow children under 13.
          </li>
          <li>
            Child-safety concerns can be reported any time to{' '}
            <a href={`mailto:${CHILD_SAFETY_EMAIL}`}>{CHILD_SAFETY_EMAIL}</a> (our designated
            child-safety point of contact) or in-app via Report.
          </li>
        </ul>
        <p>
          These standards align with the Tech Coalition's child-safety principles and apply
          regardless of whether children use the app.
        </p>
      </section>

      <section>
        <h2>How to report or block</h2>
        <p>
          Tap a message in a flock chat or a direct message and use the flag to{' '}
          <strong>Report</strong> it. The{' '}
          {/* ⋯ (U+22EF) is an icon rendered as a character. Screen readers at
              their default punctuation level say nothing for it, so this
              sentence lost its subject and became "The menu at the top of a
              direct message". The hidden text is the exact aria-label the
              button carries in App.js, so what is read here is what is read
              when the user gets there. */}
          <strong>
            <span aria-hidden="true">⋯</span>
            <span className="pp-sr-only">More options</span>
          </strong>{' '}
          menu at the top of a direct
          message reports or blocks the person. You can also report from someone's profile,
          from a venue review, and from a guest's name on a plan.
        </p>
        <p>
          Blocking is mutual: a blocked account can't message you, add you, or see your
          content, and you won't see theirs. Blocking also ends the friendship if you had
          one, and unblocking does not restore it. You can see and undo your blocks in{' '}
          <strong>Profile</strong> &rarr; <strong>Blocked accounts</strong>. You can also email{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
      </section>

      {/* "Our team reviews reports" was the one sentence on these pages that
          named people who do not exist: Flock is built by one person and
          /about says so. It is also a moderation commitment App Review reads
          for Guideline 1.2, so it could not just be deleted. What it promises
          (every report is read, and acted on promptly) is unchanged; only the
          invented headcount is gone. */}
      <section>
        <h2>What happens after a report</h2>
        <p>
          Every report is reviewed and acted on promptly, typically by removing the violating
          content and ejecting the responsible user. Serious or repeated violations result in a permanent
          ban. Deleting a banned account does not lift the ban. Illegal content may be reported
          to the authorities.
        </p>
      </section>

      <section>
        <h2>Automatic screening</h2>
        <p>
          Reports aren't the only line of defense. Messages, captions, and the other text
          you type pass through a language filter before they're stored, and every photo is
          screened by Google's SafeSearch before anyone can see it. Animated images are
          refused, because a scan of the first frame says nothing about the rest. If a check
          fails, or if it cannot run at all, the content does not post.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          General: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> &middot; Child safety:{' '}
          <a href={`mailto:${CHILD_SAFETY_EMAIL}`}>{CHILD_SAFETY_EMAIL}</a>.
        </p>
      </section>

      {/* The shared SiteFooter: legal links, the one real mailbox, and the
          copyright. It stays inside main.pp because .pp paints the page. */}
      <SiteFooter className="pp-footer" />
    </main>
  );
}
