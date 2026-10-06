/**
 * How far an event is, and whose clock its time is on (lib/eventWhereWhen.js),
 * on the Discover events card and the event detail screen.
 *
 * WHAT WAS WRONG (2026-10-06)
 *
 *   * The detail screen showed `distance_miles` from the server. The server
 *     caches events per 0.1-degree cell and had asked Ticketmaster at the
 *     exact point of whoever missed that cache first, so the number was that
 *     person's distance, up to about 14 km off for everyone else, under a card
 *     that worked out its own and said something different.
 *   * The card printed the venue's wall-clock time with no zone, while Start
 *     Flock printed the same moment on the device's clock, so a viewer two
 *     zones away read 7:00 PM on one and 9:00 PM on the other.
 *
 * Both surfaces now measure from the viewer with one function, and the time
 * carries the venue's zone exactly when the two clocks differ.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react');

// CRA's jest config ships resetMocks: true, so behaviour is set per test.
jest.mock('../services/api', () => ({
  getEventDetails: jest.fn(),
}));

const { getEventDetails } = require('../services/api');
const {
  eventDistanceKm, formatEventDistance, eventTimeZoneLabel,
} = require('../lib/eventWhereWhen');
const EventDetailOverlay = require('../components/EventDetailOverlay').default;

// The fixture backend/__tests__/eventsResilience.test.js uses: a 7 PM show at
// Red Rocks, whose UTC instant is already the next day.
const DENVER_SHOW = {
  id: 'G5vYZ9j3fV4Ay',
  name: 'Test Show',
  category: 'concert',
  date: '2026-08-20',
  time: '19:00:00',
  datetime_utc: '2026-08-21T01:00:00Z',
  timezone: 'America/Denver',
  venue_name: 'Red Rocks',
  location: { latitude: 39.6654, longitude: -105.2057 },
};

// ===========================================================================
// The distance
// ===========================================================================

describe('the distance is from the viewer', () => {
  it('is the great-circle distance, in kilometres', () => {
    // One degree of latitude is 6371 * pi / 180 = 111.19 km, worked out
    // here without the function under test.
    const event = { location: { latitude: 1, longitude: 0 } };
    expect(eventDistanceKm(event, { lat: 0, lng: 0 })).toBeCloseTo(111.19, 2);
    expect(eventDistanceKm(event, { lat: 1, lng: 0 })).toBe(0);
  });

  it('is nothing when either end is unknown, never a distance from 0,0', () => {
    const event = { location: { latitude: 39.6654, longitude: -105.2057 } };
    expect(eventDistanceKm(event, null)).toBeNull();
    expect(eventDistanceKm(event, { lat: null, lng: null })).toBeNull();
    expect(eventDistanceKm(event, { lat: NaN, lng: -105 })).toBeNull();
    expect(eventDistanceKm({ location: null }, { lat: 39.7, lng: -105 })).toBeNull();
    expect(eventDistanceKm({ location: { latitude: '39.6', longitude: '-105.2' } }, { lat: 39.7, lng: -105 })).toBeNull();
    expect(eventDistanceKm(null, { lat: 39.7, lng: -105 })).toBeNull();
  });

  it("prints the card's own way", () => {
    expect(formatEventDistance(0.8)).toBe('800m');
    expect(formatEventDistance(2.345)).toBe('2.3km');
    expect(formatEventDistance(null)).toBeNull();
    expect(formatEventDistance(NaN)).toBeNull();
  });
});

// ===========================================================================
// The zone
// ===========================================================================

describe("the time says the venue's zone when the clocks differ", () => {
  it('names the zone for a viewer on another clock', () => {
    expect(eventTimeZoneLabel(DENVER_SHOW, 'America/New_York')).toBe('MDT');
    expect(eventTimeZoneLabel(DENVER_SHOW, 'America/Los_Angeles')).toBe('MDT');
    // Arizona keeps standard time all year, so in August it is an hour behind
    // Denver even though both are "Mountain".
    expect(eventTimeZoneLabel(DENVER_SHOW, 'America/Phoenix')).toBe('MDT');
  });

  it('says nothing when the clocks agree, whatever the zone is called', () => {
    expect(eventTimeZoneLabel(DENVER_SHOW, 'America/Denver')).toBeNull();
    // Another zone name on the same clock at that moment.
    expect(eventTimeZoneLabel(DENVER_SHOW, 'America/Boise')).toBeNull();
  });

  it('falls back to the offset the printed time implies', () => {
    // A cached answer from before listed events carried their zone.
    const { timezone, ...unnamed } = DENVER_SHOW;
    expect(timezone).toBe('America/Denver');
    expect(eventTimeZoneLabel(unnamed, 'America/New_York')).toBe('GMT-6');
    // A zone name that disagrees with the printed clock is not believed: the
    // label has to be true of the time on screen.
    expect(eventTimeZoneLabel({ ...DENVER_SHOW, timezone: 'America/Chicago' }, 'America/New_York')).toBe('GMT-6');
    expect(eventTimeZoneLabel({ ...DENVER_SHOW, timezone: 'Not/AZone' }, 'America/New_York')).toBe('GMT-6');
    // Half-hour zones keep their minutes.
    const kolkata = { date: '2026-08-20', time: '19:30:00', datetime_utc: '2026-08-20T14:00:00Z' };
    expect(eventTimeZoneLabel(kolkata, 'America/New_York')).toBe('GMT+5:30');
  });

  it('says nothing when it cannot know', () => {
    expect(eventTimeZoneLabel({ ...DENVER_SHOW, datetime_utc: null }, 'America/New_York')).toBeNull();
    expect(eventTimeZoneLabel({ ...DENVER_SHOW, datetime_utc: 'soon' }, 'America/New_York')).toBeNull();
    expect(eventTimeZoneLabel({ ...DENVER_SHOW, time: null }, 'America/New_York')).toBeNull();
    expect(eventTimeZoneLabel({ ...DENVER_SHOW, date: '20 Aug' }, 'America/New_York')).toBeNull();
    expect(eventTimeZoneLabel(null, 'America/New_York')).toBeNull();
  });
});

// ===========================================================================
// The detail screen
// ===========================================================================

const DialogBehavior = () => null;
const colors = { navy: '#1f2f45', navyBg: '#1f2f45', steel: '#5b6b7f' };

function renderOverlay(eventDetail, extra = {}) {
  const setEventDetail = jest.fn();
  const utils = render(
    <EventDetailOverlay
      DialogBehavior={DialogBehavior}
      colors={colors}
      fmtMoney={(n) => String(n)}
      httpUrl={() => null}
      openExternal={jest.fn()}
      eventDetail={eventDetail}
      eventDetailError=""
      eventDetailLoading={false}
      setCurrentScreen={jest.fn()}
      setEventDetail={setEventDetail}
      setEventDetailError={jest.fn()}
      setEventDetailLoading={jest.fn()}
      setSelectedVenueForCreate={jest.fn()}
      setShowEventsView={jest.fn()}
      userLocation={{ lat: 0, lng: 0 }}
      {...extra}
    />
  );
  return { ...utils, setEventDetail };
}

// The device clock this test runs on, read the way the app reads it.
const DEVICE_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const AT = '2026-08-21T01:00:00Z';
const localParts = (zone) => {
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(AT)).forEach((p) => { parts[p.type] = p.value; });
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:00` };
};
const printed = (time) => new Date(`2000-01-01T${time}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

describe('the event detail screen', () => {
  it('measures from the viewer, not from whoever asked the server first', () => {
    // A server number from before the fix: 8.7 miles is "14.0 km away".
    const { getByText, queryByText } = renderOverlay({
      ...DENVER_SHOW, location: { latitude: 1, longitude: 0 }, distance_miles: 8.7,
    });
    expect(getByText(/111\.2km away/)).toBeTruthy();
    expect(queryByText(/14\.0 km away/)).toBeNull();
  });

  it('has no distance line without a position for the viewer', () => {
    const { queryByText } = renderOverlay({ ...DENVER_SHOW, distance_miles: 8.7 }, { userLocation: null });
    expect(queryByText(/away/)).toBeNull();
  });

  it("names the venue's zone after the time when its clock is not this device's", () => {
    // A zone whose clock is not the device's at that moment, whichever zone
    // the machine running this is in.
    const venueZone = ['Pacific/Kiritimati', 'Pacific/Pago_Pago']
      .find((z) => localParts(z).time !== localParts(DEVICE_ZONE).time);
    const { date, time } = localParts(venueZone);
    const zoneName = new Intl.DateTimeFormat('en-US', { timeZone: venueZone, timeZoneName: 'short' })
      .formatToParts(new Date(AT)).find((p) => p.type === 'timeZoneName').value;
    const { getByText } = renderOverlay({ ...DENVER_SHOW, date, time, timezone: venueZone });
    expect(getByText(`${printed(time)} ${zoneName}`)).toBeTruthy();
  });

  it("prints the time alone when the venue's clock is this device's", () => {
    const { date, time } = localParts(DEVICE_ZONE);
    const { getByText } = renderOverlay({ ...DENVER_SHOW, date, time, timezone: DEVICE_ZONE });
    expect(getByText(printed(time))).toBeTruthy();
  });

  it("keeps the venue's position when a retried read comes back without one", async () => {
    getEventDetails.mockResolvedValueOnce({ event: { id: DENVER_SHOW.id, info: 'Doors at 6', location: null } });
    const prev = { ...DENVER_SHOW };
    const { getByText, setEventDetail } = renderOverlay(prev, { eventDetailError: 'The rest of this event did not load.' });
    fireEvent.click(getByText('Try again'));
    await waitFor(() => expect(setEventDetail).toHaveBeenCalled());
    const merged = setEventDetail.mock.calls[0][0](prev);
    expect(merged.info).toBe('Doors at 6');
    expect(merged.location).toEqual(DENVER_SHOW.location);
  });
});

// ===========================================================================
// The events card (screens/ExploreScreen.js, read as source: the screen takes
// eighty-odd props and the card is a few lines of it)
// ===========================================================================

describe('the events card', () => {
  const explore = fs.readFileSync(path.join(__dirname, '..', 'screens', 'ExploreScreen.js'), 'utf8');

  it('measures and prints the distance with the functions the detail screen uses', () => {
    expect(explore).toMatch(/const dist = eventDistanceKm\(event, userLocation\);/);
    expect(explore).toMatch(/\{formatEventDistance\(dist\)\}/);
    // Its own copy of the arithmetic is gone, so the two cannot drift apart.
    expect(explore).not.toMatch(/event\.location\.latitude - userLocation\.lat/);
  });

  it("puts the venue's zone after the time when the clocks differ", () => {
    expect(explore).toMatch(/const timeZoneLabel = timeStr \? eventTimeZoneLabel\(event\) : null;/);
    expect(explore).toMatch(/\{timeStr\}\{timeZoneLabel \? ` \$\{timeZoneLabel\}` : ''\}/);
  });
});
