"""Train the sensor's network on synthetic frames and export it for the Pi.

    python train.py --out ~/flux-training/run3 --steps 30000

Frames are drawn fresh by synth.py in worker processes, so the model never
sees the same frame twice and there is nothing on disk to manage. At the end
it writes people.onnx and a report: how it counts people on held-out frames
next to how the rule counter in main.py counts the same ones, and how well it
finds and names each other kind of thing.

people.onnx takes 1 x 2 x 120 x 160 and gives two outputs on a 30 x 40 grid:
'heat', 1 x len(CLASSES) probabilities, and 'ltrb', 1 x 4 box reach in grid
cells. main.py also still reads owl-1's single-output file.

Needs torch, numpy and scipy, on the development machine. A GPU helps; a CPU
works, slowly.
"""

import argparse
import json
import pickle
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
from model import PeopleNet, focal_loss, box_loss   # noqa: E402

PEAK_THRESHOLD = 0.4
K = len(synth.CLASSES)


def flip(t, objects):
    """Mirror a frame and its labels left to right."""
    w = synth.COLS
    out = []
    for o in objects:
        x0, y0, x1, y1 = o['box']
        out.append({'cls': o['cls'], 'x': w - o['x'], 'y': o['y'], 'box': (w - x1, y0, w - x0, y1)})
    return t[:, ::-1].copy(), out


ALL_KNOWN = np.ones(K, dtype=np.float32)
PEOPLE_ONLY = np.eye(K, dtype=np.float32)[0]


def real_frame(real, rng):
    """One real training frame at Lepton size, with its people.

    real is the 'train' part of the cache real_cache.py builds from public,
    commercially licensed datasets (never their test splits):
      tp   PUT Thermo Presence, MLX90640 32x24 from the ceiling, degrees C,
           a point per person
      otp  OpenThermalPose2, side view, 8-bit, a box and head per person
    Only people are labelled in them, so only the people map is graded.
    """
    from scipy.ndimage import zoom
    if rng.random() < 0.5:
        i = int(rng.integers(len(real['tp_img'])))
        t = zoom(real['tp_img'][i].astype(np.float32), (5, 5), order=1)
        t = t + rng.normal(0, 1.5)
        objects = [{'cls': 'person', 'x': x * 5 + 2.5, 'y': y * 5 + 2.5,
                    'box': (x * 5 - 10, y * 5 - 10, x * 5 + 15, y * 5 + 15)}
                   for x, y in real['tp_pts'][i]]
        boxes = False
    else:
        # Frames with two or more people drawn three times as often: groups
        # seen from the side are where owl-3 undercounted.
        if '_w' not in real:
            w = np.array([3.0 if len(p) >= 2 else 1.0 for p in real['otp_people']])
            real['_w'] = w / w.sum()
        i = int(rng.choice(len(real['otp_img']), p=real['_w']))
        g = real['otp_img'][i].astype(np.float32) / 255.0
        # 8-bit frames carry no temperatures; a plausible room-to-skin range,
        # different every time, so no one mapping is learned as the truth.
        lo, span = rng.uniform(16, 28), rng.uniform(8, 16)
        t = lo + (g ** rng.uniform(0.8, 1.25)) * span
        objects = [{'cls': 'person', 'x': hx, 'y': hy, 'box': box}
                   for box, (hx, hy) in real['otp_people'][i]]
        boxes = True
    t = t.astype(np.float32)
    if rng.random() < 0.5:
        t, objects = flip(t, objects)
    return t, objects, boxes


