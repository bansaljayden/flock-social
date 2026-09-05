/**
 * A SHARED VENUE, AS A MESSAGE.
 *
 * WHAT IT REPLACES. The venue card in the stream today is a full width tile
 * with a 140px photo, a category chip, a rating, a price band, a distance, a
 * "View details" button and a "Vote" button. Two actions and a picture that
 * takes half a screen, for a thing somebody dropped into the chat as a
 * suggestion. The rebuild shrinks it to a 64px thumbnail and ONE action,
 * because the card is a message and the venue's own page is where the detail
 * lives.
 *
 * ONE ACTION, AND NEVER THE WORD "VIEW". The whole card is the tap target and
 * it opens the venue. A "View details" button next to a card that already
 * opens on tap teaches the reader that the card does not, which is the exact
 * confusion the rebuild is removing. So the footer carries the one thing tap
 * cannot do: Vote inside a flock, Pin inside a DM (rebuild plan, "Shared
 * venue cards"). The surface decides which, because a DM has no vote to join
 * and a flock has no single pinned venue.
 *
 * THE FIELD NAMES ARE THE ONES ALREADY IN THE STREAM. A venue card message
 * carries `venue_data`, and both chat screens read it as `{ name, addr,
 * place_id, photo_url, lat, lng, type, rating | stars }`. `formatted_address`
 * appears on rows that came straight from Places, which is why the address
 * falls back through both.
 *
 * NO FIGURE THE PROPS DID NOT SUPPLY. The vote count is optional and prints
 * as "Vote . 1" only when it is a real number above zero. Nothing here
 * derives a count, a distance or a rating from anything else.
 */
import React from 'react';
import { CardShell } from './SystemRow';
import Icons from '../../ui/Icons';
import './cards.css';

export default function VenueCardRow({
  venue,
  surface = 'flock',
  actionActive = false,
  count = null,
  onOpen,
  onAction,
}) {
  if (!venue || typeof venue.name !== 'string' || venue.name.length === 0) return null;

  const isDm = surface === 'dm';
  const address = venue.addr || venue.formatted_address || null;
  const photo = venue.photo_url || null;

  const base = isDm
    ? (actionActive ? 'Pinned' : 'Pin')
    : (actionActive ? 'Voted' : 'Vote');
  const tally = Number.isFinite(Number(count)) && Number(count) > 0 ? Number(count) : null;
  const actionLabel = tally !== null ? `${base} · ${tally}` : base;

  const stop = (fn) => (e) => {
    e.stopPropagation();
    if (typeof fn === 'function') fn(e);
  };

  return (
    <CardShell
      onOpen={onOpen}
      ariaLabel={onOpen ? `${venue.name}. Open the place.` : undefined}
      data-card="venue"
      data-venue-surface={surface}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
        {/* No photo means no photo. There is no stock image and no coloured
            block pretending to be one: a map pin on the cream ground says the
            app has a place and not a picture of it. */}
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
          {photo
            ? (
              <img
                src={photo}
                alt=""
                loading="lazy"
                decoding="async"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            )
            : Icons.mapPin('var(--text-tertiary)', 22)}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="chat-truncate"
            style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', lineHeight: '20px' }}
          >
            {venue.name}
          </div>
          {address && (
            <div
              className="chat-truncate"
              style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-secondary)', lineHeight: '18px', marginTop: '2px' }}
            >
              {address}
            </div>
          )}
        </div>
      </div>

      {typeof onAction === 'function' && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px' }}>
          <button
            type="button"
            className="hit44"
            aria-pressed={actionActive}
            onClick={stop(onAction)}
            style={{
              minHeight: '44px',
              padding: '0 16px',
              borderRadius: '12px',
              border: actionActive ? '1.5px solid var(--chat-accent)' : 'none',
              background: actionActive ? 'transparent' : 'var(--chat-accent)',
              color: actionActive ? 'var(--chat-accent)' : 'var(--chat-on-fill)',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {actionLabel}
          </button>
        </div>
      )}
    </CardShell>
  );
}
