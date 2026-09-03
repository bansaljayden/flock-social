#!/usr/bin/env bash
# Refresh the public mirror at github.com/bansaljayden/flock-social from this repo.
#
# WHY THIS EXISTS, AND WHY IT IS NOT A `git push` TO A SECOND REMOTE.
#
# The public repository is this repository with a set of paths erased from every
# commit that ever contained them -- the trained model, the old .env files, the
# Android debug keystore, and 56 MB of App Store screenshots. Erasing a path from
# history rewrites every commit after it, so the public history is a different
# chain of hashes from this one. There is no shared ancestor to push against.
#
# git-filter-repo is deterministic: the same input commits filtered with the same
# path list always produce the same output hashes. So re-running this after new
# work lands regenerates the identical hashes for every old commit and appends
# the new ones, and the push is an ordinary fast-forward. That property is the
# whole design, and it is why the path list below must not be edited casually --
# changing it renumbers the entire public history and turns every future push
# into a force-push.
#
# Nothing here touches the working repository. The filter runs on a throwaway
# copy under a temp directory, which is deleted on exit.
#
# THREE GATES, IN THIS ORDER, AND EACH ONE EXISTS BECAUSE THE ONE ABOVE IT IS
# NOT ENOUGH.
#
#   1. the strip list   removes whole PATHS from all history
#   2. redactions.txt   removes LITERALS from inside files that must stay
#   3. scan-secrets.py  refuses the push over anything credential-shaped that
#                       nobody listed, across every blob in every commit
#
# 1 and 2 only ever stop something already known. On 2026-08-25 a real reused
# personal password reached the public mirror because it was in neither list: it
# was a plain word with two digits substituted, inside a file that legitimately
# belongs in the repository, and gitleaks was green the entire six days it was
# public because that shape has no signature to key on. 3 exists for exactly
# that, and it is the only gate that can catch a secret nobody knew about. It
# adds about twenty seconds and it is not optional.
#
# Usage:  bash tools/publish/publish-public.sh          # push
#         bash tools/publish/publish-public.sh --dry-run  # build and report only

set -euo pipefail

