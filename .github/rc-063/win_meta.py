"""Item 1 (#3975), Windows: Studio recordings in the real app save their
metadata at an ordinary path, when the staged save passes MAX_PATH, when the
recordings folder itself passes MAX_PATH, and while another process holds the
metadata file without FILE_SHARE_DELETE during the stop.

Usage: win_meta.py <package> <out-dir>"""

import ctypes
import os
import sys
import threading
import time

import rclib
from rclib import App, Results, log

package, out = sys.argv[1], os.path.abspath(sys.argv[2])
results = Results(out, "Item 1: recording metadata save on Windows (#3975)")
RECORD_SECONDS = 8
FAILURE_LINES = r"meta save failed|metadata save failed|failed to stop cleanly"


def padded_dir(base, length):
    """A directory under `base` whose full path is exactly `length` chars."""
    path = base
    while len(path) + 2 <= length:
        room = length - len(path) - 1
        part = min(room, 100)
        if room - part == 1:
            part -= 1
        path = os.path.join(path, "p" * part)
    os.makedirs(rclib.long_path(path), exist_ok=True)
    return path


def hold_meta_during_stop(app, recordings, state):
    """Opens recording-meta.json with FILE_SHARE_READ only once the stop is
    requested, and lets go one second after the save's temporary file shows
    up beside it, which is when the rename is being refused."""
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateFileW.restype = ctypes.c_void_p
    kernel32.CreateFileW.argtypes = [
        ctypes.c_wchar_p,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_void_p,
    ]
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    deadline = time.time() + 120
    while time.time() < deadline and "auto-record stop requested" not in app.text():
        time.sleep(0.01)
    projects = rclib.find_projects(recordings)
    if not projects:
        state["error"] = "no project folder when the stop was requested"
        return
    project = projects[0]
    meta = os.path.join(project, "recording-meta.json")
    handle = kernel32.CreateFileW(meta, 0x80000000, 0x00000001, None, 3, 0x80, None)
    if handle in (None, ctypes.c_void_p(-1).value):
        state["error"] = f"could not open the metadata file: error {ctypes.GetLastError()}"
        return
    state["held_at"] = time.time()
    seen = None
    deadline = time.time() + 20
    while time.time() < deadline:
        temporary = [
            name
            for name in os.listdir(project)
            if name.startswith(".recording-meta-") and name.endswith(".json.tmp")
        ]
        if temporary:
            seen = time.time()
            state["temporary"] = temporary[0]
            break
        time.sleep(0.005)
    if seen is not None:
        time.sleep(1.0)
    kernel32.CloseHandle(handle)
    state["released_at"] = time.time()
    state["temporary_seen_at"] = seen


