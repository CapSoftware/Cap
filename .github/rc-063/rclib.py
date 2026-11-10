"""Shared helpers for the 0.6.3 real-app scenarios: launch the GPUI app with
its own profile, follow its log, take screenshots, read them and click."""

import json
import os
import re
import shutil
import subprocess
import sys
import time

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")

WINDOWS = sys.platform == "win32"
MAC = sys.platform == "darwin"
LINUX = sys.platform.startswith("linux")
ANSI = re.compile(r"\x1b\[[0-9;]*m")

STORE = {
    "general_settings": {
        "hasCompletedStartup": True,
        "hasCompletedOnboarding": True,
        "enableNotifications": False,
        "enableTelemetry": False,
        "recordingCountdown": 0,
    },
    "recording_start_safety": {"confirmBeforeRecordingWithoutMicrophone": False},
}


def log(message):
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def long_path(path):
    """Windows file calls from this harness go through the verbatim prefix so
    the harness itself is never what a long path breaks."""
    path = os.path.abspath(path)
    if WINDOWS and not path.startswith("\\\\?\\"):
        return "\\\\?\\" + path
    return path


def app_binary(package):
    return os.path.join(package, "bin", "cap-gpui.exe" if WINDOWS else "cap-gpui")


def make_profile(profile, general=None, sections=None):
    os.makedirs(os.path.join(profile, "logs"), exist_ok=True)
    store = json.loads(json.dumps(STORE))
    store["general_settings"].update(general or {})
    store.update(sections or {})
    with open(os.path.join(profile, "store"), "w") as handle:
        json.dump(store, handle)
    return profile


class App:
    def __init__(self, package, profile, recordings, env=None, name="app"):
        self.profile = profile
        self.log_path = os.path.join(profile, f"{name}.log")
        full = dict(os.environ)
        full.update(
            {
                "CAP_GPUI_APP_DATA_DIR": profile,
                "CAP_GPUI_RECORDINGS_DIR": recordings,
                "CAP_GPUI_LOG_DIR": os.path.join(profile, "logs"),
                "CAP_GPUI_NO_TRAY": "1",
                "CAP_GPUI_AUTO_NO_MIC": "1",
                "RUST_LOG": "info",
                "NO_COLOR": "1",
            }
        )
        if LINUX:
            libs = os.path.join(package, "libs")
            full["LD_LIBRARY_PATH"] = libs + os.pathsep + full.get("LD_LIBRARY_PATH", "")
            onnx = os.path.join(libs, "libonnxruntime.so")
            if os.path.exists(onnx):
                full["ORT_DYLIB_PATH"] = onnx
        full.update(env or {})
        self.env = full
        self.handle = open(self.log_path, "wb")
        self.process = subprocess.Popen(
            [app_binary(package)], env=full, stdout=self.handle, stderr=subprocess.STDOUT
        )
        log(f"launched {name} pid={self.process.pid} log={self.log_path}")

    def text(self):
        try:
            with open(self.log_path, "rb") as handle:
                return ANSI.sub("", handle.read().decode("utf-8", "replace"))
        except FileNotFoundError:
            return ""

    def wait_log(self, pattern, seconds, since=0):
        deadline = time.time() + seconds
        compiled = re.compile(pattern)
        while time.time() < deadline:
            match = compiled.search(self.text(), since)
            if match:
                return match
            if self.process.poll() is not None:
                match = compiled.search(self.text(), since)
                return match
            time.sleep(0.1)
        return None

    def alive(self):
        return self.process.poll() is None

    def stop(self, grace=5):
        if self.alive():
            self.process.terminate()
            try:
                self.process.wait(grace)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(10)
        self.handle.close()
        return self.process.returncode

    def kill(self):
        if self.alive():
            self.process.kill()
            self.process.wait(10)
        self.handle.close()


def grep(text, pattern, flags=re.IGNORECASE):
    return [line for line in text.splitlines() if re.search(pattern, line, flags)]


def find_projects(recordings):
    root = long_path(recordings)
    if not os.path.isdir(root):
        return []
    return sorted(
        os.path.join(root, name) for name in os.listdir(root) if name.endswith(".cap")
    )