# HTTPS, not SSH. This machine has no key pair at all: ssh -T git@github.com
# answers "Permission denied (publickey)" and ~/.ssh holds no public key, so the
# SSH form failed every time it was run and printed its error into a terminal
# nobody was reading. The private remote is HTTPS for the same reason, and gh
# has already configured git's credential helper to authenticate that way.
# Overridable for the workflow runner, which pushes with an SSH deploy key
# instead of this machine's HTTPS credential helper. Default unchanged.
PUBLIC_REMOTE="${PUBLISH_REMOTE:-https://github.com/bansaljayden/flock-social.git}"
REDACTIONS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/redactions.txt"
# Resolved HERE, before the cd into the throwaway mirror below, for the same
# reason REDACTIONS is: BASH_SOURCE is a relative path, so a $(cd dirname)
# evaluated after the cd would resolve against the mirror and silently miss.
MSG_REDACTIONS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/message-redactions.txt"
PUBLIC_REMOTE_HTTPS="$PUBLIC_REMOTE"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# Paths erased from all history. Adding to this list is a history rewrite; see above.
STRIP=(
  --path backend/scripts/ml/models/crowd_model.onnx
  --path backend/scripts/ml/models/model_metadata.json
  --path backend/.env
  --path frontend/.env.production
  --path mobile/android/app/debug.keystore
  --path frontend/public/birdie/flap-src.png
  --path frontend/public/birdie/birdie-idle.mp4
  --path-glob 'frontend/public/screenshots/appstore/*'
  # Private strategy docs (2026-08-19; Jayden chose to keep existing history as-is).
  # These were never committed anywhere; filtering them is a no-op on existing
  # hashes and exists purely so an accidental future commit cannot mirror.
  #
  # THIS LIST MUST TRACK THE PRIVATE BLOCK OF .gitignore. It is the second half
  # of a two-lock design: .gitignore stops the commit, this stops the mirror if
  # the commit happens anyway (a `git add -f`, a rewritten .gitignore, a merge).
  # A doc in .gitignore and absent here has one lock, not two -- and on
  # 2026-08-20 nine of them were in exactly that state, including all five
  # SECURITY-AUDIT-*.md, which .gitignore's own comment describes as
  # "step-by-step exploitation notes against production". Every path added here
  # has zero commits touching it, so filter-repo rewrites nothing and no public
  # hash moves; that is what makes closing the gap free.
  # redactions.txt names the very secrets it exists to remove, so it is the one
  # file in this repository that must never reach the mirror. It stays tracked
  # privately, because a fresh clone with no redactions file would silently skip
  # the redaction step and the guard would have nothing to check.
  --path tools/publish/redactions.txt
  --path tools/publish/message-redactions.txt
  # scan-allowlist.txt holds salted fingerprints, never plaintext, but a salted
  # hash of a short human-chosen password is one dictionary run from the
  # password, so it stays private for the same reason redactions.txt does. A
  # public clone without it simply reports the known-safe hits again, which is
  # the harmless direction to fail.
  --path tools/publish/scan-allowlist.txt
  --path PUBLIC-REPO-AUDIT.md
  --path VENUE-ADVISOR.md
  --path PAYMENTS-ROUTING.md
  --path MODEL-EPOCH-FINDING.md
  --path APPLE-2.1-REPLY.md
  --path OSS-SECRET-SCAN.md
  --path OSS-READINESS.md
  --path VENUE-TOS-DRAFT.md
  --path MAP-VISIBILITY-DECISION.md
  --path PRO-VS-PREMIUM.md
  --path ROOST-OWNER-INPUT.md
  --path PITCH.md
  --path PITCH-CRAFT.md
  --path VENUE-PRICING.md
  --path CONSUMER-VALUE-CASE.md
  --path PRESHIP-SWEEP.md
  # Jayden's call 2026-08-26: these two are tracked, so without this they would
  # reach the public mirror. Both state, honestly, how thin the crowd model is
  # right now (MODEL-METRICS.md carries the +0.04 realtime R2 and the 33.3
  # within-15; the ONNX weights and metadata JSON are already stripped above,
  # this is the prose that reads them). Fine internally, a number a venue owner
  # could quote back during outreach, so out of the public repo.
  --path backend/scripts/ml/MODEL-METRICS.md
  # frontend/public/SLOP-AUDIT.md is the design and weakness ledger, and it is
  # ALSO served live at flockcorp.com/SLOP-AUDIT.md because public/ is deployed.
  # Stripping it here keeps it out of the public GITHUB repo only. It does NOT
  # remove it from the live URL, which is a separate action: move it out of
  # public/ or block the path in vercel.json. See JAYDEN-TODO.md.
  --path frontend/public/SLOP-AUDIT.md
  # The root copy of that same document, and the one that carries the history:
  # eleven commits to the deployed copy's one. .gitignore keeps it tracked on
  # purpose, because it is cited from about a hundred places in the source, so
  # stripping only the public/ copy would have published it anyway. Same
  # reasoning as the line above. Nothing reads it from disk, so its absence
  # breaks no test in a public clone.
  --path SLOP-AUDIT.md
  # The end to end defect ledger. It is the working queue for the people fixing
  # things, which is what makes it worth keeping here and wrong to publish: a
  # running list of open items with owners reads as a description of the product
  # rather than as the ordinary engineering it is. The specs under tools/e2e
  # stay public, candid comments and all, because a test that names the bug it
  # pins is good work. The queue that tracks them does not.
  --path tools/e2e/FINDINGS.md
  # 2026-08-26. These three are why the list was reopened. All three are tracked,
  # all three are live in the mirror as it stands right now, and the pending
  # publish is a one-time history replace, which is the only moment at which
  # erasing them costs nothing instead of costing another force push. Nothing
  # reads any of them from disk; only MODERATION-LEGAL.md is read that way, and
  # it stays.
  #
  # BACKUP-AND-VERIFICATION.md is a disaster recovery runbook written to Jayden
  # in the second person. It names a personal cloud path on his own machine
  # holding a plaintext production dump, says which account's MFA is all that
  # protects it, and gives the offline storage plan in terms of where his
  # irreplaceable personal documents live. The last part is his private life and
  # the rest is a map. It stays tracked because it is the only restore procedure
  # that exists.
  --path BACKUP-AND-VERIFICATION.md
  # SUBMIT-CHECKLIST.md is a task board rather than a document: a legend of who
  # owns each row, a section of steps only Jayden can take, and a list of open
  # risks to settle before the next submission. Its value is that it is current,
  # which is exactly what makes it the wrong thing to hand a stranger.
  --path SUBMIT-CHECKLIST.md
  # VENUE-BILLING.md is the commercial working document, and the readers it
  # would reach in a public repository are the readers it argues about. It
  # also carries account and billing arrangements that are nobody else's
  # business. Withheld for that reason as well as the commercial one.
  --path VENUE-BILLING.md
  # PAYWALL.md, PAYWALL-DECISION.md and TASKS.md are working documents written
  # to Jayden in the second person, and their history described a relative's
  # role in the business down to whose bank details go where. On his
  # instruction (2026-09-03) only his own name is referenced anywhere public.
  # They stay tracked privately; erasing them from the mirror's history is the
  # one deliberate renumbering this list warns about, done with
  # PUBLISH_FORCE_RENUMBERED=1 on the same instruction.
  --path PAYWALL.md
  --path PAYWALL-DECISION.md
  --path TASKS.md
  --path-glob 'ADVISOR-*.md'
  --path-glob 'SECURITY-AUDIT-*.md'
  --path-glob 'VIDEO-NOTES-*.md'
  --path-glob 'REVIEW-ROUND*.md'
  --path-glob 'flock-walkthrough-*.mp4'
)

