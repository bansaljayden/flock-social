#!/usr/bin/env python3
"""Refuse the public mirror push when an unlisted secret is anywhere in its history.

WHY THIS EXISTS.

On 2026-08-25 a real password sat in three public commits inside
backend/seeds/demo-data.js, as the argument to bcrypt.hash(), as the login
password for a real account. It was public for six days and the repository had to
be deleted and rebuilt.

Every protection in place failed, and all of them failed the same way:

  .gitignore          stops whole FILES.  demo-data.js belongs in the repo.
  the mirror strip    stops whole PATHS.  same problem.
  gitleaks            stops key-SHAPED strings.  a dictionary word with two digit
                      substitutions has no prefix, no delimiter and no entropy
                      spike, so gitleaks was green the entire time and always
                      would have been.
  redactions.txt      stops literals SOMEBODY ALREADY KNEW ABOUT.  the entire
                      failure mode was not knowing.

So this scanner does not primarily look for strings that look like keys. It looks
for strings sitting in the POSITION of a credential and then judges the value,
which is the only way the password that actually leaked could have been caught.

WHAT IT READS.

Every blob reachable from every commit, not the current tree, deduplicated by
object id so a file that never changed across a thousand commits is read once. In
the publish script it runs on the filtered mirror AFTER the path strip and the
redaction pass, which is the last moment anything can be stopped.

HOW A FINDING IS MEANT TO BE HANDLED.

A scanner that cries wolf gets bypassed, and a bypassed scanner is worse than no
scanner. So every finding prints the file, the commit, the line number, a
REDACTED excerpt and the reason the value was judged credential-shaped, which is
enough to decide in seconds. If the finding is real, add the literal to
redactions.txt and rotate the credential. If it is not, paste the printed allow:
line into scan-allowlist.txt WITH A REASON. There is no blanket ignore and no
--force.

Usage:
  python tools/publish/scan-secrets.py                        # scan this repo
  python tools/publish/scan-secrets.py --repo PATH            # scan a clone
  python tools/publish/scan-secrets.py --allowlist PATH
  python tools/publish/scan-secrets.py --head-only            # tree, not history
  python tools/publish/scan-secrets.py --stats                # timing breakdown

Exit codes:  0 clean,  1 findings (refuse the push),  2 the scanner itself broke.
A scanner that cannot run must never be read as a pass, which is why 2 is not 0.
"""

import argparse
import base64
import binascii
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
from collections import defaultdict

# ---------------------------------------------------------------------------
# What we refuse to even read.
# ---------------------------------------------------------------------------

# Binary by extension, checked before the blob is read so that 600 MB of
# screenshots and model weights never cross the pipe. Anything not listed is
# still checked for NUL bytes after reading, so a mislabelled binary is never
# scanned as though it were text.
BINARY_EXT = {
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns', '.tiff',
    '.mp4', '.mov', '.avi', '.webm', '.mp3', '.wav', '.m4a', '.aac',
    '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.onnx', '.pb', '.pt', '.pth', '.h5', '.pkl', '.npy', '.npz', '.tflite',
    '.keystore', '.jks', '.p12', '.pfx', '.mobileprovision',
    '.so', '.dylib', '.dll', '.exe', '.node', '.wasm', '.class', '.o', '.a',
    '.db', '.sqlite', '.sqlite3', '.bin', '.dat', '.xcuserstate', '.car',
}

# 4 MB. Larger text blobs are scanned to the cap and the truncation is COUNTED
# and PRINTED, never silently swallowed, because a gap you cannot see is the
# thing this whole file exists to prevent.
MAX_SCAN_BYTES = 4 * 1024 * 1024

