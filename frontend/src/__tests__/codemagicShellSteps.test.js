// ---------------------------------------------------------------------------
// THE TWO SHELL STEPS IN codemagic.yaml, EXECUTED.
//
// WHY THIS FILE EXISTS. Both guards in that file were written after a build
// shipped something broken while printing green, and both were then tested by
// GREPPING codemagic.yaml for the strings they were supposed to contain. That
// is a tool that shares the blind spot of the thing it is checking. The two
// defects found in those guards the round after they landed were:
//
//   1. a loop that asked one question per entitlement, given an empty list of
//      entitlements, asking nothing and reporting every profile as good;
//   2. a conditional check printing the identical green line whether it had
//      compared the two Firebase projects or skipped the comparison entirely.
//
// Neither is visible to a grep. Both are properties of what the shell DOES,
// and until this file, nothing in this repository had ever run a line of it.
// A third of the same kind is closed here and was only findable this way:
// PlistBuddy prints its "Does Not Exist" complaint as well as exiting non-zero,
// and `VAR=$(PlistBuddy ... || echo "")` captures that complaint as the VALUE
// if the complaint goes to stdout, so a GoogleService-Info.plist with no
// API_KEY at all read as having one and shipped as verified.
//
// HOW IT RUNS THE REAL THING. The step bodies are parsed out of the YAML block
// scalars and executed, so what runs here is the text the Codemagic runner
// runs, with no second copy to drift. `security`, `plutil` and `PlistBuddy`
// are macOS binaries, so stand-ins for them go on PATH; the first two are
// resolved by name and the third was an absolute path until codemagic.yaml
// named it `PLIST_BUDDY`, which is the only change either step needed to be
// runnable off a Mac. The stubs answer out of Python's plistlib rather than by
// matching text, so they do not re-import the blind spot they exist to avoid.
//
// WHAT IT ASSERTS. The exit code and the operative sentence, for every case.
// The sentence is not decoration: both defects above were partly failures of
// the message, and "delete every profile marked STALE above" is only an
// instruction when the stale one was actually named.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'codemagic');
const STUB_SOURCE = path.join(FIXTURES, 'stubs');
// NORMALISED TO LF, WHICH IS WHAT THE RUNNER ACTUALLY GETS. The blob in git is
// LF, and `core.autocrlf=true` on a Windows clone rewrites the working copy to
// CRLF; the Codemagic Mac checks the same blob out unchanged. Feeding a Windows
// working copy to a shell verbatim would test a file that exists nowhere, and
// it would fail in a way that teaches nothing: a stray CR at the end of a
// heredoc terminator stops the heredoc closing, and one at the end of an
// assignment ends up INSIDE the value.
const yaml = fs.readFileSync(path.join(REPO, 'codemagic.yaml'), 'utf8').replace(/\r\n/g, '\n');

const BUNDLE_ID = 'com.flockcorp.flock';

// --- pulling a step body out of the YAML -----------------------------------
// Deliberately strict. A step that stops being a `script: |` block, or a step
// whose name stops matching, fails loudly here rather than quietly handing the
// suite an empty string to run, which would make every case below pass while
// testing nothing. That is the failure this whole file exists to rule out, so
// it is not allowed to happen to the file itself.
function stepScript(titleRe) {
  const lines = yaml.split('\n');
  let i = lines.findIndex((l) => {
    const m = /^ {6}- name: (.*)$/.exec(l);
    return m && titleRe.test(m[1]);
  });
  if (i < 0) throw new Error(`codemagic.yaml has no step named like ${titleRe}`);
  const title = lines[i].replace(/^ {6}- name: /, '');
  i += 1;
  if (!/^ {8}script: \|\s*$/.test(lines[i] || '')) {
    throw new Error(`the step "${title}" is no longer a "script: |" block, so this file cannot run it`);
  }
  i += 1;
  const body = [];
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') { body.push(''); continue; }
    if (!/^ {9}/.test(line)) break;
    body.push(line);
  }
  const indent = Math.min(...body.filter((l) => l !== '').map((l) => /^ */.exec(l)[0].length));
  return { title, body: `${body.map((l) => l.slice(indent)).join('\n')}\n` };
}

const PLIST_STEP = stepScript(/GoogleService-Info\.plist/);
const PROFILE_STEP = stepScript(/App\.entitlements/);

