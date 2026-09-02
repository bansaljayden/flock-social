// ---------------------------------------------------------------------------
// The client half of the venue photo contract, 2026-08-14.
//
// The server (backend/routes/venueProfile.js photoRule) stores exactly one
// kind of venue photo_url: the app's own Places photo proxy path
// (/api/venues/photo?...), normalized to its relative form. Everything else is
// a 400 — including the moderated data: URLs the avatar uploader returns,
// because the PUT cannot tell our moderated data URL from a raw unscreened one.
//
// The old client control was a file upload wired to uploadProfileImage, broken
// twice over: it destructured { url } from a call that returns
// { profile_image_url } (so it had sent photoUrl: undefined since the day it
// was written), and even fixed it could only ever send a value the server now
// refuses. The replacement is a picker over the linked Google listing's own
// photos, which are the only URLs the server vouches for. This suite pins that
// contract so neither half of the old bug can come back.
//
// It also pins the 2026-08-14 price-doc sweep: $35/$75 is FINAL (see
// venuePricingDecision.test.js for the app side); README.md, MONEY-MODEL.md
// and SUBMIT-CHECKLIST.md must not resurrect the superseded prices or the
// "fix the app, not the doc" instruction that pointed at them.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

// The venue owner dashboard left App.js on 2026-08-26: it is its own lazily
// loaded chunk now (screens/VenueDashboard.js), and about 2,000 lines of what
// this file scans went with it. Nothing asserted below changed. The app source
// is simply in two files, so both are read, in the order they used to be one.
const app = read('frontend', 'src', 'App.js') + read('frontend', 'src', 'screens', 'VenueDashboard.js');

describe('the venue logo is picked from the listing photos the server vouches for', () => {
  test('the file-upload path is gone, including the { url } destructuring bug', () => {
    expect(app).not.toContain('handleVenueLogoUpload');
    expect(app).not.toContain('venueLogoInputRef');
    // uploadProfileImage returns { profile_image_url }; this destructuring
    // yielded undefined and is what sent photoUrl: undefined for months.
    expect(app).not.toMatch(/\{\s*url\s*\}\s*=\s*await uploadProfileImage/);
  });

  test('the picker fetches the linked listing photos and saves the picked one', () => {
    const at = app.indexOf('const openVenueLogoPicker');
    expect(at).toBeGreaterThan(-1);
    const picker = app.slice(at, at + 600);
    // The choices come from getVenueDetails, i.e. the /api/venues/photo?...
    // proxy URLs the backend mints — the only values its photoRule accepts.
    expect(picker).toContain('getVenueDetails(venueLogoPlaceId)');
    // The save sends exactly what was picked, and nothing from the avatar
    // store: the only writer of photoUrl is the pick handler, and the pick
    // handler never calls uploadProfileImage.
    const pickAt = app.indexOf('const handleVenueLogoPick');
    expect(pickAt).toBeGreaterThan(-1);
    const pick = app.slice(pickAt, app.indexOf('};', pickAt));
    expect(pick).toContain('updateVenueProfile({ photoUrl: url })');
    expect(pick).not.toContain('uploadProfileImage');
    expect((app.match(/photoUrl:/g) || []).length).toBe(1);
  });

  test('a failed save rolls the optimistic preview back', () => {
    const at = app.indexOf('const handleVenueLogoPick');
    expect(at).toBeGreaterThan(-1);
    const handler = app.slice(at, at + 1600);
    expect(handler).toContain('const previousLogo = venueLogoUrl');
    expect(handler).toContain('setVenueLogoUrl(previousLogo)');
  });

  test('the stored relative proxy path is resolved on read, both hydration and save', () => {
    // The server stores photo_url normalized to /api/venues/photo?..., which
    // this SPA's origin does not serve. Raw reads 404 against Vercel.
    expect(app).toContain('setVenueLogoUrl(resolveVenuePhoto(p.photo_url))');
    expect(app).toContain('setVenueLogoUrl(resolveVenuePhoto(saved.photo_url))');
    expect(app).not.toContain('setVenueLogoUrl(p.photo_url)');
  });

  test('without a linked listing the logo box is not a control', () => {
    // A picker over listing photos cannot succeed with no listing, and a
    // control that cannot succeed is a defect (SLOP-AUDIT rule 5).
    expect(app).toMatch(/\{venueLogoPlaceId \? \(\s*\n\s*<button/);
    expect(app).toMatch(/openVenueLogoPicker = async \(\) => \{\s*\n\s*if \(!venueLogoPlaceId\) return;/);
  });

  test('an empty listing gets an honest empty state, not a blank grid', () => {
    expect(app).toContain('Your Google listing has no photos yet.');
  });
});

describe('the 2026-08-14 price sweep holds in the docs', () => {
  const readme = read('README.md');
  const money = read('MONEY-MODEL.md');
  const checklist = read('SUBMIT-CHECKLIST.md');

  test('no doc resurrects the superseded $49/$149 prices', () => {
    for (const doc of [readme, money, checklist]) {
      expect(doc).not.toMatch(/\$49\b/);
      expect(doc).not.toMatch(/\$149\b/);
    }
  });

  test('the "fix the app, not the doc" instruction is dead', () => {
    for (const doc of [readme, money, checklist]) {
      expect(doc).not.toContain('Fix the app, not the doc');
    }
    expect(checklist).toMatch(/resolved 2026-08-14/i);
  });

  test('README names the current prices next to VENUE-BILLING.md', () => {
    // Pro moved 75 -> 99 on 2026-08-25. This pin moved with it on 2026-09-01,
    // which is the whole point of the pin: the README is named authoritative on
    // price, so it is the one file that must never drift behind the app.
    expect(readme).toMatch(/\$35 Premium \/ \$99 Pro, re-priced 2026-08-25/);
    expect(readme).not.toMatch(/\$75 Pro, FINAL/);
  });

  test('MONEY-MODEL recomputed the venue-count math at the current prices', () => {
    // Recomputed at $99 Pro on 2026-09-01. ceil(1000/99) = 11, ceil(1000/35) =
    // 29, ceil(1000/67) = 15, and 67 is the real midpoint of 35 and 99. The doc
    // must show its work and the work must be right.
    expect(money).toContain('$99 x 11 = $1,089');
    expect(money).toContain('$35 x 29 = $1,015');
    expect(money).toContain('$67 x 15 = $1,005');
    expect(99 * 11).toBe(1089);
    expect(35 * 29).toBe(1015);
    expect(67 * 15).toBe(1005);
    expect((35 + 99) / 2).toBe(67);
    // The dead price must not survive anywhere in the arithmetic.
    expect(money).not.toContain('$75 x 14');
    expect(money).not.toContain('$55 x 19');
  });

  test('the revenue simulator seed says what it is', () => {
    // (35 + 99) / 2 = 67. This seeded 55 against the retired $75 until
    // 2026-09-01, so the admin revenue simulator opened on a price no venue
    // could be charged.
    expect(app).toContain('useState(67); // midpoint of $35 Premium and $99 Pro');
    expect(app).not.toContain('midpoint of $35 Premium and $75 Pro');
  });
});
