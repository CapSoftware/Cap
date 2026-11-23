import argparse
import hashlib
import io
import json
import random
import re
import subprocess
import tarfile
import urllib.request
import zipfile
from pathlib import Path

ALIGNMENTS_URL = "https://zenodo.org/records/2619474/files/librispeech_alignments.zip"
ALIGNMENTS_BYTES = 623_023_332
AUDIO_URL = "https://www.openslr.org/resources/12/test-clean.tar.gz"
AUDIO_SHA256 = "39fde525e59672dc6d1551919b1478f724438a95aa55f874b576be21967e6c23"
ATTRIBUTION = (
    "LibriSpeech test-clean (Panayotov et al. 2015, https://www.openslr.org/12, CC BY 4.0) with "
    "Montreal Forced Aligner word alignments by Loren Lugosch (https://zenodo.org/records/2619474, "
    "CC BY 4.0). Word times are a forced-alignment reference at 10 ms resolution, not hand labels."
)


class RangeReader(io.RawIOBase):
    def __init__(self, url):
        self.url = url
        self.position = 0
        head = urllib.request.urlopen(urllib.request.Request(url, method="HEAD"))
        self.size = int(head.headers["Content-Length"])

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        base = {0: 0, 1: self.position, 2: self.size}[whence]
        self.position = base + offset
        return self.position

    def readinto(self, buffer):
        if self.position >= self.size:
            return 0
        last = min(self.size, self.position + len(buffer)) - 1
        request = urllib.request.Request(self.url, headers={"Range": f"bytes={self.position}-{last}"})
        data = urllib.request.urlopen(request, timeout=120).read()
        buffer[: len(data)] = data
        self.position += len(data)
        return len(data)


def words_tier(textgrid):
    tier = textgrid.split('name = "words"', 1)[1].split("item [", 1)[0]
    out = []
    for xmin, xmax, text in re.findall(r'xmin = ([\d.]+)\s+xmax = ([\d.]+)\s+text = "([^"]*)"', tier):
        if text.strip():
            out.append({"text": text, "start": float(xmin), "end": float(xmax)})
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--scratch", required=True, type=Path)
    parser.add_argument("--per-speaker", type=int, default=1)
    parser.add_argument("--min-seconds", type=float, default=8.0)
    parser.add_argument("--max-seconds", type=float, default=22.0)
    parser.add_argument("--seed", type=int, default=5)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    alignments = RangeReader(ALIGNMENTS_URL)
    if alignments.size != ALIGNMENTS_BYTES:
        raise SystemExit(f"{ALIGNMENTS_URL}: {alignments.size} bytes, expected {ALIGNMENTS_BYTES}")
    archive = zipfile.ZipFile(io.BufferedReader(alignments, buffer_size=1 << 16))
    grids = {}
    for name in archive.namelist():
        if name.startswith("test-clean/") and name.endswith(".TextGrid"):
            utterance = Path(name).stem
            grids.setdefault(utterance.split("-")[0], []).append(name)

    chosen = []
    for speaker in sorted(grids):
        names = sorted(grids[speaker])
        rng.shuffle(names)
        taken = 0
        for name in names:
            words = words_tier(archive.read(name).decode())
            if not words:
                continue
            length = words[-1]["end"] + 0.3
            if args.min_seconds <= length <= args.max_seconds:
                chosen.append((Path(name).stem, words))
                taken += 1
            if taken >= args.per_speaker:
                break

    args.scratch.mkdir(parents=True, exist_ok=True)
    tarball = args.scratch / "test-clean.tar.gz"
    if not tarball.exists():
        urllib.request.urlretrieve(AUDIO_URL, tarball)
    digest = hashlib.sha256()
    with open(tarball, "rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    if digest.hexdigest() != AUDIO_SHA256:
        tarball.unlink()
        raise SystemExit(f"{AUDIO_URL}: sha256 {digest.hexdigest()}, expected {AUDIO_SHA256}")
    wanted = {f"{u}.flac": u for u, _ in chosen}
    flacs = {}
    with tarfile.open(tarball) as tar:
        for member in tar:
            base = Path(member.name).name
            if base in wanted:
                tar.extract(member, args.scratch, filter="data")
                flacs[wanted[base]] = args.scratch / member.name

    args.out.mkdir(parents=True, exist_ok=True)
    manifest = {"name": "libri", "attribution": ATTRIBUTION, "timing": "aligned", "clips": []}
    for utterance, words in chosen:
        if utterance not in flacs:
            continue
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-i", str(flacs[utterance]), "-ac", "1", "-ar", "16000",
             "-c:a", "pcm_s16le", str(args.out / f"{utterance}.wav")],
            check=True,
        )
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(args.out / f"{utterance}.wav")],
            check=True, capture_output=True, text=True,
        )
        manifest["clips"].append(
            {
                "id": utterance,
                "audio": f"{utterance}.wav",
                "duration": round(float(probe.stdout.strip()), 3),
                "source": f"LibriSpeech test-clean {utterance}",
                "words": words,
            }
        )
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(len(manifest["clips"]), "clips", round(sum(c["duration"] for c in manifest["clips"]) / 60, 1), "min")


if __name__ == "__main__":
    main()
