// Haptics wrapper — defensive imports so the app runs without
// react-native-haptic-feedback installed. Each helper is a fire-and-forget
// no-op when the lib isn't available.
//
// Use these everywhere instead of importing the lib directly:
//   import { tap, send, danger, selection } from '@/utils/haptics';

let HapticFeedback = null;
try {
  // eslint-disable-next-line global-require
  HapticFeedback = require('react-native-haptic-feedback').default;
} catch {
  HapticFeedback = null;
}

const opts = { enableVibrateFallback: true, ignoreAndroidSystemSettings: false };

function fire(type) {
  if (!HapticFeedback) return;
  try { HapticFeedback.trigger(type, opts); } catch {}
}

// Light tap — for normal button presses
export const tap = () => fire('impactLight');

// Medium tap — sending a message, completing a step
export const send = () => fire('impactMedium');

// Heavy tap — emergency / dangerous action
export const danger = () => fire('impactHeavy');

// Selection click — for picker / segmented control changes
export const selection = () => fire('selection');

// Notification feedback — success/warning/error
export const success = () => fire('notificationSuccess');
export const warning = () => fire('notificationWarning');
export const error = () => fire('notificationError');

export default { tap, send, danger, selection, success, warning, error };
