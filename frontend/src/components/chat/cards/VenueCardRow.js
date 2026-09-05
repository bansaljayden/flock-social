/**
 * A SHARED VENUE, AS A MESSAGE.
 *
 * WHAT IT REPLACES. This card has been three things. A tile with two competing
 * buttons and an inset photo floating in a padded box; then a 64px thumbnail
 * row, which turned the one thing worth looking at into a bullet point; then a
 * full-bleed hero with a footer action, which came to 331pt on a 390pt phone
 * where the visible stream with the keyboard up is 327. That last one was the
 * whole screen, and its own Vote button sat underneath the keyboard.
 *
 * IT IS A CHAT. That is the constraint everything below answers to. A shared
 * place is ONE MESSAGE in a thread of messages and has to read as one, so the
 * card is a row 88pt tall: about a quarter of the keyboard-up stream, with
 * room for four more messages under it. A picture big enough to judge a place
 * by is worth having. It is not worth the thread.
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
 * ONE LINE OF FACTS, because there is one line's worth of room. Rating with
 * its review count, price band, category, and how many people have voted, in
 * that order, ellipsised as a whole rather than stacked. The address is not
 * among them: it is a tap away on the venue's own page, which is where you go
 * when you want to navigate, and it survives in the card's accessible name so
 * a screen reader user still hears which place this is.
 *
 * THE PHOTO PATH IS THE CALLER'S, NOT THIS FILE'S. A venue photo can arrive
 * as an absolute Google URL or as a relative api path that only resolves
 * against the API host, and this module is presentational: it has no BASE_URL
 * and must not reach for one. So the screen hands in `resolvePhoto` (the app's
 * own resolveVenuePhoto) and `placeholder` (the app's bird on cream). With
 * neither, the raw url is used as it arrived, which is right for an absolute
 * one and is all a card with no resolver can honestly do.
 *
 * THE ACTION IS AN ICON, and that is a size decision too. Spelling it "Vote"
 * cost about 72pt of width, which came straight out of the line of facts and
 * truncated the category on every card. The count moved into that line, where
 * it reads as one more fact about the place, and the control kept its 44pt
 * target with none of the width. Its accessible name still says the word.
 *
 * ONE ACTION, AND NEVER THE WORD "VIEW". The whole card opens the venue, so
 * the button carries the one thing a tap cannot do: Vote inside a flock, Pin
 * inside a DM. The surface decides which, because a DM has no vote to join and
 * a flock has no single pinned venue.
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
   source used. One word, sentence case, underscores opened up.

   THE CONJUNCTION IS CUT, and that is what makes the "one word" above true
   rather than aspirational. Most venues reach this from categorizeVenue,
   which answers from a short closed set ("Food", "Nightlife") and always
   fitted. An owner-claimed venue does not: venue_profiles.category is free
   text somebody typed, and "Bar & grill" is the obvious thing to type. In the
   88pt row that shares its meta line with a rating, a price band and a vote
   count, it rendered as "Bar & g...", which is not a shortened category, it
   is a word cut in half.

   So a list becomes its first item. "Bar & grill" is a bar, "Bar/Restaurant"
   is a bar, and neither needs the rest to be understood at a glance in a chat
   row. A genuine single concept that happens to be long ("Coffee shop") is
   left alone and still ellipsises if the row is tight, which is the right
   outcome for a name with nothing to drop. */
