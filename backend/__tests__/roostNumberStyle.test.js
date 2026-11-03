// Run: node --test __tests__/roostNumberStyle.test.js  (from backend/)
//
// ===========================================================================
// THE MODEL'S OWN NUMBERS, IN HOUSE STYLE (2026-11-03).
//
// The first live Gemini eval since 10-28 read every one of 179 answers, and
// the same slips came back again and again, all in numbers the model wrote
// itself: "$1350" a line under "$1,350", "22:00" beside "11 PM", "4pm to
// 6pm", "5:00 PM" beside "5 PM", "your reading was -18 points under your
// typical Monday", and "On Tuesday Oct 27". advisorAnswer.tidyNumbers sets
// each right after the answer check has read the draft, and changes no value.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');

const { tidyNumbers } = require('../services/advisorAnswer');
const phrasing = require('../services/advisorPhrasing');
const freeText = require('../services/advisorFreeText');

const SPEND = () => [{ id: 'intake_typical_spend_per_person', value: 45, unit: 'usd', source: 'intake', asOf: 'owner-set 2026-10-01' }];

test('dollar amounts carry their thousands separator, and a figure already grouped is left alone', () => {
  for (const [said, shown] of [
    ['At $45 a head, 30 extra people brings in $1350 to cover staff and music.', 'At $45 a head, 30 extra people brings in $1,350 to cover staff and music.'],
    ['turning 35 seats once brings in $1330, which covers a small crew.', 'turning 35 seats once brings in $1,330, which covers a small crew.'],
    ['adds $2250.', 'adds $2,250.'],
    ['about $12480 a year, or $1350.50 a month', 'about $12,480 a year, or $1,350.50 a month'],
    ['already $1,350 and $23,400', 'already $1,350 and $23,400'],
    ['a 2026 menu and $500 minimums', 'a 2026 menu and $500 minimums'],
    // Only a dollar amount is grouped (adversarial review, 11-03): a zip code,
    // a SKU, an invoice or a phone number is an identifier, not an amount.
    ['Flyer the 10001 and 10011 zip codes first.', 'Flyer the 10001 and 10011 zip codes first.'],
    ['SKU 100234, invoice #12345, call +15551234567, about 12480 covers', 'SKU 100234, invoice #12345, call +15551234567, about 12480 covers'],
  ]) assert.strictEqual(tidyNumbers(said), shown, said);
});

test('a time reads in 12 hours where it is plainly a clock time, and nothing else is touched', () => {
  for (const [said, shown] of [
    ['a pastry with a drink between 13:00 and 2:30 PM', 'a pastry with a drink between 1 PM and 2:30 PM'],
    ['a full dining room between 19:00 and 21:00', 'a full dining room between 7 PM and 9 PM'],
    ['Schedule it around 20:00 to pull the crowd in.', 'Schedule it around 8 PM to pull the crowd in.'],
    ['offer free entry before 22:00 so the room fills early', 'offer free entry before 10 PM so the room fills early'],
    ['from 4pm to 6pm', 'from 4 PM to 6 PM'],
    // Durations, timers, ratios and scores (adversarial review, 11-03).
    ['Keep ticket times under 15:00 at the peak, and pull a runner when they pass 20:00.', 'Keep ticket times under 15:00 at the peak, and pull a runner when they pass 20:00.'],
    ['Set the fryer timer to 03:30 and keep the quoted wait under 00:45.', 'Set the fryer timer to 03:30 and keep the quoted wait under 00:45.'],
    ['after 15:00 minutes, reseat the table', 'after 15:00 minutes, reseat the table'],
    ['a 16:10 seat-to-server ratio, and the home side won 21:14', 'a 16:10 seat-to-server ratio, and the home side won 21:14'],
    ['post by 09:30 or 00:15', 'post by 09:30 or 00:15'],
    ['like 5pm to 6:30pm, so guests arrive early', 'like 5 PM to 6:30 PM, so guests arrive early'],
    ['between 5:00 PM and 6:30 PM, back by 7:00 PM', 'between 5 PM and 6:30 PM, back by 7 PM'],
    ['Doors open at 10 a.m. and it eases off at 2 p.m. Then it fills.', 'Doors open at 10 AM and it eases off at 2 PM. Then it fills.'],
    ['It opens at 10 a.m.', 'It opens at 10 AM.'],
    // "9:00" could be morning or night, and "5:00" a 5 PM special: left alone.
    ['between 9:00 and 11:00 around your 10 AM peak', 'between 9:00 and 11:00 around your 10 AM peak'],
    ['run it from 5:00 to 7:00', 'run it from 5:00 to 7:00'],
    ['8 AM, 2:30 PM, 12 PM and 12 AM', '8 AM, 2:30 PM, 12 PM and 12 AM'],
  ]) assert.strictEqual(tidyNumbers(said), shown, said);
});