FILTER_REPO="$(python -c 'import git_filter_repo,os;print(git_filter_repo.__file__)' 2>/dev/null || true)"
if [ -z "$FILTER_REPO" ]; then
  echo "git-filter-repo is not installed.  pip install git-filter-repo" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> copying $SRC (the copy is what gets cut, never the original)"
git clone --no-local --no-hardlinks --quiet "$SRC" "$WORK/mirror"
cd "$WORK/mirror"

BEFORE_COMMITS="$(git rev-list --count HEAD)"

echo "==> erasing published-excluded paths from all history"
# --prune-empty=never keeps commits that contained ONLY stripped files. They
# become empty commits rather than disappearing, so the commit count and the
# contribution timeline match the private repo exactly. That is deliberate:
# this repo doubles as a record of how long the project has been worked on.
python "$FILTER_REPO" --force --invert-paths --prune-empty=never "${STRIP[@]}" >/dev/null

# ---------------------------------------------------------------------------
# REDACT SECRETS THAT LIVE INSIDE FILES THE REPO LEGITIMATELY KEEPS.
# ---------------------------------------------------------------------------
# The strip list above removes whole PATHS. It cannot help when the secret is a
# string inside a file that belongs in the repository, and on 2026-08-25 that
# is exactly what happened: a real password sat in three
# public commits inside backend/seeds/demo-data.js as the password for a real
# account. gitleaks was green throughout and structurally could not catch it,
# because a dictionary word inside bcrypt.hash() has no key-shaped signature.
#
# Every literal listed in redactions.txt is replaced across ALL history. Adding
# a line here renumbers every public hash, which is why this file and the strip
# list are both append-with-care, but a leaked credential is worth a force
# push and a rewritten public history.
if [ -s "$REDACTIONS" ]; then
  echo "==> redacting in-file secrets from all history"
  python "$FILTER_REPO" --force --replace-text "$REDACTIONS" >/dev/null

  # Prove it. Every literal on the left of ==> must appear in ZERO blobs across
  # every commit, not merely in the current tree. A surviving literal is a
  # refusal, because the whole point of this step is that the push is the last
  # moment anything can be caught.
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in '#'*) continue ;; esac
    literal="${line%%==>*}"
    [ -z "$literal" ] && continue
    # Pickaxe, not git grep over every rev: passing 995 commit ids as argv
    # overflows the command line and the script exits 126 before it can refuse.
    # -S counts occurrences per commit, so a literal that never exists anywhere
    # produces no commits at all.
    hits="$(git log --all --oneline -S"$literal" -- . 2>/dev/null | wc -l)"
    if [ "$hits" != "0" ]; then
      echo "REFUSING TO PUSH: redaction literal still present in $hits blob(s)" >&2
      exit 1
    fi
  done < "$REDACTIONS"
  echo "    redaction verified: every literal absent from all history"
fi

# COMMIT MESSAGES get the same treatment as blob content, and for the same
# person: the public history is read by non-engineers, and a message carrying
# raw funnel numbers, internal model figures, or a limitation phrased as a
# live defect hands a stranger a quote the code itself does not. The pairs
# live in message-redactions.txt (stripped from the mirror like its siblings).
# Verified the same way content redaction is: every left-hand side must be
# absent from every message afterwards, or the push is refused.
if [ -f "$MSG_REDACTIONS" ]; then
  echo "==> redacting commit messages"
  python "$FILTER_REPO" --force --replace-message "$MSG_REDACTIONS" >/dev/null
  MSG_FAILS=0
  while IFS= read -r line; do
    case "$line" in "#"*|"") continue ;; esac
    lhs="${line%%==>*}"
    [ -n "$lhs" ] || continue
    if git log --all --format=%B | grep -qF -- "$lhs"; then
      echo "    STILL PRESENT in a message: $lhs" >&2
      MSG_FAILS=$((MSG_FAILS+1))
    fi
  done < "$MSG_REDACTIONS"
  if [ "$MSG_FAILS" -gt 0 ]; then
    echo "REFUSING TO PUSH: $MSG_FAILS message redaction(s) did not take." >&2
    exit 1
  fi
  echo "    message redaction verified: every listed phrase absent from all messages"
