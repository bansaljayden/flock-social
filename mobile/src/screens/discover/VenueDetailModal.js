import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Image,
  Linking,
  Pressable,
} from 'react-native';
import Animated, { FadeIn, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';
import GlassButton from '../../components/common/GlassButton';
import CrowdScoreGauge from '../../components/crowd/CrowdScoreGauge';
import HourlyForecastChart from '../../components/crowd/HourlyForecastChart';
import LiveOccupancyCard from '../../components/crowd/LiveOccupancyCard';
import {
  getCrowdPrediction,
  getCrowdAlternatives,
  checkInManual,
} from '../../services/api';
import { track, Events } from '../../services/posthog';
import { success as hapticSuccess } from '../../utils/haptics';
import { cardShadow } from '../../theme/shadows';

// Bottom-sheet modal that opens when a venue marker is tapped. Pulls crowd
// prediction + alternatives in parallel; renders LiveOccupancyCard if a
// hardware sensor is deployed at the venue (component handles that gating).
//
// Phase 3 ships the core: gauge, hourly chart, crowd label, busiest/wait,
// alternatives, check-in button, directions. Polish pass adds: voting from
// inside a flock context, calibration indicator, full data-source list.

export default function VenueDetailModal({ visible, venue, onClose, onSelectAlternative }) {
  const { colors, typography, screenPadding, radius } = useTheme();

  const [crowd, setCrowd] = useState(null);
  const [alternatives, setAlternatives] = useState([]);
  const [loading, setLoading] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);

  useEffect(() => {
    if (!visible || !venue?.place_id) {
      setCrowd(null); setAlternatives([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    track(Events.VenueDetailOpened, { place_id: venue.place_id, name: venue.name });
    Promise.all([
      getCrowdPrediction(venue.place_id).catch(() => null),
      getCrowdAlternatives(venue.place_id).catch(() => ({ alternatives: [] })),
    ]).then(([c, a]) => {
      if (cancelled) return;
      setCrowd(c);
      setAlternatives(a?.alternatives || []);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [visible, venue?.place_id]);

  const score = Number.isFinite(crowd?.score) ? crowd.score : 0;
  const label = crowd?.label || (score > 70 ? 'Busy' : score > 40 ? 'Moderate' : 'Not Busy');
  const peakText = crowd?.peak || crowd?.bestTime || null;
  const waitText = crowd?.waitEstimate || null;
  const isLive = crowd?.dataSourcesUsed?.includes('user_feedback') || crowd?.dataSourcesUsed?.includes('ml_model');

  const handleDirections = () => {
    const lat = venue?.location?.latitude || venue?.lat;
    const lng = venue?.location?.longitude || venue?.lng;
    if (!lat || !lng) return;
    const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&destination_place_id=${venue?.place_id || ''}`;
    Linking.openURL(url).catch(() => {});
  };

  const handleCheckIn = async () => {
    if (!venue?.place_id || checkingIn) return;
    setCheckingIn(true);
    try {
      await checkInManual(venue.place_id);
      track(Events.CheckinManual, { place_id: venue.place_id });
      hapticSuccess();
    } catch (e) {
      console.warn('Check-in failed:', e.message);
    } finally {
      setCheckingIn(false);
    }
  };

  if (!venue) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* Backdrop */}
      <Pressable onPress={onClose} style={styles.backdrop}>
        <Animated.View entering={FadeIn.duration(200)} style={[styles.backdropFill, { backgroundColor: colors.modalBackdrop }]} />
      </Pressable>

      {/* Sheet */}
      <View style={styles.sheetWrapper} pointerEvents="box-none">
        <Animated.View
          entering={SlideInDown.springify().damping(20).stiffness(280)}
          exiting={SlideOutDown.duration(180)}
          style={[
            styles.sheet,
            {
              backgroundColor: colors.bgCardSolid,
              borderColor: colors.borderDefault,
              borderTopLeftRadius: radius.xxxl,
              borderTopRightRadius: radius.xxxl,
              ...cardShadow(colors),
            },
          ]}
        >
          {/* Drag handle */}
          <View style={[styles.handle, { backgroundColor: colors.borderMid }]} />

          <ScrollView
            contentContainerStyle={{ padding: screenPadding.default, paddingBottom: 32 }}
            showsVerticalScrollIndicator={false}
          >
            {/* Header */}
            <View style={styles.headerRow}>
              {venue.photo_url ? (
                <Image source={{ uri: venue.photo_url }} style={styles.heroPhoto} />
              ) : null}
              <View style={{ flex: 1, marginLeft: venue.photo_url ? 12 : 0 }}>
                <Text style={[typography.heading2, { color: colors.textPrimary }]} numberOfLines={2}>{venue.name}</Text>
                {venue.addr || venue.formatted_address ? (
                  <Text style={[typography.bodySmall, { color: colors.textSecondary, marginTop: 2 }]} numberOfLines={2}>
                    {venue.addr || venue.formatted_address}
                  </Text>
                ) : null}
                {(venue.rating || venue.stars) && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 4 }}>
                    <Icon name="star" size={12} color={colors.amber} />
                    <Text style={[typography.bodySmallBold, { color: colors.textPrimary }]}>{venue.rating || venue.stars}</Text>
                    {venue.price_level ? (
                      <Text style={[typography.bodySmall, { color: colors.textTertiary }]}>· {'$'.repeat(venue.price_level)}</Text>
                    ) : null}
                  </View>
                )}
              </View>
              <TouchableOpacity onPress={onClose} style={[styles.closeBtn, { backgroundColor: colors.iconBg }]}>
                <Icon name="x" size={18} color={colors.textPrimary} />
              </TouchableOpacity>
            </View>

            {/* Crowd block */}
            <View style={[styles.crowdBlock, { marginTop: 16 }]}>
              <CrowdScoreGauge score={score} label={label} size={108} />
              <View style={{ flex: 1, marginLeft: 16, justifyContent: 'center' }}>
                {!!isLive && (
                  <View style={[styles.livePill, { backgroundColor: colors.accentGreenBg, borderRadius: radius.lg }]}>
                    <View style={[styles.dot, { backgroundColor: colors.accentGreenText }]} />
                    <Text style={[typography.label, { color: colors.accentGreenText, letterSpacing: 0.5 }]}>LIVE</Text>
                  </View>
                )}
                <Text style={[typography.heading3, { color: colors.textPrimary, marginTop: isLive ? 8 : 0 }]} numberOfLines={1}>
                  {label}
                </Text>
                {!!peakText && (
                  <Text style={[typography.bodySmall, { color: colors.textSecondary, marginTop: 2 }]} numberOfLines={1}>
                    Peak: {peakText}
                  </Text>
                )}
                {!!waitText && (
                  <Text style={[typography.bodySmall, { color: colors.textSecondary }]} numberOfLines={1}>
                    Wait: {waitText}
                  </Text>
                )}
              </View>
            </View>

            {/* Hourly forecast */}
            {Array.isArray(crowd?.hourly) && crowd.hourly.length > 0 && (
              <View style={{ marginTop: 16 }}>
                <Text style={[typography.label, { color: colors.textTertiary, letterSpacing: 0.5, marginBottom: 6 }]}>
                  EXPECTED CROWD BY HOUR
                </Text>
                <HourlyForecastChart hourly={crowd.hourly} nowOverride={score} height={56} maxBars={12} />
              </View>
            )}

            {/* Live sensor card — only if a Pi reports for this place */}
            <View style={{ marginTop: 16 }}>
              <LiveOccupancyCard placeId={venue.place_id} />
            </View>

            {/* Quieter alternatives */}
            {alternatives.length > 0 && (
              <View style={{ marginTop: 20 }}>
                <Text style={[typography.label, { color: colors.textTertiary, letterSpacing: 0.5, marginBottom: 8 }]}>
                  LESS CROWDED NEARBY
                </Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {alternatives.slice(0, 2).map((alt, idx) => (
                    <TouchableOpacity
                      key={alt.placeId || alt.place_id || idx}
                      onPress={() => onSelectAlternative?.(alt)}
                      style={[styles.altCard, { backgroundColor: colors.bgInput, borderColor: colors.borderDefault, borderRadius: radius.lg }]}
                    >
                      <Text style={[typography.bodySmallBold, { color: colors.textPrimary }]} numberOfLines={1}>{alt.name}</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
                        <View style={[styles.dot, {
                          backgroundColor: (alt.score || alt.crowd) > 70 ? colors.red : (alt.score || alt.crowd) > 40 ? colors.amber : colors.teal,
                        }]} />
                        <Text style={[typography.caption, { color: colors.textSecondary }]}>
                          {alt.label || ((alt.score || alt.crowd) > 70 ? 'Very Busy' : (alt.score || alt.crowd) > 40 ? 'Moderate' : 'Not Busy')}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            {/* Action row */}
            <View style={{ marginTop: 24, gap: 10 }}>
              <GlassButton variant="primary" onPress={handleCheckIn} loading={checkingIn} icon={<Icon name="check-circle" size={16} color="white" />}>
                Check In
              </GlassButton>
              <GlassButton
                variant="secondary"
                onPress={handleDirections}
                icon={<Icon name="navigation" size={16} color={colors.textPrimary} />}
              >
                Get Directions
              </GlassButton>
            </View>

            {loading && !crowd && (
              <Text style={[typography.bodySmall, { color: colors.textTertiary, textAlign: 'center', marginTop: 12 }]}>
                Loading crowd prediction…
              </Text>
            )}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject },
  backdropFill: { ...StyleSheet.absoluteFillObject },
  sheetWrapper: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '88%',
    borderWidth: 1,
    borderBottomWidth: 0,
  },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 8, marginBottom: 4 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start' },
  heroPhoto: { width: 64, height: 64, borderRadius: 14 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  crowdBlock: { flexDirection: 'row', alignItems: 'center' },
  livePill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  altCard: { flex: 1, padding: 10, borderWidth: 1 },
});
