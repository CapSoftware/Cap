import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	finalizeLinuxAppImage,
	findConflictingLibraries,
	preserveAppImageWorkingDirectory,
	relativizeDirIcon,
	removeWebviewRuntime,
	selectAppImageGtkBackend,
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

const upstreamGtkHook =
	"export GDK_BACKEND=x11 # Crash with Wayland backend on Wayland - We tested it without it and ended up with this: https://github.com/tauri-apps/tauri/issues/8541\n";

async function gtkHook(appDir, source = upstreamGtkHook) {
	const hook = path.join(appDir, "apprun-hooks/linuxdeploy-plugin-gtk.sh");
	await mkdir(path.dirname(hook), { recursive: true });
	await writeFile(hook, source, { mode: 0o755 });
	return hook;
}

test("GTK hook backend selection follows the capture environment and preserves explicit overrides", async (t) => {
	const { root } = await fixture(t);
	const socketDirectory = await mkdtemp(path.join(tmpdir(), "cap-wl-"));
	t.after(() => rm(socketDirectory, { recursive: true, force: true }));
	const socket = path.join(socketDirectory, "wl socket");
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socket, resolve);
	});
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const hook = await gtkHook(root);
	await selectAppImageGtkBackend(root);
	const patched = await readFile(hook, "utf8");
	await selectAppImageGtkBackend(root);
	assert.equal(await readFile(hook, "utf8"), patched);
	assert.equal((await stat(hook)).mode & 0o777, 0o755);
	const inherited = { ...process.env };
	for (const key of [
		"GDK_BACKEND",
		"WAYLAND_DISPLAY",
		"DISPLAY",
		"XDG_SESSION_TYPE",
		"XDG_RUNTIME_DIR",
	])
		delete inherited[key];
	const wayland = {
		WAYLAND_DISPLAY: "wl socket",
		XDG_RUNTIME_DIR: socketDirectory,
	};
	const cases = [
		[
			"normal Wayland",
			{ ...wayland, DISPLAY: ":0", XDG_SESSION_TYPE: "wayland" },
			"wayland",
		],
		[
			"case insensitive session",
			{ ...wayland, DISPLAY: ":0", XDG_SESSION_TYPE: "WaYlAnD" },
			"wayland",
		],
		["pure Wayland without session", wayland, "wayland"],
		["absolute Wayland socket", { WAYLAND_DISPLAY: socket }, "wayland"],
		["X11", { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" }, "x11"],
		["mixed without session", { ...wayland, DISPLAY: ":0" }, "x11"],
		[
			"mixed explicit X11",
			{ ...wayland, DISPLAY: ":0", XDG_SESSION_TYPE: "x11" },
			"x11",
		],
		[
			"stale socket in X11",
			{ WAYLAND_DISPLAY: "gone", DISPLAY: ":0", XDG_SESSION_TYPE: "x11" },
			"x11",
		],
		["absent Wayland variable", { XDG_SESSION_TYPE: "wayland" }, "x11"],
		["empty DISPLAY remains present", { ...wayland, DISPLAY: "" }, "x11"],
		["empty Wayland with X11", { WAYLAND_DISPLAY: "", DISPLAY: ":0" }, "x11"],
		["explicit X11 override", { ...wayland, GDK_BACKEND: "x11" }, "x11"],
		[
			"explicit ordered override",
			{ GDK_BACKEND: "wayland,x11" },
			"wayland,x11",
		],
		[
			"empty override selects backend",
			{ ...wayland, GDK_BACKEND: "" },
			"wayland",
		],
	];
	for (const [name, environment, expected] of cases) {
		const result = spawnSync(
			"/bin/sh",
			["-c", '. "$1"; printf "%s" "$GDK_BACKEND"', "cap-hook-test", hook],
			{ env: { ...inherited, ...environment }, encoding: "utf8" },
		);
		assert.equal(result.status, 0, `${name}: ${result.stderr}`);
		assert.equal(result.stdout, expected, name);
	}
	await writeFile(path.join(socketDirectory, "regular-file"), "not a socket");
	for (const [name, environment] of [
		["empty advertised display", { WAYLAND_DISPLAY: "" }],
		["relative display without runtime", { WAYLAND_DISPLAY: "wl socket" }],
		[
			"relative runtime",
			{ WAYLAND_DISPLAY: "wl socket", XDG_RUNTIME_DIR: "." },
		],
		["missing socket", { ...wayland, WAYLAND_DISPLAY: "gone" }],
		["regular file", { ...wayland, WAYLAND_DISPLAY: "regular-file" }],
		[
			"mixed Wayland missing socket",
			{
				...wayland,
				WAYLAND_DISPLAY: "gone",
				DISPLAY: ":0",
				XDG_SESSION_TYPE: "wayland",
			},
		],
	]) {
		const result = spawnSync(
			"/bin/sh",
			["-c", '. "$1"; printf "unreachable"', "cap-hook-test", hook],
			{ env: { ...inherited, ...environment }, encoding: "utf8" },
		);
		assert.equal(result.status, 1, name);
		assert.equal(result.stdout, "", name);
		assert.match(result.stderr, /advertised Wayland socket/, name);
	}
});

