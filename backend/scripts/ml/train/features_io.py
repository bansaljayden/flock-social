"""Where a feature pickle's matrix X lives: inside the pickle, or beside it.

WHY THIS FILE EXISTS. A training frame of tens of millions of rows does not fit
this project's training PC as one pickled float32 array plus the copies a fit
makes of it (the November 2026 third candidate is about 94 million rows read).
So prepare_features.py may write X to a .npy file next to its pickle (float32,
Fortran order, the layout the in-pickle X already has) and record the file's
name, shape and SHA-256 in the pickle instead of the array. Every reader opens
a feature pickle through load_features, which returns the same dict either
way, with X memory-mapped (read-only) when it is external. A pickle that holds
X inline, which is every pickle written before this file and every export
small enough to keep it inline, loads exactly as pickle.load always did.

Run its checks: python test_features_io.py
"""
import hashlib
import os
import pickle
from pathlib import Path

import numpy as np

X_FILE_KEY = 'X_file'
X_SHAPE_KEY = 'X_shape'
X_SHA_KEY = 'X_sha256'

# ---------------------------------------------------------------------------
# THE LABEL-TRUST STAMP (2026-11-27). prepare_features.check_label_trust refuses
# an export holding readings the provider generated (backend/services/
# labelQuarantine.json) or weeks of readings that repeat their own week. A
# pickle prepared before that check existed, or against another version of the
# quarantine file, never met it, and training on it again is how the November
# result happened. So every pickle prepare_features writes carries a stamp: the
# SHA-256 of the quarantine file it was checked against and what the check
# admitted. load_features refuses a pickle without a current stamp, and one
# whose check admitted quarantined or repeating labels for an analysis, unless
# the same override (FLOCK_ALLOW_QUARANTINED_LABELS / FLOCK_ALLOW_REPEATING_LABELS)
# is set where it is loaded.
# ---------------------------------------------------------------------------
LABEL_TRUST_KEY = 'label_trust_stamp'
QUARANTINE_FILE = Path(__file__).resolve().parents[3] / 'services' / 'labelQuarantine.json'
QUARANTINE_ENV = 'FLOCK_ALLOW_QUARANTINED_LABELS'
REPETITION_ENV = 'FLOCK_ALLOW_REPEATING_LABELS'


def quarantine_sha256(path=QUARANTINE_FILE) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def label_trust_stamp(record: dict, path=QUARANTINE_FILE) -> dict:
    """The stamp a prepared pickle carries, from check_label_trust's record."""
    return {
        'quarantine_sha256': quarantine_sha256(path),
        'quarantine_policy': ((record or {}).get('quarantine') or {}).get('policy'),
        'repetition_policy': ((record or {}).get('repetition') or {}).get('policy'),
    }


def _true(env, name) -> bool:
    return str(env.get(name, '')).strip().lower() == 'true'


def require_label_trust(data: dict, pickle_path, env=None, path=QUARANTINE_FILE) -> None:
    """Refuse a feature pickle that did not meet the current label quarantine (the block above)."""
    env = os.environ if env is None else env
    stamp = data.get(LABEL_TRUST_KEY)
    analysis = _true(env, QUARANTINE_ENV)
    if not isinstance(stamp, dict):
        if analysis:
            return
        raise ValueError(
            f'{pickle_path} carries no label-trust stamp: it was prepared before the label quarantine '
            '(2026-11-27) and may hold readings the provider generated. Prepare it again from a fresh '
            f'export, or set {QUARANTINE_ENV}=true for an analysis that knows what it is reading.')
    if stamp.get('quarantine_sha256') != quarantine_sha256(path) and not analysis:
        raise ValueError(
            f'{pickle_path} was checked against another version of labelQuarantine.json. Prepare it '
            f'again, or set {QUARANTINE_ENV}=true for an analysis.')
    if stamp.get('quarantine_policy') == 'admitted_for_analysis' and not analysis:
        raise ValueError(
            f'{pickle_path} was prepared with quarantined readings admitted ({QUARANTINE_ENV}=true); '
            'set the same override to load it, and never ship what it trains.')
    if stamp.get('repetition_policy') == 'admitted_for_analysis' and not _true(env, REPETITION_ENV):
        raise ValueError(
            f'{pickle_path} was prepared with repeating labels admitted ({REPETITION_ENV}=true); '
            'set the same override to load it, and never ship what it trains.')


