/**
 * scripts/deploy-cloudflare.js publishes the site to Cloudflare Pages from
 * the machine that holds frontend/.env, and wrangler.toml is what Pages runs
 * the functions with. A wrong team id breaks universal links; a missing
 * nodejs_compat breaks the invite previews and the demo relay.
 */
const fs = require('fs');
const path = require('path');
const { teamIdFrom, refusal, WRANGLER } = require('../../scripts/deploy-cloudflare');
const pkg = require('../../package.json');

const TOML = fs.readFileSync(path.join(__dirname, '..', '..', 'wrangler.toml'), 'utf8');

describe('Cloudflare Pages deploy', () => {
  test('npm run deploy:cloudflare runs the script', () => {
    expect(pkg.scripts['deploy:cloudflare']).toBe('node scripts/deploy-cloudflare.js');
  });

  test('wrangler.toml names the project, the output directory and nodejs_compat', () => {
    expect(TOML).toMatch(/^name = "flockcorp"$/m);
    expect(TOML).toMatch(/^pages_build_output_dir = "build"$/m);
    expect(TOML).toMatch(/^compatibility_flags = \["nodejs_compat"\]$/m);
  });

  test('the team id the build bakes into the app-site-association file is the one the functions get', () => {
    expect(teamIdFrom(TOML)).toBe('998W73654F');
    expect(() => teamIdFrom('name = "flockcorp"\n')).toThrow(/APPLE_TEAM_ID/);
  });

  test('refuses tracked changes unless asked, and a missing .env always', () => {
    expect(refusal({ trackedChanges: ' M src/App.js', hasEnv: true, allowDirty: false })).toMatch(/commit them first/);
    expect(refusal({ trackedChanges: ' M src/App.js', hasEnv: true, allowDirty: true })).toBeNull();
    expect(refusal({ trackedChanges: '', hasEnv: false, allowDirty: true })).toMatch(/\.env is missing/);
    expect(refusal({ trackedChanges: '', hasEnv: true, allowDirty: false })).toBeNull();
  });

  test('wrangler is pinned to one version', () => {
    expect(WRANGLER).toMatch(/^wrangler@\d+\.\d+\.\d+$/);
  });
});
