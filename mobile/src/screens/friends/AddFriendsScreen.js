import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';
import {
  acceptFriendRequest,
  addFriendByCode,
  declineFriendRequest,
  getFriendSuggestions,
  getFriends,
  getMyFriendCode,
  getOutgoingRequests,
  getPendingRequests,
  removeFriend,
  searchUsers,
  sendFriendRequest,
} from '../../services/api';
import { success as hapticSuccess } from '../../utils/haptics';
import { getFriendshipStatus, getInitial, normalizeFriendCode } from './friendUtils';

const TABS = [
  { key: 'search', label: 'Search', icon: 'search' },
  { key: 'quick', label: 'Quick Add', icon: 'users' },
  { key: 'code', label: 'Code', icon: 'hash' },
];

export default function AddFriendsScreen({ navigation }) {
  const { colors, typography, screenPadding, radius } = useTheme();
  const [activeTab, setActiveTab] = useState('search');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [friends, setFriends] = useState([]);
  const [pending, setPending] = useState([]);
  const [outgoing, setOutgoing] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [friendCode, setFriendCode] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyIds, setBusyIds] = useState({});
  const [codeBusy, setCodeBusy] = useState(false);
  const searchSequence = useRef(0);

  const loadData = useCallback(async () => {
    const settled = await Promise.allSettled([
      getFriends(),
      getPendingRequests(),
      getOutgoingRequests(),
      getFriendSuggestions(),
      getMyFriendCode(),
    ]);
    const value = (index) => settled[index].status === 'fulfilled' ? settled[index].value : null;
    setFriends(value(0)?.friends || []);
    setPending(value(1)?.requests || []);
    setOutgoing(value(2)?.requests || []);
    setSuggestions(value(3)?.suggestions || []);
    setFriendCode(value(4)?.code || '');
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { loadData(); }, [loadData]));

  useEffect(() => {
    const trimmed = query.trim();
    const sequence = ++searchSequence.current;
    setSearchError('');
    if (!trimmed) {
      setResults([]);
      setSearching(false);
      return undefined;
    }

    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const data = await searchUsers(trimmed);
        if (sequence === searchSequence.current) setResults(data?.users || []);
      } catch (error) {
        if (sequence === searchSequence.current) {
          setResults([]);
          setSearchError(error.message || 'Search is unavailable right now.');
        }
      } finally {
        if (sequence === searchSequence.current) setSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  const friendIds = useMemo(() => new Set(friends.map((item) => Number(item.id))), [friends]);
  const outgoingIds = useMemo(() => new Set(outgoing.map((item) => Number(item.id))), [outgoing]);
  const setBusy = (id, value) => setBusyIds((current) => ({ ...current, [id]: value }));

  const handleSend = async (user) => {
    if (busyIds[user.id]) return;
    setBusy(user.id, true);
    try {
      const response = await sendFriendRequest(user.id);
      hapticSuccess();
      if (response?.status === 'accepted') {
        setFriends((current) => [...current.filter((item) => item.id !== user.id), user]);
        setOutgoing((current) => current.filter((item) => item.id !== user.id));
      } else {
        setOutgoing((current) => [...current.filter((item) => item.id !== user.id), user]);
      }
    } catch (error) {
      Alert.alert('Could not add friend', error.message);
    } finally {
      setBusy(user.id, false);
    }
  };

  const handleAccept = async (user) => {
    setBusy(user.id, true);
    try {
      await acceptFriendRequest(user.id);
      hapticSuccess();
      setPending((current) => current.filter((item) => item.id !== user.id));
      setFriends((current) => [...current.filter((item) => item.id !== user.id), user]);
    } catch (error) {
      Alert.alert('Could not accept request', error.message);
    } finally {
      setBusy(user.id, false);
    }
  };

  const handleDecline = async (user) => {
    setBusy(user.id, true);
    try {
      await declineFriendRequest(user.id);
      setPending((current) => current.filter((item) => item.id !== user.id));
    } catch (error) {
      Alert.alert('Could not decline request', error.message);
    } finally {
      setBusy(user.id, false);
    }
  };

  const handleCancel = async (user) => {
    setBusy(user.id, true);
    try {
      await removeFriend(user.id);
      setOutgoing((current) => current.filter((item) => item.id !== user.id));
    } catch (error) {
      Alert.alert('Could not cancel request', error.message);
    } finally {
      setBusy(user.id, false);
    }
  };

  const handleAddByCode = async () => {
    const code = normalizeFriendCode(codeInput);
    if (!code || codeBusy) return;
    setCodeBusy(true);
    try {
      const response = await addFriendByCode(code);
      hapticSuccess();
      setCodeInput('');
      await loadData();
      Alert.alert(response?.status === 'accepted' ? 'You’re friends' : 'Request sent', response?.message);
    } catch (error) {
      Alert.alert('Could not use that code', error.message);
    } finally {
      setCodeBusy(false);
    }
  };

  const handleCopyCode = () => {
    if (!friendCode) return;
    Clipboard.setString(friendCode);
    hapticSuccess();
    Alert.alert('Copied', 'Your Flock code is ready to paste.');
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  const renderPerson = (user, subtitle) => {
    const status = getFriendshipStatus(user.id, friendIds, outgoingIds);
    const busy = !!busyIds[user.id];
    return (
      <View key={user.id} style={[styles.personRow, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xl }]}>
        <Avatar user={user} />
        <View style={styles.personCopy}>
          <Text style={[typography.bodyBold, { color: colors.textPrimary }]} numberOfLines={1}>{user.name}</Text>
          {!!subtitle && <Text style={[typography.caption, { color: colors.textTertiary, marginTop: 2 }]}>{subtitle}</Text>}
        </View>
        {busy ? (
          <ActivityIndicator size="small" color={colors.navyMid} style={styles.rowAction} />
        ) : status === 'friends' ? (
          <View style={[styles.statusPill, { backgroundColor: colors.accentGreenBg, borderRadius: radius.pill }]}>
            <Text style={[typography.bodySmallBold, { color: colors.accentGreenText }]}>Friends</Text>
          </View>
        ) : status === 'pending' ? (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Cancel friend request to ${user.name}`} onPress={() => handleCancel(user)} style={[styles.statusPill, { backgroundColor: colors.iconBg, borderRadius: radius.pill }]}>
            <Text style={[typography.bodySmallBold, { color: colors.textSecondary }]}>Sent</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Add ${user.name} as a friend`} onPress={() => handleSend(user)} style={[styles.addButton, { backgroundColor: colors.navyBg, borderRadius: radius.pill }]}>
            <Icon name="user-plus" size={15} color="white" />
            <Text style={[typography.bodySmallBold, { color: 'white' }]}>Add</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={['top']}>
      <View style={[styles.header, { paddingHorizontal: screenPadding.default }]}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={() => navigation.goBack()} style={styles.headerBtn}>
          <Icon name="chevron-left" size={26} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerTitle}>
          <Text style={[typography.heading3, { color: colors.textPrimary }]}>Add Friends</Text>
          {pending.length > 0 && <View style={[styles.countBadge, { backgroundColor: colors.accentAmberBg, borderRadius: radius.pill }]}><Text style={[typography.label, { color: colors.accentAmberText, letterSpacing: 0 }]}>{pending.length} new</Text></View>}
        </View>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="View all friends" onPress={() => navigation.navigate('YouTab', { screen: 'Friends' })} style={styles.headerBtn}>
          <Icon name="users" size={20} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: screenPadding.default, paddingBottom: 96 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.navyMid} />}>
        {pending.length > 0 && (
          <View style={styles.section}>
            <SectionTitle label="Friend requests" count={pending.length} />
            {pending.map((user) => (
              <View key={user.id} style={[styles.personRow, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xl }]}>
                <Avatar user={user} />
                <View style={styles.personCopy}>
                  <Text style={[typography.bodyBold, { color: colors.textPrimary }]} numberOfLines={1}>{user.name}</Text>
                  <Text style={[typography.caption, { color: colors.textTertiary, marginTop: 2 }]}>Wants to be friends</Text>
                </View>
                {busyIds[user.id] ? <ActivityIndicator size="small" color={colors.navyMid} /> : (
                  <View style={styles.requestActions}>
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Accept ${user.name}'s friend request`} onPress={() => handleAccept(user)} style={[styles.circleButton, { backgroundColor: colors.accentGreenText }]}><Icon name="check" size={18} color="white" /></TouchableOpacity>
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Decline ${user.name}'s friend request`} onPress={() => handleDecline(user)} style={[styles.circleButton, { backgroundColor: colors.iconBg }]}><Icon name="x" size={18} color={colors.textSecondary} /></TouchableOpacity>
                  </View>
                )}
              </View>
            ))}
          </View>
        )}

        <View style={[styles.tabs, { backgroundColor: colors.iconBg, borderRadius: radius.xl }]}>
          {TABS.map((tab) => {
            const selected = activeTab === tab.key;
            return (
              <TouchableOpacity key={tab.key} accessibilityRole="tab" accessibilityState={{ selected }} onPress={() => setActiveTab(tab.key)} style={[styles.tab, selected && { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.lg }]}>
                <Icon name={tab.icon} size={15} color={selected ? colors.navyMid : colors.textTertiary} />
                <Text style={[typography.label, { color: selected ? colors.textPrimary : colors.textTertiary, letterSpacing: 0 }]}>{tab.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {activeTab === 'search' && (
          <View style={styles.section}>
            <View style={[styles.searchBox, { backgroundColor: colors.bgInput, borderColor: query ? colors.navyMid : colors.borderDefault, borderRadius: radius.xl }]}>
              <Icon name="search" size={18} color={colors.textTertiary} />
              <TextInput accessibilityLabel="Search people by name" value={query} onChangeText={setQuery} placeholder="Search by name" placeholderTextColor={colors.textTertiary} autoCapitalize="words" autoCorrect={false} returnKeyType="search" style={[styles.searchInput, typography.body, { color: colors.textPrimary }]} />
              {searching ? <ActivityIndicator size="small" color={colors.navyMid} /> : query ? <TouchableOpacity accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setQuery('')} style={styles.inputAction}><Icon name="x" size={17} color={colors.textTertiary} /></TouchableOpacity> : null}
            </View>
            {!!searchError && <Text style={[typography.bodySmall, { color: colors.accentRedText, marginTop: 10 }]}>{searchError}</Text>}
            {outgoing.length > 0 && !query && <View style={styles.subsection}><SectionTitle label="Sent requests" count={outgoing.length} />{outgoing.map((user) => renderPerson(user, 'Waiting for a response'))}</View>}
            {!query && outgoing.length === 0 && !loading && <EmptyState icon="search" title="Find your people" body="Search by name, then send a friend request." />}
            {!!query && !searching && !searchError && results.length === 0 && <EmptyState icon="user-x" title="No one found" body={`Try another spelling for “${query.trim()}”.`} />}
            {!searching && results.map((user) => renderPerson(user))}
          </View>
        )}

        {activeTab === 'quick' && (
          <View style={styles.section}>
            <SectionTitle label="People you may know" />
            {loading ? <ActivityIndicator size="large" color={colors.navyMid} style={styles.loader} /> : suggestions.length === 0 ? <EmptyState icon="users" title="No suggestions yet" body="Your suggestions grow as you join flocks and add friends." /> : suggestions.map((user) => renderPerson(user, `${Number(user.mutual_count || 0)} mutual friend${Number(user.mutual_count || 0) === 1 ? '' : 's'}`))}
          </View>
        )}

        {activeTab === 'code' && (
          <View style={styles.section}>
            <View style={[styles.codeCard, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xxl }]}>
              <View style={[styles.codeIcon, { backgroundColor: colors.iconBg }]}><Icon name="share-2" size={24} color={colors.navyMid} /></View>
              <Text style={[typography.heading3, { color: colors.textPrimary, marginTop: 14 }]}>Your Flock code</Text>
              <Text style={[typography.bodySmall, { color: colors.textSecondary, marginTop: 4, textAlign: 'center' }]}>Share it with a friend so they can find you instantly.</Text>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={friendCode ? `Copy friend code ${friendCode}` : 'Loading friend code'} disabled={!friendCode} onPress={handleCopyCode} style={[styles.codePill, { backgroundColor: colors.iconBg, borderColor: colors.borderDefault, borderRadius: radius.xl }]}>
                {friendCode ? <Text style={[typography.heading2, { color: colors.textPrimary, letterSpacing: 2 }]}>{friendCode}</Text> : <ActivityIndicator color={colors.navyMid} />}
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" onPress={() => Share.share({ message: `Add me on Flock with my code: ${friendCode}` })} disabled={!friendCode} style={[styles.shareButton, { backgroundColor: colors.navyBg, borderRadius: radius.xl }]}><Icon name="send" size={16} color="white" /><Text style={[typography.bodyBold, { color: 'white' }]}>Share my code</Text></TouchableOpacity>
            </View>
            <View style={[styles.enterCodeCard, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xxl }]}>
              <Text style={[typography.heading4, { color: colors.textPrimary }]}>Have a friend’s code?</Text>
              <Text style={[typography.bodySmall, { color: colors.textSecondary, marginTop: 3 }]}>Enter it below to send or accept their request.</Text>
              <View style={styles.codeInputRow}>
                <TextInput accessibilityLabel="Friend code" value={codeInput} onChangeText={(value) => setCodeInput(normalizeFriendCode(value))} placeholder="FLOCK-0000" placeholderTextColor={colors.textTertiary} autoCapitalize="characters" autoCorrect={false} maxLength={20} returnKeyType="done" onSubmitEditing={handleAddByCode} style={[styles.codeInput, typography.bodyBold, { backgroundColor: colors.bgInput, borderColor: colors.borderDefault, color: colors.textPrimary, borderRadius: radius.xl }]} />
                <TouchableOpacity accessibilityRole="button" accessibilityLabel="Add friend by code" onPress={handleAddByCode} disabled={!codeInput.trim() || codeBusy} style={[styles.codeAddButton, { backgroundColor: colors.navyBg, borderRadius: radius.xl, opacity: !codeInput.trim() || codeBusy ? 0.5 : 1 }]}>{codeBusy ? <ActivityIndicator size="small" color="white" /> : <Icon name="arrow-right" size={20} color="white" />}</TouchableOpacity>
              </View>
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Avatar({ user }) {
  const { colors, typography } = useTheme();
  return <View style={[styles.avatar, { backgroundColor: colors.navyMidBg }]}>{user.profile_image_url ? <Image source={{ uri: user.profile_image_url }} style={styles.avatarImage} /> : <Text style={[typography.bodyBold, { color: 'white' }]}>{getInitial(user.name)}</Text>}</View>;
}

function SectionTitle({ label, count }) {
  const { colors, typography, radius } = useTheme();
  return <View style={styles.sectionTitle}><Text style={[typography.labelBold, { color: colors.textTertiary }]}>{label}</Text>{Number.isFinite(count) && <View style={[styles.smallCount, { backgroundColor: colors.iconBg, borderRadius: radius.pill }]}><Text style={[typography.label, { color: colors.textSecondary, letterSpacing: 0 }]}>{count}</Text></View>}</View>;
}

function EmptyState({ icon, title, body }) {
  const { colors, typography } = useTheme();
  return <View style={styles.emptyState}><View style={[styles.emptyIcon, { backgroundColor: colors.iconBg }]}><Icon name={icon} size={24} color={colors.navyMid} /></View><Text style={[typography.heading4, { color: colors.textPrimary, marginTop: 12 }]}>{title}</Text><Text style={[typography.bodySmall, { color: colors.textSecondary, marginTop: 4, textAlign: 'center' }]}>{body}</Text></View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingTop: 8, paddingBottom: 8 },
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  countBadge: { paddingHorizontal: 8, paddingVertical: 4 },
  section: { marginTop: 18 },
  subsection: { marginTop: 22 },
  sectionTitle: { minHeight: 24, flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 8 },
  smallCount: { minWidth: 22, paddingHorizontal: 7, paddingVertical: 3, alignItems: 'center' },
  personRow: { minHeight: 68, flexDirection: 'row', alignItems: 'center', padding: 11, borderWidth: 1, gap: 11, marginBottom: 8 },
  personCopy: { flex: 1, minWidth: 0 },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarImage: { width: '100%', height: '100%' },
  rowAction: { width: 52 },
  addButton: { minWidth: 68, height: 38, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  statusPill: { minWidth: 64, minHeight: 36, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  requestActions: { flexDirection: 'row', gap: 8 },
  circleButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  tabs: { flexDirection: 'row', padding: 4, gap: 3, marginTop: 4 },
  tab: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderWidth: 1, borderColor: 'transparent' },
  searchBox: { minHeight: 50, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10, borderWidth: 1 },
  searchInput: { flex: 1, minHeight: 48, paddingVertical: 0 },
  inputAction: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  loader: { marginTop: 40 },
  emptyState: { alignItems: 'center', paddingHorizontal: 28, paddingVertical: 44 },
  emptyIcon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  codeCard: { padding: 22, borderWidth: 1, alignItems: 'center' },
  codeIcon: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  codePill: { minHeight: 64, width: '100%', marginTop: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  shareButton: { minHeight: 48, width: '100%', marginTop: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  enterCodeCard: { marginTop: 12, padding: 16, borderWidth: 1 },
  codeInputRow: { flexDirection: 'row', gap: 8, marginTop: 14 },
  codeInput: { flex: 1, minHeight: 50, paddingHorizontal: 14, borderWidth: 1, letterSpacing: 1 },
  codeAddButton: { width: 52, minHeight: 50, alignItems: 'center', justifyContent: 'center' },
});