# ---------------------------------------------------------------------------
# Placeholder vocabulary.  This is the heart of the discrimination.
# ---------------------------------------------------------------------------
#
# Password1, demo123 and hunter2 have exactly the shape of a real chosen
# password: mixed case, a digit, eight-ish characters. So did the one that
# leaked. Shape alone therefore cannot separate them, and a scanner that tries
# is either silent on real passwords or screaming on every fixture.
#
# Cr0ut0n5 below stands in for the password that leaked and is invented. It has
# the same construction, and the real literal is deliberately not written
# anywhere in this repository except redactions.txt, which never ships.
#
# What separates them is the WORD. A placeholder is assembled out of words whose
# whole job is to say "this is not real". So a value is split on punctuation and
# every word must reduce, either by deleting its digits or by reading them as
# leetspeak, to a placeholder word or a run of placeholder words:
#
#   Password1     -> password           -> placeholder
#   WrongPass1    -> wrong + pass       -> placeholder
#   hunter2       -> hunter             -> placeholder
#   changeme      -> change + me        -> placeholder
#   Passw0rdish   -> password + ish     -> placeholder (leetspeak reading)
#   Cr0ut0n5      -> crouton / croutons -> NEITHER, refuse
#   Tr0ub4dor&3xK -> troubador, exk     -> NEITHER, refuse
#
# EVERY word has to match, not just one, so Cr0ut0n5-test is still refused.
#
# This is a curated vocabulary and deliberately not an English dictionary. Under
# a full dictionary the digit-deleting reading of Cr0ut0n5 is "crouton", a real
# word, and the exact password that caused this file to exist would be waved
# through. The cost of curation is that an unfamiliar fixture word occasionally
# has to be added here or allowlisted, which is a person spending ten seconds.
#
# The project's own words are deliberately ABSENT. "flock" and "birdie" are not
# placeholders: Flock2026! is a plausible real password and must never be waved
# through because the product happens to be called Flock.
PLACEHOLDER_WORDS = {
    # explicitly not-real
    'placeholder', 'changeme', 'change', 'replaceme', 'replace', 'fillme',
    'yourpassword', 'your', 'here', 'insert', 'todo', 'fixme', 'notreal',
    'redacted', 'removed', 'scrubbed', 'sanitized', 'stripped', 'omitted',
    'nothing', 'none', 'null', 'nil', 'undefined', 'empty', 'blank', 'never',
    'invalid', 'valid', 'expired', 'bogus', 'garbage', 'nonsense', 'whatever',
    'stolen', 'leaked', 'guess', 'guessed', 'wrong', 'right', 'correct',
    'incorrect', 'unknown', 'missing', 'ignored',
    # test vocabulary
    'test', 'tests', 'testing', 'tester', 'unit', 'spec', 'fixture', 'fixtures',
    'mock', 'mocked', 'stub', 'fake', 'dummy', 'sample', 'example', 'demo',
    'seed', 'seeded', 'scratch', 'sandbox', 'ci', 'jest', 'mocha', 'pytest',
    'harness', 'suite', 'case', 'cases', 'assert', 'expect', 'given', 'when',
    'before', 'after', 'setup', 'teardown', 'review', 'screenshot', 'screen',
    'shot', 'sneaky', 'attacker', 'victim', 'evil', 'good', 'bad', 'happy',
    'sad', 'winner', 'loser', 'try', 'attempt', 'retry', 'replay', 'again',
    # environment and service vocabulary
    'local', 'localhost', 'dev', 'develop', 'development', 'staging', 'stage',
    'prod', 'production', 'preview', 'docker', 'compose', 'env', 'environment',
    'config', 'configured', 'configure', 'default', 'postgres', 'postgresql',
    'pg', 'mysql', 'mariadb', 'redis', 'mongo', 'mongodb', 'sqlite', 'rabbitmq',
    'amqp', 'sha', 'md', 'dead', 'beef', 'cafe', 'babe', 'phone', 'address',
    # credential nouns, which a placeholder names outright
    'password', 'passwd', 'pass', 'pwd', 'passphrase', 'secret', 'token', 'tok',
    'key', 'apikey', 'api', 'credential', 'credentials', 'auth', 'login',
    'signin', 'session', 'bearer', 'jwt', 'hash', 'hashed', 'salt', 'sign',
    'signed', 'signature', 'nonce', 'code', 'client', 'server', 'app', 'web',
    'link', 'invite', 'grant', 'scope', 'claim',
    # role nouns
    'admin', 'administrator', 'root', 'user', 'username', 'guest', 'owner',
    'member', 'account', 'someone', 'anyone', 'nobody', 'person', 'name',
    'email', 'mail', 'temp', 'tmp', 'throwaway', 'burner', 'sibling', 'brand',
    'banned', 'unbanned', 'retired', 'moved', 'move', 'welded', 'weld',
    # the classic bad passwords, jokes in a fixture rather than secrets
    'letmein', 'hunter', 'qwerty', 'asdf', 'asdfgh', 'zxcvbn', 'iloveyou',
    'monkey', 'dragon', 'welcome', 'sunshine', 'football', 'baseball',
    'princess', 'shadow', 'master', 'trustno', 'abc', 'abcd', 'xyz',
    'aaa', 'bbb', 'xxx', 'yyy', 'zzz', 'foo', 'bar', 'baz', 'qux', 'quux',
    'hello', 'world', 'string', 'value', 'data', 'thing', 'stuff', 'other',
    'horse', 'battery', 'staple',
    # glue, so a run-together placeholder decomposes cleanly
    'my', 'the', 'a', 'an', 'is', 'it', 'for', 'and', 'of', 'in', 'on', 'to',
    'with', 'no', 'not', 'do', 'dont', 'use', 'used', 'new', 'old', 'real',
    'super', 'very', 'only', 'just', 'this', 'that', 'from', 'at', 'by', 'as',
    'be', 'so', 'up', 'out', 'off', 'has', 'had', 'was', 'are', 'all', 'any',
    'x', 'y', 'z', 'ish', 'ing', 'ed', 'er', 'able', 'less', 'full',
    'verification', 'verify', 'verified', 'refresh', 'access', 'reset',
    'signup', 'signing', 'different', 'same', 'one', 'two', 'three', 'first',
    'second', 'third', 'fourth', 'next', 'last', 'current', 'original', 'copy',
}

# ---------------------------------------------------------------------------
# Cheap literal triggers.
# ---------------------------------------------------------------------------
#
# The detailed regexes below are far too slow to run over 450 MB of blob text:
# an early version of this file took seven minutes, which is exactly the kind of
# number that gets a safety check commented out. So each blob is first swept
# with plain lowercase substring searches, which run at memchr speed, and the
# expensive patterns only ever see the handful of lines around a hit.
CRED_TRIGGERS = (
    b'password', b'passwd', b'pwd', b'passphrase', b'secret', b'token',
    b'apikey', b'api_key', b'api-key', b'privatekey', b'private_key',
    b'private-key', b'accesskey', b'access_key', b'credential',
    b'bcrypt', b'hashsync', b'createhash', b'argon2', b'scrypt', b'pbkdf2',
    b'hashpassword', b'makepassword',
)
PREFIX_TRIGGERS = (
    b'sk-', b'k_live_', b'aiza', b'ghp_', b'gho_', b'ghs_', b'ghu_', b'ghr_',
    b'github_pat_', b'whsec_', b'akia', b'asia', b'xox', b'sg.',
    b'-----begin', b'eyj',
)
# One scan for '://' covers every connection-string scheme and one scan for '@'
# covers every mail domain, so twenty domain literals cost one memchr pass
# instead of twenty.
SCHEME_TAIL = (
    b'postgres', b'postgresql', b'mysql', b'mariadb', b'mongodb',
    b'mongodb+srv', b'redis', b'rediss', b'amqp', b'amqps',
)

# How much context around a trigger the detailed patterns get. Three lines each
# way, because prettier routinely puts a bcrypt.hash argument on its own line
# and a one-line window would miss the exact shape that leaked.
WINDOW_LINES = 3

# ---------------------------------------------------------------------------
# Detailed patterns.
# ---------------------------------------------------------------------------

# A quoted literal, written out per quote character. The obvious
# (?P<q>["'`])(?:(?!(?P=q)).)* form backtracks per character and was measurably
# the slowest thing in this file.
QUOTED = r'''(?:"(?P<vd>[^"\r\n]{1,256})"|'(?P<vs>[^'\r\n]{1,256})'|`(?P<vb>[^`\r\n]{1,256})`)'''


def quoted_value(m):
    return m.group('vd') or m.group('vs') or m.group('vb')


def quoted_start(m):
    for g in ('vd', 'vs', 'vb'):
        if m.group(g) is not None:
            return m.start(g)
    return m.start()


