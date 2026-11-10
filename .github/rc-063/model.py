"""Item 6 (PR 3908): the Recommended transcription model in the real app.

old:   a Recommended model folder in the old layout is present. The editor's
       Captions tab shows the update note and offers the download, the
       download is started with a real click and completes, and Generate
       transcribes a recording of a committed fixture clip.
fresh: no model folder. No update note, the download is offered, completes,
       and Generate transcribes the same clip.
full:  High Accuracy is selected and installed, and Generate transcribes it.

Usage: model.py <package> <out-dir> <case> <clip.wav> <expected words>
Environment: RC_OLD_MODEL (old layout files), RC_FULL_MODEL (High Accuracy
files), RC_PROJECT_DIR (where the recording of the clip is kept)."""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time

import rclib
from rclib import App, Results, log

package, out, case, clip, expected_text = sys.argv[1], os.path.abspath(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]
results = Results(out, f"Item 6: Recommended transcription model (PR 3908), {case}, {sys.platform}")
ENCODER_BYTES = 895_802_223
ENCODER_SHA256 = "ba57741cd5100b1a991ba96610b0e38e448c0f52c21f6ef649fd44d36c5729cb"
NEW_FILES = ("encoder-model.onnx", "decoder_joint-model.int8.onnx", "vocab.txt")
WINDOW = "rc063 window"

if rclib.WINDOWS:
    data_home = None
    models = os.path.join(os.environ["LOCALAPPDATA"], "so.cap.desktop", "transcription_models")
else:
    data_home = os.path.join(out, "data-home")
    models = os.path.join(data_home, "so.cap.desktop", "transcription_models")
extra_env = {"XDG_DATA_HOME": data_home} if data_home else {}
project_home = os.environ.get("RC_PROJECT_DIR") or os.path.join(out, "clip-rec")


def words_of(text):
    return re.findall(r"[a-z']+", text.lower().replace("-", " "))


def word_error_rate(expected, heard):
    rows = list(range(len(heard) + 1))
    for i, want in enumerate(expected, 1):
        previous, rows[0] = rows[0], i
        for j, got in enumerate(heard, 1):
            previous, rows[j] = rows[j], min(rows[j] + 1, rows[j - 1] + 1, previous + (want != got))
    return rows[-1] / max(len(expected), 1)


def record_clip():
    """A Studio recording made by the app while the clip plays on the default
    output, captured as system audio (and on Linux through the monitor source
    acting as the microphone)."""
    existing = rclib.find_projects(project_home)
    if existing:
        return existing[0]
    os.makedirs(project_home, exist_ok=True)
    profile = rclib.make_profile(os.path.join(out, "record-profile"))
    # The clip reaches the app as the microphone only, the shape of the
    # recordings PR 3908 is about: through a second null sink on Linux, and
    # through the virtual cable's capture end on Windows.
    env = {"CAP_GPUI_AUTO_RECORD": "studio:14", "CAP_GPUI_AUTO_NO_MIC": "0"}
    helper = None
    if rclib.LINUX:
        helper = subprocess.Popen(["xmessage", "-geometry", "640x360+200+200", "-title", WINDOW, "A window to record"])
        time.sleep(1)
        env.update({"CAP_GPUI_AUTO_OVERLAY": "window", "CAP_GPUI_AUTO_WINDOW": WINDOW, "CAP_GPUI_AUTO_SYSTEM_AUDIO": "1"})
    app = App(package, profile, project_home, {**env, **extra_env}, "record")
    started = app.wait_log(r"recording started", 120)
    results.add("the recording of the clip started", bool(started), app.text()[-2000:] if not started else "")
    if started:
        time.sleep(2.5)
        if rclib.WINDOWS:
            import winsound

            try:
                winsound.PlaySound(clip, winsound.SND_FILENAME | winsound.SND_ASYNC)
            except RuntimeError as error:
                results.note("clip playback", f"could not play: {error}")
        else:
            subprocess.Popen(["paplay", "--device=cap_micsink", clip])
    finished = app.wait_log(r"recording finished", 120) if started else None
    time.sleep(3)
    app.stop()
    if helper:
        helper.kill()
    results.add("the recording of the clip finished", bool(finished), app.text()[-2000:] if started and not finished else "")
    projects = rclib.find_projects(project_home)
    if projects:
        listing = rclib.tree(projects[0])
        with open(os.path.join(out, "clip-project.tree.txt"), "w", encoding="utf-8") as handle:
            handle.write(listing + "\n")
        has_audio = re.search(r"system_audio\.|audio-input\.", listing) is not None
        results.add("the recording has an audio track", has_audio, "" if has_audio else listing[-600:])
    return projects[0] if projects else None


