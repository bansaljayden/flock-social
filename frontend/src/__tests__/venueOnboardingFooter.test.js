/**
 * THE VENUE SIGNUP'S FOOTER, ITS STEPS AND ITS LAST TAP.
 *
 * screens/VenueOnboarding.js is twelve steps over one fixed footer. Four
 * things were wrong with it, and each is pinned here:
 *   - the keyboard covered Continue: the WebView does not resize for it
 *     (resize: 'none'), and the footer padded only for the home indicator;
 *   - steps 0 to 5 were centred and 6 to 11 top-aligned, so the heading sat
 *     at a different height on each step and jumped on Continue;
 *   - Launch Dashboard had no guard, so a quick second tap sent a second
 *     create for the same venue;
 *   - the venue search said "Looking..." in grey on the navy instead of
 *     drawing the result rows in the skeleton's dark tone.
 *
 * The screen is rendered with a harness that holds the state App.js holds
 * for it, so a step change or an error re-renders it as it does in the app.
 * jsdom drops a padding shorthand it cannot parse (calc with var), so the
 * footer's keyboard padding is read from the source.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern=venueOnboardingFooter
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, fireEvent, waitFor, act } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  checkVenueClaim: jest.fn(),
  createVenueProfile: jest.fn(),
  getVenueDetails: jest.fn(),
  searchVenues: jest.fn(),
}));
jest.mock('../services/userSettings', () => ({ queueSync: jest.fn() }));
jest.mock('../components/ui/BirdieBird', () => ({ BirdieStill: () => null, WARM_BIRD: {} }));

const api = require('../services/api');
const VenueOnboarding = require('../screens/VenueOnboarding').default;

const ONBOARDING_SRC = fs.readFileSync(path.join(__dirname, '..', 'screens', 'VenueOnboarding.js'), 'utf8');

const LAST_STEP = 11;

const EMPTY_DATA = {
  businessName: '', category: '', location: '', description: '', goals: [],
  capacity: '', serviceStyle: '', hasOutdoorSeating: null,
  reservationPolicy: '', largestWalkinGroup: '', typicalDwellMinutes: '', typicalSpendPerPerson: '',
  kitchenLastOrder: '', lastCall: '', agePolicy: '', ageRestrictedAfter: '',
  eventNights: [], eventNote: '', ownerBusyNights: [], targetNight: '',
  anchorTypes: [], anchorNote: '',
  quirks: '',
};

// App.js's own input, reduced to what the steps use.
const SearchInputLocal = ({ as, initialValue, onCommit, ...rest }) => (as === 'textarea'
  ? <textarea defaultValue={initialValue} onChange={(e) => onCommit(e.target.value)} {...rest} />
  : <input defaultValue={initialValue} onChange={(e) => onCommit(e.target.value)} {...rest} />);

/** The state App.js holds for the screen, so it re-renders as it does there. */
function Harness({ initialStep = 0, initialSearchState = 'idle', spies }) {
  const [step, setStep] = React.useState(initialStep);
  const [data, setData] = React.useState({ ...EMPTY_DATA, googlePlaceId: 'place-1', businessName: 'The Heron', category: 'Bar / Nightclub', location: 'Austin, TX', goals: ['More walk-ins'] });
  const [error, setError] = React.useState('');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [searchResults, setSearchResults] = React.useState([]);
  const [searchState, setSearchState] = React.useState(initialSearchState);
  const [searchError, setSearchError] = React.useState('');
  const timer = React.useRef(null);
  return (
    <VenueOnboarding
      SearchInputLocal={SearchInputLocal}
      VENUE_MAX_ANCHORS={3}
      parseGoogleHours={() => []}
      renderVenueChips={({ label }) => <div>{label}</div>}
      renderVenueField={({ label, children }) => <div><span>{label}</span>{children}</div>}
      renderVenueNumber={({ ariaLabel }) => <input aria-label={ariaLabel} />}
      renderVenueTime={({ ariaLabel }) => <input aria-label={ariaLabel} />}
      setCurrentScreen={spies.setCurrentScreen}
      setCurrentTab={spies.setCurrentTab}
      setOperatingHours={jest.fn()}
      setShowVenueOnboarding={spies.setShowVenueOnboarding}
      setShowModeSelection={jest.fn()}
      setUserMode={jest.fn()}
      onUserPatch={jest.fn()}
      setVenueInfo={jest.fn()}
      setVenueOnboardingData={setData}
      setVenueOnboardingError={setError}
      setVenueOnboardingStep={setStep}
      setVenueSearchError={setSearchError}
      setVenueSearchQuery={setSearchQuery}
      setVenueSearchResults={setSearchResults}
      setVenueSearchState={setSearchState}
      userLocation={null}
      venueAgePolicies={[{ value: 'all_ages', label: 'All ages' }]}
      venueAnchorTypes={[{ value: 'stadium', label: 'Stadium' }]}
      venueCategories={['Bar / Nightclub', 'Restaurant']}
      venueGoals={['More walk-ins']}
      venueOnboardingData={data}
      venueOnboardingError={error}
      venueOnboardingStep={step}
      venueReservationPolicies={[{ value: 'walk_in', label: 'Walk-ins' }]}
      venueSearchError={searchError}
      venueSearchQuery={searchQuery}
      venueSearchResults={searchResults}
      venueSearchState={searchState}
      venueSearchTimer={timer}
      venueServiceStyles={[{ value: 'table', label: 'Table service' }]}
      venueWeekdays={[{ value: 'fri', label: 'Fri' }]}
    />
  );
}

