/**
 * THE VENUE CARD A MAP PIN OPENS.
 *
 * The card that slides up from the bottom of Discover when a pin is tapped,
 * and the same card the venue owner dashboard renders in its Map tab so an
 * owner sees their own venue exactly as a consumer does. It was 971 lines of
 * App.js, declared as an arrow function inside FlockAppInner
 * (renderConsumerVenueCard) and CALLED rather than mounted.
 *
 * WHY IT MOVED
 *
 * App.js contributes 515,117 of the 605,663 raw bytes in the boot chunk, which
 * is 85% of it, and FlockAppInner is a single component of about 16,300 lines
 * holding 346 useState calls, so every block declared inside it is both boot
 * weight every user downloads and a body that re-runs on every state change in
 * the app. This card and the three declarations only it used (AnimatedDial,
 * CrowdRealityCheck and getGroupAdmission, carried across below) are about
 * 1,274 lines and roughly 57 KB of comment-free source.
 *
 * It is a legitimate candidate for a fetched chunk rather than a static
 * import, which is the whole point of the move: activeVenue is null at boot
 * and nothing mounts this card until a pin tap, an openVenueDetail call or the
 * window.__flockPanToVenue bridge, so it is not on the first paint path. Two
 * conditions come with that, both of them real:
 *
 *   1. THE CHUNK HAS TO BE WARM BEFORE THE FIRST TAP. A pin tap is the most
 *      common interaction on Discover. Fetching this module on the tap itself
 *      buys boot bytes by charging a round trip at the moment the sheet is
 *      supposed to appear. Warm it when the Discover tab mounts, off the
 *      critical path, so the tap lands on an already resolved module.
 *   2. React.lazy REMEMBERS A REJECTION FOR EVER. A failed fetch is cached,
 *      so a retry button is dead without a re-arm. App.js already solves this
 *      for its screens in rearmLazyScreens; a lazy binding for this card
 *      belongs in the same place, at module scope, never inside FlockAppInner.
 *
 * WHY EVERYTHING ARRIVES AS A PROP
 *
 * The old arrow function closed over 45 names. Forty are declared in
 * FlockAppInner: activeVenue and the crowd state around it, the sensor
 * readings, the venue-pick and back-navigation state, and the setters and
 * handlers behind the actions. Five more are module-level helpers and
 * constants App.js declares once and other surfaces share (crowdColorFor,
 * crowdInkFor, resolveVenuePhoto, CROWD_FRESH_MS, HOUR_ORDERING_MIN_GAP), so
 * they stay declared there and arrive here under their own names, which is
 * what lets the body below stay a character-for-character copy of the deleted
 * lines. Nothing here re-derives any of them: the crowd ladder carries the
 * instruction "Never inline another ladder. Call these." and a second copy of
 * the hour-ordering floor is exactly the drift hourOrderingFloor.test.js
 * exists to prevent. Moving those five into src/lib/crowd.js and
 * src/lib/venuePhoto.js, where crowdLabelFor already lives, would turn five
 * props into five imports and is the right follow-up.
 *
 * The names were not read off the page. They came from a Babel scope walk of
 * the block: every referenced identifier whose binding resolves outside it,
 * split by whether the binding is FlockAppInner or module scope. Every one of
 * the forty is a const, so none of them can be reassigned later in the same
 * render and read stale through the props object.
 *
 * THREE THINGS THE CALL SITE OWNS, AND WHY THEY ARE NOT IN HERE
 *
 *   - THE NULL GUARD. The card returns null with no activeVenue, and that
 *     guard is kept below, but it is not enough on its own. Discover renders
 *     the card inside <AnimatePresence>, which animates the exit only when the
 *     child LEAVES the tree. A wrapper that always returns an element whose
 *     body renders null leaves a child mounted for ever and the exit never
 *     runs, so the wrapper in App.js returns null itself before it builds the
 *     element.
 *   - THE KEY. AnimatePresence tracks presence by the key on its direct child.
 *     The key used to sit on the root m.div because that div WAS the direct
 *     child; mounted as a component, the key belongs on the element the
 *     wrapper returns, or switching venues stops remounting the card.
 *   - THE SUSPENSE BOUNDARY. Both call sites need one if the import is lazy,
 *     and only one of them is in App.js: the dashboard calls the same wrapper
 *     through venueDashboardProps, so the boundary goes in the wrapper where
 *     both paths get it.
 *
 * m comes from framer-motion and needs the LazyMotion features provider
 * App.js wraps the app in. This card is always inside that tree.
 */
import React, { useState } from 'react';
import { m } from 'framer-motion';
import Icons from '../ui/Icons';
import { crowdLabelFor } from '../../lib/crowd';
import { submitVenueFeedback } from '../../services/api';

// Animated crowd dial — fills from 0 to target score with counting number.
// Perf notes: caches getComputedStyle (was called every frame), pre-renders the
// static track to an offscreen canvas, and keeps the parent drop-shadow filter
// on a SIBLING glow div so the canvas itself isn't re-rasterized 60×/sec.
const AnimatedDial = React.memo(function AnimatedDial({ score, color }) {
  const textRef = React.useRef(null);
  const canvasRef = React.useRef(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssSize = 60;
    const size = Math.round(cssSize * dpr);
    const center = size / 2;
    const radius = Math.round(26 * dpr);
    const lineWidth = Math.round(6 * dpr);
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext('2d');

    // Cache the track color ONCE (was a getComputedStyle call per frame — expensive style recalc)
    const trackColor = getComputedStyle(document.documentElement).getPropertyValue('--border-default').trim() || '#334155';

    // Pre-render the static gray ring to an offscreen canvas — drawn once, blitted each frame.
    const trackCanvas = document.createElement('canvas');
    trackCanvas.width = size;
    trackCanvas.height = size;
    const tctx = trackCanvas.getContext('2d');
    tctx.beginPath();
    tctx.arc(center, center, radius, 0, Math.PI * 2);
    tctx.strokeStyle = trackColor;
    tctx.lineWidth = lineWidth;
    tctx.stroke();

    let raf;
    const start = performance.now();
    const ease = t => 1 - Math.pow(1 - t, 3);

    const draw = (val) => {
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(trackCanvas, 0, 0);
      if (val > 0) {
        ctx.beginPath();
        ctx.arc(center, center, radius, -Math.PI / 2, -Math.PI / 2 + (val / 100) * Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';
        ctx.stroke();
      }
    };

    const tick = now => {
      const t = Math.min((now - start) / 1200, 1);
      const val = ease(t) * score;
      draw(val);
      if (textRef.current) textRef.current.textContent = `${Math.round(val)}%`;
      if (t < 1) raf = requestAnimationFrame(tick);
    };

    draw(0);
    if (textRef.current) textRef.current.textContent = '0%';
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [score, color]);

  return (
    <div style={{ width: '60px', height: '60px', position: 'relative', flexShrink: 0 }}>
      {/* Glow lives on a SIBLING div — not on a parent of the canvas. Otherwise every
          canvas frame would force the browser to re-rasterize the drop-shadow. */}
      <div aria-hidden style={{ position: 'absolute', inset: 0, borderRadius: '50%', boxShadow: `0 4px 12px rgba(0,0,0,0.3), 0 0 8px ${color}30`, pointerEvents: 'none' }} />
      <canvas ref={canvasRef} style={{ width: '60px', height: '60px', position: 'absolute', top: 0, left: 0, transform: 'translateZ(0)' }} />
      <div style={{ position: 'absolute', inset: '6px', borderRadius: '24px', backgroundColor: 'var(--bg-card-solid)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span ref={textRef} style={{ fontSize: 'var(--t-body)', fontWeight: '600', color, lineHeight: 1 }}>0%</span>
      </div>
    </div>
  );
});

// One-tap reality check under the crowd forecast: a report from someone at the
// venue becomes a dated training row (venue_feedback) AND calibrates the live
// score for everyone else. Self-contained state; remount per venue via key.
const CrowdRealityCheck = React.memo(function CrowdRealityCheck({ placeId, venueName, predicted, ownerAsserted }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(null); // 'verified' | 'unverified'
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!placeId) return null;
  if (sent) {
    // The forecast only learns from a report the server could verify (a
    // check-in by tag, or a plan with two people here). The old line promised
    // every report sharpened it, which was false for nearly all of them.
    return (
      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 8px', fontWeight: '500' }}>
        {sent === 'verified'
          ? 'Thanks. Real reports sharpen the forecast for everyone.'
          : 'Thanks. Reports from a night here with your flock go into the forecast; this one is noted.'}
      </p>
    );
  }
  if (!open) {
    return (
      <button className="hit44"
        onClick={() => setOpen(true)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '6px 12px', margin: '0 0 8px', borderRadius: '10px', border: '1.5px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-secondary)', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}
      >
        {/* When the number on screen is the bar's own claim, the check is the
            counterweight: reports from people in the room outrank the owner
            once three agree, and this button is where those reports come from. */}
        {ownerAsserted ? 'There now? Does this look right?' : 'There now? Rate the crowd'}
      </button>
    );
  }
  const opts = [
    // The words the score ladder actually uses (crowdLabelFor: Quiet, Not Busy,
    // Steady, Busy, Packed), narrowed to the three buckets this control has.
    //
    // The comment here used to claim these WERE the ladder's words and that
    // 'Packed' appeared nowhere else in the product. Both stopped being true on
    // 2026-08-28, when the ladder was re-cut and gained Packed. So somebody
    // looking at a card reading "Packed 91" tapped "There now? Rate the crowd"
    // and was offered Quiet / Moderate / Very Busy: no option matched the word
    // on their screen and two of the three were words nothing else in the app
    // says (backend/routes/badge.js calls them legacy aliases).
    //
    // Only the WORDS change. `level` is what travels to the server and what the
    // training export reads, so the stored data is untouched.
    { level: 1, label: 'Quiet' },
    { level: 2, label: 'Steady' },
    { level: 3, label: 'Packed' },
  ];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', margin: '0 0 8px', animation: 'fadeSlideIn 0.25s ease-out' }}>
      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)' }}>
        How busy is it actually:
      </span>
      {opts.map(o => (
        <button className="hit44"
          key={o.level}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setFailed(false);
            try {
              const saved = await submitVenueFeedback({
                venue_place_id: placeId,
                venue_name: venueName,
                crowd_level: o.level,
                predicted_score: typeof predicted === 'number' ? Math.round(predicted) : null,
              });
              setSent(saved && saved.verified ? 'verified' : 'unverified');
            } catch (err) {
              console.error('[RealityCheck] submit failed:', err);
              // Was console-only: the buttons came back with no word.
              setFailed(true);
              setBusy(false);
            }
          }}
          style={{ padding: '4px 12px', borderRadius: '8px', border: '1.5px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-primary)', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: busy ? 'wait' : 'pointer' }}
        >
          {o.label}
        </button>
      ))}
      {failed && (
        <span style={{ fontSize: 'var(--t-meta)', color: 'var(--accent-red-text)', fontWeight: '500' }}>That did not send. Try again.</span>
      )}
    </div>
  );
});

