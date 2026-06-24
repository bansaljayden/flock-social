import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Image,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { launchImageLibrary } from 'react-native-image-picker';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { getUserStats, uploadProfileImage, saveProfileImageUrl, deleteAccount } from '../../services/api';
import GlassButton from '../../components/common/GlassButton';

export default function ProfileScreen({ navigation }) {
  const { colors, typography, screenPadding, radius, mode, setMode } = useTheme();
  const { user, logout, refresh } = useAuth();

  const [stats, setStats] = useState({ flockCount: 0, friendCount: 0, streak: 0, reliabilityScore: null });

  useEffect(() => {
    getUserStats().then((d) => setStats({
      flockCount: d.flockCount ?? d.activeFlocks ?? 0,
      friendCount: d.friendCount ?? 0,
      streak: d.streak ?? 0,
      reliabilityScore: d.reliabilityScore ?? null,
    })).catch(() => {});
  }, []);

  const changePhoto = async () => {
    const res = await launchImageLibrary({ mediaType: 'photo', quality: 0.8 });
    if (res.didCancel || !res.assets?.[0]) return;
    const asset = res.assets[0];
    try {
      const u = await uploadProfileImage({
        uri: asset.uri,
        type: asset.type || 'image/jpeg',
        name: asset.fileName || 'profile.jpg',
      });
      const url = u?.url || u?.image_url;
      if (url) {
        await saveProfileImageUrl(url);
        await refresh();
      }
    } catch (e) {
      Alert.alert('Upload failed', e.message);
    }
  };

  const confirmDeleteAccount = () => {
    Alert.alert(
      'Delete account?',
      'This permanently deletes your account and all your data — flocks you created, messages, friends, and payment info. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete account',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteAccount();
              await logout(); // clears token → RootNavigator returns to Auth
            } catch (e) {
              Alert.alert('Could not delete account', e.message);
            }
          },
        },
      ],
    );
  };

  const cycleTheme = () => {
    const next = mode === 'dark' ? 'light' : mode === 'light' ? 'auto' : 'dark';
    setMode(next);
  };
  const themeLabel = mode === 'dark' ? 'Dark' : mode === 'light' ? 'Light' : 'Auto';

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={['top']}>
      <ScrollView contentContainerStyle={{ padding: screenPadding.default, paddingBottom: 96 }}>

        {/* Hero */}
        <View style={styles.heroBlock}>
          <TouchableOpacity onPress={changePhoto} activeOpacity={0.85}>
            <View style={[styles.avatar, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault }]}>
              {user?.profile_image_url ? (
                <Image source={{ uri: user.profile_image_url }} style={styles.avatarImg} />
              ) : (
                <Text style={[typography.heading1, { color: colors.textTertiary }]}>{(user?.name || '?')[0].toUpperCase()}</Text>
              )}
              <View style={[styles.cameraBadge, { backgroundColor: colors.teal }]}>
                <Icon name="camera" size={12} color="white" />
              </View>
            </View>
          </TouchableOpacity>
          <Text style={[typography.heading2, { color: colors.textPrimary, marginTop: 12 }]}>{user?.name || 'You'}</Text>
          <Text style={[typography.bodySmall, { color: colors.textSecondary, marginTop: 2 }]}>{user?.email || ''}</Text>
        </View>

        {/* Stats row */}
        <View style={[styles.statsRow, { gap: 8, marginTop: 18 }]}>
          <StatTile label="Flocks" value={stats.flockCount} />
          <StatTile label="Friends" value={stats.friendCount} />
          <StatTile label="Streak" value={stats.streak} />
          <StatTile label="Reliable" value={stats.reliabilityScore != null ? `${Math.round(stats.reliabilityScore)}%` : '—'} />
        </View>

        {/* Settings sections */}
        <SectionList
          items={[
            { icon: 'credit-card', label: 'Payment Methods', onPress: () => navigation.navigate('PaymentSettings') },
            { icon: 'bell', label: 'Notifications', onPress: () => navigation.navigate('NotificationSettings') },
            { icon: 'shield', label: 'Safety & Emergency', onPress: () => navigation.navigate('Safety') },
            { icon: 'users', label: 'Friends', onPress: () => navigation.navigate('Friends') },
          ]}
        />

        {/* Theme toggle (inline, not a sub-screen) */}
        <View style={[styles.row, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xl, marginTop: 16 }]}>
          <View style={styles.rowIconBox}><Icon name="moon" size={18} color={colors.textPrimary} /></View>
          <Text style={[typography.body, { color: colors.textPrimary, flex: 1 }]}>Appearance</Text>
          <TouchableOpacity onPress={cycleTheme} style={[styles.themePill, { borderColor: colors.borderDefault, borderRadius: radius.pill }]}>
            <Text style={[typography.bodySmallBold, { color: colors.teal }]}>{themeLabel}</Text>
          </TouchableOpacity>
        </View>

        {/* Footer / logout */}
        <View style={{ marginTop: 32, gap: 10 }}>
          <GlassButton
            variant="danger"
            onPress={() => Alert.alert('Log out?', 'You can log back in anytime.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Log out', style: 'destructive', onPress: logout },
            ])}
          >
            Log out
          </GlassButton>

          <TouchableOpacity onPress={confirmDeleteAccount} style={styles.deleteBtn} activeOpacity={0.7}>
            <Text style={[typography.bodySmall, { color: colors.red }]}>Delete account</Text>
          </TouchableOpacity>
        </View>

        <Text style={[typography.caption, { color: colors.textTertiary, textAlign: 'center', marginTop: 20 }]}>
          Flock · v0.1
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function StatTile({ label, value }) {
  const { colors, typography, radius } = useTheme();
  return (
    <View style={[styles.statTile, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xl }]}>
      <Text style={[typography.label, { color: colors.textTertiary, letterSpacing: 0.4 }]}>{label.toUpperCase()}</Text>
      <Text style={[typography.heading3, { color: colors.textPrimary, marginTop: 2 }]}>{value}</Text>
    </View>
  );
}

function SectionList({ items }) {
  const { colors, typography, radius } = useTheme();
  return (
    <View style={[styles.sectionGroup, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xl, marginTop: 24, overflow: 'hidden' }]}>
      {items.map((item, i) => (
        <TouchableOpacity
          key={item.label}
          onPress={item.onPress}
          style={[
            styles.row,
            { borderBottomWidth: i < items.length - 1 ? StyleSheet.hairlineWidth : 0, borderBottomColor: colors.borderSubtle, borderRadius: 0 },
          ]}
        >
          <View style={styles.rowIconBox}><Icon name={item.icon} size={18} color={colors.textPrimary} /></View>
          <Text style={[typography.body, { color: colors.textPrimary, flex: 1 }]}>{item.label}</Text>
          <Icon name="chevron-right" size={18} color={colors.textTertiary} />
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  heroBlock: { alignItems: 'center', paddingTop: 12 },
  avatar: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center', borderWidth: 2, overflow: 'hidden' },
  avatarImg: { width: 96, height: 96 },
  cameraBadge: {
    position: 'absolute', bottom: 0, right: 0,
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: 'white',
  },
  statsRow: { flexDirection: 'row' },
  statTile: { flex: 1, padding: 12, borderWidth: 1, alignItems: 'center' },
  sectionGroup: { borderWidth: 1 },
  row: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12, borderWidth: 0 },
  rowIconBox: { width: 24, alignItems: 'center' },
  themePill: { paddingHorizontal: 12, paddingVertical: 4, borderWidth: 1 },
  deleteBtn: { alignSelf: 'center', paddingVertical: 10, marginTop: 2 },
});
