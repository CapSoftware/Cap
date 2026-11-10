"""Item 2 (#3969), macOS: the main window's library card for the recording
in progress offers no Delete. A finished recording sits beside it as the
control. The main window is brought back during the recording through the
tray's Open Cap item, and the Recordings panel is closed and opened again
with real clicks so it lists the recording that is running.

Usage: mac_library.py <package> <out-dir>"""

import os
import sys
import time

import rclib
from rclib import App, Results

package, out = sys.argv[1], os.path.abspath(sys.argv[2])
results = Results(out, "Item 2: main window library card during a recording, macOS (#3969)")
# Cap keeps its own windows out of screen captures by default, which also
# hides them from the screenshots this scenario is judged by. The excluded
# windows list is a setting; it is emptied here so the main window can be seen.
profile = rclib.make_profile(os.path.join(out, "profile"), general={"excludedWindows": []})
recordings = os.path.join(out, "rec")
os.makedirs(recordings, exist_ok=True)
BACK = (838, 450)
RECORDINGS = (1058, 401)

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
        "CAP_GPUI_AUTO_RECORD": "studio:75",
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
shown = app.wait_log(r"tray item activated item=OpenCap", 60)
results.add("the main window was reopened during the recording", bool(shown))
time.sleep(5)
rclib.screenshot(os.path.join(out, "1-reopened.png"))
rclib.click(*BACK)
time.sleep(2)
rclib.screenshot(os.path.join(out, "2-after-back.png"))
rclib.click(*RECORDINGS)
time.sleep(4)
rclib.screenshot(os.path.join(out, "3-recordings-panel-during-recording.png"))
rclib.move(960, 300)
time.sleep(1)
rclib.screenshot(os.path.join(out, "4-recordings-panel-during-recording.png"))
results.add(
    "the screenshots were taken while still recording",
    "recording finished" not in app.text() and app.alive(),
    f"{time.time() - began:.0f}s into a 75s recording",
)
finished = app.wait_log(r"recording finished", 150)
results.add("recording finished", bool(finished))
time.sleep(4)
rclib.screenshot(os.path.join(out, "5-after-stop.png"))
results.add("no panic", "panicked at" not in app.text() and app.alive())
app.stop()

after = App(package, profile, recordings, {"CAP_GPUI_AUTO_PANEL": "recordings"}, "after")
after.wait_log(r"main window opened", 60)
time.sleep(8)
rclib.screenshot(os.path.join(out, "6-recordings-panel-after-finalize.png"))
after.stop()
projects = rclib.find_projects(recordings)
results.note("recordings on disk", ", ".join(os.path.basename(project) for project in projects))
results.note("verdict", "read off the screenshots: 3 and 4 during the recording, 6 after it finalized")
sys.exit(results.finish())
