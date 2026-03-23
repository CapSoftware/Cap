import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEV_APP_COMMAND_PREFIX = fileURLToPath(
	new URL("../../../target/debug/cap-desktop", import.meta.url),
);
const INSTALLED_APP_COMMAND_PREFIX = "/Applications/Cap.app/Contents/MacOS/Cap";

export const DEFAULTS = {
	appCommandPrefix:
		process.env.CAP_APP_COMMAND_PREFIX ||
		(existsSync(DEV_APP_COMMAND_PREFIX)
			? DEV_APP_COMMAND_PREFIX
			: INSTALLED_APP_COMMAND_PREFIX),
	baselineSeconds: 30,
	cycles: 3,
	initialWebKitWindowSeconds: 180,
	intervalSeconds: 10,
	maxCycleRatchetMb: 128,
	maxTotalGrowthMb: 768,
	newWebKitWindowSeconds: 180,
	recordingSeconds: 20,
	displaySleepSeconds: 20,
	launchTimeoutSeconds: 30,
	stopTimeoutSeconds: 10,
	storePath:
		process.env.CAP_STORE_PATH ||
		`${process.env.HOME}/Library/Application Support/so.cap.desktop.dev/store`,
	settleSeconds: 120,
	trailingSamples: 3,
};

const MEDIA_PROCESS_PATTERNS = [
	["coreaudiod", /\/usr\/sbin\/coreaudiod$/],
	[
		"cmio-host",
		/com\.apple\.cmio\.videodriverkithostextension\.systemextension/,
	],
	["cameracaptured", /\/usr\/libexec\/cameracaptured$/],
	["continuity-agent", /\/usr\/libexec\/ContinuityCaptureAgent(?:\s|$)/],
	["audioaccessoryd", /\/System\/Library\/CoreServices\/audioaccessoryd$/],
	["avconferenced", /\/usr\/libexec\/avconferenced$/],
	["vdcassistant", /\/VDC\.plugin\/Contents\/Resources\/VDCAssistant$/],
];

function toKb(mb) {
	return Math.round(mb * 1024);
}

function parseElapsedSeconds(etime) {
	const parts = etime.split("-");
	const dayPart = parts.length === 2 ? Number(parts[0]) : 0;
	const timePart = parts.length === 2 ? parts[1] : parts[0];
	const segments = timePart.split(":").map(Number);

	let hours = 0;
	let minutes = 0;
	let seconds = 0;

	if (segments.length === 3) {
		[hours, minutes, seconds] = segments;
	} else if (segments.length === 2) {
		[minutes, seconds] = segments;
	}

	return dayPart * 24 * 60 * 60 + hours * 60 * 60 + minutes * 60 + seconds;
}

export function parsePsOutput(output) {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);

			if (!match) return null;

			const [, pid, rssKb, vszKb, etime, command] = match;

			return {
				command,
				etimes: parseElapsedSeconds(etime),
				pid: Number(pid),
				rssKb: Number(rssKb),
				vszKb: Number(vszKb),
			};
		})
		.filter(Boolean);
}

export function classifyProcess(
	command,
	appCommandPrefix = DEFAULTS.appCommandPrefix,
) {
	if (
		command.startsWith(
			"/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer",
		)
	) {
		return {
			group: "system",
			kind: "window-server",
			label: "windowserver",
		};
	}

	if (command === appCommandPrefix) {
		return { group: "cap", kind: "cap-main", label: "cap-main" };
	}

	if (command.startsWith(`${appCommandPrefix} --crash-reporter-server=`)) {
		return { group: "cap", kind: "cap-crash", label: "cap-crash" };
	}

	if (command.includes("com.apple.WebKit.GPU.xpc")) {
		return { group: "cap", kind: "webkit-gpu", label: "wk-gpu" };
	}

	if (command.includes("com.apple.WebKit.Networking.xpc")) {
		return { group: "cap", kind: "webkit-networking", label: "wk-net" };
	}

	if (command.includes("com.apple.WebKit.WebContent.xpc")) {
		return { group: "cap", kind: "webkit-webcontent", label: "wk-webcontent" };
	}

	for (const [label, pattern] of MEDIA_PROCESS_PATTERNS) {
		if (pattern.test(command)) {
			return { group: "media", kind: label, label };
		}
	}

	return null;
}

export function findCapMainProcess(
	processes,
	appCommandPrefix = DEFAULTS.appCommandPrefix,
) {
	return processes
		.filter((processInfo) => processInfo.command === appCommandPrefix)
		.sort((left, right) => right.etimes - left.etimes)[0];
}

