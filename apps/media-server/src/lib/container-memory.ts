import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CGROUP_MEMORY_LIMIT_PATHS = [
	"/sys/fs/cgroup/memory.max",
	"/sys/fs/cgroup/memory/memory.limit_in_bytes",
];
const CGROUP_MEMORY_USAGE_PATHS = [
	"/sys/fs/cgroup/memory.current",
	"/sys/fs/cgroup/memory/memory.usage_in_bytes",
];
const MAX_PLAUSIBLE_CONTAINER_LIMIT_BYTES = 1024 ** 5;

function readMemoryValue(paths: string[], enforcePlausibleLimit: boolean) {
	for (const path of paths) {
		if (!existsSync(path)) continue;

		let rawValue: string;
		try {
			rawValue = readFileSync(path, "utf8").trim();
		} catch {
			continue;
		}

		if (!rawValue || rawValue === "max") continue;

		const bytes = Number.parseInt(rawValue, 10);
		if (
			Number.isFinite(bytes) &&
			bytes > 0 &&
			(!enforcePlausibleLimit || bytes < MAX_PLAUSIBLE_CONTAINER_LIMIT_BYTES)
		) {
			return { bytes, path };
		}
	}

	return undefined;
}

export interface ContainerMemoryMetrics {
	usageMB: number;
	workingSetMB: number;
	reclaimableCacheMB: number;
	limitMB: number;
	pressure: number;
}

interface ContainerMemoryOptions {
	limitPaths?: string[];
	usagePaths?: string[];
	configuredLimitMB?: number;
}

export function getContainerMemoryMetrics(
	options: ContainerMemoryOptions = {},
): ContainerMemoryMetrics {
	const configuredLimitMB =
		options.configuredLimitMB ??
		(Number.parseInt(process.env.MEDIA_SERVER_MEMORY_LIMIT_MB ?? "0", 10) || 0);
	const limit = readMemoryValue(
		options.limitPaths ?? CGROUP_MEMORY_LIMIT_PATHS,
		true,
	);
	const limitMB = configuredLimitMB || (limit ? limit.bytes / 1024 ** 2 : 0);
	const usage = readMemoryValue(
		options.usagePaths ?? CGROUP_MEMORY_USAGE_PATHS,
		false,
	);
	const usageBytes = usage?.bytes ?? 0;
	let reclaimableBytes = 0;
	if (usage) {
		try {
			const stats = new Map(
				readFileSync(join(dirname(usage.path), "memory.stat"), "utf8")
					.trim()
					.split("\n")
					.map((line) => {
						const [key, value] = line.trim().split(/\s+/);
						return [key, Number(value)] as const;
					}),
			);
			const prefix = usage.path.endsWith("memory.usage_in_bytes")
				? "total_"
				: "";
			const inactive = stats.get(`${prefix}inactive_file`);
			const dirty = stats.get(`${prefix}${prefix ? "dirty" : "file_dirty"}`);
			const writeback = stats.get(
				`${prefix}${prefix ? "writeback" : "file_writeback"}`,
			);
			if (
				[inactive, dirty, writeback].every(
					(value) =>
						typeof value === "number" &&
						Number.isSafeInteger(value) &&
						value >= 0,
				)
			) {
				reclaimableBytes = Math.min(
					usageBytes,
					Math.max(0, (inactive ?? 0) - (dirty ?? 0) - (writeback ?? 0)),
				);
			}
		} catch {}
	}
	const usageMB = usageBytes / 1024 ** 2;
	const reclaimableCacheMB = reclaimableBytes / 1024 ** 2;
	const workingSetMB = usageMB - reclaimableCacheMB;
	return {
		usageMB,
		workingSetMB,
		reclaimableCacheMB,
		limitMB,
		pressure: limitMB > 0 ? workingSetMB / limitMB : 0,
	};
}
