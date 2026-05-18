import React, { useRef } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';

import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import AuthNavigator from './AuthNavigator';
import MainTabNavigator from './MainTabNavigator';
import OnboardingScreen from '../screens/auth/OnboardingScreen';
import linking from './linking';
import { trackScreen } from '../services/posthog';

const Stack = createStackNavigator();

// Three states (driven by AuthContext, single source of truth):
//   !user                            → AuthNavigator (login/signup)
//   user && !onboardingComplete      → OnboardingScreen (5-step flow)
//   user && onboardingComplete       → MainTabNavigator

// Walk the navigation state to find the leaf-most route name. React
// Navigation's state is a tree (navigators nesting navigators), so the
// active screen is the leaf of the path of `state.index`/`state.routes`.
function getActiveRouteName(state) {
  if (!state) return null;
  const route = state.routes[state.index];
  if (route.state) return getActiveRouteName(route.state);
  return route.name;
}

export default function RootNavigator() {
  const { user, loading, onboardingComplete } = useAuth();
  const { colors } = useTheme();
  const lastRouteNameRef = useRef(null);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bgPrimary, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color={colors.teal} />
      </View>
    );
  }

  return (
    <NavigationContainer
      linking={linking}
      onStateChange={(state) => {
        // Auto-track screen views to PostHog. Fire-and-forget; never blocks UI.
        const name = getActiveRouteName(state);
        if (name && name !== lastRouteNameRef.current) {
          lastRouteNameRef.current = name;
          trackScreen(name);
        }
      }}
    >
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!user && <Stack.Screen name="Auth" component={AuthNavigator} />}
        {user && !onboardingComplete && (
          <Stack.Screen name="Onboarding" component={OnboardingScreen} />
        )}
        {user && onboardingComplete && (
          <Stack.Screen name="Main" component={MainTabNavigator} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
