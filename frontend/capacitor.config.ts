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
};

export default config;
