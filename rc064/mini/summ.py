"""Summarise drive.py results.json: python3 summ.py results.json [flow...]"""
import json
import statistics
import sys

r = json.load(open(sys.argv[1]))
want = set(sys.argv[2:])
F = r["flows"]
SIDES = [s for s in ("v062", "base", "head") if any(s in F[f] for f in F)]
NAME = {"v062": "0.6.2", "base": "0.6.3", "head": "head"}


def med(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    if not xs:
        return "-"
    m = statistics.median(xs)
    return f"{m:.2f} [{min(xs):.2f}..{max(xs):.2f}] n={len(xs)}"


def row(label, per_side):
    print(f"  {label:<34}" + " | ".join(f"{NAME[s]}: {per_side.get(s, '-')}" for s in SIDES))


def g(d, *path):
    for p in path:
        if not isinstance(d, dict):
            return None
        d = d.get(p)
    return d


def video_streams(media):
    out = []
    for name, probe in (media or {}).items():
        for s in (probe or {}).get("streams", []):
            if s.get("codec_type") == "video":
                try:
                    fr = int(s.get("nb_frames") or 0)
                    du = float(s.get("duration") or probe.get("duration") or 0)
                except (TypeError, ValueError):
                    continue
                out.append((name, fr, du, f"{s.get('width')}x{s.get('height')}", (probe.get("decodes") or {}).get("ok")))
    return out


def outs_of(e):
    return {k: (round(v.get("duration", 0), 2), [(st.get("codec_type"), st.get("nb_frames"), st.get("width"), st.get("height")) for st in v.get("streams", [])], (v.get("decodes") or {}).get("ok")) for k, v in (e.get("outputs") or {}).items()}


print("OS", r.get("os"), "errors:", [e["flow"] for e in r.get("errors", [])])

if (not want or "startup" in want) and "startup" in F:
    print("startup")
    row("first window s (rounds 1+)", {s: med([e["first_window_s"] for e in F["startup"].get(s, []) if e.get("round", 0) > 0]) for s in SIDES})
    row("first window s (cold round 0)", {s: med([e["first_window_s"] for e in F["startup"].get(s, []) if e.get("round", 0) == 0]) for s in SIDES})
    row("idle cpu %", {s: med([g(e, "idle", "cpu_mean_pct") for e in F["startup"].get(s, [])]) for s in SIDES})
    row("idle rss MB", {s: med([g(e, "idle", "rss_mean_mb") for e in F["startup"].get(s, [])]) for s in SIDES})
    row("alive", {s: str([e.get("alive") for e in F["startup"].get(s, [])]) for s in SIDES})

if (not want or "instant" in want) and "instant" in F:
    print("instant 60 s + upload")
    for s in SIDES:
        for e in F["instant"].get(s, []):
            vs = video_streams(e.get("local_media"))
            print(f"  {NAME[s]}: verified={e.get('verified')} stop->verified={e.get('stop_to_verified_s')} cpu={g(e,'recording_resources','cpu_mean_pct')} rss={g(e,'recording_resources','rss_mean_mb')} server={e.get('server')} video={[(n.split('/')[-1], f, round(d,1), wh, ok) for n, f, d, wh, ok in vs]} errors={len(e.get('log_errors') or [])}")
            print(f"     uploaded: {json.dumps(e.get('uploaded_media') or {})[:300]}")

if (not want or "studio" in want) and "studio" in F:
    print("studio 30 s with pause")
    for s in SIDES:
        for e in F["studio"].get(s, []):
            vs = video_streams(e.get("local_media"))
            print(f"  {NAME[s]}: finished={e.get('finished')} status={e.get('status')} stop->idle={e.get('stop_to_idle_s')} cpu={g(e,'recording_resources','cpu_mean_pct')} rss={g(e,'recording_resources','rss_mean_mb')} video={[(n, f, round(d,1), wh, ok) for n, f, d, wh, ok in vs][:4]} errors={(e.get('log_errors') or [])[:2]}")
if (not want or "studio" in want) and "export" in F:
    print("exports")
    for kind in ("mp4", "gif", "tracks"):
        row(f"{kind} export s", {s: med([e.get("export_s") for e in F["export"].get(s, []) if e.get("kind") == kind]) for s in SIDES})
    for s in SIDES:
        for e in F["export"].get(s, []):
            print(f"    {NAME[s]} {e.get('kind')} r{e.get('round')}: {e.get('export_s')} s {json.dumps(outs_of(e))[:260]} err={len(e.get('log_errors') or [])}")

if (not want or "export4k" in want) and "export4k" in F:
    print("export default vs 4K")
    for preset in ("default", "4k"):
        row(f"{preset} export s", {s: med([e.get("export_s") for e in F["export4k"].get(s, []) if e.get("preset") == preset]) for s in SIDES})
    for s in SIDES:
        for e in F["export4k"].get(s, []):
            print(f"    {NAME[s]} {e.get('preset')} r{e.get('round')}: {e.get('export_s')} s {json.dumps(outs_of(e))[:240]}")

if (not want or "targets" in want) and "targets" in F:
    print("targets (studio 12 s)")
    for t in ("display", "window", "area"):
        for s in SIDES:
            es = [e for e in F["targets"].get(s, []) if e.get("target") == t]
            desc = []
            for e in es:
                vs = video_streams(e.get("local_media"))
                desc.append(f"fin={e.get('finished')} st={json.dumps(e.get('status'))} cpu={g(e,'recording_resources','cpu_mean_pct')} v={[(f, round(d,1), wh, ok) for _, f, d, wh, ok in vs][:2]} err={len(e.get('log_errors') or [])}")
            print(f"  {t:<8} {NAME[s]}: " + " ; ".join(desc))

if (not want or "hotkeys" in want) and "hotkeys" in F:
    print("hotkeys")
    for s in SIDES:
        print(f"  {NAME[s]}: {json.dumps(F['hotkeys'].get(s))[:400]}")

if (not want or "perf" in want) and "perf" in F:
    print("perf (same machine, rotated)")
    labels = sorted({e["label"] for s in SIDES for e in F["perf"].get(s, [])})
    for lab in labels:
        es = {s: [e for e in F["perf"].get(s, []) if e["label"] == lab] for s in SIDES}
        row(f"{lab} cpu %", {s: med([g(e, "recording_resources", "cpu_mean_pct") for e in es[s]]) for s in SIDES})
        row(f"{lab} rss MB", {s: med([g(e, "recording_resources", "rss_mean_mb") for e in es[s]]) for s in SIDES})
        row(f"{lab} rss peak MB", {s: med([g(e, "recording_resources", "rss_peak_mb") for e in es[s]]) for s in SIDES})
        row(f"{lab} stop->complete s", {s: med([e.get("stop_to_complete_s") or e.get("stop_to_verified_s") for e in es[s]]) for s in SIDES})
        fps = {}
        for s in SIDES:
            vals = []
            for e in es[s]:
                for v in (e.get("display") or {}).values():
                    if v.get("fps"):
                        vals.append(v["fps"])
            fps[s] = med(vals)
        row(f"{lab} screen fps", fps)
        row(f"{lab} status", {s: str([json.dumps(e.get("status"))[:30] for e in es[s]]) for s in SIDES})
        if lab == "studio60":
            row("playback cpu %", {s: med([g(e, "playback", "playback_resources", "cpu_mean_pct") for e in es[s]]) for s in SIDES})
            row("playback rss MB", {s: med([g(e, "playback", "playback_resources", "rss_mean_mb") for e in es[s]]) for s in SIDES})
            row("editor window s", {s: med([g(e, "playback", "editor_window_s") for e in es[s]]) for s in SIDES})
            for s in SIDES:
                print(f"    frame stats {NAME[s]}: {[(g(e, 'playback', 'frame_stats') or [''])[-1][-110:] for e in es[s]]}")

if (not want or "playab" in want) and "playab" in F:
    print("playback A/B (same project, rotated)")
    for warm in (False, True):
        row(f"playback cpu % {'warm' if warm else 'cold'}", {s: med([g(e, "playback_resources", "cpu_mean_pct") for e in F["playab"].get(s, []) if bool(e.get("warm")) == warm]) for s in SIDES})
        import re as _re
        def pf(e, key):
            for l in e.get("frame_stats") or []:
                m = _re.search(key + r"=([0-9.]+)", l)
                if m and "playback fps" in l:
                    return float(m.group(1))
            return None
        def fs(e, key):
            for l in e.get("frame_stats") or []:
                m = _re.search(key + r'="?([0-9.]+)', l)
                if m and "frame stats" in l:
                    return float(m.group(1))
            return None
        row(f"  playback fps {'warm' if warm else 'cold'}", {s: med([pf(e, "playback fps") for e in F["playab"].get(s, []) if bool(e.get("warm")) == warm]) for s in SIDES})
        row(f"  paints/s {'warm' if warm else 'cold'}", {s: med([pf(e, "paint_submitted_fps") for e in F["playab"].get(s, []) if bool(e.get("warm")) == warm]) for s in SIDES})
        row(f"  frame p99 ms {'warm' if warm else 'cold'}", {s: med([fs(e, "p99_ms") for e in F["playab"].get(s, []) if bool(e.get("warm")) == warm]) for s in SIDES})
    if "editor_idle" in F:
        row("editor open idle cpu %", {s: med([g(e, "idle_resources", "cpu_mean_pct") for e in F["editor_idle"].get(s, [])]) for s in SIDES})
    row("playback rss MB", {s: med([g(e, "playback_resources", "rss_mean_mb") for e in F["playab"].get(s, [])]) for s in SIDES})
    row("editor window s", {s: med([e.get("editor_window_s") for e in F["playab"].get(s, [])]) for s in SIDES})
    for s in SIDES:
        print(f"    {NAME[s]}: {[(g(e, 'playback_resources', 'cpu_mean_pct'), [l[-90:] for l in (e.get('frame_stats') or []) if 'playback fps' in l][:1]) for e in F['playab'].get(s, [])]}")

if (not want or "devices" in want) and "devices" in F:
    print("devices (unplug 20 s, replug 30 s, 60 s rec)")
    for s in SIDES:
        for e in F["devices"].get(s, []):
            summ = {}
            for k, v in (e.get("rms_db") or {}).items():
                if v:
                    before, after = v[5:19], v[33:55]
                    summ[k] = (len(v), max(before) if before else None, max(after) if after else None)
            print(f"  {e['kind']} {e['mode']} {NAME[s]} r{e['round']}: st={json.dumps(e.get('status'))[:40]} stop->complete={e.get('stop_to_complete_s')} secs/maxdB pre/post={summ} unplug_rc={g(e,'unplug','rc')} errors={len(e.get('log_errors') or [])}")
            for line in (e.get("device_log") or [])[-4:]:
                print(f"      {line[-160:]}")
