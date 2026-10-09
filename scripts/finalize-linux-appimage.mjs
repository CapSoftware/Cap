import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
	access,
	chmod,
	copyFile,
	lstat,
	mkdtemp,
	open,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	rmdir,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopDirectory = fileURLToPath(
	new URL("../apps/desktop/", import.meta.url),
);

const upstreamGtkBackendAssignment =
	"export GDK_BACKEND=x11 # Crash with Wayland backend on Wayland - We tested it without it and ended up with this: https://github.com/tauri-apps/tauri/issues/8541";

// The upstream X11 workaround otherwise conflicts with Cap's Wayland recording fence.
const gtkBackendSelection = `if [ -z "\${GDK_BACKEND:-}" ]; then
	cap_uses_wayland=0
	if [ "\${WAYLAND_DISPLAY+x}" = x ]; then
		if [ "\${DISPLAY+x}" != x ]; then
			cap_uses_wayland=1
		else
			case "\${XDG_SESSION_TYPE:-}" in
				[wW][aA][yY][lL][aA][nN][dD]) cap_uses_wayland=1 ;;
			esac
		fi
	fi
	if [ "$cap_uses_wayland" = 1 ]; then
		case "\${WAYLAND_DISPLAY:-}" in
			/*) cap_wayland_socket="$WAYLAND_DISPLAY" ;;
			?*)
				case "\${XDG_RUNTIME_DIR:-}" in
					/*) cap_wayland_socket="$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ;;
					*) cap_wayland_socket= ;;
				esac
				;;
			*) cap_wayland_socket= ;;
		esac
		if [ -z "$cap_wayland_socket" ] || [ ! -S "$cap_wayland_socket" ]; then
			printf '%s\\n' 'Cap cannot connect to the advertised Wayland socket. Start Cap from the active desktop session or correct WAYLAND_DISPLAY and XDG_RUNTIME_DIR.' >&2
			exit 1
		fi
		export GDK_BACKEND=wayland
	else
		export GDK_BACKEND=x11
	fi
	unset cap_uses_wayland cap_wayland_socket
fi`;

export async function selectAppImageGtkBackend(appDir) {
	const hook = path.join(appDir, "apprun-hooks/linuxdeploy-plugin-gtk.sh");
	const source = await readFile(hook, "utf8");
	const restored = source.replace(
		gtkBackendSelection,
		upstreamGtkBackendAssignment,
	);
	const assignments = restored.match(/^.*\bGDK_BACKEND\s*=.*$/gm) ?? [];
	if (
		assignments.length !== 1 ||
		assignments[0] !== upstreamGtkBackendAssignment ||
		restored.includes(gtkBackendSelection)
	) {
		throw new Error(
			"Unrecognized AppImage GTK backend hook; refusing to replace it",
		);
	}
	if (source !== restored) return;
	await writeFile(
		hook,
		source.replace(upstreamGtkBackendAssignment, gtkBackendSelection),
	);
}

// The sentinel preserves directory names ending in newlines through shell substitution.
const appRunWrapper = `#!/bin/sh
unset OWD
if cap_original_directory="$(pwd -P && printf '.')"; then
	OWD="\${cap_original_directory%?}"
	OWD="\${OWD%?}"
	export OWD
fi
case "$0" in
	*/*) cap_appdir="\${0%/*}" ;;
	*) cap_appdir=. ;;
esac
exec "$cap_appdir/AppRun.cap-original" "$@"
`;

export async function preserveAppImageWorkingDirectory(appDir) {
	const launcher = path.join(appDir, "AppRun");
	const original = path.join(appDir, "AppRun.cap-original");
	if ((await readdir(appDir)).includes(path.basename(original))) {
		if ((await readFile(launcher, "utf8")) !== appRunWrapper) {
			throw new Error("AppImage already contains a different AppRun wrapper");
		}
		await access(original, constants.X_OK);
		return;
	}
	await access(launcher, constants.X_OK);
	await rename(launcher, original);
	await writeFile(launcher, appRunWrapper, { mode: 0o755, flag: "wx" });
}

