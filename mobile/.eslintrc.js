module.exports = {
  root: true,
  extends: '@react-native',
  rules: {
    // Flock composes theme-dependent React Native styles at render time.
    'react-native/no-inline-styles': 'off',
    // Keep compact one-line guards while requiring braces for multi-line blocks.
    curly: ['error', 'multi-line'],
  },
};
