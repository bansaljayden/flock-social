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
