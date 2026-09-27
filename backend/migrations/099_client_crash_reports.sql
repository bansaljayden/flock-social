-- 099: crash reports a person chose to send from the app's crash screen.
--
-- ASCII only, like 065, 082 and 091 to 096: the embedded server the
-- boot-safety suite runs is WIN1252.
--
-- WHY. The crash screen (frontend/src/components/ErrorBoundary.js) logged to a
-- WebView console nobody can read, and Sentry is off on purpose, because
-- turning it on means answering yes to Crash Data in App Store Connect and
-- rewriting the privacy policy. A report the user sends by pressing a button,
-- each time, is data they chose to give us, so a crash on a phone can reach
-- the operator the same day without that switch.
--
-- WHAT A ROW HOLDS, AND WHAT IT DOES NOT. The boundary that caught the crash,
-- the error's name, its message (clamped to 200 characters with addresses,
-- tokens and coordinates blanked by the client and again by the route), up to
-- eight React component names from the component stack, the build, and native
-- or web. No account id, no user id, no IP address, no device id: the route
-- never reads the Authorization header and nothing here could hold one.
--
-- ONE ROW PER CRASH SHAPE PER DAY. fingerprint is a hash of the boundary, the
-- error name and the top component, and (fingerprint, seen_on) is unique, so
-- a crash a hundred people send is one row with reports = 100. That keeps the
-- table sized by how many different things broke, not by how many people
-- pressed the button. routes/clientCrash.js deletes rows older than 90 days.
--
-- ADDITIVE and replay-safe: CREATE ... IF NOT EXISTS only.
-- @requires table client_crash_reports

CREATE TABLE IF NOT EXISTS client_crash_reports (
  id BIGSERIAL PRIMARY KEY,
  fingerprint VARCHAR(32) NOT NULL,
  seen_on DATE NOT NULL DEFAULT CURRENT_DATE,
  boundary VARCHAR(40) NOT NULL,
  error_name VARCHAR(60) NOT NULL,
  error_message VARCHAR(200) NOT NULL DEFAULT '',
  components TEXT[] NOT NULL DEFAULT '{}',
  build VARCHAR(40),
  platform VARCHAR(10) NOT NULL,
  reports INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (fingerprint, seen_on)
);

CREATE INDEX IF NOT EXISTS idx_client_crash_reports_seen ON client_crash_reports (seen_on DESC);
