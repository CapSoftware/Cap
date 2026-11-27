import glob
import json
import sys

for meta in sorted(glob.glob(sys.argv[1] + "/perf-*/recordings/*.cap/recording-meta.json")):
    m = json.load(open(meta))
    status = m.get("status")
    if status is None and isinstance(m.get("studio"), dict):
        status = m["studio"].get("status")
    print(meta.split("/")[-4], sorted(m.keys())[:10], json.dumps(status))
