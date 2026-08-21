// The desktop dev entry: `pnpm tauri dev` plus the gpui app's save-to-relaunch
// loop (`apps/desktop-gpui/dev.sh`), so working on either app under
// `pnpm dev:desktop` gets hot reload without a second terminal. The gpui loop
// is macOS-only (dev.sh uses BSD stat/md5), skipped when the workspace is
// absent (main without the gpui branch), and opt-out via CAP_GPUI_DEV=0. Its
// output is prefixed [gpui] so the two cargo streams stay tellable apart.
//
// This script is also the dev half of the experimental app-switch: handing off
// to the gpui app exits the Tauri process by design, so the session stays up
// while the loop runs, and switching back inside the gpui app writes a reopen
// sentinel (`store::request_classic_reopen`) that this supervisor answers by
// starting `tauri dev` again -- the dev classic app only exists inside that
// harness, so nothing else could reopen it.
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gpuiDir = path.join(repoRoot, "apps", "desktop-gpui");
const gpuiDevScript = path.join(gpuiDir, "dev.sh");
const reopenSentinel = path.join(
	os.homedir(),
	"Library/Application Support/so.cap.desktop/cap-classic.reopen",
);

let tauri = null;
let gpui = null;
let lastTauriCode = 0;
let exiting = false;

function startTauri() {
	tauri = spawn("pnpm", ["tauri", "dev"], { stdio: "inherit" });
	tauri.on("exit", (code, signal) => {
		tauri = null;
		lastTauriCode = signal ? 1 : (code ?? 1);
		if (exiting || !gpui) {
			finish(signal);
			return;
		}
		// The experimental toggle hands the session off to the gpui app: this
		// exit is by design, and the loop keeps the app the user switched to
		// alive. The sentinel watcher below brings `tauri dev` back when the
		// gpui app asks to switch back again.
		console.error(
			"[gpui] Tauri app exited; the gpui dev loop is still running (Ctrl-C to stop)",
		);
	});
}

function finish(signal) {
	exiting = true;
	stopGpui();
	if (signal) {
		// Re-raise with the handler gone, or it would swallow its own signal.
		process.removeAllListeners(signal);
		process.kill(process.pid, signal);
	} else process.exit(lastTauriCode);
}

// dev.sh traps TERM and shuts the running app down with it; give that a
// moment before giving up on a stuck loop.
function stopGpui() {
	const child = gpui;
	if (!child) return;
	child.kill("SIGTERM");
	setTimeout(() => {
		if (gpui === child) child.kill("SIGKILL");
	}, 5000).unref();
}

if (
	process.platform === "darwin" &&
	process.env.CAP_GPUI_DEV !== "0" &&
	existsSync(gpuiDevScript)
) {
	gpui = spawn("bash", [gpuiDevScript], {
		cwd: gpuiDir,
		stdio: ["ignore", "pipe", "pipe"],
		env: process.env,
	});
	const prefix = (stream, out) => {
		readline
			.createInterface({ input: stream })
			.on("line", (line) => out.write(`[gpui] ${line}\n`));
	};
	prefix(gpui.stdout, process.stdout);
	prefix(gpui.stderr, process.stderr);
	gpui.on("exit", (code, signal) => {
		gpui = null;
		// With no Tauri child either, the loop was the session's last process:
		// exit whether this is a shutdown or a crash in detached mode.
		if (!tauri) {
			finish(null);
			return;
		}
		if (exiting) return;
		console.error(
			`[gpui] dev loop exited (${signal ?? code}); restart with: cd apps/desktop-gpui && ./dev.sh`,
		);
	});

	// A sentinel from before this session is stale, not a request.
	rmSync(reopenSentinel, { force: true });
	setInterval(() => {
		if (exiting || !existsSync(reopenSentinel)) return;
		// Always consumed once seen: with the Tauri side already up (or still
		// starting, e.g. mid-compile) the request is satisfied, and leaving
		// the file would fire it spuriously after the next hand-off.
		rmSync(reopenSentinel, { force: true });
		if (tauri) return;
		console.error("[gpui] switch-back requested; starting the Tauri app again");
		startTauri();
	}, 500).unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		exiting = true;
		stopGpui();
		// Ctrl-C already reaches the children through the process group;
		// forward for the direct-signal case, then let the exit handlers run.
		if (tauri) tauri.kill(signal);
		else if (!gpui) process.exit(lastTauriCode);
	});
}

startTauri();
