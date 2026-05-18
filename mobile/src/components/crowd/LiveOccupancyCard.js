import React, { useEffect, useState, useRef } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { useTheme } from '../../context/ThemeContext';
import { useSocket } from '../../context/SocketContext';
import {
  getSensorCurrent,
  getSensorHistory,
} from '../../services/api';
import {
  joinVenueRoom,
  leaveVenueRoom,
  onVenueSensorUpdate,
  onVenueCheckin,
} from '../../services/socket';

// Direct port of the simpler Live Occupancy card from the web app
// (frontend/src/App.js after the visual revert). Only renders if a Pi sensor
// has reported data for this venue. Live updates via socket.

export default function LiveOccupancyCard({ placeId }) {
  const { colors, typography, radius } = useTheme();
  useSocket(); // ensure socket is alive

  const [sensorData, setSensorData] = useState(null);
  const [history, setHistory] = useState([]);

  const pulse = useSharedValue(1);
  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(withTiming(1.3, { duration: 1000 }), withTiming(1, { duration: 1000 })),
      -1,
      false
    );
  }, [pulse]);
  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));

  useEffect(() => {
    if (!placeId) return;
    let cancelled = false;
    Promise.all([
      getSensorCurrent(placeId).catch(() => null),
      getSensorHistory(placeId, 12).catch(() => ({ readings: [] })),
    ]).then(([current, hist]) => {
      if (cancelled) return;
      setSensorData(current && current.sensor_data ? current : null);
      setHistory(hist?.readings || []);
    });

    joinVenueRoom(placeId);
    const sameHour = (a, b) => {
      const da = new Date(a), db = new Date(b);
      return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth()
        && da.getDate() === db.getDate() && da.getHours() === db.getHours();
    };
    const offUpdate = onVenueSensorUpdate((p) => {
      if (!p || p.venue_place_id !== placeId) return;
      setSensorData((prev) => ({
        sensor_data: {
          venue_place_id: placeId,
          ir_beam_count: p.ir_beam_count,
          thermal_headcount: p.thermal_headcount,
          noise_db: p.noise_db,
          recorded_at: p.recorded_at,
        },
        recent_checkins: prev?.recent_checkins || 0,
      }));
      setHistory((prev) => {
        const last = prev[prev.length - 1];
        const incoming = {
          recorded_at: p.recorded_at,
          thermal_headcount: p.thermal_headcount,
          ir_beam_count: p.ir_beam_count,
          noise_db: p.noise_db,
        };
        if (last && sameHour(last.recorded_at, p.recorded_at)) {
          return [...prev.slice(0, -1), incoming];
        }
        return [...prev, incoming].slice(-48);
      });
    });
    const offCheckin = onVenueCheckin((p) => {
      if (!p || p.venue_place_id !== placeId) return;
      setSensorData((prev) => prev ? { ...prev, recent_checkins: (prev.recent_checkins || 0) + 1 } : prev);
    });

    return () => {
      cancelled = true;
      leaveVenueRoom(placeId);
      offUpdate && offUpdate();
      offCheckin && offCheckin();
    };
  }, [placeId]);

  if (!sensorData?.sensor_data) return null;

  const sd = sensorData.sensor_data;
  const ageMin = sd.recorded_at
    ? Math.max(0, Math.round((Date.now() - new Date(sd.recorded_at).getTime()) / 60000))
    : null;
  const ageStr = ageMin == null ? '' : ageMin === 0 ? 'just now' : ageMin === 1 ? '1 min ago' : `${ageMin} min ago`;

  const noiseLabel = sd.noise_db == null ? null
    : sd.noise_db < 50 ? { text: 'Quiet', color: colors.teal }
    : sd.noise_db < 70 ? { text: 'Moderate', color: colors.amber }
    : sd.noise_db < 85 ? { text: 'Lively', color: colors.food }
    : { text: 'Loud', color: colors.red };

  // Build 12 hour-bucketed slots for the mini chart
  const hourMs = (ts) => { const d = new Date(ts); d.setMinutes(0, 0, 0); return d.getTime(); };
  const now = new Date();
  const currentHour = hourMs(now);
  const slotMs = 60 * 60 * 1000;
  const slots = Array.from({ length: 12 }, (_, idx) => {
    const slotTs = currentHour - (11 - idx) * slotMs;
    return history.find((r) => hourMs(r.recorded_at) === slotTs) || null;
  });
  const maxHeads = Math.max(1, ...slots.map((s) => s?.thermal_headcount || 0));

  return (
    <View style={[styles.card, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xxl }]}>
      <View style={styles.headerRow}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Animated.View style={[styles.pulseDot, pulseStyle]} />
          <Text style={[typography.labelBold, { color: colors.textPrimary, letterSpacing: 0.5 }]}>LIVE OCCUPANCY</Text>
        </View>
        {ageStr ? <Text style={[typography.caption, { color: colors.textTertiary }]}>{ageStr}</Text> : null}
      </View>

      <View style={[styles.heroRow, { marginTop: 6 }]}>
        <Text style={[typography.numberLg, { color: colors.textPrimary, fontSize: 28, lineHeight: 30 }]}>~{sd.thermal_headcount}</Text>
        <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>people right now</Text>
      </View>

      {noiseLabel && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: noiseLabel.color }} />
          <Text style={[typography.bodySmallBold, { color: noiseLabel.color }]}>{noiseLabel.text}</Text>
          <Text style={[typography.caption, { color: colors.textTertiary }]}>· {Number(sd.noise_db).toFixed(0)} dB</Text>
        </View>
      )}

      <Text style={[typography.label, { color: colors.textTertiary, marginTop: 14, marginBottom: 4, letterSpacing: 0.5 }]}>LAST 12 HOURS</Text>
      <View style={styles.chartRow}>
        {slots.map((s, i) => {
          if (!s) {
            return <View key={i} style={[styles.chartGhost, { borderColor: colors.borderSubtle }]} />;
          }
          const h = Math.max(2, Math.round((s.thermal_headcount / maxHeads) * 32));
          return <View key={i} style={[styles.chartBar, { height: h, backgroundColor: colors.navy, opacity: 0.85 }]} />;
        })}
      </View>

      {sensorData.recent_checkins > 0 && (
        <Text style={[typography.bodySmall, { color: colors.textSecondary, marginTop: 10 }]}>
          {sensorData.recent_checkins} check-in{sensorData.recent_checkins === 1 ? '' : 's'} in the last hour
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, borderWidth: 1 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pulseDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#10b981' },
  heroRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  chartRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 36 },
  chartBar: { flex: 1, borderRadius: 2 },
  chartGhost: { flex: 1, height: 4, borderWidth: 1, borderStyle: 'dashed', opacity: 0.5, borderRadius: 2 },
});
