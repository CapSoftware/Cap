"""Item 2 (#3969), macOS: the main window's library card for the recording
in progress offers no Delete. A finished recording sits beside it as the
control. The main window is brought back during the recording through the
tray's Open Cap item, with the Recordings panel open.

Usage: mac_library.py <package> <out-dir>"""

import os
import sys
import time

import rclib
from rclib import App, Results

package, out = sys.argv[1], os.path.abspath(sys.argv[2])
results = Results(out, "Item 2: main window library card during a recording, macOS (#3969)")
profile = rclib.make_profile(os.path.join(out, "profile"))
recordings = os.path.join(out, "rec")
os.makedirs(recordings, exist_ok=True)

seed = App(package, profile, recordings, {"CAP_GPUI_AUTO_RECORD": "studio:5"}, "seed")
seeded = seed.wait_log(r"recording finished", 120)
time.sleep(3)
seed.stop()
results.add("a finished recording exists as the control", bool(seeded), seed.text()[-1500:] if not seeded else "")

app = App(
    package,
    profile,
    recordings,
    {
        "CAP_GPUI_AUTO_RECORD": "studio:60",
        "CAP_GPUI_AUTO_PANEL": "recordings",
        "CAP_GPUI_AUTO_TRAY": "open_main",
        "CAP_GPUI_AUTO_TRAY_DELAY": "25000",
        "CAP_GPUI_NO_TRAY": "0",
    },
    "main",
)
started = app.wait_log(r"recording started", 90)
began = time.time()
results.add("recording started", bool(started), app.text()[-1500:] if not started else "")
index = 0
while app.alive() and "recording finished" not in app.text() and time.time() - began < 180:
    rclib.screenshot(os.path.join(out, f"during-{index:02d}-{time.time() - began:04.0f}s.png"))
    index += 1
    time.sleep(5)
finished = "recording finished" in app.text()
results.add("recording finished", finished)
for index in range(3):
    time.sleep(3)
    rclib.screenshot(os.path.join(out, f"after-{index:02d}.png"))
projects = rclib.find_projects(recordings)
results.note("recordings on disk", ", ".join(os.path.basename(project) for project in projects))
results.add("no panic", "panicked at" not in app.text() and app.alive())
app.stop()
sys.exit(results.finish())
