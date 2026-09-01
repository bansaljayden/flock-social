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
    placesPhotoCallsMonth: 0,
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
    placesPhotoCallsMonth: 40,
  });
  const byId = Object.fromEntries(observed.lines.map((l) => [l.id, l]));
  assert.strictEqual(byId['gemini-roost-month'].durable, true);
  assert.strictEqual(byId['gemini-roost-month'].window, 'month to date');
  assert.strictEqual(byId['gemini-birdie'].durable, false);
  assert.match(byId['gemini-birdie'].window, /this process only/);
  // Both photo lines are durable as of migration 046: they come from
  // places_photo_spend rather than from a module-scope integer, which is what
  // makes a month-to-date photo figure sayable at all. The Text Search and
  // Place Details remainder is still a heap counter and still is not.
  assert.strictEqual(byId['places-photos'].durable, true);
  assert.strictEqual(byId['places-photos'].window, 'today');
  assert.strictEqual(byId['places-photos-month'].durable, true);
  assert.strictEqual(byId['places-photos-month'].window, 'month to date');
  assert.strictEqual(byId['places-other'].durable, false);
  // The free tier is real money and is applied on the month line, so 40 photos
  // in a month whose first 1,000 are free costs nothing.
  assert.strictEqual(byId['places-photos-month'].usd, 0);
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
  // BestTime left the watchlist on 2026-09-01 by being answered rather than by
  // being ignored. It sat here as "a subscription with no code path is money for
  // nothing" while that was true. It stopped being true when collection
  // restarted on a Package 100 plan behind a nightly Railway cron, so it is now
  // a known recurring bill with a figure, and a known bill on the watchlist
  // would be the same category error in the other direction.
  assert.ok(!ids.includes('besttime-subscription'), 'BestTime is a known recurring bill now, so it belongs on the fixed list rather than the watchlist');
  const besttime = cm.FIXED_MONTHLY.find((e) => e.id === 'besttime-subscription');
  assert.ok(besttime && besttime.verified && besttime.usd > 0, 'the BestTime subscription must carry a verified figure on the fixed list');
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
  [/FROM push_sends/, () => ({ rows: [], rowCount: 0 })],
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

// PUSH IS THE ONE SUBSYSTEM WHOSE FAILURE IS SILENT, and until this block
// existed the panel that reads every other meter read none of its rows.
// Migration 050 created push_sends specifically so "has a notification ever
// been delivered in production" could be answered, services/pushHelper.js has
// returned the rollup since, and nothing called it: the table was write-only
// for its whole life, which is the same amount of evidence as not having built
// it. This pins the reader, and pins that an empty ledger reads as empty rather
// than as absent, because those are different answers.
test('GET /costs serves the push delivery ledger, and an empty one reads as zero rather than as missing', async () => {
  handlers = EMPTY_LEDGERS;
  const res = await get('/api/admin/costs');
  assert.strictEqual(res.status, 200, res.text);
  const pd = res.body.pushDelivery;
  assert.ok(pd, 'the block is present, not dropped on the floor between the query and the payload');
  assert.strictEqual(pd.days, 7);
  assert.deepStrictEqual(pd.byTypeAndOutcome, []);
  assert.strictEqual(pd.totals.attempts, 0);
  assert.strictEqual(pd.totals.delivered, 0);
  // Separate from the counts on purpose: zero rows on a server with no
  // FIREBASE_SERVICE_ACCOUNT means push is off, and zero rows on a server that
  // has one means push is on and nothing went out. The ledger cannot tell those
  // apart and they are not the same fact.
  assert.strictEqual(typeof pd.configured, 'boolean');
});

