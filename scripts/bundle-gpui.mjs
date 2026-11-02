import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	detectHostTriple,
	nativeBuildEnvironment,
} from "./build-desktop-binaries.mjs";
import {
	buildMacosPackages,
	resolveMacosDeploymentTarget,
} from "./build-macos-packages.mjs";
import { minimumMacos, writeTauriOverlay } from "./fork-brand.mjs";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
export const gpuiDirectory = path.join(repoRoot, "apps", "desktop-gpui");
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

export function gpuiBinaryPath(
	target,
	profile = "release",
	directory = gpuiDirectory,
) {
	const extension = targetPlatform(target) === "win32" ? ".exe" : "";
	return path.join(
		directory,
		"target",
		...(profile === "debug" ? [] : [target]),
		profile,
		`cap-gpui${extension}`,
	);
}

export function gpuiPlatformConfig(platform) {
	if (platform === "darwin") {
		return {
			bundle: {
				resources: {
					"../../target/native-deps/onnxruntime/lib/libonnxruntime.dylib":
						"onnxruntime/lib/libonnxruntime.dylib",
				},
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

export function bundleArguments(target, args, { native = false } = {}) {
	return ["tauri", "bundle", ...(native ? [] : ["--target", target]), ...args];
}

export function bundleEnvironment(env) {
	return {
		...env,
		TAURI_APP_PATH: gpuiDirectory,
		RUSTUP_TOOLCHAIN: gpuiToolchain,
	};
}

function validate(target, args, currentPlatform) {
	const platform = targetPlatform(target ?? "");
	if (!platform || platform !== currentPlatform) {
		throw new Error(
			"Run on the target platform: node scripts/bundle-gpui.mjs <target-triple> [--debug] [--skip-build] [--no-bundle] [tauri bundle options]",
		);
	}
	if (
		args.some((argument) => /^--(?:target|debug|profile)(?:=|$)/.test(argument))
	) {
		throw new Error(
			"Select the GPUI target with <target> and the build profile with --debug",
		);
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

export async function stageMainBinary(
	target,
	profile = "release",
	options = {},
) {
	const source = gpuiBinaryPath(target, profile, options.directory);
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

export async function writePlatformConfig(platform) {
	const config = gpuiPlatformConfig(platform);
	if (!config) return null;
	const file = path.join(gpuiDirectory, platformConfigNames[platform]);
	const contents = `${JSON.stringify(config, null, "\t")}\n`;
	const current = await fs.readFile(file, "utf8").catch(() => undefined);
	if (current !== contents) await fs.writeFile(file, contents);
	return file;
}

export function parseOptions(args) {
	const flags = new Set(["--skip-build", "--no-bundle", "--debug"]);
	return {
		debug: args.includes("--debug"),
		skipBuild: args.includes("--skip-build"),
		noBundle: args.includes("--no-bundle"),
		bundleArgs: args.filter((argument) => !flags.has(argument)),
	};
}

export async function bundleGpui(
	target,
	args,
	{
		env = process.env,
		platform: currentPlatform = process.platform,
		runCommand = run,
		stageBinary = stageMainBinary,
		packageMacos = buildMacosPackages,
		writeConfig = writePlatformConfig,
		hostTriple = detectHostTriple,
		writeBrandConfig = writeTauriOverlay,
	} = {},
) {
	const {
		debug,
		skipBuild,
		noBundle,
		bundleArgs: requestedArgs,
	} = parseOptions(args);
	const platform = validate(target, requestedArgs, currentPlatform);
	if (debug) {
		const host = hostTriple({ env });
		if (target !== host)
			throw new Error(
				`Debug GPUI bundles require host target ${host}, received ${target}`,
			);
	}
	const profile = debug ? "debug" : "release";
	let environment = env;
	if (platform === "darwin") {
		environment = {
			...env,
			MACOSX_DEPLOYMENT_TARGET: resolveMacosDeploymentTarget(
				env.MACOSX_DEPLOYMENT_TARGET,
				minimumMacos,
			),
		};
	}
	const buildEnv = debug ? nativeBuildEnvironment(environment) : environment;
	if (!skipBuild) {
		runCommand(
			"bash",
			[
				path.join(repoRoot, "scripts", "build-gpui-binary.sh"),
				profile,
				...(debug ? [] : [target]),
			],
			{ env: buildEnv },
		);
	}
	const staged = await stageBinary(target, profile);
	console.log(`Staged ${staged}`);
	if (noBundle) return;
	await writeConfig(platform);
	const bundleArgs = [
		...(debug ? ["--debug"] : []),
		"--config",
		await writeBrandConfig(gpuiDirectory),
		...requestedArgs,
	];
	if (platform === "linux") {
		await fs
			.access(path.join(gpuiDirectory, platformConfigNames.linux))
			.catch(() => {
				throw new Error(
					"Missing apps/desktop-gpui/tauri.linux.conf.json; run `RUST_TARGET_TRIPLE=<target> bun run cap-setup` first",
				);
			});
	}

	if (platform === "darwin") {
		const result = await packageMacos(target, bundleArgs, {
			native: debug,
			env: bundleEnvironment(buildEnv),
		});
		if (result.signal || result.code !== 0) {
			throw new Error(
				`macOS GPUI bundling failed with ${result.signal ?? result.code}`,
			);
		}
		return;
	}

	runCommand(
		"bun",
		["run", ...bundleArguments(target, bundleArgs, { native: debug })],
		{
			cwd: gpuiDirectory,
			env: bundleEnvironment({ ...buildEnv, RUST_TARGET_TRIPLE: target }),
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
