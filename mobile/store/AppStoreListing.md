# Flock — App Store Listing Copy (v1 draft)

Drafts below. Apple character limits in parentheses. Pick one option per field; no need to use every variant.

---

## App Name (30 chars)

**Primary:** `Flock` *(5)*

If "Flock" is taken on App Store Connect, fall back to:
- `Flock — Plan Tonight` *(20)*
- `Flock: Plans with Friends` *(25)*

---

## Subtitle (30 chars)

Pick one. Subtitles are weighted in App Store search.

1. `Plan tonight with friends` *(25)* — clearest
2. `Group coordination, simplified` *(30)*
3. `Where your group actually meets` *(31 — trim a char)*
4. `Make plans, not group chats` *(27)*

**Recommend: 1.**

---

## Promotional Text (170 chars, editable any time without re-review)

> New: live crowd predictions for every venue. See where your friends are, what's busy, and pick the perfect spot — without the group-chat chaos.

*(143 chars)*

---

## Description (4,000 chars)

> Flock is the social coordination app that replaces broken group chats with structured plans. Create a flock, invite friends, vote on venues, and confirm — without the 47 unread messages.
>
> **Built for Gen Z. Designed to actually get the group out the door.**
>
> ━━━ WHAT YOU CAN DO ━━━
>
> ✦ **Start a flock in seconds.** Invite friends, set a vibe, watch RSVPs roll in.
>
> ✦ **Vote on venues, not vibes.** Search restaurants, bars, and live spots from Google Places. Vote with one tap. Whoever has the most votes wins — no more "wherever".
>
> ✦ **See real-time crowd levels.** Flock predicts how busy a place will be, hour by hour, using ML trained on millions of data points. No more showing up to a 2-hour wait.
>
> ✦ **Anonymous budget matching.** Everyone submits what they can spend. Flock surfaces the group ceiling — never your individual amount. Filter venues to what fits everyone.
>
> ✦ **Bill-split that actually works.** Tap to split, tap to send. Deep links into Venmo, CashApp, or Zelle — no Flock balance to top up.
>
> ✦ **Live location sharing — only when you want it.** Share within the flock, only while it's active. No background tracking, ever.
>
> ✦ **Built-in safety.** SOS button alerts your trusted contacts with your location instantly. Designed for the moments group plans stop being fun.
>
> ✦ **Direct messages and stories.** Talk one-on-one or post quick updates that disappear in 24 hours.
>
> ✦ **Bird the AI assistant.** Ask Bird where to go tonight. It knows the city, the crowd, the weather, and your group.
>
> ━━━ WHY FLOCK ━━━
>
> Group chats weren't built for plans. Three of you say yes, two say maybe, one drops a venue link nobody opens, and by 9pm the energy is dead. Flock is the structured layer on top: invitation, RSVP, venue, budget, confirm, go.
>
> No ads. No selling your data. No engagement-bait notifications.
>
> ━━━ WHO IT'S FOR ━━━
>
> Friend groups planning weekend nights. College crews. Birthday squads. Anyone tired of orchestrating six people through DMs.
>
> ━━━ PRIVACY FIRST ━━━
>
> Your messages are between you and your group. Your budget is your business. Live location only flows when you turn it on. Read the full policy at flockcorp.com/privacy.
>
> ━━━ PREMIUM (OPTIONAL) ━━━
>
> Free forever for the core flow. Premium unlocks unlimited flocks, advanced crowd predictions, priority venue search, and ML-powered "where should we go?" recommendations.
>
> ---
>
> Questions? support@flockcorp.com
> Web: flockcorp.com

*(~2,500 chars — room to add testimonials once you have them.)*

---

## Keywords (100 chars, comma-separated, NO spaces around commas)

`group chat,plans,friends,venue,crowd,nightlife,split bill,rsvp,social,planner,hangout,nightlife app`

*(~99 chars — counted manually, verify in App Store Connect)*

Avoid: words already in App Name/Subtitle (Apple indexes those automatically — wasted slots).

---

## Support URL

`https://flockcorp.com/support`

*(needs DNS + a /support page or simple email mailto: — see TODOs below)*

## Marketing URL (optional)

`https://flockcorp.com`

## Privacy Policy URL (REQUIRED)

`https://flockcorp.com/privacy`

*(page exists at /privacy — works once DNS points flockcorp.com → Vercel; in the meantime use `https://flock-app-w65m.vercel.app/privacy`)*

---

## Category

- **Primary:** Social Networking
- **Secondary:** Lifestyle

---

## Age Rating Questionnaire (likely answers)

| Question | Answer |
|---|---|
| Cartoon or Fantasy Violence | None |
| Realistic Violence | None |
| Sexual Content or Nudity | None |
| Profanity or Crude Humor | None |
| Alcohol, Tobacco, or Drug Use | **Infrequent/Mild** (venues include bars) |
| Mature/Suggestive Themes | None |
| Horror/Fear Themes | None |
| Gambling | None |
| Unrestricted Web Access | No |
| **User-Generated Content** | **Yes** (chat, stories) |
| **Location Services** | **Yes** (opt-in live share + SOS) |
| Personalized Ads | No |

**Expected rating: 12+** (UGC + alcohol-adjacent content). 17+ only if you allow unfiltered mature content, which Flock doesn't.