// Group admission likelihood — venue-type, size, and time-aware.
//
// ── WHOSE CLOCK, AND WHICH HOUR ──────────────────────────────────────────────
// This used to read `new Date().getHours()` and `new Date().getDay()`: the
// PHONE's clock. Every other crowd surface was moved off the device years of
// bugs ago — migration 023, crowdEngine.venueLocalNow, the whole
// ML_BASELINE_AXIS_VERIFIED pass — because how busy a place is, is a fact about
// that place's night. Someone in California opening a Philadelphia bar at 10 PM
// Friday was asking about 1 AM Saturday there, and this function answered for
// Friday evening: weekend-evening peak pressure on a room that has already
// emptied out.
//
// Two things follow, and they are one rule:
//   * `clock` is REQUIRED. There is no device-clock fallback in here, so this
//     function cannot silently regress to the phone. The caller resolves the
//     venue's clock the same way the chart does (cd.venueClock, falling back to
//     the caller's clock only when the SERVER did — `venueClock.local === false`).
//   * `clock` is the hour the CARD IS SHOWING, not "now". `crowdScore` and
//     `clock.hour` have to describe the same instant: a forecast strip that
//     puts a different bar on screen must pass THAT bar's score with THAT
//     bar's hour and day, or the verdict describes an hour nobody asked about.
// Without a clock there is no honest answer, so it returns none.
function getGroupAdmission(crowdScore, partySize, venue, clock) {
  if (!crowdScore && crowdScore !== 0) return null;
  if (!clock || !Number.isFinite(clock.hour) || !Number.isFinite(clock.day)) return null;
  const size = partySize || 1;
  const types = venue?.types || [];
  const reviews = venue?.user_ratings_total || venue?.review_count || 0;
  const hour = ((Math.trunc(clock.hour) % 24) + 24) % 24;
  const day = ((Math.trunc(clock.day) % 7) + 7) % 7;
  const isWeekendEvening = (day === 5 || day === 6) && hour >= 17;
  const isPeakDinner = hour >= 18 && hour <= 20;
  const isPeakLunch = hour >= 11 && hour <= 13;
  const has = (...tags) => types.some(t => tags.includes(t));

  // Venue size factor from reviews (more reviews = bigger venue = groups easier)
  const sizeFactor = reviews > 3000 ? 0.5 : reviews > 1000 ? 0.7 : reviews > 300 ? 0.85 : reviews > 100 ? 1.0 : 1.3;

  // Classify venue — group impact per person depends on how capacity-constrained it is
  let perPersonImpact;
  let category;

  // Open / unlimited capacity — group size doesn't matter
  if (has('park', 'amusement_park', 'zoo', 'aquarium', 'beach', 'campground',
    'national_park', 'dog_park', 'hiking_area', 'playground', 'ski_resort',
    'stadium', 'arena', 'shopping_mall', 'shopping_center', 'outlet_mall',
    'market', 'flea_market', 'farmers_market', 'tourist_attraction',
    'convention_center', 'fairground', 'water_park', 'theme_park')) {
    category = 'open';
    perPersonImpact = 0;
  }
  // Ticketed / assigned seating — group size barely matters
  else if (has('movie_theater', 'performing_arts_theater', 'concert_hall',
    'opera_house', 'live_music_venue', 'comedy_club', 'theater',
    'museum', 'art_gallery', 'science_museum', 'planetarium',
    'escape_room', 'go_kart_track', 'mini_golf')) {
    category = 'ticketed';
    perPersonImpact = 0.5;
  }
  // Large casual — high capacity, groups are easy
  else if (has('fast_food_restaurant', 'meal_takeaway', 'food_court',
    'gym', 'fitness_center', 'spa', 'bowling_alley', 'pool_hall',
    'casino', 'supermarket', 'grocery_store', 'department_store',
    'book_store', 'library', 'laundry', 'car_wash')) {
    category = 'large_casual';
    perPersonImpact = 0.8;
  }
  // Bars / breweries — standing room helps, but tables for groups are limited.
  //
  // BAR IS TESTED BEFORE ENTERTAINMENT, and the order is the fix. Google types
  // a lot of rooms both `bar` and `night_club` (or `bar` and `karaoke`), and
  // `night_club` lives in the entertainment branch below. With entertainment
  // first, one such venue got a NIGHTCLUB reading here while the same card's
  // score and wait estimate — genHourly and getWait, both `['bar',
  // 'night_club'].includes(t)`, bar wins in each — were reading it as a bar. One
  // card, one venue, two different rooms. Whatever the answer is, the three have
  // to agree, so this now resolves the ambiguity the same way they do: a venue
  // carrying a bar tag is a bar. A room typed `night_club` alone carries no bar
  // tag and still falls through to entertainment, unchanged.
  //
  // The related item in DEFERRED.md §3 was NOT this one and was fixed straight
  // after, the same way: crowdEngine.estimateCapacity tested `night_club`
  // BEFORE `isBarLike` and published nightclub capacity for a venue its own
  // score and wait called a bar. Bar wins there now too.
  else if (has('bar', 'pub', 'sports_bar', 'wine_bar', 'cocktail_bar',
    'beer_garden', 'brewery', 'winery', 'distillery', 'taproom')) {
    category = 'bar';
    perPersonImpact = 1.5;
  }
  // Entertainment — moderate impact
  else if (has('arcade', 'game_center', 'trampoline_park', 'laser_tag',
    'karaoke', 'billiard_hall', 'hookah_bar', 'lounge',
    'dance_club', 'night_club', 'batting_cage', 'rock_climbing_gym')) {
    category = 'entertainment';
    perPersonImpact = 1.2;
  }
  // Regular restaurants — table-based, groups need bigger tables
  else if (has('restaurant', 'diner', 'buffet_restaurant', 'steakhouse',
    'seafood_restaurant', 'pizza_restaurant', 'hamburger_restaurant',
    'american_restaurant', 'italian_restaurant', 'mexican_restaurant',
    'chinese_restaurant', 'japanese_restaurant', 'indian_restaurant',
    'thai_restaurant', 'korean_restaurant', 'vietnamese_restaurant',
    'mediterranean_restaurant', 'greek_restaurant', 'turkish_restaurant',
    'bbq_restaurant', 'ramen_restaurant', 'sushi_restaurant',
    'sandwich_shop', 'breakfast_restaurant', 'brunch_restaurant',
    'family_restaurant', 'food')) {
    category = 'restaurant';
    perPersonImpact = 2.0;
  }
  // Small / cozy — limited seating, groups take up a lot of space
  else if (has('cafe', 'coffee_shop', 'tea_house', 'juice_shop',
    'smoothie_shop', 'bakery', 'dessert_shop', 'ice_cream_shop',
    'donut_shop', 'patisserie', 'creperie', 'bubble_tea')) {
    category = 'small';
    perPersonImpact = 2.5;
  }
  // Fine dining — reservations are the norm, groups are hard
  else if (has('fine_dining_restaurant') || (venue?.price_level >= 3 && has('restaurant'))) {
    category = 'fine_dining';
    perPersonImpact = 3.0;
  }
  // Default — treat like a regular restaurant
  else {
    category = 'default';
    perPersonImpact = 1.5;
  }

  // Open venues — group size doesn't matter
  if (category === 'open') {
    return { text: 'No issues for groups', color: '#22C55E', icon: 'check' };
  }

  // Time pressure — peak hours make groups harder to seat
  let timeMult = 1.0;
  if (category === 'bar' || category === 'entertainment') {
    // Bars/clubs peak later
    if (isWeekendEvening && hour >= 21) timeMult = 1.5;
    else if (isWeekendEvening) timeMult = 1.3;
    else if (hour >= 21) timeMult = 1.2;
  } else {
    if (isWeekendEvening) timeMult = 1.4;
    else if (isPeakDinner) timeMult = 1.25;
    else if (isPeakLunch) timeMult = 1.1;
  }

  // Large group penalty — non-linear, 7+ is way harder than 4
  const groupPenalty = size <= 2 ? size : size <= 4 ? size * 1.1 : size * 1.4;

  const effectiveLoad = crowdScore + (groupPenalty * perPersonImpact * sizeFactor * timeMult);

  // Ticketed venues — simpler messaging
  if (category === 'ticketed') {
    if (size >= 6) return { text: 'Book ahead for group', color: '#F59E0B', icon: 'clock' };
    return { text: 'Buy tickets anytime', color: '#22C55E', icon: 'check' };
  }

  if (effectiveLoad < 40) return { text: 'Walk right in', color: '#22C55E', icon: 'check' };
  if (effectiveLoad < 55) return { text: 'Should be fine', color: '#22C55E', icon: 'check' };
  if (effectiveLoad < 70) return { text: 'Might wait briefly', color: '#F59E0B', icon: 'clock' };
  if (effectiveLoad < 85) return { text: 'Expect a wait', color: '#F59E0B', icon: 'clock' };
  if (effectiveLoad < 95) return { text: category === 'fine_dining' || size >= 5 ? 'Reservation needed' : 'Call ahead recommended', color: '#EF4444', icon: 'alert' };
  return { text: 'Reservation needed', color: '#EF4444', icon: 'alert' };
}

  // ONE venue card for every map surface. This is the card a tapped pin
  // opens on Discover, extracted so the venue dashboard's Map tab can render
  // the exact same thing: same data, same copy, same attribution labels.
  // With venueOwnerView the informational card is identical; only
  // consumer ACTIONS are left out (start a flock, check in, the crowd reality
  // check, nearby navigation), because a venue account acting on those would
  // either dead-end into consumer-only screens or write user-shaped crowd
  // signals a venue must never write.
