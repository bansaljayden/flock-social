import React, { useEffect } from 'react';
import './PrivacyPolicy.css';

const EFFECTIVE_DATE = 'June 16, 2026';
const SUPPORT_EMAIL = 'support@flockcorp.com';
const CHILD_SAFETY_EMAIL = 'safety@flockcorp.com';

export default function CommunityGuidelines() {
  useEffect(() => {
    document.title = 'Community Guidelines — Flock';
  }, []);

  return (
    <main className="pp">
      <a href="/landing" className="pp-back">&larr; flockcorp.com</a>

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
        <h2>Child safety — zero tolerance (CSAE)</h2>
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
            Flock is intended for users 13 and older; we use a neutral age screen and do not
            knowingly allow children under 13.
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
          In Flock, long-press a message or open a profile to <strong>Report</strong> content or{' '}
          <strong>Block</strong> a user. Blocking is mutual — a blocked user can't message you,
          add you, or see your content, and you won't see theirs. You can also email{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
      </section>

      <section>
        <h2>What happens after a report</h2>
        <p>
          Our team reviews reports and acts promptly — typically removing violating content and
          ejecting the responsible user. Serious or repeated violations result in a permanent
          ban. Illegal content may be reported to the authorities.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          General: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> &middot; Child safety:{' '}
          <a href={`mailto:${CHILD_SAFETY_EMAIL}`}>{CHILD_SAFETY_EMAIL}</a>.
        </p>
      </section>

      <footer className="pp-footer">
        <p>&copy; {new Date().getFullYear()} Flock Corp.</p>
      </footer>
    </main>
  );
}
