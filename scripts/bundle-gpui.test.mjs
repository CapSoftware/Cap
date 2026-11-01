import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	bundleArguments,
	bundleEnvironment,
	bundleGpui,
	gpuiBinaryPath,
	gpuiDirectory,
	gpuiPlatformConfig,
	mainBinaryName,
	parseOptions,
	stageMainBinary,
	targetPlatform,
} from "./bundle-gpui.mjs";

const readJson = (relative) =>
	JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));

const gpuiConfig = readJson("../apps/desktop-gpui/tauri.conf.json");

// Every Cap install since 0.6.0 checks for updates at this endpoint and only
// accepts packages signed for this key, so neither can change.
const shippedUpdaterPubkey =
	"dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEUyOTAzOTdFNzJFQkRFOTMKUldTVDN1dHlmam1RNHFXb1VYTXlrQk1iMFFkcjN0YitqZlA5WnZNY0ZtQ1dvM1dxK211M3VIYUQK";

test("targets map to their packaging platform and main binary", () => {
	assert.equal(targetPlatform("aarch64-apple-darwin"), "darwin");
	assert.equal(targetPlatform("x86_64-pc-windows-msvc"), "win32");
	assert.equal(targetPlatform("x86_64-unknown-linux-gnu"), "linux");
	assert.equal(targetPlatform("wasm32-unknown-unknown"), null);
	assert.equal(mainBinaryName("x86_64-pc-windows-msvc"), "Cap.exe");
	assert.equal(mainBinaryName("aarch64-apple-darwin"), "Cap");
	assert.equal(
		gpuiBinaryPath("x86_64-pc-windows-msvc"),
		path.join(
			gpuiDirectory,
			"target/x86_64-pc-windows-msvc/release/cap-gpui.exe",
		),
	);
});

test("the GPUI app keeps the identity every existing install updates into", () => {
	assert.equal(gpuiConfig.productName, "Cap");
	assert.equal(gpuiConfig.mainBinaryName, "Cap");
	assert.equal(gpuiConfig.identifier, "so.cap.desktop");
	assert.equal(gpuiConfig.plugins.updater.pubkey, shippedUpdaterPubkey);
	assert.deepEqual(gpuiConfig.plugins.updater.endpoints, [
		"https://cdn.crabnebula.app/update/cap/cap/{{target}}/{{current_version}}",
	]);
	const installer = readFileSync(
		new URL("../apps/desktop-gpui/src/installer.rs", import.meta.url),
		"utf8",
	);
	assert.match(
		installer,
		new RegExp(
			`const UPDATER_PUBLIC_KEY: &str = "${gpuiConfig.plugins.updater.pubkey}";`,
		),
	);
	assert.deepEqual(gpuiConfig.plugins["deep-link"], {
		desktop: { schemes: ["cap-desktop"] },
	});
	assert.equal(gpuiConfig.bundle.createUpdaterArtifacts, true);
});

test("every committed file the GPUI bundle references exists", () => {
	const files = [
		...gpuiConfig.bundle.icon,
		gpuiConfig.bundle.macOS.entitlements,
		gpuiConfig.bundle.macOS.dmg.background,
		gpuiConfig.bundle.windows.nsis.headerImage,
		gpuiConfig.bundle.windows.nsis.sidebarImage,
		gpuiConfig.bundle.windows.nsis.installerIcon,
		gpuiConfig.bundle.windows.nsis.installerHooks,
		"Info.plist",
	];
	for (const file of files) {
		assert.ok(existsSync(path.join(gpuiDirectory, file)), file);
	}
	for (const source of Object.keys(gpuiConfig.bundle.resources)) {
		assert.ok(
			existsSync(path.join(gpuiDirectory, path.dirname(source))),
			source,
		);
	}
	for (const binary of gpuiConfig.bundle.externalBin) {
		assert.ok(
			existsSync(path.join(gpuiDirectory, path.dirname(binary))),
			binary,
		);
	}
});

test("the GPUI bundle ships one CLI sidecar instead of two identical copies", () => {
	const names = gpuiConfig.bundle.externalBin.map((binary) =>
		path.basename(binary),
	);
	assert.deepEqual(names, ["cap-muxer", "cap-cli"]);
	assert.equal(gpuiConfig.bundle.windows.webviewInstallMode.type, "skip");
	assert.ok(
		!Object.values(gpuiConfig.bundle.resources).some((destination) =>
			destination.includes("rive"),
		),
	);
});

test("the Windows installer compresses with a window large enough to span both binaries", () => {
	assert.equal(gpuiConfig.bundle.windows.nsis.compression, "lzma");
	const hooks = readFileSync(
		path.join(gpuiDirectory, gpuiConfig.bundle.windows.nsis.installerHooks),
		"utf8",
	);
	const directives = hooks
		.split(/\r?\n/)
		.filter((line) => line.trim() && !line.trim().startsWith(";"));
	assert.equal(directives[0], "SetCompressorDictSize 128");
	assert.ok(
		directives.indexOf("SetCompressorDictSize 128") <
			directives.findIndex((line) => line.startsWith("!macro")),
	);
});

test("platform resources point at the shared native dependencies", () => {
	assert.deepEqual(gpuiPlatformConfig("darwin"), {
		bundle: {
			resources: {
				"../../target/native-deps/onnxruntime/lib/libonnxruntime.dylib":
					"onnxruntime/lib/libonnxruntime.dylib",
			},
		},
	});
	const windows = gpuiPlatformConfig("win32").bundle.resources;
	assert.equal(windows["../../target/ffmpeg/bin/*.dll"], "./");
	assert.equal(windows["../../target/native-deps/onnxruntime/lib/*.dll"], "./");
	assert.equal(gpuiPlatformConfig("linux"), null);
});

