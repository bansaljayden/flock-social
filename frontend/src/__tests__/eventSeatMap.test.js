/**
 * THE SEAT MAP SECTION GOES WITH ITS IMAGE.
 *
 * backend/routes/events.js passes Ticketmaster's seatmap.staticUrl through as
 * seatmap_url, and the event detail overlay puts it straight into an img under
 * a "Seat Map" heading. An image the content policy refuses, or a dead link,
 * fires error, and the handler hid only the img: the heading stayed over an
 * empty space. Rendered here with the real component.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test eventSeatMap --watchAll=false
 */
const React = require('react');
const { render, screen, fireEvent } = require('@testing-library/react');

const EventDetailOverlay = require('../components/EventDetailOverlay').default;

const props = (eventDetail) => ({
  DialogBehavior: () => null,
  colors: { navy: '#14213d', navyBg: '#14213d' },
  fmtMoney: (n) => `$${n}`,
  httpUrl: (u) => u,
  openExternal: () => {},
  eventDetail,
  eventDetailError: '',
  eventDetailLoading: false,
  setCurrentScreen: () => {},
  setEventDetail: () => {},
  setEventDetailError: () => {},
  setEventDetailLoading: () => {},
  setSelectedVenueForCreate: () => {},
  setShowEventsView: () => {},
  userLocation: null,
});

const EVENT = { id: 'E1', name: 'A show', seatmap_url: 'https://seatmaps.test/one.png' };

test('a seat map that loads shows under its heading', () => {
  render(React.createElement(EventDetailOverlay, props(EVENT)));
  fireEvent.load(screen.getByAltText('Seat map'));
  expect(screen.getByText('Seat Map')).toBeVisible();
  expect(screen.getByAltText('Seat map')).toBeVisible();
});

test('a seat map that does not load takes its heading with it', () => {
  render(React.createElement(EventDetailOverlay, props(EVENT)));
  fireEvent.error(screen.getByAltText('Seat map'));
  expect(screen.getByText('Seat Map')).not.toBeVisible();
  expect(screen.getByAltText('Seat map')).not.toBeVisible();
});

test('another seat map starts out shown after one failed', () => {
  const { rerender } = render(React.createElement(EventDetailOverlay, props(EVENT)));
  fireEvent.error(screen.getByAltText('Seat map'));
  rerender(React.createElement(EventDetailOverlay, props({ ...EVENT, seatmap_url: 'https://seatmaps.test/two.png' })));
  expect(screen.getByText('Seat Map')).toBeVisible();
});

test('no seat map, no section', () => {
  render(React.createElement(EventDetailOverlay, props({ id: 'E2', name: 'Another show' })));
  expect(screen.queryByText('Seat Map')).toBeNull();
});
