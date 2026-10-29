// Run: node --test __tests__/roostOwnerWords.test.js  (from backend/)
//
// ===========================================================================
// HOW OWNERS ACTUALLY TYPE, PINNED (2026-10-28).
//
// A stress test of phone-typed questions and long rants, run through the
// offline route and the playbook with no model, found three kinds of wrong
// answer. Each is pinned here:
//
//   1. MISSPELLINGS. "how to upsel desert", "is doordash worht it" and "how
//      do i get more cusotmers" found nothing. services/ownerWords.js puts
//      them back into the spelling the cues use, and changes nothing else.
//   2. TWO SENSES OF ONE WORD. "Reviews say the service is slow" got a
//      slow-day move; "empty until 3" got one too. Speed and a dead stretch
//      inside the day are their own questions (roostPlaybook.trafficView).
//   3. WHAT THE OWNER RULED OUT. "We tried a happy hour and it didn't work"
//      was answered with a happy hour (roostPlaybook.ruledOut).
//
// Plus the plain growth question, "how do I get more customers", which the
// playbook had nothing for at all.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');

const { normalizeOwnerText, SPELLING } = require('../services/ownerWords');
const pb = require('../services/roostPlaybook');
const advisorFreeText = require('../services/advisorFreeText');

const RESTAURANT = { profile: { typical_spend_per_person: 30 }, mlVenue: { venue_category: 'restaurant' } };
const CAFE = { profile: { typical_spend_per_person: 9 }, mlVenue: { venue_category: 'cafe' } };

// The move a typed question gets with the model out: the offline route, then
// the playbook, exactly as advise() falls back.
function offlineAnswer(question, ctx = RESTAURANT) {
  const route = advisorFreeText.offlineRoute(question);
  if (!route || route.mode !== 'advice') return { route, answer: null };
  return { route, answer: pb.answer({ question, intentId: route.intentId, ctx }) };
}

// ── 1. Misspellings ─────────────────────────────────────────────────────────

test('misspellings and shorthand come back in the spelling the cues use', () => {
  assert.strictEqual(normalizeOwnerText('How to UPSEL desert'), 'how to upsell dessert');
  assert.strictEqual(normalizeOwnerText('is doordash worht it'), 'is doordash worth it');
  assert.strictEqual(normalizeOwnerText('need more ppl on tuesdys'), 'need more people on tuesdays');
  assert.strictEqual(normalizeOwnerText('how do i run a happy hr'), 'how do i run a happy hour');
  assert.strictEqual(normalizeOwnerText('we pay staff for 6hrs'), 'we pay staff for 6 hours');
  assert.strictEqual(normalizeOwnerText('the average cheque is down'), 'the average check is down');
  assert.strictEqual(normalizeOwnerText('Burgers & fries'), 'burgers  and  fries');
});

test('"quite" reads as "quiet" only where nobody means "quite"', () => {
  assert.strictEqual(normalizeOwnerText('mondays are quite'), 'mondays are quiet');
  assert.strictEqual(normalizeOwnerText("it's quite on sundays"), "it's quiet on sundays");
  assert.strictEqual(normalizeOwnerText('we are quite busy on fridays'), 'we are quite busy on fridays');
  assert.strictEqual(normalizeOwnerText('quite a few people left'), 'quite a few people left');
});

test('correct spelling passes through, and running it twice changes nothing', () => {
  const plain = 'how do we fill tuesdays with more customers and better reviews';
  assert.strictEqual(normalizeOwnerText(plain), plain);
  for (const typed of ['how do i get more cusotmers', 'tuesdys are quite', 'happy hr ideas', 'menue is too long']) {
    const once = normalizeOwnerText(typed);
    assert.strictEqual(normalizeOwnerText(once), once, typed);
  }
});

test('every correction is a different word, and no correction is itself corrected', () => {
  for (const [wrong, right] of Object.entries(SPELLING)) {
    assert.notStrictEqual(wrong, right, wrong);
    for (const w of right.split(' ')) {
      assert.ok(!Object.prototype.hasOwnProperty.call(SPELLING, w), `${wrong} -> ${right}, and ${w} is corrected again`);
    }
  }
});

