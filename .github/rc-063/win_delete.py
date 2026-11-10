"""Item 2 (#3969), Windows: with Settings > Recordings open during a Studio
recording, Delete on the recording in progress does nothing and its files
stay; once the recording has stopped and finalized, the same Delete removes it.

Usage: win_delete.py <package> <out-dir> <editor-closed|editor-open>
The editor opens by itself when a Studio recording stops. `editor-closed`
closes it before Delete is pressed, `editor-open` leaves it as the app left
it. Positions are relative to the Settings window's top left corner, read off
a screenshot of this build: the Recordings and Screenshots rows of the
sidebar, and the Delete button of the first recording row."""

import os
import sys
import time

import rclib
import winui
from rclib import App, Results, log

package, out, variant = sys.argv[1], os.path.abspath(sys.argv[2]), sys.argv[3]
results = Results(out, f"Item 2: deleting the recording in progress on Windows (#3969), {variant}")
DELETE = (735, 256)
RECORDINGS = (72, 283)
SCREENSHOTS = (74, 315)
RECORD_SECONDS = 45

# Cap hides its own windows from screen captures while it records, which also
# hides them from this scenario's screenshots. The excluded windows list is a
# setting; it is emptied here so the Settings window shows in the evidence.
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


def listing(project):
    found = []
    for base, _, names in os.walk(project):
        found += [os.path.relpath(os.path.join(base, name), project) for name in names]
    return sorted(found)


def shot(name, read=False):
    path = rclib.screenshot(os.path.join(out, f"{name}.png"))
    with open(os.path.join(out, f"{name}.windows.txt"), "w", encoding="utf-8") as handle:
        handle.write(winui.describe(winui.windows(app.process.pid)))
    if not read:
        return []
    words = rclib.ocr_both(path)
    with open(os.path.join(out, f"{name}.ocr.txt"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(f"{word['x']},{word['y']} {word['text']}" for word in words))
    return words


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
    """Leaves the Recordings page and comes back, which scans the library
    again, as a person opening the page during the recording would see it."""
    press(SCREENSHOTS)
    time.sleep(1.5)
    press(RECORDINGS)
    time.sleep(3)


started = app.wait_log(r"recording started", 90)
results.add("recording started", bool(started))
time.sleep(8)
window = app_window("settings")
results.add("Settings window is open during the recording", bool(window), str(window))
if not window:
    log(winui.describe(winui.windows(app.process.pid)))
    app.stop()
    sys.exit(results.finish())
winui.place(window["hwnd"], 40, 40)
winui.raise_window(window["hwnd"])
time.sleep(1.5)
reload_recordings()
words = shot("1-during-recording", read=True)
in_progress = rclib.find_phrase(words, "Recording in progress")
results.add(
    "Settings lists the recording as in progress",
    bool(in_progress),
    f"\"Recording in progress\" at {in_progress}" if in_progress else rclib.ocr_text(words)[-400:],
)
projects = rclib.find_projects(recordings)
project = projects[0] if projects else None
before = listing(project) if project else []
results.add("the recording's folder exists while recording", bool(before), f"{len(before)} files")

point = press(DELETE)
time.sleep(2)
shot("2-during-recording-after-delete-click")
opened = dialogs()
results.add(
    "Delete during the recording opens no confirmation",
    not opened,
    f"clicked {point}; dialogs: {[entry['title'] for entry in opened]}",
)
for entry in opened:
    winui.user32.PostMessageW(entry["hwnd"], 0x0010, 0, 0)
time.sleep(1)
text = app.text()
after_click = listing(project) if project else []
results.add(
    "the recording's files stay",
    set(before) <= set(after_click) and "deleted a recording" not in text,
    f"{len(before)} files before the click, {len(after_click)} after, none missing: {set(before) <= set(after_click)}",
)
results.add("the recording is still running", "recording finished" not in text and app.alive())

finished = app.wait_log(r"recording finished", RECORD_SECONDS + 120)
results.add("recording finished", bool(finished))
time.sleep(6)
status = "missing"
if project:
    try:
        status = rclib.meta_status(rclib.read_meta(project))
    except Exception as error:
        status = repr(error)
results.add("the recording finalized", status.startswith("Complete"), f"status={status}")
editor = app_window("editor")
results.note("editor window after the stop", editor["title"] if editor else "none")
if variant == "editor-closed" and editor:
    winui.user32.PostMessageW(editor["hwnd"], 0x0010, 0, 0)
    time.sleep(4)
    results.add("the editor was closed before Delete", app_window("editor") is None)
finalized = listing(project) if project else []
reload_recordings()
shot("3-after-finalize")

point = press(DELETE)
time.sleep(2)
shot("4-after-finalize-delete-click")
opened = dialogs()
results.add(
    "Delete after finalize asks for confirmation",
    bool(opened),
    f"clicked {point}; dialogs: {[entry['title'] for entry in opened]}",
)
if opened:
    winui.user32.SetForegroundWindow(opened[0]["hwnd"])
    time.sleep(0.4)
    winui.user32.keybd_event(0x0D, 0, 0, 0)
    winui.user32.keybd_event(0x0D, 0, 2, 0)
deleted = app.wait_log(r"deleted a recording", 20)
time.sleep(1)
shot("5-after-delete")
left = listing(project) if project and os.path.exists(project) else []
results.add(
    "Delete after finalize removes the recording",
    bool(deleted) and not os.path.exists(project),
    f"log line: {bool(deleted)}; folder exists: {os.path.exists(project)}; "
    f"{len(finalized)} files before, {len(left)} left"
    + (f"; gone: {sorted(set(finalized) - set(left))}; left: {left}" if left else ""),
)
failures = rclib.grep(app.text(), r"deleting the recording failed")
results.note("delete errors in the log", " / ".join(line[-230:] for line in failures[:3]) or "none")
results.add("no panic", "panicked at" not in app.text() and app.alive())
app.stop()
sys.exit(results.finish())
