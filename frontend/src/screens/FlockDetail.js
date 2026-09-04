/**
 * FLOCK PLAN DETAIL SCREEN
 *
 * The screen a tap on any flock card lands on: roster, RSVP state, venue,
 * votes, the time editor, the momentum meter, check in, the night recap and
 * the post-hangout feedback sheet. It was about 670 lines of App.js,
 * declared as an arrow function inside FlockAppInner and called rather than
 * mounted. It moved out on 2026-09-01 for the same reason the venue owner
 * dashboard, the flock chat, Add Friends, the DM thread, the profile and
 * settings screen, the admin console and the venue onboarding did before it,
 * which is that a single file holding every screen in the product is a file
 * nobody can review.
 *
 * WHY THIS ONE IS A STATIC IMPORT
 *
 * The same call the flock chat and the DM thread made, for the same reason.
 * This screen is the hub of the core loop, one tap from the Nest for every
 * signed-in person, and it is opened mid-plan on bar networks. React.lazy
 * would move it off the boot chunk and charge a round trip, plus an empty
 * Suspense fallback on a congested network, in front of a screen the person
 * opened deliberately. The flock chat header priced that exact trade with
 * three production builds and it came out negative for a screen users open
 * immediately, so this one is imported normally and stays in the app chunk.
 * No fresh byte number was measured here, for the reason DmDetail.js gives:
 * the reasoning decides it, and inventing a number would be worse than
 * citing the sibling that measured one.
 *
 * WHY EVERYTHING ARRIVES AS A PROP
 *
 * The old arrow function closed over 69 names. Fifty-six are declared in
 * FlockAppInner: its state, setters, handlers, refs and the shared style
 * objects. Nine more are module-level helpers, constants and components
 * that App.js declares once and shares with screens other than this one, so
 * they stay declared there. Those 65 are the parameters below, built at the
 * call site with object shorthand so the name there and the parameter here
 * cannot drift apart. The remaining four are module imports App.js already
 * pulls in from '../services/api', '../components/ui/BirdieBird' and
 * '../components/ui/Icons', so this file imports them straight from the
 * source rather than taking them as props. The names were not read off the
 * page. They came from a Babel scope walk of the block, every referenced
 * identifier whose binding resolves outside it, and the parameter list
 * below and the props object at the call site were both generated from that
 * one array, so they cannot drift apart.
 *
 * The state and the effects behind these props deliberately did NOT move.
 * They live in FlockAppInner, which does not unmount when the user leaves
 * this screen, so the selected flock, the vote counts, a half-finished
 * feedback draft and the confirm slider refs all survive a trip elsewhere
 * exactly as they did before.
 *
 * The body below is the old block verbatim, including its original
 * four-space indentation, so it can be diffed against the deleted lines
 * character for character. Nothing was renamed, reformatted or improved on
 * the way across, and no defect was fixed in transit: this is a move.
 */
import React from 'react';
import { submitVenueFeedback } from '../services/api';
import { BirdieStill, WARM_BIRD } from '../components/ui/BirdieBird';
import Icons from '../components/ui/Icons';

// The time editor's day chips are relative words (Tonight, Tomorrow, This
// Weekend, Next Week). A plan that sits on none of those days, a Saturday
// two weeks out say, used to open the editor on 'Tonight', so changing its
// HOUR silently moved it to today for every member. When no chip lands on
// the plan's own day, the day itself becomes the chip, as a YYYY-MM-DD key,
// and resolves to that date at the chosen hour.
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const isDateKey = (day) => DATE_KEY_RE.test(String(day || ''));
const dateKeyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const sameLocalDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const hourOfChoice = (label) => {
  const m = /^\s*(\d{1,2})\s*(AM|PM)\s*$/i.exec(String(label || ''));
  if (!m) return 21;
  const h = parseInt(m[1], 10) % 12;
  return /pm/i.test(m[2]) ? h + 12 : h;
};
const resolveEditTime = (resolveEventTime, day, hour) => {
  const m = DATE_KEY_RE.exec(String(day || ''));
  if (!m) return resolveEventTime(day, hour);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hourOfChoice(hour), 0, 0, 0);
};
const dayChipLabel = (day) => {
  const m = DATE_KEY_RE.exec(String(day || ''));
  if (!m) return day;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
};
// The chip that lands on the plan's own day at this hour, else the day itself.
const dayChipFor = (resolveEventTime, dayChoices, when, hourLabel) => {
  const hit = dayChoices.find((d) => sameLocalDay(resolveEventTime(d, hourLabel), when));
  return hit || dateKeyOf(when);
};

