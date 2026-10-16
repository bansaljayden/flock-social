#!/usr/bin/env python3
"""Grade the sealed Flux recordings, once (OWL-RECORDING-PROTOCOL.md, section 14).

    python score_sealed.py --unsealed <dir> --sums <dir with *.SHA256SUMS> --freeze FREEZE.txt \\
        --models <dir with people.onnx and people-fine.onnx> --out <report dir> [--rerun-reason "<text>"]

In order: every hash is checked before anything is read (14.1); the two counters' tally exports are
loaded and each count is tied to its beep (14.2); the phone and Pi clocks are lined up from the
palm-over-the-lens SYNC marks (14.3); each beep gets the frame nearest beep + 1.0 s (14.4); that frame
is counted by Owl and by the heat-cluster rule exactly as the sensor counts it (14.5); and the scores,
intervals and pre-registered bars are written as items.csv, report.md, report.json and GRADED.lock
(14.6, 14.7). Nothing written holds a temperature or an image: numbers and codes only.
"""
import argparse
import csv
import datetime
import hashlib
import json
import math
import os
import re
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SENSOR_DIR = HERE.parent
sys.path.insert(0, str(HERE))
from frames import read_session  # noqa: E402

MAX_COUNT_LAG_S = 25.0      # a count belongs to a beep if saved within 25 s of it (14.2)
FRAME_AFTER_BEEP_S = 1.0    # the item's frame is the one nearest beep + 1.0 s (3, 14.4)
FRAME_TOLERANCE_S = 1.0     # ...and must fall within 1.0 s of that target, or the item is "no frame"
SYNC_SEARCH_S = 15.0        # a SYNC event is looked for within 15 s of its note (14.3)
SYNC_JUMP_C = 5.0           # palm over the lens: the frame median jumps at least 5 C...
SYNC_LOOKBACK = 10          # ...above the median of the 10 frames before it
SYNC_EXCLUDE_S = 10.0       # frames within 10 s of a SYNC event are never scored
OFFSET_IGNORE_S = 1.5       # a mean clock offset this small is not corrected
OFFSET_SPREAD_S = 1.0       # start and end offsets further apart than this: clock-uncertain
MOVING_SCENES = {'S5', 'S7', 'S10'}   # dropped from clock-uncertain sessions; still scenes are kept
BOOTSTRAP = 10000
SEED = 20261014
BINS = (('0', 0, 0), ('1-2', 1, 2), ('3-5', 3, 5), ('6-10', 6, 10), ('11-15', 11, 15), ('16+', 16, 10 ** 6))


class Refused(Exception):
    pass


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def parse_sums(path):
    """[(sha256, file name)] from a sha256sum listing ("<hex>  name" or "<hex> *name")."""
    out = []
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line:
            continue
        m = re.match(r'^([0-9a-fA-F]{64})\s+\*?(.+)$', line)
        if not m:
            raise Refused(f'{path}: a line that is not a sha256sum entry: {line[:60]!r}')
        out.append((m.group(1).lower(), m.group(2).strip()))
    return out


def parse_freeze(path):
    """The hashes FREEZE.txt pins: the two model files and this scorer."""
    text = Path(path).read_text(encoding='utf-8')
    found = {}
    for name in ('people.onnx', 'people-fine.onnx', 'score_sealed.py'):
        m = re.search(re.escape(name) + r'\b[^\n]*?sha256\s+([0-9a-fA-F]{64})', text)
        if not m:
            raise Refused(f'FREEZE.txt has no sha256 for {name}')
        found[name] = m.group(1).lower()
    return found


