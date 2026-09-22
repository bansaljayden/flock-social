import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.flockcorp.flock',
  appName: 'Flock',
  webDir: 'build',
  // THE ORIGIN CHANGE IS PARKED, NOT ABANDONED.
  //
  // Running the WebView on https://www.flockcorp.com instead of
  // capacitor://localhost is what would let iOS offer to save a Flock
  // password, and the webcredentials: entries in App.entitlements are already
  // in place for it. It was reverted on 2026-09-21 without ever reaching a
  // device, for two reasons that both point the same way:
  //
  //   * It shipped in the build that answers a "cannot sign in" rejection.
  //     That is the worst possible place for an untested change, and the app
  //     has now been rejected twice on that guideline.
  //   * The first recording run that carried it signed in three times and
  //     never reached the home screen. That is NOT proof it was the cause --
  //     the flow has a documented character-dropping flake on simulator
  //     typing, which is why it retries -- but it is the only untested thing
  //     in the build, and the cheapest way to tell them apart is to remove it.
  //
  // The real hazard to check before trying again: the app would claim an
  // origin that genuinely exists and is served over HTTPS with HSTS from
  // helmet, so WKWebView has a real host policy for it. Test it in a build of
  // its own, on a device, with nothing else in flight, and remember that it
  // signs every existing install out once because storage is keyed to the
  // origin.
  ios: {
    // The app manages all scrolling in inner containers; the WebView's own
    // scroll view only ever produced the "whole frame drags up and down"
    // rubber-band effect on device. Kill it at the native layer.
    scrollEnabled: false,
    // index.html declares viewport-fit=cover, so the WebView is edge to edge
    // and any pixel the web content has not painted yet falls through to the
    // native view behind it — the rounded screen corners and the strip behind
    // the home indicator are exactly those pixels. Without this the default
    // native background flashes there on launch and during theme transitions.
    //
    // One static colour has to serve both themes, so it matches the launch
    // screen / <meta name="theme-color"> navy rather than either app theme:
    // the handoff from splash to first paint is the only moment it is visible,
    // and matching the splash makes that handoff invisible. Once React mounts,
    // html/body paint var(--bg-primary) edge to edge (see index.css) and this
    // colour is fully covered in both light and dark mode.
    backgroundColor: '#0b1a2e',
  },
  plugins: {
    // THE KEYBOARD IS OUT OF LAYOUT, APP-WIDE.
    //
    // Capacitor's default is `native`, which resizes the WebView frame every
    // time the keyboard's height changes. Two things went wrong with that:
    //
    //   * The iOS QuickType / Passwords accessory bar counts as a keyboard
    //     height change, and iOS shows and hides it per letter as it re-scores
    //     autofill candidates. On the sign-in screen — a viewport-height
    //     scroll container — each toggle relayed out the whole column and
    //     re-scrolled the focused field, which is what read as the Passwords
    //     bar flashing on every keystroke and the screen re-rendering on tap.
    //   * The chat composer focuses on entry, so the keyboard began rising
    //     while the app was still in `native` mode: iOS shrank the WebView,
    //     the composer hook's own switch to `none` landed a moment later and
    //     it grew back. Two full relayouts of an un-virtualised message list
    //     during the entry animation.
    //
    // Declaring `none` here means the mode is already right at first paint, so
    // neither race can happen. The composer hook measures the keyboard and
    // lifts with a transform, which does not touch layout at all; screens that
    // do not use it pad by the visual viewport instead.
    Keyboard: {
      resize: 'none',
    },
    // @capgo/capacitor-social-login ships four providers and links all four
    // SDKs unless told otherwise. Only Google is wanted here, and the other
    // three are not neutral omissions:
    //
    //   facebook: false — otherwise the Facebook SDK is linked into the binary.
    //     It carries AppTrackingTransparency code, and the 2.1 reply to Apple
    //     states in writing that this app does no cross-app tracking and shows
    //     no ATT prompt. Nothing in Flock offers Facebook login.
    //   apple:    false — Sign in with Apple is already shipped by
    //     @capacitor-community/apple-sign-in (see AppleSignInButton.js). This
    //     flag governs only THIS plugin's Apple provider, which nothing calls;
    //     turning it off also drops Alamofire.
    //   twitter:  false — no such login exists in the app.
    //
    // The plugin reads this block in its own `capacitor:sync:before` hook and
    // comments the matching entries out of its Package.swift, so `npx cap sync
    // ios` is what makes it take effect. Every provider's Swift source is
    // guarded with `#if canImport(...)`, which is why disabling them compiles.
    SocialLogin: {
      providers: {
        google: true,
        facebook: false,
        apple: false,
        twitter: false,
      },
    },
  },
  experimental: {
    ios: {
      spm: {
        packageOptions: {
          // Required by @capacitor-firebase/messaging under SwiftPM — without
          // it, cap sync produces a package-identity collision with
          // firebase-ios-sdk and the iOS build fails (capacitor-firebase#959).
          '@capacitor-firebase/messaging': {
            symlink: true,
          },
          // The App plugin's own SwiftPM instructions require the same option;
          // without it a clean `cap sync ios` can hit the package-identity
          // collision before the archive step (round 6).
          '@capacitor-firebase/app': {
            symlink: true,
          },
        },
      },
    },
  },
};

export default config;