def tree(path, limit=400):
    lines = []
    for base, dirs, files in os.walk(long_path(path)):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(base, name)
            try:
                size = os.path.getsize(full)
            except OSError:
                size = -1
            lines.append(f"{size:>12} {os.path.relpath(full, long_path(path))}")
    if len(lines) > limit:
        lines = lines[: limit // 2] + [f"... {len(lines) - limit} more ..."] + lines[-limit // 2 :]
    return "\n".join(lines)


def read_meta(project):
    with open(os.path.join(long_path(project), "recording-meta.json"), "rb") as handle:
        return json.loads(handle.read().decode("utf-8"))


def meta_status(meta):
    status = meta.get("status")
    if isinstance(status, dict):
        return status.get("status")
    return status if status is not None else "Complete (no status key)"


def screenshot(path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    if WINDOWS:
        from PIL import ImageGrab

        ImageGrab.grab(all_screens=True).save(path)
    elif MAC:
        subprocess.run(["screencapture", "-x", path], check=False)
    else:
        subprocess.run(["import", "-window", "root", path], check=False)
    return path


def tesseract():
    found = shutil.which("tesseract")
    if found:
        return found
    for candidate in (r"C:\Program Files\Tesseract-OCR\tesseract.exe",):
        if os.path.exists(candidate):
            return candidate
    return None


def ocr(path, scale=3, invert=False, psm=11):
    """Words with their boxes in screenshot pixels."""
    from PIL import Image, ImageOps

    binary = tesseract()
    if not binary:
        return []
    image = Image.open(path).convert("L")
    if invert:
        image = ImageOps.invert(image)
    image = image.resize((image.width * scale, image.height * scale), Image.LANCZOS)
    scaled = path + (".inv" if invert else "") + ".ocr.png"
    image.save(scaled)
    result = subprocess.run(
        [binary, scaled, "stdout", "--psm", str(psm), "tsv"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    os.remove(scaled)
    words = []
    for row in result.stdout.splitlines()[1:]:
        cells = row.split("\t")
        if len(cells) < 12 or not cells[11].strip():
            continue
        left, top, width, height = (int(cells[i]) for i in (6, 7, 8, 9))
        words.append(
            {
                "text": cells[11].strip(),
                "x": left // scale,
                "y": top // scale,
                "w": width // scale,
                "h": height // scale,
                "line": (cells[2], cells[3], cells[4]),
            }
        )
    return words


def ocr_both(path, **kwargs):
    """Sparse text and page layout readings of both polarities: the sparse
    mode misses light text on dark buttons, the layout mode misses stray
    labels."""
    words = []
    for psm in (11, 3):
        words += ocr(path, psm=psm, **kwargs) + ocr(path, invert=True, psm=psm, **kwargs)
    return words


def ocr_block(path, box, scale=3):
    """The text of one region of a screenshot, read as a paragraph. Small grey
    body text is missed by the full-screen passes and read well this way."""
    from PIL import Image, ImageOps

    binary = tesseract()
    if not binary:
        return ""
    region = Image.open(path).convert("L").crop(box)
    region = ImageOps.autocontrast(region.resize((region.width * scale, region.height * scale), Image.LANCZOS))
    scaled = path + ".block.ocr.png"
    region.save(scaled)
    done = subprocess.run([binary, scaled, "stdout", "--psm", "6"], capture_output=True)
    os.remove(scaled)
    return " ".join(done.stdout.decode("utf-8", "replace").split())


def ocr_text(words):
    return " ".join(word["text"] for word in words)


def find_phrase(words, phrase):
    """Box of the first run of consecutive words spelling `phrase`."""
    def plain(text):
        return re.sub(r"[^\w]", "", text.lower())

    wanted = [plain(part) for part in phrase.split()]
    for first in words:
        if plain(first["text"]) != wanted[0]:
            continue
        run = [first]
        for part in wanted[1:]:
            last = run[-1]
            following = [
                word
                for word in words
                if plain(word["text"]) == part
                and abs(word["y"] - last["y"]) <= max(last["h"], 6)
                and 0 <= word["x"] - (last["x"] + last["w"]) <= 6 * max(last["h"], 8)
            ]
            if not following:
                break
            run.append(min(following, key=lambda word: word["x"]))
        if len(run) == len(wanted):
            left = min(word["x"] for word in run)
            top = min(word["y"] for word in run)
            right = max(word["x"] + word["w"] for word in run)
            bottom = max(word["y"] + word["h"] for word in run)
            return {"x": left, "y": top, "w": right - left, "h": bottom - top}
    return None


def center(box):
    return box["x"] + box["w"] // 2, box["y"] + box["h"] // 2


def click(x, y):
    log(f"click {x},{y}")
    if WINDOWS:
        import ctypes

        user32 = ctypes.windll.user32
        user32.SetCursorPos(int(x), int(y))
        time.sleep(0.15)
        user32.mouse_event(0x0002, 0, 0, 0, 0)
        time.sleep(0.05)
        user32.mouse_event(0x0004, 0, 0, 0, 0)
    elif MAC:
        subprocess.run(["cliclick", f"c:{int(x)},{int(y)}"], check=False)
    else:
        subprocess.run(
            ["xdotool", "mousemove", str(int(x)), str(int(y)), "sleep", "0.2", "click", "1"],
            check=False,
        )


def move(x, y):
    if WINDOWS:
        import ctypes

        ctypes.windll.user32.SetCursorPos(int(x), int(y))
    elif MAC:
        subprocess.run(["cliclick", f"m:{int(x)},{int(y)}"], check=False)
    else:
        subprocess.run(["xdotool", "mousemove", str(int(x)), str(int(y))], check=False)


class Results:
    def __init__(self, out, title):
        self.out = out
        self.title = title
        self.rows = []
        os.makedirs(out, exist_ok=True)

    def add(self, key, ok, detail=""):
        self.rows.append((key, ok, detail))
        log(f"RESULT {key}: {'ok' if ok else 'NOT OK'} {detail}")

    def note(self, key, detail):
        self.rows.append((key, None, detail))
        log(f"NOTE {key}: {detail}")

    def finish(self):
        with open(os.path.join(self.out, "result.txt"), "w", encoding="utf-8") as handle:
            for key, ok, detail in self.rows:
                state = "note" if ok is None else ("ok" if ok else "NOT_OK")
                handle.write(f"{key}\t{state}\t{detail}\n")
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a", encoding="utf-8") as handle:
                handle.write(f"\n### {self.title}\n\n| check | result | detail |\n| --- | --- | --- |\n")
                for key, ok, detail in self.rows:
                    state = "note" if ok is None else ("ok" if ok else "NOT OK")
                    detail = str(detail).replace("|", "\\|").replace("\n", " ")
                    handle.write(f"| {key} | {state} | {detail} |\n")
        failed = [key for key, ok, _ in self.rows if ok is False]
        if failed:
            log(f"{self.title}: NOT OK: {', '.join(failed)}")
            return 1
        log(f"{self.title}: all checks ok")
        return 0
