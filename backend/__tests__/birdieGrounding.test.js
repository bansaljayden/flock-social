// Run: node --test  (from backend/)
//
// WHAT BIRDIE MAY SAY ABOUT A VENUE (utils/birdieGrounding.js).
//
// Filming the LionCage demo on 2026-11-03, Birdie answered "Where's good
// tonight for 6 of us?" with "Thistle & Crust. The booths in the back fit six
// easily and the wood-fired pies are the whole reason to go." The venue's data
// said pizza_restaurant, restaurant, 4.6 from 301 ratings, Chestnut St, and
// nothing about booths, a back room, how many it seats or an oven. This pins
// the deterministic check that runs after the model answers: a venue detail
// stands only on that venue's own tool data, an unsupported claim's clause or
// sentence goes, what is left reads as plain sentences, and an answer is never
// emptied. One rule at a time, no route and no model; the route's use of it is
// in __tests__/birdieFlockPlan.test.js.
const test = require('node:test');
const assert = require('node:assert');

const { createVenueFacts, noteToolResult, notePlan, groundVenueDetails } = require('../utils/birdieGrounding');
const { buildSystemPrompt } = require('../routes/ai').__testables;

// The demo's venue, as the local Places stub served it and search_venues
// shaped it (record.mjs, demo-spots.json).
const THISTLE = {
  place_id: 'demo-thistle-crust', name: 'Thistle & Crust', address: 'Chestnut St, Philadelphia',
  rating: 4.6, reviews: 301, price_level: 2, types: ['pizza_restaurant', 'restaurant'], is_open: true,
  photo_url: '/api/venues/photo?ref=places%2Fdemo-thistle-crust%2Fphotos%2Fdemo&maxwidth=400',
};
const LARKSPUR = { place_id: 'demo-larkspur-tap', name: 'Larkspur Tap', address: 'Sansom St, Philadelphia', rating: 4.5, reviews: 212, price_level: 2, types: ['bar'], is_open: true };
const DINER = { place_id: 'p-diner', name: 'Hamilton Street Diner', address: '615 W Hamilton St, Allentown, PA', rating: 4.3, reviews: 624, price_level: 1, types: ['diner', 'restaurant', 'food'] };
const LANES = { place_id: 'p-lanes', name: 'Pinwheel Lanes', address: '1001 N 2nd St, Philadelphia, PA', rating: 4.3, price_level: 2, types: ['bowling_alley', 'point_of_interest', 'establishment'] };
const CAFE = { place_id: 'p-cafe', name: 'Copper Kettle Cafe', address: '228 S 20th St, Philadelphia, PA', rating: 4.6, price_level: 1, types: ['cafe', 'coffee_shop', 'food'] };
const WINGS = { place_id: 'p-wings', name: 'Rally House Wings', address: '2400 S 11th St, Philadelphia, PA', rating: 4.3, price_level: 2, types: ['chicken_wings_restaurant', 'restaurant', 'food'] };

// Facts as the tool loop records them: one search result.
function searched(...rows) {
  const facts = createVenueFacts();
  noteToolResult(facts, 'search_venues', { venues: rows });
  return facts;
}
const ground = (text, facts) => groundVenueDetails(text, facts);
const kinds = (r) => r.removed.map((x) => x.kind);

const DEMO = 'Thistle & Crust. The booths in the back fit six easily and the wood-fired pies are the whole reason to go.';

test('the demo answer: the booths, the back room, the six and the oven go, and the pick stays', () => {
  const r = ground(DEMO, searched(THISTLE, LARKSPUR));
  assert.strictEqual(r.text, 'Thistle & Crust.');
  assert.deepStrictEqual(kinds(r).sort(), ['capacity', 'preparation', 'room', 'seating']);
  assert.ok(r.removed.every((x) => x.venue === 'Thistle & Crust'), 'a claim was held to the wrong venue');
});

