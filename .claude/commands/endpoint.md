Create a new Express API endpoint for: $ARGUMENTS

Rules:
- Add to the appropriate existing file in backend/routes/ (check what exists first)
- If it needs a new route file, create it and register it in server.js
- Use auth middleware (require('../middleware/auth'))
- Add express-validator input validation on ALL input fields (body, params, query as needed)
- Check validationResult before any logic runs
- Parameterized PostgreSQL queries ONLY — no string concatenation, no template literals with user input
- All async handlers wrapped in try/catch with meaningful error messages
- Use correct HTTP status codes: 200 success, 201 created, 400 validation error, 401 not auth, 403 forbidden, 404 not found, 409 conflict, 500 server error
- Return first validation error message: errors.array()[0].msg
- Follow the exact pattern in CLAUDE.md route pattern section
- Use pool.query() for database calls (const pool = require('../db'))
- Console.error with context on catch blocks
- If the endpoint modifies data another user might see, emit a Socket.io event from backend/socket/handlers.js
