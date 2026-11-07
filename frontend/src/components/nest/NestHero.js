/**
 * THE HERO: TONIGHT'S PLAN, OR THE NEXT ONE.
 *
 * The one filled card on the Nest, so it is the first thing found and the
 * thing remembered. It holds four facts a person can take in at a glance,
 * when, what, where and who, because a plan with a time and a place is the
 * one that happens; and at most one button, the thing this plan needs from
 * the reader, so an open loop closes in one tap. No countdown: the time is
 * the real time.
 *
 * THE PLAN'S NAME IS A HEADING, AND THE CARD IS STILL ONE TAP. The card is a
 * <section> named by its <h2>, and the button that opens the plan sits inside
 * that heading and holds the name alone. Its tap area is stretched over the
 * whole card (index.css .nest-stretch), so a tap anywhere on the card opens
 * the plan, as before. The name had been a span inside one big button whose
 * aria-label read the card out: a button's children are presentational, so
 * VoiceOver's rotor found no heading to move between plans, the label hid the
 * names line and the note, and it started with the name while the card
 * starts with the time. Now the button's name is the words it shows, and the
 * time, the status, the place, the names and the note are its description,
 * read in the card's own order. The action is a second button above the
 * stretched area, never a button inside a button.
 *
 * The keyboard ring is drawn inside the card in near-white
 * (.nest-stretch--hero, .nest-on-navy): the app's steel ring measures 1.89:1
 * on this navy in light mode, under the 3:1 a focus indicator needs.
 *
 * THE SECOND ACCENT, BLUSH (index.css --accent-blush). A plan that is locked
 * in says so on a blush pill under navy words and check, where a plan still
 * voting says its status in plain words. The faces of the people in the plan
 * wear a blush ring wherever they have a ring at all, so the card shows who is
 * in as well as that it is on; the "+N" keeps the card's navy. Blush on this
 * navy and navy on blush both measure 9.63:1 (7.62:1 on the dark navy).
 *
 * The other plans on the same night sit in one white group under it, each a
 * row whose name is a heading too, with the reader's own state on its chip.
 *
 * Every word comes in as a prop: App.js picks the plan (lib/nestTime.js
 * pickHero) and the words (lib/nestHero.js), and owns every tap.
 */
import React, { useEffect, useState } from 'react';
import Icons from '../ui/Icons';
import { FaceRow } from './Face';
import NestChip from './NestChip';
import { takeLockMoment } from '../../lib/nestHero';
import { lsGet, lsSet } from '../../lib/storage';
import { HERO_GAP } from './nestBand';

const LOCK_STORE = { get: lsGet, set: lsSet };

// The heading keeps the type it had as a span; the button inside it inherits
// all of it (index.css .nest-stretch resets the button's own).
const headingReset = { margin: 0, padding: 0 };

// The Locked in pill. Its 3px above and below is given back by the same
// negative margin, so the row keeps its height and the time beside it and the
// name under it sit where they sit without the pill.
const LOCKED_PILL = {
  backgroundColor: 'var(--accent-blush)',
  color: 'var(--on-accent-blush)',
  borderRadius: '999px',
  padding: '3px 10px 3px 8px',
  margin: '-3px 0',
};

