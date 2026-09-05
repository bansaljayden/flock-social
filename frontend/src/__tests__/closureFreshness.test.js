// Three hooks in App.js keep short dependency lists on purpose and used to
// close over values that change later in the session. Each is a real
// user-visible failure, pinned here as source contracts because the
// behaviour lives in effects and callbacks a render test cannot reach.
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
const dm = fs.readFileSync(path.join(__dirname, '..', 'screens', 'DmDetail.js'), 'utf8');

function block(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  expect(i).toBeGreaterThan(-1);
  const j = src.indexOf(endMarker, i);
  expect(j).toBeGreaterThan(i);
  return src.slice(i, j + endMarker.length);
}

describe('DM live location', () => {
  test('arming a share from the composer asks for a fix on the tap', () => {
    // The composer no longer sets state blind, and it never did the toggling
    // either: starting a share is a tile in the "+" sheet now, and the control
    // for one already running is the Stop beside the bar's own chip. One
    // control that means "start" or "stop" depending on state was two doors
    // wearing one label.
    expect(dm).not.toMatch(/setDmSharingLocation\(selectedDmId\)/);
    expect(dm).toMatch(/startDmLocationSharing\(selectedDmId\);/);
    // The tile is withheld entirely while a share is running, rather than
    // being drawn and quietly meaning something else.
    expect(dm).toMatch(/onShareLocation=\{dmSharingLocation \? undefined :/);
    expect(dm).toMatch(/^\s+startDmLocationSharing,$/m);
    // App passes it and it requests a position when there is none
    expect(app).toMatch(/^\s+startDmLocationSharing,$/m);
    const cb = block(app, 'const startDmLocationSharing = useCallback((dmId) => {', '}, [showToast]);');
    // The early return on an existing position is gone (2026-09-04): it could
    // be one restored from localStorage at boot, so a DM share could open by
    // broadcasting where the phone was in a previous session. Every share now
    // takes a fresh fix, the way the flock share already did.
    expect(cb).not.toMatch(/if \(userLocation\) \{ setDmSharingLocation\(dmId\); return; \}/);
    expect(cb).toMatch(/getCurrentPosition\(/);
    expect(cb).toMatch(/setUserLocation\(\{ lat: pos\.coords\.latitude, lng: pos\.coords\.longitude \}\);\s*setDmSharingLocation\(dmId\);/);
    expect(cb).toMatch(/Turn it on in Settings/);
  });

  test('the emitter re-runs when a position first exists, without per-fix churn', () => {
    const eff = block(app, 'const hasUserLocation = !!userLocation;', '[dmSharingLocation, hasUserLocation]);');
    expect(eff).toMatch(/if \(!dmSharingLocation \|\| !userLocation\) return;/);
    expect(eff).toMatch(/const loc = userLocationRef\.current;/);
  });
});

test('the flock-share unmount cleanup reads the live share, not the mount-time value', () => {
  const cleanup = block(app, '// Clean up location sharing on unmount', '}, []);');
  expect(cleanup).toMatch(/const live = sharingLocationRef\.current;\s*if \(live\) socketStopSharing\(live\);/);
  expect(cleanup).not.toMatch(/if \(sharingLocationForFlock\)/);
});

test('an optimistic flock bubble carries the current avatar', () => {
  expect(app).toMatch(/const profilePicRef = useRef\(profilePic\);\s*profilePicRef\.current = profilePic;/);
  expect(app).toMatch(/senderImage: profilePicRef\.current,/);
  expect(app).not.toMatch(/senderImage: profilePic,/);
});
