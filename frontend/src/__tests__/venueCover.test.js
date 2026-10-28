import fs from 'fs';
import path from 'path';
import { fallbackVenueCover, VENUE_COVERS } from '../lib/venueCover';

describe('fallbackVenueCover', () => {
  test('every category chip gets the matching picture', () => {
    expect(fallbackVenueCover('Bar / Nightclub')).toBe(VENUE_COVERS.bar);
    expect(fallbackVenueCover('Restaurant')).toBe(VENUE_COVERS.restaurant);
    expect(fallbackVenueCover('Cafe / Coffee')).toBe(VENUE_COVERS.cafe);
    expect(fallbackVenueCover('Lounge')).toBe(VENUE_COVERS.bar);
    expect(fallbackVenueCover('Rooftop')).toBe(VENUE_COVERS.rooftop);
    expect(fallbackVenueCover('Brewery / Winery')).toBe(VENUE_COVERS.brewery);
    expect(fallbackVenueCover('Event Space')).toBe(VENUE_COVERS.event);
    expect(fallbackVenueCover('Other')).toBe(VENUE_COVERS.restaurant);
  });

  test('Google types and look-alike words land on the right picture', () => {
    expect(fallbackVenueCover('Night Club')).toBe(VENUE_COVERS.bar);
    expect(fallbackVenueCover('Coffee Shop')).toBe(VENUE_COVERS.cafe);
    expect(fallbackVenueCover('Steakhouse')).toBe(VENUE_COVERS.restaurant);
    expect(fallbackVenueCover('Barbecue Restaurant')).toBe(VENUE_COVERS.restaurant);
    expect(fallbackVenueCover('Republic Grill')).toBe(VENUE_COVERS.restaurant);
  });

  test('no category is the restaurant picture', () => {
    expect(fallbackVenueCover(undefined)).toBe(VENUE_COVERS.restaurant);
    expect(fallbackVenueCover(null)).toBe(VENUE_COVERS.restaurant);
    expect(fallbackVenueCover('')).toBe(VENUE_COVERS.restaurant);
  });

  test('every picture exists in public/', () => {
    for (const url of Object.values(VENUE_COVERS)) {
      expect(fs.existsSync(path.join(__dirname, '..', '..', 'public', url))).toBe(true);
    }
  });
});
