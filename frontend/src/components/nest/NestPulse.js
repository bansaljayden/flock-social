/**
 * OUT TONIGHT?: the reader's own answer, then the friends who said down.
 *
 * One segmented control, Down / Maybe / Not, on a quiet track: the most
 * tapped control in the app, so it keeps its 44px segments, its spoken names
 * ("Tonight: Down"), its pressed state, the optimistic write with a rollback
 * (handleSetPulse in App.js) and a 160 ms change. The audience is said right
 * under it, in the same words as before.
 *
 * The chosen answer is a tint of its hue with ink of the same hue (index.css
 * --pulse-{down,maybe,not}-{bg,ink}): every ink clears 4.5:1 on its tint and
 * every tint stands apart from the track (nestOutTonight.test.js). Down used
 * to fill its segment solid green under white, the loudest block on the page
 * after the hero and SOS, for an answer that is a quiet fact about tonight.
 *
 * Add friends is a steel text link at the end of the heading, so a returning
 * person with friends has it on the first screen and not only in the footer:
 * friends are what make the rest of the page work.
 *
 * Under that, the friends who are out tonight by name with their faces,
 * because what the people closest to you are doing is what moves you, and
 * a "Plan with them" that starts a plan with those friends already picked.
 * It adds to whoever is already picked, never replaces a draft, and sends
 * nothing until the person does. A friend who said Not is never shown, and
 * from midnight to 4 AM the line is not drawn at all (lib/pulse.js
 * friendsDownLine). The button belongs to the names: beside them when they
 * fit on one line, and under their first letter when they do not.
 */
import React from 'react';
import Icons from '../ui/Icons';
import { FaceRow } from './Face';

export const PULSE_OPTIONS = [
  { key: 'down', label: 'Down' },
  { key: 'maybe', label: 'Maybe' },
  { key: 'not', label: 'Not' },
];

const textLink = {
  display: 'inline-flex',
  alignItems: 'center',
  flexShrink: 0,
  minHeight: '36px',
  padding: 0,
  border: 'none',
  background: 'none',
  color: 'var(--accent-purple-text)',
  fontSize: 'var(--t-label)',
  fontWeight: '600',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

export default function NestPulse({ active, saving, onSet, friends, onPlanWith, onAddFriends }) {
  return (
    <div data-nest-band="out-tonight" style={{ marginBottom: '28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', margin: '0 0 10px', minHeight: '20px' }}>
        <h2 style={{ margin: 0, fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--text-primary)' }}>Out tonight?</h2>
        {onAddFriends && (
          <button type="button" className="hit44" onClick={onAddFriends} style={{ ...textLink, gap: '6px', minHeight: '32px', margin: '-6px 0' }}>
            {Icons.userPlus('var(--accent-purple-text)', 14)} Add friends
          </button>
        )}
      </div>
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
                backgroundColor: on ? `var(--pulse-${opt.key}-bg)` : 'transparent',
                color: on ? `var(--pulse-${opt.key}-ink)` : 'var(--text-secondary)',
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
        // The faces, then one wrapping line that holds the names and the
        // button: beside the names while they fit, and at the start of its
        // own line, under the names' first letter, when they do not.
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginTop: '10px' }}>
          <span style={{ display: 'flex', alignItems: 'center', minHeight: '36px', flexShrink: 0 }}>
            <FaceRow people={friends.people.slice(0, 3).map((p) => ({ key: p.id, name: p.name, image: p.profile_image_url }))} total={Math.min(3, friends.people.length)} size={28} max={3} ring="var(--bg-primary)" />
          </span>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: '10px', minHeight: '36px' }}>
            <span style={{ flex: '1 1 150px', minWidth: 0, fontSize: 'var(--t-label)', fontWeight: '500', lineHeight: 1.4, color: 'var(--text-secondary)' }}>{friends.text}</span>
            <button type="button" className="hit44" onClick={onPlanWith} style={{ ...textLink, gap: '2px' }}>
              {friends.planLabel} {Icons.chevronRight('var(--accent-purple-text)', 14)}
            </button>
          </div>
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