test('a word the table lacks is never answered by the object prototype', () => {
  assert.strictEqual(normalizeOwnerText('the constructor of our patio'), 'the constructor of our patio');
  assert.strictEqual(normalizeOwnerText('tostring valueof hasownproperty'), 'tostring valueof hasownproperty');
  assert.strictEqual(normalizeOwnerText(''), '');
  assert.strictEqual(normalizeOwnerText(null), '');
});

test('phone-typed questions find the move the correctly spelled one would', () => {
  for (const [typed, tactic] of [
    ['how to upsel desert', 'check_show_dessert'],
    ['is doordash worht it', 'delivery_commission_math'],
    ['how to get more reveiws', 'rev_invite_all_guests'],
    ['how do i do a happy hr', 'slow_hours_happy_hour'],
    ['how to get more privte events', 'events_private_minimum'],
    ['our menue is too long', 'menu_cut_low_sellers'],
    ['staffing for thanksgivng', 'labor_schedule_from_forecast'],
  ]) {
    const { answer } = offlineAnswer(typed);
    assert.ok(answer, `"${typed}" found no move`);
    assert.strictEqual(answer.tactics[0], tactic, `"${typed}" -> ${answer.tactics[0]}`);
  }
});

// ── 2. Two senses of one word ───────────────────────────────────────────────

test('a speed complaint is not a slow night', () => {
  const view = pb.trafficView(normalizeOwnerText('reviews say the service is slow'));
  assert.deepStrictEqual(view.speed, ['slow service']);
  assert.ok(!/\bslow\b/.test(view.text), view.text);

  for (const [question, tactic] of [
    ["I keep getting 3 star reviews saying the service is slow but my servers say they're doing their best", 'rev_fix_patterns'],
    ['the kitchen is slow on fridays', 'rush_prep_to_par'],
    ['drinks take forever at the bar', 'rush_batch_drinks'],
  ]) {
    const { route, answer } = offlineAnswer(question);
    assert.strictEqual(route.mode, 'advice', question);
    assert.notStrictEqual(route.intentId, 'quiet_nights', question);
    assert.strictEqual(answer.tactics[0], tactic, `"${question}" -> ${answer.tactics[0]}`);
  }
});

test('a meal service that is slow is still traffic', () => {
  assert.deepStrictEqual(pb.trafficView('lunch service is slow').speed, []);
  assert.deepStrictEqual(advisorFreeText.offlineRoute('lunch service is slow'), { mode: 'grounded', intentId: 'quiet_nights' });
  assert.deepStrictEqual(advisorFreeText.offlineRoute('tuesdays are slow'), { mode: 'grounded', intentId: 'quiet_nights' });
});

test('a dead stretch inside the day, or filling part of it, leans to that part of the day', () => {
  const shop = "We're a small coffee shop near a college. Mornings are packed until 10 then it's empty until 3. Any ideas?";
  assert.strictEqual(offlineAnswer(shop, CAFE).answer.tactics[0], 'day_afternoon_lull');
  assert.strictEqual(offlineAnswer('nobody comes in after 2pm, what can i do', CAFE).answer.tactics[0], 'day_afternoon_lull');
  assert.strictEqual(offlineAnswer('how do i get more ppl in the afternoon', CAFE).answer.tactics[0], 'day_afternoon_lull');
  assert.strictEqual(offlineAnswer('how do i get busier at lunch').answer.tactics[0], 'day_office_lunch_days');
  // Dinner is the main service: filling it on a slow day is the slow-day move.
  assert.strictEqual(offlineAnswer('how do i get more people in for dinner on tuesdays').answer.tactics[0], 'slow_day_recurring_reason');
  // A dead evening is not a lull in the middle of the day.
  assert.strictEqual(pb.trafficView('dead after 9pm on weeknights').lull, false);
});

// ── 3. What the owner ruled out ─────────────────────────────────────────────

