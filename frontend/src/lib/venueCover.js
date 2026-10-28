// The picture behind the venue dashboard header when the venue has no listing
// photo of its own: one of six generated interiors in public/venue-covers,
// picked by the venue's category so a bar gets a bar and a cafe gets a cafe.
// They are generated art Flock owns, never a Places photo (those may not be
// stored in the repo at all).

const COVERS = {
  restaurant: '/venue-covers/restaurant.webp',
  bar: '/venue-covers/bar.webp',
  cafe: '/venue-covers/cafe.webp',
  rooftop: '/venue-covers/rooftop.webp',
  brewery: '/venue-covers/brewery.webp',
  event: '/venue-covers/event.webp',
};

// Matched on words rather than the exact chip labels, because the category can
// also arrive as a Google type ("Night Club", "Coffee Shop") from onboarding.
// Word boundaries where a bare match would misfire: "tea" is inside
// "Steakhouse", "bar" starts "Barbecue", "pub" is inside "Republic".
const RULES = [
  [/rooftop/i, 'rooftop'],
  [/brew|winery|taproom/i, 'brewery'],
  [/caf[eé]|coffee|bakery|\btea\b/i, 'cafe'],
  [/\bbars?\b|\bpubs?\b|club|lounge|tavern/i, 'bar'],
  [/event|banquet/i, 'event'],
];

export function fallbackVenueCover(category) {
  const text = typeof category === 'string' ? category : '';
  const hit = RULES.find(([re]) => re.test(text));
  return COVERS[hit ? hit[1] : 'restaurant'];
}

export const VENUE_COVERS = COVERS;
