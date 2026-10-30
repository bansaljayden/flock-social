// ---------------------------------------------------------------------------
// TURNING LOCATION ON LOADS THE VENUES (2026-10-30). Discover's status row reads
// "Finding venues near you." until mapVenuesLoaded, and the Continue buttons
// there (and a settings pull) turn Location on through toggleLocation, which
// used to set the location and load nothing: the row stayed up for good.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

function bodyOf(marker) {
  const at = APP.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const end = APP.indexOf('\n  }, [', at);
  expect(end).toBeGreaterThan(at);
  return APP.slice(at, end);
}

test('a location fix from toggleLocation starts the venue load at that fix', () => {
  const toggle = bodyOf('const toggleLocation = useCallback(');
  const fixAt = toggle.indexOf('setUserLocation({ lat: latitude, lng: longitude });');
  const loadAt = toggle.indexOf('loadVenuesAtLocationRef.current(latitude, longitude);');
  expect(fixAt).toBeGreaterThan(-1);
  expect(loadAt).toBeGreaterThan(fixAt);
});

test('the ref is kept current with the loader it stands for', () => {
  const loaderAt = APP.indexOf('const loadVenuesAtLocation = useCallback(');
  const refAt = APP.indexOf('const loadVenuesAtLocationRef = useRef(loadVenuesAtLocation);');
  expect(loaderAt).toBeGreaterThan(-1);
  expect(refAt).toBeGreaterThan(loaderAt);
  expect(APP).toContain('loadVenuesAtLocationRef.current = loadVenuesAtLocation;');
});
