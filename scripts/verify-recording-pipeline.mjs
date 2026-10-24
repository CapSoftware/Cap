#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const stamp = new Date()
	.toISOString()
	.replaceAll(":", "")
	.replace(/\..+$/, "")
	.replace("T", "-");
const runDir = path.join(root, "target", "recording-verification", stamp);
const summaryPath = path.join(runDir, "summary.json");
const capBin = process.env.CAP_BIN || path.join(root, "target", "debug", "cap");
const ffprobeBin = process.env.FFPROBE_BIN || "ffprobe";
const recordingSeconds = Number(process.env.CAP_VERIFY_SECONDS || "4");
const desktopRecordingSeconds = Number(
	process.env.CAP_VERIFY_DESKTOP_SECONDS || recordingSeconds + 4,
);
const includeSystemAudio = process.env.CAP_VERIFY_SYSTEM_AUDIO !== "0";
const desktopEnabled = process.env.CAP_VERIFY_DESKTOP === "1";
const skipCli = process.env.CAP_VERIFY_SKIP_CLI === "1";
const desktopExecPath = process.env.CAP_VERIFY_DESKTOP_EXEC_PATH
	? path.resolve(process.env.CAP_VERIFY_DESKTOP_EXEC_PATH)
	: null;
const desktopAppPath = process.env.CAP_VERIFY_DESKTOP_APP_PATH
	? path.resolve(process.env.CAP_VERIFY_DESKTOP_APP_PATH)
	: desktopExecPath
		? appPathFromExecutable(desktopExecPath)
		: null;
const desktopBundleId =
	process.env.CAP_VERIFY_DESKTOP_BUNDLE_ID ||
	(desktopAppPath?.endsWith("Cap - Development.app")
		? "so.cap.desktop.dev"
		: "so.cap.desktop");
const signDesktopApp = process.env.CAP_VERIFY_SIGN_DESKTOP !== "0";
const desktopEntitlementsPath = process.env.CAP_VERIFY_DESKTOP_ENTITLEMENTS
	? path.resolve(process.env.CAP_VERIFY_DESKTOP_ENTITLEMENTS)
	: path.join(root, "apps", "desktop", "src-tauri", "Entitlements.plist");
const desktopLogDirs = ["so.cap.desktop.dev", "so.cap.desktop"].map((name) =>
	path.join(os.homedir(), "Library", "Logs", name),
);
const desktopRecordingDirs = [
	path.join(
		os.homedir(),
		"Library",
		"Application Support",
		"so.cap.desktop.dev",
		"recordings",
	),
	path.join(
		os.homedir(),
		"Library",
		"Application Support",
		"so.cap.desktop",
		"recordings",
	),
].filter((value, index, values) => values.indexOf(value) === index);

const summary = {
	runDir,
	flows: [],
	projects: [],
	media: [],
	exports: [],
	logScan: [],
	skipCli,
	desktop: {
		enabled: desktopEnabled,
		bundleId: desktopBundleId,
		appPath: desktopAppPath,
		execPath: desktopExecPath,
		execPid: null,
		execStdoutPath: null,
		execStderrPath: null,
		signing: {
			enabled: signDesktopApp,
			entitlementsPath: desktopEntitlementsPath,
		},
		projects: [],
	},
	doctor: null,
};

await mkdir(runDir, { recursive: true });

const commandOutputs = [];

function appPathFromExecutable(execPath) {
	const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
	const markerIndex = execPath.indexOf(marker);
	if (markerIndex === -1) {
		return null;
	}
	return execPath.slice(0, markerIndex);
}

function outputPath(name, suffix) {
	return path.join(runDir, `${name}.${suffix}`);
}

