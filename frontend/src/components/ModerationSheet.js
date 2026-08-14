import React, { useState, useEffect, useRef } from 'react';
import { reportContent, blockUser } from '../services/api';

// UGC moderation sheet (Apple Guideline 1.2). Opened from a message action, a
// user/profile menu, or a guest's card in a flock roster. Lets a user REPORT
// objectionable content and BLOCK an abusive user — the two mechanisms Apple
// requires and that our CommunityGuidelines / TermsOfService pages promise
// ("long-press a message or open a profile to Report content or Block a user").
//
// `target` shape (null = closed):
//   { userId, userName, contentType, contentId }
//     contentType ∈ 'flock_message' | 'dm' | 'profile' | 'story' | 'venue_review'
//                 | 'venue_promotion' | 'guest_rsvp'   (backend contract:
//                   VALID_CONTENT_TYPES in backend/routes/moderation.js)
//     contentId   — the row id when reporting one piece of content, else undefined
//     userId      — omit for a guest RSVP: there is no Flock account behind a
//                   guest, so the Block control correctly does not render.
//
// Reasons mirror VALID_REASONS in backend/routes/moderation.js exactly.
const REASONS = [
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'spam', label: 'Spam' },
  { value: 'hate', label: 'Hate speech' },
  { value: 'sexual', label: 'Nudity or sexual content' },
  { value: 'violence', label: 'Violence or threats' },
  { value: 'self_harm', label: 'Self-harm' },
  { value: 'other', label: 'Something else' },
];

// What the user is actually looking at, so the button does not say "Report this
// message" over a venue review or a guest's name. The old label was a single
// `contentId ? 'this message' : 'user'` ternary, which was wrong for four of the
// seven types the backend accepts.
const NOUNS = {
  flock_message: 'this message',
  dm: 'this message',
  story: 'this story',
  venue_review: 'this review',
  venue_promotion: 'this promotion',
  guest_rsvp: 'this guest name',
  profile: 'this user',
};

const FONT = "'Hanken Grotesk', -apple-system, BlinkMacSystemFont, sans-serif";

// Emoji are not UI icons in this app (SLOP-AUDIT H14). Both glyphs here used to
// be characters — a U+2691 flag and a 🚫 — and the flag had already been
// silently double-encoded once, rendering as garbage in the exact screen a
// reviewer opens to verify Guideline 1.2. Stroke SVG cannot rot in transit.
const Icon = ({ children, color }) => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
    {children}
  </svg>
);
const FlagIcon = ({ color }) => (
  <Icon color={color}><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" /></Icon>
);
const BlockIcon = ({ color }) => (
  <Icon color={color}><circle cx="12" cy="12" r="10" /><line x1="4.9" y1="4.9" x2="19.1" y2="19.1" /></Icon>
);

