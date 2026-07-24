#!/usr/bin/env python3

import atexit
import argparse
import csv
import ctypes
import json
import platform
import re
import statistics
import subprocess
import sys
import time
import urllib.parse
from datetime import datetime
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RECORDINGS_DIR = (
	Path.home()
	/ "Library"
	/ "Application Support"
	/ "so.cap.desktop.dev"
	/ "recordings"
)
NUMERIC_COLUMNS = {
	"user_ns",
	"system_ns",
	"rss_bytes",
	"phys_footprint_bytes",
	"max_phys_footprint_bytes",
	"neural_footprint_bytes",
	"energy_nj",
	"disk_read_bytes",
	"disk_write_bytes",
	"logical_writes",
	"pageins",
	"idle_wakeups",
	"interrupt_wakeups",
	"instructions",
	"cycles",
	"runnable_ns",
	"threads",
	"context_switches",
	"mach_syscalls",
	"unix_syscalls",
	"faults",
}
DELTA_COLUMNS = {
	"energy_nj",
	"disk_read_bytes",
	"disk_write_bytes",
	"logical_writes",
	"pageins",
	"idle_wakeups",
	"interrupt_wakeups",
	"instructions",
	"cycles",
	"runnable_ns",
	"context_switches",
	"mach_syscalls",
	"unix_syscalls",
	"faults",
}


def run(command, check=True, timeout=30):
	result = subprocess.run(
		[str(part) for part in command],
		capture_output=True,
		text=True,
		timeout=timeout,
	)
	if check and result.returncode != 0:
		raise RuntimeError(
			f"Command failed ({result.returncode}): {' '.join(map(str, command))}\n"
			f"{result.stderr.strip()}"
		)
	return result


def capture_area(value):
	try:
		x, y, width, height = (float(part) for part in value.split(","))
	except ValueError as error:
		raise argparse.ArgumentTypeError(
			"--area must be x,y,width,height"
		) from error
	if width <= 0 or height <= 0:
		raise argparse.ArgumentTypeError("--area width and height must be positive")
	return {"x": x, "y": y, "width": width, "height": height}


def parse_args():
	parser = argparse.ArgumentParser(
		description="Profile the local macOS Instant Mode pipeline with real camera and microphone devices.",
		epilog=(
			"This starts and uploads real Instant recordings through the running "
			"development app. See scripts/instant-mode-performance.md."
		),
	)
	parser.add_argument("--label", default="baseline")
	parser.add_argument("--repetitions", type=int, default=3)
	parser.add_argument(
		"--idle-seconds",
		"--preview-seconds",
		dest="idle_seconds",
		type=float,
		default=10.0,
	)
	parser.add_argument("--start-seconds", type=float, default=6.0)
	parser.add_argument("--recording-seconds", type=float, default=30.0)
	parser.add_argument("--stop-seconds", type=float, default=8.0)
	parser.add_argument("--post-stop-seconds", type=float, default=10.0)
	parser.add_argument("--cooldown-seconds", type=float, default=5.0)
	parser.add_argument("--camera-warmup-seconds", type=float, default=8.0)
	parser.add_argument("--interval-ms", type=int, default=1000)
	parser.add_argument("--screen-name")
	capture_target = parser.add_mutually_exclusive_group()
	capture_target.add_argument("--window-name")
	capture_target.add_argument("--area", type=capture_area)
	parser.add_argument("--camera-id")
	parser.add_argument("--no-camera", action="store_true")
	parser.add_argument(
		"--camera-blur",
		choices=("off", "light", "heavy"),
	)
	parser.add_argument(
		"--expected-preview-format",
		choices=("RGBA", "NV12"),
		default="NV12",
	)
	parser.add_argument("--mic-name")
	parser.add_argument("--system-audio", action="store_true")
	parser.add_argument("--pause-seconds", type=float, default=0.0)
	parser.add_argument("--resume-seconds", type=float, default=5.0)
	parser.add_argument(
		"--cap-binary",
		type=Path,
		default=REPO_ROOT / "target" / "debug" / "cap",
	)
	parser.add_argument(
		"--recordings-dir",
		type=Path,
		default=DEFAULT_RECORDINGS_DIR,
	)
	parser.add_argument("--artifacts-dir", type=Path)
	parser.add_argument("--app-pid", type=int)
	parser.add_argument("--prepare-only", action="store_true")
	args = parser.parse_args()
	if args.repetitions < 1:
		parser.error("--repetitions must be at least 1")
	for name in (
		"idle_seconds",
		"start_seconds",
		"recording_seconds",
		"stop_seconds",
		"post_stop_seconds",
	):
		if getattr(args, name) < 2.0:
			parser.error(f"--{name.replace('_', '-')} must be at least 2 seconds")
	if args.interval_ms < 100:
		parser.error("--interval-ms must be at least 100")
	if args.camera_warmup_seconds < 0:
		parser.error("--camera-warmup-seconds must not be negative")
	if args.pause_seconds < 0:
		parser.error("--pause-seconds must not be negative")
	if 0 < args.pause_seconds < 2:
		parser.error("--pause-seconds must be at least 2 seconds when enabled")
	if args.pause_seconds > 0 and args.resume_seconds < 2:
		parser.error("--resume-seconds must be at least 2 seconds when pause is enabled")
	return args


def find_app_pid(explicit_pid):
	if explicit_pid is not None:
		if run(["kill", "-0", explicit_pid], check=False).returncode != 0:
			raise RuntimeError(f"Cap process {explicit_pid} is not running")
		return explicit_pid
	result = run(["pgrep", "-x", "cap-desktop"], check=False)
	pids = [int(value) for value in result.stdout.split() if value.isdigit()]
	if not pids:
		raise RuntimeError(
			"cap-desktop is not running. Start the existing desktop build, then rerun the harness."
		)
	if len(pids) == 1:
		return pids[0]
	by_elapsed = []
	for pid in pids:
		elapsed = run(["ps", "-p", pid, "-o", "etimes="], check=False).stdout.strip()
		if elapsed.isdigit():
			by_elapsed.append((int(elapsed), pid))
	if not by_elapsed:
		raise RuntimeError(f"Could not choose between cap-desktop processes: {pids}")
	return min(by_elapsed)[1]


