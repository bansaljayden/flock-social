import React, { useEffect, useRef, useState } from 'react';
import Icons from '../ui/Icons';
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
 * drawn to the house geometry (Icons.siren, promoted from this file's local
 * glyph once Icons.js freed up) beside a left-aligned title, which reads as
 * an alert dialog rather than a decorated card.
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
          {/* Decorative siren beside the title. Promoted into the icon system
              (Icons.siren) 2026-08-14; .es-siren keeps its color and layout. */}
          <span className="es-siren" aria-hidden="true">
            {Icons.siren('currentColor', 26)}
          </span>
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
