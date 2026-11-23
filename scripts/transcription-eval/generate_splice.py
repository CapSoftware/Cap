import argparse
import hashlib
import json
import random
import re
import subprocess
import tempfile
from pathlib import Path

import numpy
import soundfile
import torch
from huggingface_hub import hf_hub_download
from kokoro import KModel, KPipeline

SAMPLE_RATE = 24_000
KOKORO_REPO = "hexgrad/Kokoro-82M"
KOKORO_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
KOKORO_SHA256 = {
    "kokoro-v1_0.pth": "496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4",
    "voices/af_heart.pt": "0ab5709b8ffab19bfd849cd11d98f75b60af7733253ad0d67b12382a102cb4ff",
    "voices/am_michael.pt": "9a443b79a4b22489a5b0ab7c651a0bcd1a30bef675c28333f06971abbd47bd37",
    "voices/af_bella.pt": "8cb64e02fcc8de0327a8e13817e49c76c945ecf0052ceac97d3081480e8e48d6",
    "voices/am_fenrir.pt": "98e507eca1db08230ae3b6232d59c10aec9630022d19accac4f5d12fcec3c37a",
    "voices/bf_emma.pt": "d0a423deabf4a52b4f49318c51742c54e21bb89bbbe9a12141e7758ddb5da701",
    "voices/bm_george.pt": "f1bc812213dc59774769e5c80004b13eeb79bd78130b11b2d7f934542dab811b",
}
HESITATIONS = {"um", "umm", "uh", "uhm", "er", "erm", "ah", "eh", "hm", "hmm", "mm", "mmm"}
ATTRIBUTION = (
    "Synthesised for Cap with Kokoro-82M (https://huggingface.co/hexgrad/Kokoro-82M, Apache-2.0). "
    "Every word is synthesised on its own, trimmed to its audible extent and spliced at a known "
    "sample, so word boundaries are exact."
)

SCRIPTS = [
    "So, um, I think we should, uh, start with the the dashboard.",
    "Okay, so {like} the first thing you'll notice is, um, the sidebar.",
    "Hmm, let me just, uh, open the settings page real quick.",
    "I I wanted to show you how the, um, export works.",
    "{You know}, this part is, er, a little bit slow right now.",
    "We can, uh, we can drag the clip onto the timeline.",
    "Um, so what happens next is the video gets, uh, uploaded.",
    "{I mean}, it's not perfect, but, ah, it works for now.",
    "And then, mm, you click record and it starts counting down.",
    "So the the main reason we built this was, um, speed.",
    "Uh, sorry, let me cha- change the camera first.",
    "It's {like}, really easy to, uh, share a link with your team.",
    "Hmm, okay, so, um, where was I?",
    "The new editor has, er, a lot of, {you know}, small improvements.",
    "First you pick a window, then, uh, you pick the microphone.",
    "I think, I think this is, um, the best way to do it.",
    "Let's, ah, zoom in on this part of the screen.",
    "So, {I mean}, if you look here, um, the numbers went up.",
    "We we added captions, and, uh, they're generated on your device.",
    "Um, um, okay, so that's basically, uh, the whole flow.",
    "The re- the recording keeps going even if, um, you switch apps.",
    "Mm, yeah, that's a good question, {like}, a really good one.",
    "Right, so, er, the audio and the video stay in sync.",
    "You can, um, trim the start and, uh, trim the end.",
    "And, hmm, if something breaks, you just, uh, send us the logs.",
    "Honestly, it's, {like}, ten times faster than before.",
    "So yeah, um, thanks for, uh, watching this quick demo.",
    "Wait, uh, I I need to turn on the, um, the webcam.",
    "Okay, ah, so this is the the part I wanted to show you.",
    "{You know} what, let's, um, just try it live.",
]

