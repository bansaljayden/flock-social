import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import GlassButton from '../../components/common/GlassButton';
import { ghostCommit } from '../../services/api';

// "Lock in your share?" pre-commitment card. Visible only after the venue
// is confirmed and budget is locked. Once committed, the card switches to
// the locked-in state and shows who else has committed.

export default function GhostModeCard({ flockId, status, members = [], onCommitted }) {
  const { colors, typography, radius } = useTheme();
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);

  // status shape:
  //   { committed: bool, commitAmount: number, committedMemberIds: number[] }
  if (!status) return null;
  const myCommitted = !!status.committed;
  const committedIds = status.committedMemberIds || [];

  const commit = async () => {
    Alert.alert(
      'Lock in your share?',
      `You're pre-committing $${status.commitAmount} to this plan. You'll owe it whether you show up or not.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Commit',
          onPress: async () => {
            setBusy(true);
            try { await ghostCommit(flockId); onCommitted?.(); }
            catch (e) { Alert.alert("Couldn't commit", e.message); }
            finally { setBusy(false); }
          },
        },
      ]
    );
  };

  return (
    <View style={[
      styles.card,
      { backgroundColor: colors.bgCardSolid, borderColor: myCommitted ? colors.teal : colors.borderDefault, borderRadius: radius.xxl },
    ]}>
      <View style={styles.headerRow}>
        <View style={[styles.iconBox, { backgroundColor: myCommitted ? colors.accentGreenBg : colors.iconBg, borderRadius: radius.lg }]}>
          <Icon name={myCommitted ? 'check-circle' : 'lock'} size={18} color={myCommitted ? colors.accentGreenText : colors.textPrimary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[typography.heading4, { color: colors.textPrimary }]}>
            {myCommitted ? "You're locked in" : 'Lock in your share?'}
          </Text>
          <Text style={[typography.bodySmall, { color: colors.textSecondary, marginTop: 2 }]}>
            {myCommitted
              ? `Your $${status.commitAmount} is committed to this plan.`
              : `Pre-commit $${status.commitAmount} so the group knows you're real.`}
          </Text>
        </View>
      </View>

      {/* Committed-member list — small avatars showing momentum */}
      {committedIds.length > 0 && (
        <View style={[styles.committedRow, { marginTop: 10 }]}>
          <Text style={[typography.caption, { color: colors.textTertiary, marginRight: 8 }]}>
            {committedIds.length} of {members.length || '?'} locked in:
          </Text>
          <View style={{ flexDirection: 'row' }}>
            {(members.filter((m) => committedIds.includes(m.id))).slice(0, 5).map((m, i) => (
              <View
                key={m.id}
                style={[
                  styles.tinyAvatar,
                  {
                    backgroundColor: colors.navyMidBg,
                    borderColor: colors.bgCardSolid,
                    marginLeft: i === 0 ? 0 : -6,
                  },
                ]}
              >
                <Text style={[typography.caption, { color: 'white', fontSize: 8 }]}>{(m.name || '?')[0].toUpperCase()}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {!myCommitted && (
        <View style={{ marginTop: 12 }}>
          <GlassButton variant="primary" onPress={commit} loading={busy}>
            Commit ${status.commitAmount}
          </GlassButton>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, borderWidth: 1.5 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  iconBox: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  committedRow: { flexDirection: 'row', alignItems: 'center' },
  tinyAvatar: { width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5 },
});
