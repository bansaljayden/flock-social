import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, RefreshControl, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';
import FlockCard from '../../components/flock/FlockCard';
import GlassButton from '../../components/common/GlassButton';
import { getFlocks } from '../../services/api';

export default function FlockListScreen({ navigation }) {
  const { colors, typography, screenPadding, radius } = useTheme();
  const [flocks, setFlocks] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await getFlocks();
      setFlocks(data?.flocks || []);
    } catch (e) {
      console.warn('FlockListScreen load failed:', e.message);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={['top']}>
      <View style={[styles.header, { padding: screenPadding.default }]}>
        <Text style={[typography.heading1, { color: colors.textPrimary }]}>Plans</Text>
        <TouchableOpacity onPress={() => navigation.navigate('CreateFlock')} style={[styles.iconBtn, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault }]}>
          <Icon name="plus" size={20} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>

      <FlatList
        data={flocks}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={{ paddingHorizontal: screenPadding.default, paddingBottom: 96 }}
        renderItem={({ item }) => (
          <FlockCard flock={item} onPress={() => navigation.navigate('FlockDetail', { flockId: item.id })} />
        )}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.teal} />}
        ListEmptyComponent={
          <View style={[styles.emptyCard, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xxl }]}>
            <Text style={[typography.body, { color: colors.textSecondary, textAlign: 'center', marginBottom: 16 }]}>
              No plans yet.
            </Text>
            <GlassButton variant="primary" onPress={() => navigation.navigate('CreateFlock')}>Start a Flock</GlassButton>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  iconBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  emptyCard: { padding: 24, borderWidth: 1, alignItems: 'center', marginTop: 32 },
});
