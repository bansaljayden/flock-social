// Run: node --test  (from backend/)
//
// THE COST PANEL, AND THE ONE MISTAKE IT EXISTS TO PREVENT.
//
// A ceiling is not a bill. This repo is full of ceilings that sound like
// money — 30,000,000 tokens a day, 3,000 Places calls a day, 2,000 images a
// day — and every one of them is a bound on how bad things could get, not a
// record of anything that happened. Reading one of those as spend is a mistake
// somebody in this project has already made once, and the whole shape of
// services/costModel.js is designed so it cannot be made again in code:
//
//   buildObserved()  is handed COUNTS and nothing else.
//   buildWorstCase() is handed LIMITS and nothing else.
//
// PART 1 pins that separation directly, including the case that matters most:
// with every meter reading zero, every observed figure must be zero, no matter
// how large the ceilings are.
//
// PART 2 pins the aggregation arithmetic — the totals, the free tiers, the
// bands where a meter cannot tell two SKUs apart, and the rule that an
// unmeasured line reads as null rather than as zero.
//
// PART 3 pins the per-venue unit economics, which is the number the business
// actually turns on, and the model-pricing rule that an unknown model id is
// unpriceable rather than free.
//
// PART 4 pins the admin gate on GET /api/admin/costs. The sweep in
// adminEvidence.test.js already walks the router and covers every route, this
// one is the direct statement for this route specifically, because a cost panel
// carries vendor rates and per-venue usage and must never be readable by a
// signed-in stranger.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'cost-model-test-secret';

const cm = require('../services/costModel');

// A rate card fixture. The tests below must not depend on the real published
// prices moving, so anything checking arithmetic uses these instead.
const RATE = { inputPerMTok: 1.0, outputPerMTok: 10.0 };

// ===========================================================================
// PART 1 — a ceiling can never be rendered as observed spend
// ===========================================================================

test('with every meter at zero, every observed figure is zero, whatever the ceilings are', () => {
  // THE HEADLINE PROPERTY. Ceilings in this repo are large. If any of them
  // could leak into the observed block, this is the case that would show it:
  // nothing has been used, so nothing may be priced.
  const observed = cm.buildObserved({
    onDate: '2026-08-20',
    birdieTokensToday: 0,
    birdieModel: 'gemini-3.5-flash-lite',
    advisorTokensToday: 0,
    advisorTokensMonth: 0,
    advisorModel: 'gemini-3.7-flash',
    advisorPromptTokens: 7843,
    advisorMaxOutputTokens: 512,
    placesCallsToday: 0,
    placesPhotoCallsToday: 0,
    visionCallsToday: 0,
    weatherCallsToday: 0,
    ticketmasterCallsToday: 0,
    nightContextCallsToday: 0,
    digestEmailsMonth: 0,
  });

  assert.strictEqual(observed.todayUsd, 0, 'a day on which nothing was used costs nothing');
  assert.strictEqual(observed.todayUsdHigh, 0);
  for (const line of observed.lines) {
    assert.strictEqual(line.usd, 0, `${line.id} priced something from a zero meter`);
    if (line.usdHigh !== undefined) assert.strictEqual(line.usdHigh, 0, `${line.id} high band`);
  }
});

test('buildObserved takes no limits, and buildWorstCase takes no counts', () => {
  // The structural half. Passing the entire limits vocabulary into the observed
  // builder must change nothing, because it reads none of those keys; passing
  // the entire counts vocabulary into the worst-case builder must likewise
  // change nothing. If somebody ever "helpfully" widens either signature to
  // accept a whole meter status object, this is the test that stops them.
  const counts = {
    onDate: '2026-08-20',
    birdieTokensToday: 1000,
    birdieModel: 'gemini-3.5-flash-lite',
    advisorTokensToday: 500,
    advisorTokensMonth: 900,
    advisorModel: 'gemini-3.7-flash',
    advisorPromptTokens: 7843,
    advisorMaxOutputTokens: 512,
    placesCallsToday: 10,
    placesPhotoCallsToday: 4,
    visionCallsToday: 2,
    weatherCallsToday: 5,
    ticketmasterCallsToday: 1,
    nightContextCallsToday: 1,
    digestEmailsMonth: 0,
  };
  const limits = {
    onDate: '2026-08-20',
    birdieGlobalDailyTokens: 30_000_000,
    birdieModel: 'gemini-3.5-flash-lite',
    advisorGlobalDailyTokens: 2_000_000,
    advisorPerVenueDailyTokens: 150_000,
    advisorModel: 'gemini-3.7-flash',
    advisorPromptTokens: 7843,
    advisorMaxOutputTokens: 512,
    placesGlobalDaily: 3000,
    visionGlobalDaily: 2000,
    weatherDaily: 950,
    ticketmasterGlobalDaily: 2000,
  };

  const clean = cm.buildObserved(counts);
  const polluted = cm.buildObserved({ ...counts, ...limits });
  assert.deepStrictEqual(polluted, clean, 'a limit reached the observed block and changed a number');

  const ceilings = cm.buildWorstCase(limits);
  const pollutedCeilings = cm.buildWorstCase({ ...limits, ...counts });
  assert.deepStrictEqual(pollutedCeilings, ceilings, 'a meter reading reached the worst-case block');
});

