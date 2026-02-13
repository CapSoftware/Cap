#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
	const options = {
		aggregateMd: null,
		statusMd: null,
		bottlenecksMd: null,
		validationJson: null,
		target: path.resolve("crates/editor/PLAYBACK-BENCHMARKS.md"),
	};

	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") continue;
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		if (arg === "--aggregate-md") {
			options.aggregateMd = path.resolve(argv[++i] ?? "");
			continue;
		}
		if (arg === "--status-md") {
			options.statusMd = path.resolve(argv[++i] ?? "");
			continue;
		}
		if (arg === "--bottlenecks-md") {
			options.bottlenecksMd = path.resolve(argv[++i] ?? "");
			continue;
		}
		if (arg === "--validation-json") {
			options.validationJson = path.resolve(argv[++i] ?? "");
			continue;
		}
		if (arg === "--target") {
			options.target = path.resolve(argv[++i] ?? "");
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

function usage() {
	console.log(`Usage: node scripts/publish-playback-matrix-summary.js --aggregate-md <path> --status-md <path> --validation-json <path> [--bottlenecks-md <path>] [--target <playback-benchmarks-path>]

Prepends a matrix summary section into PLAYBACK-BENCHMARKS.md benchmark history region.`);
}

function ensureFile(filePath, label) {
	if (!filePath || !fs.existsSync(filePath)) {
		throw new Error(`${label} file not found: ${filePath ?? "undefined"}`);
	}
}

function buildSummarySection(aggregateMd, statusMd, validationJson, bottlenecksMd) {
	const now = new Date().toISOString();
	const validation = JSON.parse(validationJson);
	const status = validation.passed ? "✅ MATRIX PASS" : "❌ MATRIX FAIL";

	let markdown = "";
	markdown += `### Matrix Summary Run: ${now}\n\n`;
	markdown += `**Validation:** ${status}\n\n`;
	markdown += `- Validated cells: ${validation.validatedCells}\n`;
	markdown += `- Observed cells: ${validation.observedCells}\n`;
	markdown += `- Missing cells: ${validation.missingCells?.length ?? 0}\n`;
	markdown += `- Format failures: ${validation.formatFailures?.length ?? 0}\n\n`;

	if ((validation.missingCells?.length ?? 0) > 0) {
		markdown += "**Missing Cells**\n";
		for (const cell of validation.missingCells) {
			markdown += `- ${cell.platform}:${cell.gpu}:${cell.scenario}\n`;
		}
		markdown += "\n";
	}

	if ((validation.formatFailures?.length ?? 0) > 0) {
		markdown += "**Format Failures**\n";
		for (const failure of validation.formatFailures) {
			markdown += `- ${failure.platform}:${failure.gpu}:${failure.scenario} missing ${failure.requiredFormat}\n`;
		}
		markdown += "\n";
	}

	markdown += "<details>\n<summary>Matrix Status Report</summary>\n\n";
	markdown += `${statusMd.trim()}\n\n`;
	markdown += "</details>\n\n";

	markdown += "<details>\n<summary>Aggregate Benchmark Report</summary>\n\n";
	markdown += `${aggregateMd.trim()}\n\n`;
	markdown += "</details>\n\n";

	if (bottlenecksMd) {
		markdown += "<details>\n<summary>Bottleneck Analysis</summary>\n\n";
		markdown += `${bottlenecksMd.trim()}\n\n`;
		markdown += "</details>\n\n";
	}

	return markdown;
}

function writeToBenchmarkHistory(targetFile, summaryMd) {
	const markerStart = "<!-- PLAYBACK_BENCHMARK_RESULTS_START -->";
	const markerEnd = "<!-- PLAYBACK_BENCHMARK_RESULTS_END -->";
	const current = fs.readFileSync(targetFile, "utf8");
	const start = current.indexOf(markerStart);
	const end = current.indexOf(markerEnd);
	if (start === -1 || end === -1 || start >= end) {
		throw new Error(`Could not find benchmark result markers in ${targetFile}`);
	}

	const insertPos = start + markerStart.length;
	const updated =
		current.slice(0, insertPos) +
		"\n\n" +
		summaryMd +
		current.slice(end);
	fs.writeFileSync(targetFile, updated, "utf8");
}

function main() {
	const options = parseArgs(process.argv);
	if (options.help) {
		usage();
		return;
	}

	ensureFile(options.aggregateMd, "Aggregate markdown");
	ensureFile(options.statusMd, "Status markdown");
	ensureFile(options.validationJson, "Validation JSON");
	if (options.bottlenecksMd) {
		ensureFile(options.bottlenecksMd, "Bottlenecks markdown");
	}
	ensureFile(options.target, "Target");

	const aggregateMd = fs.readFileSync(options.aggregateMd, "utf8");
	const statusMd = fs.readFileSync(options.statusMd, "utf8");
	const validationJson = fs.readFileSync(options.validationJson, "utf8");
	const bottlenecksMd = options.bottlenecksMd
		? fs.readFileSync(options.bottlenecksMd, "utf8")
		: null;
	const summaryMd = buildSummarySection(
		aggregateMd,
		statusMd,
		validationJson,
		bottlenecksMd,
	);
	writeToBenchmarkHistory(options.target, summaryMd);
	console.log(`Published matrix summary into ${options.target}`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
