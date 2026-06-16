// PostHog wrapper. Defensive imports so the rest of the app works even
// before `pod install` runs and even if the API key isn't set yet — every
// call no-ops silently. That way `track('flock_created')` is safe to drop
// anywhere without try/catch.
//
// Wire-up order:
//   1. App.js calls init() once at boot.
//   2. AuthContext calls identify(userId, props) after login/signup, and
//      reset() on logout.
//   3. Screens fire-and-forget track() on key user actions.
//   4. RootNavigator's onStateChange auto-fires screen_viewed events.

let _client = null;
let _enabled = false;

// TODO: read from .env (react-native-config) — hardcoded placeholder for now.
// Replace with the real key before TestFlight; ok to leave as-is in dev.
const POSTHOG_API_KEY = ''; // ← drop your project key here OR set via env
const POSTHOG_HOST = 'https://us.i.posthog.com';

let PostHog = null;
try {
  // Defensive — if the package isn't installed yet (pre-pod-install) we just
  // skip everything. No crashes.
  // eslint-disable-next-line global-require
  PostHog = require('posthog-react-native').default;
} catch {
  PostHog = null;
}

export async function init() {
  if (!PostHog) { console.log('[PostHog] SDK not installed yet — events disabled'); return; }
  if (!POSTHOG_API_KEY) { console.log('[PostHog] No API key set — events disabled'); return; }
  try {
    _client = new PostHog(POSTHOG_API_KEY, {
      host: POSTHOG_HOST,
      // Capture a baseline session/screen events automatically; we layer
      // domain events on top.
      captureAppLifecycleEvents: true,
      preloadFeatureFlags: false,
      // sessionExpirationTimeSeconds: 30 * 60,
    });
    await _client.optIn();
    _enabled = true;
  } catch (err) {
    console.warn('[PostHog] init failed:', err.message);
    _client = null;
    _enabled = false;
  }
}

// Identify by PSEUDONYMOUS user id ONLY — never email/name/PII. This keeps the
// app's `NSPrivacyTracking=false` declaration honest: PostHog RN does not
// collect IDFA or do cross-app linking, and we send no personal data, so no
// App Tracking Transparency prompt is required. (C3) Props are intentionally
// dropped so a caller can't accidentally leak PII.
export function identify(userId, _props = {}) {
  if (!_enabled || !_client || !userId) return;
  try { _client.identify(String(userId)); } catch {}
}

export function reset() {
  if (!_enabled || !_client) return;
  try { _client.reset(); } catch {}
}

// Fire-and-forget event capture. Never throws, never blocks UI.
export function track(eventName, props = {}) {
  if (!_enabled || !_client || !eventName) return;
  try { _client.capture(eventName, props); } catch {}
}

// Screen-view event — meant to be called from React Navigation's
// onStateChange in App.js so we don't have to scatter screen tracking
// across every screen.
export function trackScreen(screenName, params = {}) {
  if (!_enabled || !_client || !screenName) return;
  try {
    _client.screen(screenName, {
      ...params,
      // Strip large or sensitive fields from auto params
      $screen_name: screenName,
    });
  } catch {}
}

// Canonical event names — define here so we don't typo across screens.
export const Events = {
  AppOpened: 'app_opened',
  SignupCompleted: 'signup_completed',
  LoginCompleted: 'login_completed',
  LogoutCompleted: 'logout_completed',
  OnboardingStepViewed: 'onboarding_step_viewed',
  OnboardingCompleted: 'onboarding_completed',
  FlockCreated: 'flock_created',
  FlockJoined: 'flock_joined',
  FlockCompleted: 'flock_completed',
  FlockAbandoned: 'flock_abandoned',
  VenueSearched: 'venue_searched',
  VenueDetailOpened: 'venue_detail_opened',
  VenueVoted: 'venue_voted',
  BudgetSubmitted: 'budget_submitted',
  BudgetSkipped: 'budget_skipped',
  BillSplitCreated: 'bill_split_created',
  BillSettled: 'bill_settled',
  PaywallShown: 'paywall_shown',
  PaywallPurchased: 'paywall_purchased',
  PaywallDismissed: 'paywall_dismissed',
  PushReceived: 'push_notification_received',
  PushTapped: 'push_notification_tapped',
  CheckinNfc: 'checkin_nfc',
  CheckinManual: 'checkin_manual',
  SosTriggered: 'sos_triggered',
};

export default { init, identify, reset, track, trackScreen, Events };