export function runCommand(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} failed with ${result.signal ?? result.status}`);
	}
	return result;
}

async function hashPrefix(filename, size, digestMd5Offset) {
	const digestMd5End = digestMd5Offset + 16;
	const hash = createHash("sha256");
	let position = 0;
	for await (const chunk of createReadStream(filename, { end: size - 1 })) {
		if (
			digestMd5Offset >= position + chunk.length ||
			digestMd5End <= position
		) {
			hash.update(chunk);
		} else {
			const start = Math.max(digestMd5Offset - position, 0);
			const end = Math.min(digestMd5End - position, chunk.length);
			if (start > 0) hash.update(chunk.subarray(0, start));
			hash.update(Buffer.alloc(end - start));
			if (end < chunk.length) hash.update(chunk.subarray(end));
		}
		position += chunk.length;
	}
	return hash.digest("hex");
}

function parseElfHex(value) {
	if (!/^(?:0x)?[0-9a-f]+$/i.test(value)) return Number.NaN;
	const parsed = Number.parseInt(value, 16);
	return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

async function readDigestMd5Section(runtime, env, run) {
	const result = await run(
		"readelf",
		["--wide", "--section-headers", runtime],
		{
			env: { ...env, LC_ALL: "C" },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
		},
	);
	const sections =
		typeof result.stdout === "string"
			? result.stdout.split(/\r?\n/).flatMap((line) => {
					const match =
						/^\s*\[\s*\d+\]\s+(\S+)\s+\S+\s+\S+\s+(\S+)\s+(\S+)/.exec(line);
					return match?.[1] === ".digest_md5"
						? [{ offset: parseElfHex(match[2]), length: parseElfHex(match[3]) }]
						: [];
				})
			: [];
	if (sections.length !== 1) {
		throw new Error("Could not locate a single .digest_md5 section");
	}
	return sections[0];
}

async function copyRuntime(image, directory, env, run) {
	const options = {
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	};
	const signature = (await run(image, ["--appimage-signature"], options))
		.stdout;
	if (typeof signature !== "string" || signature.trim()) {
		throw new Error("Expected an AppImage without an embedded GPG signature");
	}
	const offset = (await run(image, ["--appimage-offset"], options)).stdout;
	const size = typeof offset === "string" ? Number(offset.trim()) : Number.NaN;
	if (
		typeof offset !== "string" ||
		!/^\d+$/.test(offset.trim()) ||
		!Number.isSafeInteger(size) ||
		size <= 0 ||
		size >= (await stat(image)).size
	) {
		throw new Error("Invalid AppImage runtime offset");
	}
	const filename = path.join(directory, "runtime");
	await pipeline(
		createReadStream(image, { end: size - 1 }),
		createWriteStream(filename, { mode: 0o755, flags: "wx" }),
	);
	const runtime = await stat(filename);
	if (!runtime.isFile() || runtime.size !== size) {
		throw new Error("AppImage runtime copy is incomplete");
	}
	await access(filename, constants.X_OK);
	const digestMd5 = await readDigestMd5Section(filename, env, run);
	if (
		!Number.isSafeInteger(digestMd5.offset) ||
		digestMd5.offset <= 0 ||
		!Number.isSafeInteger(digestMd5.length) ||
		digestMd5.length < 16 ||
		digestMd5.offset + digestMd5.length > size
	) {
		throw new Error("Invalid .digest_md5 section in AppImage runtime");
	}
	return {
		filename,
		size,
		digestMd5,
		hash: await hashPrefix(filename, size, digestMd5.offset),
	};
}

export async function findConflictingLibraries(appDir, directory = appDir) {
	const libraries = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const filename = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			libraries.push(...(await findConflictingLibraries(appDir, filename)));
		} else if (
			/^libwayland-client\.so(?:\..+)?$/.test(entry.name) ||
			(directory === path.join(appDir, "usr/lib") &&
				/^libpipewire-0\.3\.so(?:\..+)?$/.test(entry.name))
		) {
			libraries.push(filename);
		}
	}
	return libraries;
}

const elfMagic = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

async function isElf(filename) {
	const handle = await open(filename, "r");
	try {
		const { buffer, bytesRead } = await handle.read(Buffer.alloc(4), 0, 4, 0);
		return bytesRead === 4 && buffer.equals(elfMagic);
	} finally {
		await handle.close();
	}
}

async function neededLibraries(filename, env, run) {
	const result = await run("readelf", ["--wide", "--dynamic", filename], {
		env: { ...env, LC_ALL: "C" },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
	if (typeof result.stdout !== "string") {
		throw new Error(`Could not read the dynamic section of ${filename}`);
	}
	return [
		...result.stdout.matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g),
	].map((match) => match[1]);
}

async function elfFiles(directory, libraryDirectory) {
	const files = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const filename = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await elfFiles(filename, libraryDirectory)));
		} else if (
			entry.isFile() &&
			directory !== libraryDirectory &&
			(await isElf(filename))
		) {
			files.push(filename);
		}
	}
	return files;
}

const gtkLauncherSource =
	/^\s*source\s+"\$this_dir"\/apprun-hooks\/"linuxdeploy-plugin-gtk\.sh"\s*$/;
const gtkLauncherExec = /^\s*exec\s+"\$this_dir"\/AppRun\.wrapped\s+"\$@"\s*$/;

async function removeGtkLauncher(appDir) {
	const hooks = path.join(appDir, "apprun-hooks");
	const launcher = path.join(appDir, "AppRun");
	const wrapped = path.join(appDir, "AppRun.wrapped");
	const commands = (await readFile(launcher, "utf8"))
		.split("\n")
		.filter((line) => line.trim() && !line.trimStart().startsWith("#"));
	const sources = commands.filter((line) => /^\s*source\b/.test(line));
	if (
		(await readdir(hooks)).join() !== "linuxdeploy-plugin-gtk.sh" ||
		sources.length !== 1 ||
		!gtkLauncherSource.test(sources[0]) ||
		!gtkLauncherExec.test(commands.at(-1) ?? "")
	) {
		throw new Error(
			"Unrecognized AppImage launcher; refusing to remove the GTK runtime",
		);
	}
	await access(wrapped, constants.X_OK);
	await rm(hooks, { recursive: true });
	await rename(wrapped, launcher);
}

async function webviewRuntimeDirectories(appDir) {
	const libraryDirectory = path.join(appDir, "usr/lib");
	const multiarch = (await readdir(libraryDirectory, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && /-linux-gnu/.test(entry.name))
		.map((entry) => path.join(libraryDirectory, entry.name));
	return {
		multiarch,
		directories: [
			"usr/lib/gtk-3.0",
			"usr/lib/gdk-pixbuf-2.0",
			"usr/lib/girepository-1.0",
			"usr/lib/webkit2gtk-4.1",
			"usr/lib64/webkit2gtk-4.1",
			"usr/libexec/webkit2gtk-4.1",
			"usr/share/glib-2.0",
		]
			.map((directory) => path.join(appDir, directory))
			.concat(
				multiarch.flatMap((directory) => [
					path.join(directory, "webkit2gtk-4.1"),
					path.join(directory, "gio"),
				]),
			),
	};
}

export async function removeWebviewRuntime(
	appDir,
	{ env = process.env, run = runCommand } = {},
) {
	await removeGtkLauncher(appDir);
	const removed = [];
	const { directories, multiarch } = await webviewRuntimeDirectories(appDir);
	for (const directory of directories) {
		const entry = await lstat(directory).catch(() => null);
		if (!entry) continue;
		await rm(directory, { recursive: true });
		removed.push(directory);
	}
	for (const directory of multiarch) {
		if ((await readdir(directory)).length === 0) await rmdir(directory);
	}

	const libraryDirectory = path.join(appDir, "usr/lib");
	const libraryRoot = await realpath(libraryDirectory);
	const candidates = new Set(
		(await readdir(libraryDirectory, { withFileTypes: true }))
			.filter(
				(entry) =>
					(entry.isFile() || entry.isSymbolicLink()) &&
					/\.so(?:\.|$)/.test(entry.name),
			)
			.map((entry) => entry.name),
	);
	const pending = [];
	for (const file of await elfFiles(appDir, libraryDirectory)) {
		pending.push(...(await neededLibraries(file, env, run)));
	}
	const kept = new Set();
	while (pending.length > 0) {
		const name = pending.pop();
		if (kept.has(name) || !candidates.has(name)) continue;
		kept.add(name);
		const filename = path.join(libraryDirectory, name);
		if ((await lstat(filename)).isSymbolicLink()) {
			const target = await realpath(filename).catch(() => null);
			if (target && path.dirname(target) === libraryRoot) {
				pending.push(path.basename(target));
			}
		} else if (await isElf(filename)) {
			pending.push(...(await neededLibraries(filename, env, run)));
		}
	}
	for (const name of candidates) {
		if (kept.has(name)) continue;
		const filename = path.join(libraryDirectory, name);
		await rm(filename);
		removed.push(filename);
	}
	return removed;
}

export async function relativizeDirIcon(appDir) {
	const icon = path.join(appDir, ".DirIcon");
	const target = await readlink(icon).catch(() => null);
	if (!target || !path.isAbsolute(target)) return;
	const name = path.basename(target);
	await access(path.join(appDir, name));
	await rm(icon);
	await symlink(name, icon);
}

export async function signUpdaterArtifact(
	filename,
	{ env = process.env, run = runCommand } = {},
) {
	await run("bun", ["run", "tauri", "signer", "sign", filename], {
		cwd: desktopDirectory,
		env: {
			...env,
			TAURI_PRIVATE_KEY: env.TAURI_SIGNING_PRIVATE_KEY,
			TAURI_PRIVATE_KEY_PASSWORD: env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
		},
	});
	if (!(await stat(`${filename}.sig`)).size) {
		throw new Error(`Updater signature for ${filename} is empty`);
	}
}

export async function finalizeLinuxAppImage(
	filename,
	{
		unsigned = false,
		webview = true,
		env = process.env,
		run = runCommand,
		replace = rename,
		outputPlugin = path.join(
			env.XDG_CACHE_HOME || path.join(homedir(), ".cache"),
			"tauri/linuxdeploy-plugin-appimage.AppImage",
		),
	} = {},
) {
	const image = path.resolve(filename);
	if (!image.endsWith(".AppImage")) {
		throw new Error("Expected an .AppImage artifact");
	}
	if (!unsigned && !env.TAURI_SIGNING_PRIVATE_KEY) {
		throw new Error(
			"TAURI_SIGNING_PRIVATE_KEY is required to sign the final AppImage",
		);
	}
	if (env.LDAI_SIGN !== undefined || env.SIGN !== undefined) {
		throw new Error(
			"Embedded GPG signing is unsupported; use the Tauri signer",
		);
	}
	await access(outputPlugin, constants.X_OK);
	await access(image, constants.X_OK);
	const work = await mkdtemp(path.join(path.dirname(image), ".cap-appimage-"));
	let retainWork = false;
	try {
		const runtime = await copyRuntime(image, work, env, run);
		await run(image, ["--appimage-extract"], {
			cwd: work,
			env,
			stdio: ["ignore", "ignore", "inherit"],
		});
		const appDir = path.join(work, "squashfs-root");
		const excluded = await findConflictingLibraries(appDir);
		// Host Mesa and ALSA plugins require their matching Wayland and PipeWire ABIs.
		for (const library of excluded) await rm(library);
		if (webview) {
			await selectAppImageGtkBackend(appDir);
		} else {
			excluded.push(...(await removeWebviewRuntime(appDir, { env, run })));
		}
		await relativizeDirIcon(appDir);
		await preserveAppImageWorkingDirectory(appDir);
		const output = path.join(work, path.basename(image));
		await run(
			outputPlugin,
			["--appimage-extract-and-run", "--appdir", appDir],
			{
				env: {
					...env,
					APPIMAGE_EXTRACT_AND_RUN: "1",
					OUTPUT: output,
					LDAI_OUTPUT: output,
					LDAI_RUNTIME_FILE: runtime.filename,
				},
			},
		);
		if (
			(await stat(output)).size <= runtime.size ||
			(await hashPrefix(output, runtime.size, runtime.digestMd5.offset)) !==
				runtime.hash
		) {
			throw new Error("Final AppImage did not preserve its runtime");
		}
		await chmod(output, 0o755);
		if (!unsigned) await signUpdaterArtifact(output, { env, run });
		const originalImage = path.join(work, "original-image");
		const originalImageStat = await stat(image);
		await copyFile(image, originalImage, constants.COPYFILE_FICLONE);
		await chmod(originalImage, originalImageStat.mode & 0o7777);
		let imageReplaced = false;
		try {
			await replace(output, image);
			imageReplaced = true;
			if (!unsigned) await replace(`${output}.sig`, `${image}.sig`);
			else await rm(`${image}.sig`, { force: true });
		} catch (error) {
			if (!imageReplaced) throw error;
			try {
				await rename(originalImage, image);
			} catch (rollbackError) {
				retainWork = true;
				throw new Error(
					`${error instanceof Error ? error.message : error}; ${rollbackError instanceof Error ? rollbackError.message : rollbackError}. Recovery backup retained at ${work}`,
					{ cause: rollbackError },
				);
			}
			throw error;
		}
		return excluded.map((library) => path.relative(appDir, library));
	} finally {
		if (!retainWork) await rm(work, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const flags = new Set(["--unsigned", "--without-webview"]);
	const args = process.argv.slice(2);
	const files = args.filter((arg) => !flags.has(arg));
	if (process.platform !== "linux" || files.length !== 1) {
		throw new Error(
			"Run on Linux: node scripts/finalize-linux-appimage.mjs [--unsigned] [--without-webview] <Cap.AppImage>",
		);
	}
	const excluded = await finalizeLinuxAppImage(files[0], {
		unsigned: args.includes("--unsigned"),
		webview: !args.includes("--without-webview"),
	});
	console.log(
		`Finalized ${files[0]}; excluded ${excluded.join(", ") || "none"}`,
	);
}
