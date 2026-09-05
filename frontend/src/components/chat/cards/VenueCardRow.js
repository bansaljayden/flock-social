/**
 * A SHARED VENUE, AS A MESSAGE.
 *
 * WHAT IT REPLACES. A place somebody dropped into the chat IS the message, the
 * way a photo message is, so it gets the room a message gets. It was a 64px
 * thumbnail row during the rebuild, which turned the one thing worth looking at
 * into a bullet point, and before that a tile with two competing buttons and an
 * inset photo floating inside a padded box.
 *
 * THE PICTURE RUNS THE FULL WIDTH OF THE CARD. Not inset with its own corner
 * radius inside a padded box: the card's own corners clip it, so the photo is
 * the top of the card rather than an object sitting on it. The card is padded
 * where the words are and nowhere else.
 *
 * AND IT IS CROPPED, NOT FITTED. This card is ONE MESSAGE and has to read as
 * one. At 16:9 the photo alone was 201pt on a 390pt phone, the card came to
 * 331pt, and the visible stream with the keyboard up is 327pt: a single shared
 * venue was the entire screen. The photo is a fixed 140pt band now (about
 * 2.6:1 at this width) and the card lands at 205pt, which is 63% of the
 * keyboard-up stream and leaves room for about one message above it.
 *
 * NO FOOTER BUTTON, AND THE ADDRESS IS GONE. A survey of how iMessage,
 * WhatsApp, Telegram, Signal, Discord, Messenger and Instagram DMs draw an
 * inline rich card found that not one of them puts a persistent full-width
 * button inside it, and not one shows more than a title and a single meta
 * line. The whole card is the tap target everywhere. So the address went (it
 * is one tap away on the venue's own page, which is where you go to navigate)
 * and the 44pt footer went with it.
 *
 * THE ACTION DID NOT GO. It moved onto the photo, opposite the crowd dial,
 * where it costs the card no height at all. Flock is the one product in that
 * survey where a shared place carries a vote, and tapping the card opens the
 * venue rather than casting one, so the action is the single thing a tap
 * cannot do and deleting it would have cost the coordination loop to save
 * 44pt that the crop had already found.
 *
 * WHAT IT MAY DRAW IS FIXED BY THE SERVER. `sanitizeVenueData` in
 * `backend/utils/venuePayload.js` is the only thing that reaches a client, and
 * it passes exactly: place_id, name, addr, rating, user_ratings_total,
 * price_level, type, category, crowd, photo_url, latitude, longitude. Every
 * one of them is optional, so every one is drawn ONLY when it arrived. A
 * withheld figure draws no label, no dash and no zero, and nothing here
 * invents one. The two derivations below are conversions, not inventions: a
 * price_level of 2 IS "$$", and a crowd of 72 IS "Busy" on the server's own
 * ladder.
 *
 * THE PHOTO PATH IS THE CALLER'S, NOT THIS FILE'S. A venue photo can arrive
 * as an absolute Google URL or as a relative api path that only resolves
 * against the API host, and this module is presentational: it has no BASE_URL
 * and must not reach for one. So the screen hands in `resolvePhoto` (the
 * app's own resolveVenuePhoto) and `placeholder` (the app's bird on cream).
 * With neither, the raw url is used as it arrived, which is right for an
 * absolute one and is all a card with no resolver can honestly do.
 *
 * A PHOTO THAT FAILS SHOWS THE PLACEHOLDER, NOT A BROKEN BOX. `onError` swaps
 * once. With no placeholder to swap to it falls back to the map pin rather
 * than leaving the browser's broken image glyph inside a message.
 *
 * ONE ACTION, AND NEVER THE WORD "VIEW". The whole card opens the venue. A
 * "View details" button next to a card that already opens on tap teaches the
 * reader that the card does not, which is the confusion the rebuild removed.
 * So the footer carries the one thing tap cannot do: Vote inside a flock, Pin
 * inside a DM. The surface decides which, because a DM has no vote to join
 * and a flock has no single pinned venue.
 *
 * AND WHEN THERE IS NOTHING TO OPEN, IT IS NOT A CONTROL. A venue card whose
 * `venue_data` carries no place_id has no page behind it. Announced as a
 * button it is a promise the card cannot keep: a screen reader calls it a
 * button, a finger presses it, and nothing happens. With no place_id, or no
 * handler, the shell is drawn as content: no role, no tab stop, no pointer.
 *
 * THE FIELD NAMES ARE THE ONES ALREADY IN THE STREAM. Both chat screens read
 * `venue_data` as `{ name, addr, place_id, photo_url, lat, lng, type, rating |
 * stars, price, crowd }`. `formatted_address` appears on rows that came
 * straight from Places, which is why the address falls back through both, and
 * `price` / `price_level` are both accepted because Birdie's share path writes
 * only the second one.
 */
