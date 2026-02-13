#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
	const options = {
		platform: null,
		gpu: null,
		outputDir: null,
		fps: 60,
		recordingPath: null,
		inputDir: null,
		validate: true,
		requireFormats: [],
	};

	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		if (arg === "--platform") {
			options.platform = argv[++i] ?? null;
			continue;
		}
		if (arg === "--gpu") {
			options.gpu = argv[++i] ?? null;
			continue;
		}
		if (arg === "--output-dir") {
			options.outputDir = argv[++i] ?? null;
			continue;
		}
		if (arg === "--fps") {
			const value = Number.parseInt(argv[++i] ?? "", 10);
			if (!Number.isFinite(value) || value <= 0) {
				throw new Error("Invalid --fps value");
			}
			options.fps = value;
			continue;
		}
		if (arg === "--recording-path") {
			options.recordingPath = argv[++i] ?? null;
			continue;
		}
		if (arg === "--input-dir") {
			options.inputDir = argv[++i] ?? null;
			continue;
		}
		if (arg === "--skip-validate") {
			options.validate = false;
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
	console.log(`Usage: node scripts/run-playback-benchmark-matrix.js --platform <name> --gpu <name> --output-dir <dir> [--fps 60] [--recording-path <path>] [--input-dir <path>] [--require-formats mp4,fragmented]

Runs playback benchmark matrix scenarios and writes JSON outputs.

Required:
  --platform      Platform label (for notes metadata)
  --gpu           GPU label (for notes metadata)
  --output-dir    Directory for benchmark JSON outputs

Optional:
  --fps           FPS for benchmark runs (default: 60)
  --recording-path  Specific recording path
  --input-dir       Recording discovery directory
  --require-formats Required formats for local validation (comma-separated)
  --skip-validate   Skip post-run validation`);
}

function run(command, args) {
	const result = spawnSync(command, args, { stdio: "inherit" });
	if (result.status !== 0) {
		throw new Error(`Command failed: ${command} ${args.join(" ")}`);
	}
}

function scenarioOutputPath(outputDir, platform, gpu, scenario) {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(outputDir, `${stamp}-${platform}-${gpu}-${scenario}.json`);
}

function scenarioArgs(options, scenario) {
	const jsonOutput = scenarioOutputPath(
		options.outputDir,
		options.platform,
		options.gpu,
		scenario,
	);
	const notes = `platform=${options.platform} gpu=${options.gpu} scenario=${scenario}`;

	const args = [
		"run",
		"-p",
		"cap-recording",
		"--example",
		"playback-test-runner",
		"--",
		scenario,
		"--fps",
		String(options.fps),
		"--json-output",
		jsonOutput,
		"--notes",
		notes,
	];

	if (options.recordingPath) {
		args.push("--recording-path", options.recordingPath);
	} else if (options.inputDir) {
		args.push("--input-dir", options.inputDir);
	}

	return args;
}

function validateOptions(options) {
	if (!options.platform || !options.gpu || !options.outputDir) {
		throw new Error("Missing required options: --platform, --gpu, --output-dir");
	}

	const absoluteOutputDir = path.resolve(options.outputDir);
	options.outputDir = absoluteOutputDir;
	if (!fs.existsSync(absoluteOutputDir)) {
		fs.mkdirSync(absoluteOutputDir, { recursive: true });
	}
}

function main() {
	const options = parseArgs(process.argv);
	if (options.help) {
		usage();
		return;
	}

	validateOptions(options);

	console.log(`Running matrix for platform=${options.platform} gpu=${options.gpu}`);
	run("cargo", scenarioArgs(options, "full"));
	run("cargo", scenarioArgs(options, "scrub"));

	const aggregatePath = path.join(
		options.outputDir,
		`${options.platform}-${options.gpu}-aggregate.md`,
	);
	run("node", [
		"scripts/aggregate-playback-benchmarks.js",
		"--input",
		options.outputDir,
		"--output",
		aggregatePath,
	]);
	console.log(`Aggregate markdown: ${aggregatePath}`);

	if (options.validate) {
		const validateArgs = [
			"scripts/validate-playback-matrix.js",
			"--input",
			options.outputDir,
			"--no-default-matrix",
			"--require-cell",
			`${options.platform}:${options.gpu}:full`,
			"--require-cell",
			`${options.platform}:${options.gpu}:scrub`,
		];

		if (options.requireFormats.length > 0) {
			validateArgs.push("--require-formats", options.requireFormats.join(","));
		}

		run("node", validateArgs);
		console.log("Matrix run validation passed");
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
