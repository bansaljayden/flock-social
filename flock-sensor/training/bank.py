"""Draw a bank of synthetic frames once, for training to reuse.

    python bank.py --out ~/flux-training/bank --frames 200000 --workers 12

Drawing a frame costs the CPU about 11 ms, and a training step on the GPU
takes 64 of them in a few milliseconds, so fresh-drawn training keeps the GPU
idle most of the time. A bank is drawn once, in parallel, and read back at
disk speed; train.py mixes it with fresh frames (--bank, --bank-share) so the
model keeps seeing new ones, and varies each banked frame every time it is
used. Whether a bank costs anything is measured, not assumed: train one run
with it and one without and grade both with real_eval and stress.py.

Files: frames.f16 (N x 120 x 160 float16 Celsius, memory-mapped) and
objects.pkl (the labels, one list per frame). Several GB; keep it off the repo.
"""

import argparse
import pickle
import sys
from multiprocessing import Pool
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import synth  # noqa: E402


def _draw(args):
    seed, n = args
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(n):
        t, objects = synth.scene_full(rng)
        out.append((t.astype(np.float16), objects))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--frames', type=int, default=200000)
    ap.add_argument('--workers', type=int, default=12)
    ap.add_argument('--seed', type=int, default=2026)
    args = ap.parse_args(argv)
    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    chunk = 500
    jobs = [(args.seed * 100003 + i, min(chunk, args.frames - i * chunk))
            for i in range((args.frames + chunk - 1) // chunk)]
    frames = np.lib.format.open_memmap(out / 'frames.f16', mode='w+', dtype=np.float16,
                                       shape=(args.frames, synth.ROWS, synth.COLS))
    objects, at = [], 0
    with Pool(args.workers) as pool:
        for part in pool.imap(_draw, jobs):
            for t, objs in part:
                frames[at] = t
                objects.append(objs)
                at += 1
            print(f'{at}/{args.frames}', flush=True)
    frames.flush()
    pickle.dump(objects, open(out / 'objects.pkl', 'wb'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
