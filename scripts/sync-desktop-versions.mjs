import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const tauriManifest = path.join(
	repoRoot,
	"apps",
	"desktop",
	"src-tauri",
	"Cargo.toml",
);
const gpuiManifest = path.join(repoRoot, "apps", "desktop-gpui", "Cargo.toml");

function packageVersion(source, manifestPath) {
	const packageStart = source.indexOf("[package]");
	const packageEnd = source.indexOf("\n[", packageStart + 1);
	const section = source.slice(
		packageStart,
		packageEnd === -1 ? source.length : packageEnd,
	);
	const match = /^version\s*=\s*"([^"]+)"$/m.exec(section);
	if (!match) throw new Error(`package.version not found in ${manifestPath}`);
	return match[1];
}

function replacePackageVersion(source, manifestPath, version) {
	const packageStart = source.indexOf("[package]");
	const packageEnd = source.indexOf("\n[", packageStart + 1);
	const end = packageEnd === -1 ? source.length : packageEnd;
	const section = source.slice(packageStart, end);
	const nextSection = section.replace(
		/^version\s*=\s*"[^"]+"$/m,
		`version = "${version}"`,
	);
	if (nextSection === section)
		throw new Error(`package.version not found in ${manifestPath}`);
	return source.slice(0, packageStart) + nextSection + source.slice(end);
}

const [tauriSource, gpuiSource] = await Promise.all([
	fs.readFile(tauriManifest, "utf8"),
	fs.readFile(gpuiManifest, "utf8"),
]);
const version = packageVersion(tauriSource, tauriManifest);
const gpuiVersion = packageVersion(gpuiSource, gpuiManifest);

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version))
	throw new Error(`Invalid desktop version: ${version}`);

if (gpuiVersion !== version) {
	await fs.writeFile(
		gpuiManifest,
		replacePackageVersion(gpuiSource, gpuiManifest, version),
	);
	console.log(`Synchronized Cap GPUI ${gpuiVersion} -> ${version}`);
} else {
	console.log(`Cap desktop versions match: ${version}`);
}
