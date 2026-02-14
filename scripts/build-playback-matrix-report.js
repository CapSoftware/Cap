#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const DEFAULT_REQUIRED_CELLS = [
	{ platform: "macos-13", gpu: "apple-silicon", scenario: "full" },
	{ platform: "macos-13", gpu: "apple-silicon", scenario: "scrub" },
	{ platform: "windows-11", gpu: "nvidia-discrete", scenario: "full" },
	{ platform: "windows-11", gpu: "nvidia-discrete", scenario: "scrub" },
	{ platform: "windows-11", gpu: "amd-discrete", scenario: "full" },
	{ platform: "windows-11", gpu: "amd-discrete", scenario: "scrub" },
	{ platform: "windows-11", gpu: "integrated", scenario: "full" },
	{ platform: "windows-11", gpu: "integrated", scenario: "scrub" },
];

function parseArgs(argv) {
	const options = {
		inputs: [],
		output: null,
		useDefaultMatrix: true,
		requiredCells: [],
	};

	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") continue;
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		if (arg === "--input" || arg === "-i") {
			const value = argv[++i];
			if (!value) throw new Error("Missing value for --input");
			options.inputs.push(path.resolve(value));
			continue;
		}
		if (arg === "--output" || arg === "-o") {
			const value = argv[++i];
			if (!value) throw new Error("Missing value for --output");
			options.output = path.resolve(value);
			continue;
		}
		if (arg === "--no-default-matrix") {
			options.useDefaultMatrix = false;
			continue;
		}
		if (arg === "--require-cell") {
			const value = argv[++i];
			if (!value) throw new Error("Missing value for --require-cell");
			options.requiredCells.push(parseCell(value));
			options.useDefaultMatrix = false;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

function parseCell(value) {
	const [platform, gpu, scenario] = value.split(":");
	if (!platform || !gpu || !scenario) {
		throw new Error(
			`Invalid --require-cell format: ${value}. Expected platform:gpu:scenario`,
		);
	}
	return { platform, gpu, scenario };
}

function usage() {
	console.log(`Usage: node scripts/build-playback-matrix-report.js --input <file-or-dir> [--input <file-or-dir> ...] [--output <file>]

Builds a concise playback matrix markdown report from playback benchmark JSON outputs.`);
}

function collectJsonFiles(targetPath) {
	if (!fs.existsSync(targetPath)) {
		throw new Error(`Input path does not exist: ${targetPath}`);
	}

	const stats = fs.statSync(targetPath);
	if (stats.isFile()) {
		return targetPath.endsWith(".json") ? [targetPath] : [];
	}

	const files = [];
	for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
		const fullPath = path.join(targetPath, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectJsonFiles(fullPath));
		} else if (entry.isFile() && entry.name.endsWith(".json")) {
			files.push(fullPath);
		}
	}
	return files;
}

function parseNotes(notes) {
	if (!notes) return {};
	const result = {};
	for (const token of notes.split(/\s+/)) {
		if (!token.includes("=")) continue;
		const [key, ...rest] = token.split("=");
		const value = rest.join("=");
		if (!key || !value) continue;
		result[key.trim()] = value.trim();
	}
	return result;
}

function cellKey(platform, gpu, scenario) {
	return `${platform}|${gpu}|${scenario}`;
}

function platformGpuKey(platform, gpu) {
	return `${platform}|${gpu}`;
}

function timestampOrEpoch(value) {
	const parsed = Date.parse(value ?? "");
	return Number.isNaN(parsed) ? 0 : parsed;
}

function upsertLatestCell(cells, candidate) {
	const key = cellKey(candidate.platform, candidate.gpu, candidate.scenario);
	const existing = cells.get(key);
	if (
		!existing ||
		timestampOrEpoch(candidate.generatedAt) >=
			timestampOrEpoch(existing.generatedAt)
	) {
		cells.set(key, candidate);
	}
}

function collectData(files) {
	const latestCells = new Map();
	const formatCoverage = new Map();

	for (const filePath of files) {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		const notes = parseNotes(parsed.notes);
		const platform = notes.platform ?? "unknown";
		const gpu = notes.gpu ?? "unknown";
		const scenario = notes.scenario ?? "unspecified";
		const reports = Array.isArray(parsed.reports) ? parsed.reports : [];
		const pass = reports.every((report) => report.overall_passed === true);
		const generatedAt = parsed.generated_at_utc ?? "";

		const formats = new Set();
		for (const report of reports) {
			formats.add(report.is_fragmented ? "fragmented" : "mp4");
		}

		upsertLatestCell(latestCells, {
			platform,
			gpu,
			scenario,
			pass,
			generatedAt,
			filePath,
			formats,
		});

		const pgKey = platformGpuKey(platform, gpu);
		if (!formatCoverage.has(pgKey)) {
			formatCoverage.set(pgKey, new Set());
		}
		for (const format of formats) {
			formatCoverage.get(pgKey).add(format);
		}
	}

	return { latestCells, formatCoverage };
}

