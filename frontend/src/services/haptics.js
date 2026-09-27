// Haptic feedback, guarded so the web build never pays for it and a failure
// can never break the action it decorates. The iOS shell registers
// @capacitor/haptics through the normal `npx cap sync ios` step Codemagic
// already runs; on the web (and in jest) the dynamic import either resolves
// to a no-op bridge or rejects, and both are silently fine.
//
// Vocabulary, chosen once so call sites cannot invent their own scale:
//   tap()     light impact  — a small selection: the pulse, a vote, the plan's
//                             slide to complete reaching the point of no return
//   success() medium impact — something real landed: a plan created, a check-in,
//                             a plan locked in, a plan joined, a budget sent
//   warning() error notification — the server refused something the screen
//                             had already shown as done, and the screen has
//                             just put it back: a vote, a lock-in. The only
//                             verb that is not an impact, because iOS gives a
//                             refusal its own triple pattern and people know it.
//   alarm()   heavy impact  — the SOS press, and nothing else
// Fire and forget by design: never await these on a user path.

let bridge = null;
let loading = null;

async function load() {
  if (bridge) return bridge;
  if (!loading) {
    loading = import('@capacitor/haptics')
      .then((mod) => { bridge = mod; return mod; })
      .catch(() => { bridge = { Haptics: null }; return bridge; });
  }
  return loading;
}

function impact(style) {
  load().then((mod) => {
    if (!mod || !mod.Haptics || !mod.ImpactStyle) return;
    mod.Haptics.impact({ style: mod.ImpactStyle[style] }).catch(() => {});
  }).catch(() => {});
}

function notify(type) {
  load().then((mod) => {
    if (!mod || !mod.Haptics || !mod.NotificationType) return;
    mod.Haptics.notification({ type: mod.NotificationType[type] }).catch(() => {});
  }).catch(() => {});
}

export function hapticTap() { impact('Light'); }
export function hapticSuccess() { impact('Medium'); }
export function hapticWarning() { notify('Error'); }
export function hapticAlarm() { impact('Heavy'); }
