// ---------------------------------------------------------------------------
// ML Data Collection — Orchestrator / Cron Entry Point
// Usage:
//   node scripts/ml/runCollection.js weekly    — weekly pattern collection
//   node scripts/ml/runCollection.js realtime  — real-time snapshot
//   node scripts/ml/runCollection.js both      — run both sequentially
//   node scripts/ml/runCollection.js export    — export to CSV
// ---------------------------------------------------------------------------

// backend/.env, as the command run: collectWeekly.js loads it only as its
// own command, so `weekly` would otherwise start without it.
if (require.main === module) require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const mode = process.argv[2] || 'realtime';

async function main() {
  console.log(`[ML] Running collection mode: ${mode}\n`);

  if (mode === 'weekly' || mode === 'both') {
    const { run } = require('./collectWeekly');
    await run();
  }

  if (mode === 'realtime' || mode === 'both') {
    const { run } = require('./collectRealtime');
    await run();
  }

  if (mode === 'export') {
    const { run } = require('./exportCsv');
    await run();
  }

  if (!['weekly', 'realtime', 'both', 'export'].includes(mode)) {
    console.error(`[ML] Unknown mode: "${mode}". Use: weekly, realtime, both, or export`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[ML] Fatal error:', err);
  process.exit(1);
});
