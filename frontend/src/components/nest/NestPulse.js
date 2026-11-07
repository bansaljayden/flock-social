/**
 * OUT TONIGHT?: the reader's own answer, then the friends who said down.
 *
 * One segmented control, Down / Maybe / Not, on a quiet track: the most
 * tapped control in the app, so it keeps its 44px segments, its spoken names
 * ("Tonight: Down"), its pressed state, the optimistic write with a rollback
 * (handleSetPulse in App.js) and the fills that clear 4.5:1 under white. The
 * audience is said right under it, in the same words as before.
 *
 * Under that, the friends who are out tonight by name with their faces,
 * because what the people closest to you are doing is what moves you, and
 * a "Plan with them" that starts a plan with those friends already picked.
 * It adds to whoever is already picked, never replaces a draft, and sends
 * nothing until the person does. A friend who said Not is never shown, and
 * from midnight to 4 AM the line is not drawn at all (lib/pulse.js
 * friendsDownLine).
 */
import React from 'react';
import Icons from '../ui/Icons';
import { FaceRow } from './Face';

// The ACTIVE fill under white text has to clear 4.5:1 with white, not just
// read as green or amber: #047857 = 5.48:1, #b45309 = 5.02:1, #3f4a5a = 8.98:1.
export const PULSE_OPTIONS = [
  { key: 'down', fill: '#047857', label: 'Down' },
  { key: 'maybe', fill: '#b45309', label: 'Maybe' },
  { key: 'not', fill: '#3f4a5a', label: 'Not' },
];

export default function NestPulse({ active, saving, onSet, friends, onPlanWith }) {
  return (
    <div data-nest-band="out-tonight" style={{ marginBottom: '28px' }}>
      <h2 style={{ margin: '0 0 10px', fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--text-primary)' }}>Out tonight?</h2>
      <div style={{ display: 'flex', gap: '2px', padding: '2px', minHeight: '48px', boxSizing: 'border-box', borderRadius: '12px', backgroundColor: 'var(--bg-inset)' }}>
        {PULSE_OPTIONS.map((opt) => {
          const on = active === opt.key;
          return (
            <button
              type="button"
              key={opt.key}
              onClick={() => onSet(opt.key)}
              disabled={saving}
              aria-label={`Tonight: ${opt.label}`}
              aria-pressed={on}
              style={{
                flex: 1,
                // 44pt minimum tappable height (Apple HIG): the most tapped
                // control in the app.
                minHeight: '44px',
                padding: 0,
                border: 'none',
                borderRadius: '10px',
                backgroundColor: on ? opt.fill : 'transparent',
                color: on ? '#ffffff' : 'var(--text-secondary)',
                fontSize: 'var(--t-body)',
                fontWeight: '600',
                cursor: saving ? 'wait' : 'pointer',
                opacity: saving ? 0.6 : 1,
                transition: 'background-color 160ms var(--ease-out), color 160ms var(--ease-out)',
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {friends && (
        // One line when it fits; when the names run long (or the phone is
        // narrow) the button takes its own line under them, at the end.
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '10px', marginTop: '10px', minHeight: '44px' }}>
          <FaceRow people={friends.people.slice(0, 3).map((p) => ({ key: p.id, name: p.name, image: p.profile_image_url }))} total={Math.min(3, friends.people.length)} size={28} max={3} ring="var(--bg-primary)" />
          <span style={{ flex: '1 1 150px', minWidth: 0, fontSize: 'var(--t-label)', fontWeight: '500', lineHeight: 1.4, color: 'var(--text-secondary)' }}>{friends.text}</span>
          <button
            type="button"
            className="hit44"
            onClick={onPlanWith}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '2px', flexShrink: 0, marginLeft: 'auto', minHeight: '36px', padding: 0, border: 'none', background: 'none', color: 'var(--accent-purple-text)', fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            {friends.planLabel} {Icons.chevronRight('var(--accent-purple-text)', 14)}
          </button>
        </div>
      )}
      {/* The audience, stated. The first screen's one social disclosure:
          without it a stranger either guessed it was a mood widget or
          hesitated to tap. 4 AM is the server's own default expiry
          (routes/availability.js). */}
      <p style={{ margin: '10px 0 0', fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-tertiary)' }}>Friends see your answer until it clears at 4 AM.</p>
    </div>
  );
}
