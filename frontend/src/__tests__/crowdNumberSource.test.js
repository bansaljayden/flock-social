/**
 * A CROWD NUMBER IS ATTRIBUTED TO THE ARITHMETIC THAT MADE IT.
 *
 * The server keeps predictionMethod 'ml' for every number the model path
 * answered, including one a serving switch made from the venue's own weekly
 * pattern and its recent live readings with no model run at all. Those
 * responses carry `numberSource` (`number_source` on the public demo), and
 * every surface that says "the Flock crowd model" must read it first. With
 * both switches off the key is absent and each surface keeps the words it
 * already had.
 */
const fs = require('fs');
const path = require('path');
const {
  numberSourcePhrase, hourlySourcePhrase, isAdjustedSource, isPatternOnlySource, peersSourcePhrase, REPORTS_ADJUSTED_WORDS,
  cardSourceLine, stripRowMethod, stripPeakBars,
  isCategoryTypicalSource, hourlyTypicalOnly, NO_CURVE_FALLBACK_METHOD,
} = require('../lib/crowd');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

test('each value the server names has plain words, and anything else has none', () => {
  expect(numberSourcePhrase('venue_pattern_live')).toBe("this venue's usual pattern and its recent live readings");
  expect(numberSourcePhrase('venue_pattern')).toBe("this venue's usual pattern");
  expect(numberSourcePhrase('model_live')).toBe("the Flock crowd model and this venue's recent live readings");
  expect(numberSourcePhrase('model_alone')).toBe('the Flock crowd model alone');
  for (const v of [undefined, null, '', 'ml', 'model', 'curve_offset', 'toString', '__proto__',
    'live_reading', 'live_reading_0h', 'live_reading_13h', 'live_reading_1', 'xlive_reading_1h']) {
    expect(numberSourcePhrase(v)).toBeNull();
  }
});

test('a number that is a carried live reading says so, with its age', () => {
  expect(numberSourcePhrase('live_reading_1h')).toBe("this venue's live reading taken an hour ago");
  expect(numberSourcePhrase('live_reading_2h')).toBe("this venue's live reading taken 2 hours ago");
  expect(numberSourcePhrase('live_reading_12h')).toBe("this venue's live reading taken 12 hours ago");
});

test('a number visitor reports adjusted is never worded as the reading itself, nor as people there now', () => {
  // A reading of 20 blended to 35 by verified reporters.
  expect(numberSourcePhrase('live_reading_1h_adjusted'))
    .toBe("this venue's live reading taken an hour ago, adjusted by visitor reports from this time of week over the last four weeks");
  expect(numberSourcePhrase('live_reading_3h_adjusted'))
    .toBe("this venue's live reading taken 3 hours ago, adjusted by visitor reports from this time of week over the last four weeks");
  expect(numberSourcePhrase('venue_pattern_live_adjusted'))
    .toBe("this venue's usual pattern and its recent live readings, adjusted by visitor reports from this time of week over the last four weeks");
  expect(numberSourcePhrase('venue_pattern_adjusted')).toBe("this venue's usual pattern, adjusted by visitor reports from this time of week over the last four weeks");
  expect(numberSourcePhrase('model_live_adjusted'))
    .toBe("the Flock crowd model and this venue's recent live readings, adjusted by visitor reports from this time of week over the last four weeks");
  // Not "alone" once visitor reports moved it.
  expect(numberSourcePhrase('model_alone_adjusted')).toBe('the Flock crowd model, adjusted by visitor reports from this time of week over the last four weeks');
  for (const v of ['_adjusted', 'ml_adjusted', 'live_reading_13h_adjusted', 'live_reading_1h_adjusted_adjusted', 'toString_adjusted']) {
    expect(numberSourcePhrase(v)).toBeNull();
  }
  expect(isAdjustedSource('live_reading_1h_adjusted')).toBe(true);
  expect(isAdjustedSource('venue_pattern_adjusted')).toBe(true);
  for (const v of ['live_reading_1h', 'venue_pattern', 'ml_adjusted', undefined, null, '']) {
    expect(isAdjustedSource(v)).toBe(false);
  }
});

