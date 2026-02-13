#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
	const options = {
		inputs: [],
		output: null,
		targetFps: 60,
		maxScrubP95Ms: 40,
		maxStartupMs: 250,
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
		if (arg === "--output" || arg === "-o") {
			const value = argv[++i];
			if (!value) throw new Error("Missing value for --output");
			options.output = path.resolve(value);
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
		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

function usage() {
	console.log(`Usage: node scripts/analyze-playback-matrix-bottlenecks.js --input <file-or-dir> [--input <file-or-dir> ...] [--output <file>] [--target-fps 60] [--max-scrub-p95-ms 40] [--max-startup-ms 250]

Analyzes playback matrix JSON outputs and highlights prioritized bottlenecks.`);
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

function average(values) {
	if (values.length === 0) return null;
	return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function max(values) {
	if (values.length === 0) return null;
	return Math.max(...values);
}

function scoreIssue(issue, options) {
	let score = 0;
	if (issue.fpsMin !== null && issue.fpsMin < options.targetFps) {
		score += (options.targetFps - issue.fpsMin) * 5;
	}
	if (issue.scrubP95 !== null && issue.scrubP95 > options.maxScrubP95Ms) {
		score += issue.scrubP95 - options.maxScrubP95Ms;
	}
	if (issue.startupAvg !== null && issue.startupAvg > options.maxStartupMs) {
		score += (issue.startupAvg - options.maxStartupMs) / 2;
	}
	return score;
}

function formatValue(value, digits = 1) {
	return value === null ? "n/a" : value.toFixed(digits);
}

function collectIssues(files, options) {
	const issues = [];

	for (const filePath of files) {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		const notes = parseNotes(parsed.notes);
		const platform = notes.platform ?? "unknown";
		const gpu = notes.gpu ?? "unknown";
		const scenario = notes.scenario ?? "unspecified";
		const reports = Array.isArray(parsed.reports) ? parsed.reports : [];

		for (const report of reports) {
			const playback = Array.isArray(report.playback_results)
				? report.playback_results
				: [];
			const scrub = Array.isArray(report.scrub_results) ? report.scrub_results : [];

			const fpsValues = playback
				.map((entry) => entry.effective_fps)
				.filter((entry) => typeof entry === "number");
			const startupValues = playback
				.map((entry) => entry.startup_to_first_frame_ms)
				.filter((entry) => typeof entry === "number");
			const scrubP95Values = scrub
				.map((entry) => entry.p95_seek_time_ms)
				.filter((entry) => typeof entry === "number");

			const issue = {
				platform,
				gpu,
				scenario,
				recording: report.recording_name ?? path.basename(filePath),
				format: report.is_fragmented ? "fragmented" : "mp4",
				fpsMin: fpsValues.length ? Math.min(...fpsValues) : null,
				startupAvg: average(startupValues),
				scrubP95: max(scrubP95Values),
				filePath,
			};
			issue.score = scoreIssue(issue, options);
			if (issue.score > 0) {
				issues.push(issue);
			}
		}
	}

	issues.sort((a, b) => b.score - a.score);
	return issues;
}

function recommendation(issue, options) {
	const recommendations = [];
	if (issue.fpsMin !== null && issue.fpsMin < options.targetFps) {
		recommendations.push("inspect decode/render path and frame wait behavior");
	}
	if (issue.scrubP95 !== null && issue.scrubP95 > options.maxScrubP95Ms) {
		recommendations.push("investigate seek dispatch pressure and decoder reposition cost");
	}
	if (issue.startupAvg !== null && issue.startupAvg > options.maxStartupMs) {
		recommendations.push("optimize startup warmup and first-frame path");
	}
	return recommendations.join("; ");
}

function buildMarkdown(issues, options) {
	let md = "";
	md += "# Playback Matrix Bottleneck Analysis\n\n";
	md += `Generated: ${new Date().toISOString()}\n\n`;
	md += `Thresholds: target_fps=${options.targetFps}, max_scrub_p95_ms=${options.maxScrubP95Ms}, max_startup_ms=${options.maxStartupMs}\n\n`;

	if (issues.length === 0) {
		md += "No bottlenecks detected for configured thresholds.\n";
		return md;
	}

	md += "| Rank | Platform | GPU | Scenario | Recording | Format | FPS(min) | Startup avg(ms) | Scrub p95(ms) | Score | Recommendation |\n";
	md += "|---:|---|---|---|---|---|---:|---:|---:|---:|---|\n";
	issues.forEach((issue, index) => {
		md += `| ${index + 1} | ${issue.platform} | ${issue.gpu} | ${issue.scenario} | ${issue.recording} | ${issue.format} | ${formatValue(issue.fpsMin)} | ${formatValue(issue.startupAvg)} | ${formatValue(issue.scrubP95)} | ${formatValue(issue.score, 2)} | ${recommendation(issue, options)} |\n`;
	});
	md += "\n";
	return md;
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

	const files = new Set();
	for (const input of options.inputs) {
		for (const filePath of collectJsonFiles(input)) {
			files.add(filePath);
		}
	}
	if (files.size === 0) {
		throw new Error("No JSON files found");
	}

	const issues = collectIssues([...files], options);
	const markdown = buildMarkdown(issues, options);
	if (options.output) {
		fs.writeFileSync(options.output, markdown, "utf8");
		console.log(`Wrote bottleneck analysis to ${options.output}`);
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
