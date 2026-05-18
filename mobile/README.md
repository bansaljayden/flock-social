# Flock — React Native (iOS + Android)

The native client for [Flock](https://flockcorp.com). Hits the same Express + Socket.io backend as the web app at `flock-app-production.up.railway.app`. The web app at `flock-app-w65m.vercel.app` and the marketing site at `frontend/src/website/` continue to exist; this is a separate native codebase.

## What's in this directory

The source is checked in but the iOS/Android native projects + `node_modules` are not. You need to run a one-time scaffold to generate them.

```
mobile/
├── package.json            # all dependencies — install before scaffolding
├── index.js                # RN entry point
├── App.js                  # root provider tree (Theme + Auth + Socket + Navigation)
└── src/
    ├── theme/              # colors, typography, spacing, shadows, glass styles
    ├── services/           # api.js, socket.js, firebase.js, etc. (ported from web)
    ├── context/            # AuthContext, ThemeContext, SocketContext
    ├── navigation/         # RootNavigator + AuthNavigator + MainTabNavigator + linking
    ├── hooks/              # useAuth, useSocket, useLocation, etc.
    ├── utils/              # format, validation
    ├── screens/            # all screens (auth/, home/, flocks/, chat/, discover/, ...)
    ├── components/         # reusable UI (common/, chat/, crowd/, flock/, venue/)
    └── assets/             # fonts (Satoshi), images (icon, splash)
```

## One-time setup (run on your Mac)

```bash
cd /path/to/flock-app/mobile

# 1. Generate the iOS + Android native shells. This creates ios/ and android/.
#    DO NOT delete the existing src/, App.js, index.js, package.json — only the
#    generated native projects matter.
npx @react-native-community/cli init Flock --skip-install --pm npm

# 2. Install JS deps (already declared in package.json)
npm install

# 3. iOS: install CocoaPods
cd ios && pod install && cd ..

# 4. Run on iOS simulator
npx react-native run-ios

# 5. Run on Android emulator (need Android Studio + an AVD)
npx react-native run-android
```

If `react-native init` overwrites `package.json`, restore the version in this repo (it has all the deps the project needs).

## Environment

Set these in `mobile/.env` (use `react-native-config` to read them):

```
API_URL=https://flock-app-production.up.railway.app
SOCKET_URL=https://flock-app-production.up.railway.app
GOOGLE_MAPS_API_KEY=...        # for Android maps
REVENUECAT_API_KEY_IOS=...
REVENUECAT_API_KEY_ANDROID=...
POSTHOG_API_KEY=...
POSTHOG_HOST=https://us.i.posthog.com
```

## Build phases

See `C:/Users/Jayden/.claude/plans/mighty-doodling-metcalfe.md` for the full plan. Currently in Phase 1 (Foundation).

## Backend changes that go alongside this port

One small backend addition:
- `POST /api/auth/apple` — Sign in with Apple. Verify Apple identity token via JWKS, upsert user, issue Flock JWT. Mirrors the existing `/api/auth/google` route.