test('observed and worst case are labelled as different kinds of number', () => {
  // Two blocks that look alike on screen have to be distinguishable in the
  // payload, or a frontend can render one under the other's heading.
  const o = cm.buildObserved({ birdieTokensToday: 0, birdieModel: 'gemini-3.5-flash-lite' });
  const w = cm.buildWorstCase({ placesGlobalDaily: 3000 });
  assert.strictEqual(o.kind, 'observed');
  assert.strictEqual(w.kind, 'worstCase');
  assert.ok(w.disclaimer.length > 0, 'the worst-case block must carry its own disclaimer');
  assert.match(w.disclaimer, /not what anything has spent/);
});

test('a worst-case month is always at least as large as a maxed-out observed day', () => {
  // The sanity check on the two builders agreeing about the same rate card:
  // one day of Places at the ceiling, priced as observed, cannot exceed the
  // month the ceiling implies.
  const cap = 3000;
  const observed = cm.buildObserved({ placesCallsToday: cap, placesPhotoCallsToday: cap });
  const worst = cm.buildWorstCase({ placesGlobalDaily: cap });
  const observedPhotos = observed.lines.find((l) => l.id === 'places-photos').usd;
  const worstLow = worst.lines.find((l) => l.id === 'places').perMonthUsd;
  assert.ok(observedPhotos > 0, 'a full day of photos costs something');
  assert.ok(worstLow > observedPhotos, 'a month of ceilings must exceed one day of them');
});

// ===========================================================================
// PART 2 — the aggregation arithmetic
// ===========================================================================

test('priceTokens splits a mixed token count at the share it is given', () => {
  // 1,000,000 tokens, a tenth of them output, at $1 in and $10 out:
  //   900,000 x $1/1M  = $0.90
  //   100,000 x $10/1M = $1.00
  assert.strictEqual(cm.priceTokens(1_000_000, 0.1, RATE), 1.9);
  // All input, all output, and the two clamps.
  assert.strictEqual(cm.priceTokens(1_000_000, 0, RATE), 1.0);
  assert.strictEqual(cm.priceTokens(1_000_000, 1, RATE), 10.0);
  assert.strictEqual(cm.priceTokens(1_000_000, 5, RATE), 10.0, 'a share above 1 clamps');
  assert.strictEqual(cm.priceTokens(1_000_000, -3, RATE), 1.0, 'a negative share clamps');
  assert.strictEqual(cm.priceTokens(-5, 0.1, RATE), 0, 'a negative token count is zero, not a credit');
  assert.strictEqual(cm.priceTokens(NaN, 0.1, RATE), 0);
});

test('priceCalls and priceCallsAfterFree', () => {
  assert.strictEqual(cm.priceCalls(1000, 7), 7);
  assert.strictEqual(cm.priceCalls(250, 20), 5);
  assert.strictEqual(cm.priceCalls(0, 35), 0);
  // The free allowance comes off the front, and it cannot go negative.
  assert.strictEqual(cm.priceCallsAfterFree(1000, 7, 1000), 0, 'the whole month inside the free tier is free');
  assert.strictEqual(cm.priceCallsAfterFree(2000, 7, 1000), 7);
  assert.strictEqual(cm.priceCallsAfterFree(2000, 7, 1000, 1000), 14, 'a spent allowance stops discounting');
  assert.strictEqual(cm.priceCallsAfterFree(500, 7, 1000), 0);
});

