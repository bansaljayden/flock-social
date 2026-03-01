# Flock — Social Coordination App

## What This Is
Flock is a social coordination app for Gen Z (ages 15–22). It replaces the broken group chat planning process with structured coordination: create a flock → invite friends → RSVP → vote on venues → match budgets anonymously → confirm → go.

Flock is NOT a messaging app, calendar app, bill splitter, social media feed, or venue discovery app. Chat and venues serve coordination — they are not standalone features.

## Tech Stack (FINAL — do not suggest alternatives)
- **Frontend:** React 19.x (Create React App) deployed on Vercel
- **Backend:** Node.js + Express deployed on Railway
- **Database:** PostgreSQL (Railway-hosted)
- **Real-time:** Socket.io WebSockets
- **Auth:** JWT (access token, 24h expiry)
- **External APIs:** Google Places API (venues), Resend (email), OpenWeatherMap (crowd engine)
- **Push notifications:** Firebase Cloud Messaging (future)

Do not suggest Firebase, Supabase, Django, Flask, or any other stack replacement.

## Project Structure
```
flock-app/
├── frontend/
│   ├── src/
│   │   ├── App.js              # Monolithic (~9,900 lines — all UI)
│   │   ├── LoginScreen.js
│   │   ├── SignupScreen.js
│   │   ├── services/
│   │   │   ├── api.js           # REST client (axios)
│   │   │   └── socket.js        # Socket.io client
│   │   ├── context/
│   │   │   └── ThemeContext.js   # Dark/light mode
│   │   └── utils/
│   │       └── finance.js       # Revenue calculations
│   └── .env                     # REACT_APP_GOOGLE_MAPS_API_KEY
├── backend/
│   ├── server.js                # Entry point (Express + Socket.io)
│   ├── routes/
│   │   ├── auth.js
│   │   ├── flocks.js
│   │   ├── messages.js          # Flock messages + DMs
│   │   ├── users.js
│   │   ├── friends.js
│   │   ├── safety.js
│   │   ├── venueSearch.js
│   │   ├── venues.js
│   │   └── stories.js
│   ├── services/
│   │   ├── crowdEngine.js       # AI crowd scoring
│   │   └── weatherService.js    # OpenWeatherMap wrapper
│   ├── middleware/
│   │   └── auth.js              # JWT verification
│   ├── socket/
│   │   └── handlers.js          # All Socket.io events
│   └── .env                     # DATABASE_URL, JWT_SECRET, API keys
```

## Database Schema (Production)

### Existing Tables
- `users` — id (UUID), username, email, password_hash, display_name, avatar_url, phone, friend_code (VARCHAR 8), reliability_score, total_plans_joined, total_plans_attended, role (user/venue_owner/admin)
- `friendships` — user_id, friend_id, status (pending/accepted/declined)
- `flocks` — id (UUID), creator_id, title, description, venue_name, venue_address, date, time, status (active/confirmed/completed/cancelled), max_members
- `flock_members` — flock_id, user_id, status (invited/accepted/declined)
- `messages` — flock_id, sender_id, content, message_type (text/venue_card/image), venue_data (JSONB), image_url
- `emoji_reactions` — message_id, user_id, emoji. UNIQUE(message_id, user_id, emoji)
- `venue_votes` — flock_id, user_id, venue_name, venue_data (JSONB). UNIQUE(flock_id, user_id)
- `direct_messages` — sender_id, receiver_id, content, message_type, venue_data, image_url, reply_to_id, read
- `dm_emoji_reactions` — message_id, user_id, emoji
- `dm_venue_votes` — sender_id, receiver_id, message_id, vote (up/down)
- `dm_pinned_venues` — user_id, other_user_id, venue_data (JSONB)
- `stories` — user_id, content, image_url, expires_at
- `trusted_contacts` — user_id, name, phone, email, relationship
- `emergency_alerts` — user_id, latitude, longitude, message, contacts_notified (JSONB)

### Tables Not Yet Created
- `budget_submissions` — flock_id, user_id, amount, skipped, UNIQUE(flock_id, user_id)
- `venues` — google_place_id (UNIQUE), name, address, lat/lng, price_level, estimated_cost_per_person, category, photo_url, rating
- `notifications` — user_id, type, flock_id, from_user_id, content, read
- `research_analytics` — flock_id, group_size, budget_enabled, budget_ceiling, submission_count, skip_count, flock_completed, venue_price_level_selected, time_to_confirmation, stall_point

## Coding Standards (Enforce on EVERY file)

### Non-Negotiable
1. **No hardcoded secrets.** All API keys, JWT secrets, database URLs use environment variables. Never commit .env.
2. **Parameterized queries only.** No string concatenation or template literals with user input in SQL. Ever.
3. **try/catch on every async function.** Meaningful error responses. Never let unhandled rejections crash the server.
4. **Input validation before controller logic.** Use express-validator. Never trust client data.
5. **Correct HTTP status codes.** 200 success, 201 created, 400 bad request, 401 not authenticated, 403 forbidden, 404 not found, 409 conflict, 500 server error.

### Route Pattern (follow exactly)
```javascript
const router = require('express').Router();
const auth = require('../middleware/auth');
const { body, param, query, validationResult } = require('express-validator');
const pool = require('../db');

router.post('/', auth, [
  body('field').notEmpty().withMessage('Field is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }
    const result = await pool.query(
      'INSERT INTO table (col) VALUES ($1) RETURNING *',
      [req.body.field]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
```

### Security (Already Implemented)
- Rate limiting: auth 5/min, API 300/15min
- CORS: flock-app*.vercel.app origins only
- Helmet.js security headers
- bcrypt password hashing
- XSS protection / input sanitization
- Database connection pooling

## Socket.io Architecture
Each flock = room `flock:{flockId}`. Each user = room `user:{userId}` for DMs/notifications.

Key events: join_flock, leave_flock, send_message, new_message, typing, stop_typing, vote_venue, new_vote, select_venue, venue_selected, update_location, location_update, dm_send_message, dm_new_message, flock_invite, friend_request.

## Environment Variables

**Frontend (.env / Vercel dashboard):**
- REACT_APP_GOOGLE_MAPS_API_KEY

**Backend (.env / Railway dashboard):**
- DATABASE_URL, JWT_SECRET, GOOGLE_PLACES_API_KEY, RESEND_API_KEY, WEATHER_API_KEY, PORT, NODE_ENV, FRONTEND_URL

Two separate Google API keys: frontend (browser-restricted) and backend (server-restricted).

## What's Built vs Not Built

**Working end-to-end:** Auth, flock CRUD, flock chat (text/image/venue cards), emoji reactions, typing indicators, venue voting, RSVP, Google Places integration, friend system (QR codes, phone discovery), DMs (full featured), location sharing, stories, safety/emergency (SOS + email), dark mode, user profiles, user search.

**Not yet built:** Anonymous budget matching, anti-flake reliability scoring, AI crowd forecasting, push notifications, dashboard backends (revenue sim, venue owner, admin), research analytics layer, post-hangout feedback.

## Key Design Decisions
- Frontend is monolithic App.js (~9,900 lines). Known tech debt. Do not refactor unless explicitly asked.
- Budget matching privacy is non-negotiable: client NEVER receives individual budget amounts. Only aggregate: { ceiling, submissionCount, isReady, skipCount }.
- Crowd intelligence is rule-based scoring (not ML). Weighted multi-factor algorithm using Google Places data + weather + time context.
- All timestamps use TIMESTAMPTZ. UUIDs for core entity PKs, SERIAL for junction/log tables.
