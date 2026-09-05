/**
 * SETTINGS LANE (audit 2026-09-05): source pins for the five fixes.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test settingsLaneAudit --watchAll=false
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

test('Sign out everywhere says which one happened when the server call fails', () => {
  const app = read('App.js');
  const settings = read('screens/ProfileSettings.js');
  expect(app).toMatch(/signed_out_here_only: 'Signed out on this phone only\./);
  expect(settings).toContain("try { await logoutAll(); } catch (_) { everywhere = false; }");
  expect(settings).toContain("sessionEndCopy(everywhere ? 'signed_out_everywhere' : 'signed_out_here_only')");
});

test('a profile photo can be removed, and the row only shows when there is one', () => {
  const app = read('App.js');
  const api = read('services/api.js');
  expect(api).toContain("export async function removeProfileImage() {\n  return request('/api/users/profile-image', { method: 'DELETE' });");
  expect(app).toContain('const removePhoto = useCallback(async () => {');
  expect(app).toContain('{profilePic && (');
  expect(app).toContain('onClick={removePhoto}');
  expect(app).toContain('setProfilePic(previousPic);');
  expect(app).not.toContain('Remove photo\u2014');
});

test('synced Location, pins and order reach the running screen', () => {
  const app = read('App.js');
  expect(app).toContain("if (on !== locationEnabledRef.current) toggleLocation(on);");
  expect(app).toContain('if (Array.isArray(s.pinnedFlockIds)) setPinnedFlockIds(s.pinnedFlockIds);');
  expect(app).toContain('if (Array.isArray(s.flockOrder)) setFlockOrder(s.flockOrder);');
  // The listener names the handler it calls, so a stale closure cannot creep in.
  expect(app).toContain("return () => window.removeEventListener('flock-settings-loaded', onSettings);\n  }, [toggleLocation]);");
});

test('the mount run of the pin and order effects does not push this device over the account', () => {
  const app = read('App.js');
  expect(app).toContain("if (!pinsSyncedRef.current) { pinsSyncedRef.current = true; return; }\n    queueSync({ pinnedFlockIds });");
  expect(app).toContain("if (!orderSyncedRef.current) { orderSyncedRef.current = true; return; }\n    queueSync({ flockOrder });");
  expect(app).not.toContain("useEffect(() => { localStorage.setItem('flock_pinned', JSON.stringify(pinnedFlockIds)); queueSync({ pinnedFlockIds }); }, [pinnedFlockIds]);");
});

test('the delete sheet mentions the subscription only once there can be one', () => {
  const settings = read('screens/ProfileSettings.js');
  const at = settings.indexOf('Deleting your account does not cancel a Flock Pro subscription.');
  expect(at).toBeGreaterThan(-1);
  const before = settings.slice(at - 400, at);
  expect(before).toContain('(entitlements?.paywallEnabled || isPro) && (');
});