test('a detail the venue\'s own data says survives: pizza at a pizza place, and the rest of its kind', () => {
  const pizza = searched(THISTLE);
  for (const said of [
    'Thistle & Crust. Pizza place, rated 4.6, and only at 40 right now.',
    'Thistle & Crust. Split a couple of pies, it is $$ and rated 4.6.',
    'Thistle & Crust has slices for everyone and it is quiet right now.',
  ]) {
    const r = ground(said, pizza);
    assert.strictEqual(r.text, said, `a supported detail was removed: ${said} -> ${r.text}`);
    assert.deepStrictEqual(r.removed, []);
  }
  assert.strictEqual(ground('Pinwheel Lanes. Grab a lane now before it fills up.', searched(LANES)).removed.length, 0);
  assert.strictEqual(ground('Copper Kettle Cafe. Good coffee and it sits at 24.', searched(CAFE)).removed.length, 0);
  assert.strictEqual(ground('Hamilton Street Diner. Grab milkshakes and fries, it is open now.', searched(DINER)).removed.length, 0);
});

test('a detail is supported by any words a tool returned for that venue: a summary, a review, the name', () => {
  // A field no tool sends today (an editorial summary, review snippets) is
  // read the same way, because every string in the payload counts.
  const facts = searched({ ...THISTLE, editorial_summary: 'Known for wood-fired pies and big booths.', reviews_text: ['The back room fits a crowd.'] });
  const said = 'Thistle & Crust. The booths are big and the wood-fired pies are the reason to go.';
  assert.strictEqual(ground(said, facts).text, said);
  // A word in the venue's own name is not a claim, and stands behind the same
  // word said on its own.
  const luna = searched({ name: 'Luna Rooftop Lounge', types: ['bar', 'night_club'], price_level: 3 });
  const rooftop = 'Luna Rooftop Lounge. The rooftop is the move, and it is upscale without being stiff.';
  assert.strictEqual(ground(rooftop, luna).text, rooftop);
  const brick = searched({ name: 'Brick Oven Pie Co.', types: ['pizza_restaurant', 'restaurant', 'food'], rating: 4.6 });
  const pies = 'Split a couple pies at Brick Oven Pie Co. on 7th Street, it is at 68 right now.';
  assert.strictEqual(ground(pies, brick).text, pies, 'a name with a full stop in it split the sentence, or its words read as claims');
});

test('the prompt\'s own bad example is what the check removes, and its good example survives', () => {
  const rule = buildSystemPrompt('Jay', {}, { ageBracket: 'adult' }).split('\n').find((l) => l.startsWith('- Your reasons for a spot'));
  const bad = /Bad: "([^"]+)"/.exec(rule)[1];
  const good = /Good: "([^"]+)"/.exec(rule)[1];
  const oakwood = searched({ ...THISTLE, name: 'Oakwood', place_id: 'p-oakwood' });
  assert.strictEqual(ground(good, oakwood).text, good);
  const r = ground(bad, oakwood);
  assert.strictEqual(r.text, 'Oakwood.');
  assert.ok(kinds(r).includes('seating') && kinds(r).includes('preparation'));
});

test('a detail is held to the venue it is about, not to one further down the results', () => {
  const withBooths = { ...DINER, editorial_summary: 'Classic booths and late-night pancakes.' };
  const facts = searched(THISTLE, withBooths);
  assert.strictEqual(ground('Hamilton Street Diner. Grab a booth and some pancakes.', facts).removed.length, 0);
  const r = ground('Thistle & Crust. Grab a booth and some pies.', facts);
  assert.strictEqual(r.text, 'Thistle & Crust.');
  assert.deepStrictEqual(kinds(r), ['seating']);
  // A claim before the name it belongs to, in the same clause.
  assert.strictEqual(ground('The booths at Thistle & Crust fit six.', facts).text, 'Thistle & Crust.');
  // A claim in a clause of its own belongs to the venue before it, not to one
  // named later in another clause of the sentence.
  const two = searched(THISTLE, LARKSPUR);
  const said = 'Thistle & Crust. Pizza place, rated 4.6, and Larkspur Tap is the bar pick if you want drinks.';
  assert.strictEqual(ground(said, two).text, said);
  // Each clause is held to its own venue, and a second venue named only in a
  // clause that went goes with it: only the pick keeps its name.
  assert.strictEqual(ground('Thistle & Crust has pizza and Larkspur Tap has a patio.', two).text, 'Thistle & Crust has pizza.');
});