test("GTK hook rejects unknown or duplicated assignments without writing", async (t) => {
	const { root } = await fixture(t);
	for (const source of [
		"export GDK_BACKEND=wayland\n",
		"export GDK_BACKEND=x11\n",
		upstreamGtkHook + upstreamGtkHook,
		`${upstreamGtkHook}GDK_BACKEND=wayland\n`,
		"export GDK_BACKEND=x11\nexport GDK_BACKEND=x11\n",
		"export GDK_BACKEND=x11\nGDK_BACKEND=wayland\n",
		"export GDK_BACKEND=x11 # changed upstream\n",
		"printf unchanged\n",
	]) {
		const hook = await gtkHook(root, source);
		await assert.rejects(
			selectAppImageGtkBackend(root),
			/Unrecognized AppImage GTK backend hook/,
		);
		assert.equal(await readFile(hook, "utf8"), source);
	}
});

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
				await gtkHook(appDir);
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
				assert.equal(command, "bun");
				await writeFile(`${args[4]}.sig`, "new signature");
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
				await gtkHook(path.join(options.cwd, "squashfs-root"));
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
				assert.equal(command, "bun");
				assert.deepEqual(args.slice(0, 4), ["run", "tauri", "signer", "sign"]);
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
					.update(await readFile(args[4]))
					.digest("hex");
				await writeFile(`${args[4]}.sig`, hash);
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
		assert.deepEqual(calls, [image, image, "readelf", image, plugin, "bun"]);
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
					await gtkHook(appDir);
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

const linuxdeployLauncher = `#! /usr/bin/env bash

# autogenerated by linuxdeploy

# make sure errors in sourced scripts will cause this script to stop
set -e

this_dir="$(readlink -f "$(dirname "$0")")"

source "$this_dir"/apprun-hooks/"linuxdeploy-plugin-gtk.sh"

exec "$this_dir"/AppRun.wrapped "$@"
`;

const elf = (name) =>
	Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from(name)]);

