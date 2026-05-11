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
	const target = process.argv[2] || detectHostTriple();
	const ext = target.includes("windows") ? ".exe" : "";
	const src = path.join(
		repoRoot,
		"target",
		target,
		"release",
		`cap-muxer${ext}`,
	);
	const dest = path.join(binariesDir, `cap-muxer-${target}${ext}`);
	const watchPaths = [
		path.join(repoRoot, "crates", "cap-muxer"),
		path.join(repoRoot, "crates", "cap-muxer-protocol"),
		path.join(repoRoot, "Cargo.lock"),
	];

	if (await isUpToDate(dest, watchPaths)) {
		console.log(`cap-muxer sidecar up to date: ${dest}`);
		return;
	}

	console.log(`Building cap-muxer sidecar for ${target}...`);
	const cargo = spawnSync(
		"cargo",
		["build", "--release", "-p", "cap-muxer", "--target", target],
		{ stdio: "inherit", cwd: repoRoot },
	);
	if (cargo.status !== 0) {
		process.exit(cargo.status ?? 1);
	}

	if (!(await fileExists(src))) {
		console.error(`error: built binary not found at ${src}`);
		process.exit(1);
	}

	await fs.mkdir(binariesDir, { recursive: true });
	await fs.copyFile(src, dest);
	console.log(`Copied ${src} -> ${dest}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
