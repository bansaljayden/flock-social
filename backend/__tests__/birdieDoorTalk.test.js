// Run: node --test  (from backend/)
//
// DRINKS, ID AND THE DOOR, FOR A PLAN LOCKED IN AT A BAR (utils/birdieDoorTalk.js)
// and the clause remover that takes them out of a reply (utils/birdieGrounding.js
// withoutClauses). What counts as that talk, what does not (the crowd, the
// timing, Birdie's own cards, a venue's own name), what counts as the person
// raising it themselves, and how a reply is put back together once it is gone.
// The route's use of both is pinned by birdieLockedBar.test.js.
const test = require('node:test');
const assert = require('node:assert');

const { DOOR_TALK, talksAboutDrinksIdOrDoor, raisesDrinksIdOrDoor } = require('../utils/birdieDoorTalk');
const grounding = require('../utils/birdieGrounding');

test('what counts as talk about drinks, ID, age limits or getting in', () => {
  for (const said of [
    // Drinks.
    'Grab a drink at the bar first.', 'The cocktails are worth it.', 'Happy hour runs till 7.', 'Two beers in and you will love it.',
    'The drinks are cheap.', 'Do a shot for me.', 'Shots are half off.', 'Start a bar tab.', 'The bartenders are fast.', 'Ten taps on tap.',
    // ID and carding.
    'Heads up, they card at the door.', 'They will card everyone.', 'Bring your ID.', 'No ID, no entry.', 'They scan IDs.',
    "Bring a fake ID and you're fine.", 'Wristbands for under 21s.', "Have your driver's license ready.", "You'll get carded.",
    // Age limits.
    "It's 21+, so bring ID.", 'It is 21 and up.', 'Under 21s cannot go.', 'It is not all ages.', 'You need to be old enough.',
    'There is an age limit.', 'They let 19 year olds in on Thursdays.',
    // The door.
    "You won't get in.", 'They will not let you in.', 'They might turn you away.', 'The bouncer is strict after 10.',
    'There is a cover charge after 9.', 'Entry is free before 10.', 'The door is strict tonight.',
  ]) assert.ok(talksAboutDrinksIdOrDoor(said), `missed: ${said}`);
});

test('what does not: the crowd, the timing, idioms, Birdie\'s own cards and the rest of a normal answer', () => {
  for (const said of [
    'The Velvet Hour sits at 26 right now and climbs after 9.', 'Get there before 9 while it is quiet.', 'Get in before the rush at 10.',
    'Your best shot is right now.', 'Now is good, it gets busier later.', 'You are locked in at The Velvet Hour tonight.',
    "The card's below. Tap Vote for it.", 'Your plan card is below, tap Start this flock.', 'Cold brew at Copper Kettle.',
    'It peaks around 11 PM.', 'Steady at 38, so go now.', 'Head over around 8 PM when it is still quiet.', 'Thistle & Crust, rated 4.5.',
    'It is about a 6 minute walk.', 'Pixel Pier Arcade has skee-ball.', 'Five of you are going.', 'The vote is 3 to 1.',
  ]) assert.ok(!talksAboutDrinksIdOrDoor(said), `false alarm: ${said} (${(DOOR_TALK.exec(said) || [])[0]})`);
  assert.strictEqual(talksAboutDrinksIdOrDoor(null), false);
  assert.strictEqual(talksAboutDrinksIdOrDoor(undefined), false);
});

test('what counts as the person raising it themselves, read more broadly than a reply', () => {
  for (const ask of [
    'can we drink there?', 'will they let us in?', 'is it 21+?', 'do they card?', 'we are 19, is that ok', 'can we get in?',
    'how old do you have to be', 'will they serve us', 'is there a cover?', 'can minors go', 'do i need my id',
  ]) assert.ok(raisesDrinksIdOrDoor(ask), `missed: ${ask}`);
  for (const ask of ['how busy will it be?', 'where should we go?', 'when should we head over', 'is it packed rn', 'what time is best', 'why that one?']) {
    assert.ok(!raisesDrinksIdOrDoor(ask), `false alarm: ${ask}`);
  }
});

const factsFor = (...names) => {
  const facts = grounding.createVenueFacts();
  for (const n of names) facts.add(n, null);
  return facts;
};
const strip = (text, ...names) => grounding.withoutClauses(text, factsFor('The Velvet Hour', ...names), DOOR_TALK);

test('the clause goes and the answer around it stays, put back together as a plain sentence', () => {
  const cases = [
    ['The Velvet Hour sits at 26 right now and climbs after 9. Heads up, they card at the door.', 'The Velvet Hour sits at 26 right now and climbs after 9.'],
    ['The Velvet Hour sits at 26 right now, and the cocktails are worth it.', 'The Velvet Hour sits at 26 right now.'],
    ["Stick with The Velvet Hour. It's 21+, so bring ID.", 'Stick with The Velvet Hour.'],
    ['It is at 26 now, so get there by 8 before the bouncer gets strict.', 'It is at 26 now.'],
    ['Go now, but bring your ID.', 'Go now.'],
    ['You are locked in at The Velvet Hour. It is steady at 38, and happy hour ends at 7, so go now.', 'You are locked in at The Velvet Hour. It is steady at 38, so go now.'],
  ];
  for (const [said, kept] of cases) {
    const r = strip(said);
    assert.strictEqual(r.text, kept, said);
    assert.strictEqual(r.removed, 1, said);
  }
});

test('a reply that was only that talk comes back empty, for the caller to fill', () => {
  for (const said of ["The Velvet Hour is 21 and up, so you won't get in.", 'Heads up: they card at the door.', 'Bring ID. They card hard.']) {
    const r = strip(said);
    assert.strictEqual(r.text, '', said);
    assert.ok(r.removed >= 1, said);
  }
});

test('a venue\'s own name is never talk, and a reply with none of it is returned as it was', () => {
  const named = 'Yards Beer Hall is at 40 right now. Best time is 8 PM.';
  assert.deepStrictEqual(strip(named, 'Yards Beer Hall'), { text: named, removed: 0 });
  // Unknown to the turn, the same words read as talk.
  assert.strictEqual(grounding.withoutClauses(named, factsFor('The Velvet Hour'), DOOR_TALK).removed, 1);
  const plain = 'Now is good. The Velvet Hour is at 26 and climbs after 9.';
  assert.deepStrictEqual(strip(plain), { text: plain, removed: 0 });
  assert.deepStrictEqual(grounding.withoutClauses('', factsFor('X'), DOOR_TALK), { text: '', removed: 0 });
  assert.deepStrictEqual(grounding.withoutClauses('Bring ID.', factsFor('X'), null), { text: 'Bring ID.', removed: 0 });
});
