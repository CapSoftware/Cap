import collections, statistics, sys

rows = collections.defaultdict(lambda: collections.defaultdict(list))
for line in open(sys.argv[1]):
    kv = dict(part.split("=", 1) for part in line.split() if "=" in part)
    for metric in ("cpu", "loading_paints_per_s", "gpu_draws_per_s"):
        try:
            rows[kv["variant"]][metric].append(float(kv.get(metric, "")))
        except ValueError:
            pass
print("| Variant | Runs | Process CPU % (median) | CPU % (all) | Loading paints/s (median) | GPU draws/s (median) |")
print("|---|---|---|---|---|---|")
for variant, m in sorted(rows.items()):
    med = lambda k: f"{statistics.median(m[k]):.2f}" if m[k] else "n/a"
    print(f"| {variant} | {len(m['cpu'])} | {med('cpu')} | {', '.join(f'{v:.2f}' for v in m['cpu'])} | {med('loading_paints_per_s')} | {med('gpu_draws_per_s')} |")
