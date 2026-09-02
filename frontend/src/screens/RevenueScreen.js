/**
 * ADMIN COSTS AND REVENUE CONSOLE
 *
 * This screen was 1,387 lines of `App.js`, declared as an arrow function
 * inside `FlockAppInner` and mounted as an element rather than called. It is
 * the founder-facing admin console: four tabs, Revenue, Costs, Projections and
 * Research, behind `authUser.role === 'admin'` and reachable by nobody else.
 * It is the largest single-screen block that was still bundled into the boot
 * chunk for every teenager who opened Flock to vote on a bar, and none of them
 * can reach it.
 *
 * WHY THIS ONE IS LAZY
 *
 * The far end of the same scale the flock chat screen sits at the near end of.
 * Chat is the screen the product exists to show, every user opens it, so it is
 * a static import and pays for itself in the boot chunk. This console is the
 * opposite: it is admin only, it is opened by one account, and almost nobody
 * loads it. So it is `React.lazy` from `App.js`, its own chunk fetched the
 * first time an admin opens it and costs nothing at all to everyone else, the
 * same call the venue owner dashboard already made and for the same reason.
 *
 * WHY EVERYTHING ARRIVES AS A PROP
 *
 * The old arrow function closed over 27 names in `FlockAppInner`: the six
 * revenue-simulator fields and their setters, the research and costs state and
 * their loaders, `switchMode`, and `colors` and `styles`. A context would have
 * had to enumerate exactly the same 27 names into a provider value, so it buys
 * nothing here and hides the dependency surface behind a hook. They are
 * parameters instead, so this file's entire dependency surface is its
 * parameter list plus its imports, and a name this component reads and does not
 * receive is an undefined identifier that `no-undef` fails the build on, rather
 * than a prop that is silently `undefined` at runtime and renders as nothing.
 * The twelve module-level names it also read are all imports (the finance math,
 * the birds and the icon set), so they are imported here directly rather than
 * threaded through the props object.
 *
 * The 27 names were not read off the page. They came from a Babel scope walk of
 * the block, every `ReferencedIdentifier` whose binding resolves outside it,
 * and the parameter list below and the props object at the call site were both
 * generated from that one array, so they cannot drift apart.
 *
 * The state behind these props deliberately did NOT move. It lives in
 * `FlockAppInner`, which does not unmount when the admin leaves the console, so
 * the six simulator fields, the research pull and the costs pull survive a trip
 * to another screen exactly as they did before. It was hoisted up there in the
 * first place because this screen used to remount on every unrelated render;
 * moving to module scope fixes the remount, and keeping the state in
 * `FlockAppInner` is now the same choice the other extracted screens made.
 *
 * The body below is the old block verbatim, including its original four-space
 * indentation, so it can be diffed against the deleted lines character for
 * character. Nothing was renamed, reformatted or improved on the way across.
 */
import React from 'react';
import { BirdieStill, WARM_BIRD } from '../components/ui/BirdieBird';
import Icons from '../components/ui/Icons';
import {
  calculateAnnualRevenue,
  calculateBreakEven,
  calculateMonthlyProfit,
  calculateProfitMargin,
  calculateRevenuePerVenue,
  calculateSubscriptionRevenue,
  calculateTotalMonthlyRevenue,
  calculateTransactionRevenue,
  formatCurrency,
} from '../lib/finance';

