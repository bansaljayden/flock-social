// THE VERSION LINE AT THE FOOT OF THE YOU SCREEN.
//
// It was the literal "Flock v1.0.0" in every build: the App Store's 1.0 and
// 1.0.1 and the website alike, so a tester quoting it told nobody which build
// they had. On the iPhone the app now asks iOS for its own version and build
// number (@capacitor/app App.getInfo, the plugin the app already ships), and
// prints "Flock 1.0.1 (50)". On the web there is no build number, so it
// prints the short commit the bundle was built from, or its build date
// (scripts/build.js puts REACT_APP_BUILD_ID in): "Flock for web · 9f57f48".

import { isNativeShell } from './nativeShell';

export const WEB_BUILD_ID = process.env.REACT_APP_BUILD_ID || null;

export const versionLine = ({ native = false, version = null, build = null, buildId = null } = {}) => {
  if (native && version) return build ? `Flock ${version} (${build})` : `Flock ${version}`;
  return buildId ? `Flock for web · ${buildId}` : 'Flock for web';
};

// What to print before iOS has answered, and on the web for good.
export const initialVersionLine = (native = isNativeShell()) => (native ? 'Flock' : versionLine({ buildId: WEB_BUILD_ID }));

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
  if (!native) return versionLine({ buildId: WEB_BUILD_ID });
  if (!bridge) return 'Flock';
  try {
    const { App } = await loadApp();
    const info = await App.getInfo();
    return versionLine({ native: true, version: info && info.version, build: info && info.build });
  } catch {
    return 'Flock';
  }
}
