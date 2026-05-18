import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';
import GlassButton from '../../components/common/GlassButton';
import { submitBudget, getBudgetStatus } from '../../services/api';
import { track, Events } from '../../services/posthog';

// Context-adaptive presets — same set the web app uses. The pills change
// based on what kind of flock this is (dinner/drinks/movie/activity).
const PRESETS_BY_CONTEXT = {
  dinner:   [20, 40, 60, 80],
  drinks:   [15, 30, 45, 60],
  movie:    [15, 25, 35, 50],
  activity: [20, 40, 60, 100],
};

// Full-screen prompt that opens when a flock has budget enabled and the
// current user hasn't submitted yet. Hard rule: nothing displayed here ever
// reveals other people's amounts — backend only ever returns aggregate.

export default function BudgetSubmitScreen({ route, navigation }) {
  const { colors, typography, screenPadding, radius } = useTheme();
  const flockId = route?.params?.flockId;
  const flockName = route?.params?.flockName || 'this flock';
  const initialContext = route?.params?.budgetContext || 'dinner';

  const [context, setContext] = useState(initialContext);
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [skipping, setSkipping] = useState(false);

  const presets = PRESETS_BY_CONTEXT[context] || PRESETS_BY_CONTEXT.dinner;

  // Refresh context from server in case the creator changed it after invite
  useEffect(() => {
    if (!flockId) return;
    getBudgetStatus(flockId)
      .then((d) => { if (d?.budget_context) setContext(d.budget_context); })
      .catch(() => {});
  }, [flockId]);

  const submit = async (skipped = false) => {
    if (!flockId) return;
    if (!skipped && !amount) {
      Alert.alert('Pick an amount', 'Tap a preset or type a number.');
      return;
    }
    if (skipped) setSkipping(true); else setSubmitting(true);
    try {
      const numeric = skipped ? null : parseFloat(amount);
      await submitBudget(flockId, { amount: numeric, skipped });
      track(skipped ? Events.BudgetSkipped : Events.BudgetSubmitted, {
        flock_id: flockId,
        // NEVER pass the actual amount to analytics — privacy invariant.
        // Bucket only.
        amount_bucket: skipped ? null
          : numeric < 25 ? 'under_25'
          : numeric < 50 ? '25_50'
          : numeric < 100 ? '50_100'
          : 'over_100',
      });
      navigation.goBack();
    } catch (e) {
      Alert.alert('Could not submit', e.message);
    } finally {
      setSubmitting(false); setSkipping(false);
    }
  };

  const contextCopy = (() => {
    switch (context) {
      case 'drinks':   return "What's your drinks budget tonight?";
      case 'movie':    return "What's your movie budget?";
      case 'activity': return "What's your spend ceiling for this?";
      case 'dinner':
      default:         return "What's your dinner budget tonight?";
    }
  })();

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={['top']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={[styles.headerBar, { paddingHorizontal: screenPadding.default }]}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
            <Icon name="x" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
          <Text style={[typography.label, { color: colors.textTertiary }]}>BUDGET</Text>
          <View style={styles.headerBtn} />
        </View>

        <View style={{ flex: 1, padding: screenPadding.default, justifyContent: 'space-between' }}>
          <View>
            <Text style={[typography.heading1, { color: colors.textPrimary }]}>{contextCopy}</Text>
            <Text style={[typography.body, { color: colors.textSecondary, marginTop: 6 }]}>
              For {flockName}.
            </Text>

            {/* Privacy lock */}
            <View style={[styles.privacyRow, {
              backgroundColor: colors.accentGreenBg, borderRadius: radius.lg, marginTop: 16,
            }]}>
              <Icon name="lock" size={14} color={colors.accentGreenText} />
              <Text style={[typography.bodySmallBold, { color: colors.accentGreenText, marginLeft: 6, flex: 1 }]}>
                Anonymous. No one sees your answer — only the group ceiling.
              </Text>
            </View>

            {/* Presets */}
            <View style={[styles.presetGrid, { marginTop: 24 }]}>
              {presets.map((p) => {
                const selected = amount === String(p);
                return (
                  <TouchableOpacity
                    key={p}
                    onPress={() => setAmount(String(p))}
                    style={[
                      styles.presetCard,
                      {
                        backgroundColor: selected ? colors.teal + '22' : colors.bgCardSolid,
                        borderColor: selected ? colors.teal : colors.borderDefault,
                        borderRadius: radius.xxl,
                      },
                    ]}
                  >
                    <Text style={[typography.heading2, { color: selected ? colors.teal : colors.textPrimary }]}>${p}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Custom amount */}
            <Text style={[typography.label, { color: colors.textTertiary, marginTop: 24, marginBottom: 6, letterSpacing: 0.5 }]}>OR ENTER YOUR OWN</Text>
            <View style={[styles.customRow, { backgroundColor: colors.bgInput, borderColor: colors.borderDefault, borderRadius: radius.xl }]}>
              <Text style={[typography.heading2, { color: colors.textTertiary, marginLeft: 14 }]}>$</Text>
              <TextInput
                value={amount}
                onChangeText={(t) => setAmount(t.replace(/[^0-9.]/g, ''))}
                placeholder="0"
                placeholderTextColor={colors.textTertiary}
                keyboardType="numeric"
                returnKeyType="done"
                style={[styles.customInput, typography.heading2, { color: colors.textPrimary }]}
              />
            </View>
          </View>

          <View style={{ gap: 10, paddingBottom: 16 }}>
            <GlassButton variant="primary" onPress={() => submit(false)} loading={submitting} disabled={!amount}>
              Submit Budget
            </GlassButton>
            <TouchableOpacity onPress={() => submit(true)} disabled={skipping} style={{ alignSelf: 'center' }}>
              <Text style={[typography.body, { color: colors.textSecondary }]}>
                {skipping ? 'Skipping…' : 'Skip — count me as flexible'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, paddingBottom: 8 },
  headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  privacyRow: { flexDirection: 'row', alignItems: 'center', padding: 10 },
  presetGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  presetCard: {
    width: '48%', paddingVertical: 24, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5,
  },
  customRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, paddingRight: 12 },
  customInput: { flex: 1, paddingVertical: 16, paddingHorizontal: 8 },
});
