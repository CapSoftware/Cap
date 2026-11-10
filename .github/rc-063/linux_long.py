"""Item 4 (#3974), Linux on Xvfb: the real app records a window showing a
running seconds counter for longer than 33 minutes (more than 1000 two-second
fragments), and the editor then opens that recording, seeks past the
33 minute mark and plays. Each frame shows the counter, so a screenshot of
the editor says which moment of the recording is on screen.

Usage: linux_long.py <package> <out-dir> <short|long|open> [seconds]"""

import json
import os
import re
import shutil
import subprocess
import sys
import time

import rclib
from rclib import App, Results, log

package, out, phase = sys.argv[1], os.path.abspath(sys.argv[2]), sys.argv[3]
seconds = int(sys.argv[4]) if len(sys.argv) > 4 else (30 if phase == "short" else 3200)
results = Results(out, f"Item 4: recording past 1000 fragments in the editor (#3974), {phase}")
TITLE = "rc063 counter"
COUNTER = re.compile(r"(?<!\d)(\d{4})[.,](\d)(?!\d)")
state_path = os.path.join(out, "state.json")


def start_counter():
    started = time.time()
    script = (
        "import sys,time\ns=%r\nwhile True:\n"
        "    sys.stdout.write('\\r  %%06.1f  ' %% (time.time()-s)); sys.stdout.flush(); time.sleep(0.05)\n"
    ) % started
    path = os.path.join(out, "counter.py")
    with open(path, "w") as handle:
        handle.write(script)
    process = subprocess.Popen(
        [
            "xterm", "-T", TITLE, "-geometry", "12x1+200+120", "-fa", "DejaVu Sans Mono", "-fs", "56",
            "-bg", "white", "-fg", "black", "+sb", "-e", sys.executable, path,
        ]
    )
    time.sleep(3)
    return process, started


PREVIEW = (10, 120, 845, 500)


def read_counter(path):
    """The counter shown in the editor's preview, read at three sizes; a value
    counts only when two of the three readings agree."""
    from PIL import Image, ImageOps

    preview = Image.open(path).convert("L").crop(PREVIEW)
    seen = {}
    for scale in (0.5, 0.33, 0.25):
        sized = preview.resize((int(preview.width * scale), int(preview.height * scale)), Image.LANCZOS)
        sized = ImageOps.expand(sized, border=20, fill=255)
        scaled = f"{path}.{scale}.ocr.png"
        sized.save(scaled)
        done = subprocess.run(
            ["tesseract", scaled, "stdout", "--psm", "7", "-c", "tessedit_char_whitelist=0123456789."],
            capture_output=True,
        )
        os.remove(scaled)
        match = COUNTER.search(done.stdout.decode("utf-8", "replace").replace(" ", ""))
        if match:
            value = float(f"{match.group(1)}.{match.group(2)}")
            seen[value] = seen.get(value, 0) + 1
    agreed = [value for value, count in seen.items() if count >= 2]
    return agreed[0] if agreed else None


def segment_listing(project):
    lines = []
    for base, _, files in os.walk(project):
        fragments = [name for name in files if name.endswith(".m4s")]
        if fragments:
            indexes = sorted(int(re.search(r"_(\d+)\.m4s$", name).group(1)) for name in fragments)
            lines.append(
                f"{os.path.relpath(base, project)}: {len(fragments)} fragments, {indexes[0]}..{indexes[-1]}"
            )
    return lines