async function runCommand(name, command, args, options = {}) {
	const cwd = options.cwd || root;
	const env = { ...process.env, ...(options.env || {}) };
	const timeoutMs =
		options.timeoutMs ??
		Number(process.env.CAP_VERIFY_COMMAND_TIMEOUT_MS || "180000");
	const stdoutPath = outputPath(name, "stdout");
	const stderrPath = outputPath(name, "stderr");
	const statusPath = outputPath(name, "status.json");
	const stdout = fs.createWriteStream(stdoutPath);
	const stderr = fs.createWriteStream(stderrPath);
	const startedAt = Date.now();

	const result = await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdoutText = "";
		let stderrText = "";
		let timedOut = false;
		let killTimer = null;
		const timeoutTimer =
			timeoutMs > 0
				? setTimeout(() => {
						timedOut = true;
						child.kill("SIGTERM");
						killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
					}, timeoutMs)
				: null;

		child.stdout.on("data", (chunk) => {
			const text = chunk.toString();
			stdoutText += text;
			stdout.write(chunk);
		});

		child.stderr.on("data", (chunk) => {
			const text = chunk.toString();
			stderrText += text;
			stderr.write(chunk);
		});

		child.on("error", (error) => {
			if (timeoutTimer) {
				clearTimeout(timeoutTimer);
			}
			if (killTimer) {
				clearTimeout(killTimer);
			}
			reject(error);
		});
		child.on("close", (code, signal) => {
			if (timeoutTimer) {
				clearTimeout(timeoutTimer);
			}
			if (killTimer) {
				clearTimeout(killTimer);
			}
			stdout.end();
			stderr.end();
			resolve({
				name,
				command,
				args,
				code,
				signal,
				stdout: stdoutText,
				stderr: stderrText,
				stdoutPath,
				stderrPath,
				timedOut,
				timeoutMs,
				durationMs: Date.now() - startedAt,
			});
		});
	});

	await writeFile(
		statusPath,
		`${JSON.stringify(
			{
				name,
				command,
				args,
				code: result.code,
				signal: result.signal,
				timedOut: result.timedOut,
				timeoutMs: result.timeoutMs,
				durationMs: result.durationMs,
			},
			null,
			2,
		)}\n`,
	);

	commandOutputs.push(result);

	if (result.timedOut && !options.allowFailure) {
		throw new Error(
			`${name} timed out after ${result.timeoutMs}ms. See ${stderrPath}`,
		);
	}

	if (result.code !== 0 && !options.allowFailure) {
		throw new Error(
			`${name} failed with code ${result.code}. See ${stderrPath}`,
		);
	}

	return result;
}

function parseJsonOutput(text) {
	const trimmed = text.trim();
	if (!trimmed) {
		return null;
	}

	try {
		return JSON.parse(trimmed);
	} catch {}

	return trimmed
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}

function findLastEvent(text, type) {
	const parsed = parseJsonOutput(text);
	const rows = Array.isArray(parsed) ? parsed : [parsed].filter(Boolean);
	return rows.findLast(
		(row) => row?.type === type || row?.event === type || row?.status === type,
	);
}

async function buildCap() {
	if (process.env.CAP_VERIFY_SKIP_BUILD === "1" && fs.existsSync(capBin)) {
		return;
	}
	await runCommand("cargo-build-cap", "cargo", ["build", "-p", "cap"]);
}

async function getTargets() {
	const targetsTimeoutMs = Number(
		process.env.CAP_VERIFY_TARGETS_TIMEOUT_MS || "30000",
	);
	const screens =
		parseJsonOutput(
			(
				await runCommand(
					"targets-screens",
					capBin,
					["--json", "targets", "screens"],
					{ timeoutMs: targetsTimeoutMs },
				)
			).stdout,
		) || [];
	const cameras = process.env.CAP_VERIFY_CAMERA_ID
		? [{ deviceId: process.env.CAP_VERIFY_CAMERA_ID }]
		: parseJsonOutput(
				(
					await runCommand(
						"targets-cameras",
						capBin,
						["--json", "targets", "cameras"],
						{ timeoutMs: targetsTimeoutMs },
					)
				).stdout,
			) || [];
	const mics = process.env.CAP_VERIFY_MIC_NAME
		? [{ name: process.env.CAP_VERIFY_MIC_NAME }]
		: parseJsonOutput(
				(
					await runCommand(
						"targets-mics",
						capBin,
						["--json", "targets", "mics"],
						{ timeoutMs: targetsTimeoutMs },
					)
				).stdout,
			) || [];
	return { screens, cameras, mics };
}