def compile_sampler(artifacts_dir):
	source = REPO_ROOT / "scripts" / "instant-mode-process-sampler.c"
	binary = artifacts_dir / "instant-mode-process-sampler"
	run(
		[
			"xcrun",
			"clang",
			"-std=c11",
			"-O2",
			"-Wall",
			"-Wextra",
			"-Werror",
			str(source),
			"-o",
			str(binary),
		],
		timeout=60,
	)
	return binary


def compile_action_sender(artifacts_dir):
	source = REPO_ROOT / "scripts" / "instant-mode-action-macos.swift"
	binary = artifacts_dir / "instant-mode-action-macos"
	run(
		[
			"xcrun",
			"swiftc",
			"-O",
			str(source),
			"-o",
			str(binary),
		],
		timeout=60,
	)
	return binary


def load_targets(cap_binary):
	if not cap_binary.exists():
		raise RuntimeError(f"Cap CLI not found at {cap_binary}")
	result = run([cap_binary, "targets", "--json"], timeout=60)
	return json.loads(result.stdout)


def choose_target(items, requested, keys, preferred):
	if not items:
		raise RuntimeError("No matching capture devices were found")
	if requested:
		for item in items:
			if any(str(item.get(key)) == requested for key in keys):
				return item
		raise RuntimeError(f"Requested target not found: {requested}")
	for item in items:
		value = " ".join(str(item.get(key, "")) for key in keys)
		if preferred.lower() in value.lower():
			return item
	return items[0]


def choose_targets(targets, args):
	screens = targets.get("screens", [])
	screen = None
	if args.screen_name:
		screen = choose_target(screens, args.screen_name, ("name", "id"), "")
	else:
		screen = next((item for item in screens if item.get("primary")), None)
		screen = screen or choose_target(screens, None, ("name",), "")
	camera = choose_target(
		targets.get("cameras", []),
		args.camera_id,
		("deviceId", "displayName"),
		"MacBook Pro Camera",
	)
	mic = choose_target(
		targets.get("mics", []),
		args.mic_name,
		("name",),
		"MacBook Pro Microphone",
	)
	window = (
		choose_target(
			targets.get("windows", []),
			args.window_name,
			("name", "id"),
			"",
		)
		if args.window_name
		else None
	)
	return {
		"screen": screen,
		"window": window,
		"camera": camera,
		"mic": mic,
	}


def expected_preview_backend(recordings_dir):
	store_path = recordings_dir.parent / "store"
	if not store_path.exists():
		raise RuntimeError(f"Cap settings store not found at {store_path}")
	store = json.loads(store_path.read_text())
	settings = store.get("general_settings", {})
	return (
		"native-gpu"
		if settings.get("enableNativeCameraPreview", False)
		else "legacy-websocket"
	)


def deep_link(action, app_pid, action_sender):
	query = urllib.parse.urlencode(
		{"value": json.dumps(action, separators=(",", ":"))}
	)
	run(
		[
			action_sender,
			app_pid,
			f"cap-desktop://action?{query}",
		]
	)


def app_windows(app_pid, action_sender):
	result = run([action_sender, app_pid, "--windows"])
	return json.loads(result.stdout)


def visible_camera_windows(snapshot):
	return [
		window
		for window in snapshot["windows"]
		if window["name"] == "Cap Camera"
		and window["on_screen"]
		and window["bounds"].get("Width", 0) > 0
		and window["bounds"].get("Height", 0) > 0
	]


def wait_for_camera_window(app_pid, action_sender, timeout=8):
	deadline = time.monotonic() + timeout
	latest = None
	while time.monotonic() < deadline:
		latest = app_windows(app_pid, action_sender)
		if visible_camera_windows(latest):
			return latest
		time.sleep(0.25)
	names = [window["name"] for window in latest["windows"]] if latest else []
	raise RuntimeError(
		f"Cap Camera window is not on-screen for PID {app_pid}; windows={names}"
	)


def capture_mode(targets, args):
	if targets["window"]:
		return {"window": targets["window"]["name"]}
	if args.area:
		return {
			"area": {
				"screen": targets["screen"]["name"],
				**args.area,
			}
		}
	return {"screen": targets["screen"]["name"]}


def start_action(targets, args):
	return {
		"start_recording": {
			"capture_mode": capture_mode(targets, args),
			"camera": (
				None
				if args.no_camera
				else {"DeviceID": targets["camera"]["deviceId"]}
			),
			"mic_label": targets["mic"]["name"],
			"capture_system_audio": args.system_audio,
			"mode": "instant",
		}
	}


def open_camera_action(targets):
	return {
		"open_camera": {
			"camera": {"DeviceID": targets["camera"]["deviceId"]},
		}
	}


def set_camera_preview_state_action(state):
	return {"set_camera_preview_state": {"state": state}}


def load_camera_preview_state(recordings_dir):
	state_path = recordings_dir.parent / "cameraPreview"
	if not state_path.exists():
		return {
			"size": 230.0,
			"shape": "round",
			"mirrored": False,
			"background_blur": "off",
		}
	store = json.loads(state_path.read_text())
	return store.get("state", {})


def project_snapshot(recordings_dir):
	if not recordings_dir.exists():
		return {}
	return {
		str(project): project.stat().st_mtime_ns
		for project in recordings_dir.glob("*.cap")
		if project.is_dir()
	}


