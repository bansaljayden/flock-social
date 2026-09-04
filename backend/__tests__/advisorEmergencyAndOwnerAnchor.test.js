// Two boundaries the paid product states and did not hold, traced 2026-09-04.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ft = require('../services/advisorFreeText');
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const freeText = src('services/advisorFreeText.js');
const feedback = src('routes/feedback.js');
const predictor = src('services/mlPredictor.js');

test('a medical emergency is answered before the ceiling, the spend and the model', async () => {
  // The veto ran LAST, after four earlier returns, and the classifier's closed
  // reason list has no medical_emergency, so the route-refused branch always
  // won. An owner who had used the day's twenty questions was told their
  // allowance was spent while standing over a choking customer.
  for (const q of [
    'someone is choking what do I do',
    'a guest is not breathing',
    'my bartender collapsed and is unresponsive',
  ]) {
    const r = await ft.classify({ userId: 7, question: q });
    assert.strictEqual(r.mode, 'refused', q);
    assert.match(r.refusal, /^Call emergency services now\./, q);
  }
});

test('the emergency check sits above the charged call in the source', () => {
  const fn = freeText.slice(freeText.indexOf('const hard = screen(question);'));
  const emergencyAt = fn.indexOf('const emergency = emergencyClass(question);');
  const chargeAt = fn.indexOf('await chargedCall({');
  assert.ok(emergencyAt > -1, 'the emergency check exists');
  assert.ok(emergencyAt < chargeAt, 'and it runs before anything is charged');
  assert.match(freeText, /function emergencyClass\(text\) \{/);
  // Everything else stays where it was, for the reason written at that call site.
  assert.match(freeText, /const vetoed = prohibitedClass\(question\);/);
});

test('an owner-set card is never the number a report is scored against', () => {
  // The card's score came from the venue's own slider and was recorded like any
  // other serve. Comparing a report against it stored the owner's choice as the
  // MODEL's error, and mlPredictor averages that column with no time bound, so
  // one Saturday moved the venue's live anchor for good.
  assert.match(feedback, /AND \(prediction_method IS NULL OR prediction_method <> 'owner_report'\)/);
  // And the backstop, for rows already written.
  assert.match(predictor, /AND NOT EXISTS \(\s*SELECT 1 FROM served_predictions sp/);
  assert.match(predictor, /AND sp\.prediction_method = 'owner_report'/);
});

// ---------------------------------------------------------------------------
// Three more from the same trace: two writes whose failure was reported as
// success, and one review read that counted the owner's own stars.
// ---------------------------------------------------------------------------
test('a bounce we failed to record is asked for again', () => {
  const hook = src('routes/emailWebhook.js');
  // 200 is what stops Resend retrying, so it may only be given once the row is
  // written. `ok === false` took no branch, so a hard bounce arriving during a
  // database blip was acknowledged as handled and never redelivered.
  assert.match(hook, /let allWritten = true;/);
  assert.match(hook, /allWritten = false;/);
  assert.match(hook, /if \(!allWritten\) return res\.status\(500\)\.json\(\{ error: 'Could not record the suppression' \}\);/);
});

test('a failed digest opt-out is not reported as an expired link', () => {
  const route = src('routes/venueDigest.js');
  // `error` was computed by applyOptOut and read by nobody, so a database
  // failure and a dead token gave the owner the same page. This path also
  // serves RFC 8058 one-click, so Gmail recorded a failed unsubscribe.
  assert.match(route, /if \(result\.error === 'server error'\) \{/);
  assert.match(route, /'We could not save that'/);
  assert.match(route, /The link is fine\. The request did not go through\./);
});

test('the weekly summary counts reviews the rest of the product does not', () => {
  const dash = src('routes/venueDashboard.js');
  // Four reads apply NOT_OWNER_OF_THE_PLACE and this fifth one did not, so the
  // Reviews tab showed 0 while Analytics showed "1 new review, 5 stars".
  const q = dash.slice(dash.indexOf('ROUND(AVG(rating)::numeric, 1) AS avg_rating'));
  assert.match(q.slice(0, 600), /FROM venue_reviews vr/);
  assert.match(q.slice(0, 600), /\$\{NOT_OWNER_OF_THE_PLACE\}/);
});
