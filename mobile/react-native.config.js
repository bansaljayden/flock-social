// Links bundled font assets into the native iOS/Android builds.
// After dropping the Satoshi .otf files into src/assets/fonts/, run:
//   npx react-native-asset
// which copies them in and registers UIAppFonts (iOS) + android assets.
// typography.js references Satoshi-Light/Regular/Medium/Bold/Black.
module.exports = {
  project: { ios: {}, android: {} },
  assets: ['./src/assets/fonts/'],
};