function selectTargets(targets) {
	const screenId =
		process.env.CAP_VERIFY_SCREEN_ID || targets.screens[0]?.id?.toString();
	const screenName =
		process.env.CAP_VERIFY_DESKTOP_SCREEN_NAME || targets.screens[0]?.name;
	const cameraId =
		process.env.CAP_VERIFY_CAMERA_ID || targets.cameras[0]?.deviceId;
	const micName = process.env.CAP_VERIFY_MIC_NAME || targets.mics[0]?.name;

	if (!screenId) {
		throw new Error(
			"No screen target found. Set CAP_VERIFY_SCREEN_ID to run screen recording verification.",
		);
	}
	if (!cameraId) {
		throw new Error(
			"No camera target found. Set CAP_VERIFY_CAMERA_ID to run camera verification.",
		);
	}
	if (!micName) {
		throw new Error(
			"No microphone target found. Set CAP_VERIFY_MIC_NAME to run microphone verification.",
		);
	}

	return { screenId, screenName, cameraId, micName };
}

async function recordForeground(selected) {
	const projectPath = path.join(runDir, "cli-foreground.cap");
	await runCommand("cli-foreground-record", capBin, [
		"--log-level",
		"debug",
		"--json",
		"record",
		"start",
		"--screen",
		selected.screenId,
		"--path",
		projectPath,
		"--duration",
		String(recordingSeconds),
		"--fps",
		"30",
	]);
	summary.flows.push({ name: "cli-foreground-studio", projectPath });
	return projectPath;
}

async function recordDetached(selected) {
	const projectPath = path.join(runDir, "cli-detached.cap");
	const started = await runCommand("cli-detached-start", capBin, [
		"--log-level",
		"debug",
		"--json",
		"record",
		"start",
		"--screen",
		selected.screenId,
		"--path",
		projectPath,
		"--fps",
		"30",
		"--detach",
	]);
	const event =
		findLastEvent(started.stdout, "Started") ||
		findLastEvent(started.stdout, "started");
	const recordingId = event?.recordingId || event?.recording_id;
	if (!recordingId) {
		throw new Error(
			`Could not read detached recording id from ${started.stdoutPath}`,
		);
	}
	await sleep(recordingSeconds * 1000);
	await runCommand("cli-detached-stop", capBin, [
		"--log-level",
		"debug",
		"--json",
		"record",
		"stop",
		"--id",
		recordingId,
		"--timeout",
		"60",
	]);
	summary.flows.push({
		name: "cli-detached-start-stop",
		projectPath,
		recordingId,
	});
	return projectPath;
}

async function recordCameraMic(selected) {
	const projectPath = path.join(runDir, "cli-screen-camera-mic.cap");
	const args = [
		"--log-level",
		"debug",
		"--json",
		"record",
		"start",
		"--screen",
		selected.screenId,
		"--camera",
		selected.cameraId,
		"--mic",
		selected.micName,
		"--path",
		projectPath,
		"--duration",
		String(recordingSeconds),
		"--fps",
		"30",
	];
	if (includeSystemAudio) {
		args.push("--system-audio");
	}
	await runCommand("cli-screen-camera-mic-record", capBin, args);
	summary.flows.push({
		name: "cli-screen-camera-mic",
		projectPath,
		systemAudio: includeSystemAudio,
	});
	return projectPath;
}

async function validateProject(projectPath) {
	const result = await runCommand(
		`validate-${path.basename(projectPath, ".cap")}`,
		capBin,
		["--json", "project", "validate", projectPath],
	);
	const parsed = parseJsonOutput(result.stdout);
	summary.projects.push({ projectPath, validation: parsed });
}

