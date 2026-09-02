/**
 * VENUE OWNER DASHBOARD
 *
 * This screen was 2,018 lines of `App.js`, declared as an arrow function
 * inside `FlockAppInner` and called rather than mounted. Every person who
 * opened Flock to vote on a bar downloaded all of it, and none of them can
 * reach it: the screen is behind `authUser.role === 'venue_owner'` (or admin)
 * and it is the paid product. It is loaded now with `React.lazy` from
 * `App.js`, so it costs a chunk fetch the first time an owner opens the
 * dashboard and nothing at all to everyone else.
 *
 * WHY EVERYTHING ARRIVES AS A PROP
 *
 * The old arrow function closed over 119 names in `FlockAppInner`: state,
 * setters, loaders, and a handful of module-level helpers and components. A
 * context would have had to enumerate exactly the same 119 names into a
 * provider value, so it buys nothing here and hides the dependency surface
 * behind a hook. They are parameters instead. That makes this file's entire
 * dependency surface its parameter list plus its imports, and it means a name
 * this component needs and does not receive is an undefined identifier that
 * `no-undef` fails the build on, rather than a prop that is silently
 * `undefined` at runtime and renders as nothing.
 *
 * The state and the effects behind these props deliberately did NOT move. They
 * live in `FlockAppInner`, which does not unmount when the owner leaves the
 * dashboard, so a venue profile, a promotions list and an intelligence fetch
 * survive a trip to another screen exactly as they did before. Moving them
 * down here would have reset all of it on every exit.
 *
 * The body below is the old block verbatim, including its original four-space
 * indentation, so it can be diffed against the deleted lines character for
 * character. Nothing was renamed, reformatted or improved on the way across.
 */
import React from 'react';
import { AnimatePresence } from 'framer-motion';
import { BirdieStill, BirdNote, BIRDIE, WARM_BIRD } from '../components/ui/BirdieBird';
import Icons from '../components/ui/Icons';
import VenueInsightCards from '../components/VenueInsightCards';
import VenueAdvisorChat from '../components/VenueAdvisorChat';
import {
  BASE_URL,
  askAdvisor,
  askAdvisorQuestion,
  createVenueEvent,
  createVenuePromotion,
  deleteVenueEvent,
  deleteVenuePromotion,
  getAdvisorQuestions,
  getVenueAdvisorCards,
  replyToReview,
  updateVenueEvent,
  updateVenueProfile,
  updateVenuePromotion,
} from '../services/api';

