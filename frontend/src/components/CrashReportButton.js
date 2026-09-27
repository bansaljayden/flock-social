import React, { useState } from 'react';
import { crashReportPayload, sendCrashReport } from '../services/crashReport';

// "Send this to Flock", on every crash screen that has a person looking at
// it: the app-wide fallback in components/ErrorBoundary.js and the two
// screen-level ones in App.js. What it sends, and why nothing goes without the
// press, is in services/crashReport.js.
//
// Four states and one button. It says "Sent" only when the server answered
// that it kept the report, and a failed send can be tried again.
const WORDS = {
  idle: 'Send this to Flock',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Not sent. Try again',
};

export default function CrashReportButton({ error, componentStack, label, className, style }) {
  const [state, setState] = useState('idle');

  const onClick = async () => {
    if (state === 'sending' || state === 'sent') return;
    setState('sending');
    const ok = await sendCrashReport(crashReportPayload({ error, componentStack, label }));
    setState(ok ? 'sent' : 'failed');
  };

  const done = state === 'sending' || state === 'sent';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={done}
      aria-live="polite"
      className={className}
      style={{ ...style, ...(done ? { cursor: 'default', opacity: 0.75 } : null) }}
    >
      {WORDS[state]}
    </button>
  );
}

// A failed chunk download is the network, not a bug, and there is nothing in
// it to fix, so the crash screens leave the button off for it. One definition,
// shared by ErrorBoundary and App.js's screen fallbacks.
export function worthReporting(error) {
  if (!error) return false;
  return !(error.name === 'ChunkLoadError' || /Loading (CSS )?chunk/i.test(error.message || ''));
}

// The one line under the button that says what pressing it sends, so the
// choice is an informed one. Shared so every crash screen says the same thing.
export const CRASH_REPORT_NOTE = 'Sending it shares the error, the screen it happened on and the app version. Nothing about your account goes with it.';
