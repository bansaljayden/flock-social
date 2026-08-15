import React, { useEffect, useRef, useState } from 'react';
import Icons, { sw } from '../ui/Icons';
import './EmergencySheet.css';

/*
 * SOS EMERGENCY SHEET — extracted from App.js's inline SOSModal (2026-08-14
 * rebuild). Presentation and structure only: every action calls the same
 * App.js handler the inline modal called, through props.
 *
 * WHAT CHANGED FROM THE INLINE MODAL, AND WHY
 *
 * Hierarchy. The old modal painted Call 911 in light red (#EF4444) and Alert
 * Contacts in dark red (glass-danger #b91c1c), so the heavier, darker button
 * was the LESS critical action. On a safety surface the most critical action
 * must be the unmistakable visual primary: Call 911 is now the tallest,
 * darkest, highest-contrast control (solid #b91c1c, 6.47:1 with white in both
 * themes); Alert Contacts is a red-tinted secondary that only goes full red
 * while armed; Share Location is a neutral outline; Cancel is plain text.
 *
 * The bell-in-pink-circle header blob is gone. The header is a stroke siren
 * drawn to the house geometry (see SirenGlyph below) beside a left-aligned
 * title, which reads as an alert dialog rather than a decorated card.
 *
 * A11y. role="alertdialog" (this IS the interruption-for-an-emergency case
 * the role exists for) with aria-labelledby / aria-describedby; the
 * described-by text is the live trusted-contact count line, singular and
 * plural handled. Initial focus lands on the SHEET, not the first button —
 * the first button is an anchor that dials 911, and "open sheet, press
 * Enter" must never place an emergency call by accident (ARIA APG:
 * alertdialogs focus the least-destructive target). Tab and Shift+Tab are
 * trapped inside; Escape and Cancel both close; focus returns to the
 * safety button on close. Arming is announced through a polite live region,
 * because a label swap on the pressed button is not reliably read.
 *
 * Presentation-only refinement: 'Sending...' now appears only on the button
 * whose request is actually in flight (the inline modal printed it on both).
 * Both stay disabled during a send, exactly as before.
 */

/* Focusable-descendant selector, mirroring App.js's DialogBehavior. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), ' +
  '[contenteditable="true"]';

/*
 * Siren — a local glyph, NOT yet in components/ui/Icons.js (that file is
 * owned by a parallel agent; promote this there later). Drawn to the house
 * geometry: 24 viewBox, stroke-based, round caps and joins, sw(size) stroke
 * weight, segments at 0/45/90, the one curve a circular arc with a whole-unit
 * radius (r=5 dome), container closed onto its own base. Decorative
 * (aria-hidden): it sits beside the "Emergency" title.
 */
const SirenGlyph = ({ size = 26 }) => (
  <span className="es-siren" aria-hidden="true">
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* Dome: two verticals joined by an r=5 arc, closed across the bottom. */}
      <path d="M7 19 7 13A5 5 0 0 1 17 13L17 19Z" />
      {/* Base plinth. */}
      <path d="M4 19 20 19" />
      {/* Light rays: one vertical, two at 45 degrees. */}
      <path d="M12 2 12 4.5" />
      <path d="M5 5 6.75 6.75" />
      <path d="M19 5 17.25 6.75" />
    </svg>
  </span>
);

