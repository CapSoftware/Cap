"""score.py <transcript.jsonl> <truth.json> <offsets.json> [window_from_ms window_to_ms] [--until ms]

Scores the app's saved transcript against the meeting's exact truth.
offsets.json: {"mic": ms, "system": ms} = app time of truth time 0 per track (measured by the runner);
each is refined by +-1.5 s search. Per truth utterance, app words of the same track inside its time window
(+-1.2 s) are aligned (LCS) to its words.
  lost   = truth words with no aligned app word (minus nothing: compare with the no-fault baseline run)
  extra  = app words aligned to no truth word; dupes = app 5-grams beyond their count in the truth
  speaker accuracy = share of aligned words whose app voice's majority truth speaker is their speaker
  you_ok = the mic person's majority app voice is the document's user voice
Window: the same numbers restricted to truth utterances starting inside [from, to) (the fault window).
--until: only truth utterances that ended before this truth time count (a meeting stopped by a crash).
Prints one JSON line.
"""
import collections
import difflib
import json
import re
import sys

args = [a for a in sys.argv[1:] if not a.startswith("--")]
until = None
if "--until" in sys.argv:
    until = float(sys.argv[sys.argv.index("--until") + 1])
    args = [a for a in args if a != sys.argv[sys.argv.index("--until") + 1]]
tpath, truthpath, offpath = args[:3]
win = (float(args[3]), float(args[4])) if len(args) >= 5 else None

utt, names = {}, {}
for line in open(tpath):
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except json.JSONDecodeError:
        continue
    if d.get("op") == "upsert":
        utt[d["utterance"]["id"]] = d["utterance"]
    elif d.get("op") == "delete":
        for i in d["ids"]:
            utt.pop(i, None)
    elif "assign" in d:
        for k, v in d["assign"]:
            if k in utt:
                utt[k]["speakerId"] = v
    elif d.get("op") == "speakerNames":
        names = d.get("names") or {}
truth = json.load(open(truthpath))
offs = json.load(open(offpath))


def norm(s):
    return [w for w in re.sub(r"[^a-z0-9' ]", " ", s.lower().replace("-", " ")).split() if w]


app = collections.defaultdict(list)  # track -> [(ms, token, voice, utt_id)]
for u in utt.values():
    if not u.get("isFinal", True):
        continue
    voice = (u["source"], u.get("speakerId"))
    ws = u.get("words") or []
    if ws:
        for w in ws:
            for tok in norm(w["text"]):
                app[u["source"]].append((w["startMs"], tok, voice, u["id"]))
    else:
        toks = norm(u["text"])
        for i, tok in enumerate(toks):
            ms = u["startMs"] + (u["endMs"] - u["startMs"]) * i / max(1, len(toks))
            app[u["source"]].append((ms, tok, voice, u["id"]))
for k in app:
    app[k].sort()
TR = {"mic": "mic", "system": "system"}


def window_words(track, a, b, off):
    xs = app.get(track, [])
    return [x for x in xs if a + off - 1200 <= x[0] <= b + off + 1200]


def align(track, off, utts):
    hits = 0
    for u in utts:
        t = norm(u["text"])
        w = [x[1] for x in window_words(track, u["start_ms"], u["end_ms"], off)]
        hits += sum(b.size for b in difflib.SequenceMatcher(None, t, w, autojunk=False).get_matching_blocks())
    return hits


per_track = collections.defaultdict(list)
for u in truth["utterances"]:
    per_track[u["track"]].append(u)
best = {}
for track, us in per_track.items():
    base = offs.get(track, 0)
    sample = us[:: max(1, len(us) // 40)]
    best[track] = max(range(int(base) - 1500, int(base) + 4001, 100), key=lambda o: align(track, o, sample))

res = {"offsets": best}
used = collections.defaultdict(set)
votes = collections.defaultdict(collections.Counter)  # voice -> truth spk counter (words)
rows = []
for track, us in per_track.items():
    off = best[track]
    for u in us:
        if until is not None and u["end_ms"] > until:
            continue
        t = norm(u["text"])
        cand = [x for x in window_words(track, u["start_ms"], u["end_ms"], off)]
        w = [x[1] for x in cand]
        sm = difflib.SequenceMatcher(None, t, w, autojunk=False)
        matched = []
        for b in sm.get_matching_blocks():
            for k in range(b.size):
                matched.append(cand[b.b + k])
        for x in matched:
            used[track].add((x[0], x[1], x[3]))
            votes[x[2]][u["spk"]] += 1
        rows.append({"track": track, "spk": u["spk"], "start": u["start_ms"], "n": len(t), "hit": len(matched),
                     "voices": collections.Counter(x[2] for x in matched)})
truth_words = sum(r["n"] for r in rows)
hits = sum(r["hit"] for r in rows)
major = {v: c.most_common(1)[0][0] for v, c in votes.items()}
spk_ok = sum(n for r in rows for v, n in r["voices"].items() if major.get(v) == r["spk"])
app_words = sum(1 for tr in app.values() for x in tr if until is None or x[0] <= until + 3000 + max(best.values() or [0]))
extra = app_words - sum(len(s) for s in used.values())


def grams(toks, n=5):
    return collections.Counter(tuple(toks[i : i + n]) for i in range(len(toks) - n + 1))


dupes = 0
for track, us in per_track.items():
    tt = [tok for u in us if until is None or u["end_ms"] <= until for tok in norm(u["text"])]
    at = [x[1] for x in app.get(track, [])]
    tg, ag = grams(tt), grams(at)
    dupes += sum(max(0, c - tg.get(g, 0)) for g, c in ag.items() if c > 1)
voices = [v for v, c in votes.items() if sum(c.values()) >= 5]
truth_spk = {u["spk"] for u in truth["utterances"]}
you_spk = next((s for s in truth_spk if s.startswith("you-")), None)
you_voice = max((v for v in votes if v[0] == "mic"), key=lambda v: votes[v].get(you_spk, 0), default=None)
res.update({
    "truth_words": truth_words, "lost": truth_words - hits, "lost_pct": round(100 * (truth_words - hits) / max(1, truth_words), 2),
    "app_words": app_words, "extra": extra, "dupe_5grams": dupes,
    "speaker_acc": round(100 * spk_ok / max(1, hits), 2), "voices": len(voices), "truth_speakers": len(truth_spk),
    "you_ok": bool(you_voice and names.get("user") == you_voice[1]),
    "voice_map": {f"{v[0]}:{v[1]}": f"{major[v]} {votes[v][major[v]]}/{sum(votes[v].values())}" for v in voices},
})
if win:
    wr = [r for r in rows if win[0] <= r["start"] < win[1]]
    n = sum(r["n"] for r in wr)
    h = sum(r["hit"] for r in wr)
    res["window"] = {"from": win[0], "to": win[1], "truth_words": n, "lost": n - h, "lost_pct": round(100 * (n - h) / max(1, n), 2)}
# where the losses are (minute buckets) to see bursts
lost_by_min = collections.Counter()
for r in rows:
    if r["n"] - r["hit"] > 0:
        lost_by_min[int(r["start"] // 60000)] += r["n"] - r["hit"]
res["lost_by_min"] = dict(sorted(lost_by_min.items()))
print(json.dumps(res))
