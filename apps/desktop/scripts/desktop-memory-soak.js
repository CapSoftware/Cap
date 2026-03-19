import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
	buildSample,
	DEFAULTS,
	evaluateCycles,
	findCapMainProcess,
	formatMb,
	parsePsOutput,
	pickSettledSample,
} from "./desktop-memory-soak-lib.js";

const HOTKEYS = {
	startStudioRecording: {
		code: "KeyR",
		meta: true,
		ctrl: true,
		alt: true,
		shift: true,
	},
	stopRecording: {
		code: "KeyT",
		meta: true,
		ctrl: true,
		alt: true,
		shift: true,
	},
};

const APPLE_KEY_CODES = {
	KeyR: 15,
	KeyT: 17,
};

const INSTALLED_APP_COMMAND_PREFIX = "/Applications/Cap.app/Contents/MacOS/Cap";

function parseArgs(argv) {
	const options = {
		...DEFAULTS,
		manual: false,
		skipDisplaySleep: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		const next = argv[index + 1];

		if (token === "--help" || token === "-h") {
			options.help = true;
			continue;
		}

		if (!token.startsWith("--")) continue;

		if (token === "--manual") {
			options.manual = true;
			continue;
		}

		if (token === "--skip-display-sleep") {
			options.skipDisplaySleep = true;
			continue;
		}

		const rawValue = token.includes("=")
			? token.slice(token.indexOf("=") + 1)
			: next;

		if (token.startsWith("--app-command-prefix")) {
			options.appCommandPrefix = rawValue;
			if (!token.includes("=")) index += 1;
			continue;
		}

		if (token.startsWith("--store-path")) {
			options.storePath = rawValue;
			if (!token.includes("=")) index += 1;
			continue;
		}

		const value = Number(rawValue);

		if (token.startsWith("--cycles")) {
			options.cycles = value;
			if (!token.includes("=")) index += 1;
			continue;
		}

		if (token.startsWith("--baseline-seconds")) {
			options.baselineSeconds = value;
			if (!token.includes("=")) index += 1;
			continue;
		}

		if (token.startsWith("--settle-seconds")) {
			options.settleSeconds = value;
			if (!token.includes("=")) index += 1;
			continue;
		}

		if (token.startsWith("--interval-seconds")) {
			options.intervalSeconds = value;
			if (!token.includes("=")) index += 1;
			continue;
		}

		if (token.startsWith("--max-cycle-ratchet-mb")) {
			options.maxCycleRatchetMb = value;
			if (!token.includes("=")) index += 1;
			continue;
		}

		if (token.startsWith("--max-total-growth-mb")) {
			options.maxTotalGrowthMb = value;
			if (!token.includes("=")) index += 1;
			continue;
		}

		if (token.startsWith("--new-webkit-window-seconds")) {
			options.newWebKitWindowSeconds = value;
			if (!token.includes("=")) index += 1;
			continue;
		}

		if (token.startsWith("--initial-webkit-window-seconds")) {
			options.initialWebKitWindowSeconds = value;
			if (!token.includes("=")) index += 1;
			continue;
		}

		if (token.startsWith("--recording-seconds")) {
			options.recordingSeconds = value;
			if (!token.includes("=")) index += 1;
			continue;
		}

		if (token.startsWith("--display-sleep-seconds")) {
			options.displaySleepSeconds = value;
			if (!token.includes("=")) index += 1;
			continue;
		}

		if (token.startsWith("--launch-timeout-seconds")) {
			options.launchTimeoutSeconds = value;
			if (!token.includes("=")) index += 1;
			continue;
		}

		if (token.startsWith("--stop-timeout-seconds")) {
			options.stopTimeoutSeconds = value;
			if (!token.includes("=")) index += 1;
		}
	}

	return options;
}