export default function VenueDashboard({
  // Module-level helpers and components that live in App.js and are shared
  // with screens that are not this one, so they stay there and come in here.
  DialogBehavior,
  EventModal,
  HOUR_BAR_WELL_PX,
  MapLibreMapView,
  ModerationHiddenNotice,
  PromoModal,
  SearchInputLocal,
  WEEK_BAR_WEIGHT_MIN,
  WEEK_BAR_WELL_PX,
  crowdColorDeepFor,
  isModerationHidden,
  memberCountLabel,
  venuePlanPriceLabel,
  // Everything else: state, setters, loaders and render helpers declared in
  // FlockAppInner. Alphabetical, and generated from the identifiers this file
  // actually reads.
  VENUE_MAX_ANCHORS,
  activeVenue,
  allVenues,
  authUser,
  calcDistance,
  colors,
  dealDescription,
  dealTimeSlot,
  editingEvent,
  editingPromo,
  editingVenueInfo,
  flockMemberLocations,
  getCategoryColor,
  handleClearBusyNow,
  handleRequestVerification,
  handleSetBusyNow,
  handleVenueLogoPick,
  loadIncomingFlocks,
  loadVenueEvents,
  loadVenueMap,
  loadVenuePromotions,
  loadVenueReviews,
  onLogout,
  openVenueDetail,
  openVenueLogoPicker,
  operatingHours,
  ownerSensorData,
  ownerSensorHistory,
  promotions,
  realIncomingFlocks,
  renderConsumerVenueCard,
  renderVenueChips,
  renderVenueField,
  renderVenueNumber,
  renderVenueTime,
  replyText,
  replyingToReview,
  // Still handed over by App.js and no longer read here: the Roost card
  // stopped taking a verification handler on 2026-09-01 (see the
  // <VenueInsightCards> call site). extractionEquivalence pins this list to
  // the props object in App.js, so the name leaves both files together.
  requestVerificationNow,
  retryVenueIntel,
  savingVenueIntake,
  setActiveVenue,
  setCurrentScreen,
  setDealDescription,
  setDealTimeSlot,
  setEditingEvent,
  setEditingPromo,
  setEditingVenueInfo,
  setOperatingHours,
  setPickingVenueForCreate,
  setPromotions,
  setReplyText,
  setReplyingToReview,
  setSavingVenueIntake,
  setSelectedVenueForCreate,
  setShowEventModal,
  setShowHoursModal,
  setShowPromoModal,
  setShowUpgradeModal,
  setVenueBusyDraft,
  setVenueEventsList,
  setVenueInfo,
  setVenueIntakeDraft,
  setVenueLogoPicker,
  setVenueProfile,
  setVenueReviewsData,
  setVenueTab,
  showEventModal,
  showHoursModal,
  showPromoModal,
  showToast,
  showUpgradeModal,
  switchMode,
  venueAgePolicies,
  venueAnchorTypes,
  venueBusyDraft,
  venueBusyNow,
  venueBusySaving,
  venueCategories,
  venueEventsList,
  venueGoals,
  venueInfo,
  venueIntakeDraft,
  venueIntel,
  venueListErrors,
  venueLogoPicker,
  venueLogoPlaceId,
  venueLogoUploading,
  venueLogoUrl,
  venueMapState,
  venueOnboardingData,
  venueProfile,
  venueProfileToIntake,
  venueReservationPolicies,
  venueReviewsData,
  venueServiceStyles,
  venueStrip,
  venueTab,
  venueThisWeek,
  venueTier,
  venueTierEndsAt,
  venueTierReason,
  venueTierSource,
  venueWeekdays,
  verificationRequestBusy,
  verificationRequestError,
  verificationRequestNote,
}) {

    // Incoming flocks — real data from backend
    const incomingFlocks = realIncomingFlocks;

    // Reviews from backend
    const reviews = (venueReviewsData.reviews || []).map(r => ({
      id: r.id,
      user: r.name || 'Anonymous',
      rating: r.rating,
      text: r.text || '',
      date: r.created_at ? new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
      replied: !!r.venue_reply,
      reply: r.venue_reply || null,
    }));
    const reviewStats = venueReviewsData.stats;


    const venueTabs = [
      { id: 'analytics', label: 'Analytics', icon: Icons.barChart },
      // The venue as consumers see it. Presence, not a paid feature.
      { id: 'map', label: 'Map', icon: Icons.map },
      // Was Icons.gift. A wrapped present means "a gift", and nothing on this
      // tab is one: it is the owner posting a happy-hour deal, and the tab's
      // own first heading is "Post a Deal" under Icons.zap — so the tab and its
      // contents disagreed about what the tab was. Icons.tag is the price tag,
      // which is what an offer is, and it reads down to 12px.
      { id: 'promotions', label: 'Promotions', icon: Icons.tag },
      { id: 'events', label: 'Events', icon: Icons.calendar },
      { id: 'reviews', label: 'Reviews', icon: Icons.star },
      { id: 'settings', label: 'Settings', icon: Icons.settings }
    ];

    // The "How full are you right now?" card. ONE definition for the two
    // tabs that render it: Analytics (where it lives) and Map (where
    // setting it is the proof that the pin updates). Same state, same
    // handlers, same copy on both.
    const renderBusyNowCard = () => {
            const live = venueBusyNow.live;
            const ttl = venueBusyNow.ttlMinutes || 90;
            const expiresMin = live ? Math.max(0, Math.round((Date.parse(live.expiresAt) - Date.now()) / 60000)) : null;
            const sliderValue = venueBusyDraft != null ? venueBusyDraft : (live ? live.percent : 50);
            // What the number is labeled as on user surfaces, computed
            // server-side (utils/venueLabel.js) from the venue's category and
            // shipped on this payload. Never hardcode the words here:
            // venueLabel.test.js greps this file for the old literal, and the
            // fallback below is the one phrase that is true of any venue.
            const saysLabel = venueBusyNow.attribution || 'the venue says';
            return (
              <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 4px' }}>How full are you right now?</h3>
                {venueBusyNow.suppressed ? (
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
                    Your live numbers are paused. Recent readings disagreed with what people in the room reported, so users see the forecast for now. This lifts on its own.
                  </p>
                ) : live ? (
                  <div>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
                      <span style={{ fontWeight: '700', color: colors.steel }}>Live</span>
                      {' · users see '}
                      <span style={{ fontWeight: '600', color: colors.navy }}>{live.percent}% full</span>
                      {`, labeled as your number · ${expiresMin} min left`}
                    </p>
                    {/* Remaining time as a bar: state, not ornament. It only
                        depletes when the card re-renders, same clock as the
                        "min left" text beside it. No animation of its own. */}
                    <div aria-hidden style={{ height: '3px', borderRadius: '2px', backgroundColor: 'var(--border-light)', marginTop: '6px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: '2px', backgroundColor: colors.steel, width: `${Math.max(0, Math.min(100, (expiresMin / ttl) * 100))}%` }} />
                    </div>
                  </div>
                ) : (
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
                    Set it and users see your number instead of the forecast, labeled as yours. It expires after {ttl} minutes so you never have to remember to turn it off.
                  </p>
                )}
                <div style={{ margin: '10px 0' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: '2px' }}>
                    {/* Hanken's digits are natively monospaced (index.css header
                        note), so this readout does not jitter while the thumb
                        drags. Never Fraunces here: no tnum. */}
                    <span style={{ fontSize: '34px', fontWeight: '600', lineHeight: 1.1, color: colors.navy, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.5px' }}>{sliderValue}</span>
                    <span style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--text-secondary)', marginLeft: '2px' }}>%</span>
                    {live && venueBusyDraft != null && venueBusyDraft !== live.percent && (
                      <span style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', marginLeft: 'auto' }}>live now: {live.percent}%</span>
                    )}
                  </div>
                  <input
                    type="range" min="0" max="100" step="1"
                    className="busy-range"
                    aria-label="How full is your venue right now, 0 to 100 percent"
                    value={sliderValue}
                    onChange={(e) => setVenueBusyDraft(Number(e.target.value))}
                    disabled={venueBusySaving}
                    style={{ '--busy-fill': `${sliderValue}%` }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)' }}>Empty</span>
                    <span style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)' }}>Packed</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <button className="hit44 glass-btn glass-navy"
                    onClick={handleSetBusyNow}
                    // Only an UPDATE needs a draft. With no live reading the
                    // 50 on screen is a real, postable choice, and disabling
                    // the card's one CTA on the state every owner opens it in
                    // meant a venue that genuinely is half full had to drag
                    // the thumb off 50 and back to arm the button. Once a
                    // reading is live, re-posting the same number is a no-op,
                    // so the draft check still applies there.
                    disabled={venueBusySaving || (!!live && venueBusyDraft == null)}
                    style={{ flex: 1, padding: '12px', borderRadius: '10px', border: 'none', background: colors.navyMidBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-label)' }}
                  >
                    {venueBusySaving ? 'Saving...' : live ? 'Update live number' : 'Set live number'}
                  </button>
                  {live && (
                    <button className="hit44"
                      onClick={handleClearBusyNow}
                      disabled={venueBusySaving}
                      style={{ padding: '12px 10px', borderRadius: '10px', border: 'none', backgroundColor: 'transparent', color: 'var(--text-secondary)', fontWeight: '600', fontSize: 'var(--t-label)', cursor: venueBusySaving ? 'default' : 'pointer', opacity: venueBusySaving ? 0.5 : 1 }}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '10px 0 0', paddingTop: '8px', borderTop: '1px solid var(--border-light)', lineHeight: 1.5 }}>
                  Free on every plan. Shown to users as "{saysLabel}". Reports from people at your venue outrank it.
                </p>
              </div>
            );
    };

    // Promotion handlers — real API
    const openPromoModal = (promo = null) => {
      setEditingPromo(promo);
      setShowPromoModal(true);
    };

    // The server refuses this for real reasons the owner can act on: a
    // moderation-hidden promotion answers 409 CONTENT_HIDDEN with a sentence
    // telling them to delete and re-create, and once venue billing is switched
    // on a free-tier account gets 403 UPGRADE_REQUIRED. Both used to land in
    // console.error, so the trash icon was a dead button — tap it and nothing
    // whatsoever happens (SLOP-AUDIT rule 5). The server's own wording is what
    // shows: api.js already puts the response's `error` on err.message, and a
    // generic "couldn't delete" would throw away the only sentence that says
    // what to do next. The fallback covers an error carrying no message at all.
    //
    // A 404 is reconciled rather than reported as a failure. The server answers
    // 404 for "not yours / already gone", so the row in front of the owner does
    // not exist any more — leaving it on screen means the delete button appears
    // to have failed and every further tap on it fails the same way. Deleting
    // is what they asked for and it is already true, so the row goes.
    const deletePromo = async (id) => {
      try {
        await deleteVenuePromotion(id);
        setPromotions(prev => prev.filter(p => p.id !== id));
      } catch (e) {
        if (e?.status === 404) {
          setPromotions(prev => prev.filter(p => p.id !== id));
          return;
        }
        showToast(e?.message || "That promotion couldn't be deleted. Try again.", 'error');
      }
    };

    // Event handlers — real API
    const openEventModal = (event = null) => {
      setEditingEvent(event);
      setShowEventModal(true);
    };

    // Same dead-button fix as deletePromo above, and the same 404
    // reconciliation, for the same reasons.
    const deleteEvent = async (id) => {
      try {
        await deleteVenueEvent(id);
        setVenueEventsList(prev => prev.filter(e => e.id !== id));
      } catch (e) {
        if (e?.status === 404) {
          setVenueEventsList(prev => prev.filter(e2 => e2.id !== id));
          return;
        }
        showToast(e?.message || "That event couldn't be deleted. Try again.", 'error');
      }
    };

    // A 409 CONTENT_HIDDEN from a SAVE is the server telling us this list is
    // out of date: the row was taken down after the dashboard loaded, which is
    // how the Edit button that no longer renders for hidden rows can still be
    // reached. Two things follow, and the second matters as much as the first.
    //
    //   1. Mark the row. It explains itself from here on instead of offering an
    //      Edit button that refuses again. Nothing re-reads the list to find
    //      this out: the 409 IS the fact, and a refetch is one more thing that
    //      can fail.
    //   2. CLOSE the composer. Every other failure in these two save handlers
    //      leaves it open, because trying again is the right move there: a
    //      profanity screen, a lost connection, a tier refusal all clear. This
    //      one never does. Leaving the form up with a Save button that can only
    //      ever answer 409 is precisely the control-that-cannot-succeed this
    //      change exists to remove, and the row behind it now carries the
    //      reason in full.
    //
    // Named rather than inlined so both catch blocks stay short enough to read.
    const markPromoTakenDown = (id) => {
      setPromotions(prev => prev.map(p => (p.id === id ? { ...p, hidden_by_moderation: true } : p)));
      setShowPromoModal(false);
      setEditingPromo(null);
    };
    const markEventTakenDown = (id) => {
      setVenueEventsList(prev => prev.map(e => (e.id === id ? { ...e, hidden_by_moderation: true } : e)));
      setShowEventModal(false);
      setEditingEvent(null);
    };

    // Reply to review handler
    const handleReplyToReview = async (reviewId) => {
      if (!replyText.trim()) return;
      try {
        const updated = await replyToReview(reviewId, replyText);
        setVenueReviewsData(prev => ({
          ...prev,
          reviews: prev.reviews.map(r => r.id === reviewId ? { ...r, venue_reply: updated.venue_reply, venue_replied_at: updated.venue_replied_at } : r)
        }));
        setReplyingToReview(null);
        setReplyText('');
      } catch (e) {
        // Was swallowed too. A reply the server rejects (profanity screen,
        // a hidden review, a lost session) left the composer sitting there
        // with the text still in it and no explanation.
        showToast(e?.message || "That reply didn't post. Try again.", 'error');
      }
    };

    // Everything on the analytics tab is now computed, never invented:
    // venueIntel/venueStrip come from the crowd model, and the demand number
    // is the venue's real incoming-flocks feed. If something can't be
    // computed, the tab says so instead of showing a made-up figure.
    const venueData = {
      name: venueProfile?.business_name || authUser?.name || 'Your Venue',
      logo: null,
      tier: venueTier,
    };
    const intelReady = venueIntel?.available;
    // The three verification states are exactly the three the server reports:
    // 'verified', 'pending', 'unverified'. This is the middle one, and the only
    // thing the screen does with it is stop asking for what it already has.
    const venueVerificationPending = venueProfile?.verification_status === 'pending';
    const venueIsVerified = venueProfile?.verification_status === 'verified';

    // THE REQUEST CONTROL, LIFTED OUT OF THE PAID TAB.
    //
    // Until now the only "Request verification" button on this screen lived
    // inside the `venueIntel` card, and that card renders under
    // `venueTab === 'analytics' && can.analytics`. `can.analytics` is
    // premium-or-pro. Every venue that signs up holds `free` until an admin
    // grants otherwise, so the owner who has just claimed a venue, which is
    // the only owner who has a verification to request, opened Analytics to a
    // locked panel with the button inside it.
    //
    // What that owner did see was the server's own sentence, on the live-number
    // card above the lock: "Not verified yet. Request verification and we
    // confirm you own this venue by hand." An instruction with nothing to press
    // is the TestFlight dead end of 2026-08-21 rebuilt one tier down, and it
    // was rebuilt for the owners it hurts most, because verification is what
    // turns on the live number and the forecast in the first place.
    //
    // One definition, three call sites, and never two of them on one screen at
    // once: the Settings tab (which no tier gates), the Map tab's live-number
    // card (that tab has no intel card to duplicate), and the Analytics
    // live-number card ONLY when `can.analytics` is false, which is exactly the
    // condition under which the intel card carrying the other copy is replaced
    // by the lock. Both reads come from the same `can` object.
    //
    // Rendered only where pressing it can change something: never once the
    // venue is verified, never while a request is already in, and never after a
    // press has landed in this session, since `verificationRequestNote` then
    // holds the server's own answer.
    const canAskForVerification = !venueIsVerified
      && !venueVerificationPending
      && !verificationRequestNote;
    const renderVerificationAsk = () => {
      if (!canAskForVerification) return null;
      return (
        <>
          <button
            className="hit44"
            onClick={handleRequestVerification}
            disabled={verificationRequestBusy}
            style={{ marginTop: '10px', padding: '8px 14px', borderRadius: '8px', border: '1.5px solid var(--border-default)', backgroundColor: 'transparent', color: 'var(--text-secondary)', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: verificationRequestBusy ? 'default' : 'pointer', opacity: verificationRequestBusy ? 0.55 : 1 }}
          >
            Request verification
          </button>
          {verificationRequestError && (
            <p style={{ fontSize: 'var(--t-meta)', color: colors.redText, margin: '8px 0 0', lineHeight: 1.5 }}>{verificationRequestError}</p>
          )}
        </>
      );
    };

    const weekPeak = intelReady && venueIntel.week?.length
      ? venueIntel.week.reduce((a, b) => (b.peakScore > a.peakScore ? b : a))
      : null;
    const tonightPeak = intelReady && venueIntel.todayHourly?.length
      ? venueIntel.todayHourly.slice(-8).reduce((a, b) => (b.score > a.score ? b : a))
      : null;

    const tierBadge = {
      free: { label: 'Free', color: 'var(--text-secondary)', bg: 'var(--bg-hover)' },
      premium: { label: 'Premium', color: 'var(--accent-amber-text)', bg: 'var(--accent-amber-bg)' },
      pro: { label: 'Pro', color: 'var(--accent-purple-text)', bg: 'var(--accent-purple-bg)' },
    };

    // Tiers are set by us, on the server. The two buttons that used to sit at
    // the bottom of the plan cards called updateVenueProfile({ tier }) and then
    // flipped venueTier locally: the server stopped accepting a client-supplied
    // tier when the self-serve hole was closed, so the request did nothing, the
    // dashboard showed a plan nobody was on, and nothing had been paid. A
    // control inside the iOS binary that offers a paid plan and does not
    // deliver it is an App Review 3.1.1 question and a dead button besides.
    // There is no venue purchase flow yet, so the honest action is to reach us.
    //
    // The social mailbox, not the support one. SLOP-AUDIT section B flagged
    // the support address as one nobody has confirmed receives mail, and
    // CommunityGuidelines.js deliberately routes every contact route to the
    // social one for that exact reason. A venue owner trying to cancel a paid
    // plan is the last person who should be answered by a mailbox that may not
    // exist, so this screen now uses the address that was verified with a real
    // send. (Neither address is spelled out in this comment on purpose. The
    // flowtype eslint rule treats an at-sign followed by an f, anywhere in a
    // comment, as a malformed Flow pragma, and our domain contains exactly
    // that pair. Writing the address here turns the build yellow.)
    const VENUE_SALES_EMAIL = 'social@flockcorp.com';
    const requestTierUpgrade = (target) => {
      const subject = encodeURIComponent(`Flock venue upgrade request: ${target}`);
      const body = encodeURIComponent(
        `Business: ${venueProfile?.business_name || ''}\nPlan I want: ${target}\n`
      );
      try {
        window.location.href = `mailto:${VENUE_SALES_EMAIL}?subject=${subject}&body=${body}`;
      } catch {
        // The address is printed in the sheet as well, so a device with no
        // mail app still has something to act on.
      }
    };

    // WHAT A PLAN ACTUALLY BUYS, READ OFF THE SERVER'S OWN GATES.
    //
    // These lists are the only description of the plans a venue owner ever
    // sees, and two of them were wrong in opposite directions.
    //
    // Premium led with "Enhanced visibility on the map". Nothing in the
    // backend reads a venue tier when it builds the map, ranks a vote list or
    // scores a pin — there is no promoted placement in this repo at all
    // (VENUE-BILLING.md calls it unbuilt) — so the first line of a $35/mo plan
    // named a thing that does not exist. Pro was wrong the other way: it sold
    // hour-by-hour forecasts, the strip and the week ahead, and all three sit
    // behind requirePremium in routes/venueDashboard.js, so Pro was charging
    // $40 more for what the plan below it already includes.
    //
    // The real division, from the route middleware:
    //   free     the listing, the venue card, reviews and replies (the reply
    //            route carries no tier gate), and the live crowd number.
    //   premium  promotions, events, incoming flocks, /intelligence, /strip,
    //            and the advisor's /cards.
    //   pro      /this-week, and the advisor's /questions, /ask and /question.
    // If a gate moves, move the sentence in the same commit.
    const features = {
      free: [
        'Your listing on the map',
        'Your venue details on the card users open',
        'Reviews from Flock users, and your replies',
        'Set your live crowd number, on any plan',
      ],
      premium: [
        'Post deals and specials',
        'List your events',
        'See which groups have you in their vote',
        'Crowd forecasts for your venue, today by the hour and a week out',
        'How your projected night compares to the venues around you',
        "Roost's cards, every line naming where its number came from",
      ],
      // Only features that actually exist may appear here (SLOP-AUDIT.md C1).
      pro: [
        'Everything in Premium',
        'Ask Roost a question and get the answer from your own numbers',
        'The weekly summary: what your venue did over the last 7 days',
      ],
    };

    // A helper used to sit here that took a feature NAME and looked it up in
    // the lists above with .includes(). It is gone, and this is what it cost.
    //
    // Every one of its four call sites passed the short form of the deals
    // feature. The premium list spells that feature out in full. .includes() is
    // exact, so the lookup missed, the helper fell through to its closing
    // return, and a venue PAYING for Premium opened the Analytics tab to find
    // Post-a-Deal greyed out under a "Premium Feature" overlay, on the plan
    // that includes it. Only Pro escaped, through the early return on the first
    // line. The failure was silent in both directions: a typo could not throw,
    // and the safe-looking default was "locked".
    //
    // The lists it read are marketing copy for the upgrade sheet, and copy gets
    // reworded. The gate now reads `can` below, which is derived from the tier
    // itself and cannot drift from a sentence. If a gate is ever needed for a
    // feature that has no `can` flag, add the flag; do not match on prose.

    // Capability gates by tier — used elsewhere in the dashboard
    const can = {
      postDeals: venueTier === 'premium' || venueTier === 'pro',
      events: venueTier === 'premium' || venueTier === 'pro',
      analytics: venueTier === 'premium' || venueTier === 'pro',
      enhancedVisibility: venueTier === 'premium' || venueTier === 'pro',
      detailedInsights: venueTier === 'pro',
      pushNotifications: venueTier === 'pro',
      sponsoredPlacement: venueTier === 'pro',
      aiRecommendations: venueTier === 'pro',
      booking: venueTier === 'pro',
    };

    // Locked tab placeholder — shown when feature isn't available on current tier
    const LockedTab = ({ requiredTier, featureName, description }) => (
      <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '16px', padding: '32px 20px', textAlign: 'center', margin: '12px 0', border: `2px dashed ${requiredTier === 'pro' ? '#2d5a87' : 'var(--accent-amber-text)'}` }}>
        {/* The last hand-drawn icon on this surface. It was a padlock with
            rounded caps and a rounded rect, which is a different drawing
            language from every other mark in the app; components/ui/Icons.js
            owns that geometry and already has this shape. Decorative, so no
            label argument. */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '10px' }} aria-hidden>
          {Icons.lock(requiredTier === 'pro' ? '#2d5a87' : 'var(--accent-amber-text)', 32)}
        </div>
        <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: 'var(--text-primary)', margin: '0 0 6px' }}>{featureName}</h3>
        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 16px', lineHeight: '1.5' }}>{description}</p>
        <p style={{ fontSize: 'var(--t-micro)', color: requiredTier === 'pro' ? 'var(--accent-purple-text)' : 'var(--accent-amber-text)', fontWeight: '700', margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Requires {requiredTier === 'pro' ? `Pro · ${venuePlanPriceLabel('pro')}` : `Premium · ${venuePlanPriceLabel('premium')}`}</p>
        <button className="hit44 glass-btn glass-primary" onClick={() => setShowUpgradeModal(true)} style={{ padding: '10px 20px', borderRadius: '10px', border: 'none', background: requiredTier === 'pro' ? '#2d5a87' : 'var(--accent-amber-text)', color: 'white', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer' }}>
          Upgrade to {requiredTier === 'pro' ? 'Pro' : 'Premium'}
        </button>
      </div>
    );

    return (
      <div key="venue-dashboard-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--bg-primary)' }}>
        {/* Header */}
        <div style={{ padding: '16px', background: colors.navyBg, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <button aria-label="Back" className="hit44" onClick={switchMode} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.arrowLeft('white', 16)}
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ ...tierBadge[venueData.tier], padding: '4px 10px', borderRadius: '12px', fontSize: 'var(--t-meta)', fontWeight: '500', backgroundColor: tierBadge[venueData.tier].bg, color: tierBadge[venueData.tier].color }}>
                {tierBadge[venueData.tier].label}
              </span>
              <button aria-label="Log out" className="hit44" onClick={onLogout} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {Icons.logout('white', 14)}
              </button>
            </div>
          </div>
          <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
            {/* Was a <div onClick> whose only affordance was a 10px camera
                glyph, carrying its meaning in a `title` — a tooltip is not an
                accessible name and does not exist on touch at all. A real
                button, keyboard reachable, with the name on the control.

                Only a button while a Google listing is linked: the logo comes
                from the listing's own photos (see openVenueLogoPicker), so
                with no place id there is nothing this control could ever do,
                and a control that cannot succeed does not get rendered as
                one. */}
            {venueLogoPlaceId ? (
            <button
              type="button"
              onClick={() => openVenueLogoPicker()}
              aria-label={venueLogoUrl ? 'Replace venue logo' : 'Choose venue logo'}
              style={{ width: '48px', height: '48px', padding: 0, border: 'none', borderRadius: '12px', backgroundColor: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', overflow: 'hidden', position: 'relative', flexShrink: 0 }}
            >
              {venueLogoUrl ? (
                <img src={venueLogoUrl} alt="Logo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <span style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: 'white' }}>
                  {(venueData.name || 'V').charAt(0).toUpperCase()}
                </span>
              )}
              {/* A real spinner, not the bare "…" this overlay used to show —
                  three dots over a darkened logo read as broken, not busy.
                  Small inline action, so a small inline spinner (SLOP-AUDIT
                  §10), not a bird: mascots do not sit on wait states inside a
                  work tool. role="status" so the wait is announced. */}
              {venueLogoUploading && (
                <div role="status" aria-label="Saving logo" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ width: '16px', height: '16px', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: 'white', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                </div>
              )}
              {/* 10px was two bands below anything this set is drawn for: the
                  camera's lens is an r=5 circle inside an 18-unit box, which at
                  10px is a 4px ring with a 1px wall — it rendered as a smudge.
                  20px badge, 12px glyph. */}
              <span style={{ position: 'absolute', bottom: -2, right: -2, width: '20px', height: '20px', borderRadius: '10px', backgroundColor: colors.steel, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid var(--bg-primary)' }}>
                {Icons.camera('white', 12)}
              </span>
            </button>
            ) : (
            <div aria-hidden style={{ width: '48px', height: '48px', borderRadius: '12px', backgroundColor: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
              {venueLogoUrl ? (
                <img src={venueLogoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <span style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: 'white' }}>
                  {(venueData.name || 'V').charAt(0).toUpperCase()}
                </span>
              )}
            </div>
            )}
            <div style={{ flex: 1 }}>
              <h1 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: 'white', margin: 0 }}>Welcome, {venueData.name}</h1>
              <p style={{ fontSize: 'var(--t-meta)', color: 'rgba(255,255,255,0.7)', margin: 0 }}>{venueProfile?.category || venueOnboardingData.category || 'Venue Dashboard'}{(venueProfile?.location || venueOnboardingData.location) ? ` · ${venueProfile?.location || venueOnboardingData.location}` : ''}</p>
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        {/* Six tabs no longer fit 320px at full labels, so the strip
            scrolls sideways (same idiom as the Discover filter chips)
            instead of ellipsizing tab names or overflowing the page. */}
        <div style={{ display: 'flex', backgroundColor: 'var(--bg-card-solid)', borderBottom: '1px solid var(--border-default)', flexShrink: 0, overflowX: 'auto', scrollbarWidth: 'none', msOverflowStyle: 'none', WebkitOverflowScrolling: 'touch' }}>
          {venueTabs.map(tab => (
            <button className="hit44" key={tab.id} onClick={() => setVenueTab(tab.id)} style={{ flex: '1 0 auto', minWidth: '56px', padding: '10px 6px', border: 'none', backgroundColor: 'transparent', cursor: 'pointer', borderBottom: venueTab === tab.id ? `2px solid ${colors.navy}` : '2px solid transparent', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
              {tab.icon(venueTab === tab.id ? colors.navy : colors.textTertiary, 16)}
              <span style={{ fontSize: 'var(--t-meta)', fontWeight: venueTab === tab.id ? '500' : '500', color: venueTab === tab.id ? colors.navy : colors.textTertiary }}>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Content. The Map tab lays out as a fixed column (slider, then the
            map filling the rest), so it opts out of the scroll the list tabs
            use; scrolling a map page fights the map's own pan gesture. */}
        {/* ── SAFE AREA — the bottom inset lives HERE and nowhere else ─────
            This dashboard is the one authenticated surface that renders NO
            BottomNav, and the tab bar is where every other screen picks up
            var(--safe-bottom). So this scroller's own last pixel is the
            phone's last pixel: phoneContainer is 100dvh under viewport-fit=
            cover (see the SAFE-AREA CONTRACT in index.css), which put the
            final card of every venue tab under the home indicator: the Roost
            composer, which is deliberately the last thing in its card, the
            Settings save button, and on the Map tab MapLibre's own
            attribution control, which is a legal obligation drawn in the
            strip a thumb cannot reach.

            The Map tab is why this is padding on the scroller rather than
            margin on the cards: that tab lays out as height:100% inside this
            box, and padding is outside the content box, so the map shrinks
            by the inset instead of hanging past it. */}
        <div style={{ flex: 1, overflowY: venueTab === 'map' ? 'hidden' : 'auto', padding: '12px 12px calc(12px + var(--safe-bottom))' }}>

          {/* ANALYTICS TAB */}
          {/* HOW FULL ARE YOU RIGHT NOW — free at every tier, deliberately
              rendered OUTSIDE the can.analytics gate. The number users see is
              never for sale: a paid tier that buys influence over a
              consumer-shown figure is the FTC's LendEDU shape. What keeps this
              honest is disclosure, not price — users see it labelled "the bar
              says", it expires after 90 minutes on its own, and recent user
              reports outrank it. All three rules are server-enforced. */}
          {venueTab === 'analytics' && venueBusyNow?.available && renderBusyNowCard()}
          {/* The same card, the same absence, the same sentence. The Map tab
              already prints the server's reason when the live number is not
              available; Analytics printed nothing at all, so a venue with no
              linked listing opened its main tab to find the control simply not
              there, with no way to learn that it exists or what would bring it
              back. An unexplained gap where a control belongs is the shape
              this dashboard has already had to remove twice. */}
          {venueTab === 'analytics' && venueBusyNow && !venueBusyNow.available && (
            <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
              <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 4px' }}>How full are you right now?</h3>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>{venueBusyNow.reason || 'Your live number is unavailable right now.'}</p>
              {/* The sentence above is the server's, and when the reason is a
                  missing verification it names a request. `!can.analytics` is
                  the condition under which the intel card that carries the
                  other copy of this button is replaced by the lock, so this is
                  the one place the control can go without putting two of them
                  on the same tab. */}
              {venueBusyNow.unverified && !can.analytics && renderVerificationAsk()}
            </div>
          )}
          {/* MAP TAB. The venue exactly as consumers get it: same public
              venue lookup, same batch crowd scores, same card a pin tap
              opens on Discover. The slider up top is the same control as
              Analytics, so setting a number flips the pin's score, the heat
              weight and the open card's attribution to the venue's own words
              right in front of the owner. Presence, not a paid feature: every
              claimed venue gets this view, and nothing consumer-facing
              changes by payment. */}
          {venueTab === 'map' && (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              {venueBusyNow?.available && renderBusyNowCard()}
              {/* Titled, like the Analytics copy of it. A bare sentence in a
                  card says nothing about WHICH control is missing, and this
                  one sits where the slider would have been. */}
              {venueBusyNow && !venueBusyNow.available && (
                <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                  <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 4px' }}>How full are you right now?</h3>
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>{venueBusyNow.reason || 'Your live number is unavailable right now.'}</p>
                  {/* No tier condition here. This tab holds no intel card, so
                      there is nothing on it to duplicate. */}
                  {venueBusyNow.unverified && renderVerificationAsk()}
                </div>
              )}
              {!venueMapState && (
                <div className="skeleton" style={{ flex: 1, borderRadius: '12px' }} />
              )}
              {venueMapState && !venueMapState.available && (
                <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '16px', boxShadow: 'var(--card-shadow-sm)' }}>
                  {/* Warm bird: this card is about the owner's own listing. */}
                  <BirdieStill bird={WARM_BIRD} size={64} style={{ marginBottom: '8px' }} />
                  <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: '0 0 6px' }}>
                    {venueMapState.reason === 'no_listing' ? "Your venue isn't on the map yet"
                      : venueMapState.reason === 'no_coords' ? 'Google has no coordinates for your listing'
                      : "The map couldn't load"}
                  </p>
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
                    {venueMapState.reason === 'no_listing' ? 'No Google listing is linked, so there is no location to put a pin on. Link your listing in Edit Profile and the map fills in.'
                      : venueMapState.reason === 'no_coords' ? "Your listing exists but Google returned no location for it, so there is nothing to place a pin on. Users' maps have the same gap."
                      : 'The venue lookup failed. Check your connection and try again.'}
                  </p>
                  {venueMapState.reason === 'load_failed' && (
                    <button className="hit44" onClick={loadVenueMap} style={{ marginTop: '10px', padding: '8px 14px', borderRadius: '8px', border: '1.5px solid var(--border-default)', backgroundColor: 'transparent', color: 'var(--text-secondary)', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer' }}>
                      Try again
                    </button>
                  )}
                </div>
              )}
              {venueMapState?.available && (
                <div style={{ flex: 1, minHeight: 0, position: 'relative', borderRadius: '12px', overflow: 'hidden', boxShadow: 'var(--card-shadow-sm)' }}>
                  <MapLibreMapView
                    venues={allVenues}
                    filterCategory="All"
                    userLocation={null}
                    activeVenue={activeVenue}
                    setActiveVenue={setActiveVenue}
                    getCategoryColor={getCategoryColor}
                    pickingVenueForCreate={false}
                    setPickingVenueForCreate={setPickingVenueForCreate}
                    setSelectedVenueForCreate={setSelectedVenueForCreate}
                    setCurrentScreen={setCurrentScreen}
                    openVenueDetail={openVenueDetail}
                    flockMemberLocations={flockMemberLocations}
                    calcDistance={calcDistance}
                    ownerPlaceId={venueProfile?.google_place_id || null}
                    initialCenter={venueMapState.center}
                    followUser={false}
                  />
                  <AnimatePresence>
                    {renderConsumerVenueCard({ venueOwnerView: true })}
                  </AnimatePresence>
                </div>
              )}
            </div>
          )}

          {/* Was "Analytics Dashboard" / "Track check-ins, peak hours, and
              customer traffic with real-time insights." Three things wrong
              with one sentence: this tab has never shown check-in counts or a
              traffic figure of any kind, so it sold two things it does not
              have; "real-time insights" is the marketing register SLOP-AUDIT
              §B bans; and the plan card behind it is titled Dashboard already.
              This says what is actually behind the gate. */}
          {venueTab === 'analytics' && !can.analytics && (
            <LockedTab requiredTier="premium" featureName="Analytics" description="Crowd forecasts for your venue, today by the hour and a week out, next to the venues around you." />
          )}
          {venueTab === 'analytics' && can.analytics && (<>
          {/* No linked listing / loading states.
              Same failure class as the Map tab's, so it gets the Map tab's
              treatment: a headline that names the state, the server's own
              sentence underneath saying why, and a retry ONLY where retrying
              can change the answer. An unverified venue and a missing listing
              are settled facts, and a Try again under either is a button that
              lies. This card used to be the server's sentence set in bold and
              nothing else, one screen away from the better version. */}
          {venueIntel && !venueIntel.available && (
            <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '16px', marginBottom: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
              {/* Cobalt Birdie: the forecast is Flock's read on the room,
                  not the owner's own copy, so it gets the Flock bird. */}
              <BirdieStill size={64} style={{ marginBottom: '8px' }} />
              <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: '0 0 6px' }}>
                {venueIntel.unverified ? (venueVerificationPending ? 'Verification requested' : "Your venue isn't verified yet")
                  : venueIntel.code === 'load_failed' || venueIntel.code === 'lookup_failed' ? "The forecast couldn't load"
                  : 'No forecast for your venue yet'}
              </p>
              {/* The server writes this sentence and it is state-aware, so it
                  already says the right thing for un-requested and for pending.
                  A successful press swaps in the response's own message until
                  the next load, because the reason in hand was written for the
                  state the press just left. */}
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>{verificationRequestNote || venueIntel.reason || 'Nothing we track grounds a forecast for your venue so far.'}</p>
              {(venueIntel.code === 'load_failed' || venueIntel.code === 'lookup_failed') && (
                <button className="hit44" onClick={retryVenueIntel} style={{ marginTop: '10px', padding: '8px 14px', borderRadius: '8px', border: '1.5px solid var(--border-default)', backgroundColor: 'transparent', color: 'var(--text-secondary)', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer' }}>
                  Try again
                </button>
              )}
              {/* The way out of the dead end. No button once the request is in:
                  the state is settled from the owner's side, and a button there
                  would be the same instruction with nothing behind it. Same
                  rule as the Try again above, which only appears where trying
                  again can change the answer. */}
              {venueIntel.unverified && !venueVerificationPending && !verificationRequestNote && (
                <button
                  className="hit44"
                  onClick={handleRequestVerification}
                  disabled={verificationRequestBusy}
                  style={{ marginTop: '10px', padding: '8px 14px', borderRadius: '8px', border: '1.5px solid var(--border-default)', backgroundColor: 'transparent', color: 'var(--text-secondary)', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: verificationRequestBusy ? 'default' : 'pointer', opacity: verificationRequestBusy ? 0.55 : 1 }}
                >
                  Request verification
                </button>
              )}
              {venueIntel.unverified && verificationRequestError && (
                <p style={{ fontSize: 'var(--t-meta)', color: colors.redText, margin: '8px 0 0', lineHeight: 1.5 }}>{verificationRequestError}</p>
              )}
            </div>
          )}
          {!venueIntel && (
            <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '16px', marginBottom: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
              <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-secondary)', margin: 0 }}>Building your forecast...</p>
            </div>
          )}

          {/* Key metrics — all computed, none invented */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px', marginBottom: '12px' }}>
            <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
              <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-secondary)', margin: 0, textTransform: 'uppercase' }}>Right Now</p>
              <p style={{ fontSize: 'var(--t-display)', fontWeight: '600', color: intelReady && venueIntel.now.score > 84 ? colors.red : colors.steel, margin: '4px 0 0' }}>{intelReady ? `${venueIntel.now.score}` : '–'}</p>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0' }}>{intelReady ? venueIntel.now.label : ''}</p>
            </div>
            <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
              <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-secondary)', margin: 0, textTransform: 'uppercase' }}>Tonight's Peak</p>
              <p style={{ fontSize: 'var(--t-display)', fontWeight: '600', color: colors.navy, margin: '4px 0 0' }}>{tonightPeak ? tonightPeak.score : '–'}</p>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0' }}>{tonightPeak ? `around ${tonightPeak.hour}` : ''}</p>
            </div>
            <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
              <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-secondary)', margin: 0, textTransform: 'uppercase' }}>Groups Eyeing You</p>
              {/* A read that never landed is not zero. The other three tiles on
                  this grid already print '–' when the model has nothing to say;
                  this one printed a confident 0 for a request that 403'd or
                  timed out, and 0 here is the number a venue would act on. */}
              <p style={{ fontSize: 'var(--t-display)', fontWeight: '600', color: colors.navy, margin: '4px 0 0' }}>{(venueListErrors.incomingFlocks || venueListErrors.incomingFlocksLocked) ? '–' : realIncomingFlocks.length}</p>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0' }}>flocks with you in their vote</p>
            </div>
            <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
              <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-secondary)', margin: 0, textTransform: 'uppercase' }}>Biggest Night Ahead</p>
              <p style={{ fontSize: 'var(--t-display)', fontWeight: '600', color: colors.navy, margin: '4px 0 0' }}>{weekPeak ? weekPeak.weekday : '–'}</p>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0' }}>{weekPeak ? `projected ${weekPeak.peakScore} at ${weekPeak.peakHour}` : ''}</p>
            </div>
          </div>

          {/* This week — deterministic counts from the venue's own rows. No
              model, no estimates: every line is a SQL aggregate and says where
              it came from, because a made-up figure on this tab has already
              been deleted once (2026-08-14). */}
          {venueThisWeek?.available && (() => {
            const tw = venueThisWeek;
            const levelWord = (lvl) => (lvl == null ? null : lvl < 1.7 ? 'quiet' : lvl < 2.4 ? 'moderate' : 'busy');
            const rows = [
              {
                key: 'groups',
                main: `${tw.groupsConsidering.thisWeek} group${tw.groupsConsidering.thisWeek === 1 ? '' : 's'} had you in a venue vote`,
                sub: `${tw.groupsConsidering.lastWeek} the week before. From ${tw.groupsConsidering.source}.`,
              },
              {
                key: 'reports',
                main: `${tw.crowdReports.thisWeek} crowd report${tw.crowdReports.thisWeek === 1 ? '' : 's'} from people at your venue`
                  + (tw.crowdReports.avgLevel != null ? `, averaging ${levelWord(tw.crowdReports.avgLevel)}` : ''),
                sub: `${tw.crowdReports.lastWeek} the week before. From ${tw.crowdReports.source}.`,
              },
              {
                key: 'reviews',
                main: `${tw.reviews.thisWeek} new review${tw.reviews.thisWeek === 1 ? '' : 's'}`
                  + (tw.reviews.avgRating != null ? `, ${tw.reviews.avgRating} stars on average` : ''),
                sub: `From ${tw.reviews.source}.`,
              },
              {
                key: 'readings',
                main: `${tw.yourReadings.thisWeek} live number${tw.yourReadings.thisWeek === 1 ? '' : 's'} set by you`
                  + (tw.yourReadings.medianPercent != null ? `, median ${tw.yourReadings.medianPercent}%` : ''),
                sub: `From ${tw.yourReadings.source}.`,
              },
            ];
            return (
              <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 4px' }}>This Week</h3>
                <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '0 0 8px' }}>Last {tw.windowDays} days. Counted from your venue's own activity, nothing modeled.</p>
                {rows.map((r, i) => (
                  <div key={r.key} style={{ padding: '8px 0', borderTop: i === 0 ? 'none' : '1px solid var(--border-light)' }}>
                    <p style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: colors.navy, margin: 0 }}>{r.main}</p>
                    <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: '2px 0 0' }}>{r.sub}</p>
                  </div>
                ))}
              </div>
            );
          })()}
          {venueThisWeek && !venueThisWeek.available && venueThisWeek.locked && (
            <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
              <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 4px' }}>This Week</h3>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>The weekly summary is a Pro feature.</p>
            </div>
          )}

          {/* Roost — the advisor's T0 cards, directly under the weekly
              summary they extend. Fetching is the component's own job so the
              dashboard's effect stays one read per panel; the props are
              things this screen already holds, so the cards cost no extra
              request. The live reading is passed through, which is what
              makes the slider's effect visible on the readings card the
              moment the owner sets it. */}
          <VenueInsightCards
            fetchCards={getVenueAdvisorCards}
            colors={colors}
            intel={venueIntel}
            liveReading={venueBusyNow?.live || null}
            operatingHours={operatingHours}
            /* Roost's refusals name venue settings as the thing that fills the
               blank. The tab is in the strip above them, which the owner has
               to already know to act on the sentence they just read, so the
               card gets the door and this is the far side of it. */
            onOpenSettings={() => setVenueTab('settings')}
            /* NO VERIFICATION BUTTON HERE, AS OF 2026-09-01. This card used
               to carry a second "Request verification" off the same handler
               as the intel card at the top of this tab, so an unverified
               premium owner opened Analytics to the button twice within one
               scroll. Jayden's TestFlight note (2026-08-21) was precisely
               that the screen said it too many times. Both cards render
               under the same `can.analytics` gate, so the intel card's copy
               is always on screen whenever this one would have been: one ask
               per screen, and it lives one card up. The card still prints
               the server's reason sentence, which is the answer to "why are
               there no cards", and with no handler it draws no button. */
          />
          {/* Roost chat: suggested questions, plus a field the owner can type into.
              Grounded answers come from the same fact engine as the cards above;
              advice is labeled as advice; anything else is refused. */}
          <VenueAdvisorChat fetchQuestions={getAdvisorQuestions} ask={askAdvisor} askQuestion={askAdvisorQuestion} colors={colors} />

          {/* Week ahead — projected peak per evening */}
          {intelReady && venueIntel.week?.length > 0 && (
            <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
              <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Week Ahead (projected evening peak)</h3>
              {(() => {
                // A busy venue's projected evenings all land in one band, and
                // this chart used to colour by band alone (>70 red, >45 amber,
                // else steel) with its own thresholds. So a real week of 73,
                // 75, 84, 85 came out as six identical saturated red blocks:
                // it read as an error state rather than a chart, and the one
                // thing a week view exists to show — which evening is the big
                // one — was the only thing it could not show.
                //
                // Two changes. The HUE now comes from the shared crowd bands,
                // the same green/amber/red scale as the card, the hour bars
                // and the map pins, because 78 has to mean the same thing on
                // every surface of this app. And the WEIGHT differentiates
                // inside whatever range the week actually occupies: the
                // quietest projected evening is drawn faintest, the busiest at
                // full strength, so twelve points of spread is twelve points
                // of visible spread.
                //
                // Heights stay proportional to the score from zero, and the
                // number under each bar is still printed, so the ramp adds a
                // reading order without exaggerating any gap.
                //
                // The colour is `crowdColorDeepFor`, not the standard weight:
                // six bars this size are most of the card, and the standard
                // red at that area read as a warning light. The floor of the
                // opacity ramp came up to match, so the QUIETEST bar of the
                // week is now about as heavy as the busiest one used to be and
                // the busiest is heavier still. Differentiation is unchanged —
                // it is the same linear map over the same lo→hi range, just
                // run over a narrower, darker span.
                //
                // Layout: the bar sits in a fixed-height well and the two
                // labels sit BELOW that well, in flow. It used to be one
                // bottom-aligned column inside a 60px row, so a column of
                // bar + weekday + score (81px at 390px wide) hung 21px out of
                // the top of its own row, and a bar is painted after the
                // heading: six red blocks landed across the lower half of
                // "Week Ahead (projected evening peak)" and cut the words in
                // two. Nothing here has a fixed height it can overflow now.
                // The row is as tall as the well plus the labels, the card
                // grows to hold it (+40px), and the heading keeps the 10px it
                // always asked for.
                const scores = venueIntel.week
                  .map((d) => d.peakScore)
                  .filter((s) => Number.isFinite(s));
                const lo = scores.length ? Math.min(...scores) : 0;
                const hi = scores.length ? Math.max(...scores) : 0;
                const weightFor = (s) => {
                  if (!Number.isFinite(s)) return WEEK_BAR_WEIGHT_MIN;
                  if (hi === lo) return 1;
                  return WEEK_BAR_WEIGHT_MIN + (1 - WEEK_BAR_WEIGHT_MIN) * ((s - lo) / (hi - lo));
                };
                return (
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'flex-end' }}>
                    {venueIntel.week.map((d) => (
                      <div key={d.date} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <div style={{ width: '100%', height: `${WEEK_BAR_WELL_PX}px`, display: 'flex', alignItems: 'flex-end' }}>
                          <div style={{ width: '100%', height: `${Math.min(WEEK_BAR_WELL_PX, Math.max(3, (d.peakScore || 0) * 0.55))}px`, backgroundColor: crowdColorDeepFor(d.peakScore) || 'var(--border-mid)', opacity: weightFor(d.peakScore), borderRadius: '4px 4px 0 0' }} />
                        </div>
                        <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', marginTop: '4px' }}>{d.weekday}</span>
                        <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>{d.peakScore ?? '–'}</span>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          )}

          {/* The strip — you vs the venues around you, tonight. Google's
              busyness chart can't do this: per-venue, read-only, no API. */}
          {venueStrip?.available && (
            <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
              <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Your Strip Tonight</h3>
              {[{ ...venueStrip.you, you: true }, ...venueStrip.competitors].map((v, i) => (
                <div key={`${v.name}-${i}`} style={{ padding: '6px 0', borderTop: i === 0 ? 'none' : '1px solid var(--border-light)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ flex: 1, fontSize: 'var(--t-meta)', fontWeight: v.you ? '500' : '500', color: colors.navy, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.you ? `${v.name} (you)` : v.name}</span>
                    {/* A rule-engine number is a category-typical figure, the
                        same for every venue of its kind. It shows, labeled,
                        and the server never draws a ranking against it. */}
                    {v.method && v.method !== 'ml' && (
                      <span style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', flexShrink: 0 }}>typical for its category</span>
                    )}
                    <span style={{ width: '80px', height: '6px', borderRadius: '3px', backgroundColor: 'var(--bg-hover)', overflow: 'hidden', flexShrink: 0 }}>
                      <span style={{ display: 'block', height: '100%', width: `${Math.min(100, v.peakScore || 0)}%`, backgroundColor: v.you ? colors.steel : 'var(--text-tertiary)', borderRadius: '3px' }} />
                    </span>
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, width: '26px', textAlign: 'right', flexShrink: 0 }}>{v.peakScore ?? '–'}</span>
                  </div>
                  {/* An ordering sentence only when the server drew one — it
                      refuses below its published gap, because pairwise order
                      at small gaps measured worse than a coin flip. */}
                  {v.orderingClaim && (
                    <p style={{ fontSize: 'var(--t-micro)', color: v.orderingClaim === 'busier' ? 'var(--accent-red-text)' : 'var(--accent-green-text)', margin: '2px 0 0' }}>
                      Projected {v.orderingClaim} than you tonight
                    </p>
                  )}
                </div>
              ))}
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '8px 0 0' }}>
                Projected evening peaks within 1.5 km, from Flock's crowd model.
                {venueStrip.orderingMinGap ? ` Venues within ${venueStrip.orderingMinGap} points are too close to rank.` : ''}
              </p>
            </div>
          )}

          {/* Embeddable live badge — free marketing for them, distribution for us */}
          {intelReady && venueProfile?.google_place_id && (
            <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
              <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 6px' }}>Live Badge for Your Website</h3>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.5 }}>A live "how busy is it" badge, updated every 15 minutes by Flock's crowd model. Paste this where your site's HTML goes:</p>
              <button className="hit44"
                onClick={async () => {
                  const snippet = `<img src="${BASE_URL}/api/badge/${venueProfile.google_place_id}.svg" alt="How busy is ${venueData.name}? Live from Flock" height="36">`;
                  try { await navigator.clipboard.writeText(snippet); showToast('Embed code copied'); } catch { showToast('Could not copy', 'error'); }
                }}
                style={{ width: '100%', padding: '10px', borderRadius: '10px', border: `1.5px dashed ${colors.steel}`, backgroundColor: 'transparent', color: colors.steel, fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer' }}
              >
                Copy embed code
              </button>
            </div>
          )}

          {/* Live Sensor — only renders if a Pi is deployed for this venue */}
          {ownerSensorData?.sensor_data && (() => {
            const sd = ownerSensorData.sensor_data;
            // Today's IR total = sum of ir_beam_count for readings whose recorded_at is "today"
            const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
            const todaysIr = ownerSensorHistory
              .filter(r => new Date(r.recorded_at) >= todayStart)
              .reduce((sum, r) => sum + (r.ir_beam_count || 0), 0);
            // See the venue sheet's copy of this: a non-numeric reading used to
            // fall through every comparison and get labelled "Loud".
            const noiseDb = Number(sd.noise_db);
            const noiseLabel = !Number.isFinite(noiseDb) ? null
              // Same split as the sensor card above: fill vs type.
              : noiseDb < 50 ? { text: 'Quiet', color: colors.steel, ink: colors.steel }
              : noiseDb < 70 ? { text: 'Moderate', color: colors.amber, ink: colors.amberText }
              : noiseDb < 85 ? { text: 'Lively', color: colors.food, ink: colors.foodText }
              : { text: 'Loud', color: colors.red, ink: colors.redText };
            const lastSeenMin = sd.recorded_at ? Math.round((Date.now() - new Date(sd.recorded_at).getTime()) / 60000) : Infinity;
            // 15 matches CURRENT_READING_MAX_AGE_MINUTES in routes/sensors.js,
            // the window the occupancy card itself uses. This used to say 5,
            // so for ten minutes out of every gap the owner's panel called a
            // sensor Offline while the consumer card was still showing its
            // reading as live. GET /status returns online_within_minutes
            // precisely so no client has to carry this constant; wire that in
            // when this panel next grows a fetch.
            const online = lastSeenMin < 15;
            const max24 = Math.max(1, ...ownerSensorHistory.map(r => r.thermal_headcount || 0));
            return (
              <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '14px', marginBottom: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                    <span className="flock-pulse-dot" style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: '#10b981', display: 'inline-block' }} />
                    <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: 0 }}>Live Sensor</h3>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', padding: '2px 8px', borderRadius: '8px', backgroundColor: online ? 'var(--accent-green-bg)' : 'var(--accent-red-bg)', color: online ? 'var(--accent-green-text)' : 'var(--accent-red-text)' }}>{online ? 'Online' : 'Offline'}</span>
                    {/* A sensor that has never reported has no timestamp, which
                        made lastSeenMin Infinity and printed "last seen Infinity
                        min ago". Same guard as the break-even figure. */}
                    <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }}>{!Number.isFinite(lastSeenMin) ? 'never reported' : lastSeenMin === 0 ? 'last seen just now' : `last seen ${lastSeenMin} min ago`}</span>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px', marginBottom: '12px' }}>
                  <div>
                    {/* "In View Now", not "Currently Inside": the number is
                        a heat-cluster count in one doorway camera's field of
                        view, uncalibrated against a real room count. The
                        sensor's own display already says "In view now" for
                        exactly this reason (main.py display loop), and a
                        venue owner quoting an occupancy figure to a fire
                        marshal is the conversation that copy was going to
                        start. SLOP rule 5: never claim more than the build
                        measures. */}
                    <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-secondary)', margin: 0, textTransform: 'uppercase' }}>In View Now</p>
                    <p style={{ fontSize: 'var(--t-display)', fontWeight: '600', color: colors.navy, margin: '4px 0 0', lineHeight: 1 }}>~{sd.thermal_headcount}</p>
                  </div>
                  <div>
                    <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-secondary)', margin: 0, textTransform: 'uppercase' }}>Noise Level</p>
                    {/* No dB figure here either, and for the venue owner it
                        matters more: a number with a unit on an operator's
                        dashboard is the kind of thing that ends up in a noise
                        complaint or a licence conversation. See the copy of
                        this card in the venue sheet. */}
                    {noiseLabel ? (
                      <p style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: noiseLabel.ink, margin: '4px 0 0', lineHeight: 1 }}>
                        {noiseLabel.text}
                      </p>
                    ) : <p style={{ fontSize: 'var(--t-label)', color: 'var(--text-tertiary)', margin: '4px 0 0' }}>No reading yet</p>}
                  </div>
                  <div>
                    <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-secondary)', margin: 0, textTransform: 'uppercase' }}>Today's Door Count</p>
                    <p style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '4px 0 0' }}>{todaysIr}</p>
                  </div>
                  <div>
                    <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-secondary)', margin: 0, textTransform: 'uppercase' }}>Last Hour Check-ins</p>
                    <p style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '4px 0 0' }}>{ownerSensorData.recent_checkins || 0}</p>
                  </div>
                </div>

                {ownerSensorHistory.length > 0 && (() => {
                  // Build 24 hourly slots, anchored to "now". Match API rows by
                  // hour-truncated timestamp so the chart actually represents
                  // 24 hours of wall-clock time, not 24 raw readings.
                  const hourMs = (ts) => { const d = new Date(ts); d.setMinutes(0, 0, 0); return d.getTime(); };
                  const nowD = new Date();
                  const currentHour = hourMs(nowD);
                  const slotMs = 60 * 60 * 1000;
                  const slots = Array.from({ length: 24 }, (_, idx) => {
                    const slotTs = currentHour - (23 - idx) * slotMs;
                    return ownerSensorHistory.find(r => hourMs(r.recorded_at) === slotTs) || null;
                  });
                  return (
                    <div>
                      <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', margin: '0 0 6px', textTransform: 'uppercase' }}>Last 24 Hours</p>
                      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: '52px' }}>
                        {slots.map((r, i) => {
                          if (!r) {
                            return <div key={i} style={{ flex: 1, height: '4px', borderRadius: '2px', background: 'repeating-linear-gradient(45deg, var(--border-subtle), var(--border-subtle) 2px, transparent 2px, transparent 4px)', opacity: 0.5 }} />;
                          }
                          const h = Math.max(2, Math.round((r.thermal_headcount / max24) * 48));
                          return <div key={i} style={{ flex: 1, height: `${h}px`, borderRadius: '2px', backgroundColor: colors.navy, opacity: 0.85 }} />;
                        })}
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })()}

          {/* Post a Deal */}
          <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: 'var(--card-shadow-sm)', position: 'relative' }}>
            <h3 style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.zap(colors.amber, 14)} Post a Deal</h3>
            <SearchInputLocal aria-label="Deal description"
              type="text"
              initialValue={dealDescription}
              onCommit={setDealDescription}
              placeholder="e.g., 2-for-1 drinks until 8pm"
              style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, fontSize: 'var(--t-meta)', marginBottom: '8px', boxSizing: 'border-box', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
              disabled={!can.postDeals}
            />
            <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
              {['Happy Hour', 'Late Night', 'Weekend', 'All Day'].map(slot => (
                <button key={slot} className="hit44 glass-btn glass-secondary" onClick={() => setDealTimeSlot(slot)} style={{ padding: '6px 10px', borderRadius: '16px', border: `1px solid ${dealTimeSlot === slot ? colors.navy : colors.creamDark}`, backgroundColor: dealTimeSlot === slot ? colors.navyBg : 'var(--bg-card-solid)', color: dealTimeSlot === slot ? 'white' : colors.navy, fontSize: 'var(--t-meta)', fontWeight: '500', cursor: 'pointer' }} disabled={!can.postDeals}>
                  {slot}
                </button>
              ))}
            </div>
            <button className="hit44" onClick={async () => {
              if (!dealDescription.trim()) return;
              try {
                const created = await createVenuePromotion({
                  title: dealDescription.trim(),
                  description: dealDescription.trim(),
                  timeSlot: dealTimeSlot,
                  days: 'Daily',
                });
                setPromotions(prev => [created, ...prev]);
                setDealDescription('');
                showToast('Deal posted. It is on your venue card now.', 'success');
                setVenueTab('promotions');
              } catch (e) {
                console.error('Post deal failed:', e);
                showToast(e?.message || "That deal didn't post. Try again.", 'error');
              }
            }} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: 'none', background: colors.navyMidBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer' }} disabled={!can.postDeals || !dealDescription.trim()}>
              Post Deal
            </button>
            {/* Same mark as LockedTab above. A shield here and a padlock there
                read as two different states of two different things, on one
                tab, both meaning "your plan does not include this". */}
            {!can.postDeals && <div style={{ position: 'absolute', inset: 0, backgroundColor: 'var(--locked-overlay)', borderRadius: '12px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>{Icons.lock(colors.textTertiary, 24)}<span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', marginTop: '4px' }}>Premium Feature</span></div>}
          </div>

          {/* Today, hour by hour — from the model */}
          {intelReady && venueIntel.todayHourly?.length > 0 && (
            <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
              <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Today, Hour by Hour</h3>
              {/* Three fixes, all measured in a browser at 375px.
                  The bar sits in a fixed well and the hour label sits under
                  that well in flow, so no box here has a height its contents
                  can exceed (the Week Ahead defect, one card up, on its
                  sibling chart). The row aligns to flex-START, because only
                  every third column carries a label: bottom-aligning columns
                  of two different heights put their bars on two different
                  baselines. And `minWidth: 0` lets the labelled columns shrink
                  like the rest — without it the nowrap hour label sets a
                  min-content floor and every third bar drew 28px wide next to
                  9px neighbours, which is a comb with three teeth missing.
                  Colour comes from the shared crowd scale rather than the
                  70/45 cutoffs that used to live here: those were a third set
                  of thresholds, so a 65 read amber on this chart and red on
                  the map pin for the same venue at the same minute. It takes
                  the DEEP weight, the same as the Week Ahead chart one card
                  up, for two reasons beyond matching it. The standard weight
                  is raw hex (#22C55E for a quiet hour), which measures 2.3:1
                  against a white card and so fails the 3:1 that WCAG asks of a
                  graphic carrying meaning; --accent-green-text is 5.87:1. And
                  the standard weight is a single light-mode value, while the
                  accent tokens are already resolved per theme, so the strip
                  stays legible on the dark card instead of sinking into it. */}
              <div style={{ display: 'flex', gap: '3px', alignItems: 'flex-start' }}>
                {venueIntel.todayHourly.map((h, i) => (
                  <div key={i} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div style={{ width: '100%', height: `${HOUR_BAR_WELL_PX}px`, display: 'flex', alignItems: 'flex-end' }}>
                      <div style={{ width: '100%', height: `${Math.min(HOUR_BAR_WELL_PX, Math.max(2, (h.score || 0) * 0.5))}px`, backgroundColor: crowdColorDeepFor(h.score) || 'var(--border-mid)', borderRadius: '2px' }} />
                    </div>
                    {i % 3 === 0 && <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', marginTop: '4px', whiteSpace: 'nowrap' }}>{h.hour}</span>}
                  </div>
                ))}
              </div>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '8px 0 0' }}>
                {venueIntel.model ? `Flock crowd model v${venueIntel.model}` : 'Flock rule engine (model learns your venue as data arrives)'}
              </p>
            </div>
          )}

          {/* Upgrade Button (if not Pro) */}
          {venueTier !== 'pro' && (
            <button className="hit44 glass-btn glass-primary" onClick={() => setShowUpgradeModal(true)} style={{ width: '100%', padding: '14px', borderRadius: '12px', border: 'none', background: '#2d5a87', color: 'white', fontWeight: '600', fontSize: 'var(--t-body)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', boxShadow: '0 4px 12px rgba(45,90,135,0.3)' }}>
              {/* Icons.sparkles was here. Two things wrong with it: the glyph is
                  two stacked gull marks, which at 18px reads as a double caret
                  (scroll-to-top), not as a sparkle; and a sparkle on a paid
                  upgrade button is the 2023 AI-product tic SLOP-AUDIT exists to
                  catch. The button is the only thing on this row and the
                  sentence already says what it does, so it needs no mark. */}
              Upgrade to {venueTier === 'free' ? 'Premium' : 'Pro'}
            </button>
          )}
          </>)}

          {/* PROMOTIONS TAB */}
          {venueTab === 'promotions' && !can.postDeals && (
            <LockedTab requiredTier="premium" featureName="Deals" description="Post a deal and it shows on your venue card in the app for as long as you leave it up." />
          )}
          {venueTab === 'promotions' && can.postDeals && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Create New Promotion Button */}
              <button className="hit44 glass-btn glass-navy" onClick={() => openPromoModal()} style={{ width: '100%', padding: '14px', borderRadius: '12px', border: 'none', background: colors.navyMidBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-body)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                {Icons.plus('white', 18)} Create Promotion
              </button>

              {/* Your Promotions. NOT "Active Promotions" any more: a
                  moderation-hidden promotion is in this list (deliberately, so
                  the owner is not left staring at one that vanished with no
                  reason given) and it is the opposite of active. The heading
                  counted it as active and the row was styled as if it were
                  running. */}
              <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Your Promotions ({promotions.length})</h3>
                {/* A BANNER, not a replacement for the list. The failed read
                    leaves whatever was already loaded on screen, and a
                    promotion created after the failure still renders — hiding
                    it behind the error would be the same lie in the other
                    direction. Only the "create your first one" empty state is
                    suppressed, because that is the line that is not true. */}
                {venueListErrors.promotions && (
                  <div style={{ padding: '10px', marginBottom: '8px', borderRadius: '8px', backgroundColor: 'var(--bg-tertiary)' }}>
                    <BirdNote
                      layout="row"
                      size={48}
                      bird={WARM_BIRD}
                      body="We couldn't load your promotions. Nothing has been deleted."
                      action={<button className="hit44" onClick={() => loadVenuePromotions()} style={{ padding: '8px 16px', borderRadius: '8px', border: '1px solid var(--border-mid)', backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer' }}>Try again</button>}
                    />
                  </div>
                )}
                {promotions.length === 0 ? (
                  venueListErrors.promotions ? null : (
                    // The warm bird, because promotions are the owner's own
                    // space (cobalt Birdie marks the states about Flock users,
                    // like the incoming-flocks card). Genuine-empty only: the
                    // failed-read branch above stays bird-free — a mascot on
                    // an error would dress the failure up as an empty list.
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '14px 0 4px' }}>
                      <BirdieStill bird={WARM_BIRD} size={84} />
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', textAlign: 'center', margin: 0, padding: '10px 0 12px' }}>No promotions yet. Create your first one!</p>
                    </div>
                  )
                ) : promotions.map(promo => {
                  const hidden = isModerationHidden(promo);
                  return (
                  <div key={promo.id} style={{ padding: '10px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '8px', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1 }}>
                        <h4 style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: 0 }}>{promo.title}</h4>
                        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0' }}>{promo.description || promo.desc}</p>
                        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: 0 }}>{promo.time_slot || promo.time} - {promo.days}</p>
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        {/* No Edit on a hidden promotion. PUT /promotions/:id
                            answers 409 CONTENT_HIDDEN on one, so the button
                            could only ever open a form, take everything the
                            owner typed, and refuse it on Save. A control that
                            cannot succeed does not render; the notice below
                            says why and names the two things that do work. */}
                        {!hidden && (
                          <button aria-label="Edit" className="hit44" onClick={() => openPromoModal(promo)} style={{ padding: '6px', borderRadius: '6px', border: 'none', backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer' }}>{Icons.edit(colors.navy, 14)}</button>
                        )}
                        <button aria-label="Delete" className="hit44" onClick={() => deletePromo(promo.id)} style={{ padding: '6px', borderRadius: '6px', border: 'none', backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer' }}>{Icons.trash(colors.red, 14)}</button>
                      </div>
                    </div>
                    {hidden && <ModerationHiddenNotice kind="promotion" />}
                    {/* "N claims" was removed 2026-08-14. venue_promotions.claims
                        is written by nothing in the repo — no route, no socket
                        handler, no job — so it was DEFINITIONALLY 0 on every
                        promotion ever created, and the owner being asked to pay
                        for this dashboard was reading it as "nobody redeemed
                        this". Same rule as the Pro Tips box below: a number that
                        cannot move is fabricated data, and it gets cut rather
                        than dressed up. Views stays because it is genuinely
                        counted (venueDashboard.js increments it when a non-owner
                        is served the venue's promotions). Bring claims back the
                        day something actually records a redemption. */}
                    <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        {Icons.eye(colors.textSecondary, 12)}
                        <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>{promo.views || 0} views</span>
                      </div>
                    </div>
                  </div>
                  );
                })}
              </div>

              {/* The "Pro Tips" box was deleted 2026-08-14. It advised that
                  "Happy Hour promos get 3x more engagement" and that weekend
                  promos should be posted by Thursday. Nothing in Flock measures
                  either claim, and the venue owner reading it is the person
                  being asked to pay. Same rule as the fake venue analytics tab
                  (SLOP-AUDIT §H13): invented numbers get cut, not softened.
                  The views count above is real, and once there are enough of
                  them the tips can come back as measurements. */}
            </div>
          )}

          {/* EVENTS TAB */}
          {/* The old description sold "capacity tracking and RSVPs" and this
              one first said events "show up on your venue card". Neither is
              true. Nothing in Flock lets anyone RSVP to a venue event, the
              column that would count them is never written, and venue_events
              has no public read at all: GET /api/venue-dashboard/events is the
              only route that returns them and it is owner-only. What is behind
              this lock today is the incoming-flocks feed, which is real. The
              description names that and nothing else. */}
          {venueTab === 'events' && !can.events && (
            <LockedTab requiredTier="premium" featureName="Event Promotion" description="See which flocks are heading your way, and keep your upcoming events in one list." />
          )}
          {venueTab === 'events' && can.events && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Create Event Button */}
              <button className="hit44 glass-btn glass-navy" onClick={() => openEventModal()} style={{ width: '100%', padding: '14px', borderRadius: '12px', border: 'none', background: colors.navyMidBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-body)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                {Icons.plus('white', 18)} Create Event
              </button>

              {/* Incoming Flocks */}
              <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                <h3 style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.users(colors.steel, 14)} Incoming Flocks</h3>
                {/* Banner above the list, never instead of it — same rule as
                    the promotions and events tabs. */}
                {venueListErrors.incomingFlocks && (
                  <div style={{ padding: '10px', marginBottom: '8px', borderRadius: '8px', backgroundColor: 'var(--bg-tertiary)' }}>
                    <BirdNote
                      layout="row"
                      size={48}
                      bird={BIRDIE}
                      body="We couldn't load the flocks heading your way."
                      action={<button className="hit44" onClick={() => loadIncomingFlocks()} style={{ padding: '8px 16px', borderRadius: '8px', border: '1px solid var(--border-mid)', backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer' }}>Try again</button>}
                    />
                  </div>
                )}
                {/* A plan refusal, which is not a failure. No "Try again": the
                    server will refuse the retry identically until the plan
                    changes, so the control offered is the one that can work. */}
                {venueListErrors.incomingFlocksLocked && (
                  <div style={{ padding: '10px', marginBottom: '8px', borderRadius: '8px', backgroundColor: 'var(--bg-tertiary)' }}>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 8px' }}>The incoming-flocks feed is part of the Premium plan. Your current plan doesn't include it.</p>
                    <button className="hit44" onClick={() => setShowUpgradeModal(true)} style={{ padding: '8px 16px', borderRadius: '8px', border: 'none', backgroundColor: 'var(--accent-amber-text)', color: 'white', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer' }}>See plans</button>
                  </div>
                )}
                {incomingFlocks.length > 0 ? incomingFlocks.map(flock => (
                  <div key={flock.id} style={{ padding: '10px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '8px', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <h4 style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: 0 }}>{flock.title || flock.name}</h4>
                        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0' }}>{memberCountLabel(flock)}{flock.date ? ` - ${new Date(flock.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}` : ''}{flock.time ? ` ${flock.time}` : ''}</p>
                      </div>
                      <span style={{ padding: '4px 8px', borderRadius: '12px', backgroundColor: flock.status === 'confirmed' ? colors.steel : colors.amber, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '500' }}>
                        {flock.status === 'confirmed' ? 'Confirmed' : 'Active'}
                      </span>
                    </div>
                  </div>
                )) : (
                  // Only the empty-state SENTENCE is suppressed, because it is
                  // the part that is not true when nothing was ever read.
                  // Cobalt Birdie on the genuine-empty: this card is about
                  // Flock users, and he is their bird. The "Your Events" card
                  // below shares this screen and stays bird-free on purpose —
                  // one mark per screen, and this is the card about people.
                  (venueListErrors.incomingFlocks || venueListErrors.incomingFlocksLocked) ? null : (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '14px 0 4px' }}>
                      <BirdieStill size={84} />
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', textAlign: 'center', margin: 0, padding: '10px 0 12px' }}>No incoming flocks yet</p>
                    </div>
                  )
                )}
              </div>

              {/* Your Events */}
              <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                <h3 style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.calendar(colors.navy, 14)} Your Events ({venueEventsList.length})</h3>
                {/* Said plainly because an owner typing in an event has every
                    reason to assume it reaches somebody. It does not: there is
                    no public read of venue_events anywhere in the backend.
                    Delete this line the day one ships. */}
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '0 0 10px' }}>Only you can see these. We are not showing them to Flock users yet.</p>
                {/* Banner, not a replacement for the list — same reasoning as
                    the promotions tab above. */}
                {venueListErrors.events && (
                  <div style={{ padding: '10px', marginBottom: '8px', borderRadius: '8px', backgroundColor: 'var(--bg-tertiary)' }}>
                    <BirdNote
                      layout="row"
                      size={48}
                      bird={WARM_BIRD}
                      body="We couldn't load your events. Nothing has been deleted."
                      action={<button className="hit44" onClick={() => loadVenueEvents()} style={{ padding: '8px 16px', borderRadius: '8px', border: '1px solid var(--border-mid)', backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer' }}>Try again</button>}
                    />
                  </div>
                )}
                {venueEventsList.length === 0 ? (
                  venueListErrors.events ? null : (
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', textAlign: 'center', padding: '20px' }}>No events yet. Create your first one!</p>
                  )
                ) : venueEventsList.map(event => {
                  const hidden = isModerationHidden(event);
                  return (
                  <div key={event.id} style={{ padding: '10px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '8px', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1 }}>
                        <h4 style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: 0 }}>{event.title}</h4>
                        <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0' }}>{[event.date, event.time].filter(Boolean).join(' at ')}</p>
                        {event.capacity ? <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: 0 }}>Capacity {event.capacity}</p> : null}
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        {/* Same rule as the promotions list: PUT /events/:id
                            answers 409 CONTENT_HIDDEN on a taken-down event, so
                            an Edit button on one cannot succeed and does not
                            render. Delete still works on a hidden row, which is
                            why it stays. */}
                        {!hidden && (
                          <button aria-label="Edit" className="hit44" onClick={() => openEventModal(event)} style={{ padding: '6px', borderRadius: '6px', border: 'none', backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer' }}>{Icons.edit(colors.navy, 14)}</button>
                        )}
                        <button aria-label="Delete" className="hit44" onClick={() => deleteEvent(event.id)} style={{ padding: '6px', borderRadius: '6px', border: 'none', backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer' }}>{Icons.trash(colors.red, 14)}</button>
                      </div>
                    </div>
                    {hidden && <ModerationHiddenNotice kind="event" />}
                  </div>
                  );
                })}
              </div>

              {/* The "This Week" calendar was deleted 2026-08-14. It rendered
                  the literal numbers 19 through 25 under S-M-T-W-T-F-S, with
                  the last two cells highlighted and dotted, no matter what day
                  it actually was and no matter whether the venue had a single
                  event. It was a mockup that shipped: wrong dates every day of
                  the year except one week in a month it did not name, and
                  "something is on" markers over nothing. It cannot be made real
                  either — venue_events.event_date is a free-text field the
                  owner types ("Friday", "8/15", "next week"), not a date, so
                  there is nothing to place on a grid. Same rule as the claims
                  count and the Pro Tips box: cut, do not soften. */}
            </div>
          )}

          {/* REVIEWS TAB */}
          {venueTab === 'reviews' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Above the rating card and the list, not instead of either, so
                  a partial load still shows what it has. */}
              {venueListErrors.reviews && (
                <div style={{ padding: '10px', borderRadius: '8px', backgroundColor: 'var(--bg-tertiary)' }}>
                  <BirdNote
                    layout="row"
                    size={48}
                    bird={BIRDIE}
                    body="We couldn't load your reviews. Nothing has been deleted."
                    action={<button className="hit44" onClick={() => loadVenueReviews()} style={{ padding: '8px 16px', borderRadius: '8px', border: '1px solid var(--border-mid)', backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer' }}>Try again</button>}
                  />
                </div>
              )}
              {/* Rating Overview */}
              <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                {reviewStats && reviewStats.total > 0 ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                    <div style={{ textAlign: 'center' }}>
                      <p style={{ fontSize: 'var(--t-display)', fontWeight: '600', color: colors.navy, margin: 0 }}>{reviewStats.average}</p>
                      {/* The rating was five aria-hidden icons and nothing else,
                          so a screen reader got the number above and then
                          silence. role="img" on the row carries it once; the
                          glyphs stay decorative rather than announcing
                          "star star star star star". Empty stars move from
                          colors.amber to --star-empty, matching the per-review
                          rows below — the same scale was drawn two ways on one
                          tab. */}
                      <div role="img" aria-label={`${reviewStats.average} out of 5 stars`} style={{ display: 'flex', gap: '2px', justifyContent: 'center', margin: '4px 0' }}>
                        {[1, 2, 3, 4, 5].map(s => <React.Fragment key={s}>{s <= Math.round(reviewStats.average) ? Icons.starFilled(colors.amber, 14) : Icons.star('var(--star-empty)', 14)}</React.Fragment>)}
                      </div>
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>{reviewStats.total} review{reviewStats.total !== 1 ? 's' : ''}</p>
                    </div>
                    <div style={{ flex: 1 }}>
                      {[5, 4, 3, 2, 1].map(rating => (
                        <div key={rating} style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                          <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', width: '12px' }}>{rating}</span>
                          <div style={{ flex: 1, height: '6px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '3px', overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${reviewStats.total > 0 ? (reviewStats.distribution[rating - 1] / reviewStats.total * 100) : 0}%`, backgroundColor: colors.amber, borderRadius: '3px' }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  // Same rule as the other tabs: the failed read suppresses the
                  // sentence, not the card. "No reviews yet" over a read that
                  // never landed is the venue owner's version of being told
                  // their content is gone.
                  venueListErrors.reviews ? (
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: 0, textAlign: 'center', padding: '12px 0' }}>Ratings unavailable right now.</p>
                  ) : (
                    // Warm bird on the true-empty only. The failed-read branch
                    // above stays plain text: "unavailable" is an error, and
                    // the mascot must not make it read like an empty inbox.
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '10px 0 2px' }}>
                      <BirdieStill bird={WARM_BIRD} size={84} />
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, textAlign: 'center', padding: '10px 0 10px' }}>No reviews yet. Reviews from Flock users will appear here.</p>
                    </div>
                  )
                )}
              </div>

              {/* WHY THE REPLY BUTTONS ARE NOT THERE.
                  POST /api/venue-dashboard/reviews/:id/reply refuses an
                  unverified claim outright, and it has to: a reply rides the
                  verified badge on the public venue card, so an unverified
                  claimant writing one would be a stranger speaking as the
                  business. This tab offered the button on every review anyway,
                  so the only thing an unverified owner could do with it was
                  compose a reply, press Send, and get a 403 in a toast. A
                  control whose every press is refused is the dead button
                  SLOP-AUDIT H5 names, and it was one per review.
                  Said once, above the list, instead of failed once per row. */}
              {reviews.length > 0 && !venueIsVerified && (
                <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
                    {venueVerificationPending || verificationRequestNote
                      ? 'Replies go live once your venue is verified. We confirm ownership by hand, and your request is in.'
                      : 'Replies go live once your venue is verified. A reply is published as the business, so we confirm you own it first.'}
                  </p>
                  {renderVerificationAsk()}
                </div>
              )}

              {/* Reviews List */}
              {reviews.length > 0 && (
                <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                  <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Recent Reviews</h3>
                  {reviews.map(review => (
                    <div key={review.id} style={{ padding: '10px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '8px', marginBottom: '8px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: colors.navyBg, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: 'var(--t-meta)', fontWeight: '500' }}>
                            {review.user.charAt(0)}
                          </div>
                          <div>
                            <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, margin: 0 }}>{review.user}</p>
                            {/* Empty stars were colors.disabled (#e5e7eb), which
                                on this white card is 1.2:1 — not merely dim,
                                invisible, so a 2-star review read as a 2-star
                                SCALE. --star-empty is the token for this and it
                                holds up in both themes. 10px was below every
                                size the set is drawn for; 12 is the floor. */}
                            <div role="img" aria-label={`${review.rating} out of 5 stars`} style={{ display: 'flex', gap: '1px' }}>
                              {[1, 2, 3, 4, 5].map(s => <React.Fragment key={s}>{s <= review.rating ? Icons.starFilled(colors.amber, 12) : Icons.star('var(--star-empty)', 12)}</React.Fragment>)}
                            </div>
                          </div>
                        </div>
                        <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)' }}>{review.date}</span>
                      </div>
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '8px 0 0', lineHeight: '1.4' }}>{review.text}</p>
                      {review.reply && (
                        <div style={{ marginTop: '8px', padding: '8px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '8px', border: '1px solid var(--border-default)' }}>
                          <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.steel, margin: '0 0 2px' }}>Owner Reply</p>
                          <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>{review.reply}</p>
                        </div>
                      )}
                      {!review.replied && venueIsVerified && replyingToReview !== review.id && (
                        <button className="hit44 glass-btn glass-secondary" onClick={() => { setReplyingToReview(review.id); setReplyText(''); }} style={{ marginTop: '8px', padding: '6px 10px', borderRadius: '6px', border: `1px solid ${colors.navy}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '500', cursor: 'pointer' }}>
                          Reply
                        </button>
                      )}
                      {replyingToReview === review.id && (
                        <div style={{ marginTop: '8px', display: 'flex', gap: '6px' }}>
                          <SearchInputLocal aria-label="Your reply" initialValue={replyText} onCommit={setReplyText} placeholder="Write your reply..." autoFocus style={{ flex: 1, padding: '6px 10px', borderRadius: '6px', border: `1px solid ${colors.creamDark}`, fontSize: 'var(--t-meta)', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-primary)' }} />
                          <button className="hit44 glass-btn glass-navy" onClick={() => handleReplyToReview(review.id)} style={{ padding: '6px 12px', borderRadius: '6px', border: 'none', backgroundColor: colors.navy, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>Send</button>
                          <button className="hit44 glass-btn glass-secondary" onClick={() => setReplyingToReview(null)} style={{ padding: '6px 8px', borderRadius: '6px', border: `1px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-secondary)', fontSize: 'var(--t-meta)', cursor: 'pointer' }}>Cancel</button>
                        </div>
                      )}
                      {/* A "Replied" badge used to render here, on a condition
                          that asked for a review which HAD been replied to and
                          whose reply text was missing. Both of those fields are
                          derived from the same column a few hundred lines up
                          (the mapper sets one to the boolean of venue_reply and
                          the other to venue_reply itself), so the first implies
                          the second and the condition is false for every row
                          that can exist. The reply itself renders just above,
                          which is the stronger signal anyway. */}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* SETTINGS TAB */}
          {venueTab === 'settings' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* VERIFICATION, and the reason it lives on this tab.
                  Verification is a property of the claim, not of the plan, and
                  no tier gates Settings. It is the one place every owner can
                  reach on any tier and on any state of the profile, which is
                  what the Analytics-only button was not. It also answers a
                  question the dashboard could not answer at all before: an
                  owner had nowhere to look up whether their venue is verified.
                  What it says verification turns on is what the server checks
                  it for, and nothing else: review replies, the live number, and
                  the venue's own forecast. */}
              <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                <h3 style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.shield(colors.navy, 14)} Verification</h3>
                <p style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: colors.navy, margin: '0 0 2px' }}>
                  {venueIsVerified ? 'Verified' : venueVerificationPending ? 'Requested' : 'Not verified yet'}
                </p>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
                  {venueIsVerified
                    ? 'Replies to reviews, your live number and your own forecast are on.'
                    : venueVerificationPending || verificationRequestNote
                      ? 'We confirm ownership by hand. Replies to reviews, your live number and your own forecast turn on once that clears. Nothing more is needed from you.'
                      : 'We confirm you own this venue by hand before replies to reviews, your live number and your own forecast turn on.'}
                </p>
                {renderVerificationAsk()}
              </div>

              {/* Venue Info */}
              <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <h3 style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.building(colors.navy, 14)} Venue Information</h3>
                  {!editingVenueInfo ? (
                    <button className="hit44" onClick={() => setEditingVenueInfo(true)} style={{ padding: '4px 8px', borderRadius: '6px', border: 'none', backgroundColor: 'var(--icon-bg)', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '500', cursor: 'pointer' }}>Edit</button>
                  ) : (
                    <button className="hit44" onClick={async () => {
                      // Was fire-and-forget: it closed the editor first and
                      // threw the failure away, so a name the profanity screen
                      // refused (or a save with no venue profile, or an expired
                      // session) looked saved and reverted on the next load.
                      // The editor stays open with the owner's text now, and
                      // the toast is the server's own sentence.
                      try {
                        await updateVenueProfile({ businessName: venueInfo.name, location: venueInfo.address, phone: venueInfo.phone });
                        setEditingVenueInfo(false);
                      } catch (e) {
                        showToast(e?.message || "Those details didn't save. Try again.", 'error');
                      }
                    }} style={{ padding: '4px 8px', borderRadius: '6px', border: 'none', backgroundColor: colors.steel, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '500', cursor: 'pointer' }}>Save</button>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div>
                    <label style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }} htmlFor="venue-info-name">Venue Name</label>
                    <SearchInputLocal id="venue-info-name" type="text" initialValue={venueInfo.name} onCommit={(v) => setVenueInfo(prev => ({ ...prev, name: v }))} disabled={!editingVenueInfo} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${editingVenueInfo ? colors.navy : colors.creamDark}`, fontSize: 'var(--t-meta)', boxSizing: 'border-box', backgroundColor: editingVenueInfo ? 'var(--bg-card-solid)' : 'var(--bg-tertiary)', color: 'var(--text-primary)' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }} htmlFor="venue-info-address">Address</label>
                    <SearchInputLocal id="venue-info-address" type="text" initialValue={venueInfo.address} onCommit={(v) => setVenueInfo(prev => ({ ...prev, address: v }))} disabled={!editingVenueInfo} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${editingVenueInfo ? colors.navy : colors.creamDark}`, fontSize: 'var(--t-meta)', boxSizing: 'border-box', backgroundColor: editingVenueInfo ? 'var(--bg-card-solid)' : 'var(--bg-tertiary)', color: 'var(--text-primary)' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }} htmlFor="venue-info-phone">Phone</label>
                    <SearchInputLocal id="venue-info-phone" type="text" initialValue={venueInfo.phone} onCommit={(v) => setVenueInfo(prev => ({ ...prev, phone: v }))} disabled={!editingVenueInfo} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${editingVenueInfo ? colors.navy : colors.creamDark}`, fontSize: 'var(--t-meta)', boxSizing: 'border-box', backgroundColor: editingVenueInfo ? 'var(--bg-card-solid)' : 'var(--bg-tertiary)', color: 'var(--text-primary)' }} />
                  </div>
                </div>
              </div>

              {/* Operating Hours */}
              <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                <h3 style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.clock(colors.navy, 14)} Operating Hours</h3>
                {operatingHours.length > 0 ? operatingHours.map((slot, i) => (
                  // Index, not slot.days. "+ Add Hours" in the editor appends
                  // { days: '', open: '', close: '' }, so two added rows both
                  // key on the empty string and React collides them. The
                  // editor's own list a few hundred lines down already keys on
                  // the index for this exact reason.
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: i < operatingHours.length - 1 ? `1px solid ${colors.cream}` : 'none' }}>
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy }}>{slot.days}</span>
                    <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>{slot.close ? `${slot.open} - ${slot.close}` : slot.open}</span>
                  </div>
                )) : (
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '4px 0', fontStyle: 'italic' }}>No hours set. Tap Edit Hours to add</p>
                )}
                <button className="hit44" onClick={() => setShowHoursModal(true)} style={{ marginTop: '8px', width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '500', cursor: 'pointer' }}>
                  Edit Hours
                </button>
              </div>

              {/* ── About your venue ──────────────────────────────────────────
                  Everything the onboarding form asks after the Google Places
                  pick, editable for the rest of the venue's life.

                  This card is the fix for a real bug and not a convenience.
                  category, description and goals were accepted by
                  PUT /api/venue-profile from the day it shipped and exposed in
                  Settings by nothing at all, so they could be answered exactly
                  once, at signup. A venue that moved its kitchen close time, or
                  went 21+ on weekends, or started a Tuesday quiz, had no way to
                  tell us. Advice read off a stale profile is worse than advice
                  read off an empty one, because nobody can tell it is stale. */}
              <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <h3 style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.building(colors.navy, 14)} About Your Venue</h3>
                  {!venueIntakeDraft ? (
                    <button className="hit44" onClick={() => setVenueIntakeDraft(venueProfileToIntake(venueProfile))} style={{ padding: '4px 8px', borderRadius: '6px', border: 'none', backgroundColor: 'var(--icon-bg)', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '500', cursor: 'pointer' }}>Edit</button>
                  ) : (
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button className="hit44" onClick={() => setVenueIntakeDraft(null)} disabled={savingVenueIntake} style={{ padding: '4px 8px', borderRadius: '6px', border: `1px solid ${colors.creamDark}`, backgroundColor: 'transparent', color: 'var(--text-secondary)', fontSize: 'var(--t-meta)', fontWeight: '500', cursor: 'pointer' }}>Cancel</button>
                      <button className="hit44" disabled={savingVenueIntake} onClick={async () => {
                        // The editor stays open on failure with every answer
                        // still in it, and the toast is the server's own
                        // sentence. Same contract as the Venue Information card
                        // above, for the same reason: a save that silently
                        // reverts on the next load is worse than a refusal.
                        setSavingVenueIntake(true);
                        try {
                          const saved = await updateVenueProfile(venueIntakeDraft);
                          setVenueProfile(saved);
                          setVenueIntakeDraft(null);
                          showToast('Saved.', 'success');
                        } catch (e) {
                          showToast(e?.message || "That didn't save. Try again.", 'error');
                        } finally {
                          setSavingVenueIntake(false);
                        }
                      }} style={{ padding: '4px 8px', borderRadius: '6px', border: 'none', backgroundColor: colors.steel, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '500', cursor: savingVenueIntake ? 'wait' : 'pointer', opacity: savingVenueIntake ? 0.6 : 1 }}>{savingVenueIntake ? 'Saving' : 'Save'}</button>
                    </div>
                  )}
                </div>

                {/* What data we actually hold for this place. The sentence is
                    the server's (venue_profiles corpus columns, worded once in
                    services/venueCorpus.js) so it cannot drift into something
                    softer here than it is there. */}
                {venueProfile?.corpus_summary && (
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 12px', lineHeight: 1.5, paddingBottom: '10px', borderBottom: `1px solid ${colors.cream}` }}>{venueProfile.corpus_summary}</p>
                )}

                {!venueIntakeDraft ? (
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
                    Your capacity, service style, kitchen and last-call times, age policy, event nights and the notes you wrote about this place. Tap Edit to change any of it.
                  </p>
                ) : (
                  <div>
                    {renderVenueField({ dark: false, label: 'Type of venue', children: renderVenueChips({ dark: false, label: 'Category', options: venueCategories.map(c => ({ value: c, label: c })), value: venueIntakeDraft.category, onChange: (v) => setVenueIntakeDraft(d => ({ ...d, category: v })) }) })}
                    {renderVenueField({ dark: false, label: 'Description', children: (
                      <textarea aria-label="Venue description" maxLength={2000} rows={3} value={venueIntakeDraft.description} onChange={(e) => setVenueIntakeDraft(d => ({ ...d, description: e.target.value }))} style={{ width: '100%', padding: '10px 12px', borderRadius: '10px', border: `1px solid ${colors.creamDark}`, fontSize: '16px', boxSizing: 'border-box', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-primary)', resize: 'none', fontFamily: 'inherit' }} />
                    ) })}
                    {renderVenueField({ dark: false, label: 'Goals', children: renderVenueChips({ dark: false, label: 'Goals', options: venueGoals.map(g => ({ value: g, label: g })), value: venueIntakeDraft.goals, onChange: (v) => setVenueIntakeDraft(d => ({ ...d, goals: v })), multi: true }) })}

                    {renderVenueField({ dark: false, label: 'How many people fit', hint: 'Comfortably full, not the fire-code maximum.', children: renderVenueNumber({ dark: false, value: venueIntakeDraft.capacity, onChange: (v) => setVenueIntakeDraft(d => ({ ...d, capacity: v })), min: 1, max: 20000, placeholder: '220', ariaLabel: 'Capacity', suffix: 'people' }) })}
                    {renderVenueField({ dark: false, label: 'How people are served', children: renderVenueChips({ dark: false, label: 'Service style', options: venueServiceStyles, value: venueIntakeDraft.serviceStyle, onChange: (v) => setVenueIntakeDraft(d => ({ ...d, serviceStyle: v })) }) })}
                    {renderVenueField({ dark: false, label: 'Outdoor seating', children: renderVenueChips({
                      dark: false, label: 'Outdoor seating',
                      options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
                      value: venueIntakeDraft.hasOutdoorSeating === true ? 'yes' : venueIntakeDraft.hasOutdoorSeating === false ? 'no' : '',
                      onChange: (v) => setVenueIntakeDraft(d => ({ ...d, hasOutdoorSeating: v === 'yes' ? true : v === 'no' ? false : null })),
                    }) })}

                    {renderVenueField({ dark: false, label: 'Bookings', children: renderVenueChips({ dark: false, label: 'Reservation policy', options: venueReservationPolicies, value: venueIntakeDraft.reservationPolicy, onChange: (v) => setVenueIntakeDraft(d => ({ ...d, reservationPolicy: v })) }) })}
                    {renderVenueField({ dark: false, label: 'Biggest group you will seat without a booking', children: renderVenueNumber({ dark: false, value: venueIntakeDraft.largestWalkinGroup, onChange: (v) => setVenueIntakeDraft(d => ({ ...d, largestWalkinGroup: v })), min: 1, max: 200, placeholder: '6', ariaLabel: 'Largest walk-in group', suffix: 'people' }) })}
                    {renderVenueField({ dark: false, label: 'How long a group usually stays', children: renderVenueNumber({ dark: false, value: venueIntakeDraft.typicalDwellMinutes, onChange: (v) => setVenueIntakeDraft(d => ({ ...d, typicalDwellMinutes: v })), min: 10, max: 600, placeholder: '90', ariaLabel: 'Typical visit length in minutes', suffix: 'minutes' }) })}
                    {renderVenueField({ dark: false, label: 'Typical spend per person', children: renderVenueNumber({ dark: false, value: venueIntakeDraft.typicalSpendPerPerson, onChange: (v) => setVenueIntakeDraft(d => ({ ...d, typicalSpendPerPerson: v })), min: 1, max: 1000, placeholder: '35', ariaLabel: 'Typical spend per person in dollars', suffix: 'dollars' }) })}

                    {renderVenueField({ dark: false, label: 'Kitchen stops taking orders at', children: renderVenueTime({ dark: false, value: venueIntakeDraft.kitchenLastOrder, onChange: (v) => setVenueIntakeDraft(d => ({ ...d, kitchenLastOrder: v })), ariaLabel: 'Kitchen last order' }) })}
                    {renderVenueField({ dark: false, label: 'Last call at', children: renderVenueTime({ dark: false, value: venueIntakeDraft.lastCall, onChange: (v) => setVenueIntakeDraft(d => ({ ...d, lastCall: v })), ariaLabel: 'Last call' }) })}
                    {renderVenueField({ dark: false, label: 'Who you let in', children: renderVenueChips({ dark: false, label: 'Age policy', options: venueAgePolicies, value: venueIntakeDraft.agePolicy, onChange: (v) => setVenueIntakeDraft(d => ({ ...d, agePolicy: v, ageRestrictedAfter: v === 'all_ages' ? '' : d.ageRestrictedAfter })) }) })}
                    {venueIntakeDraft.agePolicy && venueIntakeDraft.agePolicy !== 'all_ages' && renderVenueField({ dark: false, label: 'From what time', hint: 'Leave blank if the rule applies all day.', children: renderVenueTime({ dark: false, value: venueIntakeDraft.ageRestrictedAfter, onChange: (v) => setVenueIntakeDraft(d => ({ ...d, ageRestrictedAfter: v })), ariaLabel: 'Age restriction start time' }) })}

                    {renderVenueField({ dark: false, label: 'Nights you run something', children: renderVenueChips({ dark: false, label: 'Event nights', options: venueWeekdays, value: venueIntakeDraft.eventNights, onChange: (v) => setVenueIntakeDraft(d => ({ ...d, eventNights: v })), multi: true }) })}
                    {venueIntakeDraft.eventNights.length > 0 && renderVenueField({ dark: false, label: 'What runs on those nights', children: (
                      <input aria-label="What runs on those nights" maxLength={120} value={venueIntakeDraft.eventNote} onChange={(e) => setVenueIntakeDraft(d => ({ ...d, eventNote: e.target.value }))} placeholder="e.g. Trivia at 8" autoComplete="off" data-lpignore="true" data-form-type="other" style={{ width: '100%', padding: '10px 12px', borderRadius: '10px', border: `1px solid ${colors.creamDark}`, fontSize: '16px', boxSizing: 'border-box', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-primary)' }} />
                    ) })}
                    {renderVenueField({ dark: false, label: 'Nights you think are your busiest', children: renderVenueChips({ dark: false, label: 'Busy nights', options: venueWeekdays, value: venueIntakeDraft.ownerBusyNights, onChange: (v) => setVenueIntakeDraft(d => ({ ...d, ownerBusyNights: v })), multi: true }) })}
                    {renderVenueField({ dark: false, label: 'The one night you want fuller', children: renderVenueChips({ dark: false, label: 'Night you want fuller', options: venueWeekdays, value: venueIntakeDraft.targetNight, onChange: (v) => setVenueIntakeDraft(d => ({ ...d, targetNight: v })) }) })}

                    {renderVenueField({ dark: false, label: `Within a short walk (pick up to ${VENUE_MAX_ANCHORS})`, children: renderVenueChips({ dark: false, label: 'Nearby anchors', options: venueAnchorTypes, value: venueIntakeDraft.anchorTypes, onChange: (v) => setVenueIntakeDraft(d => ({ ...d, anchorTypes: v })), multi: true, max: VENUE_MAX_ANCHORS }) })}
                    {venueIntakeDraft.anchorTypes.length > 0 && renderVenueField({ dark: false, label: 'Name it', children: (
                      <input aria-label="Nearby anchor detail" maxLength={200} value={venueIntakeDraft.anchorNote} onChange={(e) => setVenueIntakeDraft(d => ({ ...d, anchorNote: e.target.value }))} placeholder="e.g. Across from the arena" autoComplete="off" data-lpignore="true" data-form-type="other" style={{ width: '100%', padding: '10px 12px', borderRadius: '10px', border: `1px solid ${colors.creamDark}`, fontSize: '16px', boxSizing: 'border-box', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-primary)' }} />
                    ) })}

                    {renderVenueField({ dark: false, label: 'Anything a stranger would not guess', children: (
                      <textarea aria-label="What a stranger would not guess" maxLength={1000} rows={4} value={venueIntakeDraft.quirks} onChange={(e) => setVenueIntakeDraft(d => ({ ...d, quirks: e.target.value }))} placeholder="e.g. Parking fills by seven." style={{ width: '100%', padding: '10px 12px', borderRadius: '10px', border: `1px solid ${colors.creamDark}`, fontSize: '16px', boxSizing: 'border-box', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-primary)', resize: 'none', fontFamily: 'inherit' }} />
                    ) })}
                  </div>
                )}
              </div>

              {/* The Notifications panel used to sit here: three switches, one
                  offering to tell the owner when a flock books their venue, one
                  for new customer reviews, one for a weekly performance summary
                  by email.

                  It is gone because none of those three notifications exists,
                  and none of them can be made to exist from this file.
                  backend/routes/venueProfile.js carries the audit that
                  established it: notification_prefs is WRITTEN by this
                  dashboard and read nowhere in the backend, and the reason it
                  is read nowhere is that there is nothing to read it. Every
                  pushAlways / pushIfOffline / pushIfOfflineDebounced call in
                  routes/, services/ and sockets/ addresses a flock member, a DM
                  recipient, a flock creator or an admin, never a venue owner.
                  routes/venueDashboard.js inserts a review and notifies nobody.
                  services/emailService.js sends verification and password reset
                  and nothing else, with no digest, no template and no
                  scheduler. That comment names this file as the place to fix
                  it, because the route cannot.

                  So this was not a wiring bug. It was three controls for a
                  feature that was never built, on a screen a venue is paying
                  $35 a month for: flip the booking switch and the flip is
                  stored and nothing else in the product changes, ever.
                  SLOP-AUDIT rule 5, no dead buttons, and the most expensive
                  kind, because the promise is the reason to pay.

                  The SERVER side deliberately stays as it is. PUT
                  /api/venue-profile still accepts and merges the preference
                  object, so the day a real owner notification ships the
                  setting has somewhere to live and this panel comes back with
                  it. What must not come back is the panel without the sends. */}

              {/* SUBSCRIPTION, and the dead end that used to live here.
                  Jayden, TestFlight build 26: this block read "Pro Plan /
                  $75/month / No end date" and there was no way to change or
                  cancel it anywhere in the product. Same shape as the venue
                  verification dead end: the screen stated a fact about money
                  and offered no control over it.

                  Two things are wrong with a bare price on a settings screen,
                  and they are separate.

                  THE NUMBER WAS WRONG. $75 was the 2026-08-14 call.
                  VENUE-PRICING.md superseded it on 2026-08-20 with $99, which
                  is already the number the server bills against
                  (`VENUE_PRICE_USD = 99` in backend/routes/admin.js). Rather
                  than move the wrong number to a right one and leave a third
                  copy of it on this screen, the price is gone from here
                  entirely: the plan sheet is the pricing surface, this screen
                  says what the owner HOLDS, and "See plans and pricing" is the
                  one route between them. One number, one place.

                  THE PRICE WAS ALSO NOT TRUE OF THIS VENUE. Every paid tier in
                  production today is an admin grant, most of them comped, and
                  telling a comped founding venue they are on "$75/month" is a
                  claim about their bank account that is simply false. tier_source
                  and tier_reason already come down with the profile, so the
                  screen can say what actually happened instead. */}
              <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', padding: '12px', boxShadow: 'var(--card-shadow-sm)' }}>
                <h3 style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.creditCard(colors.navy, 14)} Subscription</h3>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', padding: '8px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '8px' }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, margin: 0 }}>{tierBadge[venueData.tier].label} Plan</p>
                    {/* WHERE THE PLAN CAME FROM, when the server told us. Four
                        reasons exist and only one of them involves money. A
                        missing reason prints nothing: the entitlement lookup
                        failing is not evidence of a billing arrangement. */}
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>
                      {venueTier === 'free'
                        ? 'No charge. Your listing, your hours, your replies.'
                        : venueTierReason === 'paid'
                          ? 'Billed monthly.'
                          : venueTierReason === 'founding_comp'
                            ? 'Comped as a founding venue. Nothing is being charged.'
                            : venueTierSource || venueTierReason
                              ? 'Given to you by us. Nothing is being charged.'
                              : 'Set by us.'}
                    </p>
                    {/* WHEN IT ENDS, said plainly and once. A comped venue is
                        owed this: the founding offer is six months
                        (VENUE-PRICING.md), and before migration 040 nothing
                        expired a granted tier at all, so nobody, owner or
                        operator, could say when a pilot stopped.
                        Deliberately NOT a countdown, not a colour change as the
                        date nears, and not a prompt to buy. SLOP-AUDIT: an
                        interface that manufactures urgency about its own
                        billing is the dark pattern, not the information. A date
                        is the information. */}
                    {venueTier !== 'free' && (
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '2px 0 0' }}>
                        {(() => {
                          const endsAt = venueTierEndsAt ? new Date(venueTierEndsAt) : null;
                          return endsAt && !Number.isNaN(endsAt.getTime())
                            ? `Runs until ${endsAt.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}`
                            : 'No end date';
                        })()}
                      </p>
                    )}
                  </div>
                  {venueTier !== 'pro' && (
                    <button className="hit44" onClick={() => setShowUpgradeModal(true)} style={{ padding: '6px 12px', borderRadius: '6px', border: 'none', background: '#2d5a87', color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', flexShrink: 0 }}>
                      Upgrade
                    </button>
                  )}
                </div>

                {/* THE CONTROL. This is the part that did not exist.

                    California's Automatic Renewal Law, and the several state
                    laws written from it, require that cancelling be no harder
                    than signing up. That test is passed here rather than
                    dodged: there is no self-serve signup either. Nobody can buy
                    a venue plan in this app. Every tier is granted by one
                    admin-only route, POST /api/admin/venues/:userId/tier, so
                    "write to us" is literally the same effort as the signup
                    path it mirrors.

                    What this is NOT: a Cancel button that toasts success and
                    changes nothing. No cancellation endpoint exists (checked
                    across routes/venueProfile.js, routes/venueDashboard.js,
                    services/venueEntitlements.js, routes/billing.js and
                    routes/revenuecat.js. None of them writes a tier, and the
                    PUT explicitly refuses a client-supplied one). Inventing the
                    button would be the deactivate button's old bug again, and
                    a worse one, because this one is about money.

                    The mailto carries the business name and the current plan so
                    the owner does not have to describe their own account, which
                    is the part of "email us to cancel" that people give up on.
                    The address is printed underneath for a device with no mail
                    app, exactly as the Danger Zone does it. */}
                {venueTier !== 'free' && (
                  <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--divider)' }}>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      <button className="hit44" onClick={() => {
                        const subject = encodeURIComponent('Flock venue plan: change or cancel');
                        const body = encodeURIComponent(
                          `Business: ${venueProfile?.business_name || ''}\nCurrent plan: ${tierBadge[venueData.tier].label}\nWhat I want: (change plan / cancel)\n`
                        );
                        try { window.location.href = `mailto:${VENUE_SALES_EMAIL}?subject=${subject}&body=${body}`; } catch { /* address is printed below */ }
                      }} style={{ flex: '1 1 150px', minWidth: 0, padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>
                        Change or cancel this plan
                      </button>
                      <button className="hit44" onClick={() => setShowUpgradeModal(true)} style={{ flex: '1 1 130px', minWidth: 0, padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>
                        See plans and pricing
                      </button>
                    </div>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '8px 0 0', lineHeight: 1.5 }}>
                      There is no switch for this in the app yet, and there is no switch to sign up with either. Write to {VENUE_SALES_EMAIL} and we will change or stop the plan and email you back to confirm.
                    </p>
                  </div>
                )}
              </div>

              {/* Danger Zone */}
              <div style={{ backgroundColor: 'var(--accent-red-bg)', borderRadius: '12px', padding: '12px', border: `1px solid var(--accent-red-text)22` }}>
                <h3 style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.redText, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.alertCircle(colors.red, 14)} Danger Zone</h3>
                {/* This button used to answer a window.confirm with a green
                    "Venue deactivated" toast and change nothing at all: no
                    endpoint for it exists. A control that reports success for
                    work it never did is worse than no control, and a dead
                    button is its own App Review rejection. Until deactivation
                    is built, it asks us, the same way the plan buttons do. */}
                <button className="hit44 glass-btn glass-danger" onClick={() => {
                  const subject = encodeURIComponent('Flock venue listing: please deactivate');
                  const body = encodeURIComponent(`Business: ${venueProfile?.business_name || ''}\n`);
                  try { window.location.href = `mailto:${VENUE_SALES_EMAIL}?subject=${subject}&body=${body}`; } catch { /* address is in the line below */ }
                }} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${colors.red}`, backgroundColor: 'var(--bg-card-solid)', color: colors.redText, fontSize: 'var(--t-meta)', fontWeight: '500', cursor: 'pointer' }}>
                  Ask us to deactivate this listing
                </button>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '8px 0 0', lineHeight: 1.5 }}>
                  Write to {VENUE_SALES_EMAIL} and we will take the listing down. Your account stays yours.
                </p>
              </div>
            </div>
          )}

          {/* Upgrade Modal */}
          {showUpgradeModal && (
            <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
            <DialogBehavior onClose={() => setShowUpgradeModal(false)} label="Upgrade" />
              <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '320px', maxHeight: '80%', overflowY: 'auto' }}>
                <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 16px', textAlign: 'center' }}>Venue plans</h2>

                {/* Free Tier */}
                <div style={{ border: `2px solid ${venueTier === 'free' ? colors.navy : colors.creamDark}`, borderRadius: '12px', padding: '12px', marginBottom: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontWeight: '700', color: colors.navy }}>Free</span>
                    <span style={{ fontWeight: '700', color: colors.navy }}>$0/mo</span>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '16px', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>
                    {features.free.map(f => <li key={f} style={{ marginBottom: '2px' }}>{f}</li>)}
                  </ul>
                  {venueTier === 'free' && <span style={{ display: 'block', textAlign: 'center', fontSize: 'var(--t-meta)', color: colors.steel, fontWeight: '500', marginTop: '8px' }}>Current Plan</span>}
                </div>

                {/* Premium Tier */}
                <div style={{ border: `2px solid ${venueTier === 'premium' ? 'var(--accent-amber-text)' : colors.creamDark}`, borderRadius: '12px', padding: '12px', marginBottom: '10px', backgroundColor: venueTier === 'premium' ? 'var(--accent-amber-bg)' : 'var(--bg-card-solid)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontWeight: '700', color: 'var(--accent-amber-text)' }}>Premium</span>
                    <span style={{ fontWeight: '700', color: 'var(--accent-amber-text)' }}>{venuePlanPriceLabel('premium')}</span>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '16px', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>
                    {features.premium.map(f => <li key={f} style={{ marginBottom: '2px' }}>{f}</li>)}
                  </ul>
                  {venueTier === 'premium' ? <span style={{ display: 'block', textAlign: 'center', fontSize: 'var(--t-meta)', color: 'var(--accent-amber-text)', fontWeight: '500', marginTop: '8px' }}>Current Plan</span> : venueTier === 'free' && <button className="hit44" onClick={() => requestTierUpgrade('Premium')} style={{ width: '100%', padding: '8px', borderRadius: '8px', border: 'none', backgroundColor: 'var(--accent-amber-text)', color: 'white', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer', marginTop: '8px' }}>Email us about Premium</button>}
                </div>

                {/* Pro Tier */}
                <div style={{ border: '2px solid #2d5a87', borderRadius: '12px', padding: '12px', marginBottom: '16px', backgroundColor: 'var(--accent-purple-bg)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontWeight: '700', color: 'var(--accent-purple-text)' }}>Pro</span>
                    <span style={{ fontWeight: '700', color: 'var(--accent-purple-text)' }}>{venuePlanPriceLabel('pro')}</span>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '16px', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>
                    {features.pro.map(f => <li key={f} style={{ marginBottom: '2px' }}>{f}</li>)}
                  </ul>
                  {venueTier === 'pro' ? <span style={{ display: 'block', textAlign: 'center', fontSize: 'var(--t-meta)', color: 'var(--accent-purple-text)', fontWeight: '500', marginTop: '8px' }}>Current Plan</span> : <button className="hit44" onClick={() => requestTierUpgrade('Pro')} style={{ width: '100%', padding: '8px', borderRadius: '8px', border: 'none', background: '#2d5a87', color: 'white', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer', marginTop: '8px' }}>Email us about Pro</button>}
                </div>

                {/* THE OTHER AXIS, said once rather than in three lists.
                    A plan decides which features a venue is entitled to;
                    verification decides whether the venue may speak or publish
                    at all, and several lines above are gated on BOTH. Replies,
                    the live number and the forecast all check
                    venue_profiles.verified in routes/venueDashboard.js, so a
                    venue reading the free list while unverified is reading
                    three things that are true of its plan and not yet true of
                    its account. Shown only while that is the case. */}
                {!venueIsVerified && (
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 10px', textAlign: 'center', lineHeight: 1.5 }}>
                    Replies to reviews, your live number and your forecast also need a verified venue, on every plan. Settings has the request.
                  </p>
                )}
                {/* Printed as text too, so a device with no mail app still has
                    something it can act on. */}
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 12px', textAlign: 'center', lineHeight: 1.5 }}>
                  Plans are set up by hand right now. Write to {VENUE_SALES_EMAIL} and we will get you moved over.
                </p>

                <button className="hit44" onClick={() => setShowUpgradeModal(false)} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--border-mid)', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-secondary)', fontWeight: '500', cursor: 'pointer' }}>Close</button>
              </div>
            </div>
          )}

          {/* Venue logo picker. The server only stores photo URLs this app
              mints (the /api/venues/photo proxy path), so the choices are the
              linked listing's own Google photos and nothing else. See
              openVenueLogoPicker for why this replaced the file upload. */}
          {venueLogoPicker && (
            <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
              <DialogBehavior onClose={() => setVenueLogoPicker(null)} label="Venue logo" />
              <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '320px', maxHeight: '80%', overflowY: 'auto' }}>
                <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 6px', textAlign: 'center' }}>Venue logo</h2>
                <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 16px', textAlign: 'center', lineHeight: 1.5 }}>
                  Pick a photo from your Google listing.
                </p>
                {venueLogoPicker === 'loading' && (
                  <div role="status" aria-label="Loading photos" style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}>
                    <div style={{ width: '20px', height: '20px', border: '2px solid var(--border-mid)', borderTopColor: colors.navy, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  </div>
                )}
                {venueLogoPicker === 'error' && (
                  <div style={{ textAlign: 'center', padding: '8px 0 16px' }}>
                    <BirdNote
                      size={64}
                      bird={WARM_BIRD}
                      body="Couldn't load your listing's photos."
                      action={<button className="hit44" onClick={() => openVenueLogoPicker()} style={{ padding: '8px 16px', borderRadius: '8px', border: 'none', backgroundColor: colors.navy, color: 'white', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer' }}>Try again</button>}
                      style={{ padding: '0 0 4px' }}
                    />
                  </div>
                )}
                {typeof venueLogoPicker === 'object' && venueLogoPicker.photos.length === 0 && (
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 16px', textAlign: 'center', lineHeight: 1.5 }}>
                    Your Google listing has no photos yet. Add some on Google Business Profile and they will show up here.
                  </p>
                )}
                {typeof venueLogoPicker === 'object' && venueLogoPicker.photos.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '16px' }}>
                    {venueLogoPicker.photos.map((url, i) => (
                      <button
                        key={url}
                        type="button"
                        className="hit44"
                        onClick={() => handleVenueLogoPick(url)}
                        aria-label={`Use listing photo ${i + 1} as your logo`}
                        style={{ padding: 0, border: 'none', borderRadius: '12px', overflow: 'hidden', cursor: 'pointer', backgroundColor: 'var(--bg-primary)' }}
                      >
                        <img src={url} alt="" loading="lazy" style={{ width: '100%', height: '96px', objectFit: 'cover', display: 'block' }} />
                      </button>
                    ))}
                  </div>
                )}
                <button className="hit44" onClick={() => setVenueLogoPicker(null)} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--border-mid)', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-secondary)', fontWeight: '500', cursor: 'pointer' }}>Close</button>
              </div>
            </div>
          )}

          {/* Promotion Modal — isolated component, typing doesn't re-render parent
              A refused save used to be console.error AND close the modal anyway,
              which is worse than a dead button: a promotion the server refused
              (profanity screen, a moderation-hidden row, a free-tier account once
              venue billing is on) disappeared along with everything the owner had
              typed, looking exactly like a save. Both save handlers below say what
              the server said and leave the form open with the text still in it.
              The ONE exception is a 409 CONTENT_HIDDEN, which no retry can ever
              clear; see markPromoTakenDown / markEventTakenDown. */}
          {showPromoModal && (
            <PromoModal
              editing={editingPromo}
              colors={colors}
              onCancel={() => { setShowPromoModal(false); setEditingPromo(null); }}
              onSave={async (form) => {
                if (!form.title.trim()) return;
                try {
                  if (editingPromo) {
                    const updated = await updateVenuePromotion(editingPromo.id, { title: form.title, description: form.desc, timeSlot: form.time, days: form.days });
                    setPromotions(prev => prev.map(p => p.id === editingPromo.id ? updated : p));
                  } else {
                    const created = await createVenuePromotion({ title: form.title, description: form.desc, timeSlot: form.time, days: form.days });
                    setPromotions(prev => [created, ...prev]);
                  }
                } catch (e) {
                  showToast(e?.message || "That promotion couldn't be saved. Try again.", 'error');
                  if (e?.code === 'CONTENT_HIDDEN' && editingPromo) markPromoTakenDown(editingPromo.id);
                  return;
                }
                setShowPromoModal(false);
                setEditingPromo(null);
              }}
            />
          )}

          {/* Event Modal. Two things the save handler below does that are not
              obvious: the takedown flag is read off the write response rather
              than hardcoded false (those routes answer with RETURNING *, so they
              carry the raw is_hidden column, which isModerationHidden also
              reads), and a created event is PREPENDED because GET /events orders
              by created_at DESC — appending put it at the bottom until the next
              dashboard load silently moved it to the top. */}
          {showEventModal && (
            <EventModal
              editing={editingEvent}
              colors={colors}
              onCancel={() => { setShowEventModal(false); setEditingEvent(null); }}
              onSave={async (form) => {
                if (!form.title.trim()) return;
                try {
                  if (editingEvent) {
                    const updated = await updateVenueEvent(editingEvent.id, { title: form.title, eventDate: form.date, eventTime: form.time, capacity: parseInt(form.capacity) || null });
                    setVenueEventsList(prev => prev.map(e => e.id === editingEvent.id ? { id: updated.id, title: updated.title, date: updated.event_date, time: updated.event_time, capacity: updated.capacity, hidden_by_moderation: isModerationHidden(updated) } : e));
                  } else {
                    const created = await createVenueEvent({ title: form.title, eventDate: form.date, eventTime: form.time, capacity: parseInt(form.capacity) || null });
                    setVenueEventsList(prev => [{ id: created.id, title: created.title, date: created.event_date, time: created.event_time, capacity: created.capacity, hidden_by_moderation: isModerationHidden(created) }, ...prev]);
                  }
                } catch (e) {
                  showToast(e?.message || "That event couldn't be saved. Try again.", 'error');
                  if (e?.code === 'CONTENT_HIDDEN' && editingEvent) markEventTakenDown(editingEvent.id);
                  return;
                }
                setShowEventModal(false);
                setEditingEvent(null);
              }}
            />
          )}

          {/* Hours Modal */}
          {showHoursModal && (
            <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
            <DialogBehavior onClose={() => setShowHoursModal(false)} label="Venue hours" />
              <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '340px', maxHeight: '80%', overflowY: 'auto' }}>
                <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 16px', textAlign: 'center' }}>Edit Operating Hours</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {operatingHours.map((slot, index) => (
                    <div key={index} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '8px' }}>
                      <input aria-label={`Days for hours row ${index + 1}`} value={slot.days} onChange={(e) => { const updated = [...operatingHours]; updated[index] = {...updated[index], days: e.target.value}; setOperatingHours(updated); }} style={{ width: '70px', padding: '6px', borderRadius: '6px', border: `1px solid ${colors.creamDark}`, fontSize: 'var(--t-meta)', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-primary)' }} />
                      <input aria-label={`Opening time for hours row ${index + 1}`} value={slot.open} onChange={(e) => { const updated = [...operatingHours]; updated[index] = {...updated[index], open: e.target.value}; setOperatingHours(updated); }} style={{ flex: 1, padding: '6px', borderRadius: '6px', border: `1px solid ${colors.creamDark}`, fontSize: 'var(--t-meta)', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-primary)' }} />
                      <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>to</span>
                      <input aria-label={`Closing time for hours row ${index + 1}`} value={slot.close} onChange={(e) => { const updated = [...operatingHours]; updated[index] = {...updated[index], close: e.target.value}; setOperatingHours(updated); }} style={{ flex: 1, padding: '6px', borderRadius: '6px', border: `1px solid ${colors.creamDark}`, fontSize: 'var(--t-meta)', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-primary)' }} />
                      <button aria-label={`Delete hours row ${index + 1}`} className="hit44" onClick={() => setOperatingHours(operatingHours.filter((_, i) => i !== index))} style={{ padding: '4px', border: 'none', background: 'none', cursor: 'pointer' }}>{Icons.trash(colors.red, 14)}</button>
                    </div>
                  ))}
                  <button className="hit44" onClick={() => setOperatingHours([...operatingHours, { days: '', open: '', close: '' }])} style={{ padding: '8px', borderRadius: '6px', border: `1px dashed ${colors.creamDark}`, backgroundColor: 'transparent', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '500', cursor: 'pointer' }}>+ Add Hours</button>
                </div>
                <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                  <button className="hit44" onClick={() => setShowHoursModal(false)} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: '1px solid var(--border-mid)', backgroundColor: 'var(--bg-card-solid)', color: 'var(--text-secondary)', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
                  {/* Same fix as the Venue Information Save above: the modal
                      used to close before the request and discard its failure,
                      so rejected hours vanished looking saved. */}
                  <button className="hit44" onClick={async () => {
                    try {
                      await updateVenueProfile({ operatingHours });
                      setShowHoursModal(false);
                    } catch (e) {
                      showToast(e?.message || "Those hours didn't save. Try again.", 'error');
                    }
                  }} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: 'none', backgroundColor: colors.navyBg, color: 'white', fontWeight: '600', cursor: 'pointer' }}>Save Hours</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
}