const open = (props = {}) => {
  const spies = { setCurrentScreen: jest.fn(), setCurrentTab: jest.fn(), setShowVenueOnboarding: jest.fn() };
  const utils = render(<Harness spies={spies} {...props} />);
  return { ...utils, spies };
};

afterEach(() => {
  jest.clearAllMocks();
});

describe('Launch Dashboard sends one create', () => {
  it('a second tap before the screen re-renders is stopped, and the button says it is working', async () => {
    let answer;
    api.createVenueProfile.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const utils = open({ initialStep: LAST_STEP });
    const launch = utils.getByRole('button', { name: 'Launch Dashboard' });

    // Both taps land inside one act, so nothing re-renders between them and
    // the disabled attribute cannot be what stops the second: only the ref.
    act(() => { launch.click(); launch.click(); });
    expect(api.createVenueProfile).toHaveBeenCalledTimes(1);
    const pending = utils.getByRole('button', { name: 'Launching…' });
    expect(pending.disabled).toBe(true);
    expect(pending.getAttribute('aria-busy')).toBe('true');

    await act(async () => { answer({ role: 'owner' }); });
    expect(utils.spies.setShowVenueOnboarding).toHaveBeenCalledTimes(1);
    expect(utils.spies.setShowVenueOnboarding).toHaveBeenCalledWith(false);
    expect(utils.spies.setCurrentScreen).toHaveBeenCalledWith('venueDashboard');
  });

  it('a refusal gives the button back, with every answer kept, and the next tap sends again', async () => {
    // The screen logs the refusal it shows; that line is not this test's.
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    api.createVenueProfile.mockRejectedValueOnce(Object.assign(new Error('That business is already claimed by a verified owner.'), { status: 409 }));
    const utils = open({ initialStep: LAST_STEP });
    fireEvent.click(utils.getByRole('button', { name: 'Launch Dashboard' }));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe('That business is already claimed by a verified owner.'));
    const launch = utils.getByRole('button', { name: 'Launch Dashboard' });
    expect(launch.disabled).toBe(false);
    expect(utils.spies.setShowVenueOnboarding).not.toHaveBeenCalled();

    api.createVenueProfile.mockResolvedValueOnce({ role: 'owner' });
    fireEvent.click(launch);
    await waitFor(() => expect(utils.spies.setCurrentScreen).toHaveBeenCalledWith('venueDashboard'));
    expect(api.createVenueProfile).toHaveBeenCalledTimes(2);
    quiet.mockRestore();
  });
});

describe('every step starts at the top', () => {
  for (let step = 0; step <= LAST_STEP; step += 1) {
    it(`step ${step} is top-aligned and scrolls inside itself`, () => {
      const { container } = open({ initialStep: step });
      // The screen is three rows: the progress header, the step, the footer.
      const rows = container.firstChild.children;
      expect(rows).toHaveLength(3);
      const content = rows[1];
      expect(content.style.justifyContent).not.toBe('center');
      expect(content.style.overflowY).toBe('auto');
      expect(content.style.flex).toMatch(/^1/);
    });
  }

  it('no step container is vertically centred any more', () => {
    expect(ONBOARDING_SRC).not.toMatch(/justifyContent: 'center', (alignItems: 'center', )?padding: '24px'/);
  });
});

