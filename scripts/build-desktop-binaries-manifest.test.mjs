import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

test("workspace profile changes rebuild both sidecars, then cache the results", async (context) => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "cap-sidecar-manifest-"),
	);
	context.after(async () => fs.rm(root, { recursive: true, force: true }));
	await fs.mkdir(path.join(root, "scripts"));
	for (const name of [
		"build-desktop-binaries.mjs",
		"build-desktop-binaries-cache.mjs",
	])
		await fs.copyFile(
			path.join(import.meta.dirname, name),
			path.join(root, "scripts", name),
		);
	const target = "x86_64-pc-windows-msvc";
	const releaseDir = path.join(root, "target", target, "release");
	const stagedDir = path.join(root, "apps", "desktop-gpui", "binaries");
	await fs.mkdir(releaseDir, { recursive: true });
	await fs.mkdir(stagedDir, { recursive: true });
	const manifest = path.join(root, "Cargo.toml");
	await fs.writeFile(manifest, '[profile.release]\nopt-level = "s"\n');
	const sourceTime = new Date("2025-01-01");
	const binaryTime = new Date("2025-01-02");
	await fs.utimes(manifest, sourceTime, sourceTime);
	for (const [name, copies] of [
		["cap-muxer", ["cap-muxer"]],
		["cap", ["cap-cli", "cap-exporter"]],
	]) {
		const release = path.join(releaseDir, `${name}.exe`);
		await fs.writeFile(release, `optimized ${name}`);
		await fs.utimes(release, binaryTime, binaryTime);
		for (const copy of copies) {
			const staged = path.join(stagedDir, `${copy}-${target}.exe`);
			await fs.copyFile(release, staged);
			await fs.utimes(staged, binaryTime, binaryTime);
		}
	}
	const calls = path.join(root, "calls.jsonl");
	const hook = path.join(root, "cargo.cjs");
	await fs.writeFile(
		hook,
		`
const fs = require("node:fs");
const path = require("node:path");
require("node:child_process").spawnSync = (command, args, options) => {
	if (command !== "cargo") throw new Error("Unexpected command: " + command);
	const name = args[args.indexOf("-p") + 1];
	const target = args[args.indexOf("--target") + 1];
	fs.appendFileSync(path.join(options.cwd, "calls.jsonl"), JSON.stringify(args) + "\\n");
	fs.writeFileSync(path.join(options.cwd, "target", target, "release", name + ".exe"), "rebuilt " + name);
	return {status: 0};
};
require("node:module").syncBuiltinESMExports();
`,
	);
	const run = () => {
		const result = spawnSync(
			process.execPath,
			[
				"--require",
				hook,
				path.join(root, "scripts", "build-desktop-binaries.mjs"),
				target,
			],
			{ cwd: root, encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr || result.error?.message);
		return result.stdout;
	};
	assert.match(run(), /cap-cli, cap-exporter desktop binaries up to date/);
	assert.equal(
		await fs.access(calls).then(
			() => true,
			() => false,
		),
		false,
	);
	await fs.writeFile(manifest, '[profile.release]\nopt-level = "z"\n');
	const editedTime = new Date("2025-01-03");
	await fs.utimes(manifest, editedTime, editedTime);
	assert.match(run(), /Building cap-muxer desktop binaries/);
	const builds = (await fs.readFile(calls, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(
		builds.map((args) => args[args.indexOf("-p") + 1]),
		["cap-muxer", "cap"],
	);
	assert.match(run(), /cap-cli, cap-exporter desktop binaries up to date/);
	assert.equal((await fs.readFile(calls, "utf8")).trim().split("\n").length, 2);
});