test('a move the owner says they tried, or that failed, is not offered back', () => {
  for (const [question, gone] of [
    ['ok so we opened 6 months ago and fridays are great but the rest of the week is dead, we tried a happy hour and it didnt work, what should we do', 'slow_hours_happy_hour'],
    ['we tried a happy hour and it didnt work', 'slow_hours_happy_hour'],
    ['our groupon deal flopped', 'slow_day_discount_check'],
    ['we did trivia but it flopped, any other ideas', 'events_weekly_night'],
    ['we already do trivia and happy hour, what else can we do', 'events_weekly_night'],
  ]) {
    const { answer } = offlineAnswer(question);
    assert.ok(answer, `"${question}" found no move`);
    assert.ok(!answer.tactics.includes(gone), `"${question}" offered ${gone} back: ${answer.tactics.join(', ')}`);
  }
  const listed = offlineAnswer('we tried discounts, trivia and a happy hour and nothing worked').answer;
  for (const gone of ['slow_day_discount_check', 'events_weekly_night', 'slow_hours_happy_hour']) {
    assert.ok(!listed.tactics.includes(gone), `offered ${gone}`);
  }
});

test('the tried move stays the subject when the owner asks about it', () => {
  assert.strictEqual(offlineAnswer('the happy hour didnt work, how do we make it work').answer.tactics[0], 'slow_hours_happy_hour');
  assert.strictEqual(offlineAnswer('we already have a happy hour, should i change the times').answer.tactics[0], 'slow_hours_happy_hour');
  // A goal is not a move: "tried to fill Tuesdays" rules nothing out.
  assert.deepStrictEqual(pb.ruledOut('we tried to fill tuesdays but nobody came').spans, []);
  assert.deepStrictEqual(pb.ruledOut('we tried to fill tuesdays with a happy hour').spans, [['a', 'happy', 'hour']]);
});

// ── The growth question, and three cue fixes ────────────────────────────────

test('"how do I get more customers" is the money move asked plainly', () => {
  for (const question of ['how do i get more customers', 'how do i get more business', 'how do i grow my restaurant',
    'how do i get more people through the door', 'how can i increase foot traffic']) {
    const { route, answer } = offlineAnswer(question);
    assert.deepStrictEqual(route, { mode: 'advice', intentId: 'money_move' }, question);
    assert.strictEqual(answer.tactics[0], 'slow_day_recurring_reason', question);
  }
  assert.deepStrictEqual(advisorFreeText.offlineRoute('we need more customers'), { mode: 'grounded', intentId: 'money_move' });
  assert.strictEqual(offlineAnswer('sales are down').answer.tactics[0], 'menu_new_items_no_fix');
  assert.strictEqual(offlineAnswer('how do i attract new customers').answer.tactics[0], 'mkt_listing_current');
});

test('delivery to guests is not the supplier delivery, and a labor complaint that counts tables is labor', () => {
  assert.strictEqual(offlineAnswer('should we add delivery').answer.tactics[0], 'delivery_commission_math');
  assert.strictEqual(offlineAnswer("My partner wants to add delivery but I think the fees will kill us. We do about $30 a head. Who's right?").answer.tactics[0], 'delivery_commission_math');
  assert.strictEqual(offlineAnswer('how do i check supplier deliveries').answer.tactics[0], 'food_cost_check_deliveries');
  assert.strictEqual(offlineAnswer('every sunday night we have like 4 tables and 3 servers on, im bleeding money on labor').answer.tactics[0], 'labor_schedule_from_forecast');
  // The chip questions these cues sit next to keep their routes.
  assert.deepStrictEqual(advisorFreeText.offlineRoute('do i need another server on fridays'), { mode: 'grounded', intentId: 'tables_service' });
  assert.deepStrictEqual(advisorFreeText.offlineRoute('we only had 4 tables last night'), { mode: 'grounded', intentId: 'last_night_verdict' });
});

// ── "Another option" earns its line ─────────────────────────────────────────

test('the second move is one the owner\'s words found, or one from the same topic, never a stray', () => {
  // Brunch under a Tuesday-dinner question, and a spray valve over the
  // cash-flow move the words found, were the strays.
  assert.ok(!offlineAnswer('how do i get more people in for dinner on tuesdays').answer.tactics.includes('day_brunch'));
  assert.deepStrictEqual(offlineAnswer('cash flow is tight').answer.tactics, ['costs_prime_weekly', 'weather_slow_season']);
  // A same-topic second is still offered when nothing better was found.
  assert.deepStrictEqual(offlineAnswer('is ubereats worth it').answer.tactics, ['delivery_commission_math', 'delivery_app_prices']);
  // And with no fitting second, the answer goes without one.
  const alone = offlineAnswer('my food costs went up 20%').answer;
  assert.deepStrictEqual(alone.tactics, ['food_cost_recipe_cards']);
  assert.ok(!/Another option/.test(alone.text), alone.text);
});

