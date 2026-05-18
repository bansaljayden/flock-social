// RN shadow styles. iOS uses shadow* props; Android uses elevation only
// (color is ignored on Android pre-API 28). Use these helpers everywhere
// instead of inline shadows so the look stays consistent.

import { Platform } from 'react-native';

// Mirrors --card-shadow from index.css:
//   light: 0 4px 24px rgba(13,40,71,0.08), 0 1px 3px rgba(0,0,0,0.04)
//   dark:  0 4px 24px rgba(0,0,0,0.25),    0 1px 3px rgba(0,0,0,0.15)
export const cardShadow = (colors) => Platform.select({
  ios: {
    shadowColor: colors.cardShadowColor,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: colors.cardShadowOpacity,
    shadowRadius: 12,
  },
  android: {
    elevation: 4,
  },
});

// Smaller card shadow — for inline cards/badges
export const cardShadowSm = (colors) => Platform.select({
  ios: {
    shadowColor: colors.cardShadowColor,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: colors.cardShadowOpacity * 0.7,
    shadowRadius: 3,
  },
  android: {
    elevation: 2,
  },
});

// Heavier shadow — for floating action buttons, primary CTAs
export const ctaShadow = (colors) => Platform.select({
  ios: {
    shadowColor: colors.navyMidBg,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.32,
    shadowRadius: 14,
  },
  android: {
    elevation: 8,
  },
});

// Bottom-nav shadow — points upward, subtle
export const navShadow = (colors) => Platform.select({
  ios: {
    shadowColor: colors.cardShadowColor,
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: colors.cardShadowOpacity * 0.75,
    shadowRadius: 12,
  },
  android: {
    elevation: 6,
  },
});
