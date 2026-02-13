#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
	const options = {
		inputs: [],
		outputDir: null,
		requireFormats: [],
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
		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

function usage() {
	console.log(`Usage: node scripts/finalize-playback-matrix.js --input <file-or-dir> [--input <file-or-dir> ...] --output-dir <dir> [--require-formats mp4,fragmented]

Generates aggregate markdown, status markdown, and validation JSON for collected playback matrix outputs.`);
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

	console.log(`Aggregate markdown: ${aggregatePath}`);
	console.log(`Status markdown: ${statusPath}`);
	console.log(`Validation JSON: ${validationPath}`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
