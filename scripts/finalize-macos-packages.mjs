import { mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
	runCommand,
	signUpdaterArtifact,
	withoutUpdaterSecrets,
} from "./finalize-linux-appimage.mjs";

const captured = (env) => ({
	env: { ...env, LC_ALL: "C" },
	encoding: "utf8",
	stdio: ["ignore", "pipe", "inherit"],
});

async function tarDigest(archive, env, run) {
	const result = await run(
		"bash",
		[
			"-c",
			'set -euo pipefail; pigz -dc -- "$1" | shasum -a 256',
			"bash",
			archive,
		],
		captured(env),
	);
	const digest = /^([0-9a-f]{64})\b/.exec(result.stdout ?? "")?.[1];
	if (!digest) throw new Error(`Could not read ${archive}`);
	return digest;
}

export async function recompressUpdaterArchive(
	filename,
	{ unsigned = false, env = process.env, run = runCommand } = {},
) {
	const archive = path.resolve(filename);
	if (!archive.endsWith(".tar.gz")) {
		throw new Error("Expected a .tar.gz updater archive");
	}
	if (!unsigned && !env.TAURI_SIGNING_PRIVATE_KEY) {
		throw new Error(
			"TAURI_SIGNING_PRIVATE_KEY is required to sign the updater archive",
		);
	}
	const tools = withoutUpdaterSecrets(env);
	const work = await mkdtemp(path.join(path.dirname(archive), ".cap-update-"));
	try {
		const output = path.join(work, path.basename(archive));
		await run(
			"bash",
			[
				"-c",
				'set -euo pipefail; pigz -dc -- "$1" | pigz -11 -n -c > "$2"',
				"bash",
				archive,
				output,
			],
			{ env: tools },
		);
		if (
			(await tarDigest(archive, tools, run)) !==
			(await tarDigest(output, tools, run))
		) {
			throw new Error("The recompressed updater archive changed its contents");
		}
		const [before, after] = await Promise.all([stat(archive), stat(output)]);
		if (after.size >= before.size) {
			return { before: before.size, after: before.size };
		}
		if (!unsigned) await signUpdaterArtifact(output, { env, run });
		await rename(output, archive);
		if (unsigned) await rm(`${archive}.sig`, { force: true });
		else await rename(`${output}.sig`, `${archive}.sig`);
		return { before: before.size, after: after.size };
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

async function signDiskImage(dmg, env, run, delay) {
	const keychain = env.APPLE_KEYCHAIN ? ["--keychain", env.APPLE_KEYCHAIN] : [];
	for (let attempt = 0; ; attempt++) {
		try {
			await run(
				"codesign",
				[
					"--force",
					"--timestamp",
					"--sign",
					env.APPLE_SIGNING_IDENTITY,
					...keychain,
					dmg,
				],
				{ env },
			);
			await run("codesign", ["--verify", dmg], { env });
			return;
		} catch (error) {
			if (attempt === 2) throw error;
			await delay(15_000 * (attempt + 1));
		}
	}
}

export async function convertDiskImage(
	filename,
	{
		env = process.env,
		run = runCommand,
		delay = wait,
		warn = (message) => console.warn(message),
	} = {},
) {
	const dmg = path.resolve(filename);
	if (!dmg.endsWith(".dmg")) throw new Error("Expected a .dmg disk image");
	if (!env.APPLE_SIGNING_IDENTITY) {
		throw new Error(
			"APPLE_SIGNING_IDENTITY is required to sign the disk image",
		);
	}
	const tools = withoutUpdaterSecrets(env);
	const work = await mkdtemp(path.join(path.dirname(dmg), ".cap-dmg-"));
	try {
		const output = path.join(work, path.basename(dmg));
		try {
			await run("hdiutil", ["convert", dmg, "-format", "ULMO", "-o", output], {
				env: tools,
			});
			await run("hdiutil", ["verify", output], { env: tools });
			await signDiskImage(output, tools, run, delay);
		} catch (error) {
			warn(
				`::warning::Keeping the zlib disk image; LZMA conversion failed: ${error instanceof Error ? error.message : error}`,
			);
			return null;
		}
		const [before, after] = await Promise.all([stat(dmg), stat(output)]);
		if (after.size >= before.size) {
			return { before: before.size, after: before.size };
		}
		await rename(output, dmg);
		return { before: before.size, after: after.size };
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

async function single(directory, extension) {
	const files = (await readdir(directory)).filter((file) =>
		file.endsWith(extension),
	);
	if (files.length !== 1) {
		throw new Error(
			`Expected one ${extension} in ${directory}, found ${files.length}`,
		);
	}
	return path.join(directory, files[0]);
}

export async function finalizeMacosPackages(bundleRoot, options = {}) {
	const archive = await single(path.join(bundleRoot, "macos"), ".app.tar.gz");
	const dmg = await single(path.join(bundleRoot, "dmg"), ".dmg");
	return {
		archive: await recompressUpdaterArchive(archive, options),
		dmg: await convertDiskImage(dmg, options),
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const [bundleRoot] = process.argv.slice(2);
	if (process.platform !== "darwin" || !bundleRoot) {
		throw new Error(
			"Run on macOS: node scripts/finalize-macos-packages.mjs <bundle directory>",
		);
	}
	const { archive, dmg } = await finalizeMacosPackages(bundleRoot);
	console.log(
		`Updater archive ${archive.before} -> ${archive.after} bytes; disk image ${dmg ? `${dmg.before} -> ${dmg.after} bytes` : "unchanged"}`,
	);
}
