"""Item 3 (#3971), Windows: editor playback of a long recording when the
playback audio buffer cannot be allocated. The app runs inside a Job Object
whose per-process memory limit is set, once the editor has loaded, to what
the process has committed plus a margin smaller than the buffer, so the
allocator itself refuses the buffer. The same recording is played first
without a limit as the control.

Usage: win_audio.py <package> <out-dir> <fixture-dir>"""

import ctypes
import ctypes.wintypes as wt
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import time
import wave

import rclib
from rclib import App, Results, log

package, out, fixture = sys.argv[1], os.path.abspath(sys.argv[2]), os.path.abspath(sys.argv[3])
results = Results(out, "Item 3: playback when the audio buffer cannot be allocated (#3971)")
RECORD_SECONDS = int(os.environ.get("RC_AUDIO_SECONDS", "660"))
MARGIN = int(os.environ.get("RC_AUDIO_MARGIN_MB", "215")) * 1024 * 1024
SCRIPT = "wait:30000,play,wait:25000,stop,wait:3000"

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
psapi = ctypes.WinDLL("psapi", use_last_error=True)
kernel32.CreateJobObjectW.restype = wt.HANDLE
kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wt.LPCWSTR]
kernel32.AssignProcessToJobObject.argtypes = [wt.HANDLE, wt.HANDLE]
kernel32.SetInformationJobObject.argtypes = [wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD]
kernel32.QueryInformationJobObject.argtypes = [
    wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD, ctypes.c_void_p,
]
psapi.GetProcessMemoryInfo.argtypes = [wt.HANDLE, ctypes.c_void_p, wt.DWORD]


class BasicLimit(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wt.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wt.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wt.DWORD),
        ("SchedulingClass", wt.DWORD),
    ]


class ExtendedLimit(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", BasicLimit),
        ("IoInfo", ctypes.c_ulonglong * 6),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class MemoryCounters(ctypes.Structure):
    _fields_ = [
        ("cb", wt.DWORD),
        ("PageFaultCount", wt.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
        ("PrivateUsage", ctypes.c_size_t),
    ]


def committed(process):
    counters = MemoryCounters()
    counters.cb = ctypes.sizeof(counters)
    if not psapi.GetProcessMemoryInfo(int(process._handle), ctypes.byref(counters), counters.cb):
        raise ctypes.WinError(ctypes.get_last_error())
    return counters.PrivateUsage


def mb(value):
    return f"{value / (1024 * 1024):.0f} MB"


def endpoints():
    command = (
        "Get-CimInstance Win32_SoundDevice | ForEach-Object { $_.Name + ' [' + $_.Status + ']' }; "
        "Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue | "
        "ForEach-Object { 'endpoint: ' + $_.FriendlyName + ' [' + $_.Status + ']' }"
    )
    done = subprocess.run(["powershell", "-NoProfile", "-Command", command], capture_output=True, text=True)
    return [line.strip() for line in done.stdout.splitlines() if line.strip()]


def tone(path):
    rate = 48000
    with wave.open(path, "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(
            b"".join(
                struct.pack("<hh", sample, sample)
                for sample in (int(9000 * math.sin(2 * math.pi * 440 * n / rate)) for n in range(rate * 5))
            )
        )
    return path


def record():
    import winsound

    recordings = os.path.join(fixture, "rec")
    marker = os.path.join(fixture, "recorded.txt")
    existing = rclib.find_projects(recordings)
    if existing and os.path.exists(marker):
        results.note("recording", f"reused {os.path.basename(existing[0])}")
        return existing[0]
    if os.path.isdir(recordings):
        shutil.rmtree(recordings)
    os.makedirs(recordings, exist_ok=True)
    profile = rclib.make_profile(os.path.join(out, "record-profile"))
    wav = tone(os.path.join(out, "tone.wav"))
    try:
        winsound.PlaySound(wav, winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_LOOP)
        results.note("tone", "playing a 440 Hz tone on the default output for the recording")
    except RuntimeError as error:
        results.note("tone", f"could not play: {error}")
    app = App(
        package,
        profile,
        recordings,
        {"CAP_GPUI_AUTO_RECORD": f"studio:{RECORD_SECONDS}", "CAP_GPUI_AUTO_SYSTEM_AUDIO": "1"},
        "record",
    )
    started = app.wait_log(r"recording started", 120)
    results.add("the recording with system audio started", bool(started))
    finished = app.wait_log(r"recording finished", RECORD_SECONDS + 600) if started else None
    time.sleep(3)
    app.stop()
    try:
        winsound.PlaySound(None, 0)
    except RuntimeError:
        pass
    failure = rclib.grep(app.text(), r"recording failed to start|failed to stop cleanly")
    results.add(
        "the recording finished",
        bool(finished),
        " / ".join(line[-300:] for line in failure[:2]) if not finished else "",
    )
    projects = rclib.find_projects(recordings)
    if not (finished and projects):
        return None
    with open(marker, "w") as handle:
        handle.write(os.path.basename(projects[0]) + "\n")
    return projects[0]


def play(name, project, limited):
    profile = rclib.make_profile(os.path.join(out, f"{name}-profile"))
    app = App(
        package,
        profile,
        os.path.dirname(project),
        {"CAP_GPUI_AUTO_EDITOR": project, "CAP_GPUI_AUTO_TRANSCRIPT": SCRIPT},
        name,
    )
    job = None
    detail = {}
    if limited:
        job = kernel32.CreateJobObjectW(None, None)
        if not kernel32.AssignProcessToJobObject(job, int(app.process._handle)):
            results.add(f"{name}: the app runs inside a Job Object", False, str(ctypes.WinError(ctypes.get_last_error())))
            app.stop()
            return None
    ready = app.wait_log(r"editor waveforms ready", 180)
    ready_at = time.time()
    results.add(f"{name}: the editor opened the recording", bool(ready))
    if not ready:
        app.stop()
        return None
    time.sleep(8)
    before = committed(app.process)
    detail["committed_before_play"] = before
    if limited:
        info = ExtendedLimit()
        info.BasicLimitInformation.LimitFlags = 0x00000100
        info.ProcessMemoryLimit = before + MARGIN
        ok = kernel32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))
        limit_at = time.time()
        detail["limit"] = before + MARGIN
        results.add(
            f"{name}: per-process memory limit set before play",
            bool(ok) and "transcript-auto: wait:30000" not in app.text(),
            f"committed {mb(before)}, limit {mb(before + MARGIN)}, {limit_at - ready_at:.0f}s after the editor loaded",
        )
    playing = app.wait_log(r"transcript-auto: play ", 120)
    results.add(f"{name}: play was pressed", bool(playing))
    peak = before
    shots = 0
    deadline = time.time() + 90
    while time.time() < deadline and app.alive() and "transcript-auto: stop " not in app.text():
        try:
            peak = max(peak, committed(app.process))
        except OSError:
            break
        if shots < 3:
            rclib.screenshot(os.path.join(out, f"{name}-playing-{shots}.png"))
            shots += 1
            time.sleep(6)
        time.sleep(1)
    time.sleep(4)
    alive = app.alive()
    detail["peak_committed"] = peak
    if job:
        info = ExtendedLimit()
        if kernel32.QueryInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info), None):
            detail["job_peak"] = info.PeakProcessMemoryUsed
    code = app.stop()
    text = app.text()
    # The app sends its own stderr, where an allocation failure aborts, to a
    # file in its log folder.
    logs = os.path.join(profile, "logs")
    for name in sorted(os.listdir(logs)) if os.path.isdir(logs) else []:
        if name.endswith(".stderr"):
            with open(os.path.join(logs, name), "rb") as handle:
                text += "\n" + handle.read().decode("utf-8", "replace")
    detail.update(text=text, alive=alive, code=code)
    with open(os.path.join(out, f"{name}.audio.log"), "w", encoding="utf-8") as handle:
        handle.write(
            "\n".join(
                rclib.grep(
                    text,
                    r"audio|Playback stats|memory allocation|panicked|transcript-auto|output device",
                )
            )
        )
    return detail