// ── Other kinds of room (2026-10-28 venue-kinds stress test) ────────────────

const BAR = { profile: { typical_spend_per_person: 28 }, mlVenue: { venue_category: 'bar' } };
const BAKERY = { profile: { typical_spend_per_person: 12 }, mlVenue: { venue_category: 'dessert' } };
const COUNTER = { profile: { typical_spend_per_person: 14 }, mlVenue: { venue_category: 'fast_food' } };

test('a problem stated with no question words is still a question when the playbook names it', () => {
  for (const [said, tactic, ctx] of [
    ['we sell out by noon', 'rush_prep_to_par', BAKERY],
    ['orders keep coming out wrong', 'rush_expo', COUNTER],
    ['holiday preorders', 'events_holiday_set', BAKERY],
  ]) {
    const { route, answer } = offlineAnswer(said, ctx);
    assert.deepStrictEqual(route, { mode: 'advice', intentId: null }, said);
    assert.strictEqual(answer.tactics[0], tactic, `"${said}" -> ${answer.tactics[0]}`);
  }
  // Nothing the playbook names stays unplaced, as before.
  assert.strictEqual(advisorFreeText.offlineRoute('the quick brown fox'), null);
});

test('"order" and "buy" no longer mean the supplier, and other rooms find their own moves', () => {
  assert.strictEqual(offlineAnswer('how do i get people to order more', COUNTER).answer.tactics[0], 'check_suggest_named_item');
  assert.notStrictEqual(offlineAnswer('how do i get more custom cake orders', BAKERY).answer.tactics[0], 'food_cost_supplier_quotes');
  assert.strictEqual(offlineAnswer('how do i get people to stay for another round', BAR).answer.tactics[0], 'check_suggest_named_item');
  assert.strictEqual(offlineAnswer('should we serve food', BAR).answer.tactics[0], 'day_test_first');
  assert.strictEqual(offlineAnswer('how many bartenders on a friday', BAR).answer.tactics[0], 'labor_schedule_from_forecast');
  assert.strictEqual(offlineAnswer('how much should i bake each day', BAKERY).answer.tactics[0], 'food_cost_bake_to_leftovers');
  assert.ok(offlineAnswer('should i charge for oat milk', CAFE).answer.tactics.includes('pricing_charge_extras'));
  // And the supplier move still answers a supplier question.
  assert.strictEqual(offlineAnswer('how do i get better prices from my suppliers').answer.tactics[0], 'food_cost_supplier_quotes');
});

// ── Clubs, bars, bakery wholesale and the drive-thru (13 moves, 2026-10-28) ──

const CLUB = { profile: { typical_spend_per_person: 45, age_policy: 'twenty_one_plus' }, mlVenue: { venue_category: 'nightclub' } };

test('a club owner\'s questions find the club moves, and the second option is for a club too', () => {
  for (const [said, tactic] of [
    ['how do i get more people on the dance floor', 'hosp_dance_floor_start'],
    ['should we have a dj every night', 'events_dj_by_bar_sales'],
    ['how much should the cover be', 'pricing_cover_by_demand'],
    ['how do i work with promoters', 'mkt_promoters_per_guest'],
    ['the line at the door is too long', 'rush_door_lanes'],
    ['people leave at midnight', 'events_program_leaving_hour'],
    ['how do i get more vip tables booked', 'check_vip_table_minimums'],
  ]) {
    const { answer } = offlineAnswer(said, CLUB);
    assert.ok(answer, `"${said}" found no move`);
    assert.strictEqual(answer.tactics[0], tactic, `"${said}" -> ${answer.tactics[0]}`);
    for (const id of answer.tactics.slice(1)) {
      const t = pb.tactics.find((x) => x.id === id);
      assert.ok(t.venues.includes('all') || t.venues.includes('club'), `"${said}" offered ${id}, written for ${t.venues}`);
    }
  }
});