async function probeMedia(projectPath) {
	const mediaFiles = await listMedia(projectPath);
	for (const mediaPath of mediaFiles) {
		const name = `ffprobe-${path.basename(projectPath, ".cap")}-${path.basename(mediaPath).replaceAll(".", "-")}`;
		const result = await runCommand(name, ffprobeBin, [
			"-v",
			"error",
			"-show_format",
			"-show_streams",
			"-print_format",
			"json",
			mediaPath,
		]);
		summary.media.push({
			projectPath,
			mediaPath,
			probe: parseJsonOutput(result.stdout),
		});
	}
}

async function exportProject(projectPath) {
	const output = path.join(runDir, `${path.basename(projectPath, ".cap")}.mp4`);
	const result = await runCommand(
		`export-${path.basename(projectPath, ".cap")}`,
		capBin,
		[
			"--log-level",
			"debug",
			"--json",
			"export",
			projectPath,
			"--output",
			output,
		],
	);
	const probeResult = await runCommand(
		`ffprobe-export-${path.basename(projectPath, ".cap")}`,
		ffprobeBin,
		[
			"-v",
			"error",
			"-show_format",
			"-show_streams",
			"-print_format",
			"json",
			output,
		],
	);
	summary.exports.push({
		projectPath,
		output,
		result: parseJsonOutput(result.stdout),
		probe: parseJsonOutput(probeResult.stdout),
	});
}

async function listMedia(dir) {
	const result = [];
	const names = await readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const entry of names) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			result.push(...(await listMedia(entryPath)));
		} else if (/\.(mp4|m4s|ogg|m4a|mp3|wav|mov)$/i.test(entry.name)) {
			result.push(entryPath);
		}
	}
	return result.sort();
}

async function snapshotDesktopLogs() {
	const date = new Date().toISOString().slice(0, 10);
	const paths = desktopLogDirs.flatMap((desktopLogDir) => [
		path.join(desktopLogDir, `cap-desktop.log.${date}`),
		path.join(desktopLogDir, `cap-desktop-errors.log.${date}`),
		path.join(desktopLogDir, "cap-desktop-panics.log"),
	]);
	const snapshot = new Map();
	for (const filePath of paths) {
		const size = await stat(filePath)
			.then((value) => value.size)
			.catch(() => 0);
		snapshot.set(filePath, size);
	}
	return snapshot;
}

async function captureDesktopLogSlices(snapshot) {
	const files = [];
	for (const [filePath, offset] of snapshot.entries()) {
		const data = await readFile(filePath).catch(() => null);
		if (!data || data.length <= offset) {
			continue;
		}
		const slice = data.subarray(offset);
		const destination = path.join(
			runDir,
			`desktop-${filePath.replaceAll(path.sep, "_")}`,
		);
		await writeFile(destination, slice);
		files.push(destination);
	}
	return files;
}

async function listProjects(dirs) {
	const projects = [];
	for (const dir of dirs) {
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (entry.isDirectory() && entry.name.endsWith(".cap")) {
				projects.push(path.join(dir, entry.name));
			}
		}
	}
	return projects;
}

async function verifyDesktop(selected, desktopLogSnapshot) {
	if (!desktopEnabled) {
		return [];
	}
	if (!selected.screenName) {
		throw new Error(
			"Desktop verification needs a screen name. Set CAP_VERIFY_DESKTOP_SCREEN_NAME.",
		);
	}

	await signDesktopAppIfNeeded();
	await launchDesktopApp();
	const before = new Set(await listProjects(desktopRecordingDirs));
	const startAction = {
		start_recording: {
			capture_mode: { screen: selected.screenName },
			camera: { DeviceID: selected.cameraId },
			mic_label: selected.micName,
			capture_system_audio: includeSystemAudio,
			mode: "studio",
		},
	};
	await openDeepLink("desktop-start-recording", startAction);
	await sleep(desktopRecordingSeconds * 1000);
	await openDeepLink("desktop-stop-recording", "stop_recording");

	const projectPath = await waitForDesktopProject(before);
	await openDeepLink("desktop-open-editor", {
		open_editor: { project_path: projectPath },
	});
	await sleep(Number(process.env.CAP_VERIFY_EDITOR_WAIT_MS || "5000"));

	const logSlices = await captureDesktopLogSlices(desktopLogSnapshot);
	summary.desktop.projects.push(projectPath);
	summary.flows.push({
		name: "desktop-deeplink-screen-camera-mic",
		projectPath,
		systemAudio: includeSystemAudio,
		recordingSeconds: desktopRecordingSeconds,
		logSlices,
	});
	return [projectPath];
}

