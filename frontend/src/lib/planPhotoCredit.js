/**
 * THE PLAN'S VENUE PHOTO, WITH GOOGLE'S CREDIT, for the plan screen's header.
 *
 * The header draws the venue's photo at about 362 by 170, and a Places photo
 * drawn that large carries the photographer's name (components/ui/GoogleCredit.js).
 * The plan row keeps the photo's URL and nothing about who took it, so the
 * header asks GET /api/flocks/:id/venue-photo when the plan opens. The answer
 * is a photo and its credit together: the stored photo while Google still lists
 * it, else the photo the photo proxy shows for that stored URL now. The header
 * draws THAT photo, so the picture and the name on it are one photograph.
 *
 * Until the answer names a photographer, and whenever it names nobody, this
 * returns null and the header draws the block the venue is on instead.
 *
 * HELD HERE AND NOWHERE ELSE. No storage, no module cache, no copy on the
 * flock object (which the app keeps for a long time): a photo name and a
 * credit are Places content, so they live as long as the screen that asked.
 */
import React from 'react';
import { getFlockVenuePhoto } from '../services/api';
import { usableCredit } from '../components/ui/GoogleCredit';

/**
 * @param {number|string} flockId
 * @param {string|null} storedPhoto  the plan's venuePhoto, as the list mapped it
 * @param {string|null} venueId      the plan's Google place id
 * @returns {{ url: string, credit: object } | null}
 */
export function usePlanPhotoCredit(flockId, storedPhoto, venueId) {
  // Asked again only when the plan, its venue or its stored photo changes.
  const key = flockId && storedPhoto && venueId ? `${flockId}|${venueId}|${storedPhoto}` : null;
  const [answer, setAnswer] = React.useState({ key: null, photo: null });
  React.useEffect(() => {
    if (!key) return undefined;
    let live = true;
    // Through a resolved promise so a throw and a refusal end the same way:
    // nothing to draw, and the header keeps its map.
    Promise.resolve()
      .then(() => getFlockVenuePhoto(flockId))
      .then((res) => {
        const credit = usableCredit(res && res.photo_attribution);
        const url = credit && res && typeof res.photo_url === 'string' && res.photo_url ? res.photo_url : null;
        if (live) setAnswer({ key, photo: url ? { url, credit } : null });
      })
      .catch(() => { if (live) setAnswer({ key, photo: null }); });
    return () => { live = false; };
    // `key` carries flockId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return answer.key === key ? answer.photo : null;
}