def record():
    counter, counter_started = start_counter()
    profile = rclib.make_profile(os.path.join(out, "record-profile"))
    recordings = os.path.join(out, "rec")
    os.makedirs(recordings, exist_ok=True)
    app = App(
        package,
        profile,
        recordings,
        {
            "CAP_GPUI_AUTO_RECORD": f"studio:{seconds}",
            "CAP_GPUI_AUTO_OVERLAY": "window",
            "CAP_GPUI_AUTO_WINDOW": TITLE,
        },
        "record",
    )
    started = app.wait_log(r"recording started", 90)
    recording_started = time.time()
    results.add("recording started", bool(started), app.text()[-1500:] if not started else "")
    if not started:
        app.stop()
        counter.kill()
        return None
    offset = recording_started - counter_started
    rclib.screenshot(os.path.join(out, "record-start.png"))
    crash_copy = os.path.join(out, "crash-state.cap")
    copied = False
    copied_at = 0
    deadline = recording_started + seconds + 600
    last_report = 0
    while time.time() < deadline:
        elapsed = time.time() - recording_started
        if "recording finished" in app.text() or not app.alive():
            break
        if not copied and elapsed > seconds - 20:
            projects = rclib.find_projects(recordings)
            if projects:
                shutil.copytree(projects[0], crash_copy, dirs_exist_ok=True)
                copied = True
                copied_at = elapsed
                with open(os.path.join(out, "crash-state.fragments.txt"), "w") as handle:
                    handle.write("\n".join(segment_listing(crash_copy)) + "\n")
                log("copied the recording as it is on disk while still recording")
        if elapsed - last_report > 300:
            last_report = elapsed
            projects = rclib.find_projects(recordings)
            log(f"recording {elapsed:.0f}s: {segment_listing(projects[0]) if projects else 'no project'}")
        time.sleep(1)
    finished = "recording finished" in app.text()
    results.add("recording finished", finished and app.alive(), app.text()[-2500:] if not finished else "")
    for index in range(10):
        time.sleep(2)
        rclib.screenshot(os.path.join(out, f"after-stop-{index:02d}.png"))
    text = app.text()
    app.stop()
    counter.kill()
    projects = rclib.find_projects(recordings)
    project = projects[0] if projects else None
    if project:
        with open(os.path.join(out, "project.tree.txt"), "w") as handle:
            handle.write(rclib.tree(project, 120) + "\n")
        meta = rclib.read_meta(project)
        with open(os.path.join(out, "recording-meta.json"), "w") as handle:
            json.dump(meta, handle, indent=1)
        results.note("meta status after stop", rclib.meta_status(meta))
    most = 0
    if copied:
        listing = segment_listing(crash_copy)
        most = max((int(re.search(r": (\d+) fragments", line).group(1)) for line in listing), default=0)
        results.add(
            "the recording wrote more than 1000 fragments" if phase == "long" else "the recording wrote fragments",
            most > 1000 if phase == "long" else most > 0,
            "; ".join(listing),
        )
    interesting = rclib.grep(text, r"segmented|preparing|remux|finaliz|editor opened|open_editor|panicked")
    with open(os.path.join(out, "record.interesting.log"), "w") as handle:
        handle.write("\n".join(interesting) + "\n")
    state = {
        "project": project,
        "offset": offset,
        "seconds": seconds,
        "crash_copy": crash_copy if copied else None,
        "fragments": most,
        "copied_at": copied_at,
    }
    with open(state_path, "w") as handle:
        json.dump(state, handle)
    results.note("recording offset", f"the counter read {offset:.1f}s when the recording started")
    return state


def open_in_editor(name, project, offset, seek_to, second_seek, expect_recovery=False):
    """Seeks, plays, stops and seeks again in the editor, reading the counter
    off the screen at each step."""
    profile = rclib.make_profile(os.path.join(out, f"{name}-profile"))
    recordings = os.path.dirname(project)
    script = f"wait:6000,seek:{seek_to},wait:9000,play,wait:14000,stop,wait:4000,seek:{second_seek},wait:9000"
    app = App(
        package,
        profile,
        recordings,
        {"CAP_GPUI_AUTO_EDITOR": project, "CAP_GPUI_AUTO_TRANSCRIPT": script},
        name,
    )
    marks = {}
    shots = []
    deadline = time.time() + 400
    while time.time() < deadline and app.alive():
        text = app.text()
        for action in (f"seek:{seek_to}", "play", "stop", f"seek:{second_seek}", "wait:9000"):
            for match in re.finditer(rf"transcript-auto: {re.escape(action)} ", text):
                marks.setdefault((action, match.start()), time.time())
        path = os.path.join(out, f"{name}-{len(shots):03d}.png")
        rclib.screenshot(path)
        shots.append((time.time(), path))
        waits = [key for key in marks if key[0] == "wait:9000"]
        if len(waits) >= 2 and time.time() - max(marks[key] for key in waits) > 2:
            break
        time.sleep(1.0)
    text = app.text()
    alive = app.alive()
    app.stop()
    with open(os.path.join(out, f"{name}.interesting.log"), "w") as handle:
        handle.write("\n".join(rclib.grep(text, r"segmented|recover|remux|transcript-auto|panicked|error")) + "\n")
    results.add(f"{name}: the editor stayed up", alive and "panicked at" not in text)

    def when(action, which=0):
        times = sorted(value for key, value in marks.items() if key[0] == action)
        return times[which] if len(times) > which else None

    seek_at, play_at, stop_at, seek2_at = when(f"seek:{seek_to}"), when("play"), when("stop"), when(f"seek:{second_seek}")
    results.add(
        f"{name}: the editor ran seek, play, stop, seek",
        None not in (seek_at, play_at, stop_at, seek2_at),
        f"marks: {sorted((key[0], round(value - shots[0][0], 1)) for key, value in marks.items())}",
    )
    if None in (seek_at, play_at, stop_at, seek2_at):
        log(text[-3000:])
        return
    readings = []
    for taken, path in shots:
        if taken < seek_at + 1:
            continue
        value = read_counter(path)
        readings.append((taken, value, path))
        log(f"{os.path.basename(path)} t={taken - seek_at:+.1f}s counter={value}")
    with open(os.path.join(out, f"{name}.readings.txt"), "w") as handle:
        for taken, value, path in readings:
            handle.write(f"{taken - seek_at:+7.1f}s {value} {os.path.basename(path)}\n")

    def reading(start, end):
        return [value for taken, value, _ in readings if start <= taken <= end and value is not None]

    after_seek = reading(seek_at + 4, play_at - 0.5)
    expected = seek_to + offset
    results.add(
        f"{name}: seeking to {seek_to}s shows that moment of the recording",
        bool(after_seek) and abs(after_seek[-1] - expected) <= 4,
        f"counter on screen {after_seek[-3:]}, expected about {expected:.1f}",
    )
    playing = reading(play_at + 1, stop_at + 0.5)
    advancing = [b - a for a, b in zip(playing, playing[1:])]
    results.add(
        f"{name}: playback from {seek_to}s shows advancing frames",
        len(playing) >= 4 and playing[-1] - playing[0] >= 5 and all(step >= 0 for step in advancing),
        f"counter on screen while playing {playing}",
    )
    after_second = reading(seek2_at + 4, seek2_at + 60)
    expected = second_seek + offset
    results.add(
        f"{name}: seeking to {second_seek}s shows that moment of the recording",
        bool(after_second) and abs(after_second[-1] - expected) <= 4,
        f"counter on screen {after_second[-3:]}, expected about {expected:.1f}",
    )
    recovered = rclib.grep(text, r"recovering an interrupted recording|Concatenating \d+ M4S")
    results.note(f"{name}: recovery before editing", " / ".join(line[-160:] for line in recovered[:2]) or "none")
    meta = rclib.read_meta(project)
    display = meta["segments"][0]["display"]["path"]
    kind = "directory of fragments" if os.path.isdir(os.path.join(project, display)) else "file"
    results.note(f"{name}: display track the editor opened", f"{display} ({kind}); status {rclib.meta_status(meta)}")
    return bool(recovered), kind