test("tauri bundle runs against the GPUI crate with its pinned toolchain", () => {
	assert.deepEqual(bundleArguments("x86_64-unknown-linux-gnu", ["--verbose"]), [
		"tauri",
		"bundle",
		"--target",
		"x86_64-unknown-linux-gnu",
		"--verbose",
	]);
	const environment = bundleEnvironment({ PATH: "/bin" });
	assert.equal(environment.PATH, "/bin");
	assert.equal(environment.TAURI_APP_PATH, gpuiDirectory);
	assert.match(environment.RUSTUP_TOOLCHAIN, /^\d+\.\d+\.\d+$/);
});

test("signing builds can stop before bundling and rebundle without rebuilding", () => {
	assert.deepEqual(parseOptions(["--no-bundle"]), {
		debug: false,
		skipBuild: false,
		noBundle: true,
		bundleArgs: [],
	});
	assert.deepEqual(parseOptions(["--skip-build", "--bundles", "nsis"]), {
		debug: false,
		skipBuild: true,
		noBundle: false,
		bundleArgs: ["--bundles", "nsis"],
	});
});

test("debug opts into the native profile while release keeps target-prefixed paths", () => {
	assert.deepEqual(
		parseOptions(["--debug", "--skip-build", "--bundles", "app"]),
		{
			debug: true,
			skipBuild: true,
			noBundle: false,
			bundleArgs: ["--bundles", "app"],
		},
	);
	assert.equal(
		gpuiBinaryPath("aarch64-apple-darwin", "debug"),
		path.join(gpuiDirectory, "target/debug/cap-gpui"),
	);
	assert.equal(
		gpuiBinaryPath("x86_64-pc-windows-msvc", "debug"),
		path.join(gpuiDirectory, "target/debug/cap-gpui.exe"),
	);
	assert.deepEqual(
		bundleArguments("aarch64-apple-darwin", ["--debug"], { native: true }),
		["tauri", "bundle", "--debug"],
	);
});

test("native debug staging copies the correct bytes and mode without replacing release artifacts", async (context) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-gpui-stage-"));
	context.after(() => fs.rm(directory, { recursive: true, force: true }));
	const target = "aarch64-apple-darwin";
	const debug = gpuiBinaryPath(target, "debug", directory);
	const release = gpuiBinaryPath(target, "release", directory);
	for (const file of [debug, release])
		await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(debug, "debug executable");
	await fs.chmod(debug, 0o751);
	await fs.writeFile(release, "release executable");
	const staged = await stageMainBinary(target, "debug", { directory });
	assert.equal(staged, path.join(directory, "target/debug/Cap"));
	assert.equal(await fs.readFile(staged, "utf8"), "debug executable");
	assert.equal((await fs.stat(staged)).mode & 0o777, 0o751);
	assert.equal(await fs.readFile(release, "utf8"), "release executable");
	await fs.writeFile(debug, "");
	await assert.rejects(
		stageMainBinary(target, "debug", { directory }),
		/is empty/,
	);
});

test("profile selection reaches the GPUI build, staging and macOS bundler", async () => {
	const target = "aarch64-apple-darwin";
	for (const debug of [false, true]) {
		const commands = [],
			stages = [],
			packages = [];
		await bundleGpui(
			target,
			[...(debug ? ["--debug"] : []), "--bundles", "app"],
			{
				platform: "darwin",
				env: {
					CARGO_BUILD_TARGET: "foreign-target",
					RUST_TARGET_TRIPLE: "foreign-target",
					PATH: "/bin",
				},
				hostTriple: () => {
					assert.equal(debug, true);
					return target;
				},
				runCommand: (...args) => commands.push(args),
				stageBinary: (...args) => {
					stages.push(args);
					return "/fixture/Cap";
				},
				writeConfig: async () => {},
				writeBrandConfig: async () => "/fixture/brand.json",
				packageMacos: async (...args) => {
					packages.push(args);
					return { code: 0 };
				},
			},
		);
		assert.deepEqual(
			commands[0][1].slice(1),
			debug ? ["debug"] : ["release", target],
		);
		assert.deepEqual(stages, [[target, debug ? "debug" : "release"]]);
		assert.deepEqual(packages[0][1], [
			...(debug ? ["--debug"] : []),
			"--config",
			"/fixture/brand.json",
			"--bundles",
			"app",
		]);
		assert.equal(packages[0][2].native, debug);
		assert.equal(packages[0][2].env.MACOSX_DEPLOYMENT_TARGET, "15.0");
		assert.equal(commands[0][2].env.MACOSX_DEPLOYMENT_TARGET, "15.0");
		if (debug) {
			assert.equal(commands[0][2].env.CARGO_BUILD_TARGET, undefined);
			assert.equal(commands[0][2].env.RUST_TARGET_TRIPLE, undefined);
			assert.equal(packages[0][2].env.CARGO_BUILD_TARGET, undefined);
		}
	}
});

test("debug cannot stage a foreign architecture or override the selected target/profile", async () => {
	for (const [target, args, platform] of [
		["x86_64-apple-darwin", ["--debug"], "darwin"],
		["aarch64-apple-darwin", ["--debug", "--target", "other"], "darwin"],
		["aarch64-apple-darwin", ["--debug=true"], "darwin"],
		["aarch64-apple-darwin", ["--profile", "custom"], "darwin"],
		["aarch64-apple-darwin", ["--debug"], "win32"],
	]) {
		let mutations = 0;
		await assert.rejects(
			bundleGpui(target, args, {
				platform,
				hostTriple: () => "aarch64-apple-darwin",
				runCommand: () => mutations++,
				stageBinary: () => mutations++,
			}),
		);
		assert.equal(mutations, 0);
	}
});