describe('the footer clears the keyboard', () => {
  it('pads by the keyboard inset on top of the home indicator gap', () => {
    expect(ONBOARDING_SRC).toContain("padding: '16px 24px calc(24px + var(--safe-bottom) + var(--kb-inset, 0px))'");
    // The curve the sheets use (.kb-lift in index.css).
    expect(ONBOARDING_SRC).toContain("transition: 'padding-bottom 250ms cubic-bezier(0.38, 0.7, 0.125, 1)'");
  });

  it('the footer is the last row, after the step, with Continue in it', () => {
    const { container, getByRole } = open({ initialStep: 3 });
    const rows = container.firstChild.children;
    expect(rows[2].contains(getByRole('button', { name: 'Continue' }))).toBe(true);
  });

  it('the inset it reads is written in the signed-in shell, which this screen renders inside', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8');
    expect(css).toMatch(/--kb-inset:\s*max\(0px,\s*calc\(var\(--kb-height,\s*0px\)\s*-\s*var\(--safe-bottom\)\)\);/);
    const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
    const inner = app.slice(app.indexOf('const FlockAppInner = ('));
    expect(inner.slice(0, 2000)).toContain('useKeyboardInset();');
  });
});

describe('the venue search, while it runs', () => {
  const spies = { setCurrentScreen: jest.fn(), setCurrentTab: jest.fn(), setShowVenueOnboarding: jest.fn() };

  it('draws two result rows in the dark skeleton tone in place of "Looking...", and says so to a screen reader', () => {
    const { container, getByRole } = render(<SearchStep searchState="searching" spies={spies} />);
    const bars = container.querySelectorAll('.skeleton.skeleton-dark');
    expect(bars).toHaveLength(4);
    bars.forEach((bar) => expect(bar.closest('[aria-hidden="true"]')).not.toBeNull());
    expect(getByRole('status').textContent).toBe('Searching for your venue');
    expect(container.textContent).not.toMatch(/Looking/);
  });

  it('draws none of it when no search is running', () => {
    const { container } = render(<SearchStep searchState="idle" spies={spies} />);
    expect(container.querySelector('.skeleton')).toBeNull();
  });
});

/** Step 1 before a venue is picked, which is when the search box is drawn. */
function SearchStep({ searchState, spies }) {
  const [data, setData] = React.useState({ ...EMPTY_DATA });
  const timer = React.useRef(null);
  return (
    <VenueOnboarding
      SearchInputLocal={SearchInputLocal}
      VENUE_MAX_ANCHORS={3}
      parseGoogleHours={() => []}
      renderVenueChips={() => null}
      renderVenueField={() => null}
      renderVenueNumber={() => null}
      renderVenueTime={() => null}
      setCurrentScreen={spies.setCurrentScreen}
      setCurrentTab={spies.setCurrentTab}
      setOperatingHours={jest.fn()}
      setShowVenueOnboarding={spies.setShowVenueOnboarding}
      setShowModeSelection={jest.fn()}
      setUserMode={jest.fn()}
      onUserPatch={jest.fn()}
      setVenueInfo={jest.fn()}
      setVenueOnboardingData={setData}
      setVenueOnboardingError={jest.fn()}
      setVenueOnboardingStep={jest.fn()}
      setVenueSearchError={jest.fn()}
      setVenueSearchQuery={jest.fn()}
      setVenueSearchResults={jest.fn()}
      setVenueSearchState={jest.fn()}
      userLocation={null}
      venueAgePolicies={[]}
      venueAnchorTypes={[]}
      venueCategories={[]}
      venueGoals={[]}
      venueOnboardingData={data}
      venueOnboardingError=""
      venueOnboardingStep={1}
      venueReservationPolicies={[]}
      venueSearchError=""
      venueSearchQuery="Her"
      venueSearchResults={[]}
      venueSearchState={searchState}
      venueSearchTimer={timer}
      venueServiceStyles={[]}
      venueWeekdays={[]}
    />
  );
}
