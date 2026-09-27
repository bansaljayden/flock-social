// ---------------------------------------------------------------------------
// POST /api/client-crash — a crash report the person chose to send
// ---------------------------------------------------------------------------
// The app's crash screen (frontend/src/components/ErrorBoundary.js) used to
// end at console.error, inside a WebView console nobody can read. Sentry is
// off on purpose (frontend/.env.example, SUBMIT-CHECKLIST.md): turning it on
// means answering yes to Crash Data in App Store Connect and rewriting the
// privacy policy. A report the user sends by pressing "Send this to Flock",
// each time, is data they chose to give us from the app's own screen, so this
// route is how a crash on a phone reaches the operator the same day without
// flipping that switch.
//
// WHAT IS KEPT, AND WHAT IS NEVER READ. The boundary label, the error's name,
// a clamped and scrubbed message, up to eight component names, the build and
// native or web. The route takes no auth middleware and never reads the
// Authorization header, the IP or the user agent into anything it stores, so
// a report cannot be tied back to an account. The limiter keys on the address
// in memory only, like every other open endpoint.
//
// BOUNDED THREE WAYS, because it is an open endpoint that writes to Postgres
// and can send email:
//   * the request: 4 KB at most, and the limiter in server.js;
//   * the table: one row per crash shape per day (fingerprint, seen_on), and
//     at most MAX_NEW_ROWS_PER_DAY distinct shapes a day;
//   * the inbox: the first sighting of a shape each day is mailed, through
//     ops_alert_ledger, for at most MAX_EMAILS_PER_DAY shapes a day.
// ---------------------------------------------------------------------------
const express = require('express');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
// Held as a module object so a test can replace opsAlert after this loads.
const opsAlertModule = require('../services/opsAlert');

const router = express.Router();

const MAX_BODY_BYTES = 4 * 1024;
const MESSAGE_MAX = 200;
const MAX_COMPONENTS = 8;
const MAX_NEW_ROWS_PER_DAY = 200;
const MAX_EMAILS_PER_DAY = 10;
const RETENTION_DAYS = 90;

// Identifiers only: a component or error name is a JavaScript identifier,
// possibly dotted, and a boundary label is a short tag the app chooses.
const NAME_RE = /^[A-Za-z_$][\w$.]{0,59}$/;
const LABEL_RE = /^[A-Za-z0-9][\w .:-]{0,39}$/;
const BUILD_RE = /^[A-Za-z0-9._-]{1,40}$/;