def verify(unsealed, sums, freeze_path, models, out, rerun_reason, scorer=Path(__file__)):
    """14.1. Everything is checked before a frame or a count is read. Returns what was checked."""
    unsealed, sums, models, out = Path(unsealed), Path(sums), Path(models), Path(out)
    freeze = parse_freeze(freeze_path)
    checked = {}
    sum_files = sorted(sums.glob('*.SHA256SUMS'))
    if not sum_files:
        raise Refused(f'no .SHA256SUMS files in {sums}')
    sessions = []
    for sf in sum_files:
        session = sf.name[:-len('.SHA256SUMS')]
        folder = unsealed / session
        if not folder.is_dir():
            raise Refused(f'{folder} is missing')
        listed = set()
        for want, name in parse_sums(sf):
            if name.endswith('.tar.gpg'):
                target = sums / name           # the sealed archive sits beside its listing (9.5)
            else:
                target = folder / name
                listed.add(name)
            if not target.is_file():
                raise Refused(f'{target} is named in {sf.name} but missing')
            got = sha256_file(target)
            if got != want:
                raise Refused(f'{target} has sha256 {got[:12]}, {sf.name} says {want[:12]}')
            checked[str(target)] = got
        extra = sorted(p.name for p in folder.iterdir() if p.name not in listed)
        if extra:
            raise Refused(f'{folder} holds files no listing names: {", ".join(extra)}')
        sessions.append(session)
    stray = sorted(p.name for p in unsealed.iterdir() if p.is_dir() and p.name not in sessions)
    if stray:
        raise Refused(f'{unsealed} holds sessions with no .SHA256SUMS: {", ".join(stray)}')
    for name in ('people.onnx', 'people-fine.onnx'):
        p = models / name
        if not p.is_file():
            raise Refused(f'{p} is missing')
        got = sha256_file(p)
        if got != freeze[name]:
            raise Refused(f'{name} has sha256 {got[:12]}, FREEZE.txt says {freeze[name][:12]}')
        checked[str(p)] = got
    me = sha256_file(scorer)
    if me != freeze['score_sealed.py']:
        raise Refused(f'this scorer has sha256 {me[:12]}, FREEZE.txt says {freeze["score_sealed.py"][:12]}')
    checked['score_sealed.py'] = me
    if (out / 'report.json').exists() and not rerun_reason:
        raise Refused(f'{out} already holds a report.json: the set is graded once (a rerun needs --rerun-reason)')
    return {'sessions': sessions, 'hashes': checked, 'freeze': freeze}


# ------------------------------------------------------------------ 14.2 counts
def read_tally(path):
    with open(path, encoding='utf-8-sig', newline='') as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        r['t'] = float(r['epoch_ms']) / 1000.0
    return rows


def counter_role(code):
    """'A' or 'B' from a counter code such as 'A-JB' or 'B KM'."""
    m = re.match(r'^\s*([ABab])(?:$|[^A-Za-z])', code or '')
    return m.group(1).upper() if m else None


def assign_counts(rows, max_lag=MAX_COUNT_LAG_S):
    """{slot: count row} for one counter, and how many counts came too late.
    A count belongs to the latest reminder at or before its save time, if saved within max_lag of it.
    A slot saved twice keeps the later save (the earlier one is what the counter corrected)."""
    reminders = sorted((r for r in rows if r['type'] == 'reminder'), key=lambda r: r['t'])
    counts = sorted((r for r in rows if r['type'] == 'count' and str(r.get('voided', '0')) == '0'
                     and (r.get('zone') or 'room') == 'room'), key=lambda r: r['t'])
    by_slot, late = {}, 0
    for c in counts:
        before = [r for r in reminders if r['t'] <= c['t']]
        if not before or c['t'] - before[-1]['t'] > max_lag:
            late += 1
            continue
        by_slot[before[-1]['slot']] = c
    return by_slot, late


def notes_of(rows):
    return sorted(((r['t'], (r.get('note') or '').strip()) for r in rows
                   if r['type'] == 'note' and str(r.get('voided', '0')) == '0' and (r.get('note') or '').strip()),
                  key=lambda x: x[0])


