"""Make an 8-bit copy of a trained model, and say what it costs.

    python quantize.py runs/3/people.onnx runs/3/people-int8.onnx

8-bit arithmetic is what the Pi 5's cores are fastest at, so the same network
stored in 8 bits usually runs two to three times faster there. It is only
worth shipping if it counts as well as the original, so this measures both on
the same held-out frames and on the same machine, one thread each, and prints
the comparison. Calibration uses synthetic frames, like training did.

Needs onnxruntime, numpy and scipy on the development machine.
"""

import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from onnxruntime.quantization import (CalibrationDataReader, QuantFormat, QuantType,
                                      quantize_static)
from onnxruntime.quantization.shape_inference import quant_pre_process

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import synth  # noqa: E402


class Frames(CalibrationDataReader):
    def __init__(self, n=400, seed=77):
        rng = np.random.default_rng(seed)
        self.items = iter([{'frame': synth.model_input(synth.scene_full(rng)[0])[None]}
                           for _ in range(n)])

    def get_next(self):
        return next(self.items, None)


def session(path):
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1
    return ort.InferenceSession(str(path), opts, providers=['CPUExecutionProvider'])


def counts(sess, frames, threshold=0.4):
    out, took = [], 0.0
    for t, _ in frames:
        x = synth.model_input(t)[None]
        started = time.perf_counter()
        heat = sess.run(None, {'frame': x})[0][0, 0]
        took += time.perf_counter() - started
        p = np.pad(heat, 1, constant_values=-1)
        local = np.max([p[dy:dy + heat.shape[0], dx:dx + heat.shape[1]]
                        for dy in range(3) for dx in range(3)], axis=0)
        out.append(int(((heat >= threshold) & (heat >= local)).sum()))
    return np.array(out), took / len(frames) * 1000


def main(argv):
    src, dst = Path(argv[0]), Path(argv[1])
    pre = dst.with_suffix('.pre.onnx')
    quant_pre_process(str(src), str(pre))
    quantize_static(str(pre), str(dst), Frames(), quant_format=QuantFormat.QDQ,
                    activation_type=QuantType.QUInt8, weight_type=QuantType.QInt8,
                    per_channel=True)
    pre.unlink()
    rng = np.random.default_rng(999)
    frames = [synth.scene_full(rng) for _ in range(1000)]
    truth = np.array([sum(o['cls'] == 'person' for o in objs) for _, objs in frames])
    for name, path in (('float', src), ('8-bit', dst)):
        c, ms = counts(session(path), frames)
        err = c - truth
        print(f'{name:6s} exact {np.mean(err == 0):.3f}  within one {np.mean(np.abs(err) <= 1):.3f}  '
              f'mean error {np.mean(np.abs(err)):.3f}  {ms:.1f} ms a frame  '
              f'{path.stat().st_size / 1e6:.1f} MB')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
