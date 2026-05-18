import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../../context/ThemeContext';

// Mirrors the web's "Expected Crowd by Hour" chart in App.js. Each bar is one
// hour starting at "Now", colored by busyness (teal/amber/red). The "Now" bar
// uses the live score (passed via `nowOverride`) so the gauge dial and the
// first bar always agree — same trick used in the web version.

export default function HourlyForecastChart({
  hourly = [],            // [{ hour: '5 PM', score: 60 }, ...]
  nowOverride = null,     // live score for slot 0
  height = 56,
  maxBars = 12,
}) {
  const { colors, typography } = useTheme();

  if (!hourly.length) return null;

  const slots = hourly.slice(0, maxBars);
  const colorFor = (val, isClosed) => {
    if (isClosed) return colors.textTertiary;
    if (val > 70) return colors.red;
    if (val > 40) return colors.amber;
    return colors.teal;
  };

  return (
    <View>
      <View style={[styles.row, { height }]}>
        {slots.map((h, i) => {
          const isNow = i === 0;
          const score = isNow && Number.isFinite(nowOverride) && nowOverride > 0
            ? nowOverride
            : (Number.isFinite(h.score) ? h.score : 0);
          // Closed-hour rendering: the web version greys based on Google
          // hours; RN port trusts the ML's score (low score on closed hours)
          // and skips the heuristic — same "trust the model" stance.
          const isClosed = score === 0;
          const fillColor = colorFor(score, isClosed);
          const barH = isClosed ? 6 : Math.max(8, (Math.min(score, 100) / 100) * (height - 4));
          return (
            <View key={i} style={styles.col}>
              <View
                style={[
                  styles.bar,
                  {
                    height: barH,
                    backgroundColor: fillColor,
                    opacity: isNow ? 1 : 0.85,
                    shadowColor: isNow ? fillColor : 'transparent',
                    shadowOpacity: isNow ? 0.5 : 0,
                    shadowRadius: isNow ? 4 : 0,
                  },
                ]}
              />
            </View>
          );
        })}
      </View>

      {/* Hour labels — only first / last to avoid clutter, like the web */}
      <View style={styles.labelRow}>
        <Text style={[typography.caption, { color: colors.textPrimary, fontWeight: '700' }]}>Now</Text>
        <Text style={[typography.caption, { color: colors.textTertiary }]}>{slots[slots.length - 1]?.hour || ''}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 3 },
  col: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  bar: { width: '100%', borderRadius: 3 },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
});