# Names that make the string beside them a credential by position.
CRED_NAME = (
    r'(?:pass_?phrase|passphrase|password|passwd|pwd|'
    r'client_?secret|app_?secret|shared_?secret|secret_?key|secret|'
    r'private_?key|priv_?key|encryption_?key|signing_?key|'
    r'api_?key|apikey|access_?key|auth_?token|access_?token|refresh_?token|'
    r'id_?token|session_?token|bearer_?token|token|credential)'
)

RE_ASSIGN = re.compile(
    r'(?P<name>[A-Za-z0-9_.\-]{0,32}' + CRED_NAME + r'[A-Za-z0-9_.\-]{0,16})'
    r'["\']?\s*\]?\s*(?::|=>?|:=)\s*' + QUOTED,
    re.IGNORECASE,
)

# The unquoted form, for .env files, shell exports, compose files and CI yaml.
# The value must run to the end of the line and must not contain the punctuation
# of an expression, because in a .js file "const t = readToken();" is an
# assignment to a credential-shaped name whose value is a function call, and an
# earlier version of this scanner reported nineteen of those.
RE_ASSIGN_BARE = re.compile(
    r'^[ \t]*(?:export[ \t]+|-[ \t]+)?'
    r'(?P<name>[A-Za-z0-9_.\-]{0,32}' + CRED_NAME + r'[A-Za-z0-9_.\-]{0,16})'
    r'[ \t]*[:=][ \t]*(?P<val>[^\r\n#,;(){}\[\]<>]{1,256})[ \t]*$',
    re.IGNORECASE | re.MULTILINE,
)

# Where an unquoted NAME=value line is a configuration statement rather than
# code. Everywhere else it is almost always an expression.
BARE_ASSIGN_EXT = (
    '.env', '.yml', '.yaml', '.sh', '.bash', '.zsh', '.fish', '.ini', '.cfg',
    '.conf', '.config', '.properties', '.toml', '.tf', '.tfvars', '.md',
    '.txt', '.service', '.gradle', '.editorconfig', '.example', '.sample',
    '.tmpl', '.template', '.dist',
)
BARE_ASSIGN_NAMES = ('dockerfile', 'makefile', 'procfile', 'justfile', '.env')

# The exact shape that leaked.
RE_HASH_CALL = re.compile(
    r'\b(?P<fn>bcrypt(?:js)?\s*\.\s*hash(?:Sync)?|argon2\s*\.\s*hash|'
    r'scrypt(?:Sync)?|pbkdf2(?:Sync)?|hashPassword|makePassword)'
    r'\s*\(\s*' + QUOTED,
    re.IGNORECASE,
)

# crypto.createHash('sha256').update('<the secret>'). createHash digests all
# sorts of things that are not credentials (a phone number, a device id), so
# this only fires when the line itself is about a credential.
RE_CREATE_HASH = re.compile(
    r'createHash\s*\(\s*["\'][a-z0-9]+["\']\s*\)\s*\.\s*update\s*\(\s*' + QUOTED,
    re.IGNORECASE,
)
RE_PASSWORD_CONTEXT = re.compile(r'(password|passwd|passphrase|secret|pwd)', re.IGNORECASE)

PREFIX_RULES = [
    ('openai_key',        r'\bsk-(?:proj-|ant-|live-)?[A-Za-z0-9_\-]{20,}'),
    ('stripe_live_key',   r'\b[prs]k_live_[A-Za-z0-9]{16,}'),
    ('google_api_key',    r'\bAIza[0-9A-Za-z_\-]{35}\b'),
    ('github_token',      r'\bgh[pousr]_[A-Za-z0-9]{30,}\b'),
    ('github_pat',        r'\bgithub_pat_[A-Za-z0-9_]{40,}\b'),
    ('stripe_webhook',    r'\bwhsec_[A-Za-z0-9]{24,}\b'),
    ('aws_access_key',    r'\b(?:AKIA|ASIA)[0-9A-Z]{16}\b'),
    ('slack_token',       r'\bxox[baprs]-[A-Za-z0-9\-]{10,}'),
    ('sendgrid_key',      r'\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}'),
    ('private_key_block', r'-----BEGIN [A-Z ]*PRIVATE KEY-----'),
    ('jwt',               r'\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}'),
]
PREFIX_RULES = [(n, re.compile(p)) for n, p in PREFIX_RULES]

RE_CONN = re.compile(
    r'\b(?P<scheme>postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis[s]?|amqp[s]?)'
    r'://(?P<user>[^:@/\s"\'`<>]{1,64}):(?P<pw>[^@/\s"\'`<>]{1,128})@(?P<host>[^/\s"\'`:?]{1,255})',
    re.IGNORECASE,
)

# Hosts where a credential is a local convention, not a leak. A compose file's
# postgres:postgres@db is not a secret and never was.
LOCAL_HOSTS = {
    'localhost', '127.0.0.1', '0.0.0.0', '::1', 'db', 'database', 'postgres',
    'postgresql', 'mysql', 'mariadb', 'redis', 'mongo', 'mongodb', 'rabbitmq',
    'host.docker.internal', 'test-db', 'testdb', 'local',
}

RE_EMAIL = re.compile(r'\b[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,255}\.[A-Za-z]{2,24}\b')
RE_CRED_WORD_NEARBY = re.compile(
    r'(?:password|passwd|pwd|passphrase|secret|api_?key|apikey|'
    r'auth_?token|access_?token|bcrypt|\.hash\(|credential)',
    re.IGNORECASE,
)

# Entropy candidates: long unbroken base64url-ish runs.
#
# '/' is deliberately NOT in the class even though standard base64 uses it.
# With it in, every URL path longer than 28 characters is a candidate, and on
# this repository that alone was five of the sixteen entropy hits. '=' is
# allowed only as trailing padding, which is the only place base64 puts it, and
# excluding it mid-token drops shell and systemd lines like
# Environment=PYTHONUNBUFFERED=1.
RE_TOKENISH = re.compile(rb'[A-Za-z0-9+_\-]{28,120}={0,2}')