def stats(text):
    return [int(value) for value in re.findall(r"total_rendered=(\d+)", text)]


found = endpoints()
results.note("audio devices", "; ".join(found) or "none")
project = record()
if not project:
    results.add("a long recording exists", False)
    sys.exit(results.finish())
listing = rclib.tree(project)
with open(os.path.join(out, "project.tree.txt"), "w", encoding="utf-8") as handle:
    handle.write(listing + "\n")
has_audio = re.search(r"system_audio\.|audio-input\.", listing) is not None
results.add("the recording has an audio track", has_audio, "" if has_audio else listing[-800:])
buffer_bytes = (int(RECORD_SECONDS * 48000) * 2 + 10000) * 4
results.note(
    "expected playback buffer",
    f"about {mb(buffer_bytes)} for {RECORD_SECONDS}s of stereo 48 kHz; margin given to the app {mb(MARGIN)}",
)

control = play("control", project, limited=False)
if control:
    text = control["text"]
    results.add(
        "control: without a limit the full playback buffer is used",
        "Starting progressive audio pre-render" in text and "Could not allocate the playback audio buffer" not in text,
        " / ".join(line[-220:] for line in rclib.grep(text, r"progressive audio|streaming audio|output device|No audio segments")[:3]),
    )
    rendered = stats(text)
    results.add("control: playback rendered frames", bool(rendered) and rendered[-1] > 60, f"total_rendered {rendered}")
    results.note(
        "control: memory",
        f"committed before play {mb(control['committed_before_play'])}, peak while playing {mb(control['peak_committed'])}",
    )

limited = play("limited", project, limited=True)
if limited:
    text = limited["text"]
    refused = rclib.grep(text, r"Could not allocate the playback audio buffer")
    results.add(
        "limited: the playback buffer allocation was refused and the app fell back to streaming audio",
        bool(refused),
        " / ".join(line[-260:] for line in refused[:2]) or "no fallback line in the log",
    )
    aborted = rclib.grep(text, r"memory allocation of \d+ bytes failed|panicked at")
    starved = len(rclib.grep(text, r"get_buffer\(\) failed"))
    results.add(
        "limited: no abort",
        not aborted and limited["alive"],
        (" / ".join(line[-200:] for line in aborted[:3]) or f"alive at the end: {limited['alive']}")
        + f"; video decoder buffer failures: {starved}; exit code {limited['code']}",
    )
    rendered = stats(text)
    results.add(
        "limited: playback continued after the fallback",
        len(rendered) >= 2 and rendered[-1] > rendered[0] and rendered[-1] > 60,
        f"total_rendered {rendered}",
    )
    results.note(
        "limited: memory",
        f"limit {mb(limited.get('limit', 0))}, committed before play {mb(limited['committed_before_play'])}, "
        f"peak while playing {mb(limited['peak_committed'])}, job peak {mb(limited.get('job_peak', 0))}",
    )

sys.exit(results.finish())