async function signDesktopAppIfNeeded() {
	if (!signDesktopApp || !desktopAppPath || process.platform !== "darwin") {
		return;
	}

	if (!fs.existsSync(desktopAppPath)) {
		throw new Error(`Desktop app path does not exist: ${desktopAppPath}`);
	}

	const signature = await runCommand(
		"desktop-codesign-check",
		"codesign",
		["-dv", "--verbose=4", desktopAppPath],
		{ allowFailure: true },
	);
	const verification = await runCommand(
		"desktop-codesign-verify",
		"codesign",
		["--verify", "--deep", "--strict", desktopAppPath],
		{ allowFailure: true },
	);
	if (
		signature.code === 0 &&
		verification.code === 0 &&
		signature.stderr.includes(`Identifier=${desktopBundleId}`)
	) {
		return;
	}

	if (!fs.existsSync(desktopEntitlementsPath)) {
		throw new Error(
			`Desktop entitlements path does not exist: ${desktopEntitlementsPath}`,
		);
	}

	await runCommand("desktop-codesign", "codesign", [
		"--force",
		"--deep",
		"--sign",
		"-",
		"--identifier",
		desktopBundleId,
		"--entitlements",
		desktopEntitlementsPath,
		desktopAppPath,
	]);
}

async function openDeepLink(name, action) {
	const value = JSON.stringify(action);
	const url = `cap-desktop://action?value=${encodeURIComponent(value)}`;
	if (desktopExecPath) {
		await runCommand(name, desktopExecPath, [url]);
		return;
	}

	const args = desktopAppPath
		? ["-a", desktopAppPath, url]
		: ["-b", desktopBundleId, url];
	await runCommand(name, "open", args);
}

async function launchDesktopApp() {
	if (desktopExecPath) {
		const stdoutPath = outputPath("desktop-launch-exec", "stdout");
		const stderrPath = outputPath("desktop-launch-exec", "stderr");
		summary.desktop.execStdoutPath = stdoutPath;
		summary.desktop.execStderrPath = stderrPath;
		const stdoutFd = fs.openSync(stdoutPath, "a");
		const stderrFd = fs.openSync(stderrPath, "a");
		const child = spawn(desktopExecPath, [], {
			cwd: root,
			env: process.env,
			detached: true,
			stdio: ["ignore", stdoutFd, stderrFd],
		});
		fs.closeSync(stdoutFd);
		fs.closeSync(stderrFd);
		child.unref();
		summary.desktop.execPid = child.pid;
		await sleep(
			Number(process.env.CAP_VERIFY_DESKTOP_LAUNCH_WAIT_MS || "5000"),
		);
		return;
	}

	if (!desktopAppPath) {
		return;
	}

	await runCommand("desktop-launch-app", "open", [desktopAppPath]);
	await sleep(Number(process.env.CAP_VERIFY_DESKTOP_LAUNCH_WAIT_MS || "5000"));
}

async function waitForDesktopProject(before) {
	const deadline =
		Date.now() + Number(process.env.CAP_VERIFY_DESKTOP_TIMEOUT_MS || "120000");
	while (Date.now() < deadline) {
		const projects = await listProjects(desktopRecordingDirs);
		const next = projects.filter((projectPath) => !before.has(projectPath));
		if (next.length > 0) {
			next.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
			return next[0];
		}
		await sleep(1000);
	}
	throw new Error("Timed out waiting for desktop recording project.");
}

