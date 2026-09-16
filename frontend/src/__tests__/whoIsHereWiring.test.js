/**
 * WHO IS HERE. One card a night, updated in place.
 *
 * WhoIsHereCard was built, tested and exported and nothing imported it.
 * Member positions have existed since the map was built and the chat said
 * nothing about them: somebody sharing a location showed up on a screen the
 * reader had to LEAVE the conversation to see, while the chat header counted
 * "N sharing" and stopped there. The positions were in this screen's props the
 * whole time.
 *
 * The card takes counts and refuses to draw when both are zero. Turning
 * positions into "near" and "on the way" is the parent's job, and it is where
 * every way of lying about where people are lives, so that is what this pins.
 */

const React = require('react');
const { render, screen } = require('@testing-library/react');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

const appSrc = read('App.js');
const chatDetailSrc = read('screens', 'ChatDetail.js');
const WhoIsHereCard = require('../components/chat/cards/WhoIsHereCard').default;

const derivation = (() => {
  const at = chatDetailSrc.indexOf('const whoIsHere = (() => {');
  expect(at).toBeGreaterThan(-1);
  return chatDetailSrc.slice(at, chatDetailSrc.indexOf('const nudgeKey', at));
})();

describe('the distance question is asked once, with a number', () => {
  test('App.js exposes a NUMERIC haversine under the display formatter', () => {
    /* calcDistance returned a formatted string ("350m"), so nothing could
       COMPARE two distances. A second copy of the arithmetic somewhere else is
       how two surfaces come to disagree about what "near" means, so the
       formatter is now built on the number rather than beside it. */
    expect(appSrc).toMatch(/const distanceKm = useCallback\(/);
    expect(appSrc).toMatch(/const d = distanceKm\(lat1, lng1, lat2, lng2\);/);
    const haversines = appSrc.match(/Math\.atan2\(Math\.sqrt\(a\), Math\.sqrt\(1 - a\)\)/g) || [];
    expect(haversines).toHaveLength(1);
  });

  test('the card asks with that number, not with a parsed string', () => {
    expect(derivation).toMatch(/distanceKm\(Number\(loc\.lat\), Number\(loc\.lng\), Number\(flock\.venueLat\), Number\(flock\.venueLng\)\) <= AT_VENUE_KM/);
  });
});

describe('the ways this could lie about where people are', () => {
  test('a stale position is not counted', () => {
    /* A fix from forty minutes ago is not where somebody is, and a card built
       on it is the app claiming to know where people are while knowing
       nothing, which is exactly what the component refuses to render for. */
    expect(chatDetailSrc).toMatch(/const POSITION_FRESH_MS = 10 \* 60 \* 1000;/);
    expect(derivation).toMatch(/nowMs - at > POSITION_FRESH_MS\) continue;/);
    // A position with no timestamp at all is not fresh either.
    expect(derivation).toMatch(/if \(!Number\.isFinite\(at\)/);
  });

  test('the window keeps moving in a quiet chat', () => {
    /* The row array is remembered between renders with a clock as one of its
       inputs, and a clock read during render is only ever compared by a
       render something else caused. In a chat where nothing arrived, the card
       outlived its fix until somebody typed. So the clock is state, ticked by
       an interval that runs only while there is a position to go stale. */
    expect(chatDetailSrc).toMatch(/const \[positionClock, setPositionClock\] = React\.useState\(0\);/);
    expect(chatDetailSrc).toMatch(/setInterval\(\(\) => setPositionClock\(Math\.floor\(Date\.now\(\) \/ POSITION_CLOCK_MS\)\), POSITION_CLOCK_MS\)/);
    expect(chatDetailSrc).not.toMatch(/const positionClock = Object\.keys/);
    // And it is still what the row cache is remembered against.
    expect(chatDetailSrc).toMatch(/\n {6}positionClock,\n/);
  });

  test('a position with no usable coordinates is not counted', () => {
    expect(derivation).toMatch(/!Number\.isFinite\(Number\(loc\.lat\)\) \|\| !Number\.isFinite\(Number\(loc\.lng\)\)\) continue;/);
  });

  test('the viewer is not counted', () => {
    // "3 near Kome" meaning two other people and yourself reads as a bigger
    // group than there is, and you already know where you are.
    expect(derivation).toMatch(/if \(String\(uid\) === String\(authUser\?\.id\)\) continue;/);
  });

  test('nobody is "near" a venue the group has not picked', () => {
    // People are still moving toward each other, so "2 on the way" is true and
    // is what the card says. Naming a venue nobody chose would not be.
    expect(derivation).toMatch(/const hasVenue = Number\.isFinite\(Number\(flock\.venueLat\)\)/);
    expect(derivation).toMatch(/const isNear = hasVenue/);
    // `who` is the row's own copy of whoIsHere: the renderer reads the row it
    // is handed, never the screen (see nudgeRowWiring, "the row carries its
    // own card").
    expect(chatDetailSrc).toMatch(/venueName=\{who\.hasVenue \? \(flock\.venue && flock\.venue !== 'TBD' \? flock\.venue : null\) : null\}/);
  });

  test('nothing to report means no card at all', () => {
    expect(derivation).toMatch(/return \(near === 0 && onTheWay === 0\) \? null : /);
    expect(chatDetailSrc).toMatch(/if \(whoIsHere\) \{/);
  });
});

describe('the radius', () => {
  test('200m, and it is written down with its reason', () => {
    /* A phone indoors behind a bar's walls drifts, and a card that flipped
       somebody from "near" to "on the way" because they walked to the back is
       worse than one that is slightly generous. */
    expect(chatDetailSrc).toMatch(/const AT_VENUE_KM = 0\.2;/);
    const note = chatDetailSrc.slice(
      chatDetailSrc.indexOf('WHAT COUNTS AS "AT THE VENUE"'),
      chatDetailSrc.indexOf('const AT_VENUE_KM')
    );
    expect(note).toMatch(/drifts/);
  });
});

describe('where it sits', () => {
  test('it lands on the end, like the nudge and unlike the poll', () => {
    // The state of the room right now, not a moment in the scrollback.
    expect(chatDetailSrc).toMatch(/spliceByTime\(streamRows, \{ id: WHO_ROW_ID, message_type: 'system', who: whoIsHere \}, NaN\)/);
  });

  test('it passes the server-authored gate like every other synthetic row', () => {
    expect(chatDetailSrc).toMatch(/\{ id: WHO_ROW_ID, message_type: 'system', who: whoIsHere \}/);
    expect(chatDetailSrc).toMatch(/if \(m\.message_type === 'system' && m\.system_kind\) \{/);
  });
});

describe('the card itself', () => {
  test('it reads as one sentence and drops a zero clause', () => {
    render(React.createElement(WhoIsHereCard, {
      venueName: 'Kome', nearCount: 5, onTheWayCount: 0, members: [],
    }));
    expect(screen.getByText(/5 near Kome/)).toBeInTheDocument();
    expect(screen.queryByText(/0 on the way/)).not.toBeInTheDocument();
  });

  test('with no venue it says nearby rather than naming one', () => {
    render(React.createElement(WhoIsHereCard, {
      venueName: null, nearCount: 3, onTheWayCount: 2, members: [],
    }));
    expect(screen.getByText(/3 nearby/)).toBeInTheDocument();
  });

  test('nothing to report renders nothing', () => {
    const { container } = render(React.createElement(WhoIsHereCard, {
      venueName: 'Kome', nearCount: 0, onTheWayCount: 0, members: [],
    }));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('on my way', () => {
  /* The card's one line grew a second: a person who said what they are doing
     is named with an ETA. Everything that could make that line lie is pinned
     here, beside the counts it extends. */
  const nearBranch = derivation.slice(derivation.indexOf('if (isNear) {'), derivation.indexOf('} else {'));
  const onTheWayBranch = derivation.slice(derivation.indexOf('} else {'), derivation.indexOf('return (near === 0'));

  test('a traveller is a fresh, on-the-way position that carries an intent', () => {
    /* A packet with no intent is the plain share every packet used to be,
       and stays a count. The list is built inside the same loop, past every
       guard the counts pass through, so nothing stale, blank, foreign or the
       viewer's own can reach it. */
    expect(derivation).toMatch(/const travellers = \[\];/);
    expect(onTheWayBranch).toMatch(/onTheWay \+= 1;/);
    expect(onTheWayBranch).toMatch(/if \(loc\.intent === 'omw' \|\| loc\.intent === 'need_ride'\) \{/);
    expect(onTheWayBranch).toMatch(/travellers\.push\(\{/);
    expect(onTheWayBranch).toMatch(/intent: loc\.intent,/);
    // Seats ride only with a car, the rule the wire applies.
    expect(onTheWayBranch).toMatch(/seats: loc\.mode === 'drive' \? loc\.seats : undefined,/);
  });

  test('a near person is never a traveller', () => {
    /* Somebody inside the radius has arrived whatever their packet still
       says. "Sam, about 2 min" beside "1 near Kome" is the card contradicting
       itself. */
    expect(nearBranch).toMatch(/nearPeople\.push\(/);
    expect(nearBranch).not.toMatch(/travellers\.push\(/);
    expect(nearBranch).not.toMatch(/loc\.intent/);
  });

  test('the ETA is the labelled estimate, measured to the venue, and null without one', () => {
    /* No routing call, on purpose (lib/travel.js says why). The distance is
       the haversine isNear asks, against the venue the group picked, so with
       no venue there is no distance and no time rather than a number toward
       nowhere; with no mode there is a distance and no time, because a time
       needs a speed. */
    expect(chatDetailSrc).toMatch(/import \{ MAX_SEATS, etaMinutes, formatDistance, formatEta \} from '\.\.\/lib\/travel';/);
    expect(onTheWayBranch).toMatch(/const km = hasVenue\n\s+\? distanceKm\(Number\(loc\.lat\), Number\(loc\.lng\), Number\(flock\.venueLat\), Number\(flock\.venueLng\)\)\n\s+: null;/);
    expect(onTheWayBranch).toMatch(/distanceKm: km,/);
    expect(onTheWayBranch).toMatch(/etaLabel: formatEta\(etaMinutes\(km, loc\.mode\)\),/);
    expect(onTheWayBranch).toMatch(/distanceLabel: formatDistance\(km\),/);
  });

  test('the card is handed the list off the row, beside the counts', () => {
    expect(derivation).toMatch(/return \(near === 0 && onTheWay === 0\) \? null : \{ near, onTheWay, people: nearPeople, hasVenue, travellers \};/);
    expect(chatDetailSrc).toMatch(/travellers=\{who\.travellers\}/);
  });

  test('the two sheet tiles start the share with an intent, behind the share\'s own gate', () => {
    /* The same call as Share location, with a travel state on it. Both tiles
       go away while a share is already running, the way Share does, and both
       refuse with the same toast when there is nobody to tell. */
    const handler = (name, call) => new RegExp(
      `${name}=\\{sharingLocationForFlock === flock\\.id \\? undefined : \\(\\) => \\{\\n\\s+if \\(!readyToShare\\(\\)\\) return;\\n\\s+${call}`
    );
    expect(chatDetailSrc).toMatch(handler('onShareLocation', "startSharingLocation\\(flock\\.id\\);"));
    expect(chatDetailSrc).toMatch(handler('onOnMyWay', "startSharingLocation\\(flock\\.id, \\{ intent: 'omw' \\}\\);"));
    expect(chatDetailSrc).toMatch(handler('onNeedRide', "startSharingLocation\\(flock\\.id, \\{ intent: 'need_ride' \\}\\);"));
    const gate = chatDetailSrc.slice(chatDetailSrc.indexOf('const readyToShare = () => {'), chatDetailSrc.indexOf('const pinnedForBar'));
    expect(gate).toMatch(/setPlusOpen\(false\);/);
    expect(gate).toMatch(/if \(otherMembers === 0\) \{ showToast\('No one else in this flock to share with', 'error'\); return false; \}/);
  });

  test('the bar upgrades a running share in place, and every tap re-emits', () => {
    /* The chips and the stepper go through updateTravel, which App.js emits
       at once rather than on the next ten-second tick. A plain share offers
       "On my way"; said, it asks how; a car is asked for seats, bounded by
       the wire's ceiling; and a ride request can switch to travelling. */
    const bar = chatDetailSrc.slice(chatDetailSrc.indexOf('Sharing location with {flock.name}'), chatDetailSrc.indexOf('{/* Budget status bar */}'));
    expect(bar).toMatch(/\{!myTravel\?\.intent && \(/);
    expect(bar).toMatch(/onClick=\{\(\) => updateTravel\(\{ intent: 'omw' \}\)\}[^>]*>On my way<\/button>/);
    expect(bar).toMatch(/\{myTravel\?\.intent === 'omw' && \(/);
    expect(bar).toMatch(/TRAVEL_MODE_CHIPS\.map\(\(\{ mode, label \}\) => \(/);
    expect(bar).toMatch(/aria-pressed=\{myTravel\.mode === mode\} onClick=\{\(\) => updateTravel\(\{ \.\.\.myTravel, mode \}\)\}/);
    expect(bar).toMatch(/\{myTravel\.mode === 'drive' && \(/);
    expect(bar).toMatch(/updateTravel\(\{ \.\.\.myTravel, mode: 'drive', seats: Math\.max\(0, mySeats - 1\) \}\)/);
    expect(bar).toMatch(/updateTravel\(\{ \.\.\.myTravel, mode: 'drive', seats: Math\.min\(MAX_SEATS, mySeats \+ 1\) \}\)/);
    expect(bar).toMatch(/\{myTravel\?\.intent === 'need_ride' && \(/);
    expect(bar).toMatch(/Looking for a ride/);
    expect(bar).toMatch(/updateTravel\(\{ \.\.\.myTravel, intent: 'omw' \}\)[^>]*>I'm on my way instead<\/button>/);
    // The three modes the wire accepts, and no fourth.
    const chips = chatDetailSrc.slice(chatDetailSrc.indexOf('const TRAVEL_MODE_CHIPS = Object.freeze(['), chatDetailSrc.indexOf('const travelChipStyle'));
    expect(chips.match(/\{ mode: '(walk|drive|transit)', label: '[A-Z][a-z]+' \}/g)).toHaveLength(3);
    expect(chips.match(/\{ mode: /g)).toHaveLength(3);
  });
});
