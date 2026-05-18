import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';
import GlassButton from '../../components/common/GlassButton';
import { createFlock } from '../../services/api';
import { track, Events } from '../../services/posthog';
import { success as hapticSuccess } from '../../utils/haptics';

const BUDGET_CONTEXTS = [
  { key: 'dinner', label: 'Dinner' },
  { key: 'drinks', label: 'Drinks' },
  { key: 'movie', label: 'Movie' },
  { key: 'activity', label: 'Activity' },
];

// Phase 2 minimum: name + optional description + budget toggle.
// Venue search lands in Phase 3 alongside DiscoverScreen — until then,
// users create flocks first and pick a venue from inside the flock detail.

export default function CreateFlockScreen({ navigation }) {
  const { colors, typography, screenPadding, radius } = useTheme();

  const [name, setName] = useState('');
  const [budgetEnabled, setBudgetEnabled] = useState(false);
  const [budgetContext, setBudgetContext] = useState('dinner');
  const [ghostMode, setGhostMode] = useState(true);
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) {
      Alert.alert('Name required', 'Give your flock a name so your friends know what it is.');
      return;
    }
    setSaving(true);
    try {
      const data = await createFlock({
        name: name.trim(),
        budget_enabled: budgetEnabled || undefined,
        budget_context: budgetEnabled ? budgetContext : undefined,
        ghost_mode_enabled: budgetEnabled ? ghostMode : undefined,
      });
      const flockId = data?.flock?.id || data?.id;
      track(Events.FlockCreated, {
        flock_id: flockId,
        budget_enabled: budgetEnabled,
        budget_context: budgetEnabled ? budgetContext : null,
      });
      hapticSuccess();
      if (flockId) {
        navigation.replace('FlockDetail', { flockId });
      } else {
        navigation.goBack();
      }
    } catch (e) {
      Alert.alert('Could not create flock', e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={['top']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={[styles.headerBar, { paddingHorizontal: screenPadding.default }]}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
            <Icon name="x" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
          <Text style={[typography.heading3, { color: colors.textPrimary }]}>New Flock</Text>
          <View style={styles.headerBtn} />
        </View>

        <ScrollView contentContainerStyle={{ padding: screenPadding.default, paddingBottom: 80 }}>
          <Text style={[typography.labelBold, { color: colors.textTertiary, marginBottom: 6 }]}>Name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Sunday night out"
            placeholderTextColor={colors.textTertiary}
            autoFocus
            returnKeyType="done"
            style={[
              styles.input,
              typography.heading4,
              { backgroundColor: colors.bgInput, borderColor: colors.borderDefault, color: colors.textPrimary, borderRadius: radius.xl },
            ]}
          />

          {/* Budget matching */}
          <View style={[styles.section, { marginTop: 24 }]}>
            <View style={styles.toggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={[typography.heading4, { color: colors.textPrimary }]}>Anonymous budgets</Text>
                <Text style={[typography.bodySmall, { color: colors.textSecondary, marginTop: 2 }]}>
                  Everyone shares a budget privately. Group sees only the ceiling.
                </Text>
              </View>
              <Switch value={budgetEnabled} onValueChange={setBudgetEnabled} />
            </View>

            {budgetEnabled && (
              <>
                <Text style={[typography.label, { color: colors.textTertiary, marginTop: 16, marginBottom: 6, letterSpacing: 0.4 }]}>WHAT'S THE PLAN?</Text>
                <View style={styles.pillRow}>
                  {BUDGET_CONTEXTS.map((c) => {
                    const selected = budgetContext === c.key;
                    return (
                      <TouchableOpacity
                        key={c.key}
                        onPress={() => setBudgetContext(c.key)}
                        style={[
                          styles.pill,
                          {
                            borderRadius: radius.pill,
                            backgroundColor: selected ? colors.teal + '22' : colors.bgCardSolid,
                            borderColor: selected ? colors.teal : colors.borderDefault,
                          },
                        ]}
                      >
                        <Text style={[typography.bodySmallBold, { color: selected ? colors.teal : colors.textPrimary }]}>{c.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <View style={[styles.toggleRow, { marginTop: 16 }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[typography.bodyBold, { color: colors.textPrimary }]}>Ghost Mode</Text>
                    <Text style={[typography.bodySmall, { color: colors.textSecondary, marginTop: 2 }]}>
                      Pre-commit your share before the venue confirms.
                    </Text>
                  </View>
                  <Switch value={ghostMode} onValueChange={setGhostMode} />
                </View>
              </>
            )}
          </View>

          <View style={{ marginTop: 32 }}>
            <GlassButton variant="primary" onPress={handleCreate} loading={saving} disabled={!name.trim()}>
              Create Flock
            </GlassButton>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// Tiny inline switch to avoid pulling another lib. Color follows theme.
function Switch({ value, onValueChange }) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity
      onPress={() => onValueChange(!value)}
      activeOpacity={0.7}
      style={[
        switchStyles.track,
        { backgroundColor: value ? colors.teal : colors.toggleOff },
      ]}
    >
      <View
        style={[
          switchStyles.knob,
          {
            backgroundColor: colors.toggleKnob,
            transform: [{ translateX: value ? 18 : 0 }],
          },
        ]}
      />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, paddingBottom: 8 },
  headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  input: { paddingVertical: 14, paddingHorizontal: 14, borderWidth: 1 },
  section: {},
  toggleRow: { flexDirection: 'row', alignItems: 'center' },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { paddingVertical: 8, paddingHorizontal: 14, borderWidth: 1.5 },
});

const switchStyles = StyleSheet.create({
  track: { width: 44, height: 26, borderRadius: 13, padding: 3, justifyContent: 'center' },
  knob: { width: 20, height: 20, borderRadius: 10 },
});