function printHelp() {
	console.log("Cap desktop memory soak test");
	console.log("");
	console.log("Usage:");
	console.log("  pnpm --dir apps/desktop test:memory [options]");
	console.log("");
	console.log("Options:");
	console.log(
		`  --cycles <n>                       default ${DEFAULTS.cycles}`,
	);
	console.log(
		`  --baseline-seconds <n>             default ${DEFAULTS.baselineSeconds}`,
	);
	console.log(
		`  --settle-seconds <n>               default ${DEFAULTS.settleSeconds}`,
	);
	console.log(
		`  --interval-seconds <n>             default ${DEFAULTS.intervalSeconds}`,
	);
	console.log(
		`  --max-cycle-ratchet-mb <n>         default ${DEFAULTS.maxCycleRatchetMb}`,
	);
	console.log(
		`  --max-total-growth-mb <n>          default ${DEFAULTS.maxTotalGrowthMb}`,
	);
	console.log(
		`  --new-webkit-window-seconds <n>    default ${DEFAULTS.newWebKitWindowSeconds}`,
	);
	console.log(
		`  --initial-webkit-window-seconds <n> default ${DEFAULTS.initialWebKitWindowSeconds}`,
	);
	console.log(
		`  --recording-seconds <n>            default ${DEFAULTS.recordingSeconds}`,
	);
	console.log(
		`  --display-sleep-seconds <n>        default ${DEFAULTS.displaySleepSeconds}`,
	);
	console.log(
		`  --launch-timeout-seconds <n>       default ${DEFAULTS.launchTimeoutSeconds}`,
	);
	console.log(
		`  --stop-timeout-seconds <n>         default ${DEFAULTS.stopTimeoutSeconds}`,
	);
	console.log(
		`  --app-command-prefix <path>        default ${DEFAULTS.appCommandPrefix}`,
	);
	console.log(
		`  --store-path <path>                default ${DEFAULTS.storePath}`,
	);
	console.log(
		"  --manual                           keep the old prompt-driven flow",
	);
	console.log(
		"  --skip-display-sleep               skip pmset displaysleepnow",
	);
	console.log("");
	console.log(
		"The script launches the target Cap binary, rewrites the selected store with temporary hotkeys, tracks Cap, WindowServer, related WebKit helpers, and camera/audio daemons, and restores the store afterward.",
	);
	console.log(
		"Quit any other Cap instance before running this so WindowServer noise stays attributable to the dev build.",
	);
}

function readProcesses() {
	const output = execFileSync(
		"ps",
		["-axo", "pid=,rss=,vsz=,etime=,command="],
		{ encoding: "utf8" },
	);

	return parsePsOutput(output);
}

function sampleCount(durationSeconds, intervalSeconds) {
	return Math.max(1, Math.ceil(durationSeconds / intervalSeconds));
}

function renderTopProcesses(sample) {
	return sample.processRows
		.slice(0, 5)
		.map((row) => `${row.label}:${row.pid}:${formatMb(row.rssKb)}`)
		.join("  ");
}

async function collectPhase(name, seconds, intervalSeconds, tracked, options) {
	const samples = [];
	let currentTracked = tracked;
	const totalSamples = sampleCount(seconds, intervalSeconds);

	for (let index = 0; index < totalSamples; index += 1) {
		const sample = buildSample(readProcesses(), currentTracked, options);
		currentTracked = sample.tracked;
		samples.push(sample);

		const newPidSummary =
			sample.newPids.length > 0 ? ` new:${sample.newPids.join(",")}` : "";

		console.log(
			`${name} ${index + 1}/${totalSamples} cap=${formatMb(sample.capTotalKb)} ws=${formatMb(sample.windowServerTotalKb)} media=${formatMb(sample.mediaTotalKb)} total=${formatMb(sample.grandTotalKb)}${newPidSummary}`,
		);
		console.log(`  ${renderTopProcesses(sample)}`);

		if (index < totalSamples - 1) {
			await sleep(intervalSeconds * 1000);
		}
	}

	return {
		samples,
		settled: pickSettledSample(samples, options.trailingSamples),
		tracked: currentTracked,
	};
}

function restoreStore(path, originalStoreContents) {
	writeFileSync(path, originalStoreContents);
}

function writeAutomationStore(path) {
	if (!existsSync(path)) {
		throw new Error(`Store not found: ${path}`);
	}

	const originalStoreContents = readFileSync(path, "utf8");
	const originalStore = JSON.parse(originalStoreContents);
	const nextStore = {
		...originalStore,
		hotkeys: {
			hotkeys: {
				...(originalStore.hotkeys?.hotkeys ?? {}),
				startStudioRecording: HOTKEYS.startStudioRecording,
				stopRecording: HOTKEYS.stopRecording,
			},
		},
		recording_settings: {
			...(originalStore.recording_settings ?? {}),
			mode: "studio",
			target: null,
		},
	};

	writeFileSync(path, `${JSON.stringify(nextStore, null, 2)}\n`);

	return originalStoreContents;
}

