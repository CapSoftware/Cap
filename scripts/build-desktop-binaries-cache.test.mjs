import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
	releaseBinaryMatchesDebugBinary,
	stagedBinariesAreCurrent,
} from "./build-desktop-binaries-cache.mjs";

async function fixture(context) {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "cap-sidecar-cache-"),
	);
	context.after(async () => fs.rm(directory, { recursive: true, force: true }));
	const watched = path.join(directory, "source.rs");
	const release = path.join(directory, "release.exe");
	const cli = path.join(directory, "cap-cli.exe");
	const exporter = path.join(directory, "cap-exporter.exe");
	await fs.writeFile(watched, "source");
	await fs.writeFile(release, "optimized");
	await fs.writeFile(cli, "optimized");
	await fs.writeFile(exporter, "optimized");
	const sourceTime = new Date("2025-01-01T00:00:00.000Z");
	const binaryTime = new Date("2025-01-02T00:00:00.000Z");
	await fs.utimes(watched, sourceTime, sourceTime);
	for (const file of [release, cli, exporter])
		await fs.utimes(file, binaryTime, binaryTime);
	return { watched, release, cli, exporter, binaryTime };
}

test("rejects a debug binary copied into the release artifact path", async (context) => {
	const { watched, release, cli, exporter } = await fixture(context);
	const debug = path.join(path.dirname(release), "debug.exe");
	await fs.writeFile(debug, "optimized");

	assert.equal(await releaseBinaryMatchesDebugBinary(release, [debug]), true);
	assert.equal(
		await stagedBinariesAreCurrent(
			release,
			[cli, exporter],
			[watched],
			[debug],
		),
		false,
	);
});

test("accepts an optimized release artifact when a different debug binary exists", async (context) => {
	const { watched, release, cli, exporter } = await fixture(context);
	const debug = path.join(path.dirname(release), "debug.exe");
	await fs.writeFile(debug, "debug-one");

	assert.equal(await releaseBinaryMatchesDebugBinary(release, [debug]), false);
	assert.equal(
		await stagedBinariesAreCurrent(
			release,
			[cli, exporter],
			[watched],
			[debug],
		),
		true,
	);
});

test("accepts current release binary and byte-identical staged sidecars", async (context) => {
	const { watched, release, cli, exporter } = await fixture(context);
	assert.equal(
		await stagedBinariesAreCurrent(release, [cli, exporter], [watched]),
		true,
	);
});

test("rejects staged sidecars when the release binary does not exist", async (context) => {
	const { watched, release, cli, exporter } = await fixture(context);
	await fs.rm(release);
	assert.equal(
		await stagedBinariesAreCurrent(release, [cli, exporter], [watched]),
		false,
	);
});

test("rejects same-sized debug content even when staged files are newer", async (context) => {
	const { watched, release, cli, exporter, binaryTime } =
		await fixture(context);
	await fs.writeFile(cli, "debug-old");
	await fs.utimes(cli, binaryTime, binaryTime);
	assert.equal(
		await stagedBinariesAreCurrent(release, [cli, exporter], [watched]),
		false,
	);
});

test("rejects a release binary older than watched source", async (context) => {
	const { watched, release, cli, exporter } = await fixture(context);
	const newerSource = new Date("2025-01-03T00:00:00.000Z");
	await fs.utimes(watched, newerSource, newerSource);
	assert.equal(
		await stagedBinariesAreCurrent(release, [cli, exporter], [watched]),
		false,
	);
});

test("rejects any missing or mismatched secondary destination", async (context) => {
	const { watched, release, cli, exporter, binaryTime } =
		await fixture(context);
	await fs.writeFile(exporter, "wrong-one");
	await fs.utimes(exporter, binaryTime, binaryTime);
	assert.equal(
		await stagedBinariesAreCurrent(release, [cli, exporter], [watched]),
		false,
	);
	await fs.rm(exporter);
	assert.equal(
		await stagedBinariesAreCurrent(release, [cli, exporter], [watched]),
		false,
	);
});