# Paths where a long random-looking string is a build artefact rather than a
# secret. These exclusions apply to the ENTROPY detector only. The prefix,
# connection-string and credential-position detectors still run over every one
# of these files, because a real AWS key pasted into package-lock.json is still
# a real AWS key.
ENTROPY_SKIP_SUBSTR = (
    'node_modules/', 'dist/', 'build/', '/vendor/', '.next/', 'coverage/',
    'ios/app/pods/', 'android/.gradle/', '__snapshots__/', '/pods/',
    'public/static/', '/.yarn/', 'seo-audit/raw/',
)
ENTROPY_SKIP_SUFFIX = (
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json',
    'gemfile.lock', 'podfile.lock', 'package.resolved', 'poetry.lock',
    'composer.lock', 'cargo.lock', 'go.sum', 'flake.lock',
    '.min.js', '.min.css', '.map', '.svg', '.csv', '.tsv', '.ipynb',
    '.pbxproj', '.xcworkspacedata', '.geojson', '.har', '.lock', '.html',
)
# Line level: an integrity hash, an inlined asset or a source map is never a
# credential, however random it looks.
RE_ENTROPY_LINE_SKIP = re.compile(
    r'(integrity|sha512-|sha384-|sha256-|base64,|data:image|data:font|'
    r'data:application|sourceMappingURL|srcset=|"resolved":|checksum|'
    r'\bdigest\b|\betag\b|"hash":|"revision":|X-Amz-Signature|blurhash|'
    r'<svg|<path|\bd="M|viewBox)',
    re.IGNORECASE,
)
# A random secret is random bytes. A base64 string that decodes back into
# readable ASCII is encoded TEXT, which is what test fixtures and data URIs are
# made of, so it is not treated as a secret.
ENTROPY_MIN_DIGIT_FRACTION = 0.12
ENTROPY_MIN_BITS = 4.2

RE_UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)
RE_BCRYPT_HASH = re.compile(r'^\$2[abxy]?\$\d{2}\$')
RE_ALLCAPS_NAME = re.compile(r'^[A-Z][A-Z0-9_]{2,}$')
RE_NUMERIC = re.compile(r"^[+\-]?[0-9][0-9_,.']*$")
RE_PHONE = re.compile(r'^\+?[0-9][0-9 ()\-.]{6,19}$')
RE_TEMPLATE = re.compile(
    r'(\$\{|\{\{|<%|%\(|%s\b|%d\b|#\{|\bprocess\.env\b|\bos\.environ|'
    r'\bgetenv\b|\bENV\[|import\.meta\.env|\bSecret\(|\bsecrets\.|'
    r'\bnew [A-Z]|\bawait\b|\brequire\(|=>)',
    re.IGNORECASE,
)
RE_PATHISH = re.compile(
    r'(^\.{0,2}/|://|^[A-Za-z]:\\|'
    r'\.(?:js|jsx|ts|tsx|json|md|sql|png|jpg|jpeg|svg|css|html|py|sh|yml|yaml|txt|onnx)$)')
RE_HEXDIGEST = re.compile(r'^[0-9a-f]{32,}$', re.I)
RE_WORDY = re.compile(r'^[A-Za-z][a-z]+(?:[ ._\-][A-Za-z][a-z]+){2,}$')

# An all-lowercase kebab or snake case string is a machine-readable NAME, and
# the fourteen remaining false positives on this repository were all of that
# shape: apple-refresh, bcrypt-hash, e2e-test-secret, push-454-test-secret,
# trust-sweep-revenuecat-shared-secret-012.
#
# Two guards keep this from becoming a hole. The value must be lowercase
# throughout, so Cr0ut0n5-test does NOT qualify and is still refused; and at
# least one segment must be a word that only ever appears in a name FOR a
# credential rather than in a credential. A diceware passphrase like
# correct-horse-battery-staple has the slug shape but carries no such marker,
# so it is still refused.
RE_SLUG = re.compile(r'^[a-z0-9]+(?:[-_.][a-z0-9]+)+$')
SLUG_MARKERS = {
    'test', 'tests', 'testing', 'demo', 'example', 'sample', 'fake', 'dummy',
    'mock', 'stub', 'fixture', 'seed', 'sandbox', 'scratch', 'placeholder',
    'local', 'localhost', 'dev', 'development', 'staging', 'prod', 'production',
    'secret', 'token', 'key', 'password', 'passwd', 'pwd', 'passphrase', 'hash',
    'auth', 'jwt', 'api', 'apikey', 'credential', 'session', 'refresh',
    'access', 'bearer', 'signature', 'salt', 'pepper', 'nonce', 'e2e', 'ci',
    'smoke', 'boot', 'unit', 'spec', 'original', 'not', 'real', 'none', 'null',
    'unused', 'ignored', 'redacted', 'changeme', 'notreal',
}

LEET = str.maketrans({'0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's',
                      '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i'})

# Allowlist fingerprints are salted, and the allowlist file is stripped from the
# mirror, for the same reason redactions.txt is: an unsalted sha256 of a short
# human-chosen password is one dictionary run away from the password.
ALLOW_SALT = b'flock-publish-secret-scan-v1'

# Mailboxes that belong to whoever wrote this history, filled in from git's own
# author and committer records at startup. See detect_email_with_credential.
OWNER_EMAILS = set()
MAIL_TRIGGER_TAIL = ()


# ---------------------------------------------------------------------------
# Value judgement
# ---------------------------------------------------------------------------

def _decomposes_into_placeholders(word):
    """True when the word is built entirely out of placeholder words.

    changeme -> change + me.  testpassword -> test + password.  croutons -> no.
    """
    if not word:
        return True
    n = len(word)
    if n > 40:
        return False
    reachable = [False] * (n + 1)
    reachable[0] = True
    for i in range(n):
        if not reachable[i]:
            continue
        for j in range(i + 1, n + 1):
            if not reachable[j] and word[i:j] in PLACEHOLDER_WORDS:
                reachable[j] = True
    return reachable[n]


def looks_like_an_alphabet(v):
    """True for charset constants: abcdefgh..., ABCDEFGHJKLMN...abcdefghjk...

    Alphabet constants are long, mixed-case and full of digits, which is every
    signal a random secret has. They are also strictly ascending, which no real
    secret is.
    """
    letters = [c.lower() for c in v if c.isalpha()]
    if len(letters) < 8:
        return False
    restarts = 1
    for a, b in zip(letters, letters[1:]):
        if b <= a:
            restarts += 1
            if restarts > 2:
                return False
    return True


