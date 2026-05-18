import React, { useEffect } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { useSocket } from '../../context/SocketContext';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';

// Thin banner that slides down from the top when the socket isn't
// connected. Stays out of the way during normal use; appears only on
// real disconnects (transient blips lasting <500ms don't trigger thanks
// to the small mount delay).

export default function ConnectionBanner() {
  const { connected } = useSocket();
  const { user } = useAuth();
  const { colors, typography } = useTheme();

  const offset = useSharedValue(-60);

  useEffect(() => {
    // Only show when authenticated AND disconnected. Pre-login disconnect
    // is expected and shouldn't surface anything.
    const shouldShow = !!user && connected === false;
    offset.value = withTiming(shouldShow ? 0 : -60, { duration: 240 });
  }, [user, connected, offset]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.value }],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.banner,
        animatedStyle,
        { backgroundColor: colors.accentAmberBg, borderBottomColor: colors.accentAmberText + '40' },
      ]}
    >
      <SafeAreaView edges={['top']}>
        <View style={styles.row}>
          <Text style={[typography.bodySmallBold, { color: colors.accentAmberText }]}>
            Reconnecting…
          </Text>
        </View>
      </SafeAreaView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    zIndex: 999,
    borderBottomWidth: 1,
  },
  row: {
    paddingVertical: 6,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
});
