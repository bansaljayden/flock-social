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
        },
      },
    },
  },
};

export default config;
