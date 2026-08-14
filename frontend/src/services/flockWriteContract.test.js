/**
 * Contract tests for the three flock-edit writers in services/api.js.
 *
 * These exist because App.js used to reach PUT /api/flocks/:id with bare
 * fetch() calls that read the token out of localStorage and never looked at
 * res.ok. Two failures rode on that, and both are asserted here so they cannot
 * come back:
 *
 *   - a null venue_latitude / venue_rating was SENT, and express-validator's
 *     .optional() skips `undefined` only, so the whole request came back 400
 *     and nothing saved. Nullish keys must be omitted, not sent as null.
 *   - a 403 ("only the creator can update this flock") resolved the promise, so
 *     the caller's .then ran and the refusal was invisible. Every non-2xx must
 *     reject, carrying the server's own message and status.
 *
 * Run: cd frontend && CI=true npx react-scripts test --watchAll=false
 */

/* eslint-env jest */

const ENDPOINT = /\/api\/flocks\/42$/;

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

let api;
let fetchMock;

beforeEach(() => {
  jest.resetModules();
  window.localStorage.clear();
  window.localStorage.setItem('flockToken', 'tok-abc');
  fetchMock = jest.fn();
  global.fetch = fetchMock;
  // eslint-disable-next-line global-require
  api = require('./api');
});

afterEach(() => {
  delete global.fetch;
});

function lastCall() {
  expect(fetchMock).toHaveBeenCalled();
  const [url, options] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url, options, body: JSON.parse(options.body) };
}

describe('saveFlockVenue', () => {
  test('omits nullish fields instead of sending them as null', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { flock: { id: 42 } }));

    await api.saveFlockVenue(42, {
      name: 'The Bar',
      addr: '1 Main St',
      place_id: null,
      lat: null,
      lng: undefined,
      rating: null,
      photo_url: null,
    });

    const { url, options, body } = lastCall();
    expect(url).toMatch(ENDPOINT);
    expect(options.method).toBe('PUT');
    expect(body).toEqual({ venue_name: 'The Bar', venue_address: '1 Main St' });
    // The exact keys that used to 400 the request must be ABSENT, not null.
    expect('venue_latitude' in body).toBe(false);
    expect('venue_longitude' in body).toBe(false);
    expect('venue_rating' in body).toBe(false);
    expect('venue_photo_url' in body).toBe(false);
    expect('venue_id' in body).toBe(false);
  });

  test('sends every field that does have a value', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { flock: { id: 42 } }));

    await api.saveFlockVenue(42, {
      name: 'The Bar',
      addr: '1 Main St',
      place_id: 'ChIJabc',
      lat: 40.5,
      lng: -75.2,
      rating: 4.4,
      photo_url: '/api/venues/photo?ref=x',
    });

    expect(lastCall().body).toEqual({
      venue_name: 'The Bar',
      venue_address: '1 Main St',
      venue_id: 'ChIJabc',
      venue_latitude: 40.5,
      venue_longitude: -75.2,
      venue_rating: 4.4,
      venue_photo_url: '/api/venues/photo?ref=x',
    });
  });

  test('carries the stored token as a bearer header', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { flock: { id: 42 } }));
    await api.saveFlockVenue(42, { name: 'The Bar' });
    expect(lastCall().options.headers.Authorization).toBe('Bearer tok-abc');
  });

  test('a 403 rejects with the server sentence, and does not resolve', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: 'Only the creator can update this flock' }));

    await expect(api.saveFlockVenue(42, { name: 'The Bar' }))
      .rejects.toMatchObject({ status: 403, message: 'Only the creator can update this flock' });
  });

  test('a 404 rejects too — a deleted flock is not a successful save', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'Flock not found' }));
    await expect(api.saveFlockVenue(42, { name: 'The Bar' })).rejects.toMatchObject({ status: 404 });
  });

  test('a write is sent exactly once — no retry on a gateway error', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { error: 'upstream' }));
    await expect(api.saveFlockVenue(42, { name: 'The Bar' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('setFlockStatus', () => {
  test('sends the status the server enum accepts', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { flock: { id: 42, status: 'completed' } }));
    await api.setFlockStatus(42, 'completed');
    const { options, body } = lastCall();
    expect(options.method).toBe('PUT');
    expect(body).toEqual({ status: 'completed' });
  });

  test('refuses a status the server would reject, without spending a request', async () => {
    await expect(api.setFlockStatus(42, 'done')).rejects.toThrow(/Unknown flock status/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a refusal rejects, so an attendance sheet cannot open on a failed write', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: 'Only the creator can update this flock' }));
    await expect(api.setFlockStatus(42, 'completed')).rejects.toMatchObject({ status: 403 });
  });
});

describe('setFlockEventTime', () => {
  test('sends event_time and nothing else', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { flock: { event_time: '2026-08-20T01:00:00.000Z' } }));
    const data = await api.setFlockEventTime(42, '2026-08-20T01:00:00.000Z');
    const { options, body } = lastCall();
    expect(options.method).toBe('PUT');
    expect(body).toEqual({ event_time: '2026-08-20T01:00:00.000Z' });
    expect(data.flock.event_time).toBe('2026-08-20T01:00:00.000Z');
  });

  test('a 400 from the ISO-8601 validator rejects with the server message', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: 'Invalid value' }));
    await expect(api.setFlockEventTime(42, 'tomorrow')).rejects.toMatchObject({ status: 400 });
  });
});
