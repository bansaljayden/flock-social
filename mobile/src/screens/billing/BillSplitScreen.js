import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import GlassButton from '../../components/common/GlassButton';
import { getFlock, createBillSplit, getBillSplit } from '../../services/api';
import { track, Events } from '../../services/posthog';

const TIP_OPTIONS = [
  { key: 0,  label: 'No tip' },
  { key: 15, label: '15%' },
  { key: 18, label: '18%' },
  { key: 20, label: '20%' },
];

// Bill split creation. Three inputs: who paid, total amount, tip %.
// Split type defaults to "equal" — custom shares deferred to a polish pass
// (the web app's custom-share UI is a per-member slider that's its own thing).

export default function BillSplitScreen({ route, navigation }) {
  const { colors, typography, screenPadding, radius } = useTheme();
  const { user } = useAuth();
  const flockId = route?.params?.flockId;

  const [flock, setFlock] = useState(null);
  const [paidById, setPaidById] = useState(user?.id || null);
  const [total, setTotal] = useState('');
  const [tipPercent, setTipPercent] = useState(20);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!flockId) return;
    getFlock(flockId).then((d) => setFlock(d?.flock || d)).catch(() => {});
    // If a bill already exists, jump straight to settle screen instead
    getBillSplit(flockId).then((existing) => {
      if (existing?.bill?.id) navigation.replace('SettleUp', { flockId });
    }).catch(() => {});
  }, [flockId]);

  const totalNum = parseFloat(total) || 0;
  const tipAmount = useMemo(() => Math.round(totalNum * (tipPercent / 100) * 100) / 100, [totalNum, tipPercent]);
  const grand = useMemo(() => Math.round((totalNum + tipAmount) * 100) / 100, [totalNum, tipAmount]);
  const memberCount = (flock?.members || []).filter((m) => m.status === 'accepted').length || 1;
  const perPerson = useMemo(() => Math.round((grand / memberCount) * 100) / 100, [grand, memberCount]);

  const handleCreate = async () => {
    if (!totalNum || totalNum <= 0) {
      Alert.alert('Enter a total', 'How much was the bill?');
      return;
    }
    if (!paidById) {
      Alert.alert('Pick who paid', 'Tap a member to mark them as the payer.');
      return;
    }
    setSubmitting(true);
    try {
      await createBillSplit(flockId, {
        totalAmount: totalNum,
        tipPercent,
        splitType: 'equal',
        paidBy: paidById,
      });
      track(Events.BillSplitCreated, {
        flock_id: flockId,
        member_count: memberCount,
        tip_percent: tipPercent,
        // Bucketed total instead of raw — same privacy posture as budget
        total_bucket: totalNum < 50 ? 'under_50'
          : totalNum < 150 ? '50_150'
          : totalNum < 400 ? '150_400'
          : 'over_400',
      });
      navigation.replace('SettleUp', { flockId });
    } catch (e) {
      Alert.alert('Could not create split', e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={['top']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={[styles.headerBar, { paddingHorizontal: screenPadding.default }]}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
            <Icon name="x" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
          <Text style={[typography.heading3, { color: colors.textPrimary }]}>Split the Bill</Text>
          <View style={styles.headerBtn} />
        </View>

        <ScrollView contentContainerStyle={{ padding: screenPadding.default, paddingBottom: 32 }} keyboardShouldPersistTaps="handled">

          {/* Total */}
          <Text style={[typography.label, { color: colors.textTertiary, letterSpacing: 0.5 }]}>WHAT WAS THE TOTAL?</Text>
          <View style={[styles.totalRow, { backgroundColor: colors.bgInput, borderColor: colors.borderDefault, borderRadius: radius.xl, marginTop: 6 }]}>
            <Text style={[typography.heading1, { color: colors.textTertiary, marginLeft: 14 }]}>$</Text>
            <TextInput
              value={total}
              onChangeText={(t) => setTotal(t.replace(/[^0-9.]/g, ''))}
              placeholder="0.00"
              placeholderTextColor={colors.textTertiary}
              keyboardType="numeric"
              autoFocus
              style={[styles.totalInput, typography.heading1, { color: colors.textPrimary }]}
            />
          </View>

          {/* Tip */}
          <Text style={[typography.label, { color: colors.textTertiary, letterSpacing: 0.5, marginTop: 24 }]}>ADD TIP</Text>
          <View style={[styles.tipRow, { marginTop: 6 }]}>
            {TIP_OPTIONS.map((t) => {
              const selected = tipPercent === t.key;
              return (
                <TouchableOpacity
                  key={t.key}
                  onPress={() => setTipPercent(t.key)}
                  style={[
                    styles.tipPill,
                    {
                      borderRadius: radius.pill,
                      backgroundColor: selected ? colors.teal + '22' : colors.bgCardSolid,
                      borderColor: selected ? colors.teal : colors.borderDefault,
                    },
                  ]}
                >
                  <Text style={[typography.bodySmallBold, { color: selected ? colors.teal : colors.textPrimary }]}>{t.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Who paid */}
          <Text style={[typography.label, { color: colors.textTertiary, letterSpacing: 0.5, marginTop: 24 }]}>WHO PAID?</Text>
          <View style={{ marginTop: 6, gap: 6 }}>
            {(flock?.members || []).filter((m) => m.status === 'accepted').map((m) => {
              const selected = paidById === m.id;
              return (
                <TouchableOpacity
                  key={m.id}
                  onPress={() => setPaidById(m.id)}
                  style={[
                    styles.payerRow,
                    {
                      backgroundColor: selected ? colors.teal + '15' : colors.bgCardSolid,
                      borderColor: selected ? colors.teal : colors.borderDefault,
                      borderRadius: radius.xl,
                    },
                  ]}
                >
                  <View style={[styles.avatar, { backgroundColor: colors.navyMidBg }]}>
                    {m.profile_image_url ? (
                      <Image source={{ uri: m.profile_image_url }} style={{ width: 32, height: 32 }} />
                    ) : (
                      <Text style={[typography.bodyBold, { color: 'white' }]}>{(m.name || '?')[0].toUpperCase()}</Text>
                    )}
                  </View>
                  <Text style={[typography.body, { color: colors.textPrimary, flex: 1 }]}>
                    {m.name}{m.id === user?.id ? ' (you)' : ''}
                  </Text>
                  {selected && <Icon name="check" size={18} color={colors.teal} />}
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Summary */}
          <View style={[styles.summary, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xxl, marginTop: 24 }]}>
            <SummaryLine label="Subtotal" value={`$${totalNum.toFixed(2)}`} />
            <SummaryLine label={`Tip (${tipPercent}%)`} value={`$${tipAmount.toFixed(2)}`} />
            <View style={[styles.divider, { backgroundColor: colors.borderSubtle }]} />
            <SummaryLine label="Total" value={`$${grand.toFixed(2)}`} bold />
            <SummaryLine label={`${memberCount} people`} value={`$${perPerson.toFixed(2)} each`} muted />
          </View>

          <View style={{ marginTop: 24 }}>
            <GlassButton variant="primary" onPress={handleCreate} loading={submitting} disabled={!totalNum || !paidById}>
              Create Split
            </GlassButton>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function SummaryLine({ label, value, bold, muted }) {
  const { colors, typography } = useTheme();
  return (
    <View style={styles.summaryLine}>
      <Text style={[bold ? typography.heading4 : typography.body, { color: muted ? colors.textTertiary : colors.textSecondary }]}>
        {label}
      </Text>
      <Text style={[bold ? typography.heading4 : typography.bodyBold, { color: muted ? colors.textTertiary : colors.textPrimary }]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, paddingBottom: 8 },
  headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  totalRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1 },
  totalInput: { flex: 1, paddingVertical: 18, paddingHorizontal: 8 },
  tipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tipPill: { paddingVertical: 10, paddingHorizontal: 14, borderWidth: 1.5 },
  payerRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 10, borderWidth: 1.5,
  },
  avatar: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  summary: { padding: 14, borderWidth: 1 },
  summaryLine: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 6 },
});
