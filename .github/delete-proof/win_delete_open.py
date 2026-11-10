"""Windows, real app: a Studio recording stops, the app opens the editor on it
by itself, and the recording is deleted from Settings > Recordings.

Usage: win_delete_open.py <package> <out-dir> <editor-closed|editor-open>
`editor-closed` closes the editor before Delete is pressed. `editor-open`
leaves it as the app left it, presses Delete, records what the app says and
what is left on disk, then closes the editor and deletes again. Positions are
relative to the Settings window's top left corner: the Recordings and
Screenshots rows of the sidebar, and the Delete button of the first row."""

import ctypes
import ctypes.wintypes as wt
import os
import sys
import time

import rclib
import winui
from rclib import App, Results, log

package, out, variant = sys.argv[1], os.path.abspath(sys.argv[2]), sys.argv[3]
results = Results(out, f"Deleting a recording from Settings on Windows, {variant}")
DELETE = (735, 256)
RECORDINGS = (72, 283)
SCREENSHOTS = (74, 315)
RECORD_SECONDS = 20

profile = rclib.make_profile(os.path.join(out, "profile"), general={"excludedWindows": []})
recordings = os.path.join(out, "rec")
os.makedirs(recordings, exist_ok=True)
app = App(
    package,
    profile,
    recordings,
    {"CAP_GPUI_AUTO_RECORD": f"studio:{RECORD_SECONDS}", "CAP_GPUI_AUTO_SETTINGS": "recordings"},
)


def app_window(word):
    candidates = [
        entry
        for entry in winui.windows(app.process.pid)
        if entry["visible"] and not entry["minimized"] and word in entry["title"].lower()
    ]
    return candidates[0] if candidates else None


def dialogs():
    return [
        entry
        for entry in winui.windows(app.process.pid)
        if entry["visible"] and entry["class"] == "#32770"
    ]


def child_texts(hwnd):
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    def visit(child, _):
        text = ctypes.create_unicode_buffer(1024)
        winui.user32.GetWindowTextW(child, text, 1024)
        if text.value.strip():
            found.append(text.value.strip())
        return True

    winui.user32.EnumChildWindows(hwnd, visit, 0)
    return found


def start_screen_recording(name):
    import shutil
    import subprocess

    ffmpeg = os.path.join(package, "bin", "ffmpeg.exe")
    if not os.path.exists(ffmpeg):
        ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        log("no ffmpeg, no screen recording")
        return None
    path = os.path.join(out, f"{name}.mp4")
    handle = open(os.path.join(out, f"{name}.ffmpeg.log"), "wb")
    process = subprocess.Popen(
        [ffmpeg, "-y", "-f", "gdigrab", "-framerate", "10", "-i", "desktop", "-c:v", "libx264",
         "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", path],
        stdin=subprocess.PIPE, stdout=handle, stderr=subprocess.STDOUT,
    )
    log(f"screen recording to {path}")
    return process


def stop_screen_recording(process):
    if not process:
        return
    try:
        process.stdin.write(b"q")
        process.stdin.flush()
        process.wait(30)
    except Exception as error:
        log(f"stopping the screen recording: {error!r}")
        process.kill()


def listing(project):
    found = []
    for base, _, names in os.walk(project):
        found += [os.path.relpath(os.path.join(base, name), project) for name in names]
    return sorted(found)


def shot(name):
    path = rclib.screenshot(os.path.join(out, f"{name}.png"))
    with open(os.path.join(out, f"{name}.windows.txt"), "w", encoding="utf-8") as handle:
        handle.write(winui.describe(winui.windows(app.process.pid)))
    return path


def read_dialogs(name):
    """Every dialog the app has up: its title, the text of its controls, and
    the text read off a screenshot of it."""
    path = shot(name)
    seen = []
    for entry in dialogs():
        left, top, right, bottom = entry["rect"]
        read = rclib.ocr_block(path, (max(left, 0), max(top, 0), right, bottom))
        seen.append({"hwnd": entry["hwnd"], "title": entry["title"], "controls": child_texts(entry["hwnd"]), "read": read})
    with open(os.path.join(out, f"{name}.dialogs.txt"), "w", encoding="utf-8") as handle:
        for entry in seen:
            handle.write(f"title={entry['title']!r} controls={entry['controls']!r} read={entry['read']!r}\n")
    return seen


def said(entries):
    return " / ".join(
        f"[{entry['title']}] {' '.join(entry['controls']) or entry['read']}" for entry in entries
    ) or "nothing"


def press_enter(hwnd):
    winui.user32.SetForegroundWindow(hwnd)
    time.sleep(0.4)
    winui.user32.keybd_event(0x0D, 0, 0, 0)
    winui.user32.keybd_event(0x0D, 0, 2, 0)


def dismiss():
    for _ in range(4):
        opened = dialogs()
        if not opened:
            return
        press_enter(opened[0]["hwnd"])
        time.sleep(1)
    for entry in dialogs():
        winui.user32.PostMessageW(entry["hwnd"], 0x0010, 0, 0)
    time.sleep(1)


