import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
export const gpuiIconsDirectory = path.join(
	repoRoot,
	"apps",
	"desktop-gpui",
	"icons",
);
export const iconComposerName = "cap-solarium";
export const accentColorName = "AccentColor";

export function actoolArguments({ source, catalog, output, partialPlist }) {
	return [
		source,
		catalog,
		"--compile",
		output,
		"--output-format",
		"human-readable-text",
		"--notices",
		"--warnings",
		"--output-partial-info-plist",
		partialPlist,
		"--app-icon",
		iconComposerName,
		"--accent-color",
		accentColorName,
		"--include-all-app-icons",
		"--enable-on-demand-resources",
		"NO",
		"--development-region",
		"en",
		"--target-device",
		"mac",
		"--minimum-deployment-target",
		"12.3",
		"--platform",
		"macosx",
	];
}

function plistString(contents, key) {
	const match = new RegExp(
		`<key>${key}</key>\\s*<string>([^<]+)</string>`,
	).exec(contents);
	return match?.[1];
}

export function iconNameFromPartialPlist(contents) {
	const name = plistString(contents, "CFBundleIconName");
	if (!name) throw new Error("actool did not report CFBundleIconName");
	return name;
}

export function accentNameFromPartialPlist(contents) {
	return plistString(contents, "NSAccentColorName");
}

export async function buildMacosIcon({
	source = path.join(gpuiIconsDirectory, `${iconComposerName}.icon`),
	catalog = path.join(gpuiIconsDirectory, "Cap.xcassets"),
	outputDirectory,
	platform = process.platform,
	run = (command, args) => spawnSync(command, args, { encoding: "utf8" }),
} = {}) {
	if (platform !== "darwin") {
		throw new Error("The Icon Composer icon can only be compiled on macOS");
	}
	const output = path.resolve(outputDirectory);
	await fs.mkdir(output, { recursive: true });
	const partialPlist = path.join(output, "partial.plist");
	const result = run("xcrun", [
		"actool",
		...actoolArguments({ source, catalog, output, partialPlist }),
	]);
	if (result.status !== 0) {
		throw new Error(`actool failed: ${result.stderr || result.stdout}`);
	}
	const assets = path.join(output, "Assets.car");
	await fs.access(assets);
	const plist = await fs.readFile(partialPlist, "utf8");
	return {
		assets,
		iconName: iconNameFromPartialPlist(plist),
		accentName: accentNameFromPartialPlist(plist),
	};
}
