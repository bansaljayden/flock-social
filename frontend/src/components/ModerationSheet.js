import React, { useState, useEffect } from 'react';
import { reportContent, blockUser } from '../services/api';

// UGC moderation sheet (Apple Guideline 1.2). Opened from a message action or a
// user/profile menu. Lets a user REPORT objectionable content and BLOCK an abusive
// user — the two mechanisms Apple requires and that our CommunityGuidelines /
// TermsOfService pages promise ("long-press a message or open a profile to Report
// content or Block a user").
//
// `target` shape (null = closed):
//   { userId, userName, contentType, contentId }
//     contentType ∈ 'flock_message' | 'dm' | 'profile' | 'story'  (backend contract)
//     contentId   — message id when reporting a specific message, else undefined
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

const ModerationSheet = ({ target, onClose, showToast, onBlocked }) => {
  const [mode, setMode] = useState('menu'); // 'menu' | 'report' | 'block'
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);

  // Reset to the menu each time the sheet is (re)opened for a new target.
  useEffect(() => {
    if (target) { setMode('menu'); setReason(''); setDetails(''); setBusy(false); }
  }, [target]);

  if (!target) return null;

  const { userId, userName, contentType = 'profile', contentId } = target;
  const who = userName || 'this user';

  const submitReport = async () => {
    if (!reason) { showToast?.('Pick a reason first', 'error'); return; }
    setBusy(true);
    try {
      await reportContent({ contentType, contentId, reportedUserId: userId, reason, details });
      showToast?.('Report received. Our team will review it.', 'success');
      onClose?.();
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
    borderBottom: '1px solid var(--border-subtle)',
    fontFamily: "'Satoshi', -apple-system, BlinkMacSystemFont, sans-serif",
  };

  return (
    <div
      onClick={onClose}
      style={{ position: 'absolute', inset: 0, zIndex: 200, backgroundColor: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: '440px', backgroundColor: 'var(--bg-card-solid)', borderTopLeftRadius: '20px', borderTopRightRadius: '20px', overflow: 'hidden', boxShadow: '0 -8px 30px rgba(0,0,0,0.25)', animation: 'fadeInUp 0.25s ease-out', fontFamily: "'Satoshi', -apple-system, BlinkMacSystemFont, sans-serif" }}
      >
        <div style={{ width: '38px', height: '4px', borderRadius: '2px', backgroundColor: 'var(--border-default)', margin: '10px auto 4px' }} />

        {mode === 'menu' && (
          <div>
            <p style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-secondary)', textAlign: 'center', margin: '8px 0 12px' }}>{who}</p>
            <button style={sheetBtn} onClick={() => setMode('report')}>
              <span aria-hidden style={{ fontSize: '16px' }}>⚑</span> Report{contentId ? ' this message' : ' user'}
            </button>
            {userId && (
              <button style={{ ...sheetBtn, color: '#EF4444' }} onClick={() => setMode('block')}>
                <span aria-hidden style={{ fontSize: '16px' }}>🚫</span> Block {who}
              </button>
            )}
            <button style={{ ...sheetBtn, borderBottom: 'none', justifyContent: 'center', color: 'var(--text-secondary)' }} onClick={onClose}>Cancel</button>
          </div>
        )}

        {mode === 'report' && (
          <div style={{ padding: '4px 16px 20px' }}>
            <h3 style={{ fontSize: '16px', fontWeight: '700', color: 'var(--text-primary)', margin: '6px 0 4px' }}>Why are you reporting this?</h3>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 14px' }}>Your report is anonymous. Our team reviews every report.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
              {REASONS.map(r => (
                <button key={r.value} onClick={() => setReason(r.value)} style={{ width: '100%', padding: '12px 14px', textAlign: 'left', borderRadius: '12px', border: reason === r.value ? '2px solid var(--text-primary)' : '1px solid var(--border-default)', backgroundColor: reason === r.value ? 'var(--bg-hover)' : 'transparent', color: 'var(--text-primary)', fontSize: '14px', fontWeight: '600', cursor: 'pointer' }}>{r.label}</button>
              ))}
            </div>
            <textarea value={details} onChange={(e) => setDetails(e.target.value)} maxLength={1000} placeholder="Add details (optional)" rows={3} style={{ width: '100%', boxSizing: 'border-box', padding: '12px', borderRadius: '12px', border: '1px solid var(--border-default)', backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)', fontSize: '13px', resize: 'none', outline: 'none', marginBottom: '14px', fontFamily: 'inherit' }} />
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => setMode('menu')} disabled={busy} style={{ flex: 1, padding: '13px', borderRadius: '12px', border: '1px solid var(--border-default)', backgroundColor: 'transparent', color: 'var(--text-secondary)', fontSize: '14px', fontWeight: '600', cursor: 'pointer' }}>Back</button>
              <button onClick={submitReport} disabled={busy || !reason} style={{ flex: 2, padding: '13px', borderRadius: '12px', border: 'none', backgroundColor: '#EF4444', color: 'white', fontSize: '14px', fontWeight: '700', cursor: busy || !reason ? 'not-allowed' : 'pointer', opacity: busy || !reason ? 0.6 : 1 }}>{busy ? 'Submitting…' : 'Submit report'}</button>
            </div>
          </div>
        )}

        {mode === 'block' && (
          <div style={{ padding: '4px 16px 20px' }}>
            <h3 style={{ fontSize: '16px', fontWeight: '700', color: 'var(--text-primary)', margin: '6px 0 6px' }}>Block {who}?</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '0 0 16px', lineHeight: 1.5 }}>They won't be able to message you or see your activity, and you won't see theirs. Blocking is mutual.</p>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => setMode('menu')} disabled={busy} style={{ flex: 1, padding: '13px', borderRadius: '12px', border: '1px solid var(--border-default)', backgroundColor: 'transparent', color: 'var(--text-secondary)', fontSize: '14px', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
              <button onClick={confirmBlock} disabled={busy} style={{ flex: 2, padding: '13px', borderRadius: '12px', border: 'none', backgroundColor: '#EF4444', color: 'white', fontSize: '14px', fontWeight: '700', cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1 }}>{busy ? 'Blocking…' : `Block ${who}`}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ModerationSheet;
