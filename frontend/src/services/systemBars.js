// The iOS status bar's glyph colour, matched to whatever is painted under it.
//
// WHY. Nothing set it, so CAPBridgeViewController left the status bar at
// `.default`, which follows the PHONE's appearance setting. The app's theme
// follows a clock (dark from 8 PM to 6 AM, ThemeContext.js) or a manual
// toggle, so the two disagreed every evening: a phone in system Light mode drew
// black clock and battery glyphs over the app's dark theme, and by day a phone
// in system Dark mode drew white ones over cream. The chat, DM, plan and Add
// Friends headers are navy in both themes, and the strip above them is painted
// navy to match now (App.js, topIsNavy), so there the glyphs have to be light
// at every hour whatever either setting says.
//
// HOW. SystemBars ships inside @capacitor/core 8 (SystemBars.swift), so no
// plugin is added. Capacitor names the style by the BACKGROUND: 'DARK' draws
// light glyphs for a dark background, 'LIGHT' draws dark glyphs for a light
// one. This file speaks the same way, in terms of what is under the bar.
//
// Two inputs decide it. The shell sets the base from the theme and the screen
// (setStatusBarOverDark). A full screen dark surface that opens on top of any
// screen, such as the chat photo viewer, takes a hold for as long as it is up
// (holdStatusBarOverDark), and the bar stays light-on-dark while any hold is
// held. Holds are counted rather than toggled so two surfaces closing in either
// order cannot leave the bar wrong.
//
// THE WEB BUILD NEVER LOADS @capacitor/core FROM HERE. index.js tells the
// marketing site from the native shell by window.Capacitor being absent in a
// browser (lib/nativeShell.js), and importing core would define it. So the
// import is dynamic and behind isNativeShell(), the same guard every plugin in
// this app sits behind. Fire and forget, like services/haptics.js: a status bar
// that fails to restyle is never worth an error on a user path.

import { isNativeShell } from '../lib/nativeShell';

export const STATUS_BAR_OVER_DARK = 'DARK';
export const STATUS_BAR_OVER_LIGHT = 'LIGHT';

// The screens whose first row is a navy header (colors.navyBg) in both themes:
// the flock chat, the DM thread, the plan, Add Friends, the venue dashboard and
// the admin console. A screen whose header changes colour belongs in this set
// or out of it on the same commit; statusBarAndNotch.test.js reads each of
// their files to check.
export const NAVY_TOP_SCREENS = new Set(['chatDetail', 'dmDetail', 'detail', 'addFriends', 'venueDashboard', 'adminRevenue']);

/** Is the top of the screen the shell is showing a navy header? The You tab's
 *  main page is the one tab that opens on one. `takenOver` is the Welcome or
 *  venue onboarding screen, which replace whatever currentScreen says. */
export const screenTopIsNavy = ({ currentScreen, currentTab, profileScreen, takenOver = false }) => (
  !takenOver && (
    NAVY_TOP_SCREENS.has(currentScreen)
    || (currentScreen === 'main' && currentTab === 'profile' && profileScreen === 'main')
  )
);

let loading = null;
let applied = null;
let baseOverDark = true; // capacitor.config.ts launches with 'DARK' over the navy splash
const holds = new Set();

const load = () => {
  if (!loading) {
    loading = import('@capacitor/core')
      .then((mod) => (mod && mod.SystemBars ? mod : null))
      .catch(() => null);
  }
  return loading;
};

export const statusBarStyleFor = (overDark) => (overDark ? STATUS_BAR_OVER_DARK : STATUS_BAR_OVER_LIGHT);

function apply() {
  const style = statusBarStyleFor(baseOverDark || holds.size > 0);
  if (style === applied) return;
  applied = style;
  if (!isNativeShell()) return;
  load().then((mod) => {
    if (!mod) return;
    try {
      const result = mod.SystemBars.setStyle({ style });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (err) {
      /* An older shell without the plugin. The bar keeps its last style. */
    }
  }).catch(() => {});
}

/** The shell's answer for the screen that is showing: is the top of it dark? */
export function setStatusBarOverDark(overDark) {
  baseOverDark = !!overDark;
  apply();
}

/** Keep the glyphs light while a dark full screen surface is up. Returns the
 *  release, which is safe to call more than once; use it as an effect cleanup. */
export function holdStatusBarOverDark() {
  const token = {};
  holds.add(token);
  apply();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds.delete(token);
    apply();
  };
}
