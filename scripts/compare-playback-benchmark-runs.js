#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
	const options = {
		baselineInputs: [],
		candidateInputs: [],
		output: null,
		outputJson: null,
		allowFpsDrop: 2,
		allowStartupIncreaseMs: 25,
		allowScrubP95IncreaseMs: 5,
		allowMissingCandidate: false,
		failOnCandidateOnly: false,
		minSamplesPerRow: 1,
		failOnParseErrors: false,
		failOnZeroCompared: false,
		failOnSkippedFiles: false,
	};

	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") continue;
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		if (arg === "--baseline") {
			const value = argv[++i];
			if (!value) throw new Error("Missing value for --baseline");
			options.baselineInputs.push(path.resolve(value));
			continue;
		}
		if (arg === "--candidate") {
			const value = argv[++i];
			if (!value) throw new Error("Missing value for --candidate");
			options.candidateInputs.push(path.resolve(value));
			continue;
		}
		if (arg === "--output" || arg === "-o") {
			options.output = path.resolve(argv[++i] ?? "");
			continue;
		}
		if (arg === "--output-json") {
			options.outputJson = path.resolve(argv[++i] ?? "");
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
		if (arg === "--min-samples-per-row") {
			const value = Number.parseInt(argv[++i] ?? "", 10);
			if (!Number.isFinite(value) || value < 1) {
				throw new Error("Invalid --min-samples-per-row value");
			}
			options.minSamplesPerRow = value;
			continue;
		}
		if (arg === "--fail-on-parse-errors") {
			options.failOnParseErrors = true;
			continue;
		}
		if (arg === "--fail-on-zero-compared") {
			options.failOnZeroCompared = true;
			continue;
		}
		if (arg === "--fail-on-skipped-files") {
			options.failOnSkippedFiles = true;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

function usage() {
	console.log(`Usage: node scripts/compare-playback-benchmark-runs.js --baseline <file-or-dir> [--baseline <file-or-dir> ...] --candidate <file-or-dir> [--candidate <file-or-dir> ...] [--output <file>] [--output-json <file>] [--allow-fps-drop 2] [--allow-startup-increase-ms 25] [--allow-scrub-p95-increase-ms 5] [--allow-missing-candidate] [--fail-on-candidate-only] [--min-samples-per-row 1] [--fail-on-parse-errors] [--fail-on-zero-compared] [--fail-on-skipped-files]

Compares baseline and candidate playback matrix JSON outputs and flags regressions. Multiple --baseline and --candidate inputs are supported.`);
}

function collectJsonFiles(targetPath) {
	if (!fs.existsSync(targetPath)) {
		throw new Error(`Path does not exist: ${targetPath}`);
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
	const parsed = {};
	for (const token of notes.split(/\s+/)) {
		if (!token.includes("=")) continue;
		const [key, ...rest] = token.split("=");
		const value = rest.join("=");
		if (!key || !value) continue;
		parsed[key.trim()] = value.trim();
	}
	return parsed;
}

function average(values) {
	if (values.length === 0) return null;
	return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function maximum(values) {
	if (values.length === 0) return null;
	return Math.max(...values);
}

function collectMetrics(files) {
	const accumulators = new Map();
	const stats = {
		totalFiles: files.length,
		parsedFiles: 0,
		usableFiles: 0,
		skippedFiles: 0,
		skippedNoReports: 0,
		skippedNoUsableMetrics: 0,
		parseErrors: [],
	};

	for (const filePath of files) {
		let parsed;
		try {
			parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
			stats.parsedFiles += 1;
		} catch (error) {
			stats.parseErrors.push({
				file: filePath,
				error: error instanceof Error ? error.message : String(error),
			});
			continue;
		}

		if (!Array.isArray(parsed.reports) || parsed.reports.length === 0) {
			stats.skippedFiles += 1;
			stats.skippedNoReports += 1;
			continue;
		}

		const notes = parseNotes(parsed.notes);
		const platform = notes.platform ?? "unknown";
		const gpu = notes.gpu ?? "unknown";
		const scenario = notes.scenario ?? "unspecified";
		const reports = Array.isArray(parsed.reports) ? parsed.reports : [];
		let fileContributedRows = false;

		for (const report of reports) {
			const key = `${platform}|${gpu}|${scenario}|${report.recording_name ?? "unknown"}|${report.is_fragmented ? "fragmented" : "mp4"}`;

			const playback = Array.isArray(report.playback_results)
				? report.playback_results
				: [];
			const scrub = Array.isArray(report.scrub_results)
				? report.scrub_results
				: [];

			const fpsValues = playback
				.map((entry) => entry.effective_fps)
				.filter((entry) => typeof entry === "number");
			const startupValues = playback
				.map((entry) => entry.startup_to_first_frame_ms)
				.filter((entry) => typeof entry === "number");
			const scrubP95Values = scrub
				.map((entry) => entry.p95_seek_time_ms)
				.filter((entry) => typeof entry === "number");
			const hasUsableMetrics =
				fpsValues.length > 0 ||
				startupValues.length > 0 ||
				scrubP95Values.length > 0;
			if (!hasUsableMetrics) {
				continue;
			}

			const existing = accumulators.get(key) ?? {
				key,
				platform,
				gpu,
				scenario,
				recording: report.recording_name ?? "unknown",
				format: report.is_fragmented ? "fragmented" : "mp4",
				reportCount: 0,
				fpsSamples: [],
				startupSamples: [],
				scrubP95Samples: [],
			};
			existing.reportCount += 1;
			existing.fpsSamples.push(...fpsValues);
			existing.startupSamples.push(...startupValues);
			existing.scrubP95Samples.push(...scrubP95Values);
			accumulators.set(key, existing);
			fileContributedRows = true;
		}

		if (fileContributedRows) {
			stats.usableFiles += 1;
		} else {
			stats.skippedFiles += 1;
			stats.skippedNoUsableMetrics += 1;
		}
	}

	const rows = new Map();
	for (const [key, row] of accumulators) {
		rows.set(key, {
			key,
			platform: row.platform,
			gpu: row.gpu,
			scenario: row.scenario,
			recording: row.recording,
			format: row.format,
			reportCount: row.reportCount,
			fpsSampleCount: row.fpsSamples.length,
			startupSampleCount: row.startupSamples.length,
			scrubSampleCount: row.scrubP95Samples.length,
			fpsMin: row.fpsSamples.length ? Math.min(...row.fpsSamples) : null,
			startupAvg: average(row.startupSamples),
			scrubP95Max: maximum(row.scrubP95Samples),
		});
	}

	return { rows, stats };
}

function delta(candidate, baseline) {
	if (candidate === null || baseline === null) return null;
	return candidate - baseline;
}

function formatNumber(value, digits = 2) {
	return value === null ? "n/a" : value.toFixed(digits);
}

function compareCoverageRows(a, b) {
	return (
		a.platform.localeCompare(b.platform) ||
		a.gpu.localeCompare(b.gpu) ||
		a.scenario.localeCompare(b.scenario) ||
		a.recording.localeCompare(b.recording) ||
		a.format.localeCompare(b.format)
	);
}

function compareMetrics(baselineRows, candidateRows, options) {
	const comparisons = [];
	const missingCandidateRows = [];
	const candidateOnlyRows = [];
	const insufficientSampleRows = [];

	for (const [key, baseline] of baselineRows) {
		const candidate = candidateRows.get(key);
		if (!candidate) {
			missingCandidateRows.push({
				platform: baseline.platform,
				gpu: baseline.gpu,
				scenario: baseline.scenario,
				recording: baseline.recording,
				format: baseline.format,
			});
		}
	}

	for (const [key, candidate] of candidateRows) {
		const baseline = baselineRows.get(key);
		if (!baseline) {
			candidateOnlyRows.push({
				platform: candidate.platform,
				gpu: candidate.gpu,
				scenario: candidate.scenario,
				recording: candidate.recording,
				format: candidate.format,
			});
			continue;
		}

		const fpsDelta = delta(candidate.fpsMin, baseline.fpsMin);
		const startupDelta = delta(candidate.startupAvg, baseline.startupAvg);
		const scrubDelta = delta(candidate.scrubP95Max, baseline.scrubP95Max);

		const regressions = [];
		const fpsMinSamples = Math.min(
			baseline.fpsSampleCount,
			candidate.fpsSampleCount,
		);
		const startupMinSamples = Math.min(
			baseline.startupSampleCount,
			candidate.startupSampleCount,
		);
		const scrubMinSamples = Math.min(
			baseline.scrubSampleCount,
			candidate.scrubSampleCount,
		);
		const comparableSampleCounts = [];
		if (fpsDelta !== null) {
			comparableSampleCounts.push(fpsMinSamples);
		}
		if (startupDelta !== null) {
			comparableSampleCounts.push(startupMinSamples);
		}
		if (scrubDelta !== null) {
			comparableSampleCounts.push(scrubMinSamples);
		}
		const effectiveSampleCount =
			comparableSampleCounts.length > 0
				? Math.min(...comparableSampleCounts)
				: 0;
		if (effectiveSampleCount < options.minSamplesPerRow) {
			insufficientSampleRows.push({
				platform: candidate.platform,
				gpu: candidate.gpu,
				scenario: candidate.scenario,
				recording: candidate.recording,
				format: candidate.format,
				effectiveSampleCount,
				requiredSampleCount: options.minSamplesPerRow,
			});
			regressions.push(
				`insufficient_samples=${effectiveSampleCount}/${options.minSamplesPerRow}`,
			);
		}

		if (fpsDelta !== null && fpsDelta < -options.allowFpsDrop) {
			regressions.push(`fps_drop=${formatNumber(fpsDelta)}`);
		}
		if (
			startupDelta !== null &&
			startupDelta > options.allowStartupIncreaseMs
		) {
			regressions.push(`startup_increase=${formatNumber(startupDelta)}`);
		}
		if (scrubDelta !== null && scrubDelta > options.allowScrubP95IncreaseMs) {
			regressions.push(`scrub_p95_increase=${formatNumber(scrubDelta)}`);
		}

		comparisons.push({
			platform: candidate.platform,
			gpu: candidate.gpu,
			scenario: candidate.scenario,
			recording: candidate.recording,
			format: candidate.format,
			baselineReportCount: baseline.reportCount,
			candidateReportCount: candidate.reportCount,
			fpsMinSamples,
			startupMinSamples,
			scrubMinSamples,
			comparedMetricCount: comparableSampleCounts.length,
			effectiveSampleCount,
			fpsDelta,
			startupDelta,
			scrubDelta,
			regressions,
		});
	}

	comparisons.sort(
		(a, b) =>
			b.regressions.length - a.regressions.length || compareCoverageRows(a, b),
	);
	missingCandidateRows.sort(compareCoverageRows);
	candidateOnlyRows.sort(compareCoverageRows);
	insufficientSampleRows.sort(compareCoverageRows);
	return {
		comparisons,
		missingCandidateRows,
		candidateOnlyRows,
		insufficientSampleRows,
	};
}

function escapeTableCell(value) {
	return String(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function toMarkdown(
	comparisons,
	missingCandidateRows,
	candidateOnlyRows,
	insufficientSampleRows,
	baselineStats,
	candidateStats,
	options,
) {
	const regressions = comparisons.filter(
		(entry) => entry.regressions.length > 0,
	);
	let md = "";
	md += "# Playback Benchmark Comparison\n\n";
	md += `Generated: ${new Date().toISOString()}\n\n`;
	md += `Tolerance: fps_drop<=${options.allowFpsDrop}, startup_increase<=${options.allowStartupIncreaseMs}ms, scrub_p95_increase<=${options.allowScrubP95IncreaseMs}ms\n\n`;
	md += `Coverage gate: missing_candidate=${options.allowMissingCandidate ? "allow" : "fail"}, candidate_only=${options.failOnCandidateOnly ? "fail" : "allow"}\n\n`;
	md += `Sample gate: min_samples_per_row>=${options.minSamplesPerRow}\n\n`;
	md += `Parse gate: parse_errors=${options.failOnParseErrors ? "fail" : "allow"}\n\n`;
	md += `Zero-compare gate: compared_rows=${options.failOnZeroCompared ? "fail_if_zero" : "allow"}\n\n`;
	md += `Skipped-file gate: skipped_files=${options.failOnSkippedFiles ? "fail" : "allow"}\n\n`;
	md += `Baseline files: total=${baselineStats.totalFiles}, parsed=${baselineStats.parsedFiles}, usable=${baselineStats.usableFiles}, skipped=${baselineStats.skippedFiles}, skipped_no_reports=${baselineStats.skippedNoReports}, skipped_no_metrics=${baselineStats.skippedNoUsableMetrics}, parse_errors=${baselineStats.parseErrors.length}\n`;
	md += `Candidate files: total=${candidateStats.totalFiles}, parsed=${candidateStats.parsedFiles}, usable=${candidateStats.usableFiles}, skipped=${candidateStats.skippedFiles}, skipped_no_reports=${candidateStats.skippedNoReports}, skipped_no_metrics=${candidateStats.skippedNoUsableMetrics}, parse_errors=${candidateStats.parseErrors.length}\n\n`;
	md += `Compared rows: ${comparisons.length}, regressions: ${regressions.length}, missing candidate rows: ${missingCandidateRows.length}, candidate-only rows: ${candidateOnlyRows.length}, insufficient sample rows: ${insufficientSampleRows.length}\n\n`;
	if (
		baselineStats.parseErrors.length > 0 ||
		candidateStats.parseErrors.length > 0
	) {
		md += "## Parse Errors\n\n";
		md += "| Side | File | Error |\n";
		md += "|---|---|---|\n";
		for (const entry of baselineStats.parseErrors.slice(0, 20)) {
			md += `| baseline | ${escapeTableCell(entry.file)} | ${escapeTableCell(entry.error)} |\n`;
		}
		for (const entry of candidateStats.parseErrors.slice(0, 20)) {
			md += `| candidate | ${escapeTableCell(entry.file)} | ${escapeTableCell(entry.error)} |\n`;
		}
		md += "\n";
	}
	if (missingCandidateRows.length > 0) {
		md += "## Missing Candidate Rows\n\n";
		md += "| Platform | GPU | Scenario | Recording | Format |\n";
		md += "|---|---|---|---|---|\n";
		for (const row of missingCandidateRows) {
			md += `| ${row.platform} | ${row.gpu} | ${row.scenario} | ${row.recording} | ${row.format} |\n`;
		}
		md += "\n";
	}
	if (candidateOnlyRows.length > 0) {
		md += "## Candidate-Only Rows\n\n";
		md += "| Platform | GPU | Scenario | Recording | Format |\n";
		md += "|---|---|---|---|---|\n";
		for (const row of candidateOnlyRows) {
			md += `| ${row.platform} | ${row.gpu} | ${row.scenario} | ${row.recording} | ${row.format} |\n`;
		}
		md += "\n";
	}
	if (insufficientSampleRows.length > 0) {
		md += "## Insufficient Sample Rows\n\n";
		md +=
			"| Platform | GPU | Scenario | Recording | Format | Effective Samples | Required Samples |\n";
		md += "|---|---|---|---|---|---:|---:|\n";
		for (const row of insufficientSampleRows) {
			md += `| ${row.platform} | ${row.gpu} | ${row.scenario} | ${row.recording} | ${row.format} | ${row.effectiveSampleCount} | ${row.requiredSampleCount} |\n`;
		}
		md += "\n";
	}
	md +=
		"| Platform | GPU | Scenario | Recording | Format | B Runs | C Runs | F Samples | S Samples | Q Samples | Metrics | Effective Samples | FPS Δ | Startup Δ (ms) | Scrub p95 Δ (ms) | Regression |\n";
	md +=
		"|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|\n";
	for (const row of comparisons) {
		md += `| ${row.platform} | ${row.gpu} | ${row.scenario} | ${row.recording} | ${row.format} | ${row.baselineReportCount} | ${row.candidateReportCount} | ${row.fpsMinSamples} | ${row.startupMinSamples} | ${row.scrubMinSamples} | ${row.comparedMetricCount} | ${row.effectiveSampleCount} | ${formatNumber(row.fpsDelta)} | ${formatNumber(row.startupDelta)} | ${formatNumber(row.scrubDelta)} | ${row.regressions.length > 0 ? row.regressions.join(", ") : "none"} |\n`;
	}
	md += "\n";
	return md;
}

function buildJsonOutput(
	comparisons,
	missingCandidateRows,
	candidateOnlyRows,
	insufficientSampleRows,
	baselineStats,
	candidateStats,
	options,
) {
	const regressions = comparisons.filter(
		(entry) => entry.regressions.length > 0,
	);
	const hasMissingCandidateRows = missingCandidateRows.length > 0;
	const hasCandidateOnlyRows = candidateOnlyRows.length > 0;
	const hasInsufficientSamples = insufficientSampleRows.length > 0;
	const hasMetricRegressions = regressions.some((entry) =>
		entry.regressions.some(
			(issue) =>
				issue.startsWith("fps_drop=") ||
				issue.startsWith("startup_increase=") ||
				issue.startsWith("scrub_p95_increase="),
		),
	);
	const failureReasons = [];
	if (hasMetricRegressions) {
		failureReasons.push("metric_regression");
	}
	if (hasInsufficientSamples) {
		failureReasons.push("insufficient_samples");
	}
	if (!options.allowMissingCandidate && hasMissingCandidateRows) {
		failureReasons.push("missing_candidate_rows");
	}
	if (options.failOnCandidateOnly && hasCandidateOnlyRows) {
		failureReasons.push("candidate_only_rows");
	}
	if (
		options.failOnParseErrors &&
		(baselineStats.parseErrors.length > 0 ||
			candidateStats.parseErrors.length > 0)
	) {
		failureReasons.push("parse_errors");
	}
	if (options.failOnZeroCompared && comparisons.length === 0) {
		failureReasons.push("zero_compared_rows");
	}
	if (
		options.failOnSkippedFiles &&
		(baselineStats.skippedFiles > 0 || candidateStats.skippedFiles > 0)
	) {
		failureReasons.push("skipped_files");
	}
	const passed = failureReasons.length === 0;
	return {
		generatedAt: new Date().toISOString(),
		tolerance: {
			allowFpsDrop: options.allowFpsDrop,
			allowStartupIncreaseMs: options.allowStartupIncreaseMs,
			allowScrubP95IncreaseMs: options.allowScrubP95IncreaseMs,
			allowMissingCandidate: options.allowMissingCandidate,
			failOnCandidateOnly: options.failOnCandidateOnly,
			minSamplesPerRow: options.minSamplesPerRow,
			failOnParseErrors: options.failOnParseErrors,
			failOnZeroCompared: options.failOnZeroCompared,
			failOnSkippedFiles: options.failOnSkippedFiles,
		},
		fileStats: {
			baseline: baselineStats,
			candidate: candidateStats,
		},
		summary: {
			comparedRows: comparisons.length,
			regressions: regressions.length,
			missingCandidateRows: missingCandidateRows.length,
			candidateOnlyRows: candidateOnlyRows.length,
			insufficientSampleRows: insufficientSampleRows.length,
			passed,
			failureReasons,
			gateOutcomes: {
				metricRegressions: !hasMetricRegressions,
				insufficientSamples: !hasInsufficientSamples,
				missingCandidateRows:
					options.allowMissingCandidate || !hasMissingCandidateRows,
				candidateOnlyRows:
					!options.failOnCandidateOnly || !hasCandidateOnlyRows,
				parseErrors:
					!options.failOnParseErrors ||
					(baselineStats.parseErrors.length === 0 &&
						candidateStats.parseErrors.length === 0),
				zeroComparedRows: !options.failOnZeroCompared || comparisons.length > 0,
				skippedFiles:
					!options.failOnSkippedFiles ||
					(baselineStats.skippedFiles === 0 &&
						candidateStats.skippedFiles === 0),
			},
		},
		regressions,
		missingCandidateRows,
		candidateOnlyRows,
		insufficientSampleRows,
		comparisons,
	};
}

function main() {
	const options = parseArgs(process.argv);
	if (options.help) {
		usage();
		return;
	}
	if (
		options.baselineInputs.length === 0 ||
		options.candidateInputs.length === 0
	) {
		throw new Error("At least one --baseline and one --candidate are required");
	}

	const baselineFiles = [
		...new Set(options.baselineInputs.flatMap(collectJsonFiles)),
	];
	const candidateFiles = [
		...new Set(options.candidateInputs.flatMap(collectJsonFiles)),
	];
	if (baselineFiles.length === 0) {
		throw new Error("No baseline JSON files found");
	}
	if (candidateFiles.length === 0) {
		throw new Error("No candidate JSON files found");
	}

	const baselineCollected = collectMetrics(baselineFiles);
	const candidateCollected = collectMetrics(candidateFiles);
	const baselineRows = baselineCollected.rows;
	const candidateRows = candidateCollected.rows;
	const {
		comparisons,
		missingCandidateRows,
		candidateOnlyRows,
		insufficientSampleRows,
	} = compareMetrics(baselineRows, candidateRows, options);
	const markdown = toMarkdown(
		comparisons,
		missingCandidateRows,
		candidateOnlyRows,
		insufficientSampleRows,
		baselineCollected.stats,
		candidateCollected.stats,
		options,
	);
	const outputJson = buildJsonOutput(
		comparisons,
		missingCandidateRows,
		candidateOnlyRows,
		insufficientSampleRows,
		baselineCollected.stats,
		candidateCollected.stats,
		options,
	);

	if (options.output) {
		fs.writeFileSync(options.output, markdown, "utf8");
		console.log(`Wrote comparison report to ${options.output}`);
	} else {
		process.stdout.write(markdown);
	}
	if (options.outputJson) {
		fs.writeFileSync(
			options.outputJson,
			JSON.stringify(outputJson, null, 2),
			"utf8",
		);
		console.log(`Wrote comparison JSON to ${options.outputJson}`);
	}

	if (!outputJson.summary.passed) {
		process.exit(1);
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