export function discoverTrackedProcesses(
	processes,
	tracked,
	options = DEFAULTS,
) {
	const nextTracked = new Map(tracked);
	const capMain = findCapMainProcess(processes, options.appCommandPrefix);

	if (!capMain) {
		throw new Error(
			`No running Cap process found for ${options.appCommandPrefix}`,
		);
	}

	for (const processInfo of processes) {
		const classification = classifyProcess(
			processInfo.command,
			options.appCommandPrefix,
		);

		if (!classification) continue;

		const isAlreadyTracked = nextTracked.has(processInfo.pid);
		const isLongLivedCapWebKit =
			classification.group === "cap" &&
			classification.kind.startsWith("webkit-") &&
			Math.abs(processInfo.etimes - capMain.etimes) <=
				options.initialWebKitWindowSeconds;
		const isFreshCapWebKit =
			classification.group === "cap" &&
			classification.kind.startsWith("webkit-") &&
			processInfo.etimes <= options.newWebKitWindowSeconds;
		const shouldTrack =
			classification.kind === "cap-main" ||
			classification.kind === "cap-crash" ||
			classification.group === "system" ||
			classification.group === "media" ||
			isLongLivedCapWebKit ||
			isFreshCapWebKit;

		if (!shouldTrack) continue;

		nextTracked.set(processInfo.pid, {
			...processInfo,
			...classification,
			isNew: !isAlreadyTracked,
		});
	}

	return nextTracked;
}

export function buildSample(processes, tracked, options = DEFAULTS) {
	const discoveredTracked = discoverTrackedProcesses(
		processes,
		tracked,
		options,
	);
	const liveTracked = new Map();
	let capTotalKb = 0;
	let mediaTotalKb = 0;
	let windowServerTotalKb = 0;
	const processRows = [];
	const newPids = [];

	for (const [pid, trackedProcess] of discoveredTracked.entries()) {
		const liveProcess = processes.find(
			(processInfo) => processInfo.pid === pid,
		);

		if (!liveProcess) continue;

		const row = {
			...trackedProcess,
			etimes: liveProcess.etimes,
			rssKb: liveProcess.rssKb,
			vszKb: liveProcess.vszKb,
		};

		liveTracked.set(pid, row);
		processRows.push(row);

		if (row.group === "cap") capTotalKb += row.rssKb;
		if (row.group === "media") mediaTotalKb += row.rssKb;
		if (row.group === "system") windowServerTotalKb += row.rssKb;
		if (row.isNew) newPids.push(pid);
	}

	processRows.sort((left, right) => right.rssKb - left.rssKb);

	return {
		capTotalKb,
		grandTotalKb: capTotalKb + mediaTotalKb + windowServerTotalKb,
		mediaTotalKb,
		newPids: newPids.sort((left, right) => left - right),
		processRows,
		tracked: liveTracked,
		windowServerTotalKb,
	};
}

export function pickSettledSample(
	samples,
	trailingSamples = DEFAULTS.trailingSamples,
) {
	if (samples.length === 0) {
		throw new Error("Cannot pick a settled sample from an empty set");
	}

	const window = samples.slice(-Math.min(trailingSamples, samples.length));

	return window.reduce((best, sample) =>
		sample.grandTotalKb < best.grandTotalKb ? sample : best,
	);
}

export function evaluateCycles(
	baselineKb,
	settledCycleKbs,
	options = DEFAULTS,
) {
	const maxCycleRatchetKb = toKb(options.maxCycleRatchetMb);
	const maxTotalGrowthKb = toKb(options.maxTotalGrowthMb);
	const failures = [];

	for (let index = 0; index < settledCycleKbs.length; index += 1) {
		const current = settledCycleKbs[index];
		const previous = index === 0 ? baselineKb : settledCycleKbs[index - 1];
		const cycleDeltaKb = current - previous;
		const totalDeltaKb = current - baselineKb;

		if (cycleDeltaKb > maxCycleRatchetKb) {
			failures.push({
				cycle: index + 1,
				type: "cycle-ratchet",
				valueKb: cycleDeltaKb,
			});
		}

		if (totalDeltaKb > maxTotalGrowthKb) {
			failures.push({
				cycle: index + 1,
				type: "total-growth",
				valueKb: totalDeltaKb,
			});
		}
	}

	return failures;
}

export function formatMb(kb) {
	return `${(kb / 1024).toFixed(1)} MB`;
}