def wait_for_project(recordings_dir, before, started_ns, timeout=30):
	deadline = time.monotonic() + timeout
	while time.monotonic() < deadline:
		candidates = []
		for project in recordings_dir.glob("*.cap"):
			if not project.is_dir():
				continue
			mtime = project.stat().st_mtime_ns
			if mtime >= started_ns and before.get(str(project)) != mtime:
				candidates.append((mtime, project))
		if candidates:
			return max(candidates)[1]
		time.sleep(0.25)
	raise RuntimeError("No new .cap project appeared after the Instant Mode start action")


def process_executable(pid):
	libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
	libproc.proc_pidpath.argtypes = [
		ctypes.c_int,
		ctypes.c_void_p,
		ctypes.c_uint32,
	]
	libproc.proc_pidpath.restype = ctypes.c_int
	path_buffer = ctypes.create_string_buffer(4096)
	path_length = libproc.proc_pidpath(pid, path_buffer, len(path_buffer))
	if path_length <= 0:
		raise RuntimeError(f"Could not resolve the cap-desktop executable for PID {pid}")
	executable = Path(path_buffer.value.decode())
	if not executable.exists():
		raise RuntimeError(f"Could not resolve the cap-desktop executable for PID {pid}")
	return executable


def associated_pids(app_pid):
	result = run(["lsappinfo", "list"])
	blocks = re.split(r"(?=^\s*\d+\) \")", result.stdout, flags=re.MULTILINE)
	app_block_index = next(
		(
			index
			for index, block in enumerate(blocks)
			if re.search(rf"\bpid = {app_pid}\b", block)
		),
		None,
	)
	if app_block_index is None:
		raise RuntimeError(f"Could not find cap-desktop PID {app_pid} in lsappinfo")
	app_name_match = re.search(r'^\s*\d+\) "([^"]+)"', blocks[app_block_index])
	if not app_name_match:
		raise RuntimeError(f"Could not resolve the application name for PID {app_pid}")
	app_name = app_name_match.group(1)
	pids = [app_pid]
	processes = [{"pid": app_pid, "role": "app", "command": "cap-desktop"}]
	for block in blocks[app_block_index + 1 :]:
		name_match = re.search(r'^\s*\d+\) "([^"]+)"', block)
		if not name_match or not name_match.group(1).startswith(f"{app_name} "):
			break
		pid_match = re.search(r"\bpid = (\d+)\b", block)
		bundle_match = re.search(r'bundleID="([^"]+)"', block)
		if not pid_match or not bundle_match:
			continue
		command = bundle_match.group(1)
		if not command.startswith("com.apple.WebKit."):
			continue
		pid = int(pid_match.group(1))
		role_match = re.search(r"com\.apple\.WebKit\.([^.]+)", command)
		role = f"webkit-{role_match.group(1).lower()}" if role_match else "webkit"
		pids.append(pid)
		processes.append({"pid": pid, "role": role, "command": command})
	if len(pids) > 64:
		raise RuntimeError(f"Too many associated processes to sample: {len(pids)}")
	return pids, processes


def integer(value):
	try:
		return int(value)
	except (TypeError, ValueError):
		return 0


def nettop_snapshot(app_pid):
	result = run(
		[
			"nettop",
			"-n",
			"-L",
			"1",
			"-J",
			"bytes_in,bytes_out,interface,state",
			"-p",
			app_pid,
		],
		check=False,
		timeout=15,
	)
	aggregate = {"bytes_in": 0, "bytes_out": 0}
	connections = {}
	for row in csv.reader(result.stdout.splitlines()):
		if len(row) < 5 or not row[0]:
			continue
		if row[0].startswith("cap-desktop."):
			aggregate = {
				"bytes_in": integer(row[3]),
				"bytes_out": integer(row[4]),
			}
		elif row[0].startswith(("tcp", "udp")):
			connections[row[0]] = {
				"interface": row[1],
				"state": row[2],
				"bytes_in": integer(row[3]),
				"bytes_out": integer(row[4]),
			}
	return {
		"aggregate": aggregate,
		"connections": connections,
		"raw": result.stdout,
	}


def counter_delta(after, before, key):
	return max(0, integer(after.get(key)) - integer(before.get(key)))


def network_delta(before, after, elapsed):
	aggregate = {
		key: counter_delta(after["aggregate"], before["aggregate"], key)
		for key in ("bytes_in", "bytes_out")
	}
	connection_deltas = []
	for endpoint in set(before["connections"]) | set(after["connections"]):
		before_item = before["connections"].get(endpoint, {})
		after_item = after["connections"].get(endpoint, {})
		connection_deltas.append(
			{
				"endpoint": endpoint,
				"interface": after_item.get("interface")
				or before_item.get("interface"),
				"state": after_item.get("state") or before_item.get("state"),
				"bytes_in": counter_delta(after_item, before_item, "bytes_in"),
				"bytes_out": counter_delta(after_item, before_item, "bytes_out"),
			}
		)
	local = {
		key: sum(
			item[key]
			for item in connection_deltas
			if item["interface"] == "lo0"
		)
		for key in ("bytes_in", "bytes_out")
	}
	remote = {
		key: max(0, aggregate[key] - local[key])
		for key in ("bytes_in", "bytes_out")
	}
	camera_connection = max(
		(
			item
			for item in connection_deltas
			if item["interface"] == "lo0" and item["state"] == "Established"
		),
		key=lambda item: item["bytes_in"] + item["bytes_out"],
		default=None,
	)
	camera_bytes = (
		camera_connection["bytes_in"] + camera_connection["bytes_out"]
		if camera_connection
		else 0
	)
	if elapsed <= 0 or camera_bytes / elapsed < 64 * 1024:
		camera_connection = None
		camera_bytes = 0
	aggregate_bytes = aggregate["bytes_in"] + aggregate["bytes_out"]
	return {
		"aggregate": aggregate,
		"localhost": local,
		"remote": remote,
		"camera_preview_connection": camera_connection,
		"camera_preview_bytes_per_second": (
			camera_bytes / elapsed
			if elapsed > 0
			else 0.0
		),
		"non_preview_bytes_per_second": (
			max(0, aggregate_bytes - camera_bytes) / elapsed
			if elapsed > 0
			else 0.0
		),
		"remote_bytes_per_second": (
			(remote["bytes_in"] + remote["bytes_out"]) / elapsed
			if elapsed > 0
			else 0.0
		),
		"connections": connection_deltas,
	}


