/**
 * SOS EMERGENCY SHEET REBUILD — the 2026-08-14 extraction of App.js's inline
 * SOSModal into components/safety/EmergencySheet.js, locked shut.
 *
 * Three things shipped together and each is a thing an edit can silently
 * undo:
 *
 *   1. THE A11Y CONTRACT. The old modal leaned on App.js's DialogBehavior
 *      (role="dialog" + aria-label). The sheet is a real alertdialog with
 *      aria-labelledby / aria-describedby, focus moving INTO the sheet on
 *      open (onto the sheet, never onto the Call 911 anchor — "open, press
 *      Enter" must not dial 911), a Tab trap, Escape and Cancel both
 *      closing, and focus returning to the trigger on close. These are
 *      RENDERED and exercised here, not grepped.
 *
 *   2. THE HIERARCHY FIX. The old modal painted Call 911 light red (#EF4444)
 *      and Alert Contacts dark red (#b91c1c) — the heavier button was the
 *      less critical action. Call 911 is now the tallest, darkest control;
 *      the CSS pins are scanned because jsdom computes no layout.
 *
 *   3. THE WIRING. Every action still fires the exact App.js handler the
 *      inline modal called. The component side is rendered; the App.js side
 *      (the splice passing handleEmergencyAlert and friends) is a source
 *      scan, same doctrine as iconAndAlertSweep.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import EmergencySheet from '../components/safety/EmergencySheet';

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
const SHEET_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'safety', 'EmergencySheet.js'),
  'utf8'
);
const SHEET_CSS = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'safety', 'EmergencySheet.css'),
  'utf8'
);

const noop = () => {};
const baseProps = {
  contactCount: 1,
  armed: false,
  onArmedChange: noop,
  sending: false,
  onAlertContacts: noop,
  onShareLocation: noop,
  onAddContacts: noop,
  onClose: noop,
};

const renderSheet = (overrides = {}) =>
  render(<EmergencySheet {...baseProps} {...overrides} />);

/** The mount effect focuses one tick late (sheets animate in). */
const settleFocus = () => act(() => { jest.advanceTimersByTime(0); });

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  act(() => { jest.runOnlyPendingTimers(); });
  jest.useRealTimers();
});

describe('the sheet is a real alertdialog', () => {
  it('carries role, aria-modal, and resolvable labelledby/describedby', () => {
    renderSheet();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const title = document.getElementById(dialog.getAttribute('aria-labelledby'));
    const desc = document.getElementById(dialog.getAttribute('aria-describedby'));
    expect(title).toHaveTextContent('Emergency');
    expect(desc).toHaveTextContent('1 trusted contact will be notified');
  });

  it('the described-by count line is accurate: singular, plural, and none', () => {
    const line = (count) => {
      const { unmount } = renderSheet({ contactCount: count });
      const dialog = screen.getByRole('alertdialog');
      const text = document.getElementById(dialog.getAttribute('aria-describedby')).textContent;
      unmount();
      return text;
    };
    expect(line(1)).toBe('1 trusted contact will be notified');
    expect(line(3)).toBe('3 trusted contacts will be notified');
    expect(line(0)).toBe('No trusted contacts set up');
  });
});