import React, { useState } from 'react';
import { CardShell } from './SystemRow';
import Icons from '../../ui/Icons';
import { crowdLabelFor, crowdArcFor } from '../../../lib/crowd';
import './cards.css';

/* An explicit prop wins over the field on the shared row, and either can be
   absent. Written once so the figures cannot each pick a different rule for
   what "not supplied" means. */
const pick = (given, fallback) => {
  if (given != null) return given;
  return fallback != null ? fallback : null;
};

/* Places grades price 0 to 4. The old card in App.js turned that into dollar
   signs and the rebuild dropped the conversion, so every card shared by Birdie
   (which writes price_level and no price) lost its price band silently. */
const bandFor = (level) => {
  const n = Number(level);
  if (!Number.isInteger(n) || n < 1 || n > 4) return null;
  return '$'.repeat(n);
};

/* "Bar", "night_club", "coffee shop" all arrive here in whatever shape their
   source used. One word, sentence case, underscores opened up. */
const categoryFor = (venue) => {
  const raw = venue.category || venue.type || null;
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/_/g, ' ').trim();
  if (clean.length === 0) return null;
  return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
};

/* THE CROWD DIAL.
   How full the place is, as a ring that fills, with the capacity in the middle.
   A stroked circle whose dash pattern is the share of the circumference the
   score covers, rotated so it starts at twelve o'clock and fills clockwise.

   The ring carries the figure and the ARIA label carries the ladder's word, so
   a reader who can see it gets the precision and a screen reader gets the
   meaning rather than a number with no scale attached to it. */
function CrowdDial({ score, word }) {
  const R = 13;
  const C = 2 * Math.PI * R;
  const filled = Math.max(0, Math.min(100, score)) / 100;
  return (
    <span
      className="chat-venue-dial"
      role="img"
      aria-label={word ? `${word}. ${score}% of capacity.` : `${score}% of capacity.`}
    >
      <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
        <circle cx="17" cy="17" r={R} fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth="3.5" />
        <circle
          cx="17"
          cy="17"
          r={R}
          fill="none"
          stroke={crowdArcFor(score)}
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={`${(C * filled).toFixed(2)} ${(C * (1 - filled)).toFixed(2)}`}
          transform="rotate(-90 17 17)"
        />
      </svg>
      <span className="chat-venue-dial-num" aria-hidden="true">{score}</span>
    </span>
  );
}

