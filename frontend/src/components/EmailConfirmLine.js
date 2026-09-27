/**
 * CONFIRM YOUR EMAIL, SAID BEFORE IT IS NEEDED.
 *
 * An account made with an email and a password can do almost nothing that
 * matters until the link in its first email is opened: starting a flock,
 * joining one, adding a friend and saving a payment handle all answer 403
 * (UNVERIFIED_DENY in backend/middleware/auth.js, which reads the row on every
 * request, so the gate is the server's and this line only reports it). Sign
 * up offers "Continue for now, confirm later", and that door led to a Nest
 * whose only two buttons, Start a flock and Add friends, are both on that
 * list. The first anybody heard of it was VerifyEmailSheet, raised by the 403
 * after they had typed a plan name, picked a time and invited people.
 *
 * So the Nest and the create screen say it up front, in one ruled line: what
 * is waiting on the link, where the link goes, a way to ask for it, and a way
 * to say it has been opened. That last one matters most in the iOS app, where
 * the link opens in Safari and nothing in the app hears about it; App.js also
 * re-reads the account on the way back to the foreground, so the line usually
 * goes on its own.
 *
 * It says where the link GOES, not that it was sent. Whether the signup mail
 * actually left is known only to the signup screen (verificationSent), and a
 * sentence claiming an inbox has something in it is the claim that screen was
 * rebuilt to stop making.
 *
 * Presentational only. The resend cooldown, the suppression flag and the note
 * are the same state VerifyEmailSheet reads, so the two can never disagree
 * about whether a link can be asked for.
 */
import React from 'react';

const textButton = (enabled) => ({
  padding: '8px 0',
  border: 'none',
  background: 'none',
  color: enabled ? 'var(--text-primary)' : 'var(--text-tertiary)',
  fontSize: 'var(--t-meta)',
  fontWeight: '600',
  textDecoration: enabled ? 'underline' : 'none',
  textUnderlineOffset: '3px',
  cursor: enabled ? 'pointer' : 'default',
});

export default function EmailConfirmLine({
  email,
  onResend,
  onCheck,
  cooldown,
  refused,
  checking,
  note,
  style,
}) {
  const canResend = !(cooldown > 0) && !refused;
  return (
    <section
      aria-label="Confirm your email"
      data-testid="email-confirm-line"
      style={{
        borderTop: '1px solid var(--border-default)',
        borderBottom: '1px solid var(--border-default)',
        padding: '10px 2px 4px',
        ...style,
      }}
    >
      <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-primary)', margin: 0, lineHeight: 1.45, overflowWrap: 'anywhere' }}>
        Confirm your email to start a flock or add friends.
        {email ? <> The link goes to <strong style={{ fontWeight: '600' }}>{email}</strong>.</> : null}
      </p>
      {note && (
        <p role="status" style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '6px 0 0', lineHeight: 1.45 }}>{note}</p>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: '20px' }}>
        <button type="button" className="hit44" onClick={onResend} disabled={!canResend} style={textButton(canResend)}>
          {/* Same three states as the sheet's button. A suppressed address
              cannot be helped by asking again, and the note above says why. */}
          {refused ? 'We cannot mail that address' : cooldown > 0 ? `Send it again in ${cooldown}s` : 'Send the link'}
        </button>
        <button type="button" className="hit44" onClick={onCheck} disabled={checking} style={textButton(!checking)}>
          {checking ? 'Checking' : "I've confirmed"}
        </button>
      </div>
    </section>
  );
}
