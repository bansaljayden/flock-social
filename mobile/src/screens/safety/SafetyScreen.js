import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import LinearGradient from 'react-native-linear-gradient';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';
import { useLocation } from '../../hooks/useLocation';
import { sendEmergencyAlert, shareLocationWithContacts } from '../../services/api';
import { track, Events } from '../../services/posthog';
import { danger as hapticDanger } from '../../utils/haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Safety hub. The SOS button is intentionally NOT glassy — emergencies need
// to feel different from the rest of the UI. Gradient red + scale press
// animation. Confirmation dialog before firing.

export default function SafetyScreen({ navigation }) {
  const { colors, typography, screenPadding, radius } = useTheme();
  const { location, refresh: refreshLocation } = useLocation();

  const [busy, setBusy] = useState(false);
  const sosScale = useSharedValue(1);
  const sosStyle = useAnimatedStyle(() => ({ transform: [{ scale: sosScale.value }] }));

  const triggerSOS = async () => {
    Alert.alert(
      'Send emergency alert?',
      'Your trusted contacts will receive your current location and a message that you need help.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send Alert',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            hapticDanger();
            try {
              const loc = location || (await refreshLocation());
              await sendEmergencyAlert({
                latitude: loc?.latitude,
                longitude: loc?.longitude,
                includeLocation: true,
                timezone: 'UTC',
              });
              track(Events.SosTriggered, { had_location: !!loc });
              Alert.alert('Alert sent', 'Your trusted contacts have been notified.');
            } catch (e) {
              Alert.alert('Could not send alert', e.message);
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );
  };

  const shareLocation = async () => {
    setBusy(true);
    try {
      const loc = location || (await refreshLocation());
      await shareLocationWithContacts({
        latitude: loc?.latitude, longitude: loc?.longitude, timezone: 'UTC',
      });
      Alert.alert('Location shared', 'Your trusted contacts have a link to your location.');
    } catch (e) {
      Alert.alert('Could not share', e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={['top']}>
      <View style={[styles.header, { paddingHorizontal: screenPadding.default }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
          <Icon name="chevron-left" size={26} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={[typography.heading3, { color: colors.textPrimary }]}>Safety</Text>
        <View style={styles.headerBtn} />
      </View>

      <ScrollView contentContainerStyle={{ padding: screenPadding.default, paddingBottom: 96 }}>

        {/* SOS — gradient, NOT glass. Emergency UI. */}
        <View style={styles.sosBlock}>
          <AnimatedPressable
            onPressIn={() => { sosScale.value = withSpring(0.95, { damping: 16, stiffness: 320 }); }}
            onPressOut={() => { sosScale.value = withSpring(1, { damping: 16, stiffness: 320 }); }}
            onPress={triggerSOS}
            disabled={busy}
            style={[sosStyle]}
          >
            <LinearGradient
              colors={['#EF4444', '#B91C1C']}
              style={[styles.sosBtn, { borderRadius: radius.huge }]}
              start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
            >
              <Icon name="alert-triangle" size={36} color="white" />
              <Text style={[typography.heading2, { color: 'white', marginTop: 6 }]}>SOS</Text>
              <Text style={[typography.bodySmall, { color: 'rgba(255,255,255,0.9)', marginTop: 2 }]}>Tap to alert your contacts</Text>
            </LinearGradient>
          </AnimatedPressable>
        </View>

        {/* Secondary actions */}
        <View style={[styles.row, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xl, marginTop: 16 }]}>
          <View style={styles.rowIcon}><Icon name="map-pin" size={18} color={colors.textPrimary} /></View>
          <View style={{ flex: 1 }}>
            <Text style={[typography.body, { color: colors.textPrimary }]}>Share my location</Text>
            <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>Send a non-emergency check-in to your contacts.</Text>
          </View>
          <TouchableOpacity onPress={shareLocation} disabled={busy}>
            <Text style={[typography.bodySmallBold, { color: colors.teal }]}>Send</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          onPress={() => navigation.navigate('TrustedContacts')}
          style={[styles.row, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xl, marginTop: 12 }]}
        >
          <View style={styles.rowIcon}><Icon name="users" size={18} color={colors.textPrimary} /></View>
          <View style={{ flex: 1 }}>
            <Text style={[typography.body, { color: colors.textPrimary }]}>Trusted contacts</Text>
            <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>People who get your SOS alerts.</Text>
          </View>
          <Icon name="chevron-right" size={18} color={colors.textTertiary} />
        </TouchableOpacity>

        <Text style={[typography.caption, { color: colors.textTertiary, marginTop: 24, textAlign: 'center' }]}>
          Add at least one trusted contact for SOS to mean anything.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, paddingBottom: 8 },
  headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  sosBlock: { alignItems: 'center', marginTop: 24 },
  sosBtn: {
    width: 220, height: 220, borderRadius: 110,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#EF4444', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.4, shadowRadius: 24,
    elevation: 12,
  },
  row: { flexDirection: 'row', alignItems: 'center', padding: 14, borderWidth: 1, gap: 12 },
  rowIcon: { width: 24, alignItems: 'center' },
});
