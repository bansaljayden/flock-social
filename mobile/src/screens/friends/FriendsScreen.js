import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Image,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';
import {
  getFriends,
  getPendingRequests,
  acceptFriendRequest,
  declineFriendRequest,
  removeFriend,
} from '../../services/api';
import { readCache, writeCache, CacheKeys } from '../../services/offlineCache';
import ModerationMenu from '../../components/common/ModerationMenu';

export default function FriendsScreen({ navigation }) {
  const { colors, typography, screenPadding, radius } = useTheme();
  const [friends, setFriends] = useState([]);
  const [pending, setPending] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [modTarget, setModTarget] = useState(null); // report/block target

  const load = useCallback(async () => {
    try {
      const [f, p] = await Promise.all([
        getFriends().catch(() => ({ friends: [] })),
        getPendingRequests().catch(() => ({ requests: [] })),
      ]);
      const fList = f?.friends || f || [];
      setFriends(fList);
      setPending(p?.requests || p || []);
      writeCache(CacheKeys.Friends, fList);
    } catch (e) {
      console.warn('Friends load failed:', e.message);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    readCache(CacheKeys.Friends).then((entry) => {
      if (!cancelled && entry?.value) setFriends(entry.value);
    });
    return () => { cancelled = true; };
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true); await load(); setRefreshing(false);
  }, [load]);

  const handleAccept = async (uid) => {
    try { await acceptFriendRequest(uid); await load(); }
    catch (e) { Alert.alert('Could not accept', e.message); }
  };
  const handleDecline = async (uid) => {
    try { await declineFriendRequest(uid); await load(); }
    catch (e) { Alert.alert('Could not decline', e.message); }
  };
  const handleRemove = (friend) => {
    Alert.alert(`Remove ${friend.name}?`, '', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try { await removeFriend(friend.id); await load(); }
          catch (e) { Alert.alert('Could not remove', e.message); }
        },
      },
    ]);
  };
  const openFriendActions = (friend) => {
    Alert.alert(friend.name, undefined, [
      { text: 'Report or Block', onPress: () => setModTarget({ userId: friend.id, name: friend.name, contentType: 'profile', contentId: friend.id }) },
      { text: 'Remove friend', style: 'destructive', onPress: () => handleRemove(friend) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const renderFriend = ({ item }) => (
    <TouchableOpacity
      onPress={() => navigation.navigate('DMChat', { otherUserId: item.id, otherUserName: item.name })}
      onLongPress={() => openFriendActions(item)}
      style={[styles.row, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xl }]}
    >
      <View style={[styles.avatar, { backgroundColor: colors.navyMidBg }]}>
        {item.profile_image_url ? (
          <Image source={{ uri: item.profile_image_url }} style={{ width: 38, height: 38 }} />
        ) : (
          <Text style={[typography.bodyBold, { color: 'white' }]}>{(item.name || '?')[0].toUpperCase()}</Text>
        )}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[typography.bodyBold, { color: colors.textPrimary }]}>{item.name}</Text>
        {!!item.username && <Text style={[typography.bodySmall, { color: colors.textTertiary }]}>@{item.username}</Text>}
      </View>
      <Icon name="message-circle" size={18} color={colors.textTertiary} />
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={['top']}>
      <View style={[styles.header, { paddingHorizontal: screenPadding.default }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
          <Icon name="chevron-left" size={26} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={[typography.heading3, { color: colors.textPrimary }]}>Friends</Text>
        <TouchableOpacity onPress={() => navigation.navigate('AddFriends')} style={styles.headerBtn}>
          <Icon name="user-plus" size={20} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>

      <FlatList
        data={friends}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderFriend}
        contentContainerStyle={{ padding: screenPadding.default, paddingBottom: 96, gap: 8 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.teal} />}
        ListHeaderComponent={
          pending.length > 0 ? (
            <View style={{ marginBottom: 16 }}>
              <Text style={[typography.label, { color: colors.textTertiary, letterSpacing: 0.5, marginBottom: 8 }]}>
                PENDING REQUESTS
              </Text>
              {pending.map((req) => (
                <View key={req.id} style={[styles.requestRow, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xl }]}>
                  <View style={[styles.avatar, { backgroundColor: colors.navyMidBg }]}>
                    <Text style={[typography.bodyBold, { color: 'white' }]}>{(req.name || '?')[0].toUpperCase()}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[typography.bodyBold, { color: colors.textPrimary }]}>{req.name}</Text>
                    <Text style={[typography.caption, { color: colors.textTertiary }]}>wants to be friends</Text>
                  </View>
                  <TouchableOpacity onPress={() => handleAccept(req.id)} style={[styles.miniBtn, { backgroundColor: colors.teal, borderRadius: radius.lg }]}>
                    <Text style={[typography.bodySmallBold, { color: 'white' }]}>Accept</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => handleDecline(req.id)} style={[styles.miniBtn, { backgroundColor: colors.iconBg, borderRadius: radius.lg }]}>
                    <Text style={[typography.bodySmallBold, { color: colors.textPrimary }]}>×</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={[styles.emptyCard, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xxl }]}>
            <Icon name="users" size={28} color={colors.textTertiary} />
            <Text style={[typography.body, { color: colors.textSecondary, marginTop: 12, textAlign: 'center' }]}>
              No friends yet. Add some up top.
            </Text>
          </View>
        }
      />

      <ModerationMenu
        target={modTarget}
        onClose={() => setModTarget(null)}
        onBlocked={() => load()}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, paddingBottom: 8 },
  headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', padding: 12, borderWidth: 1, gap: 12 },
  requestRow: { flexDirection: 'row', alignItems: 'center', padding: 10, borderWidth: 1, gap: 8, marginBottom: 6 },
  avatar: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  miniBtn: { paddingHorizontal: 12, paddingVertical: 6 },
  emptyCard: { padding: 32, borderWidth: 1, alignItems: 'center', marginTop: 16 },
});
