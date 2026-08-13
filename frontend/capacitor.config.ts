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
