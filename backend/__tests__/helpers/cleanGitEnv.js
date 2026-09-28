// THE ENVIRONMENT A TEST HANDS TO git, WITH NOTHING THAT POINTS AT A REPO.
//
// A git hook runs with GIT_DIR (and, in a linked worktree, GIT_INDEX_FILE,
// GIT_COMMON_DIR and friends) set for the repository being pushed. Every test
// the pre-push hook starts inherits them, and a child `git` that inherits them
// ignores its own cwd and works on THAT repository instead. A suite that builds
// a throwaway repo in a temp directory therefore rewrote the real one: its
// `git init` emptied the pushing worktree's index and its bare clone set
// core.bare=true in the shared config, which took every checkout of the repo
// out of service until the key was put back. Only a push from a linked
// worktree set the variables that way, which is why a push from the main
// checkout never showed it.
//
// So every GIT_* variable is dropped, and a caller adds back exactly the ones
// it means (GIT_CEILING_DIRECTORIES, for one).

function cleanGitEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/i.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

module.exports = { cleanGitEnv };
