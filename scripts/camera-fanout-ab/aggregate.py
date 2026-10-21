import statistics
import sys
from collections import defaultdict

rows = defaultdict(list)
for line in open(sys.argv[1]):
    if not line.startswith("RESULT "):
        continue
    fields = dict(part.split("=", 1) for part in line.split()[1:])
    rows[(fields["res"], int(fields["senders"]), fields["variant"])].append(fields)

metrics = [
    ("fanout_p50_us", "fan-out p50 us"),
    ("fanout_p95_us", "fan-out p95 us"),
    ("cpu_us_per_frame", "CPU us/frame"),
    ("minflt_per_frame", "page faults/frame"),
    ("copied_mb_per_frame", "MB copied/frame"),
    ("maxrss_mb", "max RSS MB"),
]

print("### Camera fan-out A/B (median of rounds)")
print()
print("| res | senders | metric | main | fix | change |")
print("|---|---|---|---|---|---|")
for res, senders in sorted({(k[0], k[1]) for k in rows}, key=lambda k: (int(k[0].split("x")[0]), k[1])):
    main = rows.get((res, senders, "main"), [])
    fix = rows.get((res, senders, "fix"), [])
    if not main or not fix:
        continue
    for key, label in metrics:
        a = statistics.median(float(r[key]) for r in main)
        b = statistics.median(float(r[key]) for r in fix)
        change = f"{(b - a) / a * 100:+.0f}%" if a else "n/a"
        print(f"| {res} | {senders} | {label} | {a:.2f} | {b:.2f} | {change} |")
    rounds = len(fix)
    copied = sum(int(r["copied_receipts"]) for r in fix)
    shared = sum(int(r["shared_receipts"]) for r in fix)
    print(f"| {res} | {senders} | fix receipts copied/shared ({rounds} rounds) | | {copied}/{shared} | |")
