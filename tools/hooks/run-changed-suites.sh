#!/usr/bin/env bash
#
# THE TEST SUITES, RUN BEFORE A PUSH LEAVES THIS MACHINE.
#
# WHY THIS EXISTS. `.github/workflows/tests.yml` ran these three suites on
# every push to main. This repository is PRIVATE, so those minutes are billed,
# and on 2026-09-05 the account hit a payment hold: every run since failed in
# three seconds with "The job was not started because recent account payments
# have failed or your spending limit needs to be increased". A workflow that
# cannot start is not a gate, it is a red tick nobody can act on, so the push
# triggers were turned off and the work moved here.
#
# This is EARLIER feedback than CI, not later. A workflow tells you a bad push
# already happened; this refuses to let it leave.
#
# WHAT IT DOES NOT REPLACE, and this is the honest cost of the move. The CI
# job ran Node 20 while this machine runs Node 25, and that gap is the whole
# reason its header argues for keeping it: the first run found 52 backend
# failures that were green locally, none of them regressions, and two were
# real defects that only a second runtime could see (a collector that wrote no
# rows at midnight, and three suites that passed on a Node 21+ property of the
# event loop). Running here cannot see that class at all. If Node 20 is ever
# installed alongside, point the backend suite below at it and the gap comes
# back for nothing.
#
# SCOPED TO WHAT CHANGED, because a five thousand test backend suite on every
# frontend typo is a hook people learn to skip with --no-verify, and a hook
# that is always skipped protects nothing.
#
# Skip deliberately with `git push --no-verify`.

set -u

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

# What this push actually carries. With no upstream to compare against (a fresh
# clone, a new branch) everything runs, because "cannot tell" must not read as
# "nothing changed".
UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"
if [ -n "$UPSTREAM" ] && git rev-parse --verify --quiet "$UPSTREAM" >/dev/null; then
  CHANGED="$(git diff --name-only "$UPSTREAM"...HEAD)"
else
  echo "pre-push: no upstream to compare against, running everything"
  # ONE PER LINE. `touched()` greps with a start-of-line anchor, so a single
  # space-separated line matched ^frontend/ and nothing else: the fallback that
  # exists to run EVERYTHING ran the frontend suite alone and printed a pass.
  # That is the worst possible place for it, because the case it fires on is
  # the first push of a new branch, and this hook is now the only gate there is.
  CHANGED=$'frontend/\nbackend/\nflock-sensor/'
fi

touched() { echo "$CHANGED" | grep -q "^$1"; }

FAILED=""

if touched "flock-sensor/"; then
  echo "pre-push: sensor suite"
  ( cd flock-sensor && python -m unittest -q test_main.py ) || FAILED="$FAILED sensor"
fi

if touched "frontend/"; then
  echo "pre-push: frontend suite"
  ( cd frontend && CI=true npx react-scripts test --watchAll=false ) || FAILED="$FAILED frontend"

  # THE BUILD IS A SEPARATE GATE FROM THE TESTS, and it has caught things the
  # tests cannot: Vercel builds with CI=true, which turns an eslint warning
  # into a failure, and `import/first` and `no-undef` are not gates Jest runs.
  # A build that fails leaves the previous deployment live and says nothing, so
  # the live site silently keeps the old bundle. That happened for seven
  # commits on 2026-09-05.
  echo "pre-push: frontend production build"
  ( cd frontend && CI=true npx react-scripts build >/dev/null ) || FAILED="$FAILED frontend-build"
fi

if touched "backend/"; then
  # Runs alone on purpose: the suite starts embedded PostgreSQL instances and
  # contends with itself when anything else is using the machine's cores, which
  # shows up as a file-level failure with no failing test inside it.
  echo "pre-push: backend suite (this one is long)"
  # RUN IT, AND IF IT FAILS RUN IT ONCE MORE.
  #
  # Not indulgence. The suite starts embedded PostgreSQL instances, and when
  # the machine is still busy it fails at the FILE level: the file never gets
  # far enough to run a test, so the tally reads "5373 pass, 3 fail" with three
  # failures that name files and no test inside any of them. The frontend suite
  # and the production build run immediately above this, and their workers are
  # still exiting when this starts, which is precisely when it happens.
  #
  # A gate that refuses valid pushes is worse than the flake it is reporting,
  # because the way people learn to get past it is --no-verify, and then it
  # catches nothing at all. So a first failure buys a second run on a quieter
  # machine rather than a refusal.
  #
  # A REAL failure still fails, it just costs twice. That is the right trade
  # for the thing standing between a mistake and origin/main.
  if ( cd backend && npm test ); then
    :
  else
    echo "pre-push: backend suite failed once. Re-running on a quieter machine"
    echo "pre-push: (a file-level failure with no failing test inside it is contention, not a break)"
    ( cd backend && npm test ) || FAILED="$FAILED backend"
  fi
fi

if [ -n "$FAILED" ]; then
  echo ""
  echo "pre-push: REFUSED. Failing:$FAILED"
  echo "pre-push: fix it, or push with --no-verify if you know why it is failing."
  exit 1
fi

if [ -z "$CHANGED" ]; then
  echo "pre-push: nothing under frontend, backend or flock-sensor changed"
fi
exit 0
