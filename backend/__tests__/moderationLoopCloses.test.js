// The moderation loop closes for every party. Source contracts from the
// console trace of 2026-09-04.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('a ban is told, after the commit, best-effort', () => {
  const src = read('routes/admin.js');
  assert.match(src, /const BAN_SUBJECT = 'Your Flock account has been banned';/);
  const after = src.slice(src.indexOf("if (io) io.in(`user:${banTargetId}`).disconnectSockets(true);"));
  assert.match(after, /subject: BAN_SUBJECT, text: banEmailText\(t\.name\), html: banEmailHtml\(t\.name\)/);
  assert.match(after, /ban notice for user \$\{banTargetId\} not sent/);
});

test('the reporter hears back once on resolution, with no outcome and no name', () => {
  const src = read('routes/admin.js');
  assert.match(src, /if \(newStatus === 'resolved'\) \{\s*pool\.query\(\s*'SELECT u\.name, u\.email FROM content_reports r JOIN users u ON u\.id = r\.reporter_id WHERE r\.id = \$1'/);
  const text = src.slice(src.indexOf('function reportFollowupText'), src.indexOf('function reportFollowupHtml'));
  assert.match(text, /handled/);
  assert.doesNotMatch(text, /banned|removed|warned|\$\{outcome/);
});

test('the alert summary counts a push that went nowhere as not sent', () => {
  const src = read('services/moderationAlerts.js');
  assert.match(src, /pushSkipped: 0,/);
  assert.match(src, /\.then\(\(r\) => \{ if \(r && r\.skipped\) summary\.pushSkipped \+= 1; \}\)/);
  assert.match(src, /\$\{summary\.pushSkipped\} not sent \(online or no device\)/);
});