const EM_DASH = new RegExp(String.fromCharCode(0x2014));
test('no phrase carries an em dash', () => {
  for (const v of ['venue_pattern_live', 'venue_pattern', 'model_live', 'model_alone', 'live_reading_1h', 'live_reading_3h',
    'live_reading_1h_adjusted', 'model_alone_adjusted', 'venue_pattern_live_adjusted']) {
    expect(numberSourcePhrase(v)).not.toMatch(EM_DASH);
  }
});

describe('the hourly chart caption comes from the bars drawn', () => {
  const ml = (numberSource) => (numberSource ? { predictionMethod: 'ml', numberSource } : { predictionMethod: 'ml' });
  const rule = { predictionMethod: 'rule_engine_no_baseline' };

  test('no bar with a source keeps the old caption (both switches off)', () => {
    expect(hourlySourcePhrase([ml(), ml(), rule])).toBeNull();
    expect(hourlySourcePhrase([])).toBeNull();
    expect(hourlySourcePhrase(null)).toBeNull();
    expect(hourlySourcePhrase([ml('something_new')])).toBeNull();
  });

  test('bars that all share one source take its words', () => {
    expect(hourlySourcePhrase([ml('venue_pattern_live'), ml('venue_pattern_live')])).toBe(numberSourcePhrase('venue_pattern_live'));
    expect(hourlySourcePhrase([ml('live_reading_1h')])).toBe("this venue's live reading taken an hour ago");
  });

  test('a rule-engine bar beside named bars is said to be typical, never credited to the pattern', () => {
    // curve_offset on: the current hour had no baseline and the rule engine
    // answered it, every later bar is the venue's pattern.
    expect(hourlySourcePhrase([rule, ml('venue_pattern'), ml('venue_pattern')]))
      .toBe("this venue's usual pattern, and in hours not measured here yet, what is typical for a venue like yours");
    expect(hourlySourcePhrase([rule, ml('venue_pattern_live'), ml('venue_pattern')]))
      .toBe("this venue's usual pattern, with this venue's recent live readings in some hours, and in hours not measured here yet, what is typical for a venue like yours");
  });

  test('live readings come from each bar\'s own yes or no, never from a missing source', () => {
    const on = (numberSource, liveReadings) => ({ predictionMethod: 'ml', ...(numberSource ? { numberSource } : {}), liveReadings });
    // The server names no source for an hour whose live offset landed on the
    // stored offset's score, and says yes to live readings for it. Read from
    // absence, this strip was "in some hours"; every bar used live readings.
    expect(hourlySourcePhrase([on(null, true), on(null, true), on('live_reading_1h', true)]))
      .toBe("the Flock crowd model and this venue's recent live readings");
    expect(hourlySourcePhrase([on('model_live', true), on(null, true)]))
      .toBe("the Flock crowd model and this venue's recent live readings");
    // A no is a no.
    expect(hourlySourcePhrase([on('model_live', true), on(null, false)]))
      .toBe("the Flock crowd model, with this venue's recent live readings in some hours");
    expect(hourlySourcePhrase([on('model_alone', false), on(null, false)])).toBe('the Flock crowd model');
    // A rule-engine hour is a no whatever it says.
    expect(hourlySourcePhrase([{ predictionMethod: 'rule_engine_fallback', liveReadings: false }, on('venue_pattern_live', true)]))
      .toBe("this venue's usual pattern and its recent live readings, and in hours not measured here yet, what is typical for a venue like yours");
  });

  test('live readings are named for every bar, some bars, or none, as the bars say', () => {
    // The current hour used a reading; the evening had none to use.
    expect(hourlySourcePhrase([ml('model_live'), ml(), ml()]))
      .toBe("the Flock crowd model, with this venue's recent live readings in some hours");
    expect(hourlySourcePhrase([ml('venue_pattern_live'), ml('venue_pattern')]))
      .toBe("this venue's usual pattern, with this venue's recent live readings in some hours");
    expect(hourlySourcePhrase([ml('live_reading_1h'), ml('model_live')]))
      .toBe("the Flock crowd model and this venue's recent live readings");
    expect(hourlySourcePhrase([ml('model_alone'), ml()])).toBe('the Flock crowd model');
    expect(hourlySourcePhrase([ml('live_reading_1h'), ml('live_reading_2h')])).toBe("this venue's live readings from earlier hours");
  });

  test('no caption carries an em dash', () => {
    const sets = [[ml('model_live'), ml()], [ml('venue_pattern_live'), ml('venue_pattern')], [ml('live_reading_1h'), ml('live_reading_2h')],
      [rule, ml('venue_pattern')]];
    for (const s of sets) expect(hourlySourcePhrase(s)).not.toMatch(EM_DASH);
  });
});

