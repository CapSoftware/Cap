import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gpuiDirectory } from "./bundle-gpui.mjs";
import {
	finalizeLinuxAppImage,
	runCommand,
} from "./finalize-linux-appimage.mjs";
import {
	finalizeGpuiDeb,
	finalizeGpuiRpm,
} from "./finalize-linux-gpui-packages.mjs";
import { supportedLinuxBundles } from "./linux-bundle-config.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const [target, ...args] = process.argv.slice(2);
if (
	process.platform !== "linux" ||
	!/^\w+-unknown-linux-gnu$/.test(target ?? "") ||
	args.some((arg) => /^--(?:target|bundles|debug|profile)(?:=|$)/.test(arg))
) {
	throw new Error(
		"Run on Linux: node scripts/build-linux-packages.mjs <target> [--skip-build] [tauri bundle options]",
	);
}
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
	throw new Error(
		"TAURI_SIGNING_PRIVATE_KEY is required for Linux release packages",
	);
}

const manifest = await readFile(path.join(gpuiDirectory, "Cargo.toml"), "utf8");
const packageStart = manifest.indexOf("[package]");
const packageEnd = manifest.indexOf("\n[", packageStart + 1);
const version =
	packageStart === -1
		? undefined
		: /^version\s*=\s*"([^"]+)"$/m.exec(
				manifest.slice(
					packageStart,
					packageEnd === -1 ? manifest.length : packageEnd,
				),
			)?.[1];
if (!version) throw new Error("Desktop version is missing from Cargo.toml");

runCommand(
	"node",
	[
		path.join(repoRoot, "scripts", "bundle-gpui.mjs"),
		target,
		"--bundles",
		supportedLinuxBundles(version).join(","),
		...args,
	],
	{ env: { ...process.env, RUST_TARGET_TRIPLE: target } },
);

const bundleRoot = path.join(gpuiDirectory, "target", target, "release/bundle");

async function bundledArtifacts(format, extension) {
	const directory = path.join(bundleRoot, format);
	const files = (await readdir(directory).catch(() => [])).filter((file) =>
		file.endsWith(extension),
	);
	return files.map((file) => path.join(directory, file));
}

const images = await bundledArtifacts("appimage", ".AppImage");
if (images.length !== 1) {
	throw new Error(
		`Expected one AppImage in ${bundleRoot}/appimage, found ${images.length}`,
	);
}
for (const deb of await bundledArtifacts("deb", ".deb")) {
	await finalizeGpuiDeb(deb);
}
for (const rpm of await bundledArtifacts("rpm", ".rpm")) {
	await finalizeGpuiRpm(rpm);
}
await finalizeLinuxAppImage(images[0], { webview: false });
