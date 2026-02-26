# FLOCK SECURITY REQUIREMENTS

## ALL CODE MUST FOLLOW THESE RULES:

### Secrets & Credentials
- ✅ All API keys in environment variables (.env)
- ✅ Never hardcode secrets in code
- ✅ .env files in .gitignore
- ✅ Separate keys for dev/production

### Authentication & Authorization
- ✅ All API routes check JWT token
- ✅ Users can ONLY access their own data
- ✅ Verify user owns resource before returning
- ✅ No admin endpoints without admin check

### Input Validation
- ✅ Validate ALL user inputs server-side
- ✅ Sanitize strings (prevent XSS)
- ✅ Validate types, lengths, formats
- ✅ Reject unexpected data

### Database Security
- ✅ ALWAYS use parameterized queries
- ✅ NEVER concatenate SQL strings
- ✅ Limit query results (prevent data dumps)
- ✅ Index sensitive queries

### Rate Limiting
- ✅ Auth endpoints: 5 attempts/min per IP
- ✅ API endpoints: 100 requests/min per user
- ✅ Venue search: 20 requests/min
- ✅ WebSocket connections: 10/min per IP

### Password Security
- ✅ Hash with bcrypt (10+ rounds)
- ✅ Never store plaintext
- ✅ No password in logs
- ✅ Require minimum 8 characters

### CORS & Headers
- ✅ Explicit origin whitelist (no *)
- ✅ Content-Security-Policy header
- ✅ X-Content-Type-Options: nosniff
- ✅ X-Frame-Options: DENY

### Logging
- ✅ Log failed auth attempts
- ✅ Include timestamp + IP
- ✅ Never log passwords or tokens
- ✅ Rotate logs regularly

### File Uploads (Future)
- ✅ Validate file type
- ✅ Limit file size (5MB max)
- ✅ Scan for malware
- ✅ Store outside web root