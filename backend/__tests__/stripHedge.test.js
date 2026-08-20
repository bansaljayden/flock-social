// Run: node --test  (from backend/)
//
// ===========================================================================
// THE STRIP STOPS CLAIMING AN ORDERING IT CANNOT DEFEND.
//
// /api/venue-dashboard/strip scores the owner's venue and its neighbours with
// the same model and lays the numbers side by side — which is implicitly a
// RANKING, and the ranking was measured: pairwise ordering on held-out rows
// came back 43.1% BACKWARDS (2026-08-19 model-defect hunt). A coin flip is
// 50%. So a raw "they're busier than you tonight" read off two model scores is
// slightly worse than guessing, delivered to a paying business owner as
// analytics.
//
// The hedge, pinned here:
//   1. Every row carries its predictionMethod, so a rule-engine number (a
//      category prior, identical for every same-category venue) is never
//      dressed as a model reading.
//   2. An ordering claim ('busier' / 'quieter') is only drawn when BOTH sides
//      are model-scored AND the gap clears STRIP_ORDERING_MIN_GAP. Below the
//      threshold the honest answer is no claim at all — the numbers still
//      show, the ranking sentence does not.
//   3. Rule-engine rows can never be part of a claim, whatever the gap: the
//      gap between two category priors is a fact about the categories, not
//      about tonight.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'strip-hedge-test-secret';
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';

// venueDashboard requires the auth middleware at module load.
const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => { req.user = { id: 7, role: 'venue_owner' }; next(); };

const dash = require('../routes/venueDashboard');
const { stripOrderingClaim, STRIP_ORDERING_MIN_GAP } = dash.__test;

const you = (peak, method = 'ml') => ({ name: 'Mine', peakScore: peak, method });
const them = (peak, method = 'ml') => ({ name: 'Theirs', peakScore: peak, method });

test('below the minimum gap there is no ordering claim, in either direction', () => {
  assert.strictEqual(stripOrderingClaim(you(60), them(60 + STRIP_ORDERING_MIN_GAP - 1)), null);
  assert.strictEqual(stripOrderingClaim(you(60), them(60 - STRIP_ORDERING_MIN_GAP + 1)), null);
  assert.strictEqual(stripOrderingClaim(you(60), them(60)), null);
});

test('at and above the gap the claim is drawn, and names the right direction', () => {
  assert.strictEqual(stripOrderingClaim(you(40), them(40 + STRIP_ORDERING_MIN_GAP)), 'busier');
  assert.strictEqual(stripOrderingClaim(you(80), them(80 - STRIP_ORDERING_MIN_GAP)), 'quieter');
});

test('a rule-engine number can never be part of an ordering claim', () => {
  assert.strictEqual(stripOrderingClaim(you(20, 'rule_engine'), them(90)), null);
  assert.strictEqual(stripOrderingClaim(you(20), them(90, 'rule_engine_no_baseline')), null);
  assert.strictEqual(stripOrderingClaim(you(20, 'rule_engine'), them(90, 'rule_engine')), null,
    'two category priors differ about the categories, not about tonight');
});

test('missing scores and missing rows draw no claim', () => {
  assert.strictEqual(stripOrderingClaim(you(null), them(90)), null);
  assert.strictEqual(stripOrderingClaim(you(40), them(undefined)), null);
  assert.strictEqual(stripOrderingClaim(null, them(90)), null);
  assert.strictEqual(stripOrderingClaim(you(40), null), null);
});

test('the threshold is meaningfully wide — at least a full label band', () => {
  // Labels change every 20 points (crowdEngine.getLabel). A claim drawn inside
  // one band would rank two venues the product itself describes with the same
  // word. 43.1% of orderings measured backwards; the gap is the only hedge.
  assert.ok(STRIP_ORDERING_MIN_GAP >= 20,
    `STRIP_ORDERING_MIN_GAP=${STRIP_ORDERING_MIN_GAP} is inside one label band`);
});

// ── Source pins: the payload actually carries what the hedge needs ──────────

const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'venueDashboard.js'), 'utf8');

test('every strip row carries its predictionMethod', () => {
  const scoreOne = src.slice(src.indexOf('const scoreOne'), src.indexOf('const competitors'));
  assert.ok(/method:/.test(scoreOne),
    'scoreOne must publish the method — a rule-engine row dressed as a model reading is the exact defect');
});

test('competitor rows are the ones that carry the claim, and the payload names the gap rule', () => {
  assert.ok(/orderingClaim/.test(src), 'competitor rows must carry orderingClaim');
  assert.ok(/orderingMinGap/.test(src),
    'the payload must publish the threshold so the client can say why no ranking is drawn');
});
