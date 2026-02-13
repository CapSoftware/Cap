#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
	const inputs = [];
	let output = null;
	let help = false;

	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		if (arg === "--input" || arg === "-i") {
			const value = argv[i + 1];
			if (!value) {
				throw new Error("Missing value for --input");
			}
			inputs.push(path.resolve(value));
			i += 1;
			continue;
		}
		if (arg === "--output" || arg === "-o") {
			const value = argv[i + 1];
			if (!value) {
				throw new Error("Missing value for --output");
			}
			output = path.resolve(value);
			i += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return { inputs, output, help };
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
	const entries = fs.readdirSync(targetPath, { withFileTypes: true });
	for (const entry of entries) {
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
	if (!notes) {
		return {};
	}
	const parsed = {};
	for (const token of notes.split(/\s+/)) {
		if (!token.includes("=")) {
			continue;
		}
		const [key, ...rest] = token.split("=");
		const value = rest.join("=");
		if (!key || !value) {
			continue;
		}
		parsed[key.trim()] = value.trim();
	}
	return parsed;
}

function numberOrNull(value) {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return null;
	}
	return value;
}

function maxOrNull(values) {
	const numeric = values
		.map(numberOrNull)
		.filter((value) => value !== null);
	if (numeric.length === 0) {
		return null;
	}
	return Math.max(...numeric);
}

function avgOrNull(values) {
	const numeric = values
		.map(numberOrNull)
		.filter((value) => value !== null);
	if (numeric.length === 0) {
		return null;
	}
	return numeric.reduce((acc, value) => acc + value, 0) / numeric.length;
}

function formatMetric(value, digits = 1) {
	return value === null ? "n/a" : value.toFixed(digits);
}

function extractRows(jsonPath, data) {
	if (!Array.isArray(data.reports)) {
		return [];
	}

	const notes = parseNotes(data.notes);
	const platform = notes.platform ?? "unknown";
	const gpu = notes.gpu ?? "unknown";
	const scenario = notes.scenario ?? "unspecified";
	const runTime = data.generated_at_utc ?? "unknown";

	const rows = [];
	for (const report of data.reports) {
		const playbackResults = Array.isArray(report.playback_results)
			? report.playback_results
			: [];
		const scrubResults = Array.isArray(report.scrub_results)
			? report.scrub_results
			: [];
		const audioResults = Array.isArray(report.audio_sync_results)
			? report.audio_sync_results
			: [];

		const effectiveFpsMin = playbackResults.length
			? Math.min(
					...playbackResults
						.map((result) => numberOrNull(result.effective_fps))
						.filter((value) => value !== null),
				)
			: null;
		const scrubP95Max = maxOrNull(
			scrubResults.map((result) => result.p95_seek_time_ms),
		);
		const startupAvg = avgOrNull(
			playbackResults.map((result) => result.startup_to_first_frame_ms),
		);
		const micDiffMax = maxOrNull(
			audioResults
				.filter((result) => result.has_mic_audio)
				.map((result) => result.mic_video_diff_ms),
		);
		const sysDiffMax = maxOrNull(
			audioResults
				.filter((result) => result.has_system_audio)
				.map((result) => result.system_audio_video_diff_ms),
		);

		rows.push({
			runTime,
			platform,
			gpu,
			scenario,
			recording: report.recording_name ?? path.basename(jsonPath),
			format: report.is_fragmented ? "fragmented" : "mp4",
			status: report.overall_passed ? "PASS" : "FAIL",
			effectiveFpsMin,
			scrubP95Max,
			startupAvg,
			micDiffMax,
			sysDiffMax,
			command: data.command ?? "unknown",
			source: jsonPath,
		});
	}

	return rows;
}

function buildMarkdown(rows) {
	const sorted = [...rows].sort((a, b) => (a.runTime < b.runTime ? 1 : -1));
	const passed = sorted.filter((row) => row.status === "PASS").length;
	const failed = sorted.length - passed;

	let md = "";
	md += `# Playback Benchmark Aggregate\n\n`;
	md += `Generated: ${new Date().toISOString()}\n\n`;
	md += `Total rows: ${sorted.length}, Passed: ${passed}, Failed: ${failed}\n\n`;
	md += "| Run Time (UTC) | Platform | GPU | Scenario | Recording | Format | Status | FPS(min) | Scrub p95(ms) | Startup avg(ms) | Mic diff max(ms) | Sys diff max(ms) |\n";
	md += "|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|\n";
	for (const row of sorted) {
		md += `| ${row.runTime} | ${row.platform} | ${row.gpu} | ${row.scenario} | ${row.recording} | ${row.format} | ${row.status} | ${formatMetric(row.effectiveFpsMin)} | ${formatMetric(row.scrubP95Max)} | ${formatMetric(row.startupAvg)} | ${formatMetric(row.micDiffMax)} | ${formatMetric(row.sysDiffMax)} |\n`;
	}
	md += "\n";
	return md;
}

function printUsage() {
	console.log(`Usage: node scripts/aggregate-playback-benchmarks.js --input <file-or-dir> [--input <file-or-dir> ...] [--output <file>]

Aggregates playback-test-runner JSON outputs into a markdown summary table.`);
}

function main() {
	const args = parseArgs(process.argv);
	if (args.help) {
		printUsage();
		return;
	}
	if (args.inputs.length === 0) {
		throw new Error("At least one --input is required");
	}

	const files = new Set();
	for (const inputPath of args.inputs) {
		for (const filePath of collectJsonFiles(inputPath)) {
			files.add(filePath);
		}
	}

	if (files.size === 0) {
		throw new Error("No JSON files found for aggregation");
	}

	const rows = [];
	for (const filePath of files) {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		rows.push(...extractRows(filePath, parsed));
	}

	const markdown = buildMarkdown(rows);
	if (args.output) {
		fs.writeFileSync(args.output, markdown, "utf8");
		console.log(`Wrote aggregate markdown to ${args.output}`);
	} else {
		process.stdout.write(markdown);
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
