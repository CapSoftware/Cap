// @ts-check

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { shouldBundleGpui } from "../../../scripts/run-gpui-build.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Creates a Microsoft Windows Installer (TM) compatible version from the provided crate's semver version.
 * `major.minor.patch.build`
 *
 * @see {@link https://tauri.app/reference/config/#version-1}
 * @param {string} cargoFilePath
 * @returns {Promise<string>}
 */
async function semverToWIXCompatibleVersion(cargoFilePath) {
	const config = await fs.readFile(cargoFilePath, "utf-8");
	const match = /version\s*=\s*"([\w.-]+)"/.exec(config);
	if (!match)
		throw new Error(
			'Failed to extract version from "Cargo.toml". Have you removed the main crate version by accident?',
		);

	const ver = match[1];
	const [core, buildOrPrerelease] = ver.includes("+")
		? ver.split("+")
		: ver.split("-");
	const [major, minor, patch] = core.split(".");
	let build = 0;
	if (buildOrPrerelease) {
		const numMatch = buildOrPrerelease.match(/\d+$/);
		build = numMatch ? parseInt(numMatch[0], 10) : 0;
	}
	const wixVersion = `${major}.${minor}.${patch}${
		build === 0 ? "" : `.${build}`
	}`;
	if (wixVersion !== ver)
		console.log(`Using wix-compatible version ${ver} --> ${wixVersion}`);
	return wixVersion;
}
/**
 * Deeply merges two objects
 *
 * @param {Object} target
 * @param {Object} source
 * @returns {Object}
 */
export function deepMerge(target, source) {
	for (const key of Object.keys(source)) {
		if (
			source[key] instanceof Object &&
			key in target &&
			target[key] instanceof Object
		) {
			Object.assign(source[key], deepMerge(target[key], source[key]));
		}
	}
	return { ...target, ...source };
}

/**
 * Writes platform-specific tauri configs
 *
 * @param {NodeJS.Platform} platform
 * @param {{} | undefined} configOptions
 */
export async function createTauriPlatformConfigs(
	platform,
	configOptions = undefined,
) {
	const srcTauri = path.join(__dirname, "../src-tauri/");
	const profile = process.argv.includes("--release") ? "release" : "debug";
	const hostArchitecture = process.arch === "arm64" ? "aarch64" : "x86_64";
	const hostTargets = {
		darwin: `${hostArchitecture}-apple-darwin`,
		win32: `${hostArchitecture}-pc-windows-msvc`,
		linux: `${hostArchitecture}-unknown-linux-gnu`,
	};
	const target = process.env.RUST_TARGET_TRIPLE ?? hostTargets[platform];
	const extension = platform === "win32" ? ".exe" : "";
	const sidecarAvailable = target
		? await fs
				.access(
					path.join(srcTauri, "binaries", `cap-gpui-${target}${extension}`),
				)
				.then(() => true)
				.catch(() => false)
		: false;
	const developmentWorkspaceAvailable = await fs
		.access(path.join(__dirname, "../../desktop-gpui/dev.sh"))
		.then(() => true)
		.catch(() => false);
	const includeGpui = shouldBundleGpui(
		platform,
		process.env,
		profile,
		sidecarAvailable,
		developmentWorkspaceAvailable,
	);
	const externalBin = [
		"binaries/cap-muxer",
		"binaries/cap-exporter",
		"binaries/cap-cli",
		...(includeGpui ? ["binaries/cap-gpui"] : []),
	];
	let baseConfig = {};
	let configFileName = null;

	console.log(`Updating Platform (${platform}) Tauri config...`);
	if (platform === "win32") {
		configFileName = "tauri.windows.conf.json";
		baseConfig = {
			...baseConfig,
			bundle: {
				externalBin,
				resources: {
					"../../../target/ffmpeg/bin/*.dll": "./",
					"../../../target/native-deps/dxc/*.dll": "./",
					"../../../target/native-deps/dxc/LICENSE-*.txt": "licenses/dxc/",
					"../../../target/native-deps/onnxruntime/lib/*.dll": "./",
				},
				windows: {
					wix: {
						version: await semverToWIXCompatibleVersion(
							path.join(srcTauri, "Cargo.toml"),
						),
					},
				},
			},
		};
	}

	if (platform === "darwin") {
		configFileName = "tauri.macos.conf.json";
		baseConfig = {
			...baseConfig,
			bundle: {
				externalBin,
				resources: {
					"../../../target/native-deps/onnxruntime/lib/libonnxruntime.dylib":
						"onnxruntime/lib/libonnxruntime.dylib",
				},
			},
		};
	}

	if (platform === "linux") {
		configFileName = "tauri.linux.conf.json";
		const existingConfig = await fs
			.readFile(path.join(srcTauri, configFileName), "utf-8")
			.then(JSON.parse)
			.catch((error) => {
				if (error.code === "ENOENT") return {};
				throw error;
			});
		baseConfig = deepMerge(existingConfig, { bundle: { externalBin } });
	}

	if (!configFileName) return;

	const mergedConfig = configOptions
		? deepMerge(baseConfig, configOptions)
		: baseConfig;
	await writeFileIfChanged(
		`${srcTauri}/${configFileName}`,
		JSON.stringify(mergedConfig, null, 2),
	);
}

async function main() {
	console.log("--- Preparing sidecars and configs...");
	await createTauriPlatformConfigs(process.platform);
	console.log("--- Preparation finished");
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
	main().catch((err) => {
		console.error("\n--- Preparation Failed");
		console.error(err);
		console.error("---");
		process.exitCode = 1;
	});
}

async function writeFileIfChanged(filePath, contents) {
	const currentContents = await fs
		.readFile(filePath, "utf-8")
		.catch(() => undefined);

	if (currentContents !== contents) await fs.writeFile(filePath, contents);
}
