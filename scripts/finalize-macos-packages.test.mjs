import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCommand } from "./finalize-linux-appimage.mjs";
import {
	convertDiskImage,
	finalizeMacosPackages,
	recompressUpdaterArchive,
} from "./finalize-macos-packages.mjs";

const available = (command) =>
	spawnSync("sh", ["-c", `command -v ${command}`]).status === 0;
const zopfli = available("pigz") && available("shasum");

async function workspace(t) {
	const root = await mkdtemp(path.join(tmpdir(), "cap-macos-packages-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

async function updaterArchive(root) {
	const app = path.join(root, "app/Cap.app/Contents/MacOS");
	await mkdir(app, { recursive: true });
	const line = "Cap records your screen, camera and microphone.\n";
	await writeFile(path.join(app, "Cap"), line.repeat(20_000), { mode: 0o755 });
	const archive = path.join(root, "Cap.app.tar.gz");
	runCommand("bash", [
		"-c",
		'tar -C "$1" -cf - Cap.app | gzip -1 > "$2"',
		"bash",
		path.join(root, "app"),
		archive,
	]);
	await writeFile(`${archive}.sig`, "original signature");
	return archive;
}

const tarBytes = (archive) =>
	spawnSync("bash", ["-c", 'gzip -dc "$1"', "bash", archive]).stdout;

test(
	"the updater archive is recompressed with identical contents and signed again",
	{ skip: !zopfli },
	async (t) => {
		const root = await workspace(t);
		const archive = await updaterArchive(root);
		const original = tarBytes(archive);
		const before = (await stat(archive)).size;
		const signed = [];
		const result = await recompressUpdaterArchive(archive, {
			env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: "key" },
			run: async (command, args, options) => {
				if (command !== "bun") return runCommand(command, args, options);
				assert.deepEqual(args.slice(0, 4), ["run", "tauri", "signer", "sign"]);
				signed.push(await readFile(args[4]));
				await writeFile(`${args[4]}.sig`, "zopfli signature");
				return {};
			},
		});
		assert.ok(result.after < before, `${result.after} >= ${before}`);
		assert.equal((await stat(archive)).size, result.after);
		assert.deepEqual(tarBytes(archive), original);
		assert.deepEqual(signed, [await readFile(archive)]);
		assert.equal(await readFile(`${archive}.sig`, "utf8"), "zopfli signature");
	},
);

test("an updater archive whose contents change is left untouched", async (t) => {
	const root = await workspace(t);
	const archive = path.join(root, "Cap.app.tar.gz");
	await writeFile(archive, "original");
	await writeFile(`${archive}.sig`, "original signature");
	let digests = 0;
	await assert.rejects(
		recompressUpdaterArchive(archive, {
			env: { TAURI_SIGNING_PRIVATE_KEY: "key" },
			run: async (command, args) => {
				assert.equal(command, "bash");
				if (args[1].includes("pigz -11")) {
					await writeFile(args[4], "smaller");
					return {};
				}
				digests += 1;
				return { stdout: `${String(digests).repeat(64)}  -\n` };
			},
		}),
		/changed its contents/,
	);
	assert.equal(await readFile(archive, "utf8"), "original");
	assert.equal(await readFile(`${archive}.sig`, "utf8"), "original signature");
});

function diskImageHarness({ convertedSize, failAt = new Set() }) {
	const calls = [];
	let codesignFailures = failAt.has("codesign") ? 1 : 0;
	const run = async (command, args) => {
		calls.push([command, args[0]]);
		if (failAt.has(`${command} ${args[0]}`)) {
			throw new Error(`${command} ${args[0]} failed`);
		}
		if (command === "hdiutil" && args[0] === "convert") {
			assert.deepEqual(args.slice(2, 4), ["-format", "ULMO"]);
			await writeFile(args[5], Buffer.alloc(convertedSize, 1));
		}
		if (command === "codesign" && args[0] === "--force") {
			if (codesignFailures > 0) {
				codesignFailures -= 1;
				throw new Error("The timestamp service is not available.");
			}
			assert.deepEqual(args.slice(0, 5), [
				"--force",
				"--timestamp",
				"--sign",
				"Developer ID Application: Cap",
				"--keychain",
			]);
		}
		return {};
	};
	return { calls, run };
}

for (const scenario of [
	{ name: "smaller", convertedSize: 10, replaced: true },
	{ name: "larger", convertedSize: 400, replaced: false },
	{
		name: "failed",
		convertedSize: 10,
		failAt: new Set(["hdiutil verify"]),
		replaced: false,
	},
	{
		name: "retried",
		convertedSize: 10,
		failAt: new Set(["codesign"]),
		replaced: true,
	},
]) {
	test(`a ${scenario.name} LZMA disk image ${scenario.replaced ? "replaces" : "keeps"} the original`, async (t) => {
		const root = await workspace(t);
		const dmg = path.join(root, "Cap_0.6.1_aarch64.dmg");
		await writeFile(dmg, Buffer.alloc(100, 7));
		const { calls, run } = diskImageHarness(scenario);
		const delays = [];
		const warnings = [];
		const result = await convertDiskImage(dmg, {
			env: {
				APPLE_SIGNING_IDENTITY: "Developer ID Application: Cap",
				APPLE_KEYCHAIN: "/tmp/build.keychain",
			},
			run,
			delay: async (milliseconds) => delays.push(milliseconds),
			warn: (message) => warnings.push(message),
		});
		const contents = await readFile(dmg);
		if (scenario.replaced) {
			assert.deepEqual(contents, Buffer.alloc(10, 1));
			assert.deepEqual(result, { before: 100, after: 10 });
		} else {
			assert.deepEqual(contents, Buffer.alloc(100, 7));
		}
		if (scenario.name === "failed") {
			assert.equal(result, null);
			assert.match(warnings[0], /Keeping the zlib disk image/);
		}
		if (scenario.name === "retried") assert.deepEqual(delays, [15_000]);
		assert.deepEqual(calls[0], ["hdiutil", "convert"]);
		assert.ok(
			!(await readdir(root)).some((file) => file.startsWith(".cap-dmg-")),
		);
	});
}

test("disk image conversion needs a signing identity before touching the image", async (t) => {
	const root = await workspace(t);
	const dmg = path.join(root, "Cap.dmg");
	await writeFile(dmg, "original");
	await assert.rejects(
		convertDiskImage(dmg, {
			env: {},
			run: () => assert.fail("no command should run"),
		}),
		/APPLE_SIGNING_IDENTITY/,
	);
	assert.equal(await readFile(dmg, "utf8"), "original");
});

test("macOS packages are located once each inside the bundle", async (t) => {
	const root = await workspace(t);
	await mkdir(path.join(root, "macos"));
	await mkdir(path.join(root, "dmg"));
	await writeFile(path.join(root, "dmg/Cap_0.6.1_aarch64.dmg"), "dmg");
	await assert.rejects(
		finalizeMacosPackages(root, { env: {}, run: () => assert.fail() }),
		/Expected one \.app\.tar\.gz/,
	);
});
