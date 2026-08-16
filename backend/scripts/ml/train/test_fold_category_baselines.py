"""The per-fold category baseline refit, checked against a held-out population.

WHY THIS FILE EXISTS. `category_baseline` and `refined_category_baseline` are
means of the label. prepare_features fits them on the whole training frame and
train_model's GroupKFold then holds out one city per fold, so a held-out city had
already contributed to the cells its own rows are scored against — the reported
cross-validation number came out optimistic. train_model.FoldCategoryBaselines
rebuilds both maps from each fold's own training cities to close that.

Two ways to get it wrong were already measured, and both pass the check you would
naturally reach for:

  * A leave-one-city-out map computed ONCE (each row reading
    (cell_sum - own_city_sum) / (cell_n - own_city_n)) is about six times worse
    than the leak it removes, because the feature then varies by city inside a
    fold and a tree can invert it back to the held-out city's own label level.
    It passes a label-perturbation invariance check.
  * Aggregating the per-fold statistics AFTER the serving-population filter,
    while the map they replace is fitted BEFORE it, moved the feature ~9.3 points
    on 99.9% of the shipped corpus's rows, against ~0.17 for the leak itself. The
    resulting number is not a corrected number; it describes a model whose
    category feature is not the one shipped.

So the property tested here is not invariance. It is exact reproduction against
a held-out population: hold out NO city, and the rebuilt columns must equal the
shipped columns bit for bit. Everything else — the smoothing, the rounding, the
two fallbacks, the population — is downstream of that one equality, which is why
`test_negative_control_old_population` deliberately rebuilds the statistics the
old way and requires this suite to catch it.

Run: python test_fold_category_baselines.py     (no pytest needed)
"""
import sys
import traceback
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))

from prepare_features import (  # noqa: E402
    CAT_KEYS, REFINED_KEYS, add_baseline_features, build_category_cell_aggregates,
    index_category_cells, serving_population_mask,
)
from train_model import (  # noqa: E402
    CATEGORY_FEATURES, FoldCategoryBaselines, LabelContractError, LeakageError,
)

CITIES = ['alpha', 'bravo', 'charlie', 'delta']
CATEGORIES = ['bar', 'cafe', 'club']


def make_frame(seed=7):
    """A corpus with the two properties that make this test able to fail.

    1. Rows with `baseline_busyness == 0`. The serving-population filter drops
       them, so the pre-filter and post-filter label distributions genuinely
       differ — they are given a deliberately different busyness level, which is
       what makes the population confound visible instead of theoretical.
    2. Per-city label offsets, so removing a city from a cell actually moves that
       cell's mean and a fold map is not trivially the whole-frame map.
    """
    rng = np.random.default_rng(seed)
    rows = []
    for ci, city in enumerate(CITIES):
        for cat in CATEGORIES:
            for venue in range(3):
                served = venue > 0  # venue 0 has no baseline -> filtered out
                for dow in range(7):
                    for hour in range(8, 24):
                        level = 40 + 8 * ci + 5 * CATEGORIES.index(cat) + 0.4 * hour
                        if not served:
                            level -= 25  # the filtered-out population sits lower
                        rows.append({
                            'city': city,
                            'venue_id': f'{city}-{cat}-{venue}',
                            'venue_category': cat,
                            'day_of_week': dow,
                            'hour': hour,
                            'busyness_pct': float(np.clip(
                                level + rng.normal(0, 6), 0, 100)),
                            'baseline_busyness': float(level) if served else 0.0,
                            'price_level': float(venue % 3),
                            'rating': 4.0 + 0.2 * (venue % 2),
                            'is_realtime': int(hour % 3 == 0),
                        })
    return pd.DataFrame(rows)


def build_everything(seed=7, aggregate_after_filter=False):
    """The real pipeline, start to finish, on a frame small enough to reason about.

    `aggregate_after_filter` reproduces the design this replaced: statistics
    fitted on the serving population rather than on the frame the shipped map is
    fitted on. It exists so the suite can prove it catches that.
    """
    df = make_frame(seed)
    df, _maps = add_baseline_features(df)

    if aggregate_after_filter:
        rows = df[serving_population_mask(df['baseline_busyness'])].reset_index(drop=True)
        agg = build_category_cell_aggregates(rows, 'city')
        stats = index_category_cells(rows, agg)
    else:
        agg = build_category_cell_aggregates(df, 'city')
        rows = df[serving_population_mask(df['baseline_busyness'])].reset_index(drop=True)
        stats = index_category_cells(rows, agg)

    feature_cols = list(CATEGORY_FEATURES)
    X = rows[feature_cols].to_numpy(dtype=np.float32)
    fc = FoldCategoryBaselines(stats, rows['city'].to_numpy(), feature_cols,
                               rows['busyness_pct'].to_numpy())
    return df, rows, X, feature_cols, fc, stats


# ---------------------------------------------------------------------------


def test_no_city_held_out_reproduces_the_shipped_columns():
    """The whole design in one equality. Not close — equal."""
    _df, rows, X, _cols, fc, _stats = build_everything()
    assert fc.active, fc.reason
    worst = fc.verify_reproduces_shipped(X)
    assert worst == 0.0, f'rebuilt columns differ from shipped by up to {worst}'
    assert len(rows) < len(_df), 'the fixture must exercise the serving filter'


def test_negative_control_old_population():
    """Fitting the statistics on the filtered frame must be REFUSED, not reported.

    Without this, the suite would pass on a pipeline whose "leak-corrected"
    number is dominated by a population change fifty times the leak.
    """
    _df, _rows, X, _cols, fc, _stats = build_everything(aggregate_after_filter=True)
    try:
        fc.verify_reproduces_shipped(X)
    except LeakageError as err:
        assert 'does not reproduce the shipped column' in str(err)
        return
    raise AssertionError(
        'aggregating after the serving-population filter reproduced the shipped '
        'columns exactly, which cannot be true for this fixture — the test has '
        'lost its teeth and would no longer catch the confound it was written for')


