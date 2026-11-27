import json
import statistics
import sys

r = json.load(open(sys.argv[1]))
N = {"v062": "0.6.2", "base": "0.6.3", "head": "head"}
print(r.get("os"), "errors:", [e["flow"] for e in r.get("errors", [])])
src = r["flows"].get("exportab_source", {})
for s, es in src.items():
    for e in es:
        print("source", N[s], e.get("display"))
for s in ("v062", "base", "head"):
    es = r["flows"].get("exportab", {}).get(s, [])
    if not es:
        continue
    t = [e.get("export_s") for e in es if e.get("export_s")]
    outs = []
    for e in es[:1]:
        for k, v in (e.get("outputs") or {}).items():
            vs = [st for st in v.get("streams", []) if st.get("codec_type") == "video"]
            if vs:
                fr = int(vs[0].get("nb_frames") or 0)
                du = float(vs[0].get("duration") or v.get("duration") or 0)
                outs.append((vs[0].get("width"), vs[0].get("height"), fr, round(du, 2), round(fr / du, 1) if du else None))
    print(f"{N[s]:>5} preset={es[0].get('preset')} src_fps={es[0].get('src_fps')} wall s median {statistics.median(t) if t else None} {t} bytes {[e.get('bytes') for e in es]} video {outs}")
