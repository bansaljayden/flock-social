"""The shipped graph's file names, and the one rule for reading them.

A models directory holds crowd_model.onnx, or, for a model over GitHub's 100 MB
per-file limit, only crowd_model.onnx.gz (the same bytes, gzipped). The rule is
the serving code's (services/mlPredictor.js onnxSource): the plain file when it
exists, else the .gz decompressed in memory. Every Python reader of a models
directory goes through onnx_file() and session_source() so a .gz-only directory
scores the same as a plain one.

gzip_bytes() is the export's writer. Its output depends only on the input and
the zlib build: level 9, mtime 0, no file name in the header, and OS byte 255,
written by GzipFile itself rather than by gzip.compress, whose header bytes
changed between Python versions.

Standard library only, no side effects at import.
"""
from __future__ import annotations

import gzip
import hashlib
import io
from pathlib import Path

ONNX_NAME = 'crowd_model.onnx'
GZ_NAME = ONNX_NAME + '.gz'


def gzip_bytes(raw: bytes) -> bytes:
    """Deterministic gzip of `raw`: level 9, mtime 0, empty name."""
    buf = io.BytesIO()
    with gzip.GzipFile(filename='', mode='wb', fileobj=buf, compresslevel=9, mtime=0) as f:
        f.write(raw)
    return buf.getvalue()


def gunzip_bytes(data: bytes) -> bytes:
    """Decompress, checking the trailer's CRC-32 and length (gzip raises on either)."""
    return gzip.decompress(data)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def onnx_file(models_dir) -> Path | None:
    """crowd_model.onnx if it exists, else crowd_model.onnx.gz if that does, else None."""
    d = Path(models_dir)
    for name in (ONNX_NAME, GZ_NAME):
        if (d / name).exists():
            return d / name
    return None


def has_onnx(models_dir) -> bool:
    return onnx_file(models_dir) is not None


def session_source(path):
    """What onnxruntime.InferenceSession is given for `path`: the path string for a
    plain .onnx, the decompressed bytes for a .gz."""
    p = Path(path)
    if p.suffix == '.gz':
        return gunzip_bytes(p.read_bytes())
    return str(p)
