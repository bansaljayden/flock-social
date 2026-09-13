/**
 * PAST FLOCKS SCREEN
 *
 * Completed and cancelled plans, each one tap from happening again. Reached
 * from the Your Flocks header on Home and from the Nest's empty state.
 *
 * It was 108 lines of App.js, declared as an arrow function inside
 * FlockAppInner and CALLED rather than mounted, which is the same shape the
 * venue dashboard, the flock chat, the DM thread, Add Friends, the profile
 * and settings screen, the flock detail screen and the create screen were in
 * before they moved out. App.js is 85% of the boot chunk, and every byte of
 * this screen was downloaded by people who never open it.
 *
 * WHY THIS ONE IS LAZY
 *
 * currentScreen starts at 'main' (or 'nfcCheckin' on a tag), never at
 * 'pastFlocks', and nothing routes here from a URL, so this screen cannot be
 * on screen at first paint. It is reached by a deliberate tap on Home, two
 * taps deep, and the idle prefetch in App.js warms the chunk once the Nest
 * has painted, so that tap resolves from the module cache and renders in the
 * same commit. The boot path gets the saving and the screen still opens
 * instantly.
 *
 * WHY EVERYTHING ARRIVES AS A PROP
 *
 * The old arrow function closed over 14 names. Eleven are declared in
 * FlockAppInner or at App.js module scope: the three pieces of past-flocks
 * state, the loader, the rerun handler and the in-flight id behind it, the
 * navigation setter, the themed colors and styles objects, and the two
 * shared components App.js keeps for screens other than this one. Those are
 * the parameters below, built at the call site with object shorthand so the
 * name there and the parameter here cannot drift apart. The other three
 * (BirdNote, WARM_BIRD, Icons) are module imports App.js already pulls from
 * '../components/ui/BirdieBird' and '../components/ui/Icons', so this file
 * imports them straight from the source rather than taking them as props.
 * The list came from a Babel scope walk of the block, every referenced
 * identifier whose binding resolves outside it, not from reading the page.
 *
 * No hook is called anywhere in the block, so nothing about the move changes
 * hook order in FlockAppInner.
 *
 * The state and the effects behind these props deliberately did NOT move.
 * They live in FlockAppInner, which does not unmount when the user leaves
 * this screen, so a loaded history and a rerun already in flight survive a
 * trip elsewhere exactly as they did before.
 *
 * The body below is the old block verbatim, including its original
 * four-space indentation, so it can be diffed against the deleted lines
 * character for character. Nothing was renamed, reformatted or improved on
 * the way across, and no defect was fixed in transit: this is a move.
 */
import React from 'react';
import { BirdNote, WARM_BIRD } from '../components/ui/BirdieBird';
import Icons from '../components/ui/Icons';

