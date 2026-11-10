"""Item 2 (#3969), Windows: with Settings > Recordings open during a Studio
recording, Delete on the recording in progress does nothing and its files
stay; once the recording has stopped and finalized, the same Delete removes it.

Usage: win_delete.py <package> <out-dir>
RC_DELETE_OFFSET=dx,dy is the Delete button of the first row, relative to the
Settings window's top left corner. Without it the run only takes screenshots."""

import os
import sys
import time

import rclib
import winui
from rclib import App, Results, log

package, out = sys.argv[1], os.path.abspath(sys.argv[2])
results = Results(out, "Item 2: deleting the recording in progress on Windows (#3969)")
offset = os.environ.get("RC_DELETE_OFFSET", "").strip()
offset = tuple(int(part) for part in offset.split(",")) if offset else None
RECORD_SECONDS = 40

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


def settings_window():
    candidates = [
        entry
        for entry in winui.windows(app.process.pid)
        if entry["visible"] and not entry["minimized"] and "settings" in entry["title"].lower()
    ]
    return candidates[0] if candidates else None


def dialogs():
    return [
        entry
        for entry in winui.windows(app.process.pid)
        if entry["visible"] and entry["class"] == "#32770"
    ]


def files(project):
    return sum(len(names) for _, _, names in os.walk(project))


def shot(name):
    path = rclib.screenshot(os.path.join(out, f"{name}.png"))
    with open(os.path.join(out, f"{name}.windows.txt"), "w", encoding="utf-8") as handle:
        handle.write(winui.describe(winui.windows(app.process.pid)))
    return path


def press_delete():
    window = settings_window()
    if not window:
        return None
    winui.raise_window(window["hwnd"])
    time.sleep(0.6)
    left, top, _, _ = winui.rect(window["hwnd"])
    rclib.click(left + offset[0], top + offset[1])
    time.sleep(2)
    return (left + offset[0], top + offset[1])


started = app.wait_log(r"recording started", 90)
results.add("recording started", bool(started))
time.sleep(8)
log(winui.describe(winui.windows(app.process.pid)))
window = settings_window()
results.add("Settings window is open during the recording", bool(window), str(window))
if window:
    winui.place(window["hwnd"], 40, 40)
    winui.raise_window(window["hwnd"])
    time.sleep(1.5)
shot("1-during-recording")
projects = rclib.find_projects(recordings)
project = projects[0] if projects else None
before = files(project) if project else 0
results.add("the recording's folder exists while recording", before > 0, f"{before} files")

if offset and window:
    point = press_delete()
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
    after_click = files(project) if project else 0
    results.add(
        "the recording's files stay",
        after_click >= before and "deleted a recording" not in text,
        f"{before} files before the click, {after_click} after",
    )
    results.add("the recording is still running", "recording finished" not in text and app.alive())

finished = app.wait_log(r"recording finished", RECORD_SECONDS + 120)
results.add("recording finished", bool(finished))
time.sleep(5)
status = "missing"
if project:
    try:
        status = rclib.meta_status(rclib.read_meta(project))
    except Exception as error:
        status = repr(error)
results.add("the recording finalized", status.startswith("Complete"), f"status={status}")
window = settings_window()
if window:
    winui.raise_window(window["hwnd"])
    time.sleep(1.5)
shot("3-after-finalize")

if offset and window:
    point = press_delete()
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
    results.add(
        "Delete after finalize removes the recording",
        bool(deleted) and not os.path.exists(project),
        f"log line: {bool(deleted)}, folder exists: {os.path.exists(project)}",
    )
else:
    results.note("clicks", "no RC_DELETE_OFFSET: screenshots only")

refusals = rclib.grep(app.text(), r"deleting the recording failed|Finish or cancel the recording")
results.note("delete refusals in the log", " / ".join(line[-200:] for line in refusals[:3]) or "none")
results.add("no panic", "panicked at" not in app.text() and app.alive())
app.stop()
sys.exit(results.finish())
