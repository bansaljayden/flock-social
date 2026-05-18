import React, { useEffect, useRef } from 'react';
import { StatusBar } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createNavigationContainerRef } from '@react-navigation/native';

import { ThemeProvider, useTheme } from './src/context/ThemeContext';
import { AuthProvider } from './src/context/AuthContext';
import { SocketProvider } from './src/context/SocketContext';
import RootNavigator from './src/navigation/RootNavigator';
import ConnectionBanner from './src/components/common/ConnectionBanner';
import * as PostHog from './src/services/posthog';
import * as GoogleSignInSvc from './src/services/googleSignin';

// We don't actually pass this to RootNavigator yet — RootNavigator owns
// its own NavigationContainer. The ref here is for `notifications.js` so
// it can deep-link from a tap. Phase 6.5 wires it through; for now the
// services are scaffolded but `attachHandlers` waits on RootNavigator
// exposing its container ref (TODO).
export const navigationRef = createNavigationContainerRef();

function ThemedStatusBar() {
  const { isDark, colors } = useTheme();
  return <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.bgPrimary} />;
}

export default function App() {
  // GoogleSignin.configure() must run before LoginScreen/SignupScreen can
  // call signIn() — otherwise idToken comes back null and the backend rejects.
  // PostHog init also runs here; both no-op when their keys aren't set yet.
  useEffect(() => {
    GoogleSignInSvc.init();
    PostHog.init().then(() => {
      PostHog.track(PostHog.Events.AppOpened);
    });
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <AuthProvider>
            <SocketProvider>
              <ThemedStatusBar />
              <RootNavigator />
              <ConnectionBanner />
            </SocketProvider>
          </AuthProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
