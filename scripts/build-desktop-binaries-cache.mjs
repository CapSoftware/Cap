import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

async function sourceState(targetPath) {
	let newest = 0;
	const entries = [];
	const pending = [targetPath];
	while (pending.length > 0) {
		const current = pending.pop();
		const stat = await fs.stat(current).catch(() => null);
		entries.push([current, stat?.mtimeMs, stat?.size]);
		if (!stat) continue;
		newest = Math.max(newest, stat.mtimeMs);
		if (stat.isDirectory()) {
			const names = await fs.readdir(current);
			for (const name of names.sort().reverse())
				pending.push(path.join(current, name));
		}
	}
	return { newest, entries };
}

export async function sidecarSourceSnapshot(watchPaths) {
	const states = await Promise.all(watchPaths.map(sourceState));
	return {
		newest: Math.max(0, ...states.map((state) => state.newest)),
		fingerprint: createHash("sha256")
			.update(JSON.stringify(states.map((state) => state.entries)))
			.digest("hex"),
	};
}

export async function recordSidecarBuild(releaseBinary, snapshot) {
	await fs.writeFile(
		`${releaseBinary}.sidecar-cache.json`,
		JSON.stringify({
			sourceFingerprint: snapshot.fingerprint,
			releaseHash: await sha256(releaseBinary),
		}),
	);
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

	const snapshot = await sidecarSourceSnapshot(watchPaths);
	const releaseHash = await sha256(releaseBinary);
	const record = await fs
		.readFile(`${releaseBinary}.sidecar-cache.json`, "utf8")
		.then((text) => JSON.parse(text))
		.catch(() => null);
	const checkedSnapshot =
		record?.sourceFingerprint === snapshot.fingerprint &&
		record?.releaseHash === releaseHash;
	if (record ? !checkedSnapshot : snapshot.newest > releaseStat.mtimeMs)
		return false;
	const stagedMatches = await Promise.all(
		stagedBinaries.map(async (stagedBinary) => {
			const stat = await fs.stat(stagedBinary).catch(() => null);
			if (
				!stat?.isFile() ||
				(!checkedSnapshot && stat.mtimeMs < snapshot.newest) ||
				stat.size !== releaseStat.size
			)
				return false;
			return (await sha256(stagedBinary)) === releaseHash;
		}),
	);
	return stagedMatches.every(Boolean);
}
