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
  Alert,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';
import appleAuth, { AppleButton } from '@invertase/react-native-apple-authentication';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import GlassButton from '../../components/common/GlassButton';
import { TERMS_URL, GUIDELINES_URL } from '../../config/links';

export default function LoginScreen({ navigation }) {
  const { colors, typography, screenPadding, radius } = useTheme();
  const { login, googleLogin, appleLogin } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleEmailLogin = async () => {
    if (!email || !password) { setError('Email and password required'); return; }
    setLoading(true); setError('');
    try {
      await login(email.trim(), password);
      // RootNavigator switches automatically on user state change
    } catch (e) {
      setError(e.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setLoading(true); setError('');
    try {
      await GoogleSignin.hasPlayServices();
      const { data } = await GoogleSignin.signIn();
      const idToken = data?.idToken;
      if (!idToken) throw new Error('No Google ID token returned');
      await googleLogin(idToken);
    } catch (e) {
      if (e.code === statusCodes.SIGN_IN_CANCELLED) { /* user cancelled */ }
      else setError(e.message || 'Google sign-in failed');
    } finally {
      setLoading(false);
    }
  };

  const handleApple = async () => {
    setLoading(true); setError('');
    try {
      const res = await appleAuth.performRequest({
        requestedOperation: appleAuth.Operation.LOGIN,
        // Only ask for what you'll actually use. EMAIL is required so we can
        // create users on first sign-in. FULL_NAME only arrives the first time.
        requestedScopes: [appleAuth.Scope.EMAIL, appleAuth.Scope.FULL_NAME],
      });

      const { identityToken, fullName, authorizationCode } = res;
      if (!identityToken) throw new Error('Apple did not return an identity token');

      await appleLogin({
        identityToken,
        authorizationCode,
        fullName: fullName ? { givenName: fullName.givenName, familyName: fullName.familyName } : null,
      });
    } catch (e) {
      if (e.code === appleAuth.Error.CANCELED) { /* user cancelled */ }
      else setError(e.message || 'Apple sign-in failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={[styles.scroll, { padding: screenPadding.loose }]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.heroBlock}>
            <Text style={[typography.display, { color: colors.textPrimary }]}>Flock</Text>
            <Text style={[typography.body, { color: colors.textSecondary, marginTop: 6 }]}>
              Welcome back. Sign in to keep planning.
            </Text>
          </View>

          <View style={[styles.formBlock, { gap: 12 }]}>
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
                style={[
                  styles.input,
                  typography.body,
                  {
                    backgroundColor: colors.bgInput,
                    borderColor: colors.borderDefault,
                    color: colors.textPrimary,
                    borderRadius: radius.xl,
                  },
                ]}
              />
            </View>
            <View>
              <Text style={[typography.labelBold, { color: colors.textTertiary, marginBottom: 6 }]}>Password</Text>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="••••••••"
                placeholderTextColor={colors.textTertiary}
                secureTextEntry
                returnKeyType="go"
                onSubmitEditing={handleEmailLogin}
                style={[
                  styles.input,
                  typography.body,
                  {
                    backgroundColor: colors.bgInput,
                    borderColor: colors.borderDefault,
                    color: colors.textPrimary,
                    borderRadius: radius.xl,
                  },
                ]}
              />
            </View>

            {error ? (
              <Text style={[typography.bodySmall, { color: colors.accentRedText }]}>{error}</Text>
            ) : null}

            <GlassButton variant="primary" onPress={handleEmailLogin} loading={loading}>
              Login
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
                buttonType={AppleButton.Type.SIGN_IN}
                style={{ width: '100%', height: 50, borderRadius: radius.xl }}
                onPress={handleApple}
              />
            )}
          </View>

          {/* Sign-in with Google/Apple can create an account on first use, so the
              agreement notice belongs here too (Apple 1.2 / Google UGC). */}
          <Text style={[typography.bodySmall, { color: colors.textTertiary, textAlign: 'center', marginTop: 16, paddingHorizontal: 8 }]}>
            By continuing, you agree to our{' '}
            <Text style={{ color: colors.teal }} onPress={() => Linking.openURL(TERMS_URL)}>Terms</Text>
            {' '}and{' '}
            <Text style={{ color: colors.teal }} onPress={() => Linking.openURL(GUIDELINES_URL)}>Community Guidelines</Text>.
          </Text>

          <TouchableOpacity onPress={() => navigation.navigate('Signup')} style={{ marginTop: 32, alignSelf: 'center' }}>
            <Text style={[typography.body, { color: colors.textSecondary }]}>
              Don't have an account? <Text style={{ color: colors.teal, fontFamily: typography.bodyBold.fontFamily }}>Sign up</Text>
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
  heroBlock: { marginBottom: 32 },
  formBlock: {},
  input: {
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderWidth: 1,
  },
  dividerRow: { flexDirection: 'row', alignItems: 'center' },
  dividerLine: { flex: 1, height: 1 },
});