class Frames(IterableDataset):
    def __init__(self, seed, real_path=None, real_share=0.0):
        self.seed, self.real_path, self.real_share = seed, real_path, real_share

    def __iter__(self):
        info = torch.utils.data.get_worker_info()
        wid = info.id if info else 0
        rng = np.random.default_rng([self.seed, wid, int(time.time() * 1e6) % (1 << 31)])
        real = pickle.load(open(self.real_path, 'rb'))['train'] if self.real_path else None
        while True:
            known, boxes = ALL_KNOWN, True
            if real is not None and rng.random() < self.real_share:
                t, objects, boxes = real_frame(real, rng)
                known = PEOPLE_ONLY
            else:
                t, objects = synth.scene_full(rng)
                if rng.random() < 0.5:
                    t, objects = flip(t, objects)
            heat, ltrb, mask = synth.targets(objects)
            if not boxes:
                mask = np.zeros_like(mask)
            x = synth.model_input(t)
            # Absolute temperature is not always to be trusted: an 8-bit real
            # frame's temperatures are made up, and an uncalibrated Lepton's are
            # a few degrees out. Now and then it is skewed, so the model leans on
            # warmth relative to the room as well.
            if rng.random() < (0.6 if known is PEOPLE_ONLY else 0.2):
                x[0] = x[0] * rng.uniform(0.7, 1.3) + rng.uniform(-0.8, 0.8)
            yield (torch.from_numpy(x), torch.from_numpy(heat),
                   torch.from_numpy(ltrb), torch.from_numpy(mask), torch.from_numpy(known))


def peaks(prob, threshold=PEAK_THRESHOLD):
    """Peaks on a [N, C, 30, 40] probability map: the same rule main.py uses."""
    local = F.max_pool2d(prob, 3, 1, 1)
    return (prob >= threshold) & (prob == local)


def held_out(n, seed=12345):
    rng = np.random.default_rng(seed)
    return [synth.scene_full(rng) for _ in range(n)]


def real_held_out(path, split, n=600, seed=5):
    """Real frames from a split training never saw, as (celsius, objects)."""
    real = pickle.load(open(path, 'rb'))[split]
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(n):
        t, objects, _ = real_frame(real, rng)
        out.append((t, objects))
    return out


def predict(net, frames, device, threshold=PEAK_THRESHOLD):
    """Per frame: [(class index, x, y)] of every peak, in frame pixels."""
    net.eval()
    found = []
    with torch.no_grad():
        for i in range(0, len(frames), 256):
            x = torch.stack([torch.from_numpy(synth.model_input(t)) for t, _ in frames[i:i + 256]])
            heat, _ = net(x.to(device))
            pk = peaks(torch.sigmoid(heat), threshold).cpu().numpy()
            for f in pk:
                ks, ys, xs = np.nonzero(f)
                found.append([(int(k), (x + 0.5) * 4, (y + 0.5) * 4) for k, y, x in zip(ks, ys, xs)])
    net.train()
    return found


def evaluate(net, frames, device, threshold=PEAK_THRESHOLD):
    found = predict(net, frames, device, threshold)
    truth = [sum(o['cls'] == 'person' for o in objs) for _, objs in frames]
    counts = [sum(k == 0 for k, _, _ in f) for f in found]
    return score(truth, counts), found


