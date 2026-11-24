"""Runs Cap's FFmpeg paths through the real app and CLI with one FFmpeg build.

  python probe.py <label> <bin dir> <out root> <corpus dir> <reference .cap>

<bin dir> holds cap-gpui and cap (with .exe on Windows) next to the FFmpeg
libraries under test. Run it once with the old libraries and once with the
new ones, then compare.py <out root> <base label> <head label>.

Writes <out root>/<label>.json. Media is summarised as its sha256 plus the
md5 of every decoded video frame and of the decoded audio, so two runs can be
compared byte for byte or, where an encoder is not deterministic, by content.
"""

import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time

LABEL, BIN, ROOT, CORPUS, REFERENCE = sys.argv[1:6]
ROOT = os.path.abspath(ROOT)
OUT = os.path.join(ROOT, LABEL)
SYSTEM = platform.system()
EXE = ".exe" if SYSTEM == "Windows" else ""
APP = os.path.join(BIN, "cap-gpui" + EXE)
CLI = os.path.join(BIN, "cap" + EXE)
FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
ONLY = set(filter(None, os.environ.get("PROBE_ONLY", "").split(",")))
results = {"label": LABEL, "os": SYSTEM, "cases": {}}


def wanted(group):
    return not ONLY or group in ONLY


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(args, timeout=1800, env=None):
    started = time.time()
    try:
        done = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout, env=env, errors="replace"
        )
        return done.returncode, done.stdout, done.stderr, time.time() - started
    except subprocess.TimeoutExpired as error:
        return -1, error.stdout or "", f"timeout after {timeout}s", time.time() - started


def describe(path):
    """sha256, stream summary, per-frame video md5s and decoded audio md5."""
    info = {"sha256": sha256(path), "bytes": os.path.getsize(path)}
    code, out, _, _ = run(
        [
            FFPROBE, "-v", "error", "-show_entries",
            "stream=index,codec_type,codec_name,profile,pix_fmt,width,height,r_frame_rate,"
            "sample_rate,channels,sample_fmt,nb_frames:format=format_name,duration",
            "-of", "json", path,
        ]
    )
    if code == 0:
        info["probe"] = json.loads(out)
    code, out, err, _ = run([FFMPEG, "-v", "error", "-i", path, "-map", "0:v?", "-f", "framemd5", "-"])
    frames = [line.rsplit(",", 1)[-1].strip() for line in out.splitlines() if line and not line.startswith("#")]
    info["video_frames"] = len(frames)
    info["video_md5"] = hashlib.sha256("\n".join(frames).encode()).hexdigest() if frames else None
    code, out, err, _ = run([FFMPEG, "-v", "error", "-i", path, "-map", "0:a?", "-f", "md5", "-"])
    info["audio_md5"] = out.strip().removeprefix("MD5=") or None
    code, _, err, _ = run([FFMPEG, "-v", "error", "-xerror", "-i", path, "-f", "null", "-"])
    info["decode_errors"] = err.strip()[:2000] if code != 0 or err.strip() else ""
    return info


def describe_tree(directory):
    media = {}
    for base, _, names in os.walk(directory):
        for name in sorted(names):
            path = os.path.join(base, name)
            relative = os.path.relpath(path, directory).replace(os.sep, "/")
            if name.endswith((".mp4", ".mov", ".m4a", ".ogg", ".wav", ".mp3", ".gif", ".m4s")):
                media[relative] = describe(path)
            elif name.endswith((".png", ".jpg", ".jpeg")):
                media[relative] = {"sha256": sha256(path)}
    return media


def record(group, name, data):
    results["cases"][f"{group}/{name}"] = data
    status = "ok  " if data.get("ok") else "FAIL"
    print(f"{status} {group}/{name}  {data.get('error', '')[:200]}", flush=True)
    save()


def save():
    with open(os.path.join(ROOT, LABEL + ".json"), "w") as handle:
        json.dump(results, handle, indent=1, sort_keys=True)


def project(name, edit=None):
    path = os.path.join(OUT, "projects", name + ".cap")
    shutil.rmtree(path, ignore_errors=True)
    shutil.copytree(REFERENCE, path, ignore=shutil.ignore_patterns("output"))
    config_path = os.path.join(path, "project-config.json")
    config = json.load(open(config_path))
    timeline = config.setdefault("timeline", {})
    timeline["segments"] = [
        {"recordingSegment": 0, "timescale": 1.0, "start": 2.0, "end": 5.0},
        {"recordingSegment": 1, "timescale": 1.0, "start": 1.0, "end": 3.0},
    ]
    timeline["zoomSegments"] = []
    if edit:
        edit(config, path)
    json.dump(config, open(config_path, "w"))
    return path


