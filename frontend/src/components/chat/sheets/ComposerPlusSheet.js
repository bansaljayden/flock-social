/**
 * THE "+" SHEET. Opened by the plus at the right of the input bar.
 *
 * WHAT THIS REPLACES
 * The other half of the header "Features" drawer in screens/ChatDetail.js, and
 * the two ad hoc pickers around it: the camera-or-library question the photo
 * button used to ask in its own sheet, and the venue-share modal. Nothing is
 * removed. The split with FlockProfileSheet is the one the rebuild plan
 * settles and it is the only rule this file follows:
 *
 *   THIS SHEET HOLDS EVERYTHING THE HEADER USED TO.
 *
 * It began as "only things you send into the stream", with reading and
 * configuring left to the profile sheet. It was settled the other way on
 * 2026-09-05, off the shipped screen: the flock header carried a
 * "Features" pill wide enough to push the plan's name into an ellipsis, and
 * behind it a rail of five more controls. Snapchat's header carries a name and
 * three small glyphs, and everything else lives behind the plus. "The plus
 * should have all those features."
 *
 * So Search in chat, Invite friends and the cash pool are here now, beside
 * Photo, Take a photo, the venue action, Share location, the money action,
 * Ask Birdie and Check in. The header keeps only what it can say about STATE.
 *
 * TWO OF THE SEVEN CHANGE WITH THE SURFACE
 *   Venue: a flock votes ("Vote on a venue"), a DM suggests ("Suggest a
 *   place"). Two people do not need a poll, and the plan's decision 4 says two
 *   of two auto-pins in a DM, so the DM verb is the honest one.
 *   Money: a flock splits a bill among its members ("Split the bill"), a DM
 *   asks one person for money ("Request cash"). The bill split is a group
 *   object; there is no group in a one to one thread.
 * Everything else is identical on both surfaces, which is why `isDm` appears
 * exactly twice below.
 *
 * A TILE WITH NO HANDLER DOES NOT RENDER
 * Not disabled, not greyed, absent. A grey "Check in" that does nothing when
 * pressed is the dead button DESIGN-STANDARD bans, and it also promises a feature
 * the build may not have wired yet. The integration pass turns a tile on by
 * passing its handler.
 *
 * MEASUREMENTS
 *   Tiles are a 4 column grid. The icon well is 56, radius 28, filled with
 *   --icon-bg, the glyph at 22, except the solid bird at 20. Thirteen tiles
 *   is four rows, and the sheet scrolls inside its own max height rather
 *   than growing past it. The label sits under it at --t-meta, two lines
 *   maximum, centred. Whole tile is 44 minimum in both directions by
 *   construction (56 alone clears it), so no tile needs the hit44 overlay.
 *   Sheet geometry, backdrop, grabber, focus handling and keyboard dismissal
 *   all come from ChatSheet, which is documented in FlockProfileSheet.js.
 *
 * PRESENTATIONAL ONLY. No API calls, no context, no state at all in this file.
 */
import React from 'react';
import Icons from '../../ui/Icons';
import { ChatSheet } from './FlockProfileSheet';
import './sheets.css';

/* One tile. The visible label IS the accessible name, so there is no
   aria-label here and the glyph stays decorative. An icon-only control would
   need both; this is not one. */
function Tile({ glyph, label, onClick, size = 22 }) {
  return (
    <button type="button" className="cs-tile" onClick={onClick}>
      <span className="cs-tile-well" aria-hidden="true">{glyph('currentColor', size)}</span>
      <span className="cs-tile-label">{label}</span>
    </button>
  );
}

