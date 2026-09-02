import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
	buildMacosPackages,
	executeMacosCommand,
	isTimestampSigningFailure,
} from "./build-macos-packages.mjs";

const target = "x86_64-apple-darwin";
const config = ["--config", "src-tauri/tauri.prod.conf.json"];
const intelTimestampFailure = [
	"/Users/runner/work/Cap/Cap/target/x86_64-apple-darwin/release/bundle/macos/Cap.app/Contents/Frameworks/Spacedrive.framework/Versions/Current/Libraries/libavdevice.61.3.100.dylib: replacing existing signature",
	"/Users/runner/work/Cap/Cap/target/x86_64-apple-darwin/release/bundle/macos/Cap.app/Contents/Frameworks/Spacedrive.framework/Versions/Current/Libraries/libavdevice.61.3.100.dylib: A timestamp was expected but was not found.",
	"failed to bundle project: failed to sign app",
	"       Error failed to bundle project: failed to sign app",
	" ELIFECYCLE  Command failed with exit code 1.",
	" ELIFECYCLE  Command failed with exit code 1.",
	"",
].join("\n");
const armTimestampFailure = [
	"/Users/runner/work/Cap/Cap/target/aarch64-apple-darwin/release/bundle/macos/Cap.app: The timestamp service is not available.",
	"       Error failed to bundle project: failed to sign app",
	"",
].join("\n");

function harness(results) {
	const calls = [];
	const delays = [];
	const output = [];
	return {
		calls,
		delays,
		output,
		options: {
			platform: "darwin",
			env: {
				APPLE_SIGNING_IDENTITY: "fixture-identity",
				APPLE_API_KEY_PATH: "fixture-api-key-path",
				TAURI_SIGNING_PRIVATE_KEY: "fixture-updater-key",
				RUST_TARGET_TRIPLE: "previous-target",
			},
			execute: async (args, options) => {
				const result = results[calls.length];
				calls.push({ args, env: options.env });
				assert.ok(result, "Unexpected additional command");
				for (const chunk of result.chunks ?? [result.output ?? ""]) {
					options.onOutput("stderr", chunk);
				}
				return { code: result.code, signal: result.signal ?? null };
			},
			delay: async (milliseconds) => {
				delays.push(milliseconds);
			},
			onOutput: (stream, chunk) => output.push({ stream, chunk }),
		},
	};
}

test("recognizes the observed Intel and ARM signing failures with pnpm and ANSI output", () => {
	assert.equal(isTimestampSigningFailure(intelTimestampFailure), true);
	assert.equal(isTimestampSigningFailure(armTimestampFailure), true);
	assert.equal(
		isTimestampSigningFailure(
			intelTimestampFailure
				.replace("       Error", "\u001b[31m       Error\u001b[0m")
				.replaceAll("\n", "\r\n"),
		),
		true,
	);
});

test("only retries exact timestamp diagnostics with a terminal Tauri signing error", () => {
	for (const output of [
		"Error failed to bundle project: failed to sign app\n",
		intelTimestampFailure.replace(
			"A timestamp was expected but was not found.",
			"The specified item could not be found in the keychain.",
		),
		intelTimestampFailure.replaceAll(
			"failed to sign app",
			"failed to notarize app",
		),
		intelTimestampFailure.replace(
			"A timestamp was expected but was not found.",
			"A timestamp was expected but was not found. More details",
		),
		intelTimestampFailure.replace(
			"failed to bundle project: failed to sign app\n",
			"/Users/runner/work/Cap/Cap/target/x86_64-apple-darwin/release/bundle/macos/Cap.app: The specified item could not be found in the keychain.\nfailed to bundle project: failed to sign app\n",
		),
		`${intelTimestampFailure}error: could not compile cap-desktop\n`,
		"warning: A timestamp was expected but was not found.\nError failed to bundle project: failed to sign app\n",
	]) {
		assert.equal(isTimestampSigningFailure(output), false, output);
	}
});

