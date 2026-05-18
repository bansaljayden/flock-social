import React, { useState, useEffect, useCallback } from 'react';
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
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';
import GlassButton from '../../components/common/GlassButton';
import {
  getTrustedContacts,
  addTrustedContact,
  deleteTrustedContact,
} from '../../services/api';

export default function TrustedContactsScreen({ navigation }) {
  const { colors, typography, screenPadding, radius } = useTheme();
  const [contacts, setContacts] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [relationship, setRelationship] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await getTrustedContacts();
      setContacts(data?.contacts || []);
    } catch (e) {
      console.warn('TrustedContacts load failed:', e.message);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const add = async () => {
    if (!name.trim()) { Alert.alert('Name required'); return; }
    if (!email.trim() && !phone.trim()) { Alert.alert('Email or phone required'); return; }
    setSaving(true);
    try {
      await addTrustedContact({
        name: name.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        relationship: relationship.trim() || null,
      });
      setName(''); setEmail(''); setPhone(''); setRelationship('');
      setShowAdd(false);
      await load();
    } catch (e) {
      Alert.alert('Could not add contact', e.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = (c) => {
    Alert.alert(`Remove ${c.name}?`, 'They will no longer get your SOS alerts.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try { await deleteTrustedContact(c.id); await load(); }
          catch (e) { Alert.alert('Could not remove', e.message); }
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={['top']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={[styles.header, { paddingHorizontal: screenPadding.default }]}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
            <Icon name="chevron-left" size={26} color={colors.textPrimary} />
          </TouchableOpacity>
          <Text style={[typography.heading3, { color: colors.textPrimary }]}>Trusted Contacts</Text>
          <TouchableOpacity onPress={() => setShowAdd((v) => !v)} style={styles.headerBtn}>
            <Icon name={showAdd ? 'x' : 'plus'} size={22} color={colors.textPrimary} />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ padding: screenPadding.default, paddingBottom: 96 }} keyboardShouldPersistTaps="handled">

          {showAdd && (
            <View style={[styles.addCard, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xxl, marginBottom: 16 }]}>
              <Field label="Name" value={name} onChangeText={setName} placeholder="Mom" autoCapitalize="words" />
              <Field label="Email" value={email} onChangeText={setEmail} placeholder="mom@example.com" keyboardType="email-address" />
              <Field label="Phone" value={phone} onChangeText={setPhone} placeholder="555-555-5555" keyboardType="phone-pad" />
              <Field label="Relationship (optional)" value={relationship} onChangeText={setRelationship} placeholder="Mom, Roommate, etc." />
              <GlassButton variant="primary" onPress={add} loading={saving} disabled={!name.trim()}>Add Contact</GlassButton>
            </View>
          )}

          {contacts.length === 0 ? (
            <View style={[styles.emptyCard, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xxl }]}>
              <Icon name="user-plus" size={28} color={colors.textTertiary} />
              <Text style={[typography.body, { color: colors.textSecondary, marginTop: 12, textAlign: 'center' }]}>
                Add at least one contact so SOS works.
              </Text>
            </View>
          ) : (
            contacts.map((c) => (
              <View key={c.id} style={[styles.row, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xl }]}>
                <View style={[styles.avatar, { backgroundColor: colors.navyMidBg }]}>
                  <Text style={[typography.bodyBold, { color: 'white' }]}>{(c.name || '?')[0].toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[typography.bodyBold, { color: colors.textPrimary }]}>{c.name}</Text>
                  <Text style={[typography.bodySmall, { color: colors.textSecondary }]} numberOfLines={1}>
                    {c.email || c.phone}
                    {c.relationship ? ` · ${c.relationship}` : ''}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => remove(c)} style={styles.removeBtn}>
                  <Icon name="trash-2" size={18} color={colors.accentRedText} />
                </TouchableOpacity>
              </View>
            ))
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field({ label, value, onChangeText, placeholder, keyboardType, autoCapitalize = 'none' }) {
  const { colors, typography, radius } = useTheme();
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={[typography.labelBold, { color: colors.textTertiary, marginBottom: 6 }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textTertiary}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        style={[
          styles.input,
          typography.body,
          { backgroundColor: colors.bgInput, borderColor: colors.borderDefault, color: colors.textPrimary, borderRadius: radius.xl },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, paddingBottom: 8 },
  headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  addCard: { padding: 14, borderWidth: 1 },
  input: { paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1 },
  row: { flexDirection: 'row', alignItems: 'center', padding: 12, borderWidth: 1, gap: 12, marginBottom: 8 },
  avatar: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  removeBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  emptyCard: { padding: 32, borderWidth: 1, alignItems: 'center', marginTop: 16 },
});
