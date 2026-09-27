// ---------------------------------------------------------------------------
// A CRASH REPORT THE PERSON CHOOSES TO SEND
// ---------------------------------------------------------------------------
// The crash screen (components/ErrorBoundary.js, and the screen-level
// fallbacks in App.js) offers "Send this to Flock". Nothing leaves the device
// until it is pressed, and each press sends one report. Sentry stays off: it
// would report every crash on its own, which is a different promise (see the
// privacy policy's error reports section and SUBMIT-CHECKLIST.md).
//
// WHAT IS SENT. The boundary label, the error's name, its message clamped to
// 200 characters with invite tokens, reset tokens, coordinates and email
// addresses removed, up to eight React component names from the component
// stack, the build, and whether this is the phone app or the website. No
// account: the request carries no Authorization header and no cookie, so the
// server could not attach one if it tried. backend/routes/clientCrash.js
// scrubs the message again, because a report is caller data to it.
//
// A plain fetch, not services/api.js. This module is reached from the crash
// screen, which is in the entry chunk, and api.js is not; importing it here
// would move all of it into the first download of every visit.
// ---------------------------------------------------------------------------
import { scrubUrlTokens } from '../lib/scrubUrlTokens';
import { detectNativeShell } from '../lib/nativeShell';

const BASE_URL = process.env.REACT_APP_API_URL || 'https://api.flockcorp.com';

export const MESSAGE_MAX = 200;
export const MAX_COMPONENTS = 8;
const SEND_TIMEOUT_MS = 10000;

// The same closed shapes the route accepts. A value outside them is dropped
// or replaced here rather than sent to be refused.
const NAME_RE = /^[A-Za-z_$][\w$.]{0,59}$/;
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function cleanLabel(label) {
  const s = String(label || 'root').replace(/[^\w .:-]/g, '-').slice(0, 40);
  return /^[A-Za-z0-9]/.test(s) ? s : `b${s}`.slice(0, 40);
}

// React writes one frame per line, "    at Name (url:1:2)" in React 19 and
// "    in Name (at file.js:12)" before it. Host elements (div, span) are
// lower case and say nothing about which screen broke, so only component
// names, which start with a capital, are kept, and a name repeated on the
// next frame is kept once.
export function componentNames(componentStack) {
  const out = [];
  for (const line of String(componentStack || '').split('\n')) {
    const m = /^\s*(?:at|in)\s+([A-Za-z_$][\w$.]*)/.exec(line);
    if (!m) continue;
    const name = m[1];
    if (!/^[A-Z]/.test(name) || !NAME_RE.test(name)) continue;
    if (out[out.length - 1] === name) continue;
    out.push(name);
    if (out.length >= MAX_COMPONENTS) break;
  }
  return out;
}

// Which build crashed, read off the page itself: the entry bundle's file
// name carries the build's content hash (static/js/main.<hash>.js), so no
// build variable is needed. Null on a development server, which has none.
export function buildId(doc = typeof document === 'undefined' ? undefined : document) {
  try {
    const scripts = doc && doc.scripts ? Array.from(doc.scripts) : [];
    for (const s of scripts) {
      const m = /\/static\/js\/main\.([0-9a-f]{6,})\.js/.exec(s.src || '');
      if (m) return m[1].slice(0, 12);
    }
  } catch { /* no build is a fine answer */ }
  return null;
}

export function crashReportPayload({ error, componentStack, label }) {
  const rawName = error && typeof error.name === 'string' ? error.name : '';
  const message = scrubUrlTokens(String((error && error.message) || ''))
    .replace(EMAIL_SHAPE, '[email]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MESSAGE_MAX);
  const build = buildId();
  return {
    boundary: cleanLabel(label),
    name: NAME_RE.test(rawName) ? rawName : 'Error',
    message,
    components: componentNames(componentStack),
    ...(build ? { build } : {}),
    platform: detectNativeShell() ? 'native' : 'web',
  };
}

// Resolves true when the server kept the report, false otherwise. Never
// rejects: this runs on a screen that has already failed once.
export async function sendCrashReport(payload, fetchImpl = typeof fetch === 'function' ? fetch : null) {
  if (!fetchImpl) return false;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), SEND_TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl(`${BASE_URL}/api/client-crash`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No cookie and no token: a report is not tied to an account.
      credentials: 'omit',
      body: JSON.stringify(payload),
      ...(controller ? { signal: controller.signal } : {}),
    });
    return !!res && res.ok === true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