test('every surface that credits the crowd model reads the number source first', () => {
  const card = read('components/venue/ConsumerVenueCard.js');
  // The line under the dial is chosen by lib/crowd cardSourceLine, which is
  // exercised with real payloads below.
  expect(card).toMatch(/\{cardSourceLine\(cd\)\}/);
  // The blended reports come from a four-week window for this time of week,
  // so no line may say the people adjusting the number are there now.
  expect(card).not.toMatch(/adjusted by people who are there/);
  expect(card).not.toMatch(/From the crowd model, /);
  // A number that is the venue's pattern alone is not LIVE.
  expect(card).toMatch(/if \(isPatternOnlySource\(cd\.numberSource\)\) return false;/);

  const insights = read('components/VenueInsightCards.js');
  // The hourly charts read the bars they draw FIRST, before the current
  // score's model version: a rule-engine current hour must not caption
  // pattern bars as the rule engine's.
  expect(insights).toMatch(/\{hourlySourcePhrase\(hourly\)\s*\? `Today hour by hour, our estimate from \$\{hourlySourcePhrase\(hourly\)\}\.`\s*: intel\?\.model/);
  expect(insights).not.toMatch(/intel\.numberSource/);

  const dashboard = read('screens/VenueDashboard.js');
  expect(dashboard).toMatch(/\{hourlySourcePhrase\(venueIntel\.todayHourly\)\s*\? `From \$\{hourlySourcePhrase\(venueIntel\.todayHourly\)\}\.`\s*: venueIntel\.model\s*\? `Flock crowd model v\$\{venueIntel\.model\}`\s*: 'Flock rule engine/);
  expect(dashboard).not.toMatch(/venueIntel\.numberSource/);

  const demo = read('website/LiveDemo.js');
  // The note under the chart reads the bars drawn as a crowd first, and the
  // headline's source only when no chart is drawn.
  expect(demo).toMatch(/const crowdBars = hourly\.filter\(\(h\) => h && h\.open !== false\);/);
  expect(demo).toMatch(/const madeFrom = crowdBars\.length\s*\? hourlySourcePhrase\(crowdBars, \{ reader: 'visitor' \}\)\s*: numberSourcePhrase\(selected\?\.number_source\);/);
  // A chart (or, with none drawn, a headline) that is only what is typical for
  // this kind of place is said to be from that, never "Live", and draws no
  // live dot.
  expect(demo).toMatch(/const typicalOnly = crowdBars\.length\s*\? hourlyTypicalOnly\(crowdBars\)\s*: isCategoryTypicalSource\(selected\?\.number_source\);/);
  expect(demo).toMatch(/\{madeFrom\s*\? \(typicalOnly \? `From \$\{madeFrom\}` : `Live from \$\{madeFrom\}`\)\s*: 'Live from the model inside Flock'\}/);
  expect(demo).toMatch(/\{!typicalOnly && \(\s*<span\s*key=\{`\$\{venueName\(selected\)\}\|\$\{selected\.fetched_at \|\| ''\}`\}\s*className="lpd-live-dot"/);
  expect(demo).not.toMatch(/`Live from \$\{numberSourcePhrase\(selected\.number_source\)\}`/);

  // The strip's caption reads each row's peak, not the model by default.
  expect(dashboard).toMatch(/peersSourcePhrase\(stripPeakBars\(\[venueStrip\.you, \.\.\.\(venueStrip\.competitors \|\| \[\]\)\]\)\)/);
  // Each row's label reads what made its peak, not its current hour.
  expect(dashboard).toMatch(/\{stripRowMethod\(v\) && stripRowMethod\(v\) !== 'ml' && \(/);
  expect(dashboard).not.toMatch(/v\.method && v\.method !== 'ml'/);
  // (Which peaks, evening or the whole day, follows the strip's own window;
  // stripWindowWords.test.js holds that part.)
  expect(dashboard).toMatch(/\{stripPeaksFrom\s*\? `Projected \$\{stripAllDay \? 'peaks today' : 'evening peaks'\} within 1\.5 km, from \$\{stripPeaksFrom\}\.`\s*: `Projected \$\{stripAllDay \? 'peaks today' : 'evening peaks'\} within 1\.5 km, from Flock's crowd model\.`\}/);
});

describe('the card\'s line under the dial names the engine that actually scored it', () => {
  const R = REPORTS_ADJUSTED_WORDS;
  test('visitor reports blended into a rule-engine number never credit the crowd model', () => {
    // No ML baseline, three verified reports: the rule engine's number,
    // blended. Both switches off, so no numberSource.
    for (const pm of ['rule_engine', 'rule_engine_no_baseline', 'rule_engine_fallback', 'rule_engine_baseline_refused', null, undefined]) {
      const line = cardSourceLine({ confidenceBasis: 'user_reports', predictionMethod: pm });
      expect(line).toBe(`From what is typical for a venue like this, ${R}.`);
      expect(line).not.toMatch(/model/);
    }
  });

  test('the switched-off lines for a model number keep their words exactly', () => {
    expect(cardSourceLine({ confidenceBasis: 'user_reports', predictionMethod: 'ml' })).toBe(`From the crowd model, ${R}.`);
    expect(cardSourceLine({ confidenceBasis: 'model_holdout', predictionMethod: 'ml' })).toBe('From the Flock crowd model.');
    expect(cardSourceLine({ confidenceBasis: 'model_unverified_axis', predictionMethod: 'ml' })).toBe('From the Flock crowd model.');
    expect(cardSourceLine({ confidenceBasis: 'category_pattern', predictionMethod: 'rule_engine' }))
      .toBe('An estimate from typical patterns for this kind of place.');
    expect(cardSourceLine({ confidenceBasis: 'owner_report', predictionMethod: 'owner_report', ownerReport: { noun: 'cafe' } }))
      .toBe('From the cafe itself, not a Flock estimate.');
    expect(cardSourceLine({ confidenceBasis: 'owner_report', predictionMethod: 'owner_report' }))
      .toBe('From the venue itself, not a Flock estimate.');
    expect(cardSourceLine(null)).toBeNull();
  });

  test('a named source says what made the number, and the reports words once', () => {
    expect(cardSourceLine({ confidenceBasis: 'model_holdout', predictionMethod: 'ml', numberSource: 'venue_pattern' }))
      .toBe("From this venue's usual pattern.");
    expect(cardSourceLine({ confidenceBasis: 'user_reports', predictionMethod: 'ml', numberSource: 'live_reading_1h_adjusted' }))
      .toBe(`From this venue's live reading taken an hour ago, ${R}.`);
    expect(cardSourceLine({ confidenceBasis: 'user_reports', predictionMethod: 'ml', numberSource: 'venue_pattern' }))
      .toBe(`From this venue's usual pattern, ${R}.`);
  });

  test('no card line carries an em dash', () => {
    const payloads = [
      { confidenceBasis: 'user_reports', predictionMethod: 'rule_engine' },
      { confidenceBasis: 'user_reports', predictionMethod: 'ml' },
      { confidenceBasis: 'model_holdout', predictionMethod: 'ml', numberSource: 'venue_pattern_live' },
    ];
    for (const p of payloads) expect(cardSourceLine(p)).not.toMatch(EM_DASH);
  });
});

test('a visitor is never addressed as the venue in the demo\'s caption', () => {
  const rule = { predictionMethod: 'rule_engine_no_baseline', liveReadings: false };
  const bars = [{ predictionMethod: 'ml', numberSource: 'venue_pattern', liveReadings: false }, rule];
  expect(hourlySourcePhrase(bars, { reader: 'visitor' }))
    .toBe("this venue's usual pattern, and in hours not measured there yet, what is typical for a venue like this one");
  expect(hourlySourcePhrase(bars)).toMatch(/a venue like yours$/);
  expect(hourlySourcePhrase(bars, { reader: 'visitor' })).not.toMatch(/yours/);
});

test('the reports words say when the reports are from, never that people are there now', () => {
  expect(REPORTS_ADJUSTED_WORDS).toBe('adjusted by visitor reports from this time of week over the last four weeks');
  expect(REPORTS_ADJUSTED_WORDS).not.toMatch(/who are there|right now|\bnow\b/);
  expect(REPORTS_ADJUSTED_WORDS).not.toMatch(EM_DASH);
});

test('only the pattern alone, adjusted or not, is a pattern-only source', () => {
  expect(isPatternOnlySource('venue_pattern')).toBe(true);
  expect(isPatternOnlySource('venue_pattern_adjusted')).toBe(true);
  for (const v of ['venue_pattern_live', 'venue_pattern_live_adjusted', 'model_alone', 'model_live', 'live_reading_1h', undefined, null, '', 'ml']) {
    expect(isPatternOnlySource(v)).toBe(false);
  }
});

describe('the strip of nearby peaks is captioned from the rows drawn, one per venue', () => {
  const row = (numberSource, liveReadings, predictionMethod = 'ml') => ({ predictionMethod, ...(numberSource ? { numberSource } : {}), liveReadings });

  test('no row with a source and no rule-engine peak keeps the old caption (both switches off, or all model)', () => {
    expect(peersSourcePhrase([])).toBeNull();
    expect(peersSourcePhrase(null)).toBeNull();
    expect(peersSourcePhrase([row(null, true), row(null, false)])).toBeNull();
  });

  test('a rule-engine peak is never captioned as the crowd model\'s', () => {
    // Every peak the rule engine's: nothing the model made is on the strip.
    expect(peersSourcePhrase([row(null, false, 'rule_engine_no_baseline'), row(null, false, 'rule_engine')]))
      .toBe("what is typical for each venue's category");
    // A source on a rule-engine row is not read as the row's arithmetic.
    expect(peersSourcePhrase([row('venue_pattern', false, 'rule_engine_no_baseline')]))
      .toBe("what is typical for each venue's category");
    // Model peaks beside rule-engine ones name both.
    expect(peersSourcePhrase([row(null, false), row(null, false, 'rule_engine_no_baseline')]))
      .toBe('the Flock crowd model, or what is typical for the category where a row says so');
    expect(peersSourcePhrase([row('venue_pattern', false), row(null, false, 'rule_engine')]))
      .toBe("each venue's usual pattern, or what is typical for the category where a row says so");
  });

  test('a row whose current hour is the model\'s but whose peak is the rule engine\'s is labelled and captioned off the peak', () => {
    const switchedRow = { name: 'Next Door', method: 'ml', peakScore: 70, peakMethod: 'rule_engine_no_baseline', peakLiveReadings: false };
    const you = { name: 'You', method: 'ml', peakScore: 60, peakMethod: 'ml', peakNumberSource: 'venue_pattern', peakLiveReadings: false };
    expect(stripRowMethod(switchedRow)).toBe('rule_engine_no_baseline');
    expect(stripRowMethod(you)).toBe('ml');
    const caption = peersSourcePhrase(stripPeakBars([you, switchedRow]));
    expect(caption).toBe("each venue's usual pattern, or what is typical for the category where a row says so");
    expect(peersSourcePhrase(stripPeakBars([{ ...you, peakMethod: 'rule_engine', peakNumberSource: undefined }, switchedRow])))
      .toBe("what is typical for each venue's category");
  });

  test('with both switches off the rows keep their labels and the caption its words', () => {
    // No row carries a peak field then: the current method decides the label
    // and no bar reaches the caption.
    const offRows = [{ name: 'You', method: 'ml', peakScore: 60 }, { name: 'Them', method: 'rule_engine', peakScore: 40 }];
    expect(stripRowMethod(offRows[0])).toBe('ml');
    expect(stripRowMethod(offRows[1])).toBe('rule_engine');
    expect(stripPeakBars(offRows)).toEqual([]);
    expect(peersSourcePhrase(stripPeakBars(offRows))).toBeNull();
    expect(stripRowMethod(null)).toBeNull();
  });

  test('the pattern is each venue\'s, never "this venue\'s"', () => {
    expect(peersSourcePhrase([row('venue_pattern', false), row('venue_pattern', false)])).toBe("each venue's usual pattern");
    expect(peersSourcePhrase([row('venue_pattern_live', true), row('venue_pattern_live', true)]))
      .toBe("each venue's usual pattern and recent live readings");
    expect(peersSourcePhrase([row('venue_pattern_live', true), row('venue_pattern', false)]))
      .toBe("each venue's usual pattern, with recent live readings for some venues");
  });

  test('model rows beside pattern rows name both, and carried readings are named as readings', () => {
    expect(peersSourcePhrase([row('venue_pattern', false), row(null, false)]))
      .toBe("each venue's usual pattern or the Flock crowd model");
    expect(peersSourcePhrase([row('live_reading_2h', true), row('live_reading_1h', true)])).toBe('live readings from earlier hours');
    expect(peersSourcePhrase([row('venue_pattern', false), row('live_reading_1h', true)]))
      .toBe("each venue's usual pattern, or a live reading from an earlier hour");
  });

  test('no strip caption says "this venue" or carries an em dash', () => {
    const sets = [[row('venue_pattern', false)], [row('venue_pattern_live', true), row(null, false)], [row('live_reading_3h', true)]];
    for (const s of sets) {
      expect(peersSourcePhrase(s)).not.toMatch(/this venue/);
      expect(peersSourcePhrase(s)).not.toMatch(EM_DASH);
    }
  });
});

// ---------------------------------------------------------------------------
// THE NO-CURVE FALLBACK. With CROWD_NO_CURVE_FALLBACK on, the server gives a
// venue with no curve of its own the artifact's typical level for its
// category at that weekday and hour: predictionMethod
// 'category_curve_no_baseline', numberSource 'category_typical'. Every
// surface says what that is, typical for this kind of place at that hour, and
// never this venue's pattern, the model or a live reading.
// ---------------------------------------------------------------------------
describe('the category table\'s number is typical for this kind of place, never this venue, the model or live', () => {
  const R = REPORTS_ADJUSTED_WORDS;
  const NOT_THIS_VENUE = /this venue|crowd model|\blive\b|usual pattern/;

  test('its method is the server\'s, and its source has its own words, adjusted or not', () => {
    expect(NO_CURVE_FALLBACK_METHOD).toBe('category_curve_no_baseline');
    expect(numberSourcePhrase('category_typical')).toBe('what is typical for this kind of place at this hour of the week');
    expect(numberSourcePhrase('category_typical_adjusted'))
      .toBe(`what is typical for this kind of place at this hour of the week, ${R}`);
    for (const v of ['category_typical', 'category_typical_adjusted']) {
      expect(numberSourcePhrase(v)).not.toMatch(NOT_THIS_VENUE);
      expect(numberSourcePhrase(v)).not.toMatch(EM_DASH);
      expect(isCategoryTypicalSource(v)).toBe(true);
      expect(isPatternOnlySource(v)).toBe(false);
    }
    expect(isAdjustedSource('category_typical_adjusted')).toBe(true);
    for (const v of ['venue_pattern', 'model_alone', 'live_reading_1h', 'category', 'category_pattern', undefined, null, '']) {
      expect(isCategoryTypicalSource(v)).toBe(false);
    }
  });

  test('the card\'s line says what is typical for this kind of place, with visitor reports or without', () => {
    const card = { predictionMethod: NO_CURVE_FALLBACK_METHOD, confidenceBasis: 'category_pattern', numberSource: 'category_typical' };
    expect(cardSourceLine(card)).toBe('From what is typical for this kind of place at this hour of the week.');
    const blended = { predictionMethod: NO_CURVE_FALLBACK_METHOD, confidenceBasis: 'user_reports', numberSource: 'category_typical_adjusted' };
    expect(cardSourceLine(blended)).toBe(`From what is typical for this kind of place at this hour of the week, ${R}.`);
    // A payload that carries the method and no source (a surface that does
    // not forward numberSource) is still not the model's, and keeps the
    // category words it always had.
    expect(cardSourceLine({ predictionMethod: NO_CURVE_FALLBACK_METHOD, confidenceBasis: 'category_pattern' }))
      .toBe('An estimate from typical patterns for this kind of place.');
    expect(cardSourceLine({ predictionMethod: NO_CURVE_FALLBACK_METHOD, confidenceBasis: 'user_reports' }))
      .toBe(`From what is typical for a venue like this, ${R}.`);
    for (const p of [card, blended]) {
      expect(cardSourceLine(p)).not.toMatch(NOT_THIS_VENUE);
      expect(cardSourceLine(p)).not.toMatch(EM_DASH);
    }
  });

  test('a chart of its hours says every bar is typical for this kind of place, for an owner or a visitor', () => {
    const typical = { predictionMethod: NO_CURVE_FALLBACK_METHOD, numberSource: 'category_typical', liveReadings: false };
    const rule = { predictionMethod: 'rule_engine_no_baseline', liveReadings: false };
    const words = 'what is typical for this kind of place at each hour of the week';
    expect(hourlySourcePhrase([typical, typical, typical])).toBe(words);
    expect(hourlySourcePhrase([typical, typical], { reader: 'visitor' })).toBe(words);
    // An hour the rule engine made beside them is typical for a venue like
    // this too, so the same words are true of every bar.
    expect(hourlySourcePhrase([rule, typical, typical])).toBe(words);
    expect(hourlyTypicalOnly([typical, typical])).toBe(true);
    expect(hourlyTypicalOnly([rule, typical])).toBe(true);
    expect(hourlySourcePhrase([typical])).not.toMatch(NOT_THIS_VENUE);
    // With no category bar and no other source, the chart keeps its old caption.
    expect(hourlySourcePhrase([rule, rule])).toBeNull();
    expect(hourlyTypicalOnly([rule, rule])).toBe(false);
  });

  test('beside bars measured at this venue its hours take the not-measured-here words, and the chart is not typical-only', () => {
    const typical = { predictionMethod: NO_CURVE_FALLBACK_METHOD, numberSource: 'category_typical', liveReadings: false };
    const pattern = { predictionMethod: 'ml', numberSource: 'venue_pattern', liveReadings: false };
    expect(hourlySourcePhrase([pattern, typical]))
      .toBe("this venue's usual pattern, and in hours not measured here yet, what is typical for a venue like yours");
    expect(hourlySourcePhrase([pattern, typical], { reader: 'visitor' }))
      .toBe("this venue's usual pattern, and in hours not measured there yet, what is typical for a venue like this one");
    expect(hourlyTypicalOnly([pattern, typical])).toBe(false);
    expect(hourlyTypicalOnly([pattern])).toBe(false);
    expect(hourlyTypicalOnly(null)).toBe(false);
  });

  test('on the strip of nearby peaks its rows are typical for the category, and never credited to the model', () => {
    const row = (predictionMethod, numberSource) => ({ predictionMethod, ...(numberSource ? { numberSource } : {}), liveReadings: false });
    expect(peersSourcePhrase([row(NO_CURVE_FALLBACK_METHOD, 'category_typical'), row(NO_CURVE_FALLBACK_METHOD, 'category_typical')]))
      .toBe("what is typical for each venue's category");
    expect(peersSourcePhrase([row('ml', 'venue_pattern'), row(NO_CURVE_FALLBACK_METHOD, 'category_typical')]))
      .toBe("each venue's usual pattern, or what is typical for the category where a row says so");
    const strip = { name: 'Next Door', method: NO_CURVE_FALLBACK_METHOD, peakMethod: NO_CURVE_FALLBACK_METHOD, peakNumberSource: 'category_typical', peakLiveReadings: false };
    expect(stripRowMethod(strip)).toBe(NO_CURVE_FALLBACK_METHOD);
    expect(stripRowMethod({ name: 'Next Door', method: NO_CURVE_FALLBACK_METHOD })).not.toBe('ml');
  });
});