const webviewFixtureFiles = {
	"usr/bin/Cap": ["libssl.so.3", "libavcodec.so.61", "libc.so.6"],
	"usr/bin/pactl": ["libpulse.so.0"],
	"usr/lib/cap/libavcodec.so.61": ["libva.so.2"],
	"usr/lib/libssl.so.3": ["libcrypto.so.3"],
	"usr/lib/libcrypto.so.3": [],
	"usr/lib/libavcodec.so.61": ["libva.so.2"],
	"usr/lib/libva.so.2.2100.0": [],
	"usr/lib/libpulse.so.0": [],
	"usr/lib/libwebkit2gtk-4.1.so.0": ["libgtk-3.so.0"],
	"usr/lib/libgtk-3.so.0": [],
	"usr/lib/im-xim.so": ["libgtk-3.so.0"],
	"usr/lib/gtk-3.0/3.0.0/immodules.cache": null,
	"usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache": null,
	"usr/lib/girepository-1.0/Gtk-3.0.typelib": null,
	"usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess": [
		"libwebkit2gtk-4.1.so.0",
	],
	"usr/lib/x86_64-linux-gnu/gio/modules/libgiognutls.so": ["libgtk-3.so.0"],
	"usr/share/glib-2.0/schemas/gschemas.compiled": null,
	"usr/lib/notes.txt": null,
	"usr/lib/Cap/assets/music/track.mp3": null,
	"AppRun.wrapped": ["libc.so.6"],
};

async function webviewAppDir(parent, name = "AppDir") {
	const appDir = path.join(parent, name);
	for (const [file, libraries] of Object.entries(webviewFixtureFiles)) {
		const filename = path.join(appDir, file);
		await mkdir(path.dirname(filename), { recursive: true });
		await writeFile(filename, libraries ? elf(file) : "data", {
			mode: 0o755,
		});
	}
	await symlink("libva.so.2.2100.0", path.join(appDir, "usr/lib/libva.so.2"));
	await symlink("libgtk-3.so.0", path.join(appDir, "usr/lib/libgtk-3.so"));
	await gtkHook(appDir);
	await writeFile(path.join(appDir, "AppRun"), linuxdeployLauncher, {
		mode: 0o755,
	});
	const readelf = [];
	const run = async (command, args, options) => {
		assert.equal(command, "readelf");
		assert.deepEqual(args.slice(0, 2), ["--wide", "--dynamic"]);
		assert.equal(options.env.LC_ALL, "C");
		const file = path.relative(appDir, args[2]);
		readelf.push(file);
		const libraries =
			webviewFixtureFiles[file === "AppRun" ? "AppRun.wrapped" : file];
		assert.ok(libraries, `unexpected readelf of ${file}`);
		return {
			stdout: libraries
				.map(
					(library) =>
						` 0x0000000000000001 (NEEDED)             Shared library: [${library}]`,
				)
				.join("\n"),
		};
	};
	return { appDir, run, readelf };
}

test("webview runtime removal keeps only libraries the shipped binaries load", async (t) => {
	const { root } = await fixture(t);
	const { appDir, run, readelf } = await webviewAppDir(root);
	const removed = await removeWebviewRuntime(appDir, { env: {}, run });
	assert.deepEqual(removed.map((file) => path.relative(appDir, file)).sort(), [
		"usr/lib/gdk-pixbuf-2.0",
		"usr/lib/girepository-1.0",
		"usr/lib/gtk-3.0",
		"usr/lib/im-xim.so",
		"usr/lib/libgtk-3.so",
		"usr/lib/libgtk-3.so.0",
		"usr/lib/libwebkit2gtk-4.1.so.0",
		"usr/lib/x86_64-linux-gnu/gio",
		"usr/lib/x86_64-linux-gnu/webkit2gtk-4.1",
		"usr/share/glib-2.0",
	]);
	assert.deepEqual((await readdir(path.join(appDir, "usr/lib"))).sort(), [
		"Cap",
		"cap",
		"libavcodec.so.61",
		"libcrypto.so.3",
		"libpulse.so.0",
		"libssl.so.3",
		"libva.so.2",
		"libva.so.2.2100.0",
		"notes.txt",
	]);
	assert.deepEqual((await readdir(appDir)).sort(), ["AppRun", "usr"]);
	assert.deepEqual(
		await readFile(path.join(appDir, "AppRun")),
		elf("AppRun.wrapped"),
	);
	assert.ok(!readelf.some((file) => file.includes("webkit2gtk-4.1/")));
	assert.ok(!readelf.includes("usr/lib/libgtk-3.so.0"));
});

