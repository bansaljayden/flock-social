import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  ScrollView,
  TouchableOpacity,
  Image,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { launchImageLibrary, launchCamera } from 'react-native-image-picker';
import Animated, { FadeIn, SlideInRight } from 'react-native-reanimated';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import GlassButton from '../../components/common/GlassButton';
import { uploadProfileImage, saveProfileImageUrl, updateProfile } from '../../services/api';

const VIBE_OPTIONS = [
  'Dinner', 'Drinks', 'Movies', 'Sports', 'Coffee',
  'Shopping', 'Outdoors', 'Gaming', 'Study', 'Other',
];

// 5-step onboarding. Each step renders inside an animated container that
// slides in from the right. Progress bar at top indicates advancement.
//
// Step 5 (paywall) is the only step that depends on a service not yet wired
// (RevenueCat — Phase 6). For now it shows the value prop + price and the
// "Subscribe" button is disabled with a "Coming soon" hint. "Maybe Later"
// works and completes onboarding.

export default function OnboardingScreen({ navigation }) {
  const { colors, typography, screenPadding, radius } = useTheme();
  const { user, markOnboardingComplete } = useAuth();

  const [step, setStep] = useState(1);
  const [name, setName] = useState(user?.name || '');
  const [photoUri, setPhotoUri] = useState(user?.profile_image_url || null);
  const [vibes, setVibes] = useState([]);
  const [saving, setSaving] = useState(false);

  const totalSteps = 5;

  const finish = useCallback(async () => {
    // Flips the gate in AuthContext — RootNavigator re-renders into MainTabNavigator.
    await markOnboardingComplete();
  }, [markOnboardingComplete]);

  const goNext = () => setStep((s) => Math.min(totalSteps, s + 1));
  const goBack = () => setStep((s) => Math.max(1, s - 1));

  const saveName = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await updateProfile({ name: name.trim() });
      goNext();
    } catch (e) {
      Alert.alert('Could not save name', e.message);
    } finally {
      setSaving(false);
    }
  };

  const pickPhoto = async (source) => {
    const opts = { mediaType: 'photo', quality: 0.8, includeBase64: false };
    const result = source === 'camera'
      ? await launchCamera(opts)
      : await launchImageLibrary(opts);
    if (result.didCancel || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setSaving(true);
    try {
      const upload = await uploadProfileImage({
        uri: asset.uri,
        type: asset.type || 'image/jpeg',
        name: asset.fileName || 'profile.jpg',
      });
      const url = upload?.url || upload?.image_url;
      if (url) {
        await saveProfileImageUrl(url);
        setPhotoUri(url);
      }
    } catch (e) {
      Alert.alert('Upload failed', e.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleVibe = (v) => {
    setVibes((cur) => cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);
  };

  const saveVibes = async () => {
    // No backend column for vibes yet — when user_settings adds a vibes
    // field this can persist via updateUserSettings({ vibes }). For now
    // selections are kept in component state only.
    goNext();
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]}>
      {/* Progress bar */}
      <View style={[styles.progressTrack, { backgroundColor: colors.bgTertiary, marginHorizontal: screenPadding.loose }]}>
        <View
          style={[
            styles.progressFill,
            { width: `${(step / totalSteps) * 100}%`, backgroundColor: colors.teal },
          ]}
        />
      </View>

      <ScrollView contentContainerStyle={[styles.scroll, { padding: screenPadding.loose }]}>

        {step === 1 && (
          <Animated.View entering={FadeIn.duration(280)}>
            <Text style={[typography.heading1, { color: colors.textPrimary }]}>What should we call you?</Text>
            <Text style={[typography.body, { color: colors.textSecondary, marginTop: 8, marginBottom: 24 }]}>
              This is what your friends will see when you invite them.
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Your first name"
              placeholderTextColor={colors.textTertiary}
              autoFocus
              style={[
                styles.input,
                typography.heading3,
                { backgroundColor: colors.bgInput, borderColor: colors.borderDefault, color: colors.textPrimary, borderRadius: radius.xl },
              ]}
            />
            <View style={{ marginTop: 24 }}>
              <GlassButton variant="primary" onPress={saveName} loading={saving} disabled={!name.trim()}>Continue</GlassButton>
            </View>
          </Animated.View>
        )}

        {step === 2 && (
          <Animated.View entering={SlideInRight.duration(260)}>
            <Text style={[typography.heading1, { color: colors.textPrimary }]}>Add a photo</Text>
            <Text style={[typography.body, { color: colors.textSecondary, marginTop: 8, marginBottom: 24 }]}>
              Help your friends recognize you in chats and on the map.
            </Text>

            <View style={styles.photoBlock}>
              <View style={[styles.avatarPreview, { backgroundColor: colors.bgTertiary, borderColor: colors.borderDefault }]}>
                {photoUri ? (
                  <Image source={{ uri: photoUri }} style={styles.avatarPreview} />
                ) : (
                  <Text style={[typography.heading1, { color: colors.textTertiary }]}>{name?.[0]?.toUpperCase() || '?'}</Text>
                )}
              </View>
            </View>

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 24 }}>
              <View style={{ flex: 1 }}>
                <GlassButton variant="secondary" onPress={() => pickPhoto('camera')} loading={saving}>Camera</GlassButton>
              </View>
              <View style={{ flex: 1 }}>
                <GlassButton variant="secondary" onPress={() => pickPhoto('library')} loading={saving}>Library</GlassButton>
              </View>
            </View>

            <View style={{ marginTop: 12 }}>
              <GlassButton variant="primary" onPress={goNext} disabled={!photoUri && false /* photo optional */}>Continue</GlassButton>
            </View>
            <TouchableOpacity onPress={goNext} style={{ alignSelf: 'center', marginTop: 12 }}>
              <Text style={[typography.bodySmall, { color: colors.textTertiary }]}>Skip for now</Text>
            </TouchableOpacity>
          </Animated.View>
        )}

        {step === 3 && (
          <Animated.View entering={SlideInRight.duration(260)}>
            <Text style={[typography.heading1, { color: colors.textPrimary }]}>Find your friends</Text>
            <Text style={[typography.body, { color: colors.textSecondary, marginTop: 8, marginBottom: 24 }]}>
              We'll match contacts who already use Flock. You can always do this later.
            </Text>
            {/* Phase 5 lands the contacts permission + match flow. For now,
                this step is a deliberate skip to keep onboarding short. */}
            <View style={[styles.placeholderCard, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xxl }]}>
              <Text style={[typography.body, { color: colors.textSecondary, textAlign: 'center' }]}>
                Contacts matching arrives in the Friends update — you'll get a notification when it does.
              </Text>
            </View>
            <View style={{ marginTop: 24 }}>
              <GlassButton variant="primary" onPress={goNext}>Continue</GlassButton>
            </View>
          </Animated.View>
        )}

        {step === 4 && (
          <Animated.View entering={SlideInRight.duration(260)}>
            <Text style={[typography.heading1, { color: colors.textPrimary }]}>What do you do with friends?</Text>
            <Text style={[typography.body, { color: colors.textSecondary, marginTop: 8, marginBottom: 24 }]}>
              Pick a few. We'll use this to suggest spots later.
            </Text>
            <View style={styles.pillRow}>
              {VIBE_OPTIONS.map((v) => {
                const selected = vibes.includes(v);
                return (
                  <TouchableOpacity
                    key={v}
                    onPress={() => toggleVibe(v)}
                    style={[
                      styles.pill,
                      {
                        borderRadius: radius.pill,
                        backgroundColor: selected ? colors.teal + '22' : colors.bgCardSolid,
                        borderColor: selected ? colors.teal : colors.borderDefault,
                      },
                    ]}
                  >
                    <Text style={[typography.bodySmallBold, { color: selected ? colors.teal : colors.textPrimary }]}>{v}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <View style={{ marginTop: 24 }}>
              <GlassButton variant="primary" onPress={saveVibes} disabled={vibes.length === 0}>Continue</GlassButton>
            </View>
            <TouchableOpacity onPress={goNext} style={{ alignSelf: 'center', marginTop: 12 }}>
              <Text style={[typography.bodySmall, { color: colors.textTertiary }]}>Skip</Text>
            </TouchableOpacity>
          </Animated.View>
        )}

        {step === 5 && (
          <Animated.View entering={SlideInRight.duration(260)}>
            <Text style={[typography.heading1, { color: colors.textPrimary }]}>Unlock Flock Premium</Text>
            <Text style={[typography.body, { color: colors.textSecondary, marginTop: 8, marginBottom: 20 }]}>
              Free forever covers the basics. Premium adds the deeper insights.
            </Text>

            <View style={[styles.featureCard, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xxl, gap: 12 }]}>
              {[
                'Unlimited flock history',
                'AI venue recommendations',
                'Advanced crowd analytics',
                'Priority support',
              ].map((f) => (
                <View key={f} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={[styles.bulletDot, { backgroundColor: colors.teal }]} />
                  <Text style={[typography.body, { color: colors.textPrimary }]}>{f}</Text>
                </View>
              ))}
            </View>

            <View style={[styles.priceRow, { gap: 10, marginTop: 16 }]}>
              <View style={[styles.priceCard, { backgroundColor: colors.bgCardSolid, borderColor: colors.borderDefault, borderRadius: radius.xxl }]}>
                <Text style={[typography.label, { color: colors.textTertiary }]}>MONTHLY</Text>
                <Text style={[typography.heading2, { color: colors.textPrimary, marginTop: 4 }]}>$14.99</Text>
                <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>per month</Text>
              </View>
              <View style={[styles.priceCard, { backgroundColor: colors.bgCardSolid, borderColor: colors.teal, borderWidth: 2, borderRadius: radius.xxl }]}>
                <Text style={[typography.labelBold, { color: colors.teal }]}>SAVE 44%</Text>
                <Text style={[typography.heading2, { color: colors.textPrimary, marginTop: 4 }]}>$99.99</Text>
                <Text style={[typography.bodySmall, { color: colors.textSecondary }]}>per year</Text>
              </View>
            </View>

            <View style={{ marginTop: 20 }}>
              {/* RevenueCat purchase wired in Phase 6. For now this is a
                  visible placeholder so the onboarding flow looks complete
                  but doesn't attempt a (broken) purchase. */}
              <GlassButton variant="primary" onPress={() => Alert.alert('Coming soon', 'RevenueCat is wired in Phase 6 of the port.')}>
                Subscribe (coming soon)
              </GlassButton>
              <TouchableOpacity onPress={finish} style={{ alignSelf: 'center', marginTop: 16 }}>
                <Text style={[typography.body, { color: colors.textSecondary }]}>Maybe Later</Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        )}

        {step > 1 && (
          <TouchableOpacity onPress={goBack} style={{ alignSelf: 'flex-start', marginTop: 24 }}>
            <Text style={[typography.bodySmall, { color: colors.textTertiary }]}>← Back</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flexGrow: 1, paddingTop: 32 },
  progressTrack: { height: 4, borderRadius: 2, marginTop: 8, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 2 },
  input: { paddingVertical: 16, paddingHorizontal: 16, borderWidth: 1 },
  photoBlock: { alignItems: 'center', marginTop: 8 },
  avatarPreview: {
    width: 140, height: 140, borderRadius: 70,
    borderWidth: 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  placeholderCard: { borderWidth: 1, padding: 20, alignItems: 'center' },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { paddingVertical: 10, paddingHorizontal: 14, borderWidth: 1.5 },
  featureCard: { borderWidth: 1, padding: 16 },
  bulletDot: { width: 6, height: 6, borderRadius: 3 },
  priceRow: { flexDirection: 'row' },
  priceCard: { flex: 1, padding: 14, borderWidth: 1 },
});
