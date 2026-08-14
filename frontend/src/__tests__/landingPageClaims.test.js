/**
 * LandingPage.{js,css}: the claims it makes, and the structure it makes them in.
 *
 * Companion to marketingSiteAccessibility.test.js, which owns the accessibility
 * contract for the same file. This one owns two other things that have both
 * regressed on this page before and that nothing was watching:
 *
 *   1. WHAT THE PAGE SAYS FLOCK DOES. Five separate claims have had to be
 *      deleted from this page because nothing implemented them — a claims
 *      counter, an RSVP count, a hardcoded "This Week" calendar, a "groups
 *      considered you" stat, and (2026-08-14) promoted placement in vote lists
 *      plus slow-night push offers, both of which were being sold to venues
 *      under a mailto. Copy is the easiest thing in a repo to write and the
 *      only thing with no compiler, so the checks are here instead.
 *
 *   2. THE PAGE'S STRUCTURAL FINGERPRINT. Birdie, Money and Safety were three
 *      consecutive .lp-row sections — one grid class, 1fr|1fr, each running
 *      h2 → .lp-lead → ruled .lp-list beside one media object. Two of them were
 *      not merely similar, they were the same composition with different nouns.
 *      That is the shape an audit calls templated, and the cheapest possible
 *      way to reintroduce it is for the next section to reach for .lp-row
 *      because it is the class that already exists. So the count is pinned.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 *
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */

const fs = require('fs');
const path = require('path');

const WEBSITE = path.join(__dirname, '..', 'website');
const JS = fs.readFileSync(path.join(WEBSITE, 'LandingPage.js'), 'utf8');
const CSS = fs.readFileSync(path.join(WEBSITE, 'LandingPage.css'), 'utf8');

// The reasoning for this page lives in its comments and is allowed to say
// anything, including quoting the exact claims that were deleted. Only what
// reaches a reader is under test.
const visible = JS
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

