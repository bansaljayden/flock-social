// ---------------------------------------------------------------------------
// Moderator alerting (A6) — so reports get acted on PROMPTLY (Apple 1.2).
// Notifies every admin via socket + push the moment a report lands.
// Fire-and-forget: callers must never await-block the reporting user on this.
// ---------------------------------------------------------------------------
const pool = require('../config/database');

let pushHelper = null;
try { pushHelper = require('./pushHelper'); } catch (_) { /* optional */ }

async function alertModerators(io, report) {
  try {
    const admins = await pool.query("SELECT id FROM users WHERE role = 'admin'");
    const title = 'New content report';
    const body = `${report.reason || 'report'} • ${report.content_type || ''}${report.reporter ? ` • by ${report.reporter}` : ''}`;

    for (const a of admins.rows) {
      if (io) {
        io.to(`user:${a.id}`).emit('moderation_report', { reportId: report.reportId, ...report });
      }
      if (pushHelper && pushHelper.pushIfOffline) {
        pushHelper
          .pushIfOffline(io, a.id, title, body, { type: 'moderation_report', reportId: String(report.reportId || '') })
          .catch(() => {});
      }
    }
    console.warn(`[MODERATION] New report #${report.reportId}: ${body}`);
  } catch (err) {
    console.error('alertModerators error:', err.message);
  }
}

module.exports = { alertModerators };
