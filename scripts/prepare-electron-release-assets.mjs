import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";

const TARGETS = [
	"x86_64-apple-darwin",
	"aarch64-apple-darwin",
	"x86_64-pc-windows-msvc",
	"x86_64-unknown-linux-gnu",
];
const RELEASE_ASSET_PATTERN = /\.(?:deb|dmg|exe|yml|zip)$/i;
const MAC_MANIFEST_PATTERN = /-mac\.yml$/i;
const REQUIRED_PATTERNS = new Map([
	["x86_64-apple-darwin", [/\.dmg$/i, /\.zip$/i, MAC_MANIFEST_PATTERN]],
	["aarch64-apple-darwin", [/\.dmg$/i, /\.zip$/i, MAC_MANIFEST_PATTERN]],
	["x86_64-pc-windows-msvc", [/\.exe$/i, /\.yml$/i]],
	["x86_64-unknown-linux-gnu", [/\.deb$/i, /\.yml$/i]],
]);

function parseManifest(contents, source) {
	const manifest = parse(contents);
	if (!manifest || typeof manifest !== "object")
		throw new Error(`${source} is not a YAML object`);
	if (typeof manifest.version !== "string" || !manifest.version)
		throw new Error(`${source} has no version`);
	if (!Array.isArray(manifest.files) || manifest.files.length === 0)
		throw new Error(`${source} has no update files`);
	for (const file of manifest.files) {
		if (
			!file ||
			typeof file !== "object" ||
			typeof file.url !== "string" ||
			typeof file.sha512 !== "string"
		)
			throw new Error(`${source} contains an invalid update file`);
	}
	return manifest;
}

export function mergeMacManifests(x64Contents, arm64Contents) {
	const x64 = parseManifest(x64Contents, "x64 macOS manifest");
	const arm64 = parseManifest(arm64Contents, "arm64 macOS manifest");
	if (x64.version !== arm64.version)
		throw new Error(
			`macOS manifest versions differ: ${x64.version} vs ${arm64.version}`,
		);

	const files = [...x64.files, ...arm64.files];
	const urls = new Set(files.map((file) => file.url));
	if (urls.size !== files.length)
		throw new Error("macOS manifests contain duplicate update URLs");
	if (![...urls].some((url) => url.includes("arm64")))
		throw new Error("arm64 macOS manifest has no arm64 artifact");
	if (![...urls].some((url) => !url.includes("arm64")))
		throw new Error("x64 macOS manifest has no x64 artifact");

	return stringify(
		{
			...x64,
			files,
		},
		{ lineWidth: 0 },
	);
}

export async function prepareReleaseAssets(inputDir, outputDir) {
	await fs.rm(outputDir, { recursive: true, force: true });
	await fs.mkdir(outputDir, { recursive: true });

	const copiedNames = new Set();
	const macManifests = new Map();
	for (const target of TARGETS) {
		const artifactDir = path.join(inputDir, `release-assets-${target}`);
		const entries = await fs.readdir(artifactDir, { withFileTypes: true });
		const assets = entries.filter(
			(entry) => entry.isFile() && RELEASE_ASSET_PATTERN.test(entry.name),
		);
		if (assets.length === 0)
			throw new Error(`No release assets found for ${target}`);
		for (const requiredPattern of REQUIRED_PATTERNS.get(target) ?? []) {
			if (!assets.some((asset) => requiredPattern.test(asset.name)))
				throw new Error(
					`Release assets for ${target} are missing ${requiredPattern}`,
				);
		}

		for (const asset of assets) {
			const source = path.join(artifactDir, asset.name);
			if ((await fs.stat(source)).size === 0)
				throw new Error(`Release asset is empty: ${asset.name}`);
			if (
				target.endsWith("apple-darwin") &&
				MAC_MANIFEST_PATTERN.test(asset.name)
			) {
				macManifests.set(target, { name: asset.name, source });
				continue;
			}
			if (copiedNames.has(asset.name))
				throw new Error(`Duplicate release asset name: ${asset.name}`);
			copiedNames.add(asset.name);
			await fs.copyFile(source, path.join(outputDir, asset.name));
		}
	}

	const x64Manifest = macManifests.get("x86_64-apple-darwin");
	const arm64Manifest = macManifests.get("aarch64-apple-darwin");
	if (!x64Manifest || !arm64Manifest)
		throw new Error("Both macOS updater manifests are required");
	if (x64Manifest.name !== arm64Manifest.name)
		throw new Error(
			`macOS manifest names differ: ${x64Manifest.name} vs ${arm64Manifest.name}`,
		);

	const mergedManifest = mergeMacManifests(
		await fs.readFile(x64Manifest.source, "utf8"),
		await fs.readFile(arm64Manifest.source, "utf8"),
	);
	await fs.writeFile(
		path.join(outputDir, x64Manifest.name),
		mergedManifest,
		"utf8",
	);

	return (await fs.readdir(outputDir)).sort();
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const [, , inputDir, outputDir] = process.argv;
	if (!inputDir || !outputDir)
		throw new Error(
			"Usage: node scripts/prepare-electron-release-assets.mjs <input-dir> <output-dir>",
		);
	const assets = await prepareReleaseAssets(inputDir, outputDir);
	console.log(`Prepared ${assets.length} release assets: ${assets.join(", ")}`);
}
