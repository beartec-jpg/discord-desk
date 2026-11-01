import numpy as np, pandas as pd, itertools, math
from lib import *
from scipy import stats

def stat_cols(prefix, m): return {f"{prefix}_{k}": v for k, v in m.items()}

def eval_cell(c, R, exit_ts, S, fnames, sym_id, base_mask, label, rows, combos=(), regime=None, singles=True):
    """c: candidates sorted by ts. S: (n, F) side-aligned states. Evaluates baseline, each single filter (hard block + size weight), and given combos (tuples of filter names)."""
    n = len(c); ts = c.ts.values; idea = c["idea"].values if "idea" in c else np.full(n, -1)
    valid = base_mask & np.isfinite(R); nidea = int(idea.max()) + 2 if n else 1
    def sel(keep): return select_one_at_a_time(ts, exit_ts, keep & valid, sym_id, idea, 1, nidea)
    b = sel(np.ones(n, bool)); bR = R[b]; bts = ts[b]
    def split(mask_sel, w=None):
        isb = ts[mask_sel] < OOS; r = R[mask_sel]; t_ = ts[mask_sel]; ww = None if w is None else w[mask_sel]
        return (metrics(r, t_, ww), metrics(r[isb], t_[isb], None if ww is None else ww[isb]), metrics(r[~isb], t_[~isb], None if ww is None else ww[~isb]))
    base = split(b)
    for tag, m in zip(("ALL", "IS", "OOS"), base): rows.append({"cell": label, "filter": "BASELINE", "mode": "base", "part": tag, **m})
    if regime is not None and len(bR):      # v4-style sub-cells (baseline only)
        for nm, mk in [("long", c.side.values == 1), ("short", c.side.values == -1)] + [(f"regime{r}", c.regime.values == r) for r in range(4)]:
            mm = b & mk; rows.append({"cell": label, "filter": f"BASELINE[{nm}]", "mode": "base", "part": "ALL", **metrics(R[mm], ts[mm])})
    fi = {f: i for i, f in enumerate(fnames)}
    items = ([((f,), f) for f in fnames] if singles else []) + [(cb, "+".join(cb)) for cb in combos]
    out = []
    for cb, nm in items:
        ix = [fi[f] for f in cb]; sub = S[:, ix]
        # hard block: candidate allowed only if every filter is >=0 (bullish/neutral for long, bearish/neutral for short)
        keep = (sub >= 0).all(axis=1); h = sel(keep); hs = split(h)
        # Welch t, kept vs baseline trades removed by the filter (in-sample)
        rem = b & ~h; kept_is = h & (ts < OOS); rem_is = rem & (ts < OOS)
        wt = stats.ttest_ind(R[kept_is], R[rem_is], equal_var=False) if kept_is.sum() > 2 and rem_is.sum() > 2 else None
        for tag, m in zip(("ALL", "IS", "OOS"), hs): rows.append({"cell": label, "filter": nm, "mode": "hard", "part": tag, **m, "welch_t": (wt.statistic if wt is not None and tag == "IS" else np.nan), "n_blocked_is": int(rem_is.sum())})
        # size weight: same trades as baseline, risk x(1+0.5*mean state) (agree 1.5x, neutral 1x, against .5x)
        w = 1 + 0.5 * sub.mean(axis=1); ws = split(b, w)
        d = ((w - 1) * R)[b & (ts < OOS)]; pt = d.mean() / (d.std(ddof=1) / math.sqrt(len(d))) if len(d) > 2 and d.std(ddof=1) > 0 else np.nan
        d2 = ((w - 1) * R)[b & (ts >= OOS)]
        for tag, m in zip(("ALL", "IS", "OOS"), ws): rows.append({"cell": label, "filter": nm, "mode": "weight", "part": tag, **m, "paired_t": (pt if tag == "IS" else np.nan)})
    return base

def passes(df, min_n=50, tmin=1.65, min_oos=15):
    """df: long rows -> one row per (cell, filter, mode) with IS/OOS columns and pass flags vs baseline of same cell."""
    p = df.pivot_table(index=["cell", "filter", "mode"], columns="part", values=["n", "win", "avgR", "pf", "t", "totR", "maxdd"], aggfunc="first")
    p.columns = [f"{a}_{b}" for a, b in p.columns]; p = p.reset_index()
    ex = df[df.part == "IS"][["cell", "filter", "mode", "welch_t", "paired_t", "n_blocked_is"]].drop_duplicates(["cell", "filter", "mode"])
    p = p.merge(ex, on=["cell", "filter", "mode"], how="left")
    bas = p[p["filter"] == "BASELINE"].set_index("cell"); f = p[(p["filter"] != "BASELINE") & ~p["filter"].str.startswith("BASELINE[")].copy()
    for c in ["avgR", "pf", "n"]:
        for part in ("IS", "OOS", "ALL"): f[f"b_{c}_{part}"] = f.cell.map(bas[f"{c}_{part}"])
    f["is_pass"] = (f.n_IS >= min_n) & (f.avgR_IS > f.b_avgR_IS) & (f.pf_IS > f.b_pf_IS) & (f.t_IS >= tmin)
    f["oos_pass"] = (f.n_OOS >= min_oos) & (f.avgR_OOS > f.b_avgR_OOS) & (f.pf_OOS > f.b_pf_OOS)
    f["oos_thin"] = f.n_OOS < min_oos
    # cutting trades without raising avg R doesn't count: hard-block must raise avgR vs baseline (already in is_pass), weight must also add value (paired t)
    f["add_value"] = np.where(f["mode"] == "weight", f.paired_t >= tmin, f.welch_t >= 0)
    f["PASS"] = f.is_pass & f.oos_pass & f.add_value
    return p, f