test('outputShareOf is derived from the two numbers the code actually passes', () => {
  assert.strictEqual(cm.outputShareOf(1000, 0), 0);
  assert.strictEqual(cm.outputShareOf(0, 1000), 1);
  assert.strictEqual(cm.outputShareOf(999, 1), 0.001);
  assert.strictEqual(cm.outputShareOf(0, 0), 0, 'no prompt and no output is not a division by zero');
});

test('an unmeasured meter reads as null, never as zero', () => {
  // The distinction the panel's empty states depend on. Zero means the meter
  // ran and counted nothing. Null means nobody counted, and a panel that prints
  // "$0.00" for a meter that never reported is lying about coverage.
  const observed = cm.buildObserved({ birdieModel: 'gemini-3.5-flash-lite' });
  for (const line of observed.lines) {
    assert.strictEqual(line.count, null, `${line.id} invented a count`);
    assert.strictEqual(line.usd, null, `${line.id} priced a count nobody supplied`);
  }
  assert.strictEqual(observed.todayUsd, 0, 'a total of no priced lines is zero');
  assert.ok(observed.unmeasuredLines.length > 0, 'the payload has to say which lines are missing');
  assert.ok(
    observed.unmeasuredLines.includes('places-photos'),
    'the photo line is the one that matters most and it must be named when absent'
  );
});

test('the Places line is a band, because the ledger does not record the SKU', () => {
  // 100 calls, 40 of them photos. The 60 remaining could have been Place
  // Details or Text Search and the meter cannot say, so the line carries both
  // ends rather than picking one.
  const observed = cm.buildObserved({ placesCallsToday: 100, placesPhotoCallsToday: 40 });
  const photos = observed.lines.find((l) => l.id === 'places-photos');
  const other = observed.lines.find((l) => l.id === 'places-other');
  assert.strictEqual(photos.count, 40);
  assert.strictEqual(other.count, 60, 'the non-photo remainder is total minus photos');
  assert.ok(other.usdHigh > other.usd, 'the band has to have two ends');
  assert.strictEqual(other.usd, cm.priceCalls(60, cm.RATES.places.skus.detailsEnterprise.perThousand));
  assert.strictEqual(other.usdHigh, cm.priceCalls(60, cm.RATES.places.skus.textSearchEnterprise.perThousand));
  assert.ok(observed.todayUsdHigh > observed.todayUsd, 'the total carries the band too');
});

test('more photo calls than total Places calls cannot produce a negative remainder', () => {
  // Reachable in production: the photo counter is charged before the shared
  // ledger agrees, and the shared ledger resets on a different code path. A
  // negative "other" would subtract money from the total.
  const observed = cm.buildObserved({ placesCallsToday: 10, placesPhotoCallsToday: 50 });
  const other = observed.lines.find((l) => l.id === 'places-other');
  assert.strictEqual(other.count, 0);
  assert.strictEqual(other.usd, 0);
  assert.ok(observed.todayUsd >= 0);
});

test('free-tier upstreams are counted and priced at zero, and say why', () => {
  const observed = cm.buildObserved({
    weatherCallsToday: 900,
    ticketmasterCallsToday: 1500,
    nightContextCallsToday: 150,
    digestEmailsMonth: 3,
  });
  const wx = observed.lines.find((l) => l.id === 'weather');
  const tm = observed.lines.find((l) => l.id === 'ticketmaster');
  const rs = observed.lines.find((l) => l.id === 'resend');
  assert.strictEqual(wx.count, 900);
  assert.strictEqual(wx.usd, 0);
  assert.strictEqual(wx.freeTier, true);
  assert.ok(wx.note && wx.note.length > 0, 'a zero has to explain itself or it reads as a missing number');
  // The two Ticketmaster ledgers are summed, because they are one vendor quota.
  assert.strictEqual(tm.count, 1650);
  assert.strictEqual(tm.usd, 0);
  assert.strictEqual(rs.count, 3);
  assert.strictEqual(rs.usd, 0);
});

