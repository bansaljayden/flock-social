// Glassmorphic button styles. backdrop-filter doesn't exist in RN, so we
// approximate with: layered semi-transparent fill + linear-gradient overlay
// for the top specular + multi-layer shadow + edge stroke.
//
// Note: a real backdrop blur (@react-native-community/blur) was removed — that
// library's BlurView dependency fails to resolve on JitPack and is semi-abandoned.
// The layered fill + gradient + shadow below reads as glass on its own. If a true
// blur is wanted later, use expo-blur (works on both platforms, no JitPack).
//
// blurProps below is retained as harmless config in case a blur lib is reintroduced.
//
// Each variant returns a style object you can spread onto a TouchableOpacity:
//   <TouchableOpacity style={glass.primary(colors).container}>
//     <LinearGradient {...glass.primary(colors).gradientProps} />
//     ... content ...
//   </TouchableOpacity>

import { Platform, StyleSheet } from 'react-native';

// Brand-navy gradient for the primary CTA. Matches the web app's
// "Start a Flock" button style: linear-gradient(180deg, #2d5a87 → #1e293b).
export const glassPrimary = (colors) => ({
  container: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#1e293b',
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: 0.45,
        shadowRadius: 24,
      },
      android: { elevation: 10 },
    }),
  },
  gradientProps: {
    colors: ['#2d5a87', '#1e293b'],
    start: { x: 0, y: 0 },
    end: { x: 0, y: 1 },
    style: StyleSheet.absoluteFill,
  },
  // Inset highlight at top edge (subtle)
  highlight: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  textColor: 'white',
});

// Default neutral glass — used for secondary actions like "Add Friends"
export const glassSecondary = (colors, isDark = true) => ({
  container: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.85)',
    borderWidth: 1,
    borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: isDark ? 0.32 : 0.12,
        shadowRadius: 24,
      },
      android: { elevation: 6 },
    }),
  },
  // BlurView props (only used on iOS — caller decides whether to render it)
  blurProps: { blurType: isDark ? 'dark' : 'light', blurAmount: 20, reducedTransparencyFallbackColor: isDark ? '#1e293b' : '#ffffff' },
  highlight: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: 1,
    backgroundColor: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.95)',
  },
  textColor: isDark ? colors.textPrimary : colors.navy,
});

// Danger variant — red. Used sparingly (logout, delete account, etc.).
// SOS button explicitly does NOT use this — it has its own non-glass gradient.
export const glassDanger = (colors) => ({
  container: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: 'rgba(239,68,68,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.35)',
    ...Platform.select({
      ios: {
        shadowColor: colors.red,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.25,
        shadowRadius: 14,
      },
      android: { elevation: 4 },
    }),
  },
  highlight: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  textColor: colors.accentRedText,
});

export default {
  primary: glassPrimary,
  secondary: glassSecondary,
  danger: glassDanger,
};
