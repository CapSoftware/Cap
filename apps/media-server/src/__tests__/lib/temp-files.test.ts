import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import {
	cleanupMediaTransferCache,
	sweepMediaTransferCache,
} from "../../lib/media-transfer";
import {
	cleanupStaleTempFiles,
	createTempFile,
	ensureTempDir,
	getInstanceDir,
	getTempDir,
	getTempDirUsage,
	getTempRoot,
	removeOwnTempDir,
	retainTempPath,
	sweepOrphanedTempDirs,
} from "../../lib/temp-files";

const created: string[] = [];

afterEach(async () => {
	for (const path of created.splice(0)) {
		await rm(path, { recursive: true, force: true });
	}
});

async function makeTree(path: string, ageMs: number, lease = false) {
	created.push(path);
	await mkdir(join(path, "nested", "deeper"), { recursive: true });
	await writeFile(join(path, "nested", "deeper", "segment.m4s"), "segment");
	const past = new Date(Date.now() - ageMs);
	if (lease) {
		await writeFile(join(path, ".lease"), "");
		await utimes(join(path, ".lease"), past, past);
	}
	await utimes(path, past, past);
}

async function setAge(path: string, ageMs: number) {
	const past = new Date(Date.now() - ageMs);
	await utimes(path, past, past);
}

describe("startup temp sweep", () => {
	test("removes orphaned instance dirs and old legacy entries only", async () => {
		await ensureTempDir();
		const root = getTempRoot();
		const staleInstance = join(root, `instance-${randomUUID()}`);
		const liveInstance = join(root, `instance-${randomUUID()}`);
		const oldLegacyDir = join(root, `mux-job_${randomUUID()}`);
		const youngLegacyFile = join(root, `${randomUUID()}.mp4`);
		await makeTree(staleInstance, 10 * 60 * 1000, true);
		await makeTree(liveInstance, 10 * 60 * 1000);
		await writeFile(join(liveInstance, ".lease"), "");
		await makeTree(oldLegacyDir, 2 * 60 * 60 * 1000);
		created.push(youngLegacyFile);
		await writeFile(youngLegacyFile, "in use by an older server version");

		const removed = await sweepOrphanedTempDirs();

		expect(removed).toBeGreaterThanOrEqual(2);
		expect(existsSync(staleInstance)).toBe(false);
		expect(existsSync(oldLegacyDir)).toBe(false);
		expect(existsSync(liveInstance)).toBe(true);
		expect(existsSync(youngLegacyFile)).toBe(true);
		expect(existsSync(getTempDir())).toBe(true);
		expect(existsSync(join(getTempDir(), ".lease"))).toBe(true);
	});

	test("never treats the server's own instance dir as orphaned", async () => {
		await ensureTempDir();
		await setAge(join(getTempDir(), ".lease"), 24 * 60 * 60 * 1000);
		await setAge(getTempDir(), 24 * 60 * 60 * 1000);

		await sweepOrphanedTempDirs();

		expect(existsSync(getTempDir())).toBe(true);
	});
});

describe("stale temp cleanup", () => {
	test("removes stale directories recursively and keeps in-use entries", async () => {
		await ensureTempDir();
		const staleDir = join(getTempDir(), `stream-${randomUUID()}`);
		await makeTree(staleDir, 2 * 60 * 60 * 1000);
		const retainedDir = join(getTempDir(), `mux-job_${randomUUID()}`);
		await makeTree(retainedDir, 2 * 60 * 60 * 1000);
		const releaseRetainedDir = retainTempPath(retainedDir);
		const inUse = await createTempFile(".mp4");
		created.push(inUse.path);
		await writeFile(inUse.path, "input still read by ffmpeg");
		await setAge(inUse.path, 2 * 60 * 60 * 1000);
		const fresh = await createTempFile(".mp4");
		created.push(fresh.path);
		await writeFile(fresh.path, "fresh");

		try {
			expect(await cleanupStaleTempFiles()).toBeGreaterThanOrEqual(1);
			expect(existsSync(staleDir)).toBe(false);
			expect(existsSync(retainedDir)).toBe(true);
			expect(existsSync(inUse.path)).toBe(true);
			expect(existsSync(fresh.path)).toBe(true);

			releaseRetainedDir();
			await cleanupStaleTempFiles();
			expect(existsSync(retainedDir)).toBe(false);
		} finally {
			releaseRetainedDir();
			await inUse.cleanup();
			await fresh.cleanup();
		}
	});

	test("expires entries that were retained far beyond any job lifetime", async () => {
		await ensureTempDir();
		const leaked = await createTempFile(".mp4");
		created.push(leaked.path);
		await writeFile(leaked.path, "leaked handle");
		await setAge(leaked.path, 7 * 60 * 60 * 1000);

		await cleanupStaleTempFiles();

		expect(existsSync(leaked.path)).toBe(false);
	});

	test("reports temp usage including nested files", async () => {
		await ensureTempDir();
		const dir = join(getTempDir(), `usage-${randomUUID()}`);
		await makeTree(dir, 0);

		const usage = await getTempDirUsage();

		expect(usage.entries).toBeGreaterThanOrEqual(4);
		expect(usage.bytes).toBeGreaterThanOrEqual("segment".length);
		expect(usage.truncated).toBe(false);
	});

	test("removes the server's own dir on shutdown and recreates it on demand", async () => {
		const handle = await createTempFile(".mp4");
		await writeFile(handle.path, "shutdown");

		await removeOwnTempDir();
		expect(existsSync(getTempDir())).toBe(false);

		const next = await createTempFile(".mp4");
		expect(existsSync(join(getTempDir(), ".lease"))).toBe(true);
		await next.cleanup();
	});
});

describe("media transfer cache sweep", () => {
	test("removes orphaned instance and dead-pid cache dirs but keeps a live pid's cache however old", async () => {
		const base = join(tmpdir(), "cap-media-download-cache");
		const staleInstance = join(base, `instance-${randomUUID()}`);
		const liveInstance = join(base, `instance-${randomUUID()}`);
		const exited = spawn({ cmd: ["true"] });
		await exited.exited;
		const deadPidDir = join(base, String(exited.pid));
		const oldLivePidDir = join(base, String(process.ppid));
		await makeTree(staleInstance, 10 * 60 * 1000, true);
		await makeTree(liveInstance, 0, true);
		await makeTree(deadPidDir, 0);
		await makeTree(oldLivePidDir, 24 * 60 * 60 * 1000);

		await sweepMediaTransferCache();

		expect(existsSync(staleInstance)).toBe(false);
		expect(existsSync(deadPidDir)).toBe(false);
		expect(existsSync(liveInstance)).toBe(true);
		expect(existsSync(oldLivePidDir)).toBe(true);
		expect(existsSync(getInstanceDir(base))).toBe(false);
		await cleanupMediaTransferCache();
	});
});
