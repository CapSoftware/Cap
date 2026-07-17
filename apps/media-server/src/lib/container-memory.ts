import { existsSync, readFileSync } from "node:fs";

const CGROUP_MEMORY_LIMIT_PATHS = [
	"/sys/fs/cgroup/memory.max",
	"/sys/fs/cgroup/memory/memory.limit_in_bytes",
];
const CGROUP_MEMORY_USAGE_PATHS = [
	"/sys/fs/cgroup/memory.current",
	"/sys/fs/cgroup/memory/memory.usage_in_bytes",
];
const MAX_PLAUSIBLE_CONTAINER_LIMIT_BYTES = 1024 ** 5;

function readMemoryValueMB(paths: string[], enforcePlausibleLimit: boolean) {
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
			return Math.round(bytes / (1024 * 1024));
		}
	}

	return 0;
}

export interface ContainerMemoryMetrics {
	usageMB: number;
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
	const limitMB =
		configuredLimitMB ||
		readMemoryValueMB(options.limitPaths ?? CGROUP_MEMORY_LIMIT_PATHS, true);
	const usageMB = readMemoryValueMB(
		options.usagePaths ?? CGROUP_MEMORY_USAGE_PATHS,
		false,
	);

	return {
		usageMB,
		limitMB,
		pressure: limitMB > 0 && usageMB > 0 ? usageMB / limitMB : 0,
	};
}