function modifiersForHotkey(hotkey) {
	return [
		hotkey.meta ? "command down" : null,
		hotkey.ctrl ? "control down" : null,
		hotkey.alt ? "option down" : null,
		hotkey.shift ? "shift down" : null,
	]
		.filter(Boolean)
		.join(", ");
}

function pressHotkey(hotkey) {
	const keyCode = APPLE_KEY_CODES[hotkey.code];

	if (keyCode === undefined) {
		throw new Error(`Unsupported hotkey code: ${hotkey.code}`);
	}

	execFileSync("osascript", [
		"-e",
		`tell application "System Events" to key code ${keyCode} using {${modifiersForHotkey(hotkey)}}`,
	]);
}

function sleepDisplay() {
	execFileSync("pmset", ["displaysleepnow"]);
}

function listOtherCapProcesses(options) {
	return readProcesses().filter(
		(processInfo) =>
			processInfo.command !== options.appCommandPrefix &&
			(processInfo.command === INSTALLED_APP_COMMAND_PREFIX ||
				processInfo.command ===
					`${INSTALLED_APP_COMMAND_PREFIX} --crash-reporter-server=/tmp/socket` ||
				processInfo.command.startsWith(
					`${INSTALLED_APP_COMMAND_PREFIX} --crash-reporter-server=`,
				) ||
				processInfo.command.endsWith("/target/debug/cap-desktop")),
	);
}

async function waitForApp(options) {
	const deadline = Date.now() + options.launchTimeoutSeconds * 1000;

	while (Date.now() < deadline) {
		const app = findCapMainProcess(readProcesses(), options.appCommandPrefix);

		if (app) return app;

		await sleep(500);
	}

	throw new Error(
		`Cap did not launch within ${options.launchTimeoutSeconds} seconds: ${options.appCommandPrefix}`,
	);
}

async function waitForAppExit(child, timeoutSeconds) {
	const deadline = Date.now() + timeoutSeconds * 1000;

	while (Date.now() < deadline) {
		if (child.exitCode !== null) return;
		await sleep(250);
	}
}

async function stopChild(child, timeoutSeconds) {
	if (!child || child.exitCode !== null) return;

	child.kill("SIGTERM");
	await waitForAppExit(child, timeoutSeconds);

	if (child.exitCode !== null) return;

	child.kill("SIGKILL");
	await waitForAppExit(child, 2);
}

async function runAutomatedCycle(cycle, tracked, options) {
	console.log(`Cycle ${cycle}/${options.cycles}: start recording`);
	pressHotkey(HOTKEYS.startStudioRecording);
	await sleep(options.recordingSeconds * 1000);

	if (!options.skipDisplaySleep) {
		console.log(
			`Cycle ${cycle}/${options.cycles}: sleep display for ${options.displaySleepSeconds}s`,
		);
		sleepDisplay();
		await sleep(options.displaySleepSeconds * 1000);
	}

	console.log(`Cycle ${cycle}/${options.cycles}: stop recording`);
	pressHotkey(HOTKEYS.stopRecording);
	await sleep(1000);
	pressHotkey(HOTKEYS.stopRecording);
	await sleep(3000);

	return collectPhase(
		`cycle-${cycle}`,
		options.settleSeconds,
		options.intervalSeconds,
		tracked,
		options,
	);
}

