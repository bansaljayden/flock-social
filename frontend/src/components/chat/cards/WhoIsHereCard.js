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
 *
 * THE LIST UNDER THE SENTENCE. "2 on the way" is the count; "on my way" is a
 * person saying so. A member who taps On my way or Need a ride rides an
 * intent on the same position packet (lib/travel.js), and the parent hands
 * those people down as `travellers`, one entry each, already turned into
 * words: an ETA label when the mode gives a speed, a distance label when it
 * does not, both null when there is no usable position. The card prints a
 * line per person, "Sam · about 8 min · driving, 2 seats", and never does the
 * arithmetic itself, for the same reason it never does the distance question:
 * one place answers "how far", and the card takes the answer.
 *
 * Who is in the list is the parent's call and the card does not second-guess
 * it. Somebody standing at the bar is here, not on the way, so they are in
 * the count and never in the list; the viewer is in neither. A plain share
 * with no intent is counted and not listed, because "on the way" is a fact
 * about a position and the list is what people SAID, and a name with nothing
 * said after it would be the card putting words in somebody's mouth.
 *
 * WHY THE COUNTS STILL RULE. The list can only ever describe people the
 * sentence already counts, so a list with a sentence that says nobody is
 * moving is two props disagreeing, and the numbers win: the zero-and-zero
 * card stays unrendered whatever the list holds. A card that drew a list
 * under no sentence would be the app claiming to know where people are on
 * the strength of one packet the count had already ruled out.
 */
import React from 'react';
import { CardShell, MemberAvatar } from './SystemRow';
import { MODE_LABEL } from '../../../lib/travel';
import './cards.css';

const asCount = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * Everything after the name on a traveller's line, as one string, so the
 * render below is a name and a detail and nothing else decides the wording.
 *
 * Heading there: the ETA when there is one, the distance when there is only
 * a position, and the bare fact when there is neither, then the mode, then
 * the spare seats for a car with any. A car with no spare seats says
 * "driving" and stops, because "0 seats" reads as an offer withdrawn and no
 * offer was made. Needing a ride: the ask, then how far off they are, so a
 * driver can see at a glance whether the pickup is on the way. No minutes
 * for a rider, because a person waiting for a lift has no speed.
 */
const travellerDetail = (t) => {
  if (t.intent === 'need_ride') {
    return `needs a ride${t.distanceLabel ? ` · ${t.distanceLabel}` : ''}`;
  }
  let out = t.etaLabel || t.distanceLabel || 'on the way';
  const modeLabel = t.mode ? MODE_LABEL[t.mode] : null;
  if (modeLabel) out += ` · ${modeLabel}`;
  const seats = Number(t.seats);
  if (t.mode === 'drive' && Number.isFinite(seats) && seats > 0) {
    out += `, ${seats} ${seats === 1 ? 'seat' : 'seats'}`;
  }
  return out;
};

export default function WhoIsHereCard({
  venueName = null,
  nearCount,
  onTheWayCount,
  members,
  travellers = [],
  onOpenMap,
}) {
  const near = asCount(nearCount);
  const onTheWay = asCount(onTheWayCount);
  const people = Array.isArray(members) ? members : [];
  const moving = Array.isArray(travellers) ? travellers : [];

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

        {moving.length > 0 && (
          // A group with a name, so a screen reader lands on "On the way" and
          // then reads the lines as its members, instead of a run of names and
          // minutes with nothing to say what they are. The avatar carries the
          // on-the-way badge for the same reason the strip above does: the
          // line is what the reader hears, the badge is what they see.
          <div
            role="group"
            aria-label="On the way"
            style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}
          >
            {moving.map((t) => (
              <div
                key={t.id ?? t.name}
                style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}
              >
                <MemberAvatar
                  name={t.name}
                  src={t.avatarUrl}
                  color={t.color}
                  size={22}
                  badge="onTheWay"
                />
                <span
                  className="chat-truncate"
                  style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '18px' }}
                >
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{t.name}</span>
                  {` · ${travellerDetail(t)}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </CardShell>
  );
}
