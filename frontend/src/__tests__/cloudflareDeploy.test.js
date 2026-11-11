/**
 * scripts/deploy-cloudflare.js publishes the site to Cloudflare Pages from
 * the machine that holds frontend/.env, and wrangler.toml is what Pages runs
 * the functions with. A wrong team id breaks universal links; a missing
 * nodejs_compat breaks the invite previews and the demo relay.
 */
const fs = require('fs');
const path = require('path');
const { teamIdFrom, refusal, flagsFrom, WRANGLER, HOW_TO_FORCE } = require('../../scripts/deploy-cloudflare');
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

  test('takes four options, and refuses a word it does not know', () => {
    expect(flagsFrom([])).toEqual({});
    expect(flagsFrom(['--force'])).toEqual({ force: true });
    expect(flagsFrom(['--skip-build', '--drop-old', '--allow-dirty'])).toEqual({ skipBuild: true, dropOld: true, allowDirty: true });
    // A mistyped --force must not end in "nothing to publish".
    expect(() => flagsFrom(['--forse'])).toThrow('unknown option --forse (it takes --force, --skip-build, --drop-old, --allow-dirty)');
    expect(() => flagsFrom(['--force', 'force'])).toThrow('unknown option force ');
  });

  test('the command it names for publishing anyway is one it takes', () => {
    // npm keeps a --force that comes before the "--" for itself.
    const [command, options] = HOW_TO_FORCE.split(' -- ');
    expect(command).toBe('npm run deploy:cloudflare');
    expect(flagsFrom(options.split(' '))).toEqual({ force: true });
  });

  test('wrangler is pinned to one version', () => {
    expect(WRANGLER).toMatch(/^wrangler@\d+\.\d+\.\d+$/);
  });
});
