import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

async function newestMtimeMs(targetPath) {
	let newest = 0;
	const pending = [targetPath];
	while (pending.length > 0) {
		const current = pending.pop();
		const stat = await fs.stat(current).catch(() => null);
		if (!stat) continue;
		if (stat.isFile()) {
			newest = Math.max(newest, stat.mtimeMs);
			continue;
		}
		if (stat.isDirectory()) {
			const entries = await fs.readdir(current);
			for (const name of entries) pending.push(path.join(current, name));
		}
	}
	return newest;
}

async function sha256(filePath) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest("hex");
}

export async function releaseBinaryMatchesDebugBinary(
	releaseBinary,
	debugBinaries,
) {
	const releaseStat = await fs.stat(releaseBinary).catch(() => null);
	if (!releaseStat?.isFile()) return false;

	let releaseHash;
	for (const debugBinary of debugBinaries) {
		const debugStat = await fs.stat(debugBinary).catch(() => null);
		if (!debugStat?.isFile() || debugStat.size !== releaseStat.size) continue;
		releaseHash ??= await sha256(releaseBinary);
		if ((await sha256(debugBinary)) === releaseHash) return true;
	}
	return false;
}

export async function stagedBinariesAreCurrent(
	releaseBinary,
	stagedBinaries,
	watchPaths,
	debugBinaries = [],
) {
	const releaseStat = await fs.stat(releaseBinary).catch(() => null);
	if (!releaseStat?.isFile()) return false;
	if (await releaseBinaryMatchesDebugBinary(releaseBinary, debugBinaries))
		return false;

	const newestSource = Math.max(
		0,
		...(await Promise.all(watchPaths.map(newestMtimeMs))),
	);
	if (newestSource > releaseStat.mtimeMs) return false;

	const releaseHash = await sha256(releaseBinary);
	const stagedMatches = await Promise.all(
		stagedBinaries.map(async (stagedBinary) => {
			const stat = await fs.stat(stagedBinary).catch(() => null);
			if (
				!stat?.isFile() ||
				stat.mtimeMs < newestSource ||
				stat.size !== releaseStat.size
			)
				return false;
			return (await sha256(stagedBinary)) === releaseHash;
		}),
	);
	return stagedMatches.every(Boolean);
}