// ───────────────────────────────────────────────────────────────────────────
describe('the page only sells things that exist', () => {
  const REPO = path.join(__dirname, '..', '..', '..');
  const claudeMd = fs.readFileSync(path.join(REPO, '.claude', 'CLAUDE.md'), 'utf8');

  test('the "Not built" list in CLAUDE.md still names the two features this page used to sell', () => {
    // If this fails, one of two good things happened: the feature got built, or
    // the doc was reorganised. Either way the assertions below need re-reading
    // rather than deleting — they are only meaningful while the doc still says
    // these do not exist.
    const notBuilt = claudeMd.slice(claudeMd.indexOf('**Not built:**'));
    expect(notBuilt).toMatch(/promoted placement in vote lists/i);
    expect(notBuilt).toMatch(/slow-night push offers/i);
  });

  test('no promoted-placement pitch, in any of the phrasings it has worn', () => {
    // "Show up in venue voting near you" and "Reach groups at the exact moment
    // they're picking a place" were the two that shipped. Both described a
    // venue paying to be surfaced during voting. Vote rows come from Google
    // Places in distance order and nothing in the repo reorders them.
    expect(visible).not.toMatch(/show up in venue voting/i);
    expect(visible).not.toMatch(/reach groups at the (exact )?moment/i);
    expect(visible).not.toMatch(/promoted (placement|listing|spot)/i);
    expect(visible).not.toMatch(/featured (placement|in (the )?vot)/i);
    // The pricing lead was still carrying the same pitch one paragraph above
    // the card, in wording none of the patterns above matched: "Venues pay to
    // show up in front of groups that are picking a place right now." Match the
    // IDEA — a venue being placed in front of groups — not one phrasing of it.
    expect(visible).not.toMatch(/in front of (groups|flocks|people)/i);
    expect(visible).not.toMatch(/(pay|paying|paid) to (show|be|get|appear)/i);
  });

  test('the page does not say venues are paying, because none is', () => {
    // No `stripe` dependency in backend/package.json, VENUE_BILLING_ENABLED
    // unset on Railway, and the only writer of venue_profiles.tier is the admin
    // comp route. Present tense here is a straight falsehood, and it is the
    // claim a venue would rely on when it opens the mailto.
    const pkg = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'backend', 'package.json'), 'utf8'
    ));
    expect(Object.keys(pkg.dependencies || {})).not.toContain('stripe');
    expect(visible).not.toMatch(/venues pay\b/i);
    expect(visible).not.toMatch(/venues are paying/i);
  });

  test('no slow-night offer pitch', () => {
    expect(visible).not.toMatch(/slow night/i);
    expect(visible).not.toMatch(/put an offer up/i);
  });

  test('the page does not promise to push a venue\'s post to nearby groups', () => {
    // Promotions are pull, not push: POST /api/venue-dashboard/promotions
    // stores one and GET /public-promotions/:placeId is read by the venue
    // detail screen when a user opens that venue. Nothing sends it anywhere.
    expect(visible).not.toMatch(/to nearby groups/i);
    expect(visible).not.toMatch(/(notify|alert|push) (nearby|local) (groups|users|flocks)/i);
  });

  test('the page does not sell venue EVENTS, which no user can see', () => {
    // POST /events and GET /events exist for the owner. There is no
    // public-events route, so an event a venue types is visible to the venue
    // and to nobody else. Promotions are the only one of the pair that reaches
    // a reader, which is why only promotions survive in the venue card.
    const venueCard = visible.slice(visible.indexOf('For venues'), visible.indexOf('lp-cta'));
    expect(venueCard.length).toBeGreaterThan(200);
    expect(venueCard).not.toMatch(/events?/i);
  });

  test('the surviving venue claims each name a route that exists', () => {
    const api = fs.readFileSync(path.join(__dirname, '..', 'services', 'api.js'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
    const venueCard = visible.slice(visible.indexOf('For venues'), visible.indexOf('lp-cta'));

    // "See the flocks that chose you"
    expect(venueCard).toMatch(/flocks that chose you/i);
    expect(api).toMatch(/venue-dashboard\/incoming-flocks/);
    expect(app).toMatch(/getIncomingFlocks\(/);

    // "Put a deal on your venue's card, where groups open it"
    expect(venueCard).toMatch(/deal on your venue/i);
    expect(api).toMatch(/venue-dashboard\/public-promotions/);
    expect(app).toMatch(/getPublicPromotions\(/);

    // "Reply to reviews from people who went"
    expect(venueCard).toMatch(/reply to reviews/i);
    expect(api).toMatch(/replyToReview/);

    // "Your own hour-by-hour forecast, from the model the app runs"
    expect(venueCard).toMatch(/hour-by-hour forecast/i);
    expect(api).toMatch(/venue-dashboard\/intelligence/);
    expect(app).toMatch(/getVenueIntelligence\(/);
  });

  test('the crowd-model figures in the demo proof line match the shipped model', () => {
    // The same pinning AboutPage's five figures get, because these two are now
    // on the highest-traffic page on the site. A retrain that changes the
    // corpus must change this sentence.
    const meta = JSON.parse(fs.readFileSync(
      path.join(REPO, 'backend', 'scripts', 'ml', 'models', 'model_metadata.json'),
      'utf8'
    ));
    const copy = visible.replace(/\s+/g, ' ');

    expect(Math.round(meta.training_rows / 100000) / 10).toBeCloseTo(2.1, 5);
    expect(meta.training_cities.length).toBe(31);
    expect(copy).toMatch(/2\.1 million\s*venue-hour observations across 31 cities/);
  });

  test('nothing on the page claims a team that does not exist', () => {
    // Flock is one student and /about opens by saying so. A corporate "we"
    // making a commitment is a register mismatch a reader catches in two
    // clicks, and on the legal surfaces it is a claim an App Store reviewer
    // will hold the product to. "us" as the thing you are not paying is the
    // company as an entity and is fine; a "we" that PROMISES an action is not.
    expect(visible).not.toMatch(/\bwe(’|')ll\b/i);
    expect(visible).not.toMatch(/\bour team\b/i);
    expect(visible).not.toMatch(/\bwe (review|monitor|respond|check|verify)/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('structural fingerprint', () => {
  test('at most one section is still the 1fr|1fr text-beside-media row', () => {
    // .lp-row was Birdie, Money and Safety. Money keeps it, because the split
    // card is a table of numbers and wants parity with the column arguing for
    // it. If this number climbs, the page is drifting back toward one panel
    // repeated — pick a different composition for the new section instead of
    // adding a fourth .lp-row.
    const rows = (visible.match(/className="lp-wrap lp-row/g) || []).length;
    expect(rows).toBe(1);
  });

  test('the three feature sections do not share a grid definition', () => {
    // Each of the three has its own template, and the templates differ in
    // proportion, not just in which side the media lands on. Two sections with
    // mirrored 1fr|1fr are the same section.
    // Each section's template lives in its own min-width block, so match the
    // class then take the first grid-template-columns after it.
    const grid = (cls) => {
      const m = new RegExp(`\\.${cls}\\s*\\{[\\s\\S]{0,400}?grid-template-columns:\\s*([^;]+);`)
        .exec(CSS);
      expect(m).not.toBeNull();
      return m[1].replace(/\s+/g, ' ').trim();
    };
    const birdie = grid('lp-birdie');
    const safety = grid('lp-safety');
    const row = grid('lp-row');

    expect(new Set([birdie, safety, row]).size).toBe(3);
    // And Birdie's is genuinely asymmetric, not a 1fr|1fr in disguise.
    expect(birdie).toMatch(/38rem/);
  });

  test('Safety puts its guarantees across the full width, not in a sidebar', () => {
    expect(visible).toMatch(/className="lp-list lp-safety-rules"/);
    expect(CSS).toMatch(/\.lp-safety-rules \{[\s\S]{0,400}?grid-column: 1 \/ -1;/);
    // Two columns, so the divider has to move from "between items" to "between
    // rows" or the top-right item gets a rule with nothing above it.
    expect(CSS).toMatch(/\.lp-sec-navy \.lp-safety-rules li \+ li \{ border-top-width: 0; \}/);
    expect(CSS).toMatch(/\.lp-sec-navy \.lp-safety-rules li:nth-child\(n \+ 3\)/);
  });

  test('eyebrows are capped at two', () => {
    // An eyebrow is an ordinal device. This page had four, over headings that
    // in two cases already stated the subject ("How it works" above a band
    // numbered 01–04; "Pricing" above a card reading $0). When every section is
    // chaptered, none of them is. The two that remain are the two whose
    // heading names no subject.
    const kickers = (visible.match(/className="lp-kicker"/g) || []).length;
    expect(kickers).toBeLessThanOrEqual(2);
    expect(visible).toMatch(/className="lp-kicker">Crowd levels</);
    expect(visible).toMatch(/className="lp-kicker">Safety</);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the layout floors that only fail on a phone', () => {
  test('the root clips horizontally, on html AND body, with clip not hidden', () => {
    // .lp already carries overflow-x: clip, but .lp is a div — anything that
    // escapes it still scrolls the document, and inside the Capacitor shell
    // index.css pins body.native-shell to overflow: hidden, so an overflow that
    // would merely scroll on the web is CUT OFF in the app with no scrollbar to
    // announce it. `hidden` is not an acceptable substitute for `clip` here:
    // hidden makes the element a scroll container, which silently kills
    // position: sticky on descendants, and the entire navbar is sticky.
    const rule = /html:has\(\.lp\),\s*\nhtml:has\(\.lp\) body \{ overflow-x: (\w+); \}/.exec(CSS);
    expect(rule).not.toBeNull();
    expect(rule[1]).toBe('clip');
  });

  test('no grid track that can hold an image is a bare 1fr', () => {
    // A bare `1fr` is `minmax(auto, 1fr)`, and `auto` floors the track at its
    // content's min-content width — for a 1024px-native image, that is 1024px,
    // which pushes the row past a phone viewport. One character per track.
    // Only the MINIMUM side of a track can overflow a viewport. `minmax(300px,
    // 1fr)` and `minmax(min(300px, 100%), 1fr)` are fine — 1fr there is the
    // maximum, and a maximum never floors anything. What is not fine is a bare
    // `1fr` written as a whole track, which expands to `minmax(auto, 1fr)`.
    const tracks = CSS.match(/grid-template-columns:([^;]+);/g) || [];
    const bare = tracks.filter((t) => {
      // Remove every complete minmax(...) so only whole tracks are left.
      const whole = t.replace(/minmax\([^()]*(\([^()]*\))?[^()]*\)/g, 'M');
      return /(^|[\s:])1(\.\d+)?fr\b/.test(whole);
    });
    expect(bare).toEqual([]);
  });

  test('display headings can break inside a word rather than overflow', () => {
    const block = /\.lp h1, \.lp h2, \.lp h3 \{([\s\S]*?)\}/.exec(CSS);
    expect(block).not.toBeNull();
    expect(block[1]).toMatch(/overflow-wrap: anywhere/);
    expect(block[1]).toMatch(/min-width: 0/);
  });

  test('the waitlist message slot holds a line open before there is a message', () => {
    // Both live regions collapse to zero while empty, which is what keeps the
    // pair one line tall once one fills. At rest that made the slot zero, so
    // the first failed submit inserted a line and pushed the CTA band — the
    // field you had just pressed enter in — down under your hands.
    expect(visible).toMatch(/<div className="lp-form-status">/);
    const slot = /\.lp-form-status \{([\s\S]*?)\}/.exec(CSS);
    expect(slot).not.toBeNull();
    expect(slot[1]).toMatch(/min-height: 1lh/);
    // …and a px floor first, for an engine without lh units.
    expect(slot[1]).toMatch(/min-height: \d+px/);
  });

  test('no form control is under the 16px iOS zoom floor', () => {
    // Anything under 16px on a focused input makes iOS Safari zoom the whole
    // viewport, and in the Capacitor shell it does not zoom back out.
    const inputRules = CSS.match(/\.lp[a-z-]*[ -]?input[^{]*\{[^}]*\}/g) || [];
    expect(inputRules.length).toBeGreaterThan(0);
    for (const rule of inputRules) {
      const size = /font-size:\s*([\d.]+)px/.exec(rule);
      if (size) expect(Number(size[1])).toBeGreaterThanOrEqual(16);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('token and motion discipline', () => {
  // Everything below the token block, with comments removed — the comments
  // quote hex values on purpose (they carry the measured contrast ratios) and
  // are not what renders.
  const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const tokenBlockEnd = (() => {
    const at = noComments.indexOf('.lp {');
    let depth = 0;
    for (let i = noComments.indexOf('{', at); i < noComments.length; i += 1) {
      if (noComments[i] === '{') depth += 1;
      if (noComments[i] === '}') { depth -= 1; if (depth === 0) return i; }
    }
    return -1;
  })();
  const rules = noComments.slice(0, noComments.indexOf('.lp {')) + noComments.slice(tokenBlockEnd);

  test('no opaque colour is declared outside the token block', () => {
    // The page had nine: #fff six times, #fffaf0, #22394f, #f0a3a3, #e88f8f,
    // #000, #1e293b, and three gradient stops. A locked palette that then
    // freestyles a tenth colour in a hover rule is how cohesion erodes — by the
    // third edit pass the page has eight colours instead of three. Every one of
    // them is now a named token; add a token rather than a literal.
    const hexes = rules.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    expect(hexes).toEqual([]);
  });

  test('no plate is pure white', () => {
    // Banned twice over: as a synthetic base colour, and by frontend/DESIGN.md
    // in its own words ("No pure #000000 / pure #ffffff backgrounds"). It also
    // reads wrong — this page is printed cream stock, and a pure-white card on
    // it is a different piece of paper.
    expect(CSS).toMatch(/--plate: #fbfaf6;/);
    expect(rules).not.toMatch(/background(-color)?:\s*(#fff\b|#ffffff\b|white\b)/i);
  });

  test('nothing animates a layout property', () => {
    // .lpd-bar carried `transition: height 0.5s` — twenty-four bars re-running
    // layout and paint for half a second on every pin you click, inside a
    // WKWebView. Transitions belong on transform and opacity.
    const transitions = rules.match(/transition:[^;]+;/g) || [];
    for (const t of transitions) {
      expect(t).not.toMatch(/\b(width|height|top|left|right|bottom|margin|padding)\b/);
      expect(t).not.toMatch(/\ball\b/);
    }
  });

  test('no bouncy easing on UI state', () => {
    // The house app system reaches for cubic-bezier(0.34, 1.56, 0.64, 1) for
    // tactile pops. An overshoot on a button or a panel reads as a decade-old
    // template; keep it for genuinely physical interactions, of which this page
    // has none.
    // An overshoot is a control-point Y outside [0, 1] — that is what carries
    // the curve past its destination and back. y1 and y2 are the 2nd and 4th
    // arguments.
    const curves = rules.match(/cubic-bezier\([^)]+\)/g) || [];
    expect(curves.length).toBeGreaterThan(0);
    for (const c of curves) {
      const n = /cubic-bezier\(\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\s*\)/.exec(c);
      expect(n).not.toBeNull();
      for (const y of [Number(n[2]), Number(n[4])]) {
        if (y > 1 || y < 0) throw new Error(`overshoot easing on UI state: ${c}`);
      }
    }
  });

  test('the Hallmark stamp is present and names what actually shipped', () => {
    // The stamp is the durable record of the page's shape. An audit reads it
    // and checks the page against it, so a stamp that stops being true is worse
    // than no stamp — fix the name, or fix the page.
    expect(CSS.trimStart()).toMatch(/^\/\* Hallmark · macrostructure: Workbench/);
    expect(CSS).toMatch(/pre-emit critique: P\d H\d E\d S\d R\d V\d/);
  });
});