def decodes_to_readable_text(token):
    """True when a base64-ish token is just encoded ASCII text.

    A real random secret decodes to bytes that are mostly unprintable. A fixture
    like QmFzZTY0dXJsVmVyaWZpZXJfLTAxMjM decodes to 'Base64urlVerifier_-0123',
    which is a sentence, not a secret.
    """
    s = token.replace('-', '+').replace('_', '/')
    s += '=' * (-len(s) % 4)
    try:
        raw = base64.b64decode(s, validate=True)
    except (binascii.Error, ValueError):
        return False
    if len(raw) < 8:
        return False
    printable = sum(1 for b in raw if 32 <= b < 127 or b in (9, 10, 13))
    return printable / len(raw) >= 0.9


def is_placeholder_value(val):
    """Return a reason string when the value is obviously not a real credential.

    Returning None means "this could be a real one", which is what refuses a push.
    """
    v = val.strip().strip('\'"`')
    if len(v) < 8:
        # Below the floor of anything a human picks for a real account. test,
        # xxx, abc and 1234 all live here. Stated plainly so the gap stays
        # visible: a genuine seven-character password would not be caught.
        return 'shorter than 8 characters'
    if any(c.isspace() for c in v):
        return 'contains whitespace, reads as prose not a credential'
    if RE_TEMPLATE.search(v):
        return 'interpolated, computed, or read from the environment at runtime'
    if v.startswith('<') and v.endswith('>'):
        return 'angle-bracket placeholder'
    if RE_BCRYPT_HASH.match(v):
        return 'already a bcrypt digest, not a plaintext'
    if RE_UUID.match(v):
        return 'uuid'
    if RE_NUMERIC.match(v):
        return 'numeric literal'
    if RE_PHONE.match(v):
        return 'telephone number'
    if RE_PATHISH.search(v):
        return 'path, url or filename'
    if v.count('@') == 1 and '.' in v.rpartition('@')[2]:
        return 'email address, not a password'
    if len(set(v)) <= 2:
        return 'one or two distinct characters'
    if RE_ALLCAPS_NAME.match(v):
        return 'reads as a variable or constant name, not a value'
    if RE_HEXDIGEST.match(v):
        return 'hex digest'
    if looks_like_an_alphabet(v):
        return 'an alphabet or charset constant, not a secret'
    if RE_WORDY.match(v):
        return 'three or more ordinary words, reads as a description'
    if RE_SLUG.match(v):
        marked = [seg for seg in re.split(r'[-_.]', v) if seg in SLUG_MARKERS]
        if marked:
            return ('lowercase %s name whose %r segment only ever names a '
                    'credential rather than being one' % ('-' if '-' in v else '_', marked[0]))

    words = [w for w in re.split(r'[^A-Za-z0-9]+', v) if w]
    if not words:
        return 'no alphanumeric content'
    for w in words:
        if w.isdigit() or len(w) <= 2:
            continue
        low = w.lower()
        readings = {re.sub(r'[^a-z]', '', low),
                    re.sub(r'[^a-z]', '', low.translate(LEET))}
        if not any(r and (r in PLACEHOLDER_WORDS or _decomposes_into_placeholders(r))
                   for r in readings):
            return None
    return 'every word in it is a placeholder word'


_ENTROPY_CACHE = {}


def shannon(s):
    cached = _ENTROPY_CACHE.get(s)
    if cached is not None:
        return cached
    counts = defaultdict(int)
    for c in s:
        counts[c] += 1
    n = float(len(s))
    total = 0.0
    for c in counts.values():
        p = c / n
        total -= p * math.log2(p)
    if len(_ENTROPY_CACHE) < 100000:
        _ENTROPY_CACHE[s] = total
    return total


def looks_like_a_real_jwt(tok):
    """True when the first segment really is a JOSE header.

    Every JWT starts with a base64url JSON object carrying alg or typ. A test
    fixture like eyJaaaaaaaaaaaa.eyJaaaaaaaaaaaa.aaaaaaaa has the shape and not
    the content, and this repository has two of them in one telemetry test.
    """
    head = tok.split('.')[0]
    head += '=' * (-len(head) % 4)
    try:
        raw = base64.urlsafe_b64decode(head)
        obj = json.loads(raw.decode('utf-8'))
    except Exception:
        return False
    return isinstance(obj, dict) and bool({'alg', 'typ', 'kid', 'enc'} & set(obj))


def redact(secret):
    n = len(secret)
    if n <= 6:
        return '*' * n
    return secret[:2] + '*' * (n - 4) + secret[-2:]


def fingerprint(detector, secret):
    h = hashlib.sha256(ALLOW_SALT + b'|' + detector.encode()
                       + b'|' + secret.encode('utf-8', 'replace'))
    return h.hexdigest()[:16]


# ---------------------------------------------------------------------------
# Findings
# ---------------------------------------------------------------------------

class Finding:
    __slots__ = ('detector', 'path', 'blob', 'offset', 'secret', 'why',
                 'excerpt', 'line', 'commit')

    def __init__(self, detector, path, blob, offset, secret, why, excerpt, line):
        self.detector = detector
        self.path = path
        self.blob = blob
        self.offset = offset
        self.secret = secret
        self.why = why
        self.excerpt = excerpt
        self.line = line
        self.commit = None

    @property
    def key(self):
        return '%s:%s' % (self.detector, fingerprint(self.detector, self.secret))


# ---------------------------------------------------------------------------
# Detectors.  Each takes a decoded window plus the blob's path and yields
# (detector, offset_in_window, secret, why).
# ---------------------------------------------------------------------------

def bare_assign_applies(path):
    low = os.path.basename(path.replace('\\', '/')).lower()
    if low.startswith(BARE_ASSIGN_NAMES) or '.env' in low:
        return True
    return low.endswith(BARE_ASSIGN_EXT) or '.' not in low


def line_around(win, pos):
    start = win.rfind('\n', 0, pos) + 1
    end = win.find('\n', pos)
    return win[start:end if end != -1 else len(win)]