const ModerationSheet = ({ target, onClose, showToast, onBlocked }) => {
  // 'menu' | 'report' | 'block' | 'reported' — 'reported' is the step after a
  // successful report, which offers the block. See the note on submitReport.
  const [mode, setMode] = useState('menu');
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const sheetRef = useRef(null);

  // Reset to the menu each time the sheet is (re)opened for a new target.
  useEffect(() => {
    if (target) { setMode('menu'); setReason(''); setDetails(''); setBusy(false); }
  }, [target]);

  // Escape closes, and the sheet announces itself as a dialog. App.js has a
  // DialogBehavior helper that does this for its own modals, but it is defined
  // inside App.js and not exported, so the two components that live in
  // components/ had neither. A keyboard user could open this sheet and have no
  // way out of it, on the one screen an accessibility pass is most likely to
  // land on. Never closes mid-request — see the backdrop handler.
  useEffect(() => {
    if (!target) return undefined;
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      // stopImmediatePropagation, not stopPropagation: App.js's DialogBehavior
      // binds its own capture-phase keydown to `document` too, and same-target
      // listeners are not stopped by stopPropagation alone. Without this,
      // Escape over this sheet would also dismiss whatever dialog opened it.
      e.stopImmediatePropagation();
      if (!busy) onClose?.();
    };
    document.addEventListener('keydown', onKeyDown, true);
    const t = setTimeout(() => {
      const first = sheetRef.current?.querySelector('button');
      try { first?.focus({ preventScroll: true }); } catch { /* detached */ }
    }, 0);
    return () => { document.removeEventListener('keydown', onKeyDown, true); clearTimeout(t); };
  }, [target, busy, onClose]);

  if (!target) return null;

  const { userId, userName, contentType = 'profile', contentId } = target;
  const who = userName || 'this user';
  const noun = NOUNS[contentType] || 'this content';
  const reportingContent = !!contentId;

  const submitReport = async () => {
    if (!reason) { showToast?.('Pick a reason first', 'error'); return; }
    setBusy(true);
    try {
      await reportContent({ contentType, contentId, reportedUserId: userId, reason, details });
      // The sheet used to close here. Report and Block are the two halves of
      // Guideline 1.2 and somebody reporting harassment almost always wants the
      // person gone as well — closing the sheet made them find their way back
      // through the same menu to do it. The confirmation now carries the block
      // as its primary action, so the whole journey is one flow. If they only
      // wanted to report, Done is right there.
      if (userId) {
        setMode('reported');
      } else {
        showToast?.('Report received. Our team will review it.', 'success');
        onClose?.();
      }
    } catch (err) {
      showToast?.(err.message || 'Could not submit report', 'error');
    } finally {
      setBusy(false);
    }
  };

  const confirmBlock = async () => {
    if (!userId) { showToast?.('Cannot block this user', 'error'); return; }
    setBusy(true);
    try {
      await blockUser(userId);
      showToast?.(`${who} blocked`, 'success');
      onBlocked?.(userId);
      onClose?.();
    } catch (err) {
      showToast?.(err.message || 'Could not block user', 'error');
    } finally {
      setBusy(false);
    }
  };

  const sheetBtn = {
    width: '100%', padding: '15px 16px', textAlign: 'left', border: 'none',
    backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer', fontSize: '15px',
    fontWeight: '600', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '10px',
    borderBottom: '1px solid var(--border-subtle)', fontFamily: FONT,
  };
  const ghostBtn = {
    flex: 1, padding: '13px', borderRadius: '12px', border: '1px solid var(--border-default)',
    backgroundColor: 'transparent', color: 'var(--text-secondary)', fontSize: '14px',
    fontWeight: '600', cursor: 'pointer', fontFamily: FONT,
  };
  const dangerBtn = (disabled) => ({
    flex: 2, padding: '13px', borderRadius: '12px', border: 'none', backgroundColor: '#EF4444',
    color: 'white', fontSize: '14px', fontWeight: '700', fontFamily: FONT,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
  });

  return (
    <div
      // A tap outside dismisses, except while a report or block is in flight:
      // losing the sheet mid-request left the user with no idea whether it went
      // through, on the one action where that matters most.
      onClick={() => { if (!busy) onClose?.(); }}
      style={{ position: 'absolute', inset: 0, zIndex: 200, backgroundColor: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        // Announces only what the sheet actually offers. Without a userId there
        // is no account to block and the Block control does not render, so
        // saying "report or block" would promise a screen reader an action that
        // is not there. That is the guest RSVP case.
        aria-label={userId ? `Report or block ${who}` : `Report ${who}`}
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: '440px', backgroundColor: 'var(--bg-card-solid)', borderTopLeftRadius: '20px', borderTopRightRadius: '20px', overflow: 'hidden', boxShadow: '0 -8px 30px rgba(0,0,0,0.25)', animation: 'fadeInUp 0.25s ease-out', fontFamily: FONT }}
      >
        <div style={{ width: '38px', height: '4px', borderRadius: '2px', backgroundColor: 'var(--border-default)', margin: '10px auto 4px' }} />

        {mode === 'menu' && (
          <div>
            <p style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-secondary)', textAlign: 'center', margin: '8px 0 12px' }}>{who}</p>
            <button style={sheetBtn} onClick={() => setMode('report')}>
              <FlagIcon color="var(--text-primary)" /> Report {reportingContent ? noun : who}
            </button>
            {userId && (
              <button style={{ ...sheetBtn, color: '#EF4444' }} onClick={() => setMode('block')}>
                <BlockIcon color="#EF4444" /> Block {who}
              </button>
            )}
            <button style={{ ...sheetBtn, borderBottom: 'none', justifyContent: 'center', color: 'var(--text-secondary)' }} onClick={onClose}>Cancel</button>
          </div>
        )}

        {mode === 'report' && (
          <div style={{ padding: '4px 16px 20px' }}>
            <h3 style={{ fontSize: '16px', fontWeight: '700', color: 'var(--text-primary)', margin: '6px 0 4px' }}>Why are you reporting this?</h3>
            {/* "Your report is anonymous" was not true: content_reports stores
                reporter_id and the admin queue shows it. What is true, and what
                the user is actually worried about, is that the other person is
                never told. Say that instead. */}
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 14px' }}>We never tell them who reported. Our team reviews every report.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
              {REASONS.map(r => (
                <button key={r.value} aria-pressed={reason === r.value} onClick={() => setReason(r.value)} style={{ width: '100%', padding: '12px 14px', textAlign: 'left', borderRadius: '12px', border: reason === r.value ? '2px solid var(--text-primary)' : '1px solid var(--border-default)', backgroundColor: reason === r.value ? 'var(--bg-hover)' : 'transparent', color: 'var(--text-primary)', fontSize: '14px', fontWeight: '600', cursor: 'pointer', fontFamily: FONT }}>{r.label}</button>
              ))}
            </div>
            <textarea value={details} onChange={(e) => setDetails(e.target.value)} maxLength={1000} aria-label="Add details (optional)" placeholder="Add details (optional)" rows={3} style={{ width: '100%', boxSizing: 'border-box', padding: '12px', borderRadius: '12px', border: '1px solid var(--border-default)', backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)', fontSize: '13px', resize: 'none', outline: 'none', marginBottom: '14px', fontFamily: 'inherit' }} />
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => setMode('menu')} disabled={busy} style={ghostBtn}>Back</button>
              <button onClick={submitReport} disabled={busy || !reason} style={dangerBtn(busy || !reason)}>{busy ? 'Submitting…' : 'Submit report'}</button>
            </div>
          </div>
        )}

        {mode === 'reported' && (
          <div style={{ padding: '4px 16px 20px' }}>
            <h3 style={{ fontSize: '16px', fontWeight: '700', color: 'var(--text-primary)', margin: '6px 0 6px' }}>Report sent</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '0 0 16px', lineHeight: 1.5 }}>Our team will review it. Do you also want to block {who}? They won't be able to message you or see your activity, and you won't see theirs.</p>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={onClose} disabled={busy} style={ghostBtn}>Done</button>
              <button onClick={confirmBlock} disabled={busy} style={dangerBtn(busy)}>{busy ? 'Blocking…' : `Block ${who}`}</button>
            </div>
          </div>
        )}

        {mode === 'block' && (
          <div style={{ padding: '4px 16px 20px' }}>
            <h3 style={{ fontSize: '16px', fontWeight: '700', color: 'var(--text-primary)', margin: '6px 0 6px' }}>Block {who}?</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '0 0 16px', lineHeight: 1.5 }}>{/* This used to warn that blocking was one-way inside the app,
                because getBlockedUsers/unblockUser existed in services/api.js
                with no caller. That stopped being true: App.js ships a Blocked
                accounts screen in Settings which lists them and unblocks with a
                confirm step. So saying it can be undone would now be honest.
                It is still left unsaid on purpose, because this is the moment
                someone is getting away from a person who is harassing them and
                "you can undo this later" is an argument against doing it. Say
                it on the screen that performs the undo, not on this one. */}
              They won't be able to message you or see your activity, and you won't see theirs. Blocking is mutual.</p>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => setMode('menu')} disabled={busy} style={ghostBtn}>Cancel</button>
              <button onClick={confirmBlock} disabled={busy} style={dangerBtn(busy)}>{busy ? 'Blocking…' : `Block ${who}`}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ModerationSheet;