test('a sign goes only from a points gap under or over the venue\'s own usual, and never from half of a range', () => {
  for (const [said, shown] of [
    ['Your reading was -18 points under your typical Monday.', 'Your reading was 18 points under your typical Monday.'],
    ['putting yesterday -18 points under your baseline', 'putting yesterday 18 points under your baseline'],
    ['a lift of +6 points over your usual Friday', 'a lift of 6 points over your usual Friday'],
    ['a delta of -18 on the day', 'a delta of -18 on the day'],
    ['food cost near 28-32%', 'food cost near 28-32%'],
    // A sign the word contradicts is the one hint of the truth: it stays.
    ['Your reading was -18 points over your typical Monday.', 'Your reading was -18 points over your typical Monday.'],
    ['a lift of +6 points under your usual Friday', 'a lift of +6 points under your usual Friday'],
    // Ranges, prepositions and longer numbers (adversarial review, 11-03).
    ['Your Mondays ran -18 to -25 points under your typical week.', 'Your Mondays ran -18 to -25 points under your typical week.'],
    ['Score went from -4 to -12 lower than last month.', 'Score went from -4 to -12 lower than last month.'],
    ['Your margin sits at -3% under the current menu prices.', 'Your margin sits at -3% under the current menu prices.'],
    ['moved to -12 under the new scoring', 'moved to -12 under the new scoring'],
    ['Plan for 40 +10 more covers on game nights.', 'Plan for 40 +10 more covers on game nights.'],
    ['Yesterday came in at 8 -18 points under your usual 26.', 'Yesterday came in at 8 -18 points under your usual 26.'],
    ['falling -18 below your usual 55', 'falling -18 below your usual 55'],
  ]) assert.strictEqual(tidyNumbers(said), shown, said);
});

test('a weekday beside its date takes a comma, the way the templates write it', () => {
  assert.strictEqual(tidyNumbers('On Tuesday Oct 27, your peak reading was 34.'), 'On Tuesday, Oct 27, your peak reading was 34.');
  assert.strictEqual(tidyNumbers('Saturday October 31 was the busiest.'), 'Saturday, October 31 was the busiest.');
  assert.strictEqual(tidyNumbers('Tuesday, Oct 27 had a highest reading of 34.'), 'Tuesday, Oct 27 had a highest reading of 34.');
});

test('the owner reads the tidy form from both answer checks, and the check still reads the draft as written', () => {
  const advice = freeText.applyAdviceValve(JSON.stringify({
    answer: 'Give Tuesday one recurring reason to visit.',
    points: [
      'At {{fact:intake_typical_spend_per_person}} a head, 30 extra people brings in $1350.',
      'Offer free entry before 22:00 so the room fills before your 11 PM peak.',
    ],
  }), SPEND());
  assert.ok(advice);
  assert.strictEqual(advice.text, [
    'Give Tuesday one recurring reason to visit.',
    '• At $45 a head, 30 extra people brings in $1,350.',
    '• Offer free entry before 10 PM so the room fills before your 11 PM peak.',
  ].join('\n'));
  // A made-up figure is still dropped, however it is written.
  const made = freeText.applyAdviceValve(JSON.stringify({
    answer: 'Fill Tuesday.',
    points: ['Your Tuesday took $1350 last week.'],
  }), SPEND());
  assert.strictEqual(made.text, 'Fill Tuesday.');

  const facts = [
    { id: 'reading', value: 8, source: 'owner_report', asOf: '2026-11-02' },
    { id: 'baseline', value: 26, source: 'owner_report', asOf: '2026-11-02' },
    { id: 'delta', value: -18, source: 'arithmetic', asOf: '2026-11-02' },
  ];
  const grounded = phrasing.applyValve(JSON.stringify({
    answer: 'Yesterday came in at {{fact:reading}} against your usual {{fact:baseline}}.',
    points: ['Your reading was {{fact:delta}} points under your typical Monday.'],
  }), { facts });
  assert.ok(grounded);
  assert.strictEqual(grounded.text, 'Yesterday came in at 8 against your usual 26.\n• Your reading was 18 points under your typical Monday.');
});
