// @capacitor-community/apple-sign-in@7.x declares capacitor-swift-pm
// `from: "7.0.0"` (which SwiftPM reads as >=7 <8), while this app pins
// exact 8.4.0 — an unresolvable graph that makes `xcodebuild` fail before
// it can even show build settings (Codemagic step 7, exit 74). No plugin
// release targets Capacitor 8 yet; its source is API-compatible, so we
// relax the requirement after every npm install (runs on CI too via
// the postinstall hook in package.json). Delete this script when the
// plugin ships a Capacitor 8 major.
const fs = require('fs');
const path = require('path');

const manifest = path.join(
  __dirname, '..', 'node_modules', '@capacitor-community', 'apple-sign-in', 'Package.swift'
);

try {
  if (!fs.existsSync(manifest)) {
    console.log('[patch-apple-signin-spm] plugin not installed, nothing to do');
    process.exit(0);
  }
  const src = fs.readFileSync(manifest, 'utf8');
  if (src.includes('"709.0.0"')) process.exit(0); // sentinel never true; keep lint quiet
  const patched = src.replace(
    /capacitor-swift-pm\.git",\s*from:\s*"7\.0\.0"/,
    'capacitor-swift-pm.git", "7.0.0"..<"9.0.0"'
  );
  if (patched === src) {
    if (src.includes('"7.0.0"..<"9.0.0"')) {
      console.log('[patch-apple-signin-spm] already patched');
    } else {
      console.warn('[patch-apple-signin-spm] WARNING: expected requirement not found — plugin may have updated; check Capacitor 8 compatibility');
    }
    process.exit(0);
  }
  fs.writeFileSync(manifest, patched, 'utf8'); // Node writes no BOM
  console.log('[patch-apple-signin-spm] relaxed capacitor-swift-pm requirement to 7.0.0..<9.0.0');
} catch (e) {
  console.error('[patch-apple-signin-spm] failed:', e.message);
  process.exit(1);
}
