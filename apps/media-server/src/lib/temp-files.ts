import { randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import {
	lstat,
	mkdir,
	readdir,
	rm,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEMP_ROOT = join(tmpdir(), "cap-media-server");
const INSTANCE_ID = randomUUID();
const INSTANCE_DIR_PREFIX = "instance-";
const INSTANCE_LEASE_FILE = ".lease";
const INSTANCE_LEASE_REFRESH_MS = 30_000;
const INSTANCE_LEASE_STALE_MS = 5 * 60 * 1000;
const STALE_FILE_AGE_MS = 60 * 60 * 1000;
const MAX_ACTIVE_TEMP_AGE_MS = 6 * 60 * 60 * 1000;
const TEMP_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;
const TEMP_USAGE_CACHE_MS = 5_000;
const TEMP_USAGE_MAX_ENTRIES = 20_000;

const leasedDirs = new Set<string>();
const activeTempPaths = new Set<string>();
let leaseTimer: ReturnType<typeof setInterval> | undefined;
let maintenanceTimer: ReturnType<typeof setInterval> | undefined;

export interface TempFileHandle {
	path: string;
	cleanup: () => Promise<void>;
}

export interface TempDirUsage {
	bytes: number;
	entries: number;
	truncated: boolean;
}

export function getInstanceDir(base: string): string {
	return join(base, `${INSTANCE_DIR_PREFIX}${INSTANCE_ID}`);
}

const TEMP_DIR = getInstanceDir(TEMP_ROOT);

async function refreshLeases(): Promise<void> {
	const now = new Date();
	await Promise.allSettled(
		Array.from(leasedDirs, async (dir) => {
			const lease = join(dir, INSTANCE_LEASE_FILE);
			try {
				await utimes(lease, now, now);
			} catch {
				await mkdir(dir, { recursive: true });
				await writeFile(lease, "");
			}
		}),
	);
}

export async function ensureInstanceDir(
	base: string,
	mode?: number,
): Promise<string> {
	const dir = getInstanceDir(base);
	await mkdir(dir, { recursive: true, mode });
	if (!leasedDirs.has(dir)) {
		await writeFile(join(dir, INSTANCE_LEASE_FILE), "");
		leasedDirs.add(dir);
		if (!leaseTimer) {
			leaseTimer = setInterval(() => {
				void refreshLeases();
			}, INSTANCE_LEASE_REFRESH_MS);
			leaseTimer.unref?.();
		}
	}
	return dir;
}

export async function releaseInstanceDir(base: string): Promise<void> {
	const dir = getInstanceDir(base);
	leasedDirs.delete(dir);
	await rm(dir, { recursive: true, force: true }).catch(() => {});
}

// Instance directories carry a lease so a host that shares one temp volume
// between an old (draining) and a new container never sweeps live work.
export async function sweepOrphanedInstanceDirs(
	base: string,
	isLegacyOrphan: (name: string, stats: Stats) => boolean,
): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await readdir(base, { withFileTypes: true });
	} catch {
		return 0;
	}
	const ownDir = getInstanceDir(base);
	const now = Date.now();
	let removed = 0;

	for (const entry of entries) {
		const path = join(base, entry.name);
		if (path === ownDir) continue;
		try {
			const orphaned =
				entry.isDirectory() && entry.name.startsWith(INSTANCE_DIR_PREFIX)
					? now -
							(
								await lstat(join(path, INSTANCE_LEASE_FILE)).catch(() =>
									lstat(path),
								)
							).mtimeMs >
						INSTANCE_LEASE_STALE_MS
					: isLegacyOrphan(entry.name, await lstat(path));
			if (!orphaned) continue;
			await rm(path, { recursive: true, force: true });
			removed++;
		} catch {}
	}

	return removed;
}

export async function ensureTempDir(): Promise<void> {
	await ensureInstanceDir(TEMP_ROOT);
}

export function retainTempPath(path: string): () => void {
	activeTempPaths.add(path);
	return () => {
		activeTempPaths.delete(path);
	};
}

export async function createTempFile(
	extension: string,
): Promise<TempFileHandle> {
	await ensureTempDir();
	const filename = `${randomUUID()}${extension.startsWith(".") ? extension : `.${extension}`}`;
	const path = join(TEMP_DIR, filename);
	const release = retainTempPath(path);

	return {
		path,
		cleanup: async () => {
			try {
				await unlink(path);
			} catch {}
			release();
		},
	};
}

export function sweepOrphanedTempDirs(): Promise<number> {
	return sweepOrphanedInstanceDirs(
		TEMP_ROOT,
		(_name, stats) => Date.now() - stats.mtimeMs > STALE_FILE_AGE_MS,
	);
}

export async function cleanupStaleTempFiles(): Promise<number> {
	let cleaned = await sweepOrphanedTempDirs();
	let entries: string[];
	try {
		entries = await readdir(TEMP_DIR);
	} catch {
		return cleaned;
	}
	const now = Date.now();

	for (const entry of entries) {
		if (entry === INSTANCE_LEASE_FILE) continue;
		const path = join(TEMP_DIR, entry);
		try {
			const age = now - (await lstat(path)).mtimeMs;
			if (
				age <= STALE_FILE_AGE_MS ||
				(activeTempPaths.has(path) && age <= MAX_ACTIVE_TEMP_AGE_MS)
			)
				continue;
			await rm(path, { recursive: true, force: true });
			activeTempPaths.delete(path);
			cleaned++;
		} catch {}
	}

	return cleaned;
}

export async function startTempDirMaintenance(): Promise<number> {
	if (!maintenanceTimer) {
		maintenanceTimer = setInterval(() => {
			void cleanupStaleTempFiles()
				.then((cleaned) => {
					if (cleaned > 0)
						console.log(`[temp-files] Removed ${cleaned} stale temp entries`);
				})
				.catch(() => {});
		}, TEMP_MAINTENANCE_INTERVAL_MS);
		maintenanceTimer.unref?.();
	}
	return await sweepOrphanedTempDirs();
}

export async function removeOwnTempDir(): Promise<void> {
	activeTempPaths.clear();
	await releaseInstanceDir(TEMP_ROOT);
}

async function measureDir(
	dir: string,
	usage: TempDirUsage,
): Promise<TempDirUsage> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return usage;
	}
	for (const entry of entries) {
		if (usage.entries >= TEMP_USAGE_MAX_ENTRIES) {
			usage.truncated = true;
			return usage;
		}
		usage.entries++;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			await measureDir(path, usage);
		} else {
			usage.bytes += await lstat(path).then(
				(stats) => stats.size,
				() => 0,
			);
		}
	}
	return usage;
}

let tempUsageCache:
	| { measuredAt: number; usage: Promise<TempDirUsage> }
	| undefined;

export function getTempDirUsage(): Promise<TempDirUsage> {
	const now = Date.now();
	if (
		!tempUsageCache ||
		now - tempUsageCache.measuredAt > TEMP_USAGE_CACHE_MS
	) {
		tempUsageCache = {
			measuredAt: now,
			usage: measureDir(TEMP_ROOT, { bytes: 0, entries: 0, truncated: false }),
		};
	}
	return tempUsageCache.usage;
}

export function getTempRoot(): string {
	return TEMP_ROOT;
}

export function getTempDir(): string {
	return TEMP_DIR;
}
