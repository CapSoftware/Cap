import argparse
import json
import random
import struct
import sys
import time
import urllib.error
import urllib.request
import wave
import xml.etree.ElementTree as ET
from pathlib import Path

AUDIO_URL = "https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/{meeting}/audio/{meeting}.Headset-{channel}.wav"
NITE = "{http://nite.sourceforge.net/}"
SKIP_MEETINGS = {"TS3009c", "EN2002a", "EN2002c", "EN2003a"}
HESITATIONS = {"um", "umm", "uh", "uhm", "er", "erm", "ah", "eh", "hm", "hmm", "mm", "mmm"}
ATTRIBUTION = (
    "AMI Meeting Corpus (https://groups.inf.ed.ac.uk/ami/corpus/), "
    "Carletta et al. 2005, licensed CC BY 4.0. Clips cut from the individual headset "
    "channels and resampled; word times from the corpus forced alignment."
)


def speakers(ann: Path):
    root = ET.parse(ann / "corpusResources" / "meetings.xml").getroot()
    for meeting in root.iter("meeting"):
        observation = meeting.get("observation")
        if observation in SKIP_MEETINGS or meeting.get("type") != "scenario":
            continue
        for speaker in meeting.iter("speaker"):
            yield observation, speaker.get("nxt_agent"), int(speaker.get("channel"))


def words(ann: Path, meeting: str, agent: str):
    path = ann / "words" / f"{meeting}.{agent}.words.xml"
    if not path.exists():
        return []
    out = []
    for element in ET.parse(path).getroot():
        tag = element.tag
        start = element.get("starttime")
        end = element.get("endtime")
        if tag == "w" and element.get("punc") != "true":
            out.append(
                {
                    "kind": "word",
                    "text": (element.text or "").strip(),
                    "start": float(start) if start else None,
                    "end": float(end) if end else None,
                    "trunc": element.get("trunc") == "true",
                }
            )
        elif tag in ("gap", "vocalsound", "disfmarker"):
            out.append(
                {
                    "kind": tag,
                    "type": element.get("type"),
                    "start": float(start) if start else None,
                    "end": float(end) if end else None,
                }
            )
    return out


def candidate_clips(own, others, max_len, min_words, min_pause):
    spoken = [w for w in own if w["kind"] == "word"]
    clips = []
    i = 0
    while i < len(spoken):
        first = spoken[i]
        previous_end = spoken[i - 1]["end"] if i > 0 else None
        if first["start"] is None or (
            previous_end is not None and first["start"] - previous_end < min_pause
        ):
            i += 1
            continue
        best = None
        j = i
        while j < len(spoken) and spoken[j]["start"] is not None:
            if spoken[j]["end"] is None or spoken[j]["end"] - first["start"] > max_len:
                break
            following = spoken[j + 1]["start"] if j + 1 < len(spoken) else None
            if j - i + 1 >= min_words and (
                following is None or following - spoken[j]["end"] >= min_pause
            ):
                best = j
            j += 1
        if best is None:
            i += 1
            continue
        start = first["start"] - min(0.25, (first["start"] - previous_end) / 2 if previous_end else 0.25)
        following = spoken[best + 1]["start"] if best + 1 < len(spoken) else None
        end = spoken[best]["end"] + min(0.25, (following - spoken[best]["end"]) / 2 if following else 0.25)
        inside = [w for w in own if w["start"] is not None and w["start"] < end and (w["end"] or w["start"]) > start]
        clean = all(w["kind"] != "gap" for w in inside) and all(
            w["kind"] != "word" or (w["start"] is not None and w["end"] is not None) for w in inside
        )
        overlap = any(
            w["kind"] == "word" and w["start"] is not None and w["end"] is not None and w["start"] < end and w["end"] > start
            for w in others
        )
        if clean and not overlap:
            clips.append((start, end, [w for w in inside if w["kind"] == "word"]))
            i = best + 1
        else:
            i += 1
    return clips


def get(url, byte_range):
    for attempt in range(6):
        try:
            request = urllib.request.Request(url, headers={"Range": f"bytes={byte_range}"})
            return urllib.request.urlopen(request, timeout=60).read()
        except urllib.error.HTTPError as error:
            if error.code not in (403, 429, 503) or attempt == 5:
                raise
            time.sleep(15 * (attempt + 1))
    raise RuntimeError("unreachable")


