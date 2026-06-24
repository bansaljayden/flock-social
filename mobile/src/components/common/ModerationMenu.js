import React, { useState } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { reportContent, blockUser } from '../../services/api';

// Reusable report/block bottom sheet (Apple 1.2 / Google UGC).
// Drive it from any screen with a `target` object; render once per screen:
//   const [modTarget, setModTarget] = useState(null);
//   <ModerationMenu target={modTarget} onClose={() => setModTarget(null)} onBlocked={refresh} />
// target shape: { userId, name, contentType: 'flock_message'|'dm'|'profile'|'story', contentId }

const REASONS = [
  { key: 'harassment', label: 'Harassment or bullying' },
  { key: 'hate', label: 'Hate speech or symbols' },
  { key: 'sexual', label: 'Nudity or sexual content' },
  { key: 'violence', label: 'Violence or threats' },
  { key: 'self_harm', label: 'Self-harm' },
  { key: 'spam', label: 'Spam or scam' },
  { key: 'other', label: 'Something else' },
];

export default function ModerationMenu({ target, onClose, onBlocked }) {
  const { colors, typography, radius } = useTheme();
  const [mode, setMode] = useState('menu'); // 'menu' | 'reasons'
  const [busy, setBusy] = useState(false);

  const visible = !!target;
  const name = target?.name || 'this user';
  const red = colors.red || colors.accentRedText || '#e5484d';

  const close = () => { setMode('menu'); onClose && onClose(); };

  const submitReport = async (reason) => {
    if (busy) return;
    setBusy(true);
    try {
      await reportContent({
        contentType: target.contentType,
        contentId: target.contentId,
        reportedUserId: target.userId,
        reason,
      });
      close();
      Alert.alert('Report received', 'Thanks — our team will review this promptly.');
    } catch (e) {
      Alert.alert('Could not submit report', e.message);
    } finally {
      setBusy(false);
    }
  };

  const confirmBlock = () => {
    Alert.alert(
      `Block ${name}?`,
      "They won't be able to message you, add you, or see your content — and you won't see theirs.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            try {
              await blockUser(target.userId);
              const blockedId = target.userId;
              close();
              onBlocked && onBlocked(blockedId);
            } catch (e) {
              Alert.alert('Could not block', e.message);
            }
          },
        },
      ],
    );
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <TouchableOpacity activeOpacity={1} style={styles.backdrop} onPress={close}>
        <TouchableOpacity
          activeOpacity={1}
          style={[styles.sheet, { backgroundColor: colors.bgSecondary || colors.bgInput || colors.bgPrimary, borderRadius: radius.xl }]}
        >
          {mode === 'menu' ? (
            <>
              <Text style={[typography.labelBold, { color: colors.textTertiary, textAlign: 'center', marginBottom: 4 }]}>{name}</Text>
              <TouchableOpacity style={styles.row} onPress={() => setMode('reasons')}>
                <Text style={[typography.body, { color: colors.textPrimary }]}>🚩  Report</Text>
              </TouchableOpacity>
              <View style={[styles.divider, { backgroundColor: colors.borderDefault }]} />
              <TouchableOpacity style={styles.row} onPress={confirmBlock}>
                <Text style={[typography.body, { color: red }]}>🚫  Block {name}</Text>
              </TouchableOpacity>
              <View style={[styles.divider, { backgroundColor: colors.borderDefault }]} />
              <TouchableOpacity style={styles.row} onPress={close}>
                <Text style={[typography.body, { color: colors.textSecondary, textAlign: 'center' }]}>Cancel</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={[typography.labelBold, { color: colors.textTertiary, textAlign: 'center', marginBottom: 4 }]}>Why are you reporting this?</Text>
              {REASONS.map((r) => (
                <TouchableOpacity key={r.key} style={styles.row} disabled={busy} onPress={() => submitReport(r.key)}>
                  <Text style={[typography.body, { color: colors.textPrimary }]}>{r.label}</Text>
                </TouchableOpacity>
              ))}
              <View style={[styles.divider, { backgroundColor: colors.borderDefault }]} />
              <TouchableOpacity style={styles.row} onPress={() => setMode('menu')}>
                <Text style={[typography.body, { color: colors.textSecondary, textAlign: 'center' }]}>Back</Text>
              </TouchableOpacity>
            </>
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { padding: 12, paddingBottom: 32, margin: 8 },
  row: { paddingVertical: 14, paddingHorizontal: 12 },
  divider: { height: StyleSheet.hairlineWidth, opacity: 0.5 },
});