test('an unreadable push ledger leaves the block absent rather than reporting zero deliveries', async () => {
  handlers = [
    ...EMPTY_LEDGERS.filter(([re]) => !re.test('FROM push_sends')),
    [/FROM push_sends/, () => Promise.reject(new Error('relation does not exist'))],
  ];
  const res = await get('/api/admin/costs');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.pushDelivery, null,
    'a panel that prints 0 delivered when it could not read the table is reporting an outage as a product failure');
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

// ===========================================================================
// PART 5, the inventory, and the rule that a $0 has to say which $0 it is
// ===========================================================================
//
// The blocks above answer "what does this cost". They are organised by how far
// a number can be trusted, so a vendor that charges nothing lands in whichever
// of them happens to mention it, and six of them landed in none: PostHog,
// Sentry, RevenueCat, push, Google Sign-In and Sign in with Apple were all on
// the rate card and on no screen. DEPENDENCIES answers the other question, the
// one an owner actually asks, which is what do I depend on.
//
// The failure mode this part exists to prevent is a list that goes quietly
// incomplete. A new vendor gets a rate on the card, or a new exposure gets a
// watchlist entry, and the inventory never hears about it, so the screen whose
// whole purpose is completeness is the last place the new dependency appears.
// The coverage tests below make that a failing build rather than a discovery.

const DEPS = cm.buildDependencies({
  birdieModel: 'gemini-3.5-flash-lite',
  advisorModel: 'gemini-3.7-flash',
});
const ALL_DEPS = DEPS.groups.flatMap((g) => g.entries);

test('every dependency says what it is, where it lives and which group it is in', () => {
  assert.ok(ALL_DEPS.length > 0);
  const seen = new Set();
  for (const d of ALL_DEPS) {
    assert.strictEqual(typeof d.id, 'string', 'a dependency has no id');
    assert.ok(!seen.has(d.id), `${d.id} appears twice`);
    seen.add(d.id);
    assert.ok(d.label && d.label.length > 0, `${d.id} has no label`);
    assert.ok(d.what && d.what.length > 0, `${d.id} does not say what it is`);
    assert.ok(d.where && d.where.length > 0, `${d.id} does not say where it lives`);
    assert.ok(['metered', 'fixed', 'free'].includes(d.group), `${d.id} is in no group`);
  }
});

test('a dependency that quotes a price also carries the source and the date it was checked', () => {
  // A rate with no provenance is a number somebody made up six months ago.
  // Same rule the rate card itself is held to further up this file.
  for (const d of ALL_DEPS) {
    if (!d.unitPrice && !d.freeTier) continue;
    assert.ok(d.source, `${d.id} quotes a price with no source`);
    assert.match(d.source, /^https:\/\//, `${d.id} source is not a url`);
    assert.match(d.checked || '', /^\d{4}-\d{2}-\d{2}$/, `${d.id} has no checked date`);
  }
});

test('the inventory carries join keys, never a second copy of a number', () => {
  // Its whole defence against drift is that it owns no figures. The last time
  // a vendor list in this repo owned its own numbers (the expense array in
  // frontend/src/App.js) it went five vendors out of date.
  for (const d of ALL_DEPS) {
    for (const [k, v] of Object.entries(d)) {
      if (k === 'unitPrice' || k === 'freeTier') continue; // formatted FROM the rate card
      assert.ok(typeof v !== 'number', `${d.id} carries a bare number in ${k}`);
    }
  }
});

test('every join key points at something that exists', () => {
  const observed = cm.buildObserved({});
  const observedIds = new Set(observed.lines.map((l) => l.id));
  const fixedIds = new Set(
    [...cm.FIXED_MONTHLY, ...cm.FIXED_ANNUAL, ...cm.ONE_TIME].map((e) => e.id)
  );
  const watchIds = new Set(cm.WATCHLIST.map((w) => w.id));
  for (const d of ALL_DEPS) {
    if (d.observedLineId) {
      assert.ok(observedIds.has(d.observedLineId), `${d.id} points at a meter line that does not exist`);
    }
    if (d.fixedId) {
      assert.ok(fixedIds.has(d.fixedId), `${d.id} points at a fixed line that does not exist`);
    }
    if (d.watchlistId) {
      assert.ok(watchIds.has(d.watchlistId), `${d.id} points at a watchlist entry that does not exist`);
    }
  }
});

test('nothing on the rate card, the fixed list or the watchlist is missing from the inventory', () => {
  // THE COVERAGE TEST. This is the one that keeps the screen honest as the
  // repo grows: a vendor cannot be priced, billed or watched without also being
  // listed. Add the entry, or explain the omission here in writing.
  const ids = new Set(ALL_DEPS.map((d) => d.id));
  const fixedIds = [...cm.FIXED_MONTHLY, ...cm.FIXED_ANNUAL, ...cm.ONE_TIME].map((e) => e.id);
  for (const id of fixedIds) {
    assert.ok(
      ALL_DEPS.some((d) => d.fixedId === id),
      `the fixed bill ${id} is on nobody's inventory row`
    );
  }
  for (const w of cm.WATCHLIST) {
    assert.ok(
      ALL_DEPS.some((d) => d.watchlistId === w.id),
      `the watchlist entry ${w.id} is on nobody's inventory row`
    );
  }
  // Every rate-card group is reachable from some row. `stores` is the App Store
  // commission, which is not a vendor bill but does decide what a sale is
  // worth, so it is carried as a free row rather than dropped.
  const RATE_GROUP_ROW = {
    gemini: ['gemini-birdie', 'gemini-roost'],
    places: ['places-photos', 'places-text-search', 'places-details', 'places-nearby'],
    vision: ['vision'],
    weather: ['weather'],
    ticketmaster: ['ticketmaster'],
    resend: ['resend'],
    maptiler: ['maptiler'],
    posthog: ['posthog'],
    sentry: ['sentry'],
    revenuecat: ['revenuecat'],
    push: ['push'],
    stores: ['apple-commission'],
  };
  for (const group of Object.keys(cm.RATES)) {
    const rows = RATE_GROUP_ROW[group];
    assert.ok(rows, `RATES.${group} is priced and has no inventory row named for it`);
    for (const r of rows) assert.ok(ids.has(r), `${r} is named for RATES.${group} and does not exist`);
  }
});

test('a free row says which kind of zero it is, and an unknown row does not say zero at all', () => {
  // "It costs nothing" is three different facts: inside a free tier, unused, or
  // covered by a flat fee already counted elsewhere. Printing $0 without saying
  // which one is the same confusion as printing 0 for a meter nobody read.
  for (const d of ALL_DEPS) {
    if (d.group === 'free' && !d.unknownCost) {
      assert.ok(
        d.costsNothingBecause && d.costsNothingBecause.length > 0,
        `${d.id} costs nothing and does not say why`
      );
    }
    if (d.unknownCost) {
      assert.ok(
        d.unknownAction && d.unknownAction.length > 0,
        `${d.id} has an unknown cost and does not say where to go and find it`
      );
    }
  }
  // The three the panel must never round down to free. MapTiler and CARTO are
  // usage-based map tiles that nothing in this repo counts, and the BestTime
  // plan may still be charging for a key that is dead.
  const unknown = new Set(DEPS.unknownCostIds);
  // BestTime came off this list on 2026-09-01: the plan and its price are known
  // ($119 Package 100), so reading it as unknown would understate a real bill.
  assert.ok(!unknown.has('besttime-subscription'), 'the BestTime plan has a known price now and must not read as unknown');
  for (const id of ['maptiler', 'carto']) {
    assert.ok(unknown.has(id), `${id} has no defensible figure and must read as unknown`);
  }
});

test('a dependency with no meter is named as unmeasured rather than counted as zero', () => {
  // The photo meter lived in memory until 2026-08-20, read zero after every
  // deploy, and under-reported the largest line on the Google bill for as long
  // as it did that. A zero that means "no meter" and a zero that means "no
  // spend" are different facts.
  for (const d of ALL_DEPS) {
    if (d.observedLineId) continue;
    assert.ok(
      DEPS.unmeteredIds.includes(d.id),
      `${d.id} has no meter and is not declared unmeasured`
    );
  }
  // Per-SKU Places usage is the honest example: the ledger counts calls without
  // recording which SKU each one was, so three of the four cannot be split out.
  for (const id of ['places-text-search', 'places-details', 'places-nearby']) {
    const d = ALL_DEPS.find((x) => x.id === id);
    assert.strictEqual(d.observedLineId, null);
    assert.ok(d.usageNote && d.usageNote.length > 0, `${id} does not explain why it is unmeasured`);
  }
});

test('environment readings report presence and never a value', () => {
  // This payload goes over the wire to a browser. A key is a key even on an
  // admin screen.
  const before = process.env.TICKETMASTER_API_KEY;
  process.env.TICKETMASTER_API_KEY = 'tm-secret-value';
  try {
    const d = cm.buildDependencies({}).groups
      .flatMap((g) => g.entries)
      .find((x) => x.id === 'ticketmaster');
    assert.strictEqual(d.configured, true);
    assert.strictEqual(d.configuredVia, 'TICKETMASTER_API_KEY');
    assert.ok(!JSON.stringify(d).includes('tm-secret-value'), 'a key value reached the payload');
  } finally {
    if (before === undefined) delete process.env.TICKETMASTER_API_KEY;
    else process.env.TICKETMASTER_API_KEY = before;
  }
  // A dependency the server cannot see reads as unknown, not as unset. The
  // MapTiler key is a build-time frontend variable and the backend has no
  // business claiming it is missing.
  const mt = ALL_DEPS.find((x) => x.id === 'maptiler');
  assert.strictEqual(mt.configured, null);
  assert.ok(mt.configuredNote && mt.configuredNote.length > 0);
});

test('an unpriceable model reads as unpriced on the inventory too, never as free', () => {
  const d = cm.buildDependencies({ birdieModel: 'gemini-from-the-future' }).groups
    .flatMap((g) => g.entries)
    .find((x) => x.id === 'gemini-birdie');
  assert.strictEqual(d.unitPrice, null);
  assert.strictEqual(d.unpriceable, true);
});

// ---------------------------------------------------------------------------
// The Google-side quota caps
// ---------------------------------------------------------------------------

test('the quota caps still add up to the budget they were derived from', () => {
  // The four per-day quotas were set on 2026-08-20 by dividing a $33/month
  // budget across the four SKUs. If a rate moves or a quota is edited by hand
  // that agreement breaks silently, and the panel goes on implying a cap it no
  // longer has.
  const q = cm.buildGoogleQuotas();
  assert.strictEqual(q.kind, 'googleQuotas');
  assert.ok(q.perMonthUsdAfterFree > 0);
  assert.ok(q.perMonthUsdGross > q.perMonthUsdAfterFree, 'the free allowances did nothing');
  assert.ok(
    q.agreesWithBudget,
    `the quotas price at $${q.perMonthUsdAfterFree}/month against a $${q.budget.usdPerMonth} budget`
  );
  for (const l of q.lines) {
    assert.ok(cm.RATES.places.skus[l.id], `${l.id} is not a SKU on the rate card`);
    assert.ok(l.perDay > 0);
    assert.ok(Number.isFinite(l.perMonthUsdAfterFree));
  }
});

test('the quota block says which daily photo limit actually refuses first', () => {
  // Two daily limits now sit on the same SKU: this repo's own brake in
  // services/photoStore.js, and Google's quota. Only the smaller one ever
  // fires, and reading the wrong one is how a service comes to be capped well
  // below where its owner thinks it is.
  const google = cm.buildGoogleQuotas({ photoBurstPerDay: 451 }).lines.find((l) => l.id === 'photos');
  assert.strictEqual(google.repoDailyBrake, 451);
  assert.strictEqual(google.bindingDaily, 'google', 'a 451 brake cannot bind under a 152 quota');
  const repo = cm.buildGoogleQuotas({ photoBurstPerDay: 40 }).lines.find((l) => l.id === 'photos');
  assert.strictEqual(repo.bindingDaily, 'repo');
  // With nothing passed, no claim is made about which one binds.
  const neither = cm.buildGoogleQuotas().lines.find((l) => l.id === 'photos');
  assert.strictEqual(neither.repoDailyBrake, null);
  assert.strictEqual(neither.bindingDaily, null);
});

test('a budget alert is described as a notification, not as a cap', () => {
  // It emails at 50, 90 and 100 percent and stops nothing. Calling it a cap on
  // a screen whose whole subject is ceilings would be the same category error
  // this file exists to prevent.
  const q = cm.buildGoogleQuotas();
  assert.match(q.budget.note, /not a switch|stops nothing/i);
  assert.deepStrictEqual(q.budget.alertsAtPct, [50, 90, 100]);
});

test('GET /costs serves the inventory, the quota caps and the provider status', async () => {
  handlers = EMPTY_LEDGERS;
  const res = await get('/api/admin/costs');
  assert.strictEqual(res.status, 200, res.text);
  const b = res.body;

  assert.strictEqual(b.dependencies.kind, 'dependencies');
  assert.deepStrictEqual(b.dependencies.groups.map((g) => g.id), ['metered', 'fixed', 'free']);
  assert.ok(b.dependencies.total >= 30, 'the inventory shrank; something stopped being listed');
  for (const g of b.dependencies.groups) {
    assert.ok(g.entries.length > 0, `the ${g.id} group is empty`);
    assert.ok(g.label && g.note, `the ${g.id} group has no heading`);
  }

  assert.strictEqual(b.googleQuotas.kind, 'googleQuotas');
  assert.strictEqual(b.googleQuotas.lines.length, 4);
  assert.ok(b.googleQuotas.project, 'the quota block does not name the Google project');

  // Whether images can be screened at all. A cost panel that reports Vision
  // billed nothing, without reporting whether Vision answers, is telling the
  // owner the least useful true thing available.
  assert.ok(b.visionProvider, 'the panel does not say whether images can be screened');
  assert.ok('reachable' in b.visionProvider);
  if (b.visionProvider.configured === false) {
    assert.strictEqual(b.visionProvider.reason, 'no_key');
    assert.strictEqual(b.visionProvider.reachable, null, 'no key is not the same as not reachable');
  }

  // Provenance for EVERY group on the rate card. Nine of the twelve carried a
  // checked date and a source that no screen ever showed.
  for (const group of Object.keys(cm.RATES)) {
    assert.ok(b.rates.checked[group], `${group} has no checked date on the payload`);
    assert.match(b.rates.sources[group], /^https:\/\//, `${group} has no source url on the payload`);
  }
});

// ---------------------------------------------------------------------------
// THE METER THAT WAS WIRED IN AND STILL READ NULL (2026-08-26)
// ---------------------------------------------------------------------------
// e36c22f added `predictionCoverage` to this response, on the argument that the
// counter behind it "existed so somebody could see whether the crowd number is
// coming from the model or the fallback, and nothing read it". It read it
// through meterOrNull, whose body is `Number.isFinite(v) ? v : null`, and
// predictionCoverage() returns a BLOCK. No object is finite, so the panel
// served `"predictionCoverage": null` on every request, to every admin,
// forever. Nothing threw, nothing logged, the route stayed green and the
// meter's own unit test stayed green, because nothing measured the two
// together. The counter had gone from unread to read-and-discarded.
//
// This test is that missing measurement. It asserts the VALUE, not the key: an
// assertion that `'predictionCoverage' in body` would have passed against the
// broken version, which is the whole trap.
test('GET /costs serves the prediction coverage block, not a null where the block should be', async () => {
  handlers = EMPTY_LEDGERS;
  const res = await get('/api/admin/costs');
  assert.strictEqual(res.status, 200, res.text);
  const pc = res.body.predictionCoverage;

  assert.notStrictEqual(pc, null,
    'the crowd-model coverage block is null again. A meter that returns a shape cannot be read through '
    + 'meterOrNull, which answers null for anything that is not a finite number, so the panel shows '
    + 'nothing and says nothing about why.');
  assert.strictEqual(typeof pc, 'object');
  for (const key of ['since', 'total', 'ml', 'ruleEngine', 'modelShare', 'byMethod', 'modelLoaded']) {
    assert.ok(key in pc, `the coverage block no longer carries ${key}`);
  }
  assert.strictEqual(typeof pc.total, 'number');
  assert.strictEqual(typeof pc.ml, 'number');
  // modelShare is null before anything has been scored rather than 0, because
  // "nothing measured" and "the model never answers" are the two readings this
  // number exists to tell apart. A fresh process has scored nothing.
  assert.ok(pc.modelShare === null || (pc.modelShare >= 0 && pc.modelShare <= 1),
    `modelShare must be null or a fraction, got ${pc.modelShare}`);

  // AND IT IS DISPLAY ONLY. The panel may never let this number decide
  // anything: a coverage figure that gates a prediction is a product that turns
  // its own differentiator off when it is doing badly.
  assert.strictEqual(res.body.observed.lines.some((l) => l.id === 'prediction-coverage'), false,
    'coverage has become a priced line. It is not a cost and it is not a gate.');
});

test('a meter that throws still leaves the panel standing, block-shaped or not', async () => {
  // The other half of meterOrNull's contract, now that there are two of them.
  // One unreadable meter is one unmeasured line, never a 500 on the panel an
  // owner consults DURING the incident that broke the meter.
  const mlPredictor = require('../services/mlPredictor');
  const real = mlPredictor.predictionCoverage;
  mlPredictor.predictionCoverage = () => { throw new Error('onnx session is gone'); };
  try {
    handlers = EMPTY_LEDGERS;
    const res = await get('/api/admin/costs');
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.predictionCoverage, null, 'a throwing meter reads as unmeasured');
    assert.ok(res.body.fixed.effectiveMonthlyUsd > 0, 'and the rest of the panel is untouched');
  } finally {
    mlPredictor.predictionCoverage = real;
  }
});

test('the inventory still arrives when every ledger is down', async () => {
  // The whole point of an inventory is that it is a list, not a measurement.
  // Postgres being unreachable costs it its usage numbers and nothing else.
  handlers = [[/.*/, () => Promise.reject(new Error('connection terminated'))]];
  const res = await get('/api/admin/costs');
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(res.body.dependencies.total >= 30);
  assert.strictEqual(res.body.googleQuotas.lines.length, 4);
});
