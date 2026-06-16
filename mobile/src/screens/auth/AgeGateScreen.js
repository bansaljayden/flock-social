import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../../context/ThemeContext';
import GlassButton from '../../components/common/GlassButton';

// Neutral age gate (C4). Shown once before the auth flow. Collects a date of
// birth (neutral — does NOT reveal the 13 cutoff) and blocks under-13 to stay
// outside COPPA's verifiable-parental-consent regime + Google's child-safety
// rules. Result persisted in AsyncStorage so it's a one-time gate per device.

export const AGE_KEY = 'flock_age_verified';
const DOB_KEY = 'flock_dob';
const MIN_AGE = 13;

function computeAge(y, m, d) {
  const today = new Date();
  let age = today.getFullYear() - y;
  const month = today.getMonth() + 1;
  const hadBirthday = month > m || (month === m && today.getDate() >= d);
  if (!hadBirthday) age -= 1;
  return age;
}

export default function AgeGateScreen({ onVerified }) {
  const { colors, typography, radius, screenPadding } = useTheme();
  const [month, setMonth] = useState('');
  const [day, setDay] = useState('');
  const [year, setYear] = useState('');
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState(false);

  const submit = async () => {
    const m = parseInt(month, 10), d = parseInt(day, 10), y = parseInt(year, 10);
    const nowYear = new Date().getFullYear();
    if (!m || !d || !y || m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > nowYear) {
      setError('Please enter a valid date of birth.');
      return;
    }
    if (computeAge(y, m, d) < MIN_AGE) {
      setBlocked(true);
      return;
    }
    await AsyncStorage.multiSet([
      [AGE_KEY, 'true'],
      [DOB_KEY, `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`],
    ]);
    onVerified && onVerified();
  };

  const inputStyle = [
    styles.dobInput, typography.heading3,
    { backgroundColor: colors.bgInput, borderColor: colors.borderDefault, color: colors.textPrimary, borderRadius: radius.xl },
  ];

  if (blocked) {
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]}>
        <View style={[styles.center, { padding: screenPadding.loose }]}>
          <Text style={[typography.heading1, { color: colors.textPrimary, textAlign: 'center' }]}>You're not old enough yet</Text>
          <Text style={[typography.body, { color: colors.textSecondary, textAlign: 'center', marginTop: 12 }]}>
            You must be at least {MIN_AGE} to use Flock. Thanks for checking it out.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]}>
      <View style={[styles.center, { padding: screenPadding.loose }]}>
        <Text style={[typography.heading1, { color: colors.textPrimary }]}>What's your date of birth?</Text>
        <Text style={[typography.body, { color: colors.textSecondary, marginTop: 8, marginBottom: 24 }]}>
          We ask to keep Flock age-appropriate. We don't share this.
        </Text>
        <View style={styles.dobRow}>
          <TextInput value={month} onChangeText={setMonth} placeholder="MM" placeholderTextColor={colors.textTertiary} keyboardType="number-pad" maxLength={2} style={inputStyle} />
          <TextInput value={day} onChangeText={setDay} placeholder="DD" placeholderTextColor={colors.textTertiary} keyboardType="number-pad" maxLength={2} style={inputStyle} />
          <TextInput value={year} onChangeText={setYear} placeholder="YYYY" placeholderTextColor={colors.textTertiary} keyboardType="number-pad" maxLength={4} style={[inputStyle, { flex: 1.5 }]} />
        </View>
        {error ? <Text style={[typography.bodySmall, { color: colors.accentRedText, marginTop: 12 }]}>{error}</Text> : null}
        <View style={{ marginTop: 24 }}>
          <GlassButton variant="primary" onPress={submit}>Continue</GlassButton>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center' },
  dobRow: { flexDirection: 'row', gap: 10 },
  dobInput: { flex: 1, paddingVertical: 16, paddingHorizontal: 14, borderWidth: 1, textAlign: 'center' },
});