export default function RevenueScreen({
  adminTab,
  avgSpend,
  colors,
  costsData,
  costsError,
  costsLoading,
  eventsPerVenue,
  fetchCosts,
  fetchResearchLive,
  numVenues,
  operatingCosts,
  researchDemoMode,
  researchError,
  researchLiveData,
  researchLoading,
  setAdminTab,
  setAvgSpend,
  setEventsPerVenue,
  setNumVenues,
  setOperatingCosts,
  setResearchDemoMode,
  setSubscriptionPrice,
  setTakeRate,
  styles,
  subscriptionPrice,
  switchMode,
  takeRate,
}) {
    // adminTab state is now at App level to persist across re-renders

    // Admin tabs definition.
    //
    // Two of these three tabs used to carry the IDENTICAL Icons.barChart, so a
    // three-tab bar offered two tabs you could not tell apart without reading,
    // and the labels did not help either: "Revenue" and "Money" are the same
    // word twice. The tab whose id is already `projections` is now labelled
    // Projections and carries trendingUp, which is what it actually shows.
    // Three tabs, three glyphs, three distinct meanings.
    // Costs landed 2026-08-20 as the fourth. It carries creditCard, which is
    // the only glyph in the set that says "a bill arrived" rather than "a
    // number went up", and the label is the one word Jayden used for it.
    const adminTabs = [
      { id: 'revenue', label: 'Revenue', icon: Icons.dollar },
      { id: 'costs', label: 'Costs', icon: Icons.creditCard },
      { id: 'projections', label: 'Projections', icon: Icons.trendingUp },
      { id: 'research', label: 'Research', icon: Icons.barChart }
    ];

    // Revenue simulator state lives at FlockAppInner level, next to adminTab
    // and for the same reason. See the note there.

    // Calculate all metrics
    const subscriptionRevenue = calculateSubscriptionRevenue(numVenues, subscriptionPrice);
    const transactionRevenue = calculateTransactionRevenue(numVenues, eventsPerVenue, avgSpend, takeRate);
    const totalMonthlyRevenue = calculateTotalMonthlyRevenue(subscriptionRevenue, transactionRevenue);
    const annualRevenue = calculateAnnualRevenue(totalMonthlyRevenue);
    const monthlyProfit = calculateMonthlyProfit(totalMonthlyRevenue, operatingCosts);
    const revenuePerVenue = calculateRevenuePerVenue(totalMonthlyRevenue, numVenues);
    const breakEvenVenues = calculateBreakEven(operatingCosts, subscriptionPrice, eventsPerVenue, avgSpend, takeRate);
    const profitMargin = calculateProfitMargin(monthlyProfit, totalMonthlyRevenue);
    const isProfitable = monthlyProfit >= 0;
    // calculateBreakEven returns Infinity when a venue generates no revenue,
    // which you reach just by zeroing the subscription price. Rendering it raw
    // put "Infinity venues" and "Need Infinity more venues" on screen.
    const breakEvenReachable = Number.isFinite(breakEvenVenues);
    const isAboveBreakEven = breakEvenReachable && numVenues >= breakEvenVenues;
    // Margin is undefined with no revenue, and revenue per venue is undefined
    // with no venues. Both return 0 from lib/finance.js to keep the type finite,
    // so the screen has to say "n/a" rather than print the placeholder.
    const marginDefined = totalMonthlyRevenue > 0;
    const revenuePerVenueDefined = numVenues > 0;

    // Input field style
    const inputStyle = {
      width: '100%',
      padding: '10px 12px',
      borderRadius: '8px',
      border: `1px solid ${colors.creamDark}`,
      fontSize: 'var(--t-body)',
      fontWeight: '600',
      color: colors.navy,
      backgroundColor: 'var(--bg-card-solid)',
      outline: 'none',
      boxSizing: 'border-box',
    };

    const labelStyle = {
      fontSize: 'var(--t-meta)',
      fontWeight: '500',
      color: colors.navy,
      marginBottom: '4px',
      display: 'block',
    };

    const helperStyle = {
      fontSize: 'var(--t-meta)',
      color: 'var(--text-tertiary)',
      marginTop: '2px',
    };

    const cardStyle = {
      backgroundColor: 'var(--bg-card-solid)',
      borderRadius: '12px',
      padding: '12px',
      marginBottom: '10px',
      boxShadow: 'var(--card-shadow-sm)',
    };

    return (
      <div key="revenue-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--bg-primary)' }}>
        {/* Header */}
        <div style={{ padding: '16px', background: colors.navyBg, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button aria-label="Back" className="hit44" onClick={switchMode} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.arrowLeft('white', 16)}
            </button>
            {/* Cobalt Birdie, still. This slot held a generic briefcase glyph,
                which said "office software" on the one screen that is purely
                ours. 44px is a brand mark, not an icon; the photo carries its
                own light against the navy. Eager because the header is the
                first paint of this screen — a lazy image here pops in. */}
            <BirdieStill size={44} eager style={{ flexShrink: 0 }} />
            <div>
              <h1 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: 'white', margin: 0 }}>Admin Dashboard</h1>
              <p style={{ fontSize: 'var(--t-meta)', color: 'rgba(255,255,255,0.7)', margin: 0 }}>Analytics, revenue and moderation</p>
            </div>
          </div>
          {/* Where the reports queue actually lives. /admin/moderation is a
              PAGES route index.js matches BEFORE the native-shell fallback,
              so navigating the WebView there IN PLACE renders the
              authenticated console with the app's own localStorage token, and
              the console's Back to Flock link boots the app again. The
              previous iOS branch printed the URL in a span that could be
              neither tapped nor copied, on the strength of a comment claiming
              the admin would be stranded there; that premise was wrong, and
              the routing above is why. What WOULD strand the token is an
              external open into Safari (different origin, no token), which is
              why the native branch navigates in place instead of using
              target="_blank". */}
          {(() => {
            const isNative = typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true;
            const boxStyle = { marginTop: '12px', padding: '10px 12px', borderRadius: '10px', backgroundColor: 'rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', gap: '8px' };
            if (isNative) {
              return (
                <button type="button" className="hit44" onClick={() => window.location.assign('/admin/moderation')} style={{ ...boxStyle, width: '100%', border: 'none', cursor: 'pointer', textAlign: 'left', font: 'inherit' }}>
                  {Icons.shield('white', 16)}
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: 'white' }}>Moderation console</span>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'rgba(255,255,255,0.7)', marginLeft: 'auto' }}>Reports and takedowns</span>
                </button>
              );
            }
            return (
              <a href="/admin/moderation" target="_blank" rel="noopener noreferrer" className="hit44" style={{ ...boxStyle, textDecoration: 'none', cursor: 'pointer' }}>
                {Icons.shield('white', 16)}
                <span style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: 'white' }}>Moderation console</span>
                <span style={{ fontSize: 'var(--t-meta)', color: 'rgba(255,255,255,0.7)', marginLeft: 'auto' }}>Reports and takedowns</span>
              </a>
            );
          })()}
        </div>

        {/* Tab Navigation */}
        <div style={{ display: 'flex', backgroundColor: 'var(--bg-card-solid)', borderBottom: '1px solid var(--border-default)', flexShrink: 0, padding: '8px 4px', gap: '4px' }}>
          {adminTabs.map(tab => (
            <button className="hit44" key={tab.id} onClick={() => setAdminTab(tab.id)} style={{ flex: 1, padding: '12px 4px', border: 'none', backgroundColor: adminTab === tab.id ? colors.navyBg : 'var(--bg-card-solid)', borderRadius: '10px', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', transition: 'opacity 0.2s' }}>
              {tab.icon(adminTab === tab.id ? 'white' : colors.navy, 18)}
              <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: adminTab === tab.id ? 'white' : colors.navy }}>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>

          {/* REVENUE TAB */}
          {adminTab === 'revenue' && (<>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>

            {/* LEFT COLUMN - INPUTS */}
            <div>
              <h3 style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: colors.navy, margin: '0 0 10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Inputs</h3>

              {/* Number of Venues */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle} htmlFor="rev-venues">Number of Venues</label>
                <input id="rev-venues"
                  type="number"
                  value={numVenues}
                  onChange={(e) => setNumVenues(Math.max(0, parseInt(e.target.value) || 0))}
                  style={inputStyle}
                  min="0"
                />
                <p style={helperStyle}>Venues subscribed to Flock</p>
              </div>

              {/* Subscription Price */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle} htmlFor="rev-subscription">Monthly Subscription</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', fontWeight: '600' }}>$</span>
                  <input id="rev-subscription"
                    type="number"
                    value={subscriptionPrice}
                    onChange={(e) => setSubscriptionPrice(Math.max(0, parseInt(e.target.value) || 0))}
                    style={{ ...inputStyle, paddingLeft: '28px' }}
                    min="0"
                  />
                </div>
                <p style={helperStyle}>Monthly fee per venue</p>
              </div>

              {/* Events Per Venue */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle} htmlFor="rev-events">Events Per Venue/Month</label>
                <input id="rev-events"
                  type="number"
                  value={eventsPerVenue}
                  onChange={(e) => setEventsPerVenue(Math.max(0, parseInt(e.target.value) || 0))}
                  style={inputStyle}
                  min="0"
                />
                <p style={helperStyle}>Avg bookings per venue</p>
              </div>

              {/* Average Spend */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle} htmlFor="rev-spend">Avg Group Spend</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', fontWeight: '600' }}>$</span>
                  <input id="rev-spend"
                    type="number"
                    value={avgSpend}
                    onChange={(e) => setAvgSpend(Math.max(0, parseInt(e.target.value) || 0))}
                    style={{ ...inputStyle, paddingLeft: '28px' }}
                    min="0"
                  />
                </div>
                <p style={helperStyle}>Per event transaction</p>
              </div>

              {/* Take Rate */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle} htmlFor="rev-takerate">Transaction Take Rate</label>
                <div style={{ position: 'relative' }}>
                  <input id="rev-takerate"
                    type="number"
                    value={takeRate}
                    onChange={(e) => setTakeRate(Math.max(0, parseFloat(e.target.value) || 0))}
                    style={{ ...inputStyle, paddingRight: '28px' }}
                    min="0"
                    step="0.1"
                  />
                  <span style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', fontWeight: '600' }}>%</span>
                </div>
                <p style={helperStyle}>% of each transaction</p>
              </div>

              {/* Operating Costs */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle} htmlFor="rev-costs">Monthly Operating Costs</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', fontWeight: '600' }}>$</span>
                  <input id="rev-costs"
                    type="number"
                    value={operatingCosts}
                    onChange={(e) => setOperatingCosts(Math.max(0, parseInt(e.target.value) || 0))}
                    style={{ ...inputStyle, paddingLeft: '28px' }}
                    min="0"
                  />
                </div>
                <p style={helperStyle}>Fixed monthly expenses</p>
              </div>
            </div>

            {/* RIGHT COLUMN - OUTPUTS */}
            <div>
              <h3 style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: colors.navy, margin: '0 0 4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Projections</h3>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '0 0 10px', lineHeight: '1.4' }}>
                Arithmetic on the numbers you typed, not measurements. Flock has no venue partners and has never charged anyone.
              </p>

              {/* Revenue Breakdown */}
              <div style={cardStyle}>
                <h4 style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', margin: '0 0 8px', textTransform: 'uppercase' }}>Projected Revenue</h4>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>Subscriptions</span>
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>{formatCurrency(subscriptionRevenue)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>Transactions</span>
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>{formatCurrency(transactionRevenue)}</span>
                </div>
                <div style={{ borderTop: `1px solid ${colors.creamDark}`, paddingTop: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>Monthly Total</span>
                    <span style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy }}>{formatCurrency(totalMonthlyRevenue)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                    <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>Annualised run rate</span>
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navyMid }}>{formatCurrency(annualRevenue)}</span>
                  </div>
                  {/* Not ARR. ARR may only count the recurring stream; this is
                      the monthly total times twelve, so it folds in transaction
                      revenue and assumes no venue ever cancels. */}
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '4px 0 0', lineHeight: '1.4' }}>
                    This month times twelve. It includes transaction fees, which are not recurring, and assumes no venue cancels.
                  </p>
                </div>
              </div>

              {/* Profitability.
                  The background used to be a hardcoded light mint gradient (or
                  the light red pair) while every piece of text on it uses the
                  accent TOKENS, which flip to a light green and a light red in
                  dark mode. Light on light, about 1.7:1: the profit headline
                  and the margin were unreadable in dark mode, and this is the
                  one card on the screen whose whole job is a single number.
                  --accent-green-bg / --accent-red-bg are the tokens those text
                  colours are already designed against and they flip together,
                  so the pair stays legible in both themes. Flat rather than a
                  gradient, which is also what the design rules ask for. */}
              <div style={{ ...cardStyle, background: isProfitable ? 'var(--accent-green-bg)' : 'var(--accent-red-bg)' }}>
                <h4 style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: isProfitable ? 'var(--accent-green-text)' : 'var(--accent-red-text)', margin: '0 0 8px', textTransform: 'uppercase' }}>
                  {isProfitable ? 'Profitable' : 'Not Profitable'}
                </h4>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 'var(--t-meta)', color: isProfitable ? 'var(--accent-green-text)' : 'var(--accent-red-text)' }}>Monthly Profit</span>
                  <span style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: isProfitable ? 'var(--accent-green-text)' : 'var(--accent-red-text)' }}>
                    {monthlyProfit >= 0 ? '+' : ''}{formatCurrency(monthlyProfit)}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                  <span style={{ fontSize: 'var(--t-meta)', color: isProfitable ? 'var(--accent-green-text)' : 'var(--accent-red-text)' }}>Profit Margin</span>
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: isProfitable ? 'var(--accent-green-text)' : 'var(--accent-red-text)' }}>
                    {marginDefined ? `${profitMargin.toFixed(1)}%` : 'n/a'}
                  </span>
                </div>
              </div>

              {/* Unit Economics */}
              <div style={cardStyle}>
                <h4 style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', margin: '0 0 8px', textTransform: 'uppercase' }}>Unit Economics</h4>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>Revenue/Venue</span>
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>{revenuePerVenueDefined ? `${formatCurrency(revenuePerVenue)}/mo` : 'n/a'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>Break-Even Point</span>
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>{breakEvenReachable ? `${breakEvenVenues} venues` : 'Not reachable'}</span>
                </div>
                <div style={{ padding: '8px', borderRadius: '8px', backgroundColor: isAboveBreakEven ? 'var(--accent-green-bg)' : 'var(--accent-amber-bg)', textAlign: 'center' }}>
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: isAboveBreakEven ? 'var(--accent-green-text)' : 'var(--accent-amber-text)' }}>
                    {!breakEvenReachable
                      ? 'A venue brings in nothing at these inputs, so there is no break-even point.'
                      : isAboveBreakEven
                        ? `${numVenues - breakEvenVenues} venues above break-even`
                        : `Need ${breakEvenVenues - numVenues} more venues`}
                  </span>
                </div>
              </div>

              {/* Business Model Info */}
              <div style={{ ...cardStyle, backgroundColor: 'var(--bg-card-solid)', border: `1px solid ${colors.creamDark}` }}>
                <h4 style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, margin: '0 0 6px' }}>The plan behind these numbers</h4>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
                  Two intended streams: a monthly <strong>venue subscription</strong>, which would recur, and a
                  cut of <strong>group transactions</strong>, which would not. Neither is live. There is no
                  billing code in the app and no venue has ever been charged, so every figure above is what the
                  arithmetic would say if the inputs on the left were real.
                </p>
              </div>
            </div>
          </div>
          </>)}

          {/* The Users, Venues, Cities and Txns tabs were deleted 2026-08-13.
              All four were wall-to-wall invented metrics with no demo label:
              3,200 total users, named fake people, per-venue revenues,
              '4 Active Cities', '$44.8K Total Revenue', a transactions feed.
              Flock has roughly zero users, no venue partners and no revenue,
              which the burn panel three cards down says out loud. Admin-only
              softens the damage but a judge or a reviewer looking over your
              shoulder sees invented traction. The revenue simulator (clearly a
              simulator, driven by inputs) and the burn panel are honest and
              stay. Same call as the fake venue analytics tab on 2026-08-12. */}

          {/* PROJECTIONS TAB */}
          {/* COSTS TAB
              ------------------------------------------------------------
              What Flock costs, in the three kinds of number
              backend/services/costModel.js keeps apart, kept apart here too.

              THE RULE THIS SCREEN EXISTS TO HOLD. A ceiling is not a bill.
              The panels below are ordered by how much they are worth
              trusting, and the two that are not measurements say so in their
              own headings rather than in a footnote: "If every ceiling were
              hit" is a dashed box, and it never sits next to a dollar figure
              that came off a meter.

              Nothing here is computed in the browser. Every number arrives
              from GET /api/admin/costs already priced, because the rate card
              and the arithmetic belong next to the meters that feed them and
              a second copy in JSX is how the old hand-typed expense array
              went five vendors out of date. */}
          {adminTab === 'costs' && (() => {
            const d = costsData;

            // Money, or an honest word when there is no number. A null here
            // means nobody measured, which is not the same as zero, and
            // printing "$0.00" for an absent meter would claim coverage the
            // panel does not have.
            const money = (n, dp = 2) =>
              (Number.isFinite(n) ? `$${n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}` : null);
            const moneyOr = (n, fallback = 'Not measured', dp = 2) => money(n, dp) || fallback;
            const count = (n) => (Number.isFinite(n) ? n.toLocaleString() : null);

            const card = {
              backgroundColor: 'var(--bg-card-solid)',
              borderRadius: '12px',
              padding: '12px',
              boxShadow: 'var(--card-shadow-sm)',
            };
            const h3 = { fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 2px' };
            const sub = { fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.4 };
            const big = { fontSize: 'var(--t-display)', fontWeight: '600', color: colors.navy, margin: '2px 0 0', lineHeight: 1.1 };
            const kicker = { fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.5px' };
            const foot = { fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '8px 0 0', lineHeight: 1.4 };

            const row = (key, left, right, note) => (
              <div key={key} style={{ padding: '6px 0', borderTop: '1px solid var(--border-light)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' }}>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>{left}</span>
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, whiteSpace: 'nowrap' }}>{right}</span>
                </div>
                {note && <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '2px 0 0', lineHeight: 1.35 }}>{note}</p>}
              </div>
            );

            // The mark on a figure nobody has seen on an invoice. It sits
            // beside the LABEL rather than the amount because the amount is
            // the part that has to stay scannable, and a reader who takes the
            // number without the tag has still read a marked row.
            const unverifiedTag = {
              fontSize: 'var(--t-micro)',
              fontWeight: '700',
              color: 'var(--accent-amber-text)',
              backgroundColor: 'var(--accent-amber-bg)',
              borderRadius: '6px',
              padding: '1px 5px',
              marginLeft: '6px',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              whiteSpace: 'nowrap',
            };

            // A FIXED BILL, WITH THE TWO FACTS THE OLD ROW THREW AWAY.
            //
            // It printed a label and a number, showed the note only when the
            // line was unverified, and showed the checked date never. So the
            // panel's own copy said "every line carries the date it was last
            // checked" above eight rows that carried no date at all, Vercel's
            // assumed $0 read exactly like a confirmed free tier, and the note
            // on every verified line was invisible, which is where the reason
            // for a bill lives. All three are on the row now.
            //
            // `verified` means a human has seen this exact number on an
            // invoice or a dashboard, not on a vendor's public pricing page.
            // An unverified line is still counted in the totals, and the panel
            // says so rather than dropping it.
            const fixedRow = (e, period) => (
              <div key={e.id} style={{ padding: '6px 0', borderTop: '1px solid var(--border-light)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' }}>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>
                    {e.label}
                    {!e.verified && <span style={unverifiedTag}>Unverified</span>}
                  </span>
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, whiteSpace: 'nowrap' }}>{moneyOr(e.usd, 'No figure')}{period}</span>
                </div>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '2px 0 0', lineHeight: 1.35 }}>
                  {e.verified
                    ? `Seen on an invoice. Checked ${e.checked}.`
                    : `Not seen on an invoice. This is a published price or an assumption, counted in the totals anyway. Checked ${e.checked}.`}
                  {e.note ? ` ${e.note}` : ''}
                  {e.source ? ` ${e.source}` : ''}
                </p>
              </div>
            );

            if (!d) {
              return (
                <div style={{ ...card, border: `1px dashed ${colors.creamDark}` }}>
                  {!costsLoading && <BirdieStill size={64} style={{ marginBottom: '8px' }} />}
                  <h3 style={h3}>{costsLoading ? 'Reading the meters' : costsError ? 'These numbers did not load' : 'Nothing read yet'}</h3>
                  <p style={sub}>
                    {costsLoading
                      ? 'Fetching the ledgers and the rate card.'
                      : costsError
                        ? 'The cost panel could not be read. Nothing is shown rather than showing the last numbers under a live label.'
                        : 'The cost panel has not been asked for yet.'}
                  </p>
                  {!costsLoading && (
                    <button className="hit44 glass-btn glass-primary" onClick={() => fetchCosts()} style={{ ...styles.gradientButton, padding: '12px', marginTop: '4px' }}>
                      {costsError ? 'Try again' : 'Read the meters'}
                    </button>
                  )}
                </div>
              );
            }

            const reconciledTotal = (d.reconciled?.lines || []).reduce((s2, l) => s2 + (Number.isFinite(l.usdPerMonth) ? l.usdPerMonth : 0), 0);
            const v = d.venueUnitEconomics || {};
            const obs = d.observed || {};
            const worst = d.worstCase || {};
            const fixed = d.fixed || {};
            const dep = d.dependencies || {};

            // THE INVENTORY RESOLVES, IT DOES NOT RESTATE. Every figure on an
            // inventory row is looked up from the block that owns it: usage
            // from the observed lines, flat bills from the fixed lines, the
            // long-form exposure note from the watchlist. So a price exists
            // once in this payload and this list cannot drift from the
            // arithmetic, which is exactly how the hand-typed expense array
            // that used to live in this file went five vendors out of date.
            const allDeps = (dep.groups || []).flatMap((g) => g.entries);
            const obsById = Object.fromEntries((obs.lines || []).map((l) => [l.id, l]));
            const watchById = Object.fromEntries((d.watchlist || []).map((w) => [w.id, w]));

            // THE WATCHLIST'S OWN THREE WORDS, which reached no screen at all.
            // The panel rendered a watchlist entry's note and dropped its
            // severity and its figure, so seven exposures read as ordinary
            // prose on an ordinary row. They are not the same kind of thing:
            // a cap somebody else enforces, a bill that arrives per use with
            // nothing counting the uses, and a line that grows on its own are
            // three different problems with three different responses.
            const SEVERITY_WORDS = {
              watch: 'a cap or a licence somebody else enforces',
              usage: 'billed per use, and nothing here counts the uses',
              growth: 'grows on its own as the app gets used',
            };
            // A watchlist figure of null is the whole point of the list: no
            // number can be defended, so it must read as unknown. Printing $0
            // for it would say the opposite of what is known.
            const watchCost = (w) => (
              Number.isFinite(w.usd)
                ? (w.usd === 0 ? 'nothing on a bill today' : `${money(w.usd)} today`)
                : 'no figure that can be defended, so it reads as unknown rather than as free'
            );
            const fixedById = {};
            for (const e of (fixed.monthly || [])) fixedById[e.id] = { ...e, period: '/mo' };
            for (const e of (fixed.annual || [])) fixedById[e.id] = { ...e, period: '/yr' };
            for (const e of (fixed.oneTime || [])) fixedById[e.id] = { ...e, period: ', once' };

            const depLine = { fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '2px 0 0', lineHeight: 1.4 };
            const groupLabel = { fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', margin: '2px 0 0 2px', textTransform: 'uppercase', letterSpacing: '0.5px' };
            const groupNote = { fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '2px 0 6px 2px', lineHeight: 1.4 };

            // Four different facts share the right-hand slot on an inventory
            // row and they must not be allowed to look alike: a measured
            // figure, a flat bill, a zero that has a reason, and no number at
            // all. The last one is the reason this is a function and not a
            // template: printing $0.00 for something nobody counted would
            // claim coverage this panel does not have.
            const depCost = (e) => {
              if (e.fixedId && fixedById[e.fixedId]) {
                const f = fixedById[e.fixedId];
                return Number.isFinite(f.usd) ? `${money(f.usd, 0)}${f.period}` : 'No figure';
              }
              if (e.unknownCost) return 'Unknown';
              const o = e.observedLineId ? obsById[e.observedLineId] : null;
              if (o && Number.isFinite(o.usd)) {
                if (o.usd === 0) return '$0';
                return `${money(o.usd, 4)}${Number.isFinite(o.usdHigh) && o.usdHigh > o.usd ? ` to ${money(o.usdHigh, 4)}` : ''}`;
              }
              if (o) return o.unpriceable ? 'No rate on file' : 'Not measured';
              if (e.group === 'free') return '$0';
              return 'Not measured';
            };

            const depUsage = (e) => {
              const o = e.observedLineId ? obsById[e.observedLineId] : null;
              if (!o) return e.usageNote || 'Not measured. Nothing in this repo counts it.';
              if (o.count === null) return `Not measured. The meter did not report.`;
              return `${count(o.count)} ${o.unit}, ${o.window}.`;
            };

            const depConfigured = (e) => {
              if (e.configured === true) return `Configured, ${e.configuredVia} is set.`;
              if (e.configured === false) {
                const names = (e.configuredEnv || []).join(' or ');
                return names ? `Not configured. ${names} is unset on the server.` : 'Not configured.';
              }
              return e.configuredNote || 'The server cannot see whether this is configured.';
            };

            const depBlock = (e, i) => {
              const w = e.watchlistId ? watchById[e.watchlistId] : null;
              return (
                <div key={e.id} style={{ padding: i === 0 ? '0 0 9px' : '9px 0', borderTop: i === 0 ? 'none' : '1px solid var(--border-light)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' }}>
                    <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>{e.label}</span>
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, whiteSpace: 'nowrap' }}>{depCost(e)}</span>
                  </div>
                  <p style={depLine}>{e.what} Lives in {e.where}.</p>
                  <p style={depLine}>
                    Price: {e.unitPrice || (e.unpriceable ? 'no published rate on file for this model id' : 'no published unit price')}.
                    {e.freeTier ? ` Free tier: ${e.freeTier}.` : ''}
                  </p>
                  <p style={depLine}>Usage: {depUsage(e)} {depConfigured(e)}</p>
                  {e.costsNothingBecause && <p style={depLine}>{e.costsNothingBecause}</p>}
                  {e.unknownAction && <p style={depLine}>{e.unknownAction}</p>}
                  {e.note && <p style={depLine}>{e.note}</p>}
                  {w && (
                    <p style={depLine}>
                      On the watchlist, {SEVERITY_WORDS[w.severity] || w.severity}: {watchCost(w)}. {w.note}
                    </p>
                  )}
                  {e.source && <p style={depLine}>{e.source}, checked {e.checked}.</p>}
                </div>
              );
            };

            // Two totals a person actually wants: what leaves the account every
            // month regardless of use, and what the usage on top of it is
            // running at. They are added only where both are real.
            const allInMonthly = Number.isFinite(fixed.effectiveMonthlyUsd) ? fixed.effectiveMonthlyUsd + reconciledTotal : null;

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

                {/* 1. THE ONE NUMBER THAT IS A BILL */}
                <div style={card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
                    <div>
                      <h3 style={h3}>What this actually costs</h3>
                      <p style={sub}>Fixed bills plus the metered spend a human has reconciled against a vendor invoice.</p>
                    </div>
                    <button className="hit44" disabled={costsLoading} onClick={() => fetchCosts()}
                      style={{ border: 'none', background: 'transparent', cursor: costsLoading ? 'default' : 'pointer', padding: '4px', flexShrink: 0 }}>
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-tertiary)' }}>{costsLoading ? 'Reading' : 'Refresh'}</span>
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                    <div>
                      <p style={kicker}>All in, monthly</p>
                      <p style={big}>{moneyOr(allInMonthly, 'Not measured', 0)}</p>
                      <p style={{ ...sub, margin: '3px 0 0' }}>
                        {moneyOr(fixed.effectiveMonthlyUsd, 'no fixed total', 0)} of fixed bills, plus {moneyOr(reconciledTotal, 'nothing', 0)} of metered vendor spend.
                      </p>
                    </div>
                    <div>
                      <p style={kicker}>Reconciled</p>
                      <p style={big}>{moneyOr(reconciledTotal, 'None on file', 0)}</p>
                      <p style={{ ...sub, margin: '3px 0 0' }}>
                        Read off vendor billing pages by hand{d.reconciled?.asOf ? ` on ${d.reconciled.asOf}` : ''}. Nothing in the app can verify it, so it is only as current as that date.
                      </p>
                    </div>
                  </div>
                  {(d.reconciled?.lines || []).map((l) => row(l.id, l.label, `${moneyOr(l.usdPerMonth)}/mo`, l.note))}
                  {(fixed.unverifiedLines || []).length > 0 && (
                    <p style={foot}>
                      {moneyOr(fixed.unverifiedMonthlyUsd, '$0', 2)} a month and {moneyOr(fixed.unverifiedAnnualUsd, '$0', 2)} a year of that total sits on {fixed.unverifiedLines.length} {fixed.unverifiedLines.length === 1 ? 'line nobody' : 'lines nobody'} has seen on an invoice. They are counted rather than dropped, and every one is marked unverified where it is listed below.
                    </p>
                  )}
                  {fixed.oldestChecked && (
                    <p style={foot}>
                      The hand-maintained half of this was last checked between {fixed.oldestChecked} and {fixed.newestChecked}. A stale date means unverified rather than wrong.
                    </p>
                  )}
                </div>

                {/* 1b. THE INVENTORY.
                    ------------------------------------------------------------
                    Jayden asked for every API on this screen, including the
                    ones that cost nothing, and that turned out to be a
                    different question from the one the panel answered. The
                    blocks here are ordered by how far a number can be trusted,
                    so a vendor that charges nothing appeared in whichever of
                    them happened to mention it, and six appeared in none at
                    all: PostHog, Sentry, RevenueCat, push, Google Sign-In and
                    Sign in with Apple were on the rate card and on no screen.

                    A dependency that costs $0 is still a dependency. It is
                    still an account somebody can lock, still a terms of
                    service, still a thing that breaks. So each one gets a row
                    saying so, and the row says WHICH kind of $0 it is: inside
                    a free tier, unused, or covered by a flat fee already
                    counted somewhere else. Those are three different facts and
                    a bare zero hides which one applies.

                    Grouped rather than listed, because thirty-four identical
                    rows is unnavigable (SLOP-AUDIT section S). Group labels sit
                    outside their container for the same reason. */}
                {dep.groups && (
                  <div style={card}>
                    <h3 style={h3}>Every API and service</h3>
                    <p style={sub}>
                      Everything Flock reaches outside itself, priced where there is a price and named where there is not. The rows resolve against the meters, the fixed bills and the watchlist rather than holding their own copy of a number.
                    </p>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                      <div>
                        <p style={kicker}>Dependencies</p>
                        <p style={big}>{dep.total}</p>
                        <p style={{ ...sub, margin: '3px 0 0' }}>
                          {dep.groups.map((g) => `${g.entries.length} ${g.short || g.id}`).join(', ')}.
                        </p>
                      </div>
                      <div>
                        <p style={kicker}>Without a meter</p>
                        <p style={big}>{(dep.unmeteredIds || []).length}<span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-tertiary)' }}> of {dep.total}</span></p>
                        <p style={{ ...sub, margin: '3px 0 0' }}>
                          Nothing here counts their usage, so those rows read as not measured. A zero meaning no meter and a zero meaning no spend are different facts.
                        </p>
                      </div>
                    </div>
                    {(dep.unknownCostIds || []).length > 0 && (
                      <p style={foot}>
                        {dep.unknownCostIds.length} of them have no defensible figure at all and read as unknown rather than as free: {dep.unknownCostIds.map((id) => (allDeps.find((e) => e.id === id) || {}).label || id).join(', ')}. Each one says where to go and find the number.
                      </p>
                    )}
                    {(d.watchlist || []).length > 0 && (
                      <p style={foot}>
                        {d.watchlist.length} of them are on the watchlist: not on a bill today, and each one could be. The exposure and how it would arrive are on that vendor's own row rather than in a second list of the same vendors.
                      </p>
                    )}
                  </div>
                )}

                {(dep.groups || []).map((g) => (
                  <div key={g.id}>
                    <p style={groupLabel}>{g.label}</p>
                    <p style={groupNote}>{g.note}</p>
                    <div style={card}>
                      {g.entries.map(depBlock)}
                    </div>
                  </div>
                ))}

                {/* 2. FIXED.
                    ------------------------------------------------------------
                    THE WHOLE STANDING BILL, in the three periods it actually
                    arrives in. Monthly and annual used to be one undifferentiated
                    stack of rows under a single spread figure, so the two
                    questions a person asks here, what leaves the account this
                    month and what is committed for the year, could only be
                    answered by adding rows up by hand.

                    Both totals are shown, and the annual one is shown twice on
                    purpose: as the yearly figure, which is what the invoice
                    says, and as its monthly twelfth, which is the only form
                    that can be added to the monthly figure. The sum of those
                    two is the effective monthly burn on the row below. */}
                <div style={card}>
                  <h3 style={h3}>Fixed, whether anyone uses it or not</h3>
                  <p style={sub}>
                    Maintained by hand in backend/services/costModel.js. Every line below carries the date a human last checked it and whether the figure came off an invoice or a pricing page. Update the file when a bill changes.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '4px' }}>
                    <div>
                      <p style={kicker}>Recurring monthly</p>
                      <p style={big}>{moneyOr(fixed.monthlyUsd, 'None on file', 0)}</p>
                      <p style={{ ...sub, margin: '3px 0 0' }}>
                        {(fixed.monthly || []).length} {(fixed.monthly || []).length === 1 ? 'bill' : 'bills'} that arrive every month.
                      </p>
                    </div>
                    <div>
                      <p style={kicker}>Committed annually</p>
                      <p style={big}>{moneyOr(fixed.annualUsd, 'None on file', 0)}</p>
                      <p style={{ ...sub, margin: '3px 0 0' }}>
                        {(fixed.annual || []).length} {(fixed.annual || []).length === 1 ? 'bill' : 'bills'} that arrive once a year, which is {moneyOr(fixed.annualPerMonthUsd, 'nothing')} a month once spread.
                      </p>
                    </div>
                  </div>
                  {(fixed.monthly || []).map((e) => fixedRow(e, '/mo'))}
                  {(fixed.annual || []).map((e) => fixedRow(e, '/yr'))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', marginTop: '4px', borderTop: '1px solid var(--border-default)' }}>
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)' }}>Monthly bills plus the annual ones spread over twelve months</span>
                    <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>{moneyOr(fixed.effectiveMonthlyUsd)}<span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-tertiary)' }}>/mo</span></span>
                  </div>
                  {/* One-time spend sits below that line and never inside it.
                      Money already spent and money that arrives again next
                      month are different facts, and the only way to keep them
                      apart on one panel is to keep the one-time figure out of
                      every monthly total on it. */}
                  {(fixed.oneTime || []).map((e) => fixedRow(e, ', once'))}
                  {Number.isFinite(fixed.oneTimeUsd) && fixed.oneTimeUsd > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', marginTop: '4px', borderTop: '1px solid var(--border-default)' }}>
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)' }}>Spent once, and in no monthly figure above</span>
                      <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>{moneyOr(fixed.oneTimeUsd, 'None on file', 0)}</span>
                    </div>
                  )}
                  {(fixed.unverifiedLines || []).length > 0 && (
                    <p style={foot}>
                      {fixed.unverifiedLines.length} {fixed.unverifiedLines.length === 1 ? 'line is' : 'lines are'} a published vendor price or an assumption rather than an invoice you have seen: {fixed.unverifiedLines.join(', ')}. They are counted in every total above, marked unverified on their own row, and worth {moneyOr(fixed.unverifiedMonthlyUsd, '$0', 2)} a month and {moneyOr(fixed.unverifiedAnnualUsd, '$0', 2)} a year between them.
                    </p>
                  )}
                </div>

                {/* 3. OBSERVED */}
                <div style={card}>
                  <h3 style={h3}>What the meters counted</h3>
                  <p style={sub}>
                    Real usage, priced at the rate card. This is an estimate of a bill and not a bill. Lines marked as this process only live in one container's memory, so they read zero after every deploy and do not add up across a month.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '4px' }}>
                    <div>
                      <p style={kicker}>Today so far</p>
                      <p style={big}>
                        {moneyOr(obs.todayUsd, 'Not measured')}
                        {Number.isFinite(obs.todayUsdHigh) && obs.todayUsdHigh > obs.todayUsd && (
                          <span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-tertiary)' }}> to {money(obs.todayUsdHigh)}</span>
                        )}
                      </p>
                      <p style={{ ...sub, margin: '3px 0 0' }}>A band where a meter counted calls without recording which SKU they were.</p>
                    </div>
                    <div>
                      <p style={kicker}>Coverage</p>
                      <p style={big}>{(obs.lines || []).length - (obs.unmeasuredLines || []).length}<span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-tertiary)' }}> of {(obs.lines || []).length}</span></p>
                      <p style={{ ...sub, margin: '3px 0 0' }}>
                        {(obs.unmeasuredLines || []).length === 0 ? 'Every meter reported.' : `Not reporting: ${obs.unmeasuredLines.join(', ')}.`}
                      </p>
                    </div>
                  </div>
                  {(obs.lines || []).map((l) => row(
                    l.id,
                    l.label,
                    l.usd === null
                      ? (l.unpriceable ? 'No rate on file' : 'Not measured')
                      : `${money(l.usd, 4)}${Number.isFinite(l.usdHigh) && l.usdHigh > l.usd ? ` to ${money(l.usdHigh, 4)}` : ''}`,
                    `${count(l.count) === null ? 'Nothing reported' : `${count(l.count)} ${l.unit}`}, ${l.window}.${l.freeTier ? ' Inside a free tier.' : ''}`
                  ))}
                  {(obs.unpriceableLines || []).length > 0 && (
                    <p style={foot}>
                      A model id with no published rate on file reads as unpriced rather than free. BIRDIE_MODEL and ADVISOR_MODEL are switchable from Railway with no deploy, so a swap changes what a token costs without changing any ceiling.
                    </p>
                  )}
                </div>

                {/* 3b. THE PHOTO BUDGET.
                    Its own panel rather than another row in the observed list,
                    for one reason: it is the only ceiling on this screen that a
                    person is expected to RAISE. Every other number here is a
                    thing to watch. This one is a decision, and if it is ever
                    reached the right response is usually to buy more photos
                    rather than to show fewer. It is also the line that has
                    historically taken almost the whole Google bill, and until
                    2026-08-20 its meter lived in memory, so it read zero after
                    every deploy and understated the spend by the most on
                    exactly the days there was the most of it. */}
                {d.photoBudget && (() => {
                  const pb = d.photoBudget;
                  const lim = pb.limits || {};
                  const monthPct = lim.fetchesPerMonth
                    ? Math.min(100, Math.round((pb.monthUsed / lim.fetchesPerMonth) * 100))
                    : null;
                  const tight = monthPct !== null && monthPct >= 80;
                  return (
                    <div key="photo-budget" style={{ ...card, border: tight ? `1px solid ${colors.amber}` : undefined }}>
                      <h3 style={h3}>Venue photos</h3>
                      <p style={sub}>
                        Google charges for each photo Flock buys, and Flock keeps every one it buys for thirty days in Postgres, so this counts venues photographed rather than cards viewed. A photo already bought costs nothing to show again, however many people look at it.
                      </p>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div>
                          <p style={kicker}>This month</p>
                          <p style={big}>
                            {count(pb.monthUsed)}
                            <span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-tertiary)' }}> of {count(lim.fetchesPerMonth)}</span>
                          </p>
                          <p style={{ ...sub, margin: '3px 0 0' }}>
                            {moneyOr(pb.monthUsd, 'nothing yet')} so far. The first {count(lim.freePerMonth)} photos a month are free.
                          </p>
                        </div>
                        <div>
                          <p style={kicker}>Budget</p>
                          <p style={big}>{moneyOr(lim.budgetUsdPerYear, 'Not set', 0)}<span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-tertiary)' }}>/yr</span></p>
                          <p style={{ ...sub, margin: '3px 0 0' }}>
                            Set in backend/services/photoStore.js, or by PHOTO_BUDGET_USD_PER_YEAR on Railway. Every other photo limit is derived from it.
                          </p>
                        </div>
                      </div>
                      {row('photo-day', 'Bought today', `${count(pb.dayUsed)} of ${count(lim.burstPerDay)}`,
                        'A daily brake at three times the even pace, so one bad day cannot spend the month.')}
                      {row('photo-month-left', 'Left this month', count(pb.monthRemaining),
                        tight
                          ? 'Close to the ceiling. Photos already bought keep showing. A venue nobody has looked at this month would have no picture until the 1st, so this is the moment to raise the budget.'
                          : 'Reaching this stops new venues being bought. It never blanks a photo that is already cached.')}
                    </div>
                  );
                })()}

                {/* 3c. THE QUOTA CAPS.
                    ------------------------------------------------------------
                    Every other ceiling on this screen is one this repo wrote for
                    itself and can raise with a deploy. These four are Google's.
                    They were set by hand in the Cloud console on 2026-08-20,
                    they refuse the call rather than slowing it down, and only a
                    person with console access can move one. That makes hitting
                    a quota a real failure mode with a shape a user can see: a
                    venue card with no picture, a search that finds nothing, an
                    owner dashboard with no competitors. */}
                {d.googleQuotas && (() => {
                  const q = d.googleQuotas;
                  const pb = d.photoBudget;
                  return (
                    <div key="google-quotas" style={card}>
                      <h3 style={h3}>Google quota caps</h3>
                      <p style={sub}>
                        Set by hand in the Cloud console on {q.checked}, on project {q.project}. A quota refuses the call. It does not slow it down and it does not queue it.
                      </p>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div>
                          <p style={kicker}>Caps the month at</p>
                          <p style={big}>{moneyOr(q.perMonthUsdAfterFree, 'Not priced', 0)}</p>
                          <p style={{ ...sub, margin: '3px 0 0' }}>
                            {moneyOr(q.perMonthUsdGross, 'nothing', 0)} before each SKU keeps its own free allowance, which is named on its row below. Every quota spent every day, which nothing has ever done.
                          </p>
                        </div>
                        <div>
                          <p style={kicker}>Budget alert</p>
                          <p style={big}>{moneyOr(q.budget?.usdPerMonth, 'None', 0)}<span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-tertiary)' }}>/mo</span></p>
                          <p style={{ ...sub, margin: '3px 0 0' }}>
                            Named {q.budget?.name}. It emails at {(q.budget?.alertsAtPct || []).join(', ')} percent. {q.budget?.note}
                          </p>
                        </div>
                      </div>
                      {(q.lines || []).map((l) => {
                        const isPhotos = l.id === 'photos';
                        const observed = isPhotos && pb && Number.isFinite(pb.dayUsed)
                          ? `${count(pb.dayUsed)} bought today.`
                          : 'Per SKU usage is not measured, because the shared Places ledger counts calls without recording which SKU each one was.';
                        const binding = l.bindingDaily === 'google' && Number.isFinite(l.repoDailyBrake)
                          ? ` Flock's own daily brake is ${count(l.repoDailyBrake)}, so Google refuses first.`
                          : l.bindingDaily === 'repo' && Number.isFinite(l.repoDailyBrake)
                            ? ` Flock's own daily brake is ${count(l.repoDailyBrake)}, so it refuses before Google does.`
                            : '';
                        return row(
                          `quota-${l.id}`,
                          l.label,
                          `${count(l.perDay)} a day`,
                          `${moneyOr(l.perMonthUsdAfterFree, 'no figure', 2)} a month at this cap, after the first ${count(l.freePerMonth)} free. ${observed}${binding}`
                        );
                      })}
                      {q.agreesWithBudget === false && (
                        <p style={foot}>
                          The four quotas no longer price at the budget beside them. One of them, or one of the rates, has been edited since they were set together. Redo the arithmetic before trusting either number.
                        </p>
                      )}
                    </div>
                  );
                })()}

                {/* 3d. CAN IMAGES BE SCREENED AT ALL.
                    ------------------------------------------------------------
                    This is the one row on the screen where $0 is ambiguous in a
                    way that matters. Every upload is screened by Cloud Vision
                    before it is stored, and moderateImage fails CLOSED: an image
                    that cannot be screened is refused. So a Vision bill of zero
                    means either that nobody uploaded anything, or that nothing
                    works and every upload in the app is being rejected. A cost
                    panel that cannot tell those apart is reporting the least
                    useful true thing available, so the server probes the
                    provider (with zero images, so it buys nothing) and reports
                    what it found rather than what it assumed. */}
                {d.visionProvider && (() => {
                  const vp = d.visionProvider;
                  const visionDep = allDeps.find((e) => e.statusKey === 'vision');
                  const headline = vp.configured === false
                    ? 'No key set'
                    : vp.reachable === true
                      ? 'Answering'
                      : vp.reachable === false
                        ? 'Refusing'
                        : 'Unknown';
                  const broken = vp.configured === false || vp.reachable === false;
                  const refusing = vp.required && broken;
                  // Four states, not two. "Screening is required and the
                  // provider did not answer the probe" is not the same as
                  // "the provider said no", and neither is the same as
                  // screening being switched off, which is the one state that
                  // puts unscreened photos in front of a thirteen year old.
                  const uploads = !vp.required
                    ? 'Unscreened'
                    : broken
                      ? 'Refused'
                      : vp.reachable === true
                        ? 'Screened'
                        : 'Unknown';
                  return (
                    <div key="vision-provider" style={{ ...card, border: refusing ? `1px solid ${colors.amber}` : undefined }}>
                      <h3 style={h3}>Image screening</h3>
                      <p style={sub}>
                        Every photo is screened by Cloud Vision before it is stored, and an image that cannot be screened is refused rather than kept. That makes a Vision bill of zero two different things, so this is measured rather than assumed.
                      </p>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div>
                          <p style={kicker}>Provider</p>
                          <p style={big}>{headline}</p>
                          <p style={{ ...sub, margin: '3px 0 0' }}>
                            {vp.configured === false
                              ? 'No VISION_API_KEY on this server.'
                              : `Asked Google directly, with zero images, so the check bought nothing. Key from ${vp.keyVar}.`}
                            {vp.detail ? ` ${vp.detail}` : ''}
                          </p>
                        </div>
                        <div>
                          <p style={kicker}>Uploads</p>
                          <p style={big}>{uploads}</p>
                          <p style={{ ...sub, margin: '3px 0 0' }}>
                            {uploads === 'Unscreened'
                              ? 'Screening is not required on this server, so an image that cannot be screened is stored anyway. That is the dev default and it must never be the production one.'
                              : uploads === 'Refused'
                                ? 'Screening is required and the provider is not usable, so every image upload in the app is being rejected right now.'
                                : uploads === 'Screened'
                                  ? 'Screening is required and the provider answers, which is the correct production setting.'
                                  : 'Screening is required and the probe could not reach Google, which says nothing either way. Check again before concluding anything from it.'}
                          </p>
                        </div>
                      </div>
                      {row('vision-last', 'Last real screen',
                        vp.lastOutcome ? (vp.lastOutcome.ok ? 'Answered' : 'Failed') : 'None yet',
                        vp.lastOutcome
                          ? `${new Date(vp.lastOutcome.at).toLocaleString()}.${vp.lastOutcome.detail ? ` ${vp.lastOutcome.detail}` : ''} Counted in this container's memory, so it resets on every deploy.`
                          : 'No image has been screened since this container started. That is normal on a quiet day and says nothing either way.')}
                      {visionDep && visionDep.finding && <p style={foot}>{visionDep.finding}</p>}
                    </div>
                  );
                })()}

                {/* PUSH DELIVERY. The one subsystem whose failure is completely
                    silent: an invite that never left the building and one that
                    landed on a lock screen look identical from every other
                    screen in this app, and the user-visible symptom of a dead
                    push system ("nobody answered") is the same as the product
                    simply being quiet. Migration 050 built push_sends to answer
                    it and nothing read the table, which is the same amount of
                    evidence as not having built it. This is the reader.

                    Suppressions are listed rather than summed into one number
                    because they are not one thing. "Everyone was already
                    looking" is the system working; "nobody has a device
                    registered" is the whole feature being off for that person;
                    "held until morning" is a notification that still exists.
                    A single Suppressed count would hide all three behind each
                    other. */}
                {d.pushDelivery && (() => {
                  const p = d.pushDelivery;
                  const t = p.totals || {};
                  const byOutcome = {};
                  for (const r of (p.byTypeAndOutcome || [])) {
                    byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + r.pushes;
                  }
                  // Every outcome services/pushHelper.js can write, in the
                  // order a person reads them: what landed, then what did not
                  // and why. A key that arrives without an entry here still
                  // renders, under its own raw name, because an unexplained
                  // count is better than a count silently dropped.
                  const WORDS = {
                    delivered: 'Reached at least one device',
                    failed: 'The provider refused or timed out',
                    'no-device': 'Nobody had a device registered',
                    online: 'Every device was already looking',
                    debounced: 'Same conversation, inside 30 seconds',
                    'not-visible': 'Left the plan, blocked, or banned',
                    'opted-out': 'Crowd alerts switched off',
                    'quiet-held': 'Held for the morning',
                    'quiet-dropped': 'Dropped, because a crowd alert at 3am is about last night',
                    expired: 'Given up on before it could be sent',
                  };
                  const ORDER = ['delivered', 'failed', 'quiet-held', 'expired', 'no-device', 'online', 'debounced', 'not-visible', 'opted-out', 'quiet-dropped'];
                  const seen = Object.keys(byOutcome);
                  const ordered = [
                    ...ORDER.filter((k) => seen.includes(k)),
                    ...seen.filter((k) => !ORDER.includes(k)).sort(),
                  ];
                  const attempts = Number.isFinite(t.attempts) ? t.attempts : null;
                  // A number the sentence below interpolates, so it has to be a
                  // number. count() answers null for anything unmeasured, and
                  // "null devices reached" reads as a bug rather than as an
                  // absence.
                  const reached = Number.isFinite(t.devicesReached) ? t.devicesReached : 0;
                  return (
                    <div key="push-delivery" style={{ ...card, border: p.configured === false ? `1px solid ${colors.amber}` : undefined }}>
                      <h3 style={h3}>Push delivery</h3>
                      <p style={sub}>
                        Every notification this app sends passes through one place and writes a row there, so this is the whole record for the last {p.days} days. It holds no titles, no message bodies and no device tokens. Rows are kept for 30 days and then deleted.
                      </p>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div>
                          <p style={kicker}>Landed</p>
                          <p style={big}>{count(t.delivered) || 'Not measured'}</p>
                          <p style={{ ...sub, margin: '3px 0 0' }}>
                            {attempts === null
                              ? 'The ledger could not be read, which says nothing either way.'
                              : attempts === 0
                                ? 'Nothing has been attempted in this window at all. On a product with no users that is the expected reading, and it is not evidence that delivery works.'
                                : `${count(reached)} device${reached === 1 ? '' : 's'} reached across ${count(attempts)} attempt${attempts === 1 ? '' : 's'}.`}
                          </p>
                        </div>
                        <div>
                          <p style={kicker}>Provider</p>
                          <p style={big}>{p.configured === false ? 'Switched off' : 'Configured'}</p>
                          <p style={{ ...sub, margin: '3px 0 0' }}>
                            {p.configured === false
                              ? 'FIREBASE_SERVICE_ACCOUNT is not set on this server, so every notification in the app is a no-op and no row below can be anything but a skip.'
                              : 'FIREBASE_SERVICE_ACCOUNT is set, so a count of zero below means nothing was sent rather than that sending is off.'}
                          </p>
                        </div>
                      </div>
                      {ordered.length === 0
                        ? <p style={foot}>No push has been attempted in the last {p.days} days.</p>
                        : ordered.map((k) => row(`push-${k}`, WORDS[k] || k, count(byOutcome[k])))}
                    </div>
                  );
                })()}

                {/* THE MODEL VERSUS THE FALLBACK.
                    routes/admin.js has served this block since 2026-08-26 and
                    nothing rendered it, which is the same half-finished shape
                    the push ledger above was in: the number that answers "is
                    the trained model actually doing the work" was computed,
                    carried across the wire, pinned by two server tests, and
                    shown to nobody.
                    It answers the one question the ONNX model exists to be
                    judged on. services/crowdEngine.js is the rule-based
                    fallback and it is used whenever the model files are
                    missing, the ship gate fails, features mismatch, a venue has
                    no baseline, or inference throws. Every one of those is
                    silent. A model that loaded and then served nothing looks
                    identical, from outside, to a model that is working. */}
                {d.predictionCoverage && (() => {
                  const p = d.predictionCoverage;
                  const total = Number.isFinite(p.total) ? p.total : null;
                  const ml = Number.isFinite(p.ml) ? p.ml : 0;
                  const share = Number.isFinite(p.modelShare) ? Math.round(p.modelShare * 100) : null;
                  return (
                    <div key="prediction-coverage" style={{ ...card, border: p.modelLoaded === false ? `1px solid ${colors.amber}` : undefined }}>
                      <h3 style={h3}>Crowd model versus the fallback</h3>
                      <p style={sub}>
                        Which engine actually answered. This counter lives in the server's memory, so it starts again from nothing on every deploy and reads the time since the last restart rather than all time. A small number here is not evidence the model is unused.
                      </p>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div>
                          <p style={kicker}>Answered by the model</p>
                          <p style={big}>{share === null ? 'Not measured' : `${share}%`}</p>
                          <p style={{ ...sub, margin: '3px 0 0' }}>
                            {total === null
                              ? 'The meter could not be read, which says nothing either way.'
                              : total === 0
                                ? 'Nothing has asked for a forecast since the last deploy, so neither engine has run.'
                                : `${count(ml)} of ${count(total)} forecast${total === 1 ? '' : 's'}. The rest came from the rule engine.`}
                          </p>
                        </div>
                        <div>
                          <p style={kicker}>Model file</p>
                          <p style={big}>{p.modelLoaded ? (p.modelVersion || 'Loaded') : 'Not loaded'}</p>
                          <p style={{ ...sub, margin: '3px 0 0' }}>
                            {p.modelLoaded
                              ? 'The ONNX model is in memory and available to serve.'
                              : 'Every forecast is coming from the rule engine. That is the designed fallback and the product still works, but the trained model is earning nothing.'}
                          </p>
                        </div>
                      </div>
                      {p.since && (
                        <p style={{ ...sub, margin: '10px 0 0' }}>Counting since {new Date(p.since).toLocaleString()}.</p>
                      )}
                    </div>
                  );
                })()}

                {/* 4. ONE VENUE */}
                <div style={card}>
                  <h3 style={h3}>One venue at {moneyOr(v.priceUsd, 'the list price', 0)} a month</h3>
                  <p style={sub}>
                    Gemini is the only per-venue cost that scales with use. The ceiling below is that venue's own daily token cap, spent in full every day of the month, which is the most one venue can possibly cost.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                    <div>
                      <p style={kicker}>Costs at most</p>
                      <p style={big}>{moneyOr(v.ceilingMonthlyUsdHigh, 'Not priced')}</p>
                      <p style={{ ...sub, margin: '3px 0 0' }}>
                        {Number.isFinite(v.ceilingMonthlyUsdLow) ? `From ${money(v.ceilingMonthlyUsdLow)} if every token were input.` : 'No rate on file for this model.'}
                      </p>
                    </div>
                    <div>
                      <p style={kicker}>Gross margin</p>
                      <p style={big}>{Number.isFinite(v.ceilingMarginPct) ? `${v.ceilingMarginPct}%` : 'Not priced'}</p>
                      <p style={{ ...sub, margin: '3px 0 0' }}>Against the dear end of the band, before any payment processing.</p>
                    </div>
                  </div>
                  {Number.isFinite(v.laterCeilingMonthlyUsd) && v.laterFrom && row(
                    'later',
                    `Same ceiling from ${v.laterFrom}`,
                    `${moneyOr(v.laterCeilingMonthlyUsd)}/mo`,
                    `${v.model} is on promotional pricing that doubles on that date. Margin becomes ${v.laterCeilingMarginPct}%.`
                  )}
                  {row(
                    'observed-venue',
                    'Busiest venue this month, actual',
                    v.observedMonthlyUsd === null ? 'Not measured' : money(v.observedMonthlyUsd, 4),
                    v.observedTokensMonth === null
                      ? 'No venue has spent a Roost token this month, so there is nothing to price. This stays empty until one does.'
                      : `${count(v.observedTokensMonth)} tokens. Margin ${v.observedMarginPct}%.`
                  )}
                  {row(
                    'paying',
                    'Venues paying today',
                    Number.isFinite(d.venues?.paying) ? String(d.venues.paying) : 'Not measured',
                    'Nobody has ever been charged. Venue billing is unbuilt and its flag is unset.'
                  )}
                </div>

                {/* 5. CEILINGS. Dashed, and it never touches an observed figure. */}
                <div style={{ ...card, boxShadow: 'none', border: `1px dashed ${colors.creamDark}` }}>
                  <h3 style={h3}>If every ceiling were hit, every day</h3>
                  <p style={sub}>
                    Not spend. Not a forecast. This is what the limits written into the code permit before something refuses, and nothing has ever come close to one of them. It is here so the worst case is a number rather than a worry.
                  </p>
                  <div>
                    <p style={kicker}>Would cost, monthly</p>
                    <p style={big}>
                      {moneyOr(worst.perMonthUsd, 'Not priced', 0)}
                      {Number.isFinite(worst.perMonthUsdHigh) && worst.perMonthUsdHigh > worst.perMonthUsd && (
                        <span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-tertiary)' }}> to {money(worst.perMonthUsdHigh, 0)}</span>
                      )}
                    </p>
                  </div>
                  {(worst.lines || []).map((l) => row(
                    l.id,
                    l.label,
                    l.perMonthUsd === null
                      ? 'Not priced'
                      : `${money(l.perMonthUsd, 0)}${Number.isFinite(l.perMonthUsdHigh) && l.perMonthUsdHigh > l.perMonthUsd ? ` to ${money(l.perMonthUsdHigh, 0)}` : ''}/mo`,
                    `${count(l.ceiling) === null ? 'No ceiling on file' : `${count(l.ceiling)} ${l.ceilingUnit}`}.${l.note ? ` ${l.note}` : ''}`
                  ))}
                </div>

                {/* 6. The watchlist used to be its own panel here, listing
                    eight vendors that all appear on the inventory above. Two
                    lists of the same vendors on one screen is worse than one:
                    the reader has to work out whether the second list is a
                    subset, a contradiction or an update. The long-form note on
                    each watchlist entry is now rendered inside that vendor's
                    inventory row, so the prose still has exactly one home and
                    the screen has one list. costModel.WATCHLIST is unchanged
                    and is still what the row resolves against. */}

                {/* 7. PROVENANCE */}
                <div style={{ ...card, boxShadow: 'none', backgroundColor: 'transparent', padding: '0 2px' }}>
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: 0, lineHeight: 1.5 }}>
                    {Object.keys(d.rates?.checked || {}).length} groups on the rate card, each one named on its own row above with its own source and date. The oldest was checked {Object.values(d.rates?.checked || {}).sort()[0] || 'never'}.
                    {' '}Vendors change published prices without telling anyone, so a stale date means unverified, not wrong.
                    {d.generatedAt ? ` Read at ${new Date(d.generatedAt).toLocaleString()}.` : ''}
                  </p>
                </div>
              </div>
            );
          })()}

          {adminTab === 'projections' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Deleted 2026-08-13, all three fabricated:
                    • "12-Month Projection" — $18K/$28K/$38K/$46K quarters and
                      Y1 $130K / Y2 $435K / Y3 $1.14M, with a bar chart whose
                      heights were literally `40 + i * 20` pixels.
                    • "EOY Targets" — a current column reading 8,500 users,
                      167 venue partners, 4 cities, $10.8K monthly revenue,
                      and progress bars derived from those.
                    • "Key Insights" — Austin saturation, 24% Pro conversion,
                      acquisition cost down 15% MoM.
                  Flock has roughly zero users, no venue partners, no cities,
                  no revenue and a paywall that has never been switched on, so
                  every one of those was invented. They sat directly above the
                  real hand-maintained expense figures and borrowed credibility
                  from them. Inventing metrics is banned outright (SLOP-AUDIT
                  H13), and the fake venue analytics tab went the same way on
                  2026-08-12. What replaces them is burn and break-even, which
                  are computed from the expense arrays below. */}

              {/* Growth Levers */}
              <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Growth Levers</h3>
                {[
                  { lever: 'Venue Acquisition', impact: 'High', effort: 'Medium', icon: Icons.building },
                  { lever: 'User Referrals', impact: 'High', effort: 'Low', icon: Icons.users },
                  { lever: 'City Expansion', impact: 'Very High', effort: 'High', icon: Icons.globe },
                  { lever: 'Premium Upsells', impact: 'Medium', effort: 'Low', icon: Icons.sparkles },
                ].map(item => (
                  <div key={item.lever} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${colors.cream}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {item.icon(colors.navy, 14)}
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>{item.lever}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <span style={{ padding: '2px 6px', borderRadius: '8px', backgroundColor: item.impact === 'Very High' ? 'var(--accent-green-bg)' : item.impact === 'High' ? 'var(--accent-blue-bg)' : 'var(--accent-amber-bg)', color: item.impact === 'Very High' ? 'var(--accent-green-text)' : item.impact === 'High' ? 'var(--accent-blue-text)' : 'var(--accent-amber-text)', fontSize: 'var(--t-meta)', fontWeight: '500' }}>
                        {item.impact}
                      </span>
                      <span style={{ padding: '2px 6px', borderRadius: '8px', backgroundColor: 'var(--icon-bg)', color: 'var(--text-secondary)', fontSize: 'var(--t-meta)', fontWeight: '500' }}>
                        {item.effort}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Burn and break-even.
                  ------------------------------------------------------------
                  These used to be computed from a MONTHLY / ANNUAL / ONE_TIME
                  array typed into this file. That array was Jayden's real
                  spend and it was five vendors out of date: it knew about
                  Railway, Claude Max, Codex, the Apple fee and the BestTime
                  corpus, and had never heard of Gemini, Google Places, Cloud
                  Vision, MapTiler or the domain. It also sat two tabs away
                  from a set of API ceilings nobody had ever priced.

                  The arrays now live in backend/services/costModel.js, which
                  is where the rate card and the meters are, and this panel
                  reads the same payload the Costs tab does. One source, so a
                  changed bill changes both. The full picture, including what
                  the meters have actually spent and what the ceilings would
                  permit, is on the Costs tab; this is the two-number version
                  the projections need.

                  Still true of everything below: nothing here is a
                  measurement of anything that has happened. */}
              {(() => {
                const fixed = costsData && costsData.fixed;
                // Flock Pro, monthly plan. Priced but dormant: the paywall is
                // gated behind PAYWALL_ENABLED and has never been switched on,
                // so there are no subscribers and no revenue to report.
                const PRO_MONTHLY_USD = 3.99;

                if (!fixed) {
                  return (
                    <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', border: `1px dashed ${colors.creamDark}`, marginBottom: '12px' }}>
                      <h4 style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: '0 0 4px' }}>Burn and break-even</h4>
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>
                        {costsLoading
                          ? 'Reading the cost model.'
                          : costsError
                            ? 'The cost model did not load, so there is no burn figure to show. Nothing is guessed in its place.'
                            : 'The cost model has not been read yet.'}
                      </p>
                      {!costsLoading && (
                        <button className="hit44 glass-btn glass-primary" onClick={() => fetchCosts()} style={{ ...styles.gradientButton, padding: '12px', marginTop: '10px' }}>
                          {costsError ? 'Try again' : 'Read the cost model'}
                        </button>
                      )}
                    </div>
                  );
                }

                const monthlyTotal = fixed.monthlyUsd;
                const annualTotal = fixed.annualUsd;
                const effectiveMonthly = fixed.effectiveMonthlyUsd;
                const subsToBreakEven = effectiveMonthly > 0 ? Math.ceil(effectiveMonthly / PRO_MONTHLY_USD) : 0;
                const usd0 = (n) => `$${Math.round(n).toLocaleString()}`;
                const row = (name, amount, sub) => (
                  <div key={name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '5px 0', borderTop: '1px solid var(--border-light)' }}>
                    <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>{name}</span>
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>{amount}<span style={{ fontWeight: '500', color: 'var(--text-tertiary)' }}>{sub}</span></span>
                  </div>
                );
                return (
                  <>
                  <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)', marginBottom: '12px' }}>
                    <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Burn and break-even</h3>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                      <div>
                        <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Fixed monthly burn</p>
                        <p style={{ fontSize: 'var(--t-display)', fontWeight: '600', color: colors.navy, margin: '2px 0 0', lineHeight: 1.1 }}>{usd0(effectiveMonthly)}</p>
                        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '3px 0 0' }}>{usd0(monthlyTotal)}/mo recurring plus {usd0(annualTotal)}/yr spread over twelve months. Metered API spend is on top and lives on the Costs tab.</p>
                      </div>
                      <div>
                        <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Target to cover it</p>
                        <p style={{ fontSize: 'var(--t-display)', fontWeight: '600', color: colors.navy, margin: '2px 0 0', lineHeight: 1.1 }}>{subsToBreakEven}</p>
                        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '3px 0 0' }}>Flock Pro subscriptions at ${PRO_MONTHLY_USD.toFixed(2)}/mo, before Apple's cut.</p>
                      </div>
                    </div>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '10px 0 0', paddingTop: '8px', borderTop: '1px solid var(--border-light)' }}>
                      The paywall is switched off, so nobody is subscribed and revenue is $0. {subsToBreakEven} is what break-even would take, not a count of anything.
                    </p>
                  </div>
                  <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
                      <h4 style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, margin: 0 }}>Fixed expenses</h4>
                      <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy }}>{usd0(effectiveMonthly)}<span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-tertiary)' }}>/mo effective</span></span>
                    </div>
                    {/* A LINE NOBODY HAS SEEN ON AN INVOICE SAYS SO HERE TOO.
                        This list printed a label and a number and nothing
                        else, so Vercel's assumed $0 read as a confirmed free
                        tier and the domain's $12 placeholder read as a bill.
                        The Costs tab carries the reason for each one; this tab
                        carries the mark, because a figure that is marked on one
                        screen and bare on the next is not marked. */}
                    {(fixed.monthly || []).map((e) => row(e.verified ? e.label : `${e.label} (unverified)`, `$${e.usd}`, '/mo'))}
                    {(fixed.annual || []).map((e) => row(e.verified ? e.label : `${e.label} (unverified)`, `$${e.usd}`, '/yr'))}
                    {(fixed.oneTime || []).map((e) => row(e.verified ? e.label : `${e.label} (unverified)`, `$${e.usd.toLocaleString()}`, ' once'))}
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0 0', marginTop: '3px', borderTop: '1px solid var(--border-default)' }}>
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)' }}>Recurring {usd0(monthlyTotal)}/mo plus {usd0(annualTotal)}/yr</span>
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)' }}>One-time invested: {usd0(fixed.oneTimeUsd)}</span>
                    </div>
                    {(fixed.unverifiedLines || []).length > 0 && (
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '7px 0 0', lineHeight: 1.4 }}>
                        {fixed.unverifiedLines.length} {fixed.unverifiedLines.length === 1 ? 'line is' : 'lines are'} a published price or an assumption rather than an invoice, marked above and counted in the burn anyway. The Costs tab says what each one assumes and where to confirm it.
                      </p>
                    )}
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '7px 0 0', lineHeight: 1.4 }}>
                      Vendors on free tiers, and what each meter has actually spent, are on the Costs tab.
                    </p>
                  </div>
                  </>
                );
              })()}

              {/* Where the projection charts used to be. An honest empty state
                  beats a plausible-looking fake. */}
              <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', border: `1px dashed ${colors.creamDark}`, marginBottom: '12px' }}>
                <h4 style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: '0 0 4px' }}>Revenue and growth</h4>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>
                  Nothing to show. Flock has never charged anyone and has no venue partners, so there is no revenue, no conversion rate and no acquisition cost to chart. This panel stays empty until the first real number exists.
                </p>
              </div>
            </div>
          )}

          {adminTab === 'research' && (() => {
            const demoMode = researchDemoMode;
            const data = demoMode ? {
              totalFlocks: 2340, completionRate: 78, avgGroupSize: 4.8, budgetAdoptionRate: 72,
              avgTimeToConfirmation: 5, totalUsers: 8500, newUsersThisWeek: 247,
              stallPointDistribution: [
                { stall_point: 'completed', count: 1825 }, { stall_point: 'venue', count: 198 },
                { stall_point: 'rsvp', count: 164 }, { stall_point: 'confirmation', count: 98 },
                { stall_point: 'budget', count: 55 },
              ],
              reliabilityDistribution: { reliable: 3240, moderate: 1870, flaky: 390, unscored: 3000 },
            } : researchLiveData;

            // The toggle, in one place so the two directions stay symmetrical.
            const modeToggle = (
              <button className="hit44" disabled={researchLoading} onClick={() => { if (demoMode) fetchResearchLive(); else setResearchDemoMode(true); }}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '6px', width: '100%', border: 'none', background: 'transparent', cursor: researchLoading ? 'default' : 'pointer' }}>
                <span style={{ width: '6px', height: '6px', borderRadius: '3px', background: demoMode ? '#D97706' : colors.steel }} />
                <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-tertiary)' }}>{researchLoading ? 'Reading the database...' : demoMode ? 'Demo data · Tap for live' : 'Live data · Tap for demo'}</span>
              </button>
            );

            // Nothing has been measured: the read is in flight, it failed, or
            // it has not happened. None of those is a zero, and printing them
            // as zeros under a "Live data" label is inventing a measurement.
            if (!data) {
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '20px 14px', textAlign: 'center', boxShadow: 'var(--card-shadow-sm)' }} role="status">
                    {!researchLoading && <BirdieStill bird={WARM_BIRD} size={64} style={{ margin: '0 auto 8px' }} />}
                    <h3 style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: '0 0 6px' }}>
                      {researchLoading ? 'Reading the database' : researchError ? 'These numbers did not load' : 'Nothing read yet'}
                    </h3>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
                      {researchLoading
                        ? 'One moment.'
                        : researchError
                          ? 'The analytics request failed, so there is nothing here to show. This is not a reading of zero.'
                          : 'Tap below to read the live numbers, or switch to demo data.'}
                    </p>
                    {!researchLoading && (
                      <button className="hit44 glass-btn glass-primary" onClick={() => fetchResearchLive()} style={{ ...styles.gradientButton, padding: '12px', marginTop: '14px' }}>
                        {researchError ? 'Try again' : 'Read live numbers'}
                      </button>
                    )}
                  </div>
                  {modeToggle}
                </div>
              );
            }

            const stallColors = { completed: colors.steel, venue: '#F59E0B', rsvp: '#EF4444', confirmation: '#4a7ba7', budget: '#3B82F6' };
            const stallTotal = (data.stallPointDistribution || []).reduce((s, p) => s + parseInt(p.count), 0) || 1;
            // A field the response did not carry is not a zero either, so it
            // says so rather than rendering one.
            const has = (v) => typeof v === 'number' && Number.isFinite(v);
            const stat = (v, render) => (has(v) ? render(v) : 'No data');
            const statCards = [
              { label: 'Total Flocks', value: stat(data.totalFlocks, (v) => v.toLocaleString()), color: colors.navy },
              { label: 'Completion Rate', value: stat(data.completionRate, (v) => `${v}%`), color: colors.steel },
              { label: 'Avg Group Size', value: stat(data.avgGroupSize, (v) => v), color: colors.navy },
              { label: 'Budget Adoption', value: stat(data.budgetAdoptionRate, (v) => `${v}%`), color: colors.steel },
              { label: 'Time to Confirm', value: stat(data.avgTimeToConfirmation, (v) => `${v}m`), color: colors.navy },
              { label: 'Total Users', value: stat(data.totalUsers, (v) => v.toLocaleString()), color: colors.navy },
            ];
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                  {statCards.map(s => (
                    <div key={s.label} style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', textAlign: 'center', boxShadow: 'var(--card-shadow-sm)' }}>
                      <p style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: s.color, margin: '0 0 2px' }}>{s.value}</p>
                      <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{s.label}</p>
                    </div>
                  ))}
                </div>
                <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                  <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Where Flocks Stall</h3>
                  {(data.stallPointDistribution || []).map(p => {
                    const pct = Math.round((parseInt(p.count) / stallTotal) * 100);
                    return (
                      <div key={p.stall_point} style={{ marginBottom: '8px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                          <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, textTransform: 'capitalize' }}>{p.stall_point}</span>
                          <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>{p.count} ({pct}%)</span>
                        </div>
                        <div style={{ height: '8px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '4px', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${pct}%`, backgroundColor: stallColors[p.stall_point] || colors.navy, borderRadius: '4px' }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                  <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>User Reliability</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px' }}>
                    {[
                      { label: '80%+', value: data.reliabilityDistribution?.reliable || 0, color: colors.steel },
                      { label: '50-79%', value: data.reliabilityDistribution?.moderate || 0, color: '#F59E0B' },
                      { label: '<50%', value: data.reliabilityDistribution?.flaky || 0, color: '#EF4444' },
                      { label: 'New', value: data.reliabilityDistribution?.unscored || 0, color: 'var(--text-secondary)' },
                    ].map(item => (
                      <div key={item.label} style={{ textAlign: 'center', padding: '8px 4px', borderRadius: '8px', backgroundColor: 'var(--bg-tertiary)' }}>
                        <p style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: item.color, margin: '0 0 2px' }}>{item.value}</p>
                        <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)', margin: 0 }}>{item.label}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)', textAlign: 'center' }}>
                  <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)', margin: '0 0 4px' }}>New Users This Week</p>
                  <p style={{ fontSize: 'var(--t-display)', fontWeight: '600', color: colors.steel, margin: 0 }}>
                    {has(data.newUsersThisWeek) ? `+${data.newUsersThisWeek.toLocaleString()}` : 'No data'}
                  </p>
                </div>
                {modeToggle}
              </div>
            );
          })()}
        </div>
      </div>
    );
}
