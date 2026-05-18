import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { cardShadow } from '../../theme/shadows';

// Approximation of the web flock-stack-card. Doesn't fan/stack — RN's
// transform-based stack is fragile inside scroll views. Clean flat card with
// status pill, venue line, member avatars, time pill. Tappable.

export default function FlockCard({ flock, onPress }) {
  const { colors, typography, radius } = useTheme();

  const status = flock?.status || 'voting';
  const isLocked = status === 'confirmed' || status === 'locked';
  const statusBg = isLocked ? colors.accentGreenBg : colors.accentAmberBg;
  const statusFg = isLocked ? colors.accentGreenText : colors.accentAmberText;
  const statusText = isLocked ? 'Locked In' : 'Needs Votes';

  const members = flock?.members || [];
  const visibleMembers = members.slice(0, 4);
  const remaining = Math.max(0, members.length - visibleMembers.length);

  const venueName = flock?.venue || flock?.venue_name || flock?.venue_data?.name;
  const timeLabel = flock?.time || flock?.event_time_label || (flock?.event_time ? formatTime(flock.event_time) : 'TBD');

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={[
        styles.card,
        {
          backgroundColor: colors.bgCardSolid,
          borderRadius: radius.xxl,
          borderColor: colors.borderDefault,
          ...cardShadow(colors),
        },
      ]}
    >
      <View style={styles.headerRow}>
        <View style={{ flex: 1, paddingRight: 8 }}>
          <Text style={[typography.heading4, { color: colors.textPrimary }]} numberOfLines={1}>
            {flock?.name || flock?.title || 'Untitled flock'}
          </Text>
          {!!venueName && (
            <Text style={[typography.bodySmall, { color: colors.textSecondary, marginTop: 2 }]} numberOfLines={1}>
              {venueName}
            </Text>
          )}
        </View>
        <View style={[styles.pill, { backgroundColor: statusBg, borderRadius: radius.lg }]}>
          <Text style={[typography.label, { color: statusFg, letterSpacing: 0 }]}>{statusText}</Text>
        </View>
      </View>

      <View style={styles.footerRow}>
        <View style={{ flexDirection: 'row' }}>
          {visibleMembers.map((m, i) => (
            <View
              key={m.id || i}
              style={[
                styles.avatar,
                {
                  backgroundColor: colors.navyMidBg,
                  borderColor: colors.bgCardSolid,
                  marginLeft: i === 0 ? 0 : -8,
                  zIndex: visibleMembers.length - i,
                },
              ]}
            >
              {m.profile_image_url ? (
                <Image source={{ uri: m.profile_image_url }} style={styles.avatarImg} />
              ) : (
                <Text style={[typography.label, { color: 'white' }]}>{(m.name || '?')[0].toUpperCase()}</Text>
              )}
            </View>
          ))}
          {remaining > 0 && (
            <View style={[styles.avatar, { backgroundColor: colors.iconBg, borderColor: colors.bgCardSolid, marginLeft: -8 }]}>
              <Text style={[typography.label, { color: colors.textPrimary }]}>+{remaining}</Text>
            </View>
          )}
        </View>
        <View style={[styles.timePill, { backgroundColor: colors.iconBg, borderRadius: radius.lg }]}>
          <Text style={[typography.label, { color: colors.textPrimary, letterSpacing: 0 }]}>{timeLabel}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

function formatTime(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  } catch { return 'TBD'; }
}

const styles = StyleSheet.create({
  card: { padding: 14, borderWidth: 1, marginBottom: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 },
  pill: { paddingHorizontal: 8, paddingVertical: 3 },
  footerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  avatar: {
    width: 26, height: 26, borderRadius: 13,
    borderWidth: 2, alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImg: { width: '100%', height: '100%' },
  timePill: { paddingHorizontal: 8, paddingVertical: 3 },
});