test("successful builds never retry even if their output contains a timestamp diagnostic", async () => {
	const fixture = harness([{ code: 0, output: intelTimestampFailure }]);
	assert.equal(
		(await buildMacosPackages(target, config, fixture.options)).code,
		0,
	);
	assert.equal(fixture.calls.length, 1);
	assert.deepEqual(fixture.delays, []);
});

test("timestamp retries only rebundle and preserve the target, config and signing environment", async () => {
	const fixture = harness([
		{ code: 1, output: intelTimestampFailure },
		{ code: 1, output: armTimestampFailure },
		{ code: 0 },
	]);
	const args = [...config, "--config", "extra config.json", "--verbose"];
	const result = await buildMacosPackages(target, args, fixture.options);
	assert.equal(result.code, 0);
	const bundleArguments = [
		"exec",
		"dotenv",
		"-e",
		"../../.env",
		"--",
		"pnpm",
		"tauri",
		"bundle",
		"--target",
		target,
		...args,
	];
	assert.deepEqual(
		fixture.calls.map((call) => call.args),
		[
			["build:tauri", "--target", target, ...args],
			bundleArguments,
			bundleArguments,
		],
	);
	for (const call of fixture.calls) {
		assert.deepEqual(call.env, {
			...fixture.options.env,
			RUST_TARGET_TRIPLE: target,
		});
	}
	assert.deepEqual(fixture.delays, [15_000, 30_000]);
});

test("the third timestamp failure stays failed without another attempt", async () => {
	const fixture = harness([
		{ code: 1, output: intelTimestampFailure },
		{ code: 1, output: armTimestampFailure },
		{ code: 65, output: intelTimestampFailure },
	]);
	assert.equal(
		(await buildMacosPackages(target, config, fixture.options)).code,
		65,
	);
	assert.equal(fixture.calls.length, 3);
	assert.deepEqual(fixture.delays, [15_000, 30_000]);
});

test("a retry cannot reuse the previous attempt's timestamp diagnostic", async () => {
	const fixture = harness([
		{ code: 1, output: intelTimestampFailure },
		{ code: 1, output: "Error failed to bundle project: failed to sign app\n" },
	]);
	assert.equal(
		(await buildMacosPackages(target, config, fixture.options)).code,
		1,
	);
	assert.equal(fixture.calls.length, 2);
	assert.deepEqual(fixture.delays, [15_000]);
});

test("compiler, certificate, notarization and signal failures are terminal", async () => {
	for (const result of [
		{ code: 1, output: "error: could not compile cap-desktop\n" },
		{
			code: 1,
			output:
				"No signing identity found\nError failed to bundle project: failed to sign app\n",
		},
		{
			code: 1,
			output: intelTimestampFailure.replaceAll(
				"failed to sign app",
				"failed to notarize app",
			),
		},
		{ code: 1, signal: "SIGTERM", output: intelTimestampFailure },
		{ code: null, signal: "SIGKILL", output: intelTimestampFailure },
		{ code: 130, output: intelTimestampFailure },
		{ code: 137, output: intelTimestampFailure },
		{ code: 143, output: intelTimestampFailure },
		{ code: null, output: intelTimestampFailure },
	]) {
		const fixture = harness([result]);
		assert.deepEqual(
			await buildMacosPackages(target, config, fixture.options),
			{ code: result.code, signal: result.signal ?? null },
		);
		assert.equal(fixture.calls.length, 1);
		assert.deepEqual(fixture.delays, []);
	}
});

test("launch failures propagate without retry", async () => {
	const fixture = harness([]);
	const error = new Error("spawn pnpm ENOENT");
	await assert.rejects(
		buildMacosPackages(target, config, {
			...fixture.options,
			execute: async () => {
				throw error;
			},
		}),
		error,
	);
	assert.deepEqual(fixture.delays, []);
});