def note_fields(notes, t, scene_start):
    """Scene-level and per-beep notes in force at a beep: the latest of each kind at or before
    t + MAX_COUNT_LAG_S, within the current scene (a note at the scene's start covers the scene)."""
    away = seats = None
    things = ''
    for nt, text in notes:
        if nt > t + MAX_COUNT_LAG_S:
            break
        if nt < scene_start:
            continue
        m = re.search(r'\baway\s+(\d+)', text, re.I)
        if m:
            away = int(m.group(1))
        m = re.search(r'\bseats\s+(\d+)', text, re.I)
        if m:
            seats = int(m.group(1))
        tokens = text.upper().split()
        if tokens and all(tok in {'H', 'L', 'S', 'R', 'P'} for tok in tokens):
            things = ''.join(sorted(set(tokens)))
    return away, seats, things


def scene_and_placement(notes, t, header_note):
    scene, scene_start, placement = None, float('-inf'), None
    m = re.search(r'\bP([123])\b', header_note or '')
    if m:
        placement = 'P' + m.group(1)
    for nt, text in notes:
        if nt > t:
            break
        m = re.search(r'\b(S(?:10|[1-9]))\s+start\b', text, re.I)
        if m:
            scene, scene_start = m.group(1).upper(), nt
        m = re.search(r'\bP([123])\b', text)
        if m:
            placement = 'P' + m.group(1)
    return scene, scene_start, placement


# ------------------------------------------------------------------ 14.3 clocks
def median(values):
    v = sorted(values)
    n = len(v)
    return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2.0


def find_sync_event(times, medians, note_time):
    """Wall time of the first frame within SYNC_SEARCH_S of the note whose median is at least
    SYNC_JUMP_C above the median of the SYNC_LOOKBACK frames before it, or None."""
    for i, t in enumerate(times):
        if abs(t - note_time) > SYNC_SEARCH_S or i < SYNC_LOOKBACK:
            continue
        if medians[i] >= median(medians[i - SYNC_LOOKBACK:i]) + SYNC_JUMP_C:
            return t
    return None


def clock_offsets(sync_notes, times, medians):
    """Offsets (frame time minus note time) at the first and last SYNC, their mean, the correction
    applied, and whether the session is clock-uncertain."""
    events = [(nt, find_sync_event(times, medians, nt)) for nt in sync_notes]
    found = [(nt, ft) for nt, ft in events if ft is not None]
    res = {'sync_notes': len(sync_notes), 'sync_events': len(found), 'start_offset': None,
           'end_offset': None, 'mean_offset': 0.0, 'correction': 0.0, 'clock_uncertain': False,
           'event_times': [ft for _, ft in found]}
    if len(sync_notes) < 2 or len(found) < len(sync_notes) or not found:
        res['clock_uncertain'] = True
    if found:
        start = found[0][1] - found[0][0]
        end = found[-1][1] - found[-1][0]
        res['start_offset'], res['end_offset'] = round(start, 3), round(end, 3)
        mean = (start + end) / 2.0
        res['mean_offset'] = round(mean, 3)
        if abs(start - end) > OFFSET_SPREAD_S:
            res['clock_uncertain'] = True
        res['correction'] = round(mean, 3) if abs(mean) > OFFSET_IGNORE_S else 0.0
    return res


# ------------------------------------------------------------------ 14.4 frames
def match_frame(times, flat, target, excluded=(), tolerance=FRAME_TOLERANCE_S):
    """Index of the frame nearest target that is not a shutter frame and not excluded,
    if within tolerance of target; else None."""
    order = sorted(range(len(times)), key=lambda i: abs(times[i] - target))
    for i in order:
        if abs(times[i] - target) > tolerance:
            return None
        if i in excluded or flat[i]:
            continue
        return i
    return None


# ------------------------------------------------------------------ 14.5 counters
_SENSOR = None


def sensor():
    """The sensor's own main.py, imported with its device paths pointed at a temporary folder
    (as test_main.py does) and the screen off, so Owl runs on one thread, deterministically."""
    global _SENSOR
    if _SENSOR is None:
        tmp = Path(tempfile.mkdtemp(prefix='score-sealed-'))
        (tmp / 'config.env').write_text('THERMAL_VIEW=0\n', encoding='utf-8')
        os.environ['FLOCK_CONFIG'] = str(tmp / 'config.env')
        os.environ['FLOCK_LOG'] = str(tmp / 'sensor.log')
        os.environ['FLOCK_BUFFER'] = str(tmp / 'buffer.json')
        sys.path.insert(0, str(SENSOR_DIR))
        import main
        _SENSOR = main
    return _SENSOR