describe('focus management', () => {
  it('moves focus onto the sheet on open — not onto the Call 911 anchor', () => {
    renderSheet();
    settleFocus();
    expect(document.activeElement).toBe(screen.getByRole('alertdialog'));
  });

  it('traps Tab: cycles forward from the sheet through every control and wraps', () => {
    renderSheet();
    settleFocus();
    const dialog = screen.getByRole('alertdialog');
    const call = screen.getByRole('link', { name: /call 911/i });
    const cancel = screen.getByRole('button', { name: 'Cancel' });

    // From the container, Tab enters the ring at the first control.
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(call);

    // From the last control, Tab wraps to the first.
    cancel.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(call);

    // Shift+Tab from the first control wraps to the last.
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancel);

    // Shift+Tab from the container enters the ring at the last control.
    dialog.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancel);
  });

  it('Escape closes', () => {
    const onClose = jest.fn();
    renderSheet({ onClose });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Cancel closes', () => {
    const onClose = jest.fn();
    renderSheet({ onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the trigger on close', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = renderSheet();
    settleFocus();
    expect(document.activeElement).not.toBe(trigger);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

describe('the four actions keep their original wiring', () => {
  it('Call 911 is a plain tel: anchor', () => {
    renderSheet();
    expect(screen.getByRole('link', { name: /call 911/i })).toHaveAttribute('href', 'tel:911');
  });

  it('Alert Contacts is two-step: first tap arms, second tap fires the handler', () => {
    const onArmedChange = jest.fn();
    const onAlertContacts = jest.fn();
    const { unmount } = renderSheet({ onArmedChange, onAlertContacts });
    fireEvent.click(screen.getByRole('button', { name: /alert contacts/i }));
    expect(onArmedChange).toHaveBeenCalledWith(true);
    expect(onAlertContacts).not.toHaveBeenCalled();
    unmount();

    // Armed: the same button confirms, disarms, and fires.
    renderSheet({ armed: true, onArmedChange, onAlertContacts });
    fireEvent.click(screen.getByRole('button', { name: /tap again to confirm/i }));
    expect(onAlertContacts).toHaveBeenCalledTimes(1);
    expect(onArmedChange).toHaveBeenLastCalledWith(false);
  });

  it('an armed alert disarms itself after the 4 second window', () => {
    const onArmedChange = jest.fn();
    renderSheet({ armed: true, onArmedChange });
    act(() => { jest.advanceTimersByTime(3999); });
    expect(onArmedChange).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(1); });
    expect(onArmedChange).toHaveBeenCalledWith(false);
  });

  it('Share Location fires its handler', () => {
    const onShareLocation = jest.fn();
    renderSheet({ onShareLocation });
    fireEvent.click(screen.getByRole('button', { name: /share location/i }));
    expect(onShareLocation).toHaveBeenCalledTimes(1);
  });

  it('with no contacts, alert and share are dead and setup is the live action', () => {
    const onAddContacts = jest.fn();
    renderSheet({ contactCount: 0, onAddContacts });
    expect(screen.getByRole('button', { name: /alert contacts/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /share location/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /add trusted contacts/i }));
    expect(onAddContacts).toHaveBeenCalledTimes(1);
  });

  it('while sending, both contact actions and Cancel are disabled', () => {
    renderSheet({ sending: true });
    expect(screen.getByRole('button', { name: /alert contacts|sending/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /share location|sending/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });
});

describe('presentation pins (jsdom computes no layout, so the CSS is the record)', () => {
  it('Call 911 is the visual primary: destructive red, tallest, boldest', () => {
    // #b91c1c is the app's accessibility-fixed destructive red (6.47:1 with
    // white on every surface, per index.css's .glass-danger note).
    const call = SHEET_CSS.slice(SHEET_CSS.indexOf('.es-call {'), SHEET_CSS.indexOf('.es-call:active'));
    expect(call).toContain('background: #b91c1c');
    expect(call).toContain('min-height: 56px');
    expect(call).toContain('font-weight: 700');
  });

  it('the old inverted pair is gone: Alert Contacts is a tinted secondary', () => {
    const alert = SHEET_CSS.slice(SHEET_CSS.indexOf('.es-alert {'), SHEET_CSS.indexOf('.es-alert.es-armed'));
    expect(alert).toContain('var(--accent-red-bg)');
    expect(alert).toContain('var(--accent-red-text)');
    // Full red is earned only by the armed state.
    expect(SHEET_CSS).toMatch(/\.es-alert\.es-armed \{[^}]*#b91c1c/);
  });

  it('every control clears the 44px tap floor and the 16px text floor', () => {
    const heights = [...SHEET_CSS.matchAll(/min-height:\s*(\d+)px/g)].map((m) => Number(m[1]));
    expect(heights.length).toBeGreaterThanOrEqual(4);
    expect(heights.filter((h) => h < 44)).toEqual([]);
    expect(SHEET_CSS).toMatch(/\.es-btn \{[^}]*font-size: 16px/);
  });

  it('the backdrop sits below the toast layer so error toasts stay visible', () => {
    // App.js's toast is fixed at zIndex 60; a failed send shows one while the
    // sheet stays open, so the sheet must never cover it.
    const z = Number((SHEET_CSS.match(/z-index:\s*(\d+)/) || [])[1]);
    expect(z).toBeGreaterThan(20);
    expect(z).toBeLessThan(60);
  });

  it('themes come from tokens: no hardcoded surface or text colors beyond the two deliberate ones', () => {
    // #b91c1c (destructive red) and #2d5a87 (brand steel navy) are the only
    // literals; everything else must be a var(--*) so dark mode holds.
    const hexes = [...new Set(SHEET_CSS.match(/#[0-9a-fA-F]{3,8}\b/g))];
    expect(hexes.sort()).toEqual(['#2d5a87', '#b91c1c', '#ffffff'].sort());
  });

  it('no icon in the sheet renders below the 12px legibility floor', () => {
    renderSheet({ contactCount: 0 });
    const svgs = Array.from(document.querySelectorAll('svg'));
    expect(svgs.length).toBeGreaterThanOrEqual(4);
    svgs.forEach((s) => {
      expect(Number(s.getAttribute('width'))).toBeGreaterThanOrEqual(12);
    });
  });

  it('the siren glyph follows the house geometry and the blob is gone', () => {
    // Local SVG (Icons.js is owned by a parallel agent): round caps/joins,
    // sw(size)-derived stroke, closed dome container. And the pink-circle
    // bell blob must not have survived anywhere in the component.
    expect(SHEET_SRC).toContain('strokeLinecap="round"');
    expect(SHEET_SRC).toContain('strokeLinejoin="round"');
    expect(SHEET_SRC).toContain('strokeWidth={sw(size)}');
    expect(SHEET_SRC).toContain('M7 19 7 13A5 5 0 0 1 17 13L17 19Z');
    expect(SHEET_SRC).not.toMatch(/borderRadius:\s*'32px'/);
    expect(SHEET_CSS).not.toMatch(/border-radius:\s*50%/);
  });

  it('no em dash in any user-visible string', () => {
    // SLOP-AUDIT A2/H18. Comments are exempt (the file explains itself);
    // JSX text and string literals are not.
    const codeOnly = SHEET_SRC
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line))
      .map((line) => line.replace(/\/\/.*$/, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ''))
      .join('\n');
    expect(codeOnly).not.toContain('—');
  });
});

describe('the App.js splice is minimal and correctly wired', () => {
  it('imports the component once', () => {
    const imports = APP.match(/import EmergencySheet from '\.\/components\/safety\/EmergencySheet';/g);
    expect(imports).toHaveLength(1);
  });

  it('SOSModal renders EmergencySheet with the original handlers and state', () => {
    const start = APP.indexOf('const SOSModal = ()');
    expect(start).toBeGreaterThan(-1);
    const region = APP.slice(start, APP.indexOf('/>', start) + 2);
    expect(region).toContain('showSOS && (');
    expect(region).toContain('<EmergencySheet');
    expect(region).toContain('contactCount={trustedContacts.length}');
    expect(region).toContain('armed={sosArmed}');
    expect(region).toContain('onArmedChange={setSosArmed}');
    expect(region).toContain('sending={sosAlertSending}');
    expect(region).toContain('onAlertContacts={handleEmergencyAlert}');
    expect(region).toContain('onShareLocation={handleShareLocationWithContacts}');
    expect(region).toContain('loadTrustedContacts()');
    expect(region).toContain("onClose={() => { setSosArmed(false); setShowSOS(false); }}");
  });

  it('the inline modal is fully gone from App.js', () => {
    // The header blob's one-of-a-kind call, and the old inline arm timeout.
    expect(APP).not.toContain('Icons.bell(colors.red, 32)');
    expect(APP).not.toContain("setTimeout(() => setSosArmed(false), 4000)");
    // Still rendered exactly once in the tree.
    expect(APP.match(/\{SOSModal\(\)\}/g)).toHaveLength(1);
  });
});
