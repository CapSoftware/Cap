import statistics
import sys
from collections import defaultdict

rows = defaultdict(list)
for line in open(sys.argv[1]):
    if "RESULT " not in line:
        continue
    line = line[line.index("RESULT "):]
    fields = dict(part.split("=", 1) for part in line.split()[1:])
    if fields["mode"] != "cpu":
        continue
    key = (fields["res"], fields["preview"], fields["encode"], fields["variant"])
    rows[key].append(fields)

metrics = [
    ("decodes_per_frame", "MJPEG decodes/frame"),
    ("cpu_us_per_frame", "CPU us/frame"),
    ("wall_us_per_frame", "wall us/frame"),
    ("convert_p50_us", "encoder convert p50 us"),
    ("convert_p95_us", "encoder convert p95 us"),
    ("callback_p50_us", "capture callback p50 us"),
    ("callback_p95_us", "capture callback p95 us"),
    ("preview_ready_p50_us", "preview ready p50 us"),
    ("preview_ready_p95_us", "preview ready p95 us"),
]

print("### Windows MJPEG camera A/B (median of rounds)")
print()
print("| res | preview | h264 | metric | main | fix | change |")
print("|---|---|---|---|---|---|---|")
groups = sorted(
    {k[:3] for k in rows},
    key=lambda k: (int(k[0].split("x")[0]), -int(k[1]), k[2]),
)
for res, preview, encode in groups:
    main = rows.get((res, preview, encode, "main"), [])
    fix = rows.get((res, preview, encode, "fix"), [])
    if not main or not fix:
        continue
    for key, label in metrics:
        if key.startswith("preview_ready") and preview == "0":
            continue
        a = statistics.median(float(r[key]) for r in main)
        b = statistics.median(float(r[key]) for r in fix)
        change = f"{(b - a) / a * 100:+.0f}%" if a else "n/a"
        print(
            f"| {res} | {'on' if preview == '1' else 'off'} | {'yes' if encode == '1' else 'no'} | {label} | {a:.2f} | {b:.2f} | {change} |"
        )
    print(
        f"| {res} | {'on' if preview == '1' else 'off'} | {'yes' if encode == '1' else 'no'} | rounds, MJPEG KB/frame | {len(main)} | {len(fix)}, {fix[0]['mjpeg_kb']} | |"
    )