def record(name, recordings, hold=False):
    profile = rclib.make_profile(os.path.join(out, name))
    os.makedirs(rclib.long_path(recordings), exist_ok=True)
    app = App(
        package,
        profile,
        recordings,
        {"CAP_GPUI_AUTO_RECORD": f"studio:{RECORD_SECONDS}"},
        name,
    )
    state = {}
    holder = None
    if hold:
        holder = threading.Thread(target=hold_meta_during_stop, args=(app, recordings, state))
        holder.start()
    started = app.wait_log(r"recording started", 90)
    if not started:
        # Whatever the app says instead of recording is on its main window.
        rclib.screenshot(os.path.join(out, f"{name}-did-not-start.png"))
    finished = app.wait_log(r"recording finished", 150) if started else None
    time.sleep(3)
    alive = app.alive()
    app.stop()
    if holder:
        holder.join(30)
    text = app.text()
    projects = rclib.find_projects(recordings)
    project = projects[0] if projects else None
    results.add(f"{name}: recording started and finished", bool(started and finished and alive))
    if not project:
        results.add(f"{name}: project folder exists", False, f"nothing in a recordings folder of {len(recordings)} characters")
        log(text[-4000:])
        return None, state
    plain_project = project[4:] if project.startswith("\\\\?\\") else project
    meta_path = os.path.join(plain_project, "recording-meta.json")
    try:
        meta = rclib.read_meta(project)
        status = rclib.meta_status(meta)
        results.add(
            f"{name}: recording-meta.json saved as Complete",
            status in ("Complete", "Complete (no status key)"),
            f"status={status} path_len={len(meta_path)}",
        )
    except Exception as error:
        results.add(f"{name}: recording-meta.json saved as Complete", False, repr(error))
    listing = rclib.tree(project)
    with open(os.path.join(out, f"{name}.tree.txt"), "w", encoding="utf-8") as handle:
        handle.write(f"{plain_project}\n{listing}\n")
    results.add(
        f"{name}: display.mp4 published",
        "display.mp4" in listing,
        "" if "display.mp4" in listing else listing[-600:],
    )
    workspaces = [
        entry for entry in os.listdir(project) if entry.startswith(".recovery-")
    ]
    workspace = workspaces[0] if workspaces else ".recovery-" + "0" * 36
    staged_temporary = os.path.join(
        plain_project, workspace, "staged", ".recording-meta-000000.json.tmp"
    )
    results.note(
        f"{name}: path lengths",
        f"recordings={len(recordings)} project={len(plain_project)} meta={len(meta_path)} "
        f"staged temporary={len(staged_temporary)} (workspace {'found' if workspaces else 'assumed'})",
    )
    failures = rclib.grep(text, FAILURE_LINES)
    results.add(
        f"{name}: log has no meta save failure",
        not failures,
        " / ".join(line[-200:] for line in failures[:3]),
    )
    leftovers = [line for line in listing.splitlines() if ".recording-meta-" in line]
    results.add(f"{name}: no temporary metadata left", not leftovers, " / ".join(leftovers[:3]))
    return {"project": plain_project, "staged_temporary": len(staged_temporary), "text": text}, state


try:
    import winreg

    with winreg.OpenKey(
        winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\FileSystem"
    ) as key:
        results.note("LongPathsEnabled registry value", str(winreg.QueryValueEx(key, "LongPathsEnabled")[0]))
except OSError as error:
    results.note("LongPathsEnabled registry value", repr(error))

base = os.environ.get("RC_REC_BASE") or out + "-rec"
plain, _ = record("plain", os.path.join(base, "plain"))
folder_name = len(os.path.basename(plain["project"])) if plain else 48

# The project stays under MAX_PATH and only the save inside
# `.recovery-<uuid>\staged` passes it, as with a long recording name.
target_project = 196
staged_dir = padded_dir(base, target_project - 1 - folder_name)
staged, _ = record("long-staged", staged_dir)
if staged:
    results.add(
        "long-staged: project under 260 and staged temporary over 260",
        len(staged["project"]) + 20 < 260 and staged["staged_temporary"] > 260,
        f"project={len(staged['project'])} staged temporary={staged['staged_temporary']}",
    )

# The recordings folder is under MAX_PATH and the project folder, with the
# metadata file itself, is past it.
project_dir = padded_dir(base, 232)
long_project, _ = record("long-project", project_dir)
if long_project:
    results.add(
        "long-project: recordings folder under 260 and metadata file over 260",
        len(project_dir) < 260 and len(long_project["project"]) + 20 > 260,
        f"recordings={len(project_dir)} project={len(long_project['project'])}",
    )

root_dir = padded_dir(base, 272)
rooted, _ = record("long-root", root_dir)
if rooted:
    results.add(
        "long-root: recordings folder over 260",
        len(root_dir) > 260,
        f"recordings={len(root_dir)} project={len(rooted['project'])}",
    )

blocked, state = record("blocked", os.path.join(base, "blocked"), hold=True)
if blocked:
    lines = rclib.grep(blocked["text"], r"metadata replace was blocked by another handle")
    held = state.get("temporary_seen_at") is not None
    results.add(
        "blocked: another process held the metadata file during the stop save",
        held,
        state.get("error")
        or (
            f"held {state['released_at'] - state['held_at']:.2f}s, temporary {state.get('temporary')} "
            f"seen {state['temporary_seen_at'] - state['held_at']:.2f}s after the hold began"
            if held
            else "the save never produced a temporary file while the file was held"
        ),
    )
    results.add(
        "blocked: the app retried the refused rename and succeeded",
        any("succeeded=true" in line for line in lines),
        " / ".join(line[-260:] for line in lines[:2]) or "no retry line in the log",
    )

sys.exit(results.finish())
