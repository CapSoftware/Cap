"""check.py <run dir> <doc dir> <engine>: what the real app produced, as pass/fail lines plus facts.
Reads the saved document (doc.json, transcript.jsonl, files), the auto-meeting summary, the stub
server's request log and the app log."""
import collections, json, os, re, sys
R, DOC, ENGINE = sys.argv[1], sys.argv[2], sys.argv[3]
TRUTH = json.load(open(os.path.join(sys.argv[4], "truth.json"))) if len(sys.argv) > 4 else {}
truth_tracks = collections.Counter(u["track"] for u in TRUTH.get("utterances", []))
remote_people = len({u["spk"] for u in TRUTH.get("utterances", []) if u["track"] == "system"})
ok_all = True
def check(name, ok, detail=""):
    global ok_all
    ok_all &= bool(ok)
    print(f"{'PASS' if ok else 'FAIL'} {name} {detail}")
def load(p, default=None):
    try: return json.load(open(p))
    except Exception: return default
summary = load(os.path.join(R, "summary.json"), {})
meta = load(os.path.join(DOC, "doc.json"), {}) if DOC else {}
m = meta.get("meeting") or {}
utt, names = {}, {}
tpath = os.path.join(DOC, "transcript.jsonl")
for line in open(tpath) if os.path.exists(tpath) else []:
    try: d = json.loads(line)
    except ValueError: continue
    if d.get("op") == "upsert": utt[d["utterance"]["id"]] = d["utterance"]
    elif d.get("op") == "delete":
        for i in d["ids"]: utt.pop(i, None)
    elif "assign" in d:
        for k, v in d["assign"]:
            if k in utt: utt[k]["speakerId"] = v
    elif d.get("op") == "speakerNames": names = d.get("names") or {}
final = [u for u in utt.values() if u.get("isFinal", True)]
by_src = collections.Counter(u.get("source") for u in final)
words = collections.Counter()
for u in final: words[u.get("source")] += len((u.get("text") or "").split())
voices = collections.defaultdict(set)
for u in final: voices[u.get("source")].add(u.get("speakerId"))
before = (summary.get("beforeStop") or {}).get("active") or {}
log = open(os.path.join(R, "app.log"), errors="replace").read() if os.path.exists(os.path.join(R, "app.log")) else ""
clean = re.sub(r"\x1b\[[0-9;]*m", "", log)
stub = [json.loads(l) for l in open(os.path.join(R, "stub.jsonl"))] if os.path.exists(os.path.join(R, "stub.jsonl")) else []
paths = collections.Counter(e["path"] for e in stub)
score = load(os.path.join(R, "score.json"), {})
print("facts", json.dumps({
    "engine": m.get("engine"), "stopReason": m.get("stopReason"), "durationMs": m.get("durationMs"),
    "audio": [(a.get("file"), a.get("durationMs")) for a in m.get("audio") or []],
    "utterances": dict(by_src), "words": dict(words), "voices": {k: len(v) for k, v in voices.items()},
    "speakerNames": names, "mic": before.get("mic"), "system": before.get("system"),
    "stub": dict(paths), "drainMs": summary.get("drainMs"), "peakRssMB": (summary.get("peakRssBytes") or 0) // 2**20,
    "cpuSeconds": summary.get("cpuSeconds"), "score": score,
}))
check("summary written", bool(summary) and "error" not in summary)
if truth_tracks.get("mic", 0) or not TRUTH:
    check("mic health ok", (before.get("mic") or {}).get("health") == "Ok", (before.get("mic") or {}).get("health"))
check("system health ok", (before.get("system") or {}).get("health") == "Ok", (before.get("system") or {}).get("health"))
check("both audio files saved", len(m.get("audio") or []) >= 2, str([a.get("file") for a in m.get("audio") or []]))
if truth_tracks.get("mic", 0) or not TRUTH:
    check("mic words transcribed", words.get("mic", 0) >= 20, str(words.get("mic", 0)))
check("system words transcribed", words.get("system", 0) >= 20, str(words.get("system", 0)))
if ENGINE == "local":
    if remote_people:
        check("system voices match the remote people", len(voices.get("system", ())) == remote_people, f"{len(voices.get('system', ()))} vs {remote_people}")
    if truth_tracks.get("mic", 0):
        check("user is You", bool(score.get("you_ok")), str(score.get("you_ok")))
    check("after-Stop speaker pass ran", bool(re.search(r"final pass over the meeting|Nemotron", clean)))
    late_ms = (load(os.path.join(R, "offsets.json"), {}) or {}).get("system", 0)
    if late_ms > 15000:
        # The call's audio began too late to be heard in full: not words the app lost.
        check("call page started on time (run invalid: re-run it)", False, f"{late_ms / 1000:.1f} s after the meeting started")
    elif score and "call-ended" not in open(os.path.join(R, "run.txt")).read():
        check("words lost under 10%", score.get("lost_pct", 100) < 10, str(score.get("lost_pct")))
        check("speaker accuracy over 85%", score.get("speaker_acc", 0) >= 85, str(score.get("speaker_acc")))
else:
    check("cloud clips sent", paths.get("/api/desktop/meetings/transcribe", 0) >= 2, str(paths.get("/api/desktop/meetings/transcribe", 0)))
    check("cloud words in transcript", any("cloud" in (u.get("text") or "") for u in final))
if ENGINE == "cloud":
    check("capabilities asked", paths.get("/api/desktop/meetings/capabilities", 0) >= 1)
check("notes requested after Stop", paths.get("/api/desktop/meetings/notes", 0) >= 1)
docfiles = os.listdir(DOC) if DOC and os.path.isdir(DOC) else []
notes_text = ""
for f in docfiles:
    if f.endswith((".json", ".md", ".jsonl")) and f != "transcript.jsonl":
        notes_text += open(os.path.join(DOC, f), errors="replace").read()
check("notes saved in the document", "Check the transcript against the script" in notes_text, str(docfiles))
if os.path.exists(os.path.join(R, "run.txt")) and "asked " in open(os.path.join(R, "run.txt")).read():
    ask = [e for e in stub if e["path"] == "/api/desktop/meetings/ask"]
    want = os.environ.get("CAP_EXPECT_QUESTION")
    asked = [e.get("question") for e in ask]
    check("Ask sent the typed question", (want in asked) if want else any(asked), str(asked))
if os.environ.get("CAP_EXPECT_APP_NAMES") and ENGINE == "local":
    # The call page labels its tiles; the app should name the call's voices after them.
    renamed = sorted(name for _, name in (names.get("renames") or []))
    check("call voices named from the meeting app", renamed == ["Ana Ruiz", "Ben Okafor"], str(renamed))
check("no panics", "panicked" not in clean, str(clean.count("panicked")))
print("ALL_PASS" if ok_all else "SOME_FAILED")