test("streams full output while discarding diagnostics outside the bounded tail", async () => {
	const prefix = "build output\n".repeat(8_000);
	const fixture = harness([
		{
			code: 1,
			chunks: [
				intelTimestampFailure,
				prefix,
				"Error failed to bundle project: failed to sign app\n",
			],
		},
	]);
	await buildMacosPackages(target, config, fixture.options);
	assert.equal(fixture.calls.length, 1);
	assert.equal(fixture.output[1].chunk, prefix);
	assert.deepEqual(fixture.delays, []);

	const recent = harness([
		{ code: 1, chunks: [prefix, intelTimestampFailure] },
		{ code: 0 },
	]);
	await buildMacosPackages(target, config, recent.options);
	assert.equal(recent.calls.length, 2);
});

test("cancellation before execution starts no child", async () => {
	const controller = new AbortController();
	const reason = new Error("cancelled");
	controller.abort(reason);
	const fixture = harness([]);
	await assert.rejects(
		buildMacosPackages(target, config, {
			...fixture.options,
			signal: controller.signal,
		}),
		reason,
	);
	assert.equal(fixture.calls.length, 0);
});

test("cancellation during execution waits for settlement and never retries", async () => {
	const controller = new AbortController();
	const reason = new Error("cancelled");
	const fixture = harness([]);
	let finish;
	let settled = false;
	const operation = buildMacosPackages(target, config, {
		...fixture.options,
		signal: controller.signal,
		execute: (_args, options) => {
			options.onOutput("stderr", intelTimestampFailure);
			return new Promise((resolve) => {
				finish = resolve;
			});
		},
	});
	const rejection = assert.rejects(operation, reason).then(() => {
		settled = true;
	});
	controller.abort(reason);
	await Promise.resolve();
	assert.equal(settled, false);
	finish({ code: 1, signal: null });
	await rejection;
	assert.deepEqual(fixture.delays, []);
});

test("cancellation during a retry delay prevents the next command", async () => {
	const controller = new AbortController();
	const reason = new Error("cancelled");
	const fixture = harness([{ code: 1, output: intelTimestampFailure }]);
	await assert.rejects(
		buildMacosPackages(target, config, {
			...fixture.options,
			signal: controller.signal,
			delay: async () => controller.abort(reason),
		}),
		reason,
	);
	assert.equal(fixture.calls.length, 1);
});

test("the executor cancels the child process group and waits for close", async () => {
	const controller = new AbortController();
	const reason = new Error("cancelled");
	const child = new EventEmitter();
	child.pid = 123;
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	const kills = [];
	const output = [];
	let settled = false;
	const operation = executeMacosCommand(["build:tauri"], {
		env: {},
		signal: controller.signal,
		onOutput: (stream, chunk) => output.push({ stream, chunk }),
		spawnProcess: (command, _args, options) => {
			assert.equal(command, "pnpm");
			assert.equal(options.detached, true);
			return child;
		},
		killProcess: (pid, signal) => kills.push({ pid, signal }),
	});
	const rejection = assert.rejects(operation, reason).then(() => {
		settled = true;
	});
	child.stdout.write("building\n");
	child.stderr.write("signing\n");
	controller.abort(reason);
	await Promise.resolve();
	assert.equal(settled, false);
	assert.deepEqual(kills, [{ pid: -123, signal: "SIGTERM" }]);
	child.emit("close", null, "SIGTERM");
	await rejection;
	assert.deepEqual(kills, [
		{ pid: -123, signal: "SIGTERM" },
		{ pid: -123, signal: "SIGKILL" },
	]);
	assert.deepEqual(output, [
		{ stream: "stdout", chunk: "building\n" },
		{ stream: "stderr", chunk: "signing\n" },
	]);
});

test("unsupported platforms and arguments fail before executing pnpm", async () => {
	for (const [platform, buildTarget, args] of [
		["win32", target, config],
		["linux", target, config],
		["darwin", "x86_64-pc-windows-msvc", config],
		["darwin", target, ["--config"]],
		["darwin", target, ["--target", "aarch64-apple-darwin"]],
		["darwin", target, ["--skip-stapling"]],
		["darwin", target, ["--no-bundle"]],
	]) {
		const fixture = harness([]);
		await assert.rejects(
			buildMacosPackages(buildTarget, args, { ...fixture.options, platform }),
			/Run on macOS/,
		);
		assert.equal(fixture.calls.length, 0);
	}
});
