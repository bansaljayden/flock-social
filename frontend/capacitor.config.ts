import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.flockcorp.flock',
  appName: 'Flock',
  webDir: 'build',
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
