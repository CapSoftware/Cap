import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMacosBundles } from "./build-macos-bundles.mjs";
import { buildMacosIcon } from "./build-macos-icon.mjs";
import { buildMacosPackages } from "./build-macos-packages.mjs";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
export const gpuiDirectory = path.join(repoRoot, "apps", "desktop-gpui");
const desktopDirectory = path.join(repoRoot, "apps", "desktop");
export const gpuiToolchain = process.env.CAP_GPUI_RUST_TOOLCHAIN || "1.95.0";

const platformConfigNames = {
	darwin: "tauri.macos.conf.json",
	win32: "tauri.windows.conf.json",
	linux: "tauri.linux.conf.json",
};

export function targetPlatform(target) {
	if (/-apple-darwin$/.test(target)) return "darwin";
	if (/-pc-windows-msvc$/.test(target)) return "win32";
	if (/-unknown-linux-gnu$/.test(target)) return "linux";
	return null;
}

export function mainBinaryName(target) {
	return targetPlatform(target) === "win32" ? "Cap.exe" : "Cap";
}

export function gpuiBinaryPath(target, profile = "release") {
	const extension = targetPlatform(target) === "win32" ? ".exe" : "";
	return path.join(
		gpuiDirectory,
		"target",
		target,
		profile,
		`cap-gpui${extension}`,
	);
}

export function gpuiPlatformConfig(
	platform,
	{ appexBundles = [], icon = null } = {},
) {
	if (platform === "darwin") {
		const files = Object.fromEntries([
			...appexBundles.map((bundle) => [
				`PlugIns/${path.basename(bundle)}`,
				bundle,
			]),
			...(icon ? [["Resources/Assets.car", icon.assets]] : []),
		]);
		return {
			bundle: {
				resources: {
					"../../target/native-deps/onnxruntime/lib/libonnxruntime.dylib":
						"onnxruntime/lib/libonnxruntime.dylib",
				},
				...(Object.keys(files).length > 0 && {
					macOS: { files },
				}),
			},
		};
	}
	if (platform === "win32") {
		return {
			bundle: {
				resources: {
					"../../target/ffmpeg/bin/*.dll": "./",
					"../../target/native-deps/dxc/*.dll": "./",
					"../../target/native-deps/dxc/LICENSE-*.txt": "licenses/dxc/",
					"../../target/native-deps/onnxruntime/lib/*.dll": "./",
				},
			},
		};
	}
	return null;
}

export function profileArguments(profile) {
	return profile === "debug" ? ["--debug"] : [];
}

export function bundleArguments(target, args) {
	return ["tauri", "bundle", "--target", target, ...args];
}

export function bundleEnvironment(env) {
	return {
		...env,
		TAURI_APP_PATH: gpuiDirectory,
		RUSTUP_TOOLCHAIN: gpuiToolchain,
	};
}

function validate(target, args, profile) {
	const platform = targetPlatform(target ?? "");
	if (!platform || platform !== process.platform) {
		throw new Error(
			"Run on the target platform: node scripts/bundle-gpui.mjs <target-triple> [--skip-build] [--no-bundle] [tauri bundle options]",
		);
	}
	if (args.some((argument) => /^--(?:target|debug)(?:=|$)/.test(argument))) {
		throw new Error("The GPUI bundle is always a release build for <target>");
	}
	if (profile === "debug" && process.env.CI) {
		throw new Error("--profile=debug is for local bundles only");
	}
	return platform;
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed with ${result.signal ?? result.status}`,
		);
	}
}

const sha256 = (contents) =>
	createHash("sha256").update(contents).digest("hex");

export async function stageMainBinary(target, profile = "release") {
	const source = gpuiBinaryPath(target, profile);
	const destination = path.join(path.dirname(source), mainBinaryName(target));
	const built = await fs.readFile(source);
	if (built.length === 0) throw new Error(`${source} is empty`);
	await fs.copyFile(source, destination);
	await fs.chmod(destination, (await fs.stat(source)).mode & 0o7777);
	if (sha256(await fs.readFile(destination)) !== sha256(built)) {
		throw new Error(`${destination} does not match ${source}`);
	}
	return destination;
}

export async function writePlatformConfig(platform, options) {
	const config = gpuiPlatformConfig(platform, options);
	if (!config) return null;
	const file = path.join(gpuiDirectory, platformConfigNames[platform]);
	const contents = `${JSON.stringify(config, null, "\t")}\n`;
	const current = await fs.readFile(file, "utf8").catch(() => undefined);
	if (current !== contents) await fs.writeFile(file, contents);
	return file;
}

export function parseOptions(args) {
	const flags = new Set(["--skip-build", "--no-bundle", "--profile=debug"]);
	return {
		skipBuild: args.includes("--skip-build"),
		noBundle: args.includes("--no-bundle"),
		profile: args.includes("--profile=debug") ? "debug" : "release",
		bundleArgs: args.filter((argument) => !flags.has(argument)),
	};
}

export async function bundleGpui(target, args, { env = process.env } = {}) {
	const { skipBuild, noBundle, profile, bundleArgs } = parseOptions(args);
	const platform = validate(target, bundleArgs, profile);

	if (!skipBuild) {
		run("bash", [
			path.join(repoRoot, "scripts", "build-gpui-binary.sh"),
			profile,
			target,
		]);
	}
	const staged = await stageMainBinary(target, profile);
	console.log(`Staged ${staged}`);
	if (noBundle) return;
	const appexBundles =
		platform === "darwin" ? await buildMacosBundles(target, { env }) : [];
	const icon =
		platform === "darwin"
			? await buildMacosIcon({
					outputDirectory: path.join(
						gpuiDirectory,
						"target",
						target,
						profile,
						"icon",
					),
				})
			: null;
	await writePlatformConfig(platform, { appexBundles, icon });
	if (platform === "linux") {
		await fs
			.access(path.join(gpuiDirectory, platformConfigNames.linux))
			.catch(() => {
				throw new Error(
					"Missing apps/desktop-gpui/tauri.linux.conf.json; run `RUST_TARGET_TRIPLE=<target> bun run cap-setup` first",
				);
			});
	}

	const profileArgs = profileArguments(profile);
	if (platform === "darwin") {
		const result = await buildMacosPackages(
			target,
			[...bundleArgs, ...profileArgs],
			{
				bundleOnly: true,
				env: bundleEnvironment(env),
			},
		);
		if (result.signal || result.code !== 0) {
			throw new Error(
				`macOS GPUI bundling failed with ${result.signal ?? result.code}`,
			);
		}
		return;
	}

	run(
		"bun",
		["run", ...bundleArguments(target, [...bundleArgs, ...profileArgs])],
		{
			cwd: desktopDirectory,
			env: bundleEnvironment({ ...env, RUST_TARGET_TRIPLE: target }),
		},
	);
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const [target, ...args] = process.argv.slice(2);
	bundleGpui(target, args).catch((error) => {
		console.error(error?.message ?? error);
		process.exitCode = 1;
	});
}
