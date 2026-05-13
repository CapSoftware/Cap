// @ts-check

import { exec as execCb } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execCb);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const targetDir = path.join(__dirname, "../../../target");

async function main() {
	if (process.platform === "darwin") {
		const { binaryPath, releaseFile } = await findReleaseBinary();

		await exec(
			`dsymutil "${binaryPath}" -o "${path.join(targetDir, releaseFile)}.dSYM"`,
		);
	}
}

main();

async function findReleaseBinary() {
	const dirs = [
		path.join(targetDir, "release"),
		process.env.TAURI_ENV_TARGET_TRIPLE
			? path.join(targetDir, `${process.env.TAURI_ENV_TARGET_TRIPLE}/release`)
			: null,
	].filter(Boolean);

	for (let attempt = 0; attempt < 20; attempt++) {
		for (const releaseDir of dirs) {
			const releaseFile = await findReleaseFile(releaseDir);
			if (releaseFile)
				return { binaryPath: path.join(releaseDir, releaseFile), releaseFile };
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}

	throw new Error(`No binary found at ${dirs.join(", ")}`);
}

async function findReleaseFile(releaseDir) {
	if (!(await fileExists(releaseDir))) return null;
	const releaseFiles = await fs.readdir(releaseDir);
	for (const name of ["Cap", "cap-desktop"]) {
		if (releaseFiles.includes(name)) return name;
	}

	for (const releaseFile of releaseFiles) {
		if (releaseFile.startsWith("Cap")) return releaseFile;
	}

	return null;
}

async function fileExists(path) {
	return await fs
		.access(path)
		.then(() => true)
		.catch(() => false);
}
