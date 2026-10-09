import { readdir } from "node:fs/promises";
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
import {
	supportedLinuxBundles,
	supportedLinuxClassicBundles,
} from "./linux-bundle-config.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const desktopDirectory = path.join(repoRoot, "apps", "desktop");

const [target, app, ...args] = process.argv.slice(2);
if (
	process.platform !== "linux" ||
	!/^\w+-unknown-linux-gnu$/.test(target ?? "") ||
	(app !== "cap" && app !== "classic") ||
	args.some((arg) => /^--(?:target|bundles|debug|profile)(?:=|$)/.test(arg))
) {
	throw new Error(
		"Run on Linux: node scripts/build-linux-packages.mjs <target> <cap|classic> [tauri options]",
	);
}
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
	throw new Error(
		"TAURI_SIGNING_PRIVATE_KEY is required for Linux release packages",
	);
}

function cargoMetadata(cwd) {
	return JSON.parse(
		runCommand("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
		}).stdout,
	);
}

const classic = cargoMetadata(path.join(desktopDirectory, "src-tauri"));
const version = classic.packages.find(
	(pkg) => pkg.name === "cap-desktop",
)?.version;
if (!version) throw new Error("Desktop version is missing from Cargo metadata");

let targetDirectory;
if (app === "classic") {
	targetDirectory = classic.target_directory;
	runCommand(
		"bun",
		[
			"run",
			"build:tauri",
			"--target",
			target,
			"--bundles",
			supportedLinuxClassicBundles().join(","),
			...args,
		],
		{
			cwd: desktopDirectory,
			env: { ...process.env, RUST_TARGET_TRIPLE: target },
		},
	);
} else {
	targetDirectory = path.join(gpuiDirectory, "target");
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
}

const bundleRoot = path.join(targetDirectory, target, "release/bundle");

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
if (app === "cap") {
	for (const deb of await bundledArtifacts("deb", ".deb")) {
		await finalizeGpuiDeb(deb);
	}
	for (const rpm of await bundledArtifacts("rpm", ".rpm")) {
		await finalizeGpuiRpm(rpm);
	}
}
await finalizeLinuxAppImage(images[0], { webview: app === "classic" });
