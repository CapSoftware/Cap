#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
	const options = {
		baseline: null,
		candidate: null,
		output: null,
		allowFpsDrop: 2,
		allowStartupIncreaseMs: 25,
		allowScrubP95IncreaseMs: 5,
	};

	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") continue;
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		if (arg === "--baseline") {
			options.baseline = path.resolve(argv[++i] ?? "");
			continue;
		}
		if (arg === "--candidate") {
			options.candidate = path.resolve(argv[++i] ?? "");
			continue;
		}
		if (arg === "--output" || arg === "-o") {
			options.output = path.resolve(argv[++i] ?? "");
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
		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

function usage() {
	console.log(`Usage: node scripts/compare-playback-benchmark-runs.js --baseline <file-or-dir> --candidate <file-or-dir> [--output <file>] [--allow-fps-drop 2] [--allow-startup-increase-ms 25] [--allow-scrub-p95-increase-ms 5]

Compares baseline and candidate playback matrix JSON outputs and flags regressions.`);
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
	const rows = new Map();

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

			rows.set(key, {
				key,
				platform,
				gpu,
				scenario,
				recording: report.recording_name ?? "unknown",
				format: report.is_fragmented ? "fragmented" : "mp4",
				fpsMin: fpsValues.length ? Math.min(...fpsValues) : null,
				startupAvg: average(startupValues),
				scrubP95Max: maximum(scrubP95Values),
			});
		}
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

	for (const [key, candidate] of candidateRows) {
		const baseline = baselineRows.get(key);
		if (!baseline) continue;

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
			fpsDelta,
			startupDelta,
			scrubDelta,
			regressions,
		});
	}

	comparisons.sort((a, b) => b.regressions.length - a.regressions.length);
	return comparisons;
}

function toMarkdown(comparisons, options) {
	const regressions = comparisons.filter(
		(entry) => entry.regressions.length > 0,
	);
	let md = "";
	md += "# Playback Benchmark Comparison\n\n";
	md += `Generated: ${new Date().toISOString()}\n\n`;
	md += `Tolerance: fps_drop<=${options.allowFpsDrop}, startup_increase<=${options.allowStartupIncreaseMs}ms, scrub_p95_increase<=${options.allowScrubP95IncreaseMs}ms\n\n`;
	md += `Compared rows: ${comparisons.length}, regressions: ${regressions.length}\n\n`;
	md +=
		"| Platform | GPU | Scenario | Recording | Format | FPS Δ | Startup Δ (ms) | Scrub p95 Δ (ms) | Regression |\n";
	md += "|---|---|---|---|---|---:|---:|---:|---|\n";
	for (const row of comparisons) {
		md += `| ${row.platform} | ${row.gpu} | ${row.scenario} | ${row.recording} | ${row.format} | ${formatNumber(row.fpsDelta)} | ${formatNumber(row.startupDelta)} | ${formatNumber(row.scrubDelta)} | ${row.regressions.length > 0 ? row.regressions.join(", ") : "none"} |\n`;
	}
	md += "\n";
	return md;
}

function main() {
	const options = parseArgs(process.argv);
	if (options.help) {
		usage();
		return;
	}
	if (!options.baseline || !options.candidate) {
		throw new Error("--baseline and --candidate are required");
	}

	const baselineFiles = collectJsonFiles(options.baseline);
	const candidateFiles = collectJsonFiles(options.candidate);
	if (baselineFiles.length === 0) {
		throw new Error("No baseline JSON files found");
	}
	if (candidateFiles.length === 0) {
		throw new Error("No candidate JSON files found");
	}

	const baselineRows = collectMetrics(baselineFiles);
	const candidateRows = collectMetrics(candidateFiles);
	const comparisons = compareMetrics(baselineRows, candidateRows, options);
	const markdown = toMarkdown(comparisons, options);

	if (options.output) {
		fs.writeFileSync(options.output, markdown, "utf8");
		console.log(`Wrote comparison report to ${options.output}`);
	} else {
		process.stdout.write(markdown);
	}

	if (comparisons.some((entry) => entry.regressions.length > 0)) {
		process.exit(1);
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
