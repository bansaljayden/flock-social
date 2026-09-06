// Every sentence on the public site describes something that ships. From
// the claims audit of 2026-09-04.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the landing page does not claim check-ins feed the crowd number', () => {
  const s = read('website/LandingPage.js');
  expect(s).toMatch(/Crowd reports from people at the venue fold in live/);
  expect(s).not.toMatch(/Check-ins from people who are actually there fold in live/);
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
