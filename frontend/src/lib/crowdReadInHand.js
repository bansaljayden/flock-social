/**
 * A CROWD READ ALREADY IN HAND IS NOT ASKED FOR AGAIN.
 *
 * Two pieces of App.js state hold a crowd read for a place: the map card's
 * (`crowdData`, the read for the pin the card shows) and the venue sheet's
 * (`venueDetailCrowd.read`, the read openVenueDetail makes beside Place
 * Details). Each read is tagged with the place it describes (`forPlaceId`).
 *
 * The card's effect fetches a read every time the card switches venue. When
 * the sheet opens with panMap (a chat or DM venue card, a plan's venue, a
 * "Less crowded nearby" row, the return from checkout, an NFC tap) the map
 * pans to the place and the card switches to it a moment after the sheet's
 * own read has landed. The effect used to clear the state and ask again, so
 * the forecast blanked to skeletons and the dial counted up a second time,
 * for a read seconds old. The effect asks this first: a read of the same
 * place, stamped less than `freshMs` ago, is used as it is.
 *
 * Fresh means the server's own `lastUpdated`, the same clock the card's way
 * back (skipCrowdFetchRef) already judges freshness by. A
 * read without a stamp is never fresh, so it is asked for again, as before.
 *
 * Pure, and its own module, so App.js imports a few lines rather than the
 * rest of lib/crowd.js on the boot path, and the rule can be tested alone.
 */
export function freshCrowdReadFor(placeId, reads, freshMs, now = Date.now()) {
  if (!placeId || !Array.isArray(reads)) return null;
  for (const read of reads) {
    if (!read || read.forPlaceId !== placeId) continue;
    const stamped = Date.parse(read.lastUpdated);
    if (Number.isFinite(stamped) && now - stamped < freshMs) return read;
  }
  return null;
}

export default freshCrowdReadFor;
