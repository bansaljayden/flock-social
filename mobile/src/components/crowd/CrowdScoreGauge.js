import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import Animated, {
  useSharedValue,
  useAnimatedProps,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { useTheme } from '../../context/ThemeContext';

// Replacement for the web AnimatedDial (App.js:35–102) which used Canvas + DPR
// scaling + offscreen caching. RN equivalent: an SVG arc whose stroke-dashoffset
// animates via Reanimated. Same visual language as the web version — circular
// progress, color graded by score, big number in the middle.

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export default function CrowdScoreGauge({ score = 0, label, size = 120, strokeWidth = 10 }) {
  const { colors, typography } = useTheme();

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(Math.max(0, Math.min(100, score)) / 100, {
      duration: 700,
      easing: Easing.out(Easing.cubic),
    });
  }, [score, progress]);

  const arcColor = score > 70 ? colors.red : score > 40 ? colors.amber : colors.teal;
  const trackColor = colors.borderDefault;

  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: circumference * (1 - progress.value),
  }));

  const labelColor = score > 70 ? colors.accentRedText
    : score > 40 ? colors.accentAmberText
    : colors.accentGreenText;

  return (
    <View style={[styles.wrap, { width: size, height: size }]}>
      <Svg width={size} height={size}>
        <Defs>
          <LinearGradient id="arcGrad" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={arcColor} stopOpacity="1" />
            <Stop offset="1" stopColor={arcColor} stopOpacity="0.8" />
          </LinearGradient>
        </Defs>

        {/* Track (background) */}
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={trackColor}
          strokeWidth={strokeWidth}
          fill="none"
        />

        {/* Animated progress arc — rotates -90deg so it starts at 12 o'clock */}
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="url(#arcGrad)"
          strokeWidth={strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${circumference}, ${circumference}`}
          animatedProps={animatedProps}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>

      {/* Number + label centered inside the ring */}
      <View style={styles.center} pointerEvents="none">
        <Text style={[typography.heading1, { color: colors.textPrimary, fontSize: size / 4, lineHeight: size / 4 + 2 }]}>
          {Math.round(score)}%
        </Text>
        {!!label && (
          <Text style={[typography.label, { color: labelColor, marginTop: 2, letterSpacing: 0.4 }]}>
            {label.toUpperCase()}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  center: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
});