def wait_for_preview_traffic(app_pid, timeout=12):
	deadline = time.monotonic() + timeout
	latest = None
	while time.monotonic() < deadline:
		before = nettop_snapshot(app_pid)
		started = time.monotonic()
		time.sleep(1)
		after = nettop_snapshot(app_pid)
		latest = network_delta(before, after, time.monotonic() - started)
		if latest["camera_preview_bytes_per_second"] >= 64 * 1024:
			return latest
	raise RuntimeError(
		"Legacy camera preview did not begin transferring frames; "
		f"latest={latest}"
	)


def gpu_snapshot():
	result = run(
		["ioreg", "-r", "-d", "1", "-c", "AGXAccelerator"],
		check=False,
		timeout=15,
	)
	match = re.search(r'"PerformanceStatistics" = \{([^}]*)\}', result.stdout)
	if not match:
		return {}
	values = {
		key: int(value)
		for key, value in re.findall(r'"([^"]+)"=(\d+)', match.group(1))
	}
	return {
		"device_utilization_pct": values.get("Device Utilization %"),
		"renderer_utilization_pct": values.get("Renderer Utilization %"),
		"tiler_utilization_pct": values.get("Tiler Utilization %"),
		"in_use_system_memory_bytes": values.get("In use system memory"),
		"allocated_system_memory_bytes": values.get("Alloc system memory"),
	}


def system_snapshot():
	thermal = run(["pmset", "-g", "therm"], check=False).stdout.strip()
	memory_pressure = run(
		["sysctl", "-n", "vm.memory_pressure"], check=False
	).stdout.strip()
	return {
		"thermal": thermal,
		"vm_memory_pressure": integer(memory_pressure),
	}


def summarize_process_csv(csv_path, app_pid):
	rows = []
	with csv_path.open(newline="") as handle:
		for row in csv.DictReader(handle):
			row["sample"] = integer(row["sample"])
			row["pid"] = integer(row["pid"])
			row["elapsed_s"] = float(row["elapsed_s"])
			row["cpu_pct"] = float(row["cpu_pct"])
			for column in NUMERIC_COLUMNS:
				row[column] = integer(row[column])
			rows.append(row)
	if not rows:
		raise RuntimeError(f"No process samples were collected in {csv_path}")
	by_sample = {}
	for row in rows:
		by_sample.setdefault(row["sample"], []).append(row)
	group_samples = []
	for sample_rows in by_sample.values():
		group_samples.append(
			{
				"elapsed_s": max(row["elapsed_s"] for row in sample_rows),
				"cpu_pct": sum(row["cpu_pct"] for row in sample_rows),
				"rss_bytes": sum(row["rss_bytes"] for row in sample_rows),
				"phys_footprint_bytes": sum(
					row["phys_footprint_bytes"] for row in sample_rows
				),
				"threads": sum(row["threads"] for row in sample_rows),
			}
		)
	app_rows = [row for row in rows if row["pid"] == app_pid]
	first_by_pid = {}
	last_by_pid = {}
	for row in rows:
		first_by_pid.setdefault(row["pid"], row)
		last_by_pid[row["pid"]] = row
	process_breakdown = []
	for pid in sorted(last_by_pid):
		pid_rows = [row for row in rows if row["pid"] == pid]
		process_breakdown.append(
			{
				"pid": pid,
				"name": pid_rows[-1]["name"],
				"cpu_median_pct": statistics.median(
					row["cpu_pct"] for row in pid_rows
				),
				"cpu_average_pct": (
					(
						last_by_pid[pid]["user_ns"]
						+ last_by_pid[pid]["system_ns"]
						- first_by_pid[pid]["user_ns"]
						- first_by_pid[pid]["system_ns"]
					)
					/ 1_000_000_000
					/ max(pid_rows[-1]["elapsed_s"], 0.001)
					* 100
				),
				"physical_footprint_mib_median": statistics.median(
					row["phys_footprint_bytes"] for row in pid_rows
				)
				/ 1024
				/ 1024,
			}
		)
	deltas = {}
	for column in DELTA_COLUMNS:
		deltas[column] = sum(
			max(0, last_by_pid[pid][column] - first_by_pid[pid][column])
			for pid in last_by_pid
		)
	elapsed = max(item["elapsed_s"] for item in group_samples)
	cpu_time_seconds = sum(
		max(
			0,
			(
				last_by_pid[pid]["user_ns"]
				+ last_by_pid[pid]["system_ns"]
				- first_by_pid[pid]["user_ns"]
				- first_by_pid[pid]["system_ns"]
			),
		)
		for pid in last_by_pid
	) / 1_000_000_000
	return {
		"sample_count": len(group_samples),
		"process_count": len(last_by_pid),
		"elapsed_seconds": elapsed,
		"cpu_median_pct": statistics.median(
			item["cpu_pct"] for item in group_samples
		),
		"cpu_min_pct": min(item["cpu_pct"] for item in group_samples),
		"cpu_max_pct": max(item["cpu_pct"] for item in group_samples),
		"cpu_time_seconds": cpu_time_seconds,
		"cpu_average_pct": cpu_time_seconds / elapsed * 100 if elapsed > 0 else 0,
		"app_cpu_median_pct": (
			statistics.median(row["cpu_pct"] for row in app_rows)
			if app_rows
			else None
		),
		"process_breakdown": process_breakdown,
		"rss_median_bytes": statistics.median(
			item["rss_bytes"] for item in group_samples
		),
		"rss_peak_bytes": max(item["rss_bytes"] for item in group_samples),
		"phys_footprint_median_bytes": statistics.median(
			item["phys_footprint_bytes"] for item in group_samples
		),
		"phys_footprint_peak_bytes": max(
			item["phys_footprint_bytes"] for item in group_samples
		),
		"phys_footprint_growth_bytes": (
			group_samples[-1]["phys_footprint_bytes"]
			- group_samples[0]["phys_footprint_bytes"]
		),
		"thread_median": statistics.median(
			item["threads"] for item in group_samples
		),
		"disk_read_bytes_per_second": deltas["disk_read_bytes"] / elapsed,
		"disk_write_bytes_per_second": deltas["disk_write_bytes"] / elapsed,
		"energy_millijoules_per_second": deltas["energy_nj"] / 1_000_000 / elapsed,
		"instructions_per_second": deltas["instructions"] / elapsed,
		"cycles_per_second": deltas["cycles"] / elapsed,
		"faults_per_second": deltas["faults"] / elapsed,
		"wakeups_per_second": (
			deltas["idle_wakeups"] + deltas["interrupt_wakeups"]
		)
		/ elapsed,
		"context_switches_per_second": deltas["context_switches"] / elapsed,
		"mach_syscalls_per_second": deltas["mach_syscalls"] / elapsed,
		"unix_syscalls_per_second": deltas["unix_syscalls"] / elapsed,
		"deltas": deltas,
	}


