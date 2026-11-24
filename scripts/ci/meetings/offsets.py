"""offsets.py <run dir> <doc dir>: app time of truth time 0 per track (for score.py)."""
import datetime, json, os, re, sys
R, DOC = sys.argv[1], sys.argv[2]
meta = json.load(open(os.path.join(DOC, "doc.json")))
st = (meta.get("meeting") or {}).get("startedAt")
# Python before 3.11 parses at most six fractional digits; the app writes nine.
st = re.sub(r"(\.\d{6})\d+", r"\1", st.replace("Z", "+00:00"))
st_ms = int(datetime.datetime.fromisoformat(st).timestamp() * 1000)
mic = sys_ = None
for line in open(os.path.join(R, "run.txt")):
    if line.startswith("mic "):
        mic = int(line.split()[1])
p = os.path.join(R, "page_started.log")
if os.path.exists(p):
    for line in open(p):
        if line.startswith("started ") and line.split()[1].isdigit():
            sys_ = int(line.split()[1])
offs = {}
if mic: offs["mic"] = mic - st_ms
if sys_: offs["system"] = sys_ - st_ms
print(json.dumps(offs))