export default function FlockDetail({
  // Module-level helpers, constants and components that live in App.js and
  // are shared with screens other than this one, so they stay declared there
  // and arrive here.
  DialogBehavior,
  FLOCK_DAY_CHOICES,
  FLOCK_HOUR_CHOICES,
  MOMENTUM_STAGES,
  momentumStageKey,
  onVenuePhotoError,
  openExternal,
  resolveEventTime,
  voteTotal,
  // Everything else is declared in FlockAppInner and stays declared there.
  MissingFlockPanel,
  authUser,
  checkinSaving,
  colors,
  confirmClick,
  confirmFlockPlan,
  confirmingPlan,
  crowdPredictions,
  feedbackState,
  feedbackSubmitting,
  getSelectedFlock,
  handleCheckIn,
  handleRerunFlock,
  loadPopularVenues,
  markFlockCompleted,
  rosterError,
  retryRoster,
  openAttendanceSheet,
  openUserProfile,
  openVenueDetail,
  recapSharing,
  rememberFeedbackDone,
  rerunningFlockId,
  saveFlockEventTime,
  savingEventTime,
  selectedFlockId,
  setConfirmingPlan,
  setCopiedInviteUrl,
  setCurrentScreen,
  setCurrentTab,
  setFeedbackState,
  setFeedbackSubmitting,
  setFlockInviteSearch,
  setFlockInviteSelected,
  setModerationTarget,
  setPickingVenueForCreate,
  setPickingVenueForFlockId,
  setSavingEventTime,
  setShowFlockInviteModal,
  setShowTimeEditor,
  setShowVotePanel,
  setSlideStage,
  setTimeEditDay,
  setTimeEditHour,
  shareNightRecap,
  showTimeEditor,
  showToast,
  slideFillRef,
  slidePctRef,
  slideRef,
  slideStage,
  slideThumbRef,
  slidingRef,
  styles,
  submittedFeedback,
  timeEditDay,
  timeEditHour,
  updateFlockVotes,
}) {
    const flock = getSelectedFlock();
    if (!flock) return <MissingFlockPanel />;
    const acceptedMembers = (flock.members || []).filter(m => typeof m === 'object' ? (m.status === 'accepted' || !m.status) : true);
    // Guests are merged for DISPLAY only. flock.guests stays its own array
    // because flock.members feeds the bill-split payer picker and the
    // location-share guard, which both require real account ids.
    const goingGuests = (flock.guests || []).filter(g => g.status === 'accepted');
    const goingCount = acceptedMembers.length + goingGuests.length;
    const roster = [...acceptedMembers, ...goingGuests];
    const isCompleted = flock.status === 'completed';
    const isConfirmed = flock.status === 'confirmed' || flock.status === 'locked';
    // A completed flock whose roster still carries an unmarked member. Two
    // ways to get one: the host skipped the sheet, or the server's own sweep
    // completed the night hours after it ended and there was no sheet to skip.
    const attendanceOwed = isCompleted && acceptedMembers.some(m => typeof m === 'object' && (m.attendance || 'unmarked') === 'unmarked');
    const hasVenue = flock.venue && flock.venue !== 'TBD';
    // PUT /api/flocks/:id is creator-only, so only the creator gets the control.
    const isCreator = String(flock.creatorId) === String(authUser?.id);
    // Exactly one person is in, and that person is you. Only then may the
    // roster say "just you": a lone member who is somebody else (you are still
    // deciding) must not be told they are you. Legacy string rosters carry no
    // ids, and a solo string entry is the viewer.
    const soloMember = acceptedMembers.length === 1 && goingGuests.length === 0 ? acceptedMembers[0] : null;
    const justYou = soloMember != null &&
      (typeof soloMember !== 'object' || String(soloMember.id) === String(authUser?.id));

    return (
      <div key="flock-detail-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--bg-primary)' }}>

        {/* ── Header ── */}
        <div style={{ background: colors.navyBg, padding: '16px', paddingTop: '20px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px' }}>
            <button className="hit44" aria-label="Back to your plans" onClick={() => setCurrentScreen('main')} style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(255,255,255,0.16)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{Icons.arrowLeft('white', 16)}</button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1 style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.005em', color: 'white', margin: 0, fontSize: 'var(--t-title)', fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{flock.name}</h1>
              <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: 'var(--t-label)', marginTop: '3px' }}>
                Hosted by {flock.host} {goingCount > 0 && <span style={{ marginLeft: '4px' }}>· {goingCount} going</span>}
              </div>
            </div>
            {/* The add-to-calendar button that sat here wrote a manual row
                to Flock's own Plans calendar, where this flock is ALREADY
                auto-derived, so tapping it doubled the entry; and it never
                reached the device calendar users actually meant. Removed
                2026-08-27; device-calendar export is a real feature for the
                design list, not a button that quietly does the wrong thing. */}
          </div>

          {/* Status badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '5px 12px', background: isCompleted ? 'rgba(74,123,167,0.25)' : isConfirmed ? 'rgba(34,197,94,0.25)' : 'rgba(245,158,11,0.25)', borderRadius: '20px', fontSize: 'var(--t-meta)', fontWeight: '500', color: isCompleted ? '#a9c7e4' : isConfirmed ? '#86efac' : '#fcd34d' }}>
              {isCompleted ? 'Done' : isConfirmed ? 'Locked In' : 'Planning'}
            </span>
            {flock.time && flock.time !== 'TBD' && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '5px 12px', background: 'rgba(255,255,255,0.15)', borderRadius: '20px', fontSize: 'var(--t-meta)', fontWeight: '500', color: 'white' }}>
                {Icons.calendar('white', 12)} {flock.time}
              </span>
            )}
          </div>

          {/* ── Momentum Meter ── */}
          {!isCompleted && flock.momentum && (() => {
            const m = flock.momentum;
            const stages = MOMENTUM_STAGES;
            const activeIdx = stages.findIndex(s => s.key === momentumStageKey(m));
            const activeColor = stages[activeIdx]?.color || '#94a3b8';
            return (
              <div style={{ marginTop: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'rgba(255,255,255,0.72)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Momentum</span>
                  {/* Stage label reads in white; the stage colour lives in the
                      bar below it, where contrast rules for text do not apply. */}
                  <span style={{ fontSize: 'var(--t-meta)', fontWeight: '600', color: 'rgba(255,255,255,0.92)' }}>{stages[activeIdx]?.label}</span>
                </div>
                {/* Progress bar. Reached segments are filled, unreached ones are
                    hollow outlines, so the boundary survives without colour. */}
                <div role="img" aria-label={`Momentum stage ${activeIdx + 1} of ${stages.length}: ${stages[activeIdx]?.label}`} style={{ display: 'flex', gap: '3px', height: '6px' }}>
                  {stages.map((s, i) => (
                    <div key={s.key} style={{ flex: 1, borderRadius: '3px', background: i <= activeIdx ? activeColor : 'transparent', boxShadow: i <= activeIdx ? 'none' : 'inset 0 0 0 1px rgba(255,255,255,0.35)', transition: 'background 0.3s cubic-bezier(0.16, 1, 0.3, 1)' }} />
                  ))}
                </div>
                {/* Signal summary: check = done, open ring = not yet, so the
                    two states differ by shape as well as colour. */}
                <div style={{ display: 'flex', gap: '12px', marginTop: '8px', flexWrap: 'wrap' }}>
                  {[
                    { met: m.accepted === m.totalMembers, label: `${m.accepted}/${m.totalMembers} RSVPs` },
                    { met: !!m.hasVenue, label: m.hasVenue ? 'Venue set' : 'No venue yet' },
                    { met: !!m.hasTime, label: m.hasTime ? 'Time set' : 'No time yet' },
                  ].map(sig => (
                    <span key={sig.label} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: 'var(--t-meta)', fontWeight: '500', color: sig.met ? 'rgba(134,239,172,0.95)' : 'rgba(255,255,255,0.72)' }}>
                      {sig.met ? Icons.check('rgba(134,239,172,0.95)', 12) : Icons.circle('rgba(255,255,255,0.55)', 12)} {sig.label}
                    </span>
                  ))}
                  {m.uniqueVoters > 0 && (
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'rgba(255,255,255,0.72)' }}>
                      {m.uniqueVoters} voted
                    </span>
                  )}
                </div>
              </div>
            );
          })()}
        </div>

        {/* Slide to complete bar — confirmed flocks, creator only.
            PUT /api/flocks/:id is creator-only, exactly like the time editor
            below, which is already gated. This one was not, so every other
            member got a slider that flipped the status locally, was refused by
            the server, and silently reverted on the next load. */}
        {/* Time-gated: this used to render from the second a plan was
            confirmed, so a Saturday plan confirmed Tuesday asked "Hangout
            done?" for four days, and sliding it filed a night that never
            happened as Happened. */}
        {isConfirmed && isCreator && (!flock.eventTime || new Date(flock.eventTime) <= new Date()) && (
          <div style={{ padding: '10px 16px', flexShrink: 0, borderBottom: '1px solid var(--border-subtle)' }}>
            <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-secondary)', margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Hangout done? Slide to complete</p>
            <div
              ref={slideRef}
              style={{ position: 'relative', height: '44px', borderRadius: '22px', backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-default)', overflow: 'hidden', touchAction: 'none', userSelect: 'none' }}
              onTouchStart={(e) => {
                const rect = slideRef.current.getBoundingClientRect();
                const x = e.touches[0].clientX - rect.left;
                if (x < 56) { slidingRef.current = true; }
              }}
              onTouchMove={(e) => {
                if (!slidingRef.current) return;
                const rect = slideRef.current.getBoundingClientRect();
                const x = e.touches[0].clientX - rect.left;
                const pct = Math.max(0, Math.min(100, ((x - 22) / (rect.width - 44)) * 100));
                slidePctRef.current = pct;
                if (slideFillRef.current) slideFillRef.current.style.width = `${Math.max(44, (pct / 100) * rect.width)}px`;
                if (slideThumbRef.current) slideThumbRef.current.style.left = `${Math.max(3, (pct / 100) * (rect.width - 44))}px`;
                const stage = pct > 85 ? 'armed' : pct > 30 ? 'past30' : 'idle';
                setSlideStage(prev => (prev === stage ? prev : stage));
              }}
              onTouchEnd={() => {
                slidingRef.current = false;
                if (slidePctRef.current > 85) {
                  // markFlockCompleted owns the toast now: announcing success
                  // here fired even when the server refused the change.
                  markFlockCompleted(flock.id);
                }
                slidePctRef.current = 0;
                if (slideFillRef.current) slideFillRef.current.style.width = '';
                if (slideThumbRef.current) slideThumbRef.current.style.left = '';
                setSlideStage('idle');
              }}
              onMouseDown={(e) => {
                const rect = slideRef.current.getBoundingClientRect();
                const x = e.clientX - rect.left;
                if (x < 56) { slidingRef.current = true; }
              }}
              onMouseMove={(e) => {
                if (!slidingRef.current) return;
                const rect = slideRef.current.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const pct = Math.max(0, Math.min(100, ((x - 22) / (rect.width - 44)) * 100));
                slidePctRef.current = pct;
                if (slideFillRef.current) slideFillRef.current.style.width = `${Math.max(44, (pct / 100) * rect.width)}px`;
                if (slideThumbRef.current) slideThumbRef.current.style.left = `${Math.max(3, (pct / 100) * (rect.width - 44))}px`;
                const stage = pct > 85 ? 'armed' : pct > 30 ? 'past30' : 'idle';
                setSlideStage(prev => (prev === stage ? prev : stage));
              }}
              onMouseUp={() => {
                if (!slidingRef.current) return;
                slidingRef.current = false;
                if (slidePctRef.current > 85) {
                  markFlockCompleted(flock.id);
                }
                slidePctRef.current = 0;
                if (slideFillRef.current) slideFillRef.current.style.width = '';
                if (slideThumbRef.current) slideThumbRef.current.style.left = '';
                setSlideStage('idle');
              }}
              onMouseLeave={() => { if (slidingRef.current) { slidingRef.current = false; slidePctRef.current = 0; if (slideFillRef.current) slideFillRef.current.style.width = ''; if (slideThumbRef.current) slideThumbRef.current.style.left = ''; setSlideStage('idle'); } }}
            >
              {/* Fill track: width written imperatively during the drag; the
                  empty-string resets on release hand back to this default. */}
              <div ref={slideFillRef} style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: '44px', borderRadius: '22px', background: slideStage === 'armed' ? '#2d5a87' : colors.navyBg, transition: slidingRef.current ? 'none' : 'width 0.3s ease, background 0.2s ease' }} />
              {/* Thumb */}
              <div ref={slideThumbRef} style={{ position: 'absolute', top: '3px', left: '3px', width: '38px', height: '38px', borderRadius: '19px', backgroundColor: 'white', boxShadow: '0 2px 8px rgba(0,0,0,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: slidingRef.current ? 'none' : 'left 0.3s ease' }}>
                <span style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navyBg, transition: 'transform 0.15s ease' }}>{slideStage === 'armed' ? Icons.check(colors.navyBg, 16) : Icons.chevronRight(colors.navyBg, 16)}</span>
              </div>
              {/* Label */}
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: slideStage !== 'idle' ? 'rgba(255,255,255,0.9)' : 'var(--text-secondary)', transition: 'color 0.2s ease', letterSpacing: '0.3px' }}>{slideStage === 'armed' ? 'Release to complete!' : 'Slide to mark done'}</span>
              </div>
            </div>
          </div>
        )}

        {/* The done step, for a night that finished without one. The slide bar
            above only exists on a CONFIRMED flock, so once a plan is completed
            (by the host or by the server sweep) there was no route back to
            attendance, and attendance is the only thing that writes anyone a
            reliability score. Creator only, same as the sheet itself. */}
        {attendanceOwed && isCreator && (
          <div style={{ padding: '10px 16px', flexShrink: 0, borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--text-primary)', margin: 0 }}>Who showed up?</p>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0' }}>This is what sets everyone's reliability score for the night.</p>
            </div>
            <button className="hit44 glass-btn glass-primary" onClick={(e) => { confirmClick(e); openAttendanceSheet(flock.id); }} style={{ padding: '9px 14px', borderRadius: '10px', border: 'none', background: colors.navyBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer', flexShrink: 0 }}>Mark it</button>
          </div>
        )}

        {/* ── Scrollable content ── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px', paddingBottom: '90px' }}>

          {/* Venue Card. No fade overlay on the photo: the old one faded to
              white, which in dark mode painted a white fog over the card. A
              clean photo edge is right in both themes. */}
          {hasVenue ? (
            <div style={{ ...styles.card, padding: 0, overflow: 'hidden', marginBottom: '12px' }}>
              {flock.venuePhoto && (
                <img src={flock.venuePhoto} alt="" width="375" height="170" style={{ width: '100%', height: '170px', objectFit: 'cover', display: 'block' }} onError={onVenuePhotoError} />
              )}
              <div style={{ padding: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '6px' }}>
                  <h3 style={{ color: colors.navy, margin: 0, fontSize: 'var(--t-title)', fontWeight: '700', flex: 1 }}>{flock.venue}</h3>
                  {flock.venueRating && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: '3px', padding: '3px 8px', background: 'var(--accent-amber-bg)', borderRadius: '8px', fontSize: 'var(--t-label)', fontWeight: '600', color: 'var(--accent-amber-text)', flexShrink: 0 }}>{Icons.starFilled('currentColor', 13)} {flock.venueRating}</span>
                  )}
                </div>
                {flock.venueAddress && (
                  <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--t-meta)', margin: '0 0 12px', display: 'flex', alignItems: 'flex-start', gap: '5px' }}>
                    {Icons.mapPin(colors.textSecondary, 13)} <span style={{ lineHeight: '1.3' }}>{flock.venueAddress}</span>
                  </p>
                )}
                <div style={{ display: 'flex', gap: '8px' }}>
                  {flock.venueId && (
                    <button className="hit44 glass-btn glass-secondary" onClick={() => openVenueDetail(flock.venueId, { name: flock.venue, formatted_address: flock.venueAddress, place_id: flock.venueId, rating: flock.venueRating, photo_url: flock.venuePhoto })} style={{ flex: 1, padding: '10px', background: 'var(--icon-bg)', border: `1.5px solid ${colors.navyMid}`, borderRadius: '10px', color: colors.navyMid, fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
                      {Icons.eye(colors.navyMid, 14)} Details
                    </button>
                  )}
                  {(flock.venueId || (flock.venueLat && flock.venueLng)) && (
                    /* By place id when there is one: the coordinate form
                       dropped people at a bare lat,lng pin with no name,
                       hours, or entrance, on the one tap whose whole job is
                       getting them in the door. Coordinates stay as the
                       fallback for a venue with no id. */
                    <button className="hit44 glass-btn glass-navy" onClick={() => openExternal(flock.venueId
                      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(flock.venue || 'venue')}&query_place_id=${flock.venueId}`
                      : `https://maps.google.com/?q=${flock.venueLat},${flock.venueLng}`)} style={{ flex: 1, padding: '10px', background: colors.navyBg, border: 'none', borderRadius: '10px', color: 'white', fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
                      {Icons.mapPin('white', 14)} Directions
                    </button>
                  )}
                </div>
                {/* Check In, on the plan itself, during the night itself. The
                    check-in that feeds the crowd signal lived only behind
                    Explore and venue detail, four taps from the place a
                    person actually is at 9 PM: their plan. Same endpoint and
                    same two-hour done state as the venue page button, read
                    from the same flock_checkin_ key handleCheckIn writes. */}
                {flock.venueId && flock.status === 'confirmed' && (() => {
                  const et = flock.eventTime ? new Date(flock.eventTime).getTime() : NaN;
                  if (!Number.isFinite(et)) return null;
                  const now = Date.now();
                  if (now < et - 3 * 3600 * 1000 || now > et + 6 * 3600 * 1000) return null;
                  const ts = parseInt(localStorage.getItem('flock_checkin_' + flock.venueId) || '0', 10);
                  const checkedIn = ts > 0 && now - ts < 2 * 60 * 60 * 1000;
                  return (
                    <button className="hit44 glass-btn glass-secondary" disabled={checkedIn || checkinSaving} onClick={() => handleCheckIn(flock.venueId)} style={{ width: '100%', marginTop: '8px', padding: '10px', background: 'var(--icon-bg)', border: `1.5px solid ${colors.navyMid}`, borderRadius: '10px', color: colors.navyMid, fontSize: 'var(--t-label)', fontWeight: '600', cursor: checkedIn ? 'default' : 'pointer', opacity: checkedIn ? 0.7 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
                      {Icons.check(colors.navyMid, 14)} {checkedIn ? 'Checked In' : checkinSaving ? 'Checking in…' : 'Check In'}
                    </button>
                  );
                })()}
              </div>
            </div>
          ) : (
            /* Genuine empty state: this flock has not picked anywhere yet, and
               that is the flock's own data, so the mascot earns its place.
               Cobalt Birdie because suggesting places is Birdie's beat. */
            <div style={{ ...styles.card, padding: '16px', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '14px' }}>
              <BirdieStill size={56} style={{ flexShrink: 0 }} />
              <div style={{ minWidth: 0 }}>
                <p style={{ color: colors.navy, fontSize: 'var(--t-body)', margin: '0 0 3px', fontWeight: '600' }}>No venue yet</p>
                <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--t-meta)', margin: 0, lineHeight: 1.45 }}>Suggest places in the chat and vote on where to go.</p>
              </div>
            </div>
          )}

          {/* One venue action, one register: quiet row under the venue block.
              Replaces the old Chat / Change Venue tile pair. Chat's primary
              action is the Open Chat bar pinned below; a second equal tile for
              it said nothing the bar does not. */}
          {!isCompleted && (
            <button className="hit44 glass-btn glass-secondary" onClick={() => {
              if (isCreator) {
                setPickingVenueForFlockId(flock.id); setPickingVenueForCreate(true); setCurrentTab('explore'); setCurrentScreen('main');
              } else {
                setCurrentScreen('chatDetail'); setShowVotePanel(true); loadPopularVenues();
              }
            }} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px', marginBottom: '12px', borderRadius: '12px', border: '1.5px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', cursor: 'pointer', textAlign: 'left' }}>
              {Icons.mapPin(colors.navyMid, 16)}
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', color: colors.navy, fontWeight: '600', fontSize: 'var(--t-label)' }}>{isCreator ? (hasVenue ? 'Change the venue' : 'Pick a venue') : 'Vote on venues'}</span>
                <span style={{ display: 'block', color: 'var(--text-secondary)', fontSize: 'var(--t-meta)' }}>{isCreator ? (hasVenue ? 'Search somewhere new' : 'Search places nearby') : 'Say where you want to go'}</span>
              </span>
              {Icons.chevronRight('var(--text-tertiary)', 14)}
            </button>
          )}

          {/* A finished plan's strongest next action is the same plan again.
              The Past screen already offers this; the detail screen a person
              actually lands on from Messages did not, so a completed flock
              read as a dead end. Same handler and same shape the Past card
              sends. */}
          {(flock.status === 'completed' || flock.status === 'cancelled') && (
            <button
              className="hit44 glass-btn glass-navy"
              aria-label={`Do ${flock.name} again`}
              disabled={rerunningFlockId === flock.id}
              onClick={() => handleRerunFlock({ id: flock.id, event_time: flock.eventTime, name: flock.name })}
              style={{ width: '100%', padding: '12px', marginBottom: '12px', borderRadius: '12px', border: 'none', background: colors.navyMidBg, color: 'white', fontSize: 'var(--t-label)', fontWeight: '600', cursor: rerunningFlockId === flock.id ? 'wait' : 'pointer', opacity: rerunningFlockId === flock.id ? 0.6 : 1 }}
            >{rerunningFlockId === flock.id ? 'Starting…' : 'Do it again'}</button>
          )}

          {flock.status === 'completed' && (
            <button
              className="hit44 glass-btn glass-secondary"
              disabled={recapSharing}
              onClick={() => shareNightRecap(flock)}
              style={{ width: '100%', padding: '12px', marginBottom: '12px', borderRadius: '12px', border: '1.5px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontSize: 'var(--t-label)', fontWeight: '600', cursor: recapSharing ? 'wait' : 'pointer', opacity: recapSharing ? 0.6 : 1 }}
            >{recapSharing ? 'Making the card…' : 'Share the night'}</button>
          )}

          {/* Post-hangout feedback prompt — only after flock is marked done */}
          {isCompleted && hasVenue && flock.venueId && !submittedFeedback.has(flock.id) && (
            <div style={{ ...styles.card, marginBottom: '12px', overflow: 'hidden' }}>
              <p style={{ color: colors.navy, fontSize: 'var(--t-body)', fontWeight: '600', margin: '0 0 10px' }}>How was {flock.venue}?</p>

              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 8px', fontWeight: '500' }}>Was it busy?</p>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
                {[{ level: 1, label: 'Quiet', color: colors.steel, ink: colors.steel }, { level: 2, label: 'Moderate', color: colors.amber, ink: colors.amberText }, { level: 3, label: 'Very Busy', color: colors.red, ink: colors.redText }].map(opt => (
                  <button key={opt.level} className="hit44 glass-btn glass-secondary" onClick={() => setFeedbackState(prev => ({ ...prev, crowdLevel: opt.level }))} style={{ flex: 1, padding: '12px 6px', borderRadius: '10px', border: feedbackState.crowdLevel === opt.level ? `2px solid ${opt.color}` : '1.5px solid var(--border-default)', backgroundColor: feedbackState.crowdLevel === opt.level ? `${opt.color}15` : 'var(--bg-card-solid)', cursor: 'pointer', textAlign: 'center', transition: 'opacity 0.15s ease' }}>
                    <div style={{ width: '8px', height: '8px', borderRadius: '4px', backgroundColor: opt.color, margin: '0 auto 6px' }} />
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: feedbackState.crowdLevel === opt.level ? opt.ink : colors.navy }}>{opt.label}</span>
                  </button>
                ))}
              </div>

              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 8px', fontWeight: '500' }}>Worth the price?</p>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
                {[{ val: true, label: 'Yes', color: colors.steel, ink: colors.steel }, { val: false, label: 'No', color: colors.red, ink: colors.redText }].map(opt => (
                  <button key={String(opt.val)} className="hit44 glass-btn glass-secondary" onClick={() => setFeedbackState(prev => ({ ...prev, priceWorth: opt.val }))} style={{ flex: 1, padding: '12px 6px', borderRadius: '10px', border: feedbackState.priceWorth === opt.val ? `2px solid ${opt.color}` : '1.5px solid var(--border-default)', backgroundColor: feedbackState.priceWorth === opt.val ? `${opt.color}15` : 'var(--bg-card-solid)', cursor: 'pointer', textAlign: 'center', transition: 'opacity 0.15s ease' }}>
                    <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: feedbackState.priceWorth === opt.val ? opt.ink : colors.navy }}>{opt.label}</span>
                  </button>
                ))}
              </div>

              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 8px', fontWeight: '500' }}>Rate it (optional)</p>
              {/* System stars, same pattern as the venue review form: each
                  button names its number (five buttons all reading "Rate" give
                  a screen reader nothing to pick between), aria-pressed carries
                  the selection, and the empty state is --text-tertiary because
                  an INPUT star has to read as a real outline to aim at. */}
              <div style={{ display: 'flex', gap: '4px', marginBottom: '16px' }}>
                {[1, 2, 3, 4, 5].map(star => (
                  <button aria-label={`Rate ${star} star${star === 1 ? '' : 's'}`} aria-pressed={feedbackState.rating === star} className="hit44" key={star} onClick={() => setFeedbackState(prev => ({ ...prev, rating: prev.rating === star ? null : star }))} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', transition: 'opacity 0.15s ease' }}>
                    {feedbackState.rating >= star ? Icons.starFilled(colors.amber, 22) : Icons.star('var(--text-tertiary)', 22)}
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  disabled={!feedbackState.crowdLevel || feedbackSubmitting}
                  onClick={async () => {
                    setFeedbackSubmitting(true);
                    try {
                      const filed = await submitVenueFeedback({
                        flock_id: flock.id,
                        venue_place_id: flock.venueId,
                        venue_name: flock.venue,
                        crowd_level: feedbackState.crowdLevel,
                        price_worth: feedbackState.priceWorth,
                        rating: feedbackState.rating,
                        predicted_score: crowdPredictions[flock.venueId]?.score || null,
                      });
                      rememberFeedbackDone(flock.id);
                      setFeedbackState({ crowdLevel: null, priceWorth: null, rating: null });
                      // The route returns `verified` for exactly this, and its
                      // own comment says why: "the submitter is told whether
                      // their report will count, rather than being thanked for
                      // something that was filed and ignored." This screen
                      // thanked everybody the same way. It matters most on the
                      // majority path: a host who never slides "done" gets the
                      // flock completed by the 12 hour sweep, which is the same
                      // 12 hours the verification window allows, so a report
                      // left the next morning is unverified by construction and
                      // every reader drops it. Same two sentences the venue
                      // card already uses.
                      showToast(filed?.verified
                        ? 'Thanks. Real reports sharpen the forecast for everyone.'
                        : 'Thanks. Reports from a night here with your flock go into the forecast; this one is noted.');
                    } catch (err) {
                      console.error('[Feedback] Submit error:', err);
                      showToast(err?.message || "That didn't send. Try again.", 'error');
                    } finally {
                      setFeedbackSubmitting(false);
                    }
                  }}
                  className="hit44 glass-btn glass-primary" style={{ flex: 1, padding: '11px', borderRadius: '10px', border: 'none', background: feedbackState.crowdLevel ? colors.navyBg : 'var(--border-default)', color: feedbackState.crowdLevel ? 'white' : 'var(--text-tertiary)', fontSize: 'var(--t-label)', fontWeight: '600', cursor: feedbackState.crowdLevel ? 'pointer' : 'not-allowed', opacity: feedbackSubmitting ? 0.6 : 1 }}
                >
                  {feedbackSubmitting ? 'Submitting...' : 'Submit'}
                </button>
                <button className="hit44 glass-btn glass-secondary" onClick={() => rememberFeedbackDone(flock.id)} style={{ padding: '11px 18px', borderRadius: '10px', border: '1.5px solid var(--border-default)', background: 'var(--bg-card-solid)', color: 'var(--text-secondary)', fontSize: 'var(--t-label)', fontWeight: '600', cursor: 'pointer' }}>
                  Skip
                </button>
              </div>
            </div>
          )}

          {/* ── The sheet ── Going, votes and details share one ruled surface:
              full-bleed rules divide the sections and no row wears an
              icon-in-a-rounded-square chip. Rule lines, not floating cards. */}
          <div style={{ ...styles.card, padding: '2px 16px' }}>
          <div style={{ padding: '10px 0 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <h4 style={{ color: colors.navy, margin: 0, fontSize: 'var(--t-body)', fontWeight: '700' }}>
                Going ({goingCount})
              </h4>
              <button className="hit44 glass-btn glass-navy" onClick={() => { setCurrentScreen('chatDetail'); setTimeout(() => { setShowFlockInviteModal(true); setCopiedInviteUrl(''); setFlockInviteSelected([]); setFlockInviteSearch(''); }, 100); }} style={{ padding: '5px 12px', background: colors.navyBg, border: 'none', borderRadius: '16px', color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
                {Icons.userPlus('white', 12)} Invite
              </button>
            </div>
            {roster.length > 0 ? (
              <div style={{ display: 'flex', gap: '12px', overflowX: 'auto', paddingBottom: '4px' }}>
                {roster.map((member, i) => {
                  const mName = typeof member === 'string' ? member : (member.name || 'User');
                  const mImage = typeof member === 'object' ? member.image : null;
                  const initial = mName[0]?.toUpperCase() || '?';
                  const isGuest = typeof member === 'object' && member.isGuest === true;
                  const mId = typeof member === 'object' ? member.id : null;
                  // The roster is the whole point of the person card: these are
                  // people you share a plan with who may never have typed a
                  // word, and before this there was nothing to tap. You cannot
                  // report yourself, so your own face stays plain.
                  const canOpen = !isGuest && mId != null && String(mId) !== String(authUser?.id);
                  // A guest gets the report sheet instead of the person card.
                  // There is no account behind them so there is nothing to
                  // block and no profile to open, but the NAME is user-written,
                  // unauthenticated, and broadcast live to everyone in the
                  // flock. It is the one piece of content here a stranger can
                  // put in front of you, and this roster is the only place it
                  // is shown, so it is the only place a takedown can start.
                  // guestId, not a re-parse of the namespaced id: the roster
                  // mapping is the one place that derives it, so there is a
                  // single thing to fix if the server's shape ever moves.
                  const guestReportId = isGuest ? (member.guestId ?? null) : null;
                  const canReport = guestReportId != null;
                  const tappable = canOpen || canReport;
                  const bgColors = [colors.navy, colors.navyMid, colors.steel, colors.amber, '#4a7ba7', '#ec4899'];
                  const boxStyle = { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '5px', minWidth: '54px' };
                  const inner = (
                    <>
                      {mImage ? (
                        <img src={mImage} alt="" style={{ width: '44px', height: '44px', borderRadius: '50%', objectFit: 'cover', border: '2px solid var(--bg-card-solid)', boxShadow: '0 2px 6px rgba(0,0,0,0.1)' }} />
                      ) : (
                        <div style={{ width: '44px', height: '44px', borderRadius: '50%', background: bgColors[i % bgColors.length], display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: '600', fontSize: 'var(--t-body)', border: '2px solid var(--bg-card-solid)', boxShadow: '0 2px 6px rgba(0,0,0,0.1)' }}>{initial}</div>
                      )}
                      <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', textAlign: 'center', maxWidth: '56px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: '500' }}>{mName.split(' ')[0]}</span>
                      {isGuest && <span style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-tertiary)', letterSpacing: '0.3px' }}>GUEST</span>}
                    </>
                  );
                  const rowKey = typeof member === 'object' && member.id != null ? String(member.id) : i;
                  return tappable ? (
                    <button
                      key={rowKey}
                      className="hit44"
                      aria-label={canOpen ? `About ${mName}` : `Report guest ${mName}`}
                      onClick={canOpen
                        ? () => openUserProfile({ id: mId, name: mName, image: mImage })
                        // No userId: there is no Flock account behind a guest, so
                        // the sheet correctly renders Report without Block.
                        : () => setModerationTarget({ userName: mName, contentType: 'guest_rsvp', contentId: guestReportId })}
                      style={{ ...boxStyle, background: 'none', border: 'none', padding: 0, cursor: 'pointer', flexShrink: 0 }}
                    >
                      {inner}
                    </button>
                  ) : (
                    <div key={rowKey} style={{ ...boxStyle, flexShrink: 0 }}>{inner}</div>
                  );
                })}
                {/* Roster empty-ish state: one accepted person and it is you.
                    The warm bird keeps the flock's own space warm; the copy
                    stays a fact, not a plea. */}
                {justYou && (
                  <div style={{ display: 'flex', alignItems: 'center', alignSelf: 'center', gap: '10px', paddingLeft: '4px', minWidth: 0 }}>
                    <BirdieStill bird={WARM_BIRD} size={54} style={{ flexShrink: 0 }} />
                    <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--t-meta)', margin: 0, lineHeight: 1.45 }}>Just you so far. Friends you invite land here.</p>
                  </div>
                )}
              </div>
            ) : rosterError ? (
              <div style={{ textAlign: 'center', padding: '8px 0' }}>
                <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--t-meta)', margin: '0 0 6px' }}>Couldn't load who's going.</p>
                <button className="hit44" onClick={retryRoster} style={{ minHeight: '44px', padding: '8px 14px', borderRadius: '10px', border: '1px solid var(--border-mid)', background: 'transparent', color: 'var(--text-primary)', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>Try again</button>
              </div>
            ) : (
              <p style={{ color: 'var(--text-tertiary)', fontSize: 'var(--t-meta)', margin: 0, textAlign: 'center', padding: '8px 0' }}>Loading members...</p>
            )}
          </div>

          {/* Venue votes — the flock-detail venue action itself moved up under
              the venue card, and chat's action is the Open Chat bar below. */}
          {flock.votes && flock.votes.length > 0 && (
            <>
            <div style={{ height: '1px', background: 'var(--border-default)', margin: '0 -16px' }} />
            <div style={{ padding: '12px 0 6px' }}>
              <h4 style={{ color: colors.navy, margin: '0 0 4px', fontSize: 'var(--t-body)', fontWeight: '700' }}>Venue votes</h4>
              {flock.votes.map((v, vi) => {
                const myVote = flock.votes.find(vt => vt.voters.includes('You'))?.venue || null;
                const isMyVote = myVote === v.venue;
                const count = voteTotal(v);
                // THE ROW SAID IT WAS A TOGGLE AND ONLY EVER TOGGLED ON.
                // `aria-pressed` promises a two-way control, and the old handler
                // kept 'You' where it already was, so tapping the venue you had
                // voted for rebuilt an identical list, re-POSTed the same vote,
                // and the server answered "unchanged". Nothing moved, nothing
                // was said, and the one screen a host reads the tally on had no
                // way to take a vote back. The chat's vote panel has always had
                // one, which is why this went unnoticed: the same person, the
                // same flock, two screens, two behaviours.
                //
                // Same three lines as handleUnvote in ChatDetail.js, on purpose.
                // Stripping the last voter drops the row because a venue with no
                // votes and no guests is not in the server's tally either, so
                // leaving it would be a row that vanishes on the next load.
                return (
                  <button key={v.venue} className="hit44 glass-btn" aria-pressed={isMyVote} onClick={() => {
                    const newVotes = isMyVote
                      ? flock.votes
                        .map(vt => ({ ...vt, voters: vt.voters.filter(x => x !== 'You') }))
                        .filter(vt => vt.voters.length > 0 || (vt.guestCount || 0) > 0)
                      : flock.votes.map(vt => ({ ...vt, voters: vt.venue === v.venue ? [...vt.voters, 'You'] : vt.voters.filter(x => x !== 'You') }));
                    updateFlockVotes(selectedFlockId, newVotes);
                  }} style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', borderBottom: vi < flock.votes.length - 1 ? '1px solid var(--border-subtle)' : 'none', padding: '10px 0', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, display: 'flex', alignItems: 'center', gap: '5px' }}>{isMyVote && Icons.check(colors.steel, 12)}{v.venue}</span>
                      {v.type && <span style={{ display: 'block', fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0' }}>{v.type}</span>}
                      <span style={{ display: 'block', fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '2px 0 0' }}>{[v.voters.join(', '), (v.guestCount || 0) > 0 ? `${v.guestCount} guest${v.guestCount !== 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ')}</span>
                    </span>
                    {/* navyMidBg, not navyBg: in dark mode navyBg equals
                        --bg-tertiary, so the voted pill would match the
                        unvoted one exactly. navyMidBg differs in both themes. */}
                    <span style={{ padding: '4px 12px', borderRadius: '14px', fontSize: 'var(--t-meta)', fontWeight: '600', backgroundColor: isMyVote ? colors.navyMidBg : 'var(--bg-tertiary)', color: isMyVote ? 'white' : colors.navy, flexShrink: 0 }}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
            </>
          )}

          {/* Details: a ruled label/value list. No icon chips; the labels do
              the work and the rules keep the rows apart. */}
          <div style={{ height: '1px', background: 'var(--border-default)', margin: '0 -16px' }} />
          <div style={{ padding: '12px 0 4px' }}>
            <h4 style={{ color: colors.navy, margin: 0, fontSize: 'var(--t-body)', fontWeight: '700' }}>Details</h4>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 0', borderBottom: '1px solid var(--border-subtle)' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--t-label)', fontWeight: '500', flexShrink: 0 }}>Created by</span>
              <span style={{ flex: 1, textAlign: 'right', color: colors.navy, fontSize: 'var(--t-label)', fontWeight: '600', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{flock.host}</span>
            </div>
            {/* WHEN. Always shown, and the creator can change it here. This
                row is the only place in the app where a flock's time can be
                set after it was created. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 0', borderBottom: '1px solid var(--border-subtle)', minHeight: '44px', boxSizing: 'border-box' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--t-label)', fontWeight: '500', flexShrink: 0 }}>When</span>
              <span style={{ flex: 1, textAlign: 'right', color: colors.navy, fontSize: 'var(--t-label)', fontWeight: '600', minWidth: 0 }}>
                {flock.eventTime
                  ? new Date(flock.eventTime).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                  : (flock.time && flock.time !== 'TBD' ? flock.time : 'Not set yet')}
              </span>
              {isCreator && !isCompleted && (
                <button className="hit44 glass-btn glass-secondary" onClick={() => {
                  const when = flock.eventTime ? new Date(flock.eventTime) : null;
                  if (when && !isNaN(when.getTime())) {
                    const h = when.getHours();
                    const label = `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}`;
                    const hourLabel = FLOCK_HOUR_CHOICES.includes(label) ? label : '9 PM';
                    setTimeEditHour(hourLabel);
                    // The plan's own day, not 'Tonight': see dayChipFor above.
                    setTimeEditDay(dayChipFor(resolveEventTime, FLOCK_DAY_CHOICES, when, hourLabel));
                  } else {
                    setTimeEditHour('9 PM');
                    setTimeEditDay('Tonight');
                  }
                  setShowTimeEditor(true);
                }} style={{ padding: '7px 12px', borderRadius: '10px', border: '1px solid var(--border-mid)', backgroundColor: 'transparent', color: colors.navy, fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer', flexShrink: 0 }}>
                  {flock.eventTime ? 'Change' : 'Set time'}
                </button>
              )}
            </div>
            {/* STATUS, and the control that changes it. The row used to be a
                read-only label, and the only other confirm control in the app
                was hidden behind the vote panel and hidden again on the venue
                that was already assigned. So a host who picked a venue from
                search rather than from a vote had no way to lock a plan in at
                all, and every flock stayed in planning forever. Creator only,
                because PUT /api/flocks/:id is. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 0', minHeight: '44px', boxSizing: 'border-box' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--t-label)', fontWeight: '500', flexShrink: 0 }}>Status</span>
              <span style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: '5px', color: colors.navy, fontSize: 'var(--t-label)', fontWeight: '600' }}>
                {isCompleted ? Icons.check('var(--accent-green-text)', 12) : isConfirmed ? Icons.check('var(--accent-green-text)', 12) : Icons.clock('var(--accent-amber-text)', 12)} {isCompleted ? 'Done' : isConfirmed ? 'Locked In' : 'Still Planning'}
              </span>
              {isCreator && !isConfirmed && !isCompleted && hasVenue && (
                <button className="hit44 glass-btn glass-primary" disabled={confirmingPlan} onClick={async (e) => {
                  confirmClick(e);
                  setConfirmingPlan(true);
                  try { await confirmFlockPlan(flock.id); } finally { setConfirmingPlan(false); }
                }} style={{ padding: '7px 12px', borderRadius: '10px', border: 'none', background: colors.navyBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer', flexShrink: 0, opacity: confirmingPlan ? 0.6 : 1 }}>
                  {confirmingPlan ? 'Locking...' : 'Lock it in'}
                </button>
              )}
            </div>
            {/* Said before the tap, not after it. Locking a plan sends every
                other member a push, and it is what makes the slide-to-done bar
                and the attendance step exist at all. */}
            {isCreator && !isConfirmed && !isCompleted && (
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '0 0 4px' }}>
                {hasVenue
                  ? 'Locking it in tells everyone the plan is on, and unlocks the done step afterwards.'
                  : 'Pick a venue and you can lock the plan in.'}
              </p>
            )}
          </div>
          </div>

        </div>

        {/* ── When editor ── */}
        {showTimeEditor && (
          <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setShowTimeEditor(false); }} style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-end', zIndex: 60 }}>
            <DialogBehavior onClose={() => setShowTimeEditor(false)} label="Change the time" />
            <div className="modal-content" style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '20px 20px 0 0', padding: '20px', paddingBottom: 'calc(20px + var(--safe-bottom))', width: '100%' }}>
              <div style={{ width: '40px', height: '4px', backgroundColor: 'var(--pill-bg)', borderRadius: '2px', margin: '0 auto 16px' }} />
              <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 4px' }}>When are you going?</h3>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 14px' }}>Everyone in the flock sees the new time, and it moves on your Plans calendar.</p>

              <label style={{ display: 'block', fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, marginBottom: '6px' }}>Day</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '14px' }}>
                {[...FLOCK_DAY_CHOICES, ...(isDateKey(timeEditDay) ? [timeEditDay] : [])].map(d => (
                  <button className="hit44" key={d} onClick={() => setTimeEditDay(d)} style={{ padding: '10px', borderRadius: '10px', border: timeEditDay === d ? `2px solid ${colors.steel}` : '1.5px solid var(--border-default)', backgroundColor: timeEditDay === d ? 'rgba(45,90,135,0.12)' : 'var(--bg-card-solid)', color: 'var(--text-primary)', fontWeight: '600', fontSize: 'var(--t-label)', cursor: 'pointer' }}>{dayChipLabel(d)}</button>
                ))}
              </div>

              <label style={{ display: 'block', fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, marginBottom: '6px' }}>Time</label>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
                {FLOCK_HOUR_CHOICES.map(t => (
                  <button className="hit44" key={t} onClick={() => setTimeEditHour(t)} style={{ padding: '6px 14px', borderRadius: '20px', border: timeEditHour === t ? `2px solid ${colors.steel}` : '1.5px solid var(--border-default)', backgroundColor: timeEditHour === t ? 'rgba(45,90,135,0.12)' : 'var(--bg-card-solid)', color: 'var(--text-primary)', fontWeight: '600', fontSize: 'var(--t-meta)', cursor: 'pointer' }}>{t}</button>
                ))}
              </div>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '0 0 16px', fontWeight: '500' }}>
                {resolveEditTime(resolveEventTime, timeEditDay, timeEditHour).toLocaleString([], { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </p>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="hit44 glass-btn glass-secondary" onClick={() => setShowTimeEditor(false)} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: '1px solid var(--border-mid)', backgroundColor: 'var(--bg-card-solid)', color: colors.navy, fontWeight: '600', fontSize: 'var(--t-body)', cursor: 'pointer' }}>Cancel</button>
                <button className="hit44 glass-btn glass-navy" disabled={savingEventTime} onClick={async () => {
                  setSavingEventTime(true);
                  try {
                    await saveFlockEventTime(flock.id, resolveEditTime(resolveEventTime, timeEditDay, timeEditHour).toISOString());
                    setShowTimeEditor(false);
                    showToast('Time updated');
                  } catch (err) {
                    showToast(err.message || 'Could not save the time', 'error');
                  } finally {
                    setSavingEventTime(false);
                  }
                }} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: 'none', background: colors.navyMidBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-body)', cursor: 'pointer', opacity: savingEventTime ? 0.6 : 1 }}>
                  {savingEventTime ? 'Saving...' : 'Save time'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Bottom CTA ── */}
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '14px', background: `linear-gradient(transparent, var(--bg-primary) 30%)`, pointerEvents: 'none' }}>
          <button className="hit44 glass-btn glass-navy" onClick={() => setCurrentScreen('chatDetail')} style={{ width: '100%', padding: '14px', background: colors.navyBg, border: 'none', borderRadius: '14px', color: 'white', fontSize: 'var(--t-body)', fontWeight: '600', cursor: 'pointer', boxShadow: '0 6px 20px rgba(13,40,71,0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', pointerEvents: 'auto' }}>
            {Icons.chat('white', 18)} Open Chat
          </button>
        </div>

      </div>
    );
}
