// Sentry initialization (B3).
// Must be required BEFORE any other module in server.js so the SDK can
// auto-instrument HTTP/Express. This is a no-op until SENTRY_DSN is set
// (provide it via Railway env / backend .env — never commit the DSN).
require('dotenv').config();
const Sentry = require('@sentry/node');

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
  });
  console.log('Sentry initialized');
}
