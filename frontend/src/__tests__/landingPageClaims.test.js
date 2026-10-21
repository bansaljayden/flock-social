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
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');

  test('the "Not built yet" list in README.md still names the two features this page used to sell', () => {
    // If this fails, one of two good things happened: the feature got built, or
    // the doc was reorganised. Either way the assertions below need re-reading
    // rather than deleting — they are only meaningful while the doc still says
    // these do not exist.
    const notBuilt = readme.slice(readme.indexOf('**Not built yet**'));
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
    // Nothing bills a venue: VENUE_BILLING_ENABLED is unset on Railway, the only
    // writer of venue_profiles.tier is the admin comp route, and the one file in
    // the backend that loads Stripe is the CONSUMER Flock Pro service. This used
    // to be pinned as "there is no stripe dependency at all"; that stopped being
    // the evidence on 2026-09-23 when consumer web checkout arrived, so the pin
    // now checks the thing the claim is about. Present tense here would be a
    // straight falsehood, and it is the claim a venue would rely on when it
    // opens the mailto.
    const backend = path.join(__dirname, '..', '..', '..', 'backend');
    const loaders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '__tests__', 'scripts', 'backups'].includes(e.name)) continue;
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.name.endsWith('.js') && /require\(['"]stripe['"]\)/.test(fs.readFileSync(f, 'utf8'))) {
          loaders.push(path.relative(backend, f).replace(/\\/g, '/'));
        }
      }
    };
    walk(backend);
    expect(loaders).toEqual(['services/proBilling.js']);
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

  test('venue events are sold only with the verified-venue rule the route enforces', () => {
    // Until 2026-10-20 no user could see a venue event at all, and this test
    // kept events off the page. GET /public-events/:placeId now fills the
    // venue card's "Happening here" for anyone signed in to the web app, and
    // only for a venue holding a VERIFIED claim. The iPhone build in review
    // (49) does not draw it yet, but the page sells the web app, which is
    // live, and says plainly that the iPhone app is still in review. So events
    // may be named, and every sentence that names them carries the condition.
    const route = fs.readFileSync(path.join(REPO, 'backend', 'routes', 'venueDashboard.js'), 'utf8');
    expect(route).toMatch(/router\.get\('\/public-events\/:placeId'[\s\S]{0,1200}AND vp\.verified = true/);
    const venueCard = visible.slice(visible.indexOf('id="venues"'), visible.indexOf('lp-cta'));
    expect(venueCard.length).toBeGreaterThan(200);
    const sentences = venueCard.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+|<[^>]*>|"/);
    const naming = sentences.filter((s) => /\bevents?\b/i.test(s));
    expect(naming.length).toBeGreaterThan(0);
    for (const s of naming) expect(s).toMatch(/verified/i);
  });

  test('the surviving venue claims each name a route that exists', () => {
    const api = fs.readFileSync(path.join(__dirname, '..', 'services', 'api.js'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
    // The venues section and the venue plan under Pricing, which since
    // 2026-10-21 sit one after the other ahead of the closing band. Collapsed,
    // because the sentences wrap across source lines.
    const venueCard = visible.slice(visible.indexOf('id="venues"'), visible.indexOf('lp-cta')).replace(/\s+/g, ' ');

    // "See which flocks have you in their vote this week". It said "the
    // flocks that chose you" and "who picked you tonight", and the route
    // behind it lists a plan going to the venue, or one still deciding with it
    // as the pick or in ONE present member's vote, for seven days ahead rather
    // than one night. Nothing in the feed knows who chose whom, so the pitch
    // may not say so.
    expect(venueCard).toMatch(/which flocks have you in their vote this week/i);
    expect(venueCard).not.toMatch(/\b(chose|picked|choosing|picking) you\b/i);
    expect(venueCard).not.toMatch(/\btonight\b/i);
    const route = fs.readFileSync(
      path.join(REPO, 'backend', 'routes', 'venueDashboard.js'), 'utf8'
    );
    // Where the plan is going, and a member's vote while it is still deciding:
    // the two halves of "in their vote".
    expect(route).toMatch(/\(f\.venue_id = \$1 AND \(f\.status IS NULL OR f\.status IN \('planning', 'confirmed'\)\)\)/);
    expect(route).toMatch(/\(\(f\.status IS NULL OR f\.status = 'planning'\) AND EXISTS \(\s*SELECT 1 FROM venue_votes vv[\s\S]{0,300}WHERE vv\.flock_id = f\.id AND vv\.venue_id = \$1\)\)/);
    expect(route).toMatch(/const INCOMING_AHEAD_HOURS = 168;/);
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

  test('the home page goes from the crowd list straight to the live demo', () => {
    // The accuracy line that sat between them was cut on 2026-10-03, and the
    // menu's "Try it live" now lands on the demo itself. The measured figures
    // live on /research and in llms.txt, each pinned to servedAccuracy.json.
    const copy = visible.replace(/\s+/g, ' ');
    expect(copy).not.toMatch(/real live readings they had not seen/);
    expect(copy).not.toMatch(/same model that ships inside Flock/);
    expect(visible).toMatch(/<WhenNear id="try" className="lpd-hold"/);
  });

  test('the in-their-vote list has one honest name on every surface', () => {
    // GET /incoming-flocks lists a flock when one member voted for the venue.
    // The public pages sold it as the flocks that "chose" or "picked" a venue,
    // and the dashboard gave it three names on one screen, two of which
    // promised arrivals. Every surface now calls it the flocks with you in
    // their vote, and the old names may not come back. (/about stopped
    // describing the venue tools on 2026-10-21; /how-it-works describes them.)
    const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');
    const flat = (s) => s.replace(/\s+/g, ' ');
    // Comments are where the old names are quoted on purpose, as the record
    // of why they went. Only what renders is under test.
    const strip = (s) => s
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const dashboard = strip(read('frontend', 'src', 'screens', 'VenueDashboard.js'));
    const surfaces = [
      ['LandingPage.js', flat(visible)],
      ['AboutPage.js', flat(strip(read('frontend', 'src', 'website', 'AboutPage.js')))],
      ['HowItWorksPage.js', flat(strip(read('frontend', 'src', 'website', 'HowItWorksPage.js')))],
      ['marketing-page.js', flat(strip(read('frontend', 'api', 'marketing-page.js')))],
      ['llms.txt', flat(read('frontend', 'public', 'llms.txt'))],
      ['VenueDashboard.js', dashboard],
      // The one email every venue from before Roost had a price receives,
      // which lists this feed among what stays free.
      ['roostNoticeEmail.js', flat(strip(read('backend', 'templates', 'roostNoticeEmail.js')))],
    ];
    const OVERCLAIMS = [
      /\b(chose|picked) (you|it|this venue|their venue)\b/i,
      /flocks that (chose|picked|selected)\b/i,
      /have your venue in their plans/i,
      /Groups Eyeing You/,
      />[^<]*Incoming Flocks[^<]*</,
      /No incoming flocks/,
      /heading your way/,
    ];
    const hits = [];
    for (const [name, text] of surfaces) {
      for (const re of OVERCLAIMS) {
        const m = text.match(re);
        if (m) hits.push(`${name}: "${m[0]}"`);
      }
    }
    expect(hits).toEqual([]);

    expect(dashboard).toContain('>In Their Vote</p>');
    expect(dashboard).toContain('Flocks With You in Their Vote</h3>');
    expect(dashboard).toContain('>No flock has you in its vote yet</p>');
    expect(dashboard).toContain("'See which flocks have you in their vote'");
    const text = (name) => surfaces.find(([n]) => n === name)[1];
    expect(text('LandingPage.js')).toContain('which flocks have you in their vote this week');
    expect(text('HowItWorksPage.js')).toContain('which flocks have you in their vote');
    expect(text('llms.txt')).toContain('the flocks that have their venue in their vote');
    expect(text('roostNoticeEmail.js')).toContain('seeing which flocks have your venue in their vote');
  });

  test('the In Their Vote tile names the window the feed actually keeps', () => {
    // The tile's line read "flocks, next 7 days", but GET /incoming-flocks
    // also keeps a plan whose time passed up to INCOMING_PAST_HOURS ago, the
    // party that may be inside right now, so the count was not only plans to
    // come. "This week" would have been worse: the This Week card sits just
    // below the tile and counts the LAST 7 days of votes, so the same screen
    // would show two numbers under one name.
    const route = fs.readFileSync(path.join(REPO, 'backend', 'routes', 'venueDashboard.js'), 'utf8');
    const hours = (name) => Number((route.match(new RegExp(`const ${name} = (\\d+);`)) || [])[1]);
    expect(hours('INCOMING_PAST_HOURS')).toBeGreaterThan(0);
    expect(hours('INCOMING_AHEAD_HOURS')).toBe(7 * 24);

    const dashboard = fs.readFileSync(path.join(REPO, 'frontend', 'src', 'screens', 'VenueDashboard.js'), 'utf8')
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const start = dashboard.indexOf('>In Their Vote</p>');
    expect(start).toBeGreaterThan(-1);
    const tile = dashboard.slice(start, dashboard.indexOf('</div>', start));
    expect(tile).toContain('>flocks, now and the week ahead</p>');
    expect(tile).not.toMatch(/next \d+ days|this week/i);
    // The card it must not be confused with is still there, and still looks back.
    expect(dashboard).toContain('>This Week</h3>');
    expect(dashboard).toContain('Last {tw.windowDays} days.');
  });

  test('llms.txt does not sell Roost in the present tense while no venue is charged', () => {
    // It said "Venues are the side Flock charges. Roost ... is $99 a month ...
    // bought on flockcorp.com" ninety lines below its own "no venue is being
    // charged today". VENUE_BILLING_ENABLED is unset, so checkout cannot run.
    // /about already speaks in the right tense; llms.txt now matches it.
    const llms = fs.readFileSync(path.join(REPO, 'frontend', 'public', 'llms.txt'), 'utf8')
      .replace(/\s+/g, ' ');
    expect(llms).not.toMatch(/Venues are the side Flock charges/);
    expect(llms).not.toMatch(/bought on flockcorp\.com/);
    expect(llms).toContain('Roost, the venue plan, will be $99 a month or $990 a year per location');
    expect(llms).toContain('No venue is being charged today');
  });

  test('the SOS email on the page is the one the backend sends', () => {
    // The card is captioned "The actual email." It printed "exact coordinates
    // included" after the real email had stopped claiming exactness (it prints
    // the phone's accuracy radius, or calls a coarse fix an area), and it
    // named no sender while the real one went out as "Flock Safety", an
    // unrelated camera company. Each line the card shows is checked against
    // the template in routes/safety.js, so the two cannot drift apart again.
    const safety = fs.readFileSync(
      path.join(REPO, 'backend', 'routes', 'safety.js'), 'utf8'
    );
    const start = JS.indexOf('<div className="lp-sos-mail">');
    const end = JS.indexOf('className="lp-sos-cap"', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // Bold inside a line is the template's own (<strong>${safeName}</strong>),
    // so it joins its line rather than splitting it.
    const card = JS.slice(start, end)
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
      .replace(/<\/?strong>/g, '')
      .replace(/<[^>]+>/g, '\n')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    expect(card).not.toContainEqual(expect.stringMatching(/exact/i));

    // From: the display name of SAFETY_FROM.
    expect(card).toContain('From');
    const from = /const SAFETY_FROM = '([^<']+?) <alerts@flockcorp\.com>';/.exec(safety);
    expect(from).not.toBeNull();
    expect(card[card.indexOf('From') + 1]).toBe(from[1]);

    // Subject: the alert's subject with the name filled in.
    expect(safety).toContain("`🚨 ${updateKind ? 'Update: ' : ''}Emergency Alert from ${safeSubjectText(userName)}`");
    // the maintainer, the person whose Friday the page follows.
    expect(card).toContain('🚨 Emergency Alert from the maintainer');

    // Body: the headline, the button for a precise fix, the accuracy line and
    // the timestamp line, in the words the template uses.
    expect(safety).toContain('<strong>${safeName}</strong> needs help');
    expect(card).toContain('the maintainer needs help');
    expect(safety).toContain("'View Location on Map'");
    expect(card).toContain('View Location on Map');
    expect(safety).toContain('Accurate to ${accuracyPhrase(fixMetres)}.');
    expect(card).toContain('Accurate to about 15 m.');
    expect(safety).toContain('Alert sent at ${time}');
    expect(card).toContainEqual(expect.stringMatching(/^Alert sent at \d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2} [AP]M [A-Z]{2,4}$/));

    // Since 2026-10-21 the card is as tall as the sheet beside it, and it is
    // filled with two more of the email's own lines, not invented ones: the
    // opening sentence, and the line that tells each contact how many others
    // were asked. the maintainer's sheet says two contacts will be emailed.
    expect(safety).toContain('${safeName} has triggered an emergency alert on the <strong>Flock</strong> app and may need your assistance.');
    expect(card).toContain('the maintainer has triggered an emergency alert on the Flock app and may need your assistance.');
    expect(safety).toContain('You are one of ${withEmail.length} people ${safeName} asked us to alert.');
    expect(card).toContain('You are one of 2 people the maintainer asked us to alert.');
    expect(safety).toContain('This is an automated safety alert from the Flock app. If this is an emergency, call your local emergency number. Replying to this message does not reach ${safeName}.');
    expect(card).toContain('This is an automated safety alert from the Flock app. If this is an emergency, call your local emergency number. Replying to this message does not reach the maintainer.');

    // Since the same evening the card is laid out as the email is: the pink
    // box's heading and the coordinates line under the map button are the
    // template's too.
    expect(safety).toMatch(/<h1 style="[^"]*">Emergency Alert<\/h1>/);
    expect(card).toContain('Emergency Alert');
    expect(safety).toContain('Coordinates: ${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}');
    expect(card).toContainEqual(expect.stringMatching(/^Coordinates: -?\d{1,3}\.\d{6}, -?\d{1,3}\.\d{6}$/));
  });

  test('nothing on the page claims a team that does not exist', () => {
    // Flock is two people, and /about names both. A corporate "we" making a
    // commitment is a register mismatch a reader catches in two clicks, and on the legal surfaces it is a claim an App Store reviewer
    // will hold the product to. "us" as the thing you are not paying is the
    // company as an entity and is fine; a "we" that PROMISES an action is not.
    expect(visible).not.toMatch(/\bwe(’|')ll\b/i);
    expect(visible).not.toMatch(/\bour team\b/i);
    expect(visible).not.toMatch(/\bwe (review|monitor|respond|check|verify)/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('structural fingerprint', () => {
  test('no section is the 1fr|1fr text-beside-media row', () => {
    // .lp-row was Birdie, Money and Safety, one panel repeated three times.
    // On 2026-10-21 Birdie and Money became beats of the Friday plan and the
    // row class went with them. If a new section reaches for it again, pick a
    // different composition instead.
    expect(visible).not.toMatch(/className="lp-wrap lp-row/);
    expect(CSS).not.toMatch(/\.lp-row \{/);
  });

  test('the sections that set things side by side do not share a grid definition', () => {
    // Each has its own template, and the templates differ in proportion, not
    // just in which side the media lands on. Two sections with mirrored
    // 1fr|1fr are the same section. Each template is the widest one the class
    // gets, the last rule for it in the file, since the wide layouts live in
    // min-width blocks that come after the phone default.
    const grid = (cls) => {
      const all = [...CSS.matchAll(new RegExp(`\\.${cls} \\{[^}]*?grid-template-columns:\\s*([^;]+);`, 'g'))];
      expect(all.length).toBeGreaterThan(0);
      return all[all.length - 1][1].replace(/\s+/g, ' ').trim();
    };
    // The hero left this list on 2026-10-21: its words now sit alone in the
    // top-left corner with the screens running full width under them.
    expect(CSS).toMatch(/\.lp-hero-in \{ display: block; \}/);
    const safety = grid('lp-safety');
    const venues = grid('lp-venues-in');
    // The beats went from centred stacks to rows on 2026-10-21 (his third
    // look): words beside the picture from 960px, centred over it on a phone.
    const beats = grid('lp-beat-row');
    expect(new Set([safety, venues, beats]).size).toBe(3);
    expect(CSS).toMatch(/\.lp-beat \{[^}]*text-align: center;/);
    expect(visible).not.toMatch(/lp-beat-main|has-plate/);
  });

  test('Safety keeps its two standing guarantees in one row under its facts', () => {
    // They sat as two loose lines at the foot of the band, a page width apart
    // (2026-10-21). Now they follow the facts, inside the same column.
    const body = visible.slice(visible.indexOf('className="lp-safety-body"'), visible.indexOf('className="lp-safety-exhibits"'));
    expect(body.indexOf('className="lp-safety-facts"')).toBeGreaterThan(-1);
    expect(body.indexOf('className="lp-list lp-safety-rules"')).toBeGreaterThan(body.indexOf('className="lp-safety-facts"'));
    expect(CSS).toMatch(/\.lp-safety \.lp-safety-rules \{\s*display: flex;/);
  });

  test('no hairline dividers: lists, beats, sections and the hero carry no rules', () => {
    // 2026-10-03: the page was cut into panels by 1px lines, between list rows,
    // between the four steps, above sections and under the hero headline, which
    // is the look of a site built from a template. Space does that work now,
    // and the Friday beats that replaced the steps are held to the same rule.
    expect(CSS).not.toMatch(/\.lp-list li \+ li \{[^}]*border/);
    expect(CSS).not.toMatch(/\.lp-sec-ruled\b/);
    expect(CSS).not.toMatch(/\.lp-hero-rule\b/);
    expect(visible).not.toMatch(/lp-hero-rule|lp-sec-ruled/);
    // The beats are bands now (2026-10-21): the band's ground comes from the
    // section classes, and nothing draws a rule between or around a beat.
    for (const sel of ['\\.lp-beat', '\\.lp-sec\\.lp-beat-band']) {
      const rules = CSS.match(new RegExp(`${sel} \\{[^}]*\\}`, 'g')) || [];
      expect(rules.length).toBeGreaterThan(0);
      for (const r of rules) expect(r).not.toMatch(/border|background/);
    }
  });

  test('no two neighbouring sections share a background, here or on /research', () => {
    // A new topic should always start on a new colour (2026-10-03).
    const bands = (src) => [...src.matchAll(/<section className="([^"]+)"/g)].map(([, cls]) => {
      if (/\b(lp-sec-navy|lp-hero|lp-cta|rs-hero|rs-end)\b/.test(cls)) return 'navy';
      if (/\blp-sec-sand\b/.test(cls)) return 'sand';
      if (/\blp-sec-paper\b/.test(cls)) return 'paper';
      return `unknown:${cls}`;
    });
    const research = fs.readFileSync(path.join(WEBSITE, 'ResearchPage.js'), 'utf8');
    for (const [name, src] of [['landing', visible], ['research', research]]) {
      const seq = bands(src);
      expect(seq.length).toBeGreaterThan(3);
      expect(seq.filter((b) => b.startsWith('unknown'))).toEqual([]);
      for (let i = 1; i < seq.length; i++) {
        expect(`${name} ${i}: ${seq[i - 1]} -> ${seq[i]}`).not.toMatch(/: (\w+) -> \1$/);
      }
    }
    expect(CSS).toMatch(/\.lp-sec-sand \{ background: var\(--paper-2\); \}/);
    // The "What we found" stats band was cut from /research.
    expect(research).not.toMatch(/What we found|rs-stats|const STATS/);
  });

  test('a solid bar and printed plates: no frosted header, no floating shadows', () => {
    // The translucent blurred bar and the soft drop shadows under the phone
    // screenshots and the demo are the stock site-builder look (2026-10-03).
    const nav = CSS.match(/\.lp-nav \{[^}]*\}/)[0];
    expect(nav).not.toMatch(/backdrop-filter|rgba\(/);
    expect(nav).toMatch(/background: var\(--navy\);/);
    for (const sel of ['\\.lp-shot', '\\.lp-shot-hero', '\\.lp-sec-navy \\.lpd-stage']) {
      const rule = CSS.match(new RegExp(`${sel} \\{[^}]*\\}`))[0];
      expect(rule).not.toMatch(/box-shadow/);
    }
  });

  test('pricing is a rate sheet: open columns, no boxed or inverted cards', () => {
    // The plans were bordered, rounded cards with the venue one inverted to
    // navy, the stock pricing block of a template site (2026-10-03).
    const plan = CSS.match(/\.lp-plan \{[^}]*\}/)[0];
    expect(plan).not.toMatch(/border|background|border-radius|box-shadow/);
    expect(CSS).not.toMatch(/\.lp-plan-venue\b/);
    expect(visible).not.toMatch(/lp-plan-venue/);
    const price = CSS.match(/\.lp-plan-price \{[^}]*\}/)[0];
    expect(price).toMatch(/font-family: var\(--font-display\)/);
  });

  test('no eyebrows', () => {
    // An eyebrow is an ordinal device. This page had four, then two, over
    // headings that already stated the subject. When every section is
    // chaptered, none of them is. On 2026-10-21 the last two went: each
    // heading on the page now says what its section is about in a sentence.
    expect(visible).not.toMatch(/className="lp-kicker"/);
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
    expect(CSS).toMatch(/--plate: #fdfcf9;/);
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
