import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	finalizeLinuxAppImage,
	findConflictingLibraries,
	preserveAppImageWorkingDirectory,
} from "./finalize-linux-appimage.mjs";

const runtimeSize = 64;
const digestMd5Offset = 16;
const originalRuntime = Buffer.alloc(runtimeSize, 0x52);
originalRuntime.write("cap runtime fixture");
Buffer.from("0123456789abcdef").copy(originalRuntime, digestMd5Offset);
const originalImage = Buffer.concat([
	originalRuntime,
	Buffer.from("original payload"),
]);
const digestSectionHeaders = `[ 1] .digest_md5 PROGBITS 0000000000000000 0000000000000010 0000000000000010 0000000000000000  A  0 0 1`;

function finalImage(runtime = originalRuntime) {
	return Buffer.concat([runtime, Buffer.from("final payload")]);
}

async function assertOriginalArtifact(image, signature) {
	assert.deepEqual(await readFile(image), originalImage);
	assert.equal(await readFile(`${image}.sig`, "utf8"), signature);
}

async function fixture(t) {
	const root = await mkdtemp(path.join(tmpdir(), "cap-appimage-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const image = path.join(root, "Cap.AppImage");
	const plugin = path.join(root, "output-plugin");
	await writeFile(image, originalImage, { mode: 0o755 });
	await writeFile(`${image}.sig`, "original signature");
	await writeFile(plugin, "fixture", { mode: 0o755 });
	return { root, image, plugin, originalRuntime };
}

for (const failureAt of [1, 2]) {
	test(`replacement failure ${failureAt} preserves the original artifact`, async (t) => {
		const { root, image, plugin } = await fixture(t);
		const env = {
			TAURI_SIGNING_PRIVATE_KEY: "test key",
		};
		let replacements = 0;
		const originalInode = (await stat(image)).ino;
		const run = async (command, args, options) => {
			if (command === image) {
				if (args[0] === "--appimage-signature") return { stdout: "" };
				if (args[0] === "--appimage-offset") {
					return { stdout: `${runtimeSize}` };
				}
				const appDir = path.join(options.cwd, "squashfs-root");
				await mkdir(appDir);
				await writeFile(path.join(appDir, "AppRun"), "launcher", {
					mode: 0o755,
				});
			} else if (command === plugin) {
				await writeFile(options.env.OUTPUT, finalImage());
			} else if (command === "readelf") {
				assert.deepEqual(args.slice(0, 2), ["--wide", "--section-headers"]);
				assert.equal(options.env.LC_ALL, "C");
				return { stdout: digestSectionHeaders };
			} else {
				assert.equal(command, "pnpm");
				await writeFile(`${args[3]}.sig`, "new signature");
			}
		};
		await assert.rejects(
			finalizeLinuxAppImage(image, {
				outputPlugin: plugin,
				env,
				run,
				replace: async (from, to) => {
					replacements += 1;
					if (replacements === failureAt) {
						throw new Error(`replacement ${failureAt} failed`);
					}
					await rename(from, to);
					if (to === image) {
						assert.notDeepEqual(await readFile(image), originalImage);
					}
				},
			}),
			new RegExp(`replacement ${failureAt} failed`),
		);
		await assertOriginalArtifact(image, "original signature");
		assert.equal((await stat(image)).mode & 0o111, 0o111);
		if (failureAt === 1) assert.equal((await stat(image)).ino, originalInode);
		assert.ok(
			!(await readdir(root)).some((file) => file.startsWith(".cap-appimage-")),
		);
	});
}

test("conflicting libraries are limited to Wayland clients and the root PipeWire copy without following directory symlinks", async (t) => {
	const { root } = await fixture(t);
	const appDir = path.join(root, "AppDir");
	const libraryDirectory = path.join(appDir, "usr/lib");
	await mkdir(libraryDirectory, { recursive: true });
	await writeFile(
		path.join(libraryDirectory, "libwayland-client.so.0.23.0"),
		"client",
	);
	await symlink(
		"libwayland-client.so.0.23.0",
		path.join(libraryDirectory, "libwayland-client.so.0"),
	);
	await writeFile(path.join(libraryDirectory, "libwayland-egl.so.1"), "egl");
	await writeFile(
		path.join(libraryDirectory, "libpipewire-0.3.so.0"),
		"pipewire",
	);
	await mkdir(path.join(libraryDirectory, "cap"));
	await writeFile(
		path.join(libraryDirectory, "cap/libpipewire-0.3.so.0"),
		"private copy",
	);
	await writeFile(path.join(root, "libwayland-client.so.99"), "outside");
	await symlink(root, path.join(appDir, "outside"));
	const libraries = await findConflictingLibraries(appDir);
	assert.deepEqual(libraries.map((file) => path.basename(file)).sort(), [
		"libpipewire-0.3.so.0",
		"libwayland-client.so.0",
		"libwayland-client.so.0.23.0",
	]);
});

for (const failure of [false, true]) {
	test(`signing ${failure ? "failure preserves the original artifact" : "uses the final bytes before replacing the artifact"}`, async (t) => {
		const { root, image, plugin } = await fixture(t);
		const calls = [];
		const env = {
			TAURI_SIGNING_PRIVATE_KEY: "test key",
			TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "test password",
		};
		const run = async (command, args, options) => {
			calls.push(command);
			assert.deepEqual(await readFile(image), originalImage);
			assert.equal(
				await readFile(`${image}.sig`, "utf8"),
				"original signature",
			);
			if (command === image) {
				if (args[0] === "--appimage-signature") return { stdout: "\n" };
				if (args[0] === "--appimage-offset") {
					return { stdout: `${runtimeSize}\n` };
				}
				assert.deepEqual(args, ["--appimage-extract"]);
				const libraries = path.join(options.cwd, "squashfs-root/usr/lib");
				await mkdir(libraries, { recursive: true });
				await writeFile(
					path.join(libraries, "libwayland-client.so.0"),
					"client",
				);
				await writeFile(
					path.join(libraries, "libwayland-server.so.0"),
					"server",
				);
				await writeFile(
					path.join(libraries, "libpipewire-0.3.so.0"),
					"pipewire",
				);
				await writeFile(
					path.join(options.cwd, "squashfs-root/AppRun"),
					"original launcher",
					{ mode: 0o755 },
				);
			} else if (command === "readelf") {
				return { stdout: digestSectionHeaders };
			} else if (command === plugin) {
				assert.equal(
					Buffer.compare(
						await readFile(options.env.LDAI_RUNTIME_FILE),
						originalRuntime,
					),
					0,
				);
				assert.notEqual(options.env.LDAI_RUNTIME_FILE, image);
				assert.equal(options.env.OUTPUT, options.env.LDAI_OUTPUT);
				assert.deepEqual(await readdir(path.join(args[2], "usr/lib")), [
					"libwayland-server.so.0",
				]);
				assert.equal(
					await readFile(path.join(args[2], "AppRun.cap-original"), "utf8"),
					"original launcher",
				);
				assert.match(
					await readFile(path.join(args[2], "AppRun"), "utf8"),
					/export OWD/,
				);
				const changedRuntime = Buffer.from(originalRuntime);
				changedRuntime.fill(0xa5, digestMd5Offset, digestMd5Offset + 16);
				await writeFile(options.env.OUTPUT, finalImage(changedRuntime));
			} else {
				assert.equal(command, "pnpm");
				assert.deepEqual(args.slice(0, 3), ["tauri", "signer", "sign"]);
				assert.equal(
					options.env.TAURI_PRIVATE_KEY,
					env.TAURI_SIGNING_PRIVATE_KEY,
				);
				assert.equal(
					options.env.TAURI_PRIVATE_KEY_PASSWORD,
					env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
				);
				assert.ok(!args.includes(env.TAURI_SIGNING_PRIVATE_KEY));
				if (failure) throw new Error("signer failed");
				const hash = createHash("sha256")
					.update(await readFile(args[3]))
					.digest("hex");
				await writeFile(`${args[3]}.sig`, hash);
			}
		};
		const operation = finalizeLinuxAppImage(image, {
			outputPlugin: plugin,
			env,
			run,
		});
		if (failure) {
			await assert.rejects(operation, /signer failed/);
			await assertOriginalArtifact(image, "original signature");
			assert.equal(
				await readFile(`${image}.sig`, "utf8"),
				"original signature",
			);
		} else {
			assert.deepEqual((await operation).sort(), [
				"usr/lib/libpipewire-0.3.so.0",
				"usr/lib/libwayland-client.so.0",
			]);
			const expectedRuntime = Buffer.from(originalRuntime);
			expectedRuntime.fill(0xa5, digestMd5Offset, digestMd5Offset + 16);
			assert.deepEqual(await readFile(image), finalImage(expectedRuntime));
			assert.equal(
				await readFile(`${image}.sig`, "utf8"),
				createHash("sha256").update(finalImage(expectedRuntime)).digest("hex"),
			);
		}
		assert.deepEqual(calls, [image, image, "readelf", image, plugin, "pnpm"]);
		assert.ok(
			!(await readdir(root)).some((file) => file.startsWith(".cap-appimage-")),
		);
	});
}

test("missing signing key or output tool fails before changing the input", async (t) => {
	const { image, plugin } = await fixture(t);
	await assert.rejects(
		finalizeLinuxAppImage(image, { outputPlugin: plugin, env: {} }),
		/TAURI_SIGNING_PRIVATE_KEY/,
	);
	await chmod(plugin, 0o644);
	await assert.rejects(
		finalizeLinuxAppImage(image, { outputPlugin: plugin, unsigned: true }),
		/EACCES/,
	);
	await assertOriginalArtifact(image, "original signature");
});

for (const invalidOffset of [
	"",
	"0",
	"-1",
	"80",
	"99999999999999999999",
	"9x",
]) {
	test(`invalid runtime offset ${JSON.stringify(invalidOffset)} preserves the input`, async (t) => {
		const { root, image, plugin } = await fixture(t);
		await assert.rejects(
			finalizeLinuxAppImage(image, {
				outputPlugin: plugin,
				unsigned: true,
				env: {},
				run: async (command, args) => {
					assert.equal(command, image);
					return {
						stdout: args[0] === "--appimage-signature" ? "" : invalidOffset,
					};
				},
			}),
			/Invalid AppImage runtime offset/,
		);
		await assertOriginalArtifact(image, "original signature");
		assert.ok(
			!(await readdir(root)).some((file) => file.startsWith(".cap-appimage-")),
		);
	});
}

for (const [name, sectionHeaders] of [
	[
		"missing",
		"[ 1] .text PROGBITS 0000000000000000 0000000000000010 0000000000000010",
	],
	[
		"malformed",
		"[ 1] .digest_md5 PROGBITS 0000000000000000 not-hex 0000000000000010",
	],
	[
		"short",
		"[ 1] .digest_md5 PROGBITS 0000000000000000 0000000000000010 000000000000000f",
	],
	[
		"out of range",
		"[ 1] .digest_md5 PROGBITS 0000000000000000 0000000000000038 0000000000000020",
	],
]) {
	test(`invalid digest section ${name} preserves the input`, async (t) => {
		const { root, image, plugin } = await fixture(t);
		await assert.rejects(
			finalizeLinuxAppImage(image, {
				outputPlugin: plugin,
				unsigned: true,
				env: {},
				run: async (command, args) => {
					if (command === image) {
						return {
							stdout:
								args[0] === "--appimage-signature" ? "" : `${runtimeSize}`,
						};
					}
					assert.equal(command, "readelf");
					return { stdout: sectionHeaders };
				},
			}),
			/digest_md5/,
		);
		await assertOriginalArtifact(image, "original signature");
		assert.ok(
			!(await readdir(root)).some((file) => file.startsWith(".cap-appimage-")),
		);
	});
}

test("runtime changes from the output plugin are rejected before signing", async (t) => {
	const { root, image, plugin } = await fixture(t);
	await assert.rejects(
		finalizeLinuxAppImage(image, {
			outputPlugin: plugin,
			env: { TAURI_SIGNING_PRIVATE_KEY: "test key" },
			run: async (command, args, options) => {
				if (command === image) {
					if (args[0] === "--appimage-signature") return { stdout: "" };
					if (args[0] === "--appimage-offset") {
						return { stdout: `${runtimeSize}` };
					}
					const appDir = path.join(options.cwd, "squashfs-root");
					await mkdir(appDir);
					await writeFile(path.join(appDir, "AppRun"), "launcher", {
						mode: 0o755,
					});
				} else if (command === "readelf") {
					return { stdout: digestSectionHeaders };
				} else {
					assert.equal(command, plugin);
					const changedRuntime = Buffer.from(originalRuntime);
					changedRuntime[0] ^= 0xff;
					await writeFile(options.env.OUTPUT, finalImage(changedRuntime));
				}
			},
		}),
		/did not preserve its runtime/,
	);
	await assertOriginalArtifact(image, "original signature");
	assert.ok(
		!(await readdir(root)).some((file) => file.startsWith(".cap-appimage-")),
	);
});

test("embedded GPG signatures and signing requests fail without changing the input", async (t) => {
	const { image, plugin } = await fixture(t);
	for (const env of [{ LDAI_SIGN: "1" }, { SIGN: "0" }]) {
		await assert.rejects(
			finalizeLinuxAppImage(image, {
				outputPlugin: plugin,
				unsigned: true,
				env,
			}),
			/Embedded GPG signing is unsupported/,
		);
	}
	await assert.rejects(
		finalizeLinuxAppImage(image, {
			outputPlugin: plugin,
			unsigned: true,
			env: {},
			run: async () => ({ stdout: "-----BEGIN PGP SIGNATURE-----" }),
		}),
		/without an embedded GPG signature/,
	);
	await assertOriginalArtifact(image, "original signature");
});

test("AppRun preserves caller paths and arguments in mounted and extracted launches", async (t) => {
	const { root } = await fixture(t);
	const appDir = path.join(root, "Cap's AppDir");
	await mkdir(path.join(appDir, "usr"), { recursive: true });
	const launcher = path.join(appDir, "AppRun");
	const original = `#!/bin/sh
cd "\${0%/*}/usr" || exit
printf '%s\\0' "$OWD" "$@"
exit 23
`;
	await writeFile(launcher, original, { mode: 0o755 });
	await preserveAppImageWorkingDirectory(appDir);
	await preserveAppImageWorkingDirectory(appDir);
	assert.equal(
		await readFile(path.join(appDir, "AppRun.cap-original"), "utf8"),
		original,
	);
	const direct = spawnSync("/bin/sh", ["AppRun", "--version"], {
		cwd: appDir,
	});
	assert.equal(direct.status, 23, direct.stderr.toString());
	assert.deepEqual(direct.stdout.toString().split("\0"), [
		await realpath(appDir),
		"--version",
		"",
	]);
	for (const name of ["caller's directory", "trailing-newline\n"]) {
		const caller = path.join(root, name);
		await mkdir(caller);
		for (const runtimeOwd of [undefined, "/stale/caller"]) {
			const env = { ...process.env };
			if (runtimeOwd === undefined) delete env.OWD;
			else env.OWD = runtimeOwd;
			const args = ["--cap-cli", "two words", "$(literal)", "last\n"];
			const result = spawnSync(launcher, args, { cwd: caller, env });
			assert.equal(result.status, 23, result.stderr.toString());
			assert.deepEqual(result.stdout.toString().split("\0"), [
				await realpath(caller),
				...args,
				"",
			]);
		}
	}
});

test("AppRun wrapping refuses an unrelated existing launcher backup", async (t) => {
	const { root } = await fixture(t);
	await writeFile(path.join(root, "AppRun"), "existing launcher");
	await writeFile(path.join(root, "AppRun.cap-original"), "unrelated file");
	await assert.rejects(
		preserveAppImageWorkingDirectory(root),
		/different AppRun wrapper/,
	);
	assert.equal(
		await readFile(path.join(root, "AppRun"), "utf8"),
		"existing launcher",
	);
	assert.equal(
		await readFile(path.join(root, "AppRun.cap-original"), "utf8"),
		"unrelated file",
	);
});

test("AppRun still launches the GUI after the caller directory is removed", async (t) => {
	const { root } = await fixture(t);
	const appDir = path.join(root, "AppDir");
	const caller = path.join(root, "removed-caller");
	await mkdir(appDir);
	await mkdir(caller);
	const launcher = path.join(appDir, "AppRun");
	await writeFile(
		launcher,
		`#!/bin/sh
printf 'GUI launched:%s' "\${OWD-unset}"
exit 23
`,
		{ mode: 0o755 },
	);
	await preserveAppImageWorkingDirectory(appDir);
	const result = spawnSync(
		"/bin/sh",
		["-c", `cd "$1" && rmdir "$1" && exec "$2"`, "sh", caller, launcher],
		{ env: { ...process.env, OWD: "/stale/caller" } },
	);
	assert.equal(result.status, 23, result.stderr.toString());
	assert.match(result.stdout.toString(), /^GUI launched:/);
	assert.ok(!result.stdout.toString().includes("/stale/caller"));
});
