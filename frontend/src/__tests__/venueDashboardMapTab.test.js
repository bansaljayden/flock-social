/**
 * VENUE DASHBOARD MAP TAB — the owner sees their venue exactly as consumers do.
 *
 * The tab exists for one demonstration: the owner opens the map, sees their
 * own pin among the same nearby pins users get, taps a pin and the SAME card
 * consumers see opens — and when they set the "How full are you right now?"
 * slider, the published number visibly flips to "the {venue-type} says"
 * (category-derived, e.g. "the cafe says") in front of
 * them. That only stays true under four conditions, each pinned here:
 *
 *   1. ONE CARD. The venue card is a single definition
 *      (renderConsumerVenueCard) rendered by both Discover and the dashboard
 *      map tab. Two copies of the card is two cards that drift apart, and the
 *      owner ends up looking at a rendering users never get.
 *
 *   2. CONSUMER DATA ONLY. The tab loads its pins through the same public
 *      lookups users hit (/api/venues/details, /api/venues/search,
 *      /api/crowd/batch). No owner-only read feeds a pin, so what the owner
 *      sees cannot be a flattering variant.
 *
 *   3. OWNER VIEW DROPS ACTIONS, NEVER INFORMATION. On the dashboard the card
 *      hides consumer actions (start a flock, check in, the crowd reality
 *      check, nearby navigation) because a venue account acting on them would
 *      dead-end into consumer-only screens or write user-shaped crowd
 *      signals. Everything informational — score, the owner attribution, the source
 *      line — renders from the same JSX with no owner-view fork.
 *
 *   4. THE PROOF LOOP CLOSES. Setting or clearing the slider refetches the
 *      venue's PUBLISHED score through the consumer endpoint and writes it
 *      into the pin list, the prediction store and the open card. The server
 *      applies owner reports at send time even on cached predictions
 *      (backend/routes/crowd.js), which is what makes an immediate refetch
 *      truthful rather than hopeful.
 *
 * Source-scanning, like every other App.js suite here.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');

// The venue owner dashboard left App.js on 2026-08-26: it is its own lazily
// loaded chunk now (screens/VenueDashboard.js), and about 2,000 lines of what
// this file scans went with it. Nothing asserted below changed. The app source
// is simply in two files, so both are read, in the order they used to be one.
const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, '..', 'screens', 'VenueDashboard.js'), 'utf8');

function codeOnly(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

function region(startMarker, endMarker) {
  const start = APP.indexOf(startMarker);
  const end = APP.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return APP.slice(start, end);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. One card, both surfaces
// ═══════════════════════════════════════════════════════════════════════════

describe('one venue card for every map surface', () => {
  it('the card is a single definition', () => {
    // "The {noun} says it's at N% right now" is the card's signature
    // sentence (the noun is the server's category-derived word). If it ever
    // appears twice, someone copied the card instead of reusing it.
    const code = codeOnly(APP);
    expect(code.split("says it's at {cd.score}% right now").length - 1).toBe(1);
    // The line above is what proves "single definition". This one only has to
    // prove the definition is the shared one, so it pins the two things that
    // carry meaning and nothing else: the options object has a default, so
    // every existing caller can keep calling it with no arguments, and
    // venueOwnerView defaults to false, so the CONSUMER card is what you get
    // when nobody asks for the owner variant. It used to be a toContain of the
    // whole parameter list, which fails the moment a second option is added
    // beside venueOwnerView. That is a behaviour-preserving change, and it is
    // exactly how signOutClearsDevice broke tonight: the property survived and
    // the spelling did not.
    expect(APP).toMatch(/const renderConsumerVenueCard = \(\{[^}]*\bvenueOwnerView = false\b[^}]*\} = \{\}\) => \{/);
  });

  it('Discover renders the card through the shared function', () => {
    expect(codeOnly(APP)).toContain('{!showConnectPanel && renderConsumerVenueCard()}');
    // The old inline block must be gone.
    expect(APP).not.toContain('{activeVenue && !showConnectPanel && (');
  });

  it('the dashboard map tab renders the card as owner view', () => {
    expect(codeOnly(APP)).toContain('renderConsumerVenueCard({ venueOwnerView: true })');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Consumer data only
// ═══════════════════════════════════════════════════════════════════════════

describe('the map tab reads what users read', () => {
  const loader = codeOnly(region('const loadVenueMap = React.useCallback', 'useEffect(() => {'));

  it('pins come from the public consumer lookups', () => {
    expect(loader).toContain('getVenueDetails(placeId)');
    expect(loader).toContain("searchVenues('popular restaurants cafes bars fast food'");
    expect(loader).toContain('requestCrowdScores(raw)');
    expect(loader).toContain('setAllVenues(venuesToMapPins(raw))');
  });

  it('no owner-only read feeds a pin', () => {
    // The dashboard's authenticated reads must not appear in the map loader.
    expect(loader).not.toContain('getVenueIntelligence');
    expect(loader).not.toContain('getVenueStrip');
    expect(loader).not.toContain('venue-dashboard');
  });

  it('a venue with no linked listing gets the honest empty state, not a blank map', () => {
    expect(loader).toContain("reason: 'no_listing'");
    expect(APP).toContain('Link your listing in Edit Profile and the map fills in.');
    // A failed lookup is not an empty area: it says so and offers a real retry.
    expect(loader).toContain("reason: 'load_failed'");
    expect(APP).toContain('onClick={loadVenueMap}');
    expect(APP).toContain('Try again');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Owner view drops actions, never information
// ═══════════════════════════════════════════════════════════════════════════

describe('owner view of the card', () => {
  const card = region('const renderConsumerVenueCard = (', 'const ExploreScreen = () => (');

  it('the crowd reality check never renders for a venue account', () => {
    // An owner "reporting from the room" would be a user-shaped signal that
    // outranks their own slider — self-confirmation dressed as a crowd.
    expect(card).toContain('{!isClosed && !!cd && !venueOwnerView && (');
    expect(card).toContain('<CrowdRealityCheck');
  });

  it('consumer actions are gated out, informational sections are not', () => {
    expect(card).toContain('{!venueOwnerView && (crowdAlternatives.length > 0');
    expect(card).toMatch(/\{!venueOwnerView && \(\s*\n\s*<m\.div initial=\{\{ opacity: 0, y: 14 \}\} animate=\{\{ opacity: 1, y: 0 \}\} transition=\{\{ delay: 1\.1/);
    // The source line is the honesty label; it must carry no owner-view fork.
    const sourceLine = card.slice(card.indexOf("cd.confidenceBasis === 'owner_report'"), card.indexOf('An estimate from typical patterns'));
    expect(sourceLine).not.toContain('venueOwnerView');
  });

  it('the attribution words come from the API payload, never a literal', () => {
    // utils/venueLabel.js decides what a venue is called ("the bar says" vs
    // "the cafe says"). The card renders the server's noun; hardcoding one
    // here would put the wrong word on most venues, and the backend's
    // venueLabel.test.js greps this tree for exactly that mistake.
    expect(card).toContain("cd.ownerReport.noun");
    expect(card).toContain("cd.ownerReport?.noun");
    expect(card).not.toMatch(/bar says/i);
  });

  it('the locked-forecast tease does not open the consumer paywall on a venue account', () => {
    expect(card).not.toContain("e.stopPropagation(); setPaywallTrigger('forecast')");
    const guarded = card.split("if (!venueOwnerView) setPaywallTrigger('forecast')").length - 1;
    expect(guarded).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The proof loop closes
// ═══════════════════════════════════════════════════════════════════════════

describe('slider-to-pin update loop', () => {
  const refresh = codeOnly(region('const refreshOwnerPublishedScore = async () => {', 'const handleSetBusyNow'));

  it('the refresh reads the consumer endpoint and writes all three surfaces', () => {
    expect(refresh).toContain('getCrowdPrediction(pid)');
    expect(refresh).toContain('setCrowdPredictions(prev');
    expect(refresh).toContain('setAllVenues(prev');
    expect(refresh).toContain('setCrowdData(data)');
  });

  it('both set and clear trigger the refresh', () => {
    const setFn = codeOnly(region('const handleSetBusyNow = async () => {', 'const handleClearBusyNow'));
    const clearFn = codeOnly(region('const handleClearBusyNow = async () => {', '// The venue logo is one of'));
    expect(setFn).toContain('refreshOwnerPublishedScore()');
    expect(clearFn).toContain('refreshOwnerPublishedScore()');
  });

  it('the slider state loads on the map tab, not only on analytics', () => {
    expect(APP).toContain("if ((venueTab !== 'analytics' && venueTab !== 'map') || !venueProfile) return;");
  });

  it('the slider card is one definition shared by both tabs', () => {
    // Same reasoning as the consumer card above: the call count below is the
    // "one definition, two tabs" property, and pinning an empty parameter list
    // here would only mean this test fails on the day somebody gives the card
    // an option. The declaration has to exist; how many arguments it takes is
    // not what this test is about.
    expect(APP).toMatch(/const renderBusyNowCard = \([^)]*\) => \{/);
    const calls = codeOnly(APP).split('renderBusyNowCard()').length - 1;
    expect(calls).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. The map itself: owner pin marked, no geolocation theater
// ═══════════════════════════════════════════════════════════════════════════

describe('dashboard map behavior', () => {
  it('the tab bar carries the Map tab and scrolls instead of overflowing 320px', () => {
    const tabs = region('const venueTabs = [', '];');
    expect(tabs).toContain("{ id: 'map', label: 'Map', icon: Icons.map }");
    const strip = region('{venueTabs.map(tab => (', '))}');
    expect(strip).toContain("flex: '1 0 auto'");
    const bar = region('{/* Tab Navigation */}', '{venueTabs.map');
    expect(bar).toContain("overflowX: 'auto'");
  });

  it("the owner's own pin is marked, permanently, not zoom-gated", () => {
    expect(APP).toContain("chip.textContent = 'Your venue';");
    expect(APP).toContain('.mlb-owner-chip');
    // The chip class must not appear inside the zoom-tier gate that hides
    // ordinary labels below the "hi" tier.
    expect(APP).not.toContain('[data-zoom-tier="hi"] .mlb-owner-chip');
  });

  it('the dashboard map never asks for the phone location', () => {
    // The venue's position is the venue's listing, not the owner's phone. A
    // geolocation prompt on a dashboard tab would be permission theater.
    expect(APP).toContain('followUser={false}');
    // The property, not the spelling, for the same reason the initialCenter
    // line below already says so. What the dashboard needs is that a false
    // followUser short-circuits the watch before watchPosition is reached. The
    // exact characters of that condition were pinned here, and the Settings
    // location switch added a third term to it on 2026-08-26, so this read as
    // the dashboard asking for a location when nothing about the dashboard had
    // changed. `!followUser` is still the second test in the guard and still
    // returns; anything else in the condition is somebody else's rule.
    //
    // The tail is [^\n]* rather than [^)]* because the availability check is a
    // CALL now (`!geolocationAvailable()`, the shim that keeps WKWebView from
    // raising its own "localhost" prompt), and a term with parentheses in it
    // broke a pattern that had assumed the condition contained none. The rest
    // of the line is still somebody else's rule.
    expect(APP).toMatch(/if \(!mapReady \|\| !followUser \|\|[^\n]*\) return;/);
    // The property, not the spelling: initialCenter has to short-circuit the
    // geolocation call. That expression gained a second skip on 2026-08-26 for
    // the Settings location switch, and pinning its exact characters made this
    // read as broken when the dashboard's behaviour had not changed at all.
    expect(APP).toContain('initialCenter ? { lat: initialCenter.lat, lng: initialCenter.lng }');
    expect(APP).toMatch(/const located = \(initialCenter \|\|[^)]*\)/);
    expect(APP).toMatch(/\{followUser && \(\s*\n\s*<button aria-label="My Location"/);
  });

  it('the map mounts centered on the venue with the consumer pin list', () => {
    const mapTab = region("{venueTab === 'map' && (", "{venueTab === 'analytics' && !can.analytics");
    expect(mapTab).toContain('venues={allVenues}');
    expect(mapTab).toContain('ownerPlaceId={venueProfile?.google_place_id || null}');
    expect(mapTab).toContain('initialCenter={venueMapState.center}');
  });
});
