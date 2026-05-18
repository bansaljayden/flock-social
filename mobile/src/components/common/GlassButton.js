import React, { useRef } from 'react';
import { Pressable, Text, View, ActivityIndicator, Platform } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useTheme } from '../../context/ThemeContext';
import { glassPrimary, glassSecondary, glassDanger } from '../../theme/glass';
import { tap as hapticTap } from '../../utils/haptics';

// Pressable button with the glassmorphic styling from frontend/src/index.css
// (.glass-btn, .glass-primary, .glass-secondary, .glass-danger). Reanimated
// scales the button to 0.97 on press for tactile feedback (the same behavior
// as the web's CSS :active state).
//
// Variants: 'primary' (navy gradient — main CTA), 'secondary' (neutral glass),
// 'danger' (red glass for destructive actions). SOS button is a separate
// component, NOT this — emergency UI must not look glassy.

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function GlassButton({
  variant = 'secondary',
  onPress,
  disabled,
  loading,
  icon,
  children,
  style,
  textStyle,
  fullWidth = true,
}) {
  const { colors, isDark, typography } = useTheme();
  const scale = useSharedValue(1);

  const variantStyle = (
    variant === 'primary' ? glassPrimary(colors)
    : variant === 'danger' ? glassDanger(colors)
    : glassSecondary(colors, isDark)
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.97, { damping: 18, stiffness: 320 });
    hapticTap();
  };
  const handlePressOut = () => { scale.value = withSpring(1, { damping: 18, stiffness: 320 }); };

  const content = (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
      {loading ? (
        <ActivityIndicator size="small" color={variantStyle.textColor} />
      ) : (
        <>
          {icon}
          <Text
            style={[
              typography.bodyBold,
              { color: variantStyle.textColor, letterSpacing: -0.1 },
              textStyle,
            ]}
          >
            {children}
          </Text>
        </>
      )}
    </View>
  );

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled || loading}
      style={[
        variantStyle.container,
        fullWidth && { width: '100%' },
        disabled && { opacity: 0.5 },
        animatedStyle,
        style,
      ]}
    >
      {/* Primary variant uses a gradient fill behind content */}
      {variant === 'primary' && variantStyle.gradientProps && (
        <LinearGradient {...variantStyle.gradientProps} />
      )}
      {/* Top-edge specular highlight for all variants */}
      {variantStyle.highlight && <View style={variantStyle.highlight} />}
      {content}
    </AnimatedPressable>
  );
}
