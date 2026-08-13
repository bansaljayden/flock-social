# Native iOS push — your console steps

The code side is done: the app registers for push natively on iOS
(@capacitor-firebase/messaging bridges APNs to FCM, so the backend's existing
firebase-admin send path works unchanged), the aps-environment entitlement and
remote-notification background mode are in the iOS project, and tokens
register with device_type ios.

Three console steps remain, all yours. Do them IN THIS ORDER, and note step 1
is REQUIRED BEFORE YOUR NEXT CODEMAGIC BUILD — the entitlement is already in
the project, and signing fails if the capability isn't enabled on the App ID.

## 1. Apple Developer — enable the Push capability (2 min, DO FIRST)

developer.apple.com → Certificates, Identifiers & Profiles → Identifiers →
`com.flockcorp.flock` → check **Push Notifications** → Save.
(Same flow as when you enabled Sign in with Apple. If Codemagic later
complains about the provisioning profile, delete the old profile like last
time and let it regenerate.)

## 2. Apple Developer — create an APNs key (3 min)

Certificates, Identifiers & Profiles → **Keys** → + → name it `FlockAPNs` →
check **Apple Push Notifications service (APNs)** → Continue → Register →
**Download the .p8 file** (one-time download — keep it) and note the
**Key ID** shown, plus your **Team ID** (top right of the page).

## 3. Firebase console — add the iOS app + APNs key (5 min)

console.firebase.google.com → the Flock project → Project settings (gear):

a. **General** tab → "Add app" → iOS → bundle ID `com.flockcorp.flock` →
   register → **download `GoogleService-Info.plist`**.
   Put that file at `frontend/ios/App/App/GoogleService-Info.plist`
   (drop it in the folder in Explorer, then tell Claude — it must also be
   added to the Xcode project file, which Claude does).

b. **Cloud Messaging** tab → Apple app configuration → **Upload** the .p8
   APNs key from step 2, entering its Key ID and your Team ID.

## Then

Tell Claude the plist is in place → project file wired → next Codemagic build
carries working push. Verify on device: Settings → notifications prompt on
first login, then send yourself a DM from another account with the app
backgrounded.
