// Haptic feedback, guarded so the web build never pays for it and a failure
// can never break the action it decorates. The iOS shell registers
// @capacitor/haptics through the normal `npx cap sync ios` step Codemagic
// already runs; on the web (and in jest) the dynamic import either resolves
// to a no-op bridge or rejects, and both are silently fine.
//
// Vocabulary, chosen once so call sites cannot invent their own scale:
//   tap()     light impact  — a small selection: the pulse, a vote
//   success() medium impact — something real landed: a plan created, a check-in
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

export function hapticTap() { impact('Light'); }
export function hapticSuccess() { impact('Medium'); }
export function hapticAlarm() { impact('Heavy'); }
