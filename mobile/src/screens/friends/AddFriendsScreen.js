import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';

// Phase 5 expands this into the full Snapchat-style search/QR/contacts flow.
// Phase 2 ships a navigable stub so NestScreen's "Add Friends" button works.

export default function AddFriendsScreen({ navigation }) {
  const { colors, typography, screenPadding, radius } = useTheme();
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={['top']}>
      <View style={[styles.header, { paddingHorizontal: screenPadding.default }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
          <Icon name="chevron-left" size={26} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={[typography.heading3, { color: colors.textPrimary }]}>Add Friends</Text>
        <View style={styles.headerBtn} />
      </View>
      <View style={[styles.center, { padding: screenPadding.default }]}>
        <View style={[styles.card, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xxl }]}>
          <Icon name="users" size={32} color={colors.textTertiary} />
          <Text style={[typography.body, { color: colors.textSecondary, marginTop: 12, textAlign: 'center' }]}>
            Search, QR codes, and contact matching land in Phase 5.
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: { padding: 32, borderWidth: 1, alignItems: 'center', maxWidth: 320 },
});
