// Every sentence on the public site describes something that ships. From
// the claims audit of 2026-09-04.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the landing page does not claim check-ins feed the crowd number', () => {
  const s = read('website/LandingPage.js');
  expect(s).toMatch(/Three reports from people at a venue move its score for that night and hour/);
  expect(s).not.toMatch(/Check-ins from people who are actually there fold in live/);
  // "fold in live" went on 2026-09-22. Reports do move the published score and
  // they never move it in real time: crowdEngine.js blends nothing at all until
  // MIN_CALIBRATION_REPORTERS (3) distinct verified reporters land in the same
  // weekly day-and-hour bucket inside a 28-day window, one vote per account.
  // Below that floor the model's own answer is what ships.
  //
  // The negative is pinned on the CRAWLER MIRROR, not on LandingPage.js, and
  // that is deliberate. The mirror holds copy and nothing else, while the page
  // quotes the retired wording inside the comment that records why it went, so
  // a source-level negative there would be red for the note explaining itself.
  // The page is still covered: its rendered text must deep-equal these blocks
  // under aiCrawlerSurface.test.js, so the phrase cannot come back on one
  // surface without coming back on both. Whitespace is flattened first, because
  // a line break is not a different claim.
  expect(read('../api/marketing-page.js').replace(/\s+/g, ' ')).not.toMatch(/fold in live/);
});

