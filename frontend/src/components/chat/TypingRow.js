import React from 'react';
import './chat.css';

/**
 * TypingRow: presence and typing, in one strip directly above the input bar.
 *
 * WHAT THIS REPLACES. Three separate things that all claimed to say who was
 * around. The fixed 58pt typing slot at the bottom of the flock stream (a
 * bubble with an avatar and three dots, drawn in the message list itself), the
 * DM's own copy of it, and the header subtitle. The plan retires all three for
 * one strip, and this is it.
 *
 * WHAT IT DRAWS. One outlined pill per member who is either in the chat or
 * typing, the name inside it in small caps in that member's colour, 20 tall
 * with a 2 stroke (measured 18 to 21, 2). A member who is present has their
 * avatar peeking over the top left of their pill. A member who is typing gets
 * a thought bubble of three dots beside the name.
 *
 * IT NEVER INVENTS A PERSON. A member with neither `present` nor `typing` is
 * not drawn, and an empty strip renders nothing at all rather than reserving
 * an empty band. There is no "online" here that is not a live socket fact: the
 * green dot this screen used to paint on whichever message happened to be
 * first in the page was wired to no presence data, and that is the exact class
 * of lie this file must not repeat.
 *
 * WHY IT COLLAPSES rather than holding a fixed height. The old fixed slot cost
 * 58pt of a phone screen at all times to show something that is true for a few
 * seconds an hour. The list above is bottom anchored, so when the strip
 * appears the stream slides up under it and the composer does not move.
 *
 * THE SPOKEN SENTENCE IS ALWAYS MOUNTED, and the pills are not. A screen
 * reader only notices text arriving inside a region that was already in the
 * accessibility tree: a region created together with its first sentence is a
 * fresh element insertion, which VoiceOver routinely says nothing about, and
 * this strip is the ONE place a non-sighted reader is told somebody is typing.
 * So the clipped region below is rendered whether or not anybody is here, and
 * only its text changes. It is 1px, absolutely positioned and clipped, so an
 * empty strip still occupies nothing. That is SLOP-AUDIT section N, the same
 * fix the toast got. It only works if the parent keeps this component mounted
 * across the empty state rather than rendering it conditionally, so the screen
 * mounts `<TypingRow members={...} />` once and lets it decide.
 *
 * PROPS
 *   members  [{ id, name, colour, avatarUrl, present, typing }]
 *   ground   optional background the avatar ring is drawn in, so the ring
 *            reads as a cut-out. Defaults to the stream ground token.
 */

const firstNameOf = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/** "Maya is typing", "Maya and Ava are typing", "Maya, Ava and Cal are typing". */
export function typingSentence(names) {
  const list = (names || []).filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return `${list[0]} is typing`;
  if (list.length === 2) return `${list[0]} and ${list[1]} are typing`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]} are typing`;
}

/** "Ava is in the chat", "Ava and Cal are in the chat". */
export function presenceSentence(names) {
  const list = (names || []).filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return `${list[0]} is in the chat`;
  if (list.length === 2) return `${list[0]} and ${list[1]} are in the chat`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]} are in the chat`;
}

function ThoughtDots({ colour }) {
  /* A thought bubble, not a speech bubble: the two trailing beads under the
     left edge are what make it read as thinking. Drawn in the member's own
     colour at 55% so it sits behind the name rather than beside it. */
  return (
    <span
      aria-hidden="true"
      style={{ display: 'inline-flex', alignItems: 'center', gap: '2px', marginLeft: '5px' }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '2px',
          padding: '0 4px',
          height: '10px',
          borderRadius: '5px',
          border: `1px solid ${colour}`,
        }}
      >
        <i className="chat-dot" style={{ width: '2.5px', height: '2.5px', borderRadius: '50%', background: colour, display: 'block' }} />
        <i className="chat-dot" style={{ width: '2.5px', height: '2.5px', borderRadius: '50%', background: colour, display: 'block' }} />
        <i className="chat-dot" style={{ width: '2.5px', height: '2.5px', borderRadius: '50%', background: colour, display: 'block' }} />
      </span>
      <span style={{ display: 'inline-flex', flexDirection: 'column', gap: '1px', paddingTop: '6px' }}>
        <i style={{ width: '2.5px', height: '2.5px', borderRadius: '50%', background: colour, display: 'block' }} />
        <i style={{ width: '1.5px', height: '1.5px', borderRadius: '50%', background: colour, display: 'block' }} />
      </span>
    </span>
  );
}

export default function TypingRow({ members, ground = 'var(--chat-ground)' }) {
  const shown = (members || []).filter((m) => m && (m.present || m.typing));

  const typingNames = shown.filter((m) => m.typing).map((m) => firstNameOf(m.name));
  const presentOnly = shown.filter((m) => m.present && !m.typing).map((m) => firstNameOf(m.name));
  const spoken = [typingSentence(typingNames), presenceSentence(presentOnly)]
    .filter(Boolean)
    .join('. ');

  return (
    <>
      {/* The pills are decoration for a screen reader; this sentence is the
          content. One live region, one string, so a member joining does not
          fire five announcements, and it outlives every member leaving so the
          next arrival is heard. */}
      <div className="chat-sr-only" aria-live="polite">{spoken}</div>

      {shown.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            flexWrap: 'wrap',
            gap: '8px',
            padding: '8px var(--chat-content-x) 6px',
            background: ground,
          }}
        >
          {shown.map((m) => {
            const colour = m.colour || 'var(--chat-name-fallback)';
            const first = firstNameOf(m.name);
            return (
              <span
                key={m.id != null ? m.id : first}
                aria-hidden="true"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  height: '20px',
                  padding: m.present ? '0 8px 0 16px' : '0 8px',
                  marginLeft: m.present ? '10px' : 0,
                  borderRadius: '10px',
                  border: `2px solid ${colour}`,
                  position: 'relative',
                  whiteSpace: 'nowrap',
                }}
              >
                {m.present && (
                  /* Peeking over the pill: half the avatar clears the top left
                     corner, and the ring is the stream ground so the pill's
                     stroke appears to pass behind it. */
                  <span
                    style={{
                      position: 'absolute',
                      left: '-11px',
                      top: '-7px',
                      width: '22px',
                      height: '22px',
                      borderRadius: '11px',
                      border: `2px solid ${ground}`,
                      background: colour,
                      color: 'var(--chat-ground)',
                      overflow: 'hidden',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '9px',
                      fontWeight: 700,
                    }}
                  >
                    {m.avatarUrl
                      ? <img src={m.avatarUrl} alt="" style={{ width: '22px', height: '22px', objectFit: 'cover' }} />
                      : (first[0] || '').toUpperCase()}
                  </span>
                )}
                <span
                  style={{
                    fontSize: '10px',
                    lineHeight: '10px',
                    fontWeight: 700,
                    letterSpacing: '0.6px',
                    textTransform: 'uppercase',
                    color: colour,
                  }}
                >
                  {first}
                </span>
                {m.typing && <ThoughtDots colour={colour} />}
              </span>
            );
          })}
        </div>
      )}
    </>
  );
}
