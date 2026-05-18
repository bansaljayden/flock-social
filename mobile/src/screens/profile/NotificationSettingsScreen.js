import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';

// Phase 6 lands per-event toggles + the actual APNs registration flow.
// For Phase 5 this is a navigable stub so ProfileScreen's row works.

export default function NotificationSettingsScreen({ navigation }) {
  const { colors, typography, screenPadding, radius } = useTheme();
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={['top']}>
      <View style={[styles.header, { paddingHorizontal: screenPadding.default }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
          <Icon name="chevron-left" size={26} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={[typography.heading3, { color: colors.textPrimary }]}>Notifications</Text>
        <View style={styles.headerBtn} />
      </View>
      <View style={{ padding: screenPadding.default, alignItems: 'center', justifyContent: 'center', flex: 1 }}>
        <View style={[styles.card, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xxl }]}>
          <Icon name="bell" size={28} color={colors.textTertiary} />
          <Text style={[typography.body, { color: colors.textSecondary, marginTop: 12, textAlign: 'center' }]}>
            Push registration + per-event toggles ship in Phase 6 alongside the APNs setup.
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, paddingBottom: 8 },
  headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  card: { padding: 32, borderWidth: 1, alignItems: 'center', maxWidth: 320 },
});
