/**
 * A FRIEND'S LINK, AND WHO IT BELONGS TO, BEFORE ANYTHING IS SENT.
 *
 * Opening flockcorp.com/add/<code> (a friend's QR read by the phone's own
 * camera, a link in a text, the website's page after a sign-up) used to do
 * nothing anywhere. Now App.js keeps the code and raises this sheet at the
 * root, over whatever screen is open, and it says who the code is for with
 * one button that does the one thing that makes sense:
 *
 *   none       Add <name>?                         Send request
 *   incoming   <name> asked to be your friend       Accept
 *   outgoing   You've already asked <name>          Done
 *   accepted   You're already friends               Done
 *   self       That's your own code                 Done
 *
 * plus Not now, which forgets the code.
 *
 * THE LINK NEVER SENDS BY ITSELF. add-by-code accepts a pending request from
 * the code's owner, so a link that acted on its own would make two people
 * friends without one of them seeing who. Only the button sends, and App.js's
 * handler is the only thing that calls the server.
 *
 * Presentational: App.js owns the read (GET /api/friends/by-code/:code), the
 * pending code and the send. It sits above the screens and below the
 * confirm-your-email sheet, which a refusal for an unconfirmed address raises
 * over it, so the person confirms and comes straight back to this.
 */
import React from 'react';
import { SkeletonBar, SkeletonCircle } from './ui/Skeleton';

const FACE = 64;

export default function FriendCodeSheet({
  DialogBehavior,
  sheet,
  isDark,
  onSend,
  onDone,
  onNotNow,
  onRetry,
}) {
  if (!sheet) return null;
  const { phase, user, status, busy } = sheet;
  const name = (user && user.name) || 'your friend';

  // What the sheet says, and its one button, for each answer.
  let title = '';
  let body = '';
  let primary = null;
  if (phase === 'loading') {
    title = 'Finding your friend';
  } else if (phase === 'missing') {
    title = "That code didn't match anyone";
    body = 'Check the code with whoever sent it.';
    primary = { label: 'Done', run: onDone };
  } else if (phase === 'error') {
    title = "That didn't load";
    body = 'Check your connection and try again.';
    primary = { label: 'Try again', run: onRetry };
  } else if (status === 'incoming') {
    title = `${name} asked to be your friend`;
    primary = { label: busy ? 'Accepting…' : 'Accept', run: onSend };
  } else if (status === 'outgoing') {
    title = `You've already asked ${name}`;
    body = 'Your request is waiting for them.';
    primary = { label: 'Done', run: onDone };
  } else if (status === 'accepted') {
    title = "You're already friends";
    body = `You and ${name} are friends on Flock.`;
    primary = { label: 'Done', run: onDone };
  } else if (status === 'self') {
    title = "That's your own code";
    body = 'Send it to a friend and they can add you.';
    primary = { label: 'Done', run: onDone };
  } else {
    title = `Add ${name}?`;
    primary = { label: busy ? 'Sending…' : 'Send request', run: onSend };
  }

  const showFace = phase === 'ready' && user && status !== 'self';
  // Nothing closes the sheet while its one request is out, so the answer
  // always has somewhere to land.
  const close = busy ? () => {} : onNotNow;
  // Done already is the way out; a second button saying the same is noise.
  const offerNotNow = !primary || primary.run !== onDone;

  return (
    <div
      onClick={close}
      style={{ position: 'fixed', inset: 0, zIndex: 250, backgroundColor: 'var(--modal-backdrop)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 'var(--cb-height, 0px)', boxSizing: 'border-box' }}
    >
      <DialogBehavior onClose={close} label="Add a friend" />
      <div
        data-testid="friend-code-sheet"
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: '440px', backgroundColor: 'var(--bg-card-solid)', borderRadius: 'var(--r-xl) var(--r-xl) 0 0', padding: '22px 20px calc(22px + var(--safe-bottom))', boxSizing: 'border-box' }}
      >
        {phase === 'loading' ? (
          <div role="status" aria-label="Finding your friend" style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '18px' }}>
            <SkeletonCircle size={FACE} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <SkeletonBar width="60%" height={16} style={{ marginBottom: '8px' }} />
              <SkeletonBar width="40%" height={12} />
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: body ? '8px' : '18px' }}>
            {/* The theme's face disc, as every person row has: a fixed navy
                one was the dark sheet's own colour, so in the evening the
                initial floated on nothing. */}
            {showFace && (
              <div aria-hidden="true" data-testid="friend-code-face" style={{ width: `${FACE}px`, height: `${FACE}px`, borderRadius: 'var(--r-pill)', flexShrink: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--face-bg)', color: 'var(--text-primary)', fontSize: 'var(--t-title)', fontWeight: '600' }}>
                {user.profile_image_url
                  ? <img src={user.profile_image_url} alt="" style={{ width: `${FACE}px`, height: `${FACE}px`, objectFit: 'cover', display: 'block' }} />
                  : (String(user.name || '').trim()[0] || '?').toUpperCase()}
              </div>
            )}
            <h3 style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-display)', letterSpacing: '-0.005em', fontSize: 'var(--t-title)', fontWeight: '600', color: 'var(--text-primary)', margin: 0, lineHeight: 1.25, overflowWrap: 'anywhere' }}>{title}</h3>
          </div>
        )}
        {body && <p style={{ fontSize: 'var(--t-body)', color: 'var(--text-secondary)', margin: '0 0 18px', lineHeight: 1.5 }}>{body}</p>}
        {primary && (
          <button
            type="button"
            className="hit44"
            onClick={primary.run}
            disabled={busy}
            aria-busy={busy || undefined}
            style={{ width: '100%', height: '48px', borderRadius: 'var(--r-md)', border: 'none', background: isDark ? '#f1ede0' : '#1e293b', color: isDark ? '#1e293b' : '#ffffff', fontSize: 'var(--t-body)', fontWeight: '600', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1 }}
          >
            {primary.label}
          </button>
        )}
        {offerNotNow && (
          <button
            type="button"
            className="hit44"
            onClick={close}
            disabled={busy}
            style={{ width: '100%', height: '44px', marginTop: '8px', borderRadius: 'var(--r-md)', border: 'none', background: 'none', color: 'var(--text-secondary)', fontSize: 'var(--t-body)', fontWeight: '600', cursor: busy ? 'default' : 'pointer' }}
          >
            Not now
          </button>
        )}
      </div>
    </div>
  );
}
