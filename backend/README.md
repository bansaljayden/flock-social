# Flock Backend

Real-time backend API for the Flock social coordination app. Built with Node.js, Express, PostgreSQL, and Socket.io.

## Tech Stack

- **Runtime:** Node.js (>=18)
- **Framework:** Express
- **Database:** PostgreSQL
- **Real-time:** Socket.io
- **Auth:** JWT + bcrypt
- **Validation:** express-validator

## Setup

### 1. Install dependencies

```bash
cd backend
npm install
```

### 2. Configure environment

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret key for signing JWTs (use a long random string) |
| `PORT` | Server port (default: 5000) |
| `NODE_ENV` | `development` or `production` |
| `FRONTEND_URL` | Frontend origin for CORS (default: `http://localhost:3000`) |

### 3. Initialize the database

Run the schema against your PostgreSQL instance:

```bash
psql $DATABASE_URL -f database/schema.sql
```

Or paste the contents of `database/schema.sql` into your Railway PostgreSQL console.

### 4. Create the uploads directory

```bash
mkdir uploads
```

### 5. Run locally

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

The server starts on `http://localhost:5000`.

## Deploying to Railway

1. Create a new project on [Railway](https://railway.app)
2. Add a PostgreSQL plugin and copy the `DATABASE_URL`
3. Connect your GitHub repo and set the root directory to `backend/`
4. Add environment variables in the Railway dashboard:
   - `DATABASE_URL` (auto-provided by the PostgreSQL plugin)
   - `JWT_SECRET`
   - `NODE_ENV=production`
   - `FRONTEND_URL` (your deployed frontend URL)
5. Run `database/schema.sql` against the Railway PostgreSQL instance
6. Deploy

## API Endpoints

### Auth
| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/signup` | Create account |
| POST | `/api/auth/login` | Login |
| GET | `/api/auth/me` | Get current user |
| POST | `/api/auth/logout` | Logout |

### Flocks
| Method | Path | Description |
|---|---|---|
| GET | `/api/flocks` | List user's flocks |
| POST | `/api/flocks` | Create flock |
| GET | `/api/flocks/:id` | Get flock details |
| PUT | `/api/flocks/:id` | Update flock |
| DELETE | `/api/flocks/:id` | Delete flock |
| POST | `/api/flocks/:id/join` | Join flock |
| POST | `/api/flocks/:id/leave` | Leave flock |
| GET | `/api/flocks/:id/members` | Get members |

### Messages
| Method | Path | Description |
|---|---|---|
| GET | `/api/flocks/:id/messages` | Get flock messages |
| POST | `/api/flocks/:id/messages` | Send message |
| POST | `/api/messages/:id/react` | Add emoji reaction |
| DELETE | `/api/messages/:id/react/:emoji` | Remove reaction |

### Direct Messages
| Method | Path | Description |
|---|---|---|
| GET | `/api/dm/:userId` | Get conversation |
| POST | `/api/dm/:userId` | Send DM |
| PUT | `/api/dm/:messageId/read` | Mark as read |

### Users
| Method | Path | Description |
|---|---|---|
| GET | `/api/users/profile` | Get profile |
| PUT | `/api/users/profile` | Update profile |
| GET | `/api/users/search?q=` | Search users |
| POST | `/api/users/upload-image` | Upload profile image |

### Venues
| Method | Path | Description |
|---|---|---|
| POST | `/api/flocks/:id/vote` | Vote for venue |
| GET | `/api/flocks/:id/votes` | Get vote counts |

### Health
| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Health check |

## WebSocket Events

Connect with Socket.io and pass your JWT token:

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:5000', {
  auth: { token: 'your-jwt-token' }
});
```

### Client to Server
| Event | Payload | Description |
|---|---|---|
| `join_flock` | `flockId` | Join a flock room |
| `leave_flock` | `flockId` | Leave a flock room |
| `send_message` | `{ flockId, message_text, ... }` | Send real-time message |
| `typing` | `flockId` | Typing indicator |
| `stop_typing` | `flockId` | Stop typing |
| `vote_venue` | `{ flockId, venue_name, venue_id }` | Vote for venue |
| `update_location` | `{ flockId, lat, lng }` | Share location |
| `select_venue` | `{ flockId, venue_name, ... }` | Confirm venue (creator only) |
| `crowd_update` | `{ venue_id, level }` | Update crowd level |

### Server to Client
| Event | Description |
|---|---|
| `new_message` | New message in flock |
| `user_typing` | Someone is typing |
| `user_stopped_typing` | Someone stopped typing |
| `member_joined` | User came online in flock |
| `member_left` | User went offline |
| `new_vote` | New venue vote |
| `venue_selected` | Venue confirmed |
| `location_update` | Friend location update |
| `crowd_update` | Live crowd level |
| `room_members` | Current online members |
