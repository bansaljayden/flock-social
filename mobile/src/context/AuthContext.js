import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getToken,
  getCurrentUser,
  login as apiLogin,
  signup as apiSignup,
  googleLogin as apiGoogleLogin,
  appleLogin as apiAppleLogin,
  logout as apiLogout,
} from '../services/api';
import { identify, reset, track, Events } from '../services/posthog';
import { clearCache } from '../services/offlineCache';

// Auth state + onboarding gate live together so RootNavigator can switch on a
// single source of truth. The 5-step OnboardingScreen calls
// `markOnboardingComplete()` when the user finishes — that flips the flag
// here and RootNavigator immediately renders MainTabNavigator.

const ONBOARDING_KEY = 'flock_onboarding_completed';

const AuthContext = createContext({
  user: null,
  loading: true,
  onboardingComplete: false,
  login: async () => {},
  signup: async () => {},
  googleLogin: async () => {},
  appleLogin: async () => {},
  logout: async () => {},
  refresh: async () => {},
  markOnboardingComplete: async () => {},
});

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [onboardingComplete, setOnboardingComplete] = useState(false);

  const refresh = useCallback(async () => {
    const token = await getToken();
    if (!token) { setUser(null); return null; }
    try {
      const data = await getCurrentUser();
      const u = data?.user || data || null;
      setUser(u);
      // Identify by pseudonymous id only — no email/name (C3, keeps no-tracking honest)
      if (u?.id) identify(u.id);
      return data;
    } catch {
      setUser(null);
      return null;
    }
  }, []);

  // Initial bootstrap: read token + onboarding flag together.
  useEffect(() => {
    (async () => {
      try {
        const [_, flag] = await Promise.all([
          refresh(),
          AsyncStorage.getItem(ONBOARDING_KEY),
        ]);
        setOnboardingComplete(flag === 'true');
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  const login = useCallback(async (email, password) => {
    const data = await apiLogin(email, password);
    setUser(data.user || null);
    if (data.user?.id) identify(data.user.id);
    track(Events.LoginCompleted, { method: 'email' });
    const flag = await AsyncStorage.getItem(ONBOARDING_KEY);
    if (flag !== 'true') await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
    setOnboardingComplete(true);
    return data;
  }, []);

  const signup = useCallback(async (name, email, password) => {
    const dob = await AsyncStorage.getItem('flock_dob'); // from the C4 age gate
    const data = await apiSignup(name, email, password, dob);
    setUser(data.user || null);
    if (data.user?.id) identify(data.user.id);
    track(Events.SignupCompleted, { method: 'email' });
    setOnboardingComplete(false);
    await AsyncStorage.removeItem(ONBOARDING_KEY);
    return data;
  }, []);

  const googleLogin = useCallback(async (credential) => {
    const dob = await AsyncStorage.getItem('flock_dob'); // from the C4 age gate
    const data = await apiGoogleLogin(credential, dob);
    setUser(data.user || null);
    if (data.user?.id) identify(data.user.id);
    track(Events.LoginCompleted, { method: 'google' });
    const flag = await AsyncStorage.getItem(ONBOARDING_KEY);
    setOnboardingComplete(flag === 'true');
    return data;
  }, []);

  const appleLogin = useCallback(async ({ identityToken, fullName, authorizationCode }) => {
    const dob = await AsyncStorage.getItem('flock_dob'); // from the C4 age gate
    const data = await apiAppleLogin({ identityToken, fullName, authorizationCode, date_of_birth: dob });
    setUser(data.user || null);
    if (data.user?.id) identify(data.user.id);
    track(Events.LoginCompleted, { method: 'apple' });
    const flag = await AsyncStorage.getItem(ONBOARDING_KEY);
    setOnboardingComplete(flag === 'true');
    return data;
  }, []);

  const logout = useCallback(async () => {
    track(Events.LogoutCompleted);
    await apiLogout();
    setUser(null);
    // Reset analytics + clear cached lists so the next user starts clean.
    reset();
    clearCache().catch(() => {});
  }, []);

  const markOnboardingComplete = useCallback(async () => {
    await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
    setOnboardingComplete(true);
    track(Events.OnboardingCompleted);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user, loading, onboardingComplete,
        login, signup, googleLogin, appleLogin, logout, refresh,
        markOnboardingComplete,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
