import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const brand = JSON.parse(
	readFileSync(path.join(root, "crates/fork-brand/brand.json"), "utf8"),
);

const kept = JSON.parse(
	readFileSync(path.join(root, "crates/fork-brand/kept-names.json"), "utf8"),
);

const words = (name) =>
	name
		.trim()
		.split(/[\s_-]+/)
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("[\\s_-]?");

const namePattern = (names, end = "\\b") =>
	new RegExp(names.map((name) => `\\b${words(name)}${end}`).join("|"), "gi");

const formerNames = namePattern(brand.former_names, "");
const currentNames = namePattern([
	brand.display_name,
	brand.cli_name,
	brand.skill_name,
	brand.slug,
]);
const stableIdentifiers = kept.stable_identifiers.map(({ id }) => id);

const startsWithAny = (file, prefixes) =>
	prefixes.some((prefix) => file.startsWith(prefix));

export function brandLeaks(file, contents) {
	if (startsWithAny(file, kept.door) || startsWithAny(file, kept.vendored)) {
		return [];
	}
	const prose = kept.prose_docs.includes(file);
	const leaks = [];
	contents.split("\n").forEach((line, index) => {
		const body = stableIdentifiers.reduce(
			(text, id) => text.replaceAll(id, ""),
			line,
		);
		const former = !body.includes("previously named") && formerNames.test(body);
		formerNames.lastIndex = 0;
		const current = !prose && currentNames.test(body);
		currentNames.lastIndex = 0;
		if (former || current) leaks.push(`${file}:${index + 1}: ${line.trim()}`);
	});
	return leaks;
}

export function expand(text) {
	return text
		.replaceAll("%walk%", brand.walk_mode_name)
		.replaceAll("%app%", brand.display_name)
		.replaceAll("%cli%", brand.cli_name)
		.replaceAll("%skill%", brand.skill_name)
		.replaceAll("%upstream%", brand.upstream_name)
		.replaceAll("%repo%", brand.repo_url);
}

export const minimumMacos = brand.macos.minimum_system_version;

export function tauriOverlay() {
	return {
		productName: brand.display_name,
		identifier: brand.bundle_id,
		plugins: {
			"deep-link": { desktop: { schemes: [brand.url_scheme] } },
		},
		bundle: {
			createUpdaterArtifacts: false,
			longDescription: expand(brand.long_description),
			icon: brand.icon,
			macOS: { minimumSystemVersion: minimumMacos },
		},
	};
}

export async function writeTauriOverlay(directory) {
	const file = path.join(directory, "target", "fork-brand.conf.json");
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify(tauriOverlay(), null, "\t")}\n`);
	return file;
}

export function infoPlistEdits(plist) {
	const strings = [
		["CFBundleName", brand.display_name],
		["CFBundleDisplayName", brand.display_name],
		["NSCameraUsageDescription", expand(brand.macos.camera_usage)],
		["NSMicrophoneUsageDescription", expand(brand.macos.microphone_usage)],
		[
			"NSScreenCaptureUsageDescription",
			expand(brand.macos.screen_capture_usage),
		],
	];
	const edits = strings.map(([key, value]) => [
		"-replace",
		key,
		"-string",
		value,
	]);
	if (plist.CFBundleDocumentTypes?.length) {
		edits.push([
			"-replace",
			"CFBundleDocumentTypes.0.CFBundleTypeName",
			"-string",
			expand(brand.macos.document_type_name),
		]);
	}
	if (plist.CFBundleLocalizations) {
		edits.push(["-remove", "CFBundleLocalizations"]);
	}
	return edits;
}

export async function brandBuiltApp(contents, plist) {
	const file = path.join(contents, "Info.plist");
	for (const edit of infoPlistEdits(plist)) {
		execFileSync("plutil", [...edit, file], { stdio: "ignore" });
	}
	const resources = path.join(contents, "Resources");
	for (const entry of await fs.readdir(resources)) {
		if (entry.endsWith(".lproj")) {
			const directory = path.join(resources, entry);
			await fs.rm(path.join(directory, "InfoPlist.strings"), { force: true });
			await fs.rmdir(directory).catch(() => {});
		}
	}
}

export async function brandEngineText(directory) {
	for (const entry of await fs.readdir(directory, {
		recursive: true,
		withFileTypes: true,
	})) {
		if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
		const file = path.join(entry.parentPath, entry.name);
		const before = await fs.readFile(file, "utf8");
		const after = brand.former_names.reduce(
			(text, former) => text.replaceAll(former, brand.display_name),
			before,
		);
		if (after !== before) await fs.writeFile(file, after);
	}
}
