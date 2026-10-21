/**
 * scripts/vercel-ignore-build.js decides whether Vercel builds a push. A
 * wrong "skip" leaves the live site on old code, so every case where it
 * cannot tell has to build.
 */
const { decide, NOT_THE_SITE } = require('../../scripts/vercel-ignore-build');
const vercel = require('../../vercel.json');

const never = () => {
  throw new Error('git should not run for this case');
};

describe('Vercel ignored build step', () => {
  test('vercel.json runs it', () => {
    expect(vercel.ignoreCommand).toBe('node scripts/vercel-ignore-build.js');
  });

  test('a branch other than main never builds', () => {
    expect(decide({ VERCEL_GIT_COMMIT_REF: 'feature/declared-age-range', VERCEL_GIT_PREVIOUS_SHA: 'abc12345' }, never).build).toBe(false);
  });

  test('main builds when there is no earlier deployment', () => {
    expect(decide({ VERCEL_GIT_COMMIT_REF: 'main' }, never).build).toBe(true);
    expect(decide({ VERCEL_GIT_COMMIT_REF: 'main', VERCEL_GIT_PREVIOUS_SHA: '' }, never).build).toBe(true);
  });

  test('main skips when nothing the site is built from changed', () => {
    const seen = [];
    const result = decide({ VERCEL_GIT_COMMIT_REF: 'main', VERCEL_GIT_PREVIOUS_SHA: 'cd856c11aa' }, (sha) => {
      seen.push(sha);
      return 0;
    });
    expect(result.build).toBe(false);
    expect(seen).toEqual(['cd856c11aa']);
  });

  test('main builds when the site changed', () => {
    expect(decide({ VERCEL_GIT_COMMIT_REF: 'main', VERCEL_GIT_PREVIOUS_SHA: 'cd856c11aa' }, () => 1).build).toBe(true);
  });

  test('main builds when git cannot compare (commit outside the shallow clone, or no exit code)', () => {
    expect(decide({ VERCEL_GIT_COMMIT_REF: 'main', VERCEL_GIT_PREVIOUS_SHA: 'cd856c11aa' }, () => 128).build).toBe(true);
    expect(decide({ VERCEL_GIT_COMMIT_REF: 'main', VERCEL_GIT_PREVIOUS_SHA: 'cd856c11aa' }, () => -1).build).toBe(true);
  });

  test('a deploy with no branch (CLI) is compared like main', () => {
    expect(decide({ VERCEL_GIT_PREVIOUS_SHA: 'cd856c11aa' }, () => 1).build).toBe(true);
    expect(decide({}, never).build).toBe(true);
  });

  test('every pathspec after "." only excludes', () => {
    expect(NOT_THE_SITE.length).toBeGreaterThan(0);
    for (const spec of NOT_THE_SITE) expect(spec.startsWith(':(exclude')).toBe(true);
  });
});