def summarize_gpu(samples):
	summary = {"scope": "system-wide AGX counters"}
	for key in (
		"device_utilization_pct",
		"renderer_utilization_pct",
		"tiler_utilization_pct",
		"in_use_system_memory_bytes",
		"allocated_system_memory_bytes",
	):
		values = [sample[key] for sample in samples if sample.get(key) is not None]
		if values:
			summary[f"{key}_median"] = statistics.median(values)
			summary[f"{key}_max"] = max(values)
	return summary


def measure_phase(
	name,
	duration,
	artifact_dir,
	sampler_binary,
	app_pid,
	interval_ms,
	trigger=None,
):
	pids, processes = associated_pids(app_pid)
	csv_path = artifact_dir / f"{name}-processes.csv"
	network_before = nettop_snapshot(app_pid)
	(artifact_dir / f"{name}-network-before.txt").write_text(
		network_before["raw"]
	)
	system_before = system_snapshot()
	gpu_samples = [gpu_snapshot()]
	with csv_path.open("w") as output:
		process = subprocess.Popen(
			[
				str(sampler_binary),
				str(duration),
				str(interval_ms),
				*[str(pid) for pid in pids],
			],
			stdout=output,
			stderr=subprocess.PIPE,
			text=True,
		)
		phase_started = time.monotonic()
		if trigger:
			trigger()
		for fraction in (0.5, 0.9):
			target = phase_started + duration * fraction
			delay = target - time.monotonic()
			if delay > 0:
				time.sleep(delay)
			gpu_samples.append(gpu_snapshot())
		stderr = process.communicate(timeout=max(5, duration + 5))[1]
		if process.returncode != 0:
			raise RuntimeError(f"Process sampler failed in {name}: {stderr.strip()}")
	elapsed = time.monotonic() - phase_started
	network_after = nettop_snapshot(app_pid)
	(artifact_dir / f"{name}-network-after.txt").write_text(
		network_after["raw"]
	)
	system_after = system_snapshot()
	process_summary = summarize_process_csv(csv_path, app_pid)
	return {
		"name": name,
		"duration_seconds": elapsed,
		"processes": processes,
		"process_metrics": process_summary,
		"network": network_delta(network_before, network_after, elapsed),
		"gpu": summarize_gpu(gpu_samples),
		"system_before": system_before,
		"system_after": system_after,
		"raw_process_csv": str(csv_path),
	}


def wait_for_recording_complete(project, timeout=45):
	meta_path = project / "recording-meta.json"
	deadline = time.monotonic() + timeout
	last_meta = None
	while time.monotonic() < deadline:
		if meta_path.exists():
			try:
				last_meta = json.loads(meta_path.read_text())
			except json.JSONDecodeError:
				last_meta = None
			if (
				last_meta
				and last_meta.get("upload", {}).get("state") == "Complete"
			):
				return last_meta
		time.sleep(0.5)
	return last_meta


def directory_size(path):
	return sum(
		item.stat().st_size
		for item in path.rglob("*")
		if item.is_file()
	)


