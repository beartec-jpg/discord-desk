import sys, pickle, os, itertools, numpy as np, pandas as pd, warnings; warnings.filterwarnings("ignore")
from lib import *; from signals import build; from cands import *; from engine import *
OUTD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "out"); os.makedirs(OUTD, exist_ok=True)

def load_cands(system, asset):
    p = f"{OUTD}/cands_{system}_{asset}.pkl"
    if os.path.exists(p): return pickle.load(open(p, "rb"))
    if system == "v4": r = {(tf, sw): v4_candidates(asset, tf, sw) for tf in TF_MIN for sw in SWING}
    else: r = desk_candidates(asset)
    pickle.dump(r, open(p, "wb")); return r

def run_system(system, asset, sigs, fnames):
    cs = load_cands(system, asset); rows = []; Ss = {}
    groups = cs.items() if system == "v4" else [(("desk",), cs)]
    jobs = []
    for key, (c, cells) in groups:
        S = np.stack([sigs[f].at(c.ts.values) for f in fnames], axis=1) * c.side.values[:, None].astype(np.int8)
        for ck, (R, ex) in cells.items():
            label = (f"{asset}|v4|{key[0]}|{key[1]}|{ck[0]}R|{ck[1]}" if system == "v4" else f"{asset}|desk|{ck}")
            jobs.append((label, c, R, ex, S))
    return jobs

def evaluate(jobs, fnames, singles, combos):
    rows = []
    for label, c, R, ex, S in jobs:
        eval_cell(c, R, ex, S, fnames, np.zeros(len(c), np.int64), c.fee_ok.values, label, rows, combos=combos, regime=(True if "|v4|" in label and singles else None), singles=singles)
    return pd.DataFrame(rows)

def best3(df, fnames):
    f = df[(df["mode"] == "hard") & (df.part == "IS")]; base = df[(df["filter"] == "BASELINE") & (df.part == "IS")].set_index("cell")
    g = f.assign(d=f.avgR - f.cell.map(base.avgR), kept=f.n / f.cell.map(base.n)).groupby("filter").agg(d=("d", "mean"), kept=("kept", "mean"))
    g = g[g.kept >= 0.4].sort_values("d", ascending=False); return list(g.index[:3]), g

if __name__ == "__main__":
    allrows = []; summary = {}
    for system, asset in [("v4", "XRP"), ("desk", "XRP"), ("desk", "BTC")]:
        sigs = build(asset); fnames = list(sigs); jobs = run_system(system, asset, sigs, fnames)
        d1 = evaluate(jobs, fnames, True, ()); top, g = best3(d1, fnames)
        combos = [tuple(x) for x in itertools.combinations(top, 2)] + ([tuple(top)] if len(top) == 3 else [])
        d2 = evaluate(jobs, fnames, False, combos) if combos else pd.DataFrame()
        d = pd.concat([d1, d2], ignore_index=True); d["system"] = f"{system}-{asset}"; allrows.append(d); summary[f"{system}-{asset}"] = {"top3": top, "combos": ["+".join(c) for c in combos]}
        g.to_csv(f"{OUTD}/best3_rank_{system}_{asset}.csv"); print(system, asset, top, flush=True)
    df = pd.concat(allrows, ignore_index=True); df.to_parquet(f"{OUTD}/testA_rows.parquet")
    import json; json.dump(summary, open(f"{OUTD}/testA_combos.json", "w"), indent=1)