export default function VenueCardRow({
  venue,
  surface = 'flock',
  actionActive = false,
  count = null,
  rating = null,
  price = null,
  crowd = null,
  resolvePhoto,
  placeholder = null,
  onOpen,
  onAction,
}) {
  // Declared above the guard so the hook count is the same on every render.
  const [photoBroken, setPhotoBroken] = useState(false);

  if (!venue || typeof venue.name !== 'string' || venue.name.length === 0) return null;

  const isDm = surface === 'dm';
  const address = venue.addr || venue.formatted_address || null;

  const rawPhoto = venue.photo_url || null;
  const resolved = rawPhoto && typeof resolvePhoto === 'function' ? resolvePhoto(rawPhoto) : rawPhoto;
  const photo = photoBroken ? placeholder : (resolved || placeholder);

  const ratingRaw = pick(rating, venue.stars != null ? venue.stars : venue.rating);
  const priceRaw = pick(price, venue.price);
  const crowdRaw = pick(crowd, venue.crowd);

  const ratingValue = ratingRaw != null && Number.isFinite(Number(ratingRaw)) && Number(ratingRaw) > 0
    ? Number(ratingRaw)
    : null;
  const reviewsRaw = Number(venue.user_ratings_total);
  const reviews = Number.isFinite(reviewsRaw) && reviewsRaw > 0 ? Math.round(reviewsRaw) : null;
  const priceValue = typeof priceRaw === 'string' && priceRaw.trim().length > 0
    ? priceRaw.trim()
    : bandFor(venue.price_level);
  const crowdValue = crowdRaw != null && Number.isFinite(Number(crowdRaw)) ? Math.round(Number(crowdRaw)) : null;
  const crowdWord = crowdValue !== null ? crowdLabelFor(crowdValue) : null;
  const category = categoryFor(venue);

  // The middot line. Built as a list so a missing figure closes the gap
  // instead of leaving a separator with nothing on one side of it.
  const meta = [];
  if (ratingValue !== null) meta.push('rating');
  if (priceValue !== null) meta.push('price');
  if (category !== null) meta.push('category');

  const base = isDm
    ? (actionActive ? 'Pinned' : 'Pin')
    : (actionActive ? 'Voted' : 'Vote');
  const tally = Number.isFinite(Number(count)) && Number(count) > 0 ? Number(count) : null;
  const actionLabel = tally !== null ? `${base} · ${tally}` : base;

  // A card with no page behind it is content, not a control.
  const canOpen = typeof onOpen === 'function' && !!venue.place_id;

  const stop = (fn) => (e) => {
    e.stopPropagation();
    if (typeof fn === 'function') fn(e);
  };

  const metaText = {
    fontSize: '13px',
    fontWeight: 500,
    color: 'var(--text-secondary)',
    lineHeight: '18px',
  };
  const dot = (
    <span aria-hidden="true" style={{ color: 'var(--text-tertiary)', padding: '0 6px' }}>·</span>
  );

  return (
    <CardShell
      onOpen={canOpen ? onOpen : undefined}
      /* The address is no longer drawn, so this is where it survives: a
         screen reader user still hears which place this is before deciding to
         open it, and a sighted reader has the name, the category and the
         picture. */
      ariaLabel={canOpen
        ? `${venue.name}${address ? `, ${address}` : ''}. Open the place.`
        : undefined}
      data-card="venue"
      data-venue-surface={surface}
      style={{ padding: 0, overflow: 'hidden' }}
    >
      {/* No photo and no placeholder means no photo. There is no stock image
          and no coloured block pretending to be one: a map pin on the app's
          own ground says it has a place and not a picture of it. */}
      {/* With no picture at all the hero collapses to a short band rather
          than holding a 16:9 void open. Both screens pass the placeholder,
          so this is the defensive path, and it should still look deliberate. */}
      <div className={photo ? 'chat-venue-hero' : 'chat-venue-hero chat-venue-hero--empty'}>
        {photo
          ? (
            <img
              src={photo}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setPhotoBroken(true)}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          )
          : Icons.mapPin('var(--text-tertiary)', 28)}

        {/* The reading the sender shared, in the ladder's own word rather than
            a bare number, because "Busy" is what a reader acts on and 72 is
            not. The scrim is neutral so it sits on any photograph; the colour
            ladder belongs on the venue's own page, where the figure is. */}
        {crowdValue !== null && <CrowdDial score={crowdValue} word={crowdWord} />}

        {/* Opposite the dial, on the photo, so it costs the card no height. */}
        {typeof onAction === 'function' && (
          <button
            type="button"
            className="chat-venue-action"
            aria-pressed={actionActive}
            onClick={stop(onAction)}
            data-active={actionActive ? 'true' : 'false'}
          >
            {actionLabel}
          </button>
        )}
      </div>

      <div style={{ padding: '12px 14px', minWidth: 0 }}>
        <div
          className="chat-truncate"
          style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', lineHeight: '20px' }}
        >
          {venue.name}
        </div>

        {meta.length > 0 && (
          <div
            className="chat-truncate"
            style={{ ...metaText, marginTop: '3px', display: 'flex', alignItems: 'center' }}
          >
            {meta.map((kind, i) => (
              <React.Fragment key={kind}>
                {i > 0 && dot}
                {kind === 'rating' && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
                    {Icons.starFilled('var(--accent-amber-text)', 12)}
                    <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{ratingValue}</span>
                    {reviews !== null && <span>({reviews.toLocaleString()})</span>}
                  </span>
                )}
                {kind === 'price' && <span style={{ whiteSpace: 'nowrap' }}>{priceValue}</span>}
                {kind === 'category' && <span className="chat-truncate">{category}</span>}
              </React.Fragment>
            ))}
          </div>
        )}

      </div>
    </CardShell>
  );
}
