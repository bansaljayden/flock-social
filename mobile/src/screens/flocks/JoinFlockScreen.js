import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';

export default function JoinFlockScreen({ route }) {
  const { colors, typography } = useTheme();
  const code = route?.params?.code;
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={['top']}>
      <View style={styles.center}>
        <Text style={[typography.heading1, { color: colors.textPrimary }]}>Join Flock</Text>
        <Text style={[typography.body, { color: colors.textSecondary, marginTop: 8 }]}>code={String(code)}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