VOICES = [
    ("a", "af_heart"),
    ("a", "am_michael"),
    ("a", "af_bella"),
    ("a", "am_fenrir"),
    ("b", "bf_emma"),
    ("b", "bm_george"),
    ("a", "af_nicole"),
    ("a", "am_puck"),
]


def script_words(script):
    words = []
    discourse = None
    for raw in script.split():
        if raw.startswith("{"):
            discourse = re.sub(r"[{}]", "", script[script.index(raw) :].split("}")[0]).lower()
        text = raw.replace("{", "").replace("}", "")
        spoken = re.sub(r"[^\w'-]", "", text).strip("-") or text
        word = {"text": text, "spoken": spoken}
        lower = spoken.lower()
        if lower in HESITATIONS:
            word["filler"] = lower
        elif discourse:
            word["filler"] = discourse
        if text.rstrip(",.?!").endswith("-"):
            word["truncated"] = True
        if "}" in raw:
            discourse = None
        words.append(word)
    return words


def synthesize(model, pipeline, voice, spoken, filler, rng):
    _, tokens = pipeline.g2p(spoken)
    phonemes = pipeline.tokens_to_ps(tokens)
    ids = [0] + [model.vocab[c] for c in phonemes if c in model.vocab] + [0]
    ref_s = pipeline.load_voice(kokoro_file(f"voices/{voice}.pt"))[len(ids) - 3]
    with torch.no_grad():
        input_ids = torch.LongTensor([ids])
        lengths = torch.full((1,), len(ids), dtype=torch.long)
        text_mask = torch.gt(torch.arange(len(ids)).unsqueeze(0) + 1, lengths.unsqueeze(1))
        bert = model.bert(input_ids, attention_mask=(~text_mask).int())
        d_en = model.bert_encoder(bert).transpose(-1, -2)
        s = ref_s[:, 128:]
        d = model.predictor.text_encoder(d_en, s, lengths, text_mask)
        x, _ = model.predictor.lstm(d)
        duration = torch.sigmoid(model.predictor.duration_proj(x)).sum(axis=-1) / (1.0 if filler else 1.4)
        durations = torch.round(duration).clamp(min=1).long().squeeze().tolist()
        if filler:
            inner = list(range(1, len(ids) - 1))
            target = rng.uniform(0.28, 0.7) * 40
            scale = max(1.0, target / max(1, sum(durations[i] for i in inner)))
            for i in inner:
                durations[i] = max(1, round(durations[i] * scale))
        pred_dur = torch.LongTensor(durations)
        indices = torch.repeat_interleave(torch.arange(len(ids)), pred_dur)
        alignment = torch.zeros((len(ids), indices.shape[0]))
        alignment[indices, torch.arange(indices.shape[0])] = 1
        alignment = alignment.unsqueeze(0)
        en = d.transpose(-1, -2) @ alignment
        f0, n = model.predictor.F0Ntrain(en, s)
        t_en = model.text_encoder(input_ids, lengths, text_mask)
        audio = model.decoder(t_en @ alignment, f0, n, ref_s[:, :128]).squeeze().numpy()
    return audio.astype(numpy.float64)


