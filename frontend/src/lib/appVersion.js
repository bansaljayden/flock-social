// THE VERSION LINE AT THE FOOT OF THE YOU SCREEN.
//
// It was the literal "Flock v1.0.0" in every build: the App Store's 1.0 and
// 1.0.1 and the website alike, so a tester quoting it told nobody which build
// they had. On the iPhone the app now asks iOS for its own version and build
// number (@capacitor/app App.getInfo, the plugin the app already ships), and
// prints "Flock 1.0.1 (50)". On the web there is no build number, so it
// prints the short commit the site was built from, or its build date:
// "Flock for web · 9f57f48".
//
// WHERE THE WEB'S BUILD ID LIVES. scripts/build.js names the build
// (REACT_APP_BUILD_ID) and the build writes that name into
// public/index.html's <meta name="flock-build">, which this file reads off
// the page. It used to be compiled into this file, and so into the chunk that
// holds the You screen. That chunk's bytes, its hashed name, and the main
// bundle's name with it (main lists every chunk by name) then changed on
// every deploy, the ones that changed no code included: between 2026-11-10
// and 11-11 five deploys in a row renamed exactly those two files and nothing
// else. Each rename took the old file off the site, so a tab left open asked
// for a script that was gone. The HTML is fetched fresh on every load, so the
// id costs nothing there.

import { isNativeShell } from './nativeShell';

// A short commit, a build date, or a word someone set by hand. Under
// `npm start` and in tests nothing fills the tag in and it still holds the
// build's placeholder, which is not an id.
const BUILD_ID = /^[\w.-]{1,40}$/;

export function readWebBuildId(doc = typeof document === 'undefined' ? null : document) {
  try {
    const tag = doc && doc.querySelector('meta[name="flock-build"]');
    const value = tag ? String(tag.getAttribute('content') || '').trim() : '';
    return BUILD_ID.test(value) ? value : null;
  } catch {
    return null;
  }
}

export const versionLine = ({ native = false, version = null, build = null, buildId = null } = {}) => {
  if (native && version) return build ? `Flock ${version} (${build})` : `Flock ${version}`;
  return buildId ? `Flock for web · ${buildId}` : 'Flock for web';
};

// What to print before iOS has answered, and on the web for good.
export const initialVersionLine = (native = isNativeShell()) => (native ? 'Flock' : versionLine({ buildId: readWebBuildId() }));

// Whether the page really sits on Capacitor's native bridge, the one iOS and
// Android inject before any script runs. A page that only carries a
// window.Capacitor object (a test, a web preview) has no plugin to answer, and
// importing @capacitor/app there would rebuild that object as the web's.
const hasNativeBridge = () => {
  try {
    return typeof window !== 'undefined' && !!((window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bridge) || window.androidBridge);
  } catch {
    return false;
  }
};

export async function readVersionLine({ native = isNativeShell(), bridge = hasNativeBridge(), loadApp = () => import('@capacitor/app') } = {}) {
  if (!native) return versionLine({ buildId: readWebBuildId() });
  if (!bridge) return 'Flock';
  try {
    const { App } = await loadApp();
    const info = await App.getInfo();
    return versionLine({ native: true, version: info && info.version, build: info && info.build });
  } catch {
    return 'Flock';
  }
}
