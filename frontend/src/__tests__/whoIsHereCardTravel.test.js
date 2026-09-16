/**
 * WHO IS HERE, THE LINES UNDER THE SENTENCE.
 *
 * "2 on the way" is a count the parent derives from positions. "Sam · about
 * 8 min · driving, 2 seats" is a person who said so, and the card prints one
 * line per such person from a `travellers` prop the parent has already turned
 * into words (lib/travel.js does the arithmetic, ChatDetail builds the
 * entries, this card renders them). What this pins is the wording of those
 * lines and the two rules that keep them honest: the list never speaks for
 * somebody who said nothing, and the counts still decide whether there is a
 * card at all.
 *
 * These are real renders. The card is presentational and takes its whole
 * world as props, so there is nothing to scan for; the parent-side rules
 * (who is in the list, the freshness window, the viewer skipped) live in
 * whoIsHereWiring, which reads ChatDetail's source.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false whoIsHereCardTravel
 */

import React from 'react';
import { render, screen } from '@testing-library/react';

import WhoIsHereCard from '../components/chat/cards/WhoIsHereCard';

// The list is the group labelled "On the way"; a line is the truncating span
// inside it, and its textContent is the whole line including the name, which
// the card draws as a nested span. A getByText on the line would see only the
// text after the name (testing-library matches direct text nodes), so the
// lines are read whole here instead.
const list = () => screen.queryByRole('group', { name: 'On the way' });
const lines = () => Array.from(list().querySelectorAll('.chat-truncate')).map((el) => el.textContent);

const base = { venueName: 'Kome', nearCount: 3, onTheWayCount: 2, members: [] };

describe('one line per traveller, in the words the parent supplied', () => {
  test('a driver with spare seats: name, ETA, mode, seats', () => {
    render(<WhoIsHereCard
      {...base}
      travellers={[{ id: 4, name: 'Sam', intent: 'omw', mode: 'drive', seats: 2, distanceKm: 3.2, etaLabel: 'about 8 min', distanceLabel: '3.2 km away' }]}
    />);
    expect(lines()).toEqual(['Sam · about 8 min · driving, 2 seats']);
    // The avatar carries the on-the-way badge in its accessible name, the way
    // the strip above the sentence does.
    expect(screen.getByRole('img', { name: 'Sam, on the way' })).toBeTruthy();
  });

  test('one seat is one seat', () => {
    render(<WhoIsHereCard
      {...base}
      travellers={[{ id: 4, name: 'Sam', intent: 'omw', mode: 'drive', seats: 1, distanceKm: 3.2, etaLabel: 'about 8 min', distanceLabel: '3.2 km away' }]}
    />);
    expect(lines()).toEqual(['Sam · about 8 min · driving, 1 seat']);
  });

  test('a car with no spare seats says driving and stops', () => {
    // "0 seats" reads as an offer withdrawn, and no offer was made.
    render(<WhoIsHereCard
      {...base}
      travellers={[{ id: 4, name: 'Sam', intent: 'omw', mode: 'drive', seats: 0, distanceKm: 3.2, etaLabel: 'about 8 min', distanceLabel: '3.2 km away' }]}
    />);
    expect(lines()).toEqual(['Sam · about 8 min · driving']);
  });

  test('a walker with an ETA reads the minutes and "walking"', () => {
    render(<WhoIsHereCard
      {...base}
      travellers={[{ id: 5, name: 'Joy', intent: 'omw', mode: 'walk', distanceKm: 0.6, etaLabel: 'about 10 min', distanceLabel: '600 m away' }]}
    />);
    expect(lines()).toEqual(['Joy · about 10 min · walking']);
    // Seats belong to a car. A walker never gets a seat count, whatever the
    // entry happens to carry.
    expect(lines()[0]).not.toMatch(/seat/);
  });

  test('no mode means a distance and no minutes', () => {
    // With no mode there is no speed, so the parent sends a null ETA and the
    // card shows how far off they are rather than inventing a time.
    render(<WhoIsHereCard
      {...base}
      travellers={[{ id: 5, name: 'Joy', intent: 'omw', distanceKm: 2.1, etaLabel: null, distanceLabel: '2.1 km away' }]}
    />);
    expect(lines()).toEqual(['Joy · 2.1 km away']);
    expect(lines()[0]).not.toMatch(/min/);
  });

  test('no position at all still names the person as on the way', () => {
    render(<WhoIsHereCard
      {...base}
      travellers={[{ id: 5, name: 'Joy', intent: 'omw', mode: 'transit', distanceKm: null, etaLabel: null, distanceLabel: null }]}
    />);
    expect(lines()).toEqual(['Joy · on the way · on transit']);
  });

  test('needing a ride reads the ask, then how far off they are', () => {
    render(<WhoIsHereCard
      {...base}
      travellers={[{ id: 6, name: 'Ava', intent: 'need_ride', distanceKm: 1.4, etaLabel: null, distanceLabel: '1.4 km away' }]}
    />);
    expect(lines()).toEqual(['Ava · needs a ride · 1.4 km away']);
  });

  test('needing a ride with no position is just the ask', () => {
    render(<WhoIsHereCard
      {...base}
      travellers={[{ id: 6, name: 'Ava', intent: 'need_ride', distanceKm: null, etaLabel: null, distanceLabel: null }]}
    />);
    expect(lines()).toEqual(['Ava · needs a ride']);
  });

  test('several travellers are several lines, in the order given', () => {
    render(<WhoIsHereCard
      {...base}
      travellers={[
        { id: 4, name: 'Sam', intent: 'omw', mode: 'drive', seats: 2, distanceKm: 3.2, etaLabel: 'about 8 min', distanceLabel: '3.2 km away' },
        { id: 6, name: 'Ava', intent: 'need_ride', distanceKm: 1.4, etaLabel: null, distanceLabel: '1.4 km away' },
      ]}
    />);
    expect(lines()).toEqual([
      'Sam · about 8 min · driving, 2 seats',
      'Ava · needs a ride · 1.4 km away',
    ]);
  });
});