def studio_sound_speed_music(config, path):
    config.setdefault("audio", {})["improve"] = True
    segments = config["timeline"]["segments"]
    segments[0]["timescale"] = 1.5
    segments[1]["timescale"] = 0.5
    music = os.path.join(path, "music.mp3")
    shutil.copy(os.path.join(CORPUS, "audio", "cbr.mp3"), music)
    config["timeline"]["audioSegments"] = [
        {"start": 0.0, "end": 4.0, "track": 0, "path": "music.mp3", "enabled": True, "volumeDb": -6.0}
    ]


def cli_export(name, project_path, args, env_extra=None, output_name=None):
    output = os.path.join(OUT, "exports", output_name or name)
    if os.path.isdir(output):
        shutil.rmtree(output)
    elif os.path.exists(output):
        os.remove(output)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    env = dict(os.environ)
    env.update(env_extra or {})
    code, out, err, elapsed = run([CLI, "export", project_path, "-o", output, *args], env=env)
    data = {"ok": code == 0, "seconds": round(elapsed, 1)}
    if code != 0:
        data["error"] = (err or out).strip()[-1500:]
    elif os.path.isdir(output):
        data["media"] = describe_tree(output)
    elif os.path.isfile(output):
        data["media"] = {os.path.basename(output): describe(output)}
    else:
        data.update(ok=False, error="no output written")
    return data


def exports():
    plain = project("plain")
    rich = project("rich", studio_sound_speed_music)
    size = ["--resolution", "1280x720", "--fps", "30"]
    cases = [
        ("mp4-maximum.mp4", plain, ["--quality", "maximum", *size], None),
        ("mp4-social.mp4", plain, ["--quality", "social", *size], None),
        ("mp4-web.mp4", plain, ["--quality", "web", *size], None),
        ("mp4-potato.mp4", plain, ["--quality", "potato", *size], None),
        ("mp4-native-60.mp4", plain, ["--fps", "60"], None),
        ("mp4-crf.mp4", plain, ["--optimize-filesize", *size], None),
        ("mp4-software.mp4", plain, size, {"CAP_EXPORT_FORCE_SOFTWARE_ENCODER": "1"}),
        ("mp4-ffmpeg-decoder.mp4", plain, ["--force-ffmpeg-decoder", *size], None),
        ("mov-prores.mov", plain, ["--format", "mov", "--resolution", "1280x720", "--fps", "30"], None),
        ("gif.gif", plain, ["--format", "gif", "--resolution", "640x360", "--fps", "15"], None),
        ("tracks", plain, ["--tracks", "all", "--fps", "30"], None),
        ("rich-studio-sound-speed-music.mp4", rich, size, None),
        ("rich-software.mp4", rich, size, {"CAP_EXPORT_FORCE_SOFTWARE_ENCODER": "1"}),
    ]
    for name, path, args, env in cases:
        record("export", name, cli_export(name, path, args, env))


def profile(name):
    root = os.path.join(OUT, "profiles", name)
    shutil.rmtree(root, ignore_errors=True)
    for sub in ("recordings", "logs", "assets"):
        os.makedirs(os.path.join(root, sub), exist_ok=True)
    json.dump({"restore": "done", "remoteCheckedAt": 0}, open(os.path.join(root, "assets", "state.json"), "w"))
    store = {
        "general_settings": {
            "hasCompletedOnboarding": True,
            "hasCompletedStartup": True,
            "enableNotifications": False,
            "enableTelemetry": False,
            "recordingCountdown": 0,
        }
    }
    json.dump(store, open(os.path.join(root, "store"), "w"))
    return root


