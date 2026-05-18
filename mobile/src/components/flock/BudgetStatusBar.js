import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';

// Tappable status bar shown inside flock detail and chat. Shows the group
// ceiling and submission progress — never any individual amount.
//
// Aggregate fields the backend exposes (per CLAUDE.md):
//   { ceiling, submissionCount, totalMembers, isReady, skipCount, locked }

export default function BudgetStatusBar({ status, onSubmit, onLock, onRemind, isCreator }) {
  const { colors, typography, radius } = useTheme();
  if (!status) return null;

  const ceiling = status.ceiling != null ? `$${status.ceiling}` : '$—';
  const subs = status.submissionCount ?? 0;
  const total = status.totalMembers ?? 0;
  const locked = !!status.locked;
  const ready = !!status.isReady;

  return (
    <View style={[
      styles.bar,
      {
        backgroundColor: colors.bgCardSolid,
        borderColor: locked ? colors.teal : colors.borderDefault,
        borderRadius: radius.xl,
      },
    ]}>
      <Icon name="lock" size={14} color={locked ? colors.teal : colors.textSecondary} />
      <View style={{ flex: 1, marginLeft: 8 }}>
        <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
          Group budget · up to <Text style={{ color: colors.teal, fontFamily: typography.bodyBold.fontFamily }}>{ceiling}</Text> per person
        </Text>
        <Text style={[typography.caption, { color: colors.textTertiary, marginTop: 1 }]}>
          {subs} of {total} submitted{status.skipCount > 0 ? ` · ${status.skipCount} flexible` : ''}{locked ? ' · locked' : ''}
        </Text>
      </View>

      {/* Action button area — meaning depends on user state */}
      {!locked && onSubmit && (
        <TouchableOpacity onPress={onSubmit}>
          <Text style={[typography.bodySmallBold, { color: colors.teal }]}>
            {status.userSubmitted ? 'Change' : 'Submit'}
          </Text>
        </TouchableOpacity>
      )}
      {isCreator && !locked && ready && onLock && (
        <TouchableOpacity onPress={onLock} style={{ marginLeft: 12 }}>
          <Text style={[typography.bodySmallBold, { color: colors.teal }]}>Lock</Text>
        </TouchableOpacity>
      )}
      {isCreator && !locked && !ready && onRemind && (
        <TouchableOpacity onPress={onRemind} style={{ marginLeft: 12 }}>
          <Text style={[typography.bodySmallBold, { color: colors.amber }]}>Remind</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', padding: 12, borderWidth: 1 },
});