def load_owl(models):
    s = sensor()
    m = s.PeopleModel(Path(models) / 'people.onnx', 0.4)
    m.fine = s.PeopleModel(Path(models) / 'people-fine.onnx', 0.4)
    m.CROWD_AT = 5
    return m


# ------------------------------------------------------------------ 14.6 scores
def wilson(k, n, z=1.96):
    if n == 0:
        return [None, None]
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(100 * (c - h), 1), round(100 * (c + h), 1)]


def metrics(items, key, truth='T'):
    rows = [it for it in items if it.get(key) is not None and it.get(truth) is not None]
    n = len(rows)
    if not n:
        return {'n': 0}
    err = [it[key] - it[truth] for it in rows]
    ex = sum(1 for e in err if e == 0)
    w1 = sum(1 for e in err if abs(e) <= 1)
    return {'n': n, 'exact': round(100 * ex / n, 1), 'exact_wilson': wilson(ex, n),
            'within_one': round(100 * w1 / n, 1), 'within_one_wilson': wilson(w1, n),
            'mae': round(sum(abs(e) for e in err) / n, 3), 'bias': round(sum(err) / n, 3),
            'mean_count': round(sum(it[key] for it in rows) / n, 3)}


def block_bootstrap(items, keys=('owl', 'rule'), truth='T'):
    """Percentile intervals from resampling whole sessions (seed 20261014), for exact, within one and
    MAE of each counter, and the paired Owl minus rule difference in exact."""
    import numpy as np
    rows = [it for it in items if all(it.get(k) is not None for k in keys) and it.get(truth) is not None]
    sessions = sorted({it['session'] for it in rows})
    if len(rows) == 0 or len(sessions) == 0:
        return {}
    idx = {s: i for i, s in enumerate(sessions)}
    S = len(sessions)
    tot = np.zeros((S, 1 + 3 * len(keys)))
    for it in rows:
        v = [1.0]
        for k in keys:
            e = it[k] - it[truth]
            v += [float(e == 0), float(abs(e) <= 1), float(abs(e))]
        tot[idx[it['session']]] += v
    rng = np.random.default_rng(SEED)
    draws = rng.integers(0, S, size=(BOOTSTRAP, S))
    weights = np.zeros((BOOTSTRAP, S))
    for b in range(BOOTSTRAP):
        weights[b] = np.bincount(draws[b], minlength=S)
    sums = weights @ tot
    n = sums[:, 0]
    out = {}

    def pct(a):
        return [round(float(np.percentile(a, 2.5)), 2), round(float(np.percentile(a, 97.5)), 2)]
    for j, k in enumerate(keys):
        base = 1 + 3 * j
        out[k] = {'exact': pct(100 * sums[:, base] / n), 'within_one': pct(100 * sums[:, base + 1] / n),
                  'mae': pct(sums[:, base + 2] / n)}
    if len(keys) == 2:
        out['exact_difference'] = pct(100 * (sums[:, 1] - sums[:, 4]) / n)
    out['sessions'] = S
    return out


def bin_of(t):
    for name, lo, hi in BINS:
        if lo <= t <= hi:
            return name
    return None