fi

# ---------------------------------------------------------------------------
# SCAN FOR SECRETS NOBODY HAS LISTED YET.
# ---------------------------------------------------------------------------
# Everything above this line stops something already known: a path on the strip
# list, a literal in redactions.txt. The 2026-08-25 leak was neither. It was a
# real password nobody had thought to write down anywhere, in a file that
# legitimately belongs in the repository, in a shape gitleaks structurally
# cannot see.
#
# So the last gate is a scanner that judges values by the POSITION they sit in
# rather than by whether they look like a key, run over every blob in every
# commit of the filtered mirror. It runs AFTER the redaction pass, so a listed
# literal is already gone and only the unknown reaches it, and it exits non-zero
# on any finding, which refuses the push.
#
# Reading the allowlist from $SRC and not from the mirror is deliberate: the
# mirror has had it stripped by the filter above.
echo "==> scanning every blob in every commit for unlisted secrets"
if ! python "$SRC/tools/publish/scan-secrets.py" \
       --repo "$WORK/mirror" \
       --allowlist "$SRC/tools/publish/scan-allowlist.txt"; then
  echo "REFUSING TO PUSH: the secret scan above is not clean." >&2
  echo "Judge each finding. Real ones go in redactions.txt AND get rotated;" >&2
  echo "false ones go in scan-allowlist.txt with a reason. Nothing gets skipped." >&2
  exit 1
fi

AFTER_COMMITS="$(git rev-list --count HEAD)"
SIZE="$(git count-objects -vH | awk '/size-pack/{print $2, $3}')"

echo "==> verifying nothing excluded survived"
FAIL=0
PROVEN=0
# The second group is the internal-documents half of the strip list. Those paths
# have real commits behind them, unlike the strategy docs that were never
# committed, so a typo or a dropped line would silently publish them and the
# filter itself would report success. Anything on the strip list that ever
# existed in a commit belongs here, where its absence is proven rather than
# assumed.
for p in backend/scripts/ml/models/crowd_model.onnx backend/scripts/ml/models/model_metadata.json \
         backend/.env frontend/.env.production mobile/android/app/debug.keystore \
         tools/publish/redactions.txt tools/publish/scan-allowlist.txt \
         backend/scripts/ml/MODEL-METRICS.md frontend/public/SLOP-AUDIT.md \
         SLOP-AUDIT.md tools/e2e/FINDINGS.md BACKUP-AND-VERIFICATION.md \
         SUBMIT-CHECKLIST.md VENUE-BILLING.md; do
  n="$(git log --all --oneline -- "$p" | wc -l | tr -d ' ')"
  if [ "$n" != "0" ]; then echo "    LEAK: $p still in $n commits" >&2; FAIL=1
  else PROVEN=$((PROVEN + 1)); fi
done
n="$(git log --all --oneline -- 'frontend/public/screenshots/appstore' | wc -l | tr -d ' ')"
[ "$n" = "0" ] || { echo "    LEAK: appstore screenshots still in $n commits" >&2; FAIL=1; }
[ "$FAIL" = "0" ] || { echo "REFUSING TO PUSH" >&2; exit 1; }
# Say the number out loud. A check that only speaks when it fails is a check
# nobody can tell apart from a check that never ran, and this loop is the only
# proof that a path on the strip list is actually gone rather than merely typed.
echo "    proven absent from all history: $PROVEN paths, plus the appstore screenshots"

echo "    commits: $BEFORE_COMMITS -> $AFTER_COMMITS      size: $SIZE"

if [ "$DRY_RUN" = "1" ]; then
  echo "==> dry run, not pushing"
  exit 0
fi

echo "==> pushing to $PUBLIC_REMOTE_HTTPS"
git remote add public "$PUBLIC_REMOTE_HTTPS"
# Plain push, not --force. If this is rejected as non-fast-forward, the strip
# list changed and the whole public history was renumbered. Do not reach for
# --force without understanding why: it breaks every existing clone and every
# permalink anyone has to the public repo.
# PUBLISH_FORCE_RENUMBERED=1 is the sanctioned exception for exactly one
# situation: the strip list or a redaction changed, the whole public history is
# renumbered by construction, and Jayden has said to replace it. 2026-08-26 is
# that situation, on his instruction. force-with-lease against the tip we just
# fetched, never bare --force, so a push racing somebody else's still fails.
if [ "${PUBLISH_FORCE_RENUMBERED:-}" = "1" ]; then
  echo "==> RENUMBERED HISTORY: replacing public main (force-with-lease)"
  git fetch public main
  git push --force-with-lease=main public HEAD:main
else
  git push public HEAD:main
fi
echo "==> done"
