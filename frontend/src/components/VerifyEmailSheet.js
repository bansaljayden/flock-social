/**
 * CONFIRM YOUR EMAIL, THE SHEET A 403 RAISES.
 *
 * This was an arrow function declared inside `FlockAppInner` and mounted as
 * `<VerifyEmailSheet />`. A component declared inside another component's
 * render is a NEW function object on every render, React reads that as a new
 * component TYPE, and a new type is not reconciled: the old subtree is
 * unmounted and a fresh one is mounted in its place. So every unrelated state
 * change anywhere in `FlockAppInner`, and this app has a clock ticking in it,
 * tore this sheet down and built it again.
 *
 * That is not cosmetic here. `DialogBehavior` moves focus to the first
 * focusable thing inside the dialog on MOUNT, so a remount dragged focus back
 * to the resend button out from under whatever the person was doing, and its
 * unmount handler put focus back somewhere else on the way out. The same
 * defect took the New Message sheet and the Edit Profile form with it, and it
 * is written up beside `numVenues` in App.js and pinned by
 * `__tests__/extractionEquivalence.test.js`.
 *
 * The fix is the one VenueDashboard, ChatDetail and AddFriends already used:
 * bind the component at module scope, where its identity is fixed for the life
 * of the page, and hand it everything it reads as a prop. Nothing else about
 * it changed. The body below is the old block verbatim, including its original
 * indentation, so it can be diffed against the deleted lines character for
 * character.
 *
 * `DialogBehavior` arrives as a prop rather than an import because it lives at
 * module scope in App.js and is not exported, which is exactly how AddFriends
 * receives it.
 */
import React from 'react';

const VerifyEmailSheet = ({
  DialogBehavior,
  authUser,
  isDark,
  resendVerification,
  setVerifyPrompt,
  verifyCooldown,
  verifyNote,
  verifyPrompt,
}) => verifyPrompt && (
    <div
      onClick={() => setVerifyPrompt(null)}
      style={{ position: 'fixed', inset: 0, zIndex: 300, backgroundColor: 'var(--modal-backdrop)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
    >
      {/* The one sheet in the file that was missing this: no Escape, no focus
          trap, and Tab walked straight out into the screen behind it. */}
      <DialogBehavior onClose={() => setVerifyPrompt(null)} label="Confirm your email" />
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: '440px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '20px 20px 0 0', padding: '22px 20px calc(22px + var(--safe-bottom))' }}>
        <h3 style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.005em', fontSize: 'var(--t-title)', fontWeight: '600', color: 'var(--text-primary)', margin: '0 0 8px' }}>Confirm your email first</h3>
        <p style={{ fontSize: 'var(--t-body)', color: 'var(--text-secondary)', margin: '0 0 16px', lineHeight: 1.5 }}>
          We sent a link to {authUser?.email || 'your inbox'} when you signed up. Open it and you can {verifyPrompt} right away.
        </p>
        {verifyNote && <p role="status" style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)', margin: '0 0 12px' }}>{verifyNote}</p>}
        <button
          className="hit44"
          onClick={resendVerification}
          disabled={verifyCooldown > 0}
          style={{ width: '100%', height: '48px', borderRadius: '14px', border: 'none', background: isDark ? '#f1ede0' : '#1e293b', color: isDark ? '#1e293b' : '#ffffff', fontSize: 'var(--t-body)', fontWeight: '600', cursor: verifyCooldown > 0 ? 'not-allowed' : 'pointer', opacity: verifyCooldown > 0 ? 0.5 : 1 }}
        >
          {verifyCooldown > 0 ? `Send it again in ${verifyCooldown}s` : 'Send the link again'}
        </button>
        <button
          className="hit44"
          onClick={() => setVerifyPrompt(null)}
          style={{ width: '100%', height: '44px', marginTop: '8px', borderRadius: '14px', border: 'none', background: 'none', color: 'var(--text-secondary)', fontSize: 'var(--t-body)', fontWeight: '600', cursor: 'pointer' }}
        >
          Not now
        </button>
      </div>
    </div>
  );

export default VerifyEmailSheet;