def launch(root, extra, log_path):
    env = dict(os.environ)
    env.update(
        {
            "CAP_GPUI_APP_DATA_DIR": root,
            "CAP_GPUI_RECORDINGS_DIR": os.path.join(root, "recordings"),
            "CAP_GPUI_LOG_DIR": os.path.join(root, "logs"),
            "CAP_ASSETS_DIR": os.path.join(root, "assets"),
            "CAP_GPUI_AUTO_NO_MIC": "1",
            "RUST_LOG": "cap_gpui=info,cap_export=info",
        }
    )
    env.update(extra)
    log = open(log_path, "w")
    return subprocess.Popen([APP], env=env, stdout=log, stderr=subprocess.STDOUT)


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def wait_for_log(log_path, patterns, process, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        text = open(log_path, errors="replace").read()
        for pattern in patterns:
            match = re.search(pattern, text)
            if match:
                return match, text
        if process.poll() is not None:
            return None, text
        time.sleep(0.5)
    return None, open(log_path, errors="replace").read()


DONE = [
    r"video import complete[^\n]*path=(?P<path>[^\n]+)",
    r"image import complete[^\n]*path=(?P<path>[^\n]+)",
    r"(?P<fail>failed to import [^\n]+)",
    r"(?P<fail>video import transcode failed[^\n]+)",
]


def clean(text):
    return re.sub(r"\x1b\[[0-9;]*m", "", text).strip()


def imports():
    names = sorted(os.listdir(os.path.join(CORPUS, "video"))) + sorted(os.listdir(os.path.join(CORPUS, "image")))
    for name in names:
        kind = "video" if os.path.exists(os.path.join(CORPUS, "video", name)) else "image"
        source = os.path.join(CORPUS, kind, name)
        root = profile(f"import-{name}")
        log_path = os.path.join(OUT, "logs", f"import-{name}.log")
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        process = launch(root, {"CAP_GPUI_AUTO_IMPORT_MEDIA": source}, log_path)
        match, text = wait_for_log(log_path, DONE, process, 300)
        time.sleep(1)
        stop(process)
        data = {"ok": False}
        if not match:
            data["error"] = "no import result in the log"
        elif match.groupdict().get("fail"):
            data["error"] = clean(match.group("fail"))
        else:
            path = clean(match.group("path")).strip('"')
            data["ok"] = os.path.exists(path)
            data["media"] = describe_tree(path) if os.path.isdir(path) else {}
            if kind == "video" and data["ok"]:
                exported = cli_export(name, path, ["--quality", "web", "--fps", "30"], output_name=f"import-{name}.mp4")
                data["export"] = exported
                data["ok"] = exported["ok"]
                data.setdefault("error", exported.get("error", ""))
        record("import", name, data)


def audio_imports():
    for name in sorted(os.listdir(os.path.join(CORPUS, "audio"))):
        for extension in ("mp3", "wav"):
            output = os.path.join(OUT, "exports", f"audio-{name}.{extension}")
            if os.path.exists(output):
                os.remove(output)
            root = profile(f"audio-{name}-{extension}")
            log_path = os.path.join(OUT, "logs", f"audio-{name}-{extension}.log")
            process = launch(
                root,
                {"CAP_GPUI_AUTO_IMPORT_AUDIO": os.path.join(CORPUS, "audio", name), "CAP_GPUI_AUTO_EXPORT": output},
                log_path,
            )
            deadline = time.time() + 240
            finished = False
            while time.time() < deadline and process.poll() is None:
                if os.path.isfile(output):
                    size = os.path.getsize(output)
                    time.sleep(3)
                    if size > 0 and os.path.getsize(output) == size:
                        finished = True
                        break
                time.sleep(0.5)
            stop(process)
            data = {"ok": finished}
            if finished:
                data["media"] = {os.path.basename(output): describe(output)}
            else:
                data["error"] = "no export written; log tail: " + clean(open(log_path, errors="replace").read()[-600:])
            record("audio", f"{name}.{extension}", data)


def recordings():
    for mode in ("studio", "instant"):
        path = os.path.join(OUT, "recordings", f"{mode}.cap")
        shutil.rmtree(path, ignore_errors=True)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        args = [CLI, "record", "--mode", mode, "--duration", "5", "--path", path]
        if os.environ.get("PROBE_SCREEN"):
            args += ["--screen", os.environ["PROBE_SCREEN"]]
        code, out, err, elapsed = run(args, timeout=180)
        data = {"ok": code == 0 and os.path.isdir(path), "seconds": round(elapsed, 1)}
        if not data["ok"]:
            data["error"] = (err or out).strip()[-1500:]
        else:
            data["media"] = describe_tree(path)
            bad = [name for name, info in data["media"].items() if info.get("decode_errors")]
            if bad:
                data.update(ok=False, error="decode errors in " + ", ".join(bad))
            exported = cli_export(f"recording-{mode}", path, ["--fps", "30"], output_name=f"recording-{mode}.mp4")
            data["export"] = exported
            if not exported["ok"]:
                data.update(ok=False, error=exported.get("error", "export failed"))
        record("record", mode, data)


os.makedirs(OUT, exist_ok=True)
results["ffmpeg_tool"] = run([FFMPEG, "-version"])[1].splitlines()[0] if FFMPEG else None
if wanted("export"):
    exports()
if wanted("import"):
    imports()
if wanted("audio"):
    audio_imports()
if wanted("record") and os.environ.get("PROBE_RECORD") == "1":
    recordings()
save()
failed = [name for name, data in results["cases"].items() if not data.get("ok")]
print(f"{LABEL}: {len(results['cases']) - len(failed)} ok, {len(failed)} failed", flush=True)