test('taps, game days, bakery wholesale, the drive-thru and laptop campers each have their move', () => {
  assert.strictEqual(offlineAnswer('what beers should i put on tap', BAR).answer.tactics[0], 'bev_tap_keg_speed');
  assert.strictEqual(offlineAnswer('game day specials', BAR).answer.tactics[0], 'events_game_day_tables');
  assert.strictEqual(offlineAnswer('how do i get wholesale accounts', BAKERY).answer.tactics[0], 'mkt_wholesale_cafes');
  assert.strictEqual(offlineAnswer('how do i speed up the drive thru', COUNTER).answer.tactics[0], 'rush_drive_thru_stages');
  assert.strictEqual(offlineAnswer('people camp on laptops all day', CAFE).answer.tactics[0], 'turn_laptop_free_tables');
  // A cafe that does not pour never gets the tap move.
  assert.ok(!offlineAnswer('how do i sell more', CAFE).answer || !offlineAnswer('how do i sell more', CAFE).answer.tactics.includes('bev_tap_keg_speed'));
});

test('the peak chip ends on a move the room can use: the door for a club, staffing for a bar, the short menu where there is a kitchen', () => {
  const week = [['Thursday', 60], ['Friday', 88], ['Saturday', 92]].map(([weekday, peakScore], i) => ({ id: `peak_${i}`, value: { weekday, peakScore, peakHour: 23 } }));
  const block = { facts: week };
  const kindOf = (cat, profile = {}) => pb.venueOf({ profile, mlVenue: { venue_category: cat } });
  assert.strictEqual(pb.moveFor('peak_hours', block, kindOf('nightclub', { age_policy: 'twenty_one_plus' })).id, 'rush_door_lanes');
  assert.strictEqual(pb.moveFor('peak_hours', block, kindOf('bar')).id, 'labor_stagger_starts');
  for (const cat of ['restaurant', 'cafe', 'fast_food', 'dessert']) {
    assert.strictEqual(pb.moveFor('peak_hours', block, kindOf(cat)).id, 'rush_short_menu', cat);
  }
  // The slow-day chips keep their lead for every kind.
  assert.strictEqual(pb.moveFor('quiet_nights', block, kindOf('nightclub')).id, 'slow_day_recurring_reason');
});

test('every question a chip answer suggests next gets an answer with the model out, for every kind of room', () => {
  const fu = require('../services/advisorFollowUps');
  const asked = new Set(Object.values(fu.NEXT).map((n) => n.question).filter(Boolean));
  for (const s of fu.__copyStrings()) if (s !== fu.ANOTHER_MOVE) asked.add(s); // that one follows on from its answer
  const kinds = { restaurant: RESTAURANT, cafe: CAFE, bar: BAR, club: CLUB, bakery: BAKERY, counter: COUNTER };
  const dead = [];
  for (const q of asked) {
    const route = advisorFreeText.offlineRoute(q);
    if (!route) { dead.push(`${q}: no route`); continue; }
    if (route.mode === 'grounded') continue;
    for (const [name, ctx] of Object.entries(kinds)) {
      if (!pb.answer({ question: q, intentId: route.intentId, ctx })) dead.push(`${q}: nothing for a ${name}`);
    }
  }
  assert.deepStrictEqual(dead, []);
});

test('a question that names a day is answered about that day', () => {
  const DAY = (weekday, peakHour, peakScore) => ({ id: `peak_${weekday}`, value: { weekday, peakHour, peakScore }, source: 'model_holdout', asOf: '2026-11-01T22:00:00Z' });
  const week = [DAY('Monday', 18, 41), DAY('Tuesday', 18, 34), DAY('Wednesday', 19, 47), DAY('Thursday', 19, 55), DAY('Friday', 20, 82), DAY('Saturday', 20, 88)];
  const lead = (q) => pb.answer({ question: q, intentId: advisorFreeText.offlineRoute(q).intentId, ctx: RESTAURANT, groundedFacts: week }).text.split('\n')[0];
  // It used to open on the quietest day whatever day was asked about.
  assert.match(lead('How do I fill Thursdays?'), /^Thursday projects busiest around 7 PM, at 55 on our 0 to 100 index\./);
  assert.match(lead('how many servers do i need on friday'), /^Friday projects busiest around 8 PM, at 82/);
  assert.match(lead('how do I fill Tuesdays'), /^Tuesday projects as your quietest day this week\./);
  // No forecast for the named day: no lead, rather than one about another day.
  assert.ok(!/projects/.test(lead('how do i fill sundays')), lead('how do i fill sundays'));
});

