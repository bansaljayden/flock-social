"""Train the people counter on synthetic frames and export it for the Pi.

    python train.py --out ~/flux-training/run1 --steps 30000

Frames are drawn fresh by synth.py in worker processes, so the model never
sees the same frame twice and there is nothing on disk to manage. At the end
it writes people.onnx (1 x 2 x 120 x 160 in, 1 x 1 x 30 x 40 probabilities
out) and a report of how it counts on held-out frames next to how the rule
counter in main.py counts the same ones.

Needs torch, numpy and scipy, on the development machine. A GPU helps; a CPU
works, slowly.
"""

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, IterableDataset

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import synth                      # noqa: E402
from model import PeopleNet, focal_loss   # noqa: E402

PEAK_THRESHOLD = 0.4


class Frames(IterableDataset):
    def __init__(self, seed):
        self.seed = seed

    def __iter__(self):
        info = torch.utils.data.get_worker_info()
        wid = info.id if info else 0
        rng = np.random.default_rng([self.seed, wid, int(time.time() * 1e6) % (1 << 31)])
        while True:
            t, pts = synth.scene(rng)
            if rng.random() < 0.5:
                t = t[:, ::-1].copy()
                pts = [(synth.COLS - x, y) for x, y in pts]
            yield torch.from_numpy(synth.model_input(t)), torch.from_numpy(synth.heatmap(pts))[None]


def peaks(prob, threshold=PEAK_THRESHOLD):
    """Peaks on a [N, 1, 30, 40] probability map: the same rule main.py uses."""
    local = F.max_pool2d(prob, 3, 1, 1)
    return (prob >= threshold) & (prob == local)


def held_out(n, seed=12345):
    rng = np.random.default_rng(seed)
    return [synth.scene(rng) for _ in range(n)]


def evaluate(net, frames, device, threshold=PEAK_THRESHOLD):
    net.eval()
    counts = []
    with torch.no_grad():
        for i in range(0, len(frames), 256):
            x = torch.stack([torch.from_numpy(synth.model_input(t)) for t, _ in frames[i:i + 256]])
            prob = torch.sigmoid(net(x.to(device)))
            counts += peaks(prob, threshold).flatten(1).sum(1).tolist()
    net.train()
    truth = [len(p) for _, p in frames]
    return score(truth, counts), counts


def score(truth, counts):
    truth, counts = np.array(truth), np.array(counts)
    err = counts - truth
    out = {'frames': int(len(truth)),
           'exact': round(float((err == 0).mean()), 4),
           'within_one': round(float((np.abs(err) <= 1).mean()), 4),
           'mean_abs_error': round(float(np.abs(err).mean()), 3)}
    for name, sel in (('empty', truth == 0), ('one', truth == 1), ('two', truth == 2),
                      ('three_to_five', (truth >= 3) & (truth <= 5)), ('six_plus', truth >= 6)):
        if sel.any():
            out[name] = {'frames': int(sel.sum()),
                         'exact': round(float((err[sel] == 0).mean()), 3),
                         'mean_abs_error': round(float(np.abs(err[sel]).mean()), 2)}
    return out


def rule_counts(frames):
    """What main.py's threshold counter says about the same frames."""
    sys.path.insert(0, str(HERE.parent))
    import main
    return [main.count_thermal_clusters([float(v) for v in t.ravel()]) for t, _ in frames]


def export(net, path):
    net = net.cpu().eval()

    class WithSigmoid(torch.nn.Module):
        def __init__(self, inner):
            super().__init__()
            self.inner = inner

        def forward(self, x):
            return torch.sigmoid(self.inner(x))

    torch.onnx.export(WithSigmoid(net), torch.zeros(1, 2, synth.ROWS, synth.COLS), str(path),
                      input_names=['frame'], output_names=['people'], opset_version=17,
                      dynamo=False)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--steps', type=int, default=30000)
    ap.add_argument('--batch', type=int, default=64)
    ap.add_argument('--lr', type=float, default=2e-3)
    # Not every core: at fourteen workers plus the GPU the machine this was
    # first trained on stopped responding.
    ap.add_argument('--workers', type=int, default=8)
    ap.add_argument('--width', type=int, default=24)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--name', default='owl-1',
                    help='the name this model is known by on the unit and in the report')
    args = ap.parse_args(argv)
    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    torch.manual_seed(args.seed)

    net = PeopleNet(args.width).to(device)
    params = sum(p.numel() for p in net.parameters())
    print(f'{params:,} parameters on {device}', flush=True)
    opt = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, args.lr, total_steps=args.steps, pct_start=0.05)
    loader = DataLoader(Frames(args.seed), batch_size=args.batch, num_workers=args.workers,
                        persistent_workers=True, prefetch_factor=4)
    val = held_out(1500)
    best = None
    start = 0
    # A run picks up where it stopped. A training run is half an hour of a
    # machine at full load, and losing it to a freeze or a reboot meant
    # starting again from nothing.
    if (out / 'last.pt').exists():
        ck = torch.load(out / 'last.pt', map_location=device)
        net.load_state_dict(ck['net'])
        opt.load_state_dict(ck['opt'])
        sched.load_state_dict(ck['sched'])
        start, best = ck['step'], ck['best']
        print(f'resuming at step {start}', flush=True)
    t0 = time.time()
    running = 0.0
    for step, (x, y) in enumerate(loader, start + 1):
        x, y = x.to(device, non_blocking=True), y.to(device, non_blocking=True)
        loss = focal_loss(net(x), y)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(net.parameters(), 5.0)
        opt.step()
        sched.step()
        running = 0.98 * running + 0.02 * loss.item() if step > 1 else loss.item()
        if step % 500 == 0 or step == args.steps:
            s, _ = evaluate(net, val, device)
            rate = (step - start) * args.batch / (time.time() - t0)
            print(f'step {step} loss {running:.3f} exact {s["exact"]} within1 {s["within_one"]} '
                  f'mae {s["mean_abs_error"]} ({rate:.0f} frames/s)', flush=True)
            if best is None or s['mean_abs_error'] < best:
                best = s['mean_abs_error']
                torch.save(net.state_dict(), out / 'best.pt')
            torch.save({'net': net.state_dict(), 'opt': opt.state_dict(),
                        'sched': sched.state_dict(), 'step': step, 'best': best},
                       out / 'last.pt')
        if step >= args.steps:
            break

    net.load_state_dict(torch.load(out / 'best.pt', map_location=device))
    test = held_out(3000, seed=999)
    model_score, _ = evaluate(net, test, device)
    rule_score = score([len(p) for _, p in test], rule_counts(test))
    report = {'name': args.name, 'parameters': params, 'steps': args.steps, 'model': model_score, 'rule': rule_score}
    (out / 'report.json').write_text(json.dumps(report, indent=2))
    export(net, out / 'people.onnx')
    print(json.dumps(report, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