describe('the rules that keep the list honest', () => {
  test('an empty list renders no list', () => {
    render(<WhoIsHereCard {...base} travellers={[]} />);
    expect(list()).toBeNull();
    expect(screen.getByText('3 near Kome, 2 on the way')).toBeTruthy();
  });

  test('the prop is optional and the card is unchanged without it', () => {
    render(<WhoIsHereCard {...base} />);
    expect(list()).toBeNull();
    expect(screen.getByText('3 near Kome, 2 on the way')).toBeTruthy();
  });

  test('the sentence is built from the counts, not from the list', () => {
    // Two travellers, but the parent counted five on the way: three of them
    // are plain shares with no intent, counted and not listed. The sentence
    // reads the count.
    render(<WhoIsHereCard
      venueName="Kome"
      nearCount={1}
      onTheWayCount={5}
      members={[]}
      travellers={[
        { id: 4, name: 'Sam', intent: 'omw', mode: 'drive', seats: 2, distanceKm: 3.2, etaLabel: 'about 8 min', distanceLabel: '3.2 km away' },
        { id: 5, name: 'Joy', intent: 'omw', mode: 'walk', distanceKm: 0.6, etaLabel: 'about 10 min', distanceLabel: '600 m away' },
      ]}
    />);
    expect(screen.getByText('1 near Kome, 5 on the way')).toBeTruthy();
    expect(lines()).toHaveLength(2);
  });

  test('zero and zero renders nothing, whatever the list holds', () => {
    // The counts are the parent's truth. A list under a sentence that says
    // nobody is moving is two props disagreeing, and the numbers win.
    const { container } = render(<WhoIsHereCard
      venueName="Kome"
      nearCount={0}
      onTheWayCount={0}
      members={[]}
      travellers={[{ id: 4, name: 'Sam', intent: 'omw', mode: 'drive', seats: 2, distanceKm: 3.2, etaLabel: 'about 8 min', distanceLabel: '3.2 km away' }]}
    />);
    expect(container.firstChild).toBeNull();
  });

  test('the avatar strip and the map tap are unchanged with a list present', () => {
    const onOpenMap = jest.fn();
    render(<WhoIsHereCard
      {...base}
      members={[{ id: 1, name: 'Maya', status: 'near' }, { id: 4, name: 'Sam', status: 'onTheWay' }]}
      onOpenMap={onOpenMap}
      travellers={[{ id: 4, name: 'Sam', intent: 'omw', mode: 'drive', seats: 2, distanceKm: 3.2, etaLabel: 'about 8 min', distanceLabel: '3.2 km away' }]}
    />);
    expect(screen.getByRole('img', { name: 'Maya, nearby' })).toBeTruthy();
    // Sam is in the strip and in the list, and both avatars say the same thing.
    expect(screen.getAllByRole('img', { name: 'Sam, on the way' })).toHaveLength(2);
    // Still one tap target, the whole card.
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '3 near Kome, 2 on the way. Open the map.' })).toBeTruthy();
  });
});