test('a data question about a named day is answered about that day, from the template too', async () => {
  const advisorPhrasing = require('../services/advisorPhrasing');
  const DAY = (weekday, peakHour, peakScore, i) => ({ id: `peak_2026-11-0${i}`, value: { date: `2026-11-0${i}`, weekday, peakHour, peakScore }, unit: '0-100 index', source: 'model_holdout', asOf: '2026-11-01T22:00:00Z', label: `${weekday} projects busiest.` });
  const week = [DAY('Monday', 18, 41, 2), DAY('Tuesday', 18, 34, 3), DAY('Wednesday', 19, 47, 4), DAY('Thursday', 19, 55, 5), DAY('Friday', 20, 82, 6), DAY('Saturday', 20, 88, 7)];
  for (const q of ['how busy will friday be', 'what does thursday look like']) {
    assert.deepStrictEqual(advisorFreeText.offlineRoute(q), { mode: 'grounded', intentId: 'peak_hours' }, q);
  }
  const block = { intent: 'peak_hours', facts: week, refusals: [] };
  const lead = (q) => advisorPhrasing.renderTemplate(block, q).text.split('\n')[0];
  // It used to lead with Saturday whichever day was asked about.
  assert.strictEqual(lead('how busy will friday be'), 'Friday peaks around 8 PM at 82 on our 0 to 100 index.');
  assert.match(advisorPhrasing.renderTemplate(block, 'how is tuesday looking').text, /That makes it your quietest day this week\./);
  // A question about the week still gets the week's answer.
  assert.match(lead('when are we busiest this week'), /^Your busiest day this week is Saturday/);
});

test('date questions reach the right numbers: the past is the recap, the future the forecast, weather and events their own', () => {
  for (const [q, intentId] of [
    ['how did last weekend go', 'week_recap'],
    ['was last friday good', 'week_recap'],
    ['how does next week look', 'peak_hours'],
    ['will tomorrow be busy', 'peak_hours'],
    ['is it going to rain tomorrow', 'around_you'],
    ['is there a concert nearby this weekend', 'around_you'],
    ['are we busier than other bars nearby', 'cohort_typical'],
    ['what does the weekend look like', 'weekend_outlook'],
    ['how did we do yesterday', 'last_night_verdict'],
  ]) {
    assert.deepStrictEqual(advisorFreeText.offlineRoute(q), { mode: 'grounded', intentId }, q);
  }
});

test('a move the owner will not do is not offered, and a constraint is not mistaken for one', () => {
  const avoids = [
    ['i dont want to discount, how do i fill tuesdays', 'slow_day_discount_check'],
    ['how do i fill tuesdays without discounting', 'slow_day_discount_check'],
    ['no happy hour, what else can fill weeknights', 'slow_hours_happy_hour'],
    ['how do i fill tuesdays but not with a happy hour', 'slow_hours_happy_hour'],
    ['what can i do besides discounts', 'slow_day_discount_check'],
    ['we wont do delivery, how do we grow', 'delivery_commission_math'],
  ];
  for (const [q, gone] of avoids) {
    const { answer } = offlineAnswer(q);
    assert.ok(answer, `"${q}" found no move`);
    assert.ok(!answer.tactics.includes(gone), `"${q}" offered ${gone}`);
  }
  // Constraints and complaints keep their moves.
  assert.strictEqual(offlineAnswer('how to cut labor without hurting service').answer.tactics[0], 'labor_schedule_from_forecast');
  assert.strictEqual(offlineAnswer('how do i raise prices without losing regulars').answer.tactics[0], 'pricing_small_steps');
  assert.strictEqual(offlineAnswer('no shows are killing us').answer.tactics[0], 'res_confirm_remind');
  assert.ok(offlineAnswer('no one comes in on mondays').answer);
});
