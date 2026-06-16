import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TouchableOpacity,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';
import appleAuth, { AppleButton } from '@invertase/react-native-apple-authentication';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import GlassButton from '../../components/common/GlassButton';
import { TERMS_URL, GUIDELINES_URL } from '../../config/links';

const TERMS_REQUIRED_MSG = 'Please agree to the Terms and Community Guidelines to continue.';

// Validation matches the backend rules in routes/auth.js:
//   - email: valid format
//   - password: 8+ chars, ≥1 uppercase, ≥1 digit
//   - name: 1-255 chars

function validatePassword(p) {
  if (!p || p.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(p)) return 'Password must contain an uppercase letter';
  if (!/[0-9]/.test(p)) return 'Password must contain a number';
  return null;
}

function validateEmail(e) {
  if (!e) return 'Email required';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 'Valid email required';
  return null;
}

export default function SignupScreen({ navigation }) {
  const { colors, typography, screenPadding, radius } = useTheme();
  const { signup, googleLogin, appleLogin } = useAuth();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [agreed, setAgreed] = useState(false);

  const handleSignup = async () => {
    if (!agreed) { setError(TERMS_REQUIRED_MSG); return; }
    if (!name.trim()) { setError('Name required'); return; }
    const emailErr = validateEmail(email.trim());
    if (emailErr) { setError(emailErr); return; }
    const pwErr = validatePassword(password);
    if (pwErr) { setError(pwErr); return; }

    setLoading(true); setError('');
    try {
      await signup(name.trim(), email.trim(), password);
      // RootNavigator routes to OnboardingScreen automatically because
      // AuthContext.signup sets onboardingComplete=false for new users.
    } catch (e) {
      setError(e.message || 'Signup failed');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    if (!agreed) { setError(TERMS_REQUIRED_MSG); return; }
    setLoading(true); setError('');
    try {
      await GoogleSignin.hasPlayServices();
      const { data } = await GoogleSignin.signIn();
      const idToken = data?.idToken;
      if (!idToken) throw new Error('No Google ID token returned');
      await googleLogin(idToken);
      // Routing handled by AuthContext + RootNavigator.
    } catch (e) {
      if (e.code !== statusCodes.SIGN_IN_CANCELLED) setError(e.message || 'Google sign-in failed');
    } finally {
      setLoading(false);
    }
  };

  const handleApple = async () => {
    if (!agreed) { setError(TERMS_REQUIRED_MSG); return; }
    setLoading(true); setError('');
    try {
      const res = await appleAuth.performRequest({
        requestedOperation: appleAuth.Operation.LOGIN,
        requestedScopes: [appleAuth.Scope.EMAIL, appleAuth.Scope.FULL_NAME],
      });
      const { identityToken, fullName } = res;
      if (!identityToken) throw new Error('Apple did not return an identity token');
      await appleLogin({
        identityToken,
        fullName: fullName ? { givenName: fullName.givenName, familyName: fullName.familyName } : null,
      });
    } catch (e) {
      if (e.code !== appleAuth.Error.CANCELED) setError(e.message || 'Apple sign-in failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={[styles.scroll, { padding: screenPadding.loose }]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.heroBlock}>
            <Text style={[typography.heading1, { color: colors.textPrimary }]}>Create your Flock</Text>
            <Text style={[typography.body, { color: colors.textSecondary, marginTop: 6 }]}>
              Plan with friends in fewer messages.
            </Text>
          </View>

          <View style={[styles.formBlock, { gap: 12 }]}>
            <View>
              <Text style={[typography.labelBold, { color: colors.textTertiary, marginBottom: 6 }]}>Name</Text>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="Jayden"
                placeholderTextColor={colors.textTertiary}
                autoCapitalize="words"
                autoCorrect={false}
                returnKeyType="next"
                style={[styles.input, typography.body, { backgroundColor: colors.bgInput, borderColor: colors.borderDefault, color: colors.textPrimary, borderRadius: radius.xl }]}
              />
            </View>
            <View>
              <Text style={[typography.labelBold, { color: colors.textTertiary, marginBottom: 6 }]}>Email</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="you@example.com"
                placeholderTextColor={colors.textTertiary}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                returnKeyType="next"
                style={[styles.input, typography.body, { backgroundColor: colors.bgInput, borderColor: colors.borderDefault, color: colors.textPrimary, borderRadius: radius.xl }]}
              />
            </View>
            <View>
              <Text style={[typography.labelBold, { color: colors.textTertiary, marginBottom: 6 }]}>Password</Text>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="8+ chars, 1 uppercase, 1 number"
                placeholderTextColor={colors.textTertiary}
                secureTextEntry
                returnKeyType="go"
                onSubmitEditing={handleSignup}
                style={[styles.input, typography.body, { backgroundColor: colors.bgInput, borderColor: colors.borderDefault, color: colors.textPrimary, borderRadius: radius.xl }]}
              />
            </View>

            {/* Terms/EULA acceptance gate (Apple 1.2 / Google UGC). Required for
                ALL signup methods. The zero-tolerance line is the EULA language
                Apple's Resolution Center expects to see at the agreement point. */}
            <TouchableOpacity
              onPress={() => setAgreed((a) => !a)}
              activeOpacity={0.7}
              style={styles.termsRow}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: agreed }}
            >
              <View style={[styles.checkbox, { borderColor: agreed ? colors.teal : colors.borderDefault, backgroundColor: agreed ? colors.teal : 'transparent' }]}>
                {agreed ? <Text style={styles.checkmark}>✓</Text> : null}
              </View>
              <Text style={[typography.bodySmall, { color: colors.textSecondary, flex: 1 }]}>
                I agree to Flock's{' '}
                <Text style={{ color: colors.teal }} onPress={() => Linking.openURL(TERMS_URL)}>Terms of Service</Text>
                {' '}and{' '}
                <Text style={{ color: colors.teal }} onPress={() => Linking.openURL(GUIDELINES_URL)}>Community Guidelines</Text>
                . Flock has zero tolerance for objectionable content or abusive users.
              </Text>
            </TouchableOpacity>

            {error ? (
              <Text style={[typography.bodySmall, { color: colors.accentRedText }]}>{error}</Text>
            ) : null}

            <GlassButton variant="primary" onPress={handleSignup} loading={loading}>
              Create Account
            </GlassButton>
          </View>

          <View style={[styles.dividerRow, { marginVertical: 24 }]}>
            <View style={[styles.dividerLine, { backgroundColor: colors.borderDefault }]} />
            <Text style={[typography.label, { color: colors.textTertiary, marginHorizontal: 10 }]}>OR</Text>
            <View style={[styles.dividerLine, { backgroundColor: colors.borderDefault }]} />
          </View>

          <View style={{ gap: 10 }}>
            <GlassButton variant="secondary" onPress={handleGoogle} disabled={loading}>
              Continue with Google
            </GlassButton>
            {Platform.OS === 'ios' && appleAuth.isSupported && (
              <AppleButton
                buttonStyle={AppleButton.Style.WHITE}
                buttonType={AppleButton.Type.SIGN_UP}
                style={{ width: '100%', height: 50, borderRadius: radius.xl }}
                onPress={handleApple}
              />
            )}
          </View>

          <TouchableOpacity onPress={() => navigation.navigate('Login')} style={{ marginTop: 32, alignSelf: 'center' }}>
            <Text style={[typography.body, { color: colors.textSecondary }]}>
              Already have an account? <Text style={{ color: colors.teal, fontFamily: typography.bodyBold.fontFamily }}>Log in</Text>
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center' },
  heroBlock: { marginBottom: 24 },
  formBlock: {},
  input: { paddingVertical: 14, paddingHorizontal: 14, borderWidth: 1 },
  termsRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 4 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  checkmark: { color: '#fff', fontSize: 14, fontWeight: '700', lineHeight: 16 },
  dividerRow: { flexDirection: 'row', alignItems: 'center' },
  dividerLine: { flex: 1, height: 1 },
});
