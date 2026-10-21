import collections, statistics, sys

rows = collections.defaultdict(lambda: collections.defaultdict(list))
for line in open(sys.argv[1]):
    kv = dict(part.split("=", 1) for part in line.split() if "=" in part)
    key = (kv["profile"], kv["variant"])
    for metric in ("cpu", "main_renders_per_s", "gpu_draws_per_s"):
        try:
            rows[key][metric].append(float(kv.get(metric, "")))
        except ValueError:
            pass
print("| Profile | Variant | Runs | CPU % (median) | CPU % (all) | Main window renders/s (median) | GPU draws/s (median) |")
print("|---|---|---|---|---|---|---|")
for (profile, variant), m in sorted(rows.items()):
    med = lambda k: f"{statistics.median(m[k]):.2f}" if m[k] else "n/a"
    print(f"| {profile} | {variant} | {len(m['cpu'])} | {med('cpu')} | {', '.join(f'{v:.2f}' for v in m['cpu'])} | {med('main_renders_per_s')} | {med('gpu_draws_per_s')} |")
