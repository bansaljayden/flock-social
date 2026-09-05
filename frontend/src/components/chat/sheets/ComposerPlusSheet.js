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
 *   THIS SHEET HOLDS ONLY THINGS YOU SEND INTO THE STREAM.
 *
 * If tapping it posts a message, a card or a system row, it belongs here. If
 * it opens, configures or reads something, it belongs in the profile sheet. So
 * Search in chat is not here, member management is not here, and mute is not
 * here, while Photo, Take a photo, the venue action, Share location, the money
 * action, Ask Birdie and Check in are.
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
 * pressed is the dead button SLOP-AUDIT bans, and it also promises a feature
 * the build may not have wired yet. The integration pass turns a tile on by
 * passing its handler.
 *
 * MEASUREMENTS
 *   Tiles are a 4 column grid. The icon well is 56, radius 28, filled with
 *   --icon-bg, the glyph at 22. The label sits under it at --t-meta, two lines
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
function Tile({ glyph, label, onClick }) {
  return (
    <button type="button" className="cs-tile" onClick={onClick}>
      <span className="cs-tile-well" aria-hidden="true">{glyph('currentColor', 22)}</span>
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
  onRequestCash,    // DM
  onSplitBill,      // flock
  onAskBirdie,
  onCheckIn,
}) {
  const venueHandler = isDm ? onSuggestPlace : onOpenVote;
  const venueLabel = isDm ? 'Suggest a place' : 'Vote on a venue';
  const venueGlyph = isDm ? Icons.mapPin : Icons.vote;

  const moneyHandler = isDm ? onRequestCash : onSplitBill;
  const moneyLabel = isDm ? 'Request cash' : 'Split the bill';
  const moneyGlyph = isDm ? Icons.dollar : Icons.creditCard;

  // Order is the order of use, not of importance: the two photo actions are
  // what the "+" is opened for most, and Check in is the end of a night.
  const tiles = [
    { key: 'photo', glyph: Icons.image, label: 'Photo', onClick: onPickPhoto },
    { key: 'camera', glyph: Icons.camera, label: 'Take a photo', onClick: onTakePhoto },
    { key: 'venue', glyph: venueGlyph, label: venueLabel, onClick: venueHandler },
    { key: 'location', glyph: Icons.crosshair, label: 'Share location', onClick: onShareLocation },
    { key: 'money', glyph: moneyGlyph, label: moneyLabel, onClick: moneyHandler },
    { key: 'birdie', glyph: Icons.birdie, label: 'Ask Birdie', onClick: onAskBirdie },
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
            <Tile key={t.key} glyph={t.glyph} label={t.label} onClick={t.onClick} />
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
