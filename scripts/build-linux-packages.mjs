import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	finalizeLinuxAppImage,
	runCommand,
} from "./finalize-linux-appimage.mjs";
import { supportedLinuxBundles } from "./linux-bundle-config.mjs";

const [target, ...args] = process.argv.slice(2);
if (
	process.platform !== "linux" ||
	!/^\w+-unknown-linux-gnu$/.test(target ?? "") ||
	args.some((arg) => /^--(?:target|bundles|debug|profile)(?:=|$)/.test(arg))
) {
	throw new Error(
		"Run on Linux: node scripts/build-linux-packages.mjs <target> [tauri build options]",
	);
}
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
	throw new Error(
		"TAURI_SIGNING_PRIVATE_KEY is required for Linux release packages",
	);
}

const desktopDirectory = fileURLToPath(
	new URL("../apps/desktop/", import.meta.url),
);
const metadata = runCommand(
	"cargo",
	["metadata", "--no-deps", "--format-version", "1"],
	{
		cwd: path.join(desktopDirectory, "src-tauri"),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	},
);
const workspace = JSON.parse(metadata.stdout);
const targetDirectory = workspace.target_directory;
const version = workspace.packages.find(
	(pkg) => pkg.name === "cap-desktop",
)?.version;
if (!version) throw new Error("Desktop version is missing from Cargo metadata");
const bundles = supportedLinuxBundles(version).join(",");

runCommand(
	"pnpm",
	["build:tauri", "--target", target, "--bundles", bundles, ...args],
	{
		cwd: desktopDirectory,
		env: { ...process.env, RUST_TARGET_TRIPLE: target },
	},
);

const bundleDirectory = path.join(
	targetDirectory,
	target,
	"release/bundle/appimage",
);
const images = (await readdir(bundleDirectory)).filter((file) =>
	file.endsWith(".AppImage"),
);
if (images.length !== 1) {
	throw new Error(
		`Expected one AppImage in ${bundleDirectory}, found ${images.length}`,
	);
}
await finalizeLinuxAppImage(path.join(bundleDirectory, images[0]));
