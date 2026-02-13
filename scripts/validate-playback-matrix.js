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
		requiredCells: [],
		requiredFormats: [],
		useDefaultMatrix: true,
	};

	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
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
		if (arg === "--require-cell") {
			const value = argv[++i];
			if (!value) throw new Error("Missing value for --require-cell");
			options.requiredCells.push(parseCell(value));
			options.useDefaultMatrix = false;
			continue;
		}
		if (arg === "--require-formats") {
			const value = argv[++i];
			if (!value) throw new Error("Missing value for --require-formats");
			options.requiredFormats = value
				.split(",")
				.map((entry) => entry.trim().toLowerCase())
				.filter(Boolean);
			continue;
		}
		if (arg === "--no-default-matrix") {
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

function printUsage() {
	console.log(`Usage: node scripts/validate-playback-matrix.js --input <file-or-dir> [--input <file-or-dir> ...] [--require-cell platform:gpu:scenario ...] [--require-formats mp4,fragmented]

Validates that required benchmark matrix cells are present in playback benchmark JSON results.

Options:
  --input, -i            JSON file or directory containing JSON files (repeatable)
  --require-cell         Required cell as platform:gpu:scenario (repeatable)
  --require-formats      Comma-separated required formats per cell
  --no-default-matrix    Disable built-in required matrix
  --help, -h             Show help`);
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

function keyForCell(cell) {
	return `${cell.platform}|${cell.gpu}|${cell.scenario}`;
}

function collectObservedCells(files) {
	const observed = new Map();
	for (const filePath of files) {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		const notes = parseNotes(parsed.notes);
		const platform = notes.platform ?? "unknown";
		const gpu = notes.gpu ?? "unknown";
		const scenario = notes.scenario ?? "unspecified";
		const key = keyForCell({ platform, gpu, scenario });
		if (!observed.has(key)) {
			observed.set(key, {
				platform,
				gpu,
				scenario,
				formats: new Set(),
				files: new Set(),
			});
		}
		const entry = observed.get(key);
		entry.files.add(filePath);
		const reports = Array.isArray(parsed.reports) ? parsed.reports : [];
		for (const report of reports) {
			entry.formats.add(report.is_fragmented ? "fragmented" : "mp4");
		}
	}
	return observed;
}

function main() {
	const options = parseArgs(process.argv);
	if (options.help) {
		printUsage();
		return;
	}
	if (options.inputs.length === 0) {
		throw new Error("At least one --input is required");
	}

	const files = new Set();
	for (const input of options.inputs) {
		for (const filePath of collectJsonFiles(input)) {
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
		throw new Error("No required matrix cells configured");
	}

	const observed = collectObservedCells([...files]);
	const missingCells = [];
	const formatFailures = [];

	for (const cell of requiredCells) {
		const key = keyForCell(cell);
		const observedCell = observed.get(key);
		if (!observedCell) {
			missingCells.push(cell);
			continue;
		}
		for (const requiredFormat of options.requiredFormats) {
			if (!observedCell.formats.has(requiredFormat)) {
				formatFailures.push({
					...cell,
					requiredFormat,
					observedFormats: [...observedCell.formats],
				});
			}
		}
	}

	console.log(`Validated ${requiredCells.length} required cells`);
	console.log(`Observed ${observed.size} unique cells`);

	if (missingCells.length > 0) {
		console.log("Missing required cells:");
		for (const cell of missingCells) {
			console.log(`  - ${cell.platform}:${cell.gpu}:${cell.scenario}`);
		}
	}

	if (formatFailures.length > 0) {
		console.log("Missing required formats:");
		for (const failure of formatFailures) {
			console.log(
				`  - ${failure.platform}:${failure.gpu}:${failure.scenario} missing ${failure.requiredFormat} (observed: ${failure.observedFormats.join(", ") || "none"})`,
			);
		}
	}

	if (missingCells.length > 0 || formatFailures.length > 0) {
		process.exit(1);
	}

	console.log("Matrix validation passed");
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
