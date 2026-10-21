import json
import os
import pathlib
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

bins = {"runtime": sys.argv[1], "precompiled": sys.argv[2]}
iterations = int(sys.argv[3])
out_path = pathlib.Path(sys.argv[4])
cache_root = pathlib.Path(subprocess.check_output(["getconf", "DARWIN_USER_CACHE_DIR"], text=True).strip())
line_re = re.compile(r"CAPSHADER (\w+) (.*)")


def metal_caches():
    return [p for p in cache_root.iterdir() if "metal" in p.name.lower()] if cache_root.exists() else []


def wipe():
    for p in metal_caches():
        shutil.rmtree(p, ignore_errors=True)


def run(binary):
    data = tempfile.mkdtemp(prefix="rs-data-")
    env = dict(os.environ)
    env.update(
        CAP_GPUI_APP_DATA_DIR=data,
        CAP_GPUI_NO_MENUS="1",
        CAP_GPUI_NO_TRAY="1",
        CAP_GPUI_MUTE_AUDIO="1",
        CAP_GPUI_AUTO_SETTINGS="general",
        RUST_LOG="warn",
    )
    launch = time.time() * 1000
    proc = subprocess.Popen([binary], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, bufsize=1)
    os.set_blocking(proc.stderr.fileno(), False)
    windows, renderers, done = [], {}, {}
    deadline = time.time() + 25
    buf = ""
    settings_seq = None
    while time.time() < deadline:
        try:
            chunk = proc.stderr.read()
        except Exception:
            chunk = None
        if chunk:
            buf += chunk
            *lines, buf = buf.split("\n")
            for line in lines:
                m = line_re.search(line)
                if not m:
                    continue
                kind, rest = m.groups()
                fields = dict(re.findall(r"(\w+)=([^\s]+)", rest))
                if kind == "window_open":
                    title = re.search(r'title=(Some\("([^"]*)"\)|None)', rest)
                    windows.append({"title": title.group(2) if title and title.group(2) is not None else None, "epoch": int(fields["epoch_ms"]), "raw": rest})
                elif kind == "renderer":
                    seq = int(fields["seq"])
                    renderers[seq] = {k: float(fields[k]) for k in ("device_ms", "lib_ms", "pipelines_ms")}
                    renderers[seq]["window"] = windows[seq] if seq < len(windows) else None
                elif kind == "first_draw_submitted":
                    renderers.setdefault(int(fields["seq"]), {})["submit_ms"] = float(fields["open_to_submit_ms"])
                elif kind == "first_draw_completed":
                    seq = int(fields["seq"])
                    renderers.setdefault(seq, {})["gpu_done_ms"] = float(fields["open_to_gpu_done_ms"])
                    renderers[seq]["gpu_done_epoch"] = int(fields["epoch_ms"])
                    done[seq] = True
        for seq, r in renderers.items():
            w = r.get("window") or {}
            if w.get("title") and "settings" in (w.get("title") or "").lower():
                settings_seq = seq
        if settings_seq is not None and done.get(settings_seq):
            time.sleep(1)
            break
        time.sleep(0.02)
    proc.terminate()
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()
    shutil.rmtree(data, ignore_errors=True)
    if 0 in renderers and "gpu_done_epoch" in renderers[0]:
        renderers[0]["launch_to_first_frame_ms"] = renderers[0]["gpu_done_epoch"] - launch
    return {"renderers": renderers, "settings_seq": settings_seq}


results = []
listing_done = False
for i in range(iterations):
    order = ["runtime", "precompiled"] if i % 2 == 0 else ["precompiled", "runtime"]
    for variant in order:
        wipe()
        cold = run(bins[variant])
        if not listing_done:
            print("metal caches after a cold run:", [str(p) for p in metal_caches()])
            for p in metal_caches():
                for f in list(p.rglob("*"))[:40]:
                    print("  ", f)
            listing_done = True
        warm = run(bins[variant])
        for mode, r in (("cold", cold), ("warm", warm)):
            results.append({"iteration": i, "variant": variant, "mode": mode, **r})
            print(json.dumps({"iteration": i, "variant": variant, "mode": mode, **r}, default=str))
            sys.stdout.flush()

out_path.write_text(json.dumps(results, default=str, indent=1))


def med(values):
    values = [v for v in values if v is not None]
    return (round(statistics.median(values), 2), len(values)) if values else (None, 0)


rows = []
for variant in bins:
    for mode in ("cold", "warm"):
        rs = [r for r in results if r["variant"] == variant and r["mode"] == mode]
        def pick(which, key):
            vals = []
            for r in rs:
                seq = 0 if which == "main" else r["settings_seq"]
                if seq is None:
                    continue
                vals.append(r["renderers"].get(seq, {}).get(key) if seq in r["renderers"] else r["renderers"].get(str(seq), {}).get(key))
            return med(vals)
        rows.append((variant, mode,
                     pick("main", "lib_ms"), pick("main", "pipelines_ms"), pick("main", "gpu_done_ms"), pick("main", "launch_to_first_frame_ms"),
                     pick("settings", "lib_ms"), pick("settings", "pipelines_ms"), pick("settings", "gpu_done_ms")))

summary = ["| variant | metal cache | main lib_ms | main pipelines_ms | main open->first frame ms | launch->main first frame ms | settings lib_ms | settings pipelines_ms | settings open->first frame ms |",
           "|---|---|---|---|---|---|---|---|---|"]
for row in rows:
    summary.append("| " + " | ".join(str(x[0]) + (f" (n={x[1]})" if isinstance(x, tuple) else "") if isinstance(x, tuple) else str(x) for x in row) + " |")
text = "\n".join(summary)
print(text)
with open(os.environ.get("GITHUB_STEP_SUMMARY", "/dev/null"), "a") as f:
    f.write(text + "\n")