def x_file_for(pickle_path) -> Path:
    """features_train.pkl -> features_train.X.npy, in the same folder."""
    p = Path(pickle_path)
    return p.with_name(p.stem + '.X.npy')


def open_x_memmap(pickle_path, n_rows: int, n_features: int):
    """A writable float32, Fortran-order .npy memory map for X beside the pickle.

    Returns (path, array). Rows are written in their final order; call
    finish_x when every row is written.
    """
    path = x_file_for(pickle_path)
    arr = np.lib.format.open_memmap(path, mode='w+', dtype=np.float32,
                                    shape=(int(n_rows), int(n_features)), fortran_order=True)
    return path, arr


def sha256_file(path, chunk: int = 1 << 24) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            block = f.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def finish_x(pickle_path, arr) -> dict:
    """Flush the map and return the keys that stand in for X in the pickle.

    The caller still holds `arr`; on Windows an open map keeps the file locked
    (no rename, no delete) until every reference to it is dropped.
    """
    arr.flush()
    path = x_file_for(pickle_path)
    shape = [int(arr.shape[0]), int(arr.shape[1])]
    return {X_FILE_KEY: path.name, X_SHAPE_KEY: shape, X_SHA_KEY: sha256_file(path)}


REPLAY_STAMP_SUFFIX = '.label-trust.json'


def require_replay_stamp(replay_path, env=None, path=QUARANTINE_FILE) -> None:
    """A bandEval.js --rows-out file scored under the current quarantine
    (services/labelQuarantine.js requireReplayStamp, the same rule)."""
    import json
    env = os.environ if env is None else env
    if _true(env, QUARANTINE_ENV):
        return
    stamp_path = Path(str(replay_path) + REPLAY_STAMP_SUFFIX)
    try:
        stamp = json.loads(stamp_path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise ValueError(
            f'{replay_path} has no readable {stamp_path.name} beside it: it was scored before the label '
            'quarantine (2026-11-27) and may score readings the provider generated. Score it again with '
            f'bandEval.js --rows-out, or set {QUARANTINE_ENV}=true for an analysis.')
    if not isinstance(stamp, dict) or stamp.get('quarantine_sha256') != quarantine_sha256(path):
        raise ValueError(f'{replay_path} was scored under another version of labelQuarantine.json. '
                         'Score it again with bandEval.js --rows-out.')


def load_features(pickle_path, mmap: bool = True, verify: bool = False, require_trust: bool = True) -> dict:
    """The pickle's dict, with data['X'] always present.

    Inline X: returned exactly as pickle.load gives it. External X: the .npy
    beside the pickle, memory-mapped read-only (mmap=True) or read into memory,
    after checking its shape, dtype and layout against the pickle; verify=True
    also checks the file's SHA-256 (reads the whole file once).
    """
    with open(pickle_path, 'rb') as f:
        data = pickle.load(f)
    # require_trust=False is for tests that build a pickle by hand to check
    # this file's mechanics; every training and evaluation script loads with it on.
    if require_trust:
        require_label_trust(data, pickle_path)
    if X_FILE_KEY not in data:
        return data
    if 'X' in data:
        raise ValueError(f'{pickle_path} holds X inline AND names {data[X_FILE_KEY]}; one or the other.')
    path = Path(pickle_path).with_name(data[X_FILE_KEY])
    if not path.exists():
        raise FileNotFoundError(f'{pickle_path} keeps X in {path.name}, which is not beside it.')
    if verify:
        got = sha256_file(path)
        if got != data[X_SHA_KEY]:
            raise ValueError(f'{path.name} SHA-256 {got} is not the {data[X_SHA_KEY]} the pickle records.')
    X = np.load(path, mmap_mode='r' if mmap else None)
    if list(X.shape) != list(data[X_SHAPE_KEY]):
        raise ValueError(f'{path.name} has shape {list(X.shape)}, the pickle records {data[X_SHAPE_KEY]}.')
    if X.dtype != np.float32 or not X.flags.f_contiguous:
        raise ValueError(f'{path.name} must be float32 in Fortran order (got {X.dtype}, '
                         f'f_contiguous={X.flags.f_contiguous}).')
    out = dict(data)
    out['X'] = X
    return out


def x_is_external(data: dict) -> bool:
    return isinstance(data.get('X'), np.memmap) or X_FILE_KEY in data
