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
		publishTarget: null,
		compareBaselineInputs: [],
		allowFpsDrop: 2,
		allowStartupIncreaseMs: 25,
		allowScrubP95IncreaseMs: 5,
		allowMissingCandidate: false,
		failOnCandidateOnly: false,
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
		if (arg === "--publish-target") {
			const value = argv[++i];
			if (!value) throw new Error("Missing value for --publish-target");
			options.publishTarget = path.resolve(value);
			continue;
		}
		if (arg === "--compare-baseline") {
			const value = argv[++i];
			if (!value) throw new Error("Missing value for --compare-baseline");
			options.compareBaselineInputs.push(path.resolve(value));
			continue;
		}
		if (arg === "--allow-fps-drop") {
			const value = Number.parseFloat(argv[++i] ?? "");
			if (!Number.isFinite(value) || value < 0) {
				throw new Error("Invalid --allow-fps-drop value");
			}
			options.allowFpsDrop = value;
			continue;
		}
		if (arg === "--allow-startup-increase-ms") {
			const value = Number.parseFloat(argv[++i] ?? "");
			if (!Number.isFinite(value) || value < 0) {
				throw new Error("Invalid --allow-startup-increase-ms value");
			}
			options.allowStartupIncreaseMs = value;
			continue;
		}
		if (arg === "--allow-scrub-p95-increase-ms") {
			const value = Number.parseFloat(argv[++i] ?? "");
			if (!Number.isFinite(value) || value < 0) {
				throw new Error("Invalid --allow-scrub-p95-increase-ms value");
			}
			options.allowScrubP95IncreaseMs = value;
			continue;
		}
		if (arg === "--allow-missing-candidate") {
			options.allowMissingCandidate = true;
			continue;
		}
		if (arg === "--fail-on-candidate-only") {
			options.failOnCandidateOnly = true;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

function usage() {
	console.log(`Usage: node scripts/finalize-playback-matrix.js --input <file-or-dir> [--input <file-or-dir> ...] --output-dir <dir> [--require-formats mp4,fragmented] [--target-fps 60] [--max-scrub-p95-ms 40] [--max-startup-ms 250] [--compare-baseline <file-or-dir>] [--allow-fps-drop 2] [--allow-startup-increase-ms 25] [--allow-scrub-p95-increase-ms 5] [--allow-missing-candidate] [--fail-on-candidate-only] [--publish-target <PLAYBACK-BENCHMARKS.md>]

Generates aggregate markdown, status markdown, validation JSON, and bottleneck analysis for collected playback matrix outputs. Optionally compares candidate inputs against baseline inputs and fails on regressions.`);
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

	const aggregatePath = path.join(
		options.outputDir,
		"playback-benchmark-aggregate.md",
	);
	const statusPath = path.join(options.outputDir, "playback-matrix-status.md");
	const validationPath = path.join(
		options.outputDir,
		"playback-matrix-validation.json",
	);
	const bottleneckPath = path.join(
		options.outputDir,
		"playback-bottlenecks.md",
	);
	const bottleneckJsonPath = path.join(
		options.outputDir,
		"playback-bottlenecks.json",
	);
	const comparisonPath = path.join(options.outputDir, "playback-comparison.md");
	const comparisonJsonPath = path.join(
		options.outputDir,
		"playback-comparison.json",
	);

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
			"--output-json",
			bottleneckJsonPath,
			"--target-fps",
			String(options.targetFps),
			"--max-scrub-p95-ms",
			String(options.maxScrubP95Ms),
			"--max-startup-ms",
			String(options.maxStartupMs),
		);
		run("node", analyzeArgs);
	}
	if (options.compareBaselineInputs.length > 0) {
		const compareArgs = ["scripts/compare-playback-benchmark-runs.js"];
		for (const baselineInput of options.compareBaselineInputs) {
			compareArgs.push("--baseline", baselineInput);
		}
		for (const candidateInput of options.inputs) {
			compareArgs.push("--candidate", candidateInput);
		}
		compareArgs.push(
			"--output",
			comparisonPath,
			"--output-json",
			comparisonJsonPath,
			"--allow-fps-drop",
			String(options.allowFpsDrop),
			"--allow-startup-increase-ms",
			String(options.allowStartupIncreaseMs),
			"--allow-scrub-p95-increase-ms",
			String(options.allowScrubP95IncreaseMs),
		);
		if (options.allowMissingCandidate) {
			compareArgs.push("--allow-missing-candidate");
		}
		if (options.failOnCandidateOnly) {
			compareArgs.push("--fail-on-candidate-only");
		}
		run("node", compareArgs);
	}
	if (options.publishTarget) {
		const publishArgs = [
			"scripts/publish-playback-matrix-summary.js",
			"--aggregate-md",
			aggregatePath,
			"--status-md",
			statusPath,
			"--validation-json",
			validationPath,
			"--target",
			options.publishTarget,
		];
		if (options.analyze) {
			publishArgs.push("--bottlenecks-md", bottleneckPath);
		}
		if (options.compareBaselineInputs.length > 0) {
			publishArgs.push(
				"--comparison-md",
				comparisonPath,
				"--comparison-json",
				comparisonJsonPath,
			);
		}
		run("node", publishArgs);
	}

	console.log(`Aggregate markdown: ${aggregatePath}`);
	console.log(`Status markdown: ${statusPath}`);
	console.log(`Validation JSON: ${validationPath}`);
	if (options.analyze) {
		console.log(`Bottleneck analysis: ${bottleneckPath}`);
		console.log(`Bottleneck analysis JSON: ${bottleneckJsonPath}`);
	}
	if (options.publishTarget) {
		console.log(`Published target: ${options.publishTarget}`);
	}
	if (options.compareBaselineInputs.length > 0) {
		console.log(`Comparison report: ${comparisonPath}`);
		console.log(`Comparison JSON: ${comparisonJsonPath}`);
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