def validate_project(project):
	meta_path = project / "recording-meta.json"
	log_path = project / "recording-logs.log"
	manifest_path = project / "content" / "display" / "manifest.json"
	meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
	manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
	codec = manifest.get("codec_info", {})
	segments = manifest.get("segments", [])
	log = log_path.read_text(errors="replace") if log_path.exists() else ""
	drop_matches = re.findall(
		r"Screen capture stats frames=(\d+) drops=(\d+) "
		r'drop_rate_pct="([^"]+)%" total_frames=(\d+)',
		log,
	)
	captured_frame_matches = re.findall(
		r"Capturer stopping after creating (\d+) video frames",
		log,
	)
	ws_matches = re.findall(
		r'WS frame stats fps=(\d+) mb_per_sec="([^"]+)" .* '
		r'dims="(\d+)x(\d+)" format="([^"]+)"',
		log,
	)
	active_ws_matches = [match for match in ws_matches if int(match[0]) > 0]
	camera_capture = {
		"selected": "Selected camera locked for recording camera_selected=true" in log,
		"native_sender_attached": "CameraFeed: Adding new native sender" in log,
		"availability_checks": len(
			re.findall(r"is_camera_available: looking for DeviceID", log)
		),
	}
	error_lines = [line for line in log.splitlines() if " ERROR " in line]
	audio_paths = [
		str(path.relative_to(project))
		for path in (project / "content").rglob("*")
		if path.is_file() and "display" not in path.parts
	]
	audio_manifest_path = project / "content" / "audio" / "manifest.json"
	audio_manifest = (
		json.loads(audio_manifest_path.read_text())
		if audio_manifest_path.exists()
		else {}
	)
	audio_segments = audio_manifest.get("segments", [])
	return {
		"project": str(project),
		"project_size_bytes": directory_size(project),
		"sharing": meta.get("sharing"),
		"upload_state": meta.get("upload", {}).get("state"),
		"metadata_fps": meta.get("fps"),
		"sample_rate": meta.get("sample_rate"),
		"microphone_present": bool(audio_segments),
		"audio_codec": audio_manifest.get("codec_info"),
		"audio_segments_complete": bool(audio_segments)
		and all(segment.get("is_complete") for segment in audio_segments),
		"codec": codec,
		"segment_count": len(segments),
		"segments_complete": bool(segments)
		and all(segment.get("is_complete") for segment in segments),
		"duration_seconds": manifest.get("total_duration"),
		"manifest_complete": manifest.get("is_complete"),
		"audio_paths": audio_paths,
		"last_capture_health": (
			{
				"frames": int(drop_matches[-1][0]),
				"drops": int(drop_matches[-1][1]),
				"drop_rate_pct": float(drop_matches[-1][2]),
				"total_frames": int(drop_matches[-1][3]),
			}
			if drop_matches
			else None
		),
		"captured_frames_on_stop": (
			int(captured_frame_matches[-1]) if captured_frame_matches else None
		),
		"camera_capture": camera_capture,
		"preview_backend": (
			"legacy-websocket"
			if active_ws_matches
			else "native-gpu"
			if camera_capture["selected"]
			else "none"
		),
		"webcam_preview": (
			{
				"fps": statistics.median(
					int(match[0]) for match in active_ws_matches
				),
				"megabytes_per_second": statistics.median(
					float(match[1]) for match in active_ws_matches
				),
				"width": int(active_ws_matches[-1][2]),
				"height": int(active_ws_matches[-1][3]),
				"format": active_ws_matches[-1][4],
			}
			if active_ws_matches
			else None
		),
		"error_lines": error_lines,
	}


def project_validation_errors(
	validation,
	no_camera,
	phases,
	camera_window_checks,
	expected_backend,
	expected_preview_format,
):
	errors = []
	codec = validation["codec"]
	if validation["upload_state"] != "Complete":
		errors.append(f"upload state is {validation['upload_state']!r}")
	if not validation["sharing"]:
		errors.append("sharing metadata is missing")
	if validation["metadata_fps"] != 30:
		errors.append(f"metadata frame rate is {validation['metadata_fps']!r}")
	if not validation["microphone_present"]:
		errors.append("microphone track is missing")
	if not validation["audio_segments_complete"]:
		errors.append("audio segments are incomplete")
	if not validation["segments_complete"] or not validation["manifest_complete"]:
		errors.append("video segments or manifest are incomplete")
	if codec.get("width", 0) <= 0 or codec.get("height", 0) <= 0:
		errors.append("video dimensions are missing")
	if codec.get("frame_rate_num") != 30 or codec.get("frame_rate_den") != 1:
		errors.append(f"video frame rate is {codec.get('frame_rate_num')}/{codec.get('frame_rate_den')}")
	if codec.get("pixel_format") != "NV12":
		errors.append(f"video pixel format is {codec.get('pixel_format')!r}")
	if validation["error_lines"]:
		errors.append(f"recording log contains {len(validation['error_lines'])} errors")
	health = validation["last_capture_health"]
	if not health:
		if not validation["captured_frames_on_stop"]:
			errors.append("screen capture health metrics are missing")
	elif health["drop_rate_pct"] > 0.5:
		errors.append(f"screen capture drop rate is {health['drop_rate_pct']}%")
	webcam = validation["webcam_preview"]
	camera_capture = validation["camera_capture"]
	idle_phase = next(phase for phase in phases if phase["name"] == "idle")
	recording_phase = next(phase for phase in phases if phase["name"] == "recording")
	idle_preview_bytes = idle_phase["network"]["camera_preview_bytes_per_second"]
	preview_bytes = recording_phase["network"]["camera_preview_bytes_per_second"]
	if no_camera:
		if camera_capture["selected"] or camera_capture["native_sender_attached"]:
			errors.append("camera capture was active during a camera-off run")
		if webcam and webcam["fps"] > 0:
			errors.append("webcam preview was active during a camera-off run")
		if preview_bytes >= 64 * 1024:
			errors.append("webcam preview IPC was active during a camera-off run")
	else:
		if validation["preview_backend"] != expected_backend:
			errors.append(
				f"camera preview backend is {validation['preview_backend']!r}, "
				f"expected {expected_backend!r}"
			)
		for name, snapshot in camera_window_checks.items():
			if not visible_camera_windows(snapshot):
				errors.append(f"Cap Camera window was not on-screen at {name}")
		if not camera_capture["selected"]:
			errors.append("the selected camera was not locked into the Instant pipeline")
		if not camera_capture["native_sender_attached"]:
			errors.append("the native camera sender was not attached")
		if camera_capture["availability_checks"] < 1:
			errors.append("camera availability was not monitored during recording")
		if webcam:
			if idle_preview_bytes < 64 * 1024:
				errors.append("legacy webcam preview IPC was not active before recording")
			if webcam["fps"] <= 0:
				errors.append("webcam preview frame rate is zero")
			if webcam["width"] <= 0 or webcam["height"] <= 0:
				errors.append("webcam preview dimensions are missing")
			if webcam["format"] != expected_preview_format:
				errors.append(
					f"webcam preview format is {webcam['format']!r}, "
					f"expected {expected_preview_format!r}"
				)
			if preview_bytes < 64 * 1024:
				errors.append("legacy webcam preview IPC was not active during recording")
	return errors