test('what is left reads as plain sentences', () => {
  const mango = searched({ name: 'Mango Street Tacos', address: '1325 Frankford Ave', types: ['mexican_restaurant', 'restaurant', 'food'], rating: 4.7, price_level: 1 });
  // A clause from the middle of a list: "A, and B" reads "A and B".
  assert.strictEqual(
    ground('Mango Street Tacos on Frankford. Dirt cheap, easily the best birria around here, and two tables are open right now.', mango).text,
    'Mango Street Tacos on Frankford. Dirt cheap and two tables are open right now.');
  // A phrase hanging off a clause goes alone, and the clause keeps its comma.
  assert.strictEqual(
    ground('Hamilton Street Diner. Grab milkshakes and fries in a booth, and the crowd thins out after 9.', searched(DINER)).text,
    'Hamilton Street Diner. Grab milkshakes and fries, and the crowd thins out after 9.');
  // The list's last item goes, and the new last item takes its "and".
  assert.strictEqual(
    ground('Hamilton Street Diner. It is open, cheap, rated 4.3, and far more laid back than an arcade.', searched(DINER)).text,
    'Hamilton Street Diner. It is open, cheap, and rated 4.3.');
  // The clause that named the venue goes, and the venue keeps its name.
  assert.strictEqual(
    ground("Thistle & Crust has big booths that fit six, and it's at 40 right now.", searched(THISTLE)).text,
    "Thistle & Crust. It's at 40 right now.");
  // A sentence that goes leaves the spacing between the others as it was.
  assert.strictEqual(
    ground('Thistle & Crust. The patio is huge. It is at 40 right now.', searched(THISTLE)).text,
    'Thistle & Crust. It is at 40 right now.');
  // And so does a line break, after a line that was put back together.
  assert.strictEqual(
    ground('Thistle & Crust, cheap with a big patio\n\nIt is at 40 right now.', searched(THISTLE)).text,
    'Thistle & Crust, cheap\n\nIt is at 40 right now.');
});

test('an answer is never emptied, sentence or no sentence', () => {
  const facts = searched(THISTLE);
  for (const said of ['booths in the back fit six', 'The booths in the back fit six.', 'big patio, wood-fired everything']) {
    const r = ground(said, facts);
    assert.ok(r.text.trim().length > 0, `emptied: ${said}`);
    assert.strictEqual(r.text, 'Thistle & Crust.');
  }
  // No full stop anywhere, and the name stays where it was.
  assert.strictEqual(ground('thistle & crust, booths in the back', facts).text, 'thistle & crust');
});

test('a question, a denial and a reply about no venue the turn knows claim nothing', () => {
  const facts = searched(THISTLE);
  for (const said of [
    'Want a booth at Thistle & Crust?',
    'No word on booths at Thistle & Crust, but it is at 40 right now.',
    "I can't tell if Thistle & Crust has a patio. It is at 40 right now.",
  ]) assert.strictEqual(ground(said, facts).text, said);
  // Two venues known, neither named: nothing to hold the claim to.
  const two = searched(THISTLE, LARKSPUR);
  assert.strictEqual(ground('Want somewhere with live music and a patio?', two).text, 'Want somewhere with live music and a patio?');
  assert.strictEqual(ground('If you want live music, tell me the neighborhood.', two).text, 'If you want live music, tell me the neighborhood.');
  // Nothing known at all: left alone.
  assert.strictEqual(ground(DEMO, createVenueFacts()).text, DEMO);
});

test('a word after a comparison can be about another venue the turn knows', () => {
  const facts = searched({ name: 'Saffron Room', types: ['indian_restaurant', 'restaurant', 'food'], rating: 4.5, price_level: 2 }, THISTLE);
  const said = 'Saffron Room is at 68 right now. It is $$, rated 4.5, and much more lowkey than the pizza rush around the corner.';
  assert.strictEqual(ground(said, facts).text, said);
  // Not without one: pizza at the Indian place itself is a claim.
  assert.strictEqual(ground('Saffron Room. Grab a pizza and it is at 68 right now.', facts).removed.length, 1);
});

