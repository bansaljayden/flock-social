import React from 'react';
import { Platform } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createStackNavigator } from '@react-navigation/stack';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../context/ThemeContext';
import { navShadow } from '../theme/shadows';

// Phase 2: most screens real, a few still stubbed for later phases.
import NestScreen from '../screens/home/NestScreen';
import DiscoverScreen from '../screens/discover/DiscoverScreen';
import FlockListScreen from '../screens/flocks/FlockListScreen';
import DMListScreen from '../screens/chat/DMListScreen';
import DMChatScreen from '../screens/chat/DMChatScreen';
import FlockChatScreen from '../screens/chat/FlockChatScreen';
import ProfileScreen from '../screens/profile/ProfileScreen';
import CheckInScreen from '../screens/checkin/CheckInScreen';
import FlockDetailScreen from '../screens/flocks/FlockDetailScreen';
import JoinFlockScreen from '../screens/flocks/JoinFlockScreen';
import CreateFlockScreen from '../screens/flocks/CreateFlockScreen';
import AddFriendsScreen from '../screens/friends/AddFriendsScreen';
import BudgetSubmitScreen from '../screens/budget/BudgetSubmitScreen';
import BillSplitScreen from '../screens/billing/BillSplitScreen';
import SettleUpScreen from '../screens/billing/SettleUpScreen';
import PaymentSettingsScreen from '../screens/profile/PaymentSettingsScreen';
import NotificationSettingsScreen from '../screens/profile/NotificationSettingsScreen';
import SafetyScreen from '../screens/safety/SafetyScreen';
import TrustedContactsScreen from '../screens/safety/TrustedContactsScreen';
import FriendsScreen from '../screens/friends/FriendsScreen';

const Tab = createBottomTabNavigator();
const Stack = createStackNavigator();

// Each tab gets its own stack so deep navigation pushes don't pop the user
// out of their current tab.

function NestStack() {
  const { colors } = useTheme();
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, cardStyle: { backgroundColor: colors.bgPrimary } }}>
      <Stack.Screen name="Nest" component={NestScreen} />
      <Stack.Screen name="FlockDetail" component={FlockDetailScreen} />
      <Stack.Screen name="FlockChat" component={FlockChatScreen} />
      <Stack.Screen name="CreateFlock" component={CreateFlockScreen} options={{ presentation: 'modal' }} />
      <Stack.Screen name="BudgetSubmit" component={BudgetSubmitScreen} options={{ presentation: 'modal' }} />
      <Stack.Screen name="BillSplit" component={BillSplitScreen} options={{ presentation: 'modal' }} />
      <Stack.Screen name="SettleUp" component={SettleUpScreen} />
      <Stack.Screen name="AddFriends" component={AddFriendsScreen} options={{ presentation: 'modal' }} />
      <Stack.Screen name="JoinFlock" component={JoinFlockScreen} />
      <Stack.Screen name="CheckIn" component={CheckInScreen} />
    </Stack.Navigator>
  );
}

function DiscoverStack() {
  const { colors } = useTheme();
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, cardStyle: { backgroundColor: colors.bgPrimary } }}>
      <Stack.Screen name="Discover" component={DiscoverScreen} />
    </Stack.Navigator>
  );
}

function PlansStack() {
  const { colors } = useTheme();
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, cardStyle: { backgroundColor: colors.bgPrimary } }}>
      <Stack.Screen name="FlockList" component={FlockListScreen} />
      <Stack.Screen name="FlockDetail" component={FlockDetailScreen} />
      <Stack.Screen name="FlockChat" component={FlockChatScreen} />
      <Stack.Screen name="CreateFlock" component={CreateFlockScreen} options={{ presentation: 'modal' }} />
      <Stack.Screen name="BudgetSubmit" component={BudgetSubmitScreen} options={{ presentation: 'modal' }} />
      <Stack.Screen name="BillSplit" component={BillSplitScreen} options={{ presentation: 'modal' }} />
      <Stack.Screen name="SettleUp" component={SettleUpScreen} />
    </Stack.Navigator>
  );
}

function MessagesStack() {
  const { colors } = useTheme();
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, cardStyle: { backgroundColor: colors.bgPrimary } }}>
      <Stack.Screen name="DMList" component={DMListScreen} />
      <Stack.Screen name="DMChat" component={DMChatScreen} />
    </Stack.Navigator>
  );
}

function YouStack() {
  const { colors } = useTheme();
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, cardStyle: { backgroundColor: colors.bgPrimary } }}>
      <Stack.Screen name="Profile" component={ProfileScreen} />
      <Stack.Screen name="PaymentSettings" component={PaymentSettingsScreen} />
      <Stack.Screen name="NotificationSettings" component={NotificationSettingsScreen} />
      <Stack.Screen name="Safety" component={SafetyScreen} />
      <Stack.Screen name="TrustedContacts" component={TrustedContactsScreen} />
      <Stack.Screen name="Friends" component={FriendsScreen} />
      <Stack.Screen name="AddFriends" component={AddFriendsScreen} />
      <Stack.Screen name="DMChat" component={DMChatScreen} />
    </Stack.Navigator>
  );
}

export default function MainTabNavigator() {
  const { colors, isDark } = useTheme();
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.bgNav,
          borderTopColor: colors.borderSubtle,
          borderTopWidth: Platform.OS === 'ios' ? 0.5 : 1,
          ...navShadow(colors),
        },
        tabBarActiveTintColor: colors.teal,
        tabBarInactiveTintColor: colors.textTertiary,
        tabBarLabelStyle: { fontFamily: 'Satoshi-Medium', fontSize: 10, marginBottom: 4 },
        tabBarIcon: ({ color, size }) => {
          const iconName = {
            NestTab: 'home',
            DiscoverTab: 'map',
            PlansTab: 'calendar',
            MessagesTab: 'message-circle',
            YouTab: 'user',
          }[route.name] || 'circle';
          return <Icon name={iconName} size={size} color={color} />;
        },
      })}
    >
      <Tab.Screen name="NestTab" component={NestStack} options={{ title: 'Nest' }} />
      <Tab.Screen name="DiscoverTab" component={DiscoverStack} options={{ title: 'Discover' }} />
      <Tab.Screen name="PlansTab" component={PlansStack} options={{ title: 'Plans' }} />
      <Tab.Screen name="MessagesTab" component={MessagesStack} options={{ title: 'Messages' }} />
      <Tab.Screen name="YouTab" component={YouStack} options={{ title: 'You' }} />
    </Tab.Navigator>
  );
}
