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
		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

function usage() {
	console.log(`Usage: node scripts/compare-playback-benchmark-runs.js --baseline <file-or-dir> [--baseline <file-or-dir> ...] --candidate <file-or-dir> [--candidate <file-or-dir> ...] [--output <file>] [--output-json <file>] [--allow-fps-drop 2] [--allow-startup-increase-ms 25] [--allow-scrub-p95-increase-ms 5] [--allow-missing-candidate] [--fail-on-candidate-only]

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

	for (const filePath of files) {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		const notes = parseNotes(parsed.notes);
		const platform = notes.platform ?? "unknown";
		const gpu = notes.gpu ?? "unknown";
		const scenario = notes.scenario ?? "unspecified";
		const reports = Array.isArray(parsed.reports) ? parsed.reports : [];

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

	return rows;
}

function delta(candidate, baseline) {
	if (candidate === null || baseline === null) return null;
	return candidate - baseline;
}

function formatNumber(value, digits = 2) {
	return value === null ? "n/a" : value.toFixed(digits);
}

function compareMetrics(baselineRows, candidateRows, options) {
	const comparisons = [];
	const missingCandidateRows = [];
	const candidateOnlyRows = [];

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
			fpsDelta,
			startupDelta,
			scrubDelta,
			regressions,
		});
	}

	comparisons.sort((a, b) => b.regressions.length - a.regressions.length);
	return { comparisons, missingCandidateRows, candidateOnlyRows };
}

function toMarkdown(
	comparisons,
	missingCandidateRows,
	candidateOnlyRows,
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
	md += `Compared rows: ${comparisons.length}, regressions: ${regressions.length}, missing candidate rows: ${missingCandidateRows.length}, candidate-only rows: ${candidateOnlyRows.length}\n\n`;
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
	md +=
		"| Platform | GPU | Scenario | Recording | Format | B Runs | C Runs | FPS Δ | Startup Δ (ms) | Scrub p95 Δ (ms) | Regression |\n";
	md += "|---|---|---|---|---|---:|---:|---:|---:|---:|---|\n";
	for (const row of comparisons) {
		md += `| ${row.platform} | ${row.gpu} | ${row.scenario} | ${row.recording} | ${row.format} | ${row.baselineReportCount} | ${row.candidateReportCount} | ${formatNumber(row.fpsDelta)} | ${formatNumber(row.startupDelta)} | ${formatNumber(row.scrubDelta)} | ${row.regressions.length > 0 ? row.regressions.join(", ") : "none"} |\n`;
	}
	md += "\n";
	return md;
}

function buildJsonOutput(
	comparisons,
	missingCandidateRows,
	candidateOnlyRows,
	options,
) {
	const regressions = comparisons.filter(
		(entry) => entry.regressions.length > 0,
	);
	return {
		generatedAt: new Date().toISOString(),
		tolerance: {
			allowFpsDrop: options.allowFpsDrop,
			allowStartupIncreaseMs: options.allowStartupIncreaseMs,
			allowScrubP95IncreaseMs: options.allowScrubP95IncreaseMs,
			allowMissingCandidate: options.allowMissingCandidate,
			failOnCandidateOnly: options.failOnCandidateOnly,
		},
		summary: {
			comparedRows: comparisons.length,
			regressions: regressions.length,
			missingCandidateRows: missingCandidateRows.length,
			candidateOnlyRows: candidateOnlyRows.length,
			passed:
				regressions.length === 0 &&
				(options.allowMissingCandidate || missingCandidateRows.length === 0) &&
				(!options.failOnCandidateOnly || candidateOnlyRows.length === 0),
		},
		regressions,
		missingCandidateRows,
		candidateOnlyRows,
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

	const baselineRows = collectMetrics(baselineFiles);
	const candidateRows = collectMetrics(candidateFiles);
	const { comparisons, missingCandidateRows, candidateOnlyRows } =
		compareMetrics(baselineRows, candidateRows, options);
	const markdown = toMarkdown(
		comparisons,
		missingCandidateRows,
		candidateOnlyRows,
		options,
	);
	const outputJson = buildJsonOutput(
		comparisons,
		missingCandidateRows,
		candidateOnlyRows,
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

	if (
		comparisons.some((entry) => entry.regressions.length > 0) ||
		(!options.allowMissingCandidate && missingCandidateRows.length > 0) ||
		(options.failOnCandidateOnly && candidateOnlyRows.length > 0)
	) {
		process.exit(1);
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