def copy_of_interrupted(state, name):
    directory = os.path.join(out, f"{name}-rec")
    target = os.path.join(directory, os.path.basename(state["project"]))
    if os.path.exists(target):
        shutil.rmtree(target)
    os.makedirs(directory, exist_ok=True)
    shutil.copytree(state["crash_copy"], target)
    return target


if phase in ("short", "long"):
    state = record()
else:
    with open(state_path) as handle:
        state = json.load(handle)

if state and state["project"]:
    recorded = state["seconds"]
    fragments = state.get("fragments") or 0
    per_fragment = state["copied_at"] / fragments if fragments else 3.0
    if fragments > 1030:
        # Fragment 1001 is the first one a name sort misplaces; land inside
        # fragments 1010 and 1025, and also right after the 33 minute mark.
        past_1000, later = int(1010 * per_fragment), int(1025 * per_fragment)
    else:
        span = state["copied_at"] or recorded
        past_1000, later = max(int(span * 0.3), 2), max(int(span * 0.6), 3)
    results.note(
        "fragments",
        f"{fragments} on disk {state['copied_at']:.0f}s into the recording, {per_fragment:.2f}s each; "
        f"seeking to {past_1000}s (fragment {past_1000 / per_fragment + 1:.0f}) and {later}s (fragment {later / per_fragment + 1:.0f})",
    )
    if phase != "short" and recorded > 2100:
        open_in_editor("finalized-33min", state["project"], state["offset"], 2040, 2100)
    open_in_editor("finalized", state["project"], state["offset"], past_1000, later)
    if state.get("crash_copy"):
        # The recording as it was on disk while still recording, which is what
        # a crash or a power cut leaves: the editor recovers it first.
        open_in_editor("interrupted", copy_of_interrupted(state, "interrupted"), state["offset"], past_1000, later)
        # The same fragments with metadata written by this harness: the
        # finalized recording's metadata with its display track pointed back
        # at the fragment directory. The app's own stop and recovery both
        # remux before the editor opens, so this is the only way to make the
        # editor list the fragments by name, the state GitHub #3961 reports
        # and the code #3974 changed.
        target = copy_of_interrupted(state, "fragments")
        meta = rclib.read_meta(state["project"])
        display = meta["segments"][0]["display"]
        display["path"] = display["path"].removesuffix(".mp4")
        for key in ("cursor", "keyboard"):
            relative = meta["segments"][0].get(key)
            if relative and not os.path.exists(os.path.join(target, relative)):
                source = os.path.join(state["project"], relative)
                if os.path.exists(source):
                    shutil.copy(source, os.path.join(target, relative))
        with open(os.path.join(target, "recording-meta.json"), "w") as handle:
            json.dump(meta, handle)
        listing = segment_listing(target)
        results.note("fragments: display track handed to the editor", f"{display['path']}: {'; '.join(listing)}")
        outcome = open_in_editor("fragments", target, state["offset"], past_1000, later)
        if outcome:
            results.add(
                "fragments: the editor read the fragment directory, with no remux first",
                not outcome[0] and outcome[1] == "directory of fragments",
                f"recovery ran: {outcome[0]}, display track is a {outcome[1]}",
            )

sys.exit(results.finish())
