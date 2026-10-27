/**
 * CAMERA LOOKS TODAY: HOW OFTEN THE TABLE CAMERA LOOKED, AND HOW EACH ENDED.
 *
 * From GET .../tables/camera-looks: a count for the day, then one row per
 * look, newest first, with its time, what it looked at (one table or the
 * whole room) and how it ended in plain words (lib/venueTables.js
 * cameraLookRows). Failures are listed too, since the point of the section is
 * that the owner can see every time the shutter opened. There is never a
 * picture: the unit keeps none and the server has none to send.
 *
 * The day is the venue's when the server knows its zone and UTC otherwise,
 * and the times are printed on the same clock the other sections use; the
 * line under the list says which. A look taken while the unit's clock was
 * unsynced is placed by when it arrived, with "about" in front.
 */
import React from 'react';
import TablesSection, { SectionLine, SectionSkeleton } from './TablesSection';
import { cameraLookRows, clockIn, clockWords } from '../../../lib/venueTables';

const TITLE = 'Camera looks today';

export default function TablesCameraLooks({ looks, colors, timeZone }) {
  if (looks === undefined) return <SectionSkeleton height={120} testId="tables-camera-looks-loading" />;
  if (looks === null) {
    return (
      <TablesSection title={TITLE} colors={colors}>
        <SectionLine>Camera looks couldn't load.</SectionLine>
      </TablesSection>
    );
  }
  const clock = clockIn(looks.timeZone || timeZone);
  const rows = cameraLookRows(looks, clock);
  const count = Number.isFinite(looks.count) ? looks.count : rows.length;
  return (
    <TablesSection title={`${TITLE}: ${count}`} colors={colors}>
      {rows.length === 0 ? (
        <SectionLine>The camera hasn't looked yet today.</SectionLine>
      ) : (
        <ul aria-label="Camera looks" data-testid="tables-camera-looks" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rows.map((r, i) => (
            <li key={r.key} style={{ display: 'flex', gap: '10px', padding: '6px 0', borderTop: i === 0 ? 'none' : '1px solid var(--border-light)', fontSize: 'var(--t-meta)', lineHeight: 1.45, minWidth: 0 }}>
              <span style={{ flexShrink: 0, minWidth: '64px', color: 'var(--text-secondary)' }}>{r.time}</span>
              <span style={{ flexShrink: 0, minWidth: '84px', fontWeight: '600', color: 'var(--text-primary)' }}>{r.target}</span>
              <span style={{ color: 'var(--text-primary)', minWidth: 0, overflowWrap: 'anywhere' }}>{r.result}</span>
            </li>
          ))}
        </ul>
      )}
      {rows.length < count && (
        <SectionLine>{`Showing the latest ${rows.length}.`}</SectionLine>
      )}
      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-tertiary)', margin: '8px 0 0', lineHeight: 1.45 }}>
        {looks.timeZone
          ? `Every time the camera opened, failures included. No picture is kept. Times on ${clockWords(clock.venue)}.`
          : `Every time the camera opened, failures included. No picture is kept. The day is in UTC, since your listing has no time zone; times on ${clockWords(clock.venue)}.`}
      </p>
    </TablesSection>
  );
}