// The client scrubs with the same rules as its analytics (index.js
// scrubUrlTokens), and this does it again, because a report is caller data.
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT_SHAPE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const COORD_SHAPE = /-?\b\d{1,3}\.\d{4,}\b/g;
const URL_QUERY = /(https?:\/\/[^\s?#"']+)[?#][^\s"']*/g;
const INVITE_PATH = /\/i\/[A-Za-z0-9_-]+/g;

function scrubMessage(raw) {
  const s = String(raw == null ? '' : raw)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(URL_QUERY, '$1')
    .replace(INVITE_PATH, '/i/:token')
    .replace(JWT_SHAPE, '[jwt]')
    .replace(EMAIL_SHAPE, '[email]')
    .replace(COORD_SHAPE, '[number]')
    .trim();
  return s.length > MESSAGE_MAX ? s.slice(0, MESSAGE_MAX) : s;
}

function fingerprintOf(boundary, name, topComponent) {
  return crypto
    .createHash('sha256')
    .update(`${boundary}|${name}|${topComponent || ''}`)
    .digest('hex')
    .slice(0, 32);
}

// The privacy policy says a report is deleted after RETENTION_DAYS, so this
// runs on its own hourly timer in server.js rather than off the next report:
// a month with no crashes must not be a month the old rows outlive it.
async function pruneCrashReports() {
  const r = await pool.query(
    'DELETE FROM client_crash_reports WHERE seen_on < CURRENT_DATE - $1::int',
    [RETENTION_DAYS]
  );
  return r.rowCount || 0;
}

async function alertFirstSighting(report, fingerprint) {
  try {
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM client_crash_reports WHERE seen_on = CURRENT_DATE'
    );
    if ((rows[0] && rows[0].n) > MAX_EMAILS_PER_DAY) return;
    const where = report.platform === 'native' ? 'the phone app' : 'the web app';
    await opsAlertModule.opsAlert({
      key: `client_crash_${fingerprint}`,
      subject: `A crash was sent from ${where}: ${report.name}`,
      text: [
        `Somebody pressed "Send this to Flock" on the crash screen in ${where}.`,
        '',
        `Error:       ${report.name}${report.message ? `: ${report.message}` : ''}`,
        `Screen:      the "${report.boundary}" error boundary`,
        `Components:  ${report.components.length ? report.components.join(' < ') : 'none sent'}`,
        `Build:       ${report.build || 'unknown'}`,
        '',
        'No account is attached, by design. Every report of this same crash today',
        'is counted on one row:',
        '',
        `  SELECT * FROM client_crash_reports WHERE fingerprint = '${fingerprint}';`,
        '',
        'This is the first report of this crash today. More of the same today add',
        'to that row without another email.',
      ].join('\n'),
      legs: ['email'],
      tag: '[client-crash]',
    });
  } catch (err) {
    console.error('[client-crash] alert failed:', err && err.message ? err.message : err);
  }
}

router.post(
  '/',
  (req, res, next) => {
    // The 64 KB default parser has already run; this is the route's own
    // ceiling, checked on what was actually sent.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'That report is too large to send.' });
    }
    try {
      if (Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8') > MAX_BODY_BYTES) {
        return res.status(413).json({ error: 'That report is too large to send.' });
      }
    } catch (err) {
      return res.status(400).json({ error: 'That report could not be read.' });
    }
    return next();
  },
  [
    body('boundary').isString().matches(LABEL_RE).withMessage('boundary is not a label'),
    body('name').isString().matches(NAME_RE).withMessage('name is not an error name'),
    body('message').optional({ values: 'null' }).isString().isLength({ max: 1000 }),
    body('components').optional().isArray({ max: MAX_COMPONENTS }).withMessage(`components holds at most ${MAX_COMPONENTS} names`),
    body('components.*').isString().matches(NAME_RE),
    body('build').optional({ values: 'null' }).isString().matches(BUILD_RE),
    body('platform').isIn(['native', 'web']).withMessage('platform is native or web'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }
      const report = {
        boundary: req.body.boundary,
        name: req.body.name,
        message: scrubMessage(req.body.message),
        components: Array.isArray(req.body.components) ? req.body.components.slice(0, MAX_COMPONENTS) : [],
        build: req.body.build || null,
        platform: req.body.platform,
      };
      const fingerprint = fingerprintOf(report.boundary, report.name, report.components[0]);

      // One statement: a new shape is stored only while today is under its
      // cap, and a shape already seen today is always counted. `inserted`
      // tells a first sighting from a repeat (xmax is 0 on a fresh row).
      const { rows } = await pool.query(
        // Every parameter is cast: $1 is both inserted and compared, and a
        // bare parameter used two ways is refused with 42P08.
        `INSERT INTO client_crash_reports
                (fingerprint, boundary, error_name, error_message, components, build, platform)
         SELECT $1::varchar, $2::varchar, $3::varchar, $4::varchar, $5::text[], $6::varchar, $7::varchar
          WHERE EXISTS (SELECT 1 FROM client_crash_reports WHERE fingerprint = $1::varchar AND seen_on = CURRENT_DATE)
             OR (SELECT COUNT(*) FROM client_crash_reports WHERE seen_on = CURRENT_DATE) < $8::int
         ON CONFLICT (fingerprint, seen_on) DO UPDATE
            SET reports = client_crash_reports.reports + 1,
                last_seen_at = NOW()
         RETURNING reports, (xmax = 0) AS inserted`,
        [fingerprint, report.boundary, report.name, report.message, report.components,
          report.build, report.platform, MAX_NEW_ROWS_PER_DAY]
      );
      if (rows.length === 0) {
        return res.status(429).json({ error: 'Flock has had a lot of crash reports today. This one was not saved.' });
      }

      res.status(201).json({ ok: true });
      // After the answer: the person is not kept waiting on an email.
      if (rows[0].inserted) alertFirstSighting(report, fingerprint);
      return undefined;
    } catch (err) {
      console.error('Client crash report error:', err);
      return res.status(500).json({ error: 'That report could not be saved.' });
    }
  }
);

module.exports = router;
module.exports.pruneCrashReports = pruneCrashReports;
module.exports.RETENTION_DAYS = RETENTION_DAYS;
module.exports.__test = {
  scrubMessage,
  fingerprintOf,
  MAX_BODY_BYTES,
  MAX_COMPONENTS,
  MAX_NEW_ROWS_PER_DAY,
  MAX_EMAILS_PER_DAY,
};
