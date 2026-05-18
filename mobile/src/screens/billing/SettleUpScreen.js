import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Linking,
  Alert,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import GlassButton from '../../components/common/GlassButton';
import {
  getBillSplit,
  getPaymentLinks,
  settleShare,
} from '../../services/api';
import { track, Events } from '../../services/posthog';
import { success as hapticSuccess } from '../../utils/haptics';

// SettleUp shows the user their share + the most natural way to pay it back.
// Backend returns deep links for whichever payment methods the payer has set
// up (Venmo / CashApp / Zelle). On iOS the venmo:// URL opens the Venmo app
// directly; if not installed, the universal-link fallback opens venmo.com
// in Safari (handled by Linking.openURL — iOS does the right thing).

export default function SettleUpScreen({ route, navigation }) {
  const { colors, typography, screenPadding, radius } = useTheme();
  const { user } = useAuth();
  const flockId = route?.params?.flockId;

  const [bill, setBill] = useState(null);
  const [links, setLinks] = useState(null);
  const [settling, setSettling] = useState(false);

  const load = async () => {
    if (!flockId) return;
    try {
      const [b, l] = await Promise.all([
        getBillSplit(flockId).catch(() => null),
        getPaymentLinks(flockId).catch(() => null),
      ]);
      setBill(b?.bill || b || null);
      setLinks(l || null);
    } catch (e) {
      console.warn('Settle load failed:', e.message);
    }
  };

  useEffect(() => { load(); }, [flockId]);

  if (!bill) {
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]}>
        <View style={styles.center}>
          <Text style={[typography.body, { color: colors.textSecondary }]}>Loading…</Text>
        </View>
      </SafeAreaView>
    );
  }

  const myShare = (bill.participants || []).find((p) => p.user_id === user?.id);
  const myAmount = myShare?.amount_owed ?? bill.per_person ?? 0;
  const isPayer = bill.paid_by === user?.id;
  const settled = !!myShare?.settled_at || isPayer;
  const payerName = bill.paid_by_name || 'the payer';

  const openLink = async (url) => {
    if (!url) return;
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) {
        await Linking.openURL(url);
      } else {
        Alert.alert("Can't open that app", 'It might not be installed. The web fallback should still work.');
      }
    } catch (e) {
      Alert.alert("Couldn't open payment app", e.message);
    }
  };

  const markSettled = async () => {
    setSettling(true);
    try {
      await settleShare(flockId);
      track(Events.BillSettled, { flock_id: flockId, method: 'manual' });
      hapticSuccess();
      await load();
    } catch (e) {
      Alert.alert('Could not mark settled', e.message);
    } finally {
      setSettling(false);
    }
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={['top']}>
      <View style={[styles.headerBar, { paddingHorizontal: screenPadding.default }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
          <Icon name="chevron-left" size={26} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={[typography.heading3, { color: colors.textPrimary }]}>Settle Up</Text>
        <View style={styles.headerBtn} />
      </View>

      <ScrollView contentContainerStyle={{ padding: screenPadding.default, paddingBottom: 32 }}>

        {isPayer ? (
          <View style={[styles.heroCard, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xxl }]}>
            <Text style={[typography.label, { color: colors.textTertiary, letterSpacing: 0.5 }]}>YOU PAID</Text>
            <Text style={[typography.heading1, { color: colors.textPrimary, marginTop: 6 }]}>${(bill.total_amount || 0).toFixed(2)}</Text>
            <Text style={[typography.bodySmall, { color: colors.textSecondary, marginTop: 4 }]}>
              The group owes you. They'll see your payment links here.
            </Text>
          </View>
        ) : (
          <View style={[styles.heroCard, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xxl }]}>
            <Text style={[typography.label, { color: colors.textTertiary, letterSpacing: 0.5 }]}>YOU OWE</Text>
            <Text style={[typography.heading1, { color: colors.textPrimary, marginTop: 6 }]}>${Number(myAmount).toFixed(2)}</Text>
            <Text style={[typography.bodySmall, { color: colors.textSecondary, marginTop: 4 }]}>
              to <Text style={{ color: colors.textPrimary, fontFamily: typography.bodyBold.fontFamily }}>{payerName}</Text>
            </Text>
          </View>
        )}

        {/* Status pill */}
        {settled && (
          <View style={[styles.settledPill, { backgroundColor: colors.accentGreenBg, borderRadius: radius.lg, marginTop: 16 }]}>
            <Icon name="check-circle" size={14} color={colors.accentGreenText} />
            <Text style={[typography.bodySmallBold, { color: colors.accentGreenText, marginLeft: 6 }]}>Settled</Text>
          </View>
        )}

        {/* Payment options — only shown to non-payer + not yet settled */}
        {!isPayer && !settled && (
          <>
            <Text style={[typography.label, { color: colors.textTertiary, letterSpacing: 0.5, marginTop: 24 }]}>HOW TO PAY</Text>
            <View style={{ gap: 10, marginTop: 8 }}>
              {!!links?.venmo && (
                <PaymentRow
                  brand="Venmo"
                  bgColor="#3D95CE"
                  iconChar="V"
                  subtitle={links.venmo_username ? `@${links.venmo_username}` : 'Open in Venmo'}
                  onPress={() => openLink(links.venmo)}
                />
              )}
              {!!links?.cashapp && (
                <PaymentRow
                  brand="Cash App"
                  bgColor="#00D632"
                  iconChar="$"
                  subtitle={links.cashapp_cashtag ? `$${links.cashapp_cashtag}` : 'Open in Cash App'}
                  onPress={() => openLink(links.cashapp)}
                />
              )}
              {!!links?.zelle && (
                <PaymentRow
                  brand="Zelle"
                  bgColor="#6D1ED4"
                  iconChar="Z"
                  subtitle={links.zelle_identifier || 'Send via Zelle'}
                  onPress={() => openLink(links.zelle)}
                />
              )}
              {!links?.venmo && !links?.cashapp && !links?.zelle && (
                <View style={[styles.noLinksCard, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xxl }]}>
                  <Text style={[typography.body, { color: colors.textSecondary, textAlign: 'center' }]}>
                    {payerName} hasn't added payment methods yet. Settle in person and tap "Mark as Settled" below.
                  </Text>
                </View>
              )}
            </View>

            <View style={{ marginTop: 24 }}>
              <GlassButton variant="secondary" onPress={markSettled} loading={settling} icon={<Icon name="check" size={16} color={colors.textPrimary} />}>
                Mark as Settled
              </GlassButton>
            </View>
          </>
        )}

        {/* Participants list — payer sees who's settled */}
        {isPayer && (bill.participants || []).length > 0 && (
          <>
            <Text style={[typography.label, { color: colors.textTertiary, letterSpacing: 0.5, marginTop: 24 }]}>SHARES</Text>
            <View style={{ marginTop: 8, gap: 6 }}>
              {bill.participants.map((p) => (
                <View
                  key={p.user_id}
                  style={[
                    styles.participantRow,
                    { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xl },
                  ]}
                >
                  <View style={[styles.smallAvatar, { backgroundColor: colors.navyMidBg }]}>
                    <Text style={[typography.label, { color: 'white' }]}>{(p.name || '?')[0].toUpperCase()}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[typography.body, { color: colors.textPrimary }]}>{p.name}</Text>
                    <Text style={[typography.caption, { color: colors.textTertiary }]}>
                      ${Number(p.amount_owed).toFixed(2)}
                    </Text>
                  </View>
                  {p.settled_at ? (
                    <View style={[styles.settledTinyPill, { backgroundColor: colors.accentGreenBg, borderRadius: radius.lg }]}>
                      <Text style={[typography.caption, { color: colors.accentGreenText, fontFamily: typography.bodySmallBold.fontFamily }]}>SETTLED</Text>
                    </View>
                  ) : (
                    <Text style={[typography.caption, { color: colors.textTertiary }]}>pending</Text>
                  )}
                </View>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function PaymentRow({ brand, bgColor, iconChar, subtitle, onPress }) {
  const { colors, typography, radius } = useTheme();
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[
        styles.payRow,
        { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xxl },
      ]}
    >
      <View style={[styles.brandBadge, { backgroundColor: bgColor }]}>
        <Text style={[typography.heading3, { color: 'white' }]}>{iconChar}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[typography.bodyBold, { color: colors.textPrimary }]}>Pay with {brand}</Text>
        <Text style={[typography.bodySmall, { color: colors.textSecondary }]} numberOfLines={1}>{subtitle}</Text>
      </View>
      <Icon name="external-link" size={18} color={colors.textTertiary} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  headerBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, paddingBottom: 8 },
  headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  heroCard: { padding: 18, borderWidth: 1 },
  settledPill: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4 },
  payRow: { flexDirection: 'row', alignItems: 'center', padding: 12, borderWidth: 1, gap: 12 },
  brandBadge: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  noLinksCard: { padding: 16, borderWidth: 1 },
  participantRow: { flexDirection: 'row', alignItems: 'center', padding: 10, borderWidth: 1, gap: 10 },
  smallAvatar: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  settledTinyPill: { paddingHorizontal: 6, paddingVertical: 2 },
});