test('the durable ledgers are marked durable and the in-memory ones are not', () => {
  // The panel's window labels hang off this flag. An in-memory meter reads zero
  // after a deploy, so calling its number a month would be false.
  const observed = cm.buildObserved({
    advisorTokensMonth: 10,
    advisorModel: 'gemini-3.7-flash',
    advisorPromptTokens: 7843,
    advisorMaxOutputTokens: 512,
    birdieTokensToday: 10,
    birdieModel: 'gemini-3.5-flash-lite',
    placesCallsToday: 1,
    placesPhotoCallsToday: 1,
  });
  const byId = Object.fromEntries(observed.lines.map((l) => [l.id, l]));
  assert.strictEqual(byId['gemini-roost-month'].durable, true);
  assert.strictEqual(byId['gemini-roost-month'].window, 'month to date');
  assert.strictEqual(byId['gemini-birdie'].durable, false);
  assert.match(byId['gemini-birdie'].window, /this process only/);
  assert.strictEqual(byId['places-photos'].durable, false);
  // A month-to-date line must not be added into a day total.
  assert.ok(
    !observed.todayUsd || byId['gemini-roost-month'].usd <= observed.todayUsd + 1,
    'sanity'
  );
});

test('a month-to-date line is excluded from the day total', () => {
  // The specific mixing error: advisor month-to-date is a much bigger number
  // than anything else on the panel, and adding it to "today" would make the
  // day look like the month.
  const withMonth = cm.buildObserved({
    advisorTokensToday: 0,
    advisorTokensMonth: 1_000_000,
    advisorModel: 'gemini-3.7-flash',
    advisorPromptTokens: 7843,
    advisorMaxOutputTokens: 512,
  });
  const withoutMonth = cm.buildObserved({
    advisorTokensToday: 0,
    advisorTokensMonth: 0,
    advisorModel: 'gemini-3.7-flash',
    advisorPromptTokens: 7843,
    advisorMaxOutputTokens: 512,
  });
  assert.strictEqual(withMonth.todayUsd, withoutMonth.todayUsd, 'the month leaked into the day');
  const monthLine = withMonth.lines.find((l) => l.id === 'gemini-roost-month');
  assert.ok(monthLine.usd > 0, 'the month line itself still has to be priced');
});

test('buildFixed spreads annual bills over twelve months and names its unverified lines', () => {
  const fixed = cm.buildFixed();
  const monthly = cm.FIXED_MONTHLY.reduce((s, e) => s + e.usd, 0);
  const annual = cm.FIXED_ANNUAL.reduce((s, e) => s + e.usd, 0);
  assert.strictEqual(fixed.monthlyUsd, Math.round(monthly * 100) / 100);
  assert.strictEqual(fixed.annualUsd, Math.round(annual * 100) / 100);
  assert.strictEqual(fixed.effectiveMonthlyUsd, Math.round((monthly + annual / 12) * 100) / 100);
  // One-time spend is never in a monthly figure.
  assert.ok(fixed.oneTimeUsd > 0, 'the corpus purchase is on file');
  assert.ok(fixed.effectiveMonthlyUsd < fixed.oneTimeUsd, 'a one-time cost is not a monthly cost');
  // And the honesty flag.
  for (const line of [...cm.FIXED_MONTHLY, ...cm.FIXED_ANNUAL]) {
    assert.strictEqual(typeof line.checked, 'string', `${line.id} has no checked date`);
    assert.match(line.checked, /^\d{4}-\d{2}-\d{2}$/, `${line.id} checked date is not a date`);
    if (!line.verified) {
      assert.ok(fixed.unverifiedLines.includes(line.id), `${line.id} is unverified and does not say so`);
    }
  }
});

