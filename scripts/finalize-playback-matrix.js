#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
	const options = {
		inputs: [],
		outputDir: null,
		requireFormats: [],
		targetFps: 60,
		maxScrubP95Ms: 40,
		maxStartupMs: 250,
		analyze: true,
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
		if (arg === "--output-dir" || arg === "-o") {
			const value = argv[++i];
			if (!value) throw new Error("Missing value for --output-dir");
			options.outputDir = path.resolve(value);
			continue;
		}
		if (arg === "--require-formats") {
			const value = argv[++i] ?? "";
			options.requireFormats = value
				.split(",")
				.map((entry) => entry.trim().toLowerCase())
				.filter(Boolean);
			continue;
		}
		if (arg === "--target-fps") {
			const value = Number.parseFloat(argv[++i] ?? "");
			if (!Number.isFinite(value) || value <= 0) {
				throw new Error("Invalid --target-fps value");
			}
			options.targetFps = value;
			continue;
		}
		if (arg === "--max-scrub-p95-ms") {
			const value = Number.parseFloat(argv[++i] ?? "");
			if (!Number.isFinite(value) || value <= 0) {
				throw new Error("Invalid --max-scrub-p95-ms value");
			}
			options.maxScrubP95Ms = value;
			continue;
		}
		if (arg === "--max-startup-ms") {
			const value = Number.parseFloat(argv[++i] ?? "");
			if (!Number.isFinite(value) || value <= 0) {
				throw new Error("Invalid --max-startup-ms value");
			}
			options.maxStartupMs = value;
			continue;
		}
		if (arg === "--skip-analyze") {
			options.analyze = false;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

function usage() {
	console.log(`Usage: node scripts/finalize-playback-matrix.js --input <file-or-dir> [--input <file-or-dir> ...] --output-dir <dir> [--require-formats mp4,fragmented] [--target-fps 60] [--max-scrub-p95-ms 40] [--max-startup-ms 250]

Generates aggregate markdown, status markdown, validation JSON, and bottleneck analysis for collected playback matrix outputs.`);
}

function run(command, args) {
	const result = spawnSync(command, args, { stdio: "inherit" });
	if (result.status !== 0) {
		throw new Error(`Command failed: ${command} ${args.join(" ")}`);
	}
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
	if (!options.outputDir) {
		throw new Error("--output-dir is required");
	}
	if (!fs.existsSync(options.outputDir)) {
		fs.mkdirSync(options.outputDir, { recursive: true });
	}

	const aggregatePath = path.join(options.outputDir, "playback-benchmark-aggregate.md");
	const statusPath = path.join(options.outputDir, "playback-matrix-status.md");
	const validationPath = path.join(options.outputDir, "playback-matrix-validation.json");
	const bottleneckPath = path.join(options.outputDir, "playback-bottlenecks.md");

	const aggregateArgs = ["scripts/aggregate-playback-benchmarks.js"];
	const statusArgs = ["scripts/build-playback-matrix-report.js"];
	const validateArgs = [
		"scripts/validate-playback-matrix.js",
		"--output-json",
		validationPath,
	];

	for (const input of options.inputs) {
		aggregateArgs.push("--input", input);
		statusArgs.push("--input", input);
		validateArgs.push("--input", input);
	}

	aggregateArgs.push("--output", aggregatePath);
	statusArgs.push("--output", statusPath);
	if (options.requireFormats.length > 0) {
		validateArgs.push("--require-formats", options.requireFormats.join(","));
	}

	run("node", aggregateArgs);
	run("node", statusArgs);
	run("node", validateArgs);
	if (options.analyze) {
		const analyzeArgs = ["scripts/analyze-playback-matrix-bottlenecks.js"];
		for (const input of options.inputs) {
			analyzeArgs.push("--input", input);
		}
		analyzeArgs.push(
			"--output",
			bottleneckPath,
			"--target-fps",
			String(options.targetFps),
			"--max-scrub-p95-ms",
			String(options.maxScrubP95Ms),
			"--max-startup-ms",
			String(options.maxStartupMs),
		);
		run("node", analyzeArgs);
	}

	console.log(`Aggregate markdown: ${aggregatePath}`);
	console.log(`Status markdown: ${statusPath}`);
	console.log(`Validation JSON: ${validationPath}`);
	if (options.analyze) {
		console.log(`Bottleneck analysis: ${bottleneckPath}`);
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