def aggregate_runs(runs):
	phase_names = []
	for run_result in runs:
		for phase in run_result["phases"]:
			if phase["name"] not in phase_names:
				phase_names.append(phase["name"])
	metrics = (
		("cpu_median_pct", "process_metrics"),
		("cpu_average_pct", "process_metrics"),
		("app_cpu_median_pct", "process_metrics"),
		("phys_footprint_median_bytes", "process_metrics"),
		("phys_footprint_peak_bytes", "process_metrics"),
		("phys_footprint_growth_bytes", "process_metrics"),
		("rss_median_bytes", "process_metrics"),
		("disk_read_bytes_per_second", "process_metrics"),
		("disk_write_bytes_per_second", "process_metrics"),
		("energy_millijoules_per_second", "process_metrics"),
		("instructions_per_second", "process_metrics"),
		("cycles_per_second", "process_metrics"),
		("faults_per_second", "process_metrics"),
		("wakeups_per_second", "process_metrics"),
		("context_switches_per_second", "process_metrics"),
		("mach_syscalls_per_second", "process_metrics"),
		("unix_syscalls_per_second", "process_metrics"),
		("camera_preview_bytes_per_second", "network"),
		("non_preview_bytes_per_second", "network"),
		("remote_bytes_per_second", "network"),
	)
	output = {}
	for phase_name in phase_names:
		phase_output = {}
		for metric, section in metrics:
			values = [
				phase[section][metric]
				for run_result in runs
				for phase in run_result["phases"]
				if phase["name"] == phase_name
				and phase[section].get(metric) is not None
			]
			if values:
				phase_output[metric] = {
					"median": statistics.median(values),
					"min": min(values),
					"max": max(values),
				}
		output[phase_name] = phase_output
	return output


def print_summary(summary):
	print(f"Artifacts: {summary['artifacts_dir']}")
	target = (
		summary["targets"]["window"]["name"]
		if summary["targets"]["window"]
		else (
			f"area {summary['configuration']['area']}"
			if summary["configuration"]["area"]
			else summary["targets"]["screen"]["name"]
		)
	)
	print(
		f"Target: {target} | "
		f"{'camera off' if summary['configuration']['no_camera'] else summary['targets']['camera']['displayName']} | "
		f"{summary['targets']['mic']['name']}"
	)
	print(
		"phase          cpu median    footprint    disk write    preview IPC     other net"
	)
	for name, phase in summary["aggregate"].items():
		cpu = phase.get("cpu_median_pct", {}).get("median", 0)
		memory = (
			phase.get("phys_footprint_median_bytes", {}).get("median", 0)
			/ 1024
			/ 1024
		)
		preview = (
			phase.get("camera_preview_bytes_per_second", {}).get("median", 0)
			/ 1024
			/ 1024
		)
		disk_write = (
			phase.get("disk_write_bytes_per_second", {}).get("median", 0)
			/ 1024
			/ 1024
		)
		non_preview = (
			phase.get("non_preview_bytes_per_second", {}).get("median", 0)
			/ 1024
			/ 1024
		)
		print(
			f"{name:<14} {cpu:>8.1f}% {memory:>9.1f} MiB "
			f"{disk_write:>8.2f} MiB/s {preview:>8.2f} MiB/s "
			f"{non_preview:>8.2f} MiB/s"
		)
	for run_result in summary["runs"]:
		validation = run_result["validation"]
		print(
			f"run {run_result['index']}: "
			f"{validation['codec'].get('width')}x"
			f"{validation['codec'].get('height')} "
			f"{validation['codec'].get('frame_rate_num')}fps, "
			f"audio={validation['microphone_present']}, "
			f"camera={validation['preview_backend']}, "
			f"upload={validation['upload_state']}, "
			f"errors={len(validation['error_lines'])}, "
			f"{validation['project']}"
		)