def per_class(frames, found, reach=8.0):
    """How often each kind of thing is found (recall) and how often a name
    given is right (precision). A find matches a real thing of the same kind
    within `reach` pixels of its point."""
    out = {}
    for k, name in enumerate(synth.CLASSES):
        tp = fn = fp = 0
        for (_, objs), f in zip(frames, found):
            real = [(o['x'], o['y']) for o in objs if o['cls'] == name]
            said = [(x, y) for kk, x, y in f if kk == k]
            used = set()
            for rx, ry in real:
                best = None
                for j, (sx, sy) in enumerate(said):
                    if j in used:
                        continue
                    d = ((sx - rx) ** 2 + (sy - ry) ** 2) ** 0.5
                    if d <= reach and (best is None or d < best[0]):
                        best = (d, j)
                if best:
                    used.add(best[1])
                    tp += 1
                else:
                    fn += 1
            fp += len(said) - len(used)
        out[name] = {'real': tp + fn,
                     'found': round(tp / max(1, tp + fn), 3),
                     'right_when_named': round(tp / max(1, tp + fp), 3)}
    return out


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

    class Exported(torch.nn.Module):
        def __init__(self, inner):
            super().__init__()
            self.inner = inner

        def forward(self, x):
            heat, raw = self.inner(x)
            return torch.sigmoid(heat), torch.exp(raw.clamp(0.0, 6.0)) - 1.0

    torch.onnx.export(Exported(net), torch.zeros(1, 2, synth.ROWS, synth.COLS), str(path),
                      input_names=['frame'], output_names=['heat', 'ltrb'], opset_version=17,
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
    ap.add_argument('--real', default=None,
                    help='real_cache.pkl: public, commercially licensed real frames to mix in')
    ap.add_argument('--real-share', type=float, default=0.35)
    ap.add_argument('--init', default=None,
                    help='a best.pt to start the shared layers from, such as owl-1')
    ap.add_argument('--name', default='owl-2',
                    help='the name this model is known by on the unit and in the report')
    args = ap.parse_args(argv)
    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    torch.manual_seed(args.seed)

    net = PeopleNet(args.width, classes=K, boxes=True).to(device)
    if args.init:
        # Everything but the output layer carries over; that is where owl-1
        # learned what a person looks like in this camera.
        state = torch.load(args.init, map_location=device)
        own = net.state_dict()
        # Layers that fit carry over, the output layer included when the
        # kinds of things are the same (fine-tuning owl-3); a layer whose
        # shape changed (owl-1's single map into owl-2's ten) starts fresh.
        state = {k: v for k, v in state.items() if k in own and own[k].shape == v.shape}
        missing = net.load_state_dict(state, strict=False)
        print(f'started from {args.init}; new layers: {missing.missing_keys}', flush=True)
    params = sum(p.numel() for p in net.parameters())
    print(f'{params:,} parameters on {device}', flush=True)
    opt = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, args.lr, total_steps=args.steps, pct_start=0.05)
    loader = DataLoader(Frames(args.seed, args.real, args.real_share if args.real else 0.0),
                        batch_size=args.batch, num_workers=args.workers,
                        persistent_workers=True, prefetch_factor=4)
    val = held_out(1500)
    # Chosen on real frames as much as generated ones: a model that is
    # perfect on drawings and wrong in a real room is the failure this guards.
    real_val = real_held_out(args.real, 'val') if args.real else []
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
    for step, (x, heat, ltrb, mask, known) in enumerate(loader, start + 1):
        x, heat = x.to(device, non_blocking=True), heat.to(device, non_blocking=True)
        ltrb, mask = ltrb.to(device, non_blocking=True), mask.to(device, non_blocking=True)
        known = known.to(device, non_blocking=True)
        logits, raw = net(x)
        loss = focal_loss(logits, heat, known=known) + box_loss(raw, ltrb, mask)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(net.parameters(), 5.0)
        opt.step()
        sched.step()
        running = 0.98 * running + 0.02 * loss.item() if step > 1 else loss.item()
        if step % 500 == 0 or step == args.steps:
            s, _ = evaluate(net, val, device)
            r = evaluate(net, real_val, device)[0] if real_val else None
            rate = (step - start) * args.batch / (time.time() - t0)
            print(f'step {step} loss {running:.3f} exact {s["exact"]} within1 {s["within_one"]} '
                  f'mae {s["mean_abs_error"]}' + (f' | real exact {r["exact"]} within1 '
                  f'{r["within_one"]} mae {r["mean_abs_error"]}' if r else '') +
                  f' ({rate:.0f} frames/s)', flush=True)
            mark = s['mean_abs_error'] + (r['mean_abs_error'] if r else 0.0)
            if best is None or mark < best:
                best = mark
                torch.save(net.state_dict(), out / 'best.pt')
            torch.save({'net': net.state_dict(), 'opt': opt.state_dict(),
                        'sched': sched.state_dict(), 'step': step, 'best': best},
                       out / 'last.pt')
        if step >= args.steps:
            break

    net.load_state_dict(torch.load(out / 'best.pt', map_location=device))
    test = held_out(3000, seed=999)
    model_score, found = evaluate(net, test, device)
    rule_score = score([sum(o['cls'] == 'person' for o in objs) for _, objs in test],
                       rule_counts(test))
    report = {'name': args.name, 'classes': list(synth.CLASSES), 'parameters': params,
              'steps': args.steps, 'model': model_score, 'rule': rule_score,
              'things': per_class(test, found)}
    (out / 'report.json').write_text(json.dumps(report, indent=2))
    export(net, out / 'people.onnx')
    print(json.dumps(report, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
