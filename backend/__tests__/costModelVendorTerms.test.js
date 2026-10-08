// Run: node --test  (from backend/)
//
// THE VENDOR FACTS THE MONEY HUB STATES, AS CHECKED ON 2026-09-30.
//
// Every figure and licence claim below was read off the vendor's own page
// that day (each note names the page). These pin the corrections, so a later
// edit cannot quietly put back what was wrong: a non-commercial free tier
// described as fine for a company that sells subscriptions, a public-repo
// exemption for a deployment source, an overage that could not produce the bill
// it was blamed for.

const test = require('node:test');
const assert = require('node:assert');
const cm = require('../services/costModel');

const find = (list, id) => list.find((x) => x.id === id);
const watch = (id) => find(cm.WATCHLIST, id);
const dep = (id) => find(cm.DEPENDENCIES, id);
const text = (o) => JSON.stringify(o);

test('the domain renews at cost with ICANN\'s $0.20 fee', () => {
  const domain = find(cm.FIXED_ANNUAL, 'domain');
  assert.strictEqual(domain.usd, 11.17);
  assert.match(domain.note, /\$0\.20 fee/);
});

test('Railway volume and point-in-time recovery are priced the way Railway bills them', () => {
  assert.match(watch('postgres-images').note, /\$0\.15 per GB per month/);
  assert.doesNotMatch(watch('postgres-images').note, /0\.22/);
  const wal = dep('postgres-wal-archive');
  assert.match(wal.unknownAction, /point-in-time recovery/);
  assert.match(wal.unknownAction, /no separate PITR fee/);
});

test('MapTiler is on Flex, with the allowances, the overage rates and the spending limit as MapTiler states them', () => {
  // Bought 2026-10-07 (maptiler.com/cloud/pricing read that day). The Free
  // plan was non-commercial and paused the map; Flex is licensed for
  // commercial use and bills extra use instead.
  const r = cm.RATES.maptiler;
  assert.strictEqual(r.plan, 'Flex');
  assert.strictEqual(r.checked, '2026-10-07');
  assert.strictEqual(r.baseUsd, 30);
  assert.strictEqual(r.includedSessionsPerMonth, 25000);
  assert.strictEqual(r.includedSearchSessionsPerMonth, 3000);
  assert.strictEqual(r.included3dSessionsPerMonth, 10000);
  assert.strictEqual(r.includedApiRequestsPerMonth, 500000);
  assert.strictEqual(r.includedCustomStyles, 20);
  assert.strictEqual(r.overSessionPer1kUsd, 2.5);
  assert.strictEqual(r.overSearchSessionPer1kUsd, 2.5);
  assert.strictEqual(r.over3dSessionPer1kUsd, 6);
  assert.strictEqual(r.overRequestPer1kUsd, 0.15);
  assert.strictEqual(r.requestsPerStaticImage, 15);
  for (const gone of ['freeSessionsPerMonth', 'freeApiRequestsPerMonth', 'nextTierUsd']) {
    assert.strictEqual(r[gone], undefined, `${gone} is the Free plan's`);
  }
  // The account's spending limit, read on the account page 2026-10-07.
  assert.strictEqual(cm.MAPTILER_SPEND_CAP_USD, 20);
  assert.strictEqual(cm.MAPTILER_SPEND_CAP_CHECKED, '2026-10-07');
  // The words the hub shows carry the same numbers.
  const words = cm.freeTierTextFor('maptiler');
  for (const s of ['Flex, $30 a month', '25,000 map sessions', '500,000 API requests', '3,000 search sessions', '$2.50 per 1,000 sessions', '$0.15 per 1,000 requests', 'every key stops']) {
    assert.ok(words.includes(s), `the plan's words lack "${s}"`);
  }
  const note = watch('maptiler-satellite').note;
  assert.match(note, /25,000 map sessions and 500,000 API requests/);
  assert.match(note, /\$2\.50 per 1,000 sessions and \$0\.15 per 1,000 requests/);
  assert.match(note, /spending limit is \$20/);
  assert.doesNotMatch(note, /non-commercial|Free plan/);
  assert.match(dep('maptiler').unknownAction, /MAPTILER_SERVICE_TOKEN/);
  assert.match(dep('maptiler').unknownAction, /cloud\.maptiler\.com\/account\/analytics/);
  // The bill is the live expense row, so the code carries no line for it.
  const codeLines = [...cm.FIXED_MONTHLY, ...cm.FIXED_ANNUAL, ...cm.ONE_TIME];
  assert.ok(!codeLines.some((l) => /maptiler/i.test(`${l.id} ${l.label}`)), 'a code line would count the $30 twice beside the expense row');
  // The licence line stays, and clears through that row.
  const lic = cm.LICENCE_EXPOSURES.find((x) => x.id === 'maptiler');
  assert.deepStrictEqual(lic.resolvedBy, { expenseVendor: 'maptiler' });
  assert.strictEqual(lic.checked, '2026-10-07');
});

test('free tiers that exclude commercial use say so', () => {
  // DiceBear's hosted API is non-commercial, so the avatars are drawn on our
  // own server (2026-10-05) and the line says so.
  assert.match(watch('dicebear').note, /Drawn by our own server/);
  assert.match(dep('dicebear').costsNothingBecause, /on our own server/);
  // CARTO requires a key since its 2026-09-29 terms.
  assert.match(watch('carto-basemaps').note, /CARTO-issued key/);
  assert.match(dep('carto').unknownAction, /CARTO-issued key/);
});

test('GitHub Actions is not called free for being public', () => {
  const gh = dep('github-actions');
  assert.doesNotMatch(gh.costsNothingBecause, /this one is public/);
  assert.match(gh.costsNothingBecause, /deployment source/);
  assert.match(watch('github-actions').note, /deployment source/);
});

test('the Codemagic bill is explained by its invoice, not by six minutes of overage', () => {
  // The billing page read "506 / 500" on 2026-09-30, which looked like six
  // minutes over; it counts the free allowance only. The invoice paid on
  // 2026-10-02 itemized 507 free and 1,370 billed M2 minutes.
  const note = watch('codemagic').note;
  assert.match(note, /507 free and 1,370 billed/);
  assert.match(note, /\$130\.15/);
  assert.match(note, /counts the free allowance only/);
  // A dependency that has sent an invoice is not a free one.
  assert.strictEqual(dep('codemagic').group, 'metered');
  assert.strictEqual(dep('codemagic').costsNothingBecause, undefined);
});

test('BestTime\'s filter queries are capped, not unlimited', () => {
  const all = text(cm.FIXED_MONTHLY) + text(cm.DEPENDENCIES);
  assert.doesNotMatch(all, /query calls are unlimited/);
  assert.match(all, /200,000 a month/);
  assert.doesNotMatch(text(cm.ONE_TIME), /restarted nightly collection/);
});

test('Place Details reaches the Pro price only without the phone and website fields too', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'costModel.js'), 'utf8');
  assert.match(src, /nationalPhoneNumber and websiteUri/);
});
