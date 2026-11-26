"""crowd_model.onnx.gz: written deterministically, read back to the same graph.

WHY THIS FILE EXISTS. A 2,000-tree model is over GitHub's 100 MB per-file
limit as a plain .onnx, so export_model.py also writes crowd_model.onnx.gz and
a models directory may ship only that. These checks pin model_files.py, which
both sides use: gzip_bytes gives the same bytes for the same input (level 9,
mtime 0, no file name, OS byte 255), the bytes decompress to the input, a
corrupt or truncated .gz raises, onnx_file prefers the plain file, and an
onnxruntime session built from the decompressed tracked model answers exactly
as one built from its path. export_model.py's own use (the .gz beside the
graph, the four fingerprints in the metadata) is checked by
__tests__/mlExportContracts.test.js, which runs the real export.

Run: python test_onnx_gz.py     (no pytest needed)
"""
import gzip
import shutil
import sys
import tempfile
import traceback
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import model_files as mf  # noqa: E402

MODELS = Path(__file__).parent.parent / 'models'
# The tracked graph in whichever form models/ ships it: the plain .onnx today,
# the .gz alone once a model is over GitHub's file limit.
TRACKED = mf.onnx_file(MODELS)
SAMPLE = bytes(range(256)) * 4096 + b'flock' * 1000


def test_gzip_is_deterministic():
    a, b = mf.gzip_bytes(SAMPLE), mf.gzip_bytes(bytes(SAMPLE))
    assert a == b, 'two compressions of the same bytes differ'


def test_gzip_header_has_no_time_and_no_name():
    gz = mf.gzip_bytes(SAMPLE)
    assert gz[:3] == b'\x1f\x8b\x08', gz[:3]
    flags = gz[3]
    assert flags & 0x08 == 0, 'FNAME is set: a file name is in the header'
    assert flags == 0, f'header flags {flags:#x}; expected none'
    assert gz[4:8] == b'\x00\x00\x00\x00', f'mtime {gz[4:8]!r} is not zero'
    assert gz[8] == 2, f'XFL {gz[8]} is not 2 (maximum compression)'
    assert gz[9] == 255, f'OS byte {gz[9]} is not 255'


def test_gzip_is_level_9_and_round_trips():
    gz = mf.gzip_bytes(SAMPLE)
    assert mf.gunzip_bytes(gz) == SAMPLE
    assert gzip.decompress(gz) == SAMPLE
    # The deflate stream is zlib's level 9 on the same input.
    co = zlib.compressobj(9, zlib.DEFLATED, -zlib.MAX_WBITS)
    assert gz[10:-8] == co.compress(SAMPLE) + co.flush(), 'the deflate stream is not level 9'


def test_corrupt_and_truncated_raise():
    gz = mf.gzip_bytes(SAMPLE)
    for what, bad in (('truncated', gz[:len(gz) // 2]),
                      ('corrupt', gz[:10] + b'\x5a' * 4096),
                      ('crc', gz[:-8] + bytes([gz[-8] ^ 0xff]) + gz[-7:])):
        try:
            mf.gunzip_bytes(bad)
        except (OSError, EOFError, zlib.error):
            continue
        raise AssertionError(f'{what} .gz decompressed without an error')


def test_onnx_file_prefers_the_plain_file():
    d = Path(tempfile.mkdtemp(prefix='flock-onnx-gz-'))
    try:
        assert mf.onnx_file(d) is None and not mf.has_onnx(d)
        (d / mf.GZ_NAME).write_bytes(mf.gzip_bytes(b'graph'))
        assert mf.onnx_file(d) == d / mf.GZ_NAME and mf.has_onnx(d)
        assert mf.session_source(d / mf.GZ_NAME) == b'graph'
        (d / mf.ONNX_NAME).write_bytes(b'graph')
        assert mf.onnx_file(d) == d / mf.ONNX_NAME
        assert mf.session_source(d / mf.ONNX_NAME) == str(d / mf.ONNX_NAME)
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_the_tracked_model_round_trips_and_scores_the_same():
    assert TRACKED is not None, 'models/ holds neither crowd_model.onnx nor its .gz'
    raw = TRACKED.read_bytes()
    if TRACKED.name == mf.GZ_NAME:
        raw = mf.gunzip_bytes(raw)
    gz = mf.gzip_bytes(raw)
    assert gz == mf.gzip_bytes(raw), 'not deterministic on the real model'
    assert mf.gunzip_bytes(gz) == raw
    try:
        import numpy as np
        import onnxruntime as ort
    except ImportError:
        print('  (onnxruntime/numpy absent: session comparison skipped)')
        return
    d = Path(tempfile.mkdtemp(prefix='flock-onnx-gz-'))
    try:
        (d / mf.GZ_NAME).write_bytes(gz)
        (d / 'plain').mkdir()
        (d / 'plain' / mf.ONNX_NAME).write_bytes(raw)
        plain = ort.InferenceSession(str(d / 'plain' / mf.ONNX_NAME))
        packed = ort.InferenceSession(mf.session_source(mf.onnx_file(d)))
        inp = plain.get_inputs()[0]
        width = inp.shape[-1]
        X = np.random.default_rng(20261126).uniform(0, 100, size=(64, width)).astype(np.float32)
        a = plain.run(None, {inp.name: X})[0]
        b = packed.run(None, {inp.name: X})[0]
        assert np.array_equal(a, b), 'the .gz session answered differently'
    finally:
        shutil.rmtree(d, ignore_errors=True)


def main():
    tests = [(name, fn) for name, fn in sorted(globals().items()) if name.startswith('test_') and callable(fn)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f'PASS  {name}')
        except Exception:  # noqa: BLE001 - report every failure, then exit non-zero
            failed += 1
            print(f'FAIL  {name}')
            traceback.print_exc()
    print(f'\n{len(tests) - failed}/{len(tests)} passed')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