// --- can this machine run a POSIX shell at all? ----------------------------
// The same rule the generated-config checks in iosShellConfigMatchesCode.js
// follow: a check that cannot be performed on this checkout says so by name and
// does not run, because a skipped check that reads as a passed one is the exact
// failure both of these steps were written to end.
const probe = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return !r.error && r.status === 0;
};
const SHELLS = [
  'sh',
  'bash',
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];
const SH = SHELLS.find((c) => probe(c, ['-c', 'exit 0']));
// The interpreter is resolved to its own sys.executable rather than passed on
// by name. On Windows "python3" is a launcher shim that re-resolves an install
// on every call, prints progress to STDOUT while it does, and that output lands
// in the middle of a stub's answer: the profile step read an entitlement name
// with a download bar in front of it. An absolute path to the real binary has
// none of that and starts in about forty milliseconds.
const PY = (() => {
  for (const name of ['python3', 'python']) {
    const r = spawnSync(name, ['-c', 'import plistlib, sys; print(sys.executable)'], { encoding: 'utf8' });
    const exe = !r.error && r.status === 0 ? (r.stdout || '').trim() : '';
    if (exe && fs.existsSync(exe)) return exe.replace(/\\/g, '/');
  }
  return null;
})();
const RUNNABLE = !!SH && !!PY;
const NEEDS_SHELL = 'SKIPPED, no POSIX shell and Python are reachable from this'
  + ' process: sh/bash and python3/python are what runs the step bodies, and'
  + ' both ship with Git for Windows and with macOS. Install Git Bash, or run'
  + ' this suite from one, to make these checks run';
const shellTest = RUNNABLE ? test : test.skip;
const s = (name) => (RUNNABLE ? name : `${name} [${NEEDS_SHELL}]`);

if (!RUNNABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    `[codemagicShellSteps] ${NEEDS_SHELL}. NOTHING in codemagic.yaml's two shell`
    + ' steps was executed on this run.'
  );
}

// --- running one case ------------------------------------------------------
const fwd = (p) => p.replace(/\\/g, '/');
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-codemagic-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const stub of fs.readdirSync(STUB_SOURCE)) {
    // Copied through an LF normalise for the same reason the YAML is, and here
    // it is not cosmetic: a Windows clone checks these out with CRLF, the
    // shebang line then ends in a carriage return, and the kernel looks for an
    // interpreter called "/bin/sh\r".
    const text = fs.readFileSync(path.join(STUB_SOURCE, stub), 'utf8').replace(/\r\n/g, '\n');
    const target = path.join(bin, stub);
    fs.writeFileSync(target, text, 'utf8');
    fs.chmodSync(target, 0o755);
  }
  const work = path.join(root, 'work', 'ios', 'App', 'App');
  fs.mkdirSync(work, { recursive: true });
  const home = path.join(root, 'home', 'Library', 'MobileDevice', 'Provisioning Profiles');
  fs.mkdirSync(home, { recursive: true });
  return {
    root, bin, work, profiles: home, cwd: path.join(root, 'work'),
  };
}

/**
 * Runs one of the two step bodies against a freshly built sandbox.
 *
 * The environment is BUILT, not inherited: every REACT_APP_* and
 * GOOGLE_SERVICE_INFO_PLIST that happens to be set on the machine running the
 * suite would otherwise decide the answer, and a developer with a real
 * frontend/.env would get different results from CI.
 */
function run(step, opts = {}) {
  const box = sandbox();
  const scriptPath = path.join(box.root, 'step.sh');
  fs.writeFileSync(scriptPath, step.body, 'utf8');

  for (const [name, contents] of Object.entries(opts.files || {})) {
    fs.writeFileSync(path.join(box.work, name), contents, 'utf8');
  }
  for (const [name, contents] of Object.entries(opts.profiles || {})) {
    fs.writeFileSync(path.join(box.profiles, name), contents, 'utf8');
  }

  const env = {
    PATH: `${box.bin}${path.delimiter}${process.env.PATH}`,
    SystemRoot: process.env.SystemRoot || '',
    COMSPEC: process.env.COMSPEC || '',
    TEMP: process.env.TEMP || os.tmpdir(),
    TMP: process.env.TMP || os.tmpdir(),
    HOME: fwd(path.join(box.root, 'home')),
    PLIST_BUDDY: fwd(path.join(box.bin, 'PlistBuddy')),
    FIXTURE_PYTHON: PY,
    FIXTURE_PLISTBUDDY_ERR: opts.buddyErr || 'stdout',
    BUNDLE_ID,
    ...(opts.env || {}),
  };

  const r = spawnSync(SH, [fwd(scriptPath)], { cwd: box.cwd, env, encoding: 'utf8' });
  if (r.error) throw r.error;
  return {
    code: r.status,
    out: `${r.stdout || ''}${r.stderr || ''}`,
    plist: () => fs.readFileSync(path.join(box.work, 'GoogleService-Info.plist'), 'utf8'),
  };
}