def bars(items):
    """B1 to B5, as frozen in OWL-RECORDING-PROTOCOL.md section 4."""
    out = {}
    sparse = [it for it in items if it['T'] <= 3]
    m = metrics(sparse, 'owl')
    out['B1'] = {'items': m['n'], 'owl': m,
                 'result': 'NO ITEMS' if not m['n'] else
                 ('PASS' if m['exact'] >= 70 and m['within_one'] >= 90 else 'FAIL')}
    empty = [it for it in items if it.get('scene') == 'S2']
    m = metrics(empty, 'owl')
    out['B2'] = {'items': m['n'], 'owl_mean_count': m.get('mean_count'),
                 'result': 'NO ITEMS' if not m['n'] else ('PASS' if m['mean_count'] <= 0.3 else 'FAIL')}
    mid = [it for it in items if 4 <= it['T'] <= 10]
    m = metrics(mid, 'owl')
    out['B3'] = {'items': m['n'], 'owl': m,
                 'result': 'NO ITEMS' if not m['n'] else ('PASS' if m['within_one'] >= 85 else 'FAIL')}
    crowd = [it for it in items if 11 <= it['T'] <= 15]
    m = metrics(crowd, 'owl')
    out['B4'] = {'items': m['n'], 'owl': m,
                 'result': 'NO ITEMS' if not m['n'] else
                 ('PASS' if m['within_one'] >= 60 and m['mae'] <= 2.0 else 'FAIL')}
    boot = block_bootstrap(items)
    diff = boot.get('exact_difference')
    point = None
    if items:
        point = round(100 * (sum(it['owl'] == it['T'] for it in items) - sum(it['rule'] == it['T'] for it in items))
                      / len(items), 1)
    out['B5'] = {'items': len(items), 'owl_minus_rule_exact': point, 'interval': diff,
                 'result': 'NO ITEMS' if not items or diff is None else ('PASS' if diff[0] > 0 else 'FAIL')}
    return out


def summary(items):
    res = {'overall': {'owl': metrics(items, 'owl'), 'rule': metrics(items, 'rule'),
                       'bootstrap': block_bootstrap(items)}}
    groups = {
        'bin': lambda it: bin_of(it['T']),
        'scene': lambda it: it.get('scene') or 'none',
        'placement': lambda it: it.get('placement') or 'none',
        'hidden': lambda it: str(it.get('hidden') if it.get('hidden') is not None else 'none'),
        'facing_away': lambda it: 'none noted' if it.get('away') is None else ('some' if it['away'] > 0 else 'none'),
        'warm_seats': lambda it: 'none noted' if it.get('seats') is None else ('some' if it['seats'] > 0 else 'none'),
    }
    for gname, fn in groups.items():
        res[gname] = {}
        for g in sorted({fn(it) for it in items}, key=str):
            sub = [it for it in items if fn(it) == g]
            res[gname][g] = {'owl': metrics(sub, 'owl'), 'rule': metrics(sub, 'rule')}
    both = [it for it in items if it.get('B') is not None]
    res['counter_agreement'] = metrics([dict(it, Bc=it['B']) for it in both], 'Bc')
    res['diagnostics'] = {'owl_main_model_alone': metrics(items, 'owl_main'),
                          'owl_median_of_15_frames_15s': metrics(items, 'owl_med15'),
                          'rule_with_learned_background': metrics(items, 'rule_bg')}
    return res


def sensitivity(items, uncertain_sessions):
    out = {}
    with_b = [dict(it, T=it['B']) for it in items if it.get('B') is not None]
    out['truth_counter_B'] = {'owl': metrics(with_b, 'owl'), 'rule': metrics(with_b, 'rule')}
    agree = [it for it in items if it.get('B') is not None and it['B'] == it['T']]
    mean_ab = [dict(it, T=(it['T'] + it['B']) / 2.0) for it in items if it.get('B') is not None]
    out['truth_mean_of_A_and_B'] = {
        'exact_where_A_and_B_agree': {'owl': metrics(agree, 'owl'), 'rule': metrics(agree, 'rule')},
        'within_one_and_mae_on_the_mean': {'owl': metrics(mean_ab, 'owl'), 'rule': metrics(mean_ab, 'rule')}}
    clean = [it for it in items if not it.get('edge') and it.get('hidden') != 2]
    out['edge_and_hidden_2_removed'] = {'owl': metrics(clean, 'owl'), 'rule': metrics(clean, 'rule')}
    sure = [it for it in items if it['session'] not in uncertain_sessions]
    out['clock_uncertain_sessions_removed'] = {'owl': metrics(sure, 'owl'), 'rule': metrics(sure, 'rule')}
    return out


