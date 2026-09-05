/**
 * WHO IS HERE. One card a night, updated in place.
 *
 * WHAT IT REPLACES. Nothing, in a group. Member locations exist today only as
 * pins on the map screen: a flock member sharing a position shows up on a map
 * the reader has to leave the chat to see, and the chat says nothing at all.
 * The rebuild gives the group the one line it actually wants at nine o'clock,
 * "3 near Kome, 2 on the way", posted once and rewritten as people arrive,
 * with the map a tap away (rebuild plan, "Member locations").
 *
 * ONE CARD, NOT ONE PER ARRIVAL. Six people arriving over twenty minutes is
 * six system rows in the old shape, which is a chat nobody can read. The
 * parent posts this once per night and updates it, the way the bill card
 * updates, so the stream carries one object for one fact.
 *
 * THE SENTENCE IS BUILT HERE, FROM COUNTS. The parent sends numbers and a
 * venue name; it never sends the line. A clause with a zero in it is not
 * drawn, so a card with everybody already at the bar reads "5 near Kome" and
 * not "5 near Kome, 0 on the way". A card with nothing to report does not
 * render at all: an empty who-is-here card is the app claiming to know where
 * people are while knowing nothing.
 *
 * WHY THE VENUE NAME IS OPTIONAL. A plan without a locked venue still has
 * people moving toward each other, and "3 nearby" is true then. Naming a
 * venue the group has not picked would not be.
 *
 * WHERE THE DATA COMES FROM. `flockMemberLocations` in App.js, which the
 * socket fills as `{ [userId]: { lat, lng, name, timestamp } }`. Turning
 * positions into "near" and "on the way" is a distance question against the
 * venue, and it is the parent's to answer: this card takes the answer.
 */
import React from 'react';
import { CardShell, MemberAvatar } from './SystemRow';
import './cards.css';

const asCount = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

export default function WhoIsHereCard({
  venueName = null,
  nearCount,
  onTheWayCount,
  members,
  onOpenMap,
}) {
  const near = asCount(nearCount);
  const onTheWay = asCount(onTheWayCount);
  const people = Array.isArray(members) ? members : [];

  if (near === 0 && onTheWay === 0) return null;

  const clauses = [];
  if (near > 0) {
    clauses.push(venueName ? `${near} near ${venueName}` : `${near} nearby`);
  }
  if (onTheWay > 0) {
    clauses.push(`${onTheWay} on the way`);
  }
  const sentence = clauses.join(', ');

  return (
    <CardShell
      onOpen={onOpenMap}
      ariaLabel={onOpenMap ? `${sentence}. Open the map.` : undefined}
      data-card="who-is-here"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <span
          style={{
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--text-tertiary)',
          }}
        >
          Who&apos;s here
        </span>

        {people.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            {people.map((m) => (
              <MemberAvatar
                key={m.id ?? m.name}
                name={m.name}
                src={m.avatarUrl}
                color={m.color}
                size={28}
                badge={m.status === 'near' || m.status === 'onTheWay' ? m.status : null}
              />
            ))}
          </div>
        )}

        <span
          aria-live="polite"
          className="chat-truncate"
          style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', lineHeight: '20px' }}
        >
          {sentence}
        </span>
      </div>
    </CardShell>
  );
}