test('every rate on the card carries a checked date and a source', () => {
  // A rate with no provenance is a number somebody made up six months ago.
  for (const [name, group] of Object.entries(cm.RATES)) {
    assert.match(group.checked, /^\d{4}-\d{2}-\d{2}$/, `RATES.${name} has no checked date`);
    assert.strictEqual(typeof group.source, 'string', `RATES.${name} has no source url`);
    assert.match(group.source, /^https:\/\//, `RATES.${name} source is not a url`);
  }
});

test('the reconciled block is the only place a billed figure lives, and it is dated', () => {
  assert.match(cm.RECONCILED.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(cm.RECONCILED.lines.length > 0);
  for (const l of cm.RECONCILED.lines) {
    assert.strictEqual(typeof l.usdPerMonth, 'number');
    assert.ok(Number.isFinite(l.usdPerMonth));
  }
});

// ===========================================================================
// PART 3 — per-venue unit economics, and unknown models
// ===========================================================================

const VENUE_ARGS = {
  onDate: '2026-08-20',
  priceUsd: 99,
  perVenueDailyTokens: 150_000,
  advisorModel: 'gemini-3.7-flash',
  advisorPromptTokens: 7843,
  advisorMaxOutputTokens: 512,
  advisorAdvicePromptTokens: 3303,
  advisorAdviceMaxOutputTokens: 2048,
};

test('one venue at its own daily ceiling costs a small fraction of what it pays', () => {
  const v = cm.buildVenueUnitEconomics(VENUE_ARGS);
  assert.strictEqual(v.priceUsd, 99);
  assert.ok(v.ceilingMonthlyUsdHigh > v.ceilingMonthlyUsdLow, 'the cost is a band, not a point');
  assert.ok(v.ceilingMonthlyUsdHigh < 99, 'a venue at its ceiling still has to be profitable');
  assert.ok(v.ceilingMarginPct > 50, 'a venue at its ceiling should not be marginal');
  // The margin is computed off the DEAR end of the band, never the cheap end.
  const expected = Math.round(((99 - v.ceilingMonthlyUsdHigh) / 99) * 1000) / 10;
  assert.strictEqual(v.ceilingMarginPct, expected, 'the margin flatters itself with the low end');
});

test('the promotional Gemini price is modelled as ending', () => {
  // gemini-3.7-flash doubles on 2027-01-01 and Roost is priced on it. A margin
  // that only holds until January is not a margin to plan on, so both are
  // carried.
  const v = cm.buildVenueUnitEconomics(VENUE_ARGS);
  assert.strictEqual(v.laterFrom, '2027-01-01');
  assert.ok(v.laterCeilingMonthlyUsd > v.ceilingMonthlyUsdHigh, 'the later price has to be higher');
  assert.ok(v.laterCeilingMarginPct < v.ceilingMarginPct);
  assert.ok(v.laterCeilingMarginPct > 0, 'the venue is still profitable after the promotion ends');
  // And the same date, read after it has passed, returns the list price.
  const after = cm.geminiRate('gemini-3.7-flash', '2027-06-01');
  assert.strictEqual(after.inputPerMTok, 1.5);
  assert.strictEqual(after.promotional, false);
  const before = cm.geminiRate('gemini-3.7-flash', '2026-08-20');
  assert.strictEqual(before.inputPerMTok, 0.75);
  assert.strictEqual(before.promotional, true);
});

test('the dearest call shape sets the top of the band, not the chip shape', () => {
  // The advice call has a shorter system prompt against a large output budget,
  // so its output fraction is higher than the chip call's, and output bills at
  // five times input. Pricing the whole cap at the chip's share understates a
  // venue that only ever types.
  const chipOnly = cm.buildVenueUnitEconomics({
    ...VENUE_ARGS,
    advisorAdvicePromptTokens: undefined,
    advisorAdviceMaxOutputTokens: undefined,
  });
  const both = cm.buildVenueUnitEconomics(VENUE_ARGS);
  assert.ok(
    both.ceilingMonthlyUsdHigh > chipOnly.ceilingMonthlyUsdHigh,
    'the advice call shape has to raise the top of the band'
  );
});

test('a venue with no measured spend reads as unmeasured, not as free', () => {
  const v = cm.buildVenueUnitEconomics({ ...VENUE_ARGS, observedTokensMonth: null });
  assert.strictEqual(v.observedTokensMonth, null);
  assert.strictEqual(v.observedMonthlyUsd, null);
  assert.strictEqual(v.observedMarginPct, null);
  // But a real zero is a real zero.
  const zero = cm.buildVenueUnitEconomics({ ...VENUE_ARGS, observedTokensMonth: 0 });
  assert.strictEqual(zero.observedMonthlyUsd, 0);
  assert.strictEqual(zero.observedMarginPct, 100);
});

test('observed per-venue spend is priced from tokens, never from the ceiling', () => {
  // The per-venue restatement of Part 1: a venue that used a tenth of its
  // allowance is charged a tenth, not the allowance.
  const tenth = cm.buildVenueUnitEconomics({ ...VENUE_ARGS, observedTokensMonth: 150_000 });
  assert.ok(tenth.observedMonthlyUsd > 0);
  assert.ok(
    tenth.observedMonthlyUsd < tenth.ceilingMonthlyUsdHigh,
    'one day of tokens must cost less than a month of them'
  );
});

test('an unknown model id is unpriceable, never free', () => {
  // BIRDIE_MODEL and ADVISOR_MODEL are raw env vars switchable from the Railway
  // dashboard with no deploy. A model this file has never heard of has to read
  // as "we cannot price this", because reading it as $0 turns a model swap into
  // an invisible spend change. services/birdieUsage.js documents that exact
  // hole in itself.
  assert.strictEqual(cm.geminiRate('gemini-9.9-imaginary', '2026-08-20'), null);
  assert.strictEqual(cm.geminiRate(undefined, '2026-08-20'), null);
  assert.strictEqual(cm.geminiRate('toString', '2026-08-20'), null, 'prototype keys are not models');

  const observed = cm.buildObserved({ birdieTokensToday: 5_000_000, birdieModel: 'gemini-9.9-imaginary' });
  const line = observed.lines.find((l) => l.id === 'gemini-birdie');
  assert.strictEqual(line.count, 5_000_000, 'the tokens were still counted');
  assert.strictEqual(line.usd, null, 'an unpriceable model must not read as free');
  assert.strictEqual(line.unpriceable, true);
  assert.ok(observed.unpriceableLines.includes('gemini-birdie'));

  const v = cm.buildVenueUnitEconomics({ ...VENUE_ARGS, advisorModel: 'gemini-9.9-imaginary' });
  assert.strictEqual(v.ceilingMonthlyUsdHigh, null);
  assert.strictEqual(v.ceilingMarginPct, null, 'a margin cannot be quoted against an unknown cost');
});

test('the Vision rate is imported from the module that owns it, not copied', () => {
  // utils/visionBudget.js already prints $1.50 per 1,000 in its own log lines.
  // Two copies of a price is how they drift.
  const { VISION_UNIT_PRICE_USD } = require('../utils/visionBudget');
  assert.strictEqual(cm.RATES.vision.perThousand, VISION_UNIT_PRICE_USD * 1000);
});

test('the Birdie output share matches what services/birdieUsage.js documents', () => {
  // That file states the measured range for itself. The cost model uses the
  // expensive end, because an estimate of a bill should not flatter itself.
  assert.strictEqual(cm.BIRDIE_OUTPUT_SHARE, 0.10);
  assert.strictEqual(cm.BIRDIE_OUTPUT_SHARE_LOW, 0.05);
  assert.ok(cm.BIRDIE_OUTPUT_SHARE > cm.BIRDIE_OUTPUT_SHARE_LOW);
  const observed = cm.buildObserved({ birdieTokensToday: 1_000_000, birdieModel: 'gemini-3.5-flash-lite' });
  const line = observed.lines.find((l) => l.id === 'gemini-birdie');
  assert.ok(line.usd > line.usdLow, 'the headline figure is the dearer of the two');
});

test('the watchlist carries no invented numbers', () => {
  // Costs that are not on a bill today. Anything that cannot be defended with a
  // figure has to be null rather than a plausible guess.
  assert.ok(cm.WATCHLIST.length > 0);
  for (const w of cm.WATCHLIST) {
    assert.strictEqual(typeof w.id, 'string');
    assert.strictEqual(typeof w.where, 'string', `${w.id} does not say where it lives`);
    assert.ok(w.note && w.note.length > 0, `${w.id} has no explanation`);
    assert.ok(w.usd === null || Number.isFinite(w.usd), `${w.id} has a usd that is neither null nor a number`);
  }
  // Pinned by id so a future sweep cannot quietly drop them.
  const ids = cm.WATCHLIST.map((w) => w.id);
  // Was 'esri-satellite', the app's one licence exposure: satellite imagery
  // pulled unkeyed from server.arcgisonline.com, which Esri does not licence
  // for commercial use. Resolved on 2026-08-20 by deleting the fallback branch
  // — it had never served a tile in production, because every shipping build
  // sets REACT_APP_MAPTILER_KEY and MapTiler hybrid won whenever it was set.
  // What replaces it on the watchlist is the dependency that removal creates:
  // MapTiler is now the ONLY satellite source, so its free-plan session cap is
  // the thing to watch. A licence question became a quota question.
  assert.ok(ids.includes('maptiler-satellite'), 'MapTiler is now the only licensed satellite source, so its cap is the exposure');
  assert.ok(!ids.includes('esri-satellite'), 'the Esri fallback is gone from App.js; it must not linger on the watchlist');
  assert.ok(ids.includes('besttime-subscription'), 'a subscription with no code path is money for nothing');
});

// ===========================================================================
// PART 4 — the admin gate on the route itself
// ===========================================================================

const pool = require('../config/database');

let handlers = [];
let log = [];

function dispatch(sql, params) {
  log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  for (const [re, fn] of handlers) {
    if (re.test(sql)) {
      const out = fn(params || [], String(sql));
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${String(sql).replace(/\s+/g, ' ').slice(0, 160)}`));
}

pool.query = (sql, params) => dispatch(sql, params);

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 9, name: 'Mod', role: 'admin' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const adminRouter = require('../routes/admin');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  CURRENT_USER = { id: 9, name: 'Mod', role: 'admin' };
});

async function get(p) {
  const res = await fetch(base + p);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

const EMPTY_LEDGERS = [
  [/FROM advisor_spend/, () => ({ rows: [{ today: '0', month: '0' }], rowCount: 1 })],
  [/FROM advisor_venue_spend/, () => ({ rows: [], rowCount: 0 })],
  [/FROM venue_digest_sends/, () => ({ rows: [{ n: 0 }], rowCount: 1 })],
  [/FROM venue_subscriptions/, () => ({ rows: [{ n: 0 }], rowCount: 1 })],
];

test('GET /costs refuses every non-admin, before it touches the database', async () => {
  for (const role of ['user', 'venue_owner', undefined, null, 'Admin', 'ADMIN']) {
    CURRENT_USER = { id: 42, name: 'Nosy', role };
    handlers = [];
    log = [];
    const res = await get('/api/admin/costs');
    assert.strictEqual(res.status, 403, `role=${String(role)} got ${res.status}`);
    assert.strictEqual(res.body.error, 'Admin access required');
    assert.deepStrictEqual(log, [], 'the panel queried the database before checking the role');
  }
});

test('GET /costs with no user at all is a refusal, not a crash', async () => {
  CURRENT_USER = undefined;
  handlers = [];
  const res = await get('/api/admin/costs');
  assert.strictEqual(res.status, 403);
  assert.deepStrictEqual(log, []);
});

test('GET /costs serves the three blocks, and an empty ledger reads as empty', async () => {
  handlers = EMPTY_LEDGERS;
  const res = await get('/api/admin/costs');
  assert.strictEqual(res.status, 200, res.text);
  const b = res.body;
  assert.strictEqual(b.observed.kind, 'observed');
  assert.strictEqual(b.worstCase.kind, 'worstCase');
  assert.strictEqual(b.fixed.kind, 'fixed');
  assert.strictEqual(b.venueUnitEconomics.kind, 'venueUnitEconomics');
  assert.ok(b.disclaimer.length > 0);
  // No venue has ever used Roost, so the observed per-venue figure is
  // unmeasured. It must not fall back to the ceiling.
  assert.strictEqual(b.venueUnitEconomics.observedTokensMonth, null);
  assert.strictEqual(b.venueUnitEconomics.observedMonthlyUsd, null);
  assert.deepStrictEqual(b.venues.perVenue, []);
  assert.strictEqual(b.venues.paying, 0);
  // The ceiling block is still populated, which is the whole point of keeping
  // them apart.
  assert.ok(b.worstCase.perMonthUsd > 0);
});

test('the per-venue spend query carries a LIMIT', async () => {
  handlers = EMPTY_LEDGERS;
  const res = await get('/api/admin/costs');
  assert.strictEqual(res.status, 200);
  const q = log.filter((x) => /FROM advisor_venue_spend/.test(x.sql));
  assert.strictEqual(q.length, 1);
  assert.match(q[0].sql, /LIMIT \d+/, 'a list query with no ceiling sizes its response by the row count');
});

test('an unreachable ledger leaves that line unmeasured and still serves the panel', async () => {
  // The fixed-cost half is worth showing when Postgres is down, and a cost
  // panel that 500s during an incident is a cost panel nobody can consult
  // during an incident.
  handlers = [[/.*/, () => Promise.reject(new Error('connection terminated'))]];
  const res = await get('/api/admin/costs');
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(res.body.fixed.effectiveMonthlyUsd > 0, 'the fixed costs survive a database outage');
  const month = res.body.observed.lines.find((l) => l.id === 'gemini-roost-month');
  assert.strictEqual(month.count, null, 'an unreadable ledger is unmeasured');
  assert.strictEqual(month.usd, null, 'and unpriced, not zero');
  assert.strictEqual(res.body.venues.perVenue, null);
});