def fetch_pcm(meeting, channel, start, end):
    url = AUDIO_URL.format(meeting=meeting, channel=channel)
    head = get(url, "0-4095")
    if head[:4] != b"RIFF" or head[8:12] != b"WAVE":
        raise ValueError(f"{url} is not a WAV file")
    offset = 12
    rate = channels = bits = None
    while offset + 8 <= len(head):
        chunk, size = head[offset : offset + 4], struct.unpack("<I", head[offset + 4 : offset + 8])[0]
        if chunk == b"fmt ":
            _, channels, rate, _, _, bits = struct.unpack("<HHIIHH", head[offset + 8 : offset + 24])
        if chunk == b"data":
            data_offset = offset + 8
            break
        offset += 8 + size
    else:
        raise ValueError(f"{url} has no data chunk in its first 4 KiB")
    if (channels, bits) != (1, 16):
        raise ValueError(f"{url} is {channels} channels at {bits} bits")
    frame = 2
    first = data_offset + int(start * rate) * frame
    last = data_offset + int(end * rate) * frame - 1
    pcm = get(url, f"{first}-{last}")
    return rate, pcm


def label(text):
    lower = text.lower().strip("-")
    if lower in HESITATIONS:
        return lower
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--annotations", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--minutes", type=float, default=25.0)
    parser.add_argument("--max-clip", type=float, default=30.0)
    parser.add_argument("--per-speaker", type=int, default=2)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    pool = []
    by_meeting = {}
    for meeting, agent, channel in speakers(args.annotations):
        by_meeting.setdefault(meeting, []).append((agent, channel))
    for meeting, agents in sorted(by_meeting.items()):
        all_words = {agent: words(args.annotations, meeting, agent) for agent, _ in agents}
        for agent, channel in agents:
            others = [w for other, ws in all_words.items() if other != agent for w in ws]
            clips = candidate_clips(all_words[agent], others, args.max_clip, 12, 0.35)
            scored = []
            for start, end, clip_words in clips:
                fillers = sum(1 for w in clip_words if label(w["text"]))
                if fillers:
                    scored.append((fillers / max(1.0, end - start), start, end, clip_words))
            scored.sort(key=lambda item: -item[0])
            for _, start, end, clip_words in scored[: args.per_speaker]:
                pool.append((meeting, agent, channel, start, end, clip_words))

    rng.shuffle(pool)
    args.out.mkdir(parents=True, exist_ok=True)
    manifest = {"name": "ami", "attribution": ATTRIBUTION, "timing": "none", "clips": []}
    total = 0.0
    for meeting, agent, channel, start, end, clip_words in pool:
        if total >= args.minutes * 60:
            break
        clip_id = f"{meeting}-{agent}-{int(start * 100):07d}"
        target = args.out / f"{clip_id}.wav"
        if not target.exists():
            try:
                rate, pcm = fetch_pcm(meeting, channel, start, end)
            except Exception as error:
                print(f"skip {clip_id}: {error}", file=sys.stderr)
                continue
            with wave.open(str(target), "wb") as out:
                out.setnchannels(1)
                out.setsampwidth(2)
                out.setframerate(rate)
                out.writeframes(pcm)
            time.sleep(1)
        manifest["clips"].append(
            {
                "id": clip_id,
                "audio": f"{clip_id}.wav",
                "duration": round(end - start, 3),
                "source": f"{meeting} headset {channel} speaker {agent} {start:.2f}-{end:.2f}s",
                "words": [
                    {
                        "text": w["text"],
                        "start": round(w["start"] - start, 3),
                        "end": round(w["end"] - start, 3),
                        **({"filler": label(w["text"])} if label(w["text"]) else {}),
                        **({"truncated": True} if w["trunc"] else {}),
                    }
                    for w in clip_words
                ],
            }
        )
        total += end - start
        print(f"{clip_id} {end - start:.1f}s total {total / 60:.1f} min", file=sys.stderr)
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=1))


if __name__ == "__main__":
    main()