test('a deal in the payload supports a deal claim; without one, a deal-like claim goes', () => {
  const DEAL = { title: 'Half-price wings 9–11 PM', slot: 'Late Night', days: 'Fri-Sun' };
  const said = 'Rally House Wings. Half-price wings run 9 to 11 tonight.';
  assert.strictEqual(ground(said, searched({ ...WINGS, deal: DEAL })).text, said);
  const none = ground(said, searched(WINGS));
  assert.strictEqual(none.text, 'Rally House Wings.');
  assert.deepStrictEqual(kinds(none), ['deal']);
  // A deal that is not this deal: half-price wings is no half-price pies.
  const pies = ground('Thistle & Crust. Half-price pies till 11, and it is at 40 right now.', searched({ ...THISTLE, deal: DEAL }));
  assert.strictEqual(pies.text, 'Thistle & Crust. It is at 40 right now.');
  // The deal's own time slot is part of it, and "a deal" stands on any deal.
  const quiz = searched({ ...THISTLE, deals: [{ title: 'Monday quiz night', slot: 'Happy Hour', days: 'Weekdays' }] });
  assert.strictEqual(ground('Thistle & Crust. Happy hour runs on weekdays.', quiz).text, 'Thistle & Crust. Happy hour runs on weekdays.');
  assert.strictEqual(ground('Thistle & Crust. Happy hour runs on weekdays.', searched(THISTLE)).text, 'Thistle & Crust.');
  assert.strictEqual(ground('Thistle & Crust has a deal on tonight.', quiz).removed.length, 0);
  assert.strictEqual(ground('Larkspur Tap has $5 pints till 9.', searched(LARKSPUR)).text, 'Larkspur Tap.');
});

test('what the route writes to the model is not data about a venue', () => {
  // A place id, a photo link and the route's own notes (a locked forecast,
  // the UTC clock, a staged card's button) carry words, and none of them is a
  // fact about the place.
  const facts = createVenueFacts();
  noteToolResult(facts, 'get_crowd_prediction', {
    venue_name: "Fennick's", crowd_score: 40, crowd_label: 'Steady',
    forecast_note: 'There is a patio of booths here.', clock_note: 'patio', place_id: 'demo-patio-booths',
  });
  noteToolResult(facts, 'search_venues', { error: 'Too many venue lookups right now.' });
  const r = ground("Fennick's. The patio has booths, and it is steady at 40.", facts);
  assert.strictEqual(r.text, "Fennick's. It is steady at 40.");
});

test('the plan\'s places and the venue on screen are venues a reply is held to, with nothing behind a detail', () => {
  const facts = createVenueFacts();
  notePlan(facts, { going: 6, locked: null, venueSoFar: null, picks: [{ name: 'Wren & Barrel', placeId: 'demo-wren-barrel', votes: 3 }] });
  const r = ground('Wren & Barrel. It has 3 of the 5 votes, and the fireplace room is the move.', facts);
  assert.strictEqual(r.text, 'Wren & Barrel. It has 3 of the 5 votes.');
  // A crowd lookup on the pick adds its words; its votes alone support no detail.
  noteToolResult(facts, 'get_crowd_prediction', { venue_name: 'Wren & Barrel', crowd_score: 31, crowd_label: 'Quiet' });
  assert.strictEqual(ground('Wren & Barrel. Quiet at 31, and it has 3 of the 5 votes.', facts).removed.length, 0);
});

test('a vibe read off the crowd is the crowd, and one with nothing behind it is a claim', () => {
  const facts = searched(CAFE);
  assert.strictEqual(ground('Copper Kettle Cafe. The vibe is quiet at 24 right now.', facts).removed.length, 0);
  assert.strictEqual(ground('Copper Kettle Cafe. Great vibe, and it is open.', facts).text, 'Copper Kettle Cafe. It is open.');
});

test('every removal names a kind from the fixed lexicon, never the reply\'s words', () => {
  const r = ground(DEMO, searched(THISTLE));
  const KINDS = ['seating', 'room', 'outdoor', 'capacity', 'service', 'reservations', 'preparation', 'decor', 'vibe', 'music', 'amenities', 'menu', 'reputation', 'deal', 'dish'];
  for (const x of r.removed) assert.ok(KINDS.includes(x.kind), x.kind);
  assert.deepStrictEqual(Object.keys(r.removed[0]).sort(), ['kind', 'venue']);
});