def test_fold_map_drops_exactly_the_held_out_city():
    """A fold's cell equals the mean over the OTHER cities, computed independently.

    Recomputed here from the frame with pandas rather than from the sums the
    implementation uses, so an error in the sums cannot cancel itself out.
    """
    df, _rows, _X, _cols, fc, stats = build_everything()
    held = CITIES[1]
    cols = fc.columns_for_fold(held)
    coarse = np.asarray(cols[fc.col_index['category_baseline']], dtype=np.float64)

    kept = df[df['city'] != held]
    expected_cells = kept.groupby(CAT_KEYS)['busyness_pct'].mean().round(1)
    cells = stats['category']['cells']
    row_cell = np.asarray(stats['category']['row_cell'], dtype=np.int64)

    # Check an UNSMOOTHED interior comparison is impossible (the coarse map is
    # smoothed), so verify the smoothing inputs instead: every cell the fold map
    # is built from must be the other-cities mean.
    for idx in (0, len(cells) // 2, len(cells) - 1):
        key = cells[idx]
        want = expected_cells.loc[(key[0], int(key[1]), int(key[2]))]
        got_mean, supported, _s, _n = fc._cell_means('category', np.array(
            [g != held for g in fc.groups]))
        assert supported[idx], f'cell {key} lost all support without {held}'
        assert abs(got_mean[idx] - want) < 1e-9, (
            f'cell {key}: fold mean {got_mean[idx]} != other-cities mean {want}')

    # And the applied column is finite everywhere, one value per cell.
    assert np.isfinite(coarse).all()
    order = np.argsort(row_cell, kind='stable')
    sc, sv = row_cell[order], coarse[order]
    starts = np.flatnonzero(np.r_[True, sc[1:] != sc[:-1]])
    spread = np.maximum.reduceat(sv, starts) - np.minimum.reduceat(sv, starts)
    assert spread.max() == 0.0, (
        'the fold map varies WITHIN a cell, which is the leave-one-city-out-'
        'computed-once formulation that measured six times worse than the leak')


def test_fold_map_actually_moves_the_feature():
    """If holding a city out changed nothing, the refit would be decoration."""
    _df, _rows, X, _cols, fc, _stats = build_everything()
    j = fc.col_index['category_baseline']
    shipped = np.asarray(X[:, j], dtype=np.float64)
    moved = []
    for city in CITIES:
        col = np.asarray(fc.columns_for_fold(city)[j], dtype=np.float64)
        moved.append(float(np.mean(np.abs(col - shipped) > 1e-6)))
    assert max(moved) > 0.05, (
        f'no fold moved more than {max(moved):.1%} of rows; the statistics are not '
        'city-separated and the refit is not removing anything')


def test_v1_statistics_are_refused():
    """An old pickle must stop the run, not silently produce the wrong number."""
    _df, rows, _X, cols, _fc, stats = build_everything()
    old = dict(stats)
    old.pop('version')
    old['fit_population'] = 'serving'
    try:
        FoldCategoryBaselines(old, rows['city'].to_numpy(), cols,
                              rows['busyness_pct'].to_numpy())
    except LabelContractError as err:
        assert 'v1' in str(err) and 'prepare_features' in str(err)
        return
    raise AssertionError('a v1 category_cell_stats block was accepted')


def test_misaligned_row_indexes_are_refused():
    """Positional indexes from a different row order are the silent failure."""
    _df, rows, _X, cols, _fc, stats = build_everything()
    broken = {k: (dict(v) if k in ('category', 'refined') else v)
              for k, v in stats.items()}
    rc = np.array(broken['category']['row_cell'], copy=True)
    rc[:100] = rc[100:200]  # a plausible-looking shuffle, not a length change
    broken['category']['row_cell'] = rc
    try:
        FoldCategoryBaselines(broken, rows['city'].to_numpy(), cols,
                              rows['busyness_pct'].to_numpy())
    except LeakageError:
        return
    raise AssertionError('a misaligned row_cell was accepted')


def test_refined_falls_back_to_the_coarse_value():
    """add_baseline_features fills a missing refined cell with the row's coarse
    value, not the global mean. A fold that loses a refined cell must do the same
    or the two features drift apart exactly where the data is thinnest."""
    _df, _rows, _X, _cols, fc, stats = build_everything()
    held = CITIES[0]
    cols = fc.columns_for_fold(held)
    coarse = np.asarray(cols[fc.col_index['category_baseline']], dtype=np.float64)
    refined = np.asarray(cols[fc.col_index['refined_category_baseline']], dtype=np.float64)
    counts = fc.blocks['refined']['counts']
    keep = np.array([g != held for g in fc.groups])
    lost = counts[keep].sum(0) == 0
    row_cell = np.asarray(stats['refined']['row_cell'], dtype=np.int64)
    orphaned = lost[row_cell]
    assert np.isfinite(refined).all()
    if orphaned.any():
        assert np.allclose(refined[orphaned], coarse[orphaned]), (
            'a refined cell with no support outside the held-out city did not fall '
            'back to the coarse value')


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith('test_')]
    failed = 0
    for t in tests:
        try:
            t()
            print(f'  PASS  {t.__name__}')
        except Exception:
            failed += 1
            print(f'  FAIL  {t.__name__}')
            traceback.print_exc()
    print(f'\n{len(tests) - failed}/{len(tests)} passed')
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
