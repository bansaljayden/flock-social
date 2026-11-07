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
 * The card is a <section> named by the plan. Its body is one button that
 * opens the plan, with the whole card read out as its name; the action is a
 * second button beside it, never a button inside a button.
 *
 * The other plans on the same night sit in one white group under it, each
 * with the reader's own state on its chip.
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

const LOCK_STORE = { get: lsGet, set: lsSet };

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
  // in, the status fades in, the name settles from a little below, and the
  // phone gives one buzz: the peak of planning a night, marked once
  // (lib/nestHero.js takeLockMoment). Under Reduce Motion only the fade.
  const lockId = flock && status && status.key === 'locked' ? flock.id : null;
  const [settle, setSettle] = useState(false);
  useEffect(() => {
    if (lockId == null || !takeLockMoment(lockId, LOCK_STORE)) return;
    setSettle(true);
    if (onLockMoment) onLockMoment();
  }, [lockId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!flock) return null;
  const titleId = `nest-hero-${flock.id}`;
  const spoken = [flock.name, when, place, status && status.label, `${total} going`].filter(Boolean).join(', ');
  return (
    <div data-nest-band="hero" style={{ marginBottom: '28px' }}>
      <section
        aria-labelledby={titleId}
        style={{
          backgroundColor: 'var(--nest-hero-bg)',
          color: 'var(--nest-hero-ink)',
          borderRadius: '16px',
          padding: '18px',
        }}
      >
        <button
          type="button"
          aria-label={spoken}
          onClick={onOpen}
          style={{
            display: 'block',
            width: '100%',
            padding: 0,
            margin: 0,
            border: 'none',
            background: 'none',
            color: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
            borderRadius: '12px',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' }}>
            <span style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--nest-hero-ink)', minWidth: 0 }}>{when}</span>
            {status && (
              <span
                data-nest-hero-status={status.key}
                className={settle ? 'nest-lock-fade' : undefined}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', flexShrink: 0, fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--nest-hero-meta)', whiteSpace: 'nowrap' }}
              >
                {status.key === 'locked' && Icons.check('var(--nest-hero-meta)', 13)}
                {status.label}
              </span>
            )}
          </span>
          <span
            id={titleId}
            className={settle ? 'nest-lock-settle' : undefined}
            style={{
              display: 'block',
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
            {flock.name}
          </span>
          <span style={{ display: 'block', marginTop: '3px', fontSize: 'var(--t-body)', fontWeight: '400', color: 'var(--nest-hero-meta)' }}>{place}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '14px', minWidth: 0 }}>
            <FaceRow people={faces} total={total} size={28} ring="var(--nest-hero-bg)" bg="var(--nest-hero-face)" ink="var(--nest-hero-ink)" />
            <span style={{ fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--nest-hero-meta)', minWidth: 0 }}>{names}</span>
          </span>
          {note && (
            <span style={{ display: 'block', marginTop: '12px', fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--nest-hero-meta)' }}>{note}</span>
          )}
        </button>
        {action && (
          <button
            type="button"
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
        <div style={{ marginTop: '8px', backgroundColor: 'var(--bg-card-solid)', borderRadius: '12px', overflow: 'hidden' }}>
          {sameNight.map((row, i) => (
            <button
              type="button"
              key={row.id}
              onClick={row.onClick}
              style={{
                width: '100%',
                minHeight: '60px',
                padding: '11px 14px 11px 16px',
                border: 'none',
                background: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                textAlign: 'left',
                cursor: 'pointer',
                position: 'relative',
              }}
            >
              {i > 0 && <span aria-hidden="true" style={{ position: 'absolute', top: 0, left: '16px', right: 0, height: '1px', backgroundColor: 'var(--divider)' }} />}
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{row.name}</span>
                <span style={{ display: 'block', marginTop: '2px', fontSize: 'var(--t-label)', fontWeight: '500', color: 'var(--text-secondary)' }}>{row.line}</span>
              </span>
              <NestChip chip={row.chip} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