test('a permanent ban comes with a published way to contest it, and it is tappable', () => {
  /* The sentence is still here; the address inside it is now a mailto link
     rather than plain text, which is why this no longer matches one literal
     run. It was the only unlinked address on the site and it sat in the
     ban-appeal paragraph, i.e. the moment somebody most needs to tap it. It
     was also hardcoded past this file's own SUPPORT_EMAIL constant, so the
     link is asserted through that constant rather than the address. */
  const s = read('website/CommunityGuidelines.js');
  expect(s).toMatch(/If you think a ban was a mistake, email/);
  expect(s).toMatch(/a person will read it\./);
  // The appeal address is a link, and it follows SUPPORT_EMAIL.
  expect(s).toMatch(/mailto:\$\{SUPPORT_EMAIL\}`\}>\{SUPPORT_EMAIL\}<\/a> and a person will read it/);
  expect(s).not.toMatch(/email social@flockcorp\.com and a person/);
});

test('the privacy policy describes the export delivery and the push bookkeeping truthfully', () => {
  const s = read('website/PrivacyPolicy.js');
  expect(s).toMatch(/You can save it or copy it out, depending on your device\./);
  expect(s).not.toMatch(/It downloads as a\s+file\./);
  expect(s).toMatch(/a delivery ledger that records that a notification\s+was sent, with no message text, kept for thirty days/);
  expect(s).toMatch(/push token is dropped after 270 days of silence/);
});

test('the about page keeps to one contrast pivot', () => {
  const s = read('website/AboutPage.js');
  expect(s).not.toMatch(/not trying to be a feed/);
  expect(s).toMatch(/There is nothing to scroll and nobody to follow\./);
});

test('the report sheet does not invent a team', () => {
  expect(read('components/ModerationSheet.js')).toMatch(/We never tell them who reported\. Every report is reviewed\./);
});

test('llms.txt counts the static pages correctly', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'llms.txt'), 'utf8');
  expect(s).toMatch(/Five of the pages/);
  expect(s).toMatch(/the home page, \/about, \/support, \/privacy and \/terms\./);
});

// THE SIGN-UP SCREEN ASKS FOR A YEAR, AND THE POLICY HAS TO AGREE.
//
// Account creation stopped collecting a full date of birth on 2026-09-14, as
// the answer to an App Store rejection under 5.1.1(v). Three public passages
// were updated the next day and four were missed, so the Privacy Policy
// contradicted itself on the same page: one section said "we ask for the year
// only" while the Children section still described a date of birth. A reviewer
// checking the fix reads the policy denying it.
//
// The crawler mirror in api/marketing-page.js matters as much as the React
// pages: it is the static HTML served to answer engines, so a stale sentence
// there is the version that gets quoted back.
//
// Nothing pinned any of it. This does.
test('no public page or crawler mirror says sign-up asks for a date of birth', () => {
  const surfaces = [
    'website/PrivacyPolicy.js',
    'website/TermsOfService.js',
    'website/CommunityGuidelines.js',
    'website/AboutPage.js',
    'website/LandingPage.js',
    '../api/marketing-page.js',
    '../public/llms.txt',
  ];
  for (const rel of surfaces) {
    const body = read(rel).replace(/\s+/g, ' ');
    expect(body).not.toMatch(/asks for a date of birth/i);
    expect(body).not.toMatch(/asks for your date of birth/i);
    expect(body).not.toMatch(/stored date of birth/i);
  }
});

// "Never" is the promise the house copy rules ban outright, and it is false the
// moment a flag flips: PaywallSheet.js ships a consumer subscription behind
// PAYWALL_ENABLED. The Terms and the landing page already use the present
// tense, which stays true either way.
test('no public surface promises that users never pay', () => {
  const surfaces = [
    'website/AboutPage.js',
    'website/LandingPage.js',
    '../api/marketing-page.js',
    '../public/llms.txt',
  ];
  for (const rel of surfaces) {
    const body = read(rel).replace(/\s+/g, ' ');
    expect(body).not.toMatch(/never pay/i);
    expect(body).not.toMatch(/users never do/i);
    expect(body).not.toMatch(/you never do/i);
  }
});

// SOS IS TWO TAPS. The alert control arms on the first tap and sends only on a
// second one inside four seconds, so a phone in a pocket cannot fire it. The
// home page and the JSON-LD said two taps while /about, its crawler copy and
// llms.txt said one, so an answer engine could quote either.
test('every public surface counts SOS as two taps, which is what the alert control takes', () => {
  const sheet = read('components/safety/EmergencySheet.js');
  expect(sheet).toMatch(/if \(!armed\) \{\s*onArmedChange\(true\);\s*\} else \{/);
  expect(sheet).toMatch(/setTimeout\(\(\) => onArmedChange\(false\), 4000\)/);

  const surfaces = [
    'website/AboutPage.js',
    'website/LandingPage.js',
    '../api/marketing-page.js',
    '../public/llms.txt',
    '../public/index.html',
  ];
  for (const rel of surfaces) {
    const body = read(rel).replace(/\s+/g, ' ');
    expect([rel, (body.match(/\b(one|single)[- ]tap SOS\b/i) || [])[0]]).toEqual([rel, undefined]);
  }
  for (const rel of ['website/AboutPage.js', '../api/marketing-page.js', '../public/llms.txt']) {
    expect(read(rel).replace(/\s+/g, ' ')).toMatch(/two-tap SOS/);
  }
});

// FLOCK PRO IS A PAID PLAN, AND IT IS NOT ON SALE TO THE PUBLIC. /about said
// "the one paid plan is Roost" while Terms section 10 and /pro describe Flock
// Pro. Web checkout opens only for accounts the paywall is on for, which while
// PAYWALL_ENABLED is unset is the review list alone (backend
// services/proBilling.js), so these surfaces name Pro and say it is not on
// public sale. The day it goes on sale, these sentences change with it.
test('/about, its crawler copy and llms.txt name Flock Pro as a paid plan that is not on public sale', () => {
  const billing = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'backend', 'services', 'proBilling.js'), 'utf8'
  );
  expect(billing).toMatch(/if \(!paywallEnabled\(userId\)\) missing\.push\('PAYWALL_ENABLED'\);/);

  for (const rel of ['website/AboutPage.js', '../api/marketing-page.js', '../public/llms.txt']) {
    const body = read(rel).replace(/\s+/g, ' ');
    expect(body).not.toMatch(/the one paid plan/i);
    expect(body).toMatch(/Flock Pro, with more Birdie and more crowd forecasts/);
    expect(body).toMatch(/not on sale to the public today/);
  }
});