// The step bodies really were extracted, and they really are the ones with the
// guards in them. Cheap, and it is the one thing that cannot be caught by the
// cases below going green.
describe('the step bodies come out of codemagic.yaml intact', () => {
  test('both steps parse as runnable shell, not as an empty string', () => {
    expect(PLIST_STEP.body).toMatch(/^set -eu$/m);
    expect(PLIST_STEP.body).toMatch(/PUSH CHECK FAILED/);
    expect(PLIST_STEP.body.split('\n').length).toBeGreaterThan(40);
    expect(PROFILE_STEP.body).toMatch(/^set -eu$/m);
    expect(PROFILE_STEP.body).toMatch(/SIGNING CHECK FAILED/);
    expect(PROFILE_STEP.body.split('\n').length).toBeGreaterThan(40);
  });

  test('the heredoc that writes the placeholder plist survived the dedent', () => {
    // The block scalar is indented ten spaces and the heredoc terminator sits
    // at that same indent, so a dedent that is off by one leaves PLIST_EOF
    // indented, the heredoc never closes, and the rest of the step becomes
    // plist text. The shell would report that as a syntax error at the end of
    // the file, which is a confusing way to find a broken parser.
    expect(PLIST_STEP.body).toMatch(/^PLIST_EOF$/m);
    expect(PLIST_STEP.body).toMatch(/^ *cat > "\$PLIST" <<'PLIST_EOF'$/m);
  });
});