def detect_credential_position(win, path):
    for m in RE_HASH_CALL.finditer(win):
        val = quoted_value(m)
        if val is None or is_placeholder_value(val):
            continue
        fn = re.sub(r'\s+', '', m.group('fn'))
        yield ('credential_literal', quoted_start(m), val,
               'string argument to %s() and not a recognizable placeholder' % fn)

    for m in RE_CREATE_HASH.finditer(win):
        val = quoted_value(m)
        if val is None or is_placeholder_value(val):
            continue
        if not RE_PASSWORD_CONTEXT.search(line_around(win, m.start())):
            continue
        yield ('credential_literal', quoted_start(m), val,
               'string fed to createHash().update() on a password line '
               'and not a recognizable placeholder')

    for m in RE_ASSIGN.finditer(win):
        val = quoted_value(m)
        if val is None or is_placeholder_value(val):
            continue
        yield ('credential_literal', quoted_start(m), val,
               'assigned to %r and not a recognizable placeholder' % m.group('name'))

    if bare_assign_applies(path):
        for m in RE_ASSIGN_BARE.finditer(win):
            val = m.group('val').strip().strip('"\'`')
            if not val or is_placeholder_value(val):
                continue
            yield ('credential_literal', m.start('val'), val,
                   'set as %r and not a recognizable placeholder'
                   % m.group('name').strip())


def detect_key_prefix(win, path):
    for name, rx in PREFIX_RULES:
        for m in rx.finditer(win):
            tok = m.group(0)
            if name == 'jwt' and not looks_like_a_real_jwt(tok):
                continue
            yield ('key_prefix', m.start(), tok, 'matches the %s format' % name)


def detect_connection_string(win, path):
    for m in RE_CONN.finditer(win):
        pw, host = m.group('pw'), m.group('host').lower()
        if host in LOCAL_HOSTS or host.endswith('.local') or host.endswith('.test'):
            continue
        if is_placeholder_value(pw):
            continue
        yield ('connection_string', m.start('pw'), pw,
               '%s:// password for host %s' % (m.group('scheme').lower(), host))


def detect_email_with_credential(win, path):
    """A mailbox belonging to the repository's own authors, beside a credential.

    The first version of this detector fired on any personal-domain address near
    a credential word and produced twenty-three hits, every one of them a test
    fixture like n1@gmail.com. Firing twenty-three times to catch nothing is the
    definition of a scanner people learn to ignore.

    What actually mattered in the incident was not the domain. It was that the
    address belonged to the person whose account it was, and git already knows
    those addresses: they are the author and committer of every commit. That set
    is small, exact, needs no maintenance, and it is precisely the pairing worth
    refusing, because an owner mailbox next to a password is a live login.
    """
    for m in RE_EMAIL.finditer(win):
        addr = m.group(0)
        if addr.lower() not in OWNER_EMAILS:
            continue
        if not RE_CRED_WORD_NEARBY.search(line_around(win, m.start())):
            continue
        yield ('email_with_credential', m.start(), addr,
               'a mailbox from this repository\'s own commit authorship, on the '
               'same line as a credential')


WINDOW_DETECTORS = (
    detect_credential_position,
    detect_key_prefix,
    detect_connection_string,
    detect_email_with_credential,
)


# ---------------------------------------------------------------------------
# Blob scanning
# ---------------------------------------------------------------------------

def trigger_offsets(low):
    """Byte offsets worth looking at closely, found with memchr-speed searches."""
    hits = []
    for needle in CRED_TRIGGERS + PREFIX_TRIGGERS:
        p = low.find(needle)
        while p != -1:
            hits.append(p)
            p = low.find(needle, p + len(needle))
    p = low.find(b'://')
    while p != -1:
        if low[max(0, p - 12):p].endswith(SCHEME_TAIL):
            hits.append(p)
        p = low.find(b'://', p + 3)
    if MAIL_TRIGGER_TAIL:
        p = low.find(b'@')
        while p != -1:
            if low[p + 1:p + 40].startswith(MAIL_TRIGGER_TAIL):
                hits.append(p)
            p = low.find(b'@', p + 1)
    return hits


def windows_for(body, offsets):
    """Merge trigger offsets into byte ranges covering WINDOW_LINES either side."""
    spans = []
    for off in sorted(set(offsets)):
        if spans and off <= spans[-1][1]:
            continue
        start = off
        for _ in range(WINDOW_LINES):
            nl = body.rfind(b'\n', 0, start)
            if nl == -1:
                start = 0
                break
            start = nl
        start = start + 1 if start else 0
        end = off
        for _ in range(WINDOW_LINES):
            nl = body.find(b'\n', end + 1)
            if nl == -1:
                end = len(body)
                break
            end = nl
        if spans and start <= spans[-1][1]:
            spans[-1] = (spans[-1][0], max(spans[-1][1], end))
        else:
            spans.append((start, end))
    return spans


def entropy_allowed_path(path):
    if not path:
        return True
    low = path.replace('\\', '/').lower()
    if any(s in low for s in ENTROPY_SKIP_SUBSTR):
        return False
    return not any(low.endswith(s) for s in ENTROPY_SKIP_SUFFIX)


URL_DELIMS = frozenset(b' \t\r\n"\'`()<>[]{},;')


def in_url_path(body, offset):
    """True when the offset sits in the PATH part of a URL.

    Help-centre article slugs, as in
    https://support.discord.com/hc/en-us/articles/216679607-Verification-Levels,
    are long, mixed case and full of digits, which is every signal a random
    secret gives off. A path segment is not a secret. Anything after ? or # still
    is, because a token really can ride in a query string, and that is the case
    worth keeping.

    (Written out in full on purpose. The bare slug on its own line made this
    scanner refuse a push over its own documentation.)
    """
    start = offset
    while start > 0 and body[start - 1] not in URL_DELIMS:
        start -= 1
    end = offset
    while end < len(body) and body[end] not in URL_DELIMS:
        end += 1
    chunk = body[start:end]
    if b'://' not in chunk:
        return False
    q = min(x for x in (chunk.find(b'?'), chunk.find(b'#'), len(chunk)) if x != -1)
    return (offset - start) < q


