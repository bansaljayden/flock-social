import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import GlassButton from '../../components/common/GlassButton';
import FlockCard from '../../components/flock/FlockCard';
import {
  getFlocks,
  getUserStats,
  getMyAvailability,
  setAvailability,
  clearAvailability,
} from '../../services/api';
import { readCache, writeCache, CacheKeys } from '../../services/offlineCache';

const PULSE_OPTIONS = [
  { key: 'down',  label: 'Down',  colorKey: 'sports' },   // green-ish
  { key: 'maybe', label: 'Maybe', colorKey: 'amber' },
  { key: 'not',   label: 'Not',   colorKey: 'textTertiary' },
];

// Mirrors the web HomeScreen layout (the de-vibe-coded version):
//   Header: greeting + name + avatar
//   Stats row: Flocks / Friends / Tonight (3-tap pulse)
//   Action buttons: Start a Flock + Add Friends
//   Your Flocks list (FlockCards)

export default function NestScreen({ navigation }) {
  const { colors, typography, screenPadding, radius } = useTheme();
  const { user } = useAuth();

  const [flocks, setFlocks] = useState([]);
  const [stats, setStats] = useState({ flockCount: 0, friendCount: 0 });
  const [pulse, setPulse] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pulseSaving, setPulseSaving] = useState(false);

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 5) return 'Late night';
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  })();

  const loadAll = useCallback(async () => {
    try {
      const [flocksRes, statsRes, pulseRes] = await Promise.all([
        getFlocks().catch(() => ({ flocks: [] })),
        getUserStats().catch(() => ({ flockCount: 0, friendCount: 0 })),
        getMyAvailability().catch(() => ({ pulse: null })),
      ]);
      const list = flocksRes.flocks || [];
      setFlocks(list);
      const newStats = {
        flockCount: statsRes.flockCount ?? statsRes.activeFlocks ?? list.length,
        friendCount: statsRes.friendCount ?? 0,
      };
      setStats(newStats);
      setPulse(pulseRes?.pulse || null);
      // Persist for next cold start so the screen isn't empty offline
      writeCache(CacheKeys.Flocks, list);
      writeCache(CacheKeys.Stats, newStats);
    } catch (e) {
      console.warn('NestScreen load failed:', e.message);
    }
  }, []);

  // Hydrate cache on first mount so the screen doesn't flash blank when
  // offline or on slow networks.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      readCache(CacheKeys.Flocks),
      readCache(CacheKeys.Stats),
    ]).then(([flocksEntry, statsEntry]) => {
      if (cancelled) return;
      if (flocksEntry?.value) setFlocks(flocksEntry.value);
      if (statsEntry?.value) setStats(statsEntry.value);
    });
    return () => { cancelled = true; };
  }, []);

  useFocusEffect(useCallback(() => { loadAll(); }, [loadAll]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  }, [loadAll]);

  const handlePulse = async (key) => {
    if (pulseSaving) return;
    setPulseSaving(true);
    try {
      // Tapping the active option clears it; otherwise set it.
      if (pulse?.status === key) {
        await clearAvailability();
        setPulse(null);
      } else {
        // Default expiry = 4am next-day local
        const exp = new Date();
        exp.setDate(exp.getDate() + (exp.getHours() < 4 ? 0 : 1));
        exp.setHours(4, 0, 0, 0);
        const data = await setAvailability({ status: key, expiresAt: exp.toISOString() });
        setPulse(data?.pulse || { status: key });
      }
    } catch (e) {
      console.warn('Pulse update failed:', e.message);
    } finally {
      setPulseSaving(false);
    }
  };

  const firstName = (user?.name || '').split(' ')[0] || 'there';

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ padding: screenPadding.default, paddingBottom: 96 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.teal} />}
      >
        {/* Header */}
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={[typography.label, { color: colors.textTertiary, letterSpacing: 0.3 }]}>{greeting}</Text>
            <Text style={[typography.heading1, { color: colors.textPrimary, marginTop: 2 }]} numberOfLines={1}>
              Hey, {firstName}
            </Text>
          </View>
          <TouchableOpacity onPress={() => navigation.navigate('YouTab')} style={[styles.avatar, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault }]}>
            {user?.profile_image_url ? (
              <Image source={{ uri: user.profile_image_url }} style={styles.avatarImg} />
            ) : (
              <Icon name="user" size={18} color={colors.textSecondary} />
            )}
          </TouchableOpacity>
        </View>

        {/* Stats row */}
        <View style={[styles.statsRow, { gap: 8, marginTop: 14 }]}>
          <StatTile label="Flocks" value={stats.flockCount} />
          <StatTile label="Friends" value={stats.friendCount} />
          <PulseTile pulse={pulse} onPick={handlePulse} disabled={pulseSaving} />
        </View>

        {/* Action buttons */}
        <View style={[styles.actionRow, { marginTop: 16, gap: 10 }]}>
          <View style={{ flex: 1 }}>
            <GlassButton
              variant="primary"
              icon={<Icon name="plus" size={16} color="white" />}
              onPress={() => navigation.navigate('CreateFlock')}
            >
              Start a Flock
            </GlassButton>
          </View>
          <View style={{ flex: 1 }}>
            <GlassButton
              variant="secondary"
              icon={<Icon name="user-plus" size={15} color={colors.textPrimary} />}
              onPress={() => navigation.navigate('AddFriends')}
            >
              Add Friends
            </GlassButton>
          </View>
        </View>

        {/* Your Flocks */}
        <Text style={[typography.heading4, { color: colors.textPrimary, marginTop: 24, marginBottom: 8 }]}>Your Flocks</Text>
        {flocks.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xxl }]}>
            <Text style={[typography.body, { color: colors.textSecondary, textAlign: 'center' }]}>
              No flocks yet. Start one above and invite your friends.
            </Text>
          </View>
        ) : (
          flocks.map((f) => (
            <FlockCard
              key={f.id}
              flock={f}
              onPress={() => navigation.navigate('FlockDetail', { flockId: f.id })}
            />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// Inner — used inside the stats row
function StatTile({ label, value }) {
  const { colors, typography, radius } = useTheme();
  return (
    <View style={[stStyles.tile, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xl }]}>
      <Text style={[typography.label, { color: colors.textTertiary, letterSpacing: 0.4 }]}>{label.toUpperCase()}</Text>
      <Text style={[typography.numberLg, { color: colors.textPrimary, fontSize: 22, lineHeight: 24, marginTop: 4 }]}>{value}</Text>
    </View>
  );
}

function PulseTile({ pulse, onPick, disabled }) {
  const { colors, typography, radius } = useTheme();
  return (
    <View style={[stStyles.tile, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xl }]}>
      <Text style={[typography.label, { color: colors.textTertiary, letterSpacing: 0.4, marginBottom: 6 }]}>TONIGHT</Text>
      {PULSE_OPTIONS.map((opt) => {
        const active = pulse?.status === opt.key;
        const dotColor = colors[opt.colorKey] || colors.textTertiary;
        return (
          <TouchableOpacity
            key={opt.key}
            onPress={() => onPick(opt.key)}
            disabled={disabled}
            style={pulseRowStyles.row}
          >
            <View
              style={[
                pulseRowStyles.dot,
                {
                  backgroundColor: dotColor,
                  shadowColor: dotColor,
                  shadowOpacity: active ? 1 : 0,
                  shadowRadius: active ? 4 : 0,
                  shadowOffset: { width: 0, height: 0 },
                },
              ]}
            />
            <Text
              style={[
                typography.bodySmall,
                {
                  color: active ? colors.textPrimary : colors.textTertiary,
                  fontFamily: active ? typography.bodySmallBold.fontFamily : typography.bodySmall.fontFamily,
                },
              ]}
            >
              {opt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerRow: { flexDirection: 'row', alignItems: 'center' },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', borderWidth: 1, overflow: 'hidden' },
  avatarImg: { width: 36, height: 36 },
  statsRow: { flexDirection: 'row' },
  actionRow: { flexDirection: 'row' },
  emptyCard: { padding: 24, borderWidth: 1, alignItems: 'center' },
});

const stStyles = StyleSheet.create({
  tile: { flex: 1, padding: 12, borderWidth: 1 },
});

const pulseRowStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 1 },
  dot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
});