export default function PastFlocksScreen({
  // Declared at App.js module scope and shared with screens other than this
  // one, so they stay declared there and arrive here.
  DialogBehavior,
  ListSkeleton,
  // Everything else is declared in FlockAppInner and stays declared there.
  colors,
  handleRerunFlock,
  loadPastFlocks,
  pastFlocks,
  pastFlocksError,
  pastFlocksLoading,
  rerunningFlockId,
  setCurrentScreen,
  styles,
}) {
    const currentYear = new Date().getFullYear();
    const formatPastDate = (iso) => {
      if (!iso) return null;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return null;
      const opts = { month: 'short', day: 'numeric' };
      if (d.getFullYear() !== currentYear) opts.year = 'numeric';
      return d.toLocaleDateString('en-US', opts);
    };
    return (
      <div key="past-flocks-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--bg-primary)' }}>
        <DialogBehavior modal={false} onClose={() => setCurrentScreen('main')} />
        <div style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid var(--divider)', backgroundColor: 'var(--bg-card-solid)', flexShrink: 0 }}>
          <button aria-label="Back" className="hit44" onClick={() => setCurrentScreen('main')} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'transparent', color: colors.navy, fontSize: 'var(--t-title)', cursor: 'pointer' }}>←</button>
          <h1 style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.005em', fontSize: 'var(--t-title)', fontWeight: '600', color: colors.navy, margin: 0 }}>Past flocks</h1>
        </div>

        <div style={{ flex: 1, padding: '16px', overflowY: 'auto' }}>
          {pastFlocksLoading && !pastFlocks && <ListSkeleton label="Loading past flocks" />}

          {!pastFlocksLoading && pastFlocksError && (
            <div style={{ ...styles.card, marginBottom: '10px' }}>
              {/* A bird beside a failure, not instead of one. The copy still
                  says the read failed and the retry is still the action; the
                  bird is company. */}
              <BirdNote
                layout="row"
                size={48}
                bird={WARM_BIRD}
                role="alert"
                title={pastFlocksError}
                body="Nothing has been lost. Your finished flocks are still there."
                action={<button className="hit44 glass-btn glass-navy" onClick={loadPastFlocks} style={{ padding: '10px 16px', borderRadius: '10px', border: 'none', background: colors.navyMidBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-label)', cursor: 'pointer' }}>Try again</button>}
              />
            </div>
          )}

          {/* A claim about the user's history, so it waits for a fetch that
              actually landed (pastFlocks stays null until one does). */}
          {!pastFlocksLoading && !pastFlocksError && pastFlocks && pastFlocks.length === 0 && (
            <BirdNote
              size={96}
              bird={WARM_BIRD}
              title="Nothing here yet"
              body="A flock lands here once its night has been and gone."
              style={{ marginTop: '36px' }}
            />
          )}

          {/* Not gated on the error flag: a failed refresh must not delete the
              list on screen. The error card above says the refresh missed. */}
          {pastFlocks && pastFlocks.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {pastFlocks.map(pf => {
                const dateLabel = formatPastDate(pf.event_time);
                const members = Array.isArray(pf.members) ? pf.members : [];
                const busy = rerunningFlockId === pf.id;
                const cancelled = pf.status === 'cancelled';
                return (
                  <div key={pf.id} style={{ padding: '14px 16px', borderRadius: '14px', border: '1px solid var(--border-default)', backgroundColor: 'var(--bg-card-solid)', boxShadow: 'var(--card-shadow-sm)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', marginBottom: '8px' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <h3 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: 0, lineHeight: 1.2 }}>{pf.name}</h3>
                        {pf.venue_name && (
                          <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '3px 0 0', display: 'flex', alignItems: 'center', gap: '3px' }}>{Icons.mapPin(colors.textSecondary, 12)} {pf.venue_name}</p>
                        )}
                      </div>
                      <span style={{ fontSize: 'var(--t-meta)', padding: '3px 8px', borderRadius: '10px', fontWeight: '500', flexShrink: 0, whiteSpace: 'nowrap', backgroundColor: 'var(--icon-bg)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '3px' }}>
                        {cancelled ? Icons.x('var(--text-secondary)', 12) : Icons.check('var(--text-secondary)', 12)} {cancelled ? 'Cancelled' : 'Happened'}
                      </span>
                    </div>
                    {/* flexWrap: at 320px a full avatar stack + date + button
                        cannot share one line; the button wraps under instead
                        of pushing the card into horizontal overflow. */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                        <div style={{ display: 'flex', flexShrink: 0 }}>
                          {members.slice(0, 4).map((m, j) => (
                            <div key={m.id ?? j} style={{ width: '24px', height: '24px', borderRadius: '50%', border: '2px solid var(--bg-card-solid)', backgroundColor: colors.navyMidBg, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginLeft: j > 0 ? '-6px' : 0 }}>
                              {m.profile_image_url
                                ? <img src={m.profile_image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                : <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'white' }}>{m.name?.[0]?.toUpperCase() || '?'}</span>}
                            </div>
                          ))}
                          {members.length > 4 && <div style={{ width: '24px', height: '24px', borderRadius: '50%', border: '2px solid var(--bg-card-solid)', backgroundColor: 'var(--icon-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, marginLeft: '-6px' }}>+{members.length - 4}</div>}
                        </div>
                        {dateLabel && <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', padding: '2px 8px', borderRadius: '10px', backgroundColor: 'var(--icon-bg)', color: colors.navy, whiteSpace: 'nowrap' }}>{dateLabel}</span>}
                      </div>
                      <button
                        className="hit44 glass-btn glass-navy"
                        aria-label={`Do ${pf.name} again`}
                        disabled={busy}
                        onClick={() => handleRerunFlock(pf)}
                        style={{ padding: '8px 14px', borderRadius: '10px', border: 'none', background: colors.navyMidBg, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1, flexShrink: 0 }}
                      >{busy ? 'Starting…' : 'Do it again'}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
}
