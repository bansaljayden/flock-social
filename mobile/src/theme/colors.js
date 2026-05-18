// Direct port of every CSS variable from frontend/src/index.css.
// Light + dark palettes mirror :root and [data-theme="dark"] exactly.
// Brand accent values (navy/teal/amber/etc.) come from frontend/src/App.js
// colorsLight + colorsDark objects.

export const lightColors = {
  // Backgrounds
  bgPrimary: '#f1ede0',
  bgCard: 'rgba(255,255,255,0.95)',
  bgCardSolid: '#ffffff',
  bgInput: 'rgba(255,255,255,0.95)',
  bgNav: 'rgba(255,255,255,0.95)',
  bgModal: '#ffffff',
  bgHover: '#f3f4f6',
  bgTertiary: '#e8e0d5',
  bgElevated: '#ffffff',

  // Text
  textPrimary: '#1e293b',
  textSecondary: '#64748b',
  textTertiary: '#94a3b8',
  textOnPrimary: '#1e293b',

  // Borders
  borderColor: '#e8e0d0',
  borderLight: '#f3f4f6',
  borderDefault: '#e5e7eb',
  borderMid: '#d1d5db',
  borderSubtle: 'rgba(0,0,0,0.06)',
  divider: '#eeeeee',

  // Shadows (RN uses elevation+shadowColor — see shadows.js for platform-specific)
  cardShadowColor: '#0d2847',
  cardShadowOpacity: 0.08,

  // UI surfaces
  iconBg: '#f1ede0',
  modalBackdrop: 'rgba(0,0,0,0.5)',
  badgeBg: '#f1ede0',
  toggleOff: '#d1d5db',
  toggleKnob: '#ffffff',
  pillBg: '#e5e7eb',
  msgReceivedBg: '#ffffff',
  msgReceivedText: '#1e293b',
  reactionBg: '#ffffff',
  searchHighlight: '#fde047',
  skeletonBg: '#e5e7eb',
  lockedOverlay: 'rgba(255,255,255,0.9)',
  starEmpty: '#d1d5db',

  // Accents (the ×6 set)
  accentAmberBg: '#fef3c7',
  accentAmberText: '#b45309',
  accentRedBg: '#fee2e2',
  accentRedText: '#b91c1c',
  accentGreenBg: '#d1fae5',
  accentGreenText: '#047857',
  accentBlueBg: '#dbeafe',
  accentBlueText: '#1d4ed8',
  accentPurpleBg: '#faf5ff',
  accentPurpleText: '#7c3aed',
  accentPinkBg: '#fce7f3',
  accentPinkText: '#be185d',

  // Brand palette (from App.js colorsLight)
  navy: '#1e293b',
  navyBg: '#1e293b',
  navyLight: '#1a3a5c',
  navyMid: '#2d5a87',
  navyMidBg: '#2d5a87',
  skyBlue: '#4a7ba7',
  cream: '#f1ede0',
  creamDark: '#e8e0d5',
  teal: '#14B8A6',
  amber: '#F59E0B',
  red: '#EF4444',
  food: '#F97316',
  nightlife: '#1a3a5c',
  music: '#2d5a87',
  sports: '#22C55E',
};

export const darkColors = {
  // Backgrounds
  bgPrimary: '#0f172a',
  bgCard: '#1e293b',
  bgCardSolid: '#1e293b',
  bgInput: '#1e293b',
  bgNav: '#0f172a',
  bgModal: '#1e293b',
  bgHover: '#1e3a5c',
  bgTertiary: '#1e3a5c',
  bgElevated: '#1e293b',

  // Text
  textPrimary: '#f1ede0',
  textSecondary: '#94a3b8',
  textTertiary: '#64748b',
  textOnPrimary: '#f1ede0',

  // Borders
  borderColor: '#1e3a5c',
  borderLight: '#162d4a',
  borderDefault: '#1e3a5c',
  borderMid: '#2d5a87',
  borderSubtle: 'rgba(255,255,255,0.06)',
  divider: '#1e3a5c',

  // Shadows
  cardShadowColor: '#000000',
  cardShadowOpacity: 0.25,

  // UI surfaces
  iconBg: '#1e3a5c',
  modalBackdrop: 'rgba(0,0,0,0.7)',
  badgeBg: '#1e3a5c',
  toggleOff: '#2d5a87',
  toggleKnob: '#1e293b',
  pillBg: '#1e3a5c',
  msgReceivedBg: '#1e3a5c',
  msgReceivedText: '#f1ede0',
  reactionBg: '#1e293b',
  searchHighlight: 'rgba(253,224,71,0.3)',
  skeletonBg: '#1e3a5c',
  lockedOverlay: 'rgba(30,41,59,0.9)',
  starEmpty: '#2d5a87',

  // Accents
  accentAmberBg: 'rgba(245,158,11,0.15)',
  accentAmberText: '#fbbf24',
  accentRedBg: 'rgba(239,68,68,0.15)',
  accentRedText: '#f87171',
  accentGreenBg: 'rgba(16,185,129,0.15)',
  accentGreenText: '#34d399',
  accentBlueBg: 'rgba(59,130,246,0.15)',
  accentBlueText: '#60a5fa',
  accentPurpleBg: 'rgba(124,58,237,0.15)',
  accentPurpleText: '#a78bfa',
  accentPinkBg: 'rgba(190,24,93,0.15)',
  accentPinkText: '#f472b6',

  // Brand palette (from App.js colorsDark — note: navy is inverted to cream
  // in dark mode for use as primary text color, matching the web app's pattern)
  navy: '#f1ede0',
  navyBg: '#1e3a5c',
  navyLight: '#94a3b8',
  navyMid: '#64748b',
  navyMidBg: '#2d5a87',
  skyBlue: '#38bdf8',
  cream: '#0f172a',
  creamDark: '#1e3a5c',
  teal: '#14B8A6',
  amber: '#F59E0B',
  red: '#EF4444',
  food: '#F97316',
  nightlife: '#94a3b8',
  music: '#64748b',
  sports: '#22C55E',
};

// Default to dark — matches the web app's default theme.
export const defaultColors = darkColors;