function formatStatus(entry) {
	if (!entry) return "MISSING";
	return entry.pass ? "PASS" : "FAIL";
}

function formatCoverageStatus(formats, target) {
	if (!formats || !formats.has(target)) return "NO";
	return "YES";
}

function buildReport(requiredCells, latestCells, formatCoverage) {
	const platformGpuPairs = new Map();
	for (const cell of requiredCells) {
		const key = platformGpuKey(cell.platform, cell.gpu);
		if (!platformGpuPairs.has(key)) {
			platformGpuPairs.set(key, { platform: cell.platform, gpu: cell.gpu });
		}
	}

	const rows = [];
	let missingCount = 0;
	let failCount = 0;
	for (const { platform, gpu } of platformGpuPairs.values()) {
		const full = latestCells.get(cellKey(platform, gpu, "full"));
		const scrub = latestCells.get(cellKey(platform, gpu, "scrub"));
		const formats = formatCoverage.get(platformGpuKey(platform, gpu));
		const fullStatus = formatStatus(full);
		const scrubStatus = formatStatus(scrub);
		if (fullStatus === "MISSING" || scrubStatus === "MISSING") {
			missingCount += 1;
		}
		if (fullStatus === "FAIL" || scrubStatus === "FAIL") {
			failCount += 1;
		}
		rows.push({
			platform,
			gpu,
			fullStatus,
			scrubStatus,
			mp4: formatCoverageStatus(formats, "mp4"),
			fragmented: formatCoverageStatus(formats, "fragmented"),
			fullTime: full?.generatedAt ?? "n/a",
			scrubTime: scrub?.generatedAt ?? "n/a",
		});
	}

	let markdown = "";
	markdown += "# Playback Matrix Status Report\n\n";
	markdown += `Generated: ${new Date().toISOString()}\n\n`;
	markdown += `Rows: ${rows.length}, Missing rows: ${missingCount}, Rows with failures: ${failCount}\n\n`;
	markdown +=
		"| Platform | GPU | Full | Scrub | MP4 Seen | Fragmented Seen | Full Timestamp | Scrub Timestamp |\n";
	markdown += "|---|---|---|---|---|---|---|---|\n";
	for (const row of rows) {
		markdown += `| ${row.platform} | ${row.gpu} | ${row.fullStatus} | ${row.scrubStatus} | ${row.mp4} | ${row.fragmented} | ${row.fullTime} | ${row.scrubTime} |\n`;
	}
	markdown += "\n";

	const missingCells = requiredCells.filter((cell) => {
		return !latestCells.has(cellKey(cell.platform, cell.gpu, cell.scenario));
	});
	if (missingCells.length > 0) {
		markdown += "## Missing Cells\n\n";
		for (const cell of missingCells) {
			markdown += `- ${cell.platform}:${cell.gpu}:${cell.scenario}\n`;
		}
		markdown += "\n";
	}

	return markdown;
}

function main() {
	const options = parseArgs(process.argv);
	if (options.help) {
		usage();
		return;
	}
	if (options.inputs.length === 0) {
		throw new Error("At least one --input is required");
	}

	const files = new Set();
	for (const inputPath of options.inputs) {
		for (const filePath of collectJsonFiles(inputPath)) {
			files.add(filePath);
		}
	}
	if (files.size === 0) {
		throw new Error("No JSON files found");
	}

	const requiredCells = options.useDefaultMatrix
		? [...DEFAULT_REQUIRED_CELLS, ...options.requiredCells]
		: options.requiredCells;
	if (requiredCells.length === 0) {
		throw new Error("No required cells configured");
	}

	const { latestCells, formatCoverage } = collectData([...files]);
	const report = buildReport(requiredCells, latestCells, formatCoverage);

	if (options.output) {
		fs.writeFileSync(options.output, report, "utf8");
		console.log(`Wrote matrix report to ${options.output}`);
	} else {
		process.stdout.write(report);
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