for (const [name, launcher, hooks] of [
	[
		"an extra hook",
		linuxdeployLauncher.replace(
			"\nexec",
			'\nsource "$this_dir"/apprun-hooks/"other.sh"\n\nexec',
		),
		["other.sh"],
	],
	[
		"a different launcher target",
		linuxdeployLauncher.replace("AppRun.wrapped", "usr/bin/Cap"),
		[],
	],
]) {
	test(`webview runtime removal refuses ${name} without changing the AppDir`, async (t) => {
		const { root } = await fixture(t);
		const { appDir, run } = await webviewAppDir(root);
		await writeFile(path.join(appDir, "AppRun"), launcher);
		for (const hook of hooks) {
			await writeFile(path.join(appDir, "apprun-hooks", hook), "");
		}
		const before = (await readdir(path.join(appDir, "usr/lib"))).sort();
		await assert.rejects(
			removeWebviewRuntime(appDir, { env: {}, run }),
			/Unrecognized AppImage launcher/,
		);
		assert.deepEqual(
			(await readdir(path.join(appDir, "usr/lib"))).sort(),
			before,
		);
		assert.equal(await readFile(path.join(appDir, "AppRun"), "utf8"), launcher);
		await stat(path.join(appDir, "AppRun.wrapped"));
		await stat(path.join(appDir, "apprun-hooks/linuxdeploy-plugin-gtk.sh"));
	});
}

test(".DirIcon is rewritten to a relative link inside the AppDir", async (t) => {
	const { root } = await fixture(t);
	const appDir = path.join(root, "AppDir");
	await mkdir(appDir);
	await writeFile(path.join(appDir, "Cap.png"), "icon");
	await symlink("/build/Cap.AppDir/Cap.png", path.join(appDir, ".DirIcon"));
	await relativizeDirIcon(appDir);
	assert.equal(await readlink(path.join(appDir, ".DirIcon")), "Cap.png");
	await relativizeDirIcon(appDir);
	assert.equal(await readFile(path.join(appDir, ".DirIcon"), "utf8"), "icon");
});

test("webview-free finalization hands the pruned AppDir to the output plugin", async (t) => {
	const { image, plugin } = await fixture(t);
	let extracted;
	const run = async (command, args, options) => {
		if (command === image) {
			if (args[0] === "--appimage-signature") return { stdout: "" };
			if (args[0] === "--appimage-offset") {
				return { stdout: `${runtimeSize}` };
			}
			extracted = await webviewAppDir(options.cwd, "squashfs-root");
			return {};
		}
		if (command === "readelf" && args[1] === "--section-headers") {
			return { stdout: digestSectionHeaders };
		}
		if (command === "readelf") return extracted.run(command, args, options);
		assert.equal(command, plugin);
		const appDir = args[2];
		assert.deepEqual((await readdir(appDir)).sort(), [
			"AppRun",
			"AppRun.cap-original",
			"usr",
		]);
		assert.deepEqual(
			await readFile(path.join(appDir, "AppRun.cap-original")),
			elf("AppRun.wrapped"),
		);
		await assert.rejects(
			stat(path.join(appDir, "usr/lib/libwebkit2gtk-4.1.so.0")),
		);
		await stat(path.join(appDir, "usr/lib/libssl.so.3"));
		await writeFile(options.env.OUTPUT, finalImage());
		return {};
	};
	const excluded = await finalizeLinuxAppImage(image, {
		outputPlugin: plugin,
		unsigned: true,
		webview: false,
		env: {},
		run,
	});
	assert.ok(excluded.includes("usr/lib/libwebkit2gtk-4.1.so.0"));
	assert.ok(excluded.includes("usr/share/glib-2.0"));
	assert.deepEqual(await readFile(image), finalImage());
});