def excerpt_at(body, offset, secret_bytes):
    start = body.rfind(b'\n', 0, offset) + 1
    end = body.find(b'\n', offset)
    if end == -1:
        end = len(body)
    masked = redact(secret_bytes.decode('utf-8', 'replace')).encode('utf-8', 'replace')
    text = body[start:end].replace(secret_bytes, masked).decode('utf-8', 'replace').strip()
    return text[:177] + '...' if len(text) > 180 else text


def scan_blob(body, path, blob):
    """Every finding in one blob, as whole-blob offsets."""
    raw_hits = []
    low = body.lower()

    for wstart, wend in windows_for(body, trigger_offsets(low)):
        # latin-1, not utf-8. It is the one decoding where a character offset
        # and a byte offset are the same number, so a reported line number is
        # exactly right even in a file with accented text above the finding.
        # Multi-byte utf-8 sequences become individual high characters that no
        # ASCII pattern here can match, and the matched text is re-encoded and
        # decoded as utf-8 before it is fingerprinted or printed.
        win = body[wstart:wend].decode('latin-1')
        for detector in WINDOW_DETECTORS:
            for name, off, secret, why in detector(win, path):
                raw_hits.append((name, wstart + off,
                                 secret.encode('latin-1').decode('utf-8', 'replace'),
                                 why))

    if entropy_allowed_path(path):
        for m in RE_TOKENISH.finditer(body):
            tok = m.group(0)
            if len(tok) > 100:
                continue
            has_lower = has_upper = digits = 0
            for c in tok:
                if 97 <= c <= 122:
                    has_lower = 1
                elif 65 <= c <= 90:
                    has_upper = 1
                elif 48 <= c <= 57:
                    digits += 1
            if not (has_lower and has_upper and digits):
                continue
            if digits / len(tok) < ENTROPY_MIN_DIGIT_FRACTION:
                continue
            token = tok.decode('ascii')
            ent = shannon(token)
            if ent < ENTROPY_MIN_BITS:
                continue
            if looks_like_an_alphabet(token) or decodes_to_readable_text(token):
                continue
            if in_url_path(body, m.start()):
                continue
            ex = excerpt_at(body, m.start(), tok)
            if RE_ENTROPY_LINE_SKIP.search(ex) or len(ex) > 320:
                continue
            raw_hits.append(('high_entropy', m.start(), token,
                             'random-looking %d character string, %.2f bits/char'
                             % (len(token), ent)))

    return [Finding(name, path, blob, off, secret, why,
                    excerpt_at(body, off, secret.encode('utf-8', 'replace')),
                    body.count(b'\n', 0, off) + 1)
            for name, off, secret, why in raw_hits]


# ---------------------------------------------------------------------------
# Repository walk
# ---------------------------------------------------------------------------

