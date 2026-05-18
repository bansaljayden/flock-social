// Satoshi font scale. Font files must be placed in src/assets/fonts/ and
// linked via `npx react-native-asset` after adding them to package.json:
//   "react-native": { "assets": ["./src/assets/fonts/"] }
//
// Required font files (download from Fontshare, free for commercial use):
//   Satoshi-Light.otf, Satoshi-Regular.otf, Satoshi-Medium.otf,
//   Satoshi-Bold.otf, Satoshi-Black.otf

export const fontFamily = {
  light: 'Satoshi-Light',
  regular: 'Satoshi-Regular',
  medium: 'Satoshi-Medium',
  bold: 'Satoshi-Bold',
  black: 'Satoshi-Black',
};

// Type scale — values match the web app's typical font sizes by context.
// Tweaked +1px on body text where iOS readability calls for it.
export const typography = {
  display: { fontFamily: fontFamily.black, fontSize: 32, letterSpacing: -0.6, lineHeight: 36 },
  heading1: { fontFamily: fontFamily.black, fontSize: 28, letterSpacing: -0.5, lineHeight: 32 },
  heading2: { fontFamily: fontFamily.bold, fontSize: 22, letterSpacing: -0.3, lineHeight: 26 },
  heading3: { fontFamily: fontFamily.bold, fontSize: 18, letterSpacing: -0.2, lineHeight: 22 },
  heading4: { fontFamily: fontFamily.bold, fontSize: 15, letterSpacing: -0.1, lineHeight: 20 },
  body: { fontFamily: fontFamily.regular, fontSize: 15, lineHeight: 22 },
  bodyBold: { fontFamily: fontFamily.bold, fontSize: 15, lineHeight: 22 },
  bodySmall: { fontFamily: fontFamily.regular, fontSize: 13, lineHeight: 18 },
  bodySmallBold: { fontFamily: fontFamily.bold, fontSize: 13, lineHeight: 18 },
  label: { fontFamily: fontFamily.medium, fontSize: 11, letterSpacing: 0.4, lineHeight: 14 },
  labelBold: { fontFamily: fontFamily.bold, fontSize: 11, letterSpacing: 0.6, lineHeight: 14, textTransform: 'uppercase' },
  caption: { fontFamily: fontFamily.regular, fontSize: 10, lineHeight: 13 },
  number: { fontFamily: fontFamily.black, fontSize: 32, letterSpacing: -0.8, lineHeight: 32 },
  numberLg: { fontFamily: fontFamily.black, fontSize: 48, letterSpacing: -1.2, lineHeight: 48 },
};
