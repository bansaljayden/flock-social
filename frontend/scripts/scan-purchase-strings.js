// Lists every built JS file that still carries purchase wording, with the app
// sources its sourcemap names and a little context around each hit.
//
//   REACT_APP_PURCHASES=off CI=true npm run build
//   node scripts/scan-purchase-strings.js            (reads build/static/js)
//   node scripts/scan-purchase-strings.js <dir> [pattern ...]
//
// The iOS build is made with REACT_APP_PURCHASES=off (codemagic.yaml), and this
// is how to see what payment wording is left in what it ships. It reports; it
// does not fail the build, because some hits are words in unrelated code (a
// vendor library's own "checkout" identifier, say) and need a person to read.
const fs = require('fs');
const path = require('path');

// "/mo" is spelled with its closing quote: bare, it matches /moderation.
const DEFAULT_PATTERNS = [
  'Flock Pro', 'RevenueCat', 'revenuecat', 'paywall', 'Paywall', 'checkout', 'Checkout',
  '$3.99', '$2.99', '$4.99', '$29.99', '$99', '$990', '/mo"', "/mo'", '/mo`',
  '/api/pro/', '/api/venue-billing', 'Upgrade to Roost', 'Venue plans', 'See Pro', 'Keep Pro',
  'Cancel subscription', 'Subscribe', 'Restore purchases', 'apps.apple.com/account/subscriptions',
];

const dir = process.argv[2] || path.join(__dirname, '..', 'build', 'static', 'js');
const patterns = process.argv.length > 3 ? process.argv.slice(3) : DEFAULT_PATTERNS;

let total = 0;
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  const hits = patterns.filter((p) => text.includes(p));
  if (!hits.length) continue;
  let sources = ['(no sourcemap)'];
  try {
    const map = JSON.parse(fs.readFileSync(path.join(dir, `${file}.map`), 'utf8'));
    const own = map.sources.filter((s) => !s.includes('node_modules')).map((s) => s.replace(/.*src\//, 'src/'));
    sources = own.length ? own : map.sources.slice(0, 3);
  } catch {
    // no map beside it
  }
  console.log(`${file}  [${hits.join(' | ')}]`);
  console.log(`    sources: ${sources.join(' ')}`);
  for (const p of hits) {
    let at = -1;
    let shown = 0;
    while ((at = text.indexOf(p, at + 1)) !== -1) {
      total += 1;
      if (shown < 4) {
        console.log(`    ${p}: ...${text.slice(Math.max(0, at - 70), at + p.length + 70).replace(/\s+/g, ' ')}...`);
        shown += 1;
      }
    }
  }
}
console.log(`${total} hit(s) in ${dir}`);
