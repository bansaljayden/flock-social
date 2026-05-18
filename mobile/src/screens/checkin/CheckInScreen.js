import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Linking, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { getNfcCheckin } from '../../services/api';
import { track, Events } from '../../services/posthog';

// NFC tap landing — reached via Universal Link to flockcorp.com/checkin/<placeId>.
// Backend records the check-in (authed or anonymous). This screen confirms it.
//
// Phase 1 stub. Phase 5 polishes the design + venue lookup + crowd badge.
export default function CheckInScreen({ route, navigation }) {
  const { colors, typography } = useTheme();
  const { user } = useAuth();
  const placeId = route?.params?.placeId;
  const [status, setStatus] = useState('loading'); // 'loading' | 'ok' | 'error'
  const [checkedInAt, setCheckedInAt] = useState(null);

  useEffect(() => {
    if (!placeId) { setStatus('error'); return; }
    getNfcCheckin(placeId)
      .then(res => {
        setCheckedInAt(res?.checked_in_at || new Date().toISOString());
        setStatus('ok');
        track(Events.CheckinNfc, { place_id: placeId, authenticated: !!user });
      })
      .catch(() => setStatus('error'));
  }, [placeId]);

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]}>
      <View style={styles.center}>
        {status === 'loading' && <ActivityIndicator size="large" color={colors.teal} />}
        {status === 'ok' && (
          <>
            <Text style={[typography.heading1, { color: colors.textPrimary }]}>
              {user ? "You're checked in!" : 'Checked in.'}
            </Text>
            <Text style={[typography.bodySmall, { color: colors.textSecondary, marginTop: 8 }]}>
              {checkedInAt ? new Date(checkedInAt).toLocaleString() : ''}
            </Text>
            {!user && (
              <TouchableOpacity onPress={() => Linking.openURL('https://flockcorp.com')} style={{ marginTop: 24 }}>
                <Text style={[typography.body, { color: colors.teal }]}>Continue to website</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => navigation.navigate('Nest')} style={{ marginTop: 16 }}>
              <Text style={[typography.body, { color: colors.textSecondary }]}>Done</Text>
            </TouchableOpacity>
          </>
        )}
        {status === 'error' && (
          <Text style={[typography.body, { color: colors.accentRedText }]}>Check-in failed. Try tapping again.</Text>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