export default function ComposerPlusSheet({
  open,
  onClose,
  isDm = false,
  // The name of the thread, used only in the sheet's accessible label so a
  // screen reader user knows which chat they are about to post into.
  chatName,
  DialogBehavior = null,

  onPickPhoto,      // library
  onTakePhoto,      // camera
  onSuggestPlace,   // DM
  onOpenVote,       // flock
  onShareLocation,
  onOnMyWay,        // flock
  onNeedRide,       // flock
  onRequestCash,    // DM
  onSplitBill,      // flock
  onAskBirdie,
  onCheckIn,
  /* The three the header rail used to hold. Flock and DM both search; only a
     flock has friends to invite or a pool to put money in. */
  onSearchMessages,
  onInviteFriends,
  onCashPool,
  onVenueVotes,
}) {
  const venueHandler = isDm ? onSuggestPlace : onOpenVote;
  const venueLabel = isDm ? 'Suggest a place' : 'Vote on a venue';
  const venueGlyph = isDm ? Icons.mapPin : Icons.vote;

  const moneyHandler = isDm ? onRequestCash : onSplitBill;
  const moneyLabel = isDm ? 'Request cash' : 'Split the bill';
  const moneyGlyph = isDm ? Icons.dollar : Icons.creditCard;

  // Order is the order of use, not of importance: the two photo actions are
  // what the "+" is opened for most, and Check in is the end of a night.
  // On my way and Need a ride sit directly after Share location because they
  // are the same share, saying something: each starts the position share that
  // tile starts, with an intent riding on the packet, so the three that put a
  // person on the map are found together rather than one of them alone.
  const tiles = [
    { key: 'photo', glyph: Icons.image, label: 'Photo', onClick: onPickPhoto },
    { key: 'camera', glyph: Icons.camera, label: 'Take a photo', onClick: onTakePhoto },
    { key: 'venue', glyph: venueGlyph, label: venueLabel, onClick: venueHandler },
    { key: 'location', glyph: Icons.crosshair, label: 'Share location', onClick: onShareLocation },
    { key: 'omw', glyph: Icons.compass, label: 'On my way', onClick: onOnMyWay },
    { key: 'ride', glyph: Icons.users, label: 'Need a ride', onClick: onNeedRide },
    { key: 'money', glyph: moneyGlyph, label: moneyLabel, onClick: moneyHandler },
    /* Two sizes under the bird, and only under the bird. It is the one solid
       mark in the set (the icon system's own stated exception, drawn unstroked
       so the punched eye stays open), and a filled glyph reads heavier than an
       outline at the same nominal size. At 22 beside these outlines it was the
       largest and darkest thing in the sheet. */
    { key: 'birdie', glyph: Icons.birdie, label: 'Ask Birdie', onClick: onAskBirdie, size: 20 },
    { key: 'votes', glyph: Icons.vote, label: 'Venue votes', onClick: onVenueVotes },
    { key: 'pool', glyph: Icons.dollar, label: 'Cash pool', onClick: onCashPool },
    { key: 'invite', glyph: Icons.userPlus, label: 'Invite friends', onClick: onInviteFriends },
    { key: 'search', glyph: Icons.search, label: 'Search chat', onClick: onSearchMessages },
    { key: 'checkin', glyph: Icons.checkCircle, label: 'Check in', onClick: onCheckIn },
  ].filter((t) => typeof t.onClick === 'function');

  return (
    <ChatSheet
      open={open}
      onClose={onClose}
      label={chatName ? `Send to ${chatName}` : 'Send something'}
      title="Send something"
      DialogBehavior={DialogBehavior}
      maxHeight="70%"
      testId="composer-plus-sheet"
    >
      {tiles.length > 0 ? (
        <div className="cs-tiles" data-chat-section="send">
          {tiles.map((t) => (
            <Tile key={t.key} glyph={t.glyph} label={t.label} onClick={t.onClick} size={t.size} />
          ))}
        </div>
      ) : (
        // Reachable only if the integration pass wires no handler at all. It
        // says what happened rather than showing an empty grid, which is the
        // error rule: name the state and give the way forward.
        <p className="cs-empty" data-chat-section="send">
          Nothing can be sent from here yet. Close this and use the message field.
        </p>
      )}
    </ChatSheet>
  );
}