---

## What's New in This Version (4,000 chars, per release)

> v1.0 — first public release.
>
> Plan nights out without the group-chat chaos. Create a flock, invite friends, vote on venues, see live crowd levels, split the bill in one tap. Built for the friend groups Apple's calendar wasn't designed for.

---

## Privacy Nutrition Labels (App Store Connect questionnaire)

Map this to "Data Used to Track You" / "Data Linked to You" / "Data Not Linked to You". For Flock:

### Data Linked to You
- **Contact Info:** Email Address, Phone Number (optional), Name
- **User Content:** Photos or Videos, Customer Support, Other User Content (chat messages, stories)
- **Identifiers:** User ID
- **Usage Data:** Product Interaction (PostHog)
- **Diagnostics:** Crash Data, Performance Data
- **Location:** Precise Location (only when SOS or live share is active)
- **Financial Info:** Other Financial Info (budget submissions — but server-private)

### Data Not Linked to You
- (none — everything Flock collects ties to a user account)

### Data Used to Track You
- **None.** Flock does not use any data to track users across other companies' apps or websites.

---

## Screenshots — required sizes (must include)

| Device | Resolution | Required? |
|---|---|---|
| 6.9" (iPhone 16 Pro Max) | 1290 × 2796 | YES |
| 6.7" (iPhone 14 Pro Max) | 1290 × 2796 | recommended |
| 6.5" (iPhone 11 Pro Max) | 1284 × 2778 | recommended |
| 5.5" (iPhone 8 Plus) | 1242 × 2208 | RETIRED — no longer required |
| 12.9" iPad Pro | 2048 × 2732 | only if iPad supported |

Recommend 5–8 screenshots per device size. Suggested storyboard:
1. Hero / brand shot — "Plan tonight with friends" overlay
2. NestScreen home view (flock list, stats, action buttons)
3. CreateFlockScreen — "Start a flock in seconds"
4. DiscoverScreen map with crowd-colored pins — "See who's busy, live"
5. FlockChatScreen with venue card + voting — "Vote, don't debate"
6. BudgetSubmitScreen — "Anonymous budget matching"
7. SafetyScreen with SOS — "Built-in safety"
8. ProfileScreen — premium upsell or stats — "Free forever for the core flow"

---

## Open TODOs before submission

- [ ] DNS: point flockcorp.com → Vercel app (so /privacy + /support resolve at the canonical URLs)
- [x] **Build a /support page** — done 2026-05-03. `frontend/src/website/SupportPage.js` wired into `index.js` at `/support`. Lives at `flock-app-w65m.vercel.app/support` until DNS, then `flockcorp.com/support`.
- [ ] Capture screenshots on real device or simulator (Mac required)
- [ ] App icon 1024×1024 PNG (no transparency, no rounded corners — Apple adds them)
- [ ] iOS launch screen / splash
- [x] **Bundle ID finalized** — `com.flockcorp.flock`. Set in `mobile/ios/Flock.xcodeproj/project.pbxproj` (Debug + Release) and `mobile/android/app/build.gradle` (`namespace` + `applicationId`). Kotlin sources moved to `com/flockcorp/flock/` package. Decision date: 2026-05-03.
- [x] **iOS Info.plist usage descriptions** — done 2026-05-03. NSLocationWhenInUseUsageDescription, NSCameraUsageDescription, NSPhotoLibraryUsageDescription, NFCReaderUsageDescription all populated with App-Store-acceptable strings. LSApplicationQueriesSchemes added for venmo/cashapp/cash-app/zelle/tel/sms/mailto. UIBackgroundModes set to remote-notification for FCM background push.
- [x] **Android AndroidManifest permissions + queries** — done 2026-05-03. Added INTERNET, ACCESS_FINE/COARSE_LOCATION, CAMERA, READ_MEDIA_IMAGES (+ READ_EXTERNAL_STORAGE maxSdk=32 for older), POST_NOTIFICATIONS, VIBRATE, NFC. Added `<queries>` block for Venmo/CashApp/Zelle package visibility (Android 11+ requires this for `Linking.canOpenURL` to detect installed apps), plus mailto/tel intent filters. Google Maps API key wired via `manifestPlaceholders` reading `GOOGLE_MAPS_API_KEY` gradle property (set via `~/.gradle/gradle.properties` or `-PGOOGLE_MAPS_API_KEY=...` flag — defaults to empty so build doesn't fail). Also added Universal Links autoVerify intent-filter for `https://flockcorp.com` and `flock://` scheme. Buildtype manifestPlaceholders switched to `[]=` syntax so they merge with defaultConfig instead of replacing.
- [ ] Promo text proofread by a second pair of eyes
- [ ] Decide on premium tier price (**locked: $14.99/mo, $99.99/yr** per port plan) — RevenueCat product config still needs IAP setup in App Store Connect + Google Play Console
- [ ] Privacy nutrition label questionnaire actually filled in App Store Connect (answers drafted above)
- [ ] Legal review of /privacy page before public launch
- [ ] **`mobile/` not committed to git** — entire mobile dir is untracked. Decide whether to commit ios/+android/ or rely on `npx ... init Flock` regeneration on Mac. If regenerated, all native config edits above (bundle ID, Info.plist, Kotlin packages) will be wiped and need to be re-applied.