async function main() {
	if (process.platform !== "darwin") {
		console.error("This soak test only supports macOS.");
		process.exit(1);
	}

	const options = parseArgs(process.argv.slice(2));

	if (options.help) {
		printHelp();
		return;
	}

	const existingTargetProcess = findCapMainProcess(
		readProcesses(),
		options.appCommandPrefix,
	);
	if (existingTargetProcess) {
		throw new Error(
			`Quit the target app before running the soak test: ${options.appCommandPrefix}`,
		);
	}

	const otherCapProcesses = listOtherCapProcesses(options);
	if (otherCapProcesses.length > 0) {
		throw new Error(
			`Quit other Cap processes before running the soak test: ${otherCapProcesses.map((processInfo) => processInfo.command).join(", ")}`,
		);
	}

	let originalStoreContents = null;
	let child = null;
	let cleanupStarted = false;
	const rl = options.manual
		? createInterface({
				input: process.stdin,
				output: process.stdout,
			})
		: null;

	const cleanup = async () => {
		if (cleanupStarted) return;
		cleanupStarted = true;
		await stopChild(child, options.stopTimeoutSeconds);
		if (originalStoreContents !== null) {
			restoreStore(options.storePath, originalStoreContents);
		}
	};

	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.on(signal, () => {
			cleanup()
				.then(() => process.exit(1))
				.catch((error) => {
					console.error(error instanceof Error ? error.message : String(error));
					process.exit(1);
				});
		});
	}

	try {
		originalStoreContents = writeAutomationStore(options.storePath);

		if (!existsSync(options.appCommandPrefix)) {
			throw new Error(`App binary not found: ${options.appCommandPrefix}`);
		}

		child = spawn(options.appCommandPrefix, [], {
			stdio: "ignore",
		});

		await waitForApp(options);
		await sleep(3000);

		let tracked = new Map();

		console.log("Collecting baseline...");
		const baselinePhase = await collectPhase(
			"baseline",
			options.baselineSeconds,
			options.intervalSeconds,
			tracked,
			options,
		);
		tracked = baselinePhase.tracked;

		const baseline = baselinePhase.settled;
		console.log(
			`Baseline settled total=${formatMb(baseline.grandTotalKb)} cap=${formatMb(baseline.capTotalKb)} ws=${formatMb(baseline.windowServerTotalKb)} media=${formatMb(baseline.mediaTotalKb)}`,
		);

		const cycleSettledTotals = [];

		for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
			const phase = options.manual
				? await rl
						.question(
							`Cycle ${cycle}/${options.cycles}: start and stop a recording in Cap, then press Enter.`,
						)
						.then(() =>
							collectPhase(
								`cycle-${cycle}`,
								options.settleSeconds,
								options.intervalSeconds,
								tracked,
								options,
							),
						)
				: await runAutomatedCycle(cycle, tracked, options);
			tracked = phase.tracked;

			const settled = phase.settled;
			cycleSettledTotals.push(settled.grandTotalKb);

			const previousSettled =
				cycle === 1
					? baseline.grandTotalKb
					: cycleSettledTotals[cycleSettledTotals.length - 2];
			const cycleDeltaKb = settled.grandTotalKb - previousSettled;
			const totalDeltaKb = settled.grandTotalKb - baseline.grandTotalKb;
			const newWebContent = settled.processRows
				.filter((row) => row.kind === "webkit-webcontent" && row.isNew)
				.map((row) => row.pid);

			console.log(
				`Settled cycle ${cycle}: total=${formatMb(settled.grandTotalKb)} cap=${formatMb(settled.capTotalKb)} ws=${formatMb(settled.windowServerTotalKb)} media=${formatMb(settled.mediaTotalKb)} delta-prev=${formatMb(cycleDeltaKb)} delta-baseline=${formatMb(totalDeltaKb)}`,
			);

			if (newWebContent.length > 0) {
				console.log(`  new-webcontent=${newWebContent.join(",")}`);
			}
		}

		const failures = evaluateCycles(
			baseline.grandTotalKb,
			cycleSettledTotals,
			options,
		);

		console.log("");
		console.log("Summary");
		console.log(
			`  baseline=${formatMb(baseline.grandTotalKb)} final=${formatMb(cycleSettledTotals[cycleSettledTotals.length - 1] ?? baseline.grandTotalKb)}`,
		);

		if (failures.length === 0) {
			console.log("  result=PASS");
			return;
		}

		console.log("  result=FAIL");

		for (const failure of failures) {
			console.log(
				`  cycle=${failure.cycle} type=${failure.type} value=${formatMb(failure.valueKb)}`,
			);
		}

		process.exitCode = 1;
	} finally {
		await cleanup();
		rl?.close();
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
