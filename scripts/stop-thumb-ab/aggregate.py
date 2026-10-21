import collections
import statistics
import sys

rows = collections.defaultdict(lambda: collections.defaultdict(list))
sizes = {}
for path in sys.argv[1:]:
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line.startswith("STOPBENCH,"):
            continue
        _, label, rnd, run, name, dims, size, editor, idle, thumb = line.split(",")
        if run == "0":
            continue
        key = (name, dims)
        rows[key][label].append((float(editor), float(idle), float(thumb)))
        sizes[(name, label)] = int(size)

labels = ["main", "head", "main2813", "head2813"]
print("| source | variant | n | editor unblocked ms | stop returns (idle) ms | thumbnail on disk ms | jpeg bytes |")
print("|---|---|---|---|---|---|---|")
for (name, dims), by_label in sorted(rows.items()):
    for label in labels:
        samples = by_label.get(label)
        if not samples:
            continue
        med = [statistics.median(s[i] for s in samples) for i in range(3)]
        print(f"| {name} ({dims}) | {label} | {len(samples)} | {med[0]:.1f} | {med[1]:.1f} | {med[2]:.1f} | {sizes.get((name, label), 0)} |")
