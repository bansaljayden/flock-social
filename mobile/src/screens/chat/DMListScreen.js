import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';
import { getDMConversations } from '../../services/api';
import { readCache, writeCache, CacheKeys } from '../../services/offlineCache';

export default function DMListScreen({ navigation }) {
  const { colors, typography, screenPadding, radius } = useTheme();
  const [convos, setConvos] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await getDMConversations();
      const list = data?.conversations || data || [];
      setConvos(list);
      writeCache(CacheKeys.DMs, list);
    } catch (e) {
      console.warn('DM list load failed:', e.message);
    }
  }, []);

  // Hydrate from cache on cold start
  useEffect(() => {
    let cancelled = false;
    readCache(CacheKeys.DMs).then((entry) => {
      if (!cancelled && entry?.value) setConvos(entry.value);
    });
    return () => { cancelled = true; };
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const renderItem = ({ item }) => {
    const initial = (item.name || '?')[0].toUpperCase();
    const preview = item.last_message_text || item.last_message || 'New conversation';
    return (
      <TouchableOpacity
        onPress={() => navigation.navigate('DMChat', { otherUserId: item.user_id || item.id, otherUserName: item.name })}
        style={[styles.row, { borderBottomColor: colors.borderSubtle }]}
      >
        <View style={[styles.avatar, { backgroundColor: colors.navyMidBg }]}>
          {item.profile_image_url ? (
            <Image source={{ uri: item.profile_image_url }} style={styles.avatarImg} />
          ) : (
            <Text style={[typography.bodyBold, { color: 'white' }]}>{initial}</Text>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[typography.bodyBold, { color: colors.textPrimary }]} numberOfLines={1}>{item.name || 'Unknown'}</Text>
          <Text style={[typography.bodySmall, { color: colors.textSecondary }]} numberOfLines={1}>{preview}</Text>
        </View>
        {item.unread_count > 0 && (
          <View style={[styles.unreadBadge, { backgroundColor: colors.teal, borderRadius: radius.pill }]}>
            <Text style={[typography.label, { color: 'white', letterSpacing: 0 }]}>{item.unread_count}</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={['top']}>
      <View style={[styles.header, { padding: screenPadding.default }]}>
        <Text style={[typography.heading1, { color: colors.textPrimary }]}>Messages</Text>
      </View>
      <FlatList
        data={convos}
        keyExtractor={(item, idx) => String(item.user_id || item.id || idx)}
        renderItem={renderItem}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.teal} />}
        ListEmptyComponent={
          <View style={[styles.emptyCard, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xxl, marginHorizontal: screenPadding.default }]}>
            <Icon name="message-circle" size={28} color={colors.textTertiary} />
            <Text style={[typography.body, { color: colors.textSecondary, marginTop: 12, textAlign: 'center' }]}>
              No DMs yet. Tap a friend to start one.
            </Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {},
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12, gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarImg: { width: 48, height: 48 },
  unreadBadge: { paddingHorizontal: 8, paddingVertical: 2, minWidth: 22, alignItems: 'center' },
  emptyCard: { padding: 24, borderWidth: 1, alignItems: 'center', marginTop: 32 },
});
