import { Platform } from 'react-native';
import { registerDeviceToken, unregisterAllTokens } from './api';
import { track, Events } from './posthog';

// RN Firebase messaging wrapper. Defensive imports + Platform guards so the
// app boots fine on iOS Simulator (where APNs registration silently fails)
// and on devices where `pod install` hasn't been run yet.
//
// Wire-up:
//   1. App.js calls setupNotifications(navigationRef) once after auth.
//   2. On iOS, that triggers the system permission prompt + APNs token.
//   3. We POST the token to backend so server-side notifications can route.
//   4. Foreground messages → local banner via Notifee or Alert (TODO).
//   5. Notification tap → use the navigation ref to deep-link.
//
// On simulator, getToken() returns nothing — that's fine. We log it and
// move on. Real-device testing happens after TestFlight build.

let messaging = null;
try {
  // eslint-disable-next-line global-require
  messaging = require('@react-native-firebase/messaging').default;
} catch {
  messaging = null;
}

export async function requestPermission() {
  if (!messaging) return false;
  try {
    const authStatus = await messaging().requestPermission();
    const enabled =
      authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
      authStatus === messaging.AuthorizationStatus.PROVISIONAL;
    return enabled;
  } catch (err) {
    console.warn('[Notifications] requestPermission failed:', err.message);
    return false;
  }
}

export async function getApnsToken() {
  if (!messaging || Platform.OS !== 'ios') return null;
  try {
    // On iOS, prefer the APNs token (raw device token from Apple) over the
    // Firebase token because the backend uses APNs directly via FCM.
    const token = await messaging().getAPNSToken();
    return token;
  } catch (err) {
    console.warn('[Notifications] getApnsToken failed:', err.message);
    return null;
  }
}

export async function getFcmToken() {
  if (!messaging) return null;
  try {
    const token = await messaging().getToken();
    return token;
  } catch (err) {
    console.warn('[Notifications] getFcmToken failed:', err.message);
    return null;
  }
}

// Register the device with our backend. We send the FCM token (works for
// both iOS via APNs and Android), with deviceType so backend can pick the
// right routing rules.
export async function registerWithBackend() {
  const token = await getFcmToken();
  if (!token) return null;
  try {
    await registerDeviceToken(token, Platform.OS);
    return token;
  } catch (err) {
    console.warn('[Notifications] backend registration failed:', err.message);
    return null;
  }
}

// Subscribes foreground + background handlers + tap handler. Returns a
// cleanup function to be called on logout.
export function attachHandlers(navigationRef) {
  if (!messaging) return () => {};

  // Foreground messages — iOS doesn't auto-display these, so we just log
  // for now. A polish pass adds Notifee for in-app banners.
  const offForeground = messaging().onMessage(async (msg) => {
    track(Events.PushReceived, { foreground: true, type: msg?.data?.type });
    console.log('[Notifications] Foreground message:', msg?.notification?.title);
  });

  // Background tap — when user taps a notification while app is closed
  // and it cold-starts, getInitialNotification returns the data once.
  messaging().getInitialNotification().then((msg) => {
    if (msg) {
      track(Events.PushTapped, { coldStart: true, type: msg?.data?.type });
      handleDeepLinkFromNotification(msg, navigationRef);
    }
  });

  // Background tap — when user taps a notification while app is in
  // background. onNotificationOpenedApp fires synchronously when tapped.
  const offTap = messaging().onNotificationOpenedApp((msg) => {
    track(Events.PushTapped, { coldStart: false, type: msg?.data?.type });
    handleDeepLinkFromNotification(msg, navigationRef);
  });

  return () => {
    offForeground && offForeground();
    offTap && offTap();
  };
}

// Routes a notification's data payload to the right screen. Backend
// includes shape like { type: 'flock_message', flock_id: 123 } in the
// data dict; we map that to React Navigation actions.
function handleDeepLinkFromNotification(msg, navigationRef) {
  const data = msg?.data || {};
  if (!navigationRef?.current?.isReady?.()) return;

  switch (data.type) {
    case 'flock_message':
    case 'flock_invite':
      if (data.flock_id) {
        navigationRef.current.navigate('NestTab', {
          screen: 'FlockDetail',
          params: { flockId: Number(data.flock_id) },
        });
      }
      break;
    case 'dm':
      if (data.from_user_id) {
        navigationRef.current.navigate('MessagesTab', {
          screen: 'DMChat',
          params: { otherUserId: Number(data.from_user_id), otherUserName: data.from_user_name },
        });
      }
      break;
    case 'budget_reminder':
    case 'budget_locked':
      if (data.flock_id) {
        navigationRef.current.navigate('NestTab', {
          screen: 'FlockDetail',
          params: { flockId: Number(data.flock_id) },
        });
      }
      break;
    case 'bill_created':
    case 'bill_settled':
      if (data.flock_id) {
        navigationRef.current.navigate('NestTab', {
          screen: 'SettleUp',
          params: { flockId: Number(data.flock_id) },
        });
      }
      break;
    default:
      // Unknown type — just open the app to home, no navigation needed.
      break;
  }
}

// Top-level setup. Called from App.js once the user is authenticated.
export async function setupNotifications(navigationRef) {
  const ok = await requestPermission();
  if (!ok) return () => {};
  await registerWithBackend();
  return attachHandlers(navigationRef);
}

export async function unregisterOnLogout() {
  if (!messaging) return;
  try {
    await unregisterAllTokens();
  } catch (err) {
    console.warn('[Notifications] unregister failed:', err.message);
  }
}