def project_copy(project, name):
    target = os.path.join(out, f"{name}-rec", os.path.basename(project))
    if os.path.exists(target):
        shutil.rmtree(target)
    shutil.copytree(project, target)
    return target


def model_state(folder="parakeet-best"):
    directory = os.path.join(models, folder)
    if not os.path.isdir(directory):
        return {}
    return {name: os.path.getsize(os.path.join(directory, name)) for name in sorted(os.listdir(directory))}


def look(app, name):
    path = rclib.screenshot(os.path.join(out, f"{name}.png"))
    words = rclib.ocr_both(path)
    with open(os.path.join(out, f"{name}.ocr.txt"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(f"{word['x']},{word['y']},{word['w']},{word['h']} {word['text']}" for word in words))
    return words


def click_phrase(words, phrase):
    box = rclib.find_phrase(words, phrase)
    if box:
        rclib.click(*rclib.center(box))
    return box


def saved_captions(project):
    try:
        with open(os.path.join(project, "project-config.json"), encoding="utf-8") as handle:
            config = json.load(handle)
    except (OSError, ValueError):
        return []
    segments = (config.get("captions") or {}).get("segments") or []
    return [segment.get("text", "") for segment in segments]


def download_through_the_editor(project, expect_note):
    """Opens the editor on the Captions tab, checks what it offers, clicks
    Download and waits for the model. Then clicks Generate Captions."""
    profile = rclib.make_profile(os.path.join(out, "editor-profile"))
    before = model_state()
    results.note("model folder before", json.dumps(before) if before else "absent")
    app = App(
        package,
        profile,
        os.path.dirname(project),
        {"CAP_GPUI_AUTO_EDITOR": project, "CAP_GPUI_AUTO_SIDEBAR": "captions", **extra_env},
        "editor",
    )
    app.wait_log(r"auto sidebar tab|editor waveforms ready", 120)
    time.sleep(8)
    words = look(app, "1-captions-tab")
    note = rclib.find_phrase(words, "Recommended model updated")
    wanted = os.environ.get("RC_NOTE_DESCRIPTION", "").strip()
    description = ""
    if note:
        below = (note["x"] - 8, note["y"] + note["h"] + 4, note["x"] + 400, note["y"] + note["h"] + 56)
        description = rclib.ocr_block(os.path.join(out, "1-captions-tab.png"), below)
    if expect_note:
        results.add(
            "the editor shows the update note",
            bool(note) and bool(wanted) and words_of(description) == words_of(wanted),
            f"title \"Recommended model updated\" at {note}; under it \"{description}\"; the PR head's copy is \"{wanted}\"",
        )
    else:
        results.add("a fresh install shows no update note", not note and not description, f"note {note}, description {description}")
    button = click_phrase(words, "Download Recommended Model")
    results.add("the editor offers the download", bool(button), f"button at {button}" if button else rclib.ocr_text(words)[-600:])
    installed = False
    if button:
        deadline = time.time() + 1500
        last = 0
        shots = 0
        while time.time() < deadline and app.alive():
            state = model_state()
            if (
                state.get("encoder-model.onnx") == ENCODER_BYTES
                and all(name in state for name in NEW_FILES)
                and "encoder-model.int8.onnx" not in state
                and not any(name.endswith((".part", ".tmp", ".download")) for name in state)
            ):
                installed = True
                break
            if time.time() - last > 20:
                last = time.time()
                log(f"model folder: {state}")
                if shots < 2:
                    look(app, f"2-downloading-{shots}")
                    shots += 1
            time.sleep(2)
        time.sleep(4)
    state = model_state()
    results.add("the download completed", installed, json.dumps(state))
    if installed:
        digest = hashlib.sha256()
        with open(os.path.join(models, "parakeet-best", "encoder-model.onnx"), "rb") as handle:
            for block in iter(lambda: handle.read(1 << 22), b""):
                digest.update(block)
        results.add(
            "the downloaded encoder is the published file",
            digest.hexdigest() == ENCODER_SHA256,
            f"{state.get('encoder-model.onnx')} bytes, sha256 {digest.hexdigest()}",
        )
        if expect_note:
            results.add(
                "the old encoder was replaced",
                "encoder-model.int8.onnx" not in state,
                json.dumps(state),
            )
        words = look(app, "3-after-download")
        note = rclib.find_phrase(words, "Recommended model updated")
        results.add("no update note once the model is current", not note, f"note {note}")
        generate = click_phrase(words, "Generate Captions")
        results.note("Generate Captions button", f"clicked at {generate}" if generate else "not found on screen")
        if generate:
            deadline = time.time() + 600
            while time.time() < deadline and app.alive() and not saved_captions(project):
                time.sleep(2)
            time.sleep(4)
            look(app, "4-after-generate")
            heard = " ".join(saved_captions(project))
            check_transcript("Generate Captions in the editor", heard)
    lines = rclib.grep(app.text(), r"parakeet|caption|transcri|model|download|panicked")
    with open(os.path.join(out, "editor.model.log"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    results.add("the editor stayed up", app.alive() and "panicked at" not in app.text())
    app.stop()
    return installed


def check_transcript(label, heard):
    expected, got = words_of(expected_text), words_of(heard)
    rate = word_error_rate(expected, got)
    results.add(
        f"{label}: the transcript matches the clip",
        bool(got) and rate <= 0.35,
        f"heard \"{heard.strip()}\"; clip says \"{expected_text}\"; word error rate {rate:.2f}",
    )


def transcribe_through_automation(project, name, store=None):
    """Generate through the Transcript panel's own Generate path, on a copy of
    the recording that has no captions yet, and dump the words."""
    profile = rclib.make_profile(os.path.join(out, f"{name}-profile"), sections=store)
    dump = os.path.join(out, f"{name}.words.json")
    app = App(
        package,
        profile,
        os.path.dirname(project),
        {
            "CAP_GPUI_AUTO_EDITOR": project,
            "CAP_GPUI_AUTO_SIDEBAR": "captions",
            "CAP_GPUI_AUTO_TRANSCRIPT": f"wait:4000,open,wait:1000,transcribe,wait:3000,dump:{dump}",
            **extra_env,
        },
        name,
    )
    done = app.wait_log(r"transcript-auto: dump:", 900)
    time.sleep(2)
    rclib.screenshot(os.path.join(out, f"{name}-transcript.png"))
    text = app.text()
    with open(os.path.join(out, f"{name}.model.log"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(rclib.grep(text, r"parakeet|caption|transcri|model|panicked|speech")) + "\n")
    results.add(f"{name}: Generate ran", bool(done) and "panicked at" not in text, text[-1500:] if not done else "")
    app.stop()
    heard = ""
    try:
        with open(dump, encoding="utf-8") as handle:
            heard = " ".join(word["text"] for word in json.load(handle)["words"])
    except (OSError, ValueError, KeyError) as error:
        results.note(f"{name}: word dump", repr(error))
    engine = rclib.grep(text, r"Using Parakeet TDT engine|Using Whisper engine")
    results.note(f"{name}: engine", " / ".join(line[-120:] for line in engine[:2]) or "no engine line")
    check_transcript(name, heard)
    return heard


project = record_clip()
if not project:
    results.add("a recording of the clip exists", False)
    sys.exit(results.finish())

if os.path.isdir(models):
    shutil.rmtree(models)
os.makedirs(models, exist_ok=True)

if case == "old":
    old = os.environ["RC_OLD_MODEL"]
    shutil.copytree(old, os.path.join(models, "parakeet-best"))
    state = model_state()
    results.add(
        "the old layout is in place before launch",
        "encoder-model.int8.onnx" in state and "encoder-model.onnx" not in state,
        json.dumps(state),
    )
    if download_through_the_editor(project_copy(project, "editor"), expect_note=True):
        transcribe_through_automation(project_copy(project, "generate"), "generate")
elif case == "fresh":
    if download_through_the_editor(project_copy(project, "editor"), expect_note=False):
        transcribe_through_automation(project_copy(project, "generate"), "generate")
elif case == "full":
    shutil.copytree(os.environ["RC_FULL_MODEL"], os.path.join(models, "parakeet-best-max"))
    results.note("model folders", f"parakeet-best-max {json.dumps(model_state('parakeet-best-max'))}; parakeet-best absent")
    transcribe_through_automation(
        project_copy(project, "generate"),
        "high-accuracy",
        store={"gpui": {"selectedTranscriptionModel": "best-max"}},
    )

sys.exit(results.finish())
