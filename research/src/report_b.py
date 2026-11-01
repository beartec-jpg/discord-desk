import pandas as pd, numpy as np, json
pd.set_option("display.width",300); pd.set_option("display.max_colwidth",120); pd.set_option("display.max_columns",40)
d=pd.read_csv("../out/testB_patterns.csv"); d["tf"]=d.study.str.split("-").str[0]; d["var"]=d.study.str.split("|").str[1]
d["pat_key"]=d.study+"::"+d.pattern.map(lambda p:" & ".join(sorted(p.split(" & "))))
d=d.drop_duplicates("pat_key")
mz=lambda r: 8 if r.tf=="daily" else 3
d["cross_col"]=[c for c in d.columns if c.endswith("_OOS_lift") and c not in("IS_OOS_lift",)][0]
def xl(r,part):
    for a in ("BTC","XRP"):
        if f"{a}_{part}_lift" in d.columns and not pd.isna(r.get(f"{a}_{part}_lift")): return r[f"{a}_{part}_lift"]
    return np.nan
d["X_IS_lift"]=d.apply(lambda r:xl(r,"IS"),axis=1); d["X_OOS_lift"]=d.apply(lambda r:xl(r,"OOS"),axis=1)
d["oos_ok"]=(d.OOS_support>=10)&(d.OOS_hits>=3)&(d.OOS_lift>=1.5)&(d.OOS_zones_hit>=2)
d["is_ok"]=d.sig_FWER10&(d.IS_lift>=2)&(d.IS_zones_hit>=d.tf.map({"daily":8,"weekly":3}))
d["replicates"]=(d.X_OOS_lift>=1.2)&(d.X_IS_lift>=1.2)
d["PASS"]=d.is_ok&d.oos_ok
d.to_csv("../out/testB_patterns_flagged.csv",index=False)
print(d.groupby(["study"]).agg(n=("PASS","size"),sig10=("sig_FWER10","sum"),is_ok=("is_ok","sum"),oos_ok=("oos_ok","sum"),PASS=("PASS","sum"),replic=("replicates","sum")))
cols=["kind","pattern","IS_support","IS_lift","IS_zones_hit","IS_zones","OOS_support","OOS_hits","OOS_lift","OOS_zones_hit","OOS_zones","X_IS_lift","X_OOS_lift","z_IS","sig_FWER05"]
print(d[d.PASS].sort_values(["study","z_IS"],ascending=[True,False])[["study"]+cols].round(2).to_string())
