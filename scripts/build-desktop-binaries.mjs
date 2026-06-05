import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const binariesDir = path.join(
	repoRoot,
	"apps",
	"desktop",
	"src-tauri",
	"binaries",
);

function detectHostTriple() {
	const result = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
	if (result.status !== 0) {
		const reason =
			result.stderr || result.error?.message || `exit ${result.status}`;
		throw new Error(`rustc -vV failed: ${reason}`);
	}
	const match = result.stdout.match(/^host:\s*(.+)$/m);
	if (!match) throw new Error("Could not parse host triple from rustc -vV");
	return match[1].trim();
}

async function fileExists(p) {
	return await fs
		.access(p)
		.then(() => true)
		.catch(() => false);
}

async function newestMtimeMs(targetPath) {
	let max = 0;
	const stack = [targetPath];
	while (stack.length > 0) {
		const current = stack.pop();
		const stat = await fs.stat(current).catch(() => null);
		if (!stat) continue;
		if (stat.isFile()) {
			if (stat.mtimeMs > max) max = stat.mtimeMs;
			continue;
		}
		if (stat.isDirectory()) {
			const entries = await fs.readdir(current);
			for (const name of entries) stack.push(path.join(current, name));
		}
	}
	return max;
}

async function isUpToDate(destPath, sourcePaths) {
	if (!(await fileExists(destPath))) return false;
	const destStat = await fs.stat(destPath);
	for (const src of sourcePaths) {
		const newest = await newestMtimeMs(src);
		if (newest > destStat.mtimeMs) return false;
	}
	return true;
}

async function main() {
	const target =
		process.argv[2] || process.env.RUST_TARGET_TRIPLE || detectHostTriple();
	const ext = target.includes("windows") ? ".exe" : "";

	await fs.mkdir(binariesDir, { recursive: true });

	for (const sidecar of [
		{
			packageName: "cap-muxer",
			sourceBinary: "cap-muxer",
			destBinaries: ["cap-muxer"],
			watchPaths: [
				path.join(repoRoot, "crates", "cap-muxer"),
				path.join(repoRoot, "crates", "cap-muxer-protocol"),
				path.join(repoRoot, "Cargo.lock"),
			],
		},
		{
			packageName: "cap",
			sourceBinary: "cap",
			destBinaries: ["cap-cli", "cap-exporter"],
			watchPaths: [
				path.join(repoRoot, "apps", "cli"),
				path.join(repoRoot, "crates", "cli-install"),
				path.join(repoRoot, "crates", "editor"),
				path.join(repoRoot, "crates", "enc-ffmpeg"),
				path.join(repoRoot, "crates", "export"),
				path.join(repoRoot, "crates", "media"),
				path.join(repoRoot, "crates", "media-info"),
				path.join(repoRoot, "crates", "project"),
				path.join(repoRoot, "crates", "rendering"),
				path.join(repoRoot, "Cargo.lock"),
			],
		},
	]) {
		await buildSidecar(sidecar, target, ext);
	}
}

async function buildSidecar(sidecar, target, ext) {
	const src = path.join(
		repoRoot,
		"target",
		target,
		"release",
		`${sidecar.sourceBinary}${ext}`,
	);
	const dests = sidecar.destBinaries.map((destBinary) =>
		path.join(binariesDir, `${destBinary}-${target}${ext}`),
	);

	if (
		(
			await Promise.all(
				dests.map((dest) => isUpToDate(dest, sidecar.watchPaths)),
			)
		).every(Boolean)
	) {
		console.log(
			`${sidecar.destBinaries.join(", ")} desktop binaries up to date`,
		);
		return;
	}

	console.log(
		`Building ${sidecar.destBinaries.join(", ")} desktop binaries for ${target}...`,
	);
	const cargo = spawnSync(
		"cargo",
		["build", "--release", "-p", sidecar.packageName, "--target", target],
		{ stdio: "inherit", cwd: repoRoot },
	);
	if (cargo.status !== 0) {
		process.exit(cargo.status ?? 1);
	}

	if (!(await fileExists(src))) {
		console.error(`error: built binary not found at ${src}`);
		process.exit(1);
	}

	for (const dest of dests) {
		await fs.copyFile(src, dest);
		console.log(`Copied ${src} -> ${dest}`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