# ------------------------------------------------------------------ one session
def score_session(folder, owl, steps):
    """Items for one unsealed session folder, counted. `steps` collects the drop counts."""
    s = sensor()
    frames_files = sorted(Path(folder).glob('*.frames'))
    if len(frames_files) != 1:
        raise Refused(f'{folder} should hold exactly one .frames file, it holds {len(frames_files)}')
    header, frames = read_session(frames_files[0])
    started = datetime.datetime.fromisoformat(header['started']).timestamp()
    times = [started + t for t, _ in frames]
    temps = [c for _, c in frames]
    medians = [median(c) for c in temps]
    flat = [bool(s.is_shutter_frame(c)) for c in temps]
    tallies = {}
    for p in sorted(Path(folder).glob('counts-*.csv')):
        rows = read_tally(p)
        roles = {counter_role(r.get('counter')) for r in rows if r.get('counter')}
        roles.discard(None)
        if len(roles) != 1:
            raise Refused(f'{p.name}: cannot tell counter A from B (codes {sorted(roles)})')
        tallies[roles.pop()] = rows
    if 'A' not in tallies:
        raise Refused(f'{folder} has no tally from counter A')
    a_rows = tallies['A']
    a_counts, a_late = assign_counts(a_rows)
    b_counts, b_late = assign_counts(tallies['B']) if 'B' in tallies else ({}, 0)
    steps['late_counts_dropped'] += a_late + b_late
    notes = notes_of(a_rows) + (notes_of(tallies['B']) if 'B' in tallies else [])
    notes.sort(key=lambda x: x[0])
    a_notes = notes_of(a_rows)
    sync_notes = [t for t, text in a_notes if text.upper() == 'SYNC']
    clock = clock_offsets(sync_notes, times, medians)
    excluded = {i for i, t in enumerate(times) for ev in clock['event_times'] if abs(t - ev) <= SYNC_EXCLUDE_S}
    bg = s.SceneBackground()
    rule_bg = [s.count_people(c, bg) for c in temps]
    owl_cache = {}

    def owl_count(i):
        if i not in owl_cache:
            owl_cache[i] = owl.read_crowd(temps[i])[2]
        return owl_cache[i]

    items = []
    for rem in sorted((r for r in a_rows if r['type'] == 'reminder'), key=lambda r: r['t']):
        steps['beeps'] += 1
        a = a_counts.get(rem['slot'])
        if a is None:
            steps['no_count_from_A'] += 1
            continue
        scene, scene_start, placement = scene_and_placement(notes, rem['t'], header.get('note'))
        if clock['clock_uncertain'] and scene in MOVING_SCENES:
            steps['clock_uncertain_moving_dropped'] += 1
            continue
        target = rem['t'] + clock['correction'] + FRAME_AFTER_BEEP_S
        i = match_frame(times, flat, target, excluded)
        if i is None:
            steps['no_frame'] += 1
            continue
        away, seats, things = note_fields(notes, rem['t'], scene_start)
        b = b_counts.get(rem['slot'])
        window = [owl_count(j) for j in range(max(0, i - 14), i + 1)]
        items.append({
            'session': Path(folder).name, 'slot': rem['slot'], 'beep_time': rem.get('iso_time', ''),
            'T': int(a['value']), 'B': int(b['value']) if b is not None else None,
            'owl': owl_count(i), 'owl_main': len(owl.read(temps[i])[0]),
            'owl_med15': int(round(median(window))), 'rule': s.count_thermal_clusters(temps[i]),
            'rule_bg': rule_bg[i], 'scene': scene, 'placement': placement,
            'hidden': int(a['occlusion']) if str(a.get('occlusion', '')).strip() != '' else None,
            'edge': int(a.get('edge') or 0), 'away': away, 'seats': seats, 'things': things,
            'frame': i, 'frame_offset_s': round(times[i] - target, 2),
            'clock_uncertain': clock['clock_uncertain']})
        steps['kept'] += 1
    clock = {k: v for k, v in clock.items() if k != 'event_times'}
    return items, clock