const EmergencySheet = ({
  contactCount,
  armed,
  onArmedChange,
  sending,
  onAlertContacts,
  onShareLocation,
  onAddContacts,
  onClose,
}) => {
  const sheetRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Which request 'Sending...' belongs to — presentation only. Cleared when
  // the send settles (the `sending` prop is owned by App.js).
  const [pendingAction, setPendingAction] = useState(null);
  useEffect(() => {
    if (!sending) setPendingAction(null);
  }, [sending]);

  // Two-step confirm window: an armed alert disarms itself after 4 seconds,
  // exactly as the inline modal's setTimeout did, but cleaned up on unmount.
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => onArmedChange(false), 4000);
    return () => clearTimeout(t);
  }, [armed, onArmedChange]);

  // Dialog behavior: focus in on open, trap Tab, close on Escape, restore
  // focus on close. Self-contained because App.js's DialogBehavior is module-
  // private to App.js (same situation, and same solution, as ModerationSheet).
  useEffect(() => {
    const node = sheetRef.current;
    if (!node) return undefined;
    const restoreTo = document.activeElement;

    const focusables = () => {
      const all = Array.from(node.querySelectorAll(FOCUSABLE));
      const visible = all.filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0);
      // Every focusable in this sheet is visible whenever it exists, so the
      // raw list is a safe fallback where layout boxes are not measurable
      // (jsdom reports 0x0 for everything; a real browser never hits this).
      return visible.length > 0 ? visible : all;
    };

    // One tick late, matching DialogBehavior: the sheet animates in.
    const t = setTimeout(() => {
      if (node.contains(document.activeElement) && document.activeElement !== document.body) return;
      // The sheet itself, never the first control: the first control dials 911.
      try { node.focus({ preventScroll: true }); } catch { /* detached */ }
    }, 0);

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        // Both calls matter. stopPropagation keeps the event from reaching
        // App.js's DialogBehavior listeners on document (they sit later in
        // the capture path than window, where this listener lives), so an
        // Escape over the SOS sheet can never also dismiss a non-modal
        // overlay underneath it, e.g. the Birdie panel. stopImmediate-
        // Propagation guards against any future same-target listener.
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (onCloseRef.current) onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      e.stopPropagation();
      const list = focusables();
      if (list.length === 0) {
        e.preventDefault();
        node.focus({ preventScroll: true });
        return;
      }
      const i = list.indexOf(document.activeElement);
      if (i === -1) {
        // Focus is on the sheet container (or escaped): enter the ring at
        // whichever end matches the direction of travel.
        e.preventDefault();
        (e.shiftKey ? list[list.length - 1] : list[0]).focus();
      } else if (e.shiftKey && i === 0) {
        e.preventDefault();
        list[list.length - 1].focus();
      } else if (!e.shiftKey && i === list.length - 1) {
        e.preventDefault();
        list[0].focus();
      }
    };
    // window, not document: in the capture phase window listeners run before
    // document listeners, which is what lets the SOS sheet act as the
    // top-most dialog without being registered in App.js's private
    // DialogBehavior stack.
    window.addEventListener('keydown', onKeyDown, true);

    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKeyDown, true);
      if (restoreTo && document.contains(restoreTo) && typeof restoreTo.focus === 'function') {
        try { restoreTo.focus({ preventScroll: true }); } catch { /* gone */ }
      }
    };
  }, []);

  const noContacts = contactCount === 0;
  const contactLine = noContacts
    ? 'No trusted contacts set up'
    : `${contactCount} trusted contact${contactCount === 1 ? '' : 's'} will be notified`;

  return (
    <div className="es-backdrop">
      <div
        ref={sheetRef}
        className="es-sheet"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="es-title"
        aria-describedby="es-desc"
        tabIndex={-1}
      >
        <div className="es-head">
          <SirenGlyph />
          <div>
            <h2 id="es-title" className="es-title">Emergency</h2>
            {/* The described-by text: the accurate contact count, live. */}
            <p id="es-desc" className="es-desc">{contactLine}</p>
          </div>
        </div>

        <div className="es-actions">
          <a className="es-btn es-call" href="tel:911">
            {Icons.phone('currentColor', 20)}
            <span>Call 911</span>
          </a>

          {/* With no trusted contacts there is nobody to alert, so the two
              buttons that message them are visibly dead (never a full-
              strength red control that cannot do anything), and setting
              contacts up becomes the live second action. */}
          {noContacts && (
            <button type="button" className="es-btn es-setup" onClick={onAddContacts}>
              {Icons.userPlus('currentColor', 18)}
              <span>Add trusted contacts</span>
            </button>
          )}

          <button
            type="button"
            className={`es-btn es-alert${armed ? ' es-armed' : ''}${noContacts ? ' es-dead' : ''}`}
            disabled={sending || noContacts}
            onClick={() => {
              if (!armed) {
                onArmedChange(true);
              } else {
                onArmedChange(false);
                setPendingAction('alert');
                onAlertContacts();
              }
            }}
          >
            {Icons.bell('currentColor', 18)}
            <span>
              {sending && pendingAction === 'alert'
                ? 'Sending...'
                : armed
                  ? 'Tap again to confirm'
                  : 'Alert Contacts'}
            </span>
          </button>

          <button
            type="button"
            className={`es-btn es-share${noContacts ? ' es-dead' : ''}`}
            disabled={sending || noContacts}
            onClick={() => {
              setPendingAction('share');
              onShareLocation();
            }}
          >
            {Icons.mapPin('currentColor', 18)}
            <span>{sending && pendingAction === 'share' ? 'Sending...' : 'Share Location'}</span>
          </button>

          {noContacts && (
            <p className="es-note">Alerts need at least one trusted contact.</p>
          )}

          <button type="button" className="es-btn es-cancel" disabled={sending} onClick={onClose}>
            Cancel
          </button>
        </div>

        {/* The armed state must reach screen readers: the label swap on a
            pressed button is not reliably announced on its own. */}
        <span className="sr-only" role="status">
          {armed ? 'Tap Alert Contacts again within 4 seconds to send the alert.' : ''}
        </span>
      </div>
    </div>
  );
};

export default EmergencySheet;