def trim(audio):
    hop = SAMPLE_RATE // 400
    frames = len(audio) // hop
    energy = numpy.array([numpy.sqrt(numpy.mean(audio[i * hop : (i + 1) * hop] ** 2)) + 1e-12 for i in range(frames)])
    level = 20 * numpy.log10(energy)
    loud = numpy.nonzero(level > level.max() - 45)[0]
    piece = audio[loud[0] * hop : (loud[-1] + 1) * hop].copy()
    fade = min(len(piece) // 4, SAMPLE_RATE // 500)
    ramp = 0.5 - 0.5 * numpy.cos(numpy.linspace(0, numpy.pi, fade))
    piece[:fade] *= ramp
    piece[-fade:] *= ramp[::-1]
    return piece


def gap(rng, around_filler):
    roll = rng.random()
    if around_filler:
        return 0.0 if roll < 0.25 else rng.uniform(0.03, 0.45)
    if roll < 0.35:
        return 0.0
    if roll < 0.7:
        return rng.uniform(0.015, 0.08)
    if roll < 0.9:
        return rng.uniform(0.1, 0.3)
    return rng.uniform(0.3, 0.7)


def kokoro_file(name):
    path = hf_hub_download(KOKORO_REPO, name, revision=KOKORO_REVISION)
    expected = KOKORO_SHA256.get(name)
    if expected is not None:
        digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
        if digest != expected:
            raise SystemExit(f"{name}: sha256 {digest}, expected {expected}")
    return path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--voices-per-script", type=int, default=2)
    parser.add_argument("--seed", type=int, default=11)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    noise = numpy.random.default_rng(args.seed)
    torch.manual_seed(args.seed)
    model = KModel(
        repo_id=KOKORO_REPO, config=kokoro_file("config.json"), model=kokoro_file("kokoro-v1_0.pth")
    ).eval()
    pipelines = {code: KPipeline(lang_code=code, repo_id=KOKORO_REPO, model=False) for code in ("a", "b")}
    args.out.mkdir(parents=True, exist_ok=True)
    manifest = {"name": "splice", "attribution": ATTRIBUTION, "timing": "exact", "clips": []}
    for script_index, script in enumerate(SCRIPTS):
        words = script_words(script)
        for slot in range(args.voices_per_script):
            code, voice = VOICES[(script_index * args.voices_per_script + slot) % len(VOICES)]
            pieces = []
            cursor = rng.uniform(0.3, 0.8)
            placed = []
            for index, word in enumerate(words):
                if index:
                    around = "filler" in word and word["filler"] in HESITATIONS or (
                        "filler" in words[index - 1] and words[index - 1]["filler"] in HESITATIONS
                    )
                    cursor += gap(rng, around)
                piece = trim(synthesize(model, pipelines[code], voice, word["spoken"], word.get("filler") in HESITATIONS, rng))
                start = round(cursor * SAMPLE_RATE)
                pieces.append((start, piece))
                end = start + len(piece)
                placed.append(
                    {
                        "text": word["text"],
                        "start": round(start / SAMPLE_RATE, 5),
                        "end": round(end / SAMPLE_RATE, 5),
                        **{k: word[k] for k in ("filler", "truncated") if k in word},
                    }
                )
                cursor = end / SAMPLE_RATE
            total = round((cursor + rng.uniform(0.3, 0.8)) * SAMPLE_RATE)
            mix = numpy.zeros(total)
            for start, piece in pieces:
                mix[start : start + len(piece)] += piece
            speech_rms = numpy.sqrt(numpy.mean(numpy.concatenate([p for _, p in pieces]) ** 2))
            mix += noise.normal(0, speech_rms * 10 ** (-rng.uniform(30, 50) / 20), total)
            mix *= 0.5 / max(1e-9, numpy.abs(mix).max())
            clip_id = f"splice-{script_index:02d}-{voice}"
            with tempfile.TemporaryDirectory() as scratch:
                raw = Path(scratch) / "raw.wav"
                soundfile.write(raw, mix, SAMPLE_RATE, subtype="FLOAT")
                subprocess.run(
                    [
                        "ffmpeg", "-loglevel", "error", "-y", "-i", str(raw),
                        "-af", "aresample=16000:filter_size=64",
                        "-ac", "1", "-c:a", "pcm_s16le", str(args.out / f"{clip_id}.wav"),
                    ],
                    check=True,
                )
            manifest["clips"].append(
                {
                    "id": clip_id,
                    "audio": f"{clip_id}.wav",
                    "duration": round(total / SAMPLE_RATE, 3),
                    "source": f"Kokoro-82M voice {voice}",
                    "words": placed,
                }
            )
            print(clip_id, " ".join(w["text"] for w in placed))
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=1))


if __name__ == "__main__":
    main()