def git(repo, args):
    p = subprocess.run(['git', '-C', repo] + args, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError('git %s failed: %s'
                           % (' '.join(args), p.stderr.decode('utf-8', 'replace')))
    return p.stdout.decode('utf-8', 'replace')


def owner_emails(repo):
    """Every address git has ever recorded as an author or committer here."""
    found = set()
    try:
        for line in git(repo, ['log', '--all', '--format=%ae%n%ce']).splitlines():
            line = line.strip().lower()
            if '@' in line and not line.endswith('.local'):
                found.add(line)
    except RuntimeError:
        pass
    for scope in (['config', '--get', 'user.email'], ['config', '--global', '--get', 'user.email']):
        try:
            v = git(repo, scope).strip().lower()
            if '@' in v:
                found.add(v)
        except RuntimeError:
            pass
    # noreply forwarding addresses are public by construction and are attached
    # to every commit made through the GitHub web UI, so they carry no secret.
    return {e for e in found if not e.endswith('users.noreply.github.com')}


def enumerate_blobs(repo, head_only):
    """(sha, path) for every blob reachable from history, deduplicated by sha.

    Reachability matters: --batch-all-objects also returns dangling objects left
    by a rebase or another worktree's index, which are in no commit and cannot
    be published. Refusing the push over one of those would be refusing over
    something the mirror could never contain.
    """
    if head_only:
        out = {}
        for line in git(repo, ['ls-tree', '-r', 'HEAD']).splitlines():
            meta, _, path = line.partition('\t')
            parts = meta.split()
            if len(parts) >= 3 and parts[1] == 'blob':
                out.setdefault(parts[2], path)
        return out
    types = {}
    for line in git(repo, ['cat-file', '--batch-all-objects',
                           '--batch-check=%(objectname) %(objecttype)']).splitlines():
        sha, _, typ = line.partition(' ')
        types[sha] = typ
    out = {}
    for line in git(repo, ['rev-list', '--objects', '--all']).splitlines():
        sha, _, path = line.partition(' ')
        if path and types.get(sha) == 'blob':
            out.setdefault(sha, path)
    return out


def read_blobs(repo, shas):
    """Stream blob contents through one long-lived git cat-file --batch."""
    proc = subprocess.Popen(['git', '-C', repo, 'cat-file', '--batch'],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        for sha in shas:
            proc.stdin.write((sha + '\n').encode())
            proc.stdin.flush()
            header = proc.stdout.readline().decode('utf-8', 'replace').split()
            if len(header) < 3:
                continue
            remaining = int(header[2])
            chunks = []
            while remaining:
                chunk = proc.stdout.read(remaining)
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            proc.stdout.read(1)  # trailing newline
            yield sha, b''.join(chunks)
    finally:
        try:
            proc.stdin.close()
        except (OSError, ValueError):
            pass
        proc.wait()


def introducing_commits(repo):
    """blob id -> the OLDEST commit carrying it, in one pass over every diff."""
    p = subprocess.run(
        ['git', '-C', repo, 'log', '--all', '--reverse', '--format=%x01%H',
         '--raw', '--no-abbrev', '--no-renames'],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    mapping = {}
    for chunk in p.stdout.decode('utf-8', 'replace').split('\x01'):
        if not chunk.strip():
            continue
        lines = chunk.split('\n')
        commit = lines[0].strip()
        for ln in lines[1:]:
            if ln.startswith(':'):
                parts = ln.split()
                if len(parts) >= 4:
                    mapping.setdefault(parts[3], commit)
    return mapping


# ---------------------------------------------------------------------------
# Allowlist
# ---------------------------------------------------------------------------

def load_allowlist(path):
    """Parse detector:fingerprint entries. A reason is mandatory, not decorative.

    An entry with no reason is a scanner ERROR, not a silent pass. An
    unexplained suppression is how a real finding gets waved through a year from
    now by somebody who was not here today.
    """
    allowed = {}
    if not path or not os.path.exists(path):
        return allowed
    with open(path, 'r', encoding='utf-8') as fh:
        for num, raw in enumerate(fh, 1):
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            key, sep, rest = line.partition('#')
            key = key.strip()
            if not re.fullmatch(r'[a-z_]+:[0-9a-f]{16}', key):
                raise ValueError('%s:%d: entry must be <detector>:<16 hex fingerprint>, got %r'
                                 % (path, num, key))
            reason = ''
            if sep:
                m = re.match(r'\s*reason:\s*(.+?)\s*$', rest)
                if m:
                    reason = m.group(1)
            if len(reason) < 10:
                raise ValueError(
                    '%s:%d: %s carries no reason. Every entry needs '
                    '"# reason: <why this is safe>" of at least 10 characters.'
                    % (path, num, key))
            allowed[key] = reason
    return allowed


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument('--repo', default=os.path.abspath(os.path.join(here, '..', '..')))
    ap.add_argument('--allowlist', default=os.path.join(here, 'scan-allowlist.txt'))
    ap.add_argument('--head-only', action='store_true',
                    help='scan the checked-out tree only, not every commit')
    ap.add_argument('--stats', action='store_true', help='print a timing breakdown')
    args = ap.parse_args()

    t0 = time.time()
    repo = os.path.abspath(args.repo)

    try:
        allowed = load_allowlist(args.allowlist)
    except ValueError as exc:
        print('secret scan: %s' % exc, file=sys.stderr)
        return 2

    global OWNER_EMAILS, MAIL_TRIGGER_TAIL
    try:
        OWNER_EMAILS = owner_emails(repo)
        MAIL_TRIGGER_TAIL = tuple(sorted({e.split('@', 1)[1].encode()
                                          for e in OWNER_EMAILS}))
        blobs = enumerate_blobs(repo, args.head_only)
    except RuntimeError as exc:
        print('secret scan: %s' % exc, file=sys.stderr)
        return 2

    considered = []
    skipped_ext = 0
    for sha, path in blobs.items():
        if os.path.splitext(path)[1].lower() in BINARY_EXT:
            skipped_ext += 1
            continue
        considered.append(sha)

    findings = []
    scanned = skipped_nul = truncated = 0
    scanned_bytes = 0
    t_enum = time.time()

    for sha, body in read_blobs(repo, considered):
        if b'\x00' in body[:8192]:
            skipped_nul += 1
            continue
        if len(body) > MAX_SCAN_BYTES:
            truncated += 1
            body = body[:MAX_SCAN_BYTES]
        scanned += 1
        scanned_bytes += len(body)
        findings.extend(scan_blob(body, blobs[sha], sha))

    t_scan = time.time()

    # The same secret in the same file across 900 commits is one problem, not
    # 900 lines of output.
    unique = {}
    suppressed = 0
    for f in findings:
        if f.key in allowed:
            suppressed += 1
            continue
        k = (f.detector, f.path, fingerprint(f.detector, f.secret))
        prev = unique.get(k)
        if prev is None or f.offset < prev.offset:
            unique[k] = f
    live = sorted(unique.values(), key=lambda f: (f.detector, f.path or '', f.offset))

    if live and not args.head_only:
        commits = introducing_commits(repo)
        for f in live:
            c = commits.get(f.blob)
            f.commit = c[:12] if c else None

    elapsed = time.time() - t0
    if args.stats:
        print('secret scan: enumerate %.1fs, read and scan %.1fs, attribute %.1fs'
              % (t_enum - t0, t_scan - t_enum, time.time() - t_scan))
    summary = ('secret scan: %d reachable blobs, %d skipped as binary by extension, '
               '%d by content, %d scanned (%.0f MB), %d truncated at %d MB'
               % (len(blobs), skipped_ext, skipped_nul, scanned,
                  scanned_bytes / 1e6, truncated, MAX_SCAN_BYTES // (1024 * 1024)))

    if not live:
        print(summary)
        if suppressed:
            print('secret scan: %d hit(s) suppressed by %d allowlist entr(y/ies)'
                  % (suppressed, len(allowed)))
        print('secret scan: clean in %.1fs' % elapsed)
        return 0

    by_det = defaultdict(int)
    for f in live:
        by_det[f.detector] += 1

    print('')
    print('=' * 78)
    print('SECRET SCAN: %d finding(s) in the history about to be published' % len(live))
    print('=' * 78)
    for f in live:
        print('')
        print('  [%s]  %s:%d' % (f.detector, f.path or '(no path)', f.line))
        if f.commit:
            print('    commit:  %s   (oldest commit carrying this blob)' % f.commit)
        print('    blob:    %s' % f.blob[:12])
        print('    why:     %s' % f.why)
        print('    code:    %s' % f.excerpt)
        print('    allow:   %s  # reason: ' % f.key)
    print('')
    print('-' * 78)
    print('  %s' % summary)
    print('  by detector: %s' % ', '.join('%s=%d' % kv for kv in sorted(by_det.items())))
    if suppressed:
        print('  %d further hit(s) suppressed by %d allowlist entr(y/ies)'
              % (suppressed, len(allowed)))
    print('  %.1fs' % elapsed)
    print('')
    print('  REAL finding: add the literal to tools/publish/redactions.txt AND')
    print('  rotate the credential, then re-run. Redaction rewrites it out of')
    print('  every commit; rotation is what actually makes it harmless.')
    print('')
    print('  NOT a finding: paste its allow: line into')
    print('  tools/publish/scan-allowlist.txt and complete the reason. An entry')
    print('  without a reason is rejected.')
    print('-' * 78)
    return 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(2)
    except Exception as exc:  # a scanner that crashes must never read as a pass
        print('secret scan: unexpected failure: %r' % (exc,), file=sys.stderr)
        sys.exit(2)