def press(point):
    window = app_window("settings")
    if not window:
        return None
    winui.raise_window(window["hwnd"])
    time.sleep(0.6)
    left, top, _, _ = winui.rect(window["hwnd"])
    rclib.click(left + point[0], top + point[1])
    return (left + point[0], top + point[1])


def reload_recordings():
    press(SCREENSHOTS)
    time.sleep(1.5)
    press(RECORDINGS)
    time.sleep(3)


def delete_from_settings(name):
    """Presses Delete on the first row, answers Yes if the app asks, and waits
    for the delete to settle. Returns what the app said on the way."""
    since = len(app.text())
    point = press(DELETE)
    time.sleep(2)
    first = read_dialogs(f"{name}-after-click")
    log(f"clicked {point}; dialogs: {said(first)}")
    confirmed = False
    for entry in first:
        if entry["title"] == "Cap":
            press_enter(entry["hwnd"])
            confirmed = True
    deleted = None
    if confirmed:
        deleted = app.wait_log(r"deleted a recording|deleting the recording failed|recording deletion failed", 45, since)
        time.sleep(2)
    second = read_dialogs(f"{name}-settled") if confirmed else []
    return {
        "asked": confirmed,
        "said": first + second,
        "deleted": bool(deleted) and "deleted a recording" in deleted.group(0),
        "log": rclib.grep(app.text()[since:], r"deleting the recording failed|recording deletion failed|deleted a recording"),
    }


started = app.wait_log(r"recording started", 90)
results.add("recording started", bool(started))
window = None
for _ in range(20):
    window = app_window("settings")
    if window:
        break
    time.sleep(1)
results.add("Settings window is open", bool(window), str(window))
if not window:
    log(winui.describe(winui.windows(app.process.pid)))
    app.stop()
    sys.exit(results.finish())
winui.place(window["hwnd"], 40, 40)

finished = app.wait_log(r"recording finished", RECORD_SECONDS + 120)
results.add("recording finished", bool(finished))
time.sleep(6)
projects = rclib.find_projects(recordings)
project = projects[0] if projects else None
status = "missing"
if project:
    try:
        status = rclib.meta_status(rclib.read_meta(project))
    except Exception as error:
        status = repr(error)
results.add("the recording finalized", status.startswith("Complete"), f"status={status}")
editor = app_window("editor")
results.add("the app opened the editor on the recording by itself", bool(editor), editor["title"] if editor else "none")
if not project:
    app.stop()
    sys.exit(results.finish())

if variant == "editor-closed":
    if editor:
        winui.user32.PostMessageW(editor["hwnd"], 0x0010, 0, 0)
    time.sleep(4)
    results.add("the editor was closed before Delete", app_window("editor") is None)

screen = start_screen_recording(f"screen-{variant}")
before = listing(project)
results.note("files in the recording before Delete", f"{len(before)}: {before}")
winui.raise_window(window["hwnd"])
time.sleep(1)
reload_recordings()
shot("1-before-delete")
outcome = delete_from_settings("2-delete")
left = listing(project) if os.path.exists(project) else []
results.note("what the app said", said(outcome["said"]))
results.note("delete lines in the log", " / ".join(line[-260:] for line in outcome["log"]) or "none")
results.add(
    "the delete was all or nothing",
    not left or left == before,
    f"{len(before)} files before, {len(left)} after"
    + (f"; gone: {sorted(set(before) - set(left))}; left: {left}" if left and left != before else ""),
)

if variant == "editor-closed":
    results.add("the app asked for confirmation", outcome["asked"])
    results.add(
        "Delete removed the recording",
        outcome["deleted"] and not os.path.exists(project),
        f"log line: {outcome['deleted']}; folder exists: {os.path.exists(project)}",
    )
else:
    text = " ".join(
        " ".join(entry["controls"]) + " " + entry["read"] + " " + entry["title"] for entry in outcome["said"]
    ).lower()
    results.add("the app asked for confirmation", outcome["asked"])
    results.add("the editor closed", app_window("editor") is None)
    results.add(
        "Delete removed the whole recording",
        outcome["deleted"] and not os.path.exists(project),
        f"log line: {outcome['deleted']}; folder exists: {os.path.exists(project)}; {len(left)} of {len(before)} files left",
    )
    results.add(
        "no raw OS error reached the log or a dialog",
        "os error" not in text and not rclib.grep(" ".join(outcome["log"]), r"os error"),
    )
    holding = os.path.join(rclib.long_path(recordings), ".cap-deleting")
    staged = os.listdir(holding) if os.path.isdir(holding) else []
    results.add("nothing left in the holding folder", not staged, str(staged))
    time.sleep(3)
    shot("3-after-delete")

dismiss()
shot("4-end")
stop_screen_recording(screen)
leftovers = [name for name in os.listdir(rclib.long_path(recordings)) if name not in (".upload-locks",)]
results.note("what is left in the recordings folder", str(leftovers))
results.add("no panic", "panicked at" not in app.text() and app.alive())
app.stop()
sys.exit(results.finish())
