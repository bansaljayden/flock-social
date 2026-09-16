/**
 * The "on my way" vocabulary and arithmetic in lib/travel.js.
 *
 * Three things are worth pinning. The wire fields are validated before they
 * leave the device, so the emitter can never send a shape the server drops
 * (and seats never travel without a car). The ETA is an ESTIMATE that runs
 * slow on purpose and says "about"; a change to the road factor or a speed
 * shows up here as a number, which is the point. And a position with no mode
 * gets a distance and no minutes, because a time with no speed is invented.
 */
const {
  travelFields, etaMinutes, formatEta, formatDistance,
  isTravelIntent, isTravelMode, TRAVEL_MODES, TRAVEL_INTENTS, MAX_SEATS,
} = require('../lib/travel');

describe('what goes on the wire', () => {
  it('a plain share sends nothing extra', () => {
    expect(travelFields(null)).toEqual({});
    expect(travelFields(undefined)).toEqual({});
    expect(travelFields({})).toEqual({});
    expect(travelFields('omw')).toEqual({});
  });

  it('only the allowed intents and modes survive', () => {
    expect(travelFields({ intent: 'omw' })).toEqual({ intent: 'omw' });
    expect(travelFields({ intent: 'need_ride' })).toEqual({ intent: 'need_ride' });
    expect(travelFields({ intent: 'teleport' })).toEqual({});
    expect(travelFields({ mode: 'walk' })).toEqual({ mode: 'walk' });
    expect(travelFields({ mode: 'fly' })).toEqual({});
    for (const m of TRAVEL_MODES) expect(isTravelMode(m)).toBe(true);
    for (const i of TRAVEL_INTENTS) expect(isTravelIntent(i)).toBe(true);
    expect(isTravelMode('DRIVE')).toBe(false);
  });

  it('seats travel only with a car, and only as a small whole number', () => {
    expect(travelFields({ mode: 'drive', seats: 2 })).toEqual({ mode: 'drive', seats: 2 });
    expect(travelFields({ mode: 'drive', seats: 0 })).toEqual({ mode: 'drive', seats: 0 });
    expect(travelFields({ mode: 'drive', seats: MAX_SEATS })).toEqual({ mode: 'drive', seats: MAX_SEATS });
    expect(travelFields({ mode: 'drive', seats: MAX_SEATS + 1 })).toEqual({ mode: 'drive' });
    expect(travelFields({ mode: 'drive', seats: -1 })).toEqual({ mode: 'drive' });
    expect(travelFields({ mode: 'drive', seats: 2.5 })).toEqual({ mode: 'drive' });
    expect(travelFields({ mode: 'drive', seats: '2' })).toEqual({ mode: 'drive' });
    // A walker with "seats" is a shape, not a fact.
    expect(travelFields({ mode: 'walk', seats: 2 })).toEqual({ mode: 'walk' });
    expect(travelFields({ intent: 'omw', seats: 2 })).toEqual({ intent: 'omw' });
  });
});

describe('the estimate', () => {
  it('runs slow rather than fast, and by mode', () => {
    // 1 km straight line is 1.3 km of street. Walking at 4.8 km/h: 16.25 min.
    expect(etaMinutes(1, 'walk')).toBeCloseTo(16.25, 2);
    // Driving at 28 km/h: under three minutes for the same kilometre.
    expect(etaMinutes(1, 'drive')).toBeCloseTo(2.79, 2);
    expect(etaMinutes(1, 'transit')).toBeCloseTo(4.33, 2);
    expect(etaMinutes(0, 'walk')).toBe(0);
  });

  it('has no opinion without a mode, or with a distance that is not one', () => {
    expect(etaMinutes(1, undefined)).toBeNull();
    expect(etaMinutes(1, 'fly')).toBeNull();
    expect(etaMinutes(NaN, 'walk')).toBeNull();
    expect(etaMinutes(-1, 'walk')).toBeNull();
  });

  it('is worded as an estimate', () => {
    expect(formatEta(0.4)).toBe('under a minute');
    expect(formatEta(8.4)).toBe('about 8 min');
    expect(formatEta(59.6)).toBe('about 1 hr');
    expect(formatEta(70)).toBe('about 1 hr 10 min');
    expect(formatEta(null)).toBeNull();
    expect(formatEta(-3)).toBeNull();
  });

  it('a distance reads in the unit a person would use', () => {
    expect(formatDistance(0.02)).toBe('50 m away');
    expect(formatDistance(0.43)).toBe('450 m away');
    expect(formatDistance(2.14)).toBe('2.1 km away');
    expect(formatDistance('x')).toBeNull();
  });
});