ITEM_COLS = ['session', 'slot', 'beep_time', 'T', 'B', 'owl', 'owl_main', 'owl_med15', 'rule', 'rule_bg',
             'scene', 'placement', 'hidden', 'edge', 'away', 'seats', 'things', 'frame', 'frame_offset_s',
             'clock_uncertain']


def write_outputs(out, items, report):
    out.mkdir(parents=True, exist_ok=True)
    with open(out / 'items.csv', 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=ITEM_COLS)
        w.writeheader()
        for it in items:
            w.writerow({k: ('' if it.get(k) is None else it[k]) for k in ITEM_COLS})
    rj = out / 'report.json'
    rj.write_text(json.dumps(report, indent=2), encoding='utf-8')
    (out / 'report.md').write_text(report_md(report), encoding='utf-8')
    (out / 'GRADED.lock').write_text(
        f"graded {report['graded_at']}\nreport.json sha256 {sha256_file(rj)}\n", encoding='utf-8')


def report_md(r):
    o = r['summary']['overall']
    lines = ['# Sealed Flux recordings: graded once', '',
             f"Graded {r['graded_at']} by score_sealed.py (sha256 {r['scorer_sha256']}).",
             'Truth is counter A\'s count at each beep; items are the frame nearest beep + 1.0 s.', '',
             '| Step | Items |', '|---|---|']
    lines += [f'| {k.replace("_", " ")} | {v} |' for k, v in r['steps'].items()]
    lines += ['', '| Counter | Items | Exact % | Within one % | MAE | Bias |', '|---|---|---|---|---|---|']
    for k in ('owl', 'rule'):
        m = o[k]
        if m.get('n'):
            lines.append(f"| {k} | {m['n']} | {m['exact']} | {m['within_one']} | {m['mae']} | {m['bias']} |")
    boot = o.get('bootstrap') or {}
    if boot:
        lines += ['', f"Session-block bootstrap ({BOOTSTRAP} resamples, seed {SEED}, {boot.get('sessions')} sessions): "
                      f"Owl exact {boot['owl']['exact']}, rule exact {boot['rule']['exact']}, "
                      f"Owl minus rule exact {boot.get('exact_difference')}."]
    lines += ['', '| Bar | Result |', '|---|---|']
    lines += [f"| {k} | {v['result']} |" for k, v in r['bars'].items()]
    if r.get('rerun_reason'):
        lines += ['', f"Rerun: {r['rerun_reason']}"]
    return '\n'.join(lines) + '\n'


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--unsealed', required=True)
    ap.add_argument('--sums', required=True)
    ap.add_argument('--freeze', required=True)
    ap.add_argument('--models', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--rerun-reason', default='')
    a = ap.parse_args(argv)
    try:
        checked = verify(a.unsealed, a.sums, a.freeze, a.models, a.out, a.rerun_reason)
        out = Path(a.out)
        if a.rerun_reason and (out / 'report.json').exists():
            out = out / ('rerun-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
        owl = load_owl(a.models)
        steps = {'beeps': 0, 'late_counts_dropped': 0, 'no_count_from_A': 0,
                 'clock_uncertain_moving_dropped': 0, 'no_frame': 0, 'kept': 0}
        items, clocks = [], {}
        for session in checked['sessions']:
            got, clock = score_session(Path(a.unsealed) / session, owl, steps)
            items += got
            clocks[session] = clock
    except Refused as e:
        print(f'refused: {e}', file=sys.stderr)
        return 2
    uncertain = {s for s, c in clocks.items() if c['clock_uncertain']}
    report = {'graded_at': datetime.datetime.now().astimezone().isoformat(timespec='seconds'),
              'scorer_sha256': checked['hashes']['score_sealed.py'], 'hashes_checked': checked['hashes'],
              'rerun_reason': a.rerun_reason or None, 'steps': steps, 'clocks': clocks,
              'summary': summary(items), 'bars': bars(items), 'sensitivity': sensitivity(items, uncertain)}
    write_outputs(out, items, report)
    print(f"graded {len(items)} items from {len(clocks)} sessions; report in {out}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