export default function ConsumerVenueCard({
  // Module-level helpers and constants App.js declares once and shares with
  // other surfaces, so they stay declared there and arrive here. Named exactly
  // as they are named there, which is what keeps the body below a verbatim
  // copy of the deleted lines.
  CROWD_FRESH_MS,
  HOUR_ORDERING_MIN_GAP,
  crowdColorFor,
  crowdInkFor,
  resolveVenuePhoto,
  // Declared in FlockAppInner. All forty are const, so none of them can be
  // reassigned later in the same render and read stale through the props
  // object the call site builds.
  activeVenue,
  allVenues,
  checkinJustSaved,
  checkinSaving,
  colors,
  confirmClick,
  crowdAlternatives,
  crowdData,
  crowdFetchFailed,
  crowdLoading,
  handleCheckIn,
  lastCheckinAt,
  openVenueDetail,
  partySize,
  pickingVenueForCreate,
  pickingVenueForDm,
  pickingVenueForFlockId,
  pinDmVenueNow,
  selectedDmId,
  sensorData,
  sensorHistory,
  setActiveVenue,
  setCrowdAlternatives,
  setCrowdData,
  setCurrentScreen,
  setCurrentTab,
  setPartySize,
  setPaywallTrigger,
  setPickingVenueForCreate,
  setPickingVenueForDm,
  setPickingVenueForFlockId,
  setSelectedDmId,
  setSelectedFlockId,
  setSelectedVenueForCreate,
  setVenueDetailHistory,
  setVenueDetailReturnTo,
  skipCrowdFetchRef,
  updateFlockVenue,
  venueDetailHistory,
  venueDetailReturnTo,
  // The card's own option, default unchanged from the old parameter list: the
  // consumer card is what you get when nobody asks for the owner variant.
  venueOwnerView = false,
}) {
    if (!activeVenue) return null;
    return (
          <m.div
            key={activeVenue.id || activeVenue.place_id}
            initial={{ y: 60, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ type: 'spring', damping: 22, stiffness: 260, mass: 0.8 }}
            onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', bottom: '12px', left: '8px', right: '8px', top: 'auto', backgroundColor: 'var(--bg-card-solid)', borderRadius: '16px', boxShadow: '0 8px 24px rgba(0,0,0,0.15)', zIndex: 45, overflow: 'hidden', maxHeight: 'calc(100% - 24px)', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
            {/* THE CARD THAT HAD THE PHOTO AND NEVER SHOWED IT. This is the
                primary consumer venue card, the one the map opens on a pin tap
                and the one the venue dashboard's map tab reuses, and until
                2026-08-20 it rendered the name, the type, the stars, the
                address, the crowd forecast and the actions with no image
                anywhere in it. The photo was already in hand the whole time:
                venuesToMapPins puts photo_url on every pin, and this card only
                ever read that field to pass it somewhere else. */}
            {activeVenue.photo_url && (
              <img
                src={resolveVenuePhoto(activeVenue.photo_url)}
                alt={activeVenue.name || ''}
                style={{ width: '100%', height: '104px', objectFit: 'cover', display: 'block' }}
                /* Fall back to the shared placeholder rather than vanishing. A
                   failed load used to be the one case where the layout silently
                   changed shape under the reader. */
                onError={(e) => { e.target.onerror = null; e.target.src = '/marks/venue-placeholder.jpg'; }}
              />
            )}
            <div style={{ padding: '8px 10px 10px', position: 'relative' }}>
              <button aria-label="Close" className="hit44" onClick={() => setActiveVenue(null)} style={{ position: 'absolute', top: '6px', right: '8px', width: '24px', height: '24px', borderRadius: '12px', backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1 }}>{Icons.x('var(--text-secondary)', 12)}</button>
              <m.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08, type: 'spring', damping: 20, stiffness: 300 }} style={{ marginBottom: '4px', paddingRight: '32px' }}>
                <h3 style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.005em', fontSize: 'var(--t-title)', fontWeight: '600', margin: 0, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeVenue.name}</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '1px' }}>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>{(() => {
                    const types = activeVenue.types || [];
                    if (types.length > 0) return types[0].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                    return activeVenue.type || 'Place';
                  })()}{activeVenue.price ? ` • ${activeVenue.price}` : ''}</span>
                  {/* Google returns no rating for plenty of places. Unguarded,
                      this printed the literal word "undefined" next to a star. */}
                  {activeVenue.stars != null && (
                    /* A star rating drawn with the party-popper glyph: every
                       other rating chip in the app pairs the number with
                       starFilled, and a popper next to "4.6" says nothing. */
                    <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                      {Icons.starFilled('#fbbf24', 12)}
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-primary)' }}>{activeVenue.stars}</span>
                    </div>
                  )}
                </div>
              </m.div>
              {activeVenue.addr && (
                <m.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.14, type: 'spring', damping: 18, stiffness: 280 }} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  {Icons.mapPin(colors.textSecondary, 12)}
                  <span>{activeVenue.addr}</span>
                </m.div>
              )}

              {/* AI Crowd Forecast Widget */}
              {(() => {
                // Only this venue's read. The detail modal writes the same
                // state for whichever place it has open, and an untagged read
                // put venue A's score and chart on venue B's card.
                const cdTagged = crowdData && crowdData.forPlaceId === activeVenue.place_id ? crowdData : null;
                // THE DIAL IS COVERED. Once a free account has spent its month,
                // a venue it has not opened this month gets no crowd reading
                // from the server at all (routes/crowd.js lockedCard): no score,
                // no label, no wait. Falling through would draw the "---" ring,
                // and genHourly below would invent a chart out of a zero. So the
                // whole widget becomes one block that says what is behind it.
                if (cdTagged && cdTagged.forecastAccess?.locked === true && !Number.isFinite(cdTagged.score)) {
                  const limit = Number.isFinite(cdTagged.forecastAccess.limit) ? cdTagged.forecastAccess.limit : null;
                  return (
                    <m.div initial={{ opacity: 0, y: 20, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ delay: 0.15, type: 'spring', damping: 20, stiffness: 300 }} style={{ backgroundColor: 'var(--bg-tertiary)', borderRadius: '12px', padding: '12px', marginBottom: '6px', border: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div aria-hidden="true" style={{ width: '48px', height: '48px', borderRadius: '24px', flexShrink: 0, border: '3px dashed var(--border-mid)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ margin: 0, fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--text-primary)' }}>Crowd level is part of Flock Pro</p>
                        <p style={{ margin: '2px 0 0', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                          {limit ? `You've checked ${limit} venues this month. ` : "You've used this month's venues. "}Places you already opened stay open.
                        </p>
                      </div>
                      {!venueOwnerView && (
                        <button type="button" className="hit44" onClick={(e) => { e.stopPropagation(); if (!venueOwnerView) setPaywallTrigger('forecast', activeVenue && activeVenue.place_id); }} style={{ background: 'none', border: 'none', padding: '4px 0', cursor: 'pointer', font: 'inherit', fontSize: 'var(--t-meta)', fontWeight: '600', color: colors.steel, whiteSpace: 'nowrap', flexShrink: 0 }}>
                          See Pro
                        </button>
                      )}
                    </m.div>
                  );
                }
                // A read without a finite score is a read with no estimate:
                // the dial drew it as "NaN%".
                const cd = cdTagged && Number.isFinite(cdTagged.score) ? cdTagged : null;
                const noEstimate = crowdFetchFailed || (!!cdTagged && !cd);
                const score = cd ? cd.score : (activeVenue.crowd || 0);
                // One vocabulary, one set of cut points, shared with the
                // backend and the site. The old local ladder had three bands
                // against the backend's five, so a 65 the server called "Busy"
                // this sheet called "Moderate".
                const label = cd ? cd.label : crowdLabelFor(score);
                const crowdColor = crowdColorFor(score, colors) || '#22C55E';

                // ── Whose clock? ────────────────────────────────────────────
                // How busy a place is, is a fact about that place's night. The
                // backend scores on the venue's clock and returns venueClock
                // (5e5c2c8). Labelling the bars from the phone instead would
                // offset the whole chart by the timezone difference: at 11 PM in
                // Bethlehem an LA bar is at 8 PM and only starting to fill.
                // `local: false` means the server could not resolve the venue's
                // offset and used the caller's clock, so we do the same.
                const vClock = cd?.venueClock?.local ? cd.venueClock : null;
                const deviceHour = new Date().getHours();
                const nowHour = vClock ? vClock.hour : deviceHour;
                const nowDay = vClock ? vClock.day : new Date().getDay();
                // Only worth surfacing when the two clocks actually disagree.
                const venueLocalTime = (vClock && vClock.hour !== deviceHour)
                  ? (() => {
                      const h = ((vClock.hour % 24) + 24) % 24;
                      return h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
                    })()
                  : null;

                // Generate client-side hourly forecast when API data is unavailable
                const fmtH = (h24) => { const hh = ((h24 % 24) + 24) % 24; if (hh === 0) return '12 AM'; if (hh < 12) return `${hh} AM`; if (hh === 12) return '12 PM'; return `${hh - 12} PM`; };
                const genHourly = () => {
                  const now = nowHour;
                  const types = activeVenue.types || [];
                  const isBar = types.some(t => ['bar', 'night_club'].includes(t));
                  const isCafe = types.some(t => ['cafe', 'juice_shop', 'smoothie_shop', 'juice_bar', 'tea_house', 'coffee_shop'].includes(t));
                  const isDiner = types.some(t => ['diner', 'breakfast_restaurant', 'brunch_restaurant'].includes(t));
                  const isMall = types.some(t => t === 'shopping_mall');
                  const isGym = types.some(t => ['gym', 'fitness_center'].includes(t));
                  const isLibrary = types.some(t => ['library', 'museum'].includes(t));
                  const day = nowDay;
                  const wkend = day === 5 || day === 6;
                  return Array.from({ length: 12 }, (_, i) => {
                    const h = now + i;
                    const h24 = ((h % 24) + 24) % 24;
                    // "Now" always matches the actual score
                    if (i === 0) return { hour: fmtH(h), score };
                    let s = score;
                    if (isBar) {
                      if (wkend && h24 >= 21) s = score + 25;
                      else if (h24 >= 21) s = score + 18;
                      else if (wkend && h24 >= 18) s = score + 10;
                      else if (h24 >= 18) s = score + 5;
                      else if (h24 >= 14) s = score - 20;
                      else s = score - 30;
                    } else if (isDiner) {
                      if (h24 >= 7 && h24 <= 9) s = score + 18;
                      else if (h24 >= 10 && h24 <= 11) s = score + 12;
                      else if (h24 >= 11 && h24 <= 13) s = score + 10;
                      else if (h24 >= 14 && h24 <= 16) s = score - 10;
                      else if (h24 >= 17 && h24 <= 20) s = score - 5;
                      else s = score - 20;
                    } else if (isCafe) {
                      if (h24 >= 7 && h24 <= 9) s = score + 15;
                      else if (h24 >= 10 && h24 <= 11) s = score + 5;
                      else if (h24 >= 12 && h24 <= 14) s = score - 5;
                      else if (h24 >= 15 && h24 <= 19) s = score - 15;
                      else s = score - 30;
                    } else if (isMall) {
                      if (wkend && h24 >= 12 && h24 <= 17) s = score + 18;
                      else if (wkend && h24 >= 10 && h24 <= 11) s = score + 10;
                      else if (h24 >= 12 && h24 <= 14) s = score + 10;
                      else if (h24 >= 15 && h24 <= 17) s = score + 5;
                      else if (h24 >= 18 && h24 <= 20) s = score + 3;
                      else s = score - 15;
                    } else if (isGym) {
                      if (!wkend && h24 >= 17 && h24 <= 19) s = score + 18;
                      else if (!wkend && h24 >= 6 && h24 <= 8) s = score + 12;
                      else if (wkend && h24 >= 9 && h24 <= 11) s = score + 10;
                      else if (h24 >= 12 && h24 <= 14) s = score + 3;
                      else s = score - 15;
                    } else if (isLibrary) {
                      if (wkend && h24 >= 11 && h24 <= 15) s = score + 12;
                      else if (h24 >= 11 && h24 <= 14) s = score + 8;
                      else if (h24 >= 15 && h24 <= 17) s = score + 3;
                      else s = score - 15;
                    } else {
                      // Restaurant / default
                      if (h24 >= 18 && h24 <= 20) s = score + 15;
                      else if (h24 >= 11 && h24 <= 13) s = score + 10;
                      else if (h24 >= 21 && h24 <= 22) s = wkend ? score + 5 : score - 5;
                      else if (h24 >= 14 && h24 <= 17) s = score - 15;
                      else s = score - 25;
                    }
                    return { hour: fmtH(h), score: Math.round(Math.max(5, Math.min(95, s))) };
                  });
                };

                const hourlyData = cd?.hourly || genHourly();

                // Extract real hours: prefer crowd API, fall back to venue search opening_hours
                const venueOH = activeVenue.opening_hours;

                // Find the period that actually contains "now". Handles two failure modes
                // we kept hitting on overnight venues:
                //   1. Sites like halal grills with 10AM-3AM hours — Google emits a separate
                //      Saturday early-morning period (12AM-3AM, leftover from Friday) AND the
                //      main Saturday 10AM-3AM period. Naively picking the first day=6 entry
                //      grabs the leftover, gives openHour=0, and greys 10AM-11PM.
                //   2. The backend cd.openHour was sometimes set from the wrong period, so
                //      we now do this client-side and override cd.openHour entirely.
                // Handles both legacy format (open.time = "1000") and new format (open.hour = 10).
                const activePeriod = (() => {
                  const periods = venueOH?.periods;
                  if (!periods || !periods.length) return null;
                  const getHour = (t) => (
                    t == null ? null
                      : typeof t.hour === 'number' ? t.hour
                      : (typeof t.time === 'string' && t.time.length >= 4) ? parseInt(t.time.slice(0, 2), 10)
                      : null
                  );
                  const getMin = (t) => (
                    t == null ? 0
                      : typeof t.minute === 'number' ? t.minute
                      : (typeof t.time === 'string' && t.time.length >= 4) ? parseInt(t.time.slice(2, 4), 10)
                      : 0
                  );
                  const now = new Date();
                  // minute-of-week (0..10079)
                  const nowMOW = now.getDay() * 1440 + now.getHours() * 60 + now.getMinutes();
                  for (const p of periods) {
                    if (!p.open) continue;
                    const oH = getHour(p.open);
                    if (oH == null) continue;
                    const cH = getHour(p.close);
                    const oMOW = (p.open.day ?? 0) * 1440 + oH * 60 + getMin(p.open);
                    let cMOW = p.close
                      ? ((p.close.day ?? 0) * 1440 + (cH ?? 0) * 60 + getMin(p.close))
                      : oMOW + 24 * 60; // 24/7 venues sometimes omit close
                    if (cMOW <= oMOW) cMOW += 7 * 1440; // wrap to next week
                    let n = nowMOW;
                    if (n < oMOW) n += 7 * 1440;
                    if (n >= oMOW && n < cMOW) return { openHour: oH, closeHour: (cH === 0 ? 24 : cH) };
                  }
                  // No period contains "now" — fall back to today's first period
                  const today = now.getDay();
                  const tp = periods.find(pd => pd.open?.day === today);
                  if (!tp) return null;
                  const oH = getHour(tp.open);
                  const cH = getHour(tp.close);
                  return { openHour: oH, closeHour: cH === 0 ? 24 : cH };
                })();

                const venueOpenHour = activePeriod?.openHour ?? cd?.openHour ?? null;
                const venueCloseHour = activePeriod?.closeHour ?? cd?.closeHour ?? null;

                // Compute isOpen — prefer explicit API signal, fall back to today's hours, then null
                const computedIsOpen = (venueOpenHour != null && venueCloseHour != null)
                  ? (venueCloseHour > venueOpenHour
                      ? (nowHour >= venueOpenHour && nowHour < venueCloseHour)       // normal hours e.g. 9–18
                      : (nowHour >= venueOpenHour || nowHour < venueCloseHour))      // overnight e.g. 17–02
                  : null;
                const realIsOpen = cd?.isOpen ?? venueOH?.openNow ?? computedIsOpen;
                const isOpen = realIsOpen;
                const isClosed = isOpen === false;

                // Closed all day = venue is closed AND we have no opening window for today
                const closedAllDay = isClosed && venueOpenHour == null;

                // Wait estimate — only show actual wait if busy (70%+). Under 70% = no meaningful wait.
                const getWait = () => {
                  if (isClosed) return 'Closed';
                  if (cd && cd.waitEstimate) return cd.waitEstimate;
                  if (score < 70) return 'No wait';
                  const types = activeVenue.types || [];
                  const isBarType = types.some(t => ['bar', 'night_club'].includes(t));
                  const isCafeType = types.some(t => ['cafe', 'juice_shop', 'smoothie_shop', 'juice_bar', 'tea_house', 'coffee_shop'].includes(t));
                  if (isBarType) return score <= 85 ? '5-10 min' : '10-15 min';
                  if (isCafeType) return score <= 85 ? '5-10 min' : '10-15 min';
                  return score <= 85 ? '10-20 min' : '20-35 min';
                };
                const waitText = getWait();

                // Peak and best-time come from the server or they do not exist.
                // There used to be a ~55 line client fallback here that
                // synthesised a whole 24-hour curve from the single current
                // score and a type guess, then named a 'best time' off it.
                // Two problems: the invented recommendation was unconstrained
                // by the real forecast, and `bestTime: null` is exactly what the
                // Pro gate sends when the forecast is locked, so the client sat
                // there fabricating the one thing the paywall had withheld.
                const peakText = cd?.peak || null;
                // A closed venue can never be 'Now is good'. Say nothing rather
                // than guess a replacement hour.
                const bestText = (isClosed && cd?.bestTime === 'Now is good') ? null : (cd?.bestTime || null);

                // LIVE means recent, not "a weather object came back". The chip
                // used to read `weather != null`, so a ten minute old cached
                // response still claimed LIVE. lastUpdated is on the response
                // and was read nowhere in this file.
                //
                // AND recent is not enough either. `lastUpdated` is stamped when
                // the route BUILDS the payload, so on any uncached request it is
                // seconds old and this was true for every venue in the product,
                // including one with no baseline whose number came from the
                // category curve. The card then drew a pulsing green LIVE over
                // an attribution line eight rows below reading "An estimate from
                // typical patterns for this kind of place". The route ships
                // predictionMethod for exactly this question, so ask it: only a
                // number the model actually produced may call itself live.
                const isLiveNow = (() => {
                  if (!cd?.lastUpdated) return false;
                  const method = String(cd.predictionMethod || '');
                  if (!method || method.startsWith('rule_engine')) return false;
                  const t = Date.parse(cd.lastUpdated);
                  return Number.isFinite(t) && (Date.now() - t) < CROWD_FRESH_MS;
                })();

                // Per-bar openness computed once; the chart then runs only as
                // long as the venue's hours do — trailing closed hours are
                // trimmed instead of rendering a dead gray tail after close.
                const chartBars = (() => {
                  // Per-bar openness now comes from the server. crowd.js ships
                  // `hourly[i].open` (Google's openNow wins for the Now bar) and
                  // `hoursToday`, so the client no longer re-derives it. The two
                  // local tests this replaces disagreed with each other by an
                  // hour, one inclusive and one exclusive, on top of a ~35 line
                  // ladder of per-type guesses. Only the client-generated
                  // fallback curve still needs the Google window.
                  const apiHourly = !!cd?.hourly;
                  const infos = hourlyData.map((h, i) => {
                    const isNow = i === 0;
                    const parsedH = ((nowHour + i) % 24 + 24) % 24;
                    // A live score for Now means the venue is open now, whatever
                    // the posted hours claim.
                    const hasLiveNow = isNow && Number.isFinite(score) && score > 0;
                    const hourClosed = hasLiveNow ? false : (closedAllDay ? true : (
                      apiHourly
                        ? h.open === false
                        : (venueOpenHour != null && venueCloseHour != null)
                          ? (venueCloseHour > venueOpenHour
                              ? (parsedH < venueOpenHour || parsedH >= venueCloseHour)
                              : (parsedH >= venueCloseHour && parsedH < venueOpenHour))
                          : (isClosed && isNow)
                    ));
                    // Defend against null / NaN scores; the 'Now' bar mirrors the
                    // live header score so the chart and dial never disagree.
                    const liveScoreForNow = (isNow && Number.isFinite(score) && score > 0) ? score : null;
                    const safeScore = liveScoreForNow != null
                      ? liveScoreForNow
                      : (Number.isFinite(h.score) ? h.score : 0);
                    // The server names which bar its best-time sentence means, so
                    // the chart marks the same hour instead of guessing one.
                    const isBest = cd?.bestIndex === i && !cd?.bestIsNow;
                    return { h, isNow, hourClosed, safeScore, isBest };
                  });
                  let end = infos.length;
                  while (end > 1 && infos[end - 1].hourClosed) end--;
                  return infos.slice(0, end);
                })();

                return (
              <m.div initial={{ opacity: 0, y: 20, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ delay: 0.15, type: 'spring', damping: 20, stiffness: 300 }} style={{ backgroundColor: 'var(--bg-tertiary)', borderRadius: '12px', padding: '6px 10px 8px', marginBottom: '6px', border: '1px solid var(--border-subtle)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px', gap: '8px' }}>
                  {/* Game night, sharing the row with the LIVE chip: in
                      line with it, and the chip keeps the right corner
                      (2026-08-30). A schedule FACT, never a crowd claim: the
                      same-day ablation measured no lift the model could stand
                      behind, so this states who plays and stops. The server
                      applies the same 60km market gate the training features
                      used and decides everything; this only prints. The empty
                      span keeps the chip right-aligned on non-game days. */}
                  {cd?.gameNight?.teams?.length > 0 ? (
                    <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-primary)', fontWeight: '600', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {cd.gameNight.homeGame && cd.gameNight.homeGame.distanceKm <= 10 && cd.gameNight.homeGame.venueName
                        ? `${cd.gameNight.homeGame.team} home game tonight at ${cd.gameNight.homeGame.venueName}`
                        : `${cd.gameNight.teams.length === 1
                            ? cd.gameNight.teams[0]
                            : cd.gameNight.teams.slice(0, -1).join(', ') + ' and ' + cd.gameNight.teams[cd.gameNight.teams.length - 1]} play tonight`}
                    </span>
                  ) : <span />}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                    {crowdLoading ? (
                      <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>Loading...</span>
                    ) : (
                      <>
                        {/* The dot is decorative so it keeps the vivid hue; the LABEL
                            has to be readable on the pale card. #22C55E measured
                            1.85:1 and colors.amber 1.64:1 on --bg-tertiary. The
                            accent-*-text tokens are theme-aware and clear 4.5:1. */}
                        <div style={{ width: '6px', height: '6px', borderRadius: '3px', backgroundColor: isLiveNow ? '#22C55E' : colors.amber, animation: isLiveNow ? 'pulse 2s ease-in-out infinite' : 'none' }} />
                        <span style={{ fontSize: 'var(--t-meta)', color: isLiveNow ? 'var(--accent-green-text)' : 'var(--accent-amber-text)', fontWeight: '500' }}>{isLiveNow ? 'LIVE' : 'ESTIMATED'}</span>
                      </>
                    )}
                  </div>
                </div>
                {/* The venue's own number. When the published score IS the
                    owner's live reading, the user must be able to tell — "the
                    {venue-type} says" is a different claim from "we think",
                    and the label is the whole deal that makes an owner-set
                    number honest. Server decides `applied` AND the words
                    (ownerReport.noun, category-derived in utils/venueLabel.js);
                    this only prints them. */}
                {cd?.ownerReport?.applied && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-primary)', fontWeight: '600' }}>
                      The {cd.ownerReport.noun || 'venue'} says it's at {cd.score}% right now
                    </span>
                    {(() => {
                      const mins = Math.round((Date.now() - Date.parse(cd.ownerReport.reportedAt)) / 60000);
                      return Number.isFinite(mins) && mins >= 0
                        ? <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }}>{mins <= 1 ? 'set just now' : `set ${mins} min ago`}</span>
                        : null;
                    })()}
                  </div>
                )}
                {/* Calibration indicator */}
                {cd?.calibration?.feedbackUsed && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', fontWeight: '500' }}>Calibrated from {cd.calibration.reportCount} user report{cd.calibration.reportCount !== 1 ? 's' : ''}</span>
                    {/* The owner's figure when real reports outranked it —
                        shown as information, never as the number. The two
                        disagreeing in public is the honest state. */}
                    {cd?.ownerReport && !cd.ownerReport.applied && (
                      <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }}>The {cd.ownerReport.noun || 'venue'} says {cd.ownerReport.percent}%.</span>
                    )}
                    {Math.abs(cd.calibration.predictionDrift) > 15 && (
                      <span style={{ fontSize: 'var(--t-meta)', padding: '1px 6px', borderRadius: '8px', backgroundColor: cd.calibration.predictionDrift > 0 ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)', color: cd.calibration.predictionDrift > 0 ? colors.red : '#16a34a', fontWeight: '500' }}>
                        {cd.calibration.predictionDrift > 0 ? 'Trending busier than expected' : 'Trending quieter than expected'}
                      </span>
                    )}
                  </div>
                )}

                {/* Crowd Meter */}
                <m.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25, type: 'spring', damping: 18, stiffness: 260 }} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
                  {isClosed ? (
                    <div style={{ width: '60px', height: '60px', borderRadius: '30px', backgroundColor: 'var(--border-default)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <div style={{ width: '48px', height: '48px', borderRadius: '24px', backgroundColor: 'var(--bg-card-solid)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-tertiary)' }}>---</span>
                      </div>
                    </div>
                  ) : (!cd && noEstimate) ? (
                    <div style={{ width: '60px', height: '60px', borderRadius: '30px', flexShrink: 0, backgroundColor: 'var(--bg-card-solid)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-tertiary)' }}>---</span>
                    </div>
                  ) : !cd ? (
                    <div className="skeleton" style={{ width: '60px', height: '60px', borderRadius: '30px', flexShrink: 0 }} />
                  ) : (
                    /* `score`, not a second variable for the same number. A
                       separate `dialScore` let the dial and the sentence beside
                       it quote different figures; the `!cd` branch above already
                       covers the "no data yet" case. */
                    <AnimatedDial score={score} color={crowdColor} />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {noEstimate && !isClosed ? (
                      /* The dial and the chart already say a failed read; this
                         column pulsed forever (Explore audit, 2026-09-05). */
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>No crowd read for this spot right now.</p>
                    ) : !cd && !isClosed ? (
                      <>
                        <div className="skeleton" style={{ width: '55%', height: '14px', borderRadius: '4px', marginBottom: '8px' }} />
                        <div className="skeleton" style={{ width: '40%', height: '11px', borderRadius: '4px', marginBottom: '8px' }} />
                        <div className="skeleton" style={{ width: '70%', height: '11px', borderRadius: '4px' }} />
                      </>
                    ) : isClosed ? (
                      <>
                        <p style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.redText, margin: 0 }}>{closedAllDay ? 'Closed Today' : 'Currently Closed'}</p>
                        {!closedAllDay && (cd?.forecastAccess?.locked || bestText) && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
                            {Icons.clock(colors.steel, 12)}
                            {cd?.forecastAccess?.locked ? (
                              <button type="button" onClick={(e) => { e.stopPropagation(); if (!venueOwnerView) setPaywallTrigger('forecast', activeVenue && activeVenue.place_id); }} style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left', font: 'inherit', fontSize: 'var(--t-meta)', fontWeight: '600', color: colors.steel, cursor: 'pointer' }}>
                                Best time to visit: <span aria-hidden style={{ filter: 'blur(4px)', userSelect: 'none' }}>9 PM</span> <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', letterSpacing: '0.5px' }}>PRO</span>
                              </button>
                            ) : (
                              <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.steel }}>Best time to visit: {bestText}</span>
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <p style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: crowdInkFor(score, colors) || crowdColor, margin: 0 }}>{label}</p>
                        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '3px 0' }}>{waitText === 'No wait' ? 'No wait expected' : /^\d|^~/.test(waitText) ? `Est. wait: ${waitText}` : waitText}</p>
                        {(cd?.forecastAccess?.locked || bestText) && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          {Icons.clock(colors.steel, 12)}
                          {cd?.forecastAccess?.locked ? (
                            <button type="button" onClick={(e) => { e.stopPropagation(); if (!venueOwnerView) setPaywallTrigger('forecast', activeVenue && activeVenue.place_id); }} style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left', font: 'inherit', fontSize: 'var(--t-meta)', fontWeight: '600', color: colors.steel, cursor: 'pointer' }}>
                              Least crowded: <span aria-hidden style={{ filter: 'blur(4px)', userSelect: 'none' }}>9 PM</span> <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', letterSpacing: '0.5px' }}>PRO</span>
                            </button>
                          ) : (
                            <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.steel }}>Least crowded: {bestText}</span>
                          )}
                        </div>
                        )}
                      </>
                    )}
                  </div>
                </m.div>

                {/* Where the number came from. Every published figure carries
                    confidenceBasis from the server; nothing renders
                    unattributed. Four sources, four sentences. */}
                {!isClosed && !!cd && (
                  <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '0 0 8px' }}>
                    {cd.confidenceBasis === 'owner_report' ? `From the ${cd.ownerReport?.noun || 'venue'} itself, not a Flock estimate.`
                      : cd.confidenceBasis === 'user_reports' ? 'From the crowd model, adjusted by people who are there.'
                      : cd.predictionMethod === 'ml' ? 'From the Flock crowd model.'
                      : 'An estimate from typical patterns for this kind of place.'}
                  </p>
                )}

                {/* One-tap crowd reality check (open venues, after the score loads) */}
                {!isClosed && !!cd && !venueOwnerView && (
                  <CrowdRealityCheck key={activeVenue.place_id} placeId={activeVenue.place_id} venueName={activeVenue.name} predicted={score} ownerAsserted={!!cd?.ownerReport?.applied} />
                )}

                {/* Group Admission */}
                <m.div initial={{ opacity: 0, y: 16, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ delay: 0.4, type: 'spring', damping: 20, stiffness: 280 }} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                  {partySize === null ? (
                    <>
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Group:</span>
                      <div style={{ display: 'flex', gap: '4px', flex: 1 }}>
                        {[1, 2, 3, 4, 5, 6, '7+'].map(n => (
                          <button className="hit44" key={n} onClick={() => setPartySize(typeof n === 'number' ? n : 7)}
                            style={{ flex: 1, padding: '3px 0', borderRadius: '6px', border: '1px solid var(--border-default)', background: 'var(--bg-card-solid)', color: 'var(--text-primary)', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', transition: 'all 0.15s ease' }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(45,90,135,0.14)'; e.currentTarget.style.borderColor = '#2d5a87'; e.currentTarget.style.color = '#2d5a87'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-card-solid)'; e.currentTarget.style.borderColor = 'var(--border-default)'; e.currentTarget.style.color = 'var(--text-primary)'; }}>
                            {n}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (() => {
                    // The score and the hour, together, or the verdict is about
                    // an hour nobody is looking at. `score` is the Now bar, so
                    // the hour it belongs to is the venue's own current hour —
                    // nowHour/nowDay, the same pair the chart labels its bars
                    // with, which fall back to the phone only where the SERVER
                    // fell back (venueClock.local === false). Anything that puts
                    // a different bar on this card passes that bar's score and
                    // that bar's hour here as one pair.
                    const admission = getGroupAdmission(score, partySize, activeVenue, { hour: nowHour, day: nowDay });
                    if (!admission) return null;
                    return (
                      <>
                        <div style={{ width: '6px', height: '6px', borderRadius: '3px', backgroundColor: admission.color, flexShrink: 0 }} />
                        <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: admission.color }}>{admission.text}</span>
                        <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }}>({partySize})</span>
                        <button className="hit44" onClick={() => setPartySize(null)} style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', marginLeft: 'auto' }}>Change</button>
                      </>
                    );
                  })()}
                </m.div>

                {/* THE LOCKED FORECAST. The gate (routes/crowd.js
                    LOCKED_FORECAST_FIELDS) sends `hourly: []`, which is truthy,
                    so hourlyData above is an empty list and the chart below drew
                    its heading over an empty 56px gap: it read as a broken card
                    and did not say it was a Pro feature. One row now says what
                    is behind it and opens the sheet, the same tap target as the
                    blurred best-time line. */}
                {cd?.forecastAccess?.locked ? (
                  <m.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.4, ease: 'easeOut' }} style={{ marginBottom: '6px' }}>
                    <button type="button" onClick={(e) => { e.stopPropagation(); if (!venueOwnerView) setPaywallTrigger('forecast', activeVenue && activeVenue.place_id); }} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '10px 12px', borderRadius: '10px', border: '1px dashed var(--border-default)', backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer', textAlign: 'left', font: 'inherit' }}>
                      <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', lineHeight: 1.4 }}>The hour-by-hour chart is part of Flock Pro.</span>
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: colors.steel, whiteSpace: 'nowrap' }}>See Pro</span>
                    </button>
                  </m.div>
                ) : (
                /* Hourly Forecast Graph — fades in immediately, bars animate up */
                <m.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.4, ease: 'easeOut' }} style={{ marginBottom: '6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                    {/* The hours are the venue's, not the phone's. Say so only
                        when the two clocks differ, so someone in Pennsylvania
                        reading an LA bar knows why the chart starts at 8 PM. */}
                    <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', textTransform: 'uppercase', margin: 0 }}>
                      Expected Crowd by Hour{venueLocalTime ? <span style={{ fontWeight: '500', textTransform: 'none' }}> · {venueLocalTime} there</span> : ''}
                    </p>
                    {(() => {
                      if (!cd && !isClosed) return null; // no trend claims while loading
                      // Trend arrow: compare "Now" to next-hour prediction.
                      // Skip if the next hour is closed or unknown.
                      //
                      // The dead zone is HOUR_ORDERING_MIN_GAP, the measured
                      // hour-ordering floor. It used to be 5, justified in this
                      // comment by the model's level MAE being about 5 points,
                      // and that was a level argument licensing an ordering
                      // claim: "Rising" says the next hour OUTRANKS this one,
                      // and inside ten points that call is a coin flip
                      // (HOUR-RANKING-EVAL.md). Every server-side hour
                      // comparison refuses below the same number, so this arrow
                      // stopped being the one surface willing to name a
                      // direction the best-time sentence beside it refuses to.
                      const cur = (Number.isFinite(score) && score > 0) ? score : (Number.isFinite(hourlyData[0]?.score) ? hourlyData[0].score : null);
                      const next = Number.isFinite(hourlyData[1]?.score) ? hourlyData[1].score : null;
                      if (cur == null || next == null || next <= 0) return null;
                      const diff = next - cur;
                      const rising = diff >= HOUR_ORDERING_MIN_GAP;
                      const falling = diff <= -HOUR_ORDERING_MIN_GAP;
                      const arrow = rising ? '↗' : falling ? '↘' : '→';
                      const label = rising ? 'Rising' : falling ? 'Falling' : 'Steady';
                      const color = rising ? colors.red : falling ? colors.steel : 'var(--text-secondary)';
                      return (
                        <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color, letterSpacing: '0.3px' }}>{arrow} {label}</span>
                      );
                    })()}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: '56px' }}>
                    {/* Skeleton bars while the prediction loads — never fake colored data */}
                    {(!cd && crowdFetchFailed) ? (
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: 0, alignSelf: 'center', width: '100%', textAlign: 'center' }}>No crowd read for this spot right now.</p>
                    ) : (!cd && !isClosed) ? [34, 46, 40, 52, 44, 38, 50, 42, 36, 48, 40, 32].map((hgt, i) => (
                      <div key={i} style={{ flex: 1, display: 'flex', alignItems: 'flex-end', height: '100%' }}>
                        <div className="skeleton" style={{ width: '100%', height: `${hgt}px`, borderRadius: '3px 3px 1px 1px' }} />
                      </div>
                    )) : chartBars.map((b, i) => {
                      const barColor = b.hourClosed ? 'var(--text-tertiary)' : (crowdColorFor(b.safeScore, colors) || '#22C55E');
                      // 56px chart height. The open-bar floor used to be 16px, which
                      // on a 0.5 scale meant every score at or below 32 drew the same
                      // height and a dead 8% morning looked exactly like a 32% one.
                      // 4px is enough to stay visible without flattening the low end.
                      const barH = b.hourClosed ? 10 : Math.max(Math.min(b.safeScore, 100) * 0.5, 4);
                      return (
                      <div key={i} style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', minWidth: 0, height: '100%' }}>
                        {/* Faint track behind every slot so chart structure reads even when bars are short */}
                        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '100%', backgroundColor: 'var(--border-subtle, rgba(148,163,184,0.12))', borderRadius: '3px', opacity: 0.5 }} />
                        <div style={{
                          position: 'relative',
                          width: '100%',
                          height: `${barH}px`,
                          borderRadius: '3px 3px 1px 1px',
                          backgroundColor: barColor,
                          opacity: b.hourClosed ? 0.55 : b.isNow ? 1 : 0.9,
                          boxShadow: 'none',
                          transformOrigin: 'bottom',
                          animation: `barRise 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) ${i * 0.04}s both`,
                          transition: `height 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) ${i * 0.035}s`,
                          flexShrink: 0,
                        }} />
                        {/* The hour the best-time sentence names, marked so the
                            chart and the sentence point at the same bar. */}
                        {b.isBest && <div aria-hidden style={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', width: '4px', height: '4px', borderRadius: '2px', backgroundColor: colors.steel }} />}
                      </div>
                      );
                    })}
                  </div>
                  <div style={{ display: 'flex', gap: '2px', marginTop: '2px' }}>
                    {(!cd && !isClosed) ? null : chartBars.map((b, i) => (
                      <span key={i} style={{ flex: 1, textAlign: 'center', fontSize: 'var(--t-meta)', color: b.isNow ? 'var(--text-primary)' : 'var(--text-tertiary)', fontWeight: b.isNow ? '500' : '400', minWidth: 0, overflow: 'hidden' }}>{b.isNow ? 'Now' : b.h.hour}</span>
                    ))}
                  </div>
                  {/* The server sent a crowd read with no hour-by-hour curve, so
                      the bars above are the client's category shape (genHourly).
                      They used to draw under the same ESTIMATED chip as a real
                      model curve, indistinguishable from one. */}
                  {cd && !cd.hourly && !crowdFetchFailed && (
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '6px 0 0' }}>
                      Typical for {activeVenue.category ? `a ${String(activeVenue.category).toLowerCase()}` : 'a place like this'} at these hours, not a read of this spot.
                    </p>
                  )}
                </m.div>
                )}

                {/* Busiest Hours & Wait */}
                <m.div initial={{ opacity: 0, y: 14 }} animate={cd ? { opacity: 1, y: 0 } : { opacity: 0, y: 14 }} transition={{ delay: 0.8, duration: 0.4, ease: 'easeOut' }} style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
                  <div style={{ flex: 1, backgroundColor: 'var(--bg-card-solid)', borderRadius: '8px', padding: '4px 8px', border: '1px solid var(--border-subtle)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}>
                      {Icons.trendingUp(colors.red, 12)}
                      <span style={{ fontSize: 'var(--t-micro)', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Busiest Hours</span>
                    </div>
                    {/* `peak` is one of the fields the forecast gate withholds
                        (routes/crowd.js LOCKED_FORECAST_FIELDS), so under the
                        paywall this tile printed the words BUSIEST HOURS over
                        nothing at all: an empty box that reads as a broken
                        card, not as a boundary. Same blurred stand-in and same
                        tap target as the best-time line above it. */}
                    {closedAllDay ? (
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.redText }}>Closed Today</span>
                    ) : cd?.forecastAccess?.locked ? (
                      <button type="button" onClick={(e) => { e.stopPropagation(); if (!venueOwnerView) setPaywallTrigger('forecast', activeVenue && activeVenue.place_id); }} style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left', font: 'inherit', fontSize: 'var(--t-meta)', fontWeight: '600', color: colors.steel, cursor: 'pointer' }}>
                        <span aria-hidden style={{ filter: 'blur(4px)', userSelect: 'none' }}>9 PM</span> <span style={{ fontWeight: '500', letterSpacing: '0.5px' }}>PRO</span>
                      </button>
                    ) : (
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>{peakText}</span>
                    )}
                  </div>
                  <div style={{ flex: 1, backgroundColor: 'var(--bg-card-solid)', borderRadius: '8px', padding: '4px 8px', border: '1px solid var(--border-subtle)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}>
                      {Icons.zap(colors.amber, 12)}
                      <span style={{ fontSize: 'var(--t-micro)', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{isClosed ? 'Status' : /^\d|^~|wait/i.test(waitText) ? 'Est. Wait Right Now' : 'Crowd Level'}</span>
                    </div>
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: isClosed ? colors.red : colors.navy }}>{isClosed ? 'Closed' : waitText}</span>
                  </div>
                </m.div>

                {/* Quieter Options */}
                {/* `v.crowd < score` used to do the filtering, and
                    venuesToMapPins sets crowd to NULL for a venue with no
                    reading, on purpose. A relational comparison coerces null to
                    0, so every unscored venue passed "quieter than this" and
                    `a.crowd - b.crowd` sorted them to the front as the quietest
                    places nearby, each captioned "No reading yet". The outer
                    condition also only checked the CATEGORY filter, so the
                    heading could render over an empty row. Both now ask the same
                    question, and both require two real numbers. */}
                {!venueOwnerView && (crowdAlternatives.length > 0 || (!cd && typeof score === 'number' && allVenues.filter(v => v.id !== activeVenue.id && v.category === activeVenue.category && typeof v.crowd === 'number' && v.crowd < score && v.opening_hours?.openNow !== false).length > 0)) && (
                <m.div initial={{ opacity: 0, y: 14 }} animate={cd ? { opacity: 1, y: 0 } : { opacity: 0, y: 14 }} transition={{ delay: 1.0, duration: 0.4, ease: 'easeOut' }}>
                  <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase' }}>Less Crowded Nearby</p>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {(crowdAlternatives.length > 0 ? crowdAlternatives.slice(0, 2) : allVenues.filter(v => v.id !== activeVenue.id && v.category === activeVenue.category && typeof v.crowd === 'number' && typeof score === 'number' && v.crowd < score && v.opening_hours?.openNow !== false).sort((a, b) => a.crowd - b.crowd).slice(0, 2)).map((v, i) => (
                      <button key={v.placeId || v.id || i} className="hit44 glass-btn glass-secondary" onClick={() => {
                        const pid = v.placeId || v.place_id;
                        if (pid) {
                          setVenueDetailHistory(prev => [...prev, { activeVenue, crowdData: cd, crowdAlternatives }]);
                          openVenueDetail(pid, { name: v.name, place_id: pid }, { panMap: true });
                        } else {
                          setActiveVenue(v);
                        }
                      }} style={{ flex: 1, padding: '6px', backgroundColor: 'var(--bg-card-solid)', border: '1px solid var(--border-subtle)', borderRadius: '8px', cursor: 'pointer', textAlign: 'left' }}>
                        <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, margin: 0 }}>{v.name}</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
                          <div style={{ width: '6px', height: '6px', borderRadius: '3px', backgroundColor: crowdColorFor(v.score ?? v.crowd, colors) || 'var(--border-mid)' }} />
                          <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>{v.label || crowdLabelFor(v.score ?? v.crowd) || 'No reading yet'}</span>
                        </div>
                        {/* WHOSE NUMBER IT IS. The nearby list applies the owner
                            override to every row and RANKS by it, and this cell
                            printed a name, a dot and a label, so a venue whose
                            owner had set their own slider to 10 appeared here as
                            "Quiet", indistinguishable from a Flock reading and
                            recommended over the venue the person was looking at.
                            services/ownerReports.js says the source is labelled
                            on every surface; this was the surface where it was
                            not, and it is the one where the conflict of interest
                            is sharpest. Same noun the card uses. */}
                        {v.confidenceBasis === 'owner_report' && (
                          <span style={{ display: 'block', fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', marginTop: '2px' }}>
                            {`The ${v.ownerReport?.noun || 'venue'} says so`}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </m.div>
                )}

                {/* Back to previous venue button */}
                {venueDetailHistory.length > 0 && (
                  <button onClick={() => {
                    const prev = venueDetailHistory[venueDetailHistory.length - 1];
                    setVenueDetailHistory(h => h.slice(0, -1));
                    if (prev.activeVenue) {
                      skipCrowdFetchRef.current = prev.crowdData?.lastUpdated || true;
                      setActiveVenue(prev.activeVenue);
                      setCrowdData(prev.crowdData);
                      setCrowdAlternatives(prev.crowdAlternatives || []);
                      if (window.__flockPanToVenue && prev.activeVenue.place_id) {
                        const loc = prev.activeVenue.location;
                        window.__flockPanToVenue({ place_id: prev.activeVenue.place_id, lat: loc?.latitude, lng: loc?.longitude, name: prev.activeVenue.name, address: prev.activeVenue.addr || prev.activeVenue.formatted_address, rating: prev.activeVenue.stars || prev.activeVenue.rating, photo_url: prev.activeVenue.photo_url });
                      }
                    }
                  }} className="hit44 glass-btn glass-secondary" style={{ width: '100%', padding: '8px', marginTop: '8px', borderRadius: '10px', border: `1px solid ${colors.navy}30`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                    {Icons.arrowLeft(colors.navy, 14)} Back to {venueDetailHistory[venueDetailHistory.length - 1]?.activeVenue?.name || 'Previous Venue'}
                  </button>
                )}
              </m.div>
                );
              })()}

              {/* Live Occupancy card — only renders when a Pi sensor exists for this venue */}
              {sensorData && !sensorData.sensor_data && sensorData.recent_checkins > 0 && (
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 12px' }}>
                  {/* NOT "by tag". routes/sensors.js counts every row in
                      venue_checkins for the hour with no checkin_source filter,
                      and the app's own Check in button writes 'manual'. So one
                      person tapping a button in a venue with no tag at all made
                      this card claim a tag had been tapped. routes/checkin.js
                      refuses to record a manual tap as 'nfc' for that exact
                      reason, and this sentence undid the distinction. The
                      number is right; the four words about how it was collected
                      were not. */}
                  {sensorData.recent_checkins} check-in{sensorData.recent_checkins === 1 ? '' : 's'} here in the last hour
                </p>
              )}
              {sensorData?.sensor_data && (() => {
                const sd = sensorData.sensor_data;
                // Number first. A `== null` check alone let a non-numeric
                // reading through, and every comparison below is false against
                // NaN, so a garbage value was labelled "Loud" and printed
                // "NaN dB" beside it.
                const noiseDb = Number(sd.noise_db);
                const noiseLabel = !Number.isFinite(noiseDb) ? null
                  // `color` paints the 6px dot, `ink` paints the word. They
                  // differ because the saturated hue is correct as a fill and
                  // unreadable as 12px type on a light card: amber measures
                  // 2.15:1 there and orange 2.80:1.
                  : noiseDb < 50 ? { text: 'Quiet', color: colors.steel, ink: colors.steel }
                  : noiseDb < 70 ? { text: 'Moderate', color: colors.amber, ink: colors.amberText }
                  : noiseDb < 85 ? { text: 'Lively', color: colors.food, ink: colors.foodText }
                  : { text: 'Loud', color: colors.red, ink: colors.redText };
                const ageMin = sd.recorded_at
                  ? Math.max(0, Math.round((Date.now() - new Date(sd.recorded_at).getTime()) / 60000))
                  : null;
                const ageStr = ageMin == null ? '' : ageMin === 0 ? 'just now' : ageMin === 1 ? '1 min ago' : `${ageMin} min ago`;
                // Backend returns one row per hour (date_trunc); match buckets by
                // hour-truncated timestamp. Empty hours render as placeholder bars
                // so the chart structure is always legible.
                const hourMs = (ts) => { const d = new Date(ts); d.setMinutes(0, 0, 0); return d.getTime(); };
                const now = new Date();
                const slotMs = 60 * 60 * 1000;
                const currentHour = hourMs(now);
                const slots = Array.from({ length: 12 }, (_, idx) => {
                  const slotTs = currentHour - (11 - idx) * slotMs;
                  const reading = sensorHistory.find(r => hourMs(r.recorded_at) === slotTs) || null;
                  return { hour: new Date(slotTs).getHours(), reading };
                });
                const maxHeads = Math.max(1, ...slots.map(s => s.reading?.thermal_headcount || 0));
                return (
                  <m.div
                    initial={{ opacity: 0, y: 14 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 1.05, duration: 0.4, ease: 'easeOut' }}
                    style={{
                      backgroundColor: 'var(--bg-card-solid)',
                      border: '1px solid var(--border-default)',
                      borderRadius: '14px',
                      padding: '14px 16px',
                      boxShadow: 'var(--card-shadow)',
                      marginBottom: '8px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                        <span className="flock-pulse-dot" style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: '#10b981', display: 'inline-block' }} />
                        <span style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Live Occupancy</span>
                      </div>
                      {ageStr && <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }}>{ageStr}</span>}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginBottom: '6px' }}>
                      <span style={{ fontSize: 'var(--t-display)', fontWeight: '600', color: 'var(--text-primary)', letterSpacing: '-0.5px', lineHeight: 1 }}>~{sd.thermal_headcount}</span>
                      {/* "in view", not "right now": the count is one doorway
                          camera's field of view, uncalibrated against the
                          room. Same honesty rule as the noise band below,
                          and the same words the sensor's own display uses. */}
                      <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>people in view</span>
                    </div>

                    {/* The band, and only the band. The figure that used to sit
                        beside it read "72 dB", but no microphone in this project
                        has ever been calibrated against a sound meter, so what
                        the sensor reports is a relative index and printing it
                        with a real unit was a measurement the build cannot make
                        (DESIGN-STANDARD rule 5). The word is what the reading can
                        honestly support, and it is also the only part anybody
                        was going to act on. The sensor's own display says
                        "level" for the same reason. */}
                    {noiseLabel && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px' }}>
                        <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: noiseLabel.color }} />
                        <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: noiseLabel.ink }}>{noiseLabel.text}</span>
                      </div>
                    )}

                    <div>
                      <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-tertiary)', margin: '0 0 4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Last 12 Hours</p>
                      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '36px' }}>
                        {slots.map((s, i) => {
                          const val = s.reading?.thermal_headcount;
                          if (val == null) {
                            return <div key={i} style={{ flex: 1, height: '4px', background: 'repeating-linear-gradient(45deg, var(--border-subtle), var(--border-subtle) 2px, transparent 2px, transparent 4px)', borderRadius: '2px', opacity: 0.5 }} />;
                          }
                          const h = Math.max(2, Math.round((val / maxHeads) * 32));
                          return <div key={i} style={{ flex: 1, height: `${h}px`, borderRadius: '2px', backgroundColor: colors.navy, opacity: 0.85 }} />;
                        })}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                        <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }}>{slots[0].hour === 0 ? '12 AM' : slots[0].hour < 12 ? `${slots[0].hour} AM` : slots[0].hour === 12 ? '12 PM' : `${slots[0].hour - 12} PM`}</span>
                        <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }}>now</span>
                      </div>
                    </div>

                    {sensorData.recent_checkins > 0 && (
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '10px 0 0' }}>
                        {sensorData.recent_checkins} check-in{sensorData.recent_checkins === 1 ? '' : 's'} in the last hour
                      </p>
                    )}
                  </m.div>
                );
              })()}

              {/* Consumer actions. Never rendered on the owner's map view:
                  a venue account starting a flock or checking in would
                  either dead-end into consumer-only screens or write
                  user-shaped signals a venue must not write. */}
              {!venueOwnerView && (
              <m.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.1, type: 'spring', damping: 20, stiffness: 280 }} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {pickingVenueForCreate ? (
                  <button onClick={(e) => {
                    confirmClick(e);
                    const venueData = { ...activeVenue, addr: activeVenue.addr || activeVenue.formatted_address, lat: activeVenue.location?.latitude, lng: activeVenue.location?.longitude };
                    if (pickingVenueForDm) {
                      const v = { name: venueData.name, addr: venueData.addr, place_id: venueData.place_id, rating: venueData.stars || venueData.rating, photo_url: venueData.photo_url };
                      pinDmVenueNow(selectedDmId, v);
                      setActiveVenue(null);
                      setPickingVenueForCreate(false);
                      setPickingVenueForDm(false);
                      setCurrentTab('chat');
                      setCurrentScreen('dmDetail');
                    } else if (pickingVenueForFlockId) {
                      updateFlockVenue(pickingVenueForFlockId, venueData);
                      setActiveVenue(null);
                      setPickingVenueForCreate(false);
                      setSelectedFlockId(pickingVenueForFlockId);
                      setPickingVenueForFlockId(null);
                      setCurrentTab('chat');
                      setCurrentScreen('chatDetail');
                    } else {
                      setSelectedVenueForCreate(venueData);
                      setActiveVenue(null);
                      setPickingVenueForCreate(false);
                      setCurrentScreen('create');
                    }
                  }} className="hit44 glass-btn glass-primary" style={{ width: '100%', padding: '9px', borderRadius: '10px', border: 'none', backgroundColor: colors.steel, color: 'white', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>{Icons.check('white', 14)} Select Venue</button>
                ) : venueDetailReturnTo ? (
                  /* BACK TO CHAT IS NAVIGATION, SO IT IS DRAWN AS NAVIGATION.
                     It used to be the loudest thing on this sheet: full width,
                     14px padding, 12px radius, --t-body type and a 16px arrow,
                     all in solid navy, which made a roughly 48px slab sitting
                     directly on top of a 10px outlined "Check In". On device
                     that read as far too big, and the size was the smaller
                     half of the problem: this control only undoes the tap that
                     opened the sheet, and it was shouting over the one action a
                     person standing outside the venue actually came to press.
                     Weight follows consequence, so it now wears exactly the
                     "Details" treatment two rows down (10px padding, 10px
                     radius, --t-meta, 1.5px hairline, 14px glyph). Nothing here
                     invents a size. .hit44 still lays a 44x44 target over it, so
                     the smaller paint costs no reachability, which is the whole
                     reason that class exists. */
                  <button onClick={() => {
                    setVenueDetailHistory([]);
                    const ret = venueDetailReturnTo;
                    setVenueDetailReturnTo(null);
                    setActiveVenue(null);
                    setCurrentTab(ret.tab);
                    setCurrentScreen(ret.screen);
                    if (ret.flockId) setSelectedFlockId(ret.flockId);
                    if (ret.dmId) setSelectedDmId(ret.dmId);
                  }} className="hit44 glass-btn glass-secondary" style={{ width: '100%', padding: '10px', borderRadius: '10px', border: '1.5px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-secondary)', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>{Icons.arrowLeft('var(--text-secondary)', 14)} Back to Chat</button>
                ) : (
                  <button className="hit44 glass-btn glass-navy" onClick={(e) => { confirmClick(e); setSelectedVenueForCreate({ ...activeVenue, addr: activeVenue.addr || activeVenue.formatted_address, lat: activeVenue.location?.latitude, lng: activeVenue.location?.longitude }); setActiveVenue(null); setCurrentScreen('create'); }} style={{ width: '100%', padding: '10px', borderRadius: '10px', border: 'none', background: colors.navyBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer', textAlign: 'center' }}>Start Flock Here</button>
                )}
                {activeVenue.place_id && (() => {
                  const lastCheckin = lastCheckinAt(activeVenue.place_id);
                  const checkedIn = !!lastCheckin && (Date.now() - lastCheckin < 2 * 60 * 60 * 1000);
                  const label = checkinJustSaved ? 'Checked In ✓' : checkedIn ? 'Checked In ✓' : 'Check In';
                  const disabled = checkedIn || checkinSaving;
                  // EXACTLY ONE FILLED BUTTON IN THIS STACK, AND IT IS THE ONE
                  // THAT DOES SOMETHING. The slot above renders a solid navy
                  // primary in two of its three branches ("Select Venue" while
                  // picking, "Start Flock Here" by default), and in those cases
                  // Check In is correctly the quieter of the two. The third
                  // branch is the one you reach by tapping a venue card in a
                  // chat: venueDetailReturnTo is set, the venue is already the
                  // plan's venue so there is nothing to start, and the slot
                  // holds a back button. That branch used to leave the sheet
                  // with its heaviest paint on the control that just retraces
                  // your last tap, and its real action outlined underneath.
                  // So when the slot above is carrying navigation rather than
                  // an action, Check In takes the primary paint. Same box as
                  // before, only the fill changes, because the geometry here is
                  // already the one "Start Flock Here" uses and re-sizing a
                  // device-tested button to signal priority is how the mess
                  // above got started. Disabled stays muted: "Checked In" is a
                  // receipt, not an invitation, and a filled slab you cannot
                  // press is worse than a quiet one.
                  const isTopAction = !pickingVenueForCreate && !!venueDetailReturnTo && !disabled;
                  return (
                    <button className={isTopAction ? 'hit44 glass-btn glass-navy' : 'hit44'}
                      onClick={() => handleCheckIn(activeVenue.place_id)}
                      disabled={disabled}
                      style={{
                        width: '100%',
                        padding: '10px',
                        borderRadius: '10px',
                        border: isTopAction ? 'none' : '1.5px solid var(--border-default)',
                        backgroundColor: isTopAction ? colors.navyBg : disabled ? 'var(--bg-tertiary)' : 'var(--bg-card-solid)',
                        color: isTopAction ? 'white' : disabled ? 'var(--text-tertiary)' : colors.navy,
                        cursor: disabled ? 'default' : 'pointer',
                        fontWeight: '600',
                        fontSize: 'var(--t-meta)',
                        opacity: checkinSaving ? 0.6 : 1,
                        transition: 'opacity 0.3s ease, background-color 0.2s ease',
                      }}
                    >
                      {checkinSaving ? 'Checking in...' : label}
                    </button>
                  );
                })()}
                <div style={{ display: 'flex', gap: '8px' }}>
                  {activeVenue.place_id && (
                    <button className="hit44 glass-btn glass-secondary" onClick={() => { openVenueDetail(activeVenue.place_id, { name: activeVenue.name, formatted_address: activeVenue.addr, place_id: activeVenue.place_id, rating: activeVenue.stars, photo_url: activeVenue.photo_url }); }} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: '1.5px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontSize: 'var(--t-meta)', fontWeight: '600', color: 'var(--text-secondary)' }}>{Icons.eye('var(--text-secondary)', 14)} Details</button>
                  )}
                  {/* No "Add to Calendar" here. It saved "Visit <venue>" for today at
                      8 PM whatever the plan, which is a calendar entry nobody made.
                      The plan path is the button above: start a flock here, and
                      the flock's real time lands on the calendar by itself. */}
                </div>
              </m.div>
              )}
            </div>
          </m.div>
    );
}
