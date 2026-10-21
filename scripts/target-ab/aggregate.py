import collections, statistics, sys

rows = collections.defaultdict(lambda: collections.defaultdict(list))
for line in open(sys.argv[1]):
    kv = dict(part.split("=", 1) for part in line.split() if "=" in part)
    key = (kv["scenario"], kv["variant"])
    secs = float(kv["secs"])
    try:
        rows[key]["cpu"].append(float(kv["cpu"]))
    except ValueError:
        pass
    rows[key]["renders_per_min"].append(float(kv["renders"]) * 60 / secs)
    rows[key]["display_captures"].append(float(kv["dcap"]))
    rows[key]["window_captures"].append(float(kv["wcap"]))
    d = float(kv["dcap"])
    if d:
        rows[key]["display_capture_ms"].append(float(kv["dcap_us"]) / d / 1000)
print("| Scenario | Variant | Runs | CPU % median (all) | Main window renders/min median | Display captures/min | Display capture ms (median of means) | Window captures/min |")
print("|---|---|---|---|---|---|---|---|")
for (scenario, variant), m in sorted(rows.items()):
    med = lambda k: f"{statistics.median(m[k]):.2f}" if m[k] else "n/a"
    print(f"| {scenario} | {variant} | {len(m['renders_per_min'])} | {med('cpu')} ({', '.join(f'{v:.2f}' for v in m['cpu'])}) | {med('renders_per_min')} | {med('display_captures')} | {med('display_capture_ms')} | {med('window_captures')} |")
