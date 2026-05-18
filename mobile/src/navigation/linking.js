// React Navigation deep-link config. Maps Universal Links to screens.
//
// Universal Link prerequisite (must land before this works in production):
//   - flockcorp.com DNS pointed at Vercel
//   - apple-app-site-association JSON served from
//     https://flockcorp.com/.well-known/apple-app-site-association
//   - iOS associated-domains capability: applinks:flockcorp.com
//
// Until DNS is pointed, only the `flock://` custom-scheme prefix works
// for development testing.

// Deep-link targets must be nested all the way down to the screen that
// actually owns them. CheckIn / FlockDetail / JoinFlock live inside the
// NestStack which is the component for the NestTab tab — so the path is
// Main -> NestTab -> <screen>. Declaring them directly under Main fails
// silently: the app opens but the navigator can't find the route.
const linking = {
  prefixes: ['https://flockcorp.com', 'flock://'],
  config: {
    initialRouteName: 'Main',
    screens: {
      // Auth flow (rare to hit a deep link before login, but covered)
      Login: 'login',
      Signup: 'signup',

      // Public deep targets — nested inside NestTab so the route resolves
      Main: {
        screens: {
          NestTab: {
            screens: {
              // NFC tag tap — flockcorp.com/checkin/<placeId>
              CheckIn: 'checkin/:placeId',
              // Flock invite link — flockcorp.com/flock/<flockId>
              FlockDetail: 'flock/:flockId',
              // Join via code — flockcorp.com/invite/<code>
              JoinFlock: 'invite/:code',
            },
          },
        },
      },
    },
  },
};

export default linking;
