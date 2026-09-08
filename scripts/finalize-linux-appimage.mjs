import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
	access,
	chmod,
	copyFile,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopDirectory = fileURLToPath(
	new URL("../apps/desktop/", import.meta.url),
);

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

export async function finalizeLinuxAppImage(
	filename,
	{
		unsigned = false,
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
		if (!unsigned) {
			await run("pnpm", ["tauri", "signer", "sign", output], {
				cwd: desktopDirectory,
				env: {
					...env,
					TAURI_PRIVATE_KEY: env.TAURI_SIGNING_PRIVATE_KEY,
					TAURI_PRIVATE_KEY_PASSWORD:
						env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
				},
			});
			if (!(await stat(`${output}.sig`)).size) {
				throw new Error("Final AppImage updater signature is empty");
			}
		}
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
	const args = process.argv.slice(2);
	const unsigned = args[0] === "--unsigned";
	if (unsigned) args.shift();
	if (process.platform !== "linux" || args.length !== 1) {
		throw new Error(
			"Run on Linux: node scripts/finalize-linux-appimage.mjs [--unsigned] <Cap.AppImage>",
		);
	}
	const excluded = await finalizeLinuxAppImage(args[0], { unsigned });
	console.log(
		`Finalized ${args[0]}; excluded ${excluded.join(", ") || "none"}`,
	);
}