const categoryFor = (venue) => {
  const raw = venue.category || venue.type || null;
  if (typeof raw !== 'string') return null;
  const first = raw.replace(/_/g, ' ').split(/[&,/|]/)[0];
  const clean = first.trim();
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
  const R = 11;
  const C = 2 * Math.PI * R;
  const filled = Math.max(0, Math.min(100, score)) / 100;
  return (
    <span
      className="chat-venue-dial"
      role="img"
      aria-label={word ? `${word}. ${score}% of capacity.` : `${score}% of capacity.`}
    >
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
        <circle cx="14" cy="14" r={R} fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth="3" />
        <circle
          cx="14"
          cy="14"
          r={R}
          fill="none"
          stroke={crowdArcFor(score)}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${(C * filled).toFixed(2)} ${(C * (1 - filled)).toFixed(2)}`}
          transform="rotate(-90 14 14)"
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
  const tally = Number.isFinite(Number(count)) && Number(count) > 0 ? Number(count) : null;

  /* The one line of facts. Built as a list so a missing one closes the gap
     instead of leaving a separator with nothing on one side of it. */
  const meta = [];
  if (ratingValue !== null) meta.push('rating');
  if (priceValue !== null) meta.push('price');
  if (category !== null) meta.push('category');
  if (tally !== null) meta.push('tally');

  const actionWord = isDm
    ? (actionActive ? 'Pinned' : 'Pin')
    : (actionActive ? 'Voted' : 'Vote');
  const actionGlyph = isDm
    ? (actionActive ? Icons.pinFilled : Icons.pin)
    : Icons.vote;

  // A card with no page behind it is content, not a control.
  const canOpen = typeof onOpen === 'function' && !!venue.place_id;

  const stop = (fn) => (e) => {
    e.stopPropagation();
    if (typeof fn === 'function') fn(e);
  };

  const dot = (
    <span aria-hidden="true" style={{ color: 'var(--text-tertiary)', padding: '0 5px' }}>·</span>
  );

  return (
    <CardShell
      onOpen={canOpen ? onOpen : undefined}
      /* The address is no longer drawn, so this is where it survives: a screen
         reader user still hears which place this is before deciding to open
         it, and a sighted reader has the name, the category and the picture. */
      ariaLabel={canOpen
        ? `${venue.name}${address ? `, ${address}` : ''}. Open the place.`
        : undefined}
      data-card="venue"
      data-venue-surface={surface}
      style={{ padding: 0, overflow: 'hidden', display: 'flex', alignItems: 'stretch' }}
    >
      {/* No photo and no placeholder means no photo. There is no stock image
          and no coloured block pretending to be one: a map pin on the app's
          own ground says it has a place and not a picture of it. */}
      <div className={photo ? 'chat-venue-thumb' : 'chat-venue-thumb chat-venue-thumb--empty'}>
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
          : Icons.mapPin('var(--text-tertiary)', 24)}

        {crowdValue !== null && <CrowdDial score={crowdValue} word={crowdWord} />}
      </div>

      <div className="chat-venue-text">
        <div
          className="chat-truncate"
          style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', lineHeight: '18px' }}
        >
          {venue.name}
        </div>

        {meta.length > 0 && (
          <div
            className="chat-truncate"
            style={{
              fontSize: '12px',
              fontWeight: 500,
              color: 'var(--text-secondary)',
              lineHeight: '16px',
              marginTop: '2px',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            {meta.map((kind, i) => (
              <React.Fragment key={kind}>
                {i > 0 && dot}
                {kind === 'rating' && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', whiteSpace: 'nowrap' }}>
                    {Icons.starFilled('var(--accent-amber-text)', 11)}
                    <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{ratingValue}</span>
                    {reviews !== null && <span>({reviews.toLocaleString()})</span>}
                  </span>
                )}
                {kind === 'price' && <span style={{ whiteSpace: 'nowrap' }}>{priceValue}</span>}
                {kind === 'category' && <span className="chat-truncate">{category}</span>}
                {kind === 'tally' && (
                  <span style={{ whiteSpace: 'nowrap' }}>
                    {tally} {tally === 1 ? 'vote' : 'votes'}
                  </span>
                )}
              </React.Fragment>
            ))}
          </div>
        )}
      </div>

      {typeof onAction === 'function' && (
        <button
          type="button"
          className="chat-venue-action"
          aria-label={actionWord}
          aria-pressed={actionActive}
          onClick={stop(onAction)}
          data-active={actionActive ? 'true' : 'false'}
        >
          {actionGlyph('currentColor', 18)}
        </button>
      )}
    </CardShell>
  );
}