export default function NestHero({
  flock,
  when,
  status,
  place,
  faces,
  total,
  names,
  note,
  action,
  onOpen,
  onAction,
  sameNight = [],
  onLockMoment,
}) {
  // THE ONE DESIGNED MOMENT. The first time this device shows a plan locked
  // in, while the lock is news, the status fades in, the name settles from a
  // little below, and the phone gives one buzz: the peak of planning a night,
  // marked once (lib/nestHero.js takeLockMoment, which reads the plan's own
  // confirmedAt). Under Reduce Motion only the fade.
  const lockId = flock && status && status.key === 'locked' ? flock.id : null;
  const lockedAt = flock ? flock.confirmedAt || null : null;
  const [settle, setSettle] = useState(false);
  useEffect(() => {
    if (lockId == null || !takeLockMoment(lockId, LOCK_STORE, { lockedAt })) return;
    setSettle(true);
    if (onLockMoment) onLockMoment();
  }, [lockId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!flock) return null;
  const locked = Boolean(status && status.key === 'locked');
  const base = `nest-hero-${flock.id}`;
  const ids = {
    title: base,
    when: `${base}-when`,
    status: `${base}-status`,
    place: `${base}-place`,
    names: `${base}-names`,
    note: `${base}-note`,
  };
  // What the open button says after its name, in the order the card shows it.
  const described = [ids.when, status && ids.status, ids.place, ids.names, note && ids.note].filter(Boolean).join(' ');
  return (
    <div data-nest-band="hero" style={{ marginBottom: HERO_GAP }}>
      <section
        data-nest-plan={flock.id}
        aria-labelledby={ids.title}
        style={{
          position: 'relative',
          isolation: 'isolate',
          backgroundColor: 'var(--nest-hero-bg)',
          color: 'var(--nest-hero-ink)',
          borderRadius: '16px',
          padding: '18px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' }}>
          <span id={ids.when} style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--nest-hero-ink)', minWidth: 0 }}>{when}</span>
          {status && (
            <span
              id={ids.status}
              data-nest-hero-status={status.key}
              className={settle ? 'nest-lock-fade' : undefined}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', flexShrink: 0, fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--nest-hero-meta)', whiteSpace: 'nowrap', ...(locked ? LOCKED_PILL : null) }}
            >
              {locked && Icons.check('var(--on-accent-blush)', 13)}
              {status.label}
            </span>
          )}
        </div>
        <h2
          id={ids.title}
          style={{
            ...headingReset,
            marginTop: '6px',
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--t-display)',
            fontWeight: '600',
            lineHeight: 1.15,
            letterSpacing: '-0.01em',
            color: 'var(--nest-hero-ink)',
            overflowWrap: 'anywhere',
          }}
        >
          <button type="button" className="nest-stretch nest-stretch--hero" onClick={onOpen} aria-describedby={described}>
            {/* The settle moves this span, never an ancestor of the button:
                a transform on one would shrink the stretched tap area to it.
                It takes the heading's face from index.css .nest-stretch *;
                the app's * rule would set it in the body face. */}
            <span className={settle ? 'nest-lock-settle' : undefined} style={{ display: 'inline-block' }}>{flock.name}</span>
          </button>
        </h2>
        <p id={ids.place} style={{ margin: '3px 0 0', fontSize: 'var(--t-body)', fontWeight: '400', color: 'var(--nest-hero-meta)' }}>{place}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '14px', minWidth: 0 }}>
          <FaceRow people={faces} total={total} size={28} ring="var(--nest-hero-bg)" faceRing="var(--accent-blush)" bg="var(--nest-hero-face)" ink="var(--nest-hero-ink)" />
          <span id={ids.names} style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--nest-hero-meta)', minWidth: 0 }}>{names}</span>
        </div>
        {note && (
          <p id={ids.note} style={{ margin: '12px 0 0', fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--nest-hero-meta)' }}>{note}</p>
        )}
        {action && (
          <button
            type="button"
            className="nest-raise nest-on-navy"
            onClick={onAction}
            style={{
              marginTop: '16px',
              width: '100%',
              minHeight: '44px',
              padding: '0 14px 0 16px',
              border: 'none',
              borderRadius: '12px',
              backgroundColor: 'var(--nest-hero-action-bg)',
              color: 'var(--nest-hero-action-fg)',
              fontSize: 'var(--t-body)',
              fontWeight: '600',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '10px',
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            <span style={{ minWidth: 0 }}>{action.label}</span>
            {Icons.chevronRight('var(--nest-hero-action-fg)', 16)}
          </button>
        )}
      </section>
      {sameNight.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', overflow: 'hidden' }}>
          {sameNight.map((row, i) => {
            const rowId = `nest-same-${row.id}`;
            return (
              <li
                key={row.id}
                data-nest-plan={row.id}
                style={{
                  position: 'relative',
                  isolation: 'isolate',
                  minHeight: '60px',
                  boxSizing: 'border-box',
                  padding: '11px 14px 11px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                }}
              >
                {i > 0 && <span aria-hidden="true" style={{ position: 'absolute', top: 0, left: '16px', right: 0, height: '1px', backgroundColor: 'var(--divider)' }} />}
                <span style={{ flex: 1, minWidth: 0 }}>
                  <h3 style={{ ...headingReset, fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
                    <button type="button" className="nest-stretch nest-stretch--row" onClick={row.onClick} aria-describedby={`${rowId}-line${row.chip ? ` ${rowId}-chip` : ''}`}>{row.name}</button>
                  </h3>
                  <span id={`${rowId}-line`} style={{ display: 'block', marginTop: '2px', fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-secondary)' }}>{row.line}</span>
                </span>
                <NestChip chip={row.chip} id={`${rowId}-chip`} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
