import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import GlassButton from '../../components/common/GlassButton';
import {
  getFlock,
  acceptFlockInvite,
  declineFlockInvite,
  leaveFlock,
  getBudgetStatus,
  getBillSplit,
  lockBudget,
  sendBudgetReminder,
} from '../../services/api';
import { cardShadow } from '../../theme/shadows';
import BudgetStatusBar from '../../components/flock/BudgetStatusBar';
import GhostModeCard from '../../components/flock/GhostModeCard';

// Read-only-ish flock detail view. Full creator controls (lock budget,
// venue picker, member invite modal, etc.) ship in subsequent passes.

export default function FlockDetailScreen({ route, navigation }) {
  const { colors, typography, screenPadding, radius } = useTheme();
  const { user } = useAuth();
  const flockId = route?.params?.flockId;

  const [flock, setFlock] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [budget, setBudget] = useState(null);
  const [bill, setBill] = useState(null);

  const load = useCallback(async () => {
    if (!flockId) return;
    try {
      const [flockData, budgetData, billData] = await Promise.all([
        getFlock(flockId).catch(() => null),
        getBudgetStatus(flockId).catch(() => null),
        getBillSplit(flockId).catch(() => null),
      ]);
      setFlock(flockData?.flock || flockData);
      setBudget(budgetData);
      setBill(billData?.bill || billData);
    } catch (e) {
      console.warn('Flock load failed:', e.message);
    }
  }, [flockId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (!flock) {
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={['top']}>
        <View style={styles.center}>
          <Text style={[typography.body, { color: colors.textSecondary }]}>Loading…</Text>
        </View>
      </SafeAreaView>
    );
  }

  const myMembership = (flock.members || []).find((m) => m.id === user?.id);
  const myStatus = myMembership?.status || flock.memberStatus;
  const isCreator = flock.creator_id === user?.id || flock.creatorId === user?.id;
  const venueName = flock.venue || flock.venue_name || flock.venue_data?.name;
  const venueAddr = flock.venue_address || flock.venue_data?.addr;

  const handleAccept = async () => {
    setBusy(true);
    try { await acceptFlockInvite(flockId); await load(); }
    catch (e) { Alert.alert('Could not accept', e.message); }
    finally { setBusy(false); }
  };

  const handleDecline = async () => {
    setBusy(true);
    try { await declineFlockInvite(flockId); navigation.goBack(); }
    catch (e) { Alert.alert('Could not decline', e.message); setBusy(false); }
  };

  const handleLeave = async () => {
    Alert.alert('Leave flock?', `You'll stop getting messages from "${flock.name}".`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave', style: 'destructive', onPress: async () => {
          setBusy(true);
          try { await leaveFlock(flockId); navigation.goBack(); }
          catch (e) { Alert.alert('Could not leave', e.message); setBusy(false); }
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={['top']}>
      <View style={[styles.headerBar, { paddingHorizontal: screenPadding.default }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
          <Icon name="chevron-left" size={26} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={[typography.label, { color: colors.textTertiary }]}>FLOCK</Text>
        <TouchableOpacity onPress={handleLeave} style={styles.headerBtn} disabled={busy}>
          <Icon name="more-horizontal" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: screenPadding.default, paddingBottom: 96 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.teal} />}
      >
        {/* Hero block */}
        <View style={[styles.hero, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xxl, ...cardShadow(colors) }]}>
          <Text style={[typography.heading1, { color: colors.textPrimary }]}>{flock.name}</Text>
          {!!venueName && (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 6 }}>
              <Icon name="map-pin" size={14} color={colors.textSecondary} />
              <Text style={[typography.body, { color: colors.textSecondary }]} numberOfLines={2}>
                {venueName}{venueAddr ? ` · ${venueAddr}` : ''}
              </Text>
            </View>
          )}
          {flock.event_time && (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6, gap: 6 }}>
              <Icon name="clock" size={14} color={colors.textSecondary} />
              <Text style={[typography.body, { color: colors.textSecondary }]}>
                {new Date(flock.event_time).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
              </Text>
            </View>
          )}
        </View>

        {/* Pending invite — shown only when myStatus is 'invited' */}
        {myStatus === 'invited' && (
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
            <View style={{ flex: 1 }}>
              <GlassButton variant="primary" onPress={handleAccept} loading={busy}>Accept</GlassButton>
            </View>
            <View style={{ flex: 1 }}>
              <GlassButton variant="secondary" onPress={handleDecline} disabled={busy}>Decline</GlassButton>
            </View>
          </View>
        )}

        {/* Open Chat CTA — only shown to accepted members */}
        {myStatus === 'accepted' && (
          <View style={{ marginTop: 16 }}>
            <GlassButton
              variant="primary"
              icon={<Icon name="message-circle" size={16} color="white" />}
              onPress={() => navigation.navigate('FlockChat', { flockId, flockName: flock.name })}
            >
              Open Chat
            </GlassButton>
          </View>
        )}

        {/* Budget status bar — visible whenever budget is enabled */}
        {flock.budget_enabled && budget && (
          <View style={{ marginTop: 16 }}>
            <BudgetStatusBar
              status={budget}
              isCreator={isCreator}
              onSubmit={() => navigation.navigate('BudgetSubmit', { flockId, flockName: flock.name, budgetContext: flock.budget_context })}
              onLock={async () => {
                try { await lockBudget(flockId); await load(); }
                catch (e) { Alert.alert('Could not lock', e.message); }
              }}
              onRemind={async () => {
                try { await sendBudgetReminder(flockId); Alert.alert('Reminder sent'); }
                catch (e) { Alert.alert('Could not send', e.message); }
              }}
            />
          </View>
        )}

        {/* Ghost Mode pre-commit — visible after venue confirmed + budget locked */}
        {flock.budget_enabled && flock.ghost_mode_enabled && budget?.locked && flock.venue_confirmed && (
          <View style={{ marginTop: 12 }}>
            <GhostModeCard
              flockId={flockId}
              status={budget?.ghost || { committed: false, commitAmount: budget?.ceiling || 0, committedMemberIds: [] }}
              members={flock.members || []}
              onCommitted={load}
            />
          </View>
        )}

        {/* Bill split entry — after the night, anyone can create one if not yet created */}
        {myStatus === 'accepted' && (
          <View style={{ marginTop: 16 }}>
            {bill?.id ? (
              <GlassButton
                variant="secondary"
                icon={<Icon name="dollar-sign" size={16} color={colors.textPrimary} />}
                onPress={() => navigation.navigate('SettleUp', { flockId })}
              >
                {bill.fully_settled ? 'View Bill (Settled)' : 'Settle Up'}
              </GlassButton>
            ) : (
              <GlassButton
                variant="secondary"
                icon={<Icon name="dollar-sign" size={16} color={colors.textPrimary} />}
                onPress={() => navigation.navigate('BillSplit', { flockId })}
              >
                Split the Bill
              </GlassButton>
            )}
          </View>
        )}

        {/* Members */}
        <Text style={[typography.heading4, { color: colors.textPrimary, marginTop: 24, marginBottom: 8 }]}>
          Members · {(flock.members || []).length}
        </Text>
        {(flock.members || []).map((m) => (
          <View key={m.id} style={[styles.memberRow, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xl }]}>
            <View style={[styles.avatar, { backgroundColor: colors.navyMidBg }]}>
              <Text style={[typography.bodyBold, { color: 'white' }]}>{(m.name || '?')[0].toUpperCase()}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[typography.bodyBold, { color: colors.textPrimary }]}>
                {m.name || 'Member'}{m.id === user?.id ? ' (you)' : ''}
              </Text>
              <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>
                {m.status === 'accepted' ? 'In' : m.status === 'invited' ? 'Invited' : m.status === 'declined' ? 'Declined' : m.status}
              </Text>
            </View>
            {flock.creator_id === m.id && (
              <View style={[styles.creatorBadge, { backgroundColor: colors.accentBlueBg, borderRadius: radius.lg }]}>
                <Text style={[typography.label, { color: colors.accentBlueText, letterSpacing: 0 }]}>HOST</Text>
              </View>
            )}
          </View>
        ))}

        {/* Footer note for creator */}
        {isCreator && (
          <Text style={[typography.bodySmall, { color: colors.textTertiary, marginTop: 16, textAlign: 'center' }]}>
            You created this flock. Lock budget + venue voting tools land in the next pass.
          </Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  headerBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, paddingBottom: 8 },
  headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  hero: { padding: 18, borderWidth: 1 },
  memberRow: { flexDirection: 'row', alignItems: 'center', padding: 12, borderWidth: 1, marginBottom: 8, gap: 12 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  creatorBadge: { paddingHorizontal: 8, paddingVertical: 3 },
});
