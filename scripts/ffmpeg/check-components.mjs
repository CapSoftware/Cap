#!/usr/bin/env node
// Fails when shipped Rust code asks FFmpeg for an encoder, muxer or filter
// that scripts/ffmpeg/components.sh does not build. Test code is skipped:
// #[cfg(test)] items, tests/, examples/, benches/ and *_tests.rs files.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

const SOURCE_DIRS = ["crates", "apps/desktop-gpui", "apps/cli"];
const UNSHIPPED_CRATES = new Set([
	"crates/render-farm",
	"crates/cap-test",
	"crates/verify",
	"crates/cpal-ffmpeg",
]);
const SKIPPED_DIRS = new Set([
	"target",
	"node_modules",
	"tests",
	"examples",
	"benches",
]);

const ENCODER_FOR_ID = {
	H264: "libx264",
	AAC: "aac",
	MJPEG: "mjpeg",
	PCM_S16LE: "pcm_s16le",
	PCM_F32LE: "pcm_f32le",
	OPUS: "libopus",
	MP3: "libmp3lame",
	PRORES: "prores_ks",
};

export function shellList(source, name) {
	const match = source.match(new RegExp(`^${name}=\\(([^)]*)\\)`, "m"));
	if (!match) throw new Error(`${name} missing from components.sh`);
	return match[1]
		.split("\n")
		.map((line) => line.split("#")[0])
		.flatMap((line) => line.split(/\s+/))
		.filter(Boolean);
}

export function readNames(source) {
	const sections = {};
	let current = null;
	for (const line of source.split("\n")) {
		const header = line.match(/^\[(\w+)\]$/);
		if (header) {
			current = header[1];
			sections[current] = new Set();
		} else if (current && line && !line.startsWith("#")) {
			sections[current].add(line.trim());
		}
	}
	return sections;
}

export function withoutTestCode(source) {
	let result = source;
	for (;;) {
		const marker = result.search(/#\[cfg\((?:all\()?test\b/);
		if (marker === -1) return result;
		const open = result.indexOf("{", marker);
		const semicolon = result.indexOf(";", marker);
		if (open === -1 || (semicolon !== -1 && semicolon < open)) {
			result =
				result.slice(0, marker) +
				result.slice(semicolon === -1 ? result.length : semicolon + 1);
			continue;
		}
		let depth = 0;
		let end = result.length;
		for (let index = open; index < result.length; index++) {
			const char = result[index];
			if (char === '"') {
				index++;
				while (index < result.length && result[index] !== '"') {
					if (result[index] === "\\") index++;
					index++;
				}
			} else if (char === "{") depth++;
			else if (char === "}" && --depth === 0) {
				end = index + 1;
				break;
			}
		}
		result = result.slice(0, marker) + result.slice(end);
	}
}

function literals(source) {
	return [...source.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((match) => ({
		value: match[1],
		index: match.index,
	}));
}

export function usages(source, names) {
	const found = { encoders: new Set(), muxers: new Set(), filters: new Set() };
	const code = withoutTestCode(source);

	for (const { value } of literals(code)) {
		if (
			names.encoders.has(value) &&
			(value.includes("_") || value.startsWith("lib"))
		)
			found.encoders.add(value);
	}
	for (const match of code.matchAll(/encoder::find_by_name\(\s*"([^"]+)"/g))
		found.encoders.add(match[1]);
	for (const match of code.matchAll(
		/encoder::find\(\s*(?:ffmpeg::)?(?:codec::)?(?:id::)?Id::([A-Za-z0-9_]+)/g,
	))
		if (match[1] !== "None")
			found.encoders.add(ENCODER_FOR_ID[match[1]] ?? `codec id ${match[1]}`);

	for (const match of code.matchAll(/output_as\(([^;]*?)"([a-z0-9_]+)"\s*\)/g))
		found.muxers.add(match[2]);
	for (const match of code.matchAll(/av_guess_format\(\s*c"([a-z0-9_]+)"/g))
		found.muxers.add(match[1]);

	for (const match of code.matchAll(/filter::find\(\s*"([^"]+)"/g))
		found.filters.add(match[1]);
	if (/filter::(?:Graph|find)/.test(code)) {
		for (const { value } of literals(code)) {
			for (const segment of value.split(/[,;]/)) {
				const token = segment.trim().match(/^([a-z][a-z0-9_]*)(=|$)/);
				if (token && names.filters.has(token[1])) found.filters.add(token[1]);
			}
		}
	}
	return found;
}

async function sourceFiles(directory, files = []) {
	const relative = path.relative(repoRoot, directory).split(path.sep).join("/");
	if (UNSHIPPED_CRATES.has(relative)) return files;
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith("."))
				await sourceFiles(full, files);
		} else if (
			entry.name.endsWith(".rs") &&
			!/(^|_)tests?\.rs$/.test(entry.name)
		)
			files.push(full);
	}
	return files;
}

export async function check(root = repoRoot) {
	const components = await readFile(path.join(here, "components.sh"), "utf8");
	const names = readNames(
		await readFile(path.join(here, "ffmpeg-7.1-names.txt"), "utf8"),
	);
	const allowed = {
		encoders: new Set([
			...shellList(components, "CAP_ENCODERS_ALL"),
			...shellList(components, "CAP_ENCODERS_DARWIN"),
			...shellList(components, "CAP_ENCODERS_WINDOWS"),
			...shellList(components, "CAP_ENCODERS_LINUX"),
			...shellList(components, "CAP_ENCODERS_LINUX_X86_64"),
			...shellList(components, "CAP_PROBE_ONLY_ENCODERS"),
		]),
		muxers: new Set(shellList(components, "CAP_MUXERS")),
		filters: new Set(shellList(components, "CAP_FILTERS")),
	};

	const problems = [];
	for (const dir of SOURCE_DIRS) {
		for (const file of await sourceFiles(path.join(root, dir))) {
			const found = usages(await readFile(file, "utf8"), names);
			for (const kind of Object.keys(found)) {
				for (const name of found[kind]) {
					if (!allowed[kind].has(name))
						problems.push(`${path.relative(root, file)}: ${kind} ${name}`);
				}
			}
		}
	}
	return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const problems = await check();
	if (problems.length) {
		console.error(
			"These FFmpeg components are used in code but not built (add them to scripts/ffmpeg/components.sh):",
		);
		for (const problem of problems) console.error(`  ${problem}`);
		process.exit(1);
	}
	console.log("Every FFmpeg component Cap uses is built.");
}