async function scanLogs(extraFiles = []) {
	const files = [
		...commandOutputs
			.filter((output) => !output.name.startsWith("cargo-build"))
			.map((output) => output.stderrPath),
		summary.desktop.execStdoutPath,
		summary.desktop.execStderrPath,
		...extraFiles,
	].filter(Boolean);
	for (const project of summary.flows
		.map((flow) => flow.projectPath)
		.filter(Boolean)) {
		const detachedLog = path.join(project, "detached-session.log");
		if (fs.existsSync(detachedLog)) {
			files.push(detachedLog);
		}
		const recordingLog = path.join(project, "recording-logs.log");
		if (fs.existsSync(recordingLog)) {
			files.push(recordingLog);
		}
	}

	const patterns = [
		/\bWARN\b/i,
		/\bERROR\b/i,
		/panic/i,
		/orphan/i,
		/recoverable segments/i,
		/Successfully recovered recording/i,
		/Validating recovered/i,
		/No frames decoded/i,
		/packet duration/i,
		/non-?monoton/i,
		/\bDTS\b/i,
		/actor unreachable/i,
		/RecvError/i,
		/sender disconnected/i,
		/window id is not visible/i,
		/timed out/i,
	];

	for (const filePath of files) {
		const text = await readFile(filePath, "utf8").catch(() => "");
		const matches = [];
		for (const [index, line] of text.split(/\r?\n/).entries()) {
			if (patterns.some((pattern) => pattern.test(line))) {
				matches.push({ line: index + 1, text: line });
			}
		}
		if (matches.length > 0) {
			summary.logScan.push({ filePath, matches });
		}
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

let desktopLogSnapshot;
try {
	await buildCap();
	desktopLogSnapshot = await snapshotDesktopLogs();
	const doctorResult = await runCommand("doctor", capBin, ["--json", "doctor"]);
	summary.doctor = parseJsonOutput(doctorResult.stdout);
	if (!skipCli && summary.doctor?.captureReady === false) {
		await writeSummary();
		throw new Error(
			`CLI recording is not capture-ready. See ${doctorResult.stdoutPath}`,
		);
	}
	const targets = await getTargets();
	await writeFile(
		path.join(runDir, "targets.selected.json"),
		`${JSON.stringify(targets, null, 2)}\n`,
	);
	const selected = selectTargets(targets);
	await writeFile(
		path.join(runDir, "selection.json"),
		`${JSON.stringify(selected, null, 2)}\n`,
	);

	const projects = [];
	if (!skipCli) {
		projects.push(await recordForeground(selected));
		projects.push(await recordDetached(selected));
		projects.push(await recordCameraMic(selected));
	}
	projects.push(...(await verifyDesktop(selected, desktopLogSnapshot)));

	for (const projectPath of projects) {
		await validateProject(projectPath);
		await probeMedia(projectPath);
		await exportProject(projectPath);
	}

	const desktopLogSlices = desktopEnabled
		? await captureDesktopLogSlices(desktopLogSnapshot)
		: [];
	await scanLogs(desktopLogSlices);
	await writeSummary();

	if (summary.logScan.length > 0) {
		console.error(
			`Recording verification completed with suspicious log lines. See ${summaryPath}`,
		);
		process.exit(1);
	}

	console.log(`Recording verification completed cleanly: ${summaryPath}`);
} catch (error) {
	summary.error = serializeError(error);
	if (desktopLogSnapshot) {
		const desktopLogSlices = desktopEnabled
			? await captureDesktopLogSlices(desktopLogSnapshot).catch(() => [])
			: [];
		await scanLogs(desktopLogSlices).catch((scanError) => {
			summary.logScanError = serializeError(scanError);
		});
	}
	await writeSummary().catch(() => {});
	const message = error instanceof Error ? error.message : String(error);
	console.error(
		`Recording verification failed: ${message}. See ${summaryPath}`,
	);
	process.exit(1);
}

function serializeError(error) {
	if (error instanceof Error) {
		return {
			message: error.message,
			stack: error.stack,
		};
	}
	return { message: String(error) };
}

async function writeSummary() {
	await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}