def main():
	args = parse_args()
	if platform.system() != "Darwin":
		raise RuntimeError("This harness requires macOS")
	timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
	safe_label = re.sub(r"[^A-Za-z0-9_.-]+", "-", args.label).strip("-")
	artifacts_dir = args.artifacts_dir or Path(
		f"/private/tmp/cap-instant-mode-{safe_label}-{timestamp}"
	)
	artifacts_dir.mkdir(parents=True, exist_ok=False)
	sampler_binary = compile_sampler(artifacts_dir)
	action_sender = compile_action_sender(artifacts_dir)
	app_pid = find_app_pid(args.app_pid)
	app_executable = process_executable(app_pid)
	expected_executable = (REPO_ROOT / "target" / "debug" / "cap-desktop").resolve()
	if app_executable.resolve() != expected_executable:
		raise RuntimeError(
			f"PID {app_pid} is {app_executable}, expected the local app at {expected_executable}"
		)
	targets = choose_targets(load_targets(args.cap_binary), args)
	preview_backend = expected_preview_backend(args.recordings_dir)
	expected_preview_format = (
		"RGBA"
		if args.camera_blur and args.camera_blur != "off"
		else args.expected_preview_format
	)
	preview_state_override = None
	if args.camera_blur:
		original_preview_state = load_camera_preview_state(args.recordings_dir)
		preview_state_override = {
			**original_preview_state,
			"background_blur": args.camera_blur,
		}
		atexit.register(
			deep_link,
			set_camera_preview_state_action(original_preview_state),
			app_pid,
			action_sender,
		)
	configuration = {
		"label": args.label,
		"repetitions": args.repetitions,
		"idle_seconds": args.idle_seconds,
		"start_seconds": args.start_seconds,
		"recording_seconds": args.recording_seconds,
		"stop_seconds": args.stop_seconds,
		"post_stop_seconds": args.post_stop_seconds,
		"cooldown_seconds": args.cooldown_seconds,
		"camera_warmup_seconds": args.camera_warmup_seconds,
		"interval_ms": args.interval_ms,
		"system_audio": args.system_audio,
		"no_camera": args.no_camera,
		"camera_blur": args.camera_blur,
		"expected_preview_format": expected_preview_format,
		"window_name": args.window_name,
		"area": args.area,
		"pause_seconds": args.pause_seconds,
		"resume_seconds": args.resume_seconds,
		"app_pid": app_pid,
		"app_executable": str(app_executable),
		"cap_binary": str(args.cap_binary),
		"recordings_dir": str(args.recordings_dir),
		"expected_preview_backend": preview_backend,
	}
	prepared = {
		"schema_version": 1,
		"created_at": datetime.now().astimezone().isoformat(),
		"repository_root": str(REPO_ROOT),
		"git_commit": run(["git", "rev-parse", "HEAD"]).stdout.strip(),
		"configuration": configuration,
		"targets": targets,
		"artifacts_dir": str(artifacts_dir),
	}
	(artifacts_dir / "prepared.json").write_text(
		json.dumps(prepared, indent=2) + "\n"
	)
	if args.prepare_only:
		print(json.dumps(prepared, indent=2))
		return

	args.recordings_dir.mkdir(parents=True, exist_ok=True)
	runs = []
	for index in range(1, args.repetitions + 1):
		camera_window_checks = {}
		preview_readiness = {}
		if not args.no_camera:
			print(f"run {index}/{args.repetitions}: open camera", flush=True)
			deep_link(open_camera_action(targets), app_pid, action_sender)
			if preview_state_override:
				deep_link(
					set_camera_preview_state_action(preview_state_override),
					app_pid,
					action_sender,
				)
			time.sleep(args.camera_warmup_seconds)
			camera_window_checks["idle_start"] = wait_for_camera_window(
				app_pid,
				action_sender,
			)
			preview_readiness["idle_start"] = wait_for_preview_traffic(app_pid)
		print(f"run {index}/{args.repetitions}: idle", flush=True)
		run_dir = artifacts_dir / f"run-{index:02d}"
		run_dir.mkdir()
		phases = [
			measure_phase(
				"idle",
				args.idle_seconds,
				run_dir,
				sampler_binary,
				app_pid,
				args.interval_ms,
			)
		]
		before = project_snapshot(args.recordings_dir)
		started_ns = time.time_ns()
		print(f"run {index}/{args.repetitions}: start", flush=True)
		phases.append(
			measure_phase(
				"start",
				args.start_seconds,
				run_dir,
				sampler_binary,
					app_pid,
					args.interval_ms,
					trigger=lambda: deep_link(
						start_action(targets, args),
						app_pid,
						action_sender,
					),
				)
		)
		project = wait_for_project(args.recordings_dir, before, started_ns)
		if not args.no_camera:
			print(f"run {index}/{args.repetitions}: verify camera", flush=True)
			camera_window_checks["recording_start"] = wait_for_camera_window(
				app_pid,
				action_sender,
			)
			preview_readiness["recording_start"] = wait_for_preview_traffic(
				app_pid
			)
		print(f"run {index}/{args.repetitions}: recording", flush=True)
		phases.append(
			measure_phase(
				"recording",
				args.recording_seconds,
				run_dir,
				sampler_binary,
				app_pid,
				args.interval_ms,
			)
		)
		if args.pause_seconds > 0:
			print(f"run {index}/{args.repetitions}: pause", flush=True)
			phases.append(
				measure_phase(
					"paused",
					args.pause_seconds,
					run_dir,
					sampler_binary,
					app_pid,
					args.interval_ms,
					trigger=lambda: deep_link(
						"pause_recording",
						app_pid,
						action_sender,
					),
				)
			)
			print(f"run {index}/{args.repetitions}: resume", flush=True)
			phases.append(
				measure_phase(
					"resumed",
					args.resume_seconds,
					run_dir,
					sampler_binary,
					app_pid,
					args.interval_ms,
					trigger=lambda: deep_link(
						"resume_recording",
						app_pid,
						action_sender,
					),
				)
			)
		if not args.no_camera:
			camera_window_checks["recording_end"] = app_windows(
				app_pid,
				action_sender,
			)
		print(f"run {index}/{args.repetitions}: stop", flush=True)
		phases.append(
			measure_phase(
				"stop",
				args.stop_seconds,
				run_dir,
				sampler_binary,
				app_pid,
				args.interval_ms,
				trigger=lambda: deep_link(
					"stop_recording",
					app_pid,
					action_sender,
				),
			)
		)
		meta = wait_for_recording_complete(project)
		print(f"run {index}/{args.repetitions}: post-stop", flush=True)
		phases.append(
			measure_phase(
				"post_stop",
				args.post_stop_seconds,
				run_dir,
				sampler_binary,
				app_pid,
				args.interval_ms,
			)
		)
		validation = validate_project(project)
		if meta and not validation["upload_state"]:
			validation["upload_state"] = meta.get("upload", {}).get("state")
		validation_errors = project_validation_errors(
			validation,
			args.no_camera,
			phases,
			camera_window_checks,
			preview_backend,
			expected_preview_format,
		)
		run_result = {
			"index": index,
			"phases": phases,
			"camera_window_checks": camera_window_checks,
			"preview_readiness": preview_readiness,
			"validation": validation,
			"validation_errors": validation_errors,
		}
		(run_dir / "result.json").write_text(
			json.dumps(run_result, indent=2) + "\n"
		)
		if validation_errors:
			raise RuntimeError(
				f"run {index} failed validation: {'; '.join(validation_errors)}"
			)
		runs.append(run_result)
		if index < args.repetitions and args.cooldown_seconds > 0:
			time.sleep(args.cooldown_seconds)

	summary = {
		**prepared,
		"runs": runs,
		"aggregate": aggregate_runs(runs),
	}
	summary_path = artifacts_dir / "summary.json"
	summary_path.write_text(json.dumps(summary, indent=2) + "\n")
	print_summary(summary)


if __name__ == "__main__":
	try:
		main()
	except (RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError) as error:
		print(f"error: {error}", file=sys.stderr)
		sys.exit(1)
