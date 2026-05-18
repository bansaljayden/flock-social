import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import GlassButton from '../../components/common/GlassButton';
import { updatePaymentMethods } from '../../services/api';

export default function PaymentSettingsScreen({ navigation }) {
  const { colors, typography, screenPadding, radius } = useTheme();
  const { user, refresh } = useAuth();

  const [venmo, setVenmo] = useState('');
  const [cashapp, setCashapp] = useState('');
  const [zelle, setZelle] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setVenmo(user?.venmo_username || '');
    setCashapp(user?.cashapp_cashtag || '');
    setZelle(user?.zelle_identifier || '');
  }, [user?.venmo_username, user?.cashapp_cashtag, user?.zelle_identifier]);

  const save = async () => {
    setSaving(true);
    try {
      await updatePaymentMethods({
        venmo_username: venmo.trim().replace(/^@/, ''),
        cashapp_cashtag: cashapp.trim().replace(/^\$/, ''),
        zelle_identifier: zelle.trim(),
      });
      await refresh();
      Alert.alert('Saved', 'Payment methods updated.');
    } catch (e) {
      Alert.alert('Save failed', e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={['top']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={[styles.header, { paddingHorizontal: screenPadding.default }]}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
            <Icon name="chevron-left" size={26} color={colors.textPrimary} />
          </TouchableOpacity>
          <Text style={[typography.heading3, { color: colors.textPrimary }]}>Payment Methods</Text>
          <View style={styles.headerBtn} />
        </View>

        <ScrollView contentContainerStyle={{ padding: screenPadding.default }} keyboardShouldPersistTaps="handled">
          <Text style={[typography.body, { color: colors.textSecondary, marginBottom: 16 }]}>
            Friends use these to pay you back from inside Flock. Nothing is processed by us — we just deep-link to the right app.
          </Text>

          <Field
            label="Venmo username"
            prefix="@"
            value={venmo}
            onChangeText={setVenmo}
            placeholder="jayden"
          />
          <Field
            label="CashApp cashtag"
            prefix="$"
            value={cashapp}
            onChangeText={setCashapp}
            placeholder="jayden"
          />
          <Field
            label="Zelle (email or phone)"
            value={zelle}
            onChangeText={setZelle}
            placeholder="jayden@example.com"
            keyboardType="email-address"
          />

          <View style={{ marginTop: 24 }}>
            <GlassButton variant="primary" onPress={save} loading={saving}>Save</GlassButton>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field({ label, prefix, value, onChangeText, placeholder, keyboardType }) {
  const { colors, typography, radius } = useTheme();
  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={[typography.labelBold, { color: colors.textTertiary, marginBottom: 6 }]}>{label}</Text>
      <View style={[styles.inputRow, { backgroundColor: colors.bgInput, borderColor: colors.borderDefault, borderRadius: radius.xl }]}>
        {!!prefix && <Text style={[typography.body, { color: colors.textTertiary, marginLeft: 14 }]}>{prefix}</Text>}
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={keyboardType}
          style={[styles.input, typography.body, { color: colors.textPrimary, marginLeft: prefix ? 4 : 14 }]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, paddingBottom: 8 },
  headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  inputRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, paddingRight: 14 },
  input: { flex: 1, paddingVertical: 14 },
});
