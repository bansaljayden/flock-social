/**
 * LIVE LOCATION, AS A CARD IN THE STREAM.
 *
 * WHAT IT REPLACES. The green strip that pins itself under the DM header for
 * as long as a share is running, plus the header sub-line that says "sharing
 * location" and nothing else. The strip goes. A share is an event: it starts,
 * it runs for a stated time, it ends. So it is posted where it started, it
 * updates in place while it runs, and the header keeps only a green dot
 * (rebuild plan, "Live location").
 *
 * AN ENDED SHARE IS NOT THIS CARD. When a share stops, the parent replaces it
 * with a SystemRow, because a card is an object you can act on and an ended
 * share is a thing that happened. That is why there is no "ended" mode here
 * and why `onExpire` exists: this card tells the parent its countdown reached
 * zero, and the parent decides what the stream shows next. It does not decide
 * for itself, because the server is the one that knows a share is over and a
 * client clock that runs a second fast must not retire a live share.
 *
 * NO COUNTDOWN THE PROPS DID NOT SUPPLY. The share duration is not a fact the
 * client can derive: the socket path in App.js emits a position every fifteen
 * seconds and carries no end time at all today, so `endsAt` arrives from the
 * duration the sharer picked (15 min, 1 hour, until the plan ends). With no
 * `endsAt` the card reads "Sharing live location" and stops there rather than
 * inventing a number. Same rule for the peer's distance: no `distanceMiles`,
 * no distance clause.
 *
 * WHY A TICK AND NOT A TIMESTAMP. "47 min left" has to fall to 46. The
 * interval below is 15 seconds, not one second, because the smallest thing
 * this card can say is a minute and a per-second timer on a chat screen is a
 * per-second re-render of a chat screen.
 */
import React, { useEffect, useRef, useState } from 'react';
import { CardShell } from './SystemRow';
import Icons from '../../ui/Icons';
import './cards.css';

const TICK_MS = 15000;

export const remainingLabel = (endsAt, nowMs) => {
  if (!endsAt) return null;
  const at = typeof endsAt === 'number' ? endsAt : Date.parse(endsAt);
  if (!Number.isFinite(at)) return null;
  const ms = at - nowMs;
  if (ms <= 0) return null;
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins} min left`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest === 0 ? `${hours} hr left` : `${hours} hr ${rest} min left`;
};

// A distance is a figure the props supplied or it is nothing at all.
// Number(null) is 0 and so is Number(''), both finite and neither negative,
// so coercing first turned "we have no position for this person" into "less
// than 0.1 mi away" on every peer card rendered without one. That is a false
// claim about where somebody is standing, which is worse than a cosmetic
// invented figure, so the type is settled before anything touches the value.
export const distanceLabel = (miles) => {
  if (typeof miles !== 'number' || !Number.isFinite(miles) || miles < 0) return null;
  if (miles < 0.1) return 'less than 0.1 mi away';
  if (miles < 10) return `${miles.toFixed(1)} mi away`;
  return `${Math.round(miles)} mi away`;
};

export default function LocationCard({
  mode = 'own',
  peerName,
  endsAt = null,
  distanceMiles = null,
  mapImageUrl = null,
  stopping = false,
  onStop,
  onOpenMap,
  onExpire,
}) {
  const [now, setNow] = useState(() => Date.now());
  const expired = useRef(false);

  // The window can change on a card that is already mounted: the sharer
  // extends the share, or the same slot in the stream is reused for the next
  // one. So the latch is released here, in the effect that already keys on
  // endsAt and that React runs before the expiry effect below, and the second
  // window gets its own onExpire instead of inheriting the first one's spent
  // one and sitting in the stream claiming a share that is over.
  useEffect(() => {
    if (!endsAt) return undefined;
    expired.current = false;
    // Nothing left to count down, so no timer at all. Without this an expired
    // card re-rendered the chat every fifteen seconds for a value that can no
    // longer change.
    if (remainingLabel(endsAt, Date.now()) === null) return undefined;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (remainingLabel(endsAt, t) === null) clearInterval(id);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [endsAt]);

  const remaining = remainingLabel(endsAt, now);

  useEffect(() => {
    if (!endsAt || remaining !== null || expired.current) return;
    expired.current = true;
    if (typeof onExpire === 'function') onExpire();
  }, [endsAt, remaining, onExpire]);

  const isOwn = mode !== 'peer';
  const who = (typeof peerName === 'string' && peerName.length > 0) ? peerName : null;

  // A peer card with nobody on it would say "is sharing" with a blank in
  // front of it, so it does not render. The parent knows who it received the
  // position from; if it does not, there is nothing honest to draw.
  if (!isOwn && !who) return null;

  const headline = isOwn ? 'Sharing live location' : `${who} is sharing`;
  const clause = isOwn ? remaining : distanceLabel(distanceMiles);

  return (
    <CardShell
      onOpen={onOpenMap}
      ariaLabel={onOpenMap ? `${headline}. Open the map.` : undefined}
      data-card="location"
      data-location-mode={isOwn ? 'own' : 'peer'}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div
          style={{
            width: '64px',
            height: '64px',
            flexShrink: 0,
            borderRadius: '12px',
            overflow: 'hidden',
            backgroundColor: 'var(--bg-tertiary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {mapImageUrl
            ? (
              <img
                src={mapImageUrl}
                alt=""
                loading="lazy"
                decoding="async"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            )
            : Icons.mapPin('var(--text-tertiary)', 22)}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {/* One sentence, and the half that moves is the half that announces.
              A screen reader hearing the whole line every fifteen seconds is
              worse than not hearing it at all, so the clause is its own live
              region and the headline is not. */}
          <div
            className="chat-truncate"
            style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', lineHeight: '20px' }}
          >
            {headline}
          </div>
          {clause && (
            <div
              aria-live="polite"
              style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-secondary)', lineHeight: '18px', marginTop: '2px' }}
            >
              {clause}
            </div>
          )}
        </div>

        {isOwn && typeof onStop === 'function' && (
          <button
            type="button"
            className="hit44"
            onClick={(e) => { e.stopPropagation(); onStop(e); }}
            disabled={stopping}
            style={{
              flexShrink: 0,
              minHeight: '44px',
              padding: '0 16px',
              borderRadius: '12px',
              border: '1.5px solid var(--chat-card-border)',
              background: 'transparent',
              color: 'var(--text-primary)',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              opacity: stopping ? 0.6 : 1,
            }}
          >
            {stopping ? 'Stopping' : 'Stop'}
          </button>
        )}
      </div>
    </CardShell>
  );
}