// ---------------------------------------------------------------------------
// 1. The push plist step.
// ---------------------------------------------------------------------------
describe(s('the push plist step, run'), () => {
  jest.setTimeout(30000);

  const withPlist = (name, env = {}) => run(PLIST_STEP, {
    env: { GOOGLE_SERVICE_INFO_PLIST: b64(fixture(name)), ...env },
  });

  shellTest('an absent GOOGLE_SERVICE_INFO_PLIST stops the build and names the variable', () => {
    const r = run(PLIST_STEP);
    expect(r.code).toBe(1);
    expect(r.out).toContain('PUSH CHECK FAILED: GOOGLE_SERVICE_INFO_PLIST is not set in the flock_web variable group.');
    expect(r.out).toContain('OVERRIDE: set ALLOW_PUSHLESS_BUILD=true');
    expect(r.out).not.toMatch(/PUSH IS ON/);
  });

  shellTest('the override is the exact string true, and nothing else is truthy', () => {
    for (const loose of ['TRUE', 'True', '1', 'yes', 'on']) {
      const r = run(PLIST_STEP, { env: { ALLOW_PUSHLESS_BUILD: loose } });
      expect({ loose, code: r.code }).toEqual({ loose, code: 1 });
    }
  });

  shellTest('the override writes a placeholder and says push is OFF, not ON', () => {
    const r = run(PLIST_STEP, { env: { ALLOW_PUSHLESS_BUILD: 'true' } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('WARNING: ALLOW_PUSHLESS_BUILD=true, placeholder plist written, PUSH IS OFF IN THIS BUILD');
    expect(r.out).not.toMatch(/PUSH IS ON/);
    // The placeholder has to be a real plist or the archive fails on a missing
    // resource, which is the reason it is written at all.
    expect(r.plist()).toContain('<key>API_KEY</key><string>invalid-placeholder</string>');
  });

  shellTest('a value that is not base64 stops at the lint, not twenty minutes later', () => {
    const r = run(PLIST_STEP, { env: { GOOGLE_SERVICE_INFO_PLIST: 'this is not base64 at all !!!' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('PUSH CHECK FAILED: GOOGLE_SERVICE_INFO_PLIST did not decode to a valid plist.');
  });

  shellTest('a truncated base64 value stops at the lint too', () => {
    const whole = b64(fixture('google-service-good.plist'));
    const r = run(PLIST_STEP, { env: { GOOGLE_SERVICE_INFO_PLIST: whole.slice(0, Math.floor(whole.length / 2)) } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('did not decode to a valid plist');
  });

  shellTest('a plist for another app is named by the bundle id it actually carries', () => {
    const r = withPlist('google-service-other-bundle.plist', { REACT_APP_FIREBASE_PROJECT_ID: 'flock-prod' });
    expect(r.code).toBe(1);
    expect(r.out).toContain("PUSH CHECK FAILED: this plist is registered to bundle id 'com.somebody.else', not com.flockcorp.flock.");
  });

  shellTest('the placeholder cannot be laundered back in through the variable', () => {
    // Someone who hits the stop, copies the placeholder out of the yaml and
    // base64s it into the group has done the thing the stop exists to prevent.
    const placeholder = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '  <key>API_KEY</key><string>invalid-placeholder</string>',
      `  <key>BUNDLE_ID</key><string>${BUNDLE_ID}</string>`,
      '  <key>PROJECT_ID</key><string>placeholder</string>',
      '</dict></plist>',
    ].join('\n');
    const r = run(PLIST_STEP, { env: { GOOGLE_SERVICE_INFO_PLIST: b64(placeholder) } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('PUSH CHECK FAILED: the decoded plist carries no usable API_KEY.');
  });

  shellTest('a plist with NO API_KEY is refused, whatever PlistBuddy prints when it says so', () => {
    // THE THIRD INSTANCE OF THE CLASS. `PLIST_KEY=$(PlistBuddy ... || echo "")`
    // captures whatever the failing command printed, and PlistBuddy prints
    // "Print: Entry, ":API_KEY", Does Not Exist" as well as exiting non-zero.
    // On the stdout answer that string BECOMES the API key: it is not empty and
    // it is not the placeholder, so the plist passed and shipped as verified.
    // Both streams are driven because which one the real binary uses cannot be
    // established from here, and a guard that is right on only one of them is a
    // guard nobody has checked.
    for (const buddyErr of ['stdout', 'stderr']) {
      const r = run(PLIST_STEP, {
        buddyErr,
        env: {
          GOOGLE_SERVICE_INFO_PLIST: b64(fixture('google-service-no-api-key.plist')),
          REACT_APP_FIREBASE_PROJECT_ID: 'flock-prod',
        },
      });
      expect({ buddyErr, code: r.code }).toEqual({ buddyErr, code: 1 });
      expect(r.out).toContain('PUSH CHECK FAILED: the decoded plist carries no usable API_KEY.');
      expect(r.out).not.toMatch(/PUSH IS ON/);
    }
  });

  shellTest('a plist that names no Firebase project is refused rather than reported as unchecked', () => {
    // The skip sentence below is honest about a comparison that did not run. It
    // is not a licence to print a verdict about a plist that does not say which
    // project it belongs to: "Firebase project '', WHICH NOTHING HERE CHECKED"
    // on exit 0 is a green build carrying a plist Firebase cannot configure
    // from. Both streams again, for the reason above.
    for (const buddyErr of ['stdout', 'stderr']) {
      const r = run(PLIST_STEP, {
        buddyErr,
        env: { GOOGLE_SERVICE_INFO_PLIST: b64(fixture('google-service-no-project.plist')) },
      });
      expect({ buddyErr, code: r.code }).toEqual({ buddyErr, code: 1 });
      expect(r.out).toContain('PUSH CHECK FAILED: the decoded plist names no Firebase PROJECT_ID.');
      expect(r.out).not.toMatch(/PUSH IS ON/);
    }
  });

  shellTest('a plist from the wrong Firebase project is stopped and both projects are named', () => {
    const r = withPlist('google-service-staging.plist', { REACT_APP_FIREBASE_PROJECT_ID: 'flock-prod' });
    expect(r.code).toBe(1);
    expect(r.out).toContain("PUSH CHECK FAILED: this plist belongs to Firebase project 'flock-staging', but");
    expect(r.out).toContain("REACT_APP_FIREBASE_PROJECT_ID in the same variable group says 'flock-prod'.");
    expect(r.out).not.toMatch(/PUSH IS ON/);
  });

  shellTest('two halves that agree pass, and the line says they agreed', () => {
    const r = withPlist('google-service-good.plist', { REACT_APP_FIREBASE_PROJECT_ID: 'flock-prod' });
    expect(r.code).toBe(0);
    expect(r.out.trim().split('\n').pop()).toBe(
      "GoogleService-Info.plist written and verified for com.flockcorp.flock, Firebase project 'flock-prod',"
      + ' which is the project REACT_APP_FIREBASE_PROJECT_ID names too. PUSH IS ON IN THIS BUILD.'
    );
  });

  shellTest('a build where nothing compared the projects says so on the same line', () => {
    // This is defect 2 of the last round, executed. The step used to print the
    // identical green sentence whether the comparison ran or not, which is the
    // invisible failure the whole step exists to end, moved into the log.
    const r = withPlist('google-service-staging.plist');
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "Firebase project 'flock-staging', WHICH NOTHING HERE CHECKED:"
      + ' REACT_APP_FIREBASE_PROJECT_ID is not set in this group, so there was'
      + ' nothing to compare it against'
    );
    // And the passed sentence is not also present. A log carrying both lines
    // would be no better than a log carrying the wrong one.
    expect(r.out).not.toMatch(/which is the project REACT_APP_FIREBASE_PROJECT_ID names too/);
  });

  shellTest('a blank web variable is absent, not a project named nothing', () => {
    // An empty Secure variable in the group is the ordinary way this ends up
    // blank, and comparing a real project id against "" would stop the build
    // over a variable the step already says is optional.
    const r = withPlist('google-service-good.plist', { REACT_APP_FIREBASE_PROJECT_ID: '' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('WHICH NOTHING HERE CHECKED');
  });
});

// ---------------------------------------------------------------------------
// 2. The provisioning profile step.
// ---------------------------------------------------------------------------
describe(s('the provisioning profile step, run'), () => {
  jest.setTimeout(30000);

  const GOOD = fixture('profile-complete.mobileprovision');
  const STALE = fixture('profile-stale.mobileprovision');
  const OTHER = fixture('profile-other-app.mobileprovision');
  const JUNK = fixture('profile-unreadable.mobileprovision');
  const DOMAINS = 'com.apple.developer.associated-domains';

  const withProfiles = (profiles, entitlements = 'entitlements-complete.plist', opts = {}) => run(PROFILE_STEP, {
    ...opts,
    files: { 'App.entitlements': fixture(entitlements) },
    profiles,
  });

  shellTest('one good profile passes, and the line counts what it read', () => {
    const r = withProfiles({ 'aaaa.mobileprovision': GOOD });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`All 1 installed profiles for ${BUNDLE_ID} carry every entitlement this app declares.`);
    expect(r.out).toContain('App.entitlements declares: aps-environment com.apple.developer.applesignin com.apple.developer.associated-domains');
  });

  shellTest('a profile that predates the capability is stopped and named', () => {
    const r = withProfiles({ 'aaaa.mobileprovision': STALE });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Profile: Flock App Store 2026-07-02');
    expect(r.out).toContain(`  STALE, missing: ${DOMAINS}`);
    expect(r.out).toContain(`SIGNING CHECK FAILED: 1 of 1 installed profiles for ${BUNDLE_ID} cannot sign this app.`);
    expect(r.out).toContain('DO NOT delete the entitlement to make this pass.');
  });

  shellTest('two profiles installed at once are both judged, in EITHER sort order', () => {
    // The case this step exists for is the case that leaves two on disk, and
    // the loop used to stop at the first. `xcode-project use-profiles` picks by
    // its own rule, so a check that reads whichever UUID filename sorts first
    // is right half the time by coincidence.
    const orders = [
      { label: 'good sorts first', profiles: { 'aaaa.mobileprovision': GOOD, 'zzzz.mobileprovision': STALE } },
      { label: 'stale sorts first', profiles: { 'aaaa.mobileprovision': STALE, 'zzzz.mobileprovision': GOOD } },
    ];
    for (const { label, profiles } of orders) {
      const r = withProfiles(profiles);
      expect({ label, code: r.code }).toEqual({ label, code: 1 });
      expect(r.out).toContain(`SIGNING CHECK FAILED: 1 of 2 installed profiles for ${BUNDLE_ID} cannot sign this app.`);
      expect(r.out).toContain('Flock App Store 2026-07-02');
      // The good one is reported as good in the same run, so "delete every
      // profile marked STALE above" cannot be read as "delete both".
      expect(r.out).toContain('  carries every entitlement this app declares.');
    }
  });

  shellTest('two good profiles pass and both are counted', () => {
    const r = withProfiles({ 'aaaa.mobileprovision': GOOD, 'zzzz.mobileprovision': GOOD });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`All 2 installed profiles for ${BUNDLE_ID} carry every entitlement this app declares.`);
  });

  shellTest('no profile installed blames the fetch step, not the archive', () => {
    const r = withProfiles({});
    expect(r.code).toBe(1);
    expect(r.out).toContain(`SIGNING CHECK FAILED: no provisioning profile for ${BUNDLE_ID} was installed.`);
    expect(r.out).toContain('The fetch-signing-files step above is where that went wrong, not the archive.');
  });

  shellTest('a profile for a different app id is not this app having a profile', () => {
    const r = withProfiles({ 'aaaa.mobileprovision': OTHER });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`SIGNING CHECK FAILED: no provisioning profile for ${BUNDLE_ID} was installed.`);
  });

  shellTest('a file security cannot decode is skipped without taking the step down', () => {
    const r = withProfiles({ 'aaaa.mobileprovision': JUNK, 'zzzz.mobileprovision': GOOD });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`All 1 installed profiles for ${BUNDLE_ID} carry every entitlement this app declares.`);
  });

  shellTest('an EMPTY App.entitlements stops the build instead of passing every profile', () => {
    // Defect 1 of the last round, executed. With nothing to ask, the per-profile
    // loop ran zero times and every profile on disk, stale ones included, was
    // printed as carrying every entitlement this app declares. Exit 0.
    const r = withProfiles(
      { 'aaaa.mobileprovision': GOOD, 'zzzz.mobileprovision': STALE },
      'entitlements-empty.plist'
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain('SIGNING CHECK FAILED: ios/App/App/App.entitlements declares nothing this check can ask about.');
    expect(r.out).not.toMatch(/carry every entitlement this app declares/);
    expect(r.out).toContain('     com.apple.developer.applesignin for Guideline 4.8');
  });

  shellTest('an App.entitlements whose keys are blank is empty too', () => {
    // `[ -z "$WANTED" ]` and `for key in $WANTED` were two different readings of
    // one string: a key list of nothing but whitespace is not empty, and it
    // splits into zero words. So the guard passed it and the loop asked nothing,
    // which is the same defect above reached one character to the side of it.
    const r = withProfiles(
      { 'aaaa.mobileprovision': GOOD, 'zzzz.mobileprovision': STALE },
      'entitlements-blank-key.plist'
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain('SIGNING CHECK FAILED: ios/App/App/App.entitlements declares nothing this check can ask about.');
    expect(r.out).not.toMatch(/carry every entitlement this app declares/);
  });

  shellTest('the entitlement list is read from the file, so a new capability is covered with no edit', () => {
    // The point of reading App.entitlements instead of typing the list into the
    // yaml. A capability declared tomorrow is checked tomorrow, and the profile
    // that predates it is stale for the right reason with no change here.
    const declared = fixture('entitlements-complete.plist')
      .replace('</dict>', '\t<key>com.apple.developer.healthkit</key>\n\t<true/>\n</dict>');
    const r = run(PROFILE_STEP, {
      files: { 'App.entitlements': declared },
      profiles: { 'aaaa.mobileprovision': GOOD },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('  STALE, missing: com.apple.developer.healthkit');
  });

  shellTest('a missing entitlement is missing on either PlistBuddy stream', () => {
    for (const buddyErr of ['stdout', 'stderr']) {
      const r = withProfiles({ 'aaaa.mobileprovision': STALE }, 'entitlements-complete.plist', { buddyErr });
      expect({ buddyErr, code: r.code }).toEqual({ buddyErr, code: 1 });
      expect(r.out).toContain(`  STALE, missing: ${DOMAINS}`);
    }
  });
});
